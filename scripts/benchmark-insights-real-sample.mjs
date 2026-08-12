#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { constants } from "node:fs";
import { createReadStream } from "node:fs";
import {
  chmod,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import {
  arch,
  cpus,
  platform as osPlatform,
  release as osRelease,
  tmpdir,
  totalmem,
} from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import { reconcileInsights } from "../src/insights-command.mjs";
import { loadInsightsConfig, saveInsightsConfig } from "../src/insights-config.mjs";
import { createInsightsEngineClient } from "../src/insights-engine-client.mjs";
import { resolveInsightsPaths } from "../src/insights-paths.mjs";
import { discoverProviderEvidenceSources } from "../src/provider-evidence.mjs";
import { canonicalJson, hashKey } from "../src/session-facts.mjs";
import { INSIGHTS_ENGINE_TARGETS } from "../src/insights-engine-targets.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const EPIC_PATH = path.join(
  REPOSITORY_ROOT,
  ".codestable",
  "epics",
  "local-session-insights.md",
);
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
const REPORT_FORMAT = "threadshare-insights-real-sample-benchmark@v1";
const SAMPLE_FRACTION = 0.30;
const DEFAULT_SEED = "threadshare-insights-real-sample-v1";
const DETAIL_FULL_FTS_LIMIT_BYTES = 400 * 1024 * 1024;
const MINIMUM_ACCEPTANCE_BYTE_FRACTION = 0.25;
const MAXIMUM_ACCEPTANCE_BYTE_FRACTION = 0.35;
const LONG_TERM_TURN_COUNT = 250_000;
const BUNDLED_SQLITE_VERSION = "3.53.2";
const VERSION_FORMAT = "threadshare-insights-engine-version@v1";
const DEEP_STORAGE_AMPLIFICATION_LIMIT = 1.8;
const DEEP_FTS_AMPLIFICATION_LIMIT = 0.7;
const SIZE_STRATA = Object.freeze([
  Object.freeze({ name: "under-64-kib", minimum: 0, maximum: 64 * 1024 }),
  Object.freeze({ name: "64-kib-to-1-mib", minimum: 64 * 1024, maximum: 1024 * 1024 }),
  Object.freeze({ name: "1-mib-to-16-mib", minimum: 1024 * 1024, maximum: 16 * 1024 * 1024 }),
  Object.freeze({ name: "16-mib-and-over", minimum: 16 * 1024 * 1024, maximum: Infinity }),
]);

function fail(message, code = "TS_INSIGHTS_REAL_SAMPLE_INVALID") {
  const error = new Error(message);
  error.code = code;
  throw error;
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function hashFile(file) {
  return sha256(await readFile(file));
}

async function hashFileStreaming(file) {
  const digest = createHash("sha256");
  for await (const chunk of createReadStream(file)) digest.update(chunk);
  return digest.digest("hex");
}

export function assertAllowedEngineIdentity(identity, releaseVersion = "0.6.1") {
  const keys = Object.keys(identity ?? {}).sort();
  const expected = [
    "buildManifestDigest",
    "engineVersion",
    "format",
    "protocolVersion",
    "sqliteCompileOptionsDigest",
    "sqliteVersion",
    "target",
  ].sort();
  if (keys.length !== expected.length || keys.some((key, index) => key !== expected[index])) {
    fail("Engine version document has an unexpected shape");
  }
  const releaseTargets = new Set(INSIGHTS_ENGINE_TARGETS.map(({ target }) => target));
  const development = identity.engineVersion === "0.0.0" && identity.target === "development";
  const release = identity.engineVersion === releaseVersion && releaseTargets.has(identity.target);
  if (
    identity.format !== VERSION_FORMAT || identity.protocolVersion !== 1 ||
    identity.sqliteVersion !== BUNDLED_SQLITE_VERSION || (!development && !release) ||
    !/^[0-9a-f]{64}$/u.test(identity.buildManifestDigest) ||
    !/^[0-9a-f]{64}$/u.test(identity.sqliteCompileOptionsDigest)
  ) {
    fail("Engine version document is outside the frozen ITEM-5 allowlist");
  }
  return identity;
}

function safeNumber(value, label) {
  const number = typeof value === "bigint" ? Number(value) : Number(value);
  if (!Number.isSafeInteger(number) || number < 0) fail(`${label} is outside the safe integer range`);
  return number;
}

function sum(values) {
  return values.reduce((total, value) => total + value, 0);
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function latencySummary(values) {
  return Object.freeze({
    unit: "ms",
    count: values.length,
    total: values.reduce((total, value) => total + value, 0),
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.length === 0 ? null : Math.max(...values),
  });
}

function sqliteObjectOwner(name) {
  return /^sqlite_autoindex_(.+)_[0-9]+$/u.exec(name)?.[1] ?? name;
}

function storageBytes(pageRows, predicate) {
  return sum(pageRows
    .filter((row) => predicate(String(row.name), sqliteObjectOwner(String(row.name))))
    .map((row) => Number(row.bytes)));
}

function sourceToken(seed, source) {
  return sha256([
    "threadshare-real-sample-source-v1",
    seed,
    source.provider,
    source.sessionId.toLowerCase(),
    String(source.bytes),
  ].join("\0"));
}

export function realSampleSizeStratum(bytes) {
  if (!Number.isSafeInteger(bytes) || bytes < 0) fail("source bytes must be a non-negative integer");
  return SIZE_STRATA.find(({ minimum, maximum }) => bytes >= minimum && bytes < maximum)?.name;
}

export function projectedDetailFullFtsBytes(detailFullBytes, documents, turns = LONG_TERM_TURN_COUNT) {
  if (!Number.isSafeInteger(detailFullBytes) || detailFullBytes < 0) {
    fail("detail-full FTS bytes must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(documents) || documents < 1) {
    fail("detail-full FTS projection requires at least one document");
  }
  if (!Number.isSafeInteger(turns) || turns < 1) {
    fail("detail-full FTS projection target must be a positive safe integer");
  }
  return Math.ceil((detailFullBytes * turns) / documents);
}

function digestTokens(label, tokens) {
  return sha256(`${label}\0${[...tokens].sort().join("\0")}`);
}

export function evaluateRealSampleByteFraction(byteFraction) {
  if (!Number.isFinite(byteFraction) || byteFraction < 0 || byteFraction > 1) {
    fail("sample byte fraction must be between 0 and 1");
  }
  return Object.freeze({
    target: SAMPLE_FRACTION,
    minimum: MINIMUM_ACCEPTANCE_BYTE_FRACTION,
    maximum: MAXIMUM_ACCEPTANCE_BYTE_FRACTION,
    withinAcceptanceRange:
      byteFraction >= MINIMUM_ACCEPTANCE_BYTE_FRACTION &&
      byteFraction <= MAXIMUM_ACCEPTANCE_BYTE_FRACTION,
  });
}

function selectClosestBytePrefix(group, fraction) {
  const populationBytes = sum(group.map(({ bytes }) => bytes));
  const targetBytes = populationBytes * fraction;
  let cumulativeBytes = 0;
  let selectedFiles = group.length;
  let undershootBytes = populationBytes;
  let overshootBytes = populationBytes;
  let decision = "all-files";
  for (let index = 0; index < group.length; index += 1) {
    const before = cumulativeBytes;
    cumulativeBytes += group[index].bytes;
    if (cumulativeBytes < targetBytes) continue;
    undershootBytes = before;
    overshootBytes = cumulativeBytes;
    if (index === 0) {
      selectedFiles = 1;
      decision = "at-least-one";
    } else if (cumulativeBytes === targetBytes) {
      selectedFiles = index + 1;
      decision = "exact";
    } else {
      const undershootError = targetBytes - before;
      const overshootError = cumulativeBytes - targetBytes;
      if (undershootError <= overshootError) {
        selectedFiles = index;
        decision = undershootError === overshootError ? "undershoot-tie" : "undershoot";
      } else {
        selectedFiles = index + 1;
        decision = "overshoot";
      }
    }
    break;
  }
  selectedFiles = Math.max(1, selectedFiles);
  const selectedBytes = sum(group.slice(0, selectedFiles).map(({ bytes }) => bytes));
  return Object.freeze({
    selectedFiles,
    selectedBytes,
    populationBytes,
    targetBytes,
    undershootBytes,
    overshootBytes,
    boundaryFileBytes: overshootBytes - undershootBytes,
    absoluteErrorBytes: Math.abs(selectedBytes - targetBytes),
    decision,
  });
}

export function selectStratifiedRealSample(candidates, options = {}) {
  if (!Array.isArray(candidates)) fail("candidates must be an array");
  const fraction = options.fraction ?? SAMPLE_FRACTION;
  const seed = options.seed ?? DEFAULT_SEED;
  if (!(fraction > 0 && fraction <= 1)) fail("sample fraction must be in (0,1]");
  if (typeof seed !== "string" || seed.length === 0) fail("sample seed must be non-empty");

  const groups = new Map();
  const normalized = candidates.map((source) => {
    if (
      !source ||
      !["codex", "claude"].includes(source.provider) ||
      typeof source.sessionId !== "string" ||
      source.sessionId.length === 0 ||
      typeof source.file !== "string" ||
      source.file.length === 0
    ) {
      fail("sample candidates must contain provider, sessionId, file, and bytes");
    }
    const bytes = safeNumber(source.bytes, "source bytes");
    const stratum = realSampleSizeStratum(bytes);
    const token = sourceToken(seed, { ...source, bytes });
    const item = Object.freeze({ ...source, bytes, stratum, token });
    const key = `${source.provider}\0${stratum}`;
    const group = groups.get(key) ?? [];
    group.push(item);
    groups.set(key, group);
    return item;
  });

  const selected = [];
  const strata = [];
  for (const key of [...groups.keys()].sort()) {
    const group = groups.get(key).sort((left, right) =>
      left.token.localeCompare(right.token) || left.sessionId.localeCompare(right.sessionId));
    const byteSelection = selectClosestBytePrefix(group, fraction);
    const chosen = group.slice(0, byteSelection.selectedFiles);
    selected.push(...chosen);
    strata.push(Object.freeze({
      provider: chosen[0].provider,
      sizeStratum: chosen[0].stratum,
      populationFiles: group.length,
      populationBytes: byteSelection.populationBytes,
      selectedFiles: chosen.length,
      selectedBytes: byteSelection.selectedBytes,
      fileFraction: chosen.length / group.length,
      byteFraction: byteSelection.populationBytes === 0
        ? 0
        : byteSelection.selectedBytes / byteSelection.populationBytes,
      targetBytes: byteSelection.targetBytes,
      undershootBytes: byteSelection.undershootBytes,
      overshootBytes: byteSelection.overshootBytes,
      boundaryFileBytes: byteSelection.boundaryFileBytes,
      absoluteErrorBytes: byteSelection.absoluteErrorBytes,
      decision: byteSelection.decision,
    }));
  }
  selected.sort((left, right) => left.token.localeCompare(right.token));
  return Object.freeze({
    fraction,
    seed,
    populationFiles: normalized.length,
    populationBytes: sum(normalized.map(({ bytes }) => bytes)),
    selectedFiles: selected.length,
    selectedBytes: sum(selected.map(({ bytes }) => bytes)),
    populationDigest: digestTokens("population-v1", normalized.map(({ token }) => token)),
    selectionDigest: digestTokens("selection-v1", selected.map(({ token }) => token)),
    strata: Object.freeze(strata),
    selected: Object.freeze(selected),
  });
}

export async function mapLimitSettled(values, limit, operation) {
  const results = new Array(values.length);
  let cursor = 0;
  let firstError;
  const workers = Array.from({ length: Math.min(limit, values.length) }, async () => {
    while (firstError === undefined && cursor < values.length) {
      const index = cursor;
      cursor += 1;
      try {
        results[index] = await operation(values[index], index);
      } catch (error) {
        if (firstError === undefined) firstError = error;
      }
    }
  });
  await Promise.all(workers);
  if (firstError !== undefined) throw firstError;
  return results;
}

function aggregateCodes(items) {
  const counts = new Map();
  for (const item of items ?? []) {
    const code = typeof item?.code === "string" && /^[a-z0-9][a-z0-9-]{0,63}$/u.test(item.code)
      ? item.code
      : "other";
    const count = Number.isSafeInteger(item?.count) && item.count > 0 ? item.count : 1;
    counts.set(code, (counts.get(code) ?? 0) + count);
  }
  return [...counts].sort(([left], [right]) => left.localeCompare(right))
    .map(([code, count]) => Object.freeze({ code, count }));
}

async function discoverInventory(sourceEnvironment) {
  const sourcePaths = resolveInsightsPaths({ environment: sourceEnvironment });
  const [config, ...discoveries] = await Promise.all([
    loadInsightsConfig({ paths: sourcePaths }),
    ...["codex", "claude"].map((provider) =>
      discoverProviderEvidenceSources(provider, { environment: sourceEnvironment })),
  ]);
  const excludedProviders = new Set(config.insights.excludeProviders);
  const excludedSessions = new Set(config.insights.excludeSessions.map((value) => value.toLowerCase()));
  const discovered = discoveries.flatMap(({ sources }) => sources);
  const inventory = await mapLimitSettled(discovered, 64, async (source) => {
    const metadata = await stat(source.file, { bigint: true });
    if (!metadata.isFile()) fail("a discovered session source is not a regular file");
    return Object.freeze({
      ...source,
      bytes: safeNumber(metadata.size, "source size"),
      metadata: Object.freeze({
        dev: metadata.dev,
        ino: metadata.ino,
        size: metadata.size,
        mtimeNs: metadata.mtimeNs,
      }),
    });
  });
  const candidates = [];
  const excluded = [];
  for (const source of inventory) {
    if (excludedProviders.has(source.provider) || excludedSessions.has(source.sessionId.toLowerCase())) {
      excluded.push(source);
    } else {
      candidates.push(source);
    }
  }
  return Object.freeze({
    config,
    candidates: Object.freeze(candidates),
    summary: Object.freeze({
      canonicalDiscoveredFiles: inventory.length,
      canonicalDiscoveredBytes: sum(inventory.map(({ bytes }) => bytes)),
      excludedBeforeSamplingFiles: excluded.length,
      excludedBeforeSamplingBytes: sum(excluded.map(({ bytes }) => bytes)),
      configuredExclusionCounts: Object.freeze({
        providers: config.insights.excludeProviders.length,
        projects: config.insights.excludeProjects.length,
        sessions: config.insights.excludeSessions.length,
      }),
      diagnostics: Object.freeze(aggregateCodes(
        discoveries.flatMap(({ diagnostics }) => diagnostics),
      )),
    }),
  });
}

function sameSnapshot(left, right) {
  return left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs;
}

async function snapshotCopy(source, target) {
  const before = await stat(source.file, { bigint: true });
  if (!sameSnapshot(before, source.metadata)) {
    fail("a selected session changed before snapshot materialization", "TS_INSIGHTS_REAL_SAMPLE_SOURCE_CHANGED");
  }
  let method = "clone";
  try {
    await copyFile(source.file, target, constants.COPYFILE_FICLONE_FORCE);
  } catch (error) {
    if (!["ENOSYS", "ENOTSUP", "EINVAL", "EXDEV", "EPERM"].includes(error?.code)) throw error;
    method = "copy";
    await copyFile(source.file, target);
  }
  await chmod(target, 0o600);
  const [after, copied] = await Promise.all([
    stat(source.file, { bigint: true }),
    stat(target, { bigint: true }),
  ]);
  if (!sameSnapshot(before, after) || copied.size !== before.size) {
    fail("a selected session changed during snapshot materialization", "TS_INSIGHTS_REAL_SAMPLE_SOURCE_CHANGED");
  }
  return { method, sha256: await hashFileStreaming(target), bytes: Number(copied.size) };
}

function benchmarkPaths(directory) {
  const stateDirectory = path.join(directory, "state");
  return Object.freeze({
    stateDirectory,
    configFile: path.join(directory, "config", "config.json"),
    databaseFile: path.join(stateDirectory, "insights.sqlite3"),
    originSecretFile: path.join(stateDirectory, "origin-secret.json"),
    lockFile: path.join(stateDirectory, "insights.lock"),
    tempDirectory: path.join(stateDirectory, "tmp"),
  });
}

async function materializeSample(directory, selection) {
  const providerHome = path.join(directory, "provider-home");
  const codexHome = path.join(providerHome, "codex");
  const codexRoot = path.join(codexHome, "sessions");
  const claudeRoot = path.join(providerHome, ".claude", "projects", "sample");
  await Promise.all([
    mkdir(codexRoot, { recursive: true, mode: 0o700 }),
    mkdir(claudeRoot, { recursive: true, mode: 0o700 }),
  ]);
  const methods = { clone: 0, copy: 0 };
  const copied = await mapLimitSettled(selection.selected, 8, async (source) => {
    const directoryForSource = source.provider === "codex"
      ? path.join(codexRoot, source.stratum)
      : path.join(claudeRoot, source.stratum);
    await mkdir(directoryForSource, { recursive: true, mode: 0o700 });
    const basename = source.provider === "codex"
      ? `rollout-sample-${source.sessionId.toLowerCase()}.jsonl`
      : `${source.sessionId.toLowerCase()}.jsonl`;
    const snapshot = await snapshotCopy(source, path.join(directoryForSource, basename));
    methods[snapshot.method] += 1;
    return { token: source.token, ...snapshot };
  });
  const contentDigest = createHash("sha256");
  contentDigest.update("threadshare-selected-snapshot-content-v1\0");
  for (const item of copied.sort((left, right) => left.token.localeCompare(right.token))) {
    contentDigest.update(`${item.token}\0${item.bytes}\0${item.sha256}\0`);
  }
  return Object.freeze({
    environment: Object.freeze({ HOME: providerHome, CODEX_HOME: codexHome }),
    methods: Object.freeze(methods),
    selectedSnapshotContentDigest: contentDigest.digest("hex"),
  });
}

async function databaseFootprint(databasePath) {
  let bytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes += safeNumber((await stat(`${databasePath}${suffix}`, { bigint: true })).size, "database bytes");
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return bytes;
}

function u64(value) {
  const bytes = Buffer.from(value);
  if (bytes.length !== 8) fail("database uint64 value has an invalid width");
  return bytes.readBigUInt64BE();
}

function summedU64Rows(rows, field) {
  return rows.reduce((total, row) => total + u64(row[field]), 0n).toString();
}

function fixedGroupCounts(rows, names, key = "name") {
  const counts = new Map(rows.map((row) => [String(row[key]), Number(row.count)]));
  return Object.fromEntries(names.map((name) => [name, counts.get(name) ?? 0]));
}

function isDetailFullFtsObject(name) {
  const owner = /^sqlite_autoindex_(.+)_[0-9]+$/u.exec(name)?.[1] ?? name;
  return owner === "turns_fts" || owner.startsWith("turns_fts_") || [
    "turn_fts_documents",
    "field_stats",
    "fts_analyzer_identity",
    "turn_analyzer_diagnostics",
  ].includes(owner);
}

function dedupeAggregate(database, provider = null) {
  const providerFilter = provider === null ? "" : " AND provider=?";
  const bindings = provider === null ? [] : [provider];
  const rawSessions = Number(database.prepare(
    `SELECT COUNT(*) AS value FROM sessions WHERE 1=1${providerFilter}`,
  ).get(...bindings).value);
  const row = database.prepare(`
    WITH eligible AS (
      SELECT session_id,duplicate_group_key,duplicate_confidence,
             dedupe_corroboration_fingerprint,dedupe_closure
        FROM sessions
       WHERE session_scope='main' AND eligibility='eligible'${providerFilter}
    ), strong_groups AS (
      SELECT duplicate_group_key FROM eligible
       WHERE duplicate_group_key IS NOT NULL AND duplicate_confidence='strong'
      UNION
      SELECT duplicate_group_key FROM eligible
       WHERE duplicate_group_key IS NOT NULL
         AND dedupe_corroboration_fingerprint IS NOT NULL
       GROUP BY duplicate_group_key,dedupe_corroboration_fingerprint
      HAVING COUNT(DISTINCT session_id)>=2
    ), independent_groups AS (
      SELECT DISTINCT duplicate_group_key FROM eligible WHERE duplicate_group_key IS NOT NULL
    )
    SELECT
      (SELECT COUNT(*) FROM eligible) AS eligibleMainSessions,
      (SELECT COUNT(*) FROM eligible WHERE duplicate_group_key IS NULL) AS unknownSessions,
      (SELECT COUNT(*) FROM independent_groups) AS independentGroups,
      (SELECT COUNT(*) FROM strong_groups) AS strongGroups,
      (SELECT COUNT(DISTINCT duplicate_group_key) FROM eligible
        WHERE duplicate_group_key IS NOT NULL AND dedupe_closure='observed-eof') AS provisionalGroups
  `).get(...bindings);
  const independentGroups = Number(row.independentGroups);
  const strongGroups = Number(row.strongGroups);
  return Object.freeze({
    rawSessions,
    eligibleMainSessions: Number(row.eligibleMainSessions),
    independentGroups,
    strongGroups,
    weakGroups: independentGroups - strongGroups,
    observedEofProvisionalGroups: Number(row.provisionalGroups),
    unknownSessions: Number(row.unknownSessions),
  });
}

function dedupeAggregates(database) {
  const overall = dedupeAggregate(database);
  return Object.freeze({
    definitions:
      "strong uses explicit lineage or two eligible main sessions sharing one non-null corroboration fingerprint; provisional is an overlapping closure axis",
    overall,
    byProvider: Object.freeze(Object.fromEntries(
      ["claude", "codex"].map((provider) => [provider, dedupeAggregate(database, provider)]),
    )),
  });
}

async function auditDatabase(databasePath) {
  const preMaintenanceBytes = await databaseFootprint(databasePath);
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath);
  let result;
  try {
    const maintenanceStarted = performance.now();
    database.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
    const maintenanceMs = performance.now() - maintenanceStarted;
    const scalar = (sql) => Number(database.prepare(sql).get().value);
    const pageRows = database.prepare(
      "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY name",
    ).all();
    const dbstatBytes = sum(pageRows.map((row) => Number(row.bytes)));
    const detailFullBytes = sum(pageRows
      .filter((row) => isDetailFullFtsObject(String(row.name)))
      .map((row) => Number(row.bytes)));
    const historyEventMetadataBytes = storageBytes(pageRows, (name, owner) =>
      owner === "history_events" || owner === "attempt_chain_events" ||
      owner === "file_activity" || owner === "token_usage" ||
      owner === "error_occurrences" || name.startsWith("history_events_") ||
      name.startsWith("attempt_chain_events_") || name.startsWith("file_activity_") ||
      name.startsWith("token_usage_") || name.startsWith("error_occurrences_"));
    const historyPayloadBytes = storageBytes(pageRows, (name, owner) =>
      owner === "history_payloads" || owner === "history_payload_chunks" ||
      name === "history_payloads_event");
    const historyFtsBytes = storageBytes(pageRows, (name, owner) =>
      owner === "history_event_fts_documents" || owner === "history_event_fts" ||
      name.startsWith("history_event_fts_"));
    const historyProjectionBytes = storageBytes(pageRows, (name, owner) =>
      owner === "history_coverage_rollups" || owner === "history_event_coverage" ||
      owner === "history_event_kind_rollups" || owner === "history_activity_rollups" ||
      owner === "history_token_rollups" || owner === "history_query_session_coverage" ||
      owner === "history_capability_rollups" ||
      owner === "history_capability_representatives" ||
      owner === "history_capability_cooccurrences" ||
      name.startsWith("history_event_coverage_") ||
      name.startsWith("history_event_kind_rollups_") ||
      name.startsWith("history_activity_rollups_") ||
      name.startsWith("history_token_rollups_") ||
      name.startsWith("history_capability_rollups_") ||
      name.startsWith("history_capability_representatives_") ||
      name.startsWith("history_capability_cooccurrences_"));
    const ftsByField = database.prepare(
      `SELECT col AS field, COUNT(*) AS fieldTerms, COALESCE(SUM(doc),0) AS postings,
            COALESCE(SUM(cnt),0) AS occurrences
       FROM turns_fts_vocab GROUP BY col ORDER BY col`,
    ).all().map((row) => Object.freeze({
      field: String(row.field),
      fieldTerms: Number(row.fieldTerms),
      postings: Number(row.postings),
      occurrences: Number(row.occurrences),
    }));
    const analyzer = database.prepare(
      `SELECT projection_name AS projectionName, projection_version AS projectionVersion,
            analyzer_version AS analyzerVersion, analyzer_capability AS analyzerCapability,
            codec_version AS codecVersion
       FROM fts_analyzer_identity WHERE singleton=1`,
    ).get();
    const ftsSchema = String(database.prepare(
      "SELECT sql AS value FROM sqlite_schema WHERE type='table' AND name='turns_fts'",
    ).get()?.value ?? "");
    const ftsDetail = /(?:^|[,\s])detail\s*=\s*full(?:[,\s)]|$)/iu.test(ftsSchema)
      ? "full"
      : "unexpected";
    const analyzerCaps = database.prepare(
      `SELECT COUNT(*) AS documents,
            COALESCE(SUM(token_truncated),0) AS tokenTruncated,
            COALESCE(SUM(distinct_truncated),0) AS distinctTruncated,
            COALESCE(SUM(capability_truncated),0) AS capabilityTruncated,
            COALESCE(SUM(input_token_count),0) AS inputTokens,
            COALESCE(SUM(token_count),0) AS retainedTokens,
            COALESCE(SUM(input_distinct_field_term_count),0) AS inputDistinctFieldTerms,
            COALESCE(SUM(distinct_field_term_count),0) AS retainedDistinctFieldTerms
       FROM turn_analyzer_diagnostics`,
    ).get();
    const sessionGroups = database.prepare(
      `SELECT session_scope AS scope, eligibility, COUNT(*) AS count
         FROM sessions GROUP BY scope,eligibility`,
    ).all().map((row) => Object.freeze({
      scope: String(row.scope),
      eligibility: String(row.eligibility),
      count: Number(row.count),
    }));
    const turnVisibility = database.prepare(
      `SELECT effective_provider_visibility AS name, COUNT(*) AS count
         FROM turns GROUP BY name`,
    ).all();
    const sourceSizes = database.prepare("SELECT source_size AS value FROM source_checkpoints").all();
    const committedSessionKeys = new Set(database.prepare(
      "SELECT lower(hex(session_key)) AS value FROM sessions",
    ).all().map(({ value }) => String(value)));
    const factDiagnostics = database.prepare(
      "SELECT diagnostic_count AS count FROM fact_diagnostics",
    ).all();
    const factCoverage = database.prepare(
      "SELECT coverage_count AS count FROM fact_coverage",
    ).all();
    const pageCount = Number(database.prepare("PRAGMA page_count").get().page_count);
    const pageSize = Number(database.prepare("PRAGMA page_size").get().page_size);
    const integrity = database.prepare("PRAGMA integrity_check").all()
      .map((row) => String(row.integrity_check));
    database.exec("INSERT INTO turns_fts(turns_fts) VALUES('integrity-check')");
    const ftsIntegrity = "ok";
    database.exec(
      "INSERT INTO history_event_fts(history_event_fts) VALUES('integrity-check')",
    );
    const historyFtsIntegrity = "ok";
    const historyCoverage = database.prepare(
      `SELECT COALESCE(SUM(fts_searchable_payload_bytes),0) AS searchablePayloadBytes,
              COALESCE(SUM(fts_stored_not_searchable_payload_bytes),0)
                AS storedNotSearchablePayloadBytes,
              COALESCE(SUM(fts_searchable_event_count),0) AS searchableEventCount,
              COALESCE(SUM(fts_stored_not_searchable_event_count),0)
                AS storedNotSearchableEventCount
         FROM history_coverage_rollups`,
    ).get();
    const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
    const sqliteVersion = String(database.prepare("SELECT sqlite_version() AS value").get().value);
    result = {
      sqliteVersion,
      maintenanceMs,
      preMaintenanceBytes,
      databasePageBytes: pageCount * pageSize,
      dbstatBytes,
      detailFullFtsBytes: detailFullBytes,
      deepQueryV2: {
        rows: {
          historyEvents: scalar("SELECT COUNT(*) AS value FROM history_events"),
          historyPayloads: scalar("SELECT COUNT(*) AS value FROM history_payloads"),
          historyPayloadChunks: scalar("SELECT COUNT(*) AS value FROM history_payload_chunks"),
          attemptChainEvents: scalar("SELECT COUNT(*) AS value FROM attempt_chain_events"),
          fileActivity: scalar("SELECT COUNT(*) AS value FROM file_activity"),
          tokenUsage: scalar("SELECT COUNT(*) AS value FROM token_usage"),
          errorOccurrences: scalar("SELECT COUNT(*) AS value FROM error_occurrences"),
          historyFtsDocuments: scalar(
            "SELECT COUNT(*) AS value FROM history_event_fts_documents",
          ),
        },
        storage: {
          historyEventMetadataBytes,
          historyPayloadBytes,
          historyFtsBytes,
          historyProjectionBytes,
          searchablePayloadBytes: Number(historyCoverage.searchablePayloadBytes),
          storedNotSearchablePayloadBytes:
            Number(historyCoverage.storedNotSearchablePayloadBytes),
        },
        coverage: {
          searchableEventCount: Number(historyCoverage.searchableEventCount),
          storedNotSearchableEventCount:
            Number(historyCoverage.storedNotSearchableEventCount),
        },
        historyFtsIntegrity,
      },
      facts: {
        sessions: scalar("SELECT COUNT(*) AS value FROM sessions"),
        sessionGroups,
        turns: scalar("SELECT COUNT(*) AS value FROM turns"),
        turnVisibility: fixedGroupCounts(turnVisibility, ["active", "rolled-back"]),
        sourceRecords: scalar("SELECT COUNT(*) AS value FROM source_records"),
        evidenceEvents: scalar("SELECT COUNT(*) AS value FROM evidence_events"),
        capabilities: scalar("SELECT COUNT(*) AS value FROM capabilities"),
        capabilityUses: scalar("SELECT COUNT(*) AS value FROM capability_uses"),
        sourceCheckpoints: sourceSizes.length,
        indexedSourceBytes: summedU64Rows(sourceSizes, "value"),
        committedSessionKeys,
      },
      fts: {
        detail: ftsDetail,
        documents: scalar("SELECT COUNT(*) AS value FROM turn_fts_documents"),
        fieldTerms: sum(ftsByField.map(({ fieldTerms }) => fieldTerms)),
        postings: sum(ftsByField.map(({ postings }) => postings)),
        occurrences: sum(ftsByField.map(({ occurrences }) => occurrences)),
        byField: ftsByField,
        analyzer: analyzer ? { ...analyzer } : null,
      },
      caps: {
        analyzer: Object.fromEntries(
          Object.entries(analyzerCaps).map(([key, value]) => [key, Number(value)]),
        ),
        sessionFactTruncationRows: scalar(
          "SELECT COUNT(*) AS value FROM session_fact_truncation",
        ),
        affectedSessions: scalar(
          "SELECT COUNT(DISTINCT session_id) AS value FROM session_fact_truncation",
        ),
        turnFactTruncationRows: scalar(
          "SELECT COUNT(*) AS value FROM turn_fact_truncation",
        ),
        affectedTurns: scalar(
          "SELECT COUNT(DISTINCT turn_id) AS value FROM turn_fact_truncation",
        ),
      },
      diagnostics: {
        factDiagnosticRows: factDiagnostics.length,
        factDiagnosticOccurrences: summedU64Rows(factDiagnostics, "count"),
        distinctFactDiagnosticCodes: scalar(
          "SELECT COUNT(DISTINCT code) AS value FROM fact_diagnostics",
        ),
        coverageRows: factCoverage.length,
        coverageOccurrences: summedU64Rows(factCoverage, "count"),
        distinctCoverageKeys: scalar(
          "SELECT COUNT(DISTINCT coverage_key) AS value FROM fact_coverage",
        ),
      },
      dedupe: dedupeAggregates(database),
      integrity,
      ftsIntegrity,
      foreignKeyViolations,
    };
  } finally {
    database.close();
  }
  result.postMaintenanceBytes = await databaseFootprint(databasePath);
  return result;
}

async function gitIdentity() {
  const [{ stdout: revision }, { stdout: statusOutput }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: REPOSITORY_ROOT }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: REPOSITORY_ROOT,
      maxBuffer: 8 * 1024 * 1024,
    }),
  ]);
  return Object.freeze({ revision: revision.trim(), worktreeDirty: statusOutput.length > 0 });
}

async function engineIdentity(binaryPath) {
  const { stdout } = await execFileAsync(binaryPath, ["--version", "--json"], {
    maxBuffer: 1024 * 1024,
  });
  const identity = assertAllowedEngineIdentity(JSON.parse(stdout));
  return Object.freeze({ ...identity, binarySha256: await hashFile(binaryPath) });
}

function environmentSummary() {
  const processors = cpus();
  return Object.freeze({
    platform: osPlatform(),
    release: osRelease(),
    architecture: arch(),
    nodeVersion: process.version,
    cpuModel: processors[0]?.model ?? "unknown",
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
  });
}

function realSamplePaths(directory) {
  return benchmarkPaths(directory);
}

export async function runInsightsRealSampleBenchmark(options = {}) {
  const sourceEnvironment = options.sourceEnvironment ?? process.env;
  const seed = options.seed ?? DEFAULT_SEED;
  const fraction = options.fraction ?? SAMPLE_FRACTION;
  const deepQueryV2 = options.deepQueryV2 === true;
  const binaryPath = path.resolve(options.enginePath ?? process.env.THREADSHARE_INSIGHTS_ENGINE_PATH ?? DEFAULT_ENGINE_PATH);
  if (fraction !== SAMPLE_FRACTION && options.allowNonAcceptanceFraction !== true) {
    fail("acceptance evidence requires the frozen 30% sample fraction");
  }
  const inventory = await discoverInventory(sourceEnvironment);
  const selection = selectStratifiedRealSample(inventory.candidates, { fraction, seed });
  if (selection.selectedFiles === 0) fail("no canonical sessions are available for sampling");

  const parent = options.temporaryParent ?? tmpdir();
  await mkdir(parent, { recursive: true, mode: 0o700 });
  const directory = await mkdtemp(path.join(parent, "threadshare-insights-real-sample-"));
  await chmod(directory, 0o700);
  let report;
  try {
    const paths = realSamplePaths(directory);
    const materialized = await materializeSample(directory, selection);
    await saveInsightsConfig(inventory.config, {
      paths,
      configDirectoryManaged: true,
    });
    const committedDeltas = new Map();
    const commitAckLatencies = [];
    const createMeasuredEngineClient = deepQueryV2
      ? async (clientOptions) => {
        const engine = await createInsightsEngineClient(clientOptions);
        return new Proxy(engine, {
          get(target, property) {
            if (property === "commitSourceDelta") {
              return async (input, commitOptions) => {
                const canonical = canonicalJson(input.delta);
                const started = performance.now();
                const response = await target.commitSourceDelta(input, commitOptions);
                commitAckLatencies.push(performance.now() - started);
                committedDeltas.set(input.delta.deltaId, Buffer.byteLength(canonical, "utf8"));
                return response;
              };
            }
            const value = Reflect.get(target, property, target);
            return typeof value === "function" ? value.bind(target) : value;
          },
        });
      }
      : undefined;
    const started = performance.now();
    const reconciliation = await reconcileInsights({
      paths,
      discoveryOptions: { environment: materialized.environment },
      runtimeOptions: {
        env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: binaryPath },
      },
      configOptions: { configDirectoryManaged: true },
      concurrency: options.concurrency ?? 4,
      timeoutMs: options.timeoutMs ?? 24 * 60 * 60 * 1000,
      ...(createMeasuredEngineClient === undefined
        ? {}
        : { createEngineClient: createMeasuredEngineClient }),
    });
    const indexingWallMs = performance.now() - started;
    const audit = await auditDatabase(paths.databaseFile);
    const [git, engine, scriptSha256, epicSha256] = await Promise.all([
      gitIdentity(),
      engineIdentity(binaryPath),
      hashFile(SCRIPT_PATH),
      hashFile(EPIC_PATH),
    ]);
    const indexedSourceBytes = BigInt(audit.facts.indexedSourceBytes);
    const expectedCommittedBytes = selection.selected.reduce((total, source) => {
      const sessionKey = hashKey("session", source.provider, source.sessionId.toLowerCase());
      return total + (audit.facts.committedSessionKeys.has(sessionKey) ? BigInt(source.bytes) : 0n);
    }, 0n);
    const { committedSessionKeys: _committedSessionKeys, ...safeFacts } = audit.facts;
    const indexComplete =
      reconciliation.report.planned === selection.selectedFiles &&
      reconciliation.report.committed + reconciliation.report.excluded === selection.selectedFiles &&
      reconciliation.report.failed === 0 &&
      audit.facts.sourceCheckpoints === reconciliation.report.committed &&
      indexedSourceBytes === expectedCommittedBytes;
    const projectedFtsBytes = projectedDetailFullFtsBytes(
      audit.detailFullFtsBytes,
      audit.fts.documents,
    );
    const detailFullWithinLimit = projectedFtsBytes < DETAIL_FULL_FTS_LIMIT_BYTES;
    const detailFullSchema = audit.fts.detail === "full";
    const analyzerIdentityMatches =
      Number(audit.fts.analyzer?.projectionVersion) === 2 &&
      audit.fts.analyzer?.analyzerCapability === "mixed-cjk-code@1";
    const fileFraction = selection.selectedFiles / selection.populationFiles;
    const byteFraction = selection.populationBytes === 0
      ? 0
      : selection.selectedBytes / selection.populationBytes;
    const byteFractionGate = evaluateRealSampleByteFraction(byteFraction);
    const storageConsistent = audit.integrity.length === 1 && audit.integrity[0] === "ok" &&
      audit.ftsIntegrity === "ok" && audit.foreignKeyViolations === 0;
    const canonicalIndexedSourceBytes = [...committedDeltas.values()]
      .reduce((total, bytes) => total + bytes, 0);
    const persistentStorageAmplification = deepQueryV2 && canonicalIndexedSourceBytes > 0
      ? audit.postMaintenanceBytes / canonicalIndexedSourceBytes
      : null;
    const historyFtsAmplification = deepQueryV2 &&
      audit.deepQueryV2.storage.searchablePayloadBytes > 0
      ? audit.deepQueryV2.storage.historyFtsBytes /
        audit.deepQueryV2.storage.searchablePayloadBytes
      : null;
    const deepQueryV2Gates = deepQueryV2 ? {
      committedDeltaCoverage:
        committedDeltas.size === reconciliation.report.committed && committedDeltas.size > 0,
      nonemptyHistory:
        audit.deepQueryV2.rows.historyEvents > 0 &&
        audit.deepQueryV2.rows.historyPayloads > 0 &&
        audit.deepQueryV2.rows.historyPayloadChunks > 0,
      historyFtsIntegrityPassed: audit.deepQueryV2.historyFtsIntegrity === "ok",
      persistentStorageAmplificationWithinLimit:
        persistentStorageAmplification !== null &&
        persistentStorageAmplification <= DEEP_STORAGE_AMPLIFICATION_LIMIT,
      historyFtsAmplificationWithinLimit:
        historyFtsAmplification !== null &&
        historyFtsAmplification <= DEEP_FTS_AMPLIFICATION_LIMIT,
    } : null;
    if (deepQueryV2Gates) {
      deepQueryV2Gates.allMeasuredDeepQueryV2GatesPassed =
        Object.values(deepQueryV2Gates).every((value) => value === true);
    }
    const dedupeCountsConsistent = [
      audit.dedupe.overall,
      ...Object.values(audit.dedupe.byProvider),
    ].every((counts) =>
      counts.strongGroups + counts.weakGroups === counts.independentGroups &&
      counts.observedEofProvisionalGroups <= counts.independentGroups);
    report = {
      format: REPORT_FORMAT,
      measuredScope: "item-5-real-provider-session-detail-full-capacity",
      sourceRevision: git.revision,
      sourceWorktreeDirty: git.worktreeDirty,
      hashes: {
        benchmarkScriptSha256: scriptSha256,
        approvedEpicSha256: epicSha256,
        engineBinarySha256: engine.binarySha256,
        populationDigest: selection.populationDigest,
        selectionDigest: selection.selectionDigest,
        selectedSnapshotContentDigest: materialized.selectedSnapshotContentDigest,
      },
      environment: environmentSummary(),
      engine: Object.fromEntries(
        Object.entries(engine).filter(([key]) => key !== "binarySha256"),
      ),
      sampling: {
        strategy: "provider-and-fixed-file-size-strata-seeded-nearest-byte-prefix",
        populationScope:
          "canonical discovered files after provider/session exclusions; project exclusions are applied before commit",
        fraction,
        seed,
        canonicalDiscoveredFiles: inventory.summary.canonicalDiscoveredFiles,
        canonicalDiscoveredBytes: inventory.summary.canonicalDiscoveredBytes,
        excludedBeforeSamplingFiles: inventory.summary.excludedBeforeSamplingFiles,
        excludedBeforeSamplingBytes: inventory.summary.excludedBeforeSamplingBytes,
        configuredExclusionCounts: inventory.summary.configuredExclusionCounts,
        populationFiles: selection.populationFiles,
        populationBytes: selection.populationBytes,
        selectedFiles: selection.selectedFiles,
        selectedBytes: selection.selectedBytes,
        fileFraction,
        byteFraction,
        byteFractionAcceptance: byteFractionGate,
        strata: selection.strata,
      },
      materialization: {
        immutableSnapshots: true,
        copyOnWriteClones: materialized.methods.clone,
        byteCopies: materialized.methods.copy,
      },
      indexing: {
        wallMs: indexingWallMs,
        planned: reconciliation.report.planned,
        committed: reconciliation.report.committed,
        excluded: reconciliation.report.excluded,
        unchanged: reconciliation.report.unchanged,
        missing: reconciliation.report.missing,
        failed: reconciliation.report.failed,
      },
      facts: safeFacts,
      dedupe: audit.dedupe,
      fts: {
        ...audit.fts,
        detailFullBytes: audit.detailFullFtsBytes,
        projectedAt250000TurnsBytes: projectedFtsBytes,
        projectionBasisDocuments: audit.fts.documents,
        projectionMethod: "linear-by-live-turn-document",
        backendReevaluationLimitBytes: DETAIL_FULL_FTS_LIMIT_BYTES,
        backendReevaluationRequired: !detailFullWithinLimit,
      },
      caps: audit.caps,
      diagnostics: {
        populationDiscovery: inventory.summary.diagnostics,
        index: aggregateCodes(reconciliation.report.diagnostics),
        facts: audit.diagnostics,
      },
      storage: {
        sqliteVersion: audit.sqliteVersion,
        preMaintenanceBytes: audit.preMaintenanceBytes,
        postMaintenanceBytes: audit.postMaintenanceBytes,
        maintenanceMs: audit.maintenanceMs,
        databasePageBytes: audit.databasePageBytes,
        dbstatBytes: audit.dbstatBytes,
        integrityCheck: audit.integrity,
        ftsIntegrityCheck: audit.ftsIntegrity,
        foreignKeyViolations: audit.foreignKeyViolations,
      },
      ...(deepQueryV2 ? {
        deepQueryV2: {
          measuredScope: "fact-v2-real-session-capacity-and-commit-ack",
          canonicalIndexedSourceBytes,
          committedDeltaCount: committedDeltas.size,
          syncWallMs: indexingWallMs,
          commitAckMs: latencySummary(commitAckLatencies),
          rows: audit.deepQueryV2.rows,
          storage: {
            ...audit.deepQueryV2.storage,
            persistentBytes: audit.postMaintenanceBytes,
            persistentStorageAmplification,
            historyFtsAmplification,
            limits: {
              persistentStorageAmplification: DEEP_STORAGE_AMPLIFICATION_LIMIT,
              historyFtsAmplification: DEEP_FTS_AMPLIFICATION_LIMIT,
            },
          },
          coverage: audit.deepQueryV2.coverage,
          historyFtsIntegrity: audit.deepQueryV2.historyFtsIntegrity,
          gates: deepQueryV2Gates,
          notMeasured: [
            "fixed-work-budget records, aggregate, Recipe, and Evidence latency; synthetic 25k/250k evidence owns those gates",
            "sidecar RSS; synthetic 25k/250k evidence owns the 128 MiB hard gate",
          ],
        },
      } : {}),
      gates: {
        frozenThirtyPercentFraction: fraction === SAMPLE_FRACTION,
        overallByteFractionWithinRange: byteFractionGate.withinAcceptanceRange,
        indexComplete,
        detailFullSchema,
        analyzerIdentityMatches,
        detailFullFtsWithinLimit: detailFullWithinLimit,
        engineIdentityAllowed: true,
        ftsIntegrityCheckPassed: audit.ftsIntegrity === "ok",
        dedupeCountsConsistent,
        storageConsistent,
        allMeasuredGatesPassed:
          fraction === SAMPLE_FRACTION && byteFractionGate.withinAcceptanceRange &&
          indexComplete && detailFullSchema &&
          analyzerIdentityMatches && detailFullWithinLimit && dedupeCountsConsistent &&
          audit.ftsIntegrity === "ok" && storageConsistent,
      },
      privacy: {
        sourcePathsIncluded: false,
        sessionIdentifiersIncluded: false,
        promptOrAnswerTextIncluded: false,
        rawSessionsIncluded: false,
        temporaryDatabaseIncluded: false,
      },
    };
  } finally {
    await rm(directory, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 });
  }
  return Object.freeze({
    ...report,
    privacy: Object.freeze({ ...report.privacy, temporaryStatePersisted: false }),
  });
}

function parseArguments(argv) {
  const values = {
    execute: false,
    enginePath: process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE_PATH,
    output: null,
    seed: DEFAULT_SEED,
    deepQueryV2: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--execute") {
      values.execute = true;
      continue;
    }
    if (argument === "--deep-query-v2") {
      values.deepQueryV2 = true;
      continue;
    }
    if (!["--engine", "--output", "--seed"].includes(argument)) fail(`unknown argument ${argument}`);
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(`${argument} requires a value`);
    }
    values[argument.slice(2).replace("engine", "enginePath")] = value;
    index += 1;
  }
  return values;
}

function usage() {
  return "Usage: benchmark-insights-real-sample.mjs --execute [--deep-query-v2] [--engine FILE] [--output FILE] [--seed VALUE]";
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (!options.execute) fail("--execute is required because this reads a 30% local session sample");
  const report = await runInsightsRealSampleBenchmark(options);
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output === null) {
    process.stdout.write(serialized);
  } else {
    const output = path.resolve(options.output);
    await mkdir(path.dirname(output), { recursive: true });
    await writeFile(output, serialized, { mode: 0o600 });
  }
  if (!report.gates.allMeasuredGatesPassed) fail("real-session sample benchmark gates failed");
  if (options.deepQueryV2 && !report.deepQueryV2.gates.allMeasuredDeepQueryV2GatesPassed) {
    fail("real-session Fact V2 benchmark gates failed");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    const code = typeof error?.code === "string" ? error.code : "TS_INSIGHTS_REAL_SAMPLE_FAILED";
    process.stderr.write(`benchmark-insights-real-sample: ${code}\n`);
    process.exitCode = 1;
  });
}
