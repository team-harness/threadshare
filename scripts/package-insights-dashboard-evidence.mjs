#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { assertAggregateArtifactPrivacy } from "./package-insights-benchmark-evidence.mjs";

export const ITEM6_OVERVIEW_EVIDENCE_FORMAT =
  "threadshare-insights-item6-overview-evidence@v1";
export const ITEM6_OVERVIEW_MANIFEST_FORMAT =
  "threadshare-insights-item6-overview-evidence-manifest@v1";
export const ITEM6_APPROVED_EPIC_SHA256 =
  "46e2cc8fdc974dac26a67ab3f448bcc0df458b5ae33a28da4e2f469fe8daf582";
export const ITEM6_ENGINE_BUILD_PROVENANCE =
  "local-cargo-release-profile-unverifiable";
export const ITEM6_OVERVIEW_REPORTS = Object.freeze([
  "overview-25k.acceptance.json",
  "overview-250k.acceptance.json",
]);

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_EPIC = path.join(
  REPOSITORY_ROOT,
  ".codestable",
  "epics",
  "local-session-insights.md",
);
const BENCHMARK_SCRIPT = "scripts/benchmark-insights-engine.mjs";
const PACKAGER_SCRIPT = "scripts/package-insights-dashboard-evidence.mjs";
const RAW_REPORT_FORMAT = "threadshare-insights-capacity-benchmark@v1";
const OVERVIEW_MEASUREMENT =
  "Rust sidecar READ_INSIGHTS_OVERVIEW over transactional rollups";
const CAPACITY_MEASUREMENT =
  "pre-maintenance persistent peak plus bounded staging for the 8 GiB gate; VACUUM then dbstat for category attribution";
export const ITEM6_NORMALIZED_FACT_LIMIT_BYTES = 6 * 1024 ** 3;
export const ITEM6_STEADY_STATE_LIMIT_BYTES = 8 * 1024 ** 3;
export const ITEM6_FTS_LIMIT_BYTES = 400 * 1024 ** 2;
export const ITEM6_WARM_OPEN_LIMIT_MS = 500;

export const ITEM6_FORMAL_SCALES = Object.freeze({
  25_000: Object.freeze({
    name: ITEM6_OVERVIEW_REPORTS[0],
    sessions: 250,
    seed: "threadshare-insights-dashboard-25k-v1",
    budget: "current-25k",
    p95LimitMs: 100,
    p99LimitMs: 250,
    engineRssLimitBytes: 96 * 1024 ** 2,
  }),
  250_000: Object.freeze({
    name: ITEM6_OVERVIEW_REPORTS[1],
    sessions: 2_500,
    seed: "threadshare-insights-dashboard-250k-v1",
    budget: "long-term-250k",
    p95LimitMs: 200,
    p99LimitMs: 500,
    engineRssLimitBytes: 128 * 1024 ** 2,
  }),
});
const FORMAL_SCALES = ITEM6_FORMAL_SCALES;

export const ITEM6_CORPUS_DENSITY = Object.freeze({
  sourceRecordsPerTurn: 9,
  evidenceEventsPerTurn: 9,
  turnEvidencePerTurn: 3,
  capabilityUsesPerTurn: 3,
  capabilityUseEvidencePerTurn: 6,
  capabilitiesPerProvider: 12,
  naturalTermsPerTurn: 135,
  uniqueNaturalTermsPerTurn: 6,
  problemTextCharacters: 1_600,
  finalAnswerCharacters: 1_100,
});
const DENSITY_KEYS = Object.freeze(Object.keys(ITEM6_CORPUS_DENSITY));
export const ITEM6_CAPACITY_CATEGORY_KEYS = Object.freeze([
  "fact",
  "fts",
  "projection",
  "sourceState",
  "sqliteInternal",
  "engineOther",
  "unclassified",
]);
const CAPACITY_CATEGORY_KEYS = ITEM6_CAPACITY_CATEGORY_KEYS;
const CAPACITY_GATE_KEYS = Object.freeze([
  "normalizedFactLimitBytes",
  "steadyStateLimitBytes",
  "normalizedFactExceeded",
  "steadyStateExceeded",
  "packedFactsRequired",
  "decision",
  "storageClassificationComplete",
  "dbstatMatchesPageBytes",
  "engineRssWithinLimit",
  "ftsDensityMatchesCorpus",
  "ftsBackendWithinLimit",
  "allMeasuredCapacityGatesPassed",
  "populatedWarmOpenUnder500Ms",
  "overviewLatencyWithinLimit",
]);

function fail(message) {
  throw new TypeError(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function plainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function exactKeys(value, keys, name) {
  const actual = Object.keys(plainObject(value, name)).sort();
  const expected = [...keys].sort();
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    fail(`${name} has an unexpected field set`);
  }
}

function requireHex(value, name, bytes = 32) {
  if (
    typeof value !== "string" ||
    !new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "u").test(value)
  ) {
    fail(`${name} must be a lowercase ${bytes}-byte hex digest`);
  }
  return value;
}

function requireSafeInteger(value, name, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum) {
    fail(`${name} must be a safe integer >= ${minimum}`);
  }
  return value;
}

function requireFiniteNumber(value, name, { minimum = 0 } = {}) {
  if (!Number.isFinite(value) || value < minimum) {
    fail(`${name} must be a finite number >= ${minimum}`);
  }
  return value;
}

function requireGate(value, name) {
  if (value !== true) fail(`${name} did not pass`);
}

function requireFalse(value, name) {
  if (value !== false) fail(`${name} must be false`);
}

function requireString(value, name) {
  if (typeof value !== "string" || value.length === 0) {
    fail(`${name} must be a non-empty string`);
  }
  return value;
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 0
    ? (sorted[middle - 1] + sorted[middle]) / 2
    : sorted[middle];
}

function stableIdentity(value) {
  return JSON.stringify(
    Object.fromEntries(Object.entries(value).sort(([left], [right]) =>
      left < right ? -1 : left > right ? 1 : 0)),
  );
}

function sanitizeEngineIdentity(value, name) {
  const identity = plainObject(value, name);
  exactKeys(identity, [
    "buildManifestDigest",
    "engineVersion",
    "format",
    "protocolVersion",
    "sqliteCompileOptionsDigest",
    "sqliteVersion",
    "target",
    "binarySha256",
  ], name);
  if (identity.format !== "threadshare-insights-engine-version@v1") {
    fail(`${name}.format is invalid`);
  }
  if (typeof identity.engineVersion !== "string" || identity.engineVersion.length === 0) {
    fail(`${name}.engineVersion is invalid`);
  }
  if (identity.protocolVersion !== 1) fail(`${name}.protocolVersion is invalid`);
  if (typeof identity.sqliteVersion !== "string" || identity.sqliteVersion.length === 0) {
    fail(`${name}.sqliteVersion is invalid`);
  }
  if (typeof identity.target !== "string" || identity.target.length === 0) {
    fail(`${name}.target is invalid`);
  }
  requireHex(identity.buildManifestDigest, `${name}.buildManifestDigest`);
  requireHex(identity.sqliteCompileOptionsDigest, `${name}.sqliteCompileOptionsDigest`);
  requireHex(identity.binarySha256, `${name}.binarySha256`);
  return { ...identity };
}

function identityFromVersionDocument(value, binarySha256, name) {
  const document = plainObject(value, name);
  if (Object.hasOwn(document, "binarySha256")) {
    fail(`${name} must not claim its own binary SHA-256`);
  }
  return sanitizeEngineIdentity({ ...document, binarySha256 }, name);
}

function sanitizeHostLoad(value, name) {
  const load = plainObject(value, name);
  exactKeys(load, [
    "oneMinute",
    "fiveMinutes",
    "fifteenMinutes",
    "oneMinutePerLogicalCpu",
  ], name);
  return Object.fromEntries(Object.entries(load).map(([key, item]) => [
    key,
    requireFiniteNumber(item, `${name}.${key}`),
  ]));
}

function sanitizeEnvironment(value) {
  const environment = plainObject(value, "environment");
  exactKeys(environment, [
    "platform",
    "arch",
    "os",
    "cpuModel",
    "logicalCpuCount",
    "totalMemoryBytes",
    "nodeVersion",
    "v8Version",
    "hostLoad",
  ], "environment");
  for (const key of ["platform", "arch", "os", "cpuModel", "nodeVersion", "v8Version"]) {
    if (typeof environment[key] !== "string" || environment[key].length === 0) {
      fail(`environment.${key} is invalid`);
    }
  }
  const hostLoad = plainObject(environment.hostLoad, "environment.hostLoad");
  exactKeys(hostLoad, ["atStart", "atReport"], "environment.hostLoad");
  return {
    platform: environment.platform,
    arch: environment.arch,
    os: environment.os,
    cpuModel: environment.cpuModel,
    logicalCpuCount: requireSafeInteger(
      environment.logicalCpuCount,
      "environment.logicalCpuCount",
      { minimum: 1 },
    ),
    totalMemoryBytes: requireSafeInteger(
      environment.totalMemoryBytes,
      "environment.totalMemoryBytes",
      { minimum: 1 },
    ),
    nodeVersion: environment.nodeVersion,
    v8Version: environment.v8Version,
    hostLoad: {
      atStart: sanitizeHostLoad(hostLoad.atStart, "environment.hostLoad.atStart"),
      atReport: sanitizeHostLoad(hostLoad.atReport, "environment.hostLoad.atReport"),
    },
  };
}

function sanitizeCorpus(value, turns, scale) {
  const corpus = plainObject(value, `capacity ${turns} corpus`);
  if (corpus.corpusVersion !== 4) fail(`capacity ${turns} corpusVersion is invalid`);
  if (
    corpus.turns !== turns ||
    corpus.sessions !== scale.sessions ||
    corpus.turnsPerSession !== 100
  ) {
    fail(`capacity ${turns} corpus dimensions are invalid`);
  }
  if (corpus.seed !== scale.seed) fail(`capacity ${turns} seed is invalid`);
  requireHex(corpus.identityDigest, `capacity ${turns} identityDigest`);
  requireHex(corpus.contentDigest, `capacity ${turns} contentDigest`);
  exactKeys(corpus.density, DENSITY_KEYS, `capacity ${turns} density`);
  const density = Object.fromEntries(DENSITY_KEYS.map((key) => [
    key,
    requireSafeInteger(corpus.density[key], `capacity ${turns} density.${key}`, {
      minimum: 1,
    }),
  ]));
  if (JSON.stringify(density) !== JSON.stringify(ITEM6_CORPUS_DENSITY)) {
    fail(`capacity ${turns} density contract drifted`);
  }
  if (corpus.boundedMemoryModel !== "one generated SessionFactsDeltaV1 plus one protocol batch") {
    fail(`capacity ${turns} bounded memory model is invalid`);
  }
  return {
    corpusVersion: corpus.corpusVersion,
    seed: corpus.seed,
    identityDigest: corpus.identityDigest,
    contentDigest: corpus.contentDigest,
    turns: corpus.turns,
    sessions: corpus.sessions,
    turnsPerSession: corpus.turnsPerSession,
    density,
    canonicalBytes: requireSafeInteger(
      corpus.canonicalBytes,
      `capacity ${turns} canonicalBytes`,
      { minimum: 1 },
    ),
    maxSessionCanonicalBytes: requireSafeInteger(
      corpus.maxSessionCanonicalBytes,
      `capacity ${turns} maxSessionCanonicalBytes`,
      { minimum: 1 },
    ),
    boundedMemoryModel: corpus.boundedMemoryModel,
  };
}

function sanitizeOverview(value, turns, scale) {
  const overview = plainObject(value, `capacity ${turns} overview`);
  if (overview.measurement !== OVERVIEW_MEASUREMENT) {
    fail(`capacity ${turns} overview measurement is invalid`);
  }
  if (
    overview.measuredRequestCount !== 1_000 ||
    overview.warmupRequestCount !== 100 ||
    overview.totalRequestCount !== 1_100
  ) {
    fail(`capacity ${turns} overview request counts are invalid`);
  }
  if (
    overview.requestIdRange?.first !== "2000000" ||
    overview.requestIdRange?.last !== "2001099"
  ) {
    fail(`capacity ${turns} overview request range is invalid`);
  }
  requireHex(overview.payloadDigest, `capacity ${turns} overview payloadDigest`);
  if (overview.payloadMismatchCount !== 0 || overview.snapshotMismatchCount !== 0) {
    fail(`capacity ${turns} overview observed payload or snapshot drift`);
  }
  const roundTrip = plainObject(overview.roundTripMs, `capacity ${turns} overview roundTripMs`);
  if (roundTrip.unit !== "ms" || roundTrip.count !== 1_000) {
    fail(`capacity ${turns} overview latency sample is invalid`);
  }
  for (const key of ["total", "p50", "p95", "p99", "max"]) {
    requireFiniteNumber(roundTrip[key], `capacity ${turns} overview roundTripMs.${key}`);
  }
  if (!(roundTrip.p50 <= roundTrip.p95 && roundTrip.p95 <= roundTrip.p99 && roundTrip.p99 <= roundTrip.max)) {
    fail(`capacity ${turns} overview latency percentiles are not ordered`);
  }
  const gates = plainObject(overview.gates, `capacity ${turns} overview gates`);
  exactKeys(gates, [
    "budget",
    "p95LimitMs",
    "p99LimitMs",
    "p95WithinLimit",
    "p99WithinLimit",
    "withinLimit",
    "requestsComplete",
    "snapshotStable",
    "payloadStable",
    "allMeasuredOverviewGatesPassed",
  ], `capacity ${turns} overview gates`);
  if (
    gates.budget !== scale.budget ||
    gates.p95LimitMs !== scale.p95LimitMs ||
    gates.p99LimitMs !== scale.p99LimitMs
  ) {
    fail(`capacity ${turns} overview threshold contract drifted`);
  }
  if (roundTrip.p95 >= scale.p95LimitMs || roundTrip.p99 >= scale.p99LimitMs) {
    fail(`capacity ${turns} overview latency exceeded its formal threshold`);
  }
  for (const key of [
    "p95WithinLimit",
    "p99WithinLimit",
    "withinLimit",
    "requestsComplete",
    "snapshotStable",
    "payloadStable",
    "allMeasuredOverviewGatesPassed",
  ]) {
    requireGate(gates[key], `capacity ${turns} overview gates.${key}`);
  }
  return {
    measurement: overview.measurement,
    measuredRequestCount: overview.measuredRequestCount,
    warmupRequestCount: overview.warmupRequestCount,
    totalRequestCount: overview.totalRequestCount,
    payloadDigest: overview.payloadDigest,
    payloadMismatchCount: overview.payloadMismatchCount,
    snapshotMismatchCount: overview.snapshotMismatchCount,
    roundTripMs: {
      unit: roundTrip.unit,
      count: roundTrip.count,
      total: roundTrip.total,
      p50: roundTrip.p50,
      p95: roundTrip.p95,
      p99: roundTrip.p99,
      max: roundTrip.max,
    },
    gates: { ...gates },
  };
}

function sanitizeNotMeasured(value, turns) {
  if (!Array.isArray(value) || value.length === 0) {
    fail(`capacity ${turns} notMeasured must be a non-empty array`);
  }
  const items = value.map((item, index) =>
    requireString(item, `capacity ${turns} notMeasured[${index}]`));
  if (new Set(items).size !== items.length) {
    fail(`capacity ${turns} notMeasured entries must be unique`);
  }
  return items;
}

function sanitizePopulatedStartup(value, turns) {
  const startup = plainObject(value, `capacity ${turns} populated startup`);
  exactKeys(startup, [
    "readyMs",
    "statusReadMs",
    "readyAndStatusMs",
    "status",
    "sampleCount",
    "samples",
    "gate",
  ], `capacity ${turns} populated startup`);
  plainObject(startup.status, `capacity ${turns} populated startup status`);
  const sampleCount = requireSafeInteger(
    startup.sampleCount,
    `capacity ${turns} populated startup sampleCount`,
    { minimum: 1 },
  );
  if (!Array.isArray(startup.samples) || startup.samples.length !== sampleCount) {
    fail(`capacity ${turns} populated startup samples are incomplete`);
  }
  const samples = startup.samples.map((value, index) => {
    const sample = plainObject(value, `capacity ${turns} populated startup sample ${index}`);
    exactKeys(sample, ["readyMs", "statusReadMs", "readyAndStatusMs"],
      `capacity ${turns} populated startup sample ${index}`);
    const sanitized = {
      readyMs: requireFiniteNumber(
        sample.readyMs,
        `capacity ${turns} populated startup sample ${index}.readyMs`,
      ),
      statusReadMs: requireFiniteNumber(
        sample.statusReadMs,
        `capacity ${turns} populated startup sample ${index}.statusReadMs`,
      ),
      readyAndStatusMs: requireFiniteNumber(
        sample.readyAndStatusMs,
        `capacity ${turns} populated startup sample ${index}.readyAndStatusMs`,
      ),
    };
    if (
      sanitized.readyMs <= 0 ||
      sanitized.statusReadMs <= 0 ||
      Math.abs(
        sanitized.readyAndStatusMs - sanitized.readyMs - sanitized.statusReadMs
      ) > 1e-6
    ) {
      fail(`capacity ${turns} populated startup sample ${index} is inconsistent`);
    }
    return sanitized;
  });
  const summary = {
    readyMs: requireFiniteNumber(startup.readyMs, `capacity ${turns} populated startup readyMs`),
    statusReadMs: requireFiniteNumber(
      startup.statusReadMs,
      `capacity ${turns} populated startup statusReadMs`,
    ),
    readyAndStatusMs: requireFiniteNumber(
      startup.readyAndStatusMs,
      `capacity ${turns} populated startup readyAndStatusMs`,
    ),
  };
  for (const key of Object.keys(summary)) {
    if (summary[key] !== median(samples.map((sample) => sample[key]))) {
      fail(`capacity ${turns} populated startup ${key} is not the sample median`);
    }
  }
  const gate = plainObject(startup.gate, `capacity ${turns} populated startup gate`);
  exactKeys(gate, ["limitMs", "medianReadyUnder500Ms"],
    `capacity ${turns} populated startup gate`);
  if (
    gate.limitMs !== ITEM6_WARM_OPEN_LIMIT_MS ||
    gate.medianReadyUnder500Ms !== (summary.readyMs < ITEM6_WARM_OPEN_LIMIT_MS) ||
    gate.medianReadyUnder500Ms !== true
  ) {
    fail(`capacity ${turns} populated startup gate is invalid`);
  }
  return {
    ...summary,
    sampleCount,
    samples,
    gate: { ...gate },
  };
}

function sanitizeFtsMetrics(value, categories, turns) {
  const metrics = plainObject(value, `capacity ${turns} FTS metrics`);
  exactKeys(metrics, [
    "documents",
    "fieldTerms",
    "postings",
    "occurrences",
    "byField",
    "density",
    "detailFullBytes",
    "backendReevaluationLimitBytes",
    "backendReevaluationRequired",
  ], `capacity ${turns} FTS metrics`);
  const totals = {
    documents: requireSafeInteger(metrics.documents, `capacity ${turns} FTS documents`, {
      minimum: 1,
    }),
    fieldTerms: requireSafeInteger(metrics.fieldTerms, `capacity ${turns} FTS fieldTerms`),
    postings: requireSafeInteger(metrics.postings, `capacity ${turns} FTS postings`),
    occurrences: requireSafeInteger(metrics.occurrences, `capacity ${turns} FTS occurrences`),
  };
  if (totals.documents !== turns) {
    fail(`capacity ${turns} FTS document count is invalid`);
  }
  if (!Array.isArray(metrics.byField) || metrics.byField.length !== 3) {
    fail(`capacity ${turns} FTS byField must contain three fields`);
  }
  const expectedFields = ["natural", "code", "capability"];
  const byField = metrics.byField.map((value, index) => {
    const field = plainObject(value, `capacity ${turns} FTS field ${index}`);
    exactKeys(field, ["field", "fieldTerms", "postings", "occurrences"],
      `capacity ${turns} FTS field ${index}`);
    if (field.field !== expectedFields[index]) {
      fail(`capacity ${turns} FTS field order is invalid`);
    }
    return {
      field: field.field,
      fieldTerms: requireSafeInteger(
        field.fieldTerms,
        `capacity ${turns} FTS ${field.field}.fieldTerms`,
      ),
      postings: requireSafeInteger(
        field.postings,
        `capacity ${turns} FTS ${field.field}.postings`,
      ),
      occurrences: requireSafeInteger(
        field.occurrences,
        `capacity ${turns} FTS ${field.field}.occurrences`,
      ),
    };
  });
  for (const key of ["fieldTerms", "postings", "occurrences"]) {
    if (byField.reduce((sum, field) => sum + field[key], 0) !== totals[key]) {
      fail(`capacity ${turns} FTS ${key} does not match field totals`);
    }
  }
  const fieldMap = Object.fromEntries(byField.map((field) => [field.field, field]));
  const density = plainObject(metrics.density, `capacity ${turns} FTS density`);
  exactKeys(density, expectedFields, `capacity ${turns} FTS density`);
  const sanitizedDensity = {};
  for (const fieldName of expectedFields) {
    const fieldDensity = plainObject(
      density[fieldName],
      `capacity ${turns} FTS density.${fieldName}`,
    );
    const keys = fieldName === "code"
      ? ["expectedPostings", "actualFieldTerms", "actualPostings", "meetsExpectedDensity"]
      : fieldName === "natural"
        ? [
            "minimumFieldTerms",
            "minimumPostings",
            "actualFieldTerms",
            "actualPostings",
            "meetsExpectedDensity",
          ]
        : ["minimumPostings", "actualFieldTerms", "actualPostings", "meetsExpectedDensity"];
    exactKeys(fieldDensity, keys, `capacity ${turns} FTS density.${fieldName}`);
    const sanitized = Object.fromEntries(keys.map((key) => [
      key,
      key === "meetsExpectedDensity"
        ? fieldDensity[key]
        : requireSafeInteger(
            fieldDensity[key],
            `capacity ${turns} FTS density.${fieldName}.${key}`,
          ),
    ]));
    if (
      sanitized.actualFieldTerms !== fieldMap[fieldName].fieldTerms ||
      sanitized.actualPostings !== fieldMap[fieldName].postings ||
      sanitized.meetsExpectedDensity !== true
    ) {
      fail(`capacity ${turns} FTS density.${fieldName} is inconsistent`);
    }
    if (fieldName === "code") {
      if (
        sanitized.actualPostings !== sanitized.expectedPostings ||
        sanitized.actualFieldTerms !== 0
      ) {
        fail(`capacity ${turns} FTS code density is invalid`);
      }
    } else if (
      sanitized.actualPostings < sanitized.minimumPostings ||
      (fieldName === "natural" &&
        sanitized.actualFieldTerms < sanitized.minimumFieldTerms)
    ) {
      fail(`capacity ${turns} FTS density.${fieldName} missed its minimum`);
    }
    sanitizedDensity[fieldName] = sanitized;
  }
  const detailFullBytes = requireSafeInteger(
    metrics.detailFullBytes,
    `capacity ${turns} FTS detailFullBytes`,
    { minimum: 1 },
  );
  if (
    detailFullBytes !== categories.fts.bytes ||
    metrics.backendReevaluationLimitBytes !== ITEM6_FTS_LIMIT_BYTES ||
    metrics.backendReevaluationRequired !== (detailFullBytes > ITEM6_FTS_LIMIT_BYTES) ||
    metrics.backendReevaluationRequired !== false
  ) {
    fail(`capacity ${turns} FTS backend gate is invalid`);
  }
  return {
    ...totals,
    byField,
    density: sanitizedDensity,
    detailFullBytes,
    backendReevaluationLimitBytes: metrics.backendReevaluationLimitBytes,
    backendReevaluationRequired: metrics.backendReevaluationRequired,
  };
}

function sanitizeCapacity(
  value,
  packedFactsDecision,
  maxSessionCanonicalBytes,
  startup,
  turns,
  scale,
) {
  const capacity = plainObject(value, `capacity ${turns} storage`);
  if (capacity.measurement !== CAPACITY_MEASUREMENT) {
    fail(`capacity ${turns} storage measurement is invalid`);
  }
  const result = {
    measurement: capacity.measurement,
    preVacuumPersistentBytes: requireSafeInteger(
      capacity.preVacuumPersistentBytes,
      `capacity ${turns} preVacuumPersistentBytes`,
      { minimum: 1 },
    ),
    postVacuumPersistentBytes: requireSafeInteger(
      capacity.postVacuumPersistentBytes,
      `capacity ${turns} postVacuumPersistentBytes`,
      { minimum: 1 },
    ),
    compactedSteadyStateBytes: requireSafeInteger(
      capacity.compactedSteadyStateBytes,
      `capacity ${turns} compactedSteadyStateBytes`,
      { minimum: 1 },
    ),
    observedDerivedStatePeakBytes: requireSafeInteger(
      capacity.observedDerivedStatePeakBytes,
      `capacity ${turns} observedDerivedStatePeakBytes`,
      { minimum: 1 },
    ),
  };
  if (!Array.isArray(capacity.integrity) || JSON.stringify(capacity.integrity) !== '["ok"]') {
    fail(`capacity ${turns} integrity check did not pass`);
  }
  if (capacity.foreignKeyViolations !== 0) {
    fail(`capacity ${turns} has foreign-key violations`);
  }
  if (!Array.isArray(capacity.unclassifiedObjects) || capacity.unclassifiedObjects.length !== 0) {
    fail(`capacity ${turns} has unclassified storage objects`);
  }
  exactKeys(capacity.categories, CAPACITY_CATEGORY_KEYS, `capacity ${turns} categories`);
  const categories = {};
  for (const key of CAPACITY_CATEGORY_KEYS) {
    const category = plainObject(capacity.categories[key], `capacity ${turns} categories.${key}`);
    exactKeys(category, ["bytes", "rows", "objects"], `capacity ${turns} categories.${key}`);
    categories[key] = {
      bytes: requireSafeInteger(category.bytes, `capacity ${turns} categories.${key}.bytes`),
      rows: requireSafeInteger(category.rows, `capacity ${turns} categories.${key}.rows`),
      objects: requireSafeInteger(category.objects, `capacity ${turns} categories.${key}.objects`),
    };
  }
  const fileFormatPages = plainObject(
    capacity.fileFormatPages,
    `capacity ${turns} fileFormatPages`,
  );
  exactKeys(fileFormatPages, [
    "lockBytePageBytes",
    "freelistBytes",
    "totalBytes",
  ], `capacity ${turns} fileFormatPages`);
  const sanitizedFileFormatPages = {
    lockBytePageBytes: requireSafeInteger(
      fileFormatPages.lockBytePageBytes,
      `capacity ${turns} fileFormatPages.lockBytePageBytes`,
    ),
    freelistBytes: requireSafeInteger(
      fileFormatPages.freelistBytes,
      `capacity ${turns} fileFormatPages.freelistBytes`,
    ),
    totalBytes: requireSafeInteger(
      fileFormatPages.totalBytes,
      `capacity ${turns} fileFormatPages.totalBytes`,
    ),
  };
  if (
    sanitizedFileFormatPages.totalBytes !==
    sanitizedFileFormatPages.lockBytePageBytes + sanitizedFileFormatPages.freelistBytes
  ) {
    fail(`capacity ${turns} file-format page accounting is invalid`);
  }
  const categorizedBytes = Object.values(categories)
    .reduce((sum, category) => sum + category.bytes, 0);
  if (
    requireSafeInteger(capacity.dbstatBytes, `capacity ${turns} dbstatBytes`) !== categorizedBytes ||
    requireSafeInteger(
      capacity.dbstatAccountedPageBytes,
      `capacity ${turns} dbstatAccountedPageBytes`,
    ) !== categorizedBytes + sanitizedFileFormatPages.totalBytes ||
    requireSafeInteger(capacity.databasePageBytes, `capacity ${turns} databasePageBytes`) !==
      result.postVacuumPersistentBytes ||
    categorizedBytes + sanitizedFileFormatPages.totalBytes !==
      result.postVacuumPersistentBytes
  ) {
    fail(`capacity ${turns} category bytes do not account for post-VACUUM pages`);
  }
  if (
    categories.unclassified.bytes !== 0 ||
    categories.unclassified.rows !== 0 ||
    categories.unclassified.objects !== 0
  ) {
    fail(`capacity ${turns} unclassified category is non-empty`);
  }
  if (
    categories.fact.bytes > ITEM6_NORMALIZED_FACT_LIMIT_BYTES ||
    categories.fts.bytes > ITEM6_FTS_LIMIT_BYTES ||
    result.observedDerivedStatePeakBytes > ITEM6_STEADY_STATE_LIMIT_BYTES
  ) {
    fail(`capacity ${turns} raw storage values exceed a formal capacity threshold`);
  }
  if (
    result.compactedSteadyStateBytes !==
      result.postVacuumPersistentBytes + maxSessionCanonicalBytes ||
    result.observedDerivedStatePeakBytes !==
      Math.max(result.preVacuumPersistentBytes, result.postVacuumPersistentBytes) +
        maxSessionCanonicalBytes
  ) {
    fail(`capacity ${turns} staging upper-bound arithmetic is invalid`);
  }
  const ftsMetrics = sanitizeFtsMetrics(capacity.ftsMetrics, categories, turns);
  const engineRss = plainObject(capacity.engineRss, `capacity ${turns} engineRss`);
  exactKeys(engineRss, [
    "limitBytes",
    "sidecarPeakBytes",
    "nodeHarnessPeakBytes",
    "combinedPeakBytes",
    "withinLimit",
  ], `capacity ${turns} engineRss`);
  if (engineRss.limitBytes !== scale.engineRssLimitBytes) {
    fail(`capacity ${turns} Engine RSS threshold drifted`);
  }
  requireGate(engineRss.withinLimit, `capacity ${turns} engineRss.withinLimit`);
  if (
    requireSafeInteger(engineRss.sidecarPeakBytes, `capacity ${turns} engineRss.sidecarPeakBytes`, {
      minimum: 1,
    }) > scale.engineRssLimitBytes
  ) {
    fail(`capacity ${turns} Engine RSS exceeded its formal threshold`);
  }
  const sanitizedRss = {
    limitBytes: engineRss.limitBytes,
    sidecarPeakBytes: engineRss.sidecarPeakBytes,
    nodeHarnessPeakBytes: requireSafeInteger(
      engineRss.nodeHarnessPeakBytes,
      `capacity ${turns} engineRss.nodeHarnessPeakBytes`,
    ),
    combinedPeakBytes: requireSafeInteger(
      engineRss.combinedPeakBytes,
      `capacity ${turns} engineRss.combinedPeakBytes`,
    ),
    withinLimit: engineRss.withinLimit,
  };
  const gates = plainObject(capacity.gates, `capacity ${turns} storage gates`);
  exactKeys(gates, CAPACITY_GATE_KEYS, `capacity ${turns} storage gates`);
  if (
    gates.normalizedFactLimitBytes !== ITEM6_NORMALIZED_FACT_LIMIT_BYTES ||
    gates.steadyStateLimitBytes !== ITEM6_STEADY_STATE_LIMIT_BYTES ||
    gates.decision !== "normalized-row-v1-within-capacity-gates"
  ) {
    fail(`capacity ${turns} storage threshold contract drifted`);
  }
  for (const key of ["normalizedFactExceeded", "steadyStateExceeded", "packedFactsRequired"]) {
    requireFalse(gates[key], `capacity ${turns} storage gates.${key}`);
  }
  for (const key of [
    "storageClassificationComplete",
    "dbstatMatchesPageBytes",
    "engineRssWithinLimit",
    "ftsDensityMatchesCorpus",
    "ftsBackendWithinLimit",
    "allMeasuredCapacityGatesPassed",
    "populatedWarmOpenUnder500Ms",
    "overviewLatencyWithinLimit",
  ]) {
    requireGate(gates[key], `capacity ${turns} storage gates.${key}`);
  }
  if (
    gates.ftsDensityMatchesCorpus !== Object.values(ftsMetrics.density)
      .every((field) => field.meetsExpectedDensity === true) ||
    gates.ftsBackendWithinLimit !== !ftsMetrics.backendReevaluationRequired ||
    gates.populatedWarmOpenUnder500Ms !== startup.gate.medianReadyUnder500Ms
  ) {
    fail(`capacity ${turns} storage gates do not match measured FTS/startup values`);
  }
  if (stableIdentity(plainObject(packedFactsDecision, `capacity ${turns} packedFactsDecision`)) !== stableIdentity(gates)) {
    fail(`capacity ${turns} packed-facts decision differs from capacity gates`);
  }
  return {
    ...result,
    categories,
    fileFormatPages: sanitizedFileFormatPages,
    ftsMetrics,
    engineRss: sanitizedRss,
    gates: { ...gates },
  };
}

function sourceReportIdentity(value, turns) {
  const report = plainObject(value, `capacity ${turns} source report identity`);
  return {
    bytes: requireSafeInteger(report.bytes, `capacity ${turns} source report bytes`, {
      minimum: 1,
    }),
    sha256: requireHex(report.sha256, `capacity ${turns} source report SHA-256`),
  };
}

function validateOneReport(report, turns, expected) {
  const scale = FORMAL_SCALES[turns];
  plainObject(report, `capacity ${turns} raw report`);
  if (report.format !== RAW_REPORT_FORMAT) fail(`capacity ${turns} format is invalid`);
  if (report.measuredScope !== "item-4-normalized-fact-fts-projection-capacity") {
    fail(`capacity ${turns} measured scope is invalid`);
  }
  const notMeasured = sanitizeNotMeasured(report.notMeasured, turns);
  requireHex(report.sourceRevision, `capacity ${turns} sourceRevision`, 20);
  if (report.sourceRevision !== expected.sourceRevision) {
    fail(`capacity ${turns} was not generated from the selected source revision`);
  }
  if (report.sourceWorktreeDirty !== false) {
    fail(`capacity ${turns} was not generated from a clean worktree`);
  }
  if (report.benchmarkScriptSha256 !== expected.benchmarkScriptSha256) {
    fail(`capacity ${turns} was not generated by the selected benchmark script`);
  }
  if (report.mutations !== null) fail(`capacity ${turns} must be a skip-mutations Overview run`);
  const corpus = sanitizeCorpus(report.corpus, turns, scale);
  const sidecar = plainObject(report.rustSidecar, `capacity ${turns} rustSidecar`);
  if (sidecar.engine !== "rust-sidecar") fail(`capacity ${turns} did not use the Rust sidecar`);
  const engineIdentity = sanitizeEngineIdentity(
    sidecar.engineIdentity,
    `capacity ${turns} engineIdentity`,
  );
  if (
    sidecar.engineVersion !== engineIdentity.engineVersion ||
    sidecar.target !== engineIdentity.target ||
    sidecar.sqliteVersion !== engineIdentity.sqliteVersion
  ) {
    fail(`capacity ${turns} Rust sidecar identity fields drifted`);
  }
  if (
    sidecar.corpusDigest !== corpus.contentDigest ||
    sidecar.canonicalBytes !== corpus.canonicalBytes ||
    sidecar.maxSessionCanonicalBytes !== corpus.maxSessionCanonicalBytes
  ) {
    fail(`capacity ${turns} Rust sidecar corpus identity drifted`);
  }
  const startup = sanitizePopulatedStartup(
    plainObject(sidecar.startup, `capacity ${turns} Rust sidecar startup`).populatedDatabase,
    turns,
  );
  const evidence = {
    format: ITEM6_OVERVIEW_EVIDENCE_FORMAT,
    measuredScope: report.measuredScope,
    notMeasured,
    sourceRevision: report.sourceRevision,
    sourceWorktreeDirty: report.sourceWorktreeDirty,
    approvedEpicSha256: expected.approvedEpicSha256,
    benchmarkScriptSha256: report.benchmarkScriptSha256,
    packagerScriptSha256: expected.packagerScriptSha256,
    sourceReport: sourceReportIdentity(expected.sourceReports[turns], turns),
    environment: sanitizeEnvironment(report.environment),
    corpus,
    engineIdentity,
    engineBuildProvenance: ITEM6_ENGINE_BUILD_PROVENANCE,
    startup: { populatedDatabase: startup },
    overview: sanitizeOverview(sidecar.overview, turns, scale),
    capacity: sanitizeCapacity(
      sidecar.capacity,
      report.packedFactsDecision,
      corpus.maxSessionCanonicalBytes,
      startup,
      turns,
      scale,
    ),
  };
  assertAggregateArtifactPrivacy(evidence, `capacity ${turns} evidence`);
  return evidence;
}

export function validateDashboardOverviewReports(reports, expected) {
  plainObject(reports, "Overview reports");
  const contract = plainObject(expected, "Overview expected identity");
  requireHex(contract.sourceRevision, "selected sourceRevision", 20);
  requireHex(contract.benchmarkScriptSha256, "selected benchmark script SHA-256");
  requireHex(contract.packagerScriptSha256, "selected packager script SHA-256");
  if (contract.approvedEpicSha256 !== ITEM6_APPROVED_EPIC_SHA256) {
    fail("approved Epic SHA-256 drifted");
  }
  plainObject(contract.sourceReports, "source report identities");
  const evidence = Object.fromEntries(Object.keys(FORMAL_SCALES).map((turnsText) => {
    const turns = Number(turnsText);
    if (reports[turns] === undefined) fail(`capacity ${turns} report is missing`);
    return [turns, validateOneReport(reports[turns], turns, contract)];
  }));
  const identities = Object.values(evidence);
  if (identities.some((item) => item.sourceRevision !== identities[0].sourceRevision)) {
    fail("Overview reports do not share one source revision");
  }
  if (identities.some((item) => item.benchmarkScriptSha256 !== identities[0].benchmarkScriptSha256)) {
    fail("Overview reports do not share one benchmark script");
  }
  const engine = stableIdentity(identities[0].engineIdentity);
  if (identities.some((item) => stableIdentity(item.engineIdentity) !== engine)) {
    fail("Overview reports do not share one Engine identity");
  }
  const selectedEngine = sanitizeEngineIdentity(
    contract.engineIdentity,
    "selected Engine identity",
  );
  if (stableIdentity(selectedEngine) !== engine) {
    fail("Overview reports were not generated by the selected Engine binary");
  }
  return evidence;
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

async function readSourceBenchmark(repositoryRoot, sourceRevision) {
  const { stdout } = await execFileAsync("git", [
    "show",
    `${sourceRevision}:${BENCHMARK_SCRIPT}`,
  ], {
    cwd: repositoryRoot,
    encoding: null,
    maxBuffer: 32 * 1024 * 1024,
  });
  return Buffer.isBuffer(stdout) ? stdout : Buffer.from(stdout);
}

async function readRawReport(file) {
  const bytes = await readFile(file);
  return {
    bytes,
    report: JSON.parse(bytes.toString("utf8")),
    identity: { bytes: bytes.length, sha256: sha256(bytes) },
  };
}

export async function packageDashboardOverviewEvidence({
  report25kPath,
  report250kPath,
  outputDirectory,
  enginePath,
  epicPath = DEFAULT_EPIC,
  repositoryRoot = REPOSITORY_ROOT,
}) {
  if (await pathExists(outputDirectory)) {
    fail("Dashboard evidence output directory must not already exist");
  }
  const [epicBytes, packagerBytes, engineBytes, raw25k, raw250k] = await Promise.all([
    readFile(epicPath),
    readFile(SCRIPT_PATH),
    readFile(enginePath),
    readRawReport(report25kPath),
    readRawReport(report250kPath),
  ]);
  const sourceRevision = raw25k.report?.sourceRevision;
  requireHex(sourceRevision, "25k sourceRevision", 20);
  if (raw250k.report?.sourceRevision !== sourceRevision) {
    fail("Overview reports do not share one source revision");
  }
  if (
    raw25k.report?.sourceWorktreeDirty !== false ||
    raw250k.report?.sourceWorktreeDirty !== false
  ) {
    fail("Overview reports were not generated from a clean source worktree");
  }
  const benchmarkBytes = await readSourceBenchmark(repositoryRoot, sourceRevision);
  const approvedEpicSha256 = sha256(epicBytes);
  if (approvedEpicSha256 !== ITEM6_APPROVED_EPIC_SHA256) {
    fail("approved Epic SHA-256 drifted");
  }
  const benchmarkScriptSha256 = sha256(benchmarkBytes);
  const packagerScriptSha256 = sha256(packagerBytes);
  const engineBinarySha256 = sha256(engineBytes);
  const { stdout: versionOutput } = await execFileAsync(enginePath, ["--version", "--json"], {
    maxBuffer: 1024 * 1024,
  });
  const engineIdentity = identityFromVersionDocument(
    JSON.parse(versionOutput),
    engineBinarySha256,
    "selected Engine identity",
  );
  const evidence = validateDashboardOverviewReports(
    { 25_000: raw25k.report, 250_000: raw250k.report },
    {
      sourceRevision,
      benchmarkScriptSha256,
      packagerScriptSha256,
      approvedEpicSha256,
      engineIdentity,
      sourceReports: { 25_000: raw25k.identity, 250_000: raw250k.identity },
    },
  );
  const reportBytes = {
    [FORMAL_SCALES[25_000].name]: Buffer.from(`${JSON.stringify(evidence[25_000], null, 2)}\n`),
    [FORMAL_SCALES[250_000].name]: Buffer.from(`${JSON.stringify(evidence[250_000], null, 2)}\n`),
  };
  const artifacts = Object.fromEntries(ITEM6_OVERVIEW_REPORTS.map((name) => [
    name,
    { bytes: reportBytes[name].length, sha256: sha256(reportBytes[name]) },
  ]));
  const manifest = {
    format: ITEM6_OVERVIEW_MANIFEST_FORMAT,
    sourceRevision,
    approvedEpicSha256,
    scripts: {
      [BENCHMARK_SCRIPT]: {
        source: "git-object-at-source-revision",
        bytes: benchmarkBytes.length,
        sha256: benchmarkScriptSha256,
      },
      [PACKAGER_SCRIPT]: {
        source: "packaging-worktree",
        bytes: packagerBytes.length,
        sha256: packagerScriptSha256,
      },
    },
    formalConfiguration: {
      turns: [25_000, 250_000],
      turnsPerSession: 100,
      measuredRequests: 1_000,
      warmupRequests: 100,
      totalRequests: 1_100,
      seeds: Object.fromEntries(Object.entries(FORMAL_SCALES).map(([turns, scale]) => [
        turns,
        scale.seed,
      ])),
      latencyBudgets: Object.fromEntries(Object.entries(FORMAL_SCALES).map(([turns, scale]) => [
        turns,
        {
          name: scale.budget,
          p95LimitMs: scale.p95LimitMs,
          p99LimitMs: scale.p99LimitMs,
        },
      ])),
    },
    engineIdentity: evidence[25_000].engineIdentity,
    engineBuildProvenance: ITEM6_ENGINE_BUILD_PROVENANCE,
    sourceReports: {
      [FORMAL_SCALES[25_000].name]: raw25k.identity,
      [FORMAL_SCALES[250_000].name]: raw250k.identity,
    },
    artifacts,
    privacy: {
      aggregateOnly: true,
      rawReportsIncluded: false,
      rawSessionsIncluded: false,
      temporaryDatabasesIncluded: false,
      sourcePathsIncluded: false,
      sessionIdentifiersIncluded: false,
    },
  };
  assertAggregateArtifactPrivacy(manifest, "Dashboard evidence manifest");

  const parent = path.dirname(outputDirectory);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, ".item6-overview-evidence-"));
  let installed = false;
  try {
    await chmod(temporary, 0o700);
    for (const name of ITEM6_OVERVIEW_REPORTS) {
      await writeFile(path.join(temporary, name), reportBytes[name], { mode: 0o600 });
    }
    await writeFile(
      path.join(temporary, "manifest.json"),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { mode: 0o600 },
    );
    await rename(temporary, outputDirectory);
    installed = true;
  } finally {
    if (!installed) await rm(temporary, { recursive: true, force: true });
  }
  return manifest;
}

function parseArguments(argv) {
  const values = { epicPath: DEFAULT_EPIC };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    const key = {
      "--report-25k": "report25kPath",
      "--report-250k": "report250kPath",
      "--output-dir": "outputDirectory",
      "--engine": "enginePath",
      "--epic": "epicPath",
    }[argument];
    if (key === undefined) fail(`unknown argument ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    values[key] = path.resolve(value);
  }
  return values;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(
      "Usage: package-insights-dashboard-evidence.mjs --report-25k FILE --report-250k FILE --output-dir DIR --engine FILE [--epic FILE]\n",
    );
    return;
  }
  for (const name of ["report25kPath", "report250kPath", "outputDirectory", "enginePath"]) {
    if (!options[name]) fail(`${name} is required`);
  }
  const manifest = await packageDashboardOverviewEvidence(options);
  process.stdout.write(`${JSON.stringify({
    format: manifest.format,
    sourceRevision: manifest.sourceRevision,
  })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(
      `package-insights-dashboard-evidence: ${error instanceof Error ? error.message : String(error)}\n`,
    );
    process.exitCode = 1;
  });
}
