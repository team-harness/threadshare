import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import { Readable } from "node:stream";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  createInsightsCursorCodec,
  executeInsightsQuery,
  insightsQueryDiagnostic,
  normalizeInsightsActivityRequest,
  normalizeInsightsDeepEvidenceRequest,
  normalizeInsightsDeepQueryRequest,
  normalizeInsightsRecipeRequest,
  normalizeInsightsSearchRequest,
  normalizeInsightsUsageRequest,
  parseInsightsQueryInvocation,
  projectInsightsActivity,
  projectInsightsCapabilities,
  projectInsightsEvidence,
  projectInsightsSearch,
  projectInsightsUsage,
  readInsightsQueryRequest,
} from "../src/insights-query.mjs";
import { createPrivacyContext } from "../src/session-facts.mjs";

const KEY = "1".repeat(64);
const TURN_KEY = "2".repeat(64);
const SESSION_KEY = "3".repeat(64);
const REVISION = "4".repeat(64);
const DATABASE_UUID = "11111111-2222-4333-8444-555555555555";
const RECIPE_ITEMS_URL = new URL("./fixtures/insights-recipe-items.v1.json", import.meta.url);

function privacyContext() {
  return createPrivacyContext({
    secret: Buffer.alloc(32, 7),
    originSecretEpoch: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
  });
}

function usageResponse(nextCursor = null, orderBy = "absolute-recorded-invocation-change") {
  return {
    type: "CAPABILITY_USAGE",
    requestId: "11",
    databaseUuid: DATABASE_UUID,
    snapshotSeq: "7",
    closureEvaluatedAt: "2026-08-11T00:00:00.000Z",
    quiescenceSeconds: 300,
    orderBy,
    totalCandidateCount: 1,
    truncated: nextCursor !== null,
    coverage: {
      excludedUndatedInvocationCount: 1,
      excludedUndatedTurnCount: 1,
      excludedUnrevisionedInvocationCount: 2,
      excludedUnrevisionedTurnCount: 2,
      fullyExcludedCapabilityCount: 3,
      privatePath: "/private/session.jsonl",
    },
    items: [{
      capabilityKey: KEY,
      provider: "codex",
      kind: "tool",
      canonicalName: "Read",
      recordedInvocationCount: 7,
      recordedFailingInvocationCount: 2,
      distinctTurnCount: 5,
      distinctSessionCount: 4,
      lastUsedAt: "2026-08-10T01:02:03.000Z",
      invocationTerminalCounts: {
        invocationTotal: 7, pending: 0, completed: 5, failed: 2, cancelled: 0, unknown: 0,
      },
      containingTurnOutcomeCounts: {
        distinctTurnTotal: 5, providerCompleted: 3, abandoned: 1, unknown: 1,
      },
      groupedInvocationCount: 5,
      ungroupedInvocationCount: 2,
      support: {
        distinctDedupeGroupCount: 3,
        strongDedupeGroupCount: 2,
        weakDedupeGroupCount: 1,
        observedEofProvisionalGroupCount: 1,
        unknownDedupeSessionCount: 1,
        sessionDuplicateMethodCounts: { explicitLineage: 2, exactFirstTurnPrefix: 1 },
      },
      strengthCounts: { observed: 5, confirmed: 1, inferred: 1 },
      outOfWindow: {
        scope: "all-indexed-history",
        retrySummary: { failedCount: 9, sameInputRepeatCount: 4, retryAfterFailureCount: 3 },
      },
      comparison: {
        baselineRecordedInvocationCount: 5,
        currentRecordedInvocationCount: 7,
        absoluteRecordedInvocationChange: "2",
      },
      exactObservedName: "PRIVATE_EXACT",
      inputFingerprint: "5".repeat(64),
    }],
    nextCursor,
    internalTimingMicros: 44,
  };
}

function activityResponse() {
  return {
    type: "INSIGHTS_ACTIVITY",
    requestId: "12",
    databaseUuid: DATABASE_UUID,
    snapshotSeq: "7",
    closureEvaluatedAt: "2026-08-11T00:00:00.000Z",
    quiescenceSeconds: 300,
    buckets: [{
      bucketStart: "2026-08-10T00:00:00.000Z",
      bucketEnd: "2026-08-11T00:00:00.000Z",
      distinctSessionCount: 4,
      distinctTurnCount: 5,
      currentClosureCounts: { hardSealed: 2, quiescent: 1, open: 2 },
      turnResultEvidenceCounts: { providerCompleted: 3, abandoned: 1, unknown: 1 },
      recordedToolInvocationCount: 7,
      recordedSkillInvocationCount: 3,
      support: {
        distinctDedupeGroupCount: 3,
        strongDedupeGroupCount: 2,
        weakDedupeGroupCount: 1,
        observedEofProvisionalGroupCount: 1,
        unknownDedupeSessionCount: 1,
      },
      rawProviderPath: "/private/session.jsonl",
    }],
    coverage: {
      excludedUndatedInvocationCount: 1,
      excludedUndatedTurnCount: 1,
      excludedUnrevisionedInvocationCount: 2,
      excludedUnrevisionedTurnCount: 2,
    },
    sql: "SELECT private",
  };
}

test("query action parser enforces JSON-only bounded command shapes", () => {
  assert.deepEqual(
    parseInsightsQueryInvocation(
      ["insights", "capabilities", "tool"],
      { format: "json", limit: "25", cursor: "opaque" },
    ),
    { action: "capabilities", kind: "tool", format: "json", limit: 25, cursor: "opaque" },
  );
  assert.deepEqual(
    parseInsightsQueryInvocation(
      ["insights", "query"],
      { format: "json", request: "-" },
    ),
    { action: "query", format: "json", requestSource: "-" },
  );
  assert.deepEqual(
    parseInsightsQueryInvocation(
      ["insights", "recipe", "failure-chains@1"],
      { format: "json", request: "request.json" },
    ),
    {
      action: "recipe", name: "failure-chains@1", format: "json",
      requestSource: "request.json",
    },
  );
  assert.deepEqual(
    parseInsightsQueryInvocation(
      ["insights", "evidence"],
      { format: "json", request: "-" },
    ),
    { action: "evidence-v2", format: "json", requestSource: "-" },
  );
  assert.deepEqual(
    parseInsightsQueryInvocation(
      ["insights", "evidence", TURN_KEY],
      { format: "json", revision: REVISION },
    ),
    {
      action: "evidence", turnKey: TURN_KEY, revision: REVISION,
      format: "json", limit: 50, cursor: null,
    },
  );
  for (const [positionals, options, code] of [
    [["insights", "overview"], {}, "TS_USAGE_OPTION_DEPENDENCY"],
    [["insights", "overview"], { format: "text" }, "TS_USAGE_INVALID_VALUE"],
    [["insights", "search"], { format: "json" }, "TS_USAGE_OPTION_DEPENDENCY"],
    [["insights", "search"], { format: "json", query: "x", request: "-" }, "TS_USAGE_OPTION_CONFLICT"],
    [["insights", "search"], { format: "json", query: "x", cursor: "bad" }, "TS_USAGE_OPTION_NOT_ALLOWED"],
    [["insights", "capabilities"], { format: "json" }, "TS_USAGE_MISSING_ARGUMENT"],
    [["insights", "usage", "tool"], { format: "json" }, "TS_USAGE_OPTION_DEPENDENCY"],
    [["insights", "activity"], { format: "json", request: "-", limit: "2" }, "TS_USAGE_OPTION_NOT_ALLOWED"],
    [["insights", "query"], { format: "json" }, "TS_USAGE_OPTION_DEPENDENCY"],
    [["insights", "query", "extra"], { format: "json", request: "-" }, "TS_USAGE_UNEXPECTED_ARGUMENT"],
    [["insights", "recipe"], { format: "json", request: "-" }, "TS_USAGE_MISSING_ARGUMENT"],
    [["insights", "recipe", "unknown@1"], { format: "json", request: "-" }, "TS_USAGE_INVALID_VALUE"],
    [["insights", "evidence", TURN_KEY], { format: "json", request: "-" }, "TS_USAGE_OPTION_CONFLICT"],
    [["insights", "evidence", TURN_KEY], { format: "json" }, "TS_USAGE_OPTION_DEPENDENCY"],
    [["insights", "evidence"], { format: "json", revision: REVISION }, "TS_USAGE_MISSING_ARGUMENT"],
  ]) {
    assert.throws(
      () => parseInsightsQueryInvocation(positionals, options),
      (error) => error?.code === code,
    );
  }
});

test("deep Query, Recipe, and Evidence public requests normalize into Engine contracts", () => {
  const evaluatedAt = "2026-08-12T00:00:00.000Z";
  assert.deepEqual(normalizeInsightsDeepQueryRequest({
    format: "threadshare-insights-query-request@v2",
    resource: "event",
    where: null,
    shape: { kind: "records", select: ["eventKey"], payloadMode: "reference" },
    orderBy: [
      { field: "observedAt", direction: "desc" },
      { field: "eventKey", direction: "asc" },
    ],
    limit: 10,
    count: "exact",
  }, { evaluatedAt }), {
    format: "threadshare-insights-query-request@v2",
    resource: "event",
    where: null,
    shape: { kind: "records", select: ["eventKey"], payloadMode: "reference" },
    orderBy: [
      { field: "observedAt", direction: "desc" },
      { field: "eventKey", direction: "asc" },
    ],
    limit: 10,
    cursor: null,
    count: "exact",
    evaluatedAt,
  });
  assert.equal(normalizeInsightsRecipeRequest({
    format: "threadshare-insights-recipe-request@v1",
    window: { after: "2026-08-01T00:00:00.000Z", before: evaluatedAt },
    filters: {},
    limit: 20,
  }, { name: "failure-chains@1", evaluatedAt }).name, "failure-chains@1");
  assert.equal(normalizeInsightsDeepEvidenceRequest({
    format: "threadshare-insights-evidence-request@v2",
    target: { kind: "turn", turnKey: TURN_KEY, revision: REVISION },
    include: ["envelope", "payload"],
    maxBytes: 1024,
  }).cursor, null);
});

test("deep Query, Recipe, and Evidence execution publish MAC snapshots without database UUIDs", async () => {
  const context = privacyContext();
  const state = {
    paths: { databaseFile: "/not-read-by-fixture" },
    originSecretEpoch: context.originSecretEpoch,
    privacyContext: context,
  };
  const coverage = {
    matching: {
      fullRecordCount: "1", summaryRecordCount: "0", unloadedRecordCount: "0",
      truncatedRecordCount: "0", unavailableRecordCount: "0", missingTimestampCount: "0",
      missingRevisionCount: "0", missingTokenMetricCount: "0", missingPayloadCount: "0",
    },
    indexedHistory: {
      visibleSessionCount: "1", excludedSessionCount: "0",
      subagentExcludedSessionCount: "0", unknownEligibilitySessionCount: "0",
      pendingPurgeSessionCount: "0", purgedSessionCount: "0",
      missingCoverageRollupSessionCount: "0",
      fts: {
        searchableEventCount: "1", storedNotSearchableEventCount: "0",
        searchablePayloadBytes: "7", storedNotSearchablePayloadBytes: "0",
      },
    },
    degraded: false, diagnostics: [],
  };
  const run = (invocation, request, method, response) => executeInsightsQuery(invocation, {
    async openState() { return state; },
    createReader() {
      return { async [method]() { return response; }, async close() {} };
    },
    input: Readable.from([JSON.stringify(request)]),
    now: () => 1_786_464_000_000,
  });
  const queryRequest = {
    format: "threadshare-insights-query-request@v2",
    resource: "event",
    shape: { kind: "records", select: ["eventKey"] },
    orderBy: [
      { field: "observedAt", direction: "desc" },
      { field: "eventKey", direction: "asc" },
    ],
    limit: 10,
  };
  const query = await run(
    { action: "query", requestSource: "-" }, queryRequest, "queryV2",
    {
      format: "threadshare-insights-query@v2", databaseUuid: DATABASE_UUID,
      snapshotSeq: "7", resource: "event", records: [{ eventKey: TURN_KEY }], groups: null,
      nextCursor: null, totalMatchCount: null, totalGroupCount: null, truncated: false,
      coverage, provenance: { default: "recorded", fields: [] },
      limits: { pageBytes: "3932160", payloadsMayRequireEvidencePaging: true },
    },
  );
  assert.equal(query.snapshot.seq, "7");
  assert.equal(JSON.stringify(query).includes(DATABASE_UUID), false);
  assert.equal(query.records[0].eventKey, TURN_KEY);

  const recipeRequest = {
    format: "threadshare-insights-recipe-request@v1",
    window: {
      after: "2026-08-01T00:00:00.000Z",
      before: "2026-08-12T00:00:00.000Z",
    },
    limit: 20,
  };
  const recipeItems = JSON.parse(await readFile(RECIPE_ITEMS_URL, "utf8"));
  const failureItem = recipeItems.find(({ name }) => name === "failure-chains@1").item;
  const recipe = await run(
    { action: "recipe", name: "failure-chains@1", requestSource: "-" },
    recipeRequest,
    "recipe",
    {
      format: "threadshare-insights-recipe@v1", databaseUuid: DATABASE_UUID,
      snapshotSeq: "7", name: "failure-chains@1", window: recipeRequest.window,
      comparisonWindow: null, evaluatedAt: "2026-08-11T16:00:00.000Z",
      items: [failureItem], totalItemCount: "1", truncated: false,
      coverage, provenance: { default: "recorded", fields: [] },
    },
  );
  assert.equal(recipe.items[0].status, "resolved");
  assert.equal(JSON.stringify(recipe).includes(DATABASE_UUID), false);

  const evidenceRequest = {
    format: "threadshare-insights-evidence-request@v2",
    target: { kind: "turn", turnKey: TURN_KEY, revision: REVISION },
    include: ["payload"],
    maxBytes: 1024,
  };
  const evidence = await run(
    { action: "evidence-v2", requestSource: "-" }, evidenceRequest, "evidenceV2",
    {
      format: "threadshare-insights-evidence@v2", databaseUuid: DATABASE_UUID,
      snapshotSeq: "7", target: evidenceRequest.target, revision: REVISION,
      payloadSha256: KEY, totalBytes: "7", range: { start: "0", end: "7" },
      content: "private", nextCursor: null, complete: true,
    },
  );
  assert.equal(evidence.content, "private");
  assert.equal(JSON.stringify(evidence).includes(DATABASE_UUID), false);
});

test("search request normalization is exact, bounded, and preserves explicit UTC windows", () => {
  const request = normalizeInsightsSearchRequest({
    format: "threadshare-insights-search-request@v1",
    query: "failed build",
    filters: {
      providers: ["codex"],
      projectKeys: [KEY],
      toolCapabilityKeys: [KEY],
      skillCapabilityKeys: [],
      observedAtOrAfter: "2026-01-01T00:00:00.000Z",
      observedBefore: "2026-02-01T00:00:00.000Z",
      resultEvidence: ["provider-completed"],
      closureStates: ["hard-sealed"],
      capabilityTerminalStates: ["failed"],
    },
    orderBy: "observed-desc",
    limit: 20,
    pathLimit: 5,
  });
  assert.equal(request.orderBy, "observed-desc");
  assert.equal(request.filters.observedAtOrAfterUnixMs, "1767225600000");
  assert.equal(request.filters.observedBeforeUnixMs, "1769904000000");
  assert.equal(Object.isFrozen(request.filters), true);

  for (const invalid of [
    { format: "threadshare-insights-search-request@v1" },
    { format: "threadshare-insights-search-request@v1", query: "x", surprise: true },
    { format: "threadshare-insights-search-request@v1", query: "x", orderBy: "recent" },
    {
      format: "threadshare-insights-search-request@v1", query: "x",
      filters: { capabilityTerminalStates: ["failed"] },
    },
    {
      format: "threadshare-insights-search-request@v1", query: "x", orderBy: "observed-desc",
      filters: {},
    },
  ]) {
    assert.throws(
      () => normalizeInsightsSearchRequest(invalid),
      (error) => error?.code === "TS_INSIGHTS_REQUEST_INVALID",
    );
  }
});

test("request input rejects more than 64 KiB before parsing", async () => {
  await assert.rejects(
    readInsightsQueryRequest("-", {
      input: Readable.from([Buffer.alloc(65 * 1024, 0x61)]),
    }),
    (error) => error?.code === "TS_INSIGHTS_REQUEST_INVALID",
  );
  await assert.rejects(
    readInsightsQueryRequest("-", { input: Readable.from(["{bad"]) }),
    (error) => error?.code === "TS_INSIGHTS_REQUEST_INVALID",
  );
  let offset = 0;
  const growing = Buffer.alloc(65 * 1024, 0x61);
  await assert.rejects(
    readInsightsQueryRequest("request.json", {
      async openFile() {
        return {
          async stat() { return { isFile: () => true, size: 2n }; },
          async read(buffer, bufferOffset, length) {
            const bytesRead = Math.min(length, growing.length - offset);
            growing.copy(buffer, bufferOffset, offset, offset + bytesRead);
            offset += bytesRead;
            return { bytesRead };
          },
          async close() {},
        };
      },
    }),
    (error) => error?.code === "TS_INSIGHTS_REQUEST_INVALID",
  );
});

test("request input rejects invalid UTF-8 from stdin and files", async () => {
  const invalid = Buffer.concat([
    Buffer.from('{"format":"', "ascii"), Buffer.from([0xff]), Buffer.from('"}', "ascii"),
  ]);
  await assert.rejects(
    readInsightsQueryRequest("-", { input: Readable.from([invalid]) }),
    (error) => error?.code === "TS_INSIGHTS_REQUEST_INVALID",
  );
  let offset = 0;
  await assert.rejects(
    readInsightsQueryRequest("request.json", {
      async openFile() {
        return {
          async stat() { return { isFile: () => true, size: BigInt(invalid.length) }; },
          async read(buffer, bufferOffset, length) {
            const bytesRead = Math.min(length, invalid.length - offset);
            invalid.copy(buffer, bufferOffset, offset, offset + bytesRead);
            offset += bytesRead;
            return { bytesRead };
          },
          async close() {},
        };
      },
    }),
    (error) => error?.code === "TS_INSIGHTS_REQUEST_INVALID",
  );
});

test("request input aborts while stdin is still open", async () => {
  const input = new Readable({ read() {} });
  const controller = new AbortController();
  const reading = readInsightsQueryRequest("-", { input, signal: controller.signal });
  controller.abort(new Error("stop"));
  await assert.rejects(
    reading,
    (error) => error?.code === "TS_INSIGHTS_ENGINE_ABORTED",
  );
});

test("stdin read failures use the stable input diagnostic", async () => {
  const input = {
    [Symbol.asyncIterator]() {
      return {
        async next() {
          const error = new Error("device failed");
          error.code = "EIO";
          throw error;
        },
        async return() {},
      };
    },
  };
  await assert.rejects(
    readInsightsQueryRequest("-", { input }),
    (error) => error?.code === "TS_INPUT_READ_FAILED",
  );
});

test("Engine evidence drift maps to public cursor and revision diagnostics", () => {
  assert.equal(
    insightsQueryDiagnostic({ code: "TURN_REVISION_MISMATCH" }, "evidence").code,
    "TS_INSIGHTS_TURN_CHANGED",
  );
  assert.equal(
    insightsQueryDiagnostic({ code: "EVIDENCE_INVALID_CURSOR" }, "evidence").code,
    "TS_INSIGHTS_CURSOR_STALE",
  );
  assert.equal(
    insightsQueryDiagnostic({ code: "TS_INSIGHTS_EVIDENCE_CHANGED" }, "evidence").code,
    "TS_INSIGHTS_PAYLOAD_CHANGED",
  );
  assert.equal(
    insightsQueryDiagnostic({ code: "TS_INSIGHTS_EVIDENCE_NOT_FOUND" }, "evidence").code,
    "TS_INSIGHTS_EVIDENCE_NOT_FOUND",
  );
  assert.equal(
    insightsQueryDiagnostic({ code: "TS_INSIGHTS_QUERY_V2_NOT_READY" }, "query").code,
    "TS_INSIGHTS_QUERY_V2_NOT_READY",
  );
  assert.equal(
    insightsQueryDiagnostic({ code: "TS_INSIGHTS_COVERAGE_INCOMPLETE" }, "recipe").code,
    "TS_INSIGHTS_COVERAGE_INCOMPLETE",
  );
  assert.equal(
    insightsQueryDiagnostic({ code: "TS_INSIGHTS_ENGINE_UNAVAILABLE" }, "search").code,
    "TS_INSIGHTS_ENGINE_UNAVAILABLE",
  );
});

test("Usage and Activity require explicit bounded UTC windows", () => {
  const usage = normalizeInsightsUsageRequest({
    format: "threadshare-insights-usage-request@v1",
    window: {
      observedAtOrAfter: "2026-07-01T00:00:00.000Z",
      observedBefore: "2026-08-01T00:00:00.000Z",
    },
    comparisonWindow: {
      observedAtOrAfter: "2026-06-01T00:00:00.000Z",
      observedBefore: "2026-07-01T00:00:00.000Z",
    },
    filters: { providers: ["codex"], projectKeys: [KEY], closureStates: ["hard-sealed"] },
    orderBy: "absolute-recorded-invocation-change",
    limit: 25,
  }, "tool");
  assert.equal(usage.kind, "tool");
  assert.equal(usage.window.observedAtOrAfter, "2026-07-01T00:00:00.000Z");

  const activity = normalizeInsightsActivityRequest({
    format: "threadshare-insights-activity-request@v1",
    window: {
      observedAtOrAfter: "2026-08-03T00:00:00.000Z",
      observedBefore: "2026-08-17T00:00:00.000Z",
    },
    bucket: "week",
    filters: { providers: [], projectKeys: [], closureStates: [] },
  });
  assert.equal(activity.bucketCount, 2);
  assert.equal(activity.timeZone, "UTC");

  for (const invalid of [
    () => normalizeInsightsUsageRequest({
      format: "threadshare-insights-usage-request@v1",
      window: usage.window, orderBy: "absolute-recorded-invocation-change",
    }, "tool"),
    () => normalizeInsightsActivityRequest({
      format: "threadshare-insights-activity-request@v1",
      window: {
        observedAtOrAfter: "2026-08-03T12:00:00.000Z",
        observedBefore: "2026-08-04T12:00:00.000Z",
      },
      bucket: "day",
    }),
    () => normalizeInsightsActivityRequest({
      format: "threadshare-insights-activity-request@v1",
      window: {
        observedAtOrAfter: "2026-08-04T00:00:00.000Z",
        observedBefore: "2026-08-11T00:00:00.000Z",
      },
      bucket: "week",
    }),
  ]) {
    assert.throws(invalid, (error) => error?.code === "TS_INSIGHTS_REQUEST_INVALID");
  }
});

test("public cursor rejects tampering and binds the request and snapshot", () => {
  const codec = createInsightsCursorCodec(privacyContext());
  const snapshot = codec.snapshot(DATABASE_UUID, "7");
  const token = codec.seal({
    kind: "capabilities",
    snapshot,
    requestDigest: codec.requestDigest({ kind: "tool", limit: 25 }),
    engineCursor: KEY,
    closureEvaluatedAt: null,
    quiescenceSeconds: null,
    turnKey: null,
    revision: null,
  });
  assert.equal(codec.open(token, {
    kind: "capabilities",
    request: { kind: "tool", limit: 25 },
  }).engineCursor, KEY);
  assert.throws(
    () => codec.open(`${token.slice(0, -1)}x`, {
      kind: "capabilities", request: { kind: "tool", limit: 25 },
    }),
    (error) => error?.code === "TS_INSIGHTS_CURSOR_STALE",
  );
  assert.throws(
    () => codec.open(token, {
      kind: "capabilities", request: { kind: "skill", limit: 25 },
    }),
    (error) => error?.code === "TS_INSIGHTS_CURSOR_STALE",
  );
  const replacementSnapshot = codec.snapshot("99999999-8888-4777-8666-555555555555", "7");
  assert.throws(
    () => codec.assertSnapshot(codec.open(token, {
      kind: "capabilities", request: { kind: "tool", limit: 25 },
    }), replacementSnapshot),
    (error) => error?.code === "TS_INSIGHTS_CURSOR_STALE",
  );
  assert.notEqual(snapshot.token, DATABASE_UUID);
});

test("Search and Evidence projection are exact privacy whitelists", () => {
  const context = {
    privacyContext: privacyContext(),
    closureEvaluatedAt: "2026-08-11T00:00:00.000Z",
    quiescenceSeconds: 300,
    orderBy: "relevance",
    limit: 1,
  };
  const searchResponse = {
    type: "TURN_SEARCH_RESULTS",
    requestId: "9",
    databaseUuid: DATABASE_UUID,
    snapshot: { snapshotSeq: "7", projectionVersion: 2, analyzerVersion: 1, rankerVersion: 1 },
    orderBy: "relevance",
    closureEvaluatedAt: context.closureEvaluatedAt,
    quiescenceSeconds: context.quiescenceSeconds,
    totalMatchCount: "1",
    scoringTerms: [{ token: "private-term" }],
    results: [{
      turnKey: TURN_KEY, sessionKey: SESSION_KEY, revision: REVISION,
      provider: "codex", projectKey: null,
      observedTimestamp: "2026-08-10T01:02:03.000Z",
      problemExcerpt: "why?", problemTruncated: false,
      finalAnswerExcerpt: "because", finalAnswerTruncated: false,
      closureState: "hard-sealed", resultEvidence: "provider-completed",
      score: {
        relevancePpm: 925000, bm25Rank: 1, rankComponentPpm: 999999,
        idfCoveragePpm: 875000, exact: false, matchedTermIndexes: [0],
      },
      dedupe: {
        duplicateGroupKey: KEY, confidence: "strong", observedEofProvisional: false,
      },
    }],
    evidencePaths: {
      insufficientSample: true, rawMatchCount: 1, eligibleTurnCount: 1,
      rawSessionCount: 1, independentGroupCount: 0, strongGroupCount: 0,
      weakGroupCount: 0, observedEofProvisionalGroupCount: 0,
      unknownDedupeCount: 1, unknownDedupeSessionCount: 1,
      pathsTruncated: false, families: [],
    },
    diagnostic: { analyzeMicros: 9 },
    searchTrace: { candidateTurnKeys: [TURN_KEY] },
  };
  const search = projectInsightsSearch(searchResponse, context);
  assert.deepEqual(Object.keys(search), [
    "format", "snapshot", "sourceFreshness", "versions", "closureEvaluatedAt",
    "quiescenceSeconds", "orderBy", "totalMatchCount", "results", "evidencePaths",
  ]);
  assert.deepEqual(search.results[0].score, { relevancePpm: 925000 });
  assert.equal(JSON.stringify(search).includes("private-term"), false);
  assert.equal(JSON.stringify(search).includes("bm25"), false);
  assert.equal(JSON.stringify(search).includes("databaseUuid"), false);
  const withPath = structuredClone(searchResponse);
  withPath.evidencePaths = {
    insufficientSample: false, rawMatchCount: 1, eligibleTurnCount: 1,
    rawSessionCount: 1, independentGroupCount: 1, strongGroupCount: 1,
    weakGroupCount: 0, observedEofProvisionalGroupCount: 0,
    unknownDedupeCount: 0, unknownDedupeSessionCount: 0,
    pathsTruncated: false,
    families: [{
      nodes: [{ providerScopedName: "codex:Read", repeatBucket: "1" }],
      truncated: false, bestRelevancePpm: 925000, turnCount: 1,
      rawSessionCount: 1, independentGroupCount: 1, strongGroupCount: 1,
      weakGroupCount: 0, observedEofProvisionalGroupCount: 0,
      unknownDedupeSessionCount: 0, latestUnixMs: 1_786_323_723_000,
      toolStateCounts: {
        pending: 0, completed: 1, failed: 0, cancelled: 0, unknown: 0,
        privateMetric: 7,
      },
      evidenceTurnKeys: [TURN_KEY],
    }],
  };
  assert.deepEqual(
    projectInsightsSearch(withPath, context).evidencePaths.families[0].toolStateCounts,
    { pending: "0", completed: "1", failed: "0", cancelled: "0", unknown: "0" },
  );
  assert.throws(
    () => projectInsightsSearch({
      ...searchResponse,
      totalMatchCount: "2",
      results: [
        ...searchResponse.results,
        { ...searchResponse.results[0], turnKey: "a".repeat(64) },
      ],
    }, context),
    (error) => error?.code === "TS_INSIGHTS_ENGINE_INVALID",
  );

  const evidence = projectInsightsEvidence({
    type: "TURN_EVIDENCE_PAGE", requestId: "10", databaseUuid: DATABASE_UUID,
    snapshotSeq: "7",
    turn: {
      turnKey: TURN_KEY, revision: REVISION, problemText: "question",
      finalAnswerExcerpt: "answer", observedTimestamp: "2026-08-10T01:02:03.000Z",
      nextUserBoundary: false, providerTerminal: "completed", observedEofClosed: true,
      providerVisibility: "active", factTruncation: [],
    },
    entries: [{
      factKind: "capability-use",
      fact: {
        useKey: "5".repeat(64), capabilityKey: KEY, provider: "codex",
        capabilityKind: "tool", canonicalName: "Read", turnOrdinal: "1",
        exactObservedName: "PRIVATE_EXACT", originScope: "main",
        originFingerprint: "6".repeat(64), inputFingerprint: "7".repeat(64),
        providerTerminalState: "completed", strength: "observed",
        correlationDigest: "8".repeat(64),
        evidence: [{ eventKey: "9".repeat(64), role: "invocation" }],
      },
    }],
    nextCursor: null,
  }, {
    privacyContext: context.privacyContext, turnKey: TURN_KEY, revision: REVISION, limit: 50,
  });
  assert.deepEqual(evidence.entries[0], {
    factKind: "capability-use",
    fact: {
      capabilityKey: KEY, provider: "codex", kind: "tool", canonicalName: "Read",
      turnOrdinal: "1", originScope: "main", terminalState: "completed",
      strength: "observed", evidenceRoles: ["invocation"],
    },
  });
  for (const canary of ["PRIVATE_EXACT", "originFingerprint", "inputFingerprint", "correlationDigest"] ) {
    assert.equal(JSON.stringify(evidence).includes(canary), false);
  }
});

test("paged projections bind response count and kind to the request", () => {
  const context = {
    privacyContext: privacyContext(), kind: "tool", limit: 50, cursor: null,
    closureEvaluatedAt: "2026-08-11T00:00:00.000Z", quiescenceSeconds: 300,
  };
  const item = {
    capabilityKey: KEY, provider: "codex", kind: "tool", canonicalName: "Read",
  };
  const response = {
    databaseUuid: DATABASE_UUID,
    snapshotSeq: "7",
    items: Array.from({ length: 51 }, (_, index) => ({
      ...item,
      capabilityKey: index.toString(16).padStart(64, "0"),
    })),
    coverage: {
      excludedUndatedInvocationCount: "0", excludedUndatedTurnCount: "0",
      excludedUnrevisionedInvocationCount: "0", excludedUnrevisionedTurnCount: "0",
      fullyExcludedCapabilityCount: "0",
    },
    nextCursor: null,
  };
  assert.throws(
    () => projectInsightsCapabilities(response, context),
    (error) => error?.code === "TS_INSIGHTS_ENGINE_INVALID",
  );
  assert.throws(
    () => projectInsightsCapabilities({
      ...response,
      items: [{ ...item, kind: "skill" }],
    }, context),
    (error) => error?.code === "TS_INSIGHTS_ENGINE_INVALID",
  );
});

test("Usage and Activity projections expose only stable aggregate semantics", async () => {
  const context = {
    privacyContext: privacyContext(),
    closureEvaluatedAt: "2026-08-11T00:00:00.000Z",
    quiescenceSeconds: 300,
  };
  const usage = projectInsightsUsage(usageResponse(KEY), {
    ...context,
    request: {
      kind: "tool",
      window: {
        observedAtOrAfter: "2026-08-10T00:00:00.000Z",
        observedBefore: "2026-08-11T00:00:00.000Z",
      },
      comparisonWindow: {
        observedAtOrAfter: "2026-08-09T00:00:00.000Z",
        observedBefore: "2026-08-10T00:00:00.000Z",
      },
      filters: { providers: [], projectKeys: [], closureStates: [] },
      orderBy: "absolute-recorded-invocation-change",
      limit: 25,
      cursor: null,
    },
    cursor: null,
  });
  assert.deepEqual(Object.keys(usage), [
    "format", "snapshot", "sourceFreshness", "kind", "orderBy", "window",
    "comparisonWindow", "closureEvaluatedAt", "quiescenceSeconds", "items",
    "totalCandidateCount", "truncated", "coverage", "nextCursor",
  ]);
  assert.equal(usage.items[0].recordedInvocationCount, "7");
  assert.equal(usage.items[0].comparison.absoluteRecordedInvocationChange, "2");
  assert.equal(usage.coverage.scope, "all-indexed-history");
  assert.equal(usage.coverage.categoriesMayOverlap, true);
  assert.equal(typeof usage.nextCursor, "string");
  for (const canary of ["PRIVATE_EXACT", "inputFingerprint", "privatePath", "internalTimingMicros"]) {
    assert.equal(JSON.stringify(usage).includes(canary), false);
  }

  const activity = projectInsightsActivity(activityResponse(), {
    ...context,
    request: {
      window: {
        observedAtOrAfter: "2026-08-10T00:00:00.000Z",
        observedBefore: "2026-08-11T00:00:00.000Z",
      },
      bucket: "day",
      timeZone: "UTC",
      bucketCount: 1,
    },
  });
  assert.deepEqual(Object.keys(activity), [
    "format", "snapshot", "sourceFreshness", "bucket", "timeZone", "window",
    "closureEvaluatedAt", "quiescenceSeconds", "buckets", "coverage",
  ]);
  assert.equal(activity.buckets[0].bucketEnd, "2026-08-11T00:00:00.000Z");
  assert.equal(activity.buckets[0].recordedToolInvocationCount, "7");
  assert.equal(activity.coverage.scope, "all-indexed-history");
  assert.equal(activity.coverage.categoriesMayOverlap, true);
  assert.equal(JSON.stringify(activity).includes("rawProviderPath"), false);
  assert.equal(JSON.stringify(activity).includes("SELECT private"), false);
  const shifted = activityResponse();
  shifted.buckets[0].bucketStart = "2026-08-09T00:00:00.000Z";
  shifted.buckets[0].bucketEnd = "2026-08-10T00:00:00.000Z";
  assert.throws(
    () => projectInsightsActivity(shifted, {
      ...context,
      request: {
        window: {
          observedAtOrAfter: "2026-08-10T00:00:00.000Z",
          observedBefore: "2026-08-11T00:00:00.000Z",
        },
        bucket: "day", timeZone: "UTC", bucketCount: 1,
      },
    }),
    (error) => error?.code === "TS_INSIGHTS_ENGINE_INVALID",
  );
  const mismatchedKind = usageResponse();
  mismatchedKind.items[0].kind = "skill";
  assert.throws(
    () => projectInsightsUsage(mismatchedKind, {
      ...context,
      request: {
        kind: "tool",
        window: {
          observedAtOrAfter: "2026-08-10T00:00:00.000Z",
          observedBefore: "2026-08-11T00:00:00.000Z",
        },
        comparisonWindow: {
          observedAtOrAfter: "2026-08-09T00:00:00.000Z",
          observedBefore: "2026-08-10T00:00:00.000Z",
        },
        filters: { providers: [], projectKeys: [], closureStates: [] },
        orderBy: "absolute-recorded-invocation-change",
        limit: 25,
        cursor: null,
      },
      cursor: null,
    }),
    (error) => error?.code === "TS_INSIGHTS_ENGINE_INVALID",
  );

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  for (const value of [usage, activity]) {
    const filename = value.format.replace("@v1", ".v1");
    const schema = JSON.parse(await readFile(
      new URL(`../schema/${filename}.schema.json`, import.meta.url),
    ));
    const validate = ajv.compile(schema);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
  }
});

test("Usage execution binds its full request and reuses the cursor closure clock", async () => {
  const context = privacyContext();
  const state = {
    paths: { databaseFile: "/not-read-by-fixture" },
    originSecretEpoch: context.originSecretEpoch,
    privacyContext: context,
  };
  const calls = [];
  const run = (request, now, nextCursor) => executeInsightsQuery({
    action: "usage", kind: "tool", requestSource: "-",
  }, {
    async openState() { return state; },
    createReader() {
      return {
        async usage(input) {
          calls.push(input);
          return usageResponse(nextCursor, request.orderBy);
        },
        async close() {},
      };
    },
    input: Readable.from([JSON.stringify(request)]),
    now: () => now,
  });
  const request = {
    format: "threadshare-insights-usage-request@v1",
    window: {
      observedAtOrAfter: "2026-08-10T00:00:00.000Z",
      observedBefore: "2026-08-11T00:00:00.000Z",
    },
    comparisonWindow: {
      observedAtOrAfter: "2026-08-09T00:00:00.000Z",
      observedBefore: "2026-08-10T00:00:00.000Z",
    },
    filters: { providers: ["codex"] },
    orderBy: "recorded-invocation-count",
    limit: 25,
  };
  const first = await run(request, 1_786_406_400_000, KEY);
  assert.deepEqual(calls[0].window, {
    observedAtOrAfterUnixMs: "1786320000000",
    observedBeforeUnixMs: "1786406400000",
  });
  assert.deepEqual(calls[0].filters, {
    providers: ["codex"], projectKeys: [], closureStates: [], capabilityTerminalStates: [],
  });
  assert.equal(calls[0].nowUnixMs, "1786406400000");

  const second = await run({ ...request, cursor: first.nextCursor }, 1_900_000_000_000, null);
  assert.equal(calls[1].cursor, KEY);
  assert.equal(calls[1].nowUnixMs, calls[0].nowUnixMs);
  assert.equal(second.nextCursor, null);
});

test("Activity execution sends canonical timestamps and a frozen closure clock", async () => {
  const context = privacyContext();
  let captured;
  const request = {
    format: "threadshare-insights-activity-request@v1",
    window: {
      observedAtOrAfter: "2026-08-10T00:00:00.000Z",
      observedBefore: "2026-08-11T00:00:00.000Z",
    },
    bucket: "day",
  };
  const result = await executeInsightsQuery({
    action: "activity", requestSource: "-",
  }, {
    async openState() {
      return {
        paths: { databaseFile: "/not-read-by-fixture" },
        originSecretEpoch: context.originSecretEpoch,
        privacyContext: context,
      };
    },
    createReader() {
      return {
        async activity(input) { captured = input; return activityResponse(); },
        async close() {},
      };
    },
    input: Readable.from([JSON.stringify(request)]),
    now: () => 1_786_406_400_000,
  });
  assert.deepEqual(captured.window, request.window);
  assert.equal(captured.timeZone, "UTC");
  assert.equal(captured.nowUnixMs, "1786406400000");
  assert.equal(result.closureEvaluatedAt, "2026-08-11T00:00:00.000Z");
});

test("query execution closes its reader and rejects a cursor after atomic reindex", async () => {
  const context = privacyContext();
  const state = {
    paths: { databaseFile: "/not-read-by-fixture" },
    originSecretEpoch: context.originSecretEpoch,
    privacyContext: context,
  };
  const clients = [];
  const response = (databaseUuid, nextCursor) => ({
    databaseUuid,
    snapshotSeq: "7",
    items: [{
      capabilityKey: KEY, provider: "codex", kind: "tool", canonicalName: "Read",
      useCount: "99", sourcePath: "/private/session.jsonl",
    }],
    coverage: {
      excludedUndatedInvocationCount: "1", excludedUndatedTurnCount: "1",
      excludedUnrevisionedInvocationCount: "2", excludedUnrevisionedTurnCount: "2",
      fullyExcludedCapabilityCount: "3",
    },
    nextCursor,
  });
  const run = (invocation, databaseUuid, nextCursor) => executeInsightsQuery(invocation, {
    async openState() { return state; },
    createReader() {
      const reader = {
        closed: false,
        async capabilities() { return response(databaseUuid, nextCursor); },
        async close() { this.closed = true; },
      };
      clients.push(reader);
      return reader;
    },
    now: () => 1_786_320_000_000,
  });

  const first = await run({
    action: "capabilities", kind: "tool", limit: 25, cursor: null,
  }, DATABASE_UUID, KEY);
  assert.equal(first.items[0].canonicalName, "Read");
  assert.equal(JSON.stringify(first).includes("sourcePath"), false);
  assert.equal(JSON.stringify(first).includes("useCount"), false);
  assert.equal(clients[0].closed, true);

  await assert.rejects(
    run({
      action: "capabilities", kind: "tool", limit: 25, cursor: first.nextCursor,
    }, "99999999-8888-4777-8666-555555555555", null),
    (error) => error?.code === "TS_INSIGHTS_CURSOR_STALE",
  );
  assert.equal(clients[1].closed, true);
});

test("Capabilities rejects an authenticated cursor without a frozen closure clock", async () => {
  const context = privacyContext();
  const codec = createInsightsCursorCodec(context);
  const request = { kind: "tool", limit: 25 };
  const cursor = codec.seal({
    kind: "capabilities",
    snapshot: codec.snapshot(DATABASE_UUID, "7"),
    requestDigest: codec.requestDigest(request),
    engineCursor: KEY,
    closureEvaluatedAt: null,
    quiescenceSeconds: null,
    turnKey: null,
    revision: null,
  });
  let readCount = 0;
  let closed = false;
  await assert.rejects(
    executeInsightsQuery({
      action: "capabilities", kind: "tool", limit: 25, cursor,
    }, {
      async openState() {
        return {
          paths: { databaseFile: "/not-read-by-fixture" },
          originSecretEpoch: context.originSecretEpoch,
          privacyContext: context,
        };
      },
      createReader() {
        return {
          async capabilities() { readCount += 1; },
          async close() { closed = true; },
        };
      },
      now: () => 1_786_406_400_000,
    }),
    (error) => error?.code === "TS_INSIGHTS_CURSOR_STALE",
  );
  assert.equal(readCount, 0);
  assert.equal(closed, true);
});
