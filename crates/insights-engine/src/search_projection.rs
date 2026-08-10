use crate::analyzer::{
    AnalyzerDiagnostics, AnalyzerOriginScope, CapabilityInput, SEARCH_PROJECTION_VERSION,
    analyze_document, analyzer_identity,
};
use crate::fact_model::{Eligibility, OriginScope, ProviderVisibility, SessionScope, StableKey};
use crate::fact_repository::{FactEntity, FactEntityKind, FactRepository, SessionFactSnapshot};
use crate::projection::{
    ChangeLogUsage, ProjectionRootKind, ProjectionState, ProjectionStatus,
    TURN_SEARCH_PROJECTION_NAME, projection_change_log_usage, upsert_projection_state,
};
use crate::storage::StorageError;
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use std::path::{Path, PathBuf};

const ERROR_DIGEST_BYTES: usize = 32;
const CHANGE_LOG_LIMIT_ERROR_DIGEST: [u8; ERROR_DIGEST_BYTES] = [0x73; ERROR_DIGEST_BYTES];
const BUILD_FAILURE_ERROR_DIGEST: [u8; ERROR_DIGEST_BYTES] = [0x62; ERROR_DIGEST_BYTES];
const PROJECTION_SPACE_HEADROOM_BYTES: u64 = 256 * 1024 * 1024;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SearchProjectionProgress {
    pub version: u32,
    pub status: String,
    pub base_snapshot_seq: i64,
    pub watermark: i64,
    pub base_complete: bool,
    pub processed_sessions: u32,
}

pub fn initialize_search_projection_schema(connection: &Connection) -> rusqlite::Result<()> {
    connection.execute_batch(
        "CREATE TABLE IF NOT EXISTS turn_search_build_cursor (
           projection_version INTEGER PRIMARY KEY CHECK(projection_version > 0),
           base_snapshot_seq INTEGER NOT NULL CHECK(base_snapshot_seq >= 0),
           last_session_key BLOB CHECK(last_session_key IS NULL OR length(last_session_key)=32),
           base_complete INTEGER NOT NULL CHECK(base_complete IN (0,1))
         ) WITHOUT ROWID;",
    )
}

fn current_snapshot(connection: &Connection) -> Result<i64, StorageError> {
    let metadata_exists: bool = connection.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM sqlite_schema WHERE type='table' AND name='engine_metadata'
         )",
        [],
        |row| row.get(0),
    )?;
    if !metadata_exists {
        return Ok(0);
    }
    connection
        .query_row(
            "SELECT CAST(value AS INTEGER) FROM engine_metadata WHERE key='snapshot_seq'",
            [],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn projection_state(
    connection: &Connection,
    version: u32,
) -> Result<Option<(String, u32, i64, i64)>, StorageError> {
    connection
        .query_row(
            "SELECT status,input_fact_schema_version,base_snapshot_seq,watermark
             FROM projection_state WHERE name=?1 AND version=?2",
            params![TURN_SEARCH_PROJECTION_NAME, version],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .optional()
        .map_err(Into::into)
}

fn active_projection_version(connection: &Connection) -> Result<Option<u32>, StorageError> {
    connection
        .query_row(
            "SELECT version FROM projection_state WHERE name=?1 AND status='active'",
            [TURN_SEARCH_PROJECTION_NAME],
            |row| row.get(0),
        )
        .optional()
        .map_err(Into::into)
}

pub fn active_search_projection_version(
    connection: &Connection,
) -> Result<Option<u32>, StorageError> {
    active_projection_version(connection)
}

pub fn target_search_projection_status(
    connection: &Connection,
) -> Result<Option<String>, StorageError> {
    Ok(projection_state(connection, SEARCH_PROJECTION_VERSION)?.map(|state| state.0))
}

fn create_build_tables(transaction: &Transaction<'_>) -> Result<(), StorageError> {
    drop_build_tables(transaction)?;
    transaction.execute_batch(
        "CREATE TABLE turn_fts_documents_build (
           turn_id INTEGER PRIMARY KEY CHECK(turn_id > 0),
           natural_present INTEGER NOT NULL CHECK(natural_present IN (0,1)),
           code_present INTEGER NOT NULL CHECK(code_present IN (0,1)),
           capability_present INTEGER NOT NULL CHECK(capability_present IN (0,1))
         );
         CREATE TABLE turn_fts_build_owners (
           turn_id INTEGER PRIMARY KEY CHECK(turn_id > 0),
           owner_session_key BLOB NOT NULL CHECK(length(owner_session_key)=32)
         );
         CREATE INDEX turn_fts_build_owners_owner
           ON turn_fts_build_owners(owner_session_key,turn_id);
         CREATE TABLE field_stats_build (
           field TEXT PRIMARY KEY CHECK(field IN ('natural','code','capability')),
           fts_doc_count INTEGER NOT NULL CHECK(fts_doc_count >= 0)
         ) WITHOUT ROWID;
         INSERT INTO field_stats_build(field,fts_doc_count) VALUES
           ('natural',0),('code',0),('capability',0);
         CREATE VIRTUAL TABLE turns_fts_build USING fts5(
           natural,
           code,
           capability,
           content='',
           contentless_delete=1,
           columnsize=1,
           detail=full
         );
         CREATE TABLE fts_analyzer_identity_build (
           singleton INTEGER PRIMARY KEY CHECK(singleton=1),
           projection_name TEXT NOT NULL,
           projection_version INTEGER NOT NULL CHECK(projection_version > 0),
           analyzer_version TEXT NOT NULL,
           analyzer_capability TEXT NOT NULL,
           pulldown_cmark_version TEXT NOT NULL,
           unicode_normalization_version TEXT NOT NULL,
           unicode_normalization_unicode_version TEXT NOT NULL,
           rust_unicode_version TEXT NOT NULL,
           codec_version TEXT NOT NULL
         );
         CREATE TABLE turn_analyzer_diagnostics_build (
           turn_id INTEGER PRIMARY KEY CHECK(turn_id > 0),
           input_token_count INTEGER NOT NULL CHECK(input_token_count >= 0),
           token_count INTEGER NOT NULL CHECK(token_count BETWEEN 0 AND 8192),
           input_distinct_field_term_count INTEGER NOT NULL
             CHECK(input_distinct_field_term_count >= 0),
           distinct_field_term_count INTEGER NOT NULL
             CHECK(distinct_field_term_count BETWEEN 0 AND 4096),
           capability_input_count INTEGER NOT NULL CHECK(capability_input_count >= 0),
           capability_token_count INTEGER NOT NULL
             CHECK(capability_token_count BETWEEN 0 AND 256),
           token_truncated INTEGER NOT NULL CHECK(token_truncated IN (0,1)),
           distinct_truncated INTEGER NOT NULL CHECK(distinct_truncated IN (0,1)),
           capability_truncated INTEGER NOT NULL CHECK(capability_truncated IN (0,1))
         );",
    )?;
    transaction.execute(
        "INSERT INTO turns_fts_build(turns_fts_build,rank) VALUES('automerge',4)",
        [],
    )?;
    transaction.execute(
        "INSERT INTO turns_fts_build(turns_fts_build,rank) VALUES('deletemerge',10)",
        [],
    )?;
    let identity = analyzer_identity();
    transaction.execute(
        "INSERT INTO fts_analyzer_identity_build(
           singleton,projection_name,projection_version,analyzer_version,
           analyzer_capability,pulldown_cmark_version,unicode_normalization_version,
           unicode_normalization_unicode_version,rust_unicode_version,codec_version
         ) VALUES (1,?1,?2,?3,?4,?5,?6,?7,?8,?9)",
        params![
            identity.search_projection_name,
            identity.search_projection_version,
            identity.analyzer_version,
            identity.analyzer_capability,
            identity.pulldown_cmark_version,
            identity.unicode_normalization_version,
            identity.unicode_normalization_unicode_version,
            identity.rust_unicode_version,
            identity.codec_version,
        ],
    )?;
    Ok(())
}

fn drop_build_tables(connection: &Connection) -> Result<(), StorageError> {
    connection.execute_batch(
        "DROP TABLE IF EXISTS turns_fts_build;
         DROP TABLE IF EXISTS turn_fts_build_owners;
         DROP TABLE IF EXISTS turn_fts_documents_build;
         DROP TABLE IF EXISTS field_stats_build;
         DROP TABLE IF EXISTS fts_analyzer_identity_build;
         DROP TABLE IF EXISTS turn_analyzer_diagnostics_build;",
    )?;
    Ok(())
}

pub fn ensure_search_projection(
    connection: &mut Connection,
) -> Result<SearchProjectionProgress, StorageError> {
    ensure_search_projection_with_available_space(connection, None)
}

fn ensure_search_projection_with_available_space(
    connection: &mut Connection,
    available_space_override: Option<u64>,
) -> Result<SearchProjectionProgress, StorageError> {
    if let Some((status, _, base_snapshot_seq, watermark)) =
        projection_state(connection, SEARCH_PROJECTION_VERSION)?
    {
        let base_complete = match status.as_str() {
            "active" => true,
            "building" => build_cursor(connection, SEARCH_PROJECTION_VERSION)?.2,
            "failed" => {
                restart_failed_search_projection(connection, available_space_override)?;
                return ensure_search_projection_with_available_space(connection, None);
            }
            _ => {
                return Err(StorageError::new(
                    "TS_INSIGHTS_PROJECTION_CORRUPT",
                    "search projection has an unknown status",
                ));
            }
        };
        return Ok(SearchProjectionProgress {
            version: SEARCH_PROJECTION_VERSION,
            status,
            base_snapshot_seq,
            watermark,
            base_complete,
            processed_sessions: 0,
        });
    }

    let active = active_projection_version(connection)?;
    let existing_documents: bool = connection.query_row(
        "SELECT EXISTS(SELECT 1 FROM turn_fts_documents LIMIT 1)",
        [],
        |row| row.get(0),
    )?;
    let snapshot = current_snapshot(connection)?;
    if active.is_none() && !existing_documents {
        let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
        upsert_projection_state(
            &transaction,
            &ProjectionState {
                name: TURN_SEARCH_PROJECTION_NAME,
                version: SEARCH_PROJECTION_VERSION,
                input_fact_schema_version: 1,
                root_kind: ProjectionRootKind::Turn,
                base_snapshot_seq: snapshot,
                watermark: snapshot,
                status: ProjectionStatus::Active,
                error_digest: None,
            },
        )?;
        transaction.commit()?;
        return Ok(SearchProjectionProgress {
            version: SEARCH_PROJECTION_VERSION,
            status: "active".to_owned(),
            base_snapshot_seq: snapshot,
            watermark: snapshot,
            base_complete: true,
            processed_sessions: 0,
        });
    }

    ensure_projection_space(connection, available_space_override)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    if active.is_none() {
        upsert_projection_state(
            &transaction,
            &ProjectionState {
                name: TURN_SEARCH_PROJECTION_NAME,
                version: 1,
                input_fact_schema_version: 1,
                root_kind: ProjectionRootKind::Turn,
                base_snapshot_seq: 0,
                watermark: snapshot,
                status: ProjectionStatus::Active,
                error_digest: None,
            },
        )?;
    }
    create_build_tables(&transaction)?;
    upsert_projection_state(
        &transaction,
        &ProjectionState {
            name: TURN_SEARCH_PROJECTION_NAME,
            version: SEARCH_PROJECTION_VERSION,
            input_fact_schema_version: 1,
            root_kind: ProjectionRootKind::Turn,
            base_snapshot_seq: snapshot,
            watermark: snapshot,
            status: ProjectionStatus::Building,
            error_digest: None,
        },
    )?;
    transaction.execute(
        "INSERT INTO turn_search_build_cursor(
           projection_version,base_snapshot_seq,last_session_key,base_complete
         ) VALUES (?1,?2,NULL,0)",
        params![SEARCH_PROJECTION_VERSION, snapshot],
    )?;
    transaction.commit()?;
    Ok(SearchProjectionProgress {
        version: SEARCH_PROJECTION_VERSION,
        status: "building".to_owned(),
        base_snapshot_seq: snapshot,
        watermark: snapshot,
        base_complete: false,
        processed_sessions: 0,
    })
}

fn restart_failed_search_projection(
    connection: &mut Connection,
    available_space_override: Option<u64>,
) -> Result<(), StorageError> {
    ensure_projection_space(connection, available_space_override)?;
    let snapshot = current_snapshot(connection)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    drop_build_tables(&transaction)?;
    transaction.execute(
        "DELETE FROM turn_search_build_cursor WHERE projection_version=?1",
        [SEARCH_PROJECTION_VERSION],
    )?;
    create_build_tables(&transaction)?;
    upsert_projection_state(
        &transaction,
        &ProjectionState {
            name: TURN_SEARCH_PROJECTION_NAME,
            version: SEARCH_PROJECTION_VERSION,
            input_fact_schema_version: 1,
            root_kind: ProjectionRootKind::Turn,
            base_snapshot_seq: snapshot,
            watermark: snapshot,
            status: ProjectionStatus::Building,
            error_digest: None,
        },
    )?;
    transaction.execute(
        "INSERT INTO turn_search_build_cursor(
           projection_version,base_snapshot_seq,last_session_key,base_complete
         ) VALUES (?1,?2,NULL,0)",
        params![SEARCH_PROJECTION_VERSION, snapshot],
    )?;
    transaction.commit()?;
    Ok(())
}

fn ensure_projection_space(
    connection: &Connection,
    available_space_override: Option<u64>,
) -> Result<(), StorageError> {
    let Some(database_path) = main_database_path(connection)? else {
        return Ok(());
    };
    let active_bytes = database_group_bytes(&database_path)?;
    let required_bytes = active_bytes
        .saturating_mul(2)
        .saturating_add(PROJECTION_SPACE_HEADROOM_BYTES);
    let parent = database_path.parent().unwrap_or_else(|| Path::new("."));
    let available_bytes = available_space_override
        .map(Ok)
        .unwrap_or_else(|| fs2::available_space(parent))?;
    if available_bytes < required_bytes {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_SPACE_REQUIRED",
            "search projection rebuild requires more free disk space",
        ));
    }
    Ok(())
}

fn main_database_path(connection: &Connection) -> Result<Option<PathBuf>, StorageError> {
    let file = connection.query_row(
        "SELECT file FROM pragma_database_list WHERE name='main'",
        [],
        |row| row.get::<_, String>(0),
    )?;
    Ok((!file.is_empty()).then(|| PathBuf::from(file)))
}

fn database_group_bytes(database_path: &Path) -> Result<u64, StorageError> {
    ["", "-wal", "-shm"]
        .into_iter()
        .try_fold(0_u64, |total, suffix| {
            let mut path = database_path.as_os_str().to_owned();
            path.push(suffix);
            match std::fs::metadata(PathBuf::from(path)) {
                Ok(metadata) => Ok(total.saturating_add(metadata.len())),
                Err(error) if error.kind() == std::io::ErrorKind::NotFound => Ok(total),
                Err(error) => Err(StorageError::from(error)),
            }
        })
}

fn build_cursor(
    connection: &Connection,
    version: u32,
) -> Result<(i64, Option<StableKey>, bool), StorageError> {
    connection
        .query_row(
            "SELECT base_snapshot_seq,last_session_key,base_complete
             FROM turn_search_build_cursor WHERE projection_version=?1",
            [version],
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
                "search projection has no resumable build cursor",
            )
        })
}

fn turn_id(connection: &Connection, turn_key: StableKey) -> Result<i64, StorageError> {
    connection
        .query_row(
            "SELECT turn_id FROM turns WHERE turn_key=?1",
            [turn_key.as_bytes().as_slice()],
            |row| row.get(0),
        )
        .map_err(Into::into)
}

fn delete_build_owner(
    transaction: &Transaction<'_>,
    session_key: StableKey,
) -> Result<(), StorageError> {
    let documents = {
        let mut statement = transaction.prepare(
            "SELECT d.turn_id,d.natural_present,d.code_present,d.capability_present
             FROM turn_fts_documents_build d
             JOIN turn_fts_build_owners o ON o.turn_id=d.turn_id
             WHERE o.owner_session_key=?1 ORDER BY d.turn_id",
        )?;
        statement
            .query_map([session_key.as_bytes().as_slice()], |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, bool>(1)?,
                    row.get::<_, bool>(2)?,
                    row.get::<_, bool>(3)?,
                ))
            })?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    let mut removed = [0_i64; 3];
    for (turn_id, natural, code, capability) in documents {
        transaction.execute("DELETE FROM turns_fts_build WHERE rowid=?1", [turn_id])?;
        transaction.execute(
            "DELETE FROM turn_analyzer_diagnostics_build WHERE turn_id=?1",
            [turn_id],
        )?;
        removed[0] += i64::from(natural);
        removed[1] += i64::from(code);
        removed[2] += i64::from(capability);
    }
    transaction.execute(
        "DELETE FROM turn_fts_documents_build WHERE turn_id IN (
           SELECT turn_id FROM turn_fts_build_owners WHERE owner_session_key=?1
         )",
        [session_key.as_bytes().as_slice()],
    )?;
    transaction.execute(
        "DELETE FROM turn_fts_build_owners WHERE owner_session_key=?1",
        [session_key.as_bytes().as_slice()],
    )?;
    for (field, count) in ["natural", "code", "capability"].into_iter().zip(removed) {
        transaction.execute(
            "UPDATE field_stats_build SET fts_doc_count=fts_doc_count-?1 WHERE field=?2",
            params![count, field],
        )?;
    }
    Ok(())
}

fn insert_build_document(
    transaction: &Transaction<'_>,
    owner_session_key: StableKey,
    turn_id: i64,
    natural: &str,
    code: &str,
    capability: &str,
    diagnostics: &AnalyzerDiagnostics,
) -> Result<(), StorageError> {
    transaction.execute(
        "INSERT INTO turns_fts_build(rowid,natural,code,capability) VALUES (?1,?2,?3,?4)",
        params![turn_id, natural, code, capability],
    )?;
    let presence = [
        !natural.is_empty(),
        !code.is_empty(),
        !capability.is_empty(),
    ];
    transaction.execute(
        "INSERT INTO turn_fts_documents_build(
           turn_id,natural_present,code_present,capability_present
         ) VALUES (?1,?2,?3,?4)",
        params![turn_id, presence[0], presence[1], presence[2]],
    )?;
    transaction.execute(
        "INSERT INTO turn_fts_build_owners(turn_id,owner_session_key) VALUES (?1,?2)",
        params![turn_id, owner_session_key.as_bytes().as_slice()],
    )?;
    for (field, present) in ["natural", "code", "capability"].into_iter().zip(presence) {
        if present {
            transaction.execute(
                "UPDATE field_stats_build SET fts_doc_count=fts_doc_count+1 WHERE field=?1",
                [field],
            )?;
        }
    }
    transaction.execute(
        "INSERT INTO turn_analyzer_diagnostics_build(
           turn_id,input_token_count,token_count,input_distinct_field_term_count,
           distinct_field_term_count,capability_input_count,capability_token_count,
           token_truncated,distinct_truncated,capability_truncated
         ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10)",
        params![
            turn_id,
            diagnostics.input_token_count as i64,
            diagnostics.token_count as i64,
            diagnostics.input_distinct_field_term_count as i64,
            diagnostics.distinct_field_term_count as i64,
            diagnostics.capability_input_count as i64,
            diagnostics.capability_token_count as i64,
            diagnostics.token_truncated,
            diagnostics.distinct_truncated,
            diagnostics.capability_truncated,
        ],
    )?;
    Ok(())
}

fn rebuild_session_documents(
    transaction: &Transaction<'_>,
    repository: &dyn FactRepository,
    session_key: StableKey,
) -> Result<(), StorageError> {
    delete_build_owner(transaction, session_key)?;
    let Some(FactEntity::Session(facts)) =
        repository.lookup_stable_key(FactEntityKind::Session, &session_key)?
    else {
        return Ok(());
    };
    insert_session_documents(transaction, &facts)
}

fn insert_session_documents(
    transaction: &Transaction<'_>,
    facts: &SessionFactSnapshot,
) -> Result<(), StorageError> {
    if facts.session.session_scope != SessionScope::Main
        || facts.session.eligibility != Eligibility::Eligible
    {
        return Ok(());
    }
    for turn in &facts.turns {
        if turn.provider_visibility != ProviderVisibility::Active {
            continue;
        }
        let closure = facts.turn_closure(&turn.turn_key).ok_or_else(|| {
            StorageError::new(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "search projection root has no logical Fact closure",
            )
        })?;
        let capabilities = closure
            .capabilities
            .iter()
            .map(|capability| (capability.capability_key, capability))
            .collect::<std::collections::BTreeMap<_, _>>();
        let inputs = closure
            .capability_uses
            .iter()
            .map(|usage| CapabilityInput {
                origin_scope: match usage.origin_scope {
                    OriginScope::Main => AnalyzerOriginScope::Main,
                    OriginScope::Subagent => AnalyzerOriginScope::Subagent,
                    OriginScope::Unknown => AnalyzerOriginScope::Unknown,
                },
                turn_ordinal: usage.turn_ordinal,
                capability_key: usage.capability_key.as_bytes(),
                canonical_name: capabilities
                    .get(&usage.capability_key)
                    .map(|capability| capability.canonical_name.as_str()),
            })
            .collect::<Vec<_>>();
        let analyzed = analyze_document(&turn.problem_text, &inputs);
        insert_build_document(
            transaction,
            facts.session.session_key,
            turn_id(transaction, turn.turn_key)?,
            &analyzed.natural.fts_text,
            &analyzed.code.fts_text,
            &analyzed.capability.fts_text,
            &analyzed.diagnostics,
        )?;
    }
    Ok(())
}

pub fn advance_search_projection_build(
    connection: &mut Connection,
    batch_size: u16,
) -> Result<SearchProjectionProgress, StorageError> {
    bounded_batch(batch_size)?;
    let Some((status, _, base_snapshot_seq, watermark)) =
        projection_state(connection, SEARCH_PROJECTION_VERSION)?
    else {
        return Err(not_building());
    };
    if status != "building" {
        return Err(not_building());
    }
    let (_, cursor, complete) = build_cursor(connection, SEARCH_PROJECTION_VERSION)?;
    if complete {
        return Ok(SearchProjectionProgress {
            version: SEARCH_PROJECTION_VERSION,
            status,
            base_snapshot_seq,
            watermark,
            base_complete: true,
            processed_sessions: 0,
        });
    }
    let snapshot = u64::try_from(base_snapshot_seq).map_err(|_| {
        StorageError::new(
            "TS_INSIGHTS_PROJECTION_CORRUPT",
            "search projection base snapshot is negative",
        )
    })?;
    let page = FactRepository::scan_snapshot(&*connection, snapshot, cursor.as_ref(), batch_size)?;
    let processed_sessions = u32::try_from(page.sessions.len()).map_err(|_| {
        StorageError::new(
            "TS_INSIGHTS_PROJECTION_FAILED",
            "search projection batch exceeds uint32",
        )
    })?;
    let next = page.next_cursor;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    for facts in &page.sessions {
        delete_build_owner(&transaction, facts.session.session_key)?;
        insert_session_documents(&transaction, facts)?;
    }
    let base_complete = next.is_none();
    transaction.execute(
        "UPDATE turn_search_build_cursor
         SET last_session_key=?2,base_complete=?3 WHERE projection_version=?1",
        params![
            SEARCH_PROJECTION_VERSION,
            next.map(|key| key.as_bytes().to_vec()),
            i64::from(base_complete)
        ],
    )?;
    transaction.commit()?;
    Ok(SearchProjectionProgress {
        version: SEARCH_PROJECTION_VERSION,
        status,
        base_snapshot_seq,
        watermark,
        base_complete,
        processed_sessions,
    })
}

pub fn catch_up_search_projection(
    connection: &mut Connection,
    batch_size: u16,
) -> Result<SearchProjectionProgress, StorageError> {
    catch_up_search_projection_with_usage(connection, batch_size, None)
}

fn catch_up_search_projection_with_usage(
    connection: &mut Connection,
    batch_size: u16,
    usage_override: Option<ChangeLogUsage>,
) -> Result<SearchProjectionProgress, StorageError> {
    bounded_batch(batch_size)?;
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some((status, input_version, base_snapshot_seq, watermark)) =
        projection_state(&transaction, SEARCH_PROJECTION_VERSION)?
    else {
        return Err(not_building());
    };
    if status != "building" {
        return Err(not_building());
    }
    let usage = match usage_override {
        Some(usage) => usage,
        None => projection_change_log_usage(&transaction)?,
    };
    if usage.exceeds_limit() {
        mark_failed(
            &transaction,
            input_version,
            base_snapshot_seq,
            watermark,
            &CHANGE_LOG_LIMIT_ERROR_DIGEST,
        )?;
        transaction.commit()?;
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_CHANGE_LOG_LIMIT",
            "search projection change log exceeded its bounded catch-up limit",
        ));
    }
    let (_, cursor, base_complete) = build_cursor(&transaction, SEARCH_PROJECTION_VERSION)?;
    if !base_complete {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_BASE_INCOMPLETE",
            "search projection base scan is not complete",
        ));
    }
    let changes = {
        let mut statement = transaction.prepare(
            "WITH owner_changes AS (
               SELECT owner_session_key,MAX(snapshot_seq) AS latest_snapshot
               FROM projection_change_log WHERE snapshot_seq>?1 GROUP BY owner_session_key
             )
             SELECT owner_session_key,latest_snapshot FROM owner_changes
             WHERE latest_snapshot>?2 OR (latest_snapshot=?2 AND owner_session_key>?3)
             ORDER BY latest_snapshot,owner_session_key LIMIT ?4",
        )?;
        statement
            .query_map(
                params![
                    base_snapshot_seq,
                    watermark,
                    cursor.map(|key| key.as_bytes().to_vec()),
                    batch_size
                ],
                |row| {
                    let bytes = row.get::<_, Vec<u8>>(0)?;
                    Ok((
                        stable_key(&bytes).map_err(|error| conversion_error(0, error))?,
                        row.get::<_, i64>(1)?,
                    ))
                },
            )?
            .collect::<rusqlite::Result<Vec<_>>>()?
    };
    for (session_key, _) in &changes {
        rebuild_session_documents(&transaction, &*transaction, *session_key)?;
    }
    let (new_watermark, new_cursor) = changes
        .last()
        .map(|(session_key, snapshot)| (*snapshot, Some(*session_key)))
        .unwrap_or((watermark, cursor));
    let pending: bool = transaction.query_row(
        "WITH owner_changes AS (
           SELECT owner_session_key,MAX(snapshot_seq) AS latest_snapshot
           FROM projection_change_log WHERE snapshot_seq>?1 GROUP BY owner_session_key
         )
         SELECT EXISTS(
           SELECT 1 FROM owner_changes
           WHERE latest_snapshot>?2 OR (latest_snapshot=?2 AND owner_session_key>?3)
         )",
        params![
            base_snapshot_seq,
            new_watermark,
            new_cursor.map(|key| key.as_bytes().to_vec())
        ],
        |row| row.get(0),
    )?;
    let snapshot_at_commit = current_snapshot(&transaction)?;
    if !pending {
        activate_build(&transaction, snapshot_at_commit)?;
    } else {
        transaction.execute(
            "UPDATE projection_state SET watermark=?3
             WHERE name=?1 AND version=?2 AND status='building'",
            params![
                TURN_SEARCH_PROJECTION_NAME,
                SEARCH_PROJECTION_VERSION,
                new_watermark
            ],
        )?;
        transaction.execute(
            "UPDATE turn_search_build_cursor SET last_session_key=?2
             WHERE projection_version=?1 AND base_complete=1",
            params![
                SEARCH_PROJECTION_VERSION,
                new_cursor.map(|key| key.as_bytes().to_vec())
            ],
        )?;
    }
    transaction.commit()?;
    Ok(SearchProjectionProgress {
        version: SEARCH_PROJECTION_VERSION,
        status: if pending { "building" } else { "active" }.to_owned(),
        base_snapshot_seq,
        watermark: if pending {
            new_watermark
        } else {
            snapshot_at_commit
        },
        base_complete: true,
        processed_sessions: changes.len() as u32,
    })
}

fn activate_build(transaction: &Transaction<'_>, snapshot_seq: i64) -> Result<(), StorageError> {
    transaction.execute(
        "INSERT INTO turns_fts_build(turns_fts_build) VALUES('integrity-check')",
        [],
    )?;
    let dangling: bool = transaction.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM turn_fts_documents_build d
           LEFT JOIN turns t ON t.turn_id=d.turn_id WHERE t.turn_id IS NULL
           UNION ALL
           SELECT 1 FROM turn_fts_documents_build d
           LEFT JOIN turn_fts_build_owners o ON o.turn_id=d.turn_id
           WHERE o.turn_id IS NULL
           UNION ALL
           SELECT 1 FROM turn_fts_build_owners o
           LEFT JOIN turn_fts_documents_build d ON d.turn_id=o.turn_id
           WHERE d.turn_id IS NULL
         )",
        [],
        |row| row.get(0),
    )?;
    if dangling {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_CORRUPT",
            "search projection build contains an orphan Turn",
        ));
    }
    transaction.execute_batch(
        "DROP TABLE IF EXISTS turns_fts_vocab;
         DROP TABLE turns_fts;
         DROP TABLE turn_fts_documents;
         DROP TABLE field_stats;
         DROP TABLE fts_analyzer_identity;
         DROP TABLE turn_analyzer_diagnostics;
         DROP TABLE turn_fts_build_owners;
         ALTER TABLE turns_fts_build RENAME TO turns_fts;
         ALTER TABLE turn_fts_documents_build RENAME TO turn_fts_documents;
         ALTER TABLE field_stats_build RENAME TO field_stats;
         ALTER TABLE fts_analyzer_identity_build RENAME TO fts_analyzer_identity;
         ALTER TABLE turn_analyzer_diagnostics_build RENAME TO turn_analyzer_diagnostics;
         CREATE VIRTUAL TABLE turns_fts_vocab USING fts5vocab(turns_fts,'col');",
    )?;
    transaction.execute(
        "DELETE FROM projection_state
         WHERE name=?1 AND status='active' AND version<>?2",
        params![TURN_SEARCH_PROJECTION_NAME, SEARCH_PROJECTION_VERSION],
    )?;
    transaction.execute(
        "UPDATE projection_state SET status='active',watermark=?3,error_digest=NULL
         WHERE name=?1 AND version=?2 AND status='building'",
        params![
            TURN_SEARCH_PROJECTION_NAME,
            SEARCH_PROJECTION_VERSION,
            snapshot_seq
        ],
    )?;
    transaction.execute(
        "DELETE FROM turn_search_build_cursor WHERE projection_version=?1",
        [SEARCH_PROJECTION_VERSION],
    )?;
    #[cfg(debug_assertions)]
    crate::storage::test_crash_failpoint("before-search-projection-switch-commit");
    Ok(())
}

fn mark_failed(
    transaction: &Transaction<'_>,
    input_fact_schema_version: u32,
    base_snapshot_seq: i64,
    watermark: i64,
    error_digest: &[u8],
) -> Result<(), StorageError> {
    drop_build_tables(transaction)?;
    transaction.execute(
        "DELETE FROM turn_search_build_cursor WHERE projection_version=?1",
        [SEARCH_PROJECTION_VERSION],
    )?;
    upsert_projection_state(
        transaction,
        &ProjectionState {
            name: TURN_SEARCH_PROJECTION_NAME,
            version: SEARCH_PROJECTION_VERSION,
            input_fact_schema_version,
            root_kind: ProjectionRootKind::Turn,
            base_snapshot_seq,
            watermark,
            status: ProjectionStatus::Failed,
            error_digest: Some(error_digest),
        },
    )?;
    Ok(())
}

pub fn fail_search_projection_build(
    connection: &mut Connection,
    error_digest: &[u8],
) -> Result<(), StorageError> {
    if error_digest.len() != ERROR_DIGEST_BYTES {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_INVALID",
            "projection error digest must be 32 bytes",
        ));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let Some((status, input, base, watermark)) =
        projection_state(&transaction, SEARCH_PROJECTION_VERSION)?
    else {
        return Err(not_building());
    };
    if status != "building" {
        return Err(not_building());
    }
    mark_failed(&transaction, input, base, watermark, error_digest)?;
    transaction.commit()?;
    Ok(())
}

pub(crate) fn cancel_search_projection_for_change_log(
    transaction: &Transaction<'_>,
    name: &str,
    version: u32,
) -> Result<bool, StorageError> {
    if name != TURN_SEARCH_PROJECTION_NAME || version != SEARCH_PROJECTION_VERSION {
        return Ok(false);
    }
    let Some((status, input, base, watermark)) = projection_state(transaction, version)? else {
        return Ok(false);
    };
    if status != "building" {
        return Ok(false);
    }
    mark_failed(
        transaction,
        input,
        base,
        watermark,
        &CHANGE_LOG_LIMIT_ERROR_DIGEST,
    )?;
    Ok(true)
}

pub fn maintain_search_projection(
    connection: &mut Connection,
    batch_size: u16,
) -> Result<SearchProjectionProgress, StorageError> {
    bounded_batch(batch_size)?;
    let state = ensure_search_projection(connection)?;
    if state.status != "building" {
        return Ok(state);
    }
    let progress = if !state.base_complete {
        advance_search_projection_build(connection, batch_size)
    } else {
        catch_up_search_projection(connection, batch_size)
    };
    match progress {
        Ok(progress) => Ok(progress),
        Err(_) => {
            if target_search_projection_status(connection)?.as_deref() == Some("building") {
                fail_search_projection_build(connection, &BUILD_FAILURE_ERROR_DIGEST)?;
            }
            ensure_search_projection(connection)
        }
    }
}

fn bounded_batch(batch_size: u16) -> Result<(), StorageError> {
    if !(1..=256).contains(&batch_size) {
        return Err(StorageError::new(
            "TS_INSIGHTS_PROJECTION_INVALID",
            "projection batch size must be between 1 and 256",
        ));
    }
    Ok(())
}

fn not_building() -> StorageError {
    StorageError::new(
        "TS_INSIGHTS_PROJECTION_NOT_BUILDING",
        "search projection is not building",
    )
}

fn stable_key(value: &[u8]) -> Result<StableKey, StorageError> {
    let bytes: [u8; 32] = value.try_into().map_err(|_| {
        StorageError::new(
            "TS_INSIGHTS_PROJECTION_CORRUPT",
            "search projection cursor is not a stable key",
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
    use crate::fact_model::SessionFactsDeltaV1;
    use crate::query::{SearchRequest, search_with_trace};
    use serde_json::Value;
    use std::fs;
    use std::time::{SystemTime, UNIX_EPOCH};

    struct TemporaryDatabase {
        directory: PathBuf,
        path: PathBuf,
    }

    impl TemporaryDatabase {
        fn new() -> Self {
            let suffix = SystemTime::now()
                .duration_since(UNIX_EPOCH)
                .unwrap()
                .as_nanos();
            let directory = std::env::temp_dir().join(format!(
                "threadshare-search-projection-{}-{suffix}",
                std::process::id()
            ));
            fs::create_dir(&directory).unwrap();
            let path = directory.join("insights.sqlite3");
            Self { directory, path }
        }
    }

    impl Drop for TemporaryDatabase {
        fn drop(&mut self) {
            let _ = fs::remove_dir_all(&self.directory);
        }
    }

    fn fixture_delta(
        generation: u64,
        problem_text: &str,
        delta_id_byte: u8,
    ) -> SessionFactsDeltaV1 {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
        ))
        .unwrap();
        let mut value = fixture["initial"].clone();
        value["expectedGeneration"] = Value::String(generation.to_string());
        value["targetGeneration"] = Value::String((generation + 1).to_string());
        value["checkpoint"]["generation"] = Value::String((generation + 1).to_string());
        value["deltaId"] = Value::String(format!("{delta_id_byte:02x}").repeat(32));
        value["turns"][0]["problemText"] = Value::String(problem_text.to_owned());
        SessionFactsDeltaV1::try_from(value).unwrap()
    }

    fn fixture_connection() -> Connection {
        fixture_connection_from(Connection::open_in_memory().unwrap())
    }

    fn fixture_connection_from(mut connection: Connection) -> Connection {
        connection
            .execute_batch(
                "CREATE TABLE engine_metadata (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL
                 ) WITHOUT ROWID;
                 INSERT INTO engine_metadata(key,value) VALUES ('snapshot_seq','0');",
            )
            .unwrap();
        crate::normalized_repository::initialize_schema(&mut connection).unwrap();
        crate::source_state::initialize_schema(&connection).unwrap();
        crate::normalized_repository::apply_session_facts(
            &mut connection,
            &fixture_delta(0, "legacy searchable normalized facts", 0x91),
        )
        .unwrap();
        connection
    }

    fn downgrade_search_projection_to_v1(connection: &Connection) {
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
    }

    fn finish_build(connection: &mut Connection) -> SearchProjectionProgress {
        for _ in 0..8 {
            let progress = maintain_search_projection(connection, 1).unwrap();
            if progress.status == "active" {
                return progress;
            }
        }
        panic!("search projection did not activate within the bounded fixture");
    }

    fn finish_base(connection: &mut Connection) {
        for _ in 0..4 {
            if advance_search_projection_build(connection, 1)
                .unwrap()
                .base_complete
            {
                return;
            }
        }
        panic!("search projection base scan did not complete within the bounded fixture");
    }

    fn search(connection: &Connection, query: &str) -> Result<usize, crate::query::QueryError> {
        search_with_trace(
            connection,
            SearchRequest {
                query: query.to_owned(),
                now_unix_ms: 1_786_320_000_000,
                ..SearchRequest::default()
            },
        )
        .map(|(response, _)| response.results.len())
    }

    #[test]
    fn shadow_build_catches_new_facts_and_activates_a_writable_v2_schema() {
        let mut connection = fixture_connection();
        downgrade_search_projection_to_v1(&connection);

        let started = ensure_search_projection(&mut connection).unwrap();
        assert_eq!(started.status, "building");
        assert_eq!(
            active_search_projection_version(&connection).unwrap(),
            Some(1)
        );
        assert_eq!(
            search(&connection, "legacy searchable").unwrap_err().code,
            "TS_INSIGHTS_PROJECTION_BUILDING"
        );

        finish_base(&mut connection);
        crate::normalized_repository::apply_session_facts(
            &mut connection,
            &fixture_delta(1, "updated shadow catchup phrase", 0x92),
        )
        .unwrap();

        let completed = finish_build(&mut connection);
        assert_eq!(completed.status, "active");
        assert_eq!(
            active_search_projection_version(&connection).unwrap(),
            Some(2)
        );
        assert_eq!(search(&connection, "shadow catchup").unwrap(), 1);
        assert_eq!(search(&connection, "legacy searchable").unwrap(), 0);

        let columns = connection
            .prepare("SELECT name FROM pragma_table_info('turn_fts_documents') ORDER BY cid")
            .unwrap()
            .query_map([], |row| row.get::<_, String>(0))
            .unwrap()
            .collect::<rusqlite::Result<Vec<_>>>()
            .unwrap();
        assert_eq!(
            columns,
            [
                "turn_id",
                "natural_present",
                "code_present",
                "capability_present"
            ]
        );
        let owner_table: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='turn_fts_build_owners')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(!owner_table);

        crate::normalized_repository::apply_session_facts(
            &mut connection,
            &fixture_delta(2, "post activation incremental phrase", 0x93),
        )
        .unwrap();
        assert_eq!(search(&connection, "post activation").unwrap(), 1);
    }

    #[test]
    fn atomic_switch_rollback_leaves_v1_active_and_the_build_resumable() {
        let mut connection = fixture_connection();
        downgrade_search_projection_to_v1(&connection);
        ensure_search_projection(&mut connection).unwrap();
        finish_base(&mut connection);
        let canonical_documents: i64 = connection
            .query_row("SELECT COUNT(*) FROM turn_fts_documents", [], |row| {
                row.get(0)
            })
            .unwrap();

        {
            let transaction = connection
                .transaction_with_behavior(TransactionBehavior::Immediate)
                .unwrap();
            activate_build(&transaction, current_snapshot(&transaction).unwrap()).unwrap();
        }

        assert_eq!(
            active_search_projection_version(&connection).unwrap(),
            Some(1)
        );
        assert_eq!(
            connection
                .query_row("SELECT COUNT(*) FROM turn_fts_documents", [], |row| row
                    .get::<_, i64>(0))
                .unwrap(),
            canonical_documents
        );
        let build_present: bool = connection
            .query_row(
                "SELECT EXISTS(SELECT 1 FROM sqlite_schema WHERE name='turns_fts_build')",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert!(build_present);

        assert_eq!(finish_build(&mut connection).status, "active");
        assert_eq!(search(&connection, "legacy searchable").unwrap(), 1);
    }

    #[test]
    fn failed_build_restarts_from_the_current_snapshot_and_keeps_v1_active() {
        let mut connection = fixture_connection();
        downgrade_search_projection_to_v1(&connection);
        ensure_search_projection(&mut connection).unwrap();
        fail_search_projection_build(&mut connection, &[0x5a; ERROR_DIGEST_BYTES]).unwrap();

        let state = ensure_search_projection(&mut connection).unwrap();
        assert_eq!(state.status, "building");
        assert!(!state.base_complete);
        assert_eq!(
            active_search_projection_version(&connection).unwrap(),
            Some(1)
        );
        assert_eq!(
            search(&connection, "legacy searchable").unwrap_err().code,
            "TS_INSIGHTS_PROJECTION_BUILDING"
        );
        assert_eq!(finish_build(&mut connection).status, "active");
    }

    #[test]
    fn maintenance_failure_marks_only_the_shadow_failed_and_keeps_v1_active() {
        let mut connection = fixture_connection();
        downgrade_search_projection_to_v1(&connection);
        ensure_search_projection(&mut connection).unwrap();
        finish_base(&mut connection);
        connection
            .execute(
                "INSERT INTO turn_fts_documents_build(
                   turn_id,natural_present,code_present,capability_present
                 ) VALUES (999999,1,0,0)",
                [],
            )
            .unwrap();
        connection
            .execute(
                "INSERT INTO turn_fts_build_owners(turn_id,owner_session_key)
                 VALUES (999999,?1)",
                [vec![0x7f; 32]],
            )
            .unwrap();

        let state = maintain_search_projection(&mut connection, 1).unwrap();
        assert_eq!(state.status, "building");
        assert_eq!(
            active_search_projection_version(&connection).unwrap(),
            Some(1)
        );
        assert_eq!(
            search(&connection, "legacy searchable").unwrap_err().code,
            "TS_INSIGHTS_PROJECTION_BUILDING"
        );
    }

    #[test]
    fn insufficient_disk_space_preserves_v1_without_creating_shadow_tables() {
        let database = TemporaryDatabase::new();
        let mut connection = fixture_connection_from(Connection::open(&database.path).unwrap());
        downgrade_search_projection_to_v1(&connection);

        let error =
            ensure_search_projection_with_available_space(&mut connection, Some(0)).unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_PROJECTION_SPACE_REQUIRED");
        assert_eq!(
            active_search_projection_version(&connection).unwrap(),
            Some(1)
        );
        assert_eq!(target_search_projection_status(&connection).unwrap(), None);
        let build_tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name LIKE '%_build'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(build_tables, 0);
        let active_documents: i64 = connection
            .query_row("SELECT COUNT(*) FROM turn_fts_documents", [], |row| {
                row.get(0)
            })
            .unwrap();
        assert_eq!(active_documents, 1);

        assert_eq!(
            ensure_search_projection_with_available_space(&mut connection, Some(u64::MAX))
                .unwrap()
                .status,
            "building"
        );
        fail_search_projection_build(&mut connection, &[0x6b; ERROR_DIGEST_BYTES]).unwrap();
        let retry =
            ensure_search_projection_with_available_space(&mut connection, Some(0)).unwrap_err();
        assert_eq!(retry.code, "TS_INSIGHTS_PROJECTION_SPACE_REQUIRED");
        assert_eq!(
            target_search_projection_status(&connection)
                .unwrap()
                .as_deref(),
            Some("failed")
        );
        let retry_build_tables: i64 = connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_schema WHERE name LIKE '%_build'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(retry_build_tables, 0);
    }
}
