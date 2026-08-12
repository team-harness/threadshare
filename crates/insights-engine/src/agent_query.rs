//! Capability-usage and activity aggregates over the same Turn universe Search reads.
//!
//! Both readers answer questions about *how much* rather than *which*, so neither can lean on a
//! bounded candidate pool the way ranked search does. Instead they aggregate in SQL over an
//! explicitly bounded window and report what the window had to exclude.

use rusqlite::{Connection, params_from_iter, types::Value};
use serde::{Deserialize, Serialize};
use std::collections::{BTreeMap, BTreeSet};

use crate::evidence_path::DedupeConfidence;
use crate::fact_model::{CapabilityKind, CapabilityTerminalState};
use crate::query::{
    ClosureFilter, QueryError, SqlParameters, closure_text, hard_sealed_sql, query_failed,
    read_group_confidences, sorted_unique_closure_filters, sorted_unique_terminal_states,
    stable_key_values, strictly_sorted, terminal_state_text, valid_stable_key,
};
use crate::retry_projection::active_retry_summaries;

/// One enrichable page: phase two reads detail for every selected row, so the page has to stay
/// small enough that the detail queries remain a handful of bounded `IN` lookups.
pub const MAX_USAGE_ITEMS: u16 = 50;
/// Matches the Search retention horizon, and caps Activity at one bucket per day for a year.
pub const MAX_ACTIVITY_BUCKETS: u32 = 366;
const MAX_PROJECT_KEYS: usize = 64;
pub const DAY_MS: u64 = 86_400_000;
pub const WEEK_MS: u64 = 7 * DAY_MS;
const INVALID: &str = "TS_INSIGHTS_REQUEST_INVALID";

fn placeholders(count: usize) -> String {
    std::iter::repeat_n("?", count)
        .collect::<Vec<_>>()
        .join(",")
}

fn stored_u64(value: Vec<u8>) -> Result<u64, QueryError> {
    value
        .try_into()
        .map(u64::from_be_bytes)
        .map_err(|_| QueryError::new("QUERY_FAILED", "stored uint64 is invalid"))
}

// ---------------------------------------------------------------------------
// Canonical timestamps
// ---------------------------------------------------------------------------

/// Fixed-width RFC3339 millisecond UTC, so lexicographic order is chronological order and range
/// predicates stay sargable against the stored `turns.observed_timestamp` text.
const TIMESTAMP_LEN: usize = 24;

fn invalid(message: impl Into<String>) -> QueryError {
    QueryError::new(INVALID, message)
}

/// Howard Hinnant's civil-from-days pair, inlined to keep the engine free of a date dependency.
fn days_from_civil(year: i64, month: i64, day: i64) -> i64 {
    let year = year - i64::from(month <= 2);
    let era = if year >= 0 { year } else { year - 399 } / 400;
    let year_of_era = year - era * 400;
    let day_of_year = (153 * (month + if month > 2 { -3 } else { 9 }) + 2) / 5 + day - 1;
    let day_of_era = year_of_era * 365 + year_of_era / 4 - year_of_era / 100 + day_of_year;
    era * 146_097 + day_of_era - 719_468
}

fn civil_from_days(days: i64) -> (i64, i64, i64) {
    let days = days + 719_468;
    let era = if days >= 0 { days } else { days - 146_096 } / 146_097;
    let day_of_era = days - era * 146_097;
    let year_of_era =
        (day_of_era - day_of_era / 1_460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let year = year_of_era + era * 400;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_position = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_position + 2) / 5 + 1;
    let month = month_position + if month_position < 10 { 3 } else { -9 };
    (year + i64::from(month <= 2), month, day)
}

fn days_in_month(year: i64, month: i64) -> i64 {
    match month {
        1 | 3 | 5 | 7 | 8 | 10 | 12 => 31,
        4 | 6 | 9 | 11 => 30,
        2 if (year % 4 == 0 && year % 100 != 0) || year % 400 == 0 => 29,
        2 => 28,
        _ => 0,
    }
}

/// Renders Unix milliseconds as the canonical wire timestamp.
pub(crate) fn canonical_timestamp(unix_ms: u64) -> Result<String, QueryError> {
    let unix_ms = i64::try_from(unix_ms)
        .map_err(|_| invalid("timestamps must fit signed 64-bit Unix milliseconds"))?;
    let days = unix_ms.div_euclid(DAY_MS as i64);
    let within_day = unix_ms.rem_euclid(DAY_MS as i64);
    let (year, month, day) = civil_from_days(days);
    if !(0..=9999).contains(&year) {
        return Err(invalid("timestamps must fall inside year 0000-9999"));
    }
    Ok(format!(
        "{year:04}-{month:02}-{day:02}T{:02}:{:02}:{:02}.{:03}Z",
        within_day / 3_600_000,
        (within_day / 60_000) % 60,
        (within_day / 1_000) % 60,
        within_day % 1_000,
    ))
}

/// Accepts only the exact canonical spelling: anything looser would make two spellings of one
/// instant compare unequal as text, which is the property the sargable range filter relies on.
pub(crate) fn parse_canonical_timestamp(value: &str, label: &str) -> Result<u64, QueryError> {
    let malformed = || {
        invalid(format!(
            "{label} must be canonical RFC3339 UTC milliseconds"
        ))
    };
    let bytes = value.as_bytes();
    if bytes.len() != TIMESTAMP_LEN {
        return Err(malformed());
    }
    for (index, expected) in [
        (4, b'-'),
        (7, b'-'),
        (10, b'T'),
        (13, b':'),
        (16, b':'),
        (19, b'.'),
        (23, b'Z'),
    ] {
        if bytes[index] != expected {
            return Err(malformed());
        }
    }
    let digits = |range: std::ops::Range<usize>| -> Result<i64, QueryError> {
        let slice = &value[range];
        if !slice.bytes().all(|byte| byte.is_ascii_digit()) {
            return Err(malformed());
        }
        slice.parse::<i64>().map_err(|_| malformed())
    };
    let year = digits(0..4)?;
    let month = digits(5..7)?;
    let day = digits(8..10)?;
    let hour = digits(11..13)?;
    let minute = digits(14..16)?;
    let second = digits(17..19)?;
    let millisecond = digits(20..23)?;
    if !(1..=12).contains(&month)
        || day < 1
        || day > days_in_month(year, month)
        || hour > 23
        || minute > 59
        || second > 59
    {
        return Err(malformed());
    }
    let total = days_from_civil(year, month, day) * DAY_MS as i64
        + hour * 3_600_000
        + minute * 60_000
        + second * 1_000
        + millisecond;
    u64::try_from(total).map_err(|_| malformed())
}

/// 1970-01-01 was a Thursday, so shifting by 4 puts Monday at 0.
fn is_iso_week_start(unix_ms: u64) -> bool {
    unix_ms.is_multiple_of(DAY_MS) && ((unix_ms / DAY_MS) + 3).is_multiple_of(7)
}

// ---------------------------------------------------------------------------
// Shared coverage
// ---------------------------------------------------------------------------

/// What the universe had to drop. The categories overlap by construction — one Turn can be both
/// undated and unrevisioned — so they are reported separately rather than summed.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct QueryCoverage {
    pub excluded_undated_invocation_count: String,
    pub excluded_undated_turn_count: String,
    pub excluded_unrevisioned_invocation_count: String,
    pub excluded_unrevisioned_turn_count: String,
    /// Only meaningful for capability-shaped readers: capabilities left with no eligible use at all.
    pub fully_excluded_capability_count: String,
}

// ---------------------------------------------------------------------------
// Usage request
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageWindow {
    pub observed_at_or_after_unix_ms: u64,
    pub observed_before_unix_ms: u64,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum UsageOrderBy {
    #[default]
    RecordedInvocationCount,
    RecordedFailingInvocationCount,
    DistinctTurnCount,
    DistinctSessionCount,
    DistinctDedupeGroupCount,
    #[serde(rename = "last-used")]
    LastUsedAt,
    AbsoluteRecordedInvocationChange,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRequest {
    pub kind: CapabilityKind,
    pub window: UsageWindow,
    pub comparison_window: Option<UsageWindow>,
    #[serde(default)]
    pub providers: Vec<String>,
    #[serde(default)]
    pub project_keys: Vec<String>,
    #[serde(default)]
    pub closure_states: Vec<ClosureFilter>,
    #[serde(default)]
    pub capability_terminal_states: Vec<CapabilityTerminalState>,
    pub order_by: UsageOrderBy,
    pub cursor: Option<String>,
    pub limit: u16,
    pub now_unix_ms: u64,
    pub quiescence_seconds: u32,
}

impl Default for UsageRequest {
    fn default() -> Self {
        Self {
            kind: CapabilityKind::Tool,
            window: UsageWindow::default(),
            comparison_window: None,
            providers: Vec::new(),
            project_keys: Vec::new(),
            closure_states: Vec::new(),
            capability_terminal_states: Vec::new(),
            order_by: UsageOrderBy::RecordedInvocationCount,
            cursor: None,
            limit: MAX_USAGE_ITEMS,
            now_unix_ms: 0,
            quiescence_seconds: 300,
        }
    }
}

fn validate_window(window: &UsageWindow, label: &str) -> Result<(), QueryError> {
    if window.observed_at_or_after_unix_ms >= window.observed_before_unix_ms {
        return Err(invalid(format!(
            "{label} must be a non-empty half-open range"
        )));
    }
    if window.observed_before_unix_ms > i64::MAX as u64 {
        return Err(invalid(format!(
            "{label} must fit signed 64-bit Unix milliseconds"
        )));
    }
    Ok(())
}

fn validate_shared_filters(
    providers: &[String],
    project_keys: &[String],
    closure_states: &[ClosureFilter],
    now_unix_ms: u64,
    quiescence_seconds: u32,
) -> Result<(), QueryError> {
    if providers.len() > 16 || !strictly_sorted(providers.iter()) {
        return Err(invalid("providers must be sorted unique values"));
    }
    if project_keys.len() > MAX_PROJECT_KEYS || !strictly_sorted(project_keys.iter()) {
        return Err(invalid(
            "projectKeys must contain at most 64 sorted unique values",
        ));
    }
    if project_keys.iter().any(|key| !valid_stable_key(key)) {
        return Err(invalid("projectKeys must be lowercase 64-hex stable keys"));
    }
    if !sorted_unique_closure_filters(closure_states) {
        return Err(invalid(
            "closureStates must contain at most 3 sorted unique values",
        ));
    }
    if now_unix_ms > i64::MAX as u64 {
        return Err(invalid(
            "nowUnixMs must fit signed 64-bit Unix milliseconds",
        ));
    }
    if !(60..=86_400).contains(&quiescence_seconds) {
        return Err(invalid("quiescenceSeconds must be in 60..=86400"));
    }
    Ok(())
}

impl UsageRequest {
    pub fn validate(&self) -> Result<(), QueryError> {
        if !(1..=MAX_USAGE_ITEMS).contains(&self.limit) {
            return Err(invalid(format!("limit must be in 1..={MAX_USAGE_ITEMS}")));
        }
        validate_window(&self.window, "window")?;
        if let Some(comparison) = &self.comparison_window {
            validate_window(comparison, "comparisonWindow")?;
        }
        if self.order_by == UsageOrderBy::AbsoluteRecordedInvocationChange
            && self.comparison_window.is_none()
        {
            return Err(invalid(
                "orderBy absolute-recorded-invocation-change requires comparisonWindow",
            ));
        }
        validate_shared_filters(
            &self.providers,
            &self.project_keys,
            &self.closure_states,
            self.now_unix_ms,
            self.quiescence_seconds,
        )?;
        if !sorted_unique_terminal_states(&self.capability_terminal_states) {
            return Err(invalid(
                "capabilityTerminalStates must contain at most 5 sorted unique values",
            ));
        }
        Ok(())
    }
}

// ---------------------------------------------------------------------------
// Usage response
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct InvocationTerminalCounts {
    pub invocation_total: String,
    pub pending: String,
    pub completed: String,
    pub failed: String,
    pub cancelled: String,
    pub unknown: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ContainingTurnOutcomeCounts {
    pub distinct_turn_total: String,
    pub provider_completed: String,
    pub abandoned: String,
    pub unknown: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionDuplicateMethodCounts {
    pub explicit_lineage: String,
    pub exact_first_turn_prefix: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct DedupeSupport {
    pub distinct_dedupe_group_count: String,
    pub strong_dedupe_group_count: String,
    pub weak_dedupe_group_count: String,
    pub observed_eof_provisional_group_count: String,
    pub unknown_dedupe_session_count: String,
    pub session_duplicate_method_counts: SessionDuplicateMethodCounts,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct StrengthCounts {
    pub observed: String,
    pub confirmed: String,
    pub inferred: String,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageRetrySummary {
    pub failed_count: String,
    pub same_input_repeat_count: String,
    pub retry_after_failure_count: String,
}

/// Retry evidence is deliberately not windowed: the projection counts across all indexed history,
/// and re-deriving it per window would need a schema this reader does not own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageOutOfWindow {
    pub scope: &'static str,
    pub retry_summary: Option<UsageRetrySummary>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageComparison {
    pub baseline_recorded_invocation_count: String,
    pub current_recorded_invocation_count: String,
    /// Signed decimal string: the delta can be negative and can exceed JS safe-integer range.
    pub absolute_recorded_invocation_change: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageItem {
    pub capability_key: String,
    pub provider: String,
    pub kind: CapabilityKind,
    pub canonical_name: String,
    pub recorded_invocation_count: String,
    pub recorded_failing_invocation_count: String,
    pub distinct_turn_count: String,
    pub distinct_session_count: String,
    pub last_used_at: Option<String>,
    pub invocation_terminal_counts: InvocationTerminalCounts,
    pub containing_turn_outcome_counts: ContainingTurnOutcomeCounts,
    pub grouped_invocation_count: String,
    pub ungrouped_invocation_count: String,
    pub support: DedupeSupport,
    pub strength_counts: StrengthCounts,
    pub out_of_window: UsageOutOfWindow,
    pub comparison: Option<UsageComparison>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct UsageResponse {
    pub snapshot_seq: String,
    /// Echoes the frozen clock the closure classifier ran at, because items were closure-filtered.
    pub closure_evaluated_at: String,
    pub quiescence_seconds: u32,
    pub items: Vec<UsageItem>,
    pub total_candidate_count: String,
    pub truncated: bool,
    pub next_cursor: Option<String>,
    pub coverage: QueryCoverage,
}

// ---------------------------------------------------------------------------
// Activity request
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityWindow {
    pub observed_at_or_after: String,
    pub observed_before: String,
}

#[derive(Debug, Clone, Copy, PartialEq, Eq, Default, Serialize, Deserialize)]
#[serde(rename_all = "kebab-case")]
pub enum ActivityBucket {
    #[default]
    Day,
    Week,
}

impl ActivityBucket {
    fn width_ms(self) -> u64 {
        match self {
            Self::Day => DAY_MS,
            Self::Week => WEEK_MS,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityRequest {
    pub window: ActivityWindow,
    #[serde(default)]
    pub providers: Vec<String>,
    #[serde(default)]
    pub project_keys: Vec<String>,
    #[serde(default)]
    pub closure_states: Vec<ClosureFilter>,
    pub bucket: ActivityBucket,
    pub time_zone: String,
    pub now_unix_ms: u64,
    pub quiescence_seconds: u32,
}

impl Default for ActivityRequest {
    fn default() -> Self {
        Self {
            window: ActivityWindow::default(),
            providers: Vec::new(),
            project_keys: Vec::new(),
            closure_states: Vec::new(),
            bucket: ActivityBucket::Day,
            time_zone: "UTC".to_owned(),
            now_unix_ms: 0,
            quiescence_seconds: 300,
        }
    }
}

/// The validated shape of an Activity window, so the reader never re-parses timestamps.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub struct ActivityBounds {
    pub after_unix_ms: u64,
    pub before_unix_ms: u64,
    pub width_ms: u64,
    pub bucket_count: u32,
}

impl ActivityRequest {
    pub fn validate(&self) -> Result<(), QueryError> {
        self.bounds().map(|_| ())
    }

    /// Buckets are aligned UTC calendar spans, so both bounds must already sit on a boundary;
    /// snapping them for the caller would silently answer a different question than they asked.
    pub fn bounds(&self) -> Result<ActivityBounds, QueryError> {
        if self.time_zone != "UTC" {
            return Err(invalid("timeZone must be UTC"));
        }
        validate_shared_filters(
            &self.providers,
            &self.project_keys,
            &self.closure_states,
            self.now_unix_ms,
            self.quiescence_seconds,
        )?;
        let after =
            parse_canonical_timestamp(&self.window.observed_at_or_after, "observedAtOrAfter")?;
        let before = parse_canonical_timestamp(&self.window.observed_before, "observedBefore")?;
        if after >= before {
            return Err(invalid("window must be a non-empty half-open range"));
        }
        let width = self.bucket.width_ms();
        let aligned = match self.bucket {
            ActivityBucket::Day => after % DAY_MS == 0 && before % DAY_MS == 0,
            ActivityBucket::Week => is_iso_week_start(after) && is_iso_week_start(before),
        };
        if !aligned {
            return Err(invalid(
                "window bounds must land on the requested bucket boundary",
            ));
        }
        let bucket_count = (before - after) / width;
        if bucket_count > u64::from(MAX_ACTIVITY_BUCKETS) {
            return Err(invalid(format!(
                "window must cover at most {MAX_ACTIVITY_BUCKETS} buckets"
            )));
        }
        Ok(ActivityBounds {
            after_unix_ms: after,
            before_unix_ms: before,
            width_ms: width,
            bucket_count: bucket_count as u32,
        })
    }
}

// ---------------------------------------------------------------------------
// Activity response
// ---------------------------------------------------------------------------

/// The runtime closure classification, identical to Search's — not the session dedupe closure.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ClosureCounts {
    pub hard_sealed: String,
    pub quiescent: String,
    pub open: String,
}

/// Turn-level result evidence, identical to Search's `resultEvidence` — not capability terminal
/// state, which lives on invocations and has a different set of values.
#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnResultEvidenceCounts {
    pub provider_completed: String,
    pub abandoned: String,
    pub unknown: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityBucketRow {
    pub bucket_start: String,
    pub bucket_end: String,
    pub distinct_session_count: String,
    pub distinct_turn_count: String,
    pub current_closure_counts: ClosureCounts,
    pub turn_result_evidence_counts: TurnResultEvidenceCounts,
    pub recorded_tool_invocation_count: String,
    pub recorded_skill_invocation_count: String,
    pub support: ActivitySupport,
}

#[derive(Debug, Clone, Default, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivitySupport {
    pub distinct_dedupe_group_count: String,
    pub strong_dedupe_group_count: String,
    pub weak_dedupe_group_count: String,
    pub observed_eof_provisional_group_count: String,
    pub unknown_dedupe_session_count: String,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct ActivityResponse {
    pub snapshot_seq: String,
    pub closure_evaluated_at: String,
    pub quiescence_seconds: u32,
    pub buckets: Vec<ActivityBucketRow>,
    pub coverage: QueryCoverage,
}

// ---------------------------------------------------------------------------
// Shared SQL fragments
// ---------------------------------------------------------------------------

const UNIVERSE: &str = "s.eligibility='eligible' AND s.session_scope='main' \
     AND t.effective_provider_visibility='active' \
     AND t.revision IS NOT NULL AND t.observed_timestamp IS NOT NULL \
     AND NOT EXISTS (SELECT 1 FROM source_purge_states purge \
                     WHERE purge.session_key=s.session_key)";

const RESULT_EVIDENCE: &str = "CASE t.provider_terminal WHEN 'completed' THEN 'provider-completed' \
     WHEN 'aborted' THEN 'abandoned' ELSE 'unknown' END";

const FROM_TURNS: &str = "FROM turns t \
     JOIN sessions s ON s.session_id=t.session_id \
     JOIN source_checkpoints sc ON sc.session_id=s.session_id";

const FROM_USES: &str = "FROM capability_uses u \
     JOIN capabilities c ON c.capability_id=u.capability_id \
     JOIN turns t ON t.turn_id=u.turn_id \
     JOIN sessions s ON s.session_id=t.session_id \
     JOIN source_checkpoints sc ON sc.session_id=s.session_id";

fn closure_expression(parameters: &mut SqlParameters, now_unix_ms: u64, seconds: u32) -> String {
    let threshold_ns = now_unix_ms
        .saturating_sub(u64::from(seconds) * 1_000)
        .saturating_mul(1_000_000);
    let threshold = parameters.bind(Value::Blob(threshold_ns.to_be_bytes().to_vec()));
    let hard = hard_sealed_sql();
    format!(
        "CASE WHEN {hard} THEN 'hard-sealed' \
         WHEN sc.eof_observed=1 AND sc.source_mtime_ns<={threshold} THEN 'quiescent' \
         ELSE 'open' END"
    )
}

fn push_shared_filters(
    filters: &mut Vec<String>,
    parameters: &mut SqlParameters,
    providers: &[String],
    project_keys: &[String],
    closure_states: &[ClosureFilter],
    closure: &str,
) -> Result<(), QueryError> {
    if !providers.is_empty() {
        let values = parameters.bind_list(providers.iter().cloned().map(Value::Text));
        filters.push(format!("s.provider IN ({values})"));
    }
    if !project_keys.is_empty() {
        let values = parameters.bind_list(stable_key_values(project_keys)?);
        filters.push(format!("s.project_key IN ({values})"));
    }
    if !closure_states.is_empty() {
        let values = parameters.bind_list(
            closure_states
                .iter()
                .map(|value| Value::Text(closure_text(*value).to_owned())),
        );
        filters.push(format!("({closure}) IN ({values})"));
    }
    Ok(())
}

fn window_filters(
    filters: &mut Vec<String>,
    parameters: &mut SqlParameters,
    after_unix_ms: u64,
    before_unix_ms: u64,
) -> Result<(), QueryError> {
    let after = parameters.bind(Value::Text(canonical_timestamp(after_unix_ms)?));
    let before = parameters.bind(Value::Text(canonical_timestamp(before_unix_ms)?));
    filters.push(format!("t.observed_timestamp>={after}"));
    filters.push(format!("t.observed_timestamp<{before}"));
    Ok(())
}

fn snapshot_seq(connection: &Connection) -> Result<String, QueryError> {
    connection
        .query_row(
            "SELECT value FROM engine_metadata WHERE key='snapshot_seq'",
            [],
            |row| row.get::<_, String>(0),
        )
        .map_err(query_failed)
}

fn decimal(value: i64) -> String {
    value.max(0).to_string()
}

// ---------------------------------------------------------------------------
// Coverage
// ---------------------------------------------------------------------------

/// Coverage describes what the *universe* dropped, so it is deliberately not window-filtered:
/// a Turn with no observed timestamp cannot be placed in a window in the first place.
pub(crate) fn read_coverage(
    connection: &Connection,
    kind: Option<CapabilityKind>,
) -> Result<QueryCoverage, QueryError> {
    let base = "s.eligibility='eligible' AND s.session_scope='main' \
         AND t.effective_provider_visibility='active' \
         AND NOT EXISTS (SELECT 1 FROM source_purge_states purge \
                         WHERE purge.session_key=s.session_key)";
    let (undated_turns, unrevisioned_turns, undated_uses, unrevisioned_uses) = match kind {
        Some(kind) => connection
            .query_row(
                &format!(
                    "SELECT COUNT(DISTINCT CASE WHEN t.observed_timestamp IS NULL THEN t.turn_id END),
                            COUNT(DISTINCT CASE WHEN t.revision IS NULL THEN t.turn_id END),
                            SUM(CASE WHEN t.observed_timestamp IS NULL THEN 1 ELSE 0 END),
                            SUM(CASE WHEN t.revision IS NULL THEN 1 ELSE 0 END)
                     {FROM_USES}
                     WHERE {base} AND u.origin_scope='main' AND c.capability_kind=?1"
                ),
                [capability_kind_text(kind)],
                |row| {
                    Ok((
                        row.get::<_, i64>(0)?,
                        row.get::<_, i64>(1)?,
                        row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                        row.get::<_, Option<i64>>(3)?.unwrap_or(0),
                    ))
                },
            )
            .map_err(query_failed)?,
        None => {
            connection
                .query_row(
                    "SELECT COALESCE(SUM(coverage.undated_turn_count),0),
                            COALESCE(SUM(coverage.unrevisioned_turn_count),0),
                            COALESCE(SUM(coverage.undated_invocation_count),0),
                            COALESCE(SUM(coverage.unrevisioned_invocation_count),0)
                     FROM history_query_session_coverage coverage
                     JOIN sessions s ON s.session_id=coverage.session_id
                     WHERE s.eligibility='eligible' AND s.session_scope='main'
                       AND NOT EXISTS (SELECT 1 FROM source_purge_states purge
                                       WHERE purge.session_key=s.session_key)",
                    [],
                    |row| Ok((row.get(0)?, row.get(1)?, row.get(2)?, row.get(3)?)),
                )
                .map_err(query_failed)?
        }
    };
    let fully_excluded = match kind {
        None => 0,
        Some(kind) => connection
            .query_row(
                &format!(
                    "SELECT COUNT(*) FROM capabilities c
                     WHERE c.capability_kind=?1
                       AND EXISTS (SELECT 1 FROM capability_uses u WHERE u.capability_id=c.capability_id)
                       AND NOT EXISTS (
                         SELECT 1 FROM capability_uses u
                         JOIN turns t ON t.turn_id=u.turn_id
                         JOIN sessions s ON s.session_id=t.session_id
                         WHERE u.capability_id=c.capability_id AND u.origin_scope='main'
                           AND {base} AND t.revision IS NOT NULL
                           AND t.observed_timestamp IS NOT NULL)"
                ),
                [capability_kind_text(kind)],
                |row| row.get::<_, i64>(0),
            )
            .map_err(query_failed)?,
    };
    Ok(QueryCoverage {
        excluded_undated_invocation_count: decimal(undated_uses),
        excluded_undated_turn_count: decimal(undated_turns),
        excluded_unrevisioned_invocation_count: decimal(unrevisioned_uses),
        excluded_unrevisioned_turn_count: decimal(unrevisioned_turns),
        fully_excluded_capability_count: decimal(fully_excluded),
    })
}

pub(crate) fn capability_kind_text(kind: CapabilityKind) -> &'static str {
    match kind {
        CapabilityKind::Tool => "tool",
        CapabilityKind::Skill => "skill",
    }
}

// ---------------------------------------------------------------------------
// Usage reader
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct UsageSelection {
    provider: String,
    canonical_name: String,
    metric: i64,
    distinct_turns: i64,
    distinct_sessions: i64,
    last_used: Option<String>,
}

#[derive(Debug, Clone)]
struct UsageCandidate {
    capability_id: i64,
    capability_key: String,
    current: UsageSelection,
    baseline: UsageSelection,
}

impl UsageCandidate {
    /// The metric plus enough tie-breaks to make the page boundary reproducible.
    fn sort_key(&self, order_by: UsageOrderBy) -> (i128, String, i64, i64, String, String) {
        let metric = match order_by {
            UsageOrderBy::AbsoluteRecordedInvocationChange => {
                (i128::from(self.current.metric) - i128::from(self.baseline.metric)).abs()
            }
            _ => i128::from(self.current.metric),
        };
        let metric_text = match order_by {
            UsageOrderBy::LastUsedAt => self.current.last_used.clone().unwrap_or_default(),
            _ => String::new(),
        };
        (
            metric,
            metric_text,
            self.current.distinct_turns,
            self.current.distinct_sessions,
            self.current.last_used.clone().unwrap_or_default(),
            self.capability_key.clone(),
        )
    }
}

fn usage_selection_metric(order_by: UsageOrderBy) -> &'static str {
    match order_by {
        UsageOrderBy::RecordedInvocationCount | UsageOrderBy::AbsoluteRecordedInvocationChange => {
            "COUNT(*)"
        }
        UsageOrderBy::RecordedFailingInvocationCount => {
            "SUM(CASE WHEN u.provider_terminal_state='failed' THEN 1 ELSE 0 END)"
        }
        UsageOrderBy::DistinctTurnCount => "COUNT(DISTINCT u.turn_id)",
        UsageOrderBy::DistinctSessionCount => "COUNT(DISTINCT s.session_id)",
        UsageOrderBy::DistinctDedupeGroupCount => "COUNT(DISTINCT s.duplicate_group_key)",
        UsageOrderBy::LastUsedAt => "0",
    }
}

fn usage_selection_query(
    request: &UsageRequest,
    window: UsageWindow,
) -> Result<(String, Vec<Value>), QueryError> {
    let mut parameters = SqlParameters::default();
    let closure = closure_expression(
        &mut parameters,
        request.now_unix_ms,
        request.quiescence_seconds,
    );
    let mut filters = vec![
        UNIVERSE.to_owned(),
        "u.origin_scope='main'".to_owned(),
        format!(
            "c.capability_kind={}",
            parameters.bind(Value::Text(capability_kind_text(request.kind).to_owned()))
        ),
    ];
    window_filters(
        &mut filters,
        &mut parameters,
        window.observed_at_or_after_unix_ms,
        window.observed_before_unix_ms,
    )?;
    push_shared_filters(
        &mut filters,
        &mut parameters,
        &request.providers,
        &request.project_keys,
        &request.closure_states,
        &closure,
    )?;
    if !request.capability_terminal_states.is_empty() {
        let values = parameters.bind_list(
            request
                .capability_terminal_states
                .iter()
                .map(|value| Value::Text(terminal_state_text(*value).to_owned())),
        );
        filters.push(format!(
            "COALESCE(u.provider_terminal_state,'unknown') IN ({values})"
        ));
    }
    let metric = usage_selection_metric(request.order_by);
    Ok((
        format!(
            "SELECT u.capability_id, lower(hex(c.capability_key)),
                c.provider, c.canonical_name,
                {metric},
                COUNT(DISTINCT u.turn_id),
                COUNT(DISTINCT s.session_id),
                MAX(t.observed_timestamp)
         {FROM_USES}
         WHERE {}
         GROUP BY u.capability_id",
            filters.join(" AND ")
        ),
        parameters.values,
    ))
}

fn read_usage_selections(
    connection: &Connection,
    request: &UsageRequest,
    window: UsageWindow,
) -> Result<BTreeMap<i64, (String, UsageSelection)>, QueryError> {
    let (sql, parameters) = usage_selection_query(request, window)?;
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let rows = statement
        .query_map(params_from_iter(parameters), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                UsageSelection {
                    provider: row.get(2)?,
                    canonical_name: row.get(3)?,
                    metric: row.get::<_, Option<i64>>(4)?.unwrap_or(0),
                    distinct_turns: row.get(5)?,
                    distinct_sessions: row.get(6)?,
                    last_used: row.get(7)?,
                },
            ))
        })
        .map_err(query_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(query_failed)?;
    Ok(rows
        .into_iter()
        .map(|(id, key, aggregate)| (id, (key, aggregate)))
        .collect())
}

/// Reads one page of capability usage.
///
/// Selection computes only the requested ordering metric and its stable tie-break tuple. Complete
/// counts are enriched only for the rows that survived the page cut.
pub fn read_capability_usage(
    connection: &Connection,
    request: &UsageRequest,
) -> Result<UsageResponse, QueryError> {
    request.validate()?;
    let closure_evaluated_at = canonical_timestamp(request.now_unix_ms)?;
    let transaction = connection.unchecked_transaction().map_err(query_failed)?;
    let snapshot = snapshot_seq(&transaction)?;

    let current = read_usage_selections(&transaction, request, request.window)?;
    let baseline = match request.comparison_window {
        Some(window) => read_usage_selections(&transaction, request, window)?,
        None => BTreeMap::new(),
    };
    // With a comparison window the candidate set is the union: a capability that vanished this
    // window is exactly the change a comparison is asked to surface.
    let mut candidates = current
        .keys()
        .chain(baseline.keys())
        .copied()
        .collect::<BTreeSet<_>>()
        .into_iter()
        .map(|capability_id| {
            let capability_key = current
                .get(&capability_id)
                .or_else(|| baseline.get(&capability_id))
                .map(|(key, _)| key.clone())
                .unwrap_or_default();
            UsageCandidate {
                capability_id,
                capability_key,
                current: current
                    .get(&capability_id)
                    .map(|(_, value)| value.clone())
                    .unwrap_or_default(),
                baseline: baseline
                    .get(&capability_id)
                    .map(|(_, value)| value.clone())
                    .unwrap_or_default(),
            }
        })
        .collect::<Vec<_>>();
    let order_by = request.order_by;
    candidates.sort_by(|left, right| {
        let (lm, lt, ldt, lds, ll, lk) = left.sort_key(order_by);
        let (rm, rt, rdt, rds, rl, rk) = right.sort_key(order_by);
        rm.cmp(&lm)
            .then_with(|| rt.cmp(&lt))
            .then_with(|| rdt.cmp(&ldt))
            .then_with(|| rds.cmp(&lds))
            .then_with(|| rl.cmp(&ll))
            .then_with(|| lk.cmp(&rk))
    });
    let total_candidate_count = candidates.len();
    if let Some(cursor) = &request.cursor {
        let after = decode_usage_cursor(cursor, &snapshot)?;
        let position = candidates
            .iter()
            .position(|candidate| candidate.capability_key == after)
            .ok_or_else(|| QueryError::new("TS_INSIGHTS_CURSOR_STALE", "Usage cursor is stale"))?;
        candidates.drain(..=position);
    }
    let truncated = candidates.len() > usize::from(request.limit);
    candidates.truncate(usize::from(request.limit));
    let next_cursor = truncated
        .then(|| {
            candidates
                .last()
                .map(|candidate| encode_usage_cursor(&snapshot, &candidate.capability_key))
        })
        .flatten();

    let items = enrich_usage_items(&transaction, request, &candidates)?;
    let coverage = read_coverage(&transaction, Some(request.kind))?;
    transaction.commit().map_err(query_failed)?;
    Ok(UsageResponse {
        snapshot_seq: snapshot,
        closure_evaluated_at,
        quiescence_seconds: request.quiescence_seconds,
        items,
        total_candidate_count: total_candidate_count.to_string(),
        truncated,
        next_cursor,
        coverage,
    })
}

fn encode_usage_cursor(snapshot: &str, capability_key: &str) -> String {
    hex::encode(format!("v1|{snapshot}|{capability_key}"))
}

fn decode_usage_cursor(cursor: &str, snapshot: &str) -> Result<String, QueryError> {
    let stale = || QueryError::new("TS_INSIGHTS_CURSOR_STALE", "Usage cursor is stale");
    let decoded = hex::decode(cursor).map_err(|_| stale())?;
    let decoded = String::from_utf8(decoded).map_err(|_| stale())?;
    let mut parts = decoded.splitn(3, '|');
    if parts.next() != Some("v1") || parts.next() != Some(snapshot) {
        return Err(stale());
    }
    parts.next().map(str::to_owned).ok_or_else(stale)
}

fn enrich_usage_items(
    connection: &Connection,
    request: &UsageRequest,
    candidates: &[UsageCandidate],
) -> Result<Vec<UsageItem>, QueryError> {
    if candidates.is_empty() {
        return Ok(Vec::new());
    }
    let ids = candidates
        .iter()
        .map(|candidate| candidate.capability_id)
        .collect::<Vec<_>>();
    let current_facts = read_usage_facts(connection, request, &ids, request.window)?;
    let baseline_facts = match request.comparison_window {
        Some(window) => read_usage_facts(connection, request, &ids, window)?,
        None => BTreeMap::new(),
    };
    let details = read_usage_details(connection, request, &ids)?;
    let outcomes = read_turn_outcomes(connection, request, &ids)?;
    let (group_members, unknown_sessions, provisional_groups, method_counts) =
        read_usage_support(connection, request, &ids)?;
    let all_groups = group_members
        .values()
        .flatten()
        .cloned()
        .collect::<BTreeSet<_>>();
    let confidences = read_group_confidences(connection, &all_groups)?;
    let retries = active_retry_summaries(connection)
        .map_err(|_| QueryError::new("QUERY_FAILED", "retry projection could not be read"))?
        .into_iter()
        .map(|summary| {
            (
                hex::encode(&summary.capability_key),
                UsageRetrySummary {
                    failed_count: summary.failed_count.to_string(),
                    same_input_repeat_count: summary.same_input_repeat_count.to_string(),
                    retry_after_failure_count: summary.retry_after_failure_count.to_string(),
                },
            )
        })
        .collect::<BTreeMap<_, _>>();

    let mut items = Vec::with_capacity(candidates.len());
    for candidate in candidates {
        let detail = details
            .get(&candidate.capability_id)
            .cloned()
            .unwrap_or_default();
        let outcome = outcomes
            .get(&candidate.capability_id)
            .copied()
            .unwrap_or_default();
        let groups = group_members
            .get(&candidate.capability_id)
            .cloned()
            .unwrap_or_default();
        let strong = groups
            .iter()
            .filter(|group| confidences.get(*group) == Some(&DedupeConfidence::Strong))
            .count() as i64;
        let methods = method_counts
            .get(&candidate.capability_id)
            .copied()
            .unwrap_or_default();
        let current = current_facts
            .get(&candidate.capability_id)
            .cloned()
            .unwrap_or_default();
        let baseline = baseline_facts
            .get(&candidate.capability_id)
            .cloned()
            .unwrap_or_default();
        let recorded = current.recorded;
        let identity = if candidate.current.canonical_name.is_empty() {
            &candidate.baseline
        } else {
            &candidate.current
        };
        items.push(UsageItem {
            capability_key: candidate.capability_key.clone(),
            provider: identity.provider.clone(),
            kind: request.kind,
            canonical_name: identity.canonical_name.clone(),
            recorded_invocation_count: decimal(recorded),
            recorded_failing_invocation_count: decimal(current.failing),
            distinct_turn_count: decimal(current.distinct_turns),
            distinct_session_count: decimal(current.distinct_sessions),
            last_used_at: current.last_used.clone(),
            invocation_terminal_counts: InvocationTerminalCounts {
                invocation_total: decimal(recorded),
                pending: decimal(detail.pending),
                completed: decimal(detail.completed),
                failed: decimal(detail.failed),
                cancelled: decimal(detail.cancelled),
                unknown: decimal(detail.unknown_state),
            },
            containing_turn_outcome_counts: ContainingTurnOutcomeCounts {
                distinct_turn_total: decimal(current.distinct_turns),
                provider_completed: decimal(outcome.0),
                abandoned: decimal(outcome.1),
                unknown: decimal(outcome.2),
            },
            grouped_invocation_count: decimal(detail.grouped),
            ungrouped_invocation_count: decimal(detail.ungrouped),
            support: DedupeSupport {
                distinct_dedupe_group_count: decimal(groups.len() as i64),
                strong_dedupe_group_count: decimal(strong),
                weak_dedupe_group_count: decimal(groups.len() as i64 - strong),
                observed_eof_provisional_group_count: decimal(
                    provisional_groups
                        .get(&candidate.capability_id)
                        .copied()
                        .unwrap_or(0),
                ),
                unknown_dedupe_session_count: decimal(
                    unknown_sessions
                        .get(&candidate.capability_id)
                        .copied()
                        .unwrap_or(0),
                ),
                session_duplicate_method_counts: SessionDuplicateMethodCounts {
                    explicit_lineage: decimal(methods.0),
                    exact_first_turn_prefix: decimal(methods.1),
                },
            },
            strength_counts: StrengthCounts {
                observed: decimal(detail.observed),
                confirmed: decimal(detail.confirmed),
                inferred: decimal(detail.inferred),
            },
            out_of_window: UsageOutOfWindow {
                scope: "all-indexed-history",
                retry_summary: retries.get(&candidate.capability_key).cloned(),
            },
            comparison: request.comparison_window.map(|_| UsageComparison {
                baseline_recorded_invocation_count: decimal(baseline.recorded),
                current_recorded_invocation_count: decimal(recorded),
                absolute_recorded_invocation_change: (i128::from(recorded)
                    - i128::from(baseline.recorded))
                .to_string(),
            }),
        });
    }
    Ok(items)
}

#[derive(Debug, Clone, Default)]
struct UsageDetail {
    pending: i64,
    completed: i64,
    failed: i64,
    cancelled: i64,
    unknown_state: i64,
    observed: i64,
    confirmed: i64,
    inferred: i64,
    grouped: i64,
    ungrouped: i64,
}

#[derive(Debug, Clone, Default)]
struct UsageFacts {
    recorded: i64,
    failing: i64,
    distinct_turns: i64,
    distinct_sessions: i64,
    last_used: Option<String>,
}

fn read_usage_facts(
    connection: &Connection,
    request: &UsageRequest,
    ids: &[i64],
    window: UsageWindow,
) -> Result<BTreeMap<i64, UsageFacts>, QueryError> {
    let mut parameters = SqlParameters::default();
    let scope = usage_scope_for_window(request, &mut parameters, ids, window)?;
    let sql = format!(
        "SELECT u.capability_id, COUNT(*),
                SUM(CASE WHEN u.provider_terminal_state='failed' THEN 1 ELSE 0 END),
                COUNT(DISTINCT u.turn_id), COUNT(DISTINCT s.session_id),
                MAX(t.observed_timestamp)
         {FROM_USES}
         WHERE {scope}
         GROUP BY u.capability_id"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let rows = statement
        .query_map(params_from_iter(parameters.values), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                UsageFacts {
                    recorded: row.get(1)?,
                    failing: row.get::<_, Option<i64>>(2)?.unwrap_or(0),
                    distinct_turns: row.get(3)?,
                    distinct_sessions: row.get(4)?,
                    last_used: row.get(5)?,
                },
            ))
        })
        .map_err(query_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(query_failed)?;
    Ok(rows.into_iter().collect())
}

/// Builds the same window/filter predicate the selection pass used, so enrichment can never
/// count an invocation the page cut did not.
fn usage_scope(
    request: &UsageRequest,
    parameters: &mut SqlParameters,
    ids: &[i64],
) -> Result<String, QueryError> {
    usage_scope_for_window(request, parameters, ids, request.window)
}

fn usage_scope_for_window(
    request: &UsageRequest,
    parameters: &mut SqlParameters,
    ids: &[i64],
    window: UsageWindow,
) -> Result<String, QueryError> {
    let closure = closure_expression(parameters, request.now_unix_ms, request.quiescence_seconds);
    let mut filters = vec![UNIVERSE.to_owned(), "u.origin_scope='main'".to_owned()];
    let id_values = parameters.bind_list(ids.iter().copied().map(Value::Integer));
    filters.push(format!("u.capability_id IN ({id_values})"));
    window_filters(
        &mut filters,
        parameters,
        window.observed_at_or_after_unix_ms,
        window.observed_before_unix_ms,
    )?;
    push_shared_filters(
        &mut filters,
        parameters,
        &request.providers,
        &request.project_keys,
        &request.closure_states,
        &closure,
    )?;
    if !request.capability_terminal_states.is_empty() {
        let values = parameters.bind_list(
            request
                .capability_terminal_states
                .iter()
                .map(|value| Value::Text(terminal_state_text(*value).to_owned())),
        );
        filters.push(format!(
            "COALESCE(u.provider_terminal_state,'unknown') IN ({values})"
        ));
    }
    Ok(filters.join(" AND "))
}

fn read_usage_details(
    connection: &Connection,
    request: &UsageRequest,
    ids: &[i64],
) -> Result<BTreeMap<i64, UsageDetail>, QueryError> {
    let mut parameters = SqlParameters::default();
    let scope = usage_scope(request, &mut parameters, ids)?;
    let state = "COALESCE(u.provider_terminal_state,'unknown')";
    let sql = format!(
        "SELECT u.capability_id,
                SUM(CASE WHEN {state}='pending' THEN 1 ELSE 0 END),
                SUM(CASE WHEN {state}='completed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN {state}='failed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN {state}='cancelled' THEN 1 ELSE 0 END),
                SUM(CASE WHEN {state} NOT IN ('pending','completed','failed','cancelled')
                         THEN 1 ELSE 0 END),
                SUM(CASE WHEN u.strength='observed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN u.strength='confirmed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN u.strength='inferred' THEN 1 ELSE 0 END),
                SUM(CASE WHEN s.duplicate_group_key IS NOT NULL THEN 1 ELSE 0 END),
                SUM(CASE WHEN s.duplicate_group_key IS NULL THEN 1 ELSE 0 END)
         {FROM_USES}
         WHERE {scope}
         GROUP BY u.capability_id"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let rows = statement
        .query_map(params_from_iter(parameters.values), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                UsageDetail {
                    pending: row.get(1)?,
                    completed: row.get(2)?,
                    failed: row.get(3)?,
                    cancelled: row.get(4)?,
                    unknown_state: row.get(5)?,
                    observed: row.get(6)?,
                    confirmed: row.get(7)?,
                    inferred: row.get(8)?,
                    grouped: row.get(9)?,
                    ungrouped: row.get(10)?,
                },
            ))
        })
        .map_err(query_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(query_failed)?;
    Ok(rows.into_iter().collect())
}

/// Counts distinct Turns per outcome, so a capability used twice in one Turn still contributes
/// one Turn to exactly one outcome bucket.
fn read_turn_outcomes(
    connection: &Connection,
    request: &UsageRequest,
    ids: &[i64],
) -> Result<BTreeMap<i64, (i64, i64, i64)>, QueryError> {
    let mut parameters = SqlParameters::default();
    let scope = usage_scope(request, &mut parameters, ids)?;
    let sql = format!(
        "SELECT capability_id,
                SUM(CASE WHEN evidence='provider-completed' THEN 1 ELSE 0 END),
                SUM(CASE WHEN evidence='abandoned' THEN 1 ELSE 0 END),
                SUM(CASE WHEN evidence='unknown' THEN 1 ELSE 0 END)
         FROM (SELECT DISTINCT u.capability_id AS capability_id, u.turn_id AS turn_id,
                      {RESULT_EVIDENCE} AS evidence
               {FROM_USES}
               WHERE {scope})
         GROUP BY capability_id"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let rows = statement
        .query_map(params_from_iter(parameters.values), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                (row.get(1)?, row.get(2)?, row.get(3)?),
            ))
        })
        .map_err(query_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(query_failed)?;
    Ok(rows.into_iter().collect())
}

type UsageSupport = (
    BTreeMap<i64, BTreeSet<String>>,
    BTreeMap<i64, i64>,
    BTreeMap<i64, i64>,
    BTreeMap<i64, (i64, i64)>,
);

fn read_usage_support(
    connection: &Connection,
    request: &UsageRequest,
    ids: &[i64],
) -> Result<UsageSupport, QueryError> {
    let mut parameters = SqlParameters::default();
    let scope = usage_scope(request, &mut parameters, ids)?;
    let sql = format!(
        "SELECT DISTINCT u.capability_id, lower(hex(s.duplicate_group_key)), s.session_id,
                s.dedupe_closure, s.duplicate_method
         {FROM_USES}
         WHERE {scope}"
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let rows = statement
        .query_map(params_from_iter(parameters.values), |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, Option<String>>(1)?,
                row.get::<_, i64>(2)?,
                row.get::<_, Option<String>>(3)?,
                row.get::<_, Option<String>>(4)?,
            ))
        })
        .map_err(query_failed)?
        .collect::<Result<Vec<_>, _>>()
        .map_err(query_failed)?;
    let mut groups: BTreeMap<i64, BTreeSet<String>> = BTreeMap::new();
    let mut unknown: BTreeMap<i64, BTreeSet<i64>> = BTreeMap::new();
    let mut provisional: BTreeMap<i64, BTreeSet<String>> = BTreeMap::new();
    let mut methods: BTreeMap<i64, (BTreeSet<i64>, BTreeSet<i64>)> = BTreeMap::new();
    for (capability_id, group, session_id, closure, method) in rows {
        match group.filter(|value| !value.is_empty()) {
            Some(group) => {
                if closure.as_deref() == Some("observed-eof")
                    && method.as_deref() == Some("exact-first-turn-prefix")
                {
                    provisional
                        .entry(capability_id)
                        .or_default()
                        .insert(group.clone());
                }
                groups.entry(capability_id).or_default().insert(group);
            }
            None => {
                unknown.entry(capability_id).or_default().insert(session_id);
            }
        }
        let entry = methods.entry(capability_id).or_default();
        match method.as_deref() {
            Some("explicit-lineage") => {
                entry.0.insert(session_id);
            }
            Some("exact-first-turn-prefix") => {
                entry.1.insert(session_id);
            }
            _ => {}
        }
    }
    Ok((
        groups,
        unknown
            .into_iter()
            .map(|(key, value)| (key, value.len() as i64))
            .collect(),
        provisional
            .into_iter()
            .map(|(key, value)| (key, value.len() as i64))
            .collect(),
        methods
            .into_iter()
            .map(|(key, value)| (key, (value.0.len() as i64, value.1.len() as i64)))
            .collect(),
    ))
}

// ---------------------------------------------------------------------------
// Activity reader
// ---------------------------------------------------------------------------

#[derive(Debug, Clone, Default)]
struct ActivityBucketAccumulator {
    distinct_sessions: i64,
    distinct_turns: i64,
    hard_sealed: i64,
    quiescent: i64,
    open: i64,
    provider_completed: i64,
    abandoned: i64,
    unknown: i64,
    tools: i64,
    skills: i64,
    groups: BTreeSet<String>,
    provisional_groups: BTreeSet<String>,
    unknown_sessions: BTreeSet<i64>,
}

/// Bucketing arithmetic runs on the millisecond offset from the aligned window start, so every
/// bucket is exactly `width_ms` wide and the WHERE clause stays a sargable text range.
fn bucket_expression(parameters: &mut SqlParameters, bounds: ActivityBounds) -> String {
    let after = parameters.bind(Value::Integer(bounds.after_unix_ms as i64));
    let width = parameters.bind(Value::Integer(bounds.width_ms as i64));
    format!(
        "((CAST(unixepoch(t.observed_timestamp,'subsec')*1000 AS INTEGER) - {after}) / {width})"
    )
}

fn activity_scope(
    request: &ActivityRequest,
    bounds: ActivityBounds,
    parameters: &mut SqlParameters,
) -> Result<(String, String), QueryError> {
    let closure = closure_expression(parameters, request.now_unix_ms, request.quiescence_seconds);
    let bucket = bucket_expression(parameters, bounds);
    let mut filters = vec![UNIVERSE.to_owned()];
    window_filters(
        &mut filters,
        parameters,
        bounds.after_unix_ms,
        bounds.before_unix_ms,
    )?;
    push_shared_filters(
        &mut filters,
        parameters,
        &request.providers,
        &request.project_keys,
        &request.closure_states,
        &closure,
    )?;
    Ok((filters.join(" AND "), format!("{closure}|{bucket}")))
}

/// Reads per-bucket activity over an aligned UTC window.
///
/// Turn-shaped and invocation-shaped counts are read in separate passes: joining capability uses
/// into the Turn aggregate would fan out and inflate every Turn-level count.
pub(crate) fn read_activity_buckets_in_snapshot(
    connection: &Connection,
    request: &ActivityRequest,
) -> Result<Vec<ActivityBucketRow>, QueryError> {
    if request.closure_states.is_empty() {
        return read_projected_activity_buckets(connection, request);
    }
    let bounds = request.bounds()?;
    let mut buckets: BTreeMap<i64, ActivityBucketAccumulator> = BTreeMap::new();

    {
        let mut parameters = SqlParameters::default();
        let (scope, combined) = activity_scope(request, bounds, &mut parameters)?;
        let (closure, bucket) = combined.split_once('|').expect("closure|bucket pair");
        let sql = format!(
            "SELECT {bucket} AS b,
                    COUNT(*),
                    COUNT(DISTINCT s.session_id),
                    SUM(CASE WHEN ({closure})='hard-sealed' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN ({closure})='quiescent' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN ({closure})='open' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN ({RESULT_EVIDENCE})='provider-completed' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN ({RESULT_EVIDENCE})='abandoned' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN ({RESULT_EVIDENCE})='unknown' THEN 1 ELSE 0 END)
             {FROM_TURNS}
             WHERE {scope}
             GROUP BY b"
        );
        let mut statement = connection.prepare(&sql).map_err(query_failed)?;
        let rows = statement
            .query_map(params_from_iter(parameters.values), |row| {
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
            .map_err(query_failed)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(query_failed)?;
        for row in rows {
            let entry = buckets.entry(row.0).or_default();
            entry.distinct_turns = row.1;
            entry.distinct_sessions = row.2;
            entry.hard_sealed = row.3;
            entry.quiescent = row.4;
            entry.open = row.5;
            entry.provider_completed = row.6;
            entry.abandoned = row.7;
            entry.unknown = row.8;
        }
    }

    {
        let mut parameters = SqlParameters::default();
        let (scope, combined) = activity_scope(request, bounds, &mut parameters)?;
        let bucket = combined.split_once('|').expect("closure|bucket pair").1;
        let sql = format!(
            "SELECT {bucket} AS b,
                    SUM(CASE WHEN c.capability_kind='tool' THEN 1 ELSE 0 END),
                    SUM(CASE WHEN c.capability_kind='skill' THEN 1 ELSE 0 END)
             {FROM_USES}
             WHERE {scope} AND u.origin_scope='main'
             GROUP BY b"
        );
        let mut statement = connection.prepare(&sql).map_err(query_failed)?;
        let rows = statement
            .query_map(params_from_iter(parameters.values), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, i64>(1)?,
                    row.get::<_, i64>(2)?,
                ))
            })
            .map_err(query_failed)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(query_failed)?;
        for (bucket_index, tools, skills) in rows {
            let entry = buckets.entry(bucket_index).or_default();
            entry.tools = tools;
            entry.skills = skills;
        }
    }

    {
        let mut parameters = SqlParameters::default();
        let (scope, combined) = activity_scope(request, bounds, &mut parameters)?;
        let bucket = combined.split_once('|').expect("closure|bucket pair").1;
        let sql = format!(
            "SELECT DISTINCT {bucket} AS b, lower(hex(s.duplicate_group_key)), s.session_id,
                    s.dedupe_closure, s.duplicate_method
             {FROM_TURNS}
             WHERE {scope}"
        );
        let mut statement = connection.prepare(&sql).map_err(query_failed)?;
        let rows = statement
            .query_map(params_from_iter(parameters.values), |row| {
                Ok((
                    row.get::<_, i64>(0)?,
                    row.get::<_, Option<String>>(1)?,
                    row.get::<_, i64>(2)?,
                    row.get::<_, Option<String>>(3)?,
                    row.get::<_, Option<String>>(4)?,
                ))
            })
            .map_err(query_failed)?
            .collect::<Result<Vec<_>, _>>()
            .map_err(query_failed)?;
        for (bucket_index, group, session_id, closure, method) in rows {
            let entry = buckets.entry(bucket_index).or_default();
            match group.filter(|value| !value.is_empty()) {
                Some(group) => {
                    if closure.as_deref() == Some("observed-eof")
                        && method.as_deref() == Some("exact-first-turn-prefix")
                    {
                        entry.provisional_groups.insert(group.clone());
                    }
                    entry.groups.insert(group);
                }
                None => {
                    entry.unknown_sessions.insert(session_id);
                }
            }
        }
    }

    let all_groups = buckets
        .values()
        .flat_map(|entry| entry.groups.iter().cloned())
        .collect::<BTreeSet<_>>();
    let confidences = read_group_confidences(connection, &all_groups)?;

    // Emit every bucket in the window, including empty ones: a gap in the series would read as
    // "no data collected" rather than "no activity".
    (0..bounds.bucket_count)
        .map(|index| {
            let empty = ActivityBucketAccumulator::default();
            let entry = buckets.get(&i64::from(index)).unwrap_or(&empty);
            let start = bounds.after_unix_ms + u64::from(index) * bounds.width_ms;
            let strong = entry
                .groups
                .iter()
                .filter(|group| confidences.get(*group) == Some(&DedupeConfidence::Strong))
                .count() as i64;
            Ok(ActivityBucketRow {
                bucket_start: canonical_timestamp(start)?,
                bucket_end: canonical_timestamp(start + bounds.width_ms)?,
                distinct_session_count: decimal(entry.distinct_sessions),
                distinct_turn_count: decimal(entry.distinct_turns),
                current_closure_counts: ClosureCounts {
                    hard_sealed: decimal(entry.hard_sealed),
                    quiescent: decimal(entry.quiescent),
                    open: decimal(entry.open),
                },
                turn_result_evidence_counts: TurnResultEvidenceCounts {
                    provider_completed: decimal(entry.provider_completed),
                    abandoned: decimal(entry.abandoned),
                    unknown: decimal(entry.unknown),
                },
                recorded_tool_invocation_count: decimal(entry.tools),
                recorded_skill_invocation_count: decimal(entry.skills),
                support: ActivitySupport {
                    distinct_dedupe_group_count: decimal(entry.groups.len() as i64),
                    strong_dedupe_group_count: decimal(strong),
                    weak_dedupe_group_count: decimal(entry.groups.len() as i64 - strong),
                    observed_eof_provisional_group_count: decimal(
                        entry.provisional_groups.len() as i64
                    ),
                    unknown_dedupe_session_count: decimal(entry.unknown_sessions.len() as i64),
                },
            })
        })
        .collect::<Result<Vec<_>, QueryError>>()
}

fn read_projected_activity_buckets(
    connection: &Connection,
    request: &ActivityRequest,
) -> Result<Vec<ActivityBucketRow>, QueryError> {
    let bounds = request.bounds()?;
    let after = canonical_timestamp(bounds.after_unix_ms)?;
    let before = canonical_timestamp(bounds.before_unix_ms)?;
    let mut filters = vec![
        "rollup.first_observed_timestamp<?".to_owned(),
        "rollup.last_observed_timestamp>=?".to_owned(),
        "s.eligibility='eligible'".to_owned(),
        "s.session_scope='main'".to_owned(),
        "NOT EXISTS (SELECT 1 FROM source_purge_states purge WHERE purge.session_key=s.session_key)"
            .to_owned(),
    ];
    let mut values = vec![Value::Text(before.clone()), Value::Text(after.clone())];
    if !request.providers.is_empty() {
        filters.push(format!(
            "s.provider IN ({})",
            placeholders(request.providers.len())
        ));
        values.extend(request.providers.iter().cloned().map(Value::Text));
    }
    if !request.project_keys.is_empty() {
        filters.push(format!(
            "s.project_key IN ({})",
            placeholders(request.project_keys.len())
        ));
        values.extend(stable_key_values(&request.project_keys)?);
    }
    let sql = format!(
        "SELECT rollup.bucket_day,rollup.session_id,rollup.active_turn_count,
                rollup.hard_sealed_turn_count,rollup.provider_completed_turn_count,
                rollup.abandoned_turn_count,rollup.unknown_turn_count,
                rollup.tool_invocation_count,rollup.skill_invocation_count,
                lower(hex(s.duplicate_group_key)),s.dedupe_closure,s.duplicate_method,
                sc.eof_observed,sc.source_mtime_ns
         FROM history_activity_rollups rollup
         JOIN sessions s ON s.session_id=rollup.session_id
         JOIN source_checkpoints sc ON sc.session_id=rollup.session_id
         WHERE {} ORDER BY rollup.bucket_day,rollup.session_id",
        filters.join(" AND ")
    );
    let mut statement = connection.prepare(&sql).map_err(query_failed)?;
    let mut rows = statement
        .query(params_from_iter(values))
        .map_err(query_failed)?;
    let mut buckets = BTreeMap::<i64, ActivityBucketAccumulator>::new();
    let mut bucket_sessions = BTreeMap::<i64, BTreeSet<i64>>::new();
    while let Some(row) = rows.next().map_err(query_failed)? {
        let day = row.get::<_, String>(0).map_err(query_failed)?;
        let day_ms = parse_canonical_timestamp(&format!("{day}T00:00:00.000Z"), "bucket day")?;
        if day_ms < bounds.after_unix_ms || day_ms >= bounds.before_unix_ms {
            continue;
        }
        let bucket_index = i64::try_from((day_ms - bounds.after_unix_ms) / bounds.width_ms)
            .map_err(|_| QueryError::new("QUERY_FAILED", "activity bucket index is invalid"))?;
        let entry = buckets.entry(bucket_index).or_default();
        let session_id = row.get::<_, i64>(1).map_err(query_failed)?;
        bucket_sessions
            .entry(bucket_index)
            .or_default()
            .insert(session_id);
        entry.distinct_turns += row.get::<_, i64>(2).map_err(query_failed)?;
        let hard = row.get::<_, i64>(3).map_err(query_failed)?;
        entry.hard_sealed += hard;
        let non_hard = row
            .get::<_, i64>(2)
            .map_err(query_failed)?
            .checked_sub(hard)
            .ok_or_else(|| QueryError::new("QUERY_FAILED", "activity closure count is invalid"))?;
        let eof_observed = row.get::<_, i64>(12).map_err(query_failed)?;
        let threshold_ns = request
            .now_unix_ms
            .saturating_sub(u64::from(request.quiescence_seconds) * 1_000)
            .saturating_mul(1_000_000);
        let mtime_ns = stored_u64(row.get::<_, Vec<u8>>(13).map_err(query_failed)?)?;
        if eof_observed == 1 && mtime_ns <= threshold_ns {
            entry.quiescent += non_hard;
        } else {
            entry.open += non_hard;
        }
        entry.provider_completed += row.get::<_, i64>(4).map_err(query_failed)?;
        entry.abandoned += row.get::<_, i64>(5).map_err(query_failed)?;
        entry.unknown += row.get::<_, i64>(6).map_err(query_failed)?;
        entry.tools += row.get::<_, i64>(7).map_err(query_failed)?;
        entry.skills += row.get::<_, i64>(8).map_err(query_failed)?;
        let group = row.get::<_, Option<String>>(9).map_err(query_failed)?;
        match group.filter(|value| !value.is_empty()) {
            Some(group) => {
                if row
                    .get::<_, Option<String>>(10)
                    .map_err(query_failed)?
                    .as_deref()
                    == Some("observed-eof")
                    && row
                        .get::<_, Option<String>>(11)
                        .map_err(query_failed)?
                        .as_deref()
                        == Some("exact-first-turn-prefix")
                {
                    entry.provisional_groups.insert(group.clone());
                }
                entry.groups.insert(group);
            }
            None => {
                entry.unknown_sessions.insert(session_id);
            }
        }
    }
    drop(rows);
    drop(statement);
    let all_groups = buckets
        .values()
        .flat_map(|entry| entry.groups.iter().cloned())
        .collect::<BTreeSet<_>>();
    let confidences = read_group_confidences(connection, &all_groups)?;
    (0..bounds.bucket_count)
        .map(|index| {
            let empty = ActivityBucketAccumulator::default();
            let entry = buckets.get(&i64::from(index)).unwrap_or(&empty);
            let start = bounds.after_unix_ms + u64::from(index) * bounds.width_ms;
            let strong = entry
                .groups
                .iter()
                .filter(|group| confidences.get(*group) == Some(&DedupeConfidence::Strong))
                .count() as i64;
            Ok(ActivityBucketRow {
                bucket_start: canonical_timestamp(start)?,
                bucket_end: canonical_timestamp(start + bounds.width_ms)?,
                distinct_session_count: decimal(
                    bucket_sessions
                        .get(&i64::from(index))
                        .map_or(0, |sessions| sessions.len() as i64),
                ),
                distinct_turn_count: decimal(entry.distinct_turns),
                current_closure_counts: ClosureCounts {
                    hard_sealed: decimal(entry.hard_sealed),
                    quiescent: decimal(entry.quiescent),
                    open: decimal(entry.open),
                },
                turn_result_evidence_counts: TurnResultEvidenceCounts {
                    provider_completed: decimal(entry.provider_completed),
                    abandoned: decimal(entry.abandoned),
                    unknown: decimal(entry.unknown),
                },
                recorded_tool_invocation_count: decimal(entry.tools),
                recorded_skill_invocation_count: decimal(entry.skills),
                support: ActivitySupport {
                    distinct_dedupe_group_count: decimal(entry.groups.len() as i64),
                    strong_dedupe_group_count: decimal(strong),
                    weak_dedupe_group_count: decimal(entry.groups.len() as i64 - strong),
                    observed_eof_provisional_group_count: decimal(
                        entry.provisional_groups.len() as i64
                    ),
                    unknown_dedupe_session_count: decimal(entry.unknown_sessions.len() as i64),
                },
            })
        })
        .collect()
}

pub fn read_activity(
    connection: &Connection,
    request: &ActivityRequest,
) -> Result<ActivityResponse, QueryError> {
    request.validate()?;
    let closure_evaluated_at = canonical_timestamp(request.now_unix_ms)?;
    let transaction = connection.unchecked_transaction().map_err(query_failed)?;
    let snapshot = snapshot_seq(&transaction)?;
    let rows = read_activity_buckets_in_snapshot(&transaction, request)?;
    let coverage = read_coverage(&transaction, None)?;
    transaction.commit().map_err(query_failed)?;
    Ok(ActivityResponse {
        snapshot_seq: snapshot,
        closure_evaluated_at,
        quiescence_seconds: request.quiescence_seconds,
        buckets: rows,
        coverage,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn usage_request() -> UsageRequest {
        UsageRequest {
            kind: CapabilityKind::Tool,
            order_by: UsageOrderBy::RecordedInvocationCount,
            window: UsageWindow {
                observed_at_or_after_unix_ms: 1_786_320_000_000,
                observed_before_unix_ms: 1_786_406_400_000,
            },
            now_unix_ms: 1_786_406_400_000,
            ..UsageRequest::default()
        }
    }

    #[test]
    fn canonical_timestamps_round_trip_through_the_epoch_and_leap_days() {
        for (unix_ms, text) in [
            (0_u64, "1970-01-01T00:00:00.000Z"),
            (1_786_320_000_000, "2026-08-10T00:00:00.000Z"),
            (1_786_323_600_000, "2026-08-10T01:00:00.000Z"),
            (1_709_164_800_000, "2024-02-29T00:00:00.000Z"),
        ] {
            assert_eq!(canonical_timestamp(unix_ms).unwrap(), text);
            assert_eq!(parse_canonical_timestamp(text, "value").unwrap(), unix_ms);
        }
    }

    #[test]
    fn leap_day_validity_follows_the_gregorian_rule() {
        assert!(parse_canonical_timestamp("2024-02-29T00:00:00.000Z", "value").is_ok());
        assert!(parse_canonical_timestamp("2023-02-29T00:00:00.000Z", "value").is_err());
        assert!(parse_canonical_timestamp("2000-02-29T00:00:00.000Z", "value").is_ok());
        assert!(parse_canonical_timestamp("1900-02-29T00:00:00.000Z", "value").is_err());
    }

    #[test]
    fn iso_week_starts_land_on_mondays() {
        // 2026-08-10 is a Monday; the surrounding days are not week starts.
        assert!(is_iso_week_start(1_786_320_000_000));
        assert!(!is_iso_week_start(1_786_320_000_000 - DAY_MS));
        assert!(!is_iso_week_start(1_786_320_000_000 + DAY_MS));
        assert!(is_iso_week_start(1_786_320_000_000 + WEEK_MS));
    }

    #[test]
    fn absolute_change_and_dedupe_group_ordering_use_the_declared_metrics() {
        let candidate = |key: &str, current: i64, baseline: i64| UsageCandidate {
            capability_id: 1,
            capability_key: key.to_owned(),
            current: UsageSelection {
                metric: current,
                ..UsageSelection::default()
            },
            baseline: UsageSelection {
                metric: baseline,
                ..UsageSelection::default()
            },
        };
        let mut decrease = candidate("a", 1, 10);
        let mut increase = candidate("b", 4, 1);
        assert!(
            decrease
                .sort_key(UsageOrderBy::AbsoluteRecordedInvocationChange)
                .0
                > increase
                    .sort_key(UsageOrderBy::AbsoluteRecordedInvocationChange)
                    .0
        );
        decrease.current.metric = 2;
        increase.current.metric = 3;
        assert!(
            increase.sort_key(UsageOrderBy::DistinctDedupeGroupCount).0
                > decrease.sort_key(UsageOrderBy::DistinctDedupeGroupCount).0
        );
    }

    #[test]
    fn recent_usage_window_uses_bounded_turn_and_capability_lookups() {
        let mut connection = Connection::open_in_memory().unwrap();
        crate::normalized_repository::initialize_schema(&mut connection).unwrap();
        crate::source_state::initialize_schema(&connection).unwrap();
        let request = usage_request();
        let (sql, parameters) = usage_selection_query(&request, request.window).unwrap();
        let mut plan = connection
            .prepare(&format!("EXPLAIN QUERY PLAN {sql}"))
            .unwrap();
        let details = plan
            .query_map(params_from_iter(parameters), |row| row.get::<_, String>(3))
            .unwrap()
            .collect::<Result<Vec<_>, _>>()
            .unwrap();

        assert!(
            details
                .iter()
                .any(|detail| detail.contains("turns_query_filters")),
            "Usage plan did not enter through the bounded Turn index: {details:?}"
        );
        assert!(
            details
                .iter()
                .any(|detail| detail.contains("capability_uses_query_filter")),
            "Usage plan did not use the Turn-scoped capability lookup: {details:?}"
        );
        assert!(
            details
                .iter()
                .all(|detail| { !detail.starts_with("SCAN t") && !detail.starts_with("SCAN u") }),
            "Usage plan contains an unbounded Turn or capability-use scan: {details:?}"
        );
    }
}
