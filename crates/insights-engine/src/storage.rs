use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params, params_from_iter};
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::Path;

pub const BUNDLED_SQLITE_VERSION: &str = "3.53.2";
const FTS5_SEEK_PARAMETER_TIERS: [usize; 4] = [8, 32, 128, 256];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageError {
    pub code: &'static str,
    pub message: String,
}

impl StorageError {
    fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

impl fmt::Display for StorageError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for StorageError {}

impl From<rusqlite::Error> for StorageError {
    fn from(error: rusqlite::Error) -> Self {
        Self::new("TS_INSIGHTS_STORAGE_FAILED", error.to_string())
    }
}

impl From<std::io::Error> for StorageError {
    fn from(error: std::io::Error) -> Self {
        Self::new("TS_INSIGHTS_STORAGE_FAILED", error.to_string())
    }
}

#[cfg(unix)]
mod persistent_file_permissions {
    use super::StorageError;
    use std::fs::{self, OpenOptions, Permissions};
    use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
    use std::path::{Path, PathBuf};

    fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
        let mut value = path.as_os_str().to_owned();
        value.push(suffix);
        PathBuf::from(value)
    }

    pub(super) fn prepare(path: &Path) -> Result<(), StorageError> {
        let file = OpenOptions::new()
            .read(true)
            .write(true)
            .create(true)
            .truncate(false)
            .mode(0o600)
            .open(path)?;
        file.set_permissions(Permissions::from_mode(0o600))?;
        Ok(())
    }

    pub(super) fn enforce(path: &Path) -> Result<(), StorageError> {
        for candidate in [
            path.to_path_buf(),
            sidecar_path(path, "-wal"),
            sidecar_path(path, "-shm"),
        ] {
            let mut permissions = match fs::metadata(&candidate) {
                Ok(metadata) => metadata.permissions(),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => continue,
                Err(error) => return Err(error.into()),
            };
            permissions.set_mode(0o600);
            fs::set_permissions(candidate, permissions)?;
        }
        Ok(())
    }
}

#[cfg(not(unix))]
mod persistent_file_permissions {
    use super::StorageError;
    use std::path::Path;

    // Windows has no POSIX mode bits. The launcher or installer must protect the database
    // directory with an owner-only ACL; this interface deliberately makes no 0600 claim.
    pub(super) fn prepare(_path: &Path) -> Result<(), StorageError> {
        Ok(())
    }

    pub(super) fn enforce(_path: &Path) -> Result<(), StorageError> {
        Ok(())
    }
}

#[derive(Debug, Clone)]
pub struct CommitRequest {
    pub session_key: String,
    pub delta_id: String,
    pub expected_generation: String,
    pub target_generation: String,
    pub canonical_delta: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommitOutcome {
    pub snapshot_seq: String,
    pub session_key: String,
    pub delta_id: String,
    pub idempotent: bool,
}

pub struct EngineStorage {
    connection: Connection,
}

fn valid_decimal(value: &str) -> bool {
    !value.is_empty()
        && (value == "0" || !value.starts_with('0'))
        && value.bytes().all(|byte| byte.is_ascii_digit())
        && value.parse::<u64>().is_ok()
}

fn increment_decimal(value: &str) -> Option<String> {
    if !valid_decimal(value) {
        return None;
    }
    value
        .parse::<u64>()
        .ok()?
        .checked_add(1)
        .map(|value| value.to_string())
}

fn valid_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn fts5_virtual_table_index(detail: &str) -> Option<u16> {
    let value = detail.split_once("VIRTUAL TABLE INDEX ")?.1;
    let digits = value
        .bytes()
        .take_while(u8::is_ascii_digit)
        .collect::<Vec<_>>();
    std::str::from_utf8(&digits).ok()?.parse().ok()
}

impl EngineStorage {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        persistent_file_permissions::prepare(path)?;
        let connection = Connection::open(path)?;
        let storage = Self::configure(connection, true)?;
        persistent_file_permissions::enforce(path)?;
        Ok(storage)
    }

    pub fn open_in_memory() -> Result<Self, StorageError> {
        let connection = Connection::open_in_memory()?;
        Self::configure(connection, false)
    }

    fn configure(connection: Connection, persistent: bool) -> Result<Self, StorageError> {
        connection.busy_timeout(std::time::Duration::from_secs(5))?;
        connection.execute_batch(
            "PRAGMA foreign_keys=ON;
             PRAGMA secure_delete=ON;
             PRAGMA synchronous=NORMAL;
             PRAGMA temp_store=FILE;",
        )?;
        let secure_delete: i64 =
            connection.query_row("PRAGMA secure_delete", [], |row| row.get(0))?;
        if secure_delete != 1 {
            return Err(StorageError::new(
                "TS_INSIGHTS_STORAGE_FAILED",
                "SQLite did not enable secure_delete",
            ));
        }
        if persistent {
            let journal_mode: String =
                connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
            if !journal_mode.eq_ignore_ascii_case("wal") {
                return Err(StorageError::new(
                    "TS_INSIGHTS_STORAGE_FAILED",
                    "SQLite did not enable WAL mode",
                ));
            }
        }
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS engine_metadata (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             ) WITHOUT ROWID;
             INSERT OR IGNORE INTO engine_metadata(key, value) VALUES ('snapshot_seq', '0');
             CREATE TABLE IF NOT EXISTS session_commits (
               session_key BLOB PRIMARY KEY,
               generation TEXT NOT NULL,
               delta_id BLOB NOT NULL,
               canonical_delta TEXT NOT NULL,
               snapshot_seq INTEGER NOT NULL
             ) WITHOUT ROWID;",
        )?;
        Ok(Self { connection })
    }

    pub fn sqlite_version(&self) -> String {
        rusqlite::version().to_owned()
    }

    pub fn compile_options(&self) -> Result<Vec<String>, StorageError> {
        let mut statement = self.connection.prepare("PRAGMA compile_options")?;
        let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
        let mut options = rows.collect::<Result<Vec<_>, _>>()?;
        options.sort();
        Ok(options)
    }

    pub fn compile_options_digest(&self) -> Result<String, StorageError> {
        let options = self.compile_options()?;
        Ok(hex::encode(Sha256::digest(options.join("\n").as_bytes())))
    }

    pub fn verify_sqlite_contract(&self) -> Result<(), StorageError> {
        let actual = self.sqlite_version();
        if actual != BUNDLED_SQLITE_VERSION {
            return Err(StorageError::new(
                "TS_INSIGHTS_STORAGE_FAILED",
                format!(
                    "bundled SQLite version mismatch: expected {BUNDLED_SQLITE_VERSION}, got {actual}"
                ),
            ));
        }
        if !self
            .compile_options()?
            .iter()
            .any(|option| option == "ENABLE_FTS5")
        {
            return Err(StorageError::new(
                "TS_INSIGHTS_STORAGE_FAILED",
                "bundled SQLite does not enable FTS5",
            ));
        }
        self.connection.execute_batch(
            "DROP TABLE IF EXISTS temp.threadshare_fts_smoke;
             DROP TABLE IF EXISTS temp.threadshare_fts_vocab;
             CREATE VIRTUAL TABLE temp.threadshare_fts_smoke USING fts5(
               problem,
               answer,
               capability,
               content='',
               contentless_delete=1,
               columnsize=1,
               detail=full
             );
             INSERT INTO threadshare_fts_smoke(rowid, problem, answer, capability) VALUES
               (1, 'alpha alpha alpha', 'none', 'none'),
               (2, 'none', 'alpha alpha alpha', 'none'),
               (3, 'none', 'none', 'alpha alpha alpha');
             CREATE VIRTUAL TABLE temp.threadshare_fts_vocab USING
               fts5vocab(threadshare_fts_smoke, 'col');",
        )?;

        let ranked = |weights: (f64, f64, f64)| -> Result<Vec<(i64, f64)>, StorageError> {
            let mut statement = self.connection.prepare(
                "SELECT rowid, bm25(threadshare_fts_smoke, ?1, ?2, ?3)
                 FROM threadshare_fts_smoke
                 WHERE threadshare_fts_smoke MATCH 'alpha'
                 ORDER BY 2 ASC, rowid ASC",
            )?;
            let rows = statement.query_map(params![weights.0, weights.1, weights.2], |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, f64>(1)?))
            })?;
            Ok(rows.collect::<Result<Vec<_>, _>>()?)
        };
        let problem_weighted = ranked((8.0, 4.0, 2.0))?;
        let capability_weighted = ranked((2.0, 4.0, 8.0))?;
        let scores_are_usable = problem_weighted.len() == 3
            && problem_weighted
                .iter()
                .all(|(_, score)| score.is_finite() && *score != 0.0)
            && problem_weighted
                .windows(2)
                .any(|pair| pair[0].1 != pair[1].1)
            && problem_weighted.first().map(|item| item.0) == Some(1)
            && capability_weighted.first().map(|item| item.0) == Some(3);
        if !scores_are_usable {
            return Err(StorageError::new(
                "TS_INSIGHTS_STORAGE_FAILED",
                "bundled SQLite FTS5 BM25 behavior is incompatible",
            ));
        }

        for parameter_count in FTS5_SEEK_PARAMETER_TIERS {
            let placeholders = std::iter::repeat_n("?", parameter_count)
                .collect::<Vec<_>>()
                .join(",");
            let sql = format!(
                "EXPLAIN QUERY PLAN
                 SELECT doc FROM threadshare_fts_vocab
                 WHERE term IN ({placeholders}) AND col=?"
            );
            let mut parameters = vec!["alpha"; parameter_count];
            parameters.push("problem");
            let mut plan = self.connection.prepare(&sql)?;
            let details = plan
                .query_map(params_from_iter(parameters), |row| row.get::<_, String>(3))?
                .collect::<Result<Vec<_>, _>>()?;
            if !details
                .iter()
                .any(|detail| fts5_virtual_table_index(detail) == Some(263))
            {
                return Err(StorageError::new(
                    "TS_INSIGHTS_STORAGE_FAILED",
                    format!(
                        "bundled SQLite fts5vocab {parameter_count}-parameter lookup does not use the required seek plan"
                    ),
                ));
            }
        }

        self.connection.execute_batch(
            "DROP TABLE IF EXISTS temp.threadshare_fts_terms;
             CREATE TEMP TABLE threadshare_fts_terms (
               term TEXT PRIMARY KEY
             ) WITHOUT ROWID;
             INSERT INTO threadshare_fts_terms(term) VALUES ('alpha'), ('none');",
        )?;
        let mut plan = self.connection.prepare(
            "EXPLAIN QUERY PLAN
             SELECT vocab.doc
             FROM threadshare_fts_vocab AS vocab
             JOIN threadshare_fts_terms AS terms ON terms.term=vocab.term
             WHERE vocab.col=?1",
        )?;
        let details = plan
            .query_map(params!["problem"], |row| row.get::<_, String>(3))?
            .collect::<Result<Vec<_>, _>>()?;
        let indexes = details
            .iter()
            .filter_map(|detail| fts5_virtual_table_index(detail))
            .collect::<Vec<_>>();
        if indexes.contains(&263) || !indexes.iter().any(|index| matches!(index, 3 | 7)) {
            return Err(StorageError::new(
                "TS_INSIGHTS_STORAGE_FAILED",
                "bundled SQLite fts5vocab temp-table join did not use the expected full-scan plan",
            ));
        }

        self.connection.execute_batch(
            "DELETE FROM threadshare_fts_smoke WHERE rowid=1;
             INSERT INTO threadshare_fts_smoke(threadshare_fts_smoke) VALUES('integrity-check');
             DROP TABLE threadshare_fts_terms;
             DROP TABLE threadshare_fts_vocab;
             DROP TABLE threadshare_fts_smoke;",
        )?;
        Ok(())
    }

    pub fn commit_session(
        &mut self,
        request: CommitRequest,
    ) -> Result<CommitOutcome, StorageError> {
        if !valid_hex64(&request.session_key) || !valid_hex64(&request.delta_id) {
            return Err(StorageError::new(
                "TS_INSIGHTS_INVALID_STABLE_KEY",
                "sessionKey and deltaId must be lowercase 32-byte hex",
            ));
        }
        if increment_decimal(&request.expected_generation).as_deref()
            != Some(request.target_generation.as_str())
        {
            return Err(StorageError::new(
                "TS_INSIGHTS_INVALID_GENERATION",
                "targetGeneration must immediately follow expectedGeneration",
            ));
        }

        let session_key = hex::decode(&request.session_key).map_err(|_| {
            StorageError::new("TS_INSIGHTS_INVALID_STABLE_KEY", "invalid sessionKey")
        })?;
        let delta_id = hex::decode(&request.delta_id)
            .map_err(|_| StorageError::new("TS_INSIGHTS_INVALID_DELTA_ID", "invalid deltaId"))?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let current = transaction
            .query_row(
                "SELECT generation, delta_id, canonical_delta, snapshot_seq
                 FROM session_commits WHERE session_key=?1",
                params![&session_key],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, i64>(3)?,
                    ))
                },
            )
            .optional()?;

        if let Some((_, committed_delta_id, canonical_delta, snapshot_seq)) = &current
            && committed_delta_id == &delta_id
        {
            if canonical_delta != &request.canonical_delta {
                return Err(StorageError::new(
                    "TS_INSIGHTS_DELTA_ID_CONFLICT",
                    "the committed deltaId belongs to different canonical bytes",
                ));
            }
            return Ok(CommitOutcome {
                snapshot_seq: snapshot_seq.to_string(),
                session_key: request.session_key,
                delta_id: request.delta_id,
                idempotent: true,
            });
        }

        let actual_generation = current.as_ref().map(|item| item.0.as_str()).unwrap_or("0");
        if actual_generation != request.expected_generation {
            return Err(StorageError::new(
                "TS_INSIGHTS_GENERATION_CONFLICT",
                format!(
                    "expected generation {}, committed generation is {actual_generation}",
                    request.expected_generation
                ),
            ));
        }

        let snapshot_seq: i64 = transaction.query_row(
            "UPDATE engine_metadata
             SET value=CAST(value AS INTEGER)+1
             WHERE key='snapshot_seq'
             RETURNING CAST(value AS INTEGER)",
            [],
            |row| row.get(0),
        )?;
        transaction.execute(
            "INSERT INTO session_commits(
               session_key, generation, delta_id, canonical_delta, snapshot_seq
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_key) DO UPDATE SET
               generation=excluded.generation,
               delta_id=excluded.delta_id,
               canonical_delta=excluded.canonical_delta,
               snapshot_seq=excluded.snapshot_seq",
            params![
                &session_key,
                &request.target_generation,
                &delta_id,
                &request.canonical_delta,
                snapshot_seq
            ],
        )?;
        transaction.commit()?;
        Ok(CommitOutcome {
            snapshot_seq: snapshot_seq.to_string(),
            session_key: request.session_key,
            delta_id: request.delta_id,
            idempotent: false,
        })
    }

    pub fn committed_session_count(&self) -> Result<u64, StorageError> {
        let count: i64 =
            self.connection
                .query_row("SELECT COUNT(*) FROM session_commits", [], |row| row.get(0))?;
        u64::try_from(count).map_err(|_| {
            StorageError::new(
                "TS_INSIGHTS_STORAGE_FAILED",
                "session commit count is outside uint64",
            )
        })
    }
}

#[cfg(test)]
mod tests {
    use super::{CommitRequest, EngineStorage};

    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::path::{Path, PathBuf};
    #[cfg(unix)]
    use std::sync::atomic::{AtomicU64, Ordering};

    fn request(delta_id: char, expected: &str, target: &str, body: &str) -> CommitRequest {
        CommitRequest {
            session_key: "a".repeat(64),
            delta_id: delta_id.to_string().repeat(64),
            expected_generation: expected.to_owned(),
            target_generation: target.to_owned(),
            canonical_delta: body.to_owned(),
        }
    }

    #[cfg(unix)]
    struct TemporaryDatabase {
        directory: PathBuf,
        path: PathBuf,
    }

    #[cfg(unix)]
    impl TemporaryDatabase {
        fn new() -> Self {
            static NEXT_PATH: AtomicU64 = AtomicU64::new(0);
            let directory = std::env::temp_dir().join(format!(
                "threadshare-insights-storage-{}-{}",
                std::process::id(),
                NEXT_PATH.fetch_add(1, Ordering::Relaxed)
            ));
            fs::create_dir(&directory).unwrap();
            let path = directory.join("engine.sqlite3");
            Self { directory, path }
        }
    }

    #[cfg(unix)]
    impl Drop for TemporaryDatabase {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    #[cfg(unix)]
    fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
        let mut value = path.as_os_str().to_owned();
        value.push(suffix);
        PathBuf::from(value)
    }

    #[cfg(unix)]
    fn assert_private_mode(path: &Path) {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    #[test]
    fn verifies_bundled_sqlite_and_fts5() {
        let storage = EngineStorage::open_in_memory().unwrap();
        storage.verify_sqlite_contract().unwrap();
    }

    #[test]
    fn enables_secure_delete() {
        let storage = EngineStorage::open_in_memory().unwrap();
        let enabled: i64 = storage
            .connection
            .query_row("PRAGMA secure_delete", [], |row| row.get(0))
            .unwrap();
        assert_eq!(enabled, 1);
    }

    #[cfg(unix)]
    #[test]
    fn persistent_database_and_sidecars_are_owner_only() {
        let database = TemporaryDatabase::new();
        let path = &database.path;
        let seed = rusqlite::Connection::open(path).unwrap();
        seed.execute("CREATE TABLE preservation_marker(value TEXT NOT NULL)", [])
            .unwrap();
        seed.execute(
            "INSERT INTO preservation_marker(value) VALUES ('preserved')",
            [],
        )
        .unwrap();
        drop(seed);
        fs::set_permissions(path, fs::Permissions::from_mode(0o666)).unwrap();

        let storage = EngineStorage::open(path).unwrap();
        let marker: String = storage
            .connection
            .query_row("SELECT value FROM preservation_marker", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(marker, "preserved");
        assert_private_mode(path);
        assert_private_mode(&sidecar_path(path, "-wal"));
        assert_private_mode(&sidecar_path(path, "-shm"));
        drop(storage);
    }

    #[test]
    fn commits_atomically_and_replays_idempotently() {
        let mut storage = EngineStorage::open_in_memory().unwrap();
        let first = storage
            .commit_session(request('b', "0", "1", "{\"a\":1}"))
            .unwrap();
        assert_eq!(first.snapshot_seq, "1");
        assert!(!first.idempotent);
        let replay = storage
            .commit_session(request('b', "0", "1", "{\"a\":1}"))
            .unwrap();
        assert_eq!(replay.snapshot_seq, "1");
        assert!(replay.idempotent);
        let second = storage
            .commit_session(request('c', "1", "2", "{\"a\":2}"))
            .unwrap();
        assert_eq!(second.snapshot_seq, "2");
    }

    #[test]
    fn rejects_generation_and_delta_id_conflicts() {
        let mut storage = EngineStorage::open_in_memory().unwrap();
        storage
            .commit_session(request('b', "0", "1", "{\"a\":1}"))
            .unwrap();
        let generation = storage
            .commit_session(request('c', "0", "1", "{\"a\":2}"))
            .unwrap_err();
        assert_eq!(generation.code, "TS_INSIGHTS_GENERATION_CONFLICT");
        let collision = storage
            .commit_session(request('b', "0", "1", "{\"a\":2}"))
            .unwrap_err();
        assert_eq!(collision.code, "TS_INSIGHTS_DELTA_ID_CONFLICT");
    }

    #[test]
    fn rejects_generations_outside_uint64() {
        let mut storage = EngineStorage::open_in_memory().unwrap();
        let error = storage
            .commit_session(request(
                'b',
                "18446744073709551616",
                "18446744073709551617",
                "{}",
            ))
            .unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_INVALID_GENERATION");
    }
}
