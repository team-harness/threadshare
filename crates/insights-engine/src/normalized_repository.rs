use crate::fact_model::*;
use crate::fact_projection::{
    SessionProjectionChangeSet, capture_session_projection_snapshot, recompute_session_derivations,
    record_projection_changes,
};
use crate::fact_repository::{
    CommittedSessionFacts, FactEntity, FactEntityKind, FactRepository, FactSnapshotPage,
    SessionFactSnapshot, TurnFactClosure,
};
use crate::storage::{CommitOutcome, StorageError};
use crate::{hash_key, try_canonical_json};
use rusqlite::{Connection, OptionalExtension, Row, Transaction, TransactionBehavior, params};
use serde::Serialize;
use serde::de::DeserializeOwned;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, BTreeSet};

const NORMALIZED_SCHEMA: &str = r#"
CREATE TABLE IF NOT EXISTS sessions (
  session_id INTEGER PRIMARY KEY,
  session_key BLOB NOT NULL UNIQUE CHECK(length(session_key)=32),
  provider TEXT NOT NULL,
  session_scope TEXT NOT NULL,
  eligibility TEXT NOT NULL,
  project_key BLOB CHECK(project_key IS NULL OR length(project_key)=32),
  observed_start TEXT,
  observed_end TEXT,
  originator_version TEXT,
  duplicate_group_key BLOB CHECK(duplicate_group_key IS NULL OR length(duplicate_group_key)=32),
  dedupe_fingerprint BLOB CHECK(dedupe_fingerprint IS NULL OR length(dedupe_fingerprint)=32),
  dedupe_corroboration_fingerprint BLOB CHECK(dedupe_corroboration_fingerprint IS NULL OR length(dedupe_corroboration_fingerprint)=32),
  duplicate_method TEXT,
  duplicate_confidence TEXT,
  dedupe_closure TEXT,
  duplicate_policy_version INTEGER NOT NULL CHECK(duplicate_policy_version=1)
);

CREATE TABLE IF NOT EXISTS session_commits (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  generation BLOB NOT NULL CHECK(length(generation)=8),
  delta_id BLOB NOT NULL CHECK(length(delta_id)=32),
  canonical_digest BLOB NOT NULL CHECK(length(canonical_digest)=32),
  snapshot_seq INTEGER NOT NULL
);

CREATE TABLE IF NOT EXISTS session_fact_truncation (
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  flag TEXT NOT NULL,
  PRIMARY KEY(session_id, ordinal)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS source_checkpoints (
  session_id INTEGER PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
  complete_offset BLOB NOT NULL CHECK(length(complete_offset)=8),
  eof_observed INTEGER NOT NULL CHECK(eof_observed IN (0,1)),
  partial_tail_length BLOB NOT NULL CHECK(length(partial_tail_length)=8),
  partial_tail_digest BLOB NOT NULL CHECK(length(partial_tail_digest)=32),
  source_size BLOB NOT NULL CHECK(length(source_size)=8),
  source_mtime_ns BLOB NOT NULL CHECK(length(source_mtime_ns)=8),
  source_snapshot_stable INTEGER NOT NULL CHECK(source_snapshot_stable IN (0,1)),
  origin_secret_epoch TEXT NOT NULL,
  generation BLOB NOT NULL CHECK(length(generation)=8),
  pending_state_json TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS turns (
  turn_id INTEGER PRIMARY KEY,
  turn_key BLOB NOT NULL UNIQUE CHECK(length(turn_key)=32),
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_start_offset BLOB NOT NULL CHECK(length(turn_start_offset)=8),
  problem_text TEXT NOT NULL,
  final_answer_excerpt TEXT,
  observed_timestamp TEXT,
  next_user_boundary INTEGER NOT NULL CHECK(next_user_boundary IN (0,1)),
  provider_terminal TEXT,
  observed_eof_closed INTEGER NOT NULL CHECK(observed_eof_closed IN (0,1)),
  base_provider_visibility TEXT NOT NULL,
  effective_provider_visibility TEXT NOT NULL,
  revision BLOB CHECK(revision IS NULL OR length(revision)=32)
);
CREATE INDEX IF NOT EXISTS turns_session_order ON turns(session_id, turn_start_offset, turn_id);

CREATE TABLE IF NOT EXISTS turn_fact_truncation (
  turn_id INTEGER NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  flag TEXT NOT NULL,
  PRIMARY KEY(turn_id, ordinal)
) WITHOUT ROWID;

CREATE TABLE IF NOT EXISTS source_records (
  source_record_id INTEGER PRIMARY KEY,
  source_record_key BLOB NOT NULL UNIQUE CHECK(length(source_record_key)=32),
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  start_offset BLOB NOT NULL CHECK(length(start_offset)=8),
  end_offset BLOB NOT NULL CHECK(length(end_offset)=8),
  record_sha256 BLOB NOT NULL CHECK(length(record_sha256)=32),
  provider_record_class TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS source_records_session_order ON source_records(session_id, start_offset, source_record_id);

CREATE TABLE IF NOT EXISTS capabilities (
  capability_id INTEGER PRIMARY KEY,
  capability_key BLOB NOT NULL UNIQUE CHECK(length(capability_key)=32),
  provider TEXT NOT NULL,
  capability_kind TEXT NOT NULL,
  canonical_name TEXT NOT NULL,
  identity_version INTEGER NOT NULL CHECK(identity_version=1)
);

CREATE TABLE IF NOT EXISTS evidence_events (
  event_id INTEGER PRIMARY KEY,
  event_key BLOB NOT NULL UNIQUE CHECK(length(event_key)=32),
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  occurred_turn_id INTEGER REFERENCES turns(turn_id) ON DELETE CASCADE,
  source_record_id INTEGER NOT NULL REFERENCES source_records(source_record_id) ON DELETE CASCADE,
  record_start_offset BLOB NOT NULL CHECK(length(record_start_offset)=8),
  content_index INTEGER NOT NULL CHECK(content_index>=-1),
  event_ordinal INTEGER NOT NULL CHECK(event_ordinal BETWEEN 0 AND 65535),
  pointer_kind TEXT NOT NULL,
  pointer_content_index INTEGER NOT NULL CHECK(pointer_content_index>=-1),
  pointer_event_ordinal INTEGER NOT NULL CHECK(pointer_event_ordinal BETWEEN 0 AND 65535),
  origin_scope TEXT NOT NULL,
  observed_timestamp TEXT,
  event_kind TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS evidence_events_session_order ON evidence_events(session_id, record_start_offset, content_index, event_ordinal, event_id);
CREATE INDEX IF NOT EXISTS evidence_events_source_record ON evidence_events(source_record_id);
CREATE INDEX IF NOT EXISTS evidence_events_occurred_turn
  ON evidence_events(occurred_turn_id) WHERE occurred_turn_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS visible_message_events (
  event_id INTEGER PRIMARY KEY REFERENCES evidence_events(event_id) ON DELETE CASCADE,
  message_role TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS capability_invocation_events (
  event_id INTEGER PRIMARY KEY REFERENCES evidence_events(event_id) ON DELETE CASCADE,
  capability_id INTEGER NOT NULL REFERENCES capabilities(capability_id),
  correlation_digest BLOB CHECK(correlation_digest IS NULL OR length(correlation_digest)=32),
  input_fingerprint BLOB CHECK(input_fingerprint IS NULL OR length(input_fingerprint)=32)
);
CREATE INDEX IF NOT EXISTS capability_invocation_events_capability
  ON capability_invocation_events(capability_id);
CREATE TABLE IF NOT EXISTS capability_result_events (
  event_id INTEGER PRIMARY KEY REFERENCES evidence_events(event_id) ON DELETE CASCADE,
  correlation_digest BLOB CHECK(correlation_digest IS NULL OR length(correlation_digest)=32),
  provider_state TEXT NOT NULL,
  exit_code BLOB CHECK(exit_code IS NULL OR length(exit_code)=8),
  output_bytes BLOB CHECK(output_bytes IS NULL OR length(output_bytes)=8),
  duration_ms BLOB CHECK(duration_ms IS NULL OR length(duration_ms)=8)
);
CREATE TABLE IF NOT EXISTS skill_catalog_entry_events (
  event_id INTEGER PRIMARY KEY REFERENCES evidence_events(event_id) ON DELETE CASCADE,
  capability_id INTEGER NOT NULL REFERENCES capabilities(capability_id),
  path_fingerprint BLOB NOT NULL CHECK(length(path_fingerprint)=32)
);
CREATE INDEX IF NOT EXISTS skill_catalog_entry_events_capability
  ON skill_catalog_entry_events(capability_id);
CREATE TABLE IF NOT EXISTS skill_load_events (
  event_id INTEGER PRIMARY KEY REFERENCES evidence_events(event_id) ON DELETE CASCADE,
  capability_id INTEGER NOT NULL REFERENCES capabilities(capability_id),
  strength TEXT NOT NULL,
  evidence_source TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS skill_load_events_capability
  ON skill_load_events(capability_id);
CREATE TABLE IF NOT EXISTS turn_lifecycle_events (
  event_id INTEGER PRIMARY KEY REFERENCES evidence_events(event_id) ON DELETE CASCADE,
  lifecycle_state TEXT NOT NULL,
  provider_turn_digest BLOB CHECK(provider_turn_digest IS NULL OR length(provider_turn_digest)=32)
);
CREATE TABLE IF NOT EXISTS provider_status_events (
  event_id INTEGER PRIMARY KEY REFERENCES evidence_events(event_id) ON DELETE CASCADE,
  status_kind TEXT NOT NULL,
  provider_state TEXT NOT NULL,
  rolled_back_turn_count BLOB CHECK(rolled_back_turn_count IS NULL OR length(rolled_back_turn_count)=8)
);

CREATE TABLE IF NOT EXISTS turn_evidence (
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_id INTEGER NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES evidence_events(event_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY(turn_id, event_id, role)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS turn_evidence_session_role
  ON turn_evidence(session_id, role);
CREATE INDEX IF NOT EXISTS turn_evidence_event
  ON turn_evidence(event_id);

CREATE TABLE IF NOT EXISTS capability_uses (
  use_id INTEGER PRIMARY KEY,
  use_key BLOB NOT NULL UNIQUE CHECK(length(use_key)=32),
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_id INTEGER NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
  capability_id INTEGER NOT NULL REFERENCES capabilities(capability_id),
  turn_ordinal BLOB NOT NULL CHECK(length(turn_ordinal)=8),
  exact_observed_name TEXT NOT NULL,
  origin_scope TEXT NOT NULL,
  origin_fingerprint BLOB CHECK(origin_fingerprint IS NULL OR length(origin_fingerprint)=32),
  input_fingerprint BLOB CHECK(input_fingerprint IS NULL OR length(input_fingerprint)=32),
  provider_terminal_state TEXT NOT NULL,
  strength TEXT NOT NULL,
  correlation_digest BLOB CHECK(correlation_digest IS NULL OR length(correlation_digest)=32)
);
CREATE INDEX IF NOT EXISTS capability_uses_session_key
  ON capability_uses(session_id, use_key);
CREATE INDEX IF NOT EXISTS capability_uses_turn
  ON capability_uses(turn_id);
CREATE INDEX IF NOT EXISTS capability_uses_capability
  ON capability_uses(capability_id);

CREATE TABLE IF NOT EXISTS capability_use_evidence (
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  use_id INTEGER NOT NULL REFERENCES capability_uses(use_id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES evidence_events(event_id) ON DELETE CASCADE,
  role TEXT NOT NULL,
  PRIMARY KEY(use_id, event_id, role)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS capability_use_evidence_session
  ON capability_use_evidence(session_id);
CREATE INDEX IF NOT EXISTS capability_use_evidence_event
  ON capability_use_evidence(event_id);

CREATE TABLE IF NOT EXISTS checkpoint_turn_pins (
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  turn_id INTEGER NOT NULL REFERENCES turns(turn_id) ON DELETE CASCADE,
  pin_kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(session_id,pin_kind,ordinal),
  UNIQUE(session_id,turn_id,pin_kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS checkpoint_turn_pins_turn
  ON checkpoint_turn_pins(turn_id);
CREATE TABLE IF NOT EXISTS checkpoint_event_pins (
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  event_id INTEGER NOT NULL REFERENCES evidence_events(event_id) ON DELETE CASCADE,
  pin_kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(session_id,pin_kind,ordinal),
  UNIQUE(session_id,event_id,pin_kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS checkpoint_event_pins_event
  ON checkpoint_event_pins(event_id);
CREATE TABLE IF NOT EXISTS checkpoint_use_pins (
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  use_id INTEGER NOT NULL REFERENCES capability_uses(use_id) ON DELETE CASCADE,
  pin_kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(session_id,pin_kind,ordinal),
  UNIQUE(session_id,use_id,pin_kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS checkpoint_use_pins_use
  ON checkpoint_use_pins(use_id);
CREATE TABLE IF NOT EXISTS checkpoint_capability_pins (
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  capability_id INTEGER NOT NULL REFERENCES capabilities(capability_id) ON DELETE CASCADE,
  pin_kind TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  PRIMARY KEY(session_id,pin_kind,ordinal),
  UNIQUE(session_id,capability_id,pin_kind)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS checkpoint_capability_pins_capability
  ON checkpoint_capability_pins(capability_id);

CREATE TABLE IF NOT EXISTS session_dedupe_evidence (
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  ordinal INTEGER NOT NULL,
  event_id INTEGER NOT NULL REFERENCES evidence_events(event_id) ON DELETE CASCADE,
  PRIMARY KEY(session_id, ordinal),
  UNIQUE(session_id, event_id)
) WITHOUT ROWID;
CREATE INDEX IF NOT EXISTS session_dedupe_evidence_event
  ON session_dedupe_evidence(event_id);

CREATE TABLE IF NOT EXISTS fact_diagnostics (
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  code TEXT NOT NULL,
  diagnostic_count BLOB NOT NULL CHECK(length(diagnostic_count)=8),
  first_offset BLOB CHECK(first_offset IS NULL OR length(first_offset)=8),
  digest BLOB CHECK(digest IS NULL OR length(digest)=32),
  PRIMARY KEY(session_id, code)
) WITHOUT ROWID;
CREATE TABLE IF NOT EXISTS fact_coverage (
  session_id INTEGER NOT NULL REFERENCES sessions(session_id) ON DELETE CASCADE,
  coverage_key TEXT NOT NULL,
  coverage_count BLOB NOT NULL CHECK(length(coverage_count)=8),
  PRIMARY KEY(session_id, coverage_key)
) WITHOUT ROWID;
"#;

pub(crate) fn initialize_schema(connection: &mut Connection) -> Result<(), StorageError> {
    let legacy_receipt = connection
        .prepare(
            "SELECT name FROM pragma_table_info('session_commits') WHERE name='canonical_delta'",
        )?
        .exists([])?;
    if !legacy_receipt {
        connection.execute_batch(NORMALIZED_SCHEMA)?;
        crate::projection::initialize_projection_schema(connection)?;
        crate::retry_projection::initialize_retry_projection_schema(connection)?;
        return Ok(());
    }

    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction
        .execute_batch("ALTER TABLE session_commits RENAME TO legacy_session_commits_v0;")?;
    transaction.execute_batch(NORMALIZED_SCHEMA)?;
    let mut statement = transaction.prepare(
        "SELECT session_key,generation,delta_id,canonical_delta,snapshot_seq
         FROM legacy_session_commits_v0",
    )?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for (session_key, generation, delta_id, canonical_delta, snapshot_seq) in rows {
        let generation = generation.parse::<u64>().map_err(|_| {
            StorageError::new(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "legacy generation is outside uint64",
            )
        })?;
        transaction.execute(
            "INSERT INTO sessions(
               session_key,provider,session_scope,eligibility,duplicate_policy_version
             ) VALUES (?1,'legacy','unknown','unknown',1)",
            params![session_key],
        )?;
        let session_id = transaction.last_insert_rowid();
        transaction.execute(
            "INSERT INTO session_commits(
               session_id,generation,delta_id,canonical_digest,snapshot_seq
             ) VALUES (?1,?2,?3,?4,?5)",
            params![
                session_id,
                generation.to_be_bytes().to_vec(),
                delta_id,
                Sha256::digest(canonical_delta.as_bytes()).to_vec(),
                snapshot_seq,
            ],
        )?;
    }
    transaction.execute_batch("DROP TABLE legacy_session_commits_v0;")?;
    transaction.commit()?;
    crate::projection::initialize_projection_schema(connection)?;
    crate::retry_projection::initialize_retry_projection_schema(connection)?;
    Ok(())
}

pub(crate) fn apply_session_facts(
    connection: &mut Connection,
    delta: &SessionFactsDeltaV1,
) -> Result<CommitOutcome, StorageError> {
    delta
        .validate()
        .map_err(|error| StorageError::new(error.code, error.message))?;
    let canonical = try_canonical_json(
        &serde_json::to_value(delta)
            .map_err(|error| StorageError::new("TS_INSIGHTS_INVALID_DELTA", error.to_string()))?,
    )
    .map_err(|_| StorageError::new("TS_INSIGHTS_INVALID_DELTA", "non-canonical delta"))?;
    let canonical_digest: [u8; 32] = Sha256::digest(canonical.as_bytes()).into();
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = current_commit(&transaction, delta.session.session_key)?;
    if let Some(current) = &current
        && current.delta_id == delta.delta_id
    {
        if current.canonical_digest != canonical_digest {
            return Err(StorageError::new(
                "TS_INSIGHTS_DELTA_ID_CONFLICT",
                "the committed deltaId belongs to different canonical bytes",
            ));
        }
        return Ok(CommitOutcome {
            snapshot_seq: current.snapshot_seq.to_string(),
            session_key: delta.session.session_key.to_string(),
            delta_id: delta.delta_id.to_string(),
            idempotent: true,
        });
    }
    let actual_generation = current
        .as_ref()
        .map(|value| value.generation)
        .unwrap_or(WireU64::ZERO);
    if actual_generation != delta.expected_generation {
        return Err(StorageError::new(
            "TS_INSIGHTS_GENERATION_CONFLICT",
            format!(
                "expected generation {}, committed generation is {actual_generation}",
                delta.expected_generation
            ),
        ));
    }

    let before_projection =
        capture_session_projection_snapshot(&*transaction, delta.session.session_key)?;
    let forced_turn_keys = delta
        .retractions
        .turn_keys
        .iter()
        .chain(delta.retractions.authoritative_turn_keys.iter())
        .copied()
        .collect::<BTreeSet<_>>();

    if delta.mode == MutationMode::ReplaceSession {
        delete_session_projections(&transaction, delta.session.session_key)?;
        transaction.execute(
            "DELETE FROM sessions WHERE session_key=?1",
            params![blob(delta.session.session_key)],
        )?;
    }
    let session_id = upsert_session(&transaction, &delta.session)?;
    apply_retractions(&transaction, session_id, delta)?;
    upsert_capabilities(&transaction, &delta.capabilities)?;
    upsert_turns(&transaction, session_id, &delta.turns)?;
    upsert_source_records(&transaction, session_id, &delta.source_records)?;
    upsert_events(&transaction, session_id, &delta.evidence_events)?;
    upsert_uses(&transaction, session_id, &delta.capability_uses)?;
    upsert_turn_links(&transaction, session_id, &delta.turn_evidence)?;
    upsert_use_links(&transaction, session_id, &delta.capability_use_evidence)?;
    replace_session_children(&transaction, session_id, &delta.session)?;
    replace_checkpoint(&transaction, session_id, &delta.checkpoint)?;
    replace_checkpoint_pins(&transaction, session_id, &delta.checkpoint)?;
    replace_diagnostics(&transaction, session_id, &delta.diagnostics)?;
    replace_coverage(&transaction, session_id, &delta.coverage)?;
    collect_garbage(&transaction, session_id)?;

    let snapshot_seq: i64 = transaction.query_row(
        "UPDATE engine_metadata SET value=CAST(value AS INTEGER)+1
         WHERE key='snapshot_seq' RETURNING CAST(value AS INTEGER)",
        [],
        |row| row.get(0),
    )?;
    transaction.execute(
        "INSERT INTO session_commits(
           session_id, generation, delta_id, canonical_digest, snapshot_seq
         ) VALUES (?1,?2,?3,?4,?5)
         ON CONFLICT(session_id) DO UPDATE SET
           generation=excluded.generation,
           delta_id=excluded.delta_id,
           canonical_digest=excluded.canonical_digest,
           snapshot_seq=excluded.snapshot_seq",
        params![
            session_id,
            u64_blob(delta.target_generation),
            blob(delta.delta_id),
            canonical_digest.to_vec(),
            snapshot_seq,
        ],
    )?;
    recompute_session_derivations(
        &transaction,
        &*transaction,
        session_id,
        delta.session.session_key,
    )?;
    let after_projection =
        capture_session_projection_snapshot(&*transaction, delta.session.session_key)?;
    record_projection_changes(
        &transaction,
        &*transaction,
        &SessionProjectionChangeSet {
            session_key: delta.session.session_key,
            snapshot_seq,
            before: &before_projection,
            after: &after_projection,
            forced_turn_keys: &forced_turn_keys,
            force_all_turns: delta.mode == MutationMode::ReplaceSession,
        },
    )?;
    // SQLite enforces every touched foreign key inside this transaction. A full
    // foreign_key_check scans the entire repository, so it belongs to explicit
    // integrity maintenance and capacity validation rather than the commit path.
    transaction.commit()?;
    Ok(CommitOutcome {
        snapshot_seq: snapshot_seq.to_string(),
        session_key: delta.session.session_key.to_string(),
        delta_id: delta.delta_id.to_string(),
        idempotent: false,
    })
}

fn delete_session_projections(
    transaction: &Transaction<'_>,
    session_key: StableKey,
) -> Result<(), StorageError> {
    let mut statement = transaction.prepare(
        "SELECT t.turn_id
         FROM turns AS t
         JOIN sessions AS s ON s.session_id=t.session_id
         WHERE s.session_key=?1",
    )?;
    let turn_ids = statement
        .query_map(params![blob(session_key)], |row| row.get::<_, i64>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for turn_id in turn_ids {
        crate::projection::delete_turn_projection(transaction, turn_id)?;
    }
    Ok(())
}

struct CurrentCommit {
    generation: WireU64,
    delta_id: StableKey,
    canonical_digest: [u8; 32],
    snapshot_seq: i64,
}

fn current_commit(
    transaction: &Transaction<'_>,
    session_key: StableKey,
) -> Result<Option<CurrentCommit>, StorageError> {
    let raw = transaction
        .query_row(
            "SELECT c.generation, c.delta_id, c.canonical_digest, c.snapshot_seq
             FROM session_commits AS c
             JOIN sessions AS s ON s.session_id=c.session_id
             WHERE s.session_key=?1",
            params![blob(session_key)],
            |row| {
                Ok((
                    row.get::<_, Vec<u8>>(0)?,
                    row.get::<_, Vec<u8>>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                    row.get::<_, i64>(3)?,
                ))
            },
        )
        .optional()?;
    raw.map(|(generation, delta_id, digest, snapshot_seq)| {
        Ok(CurrentCommit {
            generation: wire_from(&generation)?,
            delta_id: key_from(&delta_id)?,
            canonical_digest: digest.try_into().map_err(|_| {
                StorageError::new(
                    "TS_INSIGHTS_STORAGE_CORRUPT",
                    "canonical digest is not 32 bytes",
                )
            })?,
            snapshot_seq,
        })
    })
    .transpose()
}

fn upsert_session(
    transaction: &Transaction<'_>,
    session: &SessionFact,
) -> Result<i64, StorageError> {
    let duplicate_group_key = session
        .dedupe_fingerprint
        .map(|fingerprint| {
            hash_key(
                "duplicate-group",
                &[
                    session.provider.as_bytes().to_vec(),
                    fingerprint.as_bytes().to_vec(),
                ],
            )
            .parse::<StableKey>()
            .map_err(|_| {
                StorageError::new(
                    "TS_INSIGHTS_INVALID_DELTA",
                    "failed to derive duplicate group key",
                )
            })
        })
        .transpose()?;
    transaction.execute(
        "INSERT INTO sessions(
           session_key, provider, session_scope, eligibility, project_key,
           observed_start, observed_end, originator_version, duplicate_group_key,
           dedupe_fingerprint, dedupe_corroboration_fingerprint, duplicate_method,
           duplicate_confidence, dedupe_closure, duplicate_policy_version
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13,?14,?15)
         ON CONFLICT(session_key) DO UPDATE SET
           provider=excluded.provider, session_scope=excluded.session_scope,
           eligibility=excluded.eligibility, project_key=excluded.project_key,
           observed_start=excluded.observed_start, observed_end=excluded.observed_end,
           originator_version=excluded.originator_version,
           duplicate_group_key=excluded.duplicate_group_key,
           dedupe_fingerprint=excluded.dedupe_fingerprint,
           dedupe_corroboration_fingerprint=excluded.dedupe_corroboration_fingerprint,
           duplicate_method=excluded.duplicate_method,
           duplicate_confidence=excluded.duplicate_confidence,
           dedupe_closure=excluded.dedupe_closure,
           duplicate_policy_version=excluded.duplicate_policy_version",
        params![
            blob(session.session_key),
            &session.provider,
            enum_text(session.session_scope),
            enum_text(session.eligibility),
            optional_blob(session.project_key),
            session.observed_start.as_deref(),
            session.observed_end.as_deref(),
            session.originator_version.as_deref(),
            optional_blob(duplicate_group_key),
            optional_blob(session.dedupe_fingerprint),
            optional_blob(session.dedupe_corroboration_fingerprint),
            optional_enum(session.duplicate_method),
            optional_enum(session.duplicate_confidence),
            optional_enum(session.dedupe_closure),
            i64::from(session.duplicate_policy_version),
        ],
    )?;
    session_id(transaction, session.session_key)
}

fn apply_retractions(
    transaction: &Transaction<'_>,
    session_id: i64,
    delta: &SessionFactsDeltaV1,
) -> Result<(), StorageError> {
    for turn_key in &delta.retractions.turn_keys {
        if let Some(turn_id) = optional_entity_id(
            transaction,
            "SELECT turn_id FROM turns WHERE session_id=?1 AND turn_key=?2",
            session_id,
            *turn_key,
        )? {
            crate::projection::delete_turn_projection(transaction, turn_id)?;
        }
        transaction.execute(
            "DELETE FROM turns WHERE session_id=?1 AND turn_key=?2",
            params![session_id, blob(*turn_key)],
        )?;
    }
    for event_key in &delta.retractions.orphan_event_keys {
        transaction.execute(
            "DELETE FROM evidence_events
             WHERE session_id=?1 AND event_key=?2 AND occurred_turn_id IS NULL",
            params![session_id, blob(*event_key)],
        )?;
    }
    if delta.mode == MutationMode::Append {
        for turn_key in &delta.retractions.authoritative_turn_keys {
            let Some(turn_id) = optional_entity_id(
                transaction,
                "SELECT turn_id FROM turns WHERE session_id=?1 AND turn_key=?2",
                session_id,
                *turn_key,
            )?
            else {
                continue;
            };
            crate::projection::delete_turn_projection(transaction, turn_id)?;
            transaction.execute("DELETE FROM turn_evidence WHERE turn_id=?1", [turn_id])?;
            transaction.execute("DELETE FROM capability_uses WHERE turn_id=?1", [turn_id])?;
            transaction.execute(
                "DELETE FROM evidence_events WHERE occurred_turn_id=?1",
                [turn_id],
            )?;
        }
    }
    Ok(())
}

fn upsert_capabilities(
    transaction: &Transaction<'_>,
    capabilities: &[CapabilityFact],
) -> Result<(), StorageError> {
    for capability in capabilities {
        let identity = (
            capability.provider.clone(),
            enum_text(capability.kind),
            capability.canonical_name.clone(),
            i64::from(capability.identity_version),
        );
        let existing = transaction
            .query_row(
                "SELECT provider, capability_kind, canonical_name, identity_version
                 FROM capabilities WHERE capability_key=?1",
                params![blob(capability.capability_key)],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?;
        if let Some(existing) = existing {
            if existing != identity {
                return Err(StorageError::new(
                    "TS_INSIGHTS_CAPABILITY_IDENTITY_CONFLICT",
                    "capabilityKey belongs to a different immutable identity",
                ));
            }
            continue;
        }
        transaction.execute(
            "INSERT INTO capabilities(
               capability_key, provider, capability_kind, canonical_name, identity_version
             ) VALUES (?1,?2,?3,?4,?5)",
            params![
                blob(capability.capability_key),
                identity.0,
                identity.1,
                identity.2,
                identity.3,
            ],
        )?;
    }
    Ok(())
}

fn upsert_turns(
    transaction: &Transaction<'_>,
    session_id: i64,
    turns: &[TurnFact],
) -> Result<(), StorageError> {
    for turn in turns {
        let visibility = enum_text(turn.provider_visibility);
        transaction.execute(
            "INSERT INTO turns(
               turn_key, session_id, turn_start_offset, problem_text,
               final_answer_excerpt, observed_timestamp, next_user_boundary,
               provider_terminal, observed_eof_closed, base_provider_visibility,
               effective_provider_visibility, revision
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?10,NULL)
             ON CONFLICT(turn_key) DO UPDATE SET
               session_id=excluded.session_id,
               turn_start_offset=excluded.turn_start_offset,
               problem_text=excluded.problem_text,
               final_answer_excerpt=excluded.final_answer_excerpt,
               observed_timestamp=excluded.observed_timestamp,
               next_user_boundary=excluded.next_user_boundary,
               provider_terminal=excluded.provider_terminal,
               observed_eof_closed=excluded.observed_eof_closed,
               base_provider_visibility=excluded.base_provider_visibility,
               effective_provider_visibility=excluded.effective_provider_visibility,
               revision=NULL",
            params![
                blob(turn.turn_key),
                session_id,
                u64_blob(turn.turn_start_offset),
                &turn.problem_text,
                turn.final_answer_excerpt.as_deref(),
                turn.observed_timestamp.as_deref(),
                bool_int(turn.raw_closure.next_user_boundary),
                optional_enum(turn.raw_closure.provider_terminal),
                bool_int(turn.raw_closure.observed_eof_closed),
                visibility,
            ],
        )?;
        let turn_id = turn_id(transaction, turn.turn_key)?;
        transaction.execute(
            "DELETE FROM turn_fact_truncation WHERE turn_id=?1",
            [turn_id],
        )?;
        for (ordinal, flag) in turn.fact_truncation.iter().enumerate() {
            transaction.execute(
                "INSERT INTO turn_fact_truncation(turn_id, ordinal, flag) VALUES (?1,?2,?3)",
                params![turn_id, usize_i64(ordinal)?, flag],
            )?;
        }
    }
    Ok(())
}

fn upsert_source_records(
    transaction: &Transaction<'_>,
    session_id: i64,
    records: &[SourceRecordFact],
) -> Result<(), StorageError> {
    for record in records {
        transaction.execute(
            "INSERT INTO source_records(
               source_record_key, session_id, start_offset, end_offset,
               record_sha256, provider_record_class
             ) VALUES (?1,?2,?3,?4,?5,?6)
             ON CONFLICT(source_record_key) DO UPDATE SET
               session_id=excluded.session_id, start_offset=excluded.start_offset,
               end_offset=excluded.end_offset, record_sha256=excluded.record_sha256,
               provider_record_class=excluded.provider_record_class",
            params![
                blob(record.source_record_key),
                session_id,
                u64_blob(record.start_offset),
                u64_blob(record.end_offset),
                blob(record.record_sha256),
                &record.provider_record_class,
            ],
        )?;
    }
    Ok(())
}

fn upsert_events(
    transaction: &Transaction<'_>,
    session_id: i64,
    events: &[EvidenceEvent],
) -> Result<(), StorageError> {
    for event in events {
        let common = event.common();
        let occurred_turn_id = common
            .occurred_turn_key
            .map(|key| turn_id(transaction, key))
            .transpose()?;
        let source_record_id = source_record_id(transaction, common.source_record_key)?;
        transaction.execute(
            "INSERT INTO evidence_events(
               event_key, session_id, occurred_turn_id, source_record_id,
               record_start_offset, content_index, event_ordinal, pointer_kind,
               pointer_content_index, pointer_event_ordinal, origin_scope,
               observed_timestamp, event_kind
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)
             ON CONFLICT(event_key) DO UPDATE SET
               session_id=excluded.session_id, occurred_turn_id=excluded.occurred_turn_id,
               source_record_id=excluded.source_record_id,
               record_start_offset=excluded.record_start_offset,
               content_index=excluded.content_index, event_ordinal=excluded.event_ordinal,
               pointer_kind=excluded.pointer_kind,
               pointer_content_index=excluded.pointer_content_index,
               pointer_event_ordinal=excluded.pointer_event_ordinal,
               origin_scope=excluded.origin_scope,
               observed_timestamp=excluded.observed_timestamp,
               event_kind=excluded.event_kind",
            params![
                blob(common.event_key),
                session_id,
                occurred_turn_id,
                source_record_id,
                u64_blob(common.source_order.record_start_offset),
                i64::from(common.source_order.content_index),
                i64::from(common.source_order.event_ordinal),
                &common.pointer.pointer_kind,
                i64::from(common.pointer.content_index),
                i64::from(common.pointer.event_ordinal),
                enum_text(common.origin_scope),
                common.observed_timestamp.as_deref(),
                event_kind(event),
            ],
        )?;
        let event_id = event_id(transaction, common.event_key)?;
        delete_event_payload(transaction, event_id)?;
        match event {
            EvidenceEvent::VisibleMessage(value) => {
                transaction.execute(
                    "INSERT INTO visible_message_events(event_id,message_role) VALUES (?1,?2)",
                    params![event_id, enum_text(value.role)],
                )?;
            }
            EvidenceEvent::CapabilityInvocation(value) => {
                transaction.execute(
                    "INSERT INTO capability_invocation_events(
                       event_id,capability_id,correlation_digest,input_fingerprint
                     ) VALUES (?1,?2,?3,?4)",
                    params![
                        event_id,
                        capability_id(transaction, value.capability_key)?,
                        optional_blob(value.correlation_digest),
                        optional_blob(value.input_fingerprint),
                    ],
                )?;
            }
            EvidenceEvent::CapabilityResult(value) => {
                transaction.execute(
                    "INSERT INTO capability_result_events(
                       event_id,correlation_digest,provider_state,exit_code,output_bytes,duration_ms
                     ) VALUES (?1,?2,?3,?4,?5,?6)",
                    params![
                        event_id,
                        optional_blob(value.correlation_digest),
                        enum_text(value.provider_state),
                        optional_u64_blob(value.exit_code),
                        optional_u64_blob(value.output_bytes),
                        optional_u64_blob(value.duration_ms),
                    ],
                )?;
            }
            EvidenceEvent::SkillCatalogEntry(value) => {
                transaction.execute(
                    "INSERT INTO skill_catalog_entry_events(event_id,capability_id,path_fingerprint)
                     VALUES (?1,?2,?3)",
                    params![
                        event_id,
                        capability_id(transaction, value.capability_key)?,
                        blob(value.path_fingerprint),
                    ],
                )?;
            }
            EvidenceEvent::SkillLoad(value) => {
                transaction.execute(
                    "INSERT INTO skill_load_events(event_id,capability_id,strength,evidence_source)
                     VALUES (?1,?2,?3,?4)",
                    params![
                        event_id,
                        capability_id(transaction, value.capability_key)?,
                        enum_text(value.strength),
                        &value.evidence_source,
                    ],
                )?;
            }
            EvidenceEvent::TurnLifecycle(value) => {
                transaction.execute(
                    "INSERT INTO turn_lifecycle_events(event_id,lifecycle_state,provider_turn_digest)
                     VALUES (?1,?2,?3)",
                    params![
                        event_id,
                        enum_text(value.lifecycle_state),
                        optional_blob(value.provider_turn_digest),
                    ],
                )?;
            }
            EvidenceEvent::ProviderStatus(value) => {
                transaction.execute(
                    "INSERT INTO provider_status_events(
                       event_id,status_kind,provider_state,rolled_back_turn_count
                     ) VALUES (?1,?2,?3,?4)",
                    params![
                        event_id,
                        enum_text(value.status_kind),
                        enum_text(value.provider_state),
                        optional_u64_blob(value.rolled_back_turn_count),
                    ],
                )?;
            }
        }
    }
    Ok(())
}

fn delete_event_payload(transaction: &Transaction<'_>, event_id: i64) -> Result<(), StorageError> {
    for table in [
        "visible_message_events",
        "capability_invocation_events",
        "capability_result_events",
        "skill_catalog_entry_events",
        "skill_load_events",
        "turn_lifecycle_events",
        "provider_status_events",
    ] {
        transaction.execute(
            &format!("DELETE FROM {table} WHERE event_id=?1"),
            [event_id],
        )?;
    }
    Ok(())
}

fn upsert_uses(
    transaction: &Transaction<'_>,
    session_id: i64,
    uses: &[CapabilityUseFact],
) -> Result<(), StorageError> {
    for usage in uses {
        transaction.execute(
            "INSERT INTO capability_uses(
               use_key,session_id,turn_id,capability_id,turn_ordinal,
               exact_observed_name,origin_scope,origin_fingerprint,input_fingerprint,
               provider_terminal_state,strength,correlation_digest
             ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)
             ON CONFLICT(use_key) DO UPDATE SET
               session_id=excluded.session_id,turn_id=excluded.turn_id,
               capability_id=excluded.capability_id,turn_ordinal=excluded.turn_ordinal,
               exact_observed_name=excluded.exact_observed_name,
               origin_scope=excluded.origin_scope,
               origin_fingerprint=excluded.origin_fingerprint,
               input_fingerprint=excluded.input_fingerprint,
               provider_terminal_state=excluded.provider_terminal_state,
               strength=excluded.strength,correlation_digest=excluded.correlation_digest",
            params![
                blob(usage.use_key),
                session_id,
                turn_id(transaction, usage.turn_key)?,
                capability_id(transaction, usage.capability_key)?,
                usage.turn_ordinal.to_be_bytes().to_vec(),
                &usage.exact_observed_name,
                enum_text(usage.origin_scope),
                optional_blob(usage.origin_fingerprint),
                optional_blob(usage.input_fingerprint),
                enum_text(usage.provider_terminal_state),
                enum_text(usage.strength),
                optional_blob(usage.correlation_digest),
            ],
        )?;
    }
    Ok(())
}

fn upsert_turn_links(
    transaction: &Transaction<'_>,
    session_id: i64,
    links: &[TurnEvidenceFact],
) -> Result<(), StorageError> {
    for link in links {
        transaction.execute(
            "INSERT INTO turn_evidence(session_id,turn_id,event_id,role)
             VALUES (?1,?2,?3,?4)
             ON CONFLICT(turn_id,event_id,role) DO UPDATE SET session_id=excluded.session_id",
            params![
                session_id,
                turn_id(transaction, link.turn_key)?,
                event_id(transaction, link.event_key)?,
                enum_text(link.role),
            ],
        )?;
    }
    Ok(())
}

fn upsert_use_links(
    transaction: &Transaction<'_>,
    session_id: i64,
    links: &[CapabilityUseEvidenceFact],
) -> Result<(), StorageError> {
    for link in links {
        transaction.execute(
            "INSERT INTO capability_use_evidence(session_id,use_id,event_id,role)
             VALUES (?1,?2,?3,?4)
             ON CONFLICT(use_id,event_id,role) DO UPDATE SET session_id=excluded.session_id",
            params![
                session_id,
                use_id(transaction, link.use_key)?,
                event_id(transaction, link.event_key)?,
                enum_text(link.role),
            ],
        )?;
    }
    Ok(())
}

fn replace_session_children(
    transaction: &Transaction<'_>,
    session_id: i64,
    session: &SessionFact,
) -> Result<(), StorageError> {
    transaction.execute(
        "DELETE FROM session_fact_truncation WHERE session_id=?1",
        [session_id],
    )?;
    for (ordinal, flag) in session.fact_truncation.iter().enumerate() {
        transaction.execute(
            "INSERT INTO session_fact_truncation(session_id,ordinal,flag) VALUES (?1,?2,?3)",
            params![session_id, usize_i64(ordinal)?, flag],
        )?;
    }
    transaction.execute(
        "DELETE FROM session_dedupe_evidence WHERE session_id=?1",
        [session_id],
    )?;
    for (ordinal, event_key) in session.dedupe_evidence_event_keys.iter().enumerate() {
        transaction.execute(
            "INSERT INTO session_dedupe_evidence(session_id,ordinal,event_id)
             VALUES (?1,?2,?3)",
            params![
                session_id,
                usize_i64(ordinal)?,
                event_id(transaction, *event_key)?,
            ],
        )?;
    }
    Ok(())
}

fn replace_checkpoint(
    transaction: &Transaction<'_>,
    session_id: i64,
    checkpoint: &Checkpoint,
) -> Result<(), StorageError> {
    let pending_state_json = try_canonical_json(
        &serde_json::to_value(&checkpoint.pending_state)
            .map_err(|error| StorageError::new("TS_INSIGHTS_INVALID_DELTA", error.to_string()))?,
    )
    .map_err(|_| StorageError::new("TS_INSIGHTS_INVALID_DELTA", "invalid checkpoint"))?;
    transaction.execute(
        "INSERT INTO source_checkpoints(
           session_id,complete_offset,eof_observed,partial_tail_length,
           partial_tail_digest,source_size,source_mtime_ns,source_snapshot_stable,
           origin_secret_epoch,generation,pending_state_json
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11)
         ON CONFLICT(session_id) DO UPDATE SET
           complete_offset=excluded.complete_offset,eof_observed=excluded.eof_observed,
           partial_tail_length=excluded.partial_tail_length,
           partial_tail_digest=excluded.partial_tail_digest,source_size=excluded.source_size,
           source_mtime_ns=excluded.source_mtime_ns,
           source_snapshot_stable=excluded.source_snapshot_stable,
           origin_secret_epoch=excluded.origin_secret_epoch,generation=excluded.generation,
           pending_state_json=excluded.pending_state_json",
        params![
            session_id,
            u64_blob(checkpoint.complete_offset),
            bool_int(checkpoint.eof_observed),
            u64_blob(checkpoint.partial_tail_length),
            blob(checkpoint.partial_tail_digest),
            u64_blob(checkpoint.source_size),
            u64_blob(checkpoint.source_mtime_ns),
            bool_int(checkpoint.source_snapshot_stable),
            &checkpoint.origin_secret_epoch,
            u64_blob(checkpoint.generation),
            pending_state_json,
        ],
    )?;
    Ok(())
}

fn replace_checkpoint_pins(
    transaction: &Transaction<'_>,
    session_id: i64,
    checkpoint: &Checkpoint,
) -> Result<(), StorageError> {
    for table in [
        "checkpoint_turn_pins",
        "checkpoint_event_pins",
        "checkpoint_use_pins",
        "checkpoint_capability_pins",
    ] {
        transaction.execute(
            &format!("DELETE FROM {table} WHERE session_id=?1"),
            [session_id],
        )?;
    }

    let pending = &checkpoint.pending_state;
    if let Some(key) = pending.current_turn_key {
        insert_turn_pin(transaction, session_id, "current", 0, key)?;
    }
    if let Some(key) = pending.session_state.first_turn_key {
        insert_turn_pin(transaction, session_id, "first", 0, key)?;
    }
    if let Some(key) = pending.session_state.second_turn_key {
        insert_turn_pin(transaction, session_id, "second", 0, key)?;
    }
    for (ordinal, item) in pending.pending_started.iter().enumerate() {
        insert_event_pin(
            transaction,
            session_id,
            "pending-started",
            ordinal,
            item.event_key,
        )?;
        if let Some(key) = item.turn_key {
            insert_turn_pin(transaction, session_id, "pending-started", ordinal, key)?;
        }
    }
    for (ordinal, item) in pending.pending_uses.iter().enumerate() {
        if let Some(key) = item.use_key {
            insert_use_pin(transaction, session_id, "pending-use", ordinal, key)?;
        }
        if let Some(key) = item.capability_key {
            insert_capability_pin(transaction, session_id, "pending-use", ordinal, key)?;
        }
    }
    for (ordinal, key) in pending
        .session_state
        .dedupe
        .iter()
        .flat_map(|dedupe| dedupe.dedupe_evidence_event_keys.iter())
        .enumerate()
    {
        insert_event_pin(transaction, session_id, "dedupe", ordinal, *key)?;
    }
    for (ordinal, item) in pending.catalog_entries.iter().enumerate() {
        insert_capability_pin(
            transaction,
            session_id,
            "catalog",
            ordinal,
            item.capability_key,
        )?;
        insert_event_pin(transaction, session_id, "catalog", ordinal, item.event_key)?;
    }
    Ok(())
}

fn insert_turn_pin(
    transaction: &Transaction<'_>,
    session_id: i64,
    pin_kind: &str,
    ordinal: usize,
    key: StableKey,
) -> Result<(), StorageError> {
    let id = turn_id(transaction, key)?;
    ensure_entity_owner(transaction, "turns", "turn_id", id, session_id)?;
    transaction.execute(
        "INSERT OR IGNORE INTO checkpoint_turn_pins(session_id,turn_id,pin_kind,ordinal)
         VALUES (?1,?2,?3,?4)",
        params![session_id, id, pin_kind, usize_i64(ordinal)?],
    )?;
    Ok(())
}

fn insert_event_pin(
    transaction: &Transaction<'_>,
    session_id: i64,
    pin_kind: &str,
    ordinal: usize,
    key: StableKey,
) -> Result<(), StorageError> {
    let id = event_id(transaction, key)?;
    ensure_entity_owner(transaction, "evidence_events", "event_id", id, session_id)?;
    transaction.execute(
        "INSERT OR IGNORE INTO checkpoint_event_pins(session_id,event_id,pin_kind,ordinal)
         VALUES (?1,?2,?3,?4)",
        params![session_id, id, pin_kind, usize_i64(ordinal)?],
    )?;
    Ok(())
}

fn insert_use_pin(
    transaction: &Transaction<'_>,
    session_id: i64,
    pin_kind: &str,
    ordinal: usize,
    key: StableKey,
) -> Result<(), StorageError> {
    let id = use_id(transaction, key)?;
    ensure_entity_owner(transaction, "capability_uses", "use_id", id, session_id)?;
    transaction.execute(
        "INSERT OR IGNORE INTO checkpoint_use_pins(session_id,use_id,pin_kind,ordinal)
         VALUES (?1,?2,?3,?4)",
        params![session_id, id, pin_kind, usize_i64(ordinal)?],
    )?;
    Ok(())
}

fn insert_capability_pin(
    transaction: &Transaction<'_>,
    session_id: i64,
    pin_kind: &str,
    ordinal: usize,
    key: StableKey,
) -> Result<(), StorageError> {
    let id = capability_id(transaction, key)?;
    transaction.execute(
        "INSERT OR IGNORE INTO checkpoint_capability_pins(
           session_id,capability_id,pin_kind,ordinal
         ) VALUES (?1,?2,?3,?4)",
        params![session_id, id, pin_kind, usize_i64(ordinal)?],
    )?;
    Ok(())
}

fn replace_diagnostics(
    transaction: &Transaction<'_>,
    session_id: i64,
    diagnostics: &[DiagnosticFact],
) -> Result<(), StorageError> {
    transaction.execute(
        "DELETE FROM fact_diagnostics WHERE session_id=?1",
        [session_id],
    )?;
    for item in diagnostics {
        transaction.execute(
            "INSERT INTO fact_diagnostics(
               session_id,code,diagnostic_count,first_offset,digest
             ) VALUES (?1,?2,?3,?4,?5)",
            params![
                session_id,
                &item.code,
                item.count.to_be_bytes().to_vec(),
                optional_u64_blob(item.first_offset),
                optional_blob(item.digest),
            ],
        )?;
    }
    Ok(())
}

fn replace_coverage(
    transaction: &Transaction<'_>,
    session_id: i64,
    coverage: &BTreeMap<String, u64>,
) -> Result<(), StorageError> {
    transaction.execute(
        "DELETE FROM fact_coverage WHERE session_id=?1",
        [session_id],
    )?;
    for (name, count) in coverage {
        transaction.execute(
            "INSERT INTO fact_coverage(session_id,coverage_key,coverage_count)
             VALUES (?1,?2,?3)",
            params![session_id, name, count.to_be_bytes().to_vec()],
        )?;
    }
    Ok(())
}

fn collect_garbage(transaction: &Transaction<'_>, session_id: i64) -> Result<(), StorageError> {
    transaction.execute(
        "DELETE FROM source_records
         WHERE session_id=?1 AND NOT EXISTS(
           SELECT 1 FROM evidence_events
           WHERE evidence_events.source_record_id=source_records.source_record_id
         )",
        [session_id],
    )?;
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
    for id in candidates {
        transaction.execute("DELETE FROM capabilities WHERE capability_id=?1", [id])?;
    }
    Ok(())
}

pub(crate) fn read_committed_session(
    connection: &Connection,
    session_key: &StableKey,
) -> Result<Option<CommittedSessionFacts>, StorageError> {
    let Some((session_id, snapshot)) = read_session_snapshot(connection, session_key)? else {
        return Ok(None);
    };
    let checkpoint = read_checkpoint(connection, session_id)?.ok_or_else(|| {
        StorageError::new(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            "committed session is missing its source checkpoint",
        )
    })?;
    let capabilities = read_capabilities(
        connection,
        &checkpoint,
        &snapshot.evidence_events,
        &snapshot.capability_uses,
    )?;
    Ok(Some(CommittedSessionFacts {
        snapshot_seq: snapshot.snapshot_seq,
        fact_schema_version: snapshot.fact_schema_version,
        session: snapshot.session,
        checkpoint,
        turns: snapshot.turns,
        source_records: snapshot.source_records,
        evidence_events: snapshot.evidence_events,
        turn_evidence: snapshot.turn_evidence,
        capabilities,
        capability_uses: snapshot.capability_uses,
        capability_use_evidence: snapshot.capability_use_evidence,
        diagnostics: snapshot.diagnostics,
        coverage: snapshot.coverage,
    }))
}

fn read_session_snapshot(
    connection: &Connection,
    session_key: &StableKey,
) -> Result<Option<(i64, SessionFactSnapshot)>, StorageError> {
    let row = connection
        .query_row(
            "SELECT s.session_id,s.provider,s.session_scope,s.eligibility,s.project_key,
                    s.observed_start,s.observed_end,s.originator_version,
                    s.duplicate_group_key,s.dedupe_fingerprint,
                    s.dedupe_corroboration_fingerprint,s.duplicate_method,
                    s.duplicate_confidence,s.dedupe_closure,
                    s.duplicate_policy_version,c.snapshot_seq
             FROM sessions s JOIN session_commits c ON c.session_id=s.session_id
             WHERE s.session_key=?1",
            params![blob(*session_key)],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, String>(1)?,
                    enum_row::<SessionScope>(row, 2)?,
                    enum_row::<Eligibility>(row, 3)?,
                    optional_key_row(row, 4)?,
                    row.get::<_, Option<String>>(5)?,
                    row.get::<_, Option<String>>(6)?,
                    row.get::<_, Option<String>>(7)?,
                    optional_key_row(row, 8)?,
                    optional_key_row(row, 9)?,
                    optional_key_row(row, 10)?,
                    optional_enum_row::<DuplicateMethod>(row, 11)?,
                    optional_enum_row::<DuplicateConfidence>(row, 12)?,
                    optional_enum_row::<DedupeClosure>(row, 13)?,
                    row.get::<_, u8>(14)?,
                    row.get::<_, i64>(15)?,
                ))
            },
        )
        .optional()?;
    let Some((
        session_id,
        provider,
        session_scope,
        eligibility,
        project_key,
        observed_start,
        observed_end,
        originator_version,
        duplicate_group_key,
        dedupe_fingerprint,
        dedupe_corroboration_fingerprint,
        duplicate_method,
        duplicate_confidence,
        dedupe_closure,
        duplicate_policy_version,
        snapshot_seq,
    )) = row
    else {
        return Ok(None);
    };
    let session = SessionFact {
        session_key: *session_key,
        provider,
        session_scope,
        eligibility,
        project_key,
        observed_start,
        observed_end,
        originator_version,
        duplicate_group_key,
        dedupe_fingerprint,
        dedupe_corroboration_fingerprint,
        duplicate_method,
        duplicate_confidence,
        dedupe_closure,
        dedupe_evidence_event_keys: read_dedupe_events(connection, session_id)?,
        duplicate_policy_version,
        fact_truncation: read_flags(
            connection,
            "session_fact_truncation",
            "session_id",
            session_id,
        )?,
    };
    let stored_turns = read_turns(connection, session_id, *session_key)?;
    let source_records = read_source_records(connection, session_id, *session_key)?;
    let evidence_events = read_events(connection, session_id, *session_key)?;
    let turn_evidence = read_turn_links(connection, session_id, *session_key)?;
    let capability_uses = read_uses(connection, session_id, *session_key)?;
    let capability_use_evidence = read_use_links(connection, session_id, *session_key)?;
    let capabilities = read_capabilities_by_keys(
        connection,
        snapshot_capability_keys(connection, session_id, &evidence_events, &capability_uses)?,
    )?;
    Ok(Some((
        session_id,
        SessionFactSnapshot {
            snapshot_seq: snapshot_seq.to_string(),
            fact_schema_version: 1,
            session,
            turns: stored_turns.facts,
            turn_revisions: stored_turns.revisions,
            source_records,
            evidence_events,
            turn_evidence,
            capabilities,
            capability_uses,
            capability_use_evidence,
            diagnostics: read_diagnostics(connection, session_id)?,
            coverage: read_coverage(connection, session_id)?,
        },
    )))
}

impl FactRepository for Connection {
    fn apply_session_facts(
        &mut self,
        delta: SessionFactsDeltaV1,
    ) -> Result<CommitOutcome, StorageError> {
        crate::normalized_repository::apply_session_facts(self, &delta)
    }

    fn read_turn_closure(
        &self,
        turn_key: &StableKey,
    ) -> Result<Option<TurnFactClosure>, StorageError> {
        let Some(session_key) = owner_session_key(self, FactEntityKind::Turn, turn_key)? else {
            return Ok(None);
        };
        Ok(read_session_snapshot(self, &session_key)?
            .and_then(|(_, snapshot)| snapshot.turn_closure(turn_key)))
    }

    fn scan_snapshot(
        &self,
        snapshot_seq: u64,
        after_session_key: Option<&StableKey>,
        limit: u16,
    ) -> Result<FactSnapshotPage, StorageError> {
        if limit == 0 || limit > 256 {
            return Err(StorageError::new(
                "TS_INSIGHTS_FACT_SCAN_INVALID",
                "Fact snapshot scan limit must be between 1 and 256",
            ));
        }
        let snapshot_seq = i64::try_from(snapshot_seq).map_err(|_| {
            StorageError::new(
                "TS_INSIGHTS_FACT_SCAN_INVALID",
                "Fact snapshot sequence exceeds the repository range",
            )
        })?;
        let query_limit = i64::from(limit);
        let mut statement = self.prepare(
            "SELECT s.session_key
             FROM sessions s JOIN session_commits c ON c.session_id=s.session_id
             WHERE c.snapshot_seq<=?1
               AND (?2 IS NULL OR s.session_key>?2)
             ORDER BY s.session_key
             LIMIT ?3",
        )?;
        let keys = statement
            .query_map(
                params![
                    snapshot_seq,
                    after_session_key.map(|key| blob(*key)),
                    query_limit
                ],
                |row| key_row(row, 0),
            )?
            .collect::<Result<Vec<_>, _>>()?;
        let next_cursor = (keys.len() == usize::from(limit)).then(|| keys[keys.len() - 1]);
        let sessions = keys
            .into_iter()
            .map(|key| {
                read_session_snapshot(self, &key)?
                    .map(|(_, snapshot)| snapshot)
                    .ok_or_else(|| {
                        StorageError::new(
                            "TS_INSIGHTS_STORAGE_CORRUPT",
                            "Fact snapshot root disappeared during a bounded scan",
                        )
                    })
            })
            .collect::<Result<Vec<_>, StorageError>>()?;
        Ok(FactSnapshotPage {
            sessions,
            next_cursor,
        })
    }

    fn lookup_stable_key(
        &self,
        kind: FactEntityKind,
        key: &StableKey,
    ) -> Result<Option<FactEntity>, StorageError> {
        if kind == FactEntityKind::Capability {
            return Ok(read_capability(self, key)?.map(FactEntity::Capability));
        }
        if kind == FactEntityKind::Session {
            return Ok(read_session_snapshot(self, key)?
                .map(|(_, snapshot)| FactEntity::Session(Box::new(snapshot))));
        }
        let Some(session_key) = owner_session_key(self, kind, key)? else {
            return Ok(None);
        };
        let Some((_, snapshot)) = read_session_snapshot(self, &session_key)? else {
            return Ok(None);
        };
        Ok(match kind {
            FactEntityKind::Turn => snapshot
                .turn_closure(key)
                .map(Box::new)
                .map(FactEntity::Turn),
            FactEntityKind::SourceRecord => snapshot
                .source_records
                .into_iter()
                .find(|fact| fact.source_record_key == *key)
                .map(FactEntity::SourceRecord),
            FactEntityKind::EvidenceEvent => snapshot
                .evidence_events
                .into_iter()
                .find(|fact| fact.common().event_key == *key)
                .map(FactEntity::EvidenceEvent),
            FactEntityKind::CapabilityUse => snapshot
                .capability_uses
                .into_iter()
                .find(|fact| fact.use_key == *key)
                .map(FactEntity::CapabilityUse),
            FactEntityKind::Session | FactEntityKind::Capability => unreachable!(),
        })
    }

    fn read_committed_session(
        &self,
        session_key: &StableKey,
    ) -> Result<Option<CommittedSessionFacts>, StorageError> {
        crate::normalized_repository::read_committed_session(self, session_key)
    }
}

fn owner_session_key(
    connection: &Connection,
    kind: FactEntityKind,
    key: &StableKey,
) -> Result<Option<StableKey>, StorageError> {
    let sql = match kind {
        FactEntityKind::Turn => {
            "SELECT s.session_key FROM turns f JOIN sessions s ON s.session_id=f.session_id
             WHERE f.turn_key=?1"
        }
        FactEntityKind::SourceRecord => {
            "SELECT s.session_key FROM source_records f JOIN sessions s ON s.session_id=f.session_id
             WHERE f.source_record_key=?1"
        }
        FactEntityKind::EvidenceEvent => {
            "SELECT s.session_key FROM evidence_events f JOIN sessions s ON s.session_id=f.session_id
             WHERE f.event_key=?1"
        }
        FactEntityKind::CapabilityUse => {
            "SELECT s.session_key FROM capability_uses f JOIN sessions s ON s.session_id=f.session_id
             WHERE f.use_key=?1"
        }
        FactEntityKind::Session | FactEntityKind::Capability => return Ok(None),
    };
    connection
        .query_row(sql, params![blob(*key)], |row| key_row(row, 0))
        .optional()
        .map_err(Into::into)
}

fn read_dedupe_events(
    connection: &Connection,
    session_id: i64,
) -> Result<Vec<StableKey>, StorageError> {
    let mut statement = connection.prepare(
        "SELECT e.event_key FROM session_dedupe_evidence d
         JOIN evidence_events e ON e.event_id=d.event_id
         WHERE d.session_id=?1 ORDER BY d.ordinal",
    )?;
    Ok(statement
        .query_map([session_id], |row| key_row(row, 0))?
        .collect::<Result<Vec<_>, _>>()?)
}

fn read_flags(
    connection: &Connection,
    table: &str,
    owner_column: &str,
    owner_id: i64,
) -> Result<Vec<String>, StorageError> {
    let sql = format!("SELECT flag FROM {table} WHERE {owner_column}=?1 ORDER BY ordinal");
    let mut statement = connection.prepare(&sql)?;
    Ok(statement
        .query_map([owner_id], |row| row.get::<_, String>(0))?
        .collect::<Result<Vec<_>, _>>()?)
}

fn read_checkpoint(
    connection: &Connection,
    session_id: i64,
) -> Result<Option<Checkpoint>, StorageError> {
    let row = connection
        .query_row(
            "SELECT complete_offset,eof_observed,partial_tail_length,partial_tail_digest,
                    source_size,source_mtime_ns,source_snapshot_stable,
                    origin_secret_epoch,generation,pending_state_json
             FROM source_checkpoints WHERE session_id=?1",
            [session_id],
            |row| {
                Ok((
                    wire_row(row, 0)?,
                    row.get::<_, bool>(1)?,
                    wire_row(row, 2)?,
                    key_row(row, 3)?,
                    wire_row(row, 4)?,
                    wire_row(row, 5)?,
                    row.get::<_, bool>(6)?,
                    row.get::<_, String>(7)?,
                    wire_row(row, 8)?,
                    row.get::<_, String>(9)?,
                ))
            },
        )
        .optional()?;
    row.map(|row| {
        Ok(Checkpoint {
            complete_offset: row.0,
            eof_observed: row.1,
            partial_tail_length: row.2,
            partial_tail_digest: row.3,
            source_size: row.4,
            source_mtime_ns: row.5,
            source_snapshot_stable: row.6,
            origin_secret_epoch: row.7,
            generation: row.8,
            pending_state: serde_json::from_str(&row.9).map_err(|error| {
                StorageError::new("TS_INSIGHTS_STORAGE_CORRUPT", error.to_string())
            })?,
        })
    })
    .transpose()
}

struct StoredTurns {
    facts: Vec<TurnFact>,
    revisions: BTreeMap<StableKey, Option<[u8; 32]>>,
}

fn read_turns(
    connection: &Connection,
    session_id: i64,
    session_key: StableKey,
) -> Result<StoredTurns, StorageError> {
    let mut statement = connection.prepare(
        "SELECT turn_id,turn_key,turn_start_offset,problem_text,final_answer_excerpt,
                observed_timestamp,next_user_boundary,provider_terminal,
                observed_eof_closed,effective_provider_visibility,revision
         FROM turns WHERE session_id=?1 ORDER BY turn_key",
    )?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                TurnFact {
                    turn_key: key_row(row, 1)?,
                    owner_session_key: session_key,
                    turn_start_offset: wire_row(row, 2)?,
                    problem_text: row.get(3)?,
                    final_answer_excerpt: row.get(4)?,
                    observed_timestamp: row.get(5)?,
                    raw_closure: RawClosure {
                        next_user_boundary: row.get(6)?,
                        provider_terminal: optional_enum_row(row, 7)?,
                        observed_eof_closed: row.get(8)?,
                    },
                    provider_visibility: enum_row(row, 9)?,
                    fact_truncation: Vec::new(),
                },
                row.get::<_, Option<Vec<u8>>>(10)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    let rows = rows
        .into_iter()
        .map(|(turn_id, mut turn, revision)| {
            turn.fact_truncation =
                read_flags(connection, "turn_fact_truncation", "turn_id", turn_id)?;
            let revision = revision
                .map(|value| digest_from(&value, "stored Turn revision is not 32 bytes"))
                .transpose()?;
            Ok((turn, revision))
        })
        .collect::<Result<Vec<_>, StorageError>>()?;
    let revisions = rows
        .iter()
        .map(|(turn, revision)| (turn.turn_key, *revision))
        .collect();
    Ok(StoredTurns {
        facts: rows.into_iter().map(|(turn, _)| turn).collect(),
        revisions,
    })
}

fn read_source_records(
    connection: &Connection,
    session_id: i64,
    session_key: StableKey,
) -> Result<Vec<SourceRecordFact>, StorageError> {
    let mut statement = connection.prepare(
        "SELECT source_record_key,start_offset,end_offset,record_sha256,provider_record_class
         FROM source_records WHERE session_id=?1 ORDER BY source_record_key",
    )?;
    Ok(statement
        .query_map([session_id], |row| {
            Ok(SourceRecordFact {
                source_record_key: key_row(row, 0)?,
                owner_session_key: session_key,
                start_offset: wire_row(row, 1)?,
                end_offset: wire_row(row, 2)?,
                record_sha256: key_row(row, 3)?,
                provider_record_class: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

fn read_events(
    connection: &Connection,
    session_id: i64,
    session_key: StableKey,
) -> Result<Vec<EvidenceEvent>, StorageError> {
    let mut statement = connection.prepare(
        "SELECT e.event_id,e.event_key,t.turn_key,r.source_record_key,
                e.record_start_offset,e.content_index,e.event_ordinal,e.pointer_kind,
                e.pointer_content_index,e.pointer_event_ordinal,e.origin_scope,
                e.observed_timestamp,e.event_kind
         FROM evidence_events e
         LEFT JOIN turns t ON t.turn_id=e.occurred_turn_id
         JOIN source_records r ON r.source_record_id=e.source_record_id
         WHERE e.session_id=?1 ORDER BY e.event_key",
    )?;
    let rows = statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                EventCommon {
                    event_key: key_row(row, 1)?,
                    owner_session_key: session_key,
                    occurred_turn_key: optional_key_row(row, 2)?,
                    source_record_key: key_row(row, 3)?,
                    source_order: SourceOrder {
                        record_start_offset: wire_row(row, 4)?,
                        content_index: row.get(5)?,
                        event_ordinal: row.get(6)?,
                    },
                    pointer: EvidencePointer {
                        pointer_kind: row.get(7)?,
                        content_index: row.get(8)?,
                        event_ordinal: row.get(9)?,
                    },
                    origin_scope: enum_row(row, 10)?,
                    observed_timestamp: row.get(11)?,
                },
                row.get::<_, String>(12)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    rows.into_iter()
        .map(|(event_id, common, kind)| read_event_payload(connection, event_id, common, &kind))
        .collect()
}

fn read_event_payload(
    connection: &Connection,
    event_id: i64,
    common: EventCommon,
    kind: &str,
) -> Result<EvidenceEvent, StorageError> {
    match kind {
        "visible-message" => connection
            .query_row(
                "SELECT message_role FROM visible_message_events WHERE event_id=?1",
                [event_id],
                |row| enum_row::<MessageRole>(row, 0),
            )
            .map(|role| EvidenceEvent::VisibleMessage(VisibleMessageEvent { common, role }))
            .map_err(Into::into),
        "capability-invocation" => connection
            .query_row(
                "SELECT c.capability_key,e.correlation_digest,e.input_fingerprint
                 FROM capability_invocation_events e
                 JOIN capabilities c ON c.capability_id=e.capability_id
                 WHERE e.event_id=?1",
                [event_id],
                |row| Ok((key_row(row, 0)?, optional_key_row(row, 1)?, optional_key_row(row, 2)?)),
            )
            .map(|row| {
                EvidenceEvent::CapabilityInvocation(CapabilityInvocationEvent {
                    common,
                    capability_key: row.0,
                    correlation_digest: row.1,
                    input_fingerprint: row.2,
                })
            })
            .map_err(Into::into),
        "capability-result" => connection
            .query_row(
                "SELECT correlation_digest,provider_state,exit_code,output_bytes,duration_ms
                 FROM capability_result_events WHERE event_id=?1",
                [event_id],
                |row| {
                    Ok((
                        optional_key_row(row, 0)?,
                        enum_row::<ResultProviderState>(row, 1)?,
                        optional_wire_row(row, 2)?,
                        optional_wire_row(row, 3)?,
                        optional_wire_row(row, 4)?,
                    ))
                },
            )
            .map(|row| {
                EvidenceEvent::CapabilityResult(CapabilityResultEvent {
                    common,
                    correlation_digest: row.0,
                    provider_state: row.1,
                    exit_code: row.2,
                    output_bytes: row.3,
                    duration_ms: row.4,
                })
            })
            .map_err(Into::into),
        "skill-catalog-entry" => connection
            .query_row(
                "SELECT c.capability_key,e.path_fingerprint
                 FROM skill_catalog_entry_events e
                 JOIN capabilities c ON c.capability_id=e.capability_id
                 WHERE e.event_id=?1",
                [event_id],
                |row| Ok((key_row(row, 0)?, key_row(row, 1)?)),
            )
            .map(|row| {
                EvidenceEvent::SkillCatalogEntry(SkillCatalogEntryEvent {
                    common,
                    capability_key: row.0,
                    path_fingerprint: row.1,
                })
            })
            .map_err(Into::into),
        "skill-load" => connection
            .query_row(
                "SELECT c.capability_key,e.strength,e.evidence_source
                 FROM skill_load_events e JOIN capabilities c ON c.capability_id=e.capability_id
                 WHERE e.event_id=?1",
                [event_id],
                |row| Ok((key_row(row, 0)?, enum_row::<SkillLoadStrength>(row, 1)?, row.get::<_, String>(2)?)),
            )
            .map(|row| EvidenceEvent::SkillLoad(SkillLoadEvent {
                common,
                capability_key: row.0,
                strength: row.1,
                evidence_source: row.2,
            }))
            .map_err(Into::into),
        "turn-lifecycle" => connection
            .query_row(
                "SELECT lifecycle_state,provider_turn_digest FROM turn_lifecycle_events WHERE event_id=?1",
                [event_id],
                |row| Ok((enum_row::<LifecycleState>(row, 0)?, optional_key_row(row, 1)?)),
            )
            .map(|row| EvidenceEvent::TurnLifecycle(TurnLifecycleEvent {
                common,
                lifecycle_state: row.0,
                provider_turn_digest: row.1,
            }))
            .map_err(Into::into),
        "provider-status" => connection
            .query_row(
                "SELECT status_kind,provider_state,rolled_back_turn_count
                 FROM provider_status_events WHERE event_id=?1",
                [event_id],
                |row| Ok((
                    enum_row::<ProviderStatusKind>(row, 0)?,
                    enum_row::<ProviderStatusState>(row, 1)?,
                    optional_wire_row(row, 2)?,
                )),
            )
            .map(|row| EvidenceEvent::ProviderStatus(ProviderStatusEvent {
                common,
                status_kind: row.0,
                provider_state: row.1,
                rolled_back_turn_count: row.2,
            }))
            .map_err(Into::into),
        _ => Err(StorageError::new(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            format!("stored event has unknown kind {kind}"),
        )),
    }
}

fn read_turn_links(
    connection: &Connection,
    session_id: i64,
    session_key: StableKey,
) -> Result<Vec<TurnEvidenceFact>, StorageError> {
    let mut statement = connection.prepare(
        "SELECT t.turn_key,e.event_key,l.role FROM turn_evidence l
         JOIN turns t ON t.turn_id=l.turn_id
         JOIN evidence_events e ON e.event_id=l.event_id
         WHERE l.session_id=?1 ORDER BY t.turn_key,e.event_key,l.role",
    )?;
    Ok(statement
        .query_map([session_id], |row| {
            Ok(TurnEvidenceFact {
                owner_session_key: session_key,
                turn_key: key_row(row, 0)?,
                event_key: key_row(row, 1)?,
                role: enum_row(row, 2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

fn read_uses(
    connection: &Connection,
    session_id: i64,
    session_key: StableKey,
) -> Result<Vec<CapabilityUseFact>, StorageError> {
    let mut statement = connection.prepare(
        "SELECT u.use_key,t.turn_key,c.capability_key,u.turn_ordinal,
                u.exact_observed_name,u.origin_scope,u.origin_fingerprint,
                u.input_fingerprint,u.provider_terminal_state,u.strength,u.correlation_digest
         FROM capability_uses u JOIN turns t ON t.turn_id=u.turn_id
         JOIN capabilities c ON c.capability_id=u.capability_id
         WHERE u.session_id=?1 ORDER BY u.use_key",
    )?;
    Ok(statement
        .query_map([session_id], |row| {
            Ok(CapabilityUseFact {
                use_key: key_row(row, 0)?,
                owner_session_key: session_key,
                turn_key: key_row(row, 1)?,
                capability_key: key_row(row, 2)?,
                turn_ordinal: wire_row(row, 3)?.get(),
                exact_observed_name: row.get(4)?,
                origin_scope: enum_row(row, 5)?,
                origin_fingerprint: optional_key_row(row, 6)?,
                input_fingerprint: optional_key_row(row, 7)?,
                provider_terminal_state: enum_row(row, 8)?,
                strength: enum_row(row, 9)?,
                correlation_digest: optional_key_row(row, 10)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

fn read_use_links(
    connection: &Connection,
    session_id: i64,
    session_key: StableKey,
) -> Result<Vec<CapabilityUseEvidenceFact>, StorageError> {
    let mut statement = connection.prepare(
        "SELECT u.use_key,e.event_key,l.role FROM capability_use_evidence l
         JOIN capability_uses u ON u.use_id=l.use_id
         JOIN evidence_events e ON e.event_id=l.event_id
         WHERE l.session_id=?1 ORDER BY u.use_key,e.event_key,l.role",
    )?;
    Ok(statement
        .query_map([session_id], |row| {
            Ok(CapabilityUseEvidenceFact {
                owner_session_key: session_key,
                use_key: key_row(row, 0)?,
                event_key: key_row(row, 1)?,
                role: enum_row(row, 2)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

fn read_capabilities(
    connection: &Connection,
    checkpoint: &Checkpoint,
    events: &[EvidenceEvent],
    uses: &[CapabilityUseFact],
) -> Result<Vec<CapabilityFact>, StorageError> {
    let mut keys = referenced_capability_keys(events, uses);
    keys.extend(
        checkpoint
            .pending_state
            .pending_uses
            .iter()
            .filter_map(|item| item.capability_key),
    );
    keys.extend(
        checkpoint
            .pending_state
            .catalog_entries
            .iter()
            .map(|item| item.capability_key),
    );
    read_capabilities_by_keys(connection, keys)
}

fn referenced_capability_keys(
    events: &[EvidenceEvent],
    uses: &[CapabilityUseFact],
) -> BTreeSet<StableKey> {
    let mut keys = uses
        .iter()
        .map(|item| item.capability_key)
        .collect::<BTreeSet<_>>();
    for event in events {
        match event {
            EvidenceEvent::CapabilityInvocation(value) => {
                keys.insert(value.capability_key);
            }
            EvidenceEvent::SkillCatalogEntry(value) => {
                keys.insert(value.capability_key);
            }
            EvidenceEvent::SkillLoad(value) => {
                keys.insert(value.capability_key);
            }
            _ => {}
        }
    }
    keys
}

fn snapshot_capability_keys(
    connection: &Connection,
    session_id: i64,
    events: &[EvidenceEvent],
    uses: &[CapabilityUseFact],
) -> Result<BTreeSet<StableKey>, StorageError> {
    let mut keys = referenced_capability_keys(events, uses);
    let mut statement = connection.prepare(
        "SELECT c.capability_key
         FROM checkpoint_capability_pins p
         JOIN capabilities c ON c.capability_id=p.capability_id
         WHERE p.session_id=?1 ORDER BY c.capability_key",
    )?;
    keys.extend(
        statement
            .query_map([session_id], |row| key_row(row, 0))?
            .collect::<Result<Vec<_>, _>>()?,
    );
    Ok(keys)
}

fn read_capabilities_by_keys(
    connection: &Connection,
    keys: BTreeSet<StableKey>,
) -> Result<Vec<CapabilityFact>, StorageError> {
    keys.into_iter()
        .map(|capability_key| {
            connection
                .query_row(
                    "SELECT provider,capability_kind,canonical_name,identity_version
                 FROM capabilities WHERE capability_key=?1",
                    params![blob(capability_key)],
                    |row| {
                        Ok(CapabilityFact {
                            capability_key,
                            provider: row.get(0)?,
                            kind: enum_row(row, 1)?,
                            canonical_name: row.get(2)?,
                            identity_version: row.get(3)?,
                        })
                    },
                )
                .map_err(Into::into)
        })
        .collect()
}

fn read_capability(
    connection: &Connection,
    capability_key: &StableKey,
) -> Result<Option<CapabilityFact>, StorageError> {
    connection
        .query_row(
            "SELECT provider,capability_kind,canonical_name,identity_version
             FROM capabilities WHERE capability_key=?1",
            params![blob(*capability_key)],
            |row| {
                Ok(CapabilityFact {
                    capability_key: *capability_key,
                    provider: row.get(0)?,
                    kind: enum_row(row, 1)?,
                    canonical_name: row.get(2)?,
                    identity_version: row.get(3)?,
                })
            },
        )
        .optional()
        .map_err(Into::into)
}

fn read_diagnostics(
    connection: &Connection,
    session_id: i64,
) -> Result<Vec<DiagnosticFact>, StorageError> {
    let mut statement = connection.prepare(
        "SELECT code,diagnostic_count,first_offset,digest
         FROM fact_diagnostics WHERE session_id=?1 ORDER BY code",
    )?;
    Ok(statement
        .query_map([session_id], |row| {
            Ok(DiagnosticFact {
                code: row.get(0)?,
                count: wire_row(row, 1)?.get(),
                first_offset: optional_wire_row(row, 2)?,
                digest: optional_key_row(row, 3)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?)
}

fn read_coverage(
    connection: &Connection,
    session_id: i64,
) -> Result<BTreeMap<String, u64>, StorageError> {
    let mut statement = connection.prepare(
        "SELECT coverage_key,coverage_count FROM fact_coverage
         WHERE session_id=?1 ORDER BY coverage_key",
    )?;
    Ok(statement
        .query_map([session_id], |row| {
            Ok((row.get::<_, String>(0)?, wire_row(row, 1)?.get()))
        })?
        .collect::<Result<Vec<_>, _>>()?
        .into_iter()
        .collect())
}

fn session_id(transaction: &Transaction<'_>, key: StableKey) -> Result<i64, StorageError> {
    entity_id(transaction, "sessions", "session_key", key)
}
fn turn_id(transaction: &Transaction<'_>, key: StableKey) -> Result<i64, StorageError> {
    entity_id(transaction, "turns", "turn_key", key)
}
fn source_record_id(transaction: &Transaction<'_>, key: StableKey) -> Result<i64, StorageError> {
    entity_id(transaction, "source_records", "source_record_key", key)
}
fn capability_id(transaction: &Transaction<'_>, key: StableKey) -> Result<i64, StorageError> {
    entity_id(transaction, "capabilities", "capability_key", key)
}
fn event_id(transaction: &Transaction<'_>, key: StableKey) -> Result<i64, StorageError> {
    entity_id(transaction, "evidence_events", "event_key", key)
}
fn use_id(transaction: &Transaction<'_>, key: StableKey) -> Result<i64, StorageError> {
    entity_id(transaction, "capability_uses", "use_key", key)
}

fn entity_id(
    transaction: &Transaction<'_>,
    table: &str,
    key_column: &str,
    key: StableKey,
) -> Result<i64, StorageError> {
    transaction
        .query_row(
            &format!(
                "SELECT {table_name}_id FROM {table} WHERE {key_column}=?1",
                table_name = entity_name(table)
            ),
            params![blob(key)],
            |row| row.get(0),
        )
        .map_err(|error| {
            if error == rusqlite::Error::QueryReturnedNoRows {
                StorageError::new(
                    "TS_INSIGHTS_FOREIGN_KEY",
                    format!("missing {table} row for stable key"),
                )
            } else {
                error.into()
            }
        })
}

fn entity_name(table: &str) -> &'static str {
    match table {
        "sessions" => "session",
        "turns" => "turn",
        "source_records" => "source_record",
        "capabilities" => "capability",
        "evidence_events" => "event",
        "capability_uses" => "use",
        _ => unreachable!("fixed normalized table"),
    }
}

fn optional_entity_id(
    transaction: &Transaction<'_>,
    sql: &str,
    owner_id: i64,
    key: StableKey,
) -> Result<Option<i64>, StorageError> {
    Ok(transaction
        .query_row(sql, params![owner_id, blob(key)], |row| row.get(0))
        .optional()?)
}

fn ensure_entity_owner(
    transaction: &Transaction<'_>,
    table: &str,
    id_column: &str,
    entity_id: i64,
    session_id: i64,
) -> Result<(), StorageError> {
    let count: i64 = transaction.query_row(
        &format!("SELECT COUNT(*) FROM {table} WHERE {id_column}=?1 AND session_id=?2"),
        params![entity_id, session_id],
        |row| row.get(0),
    )?;
    if count != 1 {
        return Err(StorageError::new(
            "TS_INSIGHTS_FOREIGN_KEY",
            format!("checkpoint references a missing or foreign {table} row"),
        ));
    }
    Ok(())
}

fn event_kind(event: &EvidenceEvent) -> &'static str {
    match event {
        EvidenceEvent::VisibleMessage(_) => "visible-message",
        EvidenceEvent::CapabilityInvocation(_) => "capability-invocation",
        EvidenceEvent::CapabilityResult(_) => "capability-result",
        EvidenceEvent::SkillCatalogEntry(_) => "skill-catalog-entry",
        EvidenceEvent::SkillLoad(_) => "skill-load",
        EvidenceEvent::TurnLifecycle(_) => "turn-lifecycle",
        EvidenceEvent::ProviderStatus(_) => "provider-status",
    }
}

fn blob(value: StableKey) -> Vec<u8> {
    value.as_bytes().to_vec()
}
fn optional_blob(value: Option<StableKey>) -> Option<Vec<u8>> {
    value.map(blob)
}
fn u64_blob(value: WireU64) -> Vec<u8> {
    value.to_be_blob().to_vec()
}
fn optional_u64_blob(value: Option<WireU64>) -> Option<Vec<u8>> {
    value.map(u64_blob)
}

fn key_from(value: &[u8]) -> Result<StableKey, StorageError> {
    let bytes = digest_from(value, "stored key is not 32 bytes")?;
    Ok(StableKey::from_bytes(bytes))
}
fn digest_from(value: &[u8], message: &'static str) -> Result<[u8; 32], StorageError> {
    value
        .try_into()
        .map_err(|_| StorageError::new("TS_INSIGHTS_STORAGE_CORRUPT", message))
}
fn wire_from(value: &[u8]) -> Result<WireU64, StorageError> {
    WireU64::from_be_blob(value).map_err(|error| StorageError::new(error.code, error.message))
}
fn key_row(row: &Row<'_>, index: usize) -> rusqlite::Result<StableKey> {
    let value = row.get::<_, Vec<u8>>(index)?;
    key_from(&value).map_err(|error| conversion_error(index, error))
}
fn optional_key_row(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<StableKey>> {
    row.get::<_, Option<Vec<u8>>>(index)?
        .map(|value| key_from(&value).map_err(|error| conversion_error(index, error)))
        .transpose()
}
fn wire_row(row: &Row<'_>, index: usize) -> rusqlite::Result<WireU64> {
    let value = row.get::<_, Vec<u8>>(index)?;
    wire_from(&value).map_err(|error| conversion_error(index, error))
}
fn optional_wire_row(row: &Row<'_>, index: usize) -> rusqlite::Result<Option<WireU64>> {
    row.get::<_, Option<Vec<u8>>>(index)?
        .map(|value| wire_from(&value).map_err(|error| conversion_error(index, error)))
        .transpose()
}
fn enum_text<T: Serialize>(value: T) -> String {
    serde_json::to_value(value)
        .unwrap()
        .as_str()
        .unwrap()
        .to_owned()
}
fn optional_enum<T: Serialize>(value: Option<T>) -> Option<String> {
    value.map(enum_text)
}
fn enum_row<T: DeserializeOwned>(row: &Row<'_>, index: usize) -> rusqlite::Result<T> {
    let value = row.get::<_, String>(index)?;
    serde_json::from_value(serde_json::Value::String(value)).map_err(|error| {
        conversion_error(
            index,
            StorageError::new("TS_INSIGHTS_STORAGE_CORRUPT", error.to_string()),
        )
    })
}
fn optional_enum_row<T: DeserializeOwned>(
    row: &Row<'_>,
    index: usize,
) -> rusqlite::Result<Option<T>> {
    row.get::<_, Option<String>>(index)?
        .map(|value| {
            serde_json::from_value(serde_json::Value::String(value)).map_err(|error| {
                conversion_error(
                    index,
                    StorageError::new("TS_INSIGHTS_STORAGE_CORRUPT", error.to_string()),
                )
            })
        })
        .transpose()
}
fn conversion_error(index: usize, error: StorageError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Blob, Box::new(error))
}
fn bool_int(value: bool) -> i64 {
    if value { 1 } else { 0 }
}
fn usize_i64(value: usize) -> Result<i64, StorageError> {
    i64::try_from(value).map_err(|_| {
        StorageError::new(
            "TS_INSIGHTS_STORAGE_FAILED",
            "ordinal exceeds SQLite integer range",
        )
    })
}

#[cfg(test)]
mod tests {
    use super::{apply_session_facts, initialize_schema};
    use crate::fact_model::{MutationMode, SessionFactsDeltaV1, StableKey};
    use crate::fact_repository::{FactEntity, FactEntityKind, FactRepository};
    use rusqlite::Connection;
    use serde_json::Value;

    fn connection() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "PRAGMA foreign_keys=ON;
                 CREATE TABLE engine_metadata (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL
                 ) WITHOUT ROWID;
                 INSERT INTO engine_metadata(key,value) VALUES('snapshot_seq','0');",
            )
            .unwrap();
        initialize_schema(&mut connection).unwrap();
        connection
    }

    fn query_plan(connection: &Connection, sql: &str) -> Vec<String> {
        connection
            .prepare(sql)
            .unwrap()
            .query_map([1_i64], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    }

    fn mutation_trace() -> Vec<SessionFactsDeltaV1> {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
        ))
        .unwrap();
        let initial = SessionFactsDeltaV1::try_from(fixture["initial"].clone()).unwrap();
        let mut append = initial.clone();
        append.expected_generation = append.target_generation;
        append.target_generation = "2".parse().unwrap();
        append.checkpoint.generation = append.target_generation;
        append.delta_id = StableKey::from_bytes([0xa1; 32]);
        append.turns[0].final_answer_excerpt = Some("seam append".to_owned());
        let mut replacement = append.clone();
        replacement.expected_generation = replacement.target_generation;
        replacement.target_generation = "3".parse().unwrap();
        replacement.checkpoint.generation = replacement.target_generation;
        replacement.delta_id = StableKey::from_bytes([0xa2; 32]);
        replacement.mode = MutationMode::ReplaceSession;
        replacement.turns[0].problem_text = "seam replacement".to_owned();
        vec![initial, append, replacement]
    }

    #[test]
    fn uses_surrogate_entity_ids_and_bounded_commit_receipts() {
        let mut connection = Connection::open_in_memory().unwrap();
        initialize_schema(&mut connection).unwrap();

        for (table, id_column, key_column) in [
            ("sessions", "session_id", "session_key"),
            ("turns", "turn_id", "turn_key"),
            ("source_records", "source_record_id", "source_record_key"),
            ("evidence_events", "event_id", "event_key"),
            ("capabilities", "capability_id", "capability_key"),
            ("capability_uses", "use_id", "use_key"),
        ] {
            let columns = connection
                .prepare(&format!(
                    "SELECT name,type,pk FROM pragma_table_info('{table}')"
                ))
                .unwrap()
                .query_map([], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                    ))
                })
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert!(columns.contains(&(id_column.to_owned(), "INTEGER".to_owned(), 1)));
            assert!(columns.contains(&(key_column.to_owned(), "BLOB".to_owned(), 0)));
        }

        let receipt_columns = connection
            .prepare("SELECT name,type FROM pragma_table_info('session_commits') ORDER BY cid")
            .unwrap()
            .query_map([], |row| {
                Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            !receipt_columns
                .iter()
                .any(|(name, _)| name == "canonical_delta")
        );
        assert!(receipt_columns.contains(&("canonical_digest".to_owned(), "BLOB".to_owned())));
    }

    #[test]
    fn source_record_gc_uses_the_event_foreign_key_index() {
        let connection = connection();
        let plan = connection
            .prepare(
                "EXPLAIN QUERY PLAN
                 DELETE FROM source_records
                 WHERE session_id=?1 AND NOT EXISTS(
                   SELECT 1 FROM evidence_events
                   WHERE evidence_events.source_record_id=source_records.source_record_id
                 )",
            )
            .unwrap()
            .query_map([1_i64], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            plan.iter()
                .any(|detail| detail.contains("evidence_events_source_record")),
            "source record GC must not scan the full evidence-event table: {plan:?}",
        );
    }

    #[test]
    fn mutation_and_foreign_key_paths_use_reverse_indexes() {
        let connection = connection();
        for (sql, index) in [
            (
                "EXPLAIN QUERY PLAN DELETE FROM capability_uses WHERE turn_id=?1",
                "capability_uses_turn",
            ),
            (
                "EXPLAIN QUERY PLAN DELETE FROM evidence_events WHERE occurred_turn_id=?1",
                "evidence_events_occurred_turn",
            ),
            (
                "EXPLAIN QUERY PLAN DELETE FROM turn_evidence
                 WHERE session_id=?1 AND role='rollback'",
                "turn_evidence_session_role",
            ),
            (
                "EXPLAIN QUERY PLAN DELETE FROM turn_evidence WHERE event_id=?1",
                "turn_evidence_event",
            ),
            (
                "EXPLAIN QUERY PLAN DELETE FROM capability_use_evidence WHERE session_id=?1",
                "capability_use_evidence_session",
            ),
            (
                "EXPLAIN QUERY PLAN DELETE FROM capability_use_evidence WHERE event_id=?1",
                "capability_use_evidence_event",
            ),
            (
                "EXPLAIN QUERY PLAN DELETE FROM checkpoint_turn_pins WHERE turn_id=?1",
                "checkpoint_turn_pins_turn",
            ),
            (
                "EXPLAIN QUERY PLAN DELETE FROM checkpoint_event_pins WHERE event_id=?1",
                "checkpoint_event_pins_event",
            ),
            (
                "EXPLAIN QUERY PLAN DELETE FROM checkpoint_use_pins WHERE use_id=?1",
                "checkpoint_use_pins_use",
            ),
            (
                "EXPLAIN QUERY PLAN DELETE FROM checkpoint_capability_pins WHERE capability_id=?1",
                "checkpoint_capability_pins_capability",
            ),
            (
                "EXPLAIN QUERY PLAN DELETE FROM session_dedupe_evidence WHERE event_id=?1",
                "session_dedupe_evidence_event",
            ),
            (
                "EXPLAIN QUERY PLAN SELECT use_id FROM capability_uses
                 WHERE session_id=?1 ORDER BY use_key",
                "capability_uses_session_key",
            ),
        ] {
            let plan = query_plan(&connection, sql);
            assert!(
                plan.iter().any(|detail| detail.contains(index)),
                "{index} must serve its bounded mutation path: {plan:?}",
            );
            assert!(
                plan.iter().all(|detail| !detail.starts_with("SCAN ")),
                "mutation path must not scan a full table: {plan:?}",
            );
        }

        for (table, index) in [
            ("capability_uses", "capability_uses_capability"),
            (
                "capability_invocation_events",
                "capability_invocation_events_capability",
            ),
            (
                "skill_catalog_entry_events",
                "skill_catalog_entry_events_capability",
            ),
            ("skill_load_events", "skill_load_events_capability"),
            (
                "checkpoint_capability_pins",
                "checkpoint_capability_pins_capability",
            ),
        ] {
            let plan = query_plan(
                &connection,
                &format!("EXPLAIN QUERY PLAN SELECT 1 FROM {table} WHERE capability_id=?1"),
            );
            assert!(
                plan.iter().any(|detail| detail.contains(index)),
                "capability GC must use {index}: {plan:?}",
            );
            assert!(
                plan.iter().all(|detail| !detail.starts_with("SCAN ")),
                "capability GC must not scan {table}: {plan:?}",
            );
        }
    }

    #[test]
    fn normalized_and_seam_dispatch_have_same_mutation_trace_digests() {
        let mut concrete = connection();
        let mut through_seam = connection();
        let mut previous_digest = None;
        let trace = mutation_trace();
        let session_key = trace[0].session.session_key;
        let turn_key = trace[0].turns[0].turn_key;

        for (index, delta) in trace.into_iter().enumerate() {
            let concrete_outcome = apply_session_facts(&mut concrete, &delta).unwrap();
            let seam_outcome =
                FactRepository::apply_session_facts(&mut through_seam, delta).unwrap();
            assert_eq!(concrete_outcome, seam_outcome);
            let snapshot_seq = u64::try_from(index + 1).unwrap();
            let concrete_page =
                FactRepository::scan_snapshot(&concrete, snapshot_seq, None, 16).unwrap();
            let seam_page =
                FactRepository::scan_snapshot(&through_seam, snapshot_seq, None, 16).unwrap();
            let digest = concrete_page.semantic_digest().unwrap();
            assert_eq!(digest, seam_page.semantic_digest().unwrap());
            if let Some(previous_digest) = previous_digest {
                assert_ne!(digest, previous_digest);
            }
            previous_digest = Some(digest);
        }

        assert_eq!(
            FactRepository::read_turn_closure(&concrete, &turn_key).unwrap(),
            FactRepository::read_turn_closure(&through_seam, &turn_key).unwrap()
        );
        let looked_up =
            FactRepository::lookup_stable_key(&through_seam, FactEntityKind::Session, &session_key)
                .unwrap()
                .unwrap();
        assert_eq!(looked_up.stable_key(), session_key);
        assert!(matches!(looked_up, FactEntity::Session(_)));
    }
}
