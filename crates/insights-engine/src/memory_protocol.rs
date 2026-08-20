//! Team Memory engine protocol: `MEMORY_COMMAND` / `MEMORY_RESULT` envelope and
//! per-op payload schemas (design doc `docs/team-memory-phase1-design.md` §3, DEV-4).
//!
//! This documentation block is the **normative wire schema** for the memory ops.
//! The Node side (`memory-contracts.mjs` zod schemas) must match it exactly.
//!
//! # Envelope
//!
//! Request frame (client → engine), READY state only:
//!
//! ```json
//! { "format": "threadshare-insights-protocol@v1", "type": "MEMORY_COMMAND",
//!   "requestId": "<decimal string>", "op": "<op name>", "payload": { ... } }
//! ```
//!
//! Success frame (engine → client):
//!
//! ```json
//! { "format": "threadshare-insights-protocol@v1", "type": "MEMORY_RESULT",
//!   "requestId": "<same>", "op": "<same op>", "payload": { ... } }
//! ```
//!
//! Failures use the existing `ERROR` frame with `code` from:
//! `TS_MEMORY_REQUEST_INVALID` (validation), `TS_MEMORY_STATE_NOT_OPEN`,
//! `TS_MEMORY_TASK_NOT_FOUND`, `TS_MEMORY_TASK_NOT_CLAIMABLE`,
//! `TS_MEMORY_LEASE_LOST`, `TS_MEMORY_SUBMISSION_CONFLICT` (conflict),
//! `TS_MEMORY_SYNC_PARTIAL` (conflict), `TS_MEMORY_STATE_FAILED`,
//! `TS_MEMORY_STATE_CORRUPT` (storage).
//!
//! All digests on the wire are lowercase sha256 hex64 strings. `repositoryKey`,
//! `worktreeKey`, `sessionKey`, `turnKey` are hex64. Timestamps are integer Unix
//! milliseconds within the canonical-JSON safe-integer domain.
//!
//! # Ops (Stage 4a)
//!
//! ## `open`
//! Lazily opens (creates + migrates) `<stateDir>/memory/memory-state.sqlite3`
//! (0600, WAL). Idempotent for the same `stateDir`; a different `stateDir` while
//! open is rejected.
//! - request: `{ "stateDir": "<absolute path>" }`
//! - result: `{ "memoryStateUuid": "<uuid v4>", "schemaVersion": 1 }`
//!
//! ## `bind-repository`
//! Upserts `repository_bindings`. `rootRealpath` enters the database only and is
//! never echoed back.
//! - request: `{ "repositoryKey": hex64, "worktreeKey": hex64,
//!   "publicRepositoryIdentity": string|null, "rootRealpath": "<absolute path>",
//!   "rootRealpathDigest": hex64, "commonDirDevice": string,
//!   "commonDirInode": string, "memoryRoot": string (default
//!   ".threadshare/memory"), "status": "active"|"inactive" (default "active") }`
//! - result: `{ "repositoryKey": hex64, "worktreeKey": hex64,
//!   "publicRepositoryIdentity": string|null, "memoryRoot": string,
//!   "status": string }`
//!
//! ## `plan-tasks`
//! Batch-inserts pending chunks and tasks. Existing `chunkRef` / `taskId` rows
//! are skipped (idempotent).
//! - request: `{ "repositoryKey": hex64, "worktreeKey": hex64,
//!   "chunks": [{ "chunkRef": string, "sessionKey": hex64, "turnRange": string,
//!     "chunkDigest": hex64, "provenanceSnapshotSeq": string|null }],
//!   "tasks": [{ "taskId": string,
//!     "kind": "extraction"|"adjudication"|"consolidation",
//!     "chunkRef": string|null, "draftBatchRef": string|null,
//!     "binding": object, "authorizationPlanDigest": hex64|null }] }`
//! - result: `{ "insertedChunks": int, "skippedChunks": int,
//!   "insertedTasks": int, "skippedTasks": int }`
//!
//! ## `claim-task`
//! Transactional lease claim. Claimable iff `status='pending'`, or
//! `status='claimed'` with an expired lease; `submitted`/`stale` are never
//! re-claimable. Claiming bumps `lease_epoch` and issues a fresh random
//! `claimToken` that both submit ops must present.
//! - request: `{ "taskId": string, "leaseHolder": string, "leaseMs": int (1..=86400000) }`
//! - result: `{ "task": { "taskId": string, "kind": string,
//!   "repositoryKey": hex64, "worktreeKey": hex64, "chunkRef": string|null,
//!   "draftBatchRef": string|null, "binding": object,
//!   "authorizationPlanDigest": hex64|null, "status": "claimed",
//!   "createdAt": int, "lease": { "holder": string, "expiresAt": int,
//!   "epoch": int } }, "claimToken": hex32 }`
//! - errors: `TS_MEMORY_TASK_NOT_FOUND`, `TS_MEMORY_TASK_NOT_CLAIMABLE`.
//!
//! ## `submit-extraction`
//! Single transaction: claim-token CAS (`status='claimed' AND claimToken
//! matches AND lease not expired`, else `TS_MEMORY_LEASE_LOST`) → submission
//! idempotency (same `taskId`+`responseDigest` replays the stored outcome with
//! `"idempotent": true`; same `taskId` with a different digest records a
//! `submission_conflicts` row and fails with `TS_MEMORY_SUBMISSION_CONFLICT`)
//! → inserts candidates + candidate FTS + evidence refs + assessments →
//! `candidate_projection.generation+1` → chunk `drafted` → task `submitted`.
//! - request: `{ "taskId": string, "claimToken": string, "responseDigest": hex64,
//!   "drafts": [{ "candidateId": string, "payload": object,
//!     "searchableText": string }],
//!   "evidenceRefs": [{ "candidateId": string, "statementId": string,
//!     "evidenceId": string, "pointerDigest": hex64, "sessionKey": hex64|null,
//!     "turnKey": hex64|null, "revision": hex64|null,
//!     "payloadSha256": hex64|null, "relation": string|null,
//!     "strength": string|null, "limitations": [string]|null }],
//!   "assessments": [{ "candidateId": string, "statementId": string,
//!     "citationsDigest": hex64,
//!     "provenanceStrength": "direct"|"observed"|"candidate"|"contextual"|"unknown",
//!     "limitations": [string],
//!     "claimSupport": "unverified"|"typed-fact"|"human-confirmed",
//!     "assessedBy": "deterministic"|"human", "statementTextDigest": hex64,
//!     "revision": int }] }`
//!   Candidate `contentDigest` is engine-computed as
//!   `sha256hex(canonicalJson(payload))`.
//! - result: `{ "taskId": string, "idempotent": bool,
//!   "candidates": [{ "candidateId": string, "revision": int,
//!     "contentDigest": hex64, "status": string }],
//!   "candidateGeneration": int }`
//!
//! ## `recall`
//! Read-only. For each draft, takes `3×k` BM25 hits from `approved_fts` and
//! `candidate_fts` (owner-scoped; candidate side limited to
//! `draft`/`quarantined` rows and excluding this batch's own candidates), fuses
//! with `recall-rrf@1` (RRF k=60, rank starts at 1, tie-break lexicographic
//! `(sourceKind, id)`), and returns the top-k per draft plus a deduplicated
//! union pool.
//! - request: `{ "repositoryKey": hex64, "worktreeKey": hex64,
//!   "k": int (1..=50, default 5), "drafts": [{ "draftRef": string,
//!     "candidateId": string, "queryText": string }] }`
//! - result: `{ "recallAlgorithmVersion": "recall-rrf@1", "k": int,
//!   "approvedProjection": { "generation": int, "analyzerVersion": string,
//!     "coverage": "complete"|"partial" },
//!   "candidateProjection": { "generation": int, "analyzerVersion": string },
//!   "recallQueryDigest": hex64, "resultSetDigest": hex64,
//!   "recallSets": [{ "draftRef": string,
//!     "ordered": [{ "rank": int, "sourceKind": "approved"|"candidate",
//!       "id": string }] }],
//!   "pool": [{ "sourceKind": string, "id": string, "revision": int,
//!     "contentDigest": hex64, "state": string, "summary": string }] }`
//!   `recallQueryDigest = sha256hex(canonicalJson({ algorithm, k, owner:
//!   { repositoryKey, worktreeKey }, drafts: [{ draftRef, candidateId,
//!   queryText }] }))`. `resultSetDigest = sha256hex(canonicalJson([...]))` over
//!   the flattened ordered sequence `{ draftRef, rank, sourceKind, id,
//!   revision, contentDigest, state }` (drafts in request order).
//!
//! ## `submit-adjudication`
//! One `BEGIN IMMEDIATE` transaction: claim-token CAS → submission idempotency
//! (as in `submit-extraction`) → engine re-runs the embedded recall request and
//! compares `resultSetDigest` (mismatch → rollback, task `stale`, structured
//! stale result) → per-target candidate revision CAS (`UPDATE ... WHERE
//! candidate_id=? AND revision=?` with the revision the adjudicator saw in
//! `binding.poolItemRevisions`; any failure → rollback, task `stale`,
//! structured stale result) → applies adjudications
//! (`store` → draft quarantined; `skip` → draft discarded + FTS removal;
//! `update`/`merge` → targets discarded + FTS removal, draft payload/FTS
//! rewritten, revision+1, quarantined) → chunks `extracted` → task
//! `submitted` → `candidate_projection.generation+1`.
//! - request: `{ "taskId": string, "claimToken": string, "responseDigest": hex64,
//!   "recall": <recall request payload>, "expectedResultSetDigest": hex64,
//!   "adjudications": [{ "draftRef": string,
//!     "action": "store"|"skip"|"update"|"merge",
//!     "targets": [{ "id": string, "revision": int }],
//!     "mergedPayload": object|null, "mergedSearchableText": string|null }] }`
//!   Every recall draft must be adjudicated exactly once. `update`/`merge`
//!   require non-empty candidate-side `targets` (with the revisions the
//!   adjudicator saw), `mergedPayload`, and `mergedSearchableText`;
//!   `store`/`skip` forbid merged fields and mutate no targets.
//! - result (applied): `{ "taskId": string, "status": "applied",
//!   "idempotent": bool, "outcomes": [{ "draftRef": string, "action": string,
//!     "candidateId": string, "candidateStatus": string, "revision": int }],
//!   "candidateGeneration": int }`
//! - result (stale, no state change except task `stale`): `{ "taskId": string,
//!   "status": "stale", "reason": "result-set-digest-mismatch"|"revision-cas-failed",
//!   "expectedResultSetDigest": hex64, "actualResultSetDigest": hex64 }`
//!
//! ## `sync-approved`
//! DEV-1 contract. `coverage: "partial"` scans are recorded on
//! `approved_projection.coverage` and rejected with `TS_MEMORY_SYNC_PARTIAL`
//! (no generation change). A complete scan whose `sourceTreeDigest` equals the
//! stored digest (with stored coverage `complete`) short-circuits with
//! `"unchanged": true`. Otherwise a single transaction replaces this owner's
//! `approved_entries` + `approved_fts` wholesale and bumps `generation`.
//! - request: `{ "repositoryKey": hex64, "worktreeKey": hex64,
//!   "sourceTreeDigest": hex64, "coverage": "complete"|"partial",
//!   "entries": [{ "entryId": string, "revision": int, "contentDigest": hex64,
//!     "frontmatter": object, "bodyText": string, "status": string,
//!     "searchableText": string }] }`
//! - result: `{ "generation": int, "coverage": "complete", "unchanged": bool,
//!   "entryCount": int }`
//!
//! ## `search`
//! Read-only owner-scoped BM25 over `approved_fts`.
//! - request: `{ "repositoryKey": hex64, "worktreeKey": hex64,
//!   "query": string (1..=1024 chars), "limit": int (1..=100, default 10) }`
//! - result: `{ "generation": int, "coverage": string,
//!   "items": [{ "rank": int, "entryId": string, "revision": int,
//!     "contentDigest": hex64, "status": string, "summary": string }] }`
//!
//! ## `review-queue`
//! Read-only: quarantined candidates plus their assessments.
//! - request: `{ "repositoryKey": hex64, "worktreeKey": hex64,
//!   "limit": int (1..=200, default 50) }`
//! - result: `{ "items": [{ "candidateId": string, "chunkRef": string,
//!   "revision": int, "contentDigest": hex64, "payload": object,
//!   "assessments": [{ "statementId": string, "citationsDigest": hex64,
//!     "provenanceStrength": string, "limitations": [string],
//!     "claimSupport": string, "assessedBy": string,
//!     "statementTextDigest": hex64, "revision": int }] }] }`
//!
//! ## `status`
//! Read-only per-owner counters.
//! - request: `{ "repositoryKey": hex64, "worktreeKey": hex64 }`
//! - result: `{ "chunks": { "pending": int, "drafted": int, "extracted": int,
//!   "stale": int }, "tasks": { "pending": int, "claimed": int,
//!   "submitted": int, "stale": int }, "candidates": { "draft": int,
//!   "quarantined": int, "promoted": int, "discarded": int } }`
//!
//! Later stages add: `confirm-statement`, `discard-candidate`,
//! `promotion-plan`, `promotion-approve`, `promotion-apply`, `authorize`.

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::memory_state::{MemoryError, MemoryStorage};

/// Stage 4a op names (`MEMORY_COMMAND.op`), lowercase kebab-case per design §3.
pub const MEMORY_OPS: [&str; 11] = [
    "open",
    "bind-repository",
    "plan-tasks",
    "claim-task",
    "submit-extraction",
    "recall",
    "submit-adjudication",
    "sync-approved",
    "search",
    "review-queue",
    "status",
];

pub fn is_memory_op(op: &str) -> bool {
    MEMORY_OPS.contains(&op)
}

const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_PAYLOAD_ITEMS: usize = 512;

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn require(condition: bool, message: &str) -> Result<(), String> {
    if condition {
        Ok(())
    } else {
        Err(message.to_owned())
    }
}

fn valid_hex64(value: &str, label: &str) -> Result<(), String> {
    require(is_hex64(value), &format!("{label} must be sha256 hex64"))
}

fn valid_optional_hex64(value: Option<&String>, label: &str) -> Result<(), String> {
    match value {
        Some(value) => valid_hex64(value, label),
        None => Ok(()),
    }
}

fn valid_identifier(value: &str, label: &str) -> Result<(), String> {
    require(
        !value.is_empty() && value.len() <= 256 && !value.chars().any(char::is_control),
        &format!("{label} must be a non-empty control-free string of at most 256 bytes"),
    )
}

fn valid_text(value: &str, label: &str) -> Result<(), String> {
    require(
        value.len() <= MAX_TEXT_BYTES,
        &format!("{label} exceeds 64 KiB"),
    )
}

fn valid_object(value: &Value, label: &str) -> Result<(), String> {
    require(value.is_object(), &format!("{label} must be a JSON object"))
}

fn owner_fields(repository_key: &str, worktree_key: &str) -> Result<(), String> {
    valid_hex64(repository_key, "repositoryKey")?;
    valid_hex64(worktree_key, "worktreeKey")
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct OpenRequest {
    pub state_dir: String,
}

impl OpenRequest {
    pub fn validate(&self) -> Result<(), String> {
        require(
            std::path::Path::new(&self.state_dir).is_absolute(),
            "stateDir must be an absolute path",
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct BindRepositoryRequest {
    pub repository_key: String,
    pub worktree_key: String,
    pub public_repository_identity: Option<String>,
    pub root_realpath: String,
    pub root_realpath_digest: String,
    pub common_dir_device: String,
    pub common_dir_inode: String,
    #[serde(default = "default_memory_root")]
    pub memory_root: String,
    #[serde(default = "default_binding_status")]
    pub status: String,
}

fn default_memory_root() -> String {
    ".threadshare/memory".to_owned()
}

fn default_binding_status() -> String {
    "active".to_owned()
}

impl BindRepositoryRequest {
    pub fn validate(&self) -> Result<(), String> {
        owner_fields(&self.repository_key, &self.worktree_key)?;
        if let Some(identity) = &self.public_repository_identity {
            valid_identifier(identity, "publicRepositoryIdentity")?;
        }
        require(
            std::path::Path::new(&self.root_realpath).is_absolute(),
            "rootRealpath must be an absolute path",
        )?;
        valid_hex64(&self.root_realpath_digest, "rootRealpathDigest")?;
        valid_identifier(&self.common_dir_device, "commonDirDevice")?;
        valid_identifier(&self.common_dir_inode, "commonDirInode")?;
        valid_identifier(&self.memory_root, "memoryRoot")?;
        require(
            matches!(self.status.as_str(), "active" | "inactive"),
            "status must be active or inactive",
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanChunkInput {
    pub chunk_ref: String,
    pub session_key: String,
    pub turn_range: String,
    pub chunk_digest: String,
    pub provenance_snapshot_seq: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanTaskInput {
    pub task_id: String,
    pub kind: String,
    pub chunk_ref: Option<String>,
    pub draft_batch_ref: Option<String>,
    pub binding: Value,
    pub authorization_plan_digest: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PlanTasksRequest {
    pub repository_key: String,
    pub worktree_key: String,
    pub chunks: Vec<PlanChunkInput>,
    pub tasks: Vec<PlanTaskInput>,
}

impl PlanTasksRequest {
    pub fn validate(&self) -> Result<(), String> {
        owner_fields(&self.repository_key, &self.worktree_key)?;
        require(
            self.chunks.len() <= MAX_PAYLOAD_ITEMS && self.tasks.len() <= MAX_PAYLOAD_ITEMS,
            "plan-tasks batches are limited to 512 chunks and 512 tasks",
        )?;
        for chunk in &self.chunks {
            valid_identifier(&chunk.chunk_ref, "chunks[].chunkRef")?;
            valid_hex64(&chunk.session_key, "chunks[].sessionKey")?;
            valid_identifier(&chunk.turn_range, "chunks[].turnRange")?;
            valid_hex64(&chunk.chunk_digest, "chunks[].chunkDigest")?;
            if let Some(seq) = &chunk.provenance_snapshot_seq {
                require(
                    !seq.is_empty()
                        && (seq == "0" || !seq.starts_with('0'))
                        && seq.bytes().all(|byte| byte.is_ascii_digit()),
                    "chunks[].provenanceSnapshotSeq must be a canonical decimal string",
                )?;
            }
        }
        for task in &self.tasks {
            valid_identifier(&task.task_id, "tasks[].taskId")?;
            require(
                matches!(
                    task.kind.as_str(),
                    "extraction" | "adjudication" | "consolidation"
                ),
                "tasks[].kind must be extraction, adjudication, or consolidation",
            )?;
            if let Some(chunk_ref) = &task.chunk_ref {
                valid_identifier(chunk_ref, "tasks[].chunkRef")?;
            }
            if let Some(batch_ref) = &task.draft_batch_ref {
                valid_identifier(batch_ref, "tasks[].draftBatchRef")?;
            }
            valid_object(&task.binding, "tasks[].binding")?;
            valid_optional_hex64(
                task.authorization_plan_digest.as_ref(),
                "tasks[].authorizationPlanDigest",
            )?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ClaimTaskRequest {
    pub task_id: String,
    pub lease_holder: String,
    pub lease_ms: i64,
}

impl ClaimTaskRequest {
    pub fn validate(&self) -> Result<(), String> {
        valid_identifier(&self.task_id, "taskId")?;
        valid_identifier(&self.lease_holder, "leaseHolder")?;
        require(
            (1..=86_400_000).contains(&self.lease_ms),
            "leaseMs must be between 1 and 86400000",
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExtractionDraftInput {
    pub candidate_id: String,
    pub payload: Value,
    pub searchable_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceRefInput {
    pub candidate_id: String,
    pub statement_id: String,
    pub evidence_id: String,
    pub pointer_digest: String,
    pub session_key: Option<String>,
    pub turn_key: Option<String>,
    pub revision: Option<String>,
    pub payload_sha256: Option<String>,
    pub relation: Option<String>,
    pub strength: Option<String>,
    pub limitations: Option<Vec<String>>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AssessmentInput {
    pub candidate_id: String,
    pub statement_id: String,
    pub citations_digest: String,
    pub provenance_strength: String,
    pub limitations: Vec<String>,
    pub claim_support: String,
    pub assessed_by: String,
    pub statement_text_digest: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitExtractionRequest {
    pub task_id: String,
    pub claim_token: String,
    pub response_digest: String,
    pub drafts: Vec<ExtractionDraftInput>,
    pub evidence_refs: Vec<EvidenceRefInput>,
    pub assessments: Vec<AssessmentInput>,
}

impl SubmitExtractionRequest {
    pub fn validate(&self) -> Result<(), String> {
        valid_identifier(&self.task_id, "taskId")?;
        valid_identifier(&self.claim_token, "claimToken")?;
        valid_hex64(&self.response_digest, "responseDigest")?;
        require(!self.drafts.is_empty(), "drafts must not be empty")?;
        require(
            self.drafts.len() <= MAX_PAYLOAD_ITEMS
                && self.evidence_refs.len() <= MAX_PAYLOAD_ITEMS
                && self.assessments.len() <= MAX_PAYLOAD_ITEMS,
            "submit-extraction batches are limited to 512 items per list",
        )?;
        let mut candidate_ids = Vec::new();
        for draft in &self.drafts {
            valid_identifier(&draft.candidate_id, "drafts[].candidateId")?;
            valid_object(&draft.payload, "drafts[].payload")?;
            valid_text(&draft.searchable_text, "drafts[].searchableText")?;
            require(
                !candidate_ids.contains(&draft.candidate_id.as_str()),
                "drafts[].candidateId must be unique",
            )?;
            candidate_ids.push(draft.candidate_id.as_str());
        }
        for reference in &self.evidence_refs {
            require(
                candidate_ids.contains(&reference.candidate_id.as_str()),
                "evidenceRefs[].candidateId must reference a draft in this batch",
            )?;
            valid_identifier(&reference.statement_id, "evidenceRefs[].statementId")?;
            valid_identifier(&reference.evidence_id, "evidenceRefs[].evidenceId")?;
            valid_hex64(&reference.pointer_digest, "evidenceRefs[].pointerDigest")?;
            valid_optional_hex64(reference.session_key.as_ref(), "evidenceRefs[].sessionKey")?;
            valid_optional_hex64(reference.turn_key.as_ref(), "evidenceRefs[].turnKey")?;
            valid_optional_hex64(reference.revision.as_ref(), "evidenceRefs[].revision")?;
            valid_optional_hex64(
                reference.payload_sha256.as_ref(),
                "evidenceRefs[].payloadSha256",
            )?;
            if let Some(relation) = &reference.relation {
                valid_identifier(relation, "evidenceRefs[].relation")?;
            }
            if let Some(strength) = &reference.strength {
                valid_identifier(strength, "evidenceRefs[].strength")?;
            }
            if let Some(limitations) = &reference.limitations {
                for limitation in limitations {
                    valid_text(limitation, "evidenceRefs[].limitations[]")?;
                }
            }
        }
        for assessment in &self.assessments {
            require(
                candidate_ids.contains(&assessment.candidate_id.as_str()),
                "assessments[].candidateId must reference a draft in this batch",
            )?;
            validate_assessment(assessment)?;
        }
        Ok(())
    }
}

fn validate_assessment(assessment: &AssessmentInput) -> Result<(), String> {
    valid_identifier(&assessment.statement_id, "assessments[].statementId")?;
    valid_hex64(
        &assessment.citations_digest,
        "assessments[].citationsDigest",
    )?;
    require(
        matches!(
            assessment.provenance_strength.as_str(),
            "direct" | "observed" | "candidate" | "contextual" | "unknown"
        ),
        "assessments[].provenanceStrength is invalid",
    )?;
    for limitation in &assessment.limitations {
        valid_text(limitation, "assessments[].limitations[]")?;
    }
    require(
        matches!(
            assessment.claim_support.as_str(),
            "unverified" | "typed-fact" | "human-confirmed"
        ),
        "assessments[].claimSupport is invalid",
    )?;
    require(
        matches!(assessment.assessed_by.as_str(), "deterministic" | "human"),
        "assessments[].assessedBy is invalid",
    )?;
    valid_hex64(
        &assessment.statement_text_digest,
        "assessments[].statementTextDigest",
    )?;
    require(
        assessment.revision >= 1,
        "assessments[].revision must be at least 1",
    )
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecallDraftInput {
    pub draft_ref: String,
    pub candidate_id: String,
    pub query_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecallRequest {
    pub repository_key: String,
    pub worktree_key: String,
    #[serde(default = "default_recall_k")]
    pub k: u16,
    pub drafts: Vec<RecallDraftInput>,
}

fn default_recall_k() -> u16 {
    5
}

impl RecallRequest {
    pub fn validate(&self) -> Result<(), String> {
        owner_fields(&self.repository_key, &self.worktree_key)?;
        require((1..=50).contains(&self.k), "k must be between 1 and 50")?;
        require(!self.drafts.is_empty(), "drafts must not be empty")?;
        require(
            self.drafts.len() <= 64,
            "recall batches are limited to 64 drafts",
        )?;
        let mut refs = Vec::new();
        for draft in &self.drafts {
            valid_identifier(&draft.draft_ref, "drafts[].draftRef")?;
            valid_identifier(&draft.candidate_id, "drafts[].candidateId")?;
            valid_text(&draft.query_text, "drafts[].queryText")?;
            require(
                !refs.contains(&draft.draft_ref.as_str()),
                "drafts[].draftRef must be unique",
            )?;
            refs.push(draft.draft_ref.as_str());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdjudicationTargetInput {
    pub id: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AdjudicationInput {
    pub draft_ref: String,
    pub action: String,
    #[serde(default)]
    pub targets: Vec<AdjudicationTargetInput>,
    pub merged_payload: Option<Value>,
    pub merged_searchable_text: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SubmitAdjudicationRequest {
    pub task_id: String,
    pub claim_token: String,
    pub response_digest: String,
    pub recall: RecallRequest,
    pub expected_result_set_digest: String,
    pub adjudications: Vec<AdjudicationInput>,
}

impl SubmitAdjudicationRequest {
    pub fn validate(&self) -> Result<(), String> {
        valid_identifier(&self.task_id, "taskId")?;
        valid_identifier(&self.claim_token, "claimToken")?;
        valid_hex64(&self.response_digest, "responseDigest")?;
        self.recall.validate()?;
        valid_hex64(&self.expected_result_set_digest, "expectedResultSetDigest")?;
        let mut refs: Vec<&str> = self
            .recall
            .drafts
            .iter()
            .map(|draft| draft.draft_ref.as_str())
            .collect();
        require(
            self.adjudications.len() == refs.len(),
            "every recall draft must be adjudicated exactly once",
        )?;
        for adjudication in &self.adjudications {
            let position = refs
                .iter()
                .position(|value| *value == adjudication.draft_ref)
                .ok_or_else(|| {
                    "adjudications[].draftRef must match a recall draft exactly once".to_owned()
                })?;
            refs.swap_remove(position);
            match adjudication.action.as_str() {
                "store" | "skip" => {
                    require(
                        adjudication.merged_payload.is_none()
                            && adjudication.merged_searchable_text.is_none(),
                        "store/skip adjudications must not carry merged fields",
                    )?;
                }
                "update" | "merge" => {
                    require(
                        !adjudication.targets.is_empty(),
                        "update/merge adjudications require targets",
                    )?;
                    let payload = adjudication.merged_payload.as_ref().ok_or_else(|| {
                        "update/merge adjudications require mergedPayload".to_owned()
                    })?;
                    valid_object(payload, "adjudications[].mergedPayload")?;
                    let text = adjudication
                        .merged_searchable_text
                        .as_deref()
                        .ok_or_else(|| {
                            "update/merge adjudications require mergedSearchableText".to_owned()
                        })?;
                    valid_text(text, "adjudications[].mergedSearchableText")?;
                }
                _ => return Err("adjudications[].action is invalid".to_owned()),
            }
            for target in &adjudication.targets {
                valid_identifier(&target.id, "adjudications[].targets[].id")?;
                require(
                    target.revision >= 1,
                    "adjudications[].targets[].revision must be at least 1",
                )?;
            }
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ApprovedEntryInput {
    pub entry_id: String,
    pub revision: i64,
    pub content_digest: String,
    pub frontmatter: Value,
    pub body_text: String,
    pub status: String,
    pub searchable_text: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SyncApprovedRequest {
    pub repository_key: String,
    pub worktree_key: String,
    pub source_tree_digest: String,
    pub coverage: String,
    pub entries: Vec<ApprovedEntryInput>,
}

impl SyncApprovedRequest {
    pub fn validate(&self) -> Result<(), String> {
        owner_fields(&self.repository_key, &self.worktree_key)?;
        valid_hex64(&self.source_tree_digest, "sourceTreeDigest")?;
        require(
            matches!(self.coverage.as_str(), "complete" | "partial"),
            "coverage must be complete or partial",
        )?;
        require(
            self.entries.len() <= 4096,
            "sync-approved batches are limited to 4096 entries",
        )?;
        let mut ids = Vec::new();
        for entry in &self.entries {
            valid_identifier(&entry.entry_id, "entries[].entryId")?;
            require(entry.revision >= 1, "entries[].revision must be at least 1")?;
            valid_hex64(&entry.content_digest, "entries[].contentDigest")?;
            valid_object(&entry.frontmatter, "entries[].frontmatter")?;
            valid_text(&entry.body_text, "entries[].bodyText")?;
            valid_identifier(&entry.status, "entries[].status")?;
            valid_text(&entry.searchable_text, "entries[].searchableText")?;
            require(
                !ids.contains(&entry.entry_id.as_str()),
                "entries[].entryId must be unique",
            )?;
            ids.push(entry.entry_id.as_str());
        }
        Ok(())
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemorySearchRequest {
    pub repository_key: String,
    pub worktree_key: String,
    pub query: String,
    #[serde(default = "default_search_limit")]
    pub limit: u16,
}

fn default_search_limit() -> u16 {
    10
}

impl MemorySearchRequest {
    pub fn validate(&self) -> Result<(), String> {
        owner_fields(&self.repository_key, &self.worktree_key)?;
        require(
            !self.query.is_empty() && self.query.len() <= 1024,
            "query must be between 1 and 1024 bytes",
        )?;
        require(
            (1..=100).contains(&self.limit),
            "limit must be between 1 and 100",
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ReviewQueueRequest {
    pub repository_key: String,
    pub worktree_key: String,
    #[serde(default = "default_review_limit")]
    pub limit: u16,
}

fn default_review_limit() -> u16 {
    50
}

impl ReviewQueueRequest {
    pub fn validate(&self) -> Result<(), String> {
        owner_fields(&self.repository_key, &self.worktree_key)?;
        require(
            (1..=200).contains(&self.limit),
            "limit must be between 1 and 200",
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct MemoryStatusRequest {
    pub repository_key: String,
    pub worktree_key: String,
}

impl MemoryStatusRequest {
    pub fn validate(&self) -> Result<(), String> {
        owner_fields(&self.repository_key, &self.worktree_key)
    }
}

// ---------------------------------------------------------------------------
// Result payload shapes (engine → client).
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct OpenOutcome {
    pub memory_state_uuid: String,
    pub schema_version: u32,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct BindRepositoryOutcome {
    pub repository_key: String,
    pub worktree_key: String,
    pub public_repository_identity: Option<String>,
    pub memory_root: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PlanTasksOutcome {
    pub inserted_chunks: usize,
    pub skipped_chunks: usize,
    pub inserted_tasks: usize,
    pub skipped_tasks: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskLeaseWire {
    pub holder: String,
    pub expires_at: i64,
    pub epoch: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskWire {
    pub task_id: String,
    pub kind: String,
    pub repository_key: String,
    pub worktree_key: String,
    pub chunk_ref: Option<String>,
    pub draft_batch_ref: Option<String>,
    pub binding: Value,
    pub authorization_plan_digest: Option<String>,
    pub status: String,
    pub created_at: i64,
    pub lease: TaskLeaseWire,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClaimTaskOutcome {
    pub task: TaskWire,
    pub claim_token: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateStateWire {
    pub candidate_id: String,
    pub revision: i64,
    pub content_digest: String,
    pub status: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SubmitExtractionOutcome {
    pub task_id: String,
    pub idempotent: bool,
    pub candidates: Vec<CandidateStateWire>,
    pub candidate_generation: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ApprovedProjectionWire {
    pub generation: i64,
    pub analyzer_version: String,
    pub coverage: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateProjectionWire {
    pub generation: i64,
    pub analyzer_version: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallHitWire {
    pub rank: u32,
    pub source_kind: String,
    pub id: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallSetWire {
    pub draft_ref: String,
    pub ordered: Vec<RecallHitWire>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct PoolItemWire {
    pub source_kind: String,
    pub id: String,
    pub revision: i64,
    pub content_digest: String,
    pub state: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct RecallOutcome {
    pub recall_algorithm_version: String,
    pub k: u16,
    pub approved_projection: ApprovedProjectionWire,
    pub candidate_projection: CandidateProjectionWire,
    pub recall_query_digest: String,
    pub result_set_digest: String,
    pub recall_sets: Vec<RecallSetWire>,
    pub pool: Vec<PoolItemWire>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct AdjudicationDraftOutcome {
    pub draft_ref: String,
    pub action: String,
    pub candidate_id: String,
    pub candidate_status: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase", untagged)]
pub enum SubmitAdjudicationOutcome {
    #[serde(rename_all = "camelCase")]
    Applied {
        task_id: String,
        status: String,
        idempotent: bool,
        outcomes: Vec<AdjudicationDraftOutcome>,
        candidate_generation: i64,
    },
    #[serde(rename_all = "camelCase")]
    Stale {
        task_id: String,
        status: String,
        reason: String,
        expected_result_set_digest: String,
        actual_result_set_digest: String,
    },
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SyncApprovedOutcome {
    pub generation: i64,
    pub coverage: String,
    pub unchanged: bool,
    pub entry_count: usize,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchItemWire {
    pub rank: u32,
    pub entry_id: String,
    pub revision: i64,
    pub content_digest: String,
    pub status: String,
    pub summary: String,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SearchOutcome {
    pub generation: i64,
    pub coverage: String,
    pub items: Vec<SearchItemWire>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewAssessmentWire {
    pub statement_id: String,
    pub citations_digest: String,
    pub provenance_strength: String,
    pub limitations: Vec<String>,
    pub claim_support: String,
    pub assessed_by: String,
    pub statement_text_digest: String,
    pub revision: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewItemWire {
    pub candidate_id: String,
    pub chunk_ref: String,
    pub revision: i64,
    pub content_digest: String,
    pub payload: Value,
    pub assessments: Vec<ReviewAssessmentWire>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ReviewQueueOutcome {
    pub items: Vec<ReviewItemWire>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ChunkCountsWire {
    pub pending: i64,
    pub drafted: i64,
    pub extracted: i64,
    pub stale: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TaskCountsWire {
    pub pending: i64,
    pub claimed: i64,
    pub submitted: i64,
    pub stale: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct CandidateCountsWire {
    pub draft: i64,
    pub quarantined: i64,
    pub promoted: i64,
    pub discarded: i64,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatusOutcome {
    pub chunks: ChunkCountsWire,
    pub tasks: TaskCountsWire,
    pub candidates: CandidateCountsWire,
}

// ---------------------------------------------------------------------------
// Frame-level validation used by protocol.rs.
// ---------------------------------------------------------------------------

/// Validates a `MEMORY_COMMAND.payload` against the op's request schema.
pub fn validate_command_payload(op: &str, payload: &Value) -> Result<(), String> {
    fn parse<T: serde::de::DeserializeOwned>(
        payload: &Value,
        validate: impl FnOnce(&T) -> Result<(), String>,
    ) -> Result<(), String> {
        let request: T = serde_json::from_value(payload.clone())
            .map_err(|error| format!("payload has an invalid shape: {error}"))?;
        validate(&request)
    }
    match op {
        "open" => parse(payload, OpenRequest::validate),
        "bind-repository" => parse(payload, BindRepositoryRequest::validate),
        "plan-tasks" => parse(payload, PlanTasksRequest::validate),
        "claim-task" => parse(payload, ClaimTaskRequest::validate),
        "submit-extraction" => parse(payload, SubmitExtractionRequest::validate),
        "recall" => parse(payload, RecallRequest::validate),
        "submit-adjudication" => parse(payload, SubmitAdjudicationRequest::validate),
        "sync-approved" => parse(payload, SyncApprovedRequest::validate),
        "search" => parse(payload, MemorySearchRequest::validate),
        "review-queue" => parse(payload, ReviewQueueRequest::validate),
        "status" => parse(payload, MemoryStatusRequest::validate),
        _ => Err(format!("unknown memory op {op}")),
    }
}

// ---------------------------------------------------------------------------
// READY-state dispatch used by main.rs.
// ---------------------------------------------------------------------------

fn parse_request<T: serde::de::DeserializeOwned>(payload: &Value) -> Result<T, MemoryError> {
    serde_json::from_value(payload.clone())
        .map_err(|error| MemoryError::invalid(format!("memory payload is invalid: {error}")))
}

fn to_wire<T: Serialize>(outcome: &T) -> Result<Value, MemoryError> {
    serde_json::to_value(outcome).map_err(|error| {
        MemoryError::failed(format!("memory outcome serialization failed: {error}"))
    })
}

fn open_storage(
    memory: &mut Option<MemoryStorage>,
    request: &OpenRequest,
) -> Result<Value, MemoryError> {
    let state_dir = std::path::PathBuf::from(&request.state_dir);
    if let Some(existing) = memory {
        if existing.state_dir() != Some(state_dir.as_path()) {
            return Err(MemoryError::invalid(
                "the memory-state database is already open for a different stateDir",
            ));
        }
        return to_wire(&OpenOutcome {
            memory_state_uuid: existing.memory_state_uuid()?,
            schema_version: existing.schema_version()?,
        });
    }
    let storage = MemoryStorage::open_state_dir(&state_dir)?;
    let outcome = OpenOutcome {
        memory_state_uuid: storage.memory_state_uuid()?,
        schema_version: storage.schema_version()?,
    };
    *memory = Some(storage);
    to_wire(&outcome)
}

/// Executes one validated `MEMORY_COMMAND` and returns the `MEMORY_RESULT`
/// payload. The frame must already have passed `validate_protocol_message`.
pub fn handle_memory_command(
    memory: &mut Option<MemoryStorage>,
    op: &str,
    payload: &Value,
    now_unix_ms: i64,
) -> Result<Value, MemoryError> {
    if op == "open" {
        let request: OpenRequest = parse_request(payload)?;
        request.validate().map_err(MemoryError::invalid)?;
        return open_storage(memory, &request);
    }
    let storage = memory.as_mut().ok_or_else(|| {
        MemoryError::new(
            "TS_MEMORY_STATE_NOT_OPEN",
            "the memory-state database is not open; send MEMORY_COMMAND{op:\"open\"} first",
        )
    })?;
    match op {
        "bind-repository" => {
            let request: BindRepositoryRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            to_wire(&storage.bind_repository(&request)?)
        }
        "plan-tasks" => {
            let request: PlanTasksRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            to_wire(&storage.plan_tasks(&request, now_unix_ms)?)
        }
        "claim-task" => {
            let request: ClaimTaskRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            to_wire(&storage.claim_task(&request, now_unix_ms)?)
        }
        "submit-extraction" => {
            let request: SubmitExtractionRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            to_wire(&storage.submit_extraction(&request, now_unix_ms)?)
        }
        "recall" => {
            let request: RecallRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            to_wire(&storage.recall(&request)?)
        }
        "submit-adjudication" => {
            let request: SubmitAdjudicationRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            to_wire(&storage.submit_adjudication(&request, now_unix_ms)?)
        }
        "sync-approved" => {
            let request: SyncApprovedRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            to_wire(&storage.sync_approved(&request)?)
        }
        "search" => {
            let request: MemorySearchRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            to_wire(&storage.search(&request)?)
        }
        "review-queue" => {
            let request: ReviewQueueRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            to_wire(&storage.review_queue(&request)?)
        }
        "status" => {
            let request: MemoryStatusRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            to_wire(&storage.status(&request)?)
        }
        other => Err(MemoryError::invalid(format!("unknown memory op {other}"))),
    }
}
