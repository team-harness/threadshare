use serde_json::json;
use sha2::{Digest, Sha256};
use threadshare_insights_engine::deep_query::{
    CountMode, DeepEvidenceRequest, DeepEvidenceTarget, DeepOrderBy, DeepPredicate,
    DeepQueryRequest, DeepQueryShape, DeepResource, Direction, PayloadMode, PredicateOperator,
};
use threadshare_insights_engine::fact_model::{
    Completeness, HistoryEventFact, HistoryPayloadChunkFact, HistoryPayloadFact,
    HistoryPayloadKind, PayloadEncoding, SessionFactsDeltaV1, StableKey, WireU64,
    expected_history_event_revision,
};
use threadshare_insights_engine::recipe::{
    RecipeBucket, RecipeFilters, RecipeName, RecipeRequest, RecipeWindow,
};
use threadshare_insights_engine::storage::EngineStorage;

fn key(byte: u8) -> StableKey {
    StableKey::from_bytes([byte; 32])
}

fn wire(value: u64) -> WireU64 {
    value.to_string().parse().unwrap()
}

fn fixture_delta_v2() -> SessionFactsDeltaV1 {
    let fixture = serde_json::from_str::<serde_json::Value>(include_str!(
        "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
    ))
    .unwrap();
    let mut delta = SessionFactsDeltaV1::try_from(fixture["initial"].clone()).unwrap();
    delta.format = "session-facts-delta@v2".to_owned();
    delta.fact_schema_version = 2;
    delta.provider_adapter_version = "codex@2".to_owned();
    delta.privacy_policy_version = 2;
    delta.delta_id = key(0xd2);

    let event = delta.evidence_events[0].common();
    let content = "private payload 界";
    let payload_key = key(0x71);
    let payload = HistoryPayloadFact {
        payload_key,
        owner_session_key: delta.session.session_key,
        event_key: event.event_key,
        payload_kind: HistoryPayloadKind::MessageContent,
        encoding: PayloadEncoding::Utf8,
        byte_length: wire(content.len() as u64),
        sha256: StableKey::from_bytes(Sha256::digest(content.as_bytes()).into()),
        completeness: Completeness::Full,
        chunk_count: wire(1),
    };
    let mut history_event = HistoryEventFact {
        event_key: event.event_key,
        owner_session_key: event.owner_session_key,
        occurred_turn_key: event.occurred_turn_key,
        source_record_key: event.source_record_key,
        source_order: event.source_order.clone(),
        origin_scope: event.origin_scope,
        observed_timestamp: event.observed_timestamp.clone(),
        kind: "visible-message".to_owned(),
        completeness: Completeness::Full,
        revision: key(0),
        metadata: json!({"role":"user"}),
        payload_keys: vec![payload_key],
    };
    history_event.revision = expected_history_event_revision(&history_event, &[&payload]).unwrap();
    delta.history_events = vec![history_event];
    delta.history_payloads = vec![payload.clone()];
    delta.history_payload_chunks = vec![HistoryPayloadChunkFact {
        payload_key,
        owner_session_key: delta.session.session_key,
        ordinal: wire(0),
        content: content.to_owned(),
        byte_length: payload.byte_length,
        sha256: payload.sha256,
    }];
    delta
}

fn fixture_delta_v2_with_two_events() -> SessionFactsDeltaV1 {
    let mut delta = fixture_delta_v2();
    let first = delta.history_events[0].clone();
    let content = "second payload";
    let payload_key = key(0x72);
    let payload = HistoryPayloadFact {
        payload_key,
        owner_session_key: delta.session.session_key,
        event_key: key(0x73),
        payload_kind: HistoryPayloadKind::MessageContent,
        encoding: PayloadEncoding::Utf8,
        byte_length: wire(content.len() as u64),
        sha256: StableKey::from_bytes(Sha256::digest(content.as_bytes()).into()),
        completeness: Completeness::Full,
        chunk_count: wire(1),
    };
    let mut second = HistoryEventFact {
        event_key: payload.event_key,
        owner_session_key: first.owner_session_key,
        occurred_turn_key: first.occurred_turn_key,
        source_record_key: first.source_record_key,
        source_order: threadshare_insights_engine::fact_model::SourceOrder {
            event_ordinal: first.source_order.event_ordinal + 1,
            ..first.source_order
        },
        origin_scope: first.origin_scope,
        observed_timestamp: Some("2026-08-09T01:00:00.000Z".to_owned()),
        kind: "visible-message".to_owned(),
        completeness: Completeness::Full,
        revision: key(0),
        metadata: json!({"role":"assistant"}),
        payload_keys: vec![payload_key],
    };
    second.revision = expected_history_event_revision(&second, &[&payload]).unwrap();
    delta.history_events.push(second);
    delta.history_payloads.push(payload.clone());
    delta.history_payload_chunks.push(HistoryPayloadChunkFact {
        payload_key,
        owner_session_key: delta.session.session_key,
        ordinal: wire(0),
        content: content.to_owned(),
        byte_length: payload.byte_length,
        sha256: payload.sha256,
    });
    delta
}

fn push_history_event(
    delta: &mut SessionFactsDeltaV1,
    event_key: StableKey,
    ordinal: u16,
    kind: &str,
    observed_timestamp: &str,
    metadata: serde_json::Value,
) {
    let first = &delta.history_events[0];
    let mut event = HistoryEventFact {
        event_key,
        owner_session_key: first.owner_session_key,
        occurred_turn_key: first.occurred_turn_key,
        source_record_key: first.source_record_key,
        source_order: threadshare_insights_engine::fact_model::SourceOrder {
            event_ordinal: ordinal,
            ..first.source_order.clone()
        },
        origin_scope: first.origin_scope,
        observed_timestamp: Some(observed_timestamp.to_owned()),
        kind: kind.to_owned(),
        completeness: Completeness::Full,
        revision: key(0),
        metadata,
        payload_keys: Vec::new(),
    };
    event.revision = expected_history_event_revision(&event, &[]).unwrap();
    delta.history_events.push(event);
}

fn attach_history_payload(
    delta: &mut SessionFactsDeltaV1,
    event_key: StableKey,
    payload_key: StableKey,
    payload_kind: HistoryPayloadKind,
    content: &str,
) {
    let payload = HistoryPayloadFact {
        payload_key,
        owner_session_key: delta.session.session_key,
        event_key,
        payload_kind,
        encoding: PayloadEncoding::Utf8,
        byte_length: wire(content.len() as u64),
        sha256: StableKey::from_bytes(Sha256::digest(content.as_bytes()).into()),
        completeness: Completeness::Full,
        chunk_count: wire(1),
    };
    let event = delta
        .history_events
        .iter_mut()
        .find(|event| event.event_key == event_key)
        .unwrap();
    event.payload_keys.push(payload_key);
    event.revision = expected_history_event_revision(event, &[&payload]).unwrap();
    delta.history_payloads.push(payload.clone());
    delta.history_payload_chunks.push(HistoryPayloadChunkFact {
        payload_key,
        owner_session_key: delta.session.session_key,
        ordinal: wire(0),
        content: content.to_owned(),
        byte_length: payload.byte_length,
        sha256: payload.sha256,
    });
}

fn fixture_delta_v2_with_typed_resources() -> SessionFactsDeltaV1 {
    let mut delta = fixture_delta_v2();
    push_history_event(
        &mut delta,
        key(0x81),
        10,
        "capability-invocation",
        "2026-08-10T01:00:02.000Z",
        json!({
            "capabilityKey": key(0xee),
            "correlationDigest": key(0x55),
            "fileActivities": [{
                "action": "read", "phase": "attempted", "pathRole": "target",
                "rawPath": "/private/project/src/lib.rs",
                "normalizedPath": "/private/project/src/lib.rs",
                "relativePath": "src/lib.rs", "absolute": true, "projectRelative": true
            }]
        }),
    );
    push_history_event(
        &mut delta,
        key(0x82),
        11,
        "capability-result",
        "2026-08-10T01:00:03.000Z",
        json!({
            "capabilityKey": key(0xee),
            "correlationDigest": key(0x55),
            "providerState": "failed",
            "exitCode": "7",
            "errorSignatureVersion": "error-signature@1",
            "errorSignature": key(0x83),
            "fileActivities": [{
                "action": "read", "phase": "failed", "pathRole": "target",
                "rawPath": "/private/project/src/lib.rs",
                "normalizedPath": "/private/project/src/lib.rs",
                "relativePath": "src/lib.rs", "absolute": true, "projectRelative": true
            }]
        }),
    );
    attach_history_payload(
        &mut delta,
        key(0x81),
        key(0x87),
        HistoryPayloadKind::ToolInput,
        "{\"cmd\":\"command\"}",
    );
    attach_history_payload(
        &mut delta,
        key(0x82),
        key(0x86),
        HistoryPayloadKind::ErrorContent,
        "fixture failure exact cause",
    );
    push_history_event(
        &mut delta,
        key(0x84),
        12,
        "token-usage",
        "2026-08-10T01:00:04.000Z",
        json!({
            "usageScope": "delta", "model": "fixture-model",
            "inputTokens": "12", "cachedInputTokens": "4", "outputTokens": "3"
        }),
    );
    push_history_event(
        &mut delta,
        key(0x85),
        13,
        "capability-result",
        "2026-08-10T01:00:05.000Z",
        json!({
            "capabilityKey": key(0xee),
            "correlationDigest": key(0x55),
            "providerState": "completed"
        }),
    );
    delta
}

fn recipe_request(name: RecipeName, session_key: StableKey) -> RecipeRequest {
    let mut filters = RecipeFilters::default();
    if name == RecipeName::SolutionRecall {
        filters.text = Some("private payload".to_owned());
    }
    if name == RecipeName::SessionTimeline {
        filters.session_keys = vec![session_key.to_string()];
    }
    if name == RecipeName::ActivityShifts {
        filters.bucket = Some(RecipeBucket::Day);
    }
    RecipeRequest {
        format: "threadshare-insights-recipe-request@v1".to_owned(),
        name,
        window: RecipeWindow {
            after: "2026-08-01T00:00:00.000Z".to_owned(),
            before: "2026-09-01T00:00:00.000Z".to_owned(),
        },
        comparison_window: None,
        filters,
        limit: 20,
        allow_degraded: false,
        evaluated_at: "2026-08-12T00:00:00.000Z".to_owned(),
    }
}

#[test]
fn all_named_recipes_return_typed_results_with_coverage_and_evidence() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta_v2_with_typed_resources();
    let session_key = delta.session.session_key;
    storage.apply_session_facts(delta).unwrap();

    for name in [
        RecipeName::CapabilityContexts,
        RecipeName::FailureChains,
        RecipeName::FileWorkflowSignals,
        RecipeName::ActivityShifts,
        RecipeName::TokenHotspots,
        RecipeName::SolutionRecall,
        RecipeName::SessionTimeline,
    ] {
        let response = storage
            .read_recipe(&recipe_request(name, session_key))
            .unwrap();
        assert_eq!(response.format, "threadshare-insights-recipe@v1");
        assert_eq!(response.name, name);
        assert!(!response.database_uuid.is_empty());
        assert_ne!(response.snapshot_seq, "0");
        assert!(!response.items.is_empty(), "{name:?} must return evidence");
        let total_item_count = response.total_item_count.parse::<usize>().unwrap();
        assert!(total_item_count >= response.items.len());
        assert_eq!(response.truncated, total_item_count > response.items.len());
        assert!(!response.coverage.degraded);
        assert!(response.coverage.diagnostics.is_empty());
        assert_eq!(response.provenance.default, "recorded");
        assert!(
            response
                .items
                .iter()
                .any(|item| item["evidence"].is_object()),
            "{name:?} must return at least one directly addressable evidence target"
        );
    }
}

#[test]
fn recipe_response_rejects_an_unreviewed_item_field() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta_v2_with_typed_resources();
    let session_key = delta.session.session_key;
    storage.apply_session_facts(delta).unwrap();
    let mut response = storage
        .read_recipe(&recipe_request(RecipeName::FailureChains, session_key))
        .unwrap();
    response.items[0]["unreviewed"] = json!("private surprise");

    assert_eq!(
        response.validate().unwrap_err().code,
        "TS_INSIGHTS_REQUEST_INVALID"
    );
}

#[test]
fn coverage_separates_expected_payload_token_and_fts_visibility() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta_v2_with_typed_resources();
    let session_key = delta.session.session_key;
    storage.apply_session_facts(delta).unwrap();

    let response = storage
        .read_recipe(&recipe_request(RecipeName::SessionTimeline, session_key))
        .unwrap();
    assert_eq!(response.coverage.matching.full_record_count, "5");
    assert_eq!(response.coverage.matching.missing_payload_count, "0");
    assert_eq!(response.coverage.matching.missing_token_metric_count, "3");
    assert_eq!(response.coverage.indexed_history.visible_session_count, "1");
    assert_eq!(
        response
            .coverage
            .indexed_history
            .missing_coverage_rollup_session_count,
        "0"
    );
    assert_eq!(
        response.coverage.indexed_history.fts.searchable_event_count,
        "3"
    );
    assert_eq!(
        response
            .coverage
            .indexed_history
            .fts
            .stored_not_searchable_event_count,
        "0"
    );
    assert_eq!(
        response
            .coverage
            .indexed_history
            .fts
            .searchable_payload_bytes,
        "63"
    );

    let token_event = response
        .items
        .iter()
        .find(|item| item["eventKind"] == "token-usage")
        .unwrap();
    assert!(token_event["evidence"].is_object());
}

#[test]
fn recipes_return_failure_file_and_token_evidence_without_inferred_token_attribution() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta_v2_with_typed_resources();
    let session_key = delta.session.session_key;
    storage.apply_session_facts(delta).unwrap();

    let failure = storage
        .read_recipe(&recipe_request(RecipeName::FailureChains, session_key))
        .unwrap();
    assert_eq!(failure.items[0]["status"], "resolved");
    assert_eq!(failure.items[0]["eventCount"], "3");
    assert_eq!(
        failure.items[0]["attempts"][0]["input"]["encoding"],
        "utf-8"
    );
    assert_eq!(
        failure.items[0]["attempts"][1]["error"]["reference"]["kind"],
        "event"
    );

    let files = storage
        .read_recipe(&recipe_request(
            RecipeName::FileWorkflowSignals,
            session_key,
        ))
        .unwrap();
    assert_eq!(files.items[0]["recordedCounts"]["read"], "2");
    assert_eq!(files.items[0]["recordedCounts"]["attempted"], "1");
    assert_eq!(files.items[0]["recordedCounts"]["failed"], "1");
    assert_eq!(
        files.items[0]["events"][0]["rawPath"],
        "/private/project/src/lib.rs"
    );
    assert!(files.items[0]["events"][0]["input"]["reference"].is_object());
    assert!(files.items[0]["events"][1]["error"]["reference"].is_object());

    let tokens = storage
        .read_recipe(&recipe_request(RecipeName::TokenHotspots, session_key))
        .unwrap();
    assert_eq!(tokens.items[0]["recordedTokenTotals"]["input"], "12");
    assert_eq!(tokens.items[0]["recordedTokenTotals"]["cachedInput"], "4");
    assert!(tokens.items[0]["recordedTokenTotals"]["reasoning"].is_null());
    assert_eq!(
        tokens.items[0]["metricCoverage"]["reasoning"]["presentEventCount"],
        "0"
    );
    assert_eq!(
        tokens.items[0]["metricCoverage"]["reasoning"]["totalEventCount"],
        "1"
    );
    assert!(tokens.items[0]["capability"].is_null());
    assert_eq!(tokens.items[0]["capabilityAttribution"], "unavailable");
}

#[test]
fn every_non_null_recipe_evidence_target_is_directly_readable() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta_v2_with_typed_resources();
    let session_key = delta.session.session_key;
    storage.apply_session_facts(delta).unwrap();
    let mut checked = 0;

    for name in [
        RecipeName::CapabilityContexts,
        RecipeName::FailureChains,
        RecipeName::FileWorkflowSignals,
        RecipeName::ActivityShifts,
        RecipeName::TokenHotspots,
        RecipeName::SolutionRecall,
        RecipeName::SessionTimeline,
    ] {
        let response = storage
            .read_recipe(&recipe_request(name, session_key))
            .unwrap();
        for item in response.items {
            let evidence = &item["evidence"];
            if evidence.is_null() {
                continue;
            }
            let target = serde_json::from_value::<DeepEvidenceTarget>(evidence.clone()).unwrap();
            let include = if matches!(target, DeepEvidenceTarget::EventPayload { .. }) {
                vec!["payload".to_owned()]
            } else {
                vec!["envelope".to_owned()]
            };
            storage
                .read_deep_evidence(&DeepEvidenceRequest {
                    format: "threadshare-insights-evidence-request@v2".to_owned(),
                    target,
                    include,
                    cursor: None,
                    max_bytes: 4_096,
                })
                .unwrap_or_else(|error| {
                    panic!("{name:?} emitted unreadable evidence {evidence}: {error:?}")
                });
            checked += 1;
        }
    }
    assert!(checked >= 7);
}

#[test]
fn solution_recall_links_a_matching_failure_to_the_later_successful_attempt() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta_v2_with_typed_resources();
    let session_key = delta.session.session_key;
    storage.apply_session_facts(delta).unwrap();
    let mut request = recipe_request(RecipeName::SolutionRecall, session_key);
    request.filters.text = Some("fixture failure".to_owned());

    let response = storage.read_recipe(&request).unwrap();
    assert_eq!(response.total_item_count, "1");
    assert_eq!(response.coverage.matching.full_record_count, "1");
    assert_eq!(response.items[0]["eventKind"], "capability-result");
    assert_eq!(
        response.items[0]["subsequentSuccess"]["eventKey"],
        key(0x85).to_string()
    );
    assert_eq!(
        response.items[0]["subsequentSuccess"]["evidence"]["kind"],
        "event"
    );
    assert!(response.items[0]["subsequentSuccess"]["chainKey"].is_string());
}

#[test]
fn recipes_reject_incomplete_coverage_unless_degradation_is_explicit() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let mut delta = fixture_delta_v2_with_typed_resources();
    let event = delta.history_events.last_mut().unwrap();
    event.completeness = Completeness::Truncated;
    event.revision = expected_history_event_revision(event, &[]).unwrap();
    storage.apply_session_facts(delta.clone()).unwrap();
    let request = recipe_request(RecipeName::SessionTimeline, delta.session.session_key);

    let error = storage.read_recipe(&request).unwrap_err();
    assert_eq!(error.code, "TS_INSIGHTS_COVERAGE_INCOMPLETE");

    let mut degraded = request;
    degraded.allow_degraded = true;
    let response = storage.read_recipe(&degraded).unwrap();
    assert!(response.coverage.degraded);
    assert_eq!(
        response.coverage.diagnostics,
        ["TS_INSIGHTS_RECIPE_PARTIAL_COVERAGE"]
    );
}

#[test]
fn activity_shift_weeks_start_on_utc_monday_and_compare_complete_windows() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta_v2_with_typed_resources();
    let session_key = delta.session.session_key;
    storage.apply_session_facts(delta).unwrap();
    let mut request = recipe_request(RecipeName::ActivityShifts, session_key);
    request.filters.bucket = Some(RecipeBucket::Week);
    request.window = RecipeWindow {
        after: "2026-08-10T00:00:00.000Z".to_owned(),
        before: "2026-08-17T00:00:00.000Z".to_owned(),
    };
    request.comparison_window = Some(RecipeWindow {
        after: "2026-08-03T00:00:00.000Z".to_owned(),
        before: "2026-08-10T00:00:00.000Z".to_owned(),
    });

    let response = storage.read_recipe(&request).unwrap();
    assert_eq!(response.items.len(), 1);
    assert_eq!(response.items[0]["bucketStart"], request.window.after);
    assert_eq!(
        response.items[0]["comparison"]["baselineBucketStart"],
        request.comparison_window.as_ref().unwrap().after
    );
    assert_eq!(
        response.items[0]["comparison"]["distinctSessionCount"]["baseline"],
        "0"
    );
    assert_eq!(
        response.items[0]["comparison"]["distinctSessionCount"]["absoluteChange"],
        "1"
    );
    assert_eq!(
        response.items[0]["closureEvaluatedAt"],
        request.evaluated_at
    );
    assert_eq!(response.items[0]["quiescenceSeconds"], 300);
    assert_eq!(response.items[0]["recordedToolInvocationCount"], "1");
    assert_eq!(response.items[0]["recordedSkillInvocationCount"], "0");
    assert!(
        response.items[0]
            .get("recordedCapabilityEventCount")
            .is_none()
    );
    assert_eq!(response.items[0]["recordedTokenEventCount"], "1");
    assert_eq!(response.items[0]["recordedTokenTotals"]["input"], "12");
    assert_eq!(response.items[0]["recordedTokenTotals"]["cachedInput"], "4");
    assert_eq!(response.items[0]["recordedTokenTotals"]["output"], "3");
    assert!(response.items[0]["recordedTokenTotals"]["total"].is_null());
    assert_eq!(
        response.items[0]["tokenMetricCoverage"]["total"]["presentEventCount"],
        "0"
    );
    assert_eq!(
        response.items[0]["tokenMetricCoverage"]["total"]["totalEventCount"],
        "1"
    );
    assert_eq!(response.items[0]["currentClosureCounts"]["hardSealed"], "0");
    assert_eq!(response.items[0]["currentClosureCounts"]["quiescent"], "0");
    assert_eq!(response.items[0]["currentClosureCounts"]["open"], "1");
    assert_eq!(
        response.items[0]["turnOutcomeCounts"]["providerCompleted"],
        "1"
    );
    assert_eq!(
        response.items[0]["comparison"]["recordedToolInvocationCount"]["absoluteChange"],
        "1"
    );
    assert_eq!(
        response.items[0]["comparison"]["recordedTokenTotals"]["input"]["absoluteChange"],
        "12"
    );

    request.window = RecipeWindow {
        after: "2026-08-06T00:00:00.000Z".to_owned(),
        before: "2026-08-13T00:00:00.000Z".to_owned(),
    };
    assert_eq!(
        storage.read_recipe(&request).unwrap_err().code,
        "TS_INSIGHTS_REQUEST_INVALID"
    );
}

#[test]
fn recipes_reject_comparison_windows_they_do_not_execute() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta_v2_with_typed_resources();
    let session_key = delta.session.session_key;
    storage.apply_session_facts(delta).unwrap();
    let mut request = recipe_request(RecipeName::TokenHotspots, session_key);
    request.comparison_window = Some(RecipeWindow {
        after: "2026-07-01T00:00:00.000Z".to_owned(),
        before: "2026-08-01T00:00:00.000Z".to_owned(),
    });

    assert_eq!(
        storage.read_recipe(&request).unwrap_err().code,
        "TS_INSIGHTS_REQUEST_INVALID"
    );
}

#[test]
fn recipes_reject_filters_the_selected_recipe_does_not_execute() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta_v2_with_typed_resources();
    let session_key = delta.session.session_key;
    storage.apply_session_facts(delta).unwrap();

    let mut activity = recipe_request(RecipeName::ActivityShifts, session_key);
    activity.filters.session_keys = vec![session_key.to_string()];
    let activity_error = storage.read_recipe(&activity).unwrap_err();
    assert_eq!(activity_error.code, "TS_INSIGHTS_REQUEST_INVALID");
    assert!(activity_error.message.contains("filters.sessionKeys"));

    let mut tokens = recipe_request(RecipeName::TokenHotspots, session_key);
    tokens.filters.capability_keys = vec![key(0xee).to_string()];
    let token_error = storage.read_recipe(&tokens).unwrap_err();
    assert_eq!(token_error.code, "TS_INSIGHTS_REQUEST_INVALID");
    assert!(token_error.message.contains("filters.capabilityKeys"));
}

fn records_query(
    resource: DeepResource,
    select: &[&str],
    order_by: &[(&str, Direction)],
) -> DeepQueryRequest {
    DeepQueryRequest {
        format: "threadshare-insights-query-request@v2".to_owned(),
        resource,
        predicate: None,
        shape: DeepQueryShape::Records {
            select: select.iter().map(|field| (*field).to_owned()).collect(),
            payload_mode: PayloadMode::Reference,
        },
        order_by: order_by
            .iter()
            .map(|(field, direction)| DeepOrderBy {
                field: (*field).to_owned(),
                direction: *direction,
            })
            .collect(),
        limit: 50,
        cursor: None,
        count: CountMode::Exact,
        evaluated_at: "2026-08-12T00:00:00.000Z".to_owned(),
    }
}

fn event_query(limit: u16) -> DeepQueryRequest {
    DeepQueryRequest {
        format: "threadshare-insights-query-request@v2".to_owned(),
        resource: DeepResource::Event,
        predicate: Some(DeepPredicate::Leaf {
            field: "event.kind".to_owned(),
            operator: PredicateOperator::Eq,
            value: Some(json!("visible-message")),
        }),
        shape: DeepQueryShape::Records {
            select: vec![
                "eventKey".to_owned(),
                "sessionKey".to_owned(),
                "turnKey".to_owned(),
                "observedAt".to_owned(),
                "event.kind".to_owned(),
                "message.role".to_owned(),
                "message.content".to_owned(),
                "payloadRef".to_owned(),
            ],
            payload_mode: PayloadMode::Reference,
        },
        order_by: vec![
            DeepOrderBy {
                field: "observedAt".to_owned(),
                direction: Direction::Desc,
            },
            DeepOrderBy {
                field: "eventKey".to_owned(),
                direction: Direction::Asc,
            },
        ],
        limit,
        cursor: None,
        count: CountMode::Exact,
        evaluated_at: "2026-08-12T00:00:00.000Z".to_owned(),
    }
}

#[test]
fn event_text_match_uses_the_versioned_analyzer_projection() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta_v2()).unwrap();
    let mut request = event_query(10);
    request.predicate = Some(DeepPredicate::Leaf {
        field: "text".to_owned(),
        operator: PredicateOperator::Match,
        value: Some(json!("private payload")),
    });

    let response = storage.read_deep_query(&request).unwrap();
    assert_eq!(response.total_match_count.as_deref(), Some("1"));
    assert_eq!(response.records.len(), 1);
    assert_eq!(response.records[0]["message"]["role"], "user");
}

#[test]
fn event_records_are_typed_and_payloads_are_references() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta_v2();
    let event = delta.history_events[0].clone();
    let payload = delta.history_payloads[0].clone();
    storage.apply_session_facts(delta).unwrap();

    let response = storage.read_deep_query(&event_query(1)).unwrap();
    assert_eq!(response.resource, DeepResource::Event);
    assert_eq!(response.total_match_count.as_deref(), Some("1"));
    assert!(!response.truncated);
    assert_eq!(response.records.len(), 1);
    assert_eq!(response.records[0]["eventKey"], event.event_key.to_string());
    assert_eq!(response.records[0]["event"]["kind"], "visible-message");
    assert_eq!(response.records[0]["message"]["role"], "user");
    assert_eq!(
        response.records[0]["message"]["content"]["inline"],
        json!(null)
    );
    assert_eq!(
        response.records[0]["message"]["content"]["reference"]["payloadKey"],
        payload.payload_key.to_string()
    );
    assert_eq!(response.coverage.matching.full_record_count, "1");
}

#[test]
fn evidence_pages_reassemble_utf8_payload_without_truncation() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta_v2();
    let event = delta.history_events[0].clone();
    let payload = delta.history_payloads[0].clone();
    storage.apply_session_facts(delta).unwrap();

    let mut cursor = None;
    let mut content = String::new();
    loop {
        let page = storage
            .read_deep_evidence(&DeepEvidenceRequest {
                format: "threadshare-insights-evidence-request@v2".to_owned(),
                target: DeepEvidenceTarget::EventPayload {
                    event_key: event.event_key.to_string(),
                    revision: event.revision.to_string(),
                    payload_key: Some(payload.payload_key.to_string()),
                },
                include: vec!["envelope".to_owned(), "payload".to_owned()],
                cursor,
                max_bytes: 7,
            })
            .unwrap();
        content.push_str(&page.content);
        if page.complete {
            assert!(page.next_cursor.is_none());
            assert_eq!(page.range.end, payload.byte_length.to_string());
            break;
        }
        cursor = page.next_cursor;
    }
    assert_eq!(content, "private payload 界");
    assert_eq!(
        hex::encode(Sha256::digest(content.as_bytes())),
        payload.sha256.to_string()
    );
}

#[test]
fn deep_query_requires_a_fact_v2_database() {
    let storage = EngineStorage::open_in_memory().unwrap();
    let error = storage.read_deep_query(&event_query(1)).unwrap_err();
    assert_eq!(error.code, "TS_INSIGHTS_QUERY_V2_NOT_READY");
}

#[test]
fn event_cursor_is_stable_and_rejected_by_another_database() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage
        .apply_session_facts(fixture_delta_v2_with_two_events())
        .unwrap();
    let first = storage.read_deep_query(&event_query(1)).unwrap();
    assert!(first.truncated);
    assert_eq!(first.records.len(), 1);

    let mut second_request = event_query(1);
    second_request.cursor = first.next_cursor.clone();
    let second = storage.read_deep_query(&second_request).unwrap();
    assert!(!second.truncated);
    assert_eq!(second.records.len(), 1);
    assert_ne!(first.records[0]["eventKey"], second.records[0]["eventKey"]);

    let mut other = EngineStorage::open_in_memory().unwrap();
    other
        .apply_session_facts(fixture_delta_v2_with_two_events())
        .unwrap();
    let error = other.read_deep_query(&second_request).unwrap_err();
    assert_eq!(error.code, "TS_INSIGHTS_CURSOR_STALE");
}

#[test]
fn excluded_sessions_are_not_visible_to_deep_query() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let delta = fixture_delta_v2();
    storage.apply_session_facts(delta.clone()).unwrap();
    storage.exclude_source(delta.session.session_key).unwrap();

    let response = storage.read_deep_query(&event_query(1)).unwrap();
    assert!(response.records.is_empty());
    assert_eq!(response.total_match_count.as_deref(), Some("0"));
}

#[test]
fn explicitly_selected_message_content_keeps_a_reference_when_payloads_are_omitted() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta_v2()).unwrap();
    let mut request = event_query(1);
    request.shape = DeepQueryShape::Records {
        select: vec!["eventKey".to_owned(), "message.content".to_owned()],
        payload_mode: PayloadMode::Omit,
    };

    let response = storage.read_deep_query(&request).unwrap();
    assert!(response.records[0]["message"]["content"]["inline"].is_null());
    assert!(response.records[0]["message"]["content"]["reference"].is_object());
}

#[test]
fn all_deep_record_resources_have_typed_fields_and_stable_orders() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage
        .apply_session_facts(fixture_delta_v2_with_typed_resources())
        .unwrap();
    let cases = [
        (
            DeepResource::Session,
            vec![
                "sessionKey",
                "provider",
                "session.startedAt",
                "session.endedAt",
                "revision",
            ],
            vec![
                ("session.endedAt", Direction::Desc),
                ("sessionKey", Direction::Asc),
            ],
            "sessionKey",
        ),
        (
            DeepResource::Turn,
            vec![
                "turnKey",
                "sessionKey",
                "observedAt",
                "problem",
                "finalAnswer",
                "revision",
            ],
            vec![("observedAt", Direction::Desc), ("turnKey", Direction::Asc)],
            "turnKey",
        ),
        (
            DeepResource::CapabilityUse,
            vec![
                "useKey",
                "turnKey",
                "observedAt",
                "capability.key",
                "capability.canonicalName",
                "capability.terminalState",
            ],
            vec![("observedAt", Direction::Desc), ("useKey", Direction::Asc)],
            "useKey",
        ),
        (
            DeepResource::FileActivity,
            vec![
                "eventKey",
                "activityOrdinal",
                "observedAt",
                "file.action",
                "file.phase",
                "file.rawPath",
                "file.relativePath",
            ],
            vec![
                ("observedAt", Direction::Desc),
                ("eventKey", Direction::Asc),
                ("activityOrdinal", Direction::Asc),
            ],
            "eventKey",
        ),
        (
            DeepResource::TokenUsage,
            vec![
                "eventKey",
                "observedAt",
                "token.model",
                "token.input",
                "token.cachedInput",
                "token.output",
                "token.reasoning",
            ],
            vec![
                ("observedAt", Direction::Desc),
                ("eventKey", Direction::Asc),
            ],
            "eventKey",
        ),
        (
            DeepResource::ErrorOccurrence,
            vec![
                "eventKey",
                "observedAt",
                "error.signatureVersion",
                "error.signature",
                "error.exitCode",
                "capability.key",
            ],
            vec![
                ("observedAt", Direction::Desc),
                ("eventKey", Direction::Asc),
            ],
            "eventKey",
        ),
    ];
    for (resource, select, order, key_field) in cases {
        let response = storage
            .read_deep_query(&records_query(resource, &select, &order))
            .unwrap();
        assert_eq!(response.resource, resource);
        let expected_count = if resource == DeepResource::FileActivity {
            2
        } else {
            1
        };
        assert_eq!(
            response
                .total_match_count
                .as_deref()
                .unwrap()
                .parse::<usize>()
                .unwrap(),
            expected_count
        );
        assert_eq!(response.records.len(), expected_count);
        assert!(response.records[0][key_field].is_string());
    }
}

#[test]
fn nullable_contract_keys_remain_null_in_records_and_aggregate_groups() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let mut delta = fixture_delta_v2();
    delta.session.project_key = None;
    let event = &mut delta.history_events[0];
    event.occurred_turn_key = None;
    let payload = &delta.history_payloads[0];
    event.revision = expected_history_event_revision(event, &[payload]).unwrap();
    storage.apply_session_facts(delta).unwrap();

    let response = storage
        .read_deep_query(&DeepQueryRequest {
            format: "threadshare-insights-query-request@v2".to_owned(),
            resource: DeepResource::Event,
            predicate: None,
            shape: DeepQueryShape::Records {
                select: vec!["turnKey".to_owned(), "projectKey".to_owned()],
                payload_mode: PayloadMode::Omit,
            },
            order_by: vec![
                DeepOrderBy {
                    field: "observedAt".to_owned(),
                    direction: Direction::Desc,
                },
                DeepOrderBy {
                    field: "eventKey".to_owned(),
                    direction: Direction::Asc,
                },
            ],
            limit: 50,
            cursor: None,
            count: CountMode::Exact,
            evaluated_at: "2026-08-12T00:00:00.000Z".to_owned(),
        })
        .unwrap();
    assert!(response.records[0]["turnKey"].is_null());
    assert!(response.records[0]["projectKey"].is_null());

    let aggregate = storage
        .read_deep_query(&DeepQueryRequest {
            format: "threadshare-insights-query-request@v2".to_owned(),
            resource: DeepResource::Event,
            predicate: None,
            shape: DeepQueryShape::Aggregate {
                group_by: vec!["projectKey".to_owned(), "turnKey".to_owned()],
                metrics: vec![json!({"name":"events","op":"count"})],
            },
            order_by: vec![
                DeepOrderBy {
                    field: "events".to_owned(),
                    direction: Direction::Desc,
                },
                DeepOrderBy {
                    field: "projectKey".to_owned(),
                    direction: Direction::Asc,
                },
                DeepOrderBy {
                    field: "turnKey".to_owned(),
                    direction: Direction::Asc,
                },
            ],
            limit: 50,
            cursor: None,
            count: CountMode::Exact,
            evaluated_at: "2026-08-12T00:00:00.000Z".to_owned(),
        })
        .unwrap();
    let group = &aggregate.groups.as_ref().unwrap()[0]["group"];
    assert!(group["projectKey"].is_null());
    assert!(group["turnKey"].is_null());
}

#[test]
fn error_occurrence_reads_the_recorded_error_payload() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage
        .apply_session_facts(fixture_delta_v2_with_typed_resources())
        .unwrap();
    let response = storage
        .read_deep_query(&records_query(
            DeepResource::ErrorOccurrence,
            &["eventKey", "error.content"],
            &[
                ("observedAt", Direction::Desc),
                ("eventKey", Direction::Asc),
            ],
        ))
        .unwrap();

    assert_eq!(response.records.len(), 1);
    assert_eq!(response.records[0]["error"]["content"]["byteLength"], "27");
    assert!(response.records[0]["error"]["content"]["reference"].is_object());
}

#[test]
fn capability_use_exposes_a_revision_checked_attempt_chain() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage
        .apply_session_facts(fixture_delta_v2_with_typed_resources())
        .unwrap();
    let response = storage
        .read_deep_query(&records_query(
            DeepResource::CapabilityUse,
            &[
                "useKey",
                "observedAt",
                "attempt.chainKey",
                "attempt.revision",
            ],
            &[("observedAt", Direction::Desc), ("useKey", Direction::Asc)],
        ))
        .unwrap();

    assert_eq!(response.records.len(), 1);
    assert!(
        response.records[0]["attempt"]["chainKey"]
            .as_str()
            .is_some_and(|value| value.len() == 64)
    );
    assert!(
        response.records[0]["attempt"]["revision"]
            .as_str()
            .is_some_and(|value| value.len() == 64)
    );
    assert_eq!(
        response.records[0]["observedAt"],
        "2026-08-10T01:00:02.000Z"
    );
}

#[test]
fn attempt_chain_evidence_pages_revision_checked_canonical_json_lines() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage
        .apply_session_facts(fixture_delta_v2_with_typed_resources())
        .unwrap();
    let response = storage
        .read_deep_query(&records_query(
            DeepResource::CapabilityUse,
            &[
                "useKey",
                "observedAt",
                "attempt.chainKey",
                "attempt.revision",
            ],
            &[("observedAt", Direction::Desc), ("useKey", Direction::Asc)],
        ))
        .unwrap();
    let chain_key = response.records[0]["attempt"]["chainKey"]
        .as_str()
        .unwrap()
        .to_owned();
    let revision = response.records[0]["attempt"]["revision"]
        .as_str()
        .unwrap()
        .to_owned();

    let mut cursor = None;
    let mut content = String::new();
    let mut expected_sha = None;
    loop {
        let page = storage
            .read_deep_evidence(&DeepEvidenceRequest {
                format: "threadshare-insights-evidence-request@v2".to_owned(),
                target: DeepEvidenceTarget::AttemptChain {
                    chain_key: chain_key.clone(),
                    revision: revision.clone(),
                },
                include: vec!["envelope".to_owned()],
                cursor,
                max_bytes: 64,
            })
            .unwrap();
        expected_sha.get_or_insert(page.payload_sha256.clone());
        assert_eq!(expected_sha.as_ref(), Some(&page.payload_sha256));
        content.push_str(&page.content);
        if page.complete {
            assert_eq!(page.range.end, page.total_bytes);
            break;
        }
        cursor = page.next_cursor;
    }

    let lines = content
        .lines()
        .map(|line| serde_json::from_str::<serde_json::Value>(line).unwrap())
        .collect::<Vec<_>>();
    assert_eq!(lines.len(), 3);
    assert_eq!(lines[0]["event"]["eventKey"], key(0x81).to_string());
    assert_eq!(lines[1]["event"]["eventKey"], key(0x82).to_string());
    assert_eq!(lines[2]["event"]["eventKey"], key(0x85).to_string());
    assert_eq!(
        expected_sha.as_deref(),
        Some(hex::encode(Sha256::digest(content.as_bytes())).as_str())
    );

    let changed = storage
        .read_deep_evidence(&DeepEvidenceRequest {
            format: "threadshare-insights-evidence-request@v2".to_owned(),
            target: DeepEvidenceTarget::AttemptChain {
                chain_key,
                revision: key(0x99).to_string(),
            },
            include: vec!["envelope".to_owned()],
            cursor: None,
            max_bytes: 64,
        })
        .unwrap_err();
    assert_eq!(changed.code, "TS_INSIGHTS_PAYLOAD_CHANGED");
}

#[test]
fn aggregate_groups_the_complete_candidate_set_with_exact_counts() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage
        .apply_session_facts(fixture_delta_v2_with_typed_resources())
        .unwrap();
    let request = DeepQueryRequest {
        format: "threadshare-insights-query-request@v2".to_owned(),
        resource: DeepResource::CapabilityUse,
        predicate: None,
        shape: DeepQueryShape::Aggregate {
            group_by: vec![
                "capability.kind".to_owned(),
                "capability.canonicalName".to_owned(),
            ],
            metrics: vec![
                json!({"name":"invocations","op":"count"}),
                json!({"name":"sessions","op":"distinct-count","field":"sessionKey"}),
            ],
        },
        order_by: vec![
            DeepOrderBy {
                field: "invocations".to_owned(),
                direction: Direction::Desc,
            },
            DeepOrderBy {
                field: "capability.kind".to_owned(),
                direction: Direction::Asc,
            },
            DeepOrderBy {
                field: "capability.canonicalName".to_owned(),
                direction: Direction::Asc,
            },
        ],
        limit: 50,
        cursor: None,
        count: CountMode::Exact,
        evaluated_at: "2026-08-12T00:00:00.000Z".to_owned(),
    };

    let response = storage.read_deep_query(&request).unwrap();
    let response = serde_json::to_value(response).unwrap();
    assert!(response["records"].is_null());
    assert_eq!(response["totalMatchCount"], "1");
    assert_eq!(response["totalGroupCount"], "1");
    assert_eq!(response["groups"][0]["group"]["capability"]["kind"], "tool");
    assert_eq!(
        response["groups"][0]["group"]["capability"]["canonicalName"],
        "Read"
    );
    assert_eq!(response["groups"][0]["metrics"]["invocations"], "1");
    assert_eq!(response["groups"][0]["metrics"]["sessions"], "1");
}

#[test]
fn aggregate_preserves_u64_sums_and_represents_average_as_a_rational() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    let mut delta = fixture_delta_v2_with_typed_resources();
    let token_event = delta
        .history_events
        .iter_mut()
        .find(|event| event.kind == "token-usage")
        .unwrap();
    token_event.metadata["inputTokens"] = json!("9007199254740993");
    token_event.revision = expected_history_event_revision(token_event, &[]).unwrap();
    storage.apply_session_facts(delta).unwrap();
    let response = storage
        .read_deep_query(&DeepQueryRequest {
            format: "threadshare-insights-query-request@v2".to_owned(),
            resource: DeepResource::TokenUsage,
            predicate: None,
            shape: DeepQueryShape::Aggregate {
                group_by: vec![],
                metrics: vec![
                    json!({"name":"inputSum","op":"sum","field":"token.input"}),
                    json!({"name":"inputAverage","op":"average","field":"token.input"}),
                ],
            },
            order_by: vec![DeepOrderBy {
                field: "inputSum".to_owned(),
                direction: Direction::Desc,
            }],
            limit: 50,
            cursor: None,
            count: CountMode::Exact,
            evaluated_at: "2026-08-12T00:00:00.000Z".to_owned(),
        })
        .unwrap();
    let response = serde_json::to_value(response).unwrap();

    assert_eq!(
        response["groups"][0]["metrics"]["inputSum"],
        "9007199254740993"
    );
    assert_eq!(
        response["groups"][0]["metrics"]["inputAverage"],
        json!({"sum":"9007199254740993","count":"1"})
    );
}
