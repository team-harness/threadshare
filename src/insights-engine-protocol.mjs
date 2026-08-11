import { TextDecoder } from "node:util";

import { assertWellFormedUnicode, canonicalJson } from "./canonical-json.mjs";

export const INSIGHTS_PROTOCOL_FORMAT = "threadshare-insights-protocol@v1";
export const INSIGHTS_PROTOCOL_VERSION = 1;
export const MAX_PROTOCOL_PAYLOAD_BYTES = 4_194_304;
export const ACTIVE_INSIGHTS_PROJECTION_VERSIONS = Object.freeze([
  "turn-search@2",
  "turn-summary@1",
]);
export const ACTIVE_INSIGHTS_ANALYZER_CAPABILITIES = Object.freeze([
  "mixed-cjk-code@1",
]);
const ACTIVE_INSIGHTS_PROVIDER_ADAPTER_VERSIONS = Object.freeze(["claude@1", "codex@1"]);

export function createInsightsRequiredContract(originSecretEpoch) {
  return Object.freeze({
    factSchemaVersion: 1,
    providerAdapterVersions: ACTIVE_INSIGHTS_PROVIDER_ADAPTER_VERSIONS,
    privacyPolicyVersion: 1,
    originSecretEpoch,
    duplicatePolicyVersion: 1,
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: ACTIVE_INSIGHTS_PROJECTION_VERSIONS,
    analyzerCapabilities: ACTIVE_INSIGHTS_ANALYZER_CAPABILITIES,
    rankerVersion: 1,
  });
}

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
  "READ_INSIGHTS_OVERVIEW",
  "INSIGHTS_OVERVIEW",
  "LIST_CAPABILITIES",
  "CAPABILITY_PAGE",
  "SEARCH_TURNS",
  "TURN_SEARCH_RESULTS",
  "READ_TURN_EVIDENCE",
  "TURN_EVIDENCE_PAGE",
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
const MAX_OVERVIEW_PROVIDERS = 16;
const MAX_OVERVIEW_PROJECTS = 512;
const MAX_OVERVIEW_FACT_SIGNALS = 1_024;
const MAX_CAPABILITY_PAGE_SIZE = 200;
const CHANGE_LOG_MAX_ROWS = 1_000_000n;
const CHANGE_LOG_MAX_PAYLOAD_BYTES = 64n * 1_024n * 1_024n;
const WAL_PASSIVE_CHECKPOINT_BYTES = 64n * 1_024n * 1_024n;
const WAL_BACKPRESSURE_BYTES = 128n * 1_024n * 1_024n;
const MAX_QUERY_BYTES = 8 * 1_024;
const MAX_SEARCH_RESULTS = 200;
const MAX_SEARCH_CANDIDATES = 300;
const MAX_PATH_FAMILIES = 20;
const MAX_PATH_NODES = 128;
const MAX_PATH_TOOL_EVENTS = MAX_SEARCH_RESULTS * MAX_PATH_NODES;
const MAX_SCORING_TERMS = 32;
const MAX_FILTER_KEYS = 64;
const MAX_FILTER_PROVIDERS = 16;
const MAX_SEARCH_EXCERPT_BYTES = 512;
const MAX_TURN_PROBLEM_BYTES = 64 * 1_024;
const MAX_TURN_ANSWER_BYTES = 8 * 1_024;
const MAX_EVIDENCE_PAGE_ENTRIES = 128;
const MAX_CURSOR_BYTES = 256;
const MAX_PPM = 1_000_000;
const SEARCH_RESULT_EVIDENCE = new Set(["abandoned", "provider-completed", "unknown"]);
const SEARCH_CLOSURE_STATES = new Set(["hard-sealed", "open", "quiescent"]);
const FTS_FIELDS = new Set(["capability", "code", "natural"]);

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

function assertSafeInteger(value, label, { min = 0, max = Number.MAX_SAFE_INTEGER } = {}) {
  if (!Number.isSafeInteger(value) || value < min || value > max) {
    throw invalidFrame(`${label} must be a safe integer in [${min}, ${max}]`);
  }
}

function assertBoolean(value, label) {
  if (typeof value !== "boolean") throw invalidFrame(`${label} must be boolean`);
}

function assertBoundedString(
  value,
  label,
  maxBytes,
  { allowEmpty = true, ascii = false } = {},
) {
  if (typeof value !== "string" || (!allowEmpty && value.length === 0)) {
    throw invalidFrame(`${label} must be ${allowEmpty ? "a" : "a non-empty"} string`);
  }
  try {
    assertWellFormedUnicode(value);
  } catch (error) {
    throw invalidFrame(`${label} must contain well-formed Unicode`, error);
  }
  if (ascii && value.length > 0 && !ASCII_NAME.test(value)) {
    throw invalidFrame(`${label} must contain printable ASCII`);
  }
  if (Buffer.byteLength(value, "utf8") > maxBytes) {
    throw invalidFrame(`${label} exceeds ${maxBytes} UTF-8 bytes`);
  }
}

function assertNullableHex64(value, label) {
  if (value !== null) assertHex64(value, label);
}

function assertCanonicalTimestamp(value, label) {
  if (value === null) return;
  assertBoundedString(value, label, 32, { allowEmpty: false, ascii: true });
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.valueOf()) || parsed.toISOString() !== value) {
    throw invalidFrame(`${label} must be a canonical UTC timestamp`);
  }
}

function assertEnum(value, label, allowed) {
  if (typeof value !== "string" || !allowed.has(value)) {
    throw invalidFrame(`${label} is invalid`);
  }
}

function assertBoundedSortedArray(value, label, maxItems, validateItem) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw invalidFrame(`${label} must be an array with at most ${maxItems} items`);
  }
  for (let index = 0; index < value.length; index += 1) {
    validateItem(value[index], `${label}[${index}]`);
    if (index > 0 && compareAscii(value[index - 1], value[index]) >= 0) {
      throw invalidFrame(`${label} must be ASCII-sorted and contain unique values`);
    }
  }
}

function canonicalBoundedArray(value, label, maxItems, validateItem) {
  if (!Array.isArray(value) || value.length > maxItems) {
    throw invalidFrame(`${label} must be an array with at most ${maxItems} items`);
  }
  const result = [...value];
  for (let index = 0; index < result.length; index += 1) {
    validateItem(result[index], `${label}[${index}]`);
  }
  result.sort(compareAscii);
  for (let index = 1; index < result.length; index += 1) {
    if (result[index - 1] === result[index]) {
      throw invalidFrame(`${label} contains duplicates`);
    }
  }
  return result;
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

function assertDecimalObject(value, label, fields) {
  assertExactKeys(value, label, fields);
  for (const field of fields) assertDecimal(value[field], `${label}.${field}`);
}

function decimalSum(value, fields) {
  return fields.reduce((total, field) => total + BigInt(value[field]), 0n);
}

function assertBoundedItems(value, label, maximum) {
  assertExactKeys(value, label, ["items", "truncated"]);
  if (!Array.isArray(value.items) || value.items.length > maximum) {
    throw invalidFrame(`${label}.items exceeds its bounded limit`);
  }
  assertBoolean(value.truncated, `${label}.truncated`);
  return value.items;
}

function assertOverviewRollups(value, label, maximum, keyName) {
  const items = assertBoundedItems(value, label, maximum);
  let previous = null;
  for (let index = 0; index < items.length; index += 1) {
    const itemLabel = `${label}.items[${index}]`;
    const item = items[index];
    assertExactKeys(item, itemLabel, [
      keyName, "rawSessionCount", "eligibleSessionCount", "indexedTurnCount",
    ]);
    if (keyName === "projectKey") assertHex64(item[keyName], `${itemLabel}.${keyName}`);
    else assertBoundedString(item[keyName], `${itemLabel}.${keyName}`, 128, {
      allowEmpty: false,
      ascii: true,
    });
    if (previous !== null && compareAscii(previous, item[keyName]) >= 0) {
      throw invalidFrame(`${label}.items must be key-sorted and unique`);
    }
    previous = item[keyName];
    for (const field of ["rawSessionCount", "eligibleSessionCount", "indexedTurnCount"]) {
      assertDecimal(item[field], `${itemLabel}.${field}`);
    }
    if (BigInt(item.eligibleSessionCount) > BigInt(item.rawSessionCount)) {
      throw invalidFrame(`${itemLabel} eligible sessions exceed raw sessions`);
    }
  }
}

function assertFactCountItems(value, label, keyName) {
  const items = assertBoundedItems(value, label, MAX_OVERVIEW_FACT_SIGNALS);
  let previous = null;
  for (let index = 0; index < items.length; index += 1) {
    const itemLabel = `${label}.items[${index}]`;
    const item = items[index];
    assertExactKeys(item, itemLabel, [keyName, "count"]);
    assertBoundedString(item[keyName], `${itemLabel}.${keyName}`, 256, {
      allowEmpty: false,
      ascii: true,
    });
    assertDecimal(item.count, `${itemLabel}.count`);
    if (previous !== null && compareAscii(previous, item[keyName]) >= 0) {
      throw invalidFrame(`${label}.items must be key-sorted and unique`);
    }
    previous = item[keyName];
  }
}

function assertReadInsightsOverview(message) {
  assertEnvelope(message, "READ_INSIGHTS_OVERVIEW", ["nowUnixMs", "quiescenceSeconds"]);
  assertDecimal(message.nowUnixMs, "READ_INSIGHTS_OVERVIEW.nowUnixMs");
  assertSafeInteger(
    message.quiescenceSeconds,
    "READ_INSIGHTS_OVERVIEW.quiescenceSeconds",
    { min: 60, max: 86_400 },
  );
}

function assertInsightsOverview(message) {
  assertEnvelope(message, "INSIGHTS_OVERVIEW", [
    "snapshotSeq", "sessions", "scopes", "dedupe", "turns", "capabilities",
    "providers", "projects", "coverage", "diagnostics",
  ]);
  assertDecimal(message.snapshotSeq, "INSIGHTS_OVERVIEW.snapshotSeq");
  assertDecimalObject(message.sessions, "INSIGHTS_OVERVIEW.sessions", [
    "raw", "eligible", "excluded", "subagentExcluded", "unknown",
  ]);
  if (decimalSum(message.sessions, ["eligible", "excluded", "subagentExcluded", "unknown"]) !==
      BigInt(message.sessions.raw)) {
    throw invalidFrame("INSIGHTS_OVERVIEW session categories do not sum to raw");
  }
  assertDecimalObject(message.scopes, "INSIGHTS_OVERVIEW.scopes", [
    "main", "subagent", "unknown",
  ]);
  if (decimalSum(message.scopes, ["main", "subagent", "unknown"]) !==
      BigInt(message.sessions.raw)) {
    throw invalidFrame("INSIGHTS_OVERVIEW scope counts do not sum to raw sessions");
  }
  assertDecimalObject(message.dedupe, "INSIGHTS_OVERVIEW.dedupe", [
    "strongGroup", "weakGroup", "observedEofProvisionalSession", "unknownSession",
  ]);
  assertDecimalObject(message.turns, "INSIGHTS_OVERVIEW.turns", [
    "indexed", "active", "rolledBack", "unknownVisibility", "hardSealed", "quiescent", "open",
  ]);
  if (BigInt(message.turns.indexed) > BigInt(message.turns.active) ||
      decimalSum(message.turns, ["hardSealed", "quiescent", "open"]) >
        BigInt(message.turns.active)) {
    throw invalidFrame("INSIGHTS_OVERVIEW Turn counts are inconsistent");
  }
  assertDecimalObject(message.capabilities, "INSIGHTS_OVERVIEW.capabilities", [
    "total", "tool", "skill",
  ]);
  if (BigInt(message.capabilities.tool) + BigInt(message.capabilities.skill) !==
      BigInt(message.capabilities.total)) {
    throw invalidFrame("INSIGHTS_OVERVIEW capability categories do not sum to total");
  }
  assertOverviewRollups(message.providers, "INSIGHTS_OVERVIEW.providers", MAX_OVERVIEW_PROVIDERS, "provider");
  assertOverviewRollups(message.projects, "INSIGHTS_OVERVIEW.projects", MAX_OVERVIEW_PROJECTS, "projectKey");
  assertFactCountItems(message.coverage, "INSIGHTS_OVERVIEW.coverage", "key");
  assertFactCountItems(message.diagnostics, "INSIGHTS_OVERVIEW.diagnostics", "code");
  assertMessagePayloadBound(message, "INSIGHTS_OVERVIEW");
}

function assertListCapabilities(message) {
  assertEnvelope(message, "LIST_CAPABILITIES", ["kind", "cursor", "limit"]);
  assertEnum(message.kind, "LIST_CAPABILITIES.kind", new Set(["tool", "skill"]));
  assertNullableHex64(message.cursor, "LIST_CAPABILITIES.cursor");
  assertSafeInteger(message.limit, "LIST_CAPABILITIES.limit", {
    min: 1,
    max: MAX_CAPABILITY_PAGE_SIZE,
  });
}

function assertCapabilityPage(message) {
  assertEnvelope(message, "CAPABILITY_PAGE", ["snapshotSeq", "items", "nextCursor"]);
  assertDecimal(message.snapshotSeq, "CAPABILITY_PAGE.snapshotSeq");
  if (!Array.isArray(message.items) || message.items.length > MAX_CAPABILITY_PAGE_SIZE) {
    throw invalidFrame("CAPABILITY_PAGE.items exceeds its bounded limit");
  }
  let previous = null;
  for (let index = 0; index < message.items.length; index += 1) {
    const itemLabel = `CAPABILITY_PAGE.items[${index}]`;
    const item = message.items[index];
    assertExactKeys(item, itemLabel, [
      "capabilityKey", "provider", "kind", "canonicalName", "useCount", "turnCount",
      "sessionCount", "terminal", "strength",
    ]);
    assertHex64(item.capabilityKey, `${itemLabel}.capabilityKey`);
    if (previous !== null && compareAscii(previous, item.capabilityKey) >= 0) {
      throw invalidFrame("CAPABILITY_PAGE.items must be capabilityKey-sorted and unique");
    }
    previous = item.capabilityKey;
    assertBoundedString(item.provider, `${itemLabel}.provider`, 128, {
      allowEmpty: false,
      ascii: true,
    });
    assertEnum(item.kind, `${itemLabel}.kind`, new Set(["tool", "skill"]));
    assertBoundedString(item.canonicalName, `${itemLabel}.canonicalName`, 512, {
      allowEmpty: false,
    });
    for (const field of ["useCount", "turnCount", "sessionCount"]) {
      assertDecimal(item[field], `${itemLabel}.${field}`);
    }
    if (BigInt(item.turnCount) > BigInt(item.useCount) ||
        BigInt(item.sessionCount) > BigInt(item.turnCount)) {
      throw invalidFrame(`${itemLabel} aggregate counts are inconsistent`);
    }
    assertDecimalObject(item.terminal, `${itemLabel}.terminal`, [
      "pending", "completed", "failed", "cancelled", "unknown",
    ]);
    assertDecimalObject(item.strength, `${itemLabel}.strength`, [
      "observed", "confirmed", "inferred",
    ]);
    if (decimalSum(item.terminal, ["pending", "completed", "failed", "cancelled", "unknown"]) !==
          BigInt(item.useCount) ||
        decimalSum(item.strength, ["observed", "confirmed", "inferred"]) !==
          BigInt(item.useCount)) {
      throw invalidFrame(`${itemLabel} state counts do not sum to useCount`);
    }
  }
  assertNullableHex64(message.nextCursor, "CAPABILITY_PAGE.nextCursor");
  if (message.nextCursor !== null && message.nextCursor !== previous) {
    throw invalidFrame("CAPABILITY_PAGE.nextCursor must equal the final capabilityKey");
  }
  assertMessagePayloadBound(message, "CAPABILITY_PAGE");
}

function assertSearchFilters(filters, label) {
  assertExactKeys(filters, label, [
    "providers",
    "projectKeys",
    "observedAtOrAfterUnixMs",
    "observedBeforeUnixMs",
    "toolCapabilityKeys",
    "skillCapabilityKeys",
    "resultEvidence",
    "closureStates",
  ]);
  assertBoundedSortedArray(filters.providers, `${label}.providers`, MAX_FILTER_PROVIDERS,
    (value, itemLabel) => assertBoundedString(value, itemLabel, 64, {
      allowEmpty: false,
      ascii: true,
    }));
  for (const field of ["projectKeys", "toolCapabilityKeys", "skillCapabilityKeys"]) {
    assertBoundedSortedArray(filters[field], `${label}.${field}`, MAX_FILTER_KEYS, assertHex64);
  }
  if (filters.observedAtOrAfterUnixMs !== null) {
    assertDecimal(filters.observedAtOrAfterUnixMs, `${label}.observedAtOrAfterUnixMs`);
  }
  if (filters.observedBeforeUnixMs !== null) {
    assertDecimal(filters.observedBeforeUnixMs, `${label}.observedBeforeUnixMs`);
  }
  if (filters.observedAtOrAfterUnixMs !== null && filters.observedBeforeUnixMs !== null &&
      BigInt(filters.observedAtOrAfterUnixMs) >= BigInt(filters.observedBeforeUnixMs)) {
    throw invalidFrame(`${label} timestamp interval must be non-empty`);
  }
  assertBoundedSortedArray(filters.resultEvidence, `${label}.resultEvidence`, 3,
    (value, itemLabel) => assertEnum(value, itemLabel, SEARCH_RESULT_EVIDENCE));
  assertBoundedSortedArray(filters.closureStates, `${label}.closureStates`, 3,
    (value, itemLabel) => assertEnum(value, itemLabel, SEARCH_CLOSURE_STATES));
}

function hasStructuredSearchFilter(filters) {
  return filters.providers.length > 0 || filters.projectKeys.length > 0 ||
    filters.observedAtOrAfterUnixMs !== null || filters.observedBeforeUnixMs !== null ||
    filters.toolCapabilityKeys.length > 0 || filters.skillCapabilityKeys.length > 0 ||
    filters.resultEvidence.length > 0 || filters.closureStates.length > 0;
}

function assertSearchTurns(message) {
  assertEnvelope(message, "SEARCH_TURNS", [
    "query", "filters", "limit", "pathLimit", "nowUnixMs", "quiescenceSeconds",
  ]);
  assertBoundedString(message.query, "SEARCH_TURNS.query", MAX_PROTOCOL_PAYLOAD_BYTES);
  assertSearchFilters(message.filters, "SEARCH_TURNS.filters");
  assertSafeInteger(message.limit, "SEARCH_TURNS.limit", { min: 1, max: MAX_SEARCH_RESULTS });
  assertSafeInteger(message.pathLimit, "SEARCH_TURNS.pathLimit", { min: 0, max: MAX_PATH_FAMILIES });
  assertDecimal(message.nowUnixMs, "SEARCH_TURNS.nowUnixMs");
  assertSafeInteger(message.quiescenceSeconds, "SEARCH_TURNS.quiescenceSeconds", {
    min: 60,
    max: 86_400,
  });
}

function assertSearchRequestDomain(message) {
  if (Buffer.byteLength(message.query, "utf8") > MAX_QUERY_BYTES) {
    throw protocolError("QUERY_TOO_LONG", "query exceeds 8 KiB UTF-8");
  }
  if (message.query.length === 0 && !hasStructuredSearchFilter(message.filters)) {
    throw protocolError("QUERY_TOO_BROAD", "query requires text or a structured filter");
  }
}

function assertSearchSnapshot(snapshot, label) {
  assertExactKeys(snapshot, label, [
    "snapshotSeq", "projectionVersion", "analyzerVersion", "rankerVersion",
  ]);
  assertDecimal(snapshot.snapshotSeq, `${label}.snapshotSeq`);
  assertVersion(snapshot.projectionVersion, `${label}.projectionVersion`);
  assertVersion(snapshot.analyzerVersion, `${label}.analyzerVersion`);
  assertVersion(snapshot.rankerVersion, `${label}.rankerVersion`);
}

function assertScoringTerm(term, label) {
  assertExactKeys(term, label, [
    "logicalTerm", "field", "token", "documentFrequency", "fieldDocumentCount",
  ]);
  assertBoundedString(term.logicalTerm, `${label}.logicalTerm`, 512, { allowEmpty: false });
  assertEnum(term.field, `${label}.field`, FTS_FIELDS);
  assertBoundedString(term.token, `${label}.token`, 512, { allowEmpty: false, ascii: true });
  assertDecimal(term.documentFrequency, `${label}.documentFrequency`);
  assertDecimal(term.fieldDocumentCount, `${label}.fieldDocumentCount`);
  if (BigInt(term.documentFrequency) > BigInt(term.fieldDocumentCount)) {
    throw invalidFrame(`${label}.documentFrequency exceeds its field document count`);
  }
}

function assertPpm(value, label) {
  assertSafeInteger(value, label, { min: 0, max: MAX_PPM });
}

function assertSearchScore(score, label, scoringTermCount) {
  if (score === null) return;
  assertExactKeys(score, label, [
    "relevancePpm",
    "bm25Rank",
    "rankComponentPpm",
    "idfCoveragePpm",
    "exact",
    "matchedTermIndexes",
  ]);
  assertPpm(score.relevancePpm, `${label}.relevancePpm`);
  assertSafeInteger(score.bm25Rank, `${label}.bm25Rank`, { min: 1, max: 300 });
  assertPpm(score.rankComponentPpm, `${label}.rankComponentPpm`);
  assertPpm(score.idfCoveragePpm, `${label}.idfCoveragePpm`);
  assertBoolean(score.exact, `${label}.exact`);
  if (!Array.isArray(score.matchedTermIndexes) ||
      score.matchedTermIndexes.length > MAX_SCORING_TERMS) {
    throw invalidFrame(`${label}.matchedTermIndexes exceeds its bounded limit`);
  }
  if (scoringTermCount === 0 && score.matchedTermIndexes.length > 0) {
    throw invalidFrame(`${label}.matchedTermIndexes requires scoring terms`);
  }
  for (let index = 0; index < score.matchedTermIndexes.length; index += 1) {
    const termIndex = score.matchedTermIndexes[index];
    assertSafeInteger(termIndex, `${label}.matchedTermIndexes[${index}]`, {
      min: 0,
      max: Math.max(0, scoringTermCount - 1),
    });
    if (index > 0 && score.matchedTermIndexes[index - 1] >= termIndex) {
      throw invalidFrame(`${label}.matchedTermIndexes must be sorted and unique`);
    }
  }
}

function assertNullableBoundedString(value, label, maxBytes) {
  if (value !== null) assertBoundedString(value, label, maxBytes);
}

function assertSearchResult(result, label, scoringTermCount) {
  assertExactKeys(result, label, [
    "turnKey",
    "sessionKey",
    "revision",
    "provider",
    "projectKey",
    "observedTimestamp",
    "problemExcerpt",
    "problemTruncated",
    "finalAnswerExcerpt",
    "finalAnswerTruncated",
    "closureState",
    "resultEvidence",
    "score",
  ]);
  assertHex64(result.turnKey, `${label}.turnKey`);
  assertHex64(result.sessionKey, `${label}.sessionKey`);
  assertHex64(result.revision, `${label}.revision`);
  assertBoundedString(result.provider, `${label}.provider`, 64, {
    allowEmpty: false,
    ascii: true,
  });
  assertNullableHex64(result.projectKey, `${label}.projectKey`);
  assertCanonicalTimestamp(result.observedTimestamp, `${label}.observedTimestamp`);
  assertBoundedString(result.problemExcerpt, `${label}.problemExcerpt`, MAX_SEARCH_EXCERPT_BYTES);
  assertBoolean(result.problemTruncated, `${label}.problemTruncated`);
  assertNullableBoundedString(
    result.finalAnswerExcerpt,
    `${label}.finalAnswerExcerpt`,
    MAX_SEARCH_EXCERPT_BYTES,
  );
  assertBoolean(result.finalAnswerTruncated, `${label}.finalAnswerTruncated`);
  assertEnum(result.closureState, `${label}.closureState`, SEARCH_CLOSURE_STATES);
  assertEnum(result.resultEvidence, `${label}.resultEvidence`, SEARCH_RESULT_EVIDENCE);
  assertSearchScore(result.score, `${label}.score`, scoringTermCount);
}

function assertToolStateCounts(counts, label) {
  assertExactKeys(counts, label, ["pending", "completed", "failed", "cancelled", "unknown"]);
  for (const field of ["pending", "completed", "failed", "cancelled", "unknown"]) {
    assertSafeInteger(counts[field], `${label}.${field}`, { min: 0, max: MAX_PATH_TOOL_EVENTS });
  }
}

function assertPathFamily(family, label) {
  assertExactKeys(family, label, [
    "fingerprint",
    "nodes",
    "truncated",
    "bestRelevancePpm",
    "turnCount",
    "rawSessionCount",
    "independentGroupCount",
    "strongGroupCount",
    "weakGroupCount",
    "observedEofProvisionalGroupCount",
    "unknownDedupeSessionCount",
    "latestUnixMs",
    "toolStateCounts",
    "evidenceTurnKeys",
  ]);
  assertHex64(family.fingerprint, `${label}.fingerprint`);
  if (!Array.isArray(family.nodes) || family.nodes.length > MAX_PATH_NODES) {
    throw invalidFrame(`${label}.nodes exceeds its bounded limit`);
  }
  for (let index = 0; index < family.nodes.length; index += 1) {
    const node = family.nodes[index];
    const nodeLabel = `${label}.nodes[${index}]`;
    assertExactKeys(node, nodeLabel, ["providerScopedName", "repeatBucket"]);
    assertBoundedString(node.providerScopedName, `${nodeLabel}.providerScopedName`, 640, {
      allowEmpty: false,
    });
    assertEnum(node.repeatBucket, `${nodeLabel}.repeatBucket`, new Set(["1", "2-3", "4+"]));
  }
  assertBoolean(family.truncated, `${label}.truncated`);
  assertPpm(family.bestRelevancePpm, `${label}.bestRelevancePpm`);
  for (const field of [
    "turnCount",
    "rawSessionCount",
    "independentGroupCount",
    "strongGroupCount",
    "weakGroupCount",
    "observedEofProvisionalGroupCount",
    "unknownDedupeSessionCount",
  ]) {
    assertSafeInteger(family[field], `${label}.${field}`, { min: 0, max: MAX_SEARCH_RESULTS });
  }
  if (family.rawSessionCount > family.turnCount ||
      family.independentGroupCount > family.rawSessionCount ||
      family.strongGroupCount + family.weakGroupCount !== family.independentGroupCount ||
      family.observedEofProvisionalGroupCount > family.independentGroupCount ||
      family.unknownDedupeSessionCount > family.rawSessionCount ||
      family.turnCount < 5 ||
      family.independentGroupCount < 3) {
    throw invalidFrame(`${label} support counts are inconsistent`);
  }
  assertSafeInteger(family.latestUnixMs, `${label}.latestUnixMs`, {
    min: 0,
    max: Number.MAX_SAFE_INTEGER,
  });
  assertToolStateCounts(family.toolStateCounts, `${label}.toolStateCounts`);
  assertBoundedSortedArray(
    family.evidenceTurnKeys,
    `${label}.evidenceTurnKeys`,
    MAX_SEARCH_RESULTS,
    assertHex64,
  );
}

function assertEvidencePathReport(report, label) {
  assertExactKeys(report, label, [
    "insufficientSample",
    "rawMatchCount",
    "eligibleTurnCount",
    "rawSessionCount",
    "independentGroupCount",
    "strongGroupCount",
    "weakGroupCount",
    "observedEofProvisionalGroupCount",
    "unknownDedupeCount",
    "unknownDedupeSessionCount",
    "pathsTruncated",
    "families",
  ]);
  assertBoolean(report.insufficientSample, `${label}.insufficientSample`);
  assertBoolean(report.pathsTruncated, `${label}.pathsTruncated`);
  for (const field of [
    "rawMatchCount", "eligibleTurnCount", "rawSessionCount", "independentGroupCount",
    "strongGroupCount", "weakGroupCount", "observedEofProvisionalGroupCount",
    "unknownDedupeCount", "unknownDedupeSessionCount",
  ]) {
    assertSafeInteger(report[field], `${label}.${field}`, { min: 0, max: MAX_SEARCH_RESULTS });
  }
  if (report.eligibleTurnCount > report.rawMatchCount ||
      report.rawSessionCount > report.eligibleTurnCount ||
      report.independentGroupCount > report.rawSessionCount ||
      report.strongGroupCount + report.weakGroupCount !== report.independentGroupCount ||
      report.observedEofProvisionalGroupCount > report.independentGroupCount ||
      report.unknownDedupeCount > report.eligibleTurnCount ||
      report.unknownDedupeSessionCount > report.unknownDedupeCount ||
      report.independentGroupCount + report.unknownDedupeSessionCount > report.rawSessionCount) {
    throw invalidFrame(`${label} aggregate counts are inconsistent`);
  }
  if (!Array.isArray(report.families) || report.families.length > MAX_PATH_FAMILIES) {
    throw invalidFrame(`${label}.families exceeds its bounded limit`);
  }
  if (report.insufficientSample && report.families.length > 0) {
    throw invalidFrame(`${label}.families must be empty for an insufficient sample`);
  }
  let evidenceTurnCount = 0;
  for (let index = 0; index < report.families.length; index += 1) {
    assertPathFamily(report.families[index], `${label}.families[${index}]`);
    evidenceTurnCount += report.families[index].evidenceTurnKeys.length;
  }
  if (evidenceTurnCount > MAX_SEARCH_RESULTS) {
    throw invalidFrame(`${label} path evidence exceeds its bounded limit`);
  }
}

function assertQueryDiagnostic(diagnostic, label) {
  assertExactKeys(diagnostic, label, [
    "analyzeMicros",
    "dfMicros",
    "postingFilterMicros",
    "rerankMicros",
    "pathMicros",
    "zeroDfTermCount",
    "highFrequencyTermCount",
    "truncatedTermCount",
    "scoringTermCount",
  ]);
  for (const field of [
    "analyzeMicros", "dfMicros", "postingFilterMicros", "rerankMicros", "pathMicros",
  ]) {
    assertSafeInteger(diagnostic[field], `${label}.${field}`, {
      min: 0,
      max: Number.MAX_SAFE_INTEGER,
    });
  }
  for (const field of [
    "zeroDfTermCount", "highFrequencyTermCount", "truncatedTermCount", "scoringTermCount",
  ]) {
    assertSafeInteger(diagnostic[field], `${label}.${field}`, { min: 0, max: 65_535 });
  }
  if (diagnostic.scoringTermCount > MAX_SCORING_TERMS) {
    throw invalidFrame(`${label}.scoringTermCount exceeds its bounded limit`);
  }
}

function assertMessagePayloadBound(message, label) {
  if (Buffer.byteLength(canonicalJson(message), "utf8") > MAX_PROTOCOL_PAYLOAD_BYTES) {
    throw invalidFrame(`${label} exceeds the protocol payload limit`);
  }
}

function assertSearchTrace(trace, label) {
  assertExactKeys(trace, label, ["candidateCount", "candidateTurnKeys"]);
  assertSafeInteger(trace.candidateCount, `${label}.candidateCount`, {
    min: 0,
    max: MAX_SEARCH_CANDIDATES,
  });
  if (!Array.isArray(trace.candidateTurnKeys) ||
      trace.candidateTurnKeys.length > MAX_SEARCH_CANDIDATES) {
    throw invalidFrame(`${label}.candidateTurnKeys exceeds its bounded limit`);
  }
  if (trace.candidateCount !== trace.candidateTurnKeys.length) {
    throw invalidFrame(`${label} candidate count is inconsistent`);
  }
  const seen = new Set();
  for (let index = 0; index < trace.candidateTurnKeys.length; index += 1) {
    const key = trace.candidateTurnKeys[index];
    assertHex64(key, `${label}.candidateTurnKeys[${index}]`);
    if (seen.has(key)) throw invalidFrame(`${label}.candidateTurnKeys contains a duplicate`);
    seen.add(key);
  }
}

function assertTurnSearchResults(message) {
  assertEnvelope(message, "TURN_SEARCH_RESULTS", [
    "snapshot",
    "scoringTerms",
    "results",
    "evidencePaths",
    "diagnostic",
    "searchTrace",
  ]);
  assertSearchSnapshot(message.snapshot, "TURN_SEARCH_RESULTS.snapshot");
  if (!Array.isArray(message.scoringTerms) || message.scoringTerms.length > MAX_SCORING_TERMS) {
    throw invalidFrame("TURN_SEARCH_RESULTS.scoringTerms exceeds its bounded limit");
  }
  for (let index = 0; index < message.scoringTerms.length; index += 1) {
    assertScoringTerm(message.scoringTerms[index], `TURN_SEARCH_RESULTS.scoringTerms[${index}]`);
  }
  if (!Array.isArray(message.results) || message.results.length > MAX_SEARCH_RESULTS) {
    throw invalidFrame("TURN_SEARCH_RESULTS.results exceeds its bounded limit");
  }
  for (let index = 0; index < message.results.length; index += 1) {
    assertSearchResult(
      message.results[index],
      `TURN_SEARCH_RESULTS.results[${index}]`,
      message.scoringTerms.length,
    );
  }
  assertEvidencePathReport(message.evidencePaths, "TURN_SEARCH_RESULTS.evidencePaths");
  assertQueryDiagnostic(message.diagnostic, "TURN_SEARCH_RESULTS.diagnostic");
  assertSearchTrace(message.searchTrace, "TURN_SEARCH_RESULTS.searchTrace");
  if (message.diagnostic.scoringTermCount !== message.scoringTerms.length) {
    throw invalidFrame("TURN_SEARCH_RESULTS scoring term count is inconsistent");
  }
  assertMessagePayloadBound(message, "TURN_SEARCH_RESULTS");
}

function assertOpaqueCursor(value, label) {
  if (value !== null) {
    assertBoundedString(value, label, MAX_CURSOR_BYTES, { allowEmpty: false, ascii: true });
  }
}

function assertReadTurnEvidence(message) {
  assertEnvelope(message, "READ_TURN_EVIDENCE", [
    "turnKey", "expectedRevision", "cursor", "limit",
  ]);
  assertHex64(message.turnKey, "READ_TURN_EVIDENCE.turnKey");
  assertNullableHex64(message.expectedRevision, "READ_TURN_EVIDENCE.expectedRevision");
  assertOpaqueCursor(message.cursor, "READ_TURN_EVIDENCE.cursor");
  assertSafeInteger(message.limit, "READ_TURN_EVIDENCE.limit", {
    min: 1,
    max: MAX_EVIDENCE_PAGE_ENTRIES,
  });
}

function assertEvidenceTurn(turn, label) {
  assertExactKeys(turn, label, [
    "turnKey",
    "revision",
    "problemText",
    "finalAnswerExcerpt",
    "observedTimestamp",
    "nextUserBoundary",
    "providerTerminal",
    "observedEofClosed",
    "providerVisibility",
    "factTruncation",
  ]);
  assertHex64(turn.turnKey, `${label}.turnKey`);
  assertNullableHex64(turn.revision, `${label}.revision`);
  assertBoundedString(turn.problemText, `${label}.problemText`, MAX_TURN_PROBLEM_BYTES);
  assertNullableBoundedString(
    turn.finalAnswerExcerpt,
    `${label}.finalAnswerExcerpt`,
    MAX_TURN_ANSWER_BYTES,
  );
  assertCanonicalTimestamp(turn.observedTimestamp, `${label}.observedTimestamp`);
  assertBoolean(turn.nextUserBoundary, `${label}.nextUserBoundary`);
  if (turn.providerTerminal !== null) {
    assertEnum(turn.providerTerminal, `${label}.providerTerminal`, new Set(["aborted", "completed"]));
  }
  assertBoolean(turn.observedEofClosed, `${label}.observedEofClosed`);
  assertEnum(turn.providerVisibility, `${label}.providerVisibility`, new Set(["active"]));
  assertBoundedSortedArray(turn.factTruncation, `${label}.factTruncation`, 64,
    (value, itemLabel) => assertBoundedString(value, itemLabel, 128, {
      allowEmpty: false,
      ascii: true,
    }));
}

function assertEvidenceLink(link, label, roles) {
  assertExactKeys(link, label, ["eventKey", "role"]);
  assertHex64(link.eventKey, `${label}.eventKey`);
  assertEnum(link.role, `${label}.role`, roles);
}

function assertSafeEventPayload(payload, label) {
  assertPlainObject(payload, label);
  const fields = {
    "visible-message": ["kind", "role"],
    "capability-invocation": [
      "kind", "capabilityKey", "correlationDigest", "inputFingerprint",
    ],
    "capability-result": [
      "kind", "correlationDigest", "providerState", "exitCode", "outputBytes", "durationMs",
    ],
    "skill-catalog-entry": ["kind", "capabilityKey", "pathFingerprint"],
    "skill-load": ["kind", "capabilityKey", "strength", "evidenceSource"],
    "turn-lifecycle": ["kind", "lifecycleState", "providerTurnDigest"],
    "provider-status": ["kind", "statusKind", "providerState", "rolledBackTurnCount"],
  };
  if (!Object.hasOwn(fields, payload.kind)) throw invalidFrame(`${label}.kind is invalid`);
  assertExactKeys(payload, label, fields[payload.kind]);
  if (payload.capabilityKey !== undefined) assertHex64(payload.capabilityKey, `${label}.capabilityKey`);
  for (const field of ["correlationDigest", "inputFingerprint", "pathFingerprint", "providerTurnDigest"]) {
    if (payload[field] !== undefined) assertNullableHex64(payload[field], `${label}.${field}`);
  }
  for (const field of ["role", "providerState", "strength", "evidenceSource", "lifecycleState",
    "statusKind"]) {
    if (payload[field] !== undefined) {
      assertBoundedString(payload[field], `${label}.${field}`, 128, { allowEmpty: false, ascii: true });
    }
  }
  for (const field of ["exitCode", "outputBytes", "durationMs", "rolledBackTurnCount"]) {
    if (payload[field] !== undefined && payload[field] !== null) {
      assertDecimal(payload[field], `${label}.${field}`);
    }
  }
}

function assertSafeEvent(event, label) {
  assertExactKeys(event, label, [
    "eventKey", "occurredTurnKey", "linkedTurns", "pointerKind", "pointerContentIndex",
    "pointerEventOrdinal", "originScope", "observedTimestamp", "payload",
  ]);
  assertHex64(event.eventKey, `${label}.eventKey`);
  assertNullableHex64(event.occurredTurnKey, `${label}.occurredTurnKey`);
  if (!Array.isArray(event.linkedTurns) || event.linkedTurns.length > 512) {
    throw invalidFrame(`${label}.linkedTurns exceeds its bounded limit`);
  }
  for (let index = 0; index < event.linkedTurns.length; index += 1) {
    const link = event.linkedTurns[index];
    assertExactKeys(link, `${label}.linkedTurns[${index}]`, ["turnKey", "role"]);
    assertHex64(link.turnKey, `${label}.linkedTurns[${index}].turnKey`);
    assertBoundedString(link.role, `${label}.linkedTurns[${index}].role`, 64, {
      allowEmpty: false,
      ascii: true,
    });
  }
  assertBoundedString(event.pointerKind, `${label}.pointerKind`, 128, {
    allowEmpty: false,
    ascii: true,
  });
  assertSafeInteger(event.pointerContentIndex, `${label}.pointerContentIndex`, {
    min: -2_147_483_648,
    max: 2_147_483_647,
  });
  assertSafeInteger(event.pointerEventOrdinal, `${label}.pointerEventOrdinal`, {
    min: 0,
    max: 65_535,
  });
  assertEnum(event.originScope, `${label}.originScope`, new Set(["main", "subagent", "unknown"]));
  assertCanonicalTimestamp(event.observedTimestamp, `${label}.observedTimestamp`);
  assertSafeEventPayload(event.payload, `${label}.payload`);
}

function assertSafeCapabilityUse(use, label) {
  assertExactKeys(use, label, [
    "useKey", "capabilityKey", "provider", "capabilityKind", "canonicalName", "turnOrdinal",
    "exactObservedName", "originScope", "originFingerprint", "inputFingerprint",
    "providerTerminalState", "strength", "correlationDigest", "evidence",
  ]);
  assertHex64(use.useKey, `${label}.useKey`);
  assertHex64(use.capabilityKey, `${label}.capabilityKey`);
  assertBoundedString(use.provider, `${label}.provider`, 64, { allowEmpty: false, ascii: true });
  assertEnum(use.capabilityKind, `${label}.capabilityKind`, new Set(["skill", "tool"]));
  assertBoundedString(use.canonicalName, `${label}.canonicalName`, 512, { allowEmpty: false });
  assertDecimal(use.turnOrdinal, `${label}.turnOrdinal`);
  assertBoundedString(use.exactObservedName, `${label}.exactObservedName`, 512);
  assertEnum(use.originScope, `${label}.originScope`, new Set(["main", "subagent", "unknown"]));
  for (const field of ["originFingerprint", "inputFingerprint", "correlationDigest"]) {
    assertNullableHex64(use[field], `${label}.${field}`);
  }
  assertEnum(use.providerTerminalState, `${label}.providerTerminalState`, new Set([
    "cancelled", "completed", "failed", "pending", "unknown",
  ]));
  assertEnum(use.strength, `${label}.strength`, new Set(["confirmed", "inferred", "observed"]));
  if (!Array.isArray(use.evidence) || use.evidence.length > 512) {
    throw invalidFrame(`${label}.evidence exceeds its bounded limit`);
  }
  for (let index = 0; index < use.evidence.length; index += 1) {
    assertEvidenceLink(use.evidence[index], `${label}.evidence[${index}]`, new Set([
      "corroboration", "invocation", "result",
    ]));
  }
}

function assertEvidenceEntry(entry, label) {
  assertExactKeys(entry, label, ["factKind", "fact"]);
  if (entry.factKind === "event") {
    assertSafeEvent(entry.fact, `${label}.fact`);
  } else if (entry.factKind === "capability-use") {
    assertSafeCapabilityUse(entry.fact, `${label}.fact`);
  } else {
    throw invalidFrame(`${label}.factKind is invalid`);
  }
}

function assertTurnEvidencePage(message) {
  assertEnvelope(message, "TURN_EVIDENCE_PAGE", [
    "snapshotSeq", "turn", "entries", "nextCursor",
  ]);
  assertDecimal(message.snapshotSeq, "TURN_EVIDENCE_PAGE.snapshotSeq");
  assertEvidenceTurn(message.turn, "TURN_EVIDENCE_PAGE.turn");
  if (!Array.isArray(message.entries) || message.entries.length > MAX_EVIDENCE_PAGE_ENTRIES) {
    throw invalidFrame("TURN_EVIDENCE_PAGE.entries exceeds its bounded limit");
  }
  for (let index = 0; index < message.entries.length; index += 1) {
    assertEvidenceEntry(message.entries[index], `TURN_EVIDENCE_PAGE.entries[${index}]`);
  }
  assertOpaqueCursor(message.nextCursor, "TURN_EVIDENCE_PAGE.nextCursor");
  assertMessagePayloadBound(message, "TURN_EVIDENCE_PAGE");
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
  else if (message.type === "READ_INSIGHTS_OVERVIEW") assertReadInsightsOverview(message);
  else if (message.type === "INSIGHTS_OVERVIEW") assertInsightsOverview(message);
  else if (message.type === "LIST_CAPABILITIES") assertListCapabilities(message);
  else if (message.type === "CAPABILITY_PAGE") assertCapabilityPage(message);
  else if (message.type === "SEARCH_TURNS") assertSearchTurns(message);
  else if (message.type === "TURN_SEARCH_RESULTS") assertTurnSearchResults(message);
  else if (message.type === "READ_TURN_EVIDENCE") assertReadTurnEvidence(message);
  else if (message.type === "TURN_EVIDENCE_PAGE") assertTurnEvidencePage(message);
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

export function createReadInsightsOverviewMessage({
  requestId,
  nowUnixMs,
  quiescenceSeconds = 300,
}) {
  return assertProtocolMessage(envelope("READ_INSIGHTS_OVERVIEW", requestId, {
    nowUnixMs,
    quiescenceSeconds,
  }));
}

export function createInsightsOverviewMessage({ requestId, overview }) {
  assertPlainObject(overview, "overview");
  return assertProtocolMessage(envelope("INSIGHTS_OVERVIEW", requestId, { ...overview }));
}

export function createListCapabilitiesMessage({
  requestId,
  kind,
  cursor = null,
  limit = 100,
}) {
  return assertProtocolMessage(envelope("LIST_CAPABILITIES", requestId, {
    kind,
    cursor,
    limit,
  }));
}

export function createCapabilityPageMessage({ requestId, page }) {
  assertPlainObject(page, "page");
  return assertProtocolMessage(envelope("CAPABILITY_PAGE", requestId, { ...page }));
}

function canonicalSearchFilters(filters) {
  assertPlainObject(filters, "filters");
  assertExactKeys(filters, "filters", [
    "providers",
    "projectKeys",
    "observedAtOrAfterUnixMs",
    "observedBeforeUnixMs",
    "toolCapabilityKeys",
    "skillCapabilityKeys",
    "resultEvidence",
    "closureStates",
  ]);
  const result = {
    providers: canonicalBoundedArray(filters.providers, "filters.providers", MAX_FILTER_PROVIDERS,
      (value, label) => assertBoundedString(value, label, 64, {
        allowEmpty: false,
        ascii: true,
      })),
    projectKeys: canonicalBoundedArray(
      filters.projectKeys,
      "filters.projectKeys",
      MAX_FILTER_KEYS,
      assertHex64,
    ),
    observedAtOrAfterUnixMs: filters.observedAtOrAfterUnixMs,
    observedBeforeUnixMs: filters.observedBeforeUnixMs,
    toolCapabilityKeys: canonicalBoundedArray(
      filters.toolCapabilityKeys,
      "filters.toolCapabilityKeys",
      MAX_FILTER_KEYS,
      assertHex64,
    ),
    skillCapabilityKeys: canonicalBoundedArray(
      filters.skillCapabilityKeys,
      "filters.skillCapabilityKeys",
      MAX_FILTER_KEYS,
      assertHex64,
    ),
    resultEvidence: canonicalBoundedArray(
      filters.resultEvidence,
      "filters.resultEvidence",
      3,
      (value, label) => assertEnum(value, label, SEARCH_RESULT_EVIDENCE),
    ),
    closureStates: canonicalBoundedArray(
      filters.closureStates,
      "filters.closureStates",
      3,
      (value, label) => assertEnum(value, label, SEARCH_CLOSURE_STATES),
    ),
  };
  assertSearchFilters(result, "filters");
  return result;
}

export function createSearchTurnsMessage({
  requestId,
  query,
  filters,
  limit = 50,
  pathLimit = 10,
  nowUnixMs,
  quiescenceSeconds = 300,
}) {
  const message = assertProtocolMessage(envelope("SEARCH_TURNS", requestId, {
    query,
    filters: canonicalSearchFilters(filters),
    limit,
    pathLimit,
    nowUnixMs,
    quiescenceSeconds,
  }));
  assertSearchRequestDomain(message);
  return message;
}

export function createTurnSearchResultsMessage({
  requestId,
  snapshot,
  scoringTerms,
  results,
  evidencePaths,
  diagnostic,
  searchTrace,
}) {
  return assertProtocolMessage(envelope("TURN_SEARCH_RESULTS", requestId, {
    snapshot,
    scoringTerms,
    results,
    evidencePaths,
    diagnostic,
    searchTrace,
  }));
}

export function createReadTurnEvidenceMessage({
  requestId,
  turnKey,
  expectedRevision = null,
  cursor = null,
  limit = 64,
}) {
  return assertProtocolMessage(envelope("READ_TURN_EVIDENCE", requestId, {
    turnKey,
    expectedRevision,
    cursor,
    limit,
  }));
}

export function createTurnEvidencePageMessage({
  requestId,
  snapshotSeq,
  turn,
  entries,
  nextCursor = null,
}) {
  return assertProtocolMessage(envelope("TURN_EVIDENCE_PAGE", requestId, {
    snapshotSeq,
    turn,
    entries,
    nextCursor,
  }));
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
