//! memory-state.sqlite3: lifecycle, schema, and Stage 4a operations for the
//! Team Memory transactional database (design doc
//! `docs/team-memory-phase1-design.md` §2, §3, §8 DEV-5; proposal §5.5).
//!
//! The memory-state database is fully independent from insights.sqlite3: it is
//! a second `rusqlite::Connection` held by the engine server, lazily opened by
//! the `MEMORY_COMMAND{op:"open"}` protocol operation, configured with the same
//! pragma/WAL sequence as the Insights store, and protected with 0600
//! permissions on Unix. Wire shapes are documented in `memory_protocol.rs`.

use rusqlite::{Connection, OptionalExtension, TransactionBehavior, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::fmt;
use std::path::{Path, PathBuf};

use crate::memory_protocol::{
    AdjudicationDraftOutcome, ApprovedProjectionWire, BindRepositoryOutcome, BindRepositoryRequest,
    CandidateCountsWire, CandidateProjectionWire, CandidateStateWire, ChunkCountsWire,
    ClaimTaskOutcome, ClaimTaskRequest, MemorySearchRequest, MemoryStatusOutcome,
    MemoryStatusRequest, PlanTasksOutcome, PlanTasksRequest, PoolItemWire, RecallHitWire,
    RecallOutcome, RecallRequest, RecallSetWire, ReviewAssessmentWire, ReviewItemWire,
    ReviewQueueOutcome, ReviewQueueRequest, SearchItemWire, SearchOutcome,
    SubmitAdjudicationRequest, SubmitExtractionOutcome, SubmitExtractionRequest,
    SyncApprovedOutcome, SyncApprovedRequest, TaskCountsWire, TaskLeaseWire, TaskWire,
};
use crate::storage::persistent_file_permissions;
use crate::try_canonical_json;

/// Current memory-state schema version, stored in `memory_state_meta`.
pub const MEMORY_STATE_SCHEMA_VERSION: u32 = 1;

/// Versioned recall algorithm identifier (proposal §6.4, design §4).
pub const RECALL_ALGORITHM_VERSION: &str = "recall-rrf@1";

/// Analyzer version recorded on the candidate projection when candidate rows change.
pub const CANDIDATE_ANALYZER_VERSION: &str = "memory-extraction@1";

/// Analyzer version recorded on the approved projection (DEV-1 sync contract).
pub const APPROVED_ANALYZER_VERSION: &str = "memory-approved@1";

/// Relative database location inside the state directory (design §2).
pub const MEMORY_STATE_RELATIVE_PATH: &str = "memory/memory-state.sqlite3";

const MAX_SUMMARY_CHARS: usize = 240;
const FTS_MAX_TOKENS: usize = 32;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct MemoryError {
    pub code: &'static str,
    pub message: String,
}

impl MemoryError {
    pub fn new(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }

    pub fn invalid(message: impl Into<String>) -> Self {
        Self::new("TS_MEMORY_REQUEST_INVALID", message)
    }

    pub fn failed(message: impl Into<String>) -> Self {
        Self::new("TS_MEMORY_STATE_FAILED", message)
    }
}

impl fmt::Display for MemoryError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for MemoryError {}

impl From<rusqlite::Error> for MemoryError {
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
                "TS_MEMORY_STATE_CORRUPT",
                "the memory-state database is corrupt or is not a SQLite database",
            );
        }
        Self::failed(error.to_string())
    }
}

impl From<std::io::Error> for MemoryError {
    fn from(error: std::io::Error) -> Self {
        Self::failed(error.to_string())
    }
}

impl From<crate::storage::StorageError> for MemoryError {
    fn from(error: crate::storage::StorageError) -> Self {
        Self::failed(error.message)
    }
}

/// Schema exactly as specified by design §2 (DDL v1, rev2), with
/// `IF NOT EXISTS` added so re-opening the database is an idempotent migration.
const MEMORY_STATE_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS memory_state_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS repository_bindings (
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  public_repository_identity TEXT, root_realpath TEXT NOT NULL,
  root_realpath_digest BLOB NOT NULL,
  common_dir_device TEXT NOT NULL, common_dir_inode TEXT NOT NULL,
  memory_root TEXT NOT NULL DEFAULT '.threadshare/memory',
  status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (repository_key, worktree_key)
);
CREATE TABLE IF NOT EXISTS tasks (
  task_id TEXT PRIMARY KEY, kind TEXT NOT NULL,
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  chunk_ref TEXT, draft_batch_ref TEXT,
  binding_json TEXT NOT NULL, authorization_plan_digest BLOB,
  lease_holder TEXT, lease_epoch INTEGER NOT NULL DEFAULT 0,
  claim_token TEXT, lease_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',
  created_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS submissions (
  task_id TEXT PRIMARY KEY, response_digest BLOB NOT NULL,
  outcome_json TEXT NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS submission_conflicts (
  task_id TEXT NOT NULL, response_digest BLOB NOT NULL,
  received_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS chunks (
  chunk_ref TEXT PRIMARY KEY,
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  session_key BLOB NOT NULL, turn_range TEXT NOT NULL, chunk_digest BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',
  provenance_snapshot_seq TEXT
);
CREATE TABLE IF NOT EXISTS candidates (
  candidate_id TEXT PRIMARY KEY,
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  chunk_ref TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  content_digest BLOB NOT NULL, payload_json TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'draft',
  adjudication TEXT NOT NULL DEFAULT 'pending',
  updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE IF NOT EXISTS candidate_fts USING fts5(
  searchable_text, content='', contentless_delete=1
);
CREATE TABLE IF NOT EXISTS candidate_projection (
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  generation INTEGER NOT NULL, analyzer_version TEXT NOT NULL,
  recall_algorithm_version TEXT NOT NULL,
  PRIMARY KEY (repository_key, worktree_key)
);
CREATE TABLE IF NOT EXISTS approved_entries (
  entry_id TEXT NOT NULL, repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  revision INTEGER NOT NULL, content_digest BLOB NOT NULL,
  frontmatter_json TEXT NOT NULL, body_text TEXT NOT NULL, status TEXT NOT NULL,
  PRIMARY KEY (entry_id, repository_key, worktree_key)
);
CREATE VIRTUAL TABLE IF NOT EXISTS approved_fts USING fts5(
  searchable_text, content='', contentless_delete=1
);
CREATE TABLE IF NOT EXISTS approved_projection (
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  generation INTEGER NOT NULL, source_tree_digest BLOB NOT NULL,
  coverage TEXT NOT NULL DEFAULT 'complete',
  analyzer_version TEXT NOT NULL, recall_algorithm_version TEXT NOT NULL,
  PRIMARY KEY (repository_key, worktree_key)
);
CREATE TABLE IF NOT EXISTS runner_conformance (
  profile TEXT PRIMARY KEY, cli_version_fingerprint TEXT NOT NULL,
  test_version TEXT NOT NULL, passed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS evidence_refs (
  candidate_id TEXT NOT NULL, statement_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
  pointer_digest BLOB NOT NULL, session_key BLOB, turn_key BLOB, revision TEXT,
  payload_sha256 BLOB, relation TEXT, strength TEXT, limitations_json TEXT,
  task_id TEXT NOT NULL, PRIMARY KEY (candidate_id, statement_id, evidence_id)
);
CREATE TABLE IF NOT EXISTS assessments (
  candidate_id TEXT NOT NULL, statement_id TEXT NOT NULL,
  citations_digest BLOB NOT NULL, provenance_strength TEXT NOT NULL,
  limitations_json TEXT NOT NULL, claim_support TEXT NOT NULL,
  assessed_by TEXT NOT NULL,
  statement_text_digest BLOB NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, statement_id)
);
CREATE TABLE IF NOT EXISTS promotion_journal (
  plan_id TEXT PRIMARY KEY, repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  plan_canonical_json TEXT NOT NULL,
  plan_digest BLOB NOT NULL,
  candidate_ids_json TEXT NOT NULL, assessment_digest BLOB NOT NULL,
  policy_version TEXT NOT NULL,
  status TEXT NOT NULL DEFAULT 'generated',
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS promotion_files (
  plan_id TEXT NOT NULL, target_path TEXT NOT NULL,
  target_blob_hash TEXT,
  sanitized_content BLOB NOT NULL, sanitized_digest BLOB NOT NULL,
  applied INTEGER NOT NULL DEFAULT 0,
  PRIMARY KEY (plan_id, target_path)
);
CREATE TABLE IF NOT EXISTS authorization_log (
  plan_digest BLOB NOT NULL, task_id TEXT, runner_input_digest BLOB,
  input_coverage_digest BLOB, provider TEXT, model TEXT, endpoint TEXT,
  bytes INTEGER, decided_at INTEGER NOT NULL,
  via TEXT NOT NULL,
  manifest_digest BLOB
);
";

fn valid_memory_state_uuid(value: &str) -> bool {
    let bytes = value.as_bytes();
    bytes.len() == 36
        && bytes.iter().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => *byte == b'-',
            _ => byte.is_ascii_digit() || (b'a'..=b'f').contains(byte),
        })
        && bytes[14] == b'4'
        && matches!(bytes[19], b'8' | b'9' | b'a' | b'b')
}

fn new_memory_state_uuid(connection: &Connection) -> Result<String, MemoryError> {
    let mut bytes: Vec<u8> = connection.query_row("SELECT randomblob(16)", [], |row| row.get(0))?;
    if bytes.len() != 16 {
        return Err(MemoryError::failed(
            "SQLite did not generate a memory-state UUID",
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

fn hex_blob(value: &str) -> Result<Vec<u8>, MemoryError> {
    hex::decode(value).map_err(|_| MemoryError::invalid("value must be lowercase hex"))
}

fn canonical(value: &Value) -> Result<String, MemoryError> {
    try_canonical_json(value)
        .map_err(|_| MemoryError::invalid("value is outside the canonical JSON domain"))
}

fn canonical_digest_hex(value: &Value) -> Result<String, MemoryError> {
    Ok(hex::encode(Sha256::digest(canonical(value)?.as_bytes())))
}

fn parse_json(text: &str) -> Value {
    serde_json::from_str(text).unwrap_or(Value::Null)
}

fn summarize(text: &str) -> String {
    text.chars().take(MAX_SUMMARY_CHARS).collect()
}

fn candidate_summary(payload_json: &str) -> String {
    match parse_json(payload_json)
        .get("content")
        .and_then(Value::as_str)
    {
        Some(content) => summarize(content),
        None => String::new(),
    }
}

/// Builds a deterministic FTS5 MATCH expression from free text: unique
/// alphanumeric tokens, first 32, each quoted, joined with OR. Returns `None`
/// when the text yields no tokens.
fn fts_match_query(text: &str) -> Option<String> {
    let mut tokens: Vec<String> = Vec::new();
    for token in text.split(|character: char| !character.is_alphanumeric()) {
        if token.is_empty() {
            continue;
        }
        let token = token.to_lowercase();
        if !tokens.contains(&token) {
            tokens.push(token);
            if tokens.len() == FTS_MAX_TOKENS {
                break;
            }
        }
    }
    if tokens.is_empty() {
        return None;
    }
    Some(
        tokens
            .iter()
            .map(|token| format!("\"{token}\""))
            .collect::<Vec<_>>()
            .join(" OR "),
    )
}

struct TaskRow {
    task_id: String,
    kind: String,
    repository_key: Vec<u8>,
    worktree_key: Vec<u8>,
    chunk_ref: Option<String>,
    draft_batch_ref: Option<String>,
    binding_json: String,
    authorization_plan_digest: Option<Vec<u8>>,
    lease_holder: Option<String>,
    lease_epoch: i64,
    claim_token: Option<String>,
    lease_expires_at: Option<i64>,
    status: String,
    created_at: i64,
}

fn read_task(connection: &Connection, task_id: &str) -> Result<Option<TaskRow>, MemoryError> {
    connection
        .query_row(
            "SELECT task_id, kind, repository_key, worktree_key, chunk_ref, draft_batch_ref,
                    binding_json, authorization_plan_digest, lease_holder, lease_epoch,
                    claim_token, lease_expires_at, status, created_at
             FROM tasks WHERE task_id=?1",
            params![task_id],
            |row| {
                Ok(TaskRow {
                    task_id: row.get(0)?,
                    kind: row.get(1)?,
                    repository_key: row.get(2)?,
                    worktree_key: row.get(3)?,
                    chunk_ref: row.get(4)?,
                    draft_batch_ref: row.get(5)?,
                    binding_json: row.get(6)?,
                    authorization_plan_digest: row.get(7)?,
                    lease_holder: row.get(8)?,
                    lease_epoch: row.get(9)?,
                    claim_token: row.get(10)?,
                    lease_expires_at: row.get(11)?,
                    status: row.get(12)?,
                    created_at: row.get(13)?,
                })
            },
        )
        .optional()
        .map_err(MemoryError::from)
}

fn task_wire(task: &TaskRow) -> TaskWire {
    TaskWire {
        task_id: task.task_id.clone(),
        kind: task.kind.clone(),
        repository_key: hex::encode(&task.repository_key),
        worktree_key: hex::encode(&task.worktree_key),
        chunk_ref: task.chunk_ref.clone(),
        draft_batch_ref: task.draft_batch_ref.clone(),
        binding: parse_json(&task.binding_json),
        authorization_plan_digest: task.authorization_plan_digest.as_deref().map(hex::encode),
        status: task.status.clone(),
        created_at: task.created_at,
        lease: TaskLeaseWire {
            holder: task.lease_holder.clone().unwrap_or_default(),
            expires_at: task.lease_expires_at.unwrap_or_default(),
            epoch: task.lease_epoch,
        },
    }
}

/// What happened during the shared submit preflight.
enum SubmitGate {
    /// A previous accepted submission with the same digest: replay its outcome.
    Idempotent(Value),
    /// The submission may proceed inside the current transaction.
    Proceed,
}

/// Shared submit preflight (design §2 tx-submit): idempotent replay, digest
/// conflict audit, and claim-token CAS. Runs inside the caller's transaction.
fn submit_gate(
    connection: &Connection,
    task: &TaskRow,
    claim_token: &str,
    response_digest: &[u8],
    now_unix_ms: i64,
) -> Result<SubmitGate, MemoryError> {
    if task.claim_token.as_deref() != Some(claim_token) {
        return Err(MemoryError::new(
            "TS_MEMORY_LEASE_LOST",
            "the claim token does not match the current lease",
        ));
    }
    let existing: Option<(Vec<u8>, String)> = connection
        .query_row(
            "SELECT response_digest, outcome_json FROM submissions WHERE task_id=?1",
            params![&task.task_id],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    if let Some((stored_digest, outcome_json)) = existing {
        if stored_digest == response_digest {
            return Ok(SubmitGate::Idempotent(parse_json(&outcome_json)));
        }
        connection.execute(
            "INSERT INTO submission_conflicts(task_id, response_digest, received_at)
             VALUES (?1, ?2, ?3)",
            params![&task.task_id, response_digest, now_unix_ms],
        )?;
        return Err(MemoryError::new(
            "TS_MEMORY_SUBMISSION_CONFLICT",
            "the task already accepted a submission with a different response digest",
        ));
    }
    if task.status != "claimed" {
        return Err(MemoryError::new(
            "TS_MEMORY_LEASE_LOST",
            format!("the task is {} and cannot accept a submission", task.status),
        ));
    }
    if task
        .lease_expires_at
        .is_none_or(|expiry| expiry < now_unix_ms)
    {
        return Err(MemoryError::new(
            "TS_MEMORY_LEASE_LOST",
            "the task lease expired before the submission arrived",
        ));
    }
    Ok(SubmitGate::Proceed)
}

fn record_submission(
    connection: &Connection,
    task_id: &str,
    response_digest: &[u8],
    outcome: &Value,
    now_unix_ms: i64,
) -> Result<(), MemoryError> {
    connection.execute(
        "INSERT INTO submissions(task_id, response_digest, outcome_json, received_at)
         VALUES (?1, ?2, ?3, ?4)",
        params![task_id, response_digest, canonical(outcome)?, now_unix_ms],
    )?;
    Ok(())
}

struct RecallComputation {
    outcome: RecallOutcome,
    /// candidate-side pool revisions by candidate id, for adjudication CAS.
    candidate_pool_revisions: Vec<(String, i64)>,
}

fn read_candidate_projection(
    connection: &Connection,
    repository_key: &[u8],
    worktree_key: &[u8],
) -> Result<CandidateProjectionWire, MemoryError> {
    let row: Option<(i64, String)> = connection
        .query_row(
            "SELECT generation, analyzer_version FROM candidate_projection
             WHERE repository_key=?1 AND worktree_key=?2",
            params![repository_key, worktree_key],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .optional()?;
    let (generation, analyzer_version) = row.unwrap_or((0, CANDIDATE_ANALYZER_VERSION.to_owned()));
    Ok(CandidateProjectionWire {
        generation,
        analyzer_version,
    })
}

fn read_approved_projection(
    connection: &Connection,
    repository_key: &[u8],
    worktree_key: &[u8],
) -> Result<ApprovedProjectionWire, MemoryError> {
    let row: Option<(i64, String, String)> = connection
        .query_row(
            "SELECT generation, analyzer_version, coverage FROM approved_projection
             WHERE repository_key=?1 AND worktree_key=?2",
            params![repository_key, worktree_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let (generation, analyzer_version, coverage) = row.unwrap_or((
        0,
        APPROVED_ANALYZER_VERSION.to_owned(),
        "complete".to_owned(),
    ));
    Ok(ApprovedProjectionWire {
        generation,
        analyzer_version,
        coverage,
    })
}

struct RankedHit {
    list_rank: usize,
    source_kind: &'static str,
    id: String,
    revision: i64,
    content_digest: String,
    state: String,
    summary: String,
}

/// Runs the versioned recall (`recall-rrf@1`) against the given connection.
/// Deterministic: BM25 lists are ordered by `(bm25, id)`, RRF fusion with k=60
/// over disjoint per-source lists reduces to ordering by `(listRank,
/// sourceKind, id)`, which is exactly `score(d) = 1/(60 + rank)` descending
/// with the design's tie-break.
fn recall_on(
    connection: &Connection,
    request: &RecallRequest,
) -> Result<RecallComputation, MemoryError> {
    let repository_key = hex_blob(&request.repository_key)?;
    let worktree_key = hex_blob(&request.worktree_key)?;
    let k = usize::from(request.k);
    let fetch = 3 * k;
    let batch_ids: Vec<&str> = request
        .drafts
        .iter()
        .map(|draft| draft.candidate_id.as_str())
        .collect();

    let mut recall_sets = Vec::new();
    let mut pool: Vec<PoolItemWire> = Vec::new();
    let mut digest_entries: Vec<Value> = Vec::new();
    let mut candidate_pool_revisions: Vec<(String, i64)> = Vec::new();

    for draft in &request.drafts {
        let mut hits: Vec<RankedHit> = Vec::new();
        if let Some(match_query) = fts_match_query(&draft.query_text) {
            let mut approved = connection.prepare(
                "SELECT a.entry_id, a.revision, a.content_digest, a.status, a.body_text
                 FROM approved_fts f JOIN approved_entries a ON a.rowid = f.rowid
                 WHERE approved_fts MATCH ?1 AND a.repository_key=?2 AND a.worktree_key=?3
                 ORDER BY bm25(approved_fts), a.entry_id LIMIT ?4",
            )?;
            let rows = approved.query_map(
                params![&match_query, &repository_key, &worktree_key, fetch as i64],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )?;
            for (index, row) in rows.enumerate() {
                let (entry_id, revision, content_digest, status, body_text) = row?;
                hits.push(RankedHit {
                    list_rank: index + 1,
                    source_kind: "approved",
                    id: entry_id,
                    revision,
                    content_digest: hex::encode(content_digest),
                    state: status,
                    summary: summarize(&body_text),
                });
            }
            let mut candidate = connection.prepare(
                "SELECT c.candidate_id, c.revision, c.content_digest, c.status, c.payload_json
                 FROM candidate_fts f JOIN candidates c ON c.rowid = f.rowid
                 WHERE candidate_fts MATCH ?1 AND c.repository_key=?2 AND c.worktree_key=?3
                   AND c.status IN ('draft','quarantined')
                 ORDER BY bm25(candidate_fts), c.candidate_id LIMIT ?4",
            )?;
            let rows = candidate.query_map(
                params![
                    &match_query,
                    &repository_key,
                    &worktree_key,
                    (fetch + batch_ids.len()) as i64
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )?;
            let mut list_rank = 0usize;
            for row in rows {
                let (candidate_id, revision, content_digest, status, payload_json) = row?;
                if batch_ids.contains(&candidate_id.as_str()) {
                    continue;
                }
                list_rank += 1;
                if list_rank > fetch {
                    break;
                }
                hits.push(RankedHit {
                    list_rank,
                    source_kind: "candidate",
                    id: candidate_id,
                    revision,
                    content_digest: hex::encode(content_digest),
                    state: status,
                    summary: candidate_summary(&payload_json),
                });
            }
        }
        hits.sort_by(|left, right| {
            left.list_rank
                .cmp(&right.list_rank)
                .then_with(|| left.source_kind.cmp(right.source_kind))
                .then_with(|| left.id.cmp(&right.id))
        });
        hits.truncate(k);

        let mut ordered = Vec::new();
        for (index, hit) in hits.iter().enumerate() {
            let rank = (index + 1) as u32;
            ordered.push(RecallHitWire {
                rank,
                source_kind: hit.source_kind.to_owned(),
                id: hit.id.clone(),
            });
            digest_entries.push(serde_json::json!({
                "draftRef": draft.draft_ref,
                "rank": rank,
                "sourceKind": hit.source_kind,
                "id": hit.id,
                "revision": hit.revision,
                "contentDigest": hit.content_digest,
                "state": hit.state,
            }));
            if !pool
                .iter()
                .any(|item| item.source_kind == hit.source_kind && item.id == hit.id)
            {
                if hit.source_kind == "candidate" {
                    candidate_pool_revisions.push((hit.id.clone(), hit.revision));
                }
                pool.push(PoolItemWire {
                    source_kind: hit.source_kind.to_owned(),
                    id: hit.id.clone(),
                    revision: hit.revision,
                    content_digest: hit.content_digest.clone(),
                    state: hit.state.clone(),
                    summary: hit.summary.clone(),
                });
            }
        }
        recall_sets.push(RecallSetWire {
            draft_ref: draft.draft_ref.clone(),
            ordered,
        });
    }
    pool.sort_by(|left, right| {
        left.source_kind
            .cmp(&right.source_kind)
            .then_with(|| left.id.cmp(&right.id))
    });

    let query_document = serde_json::json!({
        "algorithm": RECALL_ALGORITHM_VERSION,
        "k": request.k,
        "owner": {
            "repositoryKey": request.repository_key,
            "worktreeKey": request.worktree_key,
        },
        "drafts": request
            .drafts
            .iter()
            .map(|draft| serde_json::json!({
                "draftRef": draft.draft_ref,
                "candidateId": draft.candidate_id,
                "queryText": draft.query_text,
            }))
            .collect::<Vec<_>>(),
    });
    let outcome = RecallOutcome {
        recall_algorithm_version: RECALL_ALGORITHM_VERSION.to_owned(),
        k: request.k,
        approved_projection: read_approved_projection(connection, &repository_key, &worktree_key)?,
        candidate_projection: read_candidate_projection(
            connection,
            &repository_key,
            &worktree_key,
        )?,
        recall_query_digest: canonical_digest_hex(&query_document)?,
        result_set_digest: canonical_digest_hex(&Value::Array(digest_entries))?,
        recall_sets,
        pool,
    };
    Ok(RecallComputation {
        outcome,
        candidate_pool_revisions,
    })
}

fn bump_candidate_generation(
    connection: &Connection,
    repository_key: &[u8],
    worktree_key: &[u8],
) -> Result<i64, MemoryError> {
    connection.execute(
        "INSERT INTO candidate_projection(
           repository_key, worktree_key, generation, analyzer_version, recall_algorithm_version)
         VALUES (?1, ?2, 1, ?3, ?4)
         ON CONFLICT(repository_key, worktree_key) DO UPDATE SET
           generation = generation + 1,
           analyzer_version = excluded.analyzer_version,
           recall_algorithm_version = excluded.recall_algorithm_version",
        params![
            repository_key,
            worktree_key,
            CANDIDATE_ANALYZER_VERSION,
            RECALL_ALGORITHM_VERSION
        ],
    )?;
    let generation = connection.query_row(
        "SELECT generation FROM candidate_projection WHERE repository_key=?1 AND worktree_key=?2",
        params![repository_key, worktree_key],
        |row| row.get(0),
    )?;
    Ok(generation)
}

/// The lazily opened second connection held by `EngineServer` (design §8 DEV-5).
pub struct MemoryStorage {
    connection: Connection,
    database_path: Option<PathBuf>,
    state_dir: Option<PathBuf>,
}

impl MemoryStorage {
    /// Open (or create) the memory-state database below `state_dir`
    /// (`<state-dir>/memory/memory-state.sqlite3`, 0600 on Unix).
    pub fn open_state_dir(state_dir: &Path) -> Result<Self, MemoryError> {
        let database_path = state_dir.join(MEMORY_STATE_RELATIVE_PATH);
        if let Some(parent) = database_path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let mut storage = Self::open(&database_path)?;
        storage.state_dir = Some(state_dir.to_path_buf());
        Ok(storage)
    }

    /// Open (or create) the memory-state database at the exact file path.
    pub fn open(path: &Path) -> Result<Self, MemoryError> {
        persistent_file_permissions::prepare(path)?;
        let connection = Connection::open(path)?;
        let storage = Self::configure(connection, Some(path.to_path_buf()))?;
        persistent_file_permissions::enforce(path)?;
        Ok(storage)
    }

    /// In-memory database for tests.
    pub fn open_in_memory() -> Result<Self, MemoryError> {
        let connection = Connection::open_in_memory()?;
        Self::configure(connection, None)
    }

    fn configure(
        connection: Connection,
        database_path: Option<PathBuf>,
    ) -> Result<Self, MemoryError> {
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
            return Err(MemoryError::failed("SQLite did not enable secure_delete"));
        }
        if database_path.is_some() {
            let journal_mode: String =
                connection.query_row("PRAGMA journal_mode=WAL", [], |row| row.get(0))?;
            if !journal_mode.eq_ignore_ascii_case("wal") {
                return Err(MemoryError::failed("SQLite did not enable WAL mode"));
            }
            connection.execute_batch("PRAGMA wal_autocheckpoint=0;")?;
        }
        connection.execute_batch(MEMORY_STATE_SCHEMA)?;
        let candidate = new_memory_state_uuid(&connection)?;
        connection.execute(
            "INSERT OR IGNORE INTO memory_state_meta(key, value) VALUES ('memoryStateUuid', ?1)",
            [candidate],
        )?;
        connection.execute(
            "INSERT OR IGNORE INTO memory_state_meta(key, value) VALUES ('schema_version', ?1)",
            [MEMORY_STATE_SCHEMA_VERSION.to_string()],
        )?;
        let storage = Self {
            connection,
            database_path,
            state_dir: None,
        };
        let version = storage.schema_version()?;
        if version != MEMORY_STATE_SCHEMA_VERSION {
            return Err(MemoryError::new(
                "TS_MEMORY_STATE_CORRUPT",
                format!("unsupported memory-state schema version {version}"),
            ));
        }
        storage.memory_state_uuid()?;
        Ok(storage)
    }

    pub fn memory_state_uuid(&self) -> Result<String, MemoryError> {
        let value: String = self.connection.query_row(
            "SELECT value FROM memory_state_meta WHERE key='memoryStateUuid'",
            [],
            |row| row.get(0),
        )?;
        if !valid_memory_state_uuid(&value) {
            return Err(MemoryError::new(
                "TS_MEMORY_STATE_CORRUPT",
                "the memory-state UUID is invalid",
            ));
        }
        Ok(value)
    }

    pub fn schema_version(&self) -> Result<u32, MemoryError> {
        let value: String = self.connection.query_row(
            "SELECT value FROM memory_state_meta WHERE key='schema_version'",
            [],
            |row| row.get(0),
        )?;
        value.parse().map_err(|_| {
            MemoryError::new(
                "TS_MEMORY_STATE_CORRUPT",
                "the memory-state schema version is invalid",
            )
        })
    }

    pub fn database_path(&self) -> Option<&Path> {
        self.database_path.as_deref()
    }

    pub fn state_dir(&self) -> Option<&Path> {
        self.state_dir.as_deref()
    }
}

impl MemoryStorage {
    /// `bind-repository`: upsert into `repository_bindings`. The absolute
    /// `rootRealpath` enters the database only and is never echoed back.
    pub fn bind_repository(
        &mut self,
        request: &BindRepositoryRequest,
    ) -> Result<BindRepositoryOutcome, MemoryError> {
        let repository_key = hex_blob(&request.repository_key)?;
        let worktree_key = hex_blob(&request.worktree_key)?;
        let root_realpath_digest = hex_blob(&request.root_realpath_digest)?;
        self.connection.execute(
            "INSERT INTO repository_bindings(
               repository_key, worktree_key, public_repository_identity, root_realpath,
               root_realpath_digest, common_dir_device, common_dir_inode, memory_root, status)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)
             ON CONFLICT(repository_key, worktree_key) DO UPDATE SET
               public_repository_identity = excluded.public_repository_identity,
               root_realpath = excluded.root_realpath,
               root_realpath_digest = excluded.root_realpath_digest,
               common_dir_device = excluded.common_dir_device,
               common_dir_inode = excluded.common_dir_inode,
               memory_root = excluded.memory_root,
               status = excluded.status",
            params![
                repository_key,
                worktree_key,
                request.public_repository_identity,
                request.root_realpath,
                root_realpath_digest,
                request.common_dir_device,
                request.common_dir_inode,
                request.memory_root,
                request.status,
            ],
        )?;
        Ok(BindRepositoryOutcome {
            repository_key: request.repository_key.clone(),
            worktree_key: request.worktree_key.clone(),
            public_repository_identity: request.public_repository_identity.clone(),
            memory_root: request.memory_root.clone(),
            status: request.status.clone(),
        })
    }

    /// `plan-tasks`: batch-inserts pending chunks and tasks, skipping rows
    /// whose `chunk_ref` / `task_id` already exist (idempotent).
    pub fn plan_tasks(
        &mut self,
        request: &PlanTasksRequest,
        now_unix_ms: i64,
    ) -> Result<PlanTasksOutcome, MemoryError> {
        let repository_key = hex_blob(&request.repository_key)?;
        let worktree_key = hex_blob(&request.worktree_key)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut inserted_chunks = 0usize;
        for chunk in &request.chunks {
            let changed = transaction.execute(
                "INSERT OR IGNORE INTO chunks(
                   chunk_ref, repository_key, worktree_key, session_key, turn_range,
                   chunk_digest, status, provenance_snapshot_seq)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 'pending', ?7)",
                params![
                    chunk.chunk_ref,
                    repository_key,
                    worktree_key,
                    hex_blob(&chunk.session_key)?,
                    chunk.turn_range,
                    hex_blob(&chunk.chunk_digest)?,
                    chunk.provenance_snapshot_seq,
                ],
            )?;
            inserted_chunks += changed;
        }
        let mut inserted_tasks = 0usize;
        for task in &request.tasks {
            let authorization_plan_digest = task
                .authorization_plan_digest
                .as_deref()
                .map(hex_blob)
                .transpose()?;
            let changed = transaction.execute(
                "INSERT OR IGNORE INTO tasks(
                   task_id, kind, repository_key, worktree_key, chunk_ref, draft_batch_ref,
                   binding_json, authorization_plan_digest, status, created_at)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'pending', ?9)",
                params![
                    task.task_id,
                    task.kind,
                    repository_key,
                    worktree_key,
                    task.chunk_ref,
                    task.draft_batch_ref,
                    canonical(&task.binding)?,
                    authorization_plan_digest,
                    now_unix_ms,
                ],
            )?;
            inserted_tasks += changed;
        }
        transaction.commit()?;
        Ok(PlanTasksOutcome {
            inserted_chunks,
            skipped_chunks: request.chunks.len() - inserted_chunks,
            inserted_tasks,
            skipped_tasks: request.tasks.len() - inserted_tasks,
        })
    }

    /// `claim-task` (design §2 tx-claim): claimable iff `pending`, or
    /// `claimed` with an expired lease; `submitted`/`stale` are never
    /// re-claimable. Bumps `lease_epoch` and issues a fresh random claim token.
    pub fn claim_task(
        &mut self,
        request: &ClaimTaskRequest,
        now_unix_ms: i64,
    ) -> Result<ClaimTaskOutcome, MemoryError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        if read_task(&transaction, &request.task_id)?.is_none() {
            return Err(MemoryError::new(
                "TS_MEMORY_TASK_NOT_FOUND",
                "the task does not exist",
            ));
        }
        let claim_token: String =
            transaction.query_row("SELECT lower(hex(randomblob(16)))", [], |row| row.get(0))?;
        let expires_at = now_unix_ms.saturating_add(request.lease_ms);
        let changed = transaction.execute(
            "UPDATE tasks SET status='claimed', lease_holder=?1,
               lease_epoch=lease_epoch+1, claim_token=?2, lease_expires_at=?3
             WHERE task_id=?4 AND (status='pending'
               OR (status='claimed' AND lease_expires_at < ?5))",
            params![
                request.lease_holder,
                claim_token,
                expires_at,
                request.task_id,
                now_unix_ms
            ],
        )?;
        if changed == 0 {
            return Err(MemoryError::new(
                "TS_MEMORY_TASK_NOT_CLAIMABLE",
                "the task is not pending and its lease has not expired",
            ));
        }
        let task = read_task(&transaction, &request.task_id)?.ok_or_else(|| {
            MemoryError::failed("the claimed task disappeared inside the transaction")
        })?;
        transaction.commit()?;
        Ok(ClaimTaskOutcome {
            task: task_wire(&task),
            claim_token,
        })
    }

    /// `submit-extraction` (design §2 tx-extraction-submit), single transaction.
    /// Returns the wire outcome value; idempotent replays return the stored
    /// outcome with `"idempotent": true`.
    pub fn submit_extraction(
        &mut self,
        request: &SubmitExtractionRequest,
        now_unix_ms: i64,
    ) -> Result<Value, MemoryError> {
        let response_digest = hex_blob(&request.response_digest)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task = read_task(&transaction, &request.task_id)?.ok_or_else(|| {
            MemoryError::new("TS_MEMORY_TASK_NOT_FOUND", "the task does not exist")
        })?;
        if task.kind != "extraction" {
            return Err(MemoryError::invalid("the task is not an extraction task"));
        }
        let chunk_ref = task.chunk_ref.clone().ok_or_else(|| {
            MemoryError::invalid("the extraction task does not reference a chunk")
        })?;
        match submit_gate(
            &transaction,
            &task,
            &request.claim_token,
            &response_digest,
            now_unix_ms,
        ) {
            Ok(SubmitGate::Idempotent(mut outcome)) => {
                transaction.commit()?;
                outcome["idempotent"] = Value::Bool(true);
                return Ok(outcome);
            }
            Ok(SubmitGate::Proceed) => {}
            Err(error) => {
                if error.code == "TS_MEMORY_SUBMISSION_CONFLICT" {
                    transaction.commit()?;
                }
                return Err(error);
            }
        }
        let mut candidates = Vec::new();
        for draft in &request.drafts {
            let payload_json = canonical(&draft.payload)?;
            let content_digest = Sha256::digest(payload_json.as_bytes()).to_vec();
            let changed = transaction.execute(
                "INSERT OR IGNORE INTO candidates(
                   candidate_id, repository_key, worktree_key, chunk_ref, revision,
                   content_digest, payload_json, status, adjudication, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, 'draft', 'pending', ?7)",
                params![
                    draft.candidate_id,
                    task.repository_key,
                    task.worktree_key,
                    chunk_ref,
                    content_digest,
                    payload_json,
                    now_unix_ms,
                ],
            )?;
            if changed == 0 {
                return Err(MemoryError::invalid(format!(
                    "candidate {} already exists",
                    draft.candidate_id
                )));
            }
            let rowid = transaction.last_insert_rowid();
            transaction.execute(
                "INSERT INTO candidate_fts(rowid, searchable_text) VALUES (?1, ?2)",
                params![rowid, draft.searchable_text],
            )?;
            candidates.push(CandidateStateWire {
                candidate_id: draft.candidate_id.clone(),
                revision: 1,
                content_digest: hex::encode(content_digest),
                status: "draft".to_owned(),
            });
        }
        for reference in &request.evidence_refs {
            let limitations_json = reference
                .limitations
                .as_ref()
                .map(|values| canonical(&serde_json::json!(values)))
                .transpose()?;
            transaction.execute(
                "INSERT INTO evidence_refs(
                   candidate_id, statement_id, evidence_id, pointer_digest, session_key,
                   turn_key, revision, payload_sha256, relation, strength, limitations_json,
                   task_id)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    reference.candidate_id,
                    reference.statement_id,
                    reference.evidence_id,
                    hex_blob(&reference.pointer_digest)?,
                    reference.session_key.as_deref().map(hex_blob).transpose()?,
                    reference.turn_key.as_deref().map(hex_blob).transpose()?,
                    reference.revision,
                    reference
                        .payload_sha256
                        .as_deref()
                        .map(hex_blob)
                        .transpose()?,
                    reference.relation,
                    reference.strength,
                    limitations_json,
                    task.task_id,
                ],
            )?;
        }
        for assessment in &request.assessments {
            transaction.execute(
                "INSERT INTO assessments(
                   candidate_id, statement_id, citations_digest, provenance_strength,
                   limitations_json, claim_support, assessed_by, statement_text_digest,
                   revision)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    assessment.candidate_id,
                    assessment.statement_id,
                    hex_blob(&assessment.citations_digest)?,
                    assessment.provenance_strength,
                    canonical(&serde_json::json!(assessment.limitations))?,
                    assessment.claim_support,
                    assessment.assessed_by,
                    hex_blob(&assessment.statement_text_digest)?,
                    assessment.revision,
                ],
            )?;
        }
        let candidate_generation =
            bump_candidate_generation(&transaction, &task.repository_key, &task.worktree_key)?;
        let changed = transaction.execute(
            "UPDATE chunks SET status='drafted'
             WHERE chunk_ref=?1 AND repository_key=?2 AND worktree_key=?3",
            params![chunk_ref, task.repository_key, task.worktree_key],
        )?;
        if changed == 0 {
            return Err(MemoryError::invalid(
                "the extraction task references a chunk that does not exist",
            ));
        }
        transaction.execute(
            "UPDATE tasks SET status='submitted' WHERE task_id=?1",
            params![task.task_id],
        )?;
        let outcome = serde_json::to_value(SubmitExtractionOutcome {
            task_id: task.task_id.clone(),
            idempotent: false,
            candidates,
            candidate_generation,
        })
        .map_err(|error| MemoryError::failed(error.to_string()))?;
        record_submission(
            &transaction,
            &task.task_id,
            &response_digest,
            &outcome,
            now_unix_ms,
        )?;
        transaction.commit()?;
        Ok(outcome)
    }

    /// `recall` (read-only): dual-FTS BM25 + `recall-rrf@1` fusion with
    /// deterministic digests.
    pub fn recall(&self, request: &RecallRequest) -> Result<RecallOutcome, MemoryError> {
        Ok(recall_on(&self.connection, request)?.outcome)
    }

    /// `submit-adjudication` (design §2 tx-adjudication-submit): recall
    /// re-run, result-set digest comparison, per-target revision CAS,
    /// adjudication effects, and state advancement, all inside one
    /// `BEGIN IMMEDIATE` transaction. Stale outcomes roll the transaction back
    /// (leaving no rows) and mark the task `stale` afterwards.
    pub fn submit_adjudication(
        &mut self,
        request: &SubmitAdjudicationRequest,
        now_unix_ms: i64,
    ) -> Result<Value, MemoryError> {
        let response_digest = hex_blob(&request.response_digest)?;
        let stale = |storage: &mut Self,
                     task_id: &str,
                     reason: &str,
                     actual: &str|
         -> Result<Value, MemoryError> {
            storage.connection.execute(
                "UPDATE tasks SET status='stale' WHERE task_id=?1 AND status='claimed'",
                params![task_id],
            )?;
            Ok(serde_json::json!({
                "taskId": task_id,
                "status": "stale",
                "reason": reason,
                "expectedResultSetDigest": request.expected_result_set_digest,
                "actualResultSetDigest": actual,
            }))
        };

        enum TxOutcome {
            Applied(Value),
            Stale {
                reason: &'static str,
                actual: String,
            },
        }

        let tx_result = (|| -> Result<TxOutcome, MemoryError> {
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let task = read_task(&transaction, &request.task_id)?.ok_or_else(|| {
                MemoryError::new("TS_MEMORY_TASK_NOT_FOUND", "the task does not exist")
            })?;
            if task.kind != "adjudication" {
                return Err(MemoryError::invalid("the task is not an adjudication task"));
            }
            if hex::encode(&task.repository_key) != request.recall.repository_key
                || hex::encode(&task.worktree_key) != request.recall.worktree_key
            {
                return Err(MemoryError::invalid(
                    "the recall owner does not match the task owner",
                ));
            }
            match submit_gate(
                &transaction,
                &task,
                &request.claim_token,
                &response_digest,
                now_unix_ms,
            ) {
                Ok(SubmitGate::Idempotent(mut outcome)) => {
                    transaction.commit()?;
                    outcome["idempotent"] = Value::Bool(true);
                    return Ok(TxOutcome::Applied(outcome));
                }
                Ok(SubmitGate::Proceed) => {}
                Err(error) => {
                    if error.code == "TS_MEMORY_SUBMISSION_CONFLICT" {
                        transaction.commit()?;
                    }
                    return Err(error);
                }
            }

            let recall = recall_on(&transaction, &request.recall)?;
            if recall.outcome.result_set_digest != request.expected_result_set_digest {
                return Ok(TxOutcome::Stale {
                    reason: "result-set-digest-mismatch",
                    actual: recall.outcome.result_set_digest,
                });
            }

            let mut outcomes = Vec::new();
            let mut chunk_refs: Vec<String> = Vec::new();
            for adjudication in &request.adjudications {
                let draft = request
                    .recall
                    .drafts
                    .iter()
                    .find(|draft| draft.draft_ref == adjudication.draft_ref)
                    .expect("validated draftRef mapping");
                let row: Option<(i64, i64, String, String)> = transaction
                    .query_row(
                        "SELECT rowid, revision, status, chunk_ref FROM candidates
                         WHERE candidate_id=?1 AND repository_key=?2 AND worktree_key=?3",
                        params![draft.candidate_id, task.repository_key, task.worktree_key],
                        |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                    )
                    .optional()?;
                let (draft_rowid, draft_revision, draft_status, draft_chunk_ref) =
                    row.ok_or_else(|| {
                        MemoryError::invalid(format!(
                            "draft candidate {} does not exist for this owner",
                            draft.candidate_id
                        ))
                    })?;
                if draft_status != "draft" {
                    return Err(MemoryError::invalid(format!(
                        "candidate {} is not a draft",
                        draft.candidate_id
                    )));
                }
                if !chunk_refs.contains(&draft_chunk_ref) {
                    chunk_refs.push(draft_chunk_ref);
                }

                if matches!(adjudication.action.as_str(), "update" | "merge") {
                    for target in &adjudication.targets {
                        if !recall
                            .candidate_pool_revisions
                            .iter()
                            .any(|(id, _)| *id == target.id)
                        {
                            return Err(MemoryError::invalid(format!(
                                "target {} is not a candidate in the recall pool",
                                target.id
                            )));
                        }
                        let target_rowid: i64 = transaction.query_row(
                            "SELECT rowid FROM candidates WHERE candidate_id=?1",
                            params![target.id],
                            |row| row.get(0),
                        )?;
                        let changed = transaction.execute(
                            "UPDATE candidates SET status='discarded', adjudication='done',
                               revision=revision+1, updated_at=?1
                             WHERE candidate_id=?2 AND revision=?3",
                            params![now_unix_ms, target.id, target.revision],
                        )?;
                        if changed == 0 {
                            return Ok(TxOutcome::Stale {
                                reason: "revision-cas-failed",
                                actual: recall.outcome.result_set_digest.clone(),
                            });
                        }
                        transaction.execute(
                            "DELETE FROM candidate_fts WHERE rowid=?1",
                            params![target_rowid],
                        )?;
                    }
                }

                let (candidate_status, revision) = match adjudication.action.as_str() {
                    "store" => {
                        transaction.execute(
                            "UPDATE candidates SET status='quarantined', adjudication='done',
                               revision=revision+1, updated_at=?1 WHERE rowid=?2",
                            params![now_unix_ms, draft_rowid],
                        )?;
                        ("quarantined", draft_revision + 1)
                    }
                    "skip" => {
                        transaction.execute(
                            "UPDATE candidates SET status='discarded', adjudication='done',
                               revision=revision+1, updated_at=?1 WHERE rowid=?2",
                            params![now_unix_ms, draft_rowid],
                        )?;
                        transaction.execute(
                            "DELETE FROM candidate_fts WHERE rowid=?1",
                            params![draft_rowid],
                        )?;
                        ("discarded", draft_revision + 1)
                    }
                    "update" | "merge" => {
                        let payload = adjudication
                            .merged_payload
                            .as_ref()
                            .expect("validated mergedPayload");
                        let searchable_text = adjudication
                            .merged_searchable_text
                            .as_deref()
                            .expect("validated mergedSearchableText");
                        let payload_json = canonical(payload)?;
                        let content_digest = Sha256::digest(payload_json.as_bytes()).to_vec();
                        transaction.execute(
                            "UPDATE candidates SET status='quarantined', adjudication='done',
                               revision=revision+1, updated_at=?1, payload_json=?2,
                               content_digest=?3
                             WHERE rowid=?4",
                            params![now_unix_ms, payload_json, content_digest, draft_rowid],
                        )?;
                        transaction.execute(
                            "DELETE FROM candidate_fts WHERE rowid=?1",
                            params![draft_rowid],
                        )?;
                        transaction.execute(
                            "INSERT INTO candidate_fts(rowid, searchable_text) VALUES (?1, ?2)",
                            params![draft_rowid, searchable_text],
                        )?;
                        ("quarantined", draft_revision + 1)
                    }
                    _ => unreachable!("validated adjudication action"),
                };
                outcomes.push(AdjudicationDraftOutcome {
                    draft_ref: adjudication.draft_ref.clone(),
                    action: adjudication.action.clone(),
                    candidate_id: draft.candidate_id.clone(),
                    candidate_status: candidate_status.to_owned(),
                    revision,
                });
            }

            for chunk_ref in &chunk_refs {
                transaction.execute(
                    "UPDATE chunks SET status='extracted' WHERE chunk_ref=?1",
                    params![chunk_ref],
                )?;
            }
            let candidate_generation =
                bump_candidate_generation(&transaction, &task.repository_key, &task.worktree_key)?;
            transaction.execute(
                "UPDATE tasks SET status='submitted' WHERE task_id=?1",
                params![task.task_id],
            )?;
            let outcome = serde_json::json!({
                "taskId": task.task_id,
                "status": "applied",
                "idempotent": false,
                "outcomes": outcomes,
                "candidateGeneration": candidate_generation,
            });
            record_submission(
                &transaction,
                &task.task_id,
                &response_digest,
                &outcome,
                now_unix_ms,
            )?;
            transaction.commit()?;
            Ok(TxOutcome::Applied(outcome))
        })();
        match tx_result? {
            TxOutcome::Applied(outcome) => Ok(outcome),
            TxOutcome::Stale { reason, actual } => stale(self, &request.task_id, reason, &actual),
        }
    }

    /// `sync-approved` (DEV-1 contract): partial scans record `coverage:
    /// partial` and are rejected; identical complete trees short-circuit;
    /// otherwise the owner's entries and FTS rows are replaced wholesale and
    /// `generation` advances, in one transaction.
    pub fn sync_approved(
        &mut self,
        request: &SyncApprovedRequest,
    ) -> Result<SyncApprovedOutcome, MemoryError> {
        let repository_key = hex_blob(&request.repository_key)?;
        let worktree_key = hex_blob(&request.worktree_key)?;
        let source_tree_digest = hex_blob(&request.source_tree_digest)?;
        if request.coverage == "partial" {
            self.connection.execute(
                "INSERT INTO approved_projection(
                   repository_key, worktree_key, generation, source_tree_digest, coverage,
                   analyzer_version, recall_algorithm_version)
                 VALUES (?1, ?2, 0, ?3, 'partial', ?4, ?5)
                 ON CONFLICT(repository_key, worktree_key) DO UPDATE SET coverage='partial'",
                params![
                    repository_key,
                    worktree_key,
                    source_tree_digest,
                    APPROVED_ANALYZER_VERSION,
                    RECALL_ALGORITHM_VERSION
                ],
            )?;
            return Err(MemoryError::new(
                "TS_MEMORY_SYNC_PARTIAL",
                "the worktree scan was partial; retry after the tree quiesces",
            ));
        }
        let existing: Option<(i64, Vec<u8>, String)> = self
            .connection
            .query_row(
                "SELECT generation, source_tree_digest, coverage FROM approved_projection
                 WHERE repository_key=?1 AND worktree_key=?2",
                params![repository_key, worktree_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        if let Some((generation, stored_digest, coverage)) = &existing
            && coverage == "complete"
            && *stored_digest == source_tree_digest
        {
            let entry_count: i64 = self.connection.query_row(
                "SELECT COUNT(*) FROM approved_entries
                 WHERE repository_key=?1 AND worktree_key=?2",
                params![repository_key, worktree_key],
                |row| row.get(0),
            )?;
            return Ok(SyncApprovedOutcome {
                generation: *generation,
                coverage: "complete".to_owned(),
                unchanged: true,
                entry_count: entry_count as usize,
            });
        }
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        transaction.execute(
            "DELETE FROM approved_fts WHERE rowid IN (
               SELECT rowid FROM approved_entries WHERE repository_key=?1 AND worktree_key=?2)",
            params![repository_key, worktree_key],
        )?;
        transaction.execute(
            "DELETE FROM approved_entries WHERE repository_key=?1 AND worktree_key=?2",
            params![repository_key, worktree_key],
        )?;
        for entry in &request.entries {
            transaction.execute(
                "INSERT INTO approved_entries(
                   entry_id, repository_key, worktree_key, revision, content_digest,
                   frontmatter_json, body_text, status)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8)",
                params![
                    entry.entry_id,
                    repository_key,
                    worktree_key,
                    entry.revision,
                    hex_blob(&entry.content_digest)?,
                    canonical(&entry.frontmatter)?,
                    entry.body_text,
                    entry.status,
                ],
            )?;
            let rowid = transaction.last_insert_rowid();
            transaction.execute(
                "INSERT INTO approved_fts(rowid, searchable_text) VALUES (?1, ?2)",
                params![rowid, entry.searchable_text],
            )?;
        }
        transaction.execute(
            "INSERT INTO approved_projection(
               repository_key, worktree_key, generation, source_tree_digest, coverage,
               analyzer_version, recall_algorithm_version)
             VALUES (?1, ?2, 1, ?3, 'complete', ?4, ?5)
             ON CONFLICT(repository_key, worktree_key) DO UPDATE SET
               generation = generation + 1,
               source_tree_digest = excluded.source_tree_digest,
               coverage = 'complete',
               analyzer_version = excluded.analyzer_version,
               recall_algorithm_version = excluded.recall_algorithm_version",
            params![
                repository_key,
                worktree_key,
                source_tree_digest,
                APPROVED_ANALYZER_VERSION,
                RECALL_ALGORITHM_VERSION
            ],
        )?;
        let generation: i64 = transaction.query_row(
            "SELECT generation FROM approved_projection
             WHERE repository_key=?1 AND worktree_key=?2",
            params![repository_key, worktree_key],
            |row| row.get(0),
        )?;
        transaction.commit()?;
        Ok(SyncApprovedOutcome {
            generation,
            coverage: "complete".to_owned(),
            unchanged: false,
            entry_count: request.entries.len(),
        })
    }

    /// `search` (read-only): owner-scoped BM25 over `approved_fts`.
    pub fn search(&self, request: &MemorySearchRequest) -> Result<SearchOutcome, MemoryError> {
        let repository_key = hex_blob(&request.repository_key)?;
        let worktree_key = hex_blob(&request.worktree_key)?;
        let projection =
            read_approved_projection(&self.connection, &repository_key, &worktree_key)?;
        let mut items = Vec::new();
        if let Some(match_query) = fts_match_query(&request.query) {
            let mut statement = self.connection.prepare(
                "SELECT a.entry_id, a.revision, a.content_digest, a.status, a.body_text
                 FROM approved_fts f JOIN approved_entries a ON a.rowid = f.rowid
                 WHERE approved_fts MATCH ?1 AND a.repository_key=?2 AND a.worktree_key=?3
                 ORDER BY bm25(approved_fts), a.entry_id LIMIT ?4",
            )?;
            let rows = statement.query_map(
                params![
                    &match_query,
                    &repository_key,
                    &worktree_key,
                    i64::from(request.limit)
                ],
                |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Vec<u8>>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                    ))
                },
            )?;
            for (index, row) in rows.enumerate() {
                let (entry_id, revision, content_digest, status, body_text) = row?;
                items.push(SearchItemWire {
                    rank: (index + 1) as u32,
                    entry_id,
                    revision,
                    content_digest: hex::encode(content_digest),
                    status,
                    summary: summarize(&body_text),
                });
            }
        }
        Ok(SearchOutcome {
            generation: projection.generation,
            coverage: projection.coverage,
            items,
        })
    }

    /// `review-queue` (read-only): quarantined candidates plus assessments.
    pub fn review_queue(
        &self,
        request: &ReviewQueueRequest,
    ) -> Result<ReviewQueueOutcome, MemoryError> {
        let repository_key = hex_blob(&request.repository_key)?;
        let worktree_key = hex_blob(&request.worktree_key)?;
        let mut statement = self.connection.prepare(
            "SELECT candidate_id, chunk_ref, revision, content_digest, payload_json
             FROM candidates
             WHERE repository_key=?1 AND worktree_key=?2 AND status='quarantined'
             ORDER BY candidate_id LIMIT ?3",
        )?;
        let rows = statement.query_map(
            params![&repository_key, &worktree_key, i64::from(request.limit)],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Vec<u8>>(3)?,
                    row.get::<_, String>(4)?,
                ))
            },
        )?;
        let mut items = Vec::new();
        for row in rows {
            let (candidate_id, chunk_ref, revision, content_digest, payload_json) = row?;
            let mut assessments = Vec::new();
            let mut assessment_statement = self.connection.prepare(
                "SELECT statement_id, citations_digest, provenance_strength, limitations_json,
                        claim_support, assessed_by, statement_text_digest, revision
                 FROM assessments WHERE candidate_id=?1 ORDER BY statement_id",
            )?;
            let assessment_rows =
                assessment_statement.query_map(params![&candidate_id], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, Vec<u8>>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                        row.get::<_, String>(4)?,
                        row.get::<_, String>(5)?,
                        row.get::<_, Vec<u8>>(6)?,
                        row.get::<_, i64>(7)?,
                    ))
                })?;
            for assessment_row in assessment_rows {
                let (
                    statement_id,
                    citations_digest,
                    provenance_strength,
                    limitations_json,
                    claim_support,
                    assessed_by,
                    statement_text_digest,
                    assessment_revision,
                ) = assessment_row?;
                let limitations = match parse_json(&limitations_json) {
                    Value::Array(values) => values
                        .into_iter()
                        .filter_map(|value| value.as_str().map(str::to_owned))
                        .collect(),
                    _ => Vec::new(),
                };
                assessments.push(ReviewAssessmentWire {
                    statement_id,
                    citations_digest: hex::encode(citations_digest),
                    provenance_strength,
                    limitations,
                    claim_support,
                    assessed_by,
                    statement_text_digest: hex::encode(statement_text_digest),
                    revision: assessment_revision,
                });
            }
            items.push(ReviewItemWire {
                candidate_id,
                chunk_ref,
                revision,
                content_digest: hex::encode(content_digest),
                payload: parse_json(&payload_json),
                assessments,
            });
        }
        Ok(ReviewQueueOutcome { items })
    }

    /// `status` (read-only): per-owner counters by status.
    pub fn status(
        &self,
        request: &MemoryStatusRequest,
    ) -> Result<MemoryStatusOutcome, MemoryError> {
        let repository_key = hex_blob(&request.repository_key)?;
        let worktree_key = hex_blob(&request.worktree_key)?;
        let count = |table: &str, status: &str| -> Result<i64, MemoryError> {
            let sql = format!(
                "SELECT COUNT(*) FROM {table}
                 WHERE repository_key=?1 AND worktree_key=?2 AND status=?3"
            );
            self.connection
                .query_row(
                    &sql,
                    params![&repository_key, &worktree_key, status],
                    |row| row.get(0),
                )
                .map_err(MemoryError::from)
        };
        Ok(MemoryStatusOutcome {
            chunks: ChunkCountsWire {
                pending: count("chunks", "pending")?,
                drafted: count("chunks", "drafted")?,
                extracted: count("chunks", "extracted")?,
                stale: count("chunks", "stale")?,
            },
            tasks: TaskCountsWire {
                pending: count("tasks", "pending")?,
                claimed: count("tasks", "claimed")?,
                submitted: count("tasks", "submitted")?,
                stale: count("tasks", "stale")?,
            },
            candidates: CandidateCountsWire {
                draft: count("candidates", "draft")?,
                quarantined: count("candidates", "quarantined")?,
                promoted: count("candidates", "promoted")?,
                discarded: count("candidates", "discarded")?,
            },
        })
    }
}
