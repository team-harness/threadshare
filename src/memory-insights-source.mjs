import { createHash } from "node:crypto";
import path from "node:path";

import { canonicalJson } from "./canonical-json.mjs";
import { normalizeInsightsRecipeRequest } from "./insights-query.mjs";
import { scoreCandidateSessions } from "./memory-extraction.mjs";

const MEMORY_EXTRACTION_REQUEST_FORMAT = "threadshare-memory-extraction-request@v1";
const INSIGHTS_EVIDENCE_REQUEST_FORMAT = "threadshare-insights-evidence-request@v2";
const DELIVERY_TRACE_REQUEST_FORMAT = "threadshare-insights-delivery-trace-request@v1";
const RECIPE_REQUEST_FORMAT = "threadshare-insights-recipe-request@v1";
const MAX_WINDOW_MS = 366 * 86_400_000;
const MAX_SEARCH_RESULTS = 200;
const MAX_FILTER_KEYS = 64;
const MAX_EVIDENCE_PAGES = 16_384;
const HEX64 = /^[0-9a-f]{64}$/u;
const CANONICAL_TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const PROVIDERS = new Set(["claude", "codex"]);
const RESULT_EVIDENCE = new Set(["provider-completed", "abandoned", "unknown"]);
const CAPABILITY_STATES = new Set(["pending", "completed", "failed", "cancelled", "unknown"]);

function sourceError(code, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

function requestError(message, cause) {
  return sourceError("TS_INSIGHTS_REQUEST_INVALID", message, cause);
}

function exactKeys(value, allowed, label) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw requestError(`${label} must be an object`);
  }
  for (const key of Object.keys(value)) {
    if (!allowed.includes(key)) throw requestError(`${label} contains unsupported field ${key}`);
  }
}

function timestamp(value, label) {
  if (typeof value !== "string" || !CANONICAL_TIMESTAMP.test(value)) {
    throw requestError(`${label} must be a canonical RFC3339 UTC timestamp`);
  }
  const milliseconds = Date.parse(value);
  if (!Number.isSafeInteger(milliseconds) || new Date(milliseconds).toISOString() !== value) {
    throw requestError(`${label} is invalid`);
  }
  return { value, milliseconds };
}

function stringArray(value, label, { maximum, allowed, hex = false } = {}) {
  if (value === undefined) return [];
  if (!Array.isArray(value) || value.length > maximum) {
    throw requestError(`${label} exceeds its bounded item limit`);
  }
  const result = value.map((item) => {
    if (typeof item !== "string" || item.length === 0) {
      throw requestError(`${label} contains an invalid value`);
    }
    if (hex && !HEX64.test(item)) throw requestError(`${label} contains an invalid opaque id`);
    if (allowed && !allowed.has(item)) throw requestError(`${label} contains an unsupported value`);
    return item;
  }).sort();
  if (new Set(result).size !== result.length) throw requestError(`${label} must be unique`);
  return result;
}

function deepFreeze(value) {
  if (value === null || typeof value !== "object" || Object.isFrozen(value)) return value;
  for (const item of Object.values(value)) deepFreeze(item);
  return Object.freeze(value);
}

function digest(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function sha256Bytes(value) {
  return createHash("sha256").update(value).digest("hex");
}

export function normalizeMemoryExtractionRequest(input) {
  exactKeys(input, ["format", "window", "query", "filters"], "Memory extraction request");
  if (input.format !== MEMORY_EXTRACTION_REQUEST_FORMAT) {
    throw requestError("Memory extraction request format is invalid");
  }
  exactKeys(input.window, ["after", "before"], "Memory extraction window");
  const after = timestamp(input.window.after, "Memory extraction window.after");
  const before = timestamp(input.window.before, "Memory extraction window.before");
  if (after.milliseconds >= before.milliseconds) {
    throw requestError("Memory extraction window must be non-empty");
  }
  if (before.milliseconds - after.milliseconds > MAX_WINDOW_MS) {
    throw requestError("Memory extraction window cannot exceed 366 days");
  }
  const query = input.query ?? "";
  if (typeof query !== "string" || Buffer.byteLength(query, "utf8") > 8 * 1024) {
    throw requestError("Memory extraction query must be a string of at most 8 KiB");
  }
  const filters = input.filters ?? {};
  exactKeys(filters, [
    "providers", "sessionKeys", "toolCapabilityKeys", "skillCapabilityKeys",
    "resultEvidence", "capabilityTerminalStates",
  ], "Memory extraction filters");
  const normalizedFilters = {
    providers: stringArray(filters.providers, "filters.providers", {
      maximum: 2,
      allowed: PROVIDERS,
    }),
    sessionKeys: stringArray(filters.sessionKeys, "filters.sessionKeys", {
      maximum: MAX_FILTER_KEYS,
      hex: true,
    }),
    toolCapabilityKeys: stringArray(filters.toolCapabilityKeys, "filters.toolCapabilityKeys", {
      maximum: MAX_FILTER_KEYS,
      hex: true,
    }),
    skillCapabilityKeys: stringArray(filters.skillCapabilityKeys, "filters.skillCapabilityKeys", {
      maximum: MAX_FILTER_KEYS,
      hex: true,
    }),
    resultEvidence: stringArray(filters.resultEvidence, "filters.resultEvidence", {
      maximum: 3,
      allowed: RESULT_EVIDENCE,
    }),
    capabilityTerminalStates: stringArray(
      filters.capabilityTerminalStates,
      "filters.capabilityTerminalStates",
      { maximum: 5, allowed: CAPABILITY_STATES },
    ),
  };
  if (normalizedFilters.capabilityTerminalStates.length > 0 &&
      normalizedFilters.toolCapabilityKeys.length === 0 &&
      normalizedFilters.skillCapabilityKeys.length === 0) {
    throw requestError("capabilityTerminalStates requires a tool or skill capability filter");
  }
  return deepFreeze({
    format: MEMORY_EXTRACTION_REQUEST_FORMAT,
    window: { after: after.value, before: before.value },
    query,
    filters: normalizedFilters,
  });
}

export function resolveMemoryInsightsScope({
  config,
  privacyContext,
  rootRealpath,
  providers,
  publicRepositoryIdentity = null,
}) {
  if (typeof privacyContext?.projectFingerprint !== "function" ||
      typeof privacyContext?.fingerprint !== "function") {
    throw new TypeError("privacyContext is required");
  }
  const root = path.resolve(rootRealpath);
  const matches = (config?.insights?.repositories ?? []).filter((registration) =>
    typeof registration?.rootDirectory === "string" &&
    path.resolve(registration.rootDirectory) === root);
  if (matches.length === 0) {
    throw sourceError(
      "TS_INSIGHTS_DELIVERY_TRACE_NOT_READY",
      "The bound worktree is not a registered Insights repository",
    );
  }
  if (matches.length !== 1) {
    throw sourceError(
      "TS_INSIGHTS_DELIVERY_TRACE_NOT_READY",
      "The bound worktree matches multiple Insights repository registrations",
    );
  }
  const registration = matches[0];
  const selectedProviders = providers.length === 0 ? ["claude", "codex"] : providers;
  return deepFreeze({
    projectKeys: selectedProviders
      .map((provider) => privacyContext.projectFingerprint(provider, registration.rootDirectory))
      .sort(),
    repositoryKey: privacyContext.fingerprint("repository", registration.repositoryId),
    publicRepositoryIdentity,
    registration: { repositoryId: registration.repositoryId, rootDirectory: registration.rootDirectory },
  });
}

function decimal(value, label) {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/u.test(value)) {
    throw sourceError("TS_INSIGHTS_ENGINE_PROTOCOL", `${label} is not a canonical decimal`);
  }
  return BigInt(value);
}

function assertSameSnapshot(response, expected, label) {
  if (response?.databaseUuid !== expected.databaseUuid || response?.snapshotSeq !== expected.snapshotSeq) {
    throw sourceError(
      "TS_INSIGHTS_PAYLOAD_CHANGED",
      `${label} changed while the extraction input was being assembled`,
    );
  }
}

function searchRequest(request, scope, evaluatedAt) {
  return {
    query: request.query,
    filters: {
      providers: request.filters.providers,
      projectKeys: scope.projectKeys,
      sessionKeys: request.filters.sessionKeys,
      observedAtOrAfterUnixMs: String(Date.parse(request.window.after)),
      observedBeforeUnixMs: String(Date.parse(request.window.before)),
      toolCapabilityKeys: request.filters.toolCapabilityKeys,
      skillCapabilityKeys: request.filters.skillCapabilityKeys,
      resultEvidence: request.filters.resultEvidence,
      closureStates: ["hard-sealed"],
      capabilityTerminalStates: request.filters.capabilityTerminalStates,
    },
    orderBy: "observed-desc",
    limit: MAX_SEARCH_RESULTS,
    pathLimit: 0,
    nowUnixMs: String(Date.parse(evaluatedAt)),
    quiescenceSeconds: 300,
  };
}

function parseEvidenceLines(content) {
  const events = new Map();
  const eventOrder = [];
  const payloads = new Map();
  for (const rawLine of content.split("\n")) {
    if (rawLine.length === 0) continue;
    let line;
    try {
      line = JSON.parse(rawLine);
    } catch (cause) {
      throw sourceError("TS_INSIGHTS_ENGINE_PROTOCOL", "Turn evidence contains invalid JSONL", cause);
    }
    if (line?.event) {
      if (events.has(line.event.eventKey)) {
        throw sourceError("TS_INSIGHTS_ENGINE_PROTOCOL", "Turn evidence repeats an event");
      }
      events.set(line.event.eventKey, line.event);
      eventOrder.push(line.event.eventKey);
    } else if (line?.payload) {
      if (payloads.has(line.payload.payloadKey)) {
        throw sourceError("TS_INSIGHTS_ENGINE_PROTOCOL", "Turn evidence repeats a payload");
      }
      payloads.set(line.payload.payloadKey, { metadata: line.payload, chunks: [] });
    } else if (line?.payloadChunk) {
      const payload = payloads.get(line.payloadChunk.payloadKey);
      if (payload === undefined) {
        throw sourceError("TS_INSIGHTS_ENGINE_PROTOCOL", "Turn evidence has an orphan payload chunk");
      }
      payload.chunks.push(line.payloadChunk);
    }
  }
  const payloadsByEvent = new Map();
  for (const payload of payloads.values()) {
    if (payload.metadata.completeness !== "full" || !events.has(payload.metadata.eventKey)) {
      throw sourceError("TS_INSIGHTS_ENGINE_PROTOCOL", "Turn evidence payload is incomplete or orphaned");
    }
    payload.chunks.sort((left, right) => {
      const leftOrdinal = BigInt(left.ordinal);
      const rightOrdinal = BigInt(right.ordinal);
      return leftOrdinal < rightOrdinal ? -1 : leftOrdinal > rightOrdinal ? 1 : 0;
    });
    const content = payload.chunks.map((chunk, index) => {
      const bytes = Buffer.from(chunk.content, "utf8");
      if (BigInt(chunk.ordinal) !== BigInt(index) ||
          BigInt(chunk.byteLength) !== BigInt(bytes.byteLength) ||
          sha256Bytes(bytes) !== chunk.sha256) {
        throw sourceError("TS_INSIGHTS_PAYLOAD_CHANGED", "Turn evidence payload chunk digest changed");
      }
      return chunk.content;
    }).join("");
    if (Buffer.byteLength(content, "utf8") !== Number(payload.metadata.byteLength) ||
        sha256Bytes(Buffer.from(content, "utf8")) !== payload.metadata.sha256) {
      throw sourceError("TS_INSIGHTS_PAYLOAD_CHANGED", "Turn evidence payload digest changed");
    }
    const list = payloadsByEvent.get(payload.metadata.eventKey) ?? [];
    list.push({ ...payload.metadata, content });
    payloadsByEvent.set(payload.metadata.eventKey, list);
  }
  return { events, eventOrder, payloadsByEvent };
}

function materializeTurnEvidence(content, turn, turnIndex) {
  const parsed = parseEvidenceLines(content);
  const events = [];
  let toolInvocations = 0;
  for (const eventKey of parsed.eventOrder) {
    const envelope = parsed.events.get(eventKey);
    if (envelope.turnKey !== turn.turnKey) continue;
    if (envelope.completeness !== "full") {
      throw sourceError("TS_INSIGHTS_ENGINE_PROTOCOL", "A selected Turn contains incomplete evidence");
    }
    if (envelope.kind === "capability-invocation") toolInvocations += 1;
    if (envelope.kind === "skill-load") toolInvocations += 1;
    const payloads = (parsed.payloadsByEvent.get(eventKey) ?? []).sort((left, right) =>
      left.kind.localeCompare(right.kind) || left.payloadKey.localeCompare(right.payloadKey));
    let role;
    let admitted;
    if (envelope.kind === "visible-message" &&
        (envelope.metadata?.role === "user" || envelope.metadata?.role === "assistant")) {
      role = envelope.metadata.role;
      admitted = payloads.filter((payload) => payload.kind === "message-content");
    } else if (envelope.kind === "capability-invocation") {
      role = "tool_call";
      admitted = payloads.filter((payload) => payload.kind === "tool-input");
    } else if (envelope.kind === "capability-result") {
      role = "tool_result";
      admitted = payloads.filter((payload) =>
        payload.kind === "tool-output" || payload.kind === "error-content");
    } else {
      continue;
    }
    if (admitted.length === 0) continue;
    const text = admitted.map((payload) => payload.content).join("\n");
    const payloadSha256 = admitted.length === 1
      ? admitted[0].sha256
      : digest(admitted.map(({ payloadKey, sha256 }) => ({ payloadKey, sha256 })));
    events.push({ role, text, payloadSha256 });
  }
  if (events.length === 0) {
    throw sourceError("TS_INSIGHTS_EVIDENCE_NOT_FOUND", "A selected Turn has no extractable content");
  }
  return {
    turn: { turnIndex, turnRevision: turn.revision, events },
    toolInvocations,
  };
}

async function readCompleteTurn(reader, turn, turnIndex, snapshot, signal) {
  let cursor = null;
  let content = "";
  let expectedDigest = null;
  let totalBytes = null;
  let expectedStart = 0n;
  for (let page = 0; page < MAX_EVIDENCE_PAGES; page += 1) {
    const response = await reader.evidenceV2({
      format: INSIGHTS_EVIDENCE_REQUEST_FORMAT,
      target: { kind: "turn", turnKey: turn.turnKey, revision: turn.revision },
      include: ["envelope", "payload"],
      cursor,
      maxBytes: 1_048_576,
    }, { signal });
    assertSameSnapshot(response, snapshot, "Turn evidence");
    if (response.revision !== turn.revision || response.target?.turnKey !== turn.turnKey) {
      throw sourceError("TS_INSIGHTS_PAYLOAD_CHANGED", "A selected Turn revision changed");
    }
    if (expectedDigest === null) {
      expectedDigest = response.payloadSha256;
      totalBytes = response.totalBytes;
    } else if (expectedDigest !== response.payloadSha256 || totalBytes !== response.totalBytes) {
      throw sourceError("TS_INSIGHTS_PAYLOAD_CHANGED", "Turn evidence paging input changed");
    }
    if (BigInt(response.range.start) !== expectedStart) {
      throw sourceError("TS_INSIGHTS_ENGINE_PROTOCOL", "Turn evidence pages are not contiguous");
    }
    content += response.content;
    expectedStart = BigInt(response.range.end);
    if (response.complete) {
      if (expectedStart !== decimal(totalBytes, "Turn evidence totalBytes") ||
          sha256Bytes(Buffer.from(content, "utf8")) !== expectedDigest) {
        throw sourceError("TS_INSIGHTS_PAYLOAD_CHANGED", "Turn evidence stream digest changed");
      }
      const materialized = materializeTurnEvidence(content, turn, turnIndex);
      return {
        ...materialized,
        evidencePayloadSha256: expectedDigest,
      };
    }
    if (response.nextCursor === null) {
      throw sourceError("TS_INSIGHTS_ENGINE_PROTOCOL", "Incomplete Turn evidence has no cursor");
    }
    cursor = response.nextCursor;
  }
  throw sourceError("TS_QUERY_TOO_BROAD", "Turn evidence exceeds the bounded paging limit");
}

function traceNodeKey(reference) {
  return `${reference.kind}:${reference.key}`;
}

function transformDeliveryTrace(nodes, edges, scope) {
  const nodeByKey = new Map(nodes.map((node) => [traceNodeKey(node), node]));
  const transformed = [];
  for (const edge of edges) {
    const commitRef = edge.from.kind === "git-commit"
      ? edge.from : edge.to.kind === "git-commit" ? edge.to : null;
    const fileRef = edge.from.kind === "file"
      ? edge.from : edge.to.kind === "file" ? edge.to : null;
    if (commitRef !== null) {
      const commit = nodeByKey.get(traceNodeKey(commitRef));
      if (commit?.attributes?.repositoryKey === scope.repositoryKey &&
          typeof commit.attributes.objectId === "string") {
        transformed.push({
          kind: "commit",
          relation: edge.relation,
          strength: edge.strength,
          limitations: [...edge.limitations],
          revision: edge.revision,
          pointer: {
            commitHash: commit.attributes.objectId,
            ...(scope.publicRepositoryIdentity === null
              ? {} : { repository: scope.publicRepositoryIdentity }),
          },
        });
      }
    }
    if (fileRef !== null) {
      const file = nodeByKey.get(traceNodeKey(fileRef));
      if (file?.attributes?.repositoryKey !== scope.repositoryKey ||
          typeof file.attributes.path !== "string") continue;
      transformed.push({
        kind: "path",
        relation: edge.relation,
        strength: edge.strength,
        limitations: [...edge.limitations],
        revision: edge.revision,
        pointer: { path: file.attributes.path },
      });
    }
  }
  transformed.sort((left, right) => canonicalJson(left).localeCompare(canonicalJson(right)));
  return transformed;
}

async function readTraceRoot(reader, root, request, snapshot, evaluatedAt, signal) {
  let cursor = null;
  const nodes = new Map();
  const edges = new Map();
  for (let page = 0; page < MAX_EVIDENCE_PAGES; page += 1) {
    const response = await reader.deliveryTrace({
      format: DELIVERY_TRACE_REQUEST_FORMAT,
      root,
      window: request.window,
      direction: "both",
      maxDepth: 3,
      includeCandidateEdges: false,
      includeContextualEdges: false,
      limit: 200,
      cursor,
      evaluatedAt,
    }, { signal });
    assertSameSnapshot(response, snapshot, "Delivery Trace");
    if (response.coverage?.repositoryState !== "complete" ||
        response.coverage?.unselectedRepositoryCount !== "0") {
      throw sourceError(
        "TS_INSIGHTS_DELIVERY_TRACE_NOT_READY",
        "Delivery Trace does not uniquely and completely cover the bound repository",
      );
    }
    for (const node of response.nodes) nodes.set(traceNodeKey(node), node);
    for (const edge of response.edges) edges.set(digest(edge), edge);
    if (response.nextCursor === null) {
      if (response.truncated === true) {
        throw sourceError("TS_INSIGHTS_ENGINE_PROTOCOL", "Truncated Delivery Trace has no cursor");
      }
      return { nodes, edges };
    }
    cursor = response.nextCursor;
  }
  throw sourceError("TS_QUERY_TOO_BROAD", "Delivery Trace exceeds the bounded paging limit");
}

async function readSessionTrace(reader, sessionKey, request, scope, snapshot, evaluatedAt, signal) {
  const combined = await readTraceRoot(
    reader,
    { kind: "session", key: sessionKey },
    request,
    snapshot,
    evaluatedAt,
    signal,
  );
  const commitKeys = [...combined.nodes.values()]
    .filter((node) => node.kind === "git-commit" &&
      node.attributes?.repositoryKey === scope.repositoryKey)
    .map((node) => node.key)
    .sort();
  for (const commitKey of commitKeys) {
    const commitTrace = await readTraceRoot(
      reader,
      { kind: "git-commit", key: commitKey },
      request,
      snapshot,
      evaluatedAt,
      signal,
    );
    for (const [key, node] of commitTrace.nodes) combined.nodes.set(key, node);
    for (const [key, edge] of commitTrace.edges) combined.edges.set(key, edge);
  }
  return transformDeliveryTrace(
    [...combined.nodes.values()],
    [...combined.edges.values()],
    scope,
  );
}

async function recoveredFailureCount(reader, sessionKey, request, scope, snapshot, evaluatedAt, signal) {
  const recipeRequest = normalizeInsightsRecipeRequest({
    format: RECIPE_REQUEST_FORMAT,
    window: request.window,
    filters: {
      providers: request.filters.providers,
      projectKeys: scope.projectKeys,
      sessionKeys: [sessionKey],
    },
    limit: 50,
    allowDegraded: false,
  }, { name: "failure-chains@1", evaluatedAt });
  const response = await reader.recipe(recipeRequest, { signal });
  assertSameSnapshot(response, snapshot, "Failure-chain recipe");
  if (response.truncated === true || decimal(response.totalItemCount, "Failure-chain total") >
      BigInt(response.items.length)) {
    throw sourceError("TS_QUERY_TOO_BROAD", "Failure-chain scoring is incomplete; narrow the filter");
  }
  return response.items.filter((item) => item.status === "resolved").length;
}

function selectedTurnSet(results) {
  return results.map((turn) => ({
    sessionKey: turn.sessionKey,
    turnKey: turn.turnKey,
    revision: turn.revision,
    observedTimestamp: turn.observedTimestamp,
  })).sort((left, right) =>
    left.sessionKey.localeCompare(right.sessionKey) || left.turnKey.localeCompare(right.turnKey));
}

async function collectOnce({ reader, request, scope, evaluatedAt, signal }) {
  const response = await reader.search(searchRequest(request, scope, evaluatedAt), { signal });
  const snapshot = {
    databaseUuid: response.databaseUuid,
    snapshotSeq: response.snapshot?.snapshotSeq,
  };
  if (typeof snapshot.databaseUuid !== "string" ||
      typeof snapshot.snapshotSeq !== "string") {
    throw sourceError("TS_INSIGHTS_ENGINE_PROTOCOL", "Insights Search omitted its snapshot identity");
  }
  const total = decimal(response.totalMatchCount, "Search totalMatchCount");
  if (total > BigInt(MAX_SEARCH_RESULTS) || total !== BigInt(response.results.length)) {
    throw sourceError(
      "TS_QUERY_TOO_BROAD",
      "The extraction filter matches more Turns than can be read completely; narrow the filter",
    );
  }
  for (const result of response.results) {
    if (result.closureState !== "hard-sealed" || !scope.projectKeys.includes(result.projectKey)) {
      throw sourceError("TS_INSIGHTS_ENGINE_PROTOCOL", "Insights Search escaped the extraction scope");
    }
  }
  const requestDigest = digest({ request, scope: {
    projectKeys: scope.projectKeys,
    repositoryKey: scope.repositoryKey,
  } });
  const resultSetDigest = digest({ requestDigest, turns: selectedTurnSet(response.results) });
  const grouped = new Map();
  for (const turn of response.results) {
    const group = grouped.get(turn.sessionKey) ?? [];
    group.push(turn);
    grouped.set(turn.sessionKey, group);
  }
  const sessions = [];
  const rejected = [];
  for (const [sessionKey, rawTurns] of grouped) {
    rawTurns.sort((left, right) =>
      left.observedTimestamp.localeCompare(right.observedTimestamp) ||
      left.turnKey.localeCompare(right.turnKey));
    if (rawTurns.length < 3) {
      rejected.push({
        sessionKey,
        eligibleTurns: rawTurns.length,
        reasons: ["insufficient-eligible-turns"],
      });
      continue;
    }
    const materialized = [];
    let toolInvocations = 0;
    const turnBindings = [];
    for (const [turnIndex, rawTurn] of rawTurns.entries()) {
      const loaded = await readCompleteTurn(reader, rawTurn, turnIndex, snapshot, signal);
      materialized.push(loaded.turn);
      toolInvocations += loaded.toolInvocations;
      turnBindings.push({
        turnKey: rawTurn.turnKey,
        revision: rawTurn.revision,
        evidencePayloadSha256: loaded.evidencePayloadSha256,
      });
    }
    const deliveryEdges = await readSessionTrace(
      reader, sessionKey, request, scope, snapshot, evaluatedAt, signal,
    );
    const recoveredFailureChains = await recoveredFailureCount(
      reader, sessionKey, request, scope, snapshot, evaluatedAt, signal,
    );
    const directDeliveryEdges = deliveryEdges.filter((edge) => edge.strength === "direct").length;
    const observedDeliveryEdges = deliveryEdges.filter((edge) => edge.strength === "observed").length;
    const sourceBindingDigest = digest({
      requestDigest,
      resultSetDigest,
      sessionKey,
      turnBindings,
      deliveryEdges,
    });
    sessions.push({
      sessionKey,
      provider: rawTurns[0].provider,
      projectKey: rawTurns[0].projectKey,
      project: scope.publicRepositoryIdentity,
      timeWindow: { start: request.window.after, end: request.window.before },
      scope: "main",
      excluded: false,
      turns: materialized,
      turnBindings,
      deliveryEdges,
      directDeliveryEdges,
      observedDeliveryEdges,
      recoveredFailureChains,
      toolInvocations,
      conclusiveFinalAnswer: rawTurns.some((turn) =>
        typeof turn.finalAnswerExcerpt === "string" && turn.finalAnswerExcerpt.trim() !== ""),
      sourceBindingDigest,
    });
  }
  const scored = scoreCandidateSessions(sessions.map((session) => ({
    ...session,
    turns: session.turns.map(() => ({ eligible: true, active: true, sealed: "hard" })),
  })));
  const sessionByKey = new Map(sessions.map((session) => [session.sessionKey, session]));
  const ordered = scored.selected.map((score) => ({ ...sessionByKey.get(score.sessionKey), ...score }));
  return deepFreeze({
    databaseUuid: snapshot.databaseUuid,
    snapshotSeq: snapshot.snapshotSeq,
    evaluatedAt,
    request,
    requestDigest,
    resultSetDigest,
    sessions: ordered,
    rejected: [...rejected, ...scored.rejected],
  });
}

export async function collectMemoryInsightsSelection(options) {
  try {
    return await collectOnce(options);
  } catch (error) {
    if (error?.code !== "TS_INSIGHTS_PAYLOAD_CHANGED") throw error;
    return collectOnce(options);
  }
}

export const MEMORY_EXTRACTION_REQUEST_SCHEMA = Object.freeze({
  format: MEMORY_EXTRACTION_REQUEST_FORMAT,
  maxWindowDays: 366,
  maxMatchedTurns: MAX_SEARCH_RESULTS,
});
