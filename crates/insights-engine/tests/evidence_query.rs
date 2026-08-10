use threadshare_insights_engine::evidence_path::{
    DedupeConfidence, EvidencePathTurn, ToolPathUse, build_evidence_paths,
};
use threadshare_insights_engine::fact_model::{
    CapabilityTerminalState, OriginScope, ProviderVisibility, SessionScope,
};
use threadshare_insights_engine::query::ClosureFilter;

fn turn(index: u8, group: u8) -> EvidencePathTurn {
    EvidencePathTurn {
        turn_key: format!("turn-{index}"),
        session_key: format!("session-{index}"),
        provider: "codex".to_owned(),
        relevance_ppm: 900_000 - u32::from(index),
        observed_unix_ms: 1_000 + u64::from(index),
        closure: ClosureFilter::HardSealed,
        session_scope: SessionScope::Main,
        provider_visibility: ProviderVisibility::Active,
        duplicate_group_key: Some(format!("group-{group}")),
        dedupe_confidence: Some(DedupeConfidence::Strong),
        observed_eof_provisional: false,
        tools: vec![
            ToolPathUse {
                capability_key: "e".repeat(64),
                canonical_name: "shell".to_owned(),
                turn_ordinal: 1,
                origin_scope: OriginScope::Main,
                terminal_state: CapabilityTerminalState::Completed,
            },
            ToolPathUse {
                capability_key: "e".repeat(64),
                canonical_name: "shell".to_owned(),
                turn_ordinal: 2,
                origin_scope: OriginScope::Main,
                terminal_state: CapabilityTerminalState::Failed,
            },
            ToolPathUse {
                capability_key: "f".repeat(64),
                canonical_name: "read".to_owned(),
                turn_ordinal: 3,
                origin_scope: OriginScope::Main,
                terminal_state: CapabilityTerminalState::Completed,
            },
        ],
    }
}

#[test]
fn evidence_path_requires_five_turns_and_three_independent_groups() {
    let insufficient = build_evidence_paths(
        &(0..4)
            .map(|index| turn(index, index % 3))
            .collect::<Vec<_>>(),
        20,
    );
    assert!(insufficient.insufficient_sample);

    let report = build_evidence_paths(
        &(0..5)
            .map(|index| turn(index, index % 3))
            .collect::<Vec<_>>(),
        20,
    );
    assert!(!report.insufficient_sample);
    assert_eq!(report.families.len(), 1);
    assert_eq!(report.families[0].turn_count, 5);
    assert_eq!(report.families[0].independent_group_count, 3);
    assert_eq!(
        report.families[0].nodes[0].provider_scoped_name,
        "codex:shell"
    );
    assert_eq!(report.families[0].nodes[0].repeat_bucket.as_str(), "2-3");
    assert_eq!(report.families[0].evidence_turn_keys.len(), 5);
}

#[test]
fn null_dedupe_turns_count_as_eligible_support_but_not_independent_groups() {
    let mut mixed = (0..5).map(|index| turn(index, index)).collect::<Vec<_>>();
    mixed[0].duplicate_group_key = None;
    mixed[1].duplicate_group_key = None;
    let report = build_evidence_paths(&mixed, 20);
    assert!(!report.insufficient_sample);
    assert_eq!(report.eligible_turn_count, 5);
    assert_eq!(report.raw_session_count, 5);
    assert_eq!(report.independent_group_count, 3);
    assert_eq!(report.strong_group_count, 3);
    assert_eq!(report.weak_group_count, 0);
    assert_eq!(report.unknown_dedupe_count, 2);
    assert_eq!(report.unknown_dedupe_session_count, 2);
    assert_eq!(report.families[0].turn_count, 5);

    let mut all_null = (0..5).map(|index| turn(index, index)).collect::<Vec<_>>();
    for candidate in &mut all_null {
        candidate.duplicate_group_key = None;
    }
    let report = build_evidence_paths(&all_null, 20);
    assert!(report.insufficient_sample);
    assert_eq!(report.eligible_turn_count, 5);
    assert_eq!(report.raw_session_count, 5);
    assert_eq!(report.independent_group_count, 0);
    assert_eq!(report.unknown_dedupe_count, 5);
    assert_eq!(report.unknown_dedupe_session_count, 5);
}

#[test]
fn ineligible_null_dedupe_turns_do_not_count_as_unknown_support() {
    let mut candidates = vec![turn(0, 0), turn(1, 1), turn(2, 2)];
    for candidate in &mut candidates {
        candidate.duplicate_group_key = None;
    }
    candidates[0].closure = ClosureFilter::Open;
    candidates[1].session_scope = SessionScope::Subagent;
    candidates[2].provider_visibility = ProviderVisibility::RolledBack;

    let report = build_evidence_paths(&candidates, 20);
    assert_eq!(report.eligible_turn_count, 0);
    assert_eq!(report.raw_session_count, 0);
    assert_eq!(report.unknown_dedupe_count, 0);
    assert_eq!(report.unknown_dedupe_session_count, 0);
    assert!(report.insufficient_sample);
}

#[test]
fn confidence_and_observed_eof_are_independent_group_axes() {
    let mut candidates = (0..5)
        .map(|index| turn(index, index % 3))
        .collect::<Vec<_>>();
    candidates[0].dedupe_confidence = Some(DedupeConfidence::Weak);
    candidates[0].observed_eof_provisional = true;
    candidates[3].dedupe_confidence = Some(DedupeConfidence::Weak);

    let report = build_evidence_paths(&candidates, 20);
    assert_eq!(report.raw_session_count, 5);
    assert_eq!(report.independent_group_count, 3);
    assert_eq!(report.strong_group_count, 2);
    assert_eq!(report.weak_group_count, 1);
    assert_eq!(report.observed_eof_provisional_group_count, 1);
    assert_eq!(report.unknown_dedupe_session_count, 0);
    let family = &report.families[0];
    assert_eq!(family.independent_group_count, 3);
    assert_eq!(family.strong_group_count, 2);
    assert_eq!(family.weak_group_count, 1);
    assert_eq!(family.observed_eof_provisional_group_count, 1);
    assert_eq!(
        family.strong_group_count + family.weak_group_count,
        family.independent_group_count
    );
}

#[test]
fn support_threshold_is_applied_to_each_family() {
    let mut candidates = (0..10)
        .map(|index| turn(index, index % 6))
        .collect::<Vec<_>>();
    for (index, candidate) in candidates.iter_mut().enumerate().skip(5) {
        candidate.tools[0].canonical_name = "write".to_owned();
        candidate.tools[0].capability_key = "a".repeat(64);
        candidate.tools[1].canonical_name = "write".to_owned();
        candidate.tools[1].capability_key = "a".repeat(64);
        candidate.tools[2].canonical_name = "edit".to_owned();
        candidate.tools[2].capability_key = "b".repeat(64);
        candidate.duplicate_group_key = Some(format!("split-group-{}", index % 2));
    }

    let report = build_evidence_paths(&candidates, 20);
    assert!(!report.insufficient_sample);
    assert_eq!(report.families.len(), 1);
    assert_eq!(
        report.families[0].nodes[0].provider_scoped_name,
        "codex:shell"
    );

    for candidate in candidates.iter_mut().take(5) {
        candidate.duplicate_group_key = Some("one-group".to_owned());
    }
    let report = build_evidence_paths(&candidates, 20);
    assert!(report.insufficient_sample);
    assert!(report.families.is_empty());
}
