use rusqlite::{
    Connection, OpenFlags, OptionalExtension, TransactionBehavior, params, params_from_iter,
};
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::{Path, PathBuf};

pub const BUNDLED_SQLITE_VERSION: &str = "3.53.2";
const FTS5_SEEK_PARAMETER_TIERS: [usize; 4] = [8, 32, 128, 256];
pub(crate) const WAL_PASSIVE_CHECKPOINT_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const WAL_BACKPRESSURE_BYTES: u64 = 128 * 1024 * 1024;

#[cfg(debug_assertions)]
const TEST_CRASH_FAILPOINT_ENV: &str = "THREADSHARE_INSIGHTS_TEST_CRASH_AT";
#[cfg(debug_assertions)]
const TEST_CRASH_MARKER_ENV: &str = "THREADSHARE_INSIGHTS_TEST_CRASH_MARKER";

#[cfg(debug_assertions)]
fn test_crash_failpoint_enabled(name: &str) -> bool {
    std::env::var(TEST_CRASH_FAILPOINT_ENV).as_deref() == Ok(name)
}

#[cfg(debug_assertions)]
pub(crate) fn test_crash_failpoint(name: &str) {
    if test_crash_failpoint_enabled(name) {
        if let Some(path) = std::env::var_os(TEST_CRASH_MARKER_ENV)
            && let Ok(mut marker) = std::fs::OpenOptions::new()
                .write(true)
                .create_new(true)
                .open(path)
        {
            let _ = std::io::Write::write_all(&mut marker, name.as_bytes());
        }
        std::process::abort();
    }
}

#[cfg(debug_assertions)]
fn arm_session_fact_commit_failpoint(connection: &Connection) -> Result<bool, StorageError> {
    if !test_crash_failpoint_enabled("before-session-fact-transaction-commit") {
        return Ok(false);
    }
    connection.commit_hook(Some(|| {
        test_crash_failpoint("before-session-fact-transaction-commit");
        false
    }))?;
    Ok(true)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub(crate) enum WalPressureAction {
    None,
    PassiveCheckpoint,
    Backpressure,
}

impl WalPressureAction {
    pub(crate) const fn as_str(self) -> &'static str {
        match self {
            Self::None => "none",
            Self::PassiveCheckpoint => "passive-checkpoint",
            Self::Backpressure => "backpressure",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StorageError {
    pub code: &'static str,
    pub message: String,
}

impl StorageError {
    pub(crate) fn new(code: &'static str, message: impl Into<String>) -> Self {
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
        if matches!(
            &error,
            rusqlite::Error::SqliteFailure(failure, _)
                if matches!(
                    failure.code,
                    rusqlite::ffi::ErrorCode::DatabaseCorrupt
                        | rusqlite::ffi::ErrorCode::NotADatabase
                )
        ) {
            return Self::new(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "the Insights database is corrupt or is not a SQLite database",
            );
        }
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
    staged_source_state: Option<crate::source_state::SourceState>,
    database_path: Option<PathBuf>,
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

fn valid_database_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

fn new_database_uuid(connection: &Connection) -> Result<String, StorageError> {
    let mut bytes: Vec<u8> = connection.query_row("SELECT randomblob(16)", [], |row| row.get(0))?;
    if bytes.len() != 16 {
        return Err(StorageError::new(
            "TS_INSIGHTS_STORAGE_FAILED",
            "SQLite did not generate a database UUID",
        ));
    }
    bytes[6] = (bytes[6] & 0x0f) | 0x40;
    bytes[8] = (bytes[8] & 0x3f) | 0x80;
    let value = hex::encode(bytes);
    Ok(format!(
        "{}-{}-{}-{}-{}",
        &value[0..8],
        &value[8..12],
        &value[12..16],
        &value[16..20],
        &value[20..32]
    ))
}

fn ensure_database_uuid(connection: &Connection) -> Result<(), StorageError> {
    let candidate = new_database_uuid(connection)?;
    connection.execute(
        "INSERT OR IGNORE INTO engine_metadata(key, value) VALUES ('database_uuid', ?1)",
        [candidate],
    )?;
    let value: String = connection.query_row(
        "SELECT value FROM engine_metadata WHERE key='database_uuid'",
        [],
        |row| row.get(0),
    )?;
    if !valid_database_uuid(&value) {
        return Err(StorageError::new(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            "the Insights database UUID is invalid",
        ));
    }
    Ok(())
}

fn fts5_virtual_table_index(detail: &str) -> Option<u16> {
    let value = detail.split_once("VIRTUAL TABLE INDEX ")?.1;
    let digits = value
        .bytes()
        .take_while(u8::is_ascii_digit)
        .collect::<Vec<_>>();
    std::str::from_utf8(&digits).ok()?.parse().ok()
}

pub(crate) fn wal_pressure_action(
    wal_bytes: u64,
    passive_checkpoint_bytes: u64,
    backpressure_bytes: u64,
) -> WalPressureAction {
    if wal_bytes >= backpressure_bytes {
        WalPressureAction::Backpressure
    } else if wal_bytes >= passive_checkpoint_bytes {
        WalPressureAction::PassiveCheckpoint
    } else {
        WalPressureAction::None
    }
}

fn sqlite_sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

impl EngineStorage {
    pub fn open(path: &Path) -> Result<Self, StorageError> {
        persistent_file_permissions::prepare(path)?;
        let connection = Connection::open(path)?;
        let storage = Self::configure(connection, Some(path.to_path_buf()))?;
        persistent_file_permissions::enforce(path)?;
        Ok(storage)
    }

    pub fn open_existing(path: &Path) -> Result<Self, StorageError> {
        let connection = Connection::open_with_flags(
            path,
            OpenFlags::SQLITE_OPEN_READ_WRITE | OpenFlags::SQLITE_OPEN_NOFOLLOW,
        )
        .map_err(|_| {
            StorageError::new(
                "TS_INSIGHTS_STORAGE_FAILED",
                "the existing Insights database could not be opened",
            )
        })?;
        Self::configure(connection, Some(path.to_path_buf()))
    }

    pub fn open_in_memory() -> Result<Self, StorageError> {
        let connection = Connection::open_in_memory()?;
        Self::configure(connection, None)
    }

    fn configure(
        mut connection: Connection,
        database_path: Option<PathBuf>,
    ) -> Result<Self, StorageError> {
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
        if database_path.is_some() {
            let journal_mode: String =
                connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
            if !journal_mode.eq_ignore_ascii_case("wal") {
                return Err(StorageError::new(
                    "TS_INSIGHTS_STORAGE_FAILED",
                    "SQLite did not enable WAL mode",
                ));
            }
            connection.execute_batch("PRAGMA wal_autocheckpoint=0;")?;
        }
        connection.execute_batch(
            "CREATE TABLE IF NOT EXISTS engine_metadata (
               key TEXT PRIMARY KEY,
               value TEXT NOT NULL
             ) WITHOUT ROWID;
             INSERT OR IGNORE INTO engine_metadata(key, value) VALUES ('snapshot_seq', '0');
             CREATE TRIGGER IF NOT EXISTS engine_snapshot_timestamp
             AFTER UPDATE OF value ON engine_metadata
             WHEN NEW.key='snapshot_seq' AND NEW.value<>OLD.value
             BEGIN
               INSERT INTO engine_metadata(key,value)
               VALUES(
                 'snapshot_committed_at_ms',
                 CAST(unixepoch('subsec') * 1000 AS INTEGER)
               )
               ON CONFLICT(key) DO UPDATE SET value=excluded.value;
             END;",
        )?;
        ensure_database_uuid(&connection)?;
        crate::normalized_repository::initialize_schema(&mut connection)?;
        crate::source_state::initialize_schema(&connection)?;
        crate::fact_staging::initialize(&connection)?;
        Ok(Self {
            connection,
            staged_source_state: None,
            database_path,
        })
    }

    fn maintain_wal_after_commit(&self) -> Result<WalPressureAction, StorageError> {
        self.maintain_wal_after_commit_with_thresholds(
            WAL_PASSIVE_CHECKPOINT_BYTES,
            WAL_BACKPRESSURE_BYTES,
        )
    }

    fn maintain_wal_after_commit_with_thresholds(
        &self,
        passive_checkpoint_bytes: u64,
        backpressure_bytes: u64,
    ) -> Result<WalPressureAction, StorageError> {
        let Some(database_path) = &self.database_path else {
            return Ok(WalPressureAction::None);
        };
        let wal_path = sqlite_sidecar_path(database_path, "-wal");
        let wal_bytes = match std::fs::metadata(wal_path) {
            Ok(metadata) => metadata.len(),
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => 0,
            Err(error) => return Err(error.into()),
        };
        let action = wal_pressure_action(wal_bytes, passive_checkpoint_bytes, backpressure_bytes);
        let checkpoint_mode = match action {
            WalPressureAction::None => return Ok(action),
            WalPressureAction::PassiveCheckpoint => "PASSIVE",
            WalPressureAction::Backpressure => "TRUNCATE",
        };
        let sql = format!("PRAGMA wal_checkpoint({checkpoint_mode})");
        let (busy, _, _): (i64, i64, i64) = self
            .connection
            .query_row(&sql, [], |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)))?;
        if action == WalPressureAction::Backpressure && busy != 0 {
            return Err(StorageError::new(
                "TS_INSIGHTS_WAL_BACKPRESSURE",
                "the Insights writer is waiting for readers to release the WAL snapshot",
            ));
        }
        Ok(action)
    }

    pub fn sqlite_version(&self) -> String {
        rusqlite::version().to_owned()
    }

    pub fn database_uuid(&self) -> Result<String, StorageError> {
        let value: String = self.connection.query_row(
            "SELECT value FROM engine_metadata WHERE key='database_uuid'",
            [],
            |row| row.get(0),
        )?;
        if !valid_database_uuid(&value) {
            return Err(StorageError::new(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "the Insights database UUID is invalid",
            ));
        }
        Ok(value)
    }

    pub fn database_fact_schema_version(&self) -> Result<Option<u8>, StorageError> {
        crate::normalized_repository::read_database_fact_schema_version(&self.connection)
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
        let canonical_digest = Sha256::digest(request.canonical_delta.as_bytes()).to_vec();
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "INSERT OR IGNORE INTO sessions(
               session_key,provider,session_scope,eligibility,duplicate_policy_version
             ) VALUES (?1,'legacy','unknown','unknown',1)",
            params![&session_key],
        )?;
        let session_id: i64 = transaction.query_row(
            "SELECT session_id FROM sessions WHERE session_key=?1",
            params![&session_key],
            |row| row.get(0),
        )?;
        let current = transaction
            .query_row(
                "SELECT generation, delta_id, canonical_digest, snapshot_seq
                 FROM session_commits WHERE session_id=?1",
                [session_id],
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

        if let Some((_, committed_delta_id, committed_digest, snapshot_seq)) = &current
            && committed_delta_id == &delta_id
        {
            if committed_digest != &canonical_digest {
                return Err(StorageError::new(
                    "TS_INSIGHTS_DELTA_ID_CONFLICT",
                    "the committed deltaId belongs to different canonical bytes",
                ));
            }
            let outcome = CommitOutcome {
                snapshot_seq: snapshot_seq.to_string(),
                session_key: request.session_key,
                delta_id: request.delta_id,
                idempotent: true,
            };
            drop(transaction);
            self.maintain_wal_after_commit()?;
            return Ok(outcome);
        }

        let actual_generation = current
            .as_ref()
            .map(|item| {
                item.0
                    .as_slice()
                    .try_into()
                    .map(u64::from_be_bytes)
                    .map_err(|_| {
                        StorageError::new(
                            "TS_INSIGHTS_STORAGE_CORRUPT",
                            "stored generation is not an 8-byte BLOB",
                        )
                    })
            })
            .transpose()?
            .unwrap_or(0);
        if actual_generation.to_string() != request.expected_generation {
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
               session_id, generation, delta_id, canonical_digest, snapshot_seq
             ) VALUES (?1, ?2, ?3, ?4, ?5)
             ON CONFLICT(session_id) DO UPDATE SET
               generation=excluded.generation,
               delta_id=excluded.delta_id,
               canonical_digest=excluded.canonical_digest,
               snapshot_seq=excluded.snapshot_seq",
            params![
                session_id,
                request
                    .target_generation
                    .parse::<u64>()
                    .unwrap()
                    .to_be_bytes()
                    .to_vec(),
                &delta_id,
                &canonical_digest,
                snapshot_seq
            ],
        )?;
        transaction.commit()?;
        let outcome = CommitOutcome {
            snapshot_seq: snapshot_seq.to_string(),
            session_key: request.session_key,
            delta_id: request.delta_id,
            idempotent: false,
        };
        self.maintain_wal_after_commit()?;
        Ok(outcome)
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

    pub fn apply_session_facts(
        &mut self,
        delta: crate::fact_model::SessionFactsDeltaV1,
    ) -> Result<CommitOutcome, StorageError> {
        let source_state = self.staged_source_state.take();
        let staged_digest =
            crate::source_state::stage_for_delta(&self.connection, &delta, source_state.as_ref())?;
        #[cfg(debug_assertions)]
        let commit_failpoint_armed = arm_session_fact_commit_failpoint(&self.connection)?;
        let outcome =
            crate::normalized_repository::apply_session_facts(&mut self.connection, &delta);
        #[cfg(debug_assertions)]
        if commit_failpoint_armed {
            self.connection.commit_hook(None::<fn() -> bool>)?;
        }
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                crate::source_state::discard_staged(&self.connection, delta.session.session_key);
                return Err(error);
            }
        };
        crate::source_state::finish_staged_commit(
            &self.connection,
            delta.session.session_key,
            staged_digest,
            outcome.idempotent,
        )?;
        #[cfg(debug_assertions)]
        if !outcome.idempotent {
            test_crash_failpoint("after-session-fact-commit-before-ack");
        }
        self.maintain_wal_after_commit()?;
        Ok(outcome)
    }

    pub fn clear_session_fact_staging(&mut self) -> Result<(), StorageError> {
        crate::fact_staging::clear(&self.connection)
    }

    pub(crate) fn stage_session_fact_batch(
        &mut self,
        collection: &str,
        first_ordinal: usize,
        items: &[serde_json::Value],
        session_key: &str,
        provider: &str,
    ) -> Result<crate::fact_staging::StageBatchOutcome, StorageError> {
        crate::fact_staging::stage_batch(
            &mut self.connection,
            collection,
            first_ordinal,
            items,
            session_key,
            provider,
        )
    }

    #[cfg(test)]
    pub(crate) fn staged_session_fact_count(
        &self,
        collection: &str,
    ) -> Result<usize, StorageError> {
        crate::fact_staging::count(&self.connection, collection)
    }

    pub(crate) fn prepare_staged_session_facts(
        &self,
        wire_delta: serde_json::Value,
    ) -> Result<crate::fact_staging::StagedSessionFacts, StorageError> {
        crate::fact_staging::prepare(&self.connection, wire_delta)
    }

    pub(crate) fn apply_staged_session_facts(
        &mut self,
        staged: crate::fact_staging::StagedSessionFacts,
    ) -> Result<CommitOutcome, StorageError> {
        let delta = &staged.delta;
        let source_state = self.staged_source_state.take();
        let staged_digest =
            crate::source_state::stage_for_delta(&self.connection, delta, source_state.as_ref())?;
        #[cfg(debug_assertions)]
        let commit_failpoint_armed = arm_session_fact_commit_failpoint(&self.connection)?;
        let outcome =
            crate::normalized_repository::apply_staged_session_facts(&mut self.connection, &staged);
        #[cfg(debug_assertions)]
        if commit_failpoint_armed {
            self.connection.commit_hook(None::<fn() -> bool>)?;
        }
        let outcome = match outcome {
            Ok(outcome) => outcome,
            Err(error) => {
                crate::source_state::discard_staged(&self.connection, delta.session.session_key);
                let _ = crate::fact_staging::clear(&self.connection);
                return Err(error);
            }
        };
        let finish = crate::source_state::finish_staged_commit(
            &self.connection,
            delta.session.session_key,
            staged_digest,
            outcome.idempotent,
        );
        let clear = crate::fact_staging::clear(&self.connection);
        finish?;
        clear?;
        #[cfg(debug_assertions)]
        if !outcome.idempotent {
            test_crash_failpoint("after-session-fact-commit-before-ack");
        }
        self.maintain_wal_after_commit()?;
        Ok(outcome)
    }

    pub fn stage_source_state(&mut self, state: Option<crate::source_state::SourceState>) {
        self.staged_source_state = state;
    }

    pub fn clear_staged_source_state(&mut self) {
        self.staged_source_state = None;
    }

    pub fn list_source_states(
        &self,
        cursor: Option<crate::fact_model::StableKey>,
        limit: u16,
    ) -> Result<crate::source_state::SourceStatePage, StorageError> {
        crate::source_state::list_source_states(&self.connection, cursor, limit)
    }

    pub fn read_source_checkpoint(
        &self,
        session_key: crate::fact_model::StableKey,
    ) -> Result<Option<crate::fact_model::Checkpoint>, StorageError> {
        crate::source_state::read_source_checkpoint(&self.connection, session_key)
    }

    pub fn remove_source(
        &mut self,
        session_key: crate::fact_model::StableKey,
    ) -> Result<crate::source_state::SourceRemovalOutcome, StorageError> {
        let outcome = crate::source_state::remove_source(&mut self.connection, session_key)?;
        self.maintain_wal_after_commit()?;
        Ok(outcome)
    }

    pub fn exclude_source(
        &mut self,
        session_key: crate::fact_model::StableKey,
    ) -> Result<crate::source_state::SourceExclusionOutcome, StorageError> {
        let outcome = crate::source_state::exclude_source(&mut self.connection, session_key)?;
        self.maintain_wal_after_commit()?;
        Ok(outcome)
    }

    pub fn read_purge_status(
        &self,
        session_key: Option<crate::fact_model::StableKey>,
    ) -> Result<crate::source_state::PurgeStatus, StorageError> {
        crate::source_state::read_purge_status(&self.connection, session_key)
    }

    pub fn read_engine_status(&self) -> Result<crate::engine_status::EngineStatus, StorageError> {
        crate::engine_status::read_engine_status(&self.connection, self.database_path.as_deref())
    }

    pub fn read_insights_overview(
        &self,
        request: crate::insights_overview::InsightsOverviewRequest,
    ) -> Result<crate::insights_overview::InsightsOverview, StorageError> {
        crate::insights_overview::read_insights_overview(&self.connection, request)
    }

    pub fn list_capabilities(
        &self,
        request: crate::insights_overview::CapabilityPageRequest,
    ) -> Result<crate::insights_overview::CapabilityPage, StorageError> {
        crate::insights_overview::list_capabilities(&self.connection, request)
    }

    pub fn read_capability_usage(
        &self,
        request: &crate::agent_query::UsageRequest,
    ) -> Result<crate::agent_query::UsageResponse, crate::query::QueryError> {
        crate::agent_query::read_capability_usage(&self.connection, request)
    }

    pub fn read_insights_activity(
        &self,
        request: &crate::agent_query::ActivityRequest,
    ) -> Result<crate::agent_query::ActivityResponse, crate::query::QueryError> {
        crate::agent_query::read_activity(&self.connection, request)
    }

    pub fn read_deep_query(
        &self,
        request: &crate::deep_query::DeepQueryRequest,
    ) -> Result<crate::deep_query::DeepQueryResponse, crate::query::QueryError> {
        crate::deep_query::read_deep_query(&self.connection, request)
    }

    pub fn read_deep_evidence(
        &self,
        request: &crate::deep_query::DeepEvidenceRequest,
    ) -> Result<crate::deep_query::DeepEvidenceResponse, crate::query::QueryError> {
        crate::deep_query::read_deep_evidence(&self.connection, request)
    }

    pub fn read_recipe(
        &self,
        request: &crate::recipe::RecipeRequest,
    ) -> Result<crate::recipe::RecipeResponse, crate::query::QueryError> {
        crate::recipe::read_recipe(&self.connection, request)
    }

    pub fn maintain_search_projection(
        &mut self,
        batch_size: u16,
    ) -> Result<crate::search_projection::SearchProjectionProgress, StorageError> {
        crate::search_projection::maintain_search_projection(&mut self.connection, batch_size)
    }

    pub fn search(
        &mut self,
        request: crate::query::SearchRequest,
    ) -> Result<crate::query::SearchResponse, crate::query::QueryError> {
        self.search_with_trace(request)
            .map(|(response, _)| response)
    }

    pub fn search_with_trace(
        &mut self,
        request: crate::query::SearchRequest,
    ) -> Result<(crate::query::SearchResponse, crate::query::SearchTrace), crate::query::QueryError>
    {
        self.maintain_search_projection(16).map_err(|error| {
            crate::query::QueryError::new(error.code, "search projection maintenance failed")
        })?;
        crate::query::search_with_trace(&self.connection, request)
    }

    pub fn read_turn_evidence(
        &self,
        turn_key: &str,
        expected_revision: Option<&str>,
        cursor: Option<&str>,
        limit: u16,
    ) -> Result<crate::evidence_path::TurnEvidencePage, crate::query::QueryError> {
        crate::evidence_path::read_turn_evidence(
            &self.connection,
            turn_key,
            expected_revision,
            cursor,
            limit,
        )
    }

    pub fn run_purge_maintenance(
        &mut self,
        limit: u16,
    ) -> Result<crate::source_state::PurgeMaintenanceOutcome, StorageError> {
        crate::source_state::run_purge_maintenance(&mut self.connection, limit)
    }

    pub fn read_committed_session(
        &self,
        session_key: &crate::fact_model::StableKey,
    ) -> Result<Option<crate::fact_repository::CommittedSessionFacts>, StorageError> {
        crate::normalized_repository::read_committed_session(&self.connection, session_key)
    }
}

impl crate::fact_repository::FactRepository for EngineStorage {
    fn apply_session_facts(
        &mut self,
        delta: crate::fact_model::SessionFactsDeltaV1,
    ) -> Result<CommitOutcome, StorageError> {
        EngineStorage::apply_session_facts(self, delta)
    }

    fn read_committed_session(
        &self,
        session_key: &crate::fact_model::StableKey,
    ) -> Result<Option<crate::fact_repository::CommittedSessionFacts>, StorageError> {
        EngineStorage::read_committed_session(self, session_key)
    }
}

#[cfg(test)]
mod tests {
    use super::{
        CommitRequest, EngineStorage, WAL_BACKPRESSURE_BYTES, WAL_PASSIVE_CHECKPOINT_BYTES,
        WalPressureAction, wal_pressure_action,
    };
    use rusqlite::params;

    #[cfg(unix)]
    use std::fs;
    #[cfg(unix)]
    use std::os::unix::fs::PermissionsExt;
    #[cfg(unix)]
    use std::os::unix::fs::symlink;
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
    fn nofollow_database_path(database: &TemporaryDatabase) -> PathBuf {
        fs::canonicalize(&database.directory)
            .unwrap()
            .join(database.path.file_name().unwrap())
    }

    #[cfg(unix)]
    fn assert_private_mode(path: &Path) {
        assert_eq!(
            fs::metadata(path).unwrap().permissions().mode() & 0o777,
            0o600
        );
    }

    fn assert_uuid_v4(value: &str) {
        assert_eq!(value.len(), 36);
        assert_eq!(&value[8..9], "-");
        assert_eq!(&value[13..14], "-");
        assert_eq!(&value[18..19], "-");
        assert_eq!(&value[23..24], "-");
        assert_eq!(&value[14..15], "4");
        assert!(matches!(&value[19..20], "8" | "9" | "a" | "b"));
        assert!(
            value
                .bytes()
                .enumerate()
                .all(
                    |(index, byte)| matches!(index, 8 | 13 | 18 | 23) && byte == b'-'
                        || !matches!(index, 8 | 13 | 18 | 23)
                            && (byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
                )
        );
    }

    #[cfg(unix)]
    #[test]
    fn staged_session_facts_do_not_survive_a_connection_restart() {
        let database = TemporaryDatabase::new();
        let item = serde_json::json!({
            "turnKey": "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb",
            "ownerSessionKey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
            "turnStartOffset": "0",
            "problemText": "staged only",
            "finalAnswerExcerpt": null,
            "observedTimestamp": null,
            "rawClosure": {
                "nextUserBoundary": false,
                "providerTerminal": "completed",
                "observedEofClosed": false
            },
            "providerVisibility": "active",
            "factTruncation": []
        });
        let mut storage = EngineStorage::open(&database.path).unwrap();
        storage
            .stage_session_fact_batch(
                "turns",
                0,
                &[item],
                "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "codex",
            )
            .unwrap();
        assert_eq!(storage.staged_session_fact_count("turns").unwrap(), 1);
        drop(storage);

        let storage = EngineStorage::open(&database.path).unwrap();
        assert_eq!(storage.staged_session_fact_count("turns").unwrap(), 0);
        assert_eq!(storage.committed_session_count().unwrap(), 0);
    }

    #[test]
    fn verifies_bundled_sqlite_and_fts5() {
        let storage = EngineStorage::open_in_memory().unwrap();
        storage.verify_sqlite_contract().unwrap();
    }

    #[cfg(unix)]
    #[test]
    fn new_databases_have_distinct_immutable_database_uuids() {
        let first_database = TemporaryDatabase::new();
        let first_uuid = {
            let storage = EngineStorage::open(&first_database.path).unwrap();
            storage.database_uuid().unwrap()
        };
        assert_uuid_v4(&first_uuid);

        let reopened_uuid = EngineStorage::open(&first_database.path)
            .unwrap()
            .database_uuid()
            .unwrap();
        assert_eq!(reopened_uuid, first_uuid);

        let second_database = TemporaryDatabase::new();
        let second_uuid = EngineStorage::open(&second_database.path)
            .unwrap()
            .database_uuid()
            .unwrap();
        assert_uuid_v4(&second_uuid);
        assert_ne!(second_uuid, first_uuid);
    }

    #[cfg(unix)]
    #[test]
    fn open_existing_never_creates_a_missing_database() {
        let database = TemporaryDatabase::new();
        let path = nofollow_database_path(&database);
        assert!(!path.exists());

        let error = match EngineStorage::open_existing(&path) {
            Ok(_) => panic!("a missing database must not be created"),
            Err(error) => error,
        };

        assert_eq!(error.code, "TS_INSIGHTS_STORAGE_FAILED");
        assert!(!error.message.contains(path.to_string_lossy().as_ref()));
        assert!(!path.exists());
    }

    #[cfg(unix)]
    #[test]
    fn open_existing_rejects_a_symlink_without_touching_its_target() {
        let database = TemporaryDatabase::new();
        let path = nofollow_database_path(&database);
        let expected_uuid = EngineStorage::open(&path).unwrap().database_uuid().unwrap();
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        let link_path = path.with_file_name("engine-link.sqlite3");
        symlink(&path, &link_path).unwrap();

        let error = match EngineStorage::open_existing(&link_path) {
            Ok(_) => panic!("a symlink database path must be rejected"),
            Err(error) => error,
        };

        assert_eq!(error.code, "TS_INSIGHTS_STORAGE_FAILED");
        assert_eq!(
            fs::metadata(&path).unwrap().permissions().mode() & 0o777,
            0o640
        );
        assert_eq!(
            EngineStorage::open_existing(&path)
                .unwrap()
                .database_uuid()
                .unwrap(),
            expected_uuid
        );
    }

    #[cfg(unix)]
    #[test]
    fn open_existing_preserves_database_and_sidecar_permissions() {
        let database = TemporaryDatabase::new();
        let path = nofollow_database_path(&database);
        let writer = EngineStorage::open(&path).unwrap();
        writer
            .connection
            .execute_batch(
                "CREATE TABLE open_existing_fixture(value TEXT NOT NULL);
                 INSERT INTO open_existing_fixture(value) VALUES ('ready');",
            )
            .unwrap();
        let wal_path = sidecar_path(&path, "-wal");
        let shm_path = sidecar_path(&path, "-shm");
        fs::set_permissions(&path, fs::Permissions::from_mode(0o640)).unwrap();
        fs::set_permissions(&wal_path, fs::Permissions::from_mode(0o620)).unwrap();
        fs::set_permissions(&shm_path, fs::Permissions::from_mode(0o660)).unwrap();

        let reader = EngineStorage::open_existing(&path).unwrap();
        assert_eq!(reader.read_engine_status().unwrap().snapshot_seq, "0");

        for (path, expected) in [(&path, 0o640), (&wal_path, 0o620), (&shm_path, 0o660)] {
            assert_eq!(
                fs::metadata(path).unwrap().permissions().mode() & 0o777,
                expected
            );
        }
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

    #[test]
    fn applies_the_fixed_wal_pressure_thresholds() {
        assert_eq!(WAL_PASSIVE_CHECKPOINT_BYTES, 64 * 1024 * 1024);
        assert_eq!(WAL_BACKPRESSURE_BYTES, 128 * 1024 * 1024);
        assert_eq!(
            wal_pressure_action(
                WAL_PASSIVE_CHECKPOINT_BYTES - 1,
                WAL_PASSIVE_CHECKPOINT_BYTES,
                WAL_BACKPRESSURE_BYTES,
            ),
            WalPressureAction::None
        );
        assert_eq!(
            wal_pressure_action(
                WAL_PASSIVE_CHECKPOINT_BYTES,
                WAL_PASSIVE_CHECKPOINT_BYTES,
                WAL_BACKPRESSURE_BYTES,
            ),
            WalPressureAction::PassiveCheckpoint
        );
        assert_eq!(
            wal_pressure_action(
                WAL_BACKPRESSURE_BYTES,
                WAL_PASSIVE_CHECKPOINT_BYTES,
                WAL_BACKPRESSURE_BYTES,
            ),
            WalPressureAction::Backpressure
        );
    }

    #[cfg(unix)]
    #[test]
    fn checkpoints_a_persistent_wal_at_transaction_boundaries() {
        let database = TemporaryDatabase::new();
        let storage = EngineStorage::open(&database.path).unwrap();
        let autocheckpoint: i64 = storage
            .connection
            .query_row("PRAGMA wal_autocheckpoint", [], |row| row.get(0))
            .unwrap();
        assert_eq!(autocheckpoint, 0);

        storage
            .connection
            .execute_batch(
                "CREATE TABLE wal_pressure_fixture(value BLOB NOT NULL);
                 INSERT INTO wal_pressure_fixture(value) VALUES (zeroblob(262144));",
            )
            .unwrap();
        let wal_path = sidecar_path(&database.path, "-wal");
        assert!(fs::metadata(&wal_path).unwrap().len() > 0);
        assert_eq!(
            storage
                .maintain_wal_after_commit_with_thresholds(1, u64::MAX)
                .unwrap(),
            WalPressureAction::PassiveCheckpoint
        );

        storage
            .connection
            .execute(
                "INSERT INTO wal_pressure_fixture(value) VALUES (zeroblob(4096))",
                [],
            )
            .unwrap();
        assert_eq!(
            storage
                .maintain_wal_after_commit_with_thresholds(1, 2)
                .unwrap(),
            WalPressureAction::Backpressure
        );
        assert_eq!(fs::metadata(wal_path).unwrap().len(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn reads_content_free_engine_status_from_persistent_storage() {
        let database = TemporaryDatabase::new();
        let storage = EngineStorage::open(&database.path).unwrap();
        let status = storage.read_engine_status().unwrap();

        assert_eq!(status.snapshot_seq, "0");
        assert!(status.snapshot_pending);
        assert_eq!(status.snapshot_age_ms, None);
        assert_eq!(status.fact_storage_profile, "normalized-row-v1");
        assert_eq!(status.projections.len(), 1);
        assert_eq!(status.projections[0].name, "turn-search");
        assert_eq!(status.projections[0].version, 2);
        assert_eq!(status.projections[0].status, "active");
        assert_eq!(status.change_log.rows, "0");
        assert_eq!(status.purge.state, crate::source_state::PurgeState::Idle);
        assert_eq!(status.storage.wal_pressure_action, "none");
        assert_eq!(status.storage.recent_diagnostic, None);
        assert_eq!(status.integrity.quick_check, "ok");
        assert_eq!(status.integrity.fts, "ok");
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

    #[cfg(unix)]
    #[test]
    fn rejects_non_sqlite_state_with_a_stable_corruption_diagnostic() {
        let database = TemporaryDatabase::new();
        fs::write(&database.path, b"not a sqlite database").unwrap();

        let error = match EngineStorage::open(&database.path) {
            Ok(_) => panic!("garbage state must not open as SQLite"),
            Err(error) => error,
        };
        assert_eq!(error.code, "TS_INSIGHTS_STORAGE_CORRUPT");
        assert!(
            !error
                .message
                .contains(database.path.to_string_lossy().as_ref())
        );
    }

    #[cfg(unix)]
    #[test]
    fn committed_write_replays_after_a_reader_releases_wal_backpressure() {
        let database = TemporaryDatabase::new();
        let mut storage = EngineStorage::open(&database.path).unwrap();
        storage
            .connection
            .execute_batch(
                "CREATE TABLE wal_backpressure_fixture(value BLOB NOT NULL);
                 INSERT INTO wal_backpressure_fixture(value) VALUES (x'00');
                 PRAGMA wal_checkpoint(TRUNCATE);",
            )
            .unwrap();

        let mut reader = rusqlite::Connection::open(&database.path).unwrap();
        reader.execute_batch("PRAGMA journal_mode=WAL;").unwrap();
        let reader_snapshot = reader.transaction().unwrap();
        let observed: i64 = reader_snapshot
            .query_row("SELECT COUNT(*) FROM wal_backpressure_fixture", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(observed, 1);

        let payload_bytes = i64::try_from(WAL_BACKPRESSURE_BYTES + 4 * 1024 * 1024).unwrap();
        storage
            .connection
            .execute(
                "INSERT INTO wal_backpressure_fixture(value) VALUES (zeroblob(?1))",
                [payload_bytes],
            )
            .unwrap();
        let wal_path = sidecar_path(&database.path, "-wal");
        assert!(fs::metadata(&wal_path).unwrap().len() >= WAL_BACKPRESSURE_BYTES);

        let error = storage
            .commit_session(request('b', "0", "1", "{\"a\":1}"))
            .unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_WAL_BACKPRESSURE");
        assert_eq!(storage.committed_session_count().unwrap(), 1);

        drop(reader_snapshot);
        drop(reader);
        let replay = storage
            .commit_session(request('b', "0", "1", "{\"a\":1}"))
            .unwrap();
        assert!(replay.idempotent);
        assert_eq!(replay.snapshot_seq, "1");
        assert_eq!(fs::metadata(wal_path).unwrap().len(), 0);
    }

    #[cfg(unix)]
    #[test]
    fn migrates_legacy_commit_receipts_to_bounded_digests() {
        let database = TemporaryDatabase::new();
        let connection = rusqlite::Connection::open(&database.path).unwrap();
        connection
            .execute_batch(
                "CREATE TABLE session_commits (
                   session_key BLOB PRIMARY KEY,
                   generation TEXT NOT NULL,
                   delta_id BLOB NOT NULL,
                   canonical_delta TEXT NOT NULL,
                   snapshot_seq INTEGER NOT NULL
                 ) WITHOUT ROWID;",
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session_commits(
                   session_key,generation,delta_id,canonical_delta,snapshot_seq
                 ) VALUES (?1,'1',?2,'{\"a\":1}',1)",
                params![vec![0xaau8; 32], vec![0xbbu8; 32]],
            )
            .unwrap();
        drop(connection);

        let mut storage = EngineStorage::open(&database.path).unwrap();
        assert_eq!(storage.committed_session_count().unwrap(), 1);
        let columns = storage
            .connection
            .prepare("SELECT name FROM pragma_table_info('session_commits') ORDER BY cid")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(!columns.iter().any(|column| column == "canonical_delta"));
        assert!(columns.iter().any(|column| column == "canonical_digest"));
        let digest_length: i64 = storage
            .connection
            .query_row(
                "SELECT length(canonical_digest) FROM session_commits",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(digest_length, 32);
        assert!(
            storage
                .commit_session(request('b', "0", "1", "{\"a\":1}"))
                .unwrap()
                .idempotent
        );
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
