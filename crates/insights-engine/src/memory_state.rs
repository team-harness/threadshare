//! memory-state.sqlite3: lifecycle, schema, and Stage 4a operations for the
//! Team Memory transactional database (design doc
//! `docs/team-memory-phase1-design.md` §2, §3, §8 DEV-5; proposal §5.5).
//!
//! The memory-state database is fully independent from insights.sqlite3: it is
//! a second `rusqlite::Connection` held by the engine server, lazily opened by
//! the `MEMORY_COMMAND{op:"open"}` protocol operation, configured with the same
//! pragma/WAL sequence as the Insights store, and protected with 0600
//! permissions on Unix. Wire shapes are documented in `memory_protocol.rs`.

use rusqlite::{Connection, OptionalExtension, Transaction, TransactionBehavior, params};
use serde_json::Value;
use sha2::{Digest, Sha256};
use std::collections::{BTreeMap, HashMap, HashSet};
use std::fmt;
use std::fs::{File, OpenOptions};
#[cfg(unix)]
use std::os::unix::fs::{OpenOptionsExt, PermissionsExt};
use std::path::{Path, PathBuf};

use fs2::FileExt;

use crate::memory_promotion::{
    ConditionalMutationOutcome, ExpectedWorktreeValue, PromotionFsError,
    cleanup_worktree_mutation_artifacts, conditional_replace_worktree_file, decode_base64,
    git_blob_oid_hex, list_worktree_directory, read_worktree_file,
};
use crate::memory_protocol::{
    AdjudicationDraftOutcome, ApprovedProjectionWire, AuthorizeRequest, BindRepositoryOutcome,
    BindRepositoryRequest, CandidateCountsWire, CandidateProjectionWire, CandidateStateWire,
    ChunkCountsWire, ClaimTaskOutcome, ClaimTaskRequest, ConfirmStatementRequest,
    ConsolidationBaselineRequest, ConsolidationCountsWire, ConsolidationOperationInput,
    DiscardCandidateRequest, ListMemoryFilesRequest, MAX_TEXT_BYTES, MemorySearchRequest,
    MemoryStatusOutcome, MemoryStatusRequest, PlanTasksOutcome, PlanTasksRequest,
    PlannedTaskStateWire, PoolItemWire, PromotionApplyRequest, PromotionApproveRequest,
    PromotionCountsWire, PromotionPlanRequest, ReadMemoryFileRequest, RecallHitWire, RecallOutcome,
    RecallRequest, RecallSetWire, ReviewAssessmentWire, ReviewItemWire, ReviewQueueOutcome,
    ReviewQueueRequest, SearchItemWire, SearchOutcome, SubmitAdjudicationRequest,
    SubmitConsolidationRequest, SubmitExtractionOutcome, SubmitExtractionRequest,
    SyncApprovedRequest, TaskCountsWire, TaskLeaseWire, TaskWire,
};
use crate::storage::{
    WAL_BACKPRESSURE_BYTES, WAL_PASSIVE_CHECKPOINT_BYTES, WalPressureAction,
    persistent_file_permissions, sqlite_sidecar_path, wal_pressure_action,
};
use crate::try_canonical_json;

/// Current memory-state schema version, stored in `memory_state_meta`.
pub const MEMORY_STATE_SCHEMA_VERSION: u32 = 2;

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

/// Promotion policy implemented by this engine build. A plan bound to another
/// policy must be regenerated instead of being interpreted under new rules.
pub const PROMOTION_POLICY_VERSION: &str = "sanitize@1";

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

const MEMORY_STATE_META_SCHEMA: &str = "
CREATE TABLE IF NOT EXISTS memory_state_meta (
  key TEXT PRIMARY KEY, value TEXT NOT NULL
);
";

/// Fresh v2 schema. Existing v1 databases use `migrate_v1_to_v2` instead of
/// running this DDL ahead of version inspection.
const MEMORY_STATE_SCHEMA_V2: &str = "
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
  candidate_kind TEXT NOT NULL DEFAULT 'entry'
    CHECK(candidate_kind IN ('entry','consolidation-patch')),
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
  mutation_phase TEXT NOT NULL DEFAULT 'precheck'
    CHECK(mutation_phase IN ('precheck','mutating','rolling_back','done')),
  updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS promotion_files (
  plan_id TEXT NOT NULL, target_path TEXT NOT NULL,
  target_blob_hash TEXT,
  operation TEXT NOT NULL DEFAULT 'write' CHECK(operation IN ('write','delete')),
  sanitized_content BLOB, sanitized_digest BLOB,
  intent_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(intent_state IN ('pending','intent','applied','rolled_back')),
  originally_present INTEGER CHECK(originally_present IN (0,1)),
  rollback_content BLOB, rollback_digest BLOB,
  legacy_write_only INTEGER NOT NULL DEFAULT 0 CHECK(legacy_write_only IN (0,1)),
  applied INTEGER NOT NULL DEFAULT 0,
  CHECK(
    (operation='write' AND sanitized_content IS NOT NULL AND sanitized_digest IS NOT NULL)
    OR (operation='delete' AND sanitized_content IS NULL AND sanitized_digest IS NULL)
  ),
  CHECK(
    (rollback_content IS NULL AND rollback_digest IS NULL)
    OR (rollback_content IS NOT NULL AND rollback_digest IS NOT NULL)
  ),
  PRIMARY KEY (plan_id, target_path)
);
CREATE TABLE IF NOT EXISTS consolidation_runs (
  run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE,
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  binding_json TEXT NOT NULL, entry_set_digest BLOB NOT NULL,
  candidate_id TEXT UNIQUE, status TEXT NOT NULL
    CHECK(status IN ('pending_review','no_op','applied','stale')),
  entry_count INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS consolidation_run_entries (
  run_id TEXT NOT NULL, entry_id TEXT NOT NULL,
  revision INTEGER NOT NULL, content_digest BLOB NOT NULL,
  PRIMARY KEY (run_id, entry_id)
);
CREATE INDEX IF NOT EXISTS consolidation_runs_owner_status
  ON consolidation_runs(repository_key, worktree_key, status, updated_at, run_id);
CREATE TABLE IF NOT EXISTS authorization_log (
  plan_digest BLOB NOT NULL, task_id TEXT, runner_input_digest BLOB,
  input_coverage_digest BLOB, provider TEXT, model TEXT, endpoint TEXT,
  bytes INTEGER, decided_at INTEGER NOT NULL,
  via TEXT NOT NULL,
  manifest_digest BLOB
);
";

const PROMOTION_FILES_V2_SCHEMA: &str = "
CREATE TABLE promotion_files (
  plan_id TEXT NOT NULL, target_path TEXT NOT NULL,
  target_blob_hash TEXT,
  operation TEXT NOT NULL DEFAULT 'write' CHECK(operation IN ('write','delete')),
  sanitized_content BLOB, sanitized_digest BLOB,
  intent_state TEXT NOT NULL DEFAULT 'pending'
    CHECK(intent_state IN ('pending','intent','applied','rolled_back')),
  originally_present INTEGER CHECK(originally_present IN (0,1)),
  rollback_content BLOB, rollback_digest BLOB,
  legacy_write_only INTEGER NOT NULL DEFAULT 0 CHECK(legacy_write_only IN (0,1)),
  applied INTEGER NOT NULL DEFAULT 0,
  CHECK(
    (operation='write' AND sanitized_content IS NOT NULL AND sanitized_digest IS NOT NULL)
    OR (operation='delete' AND sanitized_content IS NULL AND sanitized_digest IS NULL)
  ),
  CHECK(
    (rollback_content IS NULL AND rollback_digest IS NULL)
    OR (rollback_content IS NOT NULL AND rollback_digest IS NOT NULL)
  ),
  PRIMARY KEY (plan_id, target_path)
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

fn promotion_file_fingerprint(connection: &Connection, table: &str) -> Result<String, MemoryError> {
    let sql = format!(
        "SELECT plan_id, target_path, target_blob_hash, sanitized_content,
                sanitized_digest, applied FROM {table} ORDER BY plan_id, target_path"
    );
    let mut statement = connection.prepare(&sql)?;
    let rows = statement.query_map([], |row| {
        Ok(serde_json::json!({
            "planId": row.get::<_, String>(0)?,
            "targetPath": row.get::<_, String>(1)?,
            "targetBlobHash": row.get::<_, Option<String>>(2)?,
            "sanitizedContent": hex::encode(row.get::<_, Vec<u8>>(3)?),
            "sanitizedDigest": hex::encode(row.get::<_, Vec<u8>>(4)?),
            "applied": row.get::<_, i64>(5)?,
        }))
    })?;
    let values = rows.collect::<Result<Vec<_>, _>>()?;
    canonical_digest_hex(&Value::Array(values))
}

fn migrate_v1_to_v2(transaction: &Transaction<'_>) -> Result<(), MemoryError> {
    let before_count: i64 =
        transaction.query_row("SELECT COUNT(*) FROM promotion_files", [], |row| row.get(0))?;
    let before_fingerprint = promotion_file_fingerprint(transaction, "promotion_files")?;
    transaction.execute_batch("ALTER TABLE promotion_files RENAME TO promotion_files_v1;")?;
    transaction.execute_batch(PROMOTION_FILES_V2_SCHEMA)?;
    transaction.execute_batch(
        "INSERT INTO promotion_files(
           plan_id, target_path, target_blob_hash, operation,
           sanitized_content, sanitized_digest, intent_state,
           originally_present, rollback_content, rollback_digest,
           legacy_write_only, applied)
         SELECT plan_id, target_path, target_blob_hash, 'write',
                sanitized_content, sanitized_digest,
                CASE WHEN applied=1 THEN 'applied' ELSE 'pending' END,
                NULL, NULL, NULL, 1, applied
         FROM promotion_files_v1;
         DROP TABLE promotion_files_v1;
         ALTER TABLE candidates ADD COLUMN candidate_kind TEXT NOT NULL DEFAULT 'entry'
           CHECK(candidate_kind IN ('entry','consolidation-patch'));
         ALTER TABLE promotion_journal ADD COLUMN mutation_phase TEXT NOT NULL DEFAULT 'precheck'
           CHECK(mutation_phase IN ('precheck','mutating','rolling_back','done'));
         UPDATE promotion_journal SET mutation_phase = CASE
           WHEN status IN ('applied','voided') THEN 'done'
           WHEN status='applying' THEN 'mutating'
           ELSE 'precheck' END;
         CREATE TABLE consolidation_runs (
           run_id TEXT PRIMARY KEY, task_id TEXT NOT NULL UNIQUE,
           repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
           binding_json TEXT NOT NULL, entry_set_digest BLOB NOT NULL,
           candidate_id TEXT UNIQUE, status TEXT NOT NULL
             CHECK(status IN ('pending_review','no_op','applied','stale')),
           entry_count INTEGER NOT NULL, created_at INTEGER NOT NULL, updated_at INTEGER NOT NULL
         );
         CREATE TABLE consolidation_run_entries (
           run_id TEXT NOT NULL, entry_id TEXT NOT NULL,
           revision INTEGER NOT NULL, content_digest BLOB NOT NULL,
           PRIMARY KEY (run_id, entry_id)
         );
         CREATE INDEX consolidation_runs_owner_status
           ON consolidation_runs(repository_key, worktree_key, status, updated_at, run_id);",
    )?;
    let after_count: i64 =
        transaction.query_row("SELECT COUNT(*) FROM promotion_files", [], |row| row.get(0))?;
    let after_fingerprint = promotion_file_fingerprint(transaction, "promotion_files")?;
    if before_count != after_count || before_fingerprint != after_fingerprint {
        return Err(MemoryError::new(
            "TS_MEMORY_STATE_CORRUPT",
            "v1 to v2 promotion file migration did not preserve all rows",
        ));
    }
    transaction.execute(
        "UPDATE memory_state_meta SET value=?1 WHERE key='schema_version'",
        [MEMORY_STATE_SCHEMA_VERSION.to_string()],
    )?;
    Ok(())
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

const CONSOLIDATION_HEAT_MAX: i64 = 2_147_483_647;
const CONSOLIDATION_MAX_SCENES: usize = 15;
const CONSOLIDATION_MERGE_PREFERRED_AT: usize = 12;
const CONSOLIDATION_CREATE_FORBIDDEN_AT: usize = 14;

#[derive(Clone)]
struct BoundEntryRevision {
    entry_id: String,
    revision: i64,
    content_digest: Vec<u8>,
}

fn consolidation_invalid(message: impl Into<String>) -> MemoryError {
    MemoryError::new("TS_MEMORY_CONSOLIDATION_INVALID", message)
}

fn binding_drift(message: impl Into<String>) -> MemoryError {
    MemoryError::new("TS_MEMORY_BINDING_DRIFT", message)
}

fn required_object<'a>(
    value: &'a Value,
    key: &str,
) -> Result<&'a serde_json::Map<String, Value>, MemoryError> {
    value
        .get(key)
        .and_then(Value::as_object)
        .ok_or_else(|| binding_drift(format!("consolidation binding.{key} is missing or invalid")))
}

fn required_string<'a>(value: &'a Value, key: &str) -> Result<&'a str, MemoryError> {
    value
        .get(key)
        .and_then(Value::as_str)
        .ok_or_else(|| binding_drift(format!("consolidation binding.{key} is missing or invalid")))
}

fn bound_source_file(root: &Path, path: &str) -> Result<Option<Vec<u8>>, MemoryError> {
    let segments = path.split('/').collect::<Vec<_>>();
    read_worktree_file(root, &segments).map_err(|error| match error {
        PromotionFsError::Symlink => binding_drift(format!(
            "consolidation source {path} contains a symbolic link"
        )),
        PromotionFsError::Io(error) => MemoryError::failed(format!(
            "consolidation source {path} could not be read safely: {error}"
        )),
    })
}

fn bound_digest(value: &Value, label: &str) -> Result<Vec<u8>, MemoryError> {
    value
        .as_str()
        .filter(|digest| {
            digest.len() == 64
                && digest
                    .bytes()
                    .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
        })
        .and_then(|digest| hex::decode(digest).ok())
        .ok_or_else(|| binding_drift(format!("{label} is invalid")))
}

fn approved_source_tree_digest(root: &Path) -> Result<String, MemoryError> {
    let list_names = || {
        list_worktree_directory(root, &[".threadshare", "memory", "entries"])
            .map_err(|error| match error {
                PromotionFsError::Symlink => {
                    binding_drift("the approved-entry directory contains a symbolic link")
                }
                PromotionFsError::Io(error) => MemoryError::failed(format!(
                    "the approved-entry directory could not be listed safely: {error}"
                )),
            })
            .map(|names| {
                names
                    .unwrap_or_default()
                    .into_iter()
                    .filter(|name| name.ends_with(".md"))
                    .collect::<Vec<_>>()
            })
    };
    let names = list_names()?;
    if names.len() > 4096 {
        return Err(binding_drift("the approved-entry file count exceeds 4096"));
    }
    let mut entries = Vec::with_capacity(names.len());
    for name in &names {
        let path = format!(".threadshare/memory/entries/{name}");
        let bytes = bound_source_file(root, &path)?
            .ok_or_else(|| binding_drift("an approved-entry file changed during validation"))?;
        if bytes.len() > MAX_TEXT_BYTES {
            return Err(binding_drift("an approved-entry file exceeds 64 KiB"));
        }
        entries.push(serde_json::json!({
            "path": path,
            "contentDigest": hex::encode(Sha256::digest(&bytes)),
        }));
    }
    if list_names()? != names {
        return Err(binding_drift(
            "the approved-entry file set changed during validation",
        ));
    }
    canonical_digest_hex(&serde_json::json!({
        "format": "threadshare-memory-source-tree@v1",
        "entries": entries,
    }))
}

fn validate_bound_consolidation_sources(root: &Path, binding: &Value) -> Result<(), MemoryError> {
    let projection = required_object(binding, "approvedProjection")?;
    let expected_source_tree_digest = projection
        .get("sourceTreeDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| binding_drift("approvedProjection.sourceTreeDigest is invalid"))?;
    if approved_source_tree_digest(root)? != expected_source_tree_digest {
        return Err(binding_drift(
            "the approved-entry source tree changed after consolidation task assembly",
        ));
    }
    let scene_values = binding
        .get("sceneRevisions")
        .and_then(Value::as_array)
        .ok_or_else(|| binding_drift("sceneRevisions is invalid"))?;
    let expected_names = scene_values
        .iter()
        .map(|value| {
            value
                .get("name")
                .and_then(Value::as_str)
                .map(|name| format!("{name}.md"))
                .ok_or_else(|| binding_drift("sceneRevisions[].name is invalid"))
        })
        .collect::<Result<Vec<_>, _>>()?;
    let actual_names = list_worktree_directory(root, &[".threadshare", "memory", "scenes"])
        .map_err(|error| match error {
            PromotionFsError::Symlink => {
                binding_drift("the bound scene directory contains a symbolic link")
            }
            PromotionFsError::Io(error) => MemoryError::failed(format!(
                "the bound scene directory could not be listed safely: {error}"
            )),
        })?
        .unwrap_or_default()
        .into_iter()
        .filter(|name| name.ends_with(".md"))
        .collect::<Vec<_>>();
    if actual_names != expected_names {
        return Err(binding_drift(
            "the scene file set changed after consolidation task assembly",
        ));
    }
    for value in scene_values {
        let name = value
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| binding_drift("sceneRevisions[].name is invalid"))?;
        let expected_digest = bound_digest(
            value.get("contentDigest").unwrap_or(&Value::Null),
            "sceneRevisions[].contentDigest",
        )?;
        let expected_heat = value
            .get("heat")
            .and_then(Value::as_i64)
            .filter(|heat| (1..=CONSOLIDATION_HEAT_MAX).contains(heat))
            .ok_or_else(|| binding_drift("sceneRevisions[].heat is invalid"))?;
        let path = format!(".threadshare/memory/scenes/{name}.md");
        let bytes = bound_source_file(root, &path)?
            .ok_or_else(|| binding_drift(format!("bound scene {name} is missing")))?;
        if Sha256::digest(&bytes).as_slice() != expected_digest {
            return Err(binding_drift(format!("bound scene {name} changed")));
        }
        let content = std::str::from_utf8(&bytes)
            .map_err(|_| binding_drift(format!("bound scene {name} is not UTF-8")))?;
        let heat = validate_materialized_scene(content)
            .map_err(|_| binding_drift(format!("bound scene {name} is invalid")))?;
        if heat != expected_heat {
            return Err(binding_drift(format!("bound scene {name} heat changed")));
        }
    }

    let doctrine = bound_source_file(root, ".threadshare/memory/doctrine.md")?;
    match binding.get("doctrineDigest") {
        Some(Value::Null) if doctrine.is_none() => {}
        Some(Value::String(_)) => {
            let expected = bound_digest(
                binding.get("doctrineDigest").unwrap_or(&Value::Null),
                "doctrineDigest",
            )?;
            let bytes =
                doctrine.ok_or_else(|| binding_drift("the bound doctrine file is missing"))?;
            if Sha256::digest(&bytes).as_slice() != expected {
                return Err(binding_drift("the bound doctrine file changed"));
            }
            let content = std::str::from_utf8(&bytes)
                .map_err(|_| binding_drift("the bound doctrine file is not UTF-8"))?;
            validate_materialized_doctrine(content)
                .map_err(|_| binding_drift("the bound doctrine file is invalid"))?;
        }
        Some(Value::Null) => {
            return Err(binding_drift(
                "a doctrine file appeared after consolidation task assembly",
            ));
        }
        _ => return Err(binding_drift("doctrineDigest is invalid")),
    }
    Ok(())
}

fn validate_consolidation_candidate_sources(
    connection: &Connection,
    root: &Path,
    candidate_ids: &[String],
) -> Result<(), MemoryError> {
    for candidate_id in candidate_ids {
        let row: Option<(String, String, Vec<u8>, Vec<u8>)> = connection
            .query_row(
                "SELECT candidate_kind, payload_json, repository_key, worktree_key
                 FROM candidates WHERE candidate_id=?1",
                params![candidate_id],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
            )
            .optional()?;
        let Some((candidate_kind, payload_json, repository_key, worktree_key)) = row else {
            continue;
        };
        if candidate_kind == "consolidation-patch" {
            let payload = parse_json(&payload_json);
            let binding = payload
                .get("binding")
                .ok_or_else(|| binding_drift("consolidation candidate binding is missing"))?;
            validate_consolidation_replay_epoch(
                connection,
                binding,
                &repository_key,
                &worktree_key,
            )?;
            validate_bound_consolidation_sources(root, binding)?;
        }
    }
    Ok(())
}

fn valid_iso_date(value: &str) -> bool {
    let bytes = value.as_bytes();
    if bytes.len() != 10 || bytes[4] != b'-' || bytes[7] != b'-' {
        return false;
    }
    let Ok(year) = value[0..4].parse::<u32>() else {
        return false;
    };
    let Ok(month) = value[5..7].parse::<u32>() else {
        return false;
    };
    let Ok(day) = value[8..10].parse::<u32>() else {
        return false;
    };
    let leap = year.is_multiple_of(4) && (!year.is_multiple_of(100) || year.is_multiple_of(400));
    let days = match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if leap => 29,
        2 => 28,
        _ => return false,
    };
    (1..=days).contains(&day)
}

fn normalize_consolidation_text(value: &str) -> Result<String, MemoryError> {
    if value.starts_with('\u{feff}') {
        return Err(consolidation_invalid(
            "consolidation content contains a BOM",
        ));
    }
    let lf = value.replace("\r\n", "\n");
    if lf.contains('\r') {
        return Err(consolidation_invalid(
            "consolidation content contains a bare carriage return",
        ));
    }
    Ok(lf
        .split('\n')
        .map(|line| line.trim_end_matches([' ', '\t']))
        .collect::<Vec<_>>()
        .join("\n"))
}

fn validate_materialized_scene(content: &str) -> Result<i64, MemoryError> {
    if normalize_consolidation_text(content)? != content {
        return Err(consolidation_invalid(
            "scene content is not in normalized canonical form",
        ));
    }
    let lines = content.split('\n').collect::<Vec<_>>();
    if lines.len() < 6
        || lines[0] != "-----META-START-----"
        || lines[5] != "-----META-END-----"
        || !lines[1].starts_with("created: ")
        || !lines[2].starts_with("updated: ")
        || !lines[3].starts_with("summary: ")
        || !lines[4].starts_with("heat: ")
    {
        return Err(consolidation_invalid(
            "scene content does not use canonical META field order",
        ));
    }
    if !valid_iso_date(&lines[1][9..]) || !valid_iso_date(&lines[2][9..]) {
        return Err(consolidation_invalid(
            "scene dates must be valid YYYY-MM-DD dates",
        ));
    }
    let summary: String = serde_json::from_str(&lines[3][9..])
        .map_err(|_| consolidation_invalid("scene summary must be a canonical JSON string"))?;
    if summary.is_empty() || summary.chars().count() > 40 {
        return Err(consolidation_invalid(
            "scene summary must contain between 1 and 40 code points",
        ));
    }
    let heat = lines[4][6..]
        .parse::<i64>()
        .map_err(|_| consolidation_invalid("scene heat must be an integer"))?;
    if !(1..=CONSOLIDATION_HEAT_MAX).contains(&heat) {
        return Err(consolidation_invalid(
            "scene heat is outside the supported range",
        ));
    }
    let body = lines[6..].join("\n");
    if body.chars().count() > 1500 {
        return Err(consolidation_invalid("scene body exceeds 1500 code points"));
    }
    Ok(heat)
}

fn validate_materialized_doctrine(content: &str) -> Result<(), MemoryError> {
    if normalize_consolidation_text(content)? != content {
        return Err(consolidation_invalid(
            "doctrine content is not in normalized canonical form",
        ));
    }
    if content.is_empty() || content.chars().count() > 1200 {
        return Err(consolidation_invalid(
            "doctrine must contain between 1 and 1200 code points",
        ));
    }
    Ok(())
}

fn rationale_states_cannot_fit(value: &str) -> bool {
    let lower = value.to_lowercase();
    let cannot = lower.contains("cannot") || lower.contains("can't") || lower.contains("unable to");
    let fit = lower.contains("fit")
        || lower.contains("merge")
        || lower.contains("fold")
        || lower.contains("incorporat");
    (cannot && fit)
        || ((value.contains("无法") || value.contains("不能"))
            && (value.contains("并入") || value.contains("合并") || value.contains("纳入")))
}

fn checked_heat_add(left: i64, right: i64) -> Result<i64, MemoryError> {
    left.checked_add(right)
        .filter(|value| *value <= CONSOLIDATION_HEAT_MAX)
        .ok_or_else(|| consolidation_invalid("scene heat overflowed"))
}

fn validate_consolidation_replay_epoch(
    connection: &Connection,
    binding: &Value,
    repository_key: &[u8],
    worktree_key: &[u8],
) -> Result<(), MemoryError> {
    let replay = required_object(binding, "replay")?;
    if !matches!(
        replay.get("mode").and_then(Value::as_str),
        Some("incremental" | "full")
    ) {
        return Err(binding_drift("consolidation replay mode is invalid"));
    }
    let bound_after_run = match replay.get("afterSuccessfulRunId") {
        Some(Value::Null) => None,
        Some(Value::String(value)) if !value.is_empty() && value.len() <= 256 => {
            Some(value.as_str())
        }
        _ => return Err(binding_drift("consolidation replay epoch is invalid")),
    };
    let current_after_run: Option<String> = connection
        .query_row(
            "SELECT run_id FROM consolidation_runs
             WHERE repository_key=?1 AND worktree_key=?2
               AND status IN ('no_op','applied')
             ORDER BY updated_at DESC, run_id DESC LIMIT 1",
            params![repository_key, worktree_key],
            |row| row.get(0),
        )
        .optional()?;
    if current_after_run.as_deref() != bound_after_run {
        return Err(binding_drift(
            "the successful consolidation baseline advanced after task assembly",
        ));
    }
    Ok(())
}

fn validate_consolidation_binding(
    connection: &Connection,
    task: &TaskRow,
    operations: &[ConsolidationOperationInput],
) -> Result<Vec<BoundEntryRevision>, MemoryError> {
    let binding = parse_json(&task.binding_json);
    let owner = required_object(&binding, "owner")?;
    let repository_key = owner
        .get("repositoryKey")
        .and_then(Value::as_str)
        .ok_or_else(|| binding_drift("consolidation binding owner is invalid"))?;
    let worktree_key = owner
        .get("worktreeKey")
        .and_then(Value::as_str)
        .ok_or_else(|| binding_drift("consolidation binding owner is invalid"))?;
    if hex_blob(repository_key)? != task.repository_key
        || hex_blob(worktree_key)? != task.worktree_key
    {
        return Err(binding_drift("consolidation owner changed"));
    }
    let root_realpath: Option<String> = connection
        .query_row(
            "SELECT root_realpath FROM repository_bindings
             WHERE repository_key=?1 AND worktree_key=?2 AND status='active'",
            params![&task.repository_key, &task.worktree_key],
            |row| row.get(0),
        )
        .optional()?;
    let root_realpath = root_realpath
        .ok_or_else(|| binding_drift("the consolidation owner has no active repository binding"))?;
    if required_string(&binding, "memoryStateUuid")?
        != connection.query_row(
            "SELECT value FROM memory_state_meta WHERE key='memoryStateUuid'",
            [],
            |row| row.get::<_, String>(0),
        )?
    {
        return Err(binding_drift("memory-state UUID changed"));
    }
    if required_string(&binding, "schemaVersion")? != "threadshare-memory-consolidation-task@v1" {
        return Err(binding_drift("consolidation schema version is unsupported"));
    }

    validate_consolidation_replay_epoch(
        connection,
        &binding,
        &task.repository_key,
        &task.worktree_key,
    )?;

    let projection = required_object(&binding, "approvedProjection")?;
    let expected_generation = projection
        .get("generation")
        .and_then(Value::as_i64)
        .ok_or_else(|| binding_drift("approved projection generation is invalid"))?;
    let expected_source_digest = projection
        .get("sourceTreeDigest")
        .and_then(Value::as_str)
        .ok_or_else(|| binding_drift("approved projection source digest is invalid"))?;
    if projection.get("coverage").and_then(Value::as_str) != Some("complete") {
        return Err(binding_drift(
            "approved projection coverage is not complete",
        ));
    }
    let current_projection: Option<(i64, Vec<u8>, String)> = connection
        .query_row(
            "SELECT generation, source_tree_digest, coverage FROM approved_projection
             WHERE repository_key=?1 AND worktree_key=?2",
            params![&task.repository_key, &task.worktree_key],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .optional()?;
    let Some((generation, source_digest, coverage)) = current_projection else {
        return Err(binding_drift("approved projection no longer exists"));
    };
    if generation != expected_generation
        || hex::encode(source_digest) != expected_source_digest
        || coverage != "complete"
    {
        return Err(binding_drift(
            "approved projection changed after task assembly",
        ));
    }

    let entry_values = binding
        .get("entryRevisions")
        .and_then(Value::as_array)
        .ok_or_else(|| binding_drift("entryRevisions is invalid"))?;
    if canonical_digest_hex(&Value::Array(entry_values.clone()))?
        != required_string(&binding, "entrySetDigest")?
    {
        return Err(binding_drift(
            "entry-set digest does not match entryRevisions",
        ));
    }
    let mut entries = Vec::new();
    let mut previous_entry_id: Option<&str> = None;
    for value in entry_values {
        let object = value
            .as_object()
            .ok_or_else(|| binding_drift("entryRevisions contains a non-object"))?;
        let entry_id = object
            .get("entryId")
            .and_then(Value::as_str)
            .ok_or_else(|| binding_drift("entryRevisions[].entryId is invalid"))?;
        if previous_entry_id.is_some_and(|previous| previous >= entry_id) {
            return Err(binding_drift(
                "entryRevisions must be unique and sorted by entryId",
            ));
        }
        previous_entry_id = Some(entry_id);
        let revision = object
            .get("revision")
            .and_then(Value::as_i64)
            .ok_or_else(|| binding_drift("entryRevisions[].revision is invalid"))?;
        let content_digest = hex_blob(
            object
                .get("contentDigest")
                .and_then(Value::as_str)
                .ok_or_else(|| binding_drift("entryRevisions[].contentDigest is invalid"))?,
        )?;
        let current: Option<(i64, Vec<u8>)> = connection
            .query_row(
                "SELECT revision, content_digest FROM approved_entries
                 WHERE entry_id=?1 AND repository_key=?2 AND worktree_key=?3",
                params![entry_id, &task.repository_key, &task.worktree_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        if current.as_ref() != Some(&(revision, content_digest.clone())) {
            return Err(binding_drift(format!("approved entry {entry_id} changed")));
        }
        entries.push(BoundEntryRevision {
            entry_id: entry_id.to_owned(),
            revision,
            content_digest,
        });
    }

    let scene_values = binding
        .get("sceneRevisions")
        .and_then(Value::as_array)
        .ok_or_else(|| binding_drift("sceneRevisions is invalid"))?;
    if canonical_digest_hex(&Value::Array(scene_values.clone()))?
        != required_string(&binding, "sceneIndexDigest")?
    {
        return Err(binding_drift(
            "scene-index digest does not match sceneRevisions",
        ));
    }
    let mut scenes = HashMap::new();
    let mut previous_scene_name: Option<&str> = None;
    for value in scene_values {
        let object = value
            .as_object()
            .ok_or_else(|| binding_drift("sceneRevisions contains a non-object"))?;
        let name = object
            .get("name")
            .and_then(Value::as_str)
            .ok_or_else(|| binding_drift("sceneRevisions[].name is invalid"))?;
        if previous_scene_name.is_some_and(|previous| previous >= name) {
            return Err(binding_drift(
                "sceneRevisions must be unique and sorted by name",
            ));
        }
        previous_scene_name = Some(name);
        let heat = object
            .get("heat")
            .and_then(Value::as_i64)
            .filter(|heat| (1..=CONSOLIDATION_HEAT_MAX).contains(heat))
            .ok_or_else(|| binding_drift("sceneRevisions[].heat is invalid"))?;
        scenes.insert(name.to_owned(), heat);
    }
    validate_bound_consolidation_sources(Path::new(&root_realpath), &binding)?;
    validate_consolidation_operations(&binding, operations, &entries, &scenes)?;
    Ok(entries)
}

fn validate_consolidation_operations(
    binding: &Value,
    operations: &[ConsolidationOperationInput],
    entries: &[BoundEntryRevision],
    scenes: &HashMap<String, i64>,
) -> Result<(), MemoryError> {
    let entry_ids = entries
        .iter()
        .map(|entry| entry.entry_id.as_str())
        .collect::<HashSet<_>>();
    let doctrine_present = !binding.get("doctrineDigest").is_none_or(Value::is_null);
    let mut operation_ids = HashSet::new();
    let mut primary_paths: HashMap<String, &str> = HashMap::new();
    let mut merge_sources: HashMap<String, &str> = HashMap::new();
    let mut doctrine_count = 0usize;
    let mut create_count = 0usize;

    for operation in operations {
        if !operation_ids.insert(operation.operation_id.as_str()) {
            return Err(consolidation_invalid("operationId values must be unique"));
        }
        let path = if operation.target == "doctrine" {
            ".threadshare/memory/doctrine.md".to_owned()
        } else {
            format!(".threadshare/memory/scenes/{}.md", operation.name)
        };
        if primary_paths
            .insert(path.clone(), operation.operation_id.as_str())
            .is_some()
        {
            return Err(consolidation_invalid(format!(
                "multiple operations target {path}"
            )));
        }
        let mut based_on = HashSet::new();
        for entry_id in &operation.based_on_entry_ids {
            if !entry_ids.contains(entry_id.as_str()) {
                return Err(consolidation_invalid(format!(
                    "operation {} references unknown entry {entry_id}",
                    operation.operation_id
                )));
            }
            if !based_on.insert(entry_id) {
                return Err(consolidation_invalid("basedOnEntryIds contains duplicates"));
            }
        }
        let writes = operation.op != "delete";
        if writes && (operation.new_content.is_none() || operation.based_on_entry_ids.is_empty()) {
            return Err(consolidation_invalid(
                "create/update/merge require content and at least one entry",
            ));
        }
        if !writes && operation.new_content.is_some() {
            return Err(consolidation_invalid("delete requires null newContent"));
        }

        if operation.target == "doctrine" {
            doctrine_count += 1;
            if operation.name != "doctrine"
                || operation.op == "merge"
                || !operation.merge_sources.is_empty()
            {
                return Err(consolidation_invalid("doctrine operation shape is invalid"));
            }
            if (operation.op == "create") == doctrine_present {
                return Err(consolidation_invalid(
                    "doctrine create/update/delete target state is invalid",
                ));
            }
            if writes {
                validate_materialized_doctrine(operation.new_content.as_deref().unwrap())?;
            }
            continue;
        }

        if operation.op == "create" {
            create_count += 1;
            if scenes.contains_key(&operation.name) {
                return Err(consolidation_invalid("create target already exists"));
            }
        } else if matches!(operation.op.as_str(), "update" | "delete")
            && !scenes.contains_key(&operation.name)
        {
            return Err(consolidation_invalid("update/delete target does not exist"));
        }
        if operation.op != "merge" && !operation.merge_sources.is_empty() {
            return Err(consolidation_invalid("only merge may contain mergeSources"));
        }

        let expected_heat = match operation.op.as_str() {
            "create" => Some(1),
            "update" => Some(checked_heat_add(scenes[&operation.name], 1)?),
            "merge" => {
                if operation.merge_sources.len() < 2 {
                    return Err(consolidation_invalid("merge requires at least two sources"));
                }
                let mut unique_sources = HashSet::new();
                let mut heat = 1;
                for source in &operation.merge_sources {
                    let scene = scenes.get(source).ok_or_else(|| {
                        consolidation_invalid(format!("merge source {source} does not exist"))
                    })?;
                    if !unique_sources.insert(source) {
                        return Err(consolidation_invalid("mergeSources contains duplicates"));
                    }
                    heat = checked_heat_add(heat, *scene)?;
                    let source_path = format!(".threadshare/memory/scenes/{source}.md");
                    if merge_sources
                        .insert(source_path, operation.operation_id.as_str())
                        .is_some()
                    {
                        return Err(consolidation_invalid("a scene is used by multiple merges"));
                    }
                }
                if scenes.contains_key(&operation.name)
                    && !operation.merge_sources.contains(&operation.name)
                {
                    return Err(consolidation_invalid(
                        "an existing merge target must be one of the merge sources",
                    ));
                }
                Some(heat)
            }
            "delete" => None,
            _ => return Err(consolidation_invalid("unknown operation")),
        };
        if let Some(expected_heat) = expected_heat {
            let actual_heat =
                validate_materialized_scene(operation.new_content.as_deref().unwrap())?;
            if actual_heat != expected_heat {
                return Err(consolidation_invalid(format!(
                    "operation {} has heat {actual_heat}, expected {expected_heat}",
                    operation.operation_id
                )));
            }
        }
    }
    if doctrine_count > 1 || create_count > 1 {
        return Err(consolidation_invalid(
            "a patch may contain at most one doctrine operation and one scene create",
        ));
    }
    for (source_path, owner) in merge_sources {
        if primary_paths
            .get(&source_path)
            .is_some_and(|primary| *primary != owner)
        {
            return Err(consolidation_invalid(
                "a merge source is changed by another operation",
            ));
        }
    }

    let mut final_scenes = scenes.keys().cloned().collect::<HashSet<_>>();
    for operation in operations
        .iter()
        .filter(|operation| operation.target == "scene")
    {
        match operation.op.as_str() {
            "create" => {
                final_scenes.insert(operation.name.clone());
            }
            "delete" => {
                final_scenes.remove(&operation.name);
            }
            "merge" => {
                for source in &operation.merge_sources {
                    final_scenes.remove(source);
                }
                final_scenes.insert(operation.name.clone());
            }
            _ => {}
        }
    }
    if scenes.len() >= CONSOLIDATION_CREATE_FORBIDDEN_AT && create_count > 0 {
        return Err(consolidation_invalid(
            "scene creation is forbidden at this capacity",
        ));
    }
    if scenes.len() >= CONSOLIDATION_MERGE_PREFERRED_AT {
        for operation in operations
            .iter()
            .filter(|operation| operation.op == "create")
        {
            if !rationale_states_cannot_fit(&operation.rationale) {
                return Err(consolidation_invalid(
                    "scene creation must explain why it cannot fit an existing scene",
                ));
            }
        }
    }
    if final_scenes.len() > CONSOLIDATION_MAX_SCENES
        || (scenes.len() >= CONSOLIDATION_MAX_SCENES
            && (final_scenes.len() >= CONSOLIDATION_MAX_SCENES
                || !operations
                    .iter()
                    .any(|operation| matches!(operation.op.as_str(), "merge" | "delete"))))
    {
        return Err(consolidation_invalid(
            "patch does not satisfy scene capacity policy",
        ));
    }
    Ok(())
}

fn validate_consolidation_assessments(
    request: &SubmitConsolidationRequest,
    entries: &[BoundEntryRevision],
) -> Result<(), MemoryError> {
    let entry_by_id = entries
        .iter()
        .map(|entry| (entry.entry_id.as_str(), entry))
        .collect::<HashMap<_, _>>();
    let assessment_by_statement = request
        .assessments
        .iter()
        .map(|assessment| (assessment.statement_id.as_str(), assessment))
        .collect::<HashMap<_, _>>();
    if assessment_by_statement.len() != request.operations.len() {
        return Err(consolidation_invalid(
            "operations and assessments must be one-to-one",
        ));
    }
    for operation in &request.operations {
        let assessment = assessment_by_statement
            .get(operation.operation_id.as_str())
            .ok_or_else(|| consolidation_invalid("operation has no assessment"))?;
        let operation_value = serde_json::to_value(operation)
            .map_err(|error| MemoryError::failed(error.to_string()))?;
        if canonical_digest_hex(&operation_value)? != assessment.statement_text_digest {
            return Err(consolidation_invalid(
                "assessment statementTextDigest does not bind the materialized operation",
            ));
        }
        let mut entry_ids = operation.based_on_entry_ids.clone();
        entry_ids.sort();
        let citations = entry_ids
            .into_iter()
            .map(|entry_id| {
                let entry = entry_by_id[entry_id.as_str()];
                serde_json::json!({
                    "entryId": entry.entry_id,
                    "revision": entry.revision,
                    "contentDigest": hex::encode(&entry.content_digest),
                })
            })
            .collect::<Vec<_>>();
        if canonical_digest_hex(&Value::Array(citations))? != assessment.citations_digest
            || assessment.provenance_strength != "contextual"
            || assessment.claim_support != "unverified"
            || assessment.assessed_by != "deterministic"
            || assessment.revision != 1
            || assessment.limitations
                != [
                    "generated-consolidation-content",
                    "source-approved-memory-only",
                ]
        {
            return Err(consolidation_invalid(
                "assessment does not match the deterministic consolidation evidence policy",
            ));
        }
    }
    Ok(())
}

fn build_consolidation_payload(
    run_id: &str,
    binding: &Value,
    operations: &[ConsolidationOperationInput],
) -> Result<Value, MemoryError> {
    let operation_values = operations
        .iter()
        .map(serde_json::to_value)
        .collect::<Result<Vec<_>, _>>()
        .map_err(|error| MemoryError::failed(error.to_string()))?;
    let statements = operations
        .iter()
        .zip(operation_values.iter())
        .map(|(operation, value)| {
            serde_json::json!({
                "statementId": operation.operation_id,
                "operation": value,
            })
        })
        .collect::<Vec<_>>();
    Ok(serde_json::json!({
        "candidateKind": "consolidation-patch",
        "runId": run_id,
        "binding": binding,
        "operations": operation_values,
        "statements": statements,
    }))
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
        mut connection: Connection,
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
        connection.execute_batch(MEMORY_STATE_META_SCHEMA)?;
        let stored_version: Option<String> = connection
            .query_row(
                "SELECT value FROM memory_state_meta WHERE key='schema_version'",
                [],
                |row| row.get(0),
            )
            .optional()?;
        match stored_version.as_deref() {
            None => {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                transaction.execute_batch(MEMORY_STATE_SCHEMA_V2)?;
                let candidate = new_memory_state_uuid(&transaction)?;
                transaction.execute(
                    "INSERT INTO memory_state_meta(key, value) VALUES ('memoryStateUuid', ?1)",
                    [candidate],
                )?;
                transaction.execute(
                    "INSERT INTO memory_state_meta(key, value) VALUES ('schema_version', ?1)",
                    [MEMORY_STATE_SCHEMA_VERSION.to_string()],
                )?;
                transaction.commit()?;
            }
            Some("1") => {
                let transaction =
                    connection.transaction_with_behavior(TransactionBehavior::Immediate)?;
                migrate_v1_to_v2(&transaction)?;
                transaction.commit()?;
            }
            Some("2") => {}
            Some(other) => {
                return Err(MemoryError::new(
                    "TS_MEMORY_STATE_CORRUPT",
                    format!("unsupported memory-state schema version {other}"),
                ));
            }
        }
        // Idempotently ensure every recognized-v2 object exists only after the
        // version decision/migration has committed.
        connection.execute_batch(MEMORY_STATE_SCHEMA_V2)?;
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

    fn acquire_promotion_apply_lock(&self) -> Result<Option<File>, MemoryError> {
        let Some(database_path) = &self.database_path else {
            return Ok(None);
        };
        let lock_path = sqlite_sidecar_path(database_path, "-promotion.lock");
        let mut options = OpenOptions::new();
        options.read(true).write(true).create(true).truncate(false);
        #[cfg(unix)]
        options.mode(0o600).custom_flags(libc::O_NOFOLLOW);
        let file = options.open(&lock_path).map_err(|error| {
            MemoryError::failed(format!(
                "the promotion apply lock could not be opened: {error}"
            ))
        })?;
        if !file.metadata()?.is_file() {
            return Err(MemoryError::failed(
                "the promotion apply lock is not a regular file",
            ));
        }
        #[cfg(unix)]
        file.set_permissions(std::fs::Permissions::from_mode(0o600))?;
        match FileExt::try_lock_exclusive(&file) {
            Ok(()) => Ok(Some(file)),
            Err(error) if error.kind() == std::io::ErrorKind::WouldBlock => Err(MemoryError::new(
                "TS_MEMORY_PLAN_STATE_INVALID",
                "another promotion apply is active; retry after it finishes",
            )),
            Err(error) => Err(MemoryError::failed(format!(
                "the promotion apply lock could not be acquired: {error}"
            ))),
        }
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

    fn active_memory_root(
        &self,
        repository_key: &str,
        worktree_key: &str,
    ) -> Result<PathBuf, MemoryError> {
        let repository_key = hex_blob(repository_key)?;
        let worktree_key = hex_blob(worktree_key)?;
        let row: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT root_realpath, memory_root FROM repository_bindings
                 WHERE repository_key=?1 AND worktree_key=?2 AND status='active'",
                params![repository_key, worktree_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (root_realpath, memory_root) = row.ok_or_else(|| {
            MemoryError::new(
                "TS_MEMORY_BINDING_NOT_FOUND",
                "the owner has no active repository binding",
            )
        })?;
        if memory_root != ".threadshare/memory" {
            return Err(MemoryError::new(
                "TS_MEMORY_STATE_CORRUPT",
                "the repository binding has an unsupported memory root",
            ));
        }
        Ok(PathBuf::from(root_realpath))
    }

    /// Host-only descriptor-relative directory listing. This op is not
    /// exposed through MCP and never grants the Runner a filesystem tool.
    pub fn list_memory_files(
        &self,
        request: &ListMemoryFilesRequest,
    ) -> Result<Value, MemoryError> {
        let root = self.active_memory_root(&request.repository_key, &request.worktree_key)?;
        let segments = [".threadshare", "memory", request.collection.as_str()];
        let mut names = list_worktree_directory(&root, &segments)
            .map_err(|error| match error {
                PromotionFsError::Symlink => {
                    binding_drift("the requested memory directory contains a symbolic link")
                }
                PromotionFsError::Io(error) => MemoryError::failed(format!(
                    "the requested memory directory could not be listed safely: {error}"
                )),
            })?
            .unwrap_or_default()
            .into_iter()
            .filter(|name| name.ends_with(".md"))
            .collect::<Vec<_>>();
        names.sort();
        if names.len() > 4096 {
            return Err(binding_drift(
                "the requested memory directory exceeds 4096 files",
            ));
        }
        Ok(serde_json::json!({ "names": names }))
    }

    /// Host-only descriptor-relative read constrained to the three public
    /// Team Memory collections. Every path component is opened no-follow.
    pub fn read_memory_file(&self, request: &ReadMemoryFileRequest) -> Result<Value, MemoryError> {
        let root = self.active_memory_root(&request.repository_key, &request.worktree_key)?;
        let mut segments = vec![".threadshare", "memory", request.collection.as_str()];
        if let Some(name) = request.name.as_deref() {
            segments.push(name);
        } else {
            segments.pop();
            segments.push("doctrine.md");
        }
        let bytes = read_worktree_file(&root, &segments).map_err(|error| match error {
            PromotionFsError::Symlink => {
                binding_drift("the requested memory file path contains a symbolic link")
            }
            PromotionFsError::Io(error) => MemoryError::failed(format!(
                "the requested memory file could not be read safely: {error}"
            )),
        })?;
        let Some(bytes) = bytes else {
            return Ok(serde_json::json!({ "content": null }));
        };
        if bytes.len() > MAX_TEXT_BYTES {
            return Err(binding_drift("the requested memory file exceeds 64 KiB"));
        }
        let content = String::from_utf8(bytes)
            .map_err(|_| binding_drift("the requested memory file is not valid UTF-8"))?;
        Ok(serde_json::json!({ "content": content }))
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

    /// `submit-consolidation`: lease/submission CAS, authoritative binding and
    /// policy validation, full run entry-set persistence, and either a visible
    /// no-op baseline or one quarantined consolidation candidate.
    pub fn submit_consolidation(
        &mut self,
        request: &SubmitConsolidationRequest,
        now_unix_ms: i64,
    ) -> Result<Value, MemoryError> {
        let response_digest = hex_blob(&request.response_digest)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let task = read_task(&transaction, &request.task_id)?.ok_or_else(|| {
            MemoryError::new("TS_MEMORY_TASK_NOT_FOUND", "the task does not exist")
        })?;
        if task.kind != "consolidation" {
            return Err(MemoryError::invalid("the task is not a consolidation task"));
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

        let entries = validate_consolidation_binding(&transaction, &task, &request.operations)?;
        validate_consolidation_assessments(request, &entries)?;
        let binding = parse_json(&task.binding_json);
        let entry_set_digest = hex_blob(required_string(&binding, "entrySetDigest")?)?;
        let candidate_payload = if request.operations.is_empty() {
            None
        } else {
            Some(build_consolidation_payload(
                &request.run_id,
                &binding,
                &request.operations,
            )?)
        };
        transaction.execute(
            "INSERT INTO consolidation_runs(
               run_id, task_id, repository_key, worktree_key, binding_json,
               entry_set_digest, candidate_id, status, entry_count, created_at, updated_at)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?10)",
            params![
                &request.run_id,
                &task.task_id,
                &task.repository_key,
                &task.worktree_key,
                &task.binding_json,
                entry_set_digest,
                &request.candidate_id,
                if request.operations.is_empty() {
                    "no_op"
                } else {
                    "pending_review"
                },
                entries.len() as i64,
                now_unix_ms,
            ],
        )?;
        for entry in &entries {
            transaction.execute(
                "INSERT INTO consolidation_run_entries(run_id, entry_id, revision, content_digest)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    &request.run_id,
                    &entry.entry_id,
                    entry.revision,
                    &entry.content_digest
                ],
            )?;
        }

        let candidate = if let (Some(candidate_id), Some(payload)) =
            (request.candidate_id.as_ref(), candidate_payload.as_ref())
        {
            let payload_json = canonical(payload)?;
            let content_digest = Sha256::digest(payload_json.as_bytes()).to_vec();
            transaction.execute(
                "INSERT INTO candidates(
                   candidate_id, repository_key, worktree_key, chunk_ref, revision,
                   content_digest, payload_json, candidate_kind, status, adjudication, updated_at)
                 VALUES (?1, ?2, ?3, ?4, 1, ?5, ?6, 'consolidation-patch',
                   'quarantined', 'applied', ?7)",
                params![
                    candidate_id,
                    &task.repository_key,
                    &task.worktree_key,
                    &request.run_id,
                    &content_digest,
                    payload_json,
                    now_unix_ms,
                ],
            )?;
            for assessment in &request.assessments {
                transaction.execute(
                    "INSERT INTO assessments(
                       candidate_id, statement_id, citations_digest, provenance_strength,
                       limitations_json, claim_support, assessed_by, statement_text_digest,
                       revision)
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                    params![
                        &assessment.candidate_id,
                        &assessment.statement_id,
                        hex_blob(&assessment.citations_digest)?,
                        &assessment.provenance_strength,
                        canonical(&serde_json::json!(&assessment.limitations))?,
                        &assessment.claim_support,
                        &assessment.assessed_by,
                        hex_blob(&assessment.statement_text_digest)?,
                        assessment.revision,
                    ],
                )?;
            }
            Some(CandidateStateWire {
                candidate_id: candidate_id.clone(),
                revision: 1,
                content_digest: hex::encode(content_digest),
                status: "quarantined".to_owned(),
            })
        } else {
            None
        };
        let candidate_generation = if candidate.is_some() {
            bump_candidate_generation(&transaction, &task.repository_key, &task.worktree_key)?
        } else {
            read_candidate_projection(&transaction, &task.repository_key, &task.worktree_key)?
                .generation
        };
        transaction.execute(
            "UPDATE tasks SET status='submitted' WHERE task_id=?1",
            params![&task.task_id],
        )?;
        let outcome = serde_json::json!({
            "taskId": task.task_id,
            "runId": request.run_id,
            "status": if candidate.is_some() { "pending_review" } else { "no_op" },
            "idempotent": false,
            "candidate": candidate,
            "candidateGeneration": candidate_generation,
            "entryCount": entries.len(),
        });
        record_submission(
            &transaction,
            &request.task_id,
            &response_digest,
            &outcome,
            now_unix_ms,
        )?;
        transaction.commit()?;
        self.maintain_wal_after_commit()?;
        Ok(outcome)
    }

    /// Successful baseline for incremental task assembly. Pending/stale runs
    /// never advance this result; `--full` callers intentionally ignore it.
    pub fn consolidation_baseline(
        &self,
        request: &ConsolidationBaselineRequest,
    ) -> Result<Value, MemoryError> {
        let repository_key = hex_blob(&request.repository_key)?;
        let worktree_key = hex_blob(&request.worktree_key)?;
        let successful: Option<(String, String)> = self
            .connection
            .query_row(
                "SELECT run_id, status FROM consolidation_runs
                 WHERE repository_key=?1 AND worktree_key=?2
                   AND status IN ('no_op','applied')
                 ORDER BY updated_at DESC, run_id DESC LIMIT 1",
                params![&repository_key, &worktree_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let pending_run_id: Option<String> = self
            .connection
            .query_row(
                "SELECT run_id FROM consolidation_runs
                 WHERE repository_key=?1 AND worktree_key=?2 AND status='pending_review'
                 ORDER BY updated_at DESC, run_id DESC LIMIT 1",
                params![&repository_key, &worktree_key],
                |row| row.get(0),
            )
            .optional()?;
        let mut entries = Vec::new();
        if successful.is_some() {
            let mut statement = self.connection.prepare(
                "SELECT e.entry_id, e.revision, e.content_digest
                 FROM consolidation_run_entries e
                 JOIN consolidation_runs r ON r.run_id=e.run_id
                 WHERE r.repository_key=?1 AND r.worktree_key=?2
                   AND r.status IN ('no_op','applied')
                 ORDER BY r.updated_at, r.run_id, e.entry_id",
            )?;
            let rows = statement.query_map(params![&repository_key, &worktree_key], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, Vec<u8>>(2)?,
                ))
            })?;
            let mut latest = BTreeMap::new();
            for row in rows {
                let (entry_id, revision, content_digest) = row?;
                latest.insert(entry_id, (revision, content_digest));
            }
            entries = latest
                .into_iter()
                .map(|(entry_id, (revision, content_digest))| {
                    serde_json::json!({
                        "entryId": entry_id,
                        "revision": revision,
                        "contentDigest": hex::encode(content_digest),
                    })
                })
                .collect();
        }
        Ok(serde_json::json!({
            "successfulRunId": successful.as_ref().map(|(run_id, _)| run_id),
            "entries": entries,
            "pendingRunId": pending_run_id,
            "lastSuccessfulNoOp": successful.as_ref().is_some_and(|(_, status)| status == "no_op"),
        }))
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
                        require_candidate_mutable(&transaction, &target.id)?;
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
        let candidate_kind = if request.kind == "consolidation" {
            "consolidation-patch"
        } else {
            "entry"
        };
        let mut statement = self.connection.prepare(
            "SELECT candidate_id, candidate_kind, chunk_ref, revision, content_digest, payload_json
             FROM candidates
             WHERE repository_key=?1 AND worktree_key=?2 AND status='quarantined'
               AND candidate_kind=?3
             ORDER BY candidate_id LIMIT ?4",
        )?;
        let rows = statement.query_map(
            params![
                &repository_key,
                &worktree_key,
                candidate_kind,
                i64::from(request.limit)
            ],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, Vec<u8>>(4)?,
                    row.get::<_, String>(5)?,
                ))
            },
        )?;
        let mut items = Vec::new();
        for row in rows {
            let (candidate_id, candidate_kind, chunk_ref, revision, content_digest, payload_json) =
                row?;
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
                candidate_kind,
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
        let last_successful: Option<(i64, String)> = self
            .connection
            .query_row(
                "SELECT entry_count, status FROM consolidation_runs
                 WHERE repository_key=?1 AND worktree_key=?2
                   AND status IN ('no_op','applied')
                 ORDER BY updated_at DESC, run_id DESC LIMIT 1",
                params![&repository_key, &worktree_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let consolidations = ConsolidationCountsWire {
            pending_review: count("consolidation_runs", "pending_review")?,
            no_op: count("consolidation_runs", "no_op")?,
            applied: count("consolidation_runs", "applied")?,
            stale: count("consolidation_runs", "stale")?,
            last_successful_entry_count: last_successful
                .as_ref()
                .map_or(0, |(entry_count, _)| *entry_count),
            last_successful_no_op: last_successful
                .as_ref()
                .is_some_and(|(_, status)| status == "no_op"),
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
            consolidations,
        })
    }
}

/// `(rowid, revision, status, repository_key, worktree_key)` of a candidate.
type CandidateRow = (i64, i64, String, Vec<u8>, Vec<u8>);

/// `(target_path, target_blob_hash, sanitized_content, sanitized_digest)` of
/// one `promotion-plan` file before insertion.
type PlanFileRow = (
    String,
    Option<String>,
    String,
    Option<Vec<u8>>,
    Option<Vec<u8>>,
);

/// One `promotion_files` row loaded for `promotion-apply`.
struct PromotionFileRow {
    target_path: String,
    target_blob_hash: Option<String>,
    operation: String,
    sanitized_content: Option<Vec<u8>>,
    sanitized_digest: Option<Vec<u8>>,
    intent_state: String,
    originally_present: Option<i64>,
    rollback_content: Option<Vec<u8>>,
    rollback_digest: Option<Vec<u8>>,
    legacy_write_only: i64,
}

struct ConsolidationPromotionFile {
    operation: String,
    content: Option<Vec<u8>>,
}

struct PromotionApplyJournalRow {
    repository_key: Vec<u8>,
    worktree_key: Vec<u8>,
    candidate_ids_json: String,
    assessment_digest: Vec<u8>,
    policy_version: String,
    status: String,
    mutation_phase: String,
}

struct PromotionCandidateSnapshot {
    candidate_id: String,
    candidate_kind: String,
    payload: Value,
    statement_digests: HashMap<String, Vec<u8>>,
}

struct PromotionSnapshot {
    candidates: Vec<PromotionCandidateSnapshot>,
    assessment_digest: Vec<u8>,
}

struct PromotionRecoveryContext<'a> {
    plan_id: &'a str,
    root: &'a Path,
    repository_key: &'a [u8],
    worktree_key: &'a [u8],
    candidate_ids: &'a [String],
    now_unix_ms: i64,
}

fn read_promotion_files(
    connection: &Connection,
    plan_id: &str,
) -> Result<Vec<PromotionFileRow>, MemoryError> {
    let mut statement = connection.prepare(
        "SELECT target_path, target_blob_hash, operation, sanitized_content, sanitized_digest,
                intent_state, originally_present, rollback_content, rollback_digest,
                legacy_write_only
         FROM promotion_files WHERE plan_id=?1
         ORDER BY CASE operation WHEN 'write' THEN 0 ELSE 1 END, target_path",
    )?;
    let rows = statement
        .query_map(params![plan_id], |row| {
            Ok(PromotionFileRow {
                target_path: row.get(0)?,
                target_blob_hash: row.get(1)?,
                operation: row.get(2)?,
                sanitized_content: row.get(3)?,
                sanitized_digest: row.get(4)?,
                intent_state: row.get(5)?,
                originally_present: row.get(6)?,
                rollback_content: row.get(7)?,
                rollback_digest: row.get(8)?,
                legacy_write_only: row.get(9)?,
            })
        })?
        .collect::<Result<Vec<_>, _>>()?;
    Ok(rows)
}

fn promotion_staging_token(plan_id: &str, target_path: &str, direction: &str) -> String {
    let mut digest = Sha256::new();
    digest.update(plan_id.as_bytes());
    digest.update([0]);
    digest.update(target_path.as_bytes());
    digest.update([0]);
    digest.update(direction.as_bytes());
    hex::encode(digest.finalize())
}

fn forward_expected(file: &PromotionFileRow) -> Result<ExpectedWorktreeValue<'_>, MemoryError> {
    if file.legacy_write_only == 1 {
        return Ok(match file.target_blob_hash.as_deref() {
            Some(hash) => ExpectedWorktreeValue::GitBlob(hash),
            None => ExpectedWorktreeValue::Missing,
        });
    }
    match file.originally_present {
        Some(1) => file
            .rollback_content
            .as_deref()
            .map(ExpectedWorktreeValue::Bytes)
            .ok_or_else(|| {
                MemoryError::new(
                    "TS_MEMORY_STATE_CORRUPT",
                    format!("rollback bytes for {} are missing", file.target_path),
                )
            }),
        Some(0) => Ok(ExpectedWorktreeValue::Missing),
        _ => Err(MemoryError::new(
            "TS_MEMORY_STATE_CORRUPT",
            format!(
                "promotion journal for {} was not prechecked",
                file.target_path
            ),
        )),
    }
}

fn forward_replacement(file: &PromotionFileRow) -> Result<Option<&[u8]>, MemoryError> {
    match file.operation.as_str() {
        "write" => file.sanitized_content.as_deref().map(Some).ok_or_else(|| {
            MemoryError::new(
                "TS_MEMORY_STATE_CORRUPT",
                format!("write bytes for {} are missing", file.target_path),
            )
        }),
        "delete" => Ok(None),
        _ => Err(MemoryError::new(
            "TS_MEMORY_STATE_CORRUPT",
            "promotion file has an invalid operation",
        )),
    }
}

fn rollback_expected(file: &PromotionFileRow) -> Result<ExpectedWorktreeValue<'_>, MemoryError> {
    match file.operation.as_str() {
        "write" => file
            .sanitized_content
            .as_deref()
            .map(ExpectedWorktreeValue::Bytes)
            .ok_or_else(|| {
                MemoryError::new(
                    "TS_MEMORY_STATE_CORRUPT",
                    format!("write bytes for {} are missing", file.target_path),
                )
            }),
        "delete" => Ok(ExpectedWorktreeValue::Missing),
        _ => Err(MemoryError::new(
            "TS_MEMORY_STATE_CORRUPT",
            "promotion file has an invalid operation",
        )),
    }
}

fn rollback_replacement(file: &PromotionFileRow) -> Result<Option<&[u8]>, MemoryError> {
    match file.originally_present {
        Some(1) => file.rollback_content.as_deref().map(Some).ok_or_else(|| {
            MemoryError::new(
                "TS_MEMORY_ROLLBACK_REQUIRED",
                format!("rollback bytes for {} are missing", file.target_path),
            )
        }),
        Some(0) => Ok(None),
        _ => Err(MemoryError::new(
            "TS_MEMORY_ROLLBACK_REQUIRED",
            format!("rollback journal for {} is incomplete", file.target_path),
        )),
    }
}

fn recovery_required(target_path: &str, staging_name: &str) -> MemoryError {
    MemoryError::new(
        "TS_MEMORY_ROLLBACK_REQUIRED",
        format!(
            "promotion stopped at {target_path}; concurrent bytes were preserved in {staging_name} and require manual recovery"
        ),
    )
}

fn promotion_artifact_error(target_path: &str, error: PromotionFsError) -> MemoryError {
    match error {
        PromotionFsError::Symlink => MemoryError::new(
            "TS_MEMORY_BINDING_DRIFT",
            format!("promotion artifact path for {target_path} contains a symlink"),
        ),
        PromotionFsError::Io(error) => MemoryError::failed(format!(
            "promotion artifact operation failed for {target_path}: {error}"
        )),
    }
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

fn candidate_has_active_promotion(
    connection: &Connection,
    candidate_id: &str,
) -> Result<bool, MemoryError> {
    let mut statement = connection.prepare(
        "SELECT candidate_ids_json FROM promotion_journal
         WHERE status IN ('approved','applying')",
    )?;
    let rows = statement.query_map([], |row| row.get::<_, String>(0))?;
    for row in rows {
        if candidate_ids_from_json(&row?)
            .iter()
            .any(|id| id == candidate_id)
        {
            return Ok(true);
        }
    }
    Ok(false)
}

fn require_candidate_mutable(
    connection: &Connection,
    candidate_id: &str,
) -> Result<(), MemoryError> {
    if candidate_has_active_promotion(connection, candidate_id)? {
        return Err(MemoryError::new(
            "TS_MEMORY_CANDIDATE_STALE",
            format!("candidate {candidate_id} is bound to an approved or applying promotion plan"),
        ));
    }
    Ok(())
}

fn promotion_snapshot(
    connection: &Connection,
    candidate_ids: &[String],
    repository_key: &[u8],
    worktree_key: &[u8],
) -> Result<PromotionSnapshot, MemoryError> {
    let mut assessment_documents: Vec<(String, String, Value)> = Vec::new();
    let mut candidates = Vec::with_capacity(candidate_ids.len());
    for candidate_id in candidate_ids {
        let row: Option<(String, String, String)> = connection
            .query_row(
                "SELECT status, payload_json, candidate_kind FROM candidates
                 WHERE candidate_id=?1 AND repository_key=?2 AND worktree_key=?3",
                params![candidate_id, repository_key, worktree_key],
                |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
            )
            .optional()?;
        let (status, payload_json, candidate_kind) = row.ok_or_else(|| {
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

        let mut assessed_statement_ids = Vec::new();
        let mut statement_digests = HashMap::new();
        let mut statement = connection.prepare(
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
                "statementTextDigest": hex::encode(&statement_text_digest),
                "revision": revision,
            });
            assessed_statement_ids.push(statement_id.clone());
            statement_digests.insert(statement_id.clone(), statement_text_digest);
            assessment_documents.push((candidate_id.clone(), statement_id, document));
        }
        drop(statement);

        let payload = parse_json(&payload_json);
        if let Some(statements) = payload.get("statements").and_then(Value::as_array) {
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
        candidates.push(PromotionCandidateSnapshot {
            candidate_id: candidate_id.clone(),
            candidate_kind,
            payload,
            statement_digests,
        });
    }

    assessment_documents
        .sort_by(|left, right| left.0.cmp(&right.0).then_with(|| left.1.cmp(&right.1)));
    let assessment_digest = hex_blob(&canonical_digest_hex(&Value::Array(
        assessment_documents
            .into_iter()
            .map(|(_, _, document)| document)
            .collect(),
    ))?)?;
    Ok(PromotionSnapshot {
        candidates,
        assessment_digest,
    })
}

fn consolidation_candidate_files(
    candidate_id: &str,
    payload: &Value,
    assessment_digests: &HashMap<String, Vec<u8>>,
) -> Result<BTreeMap<String, ConsolidationPromotionFile>, MemoryError> {
    if payload.get("candidateKind").and_then(Value::as_str) != Some("consolidation-patch") {
        return Err(consolidation_invalid(
            "consolidation candidate payload has the wrong candidateKind",
        ));
    }
    let operations = payload
        .get("operations")
        .and_then(Value::as_array)
        .ok_or_else(|| consolidation_invalid("consolidation candidate has no operations"))?;
    let statements = payload
        .get("statements")
        .and_then(Value::as_array)
        .ok_or_else(|| consolidation_invalid("consolidation candidate has no statements"))?;
    if operations.is_empty()
        || operations.len() != statements.len()
        || operations.len() != assessment_digests.len()
    {
        return Err(MemoryError::new(
            "TS_MEMORY_UNVERIFIED_CLAIM",
            format!(
                "candidate {candidate_id} operations, statements, and assessments are not one-to-one"
            ),
        ));
    }
    let statements_by_id = statements
        .iter()
        .filter_map(|statement| {
            Some((
                statement.get("statementId")?.as_str()?,
                statement.get("operation")?,
            ))
        })
        .collect::<HashMap<_, _>>();
    if statements_by_id.len() != statements.len() {
        return Err(MemoryError::new(
            "TS_MEMORY_UNVERIFIED_CLAIM",
            format!("candidate {candidate_id} contains malformed or duplicate statements"),
        ));
    }
    let mut files = BTreeMap::new();
    for operation_value in operations {
        let operation: ConsolidationOperationInput =
            serde_json::from_value(operation_value.clone()).map_err(|_| {
                consolidation_invalid("consolidation candidate contains an invalid operation")
            })?;
        let statement_operation = statements_by_id
            .get(operation.operation_id.as_str())
            .ok_or_else(|| {
                MemoryError::new(
                    "TS_MEMORY_UNVERIFIED_CLAIM",
                    format!(
                        "candidate {candidate_id} operation {} has no statement",
                        operation.operation_id
                    ),
                )
            })?;
        if canonical(statement_operation)? != canonical(operation_value)? {
            return Err(MemoryError::new(
                "TS_MEMORY_UNVERIFIED_CLAIM",
                format!(
                    "candidate {candidate_id} statement {} does not bind its operation",
                    operation.operation_id
                ),
            ));
        }
        let expected_digest = Sha256::digest(canonical(operation_value)?.as_bytes()).to_vec();
        if assessment_digests.get(&operation.operation_id) != Some(&expected_digest) {
            return Err(MemoryError::new(
                "TS_MEMORY_UNVERIFIED_CLAIM",
                format!(
                    "candidate {candidate_id} statement {} digest does not bind its operation",
                    operation.operation_id
                ),
            ));
        }
        let target_path = if operation.target == "doctrine" {
            ".threadshare/memory/doctrine.md".to_owned()
        } else {
            format!(".threadshare/memory/scenes/{}.md", operation.name)
        };
        let primary = if operation.op == "delete" {
            ConsolidationPromotionFile {
                operation: "delete".to_owned(),
                content: None,
            }
        } else {
            ConsolidationPromotionFile {
                operation: "write".to_owned(),
                content: operation
                    .new_content
                    .as_ref()
                    .map(|content| content.as_bytes().to_vec()),
            }
        };
        if files.insert(target_path, primary).is_some() {
            return Err(consolidation_invalid(
                "consolidation candidate derives duplicate target paths",
            ));
        }
        if operation.op == "merge" {
            for source in &operation.merge_sources {
                if source == &operation.name {
                    continue;
                }
                let source_path = format!(".threadshare/memory/scenes/{source}.md");
                if files
                    .insert(
                        source_path,
                        ConsolidationPromotionFile {
                            operation: "delete".to_owned(),
                            content: None,
                        },
                    )
                    .is_some()
                {
                    return Err(consolidation_invalid(
                        "consolidation merge derives duplicate target paths",
                    ));
                }
            }
        }
    }
    Ok(files)
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
        require_candidate_mutable(&transaction, &request.candidate_id)?;
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
        require_candidate_mutable(&transaction, &request.candidate_id)?;
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
        transaction.execute(
            "UPDATE consolidation_runs SET status='stale', updated_at=?1
             WHERE candidate_id=?2 AND status='pending_review'",
            params![now_unix_ms, &request.candidate_id],
        )?;
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
        if request.policy_version != PROMOTION_POLICY_VERSION {
            return Err(MemoryError::invalid(format!(
                "policyVersion must be {PROMOTION_POLICY_VERSION}"
            )));
        }
        let repository_key = hex_blob(&request.owner.repository_key)?;
        let worktree_key = hex_blob(&request.owner.worktree_key)?;
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let binding_row: Option<(String, String)> = transaction
            .query_row(
                "SELECT memory_root, root_realpath FROM repository_bindings
                 WHERE repository_key=?1 AND worktree_key=?2",
                params![&repository_key, &worktree_key],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .optional()?;
        let (memory_root, root_realpath) = binding_row.ok_or_else(|| {
            MemoryError::new(
                "TS_MEMORY_BINDING_NOT_FOUND",
                "the owner has no repository binding; run bind-repository first",
            )
        })?;

        let snapshot = promotion_snapshot(
            &transaction,
            &request.candidate_ids,
            &repository_key,
            &worktree_key,
        )?;
        let candidate_kinds = snapshot
            .candidates
            .iter()
            .map(|candidate| candidate.candidate_kind.clone())
            .collect::<Vec<_>>();
        let mut consolidation_files = None;
        for candidate in &snapshot.candidates {
            if candidate.candidate_kind == "consolidation-patch" {
                let binding = candidate
                    .payload
                    .get("binding")
                    .ok_or_else(|| binding_drift("consolidation candidate binding is missing"))?;
                validate_consolidation_replay_epoch(
                    &transaction,
                    binding,
                    &repository_key,
                    &worktree_key,
                )?;
                validate_bound_consolidation_sources(Path::new(&root_realpath), binding)?;
                consolidation_files = Some(consolidation_candidate_files(
                    &candidate.candidate_id,
                    &candidate.payload,
                    &candidate.statement_digests,
                )?);
            }
        }
        let consolidation_plan = match candidate_kinds.as_slice() {
            [kind] if kind == "consolidation-patch" => true,
            kinds if kinds.iter().all(|kind| kind == "entry") => false,
            _ => {
                return Err(MemoryError::new(
                    "TS_MEMORY_CANDIDATE_KIND_MISMATCH",
                    "a promotion plan must contain only entry candidates, or exactly one consolidation candidate",
                ));
            }
        };
        let assessment_digest_hex = hex::encode(&snapshot.assessment_digest);

        let memory_root_prefix = format!("{memory_root}/");
        let mut per_file_documents = Vec::new();
        let mut file_rows: Vec<PlanFileRow> = Vec::new();
        let mut supplied_paths = HashSet::new();
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
            supplied_paths.insert(file.target_path.clone());
            let content = file
                .sanitized_content
                .as_deref()
                .map(|encoded| {
                    decode_base64(encoded).ok_or_else(|| {
                        MemoryError::invalid(
                            "perFile[].sanitizedContent must be strict padded base64",
                        )
                    })
                })
                .transpose()?;
            let sanitized_digest = content
                .as_deref()
                .map(|content| Sha256::digest(content).to_vec());
            if consolidation_plan {
                let derived = consolidation_files
                    .as_ref()
                    .and_then(|files| files.get(&file.target_path))
                    .ok_or_else(|| {
                        consolidation_invalid(format!(
                            "promotion file {} is not derived from the confirmed patch",
                            file.target_path
                        ))
                    })?;
                if derived.operation != file.operation || derived.content != content {
                    return Err(consolidation_invalid(format!(
                        "promotion file {} differs from the confirmed patch",
                        file.target_path
                    )));
                }
                let segments = file.target_path.split('/').collect::<Vec<_>>();
                let current =
                    read_worktree_file(Path::new(&root_realpath), &segments).map_err(|error| {
                        match error {
                            PromotionFsError::Symlink => MemoryError::new(
                                "TS_MEMORY_TARGET_PATH_INVALID",
                                format!("promotion target {} contains a symlink", file.target_path),
                            ),
                            PromotionFsError::Io(error) => MemoryError::failed(format!(
                                "promotion plan could not read {}: {error}",
                                file.target_path
                            )),
                        }
                    })?;
                let observed_blob = current.as_deref().map(git_blob_oid_hex);
                if observed_blob != file.target_blob_hash {
                    return Err(binding_drift(format!(
                        "promotion target {} changed before plan creation",
                        file.target_path
                    )));
                }
            }
            per_file_documents.push(serde_json::json!({
                "targetPath": file.target_path,
                "targetBlobHash": file.target_blob_hash,
                "sanitizedContentDigest": sanitized_digest.as_ref().map(hex::encode),
                "operation": file.operation,
            }));
            file_rows.push((
                file.target_path.clone(),
                file.target_blob_hash.clone(),
                file.operation.clone(),
                content,
                sanitized_digest,
            ));
        }
        if consolidation_plan
            && consolidation_files.as_ref().is_none_or(|files| {
                files.len() != supplied_paths.len()
                    || !files.keys().all(|path| supplied_paths.contains(path))
            })
        {
            return Err(consolidation_invalid(
                "promotion plan does not contain every file derived from the confirmed patch",
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
        for (target_path, target_blob_hash, operation, content, sanitized_digest) in file_rows {
            transaction.execute(
                "INSERT INTO promotion_files(
                   plan_id, target_path, target_blob_hash, operation, sanitized_content,
                   sanitized_digest, applied)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)",
                params![
                    plan_id,
                    target_path,
                    target_blob_hash,
                    operation,
                    content,
                    sanitized_digest
                ],
            )?;
            files.push(serde_json::json!({
                "targetPath": target_path,
                "targetBlobHash": target_blob_hash,
                "operation": operation,
                "sanitizedDigest": sanitized_digest.as_ref().map(hex::encode),
                "bytes": content.as_ref().map_or(0, Vec::len),
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

    fn close_consolidation_as_stale(
        transaction: &Transaction<'_>,
        candidate_ids: &[String],
        repository_key: &[u8],
        worktree_key: &[u8],
        now_unix_ms: i64,
    ) -> Result<bool, MemoryError> {
        let mut changed = false;
        for candidate_id in candidate_ids {
            let row: Option<(i64, String, String)> = transaction
                .query_row(
                    "SELECT rowid, candidate_kind, status FROM candidates
                     WHERE candidate_id=?1 AND repository_key=?2 AND worktree_key=?3",
                    params![candidate_id, repository_key, worktree_key],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
                )
                .optional()?;
            let Some((rowid, candidate_kind, status)) = row else {
                continue;
            };
            if candidate_kind == "consolidation-patch"
                && matches!(status.as_str(), "draft" | "quarantined")
            {
                transaction.execute(
                    "UPDATE candidates SET status='discarded', revision=revision+1,
                       updated_at=?1 WHERE rowid=?2",
                    params![now_unix_ms, rowid],
                )?;
                transaction.execute(
                    "UPDATE consolidation_runs SET status='stale', updated_at=?1
                     WHERE candidate_id=?2 AND status='pending_review'",
                    params![now_unix_ms, candidate_id],
                )?;
                changed = true;
            }
        }
        Ok(changed)
    }

    fn void_promotion(
        &mut self,
        context: &PromotionRecoveryContext<'_>,
        drifted_path: &str,
        discard_consolidation: bool,
    ) -> Result<Value, MemoryError> {
        let transaction = self
            .connection
            .transaction_with_behavior(TransactionBehavior::Immediate)?;
        let discarded = discard_consolidation
            && Self::close_consolidation_as_stale(
                &transaction,
                context.candidate_ids,
                context.repository_key,
                context.worktree_key,
                context.now_unix_ms,
            )?;
        if discarded {
            bump_candidate_generation(&transaction, context.repository_key, context.worktree_key)?;
        }
        let changed = transaction.execute(
            "UPDATE promotion_journal SET status='voided', mutation_phase='done', updated_at=?1
             WHERE plan_id=?2 AND status IN ('approved','applying')",
            params![context.now_unix_ms, context.plan_id],
        )?;
        if changed != 1 {
            return Err(MemoryError::new(
                "TS_MEMORY_PLAN_STATE_INVALID",
                "the promotion plan changed before it could be voided",
            ));
        }
        transaction.execute(
            "UPDATE promotion_files SET rollback_content=NULL, rollback_digest=NULL
             WHERE plan_id=?1",
            params![context.plan_id],
        )?;
        transaction.commit()?;
        self.maintain_wal_after_commit()?;
        Ok(serde_json::json!({
            "planId": context.plan_id,
            "status": "voided",
            "driftedPath": drifted_path,
        }))
    }

    fn start_rollback(&mut self, plan_id: &str, now_unix_ms: i64) -> Result<(), MemoryError> {
        let changed = self.connection.execute(
            "UPDATE promotion_journal SET mutation_phase='rolling_back', updated_at=?1
             WHERE plan_id=?2 AND status='applying'",
            params![now_unix_ms, plan_id],
        )?;
        if changed != 1 {
            return Err(MemoryError::new(
                "TS_MEMORY_PLAN_STATE_INVALID",
                "the promotion plan changed before rollback could start",
            ));
        }
        self.maintain_wal_after_commit()?;
        Ok(())
    }

    fn rollback_promotion(
        &mut self,
        context: &PromotionRecoveryContext<'_>,
        drifted_path: &str,
    ) -> Result<Value, MemoryError> {
        let mut files = read_promotion_files(&self.connection, context.plan_id)?;
        files.reverse();
        for file in files {
            if file.legacy_write_only == 1 || file.intent_state == "pending" {
                continue;
            }
            if !matches!(
                file.intent_state.as_str(),
                "intent" | "applied" | "rolled_back"
            ) {
                return Err(MemoryError::new(
                    "TS_MEMORY_STATE_CORRUPT",
                    format!(
                        "promotion file {} has invalid rollback progress {}",
                        file.target_path, file.intent_state
                    ),
                ));
            }
            let segments = file.target_path.split('/').collect::<Vec<_>>();
            let classify = |value: Option<&[u8]>| -> Result<(bool, bool), MemoryError> {
                let old_matches = match file.originally_present {
                    Some(1) => value.is_some_and(|bytes| {
                        file.rollback_digest
                            .as_deref()
                            .is_some_and(|digest| Sha256::digest(bytes).as_slice() == digest)
                    }),
                    Some(0) => value.is_none(),
                    _ => {
                        return Err(MemoryError::new(
                            "TS_MEMORY_ROLLBACK_REQUIRED",
                            format!("rollback journal for {} is incomplete", file.target_path),
                        ));
                    }
                };
                let new_matches = match file.operation.as_str() {
                    "write" => value.is_some_and(|bytes| {
                        file.sanitized_digest
                            .as_deref()
                            .is_some_and(|digest| Sha256::digest(bytes).as_slice() == digest)
                    }),
                    "delete" => value.is_none(),
                    _ => false,
                };
                Ok((old_matches, new_matches))
            };
            let mut current = read_worktree_file(context.root, &segments).map_err(|error| {
                MemoryError::new(
                    "TS_MEMORY_ROLLBACK_REQUIRED",
                    format!(
                        "rollback could not inspect {} without risking external data: {error}",
                        file.target_path
                    ),
                )
            })?;
            let (mut old_matches, new_matches) = classify(current.as_deref())?;
            if !old_matches && !new_matches && file.intent_state == "intent" {
                let token = promotion_staging_token(context.plan_id, &file.target_path, "forward");
                match conditional_replace_worktree_file(
                    context.root,
                    &segments,
                    forward_expected(&file)?,
                    forward_replacement(&file)?,
                    &token,
                )
                .map_err(|error| {
                    MemoryError::new(
                        "TS_MEMORY_ROLLBACK_REQUIRED",
                        format!(
                            "rollback could not resolve the forward intent for {}: {error}",
                            file.target_path
                        ),
                    )
                })? {
                    ConditionalMutationOutcome::Applied => {}
                    ConditionalMutationOutcome::Drift => {
                        return Err(MemoryError::new(
                            "TS_MEMORY_ROLLBACK_REQUIRED",
                            format!(
                                "rollback stopped at {} because a concurrent edit was preserved",
                                file.target_path
                            ),
                        ));
                    }
                    ConditionalMutationOutcome::RecoveryRequired { staging_name } => {
                        return Err(recovery_required(&file.target_path, &staging_name));
                    }
                }
                current = read_worktree_file(context.root, &segments).map_err(|error| {
                    MemoryError::new(
                        "TS_MEMORY_ROLLBACK_REQUIRED",
                        format!(
                            "rollback could not inspect the resolved forward intent for {}: {error}",
                            file.target_path
                        ),
                    )
                })?;
                old_matches = classify(current.as_deref())?.0;
            }
            if !old_matches {
                let expected = rollback_expected(&file)?;
                let replacement = rollback_replacement(&file)?;
                let token = promotion_staging_token(context.plan_id, &file.target_path, "rollback");
                match conditional_replace_worktree_file(
                    context.root,
                    &segments,
                    expected,
                    replacement,
                    &token,
                )
                .map_err(|error| {
                    MemoryError::new(
                        "TS_MEMORY_ROLLBACK_REQUIRED",
                        format!("rollback could not restore {}: {error}", file.target_path),
                    )
                })? {
                    ConditionalMutationOutcome::Applied => {}
                    ConditionalMutationOutcome::Drift => {
                        return Err(MemoryError::new(
                            "TS_MEMORY_ROLLBACK_REQUIRED",
                            format!(
                                "rollback stopped at {} because a concurrent edit was preserved",
                                file.target_path
                            ),
                        ));
                    }
                    ConditionalMutationOutcome::RecoveryRequired { staging_name } => {
                        return Err(recovery_required(&file.target_path, &staging_name));
                    }
                }
                current = read_worktree_file(context.root, &segments).map_err(|error| {
                    MemoryError::new(
                        "TS_MEMORY_ROLLBACK_REQUIRED",
                        format!("rollback could not verify {}: {error}", file.target_path),
                    )
                })?;
                old_matches = match file.originally_present {
                    Some(1) => current.as_deref().is_some_and(|bytes| {
                        file.rollback_digest
                            .as_deref()
                            .is_some_and(|digest| Sha256::digest(bytes).as_slice() == digest)
                    }),
                    Some(0) => current.is_none(),
                    _ => false,
                };
                if !old_matches {
                    return Err(MemoryError::new(
                        "TS_MEMORY_ROLLBACK_REQUIRED",
                        format!(
                            "rollback stopped at {} because the restored value changed concurrently",
                            file.target_path
                        ),
                    ));
                }
            }
            self.connection.execute(
                "UPDATE promotion_files SET intent_state='rolled_back', applied=0
                 WHERE plan_id=?1 AND target_path=?2",
                params![context.plan_id, &file.target_path],
            )?;
            for (direction, expected, replacement) in [
                (
                    "forward",
                    forward_expected(&file)?,
                    forward_replacement(&file)?,
                ),
                (
                    "rollback",
                    rollback_expected(&file)?,
                    rollback_replacement(&file)?,
                ),
            ] {
                let token = promotion_staging_token(context.plan_id, &file.target_path, direction);
                match cleanup_worktree_mutation_artifacts(
                    context.root,
                    &segments,
                    expected,
                    replacement,
                    &token,
                )
                .map_err(|error| {
                    MemoryError::new(
                        "TS_MEMORY_ROLLBACK_REQUIRED",
                        format!(
                            "rollback could not clean recoverable state for {}: {error}",
                            file.target_path
                        ),
                    )
                })? {
                    ConditionalMutationOutcome::Applied => {}
                    ConditionalMutationOutcome::RecoveryRequired { staging_name } => {
                        return Err(recovery_required(&file.target_path, &staging_name));
                    }
                    ConditionalMutationOutcome::Drift => unreachable!(),
                }
            }
        }
        self.void_promotion(context, drifted_path, true)
    }

    /// `promotion-apply`: full precheck CAS, write-ahead per-file intent,
    /// writes-before-deletes mutation, and phase-aware forward/rollback crash
    /// recovery. Filesystem and SQLite commits are deliberately bridged by
    /// the persisted intent plus old/new/missing classification.
    pub fn promotion_apply(
        &mut self,
        request: &PromotionApplyRequest,
        now_unix_ms: i64,
    ) -> Result<Value, MemoryError> {
        let _apply_lock = self.acquire_promotion_apply_lock()?;
        let (
            repository_key,
            worktree_key,
            candidate_ids,
            assessment_digest,
            policy_version,
            root_realpath,
            status,
            mut phase,
        ) = {
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            let row: Option<PromotionApplyJournalRow> = transaction
                .query_row(
                    "SELECT repository_key, worktree_key, candidate_ids_json, assessment_digest,
                            policy_version, status, mutation_phase
                     FROM promotion_journal WHERE plan_id=?1",
                    params![&request.plan_id],
                    |row| {
                        Ok(PromotionApplyJournalRow {
                            repository_key: row.get(0)?,
                            worktree_key: row.get(1)?,
                            candidate_ids_json: row.get(2)?,
                            assessment_digest: row.get(3)?,
                            policy_version: row.get(4)?,
                            status: row.get(5)?,
                            mutation_phase: row.get(6)?,
                        })
                    },
                )
                .optional()?;
            let row = row.ok_or_else(|| {
                MemoryError::new(
                    "TS_MEMORY_PLAN_NOT_FOUND",
                    "the promotion plan does not exist",
                )
            })?;
            match row.status.as_str() {
                "approved" | "applying" | "applied" => {}
                other => {
                    return Err(MemoryError::new(
                        "TS_MEMORY_PLAN_STATE_INVALID",
                        format!("the plan is {other} and cannot be applied"),
                    ));
                }
            }
            let root_realpath: Option<String> = transaction
                .query_row(
                    "SELECT root_realpath FROM repository_bindings
                     WHERE repository_key=?1 AND worktree_key=?2",
                    params![&row.repository_key, &row.worktree_key],
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
            transaction.commit()?;
            (
                row.repository_key,
                row.worktree_key,
                candidate_ids_from_json(&row.candidate_ids_json),
                row.assessment_digest,
                row.policy_version,
                root_realpath,
                row.status,
                row.mutation_phase,
            )
        };
        let root = PathBuf::from(&root_realpath);
        let recovery = PromotionRecoveryContext {
            plan_id: &request.plan_id,
            root: &root,
            repository_key: &repository_key,
            worktree_key: &worktree_key,
            candidate_ids: &candidate_ids,
            now_unix_ms,
        };
        if status == "applied" {
            let files = read_promotion_files(&self.connection, &request.plan_id)?;
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

        if status == "approved" {
            let files = read_promotion_files(&self.connection, &request.plan_id)?;
            let legacy_write_only = files.iter().all(|file| file.legacy_write_only == 1);
            if !legacy_write_only {
                if policy_version != PROMOTION_POLICY_VERSION {
                    return self.void_promotion(&recovery, ".threadshare/memory", false);
                }
                match promotion_snapshot(
                    &self.connection,
                    &candidate_ids,
                    &repository_key,
                    &worktree_key,
                ) {
                    Ok(snapshot) if snapshot.assessment_digest == assessment_digest => {}
                    Ok(_) => {
                        return self.void_promotion(&recovery, ".threadshare/memory", false);
                    }
                    Err(error)
                        if matches!(
                            error.code,
                            "TS_MEMORY_CANDIDATE_NOT_FOUND"
                                | "TS_MEMORY_CANDIDATE_STALE"
                                | "TS_MEMORY_UNVERIFIED_CLAIM"
                        ) =>
                    {
                        return self.void_promotion(&recovery, ".threadshare/memory", false);
                    }
                    Err(error) => return Err(error),
                }
            }
            if let Err(error) =
                validate_consolidation_candidate_sources(&self.connection, &root, &candidate_ids)
            {
                if error.code == "TS_MEMORY_BINDING_DRIFT" {
                    return self.void_promotion(&recovery, ".threadshare/memory", true);
                }
                return Err(error);
            }
            if phase != "precheck" {
                return Err(MemoryError::new(
                    "TS_MEMORY_PLAN_STATE_INVALID",
                    "an approved plan has an invalid mutation phase",
                ));
            }
            let transaction = self
                .connection
                .transaction_with_behavior(TransactionBehavior::Immediate)?;
            for file in &files {
                let segments = file.target_path.split('/').collect::<Vec<_>>();
                let current = match read_worktree_file(&root, &segments) {
                    Ok(current) => current,
                    Err(PromotionFsError::Symlink) => {
                        drop(transaction);
                        return self.void_promotion(&recovery, &file.target_path, true);
                    }
                    Err(PromotionFsError::Io(error)) => {
                        return Err(MemoryError::failed(format!(
                            "promotion precheck could not read {}: {error}",
                            file.target_path
                        )));
                    }
                };
                let observed_blob = current.as_deref().map(git_blob_oid_hex);
                if observed_blob.as_deref() != file.target_blob_hash.as_deref() {
                    drop(transaction);
                    return self.void_promotion(&recovery, &file.target_path, true);
                }
                let rollback_digest = current
                    .as_deref()
                    .map(|bytes| Sha256::digest(bytes).to_vec());
                transaction.execute(
                    "UPDATE promotion_files SET originally_present=?1, rollback_content=?2,
                       rollback_digest=?3, intent_state='pending', applied=0
                     WHERE plan_id=?4 AND target_path=?5",
                    params![
                        i64::from(current.is_some()),
                        current,
                        rollback_digest,
                        &request.plan_id,
                        &file.target_path,
                    ],
                )?;
            }
            let changed = transaction.execute(
                "UPDATE promotion_journal SET status='applying', mutation_phase='mutating',
                   updated_at=?1
                 WHERE plan_id=?2 AND status='approved' AND mutation_phase='precheck'",
                params![now_unix_ms, &request.plan_id],
            )?;
            if changed != 1 {
                return Err(MemoryError::new(
                    "TS_MEMORY_PLAN_STATE_INVALID",
                    "the promotion plan changed during precheck",
                ));
            }
            transaction.commit()?;
            self.maintain_wal_after_commit()?;
            phase = "mutating".to_owned();
        }

        if phase == "rolling_back" {
            let drifted_path = read_promotion_files(&self.connection, &request.plan_id)?
                .first()
                .map(|file| file.target_path.clone())
                .unwrap_or_else(|| ".threadshare/memory".to_owned());
            return self.rollback_promotion(&recovery, &drifted_path);
        }
        if phase != "mutating" {
            return Err(MemoryError::new(
                "TS_MEMORY_PLAN_STATE_INVALID",
                format!("the applying plan is in unexpected phase {phase}"),
            ));
        }

        let files = read_promotion_files(&self.connection, &request.plan_id)?;
        let mut applied_files = Vec::new();
        for file in &files {
            let intent_started = file.intent_state == "intent";
            let progress_applied = file.intent_state == "applied";
            if !matches!(file.intent_state.as_str(), "pending" | "intent" | "applied") {
                return Err(MemoryError::new(
                    "TS_MEMORY_STATE_CORRUPT",
                    format!(
                        "promotion file {} has invalid forward progress {}",
                        file.target_path, file.intent_state
                    ),
                ));
            }
            let segments: Vec<&str> = file.target_path.split('/').collect();
            let current = match read_worktree_file(&root, &segments) {
                Ok(current) => current,
                Err(error) => {
                    self.start_rollback(&request.plan_id, now_unix_ms)?;
                    return self
                        .rollback_promotion(&recovery, &file.target_path)
                        .map_err(|rollback_error| {
                            MemoryError::new(
                                rollback_error.code,
                                format!(
                                    "promotion read failed at {} ({error}); {rollback_error}",
                                    file.target_path
                                ),
                            )
                        });
                }
            };
            let old_matches = current.as_deref().map(git_blob_oid_hex).as_deref()
                == file.target_blob_hash.as_deref();
            let new_matches = match file.operation.as_str() {
                "write" => current.as_deref().is_some_and(|bytes| {
                    file.sanitized_digest
                        .as_deref()
                        .is_some_and(|digest| Sha256::digest(bytes).as_slice() == digest)
                }),
                "delete" => current.is_none(),
                _ => false,
            };

            let expected = forward_expected(file)?;
            let replacement = forward_replacement(file)?;
            let staging_token =
                promotion_staging_token(&request.plan_id, &file.target_path, "forward");

            if file.legacy_write_only == 1 {
                if new_matches && (intent_started || progress_applied) {
                    self.connection.execute(
                        "UPDATE promotion_files SET intent_state='applied', applied=1
                         WHERE plan_id=?1 AND target_path=?2",
                        params![&request.plan_id, &file.target_path],
                    )?;
                    match cleanup_worktree_mutation_artifacts(
                        &root,
                        &segments,
                        expected,
                        replacement,
                        &staging_token,
                    )
                    .map_err(|error| promotion_artifact_error(&file.target_path, error))?
                    {
                        ConditionalMutationOutcome::Applied => {}
                        ConditionalMutationOutcome::RecoveryRequired { staging_name } => {
                            return Err(recovery_required(&file.target_path, &staging_name));
                        }
                        ConditionalMutationOutcome::Drift => unreachable!(),
                    }
                    applied_files.push(file.target_path.clone());
                    continue;
                }
                if progress_applied || (!old_matches && !intent_started) {
                    return self.void_promotion(&recovery, &file.target_path, false);
                }
            } else if file.originally_present.is_none() {
                return Err(MemoryError::new(
                    "TS_MEMORY_STATE_CORRUPT",
                    format!(
                        "promotion journal for {} was not prechecked",
                        file.target_path
                    ),
                ));
            } else if new_matches && (intent_started || progress_applied) {
                self.connection.execute(
                    "UPDATE promotion_files SET intent_state='applied', applied=1
                     WHERE plan_id=?1 AND target_path=?2",
                    params![&request.plan_id, &file.target_path],
                )?;
                match cleanup_worktree_mutation_artifacts(
                    &root,
                    &segments,
                    expected,
                    replacement,
                    &staging_token,
                )
                .map_err(|error| promotion_artifact_error(&file.target_path, error))?
                {
                    ConditionalMutationOutcome::Applied => {}
                    ConditionalMutationOutcome::RecoveryRequired { staging_name } => {
                        return Err(recovery_required(&file.target_path, &staging_name));
                    }
                    ConditionalMutationOutcome::Drift => unreachable!(),
                }
                applied_files.push(file.target_path.clone());
                continue;
            } else if progress_applied || (!old_matches && !intent_started) {
                self.start_rollback(&request.plan_id, now_unix_ms)?;
                return self.rollback_promotion(&recovery, &file.target_path);
            }

            if !intent_started {
                let changed = self.connection.execute(
                    "UPDATE promotion_files SET intent_state='intent'
                     WHERE plan_id=?1 AND target_path=?2 AND intent_state='pending'",
                    params![&request.plan_id, &file.target_path],
                )?;
                if changed != 1 {
                    return Err(MemoryError::new(
                        "TS_MEMORY_PLAN_STATE_INVALID",
                        format!(
                            "promotion intent for {} changed before mutation",
                            file.target_path
                        ),
                    ));
                }
                self.maintain_wal_after_commit()?;
            }
            let mutation = conditional_replace_worktree_file(
                &root,
                &segments,
                expected,
                replacement,
                &staging_token,
            );
            match mutation {
                Ok(ConditionalMutationOutcome::Applied) => {}
                Ok(ConditionalMutationOutcome::Drift) => {
                    if file.legacy_write_only == 1 {
                        return self.void_promotion(&recovery, &file.target_path, false);
                    }
                    self.connection.execute(
                        "UPDATE promotion_files SET intent_state='pending'
                         WHERE plan_id=?1 AND target_path=?2 AND intent_state='intent'",
                        params![&request.plan_id, &file.target_path],
                    )?;
                    self.start_rollback(&request.plan_id, now_unix_ms)?;
                    return self.rollback_promotion(&recovery, &file.target_path);
                }
                Ok(ConditionalMutationOutcome::RecoveryRequired { staging_name }) => {
                    if file.legacy_write_only == 1 {
                        return Err(recovery_required(&file.target_path, &staging_name));
                    }
                    self.start_rollback(&request.plan_id, now_unix_ms)?;
                    return Err(recovery_required(&file.target_path, &staging_name));
                }
                Err(error) => {
                    if file.legacy_write_only == 1 {
                        return Err(promotion_artifact_error(&file.target_path, error));
                    }
                    self.start_rollback(&request.plan_id, now_unix_ms)?;
                    return self.rollback_promotion(&recovery, &file.target_path);
                }
            }
            let after = read_worktree_file(&root, &segments).map_err(|error| {
                MemoryError::failed(format!(
                    "promotion could not verify {} after mutation: {error}",
                    file.target_path
                ))
            })?;
            let after_matches = match file.operation.as_str() {
                "write" => after.as_deref() == replacement,
                "delete" => after.is_none(),
                _ => false,
            };
            if !after_matches {
                if file.legacy_write_only == 1 {
                    let staging_name = format!(
                        ".threadshare-promotion-{}.hold",
                        promotion_staging_token(&request.plan_id, &file.target_path, "forward")
                    );
                    return Err(recovery_required(&file.target_path, &staging_name));
                }
                self.start_rollback(&request.plan_id, now_unix_ms)?;
                return self.rollback_promotion(&recovery, &file.target_path);
            }
            self.connection.execute(
                "UPDATE promotion_files SET intent_state='applied', applied=1
                 WHERE plan_id=?1 AND target_path=?2",
                params![&request.plan_id, &file.target_path],
            )?;
            match cleanup_worktree_mutation_artifacts(
                &root,
                &segments,
                expected,
                replacement,
                &staging_token,
            )
            .map_err(|error| promotion_artifact_error(&file.target_path, error))?
            {
                ConditionalMutationOutcome::Applied => {}
                ConditionalMutationOutcome::RecoveryRequired { staging_name } => {
                    return Err(recovery_required(&file.target_path, &staging_name));
                }
                ConditionalMutationOutcome::Drift => unreachable!(),
            }
            applied_files.push(file.target_path.clone());
        }

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
                    transaction.execute(
                        "UPDATE consolidation_runs SET status='applied', updated_at=?1
                         WHERE candidate_id=?2 AND status='pending_review'",
                        params![now_unix_ms, candidate_id],
                    )?;
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
        let changed = transaction.execute(
            "UPDATE promotion_journal SET status='applied', mutation_phase='done', updated_at=?1
             WHERE plan_id=?2 AND status='applying' AND mutation_phase='mutating'",
            params![now_unix_ms, &request.plan_id],
        )?;
        if changed != 1 {
            return Err(MemoryError::new(
                "TS_MEMORY_PLAN_STATE_INVALID",
                "the promotion plan changed before finalization",
            ));
        }
        transaction.execute(
            "UPDATE promotion_files SET rollback_content=NULL, rollback_digest=NULL
             WHERE plan_id=?1",
            params![&request.plan_id],
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
    fn unicode_normalization_vectors_match_the_javascript_host() {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/memory-consolidation-unicode-vectors.v1.json"
        ))
        .unwrap();
        assert_eq!(
            fixture["format"],
            "threadshare-memory-consolidation-unicode-vectors@v1"
        );
        for vector in fixture["vectors"].as_array().unwrap() {
            let name = vector["name"].as_str().unwrap();
            let input = vector["input"]["unit"]
                .as_str()
                .unwrap()
                .repeat(vector["input"]["repeat"].as_u64().unwrap() as usize);
            let expected = vector["normalized"]["unit"]
                .as_str()
                .unwrap()
                .repeat(vector["normalized"]["repeat"].as_u64().unwrap() as usize);
            let normalized = normalize_consolidation_text(&input).unwrap();
            assert_eq!(normalized, expected, "{name}");
            let count = normalized.chars().count();
            assert_eq!(
                count as u64,
                vector["codePointCount"].as_u64().unwrap(),
                "{name}"
            );
            assert_eq!(
                hex::encode(Sha256::digest(normalized.as_bytes())),
                vector["sha256"].as_str().unwrap(),
                "{name}"
            );
            assert_eq!(
                count <= vector["maxCodePoints"].as_u64().unwrap() as usize,
                vector["accepted"].as_bool().unwrap(),
                "{name}"
            );
        }
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
