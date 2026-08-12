#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertAggregateArtifactPrivacy } from "./package-insights-benchmark-evidence.mjs";

export const DEEP_QUERY_EVIDENCE_FORMAT =
  "threadshare-insights-deep-query-evidence-manifest@v1";
export const DEEP_QUERY_REPORTS = Object.freeze([
  "deep-query-25k.acceptance.json",
  "deep-query-real-sample-30pct.acceptance.json",
]);
export const DEEP_QUERY_DEFERRED_SYNTHETIC_TURNS = Object.freeze([250_000]);
export const DEEP_QUERY_STORAGE_AMPLIFICATION_LIMIT = 1.8;
export const DEEP_QUERY_FTS_AMPLIFICATION_LIMIT = 0.7;
export const DEEP_QUERY_RECIPE_P95_LIMIT_MS = 500;
export const DEEP_QUERY_RECIPE_P99_LIMIT_MS = 1_000;

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DESIGN_FILE = "docs/insights-deep-query-design.md";
const SYNTHETIC_FORMAT = "threadshare-insights-deep-query-benchmark@v1";
const REAL_SAMPLE_FORMAT = "threadshare-insights-real-sample-benchmark@v1";
const SYNTHETIC_SCOPE = "local-insights-fact-v2-deep-query-capacity-and-performance";
const REAL_SAMPLE_SCOPE = "fact-v2-real-session-capacity-and-commit-ack";
const DEEP_QUERY_COUNT = 100;
const DEEP_QUERY_WARMUP_COUNT = 20;
const RSS_LIMIT_BYTES = 128 * 1024 ** 2;
const SYNTHETIC_SCALES = Object.freeze({
  25_000: Object.freeze({
    file: DEEP_QUERY_REPORTS[0],
    seed: "threadshare-insights-deep-query-25k-v1",
    p95Ms: 100,
    p99Ms: 250,
  }),
});
const RECIPE_NAMES = Object.freeze([
  "activity-shifts@1",
  "capability-contexts@1",
  "failure-chains@1",
  "file-workflow-signals@1",
  "session-timeline@1",
  "solution-recall@1",
  "token-hotspots@1",
]);
const SCRIPT_FILES = Object.freeze([
  "scripts/benchmark-insights-engine.mjs",
  "scripts/benchmark-insights-real-sample.mjs",
  "scripts/package-insights-deep-query-evidence.mjs",
]);

function fail(message) {
  throw new TypeError(message);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function equal(left, right, message) {
  if (!isDeepStrictEqual(left, right)) fail(message);
}

function exactKeys(value, keys, name) {
  equal(Object.keys(object(value, name)).sort(), [...keys].sort(), `${name} field set drifted`);
}

function integer(value, name, minimum = 0) {
  if (!Number.isSafeInteger(value) || value < minimum) fail(`${name} must be >= ${minimum}`);
  return value;
}

function number(value, name, minimum = 0) {
  if (!Number.isFinite(value) || value < minimum) fail(`${name} must be >= ${minimum}`);
  return value;
}

function hex(value, name, lengths = [64]) {
  if (
    typeof value !== "string" ||
    !lengths.includes(value.length) ||
    !/^[0-9a-f]+$/u.test(value)
  ) {
    fail(`${name} must be a lowercase hexadecimal digest`);
  }
  return value;
}

function gate(value, name) {
  if (value !== true) fail(`${name} did not pass`);
}

function closeEnough(left, right) {
  return Math.abs(left - right) <= Math.max(1e-12, Math.abs(right) * 1e-12);
}

function databaseGroupBytes(value, name) {
  exactKeys(value, ["databaseBytes", "walBytes", "shmBytes"], name);
  return ["databaseBytes", "walBytes", "shmBytes"]
    .reduce((total, key) => total + integer(value[key], `${name}.${key}`), 0);
}

function validateLatency(value, name, count) {
  const latency = object(value, name);
  exactKeys(latency, ["unit", "count", "total", "p50", "p95", "p99", "max"], name);
  if (latency.unit !== "ms" || latency.count !== count) fail(`${name} identity drifted`);
  const total = number(latency.total, `${name}.total`);
  const p50 = number(latency.p50, `${name}.p50`);
  const p95 = number(latency.p95, `${name}.p95`);
  const p99 = number(latency.p99, `${name}.p99`);
  const max = number(latency.max, `${name}.max`);
  if (!(p50 <= p95 && p95 <= p99 && p99 <= max && total >= max)) {
    fail(`${name} percentile order is invalid`);
  }
  return latency;
}

function validateEngineIdentity(value, name) {
  const identity = object(value, name);
  exactKeys(identity, [
    "buildManifestDigest", "engineVersion", "format", "protocolVersion",
    "sqliteCompileOptionsDigest", "sqliteVersion", "target", "binarySha256",
  ], name);
  if (identity.format !== "threadshare-insights-engine-version@v1" ||
      identity.protocolVersion !== 1) fail(`${name} is invalid`);
  for (const key of ["buildManifestDigest", "sqliteCompileOptionsDigest", "binarySha256"]) {
    hex(identity[key], `${name}.${key}`);
  }
  for (const key of ["engineVersion", "sqliteVersion", "target"]) {
    if (typeof identity[key] !== "string" || identity[key].length === 0) {
      fail(`${name}.${key} is invalid`);
    }
  }
  return identity;
}

function validateSyntheticStorage(storage, name) {
  const value = object(storage, name);
  exactKeys(value, [
    "canonicalIndexedSourceBytes", "preVacuum", "postVacuum", "persistentBytes",
    "stagingUpperBoundBytes", "historyEventMetadataBytes", "historyPayloadBytes",
    "historyFtsBytes", "projectionBytes", "searchablePayloadBytes",
    "storedNotSearchablePayloadBytes", "persistentStorageAmplification",
    "historyFtsAmplification", "limits",
  ], name);
  const canonical = integer(value.canonicalIndexedSourceBytes, `${name}.canonical`, 1);
  const persistent = integer(value.persistentBytes, `${name}.persistent`, 1);
  const searchable = integer(value.searchablePayloadBytes, `${name}.searchable`, 1);
  const historyFts = integer(value.historyFtsBytes, `${name}.historyFts`, 1);
  for (const key of ["historyEventMetadataBytes", "historyPayloadBytes", "historyFtsBytes"]) {
    integer(value[key], `${name}.${key}`, 1);
  }
  databaseGroupBytes(value.preVacuum, `${name}.preVacuum`);
  if (databaseGroupBytes(value.postVacuum, `${name}.postVacuum`) !== persistent) {
    fail(`${name} post-VACUUM accounting drifted`);
  }
  const storageRatio = number(
    value.persistentStorageAmplification,
    `${name}.persistentStorageAmplification`,
  );
  const ftsRatio = number(value.historyFtsAmplification, `${name}.historyFtsAmplification`);
  if (!closeEnough(storageRatio, persistent / canonical) ||
      !closeEnough(ftsRatio, historyFts / searchable)) {
    fail(`${name} amplification arithmetic drifted`);
  }
  if (value.limits?.persistentStorageAmplification !==
      DEEP_QUERY_STORAGE_AMPLIFICATION_LIMIT ||
      value.limits?.historyFtsAmplification !== DEEP_QUERY_FTS_AMPLIFICATION_LIMIT ||
      storageRatio > DEEP_QUERY_STORAGE_AMPLIFICATION_LIMIT ||
      ftsRatio > DEEP_QUERY_FTS_AMPLIFICATION_LIMIT) {
    fail(`${name} exceeded a frozen amplification limit`);
  }
}

function validateRealStorage(storage, name) {
  const value = object(storage, name);
  exactKeys(value, [
    "historyEventMetadataBytes", "historyPayloadBytes", "historyFtsBytes",
    "historyProjectionBytes", "searchablePayloadBytes", "storedNotSearchablePayloadBytes",
    "persistentBytes", "persistentStorageAmplification", "historyFtsAmplification", "limits",
  ], name);
  integer(value.persistentBytes, `${name}.persistent`, 1);
  const storageRatio = number(
    value.persistentStorageAmplification,
    `${name}.persistentStorageAmplification`,
  );
  const searchable = integer(value.searchablePayloadBytes, `${name}.searchable`, 1);
  const historyFts = integer(value.historyFtsBytes, `${name}.historyFts`, 1);
  for (const key of [
    "historyEventMetadataBytes", "historyPayloadBytes", "historyProjectionBytes",
  ]) integer(value[key], `${name}.${key}`, 1);
  const ftsRatio = number(value.historyFtsAmplification, `${name}.historyFtsAmplification`);
  if (!closeEnough(ftsRatio, historyFts / searchable)) {
    fail(`${name} amplification arithmetic drifted`);
  }
  if (value.limits?.persistentStorageAmplification !==
      DEEP_QUERY_STORAGE_AMPLIFICATION_LIMIT ||
      value.limits?.historyFtsAmplification !== DEEP_QUERY_FTS_AMPLIFICATION_LIMIT ||
      storageRatio > DEEP_QUERY_STORAGE_AMPLIFICATION_LIMIT ||
      ftsRatio > DEEP_QUERY_FTS_AMPLIFICATION_LIMIT) {
    fail(`${name} exceeded a frozen amplification limit`);
  }
}

function validateSynthetic(report, turns) {
  const name = `Deep Query ${turns}`;
  const scale = SYNTHETIC_SCALES[turns];
  if (report.format !== SYNTHETIC_FORMAT || report.measuredScope !== SYNTHETIC_SCOPE) {
    fail(`${name} format or scope is invalid`);
  }
  if (report.sourceWorktreeDirty !== false) fail(`${name} was not generated from a clean tree`);
  hex(report.sourceRevision, `${name}.sourceRevision`, [40, 64]);
  hex(report.benchmarkScriptSha256, `${name}.benchmarkScriptSha256`);
  const corpus = object(report.corpus, `${name}.corpus`);
  if (corpus.corpusVersion !== 7 || corpus.turns !== turns || corpus.sessions !== turns / 100 ||
      corpus.turnsPerSession !== 100 || corpus.seed !== scale.seed) {
    fail(`${name} corpus drifted`);
  }
  if (report.storage?.canonicalIndexedSourceBytes !== corpus.canonicalBytes) {
    fail(`${name} canonical byte accounting drifted`);
  }
  const density = corpus.density;
  if (density.historyEventsPerTurn !== 10 || density.historyPayloadsPerTurn !== 8 ||
      density.historyPayloadChunksPerTurn !== 8 || density.evidencePagingProbeEvents !== 1 ||
      density.evidencePagingProbePayloads !== 1 || density.evidencePagingProbeChunks !== 32) {
    fail(`${name} Fact V2 density drifted`);
  }
  const rows = object(report.rowCounts, `${name}.rowCounts`);
  if (rows.history_events !== turns * 10 + 1 || rows.history_payloads !== turns * 8 + 1 ||
      rows.history_payload_chunks !== turns * 8 + 32 ||
      rows.history_event_fts_documents !== turns * 8) {
    fail(`${name} Fact V2 row counts drifted`);
  }
  const deep = object(report.deepQuery, `${name}.deepQuery`);
  if (deep.measuredRequestCount !== DEEP_QUERY_COUNT ||
      deep.warmupRequestCount !== DEEP_QUERY_WARMUP_COUNT) {
    fail(`${name} work budget drifted`);
  }
  validateLatency(report.backfill?.commitAckMs, `${name}.backfill.commitAckMs`, turns / 100);
  const records = validateLatency(deep.records?.roundTripMs, `${name}.records`, DEEP_QUERY_COUNT);
  const aggregate = validateLatency(
    deep.aggregate?.roundTripMs,
    `${name}.aggregate`,
    DEEP_QUERY_COUNT,
  );
  if (deep.records.emptyResultCount !== 0 || deep.aggregate.emptyResultCount !== 0 ||
      records.p95 >= scale.p95Ms || records.p99 >= scale.p99Ms ||
      aggregate.p95 >= scale.p95Ms || aggregate.p99 >= scale.p99Ms) {
    fail(`${name} records or aggregate gate failed`);
  }
  const deepGates = object(deep.gates, `${name}.deepQuery.gates`);
  exactKeys(deepGates, [
    "budget", "recordsWithinLimit", "aggregateWithinLimit",
    "evidenceFirstPageWithinLimit", "evidencePagingAtLeast50MiBPerSecond",
    "allRecordsReturnedResults", "allAggregatesReturnedGroups", "allRecipesExercised",
    "allRecipesWithinLimit", "allEvidenceReadsCompleted", "allDeepQueryPathsExercised",
    "allMeasuredDeepQueryGatesPassed",
  ], `${name}.deepQuery.gates`);
  const expectedBudget = turns === 25_000 ? "current-25k" : "long-term-250k";
  if (deepGates.budget !== expectedBudget) fail(`${name} Deep Query budget drifted`);
  for (const key of Object.keys(deepGates).filter((key) => key !== "budget")) {
    gate(deepGates[key], `${name}.deepQuery.gates.${key}`);
  }
  exactKeys(deep.recipes, RECIPE_NAMES, `${name}.recipes`);
  for (const recipe of RECIPE_NAMES) {
    if (deep.recipes[recipe].emptyResultCount !== 0) fail(`${name}.${recipe} was empty`);
    const latency = validateLatency(
      deep.recipes[recipe].roundTripMs,
      `${name}.${recipe}`,
      DEEP_QUERY_COUNT,
    );
    if (latency.p95 >= DEEP_QUERY_RECIPE_P95_LIMIT_MS ||
        latency.p99 >= DEEP_QUERY_RECIPE_P99_LIMIT_MS) {
      fail(`${name}.${recipe} exceeded the frozen Recipe latency limit`);
    }
  }
  const evidence = object(deep.evidence, `${name}.evidence`);
  const firstPage = validateLatency(
    evidence.firstPageRoundTripMs,
    `${name}.evidence.firstPage`,
    DEEP_QUERY_COUNT,
  );
  if (evidence.completedReadCount !== DEEP_QUERY_COUNT ||
      evidence.multiPageReadCount !== DEEP_QUERY_COUNT || firstPage.p95 >= 100 ||
      integer(evidence.targetPayloadBytes, `${name}.evidence.targetPayloadBytes`, 1) <= 1024 * 1024 ||
      integer(evidence.returnedBytes, `${name}.evidence.returnedBytes`, 1) <=
        DEEP_QUERY_COUNT * 1024 * 1024 ||
      number(evidence.payloadMiBPerSecond, `${name}.evidence.throughput`) < 50) {
    fail(`${name} Evidence paging gate failed`);
  }
  hex(deep.resultDigest, `${name}.resultDigest`);
  validateSyntheticStorage(report.storage, `${name}.storage`);
  gate(report.gates?.v2CorpusComplete, `${name}.v2CorpusComplete`);
  gate(report.gates?.deepQueryPathsComplete, `${name}.deepQueryPathsComplete`);
  gate(report.gates?.deepQueryPerformanceWithinLimit, `${name}.performance`);
  gate(report.gates?.historyFtsIntegrityPassed, `${name}.historyFtsIntegrity`);
  gate(report.gates?.engineRssWithin128MiB, `${name}.rss`);
  gate(report.gates?.storageAmplificationWithinLimit, `${name}.storageAmplification`);
  gate(report.gates?.historyFtsAmplificationWithinLimit, `${name}.ftsAmplification`);
  gate(report.gates?.storageClassificationComplete, `${name}.storageClassification`);
  gate(report.gates?.queryPlanUsesEventKindIndex, `${name}.queryPlan`);
  gate(report.gates?.allMeasuredDeepQueryEvidenceGatesPassed, `${name}.allGates`);
  if (report.rss?.sidecarPeakBytes > RSS_LIMIT_BYTES || report.rss?.sidecarPeakBytes <= 0 ||
      report.rss?.peakSampled !== true) {
    fail(`${name} exceeded the 128 MiB sidecar RSS limit`);
  }
  if (!report.explain?.recordsByEventKind?.some((detail) =>
    detail.includes("history_events_kind_order")) ||
    report.explain.recordsByEventKind.some((detail) => /\bSCAN he\b/u.test(detail))) {
    fail(`${name} records query plan is invalid`);
  }
  validateEngineIdentity(report.engineIdentity, `${name}.engineIdentity`);
  assertAggregateArtifactPrivacy(report, name);
}

function validateRealSample(report) {
  const name = "Deep Query 30% real sample";
  if (report.format !== REAL_SAMPLE_FORMAT || report.sampling?.fraction !== 0.30 ||
      report.sampling?.seed !== "threadshare-insights-real-sample-v1") {
    fail(`${name} identity drifted`);
  }
  if (report.sourceWorktreeDirty !== false ||
      report.sampling.byteFraction < 0.25 || report.sampling.byteFraction > 0.35) {
    fail(`${name} is not a clean 30% byte sample`);
  }
  hex(report.sourceRevision, `${name}.sourceRevision`, [40, 64]);
  hex(report.hashes?.benchmarkScriptSha256, `${name}.benchmarkScriptSha256`);
  const deep = object(report.deepQueryV2, `${name}.deepQueryV2`);
  if (deep.measuredScope !== REAL_SAMPLE_SCOPE || deep.committedDeltaCount < 1 ||
      deep.committedDeltaCount !== report.indexing?.committed) {
    fail(`${name} committed delta coverage drifted`);
  }
  number(deep.syncWallMs, `${name}.syncWallMs`, 0.001);
  validateLatency(deep.commitAckMs, `${name}.commitAckMs`, deep.committedDeltaCount);
  for (const key of ["historyEvents", "historyPayloads", "historyPayloadChunks"]) {
    integer(deep.rows?.[key], `${name}.rows.${key}`, 1);
  }
  integer(deep.rows.historyFtsDocuments, `${name}.rows.historyFtsDocuments`, 1);
  const persistent = integer(deep.storage?.persistentBytes, `${name}.storage.persistent`, 1);
  const canonical = integer(
    deep.canonicalIndexedSourceBytes,
    `${name}.canonicalIndexedSourceBytes`,
    1,
  );
  if (!closeEnough(deep.storage?.persistentStorageAmplification, persistent / canonical)) {
    fail(`${name} persistent storage amplification arithmetic drifted`);
  }
  if (persistent !== report.storage?.postMaintenanceBytes) {
    fail(`${name} persistent byte accounting drifted`);
  }
  validateRealStorage(deep.storage, `${name}.storage`);
  if (deep.historyFtsIntegrity !== "ok") fail(`${name} history FTS integrity failed`);
  for (const key of [
    "committedDeltaCoverage", "nonemptyHistory", "historyFtsIntegrityPassed",
    "persistentStorageAmplificationWithinLimit", "historyFtsAmplificationWithinLimit",
    "allMeasuredDeepQueryV2GatesPassed",
  ]) gate(deep.gates?.[key], `${name}.${key}`);
  gate(report.gates?.allMeasuredGatesPassed, `${name}.legacyGates`);
  assertAggregateArtifactPrivacy(report, name);
}

export function validateDeepQueryEvidenceReports(reports, expected = {}) {
  exactKeys(reports, DEEP_QUERY_REPORTS, "Deep Query reports");
  validateSynthetic(reports[DEEP_QUERY_REPORTS[0]], 25_000);
  validateRealSample(reports[DEEP_QUERY_REPORTS[1]]);
  const values = Object.values(reports);
  const sourceRevision = values[0].sourceRevision;
  const engine = validateEngineIdentity(values[0].engineIdentity, "Deep Query Engine");
  if (values.some((report) => report.sourceRevision !== sourceRevision)) {
    fail("Deep Query reports do not share one source revision");
  }
  const realEngine = {
    ...reports[DEEP_QUERY_REPORTS[1]].engine,
    binarySha256: reports[DEEP_QUERY_REPORTS[1]].hashes.engineBinarySha256,
  };
  if (!isDeepStrictEqual(engine, realEngine)) {
    fail("Deep Query reports do not share one Engine identity");
  }
  if (expected.sourceRevision !== undefined && sourceRevision !== expected.sourceRevision) {
    fail("Deep Query source revision drifted");
  }
  if (expected.scriptHashes) {
    if (reports[DEEP_QUERY_REPORTS[0]].benchmarkScriptSha256 !==
        expected.scriptHashes["scripts/benchmark-insights-engine.mjs"]?.sha256 ||
        reports[DEEP_QUERY_REPORTS[1]].hashes.benchmarkScriptSha256 !==
        expected.scriptHashes["scripts/benchmark-insights-real-sample.mjs"]?.sha256) {
      fail("Deep Query benchmark script identity drifted");
    }
  }
  return { sourceRevision, engineIdentity: engine };
}

async function readReports(directory) {
  const files = (await readdir(directory)).sort();
  equal(files, [...DEEP_QUERY_REPORTS].sort(), "Deep Query input file set drifted");
  const reports = {};
  const reportBytes = {};
  const sourceReports = {};
  for (const file of DEEP_QUERY_REPORTS) {
    const bytes = await readFile(path.join(directory, file));
    reports[file] = JSON.parse(bytes.toString("utf8"));
    reportBytes[file] = bytes;
    sourceReports[file] = { bytes: bytes.length, sha256: digest(bytes) };
  }
  return { reports, reportBytes, sourceReports };
}

async function sourceIdentity(repositoryRoot) {
  const [{ stdout: revision }, { stdout: statusOutput }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: repositoryRoot,
      maxBuffer: 8 * 1024 * 1024,
    }),
  ]);
  if (statusOutput.length !== 0) fail("Deep Query evidence requires a clean worktree");
  return revision.trim();
}

async function readGitObject(repositoryRoot, revision, file) {
  const { stdout } = await execFileAsync("git", ["show", `${revision}:${file}`], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 64 * 1024 * 1024,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function sourceFileIdentities(repositoryRoot, revision, readSourceFile) {
  return Object.fromEntries(await Promise.all(SCRIPT_FILES.map(async (file) => {
    const bytes = await readSourceFile(repositoryRoot, revision, file);
    return [file, {
      source: "git-object-at-source-revision",
      bytes: bytes.length,
      sha256: digest(bytes),
    }];
  })));
}

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(file, bytes, { mode: 0o600 });
  await chmod(file, 0o600);
  return { bytes: bytes.length, sha256: digest(bytes) };
}

async function writeBytes(file, bytes) {
  await writeFile(file, bytes, { mode: 0o600 });
  await chmod(file, 0o600);
  return { bytes: bytes.length, sha256: digest(bytes) };
}

export async function packageDeepQueryEvidence({
  inputDirectory,
  outputDirectory,
  repositoryRoot = REPOSITORY_ROOT,
  readSourceIdentity = sourceIdentity,
  readSourceFile = readGitObject,
}) {
  if (await pathExists(outputDirectory)) fail("Deep Query evidence output must not exist");
  const revision = await readSourceIdentity(repositoryRoot);
  const [loaded, scripts, designBytes] = await Promise.all([
    readReports(inputDirectory),
    sourceFileIdentities(repositoryRoot, revision, readSourceFile),
    readSourceFile(repositoryRoot, revision, DESIGN_FILE),
  ]);
  const scriptHashes = Object.fromEntries(Object.entries(scripts)
    .map(([file, identity]) => [file, { sha256: identity.sha256 }]));
  const validated = validateDeepQueryEvidenceReports(loaded.reports, {
    sourceRevision: revision,
    scriptHashes,
  });
  const parent = path.dirname(outputDirectory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(parent, ".deep-query-evidence-"));
  await chmod(staging, 0o700);
  try {
    const artifacts = {};
    for (const file of DEEP_QUERY_REPORTS) {
      artifacts[file] = await writeBytes(path.join(staging, file), loaded.reportBytes[file]);
    }
    const manifest = {
      format: DEEP_QUERY_EVIDENCE_FORMAT,
      sourceRevision: revision,
      design: {
        source: "git-object-at-source-revision",
        file: DESIGN_FILE,
        bytes: designBytes.length,
        sha256: digest(designBytes),
      },
      scripts,
      engineIdentity: validated.engineIdentity,
      sourceReports: loaded.sourceReports,
      artifacts,
      formalConfiguration: {
        syntheticTurns: [25_000],
        deferredSyntheticTurns: DEEP_QUERY_DEFERRED_SYNTHETIC_TURNS,
        measuredRuns: DEEP_QUERY_COUNT,
        warmupRuns: DEEP_QUERY_WARMUP_COUNT,
        realSampleFraction: 0.30,
        persistentStorageAmplificationLimit: DEEP_QUERY_STORAGE_AMPLIFICATION_LIMIT,
        historyFtsAmplificationLimit: DEEP_QUERY_FTS_AMPLIFICATION_LIMIT,
        recipeP95LimitMs: DEEP_QUERY_RECIPE_P95_LIMIT_MS,
        recipeP99LimitMs: DEEP_QUERY_RECIPE_P99_LIMIT_MS,
        sidecarRssLimitBytes: RSS_LIMIT_BYTES,
      },
      privacy: {
        aggregateOnly: true,
        sourceReportsIncluded: true,
        rawSessionsIncluded: false,
        temporaryDatabasesIncluded: false,
        sourcePathsIncluded: false,
        sessionIdentifiersIncluded: false,
      },
    };
    assertAggregateArtifactPrivacy(manifest, "Deep Query evidence manifest");
    await writeJson(path.join(staging, "manifest.json"), manifest);
    await rename(staging, outputDirectory);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyDeepQueryEvidenceDirectory({
  directory,
  repositoryRoot = REPOSITORY_ROOT,
  readSourceFile = readGitObject,
} = {}) {
  const files = (await readdir(directory)).sort();
  equal(files, ["manifest.json", ...DEEP_QUERY_REPORTS].sort(), "Deep Query evidence file set drifted");
  const manifestBytes = await readFile(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  exactKeys(manifest, [
    "format", "sourceRevision", "design", "scripts", "engineIdentity", "sourceReports",
    "artifacts", "formalConfiguration", "privacy",
  ], "Deep Query manifest");
  if (manifest.format !== DEEP_QUERY_EVIDENCE_FORMAT) fail("Deep Query manifest format drifted");
  hex(manifest.sourceRevision, "Deep Query manifest sourceRevision", [40, 64]);
  const reports = {};
  for (const file of DEEP_QUERY_REPORTS) {
    const bytes = await readFile(path.join(directory, file));
    if (manifest.artifacts?.[file]?.bytes !== bytes.length ||
        manifest.artifacts?.[file]?.sha256 !== digest(bytes)) {
      fail(`Deep Query artifact identity drifted: ${file}`);
    }
    equal(manifest.sourceReports?.[file], manifest.artifacts[file],
      `Deep Query source-report identity drifted: ${file}`);
    reports[file] = JSON.parse(bytes.toString("utf8"));
  }
  const scripts = await sourceFileIdentities(
    repositoryRoot,
    manifest.sourceRevision,
    readSourceFile,
  );
  const designBytes = await readSourceFile(
    repositoryRoot,
    manifest.sourceRevision,
    DESIGN_FILE,
  );
  equal(manifest.scripts, scripts, "Deep Query script provenance drifted");
  equal(manifest.design, {
    source: "git-object-at-source-revision",
    file: DESIGN_FILE,
    bytes: designBytes.length,
    sha256: digest(designBytes),
  },
    "Deep Query design provenance drifted");
  exactKeys(manifest.formalConfiguration, [
    "syntheticTurns", "deferredSyntheticTurns", "measuredRuns", "warmupRuns", "realSampleFraction",
    "persistentStorageAmplificationLimit", "historyFtsAmplificationLimit",
    "recipeP95LimitMs", "recipeP99LimitMs", "sidecarRssLimitBytes",
  ], "Deep Query formalConfiguration");
  equal(manifest.formalConfiguration, {
    syntheticTurns: [25_000],
    deferredSyntheticTurns: DEEP_QUERY_DEFERRED_SYNTHETIC_TURNS,
    measuredRuns: DEEP_QUERY_COUNT,
    warmupRuns: DEEP_QUERY_WARMUP_COUNT,
    realSampleFraction: 0.30,
    persistentStorageAmplificationLimit: DEEP_QUERY_STORAGE_AMPLIFICATION_LIMIT,
    historyFtsAmplificationLimit: DEEP_QUERY_FTS_AMPLIFICATION_LIMIT,
    recipeP95LimitMs: DEEP_QUERY_RECIPE_P95_LIMIT_MS,
    recipeP99LimitMs: DEEP_QUERY_RECIPE_P99_LIMIT_MS,
    sidecarRssLimitBytes: RSS_LIMIT_BYTES,
  }, "Deep Query formal configuration drifted");
  equal(manifest.privacy, {
    aggregateOnly: true,
    sourceReportsIncluded: true,
    rawSessionsIncluded: false,
    temporaryDatabasesIncluded: false,
    sourcePathsIncluded: false,
    sessionIdentifiersIncluded: false,
  }, "Deep Query privacy declaration drifted");
  const scriptHashes = Object.fromEntries(Object.entries(scripts)
    .map(([file, identity]) => [file, { sha256: identity.sha256 }]));
  const validated = validateDeepQueryEvidenceReports(reports, {
    sourceRevision: manifest.sourceRevision,
    scriptHashes,
  });
  equal(validated.engineIdentity, manifest.engineIdentity, "Deep Query Engine identity drifted");
  assertAggregateArtifactPrivacy(manifest, "Deep Query manifest");
  return DEEP_QUERY_REPORTS.length;
}

function parseArguments(argv) {
  const options = { inputDirectory: null, outputDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (!['--input', '--output'].includes(argument)) fail(`unknown argument: ${argument}`);
    const value = argv[++index];
    if (typeof value !== "string" || value.length === 0) fail(`${argument} requires a value`);
    options[argument === "--input" ? "inputDirectory" : "outputDirectory"] = path.resolve(value);
  }
  if (options.inputDirectory === null || options.outputDirectory === null) {
    fail("--input and --output are required");
  }
  return options;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  packageDeepQueryEvidence(parseArguments(process.argv.slice(2)))
    .then((manifest) => process.stdout.write(`${JSON.stringify(manifest)}\n`))
    .catch((error) => {
      process.stderr.write(`package-insights-deep-query-evidence: ${error.message}\n`);
      process.exitCode = 1;
    });
}
