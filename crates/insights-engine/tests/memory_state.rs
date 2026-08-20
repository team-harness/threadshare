use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use serde_json::{Value, json};
use threadshare_insights_engine::memory_protocol::{
    BindRepositoryRequest, ClaimTaskRequest, ConfirmStatementRequest, DiscardCandidateRequest,
    MemorySearchRequest, MemoryStatusRequest, PlanTasksRequest, PromotionApplyRequest,
    PromotionApproveRequest, PromotionPlanRequest, RecallRequest, SubmitAdjudicationRequest,
    SubmitExtractionRequest, SyncApprovedRequest,
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
    expected_generation: i64,
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
        "expectedGeneration": expected_generation,
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
            0,
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
            0,
            &[("entry-1", "alpha guide")],
        ))
        .unwrap();
    assert_eq!(first["status"], "synced");
    assert_eq!(first["generation"], 1);
    assert_eq!(first["unchanged"], false);
    assert_eq!(first["entryCount"], 1);

    // Same tree digest: idempotent short-circuit, no generation change.
    let replay = storage
        .sync_approved(&sync_request(
            'a',
            "complete",
            1,
            &[("entry-1", "alpha guide")],
        ))
        .unwrap();
    assert_eq!(replay["status"], "synced");
    assert_eq!(replay["generation"], 1);
    assert_eq!(replay["unchanged"], true);

    // Partial scans are recorded and rejected without a generation change.
    let error = storage
        .sync_approved(&sync_request('b', "partial", 1, &[]))
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
        .sync_approved(&sync_request(
            'c',
            "complete",
            1,
            &[("entry-2", "beta guide")],
        ))
        .unwrap();
    assert_eq!(second["generation"], 2);
    assert_eq!(second["unchanged"], false);
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
fn sync_approved_generation_cas_rejects_lost_updates() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();

    // Scanner A reads generation 0, then scanner B commits first.
    let newer = storage
        .sync_approved(&sync_request(
            'b',
            "complete",
            0,
            &[("entry-b", "beta guide")],
        ))
        .unwrap();
    assert_eq!(newer["generation"], 1);

    // A's older scan still carries expectedGeneration 0: structured conflict,
    // no state change, and the stored digest tells A what to rescan against.
    let stale_complete = sync_request('a', "complete", 0, &[("entry-a", "alpha guide")]);
    let conflict = storage.sync_approved(&stale_complete).unwrap();
    assert_eq!(conflict["status"], "conflict");
    assert_eq!(conflict["generation"], 1);
    assert_eq!(conflict["coverage"], "complete");
    assert_eq!(conflict["sourceTreeDigest"], hex64('b'));

    // B's newer projection is untouched by the rejected scan.
    let beta: MemorySearchRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "query": "beta guide",
    }));
    let view = storage.search(&beta).unwrap();
    assert_eq!(view.generation, 1);
    assert_eq!(view.coverage, "complete");
    assert_eq!(view.items.len(), 1);
    let alpha: MemorySearchRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "query": "alpha",
    }));
    assert!(storage.search(&alpha).unwrap().items.is_empty());

    // A stale partial scan cannot downgrade the newer complete projection.
    let stale_partial = sync_request('c', "partial", 0, &[]);
    let conflict = storage.sync_approved(&stale_partial).unwrap();
    assert_eq!(conflict["status"], "conflict");
    assert_eq!(conflict["generation"], 1);
    assert_eq!(storage.search(&beta).unwrap().coverage, "complete");

    // After rescanning at the current generation the sync applies.
    let fresh = storage
        .sync_approved(&sync_request(
            'a',
            "complete",
            1,
            &[("entry-a", "alpha guide")],
        ))
        .unwrap();
    assert_eq!(fresh["status"], "synced");
    assert_eq!(fresh["generation"], 2);
}

#[test]
fn adjudication_rejects_duplicate_targets_and_pool_revision_drift() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    let (token, digest) = setup_adjudication_fixture(&mut storage);

    // `[{T,1},{T,2}]` tries to ride the engine's own revision bump: the first
    // CAS moves the row to revision 2, so a current-row comparison would let
    // the second target pass even though the recall pool saw revision 1.
    let submit: SubmitAdjudicationRequest = request(json!({
        "taskId": "task-adj",
        "claimToken": token,
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
            "action": "merge",
            "targets": [
                { "id": "cand-old", "revision": 1 },
                { "id": "cand-old", "revision": 2 },
            ],
            "mergedPayload": { "content": "merged deploy runbook", "type": "work_method" },
            "mergedSearchableText": "merged deploy runbook",
        }],
    }));

    // The protocol layer rejects duplicate target ids outright.
    let error = submit.validate().unwrap_err();
    assert!(error.contains("targets[].id must be unique"), "{error}");

    // Defense in depth: even bypassing validation, the engine maps every
    // target revision against the recall pool, so the second target fails the
    // CAS and the whole submission rolls back.
    let outcome = storage.submit_adjudication(&submit, 12_100).unwrap();
    assert_eq!(outcome["status"], "stale");
    assert_eq!(outcome["reason"], "revision-cas-failed");

    let counts = status_counts(&storage);
    assert_eq!(counts["candidates"]["draft"], 2);
    assert_eq!(counts["candidates"]["quarantined"], 0);
    assert_eq!(counts["candidates"]["discarded"], 0);
    assert_eq!(counts["tasks"]["stale"], 1);

    // The pool still carries cand-old at revision 1.
    let after = storage
        .recall(&recall_request("d1", "cand-new", "legacy deploy runbook"))
        .unwrap();
    assert_eq!(after.result_set_digest, digest);
}

#[test]
fn stale_marking_never_touches_a_reclaimed_lease() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    // Holder A claims the adjudication task (lease 60s from now=12_000).
    let (token_a, digest) = setup_adjudication_fixture(&mut storage);

    // A's lease expires and holder B re-claims: fresh token, epoch 2.
    let token_b = claim(&mut storage, "task-adj", "holder-b", 60_000, 100_000);
    assert_ne!(token_b, token_a);

    // A now drives its stale path (mismatching digest) with the superseded
    // token. The lease-scoped gate rejects it, and crucially the stale
    // marking never fires against B's re-issued lease.
    let stale_attempt = adjudication_request(&token_a, &hex64('0'), "merge", 1);
    let error = storage
        .submit_adjudication(&stale_attempt, 100_100)
        .unwrap_err();
    assert_eq!(error.code, "TS_MEMORY_LEASE_LOST");

    let counts = status_counts(&storage);
    assert_eq!(counts["tasks"]["stale"], 0);
    assert_eq!(counts["tasks"]["claimed"], 1);

    // B's lease is fully intact: its own submission still applies.
    let submit = adjudication_request(&token_b, &digest, "merge", 1);
    let outcome = storage.submit_adjudication(&submit, 100_200).unwrap();
    assert_eq!(outcome["status"], "applied");
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

// ---------------------------------------------------------------------------
// Stage 4c: confirmation, discard, and the promotion state machine.
// ---------------------------------------------------------------------------

fn base64(bytes: &[u8]) -> String {
    const ALPHABET: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::new();
    for chunk in bytes.chunks(3) {
        let padded = [
            chunk[0],
            *chunk.get(1).unwrap_or(&0),
            *chunk.get(2).unwrap_or(&0),
        ];
        let word =
            (u32::from(padded[0]) << 16) | (u32::from(padded[1]) << 8) | u32::from(padded[2]);
        out.push(ALPHABET[(word >> 18) as usize & 63] as char);
        out.push(ALPHABET[(word >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            ALPHABET[(word >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            ALPHABET[word as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

fn bind_worktree(storage: &mut MemoryStorage, root: &std::path::Path) {
    let bind: BindRepositoryRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "publicRepositoryIdentity": null,
        "rootRealpath": root.to_str().unwrap(),
        "rootRealpathDigest": hex64('e'),
        "commonDirDevice": "1",
        "commonDirInode": "2",
    }));
    bind.validate().unwrap();
    storage.bind_repository(&bind).unwrap();
}

/// Runs a candidate through extraction and a `store` adjudication so it is
/// `quarantined` with one `s1` assessment (`statementTextDigest` hex64('8'),
/// `citationsDigest` hex64('7'), the given `claimSupport`).
fn quarantine_candidate(
    storage: &mut MemoryStorage,
    label: &str,
    candidate_id: &str,
    content: &str,
    claim_support: &str,
) {
    let chunk_ref = format!("chunk-{label}");
    let task_id = format!("task-{label}");
    plan_chunk_and_task(storage, &chunk_ref, &task_id, "extraction", 1_000);
    let token = claim(storage, &task_id, "holder-q", 60_000, 10_000);
    let submit: SubmitExtractionRequest = request(json!({
        "taskId": task_id,
        "claimToken": token,
        "responseDigest": hex64('a'),
        "drafts": [{
            "candidateId": candidate_id,
            "payload": {
                "content": content,
                "type": "work_method",
                "statements": [{ "statementId": "s1", "text": content, "evidenceIds": [] }],
            },
            "searchableText": content,
        }],
        "evidenceRefs": [],
        "assessments": [{
            "candidateId": candidate_id,
            "statementId": "s1",
            "citationsDigest": hex64('7'),
            "provenanceStrength": "direct",
            "limitations": [],
            "claimSupport": claim_support,
            "assessedBy": "deterministic",
            "statementTextDigest": hex64('8'),
            "revision": 1,
        }],
    }));
    submit.validate().unwrap();
    storage.submit_extraction(&submit, 10_100).unwrap();

    let adjudication_task = format!("task-{label}-adj");
    plan_chunk_and_task(storage, "", &adjudication_task, "adjudication", 1_000);
    let adjudication_token = claim(storage, &adjudication_task, "holder-q", 60_000, 11_000);
    let recall = recall_request("d1", candidate_id, content);
    let digest = storage.recall(&recall).unwrap().result_set_digest;
    let submit: SubmitAdjudicationRequest = request(json!({
        "taskId": adjudication_task,
        "claimToken": adjudication_token,
        "responseDigest": hex64('e'),
        "recall": {
            "repositoryKey": REPO,
            "worktreeKey": TREE,
            "drafts": [{ "draftRef": "d1", "candidateId": candidate_id, "queryText": content }],
        },
        "expectedResultSetDigest": digest,
        "adjudications": [{ "draftRef": "d1", "action": "store" }],
    }));
    submit.validate().unwrap();
    let outcome = storage.submit_adjudication(&submit, 11_100).unwrap();
    assert_eq!(outcome["status"], "applied");
}

fn confirm_request(
    candidate_id: &str,
    text_char: char,
    citations_char: char,
) -> ConfirmStatementRequest {
    let value: ConfirmStatementRequest = request(json!({
        "candidateId": candidate_id,
        "statementId": "s1",
        "statementTextDigest": hex64(text_char),
        "citationsDigest": hex64(citations_char),
    }));
    value.validate().unwrap();
    value
}

fn promotion_plan_request(candidate_ids: &[&str], per_file: Value) -> PromotionPlanRequest {
    let value: PromotionPlanRequest = request(json!({
        "owner": { "repositoryKey": REPO, "worktreeKey": TREE },
        "candidateIds": candidate_ids,
        "policyVersion": "sanitize@1",
        "perFile": per_file,
    }));
    value.validate().unwrap();
    value
}

fn approve_request(plan_id: &str, plan_digest: &str) -> PromotionApproveRequest {
    let value: PromotionApproveRequest = request(json!({
        "planId": plan_id,
        "planDigest": plan_digest,
    }));
    value.validate().unwrap();
    value
}

fn apply_request(plan_id: &str, root: &std::path::Path) -> PromotionApplyRequest {
    let value: PromotionApplyRequest = request(json!({
        "planId": plan_id,
        "ownerRootRealpath": root.to_str().unwrap(),
    }));
    value.validate().unwrap();
    value
}

#[test]
fn confirm_statement_rejects_digest_drift_and_confirms_matches() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    quarantine_candidate(
        &mut storage,
        "c1",
        "cand-1",
        "release checklist",
        "unverified",
    );

    let missing = confirm_request("cand-missing", '8', '7');
    assert_eq!(
        storage.confirm_statement(&missing).unwrap_err().code,
        "TS_MEMORY_ASSESSMENT_NOT_FOUND"
    );

    // Statement text drift: structured rejection, no state change.
    let drifted = storage
        .confirm_statement(&confirm_request("cand-1", '9', '7'))
        .unwrap();
    assert_eq!(drifted["status"], "drifted");
    assert_eq!(drifted["actualStatementTextDigest"], hex64('8'));
    assert_eq!(drifted["actualCitationsDigest"], hex64('7'));

    // Citations drift is caught too.
    let drifted = storage
        .confirm_statement(&confirm_request("cand-1", '8', '9'))
        .unwrap();
    assert_eq!(drifted["status"], "drifted");

    // The drifted attempts did not confirm anything: a plan is still refused.
    bind_worktree(&mut storage, std::path::Path::new("/tmp/worktree-confirm"));
    let plan = promotion_plan_request(
        &["cand-1"],
        json!([{
            "targetPath": ".threadshare/memory/entries/checklist.md",
            "sanitizedContent": base64(b"checklist\n"),
            "targetBlobHash": null,
        }]),
    );
    assert_eq!(
        storage.promotion_plan(&plan, 20_000).unwrap_err().code,
        "TS_MEMORY_UNVERIFIED_CLAIM"
    );

    // Matching digests confirm the statement and bump the assessment revision.
    let confirmed = storage
        .confirm_statement(&confirm_request("cand-1", '8', '7'))
        .unwrap();
    assert_eq!(confirmed["status"], "confirmed");
    assert_eq!(confirmed["claimSupport"], "human-confirmed");
    assert_eq!(confirmed["assessedBy"], "human");
    assert_eq!(confirmed["revision"], 2);
    assert!(storage.promotion_plan(&plan, 20_100).is_ok());
}

#[test]
fn discard_candidate_uses_revision_cas_and_leaves_the_recall_pool() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    quarantine_candidate(
        &mut storage,
        "d1",
        "cand-1",
        "rollback recipe",
        "unverified",
    );

    let missing: DiscardCandidateRequest = request(json!({
        "candidateId": "cand-x",
        "expectedRevision": 1,
    }));
    assert_eq!(
        storage
            .discard_candidate(&missing, 30_000)
            .unwrap_err()
            .code,
        "TS_MEMORY_CANDIDATE_NOT_FOUND"
    );

    // The store adjudication bumped the candidate to revision 2.
    let stale: DiscardCandidateRequest = request(json!({
        "candidateId": "cand-1",
        "expectedRevision": 1,
    }));
    assert_eq!(
        storage.discard_candidate(&stale, 30_000).unwrap_err().code,
        "TS_MEMORY_CANDIDATE_STALE"
    );

    let discard: DiscardCandidateRequest = request(json!({
        "candidateId": "cand-1",
        "expectedRevision": 2,
    }));
    discard.validate().unwrap();
    let outcome = storage.discard_candidate(&discard, 30_100).unwrap();
    assert_eq!(outcome["status"], "discarded");
    assert_eq!(outcome["revision"], 3);
    let counts = status_counts(&storage);
    assert_eq!(counts["candidates"]["discarded"], 1);
    assert_eq!(counts["candidates"]["quarantined"], 0);

    // Discarded candidates no longer recall.
    let probe = storage
        .recall(&recall_request("p1", "unrelated", "rollback recipe"))
        .unwrap();
    assert!(probe.pool.iter().all(|item| item.id != "cand-1"));

    // Discarding again is refused (already discarded).
    assert_eq!(
        storage
            .discard_candidate(
                &request(json!({ "candidateId": "cand-1", "expectedRevision": 3 })),
                30_200
            )
            .unwrap_err()
            .code,
        "TS_MEMORY_CANDIDATE_STALE"
    );
}

#[test]
fn promotion_plan_rejects_escaping_and_out_of_root_target_paths() {
    // Wire-level validation refuses non-normalized relative paths.
    for target_path in [
        "/absolute/entry.md",
        "../escape.md",
        ".threadshare/memory/../escape.md",
        ".threadshare//memory/entry.md",
        ".threadshare\\memory\\entry.md",
        ".threadshare/memory/./entry.md",
        "",
    ] {
        let value: PromotionPlanRequest = request(json!({
            "owner": { "repositoryKey": REPO, "worktreeKey": TREE },
            "candidateIds": ["cand-1"],
            "policyVersion": "sanitize@1",
            "perFile": [{
                "targetPath": target_path,
                "sanitizedContent": base64(b"x"),
                "targetBlobHash": null,
            }],
        }));
        assert!(value.validate().is_err(), "{target_path}");
    }

    // A normalized path outside the binding memoryRoot is refused by the op.
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    quarantine_candidate(&mut storage, "p1", "cand-1", "path rules", "typed-fact");
    bind_worktree(&mut storage, std::path::Path::new("/tmp/worktree-paths"));
    let plan = promotion_plan_request(
        &["cand-1"],
        json!([{
            "targetPath": "docs/outside.md",
            "sanitizedContent": base64(b"outside\n"),
            "targetBlobHash": null,
        }]),
    );
    assert_eq!(
        storage.promotion_plan(&plan, 20_000).unwrap_err().code,
        "TS_MEMORY_TARGET_PATH_INVALID"
    );
}

#[test]
fn promotion_full_chain_writes_files_and_retires_candidates() {
    let worktree = temp_state_dir("promotion-worktree");
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    bind_worktree(&mut storage, &worktree);
    quarantine_candidate(
        &mut storage,
        "f1",
        "cand-1",
        "release workflow notes",
        "typed-fact",
    );

    let content = b"# Release workflow\n\nRun npm run test:release before tagging.\n";
    let target_path = ".threadshare/memory/entries/release-workflow.md";
    let plan = promotion_plan_request(
        &["cand-1"],
        json!([{
            "targetPath": target_path,
            "sanitizedContent": base64(content),
            "targetBlobHash": null,
        }]),
    );
    let planned = storage.promotion_plan(&plan, 20_000).unwrap();
    assert_eq!(planned["status"], "generated");
    assert_eq!(planned["owner"]["memoryRoot"], ".threadshare/memory");
    assert_eq!(planned["files"][0]["bytes"], content.len());
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    let plan_digest = planned["planDigest"].as_str().unwrap().to_owned();

    // Approval binds the exact plan digest; a mismatch is refused.
    assert_eq!(
        storage
            .promotion_approve(&approve_request(&plan_id, &hex64('0')), 20_100)
            .unwrap_err()
            .code,
        "TS_MEMORY_PLAN_DIGEST_MISMATCH"
    );
    // Applying an unapproved plan is refused.
    assert_eq!(
        storage
            .promotion_apply(&apply_request(&plan_id, &worktree), 20_150)
            .unwrap_err()
            .code,
        "TS_MEMORY_PLAN_STATE_INVALID"
    );
    let approved = storage
        .promotion_approve(&approve_request(&plan_id, &plan_digest), 20_200)
        .unwrap();
    assert_eq!(approved["status"], "approved");
    assert_eq!(approved["idempotent"], false);
    let replay = storage
        .promotion_approve(&approve_request(&plan_id, &plan_digest), 20_250)
        .unwrap();
    assert_eq!(replay["idempotent"], true);

    // Owner re-resolution: a different realpath is refused.
    assert_eq!(
        storage
            .promotion_apply(
                &apply_request(&plan_id, std::path::Path::new("/tmp/other-worktree")),
                20_300
            )
            .unwrap_err()
            .code,
        "TS_MEMORY_OWNER_MISMATCH"
    );

    let applied = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_400)
        .unwrap();
    assert_eq!(applied["status"], "applied");
    assert_eq!(applied["idempotent"], false);
    assert_eq!(applied["appliedFiles"][0], target_path);
    assert_eq!(applied["candidates"][0]["candidateId"], "cand-1");
    assert_eq!(applied["candidates"][0]["status"], "promoted");
    assert_eq!(applied["candidates"][0]["revision"], 3);

    // The exact approved bytes landed in the worktree.
    assert_eq!(
        std::fs::read(worktree.join(target_path)).unwrap(),
        content.to_vec()
    );

    // The promoted candidate left the recall pool and the counters advanced.
    let probe = storage
        .recall(&recall_request("p1", "unrelated", "release workflow notes"))
        .unwrap();
    assert!(probe.pool.iter().all(|item| item.id != "cand-1"));
    let counts = status_counts(&storage);
    assert_eq!(counts["candidates"]["promoted"], 1);
    assert_eq!(counts["candidates"]["quarantined"], 0);
    assert_eq!(counts["promotions"]["applied"], 1);
    assert_eq!(counts["promotions"]["applyingPlanIds"], json!([]));

    // Re-applying an applied plan replays idempotently without rewrites.
    let replay = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_500)
        .unwrap();
    assert_eq!(replay["status"], "applied");
    assert_eq!(replay["idempotent"], true);
    assert_eq!(replay["candidates"][0]["status"], "promoted");
}

#[test]
fn promotion_apply_voids_the_plan_on_blob_drift() {
    let worktree = temp_state_dir("promotion-drift");
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    bind_worktree(&mut storage, &worktree);
    quarantine_candidate(&mut storage, "b1", "cand-1", "drifted entry", "typed-fact");

    let target_path = ".threadshare/memory/entries/drift.md";
    let plan = promotion_plan_request(
        &["cand-1"],
        json!([{
            "targetPath": target_path,
            "sanitizedContent": base64(b"planned bytes\n"),
            "targetBlobHash": null,
        }]),
    );
    let planned = storage.promotion_plan(&plan, 20_000).unwrap();
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    let plan_digest = planned["planDigest"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(&approve_request(&plan_id, &plan_digest), 20_100)
        .unwrap();

    // The plan expected the file to be absent, but it appeared after approval.
    std::fs::create_dir_all(worktree.join(".threadshare/memory/entries")).unwrap();
    std::fs::write(worktree.join(target_path), b"user wrote this first\n").unwrap();

    let outcome = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_200)
        .unwrap();
    assert_eq!(outcome["status"], "voided");
    assert_eq!(outcome["driftedPath"], target_path);
    // The user's bytes were not touched, the candidate stayed quarantined.
    assert_eq!(
        std::fs::read(worktree.join(target_path)).unwrap(),
        b"user wrote this first\n".to_vec()
    );
    let counts = status_counts(&storage);
    assert_eq!(counts["candidates"]["quarantined"], 1);
    assert_eq!(counts["promotions"]["voided"], 1);

    // A voided plan cannot be applied or approved again.
    assert_eq!(
        storage
            .promotion_apply(&apply_request(&plan_id, &worktree), 20_300)
            .unwrap_err()
            .code,
        "TS_MEMORY_PLAN_STATE_INVALID"
    );
    assert_eq!(
        storage
            .promotion_approve(&approve_request(&plan_id, &plan_digest), 20_400)
            .unwrap_err()
            .code,
        "TS_MEMORY_PLAN_STATE_INVALID"
    );
}

#[cfg(unix)]
#[test]
fn promotion_apply_fails_closed_on_symlinked_path_segments() {
    let worktree = temp_state_dir("promotion-symlink");
    let outside = temp_state_dir("promotion-symlink-outside");
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    bind_worktree(&mut storage, &worktree);
    quarantine_candidate(&mut storage, "s1", "cand-1", "symlink guard", "typed-fact");

    // `.threadshare/memory/linked` is a symlinked directory segment.
    std::fs::create_dir_all(worktree.join(".threadshare/memory")).unwrap();
    std::os::unix::fs::symlink(&outside, worktree.join(".threadshare/memory/linked")).unwrap();

    let target_path = ".threadshare/memory/linked/entry.md";
    let plan = promotion_plan_request(
        &["cand-1"],
        json!([{
            "targetPath": target_path,
            "sanitizedContent": base64(b"never written\n"),
            "targetBlobHash": null,
        }]),
    );
    let planned = storage.promotion_plan(&plan, 20_000).unwrap();
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    let plan_digest = planned["planDigest"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(&approve_request(&plan_id, &plan_digest), 20_100)
        .unwrap();

    let outcome = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_200)
        .unwrap();
    assert_eq!(outcome["status"], "voided");
    assert_eq!(outcome["driftedPath"], target_path);
    // Nothing escaped through the symlink.
    assert!(!outside.join("entry.md").exists());
    assert_eq!(status_counts(&storage)["promotions"]["voided"], 1);
}

#[test]
fn promotion_apply_resumes_idempotently_after_a_partial_crash() {
    let worktree = temp_state_dir("promotion-resume-worktree");
    let state_dir = temp_state_dir("promotion-resume-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    quarantine_candidate(&mut storage, "r1", "cand-1", "resume entry", "typed-fact");

    let first_content = b"first file bytes\n";
    let second_content = b"second file bytes\n";
    let plan = promotion_plan_request(
        &["cand-1"],
        json!([
            {
                "targetPath": ".threadshare/memory/entries/a-first.md",
                "sanitizedContent": base64(first_content),
                "targetBlobHash": null,
            },
            {
                "targetPath": ".threadshare/memory/entries/b-second.md",
                "sanitizedContent": base64(second_content),
                "targetBlobHash": null,
            },
        ]),
    );
    let planned = storage.promotion_plan(&plan, 20_000).unwrap();
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    let plan_digest = planned["planDigest"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(&approve_request(&plan_id, &plan_digest), 20_100)
        .unwrap();

    // Simulate a crash mid-apply: the first file was written and journaled
    // (`applied=1`), the plan was left in `applying`.
    std::fs::create_dir_all(worktree.join(".threadshare/memory/entries")).unwrap();
    std::fs::write(
        worktree.join(".threadshare/memory/entries/a-first.md"),
        first_content,
    )
    .unwrap();
    let tweak = rusqlite::Connection::open(storage.database_path().unwrap()).unwrap();
    tweak
        .execute(
            "UPDATE promotion_journal SET status='applying' WHERE plan_id=?1",
            rusqlite::params![&plan_id],
        )
        .unwrap();
    tweak
        .execute(
            "UPDATE promotion_files SET applied=1
             WHERE plan_id=?1 AND target_path='.threadshare/memory/entries/a-first.md'",
            rusqlite::params![&plan_id],
        )
        .unwrap();
    drop(tweak);

    // The status op reports the recovery candidate.
    let counts = status_counts(&storage);
    assert_eq!(counts["promotions"]["applying"], 1);
    assert_eq!(counts["promotions"]["applyingPlanIds"], json!([&plan_id]));

    // Re-apply resumes file-by-file and completes the closing transaction.
    let outcome = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_200)
        .unwrap();
    assert_eq!(outcome["status"], "applied");
    assert_eq!(outcome["idempotent"], false);
    assert_eq!(
        outcome["appliedFiles"],
        json!([
            ".threadshare/memory/entries/a-first.md",
            ".threadshare/memory/entries/b-second.md",
        ])
    );
    assert_eq!(
        std::fs::read(worktree.join(".threadshare/memory/entries/a-first.md")).unwrap(),
        first_content.to_vec()
    );
    assert_eq!(
        std::fs::read(worktree.join(".threadshare/memory/entries/b-second.md")).unwrap(),
        second_content.to_vec()
    );
    let counts = status_counts(&storage);
    assert_eq!(counts["candidates"]["promoted"], 1);
    assert_eq!(counts["promotions"]["applied"], 1);
    assert_eq!(counts["promotions"]["applying"], 0);
}

#[test]
fn authorize_appends_audit_rows() {
    let state_dir = temp_state_dir("authorize");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    let authorize: threadshare_insights_engine::memory_protocol::AuthorizeRequest =
        request(json!({
            "planDigest": hex64('a'),
            "taskId": "task-1",
            "runnerInputDigest": hex64('b'),
            "inputCoverageDigest": hex64('c'),
            "provider": "claude",
            "model": "claude-test-1",
            "endpoint": "api.anthropic.com",
            "bytes": 4096,
            "via": "interactive",
            "manifestDigest": null,
        }));
    authorize.validate().unwrap();
    let outcome = storage.authorize(&authorize, 42_000).unwrap();
    assert_eq!(outcome["planDigest"], hex64('a'));
    assert_eq!(outcome["taskId"], "task-1");
    assert_eq!(outcome["via"], "interactive");
    assert_eq!(outcome["decidedAt"], 42_000);

    let audit = rusqlite::Connection::open(storage.database_path().unwrap()).unwrap();
    let (bytes, via, decided_at): (i64, String, i64) = audit
        .query_row(
            "SELECT bytes, via, decided_at FROM authorization_log",
            [],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?)),
        )
        .unwrap();
    assert_eq!(
        (bytes, via.as_str(), decided_at),
        (4096, "interactive", 42_000)
    );
}
