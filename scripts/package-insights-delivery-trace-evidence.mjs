#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, writeFile } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertAggregateArtifactPrivacy } from "./package-insights-benchmark-evidence.mjs";

export const DELIVERY_TRACE_EVIDENCE_FORMAT =
  "threadshare-insights-delivery-trace-evidence-manifest@v1";
export const DELIVERY_TRACE_REPORT = "delivery-trace-25k.acceptance.json";
export const DELIVERY_TRACE_DEFERRED_TURNS = Object.freeze([250_000]);

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DESIGN_FILE = "docs/insights-delivery-trace-design.md";
const BENCHMARK_FILE = "scripts/benchmark-insights-engine.mjs";
const PACKAGER_FILE = "scripts/package-insights-delivery-trace-evidence.mjs";
const REPORT_FORMAT = "threadshare-insights-delivery-trace-benchmark@v1";
const REPORT_SCOPE = "local-insights-delivery-trace-25k";
const QUERY_COUNT = 100;
const WARMUP_COUNT = 20;
const RSS_LIMIT = 128 * 1024 * 1024;
const FRAME_LIMIT = 4 * 1024 * 1024;

function fail(message) { throw new TypeError(message); }
function digest(value) { return createHash("sha256").update(value).digest("hex"); }
function equal(left, right, message) { if (!isDeepStrictEqual(left, right)) fail(message); }
function object(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) fail(`${name} must be an object`);
  return value;
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
  if (typeof value !== "string" || !lengths.includes(value.length) || !/^[0-9a-f]+$/u.test(value)) {
    fail(`${name} must be a lowercase hexadecimal digest`);
  }
  return value;
}
function gate(value, name) { if (value !== true) fail(`${name} did not pass`); }

function validateEngineIdentity(value) {
  exactKeys(value, [
    "buildManifestDigest", "engineVersion", "format", "protocolVersion",
    "sqliteCompileOptionsDigest", "sqliteVersion", "target", "binarySha256",
  ], "engineIdentity");
  if (value.format !== "threadshare-insights-engine-version@v1" ||
      typeof value.engineVersion !== "string" || value.engineVersion.length === 0 ||
      value.protocolVersion !== 1 ||
      typeof value.sqliteVersion !== "string" || value.sqliteVersion.length === 0 ||
      typeof value.target !== "string" || value.target.length === 0) {
    fail("engineIdentity is invalid");
  }
  hex(value.buildManifestDigest, "engineIdentity.buildManifestDigest");
  hex(value.sqliteCompileOptionsDigest, "engineIdentity.sqliteCompileOptionsDigest");
  hex(value.binarySha256, "engineIdentity.binarySha256");
}

function validateLatency(value, name, limitP95, limitP99) {
  exactKeys(value, ["unit", "count", "total", "p50", "p95", "p99", "max"], name);
  if (value.unit !== "ms" || value.count !== QUERY_COUNT) fail(`${name} identity drifted`);
  for (const key of ["total", "p50", "p95", "p99", "max"]) number(value[key], `${name}.${key}`);
  if (!(value.p50 <= value.p95 && value.p95 <= value.p99 && value.p99 <= value.max && value.total >= value.max)) {
    fail(`${name} percentile order is invalid`);
  }
  if (value.p95 >= limitP95 || value.p99 >= limitP99) fail(`${name} exceeded its frozen limit`);
}

export function validateDeliveryTraceReport(report) {
  exactKeys(report, [
    "format", "measuredScope", "sourceRevision", "sourceWorktreeDirty",
    "benchmarkScriptSha256", "environment", "corpus", "coverage",
    "incrementalEquivalence", "latency", "resources", "queryPlans",
    "resultDigest", "engineIdentity", "gates", "notMeasured",
  ], "Delivery Trace report");
  if (report.format !== REPORT_FORMAT || report.measuredScope !== REPORT_SCOPE) fail("Delivery Trace report identity drifted");
  hex(report.sourceRevision, "sourceRevision", [40, 64]);
  hex(report.benchmarkScriptSha256, "benchmarkScriptSha256");
  if (typeof report.sourceWorktreeDirty !== "boolean") fail("sourceWorktreeDirty must be boolean");
  exactKeys(report.corpus, ["seed", "turns", "sessions", "commits", "changedFiles", "intents"], "corpus");
  if (report.corpus.seed !== "threadshare-insights-delivery-trace-25k-v1" ||
      report.corpus.turns !== 25_000 || report.corpus.sessions !== 250 ||
      report.corpus.commits !== 5_000 || report.corpus.changedFiles !== 20_000 ||
      report.corpus.intents !== 100) fail("Delivery Trace corpus drifted");
  const coverageKeys = [
    "commits", "changedFiles", "intents", "unresolvedRefs", "unreachableCommits",
    "directEdges", "observedEdges", "candidateEdges", "contextualEdges",
  ];
  exactKeys(report.coverage, coverageKeys, "coverage");
  for (const key of coverageKeys) integer(report.coverage[key], `coverage.${key}`, 1);
  exactKeys(report.incrementalEquivalence, ["incrementalDigest", "cleanDigest", "equal"], "incrementalEquivalence");
  hex(report.incrementalEquivalence.incrementalDigest, "incrementalDigest");
  hex(report.incrementalEquivalence.cleanDigest, "cleanDigest");
  if (report.incrementalEquivalence.incrementalDigest !== report.incrementalEquivalence.cleanDigest) fail("Delivery Trace incremental digest drifted");
  gate(report.incrementalEquivalence.equal, "incrementalEquivalence.equal");
  exactKeys(report.latency, ["measuredRequestCount", "warmupRequestCount", "traceInitial", "traceExpansion", "evidenceFirstPage", "gitDiffFirstPage"], "latency");
  if (report.latency.measuredRequestCount !== QUERY_COUNT || report.latency.warmupRequestCount !== WARMUP_COUNT) fail("Delivery Trace query budget drifted");
  validateLatency(report.latency.traceInitial, "traceInitial", 200, 500);
  validateLatency(report.latency.traceExpansion, "traceExpansion", 250, 500);
  validateLatency(report.latency.evidenceFirstPage, "evidenceFirstPage", 100, 500);
  validateLatency(report.latency.gitDiffFirstPage, "gitDiffFirstPage", 500, 1_000);
  exactKeys(report.resources, ["sidecarPeakBytes", "maxResponseBytes"], "resources");
  const rss = integer(report.resources.sidecarPeakBytes, "sidecarPeakBytes", 1);
  const responseBytes = integer(report.resources.maxResponseBytes, "maxResponseBytes", 1);
  if (rss >= RSS_LIMIT || responseBytes >= FRAME_LIMIT) fail("Delivery Trace resource budget exceeded");
  exactKeys(report.queryPlans, ["edgeBySource", "changedFileByPath", "repositoryByProject"], "queryPlans");
  for (const [name, plan] of Object.entries(report.queryPlans)) {
    exactKeys(plan, ["detailDigest", "indexed"], `queryPlans.${name}`);
    hex(plan.detailDigest, `queryPlans.${name}.detailDigest`);
    gate(plan.indexed, `queryPlans.${name}.indexed`);
  }
  hex(report.resultDigest, "resultDigest");
  validateEngineIdentity(report.engineIdentity);
  const gates = [
    "corpusComplete", "incrementalEqualsClean", "traceInitialWithinLimit",
    "traceExpansionWithinLimit", "evidenceFirstPageWithinLimit",
    "gitDiffFirstPageWithinLimit", "engineRssWithin128MiB", "responseWithin4MiB",
    "indexedQueryPlans", "allMeasuredDeliveryTraceGatesPassed",
  ];
  exactKeys(report.gates, gates, "gates");
  for (const name of gates) gate(report.gates[name], `gates.${name}`);
  equal(report.notMeasured, [
    "250k Delivery Trace capacity is deferred to a later iteration",
    "network SCM availability and remote issue trackers are outside the local evidence boundary",
    "cross-repository and global filesystem discovery are intentionally unsupported",
  ], "Delivery Trace notMeasured drifted");
  assertAggregateArtifactPrivacy(report, "Delivery Trace report");
  return report;
}

async function sourceRevision(repositoryRoot) {
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot });
  return stdout.trim();
}
async function identity(file) {
  const bytes = await readFile(file);
  return { source: "packaging-worktree", bytes: bytes.length, sha256: digest(bytes) };
}
async function exists(file) { try { await stat(file); return true; } catch (error) { if (error?.code === "ENOENT") return false; throw error; } }
async function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(file, bytes, { mode: 0o600 });
  await chmod(file, 0o600);
  return { bytes: bytes.length, sha256: digest(bytes) };
}

export async function packageDeliveryTraceEvidence({
  inputFile,
  outputDirectory,
  repositoryRoot = REPOSITORY_ROOT,
} = {}) {
  if (await exists(outputDirectory)) fail("Delivery Trace evidence output must not exist");
  const bytes = await readFile(inputFile);
  const report = validateDeliveryTraceReport(JSON.parse(bytes.toString("utf8")));
  const revision = await sourceRevision(repositoryRoot);
  if (report.sourceRevision !== revision) fail("Delivery Trace source revision drifted");
  const scripts = {
    [BENCHMARK_FILE]: await identity(path.join(repositoryRoot, BENCHMARK_FILE)),
    [PACKAGER_FILE]: await identity(path.join(repositoryRoot, PACKAGER_FILE)),
  };
  if (scripts[BENCHMARK_FILE].sha256 !== report.benchmarkScriptSha256) fail("Delivery Trace benchmark identity drifted");
  const design = { file: DESIGN_FILE, ...await identity(path.join(repositoryRoot, DESIGN_FILE)) };
  const parent = path.dirname(outputDirectory);
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const staging = await mkdtemp(path.join(parent, ".delivery-trace-evidence-"));
  await chmod(staging, 0o700);
  try {
    const artifact = await writeJson(path.join(staging, DELIVERY_TRACE_REPORT), report);
    const manifest = {
      format: DELIVERY_TRACE_EVIDENCE_FORMAT,
      sourceRevision: revision,
      sourceWorktreeDirty: report.sourceWorktreeDirty,
      design,
      scripts,
      sourceReport: { bytes: bytes.length, sha256: digest(bytes) },
      artifacts: { [DELIVERY_TRACE_REPORT]: artifact },
      formalConfiguration: {
        measuredTurns: [25_000], deferredTurns: DELIVERY_TRACE_DEFERRED_TURNS,
        measuredRuns: QUERY_COUNT, warmupRuns: WARMUP_COUNT,
        traceInitialP95LimitMs: 200, traceInitialP99LimitMs: 500,
        traceExpansionP95LimitMs: 250, traceExpansionP99LimitMs: 500,
        evidenceP95LimitMs: 100, gitDiffP95LimitMs: 500,
        sidecarRssLimitBytes: RSS_LIMIT, responseLimitBytes: FRAME_LIMIT,
      },
      privacy: {
        aggregateOnly: true, rawSessionsIncluded: false, repositoryIncluded: false,
        databaseIncluded: false, sourcePathsIncluded: false, stableKeysIncluded: false,
      },
    };
    assertAggregateArtifactPrivacy(manifest, "Delivery Trace manifest");
    await writeJson(path.join(staging, "manifest.json"), manifest);
    await rename(staging, outputDirectory);
    return manifest;
  } catch (error) {
    await rm(staging, { recursive: true, force: true });
    throw error;
  }
}

export async function verifyDeliveryTraceEvidenceDirectory({ directory } = {}) {
  equal((await readdir(directory)).sort(), [DELIVERY_TRACE_REPORT, "manifest.json"], "Delivery Trace evidence file set drifted");
  const manifestBytes = await readFile(path.join(directory, "manifest.json"));
  const manifest = JSON.parse(manifestBytes.toString("utf8"));
  if (manifest.format !== DELIVERY_TRACE_EVIDENCE_FORMAT) fail("Delivery Trace manifest format drifted");
  const reportBytes = await readFile(path.join(directory, DELIVERY_TRACE_REPORT));
  const expected = manifest.artifacts?.[DELIVERY_TRACE_REPORT];
  if (expected?.bytes !== reportBytes.length || expected?.sha256 !== digest(reportBytes)) fail("Delivery Trace artifact identity drifted");
  if (manifest.sourceReport?.sha256 === undefined) fail("Delivery Trace source report identity is missing");
  validateDeliveryTraceReport(JSON.parse(reportBytes.toString("utf8")));
  equal(manifest.formalConfiguration?.deferredTurns, DELIVERY_TRACE_DEFERRED_TURNS, "Delivery Trace deferred scale drifted");
  equal(manifest.privacy, {
    aggregateOnly: true, rawSessionsIncluded: false, repositoryIncluded: false,
    databaseIncluded: false, sourcePathsIncluded: false, stableKeysIncluded: false,
  }, "Delivery Trace privacy declaration drifted");
  assertAggregateArtifactPrivacy(manifest, "Delivery Trace manifest");
  return 1;
}

function parseArguments(argv) {
  const values = { inputFile: null, outputDirectory: null };
  for (let index = 0; index < argv.length; index += 1) {
    const option = argv[index];
    const value = argv[++index];
    if (option === "--input") values.inputFile = path.resolve(value);
    else if (option === "--output") values.outputDirectory = path.resolve(value);
    else fail(`unknown argument: ${option}`);
  }
  if (values.inputFile === null || values.outputDirectory === null) fail("--input and --output are required");
  return values;
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  packageDeliveryTraceEvidence(parseArguments(process.argv.slice(2)))
    .then((manifest) => process.stdout.write(`${JSON.stringify(manifest)}\n`))
    .catch((error) => { process.stderr.write(`package-insights-delivery-trace-evidence: ${error.message}\n`); process.exitCode = 1; });
}
