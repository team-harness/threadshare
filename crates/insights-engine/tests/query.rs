use std::collections::BTreeMap;

use serde_json::Value;
use threadshare_insights_engine::fact_model::SessionFactsDeltaV1;
use threadshare_insights_engine::query::{QueryError, SearchRequest};
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
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
    ))
    .unwrap();
    let mut value = fixture["initial"].clone();
    // Every target starts with 0, so this single-pass remap cannot cascade into a source key.
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
