import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { createInsightsEngineClient } from "../src/insights-engine-client.mjs";
import {
  insightsEnginePackageName,
  insightsEngineTarget,
} from "../src/insights-engine-runtime.mjs";
import {
  assertHandshakeCompatible,
  createBeginSessionMessage,
  createHelloMessage,
  decodeProtocolFrames,
  encodeProtocolFrame,
} from "../src/insights-engine-protocol.mjs";
import { assertSessionFactsDelta, canonicalJson, hashKey } from "../src/session-facts.mjs";

const ENGINE_NAME = process.platform === "win32"
  ? "threadshare-insights-engine.exe"
  : "threadshare-insights-engine";
const ENGINE_PATH = fileURLToPath(
  new URL(`../crates/insights-engine/target/debug/${ENGINE_NAME}`, import.meta.url),
);
const ORIGIN_SECRET_EPOCH = "22222222-2222-4222-8222-222222222222";
const SESSION_KEY = hashKey("session", "codex", "client-e2e-session");

function handshakeContract() {
  return {
    factSchemaVersion: 1,
    providerAdapterVersions: ["claude@1", "codex@1"],
    privacyPolicyVersion: 1,
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    duplicatePolicyVersion: 1,
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: ["turn-search@2", "turn-summary@1"],
    analyzerCapabilities: ["mixed-cjk-code@1"],
    rankerVersion: 1,
  };
}

function checkpoint(generation, completeOffset) {
  return {
    completeOffset,
    eofObserved: true,
    partialTailLength: "0",
    partialTailDigest: "0".repeat(64),
    sourceSize: completeOffset,
    sourceMtimeNs: "0",
    sourceSnapshotStable: true,
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    generation,
    pendingState: {
      currentTurnKey: null,
      replayFromOffset: null,
      pendingStarted: [],
      pendingUses: [],
      sessionState: {
        sessionKey: SESSION_KEY,
        sessionScope: "main",
        eligibility: "eligible",
        originatorVersion: null,
        projectKey: null,
        observedStart: null,
        observedEnd: null,
        firstTurnKey: null,
        secondTurnKey: null,
        factTruncation: [],
        dedupe: null,
      },
      catalogEntries: [],
      seenClaudeUuids: [],
    },
  };
}

function finalizeDelta(delta) {
  const mutation = structuredClone(delta);
  delete mutation.deltaId;
  const mutationDigest = createHash("sha256").update(canonicalJson(mutation)).digest();
  delta.deltaId = hashKey(
    "delta",
    Buffer.from(delta.session.sessionKey, "hex"),
    delta.expectedGeneration,
    delta.mode,
    delta.originSecretEpoch,
    String(delta.duplicatePolicyVersion),
    mutationDigest,
    delta.checkpoint.completeOffset,
  );
  return assertSessionFactsDelta(delta);
}

function sampleDelta({
  expectedGeneration = "0",
  targetGeneration = "1",
  largePayload = false,
} = {}) {
  return finalizeDelta({
    format: "session-facts-delta@v1",
    factSchemaVersion: 1,
    providerAdapterVersion: "codex@1",
    privacyPolicyVersion: 1,
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    duplicatePolicyVersion: 1,
    expectedGeneration,
    targetGeneration,
    mode: "append",
    deltaId: "0".repeat(64),
    session: {
      sessionKey: SESSION_KEY,
      provider: "codex",
      sessionScope: "main",
      eligibility: "eligible",
      duplicateGroupKey: null,
      duplicatePolicyVersion: 1,
    },
    retractions: {
      turnKeys: [],
      orphanEventKeys: [],
      authoritativeTurnKeys: [],
    },
    turns: [],
    sourceRecords: largePayload
      ? [{
        sourceRecordKey: createHash("sha256").update("large-record").digest("hex"),
        ownerSessionKey: SESSION_KEY,
        startOffset: "0",
        endOffset: "1",
        recordSha256: createHash("sha256").update("large-record-body").digest("hex"),
        providerRecordClass: `response_item:message:${"x".repeat(72 * 1_024)}`,
      }]
      : [],
    evidenceEvents: [],
    turnEvidence: [],
    capabilities: [],
    capabilityUses: [],
    capabilityUseEvidence: [],
    checkpoint: checkpoint(targetGeneration, targetGeneration),
    diagnostics: [],
    coverage: {},
  });
}

async function queryFixtureDelta({ withLifecycle = true } = {}) {
  const fixture = JSON.parse(await readFile(new URL(
    "./fixtures/insights-fact-mutations/v1-basic.json",
    import.meta.url,
  ), "utf8"));
  const delta = structuredClone(fixture.initial);
  if (withLifecycle) {
    const lifecycleSourceKey = createHash("sha256")
      .update("query-fixture-lifecycle-source")
      .digest("hex");
    const lifecycleEventKey = createHash("sha256")
      .update("query-fixture-lifecycle-event")
      .digest("hex");
    delta.sourceRecords.push({
      sourceRecordKey: lifecycleSourceKey,
      ownerSessionKey: delta.session.sessionKey,
      startOffset: delta.checkpoint.completeOffset,
      endOffset: delta.checkpoint.completeOffset,
      recordSha256: createHash("sha256")
        .update("query-fixture-lifecycle-record")
        .digest("hex"),
      providerRecordClass: "event_msg:task_complete",
    });
    delta.evidenceEvents.push({
      eventKey: lifecycleEventKey,
      ownerSessionKey: delta.session.sessionKey,
      occurredTurnKey: null,
      sourceRecordKey: lifecycleSourceKey,
      sourceOrder: {
        recordStartOffset: delta.checkpoint.completeOffset,
        contentIndex: -1,
        eventOrdinal: 2,
      },
      pointer: {
        pointerKind: "codex:event_msg:task_complete",
        contentIndex: -1,
        eventOrdinal: 2,
      },
      originScope: "main",
      observedTimestamp: delta.session.observedEnd,
      kind: "turn-lifecycle",
      lifecycleState: "completed",
      providerTurnDigest: null,
    });
    delta.turnEvidence.push({
      ownerSessionKey: delta.session.sessionKey,
      turnKey: delta.turns[0].turnKey,
      eventKey: lifecycleEventKey,
      role: "lifecycle",
    });
  }
  delta.originSecretEpoch = ORIGIN_SECRET_EPOCH;
  delta.checkpoint.originSecretEpoch = ORIGIN_SECRET_EPOCH;
  return finalizeDelta(delta);
}

function sourceStateForDelta(delta, overrides = {}) {
  const size = BigInt(delta.checkpoint.sourceSize);
  const completeOffset = BigInt(delta.checkpoint.completeOffset);
  const headLength = Number(size < 4096n ? size : 4096n);
  const boundaryLength = Number(completeOffset < 4096n ? completeOffset : 4096n);
  return {
    provider: delta.session.provider,
    sessionId: overrides.sessionId ?? "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
    file: overrides.file ?? "/tmp/threadshare/codex-session.jsonl",
    sessionKey: delta.session.sessionKey,
    projectKey: delta.session.projectKey ?? null,
    metadata: {
      dev: "1",
      ino: "2",
      size: delta.checkpoint.sourceSize,
      mtimeNs: delta.checkpoint.sourceMtimeNs,
    },
    fingerprints: {
      head: {
        offset: "0",
        length: headLength,
        sha256: "e".repeat(64),
      },
      boundary: {
        offset: String(completeOffset - BigInt(boundaryLength)),
        length: boundaryLength,
        sha256: "f".repeat(64),
      },
    },
    checkpoint: structuredClone(delta.checkpoint),
    contract: {
      factSchemaVersion: delta.factSchemaVersion,
      providerAdapterVersion: delta.providerAdapterVersion,
      privacyPolicyVersion: delta.privacyPolicyVersion,
      duplicatePolicyVersion: delta.duplicatePolicyVersion,
      originSecretEpoch: delta.originSecretEpoch,
    },
  };
}

function clientOptions(databasePath, overrides = {}) {
  return {
    runtimeOptions: {
      env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: ENGINE_PATH },
    },
    databasePath,
    requiredContract: handshakeContract(),
    timeoutMs: 5_000,
    ...overrides,
  };
}

async function temporaryDatabase(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return path.join(directory, "insights.sqlite3");
}

async function writeFrame(stream, message) {
  if (!stream.write(encodeProtocolFrame(message))) await once(stream, "drain");
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function createFakePlatformPackage(directory) {
  const target = insightsEngineTarget();
  assert.ok(target, "the current platform must have an Insights Engine target");
  const packageRoot = path.join(directory, "platform-package");
  const binDirectory = path.join(packageRoot, "bin");
  const binaryName = process.platform === "win32"
    ? "threadshare-insights-engine.exe"
    : "threadshare-insights-engine";
  const binaryPath = path.join(binDirectory, binaryName);
  const packagePath = path.join(packageRoot, "package.json");
  const manifestPath = path.join(packageRoot, "build-manifest.json");
  const version = "9.8.7";
  const binary = `#!/usr/bin/env node
const { createHash } = require("node:crypto");
const { readFileSync } = require("node:fs");
const path = require("node:path");
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}

let input = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  if (input.length < 4) return;
  const length = input.readUInt32BE(0);
  if (input.length < length + 4) return;
  const hello = JSON.parse(input.subarray(4, length + 4).toString("utf8"));
  const manifest = readFileSync(path.join(__dirname, "..", "build-manifest.json"));
  const axis = process.env.THREADSHARE_FAKE_IDENTITY_MISMATCH;
  const ready = {
    format: "threadshare-insights-protocol@v1",
    type: "READY",
    requestId: hello.requestId,
    engineVersion: axis === "version" ? "9.8.6" : "${version}",
    target: axis === "target" ? "wrong-target" : "${target.target}",
    maxFrameBytes: 4194304,
    sqliteVersion: axis === "sqlite" ? "3.52.0" : "3.53.2",
    sqliteCompileOptionsDigest: "c".repeat(64),
    buildManifestDigest: axis === "manifest" ? "f".repeat(64) : createHash("sha256").update(manifest).digest("hex"),
    acceptedContract: hello.requiredContract,
  };
  const payload = Buffer.from(canonical(ready));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  process.stdout.write(Buffer.concat([prefix, payload]));
});
`;
  const binaryBytes = Buffer.from(binary);
  const manifest = {
    abi: target.abi,
    binary: `bin/${binaryName}`,
    binarySha256: sha256(binaryBytes),
    format: "threadshare-insights-build@v1",
    license: "MIT",
    minimumOs: target.minimumOs,
    packageName: insightsEnginePackageName(target.target),
    protocolVersion: 1,
    rustTarget: target.rustTarget,
    sourceSha: "a".repeat(64),
    sqliteVersion: "3.53.2",
    target: target.target,
    version,
  };
  await mkdir(binDirectory, { recursive: true });
  await Promise.all([
    writeFile(binaryPath, binaryBytes, { mode: 0o700 }),
    writeFile(packagePath, canonicalJson({
      name: manifest.packageName,
      version,
      os: [target.os],
      cpu: [target.cpu],
    })),
    writeFile(manifestPath, canonicalJson(manifest)),
  ]);
  return {
    runtimeOptions: {
      env: {},
      platform: target.platform,
      arch: target.arch,
      version,
      resolvePackage: () => packagePath,
    },
  };
}

async function createSessionDisconnectEngine(directory) {
  const binaryPath = path.join(directory, "session-disconnect-engine");
  const binary = `#!/usr/bin/env node
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function send(message, callback) {
  const payload = Buffer.from(canonical(message));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  process.stdout.write(Buffer.concat([prefix, payload]), callback);
}
let input = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32BE(0);
    if (input.length < length + 4) return;
    const message = JSON.parse(input.subarray(4, length + 4).toString("utf8"));
    input = input.subarray(length + 4);
    if (message.type === "HELLO") {
      send({
        format: "threadshare-insights-protocol@v1",
        type: "READY",
        requestId: message.requestId,
        engineVersion: "test",
        target: "development",
        maxFrameBytes: 4194304,
        sqliteVersion: "3.53.2",
        sqliteCompileOptionsDigest: "c".repeat(64),
        buildManifestDigest: "d".repeat(64),
        acceptedContract: message.requiredContract,
      });
    } else if (message.type === "BEGIN_SESSION") {
      send({
        format: "threadshare-insights-protocol@v1",
        type: "SESSION_ACCEPTED",
        requestId: message.requestId,
        sessionKey: message.session.sessionKey,
        deltaId: message.deltaId,
        nextSequence: "0",
      }, () => process.exit(9));
    }
  }
});
`;
  await writeFile(binaryPath, binary, { mode: 0o700 });
  return binaryPath;
}

async function createDelayedCommitEngine(directory, delayMs) {
  const binaryPath = path.join(directory, "delayed-commit-engine");
  const binary = `#!/usr/bin/env node
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function send(message) {
  const payload = Buffer.from(canonical(message));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  process.stdout.write(Buffer.concat([prefix, payload]));
}
let input = Buffer.alloc(0);
let sessionKey;
let deltaId;
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32BE(0);
    if (input.length < length + 4) return;
    const message = JSON.parse(input.subarray(4, length + 4).toString("utf8"));
    input = input.subarray(length + 4);
    if (message.type === "HELLO") {
      send({
        format: "threadshare-insights-protocol@v1",
        type: "READY",
        requestId: message.requestId,
        engineVersion: "test",
        target: "development",
        maxFrameBytes: 4194304,
        sqliteVersion: "3.53.2",
        sqliteCompileOptionsDigest: "c".repeat(64),
        buildManifestDigest: "d".repeat(64),
        acceptedContract: message.requiredContract,
      });
    } else if (message.type === "BEGIN_SESSION") {
      sessionKey = message.session.sessionKey;
      deltaId = message.deltaId;
      send({
        format: "threadshare-insights-protocol@v1",
        type: "SESSION_ACCEPTED",
        requestId: message.requestId,
        sessionKey,
        deltaId,
        nextSequence: "0",
      });
    } else if (message.type === "RETRACT_FACTS" || message.type === "UPSERT_FACTS") {
      send({
        format: "threadshare-insights-protocol@v1",
        type: "BATCH_ACCEPTED",
        requestId: message.requestId,
        sequence: message.sequence,
      });
    } else if (message.type === "COMMIT_SESSION") {
      setTimeout(() => send({
        format: "threadshare-insights-protocol@v1",
        type: "SESSION_COMMITTED",
        requestId: message.requestId,
        sessionKey,
        deltaId,
        snapshotSeq: "1",
        idempotent: false,
      }), ${delayMs});
    }
  }
});
`;
  await writeFile(binaryPath, binary, { mode: 0o700 });
  return binaryPath;
}

async function createQueryProtocolEngine(directory) {
  const binaryPath = path.join(directory, "query-protocol-engine");
  const binary = `#!/usr/bin/env node
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function send(message) {
  const payload = Buffer.from(canonical(message));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  process.stdout.write(Buffer.concat([prefix, payload]));
}
const turnKey = "e".repeat(64);
const sessionKey = "a".repeat(64);
const revision = "f".repeat(64);
let input = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32BE(0);
    if (input.length < length + 4) return;
    const message = JSON.parse(input.subarray(4, length + 4).toString("utf8"));
    input = input.subarray(length + 4);
    if (message.type === "HELLO") {
      send({
        format: "threadshare-insights-protocol@v1", type: "READY", requestId: message.requestId,
        engineVersion: "test", target: "development", maxFrameBytes: 4194304,
        sqliteVersion: "3.53.2", sqliteCompileOptionsDigest: "c".repeat(64),
        buildManifestDigest: "d".repeat(64), acceptedContract: message.requiredContract,
      });
    } else if (message.type === "SEARCH_TURNS") {
      if (message.query !== "needle" || message.filters.providers[0] !== "codex") process.exit(12);
      send({
        format: "threadshare-insights-protocol@v1", type: "TURN_SEARCH_RESULTS",
        requestId: message.requestId,
        snapshot: { snapshotSeq: "7", projectionVersion: 2, analyzerVersion: 1, rankerVersion: 1 },
        scoringTerms: [], results: [],
        evidencePaths: {
          insufficientSample: true, rawMatchCount: 0, eligibleTurnCount: 0,
          rawSessionCount: 0, independentGroupCount: 0, strongGroupCount: 0,
          weakGroupCount: 0, observedEofProvisionalGroupCount: 0,
          unknownDedupeCount: 0, unknownDedupeSessionCount: 0,
          pathsTruncated: false, families: [],
        },
        diagnostic: {
          analyzeMicros: 1, dfMicros: 0, postingFilterMicros: 1, rerankMicros: 0,
          pathMicros: 0, zeroDfTermCount: 1, highFrequencyTermCount: 0,
          truncatedTermCount: 0, scoringTermCount: 0,
        },
        searchTrace: { candidateCount: 0, candidateTurnKeys: [] },
      });
    } else if (message.type === "READ_CAPABILITY_USAGE") {
      if (message.kind !== "tool" || message.orderBy !== "recorded-invocation-count") {
        process.exit(14);
      }
      send({
        format: "threadshare-insights-protocol@v1", type: "CAPABILITY_USAGE",
        requestId: message.requestId,
        databaseUuid: "11111111-2222-4333-8444-555555555555",
        snapshotSeq: "7", closureEvaluatedAt: "2026-08-11T00:00:00.000Z",
        quiescenceSeconds: 300, orderBy: message.orderBy, items: [],
        totalCandidateCount: "0", truncated: false,
        coverage: {
          excludedUndatedInvocationCount: "0", excludedUndatedTurnCount: "0",
          excludedUnrevisionedInvocationCount: "0", excludedUnrevisionedTurnCount: "0",
          fullyExcludedCapabilityCount: "0",
        },
        nextCursor: null,
      });
    } else if (message.type === "READ_INSIGHTS_ACTIVITY") {
      if (message.bucket !== "day" || message.timeZone !== "UTC") process.exit(15);
      send({
        format: "threadshare-insights-protocol@v1", type: "INSIGHTS_ACTIVITY",
        requestId: message.requestId,
        databaseUuid: "11111111-2222-4333-8444-555555555555",
        snapshotSeq: "7", closureEvaluatedAt: "2026-08-11T00:00:00.000Z",
        quiescenceSeconds: 300,
        buckets: [{
          bucketStart: "2026-08-10T00:00:00.000Z",
          bucketEnd: "2026-08-11T00:00:00.000Z",
          distinctSessionCount: "0", distinctTurnCount: "0",
          currentClosureCounts: { hardSealed: "0", quiescent: "0", open: "0" },
          turnResultEvidenceCounts: { providerCompleted: "0", abandoned: "0", unknown: "0" },
          recordedToolInvocationCount: "0", recordedSkillInvocationCount: "0",
          support: {
            distinctDedupeGroupCount: "0", strongDedupeGroupCount: "0",
            weakDedupeGroupCount: "0", observedEofProvisionalGroupCount: "0",
            unknownDedupeSessionCount: "0",
          },
        }],
        coverage: {
          excludedUndatedInvocationCount: "0", excludedUndatedTurnCount: "0",
          excludedUnrevisionedInvocationCount: "0", excludedUnrevisionedTurnCount: "0",
        },
      });
    } else if (message.type === "READ_TURN_EVIDENCE") {
      if (message.turnKey !== turnKey || message.expectedRevision !== revision) process.exit(13);
      send({
        format: "threadshare-insights-protocol@v1", type: "TURN_EVIDENCE_PAGE",
        requestId: message.requestId, snapshotSeq: "7",
        turn: {
          turnKey, revision, problemText: "question", finalAnswerExcerpt: "answer",
          observedTimestamp: null, nextUserBoundary: false, providerTerminal: "completed",
          observedEofClosed: true, providerVisibility: "active", factTruncation: [],
        },
        entries: [{
          factKind: "event",
          fact: {
            eventKey: "5".repeat(64), occurredTurnKey: turnKey,
            linkedTurns: [{ turnKey, role: "lifecycle" }], pointerKind: "/content/0",
            pointerContentIndex: 0, pointerEventOrdinal: 0, originScope: "main",
            observedTimestamp: null,
            payload: { kind: "turn-lifecycle", lifecycleState: "completed", providerTurnDigest: null },
          },
        }],
        nextCursor: null,
      });
    }
  }
});
`;
  await writeFile(binaryPath, binary, { mode: 0o700 });
  return binaryPath;
}

async function createHangingReadEngine(directory) {
  const binaryPath = path.join(directory, "hanging-read-engine");
  const binary = `#!/usr/bin/env node
function canonical(value) {
  if (value === null || typeof value !== "object") return JSON.stringify(value);
  if (Array.isArray(value)) return "[" + value.map(canonical).join(",") + "]";
  return "{" + Object.keys(value).sort().map((key) => JSON.stringify(key) + ":" + canonical(value[key])).join(",") + "}";
}
function send(message) {
  const payload = Buffer.from(canonical(message));
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  process.stdout.write(Buffer.concat([prefix, payload]));
}
let input = Buffer.alloc(0);
process.stdin.on("data", (chunk) => {
  input = Buffer.concat([input, chunk]);
  while (input.length >= 4) {
    const length = input.readUInt32BE(0);
    if (input.length < length + 4) return;
    const message = JSON.parse(input.subarray(4, length + 4).toString("utf8"));
    input = input.subarray(length + 4);
    if (message.type === "HELLO") {
      send({
        format: "threadshare-insights-protocol@v1", type: "READY", requestId: message.requestId,
        engineVersion: "test", target: "development", maxFrameBytes: 4194304,
        sqliteVersion: "3.53.2", sqliteCompileOptionsDigest: "c".repeat(64),
        buildManifestDigest: "d".repeat(64), acceptedContract: message.requiredContract,
      });
    }
  }
});
`;
  await writeFile(binaryPath, binary, { mode: 0o700 });
  return binaryPath;
}

test("canonical-domain frame errors terminate the sidecar without panic output", {
  timeout: 10_000,
}, async (t) => {
  const child = spawn(ENGINE_PATH, [], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const stdout = [];
  const stderr = [];
  child.stdout.on("data", (chunk) => stdout.push(chunk));
  child.stderr.on("data", (chunk) => stderr.push(chunk));

  const payload = Buffer.from('{"future":9007199254740992,"type":"HELLO"}');
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32BE(payload.length);
  const closed = once(child, "close");
  child.stdin.end(Buffer.concat([prefix, payload]));

  assert.equal((await closed)[0], 1);
  assert.equal(Buffer.concat(stdout).length, 0);
  assert.equal(Buffer.concat(stderr).length, 0);
});

test("real Rust sidecar commits a delta and replays it idempotently after restart", {
  timeout: 30_000,
}, async (t) => {
  await access(ENGINE_PATH);
  const databasePath = await temporaryDatabase(t);
  // This UPSERT frame exceeds Node's pipe high-water mark and exercises drain handling.
  const delta = sampleDelta({ largePayload: true });

  const firstClient = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => firstClient.close());
  assert.deepEqual(await firstClient.applySessionFacts(delta), {
    snapshotSeq: "1",
    sessionKey: SESSION_KEY,
    idempotent: false,
  });
  await firstClient.close();

  const replayClient = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => replayClient.close());
  assert.deepEqual(await replayClient.applySessionFacts(delta), {
    snapshotSeq: "1",
    sessionKey: SESSION_KEY,
    idempotent: true,
  });
});

test("real Rust sidecar reports bounded content-free engine status", {
  timeout: 30_000,
}, async (t) => {
  await access(ENGINE_PATH);
  const databasePath = await temporaryDatabase(t);
  const client = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => client.close());

  const pending = await client.readEngineStatus();
  assert.equal(pending.snapshotSeq, "0");
  assert.equal(pending.snapshotAgeMs, null);
  assert.equal(pending.snapshotPending, true);
  assert.equal(pending.factStorageProfile, "normalized-row-v1");
  assert.deepEqual(pending.projections, [{
    name: "turn-search",
    version: 2,
    inputFactSchemaVersion: 1,
    rootKind: "turn",
    baseSnapshotSeq: "0",
    watermark: "0",
    status: "active",
    errorDigest: null,
  }]);
  assert.deepEqual(pending.changeLog, {
    rows: "0",
    payloadBytes: "0",
    maxRows: "1000000",
    maxPayloadBytes: "67108864",
    state: "within-cap",
  });
  assert.deepEqual(pending.integrity, { quickCheck: "ok", fts: "ok" });
  assert.ok(Object.isFrozen(pending));
  assert.ok(Object.isFrozen(pending.storage));

  const delta = sampleDelta();
  await client.applySessionFacts(delta);
  const ready = await client.readEngineStatus();
  assert.equal(ready.snapshotSeq, "1");
  assert.equal(ready.snapshotPending, false);
  assert.match(ready.snapshotAgeMs, /^(?:0|[1-9][0-9]*)$/u);
  assert.equal(JSON.stringify(ready).includes(delta.session.sessionKey), false);
  assert.equal(JSON.stringify(ready).includes("pendingState"), false);
});

test("real Rust sidecar searches committed Turns and pages their bounded evidence", {
  timeout: 30_000,
}, async (t) => {
  await access(ENGINE_PATH);
  const databasePath = await temporaryDatabase(t);
  const client = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => client.close());
  const delta = await queryFixtureDelta();
  await client.applySessionFacts(delta);

  const overview = await client.readInsightsOverview({
    nowUnixMs: "1786323723000",
    quiescenceSeconds: 300,
  });
  assert.equal(overview.snapshotSeq, "1");
  assert.equal(overview.sessions.eligible, "1");
  assert.equal(overview.turns.indexed, "1");
  assert.equal(Object.isFrozen(overview.sessions), true);
  const capabilities = await client.listCapabilities({ kind: "tool", cursor: null, limit: 20 });
  assert.equal(capabilities.snapshotSeq, "1");
  assert.equal(capabilities.items.length, 1);
  assert.equal(capabilities.items[0].kind, "tool");
  assert.equal(capabilities.items[0].canonicalName, "Read");
  assert.equal(JSON.stringify(capabilities).includes("problemText"), false);
  assert.equal(Object.isFrozen(capabilities.items[0].terminal), true);

  const search = await client.searchTurns({
    query: "normalized fact store",
    filters: {
      providers: ["codex"],
      projectKeys: [],
      observedAtOrAfterUnixMs: null,
      observedBeforeUnixMs: null,
      toolCapabilityKeys: [],
      skillCapabilityKeys: [],
      resultEvidence: [],
      closureStates: [],
    },
    limit: 20,
    pathLimit: 10,
    nowUnixMs: "1786323723000",
  });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].turnKey, delta.turns[0].turnKey);
  assert.equal(search.results[0].closureState, "hard-sealed");
  assert.deepEqual(search.searchTrace.candidateTurnKeys, [delta.turns[0].turnKey]);
  assert.equal(search.scoringTerms.some((term) => term.logicalTerm === "normalized"), true);
  assert.equal(search.results[0].score.matchedTermIndexes.length > 0, true);
  assert.deepEqual({
    rawMatchCount: search.evidencePaths.rawMatchCount,
    eligibleTurnCount: search.evidencePaths.eligibleTurnCount,
    rawSessionCount: search.evidencePaths.rawSessionCount,
    independentGroupCount: search.evidencePaths.independentGroupCount,
    strongGroupCount: search.evidencePaths.strongGroupCount,
    weakGroupCount: search.evidencePaths.weakGroupCount,
    observedEofProvisionalGroupCount:
      search.evidencePaths.observedEofProvisionalGroupCount,
    unknownDedupeCount: search.evidencePaths.unknownDedupeCount,
    unknownDedupeSessionCount: search.evidencePaths.unknownDedupeSessionCount,
  }, {
    rawMatchCount: 1,
    eligibleTurnCount: 1,
    rawSessionCount: 1,
    independentGroupCount: 0,
    strongGroupCount: 0,
    weakGroupCount: 0,
    observedEofProvisionalGroupCount: 0,
    unknownDedupeCount: 1,
    unknownDedupeSessionCount: 1,
  });

  const evidence = await client.readTurnEvidence({
    turnKey: search.results[0].turnKey,
    expectedRevision: search.results[0].revision,
    limit: 1,
  });
  assert.equal(evidence.turn.problemText, delta.turns[0].problemText);
  assert.equal(evidence.entries.length, 1);
  assert.equal(evidence.nextCursor === null || typeof evidence.nextCursor === "string", true);
  assert.equal(JSON.stringify(evidence).includes("recordStartOffset"), false);
  assert.equal(Object.isFrozen(evidence.turn), true);
});

test("real Rust sidecar keeps open Turns searchable but out of Tool path evidence", {
  timeout: 30_000,
}, async (t) => {
  await access(ENGINE_PATH);
  const databasePath = await temporaryDatabase(t);
  const client = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => client.close());
  const delta = await queryFixtureDelta({ withLifecycle: false });
  await client.applySessionFacts(delta);

  const search = await client.searchTurns({
    query: "normalized fact store",
    filters: {
      providers: ["codex"],
      projectKeys: [],
      observedAtOrAfterUnixMs: null,
      observedBeforeUnixMs: null,
      toolCapabilityKeys: [],
      skillCapabilityKeys: [],
      resultEvidence: [],
      closureStates: [],
    },
    limit: 20,
    pathLimit: 10,
    nowUnixMs: "1786323723000",
  });
  assert.equal(search.results.length, 1);
  assert.equal(search.results[0].closureState, "open");
  assert.equal(search.evidencePaths.rawMatchCount, 1);
  assert.equal(search.evidencePaths.eligibleTurnCount, 0);
  assert.deepEqual(search.evidencePaths.families, []);
});

test("source state commits atomically and reads summaries separately from parser checkpoints", {
  timeout: 30_000,
}, async (t) => {
  await access(ENGINE_PATH);
  const databasePath = await temporaryDatabase(t);
  const delta = sampleDelta();
  const decomposedFile = "/tmp/threadshare/cafe\u0301/codex-session.jsonl";
  assert.notEqual(decomposedFile.normalize("NFC"), decomposedFile);
  const sourceState = sourceStateForDelta(delta, { file: decomposedFile });
  const client = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => client.close());

  assert.deepEqual(await client.commitSourceDelta({ delta, sourceState }), {
    snapshotSeq: "1",
    sessionKey: SESSION_KEY,
    idempotent: false,
  });
  assert.deepEqual(await client.commitSourceDelta({ delta, sourceState }), {
    snapshotSeq: "1",
    sessionKey: SESSION_KEY,
    idempotent: true,
  });

  const states = await client.readSourceStates();
  assert.equal(states.length, 1);
  assert.deepEqual(states[0], {
    ...structuredClone(sourceState),
    checkpoint: {
      completeOffset: delta.checkpoint.completeOffset,
      sourceSnapshotStable: true,
      generation: delta.checkpoint.generation,
    },
  });
  assert.equal(JSON.stringify(states).includes("pendingState"), false);
  assert.deepEqual(await client.readSourceCheckpoint(SESSION_KEY), delta.checkpoint);
  assert.equal(await client.readSourceCheckpoint("f".repeat(64)), null);

  const conflicting = structuredClone(sourceState);
  conflicting.file = "/tmp/threadshare/different-session.jsonl";
  await assert.rejects(
    client.commitSourceDelta({ delta, sourceState: conflicting }),
    { code: "TS_INSIGHTS_SOURCE_STATE_CONFLICT", category: "conflict" },
  );
  assert.equal((await client.readSourceStates())[0].file, sourceState.file);
});

test("missing removal and exclusion purge are explicit atomic lifecycle states", {
  timeout: 30_000,
}, async (t) => {
  const databasePath = await temporaryDatabase(t);
  const delta = sampleDelta();
  const sourceState = sourceStateForDelta(delta);
  const client = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => client.close());
  await client.commitSourceDelta({ delta, sourceState });

  assert.deepEqual(await client.removeSource({
    source: { file: "/must/not/enter/the/protocol" },
    previous: { sessionKey: SESSION_KEY },
    reason: "missing",
  }), { sessionKey: SESSION_KEY, removed: true });
  assert.deepEqual(await client.readSourceStates(), []);
  assert.equal(await client.readSourceCheckpoint(SESSION_KEY), null);
  assert.deepEqual(await client.readPurgeStatus(SESSION_KEY), {
    state: "idle",
    pendingFacts: "0",
    pendingMaintenance: "0",
    purged: "0",
  });
  assert.equal((await client.removeSource({ previous: { sessionKey: SESSION_KEY } })).removed, false);

  await client.commitSourceDelta({ delta, sourceState });
  assert.deepEqual(await client.excludeSource({
    source: { file: "/must/not/enter/the/protocol" },
    previous: { sessionKey: SESSION_KEY },
    reason: "project-excluded",
  }), {
    sessionKey: SESSION_KEY,
    excluded: true,
    purgeState: "pending-purge",
  });
  assert.equal((await client.readSourceStates()).length, 1);
  assert.equal((await client.readPurgeStatus(SESSION_KEY)).state, "pending-purge");

  await client.close();
  const recoveryClient = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => recoveryClient.close());
  assert.equal((await recoveryClient.readPurgeStatus(SESSION_KEY)).state, "pending-purge");

  assert.deepEqual(await recoveryClient.runPurgeMaintenance({ limit: 1 }), {
    processedSessions: "1",
    purgedSessions: "1",
    state: "purged",
    pendingFacts: "0",
    pendingMaintenance: "0",
    purged: "1",
  });
  assert.deepEqual(await recoveryClient.readSourceStates(), []);
  assert.equal((await recoveryClient.readPurgeStatus(SESSION_KEY)).state, "purged");
  assert.deepEqual(await recoveryClient.excludeSource({ previous: { sessionKey: SESSION_KEY } }), {
    sessionKey: SESSION_KEY,
    excluded: false,
    purgeState: "purged",
  });
});

test("a rejected Fact delta cannot publish its staged source state", {
  timeout: 30_000,
}, async (t) => {
  const databasePath = await temporaryDatabase(t);
  const client = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => client.close());
  const delta = { ...sampleDelta(), deltaId: "f".repeat(64) };
  const sourceState = sourceStateForDelta(delta);
  await assert.rejects(
    client.commitSourceDelta({ delta, sourceState }),
    { code: "TS_INSIGHTS_INVALID_DELTA_ID" },
  );
  assert.deepEqual(await client.readSourceStates(), []);
  assert.equal(await client.readSourceCheckpoint(SESSION_KEY), null);
});

test("remote ERROR is mapped and a rejected commit leaves the database reusable", {
  timeout: 30_000,
}, async (t) => {
  const databasePath = await temporaryDatabase(t);
  const client = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => client.close());
  const valid = sampleDelta();
  const invalid = { ...valid, deltaId: "f".repeat(64) };

  await assert.rejects(
    client.applySessionFacts(invalid),
    (error) => {
      assert.equal(error.name, "InsightsEngineClientError");
      assert.equal(error.code, "TS_INSIGHTS_INVALID_DELTA_ID");
      assert.equal(error.category, "validation");
      assert.equal(error.retryable, false);
      assert.equal(error.fatal, false);
      return true;
    },
  );
  assert.deepEqual(await client.applySessionFacts(valid), {
    snapshotSeq: "1",
    sessionKey: SESSION_KEY,
    idempotent: false,
  });
});

test("a local serialization failure sends ABORT and keeps the sidecar reusable", {
  timeout: 30_000,
}, async (t) => {
  const databasePath = await temporaryDatabase(t);
  const client = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => client.close());
  const invalid = structuredClone(sampleDelta());
  invalid.retractions.turnKeys = ["a".repeat(64)];
  invalid.turns = [{ unsupported: 1n }];

  await assert.rejects(
    client.applySessionFacts(invalid),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME" && error.fatal === false,
  );
  assert.deepEqual(await client.applySessionFacts(sampleDelta()), {
    snapshotSeq: "1",
    sessionKey: SESSION_KEY,
    idempotent: false,
  });
});

test("an aborted operation does not poison a ready sidecar", {
  timeout: 30_000,
}, async (t) => {
  const databasePath = await temporaryDatabase(t);
  const client = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => client.close());
  const controller = new AbortController();
  controller.abort();

  await assert.rejects(
    client.applySessionFacts(sampleDelta(), { signal: controller.signal }),
    { code: "TS_INSIGHTS_ENGINE_ABORTED", retryable: true },
  );
  assert.deepEqual(await client.applySessionFacts(sampleDelta()), {
    snapshotSeq: "1",
    sessionKey: SESSION_KEY,
    idempotent: false,
  });
});

test("search, aggregate, and evidence requests use the strict query protocol", {
  timeout: 30_000,
  skip: process.platform === "win32" ? "temporary shebang fixture is POSIX-only" : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-query-client-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binaryPath = await createQueryProtocolEngine(directory);
  const client = await createInsightsEngineClient({
    runtimeOptions: {
      env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: binaryPath },
    },
    requiredContract: handshakeContract(),
    timeoutMs: 5_000,
  });
  t.after(() => client.close());

  const search = await client.searchTurns({
    query: "needle",
    filters: {
      providers: ["codex"],
      projectKeys: [],
      observedAtOrAfterUnixMs: null,
      observedBeforeUnixMs: null,
      toolCapabilityKeys: [],
      skillCapabilityKeys: [],
      resultEvidence: [],
      closureStates: [],
    },
    nowUnixMs: "1786323723000",
  });
  assert.equal(search.snapshot.snapshotSeq, "7");
  assert.equal(search.diagnostic.zeroDfTermCount, 1);
  assert.deepEqual(search.searchTrace, { candidateCount: 0, candidateTurnKeys: [] });
  assert.equal(Object.isFrozen(search), true);

  const usage = await client.readCapabilityUsage({
    kind: "tool",
    window: {
      observedAtOrAfterUnixMs: "1786320000000",
      observedBeforeUnixMs: "1786406400000",
    },
    comparisonWindow: null,
    filters: {
      providers: ["codex"], projectKeys: [], closureStates: [], capabilityTerminalStates: [],
    },
    orderBy: "recorded-invocation-count",
    cursor: null,
    limit: 5,
    nowUnixMs: "1786406400000",
    quiescenceSeconds: 300,
  });
  assert.equal(usage.totalCandidateCount, "0");
  assert.equal(usage.orderBy, "recorded-invocation-count");
  assert.equal(Object.isFrozen(usage.coverage), true);

  const activity = await client.readInsightsActivity({
    window: {
      observedAtOrAfter: "2026-08-10T00:00:00.000Z",
      observedBefore: "2026-08-11T00:00:00.000Z",
    },
    filters: { providers: ["codex"], projectKeys: [], closureStates: [] },
    bucket: "day",
    timeZone: "UTC",
    nowUnixMs: "1786406400000",
    quiescenceSeconds: 300,
  });
  assert.equal(activity.buckets[0].bucketStart, "2026-08-10T00:00:00.000Z");
  assert.equal(Object.isFrozen(activity.buckets[0]), true);

  const page = await client.readTurnEvidence({
    turnKey: "e".repeat(64),
    expectedRevision: "f".repeat(64),
  });
  assert.equal(page.turn.problemText, "question");
  assert.equal(page.entries[0].fact.linkedTurns[0].role, "lifecycle");
  assert.equal(Object.isFrozen(page), true);
});

test("an aborted read closes the sidecar before another response can reuse it", {
  timeout: 10_000,
  skip: process.platform === "win32" ? "temporary shebang fixture is POSIX-only" : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-read-abort-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binaryPath = await createHangingReadEngine(directory);
  const client = await createInsightsEngineClient({
    runtimeOptions: {
      env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: binaryPath },
    },
    requiredContract: handshakeContract(),
    timeoutMs: 5_000,
  });
  t.after(() => client.close());
  const controller = new AbortController();
  const pending = client.searchTurns({
    query: "needle",
    filters: {
      providers: ["codex"], projectKeys: [],
      observedAtOrAfterUnixMs: null, observedBeforeUnixMs: null,
      toolCapabilityKeys: [], skillCapabilityKeys: [],
      resultEvidence: [], closureStates: [],
    },
    nowUnixMs: "1786323723000",
  }, { signal: controller.signal });
  controller.abort();

  await assert.rejects(pending, { code: "TS_INSIGHTS_ENGINE_ABORTED", fatal: true });
  await assert.rejects(
    client.readInsightsOverview({ nowUnixMs: "1786323723000" }),
    { code: "TS_INSIGHTS_ENGINE_DISCONNECTED", fatal: true },
  );
});

test("disconnecting after SESSION_ACCEPTED does not commit the main database", {
  timeout: 30_000,
}, async (t) => {
  const databasePath = await temporaryDatabase(t);
  const child = spawn(ENGINE_PATH, ["--db", databasePath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  t.after(() => {
    if (child.exitCode === null && child.signalCode === null) child.kill();
  });
  const frames = decodeProtocolFrames(child.stdout)[Symbol.asyncIterator]();
  const hello = createHelloMessage({
    requestId: "1",
    clientVersion: "threadshare-test@1",
    requiredContract: handshakeContract(),
  });
  await writeFrame(child.stdin, hello);
  const ready = (await frames.next()).value;
  assert.equal(assertHandshakeCompatible(hello, ready), true);

  const delta = sampleDelta();
  const begin = createBeginSessionMessage(delta, {
    requestId: "2",
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: handshakeContract().projectionVersions,
    analyzerCapabilities: handshakeContract().analyzerCapabilities,
    rankerVersion: 1,
  });
  await writeFrame(child.stdin, begin);
  assert.deepEqual((await frames.next()).value, {
    format: "threadshare-insights-protocol@v1",
    type: "SESSION_ACCEPTED",
    requestId: "2",
    sessionKey: SESSION_KEY,
    deltaId: delta.deltaId,
    nextSequence: "0",
  });
  const closed = once(child, "close");
  child.stdin.end();
  assert.equal((await closed)[0], 0);

  const client = await createInsightsEngineClient(clientOptions(databasePath));
  t.after(() => client.close());
  assert.deepEqual(await client.applySessionFacts(delta), {
    snapshotSeq: "1",
    sessionKey: SESSION_KEY,
    idempotent: false,
  });
});

test("startup disconnect and timeout use stable errors and bounded stderr", {
  timeout: 30_000,
  skip: process.platform === "win32" ? "temporary shebang fixtures are POSIX-only" : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-fake-engine-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const disconnectPath = path.join(directory, "disconnect-engine");
  const timeoutPath = path.join(directory, "timeout-engine");
  await writeFile(
    disconnectPath,
    "#!/usr/bin/env node\nprocess.stderr.write('x'.repeat(4096)); process.stdin.once('data', () => process.exit(7));\n",
    { mode: 0o700 },
  );
  await writeFile(
    timeoutPath,
    "#!/usr/bin/env node\nprocess.stdin.resume(); setInterval(() => {}, 1000);\n",
    { mode: 0o700 },
  );

  await assert.rejects(
    createInsightsEngineClient({
      ...clientOptions(undefined),
      runtimeOptions: {
        env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: disconnectPath },
      },
      stderrLimitBytes: 64,
    }),
    (error) => {
      assert.equal(error.code, "TS_INSIGHTS_ENGINE_DISCONNECTED");
      assert.equal(Buffer.byteLength(error.stderr, "utf8"), 64);
      return true;
    },
  );

  await assert.rejects(
    createInsightsEngineClient({
      ...clientOptions(undefined),
      runtimeOptions: {
        env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: timeoutPath },
      },
      timeoutMs: 30,
    }),
    { code: "TS_INSIGHTS_ENGINE_TIMEOUT" },
  );
});

test("a session-time disconnect marks the client fatal and close remains joinable", {
  timeout: 30_000,
  skip: process.platform === "win32" ? "temporary shebang fixture is POSIX-only" : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-session-drop-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binaryPath = await createSessionDisconnectEngine(directory);
  const client = await createInsightsEngineClient({
    runtimeOptions: {
      env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: binaryPath },
    },
    requiredContract: handshakeContract(),
    timeoutMs: 5_000,
  });

  await assert.rejects(
    client.applySessionFacts(sampleDelta()),
    { code: "TS_INSIGHTS_ENGINE_DISCONNECTED", fatal: true },
  );
  await assert.rejects(
    client.applySessionFacts(sampleDelta()),
    { code: "TS_INSIGHTS_ENGINE_DISCONNECTED", fatal: true },
  );
  const firstClose = client.close();
  const secondClose = client.close();
  assert.equal(firstClose, secondClose);
  await firstClose;
});

test("session commit uses its bounded transaction timeout", {
  timeout: 10_000,
  skip: process.platform === "win32" ? "temporary shebang fixture is POSIX-only" : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-commit-timeout-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binaryPath = await createDelayedCommitEngine(directory, 2_000);
  const client = await createInsightsEngineClient({
    runtimeOptions: {
      env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: binaryPath },
    },
    requiredContract: handshakeContract(),
    timeoutMs: 1_500,
    commitTimeoutMs: 5_000,
  });
  t.after(() => client.close());

  assert.deepEqual(await client.applySessionFacts(sampleDelta()), {
    snapshotSeq: "1",
    sessionKey: SESSION_KEY,
    idempotent: false,
  });
});

test("session commit timeout remains fail-closed", {
  timeout: 10_000,
  skip: process.platform === "win32" ? "temporary shebang fixture is POSIX-only" : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-commit-timeout-bound-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const binaryPath = await createDelayedCommitEngine(directory, 250);
  const client = await createInsightsEngineClient({
    runtimeOptions: {
      env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: binaryPath },
    },
    requiredContract: handshakeContract(),
    timeoutMs: 1_500,
    commitTimeoutMs: 50,
  });
  t.after(() => client.close());

  await assert.rejects(
    client.applySessionFacts(sampleDelta()),
    { code: "TS_INSIGHTS_ENGINE_TIMEOUT" },
  );
});

test("packaged runtime requires exact READY target, version, manifest, and SQLite identity", {
  timeout: 30_000,
  skip: process.platform === "win32" ? "temporary shebang fixture is POSIX-only" : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-package-ready-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const { runtimeOptions } = await createFakePlatformPackage(directory);
  const base = {
    runtimeOptions,
    requiredContract: handshakeContract(),
    timeoutMs: 5_000,
  };

  const client = await createInsightsEngineClient(base);
  await client.close();

  for (const axis of ["target", "version", "manifest", "sqlite"]) {
    await assert.rejects(
      createInsightsEngineClient({
        ...base,
        childEnv: { ...process.env, THREADSHARE_FAKE_IDENTITY_MISMATCH: axis },
      }),
      (error) => {
        assert.equal(error.code, "TS_INSIGHTS_ENGINE_INVALID", axis);
        assert.equal(error.category, "compatibility", axis);
        assert.equal(error.fatal, true, axis);
        return true;
      },
    );
  }
});
