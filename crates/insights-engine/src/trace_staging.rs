use crate::delivery_graph_repository::{
    GitCommitFileRecordDelta, GitCommitRecordDelta, IntentNodeDelta, IntentRefDelta,
    IntentSourceDelta, RepositoryDelta, RepositoryRefDelta, decode_key,
    insert_candidate_intent_edges, insert_commit_changed_file_edge, insert_intent_node,
    insert_intent_ref, parse_optional_u64, parse_u64, refresh_repository_delivery_edges,
    replace_intent_source, replace_repository_project_keys, revision, validate_commit_record,
    validate_file_record, validate_ref,
};
use crate::storage::{CommitOutcome, StorageError};
use crate::{hash_key, try_canonical_json, try_write_canonical_json};
use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::io::{self, Write};

pub const TRACE_STAGING_BATCH_BYTES: usize = 4 * 1024 * 1024;
pub const MAX_TRACE_STAGING_PAYLOAD_BYTES: usize = 512 * 1024 * 1024;

const STAGING_SCHEMA: &str = r#"
CREATE TEMP TABLE IF NOT EXISTS trace_source_staging (
  collection TEXT NOT NULL,
  ordinal INTEGER NOT NULL,
  identity TEXT NOT NULL,
  normalized_json TEXT NOT NULL,
  PRIMARY KEY(collection,ordinal),
  UNIQUE(collection,identity)
) WITHOUT ROWID;
"#;

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceSourceCounts {
    pub refs: String,
    pub commits: String,
    pub files: String,
    pub intent_nodes: String,
    pub intent_refs: String,
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct TraceSourceMetadata {
    pub delta_id: String,
    pub expected_generation: String,
    pub target_generation: String,
    pub repository: RepositoryDelta,
    pub intent: Option<IntentSourceDelta>,
    pub counts: TraceSourceCounts,
}

impl TraceSourceMetadata {
    pub fn expected_count(&self, collection: &str) -> Result<usize, StorageError> {
        let value = match collection {
            "refs" => &self.counts.refs,
            "commits" => &self.counts.commits,
            "files" => &self.counts.files,
            "intentNodes" => &self.counts.intent_nodes,
            "intentRefs" => &self.counts.intent_refs,
            _ => return Err(invalid("trace source collection is invalid")),
        };
        usize::try_from(parse_u64(value)?)
            .map_err(|_| invalid("trace source count exceeds platform limits"))
    }
}

#[derive(Debug)]
pub struct StageTraceBatchOutcome {
    pub canonical_bytes: usize,
}

struct HashWriter(Sha256);

impl Write for HashWriter {
    fn write(&mut self, bytes: &[u8]) -> io::Result<usize> {
        self.0.update(bytes);
        Ok(bytes.len())
    }

    fn flush(&mut self) -> io::Result<()> {
        Ok(())
    }
}

fn invalid(message: &'static str) -> StorageError {
    StorageError::new("TS_INSIGHTS_INVALID_DELTA", message)
}

pub fn initialize(connection: &Connection) -> Result<(), StorageError> {
    connection.execute_batch(STAGING_SCHEMA)?;
    clear(connection)
}

pub fn clear(connection: &Connection) -> Result<(), StorageError> {
    connection.execute("DELETE FROM temp.trace_source_staging", [])?;
    Ok(())
}

fn normalize_item(collection: &str, value: &Value) -> Result<(String, String), StorageError> {
    match collection {
        "refs" => {
            let item: RepositoryRefDelta = serde_json::from_value(value.clone())
                .map_err(|_| invalid("trace source ref is invalid"))?;
            validate_ref(&item)?;
            let normalized =
                serde_json::to_value(&item).map_err(|_| invalid("trace source ref is invalid"))?;
            Ok((item.name, canonical(&normalized)?))
        }
        "commits" => {
            let item: GitCommitRecordDelta = serde_json::from_value(value.clone())
                .map_err(|_| invalid("trace source commit is invalid"))?;
            validate_commit_record(&item)?;
            let normalized = serde_json::to_value(&item)
                .map_err(|_| invalid("trace source commit is invalid"))?;
            Ok((item.object_id, canonical(&normalized)?))
        }
        "files" => {
            let item: GitCommitFileRecordDelta = serde_json::from_value(value.clone())
                .map_err(|_| invalid("trace source file change is invalid"))?;
            validate_file_record(&item)?;
            let identity = format!("{}\0{}", item.object_id, item.path);
            let normalized = serde_json::to_value(&item)
                .map_err(|_| invalid("trace source file change is invalid"))?;
            Ok((identity, canonical(&normalized)?))
        }
        "intentNodes" => {
            let item: IntentNodeDelta = serde_json::from_value(value.clone())
                .map_err(|_| invalid("trace intent node is invalid"))?;
            let normalized =
                serde_json::to_value(&item).map_err(|_| invalid("trace intent node is invalid"))?;
            Ok((item.id, canonical(&normalized)?))
        }
        "intentRefs" => {
            let item: IntentRefDelta = serde_json::from_value(value.clone())
                .map_err(|_| invalid("trace intent reference is invalid"))?;
            let identity = format!("{}\0{}\0{}", item.node_id, item.kind, item.value);
            let normalized = serde_json::to_value(&item)
                .map_err(|_| invalid("trace intent reference is invalid"))?;
            Ok((identity, canonical(&normalized)?))
        }
        _ => Err(invalid("trace source collection is invalid")),
    }
}

fn canonical(value: &Value) -> Result<String, StorageError> {
    try_canonical_json(value).map_err(|_| invalid("trace source item is non-canonical"))
}

pub fn stage_batch(
    connection: &mut Connection,
    collection: &str,
    first_ordinal: usize,
    items: &[Value],
) -> Result<StageTraceBatchOutcome, StorageError> {
    let transaction = connection.savepoint()?;
    let mut canonical_bytes = 0usize;
    for (offset, value) in items.iter().enumerate() {
        let (identity, normalized_json) = normalize_item(collection, value)?;
        canonical_bytes = canonical_bytes
            .checked_add(normalized_json.len())
            .ok_or_else(|| invalid("trace source batch byte count exceeds platform limits"))?;
        if canonical_bytes > TRACE_STAGING_BATCH_BYTES {
            return Err(invalid(
                "trace source batch exceeds the 4 MiB staging window",
            ));
        }
        let ordinal = first_ordinal
            .checked_add(offset)
            .and_then(|value| i64::try_from(value).ok())
            .ok_or_else(|| invalid("trace source ordinal exceeds platform limits"))?;
        let result = transaction.execute(
            "INSERT INTO temp.trace_source_staging(collection,ordinal,identity,normalized_json)
             VALUES (?1,?2,?3,?4)",
            params![collection, ordinal, identity, normalized_json],
        );
        if let Err(error) = result {
            if matches!(
                &error,
                rusqlite::Error::SqliteFailure(failure, _)
                    if failure.code == rusqlite::ffi::ErrorCode::ConstraintViolation
            ) {
                return Err(invalid("trace source contains duplicate identities"));
            }
            return Err(error.into());
        }
    }
    transaction.commit()?;
    Ok(StageTraceBatchOutcome { canonical_bytes })
}

pub fn count(connection: &Connection, collection: &str) -> Result<usize, StorageError> {
    let count: i64 = connection.query_row(
        "SELECT COUNT(*) FROM temp.trace_source_staging WHERE collection=?1",
        [collection],
        |row| row.get(0),
    )?;
    usize::try_from(count).map_err(|_| invalid("trace source count exceeds platform limits"))
}

fn write_collection(
    connection: &Connection,
    writer: &mut impl Write,
    collection: &str,
) -> Result<(), StorageError> {
    writer
        .write_all(b"[")
        .map_err(|_| invalid("trace source digest failed"))?;
    let mut statement = connection.prepare(
        "SELECT normalized_json FROM temp.trace_source_staging
         WHERE collection=?1 ORDER BY ordinal",
    )?;
    let mut rows = statement.query([collection])?;
    let mut first = true;
    while let Some(row) = rows.next()? {
        if !first {
            writer
                .write_all(b",")
                .map_err(|_| invalid("trace source digest failed"))?;
        }
        let json: String = row.get(0)?;
        writer
            .write_all(json.as_bytes())
            .map_err(|_| invalid("trace source digest failed"))?;
        first = false;
    }
    writer
        .write_all(b"]")
        .map_err(|_| invalid("trace source digest failed"))?;
    Ok(())
}

pub fn staged_digest(
    connection: &Connection,
    metadata: &TraceSourceMetadata,
) -> Result<String, StorageError> {
    let mut writer = HashWriter(Sha256::new());
    writer
        .write_all(b"{\"commits\":")
        .map_err(|_| invalid("trace source digest failed"))?;
    write_collection(connection, &mut writer, "commits")?;
    writer
        .write_all(b",\"deltaFormat\":\"threadshare-insights-trace-source-delta@v1\",\"expectedGeneration\":")
        .map_err(|_| invalid("trace source digest failed"))?;
    try_write_canonical_json(
        &mut writer,
        &Value::String(metadata.expected_generation.clone()),
    )
    .map_err(|_| invalid("trace source digest failed"))?;
    writer
        .write_all(b",\"files\":")
        .map_err(|_| invalid("trace source digest failed"))?;
    write_collection(connection, &mut writer, "files")?;
    writer
        .write_all(b",\"intent\":")
        .map_err(|_| invalid("trace source digest failed"))?;
    try_write_canonical_json(
        &mut writer,
        &serde_json::to_value(&metadata.intent)
            .map_err(|_| invalid("trace intent source is invalid"))?,
    )
    .map_err(|_| invalid("trace source digest failed"))?;
    writer
        .write_all(b",\"intentNodes\":")
        .map_err(|_| invalid("trace source digest failed"))?;
    write_collection(connection, &mut writer, "intentNodes")?;
    writer
        .write_all(b",\"intentRefs\":")
        .map_err(|_| invalid("trace source digest failed"))?;
    write_collection(connection, &mut writer, "intentRefs")?;
    writer
        .write_all(b",\"refs\":")
        .map_err(|_| invalid("trace source digest failed"))?;
    write_collection(connection, &mut writer, "refs")?;
    writer
        .write_all(b",\"repository\":")
        .map_err(|_| invalid("trace source digest failed"))?;
    let repository = serde_json::to_value(&metadata.repository)
        .map_err(|_| invalid("trace source repository is invalid"))?;
    try_write_canonical_json(&mut writer, &repository)
        .map_err(|_| invalid("trace source digest failed"))?;
    writer
        .write_all(b",\"targetGeneration\":")
        .map_err(|_| invalid("trace source digest failed"))?;
    try_write_canonical_json(
        &mut writer,
        &Value::String(metadata.target_generation.clone()),
    )
    .map_err(|_| invalid("trace source digest failed"))?;
    writer
        .write_all(b"}")
        .map_err(|_| invalid("trace source digest failed"))?;
    Ok(hex::encode(writer.0.finalize()))
}

fn for_each<T: for<'de> Deserialize<'de>>(
    transaction: &Transaction<'_>,
    collection: &str,
    mut apply: impl FnMut(T) -> Result<(), StorageError>,
) -> Result<(), StorageError> {
    let mut statement = transaction.prepare(
        "SELECT normalized_json FROM temp.trace_source_staging
         WHERE collection=?1 ORDER BY ordinal",
    )?;
    let mut rows = statement.query([collection])?;
    while let Some(row) = rows.next()? {
        let json: String = row.get(0)?;
        let item = serde_json::from_str(&json)
            .map_err(|_| invalid("staged trace source became unreadable"))?;
        apply(item)?;
    }
    Ok(())
}

pub fn apply_staged(
    connection: &mut Connection,
    metadata: &TraceSourceMetadata,
) -> Result<CommitOutcome, StorageError> {
    if staged_digest(connection, metadata)? != metadata.delta_id {
        return Err(invalid(
            "trace source deltaId does not match staged content",
        ));
    }
    let repository_key = decode_key(&metadata.repository.repository_key)?;
    let delta_id = decode_key(&metadata.delta_id)?;
    let ref_digest = decode_key(&metadata.repository.ref_digest)?;
    let expected = parse_u64(&metadata.expected_generation)?;
    let target = parse_u64(&metadata.target_generation)?;
    if target
        != expected
            .checked_add(1)
            .ok_or_else(|| invalid("trace source generation overflow"))?
    {
        return Err(invalid("trace source target generation is invalid"));
    }
    let transaction = connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
    let current = transaction
        .query_row(
            "SELECT generation,delta_id,snapshot_seq FROM repository_sources WHERE repository_id=?1",
            [&metadata.repository.repository_id],
            |row| Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Vec<u8>>(1)?, row.get::<_, i64>(2)?)),
        )
        .optional()?;
    if let Some((_, current_delta_id, snapshot_seq)) = &current
        && *current_delta_id == delta_id
    {
        return Ok(CommitOutcome {
            snapshot_seq: snapshot_seq.to_string(),
            session_key: metadata.repository.repository_key.clone(),
            delta_id: metadata.delta_id.clone(),
            idempotent: true,
        });
    }
    let current_generation = match &current {
        None => 0,
        Some((value, _, _)) => u64::from_be_bytes(value.as_slice().try_into().map_err(|_| {
            StorageError::new(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "repository generation is invalid",
            )
        })?),
    };
    if current_generation != expected {
        return Err(StorageError::new(
            "TS_INSIGHTS_STALE_GENERATION",
            "trace source generation changed",
        ));
    }
    transaction.execute(
        "INSERT INTO repository_sources(repository_id,repository_key,generation,delta_id,ref_digest,available,scm_provider,web_base_url,repository_path,snapshot_seq)
         VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,0)
         ON CONFLICT(repository_id) DO UPDATE SET repository_key=excluded.repository_key,generation=excluded.generation,delta_id=excluded.delta_id,ref_digest=excluded.ref_digest,available=excluded.available,
           scm_provider=CASE WHEN excluded.available=0 AND excluded.scm_provider IS NULL THEN repository_sources.scm_provider ELSE excluded.scm_provider END,
           web_base_url=CASE WHEN excluded.available=0 AND excluded.web_base_url IS NULL THEN repository_sources.web_base_url ELSE excluded.web_base_url END,
           repository_path=CASE WHEN excluded.available=0 AND excluded.repository_path IS NULL THEN repository_sources.repository_path ELSE excluded.repository_path END",
        params![metadata.repository.repository_id, repository_key, target.to_be_bytes().to_vec(), delta_id, ref_digest, i64::from(metadata.repository.available), metadata.repository.scm_provider, metadata.repository.web_base_url, metadata.repository.repository_path],
    )?;
    replace_repository_project_keys(&transaction, &metadata.repository)?;
    replace_intent_source(&transaction, &metadata.repository, metadata.intent.as_ref())?;
    transaction.execute(
        "DELETE FROM repository_refs WHERE repository_id=?1",
        [&metadata.repository.repository_id],
    )?;
    for_each::<RepositoryRefDelta>(&transaction, "refs", |reference| {
        transaction.execute(
            "INSERT INTO repository_refs(repository_id,ref_name,object_id) VALUES (?1,?2,?3)",
            params![
                metadata.repository.repository_id,
                reference.name,
                reference.object_id
            ],
        )?;
        Ok(())
    })?;
    for_each::<GitCommitRecordDelta>(&transaction, "commits", |commit| {
        let commit_key = hex::decode(hash_key(
            "git-commit",
            &[repository_key.clone(), commit.object_id.as_bytes().to_vec()],
        ))
        .map_err(|_| invalid("trace source commit key is invalid"))?;
        transaction.execute(
            "INSERT INTO git_commits(repository_id,object_id,commit_key,parent_object_ids_json,author_timestamp,committer_timestamp,tree_object_id,summary,reachable,revision)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,0,?9)
             ON CONFLICT(repository_id,object_id) DO UPDATE SET parent_object_ids_json=excluded.parent_object_ids_json,author_timestamp=excluded.author_timestamp,committer_timestamp=excluded.committer_timestamp,tree_object_id=excluded.tree_object_id,summary=excluded.summary,revision=excluded.revision",
            params![metadata.repository.repository_id, commit.object_id, commit_key, serde_json::to_string(&commit.parent_object_ids).map_err(|_| invalid("trace source parents are invalid"))?, commit.author_timestamp, commit.committer_timestamp, commit.tree_object_id, commit.summary, revision(&commit)?],
        )?;
        transaction.execute(
            "DELETE FROM delivery_trace_edges WHERE repository_id=?1 AND object_id=?2",
            params![metadata.repository.repository_id, commit.object_id],
        )?;
        transaction.execute(
            "DELETE FROM git_commit_files WHERE repository_id=?1 AND object_id=?2",
            params![metadata.repository.repository_id, commit.object_id],
        )?;
        Ok(())
    })?;
    for_each::<GitCommitFileRecordDelta>(&transaction, "files", |file| {
        let file_key = hex::decode(hash_key(
            "repository-file",
            &[repository_key.clone(), file.path.as_bytes().to_vec()],
        ))
        .map_err(|_| invalid("trace source file key is invalid"))?;
        transaction.execute(
            "INSERT INTO git_commit_files(repository_id,object_id,path,old_path,status,additions,deletions,file_key,revision)
             VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
            params![metadata.repository.repository_id, file.object_id, file.path, file.old_path, file.status, parse_optional_u64(&file.additions)?, parse_optional_u64(&file.deletions)?, file_key, revision(&file)?],
        )?;
        insert_commit_changed_file_edge(
            &transaction,
            &metadata.repository.repository_id,
            &repository_key,
            &file.object_id,
            &file_key,
        )?;
        Ok(())
    })?;
    for_each::<IntentNodeDelta>(&transaction, "intentNodes", |node| {
        insert_intent_node(&transaction, &metadata.repository, &node)
    })?;
    for_each::<IntentRefDelta>(&transaction, "intentRefs", |reference| {
        insert_intent_ref(&transaction, &metadata.repository, &reference)
    })?;
    insert_candidate_intent_edges(&transaction, &metadata.repository)?;
    transaction.execute(
        "UPDATE git_commits SET reachable=0 WHERE repository_id=?1",
        [&metadata.repository.repository_id],
    )?;
    transaction.execute(
        "WITH RECURSIVE reachable(object_id) AS (
           SELECT object_id FROM repository_refs WHERE repository_id=?1
           UNION
           SELECT parent.value FROM git_commits AS commit_row
           JOIN reachable ON reachable.object_id=commit_row.object_id
           JOIN json_each(commit_row.parent_object_ids_json) AS parent
           WHERE commit_row.repository_id=?1
         )
         UPDATE git_commits SET reachable=1 WHERE repository_id=?1 AND object_id IN (SELECT object_id FROM reachable)",
        [&metadata.repository.repository_id],
    )?;
    refresh_repository_delivery_edges(&transaction, &metadata.repository.repository_id)?;
    let snapshot: String = transaction.query_row(
        "SELECT value FROM engine_metadata WHERE key='snapshot_seq'",
        [],
        |row| row.get(0),
    )?;
    let snapshot_seq = parse_u64(&snapshot)?
        .checked_add(1)
        .ok_or_else(|| invalid("snapshot sequence overflow"))?;
    let snapshot_i64 =
        i64::try_from(snapshot_seq).map_err(|_| invalid("snapshot sequence overflow"))?;
    transaction.execute(
        "UPDATE engine_metadata SET value=?1 WHERE key='snapshot_seq'",
        [snapshot_seq.to_string()],
    )?;
    transaction.execute(
        "UPDATE repository_sources SET snapshot_seq=?1 WHERE repository_id=?2",
        params![snapshot_i64, metadata.repository.repository_id],
    )?;
    transaction.commit()?;
    Ok(CommitOutcome {
        snapshot_seq: snapshot_seq.to_string(),
        session_key: metadata.repository.repository_key.clone(),
        delta_id: metadata.delta_id.clone(),
        idempotent: false,
    })
}
