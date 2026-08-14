//! Versioned, evidence-bearing analyses over the Fact V2 local event store.

use std::collections::{BTreeMap, BTreeSet};

use rusqlite::{Connection, params_from_iter, types::Value as SqlValue};
use serde::{Deserialize, Serialize};
use serde_json::{Map, Value, json};

use crate::agent_query::{
    ActivityBucket as QueryActivityBucket, ActivityRequest, ActivityWindow,
    parse_canonical_timestamp, read_activity_buckets_in_snapshot,
};
use crate::analyzer::{AnalyzerError, analyze_query};
use crate::deep_query::{
    DeepCoverage, DeepMatchingCoverage, DeepProvenance, DeepProvenanceField, assemble_coverage,
};
use crate::fts_projection::HistoryFtsMatchExpression;
use crate::query::{QueryError, query_failed};

pub const RECIPE_REQUEST_FORMAT: &str = "threadshare-insights-recipe-request@v1";
pub const RECIPE_RESPONSE_FORMAT: &str = "threadshare-insights-recipe@v1";
const MAX_FILTER_VALUES: usize = 64;
const MAX_RECIPE_LIMIT: u16 = 50;
const MAX_RECIPE_ITEMS: usize = 10_000;
const MAX_RECIPE_DETAIL_ITEMS: usize = 10_000;
const MAX_RECIPE_PAGE_BYTES: usize = 3_932_160;
const RECIPE_QUIESCENCE_SECONDS: u32 = 300;
const RECIPE_SCAN_SEGMENT_MS: u64 = 7 * 86_400_000;

#[derive(Debug, Clone, Copy, PartialEq, Eq, PartialOrd, Ord, Serialize, Deserialize)]
pub enum RecipeName {
    #[serde(rename = "capability-contexts@1")]
    CapabilityContexts,
    #[serde(rename = "failure-chains@1")]
    FailureChains,
    #[serde(rename = "file-workflow-signals@1")]
    FileWorkflowSignals,
    #[serde(rename = "activity-shifts@1")]
    ActivityShifts,
    #[serde(rename = "token-hotspots@1")]
    TokenHotspots,
    #[serde(rename = "solution-recall@1")]
    SolutionRecall,
    #[serde(rename = "session-timeline@1")]
    SessionTimeline,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum RecipeBucket {
    Day,
    Week,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeWindow {
    pub after: String,
    pub before: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeFilters {
    #[serde(default)]
    pub providers: Vec<String>,
    #[serde(default)]
    pub project_keys: Vec<String>,
    #[serde(default)]
    pub capability_keys: Vec<String>,
    #[serde(default)]
    pub session_keys: Vec<String>,
    #[serde(default)]
    pub event_kinds: Vec<String>,
    #[serde(default)]
    pub text: Option<String>,
    #[serde(default)]
    pub bucket: Option<RecipeBucket>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeRequest {
    pub format: String,
    pub name: RecipeName,
    pub window: RecipeWindow,
    #[serde(default)]
    pub comparison_window: Option<RecipeWindow>,
    #[serde(default)]
    pub filters: RecipeFilters,
    pub limit: u16,
    #[serde(default)]
    pub allow_degraded: bool,
    pub evaluated_at: String,
}

#[derive(Debug, Clone, PartialEq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase", deny_unknown_fields)]
pub struct RecipeResponse {
    pub format: String,
    pub database_uuid: String,
    pub snapshot_seq: String,
    pub name: RecipeName,
    pub window: RecipeWindow,
    pub comparison_window: Option<RecipeWindow>,
    pub evaluated_at: String,
    pub items: Vec<Value>,
    pub total_item_count: String,
    pub truncated: bool,
    pub coverage: DeepCoverage,
    pub provenance: DeepProvenance,
}

impl RecipeResponse {
    pub fn validate(&self) -> Result<(), QueryError> {
        if self.format != RECIPE_RESPONSE_FORMAT {
            return Err(invalid("recipe response format is not supported"));
        }
        let total = self
            .total_item_count
            .parse::<usize>()
            .map_err(|_| invalid("recipe response totalItemCount is invalid"))?;
        if total < self.items.len() || self.truncated != (total > self.items.len()) {
            return Err(invalid("recipe response counts are inconsistent"));
        }
        for item in &self.items {
            validate_recipe_item(self.name, item)?;
        }
        Ok(())
    }
}

fn validate_recipe_item(name: RecipeName, item: &Value) -> Result<(), QueryError> {
    match name {
        RecipeName::CapabilityContexts => {
            let item = exact_object(
                item,
                &[
                    "capability",
                    "recordedInvocationCount",
                    "recordedFailingInvocationCount",
                    "distinctTurnCount",
                    "distinctSessionCount",
                    "distinctDedupeGroupCount",
                    "groupedInvocationCount",
                    "ungroupedInvocationCount",
                    "lastUsedAt",
                    "strongGroupMemberInvocationCount",
                    "weakGroupMemberInvocationCount",
                    "invocationTerminalCounts",
                    "topProjects",
                    "coOccurringCapabilities",
                    "representativeTurns",
                    "evidence",
                ],
            )?;
            exact_object(
                &item["capability"],
                &["capabilityKey", "provider", "kind", "canonicalName"],
            )?;
            exact_object(
                &item["invocationTerminalCounts"],
                &["pending", "completed", "failed", "cancelled", "unknown"],
            )?;
            validate_object_array(
                &item["topProjects"],
                &["projectKey", "recordedInvocationCount"],
            )?;
            validate_object_array(
                &item["coOccurringCapabilities"],
                &[
                    "capabilityKey",
                    "kind",
                    "canonicalName",
                    "distinctTurnCount",
                ],
            )?;
            for representative in value_array(&item["representativeTurns"])? {
                let representative = exact_object(
                    representative,
                    &[
                        "turnKey",
                        "usedAt",
                        "recordedInvocationCount",
                        "context",
                        "evidence",
                    ],
                )?;
                exact_object(&representative["context"], &["problem", "finalAnswer"])?;
                validate_evidence_target(&representative["evidence"])?;
            }
            validate_nullable_evidence_target(&item["evidence"])?;
        }
        RecipeName::FailureChains => {
            let item = exact_object(
                item,
                &[
                    "chainKey",
                    "revision",
                    "status",
                    "capabilityName",
                    "eventCount",
                    "failedResultCount",
                    "completedResultCount",
                    "firstObservedAt",
                    "lastObservedAt",
                    "attempts",
                    "evidence",
                ],
            )?;
            for attempt in value_array(&item["attempts"])? {
                let attempt = exact_object(
                    attempt,
                    &[
                        "eventKey",
                        "revision",
                        "eventKind",
                        "observedAt",
                        "capabilityKey",
                        "capabilityName",
                        "inputFingerprint",
                        "providerState",
                        "exitCode",
                        "input",
                        "output",
                        "error",
                        "evidence",
                    ],
                )?;
                for field in ["input", "output", "error"] {
                    validate_nullable_content_reference(&attempt[field])?;
                }
                validate_evidence_target(&attempt["evidence"])?;
            }
            validate_evidence_target(&item["evidence"])?;
        }
        RecipeName::FileWorkflowSignals => {
            let item = exact_object(
                item,
                &[
                    "sessionKey",
                    "provider",
                    "projectKey",
                    "recordedCounts",
                    "estimated",
                    "evidence",
                    "events",
                ],
            )?;
            exact_object(
                &item["recordedCounts"],
                &[
                    "read",
                    "edit",
                    "write",
                    "delete",
                    "move",
                    "search",
                    "list",
                    "attempted",
                    "confirmed",
                    "failed",
                    "unknown",
                    "distinctPath",
                    "documentLike",
                    "implementationLike",
                ],
            )?;
            exact_object(
                &item["estimated"],
                &[
                    "researchHeavy",
                    "implementationHeavy",
                    "docVoid",
                    "specPrecisionGap",
                    "method",
                ],
            )?;
            for event in value_array(&item["events"])? {
                let event = exact_object(
                    event,
                    &[
                        "eventKey",
                        "revision",
                        "observedAt",
                        "eventKind",
                        "activityOrdinal",
                        "action",
                        "phase",
                        "pathRole",
                        "rawPath",
                        "normalizedPath",
                        "relativePath",
                        "absolute",
                        "projectRelative",
                        "input",
                        "output",
                        "error",
                        "evidence",
                    ],
                )?;
                for field in ["input", "output", "error"] {
                    validate_nullable_content_reference(&event[field])?;
                }
                validate_evidence_target(&event["evidence"])?;
            }
            validate_evidence_target(&item["evidence"])?;
        }
        RecipeName::ActivityShifts => validate_activity_item(item)?,
        RecipeName::TokenHotspots => {
            let item = exact_object(
                item,
                &[
                    "provider",
                    "model",
                    "projectKey",
                    "capability",
                    "capabilityAttribution",
                    "recordedTokenTotals",
                    "metricCoverage",
                    "evidence",
                ],
            )?;
            validate_token_totals(&item["recordedTokenTotals"])?;
            validate_token_coverage(&item["metricCoverage"])?;
            validate_nullable_evidence_target(&item["evidence"])?;
        }
        RecipeName::SolutionRecall => {
            let item = exact_object(
                item,
                &[
                    "eventKey",
                    "eventRevision",
                    "turnKey",
                    "turnRevision",
                    "provider",
                    "projectKey",
                    "eventKind",
                    "observedAt",
                    "finalAnswer",
                    "subsequentSuccess",
                    "evidence",
                ],
            )?;
            if !item["subsequentSuccess"].is_null() {
                let success = exact_object(
                    &item["subsequentSuccess"],
                    &["chainKey", "eventKey", "observedAt", "evidence"],
                )?;
                validate_evidence_target(&success["evidence"])?;
            }
            validate_evidence_target(&item["evidence"])?;
        }
        RecipeName::SessionTimeline => {
            let item = exact_object(
                item,
                &[
                    "eventKey",
                    "revision",
                    "observedAt",
                    "eventKind",
                    "originScope",
                    "completeness",
                    "metadata",
                    "turnKey",
                    "turnRevision",
                    "evidence",
                ],
            )?;
            if !item["metadata"].is_object() {
                return Err(invalid("recipe timeline metadata must be an object"));
            }
            validate_evidence_target(&item["evidence"])?;
        }
    }
    Ok(())
}

fn validate_activity_item(item: &Value) -> Result<(), QueryError> {
    let item = exact_object(
        item,
        &[
            "bucketStart",
            "bucketEnd",
            "timeZone",
            "closureEvaluatedAt",
            "quiescenceSeconds",
            "distinctSessionCount",
            "distinctTurnCount",
            "distinctProjectCount",
            "observedContextSwitchCount",
            "recordedToolInvocationCount",
            "recordedSkillInvocationCount",
            "recordedTokenEventCount",
            "recordedTokenTotals",
            "tokenMetricCoverage",
            "currentClosureCounts",
            "turnOutcomeCounts",
            "dedupeSupport",
            "comparison",
            "evidence",
        ],
    )?;
    validate_token_totals(&item["recordedTokenTotals"])?;
    validate_token_coverage(&item["tokenMetricCoverage"])?;
    exact_object(
        &item["currentClosureCounts"],
        &["hardSealed", "quiescent", "open"],
    )?;
    exact_object(
        &item["turnOutcomeCounts"],
        &["providerCompleted", "abandoned", "unknown"],
    )?;
    validate_dedupe_support(&item["dedupeSupport"])?;
    if !item["comparison"].is_null() {
        let comparison = exact_object(
            &item["comparison"],
            &[
                "baselineBucketStart",
                "distinctSessionCount",
                "distinctTurnCount",
                "distinctProjectCount",
                "observedContextSwitchCount",
                "recordedToolInvocationCount",
                "recordedSkillInvocationCount",
                "recordedTokenEventCount",
                "recordedTokenTotals",
                "currentClosureCounts",
                "turnOutcomeCounts",
            ],
        )?;
        for field in [
            "distinctSessionCount",
            "distinctTurnCount",
            "distinctProjectCount",
            "observedContextSwitchCount",
            "recordedToolInvocationCount",
            "recordedSkillInvocationCount",
            "recordedTokenEventCount",
        ] {
            validate_change(&comparison[field])?;
        }
        validate_token_changes(&comparison["recordedTokenTotals"])?;
        for field in ["currentClosureCounts", "turnOutcomeCounts"] {
            let object = comparison[field]
                .as_object()
                .ok_or_else(|| invalid("recipe comparison must be an object"))?;
            for value in object.values() {
                validate_change(value)?;
            }
        }
    }
    validate_nullable_evidence_target(&item["evidence"])
}

fn validate_token_totals(value: &Value) -> Result<(), QueryError> {
    exact_object(
        value,
        &[
            "input",
            "cachedInput",
            "cacheWriteInput",
            "output",
            "reasoning",
            "total",
        ],
    )?;
    Ok(())
}

fn validate_token_coverage(value: &Value) -> Result<(), QueryError> {
    let value = exact_object(
        value,
        &[
            "input",
            "cachedInput",
            "cacheWriteInput",
            "output",
            "reasoning",
            "total",
        ],
    )?;
    for metric in value.values() {
        exact_object(metric, &["presentEventCount", "totalEventCount"])?;
    }
    Ok(())
}

fn validate_token_changes(value: &Value) -> Result<(), QueryError> {
    let value = exact_object(
        value,
        &[
            "input",
            "cachedInput",
            "cacheWriteInput",
            "output",
            "reasoning",
            "total",
        ],
    )?;
    for change in value.values() {
        validate_change(change)?;
    }
    Ok(())
}

fn validate_change(value: &Value) -> Result<(), QueryError> {
    exact_object(value, &["baseline", "current", "absoluteChange"])?;
    Ok(())
}

fn validate_dedupe_support(value: &Value) -> Result<(), QueryError> {
    exact_object(
        value,
        &[
            "distinctDedupeGroupCount",
            "strongDedupeGroupCount",
            "weakDedupeGroupCount",
            "observedEofProvisionalGroupCount",
            "unknownDedupeSessionCount",
        ],
    )?;
    Ok(())
}

fn validate_nullable_content_reference(value: &Value) -> Result<(), QueryError> {
    if value.is_null() {
        return Ok(());
    }
    let value = exact_object(
        value,
        &[
            "byteLength",
            "sha256",
            "encoding",
            "inline",
            "reference",
            "complete",
        ],
    )?;
    if !value["inline"].is_null() || value["reference"].is_null() {
        return Err(invalid("recipe content must use an evidence reference"));
    }
    validate_evidence_target(&value["reference"])
}

fn validate_nullable_evidence_target(value: &Value) -> Result<(), QueryError> {
    if value.is_null() {
        Ok(())
    } else {
        validate_evidence_target(value)
    }
}

fn validate_evidence_target(value: &Value) -> Result<(), QueryError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("recipe evidence target must be an object"))?;
    let expected = match object.get("kind").and_then(Value::as_str) {
        Some("event") if object.contains_key("payloadKey") => {
            &["kind", "eventKey", "revision", "payloadKey"][..]
        }
        Some("event") => &["kind", "eventKey", "revision"][..],
        Some("turn") => &["kind", "turnKey", "revision"][..],
        Some("session") => &["kind", "sessionKey", "revision"][..],
        Some("attempt-chain") => &["kind", "chainKey", "revision"][..],
        _ => return Err(invalid("recipe evidence target kind is invalid")),
    };
    exact_object(value, expected)?;
    Ok(())
}

fn validate_object_array(value: &Value, keys: &[&str]) -> Result<(), QueryError> {
    for item in value_array(value)? {
        exact_object(item, keys)?;
    }
    Ok(())
}

fn value_array(value: &Value) -> Result<&[Value], QueryError> {
    value
        .as_array()
        .map(Vec::as_slice)
        .ok_or_else(|| invalid("recipe field must be an array"))
}

fn exact_object<'a>(
    value: &'a Value,
    expected: &[&str],
) -> Result<&'a Map<String, Value>, QueryError> {
    let object = value
        .as_object()
        .ok_or_else(|| invalid("recipe field must be an object"))?;
    let actual = object.keys().map(String::as_str).collect::<BTreeSet<_>>();
    let expected = expected.iter().copied().collect::<BTreeSet<_>>();
    if actual != expected {
        return Err(invalid("recipe field set is invalid"));
    }
    Ok(object)
}

#[derive(Debug, Clone, Copy)]
struct WindowBounds {
    after_ms: u64,
    before_ms: u64,
}

impl RecipeRequest {
    pub fn validate(&self) -> Result<(), QueryError> {
        if self.format != RECIPE_REQUEST_FORMAT {
            return Err(invalid("recipe format is not supported"));
        }
        if !(1..=MAX_RECIPE_LIMIT).contains(&self.limit) {
            return Err(invalid("recipe limit must be in 1..=50"));
        }
        self.window.bounds("window")?;
        if let Some(window) = &self.comparison_window {
            window.bounds("comparisonWindow")?;
            if self.name != RecipeName::ActivityShifts {
                return Err(invalid(
                    "comparisonWindow is supported only by activity-shifts@1",
                ));
            }
        }
        parse_canonical_timestamp(&self.evaluated_at, "evaluatedAt")?;
        validate_filter_values(&self.filters.providers, "filters.providers", false)?;
        validate_filter_values(&self.filters.project_keys, "filters.projectKeys", true)?;
        validate_filter_values(
            &self.filters.capability_keys,
            "filters.capabilityKeys",
            true,
        )?;
        validate_filter_values(&self.filters.session_keys, "filters.sessionKeys", true)?;
        validate_filter_values(&self.filters.event_kinds, "filters.eventKinds", false)?;
        if self
            .filters
            .text
            .as_ref()
            .is_some_and(|value| value.trim().is_empty() || value.len() > 8 * 1_024)
        {
            return Err(invalid(
                "filters.text must be a non-empty string no larger than 8 KiB",
            ));
        }
        match self.name {
            RecipeName::SolutionRecall if self.filters.text.is_none() => {
                return Err(invalid("solution-recall@1 requires filters.text"));
            }
            RecipeName::SessionTimeline if self.filters.session_keys.len() != 1 => {
                return Err(invalid(
                    "session-timeline@1 requires exactly one session key",
                ));
            }
            RecipeName::ActivityShifts if self.filters.bucket.is_none() => {
                return Err(invalid("activity-shifts@1 requires filters.bucket"));
            }
            _ => {}
        }
        self.validate_recipe_filters()?;
        Ok(())
    }

    fn validate_recipe_filters(&self) -> Result<(), QueryError> {
        let reject = |present: bool, field: &str| {
            if present {
                Err(invalid(format!(
                    "{field} is not supported by the selected recipe"
                )))
            } else {
                Ok(())
            }
        };
        match self.name {
            RecipeName::CapabilityContexts => {
                reject(!self.filters.event_kinds.is_empty(), "filters.eventKinds")?;
                reject(self.filters.text.is_some(), "filters.text")?;
                reject(self.filters.bucket.is_some(), "filters.bucket")?;
            }
            RecipeName::FailureChains | RecipeName::SolutionRecall => {
                reject(
                    !self.filters.capability_keys.is_empty(),
                    "filters.capabilityKeys",
                )?;
                reject(self.filters.bucket.is_some(), "filters.bucket")?;
            }
            RecipeName::FileWorkflowSignals | RecipeName::TokenHotspots => {
                reject(
                    !self.filters.capability_keys.is_empty(),
                    "filters.capabilityKeys",
                )?;
                reject(!self.filters.event_kinds.is_empty(), "filters.eventKinds")?;
                reject(self.filters.text.is_some(), "filters.text")?;
                reject(self.filters.bucket.is_some(), "filters.bucket")?;
            }
            RecipeName::ActivityShifts => {
                reject(
                    !self.filters.capability_keys.is_empty(),
                    "filters.capabilityKeys",
                )?;
                reject(!self.filters.session_keys.is_empty(), "filters.sessionKeys")?;
                reject(!self.filters.event_kinds.is_empty(), "filters.eventKinds")?;
                reject(self.filters.text.is_some(), "filters.text")?;
            }
            RecipeName::SessionTimeline => {
                reject(
                    !self.filters.capability_keys.is_empty(),
                    "filters.capabilityKeys",
                )?;
                reject(self.filters.text.is_some(), "filters.text")?;
                reject(self.filters.bucket.is_some(), "filters.bucket")?;
            }
        }
        Ok(())
    }
}

impl RecipeWindow {
    fn bounds(&self, label: &str) -> Result<WindowBounds, QueryError> {
        let after_ms = parse_canonical_timestamp(&self.after, &format!("{label}.after"))?;
        let before_ms = parse_canonical_timestamp(&self.before, &format!("{label}.before"))?;
        if after_ms >= before_ms {
            return Err(invalid(format!(
                "{label} must be a non-empty half-open window"
            )));
        }
        Ok(WindowBounds {
            after_ms,
            before_ms,
        })
    }
}

fn segmented_windows(window: &RecipeWindow) -> Result<Vec<RecipeWindow>, QueryError> {
    let bounds = window.bounds("window")?;
    let mut after = bounds.after_ms;
    let mut result = Vec::new();
    while after < bounds.before_ms {
        let before = after
            .saturating_add(RECIPE_SCAN_SEGMENT_MS)
            .min(bounds.before_ms);
        result.push(RecipeWindow {
            after: crate::agent_query::canonical_timestamp(after)?,
            before: crate::agent_query::canonical_timestamp(before)?,
        });
        after = before;
    }
    Ok(result)
}

fn canonical_recipe_bytes(response: &RecipeResponse) -> Result<usize, QueryError> {
    let wire = serde_json::to_value(response)
        .map_err(|_| QueryError::new("QUERY_FAILED", "recipe response could not be encoded"))?;
    crate::try_canonical_json(&wire)
        .map(|encoded| encoded.len())
        .map_err(|_| QueryError::new("QUERY_FAILED", "recipe response is not canonical"))
}

fn detail_field(name: RecipeName) -> Option<&'static str> {
    match name {
        RecipeName::FailureChains => Some("attempts"),
        RecipeName::FileWorkflowSignals => Some("events"),
        _ => None,
    }
}

fn truncate_recipe_details(
    items: &mut [Value],
    name: RecipeName,
    mut byte_budget: usize,
) -> Result<bool, QueryError> {
    let Some(field) = detail_field(name) else {
        return Ok(false);
    };
    let mut details = Vec::with_capacity(items.len());
    for item in items.iter_mut() {
        let values = item
            .get_mut(field)
            .and_then(Value::as_array_mut)
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "recipe detail array is missing"))?;
        details.push(std::mem::take(values));
    }
    let total_detail_count = details.iter().map(Vec::len).sum::<usize>();
    let mut included = 0_usize;
    let mut exhausted = false;
    for (item, values) in items.iter_mut().zip(details) {
        let target = item[field]
            .as_array_mut()
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "recipe detail array is invalid"))?;
        if exhausted {
            continue;
        }
        for value in values {
            let bytes = crate::try_canonical_json(&value)
                .map_err(|_| QueryError::new("QUERY_FAILED", "recipe detail is not canonical"))?
                .len();
            let cost = bytes.saturating_add(usize::from(!target.is_empty()));
            if cost > byte_budget {
                exhausted = true;
                break;
            }
            byte_budget -= cost;
            target.push(value);
            included += 1;
        }
    }
    Ok(included < total_detail_count)
}

fn fit_degraded_recipe_response(
    response: &mut RecipeResponse,
    allow_degraded: bool,
) -> Result<(), QueryError> {
    if canonical_recipe_bytes(response)? <= MAX_RECIPE_PAGE_BYTES {
        return Ok(());
    }
    if !allow_degraded || detail_field(response.name).is_none() {
        return Err(QueryError::new(
            "TS_QUERY_TOO_BROAD",
            "recipe response exceeds the bounded response budget",
        ));
    }
    response.coverage.degraded = true;
    if !response
        .coverage
        .diagnostics
        .iter()
        .any(|code| code == "TS_INSIGHTS_RECIPE_PARTIAL_COVERAGE")
    {
        response
            .coverage
            .diagnostics
            .push("TS_INSIGHTS_RECIPE_PARTIAL_COVERAGE".to_owned());
    }
    let saved_items = response.items.clone();
    let removed = truncate_recipe_details(&mut response.items, response.name, 0)?;
    if !removed {
        return Err(QueryError::new(
            "TS_QUERY_TOO_BROAD",
            "recipe response exceeds the bounded response budget",
        ));
    }
    let base_bytes = canonical_recipe_bytes(response)?;
    if base_bytes > MAX_RECIPE_PAGE_BYTES {
        return Err(QueryError::new(
            "TS_QUERY_TOO_BROAD",
            "recipe response metadata exceeds the bounded response budget",
        ));
    }
    response.items = saved_items;
    truncate_recipe_details(
        &mut response.items,
        response.name,
        MAX_RECIPE_PAGE_BYTES - base_bytes,
    )?;
    if canonical_recipe_bytes(response)? > MAX_RECIPE_PAGE_BYTES {
        return Err(QueryError::new(
            "QUERY_FAILED",
            "recipe response budget calculation is inconsistent",
        ));
    }
    Ok(())
}

pub fn read_recipe(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<RecipeResponse, QueryError> {
    request.validate()?;
    require_fact_v2(connection)?;
    let transaction = connection.unchecked_transaction().map_err(query_failed)?;
    let (database_uuid, snapshot_seq) = read_identity(&transaction)?;
    let mut coverage = read_recipe_coverage(&transaction, request)?;
    if coverage.degraded && !request.allow_degraded {
        return Err(QueryError::new(
            "TS_INSIGHTS_COVERAGE_INCOMPLETE",
            "recipe coverage is incomplete; retry with allowDegraded only when partial results are acceptable",
        ));
    }
    let (mut items, detail_limited, exact_total) = match request.name {
        RecipeName::CapabilityContexts => {
            let items = capability_contexts(&transaction, request)?;
            let total = items.len();
            (items, false, total)
        }
        RecipeName::FailureChains => failure_chains(&transaction, request)?,
        RecipeName::FileWorkflowSignals => {
            let (items, limited) = file_workflow_signals(&transaction, request)?;
            let total = items.len();
            (items, limited, total)
        }
        RecipeName::ActivityShifts => {
            let items = activity_shifts(&transaction, request)?;
            let total = items.len();
            (items, false, total)
        }
        RecipeName::TokenHotspots => {
            let items = token_hotspots(&transaction, request)?;
            let total = items.len();
            (items, false, total)
        }
        RecipeName::SolutionRecall => {
            let items = solution_recall(&transaction, request)?;
            let total = items.len();
            (items, false, total)
        }
        RecipeName::SessionTimeline => {
            let items = session_timeline(&transaction, request)?;
            let total = items.len();
            (items, false, total)
        }
    };
    if detail_limited {
        coverage.degraded = true;
        if !coverage
            .diagnostics
            .iter()
            .any(|code| code == "TS_INSIGHTS_RECIPE_PARTIAL_COVERAGE")
        {
            coverage
                .diagnostics
                .push("TS_INSIGHTS_RECIPE_PARTIAL_COVERAGE".to_owned());
        }
    }
    if items.len() > MAX_RECIPE_ITEMS {
        return Err(QueryError::new(
            "TS_QUERY_TOO_BROAD",
            "recipe produced too many exact result groups",
        ));
    }
    let total_item_count = exact_total;
    let truncated = total_item_count > usize::from(request.limit);
    items.truncate(usize::from(request.limit));
    let provenance = recipe_provenance(request.name);
    let mut response = RecipeResponse {
        format: RECIPE_RESPONSE_FORMAT.to_owned(),
        database_uuid,
        snapshot_seq,
        name: request.name,
        window: request.window.clone(),
        comparison_window: request.comparison_window.clone(),
        evaluated_at: request.evaluated_at.clone(),
        items,
        total_item_count: total_item_count.to_string(),
        truncated,
        coverage,
        provenance,
    };
    response.validate()?;
    fit_degraded_recipe_response(&mut response, request.allow_degraded)?;
    response.validate()?;
    transaction.commit().map_err(query_failed)?;
    Ok(response)
}

fn capability_contexts(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<Vec<Value>, QueryError> {
    if complete_day_window(&request.window)?.is_some() {
        return projected_capability_contexts(connection, request);
    }
    let (scope, values) = capability_scope(request)?;
    let sql = format!(
        "SELECT lower(hex(c.capability_key)),c.provider,c.capability_kind,c.canonical_name,
                COUNT(*),SUM(CASE WHEN cu.provider_terminal_state='failed' THEN 1 ELSE 0 END),
                COUNT(DISTINCT cu.turn_id),COUNT(DISTINCT cu.session_id),
                COUNT(DISTINCT s.duplicate_group_key),
                SUM(CASE WHEN s.duplicate_group_key IS NULL THEN 0 ELSE 1 END),
                SUM(CASE WHEN s.duplicate_group_key IS NULL THEN 1 ELSE 0 END),
                MAX(COALESCE(invocation_event.observed_timestamp,t.observed_timestamp)),
                SUM(CASE WHEN s.duplicate_confidence='strong' THEN 1 ELSE 0 END),
                SUM(CASE WHEN s.duplicate_confidence='weak' THEN 1 ELSE 0 END),
                SUM(CASE WHEN cu.provider_terminal_state='pending' THEN 1 ELSE 0 END),
                SUM(CASE WHEN cu.provider_terminal_state='completed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN cu.provider_terminal_state='cancelled' THEN 1 ELSE 0 END),
                SUM(CASE WHEN cu.provider_terminal_state NOT IN
                     ('pending','completed','failed','cancelled') THEN 1 ELSE 0 END)
         FROM capability_uses cu
         JOIN turns t ON t.turn_id=cu.turn_id
         JOIN sessions s ON s.session_id=cu.session_id
         JOIN capabilities c ON c.capability_id=cu.capability_id
         LEFT JOIN evidence_events invocation_event ON invocation_event.event_id=(
           SELECT linked_event.event_id FROM capability_use_evidence invocation_link
           JOIN evidence_events linked_event ON linked_event.event_id=invocation_link.event_id
           WHERE invocation_link.use_id=cu.use_id AND invocation_link.role='invocation'
           ORDER BY linked_event.record_start_offset,linked_event.content_index,
                    linked_event.event_ordinal,linked_event.event_key LIMIT 1
         )
         WHERE {scope}
         GROUP BY c.capability_id
         ORDER BY COUNT(DISTINCT s.duplicate_group_key) DESC,COUNT(*) DESC,c.capability_key ASC"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let rows = statement
        .query_map(params_from_iter(values), |row| {
            Ok(json!({
                "capability": {
                    "capabilityKey": row.get::<_, String>(0)?,
                    "provider": row.get::<_, String>(1)?,
                    "kind": row.get::<_, String>(2)?,
                    "canonicalName": row.get::<_, String>(3)?,
                },
                "recordedInvocationCount": nonnegative_json(row.get(4)?)?,
                "recordedFailingInvocationCount": nonnegative_json(row.get(5)?)?,
                "distinctTurnCount": nonnegative_json(row.get(6)?)?,
                "distinctSessionCount": nonnegative_json(row.get(7)?)?,
                "distinctDedupeGroupCount": nonnegative_json(row.get(8)?)?,
                "groupedInvocationCount": nonnegative_json(row.get(9)?)?,
                "ungroupedInvocationCount": nonnegative_json(row.get(10)?)?,
                "lastUsedAt": row.get::<_, Option<String>>(11)?,
                "strongGroupMemberInvocationCount": nonnegative_json(row.get(12)?)?,
                "weakGroupMemberInvocationCount": nonnegative_json(row.get(13)?)?,
                "invocationTerminalCounts": {
                    "pending": nonnegative_json(row.get(14)?)?,
                    "completed": nonnegative_json(row.get(15)?)?,
                    "failed": nonnegative_json(row.get(5)?)?,
                    "cancelled": nonnegative_json(row.get(16)?)?,
                    "unknown": nonnegative_json(row.get(17)?)?,
                },
            }))
        })
        .map_err(query_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(query_failed)?;
    let mut representatives = capability_representatives(connection, request)?;
    let mut top_projects = capability_top_projects(connection, request)?;
    let mut co_occurring = capability_co_occurrences(connection, request)?;
    let mut result = Vec::with_capacity(rows.len());
    for mut item in rows {
        let capability_key = item["capability"]["capabilityKey"]
            .as_str()
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "capability key is missing"))?
            .to_owned();
        let representative_turns = representatives.remove(&capability_key).unwrap_or_default();
        item["topProjects"] =
            Value::Array(top_projects.remove(&capability_key).unwrap_or_default());
        item["coOccurringCapabilities"] =
            Value::Array(co_occurring.remove(&capability_key).unwrap_or_default());
        item["representativeTurns"] = Value::Array(representative_turns.clone());
        item["evidence"] = representative_turns
            .first()
            .and_then(|value| value.get("evidence"))
            .cloned()
            .unwrap_or(Value::Null);
        result.push(item);
    }
    Ok(result)
}

#[derive(Default)]
struct CapabilityContextRollup {
    provider: String,
    kind: String,
    canonical_name: String,
    invocations: u64,
    failures: u64,
    sessions: BTreeSet<i64>,
    groups: BTreeSet<String>,
    grouped_invocations: u64,
    ungrouped_invocations: u64,
    last_used_at: Option<String>,
    strong_invocations: u64,
    weak_invocations: u64,
    terminal: [u64; 5],
    projects: BTreeMap<Option<String>, u64>,
}

fn projected_capability_contexts(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<Vec<Value>, QueryError> {
    let (scope, values) = projected_capability_scope(request, "rollup")?;
    let sql = format!(
        "SELECT lower(hex(c.capability_key)),c.provider,c.capability_kind,c.canonical_name,
                rollup.session_id,
                CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                lower(hex(s.duplicate_group_key)),s.duplicate_confidence,
                rollup.invocation_count,rollup.failing_invocation_count,
                rollup.last_used_at,
                rollup.pending_count,rollup.completed_count,rollup.cancelled_count,
                rollup.unknown_count
         FROM history_capability_rollups rollup
         JOIN sessions s ON s.session_id=rollup.session_id
         JOIN capabilities c ON c.capability_id=rollup.capability_id
         WHERE {scope}
         ORDER BY c.capability_key,rollup.session_id,rollup.bucket_day"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(query_failed)?;
    let mut groups = BTreeMap::<String, CapabilityContextRollup>::new();
    while let Some(row) = rows.next().map_err(query_failed)? {
        let capability_key: String = row.get(0).map_err(query_failed)?;
        let group = groups.entry(capability_key).or_default();
        if group.provider.is_empty() {
            group.provider = row.get(1).map_err(query_failed)?;
            group.kind = row.get(2).map_err(query_failed)?;
            group.canonical_name = row.get(3).map_err(query_failed)?;
        }
        group.sessions.insert(row.get(4).map_err(query_failed)?);
        let project_key: Option<String> = row.get(5).map_err(query_failed)?;
        let duplicate_group: Option<String> = row.get(6).map_err(query_failed)?;
        let confidence: Option<String> = row.get(7).map_err(query_failed)?;
        let invocations = query_nonnegative_u64(row.get(8).map_err(query_failed)?)?;
        group.invocations = checked_recipe_add(group.invocations, invocations, "invocations")?;
        group.failures = checked_recipe_add(
            group.failures,
            query_nonnegative_u64(row.get(9).map_err(query_failed)?)?,
            "failures",
        )?;
        let last_used: String = row.get(10).map_err(query_failed)?;
        if group
            .last_used_at
            .as_ref()
            .is_none_or(|current| last_used > *current)
        {
            group.last_used_at = Some(last_used);
        }
        if let Some(duplicate_group) = duplicate_group.filter(|value| !value.is_empty()) {
            group.groups.insert(duplicate_group);
            group.grouped_invocations = checked_recipe_add(
                group.grouped_invocations,
                invocations,
                "grouped invocations",
            )?;
            if confidence.as_deref() == Some("strong") {
                group.strong_invocations = checked_recipe_add(
                    group.strong_invocations,
                    invocations,
                    "strong invocations",
                )?;
            } else if confidence.as_deref() == Some("weak") {
                group.weak_invocations =
                    checked_recipe_add(group.weak_invocations, invocations, "weak invocations")?;
            }
        } else {
            group.ungrouped_invocations = checked_recipe_add(
                group.ungrouped_invocations,
                invocations,
                "ungrouped invocations",
            )?;
        }
        let project_count = group.projects.entry(project_key).or_default();
        *project_count = checked_recipe_add(*project_count, invocations, "project invocations")?;
        for (index, column) in [11, 12, 9, 13, 14].into_iter().enumerate() {
            group.terminal[index] = checked_recipe_add(
                group.terminal[index],
                query_nonnegative_u64(row.get(column).map_err(query_failed)?)?,
                "terminal count",
            )?;
        }
    }
    drop(rows);
    drop(statement);
    let mut result = groups
        .into_iter()
        .map(|(capability_key, group)| {
            let mut projects = group.projects.into_iter().collect::<Vec<_>>();
            projects.sort_by(|left, right| {
                right
                    .1
                    .cmp(&left.1)
                    .then_with(|| left.0.is_none().cmp(&right.0.is_none()))
                    .then_with(|| left.0.cmp(&right.0))
            });
            Ok(json!({
                "capability": {
                    "capabilityKey":capability_key.clone(),"provider":group.provider,
                    "kind":group.kind,"canonicalName":group.canonical_name,
                },
                "recordedInvocationCount":group.invocations.to_string(),
                "recordedFailingInvocationCount":group.failures.to_string(),
                "distinctTurnCount":"0",
                "distinctSessionCount":group.sessions.len().to_string(),
                "distinctDedupeGroupCount":group.groups.len().to_string(),
                "groupedInvocationCount":group.grouped_invocations.to_string(),
                "ungroupedInvocationCount":group.ungrouped_invocations.to_string(),
                "lastUsedAt":group.last_used_at,
                "strongGroupMemberInvocationCount":group.strong_invocations.to_string(),
                "weakGroupMemberInvocationCount":group.weak_invocations.to_string(),
                "invocationTerminalCounts": {
                    "pending":group.terminal[0].to_string(),
                    "completed":group.terminal[1].to_string(),
                    "failed":group.terminal[2].to_string(),
                    "cancelled":group.terminal[3].to_string(),
                    "unknown":group.terminal[4].to_string(),
                },
                "topProjects":projects.into_iter().take(5).map(|(project_key,count)| json!({
                    "projectKey":project_key,"recordedInvocationCount":count.to_string(),
                })).collect::<Vec<_>>(),
                "coOccurringCapabilities":[],
                "representativeTurns":[],
                "evidence":Value::Null,
            }))
        })
        .collect::<Result<Vec<_>, QueryError>>()?;
    result.sort_by(|left, right| {
        decimal_json(right.pointer("/distinctDedupeGroupCount"))
            .cmp(&decimal_json(left.pointer("/distinctDedupeGroupCount")))
            .then_with(|| {
                decimal_json(right.pointer("/recordedInvocationCount"))
                    .cmp(&decimal_json(left.pointer("/recordedInvocationCount")))
            })
            .then_with(|| {
                left["capability"]["capabilityKey"]
                    .as_str()
                    .cmp(&right["capability"]["capabilityKey"].as_str())
            })
    });
    let mut detail_request = request.clone();
    detail_request.filters.capability_keys = result
        .iter()
        .take(usize::from(request.limit))
        .filter_map(|item| item.pointer("/capability/capabilityKey")?.as_str())
        .map(str::to_owned)
        .collect();
    if !detail_request.filters.capability_keys.is_empty() {
        let representatives = projected_capability_representatives(connection, &detail_request)?;
        let mut co_occurring = projected_capability_cooccurrences(connection, &detail_request)?;
        for item in result.iter_mut().take(usize::from(request.limit)) {
            let capability_key = item["capability"]["capabilityKey"]
                .as_str()
                .ok_or_else(|| QueryError::new("QUERY_FAILED", "capability key is missing"))?
                .to_owned();
            let representative_turns = representatives
                .items
                .get(&capability_key)
                .cloned()
                .unwrap_or_default();
            item["distinctTurnCount"] = Value::String(
                representatives
                    .distinct_turn_counts
                    .get(&capability_key)
                    .copied()
                    .unwrap_or(0)
                    .to_string(),
            );
            item["coOccurringCapabilities"] =
                Value::Array(co_occurring.remove(&capability_key).unwrap_or_default());
            item["representativeTurns"] = Value::Array(representative_turns.clone());
            item["evidence"] = representative_turns
                .first()
                .and_then(|value| value.get("evidence"))
                .cloned()
                .unwrap_or(Value::Null);
        }
    }
    Ok(result)
}

fn checked_recipe_add(left: u64, right: u64, label: &str) -> Result<u64, QueryError> {
    left.checked_add(right)
        .ok_or_else(|| QueryError::new("QUERY_FAILED", format!("{label} overflowed")))
}

#[derive(Default)]
struct ProjectedCapabilityRepresentatives {
    items: BTreeMap<String, Vec<Value>>,
    distinct_turn_counts: BTreeMap<String, u64>,
}

fn projected_capability_representatives(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<ProjectedCapabilityRepresentatives, QueryError> {
    let (sql, values) = projected_capability_representatives_statement(request)?;
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(query_failed)?;
    let mut result = ProjectedCapabilityRepresentatives::default();
    while let Some(row) = rows.next().map_err(query_failed)? {
        let capability_key: String = row.get(0).map_err(query_failed)?;
        result.distinct_turn_counts.insert(
            capability_key.clone(),
            query_nonnegative_u64(row.get(1).map_err(query_failed)?)?,
        );
        if row
            .get::<_, Option<i64>>(2)
            .map_err(query_failed)?
            .is_none()
        {
            continue;
        }
        let turn_key: String = row.get(3).map_err(query_failed)?;
        let revision: String = row.get(4).map_err(query_failed)?;
        result.items.entry(capability_key).or_default().push(json!({
            "turnKey":turn_key,
            "usedAt":row.get::<_, String>(8).map_err(query_failed)?,
            "recordedInvocationCount":query_nonnegative_u64(
                row.get(7).map_err(query_failed)?
            )?.to_string(),
            "context":{
                "problem":row.get::<_, String>(5).map_err(query_failed)?,
                "finalAnswer":row.get::<_, Option<String>>(6).map_err(query_failed)?,
            },
            "evidence":{"kind":"turn","turnKey":turn_key,"revision":revision},
        }));
    }
    Ok(result)
}

fn projected_capability_representatives_statement(
    request: &RecipeRequest,
) -> Result<(String, Vec<SqlValue>), QueryError> {
    let (scope, values) = projected_capability_scope(request, "representative")?;
    let sql = format!(
        "WITH grouped AS MATERIALIZED (
           SELECT representative.capability_id,representative.turn_id,
                  SUM(representative.invocation_count) AS invocation_count,
                  MAX(representative.used_at) AS used_at
           FROM history_capability_representatives representative
           JOIN sessions s ON s.session_id=representative.session_id
           JOIN capabilities c ON c.capability_id=representative.capability_id
           WHERE {scope}
           GROUP BY representative.capability_id,representative.turn_id
         ), counts AS MATERIALIZED (
           SELECT capability_id,COUNT(*) AS distinct_turn_count
           FROM grouped GROUP BY capability_id
         ), ranked AS MATERIALIZED (
           SELECT grouped.capability_id,grouped.turn_id,grouped.invocation_count,
                  grouped.used_at,
                  ROW_NUMBER() OVER (
                    PARTITION BY grouped.capability_id
                    ORDER BY grouped.invocation_count DESC,grouped.used_at DESC,t.turn_key ASC
                  ) AS representative_rank
           FROM grouped JOIN turns t ON t.turn_id=grouped.turn_id
           WHERE t.revision IS NOT NULL
         )
         SELECT lower(hex(c.capability_key)),counts.distinct_turn_count,
                ranked.turn_id,lower(hex(t.turn_key)),lower(hex(t.revision)),
                t.problem_text,t.final_answer_excerpt,
                ranked.invocation_count,ranked.used_at
         FROM counts JOIN capabilities c ON c.capability_id=counts.capability_id
         LEFT JOIN ranked ON ranked.capability_id=counts.capability_id
          AND ranked.representative_rank<=5
         LEFT JOIN turns t ON t.turn_id=ranked.turn_id
         ORDER BY c.capability_key,ranked.representative_rank"
    );
    Ok((sql, values))
}

fn projected_capability_cooccurrences(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<BTreeMap<String, Vec<Value>>, QueryError> {
    let (sql, values) = projected_capability_cooccurrences_statement(request)?;
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(query_failed)?;
    let mut result = BTreeMap::<String, Vec<Value>>::new();
    while let Some(row) = rows.next().map_err(query_failed)? {
        let capability_key: String = row.get(0).map_err(query_failed)?;
        result.entry(capability_key).or_default().push(json!({
            "capabilityKey":row.get::<_, String>(1).map_err(query_failed)?,
            "kind":row.get::<_, String>(2).map_err(query_failed)?,
            "canonicalName":row.get::<_, String>(3).map_err(query_failed)?,
            "distinctTurnCount":query_nonnegative_u64(
                row.get(4).map_err(query_failed)?
            )?.to_string(),
        }));
    }
    Ok(result)
}

fn projected_capability_cooccurrences_statement(
    request: &RecipeRequest,
) -> Result<(String, Vec<SqlValue>), QueryError> {
    let (scope, values) = projected_capability_scope(request, "cooccurrence")?;
    let sql = format!(
        "WITH grouped AS MATERIALIZED (
           SELECT cooccurrence.capability_id,cooccurrence.other_capability_id,
                  COUNT(DISTINCT cooccurrence.turn_id) AS distinct_turn_count
           FROM history_capability_cooccurrences cooccurrence
           JOIN sessions s ON s.session_id=cooccurrence.session_id
           JOIN capabilities c ON c.capability_id=cooccurrence.capability_id
           WHERE {scope}
           GROUP BY cooccurrence.capability_id,cooccurrence.other_capability_id
         ), ranked AS MATERIALIZED (
           SELECT grouped.capability_id,grouped.other_capability_id,
                  grouped.distinct_turn_count,
                  ROW_NUMBER() OVER (
                    PARTITION BY grouped.capability_id
                    ORDER BY grouped.distinct_turn_count DESC,other.capability_key ASC
                  ) AS cooccurrence_rank
           FROM grouped JOIN capabilities other
             ON other.capability_id=grouped.other_capability_id
         )
         SELECT lower(hex(c.capability_key)),lower(hex(other.capability_key)),
                other.capability_kind,other.canonical_name,ranked.distinct_turn_count
         FROM ranked JOIN capabilities c ON c.capability_id=ranked.capability_id
         JOIN capabilities other ON other.capability_id=ranked.other_capability_id
         WHERE ranked.cooccurrence_rank<=5
         ORDER BY c.capability_key,ranked.cooccurrence_rank"
    );
    Ok((sql, values))
}

fn capability_representatives(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<BTreeMap<String, Vec<Value>>, QueryError> {
    let (scope, values) = capability_scope(request)?;
    let sql = format!(
        "SELECT lower(hex(c.capability_key)),lower(hex(t.turn_key)),
                lower(hex(t.revision)),t.problem_text,
                t.final_answer_excerpt,
                MAX(COALESCE(invocation_event.observed_timestamp,t.observed_timestamp)) AS used_at,
                COUNT(*)
         FROM capability_uses cu
         JOIN turns t ON t.turn_id=cu.turn_id
         JOIN sessions s ON s.session_id=cu.session_id
         JOIN capabilities c ON c.capability_id=cu.capability_id
         LEFT JOIN evidence_events invocation_event ON invocation_event.event_id=(
           SELECT linked_event.event_id FROM capability_use_evidence invocation_link
           JOIN evidence_events linked_event ON linked_event.event_id=invocation_link.event_id
           WHERE invocation_link.use_id=cu.use_id AND invocation_link.role='invocation'
           ORDER BY linked_event.record_start_offset,linked_event.content_index,
                    linked_event.event_ordinal,linked_event.event_key LIMIT 1
         )
         WHERE {scope} AND t.revision IS NOT NULL
         GROUP BY c.capability_id,t.turn_id
         ORDER BY c.capability_key,COUNT(*) DESC,used_at IS NULL,used_at DESC,t.turn_key ASC"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(query_failed)?;
    let mut result = BTreeMap::<String, Vec<Value>>::new();
    while let Some(row) = rows.next().map_err(query_failed)? {
        let capability_key: String = row.get(0).map_err(query_failed)?;
        let entries = result.entry(capability_key).or_default();
        if entries.len() >= 5 {
            continue;
        }
        let turn_key: String = row.get(1).map_err(query_failed)?;
        let revision: String = row.get(2).map_err(query_failed)?;
        entries.push(json!({
            "turnKey": turn_key,
            "usedAt": row.get::<_, Option<String>>(5).map_err(query_failed)?,
            "recordedInvocationCount": nonnegative_json(
                row.get::<_, i64>(6).map_err(query_failed)?
            ).map_err(query_failed)?,
            "context": {
                "problem": row.get::<_, String>(3).map_err(query_failed)?,
                "finalAnswer": row.get::<_, Option<String>>(4).map_err(query_failed)?,
            },
            "evidence": {"kind":"turn","turnKey":turn_key,"revision":revision},
        }));
    }
    Ok(result)
}

fn capability_top_projects(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<BTreeMap<String, Vec<Value>>, QueryError> {
    let (scope, values) = capability_scope(request)?;
    let sql = format!(
        "SELECT lower(hex(c.capability_key)),
                CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                COUNT(*)
         FROM capability_uses cu
         JOIN turns t ON t.turn_id=cu.turn_id
         JOIN sessions s ON s.session_id=cu.session_id
         JOIN capabilities c ON c.capability_id=cu.capability_id
         LEFT JOIN evidence_events invocation_event ON invocation_event.event_id=(
           SELECT linked_event.event_id FROM capability_use_evidence invocation_link
           JOIN evidence_events linked_event ON linked_event.event_id=invocation_link.event_id
           WHERE invocation_link.use_id=cu.use_id AND invocation_link.role='invocation'
           ORDER BY linked_event.record_start_offset,linked_event.content_index,
                    linked_event.event_ordinal,linked_event.event_key LIMIT 1
         )
         WHERE {scope}
         GROUP BY c.capability_id,s.project_key
         ORDER BY c.capability_key,COUNT(*) DESC,s.project_key IS NULL,s.project_key ASC"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(query_failed)?;
    let mut result = BTreeMap::<String, Vec<Value>>::new();
    while let Some(row) = rows.next().map_err(query_failed)? {
        let capability_key: String = row.get(0).map_err(query_failed)?;
        let entries = result.entry(capability_key).or_default();
        if entries.len() < 5 {
            entries.push(json!({
                "projectKey": row.get::<_, Option<String>>(1).map_err(query_failed)?,
                "recordedInvocationCount": nonnegative_json(
                    row.get::<_, i64>(2).map_err(query_failed)?
                ).map_err(query_failed)?,
            }));
        }
    }
    Ok(result)
}

fn capability_co_occurrences(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<BTreeMap<String, Vec<Value>>, QueryError> {
    let (scope, values) = capability_scope(request)?;
    let sql = format!(
        "SELECT lower(hex(c.capability_key)),lower(hex(other_capability.capability_key)),
                other_capability.capability_kind,other_capability.canonical_name,
                COUNT(DISTINCT cu.turn_id)
         FROM capability_uses cu
         JOIN turns t ON t.turn_id=cu.turn_id
         JOIN sessions s ON s.session_id=cu.session_id
         JOIN capabilities c ON c.capability_id=cu.capability_id
         LEFT JOIN evidence_events invocation_event ON invocation_event.event_id=(
           SELECT linked_event.event_id FROM capability_use_evidence invocation_link
           JOIN evidence_events linked_event ON linked_event.event_id=invocation_link.event_id
           WHERE invocation_link.use_id=cu.use_id AND invocation_link.role='invocation'
           ORDER BY linked_event.record_start_offset,linked_event.content_index,
                    linked_event.event_ordinal,linked_event.event_key LIMIT 1
         )
         JOIN capability_uses other_use ON other_use.turn_id=cu.turn_id
          AND other_use.origin_scope='main' AND other_use.capability_id<>cu.capability_id
         JOIN capabilities other_capability ON other_capability.capability_id=other_use.capability_id
         WHERE {scope}
         GROUP BY c.capability_id,other_capability.capability_id
         ORDER BY c.capability_key,COUNT(DISTINCT cu.turn_id) DESC,
                  other_capability.capability_key ASC"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(query_failed)?;
    let mut result = BTreeMap::<String, Vec<Value>>::new();
    while let Some(row) = rows.next().map_err(query_failed)? {
        let capability_key: String = row.get(0).map_err(query_failed)?;
        let entries = result.entry(capability_key).or_default();
        if entries.len() < 5 {
            entries.push(json!({
                "capabilityKey": row.get::<_, String>(1).map_err(query_failed)?,
                "kind": row.get::<_, String>(2).map_err(query_failed)?,
                "canonicalName": row.get::<_, String>(3).map_err(query_failed)?,
                "distinctTurnCount": nonnegative_json(
                    row.get::<_, i64>(4).map_err(query_failed)?
                ).map_err(query_failed)?,
            }));
        }
    }
    Ok(result)
}

struct ChainAttempt {
    event_key: String,
    revision: String,
    event_kind: String,
    observed_at: Option<String>,
    capability_key: Option<String>,
    capability_name: Option<String>,
    input_fingerprint: Option<String>,
    provider_state: Option<String>,
    exit_code: Option<String>,
}

#[derive(Default)]
struct ChainSummary {
    capability_key: Option<String>,
    first_at: Option<String>,
    last_at: Option<String>,
    event_count: u64,
    failed: u64,
    completed: u64,
    first_failure: Option<ChainEventOrder>,
    last_completion: Option<ChainEventOrder>,
    incomplete: bool,
}

#[derive(Clone, PartialEq, Eq, PartialOrd, Ord)]
struct ChainEventOrder {
    record_start_offset: Vec<u8>,
    content_index: i64,
    event_ordinal: i64,
    event_key: Vec<u8>,
}

fn failure_chains(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<(Vec<Value>, bool, usize), QueryError> {
    let mut chains = BTreeMap::<String, ChainSummary>::new();
    for window in segmented_windows(&request.window)? {
        let mut segment = request.clone();
        segment.window = window;
        let (sql, values) = failure_chain_summary_statement(&segment)?;
        let mut statement = connection.prepare(&sql).map_err(query_failed)?;
        let mut rows = statement
            .query(params_from_iter(values))
            .map_err(query_failed)?;
        while let Some(row) = rows.next().map_err(query_failed)? {
            let chain_key: String = row.get(0).map_err(query_failed)?;
            let provider_state = row.get::<_, Option<String>>(1).map_err(query_failed)?;
            let capability_key = row.get::<_, Option<String>>(2).map_err(query_failed)?;
            let observed_at = row.get::<_, Option<String>>(3).map_err(query_failed)?;
            let completeness = row.get::<_, String>(4).map_err(query_failed)?;
            let missing_payload = row.get::<_, i64>(5).map_err(query_failed)? != 0;
            let order = ChainEventOrder {
                record_start_offset: row.get(6).map_err(query_failed)?,
                content_index: row.get(7).map_err(query_failed)?,
                event_ordinal: row.get(8).map_err(query_failed)?,
                event_key: row.get(9).map_err(query_failed)?,
            };
            let entry = chains.entry(chain_key).or_default();
            entry.event_count = entry
                .event_count
                .checked_add(1)
                .ok_or_else(|| QueryError::new("QUERY_FAILED", "attempt chain is too large"))?;
            if provider_state.as_deref() == Some("failed") {
                entry.failed += 1;
                if entry
                    .first_failure
                    .as_ref()
                    .is_none_or(|first| order < *first)
                {
                    entry.first_failure = Some(order.clone());
                }
            } else if provider_state.as_deref() == Some("completed") {
                entry.completed += 1;
                if entry
                    .last_completion
                    .as_ref()
                    .is_none_or(|last| order > *last)
                {
                    entry.last_completion = Some(order);
                }
            }
            entry.incomplete |= completeness != "full" || missing_payload;
            entry.capability_key = entry.capability_key.take().or(capability_key);
            entry.first_at = match (entry.first_at.take(), observed_at.clone()) {
                (Some(current), Some(observed)) => Some(current.min(observed)),
                (current, observed) => current.or(observed),
            };
            entry.last_at = match (entry.last_at.take(), observed_at) {
                (Some(current), Some(observed)) => Some(current.max(observed)),
                (current, observed) => current.or(observed),
            };
        }
    }
    let mut result = Vec::with_capacity(usize::from(request.limit));
    let mut total_item_count = 0_usize;
    for (chain_key, summary) in chains {
        if let Some(item) = chain_summary_value(chain_key, &summary) {
            total_item_count += 1;
            retain_ranked_chain(&mut result, item, usize::from(request.limit));
        }
    }
    let selected_chain_keys = result
        .iter()
        .map(|item| item["chainKey"].as_str().unwrap().to_owned())
        .collect::<Vec<_>>();
    let capability_names = capability_names_for_recipe_items(connection, &result)?;
    let (details, detail_limited) =
        failure_chain_details(connection, request, &selected_chain_keys)?;
    if detail_limited && !request.allow_degraded {
        return Err(QueryError::new(
            "TS_QUERY_TOO_BROAD",
            "failure chain detail exceeds the bounded recipe budget",
        ));
    }
    for item in &mut result {
        if let Some(capability_key) = item["capabilityKey"].as_str() {
            item["capabilityName"] = capability_names
                .get(capability_key)
                .cloned()
                .map(Value::String)
                .unwrap_or(Value::Null);
        }
        item.as_object_mut().unwrap().remove("capabilityKey");
        if let Some(chain_key) = item["chainKey"].as_str().map(str::to_owned) {
            item["attempts"] = Value::Array(details.get(&chain_key).cloned().unwrap_or_default());
            let revision = crate::deep_query::read_attempt_chain_revision(connection, &chain_key)?;
            item["revision"] = Value::String(revision.clone());
            item["evidence"]["revision"] = Value::String(revision);
        }
    }
    Ok((result, detail_limited, total_item_count))
}

fn failure_chain_summary_statement(
    request: &RecipeRequest,
) -> Result<(String, Vec<SqlValue>), QueryError> {
    let (scope, values) = event_scope(request, Some("ace.chain_key IS NOT NULL"))?;
    let source = if request.filters.session_keys.is_empty() {
        "history_events he INDEXED BY history_events_observed
         CROSS JOIN attempt_chain_events ace ON ace.event_key=he.event_key
         CROSS JOIN history_event_coverage hec ON hec.event_key=he.event_key
         CROSS JOIN sessions s ON s.session_id=he.session_id"
    } else {
        "sessions s
         JOIN attempt_chain_events ace INDEXED BY attempt_chain_events_correlation
           ON ace.session_id=s.session_id
         JOIN history_events he ON he.event_key=ace.event_key
         JOIN history_event_coverage hec ON hec.event_key=he.event_key"
    };
    Ok((
        format!(
            "SELECT lower(hex(ace.chain_key)),json_extract(he.metadata_json,'$.providerState'),
                    json_extract(he.metadata_json,'$.capabilityKey'),
                    he.observed_timestamp,he.completeness,
                    hec.missing_payload,he.record_start_offset,he.content_index,
                    he.event_ordinal,he.event_key
             FROM {source}
             WHERE {scope}"
        ),
        values,
    ))
}

fn chain_summary_value(chain_key: String, chain: &ChainSummary) -> Option<Value> {
    let status = if chain.incomplete {
        "unknown"
    } else if chain.failed > 0
        && chain
            .first_failure
            .as_ref()
            .zip(chain.last_completion.as_ref())
            .is_some_and(|(failure, completion)| completion > failure)
    {
        "resolved"
    } else if chain.failed > 0 {
        "never-succeeded"
    } else if chain.completed == 0 {
        "abandoned"
    } else {
        return None;
    };
    Some(json!({
        "chainKey": chain_key,
        "revision": "",
        "status": status,
        "capabilityKey": chain.capability_key,
        "capabilityName": null,
        "eventCount": chain.event_count.to_string(),
        "failedResultCount": chain.failed.to_string(),
        "completedResultCount": chain.completed.to_string(),
        "firstObservedAt": chain.first_at,
        "lastObservedAt": chain.last_at,
        "attempts": [],
        "evidence": {"kind":"attempt-chain","chainKey":chain_key,"revision":""},
    }))
}

fn capability_names_for_recipe_items(
    connection: &Connection,
    items: &[Value],
) -> Result<BTreeMap<String, String>, QueryError> {
    let keys = items
        .iter()
        .filter_map(|item| item["capabilityKey"].as_str())
        .collect::<BTreeSet<_>>();
    if keys.is_empty() {
        return Ok(BTreeMap::new());
    }
    let mut values = Vec::with_capacity(keys.len());
    for key in &keys {
        values.push(SqlValue::Blob(decode_key(key, "capabilityKey")?));
    }
    let sql = format!(
        "SELECT lower(hex(capability_key)),canonical_name FROM capabilities
         WHERE capability_key IN ({})",
        placeholders(values.len())
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    statement
        .query_map(params_from_iter(values), |row| {
            Ok((row.get(0)?, row.get(1)?))
        })
        .map_err(query_failed)?
        .collect::<Result<BTreeMap<_, _>, _>>()
        .map_err(query_failed)
}

fn retain_ranked_chain(result: &mut Vec<Value>, item: Value, limit: usize) {
    result.push(item);
    result.sort_by(|left, right| {
        decimal_json(right.get("failedResultCount"))
            .cmp(&decimal_json(left.get("failedResultCount")))
            .then_with(|| left["chainKey"].as_str().cmp(&right["chainKey"].as_str()))
    });
    result.truncate(limit);
}

fn failure_chain_details(
    connection: &Connection,
    request: &RecipeRequest,
    chain_keys: &[String],
) -> Result<(BTreeMap<String, Vec<Value>>, bool), QueryError> {
    let mut attempts = BTreeMap::<String, Vec<ChainAttempt>>::new();
    let mut event_revisions = BTreeMap::<String, String>::new();
    let mut detail_limited = false;
    for chain_key in chain_keys {
        if event_revisions.len() >= MAX_RECIPE_DETAIL_ITEMS {
            detail_limited = true;
            break;
        }
        let (scope, mut values) = event_scope(request, Some("ace.chain_key=?"))?;
        values.push(SqlValue::Blob(decode_key(chain_key, "attempt chainKey")?));
        let remaining = MAX_RECIPE_DETAIL_ITEMS - event_revisions.len();
        let sql = format!(
            "SELECT he.event_kind,he.metadata_json,lower(hex(he.event_key)),
                    lower(hex(he.revision)),he.observed_timestamp,c.canonical_name,he.completeness
             FROM attempt_chain_events ace
             JOIN history_events he ON he.event_key=ace.event_key
             JOIN sessions s ON s.session_id=he.session_id
             LEFT JOIN capabilities c
               ON lower(hex(c.capability_key))=json_extract(he.metadata_json,'$.capabilityKey')
             WHERE {scope}
             ORDER BY he.record_start_offset,he.content_index,he.event_ordinal,he.event_key
             LIMIT {}",
            remaining + 1
        );
        let mut statement = connection.prepare(&sql).map_err(query_failed)?;
        let mut rows = statement
            .query(params_from_iter(values))
            .map_err(query_failed)?;
        while let Some(row) = rows.next().map_err(query_failed)? {
            if event_revisions.len() >= MAX_RECIPE_DETAIL_ITEMS {
                detail_limited = true;
                break;
            }
            let metadata: Value = serde_json::from_str(
                &row.get::<_, String>(1).map_err(query_failed)?,
            )
            .map_err(|_| QueryError::new("QUERY_FAILED", "stored event metadata is invalid"))?;
            let event_key = row.get::<_, String>(2).map_err(query_failed)?;
            let revision = row.get::<_, String>(3).map_err(query_failed)?;
            event_revisions.insert(event_key.clone(), revision.clone());
            attempts
                .entry(chain_key.clone())
                .or_default()
                .push(ChainAttempt {
                    event_key,
                    revision,
                    event_kind: row.get(0).map_err(query_failed)?,
                    observed_at: row.get(4).map_err(query_failed)?,
                    capability_key: metadata
                        .get("capabilityKey")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    capability_name: row.get(5).map_err(query_failed)?,
                    input_fingerprint: metadata
                        .get("inputFingerprint")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    provider_state: metadata
                        .get("providerState")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                    exit_code: metadata
                        .get("exitCode")
                        .and_then(Value::as_str)
                        .map(str::to_owned),
                });
        }
    }
    let payloads = payload_references_for_events(connection, &event_revisions)?;
    let mut result = BTreeMap::new();
    for (chain_key, values) in attempts {
        let mut details = Vec::with_capacity(values.len());
        for attempt in values {
            let input = payload_for_kind(&payloads, &attempt.event_key, "tool-input");
            let output = payload_for_kind(&payloads, &attempt.event_key, "tool-output");
            let error =
                payload_for_kind(&payloads, &attempt.event_key, "error-content").or_else(|| {
                    (attempt.provider_state.as_deref() == Some("failed"))
                        .then(|| output.clone())
                        .flatten()
                });
            let evidence = input
                .as_ref()
                .or(error.as_ref())
                .or(output.as_ref())
                .and_then(|value| value.get("reference"))
                .filter(|value| !value.is_null())
                .cloned()
                .unwrap_or_else(|| {
                    json!({"kind":"event","eventKey":attempt.event_key,"revision":attempt.revision})
                });
            details.push(json!({
                "eventKey":attempt.event_key,"revision":attempt.revision,
                "eventKind":attempt.event_kind,"observedAt":attempt.observed_at,
                "capabilityKey":attempt.capability_key,"capabilityName":attempt.capability_name,
                "inputFingerprint":attempt.input_fingerprint,"providerState":attempt.provider_state,
                "exitCode":attempt.exit_code,"input":input,"output":output,"error":error,
                "evidence":evidence,
            }));
        }
        result.insert(chain_key, details);
    }
    Ok((result, detail_limited))
}

fn file_workflow_signals(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<(Vec<Value>, bool), QueryError> {
    #[derive(Default)]
    struct Summary {
        revision: String,
        provider: String,
        project_key: Option<String>,
        actions: [u64; 7],
        phases: [u64; 4],
        paths: BTreeSet<String>,
        document_events: u64,
        implementation_events: u64,
    }
    let mut summaries = BTreeMap::<String, Summary>::new();
    for window in segmented_windows(&request.window)? {
        let mut segment = request.clone();
        segment.window = window;
        let (sql, values) = file_workflow_summary_statement(&segment)?;
        let mut statement = connection.prepare(&sql).map_err(query_failed)?;
        let mut rows = statement
            .query(params_from_iter(values))
            .map_err(query_failed)?;
        while let Some(row) = rows.next().map_err(query_failed)? {
            let session_key = row.get::<_, String>(0).map_err(query_failed)?;
            let entry = summaries.entry(session_key).or_default();
            if entry.revision.is_empty() {
                entry.revision = row.get(1).map_err(query_failed)?;
                entry.provider = row.get(2).map_err(query_failed)?;
                entry.project_key = row.get(3).map_err(query_failed)?;
            }
            let action = row.get::<_, String>(4).map_err(query_failed)?;
            if let Some(index) = ["read", "edit", "write", "delete", "move", "search", "list"]
                .iter()
                .position(|candidate| *candidate == action)
            {
                entry.actions[index] += 1;
            }
            let phase = row.get::<_, String>(5).map_err(query_failed)?;
            let phase_index = ["attempted", "confirmed", "failed"]
                .iter()
                .position(|candidate| *candidate == phase)
                .unwrap_or(3);
            entry.phases[phase_index] += 1;
            let path = row.get::<_, String>(6).map_err(query_failed)?;
            let lower = path.to_ascii_lowercase();
            entry.document_events += u64::from(
                [".md", ".txt", ".rst"]
                    .iter()
                    .any(|suffix| lower.ends_with(suffix)),
            );
            entry.implementation_events += u64::from(
                [".rs", ".js", ".mjs", ".ts", ".py"]
                    .iter()
                    .any(|suffix| lower.ends_with(suffix)),
            );
            entry.paths.insert(path);
        }
    }
    let mut result = summaries
        .into_iter()
        .map(|(session_key, summary)| {
            let reads = summary.actions[0];
            let mutations = summary.actions[1..=4].iter().sum::<u64>();
            let research_heavy = reads >= 3 * mutations.max(1);
            let implementation_heavy = mutations >= 5 && reads.saturating_mul(10) <= mutations * 8;
            json!({
                "sessionKey": session_key,
                "provider": summary.provider,
                "projectKey": summary.project_key,
                "recordedCounts": {
                    "read": reads.to_string(),
                    "edit": summary.actions[1].to_string(),
                    "write": summary.actions[2].to_string(),
                    "delete": summary.actions[3].to_string(),
                    "move": summary.actions[4].to_string(),
                    "search": summary.actions[5].to_string(),
                    "list": summary.actions[6].to_string(),
                    "attempted": summary.phases[0].to_string(),
                    "confirmed": summary.phases[1].to_string(),
                    "failed": summary.phases[2].to_string(),
                    "unknown": summary.phases[3].to_string(),
                    "distinctPath": summary.paths.len().to_string(),
                    "documentLike": summary.document_events.to_string(),
                    "implementationLike": summary.implementation_events.to_string(),
                },
                "estimated": {
                    "researchHeavy": research_heavy,
                    "implementationHeavy": implementation_heavy,
                    "docVoid": research_heavy && summary.document_events == 0,
                    "specPrecisionGap": implementation_heavy && summary.document_events == 0,
                    "method": "file-workflow-signals@1",
                },
                "evidence": {"kind":"session","sessionKey":session_key,"revision":summary.revision},
            })
        })
        .collect::<Vec<_>>();
    result.sort_by(|left, right| {
        file_event_count(right)
            .cmp(&file_event_count(left))
            .then_with(|| {
                left["sessionKey"]
                    .as_str()
                    .cmp(&right["sessionKey"].as_str())
            })
    });
    let selected_session_keys = result
        .iter()
        .take(usize::from(request.limit))
        .filter_map(|item| item["sessionKey"].as_str().map(str::to_owned))
        .collect::<Vec<_>>();
    let (mut details, detail_limited) =
        file_workflow_details(connection, request, &selected_session_keys)?;
    for item in &mut result {
        let session_key = item["sessionKey"]
            .as_str()
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "file workflow session is missing"))?;
        item["events"] = Value::Array(details.remove(session_key).unwrap_or_default());
    }
    Ok((result, detail_limited))
}

fn file_workflow_summary_statement(
    request: &RecipeRequest,
) -> Result<(String, Vec<SqlValue>), QueryError> {
    let (scope, values) = file_scope(request)?;
    let source = if request.filters.session_keys.is_empty() {
        "file_activity fa INDEXED BY file_activity_observed
         CROSS JOIN history_events he ON he.event_key=fa.event_key
         CROSS JOIN sessions s ON s.session_id=he.session_id
         CROSS JOIN session_commits sc ON sc.session_id=s.session_id"
    } else {
        "sessions s
         JOIN history_events he INDEXED BY history_events_session_order
           ON he.session_id=s.session_id
         JOIN file_activity fa ON fa.event_key=he.event_key
         JOIN session_commits sc ON sc.session_id=s.session_id"
    };
    Ok((
        format!(
            "SELECT lower(hex(s.session_key)),lower(hex(sc.canonical_digest)),s.provider,
                    CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                    fa.action,fa.phase,fa.normalized_path
             FROM {source}
             WHERE {scope}
             ORDER BY fa.observed_timestamp,fa.event_key,fa.activity_ordinal"
        ),
        values,
    ))
}

fn file_event_count(item: &Value) -> u128 {
    ["read", "edit", "write", "delete", "move", "search", "list"]
        .iter()
        .map(|key| {
            decimal_json(
                item.get("recordedCounts")
                    .and_then(|counts| counts.get(key)),
            )
        })
        .sum()
}

fn file_workflow_details(
    connection: &Connection,
    request: &RecipeRequest,
    session_keys: &[String],
) -> Result<(BTreeMap<String, Vec<Value>>, bool), QueryError> {
    struct FileDetail {
        session_key: String,
        event_key: String,
        revision: String,
        observed_at: Option<String>,
        event_kind: String,
        ordinal: u64,
        action: String,
        phase: String,
        path_role: String,
        raw_path: String,
        normalized_path: String,
        relative_path: Option<String>,
        absolute: bool,
        project_relative: bool,
    }
    if session_keys.is_empty() {
        return Ok((BTreeMap::new(), false));
    }
    let (mut scope, mut values) = file_scope(request)?;
    scope.push_str(&format!(
        " AND s.session_key IN ({})",
        placeholders(session_keys.len())
    ));
    for session_key in session_keys {
        values.push(SqlValue::Blob(decode_key(session_key, "sessionKey")?));
    }
    let sql = format!(
        "SELECT lower(hex(s.session_key)),lower(hex(he.event_key)),lower(hex(he.revision)),
                fa.observed_timestamp,he.event_kind,fa.activity_ordinal,fa.action,fa.phase,
                fa.path_role,fa.raw_path,fa.normalized_path,fa.relative_path,
                fa.is_absolute,fa.is_project_relative
         FROM file_activity fa
         JOIN history_events he ON he.event_key=fa.event_key
         JOIN sessions s ON s.session_id=he.session_id
         WHERE {scope}
         ORDER BY s.session_key,he.record_start_offset,he.content_index,
                  he.event_ordinal,he.event_key,fa.activity_ordinal
         LIMIT {}",
        MAX_RECIPE_DETAIL_ITEMS + 1
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query_map(params_from_iter(values), |row| {
            Ok(FileDetail {
                session_key: row.get(0)?,
                event_key: row.get(1)?,
                revision: row.get(2)?,
                observed_at: row.get(3)?,
                event_kind: row.get(4)?,
                ordinal: nonnegative_u64(row.get(5)?)?,
                action: row.get(6)?,
                phase: row.get(7)?,
                path_role: row.get(8)?,
                raw_path: row.get(9)?,
                normalized_path: row.get(10)?,
                relative_path: row.get(11)?,
                absolute: row.get(12)?,
                project_relative: row.get(13)?,
            })
        })
        .map_err(query_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(query_failed)?;
    drop(statement);
    let detail_limited = rows.len() > MAX_RECIPE_DETAIL_ITEMS;
    if detail_limited && !request.allow_degraded {
        return Err(QueryError::new(
            "TS_QUERY_TOO_BROAD",
            "file workflow detail exceeds the bounded recipe budget",
        ));
    }
    if detail_limited {
        rows.truncate(MAX_RECIPE_DETAIL_ITEMS);
    }
    let event_revisions = rows
        .iter()
        .map(|row| (row.event_key.clone(), row.revision.clone()))
        .collect::<BTreeMap<_, _>>();
    let payloads = payload_references_for_events(connection, &event_revisions)?;
    let mut result = BTreeMap::<String, Vec<Value>>::new();
    for row in rows {
        let input = payload_for_kind(&payloads, &row.event_key, "tool-input");
        let output = payload_for_kind(&payloads, &row.event_key, "tool-output");
        let error = payload_for_kind(&payloads, &row.event_key, "error-content");
        let evidence = input
            .as_ref()
            .or(error.as_ref())
            .or(output.as_ref())
            .and_then(|value| value.get("reference"))
            .filter(|value| !value.is_null())
            .cloned()
            .unwrap_or_else(
                || json!({"kind":"event","eventKey":row.event_key,"revision":row.revision}),
            );
        result.entry(row.session_key).or_default().push(json!({
            "eventKey": row.event_key,
            "revision": row.revision,
            "observedAt": row.observed_at,
            "eventKind": row.event_kind,
            "activityOrdinal": row.ordinal.to_string(),
            "action": row.action,
            "phase": row.phase,
            "pathRole": row.path_role,
            "rawPath": row.raw_path,
            "normalizedPath": row.normalized_path,
            "relativePath": row.relative_path,
            "absolute": row.absolute,
            "projectRelative": row.project_relative,
            "input": input,
            "output": output,
            "error": error,
            "evidence": evidence,
        }));
    }
    Ok((result, detail_limited))
}

fn activity_shifts(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<Vec<Value>, QueryError> {
    let bucket = request.filters.bucket.expect("validated activity bucket");
    let width_ms = match bucket {
        RecipeBucket::Day => 86_400_000,
        RecipeBucket::Week => 7 * 86_400_000,
    };
    let bounds = activity_window_bounds(&request.window, bucket, "window")?;
    let baseline = request
        .comparison_window
        .as_ref()
        .map(|window| activity_window_bounds(window, bucket, "comparisonWindow"))
        .transpose()?;
    if baseline.is_some_and(|baseline| {
        baseline.before_ms - baseline.after_ms != bounds.before_ms - bounds.after_ms
    }) {
        return Err(invalid(
            "activity-shifts@1 comparisonWindow must contain the same number of buckets",
        ));
    }
    let current = read_activity_buckets(connection, request, bounds, width_ms)?;
    let baseline_states =
        if let (Some(window), Some(bounds)) = (&request.comparison_window, baseline) {
            let mut baseline_request = request.clone();
            baseline_request.window = window.clone();
            Some(read_activity_buckets(
                connection,
                &baseline_request,
                bounds,
                width_ms,
            )?)
        } else {
            None
        };
    let bucket_count = (bounds.before_ms - bounds.after_ms) / width_ms;
    let mut result = Vec::with_capacity(bucket_count as usize);
    for index in 0..bucket_count {
        let start = bounds.after_ms + index * width_ms;
        let state = current.get(&start).cloned().unwrap_or_default();
        let comparison = baseline_states
            .as_ref()
            .map(|states| {
                let baseline_start =
                    baseline.expect("comparison bounds exist").after_ms + index * width_ms;
                let baseline_state = states.get(&baseline_start).cloned().unwrap_or_default();
                activity_comparison(baseline_start, &baseline_state, &state)
            })
            .transpose()?;
        result.push(activity_bucket_value(
            start,
            width_ms,
            state,
            comparison,
            &request.evaluated_at,
        )?);
    }
    Ok(result)
}

#[derive(Clone, Default)]
struct ActivityBucketState {
    distinct_sessions: u64,
    distinct_turns: u64,
    projects: BTreeSet<String>,
    context_switches: u64,
    tool_invocations: u64,
    skill_invocations: u64,
    token_events: u64,
    token_values: [u128; 6],
    token_present: [u64; 6],
    closure_counts: [u64; 3],
    outcome_counts: [u64; 3],
    dedupe_support: Option<Value>,
    evidence: Option<Value>,
}

fn activity_window_bounds(
    window: &RecipeWindow,
    bucket: RecipeBucket,
    label: &str,
) -> Result<WindowBounds, QueryError> {
    let bounds = window.bounds(label)?;
    let width_ms = match bucket {
        RecipeBucket::Day => 86_400_000,
        RecipeBucket::Week => 7 * 86_400_000,
    };
    let bucket_count = (bounds.before_ms - bounds.after_ms) / width_ms;
    if bucket_count == 0 || bucket_count > 366 {
        return Err(invalid(
            "activity-shifts@1 is limited to 366 complete buckets",
        ));
    }
    let aligned = match bucket {
        RecipeBucket::Day => bounds.after_ms % width_ms == 0 && bounds.before_ms % width_ms == 0,
        RecipeBucket::Week => {
            const MONDAY_UTC_OFFSET_MS: u64 = 4 * 86_400_000;
            bounds.after_ms >= MONDAY_UTC_OFFSET_MS
                && bounds.before_ms >= MONDAY_UTC_OFFSET_MS
                && (bounds.after_ms - MONDAY_UTC_OFFSET_MS).is_multiple_of(width_ms)
                && (bounds.before_ms - MONDAY_UTC_OFFSET_MS).is_multiple_of(width_ms)
        }
    };
    if !aligned || bounds.before_ms - bounds.after_ms != bucket_count * width_ms {
        return Err(invalid(
            "activity-shifts@1 window must align to complete UTC bucket boundaries",
        ));
    }
    Ok(bounds)
}

fn read_activity_buckets(
    connection: &Connection,
    request: &RecipeRequest,
    bounds: WindowBounds,
    width_ms: u64,
) -> Result<BTreeMap<u64, ActivityBucketState>, QueryError> {
    let activity_request = ActivityRequest {
        window: ActivityWindow {
            observed_at_or_after: request.window.after.clone(),
            observed_before: request.window.before.clone(),
        },
        providers: request.filters.providers.clone(),
        project_keys: request.filters.project_keys.clone(),
        closure_states: Vec::new(),
        bucket: match request.filters.bucket.expect("validated activity bucket") {
            RecipeBucket::Day => QueryActivityBucket::Day,
            RecipeBucket::Week => QueryActivityBucket::Week,
        },
        time_zone: "UTC".to_owned(),
        now_unix_ms: parse_canonical_timestamp(&request.evaluated_at, "evaluatedAt")?,
        quiescence_seconds: RECIPE_QUIESCENCE_SECONDS,
    };
    let mut buckets = BTreeMap::<u64, ActivityBucketState>::new();
    for row in read_activity_buckets_in_snapshot(connection, &activity_request)? {
        let start = parse_canonical_timestamp(&row.bucket_start, "bucketStart")?;
        let state = buckets.entry(start).or_default();
        state.distinct_sessions = parse_decimal_count(&row.distinct_session_count)?;
        state.distinct_turns = parse_decimal_count(&row.distinct_turn_count)?;
        state.tool_invocations = parse_decimal_count(&row.recorded_tool_invocation_count)?;
        state.skill_invocations = parse_decimal_count(&row.recorded_skill_invocation_count)?;
        state.closure_counts = [
            parse_decimal_count(&row.current_closure_counts.hard_sealed)?,
            parse_decimal_count(&row.current_closure_counts.quiescent)?,
            parse_decimal_count(&row.current_closure_counts.open)?,
        ];
        state.outcome_counts = [
            parse_decimal_count(&row.turn_result_evidence_counts.provider_completed)?,
            parse_decimal_count(&row.turn_result_evidence_counts.abandoned)?,
            parse_decimal_count(&row.turn_result_evidence_counts.unknown)?,
        ];
        state.dedupe_support = Some(json!({
            "distinctDedupeGroupCount": row.support.distinct_dedupe_group_count,
            "strongDedupeGroupCount": row.support.strong_dedupe_group_count,
            "weakDedupeGroupCount": row.support.weak_dedupe_group_count,
            "observedEofProvisionalGroupCount": row.support.observed_eof_provisional_group_count,
            "unknownDedupeSessionCount": row.support.unknown_dedupe_session_count,
        }));
    }
    enrich_projected_activity_buckets(connection, request, bounds, width_ms, &mut buckets)?;
    if !projected_activity_order_is_exact(connection, request)? {
        for state in buckets.values_mut() {
            state.context_switches = 0;
        }
        enrich_exact_activity_order(connection, request, bounds, width_ms, &mut buckets)?;
    }
    Ok(buckets)
}

fn enrich_exact_activity_order(
    connection: &Connection,
    request: &RecipeRequest,
    bounds: WindowBounds,
    width_ms: u64,
    buckets: &mut BTreeMap<u64, ActivityBucketState>,
) -> Result<(), QueryError> {
    let mut last_project = None::<String>;
    let mut exact_evidence_buckets = BTreeSet::<u64>::new();
    for window in segmented_windows(&request.window)? {
        let mut segment = request.clone();
        segment.window = window;
        let (sql, values) = exact_activity_order_statement(&segment)?;
        let mut statement = connection.prepare(&sql).map_err(query_failed)?;
        let mut rows = statement
            .query(params_from_iter(values))
            .map_err(query_failed)?;
        while let Some(row) = rows.next().map_err(query_failed)? {
            let observed: String = row.get(0).map_err(query_failed)?;
            let observed_ms = parse_canonical_timestamp(&observed, "stored observedAt")?;
            let start = bounds.after_ms + ((observed_ms - bounds.after_ms) / width_ms) * width_ms;
            let state = buckets.entry(start).or_default();
            let session_key: String = row.get(1).map_err(query_failed)?;
            let project_key: Option<String> = row.get(2).map_err(query_failed)?;
            let session_revision: String = row.get(3).map_err(query_failed)?;
            if let Some(project_key) = &project_key {
                state.projects.insert(project_key.clone());
                if last_project
                    .as_ref()
                    .is_some_and(|last| last != project_key)
                {
                    state.context_switches += 1;
                }
                last_project = Some(project_key.clone());
            }
            if exact_evidence_buckets.insert(start) {
                state.evidence = Some(
                    json!({"kind":"session","sessionKey":session_key,"revision":session_revision}),
                );
            }
        }
    }
    Ok(())
}

fn exact_activity_order_statement(
    request: &RecipeRequest,
) -> Result<(String, Vec<SqlValue>), QueryError> {
    let (scope, values) = event_scope(request, None)?;
    Ok((
        format!(
            "SELECT he.observed_timestamp,lower(hex(s.session_key)),
                    CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                    lower(hex(sc.canonical_digest))
             FROM history_events he INDEXED BY history_events_observed
             CROSS JOIN sessions s ON s.session_id=he.session_id
             CROSS JOIN session_commits sc ON sc.session_id=s.session_id
             WHERE {scope}
             ORDER BY he.observed_timestamp,he.event_key"
        ),
        values,
    ))
}

fn enrich_projected_activity_buckets(
    connection: &Connection,
    request: &RecipeRequest,
    bounds: WindowBounds,
    width_ms: u64,
    buckets: &mut BTreeMap<u64, ActivityBucketState>,
) -> Result<(), QueryError> {
    let (scope, values) = projected_rollup_scope(request, None)?;
    let sql = format!(
        "SELECT rollup.bucket_day,lower(hex(s.session_key)),
                CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                lower(hex(sc.canonical_digest)),rollup.first_observed_timestamp
         FROM history_activity_rollups rollup
         JOIN sessions s ON s.session_id=rollup.session_id
         JOIN session_commits sc ON sc.session_id=rollup.session_id
         WHERE {scope}
         ORDER BY rollup.first_observed_timestamp,s.session_key"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(query_failed)?;
    let mut last_project = None::<String>;
    while let Some(row) = rows.next().map_err(query_failed)? {
        let day = row.get::<_, String>(0).map_err(query_failed)?;
        let observed_ms =
            parse_canonical_timestamp(&format!("{day}T00:00:00.000Z"), "projected bucket day")?;
        let start = bounds.after_ms + ((observed_ms - bounds.after_ms) / width_ms) * width_ms;
        let state = buckets.entry(start).or_default();
        let session_key: String = row.get(1).map_err(query_failed)?;
        let project_key: Option<String> = row.get(2).map_err(query_failed)?;
        let revision: String = row.get(3).map_err(query_failed)?;
        if let Some(project_key) = &project_key {
            state.projects.insert(project_key.clone());
            if last_project
                .as_ref()
                .is_some_and(|last| last != project_key)
            {
                state.context_switches += 1;
            }
            last_project = Some(project_key.clone());
        }
        state.evidence.get_or_insert_with(
            || json!({"kind":"session","sessionKey":session_key,"revision":revision}),
        );
    }
    drop(rows);
    drop(statement);

    let (scope, values) = projected_rollup_scope(request, None)?;
    let sql = format!(
        "SELECT rollup.bucket_day,rollup.event_count,
                rollup.input_total,rollup.cached_input_total,
                rollup.cache_write_input_total,rollup.output_total,
                rollup.reasoning_total,rollup.total_total,
                rollup.input_present,rollup.cached_input_present,
                rollup.cache_write_input_present,rollup.output_present,
                rollup.reasoning_present,rollup.total_present
         FROM history_token_rollups rollup
         JOIN sessions s ON s.session_id=rollup.session_id
         WHERE {scope} ORDER BY rollup.bucket_day,rollup.rollup_id"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(query_failed)?;
    while let Some(row) = rows.next().map_err(query_failed)? {
        let day = row.get::<_, String>(0).map_err(query_failed)?;
        let observed_ms =
            parse_canonical_timestamp(&format!("{day}T00:00:00.000Z"), "projected bucket day")?;
        let start = bounds.after_ms + ((observed_ms - bounds.after_ms) / width_ms) * width_ms;
        let state = buckets.entry(start).or_default();
        state.token_events = state
            .token_events
            .checked_add(query_nonnegative_u64(row.get(1).map_err(query_failed)?)?)
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "token event count overflowed"))?;
        for index in 0..6 {
            state.token_values[index] = state.token_values[index]
                .checked_add(parse_u128_text(
                    &row.get::<_, String>(2 + index).map_err(query_failed)?,
                    "token rollup total",
                )?)
                .ok_or_else(|| QueryError::new("QUERY_FAILED", "token total overflowed"))?;
            state.token_present[index] = state.token_present[index]
                .checked_add(query_nonnegative_u64(
                    row.get(8 + index).map_err(query_failed)?,
                )?)
                .ok_or_else(|| QueryError::new("QUERY_FAILED", "token coverage overflowed"))?;
        }
    }
    Ok(())
}

fn projected_activity_order_is_exact(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<bool, QueryError> {
    let (scope, values) = projected_rollup_scope(request, None)?;
    let sql = format!(
        "SELECT coverage.first_history_event_at,coverage.last_history_event_at
         FROM history_activity_rollups rollup
         JOIN sessions s ON s.session_id=rollup.session_id
         JOIN history_query_session_coverage coverage
           ON coverage.session_id=rollup.session_id
         WHERE {scope}
         GROUP BY rollup.session_id
         ORDER BY coverage.first_history_event_at,s.session_key"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(query_failed)?;
    let mut previous_end = None::<String>;
    while let Some(row) = rows.next().map_err(query_failed)? {
        let Some(start) = row.get::<_, Option<String>>(0).map_err(query_failed)? else {
            return Ok(false);
        };
        let Some(end) = row.get::<_, Option<String>>(1).map_err(query_failed)? else {
            return Ok(false);
        };
        if previous_end
            .as_ref()
            .is_some_and(|previous| previous >= &start)
        {
            return Ok(false);
        }
        previous_end = Some(end);
    }
    Ok(true)
}

fn activity_bucket_value(
    start: u64,
    width_ms: u64,
    state: ActivityBucketState,
    comparison: Option<Value>,
    evaluated_at: &str,
) -> Result<Value, QueryError> {
    Ok(json!({
        "bucketStart": crate::agent_query::canonical_timestamp(start)?,
        "bucketEnd": crate::agent_query::canonical_timestamp(start + width_ms)?,
        "timeZone": "UTC",
        "closureEvaluatedAt": evaluated_at,
        "quiescenceSeconds": RECIPE_QUIESCENCE_SECONDS,
        "distinctSessionCount": state.distinct_sessions.to_string(),
        "distinctTurnCount": state.distinct_turns.to_string(),
        "distinctProjectCount": state.projects.len().to_string(),
        "observedContextSwitchCount": state.context_switches.to_string(),
        "recordedToolInvocationCount": state.tool_invocations.to_string(),
        "recordedSkillInvocationCount": state.skill_invocations.to_string(),
        "recordedTokenEventCount": state.token_events.to_string(),
        "recordedTokenTotals": activity_token_totals(&state),
        "tokenMetricCoverage": activity_token_coverage(&state),
        "currentClosureCounts": {
            "hardSealed": state.closure_counts[0].to_string(),
            "quiescent": state.closure_counts[1].to_string(),
            "open": state.closure_counts[2].to_string(),
        },
        "turnOutcomeCounts": {
            "providerCompleted": state.outcome_counts[0].to_string(),
            "abandoned": state.outcome_counts[1].to_string(),
            "unknown": state.outcome_counts[2].to_string(),
        },
        "dedupeSupport": state.dedupe_support.unwrap_or_else(empty_activity_support),
        "comparison": comparison,
        "evidence": state.evidence.unwrap_or(Value::Null),
    }))
}

const TOKEN_METRIC_NAMES: [&str; 6] = [
    "input",
    "cachedInput",
    "cacheWriteInput",
    "output",
    "reasoning",
    "total",
];

fn activity_token_value(state: &ActivityBucketState, index: usize) -> Option<u128> {
    if state.token_events == 0 {
        Some(0)
    } else if state.token_present[index] == state.token_events {
        Some(state.token_values[index])
    } else {
        None
    }
}

fn activity_token_totals(state: &ActivityBucketState) -> Value {
    Value::Object(
        TOKEN_METRIC_NAMES
            .iter()
            .enumerate()
            .map(|(index, name)| {
                (
                    (*name).to_owned(),
                    activity_token_value(state, index)
                        .map(|value| Value::String(value.to_string()))
                        .unwrap_or(Value::Null),
                )
            })
            .collect(),
    )
}

fn activity_token_coverage(state: &ActivityBucketState) -> Value {
    Value::Object(
        TOKEN_METRIC_NAMES
            .iter()
            .enumerate()
            .map(|(index, name)| {
                (
                    (*name).to_owned(),
                    json!({
                        "presentEventCount": state.token_present[index].to_string(),
                        "totalEventCount": state.token_events.to_string(),
                    }),
                )
            })
            .collect(),
    )
}

fn activity_token_comparison(
    baseline: &ActivityBucketState,
    current: &ActivityBucketState,
) -> Value {
    Value::Object(
        TOKEN_METRIC_NAMES
            .iter()
            .enumerate()
            .map(|(index, name)| {
                let complete = |state: &ActivityBucketState| {
                    state.token_events == 0 || state.token_present[index] == state.token_events
                };
                let value = if complete(baseline) && complete(current) {
                    let baseline_value = activity_token_value(baseline, index).unwrap_or(0);
                    let current_value = activity_token_value(current, index).unwrap_or(0);
                    json!({
                        "baseline": baseline_value.to_string(),
                        "current": current_value.to_string(),
                        "absoluteChange": signed_change_u128(baseline_value, current_value),
                    })
                } else {
                    json!({"baseline":null,"current":null,"absoluteChange":null})
                };
                ((*name).to_owned(), value)
            })
            .collect(),
    )
}

fn empty_activity_support() -> Value {
    json!({
        "distinctDedupeGroupCount":"0",
        "strongDedupeGroupCount":"0",
        "weakDedupeGroupCount":"0",
        "observedEofProvisionalGroupCount":"0",
        "unknownDedupeSessionCount":"0",
    })
}

fn comparison_count(baseline: usize, current: usize) -> Value {
    json!({
        "baseline": baseline.to_string(),
        "current": current.to_string(),
        "absoluteChange": signed_change(baseline as u64, current as u64),
    })
}

fn comparison_u64(baseline: u64, current: u64) -> Value {
    json!({
        "baseline": baseline.to_string(),
        "current": current.to_string(),
        "absoluteChange": signed_change(baseline, current),
    })
}

fn signed_change(baseline: u64, current: u64) -> String {
    if current >= baseline {
        (current - baseline).to_string()
    } else {
        format!("-{}", baseline - current)
    }
}

fn signed_change_u128(baseline: u128, current: u128) -> String {
    if current >= baseline {
        (current - baseline).to_string()
    } else {
        format!("-{}", baseline - current)
    }
}

fn activity_comparison(
    baseline_start: u64,
    baseline: &ActivityBucketState,
    current: &ActivityBucketState,
) -> Result<Value, QueryError> {
    Ok(json!({
        "baselineBucketStart": crate::agent_query::canonical_timestamp(baseline_start)?,
        "distinctSessionCount": comparison_u64(baseline.distinct_sessions, current.distinct_sessions),
        "distinctTurnCount": comparison_u64(baseline.distinct_turns, current.distinct_turns),
        "distinctProjectCount": comparison_count(baseline.projects.len(), current.projects.len()),
        "observedContextSwitchCount": comparison_u64(baseline.context_switches, current.context_switches),
        "recordedToolInvocationCount": comparison_u64(baseline.tool_invocations, current.tool_invocations),
        "recordedSkillInvocationCount": comparison_u64(baseline.skill_invocations, current.skill_invocations),
        "recordedTokenEventCount": comparison_u64(baseline.token_events, current.token_events),
        "recordedTokenTotals": activity_token_comparison(baseline, current),
        "currentClosureCounts": {
            "hardSealed": comparison_u64(baseline.closure_counts[0], current.closure_counts[0]),
            "quiescent": comparison_u64(baseline.closure_counts[1], current.closure_counts[1]),
            "open": comparison_u64(baseline.closure_counts[2], current.closure_counts[2]),
        },
        "turnOutcomeCounts": {
            "providerCompleted": comparison_u64(baseline.outcome_counts[0], current.outcome_counts[0]),
            "abandoned": comparison_u64(baseline.outcome_counts[1], current.outcome_counts[1]),
            "unknown": comparison_u64(baseline.outcome_counts[2], current.outcome_counts[2]),
        },
    }))
}

fn token_hotspots(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<Vec<Value>, QueryError> {
    if complete_day_window(&request.window)?.is_some() {
        return projected_token_hotspots(connection, request);
    }
    let (scope, values) = token_scope(request)?;
    let sql = format!(
        "SELECT s.provider,tu.model,
                CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                tu.input_tokens,tu.cached_input_tokens,tu.cache_write_input_tokens,
                tu.output_tokens,tu.reasoning_tokens,tu.total_tokens,
                lower(hex(he.event_key)),lower(hex(he.revision)),
                (SELECT lower(hex(hp.payload_key)) FROM history_payloads hp
                 WHERE hp.event_key=he.event_key ORDER BY hp.payload_key LIMIT 1)
         FROM token_usage tu
         JOIN history_events he ON he.event_key=tu.event_key
         JOIN sessions s ON s.session_id=he.session_id
         WHERE {scope}
         ORDER BY s.provider,tu.model,s.project_key,he.event_key"
    );
    #[derive(Default)]
    struct Totals {
        events: u64,
        values: [u128; 6],
        present: [u64; 6],
        evidence: Option<Value>,
    }
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(query_failed)?;
    let mut groups = BTreeMap::<(String, Option<String>, Option<String>), Totals>::new();
    while let Some(row) = rows.next().map_err(query_failed)? {
        let key = (
            row.get(0).map_err(query_failed)?,
            row.get(1).map_err(query_failed)?,
            row.get(2).map_err(query_failed)?,
        );
        let group = groups.entry(key).or_default();
        group.events += 1;
        for index in 0..6 {
            let value: Option<Vec<u8>> = row.get(3 + index).map_err(query_failed)?;
            if let Some(value) = value {
                group.values[index] += u128::from(blob_u64(value).map_err(query_failed)?);
                group.present[index] += 1;
            }
        }
        let event_key: String = row.get(9).map_err(query_failed)?;
        let revision: String = row.get(10).map_err(query_failed)?;
        let payload_key: Option<String> = row.get(11).map_err(query_failed)?;
        group
            .evidence
            .get_or_insert_with(|| event_evidence(&event_key, &revision, payload_key.as_deref()));
    }
    let names = [
        "input",
        "cachedInput",
        "cacheWriteInput",
        "output",
        "reasoning",
        "total",
    ];
    let mut result = Vec::with_capacity(groups.len());
    for ((provider, model, project_key), group) in groups {
        let mut totals = Map::new();
        let mut coverage = Map::new();
        for (index, name) in names.iter().enumerate() {
            totals.insert(
                (*name).to_owned(),
                if group.present[index] == group.events {
                    Value::String(group.values[index].to_string())
                } else {
                    Value::Null
                },
            );
            coverage.insert(
                (*name).to_owned(),
                json!({"presentEventCount":group.present[index].to_string(),
                       "totalEventCount":group.events.to_string()}),
            );
        }
        result.push(json!({
            "provider":provider,"model":model,"projectKey":project_key,
            "capability":null,
            "capabilityAttribution":"unavailable",
            "recordedTokenTotals":totals,"metricCoverage":coverage,
            "evidence":group.evidence.unwrap_or(Value::Null),
        }));
    }
    result.sort_by(|left, right| {
        decimal_json(right.pointer("/recordedTokenTotals/total"))
            .cmp(&decimal_json(left.pointer("/recordedTokenTotals/total")))
            .then_with(|| left.to_string().cmp(&right.to_string()))
    });
    Ok(result)
}

fn projected_token_hotspots(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<Vec<Value>, QueryError> {
    let (scope, values) = projected_rollup_scope(request, None)?;
    let sql = format!(
        "SELECT s.provider,rollup.model,
                CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                rollup.event_count,rollup.input_total,rollup.cached_input_total,
                rollup.cache_write_input_total,rollup.output_total,
                rollup.reasoning_total,rollup.total_total,
                rollup.input_present,rollup.cached_input_present,
                rollup.cache_write_input_present,rollup.output_present,
                rollup.reasoning_present,rollup.total_present,
                lower(hex(rollup.evidence_event_key)),lower(hex(rollup.evidence_revision))
         FROM history_token_rollups rollup
         JOIN sessions s ON s.session_id=rollup.session_id
         WHERE {scope}
         ORDER BY s.provider,rollup.model,s.project_key,rollup.evidence_event_key"
    );
    #[derive(Default)]
    struct Totals {
        events: u64,
        values: [u128; 6],
        present: [u64; 6],
        evidence: Option<Value>,
    }
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(query_failed)?;
    let mut groups = BTreeMap::<(String, Option<String>, Option<String>), Totals>::new();
    while let Some(row) = rows.next().map_err(query_failed)? {
        let key = (
            row.get(0).map_err(query_failed)?,
            row.get(1).map_err(query_failed)?,
            row.get(2).map_err(query_failed)?,
        );
        let group = groups.entry(key).or_default();
        group.events = group
            .events
            .checked_add(query_nonnegative_u64(row.get(3).map_err(query_failed)?)?)
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "token event count overflowed"))?;
        for index in 0..6 {
            group.values[index] = group.values[index]
                .checked_add(parse_u128_text(
                    &row.get::<_, String>(4 + index).map_err(query_failed)?,
                    "token rollup total",
                )?)
                .ok_or_else(|| QueryError::new("QUERY_FAILED", "token total overflowed"))?;
            group.present[index] = group.present[index]
                .checked_add(query_nonnegative_u64(
                    row.get(10 + index).map_err(query_failed)?,
                )?)
                .ok_or_else(|| QueryError::new("QUERY_FAILED", "token coverage overflowed"))?;
        }
        let event_key: String = row.get(16).map_err(query_failed)?;
        let revision: String = row.get(17).map_err(query_failed)?;
        group
            .evidence
            .get_or_insert_with(|| event_evidence(&event_key, &revision, None));
    }
    drop(rows);
    drop(statement);
    let names = [
        "input",
        "cachedInput",
        "cacheWriteInput",
        "output",
        "reasoning",
        "total",
    ];
    let mut result = Vec::with_capacity(groups.len());
    for ((provider, model, project_key), group) in groups {
        let mut totals = Map::new();
        let mut coverage = Map::new();
        for (index, name) in names.iter().enumerate() {
            totals.insert(
                (*name).to_owned(),
                if group.present[index] == group.events {
                    Value::String(group.values[index].to_string())
                } else {
                    Value::Null
                },
            );
            coverage.insert(
                (*name).to_owned(),
                json!({"presentEventCount":group.present[index].to_string(),
                       "totalEventCount":group.events.to_string()}),
            );
        }
        result.push(json!({
            "provider":provider,"model":model,"projectKey":project_key,
            "capability":null,"capabilityAttribution":"unavailable",
            "recordedTokenTotals":totals,"metricCoverage":coverage,
            "evidence":group.evidence.unwrap_or(Value::Null),
        }));
    }
    result.sort_by(|left, right| {
        decimal_json(right.pointer("/recordedTokenTotals/total"))
            .cmp(&decimal_json(left.pointer("/recordedTokenTotals/total")))
            .then_with(|| left.to_string().cmp(&right.to_string()))
    });
    Ok(result)
}

fn query_nonnegative_u64(value: i64) -> Result<u64, QueryError> {
    u64::try_from(value)
        .map_err(|_| QueryError::new("QUERY_FAILED", "stored aggregate count is invalid"))
}

fn parse_u128_text(value: &str, label: &str) -> Result<u128, QueryError> {
    value
        .parse::<u128>()
        .map_err(|_| QueryError::new("QUERY_FAILED", format!("stored {label} is invalid")))
}

fn solution_recall(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<Vec<Value>, QueryError> {
    let (sql, values) = solution_recall_statement(request)?;
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    statement
        .query_map(params_from_iter(values), |row| {
            let event_key: String = row.get(0)?;
            let event_revision: String = row.get(1)?;
            let payload_key: Option<String> = row.get(2)?;
            let turn_key: Option<String> = row.get(3)?;
            let turn_revision: Option<String> = row.get(4)?;
            let evidence = event_evidence(&event_key, &event_revision, payload_key.as_deref());
            let success_event_key: Option<String> = row.get(11)?;
            let subsequent_success = success_event_key
                .map(|success_event_key| {
                    let success_revision = row.get::<_, String>(12)?;
                    let success_payload_key = row.get::<_, Option<String>>(14)?;
                    Ok::<Value, rusqlite::Error>(json!({
                        "chainKey": row.get::<_, String>(10)?,
                        "eventKey": success_event_key,
                        "observedAt": row.get::<_, Option<String>>(13)?,
                        "evidence": event_evidence(
                            &success_event_key,
                            &success_revision,
                            success_payload_key.as_deref(),
                        ),
                    }))
                })
                .transpose()?;
            Ok(json!({
                "eventKey":event_key,"eventRevision":event_revision,
                "turnKey":turn_key,"turnRevision":turn_revision,
                "provider":row.get::<_, String>(8)?,"projectKey":row.get::<_, Option<String>>(9)?,
                "eventKind":row.get::<_, String>(6)?,"observedAt":row.get::<_, Option<String>>(7)?,
                "finalAnswer":row.get::<_, Option<String>>(5)?,
                "subsequentSuccess":subsequent_success,
                "evidence":evidence,
            }))
        })
        .map_err(query_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(query_failed)
}

fn solution_recall_statement(
    request: &RecipeRequest,
) -> Result<(String, Vec<SqlValue>), QueryError> {
    let (matched_events, result_scope, values) = solution_recall_match(request)?;
    let sql = format!(
        "WITH {matched_events}
         SELECT lower(hex(he.event_key)),lower(hex(he.revision)),
                (SELECT lower(hex(hp.payload_key)) FROM history_payloads hp
                 WHERE hp.event_key=he.event_key ORDER BY hp.payload_key LIMIT 1),
                CASE WHEN t.turn_key IS NULL THEN NULL ELSE lower(hex(t.turn_key)) END,
                CASE WHEN t.revision IS NULL THEN NULL ELSE lower(hex(t.revision)) END,
                t.final_answer_excerpt,he.event_kind,he.observed_timestamp,s.provider,
                CASE WHEN s.project_key IS NULL THEN NULL ELSE lower(hex(s.project_key)) END,
                CASE WHEN matched_chain.chain_key IS NULL THEN NULL
                     ELSE lower(hex(matched_chain.chain_key)) END,
                CASE WHEN success_event.event_key IS NULL THEN NULL
                     ELSE lower(hex(success_event.event_key)) END,
                CASE WHEN success_event.revision IS NULL THEN NULL
                     ELSE lower(hex(success_event.revision)) END,
                success_event.observed_timestamp,
                (SELECT lower(hex(success_payload.payload_key))
                 FROM history_payloads success_payload
                 WHERE success_payload.event_key=success_event.event_key
                 ORDER BY success_payload.payload_key LIMIT 1)
         FROM matched_events matched
         JOIN history_events he ON he.event_key=matched.event_key
         JOIN sessions s ON s.session_id=he.session_id
         LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id
         LEFT JOIN attempt_chain_events matched_chain ON matched_chain.event_key=he.event_key
         LEFT JOIN history_events success_event ON success_event.event_key=(
           SELECT later.event_key
           FROM attempt_chain_events later_chain
           JOIN history_events later ON later.event_key=later_chain.event_key
           WHERE later_chain.chain_key=matched_chain.chain_key
             AND later.event_kind='capability-result'
             AND json_extract(later.metadata_json,'$.providerState')='completed'
             AND (
               later.record_start_offset>he.record_start_offset OR
               (later.record_start_offset=he.record_start_offset
                AND later.content_index>he.content_index) OR
               (later.record_start_offset=he.record_start_offset
                AND later.content_index=he.content_index
                AND later.event_ordinal>he.event_ordinal) OR
               (later.record_start_offset=he.record_start_offset
                AND later.content_index=he.content_index
                AND later.event_ordinal=he.event_ordinal
                AND later.event_key>he.event_key)
             )
           ORDER BY later.record_start_offset,later.content_index,
                    later.event_ordinal,later.event_key
           LIMIT 1
         )
         {result_scope}
         ORDER BY he.observed_timestamp IS NULL,he.observed_timestamp DESC,he.event_key
         LIMIT {}",
        MAX_RECIPE_ITEMS + 1,
    );
    Ok((sql, values))
}

fn solution_recall_match(
    request: &RecipeRequest,
) -> Result<(String, String, Vec<SqlValue>), QueryError> {
    let query = request.filters.text.as_deref().expect("validated text");
    let analyzed = analyze_query(query).map_err(|error| match error {
        AnalyzerError::QueryTooLong => QueryError::new("TS_QUERY_TOO_LONG", "query is too long"),
        AnalyzerError::QueryTooBroad => QueryError::new("TS_QUERY_TOO_BROAD", "query is too broad"),
    })?;
    let expression =
        HistoryFtsMatchExpression::from_query_terms(&analyzed.terms).map_err(query_failed)?;
    let (scope, scope_values) = event_scope(request, None)?;
    let mut values = vec![SqlValue::Text(expression.as_str().to_owned())];
    values.extend(scope_values);
    let (matched_documents, result_scope) = if request.filters.session_keys.is_empty() {
        (
            "SELECT rowid FROM history_event_fts
             WHERE history_event_fts MATCH ?"
                .to_owned(),
            format!("WHERE {scope}"),
        )
    } else {
        (
            format!(
                "SELECT rowid FROM history_event_fts
                 WHERE history_event_fts MATCH ?
                   AND rowid IN (
                     SELECT hfd.document_id
                     FROM history_events he
                     JOIN sessions s ON s.session_id=he.session_id
                     JOIN history_payloads scoped_payload
                       ON scoped_payload.event_key=he.event_key
                     JOIN history_event_fts_documents hfd
                       ON hfd.payload_key=scoped_payload.payload_key
                     WHERE {scope}
                   )"
            ),
            String::new(),
        )
    };
    let matched_events = format!(
        "matched_documents(document_id) AS MATERIALIZED (
           {matched_documents}
         ), matched_events(event_key) AS MATERIALIZED (
           SELECT DISTINCT matched_payload.event_key
           FROM matched_documents matched_document
           JOIN history_event_fts_documents hfd
             ON hfd.document_id=matched_document.document_id
           JOIN history_payloads matched_payload ON matched_payload.payload_key=hfd.payload_key
         )"
    );
    Ok((matched_events, result_scope, values))
}

fn session_timeline(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<Vec<Value>, QueryError> {
    let (scope, values) = event_scope(request, None)?;
    let sql = format!(
        "SELECT lower(hex(he.event_key)),lower(hex(he.revision)),he.observed_timestamp,
                he.event_kind,he.origin_scope,he.completeness,he.metadata_json,
                CASE WHEN t.turn_key IS NULL THEN NULL ELSE lower(hex(t.turn_key)) END,
                CASE WHEN t.revision IS NULL THEN NULL ELSE lower(hex(t.revision)) END,
                (SELECT lower(hex(event_payload.payload_key))
                 FROM history_payloads event_payload
                 WHERE event_payload.event_key=he.event_key
                 ORDER BY event_payload.payload_key LIMIT 1)
         FROM history_events he
         JOIN sessions s ON s.session_id=he.session_id
         LEFT JOIN turns t ON t.turn_id=he.occurred_turn_id
         WHERE {scope}
         ORDER BY he.record_start_offset,he.content_index,he.event_ordinal,he.event_key"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    statement
        .query_map(params_from_iter(values), |row| {
            let event_key: String = row.get(0)?;
            let revision: String = row.get(1)?;
            let payload_key: Option<String> = row.get(9)?;
            let evidence = event_evidence(&event_key, &revision, payload_key.as_deref());
            Ok(json!({
                "eventKey":event_key,"revision":revision,
                "observedAt":row.get::<_, Option<String>>(2)?,
                "eventKind":row.get::<_, String>(3)?,"originScope":row.get::<_, String>(4)?,
                "completeness":row.get::<_, String>(5)?,
                "metadata":serde_json::from_str::<Value>(&row.get::<_, String>(6)?)
                    .map_err(|_| rusqlite::Error::InvalidQuery)?,
                "turnKey":row.get::<_, Option<String>>(7)?,
                "turnRevision":row.get::<_, Option<String>>(8)?,
                "evidence":evidence,
            }))
        })
        .map_err(query_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(query_failed)
}

fn read_recipe_coverage(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<DeepCoverage, QueryError> {
    if request.name == RecipeName::ActivityShifts && complete_day_window(&request.window)?.is_some()
    {
        return read_projected_activity_coverage(connection, request);
    }
    let extra = match request.name {
        RecipeName::CapabilityContexts | RecipeName::FailureChains => {
            Some("he.event_kind IN ('capability-invocation','capability-result')")
        }
        RecipeName::FileWorkflowSignals => Some("he.has_file_activity=1"),
        RecipeName::TokenHotspots => Some("he.has_token_usage=1"),
        RecipeName::SolutionRecall => None,
        RecipeName::ActivityShifts | RecipeName::SessionTimeline => None,
    };
    let (with_clause, event_source, where_clause, values) =
        if request.name == RecipeName::SolutionRecall {
            let (matched_events, result_scope, values) = solution_recall_match(request)?;
            (
                format!("WITH {matched_events}"),
                "matched_events matched JOIN history_event_coverage he
                   ON he.event_key=matched.event_key
                   JOIN sessions s ON s.session_id=he.session_id"
                    .to_owned(),
                result_scope,
                values,
            )
        } else {
            let (scope, values) = event_scope(request, extra)?;
            (
                String::new(),
                "history_event_coverage he INDEXED BY history_event_coverage_observed
                   CROSS JOIN sessions s ON s.session_id=he.session_id"
                    .to_owned(),
                format!("WHERE {scope}"),
                values,
            )
        };
    let sql = format!(
        "{with_clause}
         SELECT
           SUM(CASE WHEN he.completeness='full' THEN 1 ELSE 0 END),
           SUM(CASE WHEN he.completeness='summary' THEN 1 ELSE 0 END),
           SUM(CASE WHEN he.completeness='unloaded' THEN 1 ELSE 0 END),
           SUM(CASE WHEN he.completeness='truncated' THEN 1 ELSE 0 END),
           SUM(CASE WHEN he.completeness='unavailable' THEN 1 ELSE 0 END),
           SUM(CASE WHEN he.observed_timestamp IS NULL THEN 1 ELSE 0 END),
           SUM(he.missing_revision),SUM(he.missing_token_metric),SUM(he.missing_payload)
         FROM {event_source}
         {where_clause}"
    );
    let counts = connection
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
        full_record_count: nonnegative_count(counts.0)?,
        summary_record_count: nonnegative_count(counts.1)?,
        unloaded_record_count: nonnegative_count(counts.2)?,
        truncated_record_count: nonnegative_count(counts.3)?,
        unavailable_record_count: nonnegative_count(counts.4)?,
        missing_timestamp_count: nonnegative_count(counts.5)?,
        missing_revision_count: nonnegative_count(counts.6)?,
        missing_token_metric_count: nonnegative_count(counts.7)?,
        missing_payload_count: nonnegative_count(counts.8)?,
    };
    assemble_coverage(connection, matching, "TS_INSIGHTS_RECIPE_PARTIAL_COVERAGE")
}

fn read_projected_activity_coverage(
    connection: &Connection,
    request: &RecipeRequest,
) -> Result<DeepCoverage, QueryError> {
    let (sql, values) = projected_activity_coverage_statement(request)?;
    let counts = connection
        .query_row(&sql, params_from_iter(values), |row| {
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
            ))
        })
        .map_err(query_failed)?;
    let matching = DeepMatchingCoverage {
        full_record_count: nonnegative_count(counts.0)?,
        summary_record_count: nonnegative_count(counts.1)?,
        unloaded_record_count: nonnegative_count(counts.2)?,
        truncated_record_count: nonnegative_count(counts.3)?,
        unavailable_record_count: nonnegative_count(counts.4)?,
        missing_timestamp_count: nonnegative_count(counts.5)?,
        missing_revision_count: nonnegative_count(counts.6)?,
        missing_token_metric_count: nonnegative_count(counts.7)?,
        missing_payload_count: nonnegative_count(counts.8)?,
    };
    assemble_coverage(connection, matching, "TS_INSIGHTS_RECIPE_PARTIAL_COVERAGE")
}

fn projected_activity_coverage_statement(
    request: &RecipeRequest,
) -> Result<(String, Vec<SqlValue>), QueryError> {
    let (scope, values) = projected_rollup_scope(request, None)?;
    let sql = format!(
        "SELECT COALESCE(SUM(rollup.full_count),0),
                COALESCE(SUM(rollup.summary_count),0),
                COALESCE(SUM(rollup.unloaded_count),0),
                COALESCE(SUM(rollup.truncated_count),0),
                COALESCE(SUM(rollup.unavailable_count),0),0,
                COALESCE(SUM(rollup.missing_revision_count),0),
                COALESCE(SUM(rollup.missing_token_metric_count),0),
                COALESCE(SUM(rollup.missing_payload_count),0)
         FROM history_event_day_coverage_rollups rollup
         JOIN sessions s ON s.session_id=rollup.session_id
         WHERE {scope}"
    );
    Ok((sql, values))
}

fn recipe_provenance(name: RecipeName) -> DeepProvenance {
    let fields = match name {
        RecipeName::CapabilityContexts => vec![derived(
            "items.*.distinctDedupeGroupCount",
            "dedupe-support@1",
        )],
        RecipeName::FailureChains => vec![derived("items.*.status", "attempt-chain@1")],
        RecipeName::FileWorkflowSignals => {
            vec![estimated("items.*.estimated", "file-workflow-signals@1")]
        }
        RecipeName::ActivityShifts => vec![derived(
            "items.*.observedContextSwitchCount",
            "activity-shifts@1",
        )],
        RecipeName::TokenHotspots => vec![derived(
            "items.*.capabilityAttribution",
            "provider-token-scope@1",
        )],
        RecipeName::SolutionRecall => {
            vec![derived("items.*.subsequentSuccess", "solution-recall@1")]
        }
        RecipeName::SessionTimeline => Vec::new(),
    };
    DeepProvenance {
        default: "recorded".to_owned(),
        fields,
    }
}

fn derived(path: &str, method: &str) -> DeepProvenanceField {
    DeepProvenanceField {
        path: path.to_owned(),
        kind: "derived".to_owned(),
        method: method.to_owned(),
    }
}

fn estimated(path: &str, method: &str) -> DeepProvenanceField {
    DeepProvenanceField {
        path: path.to_owned(),
        kind: "estimated".to_owned(),
        method: method.to_owned(),
    }
}

fn event_scope(
    request: &RecipeRequest,
    extra: Option<&str>,
) -> Result<(String, Vec<SqlValue>), QueryError> {
    scope_for(request, "he.observed_timestamp", extra)
}

fn file_scope(request: &RecipeRequest) -> Result<(String, Vec<SqlValue>), QueryError> {
    scope_for(request, "fa.observed_timestamp", None)
}

fn token_scope(request: &RecipeRequest) -> Result<(String, Vec<SqlValue>), QueryError> {
    scope_for(request, "tu.observed_timestamp", None)
}

fn complete_day_window(window: &RecipeWindow) -> Result<Option<(String, String)>, QueryError> {
    let bounds = window.bounds("window")?;
    const DAY_MS: u64 = 86_400_000;
    if !bounds.after_ms.is_multiple_of(DAY_MS) || !bounds.before_ms.is_multiple_of(DAY_MS) {
        return Ok(None);
    }
    Ok(Some((
        window.after[..10].to_owned(),
        window.before[..10].to_owned(),
    )))
}

fn projected_rollup_scope(
    request: &RecipeRequest,
    table_alias: Option<&str>,
) -> Result<(String, Vec<SqlValue>), QueryError> {
    let (after_day, before_day) = complete_day_window(&request.window)?
        .ok_or_else(|| invalid("projected recipe window must align to complete UTC days"))?;
    let alias = table_alias.unwrap_or("rollup");
    let mut clauses = vec![
        "s.eligibility='eligible'".to_owned(),
        "s.session_scope='main'".to_owned(),
        "NOT EXISTS (SELECT 1 FROM source_purge_states purge WHERE purge.session_key=s.session_key)"
            .to_owned(),
        format!("{alias}.bucket_day>=?"),
        format!("{alias}.bucket_day<?"),
    ];
    let mut values = vec![SqlValue::Text(after_day), SqlValue::Text(before_day)];
    push_text_filter(
        &mut clauses,
        &mut values,
        "s.provider",
        &request.filters.providers,
    );
    push_blob_filter(
        &mut clauses,
        &mut values,
        "s.project_key",
        &request.filters.project_keys,
    )?;
    push_blob_filter(
        &mut clauses,
        &mut values,
        "s.session_key",
        &request.filters.session_keys,
    )?;
    Ok((clauses.join(" AND "), values))
}

fn projected_capability_scope(
    request: &RecipeRequest,
    table_alias: &str,
) -> Result<(String, Vec<SqlValue>), QueryError> {
    let mut scoped = projected_rollup_scope(request, Some(table_alias))?;
    if !request.filters.capability_keys.is_empty() {
        scoped.0.push_str(&format!(
            " AND c.capability_key IN ({})",
            placeholders(request.filters.capability_keys.len())
        ));
        for item in &request.filters.capability_keys {
            scoped
                .1
                .push(SqlValue::Blob(decode_key(item, "filters.capabilityKeys")?));
        }
    }
    Ok(scoped)
}

fn capability_scope(request: &RecipeRequest) -> Result<(String, Vec<SqlValue>), QueryError> {
    let timestamp = "COALESCE(invocation_event.observed_timestamp,t.observed_timestamp)";
    let mut scoped = scope_for(request, timestamp, Some("cu.origin_scope='main'"))?;
    if !request.filters.capability_keys.is_empty() {
        scoped.0.push_str(&format!(
            " AND c.capability_key IN ({})",
            placeholders(request.filters.capability_keys.len())
        ));
        for item in &request.filters.capability_keys {
            scoped
                .1
                .push(SqlValue::Blob(decode_key(item, "filters.capabilityKeys")?));
        }
    }
    Ok(scoped)
}

fn scope_for(
    request: &RecipeRequest,
    timestamp: &str,
    extra: Option<&str>,
) -> Result<(String, Vec<SqlValue>), QueryError> {
    let mut clauses = vec![
        "s.eligibility='eligible'".to_owned(),
        "s.session_scope='main'".to_owned(),
        "NOT EXISTS (SELECT 1 FROM source_purge_states purge WHERE purge.session_key=s.session_key)"
            .to_owned(),
        format!("{timestamp}>=?"),
        format!("{timestamp}<?"),
    ];
    let mut values = vec![
        SqlValue::Text(request.window.after.clone()),
        SqlValue::Text(request.window.before.clone()),
    ];
    push_text_filter(
        &mut clauses,
        &mut values,
        "s.provider",
        &request.filters.providers,
    );
    push_blob_filter(
        &mut clauses,
        &mut values,
        "s.project_key",
        &request.filters.project_keys,
    )?;
    push_blob_filter(
        &mut clauses,
        &mut values,
        "s.session_key",
        &request.filters.session_keys,
    )?;
    if !request.filters.event_kinds.is_empty() && timestamp.contains("he.") {
        push_text_filter(
            &mut clauses,
            &mut values,
            "he.event_kind",
            &request.filters.event_kinds,
        );
    }
    if let Some(extra) = extra {
        clauses.push(extra.to_owned());
    }
    Ok((clauses.join(" AND "), values))
}

fn push_text_filter(
    clauses: &mut Vec<String>,
    values: &mut Vec<SqlValue>,
    column: &str,
    items: &[String],
) {
    if items.is_empty() {
        return;
    }
    clauses.push(format!("{column} IN ({})", placeholders(items.len())));
    values.extend(items.iter().cloned().map(SqlValue::Text));
}

fn push_blob_filter(
    clauses: &mut Vec<String>,
    values: &mut Vec<SqlValue>,
    column: &str,
    items: &[String],
) -> Result<(), QueryError> {
    if items.is_empty() {
        return Ok(());
    }
    clauses.push(format!("{column} IN ({})", placeholders(items.len())));
    for item in items {
        values.push(SqlValue::Blob(decode_key(item, column)?));
    }
    Ok(())
}

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(",")
}

fn validate_filter_values(values: &[String], label: &str, keys: bool) -> Result<(), QueryError> {
    if values.len() > MAX_FILTER_VALUES
        || values.iter().collect::<BTreeSet<_>>().len() != values.len()
    {
        return Err(invalid(format!(
            "{label} must contain at most 64 unique values"
        )));
    }
    for value in values {
        if value.is_empty() || (keys && !is_hex_key(value)) {
            return Err(invalid(format!("{label} contains an invalid value")));
        }
    }
    Ok(())
}

fn event_evidence(event_key: &str, revision: &str, payload_key: Option<&str>) -> Value {
    let mut evidence = json!({
        "kind":"event",
        "eventKey":event_key,
        "revision":revision,
    });
    if let Some(payload_key) = payload_key {
        evidence["payloadKey"] = json!(payload_key);
    }
    evidence
}

fn payload_references_for_events(
    connection: &Connection,
    event_revisions: &BTreeMap<String, String>,
) -> Result<BTreeMap<(String, String), Value>, QueryError> {
    let event_keys = event_revisions.keys().collect::<Vec<_>>();
    let mut result = BTreeMap::new();
    for chunk in event_keys.chunks(500) {
        let sql = format!(
            "SELECT lower(hex(event_key)),lower(hex(payload_key)),payload_kind,encoding,
                    byte_length,lower(hex(sha256)),completeness
             FROM history_payloads
             WHERE event_key IN ({})
             ORDER BY event_key,payload_kind,payload_key",
            placeholders(chunk.len())
        );
        let values = chunk
            .iter()
            .map(|key| decode_key(key, "eventKey").map(SqlValue::Blob))
            .collect::<Result<Vec<_>, _>>()?;
        let mut statement = connection.prepare(&sql).map_err(query_failed)?;
        let mut rows = statement
            .query(params_from_iter(values))
            .map_err(query_failed)?;
        while let Some(row) = rows.next().map_err(query_failed)? {
            let event_key: String = row.get(0).map_err(query_failed)?;
            let payload_key: String = row.get(1).map_err(query_failed)?;
            let payload_kind: String = row.get(2).map_err(query_failed)?;
            let revision = event_revisions.get(&event_key).ok_or_else(|| {
                QueryError::new("QUERY_FAILED", "stored payload event is inconsistent")
            })?;
            result.insert(
                (event_key.clone(), payload_kind),
                json!({
                    "byteLength": blob_u64(row.get(4).map_err(query_failed)?)
                        .map_err(query_failed)?.to_string(),
                    "sha256": row.get::<_, String>(5).map_err(query_failed)?,
                    "encoding": row.get::<_, String>(3).map_err(query_failed)?,
                    "inline": null,
                    "reference": {
                        "kind": "event",
                        "eventKey": event_key,
                        "revision": revision,
                        "payloadKey": payload_key,
                    },
                    "complete": row.get::<_, String>(6).map_err(query_failed)? == "full",
                }),
            );
        }
    }
    Ok(result)
}

fn payload_for_kind(
    payloads: &BTreeMap<(String, String), Value>,
    event_key: &str,
    payload_kind: &str,
) -> Option<Value> {
    payloads
        .get(&(event_key.to_owned(), payload_kind.to_owned()))
        .cloned()
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
            "recipe requires a completed Fact V2 shadow rebuild with deep-query-coverage@3",
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

fn nonnegative_u64(value: i64) -> rusqlite::Result<u64> {
    u64::try_from(value).map_err(|_| rusqlite::Error::IntegralValueOutOfRange(0, value))
}

fn nonnegative_json(value: i64) -> rusqlite::Result<String> {
    Ok(nonnegative_u64(value)?.to_string())
}

fn nonnegative_count(value: i64) -> Result<String, QueryError> {
    u64::try_from(value)
        .map(|value| value.to_string())
        .map_err(|_| QueryError::new("QUERY_FAILED", "stored count is invalid"))
}

fn parse_decimal_count(value: &str) -> Result<u64, QueryError> {
    value
        .parse::<u64>()
        .map_err(|_| QueryError::new("QUERY_FAILED", "stored count is invalid"))
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

fn decimal_json(value: Option<&Value>) -> u128 {
    value
        .and_then(Value::as_str)
        .and_then(|value| value.parse().ok())
        .unwrap_or(0)
}

fn decode_key(value: &str, label: &str) -> Result<Vec<u8>, QueryError> {
    if !is_hex_key(value) {
        return Err(invalid(format!(
            "{label} must be a lowercase 32-byte hex key"
        )));
    }
    hex::decode(value).map_err(|_| invalid(format!("{label} is invalid")))
}

fn is_hex_key(value: &str) -> bool {
    value.len() == 64
        && value
            .bytes()
            .all(|byte| byte.is_ascii_digit() || matches!(byte, b'a'..=b'f'))
}

fn invalid(message: impl Into<String>) -> QueryError {
    QueryError::new("TS_INSIGHTS_REQUEST_INVALID", message)
}

#[cfg(test)]
mod tests {
    use rusqlite::{Connection, params_from_iter};

    use super::{
        MAX_RECIPE_PAGE_BYTES, RecipeFilters, RecipeName, RecipeRequest, RecipeResponse,
        RecipeWindow, exact_activity_order_statement, failure_chain_summary_statement,
        file_workflow_summary_statement, fit_degraded_recipe_response,
        projected_activity_coverage_statement, projected_capability_cooccurrences_statement,
        projected_capability_representatives_statement, read_recipe_coverage, recipe_provenance,
        solution_recall_statement, truncate_recipe_details,
    };

    #[test]
    fn degraded_recipe_details_keep_a_ranked_prefix_within_the_byte_budget() {
        let first = serde_json::json!({"eventKey":"first"});
        let first_bytes = crate::try_canonical_json(&first).unwrap().len();
        let mut items = vec![
            serde_json::json!({"attempts":[first, {"eventKey":"second"}]}),
            serde_json::json!({"attempts":[{"eventKey":"third"}]}),
        ];

        assert!(
            truncate_recipe_details(&mut items, RecipeName::FailureChains, first_bytes).unwrap()
        );
        assert_eq!(items[0]["attempts"].as_array().unwrap().len(), 1);
        assert_eq!(items[0]["attempts"][0]["eventKey"], "first");
        assert!(items[1]["attempts"].as_array().unwrap().is_empty());
    }

    #[test]
    fn degraded_recipe_response_marks_oversized_details_as_partial() {
        let connection = coverage_connection();
        let request = capability_contexts_request();
        let coverage = read_recipe_coverage(&connection, &request).unwrap();
        let mut response = RecipeResponse {
            format: super::RECIPE_RESPONSE_FORMAT.to_owned(),
            database_uuid: "00000000-0000-4000-8000-000000000000".to_owned(),
            snapshot_seq: "0".to_owned(),
            name: RecipeName::FailureChains,
            window: request.window,
            comparison_window: None,
            evaluated_at: request.evaluated_at,
            items: vec![
                serde_json::json!({"attempts":[{"payload":"x".repeat(MAX_RECIPE_PAGE_BYTES)}]}),
            ],
            total_item_count: "1".to_owned(),
            truncated: false,
            coverage,
            provenance: recipe_provenance(RecipeName::FailureChains),
        };

        fit_degraded_recipe_response(&mut response, true).unwrap();
        assert!(response.items[0]["attempts"].as_array().unwrap().is_empty());
        assert!(response.coverage.degraded);
        assert!(
            response
                .coverage
                .diagnostics
                .iter()
                .any(|diagnostic| { diagnostic == "TS_INSIGHTS_RECIPE_PARTIAL_COVERAGE" })
        );
        assert!(super::canonical_recipe_bytes(&response).unwrap() <= MAX_RECIPE_PAGE_BYTES);
    }

    fn solution_recall_request() -> RecipeRequest {
        RecipeRequest {
            format: super::RECIPE_REQUEST_FORMAT.to_owned(),
            name: RecipeName::SolutionRecall,
            window: RecipeWindow {
                after: "2026-01-01T00:00:00.000Z".to_owned(),
                before: "2026-01-02T00:00:00.000Z".to_owned(),
            },
            comparison_window: None,
            filters: RecipeFilters {
                session_keys: vec!["11".repeat(32)],
                text: Some("benchmark retry error".to_owned()),
                ..RecipeFilters::default()
            },
            limit: 10,
            allow_degraded: false,
            evaluated_at: "2026-01-02T01:00:00.000Z".to_owned(),
        }
    }

    fn capability_contexts_request() -> RecipeRequest {
        RecipeRequest {
            format: super::RECIPE_REQUEST_FORMAT.to_owned(),
            name: RecipeName::CapabilityContexts,
            window: RecipeWindow {
                after: "2026-01-01T00:00:00.000Z".to_owned(),
                before: "2026-01-02T00:00:00.000Z".to_owned(),
            },
            comparison_window: None,
            filters: RecipeFilters {
                capability_keys: vec!["11".repeat(32)],
                ..RecipeFilters::default()
            },
            limit: 10,
            allow_degraded: false,
            evaluated_at: "2026-01-02T01:00:00.000Z".to_owned(),
        }
    }

    fn activity_request(name: RecipeName) -> RecipeRequest {
        RecipeRequest {
            format: super::RECIPE_REQUEST_FORMAT.to_owned(),
            name,
            window: RecipeWindow {
                after: "2026-01-01T00:00:00.000Z".to_owned(),
                before: "2026-01-03T00:00:00.000Z".to_owned(),
            },
            comparison_window: None,
            filters: RecipeFilters {
                bucket: (name == RecipeName::ActivityShifts).then_some(super::RecipeBucket::Day),
                ..RecipeFilters::default()
            },
            limit: 10,
            allow_degraded: false,
            evaluated_at: "2026-01-03T01:00:00.000Z".to_owned(),
        }
    }

    fn coverage_connection() -> Connection {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE engine_metadata (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL
                 ) WITHOUT ROWID;
                 INSERT INTO engine_metadata(key,value) VALUES
                   ('snapshot_seq','0'),
                   ('database_uuid','00000000-0000-4000-8000-000000000000');",
            )
            .unwrap();
        crate::normalized_repository::initialize_schema(&mut connection).unwrap();
        crate::source_state::initialize_schema(&connection).unwrap();
        connection
            .execute_batch("PRAGMA foreign_keys=OFF;")
            .unwrap();
        connection
            .execute(
                "INSERT INTO sessions(
                   session_key,provider,session_scope,eligibility,duplicate_policy_version
                 ) VALUES (?1,'codex','main','eligible',1)",
                [vec![0x11; 32]],
            )
            .unwrap();
        for (ordinal, observed, completeness, missing_revision, missing_token, missing_payload) in [
            (1_u8, "2026-01-01T01:00:00.000Z", "full", 0, 0, 0),
            (2_u8, "2026-01-01T02:00:00.000Z", "truncated", 1, 2, 1),
            (3_u8, "2026-01-02T01:00:00.000Z", "summary", 0, 0, 0),
        ] {
            connection
                .execute(
                    "INSERT INTO history_event_coverage(
                       event_key,session_id,event_kind,observed_timestamp,completeness,
                       missing_revision,missing_token_metric,missing_payload,
                       has_file_activity,has_token_usage
                     ) VALUES (?1,1,'provider-event',?2,?3,?4,?5,?6,0,0)",
                    rusqlite::params![
                        vec![ordinal; 32],
                        observed,
                        completeness,
                        missing_revision,
                        missing_token,
                        missing_payload
                    ],
                )
                .unwrap();
        }
        connection
            .execute_batch(
                "INSERT INTO history_event_day_coverage_rollups(
                   session_id,bucket_day,full_count,summary_count,unloaded_count,
                   truncated_count,unavailable_count,missing_revision_count,
                   missing_token_metric_count,missing_payload_count
                 ) VALUES
                   (1,'2026-01-01',1,0,0,1,0,1,2,1),
                   (1,'2026-01-02',0,1,0,0,0,0,0,0);",
            )
            .unwrap();
        connection
    }

    #[test]
    fn projected_activity_coverage_matches_exact_events_and_uses_day_index() {
        let connection = coverage_connection();
        let projected_request = activity_request(RecipeName::ActivityShifts);
        let exact_request = activity_request(RecipeName::SessionTimeline);
        let projected = read_recipe_coverage(&connection, &projected_request).unwrap();
        let exact = read_recipe_coverage(&connection, &exact_request).unwrap();
        assert_eq!(projected, exact);

        let (sql, values) = projected_activity_coverage_statement(&projected_request).unwrap();
        let details = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map(params_from_iter(values), |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            details.iter().any(|detail| {
                detail.contains("history_event_day_coverage_rollups_day")
                    || detail.contains("SEARCH rollup USING PRIMARY KEY")
            }),
            "projected Activity coverage must use a bounded rollup index: {details:?}"
        );
        assert!(
            details
                .iter()
                .all(|detail| !detail.contains("history_event_coverage"))
        );
    }

    #[test]
    fn exact_activity_order_uses_the_observed_time_index() {
        let connection = coverage_connection();
        let request = activity_request(RecipeName::ActivityShifts);
        let (sql, values) = exact_activity_order_statement(&request).unwrap();
        let details = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map(params_from_iter(values), |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            details
                .iter()
                .any(|detail| detail.contains("history_events_observed")),
            "exact Activity ordering must be a bounded time-index scan: {details:?}"
        );
        assert!(
            details
                .iter()
                .all(|detail| !detail.contains("USE TEMP B-TREE FOR ORDER BY")),
            "the time index must satisfy the event ordering: {details:?}"
        );
    }

    #[test]
    fn projected_capability_details_use_capability_first_indexes() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE engine_metadata (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL
                 ) WITHOUT ROWID;
                 INSERT INTO engine_metadata(key,value) VALUES
                   ('snapshot_seq','0'),
                   ('database_uuid','00000000-0000-4000-8000-000000000000');",
            )
            .unwrap();
        crate::normalized_repository::initialize_schema(&mut connection).unwrap();
        crate::source_state::initialize_schema(&connection).unwrap();
        let request = capability_contexts_request();
        for (statement, expected_index, forbidden_scan) in [
            (
                projected_capability_representatives_statement(&request).unwrap(),
                "history_capability_representatives_capability_day",
                "SCAN representative",
            ),
            (
                projected_capability_cooccurrences_statement(&request).unwrap(),
                "history_capability_cooccurrences_capability_day",
                "SCAN cooccurrence",
            ),
        ] {
            let (sql, values) = statement;
            let mut statement = connection
                .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
                .unwrap();
            let details = statement
                .query_map(params_from_iter(values), |row| row.get::<_, String>(3))
                .unwrap()
                .collect::<Result<Vec<_>, _>>()
                .unwrap();
            assert!(
                details.iter().any(|detail| detail.contains(expected_index)),
                "projected capability detail must use {expected_index}: {details:?}"
            );
            assert!(
                details
                    .iter()
                    .all(|detail| !detail.contains(forbidden_scan)),
                "projected capability detail must not scan the rollup: {details:?}"
            );
        }
    }

    #[test]
    fn failure_chain_summary_uses_the_bounded_session_plan_when_scoped() {
        let connection = coverage_connection();
        let mut request = activity_request(RecipeName::FailureChains);
        request.filters.session_keys = vec!["11".repeat(32)];
        let (sql, values) = failure_chain_summary_statement(&request).unwrap();
        let details = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map(params_from_iter(values), |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(
            details
                .iter()
                .any(|detail| detail.contains("attempt_chain_events_correlation")),
            "session-scoped failure chains must start from the bounded chain index: {details:?}"
        );
        assert!(
            details
                .iter()
                .all(|detail| !detail.contains("history_events_observed")),
            "session-scoped failure chains must not scan the global time index: {details:?}"
        );

        request.filters.session_keys.clear();
        let (sql, values) = failure_chain_summary_statement(&request).unwrap();
        let global_details = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map(params_from_iter(values), |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            global_details
                .iter()
                .any(|detail| detail.contains("history_events_observed")),
            "global failure chains must retain the bounded time-index scan: {global_details:?}"
        );
    }

    #[test]
    fn file_workflow_summary_uses_the_bounded_session_plan_when_scoped() {
        let connection = coverage_connection();
        let mut request = activity_request(RecipeName::FileWorkflowSignals);
        request.filters.session_keys = vec!["11".repeat(32)];
        let (sql, values) = file_workflow_summary_statement(&request).unwrap();
        let details = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map(params_from_iter(values), |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(
            details
                .iter()
                .any(|detail| detail.contains("history_events_session_order")),
            "session-scoped file workflows must start from the bounded event index: {details:?}"
        );
        assert!(
            details
                .iter()
                .all(|detail| !detail.contains("file_activity_observed")),
            "session-scoped file workflows must not scan the global time index: {details:?}"
        );

        request.filters.session_keys.clear();
        let (sql, values) = file_workflow_summary_statement(&request).unwrap();
        let global_details = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap()
            .query_map(params_from_iter(values), |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();
        assert!(
            global_details
                .iter()
                .any(|detail| detail.contains("file_activity_observed")),
            "global file workflows must retain the bounded time-index scan: {global_details:?}"
        );
    }

    #[test]
    fn solution_recall_constrains_history_fts_by_rowid_and_match() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE engine_metadata (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL
                 ) WITHOUT ROWID;
                 INSERT INTO engine_metadata(key,value) VALUES
                   ('snapshot_seq','0'),
                   ('database_uuid','00000000-0000-4000-8000-000000000000');",
            )
            .unwrap();
        crate::normalized_repository::initialize_schema(&mut connection).unwrap();
        crate::source_state::initialize_schema(&connection).unwrap();
        let request = solution_recall_request();
        request.validate().unwrap();
        let (sql, values) = solution_recall_statement(&request).unwrap();
        let mut statement = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap();
        let details = statement
            .query_map(params_from_iter(values), |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(
            details
                .iter()
                .any(|detail| { detail.contains("history_event_fts VIRTUAL TABLE INDEX 0:=M1") }),
            "solution recall must combine the rowid and MATCH constraints: {details:?}"
        );
    }

    #[test]
    fn global_solution_recall_starts_from_the_fts_match() {
        let mut connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch(
                "CREATE TABLE engine_metadata (
                   key TEXT PRIMARY KEY,
                   value TEXT NOT NULL
                 ) WITHOUT ROWID;
                 INSERT INTO engine_metadata(key,value) VALUES
                   ('snapshot_seq','0'),
                   ('database_uuid','00000000-0000-4000-8000-000000000000');",
            )
            .unwrap();
        crate::normalized_repository::initialize_schema(&mut connection).unwrap();
        crate::source_state::initialize_schema(&connection).unwrap();
        let mut request = solution_recall_request();
        request.filters.session_keys.clear();
        request.validate().unwrap();
        let (sql, values) = solution_recall_statement(&request).unwrap();
        let mut statement = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap();
        let details = statement
            .query_map(params_from_iter(values), |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        let fts_steps = details
            .iter()
            .filter(|detail| detail.contains("history_event_fts VIRTUAL TABLE"))
            .collect::<Vec<_>>();
        assert_eq!(
            fts_steps.len(),
            1,
            "global solution recall must execute one FTS query: {details:?}"
        );
        assert!(
            fts_steps[0].contains("INDEX 0:M1"),
            "global solution recall must start from the FTS match: {details:?}"
        );
    }
}
