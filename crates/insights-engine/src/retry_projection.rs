use crate::fact_model::{
    CapabilityTerminalState, Eligibility, OriginScope, ProviderVisibility, SessionScope, StableKey,
};
use crate::fact_repository::{FactEntity, FactEntityKind, FactRepository, SessionFactSnapshot};
use crate::projection::{
    ChangeLogUsage, ProjectionRootKind, ProjectionState, ProjectionStatus,
    projection_change_log_usage, upsert_projection_state,
};
use crate::storage::StorageError;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use std::collections::BTreeMap;

pub const RETRY_PROJECTION_NAME: &str = "capability-retry-summary";
pub const RETRY_PROJECTION_VERSION: u32 = 1;
const ERROR_DIGEST_BYTES: usize = 32;
const CHANGE_LOG_LIMIT_ERROR_DIGEST: [u8; ERROR_DIGEST_BYTES] = [0x6c; ERROR_DIGEST_BYTES];

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetryProjectionProgress {
    pub version: u32,
    pub status: String,
    pub base_snapshot_seq: i64,
    pub watermark: i64,
    pub base_complete: bool,
    pub processed_sessions: u32,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct RetrySummary {
    pub capability_key: Vec<u8>,
    pub failed_count: u64,
    pub same_input_repeat_count: u64,
    pub retry_after_failure_count: u64,
}

pub fn initialize_retry_projection_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS capability_retry_contributions (
           projection_version INTEGER NOT NULL CHECK(projection_version > 0),
           owner_session_key BLOB NOT NULL CHECK(length(owner_session_key)=32),
           capability_key BLOB NOT NULL CHECK(length(capability_key)=32),
           failed_count INTEGER NOT NULL CHECK(failed_count >= 0),
           same_input_repeat_count INTEGER NOT NULL CHECK(same_input_repeat_count >= 0),
           retry_after_failure_count INTEGER NOT NULL CHECK(retry_after_failure_count >= 0),
           PRIMARY KEY(projection_version, owner_session_key, capability_key)
         ) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS capability_retry_summary_lookup
           ON capability_retry_contributions(projection_version, capability_key);
         CREATE TABLE IF NOT EXISTS retry_projection_build_cursor (
           projection_version INTEGER PRIMARY KEY CHECK(projection_version > 0),
           base_snapshot_seq INTEGER NOT NULL CHECK(base_snapshot_seq >= 0),
           last_session_key BLOB CHECK(last_session_key IS NULL OR length(last_session_key)=32),
           base_complete INTEGER NOT NULL CHECK(base_complete IN (0,1))
         ) WITHOUT ROWID;",
    )
}

fn projection_state(
    connection: &Connection,
    version: u32,
) -> Result<Option<(String, u32, i64, i64)>, StorageError> {
    connection
        .query_row(
            "SELECT status, input_fact_schema_version, base_snapshot_seq, watermark
             FROM projection_state WHERE name=?1 AND version=?2",
            params![RETRY_PROJECTION_NAME, version],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(Into::into)
}

fn current_snapshot(connection: &Connection) -> Result<i64, StorageError> {
    connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM engine_metadata WHERE key='snapshot_seq'",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

pub fn begin_retry_projection_build(
    connection: &mut Connection,
    version: u32,
    input_fact_schema_version: u32,
) -> Result<RetryProjectionProgress, StorageError> {
    if version == 0 || input_fact_schema_version == 0 {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_INVALID",
            "projection and input Fact versions must be positive",
        ));
    }
    if let Some((status, stored_input_version, base, watermark)) =
        projection_state(connection, version)?
    {
        if stored_input_version != input_fact_schema_version {
            return Err(StorageError::new(
                "TS_INSIGHTS_PROJECTION_INVALID",
                "projection version is already bound to another input Fact schema version",
            ));
        }
        if status == "active" {
            return Ok(RetryProjectionProgress {
                version,
                status,
                base_snapshot_seq: base,
                watermark,
                base_complete: true,
                processed_sessions: 0,
            });
        }
        if status == "building" {
            let (_, _, base_complete) = build_cursor(connection, version)?;
            return Ok(RetryProjectionProgress {
                version,
                status,
                base_snapshot_seq: base,
                watermark,
                base_complete,
                processed_sessions: 0,
            });
        }
    }

    let base_snapshot_seq = current_snapshot(connection)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    transaction.execute(
        "DELETE FROM capability_retry_contributions WHERE projection_version=?1",
        params![version],
    )?;
    transaction.execute(
        "DELETE FROM retry_projection_build_cursor WHERE projection_version=?1",
        params![version],
    )?;
    upsert_projection_state(
        &transaction,
        &ProjectionState {
            name: RETRY_PROJECTION_NAME,
            version,
            input_fact_schema_version,
            root_kind: ProjectionRootKind::Session,
            base_snapshot_seq,
            watermark: base_snapshot_seq,
            status: ProjectionStatus::Building,
            error_digest: None,
        },
    )?;
    transaction.execute(
        "INSERT INTO retry_projection_build_cursor(
           projection_version, base_snapshot_seq, last_session_key, base_complete
         ) VALUES (?1,?2,NULL,0)",
        params![version, base_snapshot_seq],
    )?;
    transaction.commit()?;
    Ok(RetryProjectionProgress {
        version,
        status: "building".to_owned(),
        base_snapshot_seq,
        watermark: base_snapshot_seq,
        base_complete: false,
        processed_sessions: 0,
    })
}

fn rebuild_session_contributions(
    transaction: &Transaction<'_>,
    repository: &dyn FactRepository,
    version: u32,
    session_key: &StableKey,
) -> Result<(), StorageError> {
    transaction.execute(
        "DELETE FROM capability_retry_contributions
         WHERE projection_version=?1 AND owner_session_key=?2",
        params![version, session_key.as_bytes().as_slice()],
    )?;
    let Some(FactEntity::Session(facts)) =
        repository.lookup_stable_key(FactEntityKind::Session, session_key)?
    else {
        return Ok(());
    };
    insert_session_contributions(transaction, version, &facts)?;
    Ok(())
}

#[derive(Debug, Default)]
struct RetryCounts {
    failed: u64,
    same_input_repeat: u64,
    retry_after_failure: u64,
}

fn retry_counts(facts: &SessionFactSnapshot) -> BTreeMap<StableKey, RetryCounts> {
    if facts.session.session_scope != SessionScope::Main
        || facts.session.eligibility != Eligibility::Eligible
    {
        return BTreeMap::new();
    }
    let active_turns = facts
        .turns
        .iter()
        .filter(|turn| turn.provider_visibility == ProviderVisibility::Active)
        .map(|turn| (turn.turn_key, turn.turn_start_offset.get()))
        .collect::<BTreeMap<_, _>>();
    let mut uses = facts
        .capability_uses
        .iter()
        .filter(|usage| {
            usage.origin_scope == OriginScope::Main
                && usage.input_fingerprint.is_some()
                && active_turns.contains_key(&usage.turn_key)
        })
        .collect::<Vec<_>>();
    uses.sort_by_key(|usage| {
        (
            usage.capability_key,
            usage.input_fingerprint,
            active_turns[&usage.turn_key],
            usage.turn_ordinal,
            usage.use_key,
        )
    });

    let mut previous = BTreeMap::new();
    let mut counts = BTreeMap::<StableKey, RetryCounts>::new();
    for usage in uses {
        let input_fingerprint = usage
            .input_fingerprint
            .expect("filtered capability use has an input fingerprint");
        let group = (usage.capability_key, input_fingerprint);
        let prior = previous.insert(group, usage.provider_terminal_state);
        let entry = counts.entry(usage.capability_key).or_default();
        if usage.provider_terminal_state == CapabilityTerminalState::Failed {
            entry.failed += 1;
        }
        if prior.is_some() {
            entry.same_input_repeat += 1;
        }
        if prior == Some(CapabilityTerminalState::Failed) {
            entry.retry_after_failure += 1;
        }
    }
    counts
}

fn insert_session_contributions(
    transaction: &Transaction<'_>,
    version: u32,
    facts: &SessionFactSnapshot,
) -> Result<(), StorageError> {
    for (capability_key, counts) in retry_counts(facts) {
        transaction.execute(
            "INSERT INTO capability_retry_contributions(
               projection_version,owner_session_key,capability_key,failed_count,
               same_input_repeat_count,retry_after_failure_count
             ) VALUES (?1,?2,?3,?4,?5,?6)",
            params![
                version,
                facts.session.session_key.as_bytes().as_slice(),
                capability_key.as_bytes().as_slice(),
                projection_count(counts.failed)?,
                projection_count(counts.same_input_repeat)?,
                projection_count(counts.retry_after_failure)?,
            ],
        )?;
    }
    Ok(())
}

fn projection_count(value: u64) -> Result<i64, StorageError> {
    i64::try_from(value).map_err(|_| {
        StorageError::new(
            "TS_INSIGHTS_PROJECTION_FAILED",
            "retry projection aggregate exceeds SQLite integer range",
        )
    })
}

fn build_cursor(
    connection: &Connection,
    version: u32,
) -> Result<(i64, Option<StableKey>, bool), StorageError> {
    connection
        .query_row(
            "SELECT base_snapshot_seq, last_session_key, base_complete
             FROM retry_projection_build_cursor WHERE projection_version=?1",
            params![version],
            |row| {
                let cursor = row
                    .get::<_, Option<Vec<u8>>>(1)?
                    .map(|value| stable_key(&value).map_err(|error| conversion_error(1, error)))
                    .transpose()?;
                Ok((row.get(0)?, cursor, row.get::<_, i64>(2)? != 0))
            },
        )
        .optional()?
        .ok_or_else(|| {
            StorageError::new(
                "TS_INSIGHTS_PROJECTION_NOT_BUILDING",
                "retry projection has no resumable build cursor",
            )
        })
}

pub fn advance_retry_projection_build(
    connection: &mut Connection,
    version: u32,
    batch_size: u16,
) -> Result<RetryProjectionProgress, StorageError> {
    if batch_size == 0 || batch_size > 256 {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_INVALID",
            "projection build batch size must be between 1 and 256",
        ));
    }
    let Some((status, _, base_snapshot_seq, watermark)) = projection_state(connection, version)?
    else {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_NOT_BUILDING",
            "retry projection build state is missing",
        ));
    };
    if status != "building" {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_NOT_BUILDING",
            "retry projection is not building",
        ));
    }
    let (_, last_session_key, already_complete) = build_cursor(connection, version)?;
    if already_complete {
        return Ok(RetryProjectionProgress {
            version,
            status,
            base_snapshot_seq,
            watermark,
            base_complete: true,
            processed_sessions: 0,
        });
    }

    let base_snapshot = u64::try_from(base_snapshot_seq).map_err(|_| {
        StorageError::new(
            "TS_INSIGHTS_PROJECTION_CORRUPT",
            "retry projection base snapshot is negative",
        )
    })?;
    let page = FactRepository::scan_snapshot(
        &*connection,
        base_snapshot,
        last_session_key.as_ref(),
        batch_size,
    )?;
    let processed_sessions = u32::try_from(page.sessions.len()).map_err(|_| {
        StorageError::new(
            "TS_INSIGHTS_PROJECTION_FAILED",
            "retry projection batch exceeds uint32",
        )
    })?;
    let next_cursor = page.next_cursor;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for facts in &page.sessions {
        transaction.execute(
            "DELETE FROM capability_retry_contributions
             WHERE projection_version=?1 AND owner_session_key=?2",
            params![version, facts.session.session_key.as_bytes().as_slice()],
        )?;
        insert_session_contributions(&transaction, version, facts)?;
    }
    let base_complete = next_cursor.is_none();
    transaction.execute(
        "UPDATE retry_projection_build_cursor
         SET last_session_key=?2, base_complete=?3
         WHERE projection_version=?1",
        params![
            version,
            next_cursor.map(|key| key.as_bytes().to_vec()),
            i64::from(base_complete)
        ],
    )?;
    transaction.commit()?;
    Ok(RetryProjectionProgress {
        version,
        status,
        base_snapshot_seq,
        watermark,
        base_complete,
        processed_sessions,
    })
}

pub fn fail_retry_projection_build(
    connection: &mut Connection,
    version: u32,
    error_digest: &[u8],
) -> Result<(), StorageError> {
    if error_digest.len() != ERROR_DIGEST_BYTES {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_INVALID",
            "projection error digest must be 32 bytes",
        ));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some((status, input_fact_schema_version, base_snapshot_seq, watermark)) =
        projection_state(&transaction, version)?
    else {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_NOT_BUILDING",
            "retry projection build state is missing",
        ));
    };
    if status != "building" {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_NOT_BUILDING",
            "retry projection is not building",
        ));
    }
    mark_retry_projection_failed(
        &transaction,
        version,
        input_fact_schema_version,
        base_snapshot_seq,
        watermark,
        error_digest,
    )?;
    transaction.commit()?;
    Ok(())
}

fn mark_retry_projection_failed(
    transaction: &Transaction<'_>,
    version: u32,
    input_fact_schema_version: u32,
    base_snapshot_seq: i64,
    watermark: i64,
    error_digest: &[u8],
) -> Result<(), StorageError> {
    transaction.execute(
        "DELETE FROM capability_retry_contributions WHERE projection_version=?1",
        params![version],
    )?;
    transaction.execute(
        "DELETE FROM retry_projection_build_cursor WHERE projection_version=?1",
        params![version],
    )?;
    upsert_projection_state(
        transaction,
        &ProjectionState {
            name: RETRY_PROJECTION_NAME,
            version,
            input_fact_schema_version,
            root_kind: ProjectionRootKind::Session,
            base_snapshot_seq,
            watermark,
            status: ProjectionStatus::Failed,
            error_digest: Some(error_digest),
        },
    )?;
    Ok(())
}

pub(crate) fn cancel_retry_projection_for_change_log(
    transaction: &Transaction<'_>,
    name: &str,
    version: u32,
) -> Result<bool, StorageError> {
    if name != RETRY_PROJECTION_NAME {
        return Ok(false);
    }
    let Some((status, input_fact_schema_version, base_snapshot_seq, watermark)) =
        projection_state(transaction, version)?
    else {
        return Ok(false);
    };
    if status != "building" {
        return Ok(false);
    }
    mark_retry_projection_failed(
        transaction,
        version,
        input_fact_schema_version,
        base_snapshot_seq,
        watermark,
        &CHANGE_LOG_LIMIT_ERROR_DIGEST,
    )?;
    Ok(true)
}

pub fn catch_up_retry_projection(
    connection: &mut Connection,
    version: u32,
    batch_size: u16,
) -> Result<RetryProjectionProgress, StorageError> {
    catch_up_retry_projection_with_usage(connection, version, batch_size, None)
}

fn catch_up_retry_projection_with_usage(
    connection: &mut Connection,
    version: u32,
    batch_size: u16,
    usage_override: Option<ChangeLogUsage>,
) -> Result<RetryProjectionProgress, StorageError> {
    if batch_size == 0 || batch_size > 256 {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_INVALID",
            "projection catch-up batch size must be between 1 and 256",
        ));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some((status, input_fact_schema_version, base_snapshot_seq, watermark)) =
        projection_state(&transaction, version)?
    else {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_NOT_BUILDING",
            "retry projection build state is missing",
        ));
    };
    if status != "building" {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_NOT_BUILDING",
            "retry projection is not building",
        ));
    }
    let usage = match usage_override {
        Some(usage) => usage,
        None => projection_change_log_usage(&transaction)?,
    };
    if usage.exceeds_limit() {
        mark_retry_projection_failed(
            &transaction,
            version,
            input_fact_schema_version,
            base_snapshot_seq,
            watermark,
            &CHANGE_LOG_LIMIT_ERROR_DIGEST,
        )?;
        transaction.commit()?;
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_CHANGE_LOG_LIMIT",
            "projection change log exceeded its bounded catch-up limit",
        ));
    }
    let (_, catchup_session_key, base_complete) = build_cursor(&transaction, version)?;
    if !base_complete {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_BASE_INCOMPLETE",
            "retry projection base scan is not complete",
        ));
    }

    let changes = {
        let mut statement = transaction.prepare(
            "WITH owner_changes AS (
               SELECT owner_session_key, MAX(snapshot_seq) AS latest_snapshot
               FROM projection_change_log
               WHERE snapshot_seq>?1
               GROUP BY owner_session_key
             )
             SELECT owner_session_key, latest_snapshot
             FROM owner_changes
             WHERE latest_snapshot>?2
                OR (latest_snapshot=?2 AND owner_session_key>?3)
             ORDER BY latest_snapshot, owner_session_key
             LIMIT ?4",
        )?;
        statement
            .query_map(
                params![
                    base_snapshot_seq,
                    watermark,
                    catchup_session_key.map(|key| key.as_bytes().to_vec()),
                    batch_size
                ],
                |row| {
                    let value = row.get::<_, Vec<u8>>(0)?;
                    let key = stable_key(&value).map_err(|error| conversion_error(0, error))?;
                    Ok((key, row.get::<_, i64>(1)?))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (session_key, _) in &changes {
        rebuild_session_contributions(&transaction, &*transaction, version, session_key)?;
    }
    let (new_watermark, new_catchup_session_key) = changes
        .last()
        .map(|(session_key, snapshot)| (*snapshot, Some(*session_key)))
        .unwrap_or((watermark, catchup_session_key));
    let snapshot_at_commit: i64 = transaction.query_row(
        "SELECT CAST(value AS INTEGER) FROM engine_metadata WHERE key='snapshot_seq'",
        [],
        |row| row.get(0),
    )?;
    let pending_changes: i64 = transaction.query_row(
        "WITH owner_changes AS (
           SELECT owner_session_key, MAX(snapshot_seq) AS latest_snapshot
           FROM projection_change_log
           WHERE snapshot_seq>?1
           GROUP BY owner_session_key
         )
         SELECT EXISTS(
           SELECT 1 FROM owner_changes
           WHERE latest_snapshot>?2
              OR (latest_snapshot=?2 AND owner_session_key>?3)
         )",
        params![
            base_snapshot_seq,
            new_watermark,
            new_catchup_session_key.map(|key| key.as_bytes().to_vec())
        ],
        |row| row.get(0),
    )?;
    let caught_up = pending_changes == 0;
    if caught_up {
        let old_active_version = transaction
            .query_row(
                "SELECT version FROM projection_state
                 WHERE name=?1 AND status='active' AND version<>?2",
                params![RETRY_PROJECTION_NAME, version],
                |row| row.get::<_, u32>(0),
            )
            .optional()?;
        if let Some(old_active_version) = old_active_version {
            transaction.execute(
                "DELETE FROM capability_retry_contributions WHERE projection_version=?1",
                params![old_active_version],
            )?;
            transaction.execute(
                "DELETE FROM projection_state WHERE name=?1 AND version=?2",
                params![RETRY_PROJECTION_NAME, old_active_version],
            )?;
        }
        transaction.execute(
            "UPDATE projection_state SET status='active', watermark=?3, error_digest=NULL
             WHERE name=?1 AND version=?2 AND status='building'",
            params![RETRY_PROJECTION_NAME, version, snapshot_at_commit],
        )?;
        transaction.execute(
            "DELETE FROM retry_projection_build_cursor WHERE projection_version=?1",
            params![version],
        )?;
    } else {
        transaction.execute(
            "UPDATE projection_state SET watermark=?3
             WHERE name=?1 AND version=?2 AND status='building'",
            params![RETRY_PROJECTION_NAME, version, new_watermark],
        )?;
        transaction.execute(
            "UPDATE retry_projection_build_cursor SET last_session_key=?2
             WHERE projection_version=?1 AND base_complete=1",
            params![
                version,
                new_catchup_session_key.map(|key| key.as_bytes().to_vec())
            ],
        )?;
    }
    #[cfg(debug_assertions)]
    if caught_up {
        crate::storage::test_crash_failpoint("before-retry-projection-switch-commit");
    }
    transaction.commit()?;
    Ok(RetryProjectionProgress {
        version,
        status: if caught_up { "active" } else { "building" }.to_owned(),
        base_snapshot_seq,
        watermark: if caught_up {
            snapshot_at_commit
        } else {
            new_watermark
        },
        base_complete: true,
        processed_sessions: changes.len() as u32,
    })
}

pub fn active_retry_summaries(connection: &Connection) -> Result<Vec<RetrySummary>, StorageError> {
    let active_version = connection
        .query_row(
            "SELECT version FROM projection_state
             WHERE name=?1 AND status='active'",
            params![RETRY_PROJECTION_NAME],
            |row| row.get::<_, u32>(0),
        )
        .optional()?;
    let Some(active_version) = active_version else {
        return Ok(Vec::new());
    };
    let mut statement = connection.prepare(
        "SELECT capability_key,
                SUM(failed_count),
                SUM(same_input_repeat_count),
                SUM(retry_after_failure_count)
         FROM capability_retry_contributions
         WHERE projection_version=?1
         GROUP BY capability_key
         ORDER BY capability_key",
    )?;
    let rows = statement
        .query_map(params![active_version], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, i64>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, i64>(3)?,
            ))
        })?
        .collect::<rusqlite::Result<Vec<_>>>()?;
    rows.into_iter()
        .map(
            |(capability_key, failed_count, same_input_repeat_count, retry_after_failure_count)| {
                if capability_key.len() != 32 {
                    return Err(StorageError::new(
                        "TS_INSIGHTS_PROJECTION_CORRUPT",
                        "retry projection capability key is invalid",
                    ));
                }
                Ok(RetrySummary {
                    capability_key,
                    failed_count: checked_projection_count(failed_count)?,
                    same_input_repeat_count: checked_projection_count(same_input_repeat_count)?,
                    retry_after_failure_count: checked_projection_count(retry_after_failure_count)?,
                })
            },
        )
        .collect()
}

fn checked_projection_count(value: i64) -> Result<u64, StorageError> {
    u64::try_from(value).map_err(|_| {
        StorageError::new(
            "TS_INSIGHTS_PROJECTION_CORRUPT",
            "retry projection contains a negative aggregate count",
        )
    })
}

fn stable_key(value: &[u8]) -> Result<StableKey, StorageError> {
    let bytes: [u8; 32] = value.try_into().map_err(|_| {
        StorageError::new(
            "TS_INSIGHTS_PROJECTION_CORRUPT",
            "retry projection cursor is not a stable key",
        )
    })?;
    Ok(StableKey::from_bytes(bytes))
}

fn conversion_error(index: usize, error: StorageError) -> rusqlite::Error {
    rusqlite::Error::FromSqlConversionFailure(index, rusqlite::types::Type::Blob, Box::new(error))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::fact_projection::maintain_projection_change_log_for_test;
    use crate::projection::{CHANGE_LOG_MAX_PAYLOAD_BYTES, CHANGE_LOG_MAX_ROWS};

    const CAPABILITY_ID: i64 = 1;
    const CAPABILITY_KEY: [u8; 32] = [0x90; 32];

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
        crate::normalized_repository::initialize_schema(&mut connection).unwrap();
        connection
            .execute(
                "INSERT INTO capabilities(
                   capability_id,capability_key,provider,capability_kind,canonical_name,identity_version
                 ) VALUES (?1,?2,'codex','tool','shell',1)",
                params![CAPABILITY_ID, CAPABILITY_KEY.as_slice()],
            )
            .unwrap();
        connection
    }

    #[test]
    fn fact_commit_cancels_a_lagging_build_when_the_change_log_hits_its_cap() {
        let mut connection = connection();
        begin_retry_projection_build(&mut connection, 2, 1).unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        maintain_projection_change_log_for_test(
            &transaction,
            1,
            ChangeLogUsage {
                row_count: CHANGE_LOG_MAX_ROWS + 1,
                payload_bytes: CHANGE_LOG_MAX_PAYLOAD_BYTES + 1,
            },
        )
        .unwrap();
        transaction.commit().unwrap();

        let state: (String, Vec<u8>) = connection
            .query_row(
                "SELECT status,error_digest FROM projection_state
                 WHERE name=?1 AND version=2",
                [RETRY_PROJECTION_NAME],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .unwrap();
        assert_eq!(state.0, "failed");
        assert_eq!(state.1, CHANGE_LOG_LIMIT_ERROR_DIGEST);
        let cursor_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM retry_projection_build_cursor WHERE projection_version=2",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(cursor_count, 0);
    }

    fn session_key(byte: u8) -> [u8; 32] {
        [byte; 32]
    }

    fn set_snapshot(connection: &Connection, snapshot_seq: i64) {
        connection
            .execute(
                "UPDATE engine_metadata SET value=?1 WHERE key='snapshot_seq'",
                params![snapshot_seq.to_string()],
            )
            .unwrap();
    }

    fn insert_session(connection: &Connection, session_id: i64, key: &[u8; 32], snapshot_seq: i64) {
        connection
            .execute(
                "INSERT INTO sessions(
                   session_id,session_key,provider,session_scope,eligibility,duplicate_policy_version
                 ) VALUES (?1,?2,'codex','main','eligible',1)",
                params![session_id, key.as_slice()],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO session_commits(
                   session_id,generation,delta_id,canonical_digest,snapshot_seq
                 ) VALUES (?1,?2,?3,?4,?5)",
                params![
                    session_id,
                    (snapshot_seq as u64).to_be_bytes().to_vec(),
                    vec![session_id as u8; 32],
                    vec![(session_id as u8).wrapping_add(64); 32],
                    snapshot_seq,
                ],
            )
            .unwrap();
    }

    fn insert_turn(connection: &Connection, turn_id: i64, session_id: i64, offset: u64) {
        connection
            .execute(
                "INSERT INTO turns(
                   turn_id,turn_key,session_id,turn_start_offset,problem_text,
                   next_user_boundary,observed_eof_closed,base_provider_visibility,
                   effective_provider_visibility
                 ) VALUES (?1,?2,?3,?4,'problem',1,0,'active','active')",
                params![
                    turn_id,
                    vec![turn_id as u8; 32],
                    session_id,
                    offset.to_be_bytes().to_vec(),
                ],
            )
            .unwrap();
    }

    fn insert_use(
        connection: &Connection,
        use_id: i64,
        session_id: i64,
        turn_id: i64,
        ordinal: u64,
        input_byte: u8,
        state: &str,
    ) {
        connection
            .execute(
                "INSERT INTO capability_uses(
                   use_id,use_key,session_id,turn_id,capability_id,turn_ordinal,
                   exact_observed_name,origin_scope,input_fingerprint,
                   provider_terminal_state,strength
                 ) VALUES (?1,?2,?3,?4,?5,?6,'shell','main',?7,?8,'confirmed')",
                params![
                    use_id,
                    vec![use_id as u8; 32],
                    session_id,
                    turn_id,
                    CAPABILITY_ID,
                    ordinal.to_be_bytes().to_vec(),
                    vec![input_byte; 32],
                    state,
                ],
            )
            .unwrap();
    }

    fn append_change(connection: &Connection, snapshot_seq: i64, key: &[u8; 32], operation: &str) {
        connection
            .execute(
                "INSERT INTO projection_change_log(
                   snapshot_seq,owner_session_key,root_kind,root_key,operation
                 ) VALUES (?1,?2,'session',?2,?3)",
                params![snapshot_seq, key.as_slice(), operation],
            )
            .unwrap();
    }

    fn build_to_active(
        connection: &mut Connection,
        version: u32,
        input_fact_schema_version: u32,
        batch_size: u16,
    ) {
        begin_retry_projection_build(connection, version, input_fact_schema_version).unwrap();
        for _ in 0..64 {
            if advance_retry_projection_build(connection, version, batch_size)
                .unwrap()
                .base_complete
            {
                break;
            }
        }
        for _ in 0..64 {
            if catch_up_retry_projection(connection, version, batch_size)
                .unwrap()
                .status
                == "active"
            {
                return;
            }
        }
        panic!("retry projection did not become active");
    }

    fn seed_two_sessions(connection: &Connection) {
        let first = session_key(1);
        insert_session(connection, 1, &first, 1);
        insert_turn(connection, 10, 1, 10);
        insert_use(connection, 100, 1, 10, 1, 0x41, "failed");
        insert_use(connection, 101, 1, 10, 2, 0x41, "completed");

        let second = session_key(2);
        insert_session(connection, 2, &second, 2);
        insert_turn(connection, 20, 2, 20);
        insert_use(connection, 200, 2, 20, 1, 0x42, "completed");
        insert_use(connection, 201, 2, 20, 2, 0x42, "completed");
        set_snapshot(connection, 2);
    }

    #[test]
    fn builds_in_bounded_batches_and_resumes_without_raw_source_state() {
        let mut connection = connection();
        seed_two_sessions(&connection);
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM source_records", [], |row| {
                    row.get::<_, i64>(0)
                })
                .unwrap(),
            0
        );

        let started = begin_retry_projection_build(&mut connection, 1, 7).unwrap();
        assert!(!started.base_complete);
        let first_batch = advance_retry_projection_build(&mut connection, 1, 1).unwrap();
        assert_eq!(first_batch.processed_sessions, 1);
        assert!(!first_batch.base_complete);

        let resumed = begin_retry_projection_build(&mut connection, 1, 7).unwrap();
        assert_eq!(resumed.status, "building");
        let second_batch = advance_retry_projection_build(&mut connection, 1, 1).unwrap();
        assert_eq!(second_batch.processed_sessions, 1);
        assert!(!second_batch.base_complete);
        let final_batch = advance_retry_projection_build(&mut connection, 1, 1).unwrap();
        assert_eq!(final_batch.processed_sessions, 0);
        assert!(final_batch.base_complete);
        assert!(active_retry_summaries(&connection).unwrap().is_empty());

        let activated = catch_up_retry_projection(&mut connection, 1, 1).unwrap();
        assert_eq!(activated.status, "active");
        assert_eq!(
            active_retry_summaries(&connection).unwrap(),
            vec![RetrySummary {
                capability_key: CAPABILITY_KEY.to_vec(),
                failed_count: 1,
                same_input_repeat_count: 2,
                retry_after_failure_count: 1,
            }]
        );

        let before_rebuild = active_retry_summaries(&connection).unwrap();
        let transaction = connection
            .transaction_with_behavior(TransactionBehavior::Immediate)
            .unwrap();
        let first_key = StableKey::from_bytes(session_key(1));
        rebuild_session_contributions(&transaction, &*transaction, 1, &first_key).unwrap();
        rebuild_session_contributions(&transaction, &*transaction, 1, &first_key).unwrap();
        transaction.commit().unwrap();
        assert_eq!(active_retry_summaries(&connection).unwrap(), before_rebuild);
    }

    #[test]
    fn shadow_build_catches_same_snapshot_changes_before_atomic_activation() {
        let mut connection = connection();
        seed_two_sessions(&connection);
        build_to_active(&mut connection, 1, 7, 2);
        let old_summary = active_retry_summaries(&connection).unwrap();

        begin_retry_projection_build(&mut connection, 2, 8).unwrap();
        assert_eq!(
            advance_retry_projection_build(&mut connection, 2, 1)
                .unwrap()
                .processed_sessions,
            1
        );

        connection
            .execute(
                "UPDATE capability_uses SET provider_terminal_state='completed' WHERE use_id=100",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE session_commits SET snapshot_seq=3 WHERE session_id=1",
                [],
            )
            .unwrap();
        append_change(&connection, 3, &session_key(1), "upsert");
        let third = session_key(3);
        insert_session(&connection, 3, &third, 3);
        insert_turn(&connection, 30, 3, 30);
        insert_use(&connection, 300, 3, 30, 1, 0x43, "failed");
        append_change(&connection, 3, &third, "upsert");
        set_snapshot(&connection, 3);

        assert_eq!(
            advance_retry_projection_build(&mut connection, 2, 1)
                .unwrap()
                .processed_sessions,
            1
        );
        assert!(
            advance_retry_projection_build(&mut connection, 2, 1)
                .unwrap()
                .base_complete
        );
        assert_eq!(active_retry_summaries(&connection).unwrap(), old_summary);

        let first_catch_up = catch_up_retry_projection(&mut connection, 2, 1).unwrap();
        assert_eq!(first_catch_up.status, "building");
        assert_eq!(first_catch_up.processed_sessions, 1);
        assert_eq!(active_retry_summaries(&connection).unwrap(), old_summary);

        let activated = catch_up_retry_projection(&mut connection, 2, 1).unwrap();
        assert_eq!(activated.status, "active");
        assert_eq!(activated.processed_sessions, 1);
        assert_eq!(
            active_retry_summaries(&connection).unwrap(),
            vec![RetrySummary {
                capability_key: CAPABILITY_KEY.to_vec(),
                failed_count: 1,
                same_input_repeat_count: 2,
                retry_after_failure_count: 0,
            }]
        );
        assert_eq!(
            connection
                .query_row(
                    "SELECT COUNT(*) FROM projection_state
                     WHERE name=?1 AND status='active' AND version=2",
                    params![RETRY_PROJECTION_NAME],
                    |row| row.get::<_, i64>(0),
                )
                .unwrap(),
            1
        );
    }

    #[test]
    fn catch_up_replaces_changed_contributions_and_removes_deleted_owners() {
        let mut connection = connection();
        let first = session_key(1);
        insert_session(&connection, 1, &first, 1);
        insert_turn(&connection, 10, 1, 10);
        insert_use(&connection, 100, 1, 10, 1, 0x41, "failed");
        insert_use(&connection, 101, 1, 10, 2, 0x41, "completed");
        set_snapshot(&connection, 1);
        build_to_active(&mut connection, 1, 1, 8);

        begin_retry_projection_build(&mut connection, 2, 1).unwrap();
        while !advance_retry_projection_build(&mut connection, 2, 8)
            .unwrap()
            .base_complete
        {}
        connection
            .execute(
                "UPDATE capability_uses SET provider_terminal_state='completed' WHERE use_id=100",
                [],
            )
            .unwrap();
        connection
            .execute(
                "UPDATE session_commits SET snapshot_seq=2 WHERE session_id=1",
                [],
            )
            .unwrap();
        append_change(&connection, 2, &first, "upsert");
        set_snapshot(&connection, 2);
        assert_eq!(
            catch_up_retry_projection(&mut connection, 2, 8)
                .unwrap()
                .status,
            "active"
        );
        assert_eq!(
            active_retry_summaries(&connection).unwrap()[0].retry_after_failure_count,
            0
        );

        begin_retry_projection_build(&mut connection, 3, 1).unwrap();
        while !advance_retry_projection_build(&mut connection, 3, 8)
            .unwrap()
            .base_complete
        {}
        connection
            .execute("DELETE FROM sessions WHERE session_id=1", [])
            .unwrap();
        append_change(&connection, 3, &first, "tombstone");
        set_snapshot(&connection, 3);
        assert_eq!(
            catch_up_retry_projection(&mut connection, 3, 8)
                .unwrap()
                .status,
            "active"
        );
        assert!(active_retry_summaries(&connection).unwrap().is_empty());
    }

    #[test]
    fn failed_or_over_limit_shadow_build_keeps_the_old_active_projection() {
        let mut connection = connection();
        seed_two_sessions(&connection);
        build_to_active(&mut connection, 1, 1, 8);
        let old_summary = active_retry_summaries(&connection).unwrap();

        begin_retry_projection_build(&mut connection, 2, 9).unwrap();
        fail_retry_projection_build(&mut connection, 2, &[0x22; 32]).unwrap();
        assert_eq!(active_retry_summaries(&connection).unwrap(), old_summary);
        assert_eq!(
            connection
                .query_row(
                    "SELECT status,input_fact_schema_version FROM projection_state
                     WHERE name=?1 AND version=2",
                    params![RETRY_PROJECTION_NAME],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?)),
                )
                .unwrap(),
            ("failed".to_owned(), 9)
        );

        begin_retry_projection_build(&mut connection, 3, 11).unwrap();
        let error = catch_up_retry_projection_with_usage(
            &mut connection,
            3,
            8,
            Some(ChangeLogUsage {
                row_count: crate::projection::CHANGE_LOG_MAX_ROWS + 1,
                payload_bytes: 0,
            }),
        )
        .unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_PROJECTION_CHANGE_LOG_LIMIT");
        assert_eq!(active_retry_summaries(&connection).unwrap(), old_summary);
        assert_eq!(
            connection
                .query_row(
                    "SELECT status,input_fact_schema_version FROM projection_state
                     WHERE name=?1 AND version=3",
                    params![RETRY_PROJECTION_NAME],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?)),
                )
                .unwrap(),
            ("failed".to_owned(), 11)
        );
    }

    #[test]
    fn corrupt_negative_counts_are_rejected_instead_of_saturated() {
        let mut connection = connection();
        let first = session_key(1);
        insert_session(&connection, 1, &first, 1);
        insert_turn(&connection, 10, 1, 10);
        insert_use(&connection, 100, 1, 10, 1, 0x41, "failed");
        set_snapshot(&connection, 1);
        build_to_active(&mut connection, 1, 1, 8);

        connection
            .execute_batch("PRAGMA ignore_check_constraints=ON;")
            .unwrap();
        connection
            .execute(
                "UPDATE capability_retry_contributions SET failed_count=-1",
                [],
            )
            .unwrap();
        let error = active_retry_summaries(&connection).unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_PROJECTION_CORRUPT");
    }
}
