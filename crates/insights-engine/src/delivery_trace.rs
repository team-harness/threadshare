use crate::canonical_json;
use rusqlite::{Connection, OptionalExtension, params};
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};
use std::collections::BTreeSet;

pub const DELIVERY_TRACE_REQUEST_FORMAT: &str = "threadshare-insights-delivery-trace-request@v1";
pub const DELIVERY_TRACE_RESPONSE_FORMAT: &str = "threadshare-insights-delivery-trace@v1";

const MAX_LABEL_BYTES: usize = 1_024;
const MAX_PATH_BYTES: usize = 12 * 1_024;
const MAX_CURSOR_BYTES: usize = 32 * 1_024;
const MAX_TRACE_EDGES: usize = 200;
const MAX_TRACE_NODES: usize = 401;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct DeliveryTraceError {
    pub code: &'static str,
    pub message: String,
}

impl DeliveryTraceError {
    fn invalid(message: impl Into<String>) -> Self {
        Self {
            code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
            message: message.into(),
        }
    }

    fn query(code: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            message: message.into(),
        }
    }
}

fn request_digest(request: &DeliveryTraceRequest) -> Result<String, DeliveryTraceError> {
    let mut value = request.clone();
    value.cursor = None;
    let value = serde_json::to_value(value)
        .map_err(|_| DeliveryTraceError::invalid("Delivery Trace request is invalid"))?;
    Ok(hex::encode(Sha256::digest(
        canonical_json(&value).as_bytes(),
    )))
}

fn encode_cursor(snapshot_seq: &str, digest: &str, after: &str) -> String {
    hex::encode(format!("{snapshot_seq}\0{digest}\0{after}"))
}

fn decode_cursor(
    cursor: Option<&str>,
    snapshot_seq: &str,
    digest: &str,
) -> Result<Option<String>, DeliveryTraceError> {
    let Some(cursor) = cursor else {
        return Ok(None);
    };
    let bytes = hex::decode(cursor).map_err(|_| {
        DeliveryTraceError::query("TS_INSIGHTS_CURSOR_STALE", "Delivery Trace cursor is stale")
    })?;
    let value = String::from_utf8(bytes).map_err(|_| {
        DeliveryTraceError::query("TS_INSIGHTS_CURSOR_STALE", "Delivery Trace cursor is stale")
    })?;
    let mut parts = value.splitn(3, '\0');
    if parts.next() != Some(snapshot_seq) || parts.next() != Some(digest) {
        return Err(DeliveryTraceError::query(
            "TS_INSIGHTS_CURSOR_STALE",
            "Delivery Trace cursor is stale",
        ));
    }
    Ok(parts.next().map(str::to_owned))
}

fn bounded_label(mut value: String) -> String {
    while value.len() > MAX_LABEL_BYTES {
        value.pop();
    }
    if value.is_empty() {
        "Unnamed".to_owned()
    } else {
        value
    }
}

struct CommitNodeRow {
    repository_id: String,
    key: String,
    repository_key: String,
    object_id: String,
    parents_json: String,
    observed_at: String,
    summary: String,
    reachable: i64,
    revision: String,
    scm_provider: Option<String>,
    web_base_url: Option<String>,
    repository_path: Option<String>,
}

fn safe_scm(
    provider: Option<&str>,
    web_base_url: Option<&str>,
    repository_path: Option<&str>,
) -> Option<ScmAttributes> {
    let (kind, expected_base) = match provider? {
        "github" => (ScmProvider::Github, "https://github.com"),
        "gitlab" => (ScmProvider::Gitlab, "https://gitlab.com"),
        _ => return None,
    };
    let web_base_url = web_base_url?;
    let repository_path = repository_path?;
    if web_base_url != expected_base
        || repository_path.is_empty()
        || repository_path.starts_with('/')
        || repository_path.ends_with('/')
        || repository_path.split('/').any(|part| {
            part.is_empty()
                || matches!(part, "." | "..")
                || !part
                    .bytes()
                    .all(|byte| byte.is_ascii_alphanumeric() || b"-_.".contains(&byte))
        })
    {
        return None;
    }
    Some(ScmAttributes {
        kind,
        web_base_url: web_base_url.to_owned(),
        repository_path: repository_path.to_owned(),
        availability: ScmAvailability::NotVerified,
    })
}

fn commit_external_links(row: &CommitNodeRow) -> ExternalLinks {
    let commit = safe_scm(
        row.scm_provider.as_deref(),
        row.web_base_url.as_deref(),
        row.repository_path.as_deref(),
    )
    .map(|scm| {
        format!(
            "{}/{}/commit/{}",
            scm.web_base_url, scm.repository_path, row.object_id
        )
    });
    ExternalLinks { commit }
}

fn commit_node(row: &CommitNodeRow) -> Result<TraceNode, DeliveryTraceError> {
    let parent_object_ids = serde_json::from_str(&row.parents_json).map_err(|_| {
        DeliveryTraceError::query("TS_INSIGHTS_STORAGE_CORRUPT", "Delivery graph is invalid")
    })?;
    Ok(TraceNode {
        kind: TraceNodeKind::GitCommit,
        key: row.key.clone(),
        revision: row.revision.clone(),
        label: bounded_label(if row.summary.is_empty() {
            row.object_id[..12].to_owned()
        } else {
            row.summary.clone()
        }),
        observed_at: Some(row.observed_at.clone()),
        attributes: TraceNodeAttributes::GitCommit(GitCommitAttributes {
            repository_key: row.repository_key.clone(),
            object_id: row.object_id.clone(),
            parent_object_ids,
            reachable: row.reachable == 1,
            external_links: commit_external_links(row),
        }),
    })
}

fn file_node(key: String, repository_key: String, path: String, revision: String) -> TraceNode {
    TraceNode {
        kind: TraceNodeKind::File,
        key,
        revision,
        label: path.clone(),
        observed_at: None,
        attributes: TraceNodeAttributes::File(FileAttributes {
            repository_key,
            path,
        }),
    }
}

fn intent_kind(value: &str) -> Result<IntentKind, DeliveryTraceError> {
    match value {
        "feature" => Ok(IntentKind::Feature),
        "story" => Ok(IntentKind::Story),
        _ => Err(DeliveryTraceError::query(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            "Delivery graph contains an invalid Intent kind",
        )),
    }
}

fn intent_status(value: &str) -> Result<IntentStatus, DeliveryTraceError> {
    match value {
        "complete" => Ok(IntentStatus::Complete),
        "todo" => Ok(IntentStatus::Todo),
        _ => Err(DeliveryTraceError::query(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            "Delivery graph contains an invalid Intent status",
        )),
    }
}

fn intent_node_from_row(row: &rusqlite::Row<'_>) -> Result<TraceNode, rusqlite::Error> {
    let kind: String = row.get(4)?;
    let status: String = row.get(5)?;
    Ok(TraceNode {
        kind: TraceNodeKind::Intent,
        key: row.get(1)?,
        revision: row.get(6)?,
        label: bounded_label(row.get(3)?),
        observed_at: None,
        attributes: TraceNodeAttributes::Intent(IntentAttributes {
            intent_kind: intent_kind(&kind).map_err(|_| rusqlite::Error::InvalidQuery)?,
            status: intent_status(&status).map_err(|_| rusqlite::Error::InvalidQuery)?,
            parent_intent_key: row.get(2)?,
        }),
    })
}

fn read_intent_node(
    connection: &Connection,
    intent_key: &[u8],
) -> Result<Option<(String, TraceNode)>, DeliveryTraceError> {
    connection
        .query_row(
            "SELECT n.repository_id,lower(hex(n.intent_key)),
                    CASE WHEN n.parent_intent_key IS NULL THEN NULL ELSE lower(hex(n.parent_intent_key)) END,
                    n.title,n.kind,n.status,lower(hex(n.revision))
             FROM intent_nodes n WHERE n.intent_key=?1",
            [intent_key],
            |row| Ok((row.get(0)?, intent_node_from_row(row)?)),
        )
        .optional()
        .map_err(|_| {
            DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_FAILED",
                "Delivery graph Intent query failed",
            )
        })
}

fn read_session_node(
    connection: &Connection,
    session_key: &[u8],
) -> Result<Option<TraceNode>, DeliveryTraceError> {
    connection
        .query_row(
            "SELECT lower(hex(s.session_key)),s.provider,
                    CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                    COALESCE(s.observed_end,s.observed_start),lower(hex(c.delta_id))
             FROM sessions s JOIN session_commits c USING(session_id)
             WHERE s.session_key=?1 AND s.eligibility='eligible' AND s.session_scope='main'
               AND NOT EXISTS (SELECT 1 FROM source_purge_states p WHERE p.session_key=s.session_key)",
            [session_key],
            |row| {
                let key: String = row.get(0)?;
                let provider: String = row.get(1)?;
                Ok(TraceNode {
                    kind: TraceNodeKind::Session,
                    key: key.clone(),
                    revision: row.get(4)?,
                    label: bounded_label(format!("{provider} session {}", &key[..12])),
                    observed_at: row.get(3)?,
                    attributes: TraceNodeAttributes::Session(SessionAttributes {
                        provider,
                        project_key: row.get(2)?,
                    }),
                })
            },
        )
        .optional()
        .map_err(|_| {
            DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_FAILED",
                "Delivery graph Session query failed",
            )
        })
}

fn read_turn_node(
    connection: &Connection,
    turn_key: &[u8],
) -> Result<Option<TraceNode>, DeliveryTraceError> {
    connection
        .query_row(
            "SELECT lower(hex(t.turn_key)),lower(hex(s.session_key)),s.provider,
                    t.observed_timestamp,lower(hex(t.revision))
             FROM turns t JOIN sessions s USING(session_id)
             WHERE t.turn_key=?1 AND t.revision IS NOT NULL
               AND t.effective_provider_visibility='active'
               AND s.eligibility='eligible' AND s.session_scope='main'
               AND NOT EXISTS (SELECT 1 FROM source_purge_states p WHERE p.session_key=s.session_key)",
            [turn_key],
            |row| {
                let key: String = row.get(0)?;
                let provider: String = row.get(2)?;
                Ok(TraceNode {
                    kind: TraceNodeKind::Turn,
                    key: key.clone(),
                    revision: row.get(4)?,
                    label: bounded_label(format!("{provider} turn {}", &key[..12])),
                    observed_at: row.get(3)?,
                    attributes: TraceNodeAttributes::Turn(TurnAttributes {
                        session_key: row.get(1)?,
                    }),
                })
            },
        )
        .optional()
        .map_err(|_| {
            DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_FAILED",
                "Delivery graph Turn query failed",
            )
        })
}

fn read_commit_node(
    connection: &Connection,
    commit_key: &[u8],
) -> Result<Option<TraceNode>, DeliveryTraceError> {
    connection
        .query_row(
            "SELECT c.repository_id,lower(hex(c.commit_key)),lower(hex(s.repository_key)),c.object_id,
                    c.parent_object_ids_json,c.committer_timestamp,c.summary,c.reachable,
                    lower(hex(c.revision)),s.scm_provider,s.web_base_url,s.repository_path
             FROM git_commits c JOIN repository_sources s USING(repository_id)
             WHERE c.commit_key=?1",
            [commit_key],
            |row| {
                commit_node(&CommitNodeRow {
                    repository_id: row.get(0)?,
                    key: row.get(1)?,
                    repository_key: row.get(2)?,
                    object_id: row.get(3)?,
                    parents_json: row.get(4)?,
                    observed_at: row.get(5)?,
                    summary: row.get(6)?,
                    reachable: row.get(7)?,
                    revision: row.get(8)?,
                    scm_provider: row.get(9)?,
                    web_base_url: row.get(10)?,
                    repository_path: row.get(11)?,
                })
                .map_err(|_| rusqlite::Error::InvalidQuery)
            },
        )
        .optional()
        .map_err(|_| {
            DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_FAILED",
                "Delivery graph Commit query failed",
            )
        })
}

struct StoredIntentEdge {
    from: TraceNodeRef,
    to_kind: String,
    to_key: String,
    relation: String,
    strength: String,
    source: String,
    facts_json: String,
    limitations_json: String,
    revision: String,
}

fn intent_edge(stored: StoredIntentEdge) -> Result<TraceEdge, DeliveryTraceError> {
    let to_kind = match stored.to_kind.as_str() {
        "session" => TraceNodeKind::Session,
        "git-commit" => TraceNodeKind::GitCommit,
        _ => {
            return Err(DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "Delivery graph edge target is invalid",
            ));
        }
    };
    let relation = match stored.relation.as_str() {
        "intent-declares-session" => TraceRelation::IntentDeclaresSession,
        "intent-declares-commit" => TraceRelation::IntentDeclaresCommit,
        "intent-correlates-session" => TraceRelation::IntentCorrelatesSession,
        _ => {
            return Err(DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "Delivery graph edge relation is invalid",
            ));
        }
    };
    let strength = match stored.strength.as_str() {
        "direct" => TraceStrength::Direct,
        "candidate" => TraceStrength::Candidate,
        _ => {
            return Err(DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "Delivery graph edge strength is invalid",
            ));
        }
    };
    let source = match stored.source.as_str() {
        "intent-explicit-session-ref" => TraceSource::IntentExplicitSessionRef,
        "intent-explicit-commit-ref" => TraceSource::IntentExplicitCommitRef,
        "unique-text-overlap" => TraceSource::UniqueTextOverlap,
        _ => {
            return Err(DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "Delivery graph edge source is invalid",
            ));
        }
    };
    let facts = serde_json::from_str(&stored.facts_json).map_err(|_| {
        DeliveryTraceError::query(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            "Delivery graph edge facts are invalid",
        )
    })?;
    let limitations = serde_json::from_str(&stored.limitations_json).map_err(|_| {
        DeliveryTraceError::query(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            "Delivery graph edge limitations are invalid",
        )
    })?;
    Ok(TraceEdge {
        relation,
        from: stored.from,
        to: TraceNodeRef {
            kind: to_kind,
            key: stored.to_key,
        },
        strength,
        source,
        facts,
        limitations,
        revision: stored.revision,
    })
}

fn read_file_node(
    connection: &Connection,
    repository_id: &str,
    object_id: &str,
    file_key: &[u8],
) -> Result<Option<TraceNode>, DeliveryTraceError> {
    connection
        .query_row(
            "SELECT lower(hex(f.file_key)),lower(hex(s.repository_key)),f.path,
                    lower(hex(f.revision))
             FROM git_commit_files f JOIN repository_sources s USING(repository_id)
             WHERE f.repository_id=?1 AND f.object_id=?2 AND f.file_key=?3",
            params![repository_id, object_id, file_key],
            |row| {
                Ok(file_node(
                    row.get(0)?,
                    row.get(1)?,
                    row.get(2)?,
                    row.get(3)?,
                ))
            },
        )
        .optional()
        .map_err(|_| {
            DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_FAILED",
                "Delivery graph File query failed",
            )
        })
}

struct StoredDeliveryEdge {
    from_kind: String,
    from_key: String,
    to_kind: String,
    to_key: String,
    relation: String,
    strength: String,
    source: String,
    facts_json: String,
    limitations_json: String,
    revision: String,
}

fn stored_delivery_edge(stored: StoredDeliveryEdge) -> Result<TraceEdge, DeliveryTraceError> {
    Ok(TraceEdge {
        relation: parse_stored_enum(&stored.relation, "edge relation")?,
        from: TraceNodeRef {
            kind: parse_stored_enum(&stored.from_kind, "edge source kind")?,
            key: stored.from_key,
        },
        to: TraceNodeRef {
            kind: parse_stored_enum(&stored.to_kind, "edge target kind")?,
            key: stored.to_key,
        },
        strength: parse_stored_enum(&stored.strength, "edge strength")?,
        source: parse_stored_enum(&stored.source, "edge source")?,
        facts: serde_json::from_str(&stored.facts_json).map_err(|_| {
            DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "Delivery graph edge facts are invalid",
            )
        })?,
        limitations: serde_json::from_str(&stored.limitations_json).map_err(|_| {
            DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "Delivery graph edge limitations are invalid",
            )
        })?,
        revision: stored.revision,
    })
}

fn parse_stored_enum<T>(value: &str, label: &str) -> Result<T, DeliveryTraceError>
where
    T: serde::de::DeserializeOwned,
{
    serde_json::from_value(serde_json::Value::String(value.to_owned())).map_err(|_| {
        DeliveryTraceError::query(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            format!("Delivery graph {label} is invalid"),
        )
    })
}

type DeliveryEdgePage = (Vec<TraceNode>, Vec<TraceEdge>, Option<String>);

fn read_delivery_edge_page(
    connection: &Connection,
    repository_id: &str,
    request: &DeliveryTraceRequest,
    after: Option<&str>,
) -> Result<DeliveryEdgePage, DeliveryTraceError> {
    let outgoing = !matches!(request.direction, TraceDirection::Incoming);
    let incoming = !matches!(request.direction, TraceDirection::Outgoing);
    let mut statement = connection
        .prepare(
            "SELECT lower(hex(edge.edge_key)),edge.object_id,edge.from_kind,
                    lower(hex(edge.from_key)),edge.to_kind,lower(hex(edge.to_key)),
                    edge.relation,edge.strength,edge.source,evidence.facts_json,
                    evidence.limitations_json,lower(hex(edge.revision))
             FROM delivery_trace_edges edge
             JOIN delivery_trace_edge_evidence evidence USING(edge_key)
             WHERE edge.repository_id=?1
               AND ((?2=1 AND edge.from_kind=?3 AND edge.from_key=?4)
                 OR (?5=1 AND edge.to_kind=?3 AND edge.to_key=?4))
               AND (?6=1 OR edge.strength!='candidate')
               AND (?7=1 OR edge.strength!='contextual')
               AND (?8 IS NULL OR lower(hex(edge.edge_key))>?8)
             ORDER BY edge.edge_key LIMIT ?9",
        )
        .map_err(|_| {
            DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_FAILED",
                "Delivery graph edge query failed",
            )
        })?;
    let root_key = hex::decode(&request.root.key)
        .map_err(|_| DeliveryTraceError::invalid("root.key is invalid"))?;
    let mut rows = statement
        .query(params![
            repository_id,
            i64::from(outgoing),
            request.root.kind.as_str(),
            root_key,
            i64::from(incoming),
            i64::from(request.include_candidate_edges),
            i64::from(request.include_contextual_edges),
            after,
            i64::from(request.limit) + 1,
        ])
        .map_err(|_| {
            DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_FAILED",
                "Delivery graph edge query failed",
            )
        })?;
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut last_returned = None;
    let mut next_after = None;
    while let Some(row) = rows.next().map_err(|_| {
        DeliveryTraceError::query(
            "TS_INSIGHTS_STORAGE_FAILED",
            "Delivery graph edge query failed",
        )
    })? {
        let edge_key: String = row.get(0).map_err(|_| {
            DeliveryTraceError::query("TS_INSIGHTS_STORAGE_CORRUPT", "Delivery graph is invalid")
        })?;
        if edges.len() == usize::from(request.limit) {
            next_after = last_returned;
            break;
        }
        let object_id: String = row.get(1).map_err(|_| {
            DeliveryTraceError::query("TS_INSIGHTS_STORAGE_CORRUPT", "Delivery graph is invalid")
        })?;
        let from_kind: String = row.get(2).map_err(|_| {
            DeliveryTraceError::query("TS_INSIGHTS_STORAGE_CORRUPT", "Delivery graph is invalid")
        })?;
        let from_key: String = row.get(3).map_err(|_| {
            DeliveryTraceError::query("TS_INSIGHTS_STORAGE_CORRUPT", "Delivery graph is invalid")
        })?;
        let to_kind: String = row.get(4).map_err(|_| {
            DeliveryTraceError::query("TS_INSIGHTS_STORAGE_CORRUPT", "Delivery graph is invalid")
        })?;
        let to_key: String = row.get(5).map_err(|_| {
            DeliveryTraceError::query("TS_INSIGHTS_STORAGE_CORRUPT", "Delivery graph is invalid")
        })?;
        let edge = stored_delivery_edge(StoredDeliveryEdge {
            from_kind,
            from_key,
            to_kind,
            to_key,
            relation: row.get(6).map_err(|_| {
                DeliveryTraceError::query(
                    "TS_INSIGHTS_STORAGE_CORRUPT",
                    "Delivery graph is invalid",
                )
            })?,
            strength: row.get(7).map_err(|_| {
                DeliveryTraceError::query(
                    "TS_INSIGHTS_STORAGE_CORRUPT",
                    "Delivery graph is invalid",
                )
            })?,
            source: row.get(8).map_err(|_| {
                DeliveryTraceError::query(
                    "TS_INSIGHTS_STORAGE_CORRUPT",
                    "Delivery graph is invalid",
                )
            })?,
            facts_json: row.get(9).map_err(|_| {
                DeliveryTraceError::query(
                    "TS_INSIGHTS_STORAGE_CORRUPT",
                    "Delivery graph is invalid",
                )
            })?,
            limitations_json: row.get(10).map_err(|_| {
                DeliveryTraceError::query(
                    "TS_INSIGHTS_STORAGE_CORRUPT",
                    "Delivery graph is invalid",
                )
            })?,
            revision: row.get(11).map_err(|_| {
                DeliveryTraceError::query(
                    "TS_INSIGHTS_STORAGE_CORRUPT",
                    "Delivery graph is invalid",
                )
            })?,
        })?;
        let other = if edge.from == request.root {
            &edge.to
        } else {
            &edge.from
        };
        let key = hex::decode(&other.key).map_err(|_| {
            DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "Delivery graph node key is invalid",
            )
        })?;
        let node = match other.kind {
            TraceNodeKind::Session => read_session_node(connection, &key)?,
            TraceNodeKind::Turn => read_turn_node(connection, &key)?,
            TraceNodeKind::GitCommit => read_commit_node(connection, &key)?,
            TraceNodeKind::File => read_file_node(connection, repository_id, &object_id, &key)?,
            _ => None,
        };
        let Some(node) = node else {
            continue;
        };
        if request.window.as_ref().is_some_and(|window| {
            node.observed_at
                .as_ref()
                .is_some_and(|value| value < &window.after || value >= &window.before)
        }) {
            continue;
        }
        if !nodes
            .iter()
            .any(|item: &TraceNode| item.kind == node.kind && item.key == node.key)
        {
            nodes.push(node);
        }
        edges.push(edge);
        last_returned = Some(edge_key);
    }
    Ok((nodes, edges, next_after))
}

fn coverage(
    connection: &Connection,
    repository_id: &str,
    unselected_repository_count: i64,
    include_candidate_edges: bool,
    include_contextual_edges: bool,
) -> Result<TraceCoverage, DeliveryTraceError> {
    let (available, unreachable, unresolved, intent_coverage, candidate_count, contextual_count):
        (i64, i64, i64, Option<String>, i64, i64) = connection
        .query_row(
            "SELECT source.available,
                    (SELECT COUNT(*) FROM git_commits c WHERE c.repository_id=source.repository_id AND c.reachable=0),
                    (SELECT COUNT(*) FROM intent_refs r
                       WHERE r.repository_id=source.repository_id
                         AND NOT EXISTS (
                           SELECT 1 FROM intent_trace_edges edge
                            JOIN intent_nodes node ON node.repository_id=edge.repository_id AND node.intent_key=edge.from_key
                           WHERE edge.repository_id=r.repository_id AND node.node_id=r.node_id
                             AND ((r.ref_kind='session' AND edge.relation='intent-declares-session')
                               OR (r.ref_kind='commit' AND edge.relation='intent-declares-commit')))),
                    (SELECT coverage FROM intent_sources i WHERE i.repository_id=source.repository_id),
                    (SELECT COUNT(*) FROM intent_trace_edges i WHERE i.repository_id=source.repository_id AND i.strength='candidate'),
                    (SELECT COUNT(*) FROM delivery_trace_edges d WHERE d.repository_id=source.repository_id AND d.strength='contextual')
             FROM repository_sources source WHERE source.repository_id=?1",
            [repository_id],
            |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?, row.get(4)?, row.get(5)?)),
        )
        .map_err(|_| DeliveryTraceError::query("TS_INSIGHTS_STORAGE_CORRUPT", "Delivery graph coverage is unavailable"))?;
    Ok(TraceCoverage {
        repository_state: if available == 1 {
            TraceCoverageState::Complete
        } else {
            TraceCoverageState::Unavailable
        },
        intent_state: match intent_coverage.as_deref() {
            Some("complete") => TraceCoverageState::Complete,
            Some("partial") => TraceCoverageState::Partial,
            _ => TraceCoverageState::Unavailable,
        },
        unresolved_ref_count: unresolved.to_string(),
        excluded_candidate_edge_count: if include_candidate_edges {
            0
        } else {
            candidate_count
        }
        .to_string(),
        excluded_contextual_edge_count: if include_contextual_edges {
            0
        } else {
            contextual_count
        }
        .to_string(),
        unreachable_commit_count: unreachable.to_string(),
        unselected_repository_count: unselected_repository_count.to_string(),
    })
}

pub fn read_delivery_trace(
    connection: &Connection,
    database_uuid: &str,
    request: &DeliveryTraceRequest,
) -> Result<DeliveryTraceResponse, DeliveryTraceError> {
    request.validate()?;
    let snapshot_seq: String = connection
        .query_row(
            "SELECT value FROM engine_metadata WHERE key='snapshot_seq'",
            [],
            |row| row.get(0),
        )
        .map_err(|_| {
            DeliveryTraceError::query(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "Delivery graph snapshot is unavailable",
            )
        })?;
    let digest = request_digest(request)?;
    let after = decode_cursor(request.cursor.as_deref(), &snapshot_seq, &digest)?;
    let mut nodes = Vec::new();
    let mut edges = Vec::new();
    let mut next_after = None;
    let repository_id;
    // A root that names a repository, or reaches one through a Commit, leaves nothing out. Only the
    // roots resolved through a project key can have other repositories claiming them.
    let mut unselected_repository_count = 0;

    match request.root.kind {
        TraceNodeKind::Repository => {
            let row = connection.query_row(
                "SELECT repository_id,lower(hex(repository_key)),lower(hex(delta_id)),scm_provider,web_base_url,repository_path FROM repository_sources WHERE repository_key=?1",
                [hex::decode(&request.root.key).map_err(|_| DeliveryTraceError::invalid("root.key is invalid"))?],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, String>(1)?, row.get::<_, String>(2)?, row.get::<_, Option<String>>(3)?, row.get::<_, Option<String>>(4)?, row.get::<_, Option<String>>(5)?)),
            ).optional().map_err(|_| DeliveryTraceError::query("TS_INSIGHTS_STORAGE_FAILED", "Delivery graph query failed"))?
                .ok_or_else(|| DeliveryTraceError::query("TS_INSIGHTS_TRACE_NOT_FOUND", "Delivery Trace root was not found"))?;
            repository_id = row.0;
            nodes.push(TraceNode {
                kind: TraceNodeKind::Repository,
                key: row.1,
                revision: row.2,
                label: bounded_label(
                    row.5
                        .clone()
                        .unwrap_or_else(|| "Local repository".to_owned()),
                ),
                observed_at: None,
                attributes: TraceNodeAttributes::Repository(RepositoryAttributes {
                    project_key: None,
                    scm: safe_scm(row.3.as_deref(), row.4.as_deref(), row.5.as_deref()),
                }),
            });
            if !matches!(request.direction, TraceDirection::Incoming) {
                let mut statement = connection
                    .prepare(
                        "SELECT n.repository_id,lower(hex(n.intent_key)),
                                CASE WHEN n.parent_intent_key IS NULL THEN NULL ELSE lower(hex(n.parent_intent_key)) END,
                                n.title,n.kind,n.status,lower(hex(n.revision))
                         FROM intent_nodes n
                         WHERE n.repository_id=?1 AND n.parent_intent_key IS NULL
                           AND (?2 IS NULL OR lower(hex(n.intent_key))>?2)
                         ORDER BY n.intent_key LIMIT ?3",
                    )
                    .map_err(|_| {
                        DeliveryTraceError::query(
                            "TS_INSIGHTS_STORAGE_FAILED",
                            "Delivery graph Intent query failed",
                        )
                    })?;
                let mut rows = statement
                    .query(params![repository_id, after, i64::from(request.limit) + 1])
                    .map_err(|_| {
                        DeliveryTraceError::query(
                            "TS_INSIGHTS_STORAGE_FAILED",
                            "Delivery graph Intent query failed",
                        )
                    })?;
                let mut last_returned = None;
                while let Some(row) = rows.next().map_err(|_| {
                    DeliveryTraceError::query(
                        "TS_INSIGHTS_STORAGE_FAILED",
                        "Delivery graph Intent query failed",
                    )
                })? {
                    let node = intent_node_from_row(row).map_err(|_| {
                        DeliveryTraceError::query(
                            "TS_INSIGHTS_STORAGE_CORRUPT",
                            "Delivery graph Intent is invalid",
                        )
                    })?;
                    if nodes.len() > usize::from(request.limit) {
                        next_after = last_returned;
                        break;
                    }
                    last_returned = Some(node.key.clone());
                    nodes.push(node);
                }
            }
        }
        TraceNodeKind::Intent => {
            let key = hex::decode(&request.root.key)
                .map_err(|_| DeliveryTraceError::invalid("root.key is invalid"))?;
            let (intent_repository_id, root) =
                read_intent_node(connection, &key)?.ok_or_else(|| {
                    DeliveryTraceError::query(
                        "TS_INSIGHTS_TRACE_NOT_FOUND",
                        "Delivery Trace root was not found",
                    )
                })?;
            repository_id = intent_repository_id;
            nodes.push(root);
            if !matches!(request.direction, TraceDirection::Incoming) {
                let mut statement = connection
                    .prepare(
                        "SELECT lower(hex(edge.edge_key)),edge.to_kind,lower(hex(edge.to_key)),
                                edge.relation,edge.strength,edge.source,edge.facts_json,
                                edge.limitations_json,lower(hex(edge.revision))
                         FROM intent_trace_edges edge
                         WHERE edge.repository_id=?1 AND edge.from_key=?2
                           AND (?3=1 OR edge.strength!='candidate')
                           AND (?4 IS NULL OR lower(hex(edge.edge_key))>?4)
                         ORDER BY edge.edge_key LIMIT ?5",
                    )
                    .map_err(|_| {
                        DeliveryTraceError::query(
                            "TS_INSIGHTS_STORAGE_FAILED",
                            "Delivery graph Intent edge query failed",
                        )
                    })?;
                let mut rows = statement
                    .query(params![
                        repository_id,
                        key,
                        i64::from(request.include_candidate_edges),
                        after,
                        i64::from(request.limit) + 1,
                    ])
                    .map_err(|_| {
                        DeliveryTraceError::query(
                            "TS_INSIGHTS_STORAGE_FAILED",
                            "Delivery graph Intent edge query failed",
                        )
                    })?;
                let mut last_returned = None;
                while let Some(row) = rows.next().map_err(|_| {
                    DeliveryTraceError::query(
                        "TS_INSIGHTS_STORAGE_FAILED",
                        "Delivery graph Intent edge query failed",
                    )
                })? {
                    let edge_key: String = row.get(0).map_err(|_| {
                        DeliveryTraceError::query(
                            "TS_INSIGHTS_STORAGE_CORRUPT",
                            "Delivery graph Intent edge is invalid",
                        )
                    })?;
                    if edges.len() == usize::from(request.limit) {
                        next_after = last_returned;
                        break;
                    }
                    let to_kind: String = row.get(1).map_err(|_| {
                        DeliveryTraceError::query(
                            "TS_INSIGHTS_STORAGE_CORRUPT",
                            "Delivery graph Intent edge is invalid",
                        )
                    })?;
                    let to_key: String = row.get(2).map_err(|_| {
                        DeliveryTraceError::query(
                            "TS_INSIGHTS_STORAGE_CORRUPT",
                            "Delivery graph Intent edge is invalid",
                        )
                    })?;
                    let target_key = hex::decode(&to_key).map_err(|_| {
                        DeliveryTraceError::query(
                            "TS_INSIGHTS_STORAGE_CORRUPT",
                            "Delivery graph Intent edge target is invalid",
                        )
                    })?;
                    let target = match to_kind.as_str() {
                        "session" => read_session_node(connection, &target_key)?,
                        "git-commit" => read_commit_node(connection, &target_key)?,
                        _ => None,
                    };
                    let Some(target) = target else {
                        continue;
                    };
                    if request.window.as_ref().is_some_and(|window| {
                        target
                            .observed_at
                            .as_ref()
                            .is_none_or(|value| value < &window.after || value >= &window.before)
                    }) {
                        continue;
                    }
                    let invalid_edge = |_| {
                        DeliveryTraceError::query(
                            "TS_INSIGHTS_STORAGE_CORRUPT",
                            "Delivery graph Intent edge is invalid",
                        )
                    };
                    let edge = intent_edge(StoredIntentEdge {
                        from: request.root.clone(),
                        to_kind,
                        to_key,
                        relation: row.get(3).map_err(invalid_edge)?,
                        strength: row.get(4).map_err(invalid_edge)?,
                        source: row.get(5).map_err(invalid_edge)?,
                        facts_json: row.get(6).map_err(invalid_edge)?,
                        limitations_json: row.get(7).map_err(invalid_edge)?,
                        revision: row.get(8).map_err(invalid_edge)?,
                    })?;
                    if !nodes
                        .iter()
                        .any(|node| node.kind == target.kind && node.key == target.key)
                    {
                        nodes.push(target);
                    }
                    edges.push(edge);
                    last_returned = Some(edge_key);
                }
            }
        }
        TraceNodeKind::Session => {
            let key = hex::decode(&request.root.key)
                .map_err(|_| DeliveryTraceError::invalid("root.key is invalid"))?;
            let root = read_session_node(connection, &key)?.ok_or_else(|| {
                DeliveryTraceError::query(
                    "TS_INSIGHTS_TRACE_NOT_FOUND",
                    "Delivery Trace root was not found",
                )
            })?;
            // The subquery counts the repositories that claim this Session's project key. Each of
            // them contributes exactly one row -- `repository_project_keys` is keyed on
            // (repository_id, project_key) -- so the count needs no DISTINCT, and everything past
            // the one repository this Trace reads becomes `unselectedRepositoryCount`.
            let (selected, claiming_repository_count) = connection
                .query_row(
                    "SELECT p.repository_id,
                            (SELECT COUNT(*) FROM repository_project_keys claim
                             WHERE claim.project_key=s.project_key)
                     FROM sessions s
                     JOIN repository_project_keys p ON p.project_key=s.project_key
                     WHERE s.session_key=?1 ORDER BY p.repository_id LIMIT 1",
                    [&key],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()
                .map_err(|_| {
                    DeliveryTraceError::query(
                        "TS_INSIGHTS_STORAGE_FAILED",
                        "Delivery graph query failed",
                    )
                })?
                .ok_or_else(|| {
                    DeliveryTraceError::query(
                        "TS_INSIGHTS_DELIVERY_TRACE_NOT_READY",
                        "No registered repository matches this Session",
                    )
                })?;
            repository_id = selected;
            unselected_repository_count = claiming_repository_count - 1;
            nodes.push(root);
            let (page_nodes, page_edges, page_after) =
                read_delivery_edge_page(connection, &repository_id, request, after.as_deref())?;
            nodes.extend(page_nodes);
            edges.extend(page_edges);
            next_after = page_after;
        }
        TraceNodeKind::Turn => {
            let key = hex::decode(&request.root.key)
                .map_err(|_| DeliveryTraceError::invalid("root.key is invalid"))?;
            let root = read_turn_node(connection, &key)?.ok_or_else(|| {
                DeliveryTraceError::query(
                    "TS_INSIGHTS_TRACE_NOT_FOUND",
                    "Delivery Trace root was not found",
                )
            })?;
            // Counted the same way as the Session root: one row per claiming repository, so the
            // repositories this Trace does not read stay visible in coverage.
            let (selected, claiming_repository_count) = connection
                .query_row(
                    "SELECT p.repository_id,
                            (SELECT COUNT(*) FROM repository_project_keys claim
                             WHERE claim.project_key=s.project_key)
                     FROM turns t
                     JOIN sessions s USING(session_id)
                     JOIN repository_project_keys p ON p.project_key=s.project_key
                     WHERE t.turn_key=?1 ORDER BY p.repository_id LIMIT 1",
                    [&key],
                    |row| Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?)),
                )
                .optional()
                .map_err(|_| {
                    DeliveryTraceError::query(
                        "TS_INSIGHTS_STORAGE_FAILED",
                        "Delivery graph query failed",
                    )
                })?
                .ok_or_else(|| {
                    DeliveryTraceError::query(
                        "TS_INSIGHTS_DELIVERY_TRACE_NOT_READY",
                        "No registered repository matches this Turn",
                    )
                })?;
            repository_id = selected;
            unselected_repository_count = claiming_repository_count - 1;
            nodes.push(root);
            let (page_nodes, page_edges, page_after) =
                read_delivery_edge_page(connection, &repository_id, request, after.as_deref())?;
            nodes.extend(page_nodes);
            edges.extend(page_edges);
            next_after = page_after;
        }
        TraceNodeKind::GitCommit => {
            let row = connection.query_row(
                "SELECT c.repository_id,lower(hex(c.commit_key)),lower(hex(s.repository_key)),c.object_id,c.parent_object_ids_json,c.committer_timestamp,c.summary,c.reachable,lower(hex(c.revision)),s.scm_provider,s.web_base_url,s.repository_path FROM git_commits c JOIN repository_sources s USING(repository_id) WHERE c.commit_key=?1",
                [hex::decode(&request.root.key).map_err(|_| DeliveryTraceError::invalid("root.key is invalid"))?],
                |row| Ok(CommitNodeRow {
                    repository_id: row.get(0)?,
                    key: row.get(1)?,
                    repository_key: row.get(2)?,
                    object_id: row.get(3)?,
                    parents_json: row.get(4)?,
                    observed_at: row.get(5)?,
                    summary: row.get(6)?,
                    reachable: row.get(7)?,
                    revision: row.get(8)?,
                    scm_provider: row.get(9)?,
                    web_base_url: row.get(10)?,
                    repository_path: row.get(11)?,
                }),
            ).optional().map_err(|_| DeliveryTraceError::query("TS_INSIGHTS_STORAGE_FAILED", "Delivery graph query failed"))?
                .ok_or_else(|| DeliveryTraceError::query("TS_INSIGHTS_TRACE_NOT_FOUND", "Delivery Trace root was not found"))?;
            repository_id = row.repository_id.clone();
            let in_window = request.window.as_ref().is_none_or(|window| {
                row.observed_at >= window.after && row.observed_at < window.before
            });
            nodes.push(commit_node(&row)?);
            if in_window {
                let (page_nodes, page_edges, page_after) =
                    read_delivery_edge_page(connection, &repository_id, request, after.as_deref())?;
                nodes.extend(page_nodes);
                edges.extend(page_edges);
                next_after = page_after;
            }
        }
        _ => {
            return Err(DeliveryTraceError::query(
                "TS_INSIGHTS_DELIVERY_TRACE_NOT_READY",
                "This Delivery Trace root requires a later projection stage",
            ));
        }
    }

    let next_cursor = next_after.map(|value| encode_cursor(&snapshot_seq, &digest, &value));
    let response = DeliveryTraceResponse {
        format: DELIVERY_TRACE_RESPONSE_FORMAT.to_owned(),
        database_uuid: database_uuid.to_owned(),
        snapshot_seq,
        evaluated_at: request.evaluated_at.clone(),
        root: request.root.clone(),
        nodes,
        edges,
        truncated: next_cursor.is_some(),
        next_cursor,
        coverage: coverage(
            connection,
            &repository_id,
            unselected_repository_count,
            request.include_candidate_edges,
            request.include_contextual_edges,
        )?,
    };
    response.validate_against(request)?;
    Ok(response)
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TraceNodeKind {
    Intent,
    Repository,
    Session,
    Turn,
    CapabilityUse,
    File,
    GitCommit,
}

impl TraceNodeKind {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Intent => "intent",
            Self::Repository => "repository",
            Self::Session => "session",
            Self::Turn => "turn",
            Self::CapabilityUse => "capability-use",
            Self::File => "file",
            Self::GitCommit => "git-commit",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TraceDirection {
    Incoming,
    Outgoing,
    Both,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceNodeRef {
    pub kind: TraceNodeKind,
    pub key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceWindow {
    pub after: String,
    pub before: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryTraceRequest {
    pub format: String,
    pub root: TraceNodeRef,
    pub window: Option<TraceWindow>,
    pub direction: TraceDirection,
    pub max_depth: u8,
    pub include_candidate_edges: bool,
    pub include_contextual_edges: bool,
    pub limit: u16,
    pub cursor: Option<String>,
    pub evaluated_at: String,
}

impl DeliveryTraceRequest {
    pub fn validate(&self) -> Result<(), DeliveryTraceError> {
        if self.format != DELIVERY_TRACE_REQUEST_FORMAT {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace request format is invalid",
            ));
        }
        validate_key(&self.root.key, "root.key")?;
        validate_timestamp(&self.evaluated_at, "evaluatedAt")?;
        if let Some(window) = &self.window {
            validate_timestamp(&window.after, "window.after")?;
            validate_timestamp(&window.before, "window.before")?;
            if window.after >= window.before {
                return Err(DeliveryTraceError::invalid(
                    "Delivery Trace window is empty",
                ));
            }
        }
        if !(1..=3).contains(&self.max_depth) {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace maxDepth is invalid",
            ));
        }
        if !(1..=MAX_TRACE_EDGES as u16).contains(&self.limit) {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace limit is invalid",
            ));
        }
        if self.cursor.as_ref().is_some_and(|value| {
            value.is_empty() || value.len() > MAX_CURSOR_BYTES || !value.is_ascii()
        }) {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace cursor is invalid",
            ));
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntentKind {
    Feature,
    Story,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum IntentStatus {
    Complete,
    Todo,
    Unknown,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScmProvider {
    Github,
    Gitlab,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CapabilityKind {
    Tool,
    Skill,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct IntentAttributes {
    pub intent_kind: IntentKind,
    pub status: IntentStatus,
    pub parent_intent_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RepositoryAttributes {
    pub project_key: Option<String>,
    pub scm: Option<ScmAttributes>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ScmAvailability {
    NotVerified,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ScmAttributes {
    pub kind: ScmProvider,
    pub web_base_url: String,
    pub repository_path: String,
    pub availability: ScmAvailability,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct ExternalLinks {
    pub commit: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionAttributes {
    pub provider: String,
    pub project_key: Option<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TurnAttributes {
    pub session_key: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct CapabilityUseAttributes {
    pub turn_key: String,
    pub capability_kind: CapabilityKind,
    pub canonical_name: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct FileAttributes {
    pub repository_key: String,
    pub path: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct GitCommitAttributes {
    pub repository_key: String,
    pub object_id: String,
    pub parent_object_ids: Vec<String>,
    pub reachable: bool,
    pub external_links: ExternalLinks,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(untagged)]
pub enum TraceNodeAttributes {
    Intent(IntentAttributes),
    Repository(RepositoryAttributes),
    Session(SessionAttributes),
    Turn(TurnAttributes),
    CapabilityUse(CapabilityUseAttributes),
    File(FileAttributes),
    GitCommit(GitCommitAttributes),
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceNode {
    pub kind: TraceNodeKind,
    pub key: String,
    pub revision: String,
    pub label: String,
    pub observed_at: Option<String>,
    pub attributes: TraceNodeAttributes,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TraceRelation {
    IntentDeclaresSession,
    IntentDeclaresCommit,
    SessionContainsTurn,
    TurnContainsCapabilityUse,
    SessionTouchedFile,
    CommitChangedFile,
    SessionObservedCommit,
    SessionCorrelatesCommit,
    TurnObservedCommit,
    TurnCorrelatesCommit,
    IntentCorrelatesSession,
    ContextualSameFile,
}

impl TraceRelation {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::IntentDeclaresSession => "intent-declares-session",
            Self::IntentDeclaresCommit => "intent-declares-commit",
            Self::SessionContainsTurn => "session-contains-turn",
            Self::TurnContainsCapabilityUse => "turn-contains-capability-use",
            Self::SessionTouchedFile => "session-touched-file",
            Self::CommitChangedFile => "commit-changed-file",
            Self::SessionObservedCommit => "session-observed-commit",
            Self::SessionCorrelatesCommit => "session-correlates-commit",
            Self::TurnObservedCommit => "turn-observed-commit",
            Self::TurnCorrelatesCommit => "turn-correlates-commit",
            Self::IntentCorrelatesSession => "intent-correlates-session",
            Self::ContextualSameFile => "contextual-same-file",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TraceStrength {
    Direct,
    Observed,
    Candidate,
    Contextual,
}

impl TraceStrength {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::Direct => "direct",
            Self::Observed => "observed",
            Self::Candidate => "candidate",
            Self::Contextual => "contextual",
        }
    }
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TraceSource {
    IntentExplicitSessionRef,
    IntentExplicitCommitRef,
    SessionMembership,
    TurnMembership,
    NormalizedFileEvent,
    GitTreeDiff,
    ObservedGitResult,
    OrderedExactPathOverlap,
    UniqueTextOverlap,
    SameFileHistory,
}

impl TraceSource {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::IntentExplicitSessionRef => "intent-explicit-session-ref",
            Self::IntentExplicitCommitRef => "intent-explicit-commit-ref",
            Self::SessionMembership => "session-membership",
            Self::TurnMembership => "turn-membership",
            Self::NormalizedFileEvent => "normalized-file-event",
            Self::GitTreeDiff => "git-tree-diff",
            Self::ObservedGitResult => "observed-git-result",
            Self::OrderedExactPathOverlap => "ordered-exact-path-overlap",
            Self::UniqueTextOverlap => "unique-text-overlap",
            Self::SameFileHistory => "same-file-history",
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(tag = "kind", rename_all = "kebab-case", deny_unknown_fields)]
pub enum TraceFact {
    ExactPathOverlap { count: String },
    WithinObservedCommitWindow,
    FullCommitHash,
    UniqueAbbreviatedCommitHash,
    ExplicitReference,
    SignificantTermOverlap { count: String },
    SameRepository,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TraceLimitation {
    NotAuthorship,
    NotExclusiveLineAttribution,
    NotCausality,
    IncompleteTimestamps,
    UnverifiedIntentReference,
    UnreachableCommit,
    PathOnlyContext,
    CandidateNotDefault,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceEdge {
    pub relation: TraceRelation,
    pub from: TraceNodeRef,
    pub to: TraceNodeRef,
    pub strength: TraceStrength,
    pub source: TraceSource,
    pub facts: Vec<TraceFact>,
    pub limitations: Vec<TraceLimitation>,
    pub revision: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum TraceCoverageState {
    Complete,
    Partial,
    Unavailable,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct TraceCoverage {
    pub repository_state: TraceCoverageState,
    pub intent_state: TraceCoverageState,
    pub unresolved_ref_count: String,
    pub excluded_candidate_edge_count: String,
    pub excluded_contextual_edge_count: String,
    pub unreachable_commit_count: String,
    /// How many other registered repositories claim this root's project key and were left out of
    /// this Trace. A Trace reads one repository's edges, so a root that several repositories claim
    /// -- the same working path re-initialized as a new Git directory, for instance -- shows only
    /// one of them. Reporting the remainder keeps the omission visible instead of silent; `"0"`
    /// means the Trace covers every repository that claims the root.
    pub unselected_repository_count: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeliveryTraceResponse {
    pub format: String,
    pub database_uuid: String,
    pub snapshot_seq: String,
    pub evaluated_at: String,
    pub root: TraceNodeRef,
    pub nodes: Vec<TraceNode>,
    pub edges: Vec<TraceEdge>,
    pub next_cursor: Option<String>,
    pub truncated: bool,
    pub coverage: TraceCoverage,
}

impl DeliveryTraceResponse {
    pub fn validate(&self) -> Result<(), DeliveryTraceError> {
        if self.format != DELIVERY_TRACE_RESPONSE_FORMAT {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace response format is invalid",
            ));
        }
        validate_uuid(&self.database_uuid)?;
        validate_decimal(&self.snapshot_seq, "snapshotSeq")?;
        validate_timestamp(&self.evaluated_at, "evaluatedAt")?;
        validate_key(&self.root.key, "root.key")?;
        if self.nodes.len() > MAX_TRACE_NODES || self.edges.len() > MAX_TRACE_EDGES {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace page exceeds its bounded limit",
            ));
        }
        if self.truncated != self.next_cursor.is_some() {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace pagination is inconsistent",
            ));
        }
        if self.next_cursor.as_ref().is_some_and(|value| {
            value.is_empty() || value.len() > MAX_CURSOR_BYTES || !value.is_ascii()
        }) {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace cursor is invalid",
            ));
        }

        let mut endpoints = BTreeSet::new();
        for node in &self.nodes {
            node.validate()?;
            if !endpoints.insert((node.kind, node.key.as_str())) {
                return Err(DeliveryTraceError::invalid(
                    "Delivery Trace page contains duplicate nodes",
                ));
            }
        }
        if !endpoints.contains(&(self.root.kind, self.root.key.as_str())) {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace root is missing from the page",
            ));
        }
        for edge in &self.edges {
            edge.validate()?;
            if !endpoints.contains(&(edge.from.kind, edge.from.key.as_str()))
                || !endpoints.contains(&(edge.to.kind, edge.to.key.as_str()))
            {
                return Err(DeliveryTraceError::invalid(
                    "Delivery Trace edge references a missing page node",
                ));
            }
        }
        self.coverage.validate()
    }

    pub fn validate_against(
        &self,
        request: &DeliveryTraceRequest,
    ) -> Result<(), DeliveryTraceError> {
        request.validate()?;
        self.validate()?;
        if self.root != request.root || self.evaluated_at != request.evaluated_at {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace response changed the request",
            ));
        }
        if self.edges.len() > usize::from(request.limit) {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace response exceeds the request limit",
            ));
        }
        if !request.include_candidate_edges
            && self
                .edges
                .iter()
                .any(|edge| edge.strength == TraceStrength::Candidate)
        {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace response exposed candidate edges",
            ));
        }
        if !request.include_contextual_edges
            && self
                .edges
                .iter()
                .any(|edge| edge.strength == TraceStrength::Contextual)
        {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace response exposed contextual edges",
            ));
        }
        Ok(())
    }
}

impl TraceNode {
    fn validate(&self) -> Result<(), DeliveryTraceError> {
        validate_key(&self.key, "node.key")?;
        validate_key(&self.revision, "node.revision")?;
        if self.label.is_empty() || self.label.len() > MAX_LABEL_BYTES {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace node label is invalid",
            ));
        }
        if let Some(value) = &self.observed_at {
            validate_timestamp(value, "node.observedAt")?;
        }
        let matches = matches!(
            (self.kind, &self.attributes),
            (TraceNodeKind::Intent, TraceNodeAttributes::Intent(_))
                | (
                    TraceNodeKind::Repository,
                    TraceNodeAttributes::Repository(_)
                )
                | (TraceNodeKind::Session, TraceNodeAttributes::Session(_))
                | (TraceNodeKind::Turn, TraceNodeAttributes::Turn(_))
                | (
                    TraceNodeKind::CapabilityUse,
                    TraceNodeAttributes::CapabilityUse(_)
                )
                | (TraceNodeKind::File, TraceNodeAttributes::File(_))
                | (TraceNodeKind::GitCommit, TraceNodeAttributes::GitCommit(_))
        );
        if !matches {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace node attributes do not match kind",
            ));
        }
        match &self.attributes {
            TraceNodeAttributes::Intent(value) => {
                validate_optional_key(&value.parent_intent_key, "parentIntentKey")
            }
            TraceNodeAttributes::Repository(value) => {
                validate_optional_key(&value.project_key, "projectKey")
            }
            TraceNodeAttributes::Session(value) => {
                if value.provider.is_empty() || value.provider.len() > 64 {
                    return Err(DeliveryTraceError::invalid(
                        "Delivery Trace session provider is invalid",
                    ));
                }
                validate_optional_key(&value.project_key, "projectKey")
            }
            TraceNodeAttributes::Turn(value) => validate_key(&value.session_key, "sessionKey"),
            TraceNodeAttributes::CapabilityUse(value) => {
                validate_key(&value.turn_key, "turnKey")?;
                if value.canonical_name.is_empty() || value.canonical_name.len() > 512 {
                    return Err(DeliveryTraceError::invalid(
                        "Delivery Trace capability name is invalid",
                    ));
                }
                Ok(())
            }
            TraceNodeAttributes::File(value) => {
                validate_key(&value.repository_key, "repositoryKey")?;
                validate_relative_path(&value.path)
            }
            TraceNodeAttributes::GitCommit(value) => {
                validate_key(&value.repository_key, "repositoryKey")?;
                validate_object_id(&value.object_id)?;
                if value.parent_object_ids.len() > 16 {
                    return Err(DeliveryTraceError::invalid(
                        "Delivery Trace commit has too many parents",
                    ));
                }
                for object_id in &value.parent_object_ids {
                    validate_object_id(object_id)?;
                }
                Ok(())
            }
        }
    }
}

impl TraceEdge {
    fn validate(&self) -> Result<(), DeliveryTraceError> {
        validate_key(&self.from.key, "edge.from.key")?;
        validate_key(&self.to.key, "edge.to.key")?;
        validate_key(&self.revision, "edge.revision")?;
        if self.facts.len() > 16 || self.limitations.len() > 16 {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace edge evidence exceeds its bounded limit",
            ));
        }
        for fact in &self.facts {
            match fact {
                TraceFact::ExactPathOverlap { count }
                | TraceFact::SignificantTermOverlap { count } => {
                    validate_decimal(count, "edge.fact.count")?;
                    if count == "0" {
                        return Err(DeliveryTraceError::invalid(
                            "Delivery Trace fact count must be positive",
                        ));
                    }
                }
                _ => {}
            }
        }
        let unique = self.limitations.iter().copied().collect::<BTreeSet<_>>();
        if unique.len() != self.limitations.len() {
            return Err(DeliveryTraceError::invalid(
                "Delivery Trace limitations contain duplicates",
            ));
        }
        if matches!(
            self.relation,
            TraceRelation::SessionCorrelatesCommit
                | TraceRelation::TurnCorrelatesCommit
                | TraceRelation::IntentCorrelatesSession
                | TraceRelation::ContextualSameFile
        ) && (self.facts.is_empty() || self.limitations.is_empty())
        {
            return Err(DeliveryTraceError::invalid(
                "derived Delivery Trace edges require facts and limitations",
            ));
        }
        if self.relation == TraceRelation::ContextualSameFile
            && self.strength != TraceStrength::Contextual
        {
            return Err(DeliveryTraceError::invalid(
                "shared-file context cannot be upgraded",
            ));
        }
        if matches!(
            self.relation,
            TraceRelation::SessionCorrelatesCommit | TraceRelation::TurnCorrelatesCommit
        ) && self.strength == TraceStrength::Direct
        {
            return Err(DeliveryTraceError::invalid(
                "derived commit correlation cannot be direct",
            ));
        }
        Ok(())
    }
}

impl TraceCoverage {
    fn validate(&self) -> Result<(), DeliveryTraceError> {
        for (label, value) in [
            ("unresolvedRefCount", &self.unresolved_ref_count),
            (
                "excludedCandidateEdgeCount",
                &self.excluded_candidate_edge_count,
            ),
            (
                "excludedContextualEdgeCount",
                &self.excluded_contextual_edge_count,
            ),
            ("unreachableCommitCount", &self.unreachable_commit_count),
            (
                "unselectedRepositoryCount",
                &self.unselected_repository_count,
            ),
        ] {
            validate_decimal(value, label)?;
        }
        Ok(())
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct SessionCommitEvidence {
    pub full_commit_hash_observed: bool,
    pub exact_path_overlap_count: String,
    pub within_observed_commit_window: bool,
    pub significant_term_overlap_count: String,
    pub unique_highest_text_match: bool,
    pub same_repository: bool,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct TraceClassification {
    pub relation: TraceRelation,
    pub strength: TraceStrength,
    pub source: TraceSource,
}

pub fn classify_session_commit_evidence(
    evidence: &SessionCommitEvidence,
) -> Option<TraceClassification> {
    if !evidence.same_repository {
        return None;
    }
    let exact_paths = parse_decimal(&evidence.exact_path_overlap_count)?;
    let significant_terms = parse_decimal(&evidence.significant_term_overlap_count)?;
    if evidence.full_commit_hash_observed {
        return Some(TraceClassification {
            relation: TraceRelation::SessionObservedCommit,
            strength: TraceStrength::Direct,
            source: TraceSource::ObservedGitResult,
        });
    }
    if exact_paths > 0 && evidence.within_observed_commit_window {
        return Some(TraceClassification {
            relation: TraceRelation::SessionCorrelatesCommit,
            strength: TraceStrength::Observed,
            source: TraceSource::OrderedExactPathOverlap,
        });
    }
    if significant_terms >= 2 && evidence.unique_highest_text_match {
        return Some(TraceClassification {
            relation: TraceRelation::SessionCorrelatesCommit,
            strength: TraceStrength::Candidate,
            source: TraceSource::UniqueTextOverlap,
        });
    }
    (exact_paths > 0).then_some(TraceClassification {
        relation: TraceRelation::ContextualSameFile,
        strength: TraceStrength::Contextual,
        source: TraceSource::SameFileHistory,
    })
}

fn validate_key(value: &str, label: &str) -> Result<(), DeliveryTraceError> {
    if value.len() != 64
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(DeliveryTraceError::invalid(format!(
            "Delivery Trace {label} is invalid"
        )));
    }
    Ok(())
}

fn validate_optional_key(value: &Option<String>, label: &str) -> Result<(), DeliveryTraceError> {
    if let Some(value) = value {
        validate_key(value, label)?;
    }
    Ok(())
}

fn validate_decimal(value: &str, label: &str) -> Result<(), DeliveryTraceError> {
    if parse_decimal(value).is_none() {
        return Err(DeliveryTraceError::invalid(format!(
            "Delivery Trace {label} is invalid"
        )));
    }
    Ok(())
}

fn parse_decimal(value: &str) -> Option<u64> {
    if value.is_empty()
        || (value.len() > 1 && value.starts_with('0'))
        || !value.bytes().all(|byte| byte.is_ascii_digit())
    {
        return None;
    }
    value.parse().ok()
}

fn validate_timestamp(value: &str, label: &str) -> Result<(), DeliveryTraceError> {
    crate::agent_query::parse_canonical_timestamp(value, label)
        .map(|_| ())
        .map_err(|_| DeliveryTraceError::invalid(format!("Delivery Trace {label} is invalid")))
}

fn validate_uuid(value: &str) -> Result<(), DeliveryTraceError> {
    let valid = value.len() == 36
        && value.bytes().enumerate().all(|(index, byte)| match index {
            8 | 13 | 18 | 23 => byte == b'-',
            _ => byte.is_ascii_hexdigit(),
        });
    if !valid {
        return Err(DeliveryTraceError::invalid(
            "Delivery Trace databaseUuid is invalid",
        ));
    }
    Ok(())
}

fn validate_object_id(value: &str) -> Result<(), DeliveryTraceError> {
    if !matches!(value.len(), 40 | 64)
        || !value
            .bytes()
            .all(|byte| byte.is_ascii_hexdigit() && !byte.is_ascii_uppercase())
    {
        return Err(DeliveryTraceError::invalid(
            "Delivery Trace Git object id is invalid",
        ));
    }
    Ok(())
}

fn validate_relative_path(value: &str) -> Result<(), DeliveryTraceError> {
    if value.is_empty()
        || value.len() > MAX_PATH_BYTES
        || value.starts_with('/')
        || value.contains('\0')
        || value
            .split('/')
            .any(|segment| segment.is_empty() || matches!(segment, "." | ".."))
    {
        return Err(DeliveryTraceError::invalid(
            "Delivery Trace repository path is invalid",
        ));
    }
    Ok(())
}
