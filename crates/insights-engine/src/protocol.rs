use crate::try_canonical_json;
use serde_json::{Map, Value, json};
use std::fmt;
use std::io::{self, Read, Write};

pub const PROTOCOL_VERSION: u64 = 1;
pub const MAX_FRAME_BYTES: usize = 4_194_304;
pub const PROTOCOL_FORMAT: &str = "threadshare-insights-protocol@v1";

const MAX_SAFE_INTEGER: u64 = 9_007_199_254_740_991;
const MAX_ENGINE_STATUS_PROJECTIONS: usize = 1_024;
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
const COUNT_FIELDS: [&str; 10] = [
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
const RETRACTION_COLLECTIONS: [&str; 3] = ["turnKeys", "orphanEventKeys", "authoritativeTurnKeys"];
const UPSERT_COLLECTIONS: [&str; 7] = [
    "turns",
    "sourceRecords",
    "evidenceEvents",
    "turnEvidence",
    "capabilities",
    "capabilityUses",
    "capabilityUseEvidence",
];

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
    AbortSession,
    SessionAborted,
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
            Self::AbortSession => "ABORT_SESSION",
            Self::SessionAborted => "SESSION_ABORTED",
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
        Some("normalized-row-v1" | "packed-facts-v1")
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
        "ABORT_SESSION" => MessageKind::AbortSession,
        "SESSION_ABORTED" => MessageKind::SessionAborted,
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
            validate_envelope(
                message,
                kind,
                &[
                    "engineVersion",
                    "target",
                    "maxFrameBytes",
                    "sqliteVersion",
                    "sqliteCompileOptionsDigest",
                    "buildManifestDigest",
                    "acceptedContract",
                ],
            )?;
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
            if field(message, "deltaFormat", "BEGIN_SESSION")?.as_str()
                != Some("session-facts-delta@v1")
            {
                return Err(invalid_frame("BEGIN_SESSION.deltaFormat is unsupported"));
            }
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
            exact_object_keys(counts, "BEGIN_SESSION.counts", &COUNT_FIELDS)?;
            for count in COUNT_FIELDS {
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
            let allowed = if kind == MessageKind::RetractFacts {
                &RETRACTION_COLLECTIONS[..]
            } else {
                &UPSERT_COLLECTIONS[..]
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
    let supported = contract.get("factSchemaVersion").and_then(Value::as_u64) == Some(1)
        && contract.get("providerAdapterVersions") == Some(&json!(["claude@1", "codex@1"]))
        && contract.get("privacyPolicyVersion").and_then(Value::as_u64) == Some(1)
        && contract
            .get("duplicatePolicyVersion")
            .and_then(Value::as_u64)
            == Some(1)
        && contract.get("factStorageProfile").and_then(Value::as_str) == Some("normalized-row-v1")
        && contract.get("storageSchemaVersion").and_then(Value::as_u64) == Some(1)
        && contract.get("projectionVersions") == Some(&json!([]))
        && contract.get("analyzerCapabilities") == Some(&json!([]))
        && contract.get("rankerVersion").and_then(Value::as_u64) == Some(1);
    if !supported {
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
                MessageKind::SessionCommitted,
                MessageKind::AbortSession,
                MessageKind::SessionAborted,
                MessageKind::Error,
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
}
