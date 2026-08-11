use crate::analyzer::{AnalyzerOriginScope, CapabilityInput, analyze_document};
use crate::fact_model::{
    CapabilityFact, CapabilityUseEvidenceFact, CapabilityUseFact, EvidenceEvent, OriginScope,
    ProviderStatusState, ProviderTerminal, ProviderVisibility, SourceOrder, SourceRecordFact,
    StableKey, TurnEvidenceFact, TurnFact,
};
use crate::fact_repository::{FactRepository, TurnFactClosure};
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
    pub is_forced_turn_key: &'a dyn Fn(StableKey) -> Result<bool, StorageError>,
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
    Rollback(RollbackAction),
    Seal(StableKey),
}

#[derive(Debug, Clone, Copy)]
struct RollbackAction {
    provider_state: ProviderStatusState,
    rolled_back_turn_count: Option<u64>,
}

#[derive(Debug, Clone, Copy)]
struct RollbackTurn {
    turn_key: StableKey,
    turn_start_offset: u64,
    provider_visibility: ProviderVisibility,
    declares_hard_seal: bool,
    truncated: bool,
}

#[derive(Debug, Default)]
struct UnresolvedRollbacks {
    count: u64,
    first_offset: Option<u64>,
}

impl UnresolvedRollbacks {
    fn record(&mut self, offset: u64) -> Result<(), StorageError> {
        self.count = self.count.checked_add(1).ok_or_else(|| {
            StorageError::new(
                "TS_INSIGHTS_STORAGE_FAILED",
                "rollback diagnostic count exceeds uint64",
            )
        })?;
        self.first_offset = Some(self.first_offset.map_or(offset, |prior| prior.min(offset)));
        Ok(())
    }
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
    transaction: &Transaction<'_>,
    session_key: StableKey,
) -> Result<SessionProjectionSnapshot, StorageError> {
    let projection_eligible = transaction
        .query_row(
            "SELECT session_scope='main' AND eligibility='eligible'
             FROM sessions WHERE session_key=?1",
            params![session_key.as_bytes().as_slice()],
            |row| row.get::<_, bool>(0),
        )
        .optional()?;
    let Some(projection_eligible) = projection_eligible else {
        return Ok(SessionProjectionSnapshot::default());
    };

    let mut turn_statement = transaction.prepare(
        "SELECT turn_key,revision FROM turns
         WHERE session_id=(SELECT session_id FROM sessions WHERE session_key=?1)
         ORDER BY turn_key",
    )?;
    let turn_rows = turn_statement
        .query_map(params![session_key.as_bytes().as_slice()], |row| {
            Ok((row.get::<_, Vec<u8>>(0)?, row.get::<_, Option<Vec<u8>>>(1)?))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let turn_revisions = turn_rows
        .into_iter()
        .map(|(turn_key, revision)| {
            Ok((
                stable_key_from_blob(turn_key, "stored Turn key is not 32 bytes")?,
                revision
                    .map(|value| digest_from_blob(value, "stored Turn revision is not 32 bytes"))
                    .transpose()?,
            ))
        })
        .collect::<Result<BTreeMap<_, _>, StorageError>>()?;

    let mut capability_statement = transaction.prepare(
        "SELECT capability_key FROM (
           SELECT c.capability_key AS capability_key
             FROM capability_uses u JOIN capabilities c ON c.capability_id=u.capability_id
            WHERE u.session_id=(SELECT session_id FROM sessions WHERE session_key=?1)
           UNION
           SELECT c.capability_key
             FROM evidence_events e
             JOIN capability_invocation_events i ON i.event_id=e.event_id
             JOIN capabilities c ON c.capability_id=i.capability_id
            WHERE e.session_id=(SELECT session_id FROM sessions WHERE session_key=?1)
           UNION
           SELECT c.capability_key
             FROM evidence_events e
             JOIN skill_catalog_entry_events catalog ON catalog.event_id=e.event_id
             JOIN capabilities c ON c.capability_id=catalog.capability_id
            WHERE e.session_id=(SELECT session_id FROM sessions WHERE session_key=?1)
           UNION
           SELECT c.capability_key
             FROM evidence_events e
             JOIN skill_load_events load ON load.event_id=e.event_id
             JOIN capabilities c ON c.capability_id=load.capability_id
            WHERE e.session_id=(SELECT session_id FROM sessions WHERE session_key=?1)
           UNION
           SELECT c.capability_key
             FROM checkpoint_capability_pins pin
             JOIN capabilities c ON c.capability_id=pin.capability_id
            WHERE pin.session_id=(SELECT session_id FROM sessions WHERE session_key=?1)
         ) ORDER BY capability_key",
    )?;
    let capability_rows = capability_statement
        .query_map(params![session_key.as_bytes().as_slice()], |row| {
            row.get::<_, Vec<u8>>(0)
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let capability_keys = capability_rows
        .into_iter()
        .map(|value| stable_key_from_blob(value, "stored Capability key is not 32 bytes"))
        .collect::<Result<BTreeSet<_>, _>>()?;

    Ok(SessionProjectionSnapshot {
        turn_revisions,
        capability_keys,
        projection_eligible,
    })
}

pub(crate) fn recompute_session_derivations(
    transaction: &Transaction<'_>,
    session_id: i64,
) -> Result<(), StorageError> {
    clear_engine_rollback_state(transaction, session_id)?;
    replay_rollback_visibility(transaction, session_id)?;
    recompute_turn_revisions(transaction, session_id)
}

pub(crate) fn record_projection_changes(
    transaction: &Transaction<'_>,
    changes: &SessionProjectionChangeSet<'_>,
) -> Result<(), StorageError> {
    let session_key = changes.session_key;
    let snapshot_seq = changes.snapshot_seq;
    let before = changes.before;
    let after = changes.after;
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
            || before.turn_revisions.get(&turn_key) != after.turn_revisions.get(&turn_key)
            || (changes.is_forced_turn_key)(turn_key)?;
        if !changed {
            continue;
        }
        if exists_after {
            let closure = transaction.read_turn_closure(&turn_key)?.ok_or_else(|| {
                StorageError::new(
                    "TS_INSIGHTS_STORAGE_CORRUPT",
                    "Turn projection root is missing from its logical Fact closure",
                )
            })?;
            materialize_turn_projection(
                transaction,
                session_key,
                after.projection_eligible,
                &closure,
                snapshot_seq,
            )?;
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
        let exists_after = transaction.query_row(
            "SELECT EXISTS(SELECT 1 FROM capabilities WHERE capability_key=?1)",
            params![capability_key.as_bytes().as_slice()],
            |row| row.get::<_, bool>(0),
        )?;
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
    session_key: StableKey,
    projection_eligible: bool,
    closure: &TurnFactClosure,
    snapshot_seq: i64,
) -> Result<(), StorageError> {
    let turn_id = turn_id(transaction, closure.turn.turn_key)?.ok_or_else(|| {
        StorageError::new(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            "Turn projection root disappeared during its Fact commit",
        )
    })?;
    let eligible =
        projection_eligible && closure.turn.provider_visibility == ProviderVisibility::Active;
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
    let hard_sealed = hard_seal_exists(transaction, turn_id, &closure.turn)?;
    let rollup = [RollupContribution {
        projection_name: TURN_SUMMARY_PROJECTION_NAME,
        projection_version: ACTIVE_TURN_SUMMARY_PROJECTION_VERSION,
        dimension: "session",
        bucket_key: session_key.as_bytes(),
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

fn hard_seal_exists(
    transaction: &Transaction<'_>,
    turn_id: i64,
    turn: &TurnFact,
) -> Result<bool, StorageError> {
    let provider_terminal = turn.raw_closure.provider_terminal.map(|value| match value {
        ProviderTerminal::Completed => "completed",
        ProviderTerminal::Aborted => "aborted",
    });
    Ok(transaction.query_row(
        "SELECT EXISTS(
           SELECT 1 FROM turn_evidence link
           LEFT JOIN visible_message_events message ON message.event_id=link.event_id
           LEFT JOIN turn_lifecycle_events lifecycle ON lifecycle.event_id=link.event_id
           WHERE link.turn_id=?1 AND (
             (?2 AND link.role='follow-up' AND message.message_role='user') OR
             (?3 IS NOT NULL AND link.role='lifecycle' AND lifecycle.lifecycle_state=?3)
           )
         )",
        params![
            turn_id,
            turn.raw_closure.next_user_boundary,
            provider_terminal
        ],
        |row| row.get::<_, bool>(0),
    )?)
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
) -> Result<(), StorageError> {
    let (session_scope, session_incomplete) = transaction
        .query_row(
            "SELECT s.session_scope,
                    EXISTS(SELECT 1 FROM session_fact_truncation f WHERE f.session_id=s.session_id)
             FROM sessions s WHERE s.session_id=?1",
            [session_id],
            |row| Ok((row.get::<_, String>(0)?, row.get::<_, bool>(1)?)),
        )
        .optional()?
        .ok_or_else(|| {
            StorageError::new(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "committed session disappeared while deriving Facts",
            )
        })?;
    let session_is_main = match session_scope.as_str() {
        "main" => true,
        "subagent" | "unknown" => false,
        _ => {
            return Err(StorageError::new(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "stored Session scope is invalid",
            ));
        }
    };

    let mut turn_statement = transaction.prepare(
        "SELECT t.turn_key,t.turn_start_offset,t.base_provider_visibility,
                t.next_user_boundary,t.provider_terminal,
                EXISTS(SELECT 1 FROM turn_fact_truncation f WHERE f.turn_id=t.turn_id)
         FROM turns t WHERE t.session_id=?1 ORDER BY t.turn_key",
    )?;
    let turn_rows = turn_statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, bool>(3)?,
                row.get::<_, Option<String>>(4)?,
                row.get::<_, bool>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let turns = turn_rows
        .into_iter()
        .map(
            |(turn_key, start_offset, visibility, next_user_boundary, terminal, truncated)| {
                let provider_visibility = match visibility.as_str() {
                    "active" => ProviderVisibility::Active,
                    "rolled-back" => ProviderVisibility::RolledBack,
                    "unknown" => ProviderVisibility::Unknown,
                    _ => {
                        return Err(StorageError::new(
                            "TS_INSIGHTS_STORAGE_CORRUPT",
                            "stored Turn visibility is invalid",
                        ));
                    }
                };
                if terminal
                    .as_deref()
                    .is_some_and(|value| !matches!(value, "completed" | "aborted"))
                {
                    return Err(StorageError::new(
                        "TS_INSIGHTS_STORAGE_CORRUPT",
                        "stored Turn terminal state is invalid",
                    ));
                }
                let turn_key = stable_key_from_blob(turn_key, "stored Turn key is not 32 bytes")?;
                Ok((
                    turn_key,
                    RollbackTurn {
                        turn_key,
                        turn_start_offset: wire_value_from_blob(
                            start_offset,
                            "stored Turn offset is not 8 bytes",
                        )?
                        .get(),
                        provider_visibility,
                        declares_hard_seal: next_user_boundary || terminal.is_some(),
                        truncated,
                    },
                ))
            },
        )
        .collect::<Result<BTreeMap<StableKey, RollbackTurn>, StorageError>>()?;

    let mut seal_statement = transaction.prepare(
        "SELECT t.turn_key,e.event_key,e.record_start_offset,e.content_index,e.event_ordinal
         FROM turns t
         JOIN turn_evidence link ON link.turn_id=t.turn_id
         JOIN evidence_events e ON e.event_id=link.event_id
         LEFT JOIN visible_message_events message ON message.event_id=e.event_id
         LEFT JOIN turn_lifecycle_events lifecycle ON lifecycle.event_id=e.event_id
         WHERE t.session_id=?1 AND (
           (t.next_user_boundary=1 AND link.role='follow-up' AND message.message_role='user') OR
           (t.provider_terminal IS NOT NULL AND link.role='lifecycle'
             AND lifecycle.lifecycle_state=t.provider_terminal)
         )
         ORDER BY t.turn_key,e.record_start_offset,e.content_index,e.event_ordinal,e.event_key",
    )?;
    let seal_rows = seal_statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
                row.get::<_, i32>(3)?,
                row.get::<_, u16>(4)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    let mut seals = BTreeMap::new();
    for (turn_key, event_key, record_start_offset, content_index, event_ordinal) in seal_rows {
        let turn_key = stable_key_from_blob(turn_key, "stored Turn key is not 32 bytes")?;
        seals.entry(turn_key).or_insert((
            SourceOrder {
                record_start_offset: wire_value_from_blob(
                    record_start_offset,
                    "stored Event offset is not 8 bytes",
                )?,
                content_index,
                event_ordinal,
            },
            stable_key_from_blob(event_key, "stored Event key is not 32 bytes")?,
        ));
    }

    let mut timeline = seals
        .iter()
        .map(|(turn_key, (source_order, event_key))| TimelineAction {
            source_order: source_order.clone(),
            event_key: *event_key,
            kind: TimelineKind::Seal(*turn_key),
        })
        .collect::<Vec<_>>();
    let mut rollback_statement = transaction.prepare(
        "SELECT e.event_key,e.record_start_offset,e.content_index,e.event_ordinal,
                p.provider_state,p.rolled_back_turn_count
         FROM evidence_events e JOIN provider_status_events p ON p.event_id=e.event_id
         WHERE e.session_id=?1 AND p.status_kind='thread-rolled-back'
         ORDER BY e.record_start_offset,e.content_index,e.event_ordinal,e.event_key",
    )?;
    let rollback_rows = rollback_statement
        .query_map([session_id], |row| {
            Ok((
                row.get::<_, Vec<u8>>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, i32>(2)?,
                row.get::<_, u16>(3)?,
                row.get::<_, String>(4)?,
                row.get::<_, Option<Vec<u8>>>(5)?,
            ))
        })?
        .collect::<Result<Vec<_>, _>>()?;
    for (event_key, record_start_offset, content_index, event_ordinal, state, count) in
        rollback_rows
    {
        let provider_state = match state.as_str() {
            "observed" => ProviderStatusState::Observed,
            "invalid" => ProviderStatusState::Invalid,
            _ => {
                return Err(StorageError::new(
                    "TS_INSIGHTS_STORAGE_CORRUPT",
                    "stored Provider status state is invalid",
                ));
            }
        };
        timeline.push(TimelineAction {
            source_order: SourceOrder {
                record_start_offset: wire_value_from_blob(
                    record_start_offset,
                    "stored Event offset is not 8 bytes",
                )?,
                content_index,
                event_ordinal,
            },
            event_key: stable_key_from_blob(event_key, "stored Event key is not 32 bytes")?,
            kind: TimelineKind::Rollback(RollbackAction {
                provider_state,
                rolled_back_turn_count: count
                    .map(|value| {
                        wire_value_from_blob(value, "stored rollback count is not 8 bytes")
                            .map(|value| value.get())
                    })
                    .transpose()?,
            }),
        });
    }
    timeline.sort_by(compare_timeline);

    let earliest_incomplete_turn = turns
        .values()
        .filter(|turn| {
            turn.truncated || (turn.declares_hard_seal && !seals.contains_key(&turn.turn_key))
        })
        .map(|turn| turn.turn_start_offset)
        .min();
    let mut sealed_active = BTreeSet::new();
    let mut unresolved = UnresolvedRollbacks::default();
    for action in timeline {
        match action.kind {
            TimelineKind::Seal(turn_key) => {
                if turns
                    .get(&turn_key)
                    .is_some_and(|turn| turn.provider_visibility == ProviderVisibility::Active)
                    && let Some(turn) = turns.get(&turn_key)
                {
                    sealed_active.insert((turn.turn_start_offset, turn.turn_key));
                }
            }
            TimelineKind::Rollback(rollback) => {
                let count = rollback.rolled_back_turn_count.unwrap_or(0);
                let rollback_offset = action.source_order.record_start_offset.get();
                let prior_incomplete = earliest_incomplete_turn
                    .is_some_and(|turn_offset| turn_offset < rollback_offset);
                if rollback.provider_state != ProviderStatusState::Observed
                    || !(1..=512).contains(&count)
                    || !session_is_main
                    || session_incomplete
                    || prior_incomplete
                {
                    unresolved.record(rollback_offset)?;
                    continue;
                }
                let target_count = usize::try_from(count).map_err(|_| {
                    StorageError::new(
                        "TS_INSIGHTS_STORAGE_CORRUPT",
                        "rollback count cannot be represented by the Engine",
                    )
                })?;
                if sealed_active.len() < target_count {
                    unresolved.record(rollback_offset)?;
                    continue;
                }
                let targets = sealed_active
                    .iter()
                    .rev()
                    .take(target_count)
                    .copied()
                    .collect::<Vec<_>>();
                for target @ (_, turn_key) in targets {
                    sealed_active.remove(&target);
                    transaction.execute(
                        "UPDATE turns SET effective_provider_visibility='rolled-back'
                         WHERE session_id=?1 AND turn_key=?2",
                        params![session_id, turn_key.as_bytes().as_slice()],
                    )?;
                    transaction.execute(
                        "INSERT INTO turn_evidence(session_id,turn_id,event_id,role)
                         SELECT ?1,t.turn_id,e.event_id,'rollback'
                           FROM turns t,evidence_events e
                          WHERE t.session_id=?1 AND t.turn_key=?2
                            AND e.session_id=?1 AND e.event_key=?3",
                        params![
                            session_id,
                            turn_key.as_bytes().as_slice(),
                            action.event_key.as_bytes().as_slice()
                        ],
                    )?;
                }
            }
        }
    }
    replace_rollback_unresolved(transaction, session_id, &unresolved)?;
    Ok(())
}

fn replace_rollback_unresolved(
    transaction: &Transaction<'_>,
    session_id: i64,
    unresolved: &UnresolvedRollbacks,
) -> Result<(), StorageError> {
    if unresolved.count == 0 {
        return Ok(());
    }
    let first_offset = unresolved.first_offset.ok_or_else(|| {
        StorageError::new(
            "TS_INSIGHTS_STORAGE_CORRUPT",
            "rollback diagnostic is missing its first offset",
        )
    })?;
    transaction.execute(
        "INSERT INTO fact_coverage(session_id,coverage_key,coverage_count)
         VALUES (?1,?2,?3)",
        params![
            session_id,
            ROLLBACK_UNRESOLVED,
            unresolved.count.to_be_bytes().to_vec()
        ],
    )?;
    transaction.execute(
        "INSERT INTO fact_diagnostics(session_id,code,diagnostic_count,first_offset,digest)
         VALUES (?1,?2,?3,?4,NULL)",
        params![
            session_id,
            ROLLBACK_UNRESOLVED,
            unresolved.count.to_be_bytes().to_vec(),
            first_offset.to_be_bytes().to_vec()
        ],
    )?;
    Ok(())
}

fn recompute_turn_revisions(
    transaction: &Transaction<'_>,
    session_id: i64,
) -> Result<(), StorageError> {
    let mut statement =
        transaction.prepare("SELECT turn_key FROM turns WHERE session_id=?1 ORDER BY turn_key")?;
    let turn_key_rows = statement
        .query_map([session_id], |row| row.get::<_, Vec<u8>>(0))?
        .collect::<Result<Vec<_>, _>>()?;
    drop(statement);
    for turn_key in turn_key_rows {
        let turn_key = stable_key_from_blob(turn_key, "stored Turn key is not 32 bytes")?;
        let closure = transaction.read_turn_closure(&turn_key)?.ok_or_else(|| {
            StorageError::new(
                "TS_INSIGHTS_STORAGE_CORRUPT",
                "Turn disappeared from its logical session closure",
            )
        })?;
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

fn timeline_kind_rank(kind: &TimelineKind) -> u8 {
    match kind {
        TimelineKind::Rollback(_) => 0,
        TimelineKind::Seal(_) => 1,
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

fn stable_key_from_blob(value: Vec<u8>, message: &'static str) -> Result<StableKey, StorageError> {
    Ok(StableKey::from_bytes(digest_from_blob(value, message)?))
}

fn digest_from_blob(value: Vec<u8>, message: &'static str) -> Result<[u8; 32], StorageError> {
    value
        .try_into()
        .map_err(|_| StorageError::new("TS_INSIGHTS_STORAGE_CORRUPT", message))
}

fn wire_value_from_blob(
    value: Vec<u8>,
    message: &'static str,
) -> Result<crate::fact_model::WireU64, StorageError> {
    crate::fact_model::WireU64::from_be_blob(&value)
        .map_err(|_| StorageError::new("TS_INSIGHTS_STORAGE_CORRUPT", message))
}
