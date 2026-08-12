use rusqlite::{Connection, OptionalExtension, params, params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};
use std::ops::Deref;

use crate::analyzer::{AnalyzerError, analyze_query};
use crate::canonical_json;
use crate::fts_projection::HistoryFtsMatchExpression;
use crate::query::{QueryError, query_failed, valid_stable_key};

pub const QUERY_REQUEST_FORMAT: &str = "threadshare-insights-query-request@v2";
pub const QUERY_RESPONSE_FORMAT: &str = "threadshare-insights-query@v2";
pub const EVIDENCE_REQUEST_FORMAT: &str = "threadshare-insights-evidence-request@v2";
pub const EVIDENCE_RESPONSE_FORMAT: &str = "threadshare-insights-evidence@v2";
const MAX_QUERY_LIMIT: u16 = 50;
const MAX_QUERY_FIELDS: usize = 64;
const MAX_ORDER_FIELDS: usize = 4;
const MAX_PREDICATE_DEPTH: usize = 8;
const MAX_PREDICATE_LEAVES: usize = 64;
const MAX_CURSOR_BYTES: usize = 4096;
const MAX_QUERY_PAGE_BYTES: usize = 3_932_160;
const MAX_EVIDENCE_PAGE_BYTES: u32 = 1_048_576;
const MAX_AGGREGATE_CANDIDATES: u64 = 2_000_000;
const MAX_AGGREGATE_GROUPS: usize = 10_000;
const MAX_AGGREGATE_DISTINCT_VALUES: usize = 500_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum DeepResource {
    Session,
    Turn,
    Event,
    CapabilityUse,
    FileActivity,
    TokenUsage,
    ErrorOccurrence,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum Direction {
    Asc,
    Desc,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum CountMode {
    None,
    Exact,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PayloadMode {
    Omit,
    Reference,
    Inline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum PredicateOperator {
    Eq,
    Ne,
    In,
    NotIn,
    Exists,
    Lt,
    Lte,
    Gt,
    Gte,
    Between,
    Prefix,
    Contains,
    Match,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(untagged, deny_unknown_fields)]
pub enum DeepPredicate {
    And {
        and: Vec<DeepPredicate>,
    },
    Or {
        or: Vec<DeepPredicate>,
    },
    Not {
        not: Box<DeepPredicate>,
    },
    Leaf {
        field: String,
        #[serde(rename = "op")]
        operator: PredicateOperator,
        #[serde(default)]
        value: Option<Value>,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepOrderBy {
    pub field: String,
    pub direction: Direction,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DeepQueryShape {
    Records {
        select: Vec<String>,
        #[serde(default = "default_payload_mode")]
        payload_mode: PayloadMode,
    },
    Aggregate {
        group_by: Vec<String>,
        metrics: Vec<Value>,
    },
}

fn default_payload_mode() -> PayloadMode {
    PayloadMode::Reference
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepQueryRequest {
    pub format: String,
    pub resource: DeepResource,
    #[serde(rename = "where", default)]
    pub predicate: Option<DeepPredicate>,
    pub shape: DeepQueryShape,
    pub order_by: Vec<DeepOrderBy>,
    pub limit: u16,
    #[serde(default)]
    pub cursor: Option<String>,
    pub count: CountMode,
    pub evaluated_at: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepMatchingCoverage {
    pub full_record_count: String,
    pub summary_record_count: String,
    pub unloaded_record_count: String,
    pub truncated_record_count: String,
    pub unavailable_record_count: String,
    pub missing_timestamp_count: String,
    pub missing_revision_count: String,
    pub missing_token_metric_count: String,
    pub missing_payload_count: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepFtsCoverage {
    pub searchable_event_count: String,
    pub stored_not_searchable_event_count: String,
    pub searchable_payload_bytes: String,
    pub stored_not_searchable_payload_bytes: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepIndexedHistoryCoverage {
    pub visible_session_count: String,
    pub excluded_session_count: String,
    pub subagent_excluded_session_count: String,
    pub unknown_eligibility_session_count: String,
    pub pending_purge_session_count: String,
    pub purged_session_count: String,
    pub missing_coverage_rollup_session_count: String,
    pub fts: DeepFtsCoverage,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepCoverage {
    pub matching: DeepMatchingCoverage,
    pub indexed_history: DeepIndexedHistoryCoverage,
    pub degraded: bool,
    pub diagnostics: Vec<String>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepProvenanceField {
    pub path: String,
    pub kind: String,
    pub method: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepProvenance {
    pub default: String,
    pub fields: Vec<DeepProvenanceField>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepQueryLimits {
    pub page_bytes: String,
    pub payloads_may_require_evidence_paging: bool,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepQueryResponse {
    pub format: String,
    pub database_uuid: String,
    pub snapshot_seq: String,
    pub resource: DeepResource,
    pub records: NullableRecordPage,
    pub groups: Option<Vec<Value>>,
    pub next_cursor: Option<String>,
    pub total_match_count: Option<String>,
    pub total_group_count: Option<String>,
    pub truncated: bool,
    pub coverage: DeepCoverage,
    pub provenance: DeepProvenance,
    pub limits: DeepQueryLimits,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(transparent)]
pub struct NullableRecordPage(Option<Vec<Value>>);

impl NullableRecordPage {
    fn some(records: Vec<Value>) -> Self {
        Self(Some(records))
    }

    fn none() -> Self {
        Self(None)
    }
}

impl Deref for NullableRecordPage {
    type Target = [Value];

    fn deref(&self) -> &Self::Target {
        self.0.as_deref().unwrap_or(&[])
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(
    tag = "kind",
    rename_all = "kebab-case",
    rename_all_fields = "camelCase",
    deny_unknown_fields
)]
pub enum DeepEvidenceTarget {
    #[serde(rename = "event")]
    EventPayload {
        event_key: String,
        revision: String,
        #[serde(default, skip_serializing_if = "Option::is_none")]
        payload_key: Option<String>,
    },
    Turn {
        turn_key: String,
        revision: String,
    },
    Session {
        session_key: String,
        revision: String,
    },
    AttemptChain {
        chain_key: String,
        revision: String,
    },
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepEvidenceRequest {
    pub format: String,
    pub target: DeepEvidenceTarget,
    pub include: Vec<String>,
    #[serde(default)]
    pub cursor: Option<String>,
    pub max_bytes: u32,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct EvidenceRange {
    pub start: String,
    pub end: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct DeepEvidenceResponse {
    pub format: String,
    pub database_uuid: String,
    pub snapshot_seq: String,
    pub target: DeepEvidenceTarget,
    pub revision: String,
    pub payload_sha256: String,
    pub total_bytes: String,
    pub range: EvidenceRange,
    pub content: String,
    pub next_cursor: Option<String>,
    pub complete: bool,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct QueryCursor {
    version: u8,
    database_uuid: String,
    snapshot_seq: String,
    request_digest: String,
    observed_at: Option<String>,
    stable_key: String,
    ordinal: u64,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
struct EvidenceCursor {
    version: u8,
    database_uuid: String,
    snapshot_seq: String,
    target_digest: String,
    revision: String,
    payload_sha256: String,
    global_offset: u64,
    chunk_ordinal: Option<u64>,
    chunk_offset: Option<u64>,
}

#[derive(Debug)]
struct EventRow {
    event_key: String,
    session_key: String,
    turn_key: Option<String>,
    provider: String,
    project_key: Option<String>,
    origin_scope: String,
    observed_at: Option<String>,
    kind: String,
    completeness: String,
    revision: String,
    metadata: Value,
}

#[derive(Debug)]
struct PayloadRow {
    payload_key: String,
    kind: String,
    encoding: String,
    byte_length: u64,
    sha256: String,
    completeness: String,
}

#[derive(Debug)]
struct TypedResourceRow {
    observed_at: Option<String>,
    stable_key: String,
    ordinal: u64,
    record: Value,
    event_revision: Option<String>,
}

#[derive(Default)]
struct PredicateStats {
    leaves: usize,
}

#[derive(Default)]
struct SqlPredicate {
    sql: String,
    values: Vec<SqlValue>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AggregateMetricOperator {
    Count,
    DistinctCount,
    Sum,
    Min,
    Max,
    Average,
}

#[derive(Debug, Clone)]
struct AggregateMetric {
    name: String,
    operator: AggregateMetricOperator,
    field: Option<String>,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
enum AggregateFieldKind {
    Text,
    DecimalBlob,
}

#[derive(Debug, Clone, PartialEq, Eq, PartialOrd, Ord)]
enum AggregateValue {
    Null,
    Text(String),
    Decimal(u64),
}

#[derive(Debug)]
enum AggregateMetricState {
    Count(u64),
    Distinct(BTreeSet<AggregateValue>),
    Sum { total: u128, count: u64 },
    Min(Option<AggregateValue>),
    Max(Option<AggregateValue>),
}

impl DeepQueryRequest {
    pub fn validate(&self) -> Result<(), QueryError> {
        if self.format != QUERY_REQUEST_FORMAT {
            return Err(invalid("query format is not supported"));
        }
        if !(1..=MAX_QUERY_LIMIT).contains(&self.limit) {
            return Err(invalid("query limit must be in 1..=50"));
        }
        if self.order_by.is_empty() || self.order_by.len() > MAX_ORDER_FIELDS {
            return Err(invalid("orderBy must contain 1..=4 fields"));
        }
        if self
            .cursor
            .as_ref()
            .is_some_and(|value| value.len() > MAX_CURSOR_BYTES)
        {
            return Err(invalid("query cursor is too large"));
        }
        crate::agent_query::parse_canonical_timestamp(&self.evaluated_at, "evaluatedAt")?;
        match &self.shape {
            DeepQueryShape::Records { select, .. } => {
                if select.is_empty() || select.len() > MAX_QUERY_FIELDS {
                    return Err(invalid("records select must contain 1..=64 fields"));
                }
                let unique = select.iter().collect::<BTreeSet<_>>();
                if unique.len() != select.len() {
                    return Err(invalid("records select fields must be unique"));
                }
                for field in select {
                    resource_select_field(self.resource, field)?;
                }
                validate_resource_order(self.resource, &self.order_by)?;
            }
            DeepQueryShape::Aggregate { group_by, metrics } => {
                if group_by.len() > 3 || metrics.is_empty() || metrics.len() > 8 {
                    return Err(invalid("aggregate groupBy and metrics exceed their bounds"));
                }
                if group_by.iter().collect::<BTreeSet<_>>().len() != group_by.len() {
                    return Err(invalid("aggregate groupBy fields must be unique"));
                }
                for field in group_by {
                    aggregate_field(self.resource, field)?;
                }
                let metrics = parse_aggregate_metrics(self.resource, metrics)?;
                validate_aggregate_order(&self.order_by, group_by, &metrics)?;
            }
        }
        if let Some(predicate) = &self.predicate {
            let mut stats = PredicateStats::default();
            validate_predicate(self.resource, predicate, 1, &mut stats)?;
        }
        Ok(())
    }
}

impl DeepEvidenceRequest {
    pub fn validate(&self) -> Result<(), QueryError> {
        validate_evidence_request(self)
    }
}

pub fn read_deep_query(
    connection: &Connection,
    request: &DeepQueryRequest,
) -> Result<DeepQueryResponse, QueryError> {
    request.validate()?;
    require_fact_v2(connection)?;
    let transaction = connection.unchecked_transaction().map_err(query_failed)?;
    let (database_uuid, snapshot_seq) = read_identity(&transaction)?;
    let request_digest = query_request_digest(request)?;
    let cursor = request
        .cursor
        .as_deref()
        .map(decode_query_cursor)
        .transpose()?;
    if let Some(cursor) = &cursor
        && (cursor.database_uuid != database_uuid
            || cursor.snapshot_seq != snapshot_seq
            || cursor.request_digest != request_digest)
    {
        return Err(stale(
            "query cursor does not belong to this snapshot or request",
        ));
    }

    if request.resource != DeepResource::Event {
        if matches!(request.shape, DeepQueryShape::Aggregate { .. }) {
            let response = read_aggregate_query(
                &transaction,
                request,
                &database_uuid,
                &snapshot_seq,
                &request_digest,
                cursor.as_ref(),
            )?;
            transaction.commit().map_err(query_failed)?;
            return Ok(response);
        }
        let response = read_typed_resource_query(
            &transaction,
            request,
            &database_uuid,
            &snapshot_seq,
            &request_digest,
            cursor.as_ref(),
        )?;
        transaction.commit().map_err(query_failed)?;
        return Ok(response);
    }

    if matches!(request.shape, DeepQueryShape::Aggregate { .. }) {
        let response = read_aggregate_query(
            &transaction,
            request,
            &database_uuid,
            &snapshot_seq,
            &request_digest,
            cursor.as_ref(),
        )?;
        transaction.commit().map_err(query_failed)?;
        return Ok(response);
    }

    let predicate = compile_event_predicate(request.predicate.as_ref())?;
    let mut where_sql = String::from(
        "s.eligibility='eligible' AND s.session_scope='main' AND NOT EXISTS (
           SELECT 1 FROM source_purge_states purge WHERE purge.session_key=s.session_key
         )",
    );
    if !predicate.sql.is_empty() {
        where_sql.push_str(" AND (");
        where_sql.push_str(&predicate.sql);
        where_sql.push(')');
    }
    let mut values = predicate.values;
    if let Some(cursor) = &cursor {
        if let Some(observed_at) = &cursor.observed_at {
            where_sql.push_str(
                " AND (he.observed_timestamp<? OR he.observed_timestamp IS NULL
                   OR (he.observed_timestamp=? AND he.event_key>?))",
            );
            values.push(SqlValue::Text(observed_at.clone()));
            values.push(SqlValue::Text(observed_at.clone()));
            values.push(SqlValue::Blob(decode_key(
                &cursor.stable_key,
                "cursor stableKey",
            )?));
        } else {
            where_sql.push_str(" AND he.observed_timestamp IS NULL AND he.event_key>?");
            values.push(SqlValue::Blob(decode_key(
                &cursor.stable_key,
                "cursor stableKey",
            )?));
        }
    }

    let total_match_count = if request.count == CountMode::Exact {
        let count = if let Some(event_kind) = exact_event_kind_predicate(request.predicate.as_ref())
        {
            projected_event_kind_count(&transaction, event_kind)?
        } else {
            let coverage_predicate = event_coverage_predicate(request.predicate.as_ref())?;
            let (count_from, count_where, count_values) = if let Some(predicate) =
                coverage_predicate
            {
                let mut where_sql = event_visibility_sql().to_owned();
                if !predicate.sql.is_empty() {
                    where_sql.push_str(" AND (");
                    where_sql.push_str(&predicate.sql);
                    where_sql.push(')');
                }
                (
                    "history_event_coverage he JOIN sessions s ON s.session_id=he.session_id",
                    where_sql,
                    predicate.values,
                )
            } else {
                let (where_sql, values) = where_without_cursor(request.predicate.as_ref())?;
                (
                    "history_events he JOIN sessions s ON s.session_id=he.session_id LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id",
                    where_sql,
                    values,
                )
            };
            let count_sql = format!("SELECT COUNT(*) FROM {count_from} WHERE {count_where}");
            let count: i64 = transaction
                .query_row(&count_sql, params_from_iter(count_values), |row| row.get(0))
                .map_err(query_failed)?;
            nonnegative(count, "query count")?
        };
        Some(count.to_string())
    } else {
        None
    };

    let sql = format!(
        "SELECT lower(hex(he.event_key)),lower(hex(s.session_key)),
                CASE WHEN t.turn_key IS NULL THEN NULL ELSE lower(hex(t.turn_key)) END,
                s.provider,
                CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                he.origin_scope,he.observed_timestamp,
                he.event_kind,he.completeness,lower(hex(he.revision)),he.metadata_json
         FROM history_events he
         JOIN sessions s ON s.session_id=he.session_id
         LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id
         WHERE {where_sql}
         ORDER BY he.observed_timestamp IS NULL ASC,he.observed_timestamp DESC,he.event_key ASC
         LIMIT ?",
    );
    values.push(SqlValue::Integer(i64::from(request.limit) + 1));
    let mut statement = transaction.prepare(&sql).map_err(query_failed)?;
    let rows = statement
        .query_map(params_from_iter(values), event_row)
        .map_err(query_failed)?;
    let mut events = rows.collect::<Result<Vec<_>, _>>().map_err(query_failed)?;
    drop(statement);
    let truncated = events.len() > usize::from(request.limit);
    events.truncate(usize::from(request.limit));

    let (select, payload_mode) = match &request.shape {
        DeepQueryShape::Records {
            select,
            payload_mode,
        } => (select, *payload_mode),
        DeepQueryShape::Aggregate { .. } => unreachable!("validated records shape"),
    };
    let mut records = Vec::with_capacity(events.len());
    for event in &events {
        let record = build_event_record(&transaction, event, select, payload_mode)?;
        if canonical_json(&record).len() > MAX_QUERY_PAGE_BYTES {
            return Err(QueryError::new(
                "TS_QUERY_TOO_BROAD",
                "a query record exceeds the bounded response page",
            ));
        }
        records.push(record);
    }
    let page_bytes = canonical_json(&Value::Array(records.clone())).len();
    if page_bytes > MAX_QUERY_PAGE_BYTES {
        return Err(QueryError::new(
            "TS_QUERY_TOO_BROAD",
            "query response exceeds the bounded response page",
        ));
    }
    let next_cursor = if truncated {
        let last = events
            .last()
            .ok_or_else(|| invalid("query cursor boundary is missing"))?;
        Some(encode_cursor(&QueryCursor {
            version: 1,
            database_uuid: database_uuid.clone(),
            snapshot_seq: snapshot_seq.clone(),
            request_digest,
            observed_at: last.observed_at.clone(),
            stable_key: last.event_key.clone(),
            ordinal: 0,
        })?)
    } else {
        None
    };
    let coverage = read_event_coverage(&transaction, request.predicate.as_ref())?;
    transaction.commit().map_err(query_failed)?;
    Ok(DeepQueryResponse {
        format: QUERY_RESPONSE_FORMAT.to_owned(),
        database_uuid,
        snapshot_seq,
        resource: request.resource,
        records: NullableRecordPage::some(records),
        groups: None,
        next_cursor,
        total_match_count,
        total_group_count: None,
        truncated,
        coverage,
        provenance: DeepProvenance {
            default: "recorded".to_owned(),
            fields: Vec::new(),
        },
        limits: DeepQueryLimits {
            page_bytes: MAX_QUERY_PAGE_BYTES.to_string(),
            payloads_may_require_evidence_paging: true,
        },
    })
}

pub fn read_deep_evidence(
    connection: &Connection,
    request: &DeepEvidenceRequest,
) -> Result<DeepEvidenceResponse, QueryError> {
    validate_evidence_request(request)?;
    require_fact_v2(connection)?;
    let transaction = connection.unchecked_transaction().map_err(query_failed)?;
    let (database_uuid, snapshot_seq) = read_identity(&transaction)?;
    let response = match &request.target {
        DeepEvidenceTarget::EventPayload {
            event_key,
            revision,
            payload_key: Some(payload_key),
        } => read_event_payload_evidence(
            &transaction,
            request,
            &database_uuid,
            &snapshot_seq,
            event_key,
            revision,
            payload_key,
        )?,
        _ => read_composite_evidence(&transaction, request, &database_uuid, &snapshot_seq)?,
    };
    transaction.commit().map_err(query_failed)?;
    Ok(response)
}

fn read_event_payload_evidence(
    connection: &Connection,
    request: &DeepEvidenceRequest,
    database_uuid: &str,
    snapshot_seq: &str,
    event_key: &str,
    revision: &str,
    payload_key: &str,
) -> Result<DeepEvidenceResponse, QueryError> {
    let event_bytes = decode_key(event_key, "eventKey")?;
    let payload_bytes = decode_key(payload_key, "payloadKey")?;
    decode_key(revision, "revision")?;
    let payload = connection
        .query_row(
            "SELECT lower(hex(he.revision)),lower(hex(hp.sha256)),hp.byte_length
             FROM history_events he
             JOIN history_payloads hp ON hp.event_key=he.event_key
             JOIN sessions s ON s.session_id=he.session_id
             WHERE he.event_key=?1 AND hp.payload_key=?2
               AND s.eligibility='eligible' AND s.session_scope='main'
               AND NOT EXISTS (
                 SELECT 1 FROM source_purge_states purge WHERE purge.session_key=s.session_key
               )",
            params![event_bytes, payload_bytes],
            |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    blob_u64(row.get(2)?)?,
                ))
            },
        )
        .optional()
        .map_err(query_failed)?
        .ok_or_else(|| {
            QueryError::new(
                "TS_INSIGHTS_EVIDENCE_NOT_FOUND",
                "evidence target was not found",
            )
        })?;
    if payload.0 != *revision {
        return Err(QueryError::new(
            "TS_INSIGHTS_EVIDENCE_CHANGED",
            "evidence revision changed before it could be read",
        ));
    }
    let cursor = request
        .cursor
        .as_deref()
        .map(decode_evidence_cursor)
        .transpose()?;
    let target_digest = evidence_target_digest(&request.target, &request.include)?;
    let (global_offset, chunk_ordinal, chunk_offset) = if let Some(cursor) = &cursor {
        if cursor.database_uuid != database_uuid
            || cursor.snapshot_seq != snapshot_seq
            || cursor.target_digest != target_digest
            || cursor.revision != *revision
            || cursor.payload_sha256 != payload.1
        {
            return Err(stale(
                "evidence cursor does not belong to this target or snapshot",
            ));
        }
        (
            cursor.global_offset,
            cursor
                .chunk_ordinal
                .ok_or_else(|| stale("evidence cursor is missing its chunk ordinal"))?,
            cursor
                .chunk_offset
                .ok_or_else(|| stale("evidence cursor is missing its chunk offset"))?,
        )
    } else {
        (0, 0, 0)
    };
    if global_offset > payload.2 {
        return Err(stale("evidence cursor offset is outside the payload"));
    }
    let (content, end, next_ordinal, next_chunk_offset) = read_payload_page(
        connection,
        &decode_key(payload_key, "payloadKey")?,
        global_offset,
        chunk_ordinal,
        chunk_offset,
        request.max_bytes,
    )?;
    let complete = end == payload.2;
    let next_cursor = if complete {
        None
    } else {
        Some(encode_cursor(&EvidenceCursor {
            version: 1,
            database_uuid: database_uuid.to_owned(),
            snapshot_seq: snapshot_seq.to_owned(),
            target_digest,
            revision: revision.to_owned(),
            payload_sha256: payload.1.clone(),
            global_offset: end,
            chunk_ordinal: Some(next_ordinal),
            chunk_offset: Some(next_chunk_offset),
        })?)
    };
    Ok(DeepEvidenceResponse {
        format: EVIDENCE_RESPONSE_FORMAT.to_owned(),
        database_uuid: database_uuid.to_owned(),
        snapshot_seq: snapshot_seq.to_owned(),
        target: request.target.clone(),
        revision: revision.to_owned(),
        payload_sha256: payload.1,
        total_bytes: payload.2.to_string(),
        range: EvidenceRange {
            start: global_offset.to_string(),
            end: end.to_string(),
        },
        content,
        next_cursor,
        complete,
    })
}

fn read_composite_evidence(
    connection: &Connection,
    request: &DeepEvidenceRequest,
    database_uuid: &str,
    snapshot_seq: &str,
) -> Result<DeepEvidenceResponse, QueryError> {
    let revision = composite_target_revision(connection, &request.target)?;
    let expected_revision = target_revision(&request.target);
    if revision != expected_revision {
        return Err(QueryError::new(
            "TS_INSIGHTS_PAYLOAD_CHANGED",
            "evidence target revision changed before it could be read",
        ));
    }
    let target_digest = evidence_target_digest(&request.target, &request.include)?;
    let (payload_sha256, total_bytes) = ensure_composite_evidence_cache(
        connection,
        &target_digest,
        snapshot_seq,
        &revision,
        &request.target,
        &request.include,
    )?;
    let cursor = request
        .cursor
        .as_deref()
        .map(decode_evidence_cursor)
        .transpose()?;
    let (start, ordinal, chunk_offset) = if let Some(cursor) = cursor {
        if cursor.database_uuid != database_uuid
            || cursor.snapshot_seq != snapshot_seq
            || cursor.target_digest != target_digest
            || cursor.revision != revision
            || cursor.payload_sha256 != payload_sha256
        {
            return Err(stale(
                "evidence cursor does not belong to this target or snapshot",
            ));
        }
        (
            cursor.global_offset,
            cursor
                .chunk_ordinal
                .ok_or_else(|| stale("evidence cursor is missing its stream ordinal"))?,
            cursor
                .chunk_offset
                .ok_or_else(|| stale("evidence cursor is missing its stream offset"))?,
        )
    } else {
        (0, 0, 0)
    };
    if start > total_bytes {
        return Err(stale("evidence cursor offset is outside the target"));
    }
    let (content, end, next_ordinal, next_chunk_offset) = read_cached_evidence_page(
        connection,
        &target_digest,
        start,
        ordinal,
        chunk_offset,
        request.max_bytes,
    )?;
    let complete = end == total_bytes;
    let next_cursor = (!complete)
        .then(|| {
            encode_cursor(&EvidenceCursor {
                version: 1,
                database_uuid: database_uuid.to_owned(),
                snapshot_seq: snapshot_seq.to_owned(),
                target_digest: target_digest.clone(),
                revision: revision.clone(),
                payload_sha256: payload_sha256.clone(),
                global_offset: end,
                chunk_ordinal: Some(next_ordinal),
                chunk_offset: Some(next_chunk_offset),
            })
        })
        .transpose()?;
    if complete {
        clear_composite_evidence_cache(connection, &target_digest)?;
    }
    Ok(DeepEvidenceResponse {
        format: EVIDENCE_RESPONSE_FORMAT.to_owned(),
        database_uuid: database_uuid.to_owned(),
        snapshot_seq: snapshot_seq.to_owned(),
        target: request.target.clone(),
        revision,
        payload_sha256,
        total_bytes: total_bytes.to_string(),
        range: EvidenceRange {
            start: start.to_string(),
            end: end.to_string(),
        },
        content,
        next_cursor,
        complete,
    })
}

fn target_revision(target: &DeepEvidenceTarget) -> &str {
    match target {
        DeepEvidenceTarget::EventPayload { revision, .. }
        | DeepEvidenceTarget::Turn { revision, .. }
        | DeepEvidenceTarget::Session { revision, .. }
        | DeepEvidenceTarget::AttemptChain { revision, .. } => revision,
    }
}

fn composite_target_revision(
    connection: &Connection,
    target: &DeepEvidenceTarget,
) -> Result<String, QueryError> {
    let visible = "s.eligibility='eligible' AND s.session_scope='main'
                   AND NOT EXISTS (SELECT 1 FROM source_purge_states purge
                                   WHERE purge.session_key=s.session_key)";
    let revision = match target {
        DeepEvidenceTarget::Turn { turn_key, .. } => connection
            .query_row(
                &format!(
                    "SELECT lower(hex(t.revision)) FROM turns t
                     JOIN sessions s ON s.session_id=t.session_id
                     WHERE t.turn_key=?1 AND t.effective_provider_visibility='active'
                       AND t.revision IS NOT NULL AND {visible}"
                ),
                [decode_key(turn_key, "turnKey")?],
                |row| row.get(0),
            )
            .optional()
            .map_err(query_failed)?,
        DeepEvidenceTarget::Session { session_key, .. } => connection
            .query_row(
                &format!(
                    "SELECT lower(hex(sc.canonical_digest)) FROM sessions s
                     JOIN session_commits sc ON sc.session_id=s.session_id
                     WHERE s.session_key=?1 AND {visible}"
                ),
                [decode_key(session_key, "sessionKey")?],
                |row| row.get(0),
            )
            .optional()
            .map_err(query_failed)?,
        DeepEvidenceTarget::AttemptChain { chain_key, .. } => {
            Some(read_attempt_chain_revision(connection, chain_key)?)
        }
        DeepEvidenceTarget::EventPayload { event_key, .. } => connection
            .query_row(
                &format!(
                    "SELECT lower(hex(he.revision)) FROM history_events he
                     JOIN sessions s ON s.session_id=he.session_id
                     WHERE he.event_key=?1 AND {visible}"
                ),
                [decode_key(event_key, "eventKey")?],
                |row| row.get(0),
            )
            .optional()
            .map_err(query_failed)?,
    };
    revision.ok_or_else(|| {
        QueryError::new(
            "TS_INSIGHTS_EVIDENCE_NOT_FOUND",
            "evidence target was not found",
        )
    })
}

fn evidence_target_digest(
    target: &DeepEvidenceTarget,
    include: &[String],
) -> Result<String, QueryError> {
    let value = json!({ "target": target, "include": include });
    Ok(hex::encode(Sha256::digest(
        canonical_json(&value).as_bytes(),
    )))
}

fn ensure_composite_evidence_cache(
    connection: &Connection,
    cache_key: &str,
    snapshot_seq: &str,
    revision: &str,
    target: &DeepEvidenceTarget,
    include: &[String],
) -> Result<(String, u64), QueryError> {
    connection
        .execute_batch(
            "CREATE TEMP TABLE IF NOT EXISTS deep_evidence_stream_cache (
               cache_key TEXT NOT NULL,
               ordinal INTEGER NOT NULL,
               content TEXT NOT NULL,
               PRIMARY KEY(cache_key,ordinal)
             ) WITHOUT ROWID;
             CREATE TEMP TABLE IF NOT EXISTS deep_evidence_stream_meta (
               cache_key TEXT PRIMARY KEY,
               snapshot_seq TEXT NOT NULL,
               revision TEXT NOT NULL,
               payload_sha256 TEXT NOT NULL,
               total_bytes BLOB NOT NULL CHECK(length(total_bytes)=8)
             ) WITHOUT ROWID;",
        )
        .map_err(query_failed)?;
    if let Some(cached) = connection
        .query_row(
            "SELECT payload_sha256,total_bytes FROM deep_evidence_stream_meta
             WHERE cache_key=?1 AND snapshot_seq=?2 AND revision=?3",
            params![cache_key, snapshot_seq, revision],
            |row| Ok((row.get::<_, String>(0)?, blob_u64(row.get(1)?)?)),
        )
        .optional()
        .map_err(query_failed)?
    {
        return Ok(cached);
    }
    connection
        .execute("DELETE FROM deep_evidence_stream_cache", [])
        .map_err(query_failed)?;
    connection
        .execute("DELETE FROM deep_evidence_stream_meta", [])
        .map_err(query_failed)?;
    let mut digest = Sha256::new();
    let mut total_bytes = 0_u64;
    let mut ordinal = 0_u64;
    for_each_composite_evidence_line(connection, target, include, |line| {
        let line_bytes = u64::try_from(line.len())
            .map_err(|_| QueryError::new("QUERY_FAILED", "evidence line is too large"))?;
        total_bytes = total_bytes
            .checked_add(line_bytes)
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "evidence target is too large"))?;
        digest.update(line.as_bytes());
        connection
            .execute(
                "INSERT INTO deep_evidence_stream_cache(cache_key,ordinal,content)
                 VALUES (?1,?2,?3)",
                params![
                    cache_key,
                    i64::try_from(ordinal).map_err(|_| QueryError::new(
                        "QUERY_FAILED",
                        "evidence stream contains too many lines",
                    ))?,
                    line,
                ],
            )
            .map_err(query_failed)?;
        ordinal = ordinal
            .checked_add(1)
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "evidence ordinal overflowed"))?;
        Ok(())
    })?;
    let payload_sha256 = hex::encode(digest.finalize());
    connection
        .execute(
            "INSERT INTO deep_evidence_stream_meta(
               cache_key,snapshot_seq,revision,payload_sha256,total_bytes
             ) VALUES (?1,?2,?3,?4,?5)",
            params![
                cache_key,
                snapshot_seq,
                revision,
                &payload_sha256,
                total_bytes.to_be_bytes().to_vec(),
            ],
        )
        .map_err(query_failed)?;
    Ok((payload_sha256, total_bytes))
}

fn for_each_composite_evidence_line(
    connection: &Connection,
    target: &DeepEvidenceTarget,
    include: &[String],
    mut apply: impl FnMut(String) -> Result<(), QueryError>,
) -> Result<(), QueryError> {
    let (from_sql, predicate_sql, key, active_turn) = match target {
        DeepEvidenceTarget::Turn { turn_key, .. } => (
            "FROM history_events he
             JOIN sessions s ON s.session_id=he.session_id
             LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id",
            "t.turn_key=?1",
            decode_key(turn_key, "turnKey")?,
            true,
        ),
        DeepEvidenceTarget::Session { session_key, .. } => (
            "FROM history_events he
             JOIN sessions s ON s.session_id=he.session_id
             LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id",
            "s.session_key=?1",
            decode_key(session_key, "sessionKey")?,
            false,
        ),
        DeepEvidenceTarget::AttemptChain { chain_key, .. } => (
            "FROM attempt_chain_events ace
             JOIN history_events he ON he.event_key=ace.event_key
             JOIN sessions s ON s.session_id=he.session_id
             LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id",
            "ace.chain_key=?1",
            decode_key(chain_key, "chainKey")?,
            false,
        ),
        DeepEvidenceTarget::EventPayload { event_key, .. } => (
            "FROM history_events he
             JOIN sessions s ON s.session_id=he.session_id
             LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id",
            "he.event_key=?1",
            decode_key(event_key, "eventKey")?,
            false,
        ),
    };
    let active_turn_sql = if active_turn {
        "AND t.effective_provider_visibility='active'"
    } else {
        ""
    };
    let sql = format!(
        "SELECT lower(hex(he.event_key)),lower(hex(s.session_key)),
                CASE WHEN t.turn_key IS NULL THEN NULL ELSE lower(hex(t.turn_key)) END,
                s.provider,
                CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                he.origin_scope,he.observed_timestamp,
                he.event_kind,he.completeness,lower(hex(he.revision)),he.metadata_json
         {from_sql}
         WHERE {predicate_sql} {active_turn_sql}
           AND s.eligibility='eligible' AND s.session_scope='main'
           AND NOT EXISTS (SELECT 1 FROM source_purge_states purge
                           WHERE purge.session_key=s.session_key)
         ORDER BY he.record_start_offset,he.content_index,he.event_ordinal,he.event_key"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement.query([key]).map_err(query_failed)?;
    let envelope = include.iter().any(|value| value == "envelope");
    let payload = include.iter().any(|value| value == "payload");
    while let Some(row) = rows.next().map_err(query_failed)? {
        let event = event_row(row).map_err(query_failed)?;
        if envelope {
            apply(evidence_line(json!({
                "format": "threadshare-insights-evidence-line@v1",
                "event": {
                    "eventKey": event.event_key,
                    "sessionKey": event.session_key,
                    "turnKey": event.turn_key,
                    "provider": event.provider,
                    "projectKey": event.project_key,
                    "originScope": event.origin_scope,
                    "observedAt": event.observed_at,
                    "kind": event.kind,
                    "completeness": event.completeness,
                    "revision": event.revision,
                    "metadata": event.metadata,
                }
            })))?;
        }
        if payload {
            for_each_event_payload_line(connection, &event.event_key, &mut apply)?;
        }
    }
    Ok(())
}

fn for_each_event_payload_line(
    connection: &Connection,
    event_key: &str,
    apply: &mut impl FnMut(String) -> Result<(), QueryError>,
) -> Result<(), QueryError> {
    let event_key_bytes = decode_key(event_key, "eventKey")?;
    let mut payload_statement = connection
        .prepare(
            "SELECT payload_key,payload_kind,encoding,byte_length,lower(hex(sha256)),completeness
             FROM history_payloads WHERE event_key=?1 ORDER BY payload_key",
        )
        .map_err(query_failed)?;
    let mut payload_rows = payload_statement
        .query([event_key_bytes])
        .map_err(query_failed)?;
    while let Some(row) = payload_rows.next().map_err(query_failed)? {
        let payload_key = row.get::<_, Vec<u8>>(0).map_err(query_failed)?;
        let payload_key_hex = hex::encode(&payload_key);
        apply(evidence_line(json!({
            "format": "threadshare-insights-evidence-line@v1",
            "payload": {
                "payloadKey": payload_key_hex,
                "eventKey": event_key,
                "kind": row.get::<_, String>(1).map_err(query_failed)?,
                "encoding": row.get::<_, String>(2).map_err(query_failed)?,
                "byteLength": blob_u64(row.get(3).map_err(query_failed)?).map_err(query_failed)?.to_string(),
                "sha256": row.get::<_, String>(4).map_err(query_failed)?,
                "completeness": row.get::<_, String>(5).map_err(query_failed)?,
            }
        })))?;
        let mut chunk_statement = connection
            .prepare(
                "SELECT ordinal,content,byte_length,lower(hex(sha256))
                 FROM history_payload_chunks WHERE payload_key=?1 ORDER BY ordinal",
            )
            .map_err(query_failed)?;
        let mut chunk_rows = chunk_statement
            .query([&payload_key])
            .map_err(query_failed)?;
        while let Some(chunk) = chunk_rows.next().map_err(query_failed)? {
            apply(evidence_line(json!({
                "format": "threadshare-insights-evidence-line@v1",
                "payloadChunk": {
                    "payloadKey": payload_key_hex,
                    "ordinal": blob_u64(chunk.get(0).map_err(query_failed)?).map_err(query_failed)?.to_string(),
                    "content": chunk.get::<_, String>(1).map_err(query_failed)?,
                    "byteLength": blob_u64(chunk.get(2).map_err(query_failed)?).map_err(query_failed)?.to_string(),
                    "sha256": chunk.get::<_, String>(3).map_err(query_failed)?,
                }
            })))?;
        }
    }
    Ok(())
}

fn evidence_line(value: Value) -> String {
    let mut line = canonical_json(&value);
    line.push('\n');
    line
}

fn read_cached_evidence_page(
    connection: &Connection,
    cache_key: &str,
    global_offset: u64,
    ordinal: u64,
    chunk_offset: u64,
    max_bytes: u32,
) -> Result<(String, u64, u64, u64), QueryError> {
    let mut statement = connection
        .prepare(
            "SELECT ordinal,content FROM deep_evidence_stream_cache
             WHERE cache_key=?1 AND ordinal>=?2 ORDER BY ordinal",
        )
        .map_err(query_failed)?;
    let mut rows = statement
        .query(params![
            cache_key,
            i64::try_from(ordinal).map_err(|_| stale("evidence cursor ordinal is invalid"))?
        ])
        .map_err(query_failed)?;
    let mut output = Vec::with_capacity(max_bytes as usize);
    let mut next_ordinal = ordinal;
    let mut next_chunk_offset = chunk_offset;
    while output.len() < max_bytes as usize {
        let Some(row) = rows.next().map_err(query_failed)? else {
            break;
        };
        let current_ordinal = u64::try_from(row.get::<_, i64>(0).map_err(query_failed)?)
            .map_err(|_| QueryError::new("QUERY_FAILED", "evidence ordinal is invalid"))?;
        let content = row.get::<_, String>(1).map_err(query_failed)?;
        let offset = if current_ordinal == ordinal {
            usize::try_from(chunk_offset).map_err(|_| stale("evidence cursor offset is invalid"))?
        } else {
            0
        };
        if offset > content.len() || !content.is_char_boundary(offset) {
            return Err(stale("evidence cursor is not on a UTF-8 boundary"));
        }
        let remaining = max_bytes as usize - output.len();
        let mut take = remaining.min(content.len() - offset);
        while take > 0 && !content.is_char_boundary(offset + take) {
            take -= 1;
        }
        if take == 0 && offset < content.len() {
            break;
        }
        output.extend_from_slice(&content.as_bytes()[offset..offset + take]);
        if offset + take < content.len() {
            next_ordinal = current_ordinal;
            next_chunk_offset = u64::try_from(offset + take)
                .map_err(|_| QueryError::new("QUERY_FAILED", "evidence offset is invalid"))?;
            break;
        }
        next_ordinal = current_ordinal
            .checked_add(1)
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "evidence ordinal overflowed"))?;
        next_chunk_offset = 0;
    }
    let content = String::from_utf8(output)
        .map_err(|_| QueryError::new("QUERY_FAILED", "stored evidence is not valid UTF-8"))?;
    let end = global_offset
        .checked_add(content.len() as u64)
        .ok_or_else(|| QueryError::new("QUERY_FAILED", "evidence range overflowed"))?;
    Ok((content, end, next_ordinal, next_chunk_offset))
}

fn clear_composite_evidence_cache(
    connection: &Connection,
    cache_key: &str,
) -> Result<(), QueryError> {
    connection
        .execute(
            "DELETE FROM deep_evidence_stream_cache WHERE cache_key=?1",
            [cache_key],
        )
        .map_err(query_failed)?;
    connection
        .execute(
            "DELETE FROM deep_evidence_stream_meta WHERE cache_key=?1",
            [cache_key],
        )
        .map_err(query_failed)?;
    Ok(())
}

fn resource_from_sql(resource: DeepResource) -> &'static str {
    match resource {
        DeepResource::Session => {
            "FROM sessions s JOIN session_commits sc ON sc.session_id=s.session_id"
        }
        DeepResource::Turn => "FROM turns t JOIN sessions s ON s.session_id=t.session_id",
        DeepResource::CapabilityUse => {
            "FROM capability_uses cu
             JOIN turns t ON t.turn_id=cu.turn_id
             JOIN sessions s ON s.session_id=cu.session_id
             JOIN capabilities c ON c.capability_id=cu.capability_id
             LEFT JOIN history_events invocation_event ON invocation_event.event_key=(
               SELECT ace.event_key FROM attempt_chain_events ace
               JOIN history_events chain_event ON chain_event.event_key=ace.event_key
               WHERE ace.session_id=cu.session_id
                 AND ace.correlation_digest=cu.correlation_digest
                 AND chain_event.event_kind='capability-invocation'
               ORDER BY chain_event.record_start_offset,chain_event.content_index,
                        chain_event.event_ordinal,chain_event.event_key
               LIMIT 1
             )
             LEFT JOIN attempt_chain_events invocation_chain
               ON invocation_chain.event_key=invocation_event.event_key"
        }
        DeepResource::FileActivity => {
            "FROM file_activity fa
             JOIN history_events he ON he.event_key=fa.event_key
             JOIN sessions s ON s.session_id=he.session_id
             LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id"
        }
        DeepResource::TokenUsage => {
            "FROM token_usage tu
             JOIN history_events he ON he.event_key=tu.event_key
             JOIN sessions s ON s.session_id=he.session_id
             LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id"
        }
        DeepResource::ErrorOccurrence => {
            "FROM error_occurrences eo
             JOIN history_events he ON he.event_key=eo.event_key
             JOIN sessions s ON s.session_id=he.session_id
             LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id
             LEFT JOIN capabilities c ON c.capability_key=eo.capability_key"
        }
        DeepResource::Event => unreachable!("event has its own query path"),
    }
}

fn resource_select_sql(resource: DeepResource) -> &'static str {
    match resource {
        DeepResource::Session => {
            "SELECT s.observed_end,lower(hex(s.session_key)),0,s.provider,
                    CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                    s.session_scope,s.eligibility,s.observed_start,s.observed_end,
                    lower(hex(sc.canonical_digest)),
                    EXISTS(SELECT 1 FROM session_fact_truncation st WHERE st.session_id=s.session_id)"
        }
        DeepResource::Turn => {
            "SELECT t.observed_timestamp,lower(hex(t.turn_key)),0,
                    lower(hex(s.session_key)),s.provider,
                    CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                    t.problem_text,t.final_answer_excerpt,t.provider_terminal,
                    t.effective_provider_visibility,
                    CASE WHEN t.revision IS NULL THEN NULL ELSE lower(hex(t.revision)) END,
                    EXISTS(SELECT 1 FROM turn_fact_truncation tt WHERE tt.turn_id=t.turn_id)"
        }
        DeepResource::CapabilityUse => {
            "SELECT COALESCE(invocation_event.observed_timestamp,t.observed_timestamp),
                    lower(hex(cu.use_key)),0,
                    lower(hex(t.turn_key)),lower(hex(s.session_key)),s.provider,
                    CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                    cu.origin_scope,lower(hex(c.capability_key)),c.capability_kind,
                    c.canonical_name,cu.exact_observed_name,cu.provider_terminal_state,
                    cu.strength,
                    CASE WHEN cu.input_fingerprint IS NULL THEN NULL ELSE lower(hex(cu.input_fingerprint)) END,
                    CASE WHEN cu.correlation_digest IS NULL THEN NULL ELSE lower(hex(cu.correlation_digest)) END,
                    CASE WHEN invocation_chain.chain_key IS NULL THEN NULL
                         ELSE lower(hex(invocation_chain.chain_key)) END"
        }
        DeepResource::FileActivity => {
            "SELECT fa.observed_timestamp,lower(hex(fa.event_key)),fa.activity_ordinal,
                    CASE WHEN t.turn_key IS NULL THEN NULL ELSE lower(hex(t.turn_key)) END,
                    lower(hex(s.session_key)),s.provider,
                    CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                    fa.action,fa.phase,fa.path_role,fa.raw_path,fa.normalized_path,
                    fa.relative_path,fa.is_absolute,fa.is_project_relative,lower(hex(he.revision))"
        }
        DeepResource::TokenUsage => {
            "SELECT tu.observed_timestamp,lower(hex(tu.event_key)),0,
                    CASE WHEN t.turn_key IS NULL THEN NULL ELSE lower(hex(t.turn_key)) END,
                    lower(hex(s.session_key)),s.provider,
                    CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                    tu.usage_scope,tu.model,tu.input_tokens,tu.cached_input_tokens,
                    tu.cache_write_input_tokens,tu.output_tokens,tu.reasoning_tokens,
                    tu.total_tokens,lower(hex(he.revision))"
        }
        DeepResource::ErrorOccurrence => {
            "SELECT eo.observed_timestamp,lower(hex(eo.event_key)),0,
                    CASE WHEN t.turn_key IS NULL THEN NULL ELSE lower(hex(t.turn_key)) END,
                    lower(hex(s.session_key)),s.provider,
                    CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                    eo.signature_version,lower(hex(eo.error_signature)),
                    CASE WHEN eo.capability_key IS NULL THEN NULL ELSE lower(hex(eo.capability_key)) END,
                    c.canonical_name,eo.provider_state,eo.exit_code,lower(hex(he.revision))"
        }
        DeepResource::Event => unreachable!("event has its own query path"),
    }
}

fn resource_stable_column(resource: DeepResource) -> &'static str {
    match resource {
        DeepResource::Session => "s.session_key",
        DeepResource::Turn => "t.turn_key",
        DeepResource::CapabilityUse => "cu.use_key",
        DeepResource::FileActivity => "fa.event_key",
        DeepResource::TokenUsage => "tu.event_key",
        DeepResource::ErrorOccurrence => "eo.event_key",
        DeepResource::Event => "he.event_key",
    }
}

fn resource_ordinal_column(resource: DeepResource) -> &'static str {
    if resource == DeepResource::FileActivity {
        "fa.activity_ordinal"
    } else {
        "(0+0)"
    }
}

fn resource_visibility_sql(resource: DeepResource) -> &'static str {
    match resource {
        DeepResource::Turn | DeepResource::CapabilityUse => {
            "s.eligibility='eligible' AND s.session_scope='main'
             AND t.effective_provider_visibility='active'
             AND NOT EXISTS (SELECT 1 FROM source_purge_states purge
                             WHERE purge.session_key=s.session_key)"
        }
        _ => {
            "s.eligibility='eligible' AND s.session_scope='main'
             AND NOT EXISTS (SELECT 1 FROM source_purge_states purge
                             WHERE purge.session_key=s.session_key)"
        }
    }
}

fn aggregate_from_sql(resource: DeepResource) -> &'static str {
    if resource == DeepResource::Event {
        "FROM history_events he
         JOIN sessions s ON s.session_id=he.session_id
         LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id"
    } else {
        resource_from_sql(resource)
    }
}

fn aggregate_field(
    resource: DeepResource,
    field: &str,
) -> Result<(&'static str, AggregateFieldKind), QueryError> {
    let text = AggregateFieldKind::Text;
    let decimal = AggregateFieldKind::DecimalBlob;
    let value = match field {
        "provider" => ("s.provider", text),
        "projectKey" => (
            "CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END",
            text,
        ),
        "sessionKey" => ("lower(hex(s.session_key))", text),
        "turnKey" if resource != DeepResource::Session => (
            "CASE WHEN t.turn_key IS NULL THEN NULL ELSE lower(hex(t.turn_key)) END",
            text,
        ),
        "observedAt" => (resource_observed_column(resource), text),
        "originScope" if resource == DeepResource::Event => ("he.origin_scope", text),
        "originScope" if resource == DeepResource::CapabilityUse => ("cu.origin_scope", text),
        "completeness" if resource == DeepResource::Event => ("he.completeness", text),
        "session.startedAt" if resource == DeepResource::Session => ("s.observed_start", text),
        "session.endedAt" if resource == DeepResource::Session => ("s.observed_end", text),
        "revision" if resource == DeepResource::Session => {
            ("lower(hex(sc.canonical_digest))", text)
        }
        "revision" if resource == DeepResource::Turn => (
            "CASE WHEN t.revision IS NULL THEN NULL ELSE lower(hex(t.revision)) END",
            text,
        ),
        "revision" if resource == DeepResource::Event => ("lower(hex(he.revision))", text),
        "event.kind" if resource == DeepResource::Event => ("he.event_kind", text),
        "message.role" if resource == DeepResource::Event => {
            ("json_extract(he.metadata_json,'$.role')", text)
        }
        "turn.providerTerminal" if resource == DeepResource::Turn => ("t.provider_terminal", text),
        "turn.visibility" if resource == DeepResource::Turn => {
            ("t.effective_provider_visibility", text)
        }
        "capability.key" if resource == DeepResource::CapabilityUse => {
            ("lower(hex(c.capability_key))", text)
        }
        "capability.kind" if resource == DeepResource::CapabilityUse => ("c.capability_kind", text),
        "capability.canonicalName" if resource == DeepResource::CapabilityUse => {
            ("c.canonical_name", text)
        }
        "capability.observedName" if resource == DeepResource::CapabilityUse => {
            ("cu.exact_observed_name", text)
        }
        "capability.terminalState" if resource == DeepResource::CapabilityUse => {
            ("cu.provider_terminal_state", text)
        }
        "capability.strength" if resource == DeepResource::CapabilityUse => ("cu.strength", text),
        "capability.inputFingerprint" if resource == DeepResource::CapabilityUse => (
            "CASE WHEN cu.input_fingerprint IS NULL THEN NULL ELSE lower(hex(cu.input_fingerprint)) END",
            text,
        ),
        "capability.correlationDigest" if resource == DeepResource::CapabilityUse => (
            "CASE WHEN cu.correlation_digest IS NULL THEN NULL ELSE lower(hex(cu.correlation_digest)) END",
            text,
        ),
        "file.action" if resource == DeepResource::FileActivity => ("fa.action", text),
        "file.phase" if resource == DeepResource::FileActivity => ("fa.phase", text),
        "file.pathRole" if resource == DeepResource::FileActivity => ("fa.path_role", text),
        "file.rawPath" if resource == DeepResource::FileActivity => ("fa.raw_path", text),
        "file.normalizedPath" if resource == DeepResource::FileActivity => {
            ("fa.normalized_path", text)
        }
        "file.relativePath" if resource == DeepResource::FileActivity => ("fa.relative_path", text),
        "token.scope" if resource == DeepResource::TokenUsage => ("tu.usage_scope", text),
        "token.model" if resource == DeepResource::TokenUsage => ("tu.model", text),
        "token.input" if resource == DeepResource::TokenUsage => ("tu.input_tokens", decimal),
        "token.cachedInput" if resource == DeepResource::TokenUsage => {
            ("tu.cached_input_tokens", decimal)
        }
        "token.cacheWriteInput" if resource == DeepResource::TokenUsage => {
            ("tu.cache_write_input_tokens", decimal)
        }
        "token.output" if resource == DeepResource::TokenUsage => ("tu.output_tokens", decimal),
        "token.reasoning" if resource == DeepResource::TokenUsage => {
            ("tu.reasoning_tokens", decimal)
        }
        "token.total" if resource == DeepResource::TokenUsage => ("tu.total_tokens", decimal),
        "error.signatureVersion" if resource == DeepResource::ErrorOccurrence => {
            ("eo.signature_version", text)
        }
        "error.signature" if resource == DeepResource::ErrorOccurrence => {
            ("lower(hex(eo.error_signature))", text)
        }
        "error.providerState" if resource == DeepResource::ErrorOccurrence => {
            ("eo.provider_state", text)
        }
        "error.exitCode" if resource == DeepResource::ErrorOccurrence => ("eo.exit_code", decimal),
        "capability.key" if resource == DeepResource::ErrorOccurrence => (
            "CASE WHEN eo.capability_key IS NULL THEN NULL ELSE lower(hex(eo.capability_key)) END",
            text,
        ),
        "capability.canonicalName" if resource == DeepResource::ErrorOccurrence => {
            ("c.canonical_name", text)
        }
        _ => {
            return Err(invalid(format!(
                "field {field} is not aggregatable for this resource"
            )));
        }
    };
    Ok(value)
}

fn parse_aggregate_metrics(
    resource: DeepResource,
    values: &[Value],
) -> Result<Vec<AggregateMetric>, QueryError> {
    let mut names = BTreeSet::new();
    values
        .iter()
        .map(|value| {
            let object = value
                .as_object()
                .ok_or_else(|| invalid("aggregate metric must be an object"))?;
            let expected = if object.contains_key("field") {
                ["field", "name", "op"].as_slice()
            } else {
                ["name", "op"].as_slice()
            };
            if object.len() != expected.len()
                || expected.iter().any(|field| !object.contains_key(*field))
            {
                return Err(invalid("aggregate metric fields are invalid"));
            }
            let name = object
                .get("name")
                .and_then(Value::as_str)
                .filter(|name| {
                    (1..=64).contains(&name.len())
                        && name.bytes().enumerate().all(|(index, byte)| {
                            byte.is_ascii_alphanumeric() || (index > 0 && byte == b'-')
                        })
                })
                .ok_or_else(|| invalid("aggregate metric name is invalid"))?
                .to_owned();
            if !names.insert(name.clone()) {
                return Err(invalid("aggregate metric names must be unique"));
            }
            let operator = match object.get("op").and_then(Value::as_str) {
                Some("count") => AggregateMetricOperator::Count,
                Some("distinct-count") => AggregateMetricOperator::DistinctCount,
                Some("sum") => AggregateMetricOperator::Sum,
                Some("min") => AggregateMetricOperator::Min,
                Some("max") => AggregateMetricOperator::Max,
                Some("average") => AggregateMetricOperator::Average,
                _ => return Err(invalid("aggregate metric operator is invalid")),
            };
            let field = object
                .get("field")
                .and_then(Value::as_str)
                .map(str::to_owned);
            if (operator == AggregateMetricOperator::Count) != field.is_none() {
                return Err(invalid(
                    "count must omit field and all other aggregate metrics require field",
                ));
            }
            if let Some(field) = &field {
                let (_, kind) = aggregate_field(resource, field)?;
                if matches!(
                    operator,
                    AggregateMetricOperator::Sum | AggregateMetricOperator::Average
                ) && kind != AggregateFieldKind::DecimalBlob
                {
                    return Err(invalid("sum and average require a numeric field"));
                }
            }
            Ok(AggregateMetric {
                name,
                operator,
                field,
            })
        })
        .collect()
}

fn validate_aggregate_order(
    order: &[DeepOrderBy],
    group_by: &[String],
    metrics: &[AggregateMetric],
) -> Result<(), QueryError> {
    if order.len() != group_by.len() + 1
        || !metrics.iter().any(|metric| metric.name == order[0].field)
        || order[1..].iter().zip(group_by).any(|(actual, expected)| {
            actual.field != *expected || actual.direction != Direction::Asc
        })
    {
        return Err(invalid(
            "aggregate orderBy must start with one metric and end with groupBy ascending",
        ));
    }
    Ok(())
}

fn read_aggregate_query(
    connection: &Connection,
    request: &DeepQueryRequest,
    database_uuid: &str,
    snapshot_seq: &str,
    request_digest: &str,
    cursor: Option<&QueryCursor>,
) -> Result<DeepQueryResponse, QueryError> {
    let DeepQueryShape::Aggregate { group_by, metrics } = &request.shape else {
        unreachable!("aggregate reader requires an aggregate shape")
    };
    let metrics = parse_aggregate_metrics(request.resource, metrics)?;
    if token_provider_rollup_supported(request, group_by, &metrics) {
        return read_token_provider_rollup(
            connection,
            request,
            group_by,
            &metrics,
            database_uuid,
            snapshot_seq,
            request_digest,
            cursor,
        );
    }
    let predicate = compile_resource_predicate(request.resource, request.predicate.as_ref())?;
    let mut where_sql = resource_visibility_sql(request.resource).to_owned();
    if !predicate.sql.is_empty() {
        where_sql.push_str(" AND (");
        where_sql.push_str(&predicate.sql);
        where_sql.push(')');
    }
    let from_sql = aggregate_from_sql(request.resource);
    let candidate_sql = format!("SELECT COUNT(*) {from_sql} WHERE {where_sql}");
    let candidate_count = connection
        .query_row(
            &candidate_sql,
            params_from_iter(predicate.values.iter()),
            |row| row.get::<_, i64>(0),
        )
        .map_err(query_failed)
        .and_then(|value| nonnegative(value, "aggregate candidate count"))?;
    if candidate_count > MAX_AGGREGATE_CANDIDATES {
        return Err(QueryError::new(
            "TS_QUERY_TOO_BROAD",
            "aggregate candidate set exceeds its exact work budget",
        ));
    }

    let group_fields = group_by
        .iter()
        .map(|field| aggregate_field(request.resource, field))
        .collect::<Result<Vec<_>, _>>()?;
    let metric_fields = metrics
        .iter()
        .map(|metric| {
            metric
                .field
                .as_deref()
                .map(|field| aggregate_field(request.resource, field))
                .transpose()
        })
        .collect::<Result<Vec<_>, _>>()?;
    let mut select = group_fields
        .iter()
        .map(|field| field.0.to_owned())
        .collect::<Vec<_>>();
    select.extend(metric_fields.iter().map(|field| {
        field
            .map(|field| field.0.to_owned())
            .unwrap_or_else(|| "NULL".to_owned())
    }));
    let sql = format!("SELECT {} {from_sql} WHERE {where_sql}", select.join(","));
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(predicate.values.iter()))
        .map_err(query_failed)?;
    let mut groups = BTreeMap::<Vec<AggregateValue>, Vec<AggregateMetricState>>::new();
    let mut distinct_value_count = 0_usize;
    while let Some(row) = rows.next().map_err(query_failed)? {
        let group = group_fields
            .iter()
            .enumerate()
            .map(|(index, (_, kind))| aggregate_row_value(row, index, *kind))
            .collect::<Result<Vec<_>, _>>()?;
        if !groups.contains_key(&group) && groups.len() >= MAX_AGGREGATE_GROUPS {
            return Err(QueryError::new(
                "TS_QUERY_TOO_BROAD",
                "aggregate group count exceeds its exact work budget",
            ));
        }
        let states = groups
            .entry(group)
            .or_insert_with(|| metrics.iter().map(initial_metric_state).collect());
        for (index, (metric, state)) in metrics.iter().zip(states.iter_mut()).enumerate() {
            let value = metric_fields[index]
                .map(|(_, kind)| aggregate_row_value(row, group_fields.len() + index, kind))
                .transpose()?;
            update_metric_state(metric, state, value, &mut distinct_value_count)?;
        }
    }
    drop(rows);
    drop(statement);

    let primary_metric = metrics
        .iter()
        .position(|metric| metric.name == request.order_by[0].field)
        .ok_or_else(|| invalid("aggregate order metric is missing"))?;
    let direction = request.order_by[0].direction;
    let mut groups = groups.into_iter().collect::<Vec<_>>();
    groups.sort_by(|left, right| {
        let metric = compare_metric_state(
            &metrics[primary_metric],
            &left.1[primary_metric],
            &right.1[primary_metric],
        );
        let metric = if direction == Direction::Desc {
            metric.reverse()
        } else {
            metric
        };
        metric.then_with(|| compare_group_keys(&left.0, &right.0))
    });
    let total_group_count = u64::try_from(groups.len())
        .map_err(|_| QueryError::new("QUERY_FAILED", "aggregate group count is invalid"))?;
    let offset = cursor.map(|cursor| cursor.ordinal).unwrap_or(0);
    let start = usize::try_from(offset).map_err(|_| stale("aggregate cursor offset is invalid"))?;
    if start > groups.len() {
        return Err(stale("aggregate cursor offset is outside the result set"));
    }
    let end = start
        .saturating_add(usize::from(request.limit))
        .min(groups.len());
    let page = groups[start..end]
        .iter()
        .map(|(group, states)| aggregate_group_value(group_by, group, &metrics, states))
        .collect::<Result<Vec<_>, _>>()?;
    if canonical_json(&Value::Array(page.clone())).len() > MAX_QUERY_PAGE_BYTES {
        return Err(QueryError::new(
            "TS_QUERY_TOO_BROAD",
            "aggregate response exceeds the bounded response page",
        ));
    }
    let truncated = end < groups.len();
    let next_cursor = truncated
        .then(|| {
            encode_cursor(&QueryCursor {
                version: 1,
                database_uuid: database_uuid.to_owned(),
                snapshot_seq: snapshot_seq.to_owned(),
                request_digest: request_digest.to_owned(),
                observed_at: None,
                stable_key: "0".repeat(64),
                ordinal: u64::try_from(end)
                    .map_err(|_| QueryError::new("QUERY_FAILED", "aggregate offset overflowed"))?,
            })
        })
        .transpose()?;
    let coverage = if request.resource == DeepResource::Event {
        read_event_coverage(connection, request.predicate.as_ref())?
    } else {
        read_typed_resource_coverage(
            connection,
            request.resource,
            from_sql,
            &where_sql,
            &predicate.values,
        )?
    };
    Ok(DeepQueryResponse {
        format: QUERY_RESPONSE_FORMAT.to_owned(),
        database_uuid: database_uuid.to_owned(),
        snapshot_seq: snapshot_seq.to_owned(),
        resource: request.resource,
        records: NullableRecordPage::none(),
        groups: Some(page),
        next_cursor,
        total_match_count: Some(candidate_count.to_string()),
        total_group_count: Some(total_group_count.to_string()),
        truncated,
        coverage,
        provenance: DeepProvenance {
            default: "recorded".to_owned(),
            fields: metrics
                .iter()
                .map(|metric| DeepProvenanceField {
                    path: format!("groups.*.metrics.{}", metric.name),
                    kind: "derived".to_owned(),
                    method: "typed-aggregate@1".to_owned(),
                })
                .collect(),
        },
        limits: DeepQueryLimits {
            page_bytes: MAX_QUERY_PAGE_BYTES.to_string(),
            payloads_may_require_evidence_paging: false,
        },
    })
}

fn token_provider_rollup_supported(
    request: &DeepQueryRequest,
    group_by: &[String],
    metrics: &[AggregateMetric],
) -> bool {
    request.resource == DeepResource::TokenUsage
        && request.predicate.is_none()
        && group_by == ["provider"]
        && metrics.len() == 2
        && metrics.iter().any(|metric| {
            metric.name == "total-token-count"
                && metric.operator == AggregateMetricOperator::Sum
                && metric.field.as_deref() == Some("token.total")
        })
        && metrics.iter().any(|metric| {
            metric.name == "event-count"
                && metric.operator == AggregateMetricOperator::Count
                && metric.field.is_none()
        })
}

#[allow(clippy::too_many_arguments)]
fn read_token_provider_rollup(
    connection: &Connection,
    request: &DeepQueryRequest,
    group_by: &[String],
    metrics: &[AggregateMetric],
    database_uuid: &str,
    snapshot_seq: &str,
    request_digest: &str,
    cursor: Option<&QueryCursor>,
) -> Result<DeepQueryResponse, QueryError> {
    let mut statement = connection
        .prepare(
            "SELECT s.provider,rollup.event_count,rollup.total_total,rollup.total_present,
                    rollup.complete_metric_event_count
             FROM history_token_rollups rollup
             JOIN sessions s ON s.session_id=rollup.session_id
             WHERE s.eligibility='eligible' AND s.session_scope='main'
               AND NOT EXISTS (SELECT 1 FROM source_purge_states purge
                               WHERE purge.session_key=s.session_key)
             ORDER BY s.provider,rollup.rollup_id",
        )
        .map_err(query_failed)?;
    let mut rows = statement.query([]).map_err(query_failed)?;
    let mut groups = BTreeMap::<Vec<AggregateValue>, Vec<AggregateMetricState>>::new();
    let mut candidate_count = 0_u64;
    let mut missing_metric_event_count = 0_u64;
    while let Some(row) = rows.next().map_err(query_failed)? {
        let event_count = nonnegative(row.get(1).map_err(query_failed)?, "token event count")?;
        candidate_count = candidate_count
            .checked_add(event_count)
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "aggregate count overflowed"))?;
        let complete_metric_event_count = nonnegative(
            row.get(4).map_err(query_failed)?,
            "complete token metric event count",
        )?;
        let missing_in_rollup = event_count
            .checked_sub(complete_metric_event_count)
            .ok_or_else(|| {
                QueryError::new("QUERY_FAILED", "token coverage count is inconsistent")
            })?;
        missing_metric_event_count = missing_metric_event_count
            .checked_add(missing_in_rollup)
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "coverage count overflowed"))?;
        let key = vec![AggregateValue::Text(row.get(0).map_err(query_failed)?)];
        let states = groups
            .entry(key)
            .or_insert_with(|| metrics.iter().map(initial_metric_state).collect());
        for (metric, state) in metrics.iter().zip(states.iter_mut()) {
            match (metric.name.as_str(), state) {
                ("event-count", AggregateMetricState::Count(count)) => {
                    *count = count.checked_add(event_count).ok_or_else(|| {
                        QueryError::new("QUERY_FAILED", "aggregate count overflowed")
                    })?;
                }
                ("total-token-count", AggregateMetricState::Sum { total, count }) => {
                    *total = total
                        .checked_add(
                            row.get::<_, String>(2)
                                .map_err(query_failed)?
                                .parse::<u128>()
                                .map_err(|_| {
                                    QueryError::new("QUERY_FAILED", "token rollup total is invalid")
                                })?,
                        )
                        .ok_or_else(|| {
                            QueryError::new("QUERY_FAILED", "aggregate sum overflowed")
                        })?;
                    *count = count
                        .checked_add(nonnegative(
                            row.get(3).map_err(query_failed)?,
                            "token coverage count",
                        )?)
                        .ok_or_else(|| {
                            QueryError::new("QUERY_FAILED", "aggregate denominator overflowed")
                        })?;
                }
                _ => {
                    return Err(QueryError::new(
                        "QUERY_FAILED",
                        "token rollup metric is inconsistent",
                    ));
                }
            }
        }
    }
    drop(rows);
    drop(statement);
    if candidate_count > MAX_AGGREGATE_CANDIDATES {
        return Err(QueryError::new(
            "TS_QUERY_TOO_BROAD",
            "aggregate candidate set exceeds its exact work budget",
        ));
    }
    let primary_metric = metrics
        .iter()
        .position(|metric| metric.name == request.order_by[0].field)
        .ok_or_else(|| invalid("aggregate order metric is missing"))?;
    let direction = request.order_by[0].direction;
    let mut groups = groups.into_iter().collect::<Vec<_>>();
    groups.sort_by(|left, right| {
        let metric = compare_metric_state(
            &metrics[primary_metric],
            &left.1[primary_metric],
            &right.1[primary_metric],
        );
        let metric = if direction == Direction::Desc {
            metric.reverse()
        } else {
            metric
        };
        metric.then_with(|| compare_group_keys(&left.0, &right.0))
    });
    let total_group_count = groups.len() as u64;
    let start = usize::try_from(cursor.map_or(0, |cursor| cursor.ordinal))
        .map_err(|_| stale("aggregate cursor offset is invalid"))?;
    if start > groups.len() {
        return Err(stale("aggregate cursor offset is outside the result set"));
    }
    let end = start
        .saturating_add(usize::from(request.limit))
        .min(groups.len());
    let page = groups[start..end]
        .iter()
        .map(|(group, states)| aggregate_group_value(group_by, group, metrics, states))
        .collect::<Result<Vec<_>, _>>()?;
    if canonical_json(&Value::Array(page.clone())).len() > MAX_QUERY_PAGE_BYTES {
        return Err(QueryError::new(
            "TS_QUERY_TOO_BROAD",
            "aggregate response exceeds the bounded response page",
        ));
    }
    let truncated = end < groups.len();
    let next_cursor = truncated
        .then(|| {
            encode_cursor(&QueryCursor {
                version: 1,
                database_uuid: database_uuid.to_owned(),
                snapshot_seq: snapshot_seq.to_owned(),
                request_digest: request_digest.to_owned(),
                observed_at: None,
                stable_key: "0".repeat(64),
                ordinal: end as u64,
            })
        })
        .transpose()?;
    let candidate_count_i64 = i64::try_from(candidate_count)
        .map_err(|_| QueryError::new("QUERY_FAILED", "aggregate count exceeds SQLite"))?;
    let missing_token_i64 = i64::try_from(missing_metric_event_count)
        .map_err(|_| QueryError::new("QUERY_FAILED", "token coverage exceeds SQLite"))?;
    let coverage = coverage_from_counts(
        connection,
        (candidate_count_i64, 0, 0, 0, 0, 0, 0, missing_token_i64, 0),
    )?;
    Ok(DeepQueryResponse {
        format: QUERY_RESPONSE_FORMAT.to_owned(),
        database_uuid: database_uuid.to_owned(),
        snapshot_seq: snapshot_seq.to_owned(),
        resource: request.resource,
        records: NullableRecordPage::none(),
        groups: Some(page),
        next_cursor,
        total_match_count: Some(candidate_count.to_string()),
        total_group_count: Some(total_group_count.to_string()),
        truncated,
        coverage,
        provenance: DeepProvenance {
            default: "recorded".to_owned(),
            fields: metrics
                .iter()
                .map(|metric| DeepProvenanceField {
                    path: format!("groups.*.metrics.{}", metric.name),
                    kind: "derived".to_owned(),
                    method: "typed-aggregate@1".to_owned(),
                })
                .collect(),
        },
        limits: DeepQueryLimits {
            page_bytes: MAX_QUERY_PAGE_BYTES.to_string(),
            payloads_may_require_evidence_paging: false,
        },
    })
}

fn aggregate_row_value(
    row: &rusqlite::Row<'_>,
    index: usize,
    kind: AggregateFieldKind,
) -> Result<AggregateValue, QueryError> {
    match kind {
        AggregateFieldKind::Text => row
            .get::<_, Option<String>>(index)
            .map(|value| value.map_or(AggregateValue::Null, AggregateValue::Text))
            .map_err(query_failed),
        AggregateFieldKind::DecimalBlob => row
            .get::<_, Option<Vec<u8>>>(index)
            .map_err(query_failed)?
            .map(blob_u64)
            .transpose()
            .map_err(query_failed)
            .map(|value| value.map_or(AggregateValue::Null, AggregateValue::Decimal)),
    }
}

fn initial_metric_state(metric: &AggregateMetric) -> AggregateMetricState {
    match metric.operator {
        AggregateMetricOperator::Count => AggregateMetricState::Count(0),
        AggregateMetricOperator::DistinctCount => AggregateMetricState::Distinct(BTreeSet::new()),
        AggregateMetricOperator::Sum | AggregateMetricOperator::Average => {
            AggregateMetricState::Sum { total: 0, count: 0 }
        }
        AggregateMetricOperator::Min => AggregateMetricState::Min(None),
        AggregateMetricOperator::Max => AggregateMetricState::Max(None),
    }
}

fn update_metric_state(
    metric: &AggregateMetric,
    state: &mut AggregateMetricState,
    value: Option<AggregateValue>,
    distinct_value_count: &mut usize,
) -> Result<(), QueryError> {
    match (metric.operator, state) {
        (AggregateMetricOperator::Count, AggregateMetricState::Count(count)) => {
            *count = count
                .checked_add(1)
                .ok_or_else(|| QueryError::new("QUERY_FAILED", "aggregate count overflowed"))?;
        }
        (AggregateMetricOperator::DistinctCount, AggregateMetricState::Distinct(values)) => {
            if let Some(value) = value.filter(|value| *value != AggregateValue::Null)
                && values.insert(value)
            {
                *distinct_value_count = distinct_value_count.checked_add(1).ok_or_else(|| {
                    QueryError::new("QUERY_FAILED", "aggregate distinct count overflowed")
                })?;
                if *distinct_value_count > MAX_AGGREGATE_DISTINCT_VALUES {
                    return Err(QueryError::new(
                        "TS_QUERY_TOO_BROAD",
                        "aggregate distinct set exceeds its exact work budget",
                    ));
                }
            }
        }
        (
            AggregateMetricOperator::Sum | AggregateMetricOperator::Average,
            AggregateMetricState::Sum { total, count },
        ) => {
            if let Some(AggregateValue::Decimal(value)) = value {
                *total = total
                    .checked_add(u128::from(value))
                    .ok_or_else(|| QueryError::new("QUERY_FAILED", "aggregate sum overflowed"))?;
                *count = count.checked_add(1).ok_or_else(|| {
                    QueryError::new("QUERY_FAILED", "aggregate denominator overflowed")
                })?;
            }
        }
        (AggregateMetricOperator::Min, AggregateMetricState::Min(current)) => {
            if let Some(value) = value.filter(|value| *value != AggregateValue::Null)
                && current.as_ref().is_none_or(|current| value < *current)
            {
                *current = Some(value);
            }
        }
        (AggregateMetricOperator::Max, AggregateMetricState::Max(current)) => {
            if let Some(value) = value.filter(|value| *value != AggregateValue::Null)
                && current.as_ref().is_none_or(|current| value > *current)
            {
                *current = Some(value);
            }
        }
        _ => {
            return Err(QueryError::new(
                "QUERY_FAILED",
                "aggregate metric state is inconsistent",
            ));
        }
    }
    Ok(())
}

fn compare_metric_state(
    metric: &AggregateMetric,
    left: &AggregateMetricState,
    right: &AggregateMetricState,
) -> Ordering {
    match (metric.operator, left, right) {
        (_, AggregateMetricState::Count(left), AggregateMetricState::Count(right)) => {
            left.cmp(right)
        }
        (_, AggregateMetricState::Distinct(left), AggregateMetricState::Distinct(right)) => {
            left.len().cmp(&right.len())
        }
        (
            AggregateMetricOperator::Sum,
            AggregateMetricState::Sum {
                total: left_total, ..
            },
            AggregateMetricState::Sum {
                total: right_total, ..
            },
        ) => left_total.cmp(right_total),
        (
            AggregateMetricOperator::Average,
            AggregateMetricState::Sum {
                total: left_total,
                count: left_count,
            },
            AggregateMetricState::Sum {
                total: right_total,
                count: right_count,
            },
        ) => left_total
            .checked_mul(u128::from(*right_count))
            .zip(right_total.checked_mul(u128::from(*left_count)))
            .map_or_else(
                || {
                    left_total
                        .cmp(right_total)
                        .then(left_count.cmp(right_count))
                },
                |(left, right)| left.cmp(&right),
            ),
        (_, AggregateMetricState::Min(left), AggregateMetricState::Min(right))
        | (_, AggregateMetricState::Max(left), AggregateMetricState::Max(right)) => {
            option_aggregate_value_cmp(left, right)
        }
        _ => Ordering::Equal,
    }
}

fn option_aggregate_value_cmp(
    left: &Option<AggregateValue>,
    right: &Option<AggregateValue>,
) -> Ordering {
    match (left, right) {
        (Some(left), Some(right)) => left.cmp(right),
        (Some(_), None) => Ordering::Greater,
        (None, Some(_)) => Ordering::Less,
        (None, None) => Ordering::Equal,
    }
}

fn compare_group_keys(left: &[AggregateValue], right: &[AggregateValue]) -> Ordering {
    left.iter()
        .zip(right)
        .find_map(|(left, right)| {
            let ordering = left.cmp(right);
            (ordering != Ordering::Equal).then_some(ordering)
        })
        .unwrap_or_else(|| left.len().cmp(&right.len()))
}

fn aggregate_value_json(value: &AggregateValue) -> Value {
    match value {
        AggregateValue::Null => Value::Null,
        AggregateValue::Text(value) => json!(value),
        AggregateValue::Decimal(value) => json!(value.to_string()),
    }
}

fn metric_state_json(
    metric: &AggregateMetric,
    state: &AggregateMetricState,
) -> Result<Value, QueryError> {
    let value = match (metric.operator, state) {
        (AggregateMetricOperator::Count, AggregateMetricState::Count(value)) => {
            json!(value.to_string())
        }
        (AggregateMetricOperator::DistinctCount, AggregateMetricState::Distinct(values)) => {
            json!(values.len().to_string())
        }
        (AggregateMetricOperator::Sum, AggregateMetricState::Sum { total, .. }) => {
            json!(total.to_string())
        }
        (AggregateMetricOperator::Average, AggregateMetricState::Sum { total, count }) => {
            if *count == 0 {
                Value::Null
            } else {
                json!({ "sum": total.to_string(), "count": count.to_string() })
            }
        }
        (AggregateMetricOperator::Min, AggregateMetricState::Min(value))
        | (AggregateMetricOperator::Max, AggregateMetricState::Max(value)) => value
            .as_ref()
            .map(aggregate_value_json)
            .unwrap_or(Value::Null),
        _ => {
            return Err(QueryError::new(
                "QUERY_FAILED",
                "aggregate metric state is inconsistent",
            ));
        }
    };
    Ok(value)
}

fn aggregate_group_value(
    group_by: &[String],
    group: &[AggregateValue],
    metrics: &[AggregateMetric],
    states: &[AggregateMetricState],
) -> Result<Value, QueryError> {
    let mut group_value = Map::new();
    for (field, value) in group_by.iter().zip(group) {
        insert_path(&mut group_value, field, aggregate_value_json(value))?;
    }
    let mut metric_value = Map::new();
    for (metric, state) in metrics.iter().zip(states) {
        metric_value.insert(metric.name.clone(), metric_state_json(metric, state)?);
    }
    Ok(json!({
        "group": Value::Object(group_value),
        "metrics": Value::Object(metric_value),
    }))
}

fn read_typed_resource_query(
    connection: &Connection,
    request: &DeepQueryRequest,
    database_uuid: &str,
    snapshot_seq: &str,
    request_digest: &str,
    cursor: Option<&QueryCursor>,
) -> Result<DeepQueryResponse, QueryError> {
    let resource = request.resource;
    let predicate = compile_resource_predicate(resource, request.predicate.as_ref())?;
    let mut where_sql = resource_visibility_sql(resource).to_owned();
    if !predicate.sql.is_empty() {
        where_sql.push_str(" AND (");
        where_sql.push_str(&predicate.sql);
        where_sql.push(')');
    }
    let where_without_cursor = where_sql.clone();
    let mut values = predicate.values;
    let observed = resource_observed_column(resource);
    let stable = resource_stable_column(resource);
    let ordinal = resource_ordinal_column(resource);
    if let Some(cursor) = cursor {
        let key = decode_key(&cursor.stable_key, "cursor stableKey")?;
        if let Some(observed_at) = &cursor.observed_at {
            where_sql.push_str(&format!(
                " AND ({observed}<? OR {observed} IS NULL OR
                   ({observed}=? AND ({stable}>? OR ({stable}=? AND {ordinal}>?))))"
            ));
            values.push(SqlValue::Text(observed_at.clone()));
            values.push(SqlValue::Text(observed_at.clone()));
            values.push(SqlValue::Blob(key.clone()));
            values.push(SqlValue::Blob(key));
            values.push(SqlValue::Integer(
                i64::try_from(cursor.ordinal)
                    .map_err(|_| stale("query cursor ordinal is invalid"))?,
            ));
        } else {
            where_sql.push_str(&format!(
                " AND {observed} IS NULL AND ({stable}>? OR ({stable}=? AND {ordinal}>?))"
            ));
            values.push(SqlValue::Blob(key.clone()));
            values.push(SqlValue::Blob(key));
            values.push(SqlValue::Integer(
                i64::try_from(cursor.ordinal)
                    .map_err(|_| stale("query cursor ordinal is invalid"))?,
            ));
        }
    }

    let from_sql = resource_from_sql(resource);
    let coverage = read_typed_resource_coverage(
        connection,
        resource,
        from_sql,
        &where_without_cursor,
        &values[..values.len() - cursor_value_count(cursor)],
    )?;
    let total_match_count = (request.count == CountMode::Exact)
        .then(|| coverage_total(&coverage))
        .transpose()?;
    let sql = format!(
        "{} {} WHERE {} ORDER BY {} IS NULL ASC,{} DESC,{} ASC,{} ASC LIMIT ?",
        resource_select_sql(resource),
        from_sql,
        where_sql,
        observed,
        observed,
        stable,
        ordinal,
    );
    values.push(SqlValue::Integer(i64::from(request.limit) + 1));
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            typed_resource_row(resource, row)
        })
        .map_err(query_failed)?;
    let mut rows = rows.collect::<Result<Vec<_>, _>>().map_err(query_failed)?;
    drop(statement);
    let truncated = rows.len() > usize::from(request.limit);
    rows.truncate(usize::from(request.limit));
    let (select, payload_mode) = match &request.shape {
        DeepQueryShape::Records {
            select,
            payload_mode,
        } => (select, *payload_mode),
        DeepQueryShape::Aggregate { .. } => unreachable!("validated records shape"),
    };
    let mut records = Vec::with_capacity(rows.len());
    for row in &rows {
        records.push(select_typed_resource_record(
            connection,
            resource,
            row,
            select,
            payload_mode,
        )?);
    }
    if canonical_json(&Value::Array(records.clone())).len() > MAX_QUERY_PAGE_BYTES {
        return Err(QueryError::new(
            "TS_QUERY_TOO_BROAD",
            "query response exceeds the bounded response page",
        ));
    }
    let next_cursor = if truncated {
        let last = rows
            .last()
            .ok_or_else(|| invalid("query cursor boundary is missing"))?;
        Some(encode_cursor(&QueryCursor {
            version: 1,
            database_uuid: database_uuid.to_owned(),
            snapshot_seq: snapshot_seq.to_owned(),
            request_digest: request_digest.to_owned(),
            observed_at: last.observed_at.clone(),
            stable_key: last.stable_key.clone(),
            ordinal: last.ordinal,
        })?)
    } else {
        None
    };
    Ok(DeepQueryResponse {
        format: QUERY_RESPONSE_FORMAT.to_owned(),
        database_uuid: database_uuid.to_owned(),
        snapshot_seq: snapshot_seq.to_owned(),
        resource,
        records: NullableRecordPage::some(records),
        groups: None,
        next_cursor,
        total_match_count,
        total_group_count: None,
        truncated,
        coverage,
        provenance: typed_resource_provenance(resource),
        limits: DeepQueryLimits {
            page_bytes: MAX_QUERY_PAGE_BYTES.to_string(),
            payloads_may_require_evidence_paging: true,
        },
    })
}

fn cursor_value_count(cursor: Option<&QueryCursor>) -> usize {
    match cursor.and_then(|cursor| cursor.observed_at.as_ref()) {
        Some(_) => 5,
        None if cursor.is_some() => 3,
        None => 0,
    }
}

fn coverage_total(coverage: &DeepCoverage) -> Result<String, QueryError> {
    let values = [
        &coverage.matching.full_record_count,
        &coverage.matching.summary_record_count,
        &coverage.matching.unloaded_record_count,
        &coverage.matching.truncated_record_count,
        &coverage.matching.unavailable_record_count,
    ];
    values
        .into_iter()
        .try_fold(0_u64, |total, value| {
            value
                .parse::<u64>()
                .ok()
                .and_then(|value| total.checked_add(value))
                .ok_or_else(|| QueryError::new("QUERY_FAILED", "coverage total is invalid"))
        })
        .map(|value| value.to_string())
}

fn optional_hex(value: Option<String>) -> Option<String> {
    value.filter(|value| !value.is_empty())
}

fn optional_blob_decimal(row: &rusqlite::Row<'_>, index: usize) -> rusqlite::Result<Value> {
    row.get::<_, Option<Vec<u8>>>(index)?
        .map(blob_u64)
        .transpose()
        .map(|value| {
            value
                .map(|value| json!(value.to_string()))
                .unwrap_or(Value::Null)
        })
}

fn typed_resource_row(
    resource: DeepResource,
    row: &rusqlite::Row<'_>,
) -> rusqlite::Result<TypedResourceRow> {
    let observed_at = row.get(0)?;
    let stable_key = row.get(1)?;
    let ordinal = u64::try_from(row.get::<_, i64>(2)?).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            2,
            rusqlite::types::Type::Integer,
            Box::new(error),
        )
    })?;
    let mut record = Map::new();
    let event_revision = match resource {
        DeepResource::Session => {
            record.insert("sessionKey".to_owned(), json!(stable_key));
            record.insert("provider".to_owned(), json!(row.get::<_, String>(3)?));
            record.insert(
                "projectKey".to_owned(),
                json!(row.get::<_, Option<String>>(4)?),
            );
            record.insert("originScope".to_owned(), json!(row.get::<_, String>(5)?));
            record.insert(
                "completeness".to_owned(),
                json!(if row.get::<_, bool>(10)? {
                    "truncated"
                } else {
                    "full"
                }),
            );
            record.insert("revision".to_owned(), json!(row.get::<_, String>(9)?));
            record.insert(
                "session".to_owned(),
                json!({
                    "startedAt": row.get::<_, Option<String>>(7)?,
                    "endedAt": row.get::<_, Option<String>>(8)?,
                    "eligibility": row.get::<_, String>(6)?,
                }),
            );
            None
        }
        DeepResource::Turn => {
            record.insert("turnKey".to_owned(), json!(stable_key));
            record.insert("sessionKey".to_owned(), json!(row.get::<_, String>(3)?));
            record.insert("provider".to_owned(), json!(row.get::<_, String>(4)?));
            record.insert(
                "projectKey".to_owned(),
                json!(row.get::<_, Option<String>>(5)?),
            );
            record.insert("observedAt".to_owned(), json!(observed_at));
            record.insert("problem".to_owned(), json!(row.get::<_, String>(6)?));
            record.insert(
                "finalAnswer".to_owned(),
                json!(row.get::<_, Option<String>>(7)?),
            );
            let revision = optional_hex(row.get::<_, Option<String>>(10)?);
            record.insert("revision".to_owned(), json!(revision));
            record.insert(
                "completeness".to_owned(),
                json!(if row.get::<_, bool>(11)? || revision.is_none() {
                    "unavailable"
                } else {
                    "full"
                }),
            );
            record.insert(
                "turn".to_owned(),
                json!({
                    "providerTerminal": row.get::<_, Option<String>>(8)?,
                    "visibility": row.get::<_, String>(9)?,
                }),
            );
            None
        }
        DeepResource::CapabilityUse => {
            record.insert("useKey".to_owned(), json!(stable_key));
            record.insert("turnKey".to_owned(), json!(optional_hex(row.get(3)?)));
            record.insert("sessionKey".to_owned(), json!(row.get::<_, String>(4)?));
            record.insert("provider".to_owned(), json!(row.get::<_, String>(5)?));
            record.insert(
                "projectKey".to_owned(),
                json!(row.get::<_, Option<String>>(6)?),
            );
            record.insert("observedAt".to_owned(), json!(observed_at));
            record.insert("originScope".to_owned(), json!(row.get::<_, String>(7)?));
            record.insert(
                "capability".to_owned(),
                json!({
                    "key": row.get::<_, String>(8)?,
                    "kind": row.get::<_, String>(9)?,
                    "canonicalName": row.get::<_, String>(10)?,
                    "observedName": row.get::<_, String>(11)?,
                    "terminalState": row.get::<_, String>(12)?,
                    "strength": row.get::<_, String>(13)?,
                    "inputFingerprint": optional_hex(row.get(14)?),
                    "correlationDigest": optional_hex(row.get(15)?),
                }),
            );
            record.insert(
                "attempt".to_owned(),
                json!({
                    "chainKey": optional_hex(row.get(16)?),
                    "revision": null,
                }),
            );
            None
        }
        DeepResource::FileActivity => {
            record.insert("eventKey".to_owned(), json!(stable_key));
            record.insert("activityOrdinal".to_owned(), json!(ordinal.to_string()));
            insert_common_typed_record(&mut record, row, &observed_at)?;
            record.insert(
                "file".to_owned(),
                json!({
                    "action": row.get::<_, String>(7)?,
                    "phase": row.get::<_, String>(8)?,
                    "pathRole": row.get::<_, String>(9)?,
                    "rawPath": row.get::<_, String>(10)?,
                    "normalizedPath": row.get::<_, String>(11)?,
                    "relativePath": row.get::<_, Option<String>>(12)?,
                    "absolute": row.get::<_, bool>(13)?,
                    "projectRelative": row.get::<_, bool>(14)?,
                }),
            );
            Some(row.get(15)?)
        }
        DeepResource::TokenUsage => {
            record.insert("eventKey".to_owned(), json!(stable_key));
            insert_common_typed_record(&mut record, row, &observed_at)?;
            record.insert(
                "token".to_owned(),
                json!({
                    "scope": row.get::<_, String>(7)?,
                    "model": row.get::<_, Option<String>>(8)?,
                    "input": optional_blob_decimal(row, 9)?,
                    "cachedInput": optional_blob_decimal(row, 10)?,
                    "cacheWriteInput": optional_blob_decimal(row, 11)?,
                    "output": optional_blob_decimal(row, 12)?,
                    "reasoning": optional_blob_decimal(row, 13)?,
                    "total": optional_blob_decimal(row, 14)?,
                }),
            );
            Some(row.get(15)?)
        }
        DeepResource::ErrorOccurrence => {
            record.insert("eventKey".to_owned(), json!(stable_key));
            insert_common_typed_record(&mut record, row, &observed_at)?;
            record.insert(
                "capability".to_owned(),
                json!({
                    "key": optional_hex(row.get(9)?),
                    "canonicalName": row.get::<_, Option<String>>(10)?,
                }),
            );
            record.insert(
                "error".to_owned(),
                json!({
                    "signatureVersion": row.get::<_, String>(7)?,
                    "signature": row.get::<_, String>(8)?,
                    "providerState": row.get::<_, Option<String>>(11)?,
                    "exitCode": optional_blob_decimal(row, 12)?,
                }),
            );
            Some(row.get(13)?)
        }
        DeepResource::Event => unreachable!("event has its own query path"),
    };
    Ok(TypedResourceRow {
        observed_at,
        stable_key,
        ordinal,
        record: Value::Object(record),
        event_revision,
    })
}

fn insert_common_typed_record(
    record: &mut Map<String, Value>,
    row: &rusqlite::Row<'_>,
    observed_at: &Option<String>,
) -> rusqlite::Result<()> {
    record.insert("turnKey".to_owned(), json!(optional_hex(row.get(3)?)));
    record.insert("sessionKey".to_owned(), json!(row.get::<_, String>(4)?));
    record.insert("provider".to_owned(), json!(row.get::<_, String>(5)?));
    record.insert(
        "projectKey".to_owned(),
        json!(row.get::<_, Option<String>>(6)?),
    );
    record.insert("observedAt".to_owned(), json!(observed_at));
    Ok(())
}

fn value_at_path(value: &Value, path: &str) -> Value {
    path.split('.')
        .try_fold(value, |current, segment| current.get(segment))
        .cloned()
        .unwrap_or(Value::Null)
}

fn select_typed_resource_record(
    connection: &Connection,
    resource: DeepResource,
    row: &TypedResourceRow,
    select: &[String],
    payload_mode: PayloadMode,
) -> Result<Value, QueryError> {
    let mut selected = Map::new();
    for field in select {
        let value = if resource == DeepResource::ErrorOccurrence && field == "error.content" {
            let revision = row.event_revision.clone().ok_or_else(|| {
                QueryError::new("QUERY_FAILED", "error event revision is missing")
            })?;
            let event = EventRow {
                event_key: row.stable_key.clone(),
                session_key: String::new(),
                turn_key: None,
                provider: String::new(),
                project_key: None,
                origin_scope: "main".to_owned(),
                observed_at: row.observed_at.clone(),
                kind: "capability-result".to_owned(),
                completeness: "full".to_owned(),
                revision,
                metadata: Value::Object(Map::new()),
            };
            let payloads = read_payloads(connection, &row.stable_key)?;
            content_value_any(
                connection,
                &event,
                &payloads,
                &["error-content", "tool-output"],
                payload_mode,
            )?
        } else if resource == DeepResource::CapabilityUse && field == "attempt.revision" {
            let chain_key = value_at_path(&row.record, "attempt.chainKey");
            match chain_key.as_str() {
                Some(chain_key) => json!(read_attempt_chain_revision(connection, chain_key)?),
                None => Value::Null,
            }
        } else {
            value_at_path(&row.record, field)
        };
        insert_path(&mut selected, field, value)?;
    }
    Ok(Value::Object(selected))
}

fn read_typed_resource_coverage(
    connection: &Connection,
    resource: DeepResource,
    from_sql: &str,
    where_sql: &str,
    values: &[SqlValue],
) -> Result<DeepCoverage, QueryError> {
    let completeness = match resource {
        DeepResource::Session => {
            "CASE WHEN EXISTS(SELECT 1 FROM session_fact_truncation st
                              WHERE st.session_id=s.session_id)
                  THEN 'truncated' ELSE 'full' END"
        }
        DeepResource::Turn => {
            "CASE WHEN t.revision IS NULL THEN 'unavailable'
                  WHEN EXISTS(SELECT 1 FROM turn_fact_truncation tt
                              WHERE tt.turn_id=t.turn_id)
                  THEN 'truncated' ELSE 'full' END"
        }
        _ => "'full'",
    };
    let missing_revision = match resource {
        DeepResource::Turn => "t.revision IS NULL",
        _ => "0",
    };
    let missing_payload = match resource {
        DeepResource::ErrorOccurrence => {
            "NOT EXISTS(SELECT 1 FROM history_payloads hp
                        WHERE hp.event_key=eo.event_key
                          AND hp.payload_kind IN ('error-content','tool-output'))"
        }
        _ => "0",
    };
    let missing_token = if resource == DeepResource::TokenUsage {
        "tu.input_tokens IS NULL OR tu.cached_input_tokens IS NULL OR
         tu.cache_write_input_tokens IS NULL OR tu.output_tokens IS NULL OR
         tu.reasoning_tokens IS NULL OR tu.total_tokens IS NULL"
    } else {
        "0"
    };
    let sql = format!(
        "SELECT SUM(({completeness})='full'),SUM(({completeness})='summary'),
                SUM(({completeness})='unloaded'),SUM(({completeness})='truncated'),
                SUM(({completeness})='unavailable'),
                SUM({observed} IS NULL),SUM({missing_revision}),SUM({missing_token}),
                SUM({missing_payload})
         {from_sql} WHERE {where_sql}",
        observed = resource_observed_column(resource),
    );
    let counts = connection
        .query_row(&sql, params_from_iter(values.iter()), |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                row.get::<_, Option<i64>>(8)?.unwrap_or(0),
            ))
        })
        .map_err(query_failed)?;
    coverage_from_counts(connection, counts)
}

fn coverage_from_counts(
    connection: &Connection,
    counts: (i64, i64, i64, i64, i64, i64, i64, i64, i64),
) -> Result<DeepCoverage, QueryError> {
    let matching = DeepMatchingCoverage {
        full_record_count: nonnegative(counts.0, "full coverage count")?.to_string(),
        summary_record_count: nonnegative(counts.1, "summary coverage count")?.to_string(),
        unloaded_record_count: nonnegative(counts.2, "unloaded coverage count")?.to_string(),
        truncated_record_count: nonnegative(counts.3, "truncated coverage count")?.to_string(),
        unavailable_record_count: nonnegative(counts.4, "unavailable coverage count")?.to_string(),
        missing_timestamp_count: nonnegative(counts.5, "timestamp coverage count")?.to_string(),
        missing_revision_count: nonnegative(counts.6, "revision coverage count")?.to_string(),
        missing_token_metric_count: nonnegative(counts.7, "token coverage count")?.to_string(),
        missing_payload_count: nonnegative(counts.8, "payload coverage count")?.to_string(),
    };
    assemble_coverage(connection, matching, "TS_INSIGHTS_COVERAGE_INCOMPLETE")
}

pub(crate) fn assemble_coverage(
    connection: &Connection,
    matching: DeepMatchingCoverage,
    incomplete_diagnostic: &str,
) -> Result<DeepCoverage, QueryError> {
    let counts = connection
        .query_row(
            "SELECT
               COALESCE(SUM(CASE WHEN s.eligibility='eligible'
                                      AND s.session_scope='main'
                                      AND purge.session_key IS NULL THEN 1 ELSE 0 END),0),
               COALESCE(SUM(CASE WHEN s.eligibility='excluded' THEN 1 ELSE 0 END),0),
               COALESCE(SUM(CASE WHEN s.eligibility='subagent-excluded' THEN 1 ELSE 0 END),0),
               COALESCE(SUM(CASE WHEN s.eligibility='unknown' THEN 1 ELSE 0 END),0),
               (SELECT COUNT(*) FROM source_purge_states
                WHERE purge_state IN ('pending-facts','pending-maintenance')),
               (SELECT COUNT(*) FROM source_purge_states WHERE purge_state='purged'),
               COALESCE(SUM(CASE WHEN s.eligibility='eligible'
                                      AND s.session_scope='main'
                                      AND purge.session_key IS NULL
                                      AND rollup.session_id IS NULL THEN 1 ELSE 0 END),0),
               COALESCE(SUM(CASE WHEN s.eligibility='eligible'
                                      AND s.session_scope='main'
                                      AND purge.session_key IS NULL
                                 THEN rollup.fts_searchable_event_count ELSE 0 END),0),
               COALESCE(SUM(CASE WHEN s.eligibility='eligible'
                                      AND s.session_scope='main'
                                      AND purge.session_key IS NULL
                                 THEN rollup.fts_stored_not_searchable_event_count ELSE 0 END),0),
               COALESCE(SUM(CASE WHEN s.eligibility='eligible'
                                      AND s.session_scope='main'
                                      AND purge.session_key IS NULL
                                 THEN rollup.fts_searchable_payload_bytes ELSE 0 END),0),
               COALESCE(SUM(CASE WHEN s.eligibility='eligible'
                                      AND s.session_scope='main'
                                      AND purge.session_key IS NULL
                                 THEN rollup.fts_stored_not_searchable_payload_bytes ELSE 0 END),0)
             FROM sessions s
             LEFT JOIN source_purge_states purge ON purge.session_key=s.session_key
             LEFT JOIN history_coverage_rollups rollup ON rollup.session_id=s.session_id",
            [],
            |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, i64>(4)?,
                    row.get::<_, i64>(5)?,
                    row.get::<_, i64>(6)?,
                    row.get::<_, i64>(7)?,
                    row.get::<_, i64>(8)?,
                    row.get::<_, i64>(9)?,
                    row.get::<_, i64>(10)?,
                ))
            },
        )
        .map_err(query_failed)?;
    let indexed_history = DeepIndexedHistoryCoverage {
        visible_session_count: nonnegative(counts.0, "visible session count")?.to_string(),
        excluded_session_count: nonnegative(counts.1, "excluded session count")?.to_string(),
        subagent_excluded_session_count: nonnegative(counts.2, "subagent session count")?
            .to_string(),
        unknown_eligibility_session_count: nonnegative(counts.3, "unknown session count")?
            .to_string(),
        pending_purge_session_count: nonnegative(counts.4, "pending purge count")?.to_string(),
        purged_session_count: nonnegative(counts.5, "purged session count")?.to_string(),
        missing_coverage_rollup_session_count: nonnegative(
            counts.6,
            "missing coverage rollup count",
        )?
        .to_string(),
        fts: DeepFtsCoverage {
            searchable_event_count: nonnegative(counts.7, "searchable event count")?.to_string(),
            stored_not_searchable_event_count: nonnegative(
                counts.8,
                "stored non-searchable event count",
            )?
            .to_string(),
            searchable_payload_bytes: nonnegative(counts.9, "searchable payload bytes")?
                .to_string(),
            stored_not_searchable_payload_bytes: nonnegative(
                counts.10,
                "stored non-searchable payload bytes",
            )?
            .to_string(),
        },
    };
    let degraded = matching.summary_record_count != "0"
        || matching.unloaded_record_count != "0"
        || matching.truncated_record_count != "0"
        || matching.unavailable_record_count != "0"
        || indexed_history.excluded_session_count != "0"
        || indexed_history.subagent_excluded_session_count != "0"
        || indexed_history.unknown_eligibility_session_count != "0"
        || indexed_history.pending_purge_session_count != "0"
        || indexed_history.purged_session_count != "0"
        || indexed_history.missing_coverage_rollup_session_count != "0";
    Ok(DeepCoverage {
        matching,
        indexed_history,
        degraded,
        diagnostics: degraded
            .then(|| incomplete_diagnostic.to_owned())
            .into_iter()
            .collect(),
    })
}

fn typed_resource_provenance(resource: DeepResource) -> DeepProvenance {
    let fields = match resource {
        DeepResource::ErrorOccurrence => vec![DeepProvenanceField {
            path: "records.*.error.signature".to_owned(),
            kind: "derived".to_owned(),
            method: "error-signature@1".to_owned(),
        }],
        _ => Vec::new(),
    };
    DeepProvenance {
        default: "recorded".to_owned(),
        fields,
    }
}

fn validate_evidence_request(request: &DeepEvidenceRequest) -> Result<(), QueryError> {
    if request.format != EVIDENCE_REQUEST_FORMAT {
        return Err(invalid("evidence format is not supported"));
    }
    if request.include.is_empty()
        || request.include.len() > 2
        || request
            .include
            .iter()
            .any(|value| !matches!(value.as_str(), "envelope" | "payload"))
        || request.include.windows(2).any(|pair| pair[0] >= pair[1])
    {
        return Err(invalid(
            "evidence include must be a sorted unique subset of envelope,payload",
        ));
    }
    if !(4..=MAX_EVIDENCE_PAGE_BYTES).contains(&request.max_bytes) {
        return Err(invalid("evidence maxBytes must be in 4..=1048576"));
    }
    if request
        .cursor
        .as_ref()
        .is_some_and(|value| value.len() > MAX_CURSOR_BYTES)
    {
        return Err(invalid("evidence cursor is too large"));
    }
    match &request.target {
        DeepEvidenceTarget::EventPayload {
            event_key,
            revision,
            payload_key,
        } => {
            for (name, value) in [("eventKey", event_key), ("revision", revision)] {
                if !valid_stable_key(value) {
                    return Err(invalid(format!(
                        "{name} must be a lowercase 32-byte hex key"
                    )));
                }
            }
            if payload_key
                .as_ref()
                .is_some_and(|value| !valid_stable_key(value))
            {
                return Err(invalid("payloadKey must be a lowercase 32-byte hex key"));
            }
        }
        DeepEvidenceTarget::Turn { turn_key, revision } => {
            for (name, value) in [("turnKey", turn_key), ("revision", revision)] {
                if !valid_stable_key(value) {
                    return Err(invalid(format!(
                        "{name} must be a lowercase 32-byte hex key"
                    )));
                }
            }
        }
        DeepEvidenceTarget::Session {
            session_key,
            revision,
        } => {
            for (name, value) in [("sessionKey", session_key), ("revision", revision)] {
                if !valid_stable_key(value) {
                    return Err(invalid(format!(
                        "{name} must be a lowercase 32-byte hex key"
                    )));
                }
            }
        }
        DeepEvidenceTarget::AttemptChain {
            chain_key,
            revision,
        } => {
            for (name, value) in [("chainKey", chain_key), ("revision", revision)] {
                if !valid_stable_key(value) {
                    return Err(invalid(format!(
                        "{name} must be a lowercase 32-byte hex key"
                    )));
                }
            }
        }
    }
    Ok(())
}

fn require_fact_v2(connection: &Connection) -> Result<(), QueryError> {
    let version = crate::normalized_repository::read_database_fact_schema_version(connection)
        .map_err(|_| QueryError::new("QUERY_FAILED", "Fact schema identity could not be read"))?;
    let coverage_ready = crate::normalized_repository::deep_query_coverage_ready(connection)
        .map_err(|_| {
            QueryError::new(
                "QUERY_FAILED",
                "Deep Query projection identity could not be read",
            )
        })?;
    if version != Some(2) || !coverage_ready {
        return Err(QueryError::new(
            "TS_INSIGHTS_QUERY_V2_NOT_READY",
            "deep query requires a completed Fact V2 shadow rebuild with deep-query-coverage@3",
        ));
    }
    Ok(())
}

fn read_identity(connection: &Connection) -> Result<(String, String), QueryError> {
    connection
        .query_row(
            "SELECT
               (SELECT value FROM engine_metadata WHERE key='database_uuid'),
               (SELECT value FROM engine_metadata WHERE key='snapshot_seq')",
            [],
            |row| Ok((row.get(0)?, row.get(1)?)),
        )
        .map_err(query_failed)
}

fn query_request_digest(request: &DeepQueryRequest) -> Result<String, QueryError> {
    let mut request = request.clone();
    request.cursor = None;
    let value = serde_json::to_value(request).map_err(|_| invalid("query request is invalid"))?;
    Ok(hex::encode(Sha256::digest(
        canonical_json(&value).as_bytes(),
    )))
}

pub(crate) fn read_attempt_chain_revision(
    connection: &Connection,
    chain_key: &str,
) -> Result<String, QueryError> {
    let chain_key = decode_key(chain_key, "attempt chainKey")?;
    let mut statement = connection
        .prepare(
            "SELECT ace.event_key,he.revision
             FROM attempt_chain_events ace
             JOIN history_events he ON he.event_key=ace.event_key
             WHERE ace.chain_key=?1
             ORDER BY he.record_start_offset,he.content_index,he.event_ordinal,he.event_key",
        )
        .map_err(query_failed)?;
    let mut rows = statement.query([&chain_key]).map_err(query_failed)?;
    let mut digest = Sha256::new();
    digest.update(b"threadshare:attempt-chain-revision:v1\0");
    digest.update(&chain_key);
    let mut count = 0_u64;
    while let Some(row) = rows.next().map_err(query_failed)? {
        let event_key = row.get::<_, Vec<u8>>(0).map_err(query_failed)?;
        let revision = row.get::<_, Vec<u8>>(1).map_err(query_failed)?;
        if event_key.len() != 32 || revision.len() != 32 {
            return Err(QueryError::new(
                "QUERY_FAILED",
                "attempt chain contains an invalid identity",
            ));
        }
        digest.update(event_key);
        digest.update(revision);
        count = count
            .checked_add(1)
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "attempt chain is too large"))?;
    }
    if count == 0 {
        return Err(QueryError::new(
            "TS_INSIGHTS_EVIDENCE_NOT_FOUND",
            "attempt chain was not found",
        ));
    }
    digest.update(count.to_be_bytes());
    Ok(hex::encode(digest.finalize()))
}

fn expected_resource_order(resource: DeepResource) -> &'static [(&'static str, Direction)] {
    match resource {
        DeepResource::Session => &[
            ("session.endedAt", Direction::Desc),
            ("sessionKey", Direction::Asc),
        ],
        DeepResource::Turn => &[("observedAt", Direction::Desc), ("turnKey", Direction::Asc)],
        DeepResource::Event | DeepResource::TokenUsage | DeepResource::ErrorOccurrence => &[
            ("observedAt", Direction::Desc),
            ("eventKey", Direction::Asc),
        ],
        DeepResource::CapabilityUse => {
            &[("observedAt", Direction::Desc), ("useKey", Direction::Asc)]
        }
        DeepResource::FileActivity => &[
            ("observedAt", Direction::Desc),
            ("eventKey", Direction::Asc),
            ("activityOrdinal", Direction::Asc),
        ],
    }
}

fn validate_resource_order(
    resource: DeepResource,
    order: &[DeepOrderBy],
) -> Result<(), QueryError> {
    let expected = expected_resource_order(resource);
    if order.len() != expected.len()
        || order
            .iter()
            .zip(expected)
            .any(|(actual, expected)| actual.field != expected.0 || actual.direction != expected.1)
    {
        return Err(invalid("orderBy is not the stable order for this resource"));
    }
    Ok(())
}

fn validate_predicate(
    resource: DeepResource,
    predicate: &DeepPredicate,
    depth: usize,
    stats: &mut PredicateStats,
) -> Result<(), QueryError> {
    if depth > MAX_PREDICATE_DEPTH {
        return Err(invalid("predicate exceeds maximum depth 8"));
    }
    match predicate {
        DeepPredicate::And { and } | DeepPredicate::Or { or: and } => {
            if and.is_empty() || and.len() > MAX_PREDICATE_LEAVES {
                return Err(invalid(
                    "predicate boolean nodes must contain 1..=64 children",
                ));
            }
            for item in and {
                validate_predicate(resource, item, depth + 1, stats)?;
            }
        }
        DeepPredicate::Not { not } => validate_predicate(resource, not, depth + 1, stats)?,
        DeepPredicate::Leaf {
            field,
            operator,
            value,
        } => {
            stats.leaves += 1;
            if stats.leaves > MAX_PREDICATE_LEAVES {
                return Err(invalid("predicate exceeds maximum 64 leaves"));
            }
            resource_filter_field(resource, field)?;
            if (*operator == PredicateOperator::Match) != (field == "text") {
                return Err(invalid("match is supported only for the text field"));
            }
            validate_leaf_value(*operator, value.as_ref())?;
        }
    }
    Ok(())
}

fn validate_leaf_value(
    operator: PredicateOperator,
    value: Option<&Value>,
) -> Result<(), QueryError> {
    match operator {
        PredicateOperator::Exists if value.is_some() => {
            Err(invalid("exists predicate must omit value"))
        }
        PredicateOperator::Exists => Ok(()),
        PredicateOperator::Eq
        | PredicateOperator::Ne
        | PredicateOperator::Lt
        | PredicateOperator::Lte
        | PredicateOperator::Gt
        | PredicateOperator::Gte
        | PredicateOperator::Prefix
        | PredicateOperator::Contains => {
            if value.is_some_and(|value| value.is_string()) {
                Ok(())
            } else {
                Err(invalid("predicate operator requires a string value"))
            }
        }
        PredicateOperator::In | PredicateOperator::NotIn | PredicateOperator::Between => {
            let Some(values) = value.and_then(Value::as_array) else {
                return Err(invalid("predicate operator requires an array value"));
            };
            let valid_length = if operator == PredicateOperator::Between {
                values.len() == 2
            } else {
                (1..=64).contains(&values.len())
            };
            if !valid_length || values.iter().any(|value| !value.is_string()) {
                return Err(invalid(
                    "predicate array must contain bounded string values",
                ));
            }
            Ok(())
        }
        PredicateOperator::Match => {
            if value.is_some_and(|value| value.as_str().is_some_and(|value| !value.is_empty())) {
                Ok(())
            } else {
                Err(invalid("match requires a non-empty string value"))
            }
        }
    }
}

fn event_filter_field(field: &str) -> Result<&'static str, QueryError> {
    match field {
        "provider" => Ok("s.provider"),
        "projectKey" => {
            Ok("CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END")
        }
        "sessionKey" => Ok("lower(hex(s.session_key))"),
        "turnKey" => Ok("CASE WHEN t.turn_key IS NULL THEN NULL ELSE lower(hex(t.turn_key)) END"),
        "originScope" => Ok("he.origin_scope"),
        "observedAt" => Ok("he.observed_timestamp"),
        "completeness" => Ok("he.completeness"),
        "revision" => Ok("lower(hex(he.revision))"),
        "event.kind" => Ok("he.event_kind"),
        "message.role" => Ok("json_extract(he.metadata_json,'$.role')"),
        "text" => Ok("he.event_key"),
        _ => Err(invalid(format!(
            "field {field} is not filterable for event"
        ))),
    }
}

fn event_select_field(field: &str) -> Result<(), QueryError> {
    match field {
        "eventKey" | "sessionKey" | "turnKey" | "provider" | "projectKey" | "originScope"
        | "observedAt" | "completeness" | "revision" | "event.kind" | "message.role"
        | "message.content" | "tool.input" | "tool.output" | "error.content"
        | "providerPayload" | "payloadRef" => Ok(()),
        _ => Err(invalid(format!(
            "field {field} is not selectable for event"
        ))),
    }
}

fn resource_select_field(resource: DeepResource, field: &str) -> Result<(), QueryError> {
    if resource == DeepResource::Event {
        return event_select_field(field);
    }
    let valid = match resource {
        DeepResource::Session => matches!(
            field,
            "sessionKey"
                | "provider"
                | "projectKey"
                | "originScope"
                | "completeness"
                | "session.startedAt"
                | "session.endedAt"
                | "revision"
        ),
        DeepResource::Turn => matches!(
            field,
            "turnKey"
                | "sessionKey"
                | "provider"
                | "projectKey"
                | "observedAt"
                | "completeness"
                | "revision"
                | "problem"
                | "finalAnswer"
                | "turn.providerTerminal"
                | "turn.visibility"
        ),
        DeepResource::CapabilityUse => matches!(
            field,
            "useKey"
                | "turnKey"
                | "sessionKey"
                | "provider"
                | "projectKey"
                | "observedAt"
                | "originScope"
                | "capability.key"
                | "capability.kind"
                | "capability.canonicalName"
                | "capability.observedName"
                | "capability.terminalState"
                | "capability.strength"
                | "capability.inputFingerprint"
                | "capability.correlationDigest"
                | "attempt.chainKey"
                | "attempt.revision"
        ),
        DeepResource::FileActivity => matches!(
            field,
            "eventKey"
                | "activityOrdinal"
                | "turnKey"
                | "sessionKey"
                | "provider"
                | "projectKey"
                | "observedAt"
                | "file.action"
                | "file.phase"
                | "file.pathRole"
                | "file.rawPath"
                | "file.normalizedPath"
                | "file.relativePath"
                | "file.absolute"
                | "file.projectRelative"
        ),
        DeepResource::TokenUsage => matches!(
            field,
            "eventKey"
                | "turnKey"
                | "sessionKey"
                | "provider"
                | "projectKey"
                | "observedAt"
                | "token.scope"
                | "token.model"
                | "token.input"
                | "token.cachedInput"
                | "token.cacheWriteInput"
                | "token.output"
                | "token.reasoning"
                | "token.total"
        ),
        DeepResource::ErrorOccurrence => matches!(
            field,
            "eventKey"
                | "turnKey"
                | "sessionKey"
                | "provider"
                | "projectKey"
                | "observedAt"
                | "error.signatureVersion"
                | "error.signature"
                | "error.exitCode"
                | "error.providerState"
                | "error.content"
                | "capability.key"
                | "capability.canonicalName"
        ),
        DeepResource::Event => unreachable!(),
    };
    valid
        .then_some(())
        .ok_or_else(|| invalid(format!("field {field} is not selectable for this resource")))
}

fn resource_filter_field(resource: DeepResource, field: &str) -> Result<&'static str, QueryError> {
    if resource == DeepResource::Event {
        return event_filter_field(field);
    }
    let column = match field {
        "provider" => "s.provider",
        "projectKey" => {
            "CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END"
        }
        "sessionKey" => "lower(hex(s.session_key))",
        "turnKey" => "CASE WHEN t.turn_key IS NULL THEN NULL ELSE lower(hex(t.turn_key)) END",
        "originScope" if resource == DeepResource::CapabilityUse => "cu.origin_scope",
        "observedAt" => resource_observed_column(resource),
        "capability.key"
            if matches!(
                resource,
                DeepResource::CapabilityUse | DeepResource::ErrorOccurrence
            ) =>
        {
            if resource == DeepResource::CapabilityUse {
                "lower(hex(c.capability_key))"
            } else {
                "CASE WHEN eo.capability_key IS NULL THEN NULL ELSE lower(hex(eo.capability_key)) END"
            }
        }
        "capability.kind" if resource == DeepResource::CapabilityUse => "c.capability_kind",
        "capability.canonicalName"
            if matches!(
                resource,
                DeepResource::CapabilityUse | DeepResource::ErrorOccurrence
            ) =>
        {
            "c.canonical_name"
        }
        "capability.terminalState" if resource == DeepResource::CapabilityUse => {
            "cu.provider_terminal_state"
        }
        "file.action" if resource == DeepResource::FileActivity => "fa.action",
        "file.phase" if resource == DeepResource::FileActivity => "fa.phase",
        "file.normalizedPath" if resource == DeepResource::FileActivity => "fa.normalized_path",
        "file.relativePath" if resource == DeepResource::FileActivity => "fa.relative_path",
        "token.model" if resource == DeepResource::TokenUsage => "tu.model",
        "error.signature" if resource == DeepResource::ErrorOccurrence => {
            "lower(hex(eo.error_signature))"
        }
        "error.providerState" if resource == DeepResource::ErrorOccurrence => "eo.provider_state",
        _ => {
            return Err(invalid(format!(
                "field {field} is not filterable for this resource"
            )));
        }
    };
    Ok(column)
}

fn resource_observed_column(resource: DeepResource) -> &'static str {
    match resource {
        DeepResource::Session => "s.observed_end",
        DeepResource::Turn => "t.observed_timestamp",
        DeepResource::Event => "he.observed_timestamp",
        DeepResource::CapabilityUse => {
            "COALESCE(invocation_event.observed_timestamp,t.observed_timestamp)"
        }
        DeepResource::FileActivity => "fa.observed_timestamp",
        DeepResource::TokenUsage => "tu.observed_timestamp",
        DeepResource::ErrorOccurrence => "eo.observed_timestamp",
    }
}

fn compile_event_predicate(predicate: Option<&DeepPredicate>) -> Result<SqlPredicate, QueryError> {
    predicate
        .map(|predicate| compile_predicate(DeepResource::Event, predicate))
        .unwrap_or_else(|| Ok(SqlPredicate::default()))
}

fn compile_resource_predicate(
    resource: DeepResource,
    predicate: Option<&DeepPredicate>,
) -> Result<SqlPredicate, QueryError> {
    predicate
        .map(|predicate| compile_predicate(resource, predicate))
        .unwrap_or_else(|| Ok(SqlPredicate::default()))
}

fn compile_predicate(
    resource: DeepResource,
    predicate: &DeepPredicate,
) -> Result<SqlPredicate, QueryError> {
    match predicate {
        DeepPredicate::And { and } => compile_boolean(resource, "AND", and),
        DeepPredicate::Or { or } => compile_boolean(resource, "OR", or),
        DeepPredicate::Not { not } => {
            let child = compile_predicate(resource, not)?;
            Ok(SqlPredicate {
                sql: format!("NOT ({})", child.sql),
                values: child.values,
            })
        }
        DeepPredicate::Leaf {
            field,
            operator,
            value,
        } => compile_leaf(resource, field, *operator, value.as_ref()),
    }
}

fn compile_boolean(
    resource: DeepResource,
    operator: &str,
    predicates: &[DeepPredicate],
) -> Result<SqlPredicate, QueryError> {
    let mut parts = Vec::with_capacity(predicates.len());
    let mut values = Vec::new();
    for predicate in predicates {
        let predicate = compile_predicate(resource, predicate)?;
        parts.push(format!("({})", predicate.sql));
        values.extend(predicate.values);
    }
    Ok(SqlPredicate {
        sql: parts.join(&format!(" {operator} ")),
        values,
    })
}

fn compile_leaf(
    resource: DeepResource,
    field: &str,
    operator: PredicateOperator,
    value: Option<&Value>,
) -> Result<SqlPredicate, QueryError> {
    if operator == PredicateOperator::Match {
        if resource != DeepResource::Event || field != "text" {
            return Err(invalid("match is supported only for event text"));
        }
        let query = value
            .and_then(Value::as_str)
            .ok_or_else(|| invalid("match requires a string value"))?;
        let analyzed = analyze_query(query).map_err(|error| match error {
            AnalyzerError::QueryTooLong => {
                QueryError::new("TS_QUERY_TOO_LONG", "query is too long")
            }
            AnalyzerError::QueryTooBroad => {
                QueryError::new("TS_QUERY_TOO_BROAD", "query is too broad")
            }
        })?;
        let expression =
            HistoryFtsMatchExpression::from_query_terms(&analyzed.terms).map_err(query_failed)?;
        return Ok(SqlPredicate {
            sql: "EXISTS (
                    SELECT 1 FROM history_event_fts_documents hfd
                    JOIN history_payloads hp ON hp.payload_key=hfd.payload_key
                    JOIN history_event_fts ON history_event_fts.rowid=hfd.document_id
                    WHERE hp.event_key=he.event_key AND history_event_fts MATCH ?
                  )"
            .to_owned(),
            values: vec![SqlValue::Text(expression.as_str().to_owned())],
        });
    }
    let column = resource_filter_field(resource, field)?;
    let strings = match value {
        None => Vec::new(),
        Some(Value::String(value)) => vec![value.clone()],
        Some(Value::Array(values)) => values
            .iter()
            .map(|value| value.as_str().unwrap_or_default().to_owned())
            .collect(),
        Some(_) => return Err(invalid("predicate value has the wrong type")),
    };
    let mut values = strings.into_iter().map(SqlValue::Text).collect::<Vec<_>>();
    let sql = match operator {
        PredicateOperator::Eq => format!("{column}=?"),
        PredicateOperator::Ne => format!("{column}<>?"),
        PredicateOperator::Lt => format!("{column}<?"),
        PredicateOperator::Lte => format!("{column}<=?"),
        PredicateOperator::Gt => format!("{column}>?"),
        PredicateOperator::Gte => format!("{column}>=?"),
        PredicateOperator::Exists => format!("{column} IS NOT NULL"),
        PredicateOperator::In | PredicateOperator::NotIn => {
            let placeholders = std::iter::repeat_n("?", values.len())
                .collect::<Vec<_>>()
                .join(",");
            let negation = if operator == PredicateOperator::NotIn {
                "NOT "
            } else {
                ""
            };
            format!("{column} {negation}IN ({placeholders})")
        }
        PredicateOperator::Between => format!("{column}>=? AND {column}<?"),
        PredicateOperator::Prefix => {
            let value = values
                .pop()
                .ok_or_else(|| invalid("prefix value is missing"))?;
            let SqlValue::Text(value) = value else {
                unreachable!()
            };
            values.push(SqlValue::Text(format!("{}%", escape_like(&value))));
            format!("{column} LIKE ? ESCAPE '\\'")
        }
        PredicateOperator::Contains => {
            let value = values
                .pop()
                .ok_or_else(|| invalid("contains value is missing"))?;
            let SqlValue::Text(value) = value else {
                unreachable!()
            };
            values.push(SqlValue::Text(format!("%{}%", escape_like(&value))));
            format!("{column} LIKE ? ESCAPE '\\'")
        }
        PredicateOperator::Match => unreachable!("match is compiled before scalar predicates"),
    };
    Ok(SqlPredicate { sql, values })
}

fn escape_like(value: &str) -> String {
    value
        .replace('\\', "\\\\")
        .replace('%', "\\%")
        .replace('_', "\\_")
}

fn where_without_cursor(
    predicate: Option<&DeepPredicate>,
) -> Result<(String, Vec<SqlValue>), QueryError> {
    let predicate = compile_event_predicate(predicate)?;
    let mut sql = String::from(
        "s.eligibility='eligible' AND s.session_scope='main' AND NOT EXISTS (
           SELECT 1 FROM source_purge_states purge WHERE purge.session_key=s.session_key
         )",
    );
    if !predicate.sql.is_empty() {
        sql.push_str(" AND (");
        sql.push_str(&predicate.sql);
        sql.push(')');
    }
    Ok((sql, predicate.values))
}

fn event_visibility_sql() -> &'static str {
    "s.eligibility='eligible' AND s.session_scope='main' AND NOT EXISTS (
       SELECT 1 FROM source_purge_states purge WHERE purge.session_key=s.session_key
     )"
}

fn exact_event_kind_predicate(predicate: Option<&DeepPredicate>) -> Option<&str> {
    let DeepPredicate::Leaf {
        field,
        operator: PredicateOperator::Eq,
        value: Some(value),
    } = predicate?
    else {
        return None;
    };
    (field == "event.kind").then(|| value.as_str()).flatten()
}

fn projected_event_kind_count(
    connection: &Connection,
    event_kind: &str,
) -> Result<u64, QueryError> {
    connection
        .query_row(
            "SELECT COALESCE(SUM(rollup.record_count),0)
             FROM history_event_kind_rollups rollup
             JOIN sessions s ON s.session_id=rollup.session_id
             WHERE rollup.event_kind=?1 AND s.eligibility='eligible'
               AND s.session_scope='main'
               AND NOT EXISTS (SELECT 1 FROM source_purge_states purge
                               WHERE purge.session_key=s.session_key)",
            [event_kind],
            |row| row.get::<_, i64>(0),
        )
        .map_err(query_failed)
        .and_then(|value| nonnegative(value, "event count"))
}

fn event_coverage_predicate(
    predicate: Option<&DeepPredicate>,
) -> Result<Option<SqlPredicate>, QueryError> {
    if predicate.is_some_and(|predicate| !event_coverage_predicate_supported(predicate)) {
        return Ok(None);
    }
    compile_event_predicate(predicate).map(Some)
}

fn event_coverage_predicate_supported(predicate: &DeepPredicate) -> bool {
    match predicate {
        DeepPredicate::And { and } => and.iter().all(event_coverage_predicate_supported),
        DeepPredicate::Or { or } => or.iter().all(event_coverage_predicate_supported),
        DeepPredicate::Not { not } => event_coverage_predicate_supported(not),
        DeepPredicate::Leaf { field, .. } => matches!(
            field.as_str(),
            "provider" | "projectKey" | "sessionKey" | "observedAt" | "completeness" | "event.kind"
        ),
    }
}

fn event_row(row: &rusqlite::Row<'_>) -> rusqlite::Result<EventRow> {
    let metadata_json: String = row.get(10)?;
    let metadata = serde_json::from_str(&metadata_json).map_err(|error| {
        rusqlite::Error::FromSqlConversionFailure(
            metadata_json.len(),
            rusqlite::types::Type::Text,
            Box::new(error),
        )
    })?;
    Ok(EventRow {
        event_key: row.get(0)?,
        session_key: row.get(1)?,
        turn_key: row.get(2)?,
        provider: row.get(3)?,
        project_key: row.get(4)?,
        origin_scope: row.get(5)?,
        observed_at: row.get(6)?,
        kind: row.get(7)?,
        completeness: row.get(8)?,
        revision: row.get(9)?,
        metadata,
    })
}

fn build_event_record(
    connection: &Connection,
    event: &EventRow,
    select: &[String],
    payload_mode: PayloadMode,
) -> Result<Value, QueryError> {
    let payloads = read_payloads(connection, &event.event_key)?;
    let mut record = Map::new();
    for field in select {
        let value = match field.as_str() {
            "eventKey" => json!(event.event_key),
            "sessionKey" => json!(event.session_key),
            "turnKey" => json!(event.turn_key),
            "provider" => json!(event.provider),
            "projectKey" => json!(event.project_key),
            "originScope" => json!(event.origin_scope),
            "observedAt" => json!(event.observed_at),
            "completeness" => json!(event.completeness),
            "revision" => json!(event.revision),
            "event.kind" => json!(event.kind),
            "message.role" => event.metadata.get("role").cloned().unwrap_or(Value::Null),
            "message.content" => content_value(
                connection,
                event,
                &payloads,
                "message-content",
                payload_mode,
            )?,
            "tool.input" => {
                content_value(connection, event, &payloads, "tool-input", payload_mode)?
            }
            "tool.output" => {
                content_value(connection, event, &payloads, "tool-output", payload_mode)?
            }
            "error.content" => {
                content_value(connection, event, &payloads, "error-content", payload_mode)?
            }
            "providerPayload" => content_value(
                connection,
                event,
                &payloads,
                "provider-payload",
                payload_mode,
            )?,
            "payloadRef" => Value::Array(
                payloads
                    .iter()
                    .map(|payload| payload_reference(event, payload))
                    .collect(),
            ),
            _ => unreachable!("validated event field"),
        };
        insert_path(&mut record, field, value)?;
    }
    Ok(Value::Object(record))
}

fn read_payloads(connection: &Connection, event_key: &str) -> Result<Vec<PayloadRow>, QueryError> {
    let mut statement = connection
        .prepare(
            "SELECT lower(hex(payload_key)),payload_kind,encoding,byte_length,
                    lower(hex(sha256)),completeness
             FROM history_payloads WHERE event_key=?1 ORDER BY payload_key",
        )
        .map_err(query_failed)?;
    let rows = statement
        .query_map([decode_key(event_key, "eventKey")?], |row| {
            Ok(PayloadRow {
                payload_key: row.get(0)?,
                kind: row.get(1)?,
                encoding: row.get(2)?,
                byte_length: blob_u64(row.get(3)?)?,
                sha256: row.get(4)?,
                completeness: row.get(5)?,
            })
        })
        .map_err(query_failed)?;
    rows.collect::<Result<Vec<_>, _>>().map_err(query_failed)
}

fn content_value(
    connection: &Connection,
    event: &EventRow,
    payloads: &[PayloadRow],
    kind: &str,
    payload_mode: PayloadMode,
) -> Result<Value, QueryError> {
    let Some(payload) = payloads.iter().find(|payload| payload.kind == kind) else {
        return Ok(Value::Null);
    };
    let inline = if payload_mode == PayloadMode::Inline
        && payload.byte_length <= MAX_QUERY_PAGE_BYTES as u64
    {
        Some(read_complete_payload(
            connection,
            &payload.payload_key,
            payload.byte_length,
        )?)
    } else {
        None
    };
    let reference =
        if inline.is_none() && (payload_mode != PayloadMode::Omit || kind != "provider-payload") {
            Some(payload_reference(event, payload))
        } else {
            None
        };
    Ok(json!({
        "byteLength": payload.byte_length.to_string(),
        "sha256": payload.sha256,
        "encoding": payload.encoding,
        "inline": inline,
        "reference": reference,
        "complete": payload.completeness == "full",
    }))
}

fn content_value_any(
    connection: &Connection,
    event: &EventRow,
    payloads: &[PayloadRow],
    kinds: &[&str],
    payload_mode: PayloadMode,
) -> Result<Value, QueryError> {
    for kind in kinds {
        if payloads.iter().any(|payload| payload.kind == *kind) {
            return content_value(connection, event, payloads, kind, payload_mode);
        }
    }
    Ok(Value::Null)
}

fn payload_reference(event: &EventRow, payload: &PayloadRow) -> Value {
    json!({
        "kind": "event",
        "eventKey": event.event_key,
        "revision": event.revision,
        "payloadKey": payload.payload_key,
    })
}

fn read_complete_payload(
    connection: &Connection,
    payload_key: &str,
    expected_bytes: u64,
) -> Result<String, QueryError> {
    let mut statement = connection
        .prepare("SELECT content FROM history_payload_chunks WHERE payload_key=?1 ORDER BY ordinal")
        .map_err(query_failed)?;
    let rows = statement
        .query_map([decode_key(payload_key, "payloadKey")?], |row| {
            row.get::<_, String>(0)
        })
        .map_err(query_failed)?;
    let mut content = String::with_capacity(usize::try_from(expected_bytes).unwrap_or_default());
    for chunk in rows {
        content.push_str(&chunk.map_err(query_failed)?);
    }
    if content.len() as u64 != expected_bytes {
        return Err(QueryError::new(
            "QUERY_FAILED",
            "stored payload byte length is invalid",
        ));
    }
    Ok(content)
}

fn insert_path(
    record: &mut Map<String, Value>,
    path: &str,
    value: Value,
) -> Result<(), QueryError> {
    let mut segments = path.split('.').peekable();
    let mut current = record;
    while let Some(segment) = segments.next() {
        if segments.peek().is_none() {
            current.insert(segment.to_owned(), value);
            return Ok(());
        }
        let entry = current
            .entry(segment.to_owned())
            .or_insert_with(|| Value::Object(Map::new()));
        current = entry
            .as_object_mut()
            .ok_or_else(|| invalid("selected fields have a conflicting object shape"))?;
    }
    Err(invalid("selected field path is empty"))
}

fn read_event_coverage(
    connection: &Connection,
    predicate: Option<&DeepPredicate>,
) -> Result<DeepCoverage, QueryError> {
    if let Some(predicate) = event_coverage_predicate(predicate)? {
        return read_projected_event_coverage(connection, predicate);
    }
    let (where_sql, values) = where_without_cursor(predicate)?;
    let sql = format!(
        "SELECT
           SUM(he.completeness='full'),SUM(he.completeness='summary'),
           SUM(he.completeness='unloaded'),SUM(he.completeness='truncated'),
           SUM(he.completeness='unavailable'),SUM(he.observed_timestamp IS NULL),
           SUM(he.revision IS NULL),
           SUM(CASE WHEN tu.event_key IS NOT NULL THEN
             (tu.input_tokens IS NULL) + (tu.cached_input_tokens IS NULL) +
             (tu.cache_write_input_tokens IS NULL) + (tu.output_tokens IS NULL) +
             (tu.reasoning_tokens IS NULL) + (tu.total_tokens IS NULL)
           ELSE 0 END),
           SUM(CASE
             WHEN he.event_kind='visible-message' AND NOT EXISTS (
               SELECT 1 FROM history_payloads hp
               WHERE hp.event_key=he.event_key AND hp.payload_kind='message-content'
             ) THEN 1
             WHEN he.event_kind='capability-invocation' AND NOT EXISTS (
               SELECT 1 FROM history_payloads hp
               WHERE hp.event_key=he.event_key AND hp.payload_kind='tool-input'
             ) THEN 1
             WHEN he.event_kind='capability-result'
                  AND (json_type(he.metadata_json,'$.outputBytes') IS NOT NULL
                       OR json_type(he.metadata_json,'$.errorSignature') IS NOT NULL)
                  AND NOT EXISTS (
               SELECT 1 FROM history_payloads hp WHERE hp.event_key=he.event_key
                 AND hp.payload_kind IN ('tool-output','error-content')
             ) THEN 1
             WHEN he.event_kind='provider-unknown' AND NOT EXISTS (
               SELECT 1 FROM history_payloads hp
               WHERE hp.event_key=he.event_key AND hp.payload_kind='provider-payload'
             ) THEN 1 ELSE 0 END)
         FROM history_events he
         JOIN sessions s ON s.session_id=he.session_id
         LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id
         LEFT JOIN token_usage tu ON tu.event_key=he.event_key
         WHERE {where_sql}",
    );
    let counts: (i64, i64, i64, i64, i64, i64, i64, i64, i64) = connection
        .query_row(&sql, params_from_iter(values), |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                row.get::<_, Option<i64>>(8)?.unwrap_or(0),
            ))
        })
        .map_err(query_failed)?;
    let matching = DeepMatchingCoverage {
        full_record_count: nonnegative(counts.0, "full coverage count")?.to_string(),
        summary_record_count: nonnegative(counts.1, "summary coverage count")?.to_string(),
        unloaded_record_count: nonnegative(counts.2, "unloaded coverage count")?.to_string(),
        truncated_record_count: nonnegative(counts.3, "truncated coverage count")?.to_string(),
        unavailable_record_count: nonnegative(counts.4, "unavailable coverage count")?.to_string(),
        missing_timestamp_count: nonnegative(counts.5, "timestamp coverage count")?.to_string(),
        missing_revision_count: nonnegative(counts.6, "revision coverage count")?.to_string(),
        missing_token_metric_count: nonnegative(counts.7, "token coverage count")?.to_string(),
        missing_payload_count: nonnegative(counts.8, "payload coverage count")?.to_string(),
    };
    assemble_coverage(connection, matching, "TS_INSIGHTS_COVERAGE_INCOMPLETE")
}

fn read_projected_event_coverage(
    connection: &Connection,
    predicate: SqlPredicate,
) -> Result<DeepCoverage, QueryError> {
    if predicate.sql == "he.event_kind=?" && predicate.values.len() == 1 {
        let SqlValue::Text(event_kind) = &predicate.values[0] else {
            return Err(QueryError::new(
                "QUERY_FAILED",
                "event kind coverage predicate is invalid",
            ));
        };
        let counts = connection
            .query_row(
                "SELECT COALESCE(SUM(rollup.full_count),0),
                        COALESCE(SUM(rollup.summary_count),0),
                        COALESCE(SUM(rollup.unloaded_count),0),
                        COALESCE(SUM(rollup.truncated_count),0),
                        COALESCE(SUM(rollup.unavailable_count),0),
                        COALESCE(SUM(rollup.missing_timestamp_count),0),
                        COALESCE(SUM(rollup.missing_revision_count),0),
                        COALESCE(SUM(rollup.missing_token_metric_count),0),
                        COALESCE(SUM(rollup.missing_payload_count),0)
                 FROM history_event_kind_rollups rollup
                 JOIN sessions s ON s.session_id=rollup.session_id
                 WHERE rollup.event_kind=?1 AND s.eligibility='eligible'
                   AND s.session_scope='main'
                   AND NOT EXISTS (SELECT 1 FROM source_purge_states purge
                                   WHERE purge.session_key=s.session_key)",
                [event_kind],
                |row| {
                    Ok((
                        row.get(0)?,
                        row.get(1)?,
                        row.get(2)?,
                        row.get(3)?,
                        row.get(4)?,
                        row.get(5)?,
                        row.get(6)?,
                        row.get(7)?,
                        row.get(8)?,
                    ))
                },
            )
            .map_err(query_failed)?;
        return coverage_from_counts(connection, counts);
    }
    let mut where_sql = event_visibility_sql().to_owned();
    if !predicate.sql.is_empty() {
        where_sql.push_str(" AND (");
        where_sql.push_str(&predicate.sql);
        where_sql.push(')');
    }
    let sql = format!(
        "SELECT
           SUM(he.completeness='full'),SUM(he.completeness='summary'),
           SUM(he.completeness='unloaded'),SUM(he.completeness='truncated'),
           SUM(he.completeness='unavailable'),SUM(he.observed_timestamp IS NULL),
           SUM(he.missing_revision),SUM(he.missing_token_metric),SUM(he.missing_payload)
         FROM history_event_coverage he
         JOIN sessions s ON s.session_id=he.session_id
         WHERE {where_sql}"
    );
    let counts = connection
        .query_row(&sql, params_from_iter(predicate.values), |row| {
            Ok((
                row.get::<_, Option<i64>>(0)?.unwrap_or(0),
                row.get::<_, Option<i64>>(1)?.unwrap_or(0),
                row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                row.get::<_, Option<i64>>(5)?.unwrap_or(0),
                row.get::<_, Option<i64>>(6)?.unwrap_or(0),
                row.get::<_, Option<i64>>(7)?.unwrap_or(0),
                row.get::<_, Option<i64>>(8)?.unwrap_or(0),
            ))
        })
        .map_err(query_failed)?;
    coverage_from_counts(connection, counts)
}

fn read_payload_page(
    connection: &Connection,
    payload_key: &[u8],
    global_offset: u64,
    chunk_ordinal: u64,
    chunk_offset: u64,
    max_bytes: u32,
) -> Result<(String, u64, u64, u64), QueryError> {
    let mut statement = connection
        .prepare(
            "SELECT ordinal,content FROM history_payload_chunks
             WHERE payload_key=?1 AND ordinal>=?2 ORDER BY ordinal",
        )
        .map_err(query_failed)?;
    let mut rows = statement
        .query(params![payload_key, chunk_ordinal.to_be_bytes().to_vec()])
        .map_err(query_failed)?;
    let mut output = Vec::with_capacity(max_bytes as usize);
    let mut next_ordinal = chunk_ordinal;
    let mut next_chunk_offset = chunk_offset;
    while output.len() < max_bytes as usize {
        let Some(row) = rows.next().map_err(query_failed)? else {
            break;
        };
        let ordinal = blob_u64(row.get(0).map_err(query_failed)?).map_err(query_failed)?;
        let content: String = row.get(1).map_err(query_failed)?;
        let offset = if ordinal == chunk_ordinal {
            usize::try_from(chunk_offset).map_err(|_| stale("evidence cursor offset is invalid"))?
        } else {
            0
        };
        if offset > content.len() || !content.is_char_boundary(offset) {
            return Err(stale("evidence cursor is not on a UTF-8 boundary"));
        }
        let remaining = max_bytes as usize - output.len();
        let mut take = remaining.min(content.len() - offset);
        while take > 0 && !content.is_char_boundary(offset + take) {
            take -= 1;
        }
        if take == 0 && offset < content.len() {
            let next = content[offset..]
                .chars()
                .next()
                .ok_or_else(|| QueryError::new("QUERY_FAILED", "stored payload is invalid"))?;
            take = next.len_utf8();
            if take > remaining {
                break;
            }
        }
        output.extend_from_slice(&content.as_bytes()[offset..offset + take]);
        if offset + take < content.len() {
            next_ordinal = ordinal;
            next_chunk_offset = u64::try_from(offset + take)
                .map_err(|_| QueryError::new("QUERY_FAILED", "payload offset is invalid"))?;
            break;
        }
        next_ordinal = ordinal
            .checked_add(1)
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "payload ordinal overflowed"))?;
        next_chunk_offset = 0;
    }
    drop(rows);
    drop(statement);
    let content = String::from_utf8(output)
        .map_err(|_| QueryError::new("QUERY_FAILED", "stored payload is not valid UTF-8"))?;
    let end = global_offset
        .checked_add(content.len() as u64)
        .ok_or_else(|| QueryError::new("QUERY_FAILED", "payload range overflowed"))?;
    Ok((content, end, next_ordinal, next_chunk_offset))
}

fn encode_cursor(value: &impl Serialize) -> Result<String, QueryError> {
    let value = serde_json::to_value(value).map_err(|_| invalid("cursor cannot be encoded"))?;
    let encoded = hex::encode(canonical_json(&value));
    if encoded.len() > MAX_CURSOR_BYTES {
        return Err(invalid("cursor exceeds bounded size"));
    }
    Ok(encoded)
}

fn decode_query_cursor(value: &str) -> Result<QueryCursor, QueryError> {
    decode_cursor(value, "query")
}

fn decode_evidence_cursor(value: &str) -> Result<EvidenceCursor, QueryError> {
    decode_cursor(value, "evidence")
}

fn decode_cursor<T: for<'de> Deserialize<'de>>(value: &str, name: &str) -> Result<T, QueryError> {
    let bytes = hex::decode(value).map_err(|_| stale(format!("{name} cursor is invalid")))?;
    serde_json::from_slice(&bytes).map_err(|_| stale(format!("{name} cursor is invalid")))
}

fn decode_key(value: &str, name: &str) -> Result<Vec<u8>, QueryError> {
    if !valid_stable_key(value) {
        return Err(invalid(format!(
            "{name} must be a lowercase 32-byte hex key"
        )));
    }
    hex::decode(value).map_err(|_| invalid(format!("{name} is invalid")))
}

fn blob_u64(value: Vec<u8>) -> rusqlite::Result<u64> {
    let bytes: [u8; 8] = value.try_into().map_err(|value: Vec<u8>| {
        rusqlite::Error::FromSqlConversionFailure(
            value.len(),
            rusqlite::types::Type::Blob,
            "expected an 8-byte unsigned integer".into(),
        )
    })?;
    Ok(u64::from_be_bytes(bytes))
}

fn nonnegative(value: i64, name: &str) -> Result<u64, QueryError> {
    u64::try_from(value).map_err(|_| QueryError::new("QUERY_FAILED", format!("{name} is invalid")))
}

fn invalid(message: impl Into<String>) -> QueryError {
    QueryError::new("TS_INSIGHTS_REQUEST_INVALID", message)
}

fn stale(message: impl Into<String>) -> QueryError {
    QueryError::new("TS_INSIGHTS_CURSOR_STALE", message)
}
