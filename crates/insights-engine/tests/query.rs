use std::collections::BTreeMap;

use serde_json::Value;
use threadshare_insights_engine::fact_model::{
    CapabilityTerminalState, DedupeClosure, DuplicateConfidence, DuplicateMethod,
    SessionFactsDeltaV1,
};
use threadshare_insights_engine::query::{QueryError, SearchOrderBy, SearchRequest};
use threadshare_insights_engine::storage::EngineStorage;

fn fixture_delta() -> SessionFactsDeltaV1 {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
    ))
    .unwrap();
    SessionFactsDeltaV1::try_from(fixture["initial"].clone()).unwrap()
}

fn remap_fixture_value(value: &mut Value, replacements: &BTreeMap<String, String>) {
    match value {
        Value::String(current) => {
            if let Some(replacement) = replacements.get(current) {
                *current = replacement.clone();
            }
        }
        Value::Array(items) => {
            for item in items {
                remap_fixture_value(item, replacements);
            }
        }
        Value::Object(fields) => {
            for item in fields.values_mut() {
                remap_fixture_value(item, replacements);
            }
        }
        _ => {}
    }
}

fn independent_fixture_delta() -> SessionFactsDeltaV1 {
    remapped_fixture_delta(BTreeMap::new())
}

/// Same independent session as [`independent_fixture_delta`], observed one day earlier so
/// `observed-desc` has a deterministic ordering to assert against.
fn earlier_fixture_delta() -> SessionFactsDeltaV1 {
    remapped_fixture_delta(
        [
            ("2026-08-10T01:00:00.000Z", "2026-08-09T01:00:00.000Z"),
            ("2026-08-10T01:00:01.000Z", "2026-08-09T01:00:01.000Z"),
        ]
        .into_iter()
        .map(|(source, target)| (source.to_owned(), target.to_owned()))
        .collect(),
    )
}

fn remapped_fixture_delta(extra_replacements: BTreeMap<String, String>) -> SessionFactsDeltaV1 {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
    ))
    .unwrap();
    let mut value = fixture["initial"].clone();
    // Every target starts with 0, so this single-pass remap cannot cascade into a source key.
    let mut replacements = [
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
    replacements.extend(extra_replacements);
    remap_fixture_value(&mut value, &replacements);
    SessionFactsDeltaV1::try_from(value).unwrap()
}

fn tied_candidate_order(deltas: Vec<SessionFactsDeltaV1>) -> (Vec<String>, Vec<String>) {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    for delta in deltas {
        storage.apply_session_facts(delta).unwrap();
    }
    let (response, trace) = storage
        .search_with_trace(SearchRequest {
            query: "normalized fact store".to_owned(),
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap();
    (
        trace.candidate_turn_keys,
        response
            .results
            .into_iter()
            .map(|result| result.turn_key)
            .collect(),
    )
}

#[test]
fn filter_only_search_is_valid_but_an_unconstrained_search_is_too_broad() {
    let unconstrained = SearchRequest::default();
    assert_eq!(
        unconstrained.validate().unwrap_err(),
        QueryError::new(
            "QUERY_TOO_BROAD",
            "query requires text or a structured filter"
        )
    );

    let filtered = SearchRequest {
        providers: vec!["codex".to_owned()],
        ..SearchRequest::default()
    };
    assert!(filtered.validate().is_ok());
}

#[test]
fn search_request_enforces_wire_bounds_and_stable_filter_keys() {
    let too_long = SearchRequest {
        query: "界".repeat(2_731),
        ..SearchRequest::default()
    };
    assert_eq!(too_long.validate().unwrap_err().code, "QUERY_TOO_LONG");

    let invalid = SearchRequest {
        query: "needle".to_owned(),
        providers: vec!["codex".to_owned(); 17],
        project_keys: vec!["not-a-stable-key".to_owned()],
        limit: 0,
        path_limit: 21,
        quiescence_seconds: 59,
        ..SearchRequest::default()
    };
    let error = invalid.validate().unwrap_err();
    assert_eq!(error.code, "QUERY_INVALID_FILTER");
    assert!(error.message.contains("providers"));
}

#[test]
fn filter_only_search_reads_one_bounded_engine_snapshot() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let response = storage
        .search(SearchRequest {
            providers: vec!["codex".to_owned()],
            limit: 7,
            now_unix_ms: 1_700_000_000_000,
            ..SearchRequest::default()
        })
        .unwrap();

    assert_eq!(response.snapshot_seq, "0");
    assert!(response.results.is_empty());
    assert_eq!(response.diagnostic.scoring_term_count, 0);
}

#[test]
fn turn_evidence_is_revision_checked_paginated_and_privacy_safe() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();
    let result = storage
        .search(SearchRequest {
            providers: vec!["codex".to_owned()],
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap()
        .results
        .remove(0);

    let page = storage
        .read_turn_evidence(&result.turn_key, Some(&result.revision), None, 1)
        .unwrap();
    assert_eq!(page.entries.len(), 1);
    assert!(page.next_cursor.is_some());
    let json = serde_json::to_string(&page).unwrap();
    assert!(json.contains("How is the normalized fact store structured?"));
    for forbidden in [
        "sourceLocator",
        "recordStartOffset",
        "toolArguments",
        "/Users/",
    ] {
        assert!(!json.contains(forbidden), "leaked {forbidden}: {json}");
    }
}

#[test]
fn turn_evidence_sorts_multiple_fact_truncation_flags_for_the_wire_contract() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let mut delta = fixture_delta();
    delta.turns[0].fact_truncation =
        vec!["evidence-events".to_owned(), "capability-uses".to_owned()];
    storage.apply_session_facts(delta).unwrap();
    let result = storage
        .search(SearchRequest {
            providers: vec!["codex".to_owned()],
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap()
        .results
        .remove(0);

    let page = storage
        .read_turn_evidence(&result.turn_key, Some(&result.revision), None, 1)
        .unwrap();

    assert_eq!(
        page.turn.fact_truncation,
        ["capability-uses", "evidence-events"]
    );
}

#[test]
fn text_search_intersects_tool_filter_before_ranking() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();
    let response = storage
        .search(SearchRequest {
            query: "normalized fact store".to_owned(),
            providers: vec!["codex".to_owned()],
            tool_capability_keys: vec!["e".repeat(64)],
            after_unix_ms: Some(1_786_323_599_999),
            before_unix_ms: Some(1_786_323_600_001),
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap();

    assert_eq!(response.results.len(), 1);
    assert_eq!(response.results[0].turn_key, "b".repeat(64));
    assert!(response.results[0].relevance_ppm > 0);
    assert!(!response.results[0].matched_field_terms.is_empty());
}

#[test]
fn filter_arrays_must_be_bounded_and_unique() {
    let duplicate = SearchRequest {
        query: "needle".to_owned(),
        providers: vec!["codex".to_owned(), "codex".to_owned()],
        ..SearchRequest::default()
    };
    let error = duplicate.validate().unwrap_err();
    assert_eq!(error.code, "QUERY_INVALID_FILTER");
    assert!(error.message.contains("unique"));

    let unsorted = SearchRequest {
        query: "needle".to_owned(),
        providers: vec!["codex".to_owned(), "claude".to_owned()],
        ..SearchRequest::default()
    };
    assert!(unsorted.validate().unwrap_err().message.contains("sorted"));
}

#[test]
fn a_text_query_with_only_zero_df_terms_does_not_fall_back_to_recent_turns() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();
    let response = storage
        .search(SearchRequest {
            query: "zzzzdefinitelymissing".to_owned(),
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap();

    assert!(response.results.is_empty());
    assert!(response.diagnostic.zero_df_term_count > 0);
}

#[test]
fn evaluation_trace_preserves_the_production_candidate_order() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();
    let (response, trace) = storage
        .search_with_trace(SearchRequest {
            query: "normalized fact store".to_owned(),
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap();

    assert_eq!(trace.candidate_count, 1);
    assert_eq!(trace.candidate_turn_keys, vec!["b".repeat(64)]);
    assert_eq!(response.results[0].turn_key, trace.candidate_turn_keys[0]);
    assert_eq!(trace.path_micros, response.diagnostic.path_micros);
}

#[test]
fn equal_bm25_candidates_are_stable_across_ingestion_histories() {
    let first = fixture_delta();
    let second = independent_fixture_delta();
    let forward = tied_candidate_order(vec![first.clone(), second.clone()]);
    let reverse = tied_candidate_order(vec![second, first]);

    assert_eq!(forward, reverse);
    assert_eq!(forward.0, vec!["02".repeat(32), "b".repeat(64)]);
    assert_eq!(forward.1, forward.0);
}

#[test]
fn a_text_query_without_scoring_terms_is_rejected_even_when_filters_are_present() {
    // "a" analyzes to zero scoring terms. Silently dropping it degraded the request into a
    // filter-only recent-turns listing, which is not what the caller asked for.
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();
    let error = storage
        .search(SearchRequest {
            query: "a".to_owned(),
            providers: vec!["codex".to_owned()],
            tool_capability_keys: vec!["e".repeat(64)],
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap_err();

    assert_eq!(error.code, "QUERY_TOO_BROAD");
}

#[test]
fn relevance_is_the_default_order_and_is_echoed_on_the_response() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();
    let response = storage
        .search(SearchRequest {
            query: "normalized fact store".to_owned(),
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap();

    assert_eq!(SearchRequest::default().order_by, SearchOrderBy::Relevance);
    assert_eq!(response.order_by, SearchOrderBy::Relevance);
    assert_eq!(response.total_match_count, "1");
}

#[test]
fn observed_desc_orders_matches_by_canonical_timestamp_not_relevance_tie_break() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();
    storage
        .apply_session_facts(earlier_fixture_delta())
        .unwrap();

    // Relevance ties break on turn key ascending, which puts the older "02..." turn first.
    let relevance = storage
        .search(SearchRequest {
            query: "normalized fact store".to_owned(),
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap();
    assert_eq!(
        relevance
            .results
            .iter()
            .map(|result| result.turn_key.clone())
            .collect::<Vec<_>>(),
        vec!["02".repeat(32), "b".repeat(64)]
    );
    assert_eq!(relevance.total_match_count, "2");

    // observed-desc must return true newest-first, which is the opposite order here.
    let newest = storage
        .search(SearchRequest {
            query: "normalized fact store".to_owned(),
            order_by: SearchOrderBy::ObservedDesc,
            after_unix_ms: Some(1_786_237_200_000),
            before_unix_ms: Some(1_786_323_600_001),
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap();
    assert_eq!(newest.order_by, SearchOrderBy::ObservedDesc);
    assert_eq!(newest.total_match_count, "2");
    assert_eq!(
        newest
            .results
            .iter()
            .map(|result| result.turn_key.clone())
            .collect::<Vec<_>>(),
        vec!["b".repeat(64), "02".repeat(32)]
    );
}

#[test]
fn observed_desc_text_queries_require_a_complete_bounded_window() {
    let unbounded = SearchRequest {
        query: "needle".to_owned(),
        order_by: SearchOrderBy::ObservedDesc,
        after_unix_ms: Some(1_786_237_200_000),
        ..SearchRequest::default()
    };
    let error = unbounded.validate().unwrap_err();
    assert_eq!(error.code, "QUERY_TOO_BROAD");
    assert!(error.message.contains("observed-desc"), "{}", error.message);

    // 367 days is one day past the supported retention window.
    let too_wide = SearchRequest {
        query: "needle".to_owned(),
        order_by: SearchOrderBy::ObservedDesc,
        after_unix_ms: Some(1_786_323_600_000 - 367 * 86_400_000),
        before_unix_ms: Some(1_786_323_600_000),
        ..SearchRequest::default()
    };
    assert_eq!(too_wide.validate().unwrap_err().code, "QUERY_TOO_BROAD");

    let exactly_366_days = SearchRequest {
        query: "needle".to_owned(),
        order_by: SearchOrderBy::ObservedDesc,
        after_unix_ms: Some(1_786_323_600_000 - 366 * 86_400_000),
        before_unix_ms: Some(1_786_323_600_000),
        ..SearchRequest::default()
    };
    assert!(exactly_366_days.validate().is_ok());

    // A filter-only observed-desc request needs no window: it is already bounded by limit.
    let filter_only = SearchRequest {
        order_by: SearchOrderBy::ObservedDesc,
        providers: vec!["codex".to_owned()],
        ..SearchRequest::default()
    };
    assert!(filter_only.validate().is_ok());
}

#[test]
fn capability_terminal_states_are_bounded_unique_and_need_a_capability_key() {
    let orphaned = SearchRequest {
        query: "needle".to_owned(),
        capability_terminal_states: vec![CapabilityTerminalState::Completed],
        ..SearchRequest::default()
    };
    let error = orphaned.validate().unwrap_err();
    assert_eq!(error.code, "QUERY_INVALID_FILTER");
    assert!(
        error.message.contains("capabilityTerminalStates"),
        "{}",
        error.message
    );

    // Ranked by wire spelling, so "completed" sorts before "pending".
    let unsorted = SearchRequest {
        query: "needle".to_owned(),
        tool_capability_keys: vec!["e".repeat(64)],
        capability_terminal_states: vec![
            CapabilityTerminalState::Pending,
            CapabilityTerminalState::Completed,
        ],
        ..SearchRequest::default()
    };
    assert!(unsorted.validate().unwrap_err().message.contains("sorted"));

    let duplicated = SearchRequest {
        query: "needle".to_owned(),
        tool_capability_keys: vec!["e".repeat(64)],
        capability_terminal_states: vec![
            CapabilityTerminalState::Pending,
            CapabilityTerminalState::Pending,
        ],
        ..SearchRequest::default()
    };
    assert!(
        duplicated
            .validate()
            .unwrap_err()
            .message
            .contains("unique")
    );

    let accepted = SearchRequest {
        query: "needle".to_owned(),
        tool_capability_keys: vec!["e".repeat(64)],
        capability_terminal_states: vec![
            CapabilityTerminalState::Completed,
            CapabilityTerminalState::Pending,
        ],
        ..SearchRequest::default()
    };
    assert!(accepted.validate().is_ok());
}

#[test]
fn capability_terminal_states_filter_the_matching_use_row_not_the_whole_turn() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();

    // The fixture's only use of capability "ee..." is pending, so asking for the completed
    // rows of that capability must return nothing.
    let completed = storage
        .search(SearchRequest {
            providers: vec!["codex".to_owned()],
            tool_capability_keys: vec!["e".repeat(64)],
            capability_terminal_states: vec![CapabilityTerminalState::Completed],
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap();
    assert!(completed.results.is_empty());

    let pending = storage
        .search(SearchRequest {
            providers: vec!["codex".to_owned()],
            tool_capability_keys: vec!["e".repeat(64)],
            capability_terminal_states: vec![CapabilityTerminalState::Pending],
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap();
    assert_eq!(pending.results.len(), 1);
    assert_eq!(pending.total_match_count, "1");
    assert_eq!(pending.results[0].turn_key, "b".repeat(64));
}

#[test]
fn search_returns_group_confidence_and_only_marks_prefix_eof_as_provisional() {
    let mut delta = fixture_delta();
    delta.session.dedupe_fingerprint = Some("7".repeat(64).parse().unwrap());
    delta.session.duplicate_method = Some(DuplicateMethod::ExplicitLineage);
    delta.session.duplicate_confidence = Some(DuplicateConfidence::Strong);
    delta.session.dedupe_closure = Some(DedupeClosure::ObservedEof);
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(delta).unwrap();

    let response = storage
        .search(SearchRequest {
            providers: vec!["codex".to_owned()],
            now_unix_ms: 1_786_320_000_000,
            ..SearchRequest::default()
        })
        .unwrap();
    let dedupe = response.results[0].dedupe.as_ref().unwrap();
    assert_eq!(dedupe.duplicate_group_key.len(), 64);
    assert_eq!(
        dedupe.confidence,
        threadshare_insights_engine::evidence_path::DedupeConfidence::Strong
    );
    assert!(!dedupe.observed_eof_provisional);
}

#[test]
fn observed_timestamp_filters_use_a_half_open_canonical_range() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();
    let mut matches = |after: u64, before: u64| {
        storage
            .search(SearchRequest {
                providers: vec!["codex".to_owned()],
                after_unix_ms: Some(after),
                before_unix_ms: Some(before),
                now_unix_ms: 1_786_320_000_000,
                ..SearchRequest::default()
            })
            .unwrap()
            .results
            .len()
    };

    // The turn is observed exactly at 2026-08-10T01:00:00.000Z.
    assert_eq!(matches(1_786_323_600_000, 1_786_323_600_001), 1);
    assert_eq!(matches(1_786_323_600_001, 1_786_323_700_000), 0);
    assert_eq!(matches(1_786_323_500_000, 1_786_323_600_000), 0);
}
