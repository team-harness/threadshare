import { TextDecoder } from "node:util";

import { canonicalJson } from "./canonical-json.mjs";

export const INSIGHTS_PROTOCOL_FORMAT = "threadshare-insights-protocol@v1";
export const INSIGHTS_PROTOCOL_VERSION = 1;
export const MAX_PROTOCOL_PAYLOAD_BYTES = 4_194_304;

export const RETRACTION_COLLECTION_ORDER = Object.freeze([
  "turnKeys",
  "orphanEventKeys",
  "authoritativeTurnKeys",
]);

export const UPSERT_COLLECTION_ORDER = Object.freeze([
  "turns",
  "sourceRecords",
  "evidenceEvents",
  "turnEvidence",
  "capabilities",
  "capabilityUses",
  "capabilityUseEvidence",
]);

const MESSAGE_TYPES = new Set([
  "HELLO",
  "READY",
  "BEGIN_SESSION",
  "SESSION_ACCEPTED",
  "RETRACT_FACTS",
  "UPSERT_FACTS",
  "BATCH_ACCEPTED",
  "COMMIT_SESSION",
  "SESSION_COMMITTED",
  "ABORT_SESSION",
  "SESSION_ABORTED",
  "ERROR",
]);

const COMMON_FIELDS = ["format", "type", "requestId"];
const HEX_64 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const ASCII_NAME = /^[\x21-\x7e]+$/u;
const U64_MAX = 0xffff_ffff_ffff_ffffn;
const utf8Decoder = new TextDecoder("utf-8", { fatal: true });

export class InsightsProtocolError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "InsightsProtocolError";
    this.code = code;
  }
}

function protocolError(code, message, cause) {
  return new InsightsProtocolError(code, message, cause === undefined ? {} : { cause });
}

function invalidFrame(message, cause) {
  return protocolError("TS_INSIGHTS_PROTOCOL_INVALID_FRAME", message, cause);
}

function assertPlainObject(value, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw invalidFrame(`${label} must be an object`);
  }
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) {
    throw invalidFrame(`${label} must be a plain object`);
  }
  return value;
}

function assertExactKeys(value, label, required) {
  assertPlainObject(value, label);
  const allowed = new Set(required);
  for (const key of Object.keys(value)) {
    if (!allowed.has(key)) throw invalidFrame(`${label} contains unknown field ${key}`);
  }
  for (const key of required) {
    if (!Object.hasOwn(value, key)) throw invalidFrame(`${label} is missing field ${key}`);
  }
}

function assertEnvelope(message, type, fields) {
  assertExactKeys(message, type, [...COMMON_FIELDS, ...fields]);
  if (message.format !== INSIGHTS_PROTOCOL_FORMAT) {
    throw protocolError(
      "TS_INSIGHTS_PROTOCOL_UNSUPPORTED_VERSION",
      `unsupported protocol format ${String(message.format)}`,
    );
  }
  if (message.type !== type) throw invalidFrame(`expected ${type}`);
  assertDecimal(message.requestId, `${type}.requestId`);
}

function assertNonEmptyString(value, label) {
  if (typeof value !== "string" || value.length === 0) {
    throw invalidFrame(`${label} must be non-empty`);
  }
}

function assertAsciiName(value, label) {
  assertNonEmptyString(value, label);
  if (!ASCII_NAME.test(value)) throw invalidFrame(`${label} must contain printable ASCII`);
}

function assertVersion(value, label) {
  if (!Number.isSafeInteger(value) || value < 1) {
    throw invalidFrame(`${label} must be a positive safe integer`);
  }
}

function assertHex64(value, label) {
  if (typeof value !== "string" || !HEX_64.test(value)) {
    throw invalidFrame(`${label} must be 32 lowercase hexadecimal bytes`);
  }
}

function assertDecimal(value, label) {
  if (typeof value !== "string" || !DECIMAL.test(value) || BigInt(value) > U64_MAX) {
    throw invalidFrame(`${label} must be a uint64 decimal string`);
  }
}

function assertUuid(value, label) {
  if (typeof value !== "string" || !UUID.test(value)) throw invalidFrame(`${label} must be a UUID`);
}

function compareAscii(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function assertSortedStrings(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw invalidFrame(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  for (let index = 0; index < value.length; index += 1) {
    assertAsciiName(value[index], `${label}[${index}]`);
    if (index > 0 && compareAscii(value[index - 1], value[index]) >= 0) {
      throw invalidFrame(`${label} must be ASCII-sorted and contain unique values`);
    }
  }
}

function sortedUniqueStrings(value, label, { allowEmpty = true } = {}) {
  if (!Array.isArray(value) || (!allowEmpty && value.length === 0)) {
    throw invalidFrame(`${label} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  const result = [...value];
  for (let index = 0; index < result.length; index += 1) {
    assertAsciiName(result[index], `${label}[${index}]`);
  }
  result.sort(compareAscii);
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1] === result[index]) throw invalidFrame(`${label} contains duplicates`);
  }
  return result;
}

const HANDSHAKE_CONTRACT_FIELDS = [
  "factSchemaVersion",
  "providerAdapterVersions",
  "privacyPolicyVersion",
  "originSecretEpoch",
  "duplicatePolicyVersion",
  "factStorageProfile",
  "storageSchemaVersion",
  "projectionVersions",
  "analyzerCapabilities",
  "rankerVersion",
];

const SESSION_CONTRACT_FIELDS = [
  "factSchemaVersion",
  "providerAdapterVersion",
  "privacyPolicyVersion",
  "originSecretEpoch",
  "duplicatePolicyVersion",
  "factStorageProfile",
  "storageSchemaVersion",
  "projectionVersions",
  "analyzerCapabilities",
  "rankerVersion",
];

function assertHandshakeContract(contract, label) {
  assertExactKeys(contract, label, HANDSHAKE_CONTRACT_FIELDS);
  assertVersion(contract.factSchemaVersion, `${label}.factSchemaVersion`);
  assertSortedStrings(
    contract.providerAdapterVersions,
    `${label}.providerAdapterVersions`,
    { allowEmpty: false },
  );
  assertVersion(contract.privacyPolicyVersion, `${label}.privacyPolicyVersion`);
  assertUuid(contract.originSecretEpoch, `${label}.originSecretEpoch`);
  assertVersion(contract.duplicatePolicyVersion, `${label}.duplicatePolicyVersion`);
  assertAsciiName(contract.factStorageProfile, `${label}.factStorageProfile`);
  assertVersion(contract.storageSchemaVersion, `${label}.storageSchemaVersion`);
  assertSortedStrings(contract.projectionVersions, `${label}.projectionVersions`);
  assertSortedStrings(contract.analyzerCapabilities, `${label}.analyzerCapabilities`);
  assertVersion(contract.rankerVersion, `${label}.rankerVersion`);
}

function canonicalHandshakeContract(contract) {
  assertPlainObject(contract, "contract");
  assertExactKeys(contract, "contract", HANDSHAKE_CONTRACT_FIELDS);
  const result = {
    factSchemaVersion: contract.factSchemaVersion,
    providerAdapterVersions: sortedUniqueStrings(
      contract.providerAdapterVersions,
      "contract.providerAdapterVersions",
      { allowEmpty: false },
    ),
    privacyPolicyVersion: contract.privacyPolicyVersion,
    originSecretEpoch: contract.originSecretEpoch,
    duplicatePolicyVersion: contract.duplicatePolicyVersion,
    factStorageProfile: contract.factStorageProfile,
    storageSchemaVersion: contract.storageSchemaVersion,
    projectionVersions: sortedUniqueStrings(
      contract.projectionVersions,
      "contract.projectionVersions",
    ),
    analyzerCapabilities: sortedUniqueStrings(
      contract.analyzerCapabilities,
      "contract.analyzerCapabilities",
    ),
    rankerVersion: contract.rankerVersion,
  };
  assertHandshakeContract(result, "contract");
  return result;
}

function assertSessionContract(contract, label) {
  assertExactKeys(contract, label, SESSION_CONTRACT_FIELDS);
  assertVersion(contract.factSchemaVersion, `${label}.factSchemaVersion`);
  assertAsciiName(contract.providerAdapterVersion, `${label}.providerAdapterVersion`);
  assertVersion(contract.privacyPolicyVersion, `${label}.privacyPolicyVersion`);
  assertUuid(contract.originSecretEpoch, `${label}.originSecretEpoch`);
  assertVersion(contract.duplicatePolicyVersion, `${label}.duplicatePolicyVersion`);
  assertAsciiName(contract.factStorageProfile, `${label}.factStorageProfile`);
  assertVersion(contract.storageSchemaVersion, `${label}.storageSchemaVersion`);
  assertSortedStrings(contract.projectionVersions, `${label}.projectionVersions`);
  assertSortedStrings(contract.analyzerCapabilities, `${label}.analyzerCapabilities`);
  assertVersion(contract.rankerVersion, `${label}.rankerVersion`);
}

function assertMaxFrameBytes(value, label) {
  if (value !== MAX_PROTOCOL_PAYLOAD_BYTES) {
    throw protocolError(
      "TS_INSIGHTS_PROTOCOL_CONTRACT_UNSUPPORTED",
      `${label} must be ${MAX_PROTOCOL_PAYLOAD_BYTES}`,
    );
  }
}

const COUNT_FIELDS = [...RETRACTION_COLLECTION_ORDER, ...UPSERT_COLLECTION_ORDER];

function assertCounts(counts) {
  assertExactKeys(counts, "BEGIN_SESSION.counts", COUNT_FIELDS);
  for (const field of COUNT_FIELDS) assertDecimal(counts[field], `BEGIN_SESSION.counts.${field}`);
}

function assertHello(message) {
  assertEnvelope(message, "HELLO", ["clientVersion", "maxFrameBytes", "requiredContract"]);
  assertNonEmptyString(message.clientVersion, "HELLO.clientVersion");
  assertMaxFrameBytes(message.maxFrameBytes, "HELLO.maxFrameBytes");
  assertHandshakeContract(message.requiredContract, "HELLO.requiredContract");
}

function assertReady(message) {
  assertEnvelope(message, "READY", [
    "engineVersion",
    "target",
    "maxFrameBytes",
    "sqliteVersion",
    "sqliteCompileOptionsDigest",
    "buildManifestDigest",
    "acceptedContract",
  ]);
  assertNonEmptyString(message.engineVersion, "READY.engineVersion");
  assertNonEmptyString(message.target, "READY.target");
  assertMaxFrameBytes(message.maxFrameBytes, "READY.maxFrameBytes");
  assertNonEmptyString(message.sqliteVersion, "READY.sqliteVersion");
  assertHex64(message.sqliteCompileOptionsDigest, "READY.sqliteCompileOptionsDigest");
  assertHex64(message.buildManifestDigest, "READY.buildManifestDigest");
  assertHandshakeContract(message.acceptedContract, "READY.acceptedContract");
}

function assertBeginSession(message) {
  assertEnvelope(message, "BEGIN_SESSION", [
    "deltaFormat",
    "session",
    "deltaId",
    "mode",
    "expectedGeneration",
    "targetGeneration",
    "contract",
    "counts",
  ]);
  if (message.deltaFormat !== "session-facts-delta@v1") {
    throw invalidFrame("BEGIN_SESSION.deltaFormat is unsupported");
  }
  assertPlainObject(message.session, "BEGIN_SESSION.session");
  assertHex64(message.session.sessionKey, "BEGIN_SESSION.session.sessionKey");
  assertHex64(message.deltaId, "BEGIN_SESSION.deltaId");
  if (message.mode !== "append" && message.mode !== "replace-session") {
    throw invalidFrame("BEGIN_SESSION.mode is invalid");
  }
  assertDecimal(message.expectedGeneration, "BEGIN_SESSION.expectedGeneration");
  assertDecimal(message.targetGeneration, "BEGIN_SESSION.targetGeneration");
  assertSessionContract(message.contract, "BEGIN_SESSION.contract");
  assertCounts(message.counts);
}

function assertSessionAccepted(message) {
  assertEnvelope(message, "SESSION_ACCEPTED", ["sessionKey", "deltaId", "nextSequence"]);
  assertHex64(message.sessionKey, "SESSION_ACCEPTED.sessionKey");
  assertHex64(message.deltaId, "SESSION_ACCEPTED.deltaId");
  assertDecimal(message.nextSequence, "SESSION_ACCEPTED.nextSequence");
}

function assertBatch(message, type, allowedCollections) {
  assertEnvelope(message, type, ["sequence", "collection", "items"]);
  assertDecimal(message.sequence, `${type}.sequence`);
  if (!allowedCollections.includes(message.collection)) {
    throw invalidFrame(`${type}.collection is invalid`);
  }
  if (!Array.isArray(message.items) || message.items.length === 0) {
    throw invalidFrame(`${type}.items must be a non-empty array`);
  }
}

function assertBatchAccepted(message) {
  assertEnvelope(message, "BATCH_ACCEPTED", ["sequence"]);
  assertDecimal(message.sequence, "BATCH_ACCEPTED.sequence");
}

function assertCommitSession(message) {
  assertEnvelope(message, "COMMIT_SESSION", [
    "nextSequence",
    "checkpoint",
    "diagnostics",
    "coverage",
  ]);
  assertDecimal(message.nextSequence, "COMMIT_SESSION.nextSequence");
  assertPlainObject(message.checkpoint, "COMMIT_SESSION.checkpoint");
  if (!Array.isArray(message.diagnostics)) {
    throw invalidFrame("COMMIT_SESSION.diagnostics must be an array");
  }
  assertPlainObject(message.coverage, "COMMIT_SESSION.coverage");
}

function assertSessionCommitted(message) {
  assertEnvelope(message, "SESSION_COMMITTED", [
    "sessionKey",
    "deltaId",
    "snapshotSeq",
    "idempotent",
  ]);
  assertHex64(message.sessionKey, "SESSION_COMMITTED.sessionKey");
  assertHex64(message.deltaId, "SESSION_COMMITTED.deltaId");
  assertDecimal(message.snapshotSeq, "SESSION_COMMITTED.snapshotSeq");
  if (typeof message.idempotent !== "boolean") {
    throw invalidFrame("SESSION_COMMITTED.idempotent must be boolean");
  }
}

function assertAbortSession(message) {
  assertEnvelope(message, "ABORT_SESSION", ["nextSequence", "reason"]);
  assertDecimal(message.nextSequence, "ABORT_SESSION.nextSequence");
  assertNonEmptyString(message.reason, "ABORT_SESSION.reason");
  if (Buffer.byteLength(message.reason, "utf8") > 1_024) {
    throw invalidFrame("ABORT_SESSION.reason exceeds 1 KiB");
  }
}

function assertSessionAborted(message) {
  assertEnvelope(message, "SESSION_ABORTED", ["sessionKey", "deltaId", "nextSequence"]);
  assertHex64(message.sessionKey, "SESSION_ABORTED.sessionKey");
  assertHex64(message.deltaId, "SESSION_ABORTED.deltaId");
  assertDecimal(message.nextSequence, "SESSION_ABORTED.nextSequence");
}

function assertErrorMessage(message) {
  assertEnvelope(message, "ERROR", ["code", "category", "message", "retryable", "fatal"]);
  assertNonEmptyString(message.code, "ERROR.code");
  if (!new Set(["protocol", "compatibility", "validation", "conflict", "storage"]).has(
    message.category,
  )) {
    throw invalidFrame("ERROR.category is invalid");
  }
  assertNonEmptyString(message.message, "ERROR.message");
  if (Buffer.byteLength(message.message, "utf8") > 1_024) {
    throw invalidFrame("ERROR.message exceeds 1 KiB");
  }
  if (typeof message.retryable !== "boolean" || typeof message.fatal !== "boolean") {
    throw invalidFrame("ERROR.retryable and ERROR.fatal must be boolean");
  }
}

/** Strictly validates a protocol-v1 envelope and all protocol-owned nested fields. */
export function assertProtocolMessage(message) {
  assertPlainObject(message, "protocol message");
  if (message.format !== INSIGHTS_PROTOCOL_FORMAT) {
    throw protocolError(
      "TS_INSIGHTS_PROTOCOL_UNSUPPORTED_VERSION",
      `unsupported protocol format ${String(message.format)}`,
    );
  }
  if (typeof message.type !== "string" || !MESSAGE_TYPES.has(message.type)) {
    throw protocolError(
      "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
      `unexpected protocol message ${String(message.type)}`,
    );
  }
  if (message.type === "HELLO") assertHello(message);
  else if (message.type === "READY") assertReady(message);
  else if (message.type === "BEGIN_SESSION") assertBeginSession(message);
  else if (message.type === "SESSION_ACCEPTED") assertSessionAccepted(message);
  else if (message.type === "RETRACT_FACTS") {
    assertBatch(message, "RETRACT_FACTS", RETRACTION_COLLECTION_ORDER);
  } else if (message.type === "UPSERT_FACTS") {
    assertBatch(message, "UPSERT_FACTS", UPSERT_COLLECTION_ORDER);
  } else if (message.type === "BATCH_ACCEPTED") assertBatchAccepted(message);
  else if (message.type === "COMMIT_SESSION") assertCommitSession(message);
  else if (message.type === "SESSION_COMMITTED") assertSessionCommitted(message);
  else if (message.type === "ABORT_SESSION") assertAbortSession(message);
  else if (message.type === "SESSION_ABORTED") assertSessionAborted(message);
  else if (message.type === "ERROR") assertErrorMessage(message);
  return message;
}

function envelope(type, requestId, fields) {
  return { format: INSIGHTS_PROTOCOL_FORMAT, type, requestId, ...fields };
}

export function createHelloMessage({ requestId, clientVersion, requiredContract }) {
  return assertProtocolMessage(
    envelope("HELLO", requestId, {
      clientVersion,
      maxFrameBytes: MAX_PROTOCOL_PAYLOAD_BYTES,
      requiredContract: canonicalHandshakeContract(requiredContract),
    }),
  );
}

export function createReadyMessage({
  requestId,
  engineVersion,
  target,
  sqliteVersion,
  sqliteCompileOptionsDigest,
  buildManifestDigest,
  acceptedContract,
}) {
  return assertProtocolMessage(
    envelope("READY", requestId, {
      engineVersion,
      target,
      maxFrameBytes: MAX_PROTOCOL_PAYLOAD_BYTES,
      sqliteVersion,
      sqliteCompileOptionsDigest,
      buildManifestDigest,
      acceptedContract: canonicalHandshakeContract(acceptedContract),
    }),
  );
}

function sameStrings(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

/** READY must accept the exact required contract; no version axis is inferred later. */
export function assertHandshakeCompatible(hello, ready) {
  assertProtocolMessage(hello);
  assertProtocolMessage(ready);
  if (hello.type !== "HELLO" || ready.type !== "READY" || hello.requestId !== ready.requestId) {
    throw protocolError(
      "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
      "handshake requires matching HELLO and READY requestId",
    );
  }
  const required = hello.requiredContract;
  const accepted = ready.acceptedContract;
  const compatible =
    required.factSchemaVersion === accepted.factSchemaVersion &&
    sameStrings(required.providerAdapterVersions, accepted.providerAdapterVersions) &&
    required.privacyPolicyVersion === accepted.privacyPolicyVersion &&
    required.originSecretEpoch.toLowerCase() === accepted.originSecretEpoch.toLowerCase() &&
    required.duplicatePolicyVersion === accepted.duplicatePolicyVersion &&
    required.factStorageProfile === accepted.factStorageProfile &&
    required.storageSchemaVersion === accepted.storageSchemaVersion &&
    sameStrings(required.projectionVersions, accepted.projectionVersions) &&
    sameStrings(required.analyzerCapabilities, accepted.analyzerCapabilities) &&
    required.rankerVersion === accepted.rankerVersion;
  if (!compatible) {
    throw protocolError(
      "TS_INSIGHTS_PROTOCOL_CONTRACT_UNSUPPORTED",
      "Engine did not accept the required Insights contract",
    );
  }
  return true;
}

function assertArray(value, label) {
  if (!Array.isArray(value)) throw invalidFrame(`${label} must be an array`);
  return value;
}

function countsFromDelta(delta) {
  assertPlainObject(delta.retractions, "delta.retractions");
  const counts = {};
  for (const collection of RETRACTION_COLLECTION_ORDER) {
    counts[collection] = String(
      assertArray(delta.retractions[collection], `delta.retractions.${collection}`).length,
    );
  }
  for (const collection of UPSERT_COLLECTION_ORDER) {
    counts[collection] = String(assertArray(delta[collection], `delta.${collection}`).length);
  }
  return counts;
}

function sessionContractFromDelta(
  delta,
  {
    factStorageProfile,
    storageSchemaVersion,
    projectionVersions = [],
    analyzerCapabilities = [],
    rankerVersion,
  },
) {
  const contract = {
    factSchemaVersion: delta.factSchemaVersion,
    providerAdapterVersion: delta.providerAdapterVersion,
    privacyPolicyVersion: delta.privacyPolicyVersion,
    originSecretEpoch: delta.originSecretEpoch,
    duplicatePolicyVersion: delta.duplicatePolicyVersion,
    factStorageProfile,
    storageSchemaVersion,
    projectionVersions: sortedUniqueStrings(projectionVersions, "projectionVersions"),
    analyzerCapabilities: sortedUniqueStrings(analyzerCapabilities, "analyzerCapabilities"),
    rankerVersion,
  };
  assertSessionContract(contract, "BEGIN_SESSION.contract");
  return contract;
}

export function createBeginSessionMessage(delta, options) {
  assertPlainObject(delta, "SessionFactsDeltaV1");
  assertPlainObject(delta.session, "delta.session");
  return assertProtocolMessage(
    envelope("BEGIN_SESSION", options.requestId, {
      deltaFormat: delta.format,
      session: delta.session,
      deltaId: delta.deltaId,
      mode: delta.mode,
      expectedGeneration: delta.expectedGeneration,
      targetGeneration: delta.targetGeneration,
      contract: sessionContractFromDelta(delta, options),
      counts: countsFromDelta(delta),
    }),
  );
}

export function assertBeginSessionCompatible(begin, ready) {
  assertProtocolMessage(begin);
  assertProtocolMessage(ready);
  if (begin.type !== "BEGIN_SESSION" || ready.type !== "READY") {
    throw protocolError(
      "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
      "session compatibility requires BEGIN_SESSION and READY",
    );
  }
  const session = begin.contract;
  const accepted = ready.acceptedContract;
  const compatible =
    session.factSchemaVersion === accepted.factSchemaVersion &&
    accepted.providerAdapterVersions.includes(session.providerAdapterVersion) &&
    session.privacyPolicyVersion === accepted.privacyPolicyVersion &&
    session.originSecretEpoch.toLowerCase() === accepted.originSecretEpoch.toLowerCase() &&
    session.duplicatePolicyVersion === accepted.duplicatePolicyVersion &&
    session.factStorageProfile === accepted.factStorageProfile &&
    session.storageSchemaVersion === accepted.storageSchemaVersion &&
    sameStrings(session.projectionVersions, accepted.projectionVersions) &&
    sameStrings(session.analyzerCapabilities, accepted.analyzerCapabilities) &&
    session.rankerVersion === accepted.rankerVersion;
  if (!compatible) {
    throw protocolError(
      "TS_INSIGHTS_PROTOCOL_CONTRACT_UNSUPPORTED",
      "BEGIN_SESSION does not match the accepted Insights contract",
    );
  }
  return true;
}

export function createSessionAcceptedMessage(begin) {
  assertProtocolMessage(begin);
  if (begin.type !== "BEGIN_SESSION") throw invalidFrame("SESSION_ACCEPTED requires BEGIN_SESSION");
  return assertProtocolMessage(
    envelope("SESSION_ACCEPTED", begin.requestId, {
      sessionKey: begin.session.sessionKey,
      deltaId: begin.deltaId,
      nextSequence: "0",
    }),
  );
}

function createBatchMessage(type, { requestId, sequence, collection, items }) {
  return assertProtocolMessage(envelope(type, requestId, { sequence, collection, items }));
}

export function createRetractionBatchMessage(options) {
  return createBatchMessage("RETRACT_FACTS", options);
}

export function createUpsertBatchMessage(options) {
  return createBatchMessage("UPSERT_FACTS", options);
}

export function createBatchAcceptedMessage({ requestId, sequence }) {
  return assertProtocolMessage(envelope("BATCH_ACCEPTED", requestId, { sequence }));
}

export function createCommitSessionMessage(delta, { requestId, nextSequence }) {
  return assertProtocolMessage(
    envelope("COMMIT_SESSION", requestId, {
      nextSequence,
      checkpoint: delta.checkpoint,
      diagnostics: delta.diagnostics,
      coverage: delta.coverage,
    }),
  );
}

export function createSessionCommittedMessage({
  requestId,
  sessionKey,
  deltaId,
  snapshotSeq,
  idempotent,
}) {
  return assertProtocolMessage(
    envelope("SESSION_COMMITTED", requestId, {
      sessionKey,
      deltaId,
      snapshotSeq,
      idempotent,
    }),
  );
}

export function createAbortSessionMessage({ requestId, nextSequence, reason }) {
  return assertProtocolMessage(envelope("ABORT_SESSION", requestId, { nextSequence, reason }));
}

export function createSessionAbortedMessage({
  requestId,
  sessionKey,
  deltaId,
  nextSequence,
}) {
  return assertProtocolMessage(
    envelope("SESSION_ABORTED", requestId, { sessionKey, deltaId, nextSequence }),
  );
}

export function createProtocolErrorMessage({
  requestId,
  code,
  category,
  message,
  retryable = false,
  fatal = false,
}) {
  return assertProtocolMessage(
    envelope("ERROR", requestId, { code, category, message, retryable, fatal }),
  );
}

function assertMaxPayloadBytes(value) {
  if (!Number.isSafeInteger(value) || value < 1 || value > 0xffff_ffff) {
    throw new RangeError("maxPayloadBytes must be an integer between 1 and uint32 max");
  }
}

function canonicalPayload(message) {
  assertProtocolMessage(message);
  try {
    return Buffer.from(canonicalJson(message), "utf8");
  } catch (cause) {
    throw invalidFrame("protocol message is outside the canonical JSON value domain", cause);
  }
}

export function protocolPayloadByteLength(message) {
  return canonicalPayload(message).byteLength;
}

/** Encodes canonical UTF-8 JSON behind a 4-byte unsigned big-endian payload length. */
export function encodeProtocolFrame(
  message,
  { maxPayloadBytes = MAX_PROTOCOL_PAYLOAD_BYTES } = {},
) {
  assertMaxPayloadBytes(maxPayloadBytes);
  const payload = canonicalPayload(message);
  if (payload.byteLength > maxPayloadBytes) {
    throw protocolError(
      "TS_INSIGHTS_PROTOCOL_FRAME_TOO_LARGE",
      `protocol payload is ${payload.byteLength} bytes; maximum is ${maxPayloadBytes}`,
    );
  }
  const header = Buffer.allocUnsafe(4);
  header.writeUInt32BE(payload.byteLength);
  return Buffer.concat([header, payload], payload.byteLength + 4);
}

function decodePayload(payload) {
  let source;
  try {
    source = utf8Decoder.decode(payload);
  } catch (cause) {
    throw invalidFrame("frame payload is not valid UTF-8", cause);
  }
  let message;
  try {
    message = JSON.parse(source);
  } catch (cause) {
    throw invalidFrame("frame payload is not valid JSON", cause);
  }
  let expected;
  try {
    expected = Buffer.from(canonicalJson(message), "utf8");
  } catch (cause) {
    throw invalidFrame("frame payload is outside the canonical JSON value domain", cause);
  }
  if (expected.byteLength !== payload.byteLength || !expected.equals(payload)) {
    throw invalidFrame("frame payload is not canonical UTF-8 JSON");
  }
  return assertProtocolMessage(message);
}

/** Incremental decoder for fragmented prefixes/payloads and coalesced frames. */
export class ProtocolFrameDecoder {
  #maxPayloadBytes;
  #header = Buffer.allocUnsafe(4);
  #headerLength = 0;
  #payload = null;
  #payloadLength = 0;
  #payloadOffset = 0;
  #ended = false;

  constructor({ maxPayloadBytes = MAX_PROTOCOL_PAYLOAD_BYTES } = {}) {
    assertMaxPayloadBytes(maxPayloadBytes);
    this.#maxPayloadBytes = maxPayloadBytes;
  }

  push(chunk) {
    if (this.#ended) {
      throw protocolError("TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME", "decoder has already ended");
    }
    if (!(chunk instanceof Uint8Array)) throw new TypeError("frame chunk must be a Uint8Array");
    const bytes = Buffer.from(chunk.buffer, chunk.byteOffset, chunk.byteLength);
    const messages = [];
    let offset = 0;
    while (offset < bytes.byteLength) {
      if (this.#payload === null) {
        const copied = Math.min(4 - this.#headerLength, bytes.byteLength - offset);
        bytes.copy(this.#header, this.#headerLength, offset, offset + copied);
        this.#headerLength += copied;
        offset += copied;
        if (this.#headerLength < 4) continue;
        this.#payloadLength = this.#header.readUInt32BE(0);
        if (this.#payloadLength > this.#maxPayloadBytes) {
          throw protocolError(
            "TS_INSIGHTS_PROTOCOL_FRAME_TOO_LARGE",
            `declared payload is ${this.#payloadLength} bytes; maximum is ${this.#maxPayloadBytes}`,
          );
        }
        if (this.#payloadLength === 0) throw invalidFrame("frame payload is empty");
        this.#payload = Buffer.allocUnsafe(this.#payloadLength);
        this.#payloadOffset = 0;
      }

      const copied = Math.min(
        this.#payloadLength - this.#payloadOffset,
        bytes.byteLength - offset,
      );
      bytes.copy(this.#payload, this.#payloadOffset, offset, offset + copied);
      this.#payloadOffset += copied;
      offset += copied;
      if (this.#payloadOffset === this.#payloadLength) {
        const payload = this.#payload;
        this.#resetFrame();
        messages.push(decodePayload(payload));
      }
    }
    return messages;
  }

  end() {
    if (this.#ended) return;
    this.#ended = true;
    if (this.#headerLength !== 0 || this.#payload !== null) {
      throw invalidFrame("protocol stream ended with a truncated frame");
    }
  }

  #resetFrame() {
    this.#headerLength = 0;
    this.#payload = null;
    this.#payloadLength = 0;
    this.#payloadOffset = 0;
  }
}

export async function* decodeProtocolFrames(
  chunks,
  { maxPayloadBytes = MAX_PROTOCOL_PAYLOAD_BYTES } = {},
) {
  const decoder = new ProtocolFrameDecoder({ maxPayloadBytes });
  for await (const chunk of chunks) {
    for (const message of decoder.push(chunk)) yield message;
  }
  decoder.end();
}

function collectionDescriptors(delta) {
  return [
    ...RETRACTION_COLLECTION_ORDER.map((collection) => ({
      type: "RETRACT_FACTS",
      collection,
      items: delta.retractions[collection],
    })),
    ...UPSERT_COLLECTION_ORDER.map((collection) => ({
      type: "UPSERT_FACTS",
      collection,
      items: delta[collection],
    })),
  ];
}

function createBatch(type, options) {
  return type === "RETRACT_FACTS"
    ? createRetractionBatchMessage(options)
    : createUpsertBatchMessage(options);
}

function uncheckedEmptyBatch(type, { requestId, sequence, collection }) {
  return envelope(type, requestId, { sequence, collection, items: [] });
}

function itemCanonicalByteLength(item, collection) {
  try {
    return Buffer.byteLength(canonicalJson(item), "utf8");
  } catch (cause) {
    throw invalidFrame(`${collection} contains a non-canonical Fact`, cause);
  }
}

function assertFits(message, maxPayloadBytes) {
  const bytes = protocolPayloadByteLength(message);
  if (bytes > maxPayloadBytes) {
    throw protocolError(
      "TS_INSIGHTS_PROTOCOL_FRAME_TOO_LARGE",
      `${message.type} payload is ${bytes} bytes; maximum is ${maxPayloadBytes}`,
    );
  }
}

/** Lazily emits BEGIN, fixed-order greedy batches, and COMMIT for one session delta. */
export async function* createSessionDeltaMessages(
  delta,
  {
    requestId,
    factStorageProfile,
    storageSchemaVersion,
    projectionVersions = [],
    analyzerCapabilities = [],
    rankerVersion,
    maxPayloadBytes = MAX_PROTOCOL_PAYLOAD_BYTES,
  },
) {
  assertMaxPayloadBytes(maxPayloadBytes);
  const beginOptions = {
    requestId,
    factStorageProfile,
    storageSchemaVersion,
    projectionVersions,
    analyzerCapabilities,
    rankerVersion,
  };
  const begin = createBeginSessionMessage(delta, beginOptions);
  assertFits(begin, maxPayloadBytes);
  yield begin;

  let sequence = 0n;
  for (const descriptor of collectionDescriptors(delta)) {
    let batch = [];
    let batchBytes = 0;
    for (const item of descriptor.items) {
      const sequenceText = sequence.toString();
      if (batch.length === 0) {
        batchBytes = Buffer.byteLength(
          canonicalJson(
            uncheckedEmptyBatch(descriptor.type, {
              requestId,
              sequence: sequenceText,
              collection: descriptor.collection,
            }),
          ),
          "utf8",
        );
        if (batchBytes > maxPayloadBytes) {
          throw protocolError(
            "TS_INSIGHTS_PROTOCOL_FRAME_TOO_LARGE",
            `${descriptor.type} envelope exceeds the frame limit`,
          );
        }
      }
      const itemBytes = itemCanonicalByteLength(item, descriptor.collection);
      const candidateBytes = batchBytes + itemBytes + (batch.length === 0 ? 0 : 1);
      if (candidateBytes > maxPayloadBytes && batch.length > 0) {
        const message = createBatch(descriptor.type, {
          requestId,
          sequence: sequenceText,
          collection: descriptor.collection,
          items: batch,
        });
        assertFits(message, maxPayloadBytes);
        yield message;
        sequence += 1n;
        batch = [];
        batchBytes = Buffer.byteLength(
          canonicalJson(
            uncheckedEmptyBatch(descriptor.type, {
              requestId,
              sequence: sequence.toString(),
              collection: descriptor.collection,
            }),
          ),
          "utf8",
        );
      }
      const nextBytes = batchBytes + itemBytes + (batch.length === 0 ? 0 : 1);
      if (nextBytes > maxPayloadBytes) {
        throw protocolError(
          "TS_INSIGHTS_PROTOCOL_ITEM_TOO_LARGE",
          `${descriptor.collection} contains an item that cannot fit in one frame`,
        );
      }
      batch.push(item);
      batchBytes = nextBytes;
    }
    if (batch.length > 0) {
      const message = createBatch(descriptor.type, {
        requestId,
        sequence: sequence.toString(),
        collection: descriptor.collection,
        items: batch,
      });
      assertFits(message, maxPayloadBytes);
      yield message;
      sequence += 1n;
    }
  }

  const commit = createCommitSessionMessage(delta, {
    requestId,
    nextSequence: sequence.toString(),
  });
  assertFits(commit, maxPayloadBytes);
  yield commit;
}

function collectionRank(message) {
  if (message.type === "RETRACT_FACTS") {
    return RETRACTION_COLLECTION_ORDER.indexOf(message.collection);
  }
  if (message.type === "UPSERT_FACTS") {
    return RETRACTION_COLLECTION_ORDER.length + UPSERT_COLLECTION_ORDER.indexOf(message.collection);
  }
  return -1;
}

function countKey(message) {
  return `${message.type}:${message.collection}`;
}

function expectedCountEntries(begin) {
  return [
    ...RETRACTION_COLLECTION_ORDER.map((collection) => [
      `RETRACT_FACTS:${collection}`,
      BigInt(begin.counts[collection]),
    ]),
    ...UPSERT_COLLECTION_ORDER.map((collection) => [
      `UPSERT_FACTS:${collection}`,
      BigInt(begin.counts[collection]),
    ]),
  ];
}

/** Validates request identity, decimal sequence, collection order, and BEGIN counts. */
export class SessionBatchSequenceValidator {
  #begin;
  #expected;
  #seen = new Map();
  #nextSequence = 0n;
  #lastCollectionRank = -1;
  #done = false;

  constructor(begin) {
    assertProtocolMessage(begin);
    if (begin.type !== "BEGIN_SESSION") {
      throw protocolError(
        "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
        "session sequence must start with BEGIN_SESSION",
      );
    }
    this.#begin = begin;
    this.#expected = new Map(expectedCountEntries(begin));
    for (const key of this.#expected.keys()) this.#seen.set(key, 0n);
  }

  get nextSequence() {
    return this.#nextSequence.toString();
  }

  get done() {
    return this.#done;
  }

  accept(message) {
    assertProtocolMessage(message);
    if (this.#done) {
      throw protocolError("TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME", "session sequence is complete");
    }
    if (!new Set(["RETRACT_FACTS", "UPSERT_FACTS", "COMMIT_SESSION", "ABORT_SESSION"]).has(
      message.type,
    )) {
      throw protocolError(
        "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
        `${message.type} is invalid inside a session sequence`,
      );
    }
    if (message.requestId !== this.#begin.requestId) {
      throw protocolError(
        "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
        "session message requestId does not match BEGIN_SESSION",
      );
    }
    const receivedSequence = message.type === "RETRACT_FACTS" || message.type === "UPSERT_FACTS"
      ? message.sequence
      : message.nextSequence;
    if (receivedSequence !== this.nextSequence) {
      throw protocolError(
        "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
        `expected sequence ${this.nextSequence}, received ${receivedSequence}`,
      );
    }

    if (message.type === "RETRACT_FACTS" || message.type === "UPSERT_FACTS") {
      const rank = collectionRank(message);
      if (rank < this.#lastCollectionRank) {
        throw protocolError(
          "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
          `${message.collection} arrived after a later collection`,
        );
      }
      const key = countKey(message);
      const seen = this.#seen.get(key) + BigInt(message.items.length);
      if (seen > this.#expected.get(key)) {
        throw protocolError(
          "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
          `${message.collection} exceeds its BEGIN_SESSION count`,
        );
      }
      this.#seen.set(key, seen);
      this.#lastCollectionRank = rank;
      this.#nextSequence += 1n;
      return;
    }

    if (message.type === "COMMIT_SESSION") {
      for (const [key, expected] of this.#expected) {
        if (this.#seen.get(key) !== expected) {
          throw protocolError(
            "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
            `${key} count does not match BEGIN_SESSION`,
          );
        }
      }
    }
    this.#done = true;
  }
}
