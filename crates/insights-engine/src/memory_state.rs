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

use crate::memory_promotion::{
    PromotionFsError, decode_base64, git_blob_oid_hex, read_worktree_file, write_worktree_file,
};
use crate::memory_protocol::{
    AdjudicationDraftOutcome, ApprovedProjectionWire, AuthorizeRequest, BindRepositoryOutcome,
    BindRepositoryRequest, CandidateCountsWire, CandidateProjectionWire, CandidateStateWire,
    ChunkCountsWire, ClaimTaskOutcome, ClaimTaskRequest, ConfirmStatementRequest,
    DiscardCandidateRequest, MemorySearchRequest, MemoryStatusOutcome, MemoryStatusRequest,
    PlanTasksOutcome, PlanTasksRequest, PlannedTaskStateWire, PoolItemWire, PromotionApplyRequest,
    PromotionApproveRequest, PromotionCountsWire, PromotionPlanRequest, RecallHitWire,
    RecallOutcome, RecallRequest, RecallSetWire, ReviewAssessmentWire, ReviewItemWire,
    ReviewQueueOutcome, ReviewQueueRequest, SearchItemWire, SearchOutcome,
    SubmitAdjudicationRequest, SubmitExtractionOutcome, SubmitExtractionRequest,
    SyncApprovedRequest, TaskCountsWire, TaskLeaseWire, TaskWire,
};
use crate::storage::{
    WAL_BACKPRESSURE_BYTES, WAL_PASSIVE_CHECKPOINT_BYTES, WalPressureAction,
    persistent_file_permissions, sqlite_sidecar_path, wal_pressure_action,
};
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

/// `format` self-identifier of the canonical promotion plan document
/// persisted in `promotion_journal.plan_canonical_json` (design §9).
pub const PROMOTION_PLAN_FORMAT: &str = "threadshare-memory-promotion-plan@v1";

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

    /// WAL maintenance after every successful write transaction. The
    /// memory-state connection disables `wal_autocheckpoint`, so this applies
    /// the same threshold policy as the Insights store
    /// (`EngineStorage::maintain_wal_after_commit`): a PASSIVE checkpoint at
    /// 64 MiB and TRUNCATE backpressure at 128 MiB.
    fn maintain_wal_after_commit(&self) -> Result<(), MemoryError> {
        self.maintain_wal_after_commit_with_thresholds(
            WAL_PASSIVE_CHECKPOINT_BYTES,
            WAL_BACKPRESSURE_BYTES,
        )?;
        Ok(())
    }

    fn maintain_wal_after_commit_with_thresholds(
        &self,
        passive_checkpoint_bytes: u64,
        backpressure_bytes: u64,
    ) -> Result<WalPressureAction, MemoryError> {
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
            return Err(MemoryError::new(
                "TS_MEMORY_WAL_BACKPRESSURE",
                "the memory-state writer is waiting for readers to release the WAL snapshot",
            ));
        }
        Ok(action)
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
        self.maintain_wal_after_commit()?;
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
        let mut planned_tasks = Vec::with_capacity(request.tasks.len());
        {
            let mut statement = transaction
                .prepare("SELECT status, lease_expires_at FROM tasks WHERE task_id=?1")?;
            for task in &request.tasks {
                let (status, lease_expires_at): (String, Option<i64>) = statement
                    .query_row(params![task.task_id], |row| Ok((row.get(0)?, row.get(1)?)))?;
                let claimable = status == "pending"
                    || (status == "claimed"
                        && lease_expires_at.is_some_and(|expires_at| expires_at < now_unix_ms));
                planned_tasks.push(PlannedTaskStateWire {
                    task_id: task.task_id.clone(),
                    status,
                    claimable,
                });
            }
        }
        transaction.commit()?;
        self.maintain_wal_after_commit()?;
        Ok(PlanTasksOutcome {
            inserted_chunks,
            skipped_chunks: request.chunks.len() - inserted_chunks,
            inserted_tasks,
            skipped_tasks: request.tasks.len() - inserted_tasks,
            tasks: planned_tasks,
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
        self.maintain_wal_after_commit()?;
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
                self.maintain_wal_after_commit()?;
                outcome["idempotent"] = Value::Bool(true);
                return Ok(outcome);
            }
            Ok(SubmitGate::Proceed) => {}
            Err(error) => {
                if error.code == "TS_MEMORY_SUBMISSION_CONFLICT" {
                    transaction.commit()?;
                    self.maintain_wal_after_commit()?;
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
        self.maintain_wal_after_commit()?;
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
    /// `BEGIN IMMEDIATE` transaction. The recall re-run and the adjudication
    /// effects live under a savepoint: stale outcomes roll the savepoint back
    /// (leaving no adjudication rows) and mark the task `stale` inside the
    /// same outer transaction with a lease-scoped CAS on
    /// `(claim_token, lease_epoch, status='claimed')`, so a lease reissued to
    /// another holder can never be marked stale and no `claimed` residue can
    /// survive between the rollback and the marking.
    pub fn submit_adjudication(
        &mut self,
        request: &SubmitAdjudicationRequest,
        now_unix_ms: i64,
    ) -> Result<Value, MemoryError> {
        let response_digest = hex_blob(&request.response_digest)?;

        enum ApplyOutcome {
            Applied(Value),
            Stale {
                reason: &'static str,
                actual: String,
            },
        }

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
                self.maintain_wal_after_commit()?;
                outcome["idempotent"] = Value::Bool(true);
                return Ok(outcome);
            }
            Ok(SubmitGate::Proceed) => {}
            Err(error) => {
                if error.code == "TS_MEMORY_SUBMISSION_CONFLICT" {
                    transaction.commit()?;
                    self.maintain_wal_after_commit()?;
                }
                return Err(error);
            }
        }

        transaction.execute_batch("SAVEPOINT memory_adjudication_apply")?;
        let apply_result = (|| -> Result<ApplyOutcome, MemoryError> {
            let recall = recall_on(&transaction, &request.recall)?;
            if recall.outcome.result_set_digest != request.expected_result_set_digest {
                return Ok(ApplyOutcome::Stale {
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
                        // The submitted revision must equal exactly the
                        // revision this transaction's own recall re-run saw in
                        // the pool; comparing against the current row instead
                        // would let consecutive revisions within one request
                        // bypass the "revision the adjudicator saw" contract.
                        let pool_revision = recall
                            .candidate_pool_revisions
                            .iter()
                            .find(|(id, _)| *id == target.id)
                            .map(|(_, revision)| *revision)
                            .ok_or_else(|| {
                                MemoryError::invalid(format!(
                                    "target {} is not a candidate in the recall pool",
                                    target.id
                                ))
                            })?;
                        if target.revision != pool_revision {
                            return Ok(ApplyOutcome::Stale {
                                reason: "revision-cas-failed",
                                actual: recall.outcome.result_set_digest.clone(),
                            });
                        }
                        let target_rowid: i64 = transaction.query_row(
                            "SELECT rowid FROM candidates
                             WHERE candidate_id=?1 AND repository_key=?2 AND worktree_key=?3",
                            params![target.id, task.repository_key, task.worktree_key],
                            |row| row.get(0),
                        )?;
                        let changed = transaction.execute(
                            "UPDATE candidates SET status='discarded', adjudication='done',
                               revision=revision+1, updated_at=?1
                             WHERE candidate_id=?2 AND revision=?3
                               AND repository_key=?4 AND worktree_key=?5
                               AND status IN ('draft','quarantined')",
                            params![
                                now_unix_ms,
                                target.id,
                                target.revision,
                                task.repository_key,
                                task.worktree_key
                            ],
                        )?;
                        if changed == 0 {
                            return Ok(ApplyOutcome::Stale {
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
            Ok(ApplyOutcome::Applied(outcome))
        })();
        match apply_result? {
            ApplyOutcome::Applied(outcome) => {
                transaction.execute_batch("RELEASE memory_adjudication_apply")?;
                transaction.commit()?;
                self.maintain_wal_after_commit()?;
                Ok(outcome)
            }
            ApplyOutcome::Stale { reason, actual } => {
                transaction.execute_batch(
                    "ROLLBACK TO memory_adjudication_apply; RELEASE memory_adjudication_apply",
                )?;
                // Lease-scoped stale marking inside the same transaction: only
                // the exact lease this submission presented (and the gate just
                // verified) may be marked. A zero-row CAS means the lease is
                // no longer ours, so the result reports the actual task status
                // instead of claiming `stale`.
                let changed = transaction.execute(
                    "UPDATE tasks SET status='stale'
                     WHERE task_id=?1 AND claim_token=?2 AND lease_epoch=?3
                       AND status='claimed'",
                    params![&task.task_id, &request.claim_token, task.lease_epoch],
                )?;
                let status = if changed == 1 {
                    "stale".to_owned()
                } else {
                    read_task(&transaction, &task.task_id)?
                        .map(|current| current.status)
                        .unwrap_or_else(|| "missing".to_owned())
                };
                transaction.commit()?;
                self.maintain_wal_after_commit()?;
                Ok(serde_json::json!({
                    "taskId": task.task_id,
                    "status": status,
                    "reason": reason,
                    "expectedResultSetDigest": request.expected_result_set_digest,
                    "actualResultSetDigest": actual,
                }))
            }
        }
    }

    /// `sync-approved` (DEV-1 contract), generation-CAS guarded and fully
    /// transactional: the projection read, the `expectedGeneration` CAS, the
    /// partial-coverage marker, the unchanged short-circuit, and the wholesale
    /// replacement all run inside one `BEGIN IMMEDIATE` transaction, so a
    /// stale scan (complete or partial) can never overwrite or downgrade a
    /// projection that advanced after the scan started. A CAS miss returns
    /// the structured `"conflict"` result with the current generation and
    /// stored source tree digest; the client must rescan.
    pub fn sync_approved(&mut self, request: &SyncApprovedRequest) -> Result<Value, MemoryError> {
        let repository_key = hex_blob(&request.repository_key)?;
        let worktree_key = hex_blob(&request.worktree_key)?;
        let source_tree_digest = hex_blob(&request.source_tree_digest)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let existing: Option<(i64, Vec<u8>, String)> = transaction
            .query_row(
                "SELECT generation, source_tree_digest, coverage FROM approved_projection
                 WHERE repository_key=?1 AND worktree_key=?2",
                params![repository_key, worktree_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let current_generation = existing
            .as_ref()
            .map_or(0, |(generation, _, _)| *generation);
        if request.expected_generation != current_generation {
            // Nothing was written; dropping the transaction releases the lock.
            return Ok(serde_json::json!({
                "status": "conflict",
                "generation": current_generation,
                "coverage": existing
                    .as_ref()
                    .map_or("complete", |(_, _, coverage)| coverage.as_str()),
                "sourceTreeDigest": existing
                    .as_ref()
                    .map(|(_, stored_digest, _)| hex::encode(stored_digest)),
            }));
        }
        if request.coverage == "partial" {
            transaction.execute(
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
            transaction.commit()?;
            self.maintain_wal_after_commit()?;
            return Err(MemoryError::new(
                "TS_MEMORY_SYNC_PARTIAL",
                "the worktree scan was partial; retry after the tree quiesces",
            ));
        }
        if let Some((generation, stored_digest, coverage)) = &existing
            && coverage == "complete"
            && *stored_digest == source_tree_digest
        {
            let entry_count: i64 = transaction.query_row(
                "SELECT COUNT(*) FROM approved_entries
                 WHERE repository_key=?1 AND worktree_key=?2",
                params![repository_key, worktree_key],
                |row| row.get(0),
            )?;
            return Ok(serde_json::json!({
                "status": "synced",
                "generation": generation,
                "coverage": "complete",
                "unchanged": true,
                "entryCount": entry_count,
            }));
        }
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
        self.maintain_wal_after_commit()?;
        Ok(serde_json::json!({
            "status": "synced",
            "generation": generation,
            "coverage": "complete",
            "unchanged": false,
            "entryCount": request.entries.len(),
        }))
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

    /// `status` (read-only): per-owner counters by status, plus the
    /// promotion-journal recovery check (`applying` plans are reported so the
    /// caller can resume `promotion-apply`).
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
        let mut applying_statement = self.connection.prepare(
            "SELECT plan_id FROM promotion_journal
             WHERE repository_key=?1 AND worktree_key=?2 AND status='applying'
             ORDER BY plan_id",
        )?;
        let applying_plan_ids = applying_statement
            .query_map(params![&repository_key, &worktree_key], |row| row.get(0))?
            .collect::<Result<Vec<String>, _>>()?;
        let promotions = PromotionCountsWire {
            generated: count("promotion_journal", "generated")?,
            approved: count("promotion_journal", "approved")?,
            applying: count("promotion_journal", "applying")?,
            applied: count("promotion_journal", "applied")?,
            voided: count("promotion_journal", "voided")?,
            applying_plan_ids,
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
            promotions,
        })
    }
}

/// `(rowid, revision, status, repository_key, worktree_key)` of a candidate.
type CandidateRow = (i64, i64, String, Vec<u8>, Vec<u8>);

/// `(target_path, target_blob_hash, sanitized_content, sanitized_digest)` of
/// one `promotion-plan` file before insertion.
type PlanFileRow = (String, Option<String>, Vec<u8>, Vec<u8>);

/// One `promotion_files` row loaded for `promotion-apply`.
struct PromotionFileRow {
    target_path: String,
    target_blob_hash: Option<String>,
    sanitized_content: Vec<u8>,
    sanitized_digest: Vec<u8>,
    applied: i64,
}

fn read_promotion_files(
    connection: &Connection,
    plan_id: &str,
) -> Result<Vec<PromotionFileRow>, MemoryError> {
    let mut statement = connection.prepare(
        "SELECT target_path, target_blob_hash, sanitized_content, sanitized_digest, applied
         FROM promotion_files WHERE plan_id=?1 ORDER BY target_path",
    )?;
    let rows = statement
        .query_map(params![plan_id], |row| {
            Ok(PromotionFileRow {
                target_path: row.get(0)?,
                target_blob_hash: row.get(1)?,
                sanitized_content: row.get(2)?,
                sanitized_digest: row.get(3)?,
                applied: row.get(4)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn candidate_ids_from_json(candidate_ids_json: &str) -> Vec<String> {
    match parse_json(candidate_ids_json) {
        Value::Array(values) => values
            .into_iter()
            .filter_map(|value| value.as_str().map(str::to_owned))
            .collect(),
        _ => Vec::new(),
    }
}

/// Stage 4c ops: statement confirmation, candidate discard, and the
/// promotion state machine (design §2 tx-promotion; proposal D5, §6.5).
impl MemoryStorage {
    /// `confirm-statement`: digest-bound human confirmation. Drift returns a
    /// structured `"drifted"` result without any state change.
    pub fn confirm_statement(
        &mut self,
        request: &ConfirmStatementRequest,
    ) -> Result<Value, MemoryError> {
        let statement_text_digest = hex_blob(&request.statement_text_digest)?;
        let citations_digest = hex_blob(&request.citations_digest)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(Vec<u8>, Vec<u8>, i64)> = transaction
            .query_row(
                "SELECT statement_text_digest, citations_digest, revision
                 FROM assessments WHERE candidate_id=?1 AND statement_id=?2",
                params![&request.candidate_id, &request.statement_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (stored_text_digest, stored_citations_digest, revision) = row.ok_or_else(|| {
            MemoryError::new(
                "TS_MEMORY_ASSESSMENT_NOT_FOUND",
                "no assessment exists for this candidate statement",
            )
        })?;
        if stored_text_digest != statement_text_digest
            || stored_citations_digest != citations_digest
        {
            transaction.commit()?;
            return Ok(serde_json::json!({
                "candidateId": request.candidate_id,
                "statementId": request.statement_id,
                "status": "drifted",
                "actualStatementTextDigest": hex::encode(stored_text_digest),
                "actualCitationsDigest": hex::encode(stored_citations_digest),
            }));
        }
        transaction.execute(
            "UPDATE assessments SET claim_support='human-confirmed', assessed_by='human',
               revision=revision+1
             WHERE candidate_id=?1 AND statement_id=?2",
            params![&request.candidate_id, &request.statement_id],
        )?;
        transaction.commit()?;
        self.maintain_wal_after_commit()?;
        Ok(serde_json::json!({
            "candidateId": request.candidate_id,
            "statementId": request.statement_id,
            "status": "confirmed",
            "claimSupport": "human-confirmed",
            "assessedBy": "human",
            "revision": revision + 1,
        }))
    }

    /// `discard-candidate`: revision CAS, then `draft`/`quarantined` →
    /// `discarded`, FTS removal, and a projection generation bump.
    pub fn discard_candidate(
        &mut self,
        request: &DiscardCandidateRequest,
        now_unix_ms: i64,
    ) -> Result<Value, MemoryError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<CandidateRow> = transaction
            .query_row(
                "SELECT rowid, revision, status, repository_key, worktree_key
                 FROM candidates WHERE candidate_id=?1",
                params![&request.candidate_id],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                    ))
                },
            )
            .optional()?;
        let (rowid, revision, status, repository_key, worktree_key) = row.ok_or_else(|| {
            MemoryError::new(
                "TS_MEMORY_CANDIDATE_NOT_FOUND",
                "the candidate does not exist",
            )
        })?;
        if !matches!(status.as_str(), "draft" | "quarantined") {
            return Err(MemoryError::new(
                "TS_MEMORY_CANDIDATE_STALE",
                format!("the candidate is {status} and cannot be discarded"),
            ));
        }
        if revision != request.expected_revision {
            return Err(MemoryError::new(
                "TS_MEMORY_CANDIDATE_STALE",
                format!(
                    "the candidate revision is {revision}, not the expected {}",
                    request.expected_revision
                ),
            ));
        }
        transaction.execute(
            "UPDATE candidates SET status='discarded', revision=revision+1, updated_at=?1
             WHERE rowid=?2",
            params![now_unix_ms, rowid],
        )?;
        transaction.execute("DELETE FROM candidate_fts WHERE rowid=?1", params![rowid])?;
        let generation = bump_candidate_generation(&transaction, &repository_key, &worktree_key)?;
        transaction.commit()?;
        self.maintain_wal_after_commit()?;
        Ok(serde_json::json!({
            "candidateId": request.candidate_id,
            "status": "discarded",
            "revision": revision + 1,
            "candidateGeneration": generation,
        }))
    }

    /// `promotion-plan`: verifies quarantined candidates with fully verified
    /// statements and memoryRoot-contained targets, then persists the
    /// canonical plan (`generated`) plus the exact sanitized bytes.
    pub fn promotion_plan(
        &mut self,
        request: &PromotionPlanRequest,
        now_unix_ms: i64,
    ) -> Result<Value, MemoryError> {
        let repository_key = hex_blob(&request.owner.repository_key)?;
        let worktree_key = hex_blob(&request.owner.worktree_key)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let memory_root: Option<String> = transaction
            .query_row(
                "SELECT memory_root FROM repository_bindings
                 WHERE repository_key=?1 AND worktree_key=?2",
                params![&repository_key, &worktree_key],
                |row| row.get(0),
            )
            .optional()?;
        let memory_root = memory_root.ok_or_else(|| {
            MemoryError::new(
                "TS_MEMORY_BINDING_NOT_FOUND",
                "the owner has no repository binding; run bind-repository first",
            )
        })?;

        let mut assessment_documents: Vec<(String, String, Value)> = Vec::new();
        for candidate_id in &request.candidate_ids {
            let row: Option<(String, String)> = transaction
                .query_row(
                    "SELECT status, payload_json FROM candidates
                     WHERE candidate_id=?1 AND repository_key=?2 AND worktree_key=?3",
                    params![candidate_id, &repository_key, &worktree_key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            let (status, payload_json) = row.ok_or_else(|| {
                MemoryError::new(
                    "TS_MEMORY_CANDIDATE_NOT_FOUND",
                    format!("candidate {candidate_id} does not exist for this owner"),
                )
            })?;
            if status != "quarantined" {
                return Err(MemoryError::new(
                    "TS_MEMORY_CANDIDATE_STALE",
                    format!("candidate {candidate_id} is {status}, not quarantined"),
                ));
            }
            let mut assessed_statement_ids: Vec<String> = Vec::new();
            let mut statement = transaction.prepare(
                "SELECT statement_id, citations_digest, provenance_strength, limitations_json,
                        claim_support, assessed_by, statement_text_digest, revision
                 FROM assessments WHERE candidate_id=?1 ORDER BY statement_id",
            )?;
            let rows = statement.query_map(params![candidate_id], |row| {
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
            for row in rows {
                let (
                    statement_id,
                    citations_digest,
                    provenance_strength,
                    limitations_json,
                    claim_support,
                    assessed_by,
                    statement_text_digest,
                    revision,
                ) = row?;
                if !matches!(claim_support.as_str(), "typed-fact" | "human-confirmed") {
                    return Err(MemoryError::new(
                        "TS_MEMORY_UNVERIFIED_CLAIM",
                        format!(
                            "candidate {candidate_id} statement {statement_id} is {claim_support}; \
                             confirm every statement before planning a promotion"
                        ),
                    ));
                }
                let document = serde_json::json!({
                    "candidateId": candidate_id,
                    "statementId": statement_id,
                    "citationsDigest": hex::encode(citations_digest),
                    "provenanceStrength": provenance_strength,
                    "limitations": parse_json(&limitations_json),
                    "claimSupport": claim_support,
                    "assessedBy": assessed_by,
                    "statementTextDigest": hex::encode(statement_text_digest),
                    "revision": revision,
                });
                assessed_statement_ids.push(statement_id.clone());
                assessment_documents.push((candidate_id.clone(), statement_id, document));
            }
            drop(statement);
            if let Some(statements) = parse_json(&payload_json)
                .get("statements")
                .and_then(Value::as_array)
            {
                for statement in statements {
                    if let Some(statement_id) = statement.get("statementId").and_then(Value::as_str)
                        && !assessed_statement_ids.iter().any(|id| id == statement_id)
                    {
                        return Err(MemoryError::new(
                            "TS_MEMORY_UNVERIFIED_CLAIM",
                            format!(
                                "candidate {candidate_id} statement {statement_id} has no \
                                 assessment and cannot be promoted"
                            ),
                        ));
                    }
                }
            }
        }
        assessment_documents
            .sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
        let assessment_digest_hex = canonical_digest_hex(&Value::Array(
            assessment_documents
                .into_iter()
                .map(|(_, _, document)| document)
                .collect(),
        ))?;

        let memory_root_prefix = format!("{memory_root}/");
        let mut per_file_documents = Vec::new();
        let mut file_rows: Vec<PlanFileRow> = Vec::new();
        for file in &request.per_file {
            if !file.target_path.starts_with(&memory_root_prefix) {
                return Err(MemoryError::new(
                    "TS_MEMORY_TARGET_PATH_INVALID",
                    format!(
                        "targetPath {} is outside the binding memoryRoot {memory_root}",
                        file.target_path
                    ),
                ));
            }
            let content = decode_base64(&file.sanitized_content).ok_or_else(|| {
                MemoryError::invalid("perFile[].sanitizedContent must be strict padded base64")
            })?;
            let sanitized_digest = Sha256::digest(&content).to_vec();
            per_file_documents.push(serde_json::json!({
                "targetPath": file.target_path,
                "targetBlobHash": file.target_blob_hash,
                "sanitizedContentDigest": hex::encode(&sanitized_digest),
            }));
            file_rows.push((
                file.target_path.clone(),
                file.target_blob_hash.clone(),
                content,
                sanitized_digest,
            ));
        }

        let plan_id = new_memory_state_uuid(&transaction)?;
        let plan_document = serde_json::json!({
            "format": PROMOTION_PLAN_FORMAT,
            "planId": plan_id,
            "owner": {
                "repositoryKey": request.owner.repository_key,
                "worktreeKey": request.owner.worktree_key,
                "memoryRoot": memory_root,
            },
            "candidateIds": request.candidate_ids,
            "policyVersion": request.policy_version,
            "assessmentDigest": assessment_digest_hex,
            "perFile": per_file_documents,
        });
        let plan_canonical_json = canonical(&plan_document)?;
        let plan_digest = Sha256::digest(plan_canonical_json.as_bytes()).to_vec();
        transaction.execute(
            "INSERT INTO promotion_journal(
               plan_id, repository_key, worktree_key, plan_canonical_json, plan_digest,
               candidate_ids_json, assessment_digest, policy_version, status, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'generated', ?9)",
            params![
                plan_id,
                repository_key,
                worktree_key,
                plan_canonical_json,
                plan_digest,
                canonical(&serde_json::json!(request.candidate_ids))?,
                hex_blob(&assessment_digest_hex)?,
                request.policy_version,
                now_unix_ms,
            ],
        )?;
        let mut files = Vec::new();
        for (target_path, target_blob_hash, content, sanitized_digest) in file_rows {
            transaction.execute(
                "INSERT INTO promotion_files(
                   plan_id, target_path, target_blob_hash, sanitized_content, sanitized_digest,
                   applied)
                 VALUES (?1, ?2, ?3, ?4, ?5, 0)",
                params![
                    plan_id,
                    target_path,
                    target_blob_hash,
                    content,
                    sanitized_digest
                ],
            )?;
            files.push(serde_json::json!({
                "targetPath": target_path,
                "targetBlobHash": target_blob_hash,
                "sanitizedDigest": hex::encode(&sanitized_digest),
                "bytes": content.len(),
            }));
        }
        transaction.commit()?;
        self.maintain_wal_after_commit()?;
        Ok(serde_json::json!({
            "planId": plan_id,
            "planDigest": hex::encode(plan_digest),
            "status": "generated",
            "owner": {
                "repositoryKey": request.owner.repository_key,
                "worktreeKey": request.owner.worktree_key,
                "memoryRoot": memory_root,
            },
            "candidateIds": request.candidate_ids,
            "policyVersion": request.policy_version,
            "assessmentDigest": assessment_digest_hex,
            "files": files,
        }))
    }

    /// `promotion-approve`: the digest-bound explicit approval
    /// (`generated → approved`); the sole approval channel (proposal D5).
    pub fn promotion_approve(
        &mut self,
        request: &PromotionApproveRequest,
        now_unix_ms: i64,
    ) -> Result<Value, MemoryError> {
        let requested_digest = hex_blob(&request.plan_digest)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let row: Option<(Vec<u8>, String)> = transaction
            .query_row(
                "SELECT plan_digest, status FROM promotion_journal WHERE plan_id=?1",
                params![&request.plan_id],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (stored_digest, status) = row.ok_or_else(|| {
            MemoryError::new(
                "TS_MEMORY_PLAN_NOT_FOUND",
                "the promotion plan does not exist",
            )
        })?;
        if stored_digest != requested_digest {
            return Err(MemoryError::new(
                "TS_MEMORY_PLAN_DIGEST_MISMATCH",
                "the approval digest does not match the stored plan digest",
            ));
        }
        let idempotent = match status.as_str() {
            "generated" => {
                transaction.execute(
                    "UPDATE promotion_journal SET status='approved', updated_at=?1
                     WHERE plan_id=?2",
                    params![now_unix_ms, &request.plan_id],
                )?;
                false
            }
            "approved" => true,
            other => {
                return Err(MemoryError::new(
                    "TS_MEMORY_PLAN_STATE_INVALID",
                    format!("the plan is {other} and cannot be approved"),
                ));
            }
        };
        transaction.commit()?;
        self.maintain_wal_after_commit()?;
        Ok(serde_json::json!({
            "planId": request.plan_id,
            "planDigest": request.plan_digest,
            "status": "approved",
            "idempotent": idempotent,
        }))
    }

    fn void_plan(
        &mut self,
        plan_id: &str,
        drifted_path: &str,
        now_unix_ms: i64,
    ) -> Result<Value, MemoryError> {
        self.connection.execute(
            "UPDATE promotion_journal SET status='voided', updated_at=?1 WHERE plan_id=?2",
            params![now_unix_ms, plan_id],
        )?;
        self.maintain_wal_after_commit()?;
        Ok(serde_json::json!({
            "planId": plan_id,
            "status": "voided",
            "driftedPath": drifted_path,
        }))
    }

    /// `promotion-apply` (design §2 tx-promotion): owner re-resolution, the
    /// engine-computed git blob OID CAS per file, no-follow writes of the
    /// approved bytes, per-file `applied` progress for crash recovery, and
    /// the closing transaction that promotes the candidates out of the
    /// recall pool.
    pub fn promotion_apply(
        &mut self,
        request: &PromotionApplyRequest,
        now_unix_ms: i64,
    ) -> Result<Value, MemoryError> {
        // Phase 1: journal gate + owner re-resolution, then mark `applying`.
        let (repository_key, worktree_key, candidate_ids, root_realpath, was_applied) = {
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let row: Option<(Vec<u8>, Vec<u8>, String, String)> = transaction
                .query_row(
                    "SELECT repository_key, worktree_key, candidate_ids_json, status
                     FROM promotion_journal WHERE plan_id=?1",
                    params![&request.plan_id],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .optional()?;
            let (repository_key, worktree_key, candidate_ids_json, status) =
                row.ok_or_else(|| {
                    MemoryError::new(
                        "TS_MEMORY_PLAN_NOT_FOUND",
                        "the promotion plan does not exist",
                    )
                })?;
            let was_applied = match status.as_str() {
                "approved" | "applying" => false,
                "applied" => true,
                other => {
                    return Err(MemoryError::new(
                        "TS_MEMORY_PLAN_STATE_INVALID",
                        format!("the plan is {other} and cannot be applied"),
                    ));
                }
            };
            let root_realpath: Option<String> = transaction
                .query_row(
                    "SELECT root_realpath FROM repository_bindings
                     WHERE repository_key=?1 AND worktree_key=?2",
                    params![&repository_key, &worktree_key],
                    |row| row.get(0),
                )
                .optional()?;
            let root_realpath = root_realpath.ok_or_else(|| {
                MemoryError::new(
                    "TS_MEMORY_BINDING_NOT_FOUND",
                    "the plan owner has no repository binding",
                )
            })?;
            if root_realpath != request.owner_root_realpath {
                return Err(MemoryError::new(
                    "TS_MEMORY_OWNER_MISMATCH",
                    "ownerRootRealpath does not match the bound worktree root",
                ));
            }
            if !was_applied {
                transaction.execute(
                    "UPDATE promotion_journal SET status='applying', updated_at=?1
                     WHERE plan_id=?2",
                    params![now_unix_ms, &request.plan_id],
                )?;
            }
            transaction.commit()?;
            (
                repository_key,
                worktree_key,
                candidate_ids_from_json(&candidate_ids_json),
                root_realpath,
                was_applied,
            )
        };
        self.maintain_wal_after_commit()?;
        let files = read_promotion_files(&self.connection, &request.plan_id)?;
        if was_applied {
            let candidates =
                self.promoted_candidate_states(&candidate_ids, &repository_key, &worktree_key)?;
            let generation =
                read_candidate_projection(&self.connection, &repository_key, &worktree_key)?
                    .generation;
            return Ok(serde_json::json!({
                "planId": request.plan_id,
                "status": "applied",
                "idempotent": true,
                "appliedFiles": files
                    .iter()
                    .map(|file| file.target_path.clone())
                    .collect::<Vec<_>>(),
                "candidates": candidates,
                "candidateGeneration": generation,
            }));
        }

        // Phase 2: per-file blob CAS + no-follow write, with `applied`
        // progress persisted after each file for idempotent resume.
        let root = PathBuf::from(&root_realpath);
        let mut applied_files = Vec::new();
        for file in &files {
            let segments: Vec<&str> = file.target_path.split('/').collect();
            let current = match read_worktree_file(&root, &segments) {
                Ok(current) => current,
                Err(PromotionFsError::Symlink) => {
                    return self.void_plan(&request.plan_id, &file.target_path, now_unix_ms);
                }
                Err(PromotionFsError::Io(error)) => {
                    return Err(MemoryError::failed(format!(
                        "promotion apply could not read {}: {error}",
                        file.target_path
                    )));
                }
            };
            let current_digest = current
                .as_deref()
                .map(|bytes| Sha256::digest(bytes).to_vec());
            let already_exact = current_digest.as_deref() == Some(file.sanitized_digest.as_slice());
            if file.applied == 1 {
                if already_exact {
                    applied_files.push(file.target_path.clone());
                    continue;
                }
                // Applied earlier but the content drifted afterwards.
                return self.void_plan(&request.plan_id, &file.target_path, now_unix_ms);
            }
            if !already_exact {
                let observed_blob = current.as_deref().map(git_blob_oid_hex);
                if observed_blob.as_deref() != file.target_blob_hash.as_deref() {
                    return self.void_plan(&request.plan_id, &file.target_path, now_unix_ms);
                }
                match write_worktree_file(&root, &segments, &file.sanitized_content) {
                    Ok(()) => {}
                    Err(PromotionFsError::Symlink) => {
                        return self.void_plan(&request.plan_id, &file.target_path, now_unix_ms);
                    }
                    Err(PromotionFsError::Io(error)) => {
                        return Err(MemoryError::failed(format!(
                            "promotion apply could not write {}: {error}",
                            file.target_path
                        )));
                    }
                }
            }
            self.connection.execute(
                "UPDATE promotion_files SET applied=1 WHERE plan_id=?1 AND target_path=?2",
                params![&request.plan_id, &file.target_path],
            )?;
            applied_files.push(file.target_path.clone());
        }

        // Phase 3: closing transaction — journal `applied`, candidates
        // `promoted` (+revision, out of FTS), generation bump.
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let mut candidates = Vec::new();
        for candidate_id in &candidate_ids {
            let row: Option<(i64, i64, String)> = transaction
                .query_row(
                    "SELECT rowid, revision, status FROM candidates
                     WHERE candidate_id=?1 AND repository_key=?2 AND worktree_key=?3",
                    params![candidate_id, &repository_key, &worktree_key],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let (rowid, revision, status) = row.ok_or_else(|| {
                MemoryError::new(
                    "TS_MEMORY_CANDIDATE_NOT_FOUND",
                    format!("candidate {candidate_id} disappeared before promotion"),
                )
            })?;
            let final_revision = match status.as_str() {
                "promoted" => revision,
                "quarantined" => {
                    transaction.execute(
                        "UPDATE candidates SET status='promoted', revision=revision+1,
                           updated_at=?1 WHERE rowid=?2",
                        params![now_unix_ms, rowid],
                    )?;
                    transaction
                        .execute("DELETE FROM candidate_fts WHERE rowid=?1", params![rowid])?;
                    revision + 1
                }
                other => {
                    return Err(MemoryError::new(
                        "TS_MEMORY_CANDIDATE_STALE",
                        format!("candidate {candidate_id} is {other} and cannot be promoted"),
                    ));
                }
            };
            candidates.push(serde_json::json!({
                "candidateId": candidate_id,
                "revision": final_revision,
                "status": "promoted",
            }));
        }
        let generation = bump_candidate_generation(&transaction, &repository_key, &worktree_key)?;
        transaction.execute(
            "UPDATE promotion_journal SET status='applied', updated_at=?1 WHERE plan_id=?2",
            params![now_unix_ms, &request.plan_id],
        )?;
        transaction.commit()?;
        self.maintain_wal_after_commit()?;
        Ok(serde_json::json!({
            "planId": request.plan_id,
            "status": "applied",
            "idempotent": false,
            "appliedFiles": applied_files,
            "candidates": candidates,
            "candidateGeneration": generation,
        }))
    }

    fn promoted_candidate_states(
        &self,
        candidate_ids: &[String],
        repository_key: &[u8],
        worktree_key: &[u8],
    ) -> Result<Vec<Value>, MemoryError> {
        let mut candidates = Vec::new();
        for candidate_id in candidate_ids {
            let row: Option<(i64, String)> = self
                .connection
                .query_row(
                    "SELECT revision, status FROM candidates
                     WHERE candidate_id=?1 AND repository_key=?2 AND worktree_key=?3",
                    params![candidate_id, repository_key, worktree_key],
                    |row| Ok((row.get(0)?, row.get(1)?)),
                )
                .optional()?;
            if let Some((revision, status)) = row {
                candidates.push(serde_json::json!({
                    "candidateId": candidate_id,
                    "revision": revision,
                    "status": status,
                }));
            }
        }
        Ok(candidates)
    }

    /// `authorize`: appends one `authorization_log` audit row.
    pub fn authorize(
        &mut self,
        request: &AuthorizeRequest,
        now_unix_ms: i64,
    ) -> Result<Value, MemoryError> {
        self.connection.execute(
            "INSERT INTO authorization_log(
               plan_digest, task_id, runner_input_digest, input_coverage_digest, provider,
               model, endpoint, bytes, decided_at, via, manifest_digest)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11)",
            params![
                hex_blob(&request.plan_digest)?,
                request.task_id,
                request
                    .runner_input_digest
                    .as_deref()
                    .map(hex_blob)
                    .transpose()?,
                request
                    .input_coverage_digest
                    .as_deref()
                    .map(hex_blob)
                    .transpose()?,
                request.provider,
                request.model,
                request.endpoint,
                request.bytes,
                now_unix_ms,
                request.via,
                request
                    .manifest_digest
                    .as_deref()
                    .map(hex_blob)
                    .transpose()?,
            ],
        )?;
        self.maintain_wal_after_commit()?;
        Ok(serde_json::json!({
            "planDigest": request.plan_digest,
            "taskId": request.task_id,
            "via": request.via,
            "decidedAt": now_unix_ms,
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_database_path(label: &str) -> PathBuf {
        static NEXT: std::sync::atomic::AtomicU64 = std::sync::atomic::AtomicU64::new(0);
        let directory = std::env::temp_dir().join(format!(
            "threadshare-memory-wal-{label}-{}-{}",
            std::process::id(),
            NEXT.fetch_add(1, std::sync::atomic::Ordering::Relaxed)
        ));
        std::fs::create_dir_all(&directory).unwrap();
        directory.join("memory-state.sqlite3")
    }

    #[test]
    fn checkpoints_a_persistent_wal_at_write_boundaries() {
        let database_path = temp_database_path("checkpoint");
        let storage = MemoryStorage::open(&database_path).unwrap();
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
        let wal_path = sqlite_sidecar_path(&database_path, "-wal");
        assert!(std::fs::metadata(&wal_path).unwrap().len() > 0);
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
        assert_eq!(std::fs::metadata(&wal_path).unwrap().len(), 0);

        // Below both thresholds nothing happens, and the default write-path
        // maintenance (fixed 64/128 MiB thresholds) is a no-op for small WALs.
        storage
            .connection
            .execute(
                "INSERT INTO wal_pressure_fixture(value) VALUES (zeroblob(64))",
                [],
            )
            .unwrap();
        assert_eq!(
            storage
                .maintain_wal_after_commit_with_thresholds(u64::MAX - 1, u64::MAX)
                .unwrap(),
            WalPressureAction::None
        );
        storage.maintain_wal_after_commit().unwrap();
    }

    #[test]
    fn in_memory_databases_skip_wal_maintenance() {
        let storage = MemoryStorage::open_in_memory().unwrap();
        assert_eq!(
            storage
                .maintain_wal_after_commit_with_thresholds(1, 2)
                .unwrap(),
            WalPressureAction::None
        );
    }
}
