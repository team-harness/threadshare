import { TextDecoder } from "node:util";

import { assertWellFormedUnicode, canonicalJson } from "./canonical-json.mjs";

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
  "LIST_SOURCE_STATES",
  "SOURCE_STATES",
  "READ_SOURCE_CHECKPOINT",
  "SOURCE_CHECKPOINT",
  "REMOVE_SOURCE",
  "SOURCE_REMOVED",
  "EXCLUDE_SOURCE",
  "SOURCE_EXCLUDED",
  "READ_PURGE_STATUS",
  "PURGE_STATUS",
  "RUN_PURGE_MAINTENANCE",
  "PURGE_MAINTENANCE_STATUS",
  "READ_ENGINE_STATUS",
  "ENGINE_STATUS",
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
const MAX_SOURCE_STATE_PAGE_SIZE = 256;
const MAX_PURGE_MAINTENANCE_BATCH_SIZE = 256;
const MAX_SOURCE_LOCATOR_BYTES = 12 * 1_024;
const SOURCE_FINGERPRINT_BYTES = 4 * 1_024;
const MAX_ENGINE_STATUS_PROJECTIONS = 1_024;
const CHANGE_LOG_MAX_ROWS = 1_000_000n;
const CHANGE_LOG_MAX_PAYLOAD_BYTES = 64n * 1_024n * 1_024n;
const WAL_PASSIVE_CHECKPOINT_BYTES = 64n * 1_024n * 1_024n;
const WAL_BACKPRESSURE_BYTES = 128n * 1_024n * 1_024n;

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

const SOURCE_STATE_FIELDS = [
  "provider",
  "sessionId",
  "fileUtf8Hex",
  "sessionKey",
  "projectKey",
  "metadata",
  "fingerprints",
  "contract",
];

const SOURCE_CONTRACT_FIELDS = [
  "factSchemaVersion",
  "providerAdapterVersion",
  "privacyPolicyVersion",
  "duplicatePolicyVersion",
  "originSecretEpoch",
];

function assertPortableAbsolutePath(value, label) {
  assertNonEmptyString(value, label);
  assertWellFormedUnicode(value);
  const absolute = value.startsWith("/") || value.startsWith("\\\\") ||
    /^[A-Za-z]:[\\/]/u.test(value);
  if (!absolute || Buffer.byteLength(value, "utf8") > MAX_SOURCE_LOCATOR_BYTES ||
      /[\u0000-\u001f\u007f]/u.test(value)) {
    throw invalidFrame(`${label} must be a bounded absolute source locator`);
  }
}

function assertEncodedSourceLocator(value, label) {
  if (typeof value !== "string" || value.length === 0 ||
      value.length > MAX_SOURCE_LOCATOR_BYTES * 2 ||
      value.length % 2 !== 0 || !/^[0-9a-f]+$/u.test(value)) {
    throw invalidFrame(`${label} must be canonical lowercase UTF-8 hex`);
  }
  let decoded;
  try {
    decoded = utf8Decoder.decode(Buffer.from(value, "hex"));
  } catch (cause) {
    throw invalidFrame(`${label} must encode valid UTF-8`, cause);
  }
  assertPortableAbsolutePath(decoded, label);
  if (Buffer.from(decoded, "utf8").toString("hex") !== value) {
    throw invalidFrame(`${label} must use canonical UTF-8 hex`);
  }
}

export function encodeSourceLocator(value) {
  assertPortableAbsolutePath(value, "source locator");
  return Buffer.from(value, "utf8").toString("hex");
}

export function decodeSourceLocator(value) {
  assertEncodedSourceLocator(value, "encoded source locator");
  return utf8Decoder.decode(Buffer.from(value, "hex"));
}

export function decodeSourceStateFromProtocol(value) {
  assertSourceStateSummary(value, "source state");
  const { fileUtf8Hex, ...state } = value;
  return { ...state, file: decodeSourceLocator(fileUtf8Hex) };
}

function assertSourceContract(value, label) {
  assertExactKeys(value, label, SOURCE_CONTRACT_FIELDS);
  assertVersion(value.factSchemaVersion, `${label}.factSchemaVersion`);
  assertAsciiName(value.providerAdapterVersion, `${label}.providerAdapterVersion`);
  if (Buffer.byteLength(value.providerAdapterVersion, "utf8") > 128) {
    throw invalidFrame(`${label}.providerAdapterVersion exceeds 128 bytes`);
  }
  assertVersion(value.privacyPolicyVersion, `${label}.privacyPolicyVersion`);
  assertVersion(value.duplicatePolicyVersion, `${label}.duplicatePolicyVersion`);
  assertUuid(value.originSecretEpoch, `${label}.originSecretEpoch`);
  if (value.originSecretEpoch !== value.originSecretEpoch.toLowerCase()) {
    throw invalidFrame(`${label}.originSecretEpoch must be lowercase`);
  }
}

function assertSourceFingerprint(value, label) {
  assertExactKeys(value, label, ["offset", "length", "sha256"]);
  assertDecimal(value.offset, `${label}.offset`);
  if (!Number.isSafeInteger(value.length) || value.length < 0 ||
      value.length > SOURCE_FINGERPRINT_BYTES) {
    throw invalidFrame(`${label}.length must be between 0 and 4096`);
  }
  assertHex64(value.sha256, `${label}.sha256`);
}

function assertSourceStateFields(value, label) {
  if (value.provider !== "codex" && value.provider !== "claude") {
    throw invalidFrame(`${label}.provider is invalid`);
  }
  assertUuid(value.sessionId, `${label}.sessionId`);
  if (value.sessionId !== value.sessionId.toLowerCase()) {
    throw invalidFrame(`${label}.sessionId must be lowercase`);
  }
  assertEncodedSourceLocator(value.fileUtf8Hex, `${label}.fileUtf8Hex`);
  assertHex64(value.sessionKey, `${label}.sessionKey`);
  if (value.projectKey !== null) assertHex64(value.projectKey, `${label}.projectKey`);
  assertExactKeys(value.metadata, `${label}.metadata`, ["dev", "ino", "size", "mtimeNs"]);
  for (const field of ["dev", "ino", "size", "mtimeNs"]) {
    assertDecimal(value.metadata[field], `${label}.metadata.${field}`);
  }
  assertExactKeys(value.fingerprints, `${label}.fingerprints`, ["head", "boundary"]);
  assertSourceFingerprint(value.fingerprints.head, `${label}.fingerprints.head`);
  assertSourceFingerprint(value.fingerprints.boundary, `${label}.fingerprints.boundary`);
  assertSourceContract(value.contract, `${label}.contract`);
}

function assertSourceState(value, label) {
  assertExactKeys(value, label, SOURCE_STATE_FIELDS);
  assertSourceStateFields(value, label);
}

function assertSourceStateSummary(value, label) {
  assertExactKeys(value, label, [...SOURCE_STATE_FIELDS, "checkpoint"]);
  assertSourceStateFields(value, label);
  assertExactKeys(value.checkpoint, `${label}.checkpoint`, [
    "completeOffset",
    "sourceSnapshotStable",
    "generation",
  ]);
  assertDecimal(value.checkpoint.completeOffset, `${label}.checkpoint.completeOffset`);
  assertDecimal(value.checkpoint.generation, `${label}.checkpoint.generation`);
  if (typeof value.checkpoint.sourceSnapshotStable !== "boolean") {
    throw invalidFrame(`${label}.checkpoint.sourceSnapshotStable must be boolean`);
  }
  const sourceSize = BigInt(value.metadata.size);
  const completeOffset = BigInt(value.checkpoint.completeOffset);
  const head = value.fingerprints.head;
  const boundary = value.fingerprints.boundary;
  if (completeOffset > sourceSize || head.offset !== "0" ||
      BigInt(head.length) !== (sourceSize < 4096n ? sourceSize : 4096n) ||
      BigInt(boundary.length) !== (completeOffset < 4096n ? completeOffset : 4096n) ||
      BigInt(boundary.offset) + BigInt(boundary.length) !== completeOffset) {
    throw invalidFrame(`${label} fingerprint geometry is invalid`);
  }
}

function assertSourceCheckpointValue(value, label) {
  assertExactKeys(value, label, [
    "completeOffset",
    "eofObserved",
    "partialTailLength",
    "partialTailDigest",
    "sourceSize",
    "sourceMtimeNs",
    "sourceSnapshotStable",
    "originSecretEpoch",
    "generation",
    "pendingState",
  ]);
  for (const field of [
    "completeOffset",
    "partialTailLength",
    "sourceSize",
    "sourceMtimeNs",
    "generation",
  ]) assertDecimal(value[field], `${label}.${field}`);
  assertHex64(value.partialTailDigest, `${label}.partialTailDigest`);
  assertUuid(value.originSecretEpoch, `${label}.originSecretEpoch`);
  if (typeof value.eofObserved !== "boolean" ||
      typeof value.sourceSnapshotStable !== "boolean") {
    throw invalidFrame(`${label} boolean fields are invalid`);
  }
  assertPlainObject(value.pendingState, `${label}.pendingState`);
  if (BigInt(value.completeOffset) > BigInt(value.sourceSize) ||
      BigInt(value.partialTailLength) > BigInt(value.sourceSize)) {
    throw invalidFrame(`${label} offsets exceed sourceSize`);
  }
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
    "sourceState",
  ]);
  assertDecimal(message.nextSequence, "COMMIT_SESSION.nextSequence");
  assertPlainObject(message.checkpoint, "COMMIT_SESSION.checkpoint");
  if (!Array.isArray(message.diagnostics)) {
    throw invalidFrame("COMMIT_SESSION.diagnostics must be an array");
  }
  assertPlainObject(message.coverage, "COMMIT_SESSION.coverage");
  if (message.sourceState !== null) {
    assertSourceState(message.sourceState, "COMMIT_SESSION.sourceState");
  }
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

function assertListSourceStates(message) {
  assertEnvelope(message, "LIST_SOURCE_STATES", ["cursor", "limit"]);
  if (message.cursor !== null) assertHex64(message.cursor, "LIST_SOURCE_STATES.cursor");
  if (!Number.isSafeInteger(message.limit) || message.limit < 1 ||
      message.limit > MAX_SOURCE_STATE_PAGE_SIZE) {
    throw invalidFrame("LIST_SOURCE_STATES.limit must be between 1 and 256");
  }
}

function assertSourceStates(message) {
  assertEnvelope(message, "SOURCE_STATES", ["states", "nextCursor"]);
  if (!Array.isArray(message.states) || message.states.length > MAX_SOURCE_STATE_PAGE_SIZE) {
    throw invalidFrame("SOURCE_STATES.states must contain at most 256 items");
  }
  let previous = null;
  for (let index = 0; index < message.states.length; index += 1) {
    const state = message.states[index];
    assertSourceStateSummary(state, `SOURCE_STATES.states[${index}]`);
    if (previous !== null && compareAscii(previous, state.sessionKey) >= 0) {
      throw invalidFrame("SOURCE_STATES.states must be sessionKey-sorted and unique");
    }
    previous = state.sessionKey;
  }
  if (message.nextCursor !== null) {
    assertHex64(message.nextCursor, "SOURCE_STATES.nextCursor");
    if (message.nextCursor !== previous) {
      throw invalidFrame("SOURCE_STATES.nextCursor must equal the final state sessionKey");
    }
  }
}

function assertReadSourceCheckpoint(message) {
  assertEnvelope(message, "READ_SOURCE_CHECKPOINT", ["sessionKey"]);
  assertHex64(message.sessionKey, "READ_SOURCE_CHECKPOINT.sessionKey");
}

function assertSourceCheckpoint(message) {
  assertEnvelope(message, "SOURCE_CHECKPOINT", ["sessionKey", "checkpoint"]);
  assertHex64(message.sessionKey, "SOURCE_CHECKPOINT.sessionKey");
  if (message.checkpoint !== null) {
    assertSourceCheckpointValue(message.checkpoint, "SOURCE_CHECKPOINT.checkpoint");
  }
}

function assertPurgeState(value, label) {
  if (value !== "idle" && value !== "pending-purge" && value !== "purged") {
    throw invalidFrame(`${label} is invalid`);
  }
}

function assertPurgeStatusFields(message, label) {
  assertPurgeState(message.state, `${label}.state`);
  assertDecimal(message.pendingFacts, `${label}.pendingFacts`);
  assertDecimal(message.pendingMaintenance, `${label}.pendingMaintenance`);
  assertDecimal(message.purged, `${label}.purged`);
}

function assertSourceLifecycleRequest(message, type) {
  assertEnvelope(message, type, ["sessionKey"]);
  assertHex64(message.sessionKey, `${type}.sessionKey`);
}

function assertSourceRemoved(message) {
  assertEnvelope(message, "SOURCE_REMOVED", ["sessionKey", "removed"]);
  assertHex64(message.sessionKey, "SOURCE_REMOVED.sessionKey");
  if (typeof message.removed !== "boolean") {
    throw invalidFrame("SOURCE_REMOVED.removed must be boolean");
  }
}

function assertSourceExcluded(message) {
  assertEnvelope(message, "SOURCE_EXCLUDED", ["sessionKey", "excluded", "purgeState"]);
  assertHex64(message.sessionKey, "SOURCE_EXCLUDED.sessionKey");
  if (typeof message.excluded !== "boolean") {
    throw invalidFrame("SOURCE_EXCLUDED.excluded must be boolean");
  }
  assertPurgeState(message.purgeState, "SOURCE_EXCLUDED.purgeState");
}

function assertReadPurgeStatus(message) {
  assertEnvelope(message, "READ_PURGE_STATUS", ["sessionKey"]);
  if (message.sessionKey !== null) {
    assertHex64(message.sessionKey, "READ_PURGE_STATUS.sessionKey");
  }
}

function assertPurgeStatus(message) {
  assertEnvelope(message, "PURGE_STATUS", [
    "sessionKey",
    "state",
    "pendingFacts",
    "pendingMaintenance",
    "purged",
  ]);
  if (message.sessionKey !== null) assertHex64(message.sessionKey, "PURGE_STATUS.sessionKey");
  assertPurgeStatusFields(message, "PURGE_STATUS");
}

function assertRunPurgeMaintenance(message) {
  assertEnvelope(message, "RUN_PURGE_MAINTENANCE", ["limit"]);
  if (!Number.isSafeInteger(message.limit) || message.limit < 1 ||
      message.limit > MAX_PURGE_MAINTENANCE_BATCH_SIZE) {
    throw invalidFrame("RUN_PURGE_MAINTENANCE.limit must be between 1 and 256");
  }
}

function assertPurgeMaintenanceStatus(message) {
  assertEnvelope(message, "PURGE_MAINTENANCE_STATUS", [
    "processedSessions",
    "purgedSessions",
    "state",
    "pendingFacts",
    "pendingMaintenance",
    "purged",
  ]);
  assertDecimal(message.processedSessions, "PURGE_MAINTENANCE_STATUS.processedSessions");
  assertDecimal(message.purgedSessions, "PURGE_MAINTENANCE_STATUS.purgedSessions");
  assertPurgeStatusFields(message, "PURGE_MAINTENANCE_STATUS");
}

function assertReadEngineStatus(message) {
  assertEnvelope(message, "READ_ENGINE_STATUS", []);
}

function assertProjectionStatus(value, label) {
  assertExactKeys(value, label, [
    "name",
    "version",
    "inputFactSchemaVersion",
    "rootKind",
    "baseSnapshotSeq",
    "watermark",
    "status",
    "errorDigest",
  ]);
  assertAsciiName(value.name, `${label}.name`);
  if (Buffer.byteLength(value.name, "utf8") > 128) {
    throw invalidFrame(`${label}.name exceeds 128 bytes`);
  }
  assertVersion(value.version, `${label}.version`);
  assertVersion(value.inputFactSchemaVersion, `${label}.inputFactSchemaVersion`);
  if (!new Set(["session", "turn", "capability"]).has(value.rootKind)) {
    throw invalidFrame(`${label}.rootKind is invalid`);
  }
  assertDecimal(value.baseSnapshotSeq, `${label}.baseSnapshotSeq`);
  assertDecimal(value.watermark, `${label}.watermark`);
  if (BigInt(value.watermark) < BigInt(value.baseSnapshotSeq)) {
    throw invalidFrame(`${label}.watermark precedes baseSnapshotSeq`);
  }
  if (!new Set(["active", "building", "failed"]).has(value.status)) {
    throw invalidFrame(`${label}.status is invalid`);
  }
  if (value.status === "failed") assertHex64(value.errorDigest, `${label}.errorDigest`);
  else if (value.errorDigest !== null) {
    throw invalidFrame(`${label}.errorDigest is only valid for failed projections`);
  }
}

function assertEngineStatus(message) {
  assertEnvelope(message, "ENGINE_STATUS", [
    "snapshotSeq",
    "snapshotAgeMs",
    "snapshotPending",
    "factStorageProfile",
    "projections",
    "changeLog",
    "purge",
    "storage",
    "integrity",
  ]);
  assertDecimal(message.snapshotSeq, "ENGINE_STATUS.snapshotSeq");
  if (typeof message.snapshotPending !== "boolean") {
    throw invalidFrame("ENGINE_STATUS.snapshotPending must be boolean");
  }
  const pending = message.snapshotSeq === "0";
  if (message.snapshotPending !== pending) {
    throw invalidFrame("ENGINE_STATUS snapshot pending state is inconsistent");
  }
  if (pending) {
    if (message.snapshotAgeMs !== null) {
      throw invalidFrame("ENGINE_STATUS.snapshotAgeMs must be null while pending");
    }
  } else {
    assertDecimal(message.snapshotAgeMs, "ENGINE_STATUS.snapshotAgeMs");
  }
  if (!new Set(["normalized-row-v1", "packed-facts-v1"]).has(message.factStorageProfile)) {
    throw invalidFrame("ENGINE_STATUS.factStorageProfile is invalid");
  }

  if (!Array.isArray(message.projections) ||
      message.projections.length > MAX_ENGINE_STATUS_PROJECTIONS) {
    throw invalidFrame("ENGINE_STATUS.projections exceeds its bounded limit");
  }
  let previous = null;
  for (let index = 0; index < message.projections.length; index += 1) {
    const projection = message.projections[index];
    assertProjectionStatus(projection, `ENGINE_STATUS.projections[${index}]`);
    if (previous !== null &&
        (previous.name > projection.name ||
         (previous.name === projection.name && previous.version >= projection.version))) {
      throw invalidFrame("ENGINE_STATUS.projections must be name/version sorted and unique");
    }
    previous = projection;
  }

  assertExactKeys(message.changeLog, "ENGINE_STATUS.changeLog", [
    "rows",
    "payloadBytes",
    "maxRows",
    "maxPayloadBytes",
    "state",
  ]);
  for (const field of ["rows", "payloadBytes", "maxRows", "maxPayloadBytes"]) {
    assertDecimal(message.changeLog[field], `ENGINE_STATUS.changeLog.${field}`);
  }
  if (BigInt(message.changeLog.maxRows) !== CHANGE_LOG_MAX_ROWS ||
      BigInt(message.changeLog.maxPayloadBytes) !== CHANGE_LOG_MAX_PAYLOAD_BYTES) {
    throw invalidFrame("ENGINE_STATUS.changeLog caps are invalid");
  }
  const exceeded = BigInt(message.changeLog.rows) > BigInt(message.changeLog.maxRows) ||
    BigInt(message.changeLog.payloadBytes) > BigInt(message.changeLog.maxPayloadBytes);
  if (message.changeLog.state !== (exceeded ? "cap-exceeded" : "within-cap")) {
    throw invalidFrame("ENGINE_STATUS.changeLog.state is inconsistent");
  }

  assertExactKeys(message.purge, "ENGINE_STATUS.purge", [
    "state", "pendingFacts", "pendingMaintenance", "purged",
  ]);
  assertPurgeStatusFields(message.purge, "ENGINE_STATUS.purge");

  assertExactKeys(message.storage, "ENGINE_STATUS.storage", [
    "databaseBytes", "walBytes", "walPressureAction", "recentDiagnostic",
  ]);
  assertDecimal(message.storage.databaseBytes, "ENGINE_STATUS.storage.databaseBytes");
  assertDecimal(message.storage.walBytes, "ENGINE_STATUS.storage.walBytes");
  const walBytes = BigInt(message.storage.walBytes);
  const expectedAction = walBytes >= WAL_BACKPRESSURE_BYTES
    ? "backpressure"
    : walBytes >= WAL_PASSIVE_CHECKPOINT_BYTES
      ? "passive-checkpoint"
      : "none";
  if (message.storage.walPressureAction !== expectedAction) {
    throw invalidFrame("ENGINE_STATUS.storage.walPressureAction is inconsistent");
  }
  const expectedDiagnostic = expectedAction === "backpressure"
    ? "TS_INSIGHTS_WAL_BACKPRESSURE"
    : null;
  if (message.storage.recentDiagnostic !== expectedDiagnostic) {
    throw invalidFrame("ENGINE_STATUS.storage.recentDiagnostic is inconsistent");
  }

  assertExactKeys(message.integrity, "ENGINE_STATUS.integrity", ["quickCheck", "fts"]);
  if (message.integrity.quickCheck !== "ok" || message.integrity.fts !== "ok") {
    throw invalidFrame("ENGINE_STATUS.integrity must report successful checks");
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
  if (!new Set([
    "protocol", "compatibility", "validation", "conflict", "storage", "maintenance",
  ]).has(
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
  else if (message.type === "LIST_SOURCE_STATES") assertListSourceStates(message);
  else if (message.type === "SOURCE_STATES") assertSourceStates(message);
  else if (message.type === "READ_SOURCE_CHECKPOINT") assertReadSourceCheckpoint(message);
  else if (message.type === "SOURCE_CHECKPOINT") assertSourceCheckpoint(message);
  else if (message.type === "REMOVE_SOURCE" || message.type === "EXCLUDE_SOURCE") {
    assertSourceLifecycleRequest(message, message.type);
  }
  else if (message.type === "SOURCE_REMOVED") assertSourceRemoved(message);
  else if (message.type === "SOURCE_EXCLUDED") assertSourceExcluded(message);
  else if (message.type === "READ_PURGE_STATUS") assertReadPurgeStatus(message);
  else if (message.type === "PURGE_STATUS") assertPurgeStatus(message);
  else if (message.type === "RUN_PURGE_MAINTENANCE") assertRunPurgeMaintenance(message);
  else if (message.type === "PURGE_MAINTENANCE_STATUS") assertPurgeMaintenanceStatus(message);
  else if (message.type === "READ_ENGINE_STATUS") assertReadEngineStatus(message);
  else if (message.type === "ENGINE_STATUS") assertEngineStatus(message);
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

function sourceStateForCommit(delta, sourceState) {
  if (sourceState === undefined || sourceState === null) return null;
  const publicFields = SOURCE_STATE_FIELDS.map((field) =>
    field === "fileUtf8Hex" ? "file" : field);
  assertExactKeys(sourceState, "sourceState", [...publicFields, "checkpoint"]);
  if (canonicalJson(sourceState.checkpoint) !== canonicalJson(delta.checkpoint)) {
    throw invalidFrame("sourceState.checkpoint must equal delta.checkpoint");
  }
  const { checkpoint: _checkpoint, file, ...publicState } = sourceState;
  assertPortableAbsolutePath(file, "sourceState.file");
  const state = { ...publicState, fileUtf8Hex: encodeSourceLocator(file) };
  assertSourceState(state, "sourceState");
  if (state.sessionKey !== delta.session.sessionKey ||
      state.provider !== delta.session.provider ||
      state.projectKey !== (delta.session.projectKey ?? null) ||
      state.metadata.size !== delta.checkpoint.sourceSize ||
      state.metadata.mtimeNs !== delta.checkpoint.sourceMtimeNs ||
      state.contract.factSchemaVersion !== delta.factSchemaVersion ||
      state.contract.providerAdapterVersion !== delta.providerAdapterVersion ||
      state.contract.privacyPolicyVersion !== delta.privacyPolicyVersion ||
      state.contract.duplicatePolicyVersion !== delta.duplicatePolicyVersion ||
      state.contract.originSecretEpoch !== delta.originSecretEpoch) {
    throw invalidFrame("sourceState must match the committed delta");
  }
  const completeOffset = BigInt(delta.checkpoint.completeOffset);
  const sourceSize = BigInt(delta.checkpoint.sourceSize);
  const head = state.fingerprints.head;
  const boundary = state.fingerprints.boundary;
  if (head.offset !== "0" ||
      BigInt(head.length) !== (sourceSize < 4096n ? sourceSize : 4096n) ||
      BigInt(boundary.length) !== (completeOffset < 4096n ? completeOffset : 4096n) ||
      BigInt(boundary.offset) + BigInt(boundary.length) !== completeOffset) {
    throw invalidFrame("sourceState fingerprints must match the committed checkpoint");
  }
  return state;
}

export function createCommitSessionMessage(
  delta,
  { requestId, nextSequence, sourceState = null },
) {
  return assertProtocolMessage(
    envelope("COMMIT_SESSION", requestId, {
      nextSequence,
      checkpoint: delta.checkpoint,
      diagnostics: delta.diagnostics,
      coverage: delta.coverage,
      sourceState: sourceStateForCommit(delta, sourceState),
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

export function createListSourceStatesMessage({ requestId, cursor = null, limit = 256 }) {
  return assertProtocolMessage(
    envelope("LIST_SOURCE_STATES", requestId, { cursor, limit }),
  );
}

export function createSourceStatesMessage({ requestId, states, nextCursor = null }) {
  return assertProtocolMessage(
    envelope("SOURCE_STATES", requestId, { states, nextCursor }),
  );
}

export function createReadSourceCheckpointMessage({ requestId, sessionKey }) {
  return assertProtocolMessage(
    envelope("READ_SOURCE_CHECKPOINT", requestId, { sessionKey }),
  );
}

export function createSourceCheckpointMessage({ requestId, sessionKey, checkpoint }) {
  return assertProtocolMessage(
    envelope("SOURCE_CHECKPOINT", requestId, { sessionKey, checkpoint }),
  );
}

export function createRemoveSourceMessage({ requestId, sessionKey }) {
  return assertProtocolMessage(envelope("REMOVE_SOURCE", requestId, { sessionKey }));
}

export function createSourceRemovedMessage({ requestId, sessionKey, removed }) {
  return assertProtocolMessage(
    envelope("SOURCE_REMOVED", requestId, { sessionKey, removed }),
  );
}

export function createExcludeSourceMessage({ requestId, sessionKey }) {
  return assertProtocolMessage(envelope("EXCLUDE_SOURCE", requestId, { sessionKey }));
}

export function createSourceExcludedMessage({ requestId, sessionKey, excluded, purgeState }) {
  return assertProtocolMessage(
    envelope("SOURCE_EXCLUDED", requestId, { sessionKey, excluded, purgeState }),
  );
}

export function createReadPurgeStatusMessage({ requestId, sessionKey = null }) {
  return assertProtocolMessage(envelope("READ_PURGE_STATUS", requestId, { sessionKey }));
}

export function createPurgeStatusMessage({ requestId, sessionKey = null, status }) {
  return assertProtocolMessage(envelope("PURGE_STATUS", requestId, {
    sessionKey,
    state: status.state,
    pendingFacts: status.pendingFacts,
    pendingMaintenance: status.pendingMaintenance,
    purged: status.purged,
  }));
}

export function createRunPurgeMaintenanceMessage({ requestId, limit = 64 }) {
  return assertProtocolMessage(envelope("RUN_PURGE_MAINTENANCE", requestId, { limit }));
}

export function createPurgeMaintenanceStatusMessage({ requestId, outcome }) {
  return assertProtocolMessage(envelope("PURGE_MAINTENANCE_STATUS", requestId, {
    processedSessions: outcome.processedSessions,
    purgedSessions: outcome.purgedSessions,
    state: outcome.state,
    pendingFacts: outcome.pendingFacts,
    pendingMaintenance: outcome.pendingMaintenance,
    purged: outcome.purged,
  }));
}

export function createReadEngineStatusMessage({ requestId }) {
  return assertProtocolMessage(envelope("READ_ENGINE_STATUS", requestId, {}));
}

export function createEngineStatusMessage({ requestId, status }) {
  assertPlainObject(status, "status");
  return assertProtocolMessage(envelope("ENGINE_STATUS", requestId, { ...status }));
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
    sourceState = null,
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
    sourceState,
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
