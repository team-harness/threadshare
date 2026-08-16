use serde_json::json;
use threadshare_insights_engine::delivery_graph_repository::{
    IntentDiagnosticDelta, IntentSourceDelta, RepositoryDelta,
};
use threadshare_insights_engine::delivery_trace::{
    DeliveryTraceRequest, TraceDirection, TraceNodeKind, TraceNodeRef,
};
use threadshare_insights_engine::fact_model::{SessionFactsDeltaV1, StableKey};
use threadshare_insights_engine::hash_key;
use threadshare_insights_engine::storage::EngineStorage;
use threadshare_insights_engine::trace_staging::{TraceSourceCounts, TraceSourceMetadata};

fn metadata() -> TraceSourceMetadata {
    TraceSourceMetadata {
        delta_id: "0".repeat(64),
        expected_generation: "0".to_owned(),
        target_generation: "1".to_owned(),
        repository: RepositoryDelta {
            repository_id: "11111111-1111-4111-8111-111111111111".to_owned(),
            repository_key: "1".repeat(64),
            available: true,
            ref_digest: "2".repeat(64),
            scm_provider: Some("github".to_owned()),
            web_base_url: Some("https://github.com".to_owned()),
            repository_path: Some("team-harness/threadshare".to_owned()),
            project_keys: vec!["3".repeat(64), "4".repeat(64)],
        },
        intent: Some(IntentSourceDelta {
            source_key: "5".repeat(64),
            adapter_version: "markdown-checklist@1".to_owned(),
            revision: "6".repeat(64),
            locator: "docs/intent.md".to_owned(),
            coverage: "partial".to_owned(),
            diagnostics: vec![IntentDiagnosticDelta {
                line: "4".to_owned(),
                code: "TS_INSIGHTS_INTENT_REF_INVALID".to_owned(),
            }],
        }),
        counts: TraceSourceCounts {
            refs: "1".to_owned(),
            commits: "1".to_owned(),
            files: "1".to_owned(),
            intent_nodes: "1".to_owned(),
            intent_refs: "2".to_owned(),
        },
    }
}

fn stage(storage: &mut EngineStorage) {
    storage
        .stage_trace_source_batch(
            "refs",
            0,
            &[json!({ "name": "refs/heads/main", "objectId": "a".repeat(40) })],
        )
        .unwrap();
    storage
        .stage_trace_source_batch(
            "intentNodes",
            0,
            &[json!({
                "id": "delivery-trace",
                "parentId": null,
                "kind": "feature",
                "title": "Deliver trace evidence",
                "status": "todo",
                "stableId": true
            })],
        )
        .unwrap();
    storage
        .stage_trace_source_batch(
            "intentRefs",
            0,
            &[
                json!({
                    "nodeId": "delivery-trace",
                    "kind": "commit",
                    "value": "a".repeat(40)
                }),
                json!({
                    "nodeId": "delivery-trace",
                    "kind": "spec",
                    "value": "docs/insights-delivery-trace-design.md"
                }),
            ],
        )
        .unwrap();
    storage
        .stage_trace_source_batch(
            "commits",
            0,
            &[json!({
                "objectId": "a".repeat(40),
                "parentObjectIds": [],
                "authorTimestamp": "2026-08-16T00:00:00.000Z",
                "committerTimestamp": "2026-08-16T00:00:00.000Z",
                "treeObjectId": "b".repeat(40),
                "summary": "initial"
            })],
        )
        .unwrap();
    storage
        .stage_trace_source_batch(
            "files",
            0,
            &[json!({
                "objectId": "a".repeat(40),
                "path": "src/lib.rs",
                "oldPath": null,
                "status": "A",
                "additions": "10",
                "deletions": "0"
            })],
        )
        .unwrap();
}

#[test]
fn staged_trace_source_is_digest_checked_atomic_and_idempotent() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    stage(&mut storage);
    let mut metadata = metadata();

    let error = storage.apply_staged_trace_source(&metadata).unwrap_err();
    assert_eq!(error.code, "TS_INSIGHTS_INVALID_DELTA");
    assert_eq!(
        storage
            .repository_generation(&metadata.repository.repository_id)
            .unwrap(),
        None
    );

    metadata.delta_id = storage.staged_trace_source_digest(&metadata).unwrap();
    let first = storage.apply_staged_trace_source(&metadata).unwrap();
    assert!(!first.idempotent);
    assert_eq!(first.snapshot_seq, "1");
    assert_eq!(
        storage
            .repository_commit_counts(&metadata.repository.repository_id)
            .unwrap(),
        (1, 1)
    );

    let replay = storage.apply_staged_trace_source(&metadata).unwrap();
    assert!(replay.idempotent);
    assert_eq!(replay.snapshot_seq, "1");

    let commit_key = hash_key(
        "git-commit",
        &[
            hex::decode(&metadata.repository.repository_key).unwrap(),
            "a".repeat(40).into_bytes(),
        ],
    );
    let trace = storage
        .read_delivery_trace(
            "22222222-2222-4222-8222-222222222222",
            &DeliveryTraceRequest {
                format: "threadshare-insights-delivery-trace-request@v1".to_owned(),
                root: TraceNodeRef {
                    kind: TraceNodeKind::GitCommit,
                    key: commit_key,
                },
                window: None,
                direction: TraceDirection::Outgoing,
                max_depth: 1,
                include_candidate_edges: false,
                include_contextual_edges: false,
                limit: 10,
                cursor: None,
                evaluated_at: "2026-08-16T01:00:00.000Z".to_owned(),
            },
        )
        .unwrap();
    assert_eq!(trace.nodes.len(), 2);
    assert_eq!(trace.edges.len(), 1);
    assert_eq!(trace.edges[0].relation.as_str(), "commit-changed-file");
    assert_eq!(trace.coverage.unreachable_commit_count, "0");

    let repository_trace = storage
        .read_delivery_trace(
            "22222222-2222-4222-8222-222222222222",
            &DeliveryTraceRequest {
                format: "threadshare-insights-delivery-trace-request@v1".to_owned(),
                root: TraceNodeRef {
                    kind: TraceNodeKind::Repository,
                    key: metadata.repository.repository_key.clone(),
                },
                window: None,
                direction: TraceDirection::Outgoing,
                max_depth: 1,
                include_candidate_edges: false,
                include_contextual_edges: false,
                limit: 10,
                cursor: None,
                evaluated_at: "2026-08-16T01:00:00.000Z".to_owned(),
            },
        )
        .unwrap();
    assert_eq!(repository_trace.nodes.len(), 2);
    let intent = repository_trace
        .nodes
        .iter()
        .find(|node| node.kind == TraceNodeKind::Intent)
        .unwrap();
    assert_eq!(intent.label, "Deliver trace evidence");
    assert_eq!(
        repository_trace.coverage.intent_state,
        threadshare_insights_engine::delivery_trace::TraceCoverageState::Partial
    );
    assert_eq!(repository_trace.coverage.unresolved_ref_count, "1");

    let intent_trace = storage
        .read_delivery_trace(
            "22222222-2222-4222-8222-222222222222",
            &DeliveryTraceRequest {
                format: "threadshare-insights-delivery-trace-request@v1".to_owned(),
                root: TraceNodeRef {
                    kind: TraceNodeKind::Intent,
                    key: intent.key.clone(),
                },
                window: None,
                direction: TraceDirection::Outgoing,
                max_depth: 1,
                include_candidate_edges: false,
                include_contextual_edges: false,
                limit: 10,
                cursor: None,
                evaluated_at: "2026-08-16T01:00:00.000Z".to_owned(),
            },
        )
        .unwrap();
    assert_eq!(intent_trace.edges.len(), 1);
    assert_eq!(
        intent_trace.edges[0].relation.as_str(),
        "intent-declares-commit"
    );
    assert_eq!(intent_trace.edges[0].strength.as_str(), "direct");
}

#[test]
fn candidate_intent_edges_are_counted_but_hidden_by_default() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
    ))
    .unwrap();
    let mut session = SessionFactsDeltaV1::try_from(fixture["initial"].clone()).unwrap();
    session.delta_id = StableKey::from_bytes([0x91; 32]);
    session.session.project_key = Some("3".repeat(64).parse().unwrap());
    session.turns[0].problem_text = "Deliver trace evidence safely".to_owned();
    storage.apply_session_facts(session).unwrap();

    stage(&mut storage);
    let mut metadata = metadata();
    metadata.delta_id = storage.staged_trace_source_digest(&metadata).unwrap();
    storage.apply_staged_trace_source(&metadata).unwrap();
    let repository_key = hex::decode(&metadata.repository.repository_key).unwrap();
    let intent_key = hash_key("intent", &[repository_key, b"delivery-trace".to_vec()]);
    let request = |include_candidate_edges| DeliveryTraceRequest {
        format: "threadshare-insights-delivery-trace-request@v1".to_owned(),
        root: TraceNodeRef {
            kind: TraceNodeKind::Intent,
            key: intent_key.clone(),
        },
        window: None,
        direction: TraceDirection::Outgoing,
        max_depth: 1,
        include_candidate_edges,
        include_contextual_edges: false,
        limit: 10,
        cursor: None,
        evaluated_at: "2026-08-16T01:00:00.000Z".to_owned(),
    };

    let hidden = storage
        .read_delivery_trace("22222222-2222-4222-8222-222222222222", &request(false))
        .unwrap();
    assert_eq!(hidden.edges.len(), 1);
    assert!(
        hidden
            .edges
            .iter()
            .all(|edge| edge.strength.as_str() != "candidate")
    );
    assert_eq!(hidden.coverage.excluded_candidate_edge_count, "1");

    let visible = storage
        .read_delivery_trace("22222222-2222-4222-8222-222222222222", &request(true))
        .unwrap();
    assert_eq!(visible.edges.len(), 2);
    let candidate = visible
        .edges
        .iter()
        .find(|edge| edge.strength.as_str() == "candidate")
        .unwrap();
    assert_eq!(candidate.relation.as_str(), "intent-correlates-session");
    assert_eq!(visible.coverage.excluded_candidate_edge_count, "0");
}
