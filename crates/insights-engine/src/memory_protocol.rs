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
//! `TS_MEMORY_STATE_CORRUPT` (storage). Stage 4c adds:
//! `TS_MEMORY_ASSESSMENT_NOT_FOUND`, `TS_MEMORY_CANDIDATE_NOT_FOUND`,
//! `TS_MEMORY_BINDING_NOT_FOUND`, `TS_MEMORY_PLAN_NOT_FOUND`,
//! `TS_MEMORY_TARGET_PATH_INVALID` (validation),
//! `TS_MEMORY_CANDIDATE_STALE`, `TS_MEMORY_UNVERIFIED_CLAIM`,
//! `TS_MEMORY_PLAN_STATE_INVALID`, `TS_MEMORY_PLAN_DIGEST_MISMATCH`,
//! `TS_MEMORY_OWNER_MISMATCH` (conflict).
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
//! (as in `submit-extraction`) → engine re-runs the embedded recall request
//! under a savepoint and compares `resultSetDigest` (mismatch → savepoint
//! rollback, task `stale`, structured stale result) → per-target candidate
//! revision CAS: every target revision must equal the revision the engine's
//! own recall re-run observed in the pool, and the `UPDATE` is additionally
//! constrained to the task owner and the `draft`/`quarantined` source states
//! (any failure → savepoint rollback, task `stale`, structured stale result)
//! → applies adjudications (`store` → draft quarantined; `skip` → draft
//! discarded + FTS removal; `update`/`merge` → targets discarded + FTS
//! removal, draft payload/FTS rewritten, revision+1, quarantined) → chunks
//! `extracted` → task `submitted` → `candidate_projection.generation+1`.
//! Stale outcomes never leave the outer transaction: the savepoint rollback
//! and the stale marking commit atomically, and the stale marking is a CAS on
//! `(claimToken, leaseEpoch, status='claimed')` so it can never touch a lease
//! that was reissued to another holder. If that CAS matches zero rows the
//! result reports the task's actual status instead of claiming `stale`.
//! - request: `{ "taskId": string, "claimToken": string, "responseDigest": hex64,
//!   "recall": <recall request payload>, "expectedResultSetDigest": hex64,
//!   "adjudications": [{ "draftRef": string,
//!     "action": "store"|"skip"|"update"|"merge",
//!     "targets": [{ "id": string, "revision": int }],
//!     "mergedPayload": object|null, "mergedSearchableText": string|null }] }`
//!   Every recall draft must be adjudicated exactly once. `update`/`merge`
//!   require non-empty candidate-side `targets` (with the revisions the
//!   adjudicator saw), `mergedPayload`, and `mergedSearchableText`;
//!   `store`/`skip` forbid merged fields and mutate no targets. Target `id`s
//!   must be unique across the whole request (a target may be consumed by at
//!   most one adjudication).
//! - result (applied): `{ "taskId": string, "status": "applied",
//!   "idempotent": bool, "outcomes": [{ "draftRef": string, "action": string,
//!     "candidateId": string, "candidateStatus": string, "revision": int }],
//!   "candidateGeneration": int }`
//! - result (stale, no state change except task `stale`): `{ "taskId": string,
//!   "status": "stale"|"pending"|"claimed"|"submitted",
//!   "reason": "result-set-digest-mismatch"|"revision-cas-failed",
//!   "expectedResultSetDigest": hex64, "actualResultSetDigest": hex64 }`
//!   (`status` is `"stale"` whenever the lease-scoped CAS marked the task; any
//!   other value reports the task's actual status after a zero-row CAS.)
//!
//! ## `sync-approved`
//! DEV-1 contract, generation-CAS guarded. The whole op runs in one
//! `BEGIN IMMEDIATE` transaction. `expectedGeneration` must equal the current
//! `approved_projection.generation` for this owner (0 when no projection row
//! exists yet); a mismatch returns the structured `"conflict"` result with
//! the current generation and stored `sourceTreeDigest` (the client must
//! rescan) and changes nothing — this also stops a stale `partial` scan from
//! downgrading a newer `complete` projection. After the CAS,
//! `coverage: "partial"` scans are recorded on `approved_projection.coverage`
//! and rejected with `TS_MEMORY_SYNC_PARTIAL` (no generation change). A
//! complete scan whose `sourceTreeDigest` equals the stored digest (with
//! stored coverage `complete`) short-circuits with `"unchanged": true`.
//! Otherwise this owner's `approved_entries` + `approved_fts` are replaced
//! wholesale and `generation` advances.
//! - request: `{ "repositoryKey": hex64, "worktreeKey": hex64,
//!   "sourceTreeDigest": hex64, "coverage": "complete"|"partial",
//!   "expectedGeneration": int (>= 0),
//!   "entries": [{ "entryId": string, "revision": int, "contentDigest": hex64,
//!     "frontmatter": object, "bodyText": string, "status": string,
//!     "searchableText": string }] }`
//! - result (synced): `{ "status": "synced", "generation": int,
//!   "coverage": "complete", "unchanged": bool, "entryCount": int }`
//! - result (conflict, no state change): `{ "status": "conflict",
//!   "generation": int, "coverage": "complete"|"partial",
//!   "sourceTreeDigest": hex64|null }`
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
//! Read-only per-owner counters, including the promotion-journal recovery
//! check: plans stuck in `applying` (crash during `promotion-apply`) are
//! reported in `promotions.applyingPlanIds` so the caller can re-run
//! `promotion-apply` (idempotent resume).
//! - request: `{ "repositoryKey": hex64, "worktreeKey": hex64 }`
//! - result: `{ "chunks": { "pending": int, "drafted": int, "extracted": int,
//!   "stale": int }, "tasks": { "pending": int, "claimed": int,
//!   "submitted": int, "stale": int }, "candidates": { "draft": int,
//!   "quarantined": int, "promoted": int, "discarded": int },
//!   "promotions": { "generated": int, "approved": int, "applying": int,
//!   "applied": int, "voided": int, "applyingPlanIds": [string] } }`
//!
//! # Ops (Stage 4c)
//!
//! ## `confirm-statement`
//! One transaction: loads the `(candidateId, statementId)` assessment
//! (`TS_MEMORY_ASSESSMENT_NOT_FOUND` when absent) and compares both digests
//! against what the reviewer saw. Any drift returns the structured
//! `"drifted"` result without state change; a match sets
//! `claimSupport='human-confirmed'`, `assessedBy='human'`, `revision+1`.
//! - request: `{ "candidateId": string, "statementId": string,
//!   "statementTextDigest": hex64, "citationsDigest": hex64 }`
//! - result (confirmed): `{ "candidateId": string, "statementId": string,
//!   "status": "confirmed", "claimSupport": "human-confirmed",
//!   "assessedBy": "human", "revision": int }`
//! - result (drifted, no state change): `{ "candidateId": string,
//!   "statementId": string, "status": "drifted",
//!   "actualStatementTextDigest": hex64, "actualCitationsDigest": hex64 }`
//!
//! ## `discard-candidate`
//! One transaction: the candidate must exist (`TS_MEMORY_CANDIDATE_NOT_FOUND`),
//! be `draft` or `quarantined`, and match `expectedRevision` (both violations:
//! `TS_MEMORY_CANDIDATE_STALE`). It then becomes `discarded` with
//! `revision+1`, its `candidate_fts` row is removed, and
//! `candidate_projection.generation` advances.
//! - request: `{ "candidateId": string, "expectedRevision": int }`
//! - result: `{ "candidateId": string, "status": "discarded",
//!   "revision": int, "candidateGeneration": int }`
//!
//! ## `promotion-plan`
//! One transaction. Requires an active `repository_bindings` row for the owner
//! (`TS_MEMORY_BINDING_NOT_FOUND`). Every candidate must exist for the owner
//! and be `quarantined` (`TS_MEMORY_CANDIDATE_NOT_FOUND` /
//! `TS_MEMORY_CANDIDATE_STALE`), and every statement must be verified: any
//! assessment with `claimSupport: "unverified"`, or any
//! `payload.statements[].statementId` without an assessment row, fails with
//! `TS_MEMORY_UNVERIFIED_CLAIM`. Each `targetPath` must be a normalized
//! relative path (no absolute paths, `.`/`..`, empty segments, backslashes,
//! colons, or control characters — enforced at validation) strictly below the
//! binding's `memoryRoot` (`TS_MEMORY_TARGET_PATH_INVALID`).
//! `sanitizedContent` is strict base64 of the exact sanitized bytes
//! (per file ≤ 1 MiB decoded, ≤ 128 files, ≤ 8 MiB total). The engine
//! computes `assessmentDigest` (canonical digest of the related assessment
//! rows ordered by `(candidateId, statementId)`), stores the sanitized bytes
//! in `promotion_files` with `sanitizedDigest = sha256(bytes)`, writes the
//! canonical plan document to `promotion_journal` with `status='generated'`,
//! and returns the plan summary. `planDigest` is the canonical digest of the
//! plan document `{ format: "threadshare-memory-promotion-plan@v1", planId,
//! owner: { repositoryKey, worktreeKey, memoryRoot }, candidateIds,
//! policyVersion, assessmentDigest, perFile: [{ targetPath, targetBlobHash,
//! sanitizedContentDigest }] }`.
//! - request: `{ "owner": { "repositoryKey": hex64, "worktreeKey": hex64 },
//!   "candidateIds": [string] (1..=512, unique), "policyVersion": string,
//!   "perFile": [{ "targetPath": string, "sanitizedContent": base64,
//!     "targetBlobHash": hex40|null }] (1..=128, unique targetPath) }`
//! - result: `{ "planId": uuid, "planDigest": hex64, "status": "generated",
//!   "owner": { "repositoryKey": hex64, "worktreeKey": hex64,
//!   "memoryRoot": string }, "candidateIds": [string],
//!   "policyVersion": string, "assessmentDigest": hex64,
//!   "files": [{ "targetPath": string, "targetBlobHash": hex40|null,
//!     "sanitizedDigest": hex64, "bytes": int }] }`
//!
//! ## `promotion-approve`
//! The explicit, digest-bound user approval (`generated → approved`). The
//! request digest must equal the stored `planDigest` exactly
//! (`TS_MEMORY_PLAN_DIGEST_MISMATCH` otherwise). Re-approving an already
//! `approved` plan with the matching digest replays idempotently; any other
//! state fails with `TS_MEMORY_PLAN_STATE_INVALID`.
//! - request: `{ "planId": string, "planDigest": hex64 }`
//! - result: `{ "planId": string, "planDigest": hex64,
//!   "status": "approved", "idempotent": bool }`
//!
//! ## `promotion-apply`
//! `approved → applying → applied | voided`. The plan owner is re-resolved:
//! `ownerRootRealpath` must equal `repository_bindings.root_realpath`
//! (`TS_MEMORY_OWNER_MISMATCH`). Per file (ordered by `targetPath`) the
//! engine itself reads the current worktree bytes through the no-follow
//! traversal and computes the git blob OID (`sha1("blob {len}\0"+bytes)`;
//! missing file → expected `targetBlobHash` null). Any mismatch with the
//! plan's recorded hash, any symlink path component, or content drift on an
//! already-applied file voids the plan and returns the structured `"voided"`
//! result with the drifted path. A passing file is written with the exact
//! `promotion_files` bytes (per-segment `openat` + `O_NOFOLLOW` +
//! `O_DIRECTORY`, temp file + atomic rename) and marked `applied=1`. After
//! all files, a closing transaction marks the journal `applied` and moves the
//! plan candidates `quarantined → promoted` with `revision+1`, removes their
//! `candidate_fts` rows (they leave the recall pool), and advances
//! `candidate_projection.generation`. Crash recovery: a plan left in
//! `applying` (reported by `status`) may be re-applied; files whose current
//! content digest already equals `sanitizedDigest` are skipped idempotently,
//! and an `applied` plan replays with `"idempotent": true`. `generated` and
//! `voided` plans are rejected with `TS_MEMORY_PLAN_STATE_INVALID`.
//! - request: `{ "planId": string, "ownerRootRealpath": "<absolute path>" }`
//! - result (applied): `{ "planId": string, "status": "applied",
//!   "idempotent": bool, "appliedFiles": [string],
//!   "candidates": [{ "candidateId": string, "revision": int,
//!     "status": "promoted" }], "candidateGeneration": int }`
//! - result (voided): `{ "planId": string, "status": "voided",
//!   "driftedPath": string }`
//!
//! ## `authorize`
//! Appends one `authorization_log` row (plan- or manifest-scoped input
//! authorization audit).
//! - request: `{ "planDigest": hex64, "taskId": string|null,
//!   "runnerInputDigest": hex64|null, "inputCoverageDigest": hex64|null,
//!   "provider": string, "model": string, "endpoint": string, "bytes": int,
//!   "via": "interactive"|"digest"|"manifest", "manifestDigest": hex64|null }`
//! - result: `{ "planDigest": hex64, "taskId": string|null, "via": string,
//!   "decidedAt": int }`

use serde::{Deserialize, Serialize};
use serde_json::Value;

use crate::memory_state::{MemoryError, MemoryStorage};

/// Stage 4a + 4c op names (`MEMORY_COMMAND.op`), lowercase kebab-case per design §3.
pub const MEMORY_OPS: [&str; 17] = [
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
    "confirm-statement",
    "discard-candidate",
    "promotion-plan",
    "promotion-approve",
    "promotion-apply",
    "authorize",
];

pub fn is_memory_op(op: &str) -> bool {
    MEMORY_OPS.contains(&op)
}

const MAX_TEXT_BYTES: usize = 64 * 1024;
const MAX_PAYLOAD_ITEMS: usize = 512;
const MAX_PLAN_FILES: usize = 128;
const MAX_PLAN_FILE_BYTES: usize = 1024 * 1024;
const MAX_PLAN_TOTAL_BYTES: usize = 8 * 1024 * 1024;
const MAX_TARGET_PATH_BYTES: usize = 1024;

fn is_hex64(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || (b'a'..=b'f').contains(&byte))
}

fn is_hex40(value: &str) -> bool {
    value.len() == 40
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
        let mut target_ids: Vec<&str> = Vec::new();
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
                require(
                    !target_ids.contains(&target.id.as_str()),
                    "adjudications[].targets[].id must be unique across the request",
                )?;
                target_ids.push(target.id.as_str());
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
    pub expected_generation: i64,
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
            self.expected_generation >= 0,
            "expectedGeneration must be non-negative",
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

/// Normalized relative path check for `promotion-plan` targets: relative,
/// slash-separated, no empty/`.`/`..` segments, no backslashes, colons, or
/// control characters. Containment below the binding's `memoryRoot` is
/// enforced by the storage op (which knows the binding).
fn valid_target_path(value: &str, label: &str) -> Result<(), String> {
    require(
        !value.is_empty() && value.len() <= MAX_TARGET_PATH_BYTES,
        &format!("{label} must be between 1 and {MAX_TARGET_PATH_BYTES} bytes"),
    )?;
    require(
        !value.contains('\\') && !value.contains(':') && !value.chars().any(char::is_control),
        &format!("{label} must not contain backslashes, colons, or control characters"),
    )?;
    require(
        !value.starts_with('/'),
        &format!("{label} must be a relative path"),
    )?;
    for segment in value.split('/') {
        require(
            !segment.is_empty(),
            &format!("{label} must not contain empty segments"),
        )?;
        require(
            segment != "." && segment != "..",
            &format!("{label} must not contain dot segments"),
        )?;
    }
    Ok(())
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ConfirmStatementRequest {
    pub candidate_id: String,
    pub statement_id: String,
    pub statement_text_digest: String,
    pub citations_digest: String,
}

impl ConfirmStatementRequest {
    pub fn validate(&self) -> Result<(), String> {
        valid_identifier(&self.candidate_id, "candidateId")?;
        valid_identifier(&self.statement_id, "statementId")?;
        valid_hex64(&self.statement_text_digest, "statementTextDigest")?;
        valid_hex64(&self.citations_digest, "citationsDigest")
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DiscardCandidateRequest {
    pub candidate_id: String,
    pub expected_revision: i64,
}

impl DiscardCandidateRequest {
    pub fn validate(&self) -> Result<(), String> {
        valid_identifier(&self.candidate_id, "candidateId")?;
        require(
            self.expected_revision >= 1,
            "expectedRevision must be at least 1",
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromotionOwnerInput {
    pub repository_key: String,
    pub worktree_key: String,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromotionFileInput {
    pub target_path: String,
    pub sanitized_content: String,
    pub target_blob_hash: Option<String>,
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromotionPlanRequest {
    pub owner: PromotionOwnerInput,
    pub candidate_ids: Vec<String>,
    pub policy_version: String,
    pub per_file: Vec<PromotionFileInput>,
}

impl PromotionPlanRequest {
    pub fn validate(&self) -> Result<(), String> {
        owner_fields(&self.owner.repository_key, &self.owner.worktree_key)?;
        require(
            !self.candidate_ids.is_empty() && self.candidate_ids.len() <= MAX_PAYLOAD_ITEMS,
            "candidateIds must contain between 1 and 512 entries",
        )?;
        let mut candidate_ids = Vec::new();
        for candidate_id in &self.candidate_ids {
            valid_identifier(candidate_id, "candidateIds[]")?;
            require(
                !candidate_ids.contains(&candidate_id.as_str()),
                "candidateIds[] must be unique",
            )?;
            candidate_ids.push(candidate_id.as_str());
        }
        valid_identifier(&self.policy_version, "policyVersion")?;
        require(
            !self.per_file.is_empty() && self.per_file.len() <= MAX_PLAN_FILES,
            "perFile must contain between 1 and 128 entries",
        )?;
        let mut total_bytes = 0usize;
        let mut target_paths = Vec::new();
        for file in &self.per_file {
            valid_target_path(&file.target_path, "perFile[].targetPath")?;
            require(
                !target_paths.contains(&file.target_path.as_str()),
                "perFile[].targetPath must be unique",
            )?;
            target_paths.push(file.target_path.as_str());
            let bytes = crate::memory_promotion::decode_base64(&file.sanitized_content)
                .ok_or_else(|| {
                    "perFile[].sanitizedContent must be strict padded base64".to_owned()
                })?;
            require(
                bytes.len() <= MAX_PLAN_FILE_BYTES,
                "perFile[].sanitizedContent exceeds 1 MiB decoded",
            )?;
            total_bytes += bytes.len();
            if let Some(blob_hash) = &file.target_blob_hash {
                require(
                    is_hex40(blob_hash),
                    "perFile[].targetBlobHash must be a git blob OID (hex40)",
                )?;
            }
        }
        require(
            total_bytes <= MAX_PLAN_TOTAL_BYTES,
            "perFile decoded content exceeds 8 MiB in total",
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromotionApproveRequest {
    pub plan_id: String,
    pub plan_digest: String,
}

impl PromotionApproveRequest {
    pub fn validate(&self) -> Result<(), String> {
        valid_identifier(&self.plan_id, "planId")?;
        valid_hex64(&self.plan_digest, "planDigest")
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct PromotionApplyRequest {
    pub plan_id: String,
    pub owner_root_realpath: String,
}

impl PromotionApplyRequest {
    pub fn validate(&self) -> Result<(), String> {
        valid_identifier(&self.plan_id, "planId")?;
        require(
            std::path::Path::new(&self.owner_root_realpath).is_absolute(),
            "ownerRootRealpath must be an absolute path",
        )
    }
}

#[derive(Debug, Clone, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct AuthorizeRequest {
    pub plan_digest: String,
    pub task_id: Option<String>,
    pub runner_input_digest: Option<String>,
    pub input_coverage_digest: Option<String>,
    pub provider: String,
    pub model: String,
    pub endpoint: String,
    pub bytes: i64,
    pub via: String,
    pub manifest_digest: Option<String>,
}

impl AuthorizeRequest {
    pub fn validate(&self) -> Result<(), String> {
        valid_hex64(&self.plan_digest, "planDigest")?;
        if let Some(task_id) = &self.task_id {
            valid_identifier(task_id, "taskId")?;
        }
        valid_optional_hex64(self.runner_input_digest.as_ref(), "runnerInputDigest")?;
        valid_optional_hex64(self.input_coverage_digest.as_ref(), "inputCoverageDigest")?;
        valid_identifier(&self.provider, "provider")?;
        valid_identifier(&self.model, "model")?;
        valid_identifier(&self.endpoint, "endpoint")?;
        require(self.bytes >= 0, "bytes must be non-negative")?;
        require(
            matches!(self.via.as_str(), "interactive" | "digest" | "manifest"),
            "via must be interactive, digest, or manifest",
        )?;
        valid_optional_hex64(self.manifest_digest.as_ref(), "manifestDigest")
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
pub struct PromotionCountsWire {
    pub generated: i64,
    pub approved: i64,
    pub applying: i64,
    pub applied: i64,
    pub voided: i64,
    pub applying_plan_ids: Vec<String>,
}

#[derive(Debug, Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct MemoryStatusOutcome {
    pub chunks: ChunkCountsWire,
    pub tasks: TaskCountsWire,
    pub candidates: CandidateCountsWire,
    pub promotions: PromotionCountsWire,
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
        "confirm-statement" => parse(payload, ConfirmStatementRequest::validate),
        "discard-candidate" => parse(payload, DiscardCandidateRequest::validate),
        "promotion-plan" => parse(payload, PromotionPlanRequest::validate),
        "promotion-approve" => parse(payload, PromotionApproveRequest::validate),
        "promotion-apply" => parse(payload, PromotionApplyRequest::validate),
        "authorize" => parse(payload, AuthorizeRequest::validate),
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
            storage.sync_approved(&request)
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
        "confirm-statement" => {
            let request: ConfirmStatementRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            storage.confirm_statement(&request)
        }
        "discard-candidate" => {
            let request: DiscardCandidateRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            storage.discard_candidate(&request, now_unix_ms)
        }
        "promotion-plan" => {
            let request: PromotionPlanRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            storage.promotion_plan(&request, now_unix_ms)
        }
        "promotion-approve" => {
            let request: PromotionApproveRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            storage.promotion_approve(&request, now_unix_ms)
        }
        "promotion-apply" => {
            let request: PromotionApplyRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            storage.promotion_apply(&request, now_unix_ms)
        }
        "authorize" => {
            let request: AuthorizeRequest = parse_request(payload)?;
            request.validate().map_err(MemoryError::invalid)?;
            storage.authorize(&request, now_unix_ms)
        }
        other => Err(MemoryError::invalid(format!("unknown memory op {other}"))),
    }
}
