use crate::fact_model::{CapabilityTerminalState, OriginScope, ProviderVisibility, SessionScope};
use crate::query::{ClosureFilter, MAX_PATH_RESULTS};
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

const MAX_PATH_CANDIDATES: usize = 200;
const MAX_PATH_NODES: usize = 128;
const PATH_HEAD_NODES: usize = 96;
const PATH_TAIL_NODES: usize = 32;
const FAMILY_SIMILARITY_THRESHOLD: f64 = 0.70;
const MIN_EVIDENCE_TURNS: usize = 5;
const MIN_INDEPENDENT_GROUPS: usize = 3;
const MAX_EVIDENCE_PAGE_ITEMS: u16 = 128;
const MAX_EVIDENCE_PAGE_BYTES: usize = 3_932_160;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DedupeConfidence {
    Strong,
    Weak,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ToolPathUse {
    pub capability_key: String,
    pub canonical_name: String,
    pub turn_ordinal: u64,
    pub origin_scope: OriginScope,
    pub terminal_state: CapabilityTerminalState,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EvidencePathTurn {
    pub turn_key: String,
    pub session_key: String,
    pub provider: String,
    pub relevance_ppm: u32,
    pub observed_unix_ms: u64,
    pub closure: ClosureFilter,
    pub session_scope: SessionScope,
    pub provider_visibility: ProviderVisibility,
    pub duplicate_group_key: Option<String>,
    pub dedupe_confidence: Option<DedupeConfidence>,
    pub observed_eof_provisional: bool,
    pub tools: Vec<ToolPathUse>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize)]
#[serde(rename_all = "kebab-case")]
pub enum RepeatBucket {
    One,
    TwoToThree,
    FourPlus,
}

impl RepeatBucket {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::One => "1",
            Self::TwoToThree => "2-3",
            Self::FourPlus => "4+",
        }
    }

    fn from_count(count: usize) -> Self {
        match count {
            0 | 1 => Self::One,
            2 | 3 => Self::TwoToThree,
            _ => Self::FourPlus,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PathNode {
    pub capability_key: String,
    pub provider_scoped_name: String,
    pub repeat_bucket: RepeatBucket,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ToolStateCounts {
    pub pending: u32,
    pub completed: u32,
    pub failed: u32,
    pub cancelled: u32,
    pub unknown: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidencePathFamily {
    pub fingerprint: String,
    pub nodes: Vec<PathNode>,
    pub truncated: bool,
    pub best_relevance_ppm: u32,
    pub turn_count: u16,
    pub raw_session_count: u16,
    pub independent_group_count: u16,
    pub strong_group_count: u16,
    pub weak_group_count: u16,
    pub observed_eof_provisional_group_count: u16,
    pub unknown_dedupe_session_count: u16,
    pub latest_unix_ms: u64,
    pub tool_state_counts: ToolStateCounts,
    pub evidence_turn_keys: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidencePathReport {
    pub insufficient_sample: bool,
    pub paths_truncated: bool,
    pub raw_match_count: u16,
    pub eligible_turn_count: u16,
    pub raw_session_count: u16,
    pub independent_group_count: u16,
    pub strong_group_count: u16,
    pub weak_group_count: u16,
    pub observed_eof_provisional_group_count: u16,
    pub unknown_dedupe_count: u16,
    pub unknown_dedupe_session_count: u16,
    pub families: Vec<EvidencePathFamily>,
}

#[derive(Debug, Clone)]
struct PreparedTurn<'a> {
    turn: &'a EvidencePathTurn,
    sequence: Vec<PathNode>,
    truncated: bool,
    fingerprint: String,
}

#[derive(Debug)]
struct ExactGroup<'a> {
    fingerprint: String,
    sequence: Vec<PathNode>,
    truncated: bool,
    turns: Vec<&'a EvidencePathTurn>,
}

#[derive(Debug)]
struct Family {
    group_indexes: Vec<usize>,
    medoid_index: usize,
}

pub fn build_evidence_paths(turns: &[EvidencePathTurn], path_limit: u8) -> EvidencePathReport {
    let bounded = turns.iter().take(MAX_PATH_CANDIDATES).collect::<Vec<_>>();
    let prepared = bounded
        .iter()
        .filter_map(|turn| prepare_turn(turn))
        .collect::<Vec<_>>();
    let unknown_dedupe_count = prepared
        .iter()
        .filter(|item| item.turn.duplicate_group_key.is_none())
        .count();
    let independent_groups = prepared
        .iter()
        .filter_map(|item| item.turn.duplicate_group_key.as_ref())
        .collect::<BTreeSet<_>>();
    let raw_sessions = prepared
        .iter()
        .map(|item| &item.turn.session_key)
        .collect::<BTreeSet<_>>();
    let strong_groups = prepared
        .iter()
        .filter(|item| item.turn.dedupe_confidence == Some(DedupeConfidence::Strong))
        .filter_map(|item| item.turn.duplicate_group_key.as_ref())
        .collect::<BTreeSet<_>>();
    let weak_groups = independent_groups
        .difference(&strong_groups)
        .copied()
        .collect::<BTreeSet<_>>();
    let provisional_groups = prepared
        .iter()
        .filter(|item| item.turn.observed_eof_provisional)
        .filter_map(|item| item.turn.duplicate_group_key.as_ref())
        .collect::<BTreeSet<_>>();
    let unknown_dedupe_sessions = prepared
        .iter()
        .filter(|item| item.turn.duplicate_group_key.is_none())
        .map(|item| &item.turn.session_key)
        .collect::<BTreeSet<_>>();
    let sufficient =
        prepared.len() >= MIN_EVIDENCE_TURNS && independent_groups.len() >= MIN_INDEPENDENT_GROUPS;
    let mut report = EvidencePathReport {
        insufficient_sample: !sufficient,
        paths_truncated: false,
        raw_match_count: bounded.len().try_into().unwrap_or(u16::MAX),
        eligible_turn_count: prepared.len().try_into().unwrap_or(u16::MAX),
        raw_session_count: raw_sessions.len().try_into().unwrap_or(u16::MAX),
        independent_group_count: independent_groups.len().try_into().unwrap_or(u16::MAX),
        strong_group_count: strong_groups.len().try_into().unwrap_or(u16::MAX),
        weak_group_count: weak_groups.len().try_into().unwrap_or(u16::MAX),
        observed_eof_provisional_group_count: provisional_groups
            .len()
            .try_into()
            .unwrap_or(u16::MAX),
        unknown_dedupe_count: unknown_dedupe_count.try_into().unwrap_or(u16::MAX),
        unknown_dedupe_session_count: unknown_dedupe_sessions.len().try_into().unwrap_or(u16::MAX),
        families: Vec::new(),
    };
    if !sufficient || path_limit == 0 {
        return report;
    }

    let groups = exact_groups(&prepared);
    let bigram_df = candidate_bigram_document_frequencies(&prepared);
    let distances = group_distance_cache(&groups, prepared.len(), &bigram_df);
    let mut families: Vec<Family> = Vec::new();
    for group_index in 0..groups.len() {
        let family_index = families.iter().position(|family| {
            let medoid = &groups[family.medoid_index].sequence;
            same_endpoints(&groups[group_index].sequence, medoid)
                && 1.0 - distances[group_index][family.medoid_index] >= FAMILY_SIMILARITY_THRESHOLD
        });
        if let Some(family_index) = family_index {
            families[family_index].group_indexes.push(group_index);
            families[family_index].medoid_index =
                select_medoid(&families[family_index].group_indexes, &groups, &distances);
        } else {
            families.push(Family {
                group_indexes: vec![group_index],
                medoid_index: group_index,
            });
        }
    }

    report.families = families
        .iter()
        .map(|family| materialize_family(family, &groups))
        .filter(family_has_sufficient_support)
        .collect();
    report.insufficient_sample = report.families.is_empty();
    if report.insufficient_sample {
        return report;
    }
    report.families.sort_by(compare_families);
    report.paths_truncated = report.families.len() > usize::from(path_limit.min(MAX_PATH_RESULTS));
    report
        .families
        .truncate(usize::from(path_limit.min(MAX_PATH_RESULTS)));
    let mut remaining_evidence = MAX_PATH_CANDIDATES;
    for family in &mut report.families {
        if family.evidence_turn_keys.len() > remaining_evidence {
            report.paths_truncated = true;
        }
        family.evidence_turn_keys.truncate(remaining_evidence);
        remaining_evidence -= family.evidence_turn_keys.len();
    }
    report
}

fn prepare_turn(turn: &EvidencePathTurn) -> Option<PreparedTurn<'_>> {
    if !matches!(
        turn.closure,
        ClosureFilter::HardSealed | ClosureFilter::Quiescent
    ) || turn.session_scope != SessionScope::Main
        || turn.provider_visibility != ProviderVisibility::Active
    {
        return None;
    }
    let mut tools = turn
        .tools
        .iter()
        .filter(|usage| usage.origin_scope == OriginScope::Main)
        .collect::<Vec<_>>();
    tools.sort_by_key(|usage| usage.turn_ordinal);
    let mut sequence: Vec<(String, String, usize)> = Vec::new();
    for usage in tools {
        let name = format!("{}:{}", turn.provider, usage.canonical_name);
        if let Some((_, last_name, count)) = sequence.last_mut()
            && *last_name == name
        {
            *count += 1;
        } else {
            sequence.push((usage.capability_key.clone(), name, 1_usize));
        }
    }
    if sequence.is_empty() {
        return None;
    }
    let mut nodes = sequence
        .into_iter()
        .map(|(capability_key, provider_scoped_name, count)| PathNode {
            capability_key,
            provider_scoped_name,
            repeat_bucket: RepeatBucket::from_count(count),
        })
        .collect::<Vec<_>>();
    let truncated = nodes.len() > MAX_PATH_NODES;
    if truncated {
        nodes = nodes
            .iter()
            .take(PATH_HEAD_NODES)
            .chain(nodes.iter().skip(nodes.len() - PATH_TAIL_NODES))
            .cloned()
            .collect();
    }
    let fingerprint = sequence_fingerprint(&nodes);
    Some(PreparedTurn {
        turn,
        sequence: nodes,
        truncated,
        fingerprint,
    })
}

fn sequence_fingerprint(nodes: &[PathNode]) -> String {
    let mut digest = Sha256::new();
    digest.update(b"threadshare:tool-evidence-path:v1\0");
    for node in nodes {
        digest.update((node.provider_scoped_name.len() as u32).to_be_bytes());
        digest.update(node.provider_scoped_name.as_bytes());
        digest.update([match node.repeat_bucket {
            RepeatBucket::One => 1,
            RepeatBucket::TwoToThree => 2,
            RepeatBucket::FourPlus => 4,
        }]);
    }
    hex::encode(digest.finalize())
}

fn exact_groups<'a>(prepared: &'a [PreparedTurn<'a>]) -> Vec<ExactGroup<'a>> {
    let mut groups = BTreeMap::<String, ExactGroup<'a>>::new();
    for item in prepared {
        if let Some(group) = groups.get_mut(&item.fingerprint) {
            group.turns.push(item.turn);
            group.truncated |= item.truncated;
        } else {
            groups.insert(
                item.fingerprint.clone(),
                ExactGroup {
                    fingerprint: item.fingerprint.clone(),
                    sequence: item.sequence.clone(),
                    truncated: item.truncated,
                    turns: vec![item.turn],
                },
            );
        }
    }
    groups.into_values().collect()
}

type Bigram = (String, String);

fn bigrams(sequence: &[PathNode]) -> BTreeSet<Bigram> {
    sequence
        .windows(2)
        .map(|pair| (node_identity(&pair[0]), node_identity(&pair[1])))
        .collect()
}

fn node_identity(node: &PathNode) -> String {
    format!(
        "{}\0{}",
        node.provider_scoped_name,
        node.repeat_bucket.as_str()
    )
}

fn candidate_bigram_document_frequencies(prepared: &[PreparedTurn<'_>]) -> BTreeMap<Bigram, usize> {
    let mut frequencies = BTreeMap::new();
    for item in prepared {
        for bigram in bigrams(&item.sequence) {
            *frequencies.entry(bigram).or_insert(0) += 1;
        }
    }
    frequencies
}

fn same_endpoints(left: &[PathNode], right: &[PathNode]) -> bool {
    left.first().map(|node| &node.provider_scoped_name)
        == right.first().map(|node| &node.provider_scoped_name)
        && left.last().map(|node| &node.provider_scoped_name)
            == right.last().map(|node| &node.provider_scoped_name)
}

fn weighted_bigram_jaccard(
    left: &[PathNode],
    right: &[PathNode],
    candidate_count: usize,
    frequencies: &BTreeMap<Bigram, usize>,
) -> f64 {
    let left = bigrams(left);
    let right = bigrams(right);
    if left.is_empty() && right.is_empty() {
        return 1.0;
    }
    let union = left.union(&right).collect::<BTreeSet<_>>();
    let weight = |bigram: &Bigram| {
        let document_frequency = frequencies.get(bigram).copied().unwrap_or(0);
        1.0 + ((candidate_count + 1) as f64 / (document_frequency + 1) as f64).ln()
    };
    let union_weight = union.iter().map(|bigram| weight(bigram)).sum::<f64>();
    let intersection_weight = left.intersection(&right).map(weight).sum::<f64>();
    if union_weight == 0.0 {
        1.0
    } else {
        intersection_weight / union_weight
    }
}

fn group_distance_cache(
    groups: &[ExactGroup<'_>],
    candidate_count: usize,
    frequencies: &BTreeMap<Bigram, usize>,
) -> Vec<Vec<f64>> {
    let mut distances = vec![vec![0.0; groups.len()]; groups.len()];
    for left in 0..groups.len() {
        for right in left + 1..groups.len() {
            let distance = 1.0
                - weighted_bigram_jaccard(
                    &groups[left].sequence,
                    &groups[right].sequence,
                    candidate_count,
                    frequencies,
                );
            distances[left][right] = distance;
            distances[right][left] = distance;
        }
    }
    distances
}

fn select_medoid(
    group_indexes: &[usize],
    groups: &[ExactGroup<'_>],
    distances: &[Vec<f64>],
) -> usize {
    group_indexes
        .iter()
        .copied()
        .min_by(|left, right| {
            let distance_sum = |candidate: usize| {
                group_indexes
                    .iter()
                    .map(|other| distances[candidate][*other] * groups[*other].turns.len() as f64)
                    .sum::<f64>()
            };
            distance_sum(*left)
                .total_cmp(&distance_sum(*right))
                .then_with(|| groups[*left].fingerprint.cmp(&groups[*right].fingerprint))
        })
        .expect("family always has at least one exact group")
}

fn materialize_family(family: &Family, groups: &[ExactGroup<'_>]) -> EvidencePathFamily {
    let medoid = &groups[family.medoid_index];
    let turns = family
        .group_indexes
        .iter()
        .flat_map(|index| groups[*index].turns.iter().copied())
        .collect::<Vec<_>>();
    let raw_sessions = turns
        .iter()
        .map(|turn| &turn.session_key)
        .collect::<BTreeSet<_>>();
    let independent_groups = turns
        .iter()
        .filter_map(|turn| turn.duplicate_group_key.as_ref())
        .collect::<BTreeSet<_>>();
    let strong_groups = turns
        .iter()
        .filter(|turn| turn.dedupe_confidence == Some(DedupeConfidence::Strong))
        .filter_map(|turn| turn.duplicate_group_key.as_ref())
        .collect::<BTreeSet<_>>();
    let weak_groups = independent_groups
        .difference(&strong_groups)
        .copied()
        .collect::<BTreeSet<_>>();
    let provisional_groups = turns
        .iter()
        .filter(|turn| turn.observed_eof_provisional)
        .filter_map(|turn| turn.duplicate_group_key.as_ref())
        .collect::<BTreeSet<_>>();
    let mut states = ToolStateCounts::default();
    for usage in turns
        .iter()
        .flat_map(|turn| turn.tools.iter())
        .filter(|usage| usage.origin_scope == OriginScope::Main)
    {
        let count = match usage.terminal_state {
            CapabilityTerminalState::Pending => &mut states.pending,
            CapabilityTerminalState::Completed => &mut states.completed,
            CapabilityTerminalState::Failed => &mut states.failed,
            CapabilityTerminalState::Cancelled => &mut states.cancelled,
            CapabilityTerminalState::Unknown => &mut states.unknown,
        };
        *count = count.saturating_add(1);
    }
    let mut evidence_turn_keys = turns
        .iter()
        .map(|turn| turn.turn_key.clone())
        .collect::<Vec<_>>();
    evidence_turn_keys.sort();
    evidence_turn_keys.dedup();
    EvidencePathFamily {
        fingerprint: medoid.fingerprint.clone(),
        nodes: medoid.sequence.clone(),
        truncated: family
            .group_indexes
            .iter()
            .any(|index| groups[*index].truncated),
        best_relevance_ppm: turns
            .iter()
            .map(|turn| turn.relevance_ppm)
            .max()
            .unwrap_or(0),
        turn_count: turns.len().try_into().unwrap_or(u16::MAX),
        raw_session_count: raw_sessions.len().try_into().unwrap_or(u16::MAX),
        independent_group_count: independent_groups.len().try_into().unwrap_or(u16::MAX),
        strong_group_count: strong_groups.len().try_into().unwrap_or(u16::MAX),
        weak_group_count: weak_groups.len().try_into().unwrap_or(u16::MAX),
        observed_eof_provisional_group_count: provisional_groups
            .len()
            .try_into()
            .unwrap_or(u16::MAX),
        unknown_dedupe_session_count: turns
            .iter()
            .filter(|turn| turn.duplicate_group_key.is_none())
            .map(|turn| &turn.session_key)
            .collect::<BTreeSet<_>>()
            .len()
            .try_into()
            .unwrap_or(u16::MAX),
        latest_unix_ms: turns
            .iter()
            .map(|turn| turn.observed_unix_ms)
            .max()
            .unwrap_or(0),
        tool_state_counts: states,
        evidence_turn_keys,
    }
}

fn family_has_sufficient_support(family: &EvidencePathFamily) -> bool {
    usize::from(family.turn_count) >= MIN_EVIDENCE_TURNS
        && usize::from(family.independent_group_count) >= MIN_INDEPENDENT_GROUPS
}

fn compare_families(left: &EvidencePathFamily, right: &EvidencePathFamily) -> Ordering {
    right
        .best_relevance_ppm
        .cmp(&left.best_relevance_ppm)
        .then_with(|| {
            right
                .independent_group_count
                .cmp(&left.independent_group_count)
        })
        .then_with(|| right.turn_count.cmp(&left.turn_count))
        .then_with(|| right.latest_unix_ms.cmp(&left.latest_unix_ms))
        .then_with(|| left.fingerprint.cmp(&right.fingerprint))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct EvidenceLink {
    pub turn_key: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase"
)]
pub enum SafeEventPayload {
    VisibleMessage {
        role: String,
    },
    CapabilityInvocation {
        capability_key: String,
        correlation_digest: Option<String>,
        input_fingerprint: Option<String>,
    },
    CapabilityResult {
        correlation_digest: Option<String>,
        provider_state: String,
        exit_code: Option<String>,
        output_bytes: Option<String>,
        duration_ms: Option<String>,
    },
    SkillCatalogEntry {
        capability_key: String,
        path_fingerprint: String,
    },
    SkillLoad {
        capability_key: String,
        strength: String,
        evidence_source: String,
    },
    TurnLifecycle {
        lifecycle_state: String,
        provider_turn_digest: Option<String>,
    },
    ProviderStatus {
        status_kind: String,
        provider_state: String,
        rolled_back_turn_count: Option<String>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeEvidenceEvent {
    pub event_key: String,
    pub occurred_turn_key: Option<String>,
    pub linked_turns: Vec<EvidenceLink>,
    pub source_record_key: String,
    pub pointer_kind: String,
    pub pointer_content_index: i32,
    pub pointer_event_ordinal: u16,
    pub origin_scope: String,
    pub observed_timestamp: Option<String>,
    pub payload: SafeEventPayload,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UseEvidenceLink {
    pub event_key: String,
    pub role: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeCapabilityUse {
    pub use_key: String,
    pub capability_key: String,
    pub provider: String,
    pub capability_kind: String,
    pub canonical_name: String,
    pub turn_ordinal: String,
    pub exact_observed_name: String,
    pub origin_scope: String,
    pub origin_fingerprint: Option<String>,
    pub input_fingerprint: Option<String>,
    pub provider_terminal_state: String,
    pub strength: String,
    pub correlation_digest: Option<String>,
    pub evidence: Vec<UseEvidenceLink>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SafeTurnFact {
    pub turn_key: String,
    pub revision: Option<String>,
    pub problem_text: String,
    pub final_answer_excerpt: Option<String>,
    pub observed_timestamp: Option<String>,
    pub next_user_boundary: bool,
    pub provider_terminal: Option<String>,
    pub observed_eof_closed: bool,
    pub provider_visibility: String,
    pub fact_truncation: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "factKind", content = "fact", rename_all = "kebab-case")]
pub enum SafeEvidenceFact {
    Event(SafeEvidenceEvent),
    CapabilityUse(SafeCapabilityUse),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnEvidencePage {
    pub snapshot_seq: String,
    pub turn: SafeTurnFact,
    pub entries: Vec<SafeEvidenceFact>,
    pub next_cursor: Option<String>,
}

#[derive(Debug, Clone, Copy)]
enum EvidenceItemKind {
    Event,
    CapabilityUse,
}

impl EvidenceItemKind {
    const fn rank(self) -> i64 {
        match self {
            Self::Event => 0,
            Self::CapabilityUse => 1,
        }
    }

    const fn cursor_prefix(self) -> &'static str {
        match self {
            Self::Event => "event",
            Self::CapabilityUse => "use",
        }
    }
}

struct EvidenceItemId {
    kind: EvidenceItemKind,
    row_id: i64,
    key: Vec<u8>,
}

pub(crate) fn read_turn_evidence(
    connection: &Connection,
    turn_key: &str,
    expected_revision: Option<&str>,
    cursor: Option<&str>,
    limit: u16,
) -> Result<TurnEvidencePage, crate::query::QueryError> {
    if !(1..=MAX_EVIDENCE_PAGE_ITEMS).contains(&limit) {
        return Err(crate::query::QueryError::new(
            "EVIDENCE_INVALID_LIMIT",
            format!("evidence limit must be in 1..={MAX_EVIDENCE_PAGE_ITEMS}"),
        ));
    }
    let turn_key_bytes = decode_key(turn_key, "turnKey")?;
    if let Some(revision) = expected_revision {
        decode_key(revision, "expectedRevision")?;
    }
    let cursor = cursor.map(parse_cursor).transpose()?;
    let transaction = connection
        .unchecked_transaction()
        .map_err(evidence_failed)?;
    let snapshot_seq = transaction
        .query_row(
            "SELECT value FROM engine_metadata WHERE key='snapshot_seq'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(evidence_failed)?;
    let target = transaction
        .query_row(
            "SELECT t.turn_id,lower(hex(t.revision))
             FROM turns t JOIN sessions s ON s.session_id=t.session_id
             WHERE t.turn_key=?1 AND s.eligibility='eligible' AND s.session_scope='main'
               AND t.effective_provider_visibility='active'
               AND NOT EXISTS (
                 SELECT 1 FROM source_purge_states purge WHERE purge.session_key=s.session_key
               )",
            [&turn_key_bytes],
            |row| Ok((row.get::<_, i64>(0)?, empty_hex(row.get(1)?))),
        )
        .optional()
        .map_err(evidence_failed)?
        .ok_or_else(|| crate::query::QueryError::new("TURN_NOT_FOUND", "Turn was not found"))?;
    if expected_revision.is_some_and(|expected| target.1.as_deref() != Some(expected)) {
        return Err(crate::query::QueryError::new(
            "TURN_REVISION_MISMATCH",
            "Turn revision changed; repeat the search before reading evidence",
        ));
    }

    let (cursor_kind, cursor_key) = cursor
        .map(|(kind, key)| (kind.rank(), key))
        .unwrap_or((-1, Vec::new()));
    let mut statement = transaction
        .prepare(
            "WITH evidence_items(kind_rank,row_id,stable_key) AS (
               SELECT 0,e.event_id,e.event_key
               FROM evidence_events e
               WHERE e.occurred_turn_id=?1
                  OR EXISTS (SELECT 1 FROM turn_evidence link
                             WHERE link.event_id=e.event_id AND link.turn_id=?1)
                  OR EXISTS (SELECT 1 FROM capability_use_evidence use_link
                             JOIN capability_uses linked_use ON linked_use.use_id=use_link.use_id
                             WHERE use_link.event_id=e.event_id AND linked_use.turn_id=?1)
               UNION ALL
               SELECT 1,u.use_id,u.use_key FROM capability_uses u WHERE u.turn_id=?1
             )
             SELECT kind_rank,row_id,stable_key FROM evidence_items
             WHERE kind_rank>?2 OR (kind_rank=?2 AND stable_key>?3)
             ORDER BY kind_rank,stable_key LIMIT ?4",
        )
        .map_err(evidence_failed)?;
    let ids = statement
        .query_map(
            params![target.0, cursor_kind, cursor_key, i64::from(limit) + 1],
            |row| {
                Ok(EvidenceItemId {
                    kind: if row.get::<_, i64>(0)? == 0 {
                        EvidenceItemKind::Event
                    } else {
                        EvidenceItemKind::CapabilityUse
                    },
                    row_id: row.get(1)?,
                    key: row.get(2)?,
                })
            },
        )
        .map_err(evidence_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(evidence_failed)?;
    drop(statement);
    let has_more = ids.len() > usize::from(limit);
    let mut ids = ids.into_iter().take(usize::from(limit)).collect::<Vec<_>>();
    let turn = read_safe_turn(&transaction, target.0)?;
    let mut entries = ids
        .iter()
        .map(|id| match id.kind {
            EvidenceItemKind::Event => read_safe_event(&transaction, id.row_id),
            EvidenceItemKind::CapabilityUse => read_safe_use(&transaction, id.row_id),
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut next_cursor = has_more.then(|| cursor_for(ids.last().expect("non-empty page")));
    loop {
        let page = TurnEvidencePage {
            snapshot_seq: snapshot_seq.clone(),
            turn: turn.clone(),
            entries: entries.clone(),
            next_cursor: next_cursor.clone(),
        };
        let bytes = serde_json::to_vec(&page).map_err(|error| {
            crate::query::QueryError::new("EVIDENCE_READ_FAILED", error.to_string())
        })?;
        if bytes.len() <= MAX_EVIDENCE_PAGE_BYTES {
            transaction.commit().map_err(evidence_failed)?;
            return Ok(page);
        }
        if entries.len() <= 1 {
            return Err(crate::query::QueryError::new(
                "EVIDENCE_PAGE_TOO_LARGE",
                "one safe evidence item exceeds the page byte budget",
            ));
        }
        entries.pop();
        ids.pop();
        next_cursor = Some(cursor_for(ids.last().expect("page retains one item")));
    }
}

fn read_safe_event(
    connection: &Connection,
    event_id: i64,
) -> Result<SafeEvidenceFact, crate::query::QueryError> {
    let common = connection
        .query_row(
            "SELECT lower(hex(e.event_key)),lower(hex(t.turn_key)),lower(hex(r.source_record_key)),e.pointer_kind,
                    e.pointer_content_index,e.pointer_event_ordinal,e.origin_scope,
                    e.observed_timestamp,e.event_kind
             FROM evidence_events e LEFT JOIN turns t ON t.turn_id=e.occurred_turn_id
             JOIN source_records r ON r.source_record_id=e.source_record_id
             WHERE e.event_id=?1",
            [event_id],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    empty_hex(row.get(1)?),
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, i32>(4)?,
                    row.get::<_, u16>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .map_err(evidence_failed)?;
    let linked_turns = connection
        .prepare(
            "SELECT lower(hex(t.turn_key)),link.role FROM turn_evidence link
             JOIN turns t ON t.turn_id=link.turn_id WHERE link.event_id=?1
             ORDER BY t.turn_key,link.role",
        )
        .and_then(|mut statement| {
            statement
                .query_map([event_id], |row| {
                    Ok(EvidenceLink {
                        turn_key: row.get(0)?,
                        role: row.get(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(evidence_failed)?;
    let payload = read_safe_event_payload(connection, event_id, &common.8)?;
    Ok(SafeEvidenceFact::Event(SafeEvidenceEvent {
        event_key: common.0,
        occurred_turn_key: common.1,
        linked_turns,
        source_record_key: common.2,
        pointer_kind: common.3,
        pointer_content_index: common.4,
        pointer_event_ordinal: common.5,
        origin_scope: common.6,
        observed_timestamp: common.7,
        payload,
    }))
}

fn read_safe_turn(
    connection: &Connection,
    turn_id: i64,
) -> Result<SafeTurnFact, crate::query::QueryError> {
    let mut turn = connection
        .query_row(
            "SELECT lower(hex(turn_key)),lower(hex(revision)),problem_text,
                    final_answer_excerpt,observed_timestamp,next_user_boundary,
                    provider_terminal,observed_eof_closed,effective_provider_visibility
             FROM turns WHERE turn_id=?1",
            [turn_id],
            |row| {
                Ok(SafeTurnFact {
                    turn_key: row.get(0)?,
                    revision: empty_hex(row.get(1)?),
                    problem_text: row.get(2)?,
                    final_answer_excerpt: row.get(3)?,
                    observed_timestamp: row.get(4)?,
                    next_user_boundary: row.get(5)?,
                    provider_terminal: row.get(6)?,
                    observed_eof_closed: row.get(7)?,
                    provider_visibility: row.get(8)?,
                    fact_truncation: Vec::new(),
                })
            },
        )
        .map_err(evidence_failed)?;
    turn.fact_truncation = connection
        .prepare("SELECT flag FROM turn_fact_truncation WHERE turn_id=?1 ORDER BY flag")
        .and_then(|mut statement| {
            statement
                .query_map([turn_id], |row| row.get(0))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(evidence_failed)?;
    Ok(turn)
}

fn read_safe_event_payload(
    connection: &Connection,
    event_id: i64,
    kind: &str,
) -> Result<SafeEventPayload, crate::query::QueryError> {
    let payload = match kind {
        "visible-message" => SafeEventPayload::VisibleMessage {
            role: connection
                .query_row("SELECT message_role FROM visible_message_events WHERE event_id=?1", [event_id], |row| row.get(0))
                .map_err(evidence_failed)?,
        },
        "capability-invocation" => connection
            .query_row(
                "SELECT lower(hex(c.capability_key)),lower(hex(i.correlation_digest)),lower(hex(i.input_fingerprint))
                 FROM capability_invocation_events i JOIN capabilities c ON c.capability_id=i.capability_id
                 WHERE i.event_id=?1",
                [event_id],
                |row| Ok(SafeEventPayload::CapabilityInvocation {
                    capability_key: row.get(0)?,
                    correlation_digest: empty_hex(row.get(1)?),
                    input_fingerprint: empty_hex(row.get(2)?),
                }),
            )
            .map_err(evidence_failed)?,
        "capability-result" => connection
            .query_row(
                "SELECT lower(hex(correlation_digest)),provider_state,exit_code,output_bytes,duration_ms
                 FROM capability_result_events WHERE event_id=?1",
                [event_id],
                |row| Ok(SafeEventPayload::CapabilityResult {
                    correlation_digest: empty_hex(row.get(0)?),
                    provider_state: row.get(1)?,
                    exit_code: optional_wire_decimal(row.get(2)?, 2)?,
                    output_bytes: optional_wire_decimal(row.get(3)?, 3)?,
                    duration_ms: optional_wire_decimal(row.get(4)?, 4)?,
                }),
            )
            .map_err(evidence_failed)?,
        "skill-catalog-entry" => connection
            .query_row(
                "SELECT lower(hex(c.capability_key)),lower(hex(s.path_fingerprint))
                 FROM skill_catalog_entry_events s JOIN capabilities c ON c.capability_id=s.capability_id
                 WHERE s.event_id=?1",
                [event_id],
                |row| Ok(SafeEventPayload::SkillCatalogEntry {
                    capability_key: row.get(0)?,
                    path_fingerprint: row.get(1)?,
                }),
            )
            .map_err(evidence_failed)?,
        "skill-load" => connection
            .query_row(
                "SELECT lower(hex(c.capability_key)),s.strength,s.evidence_source
                 FROM skill_load_events s JOIN capabilities c ON c.capability_id=s.capability_id
                 WHERE s.event_id=?1",
                [event_id],
                |row| Ok(SafeEventPayload::SkillLoad {
                    capability_key: row.get(0)?,
                    strength: row.get(1)?,
                    evidence_source: row.get(2)?,
                }),
            )
            .map_err(evidence_failed)?,
        "turn-lifecycle" => connection
            .query_row(
                "SELECT lifecycle_state,lower(hex(provider_turn_digest)) FROM turn_lifecycle_events WHERE event_id=?1",
                [event_id],
                |row| Ok(SafeEventPayload::TurnLifecycle {
                    lifecycle_state: row.get(0)?,
                    provider_turn_digest: empty_hex(row.get(1)?),
                }),
            )
            .map_err(evidence_failed)?,
        "provider-status" => connection
            .query_row(
                "SELECT status_kind,provider_state,rolled_back_turn_count FROM provider_status_events WHERE event_id=?1",
                [event_id],
                |row| Ok(SafeEventPayload::ProviderStatus {
                    status_kind: row.get(0)?,
                    provider_state: row.get(1)?,
                    rolled_back_turn_count: optional_wire_decimal(row.get(2)?, 2)?,
                }),
            )
            .map_err(evidence_failed)?,
        _ => {
            return Err(crate::query::QueryError::new(
                "EVIDENCE_READ_FAILED",
                "stored evidence event kind is unknown",
            ));
        }
    };
    Ok(payload)
}

fn read_safe_use(
    connection: &Connection,
    use_id: i64,
) -> Result<SafeEvidenceFact, crate::query::QueryError> {
    let mut usage = connection
        .query_row(
            "SELECT lower(hex(u.use_key)),lower(hex(c.capability_key)),c.provider,
                    c.capability_kind,c.canonical_name,u.turn_ordinal,u.exact_observed_name,
                    u.origin_scope,lower(hex(u.origin_fingerprint)),lower(hex(u.input_fingerprint)),
                    u.provider_terminal_state,u.strength,lower(hex(u.correlation_digest))
             FROM capability_uses u JOIN capabilities c ON c.capability_id=u.capability_id
             WHERE u.use_id=?1",
            [use_id],
            |row| {
                Ok(SafeCapabilityUse {
                    use_key: row.get(0)?,
                    capability_key: row.get(1)?,
                    provider: row.get(2)?,
                    capability_kind: row.get(3)?,
                    canonical_name: row.get(4)?,
                    turn_ordinal: wire_decimal(row.get(5)?, 5)?,
                    exact_observed_name: row.get(6)?,
                    origin_scope: row.get(7)?,
                    origin_fingerprint: empty_hex(row.get(8)?),
                    input_fingerprint: empty_hex(row.get(9)?),
                    provider_terminal_state: row.get(10)?,
                    strength: row.get(11)?,
                    correlation_digest: empty_hex(row.get(12)?),
                    evidence: Vec::new(),
                })
            },
        )
        .map_err(evidence_failed)?;
    usage.evidence = connection
        .prepare(
            "SELECT lower(hex(e.event_key)),link.role FROM capability_use_evidence link
             JOIN evidence_events e ON e.event_id=link.event_id WHERE link.use_id=?1
             ORDER BY e.event_key,link.role",
        )
        .and_then(|mut statement| {
            statement
                .query_map([use_id], |row| {
                    Ok(UseEvidenceLink {
                        event_key: row.get(0)?,
                        role: row.get(1)?,
                    })
                })?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(evidence_failed)?;
    Ok(SafeEvidenceFact::CapabilityUse(usage))
}

fn parse_cursor(cursor: &str) -> Result<(EvidenceItemKind, Vec<u8>), crate::query::QueryError> {
    let (prefix, key) = cursor.split_once(':').ok_or_else(invalid_cursor)?;
    let kind = match prefix {
        "event" => EvidenceItemKind::Event,
        "use" => EvidenceItemKind::CapabilityUse,
        _ => return Err(invalid_cursor()),
    };
    Ok((kind, decode_key(key, "cursor")?))
}

fn cursor_for(item: &EvidenceItemId) -> String {
    format!("{}:{}", item.kind.cursor_prefix(), hex::encode(&item.key))
}

fn invalid_cursor() -> crate::query::QueryError {
    crate::query::QueryError::new("EVIDENCE_INVALID_CURSOR", "evidence cursor is invalid")
}

fn decode_key(value: &str, name: &str) -> Result<Vec<u8>, crate::query::QueryError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(crate::query::QueryError::new(
            "EVIDENCE_INVALID_KEY",
            format!("{name} must be a lowercase 32-byte hex key"),
        ));
    }
    hex::decode(value).map_err(|_| invalid_cursor())
}

fn empty_hex(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn wire_decimal(value: Vec<u8>, column: usize) -> rusqlite::Result<String> {
    let length = value.len();
    let bytes = value
        .try_into()
        .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(column, length as i64))?;
    Ok(u64::from_be_bytes(bytes).to_string())
}

fn optional_wire_decimal(
    value: Option<Vec<u8>>,
    column: usize,
) -> rusqlite::Result<Option<String>> {
    value.map(|value| wire_decimal(value, column)).transpose()
}

fn evidence_failed(error: rusqlite::Error) -> crate::query::QueryError {
    crate::query::QueryError::new("EVIDENCE_READ_FAILED", error.to_string())
}
