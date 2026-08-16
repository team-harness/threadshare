use crate::delivery_graph_repository::{TRACE_SOURCE_DELTA_FORMAT, TraceSourceDeltaV1};
use crate::engine::EngineError;
use crate::protocol::{MessageKind, request_id, validate_protocol_message};
use crate::storage::{CommitOutcome, EngineStorage};
use crate::trace_staging::{
    MAX_TRACE_STAGING_PAYLOAD_BYTES, TraceSourceCounts, TraceSourceMetadata,
};
use serde_json::Value;
use std::collections::BTreeMap;

const TRACE_COLLECTIONS: [&str; 5] = ["refs", "commits", "files", "intentNodes", "intentRefs"];

#[derive(Debug)]
pub struct TraceSourceAccumulator {
    request_id: String,
    metadata: TraceSourceMetadata,
    expected_counts: BTreeMap<String, usize>,
    received_counts: BTreeMap<String, usize>,
    staged_payload_bytes: usize,
    next_sequence: u64,
    last_collection_rank: Option<usize>,
}

fn invalid(message: impl Into<String>) -> EngineError {
    EngineError::new("TS_INSIGHTS_INVALID_DELTA", "validation", message)
}

impl TraceSourceAccumulator {
    pub fn begin(message: Value) -> Result<Self, EngineError> {
        if validate_protocol_message(&message)? != MessageKind::BeginTraceSource {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "expected BEGIN_TRACE_SOURCE",
            ));
        }
        let repository = serde_json::from_value(message["repository"].clone())
            .map_err(|_| invalid("trace source repository is invalid"))?;
        let counts: TraceSourceCounts = serde_json::from_value(message["counts"].clone())
            .map_err(|_| invalid("trace source counts are invalid"))?;
        let metadata = TraceSourceMetadata {
            delta_id: message["deltaId"]
                .as_str()
                .ok_or_else(|| invalid("trace source deltaId is invalid"))?
                .to_owned(),
            expected_generation: message["expectedGeneration"]
                .as_str()
                .ok_or_else(|| invalid("trace source expected generation is invalid"))?
                .to_owned(),
            target_generation: message["targetGeneration"]
                .as_str()
                .ok_or_else(|| invalid("trace source target generation is invalid"))?
                .to_owned(),
            repository,
            intent: serde_json::from_value(message["intent"].clone())
                .map_err(|_| invalid("trace intent source is invalid"))?,
            counts,
        };
        TraceSourceDeltaV1 {
            format: TRACE_SOURCE_DELTA_FORMAT.to_owned(),
            delta_id: metadata.delta_id.clone(),
            expected_generation: metadata.expected_generation.clone(),
            target_generation: metadata.target_generation.clone(),
            repository: metadata.repository.clone(),
            intent: metadata.intent.clone(),
            refs: vec![],
            commits: vec![],
            intent_nodes: vec![],
            intent_refs: vec![],
        }
        .validate()?;
        let mut expected_counts = BTreeMap::new();
        for collection in TRACE_COLLECTIONS {
            expected_counts.insert(collection.to_owned(), metadata.expected_count(collection)?);
        }
        if expected_counts["refs"] > 100_000
            || expected_counts["commits"] > 50_000
            || expected_counts["files"] > 2_000_000
            || expected_counts["intentNodes"] > 10_000
            || expected_counts["intentRefs"] > 100_000
        {
            return Err(invalid("trace source count exceeds its bounded limit"));
        }
        Ok(Self {
            request_id: request_id(&message)?.to_owned(),
            metadata,
            expected_counts,
            received_counts: BTreeMap::new(),
            staged_payload_bytes: 0,
            next_sequence: 0,
            last_collection_rank: None,
        })
    }

    pub fn apply_batch(
        &mut self,
        message: &Value,
        storage: &mut EngineStorage,
    ) -> Result<(), EngineError> {
        if validate_protocol_message(message)? != MessageKind::TraceSourceBatch {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "expected TRACE_SOURCE_BATCH",
            ));
        }
        let sequence = message["sequence"]
            .as_str()
            .and_then(|value| value.parse::<u64>().ok())
            .ok_or_else(|| invalid("trace source batch sequence is invalid"))?;
        if sequence != self.next_sequence {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "TRACE_SOURCE_BATCH sequence is not contiguous",
            ));
        }
        let collection = message["collection"]
            .as_str()
            .ok_or_else(|| invalid("trace source collection is invalid"))?;
        let rank = TRACE_COLLECTIONS
            .iter()
            .position(|value| *value == collection)
            .ok_or_else(|| invalid("trace source collection is invalid"))?;
        if self
            .last_collection_rank
            .is_some_and(|previous| rank < previous)
        {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "trace source collections must be sent in canonical order",
            ));
        }
        let items = message["items"]
            .as_array()
            .ok_or_else(|| invalid("trace source batch items are invalid"))?;
        let received = self.received_counts.get(collection).copied().unwrap_or(0);
        let next_received = received
            .checked_add(items.len())
            .ok_or_else(|| invalid("trace source count exceeds platform limits"))?;
        if next_received > self.expected_counts[collection] {
            return Err(invalid(format!(
                "{collection} exceeds its BEGIN_TRACE_SOURCE count"
            )));
        }
        let outcome = storage.stage_trace_source_batch(collection, received, items)?;
        self.staged_payload_bytes = self
            .staged_payload_bytes
            .checked_add(outcome.canonical_bytes)
            .ok_or_else(|| invalid("trace source payload exceeds platform limits"))?;
        if self.staged_payload_bytes > MAX_TRACE_STAGING_PAYLOAD_BYTES {
            return Err(invalid(
                "trace source staging exceeds the 512 MiB logical payload budget",
            ));
        }
        self.received_counts
            .insert(collection.to_owned(), next_received);
        self.last_collection_rank = Some(rank);
        self.next_sequence = self
            .next_sequence
            .checked_add(1)
            .ok_or_else(|| invalid("trace source sequence exceeds uint64"))?;
        Ok(())
    }

    pub fn finish(
        self,
        message: &Value,
        storage: &mut EngineStorage,
    ) -> Result<CommitOutcome, EngineError> {
        if validate_protocol_message(message)? != MessageKind::CommitTraceSource {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "expected COMMIT_TRACE_SOURCE",
            ));
        }
        if message["nextSequence"].as_str() != Some(self.next_sequence().as_str()) {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "COMMIT_TRACE_SOURCE nextSequence does not match received batches",
            ));
        }
        for collection in TRACE_COLLECTIONS {
            if self.received_counts.get(collection).copied().unwrap_or(0)
                != self.expected_counts[collection]
            {
                return Err(invalid(format!(
                    "{collection} count does not match BEGIN_TRACE_SOURCE"
                )));
            }
        }
        storage
            .apply_staged_trace_source(&self.metadata)
            .map_err(Into::into)
    }

    pub fn request_id(&self) -> &str {
        &self.request_id
    }

    pub fn repository_key(&self) -> &str {
        &self.metadata.repository.repository_key
    }

    pub fn delta_id(&self) -> &str {
        &self.metadata.delta_id
    }

    pub fn next_sequence(&self) -> String {
        self.next_sequence.to_string()
    }
}
