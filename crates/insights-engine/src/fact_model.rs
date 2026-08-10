use serde::{Deserialize, Deserializer, Serialize, Serializer};
use serde_json::Value;
use std::collections::{BTreeMap, HashSet};
use std::fmt;
use std::hash::Hash;
use std::str::FromStr;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct FactModelError {
    pub code: &'static str,
    pub message: String,
}

impl FactModelError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "TS_INSIGHTS_INVALID_DELTA",
            message: message.into(),
        }
    }
}

impl fmt::Display for FactModelError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for FactModelError {}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash)]
pub struct StableKey([u8; 32]);

impl StableKey {
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(bytes)
    }

    pub fn as_bytes(&self) -> &[u8; 32] {
        &self.0
    }

    pub fn to_hex(self) -> String {
        hex::encode(self.0)
    }
}

impl fmt::Debug for StableKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&hex::encode(self.0))
    }
}

impl fmt::Display for StableKey {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&hex::encode(self.0))
    }
}

impl FromStr for StableKey {
    type Err = FactModelError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.len() != 64
            || !value
                .bytes()
                .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
        {
            return Err(FactModelError::invalid(
                "stable keys must be lowercase 32-byte hex",
            ));
        }
        let decoded = hex::decode(value)
            .map_err(|_| FactModelError::invalid("stable key is not valid hex"))?;
        let bytes: [u8; 32] = decoded
            .try_into()
            .map_err(|_| FactModelError::invalid("stable key is not 32 bytes"))?;
        Ok(Self(bytes))
    }
}

impl Serialize for StableKey {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for StableKey {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Hash, Debug)]
pub struct WireU64(u64);

impl WireU64 {
    pub const ZERO: Self = Self(0);

    pub fn get(self) -> u64 {
        self.0
    }

    pub fn to_be_blob(self) -> [u8; 8] {
        self.0.to_be_bytes()
    }

    pub fn from_be_blob(value: &[u8]) -> Result<Self, FactModelError> {
        let bytes: [u8; 8] = value
            .try_into()
            .map_err(|_| FactModelError::invalid("wire u64 BLOB must contain 8 bytes"))?;
        Ok(Self(u64::from_be_bytes(bytes)))
    }
}

impl fmt::Display for WireU64 {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        self.0.fmt(formatter)
    }
}

impl FromStr for WireU64 {
    type Err = FactModelError;

    fn from_str(value: &str) -> Result<Self, Self::Err> {
        if value.is_empty()
            || (value.len() > 1 && value.starts_with('0'))
            || !value.bytes().all(|byte| byte.is_ascii_digit())
        {
            return Err(FactModelError::invalid(
                "wire u64 values must be canonical decimal strings",
            ));
        }
        value
            .parse::<u64>()
            .map(Self)
            .map_err(|_| FactModelError::invalid("wire u64 value exceeds uint64"))
    }
}

impl Serialize for WireU64 {
    fn serialize<S>(&self, serializer: S) -> Result<S::Ok, S::Error>
    where
        S: Serializer,
    {
        serializer.serialize_str(&self.to_string())
    }
}

impl<'de> Deserialize<'de> for WireU64 {
    fn deserialize<D>(deserializer: D) -> Result<Self, D::Error>
    where
        D: Deserializer<'de>,
    {
        String::deserialize(deserializer)?
            .parse()
            .map_err(serde::de::Error::custom)
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MutationMode {
    Append,
    ReplaceSession,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SessionScope {
    Main,
    Subagent,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Eligibility {
    Eligible,
    SubagentExcluded,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DuplicateMethod {
    ExplicitLineage,
    ExactFirstTurnPrefix,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DuplicateConfidence {
    Strong,
    Weak,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DedupeClosure {
    HardSealed,
    ObservedEof,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderVisibility {
    Active,
    RolledBack,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderTerminal {
    Completed,
    Aborted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum OriginScope {
    Main,
    Subagent,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum MessageRole {
    User,
    Assistant,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ResultProviderState {
    Pending,
    Completed,
    Failed,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityKind {
    Tool,
    Skill,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityTerminalState {
    Pending,
    Completed,
    Failed,
    Cancelled,
    Unknown,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum EvidenceStrength {
    Observed,
    Confirmed,
    Inferred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum SkillLoadStrength {
    Confirmed,
    Inferred,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum LifecycleState {
    Started,
    Completed,
    Aborted,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderStatusKind {
    ThreadRolledBack,
    InlineSubagentActivity,
    InterAgentCommunication,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ProviderStatusState {
    Observed,
    Invalid,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TurnEvidenceRole {
    Boundary,
    Lifecycle,
    Result,
    FollowUp,
    Rollback,
    Corroboration,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityUseEvidenceRole {
    Invocation,
    Result,
    Corroboration,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFact {
    pub session_key: StableKey,
    pub provider: String,
    pub session_scope: SessionScope,
    pub eligibility: Eligibility,
    #[serde(default)]
    pub project_key: Option<StableKey>,
    #[serde(default)]
    pub observed_start: Option<String>,
    #[serde(default)]
    pub observed_end: Option<String>,
    #[serde(default)]
    pub originator_version: Option<String>,
    #[serde(default)]
    pub duplicate_group_key: Option<StableKey>,
    #[serde(default)]
    pub dedupe_fingerprint: Option<StableKey>,
    #[serde(default)]
    pub dedupe_corroboration_fingerprint: Option<StableKey>,
    #[serde(default)]
    pub duplicate_method: Option<DuplicateMethod>,
    #[serde(default)]
    pub duplicate_confidence: Option<DuplicateConfidence>,
    #[serde(default)]
    pub dedupe_closure: Option<DedupeClosure>,
    #[serde(default)]
    pub dedupe_evidence_event_keys: Vec<StableKey>,
    pub duplicate_policy_version: u8,
    #[serde(default)]
    pub fact_truncation: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Retractions {
    pub turn_keys: Vec<StableKey>,
    pub orphan_event_keys: Vec<StableKey>,
    pub authoritative_turn_keys: Vec<StableKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RawClosure {
    pub next_user_boundary: bool,
    pub provider_terminal: Option<ProviderTerminal>,
    pub observed_eof_closed: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnFact {
    pub turn_key: StableKey,
    pub owner_session_key: StableKey,
    pub turn_start_offset: WireU64,
    pub problem_text: String,
    pub final_answer_excerpt: Option<String>,
    pub observed_timestamp: Option<String>,
    pub raw_closure: RawClosure,
    pub provider_visibility: ProviderVisibility,
    pub fact_truncation: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceRecordFact {
    pub source_record_key: StableKey,
    pub owner_session_key: StableKey,
    pub start_offset: WireU64,
    pub end_offset: WireU64,
    pub record_sha256: StableKey,
    pub provider_record_class: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceOrder {
    pub record_start_offset: WireU64,
    pub content_index: i32,
    pub event_ordinal: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidencePointer {
    pub pointer_kind: String,
    pub content_index: i32,
    pub event_ordinal: u16,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EventCommon {
    pub event_key: StableKey,
    pub owner_session_key: StableKey,
    pub occurred_turn_key: Option<StableKey>,
    pub source_record_key: StableKey,
    pub source_order: SourceOrder,
    pub pointer: EvidencePointer,
    pub origin_scope: OriginScope,
    pub observed_timestamp: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct VisibleMessageEvent {
    #[serde(flatten)]
    pub common: EventCommon,
    pub role: MessageRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityInvocationEvent {
    #[serde(flatten)]
    pub common: EventCommon,
    pub capability_key: StableKey,
    #[serde(default)]
    pub correlation_digest: Option<StableKey>,
    #[serde(default)]
    pub input_fingerprint: Option<StableKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityResultEvent {
    #[serde(flatten)]
    pub common: EventCommon,
    #[serde(default)]
    pub correlation_digest: Option<StableKey>,
    pub provider_state: ResultProviderState,
    #[serde(default)]
    pub exit_code: Option<WireU64>,
    #[serde(default)]
    pub output_bytes: Option<WireU64>,
    #[serde(default)]
    pub duration_ms: Option<WireU64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillCatalogEntryEvent {
    #[serde(flatten)]
    pub common: EventCommon,
    pub capability_key: StableKey,
    pub path_fingerprint: StableKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SkillLoadEvent {
    #[serde(flatten)]
    pub common: EventCommon,
    pub capability_key: StableKey,
    pub strength: SkillLoadStrength,
    pub evidence_source: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnLifecycleEvent {
    #[serde(flatten)]
    pub common: EventCommon,
    pub lifecycle_state: LifecycleState,
    #[serde(default)]
    pub provider_turn_digest: Option<StableKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ProviderStatusEvent {
    #[serde(flatten)]
    pub common: EventCommon,
    pub status_kind: ProviderStatusKind,
    pub provider_state: ProviderStatusState,
    #[serde(default)]
    pub rolled_back_turn_count: Option<WireU64>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case")]
pub enum EvidenceEvent {
    VisibleMessage(VisibleMessageEvent),
    CapabilityInvocation(CapabilityInvocationEvent),
    CapabilityResult(CapabilityResultEvent),
    SkillCatalogEntry(SkillCatalogEntryEvent),
    SkillLoad(SkillLoadEvent),
    TurnLifecycle(TurnLifecycleEvent),
    ProviderStatus(ProviderStatusEvent),
}

impl EvidenceEvent {
    pub fn common(&self) -> &EventCommon {
        match self {
            Self::VisibleMessage(value) => &value.common,
            Self::CapabilityInvocation(value) => &value.common,
            Self::CapabilityResult(value) => &value.common,
            Self::SkillCatalogEntry(value) => &value.common,
            Self::SkillLoad(value) => &value.common,
            Self::TurnLifecycle(value) => &value.common,
            Self::ProviderStatus(value) => &value.common,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnEvidenceFact {
    pub owner_session_key: StableKey,
    pub turn_key: StableKey,
    pub event_key: StableKey,
    pub role: TurnEvidenceRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityFact {
    pub capability_key: StableKey,
    pub provider: String,
    pub kind: CapabilityKind,
    pub canonical_name: String,
    pub identity_version: u8,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityUseFact {
    pub use_key: StableKey,
    pub owner_session_key: StableKey,
    pub turn_key: StableKey,
    pub capability_key: StableKey,
    pub turn_ordinal: u64,
    pub exact_observed_name: String,
    pub origin_scope: OriginScope,
    #[serde(default)]
    pub origin_fingerprint: Option<StableKey>,
    #[serde(default)]
    pub input_fingerprint: Option<StableKey>,
    pub provider_terminal_state: CapabilityTerminalState,
    pub strength: EvidenceStrength,
    #[serde(default)]
    pub correlation_digest: Option<StableKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityUseEvidenceFact {
    pub owner_session_key: StableKey,
    pub use_key: StableKey,
    pub event_key: StableKey,
    pub role: CapabilityUseEvidenceRole,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingStarted {
    pub event_key: StableKey,
    pub record_start_offset: WireU64,
    pub provider_turn_digest: Option<StableKey>,
    pub turn_key: Option<StableKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingUse {
    pub correlation_digest: StableKey,
    pub use_key: Option<StableKey>,
    pub capability_key: Option<StableKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingDedupe {
    pub dedupe_fingerprint: StableKey,
    pub duplicate_method: DuplicateMethod,
    pub duplicate_confidence: DuplicateConfidence,
    pub dedupe_closure: DedupeClosure,
    pub dedupe_evidence_event_keys: Vec<StableKey>,
    #[serde(default)]
    pub dedupe_corroboration_fingerprint: Option<StableKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingSessionState {
    pub session_key: StableKey,
    pub session_scope: SessionScope,
    pub eligibility: Eligibility,
    pub originator_version: Option<String>,
    pub project_key: Option<StableKey>,
    pub observed_start: Option<String>,
    pub observed_end: Option<String>,
    pub first_turn_key: Option<StableKey>,
    pub second_turn_key: Option<StableKey>,
    pub fact_truncation: Vec<String>,
    pub dedupe: Option<PendingDedupe>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CatalogEntry {
    pub path_fingerprint: StableKey,
    pub capability_key: StableKey,
    pub canonical_name: String,
    pub event_key: StableKey,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SeenClaudeUuid {
    pub digest: StableKey,
    pub record_start_offset: WireU64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PendingState {
    pub current_turn_key: Option<StableKey>,
    pub replay_from_offset: Option<WireU64>,
    pub pending_started: Vec<PendingStarted>,
    pub pending_uses: Vec<PendingUse>,
    pub session_state: PendingSessionState,
    pub catalog_entries: Vec<CatalogEntry>,
    pub seen_claude_uuids: Vec<SeenClaudeUuid>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct Checkpoint {
    pub complete_offset: WireU64,
    pub eof_observed: bool,
    pub partial_tail_length: WireU64,
    pub partial_tail_digest: StableKey,
    pub source_size: WireU64,
    pub source_mtime_ns: WireU64,
    pub source_snapshot_stable: bool,
    pub origin_secret_epoch: String,
    pub generation: WireU64,
    pub pending_state: PendingState,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiagnosticFact {
    pub code: String,
    pub count: u64,
    #[serde(default)]
    pub first_offset: Option<WireU64>,
    #[serde(default)]
    pub digest: Option<StableKey>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionFactsDeltaV1 {
    pub format: String,
    pub fact_schema_version: u8,
    pub provider_adapter_version: String,
    pub privacy_policy_version: u8,
    pub origin_secret_epoch: String,
    pub duplicate_policy_version: u8,
    pub expected_generation: WireU64,
    pub target_generation: WireU64,
    pub mode: MutationMode,
    pub delta_id: StableKey,
    pub session: SessionFact,
    pub retractions: Retractions,
    pub turns: Vec<TurnFact>,
    pub source_records: Vec<SourceRecordFact>,
    pub evidence_events: Vec<EvidenceEvent>,
    pub turn_evidence: Vec<TurnEvidenceFact>,
    pub capabilities: Vec<CapabilityFact>,
    pub capability_uses: Vec<CapabilityUseFact>,
    pub capability_use_evidence: Vec<CapabilityUseEvidenceFact>,
    pub checkpoint: Checkpoint,
    pub diagnostics: Vec<DiagnosticFact>,
    pub coverage: BTreeMap<String, u64>,
}

impl SessionFactsDeltaV1 {
    pub fn validate(&self) -> Result<(), FactModelError> {
        if self.format != "session-facts-delta@v1"
            || self.fact_schema_version != 1
            || self.privacy_policy_version != 1
            || self.duplicate_policy_version != 1
            || self.session.duplicate_policy_version != 1
        {
            return Err(FactModelError::invalid(
                "unsupported SessionFactsDeltaV1 contract version",
            ));
        }
        if self.provider_adapter_version.is_empty()
            || self.session.provider.is_empty()
            || !valid_uuid(&self.origin_secret_epoch)
            || !valid_uuid(&self.checkpoint.origin_secret_epoch)
        {
            return Err(FactModelError::invalid(
                "delta contains an invalid provider or origin secret epoch",
            ));
        }
        if self.origin_secret_epoch != self.checkpoint.origin_secret_epoch {
            return Err(FactModelError::invalid(
                "checkpoint originSecretEpoch does not match the delta",
            ));
        }
        if self.session.duplicate_group_key.is_some() {
            return Err(FactModelError::invalid(
                "incoming session.duplicateGroupKey must be null; the Engine derives it",
            ));
        }
        if self.expected_generation.get().checked_add(1) != Some(self.target_generation.get())
            || self.checkpoint.generation != self.target_generation
        {
            return Err(FactModelError::invalid(
                "targetGeneration and checkpoint generation must immediately follow expectedGeneration",
            ));
        }
        if self.session.session_key != self.checkpoint.pending_state.session_state.session_key {
            return Err(FactModelError::invalid(
                "checkpoint sessionState belongs to another session",
            ));
        }
        if self.turns.iter().any(|turn| {
            turn.owner_session_key != self.session.session_key
                || turn.problem_text.len() > 64 * 1_024
                || turn
                    .final_answer_excerpt
                    .as_ref()
                    .is_some_and(|value| value.len() > 8 * 1_024)
                || turn.provider_visibility == ProviderVisibility::RolledBack
        }) || self
            .source_records
            .iter()
            .any(|record| record.owner_session_key != self.session.session_key)
            || self.evidence_events.iter().any(|event| {
                event.common().owner_session_key != self.session.session_key
                    || event.common().source_order.content_index < -1
                    || event.common().pointer.content_index < -1
            })
            || self.turn_evidence.iter().any(|link| {
                link.owner_session_key != self.session.session_key
                    || link.role == TurnEvidenceRole::Rollback
            })
            || self
                .capability_uses
                .iter()
                .any(|usage| usage.owner_session_key != self.session.session_key)
            || self
                .capability_use_evidence
                .iter()
                .any(|link| link.owner_session_key != self.session.session_key)
        {
            return Err(FactModelError::invalid(
                "delta contains a fact owned by another session or exceeds a fact bound",
            ));
        }
        if self.capabilities.iter().any(|capability| {
            capability.identity_version != 1
                || capability.canonical_name.is_empty()
                || capability.canonical_name.len() > 512
                || capability.provider != self.session.provider
        }) {
            return Err(FactModelError::invalid(
                "delta contains an invalid capability identity",
            ));
        }
        if self.evidence_events.iter().any(|event| {
            let common = event.common();
            common.source_order.content_index != common.pointer.content_index
                || common.source_order.event_ordinal != common.pointer.event_ordinal
                || matches!(
                    event,
                    EvidenceEvent::ProviderStatus(ProviderStatusEvent {
                        common: EventCommon {
                            occurred_turn_key: Some(_),
                            ..
                        },
                        status_kind: ProviderStatusKind::ThreadRolledBack,
                        ..
                    })
                )
        }) {
            return Err(FactModelError::invalid(
                "delta contains an invalid evidence pointer or rollback authority",
            ));
        }
        if !all_unique(self.retractions.turn_keys.iter().copied())
            || !all_unique(self.retractions.orphan_event_keys.iter().copied())
            || !all_unique(self.retractions.authoritative_turn_keys.iter().copied())
            || !all_unique(self.turns.iter().map(|turn| turn.turn_key))
            || !all_unique(
                self.source_records
                    .iter()
                    .map(|record| record.source_record_key),
            )
            || !all_unique(
                self.evidence_events
                    .iter()
                    .map(|event| event.common().event_key),
            )
            || !all_unique(
                self.turn_evidence
                    .iter()
                    .map(|link| (link.turn_key, link.event_key, link.role)),
            )
            || !all_unique(
                self.capabilities
                    .iter()
                    .map(|capability| capability.capability_key),
            )
            || !all_unique(self.capability_uses.iter().map(|usage| usage.use_key))
            || !all_unique(
                self.capability_use_evidence
                    .iter()
                    .map(|link| (link.use_key, link.event_key, link.role)),
            )
            || !all_unique(
                self.diagnostics
                    .iter()
                    .map(|diagnostic| diagnostic.code.as_str()),
            )
        {
            return Err(FactModelError::invalid(
                "delta contains duplicate fact or retraction identities",
            ));
        }
        Ok(())
    }
}

fn all_unique<T>(values: impl IntoIterator<Item = T>) -> bool
where
    T: Eq + Hash,
{
    let mut seen = HashSet::new();
    values.into_iter().all(|value| seen.insert(value))
}

impl TryFrom<Value> for SessionFactsDeltaV1 {
    type Error = FactModelError;

    fn try_from(value: Value) -> Result<Self, Self::Error> {
        let delta: Self = serde_json::from_value(value)
            .map_err(|error| FactModelError::invalid(format!("invalid fact delta: {error}")))?;
        delta.validate()?;
        Ok(delta)
    }
}

fn valid_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && [8, 13, 18, 23].iter().all(|index| bytes[*index] == b'-')
        && bytes
            .iter()
            .enumerate()
            .all(|(index, byte)| [8, 13, 18, 23].contains(&index) || byte.is_ascii_hexdigit())
}

#[cfg(test)]
mod tests {
    use super::{SessionFactsDeltaV1, StableKey, WireU64};
    use serde_json::Value;

    fn fixture() -> Value {
        serde_json::from_str(include_str!(
            "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
        ))
        .unwrap()
    }

    #[test]
    fn decodes_the_closed_wire_contract_and_uint64_max() {
        let delta = SessionFactsDeltaV1::try_from(fixture()["initial"].clone()).unwrap();
        assert_eq!(delta.turns[0].turn_start_offset.get(), u64::MAX);
        assert_eq!(delta.turns[0].turn_start_offset.to_be_blob(), [0xff; 8]);
    }

    #[test]
    fn rejects_unknown_fields_and_noncanonical_scalars() {
        let mut unknown = fixture()["initial"].clone();
        unknown["future"] = Value::Bool(true);
        assert!(SessionFactsDeltaV1::try_from(unknown).is_err());
        assert!("A".repeat(64).parse::<StableKey>().is_err());
        assert!("01".parse::<WireU64>().is_err());
        assert!("18446744073709551616".parse::<WireU64>().is_err());
    }

    #[test]
    fn rejects_adapter_authority_violations_and_duplicate_keys() {
        let mut rolled_back = fixture()["initial"].clone();
        rolled_back["turns"][0]["providerVisibility"] = Value::String("rolled-back".into());
        assert!(SessionFactsDeltaV1::try_from(rolled_back).is_err());

        let mut rollback_link = fixture()["initial"].clone();
        rollback_link["turnEvidence"][0]["role"] = Value::String("rollback".into());
        assert!(SessionFactsDeltaV1::try_from(rollback_link).is_err());

        let mut foreign_capability = fixture()["initial"].clone();
        foreign_capability["capabilities"][0]["provider"] = Value::String("claude".into());
        assert!(SessionFactsDeltaV1::try_from(foreign_capability).is_err());

        let mut duplicate_turn = fixture()["initial"].clone();
        let turn = duplicate_turn["turns"][0].clone();
        duplicate_turn["turns"].as_array_mut().unwrap().push(turn);
        assert!(SessionFactsDeltaV1::try_from(duplicate_turn).is_err());
    }

    #[test]
    fn enforces_utf8_byte_bounds_and_pointer_identity() {
        let mut oversized_problem = fixture()["initial"].clone();
        oversized_problem["turns"][0]["problemText"] = Value::String("界".repeat(21_846));
        assert!(SessionFactsDeltaV1::try_from(oversized_problem).is_err());

        let mut pointer_mismatch = fixture()["initial"].clone();
        pointer_mismatch["evidenceEvents"][0]["pointer"]["eventOrdinal"] = Value::from(1);
        assert!(SessionFactsDeltaV1::try_from(pointer_mismatch).is_err());
    }
}
