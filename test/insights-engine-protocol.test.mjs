import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJson } from "../src/session-facts.mjs";
import {
  INSIGHTS_PROTOCOL_FORMAT,
  INSIGHTS_PROTOCOL_VERSION,
  MAX_PROTOCOL_PAYLOAD_BYTES,
  RETRACTION_COLLECTION_ORDER,
  UPSERT_COLLECTION_ORDER,
  ProtocolFrameDecoder,
  SessionBatchSequenceValidator,
  assertBeginSessionCompatible,
  assertHandshakeCompatible,
  assertProtocolMessage,
  createAbortSessionMessage,
  createBatchAcceptedMessage,
  createBeginSessionMessage,
  createExcludeSourceMessage,
  createEngineStatusMessage,
  createHelloMessage,
  createListSourceStatesMessage,
  createProtocolErrorMessage,
  createPurgeMaintenanceStatusMessage,
  createPurgeStatusMessage,
  createReadPurgeStatusMessage,
  createReadEngineStatusMessage,
  createReadTurnEvidenceMessage,
  createReadSourceCheckpointMessage,
  createRemoveSourceMessage,
  createReadyMessage,
  createRetractionBatchMessage,
  createSessionAbortedMessage,
  createSessionAcceptedMessage,
  createSessionCommittedMessage,
  createSessionDeltaMessages,
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
} from "../src/insights-engine-protocol.mjs";

const fixtureUrl = new URL("./fixtures/insights-protocol-v1/frames.json", import.meta.url);
const SESSION_KEY = "a".repeat(64);
const DELTA_ID = "b".repeat(64);
const EPOCH = "11111111-2222-4333-8444-555555555555";
const COMPILE_OPTIONS_DIGEST = "c".repeat(64);
const BUILD_MANIFEST_DIGEST = "d".repeat(64);
const TURN_KEY = "e".repeat(64);
const REVISION = "f".repeat(64);

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
    observedAtOrAfterUnixMs: null,
    observedBeforeUnixMs: null,
    toolCapabilityKeys: [],
    skillCapabilityKeys: [],
    resultEvidence: [],
    closureStates: [],
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

test("turn search requests canonicalize bounded filters and reject broad queries", () => {
  const request = createSearchTurnsMessage({
    requestId: "10",
    query: "Bash timeout",
    filters: searchFilters({
      providers: ["codex", "claude"],
      toolCapabilityKeys: ["2".repeat(64), "1".repeat(64)],
      resultEvidence: ["unknown", "provider-completed"],
    }),
    nowUnixMs: "1786323723000",
  });
  assert.deepEqual(request.filters.providers, ["claude", "codex"]);
  assert.deepEqual(request.filters.toolCapabilityKeys, ["1".repeat(64), "2".repeat(64)]);
  assert.deepEqual(request.filters.resultEvidence, ["provider-completed", "unknown"]);
  assert.equal(request.limit, 50);
  assert.equal(request.pathLimit, 10);
  assert.equal(request.quiescenceSeconds, 300);
  assert.equal(assertProtocolMessage(request), request);

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
    snapshot: {
      snapshotSeq: "21",
      projectionVersion: 2,
      analyzerVersion: 1,
      rankerVersion: 1,
    },
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
