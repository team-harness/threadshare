use rusqlite::Connection;
use threadshare_insights_engine::delivery_graph_repository::{
    GitCommitDelta, GitCommitFileDelta, IntentDiagnosticDelta, IntentNodeDelta, IntentRefDelta,
    IntentSourceDelta, RepositoryDelta, RepositoryRefDelta, TraceSourceDeltaV1,
};
use threadshare_insights_engine::storage::EngineStorage;

fn key(byte: char) -> String {
    std::iter::repeat_n(byte, 64).collect()
}

fn object_id(byte: char) -> String {
    std::iter::repeat_n(byte, 40).collect()
}

fn delta(delta_id: char, expected: &str, target: &str) -> TraceSourceDeltaV1 {
    let commit = object_id('a');
    TraceSourceDeltaV1 {
        format: "threadshare-insights-trace-source-delta@v1".to_owned(),
        delta_id: key(delta_id),
        expected_generation: expected.to_owned(),
        target_generation: target.to_owned(),
        repository: RepositoryDelta {
            repository_id: "11111111-1111-4111-8111-111111111111".to_owned(),
            repository_key: key('1'),
            available: true,
            ref_digest: key(delta_id),
            scm_provider: Some("github".to_owned()),
            web_base_url: Some("https://github.com".to_owned()),
            repository_path: Some("team-harness/threadshare".to_owned()),
            project_keys: vec![key('3'), key('4')],
        },
        intent: Some(IntentSourceDelta {
            source_key: key('5'),
            adapter_version: "markdown-checklist@1".to_owned(),
            revision: key(delta_id),
            locator: "docs/intent.md".to_owned(),
            coverage: "partial".to_owned(),
            diagnostics: vec![IntentDiagnosticDelta {
                line: "4".to_owned(),
                code: "TS_INSIGHTS_INTENT_REF_INVALID".to_owned(),
            }],
        }),
        refs: vec![RepositoryRefDelta {
            name: "refs/heads/main".to_owned(),
            object_id: commit.clone(),
        }],
        commits: vec![GitCommitDelta {
            object_id: commit,
            parent_object_ids: vec![],
            author_timestamp: "2026-08-16T00:00:00.000Z".to_owned(),
            committer_timestamp: "2026-08-16T00:00:00.000Z".to_owned(),
            tree_object_id: object_id('b'),
            summary: "initial".to_owned(),
            files: vec![GitCommitFileDelta {
                path: "src/lib.rs".to_owned(),
                old_path: None,
                status: "A".to_owned(),
                additions: Some("10".to_owned()),
                deletions: Some("0".to_owned()),
            }],
        }],
        intent_nodes: vec![IntentNodeDelta {
            id: "delivery-trace".to_owned(),
            parent_id: None,
            kind: "feature".to_owned(),
            title: "Deliver trace evidence".to_owned(),
            status: "todo".to_owned(),
            stable_id: true,
        }],
        intent_refs: vec![
            IntentRefDelta {
                node_id: "delivery-trace".to_owned(),
                kind: "commit".to_owned(),
                value: object_id('a'),
            },
            IntentRefDelta {
                node_id: "delivery-trace".to_owned(),
                kind: "spec".to_owned(),
                value: "docs/insights-delivery-trace-design.md".to_owned(),
            },
        ],
    }
}

#[test]
fn trace_source_commit_is_atomic_idempotent_and_generation_checked() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let first = storage
        .apply_trace_source_delta(delta('2', "0", "1"))
        .unwrap();
    assert!(!first.idempotent);
    assert_eq!(first.snapshot_seq, "1");

    let replay = storage
        .apply_trace_source_delta(delta('2', "0", "1"))
        .unwrap();
    assert!(replay.idempotent);
    assert_eq!(replay.snapshot_seq, "1");

    let error = storage
        .apply_trace_source_delta(delta('3', "0", "1"))
        .unwrap_err();
    assert_eq!(error.code, "TS_INSIGHTS_STALE_GENERATION");
    assert_eq!(
        storage
            .repository_generation("11111111-1111-4111-8111-111111111111")
            .unwrap(),
        Some("1".to_owned())
    );
}

#[test]
fn replacing_refs_recomputes_unreachable_commits_without_deleting_history() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage
        .apply_trace_source_delta(delta('2', "0", "1"))
        .unwrap();
    let mut deleted = delta('3', "1", "2");
    deleted.refs.clear();
    deleted.commits.clear();
    storage.apply_trace_source_delta(deleted).unwrap();

    assert_eq!(
        storage
            .repository_commit_counts("11111111-1111-4111-8111-111111111111",)
            .unwrap(),
        (1, 0)
    );
}

#[test]
fn incremental_and_clean_trace_source_commits_have_equal_digests() {
    let mut incremental = EngineStorage::open_in_memory().unwrap();
    incremental
        .apply_trace_source_delta(delta('2', "0", "1"))
        .unwrap();
    let mut second = delta('3', "1", "2");
    second.commits[0].summary = "updated".to_owned();
    incremental
        .apply_trace_source_delta(second.clone())
        .unwrap();

    let mut clean = EngineStorage::open_in_memory().unwrap();
    second.expected_generation = "0".to_owned();
    second.target_generation = "1".to_owned();
    clean.apply_trace_source_delta(second).unwrap();
    assert_eq!(
        incremental.delivery_graph_digest().unwrap(),
        clean.delivery_graph_digest().unwrap()
    );

    let before = clean.delivery_graph_digest().unwrap();
    let mut file_change = delta('4', "1", "2");
    file_change.commits[0].summary = "updated".to_owned();
    file_change.commits[0].files[0].additions = Some("11".to_owned());
    clean.apply_trace_source_delta(file_change).unwrap();
    assert_ne!(before, clean.delivery_graph_digest().unwrap());
}

#[test]
fn opening_an_existing_database_adds_abbreviated_commit_observation_storage() {
    let directory = std::env::temp_dir().join(format!(
        "threadshare-delivery-graph-migration-{}",
        std::process::id()
    ));
    let _ = std::fs::remove_dir_all(&directory);
    std::fs::create_dir(&directory).unwrap();
    let database = directory.join("engine.sqlite3");

    drop(EngineStorage::open(&database).unwrap());
    let connection = Connection::open(&database).unwrap();
    connection
        .execute_batch("DROP TABLE observed_git_commit_prefixes;")
        .unwrap();
    drop(connection);

    drop(EngineStorage::open(&database).unwrap());
    let connection = Connection::open(&database).unwrap();
    let present: bool = connection
        .query_row(
            "SELECT EXISTS(
               SELECT 1 FROM sqlite_schema
               WHERE type='table' AND name='observed_git_commit_prefixes'
             )",
            [],
            |row| row.get(0),
        )
        .unwrap();
    assert!(present);
    drop(connection);
    std::fs::remove_dir_all(directory).unwrap();
}
