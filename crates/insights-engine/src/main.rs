use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use threadshare_insights_engine::canonical_json;
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
use threadshare_insights_engine::query::{QueryError, SearchRequest, SearchResponse, SearchTrace};
use threadshare_insights_engine::storage::{EngineStorage, StorageError};

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
}

struct EngineServer {
    storage: EngineStorage,
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
    Ok(json!({
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
    }))
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

fn search_request(message: &Value) -> SearchRequest {
    let filters = &message["filters"];
    SearchRequest {
        query: message["query"]
            .as_str()
            .expect("validated search query")
            .to_owned(),
        providers: serde_json::from_value(filters["providers"].clone())
            .expect("validated providers"),
        project_keys: serde_json::from_value(filters["projectKeys"].clone())
            .expect("validated project keys"),
        tool_capability_keys: serde_json::from_value(filters["toolCapabilityKeys"].clone())
            .expect("validated tool keys"),
        skill_capability_keys: serde_json::from_value(filters["skillCapabilityKeys"].clone())
            .expect("validated skill keys"),
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

fn search_results_wire(request_id: &str, response: SearchResponse, trace: SearchTrace) -> Value {
    let results = response
        .results
        .into_iter()
        .map(|result| {
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
            json!({
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
            })
        })
        .collect::<Vec<_>>();
    json!({
        "format": PROTOCOL_FORMAT,
        "type": "TURN_SEARCH_RESULTS",
        "requestId": request_id,
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

fn evidence_page_wire(request_id: &str, page: TurnEvidencePage) -> Value {
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
        "snapshotSeq": page.snapshot_seq,
        "turn": page.turn,
        "entries": entries,
        "nextCursor": page.next_cursor,
    })
}

impl EngineServer {
    fn new(mut storage: EngineStorage) -> Result<Self, EngineError> {
        storage.verify_sqlite_contract()?;
        storage.maintain_search_projection(16)?;
        Ok(Self {
            storage,
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
                                    "snapshotSeq": page.snapshot_seq,
                                    "items": page.items,
                                    "nextCursor": page.next_cursor,
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
                                search_results_wire(&request_id, response, trace),
                            ))
                        }
                        MessageKind::ReadTurnEvidence => {
                            let turn_key = message["turnKey"].as_str().expect("validated turn key");
                            let expected_revision = message["expectedRevision"].as_str();
                            let cursor = message["cursor"].as_str();
                            let limit = u16::try_from(
                                message["limit"].as_u64().expect("validated evidence limit"),
                            )
                            .expect("validated evidence limit fits u16");
                            let page = self
                                .storage
                                .read_turn_evidence(turn_key, expected_revision, cursor, limit)
                                .map_err(query_engine_error)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                evidence_page_wire(&request_id, page),
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
                            accumulator.apply_batch(&message)?;
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
                        // Session facts live only in the accumulator until COMMIT_SESSION.
                        self.state = State::Ready { accepted_contract };
                        Err(error)
                    }
                }
            }
        }
    }
}

fn parse_arguments() -> Result<(bool, Option<PathBuf>), String> {
    let mut version = false;
    let mut json_output = false;
    let mut database = None;
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--version" => version = true,
            "--json" => json_output = true,
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
    Ok((version, database))
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
    let (show_version, database) = match parse_arguments() {
        Ok(value) => value,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let storage = match database {
        Some(path) => EngineStorage::open(&path),
        None => EngineStorage::open_in_memory(),
    };
    let storage = match storage {
        Ok(value) => value,
        Err(error) => {
            if !show_version {
                let _ = report_storage_initialization_error(error);
            }
            eprintln!("Insights Engine storage initialization failed");
            std::process::exit(1);
        }
    };
    if show_version {
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
        EngineServer, State, evidence_event_wire, evidence_paths_wire, query_engine_error,
        validate_protocol_message,
    };
    use serde::Deserialize;
    use serde_json::{Value, json};
    use std::fs;
    use std::path::PathBuf;
    use threadshare_insights_engine::evidence_path::{
        EvidenceLink, EvidencePathFamily, EvidencePathReport, PathNode, RepeatBucket,
        SafeEventPayload, SafeEvidenceEvent, ToolStateCounts,
    };
    use threadshare_insights_engine::query::QueryError;
    use threadshare_insights_engine::storage::EngineStorage;

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
        assert_eq!(page["items"], json!([]));
        validate_protocol_message(&page).unwrap();
        assert!(matches!(server.state, State::Ready { .. }));
    }

    #[test]
    fn search_and_evidence_requests_use_ready_state_with_content_free_errors() {
        let mut server = server();
        server.handle_message(message("hello")).unwrap();

        let response = server.handle_message(message("search-turns")).unwrap();
        assert_eq!(response["type"], "TURN_SEARCH_RESULTS");
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
}
