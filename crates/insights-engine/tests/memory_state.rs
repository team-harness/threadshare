use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use fs2::FileExt;
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use threadshare_insights_engine::memory_promotion::git_blob_oid_hex;
use threadshare_insights_engine::memory_protocol::{
    BindRepositoryRequest, ClaimTaskRequest, ConfirmStatementRequest, ConsolidationBaselineRequest,
    DiscardCandidateRequest, ListMemoryFilesRequest, MemorySearchRequest, MemoryStatusRequest,
    PlanTasksRequest, PromotionApplyRequest, PromotionApproveRequest, PromotionPlanRequest,
    ReadMemoryFileRequest, RecallRequest, ReviewQueueRequest, SubmitAdjudicationRequest,
    SubmitConsolidationRequest, SubmitExtractionRequest, SyncApprovedRequest,
};
use threadshare_insights_engine::memory_state::{
    MEMORY_STATE_RELATIVE_PATH, MEMORY_STATE_SCHEMA_VERSION, MemoryStorage,
};
use threadshare_insights_engine::try_canonical_json;

static NEXT_TEMP_DIR: AtomicU64 = AtomicU64::new(0);

const REPO: &str = "1111111111111111111111111111111111111111111111111111111111111111";
const TREE: &str = "2222222222222222222222222222222222222222222222222222222222222222";
const RELEASE_SCENE: &str = "-----META-START-----\ncreated: 2026-08-01\nupdated: 2026-08-20\nsummary: \"release\"\nheat: 1\n-----META-END-----\n# Release\n\nOld guidance.\n";

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

fn canonical_digest(value: &Value) -> String {
    hex::encode(Sha256::digest(
        try_canonical_json(value).unwrap().as_bytes(),
    ))
}

fn promotion_staging_artifact(
    parent: &std::path::Path,
    plan_id: &str,
    target_path: &str,
    direction: &str,
    suffix: &str,
) -> PathBuf {
    let mut token = Sha256::new();
    token.update(plan_id.as_bytes());
    token.update([0]);
    token.update(target_path.as_bytes());
    token.update([0]);
    token.update(direction.as_bytes());
    parent.join(format!(
        ".threadshare-promotion-{}.{}",
        hex::encode(token.finalize()),
        suffix
    ))
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
    sync_request_with_digest(&hex64(digest_char), coverage, expected_generation, entries)
}

fn sync_request_with_digest(
    source_tree_digest: &str,
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
        "sourceTreeDigest": source_tree_digest,
        "coverage": coverage,
        "expectedGeneration": expected_generation,
        "entries": entry_values,
    }));
    value.validate().unwrap();
    value
}

fn consolidation_binding(storage: &MemoryStorage, source_tree_digest: &str) -> Value {
    consolidation_binding_for(
        storage,
        1,
        source_tree_digest,
        &[("entry-1", 1, hex64('9'))],
    )
}

fn consolidation_binding_for(
    storage: &MemoryStorage,
    generation: i64,
    source_tree_digest: &str,
    entries: &[(&str, i64, String)],
) -> Value {
    let baseline: ConsolidationBaselineRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
    }));
    let after_successful_run_id =
        storage.consolidation_baseline(&baseline).unwrap()["successfulRunId"].clone();
    let entry_revisions = Value::Array(
        entries
            .iter()
            .map(|(entry_id, revision, content_digest)| {
                json!({
                    "entryId": entry_id,
                    "revision": revision,
                    "contentDigest": content_digest,
                })
            })
            .collect(),
    );
    let scene_revisions = json!([{
        "name": "release",
        "contentDigest": hex::encode(Sha256::digest(RELEASE_SCENE.as_bytes())),
        "heat": 1,
    }]);
    json!({
        "databaseUuid": "database-1",
        "memoryStateUuid": storage.memory_state_uuid().unwrap(),
        "owner": { "repositoryKey": REPO, "worktreeKey": TREE },
        "approvedProjection": {
            "generation": generation,
            "analyzerVersion": "memory-approved@1",
            "coverage": "complete",
            "sourceTreeDigest": source_tree_digest,
        },
        "entrySetDigest": canonical_digest(&entry_revisions),
        "entryRevisions": entry_revisions,
        "sceneIndexDigest": canonical_digest(&scene_revisions),
        "sceneRevisions": scene_revisions,
        "doctrineDigest": null,
        "replay": {
            "mode": "incremental",
            "afterSuccessfulRunId": after_successful_run_id,
        },
        "promptVersion": "memory-prompts@1",
        "schemaVersion": "threadshare-memory-consolidation-task@v1",
        "policyVersion": "consolidation-policy@1",
    })
}

fn prepare_consolidation_worktree(storage: &mut MemoryStorage, label: &str) -> PathBuf {
    let worktree = temp_state_dir(label);
    std::fs::create_dir_all(worktree.join(".threadshare/memory/scenes")).unwrap();
    std::fs::write(
        worktree.join(".threadshare/memory/scenes/release.md"),
        RELEASE_SCENE,
    )
    .unwrap();
    bind_worktree(storage, &worktree);
    worktree
}

fn write_approved_entry_tree(worktree: &std::path::Path, entries: &[(&str, &str)]) -> String {
    let entries_dir = worktree.join(".threadshare/memory/entries");
    std::fs::create_dir_all(&entries_dir).unwrap();
    for entry in std::fs::read_dir(&entries_dir).unwrap() {
        let path = entry.unwrap().path();
        if path.extension().and_then(|value| value.to_str()) == Some("md") {
            std::fs::remove_file(path).unwrap();
        }
    }
    let mut digests = entries
        .iter()
        .map(|(entry_id, content)| {
            let name = format!("{entry_id}.md");
            std::fs::write(entries_dir.join(&name), content).unwrap();
            json!({
                "path": format!(".threadshare/memory/entries/{name}"),
                "contentDigest": hex::encode(Sha256::digest(content.as_bytes())),
            })
        })
        .collect::<Vec<_>>();
    digests.sort_by(|left, right| {
        left["path"]
            .as_str()
            .unwrap()
            .cmp(right["path"].as_str().unwrap())
    });
    canonical_digest(&json!({
        "format": "threadshare-memory-source-tree@v1",
        "entries": digests,
    }))
}

fn materialized_update(heat: i64) -> Value {
    json!({
        "operationId": "op-release",
        "op": "update",
        "target": "scene",
        "name": "release",
        "newContent": format!(
            "-----META-START-----\ncreated: 2026-08-01\nupdated: 2026-08-21\nsummary: \"release\"\nheat: {heat}\n-----META-END-----\n# Release\n\nRun verification.\n"
        ),
        "basedOnEntryIds": ["entry-1"],
        "mergeSources": [],
        "rationale": "Fold the approved release guidance into the existing scene.",
    })
}

fn consolidation_submit(
    task_id: &str,
    claim_token: &str,
    run_id: &str,
    operation: Option<Value>,
) -> SubmitConsolidationRequest {
    let (candidate_id, operations, assessments) = match operation {
        Some(operation) => {
            let statement_digest = canonical_digest(&operation);
            let citations_digest = canonical_digest(&json!([{
                "entryId": "entry-1",
                "revision": 1,
                "contentDigest": hex64('9'),
            }]));
            (
                Value::String(format!("candidate-{run_id}")),
                json!([operation]),
                json!([{
                    "candidateId": format!("candidate-{run_id}"),
                    "statementId": "op-release",
                    "citationsDigest": citations_digest,
                    "provenanceStrength": "contextual",
                    "limitations": [
                        "generated-consolidation-content",
                        "source-approved-memory-only",
                    ],
                    "claimSupport": "unverified",
                    "assessedBy": "deterministic",
                    "statementTextDigest": statement_digest,
                    "revision": 1,
                }]),
            )
        }
        None => (Value::Null, json!([]), json!([])),
    };
    let value: SubmitConsolidationRequest = request(json!({
        "taskId": task_id,
        "claimToken": claim_token,
        "responseDigest": canonical_digest(&json!({ "run": run_id })),
        "runId": run_id,
        "candidateId": candidate_id,
        "operations": operations,
        "assessments": assessments,
    }));
    value.validate().unwrap();
    value
}

fn submit_consolidation_task(
    storage: &mut MemoryStorage,
    task_id: &str,
    run_id: &str,
    binding: Value,
    operation: Option<Value>,
    now_unix_ms: i64,
) -> (SubmitConsolidationRequest, Value) {
    let plan: PlanTasksRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "chunks": [],
        "tasks": [{
            "taskId": task_id,
            "kind": "consolidation",
            "binding": binding,
        }],
    }));
    storage.plan_tasks(&plan, now_unix_ms).unwrap();
    let token = claim(
        storage,
        task_id,
        "holder-consolidation",
        60_000,
        now_unix_ms + 1,
    );
    let submit = consolidation_submit(task_id, &token, run_id, operation);
    let outcome = storage
        .submit_consolidation(&submit, now_unix_ms + 2)
        .unwrap();
    (submit, outcome)
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

fn create_v1_database(path: &std::path::Path, include_required_tables: bool) {
    std::fs::create_dir_all(path.parent().unwrap()).unwrap();
    let connection = Connection::open(path).unwrap();
    connection
        .execute_batch(
            "CREATE TABLE memory_state_meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);
             INSERT INTO memory_state_meta(key,value) VALUES
               ('schema_version','1'),
               ('memoryStateUuid','00000000-0000-4000-8000-000000000001');
             CREATE TABLE promotion_files (
               plan_id TEXT NOT NULL, target_path TEXT NOT NULL,
               target_blob_hash TEXT, sanitized_content BLOB NOT NULL,
               sanitized_digest BLOB NOT NULL, applied INTEGER NOT NULL DEFAULT 0,
               PRIMARY KEY (plan_id,target_path)
             );",
        )
        .unwrap();
    if include_required_tables {
        connection
            .execute_batch(
                "CREATE TABLE candidates (
                   candidate_id TEXT PRIMARY KEY,
                   repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
                   chunk_ref TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
                   content_digest BLOB NOT NULL, payload_json TEXT NOT NULL,
                   status TEXT NOT NULL DEFAULT 'draft',
                   adjudication TEXT NOT NULL DEFAULT 'pending', updated_at INTEGER NOT NULL
                 );
                 CREATE TABLE promotion_journal (
                   plan_id TEXT PRIMARY KEY, repository_key BLOB NOT NULL,
                   worktree_key BLOB NOT NULL, plan_canonical_json TEXT NOT NULL,
                   plan_digest BLOB NOT NULL, candidate_ids_json TEXT NOT NULL,
                   assessment_digest BLOB NOT NULL, policy_version TEXT NOT NULL,
                   status TEXT NOT NULL DEFAULT 'generated', updated_at INTEGER NOT NULL
                 );
                 INSERT INTO candidates(
                   candidate_id,repository_key,worktree_key,chunk_ref,revision,
                   content_digest,payload_json,status,adjudication,updated_at
                 ) VALUES (
                   'candidate-v1',zeroblob(32),zeroblob(32),'chunk-v1',1,
                   zeroblob(32),'{}','quarantined','store',1
                 );
                 INSERT INTO promotion_journal(
                   plan_id,repository_key,worktree_key,plan_canonical_json,plan_digest,
                   candidate_ids_json,assessment_digest,policy_version,status,updated_at
                 ) VALUES
                   ('plan-pending',zeroblob(32),zeroblob(32),'{}',zeroblob(32),'[]',
                    zeroblob(32),'policy@1','applying',1),
                   ('plan-applied',zeroblob(32),zeroblob(32),'{}',zeroblob(32),'[]',
                    zeroblob(32),'policy@1','applied',2);",
            )
            .unwrap();
    }
    connection
        .execute(
            "INSERT INTO promotion_files(
               plan_id,target_path,target_blob_hash,sanitized_content,sanitized_digest,applied
             ) VALUES ('plan-pending','.threadshare/memory/scenes/a.md',?1,?2,?3,0)",
            params!["a".repeat(40), b"new-a".as_slice(), vec![0xa1_u8; 32]],
        )
        .unwrap();
    connection
        .execute(
            "INSERT INTO promotion_files(
               plan_id,target_path,target_blob_hash,sanitized_content,sanitized_digest,applied
             ) VALUES ('plan-applied','.threadshare/memory/scenes/b.md',?1,?2,?3,1)",
            params!["b".repeat(40), b"new-b".as_slice(), vec![0xb1_u8; 32]],
        )
        .unwrap();
}

#[test]
fn migrates_v1_partial_promotions_as_legacy_write_only_without_losing_progress() {
    let state_dir = temp_state_dir("migrate-v1-partial");
    let database_path = state_dir.join(MEMORY_STATE_RELATIVE_PATH);
    create_v1_database(&database_path, true);

    let storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    assert_eq!(
        storage.schema_version().unwrap(),
        MEMORY_STATE_SCHEMA_VERSION
    );
    drop(storage);

    let connection = Connection::open(&database_path).unwrap();
    let files = connection
        .prepare(
            "SELECT target_path,operation,intent_state,originally_present,
                    rollback_content,legacy_write_only,applied,sanitized_content
             FROM promotion_files ORDER BY target_path",
        )
        .unwrap()
        .query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, Option<i64>>(3)?,
                row.get::<_, Option<Vec<u8>>>(4)?,
                row.get::<_, i64>(5)?,
                row.get::<_, i64>(6)?,
                row.get::<_, Vec<u8>>(7)?,
            ))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(files.len(), 2);
    assert_eq!(files[0].0, ".threadshare/memory/scenes/a.md");
    assert_eq!(
        (&files[0].1, &files[0].2),
        (&"write".to_owned(), &"pending".to_owned())
    );
    assert_eq!(files[0].3, None);
    assert_eq!(files[0].4, None);
    assert_eq!((files[0].5, files[0].6), (1, 0));
    assert_eq!(files[0].7, b"new-a");
    assert_eq!(
        (&files[1].1, &files[1].2),
        (&"write".to_owned(), &"applied".to_owned())
    );
    assert_eq!((files[1].5, files[1].6), (1, 1));
    let phases = connection
        .prepare("SELECT plan_id,mutation_phase FROM promotion_journal ORDER BY plan_id")
        .unwrap()
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?))
        })
        .unwrap()
        .collect::<Result<Vec<_>, _>>()
        .unwrap();
    assert_eq!(
        phases,
        vec![
            ("plan-applied".to_owned(), "done".to_owned()),
            ("plan-pending".to_owned(), "mutating".to_owned())
        ]
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT candidate_kind FROM candidates WHERE candidate_id='candidate-v1'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "entry"
    );
}

#[test]
fn legacy_write_only_recovery_artifacts_keep_the_plan_nonterminal() {
    let state_dir = temp_state_dir("migrate-v1-recovery-artifact");
    let worktree = temp_state_dir("migrate-v1-recovery-worktree");
    let database_path = state_dir.join(MEMORY_STATE_RELATIVE_PATH);
    create_v1_database(&database_path, true);
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);

    let target_path = ".threadshare/memory/scenes/a.md";
    let target = worktree.join(target_path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, b"legacy old").unwrap();
    let connection = Connection::open(&database_path).unwrap();
    connection
        .execute(
            "UPDATE promotion_journal SET repository_key=?1, worktree_key=?2
             WHERE plan_id='plan-pending'",
            params![vec![0x11_u8; 32], vec![0x22_u8; 32]],
        )
        .unwrap();
    connection
        .execute(
            "UPDATE promotion_files SET target_blob_hash=?1
             WHERE plan_id='plan-pending' AND target_path=?2",
            params![git_blob_oid_hex(b"legacy old"), target_path],
        )
        .unwrap();
    drop(connection);

    let mut token = Sha256::new();
    token.update(b"plan-pending");
    token.update([0]);
    token.update(target_path.as_bytes());
    token.update([0]);
    token.update(b"forward");
    let hold = target.parent().unwrap().join(format!(
        ".threadshare-promotion-{}.hold",
        hex::encode(token.finalize())
    ));
    std::fs::write(&hold, b"legacy old").unwrap();

    let error = storage
        .promotion_apply(&apply_request("plan-pending", &worktree), 20_000)
        .unwrap_err();
    assert_eq!(error.code, "TS_MEMORY_ROLLBACK_REQUIRED");
    assert_eq!(std::fs::read(&target).unwrap(), b"legacy old");
    assert_eq!(std::fs::read(&hold).unwrap(), b"legacy old");
    let connection = Connection::open(&database_path).unwrap();
    let state: (String, String) = connection
        .query_row(
            "SELECT status, mutation_phase FROM promotion_journal
             WHERE plan_id='plan-pending'",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .unwrap();
    assert_eq!(state, ("applying".to_owned(), "mutating".to_owned()));
}

#[test]
fn failed_v1_migration_rolls_back_to_a_complete_v1_database() {
    let state_dir = temp_state_dir("migrate-v1-rollback");
    let database_path = state_dir.join(MEMORY_STATE_RELATIVE_PATH);
    create_v1_database(&database_path, false);
    assert!(MemoryStorage::open_state_dir(&state_dir).is_err());

    let connection = Connection::open(&database_path).unwrap();
    assert_eq!(
        connection
            .query_row(
                "SELECT value FROM memory_state_meta WHERE key='schema_version'",
                [],
                |row| row.get::<_, String>(0),
            )
            .unwrap(),
        "1"
    );
    assert_eq!(
        connection
            .query_row("SELECT COUNT(*) FROM promotion_files", [], |row| row
                .get::<_, i64>(0))
            .unwrap(),
        2
    );
    assert_eq!(
        connection
            .query_row(
                "SELECT COUNT(*) FROM sqlite_master WHERE type='table' AND name='promotion_files_v1'",
                [],
                |row| row.get::<_, i64>(0),
            )
            .unwrap(),
        0
    );
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
fn consolidation_submit_is_transactional_kind_filtered_and_digest_bound() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    let worktree = prepare_consolidation_worktree(&mut storage, "consolidation-submit");
    let source_tree_digest = write_approved_entry_tree(
        &worktree,
        &[("entry-1", "Run verification before publishing.")],
    );
    storage
        .sync_approved(&sync_request_with_digest(
            &source_tree_digest,
            "complete",
            0,
            &[("entry-1", "Run verification before publishing.")],
        ))
        .unwrap();
    let binding = consolidation_binding(&storage, &source_tree_digest);
    let plan: PlanTasksRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "chunks": [],
        "tasks": [{
            "taskId": "task-consolidate-1",
            "kind": "consolidation",
            "chunkRef": null,
            "draftBatchRef": null,
            "binding": binding,
            "authorizationPlanDigest": null,
        }],
    }));
    storage.plan_tasks(&plan, 1_000).unwrap();
    let token = claim(
        &mut storage,
        "task-consolidate-1",
        "holder-c",
        60_000,
        10_000,
    );
    let submit = consolidation_submit(
        "task-consolidate-1",
        &token,
        "run-1",
        Some(materialized_update(2)),
    );
    let outcome = storage.submit_consolidation(&submit, 10_100).unwrap();
    assert_eq!(outcome["status"], "pending_review");
    assert_eq!(outcome["candidate"]["status"], "quarantined");
    assert_eq!(outcome["entryCount"], 1);
    assert_eq!(outcome["idempotent"], false);
    assert_eq!(
        storage.submit_consolidation(&submit, 10_200).unwrap()["idempotent"],
        true
    );

    let entry_queue: ReviewQueueRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "kind": "entry",
    }));
    assert!(storage.review_queue(&entry_queue).unwrap().items.is_empty());
    let consolidation_queue: ReviewQueueRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "kind": "consolidation",
    }));
    let queue = storage.review_queue(&consolidation_queue).unwrap();
    assert_eq!(queue.items.len(), 1);
    assert_eq!(queue.items[0].candidate_kind, "consolidation-patch");
    assert_eq!(queue.items[0].assessments.len(), 1);
    assert_eq!(
        queue.items[0].payload["statements"]
            .as_array()
            .unwrap()
            .len(),
        1
    );

    let baseline: ConsolidationBaselineRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
    }));
    let baseline = storage.consolidation_baseline(&baseline).unwrap();
    assert_eq!(baseline["successfulRunId"], Value::Null);
    assert_eq!(baseline["pendingRunId"], "run-1");
}

#[test]
fn consolidation_submit_rejects_host_heat_forgery_and_projection_drift() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    let worktree = prepare_consolidation_worktree(&mut storage, "consolidation-drift");
    let source_tree_digest = write_approved_entry_tree(
        &worktree,
        &[("entry-1", "Run verification before publishing.")],
    );
    storage
        .sync_approved(&sync_request_with_digest(
            &source_tree_digest,
            "complete",
            0,
            &[("entry-1", "Run verification before publishing.")],
        ))
        .unwrap();
    let binding = consolidation_binding(&storage, &source_tree_digest);
    for (task_id, binding) in [("task-bad-heat", binding.clone()), ("task-drift", binding)] {
        let plan: PlanTasksRequest = request(json!({
            "repositoryKey": REPO,
            "worktreeKey": TREE,
            "chunks": [],
            "tasks": [{
                "taskId": task_id,
                "kind": "consolidation",
                "binding": binding,
            }],
        }));
        storage.plan_tasks(&plan, 1_000).unwrap();
    }
    let token = claim(&mut storage, "task-bad-heat", "holder-c", 60_000, 10_000);
    let forged = consolidation_submit(
        "task-bad-heat",
        &token,
        "run-bad-heat",
        Some(materialized_update(999)),
    );
    assert_eq!(
        storage
            .submit_consolidation(&forged, 10_100)
            .unwrap_err()
            .code,
        "TS_MEMORY_CONSOLIDATION_INVALID"
    );

    let changed_source_tree_digest =
        write_approved_entry_tree(&worktree, &[("entry-1", "Changed approved content.")]);
    storage
        .sync_approved(&sync_request_with_digest(
            &changed_source_tree_digest,
            "complete",
            1,
            &[("entry-1", "Changed approved content.")],
        ))
        .unwrap();
    let token = claim(&mut storage, "task-drift", "holder-c", 60_000, 11_000);
    let stale = consolidation_submit(
        "task-drift",
        &token,
        "run-drift",
        Some(materialized_update(2)),
    );
    assert_eq!(
        storage
            .submit_consolidation(&stale, 11_100)
            .unwrap_err()
            .code,
        "TS_MEMORY_BINDING_DRIFT"
    );
}

#[test]
fn consolidation_submit_rejects_changed_or_unexpected_scene_files() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    let worktree = prepare_consolidation_worktree(&mut storage, "consolidation-source-drift");
    let source_tree_digest = write_approved_entry_tree(
        &worktree,
        &[("entry-1", "Run verification before publishing.")],
    );
    storage
        .sync_approved(&sync_request_with_digest(
            &source_tree_digest,
            "complete",
            0,
            &[("entry-1", "Run verification before publishing.")],
        ))
        .unwrap();
    let plan: PlanTasksRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "chunks": [],
        "tasks": [{
            "taskId": "task-source-drift",
            "kind": "consolidation",
            "binding": consolidation_binding(&storage, &source_tree_digest),
        }],
    }));
    storage.plan_tasks(&plan, 1_000).unwrap();
    let token = claim(
        &mut storage,
        "task-source-drift",
        "holder-c",
        60_000,
        10_000,
    );
    let submit = consolidation_submit(
        "task-source-drift",
        &token,
        "run-source-drift",
        Some(materialized_update(2)),
    );

    let release = worktree.join(".threadshare/memory/scenes/release.md");
    std::fs::write(
        &release,
        RELEASE_SCENE.replace("Old guidance.", "Changed guidance."),
    )
    .unwrap();
    assert_eq!(
        storage
            .submit_consolidation(&submit, 10_100)
            .unwrap_err()
            .code,
        "TS_MEMORY_BINDING_DRIFT"
    );

    std::fs::write(&release, RELEASE_SCENE).unwrap();
    std::fs::write(
        worktree.join(".threadshare/memory/scenes/unexpected.md"),
        RELEASE_SCENE,
    )
    .unwrap();
    assert_eq!(
        storage
            .submit_consolidation(&submit, 10_200)
            .unwrap_err()
            .code,
        "TS_MEMORY_BINDING_DRIFT"
    );
}

#[test]
fn empty_consolidation_patch_advances_a_visible_replayable_baseline() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    let worktree = prepare_consolidation_worktree(&mut storage, "consolidation-no-op");
    let source_tree_digest = write_approved_entry_tree(
        &worktree,
        &[("entry-1", "Run verification before publishing.")],
    );
    storage
        .sync_approved(&sync_request_with_digest(
            &source_tree_digest,
            "complete",
            0,
            &[("entry-1", "Run verification before publishing.")],
        ))
        .unwrap();
    let binding = consolidation_binding(&storage, &source_tree_digest);
    let plan: PlanTasksRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "chunks": [],
        "tasks": [{
            "taskId": "task-no-op",
            "kind": "consolidation",
            "binding": binding,
        }],
    }));
    storage.plan_tasks(&plan, 1_000).unwrap();
    let token = claim(&mut storage, "task-no-op", "holder-c", 60_000, 10_000);
    let submit = consolidation_submit("task-no-op", &token, "run-no-op", None);
    let outcome = storage.submit_consolidation(&submit, 10_100).unwrap();
    assert_eq!(outcome["status"], "no_op");
    assert_eq!(outcome["candidate"], Value::Null);
    assert_eq!(outcome["entryCount"], 1);

    let baseline: ConsolidationBaselineRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
    }));
    let baseline = storage.consolidation_baseline(&baseline).unwrap();
    assert_eq!(baseline["successfulRunId"], "run-no-op");
    assert_eq!(baseline["lastSuccessfulNoOp"], true);
    assert_eq!(baseline["entries"].as_array().unwrap().len(), 1);
    assert_eq!(baseline["entries"][0]["entryId"], "entry-1");
}

#[test]
fn incremental_consolidation_baseline_retains_entries_from_every_successful_run() {
    let mut storage = MemoryStorage::open_in_memory().unwrap();
    let worktree = prepare_consolidation_worktree(&mut storage, "consolidation-baseline");
    let first_source_tree_digest =
        write_approved_entry_tree(&worktree, &[("entry-1", "First approved entry.")]);
    storage
        .sync_approved(&sync_request_with_digest(
            &first_source_tree_digest,
            "complete",
            0,
            &[("entry-1", "First approved entry.")],
        ))
        .unwrap();
    let first_plan: PlanTasksRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "chunks": [],
        "tasks": [{
            "taskId": "task-baseline-first",
            "kind": "consolidation",
            "binding": consolidation_binding(&storage, &first_source_tree_digest),
        }],
    }));
    storage.plan_tasks(&first_plan, 1_000).unwrap();
    let first_token = claim(
        &mut storage,
        "task-baseline-first",
        "holder-c",
        60_000,
        10_000,
    );
    storage
        .submit_consolidation(
            &consolidation_submit(
                "task-baseline-first",
                &first_token,
                "run-baseline-first",
                None,
            ),
            10_100,
        )
        .unwrap();

    let second_source_tree_digest =
        write_approved_entry_tree(&worktree, &[("entry-2", "Second approved entry.")]);
    storage
        .sync_approved(&sync_request_with_digest(
            &second_source_tree_digest,
            "complete",
            1,
            &[("entry-2", "Second approved entry.")],
        ))
        .unwrap();
    let second_binding = consolidation_binding_for(
        &storage,
        2,
        &second_source_tree_digest,
        &[("entry-2", 1, hex64('9'))],
    );
    let second_plan: PlanTasksRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "chunks": [],
        "tasks": [{
            "taskId": "task-baseline-second",
            "kind": "consolidation",
            "binding": second_binding,
        }],
    }));
    storage.plan_tasks(&second_plan, 11_000).unwrap();
    let second_token = claim(
        &mut storage,
        "task-baseline-second",
        "holder-c",
        60_000,
        20_000,
    );
    storage
        .submit_consolidation(
            &consolidation_submit(
                "task-baseline-second",
                &second_token,
                "run-baseline-second",
                None,
            ),
            20_100,
        )
        .unwrap();

    let baseline: ConsolidationBaselineRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
    }));
    let baseline = storage.consolidation_baseline(&baseline).unwrap();
    assert_eq!(baseline["successfulRunId"], "run-baseline-second");
    assert_eq!(
        baseline["entries"]
            .as_array()
            .unwrap()
            .iter()
            .map(|entry| entry["entryId"].as_str().unwrap())
            .collect::<Vec<_>>(),
        vec!["entry-1", "entry-2"]
    );
}

#[test]
fn consolidation_replay_epoch_is_revalidated_before_plan_and_apply() {
    let worktree = temp_state_dir("consolidation-replay-epoch-worktree");
    let state_dir = temp_state_dir("consolidation-replay-epoch-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    let source_tree_digest = write_approved_entry_tree(
        &worktree,
        &[("entry-1", "Run verification before publishing.")],
    );
    storage
        .sync_approved(&sync_request_with_digest(
            &source_tree_digest,
            "complete",
            0,
            &[("entry-1", "Run verification before publishing.")],
        ))
        .unwrap();
    std::fs::create_dir_all(worktree.join(".threadshare/memory/scenes")).unwrap();
    std::fs::write(
        worktree.join(".threadshare/memory/scenes/release.md"),
        RELEASE_SCENE,
    )
    .unwrap();

    let first_binding = consolidation_binding(&storage, &source_tree_digest);
    let (first_submit, first_outcome) = submit_consolidation_task(
        &mut storage,
        "task-replay-plan",
        "run-replay-plan",
        first_binding,
        Some(materialized_update(2)),
        10_000,
    );
    let first_candidate = first_outcome["candidate"]["candidateId"]
        .as_str()
        .unwrap()
        .to_owned();
    let first_assessment = &first_submit.assessments[0];
    let first_confirmation: ConfirmStatementRequest = request(json!({
        "candidateId": first_candidate,
        "statementId": first_assessment.statement_id,
        "statementTextDigest": first_assessment.statement_text_digest,
        "citationsDigest": first_assessment.citations_digest,
    }));
    storage.confirm_statement(&first_confirmation).unwrap();
    let first_content = first_submit.operations[0]
        .new_content
        .as_ref()
        .unwrap()
        .as_bytes();
    let first_promotion = promotion_plan_request(
        &[&first_candidate],
        json!([{
            "targetPath": ".threadshare/memory/scenes/release.md",
            "operation": "write",
            "sanitizedContent": base64(first_content),
            "targetBlobHash": git_blob_oid_hex(RELEASE_SCENE.as_bytes()),
        }]),
    );

    let no_op_binding = consolidation_binding(&storage, &source_tree_digest);
    submit_consolidation_task(
        &mut storage,
        "task-replay-baseline-1",
        "run-replay-baseline-1",
        no_op_binding,
        None,
        11_000,
    );
    assert_eq!(
        storage
            .promotion_plan(&first_promotion, 12_000)
            .unwrap_err()
            .code,
        "TS_MEMORY_BINDING_DRIFT"
    );

    let second_binding = consolidation_binding(&storage, &source_tree_digest);
    let (second_submit, second_outcome) = submit_consolidation_task(
        &mut storage,
        "task-replay-apply",
        "run-replay-apply",
        second_binding,
        Some(materialized_update(2)),
        13_000,
    );
    let second_candidate = second_outcome["candidate"]["candidateId"]
        .as_str()
        .unwrap()
        .to_owned();
    let second_assessment = &second_submit.assessments[0];
    let second_confirmation: ConfirmStatementRequest = request(json!({
        "candidateId": second_candidate,
        "statementId": second_assessment.statement_id,
        "statementTextDigest": second_assessment.statement_text_digest,
        "citationsDigest": second_assessment.citations_digest,
    }));
    storage.confirm_statement(&second_confirmation).unwrap();
    let second_content = second_submit.operations[0]
        .new_content
        .as_ref()
        .unwrap()
        .as_bytes();
    let second_promotion = promotion_plan_request(
        &[&second_candidate],
        json!([{
            "targetPath": ".threadshare/memory/scenes/release.md",
            "operation": "write",
            "sanitizedContent": base64(second_content),
            "targetBlobHash": git_blob_oid_hex(RELEASE_SCENE.as_bytes()),
        }]),
    );
    let planned = storage.promotion_plan(&second_promotion, 14_000).unwrap();
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(
            &approve_request(&plan_id, planned["planDigest"].as_str().unwrap()),
            14_100,
        )
        .unwrap();

    let second_no_op_binding = consolidation_binding(&storage, &source_tree_digest);
    submit_consolidation_task(
        &mut storage,
        "task-replay-baseline-2",
        "run-replay-baseline-2",
        second_no_op_binding,
        None,
        15_000,
    );
    let outcome = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 16_000)
        .unwrap();
    assert_eq!(outcome["status"], "voided");
    assert_eq!(
        std::fs::read(worktree.join(".threadshare/memory/scenes/release.md")).unwrap(),
        RELEASE_SCENE.as_bytes()
    );
}

#[test]
fn confirmed_consolidation_promotes_exact_materialized_bytes_and_advances_baseline() {
    let worktree = temp_state_dir("consolidation-promotion-worktree");
    let state_dir = temp_state_dir("consolidation-promotion-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    let source_tree_digest = write_approved_entry_tree(
        &worktree,
        &[("entry-1", "Run verification before publishing.")],
    );
    storage
        .sync_approved(&sync_request_with_digest(
            &source_tree_digest,
            "complete",
            0,
            &[("entry-1", "Run verification before publishing.")],
        ))
        .unwrap();
    let current = RELEASE_SCENE.as_bytes();
    let target_path = ".threadshare/memory/scenes/release.md";
    std::fs::create_dir_all(worktree.join(".threadshare/memory/scenes")).unwrap();
    std::fs::write(worktree.join(target_path), current).unwrap();

    let binding = consolidation_binding(&storage, &source_tree_digest);
    let plan_task: PlanTasksRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "chunks": [],
        "tasks": [{
            "taskId": "task-consolidation-promote",
            "kind": "consolidation",
            "binding": binding,
        }],
    }));
    storage.plan_tasks(&plan_task, 1_000).unwrap();
    let token = claim(
        &mut storage,
        "task-consolidation-promote",
        "holder-c",
        60_000,
        10_000,
    );
    let submit = consolidation_submit(
        "task-consolidation-promote",
        &token,
        "run-promote",
        Some(materialized_update(2)),
    );
    let submitted = storage.submit_consolidation(&submit, 10_100).unwrap();
    let candidate_id = submitted["candidate"]["candidateId"]
        .as_str()
        .unwrap()
        .to_owned();
    let content = submit.operations[0]
        .new_content
        .as_ref()
        .unwrap()
        .as_bytes();
    let promotion = promotion_plan_request(
        &[&candidate_id],
        json!([{
            "targetPath": target_path,
            "operation": "write",
            "sanitizedContent": base64(content),
            "targetBlobHash": git_blob_oid_hex(current),
        }]),
    );
    assert_eq!(
        storage.promotion_plan(&promotion, 20_000).unwrap_err().code,
        "TS_MEMORY_UNVERIFIED_CLAIM"
    );
    let assessment = &submit.assessments[0];
    let confirmation: ConfirmStatementRequest = request(json!({
        "candidateId": candidate_id,
        "statementId": assessment.statement_id,
        "statementTextDigest": assessment.statement_text_digest,
        "citationsDigest": assessment.citations_digest,
    }));
    storage.confirm_statement(&confirmation).unwrap();

    let drifted_current = RELEASE_SCENE.replace("Old guidance.", "Changed after review.");
    std::fs::write(worktree.join(target_path), &drifted_current).unwrap();
    let drifted_plan = promotion_plan_request(
        &[&candidate_id],
        json!([{
            "targetPath": target_path,
            "operation": "write",
            "sanitizedContent": base64(content),
            "targetBlobHash": git_blob_oid_hex(drifted_current.as_bytes()),
        }]),
    );
    assert_eq!(
        storage
            .promotion_plan(&drifted_plan, 20_025)
            .unwrap_err()
            .code,
        "TS_MEMORY_BINDING_DRIFT"
    );
    std::fs::write(worktree.join(target_path), current).unwrap();

    let approved_entry = worktree.join(".threadshare/memory/entries/entry-1.md");
    std::fs::write(&approved_entry, "Changed after patch submission.").unwrap();
    assert_eq!(
        storage.promotion_plan(&promotion, 20_030).unwrap_err().code,
        "TS_MEMORY_BINDING_DRIFT"
    );
    std::fs::write(&approved_entry, "Run verification before publishing.").unwrap();

    let tampered = promotion_plan_request(
        &[&candidate_id],
        json!([{
            "targetPath": target_path,
            "operation": "write",
            "sanitizedContent": base64(b"tampered bytes\n"),
            "targetBlobHash": git_blob_oid_hex(current),
        }]),
    );
    assert_eq!(
        storage.promotion_plan(&tampered, 20_050).unwrap_err().code,
        "TS_MEMORY_CONSOLIDATION_INVALID"
    );

    let planned = storage.promotion_plan(&promotion, 20_100).unwrap();
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(
            &approve_request(&plan_id, planned["planDigest"].as_str().unwrap()),
            20_200,
        )
        .unwrap();
    let applied = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_300)
        .unwrap();
    assert_eq!(applied["status"], "applied");
    assert_eq!(std::fs::read(worktree.join(target_path)).unwrap(), content);

    let baseline: ConsolidationBaselineRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
    }));
    let baseline = storage.consolidation_baseline(&baseline).unwrap();
    assert_eq!(baseline["successfulRunId"], "run-promote");
    assert_eq!(baseline["lastSuccessfulNoOp"], false);
    assert_eq!(baseline["pendingRunId"], Value::Null);
}

#[test]
fn consolidation_apply_voids_when_approved_entry_drifts_after_plan() {
    let worktree = temp_state_dir("consolidation-apply-source-drift-worktree");
    let state_dir = temp_state_dir("consolidation-apply-source-drift-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    let source_tree_digest = write_approved_entry_tree(
        &worktree,
        &[("entry-1", "Run verification before publishing.")],
    );
    storage
        .sync_approved(&sync_request_with_digest(
            &source_tree_digest,
            "complete",
            0,
            &[("entry-1", "Run verification before publishing.")],
        ))
        .unwrap();
    let target_path = ".threadshare/memory/scenes/release.md";
    std::fs::create_dir_all(worktree.join(".threadshare/memory/scenes")).unwrap();
    std::fs::write(worktree.join(target_path), RELEASE_SCENE).unwrap();

    let plan_task: PlanTasksRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "chunks": [],
        "tasks": [{
            "taskId": "task-apply-source-drift",
            "kind": "consolidation",
            "binding": consolidation_binding(&storage, &source_tree_digest),
        }],
    }));
    storage.plan_tasks(&plan_task, 1_000).unwrap();
    let token = claim(
        &mut storage,
        "task-apply-source-drift",
        "holder-c",
        60_000,
        10_000,
    );
    let submit = consolidation_submit(
        "task-apply-source-drift",
        &token,
        "run-apply-source-drift",
        Some(materialized_update(2)),
    );
    let submitted = storage.submit_consolidation(&submit, 10_100).unwrap();
    let candidate_id = submitted["candidate"]["candidateId"]
        .as_str()
        .unwrap()
        .to_owned();
    let assessment = &submit.assessments[0];
    let confirmation: ConfirmStatementRequest = request(json!({
        "candidateId": candidate_id,
        "statementId": assessment.statement_id,
        "statementTextDigest": assessment.statement_text_digest,
        "citationsDigest": assessment.citations_digest,
    }));
    storage.confirm_statement(&confirmation).unwrap();
    let content = submit.operations[0]
        .new_content
        .as_ref()
        .unwrap()
        .as_bytes();
    let promotion = promotion_plan_request(
        &[&candidate_id],
        json!([{
            "targetPath": target_path,
            "operation": "write",
            "sanitizedContent": base64(content),
            "targetBlobHash": git_blob_oid_hex(RELEASE_SCENE.as_bytes()),
        }]),
    );
    let planned = storage.promotion_plan(&promotion, 20_100).unwrap();
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(
            &approve_request(&plan_id, planned["planDigest"].as_str().unwrap()),
            20_200,
        )
        .unwrap();

    std::fs::write(
        worktree.join(".threadshare/memory/entries/entry-1.md"),
        "Changed after promotion planning.",
    )
    .unwrap();
    let voided = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_300)
        .unwrap();
    assert_eq!(voided["status"], "voided");
    assert_eq!(voided["driftedPath"], ".threadshare/memory");
    assert_eq!(
        std::fs::read(worktree.join(target_path)).unwrap(),
        RELEASE_SCENE.as_bytes()
    );
    let queue: ReviewQueueRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "kind": "consolidation",
    }));
    assert!(storage.review_queue(&queue).unwrap().items.is_empty());
    assert_eq!(status_counts(&storage)["consolidations"]["stale"], 1);
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

    let recall: RecallRequest = request(json!({
        "repositoryKey": REPO,
        "worktreeKey": TREE,
        "drafts": [
            {
                "draftRef": "d1",
                "candidateId": "cand-draft",
                "queryText": "alpha migration playbook",
            },
            {
                "draftRef": "d2",
                "candidateId": "cand-pool",
                "queryText": "alpha migration playbook",
            },
        ],
    }));
    recall.validate().unwrap();
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
    let second_draft_ordered = &first.recall_sets[1].ordered;
    assert!(
        second_draft_ordered
            .iter()
            .any(|hit| hit.source_kind == "candidate" && hit.id == "cand-draft")
    );
    assert!(second_draft_ordered.iter().all(|hit| hit.id != "cand-pool"));
    assert!(
        first
            .pool
            .iter()
            .any(|item| item.source_kind == "candidate" && item.id == "cand-draft")
    );

    let second = storage.recall(&recall).unwrap();
    assert_eq!(second.result_set_digest, first.result_set_digest);
    assert_eq!(second.recall_query_digest, first.recall_query_digest);
    assert_eq!(first.approved_projection.generation, 1);
    assert_eq!(first.candidate_projection.generation, 1);
}

#[test]
fn adjudication_protocol_rejects_mutating_a_draft_from_the_current_batch() {
    let value: SubmitAdjudicationRequest = request(json!({
        "taskId": "task-adj",
        "claimToken": "claim-token",
        "responseDigest": hex64('d'),
        "recall": {
            "repositoryKey": REPO,
            "worktreeKey": TREE,
            "drafts": [
                { "draftRef": "d1", "candidateId": "cand-1", "queryText": "alpha" },
                { "draftRef": "d2", "candidateId": "cand-2", "queryText": "alpha" },
            ],
        },
        "expectedResultSetDigest": hex64('e'),
        "adjudications": [
            {
                "draftRef": "d1",
                "action": "merge",
                "targets": [{ "id": "cand-2", "revision": 1 }],
                "mergedPayload": { "content": "merged" },
                "mergedSearchableText": "merged",
            },
            { "draftRef": "d2", "action": "store" },
        ],
    }));
    assert!(value.validate().unwrap_err().contains("current batch"));
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

#[cfg(unix)]
#[test]
fn host_memory_reads_reject_symlinked_parent_components_for_every_collection() {
    for symlink_parent in [".threadshare", ".threadshare/memory"] {
        let worktree = temp_state_dir(&format!("host-read-{symlink_parent:?}"));
        let outside = temp_state_dir(&format!("host-read-outside-{symlink_parent:?}"));
        let outside_memory = outside.join(".threadshare/memory");
        std::fs::create_dir_all(outside_memory.join("entries")).unwrap();
        std::fs::create_dir_all(outside_memory.join("scenes")).unwrap();
        std::fs::write(outside_memory.join("entries/secret.md"), "outside entry").unwrap();
        std::fs::write(outside_memory.join("scenes/secret.md"), "outside scene").unwrap();
        std::fs::write(outside_memory.join("doctrine.md"), "outside doctrine").unwrap();

        if symlink_parent == ".threadshare" {
            std::os::unix::fs::symlink(outside.join(".threadshare"), worktree.join(".threadshare"))
                .unwrap();
        } else {
            std::fs::create_dir_all(worktree.join(".threadshare")).unwrap();
            std::os::unix::fs::symlink(&outside_memory, worktree.join(".threadshare/memory"))
                .unwrap();
        }

        let mut storage = MemoryStorage::open_in_memory().unwrap();
        bind_worktree(&mut storage, &worktree);
        for collection in ["entries", "scenes"] {
            let list: ListMemoryFilesRequest = request(json!({
                "repositoryKey": REPO,
                "worktreeKey": TREE,
                "collection": collection,
            }));
            assert_eq!(
                storage.list_memory_files(&list).unwrap_err().code,
                "TS_MEMORY_BINDING_DRIFT"
            );
            let read: ReadMemoryFileRequest = request(json!({
                "repositoryKey": REPO,
                "worktreeKey": TREE,
                "collection": collection,
                "name": "secret.md",
            }));
            assert_eq!(
                storage.read_memory_file(&read).unwrap_err().code,
                "TS_MEMORY_BINDING_DRIFT"
            );
        }
        let doctrine: ReadMemoryFileRequest = request(json!({
            "repositoryKey": REPO,
            "worktreeKey": TREE,
            "collection": "doctrine",
            "name": null,
        }));
        assert_eq!(
            storage.read_memory_file(&doctrine).unwrap_err().code,
            "TS_MEMORY_BINDING_DRIFT"
        );
    }
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
fn promotion_rejects_unknown_policy_and_voids_assessment_drift_before_mutation() {
    let worktree = temp_state_dir("promotion-assessment-drift-worktree");
    let state_dir = temp_state_dir("promotion-assessment-drift-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    std::fs::create_dir_all(worktree.join(".threadshare/memory/entries")).unwrap();
    quarantine_candidate(
        &mut storage,
        "assessment-drift",
        "cand-assessment-drift",
        "release checklist",
        "typed-fact",
    );
    let target_path = ".threadshare/memory/entries/assessment-drift.md";
    let mut unsupported = promotion_plan_request(
        &["cand-assessment-drift"],
        json!([{
            "targetPath": target_path,
            "sanitizedContent": base64(b"approved bytes\n"),
            "targetBlobHash": null,
        }]),
    );
    unsupported.policy_version = "sanitize@future".to_owned();
    assert_eq!(
        storage
            .promotion_plan(&unsupported, 20_000)
            .unwrap_err()
            .code,
        "TS_MEMORY_REQUEST_INVALID"
    );

    let plan = promotion_plan_request(
        &["cand-assessment-drift"],
        json!([{
            "targetPath": target_path,
            "sanitizedContent": base64(b"approved bytes\n"),
            "targetBlobHash": null,
        }]),
    );
    let planned = storage.promotion_plan(&plan, 20_100).unwrap();
    storage
        .confirm_statement(&confirm_request("cand-assessment-drift", '8', '7'))
        .unwrap();
    let plan_id = planned["planId"].as_str().unwrap();
    storage
        .promotion_approve(
            &approve_request(plan_id, planned["planDigest"].as_str().unwrap()),
            20_200,
        )
        .unwrap();
    let outcome = storage
        .promotion_apply(&apply_request(plan_id, &worktree), 20_300)
        .unwrap();
    assert_eq!(outcome["status"], "voided");
    assert!(!worktree.join(target_path).exists());
    assert_eq!(status_counts(&storage)["promotions"]["voided"], 1);
}

#[test]
fn approved_promotion_blocks_candidate_mutation_until_apply_finishes() {
    let worktree = temp_state_dir("promotion-candidate-lock-worktree");
    let state_dir = temp_state_dir("promotion-candidate-lock-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    std::fs::create_dir_all(worktree.join(".threadshare/memory/entries")).unwrap();
    quarantine_candidate(
        &mut storage,
        "candidate-lock",
        "cand-candidate-lock",
        "release checklist",
        "typed-fact",
    );
    let target_path = ".threadshare/memory/entries/candidate-lock.md";
    let plan = promotion_plan_request(
        &["cand-candidate-lock"],
        json!([{
            "targetPath": target_path,
            "sanitizedContent": base64(b"locked plan bytes\n"),
            "targetBlobHash": null,
        }]),
    );
    let planned = storage.promotion_plan(&plan, 20_000).unwrap();
    let plan_id = planned["planId"].as_str().unwrap();
    storage
        .promotion_approve(
            &approve_request(plan_id, planned["planDigest"].as_str().unwrap()),
            20_100,
        )
        .unwrap();

    assert_eq!(
        storage
            .confirm_statement(&confirm_request("cand-candidate-lock", '8', '7'))
            .unwrap_err()
            .code,
        "TS_MEMORY_CANDIDATE_STALE"
    );
    let discard: DiscardCandidateRequest = request(json!({
        "candidateId": "cand-candidate-lock",
        "expectedRevision": 1,
    }));
    assert_eq!(
        storage
            .discard_candidate(&discard, 20_200)
            .unwrap_err()
            .code,
        "TS_MEMORY_CANDIDATE_STALE"
    );

    let outcome = storage
        .promotion_apply(&apply_request(plan_id, &worktree), 20_300)
        .unwrap();
    assert_eq!(outcome["status"], "applied");
    assert_eq!(
        std::fs::read(worktree.join(target_path)).unwrap(),
        b"locked plan bytes\n"
    );
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
fn promotion_apply_refuses_a_second_process_owner_before_reading_the_plan() {
    let worktree = temp_state_dir("promotion-owner-worktree");
    let state_dir = temp_state_dir("promotion-owner-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    let mut lock_name = storage.database_path().unwrap().as_os_str().to_os_string();
    lock_name.push("-promotion.lock");
    let lock = std::fs::OpenOptions::new()
        .read(true)
        .write(true)
        .create(true)
        .truncate(false)
        .open(PathBuf::from(lock_name))
        .unwrap();
    FileExt::try_lock_exclusive(&lock).unwrap();

    assert_eq!(
        storage
            .promotion_apply(&apply_request("missing-plan", &worktree), 20_000)
            .unwrap_err()
            .code,
        "TS_MEMORY_PLAN_STATE_INVALID"
    );

    FileExt::unlock(&lock).unwrap();
    drop(lock);
    assert_eq!(
        storage
            .promotion_apply(&apply_request("missing-plan", &worktree), 20_100)
            .unwrap_err()
            .code,
        "TS_MEMORY_PLAN_NOT_FOUND"
    );
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

    // Simulate a v2 crash mid-apply: precheck saw both files absent, the first
    // write completed and its progress committed, and the second is pending.
    std::fs::create_dir_all(worktree.join(".threadshare/memory/entries")).unwrap();
    std::fs::write(
        worktree.join(".threadshare/memory/entries/a-first.md"),
        first_content,
    )
    .unwrap();
    let tweak = rusqlite::Connection::open(storage.database_path().unwrap()).unwrap();
    tweak
        .execute(
            "UPDATE promotion_journal SET status='applying', mutation_phase='mutating'
             WHERE plan_id=?1",
            rusqlite::params![&plan_id],
        )
        .unwrap();
    tweak
        .execute(
            "UPDATE promotion_files SET originally_present=0, intent_state='pending', applied=0
             WHERE plan_id=?1",
            rusqlite::params![&plan_id],
        )
        .unwrap();
    tweak
        .execute(
            "UPDATE promotion_files SET intent_state='applied', applied=1
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
fn promotion_write_resumes_after_displacement_before_install() {
    let worktree = temp_state_dir("promotion-write-displacement-worktree");
    let state_dir = temp_state_dir("promotion-write-displacement-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    quarantine_candidate(
        &mut storage,
        "write-resume",
        "cand-write-resume",
        "write resume scene",
        "typed-fact",
    );
    let target_path = ".threadshare/memory/scenes/current.md";
    let original = b"old scene bytes\n";
    let replacement = b"new scene bytes\n";
    let target = worktree.join(target_path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, original).unwrap();
    let plan = promotion_plan_request(
        &["cand-write-resume"],
        json!([{
            "targetPath": target_path,
            "operation": "write",
            "sanitizedContent": base64(replacement),
            "targetBlobHash": git_blob_oid_hex(original),
        }]),
    );
    let planned = storage.promotion_plan(&plan, 20_000).unwrap();
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(
            &approve_request(&plan_id, planned["planDigest"].as_str().unwrap()),
            20_100,
        )
        .unwrap();

    let tweak = rusqlite::Connection::open(storage.database_path().unwrap()).unwrap();
    tweak
        .execute(
            "UPDATE promotion_journal SET status='applying', mutation_phase='mutating'
             WHERE plan_id=?1",
            rusqlite::params![&plan_id],
        )
        .unwrap();
    tweak
        .execute(
            "UPDATE promotion_files SET originally_present=1, rollback_content=?1,
               rollback_digest=?2, intent_state='intent', applied=0 WHERE plan_id=?3",
            rusqlite::params![
                original.as_slice(),
                Sha256::digest(original).to_vec(),
                &plan_id
            ],
        )
        .unwrap();
    drop(tweak);
    let hold = promotion_staging_artifact(
        target.parent().unwrap(),
        &plan_id,
        target_path,
        "forward",
        "hold",
    );
    std::fs::rename(&target, &hold).unwrap();

    let applied = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_200)
        .unwrap();
    assert_eq!(applied["status"], "applied");
    assert_eq!(std::fs::read(&target).unwrap(), replacement);
    assert!(!hold.exists());
}

#[test]
fn promotion_rollback_resumes_after_displacement_before_restore() {
    let worktree = temp_state_dir("promotion-rollback-displacement-worktree");
    let state_dir = temp_state_dir("promotion-rollback-displacement-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    quarantine_candidate(
        &mut storage,
        "rollback-resume",
        "cand-rollback-resume",
        "rollback resume scene",
        "typed-fact",
    );
    let target_path = ".threadshare/memory/scenes/current.md";
    let original = b"old scene bytes\n";
    let replacement = b"new scene bytes\n";
    let target = worktree.join(target_path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, replacement).unwrap();
    let plan = promotion_plan_request(
        &["cand-rollback-resume"],
        json!([{
            "targetPath": target_path,
            "operation": "write",
            "sanitizedContent": base64(replacement),
            "targetBlobHash": git_blob_oid_hex(original),
        }]),
    );
    let planned = storage.promotion_plan(&plan, 20_000).unwrap();
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(
            &approve_request(&plan_id, planned["planDigest"].as_str().unwrap()),
            20_100,
        )
        .unwrap();

    let tweak = rusqlite::Connection::open(storage.database_path().unwrap()).unwrap();
    tweak
        .execute(
            "UPDATE promotion_journal SET status='applying', mutation_phase='rolling_back'
             WHERE plan_id=?1",
            rusqlite::params![&plan_id],
        )
        .unwrap();
    tweak
        .execute(
            "UPDATE promotion_files SET originally_present=1, rollback_content=?1,
               rollback_digest=?2, intent_state='applied', applied=1 WHERE plan_id=?3",
            rusqlite::params![
                original.as_slice(),
                Sha256::digest(original).to_vec(),
                &plan_id
            ],
        )
        .unwrap();
    drop(tweak);
    let hold = promotion_staging_artifact(
        target.parent().unwrap(),
        &plan_id,
        target_path,
        "rollback",
        "hold",
    );
    std::fs::rename(&target, &hold).unwrap();

    let voided = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_200)
        .unwrap();
    assert_eq!(voided["status"], "voided");
    assert_eq!(std::fs::read(&target).unwrap(), original);
    assert!(!hold.exists());
}

#[test]
fn pending_promotion_never_accepts_a_coincidentally_exact_external_write() {
    let worktree = temp_state_dir("promotion-pending-exact-worktree");
    let state_dir = temp_state_dir("promotion-pending-exact-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    quarantine_candidate(
        &mut storage,
        "pending-exact",
        "cand-pending-exact",
        "pending exact scene",
        "typed-fact",
    );
    let target_path = ".threadshare/memory/scenes/current.md";
    let original = b"old scene bytes\n";
    let replacement = b"new scene bytes\n";
    let target = worktree.join(target_path);
    std::fs::create_dir_all(target.parent().unwrap()).unwrap();
    std::fs::write(&target, original).unwrap();
    let plan = promotion_plan_request(
        &["cand-pending-exact"],
        json!([{
            "targetPath": target_path,
            "operation": "write",
            "sanitizedContent": base64(replacement),
            "targetBlobHash": git_blob_oid_hex(original),
        }]),
    );
    let planned = storage.promotion_plan(&plan, 20_000).unwrap();
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(
            &approve_request(&plan_id, planned["planDigest"].as_str().unwrap()),
            20_100,
        )
        .unwrap();

    let tweak = rusqlite::Connection::open(storage.database_path().unwrap()).unwrap();
    tweak
        .execute(
            "UPDATE promotion_journal SET status='applying', mutation_phase='mutating'
             WHERE plan_id=?1",
            rusqlite::params![&plan_id],
        )
        .unwrap();
    tweak
        .execute(
            "UPDATE promotion_files SET originally_present=1, rollback_content=?1,
               rollback_digest=?2, intent_state='pending', applied=0 WHERE plan_id=?3",
            rusqlite::params![
                original.as_slice(),
                Sha256::digest(original).to_vec(),
                &plan_id
            ],
        )
        .unwrap();
    drop(tweak);
    std::fs::write(&target, replacement).unwrap();

    let voided = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_200)
        .unwrap();
    assert_eq!(voided["status"], "voided");
    assert_eq!(std::fs::read(&target).unwrap(), replacement);
}

#[test]
fn applied_new_file_deleted_externally_is_not_recreated() {
    let worktree = temp_state_dir("promotion-applied-delete-worktree");
    let state_dir = temp_state_dir("promotion-applied-delete-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    quarantine_candidate(
        &mut storage,
        "applied-delete",
        "cand-applied-delete",
        "applied delete scene",
        "typed-fact",
    );
    let target_path = ".threadshare/memory/scenes/new.md";
    let replacement = b"new scene bytes\n";
    let target = worktree.join(target_path);
    let plan = promotion_plan_request(
        &["cand-applied-delete"],
        json!([{
            "targetPath": target_path,
            "operation": "write",
            "sanitizedContent": base64(replacement),
            "targetBlobHash": null,
        }]),
    );
    let planned = storage.promotion_plan(&plan, 20_000).unwrap();
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(
            &approve_request(&plan_id, planned["planDigest"].as_str().unwrap()),
            20_100,
        )
        .unwrap();

    let tweak = rusqlite::Connection::open(storage.database_path().unwrap()).unwrap();
    tweak
        .execute(
            "UPDATE promotion_journal SET status='applying', mutation_phase='mutating'
             WHERE plan_id=?1",
            rusqlite::params![&plan_id],
        )
        .unwrap();
    tweak
        .execute(
            "UPDATE promotion_files SET originally_present=0, rollback_content=NULL,
               rollback_digest=NULL, intent_state='applied', applied=1 WHERE plan_id=?1",
            rusqlite::params![&plan_id],
        )
        .unwrap();
    drop(tweak);
    assert!(!target.exists());

    let voided = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_200)
        .unwrap();
    assert_eq!(voided["status"], "voided");
    assert!(!target.exists());
}

#[test]
fn promotion_delete_applies_with_blob_cas_and_clears_rollback_bytes() {
    let worktree = temp_state_dir("promotion-delete-worktree");
    let state_dir = temp_state_dir("promotion-delete-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    quarantine_candidate(
        &mut storage,
        "del",
        "cand-delete",
        "delete scene",
        "typed-fact",
    );
    let target_path = ".threadshare/memory/scenes/obsolete.md";
    let original = b"obsolete scene bytes\n";
    std::fs::create_dir_all(worktree.join(".threadshare/memory/scenes")).unwrap();
    std::fs::write(worktree.join(target_path), original).unwrap();
    let plan = promotion_plan_request(
        &["cand-delete"],
        json!([{
            "targetPath": target_path,
            "operation": "delete",
            "sanitizedContent": null,
            "targetBlobHash": git_blob_oid_hex(original),
        }]),
    );
    let planned = storage.promotion_plan(&plan, 20_000).unwrap();
    assert_eq!(planned["files"][0]["operation"], "delete");
    assert_eq!(planned["files"][0]["sanitizedDigest"], Value::Null);
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(
            &approve_request(&plan_id, planned["planDigest"].as_str().unwrap()),
            20_100,
        )
        .unwrap();
    let applied = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_200)
        .unwrap();
    assert_eq!(applied["status"], "applied");
    assert!(!worktree.join(target_path).exists());

    let audit = rusqlite::Connection::open(storage.database_path().unwrap()).unwrap();
    let terminal: (String, String, Option<Vec<u8>>, Option<Vec<u8>>) = audit
        .query_row(
            "SELECT j.mutation_phase, f.intent_state, f.rollback_content, f.rollback_digest
             FROM promotion_journal j JOIN promotion_files f ON f.plan_id=j.plan_id
             WHERE j.plan_id=?1",
            rusqlite::params![&plan_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
        )
        .unwrap();
    assert_eq!(terminal.0, "done");
    assert_eq!(terminal.1, "applied");
    assert!(terminal.2.is_none() && terminal.3.is_none());
}

#[test]
fn promotion_delete_recovers_when_unlink_completed_before_progress_commit() {
    let worktree = temp_state_dir("promotion-delete-resume-worktree");
    let state_dir = temp_state_dir("promotion-delete-resume-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    quarantine_candidate(
        &mut storage,
        "del-resume",
        "cand-delete",
        "delete scene",
        "typed-fact",
    );
    let target_path = ".threadshare/memory/scenes/obsolete.md";
    let original = b"obsolete scene bytes\n";
    std::fs::create_dir_all(worktree.join(".threadshare/memory/scenes")).unwrap();
    std::fs::write(worktree.join(target_path), original).unwrap();
    let plan = promotion_plan_request(
        &["cand-delete"],
        json!([{
            "targetPath": target_path,
            "operation": "delete",
            "sanitizedContent": null,
            "targetBlobHash": git_blob_oid_hex(original),
        }]),
    );
    let planned = storage.promotion_plan(&plan, 20_000).unwrap();
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(
            &approve_request(&plan_id, planned["planDigest"].as_str().unwrap()),
            20_100,
        )
        .unwrap();

    // Crash window: precheck + intent committed, unlink succeeded, progress did not.
    let tweak = rusqlite::Connection::open(storage.database_path().unwrap()).unwrap();
    tweak
        .execute(
            "UPDATE promotion_journal SET status='applying', mutation_phase='mutating'
             WHERE plan_id=?1",
            rusqlite::params![&plan_id],
        )
        .unwrap();
    tweak
        .execute(
            "UPDATE promotion_files SET originally_present=1, rollback_content=?1,
               rollback_digest=?2, intent_state='intent', applied=0 WHERE plan_id=?3",
            rusqlite::params![
                original.as_slice(),
                Sha256::digest(original).to_vec(),
                &plan_id
            ],
        )
        .unwrap();
    drop(tweak);
    std::fs::remove_file(worktree.join(target_path)).unwrap();

    let applied = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_200)
        .unwrap();
    assert_eq!(applied["status"], "applied");
    assert!(!worktree.join(target_path).exists());
}

#[test]
fn promotion_rolls_back_prior_writes_before_voiding_on_later_drift() {
    let worktree = temp_state_dir("promotion-rollback-worktree");
    let state_dir = temp_state_dir("promotion-rollback-state");
    let mut storage = MemoryStorage::open_state_dir(&state_dir).unwrap();
    bind_worktree(&mut storage, &worktree);
    quarantine_candidate(
        &mut storage,
        "rollback",
        "cand-rollback",
        "rollback patch",
        "typed-fact",
    );
    let write_path = ".threadshare/memory/scenes/current.md";
    let delete_path = ".threadshare/memory/scenes/obsolete.md";
    let old_write = b"old current bytes\n";
    let new_write = b"new current bytes\n";
    let old_delete = b"old obsolete bytes\n";
    let third_party = b"third party edit\n";
    std::fs::create_dir_all(worktree.join(".threadshare/memory/scenes")).unwrap();
    std::fs::write(worktree.join(write_path), old_write).unwrap();
    std::fs::write(worktree.join(delete_path), old_delete).unwrap();
    let plan = promotion_plan_request(
        &["cand-rollback"],
        json!([
            {
                "targetPath": write_path,
                "operation": "write",
                "sanitizedContent": base64(new_write),
                "targetBlobHash": git_blob_oid_hex(old_write),
            },
            {
                "targetPath": delete_path,
                "operation": "delete",
                "sanitizedContent": null,
                "targetBlobHash": git_blob_oid_hex(old_delete),
            },
        ]),
    );
    let planned = storage.promotion_plan(&plan, 20_000).unwrap();
    let plan_id = planned["planId"].as_str().unwrap().to_owned();
    storage
        .promotion_approve(
            &approve_request(&plan_id, planned["planDigest"].as_str().unwrap()),
            20_100,
        )
        .unwrap();

    // Simulate precheck, then the first write + progress. The delete target is
    // changed externally before its mutation, forcing rollback of the write.
    let tweak = rusqlite::Connection::open(storage.database_path().unwrap()).unwrap();
    tweak
        .execute(
            "UPDATE promotion_journal SET status='applying', mutation_phase='mutating'
             WHERE plan_id=?1",
            rusqlite::params![&plan_id],
        )
        .unwrap();
    tweak
        .execute(
            "UPDATE promotion_files SET originally_present=1, rollback_content=?1,
               rollback_digest=?2, intent_state='applied', applied=1
             WHERE plan_id=?3 AND target_path=?4",
            rusqlite::params![
                old_write.as_slice(),
                Sha256::digest(old_write).to_vec(),
                &plan_id,
                write_path
            ],
        )
        .unwrap();
    tweak
        .execute(
            "UPDATE promotion_files SET originally_present=1, rollback_content=?1,
               rollback_digest=?2, intent_state='pending', applied=0
             WHERE plan_id=?3 AND target_path=?4",
            rusqlite::params![
                old_delete.as_slice(),
                Sha256::digest(old_delete).to_vec(),
                &plan_id,
                delete_path
            ],
        )
        .unwrap();
    drop(tweak);
    std::fs::write(worktree.join(write_path), new_write).unwrap();
    std::fs::write(worktree.join(delete_path), third_party).unwrap();

    let voided = storage
        .promotion_apply(&apply_request(&plan_id, &worktree), 20_200)
        .unwrap();
    assert_eq!(voided["status"], "voided");
    assert_eq!(voided["driftedPath"], delete_path);
    assert_eq!(std::fs::read(worktree.join(write_path)).unwrap(), old_write);
    assert_eq!(
        std::fs::read(worktree.join(delete_path)).unwrap(),
        third_party
    );

    let audit = rusqlite::Connection::open(storage.database_path().unwrap()).unwrap();
    let retained: i64 = audit
        .query_row(
            "SELECT COUNT(*) FROM promotion_files
             WHERE plan_id=?1 AND (rollback_content IS NOT NULL OR rollback_digest IS NOT NULL)",
            rusqlite::params![&plan_id],
            |row| row.get(0),
        )
        .unwrap();
    assert_eq!(retained, 0);
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
