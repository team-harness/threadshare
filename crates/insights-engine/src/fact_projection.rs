use crate::analyzer::{AnalyzerOriginScope, CapabilityInput, analyze_document};
use crate::fact_model::{
    CapabilityFact, CapabilityUseEvidenceFact, CapabilityUseFact, Eligibility, EvidenceEvent,
    LifecycleState, MessageRole, OriginScope, ProviderStatusKind, ProviderStatusState,
    ProviderTerminal, ProviderVisibility, SessionScope, SourceOrder, SourceRecordFact, StableKey,
    TurnEvidenceFact, TurnEvidenceRole, TurnFact,
};
use crate::fact_repository::{FactEntity, FactEntityKind, FactRepository, SessionFactSnapshot};
use crate::fts_projection::FtsDocument;
use crate::projection::{
    ACTIVE_TURN_SUMMARY_PROJECTION_VERSION, AnalyzedTurnProjection, ProjectionChange,
    ProjectionChangeOperation, ProjectionRootKind, RollupContribution,
    TURN_SUMMARY_PROJECTION_NAME, TurnProjection, advance_active_turn_projection_watermarks,
    append_projection_change, delete_turn_projection, projection_change_log_usage,
    prune_consumed_projection_changes, upsert_analyzed_turn_projection,
    upsert_legacy_turn_projection,
};
use crate::retry_projection::cancel_retry_projection_for_change_log;
use crate::storage::StorageError;
use crate::try_canonical_json;
use rusqlite::{OptionalExtension, Transaction, params};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::cmp::Ordering;
use std::collections::{BTreeMap, BTreeSet};

const ROLLBACK_UNRESOLVED: &str = "rollback-unresolved";

#[derive(Debug, Clone, Default)]
pub(crate) struct SessionProjectionSnapshot {
    turn_revisions: BTreeMap<StableKey, Option<[u8; 32]>>,
    capability_keys: BTreeSet<StableKey>,
    projection_eligible: bool,
}

pub(crate) struct SessionProjectionChangeSet<'a> {
    pub session_key: StableKey,
    pub snapshot_seq: i64,
    pub before: &'a SessionProjectionSnapshot,
    pub after: &'a SessionProjectionSnapshot,
    pub forced_turn_keys: &'a BTreeSet<StableKey>,
    pub force_all_turns: bool,
}

pub(crate) fn maintain_projection_change_log(
    transaction: &Transaction<'_>,
    snapshot_seq: i64,
) -> Result<(), StorageError> {
    maintain_projection_change_log_with_usage(transaction, snapshot_seq, None)
}

fn maintain_projection_change_log_with_usage(
    transaction: &Transaction<'_>,
    snapshot_seq: i64,
    mut usage_override: Option<crate::projection::ChangeLogUsage>,
) -> Result<(), StorageError> {
    loop {
        prune_consumed_projection_changes(transaction, snapshot_seq)?;
        let oldest_building = transaction
            .query_row(
                "SELECT name,version FROM projection_state
                 WHERE status='building'
                 ORDER BY watermark,name,version LIMIT 1",
                [],
                |row| Ok((row.get::<_, String>(0)?, row.get::<_, u32>(1)?)),
            )
            .optional()?;
        let Some((name, version)) = oldest_building else {
            return Ok(());
        };
        let usage = match usage_override.take() {
            Some(usage) => usage,
            None => projection_change_log_usage(transaction)?,
        };
        if !usage.exceeds_limit() {
            return Ok(());
        }
        if !cancel_retry_projection_for_change_log(transaction, &name, version)?
            && !crate::search_projection::cancel_search_projection_for_change_log(
                transaction,
                &name,
                version,
            )?
        {
            return Err(StorageError::new(
                "TS_INSIGHTS_PROJECTION_INVALID",
                "the oldest building projection has no bounded cleanup handler",
            ));
        }
    }
}

#[cfg(test)]
pub(crate) fn maintain_projection_change_log_for_test(
    transaction: &Transaction<'_>,
    snapshot_seq: i64,
    usage: crate::projection::ChangeLogUsage,
) -> Result<(), StorageError> {
    maintain_projection_change_log_with_usage(transaction, snapshot_seq, Some(usage))
}

#[derive(Debug, Clone)]
enum TimelineKind {
    Rollback,
    Seal(StableKey),
}

#[derive(Debug, Clone)]
struct TimelineAction {
    source_order: SourceOrder,
    event_key: StableKey,
    kind: TimelineKind,
}

#[derive(Serialize)]
#[serde(rename_all = "camelCase")]
struct TurnRevisionInput<'a> {
    turn: &'a TurnFact,
    source_records: &'a [SourceRecordFact],
    evidence_events: &'a [EvidenceEvent],
    turn_evidence: &'a [TurnEvidenceFact],
    capabilities: &'a [CapabilityFact],
    capability_uses: &'a [CapabilityUseFact],
    capability_use_evidence: &'a [CapabilityUseEvidenceFact],
}

pub(crate) fn capture_session_projection_snapshot(
    repository: &dyn FactRepository,
    session_key: StableKey,
) -> Result<SessionProjectionSnapshot, StorageError> {
    let Some(FactEntity::Session(facts)) =
        repository.lookup_stable_key(FactEntityKind::Session, &session_key)?
    else {
        return Ok(SessionProjectionSnapshot::default());
    };
    let facts = *facts;
    let projection_eligible = facts.session.session_scope == SessionScope::Main
        && facts.session.eligibility == Eligibility::Eligible;
    Ok(SessionProjectionSnapshot {
        turn_revisions: facts.turn_revisions,
        capability_keys: facts
            .capabilities
            .into_iter()
            .map(|capability| capability.capability_key)
            .collect(),
        projection_eligible,
    })
}

pub(crate) fn recompute_session_derivations(
    transaction: &Transaction<'_>,
    repository: &dyn FactRepository,
    session_id: i64,
    session_key: StableKey,
) -> Result<(), StorageError> {
    clear_engine_rollback_state(transaction, session_id)?;
    let Some(FactEntity::Session(facts)) =
        repository.lookup_stable_key(FactEntityKind::Session, &session_key)?
    else {
        return Err(StorageError::new(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            "committed session disappeared while deriving Facts",
        ));
    };
    let mut facts = *facts;

    let effective_visibility = replay_rollback_visibility(transaction, session_id, &mut facts)?;
    recompute_turn_revisions(transaction, session_id, &facts, &effective_visibility)
}

pub(crate) fn record_projection_changes(
    transaction: &Transaction<'_>,
    repository: &dyn FactRepository,
    changes: &SessionProjectionChangeSet<'_>,
) -> Result<(), StorageError> {
    let session_key = changes.session_key;
    let snapshot_seq = changes.snapshot_seq;
    let before = changes.before;
    let after = changes.after;
    let facts = match repository.lookup_stable_key(FactEntityKind::Session, &session_key)? {
        Some(FactEntity::Session(facts)) => Some(*facts),
        None => None,
        Some(_) => {
            return Err(StorageError::new(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "session key resolved to the wrong Fact entity kind",
            ));
        }
    };
    let events = facts
        .as_ref()
        .map(|facts| {
            facts
                .evidence_events
                .iter()
                .cloned()
                .map(|event| (event.common().event_key, event))
                .collect::<BTreeMap<_, _>>()
        })
        .unwrap_or_default();
    append_projection_change(
        transaction,
        &ProjectionChange {
            snapshot_seq,
            owner_session_key: session_key.as_bytes(),
            root_kind: ProjectionRootKind::Session,
            root_key: session_key.as_bytes(),
            operation: ProjectionChangeOperation::Upsert,
        },
    )?;

    let turn_keys = before
        .turn_revisions
        .keys()
        .chain(after.turn_revisions.keys())
        .copied()
        .collect::<BTreeSet<_>>();
    for turn_key in turn_keys {
        let exists_after = after.turn_revisions.contains_key(&turn_key);
        let changed = changes.force_all_turns
            || before.projection_eligible != after.projection_eligible
            || changes.forced_turn_keys.contains(&turn_key)
            || before.turn_revisions.get(&turn_key) != after.turn_revisions.get(&turn_key);
        if !changed {
            continue;
        }
        if exists_after {
            let facts = facts.as_ref().ok_or_else(|| {
                StorageError::new(
                    "TS_INSIGHTS_STORAGE_CORRUPT",
                    "Turn survived without its owner Session Fact",
                )
            })?;
            materialize_turn_projection(transaction, facts, &events, turn_key, snapshot_seq)?;
        }
        append_projection_change(
            transaction,
            &ProjectionChange {
                snapshot_seq,
                owner_session_key: session_key.as_bytes(),
                root_kind: ProjectionRootKind::Turn,
                root_key: turn_key.as_bytes(),
                operation: if exists_after {
                    ProjectionChangeOperation::Upsert
                } else {
                    ProjectionChangeOperation::Tombstone
                },
            },
        )?;
    }

    advance_active_turn_projection_watermarks(transaction, snapshot_seq)?;

    let capability_keys = before
        .capability_keys
        .union(&after.capability_keys)
        .copied()
        .collect::<BTreeSet<_>>();
    for capability_key in capability_keys {
        let exists_after = repository
            .lookup_stable_key(FactEntityKind::Capability, &capability_key)?
            .is_some();
        append_projection_change(
            transaction,
            &ProjectionChange {
                snapshot_seq,
                owner_session_key: session_key.as_bytes(),
                root_kind: ProjectionRootKind::Capability,
                root_key: capability_key.as_bytes(),
                operation: if exists_after {
                    ProjectionChangeOperation::Upsert
                } else {
                    ProjectionChangeOperation::Tombstone
                },
            },
        )?;
    }
    maintain_projection_change_log(transaction, snapshot_seq)?;
    Ok(())
}

fn materialize_turn_projection(
    transaction: &Transaction<'_>,
    facts: &SessionFactSnapshot,
    events: &BTreeMap<StableKey, EvidenceEvent>,
    turn_key: StableKey,
    snapshot_seq: i64,
) -> Result<(), StorageError> {
    let turn_id = turn_id(transaction, turn_key)?.ok_or_else(|| {
        StorageError::new(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            "Turn projection root disappeared during its Fact commit",
        )
    })?;
    let closure = facts.turn_closure(&turn_key).ok_or_else(|| {
        StorageError::new(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            "Turn projection root is missing from its logical Fact closure",
        )
    })?;
    let eligible = facts.session.session_scope == SessionScope::Main
        && facts.session.eligibility == Eligibility::Eligible
        && closure.turn.provider_visibility == ProviderVisibility::Active;
    if !eligible {
        delete_turn_projection(transaction, turn_id)?;
        return Ok(());
    }

    let capabilities = closure
        .capabilities
        .iter()
        .map(|capability| (capability.capability_key, capability))
        .collect::<BTreeMap<_, _>>();
    let capability_inputs = closure
        .capability_uses
        .iter()
        .map(|usage| CapabilityInput {
            origin_scope: match usage.origin_scope {
                OriginScope::Main => AnalyzerOriginScope::Main,
                OriginScope::Subagent => AnalyzerOriginScope::Subagent,
                OriginScope::Unknown => AnalyzerOriginScope::Unknown,
            },
            turn_ordinal: usage.turn_ordinal,
            capability_key: usage.capability_key.as_bytes(),
            canonical_name: capabilities
                .get(&usage.capability_key)
                .map(|capability| capability.canonical_name.as_str()),
        })
        .collect::<Vec<_>>();
    let legacy_capability = capability_inputs
        .iter()
        .filter(|input| input.origin_scope == AnalyzerOriginScope::Main)
        .filter_map(|input| input.canonical_name)
        .collect::<std::collections::BTreeSet<_>>()
        .into_iter()
        .collect::<Vec<_>>()
        .join(" ");
    let analyzed = analyze_document(&closure.turn.problem_text, &capability_inputs);
    let hard_sealed = hard_seal_event(&closure.turn, &facts.turn_evidence, events).is_some();
    let rollup = [RollupContribution {
        projection_name: TURN_SUMMARY_PROJECTION_NAME,
        projection_version: ACTIVE_TURN_SUMMARY_PROJECTION_VERSION,
        dimension: "session",
        bucket_key: facts.session.session_key.as_bytes(),
        metric: "hard-sealed-turn-count",
        value: 1,
        snapshot_seq,
    }];
    let rollup_contributions = if hard_sealed { &rollup[..] } else { &[] };
    match crate::search_projection::active_search_projection_version(transaction)? {
        Some(crate::analyzer::SEARCH_PROJECTION_VERSION) => upsert_analyzed_turn_projection(
            transaction,
            &AnalyzedTurnProjection {
                document: FtsDocument {
                    turn_id,
                    natural: &analyzed.natural.fts_text,
                    code: &analyzed.code.fts_text,
                    capability: &analyzed.capability.fts_text,
                },
                analyzer_diagnostics: &analyzed.diagnostics,
                rollup_contributions,
            },
        )?,
        Some(1) => upsert_legacy_turn_projection(
            transaction,
            &TurnProjection {
                document: FtsDocument {
                    turn_id,
                    natural: &closure.turn.problem_text,
                    code: "",
                    capability: &legacy_capability,
                },
                rollup_contributions,
            },
        )?,
        _ => {
            return Err(StorageError::new(
                "TS_INSIGHTS_PROJECTION_INVALID",
                "no supported active Turn search projection is available",
            ));
        }
    }
    Ok(())
}

fn clear_engine_rollback_state(
    transaction: &Transaction<'_>,
    session_id: i64,
) -> Result<(), StorageError> {
    transaction.execute(
        "DELETE FROM turn_evidence WHERE session_id=?1 AND role='rollback'",
        [session_id],
    )?;
    transaction.execute(
        "UPDATE turns SET effective_provider_visibility=base_provider_visibility
         WHERE session_id=?1",
        [session_id],
    )?;
    transaction.execute(
        "DELETE FROM fact_diagnostics WHERE session_id=?1 AND code=?2",
        params![session_id, ROLLBACK_UNRESOLVED],
    )?;
    transaction.execute(
        "DELETE FROM fact_coverage WHERE session_id=?1 AND coverage_key=?2",
        params![session_id, ROLLBACK_UNRESOLVED],
    )?;
    Ok(())
}

fn replay_rollback_visibility(
    transaction: &Transaction<'_>,
    session_id: i64,
    facts: &mut SessionFactSnapshot,
) -> Result<BTreeMap<StableKey, ProviderVisibility>, StorageError> {
    let turns = facts
        .turns
        .iter()
        .cloned()
        .map(|turn| (turn.turn_key, turn))
        .collect::<BTreeMap<_, _>>();
    let events = facts
        .evidence_events
        .iter()
        .cloned()
        .map(|event| (event.common().event_key, event))
        .collect::<BTreeMap<_, _>>();
    let mut effective = turns
        .iter()
        .map(|(key, turn)| (*key, turn.provider_visibility))
        .collect::<BTreeMap<_, _>>();
    let mut incomplete_turns = BTreeSet::new();
    let mut timeline = Vec::new();

    for event in events.values() {
        if let EvidenceEvent::ProviderStatus(status) = event
            && status.status_kind == ProviderStatusKind::ThreadRolledBack
        {
            timeline.push(TimelineAction {
                source_order: status.common.source_order.clone(),
                event_key: status.common.event_key,
                kind: TimelineKind::Rollback,
            });
        }
    }
    for turn in turns.values() {
        let declares_hard_seal =
            turn.raw_closure.next_user_boundary || turn.raw_closure.provider_terminal.is_some();
        let seal = hard_seal_event(turn, &facts.turn_evidence, &events);
        if declares_hard_seal && seal.is_none() {
            incomplete_turns.insert(turn.turn_key);
        }
        if let Some((source_order, event_key)) = seal {
            timeline.push(TimelineAction {
                source_order,
                event_key,
                kind: TimelineKind::Seal(turn.turn_key),
            });
        }
    }
    timeline.sort_by(compare_timeline);

    let session_incomplete = !facts.session.fact_truncation.is_empty();
    let mut sealed_active = BTreeSet::new();
    let mut observed_seals = BTreeSet::new();
    let mut unresolved = Vec::new();
    let mut rollback_links = Vec::new();
    for action in timeline {
        match action.kind {
            TimelineKind::Seal(turn_key) => {
                if !observed_seals.insert(turn_key) {
                    continue;
                }
                if turns
                    .get(&turn_key)
                    .is_some_and(|turn| turn.provider_visibility == ProviderVisibility::Active)
                {
                    sealed_active.insert(turn_key);
                }
            }
            TimelineKind::Rollback => {
                let Some(EvidenceEvent::ProviderStatus(status)) = events.get(&action.event_key)
                else {
                    continue;
                };
                let count = status
                    .rolled_back_turn_count
                    .map(|value| value.get())
                    .unwrap_or(0);
                let prior_incomplete = turns.values().any(|turn| {
                    turn.turn_start_offset.get()
                        < status.common.source_order.record_start_offset.get()
                        && (!turn.fact_truncation.is_empty()
                            || incomplete_turns.contains(&turn.turn_key))
                });
                if status.provider_state != ProviderStatusState::Observed
                    || !(1..=512).contains(&count)
                    || facts.session.session_scope != SessionScope::Main
                    || session_incomplete
                    || prior_incomplete
                {
                    unresolved.push(status.clone());
                    continue;
                }

                let mut active = sealed_active
                    .iter()
                    .filter_map(|key| turns.get(key))
                    .collect::<Vec<_>>();
                active.sort_by(|left, right| {
                    left.turn_start_offset
                        .get()
                        .cmp(&right.turn_start_offset.get())
                        .then_with(|| left.turn_key.cmp(&right.turn_key))
                });
                let target_count = usize::try_from(count).map_err(|_| {
                    StorageError::new(
                        "TS_INSIGHTS_STORAGE_CORRUPT",
                        "rollback count cannot be represented by the Engine",
                    )
                })?;
                if active.len() < target_count {
                    unresolved.push(status.clone());
                    continue;
                }
                for target in active.into_iter().rev().take(target_count) {
                    sealed_active.remove(&target.turn_key);
                    effective.insert(target.turn_key, ProviderVisibility::RolledBack);
                    rollback_links.push(TurnEvidenceFact {
                        owner_session_key: facts.session.session_key,
                        turn_key: target.turn_key,
                        event_key: status.common.event_key,
                        role: TurnEvidenceRole::Rollback,
                    });
                }
            }
        }
    }

    for (turn_key, visibility) in &effective {
        transaction.execute(
            "UPDATE turns SET effective_provider_visibility=?1
             WHERE session_id=?2 AND turn_key=?3",
            params![
                visibility_text(*visibility),
                session_id,
                turn_key.as_bytes().as_slice()
            ],
        )?;
    }
    for link in &rollback_links {
        transaction.execute(
            "INSERT INTO turn_evidence(session_id,turn_id,event_id,role)
             SELECT ?1,t.turn_id,e.event_id,'rollback'
               FROM turns t,evidence_events e
              WHERE t.session_id=?1 AND t.turn_key=?2
                AND e.session_id=?1 AND e.event_key=?3",
            params![
                session_id,
                link.turn_key.as_bytes().as_slice(),
                link.event_key.as_bytes().as_slice()
            ],
        )?;
    }
    facts.turn_evidence.extend(rollback_links);
    replace_rollback_unresolved(transaction, session_id, &unresolved)?;
    Ok(effective)
}

fn hard_seal_event(
    turn: &TurnFact,
    links: &[TurnEvidenceFact],
    events: &BTreeMap<StableKey, EvidenceEvent>,
) -> Option<(SourceOrder, StableKey)> {
    let mut candidates = Vec::new();
    for link in links.iter().filter(|link| link.turn_key == turn.turn_key) {
        let Some(event) = events.get(&link.event_key) else {
            continue;
        };
        let is_boundary = turn.raw_closure.next_user_boundary
            && link.role == TurnEvidenceRole::FollowUp
            && matches!(
                event,
                EvidenceEvent::VisibleMessage(message) if message.role == MessageRole::User
            );
        let is_terminal = turn.raw_closure.provider_terminal.is_some()
            && link.role == TurnEvidenceRole::Lifecycle
            && matches!(
                event,
                EvidenceEvent::TurnLifecycle(lifecycle)
                    if terminal_matches(
                        turn.raw_closure.provider_terminal,
                        lifecycle.lifecycle_state
                    )
            );
        if is_boundary || is_terminal {
            candidates.push((
                event.common().source_order.clone(),
                event.common().event_key,
            ));
        }
    }
    candidates.sort_by(|left, right| {
        compare_source_order(&left.0, &right.0).then_with(|| left.1.cmp(&right.1))
    });
    candidates.into_iter().next()
}

fn replace_rollback_unresolved(
    transaction: &Transaction<'_>,
    session_id: i64,
    events: &[crate::fact_model::ProviderStatusEvent],
) -> Result<(), StorageError> {
    if events.is_empty() {
        return Ok(());
    }
    let count = u64::try_from(events.len()).map_err(|_| {
        StorageError::new(
            "TS_INSIGHTS_STORAGE_FAILED",
            "rollback diagnostic count exceeds uint64",
        )
    })?;
    let first_offset = events
        .iter()
        .map(|event| event.common.source_order.record_start_offset.get())
        .min()
        .unwrap_or(0);
    transaction.execute(
        "INSERT INTO fact_coverage(session_id,coverage_key,coverage_count)
         VALUES (?1,?2,?3)",
        params![
            session_id,
            ROLLBACK_UNRESOLVED,
            count.to_be_bytes().to_vec()
        ],
    )?;
    transaction.execute(
        "INSERT INTO fact_diagnostics(session_id,code,diagnostic_count,first_offset,digest)
         VALUES (?1,?2,?3,?4,NULL)",
        params![
            session_id,
            ROLLBACK_UNRESOLVED,
            count.to_be_bytes().to_vec(),
            first_offset.to_be_bytes().to_vec()
        ],
    )?;
    Ok(())
}

fn recompute_turn_revisions(
    transaction: &Transaction<'_>,
    session_id: i64,
    facts: &SessionFactSnapshot,
    effective_visibility: &BTreeMap<StableKey, ProviderVisibility>,
) -> Result<(), StorageError> {
    for base_turn in &facts.turns {
        let turn_key = base_turn.turn_key;
        let mut closure = facts.turn_closure(&turn_key).ok_or_else(|| {
            StorageError::new(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "Turn disappeared from its logical session closure",
            )
        })?;
        closure.turn.provider_visibility = effective_visibility
            .get(&turn_key)
            .copied()
            .unwrap_or(closure.turn.provider_visibility);
        let revision_input = TurnRevisionInput {
            turn: &closure.turn,
            source_records: &closure.source_records,
            evidence_events: &closure.evidence_events,
            turn_evidence: &closure.turn_evidence,
            capabilities: &closure.capabilities,
            capability_uses: &closure.capability_uses,
            capability_use_evidence: &closure.capability_use_evidence,
        };
        let value = serde_json::to_value(revision_input)
            .map_err(|error| StorageError::new("TS_INSIGHTS_STORAGE_FAILED", error.to_string()))?;
        let canonical = try_canonical_json(&value).map_err(|_| {
            StorageError::new(
                "TS_INSIGHTS_STORAGE_FAILED",
                "Turn revision is outside the canonical JSON domain",
            )
        })?;
        let revision: [u8; 32] = Sha256::digest(canonical.as_bytes()).into();
        transaction.execute(
            "UPDATE turns SET revision=?1 WHERE session_id=?2 AND turn_key=?3",
            params![
                revision.to_vec(),
                session_id,
                turn_key.as_bytes().as_slice()
            ],
        )?;
    }
    Ok(())
}

fn compare_timeline(left: &TimelineAction, right: &TimelineAction) -> Ordering {
    compare_source_order(&left.source_order, &right.source_order)
        .then_with(|| left.event_key.cmp(&right.event_key))
        .then_with(|| timeline_kind_rank(&left.kind).cmp(&timeline_kind_rank(&right.kind)))
}

fn compare_source_order(left: &SourceOrder, right: &SourceOrder) -> Ordering {
    left.record_start_offset
        .get()
        .cmp(&right.record_start_offset.get())
        .then_with(|| left.content_index.cmp(&right.content_index))
        .then_with(|| left.event_ordinal.cmp(&right.event_ordinal))
}

fn terminal_matches(terminal: Option<ProviderTerminal>, lifecycle: LifecycleState) -> bool {
    matches!(
        (terminal, lifecycle),
        (Some(ProviderTerminal::Completed), LifecycleState::Completed)
            | (Some(ProviderTerminal::Aborted), LifecycleState::Aborted)
    )
}

fn timeline_kind_rank(kind: &TimelineKind) -> u8 {
    match kind {
        TimelineKind::Rollback => 0,
        TimelineKind::Seal(_) => 1,
    }
}

fn visibility_text(value: ProviderVisibility) -> &'static str {
    match value {
        ProviderVisibility::Active => "active",
        ProviderVisibility::RolledBack => "rolled-back",
        ProviderVisibility::Unknown => "unknown",
    }
}

fn turn_id(
    transaction: &Transaction<'_>,
    turn_key: StableKey,
) -> Result<Option<i64>, StorageError> {
    Ok(transaction
        .query_row(
            "SELECT turn_id FROM turns WHERE turn_key=?1",
            params![turn_key.as_bytes().as_slice()],
            |row| row.get(0),
        )
        .optional()?)
}
