import { lstat, readdir, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { createInsightsEngineClient } from "./insights-engine-client.mjs";
import {
  ACTIVE_INSIGHTS_ANALYZER_CAPABILITIES,
  ACTIVE_INSIGHTS_PROJECTION_VERSIONS,
} from "./insights-engine-protocol.mjs";
import { resolveInsightsPaths } from "./insights-paths.mjs";
import { acquireInsightsWriterLock } from "./insights-writer-lock.mjs";

export const INSIGHTS_STATUS_FORMAT = "threadshare-insights-status@v1";
export const INSIGHTS_RESET_FORMAT = "threadshare-insights-reset@v1";

const MAX_STATUS_ENTRIES = 100_000;
const STATUS_ORIGIN_SECRET_EPOCH = "00000000-0000-4000-8000-000000000000";
const UUID_FRAGMENT = "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";
const RESET_RESIDUE_PATTERNS = Object.freeze([
  new RegExp(`^\\.reindex-${UUID_FRAGMENT}\\.sqlite3(?:-(?:wal|shm)|-journal)?$`, "u"),
  new RegExp(`^\\.reindex-${UUID_FRAGMENT}\\.origin-secret\\.json$`, "u"),
  /^\.reindex-backup\.sqlite3(?:-(?:wal|shm)|-journal)?$/u,
  /^\.reindex-backup\.origin-secret\.json$/u,
  /^\.reindex-swap\.json$/u,
  new RegExp(`^\\.reindex-swap\\.json\\.[0-9]+\\.${UUID_FRAGMENT}\\.tmp$`, "u"),
  new RegExp(`^\\.origin-secret\\.[0-9]+\\.${UUID_FRAGMENT}\\.tmp$`, "u"),
  new RegExp(`^\\.writer-lock\\.[0-9]+\\.${UUID_FRAGMENT}\\.tmp$`, "u"),
]);

const STATUS_ENGINE_CONTRACT = Object.freeze({
  factSchemaVersion: 1,
  providerAdapterVersions: Object.freeze(["claude@1", "codex@1"]),
  privacyPolicyVersion: 1,
  originSecretEpoch: STATUS_ORIGIN_SECRET_EPOCH,
  duplicatePolicyVersion: 1,
  factStorageProfile: "normalized-row-v1",
  storageSchemaVersion: 1,
  projectionVersions: ACTIVE_INSIGHTS_PROJECTION_VERSIONS,
  analyzerCapabilities: ACTIVE_INSIGHTS_ANALYZER_CAPABILITIES,
  rankerVersion: 1,
});

function lifecycleError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function stableEngineDiagnostic(error) {
  if (new Set([
    "TS_INSIGHTS_ENGINE_UNAVAILABLE",
    "TS_INSIGHTS_STORAGE_FAILED",
    "TS_INSIGHTS_STORAGE_CORRUPT",
    "TS_INSIGHTS_WAL_BACKPRESSURE",
  ]).has(error?.code)) return error.code;
  if (new Set([
    "TS_INSIGHTS_ENGINE_DISCONNECTED",
    "TS_INSIGHTS_ENGINE_TIMEOUT",
  ]).has(error?.code)) return "TS_INSIGHTS_ENGINE_UNAVAILABLE";
  return "TS_INSIGHTS_ENGINE_INVALID";
}

async function pathStat(target) {
  try {
    return await lstat(target, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function stateFootprint(root) {
  const initial = await pathStat(root);
  if (initial === null) return { bytes: 0n, entries: 0 };
  if (!initial.isDirectory() || initial.isSymbolicLink()) {
    throw lifecycleError(
      "TS_INSIGHTS_STATE_INVALID",
      "Insights state path is not a private directory",
    );
  }
  let bytes = 0n;
  let entries = 0;
  const pending = [root];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      entries += 1;
      if (entries > MAX_STATUS_ENTRIES) {
        throw lifecycleError(
          "TS_INSIGHTS_STATE_TOO_LARGE",
          "Insights state contains too many filesystem entries to inspect safely",
        );
      }
      const target = path.join(directory, entry.name);
      const stat = await pathStat(target);
      if (stat === null) continue;
      bytes += stat.size;
      if (stat.isDirectory() && !stat.isSymbolicLink()) pending.push(target);
    }
  }
  return { bytes, entries };
}

function isWithin(parent, candidate) {
  const relative = path.relative(parent, candidate);
  return relative !== "" && relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative);
}

function assertSafeResetTarget(paths, options) {
  const stateDirectory = path.resolve(paths.stateDirectory);
  const root = path.parse(stateDirectory).root;
  const homeDirectory = path.resolve(options.homeDirectory ?? os.homedir());
  if (stateDirectory === root || stateDirectory === homeDirectory) {
    throw lifecycleError(
      "TS_INSIGHTS_RESET_TARGET_UNSAFE",
      "Insights reset target is too broad",
    );
  }
  for (const required of [paths.databaseFile, paths.originSecretFile, paths.lockFile, paths.tempDirectory]) {
    if (!isWithin(stateDirectory, path.resolve(required))) {
      throw lifecycleError(
        "TS_INSIGHTS_RESET_TARGET_UNSAFE",
        "Insights reset paths do not belong to one state directory",
      );
    }
  }
  if (path.resolve(paths.configFile) === stateDirectory || isWithin(stateDirectory, path.resolve(paths.configFile))) {
    throw lifecycleError(
      "TS_INSIGHTS_CONFIG_INSIDE_STATE",
      "Persistent Insights config must not be stored inside derived state",
    );
  }
  return stateDirectory;
}

async function removeDerivedInsightsState(paths, stateDirectory) {
  const database = path.resolve(paths.databaseFile);
  const targets = new Set([
    database,
    `${database}-wal`,
    `${database}-shm`,
    `${database}-journal`,
    path.resolve(paths.originSecretFile),
    path.resolve(paths.tempDirectory),
  ]);
  for (const entry of await readdir(stateDirectory, { withFileTypes: true })) {
    if (RESET_RESIDUE_PATTERNS.some((pattern) => pattern.test(entry.name))) {
      targets.add(path.join(stateDirectory, entry.name));
    }
  }
  let removed = 0;
  for (const target of targets) {
    if (await pathStat(target) === null) continue;
    await rm(target, {
      recursive: true,
      force: true,
      maxRetries: 3,
      retryDelay: 50,
    });
    removed += 1;
  }
  return removed;
}

export async function inspectInsightsState(options = {}) {
  const paths = options.paths ?? resolveInsightsPaths(options);
  const [footprint, database, originSecret, reindexManifest] = await Promise.all([
    stateFootprint(paths.stateDirectory),
    pathStat(paths.databaseFile),
    pathStat(paths.originSecretFile),
    pathStat(path.join(paths.stateDirectory, ".reindex-swap.json")),
  ]);
  const databasePresent = database?.isFile() === true;
  const originSecretPresent = originSecret?.isFile() === true;
  let state = "empty";
  let engineStatus;
  const diagnostics = [];
  if (reindexManifest !== null) {
    diagnostics.push("TS_INSIGHTS_REINDEX_RECOVERY_REQUIRED");
  }
  if (databasePresent && originSecretPresent && options.includeEngineStatus !== false) {
    try {
      const createEngineClient = options.createEngineClient ?? createInsightsEngineClient;
      const engine = await createEngineClient({
        databasePath: paths.databaseFile,
        requiredContract: STATUS_ENGINE_CONTRACT,
        runtimeOptions: options.runtimeOptions,
        childEnv: options.childEnv,
        timeoutMs: options.timeoutMs,
        closeTimeoutMs: options.closeTimeoutMs,
      });
      try {
        engineStatus = await engine.readEngineStatus({ signal: options.signal });
      } finally {
        await engine.close();
      }
      state = "ready";
    } catch (error) {
      const diagnostic = stableEngineDiagnostic(error);
      diagnostics.push(diagnostic);
      state = diagnostic === "TS_INSIGHTS_STORAGE_CORRUPT"
        ? "corrupt"
        : "engine-unavailable";
    }
  } else if (databasePresent && !originSecretPresent) {
    state = "origin-secret-missing";
    diagnostics.push("TS_INSIGHTS_ORIGIN_SECRET_MISSING");
  } else if (databasePresent) {
    state = "engine-status-skipped";
    diagnostics.push("TS_INSIGHTS_ENGINE_STATUS_SKIPPED");
  } else if (originSecretPresent) {
    state = "not-indexed";
  }
  return Object.freeze({
    format: INSIGHTS_STATUS_FORMAT,
    state,
    location: "platform-state-directory",
    bytes: footprint.bytes.toString(),
    entries: footprint.entries,
    databasePresent,
    originSecretPresent,
    diagnostics: Object.freeze(diagnostics),
    ...(engineStatus === undefined ? {} : { engine: engineStatus }),
  });
}

export async function resetInsightsState(options = {}) {
  const paths = options.paths ?? resolveInsightsPaths(options);
  const stateDirectory = assertSafeResetTarget(paths, options);
  const existing = await pathStat(stateDirectory);
  if (existing === null) {
    return Object.freeze({ format: INSIGHTS_RESET_FORMAT, reset: false });
  }
  if (!existing.isDirectory() || existing.isSymbolicLink()) {
    throw lifecycleError(
      "TS_INSIGHTS_STATE_INVALID",
      "Insights state path is not a private directory",
    );
  }
  const lock = await acquireInsightsWriterLock(paths, options);
  let removed = 0;
  try {
    if (typeof options.stopEngine === "function") await options.stopEngine();
    removed = await removeDerivedInsightsState(paths, stateDirectory);
  } finally {
    await lock.release();
  }
  return Object.freeze({ format: INSIGHTS_RESET_FORMAT, reset: removed > 0 });
}
