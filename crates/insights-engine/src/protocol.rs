use crate::try_canonical_json;
use serde_json::{Map, Value, json};
use std::collections::BTreeSet;
use std::fmt;
use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u64 = 1;
pub const MAX_FRAME_BYTES: usize = 4_194_304;
pub const PROTOCOL_FORMAT: &str = "threadshare-insights-protocol@v1";

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_ENGINE_STATUS_PROJECTIONS: usize = 1_024;
const MAX_QUERY_WIRE_BYTES: usize = MAX_FRAME_BYTES;
const MAX_SEARCH_RESULTS: u64 = 200;
const MAX_SEARCH_CANDIDATES: usize = 300;
const MAX_PATH_FAMILIES: u64 = 20;
const MAX_PATH_NODES: usize = 128;
const MAX_SCORING_TERMS: usize = 32;
const MAX_FILTER_KEYS: usize = 64;
const MAX_FILTER_PROVIDERS: usize = 16;
const MAX_SEARCH_EXCERPT_BYTES: usize = 512;
const MAX_TURN_PROBLEM_BYTES: usize = 64 * 1_024;
const MAX_TURN_ANSWER_BYTES: usize = 8 * 1_024;
const MAX_EVIDENCE_PAGE_ENTRIES: u64 = 128;
const MAX_CURSOR_BYTES: usize = 256;
const MAX_PPM: u64 = 1_000_000;
const WAL_PASSIVE_CHECKPOINT_BYTES: u64 = 64 * 1_024 * 1_024;
const WAL_BACKPRESSURE_BYTES: u64 = 128 * 1_024 * 1_024;
const COMMON_FIELDS: [&str; 3] = ["format", "type", "requestId"];
const HANDSHAKE_CONTRACT_FIELDS: [&str; 10] = [
    "factSchemaVersion",
    "providerAdapterVersions",
    "privacyPolicyVersion",
    "originSecretEpoch",
    "duplicatePolicyVersion",
    "factStorageProfile",
    "storageSchemaVersion",
    "projectionVersions",
    "analyzerCapabilities",
    "rankerVersion",
];
const SESSION_CONTRACT_FIELDS: [&str; 10] = [
    "factSchemaVersion",
    "providerAdapterVersion",
    "privacyPolicyVersion",
    "originSecretEpoch",
    "duplicatePolicyVersion",
    "factStorageProfile",
    "storageSchemaVersion",
    "projectionVersions",
    "analyzerCapabilities",
    "rankerVersion",
];
const V1_COUNT_FIELDS: [&str; 10] = [
    "turnKeys",
    "orphanEventKeys",
    "authoritativeTurnKeys",
    "turns",
    "sourceRecords",
    "evidenceEvents",
    "turnEvidence",
    "capabilities",
    "capabilityUses",
    "capabilityUseEvidence",
];
const V2_COUNT_FIELDS: [&str; 13] = [
    "turnKeys",
    "orphanEventKeys",
    "authoritativeTurnKeys",
    "turns",
    "sourceRecords",
    "evidenceEvents",
    "turnEvidence",
    "capabilities",
    "capabilityUses",
    "capabilityUseEvidence",
    "historyEvents",
    "historyPayloads",
    "historyPayloadChunks",
];
pub const RETRACTION_COLLECTIONS: [&str; 3] =
    ["turnKeys", "orphanEventKeys", "authoritativeTurnKeys"];
pub const V1_UPSERT_COLLECTIONS: [&str; 7] = [
    "turns",
    "sourceRecords",
    "evidenceEvents",
    "turnEvidence",
    "capabilities",
    "capabilityUses",
    "capabilityUseEvidence",
];
pub const V2_UPSERT_COLLECTIONS: [&str; 10] = [
    "turns",
    "sourceRecords",
    "evidenceEvents",
    "turnEvidence",
    "capabilities",
    "capabilityUses",
    "capabilityUseEvidence",
    "historyEvents",
    "historyPayloads",
    "historyPayloadChunks",
];

pub fn upsert_collections_for_delta_format(delta_format: &str) -> Option<&'static [&'static str]> {
    match delta_format {
        "session-facts-delta@v1" => Some(&V1_UPSERT_COLLECTIONS),
        "session-facts-delta@v2" => Some(&V2_UPSERT_COLLECTIONS),
        _ => None,
    }
}

pub fn is_upsert_collection(collection: &str) -> bool {
    V2_UPSERT_COLLECTIONS.contains(&collection)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum MessageKind {
    Hello,
    Ready,
    BeginSession,
    SessionAccepted,
    RetractFacts,
    UpsertFacts,
    BatchAccepted,
    CommitSession,
    SessionCommitted,
    BeginTraceSource,
    TraceSourceAccepted,
    TraceSourceBatch,
    TraceSourceBatchAccepted,
    CommitTraceSource,
    TraceSourceCommitted,
    ReadRepositoryState,
    RepositoryState,
    ListSourceStates,
    SourceStates,
    ReadSourceCheckpoint,
    SourceCheckpoint,
    RemoveSource,
    SourceRemoved,
    ExcludeSource,
    SourceExcluded,
    ReadPurgeStatus,
    PurgeStatus,
    RunPurgeMaintenance,
    PurgeMaintenanceStatus,
    ReadEngineStatus,
    EngineStatus,
    ReadInsightsOverview,
    InsightsOverview,
    ListCapabilities,
    CapabilityPage,
    SearchTurns,
    TurnSearchResults,
    ReadCapabilityUsage,
    CapabilityUsage,
    ReadInsightsActivity,
    InsightsActivity,
    ReadTurnEvidence,
    TurnEvidencePage,
    ReadInsightsQueryV2,
    InsightsQueryV2,
    ReadInsightsEvidenceV2,
    InsightsEvidenceV2,
    ReadInsightsRecipe,
    InsightsRecipe,
    ReadInsightsDeliveryTrace,
    InsightsDeliveryTrace,
    MemoryCommand,
    MemoryResult,
    AbortSession,
    SessionAborted,
    AbortTraceSource,
    TraceSourceAborted,
    Error,
}

impl MessageKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Hello => "HELLO",
            Self::Ready => "READY",
            Self::BeginSession => "BEGIN_SESSION",
            Self::SessionAccepted => "SESSION_ACCEPTED",
            Self::RetractFacts => "RETRACT_FACTS",
            Self::UpsertFacts => "UPSERT_FACTS",
            Self::BatchAccepted => "BATCH_ACCEPTED",
            Self::CommitSession => "COMMIT_SESSION",
            Self::SessionCommitted => "SESSION_COMMITTED",
            Self::BeginTraceSource => "BEGIN_TRACE_SOURCE",
            Self::TraceSourceAccepted => "TRACE_SOURCE_ACCEPTED",
            Self::TraceSourceBatch => "TRACE_SOURCE_BATCH",
            Self::TraceSourceBatchAccepted => "TRACE_SOURCE_BATCH_ACCEPTED",
            Self::CommitTraceSource => "COMMIT_TRACE_SOURCE",
            Self::TraceSourceCommitted => "TRACE_SOURCE_COMMITTED",
            Self::ReadRepositoryState => "READ_REPOSITORY_STATE",
            Self::RepositoryState => "REPOSITORY_STATE",
            Self::ListSourceStates => "LIST_SOURCE_STATES",
            Self::SourceStates => "SOURCE_STATES",
            Self::ReadSourceCheckpoint => "READ_SOURCE_CHECKPOINT",
            Self::SourceCheckpoint => "SOURCE_CHECKPOINT",
            Self::RemoveSource => "REMOVE_SOURCE",
            Self::SourceRemoved => "SOURCE_REMOVED",
            Self::ExcludeSource => "EXCLUDE_SOURCE",
            Self::SourceExcluded => "SOURCE_EXCLUDED",
            Self::ReadPurgeStatus => "READ_PURGE_STATUS",
            Self::PurgeStatus => "PURGE_STATUS",
            Self::RunPurgeMaintenance => "RUN_PURGE_MAINTENANCE",
            Self::PurgeMaintenanceStatus => "PURGE_MAINTENANCE_STATUS",
            Self::ReadEngineStatus => "READ_ENGINE_STATUS",
            Self::EngineStatus => "ENGINE_STATUS",
            Self::ReadInsightsOverview => "READ_INSIGHTS_OVERVIEW",
            Self::InsightsOverview => "INSIGHTS_OVERVIEW",
            Self::ListCapabilities => "LIST_CAPABILITIES",
            Self::CapabilityPage => "CAPABILITY_PAGE",
            Self::SearchTurns => "SEARCH_TURNS",
            Self::TurnSearchResults => "TURN_SEARCH_RESULTS",
            Self::ReadCapabilityUsage => "READ_CAPABILITY_USAGE",
            Self::CapabilityUsage => "CAPABILITY_USAGE",
            Self::ReadInsightsActivity => "READ_INSIGHTS_ACTIVITY",
            Self::InsightsActivity => "INSIGHTS_ACTIVITY",
            Self::ReadTurnEvidence => "READ_TURN_EVIDENCE",
            Self::TurnEvidencePage => "TURN_EVIDENCE_PAGE",
            Self::ReadInsightsQueryV2 => "READ_INSIGHTS_QUERY_V2",
            Self::InsightsQueryV2 => "INSIGHTS_QUERY_V2",
            Self::ReadInsightsEvidenceV2 => "READ_INSIGHTS_EVIDENCE_V2",
            Self::InsightsEvidenceV2 => "INSIGHTS_EVIDENCE_V2",
            Self::ReadInsightsRecipe => "READ_INSIGHTS_RECIPE",
            Self::InsightsRecipe => "INSIGHTS_RECIPE",
            Self::ReadInsightsDeliveryTrace => "READ_INSIGHTS_DELIVERY_TRACE",
            Self::InsightsDeliveryTrace => "INSIGHTS_DELIVERY_TRACE",
            Self::MemoryCommand => "MEMORY_COMMAND",
            Self::MemoryResult => "MEMORY_RESULT",
            Self::AbortSession => "ABORT_SESSION",
            Self::SessionAborted => "SESSION_ABORTED",
            Self::AbortTraceSource => "ABORT_TRACE_SOURCE",
            Self::TraceSourceAborted => "TRACE_SOURCE_ABORTED",
            Self::Error => "ERROR",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct ProtocolError {
    pub code: &'static str,
    pub message: String,
    pub fatal: bool,
}

impl ProtocolError {
    pub fn new(code: &'static str, message: impl Into<String>, fatal: bool) -> Self {
        Self {
            code,
            message: message.into(),
            fatal,
        }
    }

    pub fn response(&self, request_id: &str) -> Value {
        json!({
            "format": PROTOCOL_FORMAT,
            "type": "ERROR",
            "requestId": request_id,
            "code": self.code,
            "category": if self.code.contains("UNSUPPORTED") { "compatibility" } else { "protocol" },
            "message": bounded_message(&self.message),
            "retryable": false,
            "fatal": self.fatal,
        })
    }
}

impl fmt::Display for ProtocolError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for ProtocolError {}

fn invalid_frame(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new("TS_INSIGHTS_PROTOCOL_INVALID_FRAME", message, false)
}

fn unsupported_contract(message: impl Into<String>) -> ProtocolError {
    ProtocolError::new("TS_INSIGHTS_PROTOCOL_CONTRACT_UNSUPPORTED", message, false)
}

pub fn bounded_message(message: &str) -> String {
    let mut output = String::new();
    for character in message.chars() {
        let safe = if character.is_control() {
            ' '
        } else {
            character
        };
        if output.len() + safe.len_utf8() > 1_024 {
            break;
        }
        output.push(safe);
    }
    output
}

fn object<'a>(value: &'a Value, label: &str) -> Result<&'a Map<String, Value>, ProtocolError> {
    value
        .as_object()
        .ok_or_else(|| invalid_frame(format!("{label} must be an object")))
}

fn exact_keys(value: &Value, label: &str, message_fields: &[&str]) -> Result<(), ProtocolError> {
    let object = object(value, label)?;
    let required = COMMON_FIELDS
        .iter()
        .copied()
        .chain(message_fields.iter().copied())
        .collect::<Vec<_>>();
    for key in object.keys() {
        if !required.contains(&key.as_str()) {
            return Err(invalid_frame(format!(
                "{label} contains unknown field {key}"
            )));
        }
    }
    for key in required {
        if !object.contains_key(key) {
            return Err(invalid_frame(format!("{label} is missing field {key}")));
        }
    }
    Ok(())
}

fn exact_object_keys(value: &Value, label: &str, required: &[&str]) -> Result<(), ProtocolError> {
    let object = object(value, label)?;
    for key in object.keys() {
        if !required.contains(&key.as_str()) {
            return Err(invalid_frame(format!(
                "{label} contains unknown field {key}"
            )));
        }
    }
    for key in required {
        if !object.contains_key(*key) {
            return Err(invalid_frame(format!("{label} is missing field {key}")));
        }
    }
    Ok(())
}

fn bounded_string<'a>(
    value: &'a Value,
    label: &str,
    max_bytes: usize,
    allow_empty: bool,
    printable_ascii: bool,
) -> Result<&'a str, ProtocolError> {
    let text = value
        .as_str()
        .filter(|text| allow_empty || !text.is_empty())
        .ok_or_else(|| invalid_frame(format!("{label} must be a string")))?;
    if text.len() > max_bytes {
        return Err(invalid_frame(format!("{label} exceeds its bounded limit")));
    }
    if printable_ascii && !text.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
        return Err(invalid_frame(format!(
            "{label} must contain printable ASCII"
        )));
    }
    Ok(text)
}

fn safe_integer_range(
    value: &Value,
    label: &str,
    minimum: u64,
    maximum: u64,
) -> Result<u64, ProtocolError> {
    value
        .as_u64()
        .filter(|number| *number >= minimum && *number <= maximum.min(MAX_SAFE_INTEGER))
        .ok_or_else(|| invalid_frame(format!("{label} is outside its bounded range")))
}

fn boolean(value: &Value, label: &str) -> Result<bool, ProtocolError> {
    value
        .as_bool()
        .ok_or_else(|| invalid_frame(format!("{label} must be boolean")))
}

fn enum_string<'a>(
    value: &'a Value,
    label: &str,
    allowed: &[&str],
) -> Result<&'a str, ProtocolError> {
    let text = value
        .as_str()
        .ok_or_else(|| invalid_frame(format!("{label} is invalid")))?;
    if !allowed.contains(&text) {
        return Err(invalid_frame(format!("{label} is invalid")));
    }
    Ok(text)
}

fn nullable_hex64(value: &Value, label: &str) -> Result<(), ProtocolError> {
    if !value.is_null() {
        hex64(value, label)?;
    }
    Ok(())
}

fn nullable_timestamp(value: &Value, label: &str) -> Result<(), ProtocolError> {
    if !value.is_null() {
        bounded_string(value, label, 32, false, true)?;
    }
    Ok(())
}

fn sorted_bounded_strings<'a>(
    value: &'a Value,
    label: &str,
    maximum: usize,
    max_bytes: usize,
    printable_ascii: bool,
) -> Result<Vec<&'a str>, ProtocolError> {
    let values = value
        .as_array()
        .filter(|values| values.len() <= maximum)
        .ok_or_else(|| invalid_frame(format!("{label} exceeds its bounded limit")))?;
    let mut result = Vec::with_capacity(values.len());
    for (index, item) in values.iter().enumerate() {
        let text = bounded_string(
            item,
            &format!("{label}[{index}]"),
            max_bytes,
            false,
            printable_ascii,
        )?;
        if result.last().is_some_and(|previous| previous >= &text) {
            return Err(invalid_frame(format!(
                "{label} must be sorted and contain unique values"
            )));
        }
        result.push(text);
    }
    Ok(result)
}

fn field<'a>(value: &'a Value, field_name: &str, label: &str) -> Result<&'a Value, ProtocolError> {
    object(value, label)?
        .get(field_name)
        .ok_or_else(|| invalid_frame(format!("{label} is missing field {field_name}")))
}

fn non_empty_string<'a>(value: &'a Value, label: &str) -> Result<&'a str, ProtocolError> {
    value
        .as_str()
        .filter(|text| !text.is_empty())
        .ok_or_else(|| invalid_frame(format!("{label} must be non-empty")))
}

fn ascii_name<'a>(value: &'a Value, label: &str) -> Result<&'a str, ProtocolError> {
    let value = non_empty_string(value, label)?;
    if !value.bytes().all(|byte| (0x21..=0x7e).contains(&byte)) {
        return Err(invalid_frame(format!(
            "{label} must contain printable ASCII"
        )));
    }
    Ok(value)
}

fn positive_safe_integer(value: &Value, label: &str) -> Result<u64, ProtocolError> {
    value
        .as_u64()
        .filter(|number| *number >= 1 && *number <= MAX_SAFE_INTEGER)
        .ok_or_else(|| invalid_frame(format!("{label} must be a positive safe integer")))
}

fn hex64<'a>(value: &'a Value, label: &str) -> Result<&'a str, ProtocolError> {
    let value = value
        .as_str()
        .ok_or_else(|| invalid_frame(format!("{label} must be 32 lowercase hexadecimal bytes")))?;
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid_frame(format!(
            "{label} must be 32 lowercase hexadecimal bytes"
        )));
    }
    Ok(value)
}

fn hex40_or_64<'a>(value: &'a Value, label: &str) -> Result<&'a str, ProtocolError> {
    let value = value
        .as_str()
        .ok_or_else(|| invalid_frame(format!("{label} must be lowercase hexadecimal")))?;
    if !matches!(value.len(), 40 | 64)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return Err(invalid_frame(format!(
            "{label} must be 40 or 64 lowercase hexadecimal characters"
        )));
    }
    Ok(value)
}

fn purge_state<'a>(value: &'a Value, label: &str) -> Result<&'a str, ProtocolError> {
    let value = value
        .as_str()
        .ok_or_else(|| invalid_frame(format!("{label} is invalid")))?;
    if !matches!(value, "idle" | "pending-purge" | "purged") {
        return Err(invalid_frame(format!("{label} is invalid")));
    }
    Ok(value)
}

fn purge_status_fields(message: &Value, kind: MessageKind) -> Result<(), ProtocolError> {
    purge_state(field(message, "state", kind.as_str())?, "purge state")?;
    for name in ["pendingFacts", "pendingMaintenance", "purged"] {
        decimal_u64(field(message, name, kind.as_str())?, name)?;
    }
    Ok(())
}

fn engine_status_projection(value: &Value, label: &str) -> Result<(String, u64), ProtocolError> {
    exact_object_keys(
        value,
        label,
        &[
            "name",
            "version",
            "inputFactSchemaVersion",
            "rootKind",
            "baseSnapshotSeq",
            "watermark",
            "status",
            "errorDigest",
        ],
    )?;
    let name = ascii_name(field(value, "name", label)?, &format!("{label}.name"))?;
    if name.len() > 128 {
        return Err(invalid_frame(format!("{label}.name exceeds 128 bytes")));
    }
    let version =
        positive_safe_integer(field(value, "version", label)?, &format!("{label}.version"))?;
    positive_safe_integer(
        field(value, "inputFactSchemaVersion", label)?,
        &format!("{label}.inputFactSchemaVersion"),
    )?;
    if !matches!(
        field(value, "rootKind", label)?.as_str(),
        Some("session" | "turn" | "capability")
    ) {
        return Err(invalid_frame(format!("{label}.rootKind is invalid")));
    }
    let (_, base_snapshot_seq) = decimal_u64(
        field(value, "baseSnapshotSeq", label)?,
        &format!("{label}.baseSnapshotSeq"),
    )?;
    let (_, watermark) = decimal_u64(
        field(value, "watermark", label)?,
        &format!("{label}.watermark"),
    )?;
    if watermark < base_snapshot_seq {
        return Err(invalid_frame(format!(
            "{label}.watermark precedes baseSnapshotSeq"
        )));
    }
    let status = field(value, "status", label)?
        .as_str()
        .ok_or_else(|| invalid_frame(format!("{label}.status is invalid")))?;
    if !matches!(status, "active" | "building" | "failed") {
        return Err(invalid_frame(format!("{label}.status is invalid")));
    }
    let error_digest = field(value, "errorDigest", label)?;
    if status == "failed" {
        hex64(error_digest, &format!("{label}.errorDigest"))?;
    } else if !error_digest.is_null() {
        return Err(invalid_frame(format!(
            "{label}.errorDigest is only valid for failed projections"
        )));
    }
    Ok((name.to_owned(), version))
}

fn validate_engine_status(message: &Value, kind: MessageKind) -> Result<(), ProtocolError> {
    validate_envelope(
        message,
        kind,
        &[
            "snapshotSeq",
            "snapshotAgeMs",
            "snapshotPending",
            "factStorageProfile",
            "projections",
            "changeLog",
            "purge",
            "storage",
            "integrity",
        ],
    )?;
    let (_, snapshot_seq) = decimal_u64(
        field(message, "snapshotSeq", kind.as_str())?,
        "ENGINE_STATUS.snapshotSeq",
    )?;
    let snapshot_pending = field(message, "snapshotPending", kind.as_str())?
        .as_bool()
        .ok_or_else(|| invalid_frame("ENGINE_STATUS.snapshotPending must be boolean"))?;
    if snapshot_pending != (snapshot_seq == 0) {
        return Err(invalid_frame(
            "ENGINE_STATUS snapshot pending state is inconsistent",
        ));
    }
    let snapshot_age = field(message, "snapshotAgeMs", kind.as_str())?;
    if snapshot_pending {
        if !snapshot_age.is_null() {
            return Err(invalid_frame(
                "ENGINE_STATUS.snapshotAgeMs must be null while pending",
            ));
        }
    } else {
        decimal_u64(snapshot_age, "ENGINE_STATUS.snapshotAgeMs")?;
    }
    if !matches!(
        field(message, "factStorageProfile", kind.as_str())?.as_str(),
        Some("normalized-row-v1" | "normalized-row-v2" | "packed-facts-v1")
    ) {
        return Err(invalid_frame("ENGINE_STATUS.factStorageProfile is invalid"));
    }

    let projections = field(message, "projections", kind.as_str())?
        .as_array()
        .filter(|values| values.len() <= MAX_ENGINE_STATUS_PROJECTIONS)
        .ok_or_else(|| invalid_frame("ENGINE_STATUS.projections exceeds its bounded limit"))?;
    let mut previous: Option<(String, u64)> = None;
    for (index, projection) in projections.iter().enumerate() {
        let current =
            engine_status_projection(projection, &format!("ENGINE_STATUS.projections[{index}]"))?;
        if previous.as_ref().is_some_and(|value| value >= &current) {
            return Err(invalid_frame(
                "ENGINE_STATUS.projections must be name/version sorted and unique",
            ));
        }
        previous = Some(current);
    }

    let change_log = field(message, "changeLog", kind.as_str())?;
    exact_object_keys(
        change_log,
        "ENGINE_STATUS.changeLog",
        &[
            "rows",
            "payloadBytes",
            "maxRows",
            "maxPayloadBytes",
            "state",
        ],
    )?;
    let (_, rows) = decimal_u64(
        field(change_log, "rows", "ENGINE_STATUS.changeLog")?,
        "ENGINE_STATUS.changeLog.rows",
    )?;
    let (_, payload_bytes) = decimal_u64(
        field(change_log, "payloadBytes", "ENGINE_STATUS.changeLog")?,
        "ENGINE_STATUS.changeLog.payloadBytes",
    )?;
    let (_, max_rows) = decimal_u64(
        field(change_log, "maxRows", "ENGINE_STATUS.changeLog")?,
        "ENGINE_STATUS.changeLog.maxRows",
    )?;
    let (_, max_payload_bytes) = decimal_u64(
        field(change_log, "maxPayloadBytes", "ENGINE_STATUS.changeLog")?,
        "ENGINE_STATUS.changeLog.maxPayloadBytes",
    )?;
    if max_rows != crate::projection::CHANGE_LOG_MAX_ROWS
        || max_payload_bytes != crate::projection::CHANGE_LOG_MAX_PAYLOAD_BYTES
    {
        return Err(invalid_frame("ENGINE_STATUS.changeLog caps are invalid"));
    }
    let expected_change_log_state = if rows > max_rows || payload_bytes > max_payload_bytes {
        "cap-exceeded"
    } else {
        "within-cap"
    };
    if field(change_log, "state", "ENGINE_STATUS.changeLog")?.as_str()
        != Some(expected_change_log_state)
    {
        return Err(invalid_frame(
            "ENGINE_STATUS.changeLog.state is inconsistent",
        ));
    }

    let purge = field(message, "purge", kind.as_str())?;
    exact_object_keys(
        purge,
        "ENGINE_STATUS.purge",
        &["state", "pendingFacts", "pendingMaintenance", "purged"],
    )?;
    purge_state(
        field(purge, "state", "ENGINE_STATUS.purge")?,
        "ENGINE_STATUS.purge.state",
    )?;
    for name in ["pendingFacts", "pendingMaintenance", "purged"] {
        decimal_u64(
            field(purge, name, "ENGINE_STATUS.purge")?,
            &format!("ENGINE_STATUS.purge.{name}"),
        )?;
    }

    let storage = field(message, "storage", kind.as_str())?;
    exact_object_keys(
        storage,
        "ENGINE_STATUS.storage",
        &[
            "databaseBytes",
            "walBytes",
            "walPressureAction",
            "recentDiagnostic",
        ],
    )?;
    decimal_u64(
        field(storage, "databaseBytes", "ENGINE_STATUS.storage")?,
        "ENGINE_STATUS.storage.databaseBytes",
    )?;
    let (_, wal_bytes) = decimal_u64(
        field(storage, "walBytes", "ENGINE_STATUS.storage")?,
        "ENGINE_STATUS.storage.walBytes",
    )?;
    let expected_action = if wal_bytes >= WAL_BACKPRESSURE_BYTES {
        "backpressure"
    } else if wal_bytes >= WAL_PASSIVE_CHECKPOINT_BYTES {
        "passive-checkpoint"
    } else {
        "none"
    };
    if field(storage, "walPressureAction", "ENGINE_STATUS.storage")?.as_str()
        != Some(expected_action)
    {
        return Err(invalid_frame(
            "ENGINE_STATUS.storage.walPressureAction is inconsistent",
        ));
    }
    let recent_diagnostic = field(storage, "recentDiagnostic", "ENGINE_STATUS.storage")?;
    if expected_action == "backpressure" {
        if recent_diagnostic.as_str() != Some("TS_INSIGHTS_WAL_BACKPRESSURE") {
            return Err(invalid_frame(
                "ENGINE_STATUS.storage.recentDiagnostic is inconsistent",
            ));
        }
    } else if !recent_diagnostic.is_null() {
        return Err(invalid_frame(
            "ENGINE_STATUS.storage.recentDiagnostic is inconsistent",
        ));
    }

    let integrity = field(message, "integrity", kind.as_str())?;
    exact_object_keys(integrity, "ENGINE_STATUS.integrity", &["quickCheck", "fts"])?;
    if field(integrity, "quickCheck", "ENGINE_STATUS.integrity")?.as_str() != Some("ok")
        || field(integrity, "fts", "ENGINE_STATUS.integrity")?.as_str() != Some("ok")
    {
        return Err(invalid_frame(
            "ENGINE_STATUS.integrity must report successful checks",
        ));
    }
    Ok(())
}

fn decimal_object(value: &Value, label: &str, fields: &[&str]) -> Result<Vec<u64>, ProtocolError> {
    exact_object_keys(value, label, fields)?;
    decimal_fields(value, label, fields)
}

fn decimal_fields(value: &Value, label: &str, fields: &[&str]) -> Result<Vec<u64>, ProtocolError> {
    fields
        .iter()
        .map(|name| {
            decimal_u64(field(value, name, label)?, &format!("{label}.{name}"))
                .map(|(_, number)| number)
        })
        .collect()
}

fn checked_sum(values: &[u64], label: &str) -> Result<u64, ProtocolError> {
    values.iter().try_fold(0_u64, |total, value| {
        total
            .checked_add(*value)
            .ok_or_else(|| invalid_frame(format!("{label} count sum exceeds uint64")))
    })
}

fn bounded_collection<'a>(
    value: &'a Value,
    label: &str,
    maximum: usize,
) -> Result<&'a Vec<Value>, ProtocolError> {
    exact_object_keys(value, label, &["items", "truncated"])?;
    boolean(
        field(value, "truncated", label)?,
        &format!("{label}.truncated"),
    )?;
    field(value, "items", label)?
        .as_array()
        .filter(|items| items.len() <= maximum)
        .ok_or_else(|| invalid_frame(format!("{label}.items exceeds its bounded limit")))
}

fn validate_overview_rollups(
    value: &Value,
    label: &str,
    maximum: usize,
    key_name: &str,
) -> Result<(), ProtocolError> {
    let items = bounded_collection(value, label, maximum)?;
    let mut previous: Option<&str> = None;
    for (index, item) in items.iter().enumerate() {
        let item_label = format!("{label}.items[{index}]");
        exact_object_keys(
            item,
            &item_label,
            &[
                key_name,
                "rawSessionCount",
                "eligibleSessionCount",
                "indexedTurnCount",
            ],
        )?;
        let key = if key_name == "projectKey" {
            hex64(
                field(item, key_name, &item_label)?,
                &format!("{item_label}.{key_name}"),
            )?
        } else {
            bounded_string(
                field(item, key_name, &item_label)?,
                &format!("{item_label}.{key_name}"),
                128,
                false,
                true,
            )?
        };
        if previous.is_some_and(|value| value >= key) {
            return Err(invalid_frame(format!(
                "{label}.items must be key sorted and unique"
            )));
        }
        previous = Some(key);
        let counts = decimal_fields(
            item,
            &item_label,
            &[
                "rawSessionCount",
                "eligibleSessionCount",
                "indexedTurnCount",
            ],
        )?;
        if counts[1] > counts[0] {
            return Err(invalid_frame(format!(
                "{item_label} eligible sessions exceed raw sessions"
            )));
        }
    }
    Ok(())
}

fn validate_fact_count_items(
    value: &Value,
    label: &str,
    key_name: &str,
) -> Result<(), ProtocolError> {
    let items = bounded_collection(
        value,
        label,
        crate::insights_overview::MAX_OVERVIEW_FACT_SIGNALS,
    )?;
    let mut previous: Option<&str> = None;
    for (index, item) in items.iter().enumerate() {
        let item_label = format!("{label}.items[{index}]");
        exact_object_keys(item, &item_label, &[key_name, "count"])?;
        let key = bounded_string(
            field(item, key_name, &item_label)?,
            &format!("{item_label}.{key_name}"),
            256,
            false,
            true,
        )?;
        if previous.is_some_and(|value| value >= key) {
            return Err(invalid_frame(format!(
                "{label}.items must be key sorted and unique"
            )));
        }
        previous = Some(key);
        decimal_u64(
            field(item, "count", &item_label)?,
            &format!("{item_label}.count"),
        )?;
    }
    Ok(())
}

fn validate_insights_overview(message: &Value, kind: MessageKind) -> Result<(), ProtocolError> {
    const LEGACY_FIELDS: [&str; 10] = [
        "snapshotSeq",
        "sessions",
        "scopes",
        "dedupe",
        "turns",
        "capabilities",
        "providers",
        "projects",
        "coverage",
        "diagnostics",
    ];
    const FIELDS: [&str; 11] = [
        "snapshotSeq",
        "sessions",
        "scopes",
        "dedupe",
        "turns",
        "capabilities",
        "providers",
        "projects",
        "coverage",
        "diagnostics",
        "databaseUuid",
    ];
    let has_database_uuid = message
        .as_object()
        .is_some_and(|message| message.contains_key("databaseUuid"));
    validate_envelope(
        message,
        kind,
        if has_database_uuid {
            &FIELDS
        } else {
            &LEGACY_FIELDS
        },
    )?;
    if has_database_uuid {
        uuid(
            field(message, "databaseUuid", kind.as_str())?,
            "INSIGHTS_OVERVIEW.databaseUuid",
        )?;
    }
    decimal_u64(
        field(message, "snapshotSeq", kind.as_str())?,
        "INSIGHTS_OVERVIEW.snapshotSeq",
    )?;
    let sessions = decimal_object(
        field(message, "sessions", kind.as_str())?,
        "INSIGHTS_OVERVIEW.sessions",
        &["raw", "eligible", "excluded", "subagentExcluded", "unknown"],
    )?;
    if checked_sum(&sessions[1..], "INSIGHTS_OVERVIEW.sessions")? != sessions[0] {
        return Err(invalid_frame(
            "INSIGHTS_OVERVIEW session categories do not sum to raw",
        ));
    }
    let scopes = decimal_object(
        field(message, "scopes", kind.as_str())?,
        "INSIGHTS_OVERVIEW.scopes",
        &["main", "subagent", "unknown"],
    )?;
    if checked_sum(&scopes, "INSIGHTS_OVERVIEW.scopes")? != sessions[0] {
        return Err(invalid_frame(
            "INSIGHTS_OVERVIEW scope counts do not sum to raw sessions",
        ));
    }
    decimal_object(
        field(message, "dedupe", kind.as_str())?,
        "INSIGHTS_OVERVIEW.dedupe",
        &[
            "strongGroup",
            "weakGroup",
            "observedEofProvisionalSession",
            "unknownSession",
        ],
    )?;
    let turns = decimal_object(
        field(message, "turns", kind.as_str())?,
        "INSIGHTS_OVERVIEW.turns",
        &[
            "indexed",
            "active",
            "rolledBack",
            "unknownVisibility",
            "hardSealed",
            "quiescent",
            "open",
        ],
    )?;
    if turns[0] > turns[1]
        || checked_sum(&turns[4..], "INSIGHTS_OVERVIEW.turns closure")? > turns[1]
    {
        return Err(invalid_frame(
            "INSIGHTS_OVERVIEW Turn counts are inconsistent",
        ));
    }
    let capabilities = decimal_object(
        field(message, "capabilities", kind.as_str())?,
        "INSIGHTS_OVERVIEW.capabilities",
        &["total", "tool", "skill"],
    )?;
    if checked_sum(&capabilities[1..], "INSIGHTS_OVERVIEW.capabilities")? != capabilities[0] {
        return Err(invalid_frame(
            "INSIGHTS_OVERVIEW capability categories do not sum to total",
        ));
    }
    validate_overview_rollups(
        field(message, "providers", kind.as_str())?,
        "INSIGHTS_OVERVIEW.providers",
        crate::insights_overview::MAX_OVERVIEW_PROVIDERS,
        "provider",
    )?;
    validate_overview_rollups(
        field(message, "projects", kind.as_str())?,
        "INSIGHTS_OVERVIEW.projects",
        crate::insights_overview::MAX_OVERVIEW_PROJECTS,
        "projectKey",
    )?;
    validate_fact_count_items(
        field(message, "coverage", kind.as_str())?,
        "INSIGHTS_OVERVIEW.coverage",
        "key",
    )?;
    validate_fact_count_items(
        field(message, "diagnostics", kind.as_str())?,
        "INSIGHTS_OVERVIEW.diagnostics",
        "code",
    )?;
    Ok(())
}

fn validate_capability_page(message: &Value, kind: MessageKind) -> Result<(), ProtocolError> {
    validate_envelope(
        message,
        kind,
        &[
            "databaseUuid",
            "snapshotSeq",
            "items",
            "nextCursor",
            "coverage",
        ],
    )?;
    uuid(
        field(message, "databaseUuid", kind.as_str())?,
        "CAPABILITY_PAGE.databaseUuid",
    )?;
    decimal_u64(
        field(message, "snapshotSeq", kind.as_str())?,
        "CAPABILITY_PAGE.snapshotSeq",
    )?;
    let items = field(message, "items", kind.as_str())?
        .as_array()
        .filter(|items| {
            items.len() <= usize::from(crate::insights_overview::MAX_CAPABILITY_PAGE_SIZE)
        })
        .ok_or_else(|| invalid_frame("CAPABILITY_PAGE.items exceeds 200"))?;
    let mut previous: Option<&str> = None;
    for (index, item) in items.iter().enumerate() {
        let label = format!("CAPABILITY_PAGE.items[{index}]");
        exact_object_keys(
            item,
            &label,
            &[
                "capabilityKey",
                "provider",
                "kind",
                "canonicalName",
                "useCount",
                "turnCount",
                "sessionCount",
                "terminal",
                "strength",
            ],
        )?;
        let key = hex64(
            field(item, "capabilityKey", &label)?,
            &format!("{label}.capabilityKey"),
        )?;
        if previous.is_some_and(|value| value >= key) {
            return Err(invalid_frame(
                "CAPABILITY_PAGE.items must be capabilityKey sorted and unique",
            ));
        }
        previous = Some(key);
        bounded_string(
            field(item, "provider", &label)?,
            &format!("{label}.provider"),
            128,
            false,
            true,
        )?;
        enum_string(
            field(item, "kind", &label)?,
            &format!("{label}.kind"),
            &["tool", "skill"],
        )?;
        bounded_string(
            field(item, "canonicalName", &label)?,
            &format!("{label}.canonicalName"),
            512,
            false,
            false,
        )?;
        let counts = decimal_fields(item, &label, &["useCount", "turnCount", "sessionCount"])?;
        if counts[1] > counts[0] || counts[2] > counts[1] {
            return Err(invalid_frame(format!(
                "{label} aggregate counts are inconsistent"
            )));
        }
        let terminal = decimal_object(
            field(item, "terminal", &label)?,
            &format!("{label}.terminal"),
            &["pending", "completed", "failed", "cancelled", "unknown"],
        )?;
        let strength = decimal_object(
            field(item, "strength", &label)?,
            &format!("{label}.strength"),
            &["observed", "confirmed", "inferred"],
        )?;
        if checked_sum(&terminal, &format!("{label}.terminal"))? != counts[0]
            || checked_sum(&strength, &format!("{label}.strength"))? != counts[0]
        {
            return Err(invalid_frame(format!(
                "{label} state counts do not sum to useCount"
            )));
        }
    }
    let next_cursor = field(message, "nextCursor", kind.as_str())?;
    if !next_cursor.is_null() {
        let cursor = hex64(next_cursor, "CAPABILITY_PAGE.nextCursor")?;
        if previous != Some(cursor) {
            return Err(invalid_frame(
                "CAPABILITY_PAGE.nextCursor must equal the final capabilityKey",
            ));
        }
    }
    decimal_object(
        field(message, "coverage", kind.as_str())?,
        "CAPABILITY_PAGE.coverage",
        &[
            "excludedUndatedInvocationCount",
            "excludedUndatedTurnCount",
            "excludedUnrevisionedInvocationCount",
            "excludedUnrevisionedTurnCount",
            "fullyExcludedCapabilityCount",
        ],
    )?;
    Ok(())
}

pub fn decimal_u64<'a>(value: &'a Value, label: &str) -> Result<(&'a str, u64), ProtocolError> {
    let text = value
        .as_str()
        .ok_or_else(|| invalid_frame(format!("{label} must be a uint64 decimal string")))?;
    if text.is_empty()
        || (text.len() > 1 && text.starts_with('0'))
        || !text.bytes().all(|byte| byte.is_ascii_digit())
    {
        return Err(invalid_frame(format!(
            "{label} must be a uint64 decimal string"
        )));
    }
    let number = text
        .parse::<u64>()
        .map_err(|_| invalid_frame(format!("{label} must be a uint64 decimal string")))?;
    Ok((text, number))
}

fn uuid<'a>(value: &'a Value, label: &str) -> Result<&'a str, ProtocolError> {
    let value = value
        .as_str()
        .ok_or_else(|| invalid_frame(format!("{label} must be a UUID")))?;
    if value.len() != 36 {
        return Err(invalid_frame(format!("{label} must be a UUID")));
    }
    for (index, byte) in value.bytes().enumerate() {
        let dash = matches!(index, 8 | 13 | 18 | 23);
        let valid = if dash {
            byte == b'-'
        } else {
            byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte.to_ascii_lowercase())
        };
        if !valid {
            return Err(invalid_frame(format!("{label} must be a UUID")));
        }
    }
    Ok(value)
}

fn sorted_ascii_strings<'a>(
    value: &'a Value,
    label: &str,
    allow_empty: bool,
) -> Result<Vec<&'a str>, ProtocolError> {
    let values = value
        .as_array()
        .filter(|values| allow_empty || !values.is_empty())
        .ok_or_else(|| invalid_frame(format!("{label} must be an array")))?;
    let mut result = Vec::with_capacity(values.len());
    for (index, item) in values.iter().enumerate() {
        let item = ascii_name(item, &format!("{label}[{index}]"))?;
        if result.last().is_some_and(|previous| previous >= &item) {
            return Err(invalid_frame(format!(
                "{label} must be ASCII-sorted and contain unique values"
            )));
        }
        result.push(item);
    }
    Ok(result)
}

fn validate_handshake_contract(value: &Value, label: &str) -> Result<(), ProtocolError> {
    exact_object_keys(value, label, &HANDSHAKE_CONTRACT_FIELDS)?;
    positive_safe_integer(
        field(value, "factSchemaVersion", label)?,
        &format!("{label}.factSchemaVersion"),
    )?;
    sorted_ascii_strings(
        field(value, "providerAdapterVersions", label)?,
        &format!("{label}.providerAdapterVersions"),
        false,
    )?;
    positive_safe_integer(
        field(value, "privacyPolicyVersion", label)?,
        &format!("{label}.privacyPolicyVersion"),
    )?;
    uuid(
        field(value, "originSecretEpoch", label)?,
        &format!("{label}.originSecretEpoch"),
    )?;
    positive_safe_integer(
        field(value, "duplicatePolicyVersion", label)?,
        &format!("{label}.duplicatePolicyVersion"),
    )?;
    ascii_name(
        field(value, "factStorageProfile", label)?,
        &format!("{label}.factStorageProfile"),
    )?;
    positive_safe_integer(
        field(value, "storageSchemaVersion", label)?,
        &format!("{label}.storageSchemaVersion"),
    )?;
    sorted_ascii_strings(
        field(value, "projectionVersions", label)?,
        &format!("{label}.projectionVersions"),
        true,
    )?;
    sorted_ascii_strings(
        field(value, "analyzerCapabilities", label)?,
        &format!("{label}.analyzerCapabilities"),
        true,
    )?;
    positive_safe_integer(
        field(value, "rankerVersion", label)?,
        &format!("{label}.rankerVersion"),
    )?;
    Ok(())
}

fn validate_session_contract(value: &Value, label: &str) -> Result<(), ProtocolError> {
    exact_object_keys(value, label, &SESSION_CONTRACT_FIELDS)?;
    positive_safe_integer(
        field(value, "factSchemaVersion", label)?,
        &format!("{label}.factSchemaVersion"),
    )?;
    ascii_name(
        field(value, "providerAdapterVersion", label)?,
        &format!("{label}.providerAdapterVersion"),
    )?;
    positive_safe_integer(
        field(value, "privacyPolicyVersion", label)?,
        &format!("{label}.privacyPolicyVersion"),
    )?;
    uuid(
        field(value, "originSecretEpoch", label)?,
        &format!("{label}.originSecretEpoch"),
    )?;
    positive_safe_integer(
        field(value, "duplicatePolicyVersion", label)?,
        &format!("{label}.duplicatePolicyVersion"),
    )?;
    ascii_name(
        field(value, "factStorageProfile", label)?,
        &format!("{label}.factStorageProfile"),
    )?;
    positive_safe_integer(
        field(value, "storageSchemaVersion", label)?,
        &format!("{label}.storageSchemaVersion"),
    )?;
    sorted_ascii_strings(
        field(value, "projectionVersions", label)?,
        &format!("{label}.projectionVersions"),
        true,
    )?;
    sorted_ascii_strings(
        field(value, "analyzerCapabilities", label)?,
        &format!("{label}.analyzerCapabilities"),
        true,
    )?;
    positive_safe_integer(
        field(value, "rankerVersion", label)?,
        &format!("{label}.rankerVersion"),
    )?;
    Ok(())
}

fn validate_envelope(
    message: &Value,
    kind: MessageKind,
    fields: &[&str],
) -> Result<(), ProtocolError> {
    let label = kind.as_str();
    exact_keys(message, label, fields)?;
    if field(message, "format", label)?.as_str() != Some(PROTOCOL_FORMAT) {
        return Err(ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_UNSUPPORTED_VERSION",
            "unsupported Insights protocol version",
            false,
        ));
    }
    if field(message, "type", label)?.as_str() != Some(label) {
        return Err(invalid_frame(format!("expected {label}")));
    }
    decimal_u64(
        field(message, "requestId", label)?,
        &format!("{label}.requestId"),
    )?;
    Ok(())
}

fn validate_search_filters(value: &Value) -> Result<(), ProtocolError> {
    const LEGACY_FIELDS: [&str; 8] = [
        "providers",
        "projectKeys",
        "observedAtOrAfterUnixMs",
        "observedBeforeUnixMs",
        "toolCapabilityKeys",
        "skillCapabilityKeys",
        "resultEvidence",
        "closureStates",
    ];
    const FIELDS: [&str; 9] = [
        "providers",
        "projectKeys",
        "observedAtOrAfterUnixMs",
        "observedBeforeUnixMs",
        "toolCapabilityKeys",
        "skillCapabilityKeys",
        "resultEvidence",
        "closureStates",
        "capabilityTerminalStates",
    ];
    let has_capability_terminal_states = value
        .as_object()
        .is_some_and(|value| value.contains_key("capabilityTerminalStates"));
    exact_object_keys(
        value,
        "SEARCH_TURNS.filters",
        if has_capability_terminal_states {
            &FIELDS
        } else {
            &LEGACY_FIELDS
        },
    )?;
    sorted_bounded_strings(
        field(value, "providers", "SEARCH_TURNS.filters")?,
        "SEARCH_TURNS.filters.providers",
        MAX_FILTER_PROVIDERS,
        64,
        true,
    )?;
    for name in ["projectKeys", "toolCapabilityKeys", "skillCapabilityKeys"] {
        let label = format!("SEARCH_TURNS.filters.{name}");
        let values = field(value, name, "SEARCH_TURNS.filters")?
            .as_array()
            .filter(|values| values.len() <= MAX_FILTER_KEYS)
            .ok_or_else(|| invalid_frame(format!("{label} exceeds its bounded limit")))?;
        let mut previous = None;
        for (index, item) in values.iter().enumerate() {
            let current = hex64(item, &format!("{label}[{index}]"))?;
            if previous.is_some_and(|value| value >= current) {
                return Err(invalid_frame(format!(
                    "{label} must be sorted and contain unique values"
                )));
            }
            previous = Some(current);
        }
    }
    let after = field(value, "observedAtOrAfterUnixMs", "SEARCH_TURNS.filters")?;
    let before = field(value, "observedBeforeUnixMs", "SEARCH_TURNS.filters")?;
    let after = if after.is_null() {
        None
    } else {
        Some(decimal_u64(after, "SEARCH_TURNS.filters.observedAtOrAfterUnixMs")?.1)
    };
    let before = if before.is_null() {
        None
    } else {
        Some(decimal_u64(before, "SEARCH_TURNS.filters.observedBeforeUnixMs")?.1)
    };
    if after.zip(before).is_some_and(|(start, end)| start >= end) {
        return Err(invalid_frame(
            "SEARCH_TURNS.filters timestamp interval must be non-empty",
        ));
    }
    for (name, allowed) in [
        (
            "resultEvidence",
            &["abandoned", "provider-completed", "unknown"][..],
        ),
        ("closureStates", &["hard-sealed", "open", "quiescent"][..]),
    ] {
        let label = format!("SEARCH_TURNS.filters.{name}");
        let values = sorted_bounded_strings(
            field(value, name, "SEARCH_TURNS.filters")?,
            &label,
            3,
            32,
            true,
        )?;
        if values.iter().any(|item| !allowed.contains(item)) {
            return Err(invalid_frame(format!("{label} is invalid")));
        }
    }
    if has_capability_terminal_states {
        let terminal_states = sorted_bounded_strings(
            field(value, "capabilityTerminalStates", "SEARCH_TURNS.filters")?,
            "SEARCH_TURNS.filters.capabilityTerminalStates",
            5,
            16,
            true,
        )?;
        if terminal_states
            .iter()
            .any(|item| !["pending", "completed", "failed", "cancelled", "unknown"].contains(item))
        {
            return Err(invalid_frame(
                "SEARCH_TURNS.filters.capabilityTerminalStates is invalid",
            ));
        }
        let has_capability_keys =
            ["toolCapabilityKeys", "skillCapabilityKeys"]
                .iter()
                .any(|name| {
                    field(value, name, "SEARCH_TURNS.filters")
                        .ok()
                        .and_then(Value::as_array)
                        .is_some_and(|values| !values.is_empty())
                });
        if !terminal_states.is_empty() && !has_capability_keys {
            return Err(invalid_frame(
                "SEARCH_TURNS.filters.capabilityTerminalStates requires a capability key filter",
            ));
        }
    }
    Ok(())
}

fn validate_search_turns(message: &Value, kind: MessageKind) -> Result<(), ProtocolError> {
    const LEGACY_FIELDS: [&str; 6] = [
        "query",
        "filters",
        "limit",
        "pathLimit",
        "nowUnixMs",
        "quiescenceSeconds",
    ];
    const FIELDS: [&str; 7] = [
        "query",
        "filters",
        "orderBy",
        "limit",
        "pathLimit",
        "nowUnixMs",
        "quiescenceSeconds",
    ];
    let has_order_by = message
        .as_object()
        .is_some_and(|message| message.contains_key("orderBy"));
    validate_envelope(
        message,
        kind,
        if has_order_by {
            &FIELDS
        } else {
            &LEGACY_FIELDS
        },
    )?;
    bounded_string(
        field(message, "query", kind.as_str())?,
        "SEARCH_TURNS.query",
        MAX_QUERY_WIRE_BYTES,
        true,
        false,
    )?;
    validate_search_filters(field(message, "filters", kind.as_str())?)?;
    safe_integer_range(
        field(message, "limit", kind.as_str())?,
        "SEARCH_TURNS.limit",
        1,
        MAX_SEARCH_RESULTS,
    )?;
    safe_integer_range(
        field(message, "pathLimit", kind.as_str())?,
        "SEARCH_TURNS.pathLimit",
        0,
        MAX_PATH_FAMILIES,
    )?;
    decimal_u64(
        field(message, "nowUnixMs", kind.as_str())?,
        "SEARCH_TURNS.nowUnixMs",
    )?;
    safe_integer_range(
        field(message, "quiescenceSeconds", kind.as_str())?,
        "SEARCH_TURNS.quiescenceSeconds",
        60,
        86_400,
    )?;
    if has_order_by {
        enum_string(
            field(message, "orderBy", kind.as_str())?,
            "SEARCH_TURNS.orderBy",
            &["relevance", "observed-desc"],
        )?;
    }
    Ok(())
}

fn validate_search_snapshot(value: &Value) -> Result<(), ProtocolError> {
    exact_object_keys(
        value,
        "TURN_SEARCH_RESULTS.snapshot",
        &[
            "snapshotSeq",
            "projectionVersion",
            "analyzerVersion",
            "rankerVersion",
        ],
    )?;
    decimal_u64(
        field(value, "snapshotSeq", "TURN_SEARCH_RESULTS.snapshot")?,
        "TURN_SEARCH_RESULTS.snapshot.snapshotSeq",
    )?;
    for name in ["projectionVersion", "analyzerVersion", "rankerVersion"] {
        positive_safe_integer(
            field(value, name, "TURN_SEARCH_RESULTS.snapshot")?,
            &format!("TURN_SEARCH_RESULTS.snapshot.{name}"),
        )?;
    }
    Ok(())
}

fn validate_scoring_term(value: &Value, index: usize) -> Result<(), ProtocolError> {
    let label = format!("TURN_SEARCH_RESULTS.scoringTerms[{index}]");
    exact_object_keys(
        value,
        &label,
        &[
            "logicalTerm",
            "field",
            "token",
            "documentFrequency",
            "fieldDocumentCount",
        ],
    )?;
    bounded_string(
        field(value, "logicalTerm", &label)?,
        &format!("{label}.logicalTerm"),
        512,
        false,
        false,
    )?;
    enum_string(
        field(value, "field", &label)?,
        &format!("{label}.field"),
        &["capability", "code", "natural"],
    )?;
    bounded_string(
        field(value, "token", &label)?,
        &format!("{label}.token"),
        512,
        false,
        true,
    )?;
    let frequency = decimal_u64(
        field(value, "documentFrequency", &label)?,
        &format!("{label}.documentFrequency"),
    )?
    .1;
    let document_count = decimal_u64(
        field(value, "fieldDocumentCount", &label)?,
        &format!("{label}.fieldDocumentCount"),
    )?
    .1;
    if frequency > document_count {
        return Err(invalid_frame(format!(
            "{label}.documentFrequency exceeds its field document count"
        )));
    }
    Ok(())
}

fn validate_ppm(value: &Value, label: &str) -> Result<(), ProtocolError> {
    safe_integer_range(value, label, 0, MAX_PPM)?;
    Ok(())
}

fn validate_search_score(
    value: &Value,
    label: &str,
    scoring_term_count: usize,
) -> Result<(), ProtocolError> {
    if value.is_null() {
        return Ok(());
    }
    exact_object_keys(
        value,
        label,
        &[
            "relevancePpm",
            "bm25Rank",
            "rankComponentPpm",
            "idfCoveragePpm",
            "exact",
            "matchedTermIndexes",
        ],
    )?;
    for name in ["relevancePpm", "rankComponentPpm", "idfCoveragePpm"] {
        validate_ppm(field(value, name, label)?, &format!("{label}.{name}"))?;
    }
    safe_integer_range(
        field(value, "bm25Rank", label)?,
        &format!("{label}.bm25Rank"),
        1,
        300,
    )?;
    boolean(field(value, "exact", label)?, &format!("{label}.exact"))?;
    let indexes = field(value, "matchedTermIndexes", label)?
        .as_array()
        .filter(|values| values.len() <= MAX_SCORING_TERMS)
        .ok_or_else(|| {
            invalid_frame(format!(
                "{label}.matchedTermIndexes exceeds its bounded limit"
            ))
        })?;
    let mut previous = None;
    for (index, item) in indexes.iter().enumerate() {
        let current = safe_integer_range(
            item,
            &format!("{label}.matchedTermIndexes[{index}]"),
            0,
            scoring_term_count.saturating_sub(1) as u64,
        )?;
        if scoring_term_count == 0 || previous.is_some_and(|value| value >= current) {
            return Err(invalid_frame(format!(
                "{label}.matchedTermIndexes must be sorted and unique"
            )));
        }
        previous = Some(current);
    }
    Ok(())
}

fn validate_search_result(
    value: &Value,
    index: usize,
    scoring_term_count: usize,
) -> Result<(), ProtocolError> {
    let label = format!("TURN_SEARCH_RESULTS.results[{index}]");
    let has_dedupe = value
        .as_object()
        .is_some_and(|value| value.contains_key("dedupe"));
    let mut fields = vec![
        "turnKey",
        "sessionKey",
        "revision",
        "provider",
        "projectKey",
        "observedTimestamp",
        "problemExcerpt",
        "problemTruncated",
        "finalAnswerExcerpt",
        "finalAnswerTruncated",
        "closureState",
        "resultEvidence",
        "score",
    ];
    if has_dedupe {
        fields.push("dedupe");
    }
    exact_object_keys(value, &label, &fields)?;
    for name in ["turnKey", "sessionKey", "revision"] {
        hex64(field(value, name, &label)?, &format!("{label}.{name}"))?;
    }
    bounded_string(
        field(value, "provider", &label)?,
        &format!("{label}.provider"),
        64,
        false,
        true,
    )?;
    nullable_hex64(
        field(value, "projectKey", &label)?,
        &format!("{label}.projectKey"),
    )?;
    nullable_timestamp(
        field(value, "observedTimestamp", &label)?,
        &format!("{label}.observedTimestamp"),
    )?;
    bounded_string(
        field(value, "problemExcerpt", &label)?,
        &format!("{label}.problemExcerpt"),
        MAX_SEARCH_EXCERPT_BYTES,
        true,
        false,
    )?;
    boolean(
        field(value, "problemTruncated", &label)?,
        &format!("{label}.problemTruncated"),
    )?;
    let final_excerpt = field(value, "finalAnswerExcerpt", &label)?;
    if !final_excerpt.is_null() {
        bounded_string(
            final_excerpt,
            &format!("{label}.finalAnswerExcerpt"),
            MAX_SEARCH_EXCERPT_BYTES,
            true,
            false,
        )?;
    }
    boolean(
        field(value, "finalAnswerTruncated", &label)?,
        &format!("{label}.finalAnswerTruncated"),
    )?;
    enum_string(
        field(value, "closureState", &label)?,
        &format!("{label}.closureState"),
        &["hard-sealed", "open", "quiescent"],
    )?;
    enum_string(
        field(value, "resultEvidence", &label)?,
        &format!("{label}.resultEvidence"),
        &["abandoned", "provider-completed", "unknown"],
    )?;
    validate_search_score(
        field(value, "score", &label)?,
        &format!("{label}.score"),
        scoring_term_count,
    )?;
    if has_dedupe {
        let dedupe = field(value, "dedupe", &label)?;
        let dedupe_label = format!("{label}.dedupe");
        exact_object_keys(
            dedupe,
            &dedupe_label,
            &["duplicateGroupKey", "confidence", "observedEofProvisional"],
        )?;
        hex64(
            field(dedupe, "duplicateGroupKey", &dedupe_label)?,
            &format!("{dedupe_label}.duplicateGroupKey"),
        )?;
        enum_string(
            field(dedupe, "confidence", &dedupe_label)?,
            &format!("{dedupe_label}.confidence"),
            &["strong", "weak"],
        )?;
        boolean(
            field(dedupe, "observedEofProvisional", &dedupe_label)?,
            &format!("{dedupe_label}.observedEofProvisional"),
        )?;
    }
    Ok(())
}

fn validate_tool_state_counts(value: &Value, label: &str) -> Result<(), ProtocolError> {
    exact_object_keys(
        value,
        label,
        &["pending", "completed", "failed", "cancelled", "unknown"],
    )?;
    for name in ["pending", "completed", "failed", "cancelled", "unknown"] {
        safe_integer_range(
            field(value, name, label)?,
            &format!("{label}.{name}"),
            0,
            25_600,
        )?;
    }
    Ok(())
}

/// The four counts partition the family's Turns, so their sum is checked against
/// `turn_count` here rather than left to the reader. A sum that drifts would let a
/// caller read "this path ships nothing" off a family whose delivery was merely
/// unobservable, which is the one confusion the counts exist to prevent.
fn validate_path_delivery_outcome(
    value: &Value,
    label: &str,
    turn_count: u64,
) -> Result<(), ProtocolError> {
    const FIELDS: [&str; 4] = [
        "directCommitTurnCount",
        "observedCommitTurnCount",
        "noDeliveryTurnCount",
        "uncoveredTurnCount",
    ];
    exact_object_keys(value, label, &FIELDS)?;
    let mut total: u64 = 0;
    for name in FIELDS {
        total += safe_integer_range(
            field(value, name, label)?,
            &format!("{label}.{name}"),
            0,
            MAX_SEARCH_RESULTS,
        )?;
    }
    if total != turn_count {
        return Err(invalid_frame(format!(
            "{label} counts must partition the family turnCount"
        )));
    }
    Ok(())
}

fn validate_path_family(value: &Value, index: usize) -> Result<(), ProtocolError> {
    let label = format!("TURN_SEARCH_RESULTS.evidencePaths.families[{index}]");
    exact_object_keys(
        value,
        &label,
        &[
            "fingerprint",
            "nodes",
            "truncated",
            "bestRelevancePpm",
            "turnCount",
            "rawSessionCount",
            "independentGroupCount",
            "strongGroupCount",
            "weakGroupCount",
            "observedEofProvisionalGroupCount",
            "unknownDedupeSessionCount",
            "latestUnixMs",
            "toolStateCounts",
            "deliveryOutcome",
            "evidenceTurnKeys",
        ],
    )?;
    hex64(
        field(value, "fingerprint", &label)?,
        &format!("{label}.fingerprint"),
    )?;
    let nodes = field(value, "nodes", &label)?
        .as_array()
        .filter(|values| values.len() <= MAX_PATH_NODES)
        .ok_or_else(|| invalid_frame(format!("{label}.nodes exceeds its bounded limit")))?;
    for (node_index, node) in nodes.iter().enumerate() {
        let node_label = format!("{label}.nodes[{node_index}]");
        exact_object_keys(node, &node_label, &["providerScopedName", "repeatBucket"])?;
        bounded_string(
            field(node, "providerScopedName", &node_label)?,
            &format!("{node_label}.providerScopedName"),
            640,
            false,
            false,
        )?;
        enum_string(
            field(node, "repeatBucket", &node_label)?,
            &format!("{node_label}.repeatBucket"),
            &["1", "2-3", "4+"],
        )?;
    }
    boolean(
        field(value, "truncated", &label)?,
        &format!("{label}.truncated"),
    )?;
    validate_ppm(
        field(value, "bestRelevancePpm", &label)?,
        &format!("{label}.bestRelevancePpm"),
    )?;
    let mut counts = Vec::new();
    for name in [
        "turnCount",
        "rawSessionCount",
        "independentGroupCount",
        "strongGroupCount",
        "weakGroupCount",
        "observedEofProvisionalGroupCount",
        "unknownDedupeSessionCount",
    ] {
        counts.push(safe_integer_range(
            field(value, name, &label)?,
            &format!("{label}.{name}"),
            0,
            MAX_SEARCH_RESULTS,
        )?);
    }
    let [
        turns,
        sessions,
        independent,
        strong,
        weak,
        provisional,
        unknown,
    ] = counts.as_slice()
    else {
        unreachable!("fixed support count set")
    };
    if sessions > turns
        || independent > sessions
        || strong + weak != *independent
        || provisional > independent
        || unknown > sessions
        || *turns < 5
        || *independent < 3
    {
        return Err(invalid_frame(format!(
            "{label} support counts are inconsistent"
        )));
    }
    safe_integer_range(
        field(value, "latestUnixMs", &label)?,
        &format!("{label}.latestUnixMs"),
        0,
        MAX_SAFE_INTEGER,
    )?;
    validate_tool_state_counts(
        field(value, "toolStateCounts", &label)?,
        &format!("{label}.toolStateCounts"),
    )?;
    validate_path_delivery_outcome(
        field(value, "deliveryOutcome", &label)?,
        &format!("{label}.deliveryOutcome"),
        *turns,
    )?;
    let keys = field(value, "evidenceTurnKeys", &label)?
        .as_array()
        .filter(|values| values.len() <= MAX_SEARCH_RESULTS as usize)
        .ok_or_else(|| {
            invalid_frame(format!(
                "{label}.evidenceTurnKeys exceeds its bounded limit"
            ))
        })?;
    let mut previous = None;
    for (key_index, key) in keys.iter().enumerate() {
        let current = hex64(key, &format!("{label}.evidenceTurnKeys[{key_index}]"))?;
        if previous.is_some_and(|value| value >= current) {
            return Err(invalid_frame(format!(
                "{label}.evidenceTurnKeys must be sorted and unique"
            )));
        }
        previous = Some(current);
    }
    Ok(())
}

fn validate_evidence_path_report(value: &Value) -> Result<(), ProtocolError> {
    let label = "TURN_SEARCH_RESULTS.evidencePaths";
    exact_object_keys(
        value,
        label,
        &[
            "insufficientSample",
            "pathsTruncated",
            "rawMatchCount",
            "eligibleTurnCount",
            "rawSessionCount",
            "independentGroupCount",
            "strongGroupCount",
            "weakGroupCount",
            "observedEofProvisionalGroupCount",
            "unknownDedupeCount",
            "unknownDedupeSessionCount",
            "families",
        ],
    )?;
    let insufficient = boolean(
        field(value, "insufficientSample", label)?,
        &format!("{label}.insufficientSample"),
    )?;
    boolean(
        field(value, "pathsTruncated", label)?,
        &format!("{label}.pathsTruncated"),
    )?;
    let raw = safe_integer_range(
        field(value, "rawMatchCount", label)?,
        &format!("{label}.rawMatchCount"),
        0,
        MAX_SEARCH_RESULTS,
    )?;
    let eligible = safe_integer_range(
        field(value, "eligibleTurnCount", label)?,
        &format!("{label}.eligibleTurnCount"),
        0,
        MAX_SEARCH_RESULTS,
    )?;
    let raw_sessions = safe_integer_range(
        field(value, "rawSessionCount", label)?,
        &format!("{label}.rawSessionCount"),
        0,
        MAX_SEARCH_RESULTS,
    )?;
    let independent = safe_integer_range(
        field(value, "independentGroupCount", label)?,
        &format!("{label}.independentGroupCount"),
        0,
        MAX_SEARCH_RESULTS,
    )?;
    let strong = safe_integer_range(
        field(value, "strongGroupCount", label)?,
        &format!("{label}.strongGroupCount"),
        0,
        MAX_SEARCH_RESULTS,
    )?;
    let weak = safe_integer_range(
        field(value, "weakGroupCount", label)?,
        &format!("{label}.weakGroupCount"),
        0,
        MAX_SEARCH_RESULTS,
    )?;
    let provisional = safe_integer_range(
        field(value, "observedEofProvisionalGroupCount", label)?,
        &format!("{label}.observedEofProvisionalGroupCount"),
        0,
        MAX_SEARCH_RESULTS,
    )?;
    let unknown = safe_integer_range(
        field(value, "unknownDedupeCount", label)?,
        &format!("{label}.unknownDedupeCount"),
        0,
        MAX_SEARCH_RESULTS,
    )?;
    let unknown_sessions = safe_integer_range(
        field(value, "unknownDedupeSessionCount", label)?,
        &format!("{label}.unknownDedupeSessionCount"),
        0,
        MAX_SEARCH_RESULTS,
    )?;
    if eligible > raw
        || raw_sessions > eligible
        || independent > raw_sessions
        || strong + weak != independent
        || provisional > independent
        || unknown > eligible
        || unknown_sessions > unknown
        || independent + unknown_sessions > raw_sessions
    {
        return Err(invalid_frame(format!(
            "{label} aggregate counts are inconsistent"
        )));
    }
    let families = field(value, "families", label)?
        .as_array()
        .filter(|values| values.len() <= MAX_PATH_FAMILIES as usize)
        .ok_or_else(|| invalid_frame(format!("{label}.families exceeds its bounded limit")))?;
    if insufficient && !families.is_empty() {
        return Err(invalid_frame(format!(
            "{label}.families must be empty for an insufficient sample"
        )));
    }
    let mut evidence_count = 0_usize;
    for (index, family) in families.iter().enumerate() {
        validate_path_family(family, index)?;
        evidence_count += field(family, "evidenceTurnKeys", "path family")?
            .as_array()
            .expect("validated evidence keys")
            .len();
    }
    if evidence_count > MAX_SEARCH_RESULTS as usize {
        return Err(invalid_frame(format!(
            "{label} path evidence exceeds its bounded limit"
        )));
    }
    Ok(())
}

fn validate_query_diagnostic(value: &Value) -> Result<(), ProtocolError> {
    let label = "TURN_SEARCH_RESULTS.diagnostic";
    exact_object_keys(
        value,
        label,
        &[
            "analyzeMicros",
            "dfMicros",
            "postingFilterMicros",
            "rerankMicros",
            "pathMicros",
            "zeroDfTermCount",
            "highFrequencyTermCount",
            "truncatedTermCount",
            "scoringTermCount",
        ],
    )?;
    for name in [
        "analyzeMicros",
        "dfMicros",
        "postingFilterMicros",
        "rerankMicros",
        "pathMicros",
    ] {
        safe_integer_range(
            field(value, name, label)?,
            &format!("{label}.{name}"),
            0,
            MAX_SAFE_INTEGER,
        )?;
    }
    for name in [
        "zeroDfTermCount",
        "highFrequencyTermCount",
        "truncatedTermCount",
        "scoringTermCount",
    ] {
        safe_integer_range(
            field(value, name, label)?,
            &format!("{label}.{name}"),
            0,
            u16::MAX.into(),
        )?;
    }
    Ok(())
}

fn validate_search_trace(value: &Value) -> Result<(), ProtocolError> {
    let label = "TURN_SEARCH_RESULTS.searchTrace";
    exact_object_keys(value, label, &["candidateCount", "candidateTurnKeys"])?;
    let count = safe_integer_range(
        field(value, "candidateCount", label)?,
        &format!("{label}.candidateCount"),
        0,
        MAX_SEARCH_CANDIDATES as u64,
    )?;
    let keys = field(value, "candidateTurnKeys", label)?
        .as_array()
        .filter(|values| values.len() <= MAX_SEARCH_CANDIDATES)
        .ok_or_else(|| {
            invalid_frame(format!(
                "{label}.candidateTurnKeys exceeds its bounded limit"
            ))
        })?;
    if count != keys.len() as u64 {
        return Err(invalid_frame(format!(
            "{label} candidate count is inconsistent"
        )));
    }
    let mut seen = BTreeSet::new();
    for (index, key) in keys.iter().enumerate() {
        let key = hex64(key, &format!("{label}.candidateTurnKeys[{index}]"))?;
        if !seen.insert(key) {
            return Err(invalid_frame(format!(
                "{label}.candidateTurnKeys contains a duplicate"
            )));
        }
    }
    Ok(())
}

fn validate_turn_search_results(message: &Value, kind: MessageKind) -> Result<(), ProtocolError> {
    let mut fields = vec![
        "snapshot",
        "scoringTerms",
        "results",
        "evidencePaths",
        "diagnostic",
        "searchTrace",
    ];
    let agent_fields = [
        "orderBy",
        "totalMatchCount",
        "closureEvaluatedAt",
        "quiescenceSeconds",
    ];
    let has_agent_fields = message.as_object().is_some_and(|message| {
        agent_fields
            .iter()
            .any(|field| message.contains_key(*field))
    });
    if has_agent_fields {
        fields.extend(agent_fields);
    }
    let has_database_uuid = message
        .as_object()
        .is_some_and(|message| message.contains_key("databaseUuid"));
    if has_database_uuid {
        fields.push("databaseUuid");
    }
    validate_envelope(message, kind, &fields)?;
    if has_database_uuid {
        uuid(
            field(message, "databaseUuid", kind.as_str())?,
            "TURN_SEARCH_RESULTS.databaseUuid",
        )?;
    }
    let order_by = if has_agent_fields {
        let order_by = enum_string(
            field(message, "orderBy", kind.as_str())?,
            "TURN_SEARCH_RESULTS.orderBy",
            &["relevance", "observed-desc"],
        )?;
        decimal_u64(
            field(message, "totalMatchCount", kind.as_str())?,
            "TURN_SEARCH_RESULTS.totalMatchCount",
        )?;
        canonical_timestamp_millis(
            field(message, "closureEvaluatedAt", kind.as_str())?,
            "TURN_SEARCH_RESULTS.closureEvaluatedAt",
        )?;
        safe_integer_range(
            field(message, "quiescenceSeconds", kind.as_str())?,
            "TURN_SEARCH_RESULTS.quiescenceSeconds",
            60,
            86_400,
        )?;
        Some(order_by)
    } else {
        None
    };
    validate_search_snapshot(field(message, "snapshot", kind.as_str())?)?;
    let terms = field(message, "scoringTerms", kind.as_str())?
        .as_array()
        .filter(|values| values.len() <= MAX_SCORING_TERMS)
        .ok_or_else(|| {
            invalid_frame("TURN_SEARCH_RESULTS.scoringTerms exceeds its bounded limit")
        })?;
    for (index, term) in terms.iter().enumerate() {
        validate_scoring_term(term, index)?;
    }
    let results = field(message, "results", kind.as_str())?
        .as_array()
        .filter(|values| values.len() <= MAX_SEARCH_RESULTS as usize)
        .ok_or_else(|| invalid_frame("TURN_SEARCH_RESULTS.results exceeds its bounded limit"))?;
    for (index, result) in results.iter().enumerate() {
        validate_search_result(result, index, terms.len())?;
        if has_agent_fields
            && field(result, "observedTimestamp", "TURN_SEARCH_RESULTS result")?.is_null()
        {
            return Err(invalid_frame(
                "TURN_SEARCH_RESULTS Agent results require observedTimestamp",
            ));
        }
        if order_by == Some("observed-desc")
            && !field(result, "score", "TURN_SEARCH_RESULTS result")?.is_null()
        {
            return Err(invalid_frame(
                "TURN_SEARCH_RESULTS observed-desc results must not carry a score",
            ));
        }
    }
    if has_agent_fields
        && decimal_u64(
            field(message, "totalMatchCount", kind.as_str())?,
            "TURN_SEARCH_RESULTS.totalMatchCount",
        )?
        .1 < results.len() as u64
    {
        return Err(invalid_frame(
            "TURN_SEARCH_RESULTS.totalMatchCount is inconsistent",
        ));
    }
    validate_evidence_path_report(field(message, "evidencePaths", kind.as_str())?)?;
    let diagnostic = field(message, "diagnostic", kind.as_str())?;
    validate_query_diagnostic(diagnostic)?;
    validate_search_trace(field(message, "searchTrace", kind.as_str())?)?;
    if field(
        diagnostic,
        "scoringTermCount",
        "TURN_SEARCH_RESULTS.diagnostic",
    )?
    .as_u64()
        != Some(terms.len() as u64)
    {
        return Err(invalid_frame(
            "TURN_SEARCH_RESULTS scoring term count is inconsistent",
        ));
    }
    Ok(())
}

fn validate_read_turn_evidence(message: &Value, kind: MessageKind) -> Result<(), ProtocolError> {
    validate_envelope(
        message,
        kind,
        &["turnKey", "expectedRevision", "cursor", "limit"],
    )?;
    hex64(
        field(message, "turnKey", kind.as_str())?,
        "READ_TURN_EVIDENCE.turnKey",
    )?;
    hex64(
        field(message, "expectedRevision", kind.as_str())?,
        "READ_TURN_EVIDENCE.expectedRevision",
    )?;
    let cursor = field(message, "cursor", kind.as_str())?;
    if !cursor.is_null() {
        bounded_string(
            cursor,
            "READ_TURN_EVIDENCE.cursor",
            MAX_CURSOR_BYTES,
            false,
            true,
        )?;
    }
    safe_integer_range(
        field(message, "limit", kind.as_str())?,
        "READ_TURN_EVIDENCE.limit",
        1,
        MAX_EVIDENCE_PAGE_ENTRIES,
    )?;
    Ok(())
}

fn validate_usage_window(value: &Value, label: &str) -> Result<(), ProtocolError> {
    exact_object_keys(
        value,
        label,
        &["observedAtOrAfterUnixMs", "observedBeforeUnixMs"],
    )?;
    let after = decimal_u64(
        field(value, "observedAtOrAfterUnixMs", label)?,
        &format!("{label}.observedAtOrAfterUnixMs"),
    )?
    .1;
    let before = decimal_u64(
        field(value, "observedBeforeUnixMs", label)?,
        &format!("{label}.observedBeforeUnixMs"),
    )?
    .1;
    if after >= before {
        return Err(invalid_frame(format!(
            "{label} must be a non-empty half-open window"
        )));
    }
    Ok(())
}

fn validate_aggregate_filters(
    value: &Value,
    label: &str,
    terminal_states: bool,
) -> Result<(), ProtocolError> {
    exact_object_keys(
        value,
        label,
        if terminal_states {
            &[
                "providers",
                "projectKeys",
                "closureStates",
                "capabilityTerminalStates",
            ]
        } else {
            &["providers", "projectKeys", "closureStates"]
        },
    )?;
    sorted_bounded_strings(
        field(value, "providers", label)?,
        &format!("{label}.providers"),
        MAX_FILTER_PROVIDERS,
        64,
        true,
    )?;
    let project_keys = field(value, "projectKeys", label)?
        .as_array()
        .filter(|values| values.len() <= MAX_FILTER_KEYS)
        .ok_or_else(|| invalid_frame(format!("{label}.projectKeys exceeds its bounded limit")))?;
    let mut previous = None;
    for (index, key) in project_keys.iter().enumerate() {
        let key = hex64(key, &format!("{label}.projectKeys[{index}]"))?;
        if previous.is_some_and(|value| value >= key) {
            return Err(invalid_frame(format!(
                "{label}.projectKeys must be sorted and contain unique values"
            )));
        }
        previous = Some(key);
    }
    let closure_states = sorted_bounded_strings(
        field(value, "closureStates", label)?,
        &format!("{label}.closureStates"),
        3,
        16,
        true,
    )?;
    if closure_states
        .iter()
        .any(|state| !["hard-sealed", "open", "quiescent"].contains(state))
    {
        return Err(invalid_frame(format!("{label}.closureStates is invalid")));
    }
    if terminal_states {
        let states = sorted_bounded_strings(
            field(value, "capabilityTerminalStates", label)?,
            &format!("{label}.capabilityTerminalStates"),
            5,
            16,
            true,
        )?;
        if states.iter().any(|state| {
            !["pending", "completed", "failed", "cancelled", "unknown"].contains(state)
        }) {
            return Err(invalid_frame(format!(
                "{label}.capabilityTerminalStates is invalid"
            )));
        }
    }
    Ok(())
}

fn validate_read_capability_usage(message: &Value, kind: MessageKind) -> Result<(), ProtocolError> {
    validate_envelope(
        message,
        kind,
        &[
            "kind",
            "window",
            "comparisonWindow",
            "filters",
            "orderBy",
            "cursor",
            "limit",
            "nowUnixMs",
            "quiescenceSeconds",
        ],
    )?;
    enum_string(
        field(message, "kind", kind.as_str())?,
        "READ_CAPABILITY_USAGE.kind",
        &["tool", "skill"],
    )?;
    validate_usage_window(
        field(message, "window", kind.as_str())?,
        "READ_CAPABILITY_USAGE.window",
    )?;
    let comparison = field(message, "comparisonWindow", kind.as_str())?;
    if !comparison.is_null() {
        validate_usage_window(comparison, "READ_CAPABILITY_USAGE.comparisonWindow")?;
    }
    validate_aggregate_filters(
        field(message, "filters", kind.as_str())?,
        "READ_CAPABILITY_USAGE.filters",
        true,
    )?;
    let order_by = enum_string(
        field(message, "orderBy", kind.as_str())?,
        "READ_CAPABILITY_USAGE.orderBy",
        &[
            "recorded-invocation-count",
            "recorded-failing-invocation-count",
            "distinct-turn-count",
            "distinct-session-count",
            "distinct-dedupe-group-count",
            "last-used",
            "absolute-recorded-invocation-change",
        ],
    )?;
    if order_by == "absolute-recorded-invocation-change" && comparison.is_null() {
        return Err(invalid_frame(
            "READ_CAPABILITY_USAGE comparisonWindow is required for absolute change",
        ));
    }
    let cursor = field(message, "cursor", kind.as_str())?;
    if !cursor.is_null() {
        bounded_string(
            cursor,
            "READ_CAPABILITY_USAGE.cursor",
            MAX_CURSOR_BYTES,
            false,
            true,
        )?;
    }
    safe_integer_range(
        field(message, "limit", kind.as_str())?,
        "READ_CAPABILITY_USAGE.limit",
        1,
        50,
    )?;
    decimal_u64(
        field(message, "nowUnixMs", kind.as_str())?,
        "READ_CAPABILITY_USAGE.nowUnixMs",
    )?;
    safe_integer_range(
        field(message, "quiescenceSeconds", kind.as_str())?,
        "READ_CAPABILITY_USAGE.quiescenceSeconds",
        60,
        86_400,
    )?;
    Ok(())
}

fn validate_read_insights_activity(
    message: &Value,
    kind: MessageKind,
) -> Result<(), ProtocolError> {
    validate_envelope(
        message,
        kind,
        &[
            "window",
            "filters",
            "bucket",
            "timeZone",
            "nowUnixMs",
            "quiescenceSeconds",
        ],
    )?;
    let window = field(message, "window", kind.as_str())?;
    exact_object_keys(
        window,
        "READ_INSIGHTS_ACTIVITY.window",
        &["observedAtOrAfter", "observedBefore"],
    )?;
    let (_, after) = canonical_timestamp_millis(
        field(window, "observedAtOrAfter", "READ_INSIGHTS_ACTIVITY.window")?,
        "READ_INSIGHTS_ACTIVITY.window.observedAtOrAfter",
    )?;
    let (_, before) = canonical_timestamp_millis(
        field(window, "observedBefore", "READ_INSIGHTS_ACTIVITY.window")?,
        "READ_INSIGHTS_ACTIVITY.window.observedBefore",
    )?;
    if after >= before {
        return Err(invalid_frame(
            "READ_INSIGHTS_ACTIVITY.window must be non-empty",
        ));
    }
    validate_aggregate_filters(
        field(message, "filters", kind.as_str())?,
        "READ_INSIGHTS_ACTIVITY.filters",
        false,
    )?;
    let bucket = enum_string(
        field(message, "bucket", kind.as_str())?,
        "READ_INSIGHTS_ACTIVITY.bucket",
        &["day", "week"],
    )?;
    if field(message, "timeZone", kind.as_str())?.as_str() != Some("UTC") {
        return Err(invalid_frame("READ_INSIGHTS_ACTIVITY.timeZone must be UTC"));
    }
    const DAY_MILLIS: i64 = 86_400_000;
    let bucket_millis = if bucket == "day" {
        DAY_MILLIS
    } else {
        7 * DAY_MILLIS
    };
    let after_day = after.div_euclid(DAY_MILLIS);
    let before_day = before.div_euclid(DAY_MILLIS);
    let aligned_week = bucket != "week"
        || ((after_day + 3).rem_euclid(7) == 0 && (before_day + 3).rem_euclid(7) == 0);
    let span = before - after;
    if after.rem_euclid(DAY_MILLIS) != 0
        || before.rem_euclid(DAY_MILLIS) != 0
        || !aligned_week
        || span % bucket_millis != 0
        || !(1..=366).contains(&(span / bucket_millis))
    {
        return Err(invalid_frame(
            "READ_INSIGHTS_ACTIVITY.window must contain 1..=366 complete UTC buckets",
        ));
    }
    decimal_u64(
        field(message, "nowUnixMs", kind.as_str())?,
        "READ_INSIGHTS_ACTIVITY.nowUnixMs",
    )?;
    safe_integer_range(
        field(message, "quiescenceSeconds", kind.as_str())?,
        "READ_INSIGHTS_ACTIVITY.quiescenceSeconds",
        60,
        86_400,
    )?;
    Ok(())
}

fn timestamp_digits(bytes: &[u8], start: usize, length: usize) -> Option<i64> {
    bytes
        .get(start..start + length)?
        .iter()
        .try_fold(0_i64, |value, byte| {
            byte.is_ascii_digit()
                .then_some(value * 10 + i64::from(*byte - b'0'))
        })
}

fn canonical_timestamp_millis<'a>(
    value: &'a Value,
    label: &str,
) -> Result<(&'a str, i64), ProtocolError> {
    let text = bounded_string(value, label, 24, false, true)?;
    let bytes = text.as_bytes();
    if bytes.len() != 24
        || bytes[4] != b'-'
        || bytes[7] != b'-'
        || bytes[10] != b'T'
        || bytes[13] != b':'
        || bytes[16] != b':'
        || bytes[19] != b'.'
        || bytes[23] != b'Z'
    {
        return Err(invalid_frame(format!(
            "{label} must be a canonical UTC timestamp"
        )));
    }
    let year = timestamp_digits(bytes, 0, 4);
    let month = timestamp_digits(bytes, 5, 2);
    let day = timestamp_digits(bytes, 8, 2);
    let hour = timestamp_digits(bytes, 11, 2);
    let minute = timestamp_digits(bytes, 14, 2);
    let second = timestamp_digits(bytes, 17, 2);
    let millis = timestamp_digits(bytes, 20, 3);
    let (Some(year), Some(month), Some(day), Some(hour), Some(minute), Some(second), Some(millis)) =
        (year, month, day, hour, minute, second, millis)
    else {
        return Err(invalid_frame(format!(
            "{label} must be a canonical UTC timestamp"
        )));
    };
    let leap = year % 4 == 0 && (year % 100 != 0 || year % 400 == 0);
    let days_in_month = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => 0,
    };
    if day < 1 || day > days_in_month || hour > 23 || minute > 59 || second > 59 || millis > 999 {
        return Err(invalid_frame(format!(
            "{label} must be a canonical UTC timestamp"
        )));
    }
    let adjusted_year = year - if month <= 2 { 1 } else { 0 };
    let era = adjusted_year.div_euclid(400);
    let year_of_era = adjusted_year - era * 400;
    let adjusted_month = month + if month > 2 { -3 } else { 9 };
    let day_of_year = (153 * adjusted_month + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    let epoch_days = era * 146_097 + day_of_era - 719_468;
    let timestamp = (((epoch_days * 24 + hour) * 60 + minute) * 60 + second) * 1_000 + millis;
    Ok((text, timestamp))
}

fn signed_decimal(value: &Value, label: &str) -> Result<i128, ProtocolError> {
    let text = value.as_str().ok_or_else(|| {
        invalid_frame(format!("{label} must be a canonical signed decimal string"))
    })?;
    let digits = text.strip_prefix('-').unwrap_or(text);
    if digits.is_empty()
        || (digits.len() > 1 && digits.starts_with('0'))
        || !digits.bytes().all(|byte| byte.is_ascii_digit())
        || text == "-0"
    {
        return Err(invalid_frame(format!(
            "{label} must be a canonical signed decimal string"
        )));
    }
    let number = text
        .parse::<i128>()
        .map_err(|_| invalid_frame(format!("{label} must be a canonical signed decimal string")))?;
    let limit = i128::from(u64::MAX);
    if number < -limit || number > limit {
        return Err(invalid_frame(format!(
            "{label} is outside the supported signed count range"
        )));
    }
    Ok(number)
}

fn validate_query_coverage(
    value: &Value,
    label: &str,
    fully_excluded: bool,
) -> Result<(), ProtocolError> {
    let mut fields = vec![
        "excludedUndatedInvocationCount",
        "excludedUndatedTurnCount",
        "excludedUnrevisionedInvocationCount",
        "excludedUnrevisionedTurnCount",
    ];
    if fully_excluded {
        fields.push("fullyExcludedCapabilityCount");
    }
    decimal_object(value, label, &fields)?;
    Ok(())
}

fn validate_dedupe_support(
    value: &Value,
    label: &str,
    methods: bool,
) -> Result<[u64; 5], ProtocolError> {
    let mut fields = vec![
        "distinctDedupeGroupCount",
        "strongDedupeGroupCount",
        "weakDedupeGroupCount",
        "observedEofProvisionalGroupCount",
        "unknownDedupeSessionCount",
    ];
    if methods {
        fields.push("sessionDuplicateMethodCounts");
    }
    exact_object_keys(value, label, &fields)?;
    let counts = decimal_fields(value, label, &fields[..5])?;
    let counts: [u64; 5] = counts.try_into().expect("fixed dedupe support count set");
    if counts[1].checked_add(counts[2]) != Some(counts[0]) || counts[3] > counts[0] {
        return Err(invalid_frame(format!(
            "{label} dedupe group counts are inconsistent"
        )));
    }
    if methods {
        decimal_object(
            field(value, "sessionDuplicateMethodCounts", label)?,
            &format!("{label}.sessionDuplicateMethodCounts"),
            &["explicitLineage", "exactFirstTurnPrefix"],
        )?;
    }
    Ok(counts)
}

fn validate_usage_item(item: &Value, index: usize) -> Result<(), ProtocolError> {
    let label = format!("CAPABILITY_USAGE.items[{index}]");
    exact_object_keys(
        item,
        &label,
        &[
            "capabilityKey",
            "provider",
            "kind",
            "canonicalName",
            "recordedInvocationCount",
            "recordedFailingInvocationCount",
            "distinctTurnCount",
            "distinctSessionCount",
            "lastUsedAt",
            "invocationTerminalCounts",
            "containingTurnOutcomeCounts",
            "groupedInvocationCount",
            "ungroupedInvocationCount",
            "support",
            "strengthCounts",
            "outOfWindow",
            "comparison",
        ],
    )?;
    hex64(
        field(item, "capabilityKey", &label)?,
        &format!("{label}.capabilityKey"),
    )?;
    bounded_string(
        field(item, "provider", &label)?,
        &format!("{label}.provider"),
        128,
        false,
        true,
    )?;
    enum_string(
        field(item, "kind", &label)?,
        &format!("{label}.kind"),
        &["tool", "skill"],
    )?;
    bounded_string(
        field(item, "canonicalName", &label)?,
        &format!("{label}.canonicalName"),
        512,
        false,
        false,
    )?;
    let counts = decimal_fields(
        item,
        &label,
        &[
            "recordedInvocationCount",
            "recordedFailingInvocationCount",
            "distinctTurnCount",
            "distinctSessionCount",
            "groupedInvocationCount",
            "ungroupedInvocationCount",
        ],
    )?;
    let [invocations, failing, turns, sessions, grouped, ungrouped] = counts.as_slice() else {
        unreachable!("fixed Usage count set")
    };
    let last_used = field(item, "lastUsedAt", &label)?;
    if !last_used.is_null() {
        canonical_timestamp_millis(last_used, &format!("{label}.lastUsedAt"))?;
    }
    let terminal = decimal_object(
        field(item, "invocationTerminalCounts", &label)?,
        &format!("{label}.invocationTerminalCounts"),
        &[
            "invocationTotal",
            "pending",
            "completed",
            "failed",
            "cancelled",
            "unknown",
        ],
    )?;
    let outcomes = decimal_object(
        field(item, "containingTurnOutcomeCounts", &label)?,
        &format!("{label}.containingTurnOutcomeCounts"),
        &[
            "distinctTurnTotal",
            "providerCompleted",
            "abandoned",
            "unknown",
        ],
    )?;
    let support_value = field(item, "support", &label)?;
    let support = validate_dedupe_support(support_value, &format!("{label}.support"), true)?;
    let strength = decimal_object(
        field(item, "strengthCounts", &label)?,
        &format!("{label}.strengthCounts"),
        &["observed", "confirmed", "inferred"],
    )?;
    let methods = decimal_object(
        field(
            support_value,
            "sessionDuplicateMethodCounts",
            &format!("{label}.support"),
        )?,
        &format!("{label}.support.sessionDuplicateMethodCounts"),
        &["explicitLineage", "exactFirstTurnPrefix"],
    )?;
    if failing > invocations
        || turns > invocations
        || sessions > turns
        || grouped.checked_add(*ungrouped) != Some(*invocations)
        || terminal[0] != *invocations
        || checked_sum(&terminal[1..], &format!("{label}.invocationTerminalCounts"))?
            != *invocations
        || outcomes[0] != *turns
        || checked_sum(
            &outcomes[1..],
            &format!("{label}.containingTurnOutcomeCounts"),
        )? != *turns
        || checked_sum(&strength, &format!("{label}.strengthCounts"))? != *invocations
        || support[0] > *sessions
        || support[4] > *sessions
        || checked_sum(
            &methods,
            &format!("{label}.support.sessionDuplicateMethodCounts"),
        )? > *sessions
    {
        return Err(invalid_frame(format!(
            "{label} aggregate counts are inconsistent"
        )));
    }
    let out_of_window = field(item, "outOfWindow", &label)?;
    exact_object_keys(
        out_of_window,
        &format!("{label}.outOfWindow"),
        &["scope", "retrySummary"],
    )?;
    if field(out_of_window, "scope", &format!("{label}.outOfWindow"))?.as_str()
        != Some("all-indexed-history")
    {
        return Err(invalid_frame(format!(
            "{label}.outOfWindow.scope is invalid"
        )));
    }
    let retry = field(
        out_of_window,
        "retrySummary",
        &format!("{label}.outOfWindow"),
    )?;
    if !retry.is_null() {
        decimal_object(
            retry,
            &format!("{label}.outOfWindow.retrySummary"),
            &[
                "failedCount",
                "sameInputRepeatCount",
                "retryAfterFailureCount",
            ],
        )?;
    }
    let comparison = field(item, "comparison", &label)?;
    if !comparison.is_null() {
        exact_object_keys(
            comparison,
            &format!("{label}.comparison"),
            &[
                "baselineRecordedInvocationCount",
                "currentRecordedInvocationCount",
                "absoluteRecordedInvocationChange",
            ],
        )?;
        let baseline = decimal_u64(
            field(
                comparison,
                "baselineRecordedInvocationCount",
                &format!("{label}.comparison"),
            )?,
            &format!("{label}.comparison.baselineRecordedInvocationCount"),
        )?
        .1;
        let current = decimal_u64(
            field(
                comparison,
                "currentRecordedInvocationCount",
                &format!("{label}.comparison"),
            )?,
            &format!("{label}.comparison.currentRecordedInvocationCount"),
        )?
        .1;
        let change = signed_decimal(
            field(
                comparison,
                "absoluteRecordedInvocationChange",
                &format!("{label}.comparison"),
            )?,
            &format!("{label}.comparison.absoluteRecordedInvocationChange"),
        )?;
        if current != *invocations || i128::from(current) - i128::from(baseline) != change {
            return Err(invalid_frame(format!("{label}.comparison is inconsistent")));
        }
    }
    Ok(())
}

fn validate_capability_usage(message: &Value, kind: MessageKind) -> Result<(), ProtocolError> {
    validate_envelope(
        message,
        kind,
        &[
            "databaseUuid",
            "snapshotSeq",
            "closureEvaluatedAt",
            "quiescenceSeconds",
            "orderBy",
            "items",
            "totalCandidateCount",
            "truncated",
            "coverage",
            "nextCursor",
        ],
    )?;
    uuid(
        field(message, "databaseUuid", kind.as_str())?,
        "CAPABILITY_USAGE.databaseUuid",
    )?;
    decimal_u64(
        field(message, "snapshotSeq", kind.as_str())?,
        "CAPABILITY_USAGE.snapshotSeq",
    )?;
    canonical_timestamp_millis(
        field(message, "closureEvaluatedAt", kind.as_str())?,
        "CAPABILITY_USAGE.closureEvaluatedAt",
    )?;
    safe_integer_range(
        field(message, "quiescenceSeconds", kind.as_str())?,
        "CAPABILITY_USAGE.quiescenceSeconds",
        60,
        86_400,
    )?;
    enum_string(
        field(message, "orderBy", kind.as_str())?,
        "CAPABILITY_USAGE.orderBy",
        &[
            "recorded-invocation-count",
            "recorded-failing-invocation-count",
            "distinct-turn-count",
            "distinct-session-count",
            "distinct-dedupe-group-count",
            "last-used",
            "absolute-recorded-invocation-change",
        ],
    )?;
    let items = field(message, "items", kind.as_str())?
        .as_array()
        .filter(|items| items.len() <= 50)
        .ok_or_else(|| invalid_frame("CAPABILITY_USAGE.items exceeds its bounded limit"))?;
    for (index, item) in items.iter().enumerate() {
        validate_usage_item(item, index)?;
    }
    let total = decimal_u64(
        field(message, "totalCandidateCount", kind.as_str())?,
        "CAPABILITY_USAGE.totalCandidateCount",
    )?
    .1;
    if total < items.len() as u64 {
        return Err(invalid_frame(
            "CAPABILITY_USAGE.totalCandidateCount is inconsistent",
        ));
    }
    let truncated = boolean(
        field(message, "truncated", kind.as_str())?,
        "CAPABILITY_USAGE.truncated",
    )?;
    let cursor = field(message, "nextCursor", kind.as_str())?;
    if !cursor.is_null() {
        bounded_string(
            cursor,
            "CAPABILITY_USAGE.nextCursor",
            MAX_CURSOR_BYTES,
            false,
            true,
        )?;
    }
    if truncated == cursor.is_null() {
        return Err(invalid_frame(
            "CAPABILITY_USAGE cursor and truncation state are inconsistent",
        ));
    }
    validate_query_coverage(
        field(message, "coverage", kind.as_str())?,
        "CAPABILITY_USAGE.coverage",
        true,
    )?;
    Ok(())
}

fn validate_activity_bucket(
    row: &Value,
    index: usize,
    previous_end: Option<i64>,
) -> Result<(i64, i64), ProtocolError> {
    let label = format!("INSIGHTS_ACTIVITY.buckets[{index}]");
    exact_object_keys(
        row,
        &label,
        &[
            "bucketStart",
            "bucketEnd",
            "distinctSessionCount",
            "distinctTurnCount",
            "currentClosureCounts",
            "turnResultEvidenceCounts",
            "recordedToolInvocationCount",
            "recordedSkillInvocationCount",
            "support",
        ],
    )?;
    let start = canonical_timestamp_millis(
        field(row, "bucketStart", &label)?,
        &format!("{label}.bucketStart"),
    )?
    .1;
    let end = canonical_timestamp_millis(
        field(row, "bucketEnd", &label)?,
        &format!("{label}.bucketEnd"),
    )?
    .1;
    if start >= end || previous_end.is_some_and(|previous| previous != start) {
        return Err(invalid_frame(format!(
            "{label} bucket boundaries are inconsistent"
        )));
    }
    let duration = end - start;
    if !matches!(duration, 86_400_000 | 604_800_000) {
        return Err(invalid_frame(format!(
            "{label} must be one complete UTC day or week"
        )));
    }
    let counts = decimal_fields(
        row,
        &label,
        &[
            "distinctSessionCount",
            "distinctTurnCount",
            "recordedToolInvocationCount",
            "recordedSkillInvocationCount",
        ],
    )?;
    let sessions = counts[0];
    let turns = counts[1];
    let closure = decimal_object(
        field(row, "currentClosureCounts", &label)?,
        &format!("{label}.currentClosureCounts"),
        &["hardSealed", "quiescent", "open"],
    )?;
    let outcomes = decimal_object(
        field(row, "turnResultEvidenceCounts", &label)?,
        &format!("{label}.turnResultEvidenceCounts"),
        &["providerCompleted", "abandoned", "unknown"],
    )?;
    let support = validate_dedupe_support(
        field(row, "support", &label)?,
        &format!("{label}.support"),
        false,
    )?;
    if sessions > turns
        || checked_sum(&closure, &format!("{label}.currentClosureCounts"))? != turns
        || checked_sum(&outcomes, &format!("{label}.turnResultEvidenceCounts"))? != turns
        || support[0] > sessions
        || support[4] > sessions
    {
        return Err(invalid_frame(format!(
            "{label} aggregate counts are inconsistent"
        )));
    }
    Ok((end, duration))
}

fn validate_insights_activity(message: &Value, kind: MessageKind) -> Result<(), ProtocolError> {
    validate_envelope(
        message,
        kind,
        &[
            "databaseUuid",
            "snapshotSeq",
            "closureEvaluatedAt",
            "quiescenceSeconds",
            "buckets",
            "coverage",
        ],
    )?;
    uuid(
        field(message, "databaseUuid", kind.as_str())?,
        "INSIGHTS_ACTIVITY.databaseUuid",
    )?;
    decimal_u64(
        field(message, "snapshotSeq", kind.as_str())?,
        "INSIGHTS_ACTIVITY.snapshotSeq",
    )?;
    canonical_timestamp_millis(
        field(message, "closureEvaluatedAt", kind.as_str())?,
        "INSIGHTS_ACTIVITY.closureEvaluatedAt",
    )?;
    safe_integer_range(
        field(message, "quiescenceSeconds", kind.as_str())?,
        "INSIGHTS_ACTIVITY.quiescenceSeconds",
        60,
        86_400,
    )?;
    let buckets = field(message, "buckets", kind.as_str())?
        .as_array()
        .filter(|buckets| !buckets.is_empty() && buckets.len() <= 366)
        .ok_or_else(|| invalid_frame("INSIGHTS_ACTIVITY.buckets must contain 1..=366 rows"))?;
    let mut previous_end = None;
    let mut duration = None;
    for (index, bucket) in buckets.iter().enumerate() {
        let (end, current_duration) = validate_activity_bucket(bucket, index, previous_end)?;
        if duration.is_some_and(|expected| expected != current_duration) {
            return Err(invalid_frame(
                "INSIGHTS_ACTIVITY bucket durations must be consistent",
            ));
        }
        previous_end = Some(end);
        duration = Some(current_duration);
    }
    validate_query_coverage(
        field(message, "coverage", kind.as_str())?,
        "INSIGHTS_ACTIVITY.coverage",
        false,
    )?;
    Ok(())
}

fn validate_evidence_turn(value: &Value) -> Result<(), ProtocolError> {
    let label = "TURN_EVIDENCE_PAGE.turn";
    exact_object_keys(
        value,
        label,
        &[
            "turnKey",
            "revision",
            "problemText",
            "finalAnswerExcerpt",
            "observedTimestamp",
            "nextUserBoundary",
            "providerTerminal",
            "observedEofClosed",
            "providerVisibility",
            "factTruncation",
        ],
    )?;
    hex64(field(value, "turnKey", label)?, &format!("{label}.turnKey"))?;
    nullable_hex64(
        field(value, "revision", label)?,
        &format!("{label}.revision"),
    )?;
    bounded_string(
        field(value, "problemText", label)?,
        &format!("{label}.problemText"),
        MAX_TURN_PROBLEM_BYTES,
        true,
        false,
    )?;
    let answer = field(value, "finalAnswerExcerpt", label)?;
    if !answer.is_null() {
        bounded_string(
            answer,
            &format!("{label}.finalAnswerExcerpt"),
            MAX_TURN_ANSWER_BYTES,
            true,
            false,
        )?;
    }
    nullable_timestamp(
        field(value, "observedTimestamp", label)?,
        &format!("{label}.observedTimestamp"),
    )?;
    boolean(
        field(value, "nextUserBoundary", label)?,
        &format!("{label}.nextUserBoundary"),
    )?;
    let terminal = field(value, "providerTerminal", label)?;
    if !terminal.is_null() {
        enum_string(
            terminal,
            &format!("{label}.providerTerminal"),
            &["aborted", "completed"],
        )?;
    }
    boolean(
        field(value, "observedEofClosed", label)?,
        &format!("{label}.observedEofClosed"),
    )?;
    enum_string(
        field(value, "providerVisibility", label)?,
        &format!("{label}.providerVisibility"),
        &["active"],
    )?;
    sorted_bounded_strings(
        field(value, "factTruncation", label)?,
        &format!("{label}.factTruncation"),
        64,
        128,
        true,
    )?;
    Ok(())
}

fn validate_nullable_digest_fields(
    value: &Value,
    label: &str,
    names: &[&str],
) -> Result<(), ProtocolError> {
    for name in names {
        nullable_hex64(field(value, name, label)?, &format!("{label}.{name}"))?;
    }
    Ok(())
}

fn validate_event_payload(value: &Value, label: &str) -> Result<(), ProtocolError> {
    let kind = field(value, "kind", label)?
        .as_str()
        .ok_or_else(|| invalid_frame(format!("{label}.kind is invalid")))?;
    match kind {
        "visible-message" => {
            exact_object_keys(value, label, &["kind", "role"])?;
            bounded_string(
                field(value, "role", label)?,
                &format!("{label}.role"),
                128,
                false,
                true,
            )?;
        }
        "capability-invocation" => {
            exact_object_keys(
                value,
                label,
                &[
                    "kind",
                    "capabilityKey",
                    "correlationDigest",
                    "inputFingerprint",
                ],
            )?;
            hex64(
                field(value, "capabilityKey", label)?,
                &format!("{label}.capabilityKey"),
            )?;
            validate_nullable_digest_fields(
                value,
                label,
                &["correlationDigest", "inputFingerprint"],
            )?;
        }
        "capability-result" => {
            exact_object_keys(
                value,
                label,
                &[
                    "kind",
                    "correlationDigest",
                    "providerState",
                    "exitCode",
                    "outputBytes",
                    "durationMs",
                ],
            )?;
            validate_nullable_digest_fields(value, label, &["correlationDigest"])?;
            bounded_string(
                field(value, "providerState", label)?,
                &format!("{label}.providerState"),
                128,
                false,
                true,
            )?;
            for name in ["exitCode", "outputBytes", "durationMs"] {
                let item = field(value, name, label)?;
                if !item.is_null() {
                    decimal_u64(item, &format!("{label}.{name}"))?;
                }
            }
        }
        "skill-catalog-entry" => {
            exact_object_keys(value, label, &["kind", "capabilityKey", "pathFingerprint"])?;
            hex64(
                field(value, "capabilityKey", label)?,
                &format!("{label}.capabilityKey"),
            )?;
            nullable_hex64(
                field(value, "pathFingerprint", label)?,
                &format!("{label}.pathFingerprint"),
            )?;
        }
        "skill-load" => {
            exact_object_keys(
                value,
                label,
                &["kind", "capabilityKey", "strength", "evidenceSource"],
            )?;
            hex64(
                field(value, "capabilityKey", label)?,
                &format!("{label}.capabilityKey"),
            )?;
            for name in ["strength", "evidenceSource"] {
                bounded_string(
                    field(value, name, label)?,
                    &format!("{label}.{name}"),
                    128,
                    false,
                    true,
                )?;
            }
        }
        "turn-lifecycle" => {
            exact_object_keys(
                value,
                label,
                &["kind", "lifecycleState", "providerTurnDigest"],
            )?;
            bounded_string(
                field(value, "lifecycleState", label)?,
                &format!("{label}.lifecycleState"),
                128,
                false,
                true,
            )?;
            nullable_hex64(
                field(value, "providerTurnDigest", label)?,
                &format!("{label}.providerTurnDigest"),
            )?;
        }
        "provider-status" => {
            exact_object_keys(
                value,
                label,
                &["kind", "statusKind", "providerState", "rolledBackTurnCount"],
            )?;
            for name in ["statusKind", "providerState"] {
                bounded_string(
                    field(value, name, label)?,
                    &format!("{label}.{name}"),
                    128,
                    false,
                    true,
                )?;
            }
            let count = field(value, "rolledBackTurnCount", label)?;
            if !count.is_null() {
                decimal_u64(count, &format!("{label}.rolledBackTurnCount"))?;
            }
        }
        _ => return Err(invalid_frame(format!("{label}.kind is invalid"))),
    }
    Ok(())
}

fn validate_evidence_event(value: &Value, label: &str) -> Result<(), ProtocolError> {
    exact_object_keys(
        value,
        label,
        &[
            "eventKey",
            "occurredTurnKey",
            "linkedTurns",
            "pointerKind",
            "pointerContentIndex",
            "pointerEventOrdinal",
            "originScope",
            "observedTimestamp",
            "payload",
        ],
    )?;
    hex64(
        field(value, "eventKey", label)?,
        &format!("{label}.eventKey"),
    )?;
    nullable_hex64(
        field(value, "occurredTurnKey", label)?,
        &format!("{label}.occurredTurnKey"),
    )?;
    let linked = field(value, "linkedTurns", label)?
        .as_array()
        .filter(|values| values.len() <= 512)
        .ok_or_else(|| invalid_frame(format!("{label}.linkedTurns exceeds its bounded limit")))?;
    for (index, link) in linked.iter().enumerate() {
        let link_label = format!("{label}.linkedTurns[{index}]");
        exact_object_keys(link, &link_label, &["turnKey", "role"])?;
        hex64(
            field(link, "turnKey", &link_label)?,
            &format!("{link_label}.turnKey"),
        )?;
        bounded_string(
            field(link, "role", &link_label)?,
            &format!("{link_label}.role"),
            64,
            false,
            true,
        )?;
    }
    bounded_string(
        field(value, "pointerKind", label)?,
        &format!("{label}.pointerKind"),
        128,
        false,
        true,
    )?;
    let content_index = field(value, "pointerContentIndex", label)?
        .as_i64()
        .filter(|number| i32::try_from(*number).is_ok())
        .ok_or_else(|| invalid_frame(format!("{label}.pointerContentIndex is invalid")))?;
    let _ = content_index;
    safe_integer_range(
        field(value, "pointerEventOrdinal", label)?,
        &format!("{label}.pointerEventOrdinal"),
        0,
        u16::MAX.into(),
    )?;
    enum_string(
        field(value, "originScope", label)?,
        &format!("{label}.originScope"),
        &["main", "subagent", "unknown"],
    )?;
    nullable_timestamp(
        field(value, "observedTimestamp", label)?,
        &format!("{label}.observedTimestamp"),
    )?;
    validate_event_payload(field(value, "payload", label)?, &format!("{label}.payload"))?;
    Ok(())
}

fn validate_use_evidence(value: &Value, label: &str) -> Result<(), ProtocolError> {
    exact_object_keys(value, label, &["eventKey", "role"])?;
    hex64(
        field(value, "eventKey", label)?,
        &format!("{label}.eventKey"),
    )?;
    enum_string(
        field(value, "role", label)?,
        &format!("{label}.role"),
        &["corroboration", "invocation", "result"],
    )?;
    Ok(())
}

fn validate_capability_use(value: &Value, label: &str) -> Result<(), ProtocolError> {
    exact_object_keys(
        value,
        label,
        &[
            "useKey",
            "capabilityKey",
            "provider",
            "capabilityKind",
            "canonicalName",
            "turnOrdinal",
            "exactObservedName",
            "originScope",
            "originFingerprint",
            "inputFingerprint",
            "providerTerminalState",
            "strength",
            "correlationDigest",
            "evidence",
        ],
    )?;
    for name in ["useKey", "capabilityKey"] {
        hex64(field(value, name, label)?, &format!("{label}.{name}"))?;
    }
    bounded_string(
        field(value, "provider", label)?,
        &format!("{label}.provider"),
        64,
        false,
        true,
    )?;
    enum_string(
        field(value, "capabilityKind", label)?,
        &format!("{label}.capabilityKind"),
        &["skill", "tool"],
    )?;
    bounded_string(
        field(value, "canonicalName", label)?,
        &format!("{label}.canonicalName"),
        512,
        false,
        false,
    )?;
    decimal_u64(
        field(value, "turnOrdinal", label)?,
        &format!("{label}.turnOrdinal"),
    )?;
    bounded_string(
        field(value, "exactObservedName", label)?,
        &format!("{label}.exactObservedName"),
        512,
        true,
        false,
    )?;
    enum_string(
        field(value, "originScope", label)?,
        &format!("{label}.originScope"),
        &["main", "subagent", "unknown"],
    )?;
    validate_nullable_digest_fields(
        value,
        label,
        &["originFingerprint", "inputFingerprint", "correlationDigest"],
    )?;
    enum_string(
        field(value, "providerTerminalState", label)?,
        &format!("{label}.providerTerminalState"),
        &["cancelled", "completed", "failed", "pending", "unknown"],
    )?;
    enum_string(
        field(value, "strength", label)?,
        &format!("{label}.strength"),
        &["confirmed", "inferred", "observed"],
    )?;
    let evidence = field(value, "evidence", label)?
        .as_array()
        .filter(|values| values.len() <= 512)
        .ok_or_else(|| invalid_frame(format!("{label}.evidence exceeds its bounded limit")))?;
    for (index, link) in evidence.iter().enumerate() {
        validate_use_evidence(link, &format!("{label}.evidence[{index}]"))?;
    }
    Ok(())
}

fn validate_evidence_entry(value: &Value, index: usize) -> Result<(), ProtocolError> {
    let label = format!("TURN_EVIDENCE_PAGE.entries[{index}]");
    exact_object_keys(value, &label, &["factKind", "fact"])?;
    match field(value, "factKind", &label)?.as_str() {
        Some("event") => {
            validate_evidence_event(field(value, "fact", &label)?, &format!("{label}.fact"))
        }
        Some("capability-use") => {
            validate_capability_use(field(value, "fact", &label)?, &format!("{label}.fact"))
        }
        _ => Err(invalid_frame(format!("{label}.factKind is invalid"))),
    }
}

fn validate_turn_evidence_page(message: &Value, kind: MessageKind) -> Result<(), ProtocolError> {
    let has_database_uuid = message
        .as_object()
        .is_some_and(|message| message.contains_key("databaseUuid"));
    validate_envelope(
        message,
        kind,
        if has_database_uuid {
            &[
                "snapshotSeq",
                "turn",
                "entries",
                "nextCursor",
                "databaseUuid",
            ]
        } else {
            &["snapshotSeq", "turn", "entries", "nextCursor"]
        },
    )?;
    if has_database_uuid {
        uuid(
            field(message, "databaseUuid", kind.as_str())?,
            "TURN_EVIDENCE_PAGE.databaseUuid",
        )?;
    }
    decimal_u64(
        field(message, "snapshotSeq", kind.as_str())?,
        "TURN_EVIDENCE_PAGE.snapshotSeq",
    )?;
    validate_evidence_turn(field(message, "turn", kind.as_str())?)?;
    let entries = field(message, "entries", kind.as_str())?
        .as_array()
        .filter(|values| values.len() <= MAX_EVIDENCE_PAGE_ENTRIES as usize)
        .ok_or_else(|| invalid_frame("TURN_EVIDENCE_PAGE.entries exceeds its bounded limit"))?;
    for (index, entry) in entries.iter().enumerate() {
        validate_evidence_entry(entry, index)?;
    }
    let cursor = field(message, "nextCursor", kind.as_str())?;
    if !cursor.is_null() {
        bounded_string(
            cursor,
            "TURN_EVIDENCE_PAGE.nextCursor",
            MAX_CURSOR_BYTES,
            false,
            true,
        )?;
    }
    Ok(())
}

pub fn validate_protocol_message(message: &Value) -> Result<MessageKind, ProtocolError> {
    let root = object(message, "protocol message")?;
    if root.get("format").and_then(Value::as_str) != Some(PROTOCOL_FORMAT) {
        return Err(ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_UNSUPPORTED_VERSION",
            "unsupported Insights protocol version",
            false,
        ));
    }
    let type_name = root.get("type").and_then(Value::as_str).ok_or_else(|| {
        ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
            "unexpected protocol message",
            false,
        )
    })?;
    let kind = match type_name {
        "HELLO" => MessageKind::Hello,
        "READY" => MessageKind::Ready,
        "BEGIN_SESSION" => MessageKind::BeginSession,
        "SESSION_ACCEPTED" => MessageKind::SessionAccepted,
        "RETRACT_FACTS" => MessageKind::RetractFacts,
        "UPSERT_FACTS" => MessageKind::UpsertFacts,
        "BATCH_ACCEPTED" => MessageKind::BatchAccepted,
        "COMMIT_SESSION" => MessageKind::CommitSession,
        "SESSION_COMMITTED" => MessageKind::SessionCommitted,
        "BEGIN_TRACE_SOURCE" => MessageKind::BeginTraceSource,
        "TRACE_SOURCE_ACCEPTED" => MessageKind::TraceSourceAccepted,
        "TRACE_SOURCE_BATCH" => MessageKind::TraceSourceBatch,
        "TRACE_SOURCE_BATCH_ACCEPTED" => MessageKind::TraceSourceBatchAccepted,
        "COMMIT_TRACE_SOURCE" => MessageKind::CommitTraceSource,
        "TRACE_SOURCE_COMMITTED" => MessageKind::TraceSourceCommitted,
        "READ_REPOSITORY_STATE" => MessageKind::ReadRepositoryState,
        "REPOSITORY_STATE" => MessageKind::RepositoryState,
        "LIST_SOURCE_STATES" => MessageKind::ListSourceStates,
        "SOURCE_STATES" => MessageKind::SourceStates,
        "READ_SOURCE_CHECKPOINT" => MessageKind::ReadSourceCheckpoint,
        "SOURCE_CHECKPOINT" => MessageKind::SourceCheckpoint,
        "REMOVE_SOURCE" => MessageKind::RemoveSource,
        "SOURCE_REMOVED" => MessageKind::SourceRemoved,
        "EXCLUDE_SOURCE" => MessageKind::ExcludeSource,
        "SOURCE_EXCLUDED" => MessageKind::SourceExcluded,
        "READ_PURGE_STATUS" => MessageKind::ReadPurgeStatus,
        "PURGE_STATUS" => MessageKind::PurgeStatus,
        "RUN_PURGE_MAINTENANCE" => MessageKind::RunPurgeMaintenance,
        "PURGE_MAINTENANCE_STATUS" => MessageKind::PurgeMaintenanceStatus,
        "READ_ENGINE_STATUS" => MessageKind::ReadEngineStatus,
        "ENGINE_STATUS" => MessageKind::EngineStatus,
        "READ_INSIGHTS_OVERVIEW" => MessageKind::ReadInsightsOverview,
        "INSIGHTS_OVERVIEW" => MessageKind::InsightsOverview,
        "LIST_CAPABILITIES" => MessageKind::ListCapabilities,
        "CAPABILITY_PAGE" => MessageKind::CapabilityPage,
        "SEARCH_TURNS" => MessageKind::SearchTurns,
        "TURN_SEARCH_RESULTS" => MessageKind::TurnSearchResults,
        "READ_CAPABILITY_USAGE" => MessageKind::ReadCapabilityUsage,
        "CAPABILITY_USAGE" => MessageKind::CapabilityUsage,
        "READ_INSIGHTS_ACTIVITY" => MessageKind::ReadInsightsActivity,
        "INSIGHTS_ACTIVITY" => MessageKind::InsightsActivity,
        "READ_TURN_EVIDENCE" => MessageKind::ReadTurnEvidence,
        "TURN_EVIDENCE_PAGE" => MessageKind::TurnEvidencePage,
        "READ_INSIGHTS_QUERY_V2" => MessageKind::ReadInsightsQueryV2,
        "INSIGHTS_QUERY_V2" => MessageKind::InsightsQueryV2,
        "READ_INSIGHTS_EVIDENCE_V2" => MessageKind::ReadInsightsEvidenceV2,
        "INSIGHTS_EVIDENCE_V2" => MessageKind::InsightsEvidenceV2,
        "READ_INSIGHTS_RECIPE" => MessageKind::ReadInsightsRecipe,
        "INSIGHTS_RECIPE" => MessageKind::InsightsRecipe,
        "READ_INSIGHTS_DELIVERY_TRACE" => MessageKind::ReadInsightsDeliveryTrace,
        "INSIGHTS_DELIVERY_TRACE" => MessageKind::InsightsDeliveryTrace,
        "MEMORY_COMMAND" => MessageKind::MemoryCommand,
        "MEMORY_RESULT" => MessageKind::MemoryResult,
        "ABORT_SESSION" => MessageKind::AbortSession,
        "SESSION_ABORTED" => MessageKind::SessionAborted,
        "ABORT_TRACE_SOURCE" => MessageKind::AbortTraceSource,
        "TRACE_SOURCE_ABORTED" => MessageKind::TraceSourceAborted,
        "ERROR" => MessageKind::Error,
        _ => {
            return Err(ProtocolError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                format!("unexpected protocol message {type_name}"),
                false,
            ));
        }
    };

    match kind {
        MessageKind::Hello => {
            validate_envelope(
                message,
                kind,
                &["clientVersion", "maxFrameBytes", "requiredContract"],
            )?;
            non_empty_string(
                field(message, "clientVersion", "HELLO")?,
                "HELLO.clientVersion",
            )?;
            if field(message, "maxFrameBytes", "HELLO")?.as_u64() != Some(MAX_FRAME_BYTES as u64) {
                return Err(unsupported_contract(format!(
                    "HELLO.maxFrameBytes must be {MAX_FRAME_BYTES}"
                )));
            }
            validate_handshake_contract(
                field(message, "requiredContract", "HELLO")?,
                "HELLO.requiredContract",
            )?;
        }
        MessageKind::Ready => {
            let v2 = message["acceptedContract"]["factSchemaVersion"].as_u64() == Some(2);
            let mut fields = vec![
                "engineVersion",
                "target",
                "maxFrameBytes",
                "sqliteVersion",
                "sqliteCompileOptionsDigest",
                "buildManifestDigest",
                "acceptedContract",
            ];
            if v2 {
                fields.extend(["databaseUuid", "databaseFactSchemaVersion"]);
            }
            validate_envelope(message, kind, &fields)?;
            non_empty_string(
                field(message, "engineVersion", "READY")?,
                "READY.engineVersion",
            )?;
            non_empty_string(field(message, "target", "READY")?, "READY.target")?;
            if field(message, "maxFrameBytes", "READY")?.as_u64() != Some(MAX_FRAME_BYTES as u64) {
                return Err(unsupported_contract(format!(
                    "READY.maxFrameBytes must be {MAX_FRAME_BYTES}"
                )));
            }
            non_empty_string(
                field(message, "sqliteVersion", "READY")?,
                "READY.sqliteVersion",
            )?;
            hex64(
                field(message, "sqliteCompileOptionsDigest", "READY")?,
                "READY.sqliteCompileOptionsDigest",
            )?;
            hex64(
                field(message, "buildManifestDigest", "READY")?,
                "READY.buildManifestDigest",
            )?;
            validate_handshake_contract(
                field(message, "acceptedContract", "READY")?,
                "READY.acceptedContract",
            )?;
            if v2 {
                uuid(
                    field(message, "databaseUuid", "READY")?,
                    "READY.databaseUuid",
                )?;
                let schema = field(message, "databaseFactSchemaVersion", "READY")?;
                if !schema.is_null() && !matches!(schema.as_u64(), Some(1 | 2)) {
                    return Err(invalid_frame(
                        "READY.databaseFactSchemaVersion must be null, 1, or 2",
                    ));
                }
            }
        }
        MessageKind::BeginSession => {
            validate_envelope(
                message,
                kind,
                &[
                    "deltaFormat",
                    "session",
                    "deltaId",
                    "mode",
                    "expectedGeneration",
                    "targetGeneration",
                    "contract",
                    "counts",
                ],
            )?;
            let delta_format = field(message, "deltaFormat", "BEGIN_SESSION")?
                .as_str()
                .ok_or_else(|| invalid_frame("BEGIN_SESSION.deltaFormat is unsupported"))?;
            let count_fields: &[&str] = match delta_format {
                "session-facts-delta@v1" => &V1_COUNT_FIELDS,
                "session-facts-delta@v2" => &V2_COUNT_FIELDS,
                _ => {
                    return Err(invalid_frame("BEGIN_SESSION.deltaFormat is unsupported"));
                }
            };
            let session = field(message, "session", "BEGIN_SESSION")?;
            object(session, "BEGIN_SESSION.session")?;
            hex64(
                field(session, "sessionKey", "BEGIN_SESSION.session")?,
                "BEGIN_SESSION.session.sessionKey",
            )?;
            hex64(
                field(message, "deltaId", "BEGIN_SESSION")?,
                "BEGIN_SESSION.deltaId",
            )?;
            if !matches!(
                field(message, "mode", "BEGIN_SESSION")?.as_str(),
                Some("append" | "replace-session")
            ) {
                return Err(invalid_frame("BEGIN_SESSION.mode is invalid"));
            }
            decimal_u64(
                field(message, "expectedGeneration", "BEGIN_SESSION")?,
                "BEGIN_SESSION.expectedGeneration",
            )?;
            decimal_u64(
                field(message, "targetGeneration", "BEGIN_SESSION")?,
                "BEGIN_SESSION.targetGeneration",
            )?;
            validate_session_contract(
                field(message, "contract", "BEGIN_SESSION")?,
                "BEGIN_SESSION.contract",
            )?;
            let counts = field(message, "counts", "BEGIN_SESSION")?;
            exact_object_keys(counts, "BEGIN_SESSION.counts", count_fields)?;
            for count in count_fields {
                decimal_u64(
                    field(counts, count, "BEGIN_SESSION.counts")?,
                    &format!("BEGIN_SESSION.counts.{count}"),
                )?;
            }
        }
        MessageKind::SessionAccepted => {
            validate_envelope(message, kind, &["sessionKey", "deltaId", "nextSequence"])?;
            hex64(
                field(message, "sessionKey", kind.as_str())?,
                "SESSION_ACCEPTED.sessionKey",
            )?;
            hex64(
                field(message, "deltaId", kind.as_str())?,
                "SESSION_ACCEPTED.deltaId",
            )?;
            decimal_u64(
                field(message, "nextSequence", kind.as_str())?,
                "SESSION_ACCEPTED.nextSequence",
            )?;
        }
        MessageKind::RetractFacts | MessageKind::UpsertFacts => {
            validate_envelope(message, kind, &["sequence", "collection", "items"])?;
            decimal_u64(
                field(message, "sequence", kind.as_str())?,
                &format!("{}.sequence", kind.as_str()),
            )?;
            let collection = field(message, "collection", kind.as_str())?
                .as_str()
                .ok_or_else(|| invalid_frame(format!("{}.collection is invalid", kind.as_str())))?;
            let allowed: &[&str] = if kind == MessageKind::RetractFacts {
                &RETRACTION_COLLECTIONS[..]
            } else {
                &V2_UPSERT_COLLECTIONS[..]
            };
            if !allowed.contains(&collection) {
                return Err(invalid_frame(format!(
                    "{}.collection is invalid",
                    kind.as_str()
                )));
            }
            if field(message, "items", kind.as_str())?
                .as_array()
                .is_none_or(Vec::is_empty)
            {
                return Err(invalid_frame(format!(
                    "{}.items must be a non-empty array",
                    kind.as_str()
                )));
            }
        }
        MessageKind::BatchAccepted => {
            validate_envelope(message, kind, &["sequence"])?;
            decimal_u64(
                field(message, "sequence", kind.as_str())?,
                "BATCH_ACCEPTED.sequence",
            )?;
        }
        MessageKind::CommitSession => {
            validate_envelope(
                message,
                kind,
                &[
                    "nextSequence",
                    "checkpoint",
                    "diagnostics",
                    "coverage",
                    "sourceState",
                ],
            )?;
            decimal_u64(
                field(message, "nextSequence", kind.as_str())?,
                "COMMIT_SESSION.nextSequence",
            )?;
            object(
                field(message, "checkpoint", kind.as_str())?,
                "COMMIT_SESSION.checkpoint",
            )?;
            if !field(message, "diagnostics", kind.as_str())?.is_array() {
                return Err(invalid_frame("COMMIT_SESSION.diagnostics must be an array"));
            }
            object(
                field(message, "coverage", kind.as_str())?,
                "COMMIT_SESSION.coverage",
            )?;
            let source_state = field(message, "sourceState", kind.as_str())?;
            if !source_state.is_null() {
                let source_state: crate::source_state::SourceState =
                    serde_json::from_value(source_state.clone())
                        .map_err(|_| invalid_frame("COMMIT_SESSION.sourceState is invalid"))?;
                source_state
                    .validate_identity()
                    .map_err(|_| invalid_frame("COMMIT_SESSION.sourceState is invalid"))?;
            }
        }
        MessageKind::SessionCommitted => {
            validate_envelope(
                message,
                kind,
                &["sessionKey", "deltaId", "snapshotSeq", "idempotent"],
            )?;
            hex64(
                field(message, "sessionKey", kind.as_str())?,
                "SESSION_COMMITTED.sessionKey",
            )?;
            hex64(
                field(message, "deltaId", kind.as_str())?,
                "SESSION_COMMITTED.deltaId",
            )?;
            decimal_u64(
                field(message, "snapshotSeq", kind.as_str())?,
                "SESSION_COMMITTED.snapshotSeq",
            )?;
            if !field(message, "idempotent", kind.as_str())?.is_boolean() {
                return Err(invalid_frame(
                    "SESSION_COMMITTED.idempotent must be boolean",
                ));
            }
        }
        MessageKind::BeginTraceSource => {
            validate_envelope(
                message,
                kind,
                &[
                    "deltaFormat",
                    "deltaId",
                    "expectedGeneration",
                    "targetGeneration",
                    "repository",
                    "intent",
                    "counts",
                ],
            )?;
            if field(message, "deltaFormat", kind.as_str())?.as_str()
                != Some(crate::delivery_graph_repository::TRACE_SOURCE_DELTA_FORMAT)
            {
                return Err(invalid_frame(
                    "BEGIN_TRACE_SOURCE.deltaFormat is unsupported",
                ));
            }
            hex64(
                field(message, "deltaId", kind.as_str())?,
                "BEGIN_TRACE_SOURCE.deltaId",
            )?;
            decimal_u64(
                field(message, "expectedGeneration", kind.as_str())?,
                "BEGIN_TRACE_SOURCE.expectedGeneration",
            )?;
            decimal_u64(
                field(message, "targetGeneration", kind.as_str())?,
                "BEGIN_TRACE_SOURCE.targetGeneration",
            )?;
            let repository = field(message, "repository", kind.as_str())?;
            exact_object_keys(
                repository,
                "BEGIN_TRACE_SOURCE.repository",
                &[
                    "repositoryId",
                    "repositoryKey",
                    "available",
                    "refDigest",
                    "scmProvider",
                    "webBaseUrl",
                    "repositoryPath",
                    "projectKeys",
                ],
            )?;
            uuid(
                field(repository, "repositoryId", "BEGIN_TRACE_SOURCE.repository")?,
                "BEGIN_TRACE_SOURCE.repository.repositoryId",
            )?;
            let project_keys = field(repository, "projectKeys", "BEGIN_TRACE_SOURCE.repository")?
                .as_array()
                .ok_or_else(|| {
                    invalid_frame("BEGIN_TRACE_SOURCE.repository.projectKeys must be an array")
                })?;
            if project_keys.len() != 2 {
                return Err(invalid_frame(
                    "BEGIN_TRACE_SOURCE.repository.projectKeys must contain two keys",
                ));
            }
            for key in project_keys {
                hex64(key, "BEGIN_TRACE_SOURCE.repository.projectKeys[]")?;
            }
            hex64(
                field(repository, "repositoryKey", "BEGIN_TRACE_SOURCE.repository")?,
                "BEGIN_TRACE_SOURCE.repository.repositoryKey",
            )?;
            hex64(
                field(repository, "refDigest", "BEGIN_TRACE_SOURCE.repository")?,
                "BEGIN_TRACE_SOURCE.repository.refDigest",
            )?;
            if !field(repository, "available", "BEGIN_TRACE_SOURCE.repository")?.is_boolean() {
                return Err(invalid_frame(
                    "BEGIN_TRACE_SOURCE.repository.available must be boolean",
                ));
            }
            let scm = ["scmProvider", "webBaseUrl", "repositoryPath"]
                .map(|name| field(repository, name, "BEGIN_TRACE_SOURCE.repository"))
                .into_iter()
                .collect::<Result<Vec<_>, _>>()?;
            if !(scm.iter().all(|value| value.is_null())
                || scm.iter().all(|value| {
                    value
                        .as_str()
                        .is_some_and(|value| !value.is_empty() && value.len() <= 12 * 1024)
                }))
            {
                return Err(invalid_frame(
                    "BEGIN_TRACE_SOURCE.repository SCM metadata is invalid",
                ));
            }
            let intent = field(message, "intent", kind.as_str())?;
            if !intent.is_null() {
                exact_object_keys(
                    intent,
                    "BEGIN_TRACE_SOURCE.intent",
                    &[
                        "sourceKey",
                        "adapterVersion",
                        "revision",
                        "locator",
                        "coverage",
                        "diagnostics",
                    ],
                )?;
                hex64(
                    field(intent, "sourceKey", "BEGIN_TRACE_SOURCE.intent")?,
                    "BEGIN_TRACE_SOURCE.intent.sourceKey",
                )?;
                bounded_string(
                    field(intent, "adapterVersion", "BEGIN_TRACE_SOURCE.intent")?,
                    "BEGIN_TRACE_SOURCE.intent.adapterVersion",
                    128,
                    false,
                    true,
                )?;
                hex64(
                    field(intent, "revision", "BEGIN_TRACE_SOURCE.intent")?,
                    "BEGIN_TRACE_SOURCE.intent.revision",
                )?;
                bounded_string(
                    field(intent, "locator", "BEGIN_TRACE_SOURCE.intent")?,
                    "BEGIN_TRACE_SOURCE.intent.locator",
                    4096,
                    false,
                    true,
                )?;
                if !matches!(
                    field(intent, "coverage", "BEGIN_TRACE_SOURCE.intent")?.as_str(),
                    Some("complete" | "partial" | "unavailable")
                ) {
                    return Err(invalid_frame(
                        "BEGIN_TRACE_SOURCE.intent.coverage is invalid",
                    ));
                }
                let diagnostics = field(intent, "diagnostics", "BEGIN_TRACE_SOURCE.intent")?
                    .as_array()
                    .ok_or_else(|| {
                        invalid_frame("BEGIN_TRACE_SOURCE.intent.diagnostics must be an array")
                    })?;
                if diagnostics.len() > 4096 {
                    return Err(invalid_frame(
                        "BEGIN_TRACE_SOURCE intent diagnostics exceed 4096",
                    ));
                }
                for diagnostic in diagnostics {
                    exact_object_keys(
                        diagnostic,
                        "BEGIN_TRACE_SOURCE.intent.diagnostics[]",
                        &["line", "code"],
                    )?;
                    decimal_u64(
                        field(
                            diagnostic,
                            "line",
                            "BEGIN_TRACE_SOURCE.intent.diagnostics[]",
                        )?,
                        "BEGIN_TRACE_SOURCE.intent.diagnostics[].line",
                    )?;
                    bounded_string(
                        field(
                            diagnostic,
                            "code",
                            "BEGIN_TRACE_SOURCE.intent.diagnostics[]",
                        )?,
                        "BEGIN_TRACE_SOURCE.intent.diagnostics[].code",
                        128,
                        false,
                        true,
                    )?;
                }
            }
            let counts = field(message, "counts", kind.as_str())?;
            exact_object_keys(
                counts,
                "BEGIN_TRACE_SOURCE.counts",
                &["refs", "commits", "files", "intentNodes", "intentRefs"],
            )?;
            for count in ["refs", "commits", "files", "intentNodes", "intentRefs"] {
                decimal_u64(
                    field(counts, count, "BEGIN_TRACE_SOURCE.counts")?,
                    &format!("BEGIN_TRACE_SOURCE.counts.{count}"),
                )?;
            }
        }
        MessageKind::TraceSourceAccepted | MessageKind::TraceSourceAborted => {
            validate_envelope(message, kind, &["repositoryKey", "deltaId", "nextSequence"])?;
            hex64(
                field(message, "repositoryKey", kind.as_str())?,
                &format!("{}.repositoryKey", kind.as_str()),
            )?;
            hex64(
                field(message, "deltaId", kind.as_str())?,
                &format!("{}.deltaId", kind.as_str()),
            )?;
            decimal_u64(
                field(message, "nextSequence", kind.as_str())?,
                &format!("{}.nextSequence", kind.as_str()),
            )?;
        }
        MessageKind::TraceSourceBatch => {
            validate_envelope(message, kind, &["sequence", "collection", "items"])?;
            decimal_u64(
                field(message, "sequence", kind.as_str())?,
                "TRACE_SOURCE_BATCH.sequence",
            )?;
            if !matches!(
                field(message, "collection", kind.as_str())?.as_str(),
                Some("refs" | "commits" | "files" | "intentNodes" | "intentRefs")
            ) {
                return Err(invalid_frame("TRACE_SOURCE_BATCH.collection is invalid"));
            }
            if field(message, "items", kind.as_str())?
                .as_array()
                .is_none_or(Vec::is_empty)
            {
                return Err(invalid_frame(
                    "TRACE_SOURCE_BATCH.items must be a non-empty array",
                ));
            }
        }
        MessageKind::TraceSourceBatchAccepted => {
            validate_envelope(message, kind, &["sequence"])?;
            decimal_u64(
                field(message, "sequence", kind.as_str())?,
                "TRACE_SOURCE_BATCH_ACCEPTED.sequence",
            )?;
        }
        MessageKind::CommitTraceSource | MessageKind::AbortTraceSource => {
            validate_envelope(message, kind, &["nextSequence"])?;
            decimal_u64(
                field(message, "nextSequence", kind.as_str())?,
                &format!("{}.nextSequence", kind.as_str()),
            )?;
        }
        MessageKind::TraceSourceCommitted => {
            validate_envelope(
                message,
                kind,
                &["repositoryKey", "deltaId", "snapshotSeq", "idempotent"],
            )?;
            hex64(
                field(message, "repositoryKey", kind.as_str())?,
                "TRACE_SOURCE_COMMITTED.repositoryKey",
            )?;
            hex64(
                field(message, "deltaId", kind.as_str())?,
                "TRACE_SOURCE_COMMITTED.deltaId",
            )?;
            decimal_u64(
                field(message, "snapshotSeq", kind.as_str())?,
                "TRACE_SOURCE_COMMITTED.snapshotSeq",
            )?;
            if !field(message, "idempotent", kind.as_str())?.is_boolean() {
                return Err(invalid_frame(
                    "TRACE_SOURCE_COMMITTED.idempotent must be boolean",
                ));
            }
        }
        MessageKind::ReadRepositoryState => {
            validate_envelope(message, kind, &["repositoryId", "cursor", "limit"])?;
            uuid(
                field(message, "repositoryId", kind.as_str())?,
                "READ_REPOSITORY_STATE.repositoryId",
            )?;
            let cursor = field(message, "cursor", kind.as_str())?;
            if !cursor.is_null() {
                bounded_string(cursor, "READ_REPOSITORY_STATE.cursor", 4096, false, true)?;
            }
            let limit = positive_safe_integer(
                field(message, "limit", kind.as_str())?,
                "READ_REPOSITORY_STATE.limit",
            )?;
            if limit > 256 {
                return Err(invalid_frame(
                    "READ_REPOSITORY_STATE.limit must not exceed 256",
                ));
            }
        }
        MessageKind::RepositoryState => {
            validate_envelope(
                message,
                kind,
                &[
                    "repositoryId",
                    "generation",
                    "available",
                    "refDigest",
                    "intentRevision",
                    "coverageAfter",
                    "refs",
                    "nextCursor",
                ],
            )?;
            uuid(
                field(message, "repositoryId", kind.as_str())?,
                "REPOSITORY_STATE.repositoryId",
            )?;
            decimal_u64(
                field(message, "generation", kind.as_str())?,
                "REPOSITORY_STATE.generation",
            )?;
            let available = field(message, "available", kind.as_str())?;
            if !available.is_null() && !available.is_boolean() {
                return Err(invalid_frame(
                    "REPOSITORY_STATE.available must be a boolean or null",
                ));
            }
            let digest = field(message, "refDigest", kind.as_str())?;
            if !digest.is_null() {
                hex64(digest, "REPOSITORY_STATE.refDigest")?;
            }
            let intent_revision = field(message, "intentRevision", kind.as_str())?;
            if !intent_revision.is_null() {
                hex64(intent_revision, "REPOSITORY_STATE.intentRevision")?;
            }
            let coverage_after = field(message, "coverageAfter", kind.as_str())?;
            if !coverage_after.is_null() {
                canonical_timestamp_millis(coverage_after, "REPOSITORY_STATE.coverageAfter")?;
            }
            let refs = field(message, "refs", kind.as_str())?
                .as_array()
                .ok_or_else(|| invalid_frame("REPOSITORY_STATE.refs must be an array"))?;
            if refs.len() > 256 {
                return Err(invalid_frame("REPOSITORY_STATE.refs exceeds 256 items"));
            }
            let mut previous: Option<&str> = None;
            for reference in refs {
                exact_object_keys(reference, "REPOSITORY_STATE.refs[]", &["name", "objectId"])?;
                let name = bounded_string(
                    field(reference, "name", "REPOSITORY_STATE.refs[]")?,
                    "REPOSITORY_STATE.refs[].name",
                    4096,
                    false,
                    true,
                )?;
                if !name.starts_with("refs/") || previous.is_some_and(|value| value >= name) {
                    return Err(invalid_frame(
                        "REPOSITORY_STATE.refs is not strictly sorted",
                    ));
                }
                previous = Some(name);
                hex40_or_64(
                    field(reference, "objectId", "REPOSITORY_STATE.refs[]")?,
                    "REPOSITORY_STATE.refs[].objectId",
                )?;
            }
            let next_cursor = field(message, "nextCursor", kind.as_str())?;
            if !next_cursor.is_null() {
                bounded_string(
                    next_cursor,
                    "REPOSITORY_STATE.nextCursor",
                    4096,
                    false,
                    true,
                )?;
            }
        }
        MessageKind::ListSourceStates => {
            validate_envelope(message, kind, &["cursor", "limit"])?;
            let cursor = field(message, "cursor", kind.as_str())?;
            if !cursor.is_null() {
                hex64(cursor, "LIST_SOURCE_STATES.cursor")?;
            }
            let limit = positive_safe_integer(
                field(message, "limit", kind.as_str())?,
                "LIST_SOURCE_STATES.limit",
            )?;
            if limit > u64::from(crate::source_state::MAX_SOURCE_STATE_PAGE_SIZE) {
                return Err(invalid_frame("LIST_SOURCE_STATES.limit exceeds 256"));
            }
        }
        MessageKind::SourceStates => {
            validate_envelope(message, kind, &["states", "nextCursor"])?;
            let states = field(message, "states", kind.as_str())?
                .as_array()
                .ok_or_else(|| invalid_frame("SOURCE_STATES.states must be an array"))?;
            if states.len() > usize::from(crate::source_state::MAX_SOURCE_STATE_PAGE_SIZE) {
                return Err(invalid_frame("SOURCE_STATES.states exceeds 256 items"));
            }
            let mut previous = None;
            for state in states {
                let state: crate::source_state::SourceStateSummary =
                    serde_json::from_value(state.clone()).map_err(|_| {
                        invalid_frame("SOURCE_STATES.states contains an invalid item")
                    })?;
                state
                    .validate()
                    .map_err(|_| invalid_frame("SOURCE_STATES.states contains an invalid item"))?;
                if previous.is_some_and(|value| value >= state.state.session_key) {
                    return Err(invalid_frame(
                        "SOURCE_STATES.states must be sessionKey-sorted and unique",
                    ));
                }
                previous = Some(state.state.session_key);
            }
            let next_cursor = field(message, "nextCursor", kind.as_str())?;
            if !next_cursor.is_null() {
                let cursor: crate::fact_model::StableKey =
                    serde_json::from_value(next_cursor.clone())
                        .map_err(|_| invalid_frame("SOURCE_STATES.nextCursor is invalid"))?;
                if Some(cursor) != previous {
                    return Err(invalid_frame(
                        "SOURCE_STATES.nextCursor must equal the final state sessionKey",
                    ));
                }
            }
        }
        MessageKind::ReadSourceCheckpoint => {
            validate_envelope(message, kind, &["sessionKey"])?;
            hex64(
                field(message, "sessionKey", kind.as_str())?,
                "READ_SOURCE_CHECKPOINT.sessionKey",
            )?;
        }
        MessageKind::SourceCheckpoint => {
            validate_envelope(message, kind, &["sessionKey", "checkpoint"])?;
            hex64(
                field(message, "sessionKey", kind.as_str())?,
                "SOURCE_CHECKPOINT.sessionKey",
            )?;
            let checkpoint = field(message, "checkpoint", kind.as_str())?;
            if !checkpoint.is_null() {
                let checkpoint: crate::fact_model::Checkpoint =
                    serde_json::from_value(checkpoint.clone())
                        .map_err(|_| invalid_frame("SOURCE_CHECKPOINT.checkpoint is invalid"))?;
                crate::source_state::validate_checkpoint(&checkpoint)
                    .map_err(|_| invalid_frame("SOURCE_CHECKPOINT.checkpoint is invalid"))?;
            }
        }
        MessageKind::RemoveSource | MessageKind::ExcludeSource => {
            validate_envelope(message, kind, &["sessionKey"])?;
            hex64(
                field(message, "sessionKey", kind.as_str())?,
                &format!("{}.sessionKey", kind.as_str()),
            )?;
        }
        MessageKind::SourceRemoved => {
            validate_envelope(message, kind, &["sessionKey", "removed"])?;
            hex64(
                field(message, "sessionKey", kind.as_str())?,
                "SOURCE_REMOVED.sessionKey",
            )?;
            if field(message, "removed", kind.as_str())?
                .as_bool()
                .is_none()
            {
                return Err(invalid_frame("SOURCE_REMOVED.removed must be boolean"));
            }
        }
        MessageKind::SourceExcluded => {
            validate_envelope(message, kind, &["sessionKey", "excluded", "purgeState"])?;
            hex64(
                field(message, "sessionKey", kind.as_str())?,
                "SOURCE_EXCLUDED.sessionKey",
            )?;
            if field(message, "excluded", kind.as_str())?
                .as_bool()
                .is_none()
            {
                return Err(invalid_frame("SOURCE_EXCLUDED.excluded must be boolean"));
            }
            purge_state(
                field(message, "purgeState", kind.as_str())?,
                "SOURCE_EXCLUDED.purgeState",
            )?;
        }
        MessageKind::ReadPurgeStatus => {
            validate_envelope(message, kind, &["sessionKey"])?;
            let session_key = field(message, "sessionKey", kind.as_str())?;
            if !session_key.is_null() {
                hex64(session_key, "READ_PURGE_STATUS.sessionKey")?;
            }
        }
        MessageKind::PurgeStatus => {
            validate_envelope(
                message,
                kind,
                &[
                    "sessionKey",
                    "state",
                    "pendingFacts",
                    "pendingMaintenance",
                    "purged",
                ],
            )?;
            let session_key = field(message, "sessionKey", kind.as_str())?;
            if !session_key.is_null() {
                hex64(session_key, "PURGE_STATUS.sessionKey")?;
            }
            purge_status_fields(message, kind)?;
        }
        MessageKind::RunPurgeMaintenance => {
            validate_envelope(message, kind, &["limit"])?;
            let limit = positive_safe_integer(
                field(message, "limit", kind.as_str())?,
                "RUN_PURGE_MAINTENANCE.limit",
            )?;
            if limit > u64::from(crate::source_state::MAX_PURGE_MAINTENANCE_BATCH_SIZE) {
                return Err(invalid_frame("RUN_PURGE_MAINTENANCE.limit exceeds 256"));
            }
        }
        MessageKind::PurgeMaintenanceStatus => {
            validate_envelope(
                message,
                kind,
                &[
                    "processedSessions",
                    "purgedSessions",
                    "state",
                    "pendingFacts",
                    "pendingMaintenance",
                    "purged",
                ],
            )?;
            decimal_u64(
                field(message, "processedSessions", kind.as_str())?,
                "PURGE_MAINTENANCE_STATUS.processedSessions",
            )?;
            decimal_u64(
                field(message, "purgedSessions", kind.as_str())?,
                "PURGE_MAINTENANCE_STATUS.purgedSessions",
            )?;
            purge_status_fields(message, kind)?;
        }
        MessageKind::ReadEngineStatus => {
            validate_envelope(message, kind, &[])?;
        }
        MessageKind::EngineStatus => validate_engine_status(message, kind)?,
        MessageKind::ReadInsightsOverview => {
            validate_envelope(message, kind, &["nowUnixMs", "quiescenceSeconds"])?;
            decimal_u64(
                field(message, "nowUnixMs", kind.as_str())?,
                "READ_INSIGHTS_OVERVIEW.nowUnixMs",
            )?;
            safe_integer_range(
                field(message, "quiescenceSeconds", kind.as_str())?,
                "READ_INSIGHTS_OVERVIEW.quiescenceSeconds",
                60,
                86_400,
            )?;
        }
        MessageKind::InsightsOverview => validate_insights_overview(message, kind)?,
        MessageKind::ListCapabilities => {
            validate_envelope(message, kind, &["kind", "cursor", "limit"])?;
            enum_string(
                field(message, "kind", kind.as_str())?,
                "LIST_CAPABILITIES.kind",
                &["tool", "skill"],
            )?;
            nullable_hex64(
                field(message, "cursor", kind.as_str())?,
                "LIST_CAPABILITIES.cursor",
            )?;
            safe_integer_range(
                field(message, "limit", kind.as_str())?,
                "LIST_CAPABILITIES.limit",
                1,
                u64::from(crate::insights_overview::MAX_CAPABILITY_PAGE_SIZE),
            )?;
        }
        MessageKind::CapabilityPage => validate_capability_page(message, kind)?,
        MessageKind::SearchTurns => validate_search_turns(message, kind)?,
        MessageKind::TurnSearchResults => validate_turn_search_results(message, kind)?,
        MessageKind::ReadCapabilityUsage => validate_read_capability_usage(message, kind)?,
        MessageKind::CapabilityUsage => validate_capability_usage(message, kind)?,
        MessageKind::ReadInsightsActivity => validate_read_insights_activity(message, kind)?,
        MessageKind::InsightsActivity => validate_insights_activity(message, kind)?,
        MessageKind::ReadTurnEvidence => validate_read_turn_evidence(message, kind)?,
        MessageKind::TurnEvidencePage => validate_turn_evidence_page(message, kind)?,
        MessageKind::ReadInsightsQueryV2 => {
            validate_envelope(message, kind, &["request"])?;
            let request = field(message, "request", kind.as_str())?;
            if try_canonical_json(request)
                .map_err(|_| invalid_frame("READ_INSIGHTS_QUERY_V2.request is invalid"))?
                .len()
                > 64 * 1024
            {
                return Err(invalid_frame(
                    "READ_INSIGHTS_QUERY_V2.request exceeds 64 KiB",
                ));
            }
            let request: crate::deep_query::DeepQueryRequest =
                serde_json::from_value(request.clone()).map_err(|_| {
                    invalid_frame("READ_INSIGHTS_QUERY_V2.request has an invalid shape")
                })?;
            request
                .validate()
                .map_err(|_| invalid_frame("READ_INSIGHTS_QUERY_V2.request is invalid"))?;
        }
        MessageKind::InsightsQueryV2 => {
            validate_envelope(message, kind, &["response"])?;
            let response: crate::deep_query::DeepQueryResponse =
                serde_json::from_value(field(message, "response", kind.as_str())?.clone())
                    .map_err(|_| {
                        invalid_frame("INSIGHTS_QUERY_V2.response has an invalid shape")
                    })?;
            if response.format != crate::deep_query::QUERY_RESPONSE_FORMAT {
                return Err(invalid_frame(
                    "INSIGHTS_QUERY_V2.response format is invalid",
                ));
            }
        }
        MessageKind::ReadInsightsEvidenceV2 => {
            validate_envelope(message, kind, &["request"])?;
            let request = field(message, "request", kind.as_str())?;
            if try_canonical_json(request)
                .map_err(|_| invalid_frame("READ_INSIGHTS_EVIDENCE_V2.request is invalid"))?
                .len()
                > 64 * 1024
            {
                return Err(invalid_frame(
                    "READ_INSIGHTS_EVIDENCE_V2.request exceeds 64 KiB",
                ));
            }
            let request: crate::deep_query::DeepEvidenceRequest =
                serde_json::from_value(request.clone()).map_err(|_| {
                    invalid_frame("READ_INSIGHTS_EVIDENCE_V2.request has an invalid shape")
                })?;
            request
                .validate()
                .map_err(|_| invalid_frame("READ_INSIGHTS_EVIDENCE_V2.request is invalid"))?;
        }
        MessageKind::InsightsEvidenceV2 => {
            validate_envelope(message, kind, &["response"])?;
            let response: crate::deep_query::DeepEvidenceResponse =
                serde_json::from_value(field(message, "response", kind.as_str())?.clone())
                    .map_err(|_| {
                        invalid_frame("INSIGHTS_EVIDENCE_V2.response has an invalid shape")
                    })?;
            if response.format != crate::deep_query::EVIDENCE_RESPONSE_FORMAT {
                return Err(invalid_frame(
                    "INSIGHTS_EVIDENCE_V2.response format is invalid",
                ));
            }
        }
        MessageKind::ReadInsightsRecipe => {
            validate_envelope(message, kind, &["request"])?;
            let request = field(message, "request", kind.as_str())?;
            if try_canonical_json(request)
                .map_err(|_| invalid_frame("READ_INSIGHTS_RECIPE.request is invalid"))?
                .len()
                > 64 * 1024
            {
                return Err(invalid_frame("READ_INSIGHTS_RECIPE.request exceeds 64 KiB"));
            }
            let request: crate::recipe::RecipeRequest = serde_json::from_value(request.clone())
                .map_err(|_| invalid_frame("READ_INSIGHTS_RECIPE.request has an invalid shape"))?;
            request
                .validate()
                .map_err(|_| invalid_frame("READ_INSIGHTS_RECIPE.request is invalid"))?;
        }
        MessageKind::InsightsRecipe => {
            validate_envelope(message, kind, &["response"])?;
            let response: crate::recipe::RecipeResponse =
                serde_json::from_value(field(message, "response", kind.as_str())?.clone())
                    .map_err(|_| invalid_frame("INSIGHTS_RECIPE.response has an invalid shape"))?;
            if response.format != crate::recipe::RECIPE_RESPONSE_FORMAT {
                return Err(invalid_frame("INSIGHTS_RECIPE.response format is invalid"));
            }
            response
                .validate()
                .map_err(|_| invalid_frame("INSIGHTS_RECIPE.response is invalid"))?;
        }
        MessageKind::ReadInsightsDeliveryTrace => {
            validate_envelope(message, kind, &["request"])?;
            let request: crate::delivery_trace::DeliveryTraceRequest =
                serde_json::from_value(field(message, "request", kind.as_str())?.clone()).map_err(
                    |_| invalid_frame("READ_INSIGHTS_DELIVERY_TRACE.request has an invalid shape"),
                )?;
            request
                .validate()
                .map_err(|_| invalid_frame("READ_INSIGHTS_DELIVERY_TRACE.request is invalid"))?;
        }
        MessageKind::InsightsDeliveryTrace => {
            validate_envelope(message, kind, &["request", "response"])?;
            let request: crate::delivery_trace::DeliveryTraceRequest = serde_json::from_value(
                field(message, "request", kind.as_str())?.clone(),
            )
            .map_err(|_| invalid_frame("INSIGHTS_DELIVERY_TRACE.request has an invalid shape"))?;
            let response: crate::delivery_trace::DeliveryTraceResponse =
                serde_json::from_value(field(message, "response", kind.as_str())?.clone())
                    .map_err(|_| {
                        invalid_frame("INSIGHTS_DELIVERY_TRACE.response has an invalid shape")
                    })?;
            response
                .validate_against(&request)
                .map_err(|_| invalid_frame("INSIGHTS_DELIVERY_TRACE.response is invalid"))?;
        }
        MessageKind::MemoryCommand => {
            validate_envelope(message, kind, &["op", "payload"])?;
            let op = non_empty_string(field(message, "op", kind.as_str())?, "MEMORY_COMMAND.op")?;
            if !crate::memory_protocol::is_memory_op(op) {
                return Err(invalid_frame(format!(
                    "MEMORY_COMMAND.op {op} is not supported"
                )));
            }
            let payload = field(message, "payload", kind.as_str())?;
            if !payload.is_object() {
                return Err(invalid_frame("MEMORY_COMMAND.payload must be an object"));
            }
            crate::memory_protocol::validate_command_payload(op, payload).map_err(|error| {
                invalid_frame(format!("MEMORY_COMMAND.payload is invalid: {error}"))
            })?;
        }
        MessageKind::MemoryResult => {
            validate_envelope(message, kind, &["op", "payload"])?;
            let op = non_empty_string(field(message, "op", kind.as_str())?, "MEMORY_RESULT.op")?;
            if !crate::memory_protocol::is_memory_op(op) {
                return Err(invalid_frame(format!(
                    "MEMORY_RESULT.op {op} is not supported"
                )));
            }
            if !field(message, "payload", kind.as_str())?.is_object() {
                return Err(invalid_frame("MEMORY_RESULT.payload must be an object"));
            }
        }
        MessageKind::AbortSession => {
            validate_envelope(message, kind, &["nextSequence", "reason"])?;
            decimal_u64(
                field(message, "nextSequence", kind.as_str())?,
                "ABORT_SESSION.nextSequence",
            )?;
            let reason = non_empty_string(
                field(message, "reason", kind.as_str())?,
                "ABORT_SESSION.reason",
            )?;
            if reason.len() > 1_024 {
                return Err(invalid_frame("ABORT_SESSION.reason exceeds 1 KiB"));
            }
        }
        MessageKind::SessionAborted => {
            validate_envelope(message, kind, &["sessionKey", "deltaId", "nextSequence"])?;
            hex64(
                field(message, "sessionKey", kind.as_str())?,
                "SESSION_ABORTED.sessionKey",
            )?;
            hex64(
                field(message, "deltaId", kind.as_str())?,
                "SESSION_ABORTED.deltaId",
            )?;
            decimal_u64(
                field(message, "nextSequence", kind.as_str())?,
                "SESSION_ABORTED.nextSequence",
            )?;
        }
        MessageKind::Error => {
            validate_envelope(
                message,
                kind,
                &["code", "category", "message", "retryable", "fatal"],
            )?;
            non_empty_string(field(message, "code", kind.as_str())?, "ERROR.code")?;
            if !matches!(
                field(message, "category", kind.as_str())?.as_str(),
                Some(
                    "protocol"
                        | "compatibility"
                        | "validation"
                        | "conflict"
                        | "storage"
                        | "maintenance"
                )
            ) {
                return Err(invalid_frame("ERROR.category is invalid"));
            }
            let error_message =
                non_empty_string(field(message, "message", kind.as_str())?, "ERROR.message")?;
            if error_message.len() > 1_024 {
                return Err(invalid_frame("ERROR.message exceeds 1 KiB"));
            }
            if !field(message, "retryable", kind.as_str())?.is_boolean()
                || !field(message, "fatal", kind.as_str())?.is_boolean()
            {
                return Err(invalid_frame(
                    "ERROR.retryable and ERROR.fatal must be boolean",
                ));
            }
        }
    }
    Ok(kind)
}

pub fn message_type(value: &Value) -> Result<&str, ProtocolError> {
    validate_protocol_message(value)?;
    value
        .get("type")
        .and_then(Value::as_str)
        .ok_or_else(|| invalid_frame("protocol message requires a string type"))
}

pub fn request_id(value: &Value) -> Result<&str, ProtocolError> {
    validate_protocol_message(value)?;
    Ok(decimal_u64(
        value
            .get("requestId")
            .expect("validated message has requestId"),
        "requestId",
    )?
    .0)
}

pub fn require_protocol_version(value: &Value) -> Result<(), ProtocolError> {
    if value.get("format").and_then(Value::as_str) != Some(PROTOCOL_FORMAT) {
        return Err(ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_UNSUPPORTED_VERSION",
            "unsupported Insights protocol version",
            true,
        ));
    }
    Ok(())
}

fn contract_scalar_equal(left: &Value, right: &Value, field_name: &str) -> bool {
    left.get(field_name) == right.get(field_name)
}

pub fn accepted_contract_from_hello(message: &Value) -> Result<Value, ProtocolError> {
    if validate_protocol_message(message)? != MessageKind::Hello {
        return Err(ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
            "the first frame must be HELLO",
            false,
        ));
    }
    let contract = message
        .get("requiredContract")
        .expect("validated HELLO has requiredContract");
    let v1 = contract.get("factSchemaVersion").and_then(Value::as_u64) == Some(1)
        && contract.get("providerAdapterVersions") == Some(&json!(["claude@1", "codex@1"]))
        && contract.get("privacyPolicyVersion").and_then(Value::as_u64) == Some(1)
        && contract
            .get("duplicatePolicyVersion")
            .and_then(Value::as_u64)
            == Some(1)
        && contract.get("factStorageProfile").and_then(Value::as_str) == Some("normalized-row-v1")
        && contract.get("storageSchemaVersion").and_then(Value::as_u64) == Some(1)
        && contract.get("projectionVersions") == Some(&json!(["turn-search@2", "turn-summary@1"]))
        && contract.get("analyzerCapabilities") == Some(&json!(["mixed-cjk-code@1"]))
        && contract.get("rankerVersion").and_then(Value::as_u64) == Some(1);
    let v2 = contract.get("factSchemaVersion").and_then(Value::as_u64) == Some(2)
        && contract.get("providerAdapterVersions") == Some(&json!(["claude@3", "codex@3"]))
        && contract.get("privacyPolicyVersion").and_then(Value::as_u64) == Some(2)
        && contract
            .get("duplicatePolicyVersion")
            .and_then(Value::as_u64)
            == Some(1)
        && contract.get("factStorageProfile").and_then(Value::as_str) == Some("normalized-row-v2")
        && contract.get("storageSchemaVersion").and_then(Value::as_u64) == Some(2)
        && contract.get("projectionVersions") == Some(&json!(["turn-search@2", "turn-summary@1"]))
        && contract.get("analyzerCapabilities") == Some(&json!(["mixed-cjk-code@1"]))
        && contract.get("rankerVersion").and_then(Value::as_u64) == Some(1);
    if !v1 && !v2 {
        return Err(unsupported_contract(
            "the requested Insights contract is unsupported",
        ));
    }
    Ok(contract.clone())
}

pub fn validate_begin_against_contract(
    begin: &Value,
    accepted: &Value,
) -> Result<(), ProtocolError> {
    if validate_protocol_message(begin)? != MessageKind::BeginSession {
        return Err(ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
            "session compatibility requires BEGIN_SESSION",
            false,
        ));
    }
    validate_handshake_contract(accepted, "acceptedContract")?;
    let session = begin
        .get("contract")
        .expect("validated BEGIN_SESSION has contract");
    let adapter = session
        .get("providerAdapterVersion")
        .and_then(Value::as_str)
        .expect("validated session contract has provider adapter");
    let adapters = accepted
        .get("providerAdapterVersions")
        .and_then(Value::as_array)
        .expect("validated accepted contract has provider adapters");
    let epoch_equal = session
        .get("originSecretEpoch")
        .and_then(Value::as_str)
        .zip(accepted.get("originSecretEpoch").and_then(Value::as_str))
        .is_some_and(|(left, right)| left.eq_ignore_ascii_case(right));
    let compatible = adapters.iter().any(|value| value.as_str() == Some(adapter))
        && epoch_equal
        && [
            "factSchemaVersion",
            "privacyPolicyVersion",
            "duplicatePolicyVersion",
            "factStorageProfile",
            "storageSchemaVersion",
            "projectionVersions",
            "analyzerCapabilities",
            "rankerVersion",
        ]
        .iter()
        .all(|field_name| contract_scalar_equal(session, accepted, field_name));
    if !compatible {
        return Err(unsupported_contract(
            "BEGIN_SESSION does not match the accepted Insights contract",
        ));
    }
    Ok(())
}

fn read_exact_after_first<R: Read>(reader: &mut R, buffer: &mut [u8]) -> Result<(), ProtocolError> {
    reader.read_exact(buffer).map_err(|error| {
        ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
            if error.kind() == io::ErrorKind::UnexpectedEof {
                "truncated protocol frame"
            } else {
                "failed to read protocol frame"
            },
            true,
        )
    })
}

pub fn read_frame<R: Read>(reader: &mut R) -> Result<Option<Value>, ProtocolError> {
    let mut prefix = [0_u8; 4];
    match reader.read(&mut prefix[..1]) {
        Ok(0) => return Ok(None),
        Ok(1) => {}
        Ok(_) => unreachable!("one-byte read returned more than one byte"),
        Err(_) => {
            return Err(ProtocolError::new(
                "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
                "failed to read protocol frame",
                true,
            ));
        }
    }
    read_exact_after_first(reader, &mut prefix[1..])?;
    let length = u32::from_be_bytes(prefix) as usize;
    if length == 0 {
        return Err(ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
            "zero-length protocol frames are not allowed",
            true,
        ));
    }
    if length > MAX_FRAME_BYTES {
        return Err(ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_FRAME_TOO_LARGE",
            "protocol frame exceeds the 4 MiB limit",
            true,
        ));
    }
    let mut payload = vec![0_u8; length];
    read_exact_after_first(reader, &mut payload)?;
    let text = std::str::from_utf8(&payload).map_err(|_| {
        ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
            "protocol payload must be valid UTF-8",
            true,
        )
    })?;
    let value: Value = serde_json::from_str(text).map_err(|_| {
        ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
            "protocol payload must be valid JSON",
            true,
        )
    })?;
    if !value.is_object() {
        return Err(ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
            "protocol payload must be a JSON object",
            true,
        ));
    }
    let canonical = try_canonical_json(&value).map_err(|_| {
        ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
            "protocol payload is outside the canonical JSON domain",
            true,
        )
    })?;
    if canonical.as_bytes() != payload {
        return Err(ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
            "protocol payload must use canonical JSON encoding",
            true,
        ));
    }
    validate_protocol_message(&value).map_err(|mut error| {
        error.fatal = true;
        error
    })?;
    Ok(Some(value))
}

pub fn write_frame<W: Write>(writer: &mut W, value: &Value) -> Result<(), ProtocolError> {
    validate_protocol_message(value)?;
    let payload = try_canonical_json(value).map_err(|_| {
        ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
            "response is outside the canonical JSON domain",
            true,
        )
    })?;
    if payload.len() > MAX_FRAME_BYTES {
        return Err(ProtocolError::new(
            "TS_INSIGHTS_PROTOCOL_FRAME_TOO_LARGE",
            "response exceeds the 4 MiB frame limit",
            true,
        ));
    }
    let length = u32::try_from(payload.len()).expect("4 MiB payload fits uint32");
    writer
        .write_all(&length.to_be_bytes())
        .and_then(|_| writer.write_all(payload.as_bytes()))
        .and_then(|_| writer.flush())
        .map_err(|_| {
            ProtocolError::new(
                "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
                "failed to write protocol frame",
                true,
            )
        })
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_FRAME_BYTES, MessageKind, PROTOCOL_FORMAT, ProtocolError, read_frame,
        validate_protocol_message, write_frame,
    };
    use crate::canonical_json;
    use serde::Deserialize;
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::io::Cursor;
    use std::path::PathBuf;

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct Fixture {
        format: String,
        protocol_version: u64,
        frames: Vec<FrameVector>,
    }

    #[derive(Deserialize)]
    #[serde(rename_all = "camelCase")]
    struct FrameVector {
        name: String,
        message: Value,
        payload_byte_length: usize,
        payload_sha256: String,
        length_prefix_hex: String,
        canonical_payload: String,
    }

    fn fixture() -> Fixture {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/insights-protocol-v1/frames.json");
        serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap()
    }

    #[test]
    fn matches_shared_protocol_frame_vectors() {
        let fixture = fixture();
        assert_eq!(fixture.format, "threadshare-insights-protocol-frames@v1");
        assert_eq!(fixture.protocol_version, 1);
        for vector in fixture.frames {
            let kind = validate_protocol_message(&vector.message).unwrap();
            assert_eq!(kind.as_str(), vector.message["type"].as_str().unwrap());
            let canonical = canonical_json(&vector.message);
            assert_eq!(canonical, vector.canonical_payload, "{}", vector.name);
            assert_eq!(
                canonical.len(),
                vector.payload_byte_length,
                "{}",
                vector.name
            );
            assert_eq!(
                hex::encode(Sha256::digest(canonical.as_bytes())),
                vector.payload_sha256,
                "{}",
                vector.name
            );
            let mut bytes = Vec::new();
            write_frame(&mut bytes, &vector.message).unwrap();
            assert_eq!(
                hex::encode(&bytes[..4]),
                vector.length_prefix_hex,
                "{}",
                vector.name
            );
            assert_eq!(
                read_frame(&mut Cursor::new(bytes)).unwrap().unwrap(),
                vector.message,
                "{}",
                vector.name
            );
        }
    }

    #[test]
    fn validates_v2_session_counts_without_widening_v1() {
        let mut begin = fixture()
            .frames
            .into_iter()
            .find(|frame| frame.name == "begin-session")
            .unwrap()
            .message;
        begin["counts"]["historyEvents"] = Value::String("0".to_owned());
        assert_eq!(
            validate_protocol_message(&begin).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );

        begin["deltaFormat"] = Value::String("session-facts-delta@v2".to_owned());
        begin["contract"]["factSchemaVersion"] = Value::from(2);
        begin["contract"]["providerAdapterVersion"] = Value::String("codex@3".to_owned());
        begin["contract"]["privacyPolicyVersion"] = Value::from(2);
        begin["counts"]["historyPayloads"] = Value::String("0".to_owned());
        begin["counts"]["historyPayloadChunks"] = Value::String("0".to_owned());
        assert_eq!(
            validate_protocol_message(&begin).unwrap(),
            MessageKind::BeginSession
        );
    }

    #[test]
    fn validates_trace_source_frames_without_widening_session_batches() {
        let begin = json!({
            "format": PROTOCOL_FORMAT,
            "type": "BEGIN_TRACE_SOURCE",
            "requestId": "41",
            "deltaFormat": crate::delivery_graph_repository::TRACE_SOURCE_DELTA_FORMAT,
            "deltaId": "2".repeat(64),
            "expectedGeneration": "0",
            "targetGeneration": "1",
            "repository": {
                "repositoryId": "11111111-1111-4111-8111-111111111111",
                "repositoryKey": "1".repeat(64),
                "available": true,
                "refDigest": "3".repeat(64),
                "scmProvider": "github",
                "webBaseUrl": "https://github.com",
                "repositoryPath": "team-harness/threadshare",
                "projectKeys": ["1".repeat(64), "2".repeat(64)]
            },
            "intent": null,
            "counts": {
                "refs": "1",
                "commits": "1",
                "files": "1",
                "intentNodes": "0",
                "intentRefs": "0"
            }
        });
        assert_eq!(
            validate_protocol_message(&begin).unwrap(),
            MessageKind::BeginTraceSource
        );

        let batch = json!({
            "format": PROTOCOL_FORMAT,
            "type": "TRACE_SOURCE_BATCH",
            "requestId": "41",
            "sequence": "0",
            "collection": "refs",
            "items": [{ "name": "refs/heads/main", "objectId": "a".repeat(40) }]
        });
        assert_eq!(
            validate_protocol_message(&batch).unwrap(),
            MessageKind::TraceSourceBatch
        );
        let mut invalid = batch.clone();
        invalid["collection"] = Value::String("turns".to_owned());
        assert_eq!(
            validate_protocol_message(&invalid).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
        let mut unknown = begin;
        unknown["unexpected"] = Value::Bool(true);
        assert_eq!(
            validate_protocol_message(&unknown).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
    }

    #[test]
    fn accepts_overlapping_observed_eof_groups_without_double_counting_confidence() {
        let mut message = fixture()
            .frames
            .into_iter()
            .find(|frame| frame.name == "turn-search-results")
            .unwrap()
            .message;
        message["evidencePaths"] = json!({
            "insufficientSample": false,
            "pathsTruncated": false,
            "rawMatchCount": 5,
            "eligibleTurnCount": 5,
            "rawSessionCount": 3,
            "independentGroupCount": 3,
            "strongGroupCount": 2,
            "weakGroupCount": 1,
            "observedEofProvisionalGroupCount": 1,
            "unknownDedupeCount": 0,
            "unknownDedupeSessionCount": 0,
            "families": [{
                "fingerprint": "1".repeat(64),
                "nodes": [{"providerScopedName": "codex:Bash", "repeatBucket": "1"}],
                "truncated": false,
                "bestRelevancePpm": 900000,
                "turnCount": 5,
                "rawSessionCount": 3,
                "independentGroupCount": 3,
                "strongGroupCount": 2,
                "weakGroupCount": 1,
                "observedEofProvisionalGroupCount": 1,
                "unknownDedupeSessionCount": 0,
                "latestUnixMs": 1786320000000_u64,
                "toolStateCounts": {
                    "pending": 0,
                    "completed": 5,
                    "failed": 0,
                    "cancelled": 0,
                    "unknown": 0
                },
                "deliveryOutcome": {
                    "directCommitTurnCount": 3,
                    "observedCommitTurnCount": 1,
                    "noDeliveryTurnCount": 1,
                    "uncoveredTurnCount": 0
                },
                "evidenceTurnKeys": [
                    "1".repeat(64), "2".repeat(64), "3".repeat(64),
                    "4".repeat(64), "5".repeat(64)
                ]
            }]
        });

        assert_eq!(
            validate_protocol_message(&message).unwrap(),
            MessageKind::TurnSearchResults
        );
        // The four delivery counts partition the family's Turns. A Turn whose delivery could
        // not be observed belongs in `uncoveredTurnCount`; dropping it from every bucket would
        // read as "this path ships less than it does", so a sum that misses turnCount is
        // rejected rather than passed on to the reader.
        message["evidencePaths"]["families"][0]["deliveryOutcome"]["uncoveredTurnCount"] = json!(1);
        assert_eq!(
            validate_protocol_message(&message).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
        message["evidencePaths"]["families"][0]["deliveryOutcome"]["uncoveredTurnCount"] = json!(0);

        message["evidencePaths"]["families"][0]["weakGroupCount"] = json!(2);
        assert_eq!(
            validate_protocol_message(&message).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
    }

    #[test]
    fn rejects_oversized_length_before_allocating_payload() {
        let mut bytes = ((MAX_FRAME_BYTES + 1) as u32).to_be_bytes().to_vec();
        bytes.extend_from_slice(b"{}");
        let error = read_frame(&mut Cursor::new(bytes)).unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_PROTOCOL_FRAME_TOO_LARGE");
    }

    #[test]
    fn rejects_noncanonical_truncated_and_semantically_invalid_frames() {
        fn framed(payload: &[u8]) -> Vec<u8> {
            let mut bytes = (payload.len() as u32).to_be_bytes().to_vec();
            bytes.extend_from_slice(payload);
            bytes
        }
        let hello = fixture()
            .frames
            .into_iter()
            .find(|frame| frame.name == "hello")
            .unwrap()
            .message;
        let noncanonical = serde_json::to_vec_pretty(&hello).unwrap();
        assert_eq!(
            validate_protocol_message(&hello).unwrap(),
            MessageKind::Hello
        );
        assert_eq!(
            serde_json::from_slice::<Value>(&noncanonical).unwrap(),
            hello
        );
        assert_ne!(noncanonical, canonical_json(&hello).as_bytes());
        let error = read_frame(&mut Cursor::new(framed(&noncanonical))).unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_PROTOCOL_INVALID_FRAME");

        let truncated = framed(br#"{\"type\":\"HELLO\""#);
        let error: ProtocolError = read_frame(&mut Cursor::new(truncated)).unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_PROTOCOL_INVALID_FRAME");

        let mut hello = fixture()
            .frames
            .into_iter()
            .find(|frame| frame.name == "hello")
            .unwrap()
            .message;
        hello["future"] = Value::Bool(true);
        let payload = canonical_json(&hello);
        let error = read_frame(&mut Cursor::new(framed(payload.as_bytes()))).unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_PROTOCOL_INVALID_FRAME");

        let mut sequence = fixture()
            .frames
            .into_iter()
            .find(|frame| frame.name == "retract-facts")
            .unwrap()
            .message;
        sequence["sequence"] = Value::String("18446744073709551616".to_owned());
        assert_eq!(
            validate_protocol_message(&sequence).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
    }

    #[test]
    fn validates_every_message_kind_from_the_shared_fixture() {
        let kinds = fixture()
            .frames
            .into_iter()
            .map(|frame| validate_protocol_message(&frame.message).unwrap())
            .collect::<Vec<_>>();
        assert_eq!(
            kinds,
            [
                MessageKind::Hello,
                MessageKind::Ready,
                MessageKind::BeginSession,
                MessageKind::SessionAccepted,
                MessageKind::RetractFacts,
                MessageKind::UpsertFacts,
                MessageKind::BatchAccepted,
                MessageKind::CommitSession,
                MessageKind::ListSourceStates,
                MessageKind::SourceStates,
                MessageKind::ReadSourceCheckpoint,
                MessageKind::SourceCheckpoint,
                MessageKind::RemoveSource,
                MessageKind::SourceRemoved,
                MessageKind::ExcludeSource,
                MessageKind::SourceExcluded,
                MessageKind::ReadPurgeStatus,
                MessageKind::PurgeStatus,
                MessageKind::RunPurgeMaintenance,
                MessageKind::PurgeMaintenanceStatus,
                MessageKind::ReadEngineStatus,
                MessageKind::EngineStatus,
                MessageKind::SearchTurns,
                MessageKind::TurnSearchResults,
                MessageKind::ReadTurnEvidence,
                MessageKind::TurnEvidencePage,
                MessageKind::SessionCommitted,
                MessageKind::AbortSession,
                MessageKind::SessionAborted,
                MessageKind::Error,
                MessageKind::MemoryCommand,
                MessageKind::MemoryResult,
            ]
        );
    }

    #[test]
    fn rejects_unsorted_contract_arrays_and_non_ascii_names() {
        let mut hello = fixture()
            .frames
            .into_iter()
            .find(|frame| frame.name == "hello")
            .unwrap()
            .message;
        hello["requiredContract"]["providerAdapterVersions"] = json!(["codex@1", "claude@1"]);
        assert!(validate_protocol_message(&hello).is_err());
        hello["requiredContract"]["providerAdapterVersions"] = json!(["cödex@1"]);
        assert!(validate_protocol_message(&hello).is_err());
    }

    #[test]
    fn validates_bounded_read_only_engine_status_frames() {
        let request = json!({
            "format": PROTOCOL_FORMAT,
            "type": "READ_ENGINE_STATUS",
            "requestId": "9",
        });
        assert_eq!(
            validate_protocol_message(&request).unwrap(),
            MessageKind::ReadEngineStatus
        );

        let response = json!({
            "format": PROTOCOL_FORMAT,
            "type": "ENGINE_STATUS",
            "requestId": "9",
            "snapshotSeq": "17",
            "snapshotAgeMs": "1234",
            "snapshotPending": false,
            "factStorageProfile": "normalized-row-v1",
            "projections": [{
                "name": "turn-summary",
                "version": 1,
                "inputFactSchemaVersion": 1,
                "rootKind": "turn",
                "baseSnapshotSeq": "5",
                "watermark": "17",
                "status": "active",
                "errorDigest": null,
            }],
            "changeLog": {
                "rows": "2",
                "payloadBytes": "234",
                "maxRows": "1000000",
                "maxPayloadBytes": "67108864",
                "state": "within-cap",
            },
            "purge": {
                "state": "pending-purge",
                "pendingFacts": "1",
                "pendingMaintenance": "0",
                "purged": "0",
            },
            "storage": {
                "databaseBytes": "4096",
                "walBytes": "0",
                "walPressureAction": "none",
                "recentDiagnostic": null,
            },
            "integrity": { "quickCheck": "ok", "fts": "ok" },
        });
        assert_eq!(
            validate_protocol_message(&response).unwrap(),
            MessageKind::EngineStatus
        );

        let mut inconsistent = response;
        inconsistent["storage"]["walBytes"] = Value::String("134217728".to_owned());
        assert_eq!(
            validate_protocol_message(&inconsistent).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
    }

    #[test]
    fn validates_bounded_dashboard_overview_and_capability_frames() {
        let overview_request = json!({
            "format": PROTOCOL_FORMAT,
            "type": "READ_INSIGHTS_OVERVIEW",
            "requestId": "41",
            "nowUnixMs": "1786320000000",
            "quiescenceSeconds": 300,
        });
        assert_eq!(
            validate_protocol_message(&overview_request).unwrap(),
            MessageKind::ReadInsightsOverview
        );

        let overview = json!({
            "format": PROTOCOL_FORMAT,
            "type": "INSIGHTS_OVERVIEW",
            "requestId": "41",
            "snapshotSeq": "7",
            "sessions": {
                "raw": "3", "eligible": "1", "excluded": "1",
                "subagentExcluded": "1", "unknown": "0"
            },
            "scopes": {"main": "2", "subagent": "1", "unknown": "0"},
            "dedupe": {
                "strongGroup": "1", "weakGroup": "0",
                "observedEofProvisionalSession": "1", "unknownSession": "0"
            },
            "turns": {
                "indexed": "1", "active": "2", "rolledBack": "1",
                "unknownVisibility": "0", "hardSealed": "1", "quiescent": "0", "open": "0"
            },
            "capabilities": {"total": "1", "tool": "1", "skill": "0"},
            "providers": {"items": [{
                "provider": "codex", "rawSessionCount": "3",
                "eligibleSessionCount": "1", "indexedTurnCount": "1"
            }], "truncated": false},
            "projects": {"items": [{
                "projectKey": "a".repeat(64), "rawSessionCount": "2",
                "eligibleSessionCount": "1", "indexedTurnCount": "1"
            }], "truncated": false},
            "coverage": {"items": [{"key": "records", "count": "10"}], "truncated": false},
            "diagnostics": {"items": [{"code": "unknown-record", "count": "1"}], "truncated": false},
        });
        assert_eq!(
            validate_protocol_message(&overview).unwrap(),
            MessageKind::InsightsOverview
        );

        let list = json!({
            "format": PROTOCOL_FORMAT,
            "type": "LIST_CAPABILITIES",
            "requestId": "42",
            "kind": "tool",
            "cursor": null,
            "limit": 200,
        });
        assert_eq!(
            validate_protocol_message(&list).unwrap(),
            MessageKind::ListCapabilities
        );
        let page = json!({
            "format": PROTOCOL_FORMAT,
            "type": "CAPABILITY_PAGE",
            "requestId": "42",
            "databaseUuid": "11111111-2222-4333-8444-555555555555",
            "snapshotSeq": "7",
            "items": [{
                "capabilityKey": "b".repeat(64), "provider": "codex", "kind": "tool",
                "canonicalName": "Read", "useCount": "2", "turnCount": "2", "sessionCount": "1",
                "terminal": {"pending": "0", "completed": "1", "failed": "1", "cancelled": "0", "unknown": "0"},
                "strength": {"observed": "2", "confirmed": "0", "inferred": "0"}
            }],
            "nextCursor": null,
            "coverage": {
                "excludedUndatedInvocationCount": "2",
                "excludedUndatedTurnCount": "1",
                "excludedUnrevisionedInvocationCount": "3",
                "excludedUnrevisionedTurnCount": "2",
                "fullyExcludedCapabilityCount": "1"
            },
        });
        assert_eq!(
            validate_protocol_message(&page).unwrap(),
            MessageKind::CapabilityPage
        );

        let mut invalid_coverage = page.clone();
        invalid_coverage["coverage"]["fullyExcludedCapabilityCount"] = json!(1);
        assert_eq!(
            validate_protocol_message(&invalid_coverage)
                .unwrap_err()
                .code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );

        let mut inconsistent = page;
        inconsistent["items"][0]["terminal"]["failed"] = json!("0");
        assert_eq!(
            validate_protocol_message(&inconsistent).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
    }

    #[test]
    fn keeps_search_domain_rejections_out_of_frame_validation() {
        let mut request = fixture()
            .frames
            .into_iter()
            .find(|frame| frame.name == "search-turns")
            .unwrap()
            .message;
        request["query"] = Value::String("界".repeat(2_731));
        assert_eq!(
            validate_protocol_message(&request).unwrap(),
            MessageKind::SearchTurns
        );

        request["query"] = Value::String(String::new());
        request["filters"]["providers"] = json!([]);
        assert_eq!(
            validate_protocol_message(&request).unwrap(),
            MessageKind::SearchTurns
        );

        request["filters"]["providers"] = json!(["codex", "codex"]);
        assert_eq!(
            validate_protocol_message(&request).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );

        let mut response = fixture()
            .frames
            .into_iter()
            .find(|frame| frame.name == "turn-search-results")
            .unwrap()
            .message;
        response["databaseUuid"] = json!("11111111-2222-4333-8444-555555555555");
        response["orderBy"] = json!("relevance");
        response["totalMatchCount"] = json!("1");
        response["closureEvaluatedAt"] = json!("2026-08-11T00:00:00.000Z");
        response["quiescenceSeconds"] = json!(300);
        response["results"][0]["dedupe"] = json!({
            "duplicateGroupKey": "9".repeat(64),
            "confidence": "strong",
            "observedEofProvisional": false
        });
        assert_eq!(
            validate_protocol_message(&response).unwrap(),
            MessageKind::TurnSearchResults
        );

        response["orderBy"] = json!("observed-desc");
        assert_eq!(
            validate_protocol_message(&response).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
    }

    #[test]
    fn validates_search_order_and_capability_terminal_filters() {
        let mut request = fixture()
            .frames
            .into_iter()
            .find(|frame| frame.name == "search-turns")
            .unwrap()
            .message;
        request["orderBy"] = json!("observed-desc");
        request["filters"]["toolCapabilityKeys"] = json!(["1".repeat(64)]);
        request["filters"]["capabilityTerminalStates"] = json!(["completed", "failed"]);
        assert_eq!(
            validate_protocol_message(&request).unwrap(),
            MessageKind::SearchTurns
        );

        request["filters"]["toolCapabilityKeys"] = json!([]);
        assert_eq!(
            validate_protocol_message(&request).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
    }

    #[test]
    fn read_turn_evidence_requires_an_expected_revision() {
        let mut request = fixture()
            .frames
            .into_iter()
            .find(|frame| frame.name == "read-turn-evidence")
            .unwrap()
            .message;
        request["expectedRevision"] = Value::Null;

        assert_eq!(
            validate_protocol_message(&request).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
    }

    #[test]
    fn validates_bounded_usage_and_activity_requests() {
        let usage = json!({
            "format": PROTOCOL_FORMAT,
            "type": "READ_CAPABILITY_USAGE",
            "requestId": "12",
            "kind": "tool",
            "window": {
                "observedAtOrAfterUnixMs": "1785542400000",
                "observedBeforeUnixMs": "1788220800000"
            },
            "comparisonWindow": null,
            "filters": {
                "providers": ["codex"],
                "projectKeys": ["1".repeat(64)],
                "closureStates": ["hard-sealed"],
                "capabilityTerminalStates": ["failed"]
            },
            "orderBy": "recorded-failing-invocation-count",
            "cursor": null,
            "limit": 50,
            "nowUnixMs": "1786406400000",
            "quiescenceSeconds": 300
        });
        assert_eq!(
            validate_protocol_message(&usage).unwrap(),
            MessageKind::ReadCapabilityUsage
        );

        let activity = json!({
            "format": PROTOCOL_FORMAT,
            "type": "READ_INSIGHTS_ACTIVITY",
            "requestId": "13",
            "window": {
                "observedAtOrAfter": "2026-08-03T00:00:00.000Z",
                "observedBefore": "2026-08-17T00:00:00.000Z"
            },
            "filters": {
                "providers": [], "projectKeys": [], "closureStates": []
            },
            "bucket": "week",
            "timeZone": "UTC",
            "nowUnixMs": "1786406400000",
            "quiescenceSeconds": 300
        });
        assert_eq!(
            validate_protocol_message(&activity).unwrap(),
            MessageKind::ReadInsightsActivity
        );

        let mut extended_year = activity;
        extended_year["window"]["observedAtOrAfter"] = json!("+010000-08-03T00:00:00.000Z");
        extended_year["window"]["observedBefore"] = json!("+010000-08-17T00:00:00.000Z");
        assert_eq!(
            validate_protocol_message(&extended_year).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
    }

    #[test]
    fn validates_deep_query_and_evidence_v2_envelopes_without_widening_them() {
        let query = json!({
            "format": PROTOCOL_FORMAT,
            "type": "READ_INSIGHTS_QUERY_V2",
            "requestId": "70",
            "request": {
                "format": "threadshare-insights-query-request@v2",
                "resource": "event",
                "where": {"field":"event.kind","op":"eq","value":"visible-message"},
                "shape": {
                    "kind":"records",
                    "select":["eventKey","message.content"],
                    "payloadMode":"reference"
                },
                "orderBy":[
                    {"field":"observedAt","direction":"desc"},
                    {"field":"eventKey","direction":"asc"}
                ],
                "limit": 20,
                "cursor": null,
                "count": "none",
                "evaluatedAt": "2026-08-12T00:00:00.000Z"
            }
        });
        assert_eq!(
            validate_protocol_message(&query).unwrap(),
            MessageKind::ReadInsightsQueryV2
        );

        let mut widened = query.clone();
        widened["request"]["sql"] = json!("SELECT * FROM history_events");
        assert_eq!(
            validate_protocol_message(&widened).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
        let mut invalid_field = query;
        invalid_field["request"]["shape"]["select"] = json!(["metadataJson"]);
        assert_eq!(
            validate_protocol_message(&invalid_field).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );

        let evidence = json!({
            "format": PROTOCOL_FORMAT,
            "type": "READ_INSIGHTS_EVIDENCE_V2",
            "requestId": "71",
            "request": {
                "format": "threadshare-insights-evidence-request@v2",
                "target": {
                    "kind":"event",
                    "eventKey":"1".repeat(64),
                    "revision":"2".repeat(64),
                    "payloadKey":"3".repeat(64)
                },
                "include":["envelope","payload"],
                "cursor":null,
                "maxBytes":1048576
            }
        });
        assert_eq!(
            validate_protocol_message(&evidence).unwrap(),
            MessageKind::ReadInsightsEvidenceV2
        );
        let mut oversized = evidence;
        oversized["request"]["maxBytes"] = json!(1_048_577);
        assert_eq!(
            validate_protocol_message(&oversized).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
    }

    #[test]
    fn validates_bounded_usage_and_activity_responses() {
        let usage = json!({
            "format": PROTOCOL_FORMAT,
            "type": "CAPABILITY_USAGE",
            "requestId": "14",
            "databaseUuid": "11111111-2222-4333-8444-555555555555",
            "snapshotSeq": "7",
            "closureEvaluatedAt": "2026-08-11T00:00:00.000Z",
            "quiescenceSeconds": 300,
            "orderBy": "absolute-recorded-invocation-change",
            "items": [{
                "capabilityKey": "1".repeat(64),
                "provider": "codex",
                "kind": "tool",
                "canonicalName": "Read",
                "recordedInvocationCount": "7",
                "recordedFailingInvocationCount": "2",
                "distinctTurnCount": "5",
                "distinctSessionCount": "4",
                "lastUsedAt": "2026-08-10T01:02:03.000Z",
                "invocationTerminalCounts": {
                    "invocationTotal": "7", "pending": "0", "completed": "5",
                    "failed": "2", "cancelled": "0", "unknown": "0"
                },
                "containingTurnOutcomeCounts": {
                    "distinctTurnTotal": "5", "providerCompleted": "3",
                    "abandoned": "1", "unknown": "1"
                },
                "groupedInvocationCount": "5",
                "ungroupedInvocationCount": "2",
                "support": {
                    "distinctDedupeGroupCount": "3",
                    "strongDedupeGroupCount": "2",
                    "weakDedupeGroupCount": "1",
                    "observedEofProvisionalGroupCount": "1",
                    "unknownDedupeSessionCount": "1",
                    "sessionDuplicateMethodCounts": {
                        "explicitLineage": "2", "exactFirstTurnPrefix": "1"
                    }
                },
                "strengthCounts": {"observed": "5", "confirmed": "1", "inferred": "1"},
                "outOfWindow": {
                    "scope": "all-indexed-history",
                    "retrySummary": {
                        "failedCount": "9", "sameInputRepeatCount": "4",
                        "retryAfterFailureCount": "3"
                    }
                },
                "comparison": {
                    "baselineRecordedInvocationCount": "5",
                    "currentRecordedInvocationCount": "7",
                    "absoluteRecordedInvocationChange": "2"
                }
            }],
            "totalCandidateCount": "1",
            "truncated": false,
            "coverage": {
                "excludedUndatedInvocationCount": "1",
                "excludedUndatedTurnCount": "1",
                "excludedUnrevisionedInvocationCount": "2",
                "excludedUnrevisionedTurnCount": "2",
                "fullyExcludedCapabilityCount": "3"
            },
            "nextCursor": null
        });
        assert_eq!(
            validate_protocol_message(&usage).unwrap(),
            MessageKind::CapabilityUsage
        );

        let activity = json!({
            "format": PROTOCOL_FORMAT,
            "type": "INSIGHTS_ACTIVITY",
            "requestId": "15",
            "databaseUuid": "11111111-2222-4333-8444-555555555555",
            "snapshotSeq": "7",
            "closureEvaluatedAt": "2026-08-11T00:00:00.000Z",
            "quiescenceSeconds": 300,
            "buckets": [{
                "bucketStart": "2026-08-10T00:00:00.000Z",
                "bucketEnd": "2026-08-11T00:00:00.000Z",
                "distinctSessionCount": "4",
                "distinctTurnCount": "5",
                "currentClosureCounts": {"hardSealed": "2", "quiescent": "1", "open": "2"},
                "turnResultEvidenceCounts": {
                    "providerCompleted": "3", "abandoned": "1", "unknown": "1"
                },
                "recordedToolInvocationCount": "7",
                "recordedSkillInvocationCount": "3",
                "support": {
                    "distinctDedupeGroupCount": "3",
                    "strongDedupeGroupCount": "2",
                    "weakDedupeGroupCount": "1",
                    "observedEofProvisionalGroupCount": "1",
                    "unknownDedupeSessionCount": "1"
                }
            }],
            "coverage": {
                "excludedUndatedInvocationCount": "1",
                "excludedUndatedTurnCount": "1",
                "excludedUnrevisionedInvocationCount": "2",
                "excludedUnrevisionedTurnCount": "2"
            }
        });
        assert_eq!(
            validate_protocol_message(&activity).unwrap(),
            MessageKind::InsightsActivity
        );

        let mut inconsistent = usage;
        inconsistent["items"][0]["invocationTerminalCounts"]["failed"] = json!("1");
        assert_eq!(
            validate_protocol_message(&inconsistent).unwrap_err().code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
    }
}
