use std::collections::BTreeMap;
use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;
use rusqlite::hooks::{AuthAction, AuthContext, Authorization};
use threadshare_insights_engine::fact_model::{
    CapabilityKind, CapabilityTerminalState, DedupeClosure, DuplicateConfidence, DuplicateMethod,
    EvidenceEvent, EvidenceStrength, LifecycleState, OriginScope, SessionFactsDeltaV1,
    TurnEvidenceFact, TurnEvidenceRole, TurnLifecycleEvent,
};
use threadshare_insights_engine::insights_overview::{
    CapabilityListKind, CapabilityPageRequest, InsightsOverviewRequest, read_insights_overview,
};
use threadshare_insights_engine::query::{ClosureFilter, SearchRequest};
use threadshare_insights_engine::storage::EngineStorage;

static NEXT_TEMP_DATABASE: AtomicU64 = AtomicU64::new(0);

fn temp_database_path(label: &str) -> (PathBuf, PathBuf) {
    let root = std::env::temp_dir().join(format!(
        "threadshare-insights-{label}-{}-{}",
        std::process::id(),
        NEXT_TEMP_DATABASE.fetch_add(1, Ordering::Relaxed)
    ));
    std::fs::create_dir_all(&root).unwrap();
    let database = root.join("insights.sqlite3");
    (root, database)
}

fn fixture_delta() -> SessionFactsDeltaV1 {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
    ))
    .unwrap();
    SessionFactsDeltaV1::try_from(fixture["initial"].clone()).unwrap()
}

fn remap_fixture_value(value: &mut serde_json::Value, replacements: &BTreeMap<String, String>) {
    match value {
        serde_json::Value::String(current) => {
            if let Some(replacement) = replacements.get(current) {
                *current = replacement.clone();
            }
        }
        serde_json::Value::Array(items) => {
            for item in items {
                remap_fixture_value(item, replacements);
            }
        }
        serde_json::Value::Object(fields) => {
            for item in fields.values_mut() {
                remap_fixture_value(item, replacements);
            }
        }
        _ => {}
    }
}

fn independent_fixture_delta() -> SessionFactsDeltaV1 {
    let fixture: serde_json::Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
    ))
    .unwrap();
    let mut value = fixture["initial"].clone();
    let replacements = [
        ('9', "08"),
        ('a', "01"),
        ('b', "02"),
        ('c', "03"),
        ('1', "04"),
        ('d', "05"),
        ('f', "06"),
        ('2', "07"),
        ('5', "09"),
        ('6', "0a"),
    ]
    .into_iter()
    .map(|(source, target)| (source.to_string().repeat(64), target.repeat(32)))
    .collect::<BTreeMap<_, _>>();
    remap_fixture_value(&mut value, &replacements);
    SessionFactsDeltaV1::try_from(value).unwrap()
}

#[test]
fn capability_page_reports_only_safe_aggregate_identity_and_use_counts() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();

    let page = storage
        .list_capabilities(CapabilityPageRequest {
            kind: CapabilityListKind::Tool,
            cursor: None,
            limit: 20,
        })
        .unwrap();

    assert_eq!(page.snapshot_seq, "1");
    assert_eq!(page.items.len(), 1);
    assert_eq!(page.items[0].capability_key, "e".repeat(64));
    assert_eq!(page.items[0].provider, "codex");
    assert_eq!(page.items[0].kind, CapabilityListKind::Tool);
    assert_eq!(page.items[0].canonical_name, "Read");
    assert_eq!(page.items[0].use_count, "1");
    assert_eq!(page.items[0].turn_count, "1");
    assert_eq!(page.items[0].session_count, "1");
    assert_eq!(page.items[0].terminal.pending, "1");
    assert_eq!(page.items[0].strength.observed, "1");
    assert_eq!(page.next_cursor, None);

    let serialized = serde_json::to_string(&page).unwrap();
    for forbidden in ["sessionKey", "turnKey", "source", "problemText", "/Users/"] {
        assert!(
            !serialized.contains(forbidden),
            "leaked {forbidden}: {serialized}"
        );
    }
}

#[test]
fn capability_pages_are_keyset_stable_and_exclude_subagent_origin_uses() {
    let mut delta = fixture_delta();
    let mut second_capability = delta.capabilities[0].clone();
    second_capability.capability_key = "f".repeat(64).parse().unwrap();
    second_capability.canonical_name = "Write".to_owned();
    let mut second_use = delta.capability_uses[0].clone();
    second_use.use_key = "3".repeat(64).parse().unwrap();
    second_use.capability_key = second_capability.capability_key;
    second_use.turn_ordinal = 1;
    second_use.provider_terminal_state = CapabilityTerminalState::Failed;
    second_use.strength = EvidenceStrength::Confirmed;
    delta.capabilities.push(second_capability);
    delta.capability_uses.push(second_use);

    let mut hidden_capability = delta.capabilities[0].clone();
    hidden_capability.capability_key = "9".repeat(64).parse().unwrap();
    hidden_capability.kind = CapabilityKind::Skill;
    hidden_capability.canonical_name = "private-skill".to_owned();
    let mut hidden_use = delta.capability_uses[0].clone();
    hidden_use.use_key = "4".repeat(64).parse().unwrap();
    hidden_use.capability_key = hidden_capability.capability_key;
    hidden_use.turn_ordinal = 2;
    hidden_use.origin_scope = OriginScope::Subagent;
    delta.capabilities.push(hidden_capability);
    delta.capability_uses.push(hidden_use);

    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(delta).unwrap();
    let first = storage
        .list_capabilities(CapabilityPageRequest {
            kind: CapabilityListKind::Tool,
            cursor: None,
            limit: 1,
        })
        .unwrap();
    assert_eq!(first.items[0].capability_key, "e".repeat(64));
    assert_eq!(first.next_cursor, Some("e".repeat(64)));

    let second = storage
        .list_capabilities(CapabilityPageRequest {
            kind: CapabilityListKind::Tool,
            cursor: first.next_cursor,
            limit: 1,
        })
        .unwrap();
    assert_eq!(second.items[0].capability_key, "f".repeat(64));
    assert_eq!(second.items[0].terminal.failed, "1");
    assert_eq!(second.items[0].strength.confirmed, "1");
    assert_eq!(second.next_cursor, None);

    let skills = storage
        .list_capabilities(CapabilityPageRequest {
            kind: CapabilityListKind::Skill,
            cursor: None,
            limit: 20,
        })
        .unwrap();
    assert!(skills.items.is_empty());

    let overview = storage
        .read_insights_overview(InsightsOverviewRequest {
            now_unix_ms: 1_786_320_000_000,
            quiescence_seconds: 300,
        })
        .unwrap();
    assert_eq!(overview.capabilities.total, "2");
    assert_eq!(overview.capabilities.tool, "2");
    assert_eq!(overview.capabilities.skill, "0");
}

#[test]
fn empty_overview_reads_the_committed_snapshot_without_raw_input() {
    let storage = EngineStorage::open_in_memory().unwrap();
    let overview = storage
        .read_insights_overview(InsightsOverviewRequest {
            now_unix_ms: 1_786_320_000_000,
            quiescence_seconds: 300,
        })
        .unwrap();

    assert_eq!(overview.snapshot_seq, "0");
    assert_eq!(overview.sessions.raw, "0");
    assert_eq!(overview.turns.indexed, "0");
    assert_eq!(overview.capabilities.total, "0");
    assert!(overview.providers.items.is_empty());
    assert!(overview.projects.items.is_empty());
    assert!(overview.coverage.items.is_empty());
    assert!(overview.diagnostics.items.is_empty());
}

#[test]
fn overview_reads_only_transactional_rollups_after_projection_build() {
    let (root, database_path) = temp_database_path("overview-rollup-only");
    {
        let mut storage = EngineStorage::open(&database_path).unwrap();
        storage.apply_session_facts(fixture_delta()).unwrap();
    }

    let connection = Connection::open(&database_path).unwrap();
    connection
        .authorizer(Some(|context: AuthContext<'_>| match context.action {
            AuthAction::Read {
                table_name:
                    "sessions" | "turns" | "source_records" | "evidence_events" | "turn_evidence"
                    | "capabilities" | "capability_uses" | "use_evidence" | "fact_coverage"
                    | "fact_diagnostics",
                ..
            } => Authorization::Deny,
            _ => Authorization::Allow,
        }))
        .unwrap();

    let overview = read_insights_overview(
        &connection,
        InsightsOverviewRequest {
            now_unix_ms: 1_786_320_000_000,
            quiescence_seconds: 300,
        },
    )
    .unwrap();
    assert_eq!(overview.sessions.raw, "1");
    assert_eq!(overview.turns.indexed, "1");
    assert_eq!(overview.capabilities.tool, "1");
    assert_eq!(overview.coverage.items.len(), 2);

    drop(connection);
    std::fs::remove_dir_all(root).unwrap();
}

#[test]
fn purged_sessions_remain_visible_as_content_free_exclusion_counts() {
    let delta = fixture_delta();
    let session_key = delta.session.session_key;
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(delta).unwrap();
    storage.exclude_source(session_key).unwrap();
    storage.run_purge_maintenance(1).unwrap();

    let overview = storage
        .read_insights_overview(InsightsOverviewRequest {
            now_unix_ms: 1_786_320_000_000,
            quiescence_seconds: 300,
        })
        .unwrap();
    assert_eq!(overview.sessions.raw, "1");
    assert_eq!(overview.sessions.excluded, "1");
    assert_eq!(overview.sessions.eligible, "0");
    assert_eq!(overview.scopes.unknown, "1");
}

#[test]
fn excluded_and_purge_pending_sessions_do_not_contribute_turn_visibility() {
    let delta = fixture_delta();
    let session_key = delta.session.session_key;
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(delta).unwrap();

    let before = storage
        .read_insights_overview(InsightsOverviewRequest {
            now_unix_ms: 1_786_320_000_000,
            quiescence_seconds: 300,
        })
        .unwrap();
    assert_eq!(before.turns.active, "1");
    assert_eq!(before.turns.rolled_back, "0");

    storage.exclude_source(session_key).unwrap();
    let pending = storage
        .read_insights_overview(InsightsOverviewRequest {
            now_unix_ms: 1_786_320_000_000,
            quiescence_seconds: 300,
        })
        .unwrap();
    assert_eq!(pending.sessions.excluded, "1");
    assert_eq!(pending.turns.active, "0");
    assert_eq!(pending.turns.rolled_back, "0");
    assert_eq!(pending.turns.unknown_visibility, "0");

    storage.run_purge_maintenance(1).unwrap();
    let purged = storage
        .read_insights_overview(InsightsOverviewRequest {
            now_unix_ms: 1_786_320_000_000,
            quiescence_seconds: 300,
        })
        .unwrap();
    assert_eq!(purged.turns.rolled_back, "0");
}

#[test]
fn overview_aggregates_committed_fact_projection_and_coverage() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();

    let overview = storage
        .read_insights_overview(InsightsOverviewRequest {
            now_unix_ms: 1_786_320_000_000,
            quiescence_seconds: 300,
        })
        .unwrap();

    assert_eq!(overview.snapshot_seq, "1");
    assert_eq!(overview.sessions.raw, "1");
    assert_eq!(overview.sessions.eligible, "1");
    assert_eq!(overview.scopes.main, "1");
    assert_eq!(overview.dedupe.unknown_session, "1");
    assert_eq!(overview.turns.active, "1");
    assert_eq!(overview.turns.hard_sealed, "0");
    assert_eq!(overview.turns.quiescent, "0");
    assert_eq!(overview.turns.open, "1");
    assert_eq!(overview.turns.indexed, "1");
    assert_eq!(overview.capabilities.total, "1");
    assert_eq!(overview.capabilities.tool, "1");
    assert_eq!(overview.providers.items[0].provider, "codex");
    assert_eq!(overview.providers.items[0].indexed_turn_count, "1");
    let records = overview
        .coverage
        .items
        .iter()
        .find(|item| item.key == "records")
        .unwrap();
    assert_eq!(records.count, "2");
    assert!(overview.coverage.truncated);
    assert_eq!(overview.diagnostics.items[0].code, "other");
    assert_eq!(overview.diagnostics.items[0].count, "1");
    assert!(overview.diagnostics.truncated);
}

#[test]
fn dedupe_confidence_and_observed_eof_are_independent_overview_axes() {
    let mut first = fixture_delta();
    let mut second = independent_fixture_delta();
    for delta in [&mut first, &mut second] {
        delta.session.dedupe_fingerprint = Some("7".repeat(64).parse().unwrap());
        delta.session.dedupe_corroboration_fingerprint = Some("8".repeat(64).parse().unwrap());
        delta.session.duplicate_method = Some(DuplicateMethod::ExactFirstTurnPrefix);
        delta.session.duplicate_confidence = Some(DuplicateConfidence::Weak);
    }
    first.session.dedupe_closure = Some(DedupeClosure::HardSealed);
    second.session.dedupe_closure = Some(DedupeClosure::ObservedEof);

    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(first).unwrap();
    storage.apply_session_facts(second).unwrap();
    let overview = storage
        .read_insights_overview(InsightsOverviewRequest {
            now_unix_ms: 1_786_320_000_000,
            quiescence_seconds: 300,
        })
        .unwrap();

    assert_eq!(overview.sessions.raw, "2");
    assert_eq!(overview.dedupe.strong_group, "1");
    assert_eq!(overview.dedupe.weak_group, "0");
    assert_eq!(overview.dedupe.observed_eof_provisional_session, "1");
    assert_eq!(overview.dedupe.unknown_session, "0");
}

#[test]
fn overview_quiescence_uses_the_same_injected_clock_semantics_as_search() {
    let mut delta = fixture_delta();
    delta.checkpoint.source_mtime_ns = "1".parse().unwrap();
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(delta).unwrap();
    let now_unix_ms = 1_786_320_000_000;

    let result = storage
        .search(SearchRequest {
            providers: vec!["codex".to_owned()],
            now_unix_ms,
            quiescence_seconds: 300,
            ..SearchRequest::default()
        })
        .unwrap()
        .results
        .remove(0);
    let overview = storage
        .read_insights_overview(InsightsOverviewRequest {
            now_unix_ms,
            quiescence_seconds: 300,
        })
        .unwrap();

    assert_eq!(result.closure, ClosureFilter::Quiescent);
    assert_eq!(overview.turns.hard_sealed, "0");
    assert_eq!(overview.turns.quiescent, "1");
    assert_eq!(overview.turns.open, "0");
}

#[test]
fn overview_hard_seal_requires_the_same_lifecycle_evidence_as_search() {
    let mut delta = fixture_delta();
    let turn_key = delta.turns[0].turn_key;
    let mut common = delta.evidence_events[0].common().clone();
    common.event_key = "9".repeat(64).parse().unwrap();
    common.occurred_turn_key = Some(turn_key);
    common.source_order.event_ordinal = 2;
    common.pointer.event_ordinal = 2;
    delta
        .evidence_events
        .push(EvidenceEvent::TurnLifecycle(TurnLifecycleEvent {
            common,
            lifecycle_state: LifecycleState::Completed,
            provider_turn_digest: None,
        }));
    delta.turn_evidence.push(TurnEvidenceFact {
        owner_session_key: delta.session.session_key,
        turn_key,
        event_key: "9".repeat(64).parse().unwrap(),
        role: TurnEvidenceRole::Lifecycle,
    });
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(delta).unwrap();
    let now_unix_ms = 1_786_320_000_000;

    let result = storage
        .search(SearchRequest {
            providers: vec!["codex".to_owned()],
            now_unix_ms,
            quiescence_seconds: 300,
            ..SearchRequest::default()
        })
        .unwrap()
        .results
        .remove(0);
    let overview = storage
        .read_insights_overview(InsightsOverviewRequest {
            now_unix_ms,
            quiescence_seconds: 300,
        })
        .unwrap();

    assert_eq!(result.closure, ClosureFilter::HardSealed);
    assert_eq!(overview.turns.hard_sealed, "1");
    assert_eq!(overview.turns.quiescent, "0");
    assert_eq!(overview.turns.open, "0");
}
