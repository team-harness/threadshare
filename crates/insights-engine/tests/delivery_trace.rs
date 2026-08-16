use serde::Deserialize;
use threadshare_insights_engine::delivery_trace::{
    DeliveryTraceRequest, DeliveryTraceResponse, SessionCommitEvidence,
    classify_session_commit_evidence,
};
use threadshare_insights_engine::protocol::{MessageKind, validate_protocol_message};

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    format: String,
    request: DeliveryTraceRequest,
    response: DeliveryTraceResponse,
    classifier_cases: Vec<ClassifierCase>,
}

#[derive(Debug, Deserialize)]
#[serde(rename_all = "camelCase")]
struct ClassifierCase {
    name: String,
    input: SessionCommitEvidence,
    expected: ExpectedClassification,
}

#[derive(Debug, Deserialize)]
struct ExpectedClassification {
    relation: String,
    strength: String,
    source: String,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/insights-delivery-trace-golden.v1.json"
    ))
    .unwrap()
}

#[test]
fn shared_fixture_is_valid_and_edge_endpoints_are_page_local() {
    let fixture = fixture();
    assert_eq!(
        fixture.format,
        "threadshare-insights-delivery-trace-golden@v1"
    );
    fixture.request.validate().unwrap();
    fixture.response.validate_against(&fixture.request).unwrap();

    let mut missing = fixture.response;
    missing.nodes.retain(|node| node.kind.as_str() != "file");
    assert_eq!(
        missing.validate_against(&fixture.request).unwrap_err().code,
        "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
    );
}

#[test]
fn session_commit_classifier_never_upgrades_shared_paths_to_direct() {
    let fixture = fixture();
    for case in fixture.classifier_cases {
        let actual = classify_session_commit_evidence(&case.input)
            .unwrap_or_else(|| panic!("{} did not classify", case.name));
        assert_eq!(
            actual.relation.as_str(),
            case.expected.relation,
            "{}",
            case.name
        );
        assert_eq!(
            actual.strength.as_str(),
            case.expected.strength,
            "{}",
            case.name
        );
        assert_eq!(
            actual.source.as_str(),
            case.expected.source,
            "{}",
            case.name
        );
    }
}

#[test]
fn default_request_excludes_candidate_and_contextual_edges() {
    let fixture = fixture();
    for strength in ["candidate", "contextual"] {
        let mut response = fixture.response.clone();
        response.edges[2].strength = serde_json::from_str(&format!("\"{strength}\"")).unwrap();
        assert_eq!(
            response
                .validate_against(&fixture.request)
                .unwrap_err()
                .code,
            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME"
        );
    }
}

#[test]
fn rust_protocol_rejects_malformed_trace_evidence() {
    let build = || {
        let fixture = fixture();
        serde_json::json!({
            "format": "threadshare-insights-protocol@v1",
            "type": "INSIGHTS_DELIVERY_TRACE",
            "requestId": "96",
            "request": fixture.request,
            "response": fixture.response,
        })
    };

    let mut direct = build();
    direct["response"]["edges"][2]["strength"] = serde_json::json!("direct");
    assert!(validate_protocol_message(&direct).is_err());

    let mut invalid_revision = build();
    invalid_revision["response"]["edges"][2]["revision"] = serde_json::json!("invalid");
    assert!(validate_protocol_message(&invalid_revision).is_err());

    let mut invalid_limitation = build();
    invalid_limitation["response"]["edges"][2]["limitations"] =
        serde_json::json!(["proves-authorship"]);
    assert!(validate_protocol_message(&invalid_limitation).is_err());

    let mut missing_facts = build();
    missing_facts["response"]["edges"][2]["facts"] = serde_json::json!([]);
    assert!(validate_protocol_message(&missing_facts).is_err());

    let mut missing_limitations = build();
    missing_limitations["response"]["edges"][2]["limitations"] = serde_json::json!([]);
    assert!(validate_protocol_message(&missing_limitations).is_err());

    let mut unknown = build();
    unknown["response"]["nodes"][0]["attributes"]["unknown"] = serde_json::json!(true);
    assert!(validate_protocol_message(&unknown).is_err());
}

#[test]
fn rust_protocol_validates_the_same_delivery_trace_pair() {
    let first = fixture();
    let request = serde_json::json!({
        "format": "threadshare-insights-protocol@v1",
        "type": "READ_INSIGHTS_DELIVERY_TRACE",
        "requestId": "95",
        "request": first.request,
    });
    assert_eq!(
        validate_protocol_message(&request).unwrap(),
        MessageKind::ReadInsightsDeliveryTrace
    );

    let second = fixture();
    let response = serde_json::json!({
        "format": "threadshare-insights-protocol@v1",
        "type": "INSIGHTS_DELIVERY_TRACE",
        "requestId": "95",
        "request": second.request,
        "response": second.response,
    });
    assert_eq!(
        validate_protocol_message(&response).unwrap(),
        MessageKind::InsightsDeliveryTrace
    );
}
