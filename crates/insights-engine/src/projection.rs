use crate::fts_projection::{
    FtsDocument, delete_fts_document, initialize_fts_projection_schema, upsert_fts_document,
};
use rusqlite::{Connection, Transaction, TransactionBehavior, params};

pub const PROJECTION_SCHEMA_VERSION: u32 = 1;
pub const CHANGE_LOG_MAX_ROWS: u64 = 1_000_000;
pub const CHANGE_LOG_MAX_PAYLOAD_BYTES: u64 = 64 * 1024 * 1024;
pub(crate) const ACTIVE_TURN_PROJECTION_VERSION: u32 = 1;
pub(crate) const TURN_SEARCH_PROJECTION_NAME: &str = "turn-search";
pub(crate) const TURN_SUMMARY_PROJECTION_NAME: &str = "turn-summary";

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionRootKind {
    Session,
    Turn,
    Capability,
}

impl ProjectionRootKind {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Session => "session",
            Self::Turn => "turn",
            Self::Capability => "capability",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionStatus {
    Active,
    Building,
    Failed,
}

impl ProjectionStatus {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Active => "active",
            Self::Building => "building",
            Self::Failed => "failed",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum ProjectionChangeOperation {
    Upsert,
    Tombstone,
}

impl ProjectionChangeOperation {
    pub const fn as_str(self) -> &'static str {
        match self {
            Self::Upsert => "upsert",
            Self::Tombstone => "tombstone",
        }
    }
}

#[derive(Debug, Clone, Copy)]
pub struct RollupContribution<'a> {
    pub projection_name: &'a str,
    pub projection_version: u32,
    pub dimension: &'a str,
    pub bucket_key: &'a [u8],
    pub metric: &'a str,
    pub value: i64,
    pub snapshot_seq: i64,
}

#[derive(Debug, Clone, Copy)]
pub struct TurnProjection<'a> {
    pub document: FtsDocument<'a>,
    pub rollup_contributions: &'a [RollupContribution<'a>],
}

#[derive(Debug, Clone, Copy)]
pub struct ProjectionState<'a> {
    pub name: &'a str,
    pub version: u32,
    pub input_fact_schema_version: u32,
    pub root_kind: ProjectionRootKind,
    pub base_snapshot_seq: i64,
    pub watermark: i64,
    pub status: ProjectionStatus,
    pub error_digest: Option<&'a [u8]>,
}

#[derive(Debug, Clone, Copy)]
pub struct ProjectionChange<'a> {
    pub snapshot_seq: i64,
    pub owner_session_key: &'a [u8],
    pub root_kind: ProjectionRootKind,
    pub root_key: &'a [u8],
    pub operation: ProjectionChangeOperation,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ChangeLogUsage {
    pub row_count: u64,
    pub payload_bytes: u64,
}

impl ChangeLogUsage {
    pub const fn exceeds_limit(self) -> bool {
        self.row_count > CHANGE_LOG_MAX_ROWS || self.payload_bytes > CHANGE_LOG_MAX_PAYLOAD_BYTES
    }
}

pub fn initialize_projection_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "PRAGMA secure_delete=ON;
         CREATE TABLE IF NOT EXISTS turn_rollup_contributions (
           projection_name TEXT NOT NULL CHECK(length(projection_name) BETWEEN 1 AND 128),
           projection_version INTEGER NOT NULL CHECK(projection_version > 0),
           turn_id INTEGER NOT NULL CHECK(turn_id > 0),
           dimension TEXT NOT NULL CHECK(length(dimension) BETWEEN 1 AND 128),
           bucket_key BLOB NOT NULL CHECK(length(bucket_key) = 32),
           metric TEXT NOT NULL CHECK(length(metric) BETWEEN 1 AND 128),
           value INTEGER NOT NULL,
           snapshot_seq INTEGER NOT NULL CHECK(snapshot_seq >= 0),
           PRIMARY KEY (
             projection_name,
             projection_version,
             turn_id,
             dimension,
             bucket_key,
             metric
           )
         ) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS turn_rollup_by_turn
           ON turn_rollup_contributions(turn_id);
         CREATE INDEX IF NOT EXISTS turn_rollup_lookup
           ON turn_rollup_contributions(
             projection_name,
             projection_version,
             dimension,
             bucket_key,
             metric
           );
         CREATE TABLE IF NOT EXISTS projection_state (
           name TEXT NOT NULL CHECK(length(name) BETWEEN 1 AND 128),
           version INTEGER NOT NULL CHECK(version > 0),
           input_fact_schema_version INTEGER NOT NULL CHECK(input_fact_schema_version > 0),
           root_kind TEXT NOT NULL CHECK(root_kind IN ('session', 'turn', 'capability')),
           base_snapshot_seq INTEGER NOT NULL CHECK(base_snapshot_seq >= 0),
           watermark INTEGER NOT NULL CHECK(watermark >= base_snapshot_seq),
           status TEXT NOT NULL CHECK(status IN ('active', 'building', 'failed')),
           error_digest BLOB,
           CHECK(
             (status = 'failed' AND error_digest IS NOT NULL AND length(error_digest) = 32)
             OR (status != 'failed' AND error_digest IS NULL)
           ),
           PRIMARY KEY(name, version)
         ) WITHOUT ROWID;
         CREATE UNIQUE INDEX IF NOT EXISTS projection_state_one_active
           ON projection_state(name) WHERE status='active';
         CREATE INDEX IF NOT EXISTS projection_state_build_watermark
           ON projection_state(status, watermark)
           WHERE status='building';
         CREATE TABLE IF NOT EXISTS projection_change_log (
           snapshot_seq INTEGER NOT NULL CHECK(snapshot_seq > 0),
           owner_session_key BLOB NOT NULL CHECK(length(owner_session_key) = 32),
           root_kind TEXT NOT NULL CHECK(root_kind IN ('session', 'turn', 'capability')),
           root_key BLOB NOT NULL CHECK(length(root_key) = 32),
           operation TEXT NOT NULL CHECK(operation IN ('upsert', 'tombstone')),
           PRIMARY KEY(snapshot_seq, root_kind, root_key)
         ) WITHOUT ROWID;
         CREATE INDEX IF NOT EXISTS projection_change_log_owner
           ON projection_change_log(owner_session_key, snapshot_seq);",
    )?;
    initialize_fts_projection_schema(connection)
}

pub fn with_projection_transaction<T>(
    connection: &mut Connection,
    apply: impl FnOnce(&Transaction<'_>) -> rusqlite::Result<T>,
) -> rusqlite::Result<T> {
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let result = apply(&transaction)?;
    transaction.commit()?;
    Ok(result)
}

pub fn upsert_turn_projection(
    transaction: &Transaction<'_>,
    projection: &TurnProjection<'_>,
) -> rusqlite::Result<()> {
    upsert_fts_document(transaction, &projection.document)?;
    transaction.execute(
        "DELETE FROM turn_rollup_contributions WHERE turn_id=?1",
        params![projection.document.turn_id],
    )?;
    for contribution in projection.rollup_contributions {
        transaction.execute(
            "INSERT INTO turn_rollup_contributions(
               projection_name,
               projection_version,
               turn_id,
               dimension,
               bucket_key,
               metric,
               value,
               snapshot_seq
             ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
            params![
                contribution.projection_name,
                contribution.projection_version,
                projection.document.turn_id,
                contribution.dimension,
                contribution.bucket_key,
                contribution.metric,
                contribution.value,
                contribution.snapshot_seq
            ],
        )?;
    }
    Ok(())
}

pub fn delete_turn_projection(
    transaction: &Transaction<'_>,
    turn_id: i64,
) -> rusqlite::Result<bool> {
    let fts_deleted = delete_fts_document(transaction, turn_id)?;
    let rollups_deleted = transaction.execute(
        "DELETE FROM turn_rollup_contributions WHERE turn_id=?1",
        params![turn_id],
    )?;
    Ok(fts_deleted || rollups_deleted != 0)
}

pub fn upsert_projection_state(
    transaction: &Transaction<'_>,
    state: &ProjectionState<'_>,
) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO projection_state(
           name,
           version,
           input_fact_schema_version,
           root_kind,
           base_snapshot_seq,
           watermark,
           status,
           error_digest
         ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)
         ON CONFLICT(name, version) DO UPDATE SET
           input_fact_schema_version=excluded.input_fact_schema_version,
           root_kind=excluded.root_kind,
           base_snapshot_seq=excluded.base_snapshot_seq,
           watermark=excluded.watermark,
           status=excluded.status,
           error_digest=excluded.error_digest",
        params![
            state.name,
            state.version,
            state.input_fact_schema_version,
            state.root_kind.as_str(),
            state.base_snapshot_seq,
            state.watermark,
            state.status.as_str(),
            state.error_digest
        ],
    )?;
    Ok(())
}

pub(crate) fn advance_active_turn_projection_watermarks(
    transaction: &Transaction<'_>,
    snapshot_seq: i64,
) -> rusqlite::Result<()> {
    for name in [TURN_SEARCH_PROJECTION_NAME, TURN_SUMMARY_PROJECTION_NAME] {
        upsert_projection_state(
            transaction,
            &ProjectionState {
                name,
                version: ACTIVE_TURN_PROJECTION_VERSION,
                input_fact_schema_version: 1,
                root_kind: ProjectionRootKind::Turn,
                base_snapshot_seq: 0,
                watermark: snapshot_seq,
                status: ProjectionStatus::Active,
                error_digest: None,
            },
        )?;
    }
    Ok(())
}

pub fn append_projection_change(
    transaction: &Transaction<'_>,
    change: &ProjectionChange<'_>,
) -> rusqlite::Result<()> {
    transaction.execute(
        "INSERT INTO projection_change_log(
           snapshot_seq, owner_session_key, root_kind, root_key, operation
         ) VALUES (?1, ?2, ?3, ?4, ?5)
         ON CONFLICT(snapshot_seq, root_kind, root_key) DO UPDATE SET
           owner_session_key=excluded.owner_session_key,
           operation=excluded.operation",
        params![
            change.snapshot_seq,
            change.owner_session_key,
            change.root_kind.as_str(),
            change.root_key,
            change.operation.as_str()
        ],
    )?;
    Ok(())
}

pub fn projection_change_log_usage(connection: &Connection) -> rusqlite::Result<ChangeLogUsage> {
    let (row_count, payload_bytes) = connection.query_row(
        "SELECT
           COUNT(*),
           COALESCE(SUM(
             8
             + length(owner_session_key)
             + length(root_kind)
             + length(root_key)
             + length(operation)
           ), 0)
         FROM projection_change_log",
        [],
        |row| Ok((row.get::<_, i64>(0)?, row.get::<_, i64>(1)?)),
    )?;
    Ok(ChangeLogUsage {
        row_count: u64::try_from(row_count)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, row_count))?,
        payload_bytes: u64::try_from(payload_bytes)
            .map_err(|_| rusqlite::Error::IntegralValueOutOfRange(1, payload_bytes))?,
    })
}

pub fn prune_projection_change_log_through(
    transaction: &Transaction<'_>,
    watermark: i64,
) -> rusqlite::Result<usize> {
    transaction.execute(
        "DELETE FROM projection_change_log WHERE snapshot_seq<=?1",
        params![watermark],
    )
}

pub fn prune_consumed_projection_changes(
    transaction: &Transaction<'_>,
    current_snapshot: i64,
) -> rusqlite::Result<usize> {
    let oldest_building_watermark: Option<i64> = transaction.query_row(
        "SELECT MIN(watermark) FROM projection_state WHERE status='building'",
        [],
        |row| row.get(0),
    )?;
    let retained_snapshot = oldest_building_watermark.unwrap_or(current_snapshot);
    if retained_snapshot <= 0 {
        return Ok(0);
    }
    prune_projection_change_log_through(transaction, retained_snapshot - 1)
}

#[cfg(test)]
mod tests {
    use super::{
        ProjectionChange, ProjectionChangeOperation, ProjectionRootKind, ProjectionState,
        ProjectionStatus, RollupContribution, TurnProjection, append_projection_change,
        delete_turn_projection, initialize_projection_schema, projection_change_log_usage,
        prune_consumed_projection_changes, prune_projection_change_log_through,
        upsert_projection_state, upsert_turn_projection, with_projection_transaction,
    };
    use crate::fts_projection::{Bm25Weights, FtsDocument, search_fts};
    use rusqlite::{Connection, params};

    const SESSION_KEY: [u8; 32] = [0x11; 32];
    const TURN_KEY: [u8; 32] = [0x22; 32];
    const BUCKET_KEY: [u8; 32] = [0x33; 32];

    fn connection() -> Connection {
        let connection = Connection::open_in_memory().unwrap();
        initialize_projection_schema(&connection).unwrap();
        connection
    }

    fn contribution(value: i64) -> RollupContribution<'static> {
        RollupContribution {
            projection_name: "turn-summary",
            projection_version: 1,
            dimension: "capability",
            bucket_key: &BUCKET_KEY,
            metric: "use-count",
            value,
            snapshot_seq: 1,
        }
    }

    #[test]
    fn creates_v1_rollup_state_change_log_and_field_stats_schema() {
        let connection = connection();
        let names = connection
            .prepare(
                "SELECT name FROM sqlite_master
                 WHERE name IN (
                   'turn_rollup_contributions',
                   'projection_state',
                   'projection_change_log',
                   'field_stats',
                   'turns_fts'
                 )
                 ORDER BY name",
            )
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(
            names,
            vec![
                "field_stats",
                "projection_change_log",
                "projection_state",
                "turn_rollup_contributions",
                "turns_fts",
            ]
        );
        let field_count: i64 = connection
            .query_row("SELECT COUNT(*) FROM field_stats", [], |row| row.get(0))
            .unwrap();
        assert_eq!(field_count, 3);
    }

    #[test]
    fn turn_rollup_replacement_uses_the_turn_id_index() {
        let connection = connection();
        let plan = connection
            .prepare(
                "EXPLAIN QUERY PLAN
                 DELETE FROM turn_rollup_contributions WHERE turn_id=?1",
            )
            .unwrap()
            .query_map([7_i64], |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap()
            .join("\n");
        assert!(
            plan.contains("turn_rollup_by_turn"),
            "unexpected plan: {plan}"
        );
    }

    #[test]
    fn turn_upsert_rolls_back_fts_field_stats_and_rollup_together() {
        let mut connection = connection();
        with_projection_transaction(&mut connection, |transaction| {
            upsert_turn_projection(
                transaction,
                &TurnProjection {
                    document: FtsDocument {
                        turn_id: 7,
                        natural: "alpha",
                        code: "",
                        capability: "shelltool",
                    },
                    rollup_contributions: &[contribution(1)],
                },
            )
        })
        .unwrap();

        let duplicate = [contribution(2), contribution(3)];
        let failure = with_projection_transaction(&mut connection, |transaction| {
            upsert_turn_projection(
                transaction,
                &TurnProjection {
                    document: FtsDocument {
                        turn_id: 7,
                        natural: "beta",
                        code: "",
                        capability: "shelltool",
                    },
                    rollup_contributions: &duplicate,
                },
            )
        });
        assert!(failure.is_err());

        assert_eq!(
            search_fts(&connection, "alpha", Bm25Weights::default(), 10)
                .unwrap()
                .len(),
            1
        );
        assert!(
            search_fts(&connection, "beta", Bm25Weights::default(), 10)
                .unwrap()
                .is_empty()
        );
        let rollup_value: i64 = connection
            .query_row(
                "SELECT value FROM turn_rollup_contributions WHERE turn_id=7",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rollup_value, 1);
        let natural_docs: i64 = connection
            .query_row(
                "SELECT fts_doc_count FROM field_stats WHERE field='natural'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(natural_docs, 1);
    }

    #[test]
    fn explicit_delete_removes_fts_and_rollup_in_one_transaction() {
        let mut connection = connection();
        with_projection_transaction(&mut connection, |transaction| {
            upsert_turn_projection(
                transaction,
                &TurnProjection {
                    document: FtsDocument {
                        turn_id: 9,
                        natural: "retiredtoken",
                        code: "cli_flag",
                        capability: "shelltool",
                    },
                    rollup_contributions: &[contribution(1)],
                },
            )
        })
        .unwrap();
        with_projection_transaction(&mut connection, |transaction| {
            assert!(delete_turn_projection(transaction, 9)?);
            Ok(())
        })
        .unwrap();

        assert!(
            search_fts(&connection, "retiredtoken", Bm25Weights::default(), 10)
                .unwrap()
                .is_empty()
        );
        let rollup_count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM turn_rollup_contributions WHERE turn_id=9",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(rollup_count, 0);
    }

    #[test]
    fn projection_state_and_change_log_preserve_rebuild_coordinates() {
        let mut connection = connection();
        with_projection_transaction(&mut connection, |transaction| {
            upsert_projection_state(
                transaction,
                &ProjectionState {
                    name: "turn-search",
                    version: 1,
                    input_fact_schema_version: 1,
                    root_kind: ProjectionRootKind::Turn,
                    base_snapshot_seq: 4,
                    watermark: 6,
                    status: ProjectionStatus::Building,
                    error_digest: None,
                },
            )?;
            append_projection_change(
                transaction,
                &ProjectionChange {
                    snapshot_seq: 7,
                    owner_session_key: &SESSION_KEY,
                    root_kind: ProjectionRootKind::Turn,
                    root_key: &TURN_KEY,
                    operation: ProjectionChangeOperation::Upsert,
                },
            )?;
            append_projection_change(
                transaction,
                &ProjectionChange {
                    snapshot_seq: 7,
                    owner_session_key: &SESSION_KEY,
                    root_kind: ProjectionRootKind::Turn,
                    root_key: &TURN_KEY,
                    operation: ProjectionChangeOperation::Tombstone,
                },
            )
        })
        .unwrap();

        let state = connection
            .query_row(
                "SELECT
                   input_fact_schema_version,
                   root_kind,
                   base_snapshot_seq,
                   watermark,
                   status,
                   error_digest
                 FROM projection_state WHERE name='turn-search' AND version=1",
                [],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, i64>(2)?,
                        row.get::<_, i64>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, Option<Vec<u8>>>(5)?,
                    ))
                },
            )
            .unwrap();
        assert_eq!(
            state,
            (1, "turn".to_owned(), 4, 6, "building".to_owned(), None)
        );
        let operation: String = connection
            .query_row("SELECT operation FROM projection_change_log", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(operation, "tombstone");
        let usage = projection_change_log_usage(&connection).unwrap();
        assert_eq!(usage.row_count, 1);
        assert!(!usage.exceeds_limit());

        with_projection_transaction(&mut connection, |transaction| {
            assert_eq!(prune_projection_change_log_through(transaction, 7)?, 1);
            Ok(())
        })
        .unwrap();
        assert_eq!(
            projection_change_log_usage(&connection).unwrap().row_count,
            0
        );
    }

    #[test]
    fn change_log_retains_only_snapshots_needed_by_building_projections() {
        let mut connection = connection();
        with_projection_transaction(&mut connection, |transaction| {
            upsert_projection_state(
                transaction,
                &ProjectionState {
                    name: "history-rollup",
                    version: 2,
                    input_fact_schema_version: 1,
                    root_kind: ProjectionRootKind::Session,
                    base_snapshot_seq: 3,
                    watermark: 5,
                    status: ProjectionStatus::Building,
                    error_digest: None,
                },
            )?;
            for snapshot_seq in 4..=6 {
                append_projection_change(
                    transaction,
                    &ProjectionChange {
                        snapshot_seq,
                        owner_session_key: &SESSION_KEY,
                        root_kind: ProjectionRootKind::Turn,
                        root_key: &TURN_KEY,
                        operation: ProjectionChangeOperation::Upsert,
                    },
                )?;
            }
            assert_eq!(prune_consumed_projection_changes(transaction, 6)?, 1);
            Ok(())
        })
        .unwrap();
        let snapshots = connection
            .prepare("SELECT snapshot_seq FROM projection_change_log ORDER BY snapshot_seq")
            .unwrap()
            .query_map([], |row| row.get::<_, i64>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(snapshots, vec![5, 6]);

        connection
            .execute(
                "UPDATE projection_state SET watermark=6 WHERE name='history-rollup' AND version=2",
                [],
            )
            .unwrap();
        with_projection_transaction(&mut connection, |transaction| {
            assert_eq!(prune_consumed_projection_changes(transaction, 7)?, 1);
            Ok(())
        })
        .unwrap();
        let snapshots = connection
            .prepare("SELECT snapshot_seq FROM projection_change_log ORDER BY snapshot_seq")
            .unwrap()
            .query_map([], |row| row.get::<_, i64>(0))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert_eq!(snapshots, vec![6]);
    }

    #[test]
    fn failed_state_requires_a_sha256_sized_error_digest() {
        let mut connection = connection();
        for error_digest in [None, Some(&[0x44; 31][..])] {
            let invalid = with_projection_transaction(&mut connection, |transaction| {
                upsert_projection_state(
                    transaction,
                    &ProjectionState {
                        name: "turn-search",
                        version: 2,
                        input_fact_schema_version: 1,
                        root_kind: ProjectionRootKind::Turn,
                        base_snapshot_seq: 4,
                        watermark: 4,
                        status: ProjectionStatus::Failed,
                        error_digest,
                    },
                )
            });
            assert!(invalid.is_err());
        }
        let count: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM projection_state WHERE name='turn-search'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn change_log_rejects_non_stable_keys() {
        let mut connection = connection();
        let invalid = with_projection_transaction(&mut connection, |transaction| {
            append_projection_change(
                transaction,
                &ProjectionChange {
                    snapshot_seq: 1,
                    owner_session_key: &[0x11; 31],
                    root_kind: ProjectionRootKind::Session,
                    root_key: &TURN_KEY,
                    operation: ProjectionChangeOperation::Upsert,
                },
            )
        });
        assert!(invalid.is_err());
        let count: i64 = connection
            .query_row("SELECT COUNT(*) FROM projection_change_log", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(count, 0);
    }

    #[test]
    fn at_most_one_active_version_exists_per_projection_name() {
        let mut connection = connection();
        with_projection_transaction(&mut connection, |transaction| {
            upsert_projection_state(
                transaction,
                &ProjectionState {
                    name: "turn-search",
                    version: 1,
                    input_fact_schema_version: 1,
                    root_kind: ProjectionRootKind::Turn,
                    base_snapshot_seq: 1,
                    watermark: 1,
                    status: ProjectionStatus::Active,
                    error_digest: None,
                },
            )
        })
        .unwrap();
        let duplicate_active = with_projection_transaction(&mut connection, |transaction| {
            upsert_projection_state(
                transaction,
                &ProjectionState {
                    name: "turn-search",
                    version: 2,
                    input_fact_schema_version: 1,
                    root_kind: ProjectionRootKind::Turn,
                    base_snapshot_seq: 2,
                    watermark: 2,
                    status: ProjectionStatus::Active,
                    error_digest: None,
                },
            )
        });
        assert!(duplicate_active.is_err());
        let active_version: i64 = connection
            .query_row(
                "SELECT version FROM projection_state
                 WHERE name='turn-search' AND status='active'",
                params![],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(active_version, 1);
    }
}
