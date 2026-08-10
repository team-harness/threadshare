use crate::fact_model::{Checkpoint, SessionFactsDeltaV1, StableKey, WireU64};
use crate::fact_projection::maintain_projection_change_log;
use crate::projection::{
    ProjectionChange, ProjectionChangeOperation, ProjectionRootKind, append_projection_change,
};
use crate::storage::StorageError;
use crate::try_canonical_json;
use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const MAX_SOURCE_STATE_PAGE_SIZE: u16 = 256;
pub const MAX_PURGE_MAINTENANCE_BATCH_SIZE: u16 = 256;
// Hex-encoded 12 KiB locators keep a worst-case response below the 4 MiB frame cap.
const MAX_SOURCE_STATE_RESPONSE_ITEMS: u16 = 128;
const MAX_SOURCE_LOCATOR_BYTES: usize = 12 * 1024;
const MAX_PROVIDER_ADAPTER_VERSION_BYTES: usize = 128;
const FINGERPRINT_BYTES: u64 = 4 * 1024;

const SOURCE_STATE_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS source_ingestion_states (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  state_json TEXT NOT NULL,
  state_digest BLOB NOT NULL CHECK(length(state_digest)=32)
);

CREATE TABLE IF NOT EXISTS source_ingestion_staging (
  session_key BLOB PRIMARY KEY CHECK(length(session_key)=32),
  state_json TEXT NOT NULL,
  state_digest BLOB NOT NULL CHECK(length(state_digest)=32)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS source_purge_states (
  session_key BLOB PRIMARY KEY CHECK(length(session_key)=32),
  purge_state TEXT NOT NULL CHECK(purge_state IN ('pending-facts','pending-maintenance','purged'))
) WITHOUT ROWID;

CREATE TRIGGER IF NOT EXISTS source_ingestion_publish_insert
AFTER INSERT ON source_checkpoints BEGIN
  DELETE FROM source_ingestion_states WHERE session_id=NEW.session_id;
  INSERT INTO source_ingestion_states(session_id,state_json,state_digest)
    SELECT NEW.session_id,staging.state_json,staging.state_digest
    FROM source_ingestion_staging AS staging
    JOIN sessions AS session ON session.session_key=staging.session_key
    WHERE session.session_id=NEW.session_id;
  DELETE FROM source_ingestion_staging
    WHERE session_key=(SELECT session_key FROM sessions WHERE session_id=NEW.session_id);
  DELETE FROM source_purge_states
    WHERE session_key=(SELECT session_key FROM sessions WHERE session_id=NEW.session_id);
END;

CREATE TRIGGER IF NOT EXISTS source_ingestion_publish_update
AFTER UPDATE ON source_checkpoints BEGIN
  DELETE FROM source_ingestion_states WHERE session_id=NEW.session_id;
  INSERT INTO source_ingestion_states(session_id,state_json,state_digest)
    SELECT NEW.session_id,staging.state_json,staging.state_digest
    FROM source_ingestion_staging AS staging
    JOIN sessions AS session ON session.session_key=staging.session_key
    WHERE session.session_id=NEW.session_id;
  DELETE FROM source_ingestion_staging
    WHERE session_key=(SELECT session_key FROM sessions WHERE session_id=NEW.session_id);
  DELETE FROM source_purge_states
    WHERE session_key=(SELECT session_key FROM sessions WHERE session_id=NEW.session_id);
END;
"#;

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceMetadata {
    pub dev: WireU64,
    pub ino: WireU64,
    pub size: WireU64,
    pub mtime_ns: WireU64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFingerprint {
    pub offset: WireU64,
    pub length: u16,
    pub sha256: StableKey,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceFingerprints {
    pub head: SourceFingerprint,
    pub boundary: SourceFingerprint,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceContract {
    pub fact_schema_version: u8,
    pub provider_adapter_version: String,
    pub privacy_policy_version: u8,
    pub duplicate_policy_version: u8,
    pub origin_secret_epoch: String,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceState {
    pub provider: String,
    pub session_id: String,
    pub file_utf8_hex: String,
    pub session_key: StableKey,
    pub project_key: Option<StableKey>,
    pub metadata: SourceMetadata,
    pub fingerprints: SourceFingerprints,
    pub contract: SourceContract,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceCheckpointSummary {
    pub complete_offset: WireU64,
    pub source_snapshot_stable: bool,
    pub generation: WireU64,
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SourceStateSummary {
    #[serde(flatten)]
    pub state: SourceState,
    pub checkpoint: SourceCheckpointSummary,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SourceStatePage {
    pub states: Vec<SourceStateSummary>,
    pub next_cursor: Option<StableKey>,
}

#[derive(Debug, Clone, Copy, Serialize, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum PurgeState {
    Idle,
    PendingPurge,
    Purged,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceRemovalOutcome {
    pub session_key: StableKey,
    pub removed: bool,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct SourceExclusionOutcome {
    pub session_key: StableKey,
    pub excluded: bool,
    pub purge_state: PurgeState,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PurgeStatus {
    pub state: PurgeState,
    pub pending_facts: String,
    pub pending_maintenance: String,
    pub purged: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct PurgeMaintenanceOutcome {
    pub processed_sessions: String,
    pub purged_sessions: String,
    pub status: PurgeStatus,
}

fn invalid(message: impl Into<String>) -> StorageError {
    StorageError::new("TS_INSIGHTS_INVALID_SOURCE_STATE", message)
}

fn corrupt(message: impl Into<String>) -> StorageError {
    StorageError::new("TS_INSIGHTS_STORAGE_CORRUPT", message)
}

fn valid_provider(value: &str) -> bool {
    matches!(value, "codex" | "claude")
}

fn valid_uuid(value: &str) -> bool {
    if value.len() != 36 || value != value.to_ascii_lowercase() {
        return false;
    }
    value.bytes().enumerate().all(|(index, byte)| {
        if matches!(index, 8 | 13 | 18 | 23) {
            byte == b'-'
        } else {
            byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte)
        }
    })
}

fn valid_locator_utf8_hex(value: &str) -> bool {
    if value.is_empty()
        || value.len() > MAX_SOURCE_LOCATOR_BYTES * 2
        || !value.len().is_multiple_of(2)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
    {
        return false;
    }
    let Ok(bytes) = hex::decode(value) else {
        return false;
    };
    let Ok(locator) = String::from_utf8(bytes) else {
        return false;
    };
    let bytes = locator.as_bytes();
    let portable_absolute = locator.starts_with('/')
        || locator.starts_with("\\\\")
        || (bytes.len() >= 3
            && bytes[0].is_ascii_alphabetic()
            && bytes[1] == b':'
            && matches!(bytes[2], b'/' | b'\\'));
    portable_absolute
        && !bytes.is_empty()
        && bytes.len() <= MAX_SOURCE_LOCATOR_BYTES
        && !locator.chars().any(char::is_control)
}

fn valid_adapter_version(value: &str) -> bool {
    !value.is_empty()
        && value.len() <= MAX_PROVIDER_ADAPTER_VERSION_BYTES
        && value.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
}

fn expected_fingerprint_length(end: WireU64) -> u64 {
    end.get().min(FINGERPRINT_BYTES)
}

impl SourceState {
    pub fn validate_identity(&self) -> Result<(), StorageError> {
        if !valid_provider(&self.provider)
            || !valid_uuid(&self.session_id)
            || !valid_locator_utf8_hex(&self.file_utf8_hex)
            || !valid_adapter_version(&self.contract.provider_adapter_version)
            || self.contract.fact_schema_version == 0
            || self.contract.privacy_policy_version == 0
            || self.contract.duplicate_policy_version == 0
            || !valid_uuid(&self.contract.origin_secret_epoch)
        {
            return Err(invalid("source state identity is invalid"));
        }
        Ok(())
    }

    pub fn validate_for_delta(&self, delta: &SessionFactsDeltaV1) -> Result<(), StorageError> {
        self.validate_identity()?;
        if self.provider != delta.session.provider
            || self.session_key != delta.session.session_key
            || self.project_key != delta.session.project_key
        {
            return Err(invalid("source state does not match the session Fact"));
        }
        if self.contract.fact_schema_version != delta.fact_schema_version
            || self.contract.provider_adapter_version != delta.provider_adapter_version
            || self.contract.privacy_policy_version != delta.privacy_policy_version
            || self.contract.duplicate_policy_version != delta.duplicate_policy_version
            || self.contract.origin_secret_epoch != delta.origin_secret_epoch
            || self.contract.origin_secret_epoch != delta.checkpoint.origin_secret_epoch
        {
            return Err(invalid("source state does not match the delta contract"));
        }
        if self.metadata.size != delta.checkpoint.source_size
            || self.metadata.mtime_ns != delta.checkpoint.source_mtime_ns
            || delta.checkpoint.generation != delta.target_generation
        {
            return Err(invalid("source metadata does not match the checkpoint"));
        }

        let head = &self.fingerprints.head;
        let boundary = &self.fingerprints.boundary;
        let expected_head = expected_fingerprint_length(delta.checkpoint.source_size);
        let expected_boundary = expected_fingerprint_length(delta.checkpoint.complete_offset);
        if head.offset != WireU64::ZERO
            || u64::from(head.length) != expected_head
            || u64::from(boundary.length) != expected_boundary
            || boundary
                .offset
                .get()
                .checked_add(u64::from(boundary.length))
                != Some(delta.checkpoint.complete_offset.get())
        {
            return Err(invalid("source fingerprints do not match the checkpoint"));
        }
        Ok(())
    }

    fn canonical(&self) -> Result<(String, [u8; 32]), StorageError> {
        let value =
            serde_json::to_value(self).map_err(|_| invalid("source state is not serializable"))?;
        let canonical = try_canonical_json(&value)
            .map_err(|_| invalid("source state is outside the canonical JSON domain"))?;
        let digest = Sha256::digest(canonical.as_bytes()).into();
        Ok((canonical, digest))
    }
}

impl SourceStateSummary {
    pub fn validate(&self) -> Result<(), StorageError> {
        self.state.validate_identity()?;
        if self.state.metadata.size.get() < self.checkpoint.complete_offset.get() {
            return Err(invalid("source state checkpoint exceeds the source size"));
        }
        let head = &self.state.fingerprints.head;
        let boundary = &self.state.fingerprints.boundary;
        if head.offset != WireU64::ZERO
            || u64::from(head.length) != expected_fingerprint_length(self.state.metadata.size)
            || u64::from(boundary.length)
                != expected_fingerprint_length(self.checkpoint.complete_offset)
            || boundary
                .offset
                .get()
                .checked_add(u64::from(boundary.length))
                != Some(self.checkpoint.complete_offset.get())
        {
            return Err(invalid("source state fingerprint geometry is invalid"));
        }
        Ok(())
    }
}

pub fn validate_checkpoint(checkpoint: &Checkpoint) -> Result<(), StorageError> {
    if checkpoint.complete_offset.get() > checkpoint.source_size.get()
        || checkpoint.partial_tail_length.get() > checkpoint.source_size.get()
        || !valid_uuid(&checkpoint.origin_secret_epoch)
    {
        return Err(invalid("source checkpoint is invalid"));
    }
    Ok(())
}

pub fn initialize_schema(connection: &Connection) -> Result<(), StorageError> {
    connection.execute_batch(SOURCE_STATE_SCHEMA)?;
    connection.execute("DELETE FROM source_ingestion_staging", [])?;
    Ok(())
}

pub fn stage_for_delta(
    connection: &Connection,
    delta: &SessionFactsDeltaV1,
    state: Option<&SourceState>,
) -> Result<Option<[u8; 32]>, StorageError> {
    let session_key = delta.session.session_key.as_bytes().to_vec();
    connection.execute(
        "DELETE FROM source_ingestion_staging WHERE session_key=?1",
        params![&session_key],
    )?;
    let Some(state) = state else {
        return Ok(None);
    };
    state.validate_for_delta(delta)?;
    let (canonical, digest) = state.canonical()?;
    connection.execute(
        "INSERT INTO source_ingestion_staging(session_key,state_json,state_digest)
         VALUES (?1,?2,?3)",
        params![&session_key, canonical, digest.to_vec()],
    )?;
    Ok(Some(digest))
}

pub fn finish_staged_commit(
    connection: &Connection,
    session_key: StableKey,
    expected_digest: Option<[u8; 32]>,
    idempotent: bool,
) -> Result<(), StorageError> {
    let key = session_key.as_bytes().to_vec();
    let result = (|| {
        if let Some(expected_digest) = expected_digest {
            let actual = connection
                .query_row(
                    "SELECT state.state_digest
                     FROM source_ingestion_states AS state
                     JOIN sessions AS session ON session.session_id=state.session_id
                     WHERE session.session_key=?1",
                    params![&key],
                    |row| row.get::<_, Vec<u8>>(0),
                )
                .optional()?;
            if actual.as_deref() != Some(expected_digest.as_slice()) {
                let message = if idempotent {
                    "the committed deltaId belongs to different source state"
                } else {
                    "source state was not published with the session checkpoint"
                };
                return Err(StorageError::new(
                    "TS_INSIGHTS_SOURCE_STATE_CONFLICT",
                    message,
                ));
            }
        }
        Ok(())
    })();
    connection.execute(
        "DELETE FROM source_ingestion_staging WHERE session_key=?1",
        params![&key],
    )?;
    result
}

pub fn discard_staged(connection: &Connection, session_key: StableKey) {
    let _ = connection.execute(
        "DELETE FROM source_ingestion_staging WHERE session_key=?1",
        params![session_key.as_bytes().to_vec()],
    );
}

fn wire_blob(row: &Row<'_>, index: usize) -> rusqlite::Result<WireU64> {
    let bytes = row.get::<_, Vec<u8>>(index)?;
    WireU64::from_be_blob(&bytes).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            bytes.len(),
            rusqlite::types::Type::Blob,
            Box::new(error),
        )
    })
}

fn key_blob(row: &Row<'_>, index: usize) -> rusqlite::Result<StableKey> {
    let bytes = row.get::<_, Vec<u8>>(index)?;
    let array: [u8; 32] = bytes.as_slice().try_into().map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(
            bytes.len(),
            rusqlite::types::Type::Blob,
            "stable key BLOB must contain 32 bytes".into(),
        )
    })?;
    Ok(StableKey::from_bytes(array))
}

fn parse_stored_state(value: String) -> Result<SourceState, StorageError> {
    serde_json::from_str(&value).map_err(|_| corrupt("stored source state is invalid"))
}

pub fn list_source_states(
    connection: &Connection,
    cursor: Option<StableKey>,
    limit: u16,
) -> Result<SourceStatePage, StorageError> {
    if limit == 0 || limit > MAX_SOURCE_STATE_PAGE_SIZE {
        return Err(invalid("source state page limit is outside 1..=256"));
    }
    let cursor = cursor.map(|value| value.as_bytes().to_vec());
    let effective_limit = limit.min(MAX_SOURCE_STATE_RESPONSE_ITEMS);
    let mut statement = connection.prepare(
        "SELECT session.session_key,state.state_json,checkpoint.complete_offset,
                checkpoint.source_snapshot_stable,checkpoint.generation
         FROM source_ingestion_states AS state
         JOIN sessions AS session ON session.session_id=state.session_id
         JOIN source_checkpoints AS checkpoint ON checkpoint.session_id=state.session_id
         WHERE (?1 IS NULL OR session.session_key>?1)
         ORDER BY session.session_key ASC
         LIMIT ?2",
    )?;
    let rows = statement.query_map(params![cursor, i64::from(effective_limit) + 1], |row| {
        Ok((
            key_blob(row, 0)?,
            row.get::<_, String>(1)?,
            wire_blob(row, 2)?,
            row.get::<_, bool>(3)?,
            wire_blob(row, 4)?,
        ))
    })?;
    let mut states = Vec::with_capacity(usize::from(effective_limit) + 1);
    for row in rows {
        let (session_key, state_json, complete_offset, source_snapshot_stable, generation) = row?;
        let state = parse_stored_state(state_json)?;
        if state.session_key != session_key {
            return Err(corrupt("stored source state sessionKey is inconsistent"));
        }
        states.push(SourceStateSummary {
            state,
            checkpoint: SourceCheckpointSummary {
                complete_offset,
                source_snapshot_stable,
                generation,
            },
        });
    }
    let has_more = states.len() > usize::from(effective_limit);
    if has_more {
        states.pop();
    }
    let next_cursor = has_more
        .then(|| states.last().map(|value| value.state.session_key))
        .flatten();
    Ok(SourceStatePage {
        states,
        next_cursor,
    })
}

pub fn read_source_checkpoint(
    connection: &Connection,
    session_key: StableKey,
) -> Result<Option<Checkpoint>, StorageError> {
    let row = connection
        .query_row(
            "SELECT checkpoint.complete_offset,checkpoint.eof_observed,
                    checkpoint.partial_tail_length,checkpoint.partial_tail_digest,
                    checkpoint.source_size,checkpoint.source_mtime_ns,
                    checkpoint.source_snapshot_stable,checkpoint.origin_secret_epoch,
                    checkpoint.generation,checkpoint.pending_state_json
             FROM source_ingestion_states AS state
             JOIN sessions AS session ON session.session_id=state.session_id
             JOIN source_checkpoints AS checkpoint ON checkpoint.session_id=state.session_id
             WHERE session.session_key=?1",
            params![session_key.as_bytes().to_vec()],
            |row| {
                Ok((
                    wire_blob(row, 0)?,
                    row.get::<_, bool>(1)?,
                    wire_blob(row, 2)?,
                    key_blob(row, 3)?,
                    wire_blob(row, 4)?,
                    wire_blob(row, 5)?,
                    row.get::<_, bool>(6)?,
                    row.get::<_, String>(7)?,
                    wire_blob(row, 8)?,
                    row.get::<_, String>(9)?,
                ))
            },
        )
        .optional()?;
    row.map(|value| {
        Ok(Checkpoint {
            complete_offset: value.0,
            eof_observed: value.1,
            partial_tail_length: value.2,
            partial_tail_digest: value.3,
            source_size: value.4,
            source_mtime_ns: value.5,
            source_snapshot_stable: value.6,
            origin_secret_epoch: value.7,
            generation: value.8,
            pending_state: serde_json::from_str(&value.9)
                .map_err(|_| corrupt("stored source checkpoint is invalid"))?,
        })
    })
    .transpose()
}

fn next_snapshot_seq(transaction: &Transaction<'_>) -> Result<i64, StorageError> {
    transaction
        .query_row(
            "UPDATE engine_metadata SET value=CAST(value AS INTEGER)+1
             WHERE key='snapshot_seq' RETURNING CAST(value AS INTEGER)",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn session_id(
    transaction: &Transaction<'_>,
    session_key: StableKey,
) -> Result<Option<i64>, StorageError> {
    transaction
        .query_row(
            "SELECT session_id FROM sessions WHERE session_key=?1",
            params![session_key.as_bytes().as_slice()],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

fn session_turns(
    transaction: &Transaction<'_>,
    session_id: i64,
) -> Result<Vec<(i64, StableKey)>, StorageError> {
    let mut statement = transaction
        .prepare("SELECT turn_id,turn_key FROM turns WHERE session_id=?1 ORDER BY turn_key")?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((row.get::<_, i64>(0)?, key_blob(row, 1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn session_capability_keys(
    transaction: &Transaction<'_>,
    session_id: i64,
) -> Result<BTreeSet<StableKey>, StorageError> {
    let mut statement = transaction.prepare(
        "SELECT DISTINCT capability_key FROM (
           SELECT c.capability_key AS capability_key
             FROM capabilities c JOIN capability_uses u ON u.capability_id=c.capability_id
            WHERE u.session_id=?1
           UNION
           SELECT c.capability_key
             FROM capabilities c
             JOIN capability_invocation_events p ON p.capability_id=c.capability_id
             JOIN evidence_events e ON e.event_id=p.event_id
            WHERE e.session_id=?1
           UNION
           SELECT c.capability_key
             FROM capabilities c
             JOIN skill_catalog_entry_events p ON p.capability_id=c.capability_id
             JOIN evidence_events e ON e.event_id=p.event_id
            WHERE e.session_id=?1
           UNION
           SELECT c.capability_key
             FROM capabilities c
             JOIN skill_load_events p ON p.capability_id=c.capability_id
             JOIN evidence_events e ON e.event_id=p.event_id
            WHERE e.session_id=?1
           UNION
           SELECT c.capability_key
             FROM capabilities c
             JOIN checkpoint_capability_pins p ON p.capability_id=c.capability_id
            WHERE p.session_id=?1
         ) ORDER BY capability_key",
    )?;
    let rows = statement
        .query_map([session_id], |row| key_blob(row, 0))?
        .collect::<Result<BTreeSet<_>, _>>()?;
    Ok(rows)
}

fn delete_turn_projections(
    transaction: &Transaction<'_>,
    turns: &[(i64, StableKey)],
) -> Result<(), StorageError> {
    for (turn_id, _) in turns {
        crate::projection::delete_turn_projection(transaction, *turn_id)?;
    }
    Ok(())
}

fn collect_capability_garbage(transaction: &Transaction<'_>) -> Result<(), StorageError> {
    let mut statement = transaction.prepare(
        "SELECT capability_id FROM capabilities
         WHERE NOT EXISTS(SELECT 1 FROM capability_uses u WHERE u.capability_id=capabilities.capability_id)
           AND NOT EXISTS(SELECT 1 FROM capability_invocation_events e WHERE e.capability_id=capabilities.capability_id)
           AND NOT EXISTS(SELECT 1 FROM skill_catalog_entry_events e WHERE e.capability_id=capabilities.capability_id)
           AND NOT EXISTS(SELECT 1 FROM skill_load_events e WHERE e.capability_id=capabilities.capability_id)
           AND NOT EXISTS(SELECT 1 FROM checkpoint_capability_pins p WHERE p.capability_id=capabilities.capability_id)",
    )?;
    let candidates = statement
        .query_map([], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for capability_id in candidates {
        transaction.execute(
            "DELETE FROM capabilities WHERE capability_id=?1",
            [capability_id],
        )?;
    }
    Ok(())
}

fn append_change(
    transaction: &Transaction<'_>,
    snapshot_seq: i64,
    session_key: StableKey,
    root_kind: ProjectionRootKind,
    root_key: StableKey,
    operation: ProjectionChangeOperation,
) -> Result<(), StorageError> {
    append_projection_change(
        transaction,
        &ProjectionChange {
            snapshot_seq,
            owner_session_key: session_key.as_bytes(),
            root_kind,
            root_key: root_key.as_bytes(),
            operation,
        },
    )?;
    Ok(())
}

fn delete_session_facts(
    transaction: &Transaction<'_>,
    session_key: StableKey,
) -> Result<bool, StorageError> {
    let Some(session_id) = session_id(transaction, session_key)? else {
        return Ok(false);
    };
    let turns = session_turns(transaction, session_id)?;
    let capability_keys = session_capability_keys(transaction, session_id)?;
    delete_turn_projections(transaction, &turns)?;
    transaction.execute("DELETE FROM sessions WHERE session_id=?1", [session_id])?;
    collect_capability_garbage(transaction)?;

    let snapshot_seq = next_snapshot_seq(transaction)?;
    append_change(
        transaction,
        snapshot_seq,
        session_key,
        ProjectionRootKind::Session,
        session_key,
        ProjectionChangeOperation::Tombstone,
    )?;
    for (_, turn_key) in turns {
        append_change(
            transaction,
            snapshot_seq,
            session_key,
            ProjectionRootKind::Turn,
            turn_key,
            ProjectionChangeOperation::Tombstone,
        )?;
    }
    for capability_key in capability_keys {
        let exists = transaction
            .query_row(
                "SELECT 1 FROM capabilities WHERE capability_key=?1",
                params![capability_key.as_bytes().as_slice()],
                |_| Ok(()),
            )
            .optional()?
            .is_some();
        append_change(
            transaction,
            snapshot_seq,
            session_key,
            ProjectionRootKind::Capability,
            capability_key,
            if exists {
                ProjectionChangeOperation::Upsert
            } else {
                ProjectionChangeOperation::Tombstone
            },
        )?;
    }
    maintain_projection_change_log(transaction, snapshot_seq)?;
    Ok(true)
}

pub fn remove_source(
    connection: &mut Connection,
    session_key: StableKey,
) -> Result<SourceRemovalOutcome, StorageError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let had_lifecycle = transaction.execute(
        "DELETE FROM source_purge_states WHERE session_key=?1",
        params![session_key.as_bytes().as_slice()],
    )? != 0;
    let removed = delete_session_facts(&transaction, session_key)? || had_lifecycle;
    transaction.commit()?;
    Ok(SourceRemovalOutcome {
        session_key,
        removed,
    })
}

pub fn exclude_source(
    connection: &mut Connection,
    session_key: StableKey,
) -> Result<SourceExclusionOutcome, StorageError> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some(session_id) = session_id(&transaction, session_key)? else {
        let purge_state = transaction
            .query_row(
                "SELECT purge_state FROM source_purge_states WHERE session_key=?1",
                params![session_key.as_bytes().as_slice()],
                |row| row.get::<_, String>(0),
            )
            .optional()?;
        transaction.commit()?;
        return Ok(SourceExclusionOutcome {
            session_key,
            excluded: false,
            purge_state: if purge_state.as_deref() == Some("purged") {
                PurgeState::Purged
            } else if purge_state.is_some() {
                PurgeState::PendingPurge
            } else {
                PurgeState::Idle
            },
        });
    };

    let already_pending = transaction
        .query_row(
            "SELECT purge_state FROM source_purge_states WHERE session_key=?1",
            params![session_key.as_bytes().as_slice()],
            |row| row.get::<_, String>(0),
        )
        .optional()?
        .is_some_and(|value| value == "pending-facts");
    if !already_pending {
        let turns = session_turns(&transaction, session_id)?;
        delete_turn_projections(&transaction, &turns)?;
        transaction.execute(
            "UPDATE sessions SET eligibility='excluded' WHERE session_id=?1",
            [session_id],
        )?;
        transaction.execute(
            "INSERT INTO source_purge_states(session_key,purge_state)
             VALUES (?1,'pending-facts')
             ON CONFLICT(session_key) DO UPDATE SET purge_state='pending-facts'",
            params![session_key.as_bytes().as_slice()],
        )?;
        let snapshot_seq = next_snapshot_seq(&transaction)?;
        append_change(
            &transaction,
            snapshot_seq,
            session_key,
            ProjectionRootKind::Session,
            session_key,
            ProjectionChangeOperation::Upsert,
        )?;
        for (_, turn_key) in turns {
            append_change(
                &transaction,
                snapshot_seq,
                session_key,
                ProjectionRootKind::Turn,
                turn_key,
                ProjectionChangeOperation::Tombstone,
            )?;
        }
        crate::insights_overview::refresh_session_overview_rollup(&transaction, session_id)?;
        maintain_projection_change_log(&transaction, snapshot_seq)?;
    }
    transaction.commit()?;
    Ok(SourceExclusionOutcome {
        session_key,
        excluded: true,
        purge_state: PurgeState::PendingPurge,
    })
}

fn purge_counts(
    connection: &Connection,
    session_key: Option<StableKey>,
) -> Result<PurgeStatus, StorageError> {
    let key = session_key.map(|value| value.as_bytes().to_vec());
    let (pending_facts, pending_maintenance, purged) = connection.query_row(
        "SELECT
           COALESCE(SUM(purge_state='pending-facts'),0),
           COALESCE(SUM(purge_state='pending-maintenance'),0),
           COALESCE(SUM(purge_state='purged'),0)
         FROM source_purge_states
         WHERE (?1 IS NULL OR session_key=?1)",
        params![key],
        |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
            ))
        },
    )?;
    let pending_facts = u64::try_from(pending_facts)
        .map_err(|_| corrupt("stored pending-facts count is invalid"))?;
    let pending_maintenance = u64::try_from(pending_maintenance)
        .map_err(|_| corrupt("stored pending-maintenance count is invalid"))?;
    let purged = u64::try_from(purged).map_err(|_| corrupt("stored purged count is invalid"))?;
    Ok(PurgeStatus {
        state: if pending_facts != 0 || pending_maintenance != 0 {
            PurgeState::PendingPurge
        } else if purged != 0 {
            PurgeState::Purged
        } else {
            PurgeState::Idle
        },
        pending_facts: pending_facts.to_string(),
        pending_maintenance: pending_maintenance.to_string(),
        purged: purged.to_string(),
    })
}

pub fn read_purge_status(
    connection: &Connection,
    session_key: Option<StableKey>,
) -> Result<PurgeStatus, StorageError> {
    purge_counts(connection, session_key)
}

fn checkpoint_truncate(connection: &Connection) -> Result<bool, StorageError> {
    let busy = connection.query_row("PRAGMA wal_checkpoint(TRUNCATE)", [], |row| {
        row.get::<_, i64>(0)
    })?;
    Ok(busy == 0)
}

pub fn run_purge_maintenance(
    connection: &mut Connection,
    limit: u16,
) -> Result<PurgeMaintenanceOutcome, StorageError> {
    if limit == 0 || limit > MAX_PURGE_MAINTENANCE_BATCH_SIZE {
        return Err(invalid("purge maintenance limit is outside 1..=256"));
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let mut statement = transaction.prepare(
        "SELECT session_key FROM source_purge_states
         WHERE purge_state='pending-facts'
         ORDER BY session_key ASC LIMIT ?1",
    )?;
    let session_keys = statement
        .query_map([i64::from(limit)], |row| key_blob(row, 0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for session_key in &session_keys {
        delete_session_facts(&transaction, *session_key)?;
        transaction.execute(
            "UPDATE source_purge_states SET purge_state='pending-maintenance'
             WHERE session_key=?1",
            params![session_key.as_bytes().as_slice()],
        )?;
    }
    #[cfg(debug_assertions)]
    crate::storage::test_crash_failpoint("before-purge-delete-commit");
    transaction.commit()?;
    #[cfg(debug_assertions)]
    crate::storage::test_crash_failpoint("after-purge-delete-commit");

    let mut purged_sessions = 0_u64;
    let status = purge_counts(connection, None)?;
    if status.pending_facts == "0" && status.pending_maintenance != "0" {
        connection.execute("INSERT INTO turns_fts(turns_fts) VALUES('optimize')", [])?;
        #[cfg(debug_assertions)]
        crate::storage::test_crash_failpoint("after-purge-fts-optimize");
        if checkpoint_truncate(connection)? {
            #[cfg(debug_assertions)]
            crate::storage::test_crash_failpoint("after-purge-checkpoint-before-vacuum");
            connection.execute_batch("VACUUM")?;
            #[cfg(debug_assertions)]
            crate::storage::test_crash_failpoint("after-purge-vacuum");
            if !checkpoint_truncate(connection)? {
                return Err(StorageError::new(
                    "TS_INSIGHTS_PURGE_PENDING",
                    "purge maintenance is waiting for the WAL checkpoint",
                ));
            }
            let transaction =
                connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
            let purged_count = transaction.query_row(
                "SELECT COUNT(*) FROM source_purge_states
                 WHERE purge_state='pending-maintenance'",
                [],
                |row| row.get::<_, i64>(0),
            )?;
            purged_sessions = u64::try_from(purged_count)
                .map_err(|_| corrupt("stored purge maintenance count is invalid"))?;
            transaction.execute(
                "UPDATE source_purge_states SET purge_state='purged'
                 WHERE purge_state='pending-maintenance'",
                [],
            )?;
            #[cfg(debug_assertions)]
            crate::storage::test_crash_failpoint("before-purge-finalize-commit");
            transaction.commit()?;
            #[cfg(debug_assertions)]
            crate::storage::test_crash_failpoint("after-purge-finalize-commit");
        }
    }

    let final_status = purge_counts(connection, None)?;
    if final_status.state == PurgeState::Purged && !checkpoint_truncate(connection)? {
        return Err(StorageError::new(
            "TS_INSIGHTS_PURGE_PENDING",
            "purge maintenance is waiting for the final WAL checkpoint",
        ));
    }

    Ok(PurgeMaintenanceOutcome {
        processed_sessions: session_keys.len().to_string(),
        purged_sessions: purged_sessions.to_string(),
        status: final_status,
    })
}

#[cfg(test)]
mod tests {
    use super::{
        FINGERPRINT_BYTES, PurgeState, SourceState, exclude_source, initialize_schema,
        list_source_states, read_purge_status, remove_source, run_purge_maintenance,
    };
    use crate::fact_model::{SessionFactsDeltaV1, StableKey};
    use rusqlite::{Connection, params};

    fn fixture_delta() -> SessionFactsDeltaV1 {
        let fixture: serde_json::Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
        ))
        .unwrap();
        serde_json::from_value(fixture["initial"].clone()).unwrap()
    }

    fn fixture_source_state(delta: &SessionFactsDeltaV1) -> SourceState {
        let boundary_offset = delta.checkpoint.complete_offset.get() - FINGERPRINT_BYTES;
        serde_json::from_value(serde_json::json!({
            "provider": delta.session.provider,
            "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "fileUtf8Hex": hex::encode("/tmp/session.jsonl"),
            "sessionKey": delta.session.session_key,
            "projectKey": delta.session.project_key,
            "metadata": {
                "dev": "1",
                "ino": "2",
                "size": delta.checkpoint.source_size,
                "mtimeNs": delta.checkpoint.source_mtime_ns,
            },
            "fingerprints": {
                "head": {"offset":"0", "length":4096, "sha256":"11".repeat(32)},
                "boundary": {
                    "offset":boundary_offset.to_string(),
                    "length":4096,
                    "sha256":"22".repeat(32)
                },
            },
            "contract": {
                "factSchemaVersion": delta.fact_schema_version,
                "providerAdapterVersion": delta.provider_adapter_version,
                "privacyPolicyVersion": delta.privacy_policy_version,
                "duplicatePolicyVersion": delta.duplicate_policy_version,
                "originSecretEpoch": delta.origin_secret_epoch,
            },
        }))
        .unwrap()
    }

    fn lifecycle_connection() -> (Connection, SessionFactsDeltaV1) {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE engine_metadata(key TEXT PRIMARY KEY,value TEXT NOT NULL) WITHOUT ROWID;
                 INSERT INTO engine_metadata(key,value) VALUES('snapshot_seq','0');",
            )
            .unwrap();
        crate::normalized_repository::initialize_schema(&mut connection).unwrap();
        initialize_schema(&connection).unwrap();
        let delta = fixture_delta();
        crate::normalized_repository::apply_session_facts(&mut connection, &delta).unwrap();
        let state = fixture_source_state(&delta);
        let (canonical, digest) = state.canonical().unwrap();
        let session_id: i64 = connection
            .query_row(
                "SELECT session_id FROM sessions WHERE session_key=?1",
                params![delta.session.session_key.as_bytes().as_slice()],
                |row| row.get(0),
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO source_ingestion_states(session_id,state_json,state_digest)
                 VALUES (?1,?2,?3)",
                params![session_id, canonical, digest.to_vec()],
            )
            .unwrap();
        (connection, delta)
    }

    #[test]
    fn source_state_schema_initializes_on_normalized_schema() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::normalized_repository::initialize_schema(&mut connection).unwrap();
        initialize_schema(&connection).unwrap();
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE name='source_ingestion_states'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn rejects_source_state_that_disagrees_with_delta() {
        let delta = fixture_delta();
        let boundary_offset = delta.checkpoint.complete_offset.get() - FINGERPRINT_BYTES;
        let mut value = serde_json::json!({
            "provider": delta.session.provider,
            "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            "fileUtf8Hex": hex::encode("/tmp/session.jsonl"),
            "sessionKey": delta.session.session_key,
            "projectKey": delta.session.project_key,
            "metadata": {
                "dev": "1",
                "ino": "2",
                "size": delta.checkpoint.source_size,
                "mtimeNs": delta.checkpoint.source_mtime_ns,
            },
            "fingerprints": {
                "head": {"offset":"0", "length":4096, "sha256":"11".repeat(32)},
                "boundary": {
                    "offset":boundary_offset.to_string(),
                    "length":4096,
                    "sha256":"22".repeat(32)
                },
            },
            "contract": {
                "factSchemaVersion": delta.fact_schema_version,
                "providerAdapterVersion": delta.provider_adapter_version,
                "privacyPolicyVersion": delta.privacy_policy_version,
                "duplicatePolicyVersion": delta.duplicate_policy_version,
                "originSecretEpoch": delta.origin_secret_epoch,
            },
        });
        let state: SourceState = serde_json::from_value(value.clone()).unwrap();
        state.validate_for_delta(&delta).unwrap();
        value["metadata"]["size"] = serde_json::Value::String("2".to_owned());
        let state: SourceState = serde_json::from_value(value).unwrap();
        assert_eq!(
            state.validate_for_delta(&delta).unwrap_err().code,
            "TS_INSIGHTS_INVALID_SOURCE_STATE"
        );
    }

    #[test]
    fn source_state_listing_is_stable_and_frame_safe() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::normalized_repository::initialize_schema(&mut connection).unwrap();
        initialize_schema(&connection).unwrap();
        let delta = fixture_delta();
        let pending = serde_json::to_string(&delta.checkpoint.pending_state).unwrap();
        for index in 0_u16..257 {
            let mut bytes = [0_u8; 32];
            bytes[30..].copy_from_slice(&index.to_be_bytes());
            let session_key = StableKey::from_bytes(bytes);
            connection.execute(
                "INSERT INTO sessions(
                   session_id,session_key,provider,session_scope,eligibility,duplicate_policy_version
                 ) VALUES (?1,?2,'codex','main','eligible',1)",
                params![i64::from(index) + 1, bytes.to_vec()],
            ).unwrap();
            connection
                .execute(
                    "INSERT INTO source_checkpoints(
                   session_id,complete_offset,eof_observed,partial_tail_length,
                   partial_tail_digest,source_size,source_mtime_ns,source_snapshot_stable,
                   origin_secret_epoch,generation,pending_state_json
                 ) VALUES (?1,?2,1,?3,?4,?2,?3,1,?5,?6,?7)",
                    params![
                        i64::from(index) + 1,
                        1_u64.to_be_bytes().to_vec(),
                        0_u64.to_be_bytes().to_vec(),
                        vec![0_u8; 32],
                        delta.origin_secret_epoch,
                        1_u64.to_be_bytes().to_vec(),
                        pending,
                    ],
                )
                .unwrap();
            let state: SourceState = serde_json::from_value(serde_json::json!({
                "provider": "codex",
                "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
                "fileUtf8Hex": hex::encode(format!("/tmp/session-{index}.jsonl")),
                "sessionKey": session_key,
                "projectKey": null,
                "metadata": {"dev":"1", "ino":"2", "size":"1", "mtimeNs":"0"},
                "fingerprints": {
                    "head": {"offset":"0", "length":1, "sha256":"11".repeat(32)},
                    "boundary": {"offset":"0", "length":1, "sha256":"22".repeat(32)},
                },
                "contract": {
                    "factSchemaVersion": 1,
                    "providerAdapterVersion": "codex@1",
                    "privacyPolicyVersion": 1,
                    "duplicatePolicyVersion": 1,
                    "originSecretEpoch": delta.origin_secret_epoch,
                },
            }))
            .unwrap();
            let (canonical, digest) = state.canonical().unwrap();
            connection
                .execute(
                    "INSERT INTO source_ingestion_states(session_id,state_json,state_digest)
                 VALUES (?1,?2,?3)",
                    params![i64::from(index) + 1, canonical, digest.to_vec()],
                )
                .unwrap();
        }

        let first = list_source_states(&connection, None, 256).unwrap();
        assert_eq!(first.states.len(), 128);
        assert_eq!(first.next_cursor, Some(first.states[127].state.session_key));
        let second = list_source_states(&connection, first.next_cursor, 256).unwrap();
        assert_eq!(second.states.len(), 128);
        assert_eq!(
            second.next_cursor,
            Some(second.states[127].state.session_key)
        );
        let third = list_source_states(&connection, second.next_cursor, 256).unwrap();
        assert_eq!(third.states.len(), 1);
        assert_eq!(third.next_cursor, None);
    }

    #[test]
    fn remove_source_atomically_deletes_facts_projections_and_source_state() {
        let (mut connection, delta) = lifecycle_connection();
        let outcome = remove_source(&mut connection, delta.session.session_key).unwrap();
        assert!(outcome.removed);
        for table in [
            "sessions",
            "turns",
            "source_records",
            "evidence_events",
            "capability_uses",
            "source_ingestion_states",
            "turn_fts_documents",
            "turn_rollup_contributions",
        ] {
            let count: i64 = connection
                .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                    row.get(0)
                })
                .unwrap();
            assert_eq!(count, 0, "{table} must be deleted");
        }
        assert_eq!(
            read_purge_status(&connection, Some(delta.session.session_key))
                .unwrap()
                .state,
            PurgeState::Idle
        );
        assert!(
            !remove_source(&mut connection, delta.session.session_key)
                .unwrap()
                .removed
        );
    }

    #[test]
    fn exclusion_hides_immediately_then_maintenance_reports_purged() {
        let (mut connection, delta) = lifecycle_connection();
        let outcome = exclude_source(&mut connection, delta.session.session_key).unwrap();
        assert!(outcome.excluded);
        assert_eq!(outcome.purge_state, PurgeState::PendingPurge);
        let eligibility: String = connection
            .query_row("SELECT eligibility FROM sessions", [], |row| row.get(0))
            .unwrap();
        assert_eq!(eligibility, "excluded");
        let facts: i64 = connection
            .query_row("SELECT COUNT(*) FROM turns", [], |row| row.get(0))
            .unwrap();
        let fts: i64 = connection
            .query_row("SELECT COUNT(*) FROM turn_fts_documents", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert!(facts > 0, "pending purge retains Facts until maintenance");
        assert_eq!(fts, 0, "excluded sessions must be immediately unsearchable");
        assert_eq!(
            read_purge_status(&connection, Some(delta.session.session_key))
                .unwrap()
                .state,
            PurgeState::PendingPurge
        );

        let maintenance = run_purge_maintenance(&mut connection, 1).unwrap();
        assert_eq!(maintenance.processed_sessions, "1");
        assert_eq!(maintenance.purged_sessions, "1");
        assert_eq!(maintenance.status.state, PurgeState::Purged);
        let sessions: i64 = connection
            .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
            .unwrap();
        let source_states: i64 = connection
            .query_row("SELECT COUNT(*) FROM source_ingestion_states", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!((sessions, source_states), (0, 0));
        assert_eq!(
            read_purge_status(&connection, Some(delta.session.session_key))
                .unwrap()
                .state,
            PurgeState::Purged
        );
    }
}
