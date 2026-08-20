use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use threadshare_insights_engine::memory_protocol::{
    BindRepositoryRequest, ClaimTaskRequest, MemorySearchRequest, MemoryStatusRequest,
    PlanTasksRequest, RecallRequest, SubmitAdjudicationRequest, SubmitExtractionRequest,
    SyncApprovedRequest,
};
use threadshare_insights_engine::memory_state::{MEMORY_STATE_SCHEMA_VERSION, MemoryStorage};

static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

const REPO: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const TREE: &str = "2222222222222222222222222222222222222222222222222222222222222222";

fn temp_state_dir(label: &str) -> PathBuf {
    let root = std::env::temp_dir().join(format!(
        "threadshare-memory-{label}-{}-{}",
        std::process::id(),
        NEXT_TEMP_DIR.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    root
}

fn hex64(character: char) -> String {
    character.to_string().repeat(64)
}

fn request<T: serde::de::DeserializeOwned>(value: Value) -> T {
    serde_json::from_value(value).unwrap()
}

fn plan_chunk_and_task(
    storage: &mut MemoryStorage,
    chunk_ref: &str,
    task_id: &str,
    kind: &str,
    now: i64,
) {
    let chunks = if kind == "extraction" {
        json!([{
            "chunkRef": chunk_ref,
            "sessionKey": hex64('3'),
            "turnRange": "1..4",
            "chunkDigest": hex64('4'),
            "provenanceSnapshotSeq": "7",
        }])
    } else {
        json!([])
    };
    let plan: PlanTasksRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "chunks": chunks,
        "tasks": [{
            "taskId": task_id,
            "kind": kind,
            "chunkRef": if kind == "extraction" { Value::from(chunk_ref) } else { Value::Null },
            "draftBatchRef": if kind == "adjudication" { Value::from("batch-1") } else { Value::Null },
            "binding": { "promptVersion": "p@1" },
            "authorizationPlanDigest": null,
        }],
    }));
    plan.validate().unwrap();
    storage.plan_tasks(&plan, now).unwrap();
}

fn claim(
    storage: &mut MemoryStorage,
    task_id: &str,
    holder: &str,
    lease_ms: i64,
    now: i64,
) -> String {
    let claim: ClaimTaskRequest = request(json!({
        "taskId": task_id,
        "leaseHolder": holder,
        "leaseMs": lease_ms,
    }));
    claim.validate().unwrap();
    let outcome = storage.claim_task(&claim, now).unwrap();
    assert_eq!(outcome.task.status, "claimed");
    assert_eq!(outcome.task.lease.holder, holder);
    outcome.claim_token
}

fn extraction_request(
    task_id: &str,
    claim_token: &str,
    digest_char: char,
    drafts: &[(&str, &str, &str)],
) -> SubmitExtractionRequest {
    let draft_values: Vec<Value> = drafts
        .iter()
        .map(|(candidate_id, content, text)| {
            json!({
                "candidateId": candidate_id,
                "payload": { "content": content, "type": "work_method" },
                "searchableText": text,
            })
        })
        .collect();
    let first = drafts[0].0;
    let value: SubmitExtractionRequest = request(json!({
        "taskId": task_id,
        "claimToken": claim_token,
        "responseDigest": hex64(digest_char),
        "drafts": draft_values,
        "evidenceRefs": [{
            "candidateId": first,
            "statementId": "s1",
            "evidenceId": "e1",
            "pointerDigest": hex64('5'),
            "sessionKey": hex64('3'),
            "turnKey": null,
            "revision": hex64('6'),
            "payloadSha256": null,
            "relation": "direct",
            "strength": "direct",
            "limitations": ["single-run"],
        }],
        "assessments": [{
            "candidateId": first,
            "statementId": "s1",
            "citationsDigest": hex64('7'),
            "provenanceStrength": "direct",
            "limitations": ["single-run"],
            "claimSupport": "unverified",
            "assessedBy": "deterministic",
            "statementTextDigest": hex64('8'),
            "revision": 1,
        }],
    }));
    value.validate().unwrap();
    value
}

fn submit_extraction_ok(
    storage: &mut MemoryStorage,
    task_id: &str,
    claim_token: &str,
    digest_char: char,
    drafts: &[(&str, &str, &str)],
    now: i64,
) -> Value {
    let request = extraction_request(task_id, claim_token, digest_char, drafts);
    storage.submit_extraction(&request, now).unwrap()
}

fn recall_request(draft_ref: &str, candidate_id: &str, query_text: &str) -> RecallRequest {
    let value: RecallRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "drafts": [{
            "draftRef": draft_ref,
            "candidateId": candidate_id,
            "queryText": query_text,
        }],
    }));
    value.validate().unwrap();
    value
}

fn status_counts(storage: &MemoryStorage) -> Value {
    let status: MemoryStatusRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
    }));
    serde_json::to_value(storage.status(&status).unwrap()).unwrap()
}

fn sync_request(
    digest_char: char,
    coverage: &str,
    entries: &[(&str, &str)],
) -> SyncApprovedRequest {
    let entry_values: Vec<Value> = entries
        .iter()
        .map(|(entry_id, text)| {
            json!({
                "entryId": entry_id,
                "revision": 1,
                "contentDigest": hex64('9'),
                "frontmatter": { "type": "work_method" },
                "bodyText": text,
                "status": "active",
                "searchableText": text,
            })
        })
        .collect();
    let value: SyncApprovedRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "sourceTreeDigest": hex64(digest_char),
        "coverage": coverage,
        "entries": entry_values,
    }));
    value.validate().unwrap();
    value
}

#[test]
fn opens_and_migrates_idempotently_with_owner_only_permissions() {
    let state_dir = temp_state_dir("open");
    let first_uuid;
    {
        let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
        assert_eq!(
            storage.schema_version().unwrap(),
            MEMORY_STATE_SCHEMA_VERSION
        );
        first_uuid = storage.memory_state_uuid().unwrap();
        plan_chunk_and_task(&mut storage, "chunk-1", "task-1", "extraction", 1_000);
    }
    let storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    assert_eq!(storage.memory_state_uuid().unwrap(), first_uuid);
    assert_eq!(
        storage.schema_version().unwrap(),
        MEMORY_STATE_SCHEMA_VERSION
    );
    let counts = status_counts(&storage);
    assert_eq!(counts["chunks"]["pending"], 1);
    assert_eq!(counts["tasks"]["pending"], 1);
    #[cfg(unix)]
    {
        use std::os::unix::fs::PermissionsExt;
        let mode = std::fs::metadata(storage.database_path().unwrap())
            .unwrap()
            .permissions()
            .mode();
        assert_eq!(mode & 0o777, 0o600);
    }
}

#[test]
fn claims_recover_expired_leases_and_never_reissue_submitted_tasks() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    plan_chunk_and_task(&mut storage, "chunk-1", "task-1", "extraction", 1_000);

    let token_a = claim(&mut storage, "task-1", "holder-a", 1_000, 10_000);
    let request_b: ClaimTaskRequest = request(json!({
        "taskId": "task-1",
        "leaseHolder": "holder-b",
        "leaseMs": 1_000,
    }));
    let error = storage.claim_task(&request_b, 10_500).unwrap_err();
    assert_eq!(error.code, "TS_MEMORY_TASK_NOT_CLAIMABLE");

    let outcome = storage.claim_task(&request_b, 12_000).unwrap();
    assert_eq!(outcome.task.lease.epoch, 2);
    assert_ne!(outcome.claim_token, token_a);

    let missing: ClaimTaskRequest = request(json!({
        "taskId": "task-x",
        "leaseHolder": "holder-b",
        "leaseMs": 1_000,
    }));
    assert_eq!(
        storage.claim_task(&missing, 12_000).unwrap_err().code,
        "TS_MEMORY_TASK_NOT_FOUND"
    );

    submit_extraction_ok(
        &mut storage,
        "task-1",
        &outcome.claim_token,
        'a',
        &[("cand-1", "deploy steps", "deploy steps")],
        12_100,
    );
    let error = storage.claim_task(&request_b, 99_999_999).unwrap_err();
    assert_eq!(error.code, "TS_MEMORY_TASK_NOT_CLAIMABLE");
}

#[test]
fn claim_token_cas_rejects_submissions_from_superseded_holders() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    plan_chunk_and_task(&mut storage, "chunk-1", "task-1", "extraction", 1_000);

    let token_a = claim(&mut storage, "task-1", "holder-a", 1_000, 10_000);
    let token_b = claim(&mut storage, "task-1", "holder-b", 1_000, 12_000);

    let stale_submit = extraction_request(
        "task-1",
        &token_a,
        'a',
        &[("cand-1", "deploy steps", "deploy steps")],
    );
    let error = storage
        .submit_extraction(&stale_submit, 12_100)
        .unwrap_err();
    assert_eq!(error.code, "TS_MEMORY_LEASE_LOST");

    let outcome = submit_extraction_ok(
        &mut storage,
        "task-1",
        &token_b,
        'b',
        &[("cand-1", "deploy steps", "deploy steps")],
        12_200,
    );
    assert_eq!(outcome["idempotent"], false);

    // An expired lease is also rejected even with the right token.
    plan_chunk_and_task(&mut storage, "chunk-2", "task-2", "extraction", 1_000);
    let token = claim(&mut storage, "task-2", "holder-a", 1_000, 20_000);
    let late = extraction_request("task-2", &token, 'c', &[("cand-2", "late", "late")]);
    let error = storage.submit_extraction(&late, 30_000).unwrap_err();
    assert_eq!(error.code, "TS_MEMORY_LEASE_LOST");
}

#[test]
fn submit_extraction_is_idempotent_and_audits_digest_conflicts() {
    let state_dir = temp_state_dir("extract");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    plan_chunk_and_task(&mut storage, "chunk-1", "task-1", "extraction", 1_000);
    let token = claim(&mut storage, "task-1", "holder-a", 60_000, 10_000);

    let drafts = [
        ("cand-1", "release checklist", "release checklist alpha"),
        ("cand-2", "rollback recipe", "rollback recipe beta"),
    ];
    let first = submit_extraction_ok(&mut storage, "task-1", &token, 'a', &drafts, 10_100);
    assert_eq!(first["idempotent"], false);
    assert_eq!(first["candidateGeneration"], 1);
    assert_eq!(first["candidates"].as_array().unwrap().len(), 2);
    let counts = status_counts(&storage);
    assert_eq!(counts["chunks"]["drafted"], 1);
    assert_eq!(counts["tasks"]["submitted"], 1);
    assert_eq!(counts["candidates"]["draft"], 2);

    let replay = submit_extraction_ok(&mut storage, "task-1", &token, 'a', &drafts, 10_200);
    assert_eq!(replay["idempotent"], true);
    assert_eq!(replay["candidates"], first["candidates"]);
    assert_eq!(replay["candidateGeneration"], first["candidateGeneration"]);
    assert_eq!(status_counts(&storage)["candidates"]["draft"], 2);

    let conflicting = extraction_request("task-1", &token, 'b', &drafts);
    let error = storage.submit_extraction(&conflicting, 10_300).unwrap_err();
    assert_eq!(error.code, "TS_MEMORY_SUBMISSION_CONFLICT");

    let audit = rusqlite::Connection::open(storage.database_path().unwrap()).unwrap();
    let conflicts: i64 = audit
        .query_row(
            "SELECT COUNT(*) FROM submission_conflicts WHERE task_id='task-1'",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(conflicts, 1);
    let submissions: i64 = audit
        .query_row("SELECT COUNT(*) FROM submissions", [], |row| row.get(0))
        .unwrap();
    assert_eq!(submissions, 1);
}

#[test]
fn recall_orders_by_rrf_with_deterministic_tiebreaks() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    storage
        .sync_approved(&sync_request(
            'a',
            "complete",
            &[
                ("entry-b", "alpha migration playbook"),
                ("entry-a", "alpha migration playbook"),
            ],
        ))
        .unwrap();
    plan_chunk_and_task(&mut storage, "chunk-1", "task-1", "extraction", 1_000);
    let token = claim(&mut storage, "task-1", "holder-a", 60_000, 10_000);
    submit_extraction_ok(
        &mut storage,
        "task-1",
        &token,
        'a',
        &[
            (
                "cand-pool",
                "alpha migration playbook",
                "alpha migration playbook",
            ),
            ("cand-draft", "alpha draft", "alpha draft"),
        ],
        10_100,
    );

    let recall = recall_request("d1", "cand-draft", "alpha migration playbook");
    let first = storage.recall(&recall).unwrap();
    let ordered = &first.recall_sets[0].ordered;
    // Identical texts give equal per-list BM25; list rank ties are broken by
    // (sourceKind, id): approved before candidate, then id lexicographically.
    assert_eq!(ordered[0].source_kind, "approved");
    assert_eq!(ordered[0].id, "entry-a");
    assert_eq!(ordered[0].rank, 1);
    assert_eq!(ordered[1].source_kind, "candidate");
    assert_eq!(ordered[1].id, "cand-pool");
    assert_eq!(ordered[2].source_kind, "approved");
    assert_eq!(ordered[2].id, "entry-b");
    // The batch's own draft never recalls itself.
    assert!(ordered.iter().all(|hit| hit.id != "cand-draft"));

    let second = storage.recall(&recall).unwrap();
    assert_eq!(second.result_set_digest, first.result_set_digest);
    assert_eq!(second.recall_query_digest, first.recall_query_digest);
    assert_eq!(first.approved_projection.generation, 1);
    assert_eq!(first.candidate_projection.generation, 1);
}

fn setup_adjudication_fixture(storage: &mut MemoryStorage) -> (String, String) {
    // Target candidate from an earlier chunk plus the current draft batch.
    plan_chunk_and_task(storage, "chunk-1", "task-1", "extraction", 1_000);
    let token = claim(storage, "task-1", "holder-a", 60_000, 10_000);
    submit_extraction_ok(
        storage,
        "task-1",
        &token,
        'a',
        &[("cand-old", "legacy deploy runbook", "legacy deploy runbook")],
        10_100,
    );
    plan_chunk_and_task(storage, "chunk-2", "task-2", "extraction", 1_000);
    let token = claim(storage, "task-2", "holder-a", 60_000, 11_000);
    submit_extraction_ok(
        storage,
        "task-2",
        &token,
        'b',
        &[(
            "cand-new",
            "deploy runbook draft",
            "legacy deploy runbook draft",
        )],
        11_100,
    );
    plan_chunk_and_task(storage, "", "task-adj", "adjudication", 1_000);
    let adj_token = claim(storage, "task-adj", "holder-a", 60_000, 12_000);
    let recall = recall_request("d1", "cand-new", "legacy deploy runbook");
    let outcome = storage.recall(&recall).unwrap();
    assert!(
        outcome
            .pool
            .iter()
            .any(|item| item.source_kind == "candidate" && item.id == "cand-old")
    );
    (adj_token, outcome.result_set_digest)
}

fn adjudication_request(
    claim_token: &str,
    digest: &str,
    action: &str,
    target_revision: i64,
) -> SubmitAdjudicationRequest {
    let (targets, merged_payload, merged_text) = match action {
        "merge" | "update" => (
            json!([{ "id": "cand-old", "revision": target_revision }]),
            json!({ "content": "merged deploy runbook", "type": "work_method" }),
            Value::from("merged deploy runbook"),
        ),
        _ => (json!([]), Value::Null, Value::Null),
    };
    let value: SubmitAdjudicationRequest = request(json!({
        "taskId": "task-adj",
        "claimToken": claim_token,
        "responseDigest": hex64('d'),
        "recall": {
            "repositoryKey": REPO,
            "worktreeKey": TREE,
            "drafts": [{
                "draftRef": "d1",
                "candidateId": "cand-new",
                "queryText": "legacy deploy runbook",
            }],
        },
        "expectedResultSetDigest": digest,
        "adjudications": [{
            "draftRef": "d1",
            "action": action,
            "targets": targets,
            "mergedPayload": merged_payload,
            "mergedSearchableText": merged_text,
        }],
    }));
    value.validate().unwrap();
    value
}

#[test]
fn adjudication_merge_applies_and_reindexes_fts() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    let (token, digest) = setup_adjudication_fixture(&mut storage);

    let submit = adjudication_request(&token, &digest, "merge", 1);
    let outcome = storage.submit_adjudication(&submit, 12_100).unwrap();
    assert_eq!(outcome["status"], "applied");
    assert_eq!(outcome["idempotent"], false);
    assert_eq!(outcome["outcomes"][0]["candidateStatus"], "quarantined");
    assert_eq!(outcome["outcomes"][0]["revision"], 2);
    assert_eq!(outcome["candidateGeneration"], 3);

    let counts = status_counts(&storage);
    assert_eq!(counts["candidates"]["quarantined"], 1);
    assert_eq!(counts["candidates"]["discarded"], 1);
    assert_eq!(counts["chunks"]["extracted"], 1);
    assert_eq!(counts["tasks"]["submitted"], 3);

    // The merged draft is retrievable through FTS under its *new* content, and
    // the discarded target is no longer indexed.
    let probe = storage
        .recall(&recall_request("p1", "unrelated", "merged deploy runbook"))
        .unwrap();
    let pool_ids: Vec<&str> = probe.pool.iter().map(|item| item.id.as_str()).collect();
    assert!(pool_ids.contains(&"cand-new"));
    assert!(!pool_ids.contains(&"cand-old"));

    // Idempotent replay returns the stored outcome.
    let replay = storage.submit_adjudication(&submit, 12_200).unwrap();
    assert_eq!(replay["idempotent"], true);
    assert_eq!(replay["outcomes"], outcome["outcomes"]);

    // The review queue exposes the quarantined candidate.
    let review: threadshare_insights_engine::memory_protocol::ReviewQueueRequest =
        request(json!({ "repositoryKey": REPO, "worktreeKey": TREE }));
    let queue = storage.review_queue(&review).unwrap();
    assert_eq!(queue.items.len(), 1);
    assert_eq!(queue.items[0].candidate_id, "cand-new");
    assert_eq!(queue.items[0].payload["content"], "merged deploy runbook");
}

#[test]
fn adjudication_rejects_stale_result_set_digests_without_side_effects() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    let (token, digest) = setup_adjudication_fixture(&mut storage);

    // A third extraction squeezes a new candidate into the recall top-k.
    plan_chunk_and_task(&mut storage, "chunk-3", "task-3", "extraction", 1_000);
    let extra_token = claim(&mut storage, "task-3", "holder-a", 60_000, 12_050);
    submit_extraction_ok(
        &mut storage,
        "task-3",
        &extra_token,
        'c',
        &[(
            "cand-mid",
            "legacy deploy runbook variant",
            "legacy deploy runbook variant",
        )],
        12_060,
    );
    let fresh = storage
        .recall(&recall_request("d1", "cand-new", "legacy deploy runbook"))
        .unwrap();
    assert_ne!(fresh.result_set_digest, digest);

    let submit = adjudication_request(&token, &digest, "merge", 1);
    let outcome = storage.submit_adjudication(&submit, 12_100).unwrap();
    assert_eq!(outcome["status"], "stale");
    assert_eq!(outcome["reason"], "result-set-digest-mismatch");
    assert_eq!(outcome["actualResultSetDigest"], fresh.result_set_digest);

    let counts = status_counts(&storage);
    assert_eq!(counts["candidates"]["draft"], 3);
    assert_eq!(counts["candidates"]["quarantined"], 0);
    assert_eq!(counts["candidates"]["discarded"], 0);
    assert_eq!(counts["tasks"]["stale"], 1);
    assert_eq!(counts["chunks"]["extracted"], 0);
}

#[test]
fn adjudication_revision_cas_failure_rolls_back_completely() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    let (token, digest) = setup_adjudication_fixture(&mut storage);

    // Wrong adjudicator-side revision: the digest matches but the CAS fails.
    let submit = adjudication_request(&token, &digest, "merge", 7);
    let outcome = storage.submit_adjudication(&submit, 12_100).unwrap();
    assert_eq!(outcome["status"], "stale");
    assert_eq!(outcome["reason"], "revision-cas-failed");

    // No adjudication rows survived the rollback.
    let counts = status_counts(&storage);
    assert_eq!(counts["candidates"]["draft"], 2);
    assert_eq!(counts["candidates"]["quarantined"], 0);
    assert_eq!(counts["candidates"]["discarded"], 0);
    assert_eq!(counts["chunks"]["drafted"], 2);
    assert_eq!(counts["chunks"]["extracted"], 0);
    assert_eq!(counts["tasks"]["stale"], 1);

    // The recall pool still carries the original revision and digest.
    let after = storage
        .recall(&recall_request("d1", "cand-new", "legacy deploy runbook"))
        .unwrap();
    assert_eq!(after.result_set_digest, digest);

    // A stale task refuses further submissions and re-claims.
    let retry = adjudication_request(&token, &digest, "merge", 1);
    let error = storage.submit_adjudication(&retry, 12_200).unwrap_err();
    assert_eq!(error.code, "TS_MEMORY_LEASE_LOST");
    let reclaim: ClaimTaskRequest = request(json!({
        "taskId": "task-adj",
        "leaseHolder": "holder-b",
        "leaseMs": 1_000,
    }));
    assert_eq!(
        storage.claim_task(&reclaim, 99_999_999).unwrap_err().code,
        "TS_MEMORY_TASK_NOT_CLAIMABLE"
    );
}

#[test]
fn sync_approved_shortcircuits_rejects_partial_and_advances_generations() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();

    let first = storage
        .sync_approved(&sync_request(
            'a',
            "complete",
            &[("entry-1", "alpha guide")],
        ))
        .unwrap();
    assert_eq!(first.generation, 1);
    assert!(!first.unchanged);
    assert_eq!(first.entry_count, 1);

    // Same tree digest: idempotent short-circuit, no generation change.
    let replay = storage
        .sync_approved(&sync_request(
            'a',
            "complete",
            &[("entry-1", "alpha guide")],
        ))
        .unwrap();
    assert_eq!(replay.generation, 1);
    assert!(replay.unchanged);

    // Partial scans are recorded and rejected without a generation change.
    let error = storage
        .sync_approved(&sync_request('b', "partial", &[]))
        .unwrap_err();
    assert_eq!(error.code, "TS_MEMORY_SYNC_PARTIAL");
    let search: MemorySearchRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "query": "alpha guide",
    }));
    let partial_view = storage.search(&search).unwrap();
    assert_eq!(partial_view.generation, 1);
    assert_eq!(partial_view.coverage, "partial");
    assert_eq!(partial_view.items.len(), 1);

    // A complete scan replaces entries wholesale and advances the generation.
    let second = storage
        .sync_approved(&sync_request('c', "complete", &[("entry-2", "beta guide")]))
        .unwrap();
    assert_eq!(second.generation, 2);
    assert!(!second.unchanged);
    let alpha_only: MemorySearchRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "query": "alpha",
    }));
    let after = storage.search(&alpha_only).unwrap();
    assert_eq!(after.coverage, "complete");
    assert!(after.items.is_empty());
    let beta: MemorySearchRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "query": "beta guide",
    }));
    let hits = storage.search(&beta).unwrap();
    assert_eq!(hits.items.len(), 1);
    assert_eq!(hits.items[0].entry_id, "entry-2");
    assert_eq!(hits.items[0].rank, 1);
}

#[test]
fn bind_repository_upserts_and_never_echoes_the_realpath() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    let bind: BindRepositoryRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "publicRepositoryIdentity": "github.com/team-harness/threadshare",
        "rootRealpath": "/tmp/worktree-a",
        "rootRealpathDigest": hex64('e'),
        "commonDirDevice": "16777232",
        "commonDirInode": "42",
    }));
    bind.validate().unwrap();
    let outcome = storage.bind_repository(&bind).unwrap();
    assert_eq!(outcome.memory_root, ".threadshare/memory");
    assert_eq!(outcome.status, "active");
    let wire = serde_json::to_value(&outcome).unwrap();
    assert!(!wire.to_string().contains("/tmp/worktree-a"));

    let rebind: BindRepositoryRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "publicRepositoryIdentity": null,
        "rootRealpath": "/tmp/worktree-b",
        "rootRealpathDigest": hex64('f'),
        "commonDirDevice": "16777232",
        "commonDirInode": "43",
        "status": "inactive",
    }));
    rebind.validate().unwrap();
    let outcome = storage.bind_repository(&rebind).unwrap();
    assert_eq!(outcome.status, "inactive");
}
