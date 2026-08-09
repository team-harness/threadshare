use serde_json::{Value, json};
use sha2::{Digest, Sha256};
use std::env;
use std::fs;
use std::io::{self, BufReader, BufWriter, Read, Write};
use std::path::PathBuf;
use threadshare_insights_engine::canonical_json;
use threadshare_insights_engine::engine::{EngineError, SessionAccumulator};
use threadshare_insights_engine::protocol::{
    MAX_FRAME_BYTES, MessageKind, PROTOCOL_FORMAT, PROTOCOL_VERSION, ProtocolError,
    accepted_contract_from_hello, bounded_message, read_frame, request_id,
    validate_begin_against_contract, validate_protocol_message, write_frame,
};
use threadshare_insights_engine::storage::EngineStorage;

const ENGINE_VERSION: &str = match option_env!("THREADSHARE_RELEASE_VERSION") {
    Some(version) => version,
    None => env!("CARGO_PKG_VERSION"),
};
const ENGINE_TARGET: &str = match option_env!("THREADSHARE_ENGINE_TARGET") {
    Some(target) => target,
    None => "development",
};

#[derive(Debug)]
enum State {
    AwaitHello,
    Ready {
        accepted_contract: Value,
    },
    InSession {
        accepted_contract: Value,
        accumulator: SessionAccumulator,
    },
}

struct EngineServer {
    storage: EngineStorage,
    state: State,
}

fn adjacent_build_manifest_digest() -> Result<Option<String>, EngineError> {
    let executable = env::current_exe().map_err(|_| {
        EngineError::new(
            "TS_INSIGHTS_ENGINE_INVALID",
            "storage",
            "Engine executable identity is unavailable",
        )
    })?;
    let Some(package_root) = executable.parent().and_then(|bin| bin.parent()) else {
        return Ok(None);
    };
    let manifest_path = package_root.join("build-manifest.json");
    let bytes = match fs::read(manifest_path) {
        Ok(value) => value,
        Err(error) if error.kind() == io::ErrorKind::NotFound => return Ok(None),
        Err(_) => {
            return Err(EngineError::new(
                "TS_INSIGHTS_ENGINE_INVALID",
                "storage",
                "Engine build manifest is unreadable",
            ));
        }
    };
    let document: Value = serde_json::from_slice(&bytes).map_err(|_| {
        EngineError::new(
            "TS_INSIGHTS_ENGINE_INVALID",
            "storage",
            "Engine build manifest is invalid",
        )
    })?;
    if canonical_json(&document).as_bytes() != bytes {
        return Err(EngineError::new(
            "TS_INSIGHTS_ENGINE_INVALID",
            "storage",
            "Engine build manifest is not canonical JSON",
        ));
    }
    Ok(Some(hex::encode(Sha256::digest(bytes))))
}

fn build_manifest_digest(storage: &EngineStorage) -> Result<String, EngineError> {
    if let Some(value) = adjacent_build_manifest_digest()? {
        return Ok(value);
    }
    let identity = json!({
        "engineVersion": ENGINE_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "sqliteCompileOptionsDigest": storage.compile_options_digest()?,
        "sqliteVersion": storage.sqlite_version(),
        "target": ENGINE_TARGET,
    });
    Ok(hex::encode(Sha256::digest(
        canonical_json(&identity).as_bytes(),
    )))
}

fn version_document(storage: &EngineStorage) -> Result<Value, EngineError> {
    Ok(json!({
        "format": "threadshare-insights-engine-version@v1",
        "engineVersion": ENGINE_VERSION,
        "protocolVersion": PROTOCOL_VERSION,
        "target": ENGINE_TARGET,
        "sqliteVersion": storage.sqlite_version(),
        "sqliteCompileOptionsDigest": storage.compile_options_digest()?,
        "buildManifestDigest": build_manifest_digest(storage)?,
    }))
}

fn ready_message(
    storage: &EngineStorage,
    request_id: &str,
    accepted_contract: Value,
) -> Result<Value, EngineError> {
    Ok(json!({
        "format": PROTOCOL_FORMAT,
        "type": "READY",
        "requestId": request_id,
        "engineVersion": ENGINE_VERSION,
        "target": ENGINE_TARGET,
        "maxFrameBytes": MAX_FRAME_BYTES,
        "sqliteVersion": storage.sqlite_version(),
        "sqliteCompileOptionsDigest": storage.compile_options_digest()?,
        "buildManifestDigest": build_manifest_digest(storage)?,
        "acceptedContract": accepted_contract,
    }))
}

fn engine_error_response(error: &EngineError, request_id: &str) -> Value {
    json!({
        "format": PROTOCOL_FORMAT,
        "type": "ERROR",
        "requestId": request_id,
        "code": error.code,
        "category": error.category,
        "message": bounded_message(&error.message),
        "retryable": error.retryable,
        "fatal": error.fatal,
    })
}

fn fatal(mut error: EngineError) -> EngineError {
    error.fatal = true;
    error
}

impl EngineServer {
    fn new(storage: EngineStorage) -> Result<Self, EngineError> {
        storage.verify_sqlite_contract()?;
        Ok(Self {
            storage,
            state: State::AwaitHello,
        })
    }

    fn handle_message(&mut self, message: Value) -> Result<Value, EngineError> {
        let kind = validate_protocol_message(&message)?;
        let state = std::mem::replace(&mut self.state, State::AwaitHello);
        match state {
            State::AwaitHello => {
                let result = (|| {
                    if kind != MessageKind::Hello {
                        return Err(EngineError::new(
                            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                            "protocol",
                            "the first frame must be HELLO",
                        ));
                    }
                    let request_id = request_id(&message)?.to_owned();
                    let accepted_contract = accepted_contract_from_hello(&message)?;
                    let response =
                        ready_message(&self.storage, &request_id, accepted_contract.clone())?;
                    Ok((State::Ready { accepted_contract }, response))
                })();
                match result {
                    Ok((state, response)) => {
                        self.state = state;
                        Ok(response)
                    }
                    Err(error) => {
                        self.state = State::AwaitHello;
                        Err(fatal(error))
                    }
                }
            }
            State::Ready { accepted_contract } => {
                let result = (|| {
                    if kind != MessageKind::BeginSession {
                        return Err(EngineError::new(
                            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                            "protocol",
                            "READY state requires BEGIN_SESSION",
                        ));
                    }
                    validate_begin_against_contract(&message, &accepted_contract)?;
                    let request_id = request_id(&message)?.to_owned();
                    let session_key = message["session"]["sessionKey"].clone();
                    let delta_id = message["deltaId"].clone();
                    let accumulator = SessionAccumulator::begin(message)?;
                    Ok((
                        State::InSession {
                            accepted_contract: accepted_contract.clone(),
                            accumulator,
                        },
                        json!({
                            "format": PROTOCOL_FORMAT,
                            "type": "SESSION_ACCEPTED",
                            "requestId": request_id,
                            "sessionKey": session_key,
                            "deltaId": delta_id,
                            "nextSequence": "0",
                        }),
                    ))
                })();
                match result {
                    Ok((state, response)) => {
                        self.state = state;
                        Ok(response)
                    }
                    Err(error) => {
                        self.state = State::Ready { accepted_contract };
                        Err(error)
                    }
                }
            }
            State::InSession {
                accepted_contract,
                mut accumulator,
            } => {
                let result = (|| {
                    let message_request_id = request_id(&message)?;
                    if message_request_id != accumulator.request_id() {
                        return Err(EngineError::new(
                            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                            "protocol",
                            "session requestId does not match BEGIN_SESSION",
                        ));
                    }
                    match kind {
                        MessageKind::RetractFacts | MessageKind::UpsertFacts => {
                            accumulator.apply_batch(&message)?;
                            let sequence = message["sequence"].clone();
                            Ok((
                                State::InSession {
                                    accepted_contract: accepted_contract.clone(),
                                    accumulator,
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "BATCH_ACCEPTED",
                                    "requestId": message_request_id,
                                    "sequence": sequence,
                                }),
                            ))
                        }
                        MessageKind::CommitSession => {
                            let outcome = accumulator.finish(&message, &mut self.storage)?;
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "SESSION_COMMITTED",
                                    "requestId": message_request_id,
                                    "sessionKey": outcome.session_key,
                                    "deltaId": outcome.delta_id,
                                    "snapshotSeq": outcome.snapshot_seq,
                                    "idempotent": outcome.idempotent,
                                }),
                            ))
                        }
                        MessageKind::AbortSession => {
                            let next_sequence = accumulator.next_sequence();
                            if message["nextSequence"].as_str() != Some(next_sequence.as_str()) {
                                return Err(EngineError::new(
                                    "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                                    "protocol",
                                    "ABORT_SESSION nextSequence does not match received batches",
                                ));
                            }
                            Ok((
                                State::Ready {
                                    accepted_contract: accepted_contract.clone(),
                                },
                                json!({
                                    "format": PROTOCOL_FORMAT,
                                    "type": "SESSION_ABORTED",
                                    "requestId": message_request_id,
                                    "sessionKey": accumulator.session_key(),
                                    "deltaId": accumulator.delta_id(),
                                    "nextSequence": next_sequence,
                                }),
                            ))
                        }
                        _ => Err(EngineError::new(
                            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
                            "protocol",
                            "unexpected frame during session ingestion",
                        )),
                    }
                })();
                match result {
                    Ok((state, response)) => {
                        self.state = state;
                        Ok(response)
                    }
                    Err(error) => {
                        // Session facts live only in the accumulator until COMMIT_SESSION.
                        self.state = State::Ready { accepted_contract };
                        Err(error)
                    }
                }
            }
        }
    }
}

fn parse_arguments() -> Result<(bool, Option<PathBuf>), String> {
    let mut version = false;
    let mut json_output = false;
    let mut database = None;
    let mut arguments = env::args().skip(1);
    while let Some(argument) = arguments.next() {
        match argument.as_str() {
            "--version" => version = true,
            "--json" => json_output = true,
            "--db" => {
                let value = arguments.next().ok_or("--db requires a path")?;
                database = Some(PathBuf::from(value));
            }
            _ => return Err("unsupported Engine argument".to_owned()),
        }
    }
    if json_output && !version {
        return Err("--json requires --version".to_owned());
    }
    Ok((version, database))
}

fn run_server_stream<R: Read, W: Write>(
    reader: &mut R,
    writer: &mut W,
    storage: EngineStorage,
) -> Result<(), ProtocolError> {
    let mut server = EngineServer::new(storage).map_err(|error| {
        ProtocolError::new(error.code, "the bundled SQLite contract is invalid", true)
    })?;
    while let Some(message) = read_frame(reader)? {
        let message_request_id = request_id(&message).unwrap_or("0").to_owned();
        match server.handle_message(message) {
            Ok(response) => write_frame(writer, &response)?,
            Err(error) => {
                let fatal = error.fatal;
                write_frame(writer, &engine_error_response(&error, &message_request_id))?;
                if fatal {
                    return Ok(());
                }
            }
        }
    }
    Ok(())
}

fn run_server(storage: EngineStorage) -> Result<(), ProtocolError> {
    let stdin = io::stdin();
    let stdout = io::stdout();
    let mut reader = BufReader::new(stdin.lock());
    let mut writer = BufWriter::new(stdout.lock());
    run_server_stream(&mut reader, &mut writer, storage)
}

fn main() {
    let (show_version, database) = match parse_arguments() {
        Ok(value) => value,
        Err(message) => {
            eprintln!("{message}");
            std::process::exit(2);
        }
    };
    let storage = match database {
        Some(path) => EngineStorage::open(&path),
        None => EngineStorage::open_in_memory(),
    };
    let storage = match storage {
        Ok(value) => value,
        Err(_) => {
            eprintln!("Insights Engine storage initialization failed");
            std::process::exit(1);
        }
    };
    if show_version {
        match version_document(&storage) {
            Ok(value) => println!("{}", canonical_json(&value)),
            Err(_) => {
                eprintln!("Insights Engine version probe failed");
                std::process::exit(1);
            }
        }
        return;
    }
    if run_server(storage).is_err() {
        std::process::exit(1);
    }
}

#[cfg(test)]
mod tests {
    use super::{EngineServer, State};
    use serde::Deserialize;
    use serde_json::{Value, json};
    use std::fs;
    use std::path::PathBuf;
    use threadshare_insights_engine::storage::EngineStorage;

    #[derive(Deserialize)]
    struct Fixture {
        frames: Vec<FrameVector>,
    }

    #[derive(Deserialize)]
    struct FrameVector {
        name: String,
        message: Value,
    }

    fn message(name: &str) -> Value {
        let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
            .join("../../test/fixtures/insights-protocol-v1/frames.json");
        let fixture: Fixture = serde_json::from_str(&fs::read_to_string(path).unwrap()).unwrap();
        fixture
            .frames
            .into_iter()
            .find(|frame| frame.name == name)
            .unwrap()
            .message
    }

    fn server() -> EngineServer {
        EngineServer::new(EngineStorage::open_in_memory().unwrap()).unwrap()
    }

    #[test]
    fn handshake_contract_is_preserved_and_begin_must_match_it() {
        let mut server = server();
        let ready = server.handle_message(message("hello")).unwrap();
        assert_eq!(ready["type"], "READY");

        let mut incompatible = message("begin-session");
        incompatible["contract"]["originSecretEpoch"] =
            Value::String("aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee".to_owned());
        let error = server.handle_message(incompatible).unwrap_err();
        assert_eq!(error.code, "TS_INSIGHTS_PROTOCOL_CONTRACT_UNSUPPORTED");
        assert!(matches!(server.state, State::Ready { .. }));

        let accepted = server.handle_message(message("begin-session")).unwrap();
        assert_eq!(accepted["type"], "SESSION_ACCEPTED");
    }

    #[test]
    fn abort_discards_staged_facts_without_committing() {
        let mut server = server();
        server.handle_message(message("hello")).unwrap();
        server.handle_message(message("begin-session")).unwrap();
        let batch = server.handle_message(message("retract-facts")).unwrap();
        assert_eq!(batch["type"], "BATCH_ACCEPTED");
        let response = server
            .handle_message(json!({
                "format": "threadshare-insights-protocol@v1",
                "type": "ABORT_SESSION",
                "requestId": "2",
                "nextSequence": "1",
                "reason": "cancelled",
            }))
            .unwrap();
        assert_eq!(response["type"], "SESSION_ABORTED");
        assert_eq!(server.storage.committed_session_count().unwrap(), 0);
        assert!(matches!(server.state, State::Ready { .. }));
    }

    #[test]
    fn disconnect_before_commit_leaves_storage_unchanged() {
        let mut server = server();
        server.handle_message(message("hello")).unwrap();
        server.handle_message(message("begin-session")).unwrap();
        server.handle_message(message("retract-facts")).unwrap();
        assert!(matches!(server.state, State::InSession { .. }));
        assert_eq!(server.storage.committed_session_count().unwrap(), 0);
        drop(server);
    }
}
