#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { access, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { cpus, platform as osPlatform, release as osRelease, totalmem } from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  assertHandshakeCompatible,
  createHelloMessage,
  createSessionDeltaMessages,
  decodeProtocolFrames,
  encodeProtocolFrame,
} from "../src/insights-engine-protocol.mjs";
import {
  assertSessionFactsDelta,
  canonicalJson,
  hashKey,
} from "../src/session-facts.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const ENGINE_NAME = process.platform === "win32"
  ? "threadshare-insights-engine.exe"
  : "threadshare-insights-engine";
const DEFAULT_ENGINE_PATH = path.join(
  REPOSITORY_ROOT,
  "crates",
  "insights-engine",
  "target",
  "release",
  ENGINE_NAME,
);
const DEFAULT_SEED = "threadshare-insights-benchmark-v1";
const ORIGIN_SECRET_EPOCH = "33333333-3333-4333-8333-333333333333";
const PROTOCOL_FORMAT = "threadshare-insights-protocol@v1";
const BENCHMARK_FORMAT = "threadshare-insights-engine-benchmark@v1";
const BASE_TIME_MS = Date.UTC(2026, 0, 1, 0, 0, 0);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function positiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/u.test(String(value))) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} is too large`);
  return number;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function checkpoint(sessionKey, generation, completeOffset) {
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
        sessionKey,
        sessionScope: "main",
        eligibility: "eligible",
        originatorVersion: "benchmark@1",
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
  assertSessionFactsDelta(delta);
  return {
    delta,
    canonical: canonicalJson(delta),
  };
}

export function createBenchmarkCorpus({
  turnCount = 25_000,
  turnsPerSession = 100,
  seed = DEFAULT_SEED,
} = {}) {
  positiveInteger(turnCount, "turnCount");
  positiveInteger(turnsPerSession, "turnsPerSession");
  if (typeof seed !== "string" || seed.length === 0) {
    throw new TypeError("seed must be a non-empty string");
  }

  const sessions = [];
  const digest = createHash("sha256");
  let canonicalBytes = 0;
  let nextTurn = 0;
  for (let sessionIndex = 0; nextTurn < turnCount; sessionIndex += 1) {
    const sessionKey = hashKey("session", "benchmark", seed, String(sessionIndex));
    const remaining = turnCount - nextTurn;
    const sessionTurnCount = Math.min(turnsPerSession, remaining);
    const turns = [];
    const observedStart = new Date(BASE_TIME_MS + nextTurn * 1_000).toISOString();
    for (let localIndex = 0; localIndex < sessionTurnCount; localIndex += 1) {
      const globalIndex = nextTurn + localIndex;
      const offset = String(globalIndex * 1_024);
      const topic = globalIndex % 97;
      const language = ["zh", "en", "mixed", "code"][globalIndex % 4];
      turns.push({
        turnKey: hashKey(
          "turn",
          Buffer.from(sessionKey, "hex"),
          offset,
          String(localIndex),
        ),
        ownerSessionKey: sessionKey,
        turnStartOffset: offset,
        problemText: `benchmark problem ${globalIndex} topic-${topic} ${language} identifier-${globalIndex.toString(36)}`,
        finalAnswerExcerpt: `benchmark answer ${globalIndex} route-${globalIndex % 31} evidence-${globalIndex % 17}`,
        observedTimestamp: new Date(BASE_TIME_MS + globalIndex * 1_000).toISOString(),
        rawClosure: {
          nextUserBoundary: localIndex + 1 < sessionTurnCount,
          providerTerminal: localIndex + 1 === sessionTurnCount ? "completed" : null,
          observedEofClosed: false,
        },
        providerVisibility: "active",
        factTruncation: [],
      });
    }
    const lastTurnIndex = nextTurn + sessionTurnCount - 1;
    const completeOffset = String((lastTurnIndex + 1) * 1_024);
    const finalized = finalizeDelta({
      format: "session-facts-delta@v1",
      factSchemaVersion: 1,
      providerAdapterVersion: sessionIndex % 2 === 0 ? "codex@1" : "claude@1",
      privacyPolicyVersion: 1,
      originSecretEpoch: ORIGIN_SECRET_EPOCH,
      duplicatePolicyVersion: 1,
      expectedGeneration: "0",
      targetGeneration: "1",
      mode: "append",
      deltaId: "0".repeat(64),
      session: {
        sessionKey,
        provider: sessionIndex % 2 === 0 ? "codex" : "claude",
        sessionScope: "main",
        eligibility: "eligible",
        projectKey: hashKey("project", "benchmark", String(sessionIndex % 13)),
        observedStart,
        observedEnd: new Date(BASE_TIME_MS + lastTurnIndex * 1_000).toISOString(),
        originatorVersion: "benchmark@1",
        duplicateGroupKey: null,
        dedupeFingerprint: null,
        dedupeCorroborationFingerprint: null,
        duplicateMethod: null,
        duplicateConfidence: null,
        dedupeClosure: null,
        dedupeEvidenceEventKeys: [],
        duplicatePolicyVersion: 1,
        factTruncation: [],
      },
      retractions: {
        turnKeys: [],
        orphanEventKeys: [],
        authoritativeTurnKeys: [],
      },
      turns,
      sourceRecords: [],
      evidenceEvents: [],
      turnEvidence: [],
      capabilities: [],
      capabilityUses: [],
      capabilityUseEvidence: [],
      checkpoint: checkpoint(sessionKey, "1", completeOffset),
      diagnostics: [],
      coverage: {},
    });
    canonicalBytes += Buffer.byteLength(finalized.canonical, "utf8");
    digest.update(finalized.canonical);
    sessions.push(finalized);
    nextTurn += sessionTurnCount;
  }

  return Object.freeze({
    seed,
    turnCount,
    turnsPerSession,
    sessionCount: sessions.length,
    canonicalBytes,
    digest: digest.digest("hex"),
    sessions: Object.freeze(sessions),
  });
}

function requiredContract() {
  return {
    factSchemaVersion: 1,
    providerAdapterVersions: ["claude@1", "codex@1"],
    privacyPolicyVersion: 1,
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    duplicatePolicyVersion: 1,
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: [],
    analyzerCapabilities: [],
    rankerVersion: 1,
  };
}

async function writeEncodedFrame(stream, frame) {
  if (!stream.write(frame)) await once(stream, "drain");
}

async function nextResponse(iterator, expectedType, requestId) {
  const result = await iterator.next();
  if (result.done) throw new Error(`Insights Engine exited before ${expectedType}`);
  const message = result.value;
  if (message.type === "ERROR") {
    throw new Error(`${message.code ?? "TS_INSIGHTS_ENGINE_ERROR"}: ${message.message ?? "unknown error"}`);
  }
  if (message.format !== PROTOCOL_FORMAT || message.type !== expectedType ||
      message.requestId !== requestId) {
    throw new Error(`expected ${expectedType} for request ${requestId}, received ${message.type}`);
  }
  return message;
}

async function readProcessRssBytes(pid) {
  if (process.platform === "linux") {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+([0-9]+)\s+kB$/mu.exec(status);
      return match ? Number(match[1]) * 1_024 : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)], {
        encoding: "utf8",
      });
      const kibibytes = Number(stdout.trim());
      return Number.isFinite(kibibytes) ? kibibytes * 1_024 : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    try {
      const command = `(Get-Process -Id ${pid}).WorkingSet64`;
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8" },
      );
      const bytes = Number(stdout.trim());
      return Number.isFinite(bytes) ? bytes : null;
    } catch {
      return null;
    }
  }
  return null;
}

function startRssSampler(pid) {
  let sidecarPeakBytes = 0;
  let nodeHarnessPeakBytes = process.memoryUsage().rss;
  let combinedPeakBytes = nodeHarnessPeakBytes;
  let stopped = false;
  let pending = Promise.resolve();

  const sample = async () => {
    const nodeBytes = process.memoryUsage().rss;
    const sidecarBytes = await readProcessRssBytes(pid);
    nodeHarnessPeakBytes = Math.max(nodeHarnessPeakBytes, nodeBytes);
    if (sidecarBytes !== null) {
      sidecarPeakBytes = Math.max(sidecarPeakBytes, sidecarBytes);
      combinedPeakBytes = Math.max(combinedPeakBytes, nodeBytes + sidecarBytes);
    }
  };
  // Linux exposes RSS as a cheap procfs read. macOS and Windows require a new
  // subprocess per sample, which materially distorts this short benchmark, so
  // those platforms report start/end observations instead of claiming a peak.
  const periodic = process.platform === "linux";
  const timer = periodic
    ? setInterval(() => {
      if (stopped) return;
      pending = pending.then(sample, sample);
    }, 100)
    : null;
  timer?.unref();
  pending = sample();

  return async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    await pending;
    await sample();
    return {
      samplingMode: periodic ? "linux-procfs-100ms" : "process-start-end-observations",
      sidecarPeakBytes,
      nodeHarnessPeakBytes,
      combinedPeakBytes,
    };
  };
}

async function databaseFootprint(databasePath) {
  let bytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes += (await stat(`${databasePath}${suffix}`)).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return bytes;
}

function querySummary(database, sessionKeys, queryCount, warmupCount) {
  const point = database.prepare(
    "SELECT generation, hex(delta_id) AS deltaId, length(canonical_delta) AS canonicalBytes, snapshot_seq AS snapshotSeq FROM session_commits WHERE session_key=?",
  );
  const count = database.prepare("SELECT COUNT(*) AS value FROM session_commits");
  const pick = (index) => sessionKeys[(index * 7_919 + 17) % sessionKeys.length];
  for (let index = 0; index < warmupCount; index += 1) {
    point.get(Buffer.from(pick(index), "hex"));
  }
  const latencies = [];
  const digest = createHash("sha256");
  const start = performance.now();
  for (let index = 0; index < queryCount; index += 1) {
    const queryStart = performance.now();
    const row = point.get(Buffer.from(pick(index + warmupCount), "hex"));
    latencies.push(performance.now() - queryStart);
    if (row === undefined) throw new Error("point lookup missed a deterministic session key");
    digest.update(canonicalJson(row));
  }
  const wallMs = performance.now() - start;
  const committedSessions = Number(count.get().value);
  return {
    kind: "session-commit-point-lookup",
    implementation: "node:sqlite direct database read",
    queryCount,
    warmupCount,
    wallMs,
    p50Ms: percentile(latencies, 0.50),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    resultDigest: digest.digest("hex"),
    committedSessions,
  };
}

async function openNodeDatabase(databasePath) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    throw new Error("the node:sqlite reference benchmark requires Node 22.5 or newer");
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(databasePath);
}

function configureReferenceDatabase(database) {
  database.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA synchronous=NORMAL;
    PRAGMA temp_store=FILE;
    PRAGMA journal_mode=WAL;
    CREATE TABLE engine_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
    INSERT INTO engine_metadata(key, value) VALUES ('snapshot_seq', '0');
    CREATE TABLE session_commits (
      session_key BLOB PRIMARY KEY,
      generation TEXT NOT NULL,
      delta_id BLOB NOT NULL,
      canonical_delta TEXT NOT NULL,
      snapshot_seq INTEGER NOT NULL
    ) WITHOUT ROWID;
  `);
}

export async function benchmarkNodeSqliteReference({
  databasePath,
  turnCount,
  turnsPerSession,
  queryCount,
  warmupCount,
  seed = DEFAULT_SEED,
}) {
  const corpus = createBenchmarkCorpus({ turnCount, turnsPerSession, seed });
  const database = await openNodeDatabase(databasePath);
  configureReferenceDatabase(database);
  const version = database.prepare("SELECT sqlite_version() AS value").get().value;
  const compileOptions = database.prepare("PRAGMA compile_options").all().map((row) => row.compile_options);
  const updateMetadata = database.prepare(
    "UPDATE engine_metadata SET value=? WHERE key='snapshot_seq'",
  );
  const upsert = database.prepare(`
    INSERT INTO session_commits(session_key, generation, delta_id, canonical_delta, snapshot_seq)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_key) DO UPDATE SET
      generation=excluded.generation,
      delta_id=excluded.delta_id,
      canonical_delta=excluded.canonical_delta,
      snapshot_seq=excluded.snapshot_seq
  `);
  let peakRssBytes = process.memoryUsage().rss;
  const start = performance.now();
  for (let index = 0; index < corpus.sessions.length; index += 1) {
    const { delta, canonical } = corpus.sessions[index];
    const snapshotSeq = index + 1;
    database.exec("BEGIN IMMEDIATE");
    try {
      updateMetadata.run(String(snapshotSeq));
      upsert.run(
        Buffer.from(delta.session.sessionKey, "hex"),
        delta.targetGeneration,
        Buffer.from(delta.deltaId, "hex"),
        canonical,
        snapshotSeq,
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }
  const backfillMs = performance.now() - start;
  const query = querySummary(
    database,
    corpus.sessions.map((item) => item.delta.session.sessionKey),
    queryCount,
    warmupCount,
  );
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  database.close();

  return {
    engine: "node:sqlite-reference",
    sqliteVersion: version,
    fts5Enabled: compileOptions.includes("ENABLE_FTS5"),
    corpusDigest: corpus.digest,
    backfill: {
      wallMs: backfillMs,
      turnsPerSecond: corpus.turnCount / (backfillMs / 1_000),
      canonicalMiBPerSecond: (corpus.canonicalBytes / 1_048_576) / (backfillMs / 1_000),
    },
    rss: { peakBytes: peakRssBytes },
    databaseBytes: await databaseFootprint(databasePath),
    query,
  };
}

async function benchmarkRustSidecar({
  binaryPath,
  databasePath,
  corpus,
  queryCount,
  warmupCount,
}) {
  await access(binaryPath);
  const { stdout: versionStdout } = await execFileAsync(binaryPath, ["--version", "--json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const versionDocument = JSON.parse(versionStdout);
  const child = spawn(binaryPath, ["--db", databasePath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const responses = decodeProtocolFrames(child.stdout)[Symbol.asyncIterator]();
  const stopRssSampler = startRssSampler(child.pid);
  let requestWireBytes = 0;
  let responseWireBytes = 0;
  let requestFrameCount = 0;
  let responseFrameCount = 0;
  let preparationMs = 0;

  const processStart = performance.now();
  const hello = createHelloMessage({
    requestId: "1",
    clientVersion: "threadshare-benchmark@1",
    requiredContract: requiredContract(),
  });
  const helloFrame = encodeProtocolFrame(hello);
  await writeEncodedFrame(child.stdin, helloFrame);
  const ready = await nextResponse(responses, "READY", "1");
  assertHandshakeCompatible(hello, ready);
  const warmOpenMs = performance.now() - processStart;

  const backfillStart = performance.now();
  try {
    for (let index = 0; index < corpus.sessions.length; index += 1) {
      const { delta } = corpus.sessions[index];
      const requestId = String(index + 2);
      const messages = [];
      const prepareStart = performance.now();
      for await (const message of createSessionDeltaMessages(delta, {
        requestId,
        factStorageProfile: "normalized-row-v1",
        storageSchemaVersion: 1,
        projectionVersions: [],
        analyzerCapabilities: [],
        rankerVersion: 1,
      })) {
        messages.push({ message, frame: encodeProtocolFrame(message) });
      }
      preparationMs += performance.now() - prepareStart;

      for (const { message, frame } of messages) {
        requestWireBytes += frame.length;
        requestFrameCount += 1;
        await writeEncodedFrame(child.stdin, frame);
        const expectedType = message.type === "BEGIN_SESSION"
          ? "SESSION_ACCEPTED"
          : message.type === "COMMIT_SESSION"
            ? "SESSION_COMMITTED"
            : "BATCH_ACCEPTED";
        const response = await nextResponse(responses, expectedType, requestId);
        if (expectedType === "SESSION_COMMITTED" && response.idempotent !== false) {
          throw new Error("fresh benchmark corpus unexpectedly produced an idempotent commit");
        }
        responseWireBytes += encodeProtocolFrame(response).length;
        responseFrameCount += 1;
      }
    }
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}${stderr ? `; engine stderr: ${stderr}` : ""}`);
  }
  const backfillMs = performance.now() - backfillStart;
  const rss = await stopRssSampler();
  child.stdin.end();
  const [exitCode] = await once(child, "close");
  if (exitCode !== 0) throw new Error(`Insights Engine exited ${exitCode}: ${stderr}`);

  const database = await openNodeDatabase(databasePath);
  const query = querySummary(
    database,
    corpus.sessions.map((item) => item.delta.session.sessionKey),
    queryCount,
    warmupCount,
  );
  database.close();

  return {
    engine: "rust-sidecar",
    engineVersion: versionDocument.engineVersion,
    target: versionDocument.target,
    sqliteVersion: ready.sqliteVersion,
    warmOpenMs,
    backfill: {
      wallMs: backfillMs,
      protocolPreparationMs: preparationMs,
      transportValidationStorageMs: Math.max(0, backfillMs - preparationMs),
      turnsPerSecond: corpus.turnCount / (backfillMs / 1_000),
      canonicalMiBPerSecond: (corpus.canonicalBytes / 1_048_576) / (backfillMs / 1_000),
    },
    protocol: {
      requestFrames: requestFrameCount,
      responseFrames: responseFrameCount,
      requestBytes: requestWireBytes,
      responseBytes: responseWireBytes,
      totalWireBytes: requestWireBytes + responseWireBytes,
      canonicalCorpusBytes: corpus.canonicalBytes,
      wireAmplification: ratio(requestWireBytes + responseWireBytes, corpus.canonicalBytes),
    },
    rss,
    databaseBytes: await databaseFootprint(databasePath),
    query: {
      ...query,
      implementation: "node:sqlite direct read of the Rust-created database",
      rustProtocolQueryAvailable: false,
    },
  };
}

function sanitizedEnvironment() {
  const processors = cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    os: `${osPlatform()} ${osRelease()}`,
    cpuModel: processors[0]?.model ?? "unknown",
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    nodeVersion: process.version,
    v8Version: process.versions.v8,
  };
}

async function sourceRevision() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function sourceWorktreeDirty() {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.length > 0;
  } catch {
    return null;
  }
}

async function runNodeReferenceWorker(options) {
  const args = [
    SCRIPT_PATH,
    "--node-reference-worker",
    "--db", options.databasePath,
    "--turns", String(options.turnCount),
    "--turns-per-session", String(options.turnsPerSession),
    "--queries", String(options.queryCount),
    "--warmup", String(options.warmupCount),
    "--seed", options.seed,
  ];
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function runInsightsEngineBenchmark({
  turnCount = 25_000,
  turnsPerSession = 100,
  queryCount = 1_000,
  warmupCount = 100,
  seed = DEFAULT_SEED,
  binaryPath = process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE_PATH,
  workingDirectory,
} = {}) {
  positiveInteger(turnCount, "turnCount");
  positiveInteger(turnsPerSession, "turnsPerSession");
  positiveInteger(queryCount, "queryCount");
  positiveInteger(warmupCount, "warmupCount");
  const ownsDirectory = workingDirectory === undefined;
  const directory = workingDirectory ?? await mkdtemp(
    path.join(tmpdir(), "threadshare-insights-benchmark-"),
  );
  const rustDatabasePath = path.join(directory, "rust.sqlite3");
  const nodeDatabasePath = path.join(directory, "node.sqlite3");

  try {
    const corpusStart = performance.now();
    const corpus = createBenchmarkCorpus({ turnCount, turnsPerSession, seed });
    const corpusBuildMs = performance.now() - corpusStart;
    const rust = await benchmarkRustSidecar({
      binaryPath: path.resolve(binaryPath),
      databasePath: rustDatabasePath,
      corpus,
      queryCount,
      warmupCount,
    });
    const node = await runNodeReferenceWorker({
      databasePath: nodeDatabasePath,
      turnCount,
      turnsPerSession,
      queryCount,
      warmupCount,
      seed,
    });
    if (node.corpusDigest !== corpus.digest) {
      throw new Error("Rust and Node paths did not use the same deterministic corpus");
    }
    if (node.query.resultDigest !== rust.query.resultDigest) {
      throw new Error("Rust-created and Node-created databases returned different query results");
    }

    return {
      format: BENCHMARK_FORMAT,
      measuredScope: "item-3-session-commit-substrate",
      sourceRevision: await sourceRevision(),
      sourceWorktreeDirty: await sourceWorktreeDirty(),
      benchmarkScriptSha256: sha256(await readFile(SCRIPT_PATH)),
      environment: sanitizedEnvironment(),
      corpus: {
        seed,
        turns: corpus.turnCount,
        sessions: corpus.sessionCount,
        turnsPerSession,
        canonicalBytes: corpus.canonicalBytes,
        digest: corpus.digest,
        buildMs: corpusBuildMs,
      },
      rustSidecar: rust,
      nodeSqliteReference: node,
      comparison: {
        rustToNodeBackfillWallRatio: ratio(rust.backfill.wallMs, node.backfill.wallMs),
        rustToNodeDatabaseSizeRatio: ratio(rust.databaseBytes, node.databaseBytes),
        directReadP95Ratio: ratio(rust.query.p95Ms, node.query.p95Ms),
        queryResultsEqual: true,
        selectionBasis: [
          "Rust preserves the public Node >=20 contract while node:sqlite requires Node >=22.5.",
          "Rust pins the SQLite patch and compile options independently of the user's Node runtime.",
          "The sidecar provides process fault and memory isolation; this benchmark reports that cost explicitly.",
          "Performance is not a final backend decision until ITEM-4 adds normalized Fact and FTS workloads.",
        ],
      },
      deferredToItem4: [
        "raw-session parsing and Fact repository backfill",
        "detail-full FTS indexing and BM25/field-df query",
        "rollup, delete/replace, purge, projection rebuild, and crash-recovery costs",
        "the Epic's raw-byte throughput and final warm Top-20 latency gates",
      ],
    };
  } finally {
    if (ownsDirectory) await rm(directory, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {
    turnCount: 25_000,
    turnsPerSession: 100,
    queryCount: 1_000,
    warmupCount: 100,
    seed: DEFAULT_SEED,
    binaryPath: process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE_PATH,
    outputPath: null,
    json: false,
    nodeReferenceWorker: false,
    databasePath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--node-reference-worker") options.nodeReferenceWorker = true;
    else if (argument === "--turns") options.turnCount = positiveInteger(argv[++index], "--turns");
    else if (argument === "--turns-per-session") {
      options.turnsPerSession = positiveInteger(argv[++index], "--turns-per-session");
    } else if (argument === "--queries") options.queryCount = positiveInteger(argv[++index], "--queries");
    else if (argument === "--warmup") options.warmupCount = positiveInteger(argv[++index], "--warmup");
    else if (argument === "--seed") options.seed = argv[++index];
    else if (argument === "--engine") options.binaryPath = argv[++index];
    else if (argument === "--output") options.outputPath = argv[++index];
    else if (argument === "--db") options.databasePath = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.nodeReferenceWorker) {
    if (!options.databasePath) throw new Error("--db is required for the reference worker");
    const result = await benchmarkNodeSqliteReference({
      databasePath: options.databasePath,
      turnCount: options.turnCount,
      turnsPerSession: options.turnsPerSession,
      queryCount: options.queryCount,
      warmupCount: options.warmupCount,
      seed: options.seed,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const result = await runInsightsEngineBenchmark(options);
  const rendered = options.json ? JSON.stringify(result) : `${JSON.stringify(result, null, 2)}\n`;
  if (options.outputPath) await writeFile(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(options.json ? `${rendered}\n` : rendered);
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`benchmark-insights-engine: ${error.message}\n`);
    process.exitCode = 1;
  });
}
