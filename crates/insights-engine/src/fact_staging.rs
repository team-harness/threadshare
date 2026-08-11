use crate::fact_model::{
    CapabilityFact, CapabilityUseEvidenceFact, CapabilityUseFact, EvidenceEvent,
    ProviderStatusEvent, ProviderStatusKind, ProviderVisibility, SessionFactsDeltaV1, StableKey,
    TurnEvidenceFact, TurnEvidenceRole, TurnFact,
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
pub const MAX_STAGED_SESSION_PAYLOAD_BYTES: usize = 512 * 1024 * 1024;
const STAGED_FACT_CHUNK_ROWS: usize = 512;

const STAGING_SCHEMA: &str = r#"
CREATE TEMP TABLE IF NOT EXISTS session_fact_staging (
  collection TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  identity TEXT NOT NULL,
  wire_json TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  PRIMARY KEY(collection, ordinal),
  UNIQUE(collection, identity)
) WITHOUT ROWID;
"#;

pub struct StagedSessionFacts {
    pub delta: SessionFactsDeltaV1,
    pub canonical_digest: [u8; 32],
}

#[derive(Debug)]
pub struct StageBatchOutcome {
    pub canonical_bytes: usize,
    pub staged_payload_bytes: usize,
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
    current_staged_payload_bytes: usize,
) -> Result<StageBatchOutcome, StorageError> {
    let transaction = connection.savepoint()?;
    let mut canonical_bytes = 0_usize;
    let mut added_staged_payload_bytes = 0_usize;
    for (offset, item) in items.iter().enumerate() {
        let wire_json = try_canonical_json(item)
            .map_err(|_| invalid("batch item is outside the canonical JSON domain"))?;
        canonical_bytes = canonical_bytes
            .checked_add(wire_json.len())
            .ok_or_else(|| invalid("batch canonical byte count exceeds platform limits"))?;
        if canonical_bytes > STAGED_FACT_CHUNK_BYTES {
            return Err(invalid("batch fact data exceeds the 4 MiB staging window"));
        }
        let (identity, normalized_json) = normalize_item(collection, item, session_key, provider)?;
        added_staged_payload_bytes = added_staged_payload_bytes
            .checked_add(wire_json.len())
            .and_then(|total| total.checked_add(normalized_json.len()))
            .ok_or_else(|| invalid("staged session byte count exceeds platform limits"))?;
        if current_staged_payload_bytes
            .checked_add(added_staged_payload_bytes)
            .is_none_or(|total| total > MAX_STAGED_SESSION_PAYLOAD_BYTES)
        {
            return Err(invalid(
                "session fact staging exceeds the 512 MiB logical payload budget",
            ));
        }
        let ordinal = first_ordinal
            .checked_add(offset)
            .ok_or_else(|| invalid("staged fact ordinal exceeds platform limits"))?;
        let ordinal = i64::try_from(ordinal)
            .map_err(|_| invalid("staged fact ordinal exceeds platform limits"))?;
        let result = transaction.execute(
            "INSERT INTO temp.session_fact_staging(
               collection,ordinal,identity,wire_json,normalized_json
             ) VALUES (?1,?2,?3,?4,?5)",
            params![collection, ordinal, identity, wire_json, normalized_json],
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
    Ok(StageBatchOutcome {
        canonical_bytes,
        staged_payload_bytes: added_staged_payload_bytes,
    })
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
) -> Result<(String, String), StorageError> {
    let owner = session_key
        .parse::<StableKey>()
        .map_err(|error| StorageError::new(error.code, error.message))?;
    match collection {
        "turnKeys" | "orphanEventKeys" | "authoritativeTurnKeys" => {
            let (key, canonical) = decode::<StableKey>(value)?;
            Ok((stable_identity(key), canonical))
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
            Ok((stable_identity(fact.turn_key), canonical))
        }
        "sourceRecords" => {
            let (fact, canonical) = decode::<crate::fact_model::SourceRecordFact>(value)?;
            if fact.owner_session_key != owner {
                return Err(invalid(
                    "delta contains a source record owned by another session",
                ));
            }
            Ok((stable_identity(fact.source_record_key), canonical))
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
            Ok((stable_identity(common.event_key), canonical))
        }
        "turnEvidence" => {
            let (fact, canonical) = decode::<TurnEvidenceFact>(value)?;
            if fact.owner_session_key != owner || fact.role == TurnEvidenceRole::Rollback {
                return Err(invalid("delta contains an invalid Turn evidence link"));
            }
            let identity = composite_identity(&(fact.turn_key, fact.event_key, fact.role))?;
            Ok((identity, canonical))
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
            Ok((stable_identity(fact.capability_key), canonical))
        }
        "capabilityUses" => {
            let (fact, canonical) = decode::<CapabilityUseFact>(value)?;
            if fact.owner_session_key != owner {
                return Err(invalid(
                    "delta contains a capability use owned by another session",
                ));
            }
            Ok((stable_identity(fact.use_key), canonical))
        }
        "capabilityUseEvidence" => {
            let (fact, canonical) = decode::<CapabilityUseEvidenceFact>(value)?;
            if fact.owner_session_key != owner {
                return Err(invalid(
                    "delta contains a capability evidence link owned by another session",
                ));
            }
            let identity = composite_identity(&(fact.use_key, fact.event_key, fact.role))?;
            Ok((identity, canonical))
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
    verify_delta_id(connection, &wire_delta, &delta)?;
    let normalized =
        serde_json::to_value(&delta).map_err(|_| invalid("delta is not serializable"))?;
    let canonical_digest = stream_digest(connection, &normalized, JsonColumn::Normalized, true)?;
    Ok(StagedSessionFacts {
        delta,
        canonical_digest,
    })
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
        if crate::engine::UPSERT_COLLECTIONS.contains(&key.as_str()) {
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
    use super::{
        MAX_STAGED_SESSION_PAYLOAD_BYTES, STAGED_FACT_CHUNK_BYTES, for_each_chunk, initialize,
        prepare, stage_batch,
    };
    use crate::engine::{RETRACTION_COLLECTIONS, UPSERT_COLLECTIONS};
    use crate::fact_model::SessionFactsDeltaV1;
    use crate::{hash_key, try_canonical_json};
    use rusqlite::Connection;
    use serde_json::Value;
    use sha2::{Digest, Sha256};
    use std::sync::Arc;
    use std::sync::atomic::{AtomicUsize, Ordering};

    fn fixture_delta() -> Value {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
        ))
        .unwrap();
        let mut delta = fixture["initial"].clone();
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
        delta
    }

    fn stage_fixture(connection: &mut Connection, delta: &mut Value) {
        let session_key = delta["session"]["sessionKey"].as_str().unwrap().to_owned();
        let provider = delta["session"]["provider"].as_str().unwrap().to_owned();
        let mut staged_payload_bytes = 0;
        for collection in RETRACTION_COLLECTIONS {
            let items = std::mem::take(delta["retractions"][collection].as_array_mut().unwrap());
            if items.is_empty() {
                continue;
            }
            let outcome = stage_batch(
                connection,
                collection,
                0,
                &items,
                &session_key,
                &provider,
                staged_payload_bytes,
            )
            .unwrap();
            staged_payload_bytes += outcome.staged_payload_bytes;
        }
        for collection in UPSERT_COLLECTIONS {
            let items = std::mem::take(delta[collection].as_array_mut().unwrap());
            if items.is_empty() {
                continue;
            }
            let outcome = stage_batch(
                connection,
                collection,
                0,
                &items,
                &session_key,
                &provider,
                staged_payload_bytes,
            )
            .unwrap();
            staged_payload_bytes += outcome.staged_payload_bytes;
        }
    }

    #[test]
    fn rejects_the_exact_temp_storage_budget_without_leaving_rows() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize(&connection).unwrap();
        let error = stage_batch(
            &mut connection,
            "turnKeys",
            0,
            &[Value::String("11".repeat(32))],
            &"aa".repeat(32),
            "codex",
            MAX_STAGED_SESSION_PAYLOAD_BYTES,
        )
        .unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_INVALID_DELTA");
        assert_eq!(
            error.message,
            "session fact staging exceeds the 512 MiB logical payload budget"
        );
        assert_eq!(super::count(&connection, "turnKeys").unwrap(), 0);
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
            0,
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
            try_canonical_json(&serde_json::to_value(&typed).unwrap())
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
}
