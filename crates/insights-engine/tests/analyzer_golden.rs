use serde::Deserialize;
use threadshare_insights_engine::analyzer::{
    AnalyzerError, AnalyzerOriginScope, CapabilityInput, analyze_document, analyze_query,
    analyzer_identity, encode_term,
};
use threadshare_insights_engine::fts_projection::{
    FtsDocument, FtsMatchExpression, initialize_fts_projection_schema,
    upsert_analyzed_fts_document, upsert_fts_document,
};

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct Fixture {
    version: u8,
    identity: IdentityFixture,
    codec_vectors: Vec<CodecVector>,
    document: DocumentFixture,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct IdentityFixture {
    analyzer_version: String,
    analyzer_capability: String,
    search_projection_name: String,
    search_projection_version: u32,
    pulldown_cmark_version: String,
    unicode_normalization_version: String,
    unicode_normalization_unicode_version: String,
    codec_version: String,
}

#[derive(Deserialize)]
struct CodecVector {
    name: String,
    #[serde(default)]
    term: String,
    repeat: Option<String>,
    count: Option<usize>,
    expected: String,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct DocumentFixture {
    markdown: String,
    capabilities: Vec<CapabilityFixture>,
    expected_natural: Vec<String>,
    expected_code: Vec<String>,
    expected_capability: Vec<String>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct CapabilityFixture {
    origin_scope: String,
    turn_ordinal: u64,
    capability_key: String,
    canonical_name: Option<String>,
}

fn fixture() -> Fixture {
    serde_json::from_str(include_str!(
        "../../../test/fixtures/insights-analyzer-golden.v1.json"
    ))
    .unwrap()
}

fn logical_terms(field: &threadshare_insights_engine::analyzer::AnalyzedField) -> Vec<&str> {
    field
        .terms
        .iter()
        .map(|term| term.logical.as_str())
        .collect()
}

#[test]
fn matches_analyzer_identity_and_golden_vectors() {
    let fixture = fixture();
    assert_eq!(fixture.version, 1);

    let identity = analyzer_identity();
    assert_eq!(identity.analyzer_version, fixture.identity.analyzer_version);
    assert_eq!(
        identity.analyzer_capability,
        fixture.identity.analyzer_capability
    );
    assert_eq!(
        identity.search_projection_name,
        fixture.identity.search_projection_name
    );
    assert_eq!(
        identity.search_projection_version,
        fixture.identity.search_projection_version
    );
    assert_eq!(
        identity.pulldown_cmark_version,
        fixture.identity.pulldown_cmark_version
    );
    assert_eq!(
        identity.unicode_normalization_version,
        fixture.identity.unicode_normalization_version
    );
    assert_eq!(
        identity.unicode_normalization_unicode_version,
        fixture.identity.unicode_normalization_unicode_version
    );
    assert_eq!(identity.codec_version, fixture.identity.codec_version);
    assert!(!identity.rust_unicode_version.is_empty());

    for vector in fixture.codec_vectors {
        let logical = match (vector.repeat, vector.count) {
            (Some(value), Some(count)) => value.repeat(count),
            (None, None) => vector.term,
            _ => panic!("invalid codec vector {}", vector.name),
        };
        assert_eq!(encode_term(&logical), vector.expected, "{}", vector.name);
    }

    let keys = fixture
        .document
        .capabilities
        .iter()
        .map(|capability| hex::decode(&capability.capability_key).unwrap())
        .collect::<Vec<_>>();
    let capabilities = fixture
        .document
        .capabilities
        .iter()
        .zip(&keys)
        .map(|(capability, key)| CapabilityInput {
            origin_scope: match capability.origin_scope.as_str() {
                "main" => AnalyzerOriginScope::Main,
                "subagent" => AnalyzerOriginScope::Subagent,
                _ => AnalyzerOriginScope::Unknown,
            },
            turn_ordinal: capability.turn_ordinal,
            capability_key: key,
            canonical_name: capability.canonical_name.as_deref(),
        })
        .collect::<Vec<_>>();
    let analyzed = analyze_document(&fixture.document.markdown, &capabilities);
    assert_eq!(
        logical_terms(&analyzed.natural),
        fixture.document.expected_natural
    );
    assert_eq!(
        logical_terms(&analyzed.code),
        fixture.document.expected_code
    );
    assert_eq!(
        logical_terms(&analyzed.capability),
        fixture.document.expected_capability
    );
    for field in [&analyzed.natural, &analyzed.code, &analyzed.capability] {
        assert_eq!(
            field.fts_text,
            field
                .terms
                .iter()
                .map(|term| term.encoded.as_str())
                .collect::<Vec<_>>()
                .join(" ")
        );
    }
}

#[test]
fn document_caps_keep_deterministic_head_and_tail_budgets() {
    let markdown = (0..5_000)
        .map(|index| format!("natural{index} code_name_{index}"))
        .collect::<Vec<_>>()
        .join(" ");
    let capability_names = (0..300)
        .map(|index| format!("tool{index}"))
        .collect::<Vec<_>>();
    let capability_keys = (0_u64..300)
        .map(|index| index.to_be_bytes().to_vec())
        .collect::<Vec<_>>();
    let capabilities = capability_names
        .iter()
        .zip(&capability_keys)
        .enumerate()
        .map(|(ordinal, (name, key))| CapabilityInput {
            origin_scope: AnalyzerOriginScope::Main,
            turn_ordinal: ordinal as u64,
            capability_key: key,
            canonical_name: Some(name),
        })
        .collect::<Vec<_>>();

    let analyzed = analyze_document(&markdown, &capabilities);
    assert!(analyzed.natural.terms.len() + analyzed.code.terms.len() <= 8_192);
    assert_eq!(analyzed.diagnostics.distinct_field_term_count, 4_096);
    assert!(analyzed.diagnostics.token_truncated);
    assert!(analyzed.diagnostics.distinct_truncated);
    assert_eq!(analyzed.capability.terms.len(), 256);
    assert!(analyzed.diagnostics.capability_truncated);
    assert_eq!(analyzed.capability.terms[191].logical, "tool191".to_owned());
    assert_eq!(analyzed.capability.terms[192].logical, "tool236".to_owned());
    assert_eq!(analyzed.capability.terms[255].logical, "tool299".to_owned());

    let duplicate_keys = [1_u64.to_be_bytes(), 2_u64.to_be_bytes()];
    let duplicate_uses = duplicate_keys
        .iter()
        .enumerate()
        .map(|(ordinal, key)| CapabilityInput {
            origin_scope: AnalyzerOriginScope::Main,
            turn_ordinal: ordinal as u64,
            capability_key: key,
            canonical_name: Some("RepeatedTool"),
        })
        .collect::<Vec<_>>();
    let deduplicated = analyze_document("question", &duplicate_uses);
    assert_eq!(deduplicated.diagnostics.capability_input_count, 2);
    assert_eq!(
        logical_terms(&deduplicated.capability),
        vec!["repeatedtool", "repeated", "tool"]
    );
}

#[test]
fn query_is_typed_bounded_and_deduplicated() {
    assert_eq!(analyze_query("中"), Err(AnalyzerError::QueryTooBroad));
    assert_eq!(
        analyze_query(&"a".repeat(8 * 1_024 + 1)),
        Err(AnalyzerError::QueryTooLong)
    );

    let query = (0..400)
        .map(|index| format!("queryTerm{index}"))
        .collect::<Vec<_>>()
        .join(" ");
    let analyzed = analyze_query(&query).unwrap();
    assert_eq!(analyzed.terms.len(), 256);
    assert!(analyzed.truncated);
    assert!(
        analyzed
            .terms
            .iter()
            .any(|term| term.logical == "queryterm0" && term.field.as_str() == "natural")
    );
    assert!(
        analyzed
            .terms
            .iter()
            .any(|term| term.logical == "queryterm0" && term.field.as_str() == "capability")
    );
    assert!(
        analyzed
            .terms
            .iter()
            .any(|term| term.logical == "queryterm399" && term.field.as_str() == "capability")
    );

    let ordinary = analyze_query("ShellTool").unwrap();
    for logical in ["shelltool", "shell", "tool"] {
        assert!(
            ordinary
                .terms
                .iter()
                .any(|term| term.logical == logical && term.field.as_str() == "capability"),
            "missing capability candidate for {logical}"
        );
    }
}

#[test]
fn fts_accepts_only_analyzed_documents_and_persists_identity_and_diagnostics() {
    let mut connection = rusqlite::Connection::open_in_memory().unwrap();
    initialize_fts_projection_schema(&connection).unwrap();
    let analyzed = analyze_document("Alpha code_name", &[]);

    let transaction = connection.transaction().unwrap();
    upsert_analyzed_fts_document(
        &transaction,
        &FtsDocument {
            turn_id: 7,
            natural: &analyzed.natural.fts_text,
            code: &analyzed.code.fts_text,
            capability: &analyzed.capability.fts_text,
        },
        &analyzed.diagnostics,
    )
    .unwrap();
    assert!(
        upsert_fts_document(
            &transaction,
            &FtsDocument {
                turn_id: 8,
                natural: "raw-alpha",
                code: "",
                capability: "",
            }
        )
        .is_err()
    );
    transaction.commit().unwrap();

    let identity = connection
        .query_row(
            "SELECT projection_name, projection_version, analyzer_version,
                    analyzer_capability, pulldown_cmark_version,
                    unicode_normalization_version,
                    unicode_normalization_unicode_version,
                    rust_unicode_version, codec_version
             FROM fts_analyzer_identity",
            [],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, u32>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                    row.get::<_, String>(4)?,
                    row.get::<_, String>(5)?,
                    row.get::<_, String>(6)?,
                    row.get::<_, String>(7)?,
                    row.get::<_, String>(8)?,
                ))
            },
        )
        .unwrap();
    let expected = analyzer_identity();
    assert_eq!(identity.0, expected.search_projection_name);
    assert_eq!(identity.1, expected.search_projection_version);
    assert_eq!(identity.2, expected.analyzer_version);
    assert_eq!(identity.3, expected.analyzer_capability);
    assert_eq!(identity.4, expected.pulldown_cmark_version);
    assert_eq!(identity.5, expected.unicode_normalization_version);
    assert_eq!(identity.6, expected.unicode_normalization_unicode_version);
    assert_eq!(identity.7, expected.rust_unicode_version);
    assert_eq!(identity.8, expected.codec_version);

    let diagnostics = connection
        .query_row(
            "SELECT token_count, distinct_field_term_count, capability_token_count,
                    token_truncated, distinct_truncated, capability_truncated
             FROM turn_analyzer_diagnostics WHERE turn_id=7",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, bool>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, bool>(5)?,
                ))
            },
        )
        .unwrap();
    assert_eq!(diagnostics.0, analyzed.diagnostics.token_count as i64);
    assert_eq!(
        diagnostics.1,
        analyzed.diagnostics.distinct_field_term_count as i64
    );
    assert_eq!(
        diagnostics.2,
        analyzed.diagnostics.capability_token_count as i64
    );
    assert_eq!(diagnostics.3, analyzed.diagnostics.token_truncated);
    assert_eq!(diagnostics.4, analyzed.diagnostics.distinct_truncated);
    assert_eq!(diagnostics.5, analyzed.diagnostics.capability_truncated);

    let query = analyze_query("Alpha code_name").unwrap();
    let expression = FtsMatchExpression::from_query_terms(&query.terms).unwrap();
    assert!(expression.as_str().contains("natural:"));
    assert!(!expression.as_str().contains("Alpha"));
}

#[test]
fn legacy_nonempty_fts_requires_an_explicit_v2_rebuild() {
    let mut connection = rusqlite::Connection::open_in_memory().unwrap();
    initialize_fts_projection_schema(&connection).unwrap();
    let encoded = encode_term("legacy");
    let transaction = connection.transaction().unwrap();
    upsert_fts_document(
        &transaction,
        &FtsDocument {
            turn_id: 1,
            natural: &encoded,
            code: "",
            capability: "",
        },
    )
    .unwrap();
    transaction.commit().unwrap();

    let analyzed = analyze_document("replacement", &[]);
    let transaction = connection.transaction().unwrap();
    let error = upsert_analyzed_fts_document(
        &transaction,
        &FtsDocument {
            turn_id: 1,
            natural: &analyzed.natural.fts_text,
            code: &analyzed.code.fts_text,
            capability: &analyzed.capability.fts_text,
        },
        &analyzed.diagnostics,
    )
    .unwrap_err();
    assert!(error.to_string().contains("projection rebuild"));
    assert_eq!(
        transaction
            .query_row("SELECT COUNT(*) FROM fts_analyzer_identity", [], |row| {
                row.get::<_, i64>(0)
            })
            .unwrap(),
        0
    );
}
