use crate::fact_model::{
    CapabilityFact, CapabilityUseEvidenceFact, CapabilityUseFact, EvidenceEvent, HistoryEventFact,
    HistoryPayloadChunkFact, HistoryPayloadFact, ProviderStatusEvent, ProviderStatusKind,
    ProviderVisibility, SessionFactsDeltaV1, StableKey, TurnEvidenceFact, TurnEvidenceRole,
    TurnFact,
};
use crate::storage::StorageError;
use crate::{hash_key, try_canonical_json, try_write_canonical_json};
use rusqlite::{Connection, Transaction, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{self, Write};

pub const STAGED_FACT_CHUNK_BYTES: usize = 4 * 1024 * 1024;
const STAGED_FACT_CHUNK_ROWS: usize = 512;

const STAGING_SCHEMA: &str = r#"
CREATE TEMP TABLE IF NOT EXISTS session_fact_staging (
  collection TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  identity TEXT NOT NULL,
  parent_identity TEXT,
  wire_json TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  PRIMARY KEY(collection, ordinal),
  UNIQUE(collection, identity)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_fact_staging_parent
  ON session_fact_staging(collection,parent_identity,ordinal);
"#;

pub struct StagedSessionFacts {
    pub delta: SessionFactsDeltaV1,
    pub canonical_digest: [u8; 32],
}

#[derive(Debug)]
pub struct StageBatchOutcome {
    pub canonical_bytes: usize,
}

struct HashWriter(Sha256);

impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn invalid(message: impl Into<String>) -> StorageError {
    StorageError::new("TS_INSIGHTS_INVALID_DELTA", message)
}

pub fn initialize(connection: &Connection) -> Result<(), StorageError> {
    connection.execute_batch(STAGING_SCHEMA)?;
    connection.execute("DELETE FROM temp.session_fact_staging", [])?;
    Ok(())
}

pub fn clear(connection: &Connection) -> Result<(), StorageError> {
    connection.execute("DELETE FROM temp.session_fact_staging", [])?;
    Ok(())
}

pub fn count(connection: &Connection, collection: &str) -> Result<usize, StorageError> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM temp.session_fact_staging WHERE collection=?1",
        [collection],
        |row| row.get(0),
    )?;
    usize::try_from(count).map_err(|_| invalid("staged fact count exceeds platform limits"))
}

pub fn stage_batch(
    connection: &mut Connection,
    collection: &str,
    first_ordinal: usize,
    items: &[Value],
    session_key: &str,
    provider: &str,
) -> Result<StageBatchOutcome, StorageError> {
    let transaction = connection.savepoint()?;
    let mut canonical_bytes = 0_usize;
    for (offset, item) in items.iter().enumerate() {
        let wire_json = try_canonical_json(item)
            .map_err(|_| invalid("batch item is outside the canonical JSON domain"))?;
        canonical_bytes = canonical_bytes
            .checked_add(wire_json.len())
            .ok_or_else(|| invalid("batch canonical byte count exceeds platform limits"))?;
        if canonical_bytes > STAGED_FACT_CHUNK_BYTES {
            return Err(invalid("batch fact data exceeds the 4 MiB staging window"));
        }
        let (identity, parent_identity, normalized_json) =
            normalize_item(collection, item, session_key, provider)?;
        let ordinal = first_ordinal
            .checked_add(offset)
            .ok_or_else(|| invalid("staged fact ordinal exceeds platform limits"))?;
        let ordinal = i64::try_from(ordinal)
            .map_err(|_| invalid("staged fact ordinal exceeds platform limits"))?;
        let result = transaction.execute(
            "INSERT INTO temp.session_fact_staging(
               collection,ordinal,identity,parent_identity,wire_json,normalized_json
             ) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                collection,
                ordinal,
                identity,
                parent_identity,
                wire_json,
                normalized_json
            ],
        );
        if let Err(error) = result {
            if matches!(
                &error,
                rusqlite::Error::SqliteFailure(failure, _)
                    if failure.code == rusqlite::ffi::ErrorCode::ConstraintViolation
            ) {
                return Err(invalid(
                    "delta contains duplicate fact or retraction identities",
                ));
            }
            return Err(error.into());
        }
    }
    transaction.commit()?;
    Ok(StageBatchOutcome { canonical_bytes })
}

fn decode<T: DeserializeOwned + Serialize>(value: &Value) -> Result<(T, String), StorageError> {
    let typed: T = serde_json::from_value(value.clone())
        .map_err(|error| invalid(format!("invalid staged fact: {error}")))?;
    let normalized =
        serde_json::to_value(&typed).map_err(|_| invalid("staged fact is not serializable"))?;
    let canonical = try_canonical_json(&normalized)
        .map_err(|_| invalid("staged fact is outside the canonical JSON domain"))?;
    Ok((typed, canonical))
}

fn stable_identity(key: StableKey) -> String {
    key.to_string()
}

fn composite_identity(value: &impl Serialize) -> Result<String, StorageError> {
    let value = serde_json::to_value(value)
        .map_err(|_| invalid("staged fact identity is not serializable"))?;
    try_canonical_json(&value).map_err(|_| invalid("staged fact identity is invalid"))
}

fn normalize_item(
    collection: &str,
    value: &Value,
    session_key: &str,
    provider: &str,
) -> Result<(String, Option<String>, String), StorageError> {
    let owner = session_key
        .parse::<StableKey>()
        .map_err(|error| StorageError::new(error.code, error.message))?;
    match collection {
        "turnKeys" | "orphanEventKeys" | "authoritativeTurnKeys" => {
            let (key, canonical) = decode::<StableKey>(value)?;
            Ok((stable_identity(key), None, canonical))
        }
        "turns" => {
            let (fact, canonical) = decode::<TurnFact>(value)?;
            if fact.owner_session_key != owner
                || fact.problem_text.len() > 64 * 1_024
                || fact
                    .final_answer_excerpt
                    .as_ref()
                    .is_some_and(|excerpt| excerpt.len() > 8 * 1_024)
                || fact.provider_visibility == ProviderVisibility::RolledBack
            {
                return Err(invalid("delta contains a Turn outside its Fact bounds"));
            }
            Ok((stable_identity(fact.turn_key), None, canonical))
        }
        "sourceRecords" => {
            let (fact, canonical) = decode::<crate::fact_model::SourceRecordFact>(value)?;
            if fact.owner_session_key != owner {
                return Err(invalid(
                    "delta contains a source record owned by another session",
                ));
            }
            Ok((stable_identity(fact.source_record_key), None, canonical))
        }
        "evidenceEvents" => {
            let (fact, canonical) = decode::<EvidenceEvent>(value)?;
            let common = fact.common();
            if common.owner_session_key != owner
                || common.source_order.content_index < -1
                || common.pointer.content_index < -1
                || common.source_order.content_index != common.pointer.content_index
                || common.source_order.event_ordinal != common.pointer.event_ordinal
                || matches!(
                    fact,
                    EvidenceEvent::ProviderStatus(ProviderStatusEvent {
                        status_kind: ProviderStatusKind::ThreadRolledBack,
                        common: crate::fact_model::EventCommon {
                            occurred_turn_key: Some(_),
                            ..
                        },
                        ..
                    })
                )
            {
                return Err(invalid("delta contains an invalid evidence event"));
            }
            Ok((stable_identity(common.event_key), None, canonical))
        }
        "turnEvidence" => {
            let (fact, canonical) = decode::<TurnEvidenceFact>(value)?;
            if fact.owner_session_key != owner || fact.role == TurnEvidenceRole::Rollback {
                return Err(invalid("delta contains an invalid Turn evidence link"));
            }
            let identity = composite_identity(&(fact.turn_key, fact.event_key, fact.role))?;
            Ok((identity, None, canonical))
        }
        "capabilities" => {
            let (fact, canonical) = decode::<CapabilityFact>(value)?;
            if fact.identity_version != 1
                || fact.canonical_name.is_empty()
                || fact.canonical_name.len() > 512
                || fact.provider != provider
            {
                return Err(invalid("delta contains an invalid capability identity"));
            }
            Ok((stable_identity(fact.capability_key), None, canonical))
        }
        "capabilityUses" => {
            let (fact, canonical) = decode::<CapabilityUseFact>(value)?;
            if fact.owner_session_key != owner {
                return Err(invalid(
                    "delta contains a capability use owned by another session",
                ));
            }
            Ok((stable_identity(fact.use_key), None, canonical))
        }
        "capabilityUseEvidence" => {
            let (fact, canonical) = decode::<CapabilityUseEvidenceFact>(value)?;
            if fact.owner_session_key != owner {
                return Err(invalid(
                    "delta contains a capability evidence link owned by another session",
                ));
            }
            let identity = composite_identity(&(fact.use_key, fact.event_key, fact.role))?;
            Ok((identity, None, canonical))
        }
        "historyEvents" => {
            let (fact, canonical) = decode::<HistoryEventFact>(value)?;
            if fact.owner_session_key != owner
                || fact.kind.is_empty()
                || !fact.metadata.is_object()
                || fact.payload_keys.windows(2).any(|pair| pair[0] >= pair[1])
            {
                return Err(invalid("delta contains an invalid history event"));
            }
            Ok((stable_identity(fact.event_key), None, canonical))
        }
        "historyPayloads" => {
            let (fact, canonical) = decode::<HistoryPayloadFact>(value)?;
            if fact.owner_session_key != owner {
                return Err(invalid(
                    "delta contains a history payload owned by another session",
                ));
            }
            Ok((
                stable_identity(fact.payload_key),
                Some(stable_identity(fact.event_key)),
                canonical,
            ))
        }
        "historyPayloadChunks" => {
            let (fact, canonical) = decode::<HistoryPayloadChunkFact>(value)?;
            if fact.owner_session_key != owner
                || fact.content.len() > 64 * 1024
                || fact.content.len() != fact.byte_length.get() as usize
                || Sha256::digest(fact.content.as_bytes()).as_slice() != fact.sha256.as_bytes()
            {
                return Err(invalid("delta contains an invalid history payload chunk"));
            }
            let identity = composite_identity(&(fact.payload_key, fact.ordinal))?;
            Ok((identity, Some(stable_identity(fact.payload_key)), canonical))
        }
        _ => Err(invalid("unknown staged Fact collection")),
    }
}

pub fn prepare(
    connection: &Connection,
    wire_delta: Value,
) -> Result<StagedSessionFacts, StorageError> {
    let delta = SessionFactsDeltaV1::try_from(wire_delta.clone())
        .map_err(|error| StorageError::new(error.code, error.message))?;
    if delta.format == "session-facts-delta@v2" {
        validate_staged_history_facts(connection)?;
    }
    verify_delta_id(connection, &wire_delta, &delta)?;
    let normalized = delta
        .to_contract_value()
        .map_err(|error| StorageError::new(error.code, error.message))?;
    let canonical_digest = stream_digest(connection, &normalized, JsonColumn::Normalized, true)?;
    Ok(StagedSessionFacts {
        delta,
        canonical_digest,
    })
}

fn validate_staged_history_facts(connection: &Connection) -> Result<(), StorageError> {
    let missing_relation: i64 = connection.query_row(
        "SELECT EXISTS(
           SELECT 1
             FROM temp.session_fact_staging child
             LEFT JOIN temp.session_fact_staging parent
               ON parent.collection=CASE child.collection
                    WHEN 'historyPayloads' THEN 'historyEvents'
                    WHEN 'historyPayloadChunks' THEN 'historyPayloads'
                  END
              AND parent.identity=child.parent_identity
            WHERE child.collection IN ('historyPayloads','historyPayloadChunks')
              AND parent.identity IS NULL
         )",
        [],
        |row| row.get(0),
    )?;
    if missing_relation == 1 {
        return Err(invalid("history payload relation is incomplete"));
    }

    validate_staged_history_event_revisions(connection)?;
    validate_staged_history_payload_chunks(connection)
}

fn validate_staged_history_event_revisions(connection: &Connection) -> Result<(), StorageError> {
    let mut statement = connection.prepare(
        "SELECT event.normalized_json,payload.normalized_json
           FROM temp.session_fact_staging event
           LEFT JOIN temp.session_fact_staging payload INDEXED BY session_fact_staging_parent
             ON payload.collection='historyPayloads'
            AND payload.parent_identity=event.identity
          WHERE event.collection='historyEvents'
          ORDER BY event.identity,payload.identity",
    )?;
    let mut rows = statement.query([])?;
    let mut current: Option<HistoryEventFact> = None;
    let mut payloads = Vec::<HistoryPayloadFact>::new();
    while let Some(row) = rows.next()? {
        let event_json: String = row.get(0)?;
        let event: HistoryEventFact = serde_json::from_str(&event_json)
            .map_err(|_| invalid("staged history event became unreadable"))?;
        if current
            .as_ref()
            .is_some_and(|value| value.event_key != event.event_key)
        {
            validate_staged_history_event(current.take().unwrap(), &payloads)?;
            payloads.clear();
        }
        current = Some(event);
        if let Some(payload_json) = row.get::<_, Option<String>>(1)? {
            payloads.push(
                serde_json::from_str(&payload_json)
                    .map_err(|_| invalid("staged history payload became unreadable"))?,
            );
        }
    }
    if let Some(event) = current {
        validate_staged_history_event(event, &payloads)?;
    }
    Ok(())
}

fn validate_staged_history_event(
    event: HistoryEventFact,
    payloads: &[HistoryPayloadFact],
) -> Result<(), StorageError> {
    let payload_keys = payloads
        .iter()
        .map(|payload| payload.payload_key)
        .collect::<Vec<_>>();
    if payload_keys != event.payload_keys {
        return Err(invalid(
            "history event payload references do not match staged payloads",
        ));
    }
    let references = payloads.iter().collect::<Vec<_>>();
    let expected = crate::fact_model::expected_history_event_revision(&event, &references)
        .map_err(|error| invalid(error.message))?;
    if expected != event.revision {
        return Err(invalid(
            "history event revision does not match its envelope and payloads",
        ));
    }
    Ok(())
}

fn validate_staged_history_payload_chunks(connection: &Connection) -> Result<(), StorageError> {
    let mut statement = connection.prepare(
        "SELECT payload.normalized_json,chunk.normalized_json
           FROM temp.session_fact_staging payload
           LEFT JOIN temp.session_fact_staging chunk INDEXED BY session_fact_staging_parent
             ON chunk.collection='historyPayloadChunks'
            AND chunk.parent_identity=payload.identity
          WHERE payload.collection='historyPayloads'
          ORDER BY payload.identity,chunk.ordinal",
    )?;
    let mut rows = statement.query([])?;
    let mut current: Option<HistoryPayloadFact> = None;
    let mut next_ordinal = 0_u64;
    let mut byte_length = 0_u64;
    let mut digest = Sha256::new();
    while let Some(row) = rows.next()? {
        let payload_json: String = row.get(0)?;
        let payload: HistoryPayloadFact = serde_json::from_str(&payload_json)
            .map_err(|_| invalid("staged history payload became unreadable"))?;
        if current
            .as_ref()
            .is_some_and(|value| value.payload_key != payload.payload_key)
        {
            validate_staged_history_payload(
                current.take().unwrap(),
                next_ordinal,
                byte_length,
                digest,
            )?;
            next_ordinal = 0;
            byte_length = 0;
            digest = Sha256::new();
        }
        current = Some(payload);
        if let Some(chunk_json) = row.get::<_, Option<String>>(1)? {
            let chunk: HistoryPayloadChunkFact = serde_json::from_str(&chunk_json)
                .map_err(|_| invalid("staged history payload chunk became unreadable"))?;
            if chunk.ordinal.get() != next_ordinal {
                return Err(invalid("history payload chunks are not contiguous"));
            }
            next_ordinal = next_ordinal
                .checked_add(1)
                .ok_or_else(|| invalid("history payload chunk count exceeds uint64"))?;
            byte_length = byte_length
                .checked_add(chunk.byte_length.get())
                .ok_or_else(|| invalid("history payload is too large"))?;
            digest.update(chunk.content.as_bytes());
        }
    }
    if let Some(payload) = current {
        validate_staged_history_payload(payload, next_ordinal, byte_length, digest)?;
    }
    Ok(())
}

fn validate_staged_history_payload(
    payload: HistoryPayloadFact,
    chunk_count: u64,
    byte_length: u64,
    digest: Sha256,
) -> Result<(), StorageError> {
    if chunk_count != payload.chunk_count.get()
        || byte_length != payload.byte_length.get()
        || digest.finalize().as_slice() != payload.sha256.as_bytes()
    {
        return Err(invalid(
            "history payload digest or byte length does not match its chunks",
        ));
    }
    Ok(())
}

fn verify_delta_id(
    connection: &Connection,
    wire_delta: &Value,
    delta: &SessionFactsDeltaV1,
) -> Result<(), StorageError> {
    let mutation_digest = stream_digest(connection, wire_delta, JsonColumn::Wire, false)?;
    let expected = hash_key(
        "delta",
        &[
            delta.session.session_key.as_bytes().to_vec(),
            delta.expected_generation.to_string().into_bytes(),
            serde_json::to_value(delta.mode)
                .ok()
                .and_then(|value| value.as_str().map(str::as_bytes).map(ToOwned::to_owned))
                .ok_or_else(|| invalid("delta mode is invalid"))?,
            delta.origin_secret_epoch.as_bytes().to_vec(),
            delta.duplicate_policy_version.to_string().into_bytes(),
            mutation_digest.to_vec(),
            delta.checkpoint.complete_offset.to_string().into_bytes(),
        ],
    );
    if delta.delta_id.to_string() != expected {
        return Err(StorageError::new(
            "TS_INSIGHTS_INVALID_DELTA_ID",
            "deltaId does not match canonical mutation",
        ));
    }
    Ok(())
}

#[derive(Clone, Copy)]
enum JsonColumn {
    Wire,
    Normalized,
}

fn stream_digest(
    connection: &Connection,
    skeleton: &Value,
    column: JsonColumn,
    include_delta_id: bool,
) -> Result<[u8; 32], StorageError> {
    let object = skeleton
        .as_object()
        .ok_or_else(|| invalid("delta must be an object"))?;
    let mut keys = object.keys().collect::<Vec<_>>();
    keys.sort();
    let mut writer = HashWriter(Sha256::new());
    writer.write_all(b"{")?;
    let mut emitted = 0_usize;
    for key in keys {
        if key == "deltaId" && !include_delta_id {
            continue;
        }
        if emitted > 0 {
            writer.write_all(b",")?;
        }
        try_write_canonical_json(&mut writer, &Value::String(key.clone()))
            .map_err(|_| invalid("delta key is outside the canonical JSON domain"))?;
        writer.write_all(b":")?;
        if crate::protocol::is_upsert_collection(key) {
            write_collection(connection, &mut writer, key, column)?;
        } else if key == "retractions" {
            write_retractions(connection, &mut writer, column)?;
        } else {
            try_write_canonical_json(&mut writer, &object[key])
                .map_err(|_| invalid("delta is outside the canonical JSON domain"))?;
        }
        emitted += 1;
    }
    writer.write_all(b"}")?;
    Ok(writer.0.finalize().into())
}

fn write_retractions(
    connection: &Connection,
    writer: &mut impl Write,
    column: JsonColumn,
) -> Result<(), StorageError> {
    writer.write_all(b"{")?;
    for (index, (key, collection)) in [
        ("authoritativeTurnKeys", "authoritativeTurnKeys"),
        ("orphanEventKeys", "orphanEventKeys"),
        ("turnKeys", "turnKeys"),
    ]
    .into_iter()
    .enumerate()
    {
        if index > 0 {
            writer.write_all(b",")?;
        }
        try_write_canonical_json(writer, &Value::String(key.to_owned()))
            .map_err(|_| invalid("retraction key is invalid"))?;
        writer.write_all(b":")?;
        write_collection(connection, writer, collection, column)?;
    }
    writer.write_all(b"}")?;
    Ok(())
}

fn write_collection(
    connection: &Connection,
    writer: &mut impl Write,
    collection: &str,
    column: JsonColumn,
) -> Result<(), StorageError> {
    let selected = match column {
        JsonColumn::Wire => "wire_json",
        JsonColumn::Normalized => "normalized_json",
    };
    let mut statement = connection.prepare(&format!(
        "SELECT {selected} FROM temp.session_fact_staging
         WHERE collection=?1 ORDER BY ordinal"
    ))?;
    let mut rows = statement.query([collection])?;
    writer.write_all(b"[")?;
    let mut index = 0_usize;
    while let Some(row) = rows.next()? {
        if index > 0 {
            writer.write_all(b",")?;
        }
        let json: String = row.get(0)?;
        writer.write_all(json.as_bytes())?;
        index += 1;
    }
    writer.write_all(b"]")?;
    Ok(())
}

pub fn for_each_chunk<T: DeserializeOwned>(
    transaction: &Transaction<'_>,
    collection: &str,
    mut apply: impl FnMut(&[T]) -> Result<(), StorageError>,
) -> Result<(), StorageError> {
    let mut after = -1_i64;
    loop {
        let mut statement = transaction.prepare_cached(
            "SELECT ordinal,normalized_json FROM temp.session_fact_staging
             WHERE collection=?1 AND ordinal>?2 ORDER BY ordinal LIMIT ?3",
        )?;
        let mut rows =
            statement.query(params![collection, after, STAGED_FACT_CHUNK_ROWS as i64])?;
        let mut chunk = Vec::new();
        let mut chunk_bytes = 0_usize;
        let mut next_after = after;
        while let Some(row) = rows.next()? {
            let ordinal: i64 = row.get(0)?;
            let json: String = row.get(1)?;
            let next_bytes = chunk_bytes.saturating_add(json.len());
            if !chunk.is_empty() && next_bytes > STAGED_FACT_CHUNK_BYTES {
                break;
            }
            chunk.push(
                serde_json::from_str(&json)
                    .map_err(|_| invalid("staged fact became unreadable"))?,
            );
            chunk_bytes = next_bytes;
            next_after = ordinal;
        }
        drop(rows);
        drop(statement);
        if chunk.is_empty() {
            return Ok(());
        }
        apply(&chunk)?;
        after = next_after;
    }
}

pub fn contains_identity(
    transaction: &Transaction<'_>,
    collections: &[&str],
    key: StableKey,
) -> Result<bool, StorageError> {
    let identity = key.to_string();
    for collection in collections {
        let found: i64 = transaction.query_row(
            "SELECT EXISTS(
               SELECT 1 FROM temp.session_fact_staging
               WHERE collection=?1 AND identity=?2
             )",
            params![collection, identity],
            |row| row.get(0),
        )?;
        if found == 1 {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests {
    use super::{STAGED_FACT_CHUNK_BYTES, count, for_each_chunk, initialize, prepare, stage_batch};
    use crate::engine::RETRACTION_COLLECTIONS;
    use crate::fact_model::{HistoryEventFact, HistoryPayloadFact, SessionFactsDeltaV1};
    use crate::protocol::upsert_collections_for_delta_format;
    use crate::{hash_key, try_canonical_json};
    use rusqlite::Connection;
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn recompute_delta_id(delta: &mut Value) {
        let mut mutation = delta.clone();
        mutation.as_object_mut().unwrap().remove("deltaId");
        let mutation_digest =
            Sha256::digest(try_canonical_json(&mutation).unwrap().as_bytes()).to_vec();
        let root = delta.as_object().unwrap();
        let expected = hash_key(
            "delta",
            &[
                hex::decode(root["session"]["sessionKey"].as_str().unwrap()).unwrap(),
                root["expectedGeneration"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
                    .to_vec(),
                root["mode"].as_str().unwrap().as_bytes().to_vec(),
                root["originSecretEpoch"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
                    .to_vec(),
                root["duplicatePolicyVersion"]
                    .as_u64()
                    .unwrap()
                    .to_string()
                    .into_bytes(),
                mutation_digest,
                root["checkpoint"]["completeOffset"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
                    .to_vec(),
            ],
        );
        delta["deltaId"] = Value::String(expected);
    }

    fn fixture_delta() -> Value {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
        ))
        .unwrap();
        let mut delta = fixture["initial"].clone();
        recompute_delta_id(&mut delta);
        delta
    }

    fn fixture_delta_v2() -> Value {
        let mut delta = fixture_delta();
        let event = delta["evidenceEvents"][0].clone();
        let content = "private payload 界";
        let digest = hex::encode(Sha256::digest(content.as_bytes()));
        let payload_key = "71".repeat(32);
        delta["format"] = Value::String("session-facts-delta@v2".to_owned());
        delta["factSchemaVersion"] = Value::from(2);
        delta["providerAdapterVersion"] = Value::String("codex@2".to_owned());
        delta["privacyPolicyVersion"] = Value::from(2);
        delta["historyEvents"] = serde_json::json!([{
            "eventKey": event["eventKey"],
            "ownerSessionKey": event["ownerSessionKey"],
            "occurredTurnKey": event["occurredTurnKey"],
            "sourceRecordKey": event["sourceRecordKey"],
            "sourceOrder": event["sourceOrder"],
            "originScope": event["originScope"],
            "observedTimestamp": event["observedTimestamp"],
            "kind": "visible-message",
            "completeness": "full",
            "revision": "72".repeat(32),
            "metadata": {"role":"user"},
            "payloadKeys": [payload_key],
        }]);
        delta["historyPayloads"] = serde_json::json!([{
            "payloadKey": payload_key,
            "ownerSessionKey": delta["session"]["sessionKey"],
            "eventKey": event["eventKey"],
            "payloadKind": "message-content",
            "encoding": "utf-8",
            "byteLength": content.len().to_string(),
            "sha256": digest,
            "completeness": "full",
            "chunkCount": "1",
        }]);
        delta["historyPayloadChunks"] = serde_json::json!([{
            "payloadKey": payload_key,
            "ownerSessionKey": delta["session"]["sessionKey"],
            "ordinal": "0",
            "content": content,
            "byteLength": content.len().to_string(),
            "sha256": digest,
        }]);
        let mut event: HistoryEventFact =
            serde_json::from_value(delta["historyEvents"][0].clone()).unwrap();
        let payload: HistoryPayloadFact =
            serde_json::from_value(delta["historyPayloads"][0].clone()).unwrap();
        event.revision =
            crate::fact_model::expected_history_event_revision(&event, &[&payload]).unwrap();
        delta["historyEvents"][0] = serde_json::to_value(event).unwrap();
        recompute_delta_id(&mut delta);
        delta
    }

    fn stage_fixture(connection: &mut Connection, delta: &mut Value) {
        let session_key = delta["session"]["sessionKey"].as_str().unwrap().to_owned();
        let provider = delta["session"]["provider"].as_str().unwrap().to_owned();
        for collection in RETRACTION_COLLECTIONS {
            let items = std::mem::take(delta["retractions"][collection].as_array_mut().unwrap());
            if items.is_empty() {
                continue;
            }
            stage_batch(connection, collection, 0, &items, &session_key, &provider).unwrap();
        }
        let delta_format = delta["format"].as_str().unwrap();
        for collection in upsert_collections_for_delta_format(delta_format).unwrap() {
            let items = std::mem::take(delta[collection].as_array_mut().unwrap());
            if items.is_empty() {
                continue;
            }
            stage_batch(connection, collection, 0, &items, &session_key, &provider).unwrap();
        }
    }

    #[test]
    fn stages_a_batch_after_the_legacy_session_payload_budget() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        let outcome = stage_batch(
            &mut connection,
            "turnKeys",
            0,
            &[Value::String("11".repeat(32))],
            &"aa".repeat(32),
            "codex",
        )
        .unwrap();
        assert!(outcome.canonical_bytes > 0);
        assert_eq!(super::count(&connection, "turnKeys").unwrap(), 1);
    }

    #[test]
    fn does_not_misclassify_sqlite_failures_as_duplicate_facts() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        connection
            .execute("DROP TABLE temp.session_fact_staging", [])
            .unwrap();
        let error = stage_batch(
            &mut connection,
            "turnKeys",
            0,
            &[Value::String("11".repeat(32))],
            &"aa".repeat(32),
            "codex",
        )
        .unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_STORAGE_FAILED");
        assert!(!error.message.contains("duplicate fact"));
    }

    #[test]
    fn stops_reading_staged_rows_at_the_first_byte_bounded_chunk() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        let json = serde_json::to_string(&"x".repeat(64 * 1_024)).unwrap();
        {
            let transaction = connection.transaction().unwrap();
            for ordinal in 0..256_i64 {
                transaction
                    .execute(
                        "INSERT INTO temp.session_fact_staging(
                           collection,ordinal,identity,wire_json,normalized_json
                         ) VALUES ('turns',?1,?2,?3,?3)",
                        rusqlite::params![ordinal, ordinal.to_string(), json],
                    )
                    .unwrap();
            }
            transaction.commit().unwrap();
        }

        let progress_steps = Arc::new(AtomicUsize::new(0));
        let observed_steps = Arc::clone(&progress_steps);
        connection
            .progress_handler(
                1,
                Some(move || {
                    observed_steps.fetch_add(1, Ordering::Relaxed);
                    false
                }),
            )
            .unwrap();
        let transaction = connection.transaction().unwrap();
        progress_steps.store(0, Ordering::Relaxed);
        let fully_buffered_rows = {
            let mut statement = transaction
                .prepare(
                    "SELECT ordinal,normalized_json FROM temp.session_fact_staging
                     WHERE collection=?1 AND ordinal>?2 ORDER BY ordinal LIMIT ?3",
                )
                .unwrap();
            statement
                .query_map(rusqlite::params!["turns", -1_i64, 512_i64], |row| {
                    Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap()
        };
        assert_eq!(fully_buffered_rows.len(), 256);
        let fully_buffered_steps = progress_steps.load(Ordering::Relaxed);
        drop(fully_buffered_rows);

        progress_steps.store(0, Ordering::Relaxed);
        let mut observed_chunk_bytes = 0_usize;
        let error = for_each_chunk::<String>(&transaction, "turns", |chunk| {
            observed_chunk_bytes = chunk.iter().map(|value| value.len()).sum();
            Err(super::invalid("stop after the first staged chunk"))
        })
        .unwrap_err();

        assert_eq!(error.message, "stop after the first staged chunk");
        assert!(observed_chunk_bytes <= STAGED_FACT_CHUNK_BYTES);
        let bounded_steps = progress_steps.load(Ordering::Relaxed);
        assert!(bounded_steps < 2_000);
        assert!(
            bounded_steps.saturating_mul(2) < fully_buffered_steps,
            "the staging query read beyond the first bounded chunk"
        );
    }

    #[test]
    fn staged_digest_matches_the_legacy_full_delta_digest() {
        let full_delta = fixture_delta();
        let typed = SessionFactsDeltaV1::try_from(full_delta.clone()).unwrap();
        let expected: [u8; 32] = Sha256::digest(
            try_canonical_json(&typed.to_contract_value().unwrap())
                .unwrap()
                .as_bytes(),
        )
        .into();
        let mut skeleton = full_delta;
        let mut connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        stage_fixture(&mut connection, &mut skeleton);
        let staged = prepare(&connection, skeleton).unwrap();
        assert_eq!(staged.canonical_digest, expected);
        assert_eq!(staged.delta.session, typed.session);
        assert_eq!(staged.delta.checkpoint, typed.checkpoint);
    }

    #[test]
    fn staged_v2_digest_matches_the_complete_history_delta() {
        let full_delta = fixture_delta_v2();
        let typed = SessionFactsDeltaV1::try_from(full_delta.clone()).unwrap();
        let expected: [u8; 32] = Sha256::digest(
            try_canonical_json(&typed.to_contract_value().unwrap())
                .unwrap()
                .as_bytes(),
        )
        .into();
        let mut skeleton = full_delta;
        let mut connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        stage_fixture(&mut connection, &mut skeleton);
        let staged = prepare(&connection, skeleton).unwrap();
        assert_eq!(staged.canonical_digest, expected);
        assert_eq!(count(&connection, "historyEvents").unwrap(), 1);
        assert_eq!(count(&connection, "historyPayloads").unwrap(), 1);
        assert_eq!(count(&connection, "historyPayloadChunks").unwrap(), 1);
    }
}
