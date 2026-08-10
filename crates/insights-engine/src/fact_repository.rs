use crate::fact_model::{
    CapabilityFact, CapabilityUseEvidenceFact, CapabilityUseFact, Checkpoint, DiagnosticFact,
    EvidenceEvent, SessionFact, SourceRecordFact, StableKey, TurnEvidenceFact, TurnFact,
};
use crate::storage::{CommitOutcome, StorageError};
use serde::Serialize;
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::collections::BTreeSet;

#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum FactEntityKind {
    Session,
    Turn,
    SourceRecord,
    EvidenceEvent,
    Capability,
    CapabilityUse,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", content = "fact", rename_all = "kebab-case")]
pub enum FactEntity {
    Session(Box<SessionFactSnapshot>),
    Turn(Box<TurnFactClosure>),
    SourceRecord(SourceRecordFact),
    EvidenceEvent(EvidenceEvent),
    Capability(CapabilityFact),
    CapabilityUse(CapabilityUseFact),
}

impl FactEntity {
    pub fn stable_key(&self) -> StableKey {
        match self {
            Self::Session(fact) => fact.session.session_key,
            Self::Turn(fact) => fact.turn.turn_key,
            Self::SourceRecord(fact) => fact.source_record_key,
            Self::EvidenceEvent(fact) => fact.common().event_key,
            Self::Capability(fact) => fact.capability_key,
            Self::CapabilityUse(fact) => fact.use_key,
        }
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TurnFactClosure {
    pub turn: TurnFact,
    pub revision: Option<[u8; 32]>,
    pub source_records: Vec<SourceRecordFact>,
    pub evidence_events: Vec<EvidenceEvent>,
    pub turn_evidence: Vec<TurnEvidenceFact>,
    pub capabilities: Vec<CapabilityFact>,
    pub capability_uses: Vec<CapabilityUseFact>,
    pub capability_use_evidence: Vec<CapabilityUseEvidenceFact>,
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct SessionFactSnapshot {
    #[serde(skip)]
    pub snapshot_seq: String,
    pub fact_schema_version: u8,
    pub session: SessionFact,
    pub turns: Vec<TurnFact>,
    pub turn_revisions: BTreeMap<StableKey, Option<[u8; 32]>>,
    pub source_records: Vec<SourceRecordFact>,
    pub evidence_events: Vec<EvidenceEvent>,
    pub turn_evidence: Vec<TurnEvidenceFact>,
    pub capabilities: Vec<CapabilityFact>,
    pub capability_uses: Vec<CapabilityUseFact>,
    pub capability_use_evidence: Vec<CapabilityUseEvidenceFact>,
    pub diagnostics: Vec<DiagnosticFact>,
    pub coverage: BTreeMap<String, u64>,
}

impl SessionFactSnapshot {
    pub fn turn_closure(&self, turn_key: &StableKey) -> Option<TurnFactClosure> {
        let turn = self
            .turns
            .iter()
            .find(|turn| turn.turn_key == *turn_key)?
            .clone();
        let mut evidence_events = self
            .evidence_events
            .iter()
            .filter(|event| event.common().occurred_turn_key == Some(*turn_key))
            .cloned()
            .collect::<Vec<_>>();
        evidence_events.sort_by_key(|event| event.common().event_key);
        let record_keys = evidence_events
            .iter()
            .map(|event| event.common().source_record_key)
            .collect::<BTreeSet<_>>();
        let source_records = self
            .source_records
            .iter()
            .filter(|record| record_keys.contains(&record.source_record_key))
            .cloned()
            .collect::<Vec<_>>();
        let mut turn_evidence = self
            .turn_evidence
            .iter()
            .filter(|link| link.turn_key == *turn_key)
            .cloned()
            .collect::<Vec<_>>();
        turn_evidence.sort_by_key(|link| (link.event_key, turn_evidence_role_rank(link.role)));
        let mut capability_uses = self
            .capability_uses
            .iter()
            .filter(|usage| usage.turn_key == *turn_key)
            .cloned()
            .collect::<Vec<_>>();
        capability_uses.sort_by_key(|usage| usage.use_key);
        let use_keys = capability_uses
            .iter()
            .map(|usage| usage.use_key)
            .collect::<BTreeSet<_>>();
        let mut capability_use_evidence = self
            .capability_use_evidence
            .iter()
            .filter(|link| use_keys.contains(&link.use_key))
            .cloned()
            .collect::<Vec<_>>();
        capability_use_evidence.sort_by_key(|link| {
            (
                link.use_key,
                link.event_key,
                capability_use_evidence_role_rank(link.role),
            )
        });
        let capability_keys = capability_uses
            .iter()
            .map(|usage| usage.capability_key)
            .collect::<BTreeSet<_>>();
        let capabilities = self
            .capabilities
            .iter()
            .filter(|capability| capability_keys.contains(&capability.capability_key))
            .cloned()
            .collect::<Vec<_>>();

        Some(TurnFactClosure {
            turn,
            revision: self.turn_revisions.get(turn_key).copied().flatten(),
            source_records,
            evidence_events,
            turn_evidence,
            capabilities,
            capability_uses,
            capability_use_evidence,
        })
    }

    pub fn semantic_digest(&self) -> Result<[u8; 32], StorageError> {
        semantic_digest(self)
    }
}

fn turn_evidence_role_rank(role: crate::fact_model::TurnEvidenceRole) -> u8 {
    match role {
        crate::fact_model::TurnEvidenceRole::Boundary => 0,
        crate::fact_model::TurnEvidenceRole::Corroboration => 1,
        crate::fact_model::TurnEvidenceRole::FollowUp => 2,
        crate::fact_model::TurnEvidenceRole::Lifecycle => 3,
        crate::fact_model::TurnEvidenceRole::Result => 4,
        crate::fact_model::TurnEvidenceRole::Rollback => 5,
    }
}

fn capability_use_evidence_role_rank(role: crate::fact_model::CapabilityUseEvidenceRole) -> u8 {
    match role {
        crate::fact_model::CapabilityUseEvidenceRole::Corroboration => 0,
        crate::fact_model::CapabilityUseEvidenceRole::Invocation => 1,
        crate::fact_model::CapabilityUseEvidenceRole::Result => 2,
    }
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct FactSnapshotPage {
    pub sessions: Vec<SessionFactSnapshot>,
    pub next_cursor: Option<StableKey>,
}

impl FactSnapshotPage {
    pub fn semantic_digest(&self) -> Result<[u8; 32], StorageError> {
        semantic_digest(&self.sessions)
    }
}

fn semantic_digest(value: &impl Serialize) -> Result<[u8; 32], StorageError> {
    let value = serde_json::to_value(value)
        .map_err(|error| StorageError::new("TS_INSIGHTS_STORAGE_FAILED", error.to_string()))?;
    let canonical = crate::try_canonical_json(&value).map_err(|_| {
        StorageError::new(
            "TS_INSIGHTS_STORAGE_FAILED",
            "logical Fact snapshot is outside the canonical JSON domain",
        )
    })?;
    Ok(Sha256::digest(canonical.as_bytes()).into())
}

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct CommittedSessionFacts {
    pub snapshot_seq: String,
    pub fact_schema_version: u8,
    pub session: SessionFact,
    pub checkpoint: Checkpoint,
    pub turns: Vec<TurnFact>,
    pub source_records: Vec<crate::fact_model::SourceRecordFact>,
    pub evidence_events: Vec<EvidenceEvent>,
    pub turn_evidence: Vec<TurnEvidenceFact>,
    pub capabilities: Vec<CapabilityFact>,
    pub capability_uses: Vec<CapabilityUseFact>,
    pub capability_use_evidence: Vec<CapabilityUseEvidenceFact>,
    pub diagnostics: Vec<DiagnosticFact>,
    pub coverage: BTreeMap<String, u64>,
}

pub trait FactRepository {
    fn apply_session_facts(
        &mut self,
        delta: crate::fact_model::SessionFactsDeltaV1,
    ) -> Result<CommitOutcome, StorageError>;

    fn read_turn_closure(
        &self,
        turn_key: &StableKey,
    ) -> Result<Option<TurnFactClosure>, StorageError> {
        let _ = turn_key;
        Err(unsupported_read())
    }

    fn scan_snapshot(
        &self,
        snapshot_seq: u64,
        after_session_key: Option<&StableKey>,
        limit: u16,
    ) -> Result<FactSnapshotPage, StorageError> {
        let _ = (snapshot_seq, after_session_key, limit);
        Err(unsupported_read())
    }

    fn lookup_stable_key(
        &self,
        kind: FactEntityKind,
        key: &StableKey,
    ) -> Result<Option<FactEntity>, StorageError> {
        let _ = (kind, key);
        Err(unsupported_read())
    }

    #[doc(hidden)]
    fn read_committed_session(
        &self,
        session_key: &StableKey,
    ) -> Result<Option<CommittedSessionFacts>, StorageError>;
}

fn unsupported_read() -> StorageError {
    StorageError::new(
        "TS_INSIGHTS_FACT_REPOSITORY_UNSUPPORTED",
        "Fact repository implementation does not expose logical snapshot reads",
    )
}
