use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use threadshare_insights_engine::agent_query::{
    ActivityRequest, ActivityResponse, ActivityWindow, UsageOrderBy, UsageRequest, UsageResponse,
    UsageWindow,
};
use threadshare_insights_engine::canonical_json;
use threadshare_insights_engine::deep_query::{DeepEvidenceRequest, DeepQueryRequest};
use threadshare_insights_engine::delivery_trace::{DeliveryTraceError, DeliveryTraceRequest};
use threadshare_insights_engine::engine::{EngineError, SessionAccumulator};
use threadshare_insights_engine::evidence_path::{
    EvidencePathReport, SafeEvidenceEvent, SafeEvidenceFact, TurnEvidencePage,
};
use threadshare_insights_engine::insights_overview::{
    CapabilityListKind, CapabilityPageRequest, InsightsOverviewRequest,
};
use threadshare_insights_engine::protocol::{
    MAX_FRAME_BYTES, MessageKind, PROTOCOL_FORMAT, PROTOCOL_VERSION, ProtocolError,
    accepted_contract_from_hello, bounded_message, read_frame, request_id,
    validate_begin_against_contract, validate_protocol_message, write_frame,
};
use threadshare_insights_engine::query::{
    QueryError, SearchOrderBy, SearchRequest, SearchResponse, SearchTrace,
};
use threadshare_insights_engine::recipe::RecipeRequest;
use threadshare_insights_engine::storage::{EngineStorage, StorageError};
use threadshare_insights_engine::trace_engine::TraceSourceAccumulator;

const ENGINE_VERSION: &str = match option_env!("THREADSHARE_RELEASE_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
const ENGINE_TARGET: &str = match option_env!("THREADSHARE_ENGINE_TARGET") {
    Some(target) => target,
    None => "development",
};

#[derive(Debug)]
enum State {
    AwaitHello,
    Ready {
        accepted_contract: Value,
    },
    InSession {
        accepted_contract: Value,
        accumulator: SessionAccumulator,
    },
    InTraceSource {
        accepted_contract: Value,
        accumulator: Box<TraceSourceAccumulator>,
    },
}

struct EngineServer {
    storage: EngineStorage,
    database_uuid: String,
    state: State,
}

fn adjacent_build_manifest_digest() -> Result<Option<String>, EngineError> {
    let executable = env::current_exe().map_err(|_| {
        EngineError::new(
            "TS_INSIGHTS_ENGINE_INVALID",
            "storage",
            "Engine executable identity is unavailable",
        )
    })?;
    let Some(package_root) = executable.parent().and_then(|bin| bin.parent()) else {
        return Ok(None);
    };
    let manifest_path = package_root.join("build-manifest.json");
    let bytes = match fs::read(manifest_path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(EngineError::new(
                "TS_INSIGHTS_ENGINE_INVALID",
                "storage",
                "Engine build manifest is unreadable",
            ));
        }
    };
    let document: Value = serde_json::from_slice(&bytes).map_err(|_| {
        EngineError::new(
            "TS_INSIGHTS_ENGINE_INVALID",
            "storage",
            "Engine build manifest is invalid",
        )
    })?;
    if canonical_json(&document).as_bytes() != bytes {
        return Err(EngineError::new(
            "TS_INSIGHTS_ENGINE_INVALID",
            "storage",
            "Engine build manifest is not canonical JSON",
        ));
    }
    Ok(Some(hex::encode(Sha256::digest(bytes))))
}

fn build_manifest_digest(storage: &EngineStorage) -> Result<String, EngineError> {
    if let Some(value) = adjacent_build_manifest_digest()? {
        return Ok(value);
    }
    let identity = json!({
        "engineVersion": ENGINE_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "sqliteCompileOptionsDigest": storage.compile_options_digest()?,
        "sqliteVersion": storage.sqlite_version(),
        "target": ENGINE_TARGET,
    });
    Ok(hex::encode(Sha256::digest(
        canonical_json(&identity).as_bytes(),
    )))
}

fn version_document(storage: &EngineStorage) -> Result<Value, EngineError> {
    Ok(json!({
        "format": "threadshare-insights-engine-version@v1",
        "engineVersion": ENGINE_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "target": ENGINE_TARGET,
        "sqliteVersion": storage.sqlite_version(),
        "sqliteCompileOptionsDigest": storage.compile_options_digest()?,
        "buildManifestDigest": build_manifest_digest(storage)?,
    }))
}

fn ready_message(
    storage: &EngineStorage,
    request_id: &str,
    accepted_contract: Value,
) -> Result<Value, EngineError> {
    let mut response = json!({
        "format": PROTOCOL_FORMAT,
        "type": "READY",
        "requestId": request_id,
        "engineVersion": ENGINE_VERSION,
        "target": ENGINE_TARGET,
        "maxFrameBytes": MAX_FRAME_BYTES,
        "sqliteVersion": storage.sqlite_version(),
        "sqliteCompileOptionsDigest": storage.compile_options_digest()?,
        "buildManifestDigest": build_manifest_digest(storage)?,
        "acceptedContract": accepted_contract,
    });
    if response["acceptedContract"]["factSchemaVersion"].as_u64() == Some(2) {
        response["databaseUuid"] = json!(storage.database_uuid()?);
        response["databaseFactSchemaVersion"] = json!(storage.database_fact_schema_version()?);
    }
    Ok(response)
}

fn engine_error_response(error: &EngineError, request_id: &str) -> Value {
    json!({
        "format": PROTOCOL_FORMAT,
        "type": "ERROR",
        "requestId": request_id,
        "code": error.code,
        "category": error.category,
        "message": bounded_message(&error.message),
        "retryable": error.retryable,
        "fatal": error.fatal,
    })
}

fn fatal(mut error: EngineError) -> EngineError {
    error.fatal = true;
    error
}

fn query_engine_error(error: QueryError) -> EngineError {
    let (category, message) = match error.code {
        "QUERY_FAILED" => ("storage", "Turn search failed"),
        "EVIDENCE_READ_FAILED" => ("storage", "Turn evidence could not be read"),
        "TURN_REVISION_MISMATCH" => ("conflict", "Turn revision changed; repeat the search"),
        "TURN_NOT_FOUND" => ("validation", "Turn was not found"),
        "QUERY_TOO_LONG" => ("validation", "Search query exceeds the supported limit"),
        "QUERY_TOO_BROAD" => (
            "validation",
            "Search query requires more detail or a filter",
        ),
        "QUERY_INVALID_FILTER" => ("validation", "Search filters are invalid"),
        "QUERY_INVALID_LIMIT" => ("validation", "Search result limit is invalid"),
        "TS_INSIGHTS_PROJECTION_BUILDING" => (
            "conflict",
            "Turn search projection is still building; retry after local indexing advances",
        ),
        "TS_INSIGHTS_PROJECTION_FAILED" => (
            "conflict",
            "Turn search projection rebuild failed; rebuild local Insights state",
        ),
        "TS_INSIGHTS_PROJECTION_SPACE_REQUIRED" => (
            "storage",
            "Turn search projection rebuild requires more free disk space",
        ),
        "EVIDENCE_INVALID_LIMIT" => ("validation", "Evidence page limit is invalid"),
        "EVIDENCE_INVALID_CURSOR" => ("validation", "Evidence cursor is invalid"),
        "EVIDENCE_INVALID_KEY" => ("validation", "Evidence key is invalid"),
        "EVIDENCE_PAGE_TOO_LARGE" => ("validation", "Evidence page exceeds the supported limit"),
        _ => ("validation", "Insights query could not be completed"),
    };
    EngineError::new(error.code, category, message)
}

fn dashboard_storage_error(error: StorageError) -> EngineError {
    EngineError::new(
        error.code,
        "storage",
        "Insights dashboard data could not be read",
    )
}

fn agent_query_engine_error(error: QueryError) -> EngineError {
    let (category, message) = match error.code {
        "QUERY_FAILED" => ("storage", "Insights aggregate query failed"),
        "TS_INSIGHTS_REQUEST_INVALID" => ("validation", "Insights aggregate request is invalid"),
        _ => (
            "validation",
            "Insights aggregate query could not be completed",
        ),
    };
    EngineError::new(error.code, category, message)
}

fn deep_query_engine_error(error: QueryError) -> EngineError {
    let (category, message) = match error.code {
        "QUERY_FAILED" => ("storage", "Local Insights query failed"),
        "TS_INSIGHTS_REQUEST_INVALID" => ("validation", "Local Insights request is invalid"),
        "TS_INSIGHTS_QUERY_V2_NOT_READY" => (
            "conflict",
            "Deep query requires a completed Fact V2 index; run threadshare insights sync",
        ),
        "TS_INSIGHTS_CURSOR_STALE" => (
            "conflict",
            "Local Insights cursor is stale; restart from the first page",
        ),
        "TS_INSIGHTS_EVIDENCE_CHANGED" => (
            "conflict",
            "Local Insights evidence changed; repeat the query",
        ),
        "TS_INSIGHTS_EVIDENCE_NOT_FOUND" => ("validation", "Local Insights evidence was not found"),
        "TS_QUERY_TOO_BROAD" => (
            "validation",
            "Local Insights query exceeds its bounded work budget",
        ),
        _ => ("validation", "Local Insights query could not be completed"),
    };
    EngineError::new(error.code, category, message)
}

fn delivery_trace_engine_error(error: DeliveryTraceError) -> EngineError {
    let category = match error.code {
        "TS_INSIGHTS_DELIVERY_TRACE_NOT_READY" | "TS_INSIGHTS_CURSOR_STALE" => "conflict",
        "TS_INSIGHTS_STORAGE_FAILED" | "TS_INSIGHTS_STORAGE_CORRUPT" => "storage",
        _ => "validation",
    };
    EngineError::new(error.code, category, error.message)
}

fn search_request(message: &Value) -> SearchRequest {
    let filters = &message["filters"];
    SearchRequest {
        query: message["query"]
            .as_str()
            .expect("validated search query")
            .to_owned(),
        order_by: match message.get("orderBy").and_then(Value::as_str) {
            Some("observed-desc") => SearchOrderBy::ObservedDesc,
            Some("relevance") | None => SearchOrderBy::Relevance,
            Some(_) => unreachable!("protocol validated search order"),
        },
        providers: serde_json::from_value(filters["providers"].clone())
            .expect("validated providers"),
        project_keys: serde_json::from_value(filters["projectKeys"].clone())
            .expect("validated project keys"),
        tool_capability_keys: serde_json::from_value(filters["toolCapabilityKeys"].clone())
            .expect("validated tool keys"),
        skill_capability_keys: serde_json::from_value(filters["skillCapabilityKeys"].clone())
            .expect("validated skill keys"),
        capability_terminal_states: filters
            .get("capabilityTerminalStates")
            .map(|states| {
                serde_json::from_value(states.clone())
                    .expect("validated capability terminal states")
            })
            .unwrap_or_default(),
        after_unix_ms: filters["observedAtOrAfterUnixMs"]
            .as_str()
            .map(|value| value.parse().expect("validated after timestamp")),
        before_unix_ms: filters["observedBeforeUnixMs"]
            .as_str()
            .map(|value| value.parse().expect("validated before timestamp")),
        result_evidence: serde_json::from_value(filters["resultEvidence"].clone())
            .expect("validated result evidence"),
        closure: serde_json::from_value(filters["closureStates"].clone())
            .expect("validated closure states"),
        limit: u16::try_from(message["limit"].as_u64().expect("validated search limit"))
            .expect("validated search limit fits u16"),
        path_limit: u8::try_from(message["pathLimit"].as_u64().expect("validated path limit"))
            .expect("validated path limit fits u8"),
        now_unix_ms: message["nowUnixMs"]
            .as_str()
            .expect("validated now timestamp")
            .parse()
            .expect("validated now timestamp fits u64"),
        quiescence_seconds: u32::try_from(
            message["quiescenceSeconds"]
                .as_u64()
                .expect("validated quiescence"),
        )
        .expect("validated quiescence fits u32"),
    }
}

fn usage_window(value: &Value) -> UsageWindow {
    UsageWindow {
        observed_at_or_after_unix_ms: value["observedAtOrAfterUnixMs"]
            .as_str()
            .expect("validated Usage window start")
            .parse()
            .expect("validated Usage window start fits u64"),
        observed_before_unix_ms: value["observedBeforeUnixMs"]
            .as_str()
            .expect("validated Usage window end")
            .parse()
            .expect("validated Usage window end fits u64"),
    }
}

fn usage_order_by(value: &Value) -> UsageOrderBy {
    match value.as_str().expect("validated Usage order") {
        "recorded-invocation-count" => UsageOrderBy::RecordedInvocationCount,
        "recorded-failing-invocation-count" => UsageOrderBy::RecordedFailingInvocationCount,
        "distinct-turn-count" => UsageOrderBy::DistinctTurnCount,
        "distinct-session-count" => UsageOrderBy::DistinctSessionCount,
        "distinct-dedupe-group-count" => UsageOrderBy::DistinctDedupeGroupCount,
        "last-used" => UsageOrderBy::LastUsedAt,
        "absolute-recorded-invocation-change" => UsageOrderBy::AbsoluteRecordedInvocationChange,
        _ => unreachable!("protocol validated Usage order"),
    }
}

fn capability_usage_request(message: &Value) -> UsageRequest {
    let filters = &message["filters"];
    UsageRequest {
        kind: serde_json::from_value(message["kind"].clone()).expect("validated Usage kind"),
        window: usage_window(&message["window"]),
        comparison_window: (!message["comparisonWindow"].is_null())
            .then(|| usage_window(&message["comparisonWindow"])),
        providers: serde_json::from_value(filters["providers"].clone())
            .expect("validated Usage providers"),
        project_keys: serde_json::from_value(filters["projectKeys"].clone())
            .expect("validated Usage project keys"),
        closure_states: serde_json::from_value(filters["closureStates"].clone())
            .expect("validated Usage closure states"),
        capability_terminal_states: serde_json::from_value(
            filters["capabilityTerminalStates"].clone(),
        )
        .expect("validated Usage terminal states"),
        order_by: usage_order_by(&message["orderBy"]),
        cursor: message["cursor"].as_str().map(str::to_owned),
        limit: u16::try_from(message["limit"].as_u64().expect("validated Usage limit"))
            .expect("validated Usage limit fits u16"),
        now_unix_ms: message["nowUnixMs"]
            .as_str()
            .expect("validated Usage clock")
            .parse()
            .expect("validated Usage clock fits u64"),
        quiescence_seconds: u32::try_from(
            message["quiescenceSeconds"]
                .as_u64()
                .expect("validated Usage quiescence"),
        )
        .expect("validated Usage quiescence fits u32"),
    }
}

fn activity_request(message: &Value) -> ActivityRequest {
    let filters = &message["filters"];
    ActivityRequest {
        window: ActivityWindow {
            observed_at_or_after: message["window"]["observedAtOrAfter"]
                .as_str()
                .expect("validated Activity window start")
                .to_owned(),
            observed_before: message["window"]["observedBefore"]
                .as_str()
                .expect("validated Activity window end")
                .to_owned(),
        },
        providers: serde_json::from_value(filters["providers"].clone())
            .expect("validated Activity providers"),
        project_keys: serde_json::from_value(filters["projectKeys"].clone())
            .expect("validated Activity project keys"),
        closure_states: serde_json::from_value(filters["closureStates"].clone())
            .expect("validated Activity closure states"),
        bucket: serde_json::from_value(message["bucket"].clone())
            .expect("validated Activity bucket"),
        time_zone: message["timeZone"]
            .as_str()
            .expect("validated Activity time zone")
            .to_owned(),
        now_unix_ms: message["nowUnixMs"]
            .as_str()
            .expect("validated Activity clock")
            .parse()
            .expect("validated Activity clock fits u64"),
        quiescence_seconds: u32::try_from(
            message["quiescenceSeconds"]
                .as_u64()
                .expect("validated Activity quiescence"),
        )
        .expect("validated Activity quiescence fits u32"),
    }
}

fn evidence_paths_wire(report: EvidencePathReport) -> Value {
    json!({
        "insufficientSample": report.insufficient_sample,
        "pathsTruncated": report.paths_truncated,
        "rawMatchCount": report.raw_match_count,
        "eligibleTurnCount": report.eligible_turn_count,
        "rawSessionCount": report.raw_session_count,
        "independentGroupCount": report.independent_group_count,
        "strongGroupCount": report.strong_group_count,
        "weakGroupCount": report.weak_group_count,
        "observedEofProvisionalGroupCount": report.observed_eof_provisional_group_count,
        "unknownDedupeCount": report.unknown_dedupe_count,
        "unknownDedupeSessionCount": report.unknown_dedupe_session_count,
        "families": report.families.into_iter().map(|family| json!({
            "fingerprint": family.fingerprint,
            "nodes": family.nodes.into_iter().map(|node| json!({
                "providerScopedName": node.provider_scoped_name,
                "repeatBucket": node.repeat_bucket.as_str(),
            })).collect::<Vec<_>>(),
            "truncated": family.truncated,
            "bestRelevancePpm": family.best_relevance_ppm,
            "turnCount": family.turn_count,
            "rawSessionCount": family.raw_session_count,
            "independentGroupCount": family.independent_group_count,
            "strongGroupCount": family.strong_group_count,
            "weakGroupCount": family.weak_group_count,
            "observedEofProvisionalGroupCount": family.observed_eof_provisional_group_count,
            "unknownDedupeSessionCount": family.unknown_dedupe_session_count,
            "latestUnixMs": family.latest_unix_ms,
            "toolStateCounts": family.tool_state_counts,
            "evidenceTurnKeys": family.evidence_turn_keys,
        })).collect::<Vec<_>>(),
    })
}

fn search_results_wire(
    request_id: &str,
    database_uuid: &str,
    response: SearchResponse,
    trace: SearchTrace,
) -> Value {
    let results = response
        .results
        .into_iter()
        .map(|result| {
            let dedupe = result.dedupe;
            let score = result.bm25_rank.map_or(Value::Null, |rank| {
                json!({
                    "relevancePpm": result.relevance_ppm,
                    "bm25Rank": rank,
                    "rankComponentPpm": result.rank_component_ppm,
                    "idfCoveragePpm": result.coverage_ppm,
                    "exact": result.exact,
                    "matchedTermIndexes": result.matched_term_indexes,
                })
            });
            let mut wire = json!({
                "turnKey": result.turn_key,
                "sessionKey": result.session_key,
                "revision": result.revision,
                "provider": result.provider,
                "projectKey": result.project_key,
                "observedTimestamp": result.observed_timestamp,
                "problemExcerpt": result.problem_summary,
                "problemTruncated": result.problem_truncated,
                "finalAnswerExcerpt": result.final_summary,
                "finalAnswerTruncated": result.final_truncated,
                "closureState": result.closure,
                "resultEvidence": result.result_evidence,
                "score": score,
            });
            if let Some(dedupe) = dedupe {
                wire["dedupe"] = json!(dedupe);
            }
            wire
        })
        .collect::<Vec<_>>();
    json!({
        "format": PROTOCOL_FORMAT,
        "type": "TURN_SEARCH_RESULTS",
        "requestId": request_id,
        "databaseUuid": database_uuid,
        "orderBy": response.order_by,
        "totalMatchCount": response.total_match_count,
        "closureEvaluatedAt": response.closure_evaluated_at,
        "quiescenceSeconds": response.quiescence_seconds,
        "snapshot": {
            "snapshotSeq": response.snapshot_seq,
            "projectionVersion": response.projection_version,
            "analyzerVersion": response.analyzer_version,
            "rankerVersion": response.ranker_version,
        },
        "scoringTerms": response.scoring_terms,
        "results": results,
        "evidencePaths": evidence_paths_wire(response.evidence_paths),
        "diagnostic": response.diagnostic,
        "searchTrace": {
            "candidateCount": trace.candidate_count,
            "candidateTurnKeys": trace.candidate_turn_keys,
        },
    })
}

fn evidence_event_wire(event: SafeEvidenceEvent) -> Value {
    json!({
        "eventKey": event.event_key,
        "occurredTurnKey": event.occurred_turn_key,
        "linkedTurns": event.linked_turns,
        "pointerKind": event.pointer_kind,
        "pointerContentIndex": event.pointer_content_index,
        "pointerEventOrdinal": event.pointer_event_ordinal,
        "originScope": event.origin_scope,
        "observedTimestamp": event.observed_timestamp,
        "payload": event.payload,
    })
}

fn evidence_page_wire(request_id: &str, database_uuid: &str, page: TurnEvidencePage) -> Value {
    let entries = page
        .entries
        .into_iter()
        .map(|entry| match entry {
            SafeEvidenceFact::Event(event) => json!({
                "factKind": "event",
                "fact": evidence_event_wire(event),
            }),
            SafeEvidenceFact::CapabilityUse(usage) => json!({
                "factKind": "capability-use",
                "fact": usage,
            }),
        })
        .collect::<Vec<_>>();
    json!({
        "format": PROTOCOL_FORMAT,
        "type": "TURN_EVIDENCE_PAGE",
        "requestId": request_id,
        "databaseUuid": database_uuid,
        "snapshotSeq": page.snapshot_seq,
        "turn": page.turn,
        "entries": entries,
        "nextCursor": page.next_cursor,
    })
}

fn capability_usage_wire(
    request_id: &str,
    database_uuid: &str,
    order_by: &Value,
    response: UsageResponse,
) -> Value {
    json!({
        "format": PROTOCOL_FORMAT,
        "type": "CAPABILITY_USAGE",
        "requestId": request_id,
        "databaseUuid": database_uuid,
        "snapshotSeq": response.snapshot_seq,
        "closureEvaluatedAt": response.closure_evaluated_at,
        "quiescenceSeconds": response.quiescence_seconds,
        "orderBy": order_by,
        "items": response.items,
        "totalCandidateCount": response.total_candidate_count,
        "truncated": response.truncated,
        "coverage": response.coverage,
        "nextCursor": response.next_cursor,
    })
}

fn insights_activity_wire(
    request_id: &str,
    database_uuid: &str,
    response: ActivityResponse,
) -> Value {
    json!({
        "format": PROTOCOL_FORMAT,
        "type": "INSIGHTS_ACTIVITY",
        "requestId": request_id,
        "databaseUuid": database_uuid,
        "snapshotSeq": response.snapshot_seq,
        "closureEvaluatedAt": response.closure_evaluated_at,
        "quiescenceSeconds": response.quiescence_seconds,
        "buckets": response.buckets,
        "coverage": {
            "excludedUndatedInvocationCount": response.coverage.excluded_undated_invocation_count,
            "excludedUndatedTurnCount": response.coverage.excluded_undated_turn_count,
            "excludedUnrevisionedInvocationCount": response.coverage.excluded_unrevisioned_invocation_count,
            "excludedUnrevisionedTurnCount": response.coverage.excluded_unrevisioned_turn_count,
        },
    })
}

impl EngineServer {
    fn new(mut storage: EngineStorage) -> Result<Self, EngineError> {
        storage.verify_sqlite_contract()?;
        storage.maintain_search_projection(16)?;
        let database_uuid = storage.database_uuid()?;
        Ok(Self {
            storage,
            database_uuid,
            state: State::AwaitHello,
        })
    }

    fn handle_message(&mut self, message: Value) -> Result<Value, EngineError> {
        let kind = validate_protocol_message(&message)?;
        let state = std::mem::replace(&mut self.state, State::AwaitHello);
        match state {
            State::AwaitHello => {
                let result = (|| {
                    if kind != MessageKind::Hello {
                        return Err(EngineError::new(
                            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                            "protocol",
                            "the first frame must be HELLO",
                        ));
                    }
                    let request_id = request_id(&message)?.to_owned();
                    let accepted_contract = accepted_contract_from_hello(&message)?;
                    let response =
                        ready_message(&self.storage, &request_id, accepted_contract.clone())?;
                    Ok((State::Ready { accepted_contract }, response))
                })();
                match result {
                    Ok((state, response)) => {
                        self.state = state;
                        Ok(response)
                    }
                    Err(error) => {
                        self.state = State::AwaitHello;
                        Err(fatal(error))
                    }
                }
            }
            State::Ready { accepted_contract } => {
                let result = (|| {
                    let request_id = request_id(&message)?.to_owned();
                    match kind {
                        MessageKind::BeginSession => {
                            validate_begin_against_contract(&message, &accepted_contract)?;
                            let session_key = message["session"]["sessionKey"].clone();
                            let delta_id = message["deltaId"].clone();
                            let accumulator = SessionAccumulator::begin(message)?;
                            self.storage.clear_session_fact_staging()?;
                            Ok((
                                State::InSession {
                                    accepted_contract: accepted_contract.clone(),
                                    accumulator,
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "SESSION_ACCEPTED",
                                    "requestId": request_id,
                                    "sessionKey": session_key,
                                    "deltaId": delta_id,
                                    "nextSequence": "0",
                                }),
                            ))
                        }
                        MessageKind::BeginTraceSource => {
                            let repository_key = message["repository"]["repositoryKey"].clone();
                            let delta_id = message["deltaId"].clone();
                            let accumulator = Box::new(TraceSourceAccumulator::begin(message)?);
                            self.storage.clear_trace_source_staging()?;
                            Ok((
                                State::InTraceSource {
                                    accepted_contract: accepted_contract.clone(),
                                    accumulator,
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "TRACE_SOURCE_ACCEPTED",
                                    "requestId": request_id,
                                    "repositoryKey": repository_key,
                                    "deltaId": delta_id,
                                    "nextSequence": "0",
                                }),
                            ))
                        }
                        MessageKind::ReadRepositoryState => {
                            let repository_id = message["repositoryId"]
                                .as_str()
                                .expect("validated repositoryId");
                            let page = self.storage.repository_state_page(
                                repository_id,
                                message["cursor"].as_str(),
                                message["limit"].as_u64().expect("validated limit") as usize,
                            )?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "REPOSITORY_STATE",
                                    "requestId": request_id,
                                    "repositoryId": repository_id,
                                    "generation": page.generation,
                                    "available": page.available,
                                    "refDigest": page.ref_digest,
                                    "intentRevision": page.intent_revision,
                                    "coverageAfter": page.coverage_after,
                                    "refs": page.refs,
                                    "nextCursor": page.next_cursor,
                                }),
                            ))
                        }
                        MessageKind::ReadEngineStatus => {
                            self.storage.maintain_search_projection(16)?;
                            let status = self.storage.read_engine_status()?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "ENGINE_STATUS",
                                    "requestId": request_id,
                                    "snapshotSeq": status.snapshot_seq,
                                    "snapshotAgeMs": status.snapshot_age_ms,
                                    "snapshotPending": status.snapshot_pending,
                                    "factStorageProfile": status.fact_storage_profile,
                                    "projections": status.projections,
                                    "changeLog": status.change_log,
                                    "purge": status.purge,
                                    "storage": status.storage,
                                    "integrity": status.integrity,
                                }),
                            ))
                        }
                        MessageKind::ReadInsightsOverview => {
                            let overview = self
                                .storage
                                .read_insights_overview(InsightsOverviewRequest {
                                    now_unix_ms: message["nowUnixMs"]
                                        .as_str()
                                        .expect("validated overview time")
                                        .parse()
                                        .expect("validated overview time fits u64"),
                                    quiescence_seconds: u32::try_from(
                                        message["quiescenceSeconds"]
                                            .as_u64()
                                            .expect("validated overview quiescence"),
                                    )
                                    .expect("validated overview quiescence fits u32"),
                                })
                                .map_err(dashboard_storage_error)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "INSIGHTS_OVERVIEW",
                                    "requestId": request_id,
                                    "databaseUuid": self.database_uuid,
                                    "snapshotSeq": overview.snapshot_seq,
                                    "sessions": overview.sessions,
                                    "scopes": overview.scopes,
                                    "dedupe": overview.dedupe,
                                    "turns": overview.turns,
                                    "capabilities": overview.capabilities,
                                    "providers": overview.providers,
                                    "projects": overview.projects,
                                    "coverage": overview.coverage,
                                    "diagnostics": overview.diagnostics,
                                }),
                            ))
                        }
                        MessageKind::ListCapabilities => {
                            let kind = match message["kind"]
                                .as_str()
                                .expect("validated capability kind")
                            {
                                "tool" => CapabilityListKind::Tool,
                                "skill" => CapabilityListKind::Skill,
                                _ => unreachable!("protocol validated capability kind"),
                            };
                            let page = self
                                .storage
                                .list_capabilities(CapabilityPageRequest {
                                    kind,
                                    cursor: message["cursor"].as_str().map(str::to_owned),
                                    limit: u16::try_from(
                                        message["limit"]
                                            .as_u64()
                                            .expect("validated capability limit"),
                                    )
                                    .expect("validated capability limit fits u16"),
                                })
                                .map_err(dashboard_storage_error)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "CAPABILITY_PAGE",
                                    "requestId": request_id,
                                    "databaseUuid": self.database_uuid,
                                    "snapshotSeq": page.snapshot_seq,
                                    "items": page.items,
                                    "nextCursor": page.next_cursor,
                                    "coverage": page.coverage,
                                }),
                            ))
                        }
                        MessageKind::ListSourceStates => {
                            let cursor = if message["cursor"].is_null() {
                                None
                            } else {
                                Some(serde_json::from_value(message["cursor"].clone()).map_err(
                                    |_| {
                                        EngineError::new(
                                            "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
                                            "protocol",
                                            "LIST_SOURCE_STATES cursor is invalid",
                                        )
                                    },
                                )?)
                            };
                            let limit = u16::try_from(
                                message["limit"]
                                    .as_u64()
                                    .expect("validated source-state limit"),
                            )
                            .expect("validated source-state limit fits u16");
                            let page = self.storage.list_source_states(cursor, limit)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "SOURCE_STATES",
                                    "requestId": request_id,
                                    "states": page.states,
                                    "nextCursor": page.next_cursor,
                                }),
                            ))
                        }
                        MessageKind::ReadSourceCheckpoint => {
                            let session_key = serde_json::from_value(message["sessionKey"].clone())
                                .map_err(|_| {
                                    EngineError::new(
                                        "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
                                        "protocol",
                                        "READ_SOURCE_CHECKPOINT sessionKey is invalid",
                                    )
                                })?;
                            let checkpoint = self.storage.read_source_checkpoint(session_key)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "SOURCE_CHECKPOINT",
                                    "requestId": request_id,
                                    "sessionKey": message["sessionKey"],
                                    "checkpoint": checkpoint,
                                }),
                            ))
                        }
                        MessageKind::RemoveSource => {
                            let session_key = serde_json::from_value(message["sessionKey"].clone())
                                .map_err(|_| {
                                    EngineError::new(
                                        "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
                                        "protocol",
                                        "REMOVE_SOURCE sessionKey is invalid",
                                    )
                                })?;
                            let outcome = self.storage.remove_source(session_key)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "SOURCE_REMOVED",
                                    "requestId": request_id,
                                    "sessionKey": outcome.session_key,
                                    "removed": outcome.removed,
                                }),
                            ))
                        }
                        MessageKind::ExcludeSource => {
                            let session_key = serde_json::from_value(message["sessionKey"].clone())
                                .map_err(|_| {
                                    EngineError::new(
                                        "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
                                        "protocol",
                                        "EXCLUDE_SOURCE sessionKey is invalid",
                                    )
                                })?;
                            let outcome = self.storage.exclude_source(session_key)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "SOURCE_EXCLUDED",
                                    "requestId": request_id,
                                    "sessionKey": outcome.session_key,
                                    "excluded": outcome.excluded,
                                    "purgeState": outcome.purge_state,
                                }),
                            ))
                        }
                        MessageKind::ReadPurgeStatus => {
                            let session_key = if message["sessionKey"].is_null() {
                                None
                            } else {
                                Some(
                                    serde_json::from_value(message["sessionKey"].clone()).map_err(
                                        |_| {
                                            EngineError::new(
                                                "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
                                                "protocol",
                                                "READ_PURGE_STATUS sessionKey is invalid",
                                            )
                                        },
                                    )?,
                                )
                            };
                            let status = self.storage.read_purge_status(session_key)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "PURGE_STATUS",
                                    "requestId": request_id,
                                    "sessionKey": message["sessionKey"],
                                    "state": status.state,
                                    "pendingFacts": status.pending_facts,
                                    "pendingMaintenance": status.pending_maintenance,
                                    "purged": status.purged,
                                }),
                            ))
                        }
                        MessageKind::RunPurgeMaintenance => {
                            let limit = u16::try_from(
                                message["limit"]
                                    .as_u64()
                                    .expect("validated purge maintenance limit"),
                            )
                            .expect("validated purge maintenance limit fits u16");
                            let outcome = self.storage.run_purge_maintenance(limit)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "PURGE_MAINTENANCE_STATUS",
                                    "requestId": request_id,
                                    "processedSessions": outcome.processed_sessions,
                                    "purgedSessions": outcome.purged_sessions,
                                    "state": outcome.status.state,
                                    "pendingFacts": outcome.status.pending_facts,
                                    "pendingMaintenance": outcome.status.pending_maintenance,
                                    "purged": outcome.status.purged,
                                }),
                            ))
                        }
                        MessageKind::SearchTurns => {
                            let (response, trace) = self
                                .storage
                                .search_with_trace(search_request(&message))
                                .map_err(query_engine_error)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                search_results_wire(
                                    &request_id,
                                    &self.database_uuid,
                                    response,
                                    trace,
                                ),
                            ))
                        }
                        MessageKind::ReadCapabilityUsage => {
                            let response = self
                                .storage
                                .read_capability_usage(&capability_usage_request(&message))
                                .map_err(agent_query_engine_error)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                capability_usage_wire(
                                    &request_id,
                                    &self.database_uuid,
                                    &message["orderBy"],
                                    response,
                                ),
                            ))
                        }
                        MessageKind::ReadInsightsActivity => {
                            let response = self
                                .storage
                                .read_insights_activity(&activity_request(&message))
                                .map_err(agent_query_engine_error)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                insights_activity_wire(&request_id, &self.database_uuid, response),
                            ))
                        }
                        MessageKind::ReadTurnEvidence => {
                            let turn_key = message["turnKey"].as_str().expect("validated turn key");
                            let expected_revision = message["expectedRevision"]
                                .as_str()
                                .expect("validated expected revision");
                            let cursor = message["cursor"].as_str();
                            let limit = u16::try_from(
                                message["limit"].as_u64().expect("validated evidence limit"),
                            )
                            .expect("validated evidence limit fits u16");
                            let page = self
                                .storage
                                .read_turn_evidence(
                                    turn_key,
                                    Some(expected_revision),
                                    cursor,
                                    limit,
                                )
                                .map_err(query_engine_error)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                evidence_page_wire(&request_id, &self.database_uuid, page),
                            ))
                        }
                        MessageKind::ReadInsightsQueryV2 => {
                            let request: DeepQueryRequest = serde_json::from_value(
                                message["request"].clone(),
                            )
                            .map_err(|_| {
                                EngineError::new(
                                    "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
                                    "protocol",
                                    "READ_INSIGHTS_QUERY_V2 request is invalid",
                                )
                            })?;
                            let response = self
                                .storage
                                .read_deep_query(&request)
                                .map_err(deep_query_engine_error)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "INSIGHTS_QUERY_V2",
                                    "requestId": request_id,
                                    "response": response,
                                }),
                            ))
                        }
                        MessageKind::ReadInsightsEvidenceV2 => {
                            let request: DeepEvidenceRequest = serde_json::from_value(
                                message["request"].clone(),
                            )
                            .map_err(|_| {
                                EngineError::new(
                                    "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
                                    "protocol",
                                    "READ_INSIGHTS_EVIDENCE_V2 request is invalid",
                                )
                            })?;
                            let response = self
                                .storage
                                .read_deep_evidence(&request)
                                .map_err(deep_query_engine_error)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "INSIGHTS_EVIDENCE_V2",
                                    "requestId": request_id,
                                    "response": response,
                                }),
                            ))
                        }
                        MessageKind::ReadInsightsRecipe => {
                            let request: RecipeRequest = serde_json::from_value(
                                message["request"].clone(),
                            )
                            .map_err(|_| {
                                EngineError::new(
                                    "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
                                    "protocol",
                                    "READ_INSIGHTS_RECIPE request is invalid",
                                )
                            })?;
                            let response = self
                                .storage
                                .read_recipe(&request)
                                .map_err(deep_query_engine_error)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "INSIGHTS_RECIPE",
                                    "requestId": request_id,
                                    "response": response,
                                }),
                            ))
                        }
                        MessageKind::ReadInsightsDeliveryTrace => {
                            let request: DeliveryTraceRequest = serde_json::from_value(
                                message["request"].clone(),
                            )
                            .map_err(|_| {
                                EngineError::new(
                                    "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
                                    "protocol",
                                    "READ_INSIGHTS_DELIVERY_TRACE request is invalid",
                                )
                            })?;
                            let response = self
                                .storage
                                .read_delivery_trace(&self.database_uuid, &request)
                                .map_err(delivery_trace_engine_error)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "INSIGHTS_DELIVERY_TRACE",
                                    "requestId": request_id,
                                    "request": request,
                                    "response": response,
                                }),
                            ))
                        }
                        _ => Err(EngineError::new(
                            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                            "protocol",
                            "unexpected frame in READY state",
                        )),
                    }
                })();
                match result {
                    Ok((state, response)) => {
                        self.state = state;
                        Ok(response)
                    }
                    Err(error) => {
                        self.state = State::Ready { accepted_contract };
                        Err(error)
                    }
                }
            }
            State::InSession {
                accepted_contract,
                mut accumulator,
            } => {
                let result = (|| {
                    let message_request_id = request_id(&message)?;
                    if message_request_id != accumulator.request_id() {
                        return Err(EngineError::new(
                            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                            "protocol",
                            "session requestId does not match BEGIN_SESSION",
                        ));
                    }
                    match kind {
                        MessageKind::RetractFacts | MessageKind::UpsertFacts => {
                            accumulator.apply_batch(&message, &mut self.storage)?;
                            let sequence = message["sequence"].clone();
                            Ok((
                                State::InSession {
                                    accepted_contract: accepted_contract.clone(),
                                    accumulator,
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "BATCH_ACCEPTED",
                                    "requestId": message_request_id,
                                    "sequence": sequence,
                                }),
                            ))
                        }
                        MessageKind::CommitSession => {
                            let source_state = if message["sourceState"].is_null() {
                                None
                            } else {
                                Some(
                                    serde_json::from_value(message["sourceState"].clone())
                                        .map_err(|_| {
                                            EngineError::new(
                                                "TS_INSIGHTS_INVALID_SOURCE_STATE",
                                                "validation",
                                                "COMMIT_SESSION source state is invalid",
                                            )
                                        })?,
                                )
                            };
                            self.storage.stage_source_state(source_state);
                            let outcome = match accumulator.finish(&message, &mut self.storage) {
                                Ok(outcome) => outcome,
                                Err(error) => {
                                    self.storage.clear_staged_source_state();
                                    return Err(error);
                                }
                            };
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "SESSION_COMMITTED",
                                    "requestId": message_request_id,
                                    "sessionKey": outcome.session_key,
                                    "deltaId": outcome.delta_id,
                                    "snapshotSeq": outcome.snapshot_seq,
                                    "idempotent": outcome.idempotent,
                                }),
                            ))
                        }
                        MessageKind::AbortSession => {
                            let next_sequence = accumulator.next_sequence();
                            if message["nextSequence"].as_str() != Some(next_sequence.as_str()) {
                                return Err(EngineError::new(
                                    "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                                    "protocol",
                                    "ABORT_SESSION nextSequence does not match received batches",
                                ));
                            }
                            self.storage.clear_session_fact_staging()?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "SESSION_ABORTED",
                                    "requestId": message_request_id,
                                    "sessionKey": accumulator.session_key(),
                                    "deltaId": accumulator.delta_id(),
                                    "nextSequence": next_sequence,
                                }),
                            ))
                        }
                        _ => Err(EngineError::new(
                            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                            "protocol",
                            "unexpected frame during session ingestion",
                        )),
                    }
                })();
                match result {
                    Ok((state, response)) => {
                        self.state = state;
                        Ok(response)
                    }
                    Err(error) => {
                        let _ = self.storage.clear_session_fact_staging();
                        self.state = State::Ready { accepted_contract };
                        Err(error)
                    }
                }
            }
            State::InTraceSource {
                accepted_contract,
                mut accumulator,
            } => {
                let result = (|| {
                    let message_request_id = request_id(&message)?;
                    if message_request_id != accumulator.request_id() {
                        return Err(EngineError::new(
                            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                            "protocol",
                            "trace source requestId does not match BEGIN_TRACE_SOURCE",
                        ));
                    }
                    match kind {
                        MessageKind::TraceSourceBatch => {
                            accumulator.apply_batch(&message, &mut self.storage)?;
                            let sequence = message["sequence"].clone();
                            Ok((
                                State::InTraceSource {
                                    accepted_contract: accepted_contract.clone(),
                                    accumulator,
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "TRACE_SOURCE_BATCH_ACCEPTED",
                                    "requestId": message_request_id,
                                    "sequence": sequence,
                                }),
                            ))
                        }
                        MessageKind::CommitTraceSource => {
                            let outcome = accumulator.finish(&message, &mut self.storage)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "TRACE_SOURCE_COMMITTED",
                                    "requestId": message_request_id,
                                    "repositoryKey": outcome.session_key,
                                    "deltaId": outcome.delta_id,
                                    "snapshotSeq": outcome.snapshot_seq,
                                    "idempotent": outcome.idempotent,
                                }),
                            ))
                        }
                        MessageKind::AbortTraceSource => {
                            let next_sequence = accumulator.next_sequence();
                            if message["nextSequence"].as_str() != Some(next_sequence.as_str()) {
                                return Err(EngineError::new(
                                    "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                                    "protocol",
                                    "ABORT_TRACE_SOURCE nextSequence does not match received batches",
                                ));
                            }
                            self.storage.clear_trace_source_staging()?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "TRACE_SOURCE_ABORTED",
                                    "requestId": message_request_id,
                                    "repositoryKey": accumulator.repository_key(),
                                    "deltaId": accumulator.delta_id(),
                                    "nextSequence": next_sequence,
                                }),
                            ))
                        }
                        _ => Err(EngineError::new(
                            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                            "protocol",
                            "unexpected frame during trace source ingestion",
                        )),
                    }
                })();
                match result {
                    Ok((state, response)) => {
                        self.state = state;
                        Ok(response)
                    }
                    Err(error) => {
                        let _ = self.storage.clear_trace_source_staging();
                        self.state = State::Ready { accepted_contract };
                        Err(error)
                    }
                }
            }
        }
    }
}

#[derive(Debug, PartialEq, Eq)]
struct EngineArguments {
    show_version: bool,
    database: Option<PathBuf>,
    open_existing: bool,
}

fn parse_arguments_from(
    arguments: impl IntoIterator<Item = String>,
) -> Result<EngineArguments, String> {
    let mut version = false;
    let mut json_output = false;
    let mut database = None;
    let mut open_existing = false;
    let mut arguments = arguments.into_iter();
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--version" => version = true,
            "--json" => json_output = true,
            "--open-existing" => open_existing = true,
            "--db" => {
                let value = arguments.next().ok_or("--db requires a path")?;
                database = Some(PathBuf::from(value));
            }
            _ => return Err("unsupported Engine argument".to_owned()),
        }
    }
    if json_output && !version {
        return Err("--json requires --version".to_owned());
    }
    if open_existing && database.is_none() {
        return Err("--open-existing requires --db".to_owned());
    }
    Ok(EngineArguments {
        show_version: version,
        database,
        open_existing,
    })
}

fn parse_arguments() -> Result<EngineArguments, String> {
    parse_arguments_from(env::args().skip(1))
}

fn run_server_stream<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    storage: EngineStorage,
) -> Result<(), ProtocolError> {
    let mut server = EngineServer::new(storage).map_err(|error| {
        ProtocolError::new(error.code, "the bundled SQLite contract is invalid", true)
    })?;
    while let Some(message) = read_frame(reader)? {
        let message_request_id = request_id(&message).unwrap_or("0").to_owned();
        match server.handle_message(message) {
            Ok(response) => write_frame(writer, &response)?,
            Err(error) => {
                let fatal = error.fatal;
                write_frame(writer, &engine_error_response(&error, &message_request_id))?;
                if fatal {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

fn run_server(storage: EngineStorage) -> Result<(), ProtocolError> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    run_server_stream(&mut reader, &mut writer, storage)
}

fn report_storage_initialization_error(error: StorageError) -> Result<(), ProtocolError> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    let Some(message) = read_frame(&mut reader)? else {
        return Ok(());
    };
    let message_request_id = request_id(&message).unwrap_or("0").to_owned();
    let response = engine_error_response(&fatal(error.into()), &message_request_id);
    write_frame(&mut writer, &response)
}

fn main() {
    let arguments = match parse_arguments() {
        Ok(value) => value,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let storage = match (arguments.database, arguments.open_existing) {
        (Some(path), true) => EngineStorage::open_existing(&path),
        (Some(path), false) => EngineStorage::open(&path),
        (None, false) => EngineStorage::open_in_memory(),
        (None, true) => unreachable!("argument validation requires an existing database path"),
    };
    let storage = match storage {
        Ok(value) => value,
        Err(error) => {
            if !arguments.show_version {
                let _ = report_storage_initialization_error(error);
            }
            eprintln!("Insights Engine storage initialization failed");
            std::process::exit(1);
        }
    };
    if arguments.show_version {
        match version_document(&storage) {
            Ok(value) => println!("{}", canonical_json(&value)),
            Err(_) => {
                eprintln!("Insights Engine version probe failed");
                std::process::exit(1);
            }
        }
        return;
    }
    if run_server(storage).is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{
        EngineServer, State, evidence_event_wire, evidence_paths_wire, parse_arguments_from,
        query_engine_error, search_request, search_results_wire, usage_order_by,
        validate_protocol_message,
    };
    use serde::Deserialize;
    use serde_json::{Value, json};
    use sha2::{Digest, Sha256};
    use std::fs;
    use std::path::PathBuf;
    use threadshare_insights_engine::agent_query::UsageOrderBy;
    use threadshare_insights_engine::delivery_graph_repository::RepositoryDelta;
    use threadshare_insights_engine::evidence_path::{
        DedupeConfidence, EvidenceLink, EvidencePathFamily, EvidencePathReport, PathNode,
        RepeatBucket, SafeEventPayload, SafeEvidenceEvent, ToolStateCounts,
    };
    use threadshare_insights_engine::fact_model::CapabilityTerminalState;
    use threadshare_insights_engine::query::{
        ClosureFilter, QueryDiagnostic, QueryError, ResultEvidenceFilter, SearchDedupe,
        SearchOrderBy, SearchResponse, SearchResult, SearchTrace,
    };
    use threadshare_insights_engine::storage::EngineStorage;
    use threadshare_insights_engine::trace_staging::{TraceSourceCounts, TraceSourceMetadata};
    use threadshare_insights_engine::{canonical_json, hash_key};

    #[derive(Deserialize)]
    struct Fixture {
        frames: Vec<FrameVector>,
    }

    #[derive(Deserialize)]
    struct FrameVector {
        name: String,
        message: Value,
    }

    fn message(name: &str) -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/insights-protocol-v1/frames.json");
        let fixture: Fixture = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        fixture
            .frames
            .into_iter()
            .find(|frame| frame.name == name)
            .unwrap()
            .message
    }

    fn server() -> EngineServer {
        EngineServer::new(EngineStorage::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn open_existing_argument_requires_and_preserves_the_database_path() {
        let database = PathBuf::from("/existing/insights.sqlite3");
        let arguments = parse_arguments_from([
            "--db".to_owned(),
            database.to_string_lossy().into_owned(),
            "--open-existing".to_owned(),
        ])
        .unwrap();
        assert_eq!(arguments.database, Some(database));
        assert!(arguments.open_existing);

        assert_eq!(
            parse_arguments_from(["--open-existing".to_owned()]).unwrap_err(),
            "--open-existing requires --db"
        );
    }

    fn large_session_delta() -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/insights-fact-mutations/v1-basic.json");
        let fixture: Value = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        let mut delta = fixture["initial"].clone();
        let template = delta["turns"][0].clone();
        let problem_text = "x".repeat(64 * 1_024);
        let mut turns = Vec::with_capacity(513);
        for index in 0..513 {
            let mut turn = template.clone();
            if index > 0 {
                turn["turnKey"] = Value::String(format!("{index:064x}"));
            }
            turn["turnStartOffset"] = Value::String(index.to_string());
            turn["problemText"] = Value::String(problem_text.clone());
            turns.push(turn);
        }
        delta["turns"] = Value::Array(turns);
        let mut mutation = delta.clone();
        mutation.as_object_mut().unwrap().remove("deltaId");
        let mutation_digest = Sha256::digest(canonical_json(&mutation).as_bytes()).to_vec();
        let root = delta.as_object().unwrap();
        let session_key = hex::decode(root["session"]["sessionKey"].as_str().unwrap()).unwrap();
        let expected = hash_key(
            "delta",
            &[
                session_key,
                root["expectedGeneration"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
                    .to_vec(),
                root["mode"].as_str().unwrap().as_bytes().to_vec(),
                root["originSecretEpoch"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
                    .to_vec(),
                root["duplicatePolicyVersion"]
                    .as_u64()
                    .unwrap()
                    .to_string()
                    .into_bytes(),
                mutation_digest,
                root["checkpoint"]["completeOffset"]
                    .as_str()
                    .unwrap()
                    .as_bytes()
                    .to_vec(),
            ],
        );
        delta["deltaId"] = Value::String(expected);
        delta
    }

    fn ingest_delta(server: &mut EngineServer, delta: &Value) -> Value {
        server.handle_message(message("hello")).unwrap();
        let template = message("begin-session");
        let mut counts = serde_json::Map::new();
        for collection in ["turnKeys", "orphanEventKeys", "authoritativeTurnKeys"] {
            counts.insert(
                collection.to_owned(),
                Value::String(
                    delta["retractions"][collection]
                        .as_array()
                        .unwrap()
                        .len()
                        .to_string(),
                ),
            );
        }
        for collection in threadshare_insights_engine::engine::UPSERT_COLLECTIONS {
            counts.insert(
                collection.to_owned(),
                Value::String(delta[collection].as_array().unwrap().len().to_string()),
            );
        }
        let begin = json!({
            "format": "threadshare-insights-protocol@v1",
            "type": "BEGIN_SESSION",
            "requestId": "2",
            "deltaFormat": delta["format"],
            "session": delta["session"],
            "deltaId": delta["deltaId"],
            "mode": delta["mode"],
            "expectedGeneration": delta["expectedGeneration"],
            "targetGeneration": delta["targetGeneration"],
            "contract": template["contract"],
            "counts": counts,
        });
        server.handle_message(begin).unwrap();

        let mut sequence = 0_u64;
        for (message_type, container, collections) in [
            (
                "RETRACT_FACTS",
                &delta["retractions"],
                &threadshare_insights_engine::engine::RETRACTION_COLLECTIONS[..],
            ),
            (
                "UPSERT_FACTS",
                delta,
                &threadshare_insights_engine::engine::UPSERT_COLLECTIONS[..],
            ),
        ] {
            for collection in collections {
                let items = container[*collection].as_array().unwrap();
                for chunk in items.chunks(32) {
                    server
                        .handle_message(json!({
                            "format": "threadshare-insights-protocol@v1",
                            "type": message_type,
                            "requestId": "2",
                            "sequence": sequence.to_string(),
                            "collection": collection,
                            "items": chunk,
                        }))
                        .unwrap();
                    sequence += 1;
                }
            }
        }
        server
            .handle_message(json!({
                "format": "threadshare-insights-protocol@v1",
                "type": "COMMIT_SESSION",
                "requestId": "2",
                "nextSequence": sequence.to_string(),
                "checkpoint": delta["checkpoint"],
                "diagnostics": delta["diagnostics"],
                "coverage": delta["coverage"],
                "sourceState": null,
            }))
            .unwrap()
    }

    #[test]
    fn handshake_contract_is_preserved_and_begin_must_match_it() {
        let mut server = server();
        let ready = server.handle_message(message("hello")).unwrap();
        assert_eq!(ready["type"], "READY");

        let mut incompatible = message("begin-session");
        incompatible["contract"]["originSecretEpoch"] =
            Value::String("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".to_owned());
        let error = server.handle_message(incompatible).unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_PROTOCOL_CONTRACT_UNSUPPORTED");
        assert!(matches!(server.state, State::Ready { .. }));

        let accepted = server.handle_message(message("begin-session")).unwrap();
        assert_eq!(accepted["type"], "SESSION_ACCEPTED");
    }

    #[test]
    fn engine_status_is_content_free_and_keeps_the_server_ready() {
        let mut server = server();
        server.handle_message(message("hello")).unwrap();
        let response = server
            .handle_message(json!({
                "format": "threadshare-insights-protocol@v1",
                "type": "READ_ENGINE_STATUS",
                "requestId": "2",
            }))
            .unwrap();

        assert_eq!(response["type"], "ENGINE_STATUS");
        assert_eq!(response["snapshotSeq"], "0");
        assert_eq!(response["snapshotAgeMs"], Value::Null);
        assert_eq!(response["snapshotPending"], true);
        assert_eq!(response["factStorageProfile"], "normalized-row-v1");
        assert_eq!(response["integrity"]["quickCheck"], "ok");
        assert_eq!(response["integrity"]["fts"], "ok");
        assert!(response.get("sessions").is_none());
        assert!(response.get("facts").is_none());
        assert!(matches!(server.state, State::Ready { .. }));
    }

    #[test]
    fn dashboard_overview_and_capability_page_are_ready_state_reads() {
        let mut server = server();
        server.handle_message(message("hello")).unwrap();

        let overview = server
            .handle_message(json!({
                "format": "threadshare-insights-protocol@v1",
                "type": "READ_INSIGHTS_OVERVIEW",
                "requestId": "51",
                "nowUnixMs": "1786320000000",
                "quiescenceSeconds": 300,
            }))
            .unwrap();
        assert_eq!(overview["type"], "INSIGHTS_OVERVIEW");
        assert_eq!(overview["snapshotSeq"], "0");
        let database_uuid = overview["databaseUuid"]
            .as_str()
            .expect("overview carries database generation identity")
            .to_owned();
        assert_eq!(overview["sessions"]["raw"], "0");
        validate_protocol_message(&overview).unwrap();
        assert!(matches!(server.state, State::Ready { .. }));

        let page = server
            .handle_message(json!({
                "format": "threadshare-insights-protocol@v1",
                "type": "LIST_CAPABILITIES",
                "requestId": "52",
                "kind": "tool",
                "cursor": null,
                "limit": 20,
            }))
            .unwrap();
        assert_eq!(page["type"], "CAPABILITY_PAGE");
        assert_eq!(page["snapshotSeq"], "0");
        assert_eq!(page["databaseUuid"], database_uuid);
        assert_eq!(page["items"], json!([]));
        assert_eq!(page["coverage"]["fullyExcludedCapabilityCount"], "0");
        validate_protocol_message(&page).unwrap();
        assert!(matches!(server.state, State::Ready { .. }));
    }

    #[test]
    fn usage_and_activity_are_bounded_ready_state_reads() {
        assert_eq!(
            usage_order_by(&json!("last-used")),
            UsageOrderBy::LastUsedAt
        );
        assert_eq!(
            usage_order_by(&json!("distinct-dedupe-group-count")),
            UsageOrderBy::DistinctDedupeGroupCount
        );
        let mut server = server();
        server.handle_message(message("hello")).unwrap();

        let usage = server
            .handle_message(json!({
                "format": threadshare_insights_engine::protocol::PROTOCOL_FORMAT,
                "type": "READ_CAPABILITY_USAGE",
                "requestId": "61",
                "kind": "tool",
                "window": {
                    "observedAtOrAfterUnixMs": "1786320000000",
                    "observedBeforeUnixMs": "1786406400000"
                },
                "comparisonWindow": null,
                "filters": {
                    "providers": [], "projectKeys": [], "closureStates": [],
                    "capabilityTerminalStates": []
                },
                "orderBy": "last-used",
                "cursor": null,
                "limit": 50,
                "nowUnixMs": "1786406400000",
                "quiescenceSeconds": 300
            }))
            .unwrap();
        assert_eq!(usage["type"], "CAPABILITY_USAGE");
        assert_eq!(usage["orderBy"], "last-used");
        assert_eq!(usage["closureEvaluatedAt"], "2026-08-11T00:00:00.000Z");
        assert_eq!(usage["items"], json!([]));
        assert_eq!(usage["totalCandidateCount"], "0");
        validate_protocol_message(&usage).unwrap();
        assert!(matches!(server.state, State::Ready { .. }));

        let distinct_dedupe_usage = server
            .handle_message(json!({
                "format": threadshare_insights_engine::protocol::PROTOCOL_FORMAT,
                "type": "READ_CAPABILITY_USAGE",
                "requestId": "63",
                "kind": "tool",
                "window": {
                    "observedAtOrAfterUnixMs": "1786320000000",
                    "observedBeforeUnixMs": "1786406400000"
                },
                "comparisonWindow": null,
                "filters": {
                    "providers": [], "projectKeys": [], "closureStates": [],
                    "capabilityTerminalStates": []
                },
                "orderBy": "distinct-dedupe-group-count",
                "cursor": null,
                "limit": 50,
                "nowUnixMs": "1786406400000",
                "quiescenceSeconds": 300
            }))
            .unwrap();
        assert_eq!(
            distinct_dedupe_usage["orderBy"],
            "distinct-dedupe-group-count"
        );
        validate_protocol_message(&distinct_dedupe_usage).unwrap();
        assert!(matches!(server.state, State::Ready { .. }));

        for (request_id, project_key_count) in [("64", 17), ("65", 64)] {
            let project_keys = (0..project_key_count)
                .map(|index| format!("{index:064x}"))
                .collect::<Vec<_>>();
            let bounded_project_usage = server
                .handle_message(json!({
                    "format": threadshare_insights_engine::protocol::PROTOCOL_FORMAT,
                    "type": "READ_CAPABILITY_USAGE",
                    "requestId": request_id,
                    "kind": "tool",
                    "window": {
                        "observedAtOrAfterUnixMs": "1786320000000",
                        "observedBeforeUnixMs": "1786406400000"
                    },
                    "comparisonWindow": null,
                    "filters": {
                        "providers": [], "projectKeys": project_keys, "closureStates": [],
                        "capabilityTerminalStates": []
                    },
                    "orderBy": "recorded-invocation-count",
                    "cursor": null,
                    "limit": 50,
                    "nowUnixMs": "1786406400000",
                    "quiescenceSeconds": 300
                }))
                .unwrap();
            assert_eq!(bounded_project_usage["type"], "CAPABILITY_USAGE");
            validate_protocol_message(&bounded_project_usage).unwrap();
            assert!(matches!(server.state, State::Ready { .. }));
        }

        let activity = server
            .handle_message(json!({
                "format": threadshare_insights_engine::protocol::PROTOCOL_FORMAT,
                "type": "READ_INSIGHTS_ACTIVITY",
                "requestId": "62",
                "window": {
                    "observedAtOrAfter": "2026-08-10T00:00:00.000Z",
                    "observedBefore": "2026-08-11T00:00:00.000Z"
                },
                "filters": {"providers": [], "projectKeys": [], "closureStates": []},
                "bucket": "day",
                "timeZone": "UTC",
                "nowUnixMs": "1786406400000",
                "quiescenceSeconds": 300
            }))
            .unwrap();
        assert_eq!(activity["type"], "INSIGHTS_ACTIVITY");
        assert_eq!(activity["closureEvaluatedAt"], "2026-08-11T00:00:00.000Z");
        assert_eq!(activity["buckets"].as_array().unwrap().len(), 1);
        assert!(
            activity["coverage"]
                .get("fullyExcludedCapabilityCount")
                .is_none()
        );
        validate_protocol_message(&activity).unwrap();
        assert!(matches!(server.state, State::Ready { .. }));
    }

    #[test]
    fn deep_query_not_ready_is_structured_and_keeps_the_server_usable() {
        let mut server = server();
        server.handle_message(message("hello")).unwrap();
        let error = server
            .handle_message(json!({
                "format": threadshare_insights_engine::protocol::PROTOCOL_FORMAT,
                "type": "READ_INSIGHTS_QUERY_V2",
                "requestId": "70",
                "request": {
                    "format": "threadshare-insights-query-request@v2",
                    "resource": "event",
                    "where": {"field":"event.kind","op":"eq","value":"visible-message"},
                    "shape": {
                        "kind":"records",
                        "select":["eventKey"],
                        "payloadMode":"reference"
                    },
                    "orderBy":[
                        {"field":"observedAt","direction":"desc"},
                        {"field":"eventKey","direction":"asc"}
                    ],
                    "limit":20,
                    "cursor":null,
                    "count":"none",
                    "evaluatedAt":"2026-08-12T00:00:00.000Z"
                }
            }))
            .unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_QUERY_V2_NOT_READY");
        assert_eq!(error.category, "conflict");
        assert!(matches!(server.state, State::Ready { .. }));

        let status = server
            .handle_message(json!({
                "format": threadshare_insights_engine::protocol::PROTOCOL_FORMAT,
                "type": "READ_PURGE_STATUS",
                "requestId": "71",
                "sessionKey": null
            }))
            .unwrap();
        assert_eq!(status["type"], "PURGE_STATUS");
    }

    #[test]
    fn missing_delivery_trace_root_is_structured_and_keeps_the_server_usable() {
        let mut server = server();
        server.handle_message(message("hello")).unwrap();
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/insights-delivery-trace-golden.v1.json"
        ))
        .unwrap();
        let error = server
            .handle_message(json!({
                "format": threadshare_insights_engine::protocol::PROTOCOL_FORMAT,
                "type": "READ_INSIGHTS_DELIVERY_TRACE",
                "requestId": "72",
                "request": fixture["request"].clone()
            }))
            .unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_TRACE_NOT_FOUND");
        assert_eq!(error.category, "validation");
        assert!(matches!(server.state, State::Ready { .. }));

        let status = server
            .handle_message(json!({
                "format": threadshare_insights_engine::protocol::PROTOCOL_FORMAT,
                "type": "READ_PURGE_STATUS",
                "requestId": "73",
                "sessionKey": null
            }))
            .unwrap();
        assert_eq!(status["type"], "PURGE_STATUS");
    }

    #[test]
    fn search_and_evidence_requests_use_ready_state_with_content_free_errors() {
        let mut server = server();
        server.handle_message(message("hello")).unwrap();

        let mut search = message("search-turns");
        search["orderBy"] = json!("observed-desc");
        search["filters"]["capabilityTerminalStates"] = json!(["failed"]);
        search["filters"]["toolCapabilityKeys"] = json!(["1".repeat(64)]);
        let mapped = search_request(&search);
        assert_eq!(mapped.order_by, SearchOrderBy::ObservedDesc);
        assert_eq!(
            mapped.capability_terminal_states,
            vec![CapabilityTerminalState::Failed]
        );

        let response = server.handle_message(message("search-turns")).unwrap();
        assert_eq!(response["type"], "TURN_SEARCH_RESULTS");
        assert!(response["databaseUuid"].as_str().is_some());
        assert_eq!(response["orderBy"], "relevance");
        assert_eq!(response["totalMatchCount"], "0");
        assert_eq!(response["closureEvaluatedAt"], "2026-08-10T00:00:00.000Z");
        assert_eq!(response["quiescenceSeconds"], 300);
        assert_eq!(response["snapshot"]["projectionVersion"], 2);
        assert_eq!(response["snapshot"]["analyzerVersion"], 1);
        assert_eq!(response["snapshot"]["rankerVersion"], 1);
        assert_eq!(response["results"], json!([]));
        assert_eq!(response["searchTrace"]["candidateCount"], 0);
        assert_eq!(response["searchTrace"]["candidateTurnKeys"], json!([]));
        validate_protocol_message(&response).unwrap();
        assert!(matches!(server.state, State::Ready { .. }));

        let mut broad = message("search-turns");
        broad["query"] = Value::String(String::new());
        broad["filters"]["providers"] = json!([]);
        let error = server.handle_message(broad).unwrap_err();
        assert_eq!(error.code, "QUERY_TOO_BROAD");
        assert_eq!(
            error.message,
            "Search query requires more detail or a filter"
        );
        assert!(!error.fatal);
        assert!(matches!(server.state, State::Ready { .. }));

        let error = server
            .handle_message(message("read-turn-evidence"))
            .unwrap_err();
        assert_eq!(error.code, "TURN_NOT_FOUND");
        assert_eq!(error.message, "Turn was not found");
        assert!(!error.fatal);
        assert!(matches!(server.state, State::Ready { .. }));
    }

    #[test]
    fn query_wire_mapping_excludes_internal_identity_and_error_content() {
        let path = evidence_paths_wire(EvidencePathReport {
            insufficient_sample: false,
            paths_truncated: true,
            raw_match_count: 5,
            eligible_turn_count: 5,
            raw_session_count: 5,
            independent_group_count: 3,
            strong_group_count: 3,
            weak_group_count: 0,
            observed_eof_provisional_group_count: 0,
            unknown_dedupe_count: 0,
            unknown_dedupe_session_count: 0,
            families: vec![EvidencePathFamily {
                fingerprint: "1".repeat(64),
                nodes: vec![PathNode {
                    capability_key: "2".repeat(64),
                    provider_scoped_name: "codex:Bash".to_owned(),
                    repeat_bucket: RepeatBucket::One,
                }],
                truncated: false,
                best_relevance_ppm: 900_000,
                turn_count: 5,
                raw_session_count: 3,
                independent_group_count: 3,
                strong_group_count: 3,
                weak_group_count: 0,
                observed_eof_provisional_group_count: 0,
                unknown_dedupe_session_count: 0,
                latest_unix_ms: 1_786_320_000_000,
                tool_state_counts: ToolStateCounts::default(),
                evidence_turn_keys: vec!["3".repeat(64)],
            }],
        });
        assert_eq!(path["pathsTruncated"], true);
        assert!(
            path["families"][0]["nodes"][0]
                .get("capabilityKey")
                .is_none()
        );
        assert_eq!(path["families"][0]["nodes"][0]["repeatBucket"], "1");

        let dedupe_group_key = "4".repeat(64);
        let turn_key = "5".repeat(64);
        let search = search_results_wire(
            "71",
            "11111111-1111-4111-8111-111111111111",
            SearchResponse {
                snapshot_seq: "3".to_owned(),
                projection_version: 2,
                analyzer_version: 1,
                ranker_version: 1,
                order_by: SearchOrderBy::Relevance,
                closure_evaluated_at: "2026-08-11T00:00:00.000Z".to_owned(),
                quiescence_seconds: 300,
                total_match_count: "7".to_owned(),
                scoring_terms: Vec::new(),
                results: vec![SearchResult {
                    turn_key: turn_key.clone(),
                    session_key: "6".repeat(64),
                    revision: "7".repeat(64),
                    provider: "codex".to_owned(),
                    project_key: None,
                    observed_timestamp: "2026-08-10T01:00:00.000Z".to_owned(),
                    closure: ClosureFilter::HardSealed,
                    result_evidence: ResultEvidenceFilter::ProviderCompleted,
                    problem_summary: "bounded problem".to_owned(),
                    problem_truncated: false,
                    final_summary: Some("bounded answer".to_owned()),
                    final_truncated: false,
                    dedupe: Some(SearchDedupe {
                        duplicate_group_key: dedupe_group_key.clone(),
                        confidence: DedupeConfidence::Strong,
                        observed_eof_provisional: true,
                    }),
                    bm25_rank: Some(1),
                    rank_component_ppm: 900_000,
                    matched_field_terms: Vec::new(),
                    matched_term_indexes: Vec::new(),
                    coverage_ppm: 1_000_000,
                    exact: true,
                    relevance_ppm: 950_000,
                }],
                evidence_paths: EvidencePathReport {
                    insufficient_sample: true,
                    paths_truncated: false,
                    raw_match_count: 1,
                    eligible_turn_count: 1,
                    raw_session_count: 1,
                    independent_group_count: 1,
                    strong_group_count: 1,
                    weak_group_count: 0,
                    observed_eof_provisional_group_count: 1,
                    unknown_dedupe_count: 0,
                    unknown_dedupe_session_count: 0,
                    families: Vec::new(),
                },
                diagnostic: QueryDiagnostic::default(),
            },
            SearchTrace {
                candidate_turn_keys: vec![turn_key],
                candidate_count: 1,
                ..SearchTrace::default()
            },
        );
        assert_eq!(search["orderBy"], "relevance");
        assert_eq!(search["totalMatchCount"], "7");
        assert_eq!(
            search["results"][0]["dedupe"]["duplicateGroupKey"],
            dedupe_group_key
        );
        assert_eq!(search["results"][0]["dedupe"]["confidence"], "strong");
        assert_eq!(
            search["results"][0]["dedupe"]["observedEofProvisional"],
            true
        );
        validate_protocol_message(&search).unwrap();

        let event = evidence_event_wire(SafeEvidenceEvent {
            event_key: "4".repeat(64),
            occurred_turn_key: None,
            linked_turns: vec![EvidenceLink {
                turn_key: "3".repeat(64),
                role: "lifecycle".to_owned(),
            }],
            source_record_key: "private-source-record".to_owned(),
            pointer_kind: "response_item".to_owned(),
            pointer_content_index: 0,
            pointer_event_ordinal: 0,
            origin_scope: "main".to_owned(),
            observed_timestamp: None,
            payload: SafeEventPayload::VisibleMessage {
                role: "user".to_owned(),
            },
        });
        assert!(event.get("sourceRecordKey").is_none());
        assert!(!event.to_string().contains("private-source-record"));

        let error = query_engine_error(QueryError::new(
            "QUERY_FAILED",
            "database failure at /private/session.jsonl",
        ));
        assert_eq!(error.message, "Turn search failed");
        assert!(!error.message.contains("/private"));

        let space = query_engine_error(QueryError::new(
            "TS_INSIGHTS_PROJECTION_SPACE_REQUIRED",
            "private filesystem details",
        ));
        assert_eq!(space.code, "TS_INSIGHTS_PROJECTION_SPACE_REQUIRED");
        assert_eq!(
            space.message,
            "Turn search projection rebuild requires more free disk space"
        );
        assert!(!space.message.contains("private"));
    }

    #[test]
    fn abort_discards_staged_facts_without_committing() {
        let mut server = server();
        server.handle_message(message("hello")).unwrap();
        server.handle_message(message("begin-session")).unwrap();
        let batch = server.handle_message(message("retract-facts")).unwrap();
        assert_eq!(batch["type"], "BATCH_ACCEPTED");
        let response = server
            .handle_message(json!({
                "format": "threadshare-insights-protocol@v1",
                "type": "ABORT_SESSION",
                "requestId": "2",
                "nextSequence": "1",
                "reason": "cancelled",
            }))
            .unwrap();
        assert_eq!(response["type"], "SESSION_ABORTED");
        assert_eq!(server.storage.committed_session_count().unwrap(), 0);
        assert!(matches!(server.state, State::Ready { .. }));

        server.handle_message(message("begin-session")).unwrap();
        let repeated = server.handle_message(message("retract-facts")).unwrap();
        assert_eq!(repeated["type"], "BATCH_ACCEPTED");
    }

    #[test]
    fn protocol_error_clears_staged_facts_before_the_next_session() {
        let mut server = server();
        server.handle_message(message("hello")).unwrap();
        server.handle_message(message("begin-session")).unwrap();
        server.handle_message(message("retract-facts")).unwrap();
        let mut invalid = message("retract-facts");
        invalid["sequence"] = Value::String("0".to_owned());
        let error = server.handle_message(invalid).unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME");
        assert!(matches!(server.state, State::Ready { .. }));

        server.handle_message(message("begin-session")).unwrap();
        let repeated = server.handle_message(message("retract-facts")).unwrap();
        assert_eq!(repeated["type"], "BATCH_ACCEPTED");
    }

    #[test]
    fn disconnect_before_commit_leaves_storage_unchanged() {
        let mut server = server();
        server.handle_message(message("hello")).unwrap();
        server.handle_message(message("begin-session")).unwrap();
        server.handle_message(message("retract-facts")).unwrap();
        assert!(matches!(server.state, State::InSession { .. }));
        assert_eq!(server.storage.committed_session_count().unwrap(), 0);
        drop(server);
    }

    #[test]
    fn commits_a_session_larger_than_32_mib_through_disk_staging() {
        let delta = large_session_delta();
        assert!(canonical_json(&delta).len() > 32 * 1024 * 1024);
        let mut server = server();
        let response = ingest_delta(&mut server, &delta);
        assert_eq!(response["type"], "SESSION_COMMITTED");
        assert_eq!(response["idempotent"], false);
        assert_eq!(server.storage.committed_session_count().unwrap(), 1);
        assert!(matches!(server.state, State::Ready { .. }));
    }

    #[test]
    fn commits_a_trace_source_through_the_independent_protocol_state() {
        let repository = RepositoryDelta {
            repository_id: "11111111-1111-4111-8111-111111111111".to_owned(),
            repository_key: "1".repeat(64),
            available: true,
            ref_digest: "2".repeat(64),
            scm_provider: Some("github".to_owned()),
            web_base_url: Some("https://github.com".to_owned()),
            repository_path: Some("team-harness/threadshare".to_owned()),
            project_keys: vec!["3".repeat(64), "4".repeat(64)],
        };
        let refs = vec![json!({
            "name": "refs/heads/main",
            "objectId": "a".repeat(40)
        })];
        let commits = vec![json!({
            "objectId": "a".repeat(40),
            "parentObjectIds": [],
            "authorTimestamp": "2026-08-16T00:00:00.000Z",
            "committerTimestamp": "2026-08-16T00:00:00.000Z",
            "treeObjectId": "b".repeat(40),
            "summary": "initial"
        })];
        let files = vec![json!({
            "objectId": "a".repeat(40),
            "path": "src/lib.rs",
            "oldPath": null,
            "status": "A",
            "additions": "10",
            "deletions": "0"
        })];
        let counts = TraceSourceCounts {
            refs: "1".to_owned(),
            commits: "1".to_owned(),
            files: "1".to_owned(),
            intent_nodes: "0".to_owned(),
            intent_refs: "0".to_owned(),
        };
        let mut digest_storage = EngineStorage::open_in_memory().unwrap();
        digest_storage
            .stage_trace_source_batch("refs", 0, &refs)
            .unwrap();
        digest_storage
            .stage_trace_source_batch("commits", 0, &commits)
            .unwrap();
        digest_storage
            .stage_trace_source_batch("files", 0, &files)
            .unwrap();
        let mut metadata = TraceSourceMetadata {
            delta_id: "0".repeat(64),
            expected_generation: "0".to_owned(),
            target_generation: "1".to_owned(),
            repository: repository.clone(),
            intent: None,
            counts: counts.clone(),
        };
        metadata.delta_id = digest_storage
            .staged_trace_source_digest(&metadata)
            .unwrap();

        let mut server = server();
        server.handle_message(message("hello")).unwrap();
        let accepted = server
            .handle_message(json!({
                "format": "threadshare-insights-protocol@v1",
                "type": "BEGIN_TRACE_SOURCE",
                "requestId": "81",
                "deltaFormat": "threadshare-insights-trace-source-delta@v1",
                "deltaId": metadata.delta_id,
                "expectedGeneration": "0",
                "targetGeneration": "1",
                "repository": repository,
                "intent": null,
                "counts": counts,
            }))
            .unwrap();
        assert_eq!(accepted["type"], "TRACE_SOURCE_ACCEPTED");
        for (sequence, collection, items) in [
            ("0", "refs", refs),
            ("1", "commits", commits),
            ("2", "files", files),
        ] {
            let response = server
                .handle_message(json!({
                    "format": "threadshare-insights-protocol@v1",
                    "type": "TRACE_SOURCE_BATCH",
                    "requestId": "81",
                    "sequence": sequence,
                    "collection": collection,
                    "items": items,
                }))
                .unwrap();
            assert_eq!(response["type"], "TRACE_SOURCE_BATCH_ACCEPTED");
        }
        let response = server
            .handle_message(json!({
                "format": "threadshare-insights-protocol@v1",
                "type": "COMMIT_TRACE_SOURCE",
                "requestId": "81",
                "nextSequence": "3",
            }))
            .unwrap();
        assert_eq!(response["type"], "TRACE_SOURCE_COMMITTED");
        assert_eq!(response["snapshotSeq"], "1");
        assert_eq!(
            server
                .storage
                .repository_commit_counts("11111111-1111-4111-8111-111111111111")
                .unwrap(),
            (1, 1)
        );
        assert!(matches!(server.state, State::Ready { .. }));
    }
}
