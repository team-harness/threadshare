use rusqlite::{Connection, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fs;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};
use threadshare_insights_engine::fact_model::{
    Completeness, Eligibility, EventCommon, EvidenceEvent, EvidencePointer, HistoryEventFact,
    HistoryPayloadChunkFact, HistoryPayloadFact, HistoryPayloadKind, LifecycleState, MessageRole,
    MutationMode, OriginScope, PayloadEncoding, ProviderStatusEvent, ProviderStatusKind,
    ProviderStatusState, ProviderTerminal, ProviderVisibility, RawClosure, SessionFactsDeltaV1,
    SourceOrder, SourceRecordFact, StableKey, TurnEvidenceFact, TurnEvidenceRole, TurnFact,
    TurnLifecycleEvent, VisibleMessageEvent, WireU64, expected_history_event_revision,
};
use threadshare_insights_engine::storage::EngineStorage;
use threadshare_insights_engine::{hash_key, try_canonical_json};

static NEXT_PATH: AtomicU64 = AtomicU64::new(0);

struct TemporaryDatabase {
    directory: PathBuf,
    path: PathBuf,
}

impl TemporaryDatabase {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "threadshare-normalized-facts-{}-{}",
            std::process::id(),
            NEXT_PATH.fetch_add(1, Ordering::Relaxed)
        ));
        fs::create_dir(&directory).unwrap();
        let path = directory.join("engine.sqlite3");
        Self { directory, path }
    }
}

impl Drop for TemporaryDatabase {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.directory);
    }
}

fn fixture_delta() -> SessionFactsDeltaV1 {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
    ))
    .unwrap();
    SessionFactsDeltaV1::try_from(fixture["initial"].clone()).unwrap()
}

fn fixture_delta_v2() -> SessionFactsDeltaV1 {
    let mut delta = fixture_delta();
    delta.format = "session-facts-delta@v2".to_owned();
    delta.fact_schema_version = 2;
    delta.provider_adapter_version = "codex@3".to_owned();
    delta.privacy_policy_version = 2;
    let event = delta.evidence_events[0].common();
    let history_event_key = key(0x72);
    let payload_key = key(0x71);
    let content = "private payload 界";
    let content_bytes = content.as_bytes();
    let payload_sha256 = StableKey::from_bytes(Sha256::digest(content_bytes).into());
    let mut history_event = HistoryEventFact {
        event_key: history_event_key,
        owner_session_key: event.owner_session_key,
        occurred_turn_key: None,
        source_record_key: event.source_record_key,
        source_order: event.source_order.clone(),
        origin_scope: event.origin_scope,
        observed_timestamp: event.observed_timestamp.clone(),
        kind: "visible-message".to_owned(),
        completeness: Completeness::Full,
        revision: key(0),
        metadata: serde_json::json!({"role":"user"}),
        payload_keys: vec![payload_key],
    };
    let payload = HistoryPayloadFact {
        payload_key,
        owner_session_key: delta.session.session_key,
        event_key: history_event_key,
        payload_kind: HistoryPayloadKind::MessageContent,
        encoding: PayloadEncoding::Utf8,
        byte_length: wire(content_bytes.len() as u64),
        sha256: payload_sha256,
        completeness: Completeness::Full,
        chunk_count: wire(1),
    };
    history_event.revision = StableKey::from_bytes(
        Sha256::digest(
            try_canonical_json(&serde_json::json!({
                "eventKey": history_event.event_key,
                "ownerSessionKey": history_event.owner_session_key,
                "occurredTurnKey": history_event.occurred_turn_key,
                "sourceRecordKey": history_event.source_record_key,
                "sourceOrder": history_event.source_order,
                "originScope": history_event.origin_scope,
                "observedTimestamp": history_event.observed_timestamp,
                "kind": history_event.kind,
                "completeness": history_event.completeness,
                "metadata": history_event.metadata,
                "payloads": [{
                    "payloadKey": payload.payload_key,
                    "sha256": payload.sha256,
                    "byteLength": payload.byte_length,
                }],
            }))
            .unwrap()
            .as_bytes(),
        )
        .into(),
    );
    delta.history_events = vec![history_event];
    delta.history_payloads = vec![payload];
    delta.history_payload_chunks = vec![HistoryPayloadChunkFact {
        payload_key,
        owner_session_key: delta.session.session_key,
        ordinal: wire(0),
        content: content.to_owned(),
        byte_length: wire(content_bytes.len() as u64),
        sha256: payload_sha256,
    }];
    delta
}

fn clear_session_owned_facts(delta: &mut SessionFactsDeltaV1) {
    delta.retractions.turn_keys.clear();
    delta.retractions.orphan_event_keys.clear();
    delta.retractions.authoritative_turn_keys.clear();
    delta.turns.clear();
    delta.source_records.clear();
    delta.evidence_events.clear();
    delta.turn_evidence.clear();
    delta.capabilities.clear();
    delta.capability_uses.clear();
    delta.capability_use_evidence.clear();
    delta.checkpoint.pending_state.current_turn_key = None;
    delta.checkpoint.pending_state.replay_from_offset = None;
    delta.checkpoint.pending_state.pending_started.clear();
    delta.checkpoint.pending_state.session_state.first_turn_key = None;
    delta.checkpoint.pending_state.session_state.second_turn_key = None;
    delta.checkpoint.pending_state.session_state.dedupe = None;
    delta.checkpoint.pending_state.catalog_entries.clear();
    delta.checkpoint.pending_state.seen_claude_uuids.clear();
}

fn key(value: u8) -> StableKey {
    StableKey::from_bytes([value; 32])
}

fn wire(value: u64) -> WireU64 {
    value.to_string().parse().unwrap()
}

fn source_record(
    session_key: StableKey,
    source_record_key: StableKey,
    start_offset: u64,
    digest_byte: u8,
) -> SourceRecordFact {
    SourceRecordFact {
        source_record_key,
        owner_session_key: session_key,
        start_offset: wire(start_offset),
        end_offset: wire(start_offset + 1),
        record_sha256: key(digest_byte),
        provider_record_class: "fixture-record".to_owned(),
    }
}

fn event_common(
    session_key: StableKey,
    event_key: StableKey,
    occurred_turn_key: Option<StableKey>,
    source_record_key: StableKey,
    record_start_offset: u64,
) -> EventCommon {
    EventCommon {
        event_key,
        owner_session_key: session_key,
        occurred_turn_key,
        source_record_key,
        source_order: SourceOrder {
            record_start_offset: wire(record_start_offset),
            content_index: -1,
            event_ordinal: 0,
        },
        pointer: EvidencePointer {
            pointer_kind: "fixture-record".to_owned(),
            content_index: -1,
            event_ordinal: 0,
        },
        origin_scope: OriginScope::Main,
        observed_timestamp: None,
    }
}

fn rollback_scenario(rollback_count: Option<u64>) -> SessionFactsDeltaV1 {
    let mut delta = fixture_delta();
    clear_session_owned_facts(&mut delta);
    delta.checkpoint.pending_state.pending_uses.clear();
    delta.diagnostics.clear();
    delta.coverage.clear();
    let session_key = delta.session.session_key;
    let turn_key = key(0x21);
    let lifecycle_record_key = key(0x31);
    let lifecycle_event_key = key(0x41);
    delta.retractions.authoritative_turn_keys = vec![turn_key];
    delta.turns.push(TurnFact {
        turn_key,
        owner_session_key: session_key,
        turn_start_offset: wire(1),
        problem_text: "rollback target".to_owned(),
        final_answer_excerpt: Some("sealed answer".to_owned()),
        observed_timestamp: None,
        raw_closure: RawClosure {
            next_user_boundary: false,
            provider_terminal: Some(ProviderTerminal::Completed),
            observed_eof_closed: false,
        },
        provider_visibility: ProviderVisibility::Active,
        fact_truncation: Vec::new(),
    });
    delta
        .source_records
        .push(source_record(session_key, lifecycle_record_key, 10, 0x91));
    delta
        .evidence_events
        .push(EvidenceEvent::TurnLifecycle(TurnLifecycleEvent {
            common: event_common(
                session_key,
                lifecycle_event_key,
                Some(turn_key),
                lifecycle_record_key,
                10,
            ),
            lifecycle_state: LifecycleState::Completed,
            provider_turn_digest: None,
        }));
    delta.turn_evidence.push(TurnEvidenceFact {
        owner_session_key: session_key,
        turn_key,
        event_key: lifecycle_event_key,
        role: TurnEvidenceRole::Lifecycle,
    });
    if let Some(rollback_count) = rollback_count {
        let rollback_record_key = key(0x32);
        delta
            .source_records
            .push(source_record(session_key, rollback_record_key, 20, 0x92));
        delta
            .evidence_events
            .push(EvidenceEvent::ProviderStatus(ProviderStatusEvent {
                common: event_common(session_key, key(0x42), None, rollback_record_key, 20),
                status_kind: ProviderStatusKind::ThreadRolledBack,
                provider_state: ProviderStatusState::Observed,
                rolled_back_turn_count: Some(wire(rollback_count)),
            }));
    }
    delta
}

fn next_delta(delta: &mut SessionFactsDeltaV1, delta_id_byte: u8) {
    delta.expected_generation = wire(delta.target_generation.get());
    delta.target_generation = wire(delta.target_generation.get() + 1);
    delta.checkpoint.generation = delta.target_generation;
    delta.delta_id = key(delta_id_byte);
}

fn derived_turns(path: &PathBuf) -> Vec<(StableKey, String, [u8; 32])> {
    let connection = Connection::open(path).unwrap();
    let mut statement = connection
        .prepare(
            "SELECT turn_key,effective_provider_visibility,revision
             FROM turns ORDER BY turn_key",
        )
        .unwrap();
    statement
        .query_map([], |row| {
            let turn_key = row.get::<_, Vec<u8>>(0)?;
            let revision = row.get::<_, Vec<u8>>(2)?;
            Ok((
                StableKey::from_bytes(turn_key.try_into().unwrap()),
                row.get(1)?,
                revision.try_into().unwrap(),
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap()
}

#[test]
fn commits_typed_normalized_facts_idempotently_and_reads_them_after_restart() {
    let database = TemporaryDatabase::new();
    let delta = fixture_delta();

    let first = {
        let mut storage = EngineStorage::open(&database.path).unwrap();
        let outcome = storage.apply_session_facts(delta.clone()).unwrap();
        assert_eq!(outcome.snapshot_seq, "1");
        assert!(!outcome.idempotent);

        let replay = storage.apply_session_facts(delta.clone()).unwrap();
        assert_eq!(replay.snapshot_seq, "1");
        assert!(replay.idempotent);
        storage
            .read_committed_session(&delta.session.session_key)
            .unwrap()
            .unwrap()
    };

    let reopened = EngineStorage::open(&database.path)
        .unwrap()
        .read_committed_session(&delta.session.session_key)
        .unwrap()
        .unwrap();

    assert_eq!(reopened, first);
    assert_eq!(reopened.session, delta.session);
    assert_eq!(reopened.checkpoint, delta.checkpoint);
    assert_eq!(reopened.turns, delta.turns);
    let mut expected_source_records = delta.source_records.clone();
    expected_source_records.sort_by_key(|record| record.source_record_key);
    assert_eq!(reopened.source_records, expected_source_records);
    assert_eq!(reopened.evidence_events, delta.evidence_events);
    assert_eq!(reopened.turn_evidence, delta.turn_evidence);
    assert_eq!(reopened.capabilities, delta.capabilities);
    assert_eq!(reopened.capability_uses, delta.capability_uses);
    assert_eq!(
        reopened.capability_use_evidence,
        delta.capability_use_evidence
    );
    assert_eq!(reopened.diagnostics, delta.diagnostics);
    assert_eq!(reopened.coverage, delta.coverage);
}

#[test]
fn commits_fact_v2_history_payloads_and_reopens_losslessly() {
    let database = TemporaryDatabase::new();
    let delta = fixture_delta_v2();
    {
        let mut storage = EngineStorage::open(&database.path).unwrap();
        let outcome = storage.apply_session_facts(delta).unwrap();
        assert_eq!(outcome.snapshot_seq, "1");
        assert_eq!(
            storage.read_engine_status().unwrap().fact_storage_profile,
            "normalized-row-v2"
        );
    }

    let connection = Connection::open(&database.path).unwrap();
    let event_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM history_events", [], |row| row.get(0))
        .unwrap();
    let payload_count: i64 = connection
        .query_row("SELECT COUNT(*) FROM history_payloads", [], |row| {
            row.get(0)
        })
        .unwrap();
    let content: String = connection
        .query_row(
            "SELECT group_concat(content, '') FROM (
               SELECT content FROM history_payload_chunks ORDER BY ordinal
             )",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(event_count, 1);
    assert_eq!(payload_count, 1);
    assert_eq!(content, "private payload 界");
}

#[test]
fn projects_fact_v2_file_token_and_error_metadata_transactionally() {
    let database = TemporaryDatabase::new();
    let mut delta = fixture_delta_v2();
    let event = &mut delta.history_events[0];
    event.kind = "capability-result".to_owned();
    event.observed_timestamp = Some("2026-08-12T01:02:03.000Z".to_owned());
    event.metadata = serde_json::json!({
        "capabilityKey": key(0x81),
        "providerState": "failed",
        "fileActivities": [{
            "action": "edit",
            "phase": "failed",
            "pathRole": "target",
            "rawPath": "/private/project/src/lib.rs",
            "normalizedPath": "/private/project/src/lib.rs",
            "relativePath": "src/lib.rs",
            "absolute": true,
            "projectRelative": true
        }],
        "errorSignatureVersion": "error-signature@1",
        "errorSignature": key(0x82),
        "usageScope": "delta",
        "model": "fixture-model",
        "inputTokens": "12",
        "cachedInputTokens": "4",
        "outputTokens": "3"
    });
    event.revision = expected_history_event_revision(event, &[&delta.history_payloads[0]]).unwrap();

    let mut storage = EngineStorage::open(&database.path).unwrap();
    storage.apply_session_facts(delta).unwrap();
    drop(storage);

    let connection = Connection::open(&database.path).unwrap();
    let file: (String, String, String, String, i64, i64) = connection
        .query_row(
            "SELECT action,phase,raw_path,relative_path,is_absolute,is_project_relative
             FROM file_activity",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                    row.get(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(
        file,
        (
            "edit".to_owned(),
            "failed".to_owned(),
            "/private/project/src/lib.rs".to_owned(),
            "src/lib.rs".to_owned(),
            1,
            1
        )
    );
    let tokens: (String, String, Option<String>, Option<String>) = connection
        .query_row(
            "SELECT model,lower(hex(input_tokens)),lower(hex(cached_input_tokens)),
                    CASE WHEN reasoning_tokens IS NULL THEN NULL
                         ELSE lower(hex(reasoning_tokens)) END
             FROM token_usage",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(
        tokens,
        (
            "fixture-model".to_owned(),
            "000000000000000c".to_owned(),
            Some("0000000000000004".to_owned()),
            None
        )
    );
    let error: (String, String) = connection
        .query_row(
            "SELECT signature_version,lower(hex(error_signature)) FROM error_occurrences",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(
        error,
        ("error-signature@1".to_owned(), key(0x82).to_string())
    );
}

#[test]
fn database_fact_schema_identity_prevents_v1_v2_mixing() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();
    assert_eq!(storage.database_fact_schema_version().unwrap(), Some(1));

    let error = storage.apply_session_facts(fixture_delta_v2()).unwrap_err();
    assert_eq!(error.code, "TS_INSIGHTS_FACT_SCHEMA_MIGRATION_REQUIRED");
    assert_eq!(storage.database_fact_schema_version().unwrap(), Some(1));
    assert_eq!(storage.committed_session_count().unwrap(), 1);
}

#[test]
fn first_fact_v2_commit_binds_the_empty_database_identity() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    assert_eq!(storage.database_fact_schema_version().unwrap(), None);
    storage.apply_session_facts(fixture_delta_v2()).unwrap();
    assert_eq!(storage.database_fact_schema_version().unwrap(), Some(2));
}

#[test]
fn rejects_a_stale_generation_without_changing_committed_facts() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta();
    storage.apply_session_facts(delta.clone()).unwrap();

    let mut stale = delta.clone();
    stale.delta_id = "abababababababababababababababababababababababababababababababab"
        .parse()
        .unwrap();
    let error = storage.apply_session_facts(stale).unwrap_err();

    assert_eq!(error.code, "TS_INSIGHTS_GENERATION_CONFLICT");
    assert_eq!(
        storage
            .read_committed_session(&delta.session.session_key)
            .unwrap()
            .unwrap()
            .snapshot_seq,
        "1"
    );
}

#[test]
fn derives_duplicate_group_key_in_the_engine() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let mut delta = fixture_delta();
    let fingerprint: StableKey = "1212121212121212121212121212121212121212121212121212121212121212"
        .parse()
        .unwrap();
    delta.session.dedupe_fingerprint = Some(fingerprint);

    storage.apply_session_facts(delta.clone()).unwrap();
    let committed = storage
        .read_committed_session(&delta.session.session_key)
        .unwrap()
        .unwrap();
    let expected: StableKey = hash_key(
        "duplicate-group",
        &[
            delta.session.provider.as_bytes().to_vec(),
            fingerprint.as_bytes().to_vec(),
        ],
    )
    .parse()
    .unwrap();

    assert_eq!(committed.session.duplicate_group_key, Some(expected));
}

#[test]
fn preserves_a_capability_pinned_only_by_another_sessions_checkpoint() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let initial = fixture_delta();
    let capability_key = initial.capabilities[0].capability_key;
    storage.apply_session_facts(initial.clone()).unwrap();

    let mut pinned = fixture_delta();
    let pinned_session_key: StableKey =
        "abababababababababababababababababababababababababababababababab"
            .parse()
            .unwrap();
    pinned.session.session_key = pinned_session_key;
    pinned.checkpoint.pending_state.session_state.session_key = pinned_session_key;
    pinned.delta_id = "1313131313131313131313131313131313131313131313131313131313131313"
        .parse()
        .unwrap();
    clear_session_owned_facts(&mut pinned);
    pinned.checkpoint.pending_state.pending_uses[0].use_key = None;
    storage.apply_session_facts(pinned.clone()).unwrap();

    let mut replacement = initial.clone();
    replacement.expected_generation = "1".parse().unwrap();
    replacement.target_generation = "2".parse().unwrap();
    replacement.checkpoint.generation = "2".parse().unwrap();
    replacement.delta_id = "1414141414141414141414141414141414141414141414141414141414141414"
        .parse()
        .unwrap();
    replacement.mode = MutationMode::ReplaceSession;
    clear_session_owned_facts(&mut replacement);
    replacement.checkpoint.pending_state.pending_uses.clear();
    storage.apply_session_facts(replacement).unwrap();

    let committed = storage
        .read_committed_session(&pinned_session_key)
        .unwrap()
        .unwrap();
    assert_eq!(committed.capabilities.len(), 1);
    assert_eq!(committed.capabilities[0].capability_key, capability_key);
}

#[test]
fn replays_rollback_visibility_and_records_engine_evidence() {
    let database = TemporaryDatabase::new();
    let delta = rollback_scenario(Some(1));
    EngineStorage::open(&database.path)
        .unwrap()
        .apply_session_facts(delta)
        .unwrap();

    let connection = Connection::open(&database.path).unwrap();
    let (visibility, rollback_links, unresolved, fts_rows, rollup_rows): (
        String,
        i64,
        i64,
        i64,
        i64,
    ) = connection
        .query_row(
            "SELECT
               (SELECT effective_provider_visibility FROM turns LIMIT 1),
               (SELECT COUNT(*) FROM turn_evidence WHERE role='rollback'),
               (SELECT COUNT(*) FROM fact_diagnostics WHERE code='rollback-unresolved'),
               (SELECT COUNT(*) FROM turns_fts),
               (SELECT COUNT(*) FROM turn_rollup_contributions)",
            [],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(visibility, "rolled-back");
    assert_eq!(rollback_links, 1);
    assert_eq!(unresolved, 0);
    assert_eq!((fts_rows, rollup_rows), (0, 0));
}

#[test]
fn replaces_rollback_unresolved_diagnostics_without_accumulating() {
    let database = TemporaryDatabase::new();
    let first = rollback_scenario(Some(2));
    let mut storage = EngineStorage::open(&database.path).unwrap();
    storage.apply_session_facts(first.clone()).unwrap();

    let mut replacement = first;
    next_delta(&mut replacement, 0xa2);
    replacement.mode = MutationMode::ReplaceSession;
    storage.apply_session_facts(replacement).unwrap();
    drop(storage);

    let connection = Connection::open(&database.path).unwrap();
    let (diagnostic, coverage): (Vec<u8>, Vec<u8>) = connection
        .query_row(
            "SELECT d.diagnostic_count,c.coverage_count
               FROM fact_diagnostics d JOIN fact_coverage c USING(session_id)
              WHERE d.code='rollback-unresolved'
                AND c.coverage_key='rollback-unresolved'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(u64::from_be_bytes(diagnostic.try_into().unwrap()), 1);
    assert_eq!(u64::from_be_bytes(coverage.try_into().unwrap()), 1);
}

#[test]
fn follow_up_link_revises_an_already_sealed_turn() {
    let database = TemporaryDatabase::new();
    let first = rollback_scenario(None);
    let session_key = first.session.session_key;
    let first_turn_key = first.turns[0].turn_key;
    let mut storage = EngineStorage::open(&database.path).unwrap();
    storage.apply_session_facts(first.clone()).unwrap();
    drop(storage);
    let before = derived_turns(&database.path)[0].2;

    let mut follow_up = first;
    next_delta(&mut follow_up, 0xa3);
    clear_session_owned_facts(&mut follow_up);
    follow_up.checkpoint.pending_state.pending_uses.clear();
    follow_up.diagnostics.clear();
    follow_up.coverage.clear();
    let next_turn_key = key(0x22);
    let record_key = key(0x33);
    let event_key = key(0x43);
    follow_up.retractions.authoritative_turn_keys = vec![next_turn_key];
    follow_up.turns.push(TurnFact {
        turn_key: next_turn_key,
        owner_session_key: session_key,
        turn_start_offset: wire(30),
        problem_text: "follow-up".to_owned(),
        final_answer_excerpt: None,
        observed_timestamp: None,
        raw_closure: RawClosure {
            next_user_boundary: false,
            provider_terminal: None,
            observed_eof_closed: false,
        },
        provider_visibility: ProviderVisibility::Active,
        fact_truncation: Vec::new(),
    });
    follow_up
        .source_records
        .push(source_record(session_key, record_key, 30, 0x93));
    follow_up
        .evidence_events
        .push(EvidenceEvent::VisibleMessage(VisibleMessageEvent {
            common: event_common(session_key, event_key, Some(next_turn_key), record_key, 30),
            role: MessageRole::User,
        }));
    follow_up.turn_evidence.push(TurnEvidenceFact {
        owner_session_key: session_key,
        turn_key: first_turn_key,
        event_key,
        role: TurnEvidenceRole::FollowUp,
    });

    EngineStorage::open(&database.path)
        .unwrap()
        .apply_session_facts(follow_up)
        .unwrap();
    let after = derived_turns(&database.path);
    assert_ne!(after[0].2, before);
    let connection = Connection::open(&database.path).unwrap();
    let change_count: i64 = connection
        .query_row(
            "SELECT COUNT(*) FROM projection_change_log
             WHERE snapshot_seq=2 AND root_kind='turn' AND root_key=?1 AND operation='upsert'",
            params![first_turn_key.as_bytes().as_slice()],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(change_count, 1);
}

#[test]
fn incremental_and_replace_rebuild_have_equal_derived_turns() {
    let incremental_database = TemporaryDatabase::new();
    let initial = rollback_scenario(None);
    let mut storage = EngineStorage::open(&incremental_database.path).unwrap();
    storage.apply_session_facts(initial.clone()).unwrap();
    let mut rollback = rollback_scenario(Some(1));
    next_delta(&mut rollback, 0xa4);
    rollback.mode = MutationMode::Append;
    rollback.turns.clear();
    rollback.retractions.authoritative_turn_keys.clear();
    rollback.source_records.remove(0);
    rollback.evidence_events.remove(0);
    rollback.turn_evidence.clear();
    storage.apply_session_facts(rollback).unwrap();
    drop(storage);

    let replacement_database = TemporaryDatabase::new();
    let mut replacement = rollback_scenario(Some(1));
    replacement.mode = MutationMode::ReplaceSession;
    EngineStorage::open(&replacement_database.path)
        .unwrap()
        .apply_session_facts(replacement)
        .unwrap();

    assert_eq!(
        derived_turns(&incremental_database.path),
        derived_turns(&replacement_database.path)
    );
}

#[test]
fn retraction_deletes_turn_projection_and_logs_a_tombstone() {
    let database = TemporaryDatabase::new();
    let initial = rollback_scenario(None);
    let turn_key = initial.turns[0].turn_key;
    let mut storage = EngineStorage::open(&database.path).unwrap();
    storage.apply_session_facts(initial.clone()).unwrap();
    drop(storage);

    let connection = Connection::open(&database.path).unwrap();
    let turn_id: i64 = connection
        .query_row(
            "SELECT turn_id FROM turns WHERE turn_key=?1",
            params![turn_key.as_bytes().as_slice()],
            |row| row.get(0),
        )
        .unwrap();
    let initial_projection: (i64, i64, i64, i64, i64) = connection
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM turns_fts WHERE rowid=?1),
               (SELECT COUNT(*) FROM turn_rollup_contributions WHERE turn_id=?1),
               (SELECT COUNT(*) FROM projection_state WHERE status='active'),
               (SELECT MIN(watermark) FROM projection_state WHERE status='active'),
               (SELECT MAX(watermark) FROM projection_state WHERE status='active')",
            params![turn_id],
            |row| {
                Ok((
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                    row.get(4)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(initial_projection, (1, 1, 2, 1, 1));
    drop(connection);

    let mut retraction = initial;
    next_delta(&mut retraction, 0xa5);
    clear_session_owned_facts(&mut retraction);
    retraction.checkpoint.pending_state.pending_uses.clear();
    retraction.diagnostics.clear();
    retraction.coverage.clear();
    retraction.retractions.turn_keys = vec![turn_key];
    EngineStorage::open(&database.path)
        .unwrap()
        .apply_session_facts(retraction)
        .unwrap();

    let connection = Connection::open(&database.path).unwrap();
    let (fts_rows, rollup_rows, tombstones, watermark): (i64, i64, i64, i64) = connection
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM turns_fts WHERE rowid=?1),
               (SELECT COUNT(*) FROM turn_rollup_contributions WHERE turn_id=?1),
               (SELECT COUNT(*) FROM projection_change_log
                 WHERE snapshot_seq=2 AND root_kind='turn' AND root_key=?2
                   AND operation='tombstone'),
               (SELECT MIN(watermark) FROM projection_state WHERE status='active')",
            params![turn_id, turn_key.as_bytes().as_slice()],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!((fts_rows, rollup_rows, tombstones, watermark), (0, 0, 1, 2));
}

#[test]
fn provisional_turn_is_searchable_without_a_persistent_rollup() {
    let database = TemporaryDatabase::new();
    EngineStorage::open(&database.path)
        .unwrap()
        .apply_session_facts(fixture_delta())
        .unwrap();

    let connection = Connection::open(&database.path).unwrap();
    let counts: (i64, i64) = connection
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM turns_fts),
               (SELECT COUNT(*) FROM turn_rollup_contributions)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(counts, (1, 0));
}

#[test]
fn making_a_session_ineligible_removes_its_active_turn_projections() {
    let database = TemporaryDatabase::new();
    let initial = rollback_scenario(None);
    let mut storage = EngineStorage::open(&database.path).unwrap();
    storage.apply_session_facts(initial.clone()).unwrap();

    let mut excluded = initial;
    next_delta(&mut excluded, 0xa6);
    clear_session_owned_facts(&mut excluded);
    excluded.checkpoint.pending_state.pending_uses.clear();
    excluded.diagnostics.clear();
    excluded.coverage.clear();
    excluded.session.eligibility = Eligibility::Unknown;
    storage.apply_session_facts(excluded).unwrap();
    drop(storage);

    let connection = Connection::open(&database.path).unwrap();
    let counts: (i64, i64) = connection
        .query_row(
            "SELECT
               (SELECT COUNT(*) FROM turns_fts),
               (SELECT COUNT(*) FROM turn_rollup_contributions)",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(counts, (0, 0));
}
