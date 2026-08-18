use rusqlite::{Connection, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};
use std::fmt;
use std::time::Instant;
use unicode_normalization::UnicodeNormalization;

use crate::agent_query::canonical_timestamp;
use crate::analyzer::{
    AnalyzerError, AnalyzerField, AnalyzerOriginScope, CapabilityInput, QueryTerm,
    SEARCH_PROJECTION_VERSION, analyze_document, analyze_query,
};
use crate::evidence_path::{
    DedupeConfidence, EvidencePathReport, EvidencePathTurn, ToolPathUse, TurnDeliveryAttribution,
    build_evidence_paths,
};
use crate::fact_model::{CapabilityTerminalState, OriginScope, ProviderVisibility, SessionScope};
use crate::fts_projection::{FtsField, FtsMatchExpression, lookup_field_document_frequencies};

pub const MAX_QUERY_BYTES: usize = 8_192;
pub const MAX_SEARCH_RESULTS: u16 = 200;
pub const MAX_PATH_RESULTS: u8 = 20;
const MAX_SCORING_TERMS: usize = 32;
const MAX_FTS_CANDIDATES: usize = 300;
const SUMMARY_BYTES: usize = 512;
pub const ANALYZER_WIRE_VERSION: u32 = 1;
pub const RANKER_VERSION: u32 = 1;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct QueryError {
    pub code: &'static str,
    pub message: String,
}

impl QueryError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for QueryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for QueryError {}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResultEvidenceFilter {
    ProviderCompleted,
    Abandoned,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ClosureFilter {
    HardSealed,
    Quiescent,
    Open,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SearchOrderBy {
    /// Blended bm25 + coverage + exactness ranking over a bounded candidate pool.
    #[default]
    Relevance,
    /// True newest-first over the whole matching set, not just the ranked pool.
    ObservedDesc,
}

/// `observed-desc` cannot lean on the ranked candidate cap, so a text query must name a
/// window no wider than the supported retention horizon.
pub const MAX_OBSERVED_DESC_WINDOW_MS: u64 = 366 * 86_400_000;
/// One past the largest match set `observed-desc` will sort for a text query.
pub const MAX_OBSERVED_DESC_MATCHES: usize = 10_000;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchRequest {
    #[serde(default)]
    pub query: String,
    #[serde(default)]
    pub order_by: SearchOrderBy,
    #[serde(default)]
    pub providers: Vec<String>,
    #[serde(default)]
    pub project_keys: Vec<String>,
    #[serde(default)]
    pub tool_capability_keys: Vec<String>,
    #[serde(default)]
    pub skill_capability_keys: Vec<String>,
    #[serde(default)]
    pub capability_terminal_states: Vec<CapabilityTerminalState>,
    pub after_unix_ms: Option<u64>,
    pub before_unix_ms: Option<u64>,
    #[serde(default)]
    pub result_evidence: Vec<ResultEvidenceFilter>,
    #[serde(default)]
    pub closure: Vec<ClosureFilter>,
    pub limit: u16,
    pub path_limit: u8,
    pub now_unix_ms: u64,
    pub quiescence_seconds: u32,
}

impl Default for SearchRequest {
    fn default() -> Self {
        Self {
            query: String::new(),
            order_by: SearchOrderBy::Relevance,
            providers: Vec::new(),
            project_keys: Vec::new(),
            tool_capability_keys: Vec::new(),
            skill_capability_keys: Vec::new(),
            capability_terminal_states: Vec::new(),
            after_unix_ms: None,
            before_unix_ms: None,
            result_evidence: Vec::new(),
            closure: Vec::new(),
            limit: 50,
            path_limit: 0,
            now_unix_ms: 0,
            quiescence_seconds: 300,
        }
    }
}

impl SearchRequest {
    pub fn validate(&self) -> Result<(), QueryError> {
        if self.query.len() > MAX_QUERY_BYTES {
            return Err(QueryError::new(
                "QUERY_TOO_LONG",
                format!("query exceeds {MAX_QUERY_BYTES} UTF-8 bytes"),
            ));
        }
        if self.providers.len() > 16
            || self
                .providers
                .iter()
                .any(|provider| provider.is_empty() || provider.len() > 64 || !provider.is_ascii())
            || !strictly_sorted(self.providers.iter())
        {
            return Err(QueryError::new(
                "QUERY_INVALID_FILTER",
                "providers must contain at most 16 sorted unique non-empty ASCII values of at most 64 bytes",
            ));
        }
        for (name, keys) in [
            ("projectKeys", &self.project_keys),
            ("toolCapabilityKeys", &self.tool_capability_keys),
            ("skillCapabilityKeys", &self.skill_capability_keys),
        ] {
            if keys.len() > 64
                || keys.iter().any(|key| !valid_stable_key(key))
                || !strictly_sorted(keys.iter())
            {
                return Err(QueryError::new(
                    "QUERY_INVALID_FILTER",
                    format!(
                        "{name} must contain at most 64 sorted unique lowercase 32-byte hex keys"
                    ),
                ));
            }
        }
        if self.result_evidence.len() > 3
            || self
                .result_evidence
                .iter()
                .map(|value| result_filter_rank(*value))
                .collect::<Vec<_>>()
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
        {
            return Err(QueryError::new(
                "QUERY_INVALID_FILTER",
                "resultEvidence must contain at most 3 sorted unique values",
            ));
        }
        if self.closure.len() > 3
            || self
                .closure
                .iter()
                .map(|value| closure_filter_rank(*value))
                .collect::<Vec<_>>()
                .windows(2)
                .any(|pair| pair[0] >= pair[1])
        {
            return Err(QueryError::new(
                "QUERY_INVALID_FILTER",
                "closure must contain at most 3 sorted unique values",
            ));
        }
        if !sorted_unique_terminal_states(&self.capability_terminal_states) {
            return Err(QueryError::new(
                "QUERY_INVALID_FILTER",
                "capabilityTerminalStates must contain at most 5 sorted unique values",
            ));
        }
        if !self.capability_terminal_states.is_empty()
            && self.tool_capability_keys.is_empty()
            && self.skill_capability_keys.is_empty()
        {
            // The filter narrows a capability's own use rows, so without a capability key it
            // would silently become "any capability in this turn reached this state".
            return Err(QueryError::new(
                "QUERY_INVALID_FILTER",
                "capabilityTerminalStates requires toolCapabilityKeys or skillCapabilityKeys",
            ));
        }
        if self
            .after_unix_ms
            .zip(self.before_unix_ms)
            .is_some_and(|(after, before)| after >= before)
        {
            return Err(QueryError::new(
                "QUERY_INVALID_FILTER",
                "time range must satisfy afterUnixMs < beforeUnixMs",
            ));
        }
        if [
            self.after_unix_ms,
            self.before_unix_ms,
            Some(self.now_unix_ms),
        ]
        .into_iter()
        .flatten()
        .any(|value| value > i64::MAX as u64)
        {
            return Err(QueryError::new(
                "QUERY_INVALID_FILTER",
                "query timestamps must fit signed 64-bit Unix milliseconds",
            ));
        }
        if !(1..=MAX_SEARCH_RESULTS).contains(&self.limit) {
            return Err(QueryError::new(
                "QUERY_INVALID_LIMIT",
                format!("limit must be in 1..={MAX_SEARCH_RESULTS}"),
            ));
        }
        if self.path_limit > MAX_PATH_RESULTS {
            return Err(QueryError::new(
                "QUERY_INVALID_LIMIT",
                format!("pathLimit must be in 0..={MAX_PATH_RESULTS}"),
            ));
        }
        if !(60..=86_400).contains(&self.quiescence_seconds) {
            return Err(QueryError::new(
                "QUERY_INVALID_FILTER",
                "quiescenceSeconds must be in 60..=86400",
            ));
        }
        if self.query.is_empty() && !self.has_structured_filter() {
            return Err(QueryError::new(
                "QUERY_TOO_BROAD",
                "query requires text or a structured filter",
            ));
        }
        if self.order_by == SearchOrderBy::ObservedDesc && !self.query.is_empty() {
            // Relevance ordering can lean on a bounded candidate pool; true newest-first cannot,
            // so a text query has to name a window we are willing to sort in full.
            let Some((after, before)) = self.after_unix_ms.zip(self.before_unix_ms) else {
                return Err(QueryError::new(
                    "QUERY_TOO_BROAD",
                    "observed-desc with a text query requires afterUnixMs and beforeUnixMs",
                ));
            };
            if before.saturating_sub(after) > MAX_OBSERVED_DESC_WINDOW_MS {
                return Err(QueryError::new(
                    "QUERY_TOO_BROAD",
                    format!(
                        "observed-desc with a text query requires a window of at most {} days",
                        MAX_OBSERVED_DESC_WINDOW_MS / 86_400_000
                    ),
                ));
            }
        }
        Ok(())
    }

    fn has_structured_filter(&self) -> bool {
        !self.providers.is_empty()
            || !self.project_keys.is_empty()
            || !self.tool_capability_keys.is_empty()
            || !self.skill_capability_keys.is_empty()
            || !self.capability_terminal_states.is_empty()
            || self.after_unix_ms.is_some()
            || self.before_unix_ms.is_some()
            || !self.result_evidence.is_empty()
            || !self.closure.is_empty()
    }
}

pub(crate) fn valid_stable_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

pub(crate) fn strictly_sorted<'a>(values: impl Iterator<Item = &'a String>) -> bool {
    let values = values.collect::<Vec<_>>();
    values.windows(2).all(|pair| pair[0] < pair[1])
}

fn result_filter_rank(value: ResultEvidenceFilter) -> u8 {
    match value {
        ResultEvidenceFilter::Abandoned => 0,
        ResultEvidenceFilter::ProviderCompleted => 1,
        ResultEvidenceFilter::Unknown => 2,
    }
}

pub(crate) fn closure_filter_rank(value: ClosureFilter) -> u8 {
    match value {
        ClosureFilter::HardSealed => 0,
        ClosureFilter::Open => 1,
        ClosureFilter::Quiescent => 2,
    }
}

/// Ranked by wire spelling so the sorted-unique contract matches the JSON the caller sent.
pub(crate) fn terminal_state_rank(value: CapabilityTerminalState) -> u8 {
    match value {
        CapabilityTerminalState::Cancelled => 0,
        CapabilityTerminalState::Completed => 1,
        CapabilityTerminalState::Failed => 2,
        CapabilityTerminalState::Pending => 3,
        CapabilityTerminalState::Unknown => 4,
    }
}

pub(crate) fn terminal_state_text(value: CapabilityTerminalState) -> &'static str {
    match value {
        CapabilityTerminalState::Cancelled => "cancelled",
        CapabilityTerminalState::Completed => "completed",
        CapabilityTerminalState::Failed => "failed",
        CapabilityTerminalState::Pending => "pending",
        CapabilityTerminalState::Unknown => "unknown",
    }
}

pub(crate) fn sorted_unique_terminal_states(values: &[CapabilityTerminalState]) -> bool {
    values.len() <= 5
        && values
            .iter()
            .map(|value| terminal_state_rank(*value))
            .collect::<Vec<_>>()
            .windows(2)
            .all(|pair| pair[0] < pair[1])
}

pub(crate) fn sorted_unique_closure_filters(values: &[ClosureFilter]) -> bool {
    values.len() <= 3
        && values
            .iter()
            .map(|value| closure_filter_rank(*value))
            .collect::<Vec<_>>()
            .windows(2)
            .all(|pair| pair[0] < pair[1])
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MatchedFieldTerm {
    pub field: &'static str,
    pub term: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResult {
    pub turn_key: String,
    pub session_key: String,
    pub revision: String,
    pub provider: String,
    pub project_key: Option<String>,
    pub observed_timestamp: String,
    pub closure: ClosureFilter,
    pub result_evidence: ResultEvidenceFilter,
    pub problem_summary: String,
    pub problem_truncated: bool,
    pub final_summary: Option<String>,
    pub final_truncated: bool,
    pub dedupe: Option<SearchDedupe>,
    pub bm25_rank: Option<u16>,
    pub rank_component_ppm: u32,
    pub matched_field_terms: Vec<MatchedFieldTerm>,
    pub matched_term_indexes: Vec<u8>,
    pub coverage_ppm: u32,
    pub exact: bool,
    pub relevance_ppm: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchDedupe {
    pub duplicate_group_key: String,
    pub confidence: DedupeConfidence,
    pub observed_eof_provisional: bool,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryDiagnostic {
    pub analyze_micros: u64,
    pub df_micros: u64,
    pub posting_filter_micros: u64,
    pub rerank_micros: u64,
    pub path_micros: u64,
    pub zero_df_term_count: u16,
    pub high_frequency_term_count: u16,
    pub truncated_term_count: u16,
    pub scoring_term_count: u16,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchTrace {
    pub candidate_turn_keys: Vec<String>,
    pub candidate_count: u16,
    pub analyze_micros: u64,
    pub df_micros: u64,
    pub posting_filter_micros: u64,
    pub rerank_micros: u64,
    pub path_micros: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchResponse {
    pub snapshot_seq: String,
    pub projection_version: u32,
    pub analyzer_version: u32,
    pub ranker_version: u32,
    pub order_by: SearchOrderBy,
    /// Frozen clock the closure classifier ran at, echoed because results carry closure.
    pub closure_evaluated_at: String,
    pub quiescence_seconds: u32,
    pub total_match_count: String,
    pub scoring_terms: Vec<ScoringTermSummary>,
    pub results: Vec<SearchResult>,
    pub evidence_paths: EvidencePathReport,
    pub diagnostic: QueryDiagnostic,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ScoringTermSummary {
    pub logical_term: String,
    pub field: &'static str,
    pub token: String,
    pub document_frequency: String,
    pub field_document_count: String,
}

#[derive(Debug, Clone)]
struct ScoringTerm {
    query: QueryTerm,
    document_frequency: u64,
    field_document_count: u64,
    idf: f64,
}

#[derive(Debug)]
struct Candidate {
    turn_id: i64,
    turn_key: String,
    revision: String,
    provider: String,
    project_key: Option<String>,
    problem_text: String,
    final_excerpt: Option<String>,
    observed_timestamp: String,
    observed_unix_ms: u64,
    closure: ClosureFilter,
    result_evidence: ResultEvidenceFilter,
    session_key: String,
    duplicate_group_key: Option<String>,
    duplicate_method: Option<String>,
    dedupe_closure: Option<String>,
}

#[derive(Default)]
pub(crate) struct SqlParameters {
    pub(crate) values: Vec<Value>,
}

impl SqlParameters {
    pub(crate) fn bind(&mut self, value: Value) -> String {
        self.values.push(value);
        format!("?{}", self.values.len())
    }

    pub(crate) fn bind_list(&mut self, values: impl IntoIterator<Item = Value>) -> String {
        values
            .into_iter()
            .map(|value| self.bind(value))
            .collect::<Vec<_>>()
            .join(",")
    }
}

pub fn search_with_trace(
    connection: &Connection,
    request: SearchRequest,
) -> Result<(SearchResponse, SearchTrace), QueryError> {
    request.validate()?;
    if crate::search_projection::active_search_projection_version(connection)
        .map_err(|_| QueryError::new("QUERY_FAILED", "search projection state could not be read"))?
        != Some(SEARCH_PROJECTION_VERSION)
    {
        let status = crate::search_projection::target_search_projection_status(connection)
            .map_err(|_| {
                QueryError::new("QUERY_FAILED", "search projection state could not be read")
            })?;
        if status.as_deref() == Some("failed") {
            return Err(QueryError::new(
                "TS_INSIGHTS_PROJECTION_FAILED",
                "Turn search projection build failed",
            ));
        }
        return Err(QueryError::new(
            "TS_INSIGHTS_PROJECTION_BUILDING",
            "Turn search projection is still building",
        ));
    }
    // Frozen before any classification so every row in this response, and the echoed clock,
    // describe the same instant.
    let closure_evaluated_at = canonical_timestamp(request.now_unix_ms)?;
    let transaction = connection.unchecked_transaction().map_err(query_failed)?;
    let snapshot_seq = transaction
        .query_row(
            "SELECT value FROM engine_metadata WHERE key='snapshot_seq'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(query_failed)?;

    let mut diagnostic = QueryDiagnostic::default();
    let analyze_started = Instant::now();
    let analyzed = if request.query.is_empty() {
        None
    } else {
        match analyze_query(&request.query) {
            Ok(analyzed) => Some(analyzed),
            Err(AnalyzerError::QueryTooLong) => {
                return Err(QueryError::new(
                    "QUERY_TOO_LONG",
                    "query exceeds 8192 UTF-8 bytes",
                ));
            }
            // Never fall back to a filter-only scan: the caller typed text, and answering with
            // recent turns that ignore it looks like a match when it is not one.
            Err(AnalyzerError::QueryTooBroad) => {
                return Err(QueryError::new(
                    "QUERY_TOO_BROAD",
                    "query has fewer than two searchable characters",
                ));
            }
        }
    };
    diagnostic.analyze_micros = elapsed_micros(analyze_started);

    let scoring_terms = if let Some(analyzed) = &analyzed {
        let df_started = Instant::now();
        let (terms, zero, high, scoring_truncated) =
            select_scoring_terms(&transaction, &analyzed.terms).map_err(query_failed)?;
        diagnostic.df_micros = elapsed_micros(df_started);
        diagnostic.zero_df_term_count = saturating_u16(zero);
        diagnostic.high_frequency_term_count = saturating_u16(high);
        diagnostic.truncated_term_count = saturating_u16(
            analyzed
                .input_distinct_field_term_count
                .saturating_sub(analyzed.terms.len())
                + scoring_truncated,
        );
        terms
    } else {
        Vec::new()
    };
    diagnostic.scoring_term_count = saturating_u16(scoring_terms.len());

    let posting_started = Instant::now();
    let (candidates, total_match_count) = query_candidates(
        &transaction,
        &request,
        analyzed.as_ref().map(|_| scoring_terms.as_slice()),
    )?;
    diagnostic.posting_filter_micros = elapsed_micros(posting_started);
    let candidate_turn_keys = candidates
        .iter()
        .map(|candidate| candidate.turn_key.clone())
        .collect::<Vec<_>>();

    let rerank_started = Instant::now();
    let mut ranked = rerank_candidates(&transaction, candidates, &request, &scoring_terms)?;
    diagnostic.rerank_micros = elapsed_micros(rerank_started);
    let path_started = Instant::now();
    let dedupe_limit = if request.path_limit == 0 {
        usize::from(request.limit)
    } else {
        MAX_SEARCH_RESULTS as usize
    };
    let group_keys = ranked
        .iter()
        .take(dedupe_limit)
        .filter_map(|(_, candidate)| candidate.duplicate_group_key.clone())
        .collect::<BTreeSet<_>>();
    let group_confidences = read_group_confidences(&transaction, &group_keys)?;
    for (result, candidate) in ranked.iter_mut().take(usize::from(request.limit)) {
        result.dedupe = candidate
            .duplicate_group_key
            .as_ref()
            .map(|group| SearchDedupe {
                duplicate_group_key: group.clone(),
                confidence: group_confidences
                    .get(group)
                    .copied()
                    .unwrap_or(DedupeConfidence::Weak),
                observed_eof_provisional: observed_eof_provisional(candidate),
            });
    }
    let path_turns = if request.path_limit == 0 {
        Vec::new()
    } else {
        ranked
            .iter()
            .take(MAX_SEARCH_RESULTS as usize)
            .map(|(result, candidate)| {
                read_path_turn(&transaction, result, candidate, &group_confidences)
            })
            .collect::<Result<Vec<_>, _>>()?
    };
    let evidence_paths = build_evidence_paths(&path_turns, request.path_limit);
    diagnostic.path_micros = elapsed_micros(path_started);
    ranked.truncate(usize::from(request.limit));
    let results = ranked.into_iter().map(|(result, _)| result).collect();
    let scoring_terms = scoring_terms
        .iter()
        .map(|term| ScoringTermSummary {
            logical_term: term.query.logical.clone(),
            field: term.query.field.as_str(),
            token: term.query.encoded.clone(),
            document_frequency: term.document_frequency.to_string(),
            field_document_count: term.field_document_count.to_string(),
        })
        .collect();
    transaction.commit().map_err(query_failed)?;
    let trace = SearchTrace {
        candidate_count: saturating_u16(candidate_turn_keys.len()),
        candidate_turn_keys,
        analyze_micros: diagnostic.analyze_micros,
        df_micros: diagnostic.df_micros,
        posting_filter_micros: diagnostic.posting_filter_micros,
        rerank_micros: diagnostic.rerank_micros,
        path_micros: diagnostic.path_micros,
    };
    Ok((
        SearchResponse {
            snapshot_seq,
            projection_version: SEARCH_PROJECTION_VERSION,
            analyzer_version: ANALYZER_WIRE_VERSION,
            ranker_version: RANKER_VERSION,
            order_by: request.order_by,
            closure_evaluated_at,
            quiescence_seconds: request.quiescence_seconds,
            total_match_count: total_match_count.to_string(),
            scoring_terms,
            results,
            evidence_paths,
            diagnostic,
        },
        trace,
    ))
}

fn select_scoring_terms(
    connection: &Connection,
    terms: &[QueryTerm],
) -> rusqlite::Result<(Vec<ScoringTerm>, usize, usize, usize)> {
    let mut candidates = Vec::new();
    let mut zero_count = 0;
    let mut high_count = 0;
    for field in [
        AnalyzerField::Natural,
        AnalyzerField::Code,
        AnalyzerField::Capability,
    ] {
        let field_terms = terms
            .iter()
            .filter(|term| term.field == field)
            .cloned()
            .collect::<Vec<_>>();
        if field_terms.is_empty() {
            continue;
        }
        let fts_field = analyzer_fts_field(field);
        let frequencies = lookup_field_document_frequencies(
            connection,
            fts_field,
            &field_terms
                .iter()
                .map(|term| term.encoded.clone())
                .collect::<Vec<_>>(),
        )?
        .into_iter()
        .map(|frequency| (frequency.term, frequency.document_count))
        .collect::<BTreeMap<_, _>>();
        let field_document_count = connection.query_row(
            "SELECT fts_doc_count FROM field_stats WHERE field=?1",
            [fts_field.as_str()],
            |row| row.get::<_, i64>(0),
        )?;
        let field_document_count = u64::try_from(field_document_count)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, field_document_count))?;
        let mut present = field_terms
            .into_iter()
            .filter_map(|query| {
                let document_frequency = frequencies.get(&query.encoded).copied().unwrap_or(0);
                if document_frequency == 0 {
                    zero_count += 1;
                    None
                } else {
                    Some((query, document_frequency))
                }
            })
            .collect::<Vec<_>>();
        if field != AnalyzerField::Capability && !present.is_empty() {
            let high = |df: u64| u128::from(df) * 5 > u128::from(field_document_count);
            if present.iter().any(|(_, df)| !high(*df)) {
                let previous = present.len();
                present.retain(|(_, df)| !high(*df));
                high_count += previous - present.len();
            } else {
                present.sort_by(scoring_order);
                high_count += present.len().saturating_sub(2);
                present.truncate(2);
            }
        }
        candidates.extend(present.into_iter().map(|(query, document_frequency)| {
            let idf = (((field_document_count + 1) as f64) / ((document_frequency + 1) as f64))
                .ln()
                + 1.0;
            ScoringTerm {
                query,
                document_frequency,
                field_document_count,
                idf,
            }
        }));
    }
    candidates.sort_by(|left, right| {
        scoring_order(
            &(left.query.clone(), left.document_frequency),
            &(right.query.clone(), right.document_frequency),
        )
    });
    let truncated = candidates.len().saturating_sub(MAX_SCORING_TERMS);
    candidates.truncate(MAX_SCORING_TERMS);
    Ok((candidates, zero_count, high_count, truncated))
}

fn scoring_order(left: &(QueryTerm, u64), right: &(QueryTerm, u64)) -> std::cmp::Ordering {
    left.1
        .cmp(&right.1)
        .then_with(|| field_priority(left.0.field).cmp(&field_priority(right.0.field)))
        .then_with(|| left.0.source_offset.cmp(&right.0.source_offset))
        .then_with(|| left.0.field.cmp(&right.0.field))
        .then_with(|| left.0.encoded.cmp(&right.0.encoded))
}

fn field_priority(field: AnalyzerField) -> u8 {
    match field {
        AnalyzerField::Code => 0,
        AnalyzerField::Natural => 1,
        AnalyzerField::Capability => 2,
    }
}

fn analyzer_fts_field(field: AnalyzerField) -> FtsField {
    match field {
        AnalyzerField::Natural => FtsField::Natural,
        AnalyzerField::Code => FtsField::Code,
        AnalyzerField::Capability => FtsField::Capability,
    }
}

fn query_candidates(
    connection: &Connection,
    request: &SearchRequest,
    scoring_terms: Option<&[ScoringTerm]>,
) -> Result<(Vec<Candidate>, u64), QueryError> {
    if scoring_terms.is_some_and(<[ScoringTerm]>::is_empty) {
        return Ok((Vec::new(), 0));
    }
    let mut parameters = SqlParameters::default();
    let threshold_ns = request
        .now_unix_ms
        .saturating_sub(u64::from(request.quiescence_seconds) * 1_000)
        .saturating_mul(1_000_000);
    let threshold = parameters.bind(Value::Blob(threshold_ns.to_be_bytes().to_vec()));
    let hard = hard_sealed_sql();
    let closure = format!(
        "CASE WHEN {hard} THEN 'hard-sealed' \
         WHEN sc.eof_observed=1 AND sc.source_mtime_ns<={threshold} THEN 'quiescent' \
         ELSE 'open' END"
    );
    let result_evidence = "CASE t.provider_terminal WHEN 'completed' THEN 'provider-completed' WHEN 'aborted' THEN 'abandoned' ELSE 'unknown' END";
    let mut filters = vec![
        "s.eligibility='eligible'".to_owned(),
        "s.session_scope='main'".to_owned(),
        "t.effective_provider_visibility='active'".to_owned(),
        "t.revision IS NOT NULL".to_owned(),
        "t.observed_timestamp IS NOT NULL".to_owned(),
        "NOT EXISTS (SELECT 1 FROM source_purge_states purge WHERE purge.session_key=s.session_key)".to_owned(),
    ];
    append_structured_filters(
        &mut filters,
        &mut parameters,
        request,
        &closure,
        result_evidence,
    )?;

    let filter_only_limit = if request.path_limit == 0 {
        usize::from(request.limit)
    } else {
        MAX_SEARCH_RESULTS as usize
    };
    let mut observed_desc_text = false;
    let (score_select, fts_filter, order, limit) = if let Some(terms) = scoring_terms {
        let expression = FtsMatchExpression::from_query_terms(
            &terms
                .iter()
                .map(|term| term.query.clone())
                .collect::<Vec<_>>(),
        )
        .map_err(query_failed)?;
        let match_parameter = parameters.bind(Value::Text(expression.as_str().to_owned()));
        let fts_filter = format!("turns_fts MATCH {match_parameter}");
        if request.order_by == SearchOrderBy::ObservedDesc {
            // The ranked pool would silently drop older matches, so refuse to answer
            // "newest first" at all unless the whole match set is small enough to sort.
            observed_desc_text = true;
            (
                "0.0",
                fts_filter,
                "t.observed_timestamp DESC, t.turn_key ASC",
                filter_only_limit,
            )
        } else {
            (
                "bm25(turns_fts, 8.0, 4.0, 2.0)",
                fts_filter,
                "bm25(turns_fts, 8.0, 4.0, 2.0) ASC, t.turn_key ASC",
                MAX_FTS_CANDIDATES,
            )
        }
    } else {
        (
            "0.0",
            "1=1".to_owned(),
            "t.observed_timestamp DESC, t.turn_key ASC",
            filter_only_limit,
        )
    };
    filters.push(fts_filter);
    let total_match_count = count_filtered_matches(
        connection,
        &filters,
        &parameters,
        scoring_terms.is_some(),
        observed_desc_text.then_some(MAX_OBSERVED_DESC_MATCHES),
    )?;
    let limit_parameter = parameters.bind(Value::Integer(limit as i64));
    let sql = format!(
        "SELECT t.turn_id,lower(hex(t.turn_key)),lower(hex(t.revision)),s.provider,
                lower(hex(s.project_key)),t.problem_text,t.final_answer_excerpt,
                t.observed_timestamp,
                COALESCE(CAST(unixepoch(t.observed_timestamp,'subsec')*1000 AS INTEGER),0),
                {closure},{result_evidence},lower(hex(s.session_key)),
                lower(hex(s.duplicate_group_key)),s.duplicate_method,s.dedupe_closure,
                {score_select}
         FROM turns t
         JOIN sessions s ON s.session_id=t.session_id
         JOIN source_checkpoints sc ON sc.session_id=s.session_id
         {}
         WHERE {}
         ORDER BY {order}
         LIMIT {limit_parameter}",
        if scoring_terms.is_some() {
            "JOIN turns_fts ON turns_fts.rowid=t.turn_id"
        } else {
            ""
        },
        filters.join(" AND ")
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let candidates = statement
        .query_map(params_from_iter(parameters.values), |row| {
            let closure: String = row.get(9)?;
            let result: String = row.get(10)?;
            Ok(Candidate {
                turn_id: row.get(0)?,
                turn_key: row.get(1)?,
                revision: row.get(2)?,
                provider: row.get(3)?,
                project_key: empty_hex_to_none(row.get(4)?),
                problem_text: row.get(5)?,
                final_excerpt: row.get(6)?,
                observed_timestamp: row.get(7)?,
                observed_unix_ms: u64::try_from(row.get::<_, i64>(8)?).unwrap_or(0),
                closure: parse_closure(&closure),
                result_evidence: parse_result_evidence(&result),
                session_key: row.get(11)?,
                duplicate_group_key: empty_hex_to_none(row.get(12)?),
                duplicate_method: row.get(13)?,
                dedupe_closure: row.get(14)?,
            })
        })
        .map_err(query_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(query_failed)?;
    Ok((candidates, total_match_count))
}

/// Counts the complete filtered universe. `observed-desc` text queries retain their 10,001-row
/// bounded probe: the count is exact only when it is small enough for true newest-first sorting.
fn count_filtered_matches(
    connection: &Connection,
    filters: &[String],
    parameters: &SqlParameters,
    join_fts: bool,
    bounded_cap: Option<usize>,
) -> Result<u64, QueryError> {
    let from = format!(
        "FROM turns t
         JOIN sessions s ON s.session_id=t.session_id
         JOIN source_checkpoints sc ON sc.session_id=s.session_id
         {}",
        if join_fts {
            "JOIN turns_fts ON turns_fts.rowid=t.turn_id"
        } else {
            ""
        }
    );
    let predicate = filters.join(" AND ");
    let sql = match bounded_cap {
        Some(cap) => format!(
            "SELECT COUNT(*) FROM (SELECT 1 {from} WHERE {predicate} LIMIT {})",
            cap + 1
        ),
        None => format!("SELECT COUNT(*) {from} WHERE {predicate}"),
    };
    let matches: i64 = connection
        .query_row(&sql, params_from_iter(parameters.values.iter()), |row| {
            row.get(0)
        })
        .map_err(query_failed)?;
    if bounded_cap.is_some_and(|cap| matches as usize > cap) {
        return Err(QueryError::new(
            "QUERY_TOO_BROAD",
            format!(
                "observed-desc with a text query matches more than {MAX_OBSERVED_DESC_MATCHES} turns"
            ),
        ));
    }
    u64::try_from(matches)
        .map_err(|_| query_failed(rusqlite::Error::IntegralValueOutOfRange(0, matches)))
}

fn append_structured_filters(
    filters: &mut Vec<String>,
    parameters: &mut SqlParameters,
    request: &SearchRequest,
    closure_expression: &str,
    result_expression: &str,
) -> Result<(), QueryError> {
    if !request.providers.is_empty() {
        let values = parameters.bind_list(request.providers.iter().cloned().map(Value::Text));
        filters.push(format!("s.provider IN ({values})"));
    }
    if !request.project_keys.is_empty() {
        let values = parameters.bind_list(stable_key_values(&request.project_keys)?);
        filters.push(format!("s.project_key IN ({values})"));
    }
    // The terminal-state predicate lives inside the same EXISTS as the capability key so it
    // constrains the same use row; hoisting it out would match "this turn used X and, separately,
    // something reached this state".
    let terminal_clause = if request.capability_terminal_states.is_empty() {
        String::new()
    } else {
        let values = parameters.bind_list(
            request
                .capability_terminal_states
                .iter()
                .map(|value| Value::Text(terminal_state_text(*value).to_owned())),
        );
        format!(" AND COALESCE(use_filter.provider_terminal_state,'unknown') IN ({values})")
    };
    for (keys, kind) in [
        (&request.tool_capability_keys, "tool"),
        (&request.skill_capability_keys, "skill"),
    ] {
        if !keys.is_empty() {
            let values = parameters.bind_list(stable_key_values(keys)?);
            filters.push(format!(
                "EXISTS (SELECT 1 FROM capability_uses use_filter \
                 JOIN capabilities capability_filter ON capability_filter.capability_id=use_filter.capability_id \
                 WHERE use_filter.turn_id=t.turn_id AND use_filter.origin_scope='main' \
                 AND capability_filter.capability_kind='{kind}' \
                 AND capability_filter.capability_key IN ({values}){terminal_clause})"
            ));
        }
    }
    // Compared as canonical RFC3339 millisecond UTC text so the range stays sargable against
    // turns_query_filters; wrapping the column in unixepoch() would force a scan.
    if let Some(after) = request.after_unix_ms {
        let value = parameters.bind(Value::Text(canonical_timestamp(after)?));
        filters.push(format!("t.observed_timestamp>={value}"));
    }
    if let Some(before) = request.before_unix_ms {
        let value = parameters.bind(Value::Text(canonical_timestamp(before)?));
        filters.push(format!("t.observed_timestamp<{value}"));
    }
    if !request.result_evidence.is_empty() {
        let values = parameters.bind_list(
            request
                .result_evidence
                .iter()
                .map(|value| Value::Text(result_evidence_text(*value).to_owned())),
        );
        filters.push(format!("({result_expression}) IN ({values})"));
    }
    if !request.closure.is_empty() {
        let values = parameters.bind_list(
            request
                .closure
                .iter()
                .map(|value| Value::Text(closure_text(*value).to_owned())),
        );
        filters.push(format!("({closure_expression}) IN ({values})"));
    }
    Ok(())
}

fn observed_eof_provisional(candidate: &Candidate) -> bool {
    candidate.duplicate_method.as_deref() == Some("exact-first-turn-prefix")
        && candidate.dedupe_closure.as_deref() == Some("observed-eof")
}

pub(crate) fn hard_sealed_sql() -> &'static str {
    "((t.next_user_boundary=1 AND EXISTS (
       SELECT 1 FROM turn_evidence seal_link
       JOIN evidence_events seal_event ON seal_event.event_id=seal_link.event_id
       JOIN visible_message_events seal_message ON seal_message.event_id=seal_event.event_id
       WHERE seal_link.turn_id=t.turn_id AND seal_link.role='follow-up'
         AND seal_message.message_role='user'))
     OR (t.provider_terminal IS NOT NULL AND EXISTS (
       SELECT 1 FROM turn_evidence seal_link
       JOIN evidence_events seal_event ON seal_event.event_id=seal_link.event_id
       JOIN turn_lifecycle_events seal_lifecycle ON seal_lifecycle.event_id=seal_event.event_id
       WHERE seal_link.turn_id=t.turn_id AND seal_link.role='lifecycle'
         AND ((t.provider_terminal='completed' AND seal_lifecycle.lifecycle_state='completed')
           OR (t.provider_terminal='aborted' AND seal_lifecycle.lifecycle_state='aborted')))))"
}

fn rerank_candidates(
    connection: &Connection,
    candidates: Vec<Candidate>,
    request: &SearchRequest,
    scoring_terms: &[ScoringTerm],
) -> Result<Vec<(SearchResult, Candidate)>, QueryError> {
    // Under observed-desc the SQL already emitted true newest-first and skipped bm25, so the
    // candidate index is a timeline position, not a rank.
    let ranked_by_relevance =
        !scoring_terms.is_empty() && request.order_by == SearchOrderBy::Relevance;
    let total_idf = scoring_terms.iter().map(|term| term.idf).sum::<f64>();
    let normalized_query = normalize_exact(&request.query);
    let mut ranked = Vec::with_capacity(candidates.len());
    for (index, candidate) in candidates.into_iter().enumerate() {
        let capabilities = read_analyzer_capabilities(connection, candidate.turn_id)?;
        let inputs = capabilities
            .iter()
            .map(|(key, name, ordinal)| CapabilityInput {
                origin_scope: AnalyzerOriginScope::Main,
                turn_ordinal: *ordinal,
                capability_key: key,
                canonical_name: Some(name),
            })
            .collect::<Vec<_>>();
        let document = analyze_document(&candidate.problem_text, &inputs);
        let document_terms = document_term_set(&document);
        let matched = scoring_terms
            .iter()
            .enumerate()
            .filter(|(_, term)| {
                document_terms.contains(&(term.query.field, term.query.encoded.clone()))
            })
            .collect::<Vec<_>>();
        let matched_idf = matched.iter().map(|(_, term)| term.idf).sum::<f64>();
        let coverage = if total_idf > 0.0 {
            matched_idf / total_idf
        } else {
            0.0
        };
        let exact = !normalized_query.is_empty()
            && normalize_exact(&candidate.problem_text).contains(&normalized_query);
        let rank_component = if ranked_by_relevance {
            61.0 / (60.0 + (index + 1) as f64)
        } else {
            0.0
        };
        let relevance = 0.45 * rank_component + 0.40 * coverage + 0.15 * f64::from(exact);
        let result = SearchResult {
            turn_key: candidate.turn_key.clone(),
            session_key: candidate.session_key.clone(),
            revision: candidate.revision.clone(),
            provider: candidate.provider.clone(),
            project_key: candidate.project_key.clone(),
            observed_timestamp: candidate.observed_timestamp.clone(),
            closure: candidate.closure,
            result_evidence: candidate.result_evidence,
            problem_summary: utf8_prefix(&candidate.problem_text, SUMMARY_BYTES),
            problem_truncated: candidate.problem_text.len() > SUMMARY_BYTES,
            final_summary: candidate
                .final_excerpt
                .as_deref()
                .map(|value| utf8_prefix(value, SUMMARY_BYTES)),
            final_truncated: candidate
                .final_excerpt
                .as_ref()
                .is_some_and(|value| value.len() > SUMMARY_BYTES),
            dedupe: None,
            bm25_rank: ranked_by_relevance.then(|| saturating_u16(index + 1)),
            rank_component_ppm: ppm(rank_component),
            matched_field_terms: matched
                .iter()
                .map(|(_, term)| MatchedFieldTerm {
                    field: term.query.field.as_str(),
                    term: term.query.logical.clone(),
                })
                .collect(),
            matched_term_indexes: matched
                .iter()
                .map(|(index, _)| u8::try_from(*index).expect("scoring term cap fits u8"))
                .collect(),
            coverage_ppm: ppm(coverage),
            exact,
            relevance_ppm: ppm(relevance),
        };
        ranked.push((result, candidate));
    }
    if ranked_by_relevance {
        ranked.sort_by(|left, right| {
            right
                .0
                .relevance_ppm
                .cmp(&left.0.relevance_ppm)
                .then_with(|| right.0.observed_timestamp.cmp(&left.0.observed_timestamp))
                .then_with(|| left.0.turn_key.cmp(&right.0.turn_key))
        });
    }
    ranked.truncate(MAX_SEARCH_RESULTS as usize);
    Ok(ranked)
}

fn read_analyzer_capabilities(
    connection: &Connection,
    turn_id: i64,
) -> Result<Vec<(Vec<u8>, String, u64)>, QueryError> {
    let mut statement = connection
        .prepare(
            "SELECT c.capability_key,c.canonical_name,u.turn_ordinal
             FROM capability_uses u
             JOIN capabilities c ON c.capability_id=u.capability_id
             WHERE u.turn_id=?1 AND u.origin_scope='main'
             ORDER BY u.turn_ordinal,u.use_key",
        )
        .map_err(query_failed)?;
    statement
        .query_map([turn_id], |row| {
            let ordinal = row.get::<_, Vec<u8>>(2)?;
            let ordinal_len = ordinal.len();
            Ok((
                row.get(0)?,
                row.get(1)?,
                u64::from_be_bytes(ordinal.try_into().map_err(|_| {
                    rusqlite::Error::IntegralValueOutOfRange(2, ordinal_len as i64)
                })?),
            ))
        })
        .map_err(query_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(query_failed)
}

fn document_term_set(
    document: &crate::analyzer::AnalyzedDocument,
) -> BTreeSet<(AnalyzerField, String)> {
    document
        .natural
        .terms
        .iter()
        .chain(document.code.terms.iter())
        .chain(document.capability.terms.iter())
        .map(|term| (term.field, term.encoded.clone()))
        .collect()
}

fn read_path_turn(
    connection: &Connection,
    result: &SearchResult,
    candidate: &Candidate,
    group_confidences: &BTreeMap<String, DedupeConfidence>,
) -> Result<EvidencePathTurn, QueryError> {
    let mut statement = connection
        .prepare(
            "SELECT lower(hex(c.capability_key)),c.canonical_name,u.turn_ordinal,u.origin_scope,u.provider_terminal_state
             FROM capability_uses u
             JOIN capabilities c ON c.capability_id=u.capability_id
             WHERE u.turn_id=?1 AND c.capability_kind='tool'
             ORDER BY u.turn_ordinal,u.use_key",
        )
        .map_err(query_failed)?;
    let tools = statement
        .query_map([candidate.turn_id], |row| {
            let ordinal = row.get::<_, Vec<u8>>(2)?;
            let ordinal_len = ordinal.len();
            Ok(ToolPathUse {
                capability_key: row.get(0)?,
                canonical_name: row.get(1)?,
                turn_ordinal: u64::from_be_bytes(ordinal.try_into().map_err(|_| {
                    rusqlite::Error::IntegralValueOutOfRange(2, ordinal_len as i64)
                })?),
                origin_scope: parse_origin_scope(&row.get::<_, String>(3)?),
                terminal_state: parse_capability_state(&row.get::<_, String>(4)?),
            })
        })
        .map_err(query_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(query_failed)?;
    Ok(EvidencePathTurn {
        delivery_attribution: read_turn_delivery_attribution(connection, candidate.turn_id)?,
        turn_key: result.turn_key.clone(),
        session_key: candidate.session_key.clone(),
        provider: result.provider.clone(),
        relevance_ppm: result.relevance_ppm,
        observed_unix_ms: candidate.observed_unix_ms,
        closure: result.closure,
        session_scope: SessionScope::Main,
        provider_visibility: ProviderVisibility::Active,
        duplicate_group_key: candidate.duplicate_group_key.clone(),
        dedupe_confidence: candidate.duplicate_group_key.as_ref().map(|group| {
            group_confidences
                .get(group)
                .copied()
                .unwrap_or(DedupeConfidence::Weak)
        }),
        observed_eof_provisional: observed_eof_provisional(candidate),
        tools,
    })
}

/// Reads one Turn's delivery attribution from the projected delivery graph rather than
/// re-deriving it: the commit-correlation algorithm lives in the delivery projection alone.
/// A project with no registered repository yields `Uncovered`, never `None`, so an
/// unindexed workspace cannot read as a path that ships nothing.
///
/// A registered repository that the last scan could not read counts as no coverage for the
/// same reason. Such a scan carries no commits, so no Turn under it can gain a delivery edge;
/// calling those Turns `None` would report "this path ships nothing" about a repository nobody
/// could look at. `available` describes the most recent scan rather than the moment the Turn
/// happened, so these counts move back once the repository can be read again -- which is what a
/// Derived reading is for, and what a reader of the counts has to know.
fn read_turn_delivery_attribution(
    connection: &Connection,
    turn_id: i64,
) -> Result<TurnDeliveryAttribution, QueryError> {
    let row = connection
        .query_row(
            "SELECT
               EXISTS (SELECT 1 FROM repository_project_keys p
                       JOIN repository_sources source ON source.repository_id=p.repository_id
                       WHERE p.project_key=s.project_key AND source.available=1),
               (SELECT MIN(CASE edge.relation WHEN 'turn-observed-commit' THEN 0 ELSE 1 END)
                FROM repository_project_keys p
                JOIN delivery_trace_edges edge ON edge.repository_id=p.repository_id
                 AND edge.from_kind='turn' AND edge.from_key=t.turn_key
                 AND edge.relation IN ('turn-observed-commit','turn-correlates-commit')
                WHERE p.project_key=s.project_key)
             FROM turns t JOIN sessions s ON s.session_id=t.session_id
             WHERE t.turn_id=?1",
            [turn_id],
            |row| Ok((row.get::<_, bool>(0)?, row.get::<_, Option<i64>>(1)?)),
        )
        .map_err(query_failed)?;
    Ok(match row {
        (_, Some(0)) => TurnDeliveryAttribution::Direct,
        (_, Some(_)) => TurnDeliveryAttribution::Observed,
        (true, None) => TurnDeliveryAttribution::None,
        (false, None) => TurnDeliveryAttribution::Uncovered,
    })
}

/// Classifies whole duplicate groups, so it deliberately reads the global eligible/main/nonpurged
/// population rather than the caller's filtered slice: a group's confidence must not change with
/// the query that happened to surface it.
pub(crate) fn read_group_confidences(
    connection: &Connection,
    group_keys: &BTreeSet<String>,
) -> Result<BTreeMap<String, DedupeConfidence>, QueryError> {
    if group_keys.is_empty() {
        return Ok(BTreeMap::new());
    }
    let values = stable_key_values(&group_keys.iter().cloned().collect::<Vec<_>>())?;
    let placeholders = (1..=values.len())
        .map(|index| format!("?{index}"))
        .collect::<Vec<_>>()
        .join(",");
    let sql = format!(
        "SELECT lower(hex(group_key)),
                MAX(explicit_strong),
                CASE WHEN SUM(CASE WHEN corroboration IS NOT NULL THEN 1 ELSE 0 END)=1
                           AND MAX(CASE WHEN corroboration IS NOT NULL THEN member_count ELSE 0 END)>=2
                     THEN 1 ELSE 0 END
         FROM (
           SELECT duplicate_group_key AS group_key,
                  dedupe_corroboration_fingerprint AS corroboration,
                  MAX(CASE WHEN duplicate_method='explicit-lineage'
                                AND duplicate_confidence='strong'
                           THEN 1 ELSE 0 END) AS explicit_strong,
                  COUNT(*) AS member_count
           FROM sessions
           WHERE eligibility='eligible' AND session_scope='main'
             AND NOT EXISTS (SELECT 1 FROM source_purge_states purge
                             WHERE purge.session_key=sessions.session_key)
             AND duplicate_group_key IN ({placeholders})
           GROUP BY duplicate_group_key,dedupe_corroboration_fingerprint
         )
         GROUP BY group_key"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    statement
        .query_map(params_from_iter(values), |row| {
            let explicit = row.get::<_, i64>(1)? != 0;
            let corroborated = row.get::<_, i64>(2)? != 0;
            Ok((
                row.get::<_, String>(0)?,
                if explicit || corroborated {
                    DedupeConfidence::Strong
                } else {
                    DedupeConfidence::Weak
                },
            ))
        })
        .map_err(query_failed)?
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(query_failed)
}

pub(crate) fn stable_key_values(keys: &[String]) -> Result<Vec<Value>, QueryError> {
    keys.iter()
        .map(|key| {
            hex::decode(key).map(Value::Blob).map_err(|_| {
                QueryError::new("QUERY_INVALID_FILTER", "invalid lowercase stable key")
            })
        })
        .collect()
}

fn empty_hex_to_none(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn parse_closure(value: &str) -> ClosureFilter {
    match value {
        "hard-sealed" => ClosureFilter::HardSealed,
        "quiescent" => ClosureFilter::Quiescent,
        _ => ClosureFilter::Open,
    }
}

fn parse_result_evidence(value: &str) -> ResultEvidenceFilter {
    match value {
        "provider-completed" => ResultEvidenceFilter::ProviderCompleted,
        "abandoned" => ResultEvidenceFilter::Abandoned,
        _ => ResultEvidenceFilter::Unknown,
    }
}

pub(crate) fn closure_text(value: ClosureFilter) -> &'static str {
    match value {
        ClosureFilter::HardSealed => "hard-sealed",
        ClosureFilter::Quiescent => "quiescent",
        ClosureFilter::Open => "open",
    }
}

fn result_evidence_text(value: ResultEvidenceFilter) -> &'static str {
    match value {
        ResultEvidenceFilter::ProviderCompleted => "provider-completed",
        ResultEvidenceFilter::Abandoned => "abandoned",
        ResultEvidenceFilter::Unknown => "unknown",
    }
}

fn parse_origin_scope(value: &str) -> OriginScope {
    match value {
        "main" => OriginScope::Main,
        "subagent" => OriginScope::Subagent,
        _ => OriginScope::Unknown,
    }
}

fn parse_capability_state(value: &str) -> CapabilityTerminalState {
    match value {
        "pending" => CapabilityTerminalState::Pending,
        "completed" => CapabilityTerminalState::Completed,
        "failed" => CapabilityTerminalState::Failed,
        "cancelled" => CapabilityTerminalState::Cancelled,
        _ => CapabilityTerminalState::Unknown,
    }
}

fn normalize_exact(value: &str) -> String {
    value.nfkc().flat_map(char::to_lowercase).collect()
}

fn utf8_prefix(value: &str, max_bytes: usize) -> String {
    if value.len() <= max_bytes {
        return value.to_owned();
    }
    let mut end = max_bytes;
    while !value.is_char_boundary(end) {
        end -= 1;
    }
    value[..end].to_owned()
}

fn ppm(value: f64) -> u32 {
    (value.clamp(0.0, 1.0) * 1_000_000.0).round() as u32
}

fn elapsed_micros(started: Instant) -> u64 {
    started.elapsed().as_micros().try_into().unwrap_or(u64::MAX)
}

fn saturating_u16(value: usize) -> u16 {
    value.try_into().unwrap_or(u16::MAX)
}

pub(crate) fn query_failed(error: rusqlite::Error) -> QueryError {
    QueryError::new("QUERY_FAILED", error.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    fn confidence_connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE sessions (
                   session_id INTEGER PRIMARY KEY,
                   session_key BLOB NOT NULL UNIQUE,
                   eligibility TEXT NOT NULL,
                   session_scope TEXT NOT NULL,
                   duplicate_group_key BLOB,
                   dedupe_corroboration_fingerprint BLOB,
                   duplicate_method TEXT,
                   duplicate_confidence TEXT
                 );
                 CREATE INDEX sessions_dedupe_support
                   ON sessions(duplicate_group_key,eligibility,session_scope,
                     duplicate_method,duplicate_confidence,
                     dedupe_corroboration_fingerprint,session_id);
                 CREATE TABLE source_purge_states (
                   session_key BLOB PRIMARY KEY,
                   purge_state TEXT NOT NULL
                 );",
            )
            .unwrap();
        connection
    }

    fn insert_session(
        connection: &Connection,
        id: u8,
        group: u8,
        confidence: &str,
        corroboration: Option<u8>,
    ) {
        let method = if confidence == "strong" {
            "explicit-lineage"
        } else {
            "exact-first-turn-prefix"
        };
        connection
            .execute(
                "INSERT INTO sessions(
                   session_key,eligibility,session_scope,duplicate_group_key,
                   dedupe_corroboration_fingerprint,duplicate_method,duplicate_confidence
                 ) VALUES (?1,'eligible','main',?2,?3,?4,?5)",
                params_from_iter([
                    Value::Blob(vec![id; 32]),
                    Value::Blob(vec![group; 32]),
                    corroboration.map_or(Value::Null, |value| Value::Blob(vec![value; 32])),
                    Value::Text(method.to_owned()),
                    Value::Text(confidence.to_owned()),
                ]),
            )
            .unwrap();
    }

    #[test]
    fn dedupe_group_confidence_requires_lineage_or_shared_corroboration() {
        let connection = confidence_connection();
        insert_session(&connection, 1, 0x11, "weak", Some(0x31));
        insert_session(&connection, 2, 0x11, "weak", Some(0x31));
        insert_session(&connection, 3, 0x22, "weak", Some(0x41));
        insert_session(&connection, 4, 0x22, "weak", Some(0x42));
        insert_session(&connection, 5, 0x33, "strong", None);
        insert_session(&connection, 6, 0x44, "weak", Some(0x51));
        insert_session(&connection, 7, 0x44, "weak", Some(0x51));
        insert_session(&connection, 8, 0x44, "weak", Some(0x52));
        let groups = [0x11_u8, 0x22, 0x33, 0x44]
            .into_iter()
            .map(|value| hex::encode([value; 32]))
            .collect::<BTreeSet<_>>();

        let confidence = read_group_confidences(&connection, &groups).unwrap();
        assert_eq!(
            confidence[&hex::encode([0x11; 32])],
            DedupeConfidence::Strong
        );
        assert_eq!(confidence[&hex::encode([0x22; 32])], DedupeConfidence::Weak);
        assert_eq!(
            confidence[&hex::encode([0x33; 32])],
            DedupeConfidence::Strong
        );
        assert_eq!(confidence[&hex::encode([0x44; 32])], DedupeConfidence::Weak);
    }
}
