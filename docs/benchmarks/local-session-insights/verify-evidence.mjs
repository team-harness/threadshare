#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import { isDeepStrictEqual, promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertAggregateArtifactPrivacy } from "../../../scripts/package-insights-benchmark-evidence.mjs";
import { verifyDeepQueryEvidenceDirectory } from "../../../scripts/package-insights-deep-query-evidence.mjs";
import {
  ITEM6_APPROVED_EPIC_SHA256,
  ITEM6_CAPACITY_CATEGORY_KEYS,
  ITEM6_CORPUS_DENSITY,
  ITEM6_ENGINE_BUILD_PROVENANCE,
  ITEM6_FORMAL_SCALES,
  ITEM6_FTS_LIMIT_BYTES,
  ITEM6_NORMALIZED_FACT_LIMIT_BYTES,
  ITEM6_OVERVIEW_EVIDENCE_FORMAT,
  ITEM6_OVERVIEW_MANIFEST_FORMAT,
  ITEM6_PRODUCT_APPEND_FRESHNESS_MEASUREMENT,
  ITEM6_PRODUCT_APPEND_LIMIT_MS,
  ITEM6_STEADY_STATE_LIMIT_BYTES,
  ITEM6_WARM_OPEN_LIMIT_MS,
} from "../../../scripts/package-insights-dashboard-evidence.mjs";

const execFileAsync = promisify(execFile);
const REPOSITORY_ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../..");
const ITEM6_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "docs",
  "benchmarks",
  "local-session-insights",
  "2026-08-11-item-6",
  "evidence",
);
const ITEM6_EPIC = path.join(
  REPOSITORY_ROOT,
  ".codestable",
  "epics",
  "local-session-insights.md",
);
const BENCHMARK_SCRIPT = "scripts/benchmark-insights-engine.mjs";
const PACKAGER_SCRIPT = "scripts/package-insights-dashboard-evidence.mjs";
const ITEM6_REPORTS = Object.freeze(Object.fromEntries(
  Object.entries(ITEM6_FORMAL_SCALES).map(([turns, scale]) => [
    scale.name,
    Object.freeze({ turns: Number(turns), ...scale }),
  ]),
));
const ITEM6_FILES = Object.freeze(["manifest.json", ...Object.keys(ITEM6_REPORTS)].sort());
const DEEP_QUERY_DIRECTORY = path.join(
  REPOSITORY_ROOT,
  "docs",
  "benchmarks",
  "local-session-insights",
  "2026-08-13-deep-query",
  "evidence",
);

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function object(value, name) {
  assert(value !== null && typeof value === "object" && !Array.isArray(value), `${name} must be an object`);
  return value;
}

function safeInteger(value, name, minimum = 0) {
  assert(Number.isSafeInteger(value) && value >= minimum, `${name} must be an integer >= ${minimum}`);
  return value;
}

function finiteNumber(value, name, minimum = 0) {
  assert(Number.isFinite(value) && value >= minimum, `${name} must be a number >= ${minimum}`);
  return value;
}

function hex(value, name, bytes = 32) {
  assert(
    typeof value === "string" && new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "u").test(value),
    `${name} must be a lowercase ${bytes}-byte digest`,
  );
  return value;
}

function equal(left, right, message) {
  assert(isDeepStrictEqual(left, right), message);
}

async function readJson(file) {
  const bytes = await readFile(file);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

async function verifyItem4() {
  const directory = new URL("./2026-08-10/", import.meta.url);
  const { value: manifest } = await readJson(new URL("manifest.json", directory));
  assert(Array.isArray(manifest.runs) && manifest.runs.length === 5, "ITEM-4 manifest must list five runs");
  for (const run of manifest.runs) {
    const { bytes } = await readJson(new URL(run.file, directory));
    assert(bytes.length === run.fileBytes, `ITEM-4 byte count mismatch: ${run.file}`);
    assert(digest(bytes) === run.outputSha256, `ITEM-4 digest mismatch: ${run.file}`);
  }
  return manifest.runs.length;
}

async function verifyItem5() {
  const directory = new URL("./2026-08-10-item-5/evidence/", import.meta.url);
  const { value: manifest } = await readJson(new URL("manifest.json", directory));
  const artifacts = Object.entries(manifest.artifacts ?? {});
  assert(artifacts.length === 6, "ITEM-5 manifest must list six reports");
  for (const [file, expected] of artifacts) {
    const { bytes } = await readJson(new URL(file, directory));
    assert(bytes.length === expected.bytes, `ITEM-5 byte count mismatch: ${file}`);
    assert(digest(bytes) === expected.sha256, `ITEM-5 digest mismatch: ${file}`);
  }
  return artifacts.length;
}

function validateEngineIdentity(value, name) {
  const identity = object(value, name);
  equal(
    Object.keys(identity).sort(),
    [
      "binarySha256",
      "buildManifestDigest",
      "engineVersion",
      "format",
      "protocolVersion",
      "sqliteCompileOptionsDigest",
      "sqliteVersion",
      "target",
    ],
    `${name} field set drifted`,
  );
  assert(identity.format === "threadshare-insights-engine-version@v1", `${name}.format is invalid`);
  assert(identity.protocolVersion === 1, `${name}.protocolVersion is invalid`);
  for (const key of ["engineVersion", "sqliteVersion", "target"]) {
    assert(typeof identity[key] === "string" && identity[key].length > 0, `${name}.${key} is invalid`);
  }
  for (const key of ["buildManifestDigest", "sqliteCompileOptionsDigest", "binarySha256"]) {
    hex(identity[key], `${name}.${key}`);
  }
  return identity;
}

function validateBuildProvenance(value, name) {
  assert(
    value === ITEM6_ENGINE_BUILD_PROVENANCE,
    `${name} must explicitly identify the local Cargo release-profile limitation`,
  );
  return value;
}

function validateOverview(value, scale, file) {
  const overview = object(value, `${file}.overview`);
  assert(overview.measuredRequestCount === 1_000, `${file} measured request count drifted`);
  assert(overview.warmupRequestCount === 100, `${file} warmup request count drifted`);
  assert(overview.totalRequestCount === 1_100, `${file} total request count drifted`);
  assert(overview.payloadMismatchCount === 0, `${file} has payload drift`);
  assert(overview.snapshotMismatchCount === 0, `${file} has snapshot drift`);

  const roundTrip = object(overview.roundTripMs, `${file}.overview.roundTripMs`);
  assert(roundTrip.unit === "ms" && roundTrip.count === 1_000, `${file} latency sample is invalid`);
  for (const key of ["total", "p50", "p95", "p99", "max"]) {
    finiteNumber(roundTrip[key], `${file}.overview.roundTripMs.${key}`);
  }
  assert(
    roundTrip.p50 <= roundTrip.p95 && roundTrip.p95 <= roundTrip.p99 && roundTrip.p99 <= roundTrip.max,
    `${file} latency percentiles are unordered`,
  );
  assert(roundTrip.total >= roundTrip.max, `${file} latency total is impossible`);

  const gates = object(overview.gates, `${file}.overview.gates`);
  assert(gates.budget === scale.budget, `${file} latency budget name drifted`);
  assert(gates.p95LimitMs === scale.p95LimitMs, `${file} P95 limit drifted`);
  assert(gates.p99LimitMs === scale.p99LimitMs, `${file} P99 limit drifted`);
  assert(roundTrip.p95 < gates.p95LimitMs, `${file} P95 exceeded its strict limit`);
  assert(roundTrip.p99 < gates.p99LimitMs, `${file} P99 exceeded its strict limit`);
  for (const key of [
    "p95WithinLimit",
    "p99WithinLimit",
    "withinLimit",
    "requestsComplete",
    "snapshotStable",
    "payloadStable",
    "allMeasuredOverviewGatesPassed",
  ]) {
    assert(gates[key] === true, `${file}.overview.gates.${key} did not pass`);
  }
}

function validateFtsMetrics(value, corpus, categoryBytes, file) {
  const metrics = object(value, `${file}.capacity.ftsMetrics`);
  assert(metrics.documents === corpus.turns, `${file} FTS document count drifted`);
  const fields = new Map(
    (Array.isArray(metrics.byField) ? metrics.byField : []).map((entry) => [entry.field, entry]),
  );
  assert(metrics.byField.length === 3, `${file} FTS field list contains duplicates`);
  equal([...fields.keys()].sort(), ["capability", "code", "natural"], `${file} FTS field set drifted`);
  for (const [field, entry] of fields) {
    for (const key of ["fieldTerms", "postings", "occurrences"]) {
      safeInteger(entry[key], `${file}.capacity.ftsMetrics.${field}.${key}`);
    }
  }
  for (const key of ["fieldTerms", "postings", "occurrences"]) {
    const total = [...fields.values()].reduce((sum, entry) => sum + entry[key], 0);
    assert(metrics[key] === total, `${file} FTS ${key} accounting drifted`);
  }
  assert(metrics.detailFullBytes === categoryBytes, `${file} FTS bytes differ from dbstat attribution`);
  assert(metrics.backendReevaluationLimitBytes === ITEM6_FTS_LIMIT_BYTES, `${file} FTS limit drifted`);
  assert(metrics.detailFullBytes <= ITEM6_FTS_LIMIT_BYTES, `${file} FTS exceeded 400 MiB`);
  assert(metrics.backendReevaluationRequired === false, `${file} requires FTS backend reevaluation`);

  const density = object(metrics.density, `${file}.capacity.ftsMetrics.density`);
  const natural = object(density.natural, `${file}.capacity.ftsMetrics.density.natural`);
  const code = object(density.code, `${file}.capacity.ftsMetrics.density.code`);
  const capability = object(density.capability, `${file}.capacity.ftsMetrics.density.capability`);
  assert(
    natural.minimumFieldTerms === corpus.turns * corpus.density.uniqueNaturalTermsPerTurn &&
      natural.minimumPostings === corpus.turns * corpus.density.naturalTermsPerTurn &&
      natural.actualFieldTerms === fields.get("natural").fieldTerms &&
      natural.actualPostings === fields.get("natural").postings &&
      natural.actualFieldTerms >= natural.minimumFieldTerms &&
      natural.actualPostings >= natural.minimumPostings &&
      natural.meetsExpectedDensity === true,
    `${file} natural FTS density is invalid`,
  );
  assert(
    code.expectedPostings === 0 &&
      code.actualFieldTerms === fields.get("code").fieldTerms &&
      code.actualPostings === fields.get("code").postings &&
      code.actualPostings === 0 &&
      code.meetsExpectedDensity === true,
    `${file} code FTS density is invalid`,
  );
  assert(
    capability.minimumPostings === corpus.turns * corpus.density.capabilityUsesPerTurn &&
      capability.actualFieldTerms === fields.get("capability").fieldTerms &&
      capability.actualPostings === fields.get("capability").postings &&
      capability.actualPostings >= capability.minimumPostings &&
      capability.meetsExpectedDensity === true,
    `${file} capability FTS density is invalid`,
  );
}

function validateStartup(value, file) {
  const startup = object(value, `${file}.startup`);
  equal(
    Object.keys(startup).sort(),
    ["populatedDatabase"],
    `${file}.startup field set drifted`,
  );
  const populated = object(startup.populatedDatabase, `${file}.startup.populatedDatabase`);
  equal(
    Object.keys(populated).sort(),
    [
      "readyMs",
      "firstOverviewReadMs",
      "readyAndFirstOverviewMs",
      "integrityStatusReadMs",
      "readyOverviewAndIntegrityStatusMs",
      "sampleCount",
      "samples",
      "gate",
    ].sort(),
    `${file}.startup.populatedDatabase field set drifted`,
  );
  const gate = object(populated.gate, `${file}.startup.populatedDatabase.gate`);
  equal(
    Object.keys(gate).sort(),
    ["limitMs", "medianReadyAndFirstOverviewUnder500Ms"].sort(),
    `${file}.startup.populatedDatabase.gate field set drifted`,
  );
  assert(populated.sampleCount === 3, `${file} warm startup sample count drifted`);
  assert(
    Array.isArray(populated.samples) && populated.samples.length === populated.sampleCount,
    `${file} warm startup samples are incomplete`,
  );
  const samples = populated.samples.map((value, index) => {
    const sample = object(value, `${file}.startup.populatedDatabase.samples[${index}]`);
    equal(
      Object.keys(sample).sort(),
      [
        "readyMs",
        "firstOverviewReadMs",
        "readyAndFirstOverviewMs",
        "integrityStatusReadMs",
        "readyOverviewAndIntegrityStatusMs",
      ].sort(),
      `${file}.startup.populatedDatabase.samples[${index}] field set drifted`,
    );
    const readyMs = finiteNumber(
      sample.readyMs,
      `${file}.startup.populatedDatabase.samples[${index}].readyMs`,
    );
    const firstOverviewReadMs = finiteNumber(
      sample.firstOverviewReadMs,
      `${file}.startup.populatedDatabase.samples[${index}].firstOverviewReadMs`,
    );
    const readyAndFirstOverviewMs = finiteNumber(
      sample.readyAndFirstOverviewMs,
      `${file}.startup.populatedDatabase.samples[${index}].readyAndFirstOverviewMs`,
    );
    const integrityStatusReadMs = finiteNumber(
      sample.integrityStatusReadMs,
      `${file}.startup.populatedDatabase.samples[${index}].integrityStatusReadMs`,
    );
    const readyOverviewAndIntegrityStatusMs = finiteNumber(
      sample.readyOverviewAndIntegrityStatusMs,
      `${file}.startup.populatedDatabase.samples[${index}].readyOverviewAndIntegrityStatusMs`,
    );
    assert(
      readyMs > 0 && firstOverviewReadMs > 0 && integrityStatusReadMs > 0,
      `${file} warm startup sample must be positive`,
    );
    assert(
      Math.abs(readyAndFirstOverviewMs - readyMs - firstOverviewReadMs) <= 1e-6,
      `${file} warm startup first-Overview arithmetic drifted`,
    );
    assert(
      Math.abs(
        readyOverviewAndIntegrityStatusMs - readyAndFirstOverviewMs - integrityStatusReadMs
      ) <= 1e-6,
      `${file} warm startup integrity-status arithmetic drifted`,
    );
    return {
      readyMs,
      firstOverviewReadMs,
      readyAndFirstOverviewMs,
      integrityStatusReadMs,
      readyOverviewAndIntegrityStatusMs,
    };
  });
  for (const key of [
    "readyMs",
    "firstOverviewReadMs",
    "readyAndFirstOverviewMs",
    "integrityStatusReadMs",
    "readyOverviewAndIntegrityStatusMs",
  ]) {
    const values = samples.map((sample) => sample[key]).sort((left, right) => left - right);
    const median = values[Math.floor(values.length / 2)];
    finiteNumber(populated[key], `${file}.startup.populatedDatabase.${key}`);
    assert(populated[key] === median, `${file} warm startup ${key} was not recomputed from samples`);
  }
  assert(gate.limitMs === ITEM6_WARM_OPEN_LIMIT_MS, `${file} warm startup limit drifted`);
  assert(
    populated.readyAndFirstOverviewMs < gate.limitMs,
    `${file} warm Engine first-Overview median exceeded 500 ms`,
  );
  assert(
    gate.medianReadyAndFirstOverviewUnder500Ms === true,
    `${file} warm Engine first-Overview gate did not pass`,
  );
}

function validateProductAppendFreshness(value, corpus, scale, file) {
  const freshness = object(value, `${file}.productAppendFreshness`);
  equal(
    Object.keys(freshness).sort(),
    ["measurement", "corpusTurnCount", "baseline", "append", "cleanup", "gate"].sort(),
    `${file}.productAppendFreshness field set drifted`,
  );
  assert(
    freshness.measurement === ITEM6_PRODUCT_APPEND_FRESHNESS_MEASUREMENT,
    `${file} product append freshness did not use the product path`,
  );
  assert(
    freshness.corpusTurnCount === corpus.turns,
    `${file} product append freshness corpus size drifted`,
  );

  const baseline = object(freshness.baseline, `${file}.productAppendFreshness.baseline`);
  equal(
    Object.keys(baseline).sort(),
    ["sessions", "turns", "ftsDocuments"].sort(),
    `${file}.productAppendFreshness.baseline field set drifted`,
  );
  equal(
    baseline,
    { sessions: scale.sessions, turns: corpus.turns, ftsDocuments: corpus.turns },
    `${file} product append freshness baseline is not the formal corpus`,
  );

  const append = object(freshness.append, `${file}.productAppendFreshness.append`);
  equal(
    Object.keys(append).sort(),
    ["commitAckMs", "appendToSearchableMs", "committed", "searchResultCount"].sort(),
    `${file}.productAppendFreshness.append field set drifted`,
  );
  finiteNumber(append.commitAckMs, `${file}.productAppendFreshness.append.commitAckMs`);
  finiteNumber(
    append.appendToSearchableMs,
    `${file}.productAppendFreshness.append.appendToSearchableMs`,
  );
  assert(append.commitAckMs > 0, `${file} product append lacks a commit acknowledgement`);
  assert(
    append.commitAckMs <= append.appendToSearchableMs,
    `${file} product append search completed before its commit acknowledgement`,
  );
  assert(
    append.appendToSearchableMs > 0 &&
      append.appendToSearchableMs <= ITEM6_PRODUCT_APPEND_LIMIT_MS,
    `${file} product append did not become searchable within two seconds`,
  );
  assert(append.committed === 1, `${file} product append did not commit exactly once`);
  assert(
    append.searchResultCount === 1,
    `${file} product append marker was not uniquely searchable`,
  );

  const cleanup = object(freshness.cleanup, `${file}.productAppendFreshness.cleanup`);
  equal(
    Object.keys(cleanup).sort(),
    ["missing", "searchResultCount", "restored"].sort(),
    `${file}.productAppendFreshness.cleanup field set drifted`,
  );
  equal(
    cleanup,
    { missing: 1, searchResultCount: 0, restored: true },
    `${file} product append cleanup did not restore the baseline`,
  );

  const gate = object(freshness.gate, `${file}.productAppendFreshness.gate`);
  equal(
    Object.keys(gate).sort(),
    [
      "limitMs",
      "productPathUsed",
      "commitAcknowledged",
      "markerUniquelySearchable",
      "cleanupRestored",
      "appendedTurnWithin2Seconds",
    ].sort(),
    `${file}.productAppendFreshness.gate field set drifted`,
  );
  assert(gate.limitMs === ITEM6_PRODUCT_APPEND_LIMIT_MS, `${file} product append limit drifted`);
  for (const key of [
    "productPathUsed",
    "commitAcknowledged",
    "markerUniquelySearchable",
    "cleanupRestored",
    "appendedTurnWithin2Seconds",
  ]) {
    assert(gate[key] === true, `${file}.productAppendFreshness.gate.${key} did not pass`);
  }
}

function validateCapacity(value, corpus, startup, productAppendFreshness, scale, file) {
  const capacity = object(value, `${file}.capacity`);
  safeInteger(capacity.observedDerivedStatePeakBytes, `${file}.capacity.observedDerivedStatePeakBytes`, 1);
  assert(
    capacity.observedDerivedStatePeakBytes <= ITEM6_STEADY_STATE_LIMIT_BYTES,
    `${file} derived-state peak exceeded 8 GiB`,
  );
  const categories = object(capacity.categories, `${file}.capacity.categories`);
  equal(
    Object.keys(categories).sort(),
    [...ITEM6_CAPACITY_CATEGORY_KEYS].sort(),
    `${file}.capacity.categories field set drifted`,
  );
  for (const key of ITEM6_CAPACITY_CATEGORY_KEYS) {
    const category = object(categories[key], `${file}.capacity.categories.${key}`);
    for (const field of ["bytes", "rows", "objects"]) {
      safeInteger(category[field], `${file}.capacity.categories.${key}.${field}`);
    }
  }
  assert(
    categories.fact.bytes <= ITEM6_NORMALIZED_FACT_LIMIT_BYTES,
    `${file} Fact storage exceeded 6 GiB`,
  );
  const fileFormatPages = object(capacity.fileFormatPages, `${file}.capacity.fileFormatPages`);
  for (const key of ["lockBytePageBytes", "freelistBytes", "totalBytes"]) {
    safeInteger(fileFormatPages[key], `${file}.capacity.fileFormatPages.${key}`);
  }
  assert(
    fileFormatPages.totalBytes === fileFormatPages.lockBytePageBytes + fileFormatPages.freelistBytes,
    `${file} file-format page accounting drifted`,
  );
  const categorizedBytes = Object.values(categories).reduce((sum, category) => sum + category.bytes, 0);
  assert(
    categorizedBytes + fileFormatPages.totalBytes === capacity.postVacuumPersistentBytes,
    `${file} post-VACUUM storage accounting drifted`,
  );
  assert(
    capacity.compactedSteadyStateBytes ===
      capacity.postVacuumPersistentBytes + corpus.maxSessionCanonicalBytes,
    `${file} compacted steady-state arithmetic drifted`,
  );
  assert(
    capacity.observedDerivedStatePeakBytes ===
      Math.max(capacity.preVacuumPersistentBytes, capacity.postVacuumPersistentBytes) +
        corpus.maxSessionCanonicalBytes,
    `${file} derived-state peak arithmetic drifted`,
  );
  assert(categories.fts.bytes <= ITEM6_FTS_LIMIT_BYTES, `${file} FTS storage exceeded 400 MiB`);
  assert(
    categories.unclassified.bytes === 0 &&
      categories.unclassified.rows === 0 &&
      categories.unclassified.objects === 0,
    `${file} has unclassified storage`,
  );

  const rss = object(capacity.engineRss, `${file}.capacity.engineRss`);
  assert(rss.limitBytes === scale.engineRssLimitBytes, `${file} sidecar RSS limit drifted`);
  safeInteger(rss.sidecarPeakBytes, `${file}.capacity.engineRss.sidecarPeakBytes`, 1);
  assert(rss.sidecarPeakBytes <= rss.limitBytes, `${file} sidecar RSS exceeded its limit`);
  assert(rss.withinLimit === true, `${file} sidecar RSS gate did not pass`);
  validateFtsMetrics(capacity.ftsMetrics, corpus, categories.fts.bytes, file);

  const gates = object(capacity.gates, `${file}.capacity.gates`);
  assert(
    gates.normalizedFactLimitBytes === ITEM6_NORMALIZED_FACT_LIMIT_BYTES,
    `${file} Fact limit drifted`,
  );
  assert(
    gates.steadyStateLimitBytes === ITEM6_STEADY_STATE_LIMIT_BYTES,
    `${file} derived-state limit drifted`,
  );
  for (const key of ["normalizedFactExceeded", "steadyStateExceeded", "packedFactsRequired"]) {
    assert(gates[key] === false, `${file}.capacity.gates.${key} must be false`);
  }
  for (const key of [
    "storageClassificationComplete",
    "dbstatMatchesPageBytes",
    "engineRssWithinLimit",
    "ftsDensityMatchesCorpus",
    "ftsBackendWithinLimit",
    "allMeasuredCapacityGatesPassed",
    "populatedWarmOpenUnder500Ms",
    "productAppendWithin2Seconds",
    "overviewLatencyWithinLimit",
  ]) {
    assert(gates[key] === true, `${file}.capacity.gates.${key} did not pass`);
  }
  assert(
    gates.populatedWarmOpenUnder500Ms ===
      startup.populatedDatabase.gate.medianReadyAndFirstOverviewUnder500Ms,
    `${file} capacity warm startup gate contradicts the startup measurement`,
  );
  assert(
    gates.productAppendWithin2Seconds ===
      productAppendFreshness.gate.appendedTurnWithin2Seconds,
    `${file} capacity product append gate contradicts the product measurement`,
  );
}

function validateCorpus(value, scale, file) {
  const corpus = object(value, `${file}.corpus`);
  assert(corpus.turns === scale.turns, `${file} turn scale drifted`);
  assert(corpus.sessions === scale.sessions, `${file} session scale drifted`);
  assert(corpus.turnsPerSession === 100, `${file} turns/session drifted`);
  assert(corpus.seed === scale.seed, `${file} corpus seed drifted`);
  const density = object(corpus.density, `${file}.corpus.density`);
  equal(
    Object.keys(density).sort(),
    Object.keys(ITEM6_CORPUS_DENSITY).sort(),
    `${file}.corpus.density field set drifted`,
  );
  equal(density, ITEM6_CORPUS_DENSITY, `${file}.corpus.density contract drifted`);
  return corpus;
}

async function readGitObject(repositoryRoot, revision, file) {
  const { stdout } = await execFileAsync("git", ["show", `${revision}:${file}`], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

function validateManifestConfiguration(manifest) {
  const configuration = object(manifest.formalConfiguration, "ITEM-6 formalConfiguration");
  equal(configuration.turns, [25_000, 250_000], "ITEM-6 formal turn scales drifted");
  assert(configuration.turnsPerSession === 100, "ITEM-6 turns/session drifted");
  assert(configuration.measuredRequests === 1_000, "ITEM-6 measured request count drifted");
  assert(configuration.warmupRequests === 100, "ITEM-6 warmup request count drifted");
  assert(configuration.totalRequests === 1_100, "ITEM-6 total request count drifted");
  equal(
    configuration.seeds,
    Object.fromEntries(Object.values(ITEM6_REPORTS).map((scale) => [scale.turns, scale.seed])),
    "ITEM-6 seed set drifted",
  );
  equal(
    configuration.latencyBudgets,
    Object.fromEntries(Object.values(ITEM6_REPORTS).map((scale) => [
      scale.turns,
      { name: scale.budget, p95LimitMs: scale.p95LimitMs, p99LimitMs: scale.p99LimitMs },
    ])),
    "ITEM-6 latency budget set drifted",
  );
}

export async function verifyItem6Evidence({
  directory = ITEM6_DIRECTORY,
  repositoryRoot = REPOSITORY_ROOT,
  epicPath = ITEM6_EPIC,
} = {}) {
  const entries = await readdir(directory, { withFileTypes: true });
  const actualFiles = entries.map((entry) => entry.name).sort();
  equal(actualFiles, ITEM6_FILES, "ITEM-6 evidence directory contains an unexpected file set");
  assert(entries.every((entry) => entry.isFile()), "ITEM-6 evidence directory must contain regular files only");

  const { value: manifest } = await readJson(path.join(directory, "manifest.json"));
  assert(manifest.format === ITEM6_OVERVIEW_MANIFEST_FORMAT, "ITEM-6 manifest format is invalid");
  hex(manifest.sourceRevision, "ITEM-6 manifest sourceRevision", 20);
  assert(manifest.approvedEpicSha256 === ITEM6_APPROVED_EPIC_SHA256, "ITEM-6 approved Epic digest drifted");
  const epicBytes = await readFile(epicPath);
  assert(digest(epicBytes) === manifest.approvedEpicSha256, "ITEM-6 approved Epic file drifted");
  validateManifestConfiguration(manifest);
  const manifestEngine = validateEngineIdentity(manifest.engineIdentity, "ITEM-6 manifest engineIdentity");
  const manifestBuildProvenance = validateBuildProvenance(
    manifest.engineBuildProvenance,
    "ITEM-6 manifest engineBuildProvenance",
  );
  equal(
    manifest.privacy,
    {
      aggregateOnly: true,
      rawReportsIncluded: false,
      rawSessionsIncluded: false,
      temporaryDatabasesIncluded: false,
      sourcePathsIncluded: false,
      sessionIdentifiersIncluded: false,
    },
    "ITEM-6 privacy declaration drifted",
  );

  const scripts = object(manifest.scripts, "ITEM-6 manifest scripts");
  equal(Object.keys(scripts).sort(), [BENCHMARK_SCRIPT, PACKAGER_SCRIPT], "ITEM-6 script set drifted");
  const benchmarkBytes = await readGitObject(repositoryRoot, manifest.sourceRevision, BENCHMARK_SCRIPT);
  equal(
    scripts[BENCHMARK_SCRIPT],
    {
      source: "git-object-at-source-revision",
      bytes: benchmarkBytes.length,
      sha256: digest(benchmarkBytes),
    },
    "ITEM-6 benchmark provenance drifted",
  );
  const packagerScript = object(scripts[PACKAGER_SCRIPT], "ITEM-6 packager provenance");
  assert(packagerScript.source === "packaging-worktree", "ITEM-6 packager provenance source drifted");
  safeInteger(packagerScript.bytes, "ITEM-6 packager provenance bytes", 1);
  hex(packagerScript.sha256, "ITEM-6 packager provenance digest");

  const artifacts = object(manifest.artifacts, "ITEM-6 manifest artifacts");
  const sourceReports = object(manifest.sourceReports, "ITEM-6 manifest sourceReports");
  equal(Object.keys(artifacts).sort(), Object.keys(ITEM6_REPORTS).sort(), "ITEM-6 artifact set drifted");
  equal(Object.keys(sourceReports).sort(), Object.keys(ITEM6_REPORTS).sort(), "ITEM-6 source-report set drifted");

  for (const [file, scale] of Object.entries(ITEM6_REPORTS)) {
    const { bytes, value } = await readJson(path.join(directory, file));
    const expectedArtifact = object(artifacts[file], `ITEM-6 manifest artifacts.${file}`);
    equal(
      Object.keys(expectedArtifact).sort(),
      ["bytes", "sha256"],
      `ITEM-6 manifest artifacts.${file} field set drifted`,
    );
    safeInteger(expectedArtifact.bytes, `ITEM-6 manifest artifacts.${file}.bytes`, 1);
    hex(expectedArtifact.sha256, `ITEM-6 manifest artifacts.${file}.sha256`);
    const expectedSourceReport = object(
      sourceReports[file],
      `ITEM-6 manifest sourceReports.${file}`,
    );
    equal(
      Object.keys(expectedSourceReport).sort(),
      ["bytes", "sha256"],
      `ITEM-6 manifest sourceReports.${file} field set drifted`,
    );
    safeInteger(expectedSourceReport.bytes, `ITEM-6 manifest sourceReports.${file}.bytes`, 1);
    hex(expectedSourceReport.sha256, `ITEM-6 manifest sourceReports.${file}.sha256`);
    assert(bytes.length === expectedArtifact.bytes, `ITEM-6 byte count mismatch: ${file}`);
    assert(digest(bytes) === expectedArtifact.sha256, `ITEM-6 digest mismatch: ${file}`);
    assert(value.format === ITEM6_OVERVIEW_EVIDENCE_FORMAT, `${file} format is invalid`);
    assert(value.sourceRevision === manifest.sourceRevision, `${file} source revision drifted`);
    assert(value.sourceWorktreeDirty === false, `${file} source worktree was dirty`);
    assert(value.approvedEpicSha256 === manifest.approvedEpicSha256, `${file} approved Epic drifted`);
    assert(value.benchmarkScriptSha256 === scripts[BENCHMARK_SCRIPT].sha256, `${file} benchmark digest drifted`);
    assert(value.packagerScriptSha256 === packagerScript.sha256, `${file} packager digest drifted`);
    equal(value.sourceReport, expectedSourceReport, `${file} source-report identity drifted`);
    equal(validateEngineIdentity(value.engineIdentity, `${file}.engineIdentity`), manifestEngine, `${file} Engine identity drifted`);
    assert(
      validateBuildProvenance(value.engineBuildProvenance, `${file}.engineBuildProvenance`) ===
        manifestBuildProvenance,
      `${file} Engine build provenance drifted`,
    );
    assert(
      value.measuredScope === "item-4-normalized-fact-fts-projection-capacity",
      `${file} measured scope is missing or invalid`,
    );
    assert(
      Array.isArray(value.notMeasured) &&
        value.notMeasured.length > 0 &&
        value.notMeasured.every((item) => typeof item === "string" && item.length > 0) &&
        new Set(value.notMeasured).size === value.notMeasured.length,
      `${file} notMeasured must explicitly list omitted measurements`,
    );
    const corpus = validateCorpus(value.corpus, scale, file);
    validateStartup(value.startup, file);
    validateProductAppendFreshness(value.productAppendFreshness, corpus, scale, file);
    validateOverview(value.overview, scale, file);
    validateCapacity(
      value.capacity,
      corpus,
      value.startup,
      value.productAppendFreshness,
      scale,
      file,
    );
    assertAggregateArtifactPrivacy(value, file);
  }
  assertAggregateArtifactPrivacy(manifest, "ITEM-6 manifest");
  return Object.keys(ITEM6_REPORTS).length;
}

export async function verifyInsightsEvidence() {
  const [item4Artifacts, item5Artifacts, item6Artifacts, deepQueryArtifacts] = await Promise.all([
    verifyItem4(),
    verifyItem5(),
    verifyItem6Evidence(),
    verifyDeepQueryEvidenceDirectory({
      directory: DEEP_QUERY_DIRECTORY,
      repositoryRoot: REPOSITORY_ROOT,
    }),
  ]);
  return {
    format: "threadshare-insights-evidence-verification@v1",
    item4Artifacts,
    item5Artifacts,
    item6Artifacts,
    deepQueryArtifacts,
  };
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  verifyInsightsEvidence()
    .then((result) => process.stdout.write(`${JSON.stringify(result)}\n`))
    .catch((error) => {
      process.stderr.write(`verify-insights-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
      process.exitCode = 1;
    });
}
