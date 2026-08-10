use rusqlite::Connection;
use serde_json::Value;
use std::ffi::OsString;
use std::fs;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use threadshare_insights_engine::fact_model::{SessionFactsDeltaV1, StableKey};
use threadshare_insights_engine::source_state::PurgeState;
use threadshare_insights_engine::storage::EngineStorage;

const PURGE_CANARY: &str = "threadsharepurgecanary9f0d4e8c7a6b5c3d";
static NEXT_PATH: AtomicU64 = AtomicU64::new(0);

struct TemporaryDatabase {
    directory: PathBuf,
    path: PathBuf,
}

impl TemporaryDatabase {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "threadshare-purge-privacy-{}-{}",
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
    let mut delta = SessionFactsDeltaV1::try_from(fixture["initial"].clone()).unwrap();
    delta.turns[0].problem_text = PURGE_CANARY.to_owned();
    delta.delta_id = StableKey::from_bytes([0xf5; 32]);
    delta
}

fn sqlite_sidecar_path(database: &Path, suffix: &str) -> PathBuf {
    let mut path = OsString::from(database.as_os_str());
    path.push(suffix);
    PathBuf::from(path)
}

fn file_contains_canary(path: &Path) -> bool {
    match fs::read(path) {
        Ok(bytes) => bytes
            .windows(PURGE_CANARY.len())
            .any(|window| window == PURGE_CANARY.as_bytes()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => false,
        Err(error) => panic!("failed to inspect purge canary storage: {error}"),
    }
}

fn fts_canary_counts(database: &Path) -> (i64, i64) {
    let connection = Connection::open(database).unwrap();
    let matching = connection
        .query_row(
            "SELECT COUNT(*) FROM turns_fts WHERE turns_fts MATCH ?1",
            [PURGE_CANARY],
            |row| row.get(0),
        )
        .unwrap();
    let vocabulary = connection
        .query_row(
            "SELECT COALESCE(SUM(doc),0) FROM turns_fts_vocab
             WHERE term=?1 AND col='natural'",
            [PURGE_CANARY],
            |row| row.get(0),
        )
        .unwrap();
    (matching, vocabulary)
}

#[test]
fn purge_clears_sensitive_fts_state_before_reporting_purged() {
    let database = TemporaryDatabase::new();
    let delta = fixture_delta();
    let session_key = delta.session.session_key;
    let mut storage = EngineStorage::open(&database.path).unwrap();
    storage.apply_session_facts(delta).unwrap();
    assert_eq!(fts_canary_counts(&database.path), (1, 1));

    let mut reader = Connection::open(&database.path).unwrap();
    reader.execute_batch("PRAGMA journal_mode=WAL").unwrap();
    let reader_snapshot = reader.transaction().unwrap();
    let visible_before_exclusion: i64 = reader_snapshot
        .query_row(
            "SELECT COUNT(*) FROM turns_fts WHERE turns_fts MATCH ?1",
            [PURGE_CANARY],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(visible_before_exclusion, 1);

    let exclusion = storage.exclude_source(session_key).unwrap();
    assert_eq!(exclusion.purge_state, PurgeState::PendingPurge);
    let blocked = storage.run_purge_maintenance(1).unwrap();
    assert_eq!(blocked.purged_sessions, "0");
    assert_eq!(blocked.status.state, PurgeState::PendingPurge);
    assert_eq!(
        storage.read_purge_status(Some(session_key)).unwrap().state,
        PurgeState::PendingPurge
    );
    assert_eq!(fts_canary_counts(&database.path), (0, 0));
    let wal_path = sqlite_sidecar_path(&database.path, "-wal");
    assert!(
        file_contains_canary(&database.path) || file_contains_canary(&wal_path),
        "pending purge must not pretend the unique canary was physically cleared"
    );

    drop(reader_snapshot);
    drop(reader);

    let completed = storage.run_purge_maintenance(1).unwrap();
    assert_eq!(completed.purged_sessions, "1");
    assert_eq!(completed.status.state, PurgeState::Purged);
    assert_eq!(
        storage.read_purge_status(Some(session_key)).unwrap().state,
        PurgeState::Purged
    );
    assert_eq!(fts_canary_counts(&database.path), (0, 0));
    assert!(
        !file_contains_canary(&database.path),
        "VACUUM must remove the unique plaintext canary from the active database"
    );

    let wal_bytes = fs::metadata(&wal_path)
        .map(|metadata| metadata.len())
        .unwrap_or(0);
    assert_eq!(wal_bytes, 0, "successful purge must leave the WAL empty");
}
