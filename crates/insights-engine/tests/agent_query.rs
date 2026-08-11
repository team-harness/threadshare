use std::path::PathBuf;
use std::sync::atomic::{AtomicU64, Ordering};

use rusqlite::Connection;
use serde_json::Value;
use threadshare_insights_engine::agent_query::{
    ActivityBucket, ActivityRequest, ActivityWindow, UsageOrderBy, UsageRequest, UsageWindow,
};
use threadshare_insights_engine::fact_model::{
    CapabilityKind, CapabilityTerminalState, SessionFactsDeltaV1,
};
use threadshare_insights_engine::query::ClosureFilter;
use threadshare_insights_engine::storage::EngineStorage;

const DAY_MS: u64 = 86_400_000;
/// 2026-08-10T00:00:00.000Z — a Monday, so it is both a UTC day and an ISO week boundary.
const MONDAY: u64 = 1_786_320_000_000;
static NEXT_TEMP_DATABASE: AtomicU64 = AtomicU64::new(0);

struct TemporaryDatabase {
    directory: PathBuf,
    path: PathBuf,
}

impl TemporaryDatabase {
    fn new() -> Self {
        let directory = std::env::temp_dir().join(format!(
            "threadshare-agent-query-{}-{}",
            std::process::id(),
            NEXT_TEMP_DATABASE.fetch_add(1, Ordering::Relaxed)
        ));
        std::fs::create_dir(&directory).unwrap();
        let path = directory.join("engine.sqlite3");
        Self { directory, path }
    }
}

impl Drop for TemporaryDatabase {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

fn fixture_delta() -> SessionFactsDeltaV1 {
    let fixture: Value = serde_json::from_str(include_str!(
        "../../../test/fixtures/insights-fact-mutations/v1-basic.json"
    ))
    .unwrap();
    SessionFactsDeltaV1::try_from(fixture["initial"].clone()).unwrap()
}

fn usage_request() -> UsageRequest {
    UsageRequest {
        kind: CapabilityKind::Tool,
        order_by: UsageOrderBy::RecordedInvocationCount,
        window: UsageWindow {
            observed_at_or_after_unix_ms: MONDAY,
            observed_before_unix_ms: MONDAY + DAY_MS,
        },
        now_unix_ms: MONDAY + DAY_MS,
        ..UsageRequest::default()
    }
}

fn activity_request() -> ActivityRequest {
    ActivityRequest {
        window: ActivityWindow {
            observed_at_or_after: "2026-08-10T00:00:00.000Z".to_owned(),
            observed_before: "2026-08-11T00:00:00.000Z".to_owned(),
        },
        bucket: ActivityBucket::Day,
        now_unix_ms: MONDAY + DAY_MS,
        ..ActivityRequest::default()
    }
}

fn project_keys(count: usize) -> Vec<String> {
    (0..count).map(|index| format!("{index:064x}")).collect()
}

#[test]
fn a_baseline_usage_request_is_accepted() {
    assert!(usage_request().validate().is_ok());
}

#[test]
fn usage_limits_are_bounded_to_a_single_enrichable_page() {
    for limit in [0, 51, 255] {
        let request = UsageRequest {
            limit,
            ..usage_request()
        };
        let error = request.validate().unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_REQUEST_INVALID");
        assert!(error.message.contains("limit"), "{}", error.message);
    }

    assert!(
        UsageRequest {
            limit: 50,
            ..usage_request()
        }
        .validate()
        .is_ok()
    );
}

#[test]
fn usage_windows_must_be_a_non_empty_half_open_range() {
    let empty = UsageRequest {
        window: UsageWindow {
            observed_at_or_after_unix_ms: MONDAY,
            observed_before_unix_ms: MONDAY,
        },
        ..usage_request()
    };
    let error = empty.validate().unwrap_err();
    assert_eq!(error.code, "TS_INSIGHTS_REQUEST_INVALID");
    assert!(error.message.contains("window"), "{}", error.message);

    let inverted = UsageRequest {
        comparison_window: Some(UsageWindow {
            observed_at_or_after_unix_ms: MONDAY,
            observed_before_unix_ms: MONDAY - DAY_MS,
        }),
        ..usage_request()
    };
    assert_eq!(
        inverted.validate().unwrap_err().code,
        "TS_INSIGHTS_REQUEST_INVALID"
    );
}

#[test]
fn ordering_by_absolute_change_requires_a_comparison_window() {
    let missing = UsageRequest {
        order_by: UsageOrderBy::AbsoluteRecordedInvocationChange,
        ..usage_request()
    };
    let error = missing.validate().unwrap_err();
    assert_eq!(error.code, "TS_INSIGHTS_REQUEST_INVALID");
    assert!(
        error.message.contains("comparisonWindow"),
        "{}",
        error.message
    );

    let supplied = UsageRequest {
        order_by: UsageOrderBy::AbsoluteRecordedInvocationChange,
        comparison_window: Some(UsageWindow {
            observed_at_or_after_unix_ms: MONDAY - DAY_MS,
            observed_before_unix_ms: MONDAY,
        }),
        ..usage_request()
    };
    assert!(supplied.validate().is_ok());
}

#[test]
fn usage_order_wire_names_match_the_public_contract() {
    assert_eq!(
        serde_json::from_str::<UsageOrderBy>("\"last-used\"").unwrap(),
        UsageOrderBy::LastUsedAt
    );
    assert_eq!(
        serde_json::from_str::<UsageOrderBy>("\"distinct-dedupe-group-count\"").unwrap(),
        UsageOrderBy::DistinctDedupeGroupCount
    );
    assert!(serde_json::from_str::<UsageOrderBy>("\"last-used-at\"").is_err());
}

#[test]
fn usage_filter_arrays_must_be_sorted_unique_and_bounded() {
    let unsorted = UsageRequest {
        providers: vec!["codex".to_owned(), "claude".to_owned()],
        ..usage_request()
    };
    assert!(unsorted.validate().unwrap_err().message.contains("sorted"));

    let duplicated = UsageRequest {
        closure_states: vec![ClosureFilter::Open, ClosureFilter::Open],
        ..usage_request()
    };
    assert!(
        duplicated
            .validate()
            .unwrap_err()
            .message
            .contains("unique")
    );

    let duplicated_terminal = UsageRequest {
        capability_terminal_states: vec![
            CapabilityTerminalState::Failed,
            CapabilityTerminalState::Failed,
        ],
        ..usage_request()
    };
    assert!(
        duplicated_terminal
            .validate()
            .unwrap_err()
            .message
            .contains("unique")
    );

    let invalid_key = UsageRequest {
        project_keys: vec!["not-a-stable-key".to_owned()],
        ..usage_request()
    };
    assert_eq!(
        invalid_key.validate().unwrap_err().code,
        "TS_INSIGHTS_REQUEST_INVALID"
    );
}

#[test]
fn usage_and_activity_accept_the_public_64_project_key_limit() {
    for count in [17, 64] {
        assert!(
            UsageRequest {
                project_keys: project_keys(count),
                ..usage_request()
            }
            .validate()
            .is_ok(),
            "Usage rejected {count} project keys"
        );
        assert!(
            ActivityRequest {
                project_keys: project_keys(count),
                ..activity_request()
            }
            .validate()
            .is_ok(),
            "Activity rejected {count} project keys"
        );
    }

    for error in [
        UsageRequest {
            project_keys: project_keys(65),
            ..usage_request()
        }
        .validate()
        .unwrap_err(),
        ActivityRequest {
            project_keys: project_keys(65),
            ..activity_request()
        }
        .validate()
        .unwrap_err(),
    ] {
        assert_eq!(error.code, "TS_INSIGHTS_REQUEST_INVALID");
        assert!(error.message.contains("at most 64"), "{}", error.message);
    }
}

#[test]
fn usage_requires_a_valid_quiescence_clock_because_it_filters_closure() {
    for seconds in [0, 59, 86_401] {
        let request = UsageRequest {
            quiescence_seconds: seconds,
            ..usage_request()
        };
        let error = request.validate().unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_REQUEST_INVALID");
        assert!(
            error.message.contains("quiescenceSeconds"),
            "{}",
            error.message
        );
    }
}

#[test]
fn a_baseline_activity_request_is_accepted_for_both_buckets() {
    assert!(activity_request().validate().is_ok());

    let weekly = ActivityRequest {
        window: ActivityWindow {
            observed_at_or_after: "2026-08-10T00:00:00.000Z".to_owned(),
            observed_before: "2026-08-17T00:00:00.000Z".to_owned(),
        },
        bucket: ActivityBucket::Week,
        ..activity_request()
    };
    assert!(weekly.validate().is_ok());
}

#[test]
fn activity_only_supports_utc() {
    let request = ActivityRequest {
        time_zone: "America/New_York".to_owned(),
        ..activity_request()
    };
    let error = request.validate().unwrap_err();
    assert_eq!(error.code, "TS_INSIGHTS_REQUEST_INVALID");
    assert!(error.message.contains("timeZone"), "{}", error.message);

    assert_eq!(ActivityRequest::default().time_zone, "UTC");
}

#[test]
fn activity_bounds_must_land_on_the_requested_bucket_boundary() {
    let mid_day = ActivityRequest {
        window: ActivityWindow {
            observed_at_or_after: "2026-08-10T01:00:00.000Z".to_owned(),
            ..activity_request().window
        },
        ..activity_request()
    };
    let error = mid_day.validate().unwrap_err();
    assert_eq!(error.code, "TS_INSIGHTS_REQUEST_INVALID");
    assert!(error.message.contains("bucket"), "{}", error.message);

    // 2026-08-11 is a Tuesday: a valid day boundary but not an ISO week boundary.
    let mid_week = ActivityRequest {
        window: ActivityWindow {
            observed_at_or_after: "2026-08-11T00:00:00.000Z".to_owned(),
            observed_before: "2026-08-18T00:00:00.000Z".to_owned(),
        },
        bucket: ActivityBucket::Week,
        ..activity_request()
    };
    assert_eq!(
        mid_week.validate().unwrap_err().code,
        "TS_INSIGHTS_REQUEST_INVALID"
    );
}

#[test]
fn activity_rejects_empty_inverted_and_oversized_ranges() {
    let empty = ActivityRequest {
        window: ActivityWindow {
            observed_at_or_after: "2026-08-10T00:00:00.000Z".to_owned(),
            observed_before: "2026-08-10T00:00:00.000Z".to_owned(),
        },
        ..activity_request()
    };
    assert_eq!(
        empty.validate().unwrap_err().code,
        "TS_INSIGHTS_REQUEST_INVALID"
    );

    let inverted = ActivityRequest {
        window: ActivityWindow {
            observed_at_or_after: "2026-08-11T00:00:00.000Z".to_owned(),
            observed_before: "2026-08-10T00:00:00.000Z".to_owned(),
        },
        ..activity_request()
    };
    assert_eq!(
        inverted.validate().unwrap_err().code,
        "TS_INSIGHTS_REQUEST_INVALID"
    );

    // 367 daily buckets is one past the cap.
    let oversized = ActivityRequest {
        window: ActivityWindow {
            observed_at_or_after: "2025-08-09T00:00:00.000Z".to_owned(),
            observed_before: "2026-08-11T00:00:00.000Z".to_owned(),
        },
        ..activity_request()
    };
    let error = oversized.validate().unwrap_err();
    assert_eq!(error.code, "TS_INSIGHTS_REQUEST_INVALID");
    assert!(error.message.contains("366"), "{}", error.message);

    // Exactly 366 daily buckets is still accepted.
    let at_cap = ActivityRequest {
        window: ActivityWindow {
            observed_at_or_after: "2025-08-10T00:00:00.000Z".to_owned(),
            observed_before: "2026-08-11T00:00:00.000Z".to_owned(),
        },
        ..activity_request()
    };
    assert!(at_cap.validate().is_ok());
}

#[test]
fn activity_timestamps_must_be_canonical_rfc3339_utc_milliseconds() {
    for malformed in [
        "2026-08-10",
        "2026-08-10T00:00:00Z",
        "2026-08-10T00:00:00.000+00:00",
        "2026-08-10t00:00:00.000z",
        "2026-13-10T00:00:00.000Z",
        "2026-08-32T00:00:00.000Z",
        "not-a-timestamp",
    ] {
        let request = ActivityRequest {
            window: ActivityWindow {
                observed_at_or_after: malformed.to_owned(),
                ..activity_request().window
            },
            ..activity_request()
        };
        assert_eq!(
            request.validate().unwrap_err().code,
            "TS_INSIGHTS_REQUEST_INVALID",
            "accepted malformed timestamp {malformed}"
        );
    }
}

#[test]
fn usage_reads_recorded_invocations_without_inventing_dedupe_independence() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();

    let response = storage.read_capability_usage(&usage_request()).unwrap();
    assert_eq!(response.items.len(), 1);
    let item = &response.items[0];
    assert_eq!(item.canonical_name, "Read");
    assert_eq!(item.recorded_invocation_count, "1");
    assert_eq!(item.distinct_turn_count, "1");
    assert_eq!(item.distinct_session_count, "1");
    assert_eq!(item.grouped_invocation_count, "0");
    assert_eq!(item.ungrouped_invocation_count, "1");
    assert_eq!(item.support.distinct_dedupe_group_count, "0");
    assert_eq!(item.support.unknown_dedupe_session_count, "1");
    assert_eq!(item.invocation_terminal_counts.invocation_total, "1");
    assert_eq!(item.invocation_terminal_counts.pending, "1");
    assert_eq!(item.containing_turn_outcome_counts.distinct_turn_total, "1");
    assert_eq!(item.containing_turn_outcome_counts.provider_completed, "1");
    assert_eq!(response.total_candidate_count, "1");
    assert!(!response.truncated);
}

#[test]
fn activity_emits_complete_empty_buckets_and_keeps_turn_and_invocation_axes_separate() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();
    let request = ActivityRequest {
        window: ActivityWindow {
            observed_at_or_after: "2026-08-10T00:00:00.000Z".to_owned(),
            observed_before: "2026-08-12T00:00:00.000Z".to_owned(),
        },
        ..activity_request()
    };

    let response = storage.read_insights_activity(&request).unwrap();
    assert_eq!(response.buckets.len(), 2);
    let first = &response.buckets[0];
    assert_eq!(first.bucket_start, "2026-08-10T00:00:00.000Z");
    assert_eq!(first.bucket_end, "2026-08-11T00:00:00.000Z");
    assert_eq!(first.distinct_session_count, "1");
    assert_eq!(first.distinct_turn_count, "1");
    assert_eq!(first.current_closure_counts.open, "1");
    assert_eq!(first.turn_result_evidence_counts.provider_completed, "1");
    assert_eq!(first.recorded_tool_invocation_count, "1");
    assert_eq!(first.recorded_skill_invocation_count, "0");
    let second = &response.buckets[1];
    assert_eq!(second.distinct_session_count, "0");
    assert_eq!(second.distinct_turn_count, "0");
    assert_eq!(second.recorded_tool_invocation_count, "0");
}

#[test]
fn usage_comparison_keeps_baseline_only_capability_identity_and_signed_delta() {
    let mut storage = EngineStorage::open_in_memory().unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();
    let request = UsageRequest {
        window: UsageWindow {
            observed_at_or_after_unix_ms: MONDAY + DAY_MS,
            observed_before_unix_ms: MONDAY + 2 * DAY_MS,
        },
        comparison_window: Some(UsageWindow {
            observed_at_or_after_unix_ms: MONDAY,
            observed_before_unix_ms: MONDAY + DAY_MS,
        }),
        order_by: UsageOrderBy::AbsoluteRecordedInvocationChange,
        now_unix_ms: MONDAY + 2 * DAY_MS,
        ..usage_request()
    };

    let response = storage.read_capability_usage(&request).unwrap();
    assert_eq!(response.items.len(), 1);
    let item = &response.items[0];
    assert_eq!(item.provider, "codex");
    assert_eq!(item.canonical_name, "Read");
    assert_eq!(item.recorded_invocation_count, "0");
    let comparison = item.comparison.as_ref().unwrap();
    assert_eq!(comparison.baseline_recorded_invocation_count, "1");
    assert_eq!(comparison.current_recorded_invocation_count, "0");
    assert_eq!(comparison.absolute_recorded_invocation_change, "-1");
}

#[test]
fn observed_eof_is_provisional_only_for_prefix_dedupe_groups() {
    let database = TemporaryDatabase::new();
    let mut storage = EngineStorage::open(&database.path).unwrap();
    storage.apply_session_facts(fixture_delta()).unwrap();
    Connection::open(&database.path)
        .unwrap()
        .execute(
            "UPDATE sessions
             SET duplicate_group_key=x'7777777777777777777777777777777777777777777777777777777777777777',
                 duplicate_method='explicit-lineage', duplicate_confidence='strong',
                 dedupe_closure='observed-eof'",
            [],
        )
        .unwrap();

    let usage = storage.read_capability_usage(&usage_request()).unwrap();
    assert_eq!(usage.items[0].support.distinct_dedupe_group_count, "1");
    assert_eq!(
        usage.items[0].support.observed_eof_provisional_group_count,
        "0"
    );

    let activity = storage.read_insights_activity(&activity_request()).unwrap();
    assert_eq!(activity.buckets[0].support.distinct_dedupe_group_count, "1");
    assert_eq!(
        activity.buckets[0]
            .support
            .observed_eof_provisional_group_count,
        "0"
    );
}
