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
const INSIGHTS_PROVIDER_ADAPTER_VERSIONS = Object.freeze({
  1: Object.freeze(["claude@1", "codex@1"]),
  2: Object.freeze(["claude@3", "codex@3"]),
});

export function createInsightsRequiredContract(originSecretEpoch, options = {}) {
  const factSchemaVersion = options.factSchemaVersion ?? 2;
  if (factSchemaVersion !== 1 && factSchemaVersion !== 2) {
    throw new RangeError("factSchemaVersion must be 1 or 2");
  }
  return Object.freeze({
    factSchemaVersion,
    providerAdapterVersions: INSIGHTS_PROVIDER_ADAPTER_VERSIONS[factSchemaVersion],
    privacyPolicyVersion: factSchemaVersion,
    originSecretEpoch,
    duplicatePolicyVersion: 1,
    factStorageProfile: `normalized-row-v${factSchemaVersion}`,
    storageSchemaVersion: factSchemaVersion,
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
export const V2_UPSERT_COLLECTION_ORDER = Object.freeze([
  ...UPSERT_COLLECTION_ORDER,
  "historyEvents",
  "historyPayloads",
  "historyPayloadChunks",
]);
export const TRACE_SOURCE_COLLECTION_ORDER = Object.freeze([
  "refs", "commits", "files", "intentNodes", "intentRefs",
]);
const ALL_UPSERT_COLLECTIONS = Object.freeze([...new Set(V2_UPSERT_COLLECTION_ORDER)]);

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
  "BEGIN_TRACE_SOURCE",
  "TRACE_SOURCE_ACCEPTED",
  "TRACE_SOURCE_BATCH",
  "TRACE_SOURCE_BATCH_ACCEPTED",
  "COMMIT_TRACE_SOURCE",
  "TRACE_SOURCE_COMMITTED",
  "READ_REPOSITORY_STATE",
  "REPOSITORY_STATE",
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
  "READ_CAPABILITY_USAGE",
  "CAPABILITY_USAGE",
  "READ_INSIGHTS_ACTIVITY",
  "INSIGHTS_ACTIVITY",
  "READ_TURN_EVIDENCE",
  "TURN_EVIDENCE_PAGE",
  "READ_INSIGHTS_QUERY_V2",
  "INSIGHTS_QUERY_V2",
  "READ_INSIGHTS_EVIDENCE_V2",
  "INSIGHTS_EVIDENCE_V2",
  "READ_INSIGHTS_RECIPE",
  "INSIGHTS_RECIPE",
  "READ_INSIGHTS_DELIVERY_TRACE",
  "INSIGHTS_DELIVERY_TRACE",
  "MEMORY_COMMAND",
  "MEMORY_RESULT",
  "ABORT_SESSION",
  "SESSION_ABORTED",
  "ABORT_TRACE_SOURCE",
  "TRACE_SOURCE_ABORTED",
  "ERROR",
]);

/**
 * Stage 4a Team Memory op names (`MEMORY_COMMAND.op` / `MEMORY_RESULT.op`),
 * lowercase kebab-case, mirroring `MEMORY_OPS` in
 * `crates/insights-engine/src/memory_protocol.rs`.
 */
export const MEMORY_OPS = Object.freeze([
  "open",
  "bind-repository",
  "plan-tasks",
  "claim-task",
  "submit-extraction",
  "recall",
  "submit-adjudication",
  "sync-approved",
  "search",
  "review-queue",
  "status",
]);
const MEMORY_OP_SET = new Set(MEMORY_OPS);

const COMMON_FIELDS = ["format", "type", "requestId"];
const HEX_64 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const UUID = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/iu;
const ASCII_NAME = /^[\x21-\x7e]+$/u;
const CANONICAL_TIMESTAMP = /^[0-9]{4}-[0-9]{2}-[0-9]{2}T[0-9]{2}:[0-9]{2}:[0-9]{2}\.[0-9]{3}Z$/u;
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
const MAX_USAGE_ITEMS = 50;
const MAX_ACTIVITY_BUCKETS = 366;
const MAX_CURSOR_BYTES = 256;
const MAX_DEEP_QUERY_REQUEST_BYTES = 64 * 1_024;
const MAX_DEEP_CURSOR_BYTES = 4 * 1_024;
const MAX_DEEP_EVIDENCE_BYTES = 1_048_576;
const MAX_DEEP_QUERY_FIELDS = 64;
const TRACE_NODE_KINDS = new Set([
  "intent", "repository", "session", "turn", "capability-use", "file", "git-commit",
]);
const TRACE_DIRECTIONS = new Set(["incoming", "outgoing", "both"]);
const TRACE_STRENGTHS = new Set(["direct", "observed", "candidate", "contextual"]);
const TRACE_RELATIONS = new Set([
  "intent-declares-session", "intent-declares-commit", "session-contains-turn",
  "turn-contains-capability-use", "session-touched-file", "commit-changed-file",
  "session-observed-commit", "session-correlates-commit", "turn-observed-commit",
  "turn-correlates-commit", "intent-correlates-session", "contextual-same-file",
]);
const TRACE_DERIVED_RELATIONS = new Set([
  "session-correlates-commit", "turn-correlates-commit", "intent-correlates-session",
  "contextual-same-file",
]);
const TRACE_SOURCES = new Set([
  "intent-explicit-session-ref", "intent-explicit-commit-ref", "session-membership",
  "turn-membership", "normalized-file-event", "git-tree-diff", "observed-git-result",
  "ordered-exact-path-overlap", "unique-text-overlap", "same-file-history",
]);
const TRACE_LIMITATIONS = new Set([
  "not-authorship", "not-exclusive-line-attribution", "not-causality",
  "incomplete-timestamps", "unverified-intent-reference", "unreachable-commit",
  "path-only-context", "candidate-not-default",
]);
const TRACE_COVERAGE_STATES = new Set(["complete", "partial", "unavailable"]);
const TRACE_FACT_KINDS = new Set([
  "exact-path-overlap", "within-observed-commit-window", "full-commit-hash",
  "unique-abbreviated-commit-hash", "explicit-reference", "significant-term-overlap",
  "same-repository",
]);
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const MAX_DEEP_ORDER_FIELDS = 4;
const MAX_DEEP_PREDICATE_DEPTH = 8;
const MAX_DEEP_PREDICATE_LEAVES = 64;
const MAX_PPM = 1_000_000;
const SEARCH_RESULT_EVIDENCE = new Set(["abandoned", "provider-completed", "unknown"]);
const SEARCH_CLOSURE_STATES = new Set(["hard-sealed", "open", "quiescent"]);
const SEARCH_ORDER = new Set(["relevance", "observed-desc"]);
const CAPABILITY_TERMINAL_STATES = new Set([
  "pending", "completed", "failed", "cancelled", "unknown",
]);
const USAGE_ORDER = new Set([
  "recorded-invocation-count",
  "recorded-failing-invocation-count",
  "distinct-turn-count",
  "distinct-session-count",
  "distinct-dedupe-group-count",
  "last-used",
  "absolute-recorded-invocation-change",
]);
const ACTIVITY_BUCKETS = new Set(["day", "week"]);
const FTS_FIELDS = new Set(["capability", "code", "natural"]);
const DEEP_RESOURCES = new Set([
  "session", "turn", "event", "capability-use", "file-activity", "token-usage",
  "error-occurrence", "delivery-edge",
]);
const DEEP_PREDICATE_OPERATORS = new Set([
  "eq", "ne", "in", "not-in", "exists", "lt", "lte", "gt", "gte", "between",
  "prefix", "contains", "match",
]);
const DEEP_PAYLOAD_MODES = new Set(["omit", "reference", "inline"]);
const DEEP_COUNT_MODES = new Set(["none", "exact"]);
const DEEP_DIRECTIONS = new Set(["asc", "desc"]);
const DEEP_COMPLETENESS = new Set(["full", "summary", "unloaded", "truncated", "unavailable"]);

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
  assertBoundedString(value, label, 24, { allowEmpty: false, ascii: true });
  if (!CANONICAL_TIMESTAMP.test(value)) {
    throw invalidFrame(`${label} must be a canonical UTC timestamp`);
  }
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

function upsertCollectionsForDeltaFormat(deltaFormat) {
  if (deltaFormat === "session-facts-delta@v1") return UPSERT_COLLECTION_ORDER;
  if (deltaFormat === "session-facts-delta@v2") return V2_UPSERT_COLLECTION_ORDER;
  throw invalidFrame("BEGIN_SESSION.deltaFormat is unsupported");
}

function assertCounts(counts, upsertCollections) {
  const countFields = [...RETRACTION_COLLECTION_ORDER, ...upsertCollections];
  assertExactKeys(counts, "BEGIN_SESSION.counts", countFields);
  for (const field of countFields) assertDecimal(counts[field], `BEGIN_SESSION.counts.${field}`);
}

function assertHello(message) {
  assertEnvelope(message, "HELLO", ["clientVersion", "maxFrameBytes", "requiredContract"]);
  assertNonEmptyString(message.clientVersion, "HELLO.clientVersion");
  assertMaxFrameBytes(message.maxFrameBytes, "HELLO.maxFrameBytes");
  assertHandshakeContract(message.requiredContract, "HELLO.requiredContract");
}

function assertReady(message) {
  const v2 = message.acceptedContract?.factSchemaVersion === 2;
  const fields = [
    "engineVersion",
    "target",
    "maxFrameBytes",
    "sqliteVersion",
    "sqliteCompileOptionsDigest",
    "buildManifestDigest",
    "acceptedContract",
  ];
  if (v2) fields.push("databaseUuid", "databaseFactSchemaVersion");
  assertEnvelope(message, "READY", fields);
  assertNonEmptyString(message.engineVersion, "READY.engineVersion");
  assertNonEmptyString(message.target, "READY.target");
  assertMaxFrameBytes(message.maxFrameBytes, "READY.maxFrameBytes");
  assertNonEmptyString(message.sqliteVersion, "READY.sqliteVersion");
  assertHex64(message.sqliteCompileOptionsDigest, "READY.sqliteCompileOptionsDigest");
  assertHex64(message.buildManifestDigest, "READY.buildManifestDigest");
  assertHandshakeContract(message.acceptedContract, "READY.acceptedContract");
  if (v2) {
    assertUuid(message.databaseUuid, "READY.databaseUuid");
    if (message.databaseFactSchemaVersion !== null &&
        message.databaseFactSchemaVersion !== 1 && message.databaseFactSchemaVersion !== 2) {
      throw invalidFrame("READY.databaseFactSchemaVersion must be null, 1, or 2");
    }
  }
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
  const upsertCollections = upsertCollectionsForDeltaFormat(message.deltaFormat);
  assertPlainObject(message.session, "BEGIN_SESSION.session");
  assertHex64(message.session.sessionKey, "BEGIN_SESSION.session.sessionKey");
  assertHex64(message.deltaId, "BEGIN_SESSION.deltaId");
  if (message.mode !== "append" && message.mode !== "replace-session") {
    throw invalidFrame("BEGIN_SESSION.mode is invalid");
  }
  assertDecimal(message.expectedGeneration, "BEGIN_SESSION.expectedGeneration");
  assertDecimal(message.targetGeneration, "BEGIN_SESSION.targetGeneration");
  assertSessionContract(message.contract, "BEGIN_SESSION.contract");
  assertCounts(message.counts, upsertCollections);
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

function assertBeginTraceSource(message) {
  assertEnvelope(message, "BEGIN_TRACE_SOURCE", [
    "deltaFormat", "deltaId", "expectedGeneration", "targetGeneration", "repository", "intent",
    "counts",
  ]);
  if (message.deltaFormat !== "threadshare-insights-trace-source-delta@v1") {
    throw invalidFrame("BEGIN_TRACE_SOURCE.deltaFormat is unsupported");
  }
  assertHex64(message.deltaId, "BEGIN_TRACE_SOURCE.deltaId");
  assertDecimal(message.expectedGeneration, "BEGIN_TRACE_SOURCE.expectedGeneration");
  assertDecimal(message.targetGeneration, "BEGIN_TRACE_SOURCE.targetGeneration");
  assertExactKeys(message.repository, "BEGIN_TRACE_SOURCE.repository", [
    "repositoryId", "repositoryKey", "available", "refDigest", "scmProvider", "webBaseUrl",
    "repositoryPath",
    "projectKeys",
  ]);
  assertUuid(message.repository.repositoryId, "BEGIN_TRACE_SOURCE.repository.repositoryId");
  assertHex64(message.repository.repositoryKey, "BEGIN_TRACE_SOURCE.repository.repositoryKey");
  assertHex64(message.repository.refDigest, "BEGIN_TRACE_SOURCE.repository.refDigest");
  if (typeof message.repository.available !== "boolean") {
    throw invalidFrame("BEGIN_TRACE_SOURCE.repository.available must be boolean");
  }
  const scm = [
    message.repository.scmProvider,
    message.repository.webBaseUrl,
    message.repository.repositoryPath,
  ];
  const projectKeys = assertArray(message.repository.projectKeys, "BEGIN_TRACE_SOURCE.repository.projectKeys");
  if (projectKeys.length !== 2) throw invalidFrame("BEGIN_TRACE_SOURCE.repository.projectKeys must contain two keys");
  for (const key of projectKeys) assertHex64(key, "BEGIN_TRACE_SOURCE.repository.projectKeys[]");
  if (!(scm.every((value) => value === null) || scm.every((value) =>
    typeof value === "string" && value.length > 0 && Buffer.byteLength(value, "utf8") <= 12 * 1024))) {
    throw invalidFrame("BEGIN_TRACE_SOURCE.repository SCM metadata is invalid");
  }
  if (message.intent !== null) {
    assertExactKeys(message.intent, "BEGIN_TRACE_SOURCE.intent", [
      "sourceKey", "adapterVersion", "revision", "locator", "coverage", "diagnostics",
    ]);
    assertHex64(message.intent.sourceKey, "BEGIN_TRACE_SOURCE.intent.sourceKey");
    assertNonEmptyString(message.intent.adapterVersion, "BEGIN_TRACE_SOURCE.intent.adapterVersion");
    assertHex64(message.intent.revision, "BEGIN_TRACE_SOURCE.intent.revision");
    assertNonEmptyString(message.intent.locator, "BEGIN_TRACE_SOURCE.intent.locator");
    assertEnum(message.intent.coverage, "BEGIN_TRACE_SOURCE.intent.coverage", TRACE_COVERAGE_STATES);
    const diagnostics = assertArray(message.intent.diagnostics, "BEGIN_TRACE_SOURCE.intent.diagnostics");
    if (diagnostics.length > 4096) throw invalidFrame("BEGIN_TRACE_SOURCE intent diagnostics exceed 4096");
    for (const diagnostic of diagnostics) {
      assertExactKeys(diagnostic, "BEGIN_TRACE_SOURCE.intent.diagnostics[]", ["line", "code"]);
      assertDecimal(diagnostic.line, "BEGIN_TRACE_SOURCE.intent.diagnostics[].line");
      assertNonEmptyString(diagnostic.code, "BEGIN_TRACE_SOURCE.intent.diagnostics[].code");
    }
  }
  assertExactKeys(message.counts, "BEGIN_TRACE_SOURCE.counts", TRACE_SOURCE_COLLECTION_ORDER);
  for (const collection of TRACE_SOURCE_COLLECTION_ORDER) {
    assertDecimal(message.counts[collection], `BEGIN_TRACE_SOURCE.counts.${collection}`);
  }
}

function assertTraceSourceIdentity(message, type, sequenceField) {
  assertEnvelope(message, type, ["repositoryKey", "deltaId", sequenceField]);
  assertHex64(message.repositoryKey, `${type}.repositoryKey`);
  assertHex64(message.deltaId, `${type}.deltaId`);
  assertDecimal(message[sequenceField], `${type}.${sequenceField}`);
}

function assertTraceSourceBatch(message) {
  assertBatch(message, "TRACE_SOURCE_BATCH", TRACE_SOURCE_COLLECTION_ORDER);
}

function assertTraceSourceBatchAccepted(message) {
  assertEnvelope(message, "TRACE_SOURCE_BATCH_ACCEPTED", ["sequence"]);
  assertDecimal(message.sequence, "TRACE_SOURCE_BATCH_ACCEPTED.sequence");
}

function assertTraceSourceTerminalRequest(message, type) {
  assertEnvelope(message, type, ["nextSequence"]);
  assertDecimal(message.nextSequence, `${type}.nextSequence`);
}

function assertTraceSourceCommitted(message) {
  assertEnvelope(message, "TRACE_SOURCE_COMMITTED", [
    "repositoryKey", "deltaId", "snapshotSeq", "idempotent",
  ]);
  assertHex64(message.repositoryKey, "TRACE_SOURCE_COMMITTED.repositoryKey");
  assertHex64(message.deltaId, "TRACE_SOURCE_COMMITTED.deltaId");
  assertDecimal(message.snapshotSeq, "TRACE_SOURCE_COMMITTED.snapshotSeq");
  if (typeof message.idempotent !== "boolean") {
    throw invalidFrame("TRACE_SOURCE_COMMITTED.idempotent must be boolean");
  }
}

function assertReadRepositoryState(message) {
  assertEnvelope(message, "READ_REPOSITORY_STATE", ["repositoryId", "cursor", "limit"]);
  assertUuid(message.repositoryId, "READ_REPOSITORY_STATE.repositoryId");
  if (message.cursor !== null) {
    assertNonEmptyString(message.cursor, "READ_REPOSITORY_STATE.cursor");
    if (Buffer.byteLength(message.cursor, "utf8") > 4_096) {
      throw invalidFrame("READ_REPOSITORY_STATE.cursor exceeds 4096 bytes");
    }
  }
  if (!Number.isSafeInteger(message.limit) || message.limit < 1 || message.limit > 256) {
    throw invalidFrame("READ_REPOSITORY_STATE.limit must be between 1 and 256");
  }
}

function assertRepositoryState(message) {
  assertEnvelope(message, "REPOSITORY_STATE", [
    "repositoryId", "generation", "available", "refDigest", "intentRevision", "coverageAfter",
    "refs", "nextCursor",
  ]);
  assertUuid(message.repositoryId, "REPOSITORY_STATE.repositoryId");
  assertDecimal(message.generation, "REPOSITORY_STATE.generation");
  if (message.available !== null && typeof message.available !== "boolean") {
    throw invalidFrame("REPOSITORY_STATE.available must be a boolean or null");
  }
  if (message.refDigest !== null) assertHex64(message.refDigest, "REPOSITORY_STATE.refDigest");
  if (message.intentRevision !== null) {
    assertHex64(message.intentRevision, "REPOSITORY_STATE.intentRevision");
  }
  if (message.coverageAfter !== null) {
    assertCanonicalTimestamp(message.coverageAfter, "REPOSITORY_STATE.coverageAfter");
  }
  if (!Array.isArray(message.refs) || message.refs.length > 256) {
    throw invalidFrame("REPOSITORY_STATE.refs must contain at most 256 items");
  }
  let previous = null;
  for (const reference of message.refs) {
    assertExactKeys(reference, "REPOSITORY_STATE.refs[]", ["name", "objectId"]);
    assertNonEmptyString(reference.name, "REPOSITORY_STATE.refs[].name");
    if (!reference.name.startsWith("refs/") ||
        (previous !== null && reference.name.localeCompare(previous) <= 0)) {
      throw invalidFrame("REPOSITORY_STATE.refs is not strictly sorted");
    }
    if (!/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(reference.objectId)) {
      throw invalidFrame("REPOSITORY_STATE.refs[].objectId is invalid");
    }
    previous = reference.name;
  }
  if (message.nextCursor !== null) {
    assertNonEmptyString(message.nextCursor, "REPOSITORY_STATE.nextCursor");
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
  if (!new Set(["normalized-row-v1", "normalized-row-v2", "packed-facts-v1"]).has(
    message.factStorageProfile,
  )) {
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
  const fields = [
    "snapshotSeq", "sessions", "scopes", "dedupe", "turns", "capabilities",
    "providers", "projects", "coverage", "diagnostics",
  ];
  if (Object.hasOwn(message, "databaseUuid")) fields.push("databaseUuid");
  assertEnvelope(message, "INSIGHTS_OVERVIEW", fields);
  if (Object.hasOwn(message, "databaseUuid")) {
    assertUuid(message.databaseUuid, "INSIGHTS_OVERVIEW.databaseUuid");
  }
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
  assertEnvelope(message, "CAPABILITY_PAGE", [
    "databaseUuid", "snapshotSeq", "items", "nextCursor", "coverage",
  ]);
  assertUuid(message.databaseUuid, "CAPABILITY_PAGE.databaseUuid");
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
  assertDecimalObject(message.coverage, "CAPABILITY_PAGE.coverage", [
    "excludedUndatedInvocationCount",
    "excludedUndatedTurnCount",
    "excludedUnrevisionedInvocationCount",
    "excludedUnrevisionedTurnCount",
    "fullyExcludedCapabilityCount",
  ]);
  assertMessagePayloadBound(message, "CAPABILITY_PAGE");
}

function assertSearchFilters(filters, label) {
  const fields = [
    "providers",
    "projectKeys",
    "observedAtOrAfterUnixMs",
    "observedBeforeUnixMs",
    "toolCapabilityKeys",
    "skillCapabilityKeys",
    "resultEvidence",
    "closureStates",
  ];
  const hasCapabilityTerminalStates = Object.hasOwn(filters, "capabilityTerminalStates");
  if (hasCapabilityTerminalStates) fields.push("capabilityTerminalStates");
  assertExactKeys(filters, label, fields);
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
  if (hasCapabilityTerminalStates) {
    assertBoundedSortedArray(
      filters.capabilityTerminalStates,
      `${label}.capabilityTerminalStates`,
      5,
      (value, itemLabel) => assertEnum(value, itemLabel, CAPABILITY_TERMINAL_STATES),
    );
    if (filters.capabilityTerminalStates.length > 0 &&
        filters.toolCapabilityKeys.length === 0 && filters.skillCapabilityKeys.length === 0) {
      throw invalidFrame(`${label}.capabilityTerminalStates requires a capability key filter`);
    }
  }
}

function hasStructuredSearchFilter(filters) {
  return filters.providers.length > 0 || filters.projectKeys.length > 0 ||
    filters.observedAtOrAfterUnixMs !== null || filters.observedBeforeUnixMs !== null ||
    filters.toolCapabilityKeys.length > 0 || filters.skillCapabilityKeys.length > 0 ||
    filters.resultEvidence.length > 0 || filters.closureStates.length > 0 ||
    (filters.capabilityTerminalStates?.length ?? 0) > 0;
}

function assertSearchTurns(message) {
  const fields = [
    "query", "filters", "limit", "pathLimit", "nowUnixMs", "quiescenceSeconds",
  ];
  const hasOrderBy = Object.hasOwn(message, "orderBy");
  if (hasOrderBy) fields.push("orderBy");
  assertEnvelope(message, "SEARCH_TURNS", fields);
  assertBoundedString(message.query, "SEARCH_TURNS.query", MAX_PROTOCOL_PAYLOAD_BYTES);
  assertSearchFilters(message.filters, "SEARCH_TURNS.filters");
  assertSafeInteger(message.limit, "SEARCH_TURNS.limit", { min: 1, max: MAX_SEARCH_RESULTS });
  assertSafeInteger(message.pathLimit, "SEARCH_TURNS.pathLimit", { min: 0, max: MAX_PATH_FAMILIES });
  assertDecimal(message.nowUnixMs, "SEARCH_TURNS.nowUnixMs");
  assertSafeInteger(message.quiescenceSeconds, "SEARCH_TURNS.quiescenceSeconds", {
    min: 60,
    max: 86_400,
  });
  if (hasOrderBy) assertEnum(message.orderBy, "SEARCH_TURNS.orderBy", SEARCH_ORDER);
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
  const fields = [
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
  ];
  const hasDedupe = Object.hasOwn(result, "dedupe");
  if (hasDedupe) fields.push("dedupe");
  assertExactKeys(result, label, fields);
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
  if (hasDedupe) {
    assertExactKeys(result.dedupe, `${label}.dedupe`, [
      "duplicateGroupKey", "confidence", "observedEofProvisional",
    ]);
    assertHex64(result.dedupe.duplicateGroupKey, `${label}.dedupe.duplicateGroupKey`);
    assertEnum(
      result.dedupe.confidence,
      `${label}.dedupe.confidence`,
      new Set(["strong", "weak"]),
    );
    assertBoolean(result.dedupe.observedEofProvisional, `${label}.dedupe.observedEofProvisional`);
  }
}

function assertToolStateCounts(counts, label) {
  assertExactKeys(counts, label, ["pending", "completed", "failed", "cancelled", "unknown"]);
  for (const field of ["pending", "completed", "failed", "cancelled", "unknown"]) {
    assertSafeInteger(counts[field], `${label}.${field}`, { min: 0, max: MAX_PATH_TOOL_EVENTS });
  }
}

const PATH_DELIVERY_OUTCOME_FIELDS = [
  "directCommitTurnCount",
  "observedCommitTurnCount",
  "noDeliveryTurnCount",
  "uncoveredTurnCount",
];

/** Counts must exhaust the family's Turns, so an unattributed Turn cannot pass as unclassified. */
function assertPathDeliveryOutcome(outcome, label, turnCount) {
  assertExactKeys(outcome, label, PATH_DELIVERY_OUTCOME_FIELDS);
  let total = 0;
  for (const field of PATH_DELIVERY_OUTCOME_FIELDS) {
    assertSafeInteger(outcome[field], `${label}.${field}`, { min: 0, max: MAX_SEARCH_RESULTS });
    total += outcome[field];
  }
  if (total !== turnCount) {
    throw invalidFrame(`${label} counts do not partition the family turn count`);
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
    "deliveryOutcome",
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
  assertPathDeliveryOutcome(
    family.deliveryOutcome,
    `${label}.deliveryOutcome`,
    family.turnCount,
  );
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

function assertMessagePayloadBound(message, label, validatedPayloadByteLength = null) {
  const payloadByteLength = validatedPayloadByteLength ??
    Buffer.byteLength(canonicalJson(message), "utf8");
  if (payloadByteLength > MAX_PROTOCOL_PAYLOAD_BYTES) {
    throw invalidFrame(`${label} exceeds the protocol payload limit`);
  }
}

function assertDeepCursor(value, label) {
  if (value !== null) {
    assertBoundedString(value, label, MAX_DEEP_CURSOR_BYTES, { allowEmpty: false, ascii: true });
  }
}

function assertDeepTarget(target, label) {
  assertPlainObject(target, label);
  const fields = {
    turn: ["kind", "turnKey", "revision"],
    session: ["kind", "sessionKey", "revision"],
    "attempt-chain": ["kind", "chainKey", "revision"],
  };
  if (target.kind === "event") {
    const expected = Object.hasOwn(target, "payloadKey")
      ? ["kind", "eventKey", "revision", "payloadKey"]
      : ["kind", "eventKey", "revision"];
    assertExactKeys(target, label, expected);
    assertHex64(target.eventKey, `${label}.eventKey`);
    assertHex64(target.revision, `${label}.revision`);
    if (target.payloadKey !== undefined) {
      assertHex64(target.payloadKey, `${label}.payloadKey`);
    }
    return;
  }
  if (target.kind === "delivery-node") {
    assertExactKeys(target, label, ["kind", "nodeKind", "nodeKey", "revision"]);
    assertEnum(target.nodeKind, `${label}.nodeKind`, TRACE_NODE_KINDS);
    assertHex64(target.nodeKey, `${label}.nodeKey`);
    assertHex64(target.revision, `${label}.revision`);
    return;
  }
  if (target.kind === "delivery-edge") {
    assertExactKeys(target, label, ["kind", "relation", "from", "to", "revision"]);
    assertEnum(target.relation, `${label}.relation`, TRACE_RELATIONS);
    assertTraceNodeRef(target.from, `${label}.from`);
    assertTraceNodeRef(target.to, `${label}.to`);
    assertHex64(target.revision, `${label}.revision`);
    return;
  }
  if (typeof target.kind !== "string" || fields[target.kind] === undefined) {
    throw invalidFrame(`${label}.kind is invalid`);
  }
  assertExactKeys(target, label, fields[target.kind]);
  for (const field of fields[target.kind].filter((field) => field !== "kind")) {
    assertHex64(target[field], `${label}.${field}`);
  }
}

function assertDeepPredicate(predicate, label, depth = 1, state = { leaves: 0 }) {
  if (depth > MAX_DEEP_PREDICATE_DEPTH) {
    throw invalidFrame(`${label} exceeds maximum depth ${MAX_DEEP_PREDICATE_DEPTH}`);
  }
  assertPlainObject(predicate, label);
  const keys = Object.keys(predicate);
  if (keys.length === 1 && (keys[0] === "and" || keys[0] === "or")) {
    const field = keys[0];
    const items = predicate[field];
    if (!Array.isArray(items) || items.length < 1 || items.length > 64) {
      throw invalidFrame(`${label}.${field} must contain 1..=64 predicates`);
    }
    for (let index = 0; index < items.length; index += 1) {
      assertDeepPredicate(items[index], `${label}.${field}[${index}]`, depth + 1, state);
    }
    return;
  }
  if (keys.length === 1 && keys[0] === "not") {
    assertDeepPredicate(predicate.not, `${label}.not`, depth + 1, state);
    return;
  }
  const expected = predicate.op === "exists" ? ["field", "op"] : ["field", "op", "value"];
  assertExactKeys(predicate, label, expected);
  assertBoundedString(predicate.field, `${label}.field`, 256, { allowEmpty: false });
  assertEnum(predicate.op, `${label}.op`, DEEP_PREDICATE_OPERATORS);
  state.leaves += 1;
  if (state.leaves > MAX_DEEP_PREDICATE_LEAVES) {
    throw invalidFrame(`${label} exceeds maximum ${MAX_DEEP_PREDICATE_LEAVES} leaves`);
  }
  if (predicate.op === "exists") return;
  if (["in", "not-in", "between"].includes(predicate.op)) {
    if (!Array.isArray(predicate.value) || predicate.value.length < 1 ||
        predicate.value.length > 64 ||
        (predicate.op === "between" && predicate.value.length !== 2)) {
      throw invalidFrame(`${label}.value must be a bounded array`);
    }
    for (let index = 0; index < predicate.value.length; index += 1) {
      assertBoundedString(predicate.value[index], `${label}.value[${index}]`, 8 * 1_024);
    }
    return;
  }
  assertBoundedString(predicate.value, `${label}.value`, 8 * 1_024);
}

function assertDeepQueryShape(shape, label) {
  assertPlainObject(shape, label);
  if (shape.kind === "records") {
    assertExactKeys(shape, label, ["kind", "select", "payloadMode"]);
    if (!Array.isArray(shape.select) || shape.select.length < 1 ||
        shape.select.length > MAX_DEEP_QUERY_FIELDS) {
      throw invalidFrame(`${label}.select must contain 1..=${MAX_DEEP_QUERY_FIELDS} fields`);
    }
    const seen = new Set();
    for (let index = 0; index < shape.select.length; index += 1) {
      assertBoundedString(shape.select[index], `${label}.select[${index}]`, 256, {
        allowEmpty: false,
      });
      if (seen.has(shape.select[index])) throw invalidFrame(`${label}.select contains duplicates`);
      seen.add(shape.select[index]);
    }
    assertEnum(shape.payloadMode, `${label}.payloadMode`, DEEP_PAYLOAD_MODES);
    return;
  }
  if (shape.kind === "aggregate") {
    assertExactKeys(shape, label, ["kind", "groupBy", "metrics"]);
    if (!Array.isArray(shape.groupBy) || shape.groupBy.length > 3 ||
        !Array.isArray(shape.metrics) || shape.metrics.length < 1 || shape.metrics.length > 8) {
      throw invalidFrame(`${label} aggregate bounds are invalid`);
    }
    for (let index = 0; index < shape.groupBy.length; index += 1) {
      assertBoundedString(shape.groupBy[index], `${label}.groupBy[${index}]`, 256, {
        allowEmpty: false,
      });
    }
    for (let index = 0; index < shape.metrics.length; index += 1) {
      assertPlainObject(shape.metrics[index], `${label}.metrics[${index}]`);
    }
    return;
  }
  throw invalidFrame(`${label}.kind is invalid`);
}

function assertDeepQueryRequest(request, label) {
  assertExactKeys(request, label, [
    "format", "resource", "where", "shape", "orderBy", "limit", "cursor", "count",
    "evaluatedAt",
  ]);
  if (request.format !== "threadshare-insights-query-request@v2") {
    throw invalidFrame(`${label}.format is invalid`);
  }
  assertEnum(request.resource, `${label}.resource`, DEEP_RESOURCES);
  if (request.where !== null) assertDeepPredicate(request.where, `${label}.where`);
  assertDeepQueryShape(request.shape, `${label}.shape`);
  if (!Array.isArray(request.orderBy) || request.orderBy.length < 1 ||
      request.orderBy.length > MAX_DEEP_ORDER_FIELDS) {
    throw invalidFrame(`${label}.orderBy must contain 1..=${MAX_DEEP_ORDER_FIELDS} fields`);
  }
  for (let index = 0; index < request.orderBy.length; index += 1) {
    const item = request.orderBy[index];
    assertExactKeys(item, `${label}.orderBy[${index}]`, ["field", "direction"]);
    assertBoundedString(item.field, `${label}.orderBy[${index}].field`, 256, {
      allowEmpty: false,
    });
    assertEnum(item.direction, `${label}.orderBy[${index}].direction`, DEEP_DIRECTIONS);
  }
  assertSafeInteger(request.limit, `${label}.limit`, { min: 1, max: 50 });
  assertDeepCursor(request.cursor, `${label}.cursor`);
  assertEnum(request.count, `${label}.count`, DEEP_COUNT_MODES);
  assertCanonicalTimestamp(request.evaluatedAt, `${label}.evaluatedAt`);
  if (Buffer.byteLength(canonicalJson(request), "utf8") > MAX_DEEP_QUERY_REQUEST_BYTES) {
    throw invalidFrame(`${label} exceeds 64 KiB`);
  }
}

function assertDeepEvidenceRequest(request, label) {
  assertExactKeys(request, label, ["format", "target", "include", "cursor", "maxBytes"]);
  if (request.format !== "threadshare-insights-evidence-request@v2") {
    throw invalidFrame(`${label}.format is invalid`);
  }
  assertDeepTarget(request.target, `${label}.target`);
  assertBoundedSortedArray(request.include, `${label}.include`, 2, (value, itemLabel) =>
    assertEnum(value, itemLabel, new Set(["envelope", "payload"])));
  if (request.include.length === 0) throw invalidFrame(`${label}.include must not be empty`);
  assertDeepCursor(request.cursor, `${label}.cursor`);
  assertSafeInteger(request.maxBytes, `${label}.maxBytes`, {
    min: 4,
    max: MAX_DEEP_EVIDENCE_BYTES,
  });
  if (Buffer.byteLength(canonicalJson(request), "utf8") > MAX_DEEP_QUERY_REQUEST_BYTES) {
    throw invalidFrame(`${label} exceeds 64 KiB`);
  }
}

function assertDeepJsonValue(value, label, depth = 0) {
  if (depth > 16) throw invalidFrame(`${label} exceeds maximum nesting depth`);
  if (value === null || typeof value === "boolean") return;
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw invalidFrame(`${label} must be finite`);
    return;
  }
  if (typeof value === "string") {
    assertBoundedString(value, label, MAX_PROTOCOL_PAYLOAD_BYTES);
    return;
  }
  if (Array.isArray(value)) {
    if (value.length > 4096) throw invalidFrame(`${label} has too many items`);
    for (let index = 0; index < value.length; index += 1) {
      assertDeepJsonValue(value[index], `${label}[${index}]`, depth + 1);
    }
    return;
  }
  assertPlainObject(value, label);
  const contentFields = [
    "byteLength", "sha256", "encoding", "inline", "reference", "complete",
  ];
  if (contentFields.some((field) => Object.hasOwn(value, field))) {
    assertExactKeys(value, label, contentFields);
    assertDecimal(value.byteLength, `${label}.byteLength`);
    assertHex64(value.sha256, `${label}.sha256`);
    assertEnum(value.encoding, `${label}.encoding`, new Set(["utf-8", "canonical-json"]));
    const inline = value.inline !== null;
    const reference = value.reference !== null;
    if (inline === reference) throw invalidFrame(`${label} must contain inline xor reference`);
    if (inline) {
      assertBoundedString(value.inline, `${label}.inline`, MAX_PROTOCOL_PAYLOAD_BYTES);
      if (BigInt(Buffer.byteLength(value.inline, "utf8")) > BigInt(value.byteLength)) {
        throw invalidFrame(`${label}.inline exceeds byteLength`);
      }
    } else {
      assertDeepTarget(value.reference, `${label}.reference`);
    }
    assertBoolean(value.complete, `${label}.complete`);
    return;
  }
  for (const [key, item] of Object.entries(value)) {
    assertBoundedString(key, `${label} key`, 256, { allowEmpty: false });
    assertDeepJsonValue(item, `${label}.${key}`, depth + 1);
  }
}

function assertDeepCoverage(value, label) {
  assertExactKeys(value, label, ["matching", "indexedHistory", "degraded", "diagnostics"]);
  const matchingFields = [
    "fullRecordCount", "summaryRecordCount", "unloadedRecordCount",
    "truncatedRecordCount", "unavailableRecordCount", "missingTimestampCount",
    "missingRevisionCount", "missingTokenMetricCount", "missingPayloadCount",
  ];
  assertExactKeys(value.matching, `${label}.matching`, matchingFields);
  for (const field of matchingFields) {
    assertDecimal(value.matching[field], `${label}.matching.${field}`);
  }
  const visible = matchingFields.slice(0, 5)
    .reduce((sum, field) => sum + BigInt(value.matching[field]), 0n);
  for (const field of ["missingTimestampCount", "missingRevisionCount", "missingPayloadCount"]) {
    if (BigInt(value.matching[field]) > visible) {
      throw invalidFrame(`${label}.matching.${field} is inconsistent`);
    }
  }
  if (BigInt(value.matching.missingTokenMetricCount) > visible * 6n) {
    throw invalidFrame(`${label}.matching.missingTokenMetricCount is inconsistent`);
  }
  const historyCountFields = [
    "visibleSessionCount", "excludedSessionCount", "subagentExcludedSessionCount",
    "unknownEligibilitySessionCount", "pendingPurgeSessionCount", "purgedSessionCount",
    "missingCoverageRollupSessionCount",
  ];
  assertExactKeys(value.indexedHistory, `${label}.indexedHistory`, [...historyCountFields, "fts"]);
  for (const field of historyCountFields) {
    assertDecimal(value.indexedHistory[field], `${label}.indexedHistory.${field}`);
  }
  const ftsFields = [
    "searchableEventCount", "storedNotSearchableEventCount",
    "searchablePayloadBytes", "storedNotSearchablePayloadBytes",
  ];
  assertExactKeys(value.indexedHistory.fts, `${label}.indexedHistory.fts`, ftsFields);
  for (const field of ftsFields) {
    assertDecimal(value.indexedHistory.fts[field], `${label}.indexedHistory.fts.${field}`);
  }
  if (BigInt(value.indexedHistory.missingCoverageRollupSessionCount) >
      BigInt(value.indexedHistory.visibleSessionCount)) {
    throw invalidFrame(`${label}.indexedHistory coverage rollup count is inconsistent`);
  }
  assertBoolean(value.degraded, `${label}.degraded`);
  const expectedDegraded = matchingFields.slice(1, 5)
    .some((field) => BigInt(value.matching[field]) > 0n) ||
    historyCountFields.slice(1).some((field) => BigInt(value.indexedHistory[field]) > 0n);
  if (value.degraded !== expectedDegraded) throw invalidFrame(`${label}.degraded is inconsistent`);
  assertBoundedSortedArray(value.diagnostics, `${label}.diagnostics`, 32,
    (item, itemLabel) => assertBoundedString(item, itemLabel, 128, {
      allowEmpty: false,
      ascii: true,
    }));
  if (value.degraded !== (value.diagnostics.length > 0)) {
    throw invalidFrame(`${label}.diagnostics is inconsistent with degraded`);
  }
  return visible;
}

function assertDeepQueryResponse(response, label) {
  assertExactKeys(response, label, [
    "format", "databaseUuid", "snapshotSeq", "resource", "records", "groups",
    "nextCursor", "totalMatchCount", "totalGroupCount", "truncated", "coverage",
    "provenance", "limits",
  ]);
  if (response.format !== "threadshare-insights-query@v2") {
    throw invalidFrame(`${label}.format is invalid`);
  }
  assertUuid(response.databaseUuid, `${label}.databaseUuid`);
  assertDecimal(response.snapshotSeq, `${label}.snapshotSeq`);
  assertEnum(response.resource, `${label}.resource`, DEEP_RESOURCES);
  const records = response.records !== null;
  const groups = response.groups !== null;
  if (records === groups) throw invalidFrame(`${label} must contain records xor groups`);
  const page = records ? response.records : response.groups;
  if (!Array.isArray(page) || page.length > 50) throw invalidFrame(`${label} page is invalid`);
  for (let index = 0; index < page.length; index += 1) {
    assertDeepJsonValue(page[index], `${label}.${records ? "records" : "groups"}[${index}]`);
  }
  assertDeepCursor(response.nextCursor, `${label}.nextCursor`);
  if (response.totalMatchCount !== null) {
    assertDecimal(response.totalMatchCount, `${label}.totalMatchCount`);
    if (BigInt(response.totalMatchCount) < BigInt(page.length)) {
      throw invalidFrame(`${label}.totalMatchCount is inconsistent`);
    }
  }
  if (records) {
    if (response.totalGroupCount !== null) {
      throw invalidFrame(`${label}.totalGroupCount must be null for records`);
    }
  } else {
    assertDecimal(response.totalGroupCount, `${label}.totalGroupCount`);
    if (BigInt(response.totalGroupCount) < BigInt(page.length)) {
      throw invalidFrame(`${label}.totalGroupCount is inconsistent`);
    }
  }
  assertBoolean(response.truncated, `${label}.truncated`);
  if (response.truncated !== (response.nextCursor !== null)) {
    throw invalidFrame(`${label}.truncated is inconsistent`);
  }
  const coverageTotal = assertDeepCoverage(response.coverage, `${label}.coverage`);
  if (response.totalMatchCount !== null && BigInt(response.totalMatchCount) !== coverageTotal) {
    throw invalidFrame(`${label}.totalMatchCount does not match coverage`);
  }
  assertExactKeys(response.provenance, `${label}.provenance`, ["default", "fields"]);
  assertEnum(response.provenance.default, `${label}.provenance.default`,
    new Set(["recorded", "derived", "estimated"]));
  if (!Array.isArray(response.provenance.fields) || response.provenance.fields.length > 128) {
    throw invalidFrame(`${label}.provenance.fields is invalid`);
  }
  for (let index = 0; index < response.provenance.fields.length; index += 1) {
    const field = response.provenance.fields[index];
    const fieldLabel = `${label}.provenance.fields[${index}]`;
    assertExactKeys(field, fieldLabel, ["path", "kind", "method"]);
    assertBoundedString(field.path, `${fieldLabel}.path`, 256, { allowEmpty: false });
    assertEnum(field.kind, `${fieldLabel}.kind`, new Set(["recorded", "derived", "estimated"]));
    assertBoundedString(field.method, `${fieldLabel}.method`, 128, { allowEmpty: false });
  }
  assertExactKeys(response.limits, `${label}.limits`, [
    "pageBytes", "payloadsMayRequireEvidencePaging",
  ]);
  assertDecimal(response.limits.pageBytes, `${label}.limits.pageBytes`);
  assertBoolean(
    response.limits.payloadsMayRequireEvidencePaging,
    `${label}.limits.payloadsMayRequireEvidencePaging`,
  );
}

function assertDeepEvidenceResponse(response, label) {
  assertExactKeys(response, label, [
    "format", "databaseUuid", "snapshotSeq", "target", "revision", "payloadSha256",
    "totalBytes", "range", "content", "nextCursor", "complete",
  ]);
  if (response.format !== "threadshare-insights-evidence@v2") {
    throw invalidFrame(`${label}.format is invalid`);
  }
  assertUuid(response.databaseUuid, `${label}.databaseUuid`);
  assertDecimal(response.snapshotSeq, `${label}.snapshotSeq`);
  assertDeepTarget(response.target, `${label}.target`);
  assertHex64(response.revision, `${label}.revision`);
  if (response.target.revision !== response.revision) {
    throw invalidFrame(`${label}.revision does not match target`);
  }
  assertHex64(response.payloadSha256, `${label}.payloadSha256`);
  assertDecimal(response.totalBytes, `${label}.totalBytes`);
  assertExactKeys(response.range, `${label}.range`, ["start", "end"]);
  assertDecimal(response.range.start, `${label}.range.start`);
  assertDecimal(response.range.end, `${label}.range.end`);
  const start = BigInt(response.range.start);
  const end = BigInt(response.range.end);
  const total = BigInt(response.totalBytes);
  if (start > end || end > total || end - start !== BigInt(Buffer.byteLength(response.content))) {
    throw invalidFrame(`${label}.range is inconsistent`);
  }
  assertBoundedString(response.content, `${label}.content`, MAX_DEEP_EVIDENCE_BYTES);
  assertDeepCursor(response.nextCursor, `${label}.nextCursor`);
  assertBoolean(response.complete, `${label}.complete`);
  if (response.complete !== (end === total && response.nextCursor === null)) {
    throw invalidFrame(`${label}.complete is inconsistent`);
  }
}

function assertReadInsightsQueryV2(message) {
  assertEnvelope(message, "READ_INSIGHTS_QUERY_V2", ["request"]);
  assertDeepQueryRequest(message.request, "READ_INSIGHTS_QUERY_V2.request");
}

function assertInsightsQueryV2(message) {
  assertEnvelope(message, "INSIGHTS_QUERY_V2", ["response"]);
  assertDeepQueryResponse(message.response, "INSIGHTS_QUERY_V2.response");
  assertMessagePayloadBound(message, "INSIGHTS_QUERY_V2");
}

function assertReadInsightsEvidenceV2(message) {
  assertEnvelope(message, "READ_INSIGHTS_EVIDENCE_V2", ["request"]);
  assertDeepEvidenceRequest(message.request, "READ_INSIGHTS_EVIDENCE_V2.request");
}

function assertInsightsEvidenceV2(message, validatedPayloadByteLength = null) {
  assertEnvelope(message, "INSIGHTS_EVIDENCE_V2", ["response"]);
  assertDeepEvidenceResponse(message.response, "INSIGHTS_EVIDENCE_V2.response");
  assertMessagePayloadBound(
    message,
    "INSIGHTS_EVIDENCE_V2",
    validatedPayloadByteLength,
  );
}

const RECIPE_NAMES = new Set([
  "capability-contexts@1", "failure-chains@1", "file-workflow-signals@1",
  "activity-shifts@1", "token-hotspots@1", "solution-recall@1", "session-timeline@1",
]);

function assertRecipeWindow(value, label) {
  assertExactKeys(value, label, ["after", "before"]);
  assertCanonicalTimestamp(value.after, `${label}.after`);
  assertCanonicalTimestamp(value.before, `${label}.before`);
  if (Date.parse(value.after) >= Date.parse(value.before)) {
    throw invalidFrame(`${label} must be non-empty`);
  }
}

function assertRecipeFilters(value, label) {
  assertExactKeys(value, label, [
    "providers", "projectKeys", "capabilityKeys", "sessionKeys", "eventKinds", "text", "bucket",
  ]);
  for (const field of ["providers", "eventKinds"]) {
    assertBoundedSortedArray(value[field], `${label}.${field}`, 64,
      (item, itemLabel) => assertBoundedString(item, itemLabel, 256, { allowEmpty: false }));
  }
  for (const field of ["projectKeys", "capabilityKeys", "sessionKeys"]) {
    assertBoundedSortedArray(value[field], `${label}.${field}`, 64,
      (item, itemLabel) => assertHex64(item, itemLabel));
  }
  if (value.text !== null) {
    assertBoundedString(value.text, `${label}.text`, 8 * 1_024, { allowEmpty: false });
  }
  if (value.bucket !== null) assertEnum(value.bucket, `${label}.bucket`, new Set(["day", "week"]));
}

function assertRecipeRequest(request, label) {
  assertExactKeys(request, label, [
    "format", "name", "window", "comparisonWindow", "filters", "limit", "allowDegraded",
    "evaluatedAt",
  ]);
  if (request.format !== "threadshare-insights-recipe-request@v1") {
    throw invalidFrame(`${label}.format is invalid`);
  }
  assertEnum(request.name, `${label}.name`, RECIPE_NAMES);
  assertRecipeWindow(request.window, `${label}.window`);
  if (request.comparisonWindow !== null) {
    assertRecipeWindow(request.comparisonWindow, `${label}.comparisonWindow`);
  }
  assertRecipeFilters(request.filters, `${label}.filters`);
  assertSafeInteger(request.limit, `${label}.limit`, { min: 1, max: 50 });
  assertBoolean(request.allowDegraded, `${label}.allowDegraded`);
  assertCanonicalTimestamp(request.evaluatedAt, `${label}.evaluatedAt`);
  if (Buffer.byteLength(canonicalJson(request), "utf8") > MAX_DEEP_QUERY_REQUEST_BYTES) {
    throw invalidFrame(`${label} exceeds 64 KiB`);
  }
}

const RECIPE_TOKEN_METRICS = Object.freeze([
  "input", "cachedInput", "cacheWriteInput", "output", "reasoning", "total",
]);

function assertNullableRecipeString(value, label, maxBytes = MAX_PROTOCOL_PAYLOAD_BYTES) {
  if (value !== null) assertBoundedString(value, label, maxBytes);
}

function assertRecipeEvidence(value, label, { nullable = false, kind = null } = {}) {
  if (value === null && nullable) return;
  assertDeepTarget(value, label);
  if (kind !== null && value.kind !== kind) throw invalidFrame(`${label}.kind is invalid`);
}

function assertRecipeContent(value, label) {
  if (value === null) return;
  assertDeepJsonValue(value, label);
  if (value.inline !== null || value.reference === null) {
    throw invalidFrame(`${label} must use an evidence reference`);
  }
}

function assertRecipeDecimalFields(value, label, fields) {
  assertExactKeys(value, label, fields);
  for (const field of fields) assertDecimal(value[field], `${label}.${field}`);
}

function assertRecipeTokenFields(totals, coverage, label) {
  assertExactKeys(totals, `${label}.totals`, RECIPE_TOKEN_METRICS);
  assertExactKeys(coverage, `${label}.coverage`, RECIPE_TOKEN_METRICS);
  for (const field of RECIPE_TOKEN_METRICS) {
    const metricLabel = `${label}.${field}`;
    assertRecipeDecimalFields(coverage[field], `${metricLabel}.coverage`, [
      "presentEventCount", "totalEventCount",
    ]);
    const present = BigInt(coverage[field].presentEventCount);
    const total = BigInt(coverage[field].totalEventCount);
    if (present > total) throw invalidFrame(`${metricLabel} coverage is inconsistent`);
    const complete = present === total;
    if (totals[field] === null) {
      if (complete) throw invalidFrame(`${metricLabel} unexpectedly omits a complete total`);
    } else {
      assertDecimal(totals[field], `${metricLabel}.total`);
      if (!complete) throw invalidFrame(`${metricLabel} presents a partial sum as a total`);
    }
  }
}

function assertRecipeChange(value, label, { nullable = false } = {}) {
  assertExactKeys(value, label, ["baseline", "current", "absoluteChange"]);
  const nulls = [value.baseline, value.current, value.absoluteChange]
    .filter((item) => item === null).length;
  if (nulls > 0) {
    if (!nullable || nulls !== 3) throw invalidFrame(`${label} nullability is inconsistent`);
    return;
  }
  assertDecimal(value.baseline, `${label}.baseline`);
  assertDecimal(value.current, `${label}.current`);
  assertSignedDecimal(value.absoluteChange, `${label}.absoluteChange`);
  if (BigInt(value.current) - BigInt(value.baseline) !== BigInt(value.absoluteChange)) {
    throw invalidFrame(`${label}.absoluteChange is inconsistent`);
  }
}

function assertRecipeDedupeSupport(value, label) {
  assertRecipeDecimalFields(value, label, [
    "distinctDedupeGroupCount", "strongDedupeGroupCount", "weakDedupeGroupCount",
    "observedEofProvisionalGroupCount", "unknownDedupeSessionCount",
  ]);
  if (BigInt(value.strongDedupeGroupCount) + BigInt(value.weakDedupeGroupCount) !==
      BigInt(value.distinctDedupeGroupCount)) {
    throw invalidFrame(`${label} confidence counts are inconsistent`);
  }
}

function assertCapabilityContextItem(item, label) {
  assertExactKeys(item, label, [
    "capability", "recordedInvocationCount", "recordedFailingInvocationCount",
    "distinctTurnCount", "distinctSessionCount", "distinctDedupeGroupCount",
    "groupedInvocationCount", "ungroupedInvocationCount", "lastUsedAt",
    "strongGroupMemberInvocationCount", "weakGroupMemberInvocationCount",
    "invocationTerminalCounts", "topProjects", "coOccurringCapabilities",
    "representativeTurns", "evidence",
  ]);
  assertExactKeys(item.capability, `${label}.capability`, [
    "capabilityKey", "provider", "kind", "canonicalName",
  ]);
  assertHex64(item.capability.capabilityKey, `${label}.capability.capabilityKey`);
  assertBoundedString(item.capability.provider, `${label}.capability.provider`, 64, {
    allowEmpty: false,
  });
  assertEnum(item.capability.kind, `${label}.capability.kind`, new Set(["tool", "skill"]));
  assertBoundedString(item.capability.canonicalName, `${label}.capability.canonicalName`, 512, {
    allowEmpty: false,
  });
  const counts = [
    "recordedInvocationCount", "recordedFailingInvocationCount", "distinctTurnCount",
    "distinctSessionCount", "distinctDedupeGroupCount", "groupedInvocationCount",
    "ungroupedInvocationCount", "strongGroupMemberInvocationCount",
    "weakGroupMemberInvocationCount",
  ];
  for (const field of counts) assertDecimal(item[field], `${label}.${field}`);
  if (BigInt(item.groupedInvocationCount) + BigInt(item.ungroupedInvocationCount) !==
      BigInt(item.recordedInvocationCount)) {
    throw invalidFrame(`${label} grouped invocation counts are inconsistent`);
  }
  if (item.lastUsedAt !== null) requiredTimestamp(item.lastUsedAt, `${label}.lastUsedAt`);
  assertRecipeDecimalFields(item.invocationTerminalCounts, `${label}.invocationTerminalCounts`, [
    "pending", "completed", "failed", "cancelled", "unknown",
  ]);
  const terminalTotal = Object.values(item.invocationTerminalCounts)
    .reduce((sum, value) => sum + BigInt(value), 0n);
  if (terminalTotal !== BigInt(item.recordedInvocationCount) ||
      item.invocationTerminalCounts.failed !== item.recordedFailingInvocationCount) {
    throw invalidFrame(`${label} terminal counts are inconsistent`);
  }
  if (!Array.isArray(item.topProjects) || item.topProjects.length > 5) {
    throw invalidFrame(`${label}.topProjects exceeds 5 items`);
  }
  for (let index = 0; index < item.topProjects.length; index += 1) {
    const project = item.topProjects[index];
    const projectLabel = `${label}.topProjects[${index}]`;
    assertExactKeys(project, projectLabel, ["projectKey", "recordedInvocationCount"]);
    assertNullableHex64(project.projectKey, `${projectLabel}.projectKey`);
    assertDecimal(project.recordedInvocationCount, `${projectLabel}.recordedInvocationCount`);
  }
  if (!Array.isArray(item.coOccurringCapabilities) || item.coOccurringCapabilities.length > 5) {
    throw invalidFrame(`${label}.coOccurringCapabilities exceeds 5 items`);
  }
  for (let index = 0; index < item.coOccurringCapabilities.length; index += 1) {
    const other = item.coOccurringCapabilities[index];
    const otherLabel = `${label}.coOccurringCapabilities[${index}]`;
    assertExactKeys(other, otherLabel, [
      "capabilityKey", "kind", "canonicalName", "distinctTurnCount",
    ]);
    assertHex64(other.capabilityKey, `${otherLabel}.capabilityKey`);
    assertEnum(other.kind, `${otherLabel}.kind`, new Set(["tool", "skill"]));
    assertBoundedString(other.canonicalName, `${otherLabel}.canonicalName`, 512, {
      allowEmpty: false,
    });
    assertDecimal(other.distinctTurnCount, `${otherLabel}.distinctTurnCount`);
  }
  if (!Array.isArray(item.representativeTurns) || item.representativeTurns.length > 5) {
    throw invalidFrame(`${label}.representativeTurns exceeds 5 items`);
  }
  for (let index = 0; index < item.representativeTurns.length; index += 1) {
    const turn = item.representativeTurns[index];
    const turnLabel = `${label}.representativeTurns[${index}]`;
    assertExactKeys(turn, turnLabel, [
      "turnKey", "usedAt", "recordedInvocationCount", "context", "evidence",
    ]);
    assertHex64(turn.turnKey, `${turnLabel}.turnKey`);
    if (turn.usedAt !== null) requiredTimestamp(turn.usedAt, `${turnLabel}.usedAt`);
    assertDecimal(turn.recordedInvocationCount, `${turnLabel}.recordedInvocationCount`);
    assertExactKeys(turn.context, `${turnLabel}.context`, ["problem", "finalAnswer"]);
    assertBoundedString(turn.context.problem, `${turnLabel}.context.problem`, MAX_TURN_PROBLEM_BYTES);
    assertNullableBoundedString(
      turn.context.finalAnswer,
      `${turnLabel}.context.finalAnswer`,
      MAX_TURN_ANSWER_BYTES,
    );
    assertRecipeEvidence(turn.evidence, `${turnLabel}.evidence`, { kind: "turn" });
  }
  assertRecipeEvidence(item.evidence, `${label}.evidence`, { nullable: true, kind: "turn" });
}

function assertFailureChainItem(item, label) {
  assertExactKeys(item, label, [
    "chainKey", "revision", "status", "capabilityName", "eventCount",
    "failedResultCount", "completedResultCount", "firstObservedAt", "lastObservedAt",
    "attempts", "evidence",
  ]);
  assertHex64(item.chainKey, `${label}.chainKey`);
  assertHex64(item.revision, `${label}.revision`);
  assertEnum(item.status, `${label}.status`, new Set([
    "resolved", "never-succeeded", "abandoned", "unknown",
  ]));
  assertNullableRecipeString(item.capabilityName, `${label}.capabilityName`, 512);
  for (const field of ["eventCount", "failedResultCount", "completedResultCount"]) {
    assertDecimal(item[field], `${label}.${field}`);
  }
  if (item.firstObservedAt !== null) requiredTimestamp(item.firstObservedAt, `${label}.firstObservedAt`);
  if (item.lastObservedAt !== null) requiredTimestamp(item.lastObservedAt, `${label}.lastObservedAt`);
  if (!Array.isArray(item.attempts) || item.attempts.length > 10_000 ||
      BigInt(item.eventCount) !== BigInt(item.attempts.length)) {
    throw invalidFrame(`${label}.attempts is inconsistent`);
  }
  let failed = 0n;
  let completed = 0n;
  for (let index = 0; index < item.attempts.length; index += 1) {
    const attempt = item.attempts[index];
    const attemptLabel = `${label}.attempts[${index}]`;
    assertExactKeys(attempt, attemptLabel, [
      "eventKey", "revision", "eventKind", "observedAt", "capabilityKey",
      "capabilityName", "inputFingerprint", "providerState", "exitCode", "input",
      "output", "error", "evidence",
    ]);
    assertHex64(attempt.eventKey, `${attemptLabel}.eventKey`);
    assertHex64(attempt.revision, `${attemptLabel}.revision`);
    assertBoundedString(attempt.eventKind, `${attemptLabel}.eventKind`, 128, {
      allowEmpty: false,
    });
    if (attempt.observedAt !== null) requiredTimestamp(attempt.observedAt, `${attemptLabel}.observedAt`);
    assertNullableHex64(attempt.capabilityKey, `${attemptLabel}.capabilityKey`);
    assertNullableRecipeString(attempt.capabilityName, `${attemptLabel}.capabilityName`, 512);
    assertNullableHex64(attempt.inputFingerprint, `${attemptLabel}.inputFingerprint`);
    if (attempt.providerState !== null) {
      assertEnum(attempt.providerState, `${attemptLabel}.providerState`, new Set([
        "pending", "completed", "failed", "unknown",
      ]));
    }
    if (attempt.exitCode !== null) assertDecimal(attempt.exitCode, `${attemptLabel}.exitCode`);
    for (const field of ["input", "output", "error"]) {
      assertRecipeContent(attempt[field], `${attemptLabel}.${field}`);
    }
    assertRecipeEvidence(attempt.evidence, `${attemptLabel}.evidence`, { kind: "event" });
    if (attempt.providerState === "failed") failed += 1n;
    if (attempt.providerState === "completed") completed += 1n;
  }
  if (failed !== BigInt(item.failedResultCount) || completed !== BigInt(item.completedResultCount)) {
    throw invalidFrame(`${label} result counts are inconsistent`);
  }
  assertRecipeEvidence(item.evidence, `${label}.evidence`, { kind: "attempt-chain" });
}

function assertFileWorkflowItem(item, label) {
  assertExactKeys(item, label, [
    "sessionKey", "provider", "projectKey", "recordedCounts", "estimated", "evidence", "events",
  ]);
  assertHex64(item.sessionKey, `${label}.sessionKey`);
  assertBoundedString(item.provider, `${label}.provider`, 64, { allowEmpty: false });
  assertNullableHex64(item.projectKey, `${label}.projectKey`);
  const recordedFields = [
    "read", "edit", "write", "delete", "move", "search", "list", "attempted",
    "confirmed", "failed", "unknown", "distinctPath", "documentLike", "implementationLike",
  ];
  assertRecipeDecimalFields(item.recordedCounts, `${label}.recordedCounts`, recordedFields);
  assertExactKeys(item.estimated, `${label}.estimated`, [
    "researchHeavy", "implementationHeavy", "docVoid", "specPrecisionGap", "method",
  ]);
  for (const field of ["researchHeavy", "implementationHeavy", "docVoid", "specPrecisionGap"]) {
    assertBoolean(item.estimated[field], `${label}.estimated.${field}`);
  }
  if (item.estimated.method !== "file-workflow-signals@1") {
    throw invalidFrame(`${label}.estimated.method is invalid`);
  }
  if (!Array.isArray(item.events) || item.events.length > 10_000) {
    throw invalidFrame(`${label}.events is invalid`);
  }
  for (let index = 0; index < item.events.length; index += 1) {
    const event = item.events[index];
    const eventLabel = `${label}.events[${index}]`;
    assertExactKeys(event, eventLabel, [
      "eventKey", "revision", "observedAt", "eventKind", "activityOrdinal", "action",
      "phase", "pathRole", "rawPath", "normalizedPath", "relativePath", "absolute",
      "projectRelative", "input", "output", "error", "evidence",
    ]);
    assertHex64(event.eventKey, `${eventLabel}.eventKey`);
    assertHex64(event.revision, `${eventLabel}.revision`);
    if (event.observedAt !== null) requiredTimestamp(event.observedAt, `${eventLabel}.observedAt`);
    assertBoundedString(event.eventKind, `${eventLabel}.eventKind`, 128, { allowEmpty: false });
    assertDecimal(event.activityOrdinal, `${eventLabel}.activityOrdinal`);
    assertEnum(event.action, `${eventLabel}.action`, new Set([
      "read", "edit", "write", "delete", "move", "search", "list",
    ]));
    assertEnum(event.phase, `${eventLabel}.phase`, new Set([
      "attempted", "confirmed", "failed", "unknown",
    ]));
    assertEnum(event.pathRole, `${eventLabel}.pathRole`, new Set(["target", "source", "destination"]));
    assertBoundedString(event.rawPath, `${eventLabel}.rawPath`, MAX_SOURCE_LOCATOR_BYTES, {
      allowEmpty: false,
    });
    assertBoundedString(event.normalizedPath, `${eventLabel}.normalizedPath`, MAX_SOURCE_LOCATOR_BYTES, {
      allowEmpty: false,
    });
    assertNullableRecipeString(event.relativePath, `${eventLabel}.relativePath`, MAX_SOURCE_LOCATOR_BYTES);
    assertBoolean(event.absolute, `${eventLabel}.absolute`);
    assertBoolean(event.projectRelative, `${eventLabel}.projectRelative`);
    for (const field of ["input", "output", "error"]) {
      assertRecipeContent(event[field], `${eventLabel}.${field}`);
    }
    assertRecipeEvidence(event.evidence, `${eventLabel}.evidence`, { kind: "event" });
  }
  const actionTotal = ["read", "edit", "write", "delete", "move", "search", "list"]
    .reduce((sum, field) => sum + BigInt(item.recordedCounts[field]), 0n);
  const phaseTotal = ["attempted", "confirmed", "failed", "unknown"]
    .reduce((sum, field) => sum + BigInt(item.recordedCounts[field]), 0n);
  if (actionTotal !== phaseTotal || BigInt(item.events.length) > actionTotal ||
      BigInt(item.recordedCounts.distinctPath) > actionTotal) {
    throw invalidFrame(`${label}.recordedCounts is inconsistent`);
  }
  const mutations = ["edit", "write", "delete", "move"]
    .reduce((sum, field) => sum + BigInt(item.recordedCounts[field]), 0n);
  const reads = BigInt(item.recordedCounts.read);
  const researchHeavy = reads >= 3n * (mutations > 0n ? mutations : 1n);
  const implementationHeavy = mutations >= 5n && reads * 10n <= mutations * 8n;
  const noDocuments = item.recordedCounts.documentLike === "0";
  if (item.estimated.researchHeavy !== researchHeavy ||
      item.estimated.implementationHeavy !== implementationHeavy ||
      item.estimated.docVoid !== (researchHeavy && noDocuments) ||
      item.estimated.specPrecisionGap !== (implementationHeavy && noDocuments)) {
    throw invalidFrame(`${label}.estimated is inconsistent`);
  }
  assertRecipeEvidence(item.evidence, `${label}.evidence`, { kind: "session" });
}

function assertActivityShiftItem(item, label) {
  assertExactKeys(item, label, [
    "bucketStart", "bucketEnd", "timeZone", "closureEvaluatedAt", "quiescenceSeconds",
    "distinctSessionCount", "distinctTurnCount", "distinctProjectCount",
    "observedContextSwitchCount", "recordedToolInvocationCount",
    "recordedSkillInvocationCount", "recordedTokenEventCount", "recordedTokenTotals",
    "tokenMetricCoverage", "currentClosureCounts", "turnOutcomeCounts", "dedupeSupport",
    "comparison", "evidence",
  ]);
  const start = requiredTimestamp(item.bucketStart, `${label}.bucketStart`);
  const end = requiredTimestamp(item.bucketEnd, `${label}.bucketEnd`);
  if (start >= end || item.timeZone !== "UTC") throw invalidFrame(`${label} bucket is invalid`);
  requiredTimestamp(item.closureEvaluatedAt, `${label}.closureEvaluatedAt`);
  if (item.quiescenceSeconds !== 300) throw invalidFrame(`${label}.quiescenceSeconds is invalid`);
  const countFields = [
    "distinctSessionCount", "distinctTurnCount", "distinctProjectCount",
    "observedContextSwitchCount", "recordedToolInvocationCount",
    "recordedSkillInvocationCount", "recordedTokenEventCount",
  ];
  for (const field of countFields) assertDecimal(item[field], `${label}.${field}`);
  assertRecipeTokenFields(
    item.recordedTokenTotals,
    item.tokenMetricCoverage,
    `${label}.tokenMetrics`,
  );
  for (const metric of RECIPE_TOKEN_METRICS) {
    if (item.tokenMetricCoverage[metric].totalEventCount !== item.recordedTokenEventCount) {
      throw invalidFrame(`${label}.${metric} token coverage denominator is inconsistent`);
    }
  }
  assertRecipeDecimalFields(item.currentClosureCounts, `${label}.currentClosureCounts`, [
    "hardSealed", "quiescent", "open",
  ]);
  assertRecipeDecimalFields(item.turnOutcomeCounts, `${label}.turnOutcomeCounts`, [
    "providerCompleted", "abandoned", "unknown",
  ]);
  for (const group of [item.currentClosureCounts, item.turnOutcomeCounts]) {
    const total = Object.values(group).reduce((sum, value) => sum + BigInt(value), 0n);
    if (total !== BigInt(item.distinctTurnCount)) {
      throw invalidFrame(`${label} Turn counts are inconsistent`);
    }
  }
  assertRecipeDedupeSupport(item.dedupeSupport, `${label}.dedupeSupport`);
  if (item.comparison !== null) {
    assertExactKeys(item.comparison, `${label}.comparison`, [
      "baselineBucketStart", "distinctSessionCount", "distinctTurnCount",
      "distinctProjectCount", "observedContextSwitchCount", "recordedToolInvocationCount",
      "recordedSkillInvocationCount", "recordedTokenEventCount", "recordedTokenTotals",
      "currentClosureCounts", "turnOutcomeCounts",
    ]);
    requiredTimestamp(item.comparison.baselineBucketStart, `${label}.comparison.baselineBucketStart`);
    for (const field of countFields) {
      assertRecipeChange(item.comparison[field], `${label}.comparison.${field}`);
    }
    assertExactKeys(
      item.comparison.recordedTokenTotals,
      `${label}.comparison.recordedTokenTotals`,
      RECIPE_TOKEN_METRICS,
    );
    for (const metric of RECIPE_TOKEN_METRICS) {
      assertRecipeChange(
        item.comparison.recordedTokenTotals[metric],
        `${label}.comparison.recordedTokenTotals.${metric}`,
        { nullable: true },
      );
    }
    for (const [field, keys] of [
      ["currentClosureCounts", ["hardSealed", "quiescent", "open"]],
      ["turnOutcomeCounts", ["providerCompleted", "abandoned", "unknown"]],
    ]) {
      assertExactKeys(item.comparison[field], `${label}.comparison.${field}`, keys);
      for (const key of keys) {
        assertRecipeChange(
          item.comparison[field][key],
          `${label}.comparison.${field}.${key}`,
        );
      }
    }
  }
  assertRecipeEvidence(item.evidence, `${label}.evidence`, { nullable: true, kind: "session" });
}

function assertTokenHotspotItem(item, label) {
  assertExactKeys(item, label, [
    "provider", "model", "projectKey", "capability", "capabilityAttribution",
    "recordedTokenTotals", "metricCoverage", "evidence",
  ]);
  assertBoundedString(item.provider, `${label}.provider`, 64, { allowEmpty: false });
  assertNullableRecipeString(item.model, `${label}.model`, 256);
  assertNullableHex64(item.projectKey, `${label}.projectKey`);
  if (item.capability !== null || item.capabilityAttribution !== "unavailable") {
    throw invalidFrame(`${label} must not infer capability-scoped token usage`);
  }
  assertRecipeTokenFields(
    item.recordedTokenTotals,
    item.metricCoverage,
    `${label}.tokenMetrics`,
  );
  assertRecipeEvidence(item.evidence, `${label}.evidence`, { nullable: true, kind: "event" });
}

function assertSolutionRecallItem(item, label) {
  assertExactKeys(item, label, [
    "eventKey", "eventRevision", "turnKey", "turnRevision", "provider", "projectKey",
    "eventKind", "observedAt", "finalAnswer", "subsequentSuccess", "evidence",
  ]);
  assertHex64(item.eventKey, `${label}.eventKey`);
  assertHex64(item.eventRevision, `${label}.eventRevision`);
  assertNullableHex64(item.turnKey, `${label}.turnKey`);
  assertNullableHex64(item.turnRevision, `${label}.turnRevision`);
  if ((item.turnKey === null) !== (item.turnRevision === null)) {
    throw invalidFrame(`${label} Turn identity is inconsistent`);
  }
  assertBoundedString(item.provider, `${label}.provider`, 64, { allowEmpty: false });
  assertNullableHex64(item.projectKey, `${label}.projectKey`);
  assertBoundedString(item.eventKind, `${label}.eventKind`, 128, { allowEmpty: false });
  if (item.observedAt !== null) requiredTimestamp(item.observedAt, `${label}.observedAt`);
  assertNullableBoundedString(item.finalAnswer, `${label}.finalAnswer`, MAX_TURN_ANSWER_BYTES);
  if (item.subsequentSuccess !== null) {
    assertExactKeys(item.subsequentSuccess, `${label}.subsequentSuccess`, [
      "chainKey", "eventKey", "observedAt", "evidence",
    ]);
    assertHex64(item.subsequentSuccess.chainKey, `${label}.subsequentSuccess.chainKey`);
    assertHex64(item.subsequentSuccess.eventKey, `${label}.subsequentSuccess.eventKey`);
    if (item.subsequentSuccess.observedAt !== null) {
      requiredTimestamp(
        item.subsequentSuccess.observedAt,
        `${label}.subsequentSuccess.observedAt`,
      );
    }
    assertRecipeEvidence(
      item.subsequentSuccess.evidence,
      `${label}.subsequentSuccess.evidence`,
      { kind: "event" },
    );
  }
  assertRecipeEvidence(item.evidence, `${label}.evidence`, { kind: "event" });
}

/**
 * Timeline items carry an Engine-assigned ordinal so a reader can restate the observed
 * order without re-deriving it from offsets, and a repeat group so repeated attempts can
 * be collapsed. `expectedOrdinal` is the item's position in this response: the two must
 * agree, otherwise the ordinal is not a usable ordering key.
 */
function assertSessionTimelineItem(item, label, expectedOrdinal) {
  assertExactKeys(item, label, [
    "eventKey", "revision", "observedAt", "eventKind", "originScope", "completeness",
    "metadata", "turnKey", "turnRevision", "repeatGroup", "sequenceOrdinal", "evidence",
  ]);
  if (item.sequenceOrdinal !== expectedOrdinal) {
    throw invalidFrame(`${label}.sequenceOrdinal does not match the item position`);
  }
  if (item.repeatGroup !== null) {
    assertExactKeys(item.repeatGroup, `${label}.repeatGroup`, ["groupKey", "bucket"]);
    assertHex64(item.repeatGroup.groupKey, `${label}.repeatGroup.groupKey`);
    assertEnum(item.repeatGroup.bucket, `${label}.repeatGroup.bucket`,
      new Set(["1", "2-3", "4+"]));
    if (item.turnKey === null) {
      throw invalidFrame(`${label}.repeatGroup requires a Turn`);
    }
  }
  assertHex64(item.eventKey, `${label}.eventKey`);
  assertHex64(item.revision, `${label}.revision`);
  if (item.observedAt !== null) requiredTimestamp(item.observedAt, `${label}.observedAt`);
  assertBoundedString(item.eventKind, `${label}.eventKind`, 128, { allowEmpty: false });
  assertEnum(item.originScope, `${label}.originScope`, new Set(["main", "subagent", "unknown"]));
  assertEnum(item.completeness, `${label}.completeness`, new Set([
    "full", "summary", "unloaded", "truncated", "unavailable",
  ]));
  assertPlainObject(item.metadata, `${label}.metadata`);
  assertDeepJsonValue(item.metadata, `${label}.metadata`);
  assertNullableHex64(item.turnKey, `${label}.turnKey`);
  assertNullableHex64(item.turnRevision, `${label}.turnRevision`);
  if ((item.turnKey === null) !== (item.turnRevision === null)) {
    throw invalidFrame(`${label} Turn identity is inconsistent`);
  }
  assertRecipeEvidence(item.evidence, `${label}.evidence`, { kind: "event" });
}

function assertRecipeItem(name, item, label, index) {
  if (name === "capability-contexts@1") return assertCapabilityContextItem(item, label);
  if (name === "failure-chains@1") return assertFailureChainItem(item, label);
  if (name === "file-workflow-signals@1") return assertFileWorkflowItem(item, label);
  if (name === "activity-shifts@1") return assertActivityShiftItem(item, label);
  if (name === "token-hotspots@1") return assertTokenHotspotItem(item, label);
  if (name === "solution-recall@1") return assertSolutionRecallItem(item, label);
  return assertSessionTimelineItem(item, label, index);
}

function assertRecipeResponse(response, label) {
  assertExactKeys(response, label, [
    "format", "databaseUuid", "snapshotSeq", "name", "window", "comparisonWindow",
    "evaluatedAt", "items", "totalItemCount", "truncated", "coverage", "provenance",
  ]);
  if (response.format !== "threadshare-insights-recipe@v1") {
    throw invalidFrame(`${label}.format is invalid`);
  }
  assertUuid(response.databaseUuid, `${label}.databaseUuid`);
  assertDecimal(response.snapshotSeq, `${label}.snapshotSeq`);
  assertEnum(response.name, `${label}.name`, RECIPE_NAMES);
  assertRecipeWindow(response.window, `${label}.window`);
  if (response.comparisonWindow !== null) {
    assertRecipeWindow(response.comparisonWindow, `${label}.comparisonWindow`);
  }
  assertCanonicalTimestamp(response.evaluatedAt, `${label}.evaluatedAt`);
  if (!Array.isArray(response.items) || response.items.length > 50) {
    throw invalidFrame(`${label}.items exceeds 50 items`);
  }
  for (let index = 0; index < response.items.length; index += 1) {
    assertRecipeItem(response.name, response.items[index], `${label}.items[${index}]`, index);
  }
  assertDecimal(response.totalItemCount, `${label}.totalItemCount`);
  if (BigInt(response.totalItemCount) < BigInt(response.items.length)) {
    throw invalidFrame(`${label}.totalItemCount is inconsistent`);
  }
  assertBoolean(response.truncated, `${label}.truncated`);
  if (response.truncated !== (BigInt(response.totalItemCount) > BigInt(response.items.length))) {
    throw invalidFrame(`${label}.truncated is inconsistent`);
  }
  assertDeepCoverage(response.coverage, `${label}.coverage`);
  assertExactKeys(response.provenance, `${label}.provenance`, ["default", "fields"]);
  assertEnum(response.provenance.default, `${label}.provenance.default`,
    new Set(["recorded", "derived", "estimated"]));
  if (!Array.isArray(response.provenance.fields) || response.provenance.fields.length > 64) {
    throw invalidFrame(`${label}.provenance.fields is invalid`);
  }
  assertMessagePayloadBound({ response }, label);
}

function assertReadInsightsRecipe(message) {
  assertEnvelope(message, "READ_INSIGHTS_RECIPE", ["request"]);
  assertRecipeRequest(message.request, "READ_INSIGHTS_RECIPE.request");
}

function assertInsightsRecipe(message) {
  assertEnvelope(message, "INSIGHTS_RECIPE", ["response"]);
  assertRecipeResponse(message.response, "INSIGHTS_RECIPE.response");
}

function assertTraceNodeRef(value, label) {
  assertExactKeys(value, label, ["kind", "key"]);
  assertEnum(value.kind, `${label}.kind`, TRACE_NODE_KINDS);
  assertHex64(value.key, `${label}.key`);
}

function assertRepositoryPath(value, label) {
  assertBoundedString(value, label, 12 * 1024, { allowEmpty: false });
  if (value.startsWith("/") || value.includes("\0") ||
      value.split("/").some((part) => part === "" || part === "." || part === "..")) {
    throw invalidFrame(`${label} must be a lexical repository-relative path`);
  }
}

function assertGitObjectId(value, label) {
  if (typeof value !== "string" || !GIT_OBJECT_ID.test(value)) {
    throw invalidFrame(`${label} must be a full lowercase Git object id`);
  }
}

function assertScmAttributes(value, label) {
  assertExactKeys(value, label, ["kind", "webBaseUrl", "repositoryPath", "availability"]);
  assertEnum(value.kind, `${label}.kind`, new Set(["github", "gitlab"]));
  const expectedBase = value.kind === "github" ? "https://github.com" : "https://gitlab.com";
  if (value.webBaseUrl !== expectedBase || value.availability !== "not-verified") {
    throw invalidFrame(`${label} identity is invalid`);
  }
  assertRepositoryPath(value.repositoryPath, `${label}.repositoryPath`);
}

function assertCommitExternalLink(value, objectId, label) {
  if (value === null) return;
  assertBoundedString(value, label, 16 * 1024, { allowEmpty: false, ascii: true });
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    throw invalidFrame(`${label} is invalid`);
  }
  const supportedHost = parsed.hostname === "github.com" || parsed.hostname === "gitlab.com";
  if (parsed.protocol !== "https:" || !supportedHost || parsed.username !== "" ||
      parsed.password !== "" || parsed.search !== "" || parsed.hash !== "" ||
      !parsed.pathname.endsWith(`/commit/${objectId}`)) {
    throw invalidFrame(`${label} is invalid`);
  }
}

function assertTraceNodeAttributes(kind, value, label) {
  if (kind === "intent") {
    assertExactKeys(value, label, ["intentKind", "status", "parentIntentKey"]);
    assertEnum(value.intentKind, `${label}.intentKind`, new Set(["feature", "story"]));
    assertEnum(value.status, `${label}.status`, new Set(["complete", "todo", "unknown"]));
    assertNullableHex64(value.parentIntentKey, `${label}.parentIntentKey`);
  } else if (kind === "repository") {
    assertExactKeys(value, label, ["projectKey", "scm"]);
    assertNullableHex64(value.projectKey, `${label}.projectKey`);
    if (value.scm !== null) assertScmAttributes(value.scm, `${label}.scm`);
  } else if (kind === "session") {
    assertExactKeys(value, label, ["provider", "projectKey"]);
    assertBoundedString(value.provider, `${label}.provider`, 64, { allowEmpty: false, ascii: true });
    assertNullableHex64(value.projectKey, `${label}.projectKey`);
  } else if (kind === "turn") {
    assertExactKeys(value, label, ["sessionKey"]);
    assertHex64(value.sessionKey, `${label}.sessionKey`);
  } else if (kind === "capability-use") {
    assertExactKeys(value, label, ["turnKey", "capabilityKind", "canonicalName"]);
    assertHex64(value.turnKey, `${label}.turnKey`);
    assertEnum(value.capabilityKind, `${label}.capabilityKind`, new Set(["tool", "skill"]));
    assertBoundedString(value.canonicalName, `${label}.canonicalName`, 512, { allowEmpty: false });
  } else if (kind === "file") {
    assertExactKeys(value, label, ["repositoryKey", "path"]);
    assertHex64(value.repositoryKey, `${label}.repositoryKey`);
    assertRepositoryPath(value.path, `${label}.path`);
  } else {
    assertExactKeys(value, label, [
      "repositoryKey", "objectId", "parentObjectIds", "reachable", "externalLinks",
    ]);
    assertHex64(value.repositoryKey, `${label}.repositoryKey`);
    assertGitObjectId(value.objectId, `${label}.objectId`);
    if (!Array.isArray(value.parentObjectIds) || value.parentObjectIds.length > 16) {
      throw invalidFrame(`${label}.parentObjectIds exceeds 16 items`);
    }
    value.parentObjectIds.forEach((item, index) =>
      assertGitObjectId(item, `${label}.parentObjectIds[${index}]`));
    assertBoolean(value.reachable, `${label}.reachable`);
    assertExactKeys(value.externalLinks, `${label}.externalLinks`, ["commit"]);
    assertCommitExternalLink(value.externalLinks.commit, value.objectId, `${label}.externalLinks.commit`);
  }
}

function assertTraceNode(value, label) {
  assertExactKeys(value, label, ["kind", "key", "revision", "label", "observedAt", "attributes"]);
  assertEnum(value.kind, `${label}.kind`, TRACE_NODE_KINDS);
  assertHex64(value.key, `${label}.key`);
  assertHex64(value.revision, `${label}.revision`);
  assertBoundedString(value.label, `${label}.label`, 1024, { allowEmpty: false });
  assertCanonicalTimestamp(value.observedAt, `${label}.observedAt`);
  assertTraceNodeAttributes(value.kind, value.attributes, `${label}.attributes`);
}

function assertTraceFact(value, label) {
  assertPlainObject(value, label);
  assertEnum(value.kind, `${label}.kind`, TRACE_FACT_KINDS);
  const counted = value.kind === "exact-path-overlap" || value.kind === "significant-term-overlap";
  assertExactKeys(value, label, counted ? ["kind", "count"] : ["kind"]);
  if (counted) {
    assertDecimal(value.count, `${label}.count`);
    if (value.count === "0") throw invalidFrame(`${label}.count must be positive`);
  }
}

function assertTraceEdge(value, label) {
  assertExactKeys(value, label, [
    "relation", "from", "to", "strength", "source", "facts", "limitations", "revision",
  ]);
  assertEnum(value.relation, `${label}.relation`, TRACE_RELATIONS);
  assertTraceNodeRef(value.from, `${label}.from`);
  assertTraceNodeRef(value.to, `${label}.to`);
  assertEnum(value.strength, `${label}.strength`, TRACE_STRENGTHS);
  assertEnum(value.source, `${label}.source`, TRACE_SOURCES);
  if (!Array.isArray(value.facts) || value.facts.length > 16) {
    throw invalidFrame(`${label}.facts exceeds 16 items`);
  }
  value.facts.forEach((fact, index) => assertTraceFact(fact, `${label}.facts[${index}]`));
  if (!Array.isArray(value.limitations) || value.limitations.length > 16 ||
      new Set(value.limitations).size !== value.limitations.length) {
    throw invalidFrame(`${label}.limitations is invalid`);
  }
  value.limitations.forEach((limitation, index) =>
    assertEnum(limitation, `${label}.limitations[${index}]`, TRACE_LIMITATIONS));
  assertHex64(value.revision, `${label}.revision`);
  if (TRACE_DERIVED_RELATIONS.has(value.relation) &&
      (value.facts.length === 0 || value.limitations.length === 0)) {
    throw invalidFrame(`${label} derived edges require facts and limitations`);
  }
  if (value.relation === "contextual-same-file" && value.strength !== "contextual") {
    throw invalidFrame(`${label} shared-file context cannot be upgraded`);
  }
  if ((value.relation === "session-correlates-commit" ||
       value.relation === "turn-correlates-commit") && value.strength === "direct") {
    throw invalidFrame(`${label} derived commit correlation cannot be direct`);
  }
}

function assertDeliveryTraceRequest(request, label) {
  assertExactKeys(request, label, [
    "format", "root", "window", "direction", "maxDepth", "includeCandidateEdges",
    "includeContextualEdges", "limit", "cursor", "evaluatedAt",
  ]);
  if (request.format !== "threadshare-insights-delivery-trace-request@v1") {
    throw invalidFrame(`${label}.format is invalid`);
  }
  assertTraceNodeRef(request.root, `${label}.root`);
  if (request.window !== null) {
    assertExactKeys(request.window, `${label}.window`, ["after", "before"]);
    requiredTimestamp(request.window.after, `${label}.window.after`);
    requiredTimestamp(request.window.before, `${label}.window.before`);
    if (request.window.after >= request.window.before) throw invalidFrame(`${label}.window is empty`);
  }
  assertEnum(request.direction, `${label}.direction`, TRACE_DIRECTIONS);
  assertSafeInteger(request.maxDepth, `${label}.maxDepth`, { min: 1, max: 3 });
  assertBoolean(request.includeCandidateEdges, `${label}.includeCandidateEdges`);
  assertBoolean(request.includeContextualEdges, `${label}.includeContextualEdges`);
  assertSafeInteger(request.limit, `${label}.limit`, { min: 1, max: 200 });
  if (request.cursor !== null) {
    assertBoundedString(request.cursor, `${label}.cursor`, 32 * 1024, {
      allowEmpty: false,
      ascii: true,
    });
  }
  requiredTimestamp(request.evaluatedAt, `${label}.evaluatedAt`);
}

function assertDeliveryTraceResponse(response, label) {
  assertExactKeys(response, label, [
    "format", "databaseUuid", "snapshotSeq", "evaluatedAt", "root", "nodes", "edges",
    "nextCursor", "truncated", "coverage",
  ]);
  if (response.format !== "threadshare-insights-delivery-trace@v1") {
    throw invalidFrame(`${label}.format is invalid`);
  }
  assertUuid(response.databaseUuid, `${label}.databaseUuid`);
  assertDecimal(response.snapshotSeq, `${label}.snapshotSeq`);
  requiredTimestamp(response.evaluatedAt, `${label}.evaluatedAt`);
  assertTraceNodeRef(response.root, `${label}.root`);
  if (!Array.isArray(response.nodes) || response.nodes.length > 401) {
    throw invalidFrame(`${label}.nodes exceeds 401 items`);
  }
  if (!Array.isArray(response.edges) || response.edges.length > 200) {
    throw invalidFrame(`${label}.edges exceeds 200 items`);
  }
  const endpoints = new Set();
  response.nodes.forEach((node, index) => {
    assertTraceNode(node, `${label}.nodes[${index}]`);
    const identity = `${node.kind}:${node.key}`;
    if (endpoints.has(identity)) throw invalidFrame(`${label}.nodes contains a duplicate`);
    endpoints.add(identity);
  });
  if (!endpoints.has(`${response.root.kind}:${response.root.key}`)) {
    throw invalidFrame(`${label}.root is missing from nodes`);
  }
  response.edges.forEach((edge, index) => {
    assertTraceEdge(edge, `${label}.edges[${index}]`);
    if (!endpoints.has(`${edge.from.kind}:${edge.from.key}`) ||
        !endpoints.has(`${edge.to.kind}:${edge.to.key}`)) {
      throw invalidFrame(`${label}.edges[${index}] references a missing node`);
    }
  });
  if (response.nextCursor !== null) {
    assertBoundedString(response.nextCursor, `${label}.nextCursor`, 32 * 1024, {
      allowEmpty: false,
      ascii: true,
    });
  }
  assertBoolean(response.truncated, `${label}.truncated`);
  if (response.truncated !== (response.nextCursor !== null)) {
    throw invalidFrame(`${label}.pagination is inconsistent`);
  }
  assertExactKeys(response.coverage, `${label}.coverage`, [
    "repositoryState", "intentState", "unresolvedRefCount", "excludedCandidateEdgeCount",
    "excludedContextualEdgeCount", "unreachableCommitCount", "unselectedRepositoryCount",
  ]);
  assertEnum(response.coverage.repositoryState, `${label}.coverage.repositoryState`,
    TRACE_COVERAGE_STATES);
  assertEnum(response.coverage.intentState, `${label}.coverage.intentState`, TRACE_COVERAGE_STATES);
  for (const field of [
    "unresolvedRefCount", "excludedCandidateEdgeCount", "excludedContextualEdgeCount",
    "unreachableCommitCount", "unselectedRepositoryCount",
  ]) assertDecimal(response.coverage[field], `${label}.coverage.${field}`);
  assertMessagePayloadBound({ response }, label);
}

function assertDeliveryTracePair(request, response, label) {
  assertDeliveryTraceRequest(request, `${label}.request`);
  assertDeliveryTraceResponse(response, `${label}.response`);
  if (canonicalJson(response.root) !== canonicalJson(request.root) ||
      response.evaluatedAt !== request.evaluatedAt || response.edges.length > request.limit) {
    throw invalidFrame(`${label}.response changed or exceeded the request`);
  }
  if (!request.includeCandidateEdges &&
      response.edges.some((edge) => edge.strength === "candidate")) {
    throw invalidFrame(`${label}.response exposed candidate edges`);
  }
  if (!request.includeContextualEdges &&
      response.edges.some((edge) => edge.strength === "contextual")) {
    throw invalidFrame(`${label}.response exposed contextual edges`);
  }
}

function assertReadInsightsDeliveryTrace(message) {
  assertEnvelope(message, "READ_INSIGHTS_DELIVERY_TRACE", ["request"]);
  assertDeliveryTraceRequest(message.request, "READ_INSIGHTS_DELIVERY_TRACE.request");
}

function assertInsightsDeliveryTrace(message) {
  assertEnvelope(message, "INSIGHTS_DELIVERY_TRACE", ["request", "response"]);
  assertDeliveryTracePair(message.request, message.response, "INSIGHTS_DELIVERY_TRACE");
}

/**
 * Envelope-level validation for the Team Memory `MEMORY_COMMAND`/`MEMORY_RESULT`
 * pair (design doc §3 DEV-4): the op must be one of the Stage 4a kebab-case ops
 * and the payload must be a plain object. Op-level deep validation lives in
 * `memory-state-client.mjs` (zod), matching the Rust side where `MEMORY_RESULT`
 * is only envelope-validated (crates/insights-engine/src/protocol.rs).
 */
function assertMemoryEnvelope(message, type) {
  assertEnvelope(message, type, ["op", "payload"]);
  if (typeof message.op !== "string" || !MEMORY_OP_SET.has(message.op)) {
    throw invalidFrame(`${type}.op ${String(message.op)} is not supported`);
  }
  assertPlainObject(message.payload, `${type}.payload`);
  assertMessagePayloadBound(message, type);
}

function assertMemoryCommand(message) {
  assertMemoryEnvelope(message, "MEMORY_COMMAND");
}

function assertMemoryResult(message) {
  assertMemoryEnvelope(message, "MEMORY_RESULT");
}

export function assertGitDiffEvidenceRequest(request, label = "Git diff request") {
  assertExactKeys(request, label, [
    "format", "repositoryKey", "commitObjectId", "parentObjectId", "path", "revision",
    "contextLines", "maxBytes", "cursor",
  ]);
  if (request.format !== "threadshare-insights-git-diff-evidence-request@v1") {
    throw invalidFrame(`${label}.format is invalid`);
  }
  assertHex64(request.repositoryKey, `${label}.repositoryKey`);
  assertGitObjectId(request.commitObjectId, `${label}.commitObjectId`);
  if (request.parentObjectId !== null) {
    assertGitObjectId(request.parentObjectId, `${label}.parentObjectId`);
  }
  if (request.path !== null) assertRepositoryPath(request.path, `${label}.path`);
  assertHex64(request.revision, `${label}.revision`);
  assertSafeInteger(request.contextLines, `${label}.contextLines`, { min: 0, max: 20 });
  assertSafeInteger(request.maxBytes, `${label}.maxBytes`, { min: 4, max: 1_048_576 });
  if (request.cursor !== null) {
    assertBoundedString(request.cursor, `${label}.cursor`, 32 * 1024, {
      allowEmpty: false,
      ascii: true,
    });
  }
}

export function assertGitDiffEvidenceResponse(response, label = "Git diff response") {
  assertExactKeys(response, label, [
    "format", "repositoryKey", "commitObjectId", "parentObjectId", "path", "revision",
    "provenance", "payloadSha256", "totalBytes", "range", "content", "nextCursor",
    "complete", "binary",
  ]);
  if (response.format !== "threadshare-insights-git-diff-evidence@v1" ||
      response.provenance !== "local-git-object") {
    throw invalidFrame(`${label} identity is invalid`);
  }
  assertHex64(response.repositoryKey, `${label}.repositoryKey`);
  assertGitObjectId(response.commitObjectId, `${label}.commitObjectId`);
  if (response.parentObjectId !== null) {
    assertGitObjectId(response.parentObjectId, `${label}.parentObjectId`);
  }
  if (response.path !== null) assertRepositoryPath(response.path, `${label}.path`);
  assertHex64(response.revision, `${label}.revision`);
  assertHex64(response.payloadSha256, `${label}.payloadSha256`);
  assertDecimal(response.totalBytes, `${label}.totalBytes`);
  assertExactKeys(response.range, `${label}.range`, ["start", "end"]);
  assertDecimal(response.range.start, `${label}.range.start`);
  assertDecimal(response.range.end, `${label}.range.end`);
  assertBoundedString(response.content, `${label}.content`, 1_048_576);
  if (BigInt(response.range.start) > BigInt(response.range.end) ||
      BigInt(response.range.end) > BigInt(response.totalBytes) ||
      Buffer.byteLength(response.content, "utf8") !==
        Number(BigInt(response.range.end) - BigInt(response.range.start))) {
    throw invalidFrame(`${label}.range is inconsistent`);
  }
  if (response.nextCursor !== null) {
    assertBoundedString(response.nextCursor, `${label}.nextCursor`, 32 * 1024, {
      allowEmpty: false,
      ascii: true,
    });
  }
  assertBoolean(response.complete, `${label}.complete`);
  assertBoolean(response.binary, `${label}.binary`);
  if (response.complete !== (response.nextCursor === null && response.range.end === response.totalBytes)) {
    throw invalidFrame(`${label}.completion is inconsistent`);
  }
}

export function assertGitDiffEvidencePair(request, response) {
  assertGitDiffEvidenceRequest(request, "Git diff request");
  assertGitDiffEvidenceResponse(response, "Git diff response");
  for (const field of ["repositoryKey", "commitObjectId", "parentObjectId", "path", "revision"]) {
    if (request[field] !== response[field]) {
      throw invalidFrame(`Git diff response changed ${field}`);
    }
  }
  return true;
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
  const fields = [
    "snapshot",
    "scoringTerms",
    "results",
    "evidencePaths",
    "diagnostic",
    "searchTrace",
  ];
  const agentFields = ["orderBy", "totalMatchCount", "closureEvaluatedAt", "quiescenceSeconds"];
  const hasAgentFields = agentFields.some((field) => Object.hasOwn(message, field));
  if (hasAgentFields) fields.push(...agentFields);
  if (Object.hasOwn(message, "databaseUuid")) fields.push("databaseUuid");
  assertEnvelope(message, "TURN_SEARCH_RESULTS", fields);
  if (Object.hasOwn(message, "databaseUuid")) {
    assertUuid(message.databaseUuid, "TURN_SEARCH_RESULTS.databaseUuid");
  }
  if (hasAgentFields) {
    assertEnum(message.orderBy, "TURN_SEARCH_RESULTS.orderBy", SEARCH_ORDER);
    assertDecimal(message.totalMatchCount, "TURN_SEARCH_RESULTS.totalMatchCount");
    requiredTimestamp(message.closureEvaluatedAt, "TURN_SEARCH_RESULTS.closureEvaluatedAt");
    assertSafeInteger(message.quiescenceSeconds, "TURN_SEARCH_RESULTS.quiescenceSeconds", {
      min: 60, max: 86_400,
    });
  }
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
    if (hasAgentFields && message.results[index].observedTimestamp === null) {
      throw invalidFrame("TURN_SEARCH_RESULTS Agent results require observedTimestamp");
    }
    if (hasAgentFields && message.orderBy === "observed-desc" &&
        message.results[index].score !== null) {
      throw invalidFrame("TURN_SEARCH_RESULTS observed-desc results must not carry a score");
    }
  }
  if (hasAgentFields && BigInt(message.totalMatchCount) < BigInt(message.results.length)) {
    throw invalidFrame("TURN_SEARCH_RESULTS.totalMatchCount is inconsistent");
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
  assertHex64(message.expectedRevision, "READ_TURN_EVIDENCE.expectedRevision");
  assertOpaqueCursor(message.cursor, "READ_TURN_EVIDENCE.cursor");
  assertSafeInteger(message.limit, "READ_TURN_EVIDENCE.limit", {
    min: 1,
    max: MAX_EVIDENCE_PAGE_ENTRIES,
  });
}

function assertUsageWindow(value, label) {
  assertExactKeys(value, label, ["observedAtOrAfterUnixMs", "observedBeforeUnixMs"]);
  assertDecimal(value.observedAtOrAfterUnixMs, `${label}.observedAtOrAfterUnixMs`);
  assertDecimal(value.observedBeforeUnixMs, `${label}.observedBeforeUnixMs`);
  if (BigInt(value.observedAtOrAfterUnixMs) >= BigInt(value.observedBeforeUnixMs)) {
    throw invalidFrame(`${label} must be a non-empty half-open window`);
  }
}

function assertAggregateFilters(value, label, { terminalStates = false } = {}) {
  const fields = ["providers", "projectKeys", "closureStates"];
  if (terminalStates) fields.push("capabilityTerminalStates");
  assertExactKeys(value, label, fields);
  assertBoundedSortedArray(value.providers, `${label}.providers`, MAX_FILTER_PROVIDERS,
    (provider, itemLabel) => assertBoundedString(provider, itemLabel, 64, {
      allowEmpty: false,
      ascii: true,
    }));
  assertBoundedSortedArray(value.projectKeys, `${label}.projectKeys`, MAX_FILTER_KEYS, assertHex64);
  assertBoundedSortedArray(value.closureStates, `${label}.closureStates`, 3,
    (state, itemLabel) => assertEnum(state, itemLabel, SEARCH_CLOSURE_STATES));
  if (terminalStates) {
    assertBoundedSortedArray(
      value.capabilityTerminalStates,
      `${label}.capabilityTerminalStates`,
      5,
      (state, itemLabel) => assertEnum(state, itemLabel, CAPABILITY_TERMINAL_STATES),
    );
  }
}

function assertReadCapabilityUsage(message) {
  assertEnvelope(message, "READ_CAPABILITY_USAGE", [
    "kind", "window", "comparisonWindow", "filters", "orderBy", "cursor", "limit",
    "nowUnixMs", "quiescenceSeconds",
  ]);
  assertEnum(message.kind, "READ_CAPABILITY_USAGE.kind", new Set(["tool", "skill"]));
  assertUsageWindow(message.window, "READ_CAPABILITY_USAGE.window");
  if (message.comparisonWindow !== null) {
    assertUsageWindow(message.comparisonWindow, "READ_CAPABILITY_USAGE.comparisonWindow");
  }
  assertAggregateFilters(message.filters, "READ_CAPABILITY_USAGE.filters", {
    terminalStates: true,
  });
  assertEnum(message.orderBy, "READ_CAPABILITY_USAGE.orderBy", USAGE_ORDER);
  if (message.orderBy === "absolute-recorded-invocation-change" &&
      message.comparisonWindow === null) {
    throw invalidFrame("READ_CAPABILITY_USAGE comparisonWindow is required for absolute change");
  }
  assertOpaqueCursor(message.cursor, "READ_CAPABILITY_USAGE.cursor");
  assertSafeInteger(message.limit, "READ_CAPABILITY_USAGE.limit", { min: 1, max: 50 });
  assertDecimal(message.nowUnixMs, "READ_CAPABILITY_USAGE.nowUnixMs");
  assertSafeInteger(message.quiescenceSeconds, "READ_CAPABILITY_USAGE.quiescenceSeconds", {
    min: 60,
    max: 86_400,
  });
}

function requiredTimestamp(value, label) {
  if (value === null) throw invalidFrame(`${label} is required`);
  assertCanonicalTimestamp(value, label);
  return Date.parse(value);
}

function assertReadInsightsActivity(message) {
  assertEnvelope(message, "READ_INSIGHTS_ACTIVITY", [
    "window", "filters", "bucket", "timeZone", "nowUnixMs", "quiescenceSeconds",
  ]);
  assertExactKeys(message.window, "READ_INSIGHTS_ACTIVITY.window", [
    "observedAtOrAfter", "observedBefore",
  ]);
  const after = requiredTimestamp(
    message.window.observedAtOrAfter,
    "READ_INSIGHTS_ACTIVITY.window.observedAtOrAfter",
  );
  const before = requiredTimestamp(
    message.window.observedBefore,
    "READ_INSIGHTS_ACTIVITY.window.observedBefore",
  );
  assertAggregateFilters(message.filters, "READ_INSIGHTS_ACTIVITY.filters");
  assertEnum(message.bucket, "READ_INSIGHTS_ACTIVITY.bucket", ACTIVITY_BUCKETS);
  if (message.timeZone !== "UTC") throw invalidFrame("READ_INSIGHTS_ACTIVITY.timeZone must be UTC");
  const bucketMs = message.bucket === "day" ? 86_400_000 : 7 * 86_400_000;
  const afterDate = new Date(after);
  const beforeDate = new Date(before);
  const alignedDay = (date) => date.getUTCHours() === 0 && date.getUTCMinutes() === 0 &&
    date.getUTCSeconds() === 0 && date.getUTCMilliseconds() === 0;
  const alignedWeek = (date) => message.bucket !== "week" || date.getUTCDay() === 1;
  const bucketCount = (before - after) / bucketMs;
  if (!alignedDay(afterDate) || !alignedDay(beforeDate) ||
      !alignedWeek(afterDate) || !alignedWeek(beforeDate) ||
      !Number.isSafeInteger(bucketCount) || bucketCount < 1 || bucketCount > 366) {
    throw invalidFrame("READ_INSIGHTS_ACTIVITY.window must contain 1..=366 complete UTC buckets");
  }
  assertDecimal(message.nowUnixMs, "READ_INSIGHTS_ACTIVITY.nowUnixMs");
  assertSafeInteger(message.quiescenceSeconds, "READ_INSIGHTS_ACTIVITY.quiescenceSeconds", {
    min: 60,
    max: 86_400,
  });
}

function assertSignedDecimal(value, label) {
  if (typeof value !== "string" || !/^-?(?:0|[1-9][0-9]*)$/u.test(value) || value === "-0") {
    throw invalidFrame(`${label} must be a canonical signed decimal string`);
  }
  const number = BigInt(value);
  if (number < -U64_MAX || number > U64_MAX) {
    throw invalidFrame(`${label} is outside the supported signed count range`);
  }
}

function assertQueryCoverage(value, label, { fullyExcluded = false } = {}) {
  const fields = [
    "excludedUndatedInvocationCount",
    "excludedUndatedTurnCount",
    "excludedUnrevisionedInvocationCount",
    "excludedUnrevisionedTurnCount",
  ];
  if (fullyExcluded) fields.push("fullyExcludedCapabilityCount");
  assertDecimalObject(value, label, fields);
}

function assertDedupeSupport(value, label, { methods = false } = {}) {
  const fields = [
    "distinctDedupeGroupCount",
    "strongDedupeGroupCount",
    "weakDedupeGroupCount",
    "observedEofProvisionalGroupCount",
    "unknownDedupeSessionCount",
  ];
  if (methods) fields.push("sessionDuplicateMethodCounts");
  assertExactKeys(value, label, fields);
  for (const field of fields.slice(0, 5)) assertDecimal(value[field], `${label}.${field}`);
  const groups = BigInt(value.distinctDedupeGroupCount);
  if (BigInt(value.strongDedupeGroupCount) + BigInt(value.weakDedupeGroupCount) !== groups ||
      BigInt(value.observedEofProvisionalGroupCount) > groups) {
    throw invalidFrame(`${label} dedupe group counts are inconsistent`);
  }
  if (methods) {
    assertDecimalObject(value.sessionDuplicateMethodCounts, `${label}.sessionDuplicateMethodCounts`, [
      "explicitLineage", "exactFirstTurnPrefix",
    ]);
  }
}

function assertUsageItem(item, label) {
  assertExactKeys(item, label, [
    "capabilityKey", "provider", "kind", "canonicalName",
    "recordedInvocationCount", "recordedFailingInvocationCount", "distinctTurnCount",
    "distinctSessionCount", "lastUsedAt", "invocationTerminalCounts",
    "containingTurnOutcomeCounts", "groupedInvocationCount", "ungroupedInvocationCount",
    "support", "strengthCounts", "outOfWindow", "comparison",
  ]);
  assertHex64(item.capabilityKey, `${label}.capabilityKey`);
  assertBoundedString(item.provider, `${label}.provider`, 128, {
    allowEmpty: false, ascii: true,
  });
  assertEnum(item.kind, `${label}.kind`, new Set(["tool", "skill"]));
  assertBoundedString(item.canonicalName, `${label}.canonicalName`, 512, { allowEmpty: false });
  for (const field of [
    "recordedInvocationCount", "recordedFailingInvocationCount", "distinctTurnCount",
    "distinctSessionCount", "groupedInvocationCount", "ungroupedInvocationCount",
  ]) assertDecimal(item[field], `${label}.${field}`);
  if (item.lastUsedAt !== null) requiredTimestamp(item.lastUsedAt, `${label}.lastUsedAt`);

  assertDecimalObject(item.invocationTerminalCounts, `${label}.invocationTerminalCounts`, [
    "invocationTotal", "pending", "completed", "failed", "cancelled", "unknown",
  ]);
  assertDecimalObject(item.containingTurnOutcomeCounts, `${label}.containingTurnOutcomeCounts`, [
    "distinctTurnTotal", "providerCompleted", "abandoned", "unknown",
  ]);
  assertDedupeSupport(item.support, `${label}.support`, { methods: true });
  assertDecimalObject(item.strengthCounts, `${label}.strengthCounts`, [
    "observed", "confirmed", "inferred",
  ]);

  const invocations = BigInt(item.recordedInvocationCount);
  const turns = BigInt(item.distinctTurnCount);
  const sessions = BigInt(item.distinctSessionCount);
  const terminal = item.invocationTerminalCounts;
  const outcomes = item.containingTurnOutcomeCounts;
  const support = item.support;
  if (BigInt(item.recordedFailingInvocationCount) > invocations ||
      turns > invocations || sessions > turns ||
      BigInt(item.groupedInvocationCount) + BigInt(item.ungroupedInvocationCount) !== invocations ||
      BigInt(terminal.invocationTotal) !== invocations ||
      decimalSum(terminal, ["pending", "completed", "failed", "cancelled", "unknown"]) !== invocations ||
      BigInt(outcomes.distinctTurnTotal) !== turns ||
      decimalSum(outcomes, ["providerCompleted", "abandoned", "unknown"]) !== turns ||
      decimalSum(item.strengthCounts, ["observed", "confirmed", "inferred"]) !== invocations ||
      BigInt(support.distinctDedupeGroupCount) > sessions ||
      BigInt(support.unknownDedupeSessionCount) > sessions ||
      decimalSum(support.sessionDuplicateMethodCounts, ["explicitLineage", "exactFirstTurnPrefix"]) > sessions) {
    throw invalidFrame(`${label} aggregate counts are inconsistent`);
  }

  assertExactKeys(item.outOfWindow, `${label}.outOfWindow`, ["scope", "retrySummary"]);
  if (item.outOfWindow.scope !== "all-indexed-history") {
    throw invalidFrame(`${label}.outOfWindow.scope is invalid`);
  }
  if (item.outOfWindow.retrySummary !== null) {
    assertDecimalObject(item.outOfWindow.retrySummary, `${label}.outOfWindow.retrySummary`, [
      "failedCount", "sameInputRepeatCount", "retryAfterFailureCount",
    ]);
  }
  if (item.comparison !== null) {
    assertExactKeys(item.comparison, `${label}.comparison`, [
      "baselineRecordedInvocationCount", "currentRecordedInvocationCount",
      "absoluteRecordedInvocationChange",
    ]);
    assertDecimal(
      item.comparison.baselineRecordedInvocationCount,
      `${label}.comparison.baselineRecordedInvocationCount`,
    );
    assertDecimal(
      item.comparison.currentRecordedInvocationCount,
      `${label}.comparison.currentRecordedInvocationCount`,
    );
    assertSignedDecimal(
      item.comparison.absoluteRecordedInvocationChange,
      `${label}.comparison.absoluteRecordedInvocationChange`,
    );
    if (BigInt(item.comparison.currentRecordedInvocationCount) !== invocations ||
        BigInt(item.comparison.currentRecordedInvocationCount) -
          BigInt(item.comparison.baselineRecordedInvocationCount) !==
          BigInt(item.comparison.absoluteRecordedInvocationChange)) {
      throw invalidFrame(`${label}.comparison is inconsistent`);
    }
  }
}

function assertCapabilityUsage(message) {
  assertEnvelope(message, "CAPABILITY_USAGE", [
    "databaseUuid", "snapshotSeq", "closureEvaluatedAt", "quiescenceSeconds", "orderBy",
    "items", "totalCandidateCount", "truncated", "coverage", "nextCursor",
  ]);
  assertUuid(message.databaseUuid, "CAPABILITY_USAGE.databaseUuid");
  assertDecimal(message.snapshotSeq, "CAPABILITY_USAGE.snapshotSeq");
  requiredTimestamp(message.closureEvaluatedAt, "CAPABILITY_USAGE.closureEvaluatedAt");
  assertSafeInteger(message.quiescenceSeconds, "CAPABILITY_USAGE.quiescenceSeconds", {
    min: 60, max: 86_400,
  });
  assertEnum(message.orderBy, "CAPABILITY_USAGE.orderBy", USAGE_ORDER);
  if (!Array.isArray(message.items) || message.items.length > MAX_USAGE_ITEMS) {
    throw invalidFrame("CAPABILITY_USAGE.items exceeds its bounded limit");
  }
  for (let index = 0; index < message.items.length; index += 1) {
    assertUsageItem(message.items[index], `CAPABILITY_USAGE.items[${index}]`);
  }
  assertDecimal(message.totalCandidateCount, "CAPABILITY_USAGE.totalCandidateCount");
  if (BigInt(message.totalCandidateCount) < BigInt(message.items.length)) {
    throw invalidFrame("CAPABILITY_USAGE.totalCandidateCount is inconsistent");
  }
  assertBoolean(message.truncated, "CAPABILITY_USAGE.truncated");
  assertOpaqueCursor(message.nextCursor, "CAPABILITY_USAGE.nextCursor");
  if (message.truncated !== (message.nextCursor !== null)) {
    throw invalidFrame("CAPABILITY_USAGE cursor and truncation state are inconsistent");
  }
  assertQueryCoverage(message.coverage, "CAPABILITY_USAGE.coverage", { fullyExcluded: true });
  assertMessagePayloadBound(message, "CAPABILITY_USAGE");
}

function assertActivityBucket(row, label, previousEnd) {
  assertExactKeys(row, label, [
    "bucketStart", "bucketEnd", "distinctSessionCount", "distinctTurnCount",
    "currentClosureCounts", "turnResultEvidenceCounts", "recordedToolInvocationCount",
    "recordedSkillInvocationCount", "support",
  ]);
  const start = requiredTimestamp(row.bucketStart, `${label}.bucketStart`);
  const end = requiredTimestamp(row.bucketEnd, `${label}.bucketEnd`);
  if (start >= end || (previousEnd !== null && start !== previousEnd)) {
    throw invalidFrame(`${label} bucket boundaries are inconsistent`);
  }
  const duration = end - start;
  if (duration !== 86_400_000 && duration !== 7 * 86_400_000) {
    throw invalidFrame(`${label} must be one complete UTC day or week`);
  }
  for (const field of [
    "distinctSessionCount", "distinctTurnCount", "recordedToolInvocationCount",
    "recordedSkillInvocationCount",
  ]) assertDecimal(row[field], `${label}.${field}`);
  assertDecimalObject(row.currentClosureCounts, `${label}.currentClosureCounts`, [
    "hardSealed", "quiescent", "open",
  ]);
  assertDecimalObject(row.turnResultEvidenceCounts, `${label}.turnResultEvidenceCounts`, [
    "providerCompleted", "abandoned", "unknown",
  ]);
  assertDedupeSupport(row.support, `${label}.support`);
  const turns = BigInt(row.distinctTurnCount);
  const sessions = BigInt(row.distinctSessionCount);
  if (sessions > turns ||
      decimalSum(row.currentClosureCounts, ["hardSealed", "quiescent", "open"]) !== turns ||
      decimalSum(row.turnResultEvidenceCounts, ["providerCompleted", "abandoned", "unknown"]) !== turns ||
      BigInt(row.support.distinctDedupeGroupCount) > sessions ||
      BigInt(row.support.unknownDedupeSessionCount) > sessions) {
    throw invalidFrame(`${label} aggregate counts are inconsistent`);
  }
  return { end, duration };
}

function assertInsightsActivity(message) {
  assertEnvelope(message, "INSIGHTS_ACTIVITY", [
    "databaseUuid", "snapshotSeq", "closureEvaluatedAt", "quiescenceSeconds", "buckets",
    "coverage",
  ]);
  assertUuid(message.databaseUuid, "INSIGHTS_ACTIVITY.databaseUuid");
  assertDecimal(message.snapshotSeq, "INSIGHTS_ACTIVITY.snapshotSeq");
  requiredTimestamp(message.closureEvaluatedAt, "INSIGHTS_ACTIVITY.closureEvaluatedAt");
  assertSafeInteger(message.quiescenceSeconds, "INSIGHTS_ACTIVITY.quiescenceSeconds", {
    min: 60, max: 86_400,
  });
  if (!Array.isArray(message.buckets) || message.buckets.length < 1 ||
      message.buckets.length > MAX_ACTIVITY_BUCKETS) {
    throw invalidFrame("INSIGHTS_ACTIVITY.buckets must contain 1..=366 rows");
  }
  let previousEnd = null;
  let duration = null;
  for (let index = 0; index < message.buckets.length; index += 1) {
    const validated = assertActivityBucket(
      message.buckets[index], `INSIGHTS_ACTIVITY.buckets[${index}]`, previousEnd,
    );
    if (duration !== null && validated.duration !== duration) {
      throw invalidFrame("INSIGHTS_ACTIVITY bucket durations must be consistent");
    }
    previousEnd = validated.end;
    duration = validated.duration;
  }
  assertQueryCoverage(message.coverage, "INSIGHTS_ACTIVITY.coverage");
  assertMessagePayloadBound(message, "INSIGHTS_ACTIVITY");
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
  const fields = [
    "snapshotSeq", "turn", "entries", "nextCursor",
  ];
  if (Object.hasOwn(message, "databaseUuid")) fields.push("databaseUuid");
  assertEnvelope(message, "TURN_EVIDENCE_PAGE", fields);
  if (Object.hasOwn(message, "databaseUuid")) {
    assertUuid(message.databaseUuid, "TURN_EVIDENCE_PAGE.databaseUuid");
  }
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
function validateProtocolMessage(message, validatedPayloadByteLength = null) {
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
    assertBatch(message, "UPSERT_FACTS", ALL_UPSERT_COLLECTIONS);
  } else if (message.type === "BATCH_ACCEPTED") assertBatchAccepted(message);
  else if (message.type === "COMMIT_SESSION") assertCommitSession(message);
  else if (message.type === "SESSION_COMMITTED") assertSessionCommitted(message);
  else if (message.type === "BEGIN_TRACE_SOURCE") assertBeginTraceSource(message);
  else if (message.type === "TRACE_SOURCE_ACCEPTED") {
    assertTraceSourceIdentity(message, "TRACE_SOURCE_ACCEPTED", "nextSequence");
  }
  else if (message.type === "TRACE_SOURCE_BATCH") assertTraceSourceBatch(message);
  else if (message.type === "TRACE_SOURCE_BATCH_ACCEPTED") assertTraceSourceBatchAccepted(message);
  else if (message.type === "COMMIT_TRACE_SOURCE") {
    assertTraceSourceTerminalRequest(message, "COMMIT_TRACE_SOURCE");
  }
  else if (message.type === "TRACE_SOURCE_COMMITTED") assertTraceSourceCommitted(message);
  else if (message.type === "READ_REPOSITORY_STATE") assertReadRepositoryState(message);
  else if (message.type === "REPOSITORY_STATE") assertRepositoryState(message);
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
  else if (message.type === "READ_CAPABILITY_USAGE") assertReadCapabilityUsage(message);
  else if (message.type === "CAPABILITY_USAGE") assertCapabilityUsage(message);
  else if (message.type === "READ_INSIGHTS_ACTIVITY") assertReadInsightsActivity(message);
  else if (message.type === "INSIGHTS_ACTIVITY") assertInsightsActivity(message);
  else if (message.type === "READ_TURN_EVIDENCE") assertReadTurnEvidence(message);
  else if (message.type === "TURN_EVIDENCE_PAGE") assertTurnEvidencePage(message);
  else if (message.type === "READ_INSIGHTS_QUERY_V2") assertReadInsightsQueryV2(message);
  else if (message.type === "INSIGHTS_QUERY_V2") assertInsightsQueryV2(message);
  else if (message.type === "READ_INSIGHTS_EVIDENCE_V2") assertReadInsightsEvidenceV2(message);
  else if (message.type === "INSIGHTS_EVIDENCE_V2") {
    assertInsightsEvidenceV2(message, validatedPayloadByteLength);
  }
  else if (message.type === "READ_INSIGHTS_RECIPE") assertReadInsightsRecipe(message);
  else if (message.type === "INSIGHTS_RECIPE") assertInsightsRecipe(message);
  else if (message.type === "READ_INSIGHTS_DELIVERY_TRACE") assertReadInsightsDeliveryTrace(message);
  else if (message.type === "INSIGHTS_DELIVERY_TRACE") assertInsightsDeliveryTrace(message);
  else if (message.type === "MEMORY_COMMAND") assertMemoryCommand(message);
  else if (message.type === "MEMORY_RESULT") assertMemoryResult(message);
  else if (message.type === "ABORT_SESSION") assertAbortSession(message);
  else if (message.type === "SESSION_ABORTED") assertSessionAborted(message);
  else if (message.type === "ABORT_TRACE_SOURCE") {
    assertTraceSourceTerminalRequest(message, "ABORT_TRACE_SOURCE");
  }
  else if (message.type === "TRACE_SOURCE_ABORTED") {
    assertTraceSourceIdentity(message, "TRACE_SOURCE_ABORTED", "nextSequence");
  }
  else if (message.type === "ERROR") assertErrorMessage(message);
  return message;
}

/** Strictly validates a protocol-v1 envelope and all protocol-owned nested fields. */
export function assertProtocolMessage(message) {
  return validateProtocolMessage(message);
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
  databaseUuid,
  databaseFactSchemaVersion,
}) {
  const fields = {
    engineVersion,
    target,
    maxFrameBytes: MAX_PROTOCOL_PAYLOAD_BYTES,
    sqliteVersion,
    sqliteCompileOptionsDigest,
    buildManifestDigest,
    acceptedContract: canonicalHandshakeContract(acceptedContract),
  };
  if (acceptedContract.factSchemaVersion === 2) {
    fields.databaseUuid = databaseUuid;
    fields.databaseFactSchemaVersion = databaseFactSchemaVersion;
  }
  return assertProtocolMessage(
    envelope("READY", requestId, fields),
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
  for (const collection of upsertCollectionsForDeltaFormat(delta.format)) {
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
  assertPlainObject(delta, "SessionFactsDelta");
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

function traceSourceCollections(delta) {
  assertPlainObject(delta, "TraceSourceDeltaV1");
  const refs = assertArray(delta.refs, "delta.refs");
  const commits = assertArray(delta.commits, "delta.commits").map((commit) => {
    assertPlainObject(commit, "delta.commits[]");
    const { files: _files, ...record } = commit;
    return record;
  });
  const files = [];
  for (const commit of delta.commits) {
    for (const file of assertArray(commit.files, "delta.commits[].files")) {
      files.push({ objectId: commit.objectId, ...file });
    }
  }
  const intentNodes = assertArray(delta.intentNodes, "delta.intentNodes");
  const intentRefs = assertArray(delta.intentRefs, "delta.intentRefs");
  return { refs, commits, files, intentNodes, intentRefs };
}

export function traceSourceDigestDocument(delta) {
  const collections = traceSourceCollections(delta);
  return {
    commits: collections.commits,
    deltaFormat: delta.format,
    expectedGeneration: delta.expectedGeneration,
    files: collections.files,
    intent: delta.intent,
    intentNodes: collections.intentNodes,
    intentRefs: collections.intentRefs,
    refs: collections.refs,
    repository: delta.repository,
    targetGeneration: delta.targetGeneration,
  };
}

export function createBeginTraceSourceMessage(delta, { requestId }) {
  const collections = traceSourceCollections(delta);
  return assertProtocolMessage(envelope("BEGIN_TRACE_SOURCE", requestId, {
    deltaFormat: delta.format,
    deltaId: delta.deltaId,
    expectedGeneration: delta.expectedGeneration,
    targetGeneration: delta.targetGeneration,
    repository: delta.repository,
    intent: delta.intent,
    counts: Object.fromEntries(TRACE_SOURCE_COLLECTION_ORDER.map((collection) => [
      collection,
      String(collections[collection].length),
    ])),
  }));
}

export function createTraceSourceBatchMessage(options) {
  return createBatchMessage("TRACE_SOURCE_BATCH", options);
}

export function createCommitTraceSourceMessage({ requestId, nextSequence }) {
  return assertProtocolMessage(envelope("COMMIT_TRACE_SOURCE", requestId, { nextSequence }));
}

export function createAbortTraceSourceMessage({ requestId, nextSequence }) {
  return assertProtocolMessage(envelope("ABORT_TRACE_SOURCE", requestId, { nextSequence }));
}

export function createReadRepositoryStateMessage({
  requestId,
  repositoryId,
  cursor = null,
  limit = 256,
}) {
  return assertProtocolMessage(envelope("READ_REPOSITORY_STATE", requestId, {
    repositoryId,
    cursor,
    limit,
  }));
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
  const source = {
    ...filters,
    capabilityTerminalStates: filters.capabilityTerminalStates ?? [],
  };
  assertExactKeys(source, "filters", [
    "providers",
    "projectKeys",
    "observedAtOrAfterUnixMs",
    "observedBeforeUnixMs",
    "toolCapabilityKeys",
    "skillCapabilityKeys",
    "resultEvidence",
    "closureStates",
    "capabilityTerminalStates",
  ]);
  const result = {
    providers: canonicalBoundedArray(source.providers, "filters.providers", MAX_FILTER_PROVIDERS,
      (value, label) => assertBoundedString(value, label, 64, {
        allowEmpty: false,
        ascii: true,
      })),
    projectKeys: canonicalBoundedArray(
      source.projectKeys,
      "filters.projectKeys",
      MAX_FILTER_KEYS,
      assertHex64,
    ),
    observedAtOrAfterUnixMs: source.observedAtOrAfterUnixMs,
    observedBeforeUnixMs: source.observedBeforeUnixMs,
    toolCapabilityKeys: canonicalBoundedArray(
      source.toolCapabilityKeys,
      "filters.toolCapabilityKeys",
      MAX_FILTER_KEYS,
      assertHex64,
    ),
    skillCapabilityKeys: canonicalBoundedArray(
      source.skillCapabilityKeys,
      "filters.skillCapabilityKeys",
      MAX_FILTER_KEYS,
      assertHex64,
    ),
    resultEvidence: canonicalBoundedArray(
      source.resultEvidence,
      "filters.resultEvidence",
      3,
      (value, label) => assertEnum(value, label, SEARCH_RESULT_EVIDENCE),
    ),
    closureStates: canonicalBoundedArray(
      source.closureStates,
      "filters.closureStates",
      3,
      (value, label) => assertEnum(value, label, SEARCH_CLOSURE_STATES),
    ),
    capabilityTerminalStates: canonicalBoundedArray(
      source.capabilityTerminalStates,
      "filters.capabilityTerminalStates",
      5,
      (value, label) => assertEnum(value, label, CAPABILITY_TERMINAL_STATES),
    ),
  };
  assertSearchFilters(result, "filters");
  return result;
}

export function createSearchTurnsMessage({
  requestId,
  query,
  filters,
  orderBy = query.length > 0 ? "relevance" : "observed-desc",
  limit = 50,
  pathLimit = 10,
  nowUnixMs,
  quiescenceSeconds = 300,
}) {
  const message = assertProtocolMessage(envelope("SEARCH_TURNS", requestId, {
    query,
    filters: canonicalSearchFilters(filters),
    orderBy,
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
  databaseUuid,
  snapshot,
  orderBy,
  totalMatchCount,
  closureEvaluatedAt,
  quiescenceSeconds,
  scoringTerms,
  results,
  evidencePaths,
  diagnostic,
  searchTrace,
}) {
  const response = {
    snapshot,
    scoringTerms,
    results,
    evidencePaths,
    diagnostic,
    searchTrace,
  };
  if (databaseUuid !== undefined) response.databaseUuid = databaseUuid;
  if ([orderBy, totalMatchCount, closureEvaluatedAt, quiescenceSeconds]
    .some((value) => value !== undefined)) {
    response.orderBy = orderBy;
    response.totalMatchCount = totalMatchCount;
    response.closureEvaluatedAt = closureEvaluatedAt;
    response.quiescenceSeconds = quiescenceSeconds;
  }
  return assertProtocolMessage(envelope("TURN_SEARCH_RESULTS", requestId, response));
}

function canonicalAggregateFilters(filters, { terminalStates = false } = {}) {
  assertPlainObject(filters, "filters");
  const source = terminalStates
    ? { ...filters, capabilityTerminalStates: filters.capabilityTerminalStates ?? [] }
    : filters;
  const fields = ["providers", "projectKeys", "closureStates"];
  if (terminalStates) fields.push("capabilityTerminalStates");
  assertExactKeys(source, "filters", fields);
  const result = {
    providers: canonicalBoundedArray(source.providers, "filters.providers", MAX_FILTER_PROVIDERS,
      (provider, label) => assertBoundedString(provider, label, 64, {
        allowEmpty: false,
        ascii: true,
      })),
    projectKeys: canonicalBoundedArray(
      source.projectKeys,
      "filters.projectKeys",
      MAX_FILTER_KEYS,
      assertHex64,
    ),
    closureStates: canonicalBoundedArray(
      source.closureStates,
      "filters.closureStates",
      3,
      (state, label) => assertEnum(state, label, SEARCH_CLOSURE_STATES),
    ),
  };
  if (terminalStates) {
    result.capabilityTerminalStates = canonicalBoundedArray(
      source.capabilityTerminalStates,
      "filters.capabilityTerminalStates",
      5,
      (state, label) => assertEnum(state, label, CAPABILITY_TERMINAL_STATES),
    );
  }
  assertAggregateFilters(result, "filters", { terminalStates });
  return result;
}

export function createReadCapabilityUsageMessage({
  requestId,
  kind,
  window,
  comparisonWindow = null,
  filters,
  orderBy,
  cursor = null,
  limit = 50,
  nowUnixMs,
  quiescenceSeconds = 300,
}) {
  return assertProtocolMessage(envelope("READ_CAPABILITY_USAGE", requestId, {
    kind,
    window,
    comparisonWindow,
    filters: canonicalAggregateFilters(filters, { terminalStates: true }),
    orderBy,
    cursor,
    limit,
    nowUnixMs,
    quiescenceSeconds,
  }));
}

export function createCapabilityUsageMessage({ requestId, usage }) {
  assertPlainObject(usage, "usage");
  return assertProtocolMessage(envelope("CAPABILITY_USAGE", requestId, { ...usage }));
}

export function createReadInsightsActivityMessage({
  requestId,
  window,
  filters,
  bucket,
  timeZone = "UTC",
  nowUnixMs,
  quiescenceSeconds = 300,
}) {
  return assertProtocolMessage(envelope("READ_INSIGHTS_ACTIVITY", requestId, {
    window,
    filters: canonicalAggregateFilters(filters),
    bucket,
    timeZone,
    nowUnixMs,
    quiescenceSeconds,
  }));
}

export function createInsightsActivityMessage({ requestId, activity }) {
  assertPlainObject(activity, "activity");
  return assertProtocolMessage(envelope("INSIGHTS_ACTIVITY", requestId, { ...activity }));
}

export function createReadTurnEvidenceMessage({
  requestId,
  turnKey,
  expectedRevision,
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

export function createReadInsightsQueryV2Message({ requestId, request }) {
  return assertProtocolMessage(envelope("READ_INSIGHTS_QUERY_V2", requestId, { request }));
}

export function createInsightsQueryV2Message({ requestId, response }) {
  return assertProtocolMessage(envelope("INSIGHTS_QUERY_V2", requestId, { response }));
}

export function createReadInsightsEvidenceV2Message({ requestId, request }) {
  return assertProtocolMessage(envelope("READ_INSIGHTS_EVIDENCE_V2", requestId, { request }));
}

export function createInsightsEvidenceV2Message({ requestId, response }) {
  return assertProtocolMessage(envelope("INSIGHTS_EVIDENCE_V2", requestId, { response }));
}

export function createReadInsightsRecipeMessage({ requestId, request }) {
  return assertProtocolMessage(envelope("READ_INSIGHTS_RECIPE", requestId, { request }));
}

export function createInsightsRecipeMessage({ requestId, response }) {
  return assertProtocolMessage(envelope("INSIGHTS_RECIPE", requestId, { response }));
}

export function createReadInsightsDeliveryTraceMessage({ requestId, request }) {
  return assertProtocolMessage(envelope("READ_INSIGHTS_DELIVERY_TRACE", requestId, { request }));
}

export function createInsightsDeliveryTraceMessage({ requestId, request, response }) {
  return assertProtocolMessage(envelope("INSIGHTS_DELIVERY_TRACE", requestId, { request, response }));
}

export function createMemoryCommandMessage({ requestId, op, payload }) {
  return assertProtocolMessage(envelope("MEMORY_COMMAND", requestId, { op, payload }));
}

export function createMemoryResultMessage({ requestId, op, payload }) {
  return assertProtocolMessage(envelope("MEMORY_RESULT", requestId, { op, payload }));
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
  return validateProtocolMessage(message, payload.byteLength);
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
    ...upsertCollectionsForDeltaFormat(delta.format).map((collection) => ({
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

/** Lazily emits BEGIN, fixed-order greedy batches, and COMMIT for one trace source delta. */
export async function* createTraceSourceDeltaMessages(
  delta,
  { requestId, maxPayloadBytes = MAX_PROTOCOL_PAYLOAD_BYTES },
) {
  assertMaxPayloadBytes(maxPayloadBytes);
  const begin = createBeginTraceSourceMessage(delta, { requestId });
  assertFits(begin, maxPayloadBytes);
  yield begin;

  const collections = traceSourceCollections(delta);
  let sequence = 0n;
  for (const collection of TRACE_SOURCE_COLLECTION_ORDER) {
    let batch = [];
    let batchBytes = 0;
    for (const item of collections[collection]) {
      const sequenceText = sequence.toString();
      if (batch.length === 0) {
        batchBytes = Buffer.byteLength(canonicalJson(envelope("TRACE_SOURCE_BATCH", requestId, {
          sequence: sequenceText,
          collection,
          items: [],
        })), "utf8");
      }
      const itemBytes = itemCanonicalByteLength(item, collection);
      if (batch.length > 0 && batchBytes + itemBytes + 1 > maxPayloadBytes) {
        const message = createTraceSourceBatchMessage({
          requestId,
          sequence: sequenceText,
          collection,
          items: batch,
        });
        assertFits(message, maxPayloadBytes);
        yield message;
        sequence += 1n;
        batch = [];
        batchBytes = Buffer.byteLength(canonicalJson(envelope("TRACE_SOURCE_BATCH", requestId, {
          sequence: sequence.toString(),
          collection,
          items: [],
        })), "utf8");
      }
      const nextBytes = batchBytes + itemBytes + (batch.length === 0 ? 0 : 1);
      if (nextBytes > maxPayloadBytes) {
        throw protocolError(
          "TS_INSIGHTS_PROTOCOL_ITEM_TOO_LARGE",
          `${collection} contains an item that cannot fit in one frame`,
        );
      }
      batch.push(item);
      batchBytes = nextBytes;
    }
    if (batch.length > 0) {
      const message = createTraceSourceBatchMessage({
        requestId,
        sequence: sequence.toString(),
        collection,
        items: batch,
      });
      assertFits(message, maxPayloadBytes);
      yield message;
      sequence += 1n;
    }
  }
  const commit = createCommitTraceSourceMessage({
    requestId,
    nextSequence: sequence.toString(),
  });
  assertFits(commit, maxPayloadBytes);
  yield commit;
}

function collectionRank(message, upsertCollections) {
  if (message.type === "RETRACT_FACTS") {
    return RETRACTION_COLLECTION_ORDER.indexOf(message.collection);
  }
  if (message.type === "UPSERT_FACTS") {
    return RETRACTION_COLLECTION_ORDER.length + upsertCollections.indexOf(message.collection);
  }
  return -1;
}

function countKey(message) {
  return `${message.type}:${message.collection}`;
}

function expectedCountEntries(begin, upsertCollections) {
  return [
    ...RETRACTION_COLLECTION_ORDER.map((collection) => [
      `RETRACT_FACTS:${collection}`,
      BigInt(begin.counts[collection]),
    ]),
    ...upsertCollections.map((collection) => [
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
  #upsertCollections;

  constructor(begin) {
    assertProtocolMessage(begin);
    if (begin.type !== "BEGIN_SESSION") {
      throw protocolError(
        "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
        "session sequence must start with BEGIN_SESSION",
      );
    }
    this.#begin = begin;
    this.#upsertCollections = upsertCollectionsForDeltaFormat(begin.deltaFormat);
    this.#expected = new Map(expectedCountEntries(begin, this.#upsertCollections));
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
      const rank = collectionRank(message, this.#upsertCollections);
      if (rank < 0) {
        throw protocolError(
          "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
          `${message.collection} is not valid for ${this.#begin.deltaFormat}`,
        );
      }
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
