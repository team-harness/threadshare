import { createHash, timingSafeEqual } from "node:crypto";
import { open } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

import { canonicalJson } from "./canonical-json.mjs";
import { cliDiagnostic } from "./cli-contract.mjs";
import { readExistingInsightsConfig } from "./insights-config.mjs";
import {
  assertGitDiffEvidenceRequest,
  createReadInsightsDeliveryTraceMessage,
  createReadInsightsEvidenceV2Message,
  createReadInsightsQueryV2Message,
  createReadInsightsRecipeMessage,
} from "./insights-engine-protocol.mjs";
import { readGitDiffEvidence } from "./insights-git-evidence.mjs";
import { createInsightsQueryReader } from "./insights-query-reader.mjs";
import { resolveGitRepository } from "./insights-repository-source.mjs";
import { openExistingInsightsState } from "./insights-state.mjs";
import { hashKey } from "./session-facts.mjs";

export const INSIGHTS_QUERY_ACTIONS = new Set([
  "overview",
  "search",
  "capabilities",
  "usage",
  "activity",
  "evidence",
  "query",
  "recipe",
]);

const MAX_REQUEST_BYTES = 64 * 1024;
const MAX_QUERY_BYTES = 8 * 1024;
const MAX_PUBLIC_LIMIT = 50;
const MAX_PATH_LIMIT = 20;
const MAX_CURSOR_BYTES = 32 * 1024;
const HEX64 = /^[0-9a-f]{64}$/u;
const DECIMAL = /^(?:0|[1-9][0-9]*)$/u;
const SIGNED_DECIMAL = /^(?:0|-?[1-9][0-9]*)$/u;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u;
const SEARCH_ORDER = new Set(["relevance", "observed-desc"]);
const CAPABILITY_TERMINAL_STATES = new Set([
  "pending", "completed", "failed", "cancelled", "unknown",
]);
const RESULT_EVIDENCE = new Set(["provider-completed", "abandoned", "unknown"]);
const CLOSURE_STATES = new Set(["hard-sealed", "quiescent", "open"]);
const USAGE_ORDER = new Set([
  "recorded-invocation-count",
  "recorded-failing-invocation-count",
  "distinct-turn-count",
  "distinct-session-count",
  "distinct-dedupe-group-count",
  "last-used",
  "absolute-recorded-invocation-change",
]);
const SKILL_LOAD_EVIDENCE_SOURCES = new Set([
  "structured-skill-injection",
  "session-catalog-complete-read",
  "claude-skill-tool-success",
]);
const RECIPE_NAMES = new Set([
  "capability-contexts@1",
  "failure-chains@1",
  "file-workflow-signals@1",
  "activity-shifts@1",
  "token-hotspots@1",
  "solution-recall@1",
  "session-timeline@1",
  "delivery-trace@1",
]);

function queryError(code, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

function requestError(message, cause) {
  return queryError("TS_INSIGHTS_REQUEST_INVALID", message, cause);
}

function deliveryTraceNotReady(message) {
  return queryError("TS_INSIGHTS_DELIVERY_TRACE_NOT_READY", message);
}

function responseError(message) {
  return queryError("TS_INSIGHTS_ENGINE_INVALID", message);
}

function staleCursor() {
  return queryError("TS_INSIGHTS_CURSOR_STALE", "Insights cursor is stale or invalid");
}

function turnChanged() {
  return queryError("TS_INSIGHTS_TURN_CHANGED", "Insights Turn revision changed");
}

function queryAborted(cause) {
  return queryError("TS_INSIGHTS_ENGINE_ABORTED", "Insights query was aborted", cause);
}

function plainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function exactKeys(value, allowed, label) {
  if (!plainObject(value)) throw requestError(`${label} must be an object`);
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw requestError(`${label} contains an unsupported field`);
  }
}

function deepFreeze(value) {
  if (Array.isArray(value)) {
    for (const item of value) deepFreeze(item);
  } else if (plainObject(value)) {
    for (const item of Object.values(value)) deepFreeze(item);
  }
  return value !== null && typeof value === "object" ? Object.freeze(value) : value;
}

function parseLimit(value, fallback = MAX_PUBLIC_LIMIT) {
  if (value === undefined) return fallback;
  const parsed = typeof value === "number" ? value : /^\d+$/u.test(value) ? Number(value) : NaN;
  if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_PUBLIC_LIMIT) {
    throw queryError("TS_USAGE_INVALID_VALUE", `--limit must be an integer from 1 to ${MAX_PUBLIC_LIMIT}`);
  }
  return parsed;
}

function requireJsonFormat(value) {
  if (value === undefined) {
    throw queryError("TS_USAGE_OPTION_DEPENDENCY", "Insights queries require --format json");
  }
  if (value !== "json") {
    throw queryError("TS_USAGE_INVALID_VALUE", "Insights queries only support --format json");
  }
}

function assertAllowedOptions(options, allowed) {
  for (const key of Object.keys(options)) {
    if (!allowed.includes(key)) {
      throw queryError("TS_USAGE_OPTION_NOT_ALLOWED", `--${key} is not valid for this Insights query`);
    }
  }
}

function requireKind(kind) {
  if (kind === undefined) {
    throw queryError("TS_USAGE_MISSING_ARGUMENT", "Capability kind is required");
  }
  if (kind !== "tool" && kind !== "skill") {
    throw queryError("TS_USAGE_INVALID_VALUE", "Capability kind must be tool or skill");
  }
  return kind;
}

function requireHex64(value, label, code = "TS_INSIGHTS_REQUEST_INVALID") {
  if (typeof value !== "string" || !HEX64.test(value)) {
    throw queryError(code, `${label} must be a lowercase 64-character contract ID`);
  }
  return value;
}

function optionalCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > MAX_CURSOR_BYTES) {
    throw queryError("TS_USAGE_INVALID_VALUE", "--cursor must be a bounded non-empty token");
  }
  return value;
}

export function parseInsightsQueryInvocation(positionals, options = {}) {
  const [, action, first, ...extra] = positionals;
  if (!INSIGHTS_QUERY_ACTIONS.has(action)) return null;
  requireJsonFormat(options.format);
  if (extra.length > 0) {
    throw queryError("TS_USAGE_UNEXPECTED_ARGUMENT", "Unexpected Insights query argument");
  }
  if (action === "overview") {
    assertAllowedOptions(options, ["format"]);
    if (first !== undefined) throw queryError("TS_USAGE_UNEXPECTED_ARGUMENT", "overview takes no argument");
    return Object.freeze({ action, format: "json" });
  }
  if (action === "search") {
    assertAllowedOptions(options, ["format", "query", "request", "limit"]);
    if (first !== undefined) throw queryError("TS_USAGE_UNEXPECTED_ARGUMENT", "search takes no positional argument");
    if (options.query !== undefined && options.request !== undefined) {
      throw queryError("TS_USAGE_OPTION_CONFLICT", "--query and --request are mutually exclusive");
    }
    if (options.query === undefined && options.request === undefined) {
      throw queryError("TS_USAGE_OPTION_DEPENDENCY", "search requires --query or --request");
    }
    if (options.query !== undefined) {
      if (typeof options.query !== "string" || options.query.trim() === "") {
        throw queryError("TS_USAGE_INVALID_VALUE", "--query must be non-empty");
      }
      if (Buffer.byteLength(options.query, "utf8") > MAX_QUERY_BYTES) {
        throw queryError("TS_QUERY_TOO_LONG", "Insights query exceeds 8 KiB");
      }
      return Object.freeze({
        action, format: "json", query: options.query,
        requestSource: null, limit: parseLimit(options.limit),
      });
    }
    if (options.limit !== undefined) {
      throw queryError("TS_USAGE_OPTION_NOT_ALLOWED", "--limit with structured search belongs in --request");
    }
    return Object.freeze({ action, format: "json", query: null, requestSource: options.request });
  }
  if (action === "capabilities") {
    assertAllowedOptions(options, ["format", "cursor", "limit"]);
    return Object.freeze({
      action, kind: requireKind(first), format: "json",
      limit: parseLimit(options.limit), cursor: optionalCursor(options.cursor),
    });
  }
  if (action === "usage") {
    assertAllowedOptions(options, ["format", "request"]);
    requireKind(first);
    if (options.request === undefined) {
      throw queryError("TS_USAGE_OPTION_DEPENDENCY", "usage requires --request");
    }
    return Object.freeze({ action, kind: first, format: "json", requestSource: options.request });
  }
  if (action === "activity") {
    assertAllowedOptions(options, ["format", "request"]);
    if (first !== undefined) throw queryError("TS_USAGE_UNEXPECTED_ARGUMENT", "activity takes no positional argument");
    if (options.request === undefined) {
      throw queryError("TS_USAGE_OPTION_DEPENDENCY", "activity requires --request");
    }
    return Object.freeze({ action, format: "json", requestSource: options.request });
  }
  if (action === "query") {
    assertAllowedOptions(options, ["format", "request"]);
    if (first !== undefined) throw queryError("TS_USAGE_UNEXPECTED_ARGUMENT", "query takes no positional argument");
    if (options.request === undefined) {
      throw queryError("TS_USAGE_OPTION_DEPENDENCY", "query requires --request");
    }
    return Object.freeze({ action, format: "json", requestSource: options.request });
  }
  if (action === "recipe") {
    assertAllowedOptions(options, ["format", "request"]);
    if (first === undefined) throw queryError("TS_USAGE_MISSING_ARGUMENT", "recipe requires a name");
    if (!RECIPE_NAMES.has(first)) {
      throw queryError("TS_USAGE_INVALID_VALUE", "recipe name is not supported");
    }
    if (options.request === undefined) {
      throw queryError("TS_USAGE_OPTION_DEPENDENCY", "recipe requires --request");
    }
    return Object.freeze({ action, name: first, format: "json", requestSource: options.request });
  }
  if (options.request !== undefined) {
    assertAllowedOptions(options, ["format", "request"]);
    if (first !== undefined) {
      throw queryError("TS_USAGE_OPTION_CONFLICT", "evidence --request cannot be combined with a Turn key");
    }
    return Object.freeze({ action: "evidence-v2", format: "json", requestSource: options.request });
  }
  assertAllowedOptions(options, ["format", "revision", "cursor", "limit"]);
  if (first === undefined) {
    throw queryError("TS_USAGE_MISSING_ARGUMENT", "evidence requires a Turn key");
  }
  if (options.revision === undefined) {
    throw queryError("TS_USAGE_OPTION_DEPENDENCY", "evidence requires --revision");
  }
  return Object.freeze({
    action, turnKey: requireHex64(first, "turn-key", "TS_USAGE_INVALID_VALUE"),
    revision: requireHex64(options.revision, "revision", "TS_USAGE_INVALID_VALUE"),
    format: "json", limit: parseLimit(options.limit), cursor: optionalCursor(options.cursor),
  });
}

function validateEngineRequest(factory, request, label) {
  try {
    factory({ requestId: "1", request });
  } catch (cause) {
    throw requestError(`${label} is invalid`, cause);
  }
  return deepFreeze(request);
}

function cloneJson(value, label) {
  try {
    return JSON.parse(JSON.stringify(value));
  } catch (cause) {
    throw requestError(`${label} is not valid JSON`, cause);
  }
}

export function normalizeInsightsDeepQueryRequest(input, options = {}) {
  exactKeys(input, [
    "format", "resource", "where", "shape", "orderBy", "limit", "cursor", "count",
  ], "Query request");
  if (input.format !== "threadshare-insights-query-request@v2") {
    throw requestError("Query request format is invalid");
  }
  const evaluatedAt = canonicalTimestamp(options.evaluatedAt, "evaluatedAt").timestamp;
  const shape = cloneJson(input.shape, "Query shape");
  if (plainObject(shape) && shape.kind === "records" && shape.payloadMode === undefined) {
    shape.payloadMode = "reference";
  }
  const request = {
    format: input.format,
    resource: input.resource,
    where: input.where === undefined ? null : cloneJson(input.where, "Query predicate"),
    shape,
    orderBy: cloneJson(input.orderBy, "Query orderBy"),
    limit: input.limit,
    cursor: options.engineCursor ?? null,
    count: input.count ?? "none",
    evaluatedAt,
  };
  return validateEngineRequest(createReadInsightsQueryV2Message, request, "Query request");
}

function normalizeRecipeWindow(value, label) {
  exactKeys(value, ["after", "before"], label);
  const after = canonicalTimestamp(value.after, `${label}.after`).timestamp;
  const before = canonicalTimestamp(value.before, `${label}.before`).timestamp;
  if (Date.parse(after) >= Date.parse(before)) throw requestError(`${label} must be non-empty`);
  return { after, before };
}

function normalizeRecipeFilters(value = {}) {
  exactKeys(value, [
    "providers", "projectKeys", "capabilityKeys", "sessionKeys", "eventKinds", "text", "bucket",
  ], "Recipe filters");
  const text = value.text ?? null;
  if (text !== null && (typeof text !== "string" || text.length === 0 ||
      Buffer.byteLength(text, "utf8") > MAX_QUERY_BYTES)) {
    throw requestError("Recipe filters.text must be a bounded non-empty string");
  }
  const bucket = value.bucket ?? null;
  if (bucket !== null && bucket !== "day" && bucket !== "week") {
    throw requestError("Recipe filters.bucket must be day or week");
  }
  return {
    providers: stringArray(value.providers, "Recipe filters.providers", {
      maximum: 64, maxBytes: 256,
    }),
    projectKeys: stringArray(value.projectKeys, "Recipe filters.projectKeys", { maximum: 64, hex: true }),
    capabilityKeys: stringArray(value.capabilityKeys, "Recipe filters.capabilityKeys", { maximum: 64, hex: true }),
    sessionKeys: stringArray(value.sessionKeys, "Recipe filters.sessionKeys", { maximum: 64, hex: true }),
    eventKinds: stringArray(value.eventKinds, "Recipe filters.eventKinds", {
      maximum: 64, maxBytes: 256,
    }),
    text,
    bucket,
  };
}

export function normalizeInsightsRecipeRequest(input, options = {}) {
  if (options.name === "delivery-trace@1") {
    exactKeys(input, [
      "format", "root", "window", "direction", "maxDepth", "includeCandidateEdges",
      "includeContextualEdges", "limit", "cursor",
    ], "Delivery Trace Recipe request");
    if (input.format !== "threadshare-insights-recipe-request@v1") {
      throw requestError("Recipe request format is invalid");
    }
    const request = {
      format: "threadshare-insights-delivery-trace-request@v1",
      root: cloneJson(input.root, "Delivery Trace root"),
      window: input.window == null ? null : normalizeRecipeWindow(input.window, "Delivery Trace window"),
      direction: input.direction ?? "both",
      maxDepth: input.maxDepth ?? 3,
      includeCandidateEdges: input.includeCandidateEdges ?? false,
      includeContextualEdges: input.includeContextualEdges ?? false,
      limit: input.limit ?? 100,
      cursor: options.engineCursor ?? null,
      evaluatedAt: canonicalTimestamp(options.evaluatedAt, "evaluatedAt").timestamp,
    };
    return validateEngineRequest(
      createReadInsightsDeliveryTraceMessage,
      request,
      "Delivery Trace Recipe request",
    );
  }
  exactKeys(input, [
    "format", "window", "comparisonWindow", "filters", "limit", "allowDegraded",
  ], "Recipe request");
  if (input.format !== "threadshare-insights-recipe-request@v1") {
    throw requestError("Recipe request format is invalid");
  }
  if (!RECIPE_NAMES.has(options.name)) throw requestError("Recipe name is not supported");
  const request = {
    format: input.format,
    name: options.name,
    window: normalizeRecipeWindow(input.window, "Recipe window"),
    comparisonWindow: input.comparisonWindow == null
      ? null
      : normalizeRecipeWindow(input.comparisonWindow, "Recipe comparisonWindow"),
    filters: normalizeRecipeFilters(input.filters),
    limit: input.limit ?? 20,
    allowDegraded: input.allowDegraded ?? false,
    evaluatedAt: canonicalTimestamp(options.evaluatedAt, "evaluatedAt").timestamp,
  };
  return validateEngineRequest(createReadInsightsRecipeMessage, request, "Recipe request");
}

export function normalizeInsightsDeepEvidenceRequest(input, options = {}) {
  exactKeys(input, ["format", "target", "include", "cursor", "maxBytes"], "Evidence request");
  if (input.format !== "threadshare-insights-evidence-request@v2") {
    throw requestError("Evidence request format is invalid");
  }
  const request = {
    format: input.format,
    target: cloneJson(input.target, "Evidence target"),
    include: cloneJson(input.include, "Evidence include"),
    cursor: options.engineCursor ?? null,
    maxBytes: input.maxBytes ?? 1_048_576,
  };
  return validateEngineRequest(createReadInsightsEvidenceV2Message, request, "Evidence request");
}

export function normalizeInsightsGitDiffEvidenceRequest(input) {
  exactKeys(input, [
    "format", "repositoryKey", "commitObjectId", "parentObjectId", "path", "revision",
    "contextLines", "maxBytes", "cursor",
  ], "Git diff Evidence request");
  try {
    assertGitDiffEvidenceRequest(input);
  } catch (cause) {
    throw requestError("Git diff Evidence request is invalid", cause);
  }
  return deepFreeze(cloneJson(input, "Git diff Evidence request"));
}

function canonicalTimestamp(value, label) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u.test(value)) {
    throw requestError(`${label} must be a canonical RFC3339 UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw requestError(`${label} must be a valid canonical RFC3339 UTC timestamp`);
  }
  return { timestamp: value, unixMs: String(milliseconds), milliseconds };
}

function stringArray(value, label, { maximum, allowed, hex = false, maxBytes, ascii = false } = {}) {
  if (value === undefined) return Object.freeze([]);
  if (!Array.isArray(value) || value.length > maximum) {
    throw requestError(`${label} exceeds its bounded item limit`);
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || item.length === 0) throw requestError(`${label} contains an invalid value`);
    if (hex && !HEX64.test(item)) throw requestError(`${label} contains an invalid contract ID`);
    if (allowed && !allowed.has(item)) throw requestError(`${label} contains an unsupported value`);
    if ((maxBytes !== undefined && Buffer.byteLength(item, "utf8") > maxBytes) ||
        (ascii && !/^[\x20-\x7e]+$/u.test(item))) {
      throw requestError(`${label} contains an invalid bounded value`);
    }
    return item;
  }).sort();
  if (new Set(result).size !== result.length) throw requestError(`${label} must be unique`);
  return Object.freeze(result);
}

function normalizeFilters(filters = {}) {
  exactKeys(filters, [
    "providers", "projectKeys", "toolCapabilityKeys", "skillCapabilityKeys",
    "observedAtOrAfter", "observedBefore", "resultEvidence", "closureStates",
    "capabilityTerminalStates",
  ], "filters");
  const after = filters.observedAtOrAfter === undefined
    ? null : canonicalTimestamp(filters.observedAtOrAfter, "filters.observedAtOrAfter");
  const before = filters.observedBefore === undefined
    ? null : canonicalTimestamp(filters.observedBefore, "filters.observedBefore");
  if (after !== null && before !== null && after.milliseconds >= before.milliseconds) {
    throw requestError("Search time window must be non-empty");
  }
  const result = {
    providers: stringArray(filters.providers, "filters.providers", {
      maximum: 16, maxBytes: 64, ascii: true,
    }),
    projectKeys: stringArray(filters.projectKeys, "filters.projectKeys", { maximum: 64, hex: true }),
    observedAtOrAfterUnixMs: after?.unixMs ?? null,
    observedBeforeUnixMs: before?.unixMs ?? null,
    toolCapabilityKeys: stringArray(filters.toolCapabilityKeys, "filters.toolCapabilityKeys", { maximum: 64, hex: true }),
    skillCapabilityKeys: stringArray(filters.skillCapabilityKeys, "filters.skillCapabilityKeys", { maximum: 64, hex: true }),
    resultEvidence: stringArray(filters.resultEvidence, "filters.resultEvidence", { maximum: 3, allowed: RESULT_EVIDENCE }),
    closureStates: stringArray(filters.closureStates, "filters.closureStates", { maximum: 3, allowed: CLOSURE_STATES }),
    capabilityTerminalStates: stringArray(filters.capabilityTerminalStates, "filters.capabilityTerminalStates", {
      maximum: 5, allowed: CAPABILITY_TERMINAL_STATES,
    }),
  };
  if (result.capabilityTerminalStates.length > 0 &&
      result.toolCapabilityKeys.length === 0 && result.skillCapabilityKeys.length === 0) {
    throw requestError("capabilityTerminalStates requires a tool or skill capability key filter");
  }
  return deepFreeze(result);
}

function filtersPresent(filters) {
  return Object.entries(filters).some(([key, value]) =>
    key.endsWith("UnixMs") ? value !== null : value.length > 0);
}

export function normalizeInsightsSearchRequest(input) {
  exactKeys(input, ["format", "query", "filters", "orderBy", "limit", "pathLimit"], "Search request");
  if (input.format !== "threadshare-insights-search-request@v1") {
    throw requestError("Search request format is invalid");
  }
  const query = input.query === undefined ? "" : input.query;
  if (typeof query !== "string") throw requestError("Search query must be a string");
  if (Buffer.byteLength(query, "utf8") > MAX_QUERY_BYTES) {
    throw queryError("TS_QUERY_TOO_LONG", "Insights query exceeds 8 KiB");
  }
  const hasQuery = query.trim() !== "";
  if (input.query !== undefined && !hasQuery) {
    throw requestError("Search query must be non-empty when provided");
  }
  const filters = normalizeFilters(input.filters);
  if (!hasQuery && !filtersPresent(filters)) {
    throw requestError("Search requires a non-empty query or a structured filter");
  }
  const orderBy = input.orderBy ?? (hasQuery ? "relevance" : "observed-desc");
  if (!SEARCH_ORDER.has(orderBy) || (orderBy === "relevance" && !hasQuery)) {
    throw requestError("Search orderBy is invalid for this request");
  }
  if (hasQuery && orderBy === "observed-desc") {
    if (filters.observedAtOrAfterUnixMs === null || filters.observedBeforeUnixMs === null) {
      throw requestError("query with observed-desc requires a complete time window");
    }
    const duration = BigInt(filters.observedBeforeUnixMs) - BigInt(filters.observedAtOrAfterUnixMs);
    if (duration > 366n * 86_400_000n) {
      throw requestError("query with observed-desc is limited to 366 days");
    }
  }
  const limit = input.limit === undefined ? MAX_PUBLIC_LIMIT : parseLimit(input.limit);
  const pathLimit = input.pathLimit ?? 10;
  if (!Number.isSafeInteger(pathLimit) || pathLimit < 0 || pathLimit > MAX_PATH_LIMIT) {
    throw requestError(`Search pathLimit must be an integer from 0 to ${MAX_PATH_LIMIT}`);
  }
  return deepFreeze({ query, filters, orderBy, limit, pathLimit });
}

function normalizeWindow(value, label) {
  exactKeys(value, ["observedAtOrAfter", "observedBefore"], label);
  const after = canonicalTimestamp(value.observedAtOrAfter, `${label}.observedAtOrAfter`);
  const before = canonicalTimestamp(value.observedBefore, `${label}.observedBefore`);
  if (after.milliseconds >= before.milliseconds) {
    throw requestError(`${label} must be a non-empty half-open window`);
  }
  return deepFreeze({
    observedAtOrAfter: after.timestamp,
    observedBefore: before.timestamp,
  });
}

function normalizeAggregateFilters(value = {}) {
  exactKeys(value, ["providers", "projectKeys", "closureStates"], "filters");
  return deepFreeze({
    providers: stringArray(value.providers, "filters.providers", {
      maximum: 16, maxBytes: 64, ascii: true,
    }),
    projectKeys: stringArray(value.projectKeys, "filters.projectKeys", { maximum: 64, hex: true }),
    closureStates: stringArray(value.closureStates, "filters.closureStates", {
      maximum: 3, allowed: CLOSURE_STATES,
    }),
  });
}

function requestLimit(value) {
  if (value === undefined) return MAX_PUBLIC_LIMIT;
  if (!Number.isSafeInteger(value) || value < 1 || value > MAX_PUBLIC_LIMIT) {
    throw requestError(`limit must be an integer from 1 to ${MAX_PUBLIC_LIMIT}`);
  }
  return value;
}

function requestCursor(value) {
  if (value === undefined) return null;
  if (typeof value !== "string" || value.length === 0 || Buffer.byteLength(value) > MAX_CURSOR_BYTES) {
    throw requestError("cursor must be a bounded non-empty token");
  }
  return value;
}

export function normalizeInsightsUsageRequest(input, kind) {
  requireKind(kind);
  exactKeys(input, [
    "format", "window", "comparisonWindow", "filters", "orderBy", "limit", "cursor",
  ], "Usage request");
  if (input.format !== "threadshare-insights-usage-request@v1") {
    throw requestError("Usage request format is invalid");
  }
  if (!USAGE_ORDER.has(input.orderBy)) throw requestError("Usage orderBy is required and invalid");
  const comparisonWindow = input.comparisonWindow === undefined
    ? null : normalizeWindow(input.comparisonWindow, "comparisonWindow");
  if (input.orderBy === "absolute-recorded-invocation-change" && comparisonWindow === null) {
    throw requestError("absolute-recorded-invocation-change requires comparisonWindow");
  }
  return deepFreeze({
    kind,
    window: normalizeWindow(input.window, "window"),
    comparisonWindow,
    filters: normalizeAggregateFilters(input.filters),
    orderBy: input.orderBy,
    limit: requestLimit(input.limit),
    cursor: requestCursor(input.cursor),
  });
}

export function normalizeInsightsActivityRequest(input) {
  exactKeys(input, ["format", "window", "filters", "bucket"], "Activity request");
  if (input.format !== "threadshare-insights-activity-request@v1") {
    throw requestError("Activity request format is invalid");
  }
  if (input.bucket !== "day" && input.bucket !== "week") {
    throw requestError("Activity bucket must be day or week");
  }
  const window = normalizeWindow(input.window, "window");
  const after = Date.parse(window.observedAtOrAfter);
  const before = Date.parse(window.observedBefore);
  const bucketMs = input.bucket === "day" ? 86_400_000 : 7 * 86_400_000;
  const afterDate = new Date(after);
  const beforeDate = new Date(before);
  const midnight = (value) => value.getUTCHours() === 0 && value.getUTCMinutes() === 0 &&
    value.getUTCSeconds() === 0 && value.getUTCMilliseconds() === 0;
  if (!midnight(afterDate) || !midnight(beforeDate) ||
      (input.bucket === "week" && (afterDate.getUTCDay() !== 1 || beforeDate.getUTCDay() !== 1)) ||
      (before - after) % bucketMs !== 0) {
    throw requestError("Activity window must align to complete UTC bucket boundaries");
  }
  const bucketCount = (before - after) / bucketMs;
  if (!Number.isSafeInteger(bucketCount) || bucketCount < 1 || bucketCount > 366) {
    throw requestError("Activity is limited to 366 complete buckets");
  }
  return deepFreeze({
    window,
    filters: normalizeAggregateFilters(input.filters),
    bucket: input.bucket,
    timeZone: "UTC",
    bucketCount,
  });
}

async function readBoundedRequestStream(input, signal) {
  const iterator = input[Symbol.asyncIterator]();
  let abortHandler;
  let completed = false;
  const aborted = signal === undefined
    ? null
    : new Promise((_, reject) => {
        abortHandler = () => reject(queryAborted(signal.reason));
        signal.addEventListener("abort", abortHandler, { once: true });
        if (signal.aborted) abortHandler();
      });
  let bytes = Buffer.alloc(0);
  try {
    for (;;) {
      const result = await (aborted === null
        ? iterator.next()
        : Promise.race([iterator.next(), aborted]));
      if (result.done) {
        completed = true;
        return bytes;
      }
      const next = Buffer.from(result.value);
      if (bytes.byteLength + next.byteLength > MAX_REQUEST_BYTES) {
        throw requestError("Insights request exceeds 64 KiB");
      }
      bytes = Buffer.concat([bytes, next], bytes.byteLength + next.byteLength);
    }
  } finally {
    if (abortHandler !== undefined) signal.removeEventListener("abort", abortHandler);
    if (!completed) Promise.resolve(iterator.return?.()).catch(() => {});
  }
}

export async function readInsightsQueryRequest(source, options = {}) {
  if (options.signal?.aborted) throw queryAborted(options.signal.reason);
  let bytes;
  if (source === "-") {
    try {
      bytes = await readBoundedRequestStream(options.input ?? process.stdin, options.signal);
    } catch (error) {
      if (error?.code === "TS_INSIGHTS_REQUEST_INVALID" ||
          error?.code === "TS_INSIGHTS_ENGINE_ABORTED") throw error;
      throw queryError("TS_INPUT_READ_FAILED", "Unable to read the Insights request", error);
    }
  } else {
    let handle;
    try {
      handle = await (options.openFile ?? open)(source, "r");
      const stats = await handle.stat({ bigint: true });
      if (!stats.isFile() || stats.size > BigInt(MAX_REQUEST_BYTES)) {
        throw requestError("Insights request exceeds 64 KiB");
      }
      const bounded = Buffer.alloc(MAX_REQUEST_BYTES + 1);
      let offset = 0;
      while (offset < bounded.byteLength) {
        if (options.signal?.aborted) throw queryAborted(options.signal.reason);
        const { bytesRead } = await handle.read(
          bounded,
          offset,
          bounded.byteLength - offset,
          null,
        );
        if (bytesRead === 0) break;
        offset += bytesRead;
      }
      if (options.signal?.aborted) throw queryAborted(options.signal.reason);
      if (offset > MAX_REQUEST_BYTES) {
        throw requestError("Insights request exceeds 64 KiB");
      }
      bytes = bounded.subarray(0, offset);
    } catch (error) {
      if (error?.code === "TS_INSIGHTS_REQUEST_INVALID" ||
          error?.code === "TS_INSIGHTS_ENGINE_ABORTED") throw error;
      throw queryError("TS_INPUT_READ_FAILED", "Unable to read the Insights request", error);
    } finally {
      await handle?.close();
    }
  }
  let text;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (cause) {
    throw requestError("Insights request is not valid UTF-8", cause);
  }
  try {
    return JSON.parse(text);
  } catch (cause) {
    throw requestError("Insights request is not valid JSON", cause);
  }
}

function decimal(value) {
  if (typeof value === "string" && DECIMAL.test(value)) return value;
  if (Number.isSafeInteger(value) && value >= 0) return String(value);
  throw responseError("Engine response contains an invalid count");
}

function signedDecimal(value) {
  if (typeof value === "string" && SIGNED_DECIMAL.test(value)) return value;
  if (Number.isSafeInteger(value)) return String(value);
  throw responseError("Engine response contains an invalid signed count");
}

export function createInsightsCursorCodec(privacyContext) {
  if (!privacyContext || typeof privacyContext.fingerprint !== "function") {
    throw new TypeError("privacyContext.fingerprint is required");
  }
  const snapshot = (databaseUuid, seq) => {
    if (typeof databaseUuid !== "string" || !UUID.test(databaseUuid) || !DECIMAL.test(seq)) {
      throw responseError("Engine response has an invalid snapshot identity");
    }
    return Object.freeze({
      seq,
      token: privacyContext.fingerprint("insights-public-snapshot-v1", databaseUuid, seq),
    });
  };
  const requestDigest = (request) =>
    createHash("sha256").update(canonicalJson(request)).digest("hex");
  const seal = (value) => {
    if (typeof value?.engineCursor !== "string" || value.engineCursor.length === 0 ||
        Buffer.byteLength(value.engineCursor, "utf8") > 4096 ||
        !/^[\x20-\x7e]+$/u.test(value.engineCursor)) {
      throw responseError("Engine response contains an invalid page cursor");
    }
    const payload = {
      format: "threadshare-insights-cursor@v1",
      kind: value.kind,
      snapshot: value.snapshot,
      requestDigest: value.requestDigest,
      engineCursor: value.engineCursor,
      closureEvaluatedAt: value.closureEvaluatedAt,
      quiescenceSeconds: value.quiescenceSeconds,
      turnKey: value.turnKey,
      revision: value.revision,
    };
    const body = Buffer.from(canonicalJson(payload)).toString("base64url");
    const tag = privacyContext.fingerprint("insights-public-cursor-v1", body);
    return `${body}.${tag}`;
  };
  const openCursor = (token, expected) => {
    try {
      if (typeof token !== "string" || Buffer.byteLength(token) > MAX_CURSOR_BYTES) throw staleCursor();
      const parts = token.split(".");
      if (parts.length !== 2 || !HEX64.test(parts[1])) throw staleCursor();
      const expectedTag = privacyContext.fingerprint("insights-public-cursor-v1", parts[0]);
      if (!timingSafeEqual(Buffer.from(parts[1], "hex"), Buffer.from(expectedTag, "hex"))) {
        throw staleCursor();
      }
      const payload = JSON.parse(Buffer.from(parts[0], "base64url").toString("utf8"));
      exactKeys(payload, [
        "format", "kind", "snapshot", "requestDigest", "engineCursor",
        "closureEvaluatedAt", "quiescenceSeconds", "turnKey", "revision",
      ], "cursor");
      if (payload.format !== "threadshare-insights-cursor@v1" || payload.kind !== expected.kind ||
          payload.requestDigest !== requestDigest(expected.request) ||
          (expected.turnKey !== undefined && payload.turnKey !== expected.turnKey) ||
          (expected.revision !== undefined && payload.revision !== expected.revision) ||
          typeof payload.engineCursor !== "string" || payload.engineCursor.length === 0 ||
          Buffer.byteLength(payload.engineCursor, "utf8") > 4096 ||
          !plainObject(payload.snapshot) || !DECIMAL.test(payload.snapshot.seq) ||
          !HEX64.test(payload.snapshot.token)) {
        throw staleCursor();
      }
      exactKeys(payload.snapshot, ["seq", "token"], "cursor.snapshot");
      if (payload.closureEvaluatedAt !== null) {
        canonicalTimestamp(payload.closureEvaluatedAt, "cursor.closureEvaluatedAt");
      }
      if (payload.quiescenceSeconds !== null &&
          (!Number.isSafeInteger(payload.quiescenceSeconds) ||
           payload.quiescenceSeconds < 60 || payload.quiescenceSeconds > 86_400)) {
        throw staleCursor();
      }
      return deepFreeze(payload);
    } catch (error) {
      if (error?.code === "TS_INSIGHTS_CURSOR_STALE") throw error;
      throw staleCursor();
    }
  };
  const assertSnapshot = (cursor, current) => {
    if (cursor.snapshot.seq !== current.seq || cursor.snapshot.token !== current.token) {
      throw staleCursor();
    }
    return true;
  };
  return Object.freeze({ snapshot, requestDigest, seal, open: openCursor, assertSnapshot });
}

function publicSnapshot(response, privacyContext) {
  const seq = response.snapshot?.snapshotSeq ?? response.snapshotSeq;
  if (seq === "0") throw queryError("TS_INSIGHTS_NOT_INDEXED", "Insights index is empty");
  return createInsightsCursorCodec(privacyContext).snapshot(response.databaseUuid, seq);
}

function publicSourceFreshness() {
  return { state: "not-evaluated", lastCommittedAt: null };
}

function publicDeepCoverage(value) {
  if (!plainObject(value)) throw responseError("Engine response is missing deep query coverage");
  return {
    matching: {
      fullRecordCount: decimal(value.matching.fullRecordCount),
      summaryRecordCount: decimal(value.matching.summaryRecordCount),
      unloadedRecordCount: decimal(value.matching.unloadedRecordCount),
      truncatedRecordCount: decimal(value.matching.truncatedRecordCount),
      unavailableRecordCount: decimal(value.matching.unavailableRecordCount),
      missingTimestampCount: decimal(value.matching.missingTimestampCount),
      missingRevisionCount: decimal(value.matching.missingRevisionCount),
      missingTokenMetricCount: decimal(value.matching.missingTokenMetricCount),
      missingPayloadCount: decimal(value.matching.missingPayloadCount),
    },
    indexedHistory: {
      visibleSessionCount: decimal(value.indexedHistory.visibleSessionCount),
      excludedSessionCount: decimal(value.indexedHistory.excludedSessionCount),
      subagentExcludedSessionCount: decimal(value.indexedHistory.subagentExcludedSessionCount),
      unknownEligibilitySessionCount: decimal(value.indexedHistory.unknownEligibilitySessionCount),
      pendingPurgeSessionCount: decimal(value.indexedHistory.pendingPurgeSessionCount),
      purgedSessionCount: decimal(value.indexedHistory.purgedSessionCount),
      missingCoverageRollupSessionCount:
        decimal(value.indexedHistory.missingCoverageRollupSessionCount),
      fts: {
        searchableEventCount: decimal(value.indexedHistory.fts.searchableEventCount),
        storedNotSearchableEventCount:
          decimal(value.indexedHistory.fts.storedNotSearchableEventCount),
        searchablePayloadBytes: decimal(value.indexedHistory.fts.searchablePayloadBytes),
        storedNotSearchablePayloadBytes:
          decimal(value.indexedHistory.fts.storedNotSearchablePayloadBytes),
      },
    },
    degraded: value.degraded,
    diagnostics: [...value.diagnostics],
  };
}

function publicDeepProvenance(value) {
  if (!plainObject(value) || !Array.isArray(value.fields)) {
    throw responseError("Engine response is missing deep query provenance");
  }
  return {
    default: value.default,
    fields: value.fields.map((field) => ({
      path: field.path,
      kind: field.kind,
      method: field.method,
    })),
  };
}

function deepQueryCursorRequest(request) {
  return {
    format: request.format,
    resource: request.resource,
    where: request.where,
    shape: request.shape,
    orderBy: request.orderBy,
    limit: request.limit,
    count: request.count,
  };
}

export function projectInsightsDeepQuery(response, context) {
  if (response.resource !== context.request.resource ||
      (response.records === null) === (response.groups === null)) {
    throw responseError("Engine response changed the deep Query shape");
  }
  const codec = createInsightsCursorCodec(context.privacyContext);
  const snapshot = publicSnapshot(response, context.privacyContext);
  if (context.cursor !== null) codec.assertSnapshot(context.cursor, snapshot);
  const nextCursor = response.nextCursor === null ? null : codec.seal({
    kind: "query-v2",
    snapshot,
    requestDigest: codec.requestDigest(deepQueryCursorRequest(context.request)),
    engineCursor: response.nextCursor,
    closureEvaluatedAt: context.evaluatedAt,
    quiescenceSeconds: null,
    turnKey: null,
    revision: null,
  });
  return deepFreeze({
    format: "threadshare-insights-query@v2",
    snapshot,
    sourceFreshness: publicSourceFreshness(),
    resource: response.resource,
    records: response.records === null ? null : cloneJson(response.records, "Query records"),
    groups: response.groups === null ? null : cloneJson(response.groups, "Query groups"),
    nextCursor,
    totalMatchCount: response.totalMatchCount === null ? null : decimal(response.totalMatchCount),
    totalGroupCount: response.totalGroupCount === null ? null : decimal(response.totalGroupCount),
    truncated: response.truncated,
    coverage: publicDeepCoverage(response.coverage),
    provenance: publicDeepProvenance(response.provenance),
    limits: {
      pageBytes: decimal(response.limits.pageBytes),
      payloadsMayRequireEvidencePaging: response.limits.payloadsMayRequireEvidencePaging,
    },
  });
}

export async function executeInsightsDeepQueryRequest(input, context) {
  const codec = createInsightsCursorCodec(context.privacyContext);
  const initialRequest = normalizeInsightsDeepQueryRequest(input, {
    evaluatedAt: context.evaluatedAt,
  });
  const publicCursor = input.cursor == null ? null : codec.open(input.cursor, {
    kind: "query-v2",
    request: deepQueryCursorRequest(initialRequest),
  });
  const evaluatedAt = publicCursor?.closureEvaluatedAt ?? context.evaluatedAt;
  if (evaluatedAt === null) throw staleCursor();
  const request = publicCursor === null ? initialRequest : normalizeInsightsDeepQueryRequest(
    input,
    { evaluatedAt, engineCursor: publicCursor.engineCursor },
  );
  const response = await context.reader.queryV2(request, { signal: context.signal });
  return projectInsightsDeepQuery(response, {
    privacyContext: context.privacyContext,
    request,
    cursor: publicCursor,
    evaluatedAt,
  });
}

export function projectInsightsRecipe(response, context) {
  if (response.name !== context.request.name || response.evaluatedAt !== context.evaluatedAt ||
      canonicalJson(response.window) !== canonicalJson(context.request.window) ||
      canonicalJson(response.comparisonWindow) !== canonicalJson(context.request.comparisonWindow)) {
    throw responseError("Engine response changed the Recipe request");
  }
  return deepFreeze({
    format: "threadshare-insights-recipe@v1",
    snapshot: publicSnapshot(response, context.privacyContext),
    sourceFreshness: publicSourceFreshness(),
    name: response.name,
    window: cloneJson(response.window, "Recipe window"),
    comparisonWindow: response.comparisonWindow === null
      ? null
      : cloneJson(response.comparisonWindow, "Recipe comparisonWindow"),
    evaluatedAt: response.evaluatedAt,
    items: cloneJson(response.items, "Recipe items"),
    totalItemCount: decimal(response.totalItemCount),
    truncated: response.truncated,
    coverage: publicDeepCoverage(response.coverage),
    provenance: publicDeepProvenance(response.provenance),
  });
}

export async function executeInsightsRecipeRequest(name, input, context) {
  const request = normalizeInsightsRecipeRequest(input, {
    name,
    evaluatedAt: context.evaluatedAt,
  });
  const response = await context.reader.recipe(request, { signal: context.signal });
  return projectInsightsRecipe(response, {
    privacyContext: context.privacyContext,
    request,
    evaluatedAt: context.evaluatedAt,
  });
}

function deliveryTraceCursorRequest(request) {
  return {
    format: request.format,
    root: request.root,
    window: request.window,
    direction: request.direction,
    maxDepth: request.maxDepth,
    includeCandidateEdges: request.includeCandidateEdges,
    includeContextualEdges: request.includeContextualEdges,
    limit: request.limit,
  };
}

export function projectInsightsDeliveryTrace(response, context) {
  if (response.evaluatedAt !== context.request.evaluatedAt ||
      canonicalJson(response.root) !== canonicalJson(context.request.root) ||
      !Array.isArray(response.nodes) || !Array.isArray(response.edges) ||
      response.edges.length > context.request.limit ||
      typeof response.truncated !== "boolean" ||
      response.truncated !== (response.nextCursor !== null)) {
    throw responseError("Engine response changed the Delivery Trace request");
  }
  const codec = createInsightsCursorCodec(context.privacyContext);
  const snapshot = publicSnapshot(response, context.privacyContext);
  if (context.cursor !== null) codec.assertSnapshot(context.cursor, snapshot);
  const nextCursor = response.nextCursor === null ? null : codec.seal({
    kind: "delivery-trace",
    snapshot,
    requestDigest: codec.requestDigest(deliveryTraceCursorRequest(context.request)),
    engineCursor: response.nextCursor,
    closureEvaluatedAt: context.request.evaluatedAt,
    quiescenceSeconds: null,
    turnKey: null,
    revision: null,
  });
  return deepFreeze({
    format: "threadshare-insights-delivery-trace@v1",
    databaseUuid: response.databaseUuid,
    snapshotSeq: decimal(response.snapshotSeq),
    evaluatedAt: response.evaluatedAt,
    root: cloneJson(response.root, "Delivery Trace root"),
    nodes: cloneJson(response.nodes, "Delivery Trace nodes"),
    edges: cloneJson(response.edges, "Delivery Trace edges"),
    nextCursor,
    truncated: response.truncated,
    coverage: cloneJson(response.coverage, "Delivery Trace coverage"),
  });
}

export async function executeInsightsDeliveryTraceRequest(input, context) {
  const resolvedInput = await resolveDeliveryTraceRoot(input, context);
  const codec = createInsightsCursorCodec(context.privacyContext);
  const initialRequest = normalizeInsightsRecipeRequest(resolvedInput, {
    name: "delivery-trace@1",
    evaluatedAt: context.evaluatedAt,
  });
  const publicCursor = input.cursor == null ? null : codec.open(input.cursor, {
    kind: "delivery-trace",
    request: deliveryTraceCursorRequest(initialRequest),
  });
  const evaluatedAt = publicCursor?.closureEvaluatedAt ?? context.evaluatedAt;
  if (evaluatedAt === null) throw staleCursor();
  const request = publicCursor === null ? initialRequest : normalizeInsightsRecipeRequest(resolvedInput, {
    name: "delivery-trace@1",
    evaluatedAt,
    engineCursor: publicCursor.engineCursor,
  });
  const response = await context.reader.deliveryTrace(request, { signal: context.signal });
  return projectInsightsDeliveryTrace(response, {
    privacyContext: context.privacyContext,
    request,
    cursor: publicCursor,
  });
}

function pathContains(rootDirectory, currentDirectory) {
  const relative = path.relative(rootDirectory, currentDirectory);
  return relative === "" || (relative !== ".." && !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative));
}

async function resolveDeliveryTraceRoot(input, context) {
  if (input.root !== undefined) return input;
  const config = await context.readConfig({ paths: context.paths });
  const currentDirectory = path.resolve(context.cwd);
  const matches = (config.insights.repositories ?? [])
    .map((repository) => ({
      repository,
      rootDirectory: path.resolve(repository.rootDirectory),
    }))
    .filter(({ rootDirectory }) => pathContains(rootDirectory, currentDirectory))
    .sort((left, right) => right.rootDirectory.length - left.rootDirectory.length ||
      left.repository.repositoryId.localeCompare(right.repository.repositoryId));
  if (matches.length === 0) {
    throw deliveryTraceNotReady(
      "Current directory is not a registered Insights repository; run `threadshare insights sync --repository .` first",
    );
  }
  if (matches.length > 1 && matches[0].rootDirectory === matches[1].rootDirectory) {
    throw deliveryTraceNotReady(
      "Current directory matches multiple Insights repositories; register it again with `threadshare insights sync --repository .`",
    );
  }
  return {
    ...input,
    root: {
      kind: "repository",
      key: context.privacyContext.fingerprint("repository", matches[0].repository.repositoryId),
    },
  };
}

function deepEvidenceCursorRequest(request) {
  return {
    format: request.format,
    target: request.target,
    include: request.include,
    maxBytes: request.maxBytes,
  };
}

function gitDiffCursorRequest(request) {
  return {
    format: request.format,
    repositoryKey: request.repositoryKey,
    commitObjectId: request.commitObjectId,
    parentObjectId: request.parentObjectId,
    path: request.path,
    revision: request.revision,
    contextLines: request.contextLines,
    maxBytes: request.maxBytes,
  };
}

function encodeGitDiffCursorState(value) {
  return Buffer.from(canonicalJson({
    format: "threadshare-insights-git-diff-cursor-state@v1",
    offset: String(value.offset),
    payloadSha256: value.payloadSha256,
    totalBytes: value.totalBytes,
  })).toString("base64url");
}

function decodeGitDiffCursorState(value) {
  try {
    const state = JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
    exactKeys(state, ["format", "offset", "payloadSha256", "totalBytes"], "Git diff cursor");
    if (state.format !== "threadshare-insights-git-diff-cursor-state@v1" ||
        !DECIMAL.test(state.offset) || !HEX64.test(state.payloadSha256) ||
        !DECIMAL.test(state.totalBytes) || BigInt(state.offset) > BigInt(state.totalBytes) ||
        BigInt(state.offset) > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw staleCursor();
    }
    return Object.freeze({
      offset: Number(state.offset),
      payloadSha256: state.payloadSha256,
      totalBytes: state.totalBytes,
    });
  } catch (error) {
    if (error?.code === "TS_INSIGHTS_CURSOR_STALE") throw error;
    throw staleCursor();
  }
}

function unavailableGitEvidence(message) {
  return queryError("TS_INSIGHTS_EVIDENCE_NOT_FOUND", message);
}

function sameRepositoryIdentity(registration, resolved) {
  return resolved.commonDirectoryDevice === registration.commonDirectoryDevice &&
    resolved.commonDirectoryInode === registration.commonDirectoryInode;
}

function gitCommitKey(request) {
  return hashKey(
    "git-commit",
    Buffer.from(request.repositoryKey, "hex"),
    request.commitObjectId,
  );
}

function gitDiffPathAuthorizationRequest(request, evaluatedAt) {
  return validateEngineRequest(createReadInsightsQueryV2Message, {
    format: "threadshare-insights-query-request@v2",
    resource: "delivery-edge",
    where: {
      and: [
        { field: "repositoryKey", op: "eq", value: request.repositoryKey },
        { field: "commitHash", op: "eq", value: request.commitObjectId },
        { field: "normalizedPath", op: "eq", value: request.path },
        { field: "relation", op: "eq", value: "commit-changed-file" },
      ],
    },
    shape: {
      kind: "records",
      select: [
        "edgeKey", "repositoryKey", "commitHash", "normalizedPath", "oldPath",
        "relation", "revision",
      ],
      payloadMode: "reference",
    },
    orderBy: [
      { field: "observedAt", direction: "desc" },
      { field: "edgeKey", direction: "asc" },
    ],
    limit: 2,
    cursor: null,
    count: "exact",
    evaluatedAt,
  }, "Git diff path authorization request");
}

export async function authorizeInsightsGitDiffEvidence(request, context) {
  const config = await context.readConfig({ paths: context.state.paths });
  const registration = (config.insights.repositories ?? []).find((item) =>
    context.state.privacyContext.fingerprint("repository", item.repositoryId) ===
      request.repositoryKey);
  if (registration === undefined) {
    throw unavailableGitEvidence("The requested Git repository is not registered");
  }
  let resolved;
  try {
    resolved = await context.resolveRepository(registration.rootDirectory, {
      signal: context.signal,
    });
  } catch (error) {
    if (error?.name === "AbortError" || error?.code === "TS_INSIGHTS_ENGINE_ABORTED") throw error;
    throw unavailableGitEvidence("The registered Git repository is unavailable");
  }
  if (!sameRepositoryIdentity(registration, resolved)) {
    throw unavailableGitEvidence("The registered Git repository identity changed");
  }
  const root = { kind: "git-commit", key: gitCommitKey(request) };
  const traceRequest = validateEngineRequest(createReadInsightsDeliveryTraceMessage, {
    format: "threadshare-insights-delivery-trace-request@v1",
    root,
    window: null,
    direction: "outgoing",
    maxDepth: 1,
    includeCandidateEdges: false,
    includeContextualEdges: false,
    limit: 1,
    cursor: null,
    evaluatedAt: context.evaluatedAt,
  }, "Git diff commit authorization request");
  const trace = await context.reader.deliveryTrace(traceRequest, { signal: context.signal });
  const commit = trace.nodes.find((node) => node.kind === "git-commit" && node.key === root.key);
  if (commit === undefined || commit.attributes.repositoryKey !== request.repositoryKey ||
      commit.attributes.objectId !== request.commitObjectId) {
    throw unavailableGitEvidence("The requested Git commit is not in the committed trace");
  }
  if (commit.revision !== request.revision) {
    throw queryError("TS_INSIGHTS_PAYLOAD_CHANGED", "The requested Git commit revision changed");
  }
  const parents = commit.attributes.parentObjectIds;
  if ((request.parentObjectId === null && parents.length !== 0) ||
      (request.parentObjectId !== null && !parents.includes(request.parentObjectId))) {
    throw requestError("Git diff parentObjectId is not a parent of the projected commit");
  }
  let oldPath = null;
  if (request.path !== null) {
    const edgePage = await context.reader.queryV2(
      gitDiffPathAuthorizationRequest(request, context.evaluatedAt),
      { signal: context.signal },
    );
    if (edgePage.databaseUuid !== trace.databaseUuid || edgePage.snapshotSeq !== trace.snapshotSeq) {
      throw staleCursor();
    }
    if (edgePage.totalMatchCount !== "1" || !Array.isArray(edgePage.records) ||
        edgePage.records.length !== 1) {
      throw unavailableGitEvidence("The requested path is not in the projected commit manifest");
    }
    const [record] = edgePage.records;
    if (record.repositoryKey !== request.repositoryKey ||
        record.commitHash !== request.commitObjectId ||
        record.normalizedPath !== request.path ||
        record.relation !== "commit-changed-file") {
      throw responseError("Engine response changed the Git diff path authorization");
    }
    oldPath = record.oldPath;
  }
  return Object.freeze({
    registration,
    oldPath,
    snapshot: createInsightsCursorCodec(context.state.privacyContext)
      .snapshot(trace.databaseUuid, decimal(trace.snapshotSeq)),
  });
}

export async function executeInsightsGitDiffEvidenceRequest(input, context) {
  const request = normalizeInsightsGitDiffEvidenceRequest(input);
  const codec = createInsightsCursorCodec(context.state.privacyContext);
  const cursor = request.cursor === null ? null : codec.open(request.cursor, {
    kind: "git-diff-evidence",
    request: gitDiffCursorRequest(request),
  });
  const cursorState = cursor === null ? null : decodeGitDiffCursorState(cursor.engineCursor);
  const authorization = await authorizeInsightsGitDiffEvidence(request, context);
  if (cursor !== null) codec.assertSnapshot(cursor, authorization.snapshot);
  try {
    return await context.readGitDiff(request, {
      rootDirectory: authorization.registration.rootDirectory,
      oldPath: authorization.oldPath,
      offset: cursorState?.offset ?? 0,
      expectedPayloadSha256: cursorState?.payloadSha256,
      expectedTotalBytes: cursorState?.totalBytes,
      signal: context.signal,
      createCursor(value) {
        return codec.seal({
          kind: "git-diff-evidence",
          snapshot: authorization.snapshot,
          requestDigest: codec.requestDigest(gitDiffCursorRequest(request)),
          engineCursor: encodeGitDiffCursorState(value),
          closureEvaluatedAt: null,
          quiescenceSeconds: null,
          turnKey: null,
          revision: request.revision,
        });
      },
    });
  } catch (error) {
    if (error?.code === "TS_INSIGHTS_GIT_OBJECT_UNAVAILABLE" ||
        error?.code === "TS_INSIGHTS_GIT_DIFF_ENCODING_UNSUPPORTED") {
      throw unavailableGitEvidence("The projected Git diff is unavailable");
    }
    if (error?.code === "TS_INSIGHTS_GIT_DIFF_TOO_LARGE") {
      throw queryError("TS_QUERY_TOO_BROAD", "The projected Git diff exceeds its bounded limit");
    }
    throw error;
  }
}

export function projectInsightsDeepEvidence(response, context) {
  if (canonicalJson(response.target) !== canonicalJson(context.request.target)) {
    throw turnChanged();
  }
  const codec = createInsightsCursorCodec(context.privacyContext);
  const snapshot = publicSnapshot(response, context.privacyContext);
  if (context.cursor !== null) codec.assertSnapshot(context.cursor, snapshot);
  const nextCursor = response.nextCursor === null ? null : codec.seal({
    kind: "evidence-v2",
    snapshot,
    requestDigest: codec.requestDigest(deepEvidenceCursorRequest(context.request)),
    engineCursor: response.nextCursor,
    closureEvaluatedAt: null,
    quiescenceSeconds: null,
    turnKey: null,
    revision: response.revision,
  });
  return deepFreeze({
    format: "threadshare-insights-evidence@v2",
    snapshot,
    sourceFreshness: publicSourceFreshness(),
    target: cloneJson(response.target, "Evidence target"),
    revision: response.revision,
    payloadSha256: response.payloadSha256,
    totalBytes: decimal(response.totalBytes),
    range: { start: decimal(response.range.start), end: decimal(response.range.end) },
    content: response.content,
    nextCursor,
    complete: response.complete,
  });
}

export async function executeInsightsDeepEvidenceRequest(input, context) {
  const codec = createInsightsCursorCodec(context.privacyContext);
  const baseRequest = normalizeInsightsDeepEvidenceRequest(input);
  const publicCursor = input.cursor == null ? null : codec.open(input.cursor, {
    kind: "evidence-v2",
    request: deepEvidenceCursorRequest(baseRequest),
  });
  const request = normalizeInsightsDeepEvidenceRequest(input, {
    engineCursor: publicCursor?.engineCursor ?? null,
  });
  const response = await context.reader.evidenceV2(request, { signal: context.signal });
  return projectInsightsDeepEvidence(response, {
    privacyContext: context.privacyContext,
    request,
    cursor: publicCursor,
  });
}

function publicSearchResult(item, orderBy) {
  const result = {
    turnKey: item.turnKey,
    sessionKey: item.sessionKey,
    revision: item.revision,
    provider: item.provider,
    projectKey: item.projectKey,
    observedTimestamp: item.observedTimestamp,
    problemExcerpt: item.problemExcerpt,
    problemTruncated: item.problemTruncated,
    finalAnswerExcerpt: item.finalAnswerExcerpt,
    finalAnswerTruncated: item.finalAnswerTruncated,
    closureState: item.closureState,
    resultEvidence: item.resultEvidence,
    score: orderBy === "relevance" && item.score !== null
      ? { relevancePpm: item.score.relevancePpm }
      : null,
  };
  if (item.dedupe !== undefined) {
    result.dedupe = {
      duplicateGroupKey: item.dedupe.duplicateGroupKey,
      confidence: item.dedupe.confidence,
      observedEofProvisional: item.dedupe.observedEofProvisional,
    };
  }
  return result;
}

function publicEvidencePaths(value) {
  return {
    insufficientSample: value.insufficientSample,
    rawMatchCount: decimal(value.rawMatchCount),
    eligibleTurnCount: decimal(value.eligibleTurnCount),
    rawSessionCount: decimal(value.rawSessionCount),
    independentGroupCount: decimal(value.independentGroupCount),
    strongGroupCount: decimal(value.strongGroupCount),
    weakGroupCount: decimal(value.weakGroupCount),
    observedEofProvisionalGroupCount: decimal(value.observedEofProvisionalGroupCount),
    unknownDedupeCount: decimal(value.unknownDedupeCount),
    unknownDedupeSessionCount: decimal(value.unknownDedupeSessionCount),
    pathsTruncated: value.pathsTruncated,
    families: value.families.map((family) => ({
      nodes: family.nodes.map((node) => ({
        providerScopedName: node.providerScopedName,
        repeatBucket: node.repeatBucket,
      })),
      truncated: family.truncated,
      bestRelevancePpm: family.bestRelevancePpm,
      turnCount: decimal(family.turnCount),
      rawSessionCount: decimal(family.rawSessionCount),
      independentGroupCount: decimal(family.independentGroupCount),
      strongGroupCount: decimal(family.strongGroupCount),
      weakGroupCount: decimal(family.weakGroupCount),
      observedEofProvisionalGroupCount: decimal(family.observedEofProvisionalGroupCount),
      unknownDedupeSessionCount: decimal(family.unknownDedupeSessionCount),
      latestAt: new Date(family.latestUnixMs).toISOString(),
      toolStateCounts: decimalObject(family.toolStateCounts, [
        "pending", "completed", "failed", "cancelled", "unknown",
      ]),
      evidenceTurnKeys: [...family.evidenceTurnKeys],
    })),
  };
}

export function projectInsightsSearch(response, context) {
  assertEvaluationClock(response, context);
  if (response.orderBy !== context.orderBy) {
    throw responseError("Engine response changed the Search order");
  }
  if (!Array.isArray(response.results) || response.results.length > context.limit) {
    throw responseError("Engine response exceeds the requested Search limit");
  }
  const snapshot = publicSnapshot(response, context.privacyContext);
  return deepFreeze({
    format: "threadshare-insights-search@v1",
    snapshot,
    sourceFreshness: "not-evaluated",
    versions: {
      projection: response.snapshot.projectionVersion,
      analyzer: response.snapshot.analyzerVersion,
      ranker: response.snapshot.rankerVersion,
    },
    closureEvaluatedAt: context.closureEvaluatedAt,
    quiescenceSeconds: context.quiescenceSeconds,
    orderBy: context.orderBy,
    totalMatchCount: decimal(response.totalMatchCount),
    results: response.results.map((item) => publicSearchResult(item, context.orderBy)),
    evidencePaths: publicEvidencePaths(response.evidencePaths),
  });
}

function publicEvidencePayload(payload) {
  if (payload.kind === "visible-message") return { kind: payload.kind, role: payload.role };
  if (payload.kind === "capability-invocation") {
    return { kind: payload.kind, capabilityKey: payload.capabilityKey };
  }
  if (payload.kind === "capability-result") {
    return {
      kind: payload.kind, providerState: payload.providerState, exitCode: payload.exitCode,
      outputBytes: payload.outputBytes, durationMs: payload.durationMs,
    };
  }
  if (payload.kind === "skill-catalog-entry") {
    return { kind: payload.kind, capabilityKey: payload.capabilityKey };
  }
  if (payload.kind === "skill-load") {
    if (!SKILL_LOAD_EVIDENCE_SOURCES.has(payload.evidenceSource)) {
      throw responseError("Engine response contains an invalid Skill evidence source");
    }
    return {
      kind: payload.kind, capabilityKey: payload.capabilityKey,
      strength: payload.strength, evidenceSource: payload.evidenceSource,
    };
  }
  if (payload.kind === "turn-lifecycle") {
    return { kind: payload.kind, lifecycleState: payload.lifecycleState };
  }
  return {
    kind: payload.kind, statusKind: payload.statusKind, providerState: payload.providerState,
    rolledBackTurnCount: payload.rolledBackTurnCount,
  };
}

function publicEvidenceEntry(entry) {
  if (entry.factKind === "capability-use") {
    return {
      factKind: "capability-use",
      fact: {
        capabilityKey: entry.fact.capabilityKey,
        provider: entry.fact.provider,
        kind: entry.fact.capabilityKind,
        canonicalName: entry.fact.canonicalName,
        turnOrdinal: entry.fact.turnOrdinal,
        originScope: entry.fact.originScope,
        terminalState: entry.fact.providerTerminalState,
        strength: entry.fact.strength,
        evidenceRoles: [...new Set(entry.fact.evidence.map((item) => item.role))].sort(),
      },
    };
  }
  return {
    factKind: "event",
    fact: {
      occurredTurnKey: entry.fact.occurredTurnKey,
      linkedTurns: entry.fact.linkedTurns.map((item) => ({
        turnKey: item.turnKey, role: item.role,
      })),
      originScope: entry.fact.originScope,
      observedTimestamp: entry.fact.observedTimestamp,
      payload: publicEvidencePayload(entry.fact.payload),
    },
  };
}

export function projectInsightsEvidence(response, context) {
  if (response.turn?.turnKey !== context.turnKey ||
      response.turn?.revision !== context.revision) {
    throw turnChanged();
  }
  if (!Array.isArray(response.entries) || response.entries.length > context.limit) {
    throw responseError("Engine response exceeds the requested Evidence limit");
  }
  const codec = createInsightsCursorCodec(context.privacyContext);
  const snapshot = publicSnapshot(response, context.privacyContext);
  const nextCursor = response.nextCursor === null ? null : codec.seal({
    kind: "evidence", snapshot,
    requestDigest: codec.requestDigest({
      turnKey: context.turnKey, revision: context.revision, limit: context.limit,
    }),
    engineCursor: response.nextCursor,
    closureEvaluatedAt: null, quiescenceSeconds: null,
    turnKey: context.turnKey, revision: context.revision,
  });
  return deepFreeze({
    format: "threadshare-insights-evidence@v1",
    snapshot,
    sourceFreshness: "not-evaluated",
    turn: {
      turnKey: response.turn.turnKey,
      revision: response.turn.revision,
      problemText: response.turn.problemText,
      finalAnswerExcerpt: response.turn.finalAnswerExcerpt,
      observedTimestamp: response.turn.observedTimestamp,
      nextUserBoundary: response.turn.nextUserBoundary,
      providerTerminal: response.turn.providerTerminal,
      observedEofClosed: response.turn.observedEofClosed,
      factTruncation: [...response.turn.factTruncation],
    },
    entries: response.entries.map(publicEvidenceEntry),
    nextCursor,
  });
}

function decimalObject(value, fields) {
  if (!plainObject(value)) throw responseError("Engine response contains an invalid count object");
  return Object.fromEntries(fields.map((field) => [field, decimal(value[field])]));
}

function publicCoverage(value, { fullyExcluded = false } = {}) {
  if (!plainObject(value)) throw responseError("Engine response is missing query coverage");
  return {
    scope: "all-indexed-history",
    excludedUndatedInvocationCount: decimal(value.excludedUndatedInvocationCount),
    excludedUndatedTurnCount: decimal(value.excludedUndatedTurnCount),
    excludedUnrevisionedInvocationCount: decimal(value.excludedUnrevisionedInvocationCount),
    excludedUnrevisionedTurnCount: decimal(value.excludedUnrevisionedTurnCount),
    categoriesMayOverlap: true,
    ...(fullyExcluded
      ? { fullyExcludedCapabilityCount: decimal(value.fullyExcludedCapabilityCount) }
      : {}),
  };
}

export function projectInsightsOverview(response, context) {
  return deepFreeze({
    format: "threadshare-insights-overview@v1",
    snapshot: publicSnapshot(response, context.privacyContext),
    sourceFreshness: "not-evaluated",
    closureEvaluatedAt: context.closureEvaluatedAt,
    quiescenceSeconds: context.quiescenceSeconds,
    sessions: decimalObject(response.sessions, ["raw", "eligible", "excluded", "subagentExcluded", "unknown"]),
    scopes: decimalObject(response.scopes, ["main", "subagent", "unknown"]),
    dedupe: decimalObject(response.dedupe, [
      "strongGroup", "weakGroup", "observedEofProvisionalSession", "unknownSession",
    ]),
    turns: decimalObject(response.turns, [
      "indexed", "active", "rolledBack", "unknownVisibility", "hardSealed", "quiescent", "open",
    ]),
    capabilities: decimalObject(response.capabilities, ["total", "tool", "skill"]),
    providers: {
      items: response.providers.items.map((item) => ({
        provider: item.provider,
        rawSessionCount: decimal(item.rawSessionCount),
        eligibleSessionCount: decimal(item.eligibleSessionCount),
        indexedTurnCount: decimal(item.indexedTurnCount),
      })),
      truncated: response.providers.truncated,
    },
    projects: {
      items: response.projects.items.map((item) => ({
        projectKey: item.projectKey,
        rawSessionCount: decimal(item.rawSessionCount),
        eligibleSessionCount: decimal(item.eligibleSessionCount),
        indexedTurnCount: decimal(item.indexedTurnCount),
      })),
      truncated: response.projects.truncated,
    },
    coverage: {
      items: response.coverage.items.map((item) => ({ key: item.key, count: decimal(item.count) })),
      truncated: response.coverage.truncated,
    },
    diagnostics: {
      items: response.diagnostics.items.map((item) => ({ code: item.code, count: decimal(item.count) })),
      truncated: response.diagnostics.truncated,
    },
  });
}

export function projectInsightsCapabilities(response, context) {
  const codec = createInsightsCursorCodec(context.privacyContext);
  const snapshot = publicSnapshot(response, context.privacyContext);
  if (context.cursor !== null) codec.assertSnapshot(context.cursor, snapshot);
  if (!Array.isArray(response.items) || response.items.length > context.limit ||
      response.items.some((item) => item?.kind !== context.kind)) {
    throw responseError("Engine response does not match the requested Capability page");
  }
  const nextCursor = response.nextCursor === null ? null : codec.seal({
    kind: "capabilities",
    snapshot,
    requestDigest: codec.requestDigest({ kind: context.kind, limit: context.limit }),
    engineCursor: response.nextCursor,
    closureEvaluatedAt: context.closureEvaluatedAt,
    quiescenceSeconds: context.quiescenceSeconds,
    turnKey: null,
    revision: null,
  });
  return deepFreeze({
    format: "threadshare-insights-capabilities@v1",
    snapshot,
    sourceFreshness: "not-evaluated",
    kind: context.kind,
    items: response.items.map((item) => ({
      capabilityKey: item.capabilityKey,
      provider: item.provider,
      kind: item.kind,
      canonicalName: item.canonicalName,
    })),
    coverage: publicCoverage(response.coverage, { fullyExcluded: true }),
    nextCursor,
  });
}

function publicResponseTimestamp(value, label, { nullable = false } = {}) {
  if (nullable && value === null) return null;
  try {
    return canonicalTimestamp(value, label).timestamp;
  } catch {
    throw responseError(`Engine response contains an invalid ${label}`);
  }
}

function assertEvaluationClock(response, context) {
  if (response.closureEvaluatedAt !== context.closureEvaluatedAt ||
      response.quiescenceSeconds !== context.quiescenceSeconds) {
    throw responseError("Engine response changed the frozen closure clock");
  }
  publicResponseTimestamp(response.closureEvaluatedAt, "closure evaluation timestamp");
}

function decimalSumOf(value, fields) {
  return fields.reduce((sum, field) => sum + BigInt(value[field]), 0n);
}

function publicUsageItem(item, comparisonRequested, expectedKind) {
  if (!plainObject(item) || typeof item.capabilityKey !== "string" ||
      !HEX64.test(item.capabilityKey) || item.kind !== expectedKind) {
    throw responseError("Engine response contains an invalid Usage item");
  }
  const invocationTerminalCounts = decimalObject(item.invocationTerminalCounts, [
    "invocationTotal", "pending", "completed", "failed", "cancelled", "unknown",
  ]);
  const containingTurnOutcomeCounts = decimalObject(item.containingTurnOutcomeCounts, [
    "distinctTurnTotal", "providerCompleted", "abandoned", "unknown",
  ]);
  const support = {
    ...decimalObject(item.support, [
      "distinctDedupeGroupCount", "strongDedupeGroupCount", "weakDedupeGroupCount",
      "observedEofProvisionalGroupCount", "unknownDedupeSessionCount",
    ]),
    sessionDuplicateMethodCounts: decimalObject(item.support?.sessionDuplicateMethodCounts, [
      "explicitLineage", "exactFirstTurnPrefix",
    ]),
  };
  const recordedInvocationCount = decimal(item.recordedInvocationCount);
  const recordedFailingInvocationCount = decimal(item.recordedFailingInvocationCount);
  const distinctTurnCount = decimal(item.distinctTurnCount);
  const distinctSessionCount = decimal(item.distinctSessionCount);
  const groupedInvocationCount = decimal(item.groupedInvocationCount);
  const ungroupedInvocationCount = decimal(item.ungroupedInvocationCount);
  if (BigInt(groupedInvocationCount) + BigInt(ungroupedInvocationCount) !==
        BigInt(recordedInvocationCount) ||
      BigInt(invocationTerminalCounts.invocationTotal) !== BigInt(recordedInvocationCount) ||
      decimalSumOf(invocationTerminalCounts, [
        "pending", "completed", "failed", "cancelled", "unknown",
      ]) !== BigInt(recordedInvocationCount) ||
      BigInt(containingTurnOutcomeCounts.distinctTurnTotal) !== BigInt(distinctTurnCount) ||
      decimalSumOf(containingTurnOutcomeCounts, [
        "providerCompleted", "abandoned", "unknown",
      ]) !== BigInt(distinctTurnCount) ||
      BigInt(support.strongDedupeGroupCount) + BigInt(support.weakDedupeGroupCount) !==
        BigInt(support.distinctDedupeGroupCount)) {
    throw responseError("Engine response contains inconsistent Usage aggregates");
  }
  let comparison = null;
  if (comparisonRequested) {
    if (!plainObject(item.comparison)) {
      throw responseError("Engine response is missing Usage comparison counts");
    }
    comparison = {
      baselineRecordedInvocationCount: decimal(item.comparison.baselineRecordedInvocationCount),
      currentRecordedInvocationCount: decimal(item.comparison.currentRecordedInvocationCount),
      absoluteRecordedInvocationChange: signedDecimal(
        item.comparison.absoluteRecordedInvocationChange,
      ),
    };
    if (BigInt(comparison.currentRecordedInvocationCount) -
        BigInt(comparison.baselineRecordedInvocationCount) !==
        BigInt(comparison.absoluteRecordedInvocationChange)) {
      throw responseError("Engine response contains an inconsistent Usage comparison");
    }
  } else if (item.comparison !== null) {
    throw responseError("Engine response returned an unexpected Usage comparison");
  }
  if (!plainObject(item.outOfWindow) || item.outOfWindow.scope !== "all-indexed-history") {
    throw responseError("Engine response contains an invalid out-of-window scope");
  }
  const retrySummary = item.outOfWindow.retrySummary === null
    ? null
    : decimalObject(item.outOfWindow.retrySummary, [
        "failedCount", "sameInputRepeatCount", "retryAfterFailureCount",
      ]);
  return {
    capabilityKey: item.capabilityKey,
    provider: item.provider,
    kind: item.kind,
    canonicalName: item.canonicalName,
    recordedInvocationCount,
    recordedFailingInvocationCount,
    distinctTurnCount,
    distinctSessionCount,
    lastUsedAt: publicResponseTimestamp(item.lastUsedAt, "last-used timestamp", {
      nullable: true,
    }),
    invocationTerminalCounts,
    containingTurnOutcomeCounts,
    groupedInvocationCount,
    ungroupedInvocationCount,
    support,
    strengthCounts: decimalObject(item.strengthCounts, ["observed", "confirmed", "inferred"]),
    outOfWindow: { scope: "all-indexed-history", retrySummary },
    comparison,
  };
}

function usageCursorRequest(request) {
  return {
    kind: request.kind,
    window: request.window,
    comparisonWindow: request.comparisonWindow,
    filters: request.filters,
    orderBy: request.orderBy,
    limit: request.limit,
  };
}

export function projectInsightsUsage(response, context) {
  assertEvaluationClock(response, context);
  if (response.orderBy !== context.request.orderBy) {
    throw responseError("Engine response changed the Usage order");
  }
  const codec = createInsightsCursorCodec(context.privacyContext);
  const snapshot = publicSnapshot(response, context.privacyContext);
  if (context.cursor !== null) codec.assertSnapshot(context.cursor, snapshot);
  if (!Array.isArray(response.items) || response.items.length > context.request.limit ||
      typeof response.truncated !== "boolean" ||
      (response.nextCursor !== null && typeof response.nextCursor !== "string") ||
      response.truncated !== (response.nextCursor !== null)) {
    throw responseError("Engine response contains an invalid Usage page");
  }
  const nextCursor = response.nextCursor === null ? null : codec.seal({
    kind: "usage",
    snapshot,
    requestDigest: codec.requestDigest(usageCursorRequest(context.request)),
    engineCursor: response.nextCursor,
    closureEvaluatedAt: context.closureEvaluatedAt,
    quiescenceSeconds: context.quiescenceSeconds,
    turnKey: null,
    revision: null,
  });
  return deepFreeze({
    format: "threadshare-insights-usage@v1",
    snapshot,
    sourceFreshness: "not-evaluated",
    kind: context.request.kind,
    orderBy: context.request.orderBy,
    window: context.request.window,
    comparisonWindow: context.request.comparisonWindow,
    closureEvaluatedAt: context.closureEvaluatedAt,
    quiescenceSeconds: context.quiescenceSeconds,
    items: response.items.map((item) => publicUsageItem(
      item,
      context.request.comparisonWindow !== null,
      context.request.kind,
    )),
    totalCandidateCount: decimal(response.totalCandidateCount),
    truncated: response.truncated,
    coverage: publicCoverage(response.coverage, { fullyExcluded: true }),
    nextCursor,
  });
}

function publicActivitySupport(value) {
  const support = decimalObject(value, [
    "distinctDedupeGroupCount", "strongDedupeGroupCount", "weakDedupeGroupCount",
    "observedEofProvisionalGroupCount", "unknownDedupeSessionCount",
  ]);
  if (BigInt(support.strongDedupeGroupCount) + BigInt(support.weakDedupeGroupCount) !==
      BigInt(support.distinctDedupeGroupCount)) {
    throw responseError("Engine response contains inconsistent Activity support");
  }
  return support;
}

function publicActivityBucket(row) {
  const distinctTurnCount = decimal(row.distinctTurnCount);
  const currentClosureCounts = decimalObject(row.currentClosureCounts, [
    "hardSealed", "quiescent", "open",
  ]);
  const turnResultEvidenceCounts = decimalObject(row.turnResultEvidenceCounts, [
    "providerCompleted", "abandoned", "unknown",
  ]);
  if (decimalSumOf(currentClosureCounts, ["hardSealed", "quiescent", "open"]) !==
        BigInt(distinctTurnCount) ||
      decimalSumOf(turnResultEvidenceCounts, ["providerCompleted", "abandoned", "unknown"]) !==
        BigInt(distinctTurnCount)) {
    throw responseError("Engine response contains inconsistent Activity Turn counts");
  }
  return {
    bucketStart: publicResponseTimestamp(row.bucketStart, "Activity bucket start"),
    bucketEnd: publicResponseTimestamp(row.bucketEnd, "Activity bucket end"),
    distinctSessionCount: decimal(row.distinctSessionCount),
    distinctTurnCount,
    currentClosureCounts,
    turnResultEvidenceCounts,
    recordedToolInvocationCount: decimal(row.recordedToolInvocationCount),
    recordedSkillInvocationCount: decimal(row.recordedSkillInvocationCount),
    support: publicActivitySupport(row.support),
  };
}

export function projectInsightsActivity(response, context) {
  assertEvaluationClock(response, context);
  if (!Array.isArray(response.buckets) || response.buckets.length > 366 ||
      response.buckets.length !== context.request.bucketCount) {
    throw responseError("Engine response contains an invalid Activity bucket count");
  }
  const bucketMilliseconds = context.request.bucket === "day" ? 86_400_000 : 7 * 86_400_000;
  let expectedStart = Date.parse(context.request.window.observedAtOrAfter);
  for (const row of response.buckets) {
    const expectedEnd = expectedStart + bucketMilliseconds;
    if (row.bucketStart !== new Date(expectedStart).toISOString() ||
        row.bucketEnd !== new Date(expectedEnd).toISOString()) {
      throw responseError("Engine response changed the Activity window");
    }
    expectedStart = expectedEnd;
  }
  if (new Date(expectedStart).toISOString() !== context.request.window.observedBefore) {
    throw responseError("Engine response changed the Activity window");
  }
  return deepFreeze({
    format: "threadshare-insights-activity@v1",
    snapshot: publicSnapshot(response, context.privacyContext),
    sourceFreshness: "not-evaluated",
    bucket: context.request.bucket,
    timeZone: "UTC",
    window: context.request.window,
    closureEvaluatedAt: context.closureEvaluatedAt,
    quiescenceSeconds: context.quiescenceSeconds,
    buckets: response.buckets.map(publicActivityBucket),
    coverage: publicCoverage(response.coverage),
  });
}

function evaluationContext(now, quiescenceSeconds) {
  const milliseconds = now();
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError("now must return a non-negative safe integer");
  }
  if (!Number.isSafeInteger(quiescenceSeconds) ||
      quiescenceSeconds < 60 || quiescenceSeconds > 86_400) {
    throw new TypeError("quiescenceSeconds must be an integer from 60 to 86400");
  }
  return Object.freeze({
    nowUnixMs: String(milliseconds),
    closureEvaluatedAt: new Date(milliseconds).toISOString(),
    quiescenceSeconds,
  });
}

function searchEngineRequest(request, evaluation) {
  return {
    query: request.query,
    filters: request.filters,
    orderBy: request.orderBy,
    limit: request.limit,
    pathLimit: request.pathLimit,
    nowUnixMs: evaluation.nowUnixMs,
    quiescenceSeconds: evaluation.quiescenceSeconds,
  };
}

function usageEngineWindow(window) {
  return {
    observedAtOrAfterUnixMs: String(Date.parse(window.observedAtOrAfter)),
    observedBeforeUnixMs: String(Date.parse(window.observedBefore)),
  };
}

function usageEngineRequest(request, cursor, evaluation) {
  return {
    kind: request.kind,
    window: usageEngineWindow(request.window),
    comparisonWindow: request.comparisonWindow === null
      ? null
      : usageEngineWindow(request.comparisonWindow),
    filters: {
      providers: request.filters.providers,
      projectKeys: request.filters.projectKeys,
      closureStates: request.filters.closureStates,
      capabilityTerminalStates: [],
    },
    orderBy: request.orderBy,
    cursor: cursor?.engineCursor ?? null,
    limit: request.limit,
    nowUnixMs: evaluation.nowUnixMs,
    quiescenceSeconds: evaluation.quiescenceSeconds,
  };
}

function cursorEvaluation(cursor) {
  if (cursor.closureEvaluatedAt === null || cursor.quiescenceSeconds === null) {
    throw staleCursor();
  }
  return Object.freeze({
    nowUnixMs: String(Date.parse(cursor.closureEvaluatedAt)),
    closureEvaluatedAt: cursor.closureEvaluatedAt,
    quiescenceSeconds: cursor.quiescenceSeconds,
  });
}

export async function executeInsightsQuery(invocation, options = {}) {
  const openState = options.openState ?? openExistingInsightsState;
  const state = await openState(options.stateOptions ?? options);
  const createReader = options.createReader ?? createInsightsQueryReader;
  const reader = createReader({
    ...options.readerOptions,
    paths: state.paths,
    originSecretEpoch: state.originSecretEpoch,
  });
  const evaluation = evaluationContext(options.now ?? Date.now, options.quiescenceSeconds ?? 300);
  const codec = createInsightsCursorCodec(state.privacyContext);
  try {
    if (invocation.action === "overview") {
      const response = await reader.overview({
        nowUnixMs: evaluation.nowUnixMs,
        quiescenceSeconds: evaluation.quiescenceSeconds,
      }, { signal: options.signal });
      return projectInsightsOverview(response, { ...evaluation, privacyContext: state.privacyContext });
    }
    if (invocation.action === "search") {
      const request = invocation.query === null
        ? normalizeInsightsSearchRequest(await readInsightsQueryRequest(invocation.requestSource, options))
        : normalizeInsightsSearchRequest({
            format: "threadshare-insights-search-request@v1",
            query: invocation.query,
            limit: invocation.limit,
          });
      const response = await reader.search(searchEngineRequest(request, evaluation), {
        signal: options.signal,
      });
      return projectInsightsSearch(response, {
        ...evaluation,
        privacyContext: state.privacyContext,
        orderBy: request.orderBy,
        limit: request.limit,
      });
    }
    if (invocation.action === "capabilities") {
      const digestRequest = { kind: invocation.kind, limit: invocation.limit };
      const cursor = invocation.cursor === null ? null : codec.open(invocation.cursor, {
        kind: "capabilities", request: digestRequest,
      });
      const requestEvaluation = cursor === null ? evaluation : cursorEvaluation(cursor);
      const response = await reader.capabilities({
        kind: invocation.kind,
        cursor: cursor?.engineCursor ?? null,
        limit: invocation.limit,
      }, { signal: options.signal });
      return projectInsightsCapabilities(response, {
        privacyContext: state.privacyContext,
        kind: invocation.kind,
        limit: invocation.limit,
        cursor,
        closureEvaluatedAt: requestEvaluation.closureEvaluatedAt,
        quiescenceSeconds: requestEvaluation.quiescenceSeconds,
      });
    }
    if (invocation.action === "usage") {
      const request = normalizeInsightsUsageRequest(
        await readInsightsQueryRequest(invocation.requestSource, options),
        invocation.kind,
      );
      const digestRequest = usageCursorRequest(request);
      const cursor = request.cursor === null ? null : codec.open(request.cursor, {
        kind: "usage",
        request: digestRequest,
      });
      const requestEvaluation = cursor === null ? evaluation : cursorEvaluation(cursor);
      const response = await reader.usage(
        usageEngineRequest(request, cursor, requestEvaluation),
        { signal: options.signal },
      );
      return projectInsightsUsage(response, {
        ...requestEvaluation,
        privacyContext: state.privacyContext,
        request,
        cursor,
      });
    }
    if (invocation.action === "activity") {
      const request = normalizeInsightsActivityRequest(
        await readInsightsQueryRequest(invocation.requestSource, options),
      );
      const response = await reader.activity({
        window: request.window,
        filters: request.filters,
        bucket: request.bucket,
        timeZone: "UTC",
        nowUnixMs: evaluation.nowUnixMs,
        quiescenceSeconds: evaluation.quiescenceSeconds,
      }, { signal: options.signal });
      return projectInsightsActivity(response, {
        ...evaluation,
        privacyContext: state.privacyContext,
        request,
      });
    }
    if (invocation.action === "query") {
      const input = await readInsightsQueryRequest(invocation.requestSource, options);
      return await executeInsightsDeepQueryRequest(input, {
        privacyContext: state.privacyContext,
        reader,
        signal: options.signal,
        evaluatedAt: evaluation.closureEvaluatedAt,
      });
    }
    if (invocation.action === "recipe") {
      const input = await readInsightsQueryRequest(invocation.requestSource, options);
      if (invocation.name === "delivery-trace@1") {
        return await executeInsightsDeliveryTraceRequest(input, {
          paths: state.paths,
          privacyContext: state.privacyContext,
          reader,
          signal: options.signal,
          evaluatedAt: evaluation.closureEvaluatedAt,
          readConfig: options.readConfig ?? readExistingInsightsConfig,
          cwd: options.cwd ?? process.cwd(),
        });
      }
      return await executeInsightsRecipeRequest(invocation.name, input, {
        privacyContext: state.privacyContext,
        reader,
        signal: options.signal,
        evaluatedAt: evaluation.closureEvaluatedAt,
      });
    }
    if (invocation.action === "evidence-v2") {
      const input = await readInsightsQueryRequest(invocation.requestSource, options);
      if (input?.format === "threadshare-insights-git-diff-evidence-request@v1") {
        return await executeInsightsGitDiffEvidenceRequest(input, {
          state,
          reader,
          evaluatedAt: evaluation.closureEvaluatedAt,
          signal: options.signal,
          readConfig: options.readConfig ?? readExistingInsightsConfig,
          resolveRepository: options.resolveRepository ?? resolveGitRepository,
          readGitDiff: options.readGitDiff ?? readGitDiffEvidence,
        });
      }
      return await executeInsightsDeepEvidenceRequest(input, {
        privacyContext: state.privacyContext,
        reader,
        signal: options.signal,
      });
    }
    if (invocation.action === "evidence") {
      const digestRequest = {
        turnKey: invocation.turnKey,
        revision: invocation.revision,
        limit: invocation.limit,
      };
      const cursor = invocation.cursor === null ? null : codec.open(invocation.cursor, {
        kind: "evidence",
        request: digestRequest,
        turnKey: invocation.turnKey,
        revision: invocation.revision,
      });
      const response = await reader.evidence({
        turnKey: invocation.turnKey,
        expectedRevision: invocation.revision,
        cursor: cursor?.engineCursor ?? null,
        limit: invocation.limit,
      }, { signal: options.signal });
      const projected = projectInsightsEvidence(response, {
        privacyContext: state.privacyContext,
        turnKey: invocation.turnKey,
        revision: invocation.revision,
        limit: invocation.limit,
      });
      if (cursor !== null) codec.assertSnapshot(cursor, projected.snapshot);
      return projected;
    }
    throw requestError("Insights query action is not available");
  } finally {
    await reader.close();
  }
}

export function formatInsightsQueryResult(result) {
  return `${JSON.stringify(result)}\n`;
}

export function insightsQueryDiagnostic(error, action) {
  if (error?.name === "CliDiagnostic") return error;
  const direct = new Set([
    "TS_USAGE_MISSING_ARGUMENT",
    "TS_USAGE_UNEXPECTED_ARGUMENT",
    "TS_USAGE_OPTION_NOT_ALLOWED",
    "TS_USAGE_INVALID_VALUE",
    "TS_USAGE_OPTION_DEPENDENCY",
    "TS_USAGE_OPTION_CONFLICT",
    "TS_INPUT_READ_FAILED",
    "TS_QUERY_TOO_LONG",
    "TS_QUERY_TOO_BROAD",
    "TS_INSIGHTS_REQUEST_INVALID",
    "TS_INSIGHTS_NOT_INDEXED",
    "TS_INSIGHTS_QUERY_V2_NOT_READY",
    "TS_INSIGHTS_CURSOR_STALE",
    "TS_INSIGHTS_TURN_CHANGED",
    "TS_INSIGHTS_PAYLOAD_CHANGED",
    "TS_INSIGHTS_EVIDENCE_NOT_FOUND",
    "TS_INSIGHTS_COVERAGE_INCOMPLETE",
    "TS_INSIGHTS_ENGINE_TIMEOUT",
    "TS_INSIGHTS_ENGINE_DISCONNECTED",
    "TS_INSIGHTS_ENGINE_UNAVAILABLE",
    "TS_INSIGHTS_ORIGIN_SECRET_MISSING",
    "TS_INSIGHTS_ORIGIN_SECRET_INVALID",
  ]);
  let code = direct.has(error?.code) ? error.code : "TS_OPERATION_FAILED";
  if (error?.code === "QUERY_TOO_LONG") code = "TS_QUERY_TOO_LONG";
  if (error?.code === "QUERY_TOO_BROAD") code = "TS_QUERY_TOO_BROAD";
  if (error?.code === "TURN_REVISION_MISMATCH") code = "TS_INSIGHTS_TURN_CHANGED";
  if (error?.code === "TS_INSIGHTS_EVIDENCE_CHANGED") code = "TS_INSIGHTS_PAYLOAD_CHANGED";
  if (error?.code === "EVIDENCE_INVALID_CURSOR" || error?.code === "USAGE_INVALID_CURSOR") {
    code = "TS_INSIGHTS_CURSOR_STALE";
  }
  if ((error?.fatal === true && !direct.has(error?.code)) || [
    "TS_INSIGHTS_ENGINE_ABORTED",
    "TS_INSIGHTS_ENGINE_INVALID", "TS_INSIGHTS_STORAGE_FAILED",
    "TS_INSIGHTS_STORAGE_CORRUPT", "TS_INSIGHTS_WAL_BACKPRESSURE",
  ].includes(error?.code)) code = "TS_INSIGHTS_ENGINE_UNAVAILABLE";
  const problems = {
    TS_USAGE_MISSING_ARGUMENT: "The Insights query is missing a required argument.",
    TS_USAGE_UNEXPECTED_ARGUMENT: "The Insights query has an unexpected argument.",
    TS_USAGE_OPTION_NOT_ALLOWED: "An option is not valid for this Insights query.",
    TS_USAGE_INVALID_VALUE: "An Insights query option has an invalid value.",
    TS_USAGE_OPTION_DEPENDENCY: "The Insights query is missing a required option.",
    TS_USAGE_OPTION_CONFLICT: "The Insights query contains conflicting options.",
    TS_INPUT_READ_FAILED: "Unable to read the local Insights request.",
    TS_QUERY_TOO_LONG: "The Insights search query is too long.",
    TS_QUERY_TOO_BROAD: "The Insights search query is too broad.",
    TS_INSIGHTS_REQUEST_INVALID: "The Insights request is invalid.",
    TS_INSIGHTS_NOT_INDEXED: "No committed Insights index is available.",
    TS_INSIGHTS_QUERY_V2_NOT_READY: "The committed Insights index has not completed its Fact V2 rebuild.",
    TS_INSIGHTS_CURSOR_STALE: "The Insights cursor no longer matches the committed index.",
    TS_INSIGHTS_TURN_CHANGED: "The requested Turn changed after the search result was read.",
    TS_INSIGHTS_PAYLOAD_CHANGED: "The requested Insights evidence changed after the result was read.",
    TS_INSIGHTS_EVIDENCE_NOT_FOUND: "The requested Insights evidence is no longer available.",
    TS_INSIGHTS_COVERAGE_INCOMPLETE: "The Insights recipe cannot provide complete coverage for this request.",
    TS_INSIGHTS_ENGINE_TIMEOUT: "The local Insights query exceeded its 120 second execution limit.",
    TS_INSIGHTS_ENGINE_DISCONNECTED: "The local Insights Engine stopped before the query completed.",
    TS_INSIGHTS_ORIGIN_SECRET_MISSING: "The Insights origin secret is missing.",
    TS_INSIGHTS_ORIGIN_SECRET_INVALID: "The Insights origin secret is invalid.",
    TS_INSIGHTS_ENGINE_UNAVAILABLE: "The local Insights Engine is unavailable.",
    TS_OPERATION_FAILED: "Unable to complete the local Insights query.",
  };
  return cliDiagnostic(code, problems[code], {
    command: "insights",
    next: code === "TS_INSIGHTS_NOT_INDEXED" || code === "TS_INSIGHTS_QUERY_V2_NOT_READY"
      ? "Run `threadshare insights sync`, then retry the query."
      : code === "TS_INSIGHTS_CURSOR_STALE"
          || code === "TS_INSIGHTS_TURN_CHANGED"
          || code === "TS_INSIGHTS_PAYLOAD_CHANGED"
          || code === "TS_INSIGHTS_EVIDENCE_NOT_FOUND"
        ? "Repeat the preceding Insights query and use its new snapshot, revision, or cursor."
        : code === "TS_INSIGHTS_COVERAGE_INCOMPLETE"
          ? "Run `threadshare insights sync`; use allowDegraded only when partial results are acceptable."
        : code === "TS_INSIGHTS_ENGINE_TIMEOUT"
          ? "Narrow the time window or filters, then retry the Insights query."
        : code === "TS_INSIGHTS_ENGINE_DISCONNECTED"
          ? "Retry once; if it recurs, run `threadshare insights status --verify`."
        : `Check \`threadshare insights --help\` and retry insights ${action ?? "query"}.`,
  });
}
