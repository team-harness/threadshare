use crate::projection::{
    CHANGE_LOG_MAX_PAYLOAD_BYTES, CHANGE_LOG_MAX_ROWS, projection_change_log_usage,
};
use crate::source_state::{PurgeStatus, read_purge_status};
use crate::storage::{
    StorageError, WAL_BACKPRESSURE_BYTES, WAL_PASSIVE_CHECKPOINT_BYTES, WalPressureAction,
    wal_pressure_action,
};
use rusqlite::{Connection, OptionalExtension};
use serde::Serialize;
use std::path::{Path, PathBuf};
use std::time::{SystemTime, UNIX_EPOCH};

pub const FACT_STORAGE_PROFILE: &str = "normalized-row-v1";
const MAX_PROJECTION_STATES: usize = 1_024;

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineStatus {
    pub snapshot_seq: String,
    pub snapshot_age_ms: Option<String>,
    pub snapshot_pending: bool,
    pub fact_storage_profile: String,
    pub projections: Vec<EngineProjectionStatus>,
    pub change_log: EngineChangeLogStatus,
    pub purge: PurgeStatus,
    pub storage: EngineStorageStatus,
    pub integrity: EngineIntegrityStatus,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineProjectionStatus {
    pub name: String,
    pub version: u32,
    pub input_fact_schema_version: u32,
    pub root_kind: String,
    pub base_snapshot_seq: String,
    pub watermark: String,
    pub status: String,
    pub error_digest: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineChangeLogStatus {
    pub rows: String,
    pub payload_bytes: String,
    pub max_rows: String,
    pub max_payload_bytes: String,
    pub state: String,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineStorageStatus {
    pub database_bytes: String,
    pub wal_bytes: String,
    pub wal_pressure_action: String,
    pub recent_diagnostic: Option<String>,
}

#[derive(Debug, Clone, Serialize, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub struct EngineIntegrityStatus {
    pub quick_check: String,
    pub fts: String,
}

fn corrupt(message: impl Into<String>) -> StorageError {
    StorageError::new("TS_INSIGHTS_STORAGE_CORRUPT", message)
}

fn status_query_error(_error: rusqlite::Error) -> StorageError {
    corrupt("the Insights database status metadata is invalid")
}

fn system_time_ms(time: SystemTime) -> u64 {
    time.duration_since(UNIX_EPOCH)
        .map(|duration| u64::try_from(duration.as_millis()).unwrap_or(u64::MAX))
        .unwrap_or(0)
}

fn now_ms() -> u64 {
    system_time_ms(SystemTime::now())
}

fn sidecar_path(path: &Path, suffix: &str) -> PathBuf {
    let mut value = path.as_os_str().to_owned();
    value.push(suffix);
    PathBuf::from(value)
}

fn file_bytes(path: &Path) -> Result<u64, StorageError> {
    match std::fs::metadata(path) {
        Ok(metadata) => Ok(metadata.len()),
        Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(0),
        Err(error) => Err(error.into()),
    }
}

fn latest_storage_modified_ms(path: &Path) -> Result<Option<u64>, StorageError> {
    let mut latest = None;
    for candidate in [path.to_path_buf(), sidecar_path(path, "-wal")] {
        match std::fs::metadata(candidate) {
            Ok(metadata) => {
                let modified = system_time_ms(metadata.modified()?);
                latest = Some(latest.map_or(modified, |value: u64| value.max(modified)));
            }
            Err(error) if error.kind() == std::io::ErrorKind::NotFound => {}
            Err(error) => return Err(error.into()),
        }
    }
    Ok(latest)
}

fn verify_integrity(connection: &Connection) -> Result<EngineIntegrityStatus, StorageError> {
    let quick_check: String = connection
        .query_row("PRAGMA quick_check(1)", [], |row| row.get(0))
        .map_err(|_| corrupt("the Insights database failed quick_check"))?;
    if quick_check != "ok" {
        return Err(corrupt("the Insights database failed quick_check"));
    }
    connection
        .execute(
            "INSERT INTO turns_fts(turns_fts) VALUES('integrity-check')",
            [],
        )
        .map_err(|_| corrupt("the Insights FTS index failed integrity-check"))?;
    Ok(EngineIntegrityStatus {
        quick_check: "ok".to_owned(),
        fts: "ok".to_owned(),
    })
}

fn snapshot_status(
    connection: &Connection,
    database_path: Option<&Path>,
) -> Result<(String, Option<String>, bool), StorageError> {
    let snapshot_seq: String = connection
        .query_row(
            "SELECT value FROM engine_metadata WHERE key='snapshot_seq'",
            [],
            |row| row.get(0),
        )
        .map_err(status_query_error)?;
    let snapshot_number = snapshot_seq
        .parse::<u64>()
        .map_err(|_| corrupt("the Insights snapshot sequence is invalid"))?;
    if snapshot_number == 0 {
        return Ok((snapshot_seq, None, true));
    }

    let committed_at: Option<String> = connection
        .query_row(
            "SELECT value FROM engine_metadata WHERE key='snapshot_committed_at_ms'",
            [],
            |row| row.get(0),
        )
        .optional()
        .map_err(status_query_error)?;
    let committed_at = match committed_at {
        Some(value) => Some(
            value
                .parse::<u64>()
                .map_err(|_| corrupt("the Insights snapshot timestamp is invalid"))?,
        ),
        None => match database_path {
            Some(path) => latest_storage_modified_ms(path)?,
            None => None,
        },
    }
    .unwrap_or_else(now_ms);
    let age = now_ms().saturating_sub(committed_at);
    Ok((snapshot_seq, Some(age.to_string()), false))
}

fn projection_statuses(
    connection: &Connection,
) -> Result<Vec<EngineProjectionStatus>, StorageError> {
    let mut statement = connection
        .prepare(
            "SELECT
               name,version,input_fact_schema_version,root_kind,
               base_snapshot_seq,watermark,status,error_digest
             FROM projection_state
             ORDER BY name,version
             LIMIT 1025",
        )
        .map_err(status_query_error)?;
    let rows = statement
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, String>(3)?,
                row.get::<_, i64>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, String>(6)?,
                row.get::<_, Option<Vec<u8>>>(7)?,
            ))
        })
        .map_err(status_query_error)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(status_query_error)?;
    if rows.len() > MAX_PROJECTION_STATES {
        return Err(corrupt(
            "the Insights projection status exceeds its bounded protocol limit",
        ));
    }
    rows.into_iter()
        .map(
            |(
                name,
                version,
                input_fact_schema_version,
                root_kind,
                base_snapshot_seq,
                watermark,
                status,
                error_digest,
            )| {
                if name.is_empty()
                    || name.len() > 128
                    || !name.bytes().all(|byte| (0x21..=0x7e).contains(&byte))
                    || !matches!(root_kind.as_str(), "session" | "turn" | "capability")
                    || !matches!(status.as_str(), "active" | "building" | "failed")
                    || base_snapshot_seq < 0
                    || watermark < base_snapshot_seq
                    || (status == "failed") != error_digest.is_some()
                    || error_digest
                        .as_ref()
                        .is_some_and(|digest| digest.len() != 32)
                {
                    return Err(corrupt("the Insights projection status is invalid"));
                }
                let version = u32::try_from(version)
                    .ok()
                    .filter(|value| *value != 0)
                    .ok_or_else(|| corrupt("the Insights projection version is invalid"))?;
                let input_fact_schema_version = u32::try_from(input_fact_schema_version)
                    .ok()
                    .filter(|value| *value != 0)
                    .ok_or_else(|| corrupt("the Insights projection input version is invalid"))?;
                Ok(EngineProjectionStatus {
                    name,
                    version,
                    input_fact_schema_version,
                    root_kind,
                    base_snapshot_seq: base_snapshot_seq.to_string(),
                    watermark: watermark.to_string(),
                    status,
                    error_digest: error_digest.map(hex::encode),
                })
            },
        )
        .collect()
}

pub(crate) fn read_engine_status(
    connection: &Connection,
    database_path: Option<&Path>,
) -> Result<EngineStatus, StorageError> {
    let integrity = verify_integrity(connection)?;
    let (snapshot_seq, snapshot_age_ms, snapshot_pending) =
        snapshot_status(connection, database_path)?;
    let projections = projection_statuses(connection)?;
    let usage = projection_change_log_usage(connection).map_err(status_query_error)?;
    let change_log_exceeded = usage.exceeds_limit();
    let purge = read_purge_status(connection, None)?;
    let (database_bytes, wal_bytes) = match database_path {
        Some(path) => (file_bytes(path)?, file_bytes(&sidecar_path(path, "-wal"))?),
        None => (0, 0),
    };
    let wal_pressure = wal_pressure_action(
        wal_bytes,
        WAL_PASSIVE_CHECKPOINT_BYTES,
        WAL_BACKPRESSURE_BYTES,
    );
    Ok(EngineStatus {
        snapshot_seq,
        snapshot_age_ms,
        snapshot_pending,
        fact_storage_profile: FACT_STORAGE_PROFILE.to_owned(),
        projections,
        change_log: EngineChangeLogStatus {
            rows: usage.row_count.to_string(),
            payload_bytes: usage.payload_bytes.to_string(),
            max_rows: CHANGE_LOG_MAX_ROWS.to_string(),
            max_payload_bytes: CHANGE_LOG_MAX_PAYLOAD_BYTES.to_string(),
            state: if change_log_exceeded {
                "cap-exceeded"
            } else {
                "within-cap"
            }
            .to_owned(),
        },
        purge,
        storage: EngineStorageStatus {
            database_bytes: database_bytes.to_string(),
            wal_bytes: wal_bytes.to_string(),
            wal_pressure_action: wal_pressure.as_str().to_owned(),
            recent_diagnostic: (wal_pressure == WalPressureAction::Backpressure)
                .then(|| "TS_INSIGHTS_WAL_BACKPRESSURE".to_owned()),
        },
        integrity,
    })
}
