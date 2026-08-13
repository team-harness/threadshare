use crate::protocol::{
    MessageKind, ProtocolError, V1_UPSERT_COLLECTIONS, upsert_collections_for_delta_format,
    validate_protocol_message,
};
use crate::storage::{CommitOutcome, EngineStorage, StorageError};
use crate::{hash_key, try_canonical_json};
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use std::collections::BTreeMap;
use std::fmt;

pub use crate::protocol::{RETRACTION_COLLECTIONS, V2_UPSERT_COLLECTIONS};
pub const UPSERT_COLLECTIONS: [&str; 7] = V1_UPSERT_COLLECTIONS;
pub const MAX_SESSION_FACTS: u64 = 1_000_000;

#[derive(Debug, Clone, PartialEq, Eq)]
pub struct EngineError {
    pub code: &'static str,
    pub category: &'static str,
    pub message: String,
    pub retryable: bool,
    pub fatal: bool,
}

impl EngineError {
    pub fn new(code: &'static str, category: &'static str, message: impl Into<String>) -> Self {
        Self {
            code,
            category,
            message: message.into(),
            retryable: false,
            fatal: false,
        }
    }
}

impl fmt::Display for EngineError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str(&self.message)
    }
}

impl std::error::Error for EngineError {}

impl From<StorageError> for EngineError {
    fn from(error: StorageError) -> Self {
        let category = match error.code {
            "TS_INSIGHTS_GENERATION_CONFLICT"
            | "TS_INSIGHTS_DELTA_ID_CONFLICT"
            | "TS_INSIGHTS_SOURCE_STATE_CONFLICT" => "conflict",
            "TS_INSIGHTS_STORAGE_FAILED"
            | "TS_INSIGHTS_STORAGE_CORRUPT"
            | "TS_INSIGHTS_WAL_BACKPRESSURE" => "storage",
            "TS_INSIGHTS_PURGE_PENDING" => "maintenance",
            _ => "validation",
        };
        let mut mapped = Self::new(error.code, category, error.message);
        mapped.retryable = matches!(
            mapped.code,
            "TS_INSIGHTS_WAL_BACKPRESSURE" | "TS_INSIGHTS_PURGE_PENDING"
        );
        mapped
    }
}

impl From<ProtocolError> for EngineError {
    fn from(error: ProtocolError) -> Self {
        let category = if error.code.contains("UNSUPPORTED") {
            "compatibility"
        } else {
            "protocol"
        };
        let mut mapped = Self::new(error.code, category, error.message);
        mapped.fatal = error.fatal;
        mapped
    }
}

fn object<'a>(value: &'a Value, name: &str) -> Result<&'a Map<String, Value>, EngineError> {
    value.as_object().ok_or_else(|| {
        EngineError::new(
            "TS_INSIGHTS_INVALID_DELTA",
            "validation",
            format!("{name} must be an object"),
        )
    })
}

fn string<'a>(value: &'a Value, name: &str) -> Result<&'a str, EngineError> {
    value.as_str().ok_or_else(|| {
        EngineError::new(
            "TS_INSIGHTS_INVALID_DELTA",
            "validation",
            format!("{name} must be a string"),
        )
    })
}

fn decimal(value: &Value, name: &str) -> Result<String, EngineError> {
    let value = string(value, name)?;
    if value != "0"
        && (value.is_empty()
            || value.starts_with('0')
            || !value.bytes().all(|byte| byte.is_ascii_digit()))
    {
        return Err(EngineError::new(
            "TS_INSIGHTS_INVALID_DELTA",
            "validation",
            format!("{name} must be a decimal string"),
        ));
    }
    Ok(value.to_owned())
}

fn field<'a>(object: &'a Map<String, Value>, name: &str) -> Result<&'a Value, EngineError> {
    object.get(name).ok_or_else(|| {
        EngineError::new(
            "TS_INSIGHTS_INVALID_DELTA",
            "validation",
            format!("missing {name}"),
        )
    })
}

#[derive(Debug)]
pub struct SessionAccumulator {
    begin: Value,
    provider: String,
    upsert_collections: &'static [&'static str],
    expected_counts: BTreeMap<String, usize>,
    received_counts: BTreeMap<String, usize>,
    canonical_fact_bytes: usize,
    next_sequence: u64,
    last_collection_rank: Option<usize>,
}

impl SessionAccumulator {
    pub fn begin(message: Value) -> Result<Self, EngineError> {
        if validate_protocol_message(&message)? != MessageKind::BeginSession {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "expected BEGIN_SESSION",
            ));
        }
        let root = object(&message, "BEGIN_SESSION")?;
        if string(field(root, "type")?, "type")? != "BEGIN_SESSION" {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "expected BEGIN_SESSION",
            ));
        }
        let delta_format = string(field(root, "deltaFormat")?, "deltaFormat")?;
        let upsert_collections =
            upsert_collections_for_delta_format(delta_format).ok_or_else(|| {
                EngineError::new(
                    "TS_INSIGHTS_INVALID_DELTA",
                    "validation",
                    "unsupported session Fact delta format",
                )
            })?;
        let counts = object(field(root, "counts")?, "counts")?;
        let mut expected_counts = BTreeMap::new();
        let mut total_fact_count = 0_u64;
        for collection in RETRACTION_COLLECTIONS
            .iter()
            .chain(upsert_collections.iter())
        {
            let count = decimal(field(counts, collection)?, collection)?
                .parse::<u64>()
                .map_err(|_| {
                    EngineError::new(
                        "TS_INSIGHTS_INVALID_DELTA",
                        "validation",
                        format!("{collection} count exceeds platform limits"),
                    )
                })?;
            total_fact_count = total_fact_count.checked_add(count).ok_or_else(|| {
                EngineError::new(
                    "TS_INSIGHTS_INVALID_DELTA",
                    "validation",
                    "BEGIN_SESSION total fact count exceeds 1000000",
                )
            })?;
            if total_fact_count > MAX_SESSION_FACTS {
                return Err(EngineError::new(
                    "TS_INSIGHTS_INVALID_DELTA",
                    "validation",
                    "BEGIN_SESSION total fact count exceeds 1000000",
                ));
            }
            let count = usize::try_from(count).map_err(|_| {
                EngineError::new(
                    "TS_INSIGHTS_INVALID_DELTA",
                    "validation",
                    format!("{collection} count exceeds platform limits"),
                )
            })?;
            expected_counts.insert((*collection).to_owned(), count);
        }
        let session_fact = field(root, "session")?;
        let provider = object(session_fact, "session")?
            .get("provider")
            .and_then(Value::as_str)
            .filter(|provider| !provider.is_empty())
            .ok_or_else(|| {
                EngineError::new(
                    "TS_INSIGHTS_INVALID_DELTA",
                    "validation",
                    "session provider must be a non-empty string",
                )
            })?
            .to_owned();
        let session_fact_bytes = try_canonical_json(session_fact)
            .map_err(|_| {
                EngineError::new(
                    "TS_INSIGHTS_INVALID_DELTA",
                    "validation",
                    "session fact is outside the canonical JSON domain",
                )
            })?
            .len();
        Ok(Self {
            begin: message,
            provider,
            upsert_collections,
            expected_counts,
            received_counts: BTreeMap::new(),
            canonical_fact_bytes: session_fact_bytes,
            next_sequence: 0,
            last_collection_rank: None,
        })
    }

    pub fn apply_batch(
        &mut self,
        message: &Value,
        storage: &mut EngineStorage,
    ) -> Result<(), EngineError> {
        if !matches!(
            validate_protocol_message(message)?,
            MessageKind::RetractFacts | MessageKind::UpsertFacts
        ) {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "expected RETRACT_FACTS or UPSERT_FACTS",
            ));
        }
        let root = object(message, "batch")?;
        let message_type = string(field(root, "type")?, "type")?;
        let collection = string(field(root, "collection")?, "collection")?;
        let allowed = match message_type {
            "RETRACT_FACTS" => &RETRACTION_COLLECTIONS[..],
            "UPSERT_FACTS" => self.upsert_collections,
            _ => {
                return Err(EngineError::new(
                    "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                    "protocol",
                    "expected RETRACT_FACTS or UPSERT_FACTS",
                ));
            }
        };
        if !allowed.contains(&collection) {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "batch collection does not match frame type",
            ));
        }
        let rank = RETRACTION_COLLECTIONS
            .iter()
            .chain(self.upsert_collections.iter())
            .position(|candidate| candidate == &collection)
            .expect("validated collection has a rank");
        if self.last_collection_rank.is_some_and(|prior| rank < prior) {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "batch collections must follow canonical order",
            ));
        }
        let sequence = decimal(field(root, "sequence")?, "sequence")?
            .parse::<u64>()
            .map_err(|_| {
                EngineError::new(
                    "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                    "protocol",
                    "batch sequence exceeds uint64",
                )
            })?;
        if sequence != self.next_sequence {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "batch sequence is not contiguous",
            ));
        }
        let items = field(root, "items")?.as_array().ok_or_else(|| {
            EngineError::new(
                "TS_INSIGHTS_INVALID_DELTA",
                "validation",
                "batch items must be an array",
            )
        })?;
        if items.is_empty() {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "empty batch frames are not allowed",
            ));
        }
        let expected = self.expected_counts[collection];
        let accumulated_count = self.received_counts.get(collection).copied().unwrap_or(0);
        let next_count = accumulated_count.checked_add(items.len()).ok_or_else(|| {
            EngineError::new(
                "TS_INSIGHTS_INVALID_DELTA",
                "validation",
                "batch count exceeds BEGIN_SESSION declaration",
            )
        })?;
        if next_count > expected {
            return Err(EngineError::new(
                "TS_INSIGHTS_INVALID_DELTA",
                "validation",
                "batch count exceeds BEGIN_SESSION declaration",
            ));
        }
        let staged = storage
            .stage_session_fact_batch(
                collection,
                accumulated_count,
                items,
                self.session_key(),
                &self.provider,
            )
            .map_err(EngineError::from)?;
        let next_fact_bytes = self
            .canonical_fact_bytes
            .checked_add(staged.canonical_bytes)
            .ok_or_else(|| {
                EngineError::new(
                    "TS_INSIGHTS_INVALID_DELTA",
                    "validation",
                    "session fact byte count exceeds platform limits",
                )
            })?;

        self.received_counts
            .insert(collection.to_owned(), next_count);
        self.canonical_fact_bytes = next_fact_bytes;
        self.next_sequence = self.next_sequence.checked_add(1).ok_or_else(|| {
            EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "batch sequence exceeds uint64",
            )
        })?;
        self.last_collection_rank = Some(rank);
        Ok(())
    }

    pub fn request_id(&self) -> &str {
        self.begin
            .get("requestId")
            .and_then(Value::as_str)
            .expect("validated BEGIN_SESSION has requestId")
    }

    pub fn session_key(&self) -> &str {
        self.begin
            .get("session")
            .and_then(Value::as_object)
            .and_then(|session| session.get("sessionKey"))
            .and_then(Value::as_str)
            .expect("validated BEGIN_SESSION has sessionKey")
    }

    pub fn delta_id(&self) -> &str {
        self.begin
            .get("deltaId")
            .and_then(Value::as_str)
            .expect("validated BEGIN_SESSION has deltaId")
    }

    pub fn next_sequence(&self) -> String {
        self.next_sequence.to_string()
    }

    pub fn finish(
        self,
        commit: &Value,
        storage: &mut EngineStorage,
    ) -> Result<CommitOutcome, EngineError> {
        if validate_protocol_message(commit)? != MessageKind::CommitSession {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "expected COMMIT_SESSION",
            ));
        }
        let commit_root = object(commit, "COMMIT_SESSION")?;
        if string(field(commit_root, "type")?, "type")? != "COMMIT_SESSION" {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "expected COMMIT_SESSION",
            ));
        }
        let next_sequence = decimal(field(commit_root, "nextSequence")?, "nextSequence")?
            .parse::<u64>()
            .map_err(|_| {
                EngineError::new(
                    "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                    "protocol",
                    "nextSequence exceeds uint64",
                )
            })?;
        if next_sequence != self.next_sequence {
            return Err(EngineError::new(
                "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                "protocol",
                "COMMIT_SESSION nextSequence does not match received batches",
            ));
        }
        for (collection, expected) in &self.expected_counts {
            let actual = self.received_counts.get(collection).copied().unwrap_or(0);
            if actual != *expected {
                return Err(EngineError::new(
                    "TS_INSIGHTS_INVALID_DELTA",
                    "validation",
                    format!("{collection} count does not match BEGIN_SESSION"),
                ));
            }
        }

        let begin = object(&self.begin, "BEGIN_SESSION")?;
        let contract = object(field(begin, "contract")?, "contract")?;
        let session = field(begin, "session")?.clone();
        let delta_id = string(field(begin, "deltaId")?, "deltaId")?;
        let expected_generation =
            decimal(field(begin, "expectedGeneration")?, "expectedGeneration")?;
        let target_generation = decimal(field(begin, "targetGeneration")?, "targetGeneration")?;
        let mode = string(field(begin, "mode")?, "mode")?;
        let checkpoint = field(commit_root, "checkpoint")?.clone();

        let mut delta = Map::new();
        delta.insert("format".to_owned(), field(begin, "deltaFormat")?.clone());
        for (target, source) in [
            ("factSchemaVersion", "factSchemaVersion"),
            ("providerAdapterVersion", "providerAdapterVersion"),
            ("privacyPolicyVersion", "privacyPolicyVersion"),
            ("originSecretEpoch", "originSecretEpoch"),
            ("duplicatePolicyVersion", "duplicatePolicyVersion"),
        ] {
            delta.insert(target.to_owned(), field(contract, source)?.clone());
        }
        delta.insert(
            "expectedGeneration".to_owned(),
            Value::String(expected_generation.clone()),
        );
        delta.insert(
            "targetGeneration".to_owned(),
            Value::String(target_generation.clone()),
        );
        delta.insert("mode".to_owned(), Value::String(mode.to_owned()));
        delta.insert("deltaId".to_owned(), Value::String(delta_id.to_owned()));
        delta.insert("session".to_owned(), session);
        delta.insert(
            "retractions".to_owned(),
            json!({
                "turnKeys": [],
                "orphanEventKeys": [],
                "authoritativeTurnKeys": [],
            }),
        );
        for collection in self.upsert_collections {
            delta.insert((*collection).to_owned(), Value::Array(Vec::new()));
        }
        delta.insert("checkpoint".to_owned(), checkpoint.clone());
        delta.insert(
            "diagnostics".to_owned(),
            field(commit_root, "diagnostics")?.clone(),
        );
        delta.insert(
            "coverage".to_owned(),
            field(commit_root, "coverage")?.clone(),
        );
        let delta = Value::Object(delta);
        let staged = storage
            .prepare_staged_session_facts(delta)
            .map_err(EngineError::from)?;
        storage
            .apply_staged_session_facts(staged)
            .map_err(EngineError::from)
    }
}

pub fn verify_delta_id(delta: &Value) -> Result<(), EngineError> {
    let root = object(delta, "delta")?;
    let claimed = string(field(root, "deltaId")?, "deltaId")?;
    let session_key = string(
        field(object(field(root, "session")?, "session")?, "sessionKey")?,
        "sessionKey",
    )?;
    let session_bytes = hex::decode(session_key).map_err(|_| {
        EngineError::new(
            "TS_INSIGHTS_INVALID_STABLE_KEY",
            "validation",
            "sessionKey must be lowercase 32-byte hex",
        )
    })?;
    let mut mutation = delta.clone();
    mutation
        .as_object_mut()
        .expect("validated object")
        .remove("deltaId");
    let mutation = try_canonical_json(&mutation).map_err(|_| {
        EngineError::new(
            "TS_INSIGHTS_INVALID_DELTA",
            "validation",
            "delta is outside the canonical JSON domain",
        )
    })?;
    let mutation_digest = Sha256::digest(mutation.as_bytes()).to_vec();
    let checkpoint = object(field(root, "checkpoint")?, "checkpoint")?;
    let expected = hash_key(
        "delta",
        &[
            session_bytes,
            string(field(root, "expectedGeneration")?, "expectedGeneration")?
                .as_bytes()
                .to_vec(),
            string(field(root, "mode")?, "mode")?.as_bytes().to_vec(),
            string(field(root, "originSecretEpoch")?, "originSecretEpoch")?
                .as_bytes()
                .to_vec(),
            field(root, "duplicatePolicyVersion")?
                .as_u64()
                .ok_or_else(|| {
                    EngineError::new(
                        "TS_INSIGHTS_INVALID_DELTA",
                        "validation",
                        "duplicatePolicyVersion must be an integer",
                    )
                })?
                .to_string()
                .into_bytes(),
            mutation_digest,
            string(field(checkpoint, "completeOffset")?, "completeOffset")?
                .as_bytes()
                .to_vec(),
        ],
    );
    if claimed != expected {
        return Err(EngineError::new(
            "TS_INSIGHTS_INVALID_DELTA_ID",
            "validation",
            "deltaId does not match canonical mutation",
        ));
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::{
        MAX_SESSION_FACTS, RETRACTION_COLLECTIONS, SessionAccumulator, UPSERT_COLLECTIONS,
    };
    use crate::storage::EngineStorage;
    use serde_json::{Value, json};

    fn fixture_message(name: &str) -> Value {
        let fixture: Value = serde_json::from_str(include_str!(
            "../../../test/fixtures/insights-protocol-v1/frames.json"
        ))
        .unwrap();
        fixture["frames"]
            .as_array()
            .unwrap()
            .iter()
            .find(|frame| frame["name"].as_str() == Some(name))
            .unwrap()["message"]
            .clone()
    }

    fn begin_with_zero_counts() -> Value {
        let mut begin = fixture_message("begin-session");
        for collection in RETRACTION_COLLECTIONS
            .iter()
            .chain(UPSERT_COLLECTIONS.iter())
        {
            begin["counts"][collection] = Value::String("0".to_owned());
        }
        begin
    }

    #[test]
    fn bounds_total_declared_session_fact_count() {
        let mut at_limit = begin_with_zero_counts();
        at_limit["counts"]["turns"] = Value::String(MAX_SESSION_FACTS.to_string());
        SessionAccumulator::begin(at_limit.clone()).unwrap();

        at_limit["counts"]["turnKeys"] = Value::String("1".to_owned());
        let error = SessionAccumulator::begin(at_limit).unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_INVALID_DELTA");
        assert_eq!(error.category, "validation");
        assert_eq!(
            error.message,
            "BEGIN_SESSION total fact count exceeds 1000000"
        );
    }

    #[test]
    fn rejects_a_missing_or_invalid_begin_session_provider_without_panicking() {
        for provider in [
            Value::Null,
            Value::Number(7.into()),
            Value::String(String::new()),
        ] {
            let mut begin = begin_with_zero_counts();
            begin["session"]["provider"] = provider;
            let error = SessionAccumulator::begin(begin).unwrap_err();
            assert_eq!(error.code, "TS_INSIGHTS_INVALID_DELTA");
            assert_eq!(error.category, "validation");
            assert_eq!(error.message, "session provider must be a non-empty string");
        }

        let mut begin = begin_with_zero_counts();
        begin["session"].as_object_mut().unwrap().remove("provider");
        let error = SessionAccumulator::begin(begin).unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_INVALID_DELTA");
        assert_eq!(error.category, "validation");
        assert_eq!(error.message, "session provider must be a non-empty string");
    }

    #[test]
    fn accepts_more_than_32_mib_across_protocol_sized_batches() {
        let mut begin = begin_with_zero_counts();
        const TURN_COUNT: usize = 513;
        begin["counts"]["turns"] = Value::String(TURN_COUNT.to_string());
        let mut accumulator = SessionAccumulator::begin(begin).unwrap();
        let mut storage = EngineStorage::open_in_memory().unwrap();
        let problem_text = "x".repeat(64 * 1_024);
        for index in 0..TURN_COUNT {
            let item = json!({
                "turnKey": format!("{index:064x}"),
                "ownerSessionKey": "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa",
                "turnStartOffset": index.to_string(),
                "problemText": problem_text,
                "finalAnswerExcerpt": null,
                "observedTimestamp": null,
                "rawClosure": {
                    "nextUserBoundary": false,
                    "providerTerminal": "completed",
                    "observedEofClosed": false
                },
                "providerVisibility": "active",
                "factTruncation": []
            });
            accumulator
                .apply_batch(
                    &json!({
                        "format": "threadshare-insights-protocol@v1",
                        "type": "UPSERT_FACTS",
                        "requestId": "2",
                        "sequence": index.to_string(),
                        "collection": "turns",
                        "items": [item],
                    }),
                    &mut storage,
                )
                .unwrap();
        }
        assert!(accumulator.canonical_fact_bytes > 32 * 1024 * 1024);
        assert_eq!(accumulator.received_counts["turns"], TURN_COUNT);
        assert_eq!(
            storage.staged_session_fact_count("turns").unwrap(),
            TURN_COUNT
        );
        assert_eq!(accumulator.next_sequence, TURN_COUNT as u64);
    }

    #[test]
    fn v1_session_rejects_v2_fact_collections() {
        let begin = begin_with_zero_counts();
        let mut accumulator = SessionAccumulator::begin(begin).unwrap();
        let mut storage = EngineStorage::open_in_memory().unwrap();
        let error = accumulator
            .apply_batch(
                &json!({
                    "format": "threadshare-insights-protocol@v1",
                    "type": "UPSERT_FACTS",
                    "requestId": "2",
                    "sequence": "0",
                    "collection": "historyEvents",
                    "items": [{}],
                }),
                &mut storage,
            )
            .unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME");
    }
}
