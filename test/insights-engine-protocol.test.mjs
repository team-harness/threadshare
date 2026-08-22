import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJson } from "../src/session-facts.mjs";
import {
  INSIGHTS_PROTOCOL_FORMAT,
  INSIGHTS_PROTOCOL_VERSION,
  MAX_PROTOCOL_PAYLOAD_BYTES,
  MEMORY_OPS,
  RETRACTION_COLLECTION_ORDER,
  UPSERT_COLLECTION_ORDER,
  V2_UPSERT_COLLECTION_ORDER,
  ProtocolFrameDecoder,
  SessionBatchSequenceValidator,
  assertBeginSessionCompatible,
  assertHandshakeCompatible,
  assertProtocolMessage,
  createInsightsRequiredContract,
  createAbortSessionMessage,
  createBatchAcceptedMessage,
  createBeginSessionMessage,
  createExcludeSourceMessage,
  createEngineStatusMessage,
  createCapabilityPageMessage,
  createHelloMessage,
  createInsightsOverviewMessage,
  createListCapabilitiesMessage,
  createListSourceStatesMessage,
  createMemoryCommandMessage,
  createMemoryResultMessage,
  createProtocolErrorMessage,
  createPurgeMaintenanceStatusMessage,
  createPurgeStatusMessage,
  createReadPurgeStatusMessage,
  createReadEngineStatusMessage,
  createReadCapabilityUsageMessage,
  createReadInsightsActivityMessage,
  createReadInsightsEvidenceV2Message,
  createReadInsightsRecipeMessage,
  createReadInsightsQueryV2Message,
  createCapabilityUsageMessage,
  createInsightsActivityMessage,
  createInsightsEvidenceV2Message,
  createInsightsRecipeMessage,
  createInsightsQueryV2Message,
  createReadInsightsOverviewMessage,
  createReadTurnEvidenceMessage,
  createReadSourceCheckpointMessage,
  createRemoveSourceMessage,
  createReadyMessage,
  createRetractionBatchMessage,
  createSessionAbortedMessage,
  createSessionAcceptedMessage,
  createSessionCommittedMessage,
  createSessionDeltaMessages,
  createTraceSourceDeltaMessages,
  createSourceCheckpointMessage,
  createSourceExcludedMessage,
  createSourceRemovedMessage,
  createSourceStatesMessage,
  createSearchTurnsMessage,
  createRunPurgeMaintenanceMessage,
  createTurnEvidencePageMessage,
  createTurnSearchResultsMessage,
  createUpsertBatchMessage,
  decodeSourceLocator,
  decodeProtocolFrames,
  encodeSourceLocator,
  encodeProtocolFrame,
  protocolPayloadByteLength,
  traceSourceDigestDocument,
} from "../src/insights-engine-protocol.mjs";

const fixtureUrl = new URL("./fixtures/insights-protocol-v1/frames.json", import.meta.url);
const recipeItemsUrl = new URL("./fixtures/insights-recipe-items.v1.json", import.meta.url);
const SESSION_KEY = "a".repeat(64);
const DELTA_ID = "b".repeat(64);
const EPOCH = "11111111-2222-4333-8444-555555555555";

function traceSourceDelta() {
  const value = {
    format: "threadshare-insights-trace-source-delta@v1",
    expectedGeneration: "0",
    targetGeneration: "1",
    repository: {
      repositoryId: "11111111-1111-4111-8111-111111111111",
      repositoryKey: "1".repeat(64),
      available: true,
      refDigest: "2".repeat(64),
      scmProvider: "github",
      webBaseUrl: "https://github.com",
      repositoryPath: "team-harness/threadshare",
      projectKeys: ["3".repeat(64), "4".repeat(64)],
    },
    intent: null,
    refs: [{ name: "refs/heads/main", objectId: "a".repeat(40) }],
    commits: [{
      objectId: "a".repeat(40), parentObjectIds: [],
      authorTimestamp: "2026-08-16T00:00:00.000Z",
      committerTimestamp: "2026-08-16T00:00:00.000Z",
      treeObjectId: "b".repeat(40), summary: "initial",
      files: [{ path: "src/lib.rs", oldPath: null, status: "A", additions: "10", deletions: "0" }],
    }],
    intentNodes: [],
    intentRefs: [],
  };
  return {
    ...value,
    deltaId: createHash("sha256").update(canonicalJson(traceSourceDigestDocument(value))).digest("hex"),
  };
}
const COMPILE_OPTIONS_DIGEST = "c".repeat(64);
const BUILD_MANIFEST_DIGEST = "d".repeat(64);
const TURN_KEY = "e".repeat(64);
const REVISION = "f".repeat(64);

function deepQueryRequest(overrides = {}) {
  return {
    format: "threadshare-insights-query-request@v2",
    resource: "event",
    where: { field: "event.kind", op: "eq", value: "message" },
    shape: {
      kind: "records",
      select: ["eventKey", "message.content"],
      payloadMode: "reference",
    },
    orderBy: [
      { field: "observedAt", direction: "desc" },
      { field: "eventKey", direction: "asc" },
    ],
    limit: 2,
    cursor: null,
    count: "exact",
    evaluatedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

function deepEvidenceTarget() {
  return {
    kind: "event",
    eventKey: TURN_KEY,
    revision: REVISION,
    payloadKey: "1".repeat(64),
  };
}

function contentReference(overrides = {}) {
  return {
    byteLength: "7",
    sha256: "2".repeat(64),
    encoding: "utf-8",
    inline: null,
    reference: deepEvidenceTarget(),
    complete: true,
    ...overrides,
  };
}

function deepCoverage() {
  return {
    matching: {
      fullRecordCount: "1",
      summaryRecordCount: "0",
      unloadedRecordCount: "0",
      truncatedRecordCount: "0",
      unavailableRecordCount: "0",
      missingTimestampCount: "0",
      missingRevisionCount: "0",
      missingTokenMetricCount: "0",
      missingPayloadCount: "0",
    },
    indexedHistory: {
      visibleSessionCount: "1",
      excludedSessionCount: "0",
      subagentExcludedSessionCount: "0",
      unknownEligibilitySessionCount: "0",
      pendingPurgeSessionCount: "0",
      purgedSessionCount: "0",
      missingCoverageRollupSessionCount: "0",
      fts: {
        searchableEventCount: "1",
        storedNotSearchableEventCount: "0",
        searchablePayloadBytes: "7",
        storedNotSearchablePayloadBytes: "0",
      },
    },
    degraded: false,
    diagnostics: [],
  };
}

function deepQueryResponse(overrides = {}) {
  return {
    format: "threadshare-insights-query@v2",
    databaseUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    snapshotSeq: "7",
    resource: "event",
    records: [{ eventKey: TURN_KEY, message: { content: contentReference() } }],
    groups: null,
    nextCursor: null,
    totalMatchCount: "1",
    totalGroupCount: null,
    truncated: false,
    coverage: deepCoverage(),
    provenance: { default: "recorded", fields: [] },
    limits: { pageBytes: "3932160", payloadsMayRequireEvidencePaging: true },
    ...overrides,
  };
}

function recipeRequest(overrides = {}) {
  return {
    format: "threadshare-insights-recipe-request@v1",
    name: "capability-contexts@1",
    window: {
      after: "2026-08-01T00:00:00.000Z",
      before: "2026-09-01T00:00:00.000Z",
    },
    comparisonWindow: null,
    filters: {
      providers: [],
      projectKeys: [],
      capabilityKeys: [],
      sessionKeys: [],
      turnKeys: [],
      eventKinds: [],
      text: null,
      bucket: null,
    },
    limit: 20,
    allowDegraded: false,
    evaluatedAt: "2026-08-12T00:00:00.000Z",
    ...overrides,
  };
}

function recipeResponse(overrides = {}) {
  return {
    format: "threadshare-insights-recipe@v1",
    databaseUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    snapshotSeq: "7",
    name: "capability-contexts@1",
    window: recipeRequest().window,
    comparisonWindow: null,
    evaluatedAt: "2026-08-12T00:00:00.000Z",
    items: [{
      capability: {
        capabilityKey: TURN_KEY, provider: "codex", kind: "tool", canonicalName: "Bash",
      },
      recordedInvocationCount: "1",
      recordedFailingInvocationCount: "0",
      distinctTurnCount: "1",
      distinctSessionCount: "1",
      distinctDedupeGroupCount: "0",
      groupedInvocationCount: "0",
      ungroupedInvocationCount: "1",
      lastUsedAt: "2026-08-10T00:00:00.000Z",
      strongGroupMemberInvocationCount: "0",
      weakGroupMemberInvocationCount: "0",
      invocationTerminalCounts: {
        pending: "0", completed: "1", failed: "0", cancelled: "0", unknown: "0",
      },
      topProjects: [],
      coOccurringCapabilities: [],
      representativeTurns: [{
        turnKey: TURN_KEY,
        usedAt: "2026-08-10T00:00:00.000Z",
        recordedInvocationCount: "1",
        context: { problem: "run Bash", finalAnswer: null },
        evidence: { kind: "turn", turnKey: TURN_KEY, revision: REVISION },
      }],
      evidence: { kind: "turn", turnKey: TURN_KEY, revision: REVISION },
    }],
    totalItemCount: "1",
    truncated: false,
    coverage: deepCoverage(),
    provenance: { default: "recorded", fields: [] },
    ...overrides,
  };
}

function handshakeContract(overrides = {}) {
  return {
    factSchemaVersion: 1,
    providerAdapterVersions: ["claude@1", "codex@1"],
    privacyPolicyVersion: 1,
    originSecretEpoch: EPOCH,
    duplicatePolicyVersion: 1,
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: [],
    analyzerCapabilities: [],
    rankerVersion: 1,
    ...overrides,
  };
}

function sessionOptions(overrides = {}) {
  return {
    requestId: "2",
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: [],
    analyzerCapabilities: [],
    rankerVersion: 1,
    ...overrides,
  };
}

test("required contract builder owns every active Engine contract axis", () => {
  const contract = createInsightsRequiredContract(EPOCH);
  assert.deepEqual(contract, {
    factSchemaVersion: 2,
    providerAdapterVersions: ["claude@3", "codex@3"],
    privacyPolicyVersion: 2,
    originSecretEpoch: EPOCH,
    duplicatePolicyVersion: 1,
    factStorageProfile: "normalized-row-v2",
    storageSchemaVersion: 2,
    projectionVersions: ["turn-search@2", "turn-summary@1"],
    analyzerCapabilities: ["mixed-cjk-code@1"],
    rankerVersion: 1,
  });
  assert.deepEqual(createInsightsRequiredContract(EPOCH, { factSchemaVersion: 1 }), {
    ...contract,
    factSchemaVersion: 1,
    providerAdapterVersions: ["claude@1", "codex@1"],
    privacyPolicyVersion: 1,
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
  });
  assert.equal(Object.isFrozen(contract), true);
  assert.equal(Object.isFrozen(contract.providerAdapterVersions), true);
  assert.equal(Object.isFrozen(contract.projectionVersions), true);
  assert.equal(Object.isFrozen(contract.analyzerCapabilities), true);
});

test("Fact V2 READY requires the active database identity without widening V1", () => {
  const contract = createInsightsRequiredContract(EPOCH);
  const input = {
    requestId: "1",
    engineVersion: "threadshare-insights-engine@0.8.0",
    target: "darwin-arm64",
    sqliteVersion: "3.53.2",
    sqliteCompileOptionsDigest: COMPILE_OPTIONS_DIGEST,
    buildManifestDigest: BUILD_MANIFEST_DIGEST,
    acceptedContract: contract,
    databaseUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    databaseFactSchemaVersion: null,
  };
  const ready = createReadyMessage(input);
  assert.equal(ready.databaseFactSchemaVersion, null);
  assert.throws(
    () => assertProtocolMessage({ ...ready, databaseUuid: undefined }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => assertProtocolMessage({ ...ready, databaseFactSchemaVersion: 3 }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );

  const v1 = readyMessage();
  assert.equal(Object.hasOwn(v1, "databaseUuid"), false);
  assert.equal(Object.hasOwn(v1, "databaseFactSchemaVersion"), false);
});

test("benchmark entry points use the canonical required contract builder", async () => {
  const sources = await Promise.all([
    readFile(new URL("../scripts/benchmark-insights-engine.mjs", import.meta.url), "utf8"),
    readFile(new URL("../scripts/run-insights-query-quality.mjs", import.meta.url), "utf8"),
  ]);
  for (const source of sources) {
    assert.match(source, /createInsightsRequiredContract\(ORIGIN_SECRET_EPOCH\)/u);
    assert.doesNotMatch(source, /function requiredContract\(/u);
  }
});

function sampleDelta(overrides = {}) {
  return {
    format: "session-facts-delta@v1",
    factSchemaVersion: 1,
    providerAdapterVersion: "codex@1",
    privacyPolicyVersion: 1,
    originSecretEpoch: EPOCH,
    duplicatePolicyVersion: 1,
    expectedGeneration: "0",
    targetGeneration: "1",
    mode: "append",
    deltaId: DELTA_ID,
    session: { sessionKey: SESSION_KEY, provider: "codex", marker: "session" },
    retractions: {
      turnKeys: [],
      orphanEventKeys: [],
      authoritativeTurnKeys: [],
    },
    turns: [],
    sourceRecords: [],
    evidenceEvents: [],
    turnEvidence: [],
    capabilities: [],
    capabilityUses: [],
    capabilityUseEvidence: [],
    checkpoint: { generation: "1", marker: "checkpoint" },
    diagnostics: [],
    coverage: {},
    ...overrides,
  };
}

function sampleDeltaV2(overrides = {}) {
  return {
    ...sampleDelta(),
    format: "session-facts-delta@v2",
    factSchemaVersion: 2,
    providerAdapterVersion: "codex@3",
    privacyPolicyVersion: 2,
    historyEvents: [],
    historyPayloads: [],
    historyPayloadChunks: [],
    ...overrides,
  };
}

function helloMessage() {
  return createHelloMessage({
    requestId: "1",
    clientVersion: "threadshare@0.6.1",
    requiredContract: handshakeContract({
      providerAdapterVersions: ["codex@1", "claude@1"],
    }),
  });
}

function readyMessage(contractOverrides = {}) {
  return createReadyMessage({
    requestId: "1",
    engineVersion: "threadshare-insights-engine@0.6.1",
    target: "aarch64-apple-darwin",
    sqliteVersion: "3.53.2",
    sqliteCompileOptionsDigest: COMPILE_OPTIONS_DIGEST,
    buildManifestDigest: BUILD_MANIFEST_DIGEST,
    acceptedContract: handshakeContract(contractOverrides),
  });
}

function rawFrame(payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

function sourceSummary(sessionKey, file = "/tmp/threadshare/session.jsonl") {
  return {
    provider: "codex",
    sessionId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    fileUtf8Hex: encodeSourceLocator(file),
    sessionKey,
    projectKey: null,
    metadata: { dev: "1", ino: "2", size: "1", mtimeNs: "3" },
    fingerprints: {
      head: { offset: "0", length: 1, sha256: "e".repeat(64) },
      boundary: { offset: "0", length: 1, sha256: "f".repeat(64) },
    },
    contract: {
      factSchemaVersion: 1,
      providerAdapterVersion: "codex@1",
      privacyPolicyVersion: 1,
      duplicatePolicyVersion: 1,
      originSecretEpoch: EPOCH,
    },
    checkpoint: { completeOffset: "1", sourceSnapshotStable: true, generation: "1" },
  };
}

function engineStatus() {
  return {
    snapshotSeq: "17",
    snapshotAgeMs: "1234",
    snapshotPending: false,
    factStorageProfile: "normalized-row-v1",
    projections: [{
      name: "turn-summary",
      version: 1,
      inputFactSchemaVersion: 1,
      rootKind: "turn",
      baseSnapshotSeq: "5",
      watermark: "17",
      status: "active",
      errorDigest: null,
    }],
    changeLog: {
      rows: "2",
      payloadBytes: "234",
      maxRows: "1000000",
      maxPayloadBytes: "67108864",
      state: "within-cap",
    },
    purge: {
      state: "pending-purge",
      pendingFacts: "1",
      pendingMaintenance: "0",
      purged: "0",
    },
    storage: {
      databaseBytes: "4096",
      walBytes: "0",
      walPressureAction: "none",
      recentDiagnostic: null,
    },
    integrity: { quickCheck: "ok", fts: "ok" },
  };
}

function searchFilters(overrides = {}) {
  return {
    providers: [],
    projectKeys: [],
    sessionKeys: [],
    observedAtOrAfterUnixMs: null,
    observedBeforeUnixMs: null,
    toolCapabilityKeys: [],
    skillCapabilityKeys: [],
    resultEvidence: [],
    closureStates: [],
    capabilityTerminalStates: [],
    ...overrides,
  };
}

function searchResult(overrides = {}) {
  return {
    turnKey: TURN_KEY,
    sessionKey: SESSION_KEY,
    revision: REVISION,
    provider: "codex",
    projectKey: null,
    observedTimestamp: "2026-08-10T01:02:03.000Z",
    problemExcerpt: "why did the query fail?",
    problemTruncated: false,
    finalAnswerExcerpt: "the query used an invalid filter",
    finalAnswerTruncated: false,
    closureState: "hard-sealed",
    resultEvidence: "provider-completed",
    dedupe: {
      duplicateGroupKey: "9".repeat(64),
      confidence: "strong",
      observedEofProvisional: false,
    },
    score: {
      relevancePpm: 925_000,
      bm25Rank: 1,
      rankComponentPpm: 1_000_000,
      idfCoveragePpm: 875_000,
      exact: false,
      matchedTermIndexes: [0],
    },
    ...overrides,
  };
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test("protocol constants and shared frame vectors stay byte-for-byte stable", async () => {
  assert.equal(INSIGHTS_PROTOCOL_FORMAT, "threadshare-insights-protocol@v1");
  assert.equal(INSIGHTS_PROTOCOL_VERSION, 1);
  assert.equal(MAX_PROTOCOL_PAYLOAD_BYTES, 4_194_304);
  assert.deepEqual(RETRACTION_COLLECTION_ORDER, [
    "turnKeys",
    "orphanEventKeys",
    "authoritativeTurnKeys",
  ]);
  assert.deepEqual(UPSERT_COLLECTION_ORDER, [
    "turns",
    "sourceRecords",
    "evidenceEvents",
    "turnEvidence",
    "capabilities",
    "capabilityUses",
    "capabilityUseEvidence",
  ]);

  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  assert.equal(fixture.format, "threadshare-insights-protocol-frames@v1");
  for (const vector of fixture.frames) {
    const canonical = canonicalJson(vector.message);
    const payload = Buffer.from(canonical);
    assert.equal(canonical, vector.canonicalPayload, vector.name);
    assert.equal(payload.length, vector.payloadByteLength, vector.name);
    assert.equal(createHash("sha256").update(payload).digest("hex"), vector.payloadSha256, vector.name);
    assert.equal(
      encodeProtocolFrame(vector.message).subarray(0, 4).toString("hex"),
      vector.lengthPrefixHex,
      vector.name,
    );
  }
});

test("memory envelope pins the op enum and requires plain-object payloads", () => {
  assert.deepEqual(MEMORY_OPS, [
    "open",
    "bind-repository",
    "list-memory-files",
    "read-memory-file",
    "plan-tasks",
    "claim-task",
    "abandon-task",
    "submit-extraction",
    "submit-consolidation",
    "consolidation-baseline",
    "recall",
    "submit-adjudication",
    "sync-approved",
    "search",
    "review-queue",
    "status",
    "confirm-statement",
    "discard-candidate",
    "promotion-plan",
    "promotion-approve",
    "promotion-apply",
    "authorize",
  ]);

  const payload = { repositoryKey: "1".repeat(64), worktreeKey: "2".repeat(64) };
  const command = createMemoryCommandMessage({ requestId: "91", op: "status", payload });
  assert.deepEqual(command, {
    format: INSIGHTS_PROTOCOL_FORMAT,
    type: "MEMORY_COMMAND",
    requestId: "91",
    op: "status",
    payload,
  });
  const result = createMemoryResultMessage({
    requestId: "91",
    op: "status",
    payload: { chunks: {}, tasks: {}, candidates: {} },
  });
  assert.equal(assertProtocolMessage(result), result);
  for (const op of MEMORY_OPS) {
    assertProtocolMessage(createMemoryCommandMessage({ requestId: "1", op, payload: {} }));
    assertProtocolMessage(createMemoryResultMessage({ requestId: "1", op, payload: {} }));
  }

  const invalid = (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME";
  // Unknown, camelCase, and missing ops are rejected on both envelope types.
  for (const op of ["promote", "bindRepository", "", undefined]) {
    assert.throws(() => createMemoryCommandMessage({ requestId: "1", op, payload: {} }), invalid);
    assert.throws(() => createMemoryResultMessage({ requestId: "1", op, payload: {} }), invalid);
  }
  // Payload must be a plain object.
  for (const payloadValue of [undefined, null, [], "x", 7]) {
    assert.throws(
      () => createMemoryCommandMessage({ requestId: "1", op: "open", payload: payloadValue }),
      invalid,
    );
    assert.throws(
      () => createMemoryResultMessage({ requestId: "1", op: "open", payload: payloadValue }),
      invalid,
    );
  }
  // The envelope is exact-keyed.
  assert.throws(() => assertProtocolMessage({ ...command, extra: true }), invalid);
  assert.throws(() => assertProtocolMessage((({ op: _op, ...rest }) => rest)(command)), invalid);
});

test("engine status protocol is bounded, read-only, and rejects inconsistent state", () => {
  const request = createReadEngineStatusMessage({ requestId: "9" });
  assert.deepEqual(request, {
    format: INSIGHTS_PROTOCOL_FORMAT,
    type: "READ_ENGINE_STATUS",
    requestId: "9",
  });

  const response = createEngineStatusMessage({ requestId: "9", status: engineStatus() });
  assert.equal(assertProtocolMessage(response), response);
  assert.ok(protocolPayloadByteLength(response) < MAX_PROTOCOL_PAYLOAD_BYTES);

  assert.throws(
    () => assertProtocolMessage({
      ...structuredClone(response),
      snapshotPending: true,
    }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
  assert.throws(
    () => assertProtocolMessage({
      ...structuredClone(response),
      projections: [{ ...response.projections[0], status: "stale" }],
    }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
  assert.throws(
    () => assertProtocolMessage({
      ...structuredClone(response),
      storage: {
        ...response.storage,
        walBytes: "134217728",
      },
    }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
});

test("Insights overview protocol keeps aggregate categories bounded and consistent", () => {
  const request = createReadInsightsOverviewMessage({
    requestId: "10",
    nowUnixMs: "1786323723000",
  });
  assert.equal(request.quiescenceSeconds, 300);
  const overview = {
    snapshotSeq: "7",
    sessions: { raw: "3", eligible: "1", excluded: "1", subagentExcluded: "1", unknown: "0" },
    scopes: { main: "2", subagent: "1", unknown: "0" },
    dedupe: {
      strongGroup: "1", weakGroup: "0", observedEofProvisionalSession: "1", unknownSession: "0",
    },
    turns: {
      indexed: "2", active: "2", rolledBack: "1", unknownVisibility: "0",
      hardSealed: "1", quiescent: "0", open: "1",
    },
    capabilities: { total: "2", tool: "1", skill: "1" },
    providers: {
      items: [{
        provider: "codex", rawSessionCount: "3", eligibleSessionCount: "1", indexedTurnCount: "2",
      }],
      truncated: false,
    },
    projects: {
      items: [{
        projectKey: "1".repeat(64), rawSessionCount: "1", eligibleSessionCount: "1",
        indexedTurnCount: "2",
      }],
      truncated: false,
    },
    coverage: { items: [{ key: "records", count: "9" }], truncated: false },
    diagnostics: { items: [{ code: "fixture-observed", count: "1" }], truncated: false },
  };
  const response = createInsightsOverviewMessage({ requestId: "10", overview });
  assert.equal(assertProtocolMessage(response), response);
  assert.ok(protocolPayloadByteLength(response) < MAX_PROTOCOL_PAYLOAD_BYTES);
  assert.doesNotThrow(() => createInsightsOverviewMessage({
    requestId: "10",
    overview: {
      ...structuredClone(overview),
      coverage: { items: overview.coverage.items, truncated: true },
    },
  }));

  assert.throws(
    () => createInsightsOverviewMessage({
      requestId: "10",
      overview: { ...structuredClone(overview), sessions: { ...overview.sessions, eligible: "2" } },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createInsightsOverviewMessage({
      requestId: "10",
      overview: {
        ...structuredClone(overview),
        coverage: { items: [{ key: "z", count: "1" }, { key: "a", count: "1" }], truncated: false },
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
});

test("capability pages are stable-key paged and contain only bounded aggregates", () => {
  const request = createListCapabilitiesMessage({
    requestId: "11",
    kind: "tool",
    limit: 100,
  });
  assert.deepEqual(request, {
    format: INSIGHTS_PROTOCOL_FORMAT,
    type: "LIST_CAPABILITIES",
    requestId: "11",
    kind: "tool",
    cursor: null,
    limit: 100,
  });
  const item = {
    capabilityKey: "2".repeat(64),
    provider: "codex",
    kind: "tool",
    canonicalName: "Read",
    useCount: "3",
    turnCount: "2",
    sessionCount: "1",
    terminal: { pending: "0", completed: "2", failed: "1", cancelled: "0", unknown: "0" },
    strength: { observed: "3", confirmed: "0", inferred: "0" },
  };
  const page = {
    databaseUuid: EPOCH,
    snapshotSeq: "7",
    items: [item],
    nextCursor: item.capabilityKey,
    coverage: {
      excludedUndatedInvocationCount: "2",
      excludedUndatedTurnCount: "1",
      excludedUnrevisionedInvocationCount: "3",
      excludedUnrevisionedTurnCount: "2",
      fullyExcludedCapabilityCount: "1",
    },
  };
  const response = createCapabilityPageMessage({ requestId: "11", page });
  assert.equal(assertProtocolMessage(response), response);
  assert.throws(
    () => createCapabilityPageMessage({
      requestId: "11",
      page: {
        ...page,
        coverage: { ...page.coverage, fullyExcludedCapabilityCount: 1 },
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createCapabilityPageMessage({
      requestId: "11",
      page: { ...page, nextCursor: "3".repeat(64) },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createCapabilityPageMessage({
      requestId: "11",
      page: {
        ...page,
        items: [{ ...item, sourcePath: "/private/session.jsonl" }],
        nextCursor: null,
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
});

test("turn search requests canonicalize bounded filters and reject broad queries", () => {
  const request = createSearchTurnsMessage({
    requestId: "10",
    query: "Bash timeout",
    filters: searchFilters({
      providers: ["codex", "claude"],
      sessionKeys: ["4".repeat(64), "3".repeat(64)],
      toolCapabilityKeys: ["2".repeat(64), "1".repeat(64)],
      resultEvidence: ["unknown", "provider-completed"],
      capabilityTerminalStates: ["failed", "completed"],
    }),
    orderBy: "observed-desc",
    nowUnixMs: "1786323723000",
  });
  assert.deepEqual(request.filters.providers, ["claude", "codex"]);
  assert.deepEqual(request.filters.sessionKeys, ["3".repeat(64), "4".repeat(64)]);
  assert.deepEqual(request.filters.toolCapabilityKeys, ["1".repeat(64), "2".repeat(64)]);
  assert.deepEqual(request.filters.resultEvidence, ["provider-completed", "unknown"]);
  assert.deepEqual(request.filters.capabilityTerminalStates, ["completed", "failed"]);
  assert.equal(request.orderBy, "observed-desc");
  assert.equal(request.limit, 50);
  assert.equal(request.pathLimit, 10);
  assert.equal(request.quiescenceSeconds, 300);
  assert.equal(assertProtocolMessage(request), request);

  assert.throws(
    () => createSearchTurnsMessage({
      requestId: "10",
      query: "needle",
      filters: searchFilters({ capabilityTerminalStates: ["failed"] }),
      nowUnixMs: "1786323723000",
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createSearchTurnsMessage({
      requestId: "10",
      query: "needle",
      filters: searchFilters(),
      orderBy: "recent",
      nowUnixMs: "1786323723000",
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createSearchTurnsMessage({
      requestId: "10",
      query: "界".repeat(2_731),
      filters: searchFilters(),
      nowUnixMs: "1786323723000",
    }),
    { code: "QUERY_TOO_LONG" },
  );
  assert.throws(
    () => createSearchTurnsMessage({
      requestId: "10",
      query: "",
      filters: searchFilters(),
      nowUnixMs: "1786323723000",
    }),
    { code: "QUERY_TOO_BROAD" },
  );
  assert.throws(
    () => createSearchTurnsMessage({
      requestId: "10",
      query: "needle",
      filters: searchFilters({ providers: Array.from({ length: 17 }, (_, index) => `p${index}`) }),
      nowUnixMs: "1786323723000",
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createSearchTurnsMessage({
      requestId: "10",
      query: "needle",
      filters: searchFilters({ providers: ["codex", "codex"] }),
      nowUnixMs: "1786323723000",
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createSearchTurnsMessage({
      requestId: "10",
      query: "needle",
      filters: searchFilters({
        observedAtOrAfterUnixMs: "1786406400000",
        observedBeforeUnixMs: "1786320000000",
      }),
      nowUnixMs: "1786323723000",
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
});

test("turn search responses bound excerpts, scores, terms, and path evidence", () => {
  const response = createTurnSearchResultsMessage({
    requestId: "10",
    databaseUuid: EPOCH,
    snapshot: {
      snapshotSeq: "21",
      projectionVersion: 2,
      analyzerVersion: 1,
      rankerVersion: 1,
    },
    orderBy: "relevance",
    totalMatchCount: "1",
    closureEvaluatedAt: "2026-08-11T00:00:00.000Z",
    quiescenceSeconds: 300,
    scoringTerms: [{
      logicalTerm: "normalized",
      field: "natural",
      token: "tmfrgg",
      documentFrequency: "10",
      fieldDocumentCount: "20",
    }],
    results: [searchResult()],
    evidencePaths: {
      insufficientSample: false,
      rawMatchCount: 5,
      eligibleTurnCount: 5,
      rawSessionCount: 5,
      independentGroupCount: 3,
      strongGroupCount: 2,
      weakGroupCount: 1,
      observedEofProvisionalGroupCount: 0,
      unknownDedupeCount: 0,
      unknownDedupeSessionCount: 0,
      pathsTruncated: false,
      families: [{
        fingerprint: "3".repeat(64),
        nodes: [{ providerScopedName: "codex:Bash", repeatBucket: "1" }],
        truncated: false,
        bestRelevancePpm: 925_000,
        turnCount: 5,
        rawSessionCount: 5,
        independentGroupCount: 3,
        strongGroupCount: 2,
        weakGroupCount: 1,
        observedEofProvisionalGroupCount: 0,
        unknownDedupeSessionCount: 0,
        latestUnixMs: 1_786_323_723_000,
        toolStateCounts: { pending: 0, completed: 4, failed: 1, cancelled: 0, unknown: 0 },
        deliveryOutcome: {
          directCommitTurnCount: 2,
          observedCommitTurnCount: 1,
          noDeliveryTurnCount: 1,
          uncoveredTurnCount: 1,
        },
        evidenceTurnKeys: [TURN_KEY],
      }],
    },
    diagnostic: {
      analyzeMicros: 10,
      dfMicros: 20,
      postingFilterMicros: 30,
      rerankMicros: 40,
      pathMicros: 50,
      zeroDfTermCount: 0,
      highFrequencyTermCount: 0,
      truncatedTermCount: 0,
      scoringTermCount: 1,
    },
    searchTrace: {
      candidateCount: 1,
      candidateTurnKeys: [TURN_KEY],
    },
  });
  assert.equal(assertProtocolMessage(response), response);
  assert.ok(protocolPayloadByteLength(response) < MAX_PROTOCOL_PAYLOAD_BYTES);

  const overlappingDedupeAxes = structuredClone(response);
  overlappingDedupeAxes.evidencePaths.observedEofProvisionalGroupCount = 1;
  overlappingDedupeAxes.evidencePaths.families[0].observedEofProvisionalGroupCount = 1;
  assert.equal(assertProtocolMessage(overlappingDedupeAxes), overlappingDedupeAxes);

  assert.throws(
    () => createTurnSearchResultsMessage({
      ...structuredClone(response),
      requestId: "10",
      evidencePaths: {
        ...structuredClone(response.evidencePaths),
        strongGroupCount: 1,
        weakGroupCount: 1,
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );

  assert.throws(
    () => createTurnSearchResultsMessage({
      ...structuredClone(response),
      requestId: "10",
      evidencePaths: {
        ...structuredClone(response.evidencePaths),
        families: [{
          ...structuredClone(response.evidencePaths.families[0]),
          strongGroupCount: 1,
          weakGroupCount: 1,
        }],
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );

  assert.throws(
    () => createTurnSearchResultsMessage({
      ...structuredClone(response),
      requestId: "10",
      evidencePaths: {
        ...structuredClone(response.evidencePaths),
        families: [{
          ...structuredClone(response.evidencePaths.families[0]),
          independentGroupCount: 2,
          strongGroupCount: 1,
          weakGroupCount: 1,
        }],
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );

  assert.throws(
    () => createTurnSearchResultsMessage({
      ...structuredClone(response),
      requestId: "10",
      evidencePaths: {
        ...structuredClone(response.evidencePaths),
        families: [{
          ...structuredClone(response.evidencePaths.families[0]),
          deliveryOutcome: {
            directCommitTurnCount: 2,
            observedCommitTurnCount: 1,
            noDeliveryTurnCount: 1,
            uncoveredTurnCount: 0,
          },
        }],
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );

  assert.throws(
    () => createTurnSearchResultsMessage({
      ...structuredClone(response),
      requestId: "10",
      results: [searchResult({ problemExcerpt: "界".repeat(171) })],
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createTurnSearchResultsMessage({
      ...structuredClone(response),
      requestId: "10",
      searchTrace: { candidateCount: 2, candidateTurnKeys: [TURN_KEY] },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createTurnSearchResultsMessage({
      ...structuredClone(response),
      requestId: "10",
      searchTrace: { candidateCount: 2, candidateTurnKeys: [TURN_KEY, TURN_KEY] },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createTurnSearchResultsMessage({
      ...structuredClone(response),
      requestId: "10",
      results: [searchResult({ score: { ...searchResult().score, relevancePpm: 0.5 } })],
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createTurnSearchResultsMessage({
      ...structuredClone(response),
      requestId: "10",
      scoringTerms: Array.from({ length: 33 }, (_, index) => ({
        logicalTerm: `term-${index}`,
        field: "natural",
        token: `t${index}`,
        documentFrequency: "1",
        fieldDocumentCount: "1",
      })),
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createTurnSearchResultsMessage({
      ...structuredClone(response),
      requestId: "10",
      scoringTerms: [],
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createTurnSearchResultsMessage({
      ...structuredClone(response),
      requestId: "10",
      results: [],
      evidencePaths: {
        ...structuredClone(response.evidencePaths),
        eligibleTurnCount: 6,
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
});

test("turn evidence pages are revision-aware, strictly tagged, and frame bounded", () => {
  assert.throws(
    () => createReadTurnEvidenceMessage({ requestId: "11", turnKey: TURN_KEY }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createReadTurnEvidenceMessage({
      requestId: "11",
      turnKey: TURN_KEY,
      expectedRevision: null,
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );

  const request = createReadTurnEvidenceMessage({
    requestId: "11",
    turnKey: TURN_KEY,
    expectedRevision: REVISION,
  });
  assert.equal(request.cursor, null);
  assert.equal(request.limit, 64);

  const response = createTurnEvidencePageMessage({
    requestId: "11",
    snapshotSeq: "21",
    turn: {
      turnKey: TURN_KEY,
      revision: REVISION,
      problemText: "why did the query fail?",
      finalAnswerExcerpt: "the query used an invalid filter",
      observedTimestamp: "2026-08-10T01:02:03.000Z",
      nextUserBoundary: false,
      providerTerminal: "completed",
      observedEofClosed: true,
      providerVisibility: "active",
      factTruncation: [],
    },
    entries: [{
      factKind: "event",
      fact: {
        eventKey: "5".repeat(64),
        occurredTurnKey: TURN_KEY,
        linkedTurns: [{ turnKey: TURN_KEY, role: "lifecycle" }],
        pointerKind: "/content/0",
        pointerContentIndex: 0,
        pointerEventOrdinal: 0,
        originScope: "main",
        observedTimestamp: "2026-08-10T01:02:03.000Z",
        payload: {
          kind: "turn-lifecycle",
          lifecycleState: "completed",
          providerTurnDigest: null,
        },
      },
    }],
    nextCursor: null,
  });
  assert.equal(assertProtocolMessage(response), response);
  assert.ok(protocolPayloadByteLength(response) < MAX_PROTOCOL_PAYLOAD_BYTES);

  assert.throws(
    () => createReadTurnEvidenceMessage({
      requestId: "11",
      turnKey: TURN_KEY,
      expectedRevision: REVISION,
      cursor: "x".repeat(257),
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createTurnEvidencePageMessage({
      requestId: "11",
      snapshotSeq: "21",
      turn: {
        ...response.turn,
        problemText: "x".repeat(65_537),
      },
      entries: [],
      nextCursor: null,
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createTurnEvidencePageMessage({
      requestId: "11",
      snapshotSeq: "21",
      turn: response.turn,
      entries: [{ factKind: "future", fact: {} }],
      nextCursor: null,
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
});

test("Usage and Activity requests carry bounded frozen windows", () => {
  const usage = createReadCapabilityUsageMessage({
    requestId: "12",
    kind: "tool",
    window: {
      observedAtOrAfterUnixMs: "1785542400000",
      observedBeforeUnixMs: "1788220800000",
    },
    comparisonWindow: null,
    filters: {
      providers: ["codex"],
      projectKeys: ["1".repeat(64)],
      closureStates: ["hard-sealed"],
      capabilityTerminalStates: ["failed"],
    },
    orderBy: "recorded-failing-invocation-count",
    nowUnixMs: "1786406400000",
  });
  assert.equal(usage.limit, 50);
  assert.equal(usage.cursor, null);
  assert.equal(usage.quiescenceSeconds, 300);

  const activity = createReadInsightsActivityMessage({
    requestId: "13",
    window: {
      observedAtOrAfter: "2026-08-03T00:00:00.000Z",
      observedBefore: "2026-08-17T00:00:00.000Z",
    },
    filters: { providers: [], projectKeys: [], closureStates: [] },
    bucket: "week",
    timeZone: "UTC",
    nowUnixMs: "1786406400000",
  });
  assert.equal(activity.quiescenceSeconds, 300);

  assert.throws(
    () => createReadCapabilityUsageMessage({
      ...usage,
      requestId: "12",
      orderBy: "use-count",
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createReadInsightsActivityMessage({
      ...activity,
      requestId: "13",
      timeZone: "Asia/Shanghai",
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createReadInsightsActivityMessage({
      ...activity,
      requestId: "13",
      window: {
        observedAtOrAfter: "+010000-08-03T00:00:00.000Z",
        observedBefore: "+010000-08-17T00:00:00.000Z",
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createReadCapabilityUsageMessage({
      ...usage,
      requestId: "12",
      filters: { ...usage.filters, provider: "codex" },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
});

test("Usage and Activity responses are bounded and preserve aggregate invariants", () => {
  const usage = {
    databaseUuid: EPOCH,
    snapshotSeq: "7",
    closureEvaluatedAt: "2026-08-11T00:00:00.000Z",
    quiescenceSeconds: 300,
    orderBy: "absolute-recorded-invocation-change",
    items: [{
      capabilityKey: "1".repeat(64),
      provider: "codex",
      kind: "tool",
      canonicalName: "Read",
      recordedInvocationCount: "7",
      recordedFailingInvocationCount: "2",
      distinctTurnCount: "5",
      distinctSessionCount: "4",
      lastUsedAt: "2026-08-10T01:02:03.000Z",
      invocationTerminalCounts: {
        invocationTotal: "7", pending: "0", completed: "5", failed: "2",
        cancelled: "0", unknown: "0",
      },
      containingTurnOutcomeCounts: {
        distinctTurnTotal: "5", providerCompleted: "3", abandoned: "1", unknown: "1",
      },
      groupedInvocationCount: "5",
      ungroupedInvocationCount: "2",
      support: {
        distinctDedupeGroupCount: "3",
        strongDedupeGroupCount: "2",
        weakDedupeGroupCount: "1",
        observedEofProvisionalGroupCount: "1",
        unknownDedupeSessionCount: "1",
        sessionDuplicateMethodCounts: { explicitLineage: "2", exactFirstTurnPrefix: "1" },
      },
      strengthCounts: { observed: "5", confirmed: "1", inferred: "1" },
      outOfWindow: {
        scope: "all-indexed-history",
        retrySummary: { failedCount: "9", sameInputRepeatCount: "4", retryAfterFailureCount: "3" },
      },
      comparison: {
        baselineRecordedInvocationCount: "5",
        currentRecordedInvocationCount: "7",
        absoluteRecordedInvocationChange: "2",
      },
    }],
    totalCandidateCount: "1",
    truncated: false,
    coverage: {
      excludedUndatedInvocationCount: "1",
      excludedUndatedTurnCount: "1",
      excludedUnrevisionedInvocationCount: "2",
      excludedUnrevisionedTurnCount: "2",
      fullyExcludedCapabilityCount: "3",
    },
    nextCursor: null,
  };
  const usageMessage = createCapabilityUsageMessage({ requestId: "14", usage });
  assert.equal(assertProtocolMessage(usageMessage), usageMessage);

  const activity = {
    databaseUuid: EPOCH,
    snapshotSeq: "7",
    closureEvaluatedAt: "2026-08-11T00:00:00.000Z",
    quiescenceSeconds: 300,
    buckets: [{
      bucketStart: "2026-08-10T00:00:00.000Z",
      bucketEnd: "2026-08-11T00:00:00.000Z",
      distinctSessionCount: "4",
      distinctTurnCount: "5",
      currentClosureCounts: { hardSealed: "2", quiescent: "1", open: "2" },
      turnResultEvidenceCounts: { providerCompleted: "3", abandoned: "1", unknown: "1" },
      recordedToolInvocationCount: "7",
      recordedSkillInvocationCount: "3",
      support: {
        distinctDedupeGroupCount: "3",
        strongDedupeGroupCount: "2",
        weakDedupeGroupCount: "1",
        observedEofProvisionalGroupCount: "1",
        unknownDedupeSessionCount: "1",
      },
    }],
    coverage: {
      excludedUndatedInvocationCount: "1",
      excludedUndatedTurnCount: "1",
      excludedUnrevisionedInvocationCount: "2",
      excludedUnrevisionedTurnCount: "2",
    },
  };
  const activityMessage = createInsightsActivityMessage({ requestId: "15", activity });
  assert.equal(assertProtocolMessage(activityMessage), activityMessage);

  assert.throws(
    () => createCapabilityUsageMessage({
      requestId: "14",
      usage: {
        ...usage,
        items: [{
          ...usage.items[0],
          invocationTerminalCounts: { ...usage.items[0].invocationTerminalCounts, failed: "1" },
        }],
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createInsightsActivityMessage({
      requestId: "15",
      activity: {
        ...activity,
        buckets: [{ ...activity.buckets[0], bucketEnd: "2026-08-10T12:00:00.000Z" }],
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
});

test("source-state pages preserve locator bytes and safe pages fit the 4 MiB frame", () => {
  assert.deepEqual(createListSourceStatesMessage({ requestId: "3" }), {
    format: INSIGHTS_PROTOCOL_FORMAT,
    type: "LIST_SOURCE_STATES",
    requestId: "3",
    cursor: null,
    limit: 256,
  });
  assert.deepEqual(createReadSourceCheckpointMessage({
    requestId: "4",
    sessionKey: SESSION_KEY,
  }), {
    format: INSIGHTS_PROTOCOL_FORMAT,
    type: "READ_SOURCE_CHECKPOINT",
    requestId: "4",
    sessionKey: SESSION_KEY,
  });
  assert.equal(createSourceCheckpointMessage({
    requestId: "4",
    sessionKey: SESSION_KEY,
    checkpoint: null,
  }).checkpoint, null);

  const locator = `/${"x".repeat(12 * 1_024 - 1)}`;
  const decomposedLocator = "/tmp/threadshare/cafe\u0301/session.jsonl";
  assert.equal(decodeSourceLocator(encodeSourceLocator(decomposedLocator)), decomposedLocator);
  assert.notEqual(decomposedLocator.normalize("NFC"), decomposedLocator);

  const states = Array.from({ length: 128 }, (_, index) =>
    sourceSummary(index.toString(16).padStart(64, "0"), locator));
  const page = createSourceStatesMessage({ requestId: "3", states });
  assert.ok(protocolPayloadByteLength(page) < MAX_PROTOCOL_PAYLOAD_BYTES);
  assert.doesNotThrow(() => encodeProtocolFrame(page));
  assert.throws(
    () => createSourceStatesMessage({
      requestId: "3",
      states: Array.from({ length: 257 }, (_, index) =>
        sourceSummary(index.toString(16).padStart(64, "0"))),
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createListSourceStatesMessage({ requestId: "3", limit: 257 }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
});

test("source lifecycle and purge maintenance frames are strict and path-free", () => {
  assert.deepEqual(createRemoveSourceMessage({ requestId: "5", sessionKey: SESSION_KEY }), {
    format: INSIGHTS_PROTOCOL_FORMAT,
    type: "REMOVE_SOURCE",
    requestId: "5",
    sessionKey: SESSION_KEY,
  });
  assert.equal(createSourceRemovedMessage({
    requestId: "5",
    sessionKey: SESSION_KEY,
    removed: true,
  }).removed, true);
  assert.equal(createExcludeSourceMessage({
    requestId: "6",
    sessionKey: SESSION_KEY,
  }).sessionKey, SESSION_KEY);
  assert.equal(createSourceExcludedMessage({
    requestId: "6",
    sessionKey: SESSION_KEY,
    excluded: true,
    purgeState: "pending-purge",
  }).purgeState, "pending-purge");
  assert.equal(createReadPurgeStatusMessage({ requestId: "7" }).sessionKey, null);
  assert.equal(createPurgeStatusMessage({
    requestId: "7",
    status: {
      state: "pending-purge",
      pendingFacts: "1",
      pendingMaintenance: "0",
      purged: "0",
    },
  }).state, "pending-purge");
  assert.equal(createRunPurgeMaintenanceMessage({ requestId: "8" }).limit, 64);
  assert.equal(createPurgeMaintenanceStatusMessage({
    requestId: "8",
    outcome: {
      processedSessions: "1",
      purgedSessions: "1",
      state: "purged",
      pendingFacts: "0",
      pendingMaintenance: "0",
      purged: "1",
    },
  }).state, "purged");
  assert.throws(
    () => createRunPurgeMaintenanceMessage({ requestId: "8", limit: 257 }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createSourceExcludedMessage({
      requestId: "6",
      sessionKey: SESSION_KEY,
      excluded: true,
      purgeState: "done",
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  const lifecycleFrame = JSON.stringify(createExcludeSourceMessage({
    requestId: "6",
    sessionKey: SESSION_KEY,
  }));
  assert.equal(lifecycleFrame.includes("file"), false);
  assert.equal(lifecycleFrame.includes("reason"), false);
});

test("decoder accepts fragmented prefix/payload and coalesced canonical frames", async () => {
  const hello = helloMessage();
  const ready = readyMessage();
  const helloFrame = encodeProtocolFrame(hello);
  const readyFrame = encodeProtocolFrame(ready);

  const bytewise = new ProtocolFrameDecoder();
  const decoded = [];
  for (const byte of helloFrame) decoded.push(...bytewise.push(Buffer.from([byte])));
  bytewise.end();
  assert.deepEqual(decoded, [hello]);

  const coalesced = new ProtocolFrameDecoder();
  assert.deepEqual(coalesced.push(Buffer.concat([helloFrame, readyFrame])), [hello, ready]);
  coalesced.end();

  assert.deepEqual(
    await collect(
      decodeProtocolFrames([
        helloFrame.subarray(0, 3),
        Buffer.concat([helloFrame.subarray(3), readyFrame.subarray(0, 11)]),
        readyFrame.subarray(11),
      ]),
    ),
    [hello, ready],
  );
});

test("decoder rejects EOF, oversize, invalid JSON/UTF-8, duplicate/non-canonical, and unknown fields", () => {
  const hello = helloMessage();
  const frame = encodeProtocolFrame(hello);
  for (const truncated of [frame.subarray(0, 2), frame.subarray(0, frame.length - 1)]) {
    const decoder = new ProtocolFrameDecoder();
    decoder.push(truncated);
    assert.throws(
      () => decoder.end(),
      (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
    );
  }

  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32BE(65);
  assert.throws(
    () => new ProtocolFrameDecoder({ maxPayloadBytes: 64 }).push(oversizedHeader),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_FRAME_TOO_LARGE",
  );
  assert.throws(
    () => new ProtocolFrameDecoder().push(rawFrame(Buffer.from([0xc3, 0x28]))),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
  assert.throws(
    () => new ProtocolFrameDecoder().push(rawFrame("{")),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
  assert.throws(
    () => new ProtocolFrameDecoder().push(rawFrame(JSON.stringify(hello))),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
  const duplicateKey = canonicalJson(hello).replace(
    "{",
    "{\"format\":\"threadshare-insights-protocol@v1\",",
  );
  assert.throws(
    () => new ProtocolFrameDecoder().push(rawFrame(duplicateKey)),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
  assert.throws(
    () => new ProtocolFrameDecoder().push(rawFrame(canonicalJson({ ...hello, future: true }))),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
  assert.throws(
    () => assertProtocolMessage({ ...hello, type: "FUTURE_MESSAGE" }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
  );
});

test("payload cap uses canonical UTF-8 bytes and permits an exactly full payload", () => {
  const empty = createUpsertBatchMessage({
    requestId: "2",
    sequence: "0",
    collection: "turns",
    items: [{ text: "" }],
  });
  const baseBytes = protocolPayloadByteLength(empty);
  const exact = createUpsertBatchMessage({
    requestId: "2",
    sequence: "0",
    collection: "turns",
    items: [{ text: "x".repeat(31) }],
  });
  const exactBytes = baseBytes + 31;
  assert.equal(protocolPayloadByteLength(exact), exactBytes);
  assert.equal(encodeProtocolFrame(exact, { maxPayloadBytes: exactBytes }).length, exactBytes + 4);
  assert.throws(
    () => encodeProtocolFrame(exact, { maxPayloadBytes: exactBytes - 1 }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_FRAME_TOO_LARGE",
  );

  const multibyte = createUpsertBatchMessage({
    requestId: "2",
    sequence: "0",
    collection: "turns",
    items: [{ text: "界".repeat(31) }],
  });
  assert.equal(protocolPayloadByteLength(multibyte), baseBytes + 31 * 3);
});

test("HELLO/READY and BEGIN negotiate every contract axis", () => {
  const hello = helloMessage();
  assert.deepEqual(hello.requiredContract.providerAdapterVersions, ["claude@1", "codex@1"]);
  const ready = readyMessage();
  assert.equal(assertHandshakeCompatible(hello, ready), true);

  const begin = createBeginSessionMessage(sampleDelta(), sessionOptions());
  assert.equal(assertBeginSessionCompatible(begin, ready), true);
  assert.deepEqual(begin.counts, {
    turnKeys: "0",
    orphanEventKeys: "0",
    authoritativeTurnKeys: "0",
    turns: "0",
    sourceRecords: "0",
    evidenceEvents: "0",
    turnEvidence: "0",
    capabilities: "0",
    capabilityUses: "0",
    capabilityUseEvidence: "0",
  });
  assert.deepEqual(begin.session, sampleDelta().session);

  const unsupported = readyMessage({ storageSchemaVersion: 2 });
  assert.throws(
    () => assertHandshakeCompatible(hello, unsupported),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_CONTRACT_UNSUPPORTED",
  );
  assert.throws(
    () => assertBeginSessionCompatible(begin, unsupported),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_CONTRACT_UNSUPPORTED",
  );
});

test("response and abort envelopes use request-scoped decimal sequence", () => {
  const begin = createBeginSessionMessage(sampleDelta(), sessionOptions());
  const messages = [
    createSessionAcceptedMessage(begin),
    createBatchAcceptedMessage({ requestId: "2", sequence: "0" }),
    createSessionCommittedMessage({
      requestId: "2",
      sessionKey: SESSION_KEY,
      deltaId: DELTA_ID,
      snapshotSeq: "9",
      idempotent: false,
    }),
    createAbortSessionMessage({ requestId: "2", nextSequence: "1", reason: "cancelled" }),
    createSessionAbortedMessage({
      requestId: "2",
      sessionKey: SESSION_KEY,
      deltaId: DELTA_ID,
      nextSequence: "1",
    }),
    createProtocolErrorMessage({
      requestId: "2",
      code: "TS_INSIGHTS_GENERATION_CONFLICT",
      category: "conflict",
      message: "generation conflict",
      retryable: true,
      fatal: false,
    }),
  ];
  for (const message of messages) {
    assert.deepEqual(new ProtocolFrameDecoder().push(encodeProtocolFrame(message)), [message]);
  }
  assert.throws(
    () => createProtocolErrorMessage({
      requestId: "2",
      code: "X",
      category: "protocol",
      message: "界".repeat(342),
    }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
});

test("session generator greedily batches actual canonical bytes in fixed collection order", async () => {
  const first = { turnKey: "1".repeat(64), text: "界".repeat(120) };
  const second = { turnKey: "2".repeat(64), text: "界".repeat(120) };
  const twoTurnBytes = protocolPayloadByteLength(
    createUpsertBatchMessage({
      requestId: "2",
      sequence: "3",
      collection: "turns",
      items: [first, second],
    }),
  );
  const maxPayloadBytes = twoTurnBytes - 1;
  const delta = sampleDelta({
    retractions: {
      turnKeys: ["3".repeat(64)],
      orphanEventKeys: ["4".repeat(64)],
      authoritativeTurnKeys: ["1".repeat(64), "2".repeat(64)],
    },
    turns: [first, second],
    sourceRecords: [{ sourceRecordKey: "5".repeat(64) }],
    capabilities: [{ capabilityKey: "6".repeat(64) }],
  });
  const beginBytes = protocolPayloadByteLength(createBeginSessionMessage(delta, sessionOptions()));
  assert.ok(maxPayloadBytes > beginBytes);

  const messages = await collect(
    createSessionDeltaMessages(delta, sessionOptions({ maxPayloadBytes })),
  );
  assert.equal(messages[0].type, "BEGIN_SESSION");
  assert.equal(messages.at(-1).type, "COMMIT_SESSION");
  for (const message of messages) {
    assert.ok(protocolPayloadByteLength(message) <= maxPayloadBytes, message.type);
  }

  const batches = messages.slice(1, -1);
  assert.deepEqual(
    batches.map((message) => `${message.type}:${message.collection}`),
    [
      "RETRACT_FACTS:turnKeys",
      "RETRACT_FACTS:orphanEventKeys",
      "RETRACT_FACTS:authoritativeTurnKeys",
      "UPSERT_FACTS:turns",
      "UPSERT_FACTS:turns",
      "UPSERT_FACTS:sourceRecords",
      "UPSERT_FACTS:capabilities",
    ],
  );
  assert.deepEqual(
    batches.map((message) => message.sequence),
    batches.map((_, index) => String(index)),
  );
  assert.equal(messages.at(-1).nextSequence, String(batches.length));
  assert.deepEqual(
    batches.filter((message) => message.collection === "turns").flatMap((message) => message.items),
    [first, second],
  );

  const validator = new SessionBatchSequenceValidator(messages[0]);
  for (const message of messages.slice(1)) validator.accept(message);
  assert.equal(validator.done, true);
  assert.equal(validator.nextSequence, String(batches.length));
});

test("trace source batches flatten commit files and stay within the frame limit", async () => {
  const messages = await collect(createTraceSourceDeltaMessages(traceSourceDelta(), {
    requestId: "81",
    maxPayloadBytes: 1_024,
  }));
  assert.equal(messages[0].type, "BEGIN_TRACE_SOURCE");
  assert.deepEqual(messages[0].counts, {
    refs: "1", commits: "1", files: "1", intentNodes: "0", intentRefs: "0",
  });
  assert.equal(messages.at(-1).type, "COMMIT_TRACE_SOURCE");
  const batches = messages.filter((message) => message.type === "TRACE_SOURCE_BATCH");
  assert.deepEqual(batches.map((message) => message.collection), ["refs", "commits", "files"]);
  assert.equal(Object.hasOwn(batches[1].items[0], "files"), false);
  assert.equal(batches[2].items[0].objectId, "a".repeat(40));
  for (const message of messages) {
    assert.ok(protocolPayloadByteLength(message) <= 1_024);
    assert.equal(assertProtocolMessage(message), message);
  }
});

test("Fact V2 session batches history metadata before payload chunks in fixed order", async () => {
  assert.deepEqual(V2_UPSERT_COLLECTION_ORDER, [
    "turns",
    "sourceRecords",
    "evidenceEvents",
    "turnEvidence",
    "capabilities",
    "capabilityUses",
    "capabilityUseEvidence",
    "historyEvents",
    "historyPayloads",
    "historyPayloadChunks",
  ]);
  const eventKey = "7".repeat(64);
  const payloadKey = "8".repeat(64);
  const delta = sampleDeltaV2({
    historyEvents: [{ eventKey }],
    historyPayloads: [{ payloadKey, eventKey }],
    historyPayloadChunks: [{ payloadKey, ordinal: "0", content: "private" }],
  });
  const messages = await collect(createSessionDeltaMessages(delta, sessionOptions()));
  assert.deepEqual(
    messages.slice(1, -1).map((message) => `${message.type}:${message.collection}`),
    [
      "UPSERT_FACTS:historyEvents",
      "UPSERT_FACTS:historyPayloads",
      "UPSERT_FACTS:historyPayloadChunks",
    ],
  );
  assert.deepEqual(messages[0].counts, {
    turnKeys: "0",
    orphanEventKeys: "0",
    authoritativeTurnKeys: "0",
    turns: "0",
    sourceRecords: "0",
    evidenceEvents: "0",
    turnEvidence: "0",
    capabilities: "0",
    capabilityUses: "0",
    capabilityUseEvidence: "0",
    historyEvents: "1",
    historyPayloads: "1",
    historyPayloadChunks: "1",
  });
});

test("deep Query v2 protocol keeps requests exact and rejects forged response invariants", () => {
  const request = deepQueryRequest();
  const frame = createReadInsightsQueryV2Message({ requestId: "41", request });
  assert.equal(frame.request, request);
  assert.throws(
    () => createReadInsightsQueryV2Message({
      requestId: "41",
      request: { ...request, sql: "SELECT * FROM history_events" },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );

  const response = deepQueryResponse();
  assert.equal(
    createInsightsQueryV2Message({ requestId: "41", response }).response,
    response,
  );
  assert.throws(
    () => createInsightsQueryV2Message({
      requestId: "41",
      response: { ...response, totalMatchCount: "0" },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createInsightsQueryV2Message({
      requestId: "41",
      response: {
        ...response,
        records: [{
          eventKey: TURN_KEY,
          message: { content: contentReference({ inline: "private" }) },
        }],
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
});

test("deep Evidence v2 protocol binds revisions and UTF-8 byte ranges", () => {
  const request = {
    format: "threadshare-insights-evidence-request@v2",
    target: deepEvidenceTarget(),
    include: ["envelope", "payload"],
    cursor: null,
    maxBytes: 1024,
  };
  assert.equal(
    createReadInsightsEvidenceV2Message({ requestId: "42", request }).request,
    request,
  );
  const wholeEvent = {
    ...request,
    target: {
      kind: "event",
      eventKey: TURN_KEY,
      revision: REVISION,
    },
  };
  assert.equal(
    createReadInsightsEvidenceV2Message({ requestId: "43", request: wholeEvent }).request,
    wholeEvent,
  );
  assert.throws(
    () => createReadInsightsEvidenceV2Message({
      requestId: "42",
      request: { ...request, include: ["payload", "envelope"] },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );

  const response = {
    format: "threadshare-insights-evidence@v2",
    databaseUuid: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee",
    snapshotSeq: "7",
    target: request.target,
    revision: REVISION,
    payloadSha256: "2".repeat(64),
    totalBytes: "7",
    range: { start: "0", end: "7" },
    content: "private",
    nextCursor: null,
    complete: true,
  };
  assert.equal(
    createInsightsEvidenceV2Message({ requestId: "42", response }).response,
    response,
  );
  assert.throws(
    () => createInsightsEvidenceV2Message({
      requestId: "42",
      response: { ...response, range: { start: "0", end: "6" } },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
});

test("Recipe protocol keeps requests exact and rejects forged response counts", async () => {
  const request = recipeRequest();
  assert.equal(
    createReadInsightsRecipeMessage({ requestId: "43", request }).request,
    request,
  );
  assert.throws(
    () => createReadInsightsRecipeMessage({
      requestId: "43",
      request: { ...request, name: "arbitrary-sql@1" },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createReadInsightsRecipeMessage({
      requestId: "43",
      request: { ...request, sql: "SELECT * FROM history_events" },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );

  const response = recipeResponse();
  assert.equal(
    createInsightsRecipeMessage({ requestId: "43", response }).response,
    response,
  );
  assert.equal(
    createInsightsQueryV2Message({
      requestId: "43",
      response: deepQueryResponse({
        records: [{
          eventKey: TURN_KEY,
          tool: { input: contentReference({ encoding: "canonical-json" }) },
        }],
      }),
    }).response.records[0].tool.input.encoding,
    "canonical-json",
  );
  assert.throws(
    () => createInsightsRecipeMessage({
      requestId: "43",
      response: { ...response, totalItemCount: "0" },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createInsightsRecipeMessage({
      requestId: "43",
      response: {
        ...response,
        coverage: { ...response.coverage, truncatedRecordCount: "1", degraded: false },
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createInsightsRecipeMessage({
      requestId: "43",
      response: {
        ...response,
        coverage: {
          ...response.coverage,
          matching: { ...response.coverage.matching, missingTokenMetricCount: "7" },
        },
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
  assert.throws(
    () => createInsightsRecipeMessage({
      requestId: "43",
      response: {
        ...response,
        coverage: { ...response.coverage, diagnostics: ["TS_INSIGHTS_PARTIAL"] },
      },
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );

  const recipes = JSON.parse(await readFile(recipeItemsUrl, "utf8"));
  assert.equal(recipes.length, 8);
  for (const { name, item } of recipes) {
    const typed = recipeResponse({ name, items: [item] });
    assert.equal(
      createInsightsRecipeMessage({ requestId: "43", response: typed }).response,
      typed,
      name,
    );
    assert.throws(
      () => createInsightsRecipeMessage({
        requestId: "43",
        response: { ...typed, items: [{ ...item, unreviewed: true }] },
      }),
      { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
      name,
    );
  }

  const fileWorkflow = recipes.find(({ name }) => name === "file-workflow-signals@1");
  const sampledDetails = structuredClone(fileWorkflow.item);
  sampledDetails.recordedCounts.read = "2";
  sampledDetails.recordedCounts.attempted = "2";
  assert.equal(
    createInsightsRecipeMessage({
      requestId: "43",
      response: recipeResponse({
        name: fileWorkflow.name,
        items: [sampledDetails],
      }),
    }).response.items[0].events.length,
    1,
  );
  assert.throws(
    () => createInsightsRecipeMessage({
      requestId: "43",
      response: recipeResponse({
        name: fileWorkflow.name,
        items: [{
          ...sampledDetails,
          recordedCounts: { ...sampledDetails.recordedCounts, attempted: "1" },
        }],
      }),
    }),
    { code: "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" },
  );
});

test("session sequence rejects gaps, count mismatch, collection regression, and request mismatch", () => {
  const begin = createBeginSessionMessage(
    sampleDelta({
      retractions: {
        turnKeys: ["1".repeat(64)],
        orphanEventKeys: [],
        authoritativeTurnKeys: [],
      },
      turns: [{ turnKey: "2".repeat(64) }],
    }),
    sessionOptions(),
  );
  const gap = new SessionBatchSequenceValidator(begin);
  assert.throws(
    () => gap.accept(createRetractionBatchMessage({
      requestId: "2",
      sequence: "1",
      collection: "turnKeys",
      items: ["1".repeat(64)],
    })),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
  );

  const overflow = new SessionBatchSequenceValidator(begin);
  assert.throws(
    () => overflow.accept(createRetractionBatchMessage({
      requestId: "2",
      sequence: "0",
      collection: "turnKeys",
      items: ["1".repeat(64), "3".repeat(64)],
    })),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
  );

  const regression = new SessionBatchSequenceValidator(begin);
  regression.accept(createUpsertBatchMessage({
    requestId: "2",
    sequence: "0",
    collection: "turns",
    items: [{ turnKey: "2".repeat(64) }],
  }));
  assert.throws(
    () => regression.accept(createRetractionBatchMessage({
      requestId: "2",
      sequence: "1",
      collection: "turnKeys",
      items: ["1".repeat(64)],
    })),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
  );

  const foreign = new SessionBatchSequenceValidator(begin);
  assert.throws(
    () => foreign.accept(createRetractionBatchMessage({
      requestId: "3",
      sequence: "0",
      collection: "turnKeys",
      items: ["1".repeat(64)],
    })),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
  );

  for (const sequence of ["01", "18446744073709551616"]) {
    assert.throws(
      () => createRetractionBatchMessage({
        requestId: "2",
        sequence,
        collection: "turnKeys",
        items: ["1".repeat(64)],
      }),
      (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
    );
  }
  assert.throws(
    () => createHelloMessage({
      requestId: "1",
      clientVersion: "threadshare@0.6.1",
      requiredContract: handshakeContract({ providerAdapterVersions: ["cödex@1"] }),
    }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
});

test("single Fact cannot split and async generator does not pre-encode later collections", async () => {
  let turnsCanonicalized = 0;
  const lazyTurn = new Proxy(
    { turnKey: "1".repeat(64), text: "lazy" },
    {
      ownKeys(target) {
        turnsCanonicalized += 1;
        return Reflect.ownKeys(target);
      },
    },
  );
  const iterator = createSessionDeltaMessages(
    sampleDelta({ turns: [lazyTurn] }),
    sessionOptions({ maxPayloadBytes: 1_024 }),
  );
  assert.equal((await iterator.next()).value.type, "BEGIN_SESSION");
  assert.equal(turnsCanonicalized, 0);
  assert.equal((await iterator.next()).value.collection, "turns");
  assert.ok(turnsCanonicalized > 0);

  await assert.rejects(
    () => collect(
      createSessionDeltaMessages(
        sampleDelta({ turns: [{ turnKey: "1".repeat(64), text: "x".repeat(2_000) }] }),
        sessionOptions({ maxPayloadBytes: 1_024 }),
      ),
    ),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_ITEM_TOO_LARGE",
  );
});
