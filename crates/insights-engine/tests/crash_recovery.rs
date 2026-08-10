#![cfg_attr(not(debug_assertions), allow(dead_code, unused_imports))]

use rusqlite::{Connection, params};
use serde::Deserialize;
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::fs;
use std::io::Cursor;
use std::path::{Path, PathBuf};
use std::process::{Command, ExitStatus, Stdio};
use std::sync::atomic::{AtomicU64, Ordering};
use threadshare_insights_engine::engine_status::FACT_STORAGE_PROFILE;
use threadshare_insights_engine::fact_model::{SessionFactsDeltaV1, StableKey};
use threadshare_insights_engine::fact_repository::CommittedSessionFacts;
use threadshare_insights_engine::protocol::{read_frame, write_frame};
use threadshare_insights_engine::retry_projection::{
    RETRY_PROJECTION_NAME, active_retry_summaries, advance_retry_projection_build,
    begin_retry_projection_build, catch_up_retry_projection,
};
use threadshare_insights_engine::search_projection::{
    active_search_projection_version, advance_search_projection_build, catch_up_search_projection,
    ensure_search_projection,
};
use threadshare_insights_engine::source_state::{PurgeState, SourceStatePage};
use threadshare_insights_engine::storage::EngineStorage;
use threadshare_insights_engine::{hash_key, try_canonical_json};

#[cfg(unix)]
use std::os::unix::process::ExitStatusExt;

const TEST_CRASH_ENV: &str = "THREADSHARE_INSIGHTS_TEST_CRASH_AT";
const TEST_CRASH_MARKER_ENV: &str = "THREADSHARE_INSIGHTS_TEST_CRASH_MARKER";
const CRASH_WORKER_ENV: &str = "THREADSHARE_INSIGHTS_CRASH_WORKER";
const CRASH_DATABASE_ENV: &str = "THREADSHARE_INSIGHTS_CRASH_DATABASE";
static NEXT_PATH: AtomicU64 = AtomicU64::new(0);

fn session_key() -> StableKey {
    StableKey::from_bytes([0xaa; 32])
}

struct TemporaryDatabase {
    directory: PathBuf,
    path: PathBuf,
}

impl TemporaryDatabase {
    fn new(label: &str) -> Self {
        let directory = std::env::temp_dir().join(format!(
            "threadshare-crash-recovery-{label}-{}-{}",
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

#[derive(Deserialize)]
struct ProtocolFixture {
    frames: Vec<ProtocolFrame>,
}

#[derive(Deserialize)]
struct ProtocolFrame {
    name: String,
    message: Value,
}

struct EngineRun {
    status: ExitStatus,
    responses: Vec<Value>,
    stderr: String,
    crash_marker: Option<String>,
}

struct CrashRun {
    status: ExitStatus,
    crash_marker: Option<String>,
}

#[derive(Debug, PartialEq, Eq)]
struct LogicalSnapshot {
    committed_session_count: u64,
    session: Option<CommittedSessionFacts>,
    source_states: SourceStatePage,
    status: Value,
    retry_summaries: Vec<(Vec<u8>, u64, u64, u64)>,
    table_counts: Vec<(String, i64)>,
    stable_rows: Vec<String>,
}

fn fixture_delta() -> SessionFactsDeltaV1 {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
    ))
    .unwrap();
    SessionFactsDeltaV1::try_from(fixture["initial"].clone()).unwrap()
}

fn protocol_ingest_messages() -> Vec<Value> {
    let fixture: ProtocolFixture = serde_json::from_str(include_str!(
        "../../../test/fixtures/insights-protocol-v1/frames.json"
    ))
    .unwrap();
    let frame = |name: &str| {
        fixture
            .frames
            .iter()
            .find(|frame| frame.name == name)
            .unwrap()
            .message
            .clone()
    };
    let mut delta = serde_json::to_value(fixture_delta()).unwrap();
    let mut begin = frame("begin-session");
    begin["session"] = json!({
        "sessionKey": delta["session"]["sessionKey"],
        "provider": delta["session"]["provider"],
        "sessionScope": delta["session"]["sessionScope"],
        "eligibility": delta["session"]["eligibility"],
        "duplicatePolicyVersion": delta["session"]["duplicatePolicyVersion"],
    });
    delta["session"] = begin["session"].clone();
    let mut mutation = delta.clone();
    mutation.as_object_mut().unwrap().remove("deltaId");
    let mutation_digest = Sha256::digest(try_canonical_json(&mutation).unwrap()).to_vec();
    delta["deltaId"] = Value::String(hash_key(
        "delta",
        &[
            hex::decode(delta["session"]["sessionKey"].as_str().unwrap()).unwrap(),
            delta["expectedGeneration"]
                .as_str()
                .unwrap()
                .as_bytes()
                .to_vec(),
            delta["mode"].as_str().unwrap().as_bytes().to_vec(),
            delta["originSecretEpoch"]
                .as_str()
                .unwrap()
                .as_bytes()
                .to_vec(),
            delta["duplicatePolicyVersion"]
                .as_u64()
                .unwrap()
                .to_string()
                .into_bytes(),
            mutation_digest,
            delta["checkpoint"]["completeOffset"]
                .as_str()
                .unwrap()
                .as_bytes()
                .to_vec(),
        ],
    ));
    begin["deltaId"] = delta["deltaId"].clone();
    begin["mode"] = delta["mode"].clone();
    begin["expectedGeneration"] = delta["expectedGeneration"].clone();
    begin["targetGeneration"] = delta["targetGeneration"].clone();

    let retraction_collections = ["turnKeys", "orphanEventKeys", "authoritativeTurnKeys"];
    let upsert_collections = [
        "turns",
        "sourceRecords",
        "evidenceEvents",
        "turnEvidence",
        "capabilities",
        "capabilityUses",
        "capabilityUseEvidence",
    ];
    let mut counts = serde_json::Map::new();
    for collection in retraction_collections {
        counts.insert(
            collection.to_owned(),
            Value::String(
                delta["retractions"][collection]
                    .as_array()
                    .unwrap()
                    .len()
                    .to_string(),
            ),
        );
    }
    for collection in upsert_collections {
        counts.insert(
            collection.to_owned(),
            Value::String(delta[collection].as_array().unwrap().len().to_string()),
        );
    }
    begin["counts"] = Value::Object(counts);

    let mut messages = vec![frame("hello"), begin];
    let mut sequence = 0_u64;
    for collection in retraction_collections {
        let items = delta["retractions"][collection].clone();
        if items.as_array().unwrap().is_empty() {
            continue;
        }
        messages.push(json!({
            "format": "threadshare-insights-protocol@v1",
            "type": "RETRACT_FACTS",
            "requestId": "2",
            "sequence": sequence.to_string(),
            "collection": collection,
            "items": items,
        }));
        sequence += 1;
    }
    for collection in upsert_collections {
        let items = delta[collection].clone();
        if items.as_array().unwrap().is_empty() {
            continue;
        }
        messages.push(json!({
            "format": "threadshare-insights-protocol@v1",
            "type": "UPSERT_FACTS",
            "requestId": "2",
            "sequence": sequence.to_string(),
            "collection": collection,
            "items": items,
        }));
        sequence += 1;
    }
    let mut commit = frame("commit-session");
    commit["nextSequence"] = Value::String(sequence.to_string());
    commit["checkpoint"] = delta["checkpoint"].clone();
    commit["diagnostics"] = delta["diagnostics"].clone();
    commit["coverage"] = delta["coverage"].clone();
    let complete_offset = delta["checkpoint"]["completeOffset"]
        .as_str()
        .unwrap()
        .parse::<u64>()
        .unwrap();
    commit["sourceState"] = json!({
        "provider": delta["session"]["provider"],
        "sessionId": "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
        "fileUtf8Hex": "2f746d702f74687265616473686172652f636f6465782d73657373696f6e2e6a736f6e6c",
        "sessionKey": delta["session"]["sessionKey"],
        "projectKey": null,
        "metadata": {
            "dev": "1",
            "ino": "2",
            "size": delta["checkpoint"]["sourceSize"],
            "mtimeNs": delta["checkpoint"]["sourceMtimeNs"],
        },
        "fingerprints": {
            "head": {
                "offset": "0",
                "length": 4096,
                "sha256": "eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee",
            },
            "boundary": {
                "offset": (complete_offset - 4096).to_string(),
                "length": 4096,
                "sha256": "ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff",
            },
        },
        "contract": {
            "factSchemaVersion": delta["factSchemaVersion"],
            "providerAdapterVersion": delta["providerAdapterVersion"],
            "privacyPolicyVersion": delta["privacyPolicyVersion"],
            "duplicatePolicyVersion": delta["duplicatePolicyVersion"],
            "originSecretEpoch": delta["originSecretEpoch"],
        },
    });
    messages.push(commit);
    messages
}

fn crash_marker_path(path: &Path) -> PathBuf {
    path.parent().unwrap().join("crash-marker")
}

fn run_engine(path: &Path, failpoint: Option<&str>) -> EngineRun {
    let crash_marker_path = crash_marker_path(path);
    let _ = fs::remove_file(&crash_marker_path);
    let mut command = Command::new(env!("CARGO_BIN_EXE_threadshare-insights-engine"));
    command
        .arg("--db")
        .arg(path)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .env_remove(TEST_CRASH_ENV)
        .env_remove(TEST_CRASH_MARKER_ENV);
    if let Some(failpoint) = failpoint {
        command
            .env(TEST_CRASH_ENV, failpoint)
            .env(TEST_CRASH_MARKER_ENV, &crash_marker_path);
    }
    let mut child = command.spawn().unwrap();
    {
        let mut stdin = child.stdin.take().unwrap();
        for message in protocol_ingest_messages() {
            write_frame(&mut stdin, &message).unwrap();
        }
    }
    let output = child.wait_with_output().unwrap();
    let mut cursor = Cursor::new(&output.stdout);
    let mut responses = Vec::new();
    while let Some(response) = read_frame(&mut cursor).unwrap() {
        responses.push(response);
    }
    EngineRun {
        status: output.status,
        responses,
        stderr: String::from_utf8_lossy(&output.stderr).into_owned(),
        crash_marker: fs::read_to_string(crash_marker_path).ok(),
    }
}

fn session_committed(run: &EngineRun) -> Option<&Value> {
    run.responses
        .iter()
        .find(|response| response["type"] == "SESSION_COMMITTED")
}

fn assert_aborted(status: &ExitStatus, crash_marker: Option<&str>, failpoint: &str, context: &str) {
    assert!(
        !status.success(),
        "{context} unexpectedly exited successfully"
    );
    assert_eq!(
        crash_marker,
        Some(failpoint),
        "{context} did not reach the requested crash failpoint"
    );
    #[cfg(unix)]
    assert_eq!(
        status.signal(),
        Some(6),
        "{context} did not terminate via SIGABRT"
    );
}

fn stable_table_counts(path: &Path) -> Vec<(String, i64)> {
    let connection = Connection::open(path).unwrap();
    [
        "sessions",
        "session_commits",
        "turns",
        "source_records",
        "evidence_events",
        "turn_evidence",
        "capabilities",
        "capability_uses",
        "capability_use_evidence",
        "source_checkpoints",
        "turn_fts_documents",
        "turns_fts",
        "turn_rollup_contributions",
        "projection_change_log",
        "source_ingestion_states",
        "source_ingestion_staging",
        "source_purge_states",
        "capability_retry_contributions",
        "retry_projection_build_cursor",
    ]
    .into_iter()
    .map(|table| {
        let count = connection
            .query_row(&format!("SELECT COUNT(*) FROM {table}"), [], |row| {
                row.get(0)
            })
            .unwrap();
        (table.to_owned(), count)
    })
    .collect()
}

fn stable_database_rows(path: &Path) -> Vec<String> {
    let connection = Connection::open(path).unwrap();
    let queries = [
        "SELECT 'commit|' || hex(session.session_key) || '|' ||
                hex(receipt.generation) || '|' || hex(receipt.delta_id) || '|' ||
                hex(receipt.canonical_digest) || '|' || receipt.snapshot_seq
         FROM session_commits AS receipt
         JOIN sessions AS session USING(session_id)
         ORDER BY session.session_key",
        "SELECT 'projection|' || name || '|' || version || '|' ||
                input_fact_schema_version || '|' || root_kind || '|' ||
                base_snapshot_seq || '|' || watermark || '|' || status || '|' ||
                COALESCE(hex(error_digest),'')
         FROM projection_state ORDER BY name,version",
        "SELECT 'change|' || snapshot_seq || '|' || hex(owner_session_key) || '|' ||
                root_kind || '|' || hex(root_key) || '|' || operation
         FROM projection_change_log ORDER BY snapshot_seq,root_kind,root_key",
        "SELECT 'source|' || hex(session.session_key) || '|' || state.state_json || '|' ||
                hex(state.state_digest)
         FROM source_ingestion_states AS state
         JOIN sessions AS session USING(session_id)
         ORDER BY session.session_key",
        "SELECT 'purge|' || hex(session_key) || '|' || purge_state
         FROM source_purge_states ORDER BY session_key",
        "SELECT 'retry|' || projection_version || '|' || hex(owner_session_key) || '|' ||
                hex(capability_key) || '|' || failed_count || '|' ||
                same_input_repeat_count || '|' || retry_after_failure_count
         FROM capability_retry_contributions
         ORDER BY projection_version,owner_session_key,capability_key",
        "SELECT 'cursor|' || projection_version || '|' || base_snapshot_seq || '|' ||
                COALESCE(hex(last_session_key),'') || '|' || base_complete
         FROM retry_projection_build_cursor ORDER BY projection_version",
    ];
    let mut rows = Vec::new();
    for query in queries {
        let mut statement = connection.prepare(query).unwrap();
        rows.extend(
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap(),
        );
    }
    rows
}

fn logical_snapshot(path: &Path) -> LogicalSnapshot {
    let storage = EngineStorage::open(path).unwrap();
    let committed_session_count = storage.committed_session_count().unwrap();
    let session = storage.read_committed_session(&session_key()).unwrap();
    let source_states = storage.list_source_states(None, 256).unwrap();
    let status = storage.read_engine_status().unwrap();
    assert_eq!(status.integrity.quick_check, "ok");
    assert_eq!(status.integrity.fts, "ok");
    let stable_status = json!({
        "snapshotSeq": status.snapshot_seq,
        "factStorageProfile": status.fact_storage_profile,
        "projections": status.projections,
        "changeLog": status.change_log,
        "purge": status.purge,
        "integrity": status.integrity,
    });
    drop(storage);

    let connection = Connection::open(path).unwrap();
    let retry_summaries = active_retry_summaries(&connection)
        .unwrap()
        .into_iter()
        .map(|summary| {
            (
                summary.capability_key,
                summary.failed_count,
                summary.same_input_repeat_count,
                summary.retry_after_failure_count,
            )
        })
        .collect();
    drop(connection);

    LogicalSnapshot {
        committed_session_count,
        session,
        source_states,
        status: stable_status,
        retry_summaries,
        table_counts: stable_table_counts(path),
        stable_rows: stable_database_rows(path),
    }
}

fn apply_fixture(path: &Path) {
    let mut storage = EngineStorage::open(path).unwrap();
    let outcome = storage.apply_session_facts(fixture_delta()).unwrap();
    assert!(!outcome.idempotent);
}

fn build_retry_base(connection: &mut Connection, version: u32) {
    begin_retry_projection_build(connection, version, 1).unwrap();
    for _ in 0..4 {
        if advance_retry_projection_build(connection, version, 256)
            .unwrap()
            .base_complete
        {
            return;
        }
    }
    panic!("retry projection base scan did not complete");
}

fn activate_retry_projection(connection: &mut Connection, version: u32) {
    for _ in 0..4 {
        let progress = catch_up_retry_projection(connection, version, 256).unwrap();
        if progress.status == "active" {
            return;
        }
    }
    panic!("retry projection catch-up did not activate");
}

fn prepare_retry_switch(path: &Path, switch_version_two: bool) {
    apply_fixture(path);
    let mut connection = Connection::open(path).unwrap();
    build_retry_base(&mut connection, 1);
    activate_retry_projection(&mut connection, 1);
    build_retry_base(&mut connection, 2);
    if switch_version_two {
        activate_retry_projection(&mut connection, 2);
    }
}

fn prepare_search_switch(path: &Path, switch_version_two: bool) {
    apply_fixture(path);
    let mut connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "DELETE FROM projection_state
             WHERE name='turn-search' AND version=2;
             INSERT INTO projection_state(
               name,version,input_fact_schema_version,root_kind,
               base_snapshot_seq,watermark,status,error_digest
             ) VALUES ('turn-search',1,1,'turn',0,1,'active',NULL);",
        )
        .unwrap();
    ensure_search_projection(&mut connection).unwrap();
    for _ in 0..4 {
        if advance_search_projection_build(&mut connection, 256)
            .unwrap()
            .base_complete
        {
            break;
        }
    }
    if switch_version_two {
        let progress = catch_up_search_projection(&mut connection, 256).unwrap();
        assert_eq!(progress.status, "active");
    }
}

fn prepare_pending_purge(path: &Path) {
    apply_fixture(path);
    let mut storage = EngineStorage::open(path).unwrap();
    let outcome = storage.exclude_source(session_key()).unwrap();
    assert_eq!(outcome.purge_state, PurgeState::PendingPurge);
}

fn finish_purge(path: &Path) {
    let mut storage = EngineStorage::open(path).unwrap();
    for _ in 0..4 {
        let outcome = storage.run_purge_maintenance(256).unwrap();
        if outcome.status.state == PurgeState::Purged {
            return;
        }
    }
    panic!("purge maintenance did not finish");
}

fn source_publish_counts(path: &Path) -> (i64, i64, i64) {
    let connection = Connection::open(path).unwrap();
    let sessions = connection
        .query_row("SELECT COUNT(*) FROM sessions", [], |row| row.get(0))
        .unwrap();
    let staging = connection
        .query_row("SELECT COUNT(*) FROM source_ingestion_staging", [], |row| {
            row.get(0)
        })
        .unwrap();
    let published = connection
        .query_row("SELECT COUNT(*) FROM source_ingestion_states", [], |row| {
            row.get(0)
        })
        .unwrap();
    (sessions, staging, published)
}

fn purge_intermediate_state(path: &Path) -> (i64, String) {
    let connection = Connection::open(path).unwrap();
    let sessions = connection
        .query_row(
            "SELECT COUNT(*) FROM sessions WHERE session_key=?1",
            params![session_key().as_bytes().as_slice()],
            |row| row.get(0),
        )
        .unwrap();
    let purge_state = connection
        .query_row(
            "SELECT purge_state FROM source_purge_states WHERE session_key=?1",
            params![session_key().as_bytes().as_slice()],
            |row| row.get(0),
        )
        .unwrap();
    (sessions, purge_state)
}

fn spawn_crash_worker(path: &Path, worker: &str, failpoint: &str) -> CrashRun {
    let crash_marker_path = crash_marker_path(path);
    let _ = fs::remove_file(&crash_marker_path);
    let status = Command::new(std::env::current_exe().unwrap())
        .args(["--exact", "crash_worker", "--nocapture"])
        .env(CRASH_WORKER_ENV, worker)
        .env(CRASH_DATABASE_ENV, path)
        .env(TEST_CRASH_ENV, failpoint)
        .env(TEST_CRASH_MARKER_ENV, &crash_marker_path)
        .stdin(Stdio::null())
        .stdout(Stdio::null())
        .stderr(Stdio::null())
        .status()
        .unwrap();
    CrashRun {
        status,
        crash_marker: fs::read_to_string(crash_marker_path).ok(),
    }
}

#[cfg(debug_assertions)]
#[test]
fn crash_worker() {
    let Ok(worker) = std::env::var(CRASH_WORKER_ENV) else {
        return;
    };
    let path = PathBuf::from(std::env::var_os(CRASH_DATABASE_ENV).unwrap());
    match worker.as_str() {
        "retry-switch" => {
            let mut connection = Connection::open(path).unwrap();
            catch_up_retry_projection(&mut connection, 2, 256).unwrap();
        }
        "search-switch" => {
            let mut connection = Connection::open(path).unwrap();
            catch_up_search_projection(&mut connection, 256).unwrap();
        }
        "purge" => {
            let mut storage = EngineStorage::open(&path).unwrap();
            storage.run_purge_maintenance(256).unwrap();
        }
        _ => panic!("unknown crash worker"),
    }
}

#[cfg(debug_assertions)]
#[test]
fn fact_commit_interruption_rolls_back_and_exact_delta_replay_matches_clean_snapshot() {
    let clean = TemporaryDatabase::new("fact-clean");
    let clean_run = run_engine(&clean.path, None);
    assert!(clean_run.status.success(), "{}", clean_run.stderr);
    assert_eq!(
        session_committed(&clean_run)
            .unwrap_or_else(|| panic!("missing commit response: {:?}", clean_run.responses))["idempotent"],
        false
    );
    let expected = logical_snapshot(&clean.path);

    let recovered = TemporaryDatabase::new("fact-precommit");
    let failpoint = "before-session-fact-transaction-commit";
    let crashed = run_engine(&recovered.path, Some(failpoint));
    assert_aborted(
        &crashed.status,
        crashed.crash_marker.as_deref(),
        failpoint,
        "pre-commit Engine",
    );
    assert!(session_committed(&crashed).is_none());
    assert_eq!(source_publish_counts(&recovered.path), (0, 1, 0));
    let interrupted = logical_snapshot(&recovered.path);
    assert_eq!(interrupted.committed_session_count, 0);
    assert_eq!(interrupted.status["snapshotSeq"], "0");

    let replay = run_engine(&recovered.path, None);
    assert!(replay.status.success(), "{}", replay.stderr);
    assert_eq!(session_committed(&replay).unwrap()["idempotent"], false);
    assert_eq!(logical_snapshot(&recovered.path), expected);
}

#[cfg(debug_assertions)]
#[test]
fn lost_ack_replays_the_same_delta_idempotently_without_changing_the_snapshot() {
    let clean = TemporaryDatabase::new("ack-clean");
    let clean_run = run_engine(&clean.path, None);
    assert!(clean_run.status.success(), "{}", clean_run.stderr);
    let clean_commit = session_committed(&clean_run).unwrap();
    let expected = logical_snapshot(&clean.path);

    let recovered = TemporaryDatabase::new("ack-lost");
    let failpoint = "after-session-fact-commit-before-ack";
    let crashed = run_engine(&recovered.path, Some(failpoint));
    assert_aborted(
        &crashed.status,
        crashed.crash_marker.as_deref(),
        failpoint,
        "post-commit Engine",
    );
    assert!(session_committed(&crashed).is_none());
    assert_eq!(source_publish_counts(&recovered.path), (1, 0, 1));
    assert_eq!(logical_snapshot(&recovered.path), expected);

    let replay = run_engine(&recovered.path, None);
    assert!(replay.status.success(), "{}", replay.stderr);
    let replay_commit = session_committed(&replay).unwrap();
    assert_eq!(replay_commit["idempotent"], true);
    assert_eq!(replay_commit["snapshotSeq"], clean_commit["snapshotSeq"]);
    assert_eq!(logical_snapshot(&recovered.path), expected);
}

#[cfg(debug_assertions)]
#[test]
fn retry_projection_shadow_switch_rolls_back_atomically_and_recovers_to_clean_snapshot() {
    let clean = TemporaryDatabase::new("retry-clean");
    prepare_retry_switch(&clean.path, true);
    let expected = logical_snapshot(&clean.path);

    let recovered = TemporaryDatabase::new("retry-switch");
    prepare_retry_switch(&recovered.path, false);
    let failpoint = "before-retry-projection-switch-commit";
    let crashed = spawn_crash_worker(&recovered.path, "retry-switch", failpoint);
    assert_aborted(
        &crashed.status,
        crashed.crash_marker.as_deref(),
        failpoint,
        "retry projection switch worker",
    );

    let mut connection = Connection::open(&recovered.path).unwrap();
    let states = {
        let mut statement = connection
            .prepare(
                "SELECT version,status FROM projection_state
                 WHERE name=?1 ORDER BY version",
            )
            .unwrap();
        statement
            .query_map(params![RETRY_PROJECTION_NAME], |row| {
                Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(
        states,
        vec![(1, "active".to_owned()), (2, "building".to_owned())]
    );
    activate_retry_projection(&mut connection, 2);
    drop(connection);

    assert_eq!(logical_snapshot(&recovered.path), expected);
}

#[cfg(debug_assertions)]
#[test]
fn search_projection_shadow_switch_rolls_back_atomically_and_recovers_to_clean_snapshot() {
    let clean = TemporaryDatabase::new("search-clean");
    prepare_search_switch(&clean.path, true);
    let expected = logical_snapshot(&clean.path);

    let recovered = TemporaryDatabase::new("search-switch");
    prepare_search_switch(&recovered.path, false);
    let failpoint = "before-search-projection-switch-commit";
    let crashed = spawn_crash_worker(&recovered.path, "search-switch", failpoint);
    assert_aborted(
        &crashed.status,
        crashed.crash_marker.as_deref(),
        failpoint,
        "search projection switch worker",
    );

    let mut connection = Connection::open(&recovered.path).unwrap();
    assert_eq!(
        active_search_projection_version(&connection).unwrap(),
        Some(1)
    );
    let states = {
        let mut statement = connection
            .prepare(
                "SELECT version,status FROM projection_state
                 WHERE name='turn-search' ORDER BY version",
            )
            .unwrap();
        statement
            .query_map([], |row| {
                Ok((row.get::<_, u32>(0)?, row.get::<_, String>(1)?))
            })
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
    };
    assert_eq!(
        states,
        vec![(1, "active".to_owned()), (2, "building".to_owned())]
    );
    assert_eq!(
        catch_up_search_projection(&mut connection, 256)
            .unwrap()
            .status,
        "active"
    );
    drop(connection);

    assert_eq!(logical_snapshot(&recovered.path), expected);
}

#[cfg(debug_assertions)]
#[test]
fn purge_delete_checkpoint_and_vacuum_boundaries_recover_to_clean_snapshot() {
    let clean = TemporaryDatabase::new("purge-clean");
    prepare_pending_purge(&clean.path);
    finish_purge(&clean.path);
    let expected = logical_snapshot(&clean.path);

    for failpoint in [
        "before-purge-delete-commit",
        "after-purge-delete-commit",
        "after-purge-fts-optimize",
        "after-purge-checkpoint-before-vacuum",
        "after-purge-vacuum",
        "before-purge-finalize-commit",
        "after-purge-finalize-commit",
    ] {
        let recovered = TemporaryDatabase::new(failpoint);
        prepare_pending_purge(&recovered.path);
        let crashed = spawn_crash_worker(&recovered.path, "purge", failpoint);
        assert_aborted(
            &crashed.status,
            crashed.crash_marker.as_deref(),
            failpoint,
            failpoint,
        );
        let expected_intermediate = match failpoint {
            "before-purge-delete-commit" => (1, "pending-facts".to_owned()),
            "after-purge-finalize-commit" => (0, "purged".to_owned()),
            _ => (0, "pending-maintenance".to_owned()),
        };
        assert_eq!(
            purge_intermediate_state(&recovered.path),
            expected_intermediate,
            "unexpected durable intermediate state at {failpoint}"
        );
        finish_purge(&recovered.path);
        assert_eq!(
            logical_snapshot(&recovered.path),
            expected,
            "logical recovery mismatch at {failpoint}"
        );
    }
}

#[test]
fn packed_fact_swap_is_not_applicable_to_the_normalized_row_profile() {
    assert_eq!(FACT_STORAGE_PROFILE, "normalized-row-v1");
}
