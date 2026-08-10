import Ajv2020 from "ajv/dist/2020.js";
import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { chmod, link, lstat, mkdir, open, rename, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveInsightsPaths } from "./insights-paths.mjs";

export const INSIGHTS_CONFIG_FORMAT = "threadshare-config@v1";
export const DEFAULT_QUIESCENCE_SECONDS = 300;

export const INSIGHTS_CONFIG_SCHEMA = {
  $schema: "https://json-schema.org/draft/2020-12/schema",
  $id: "https://threadshare.dev/schema/threadshare-config.v1.schema.json",
  title: "ThreadshareConfigV1",
  type: "object",
  additionalProperties: false,
  required: ["format", "schemaVersion", "insights"],
  properties: {
    format: { const: INSIGHTS_CONFIG_FORMAT },
    schemaVersion: { const: 1 },
    insights: {
      type: "object",
      additionalProperties: false,
      required: [
        "excludeProviders",
        "excludeProjects",
        "excludeSessions",
        "quiescenceSeconds",
      ],
      properties: {
        excludeProviders: {
          type: "array",
          uniqueItems: true,
          maxItems: 10,
          items: { enum: ["claude", "codex"] },
        },
        excludeProjects: {
          type: "array",
          uniqueItems: true,
          maxItems: 10_000,
          items: { type: "string", minLength: 1, maxLength: 4096 },
        },
        excludeSessions: {
          type: "array",
          uniqueItems: true,
          maxItems: 100_000,
          items: { type: "string", minLength: 1, maxLength: 512 },
        },
        quiescenceSeconds: { type: "integer", minimum: 60, maximum: 86_400 },
      },
    },
  },
};

const validateConfig = new Ajv2020({ allErrors: true, strict: false }).compile(
  INSIGHTS_CONFIG_SCHEMA,
);
const MAX_CONFIG_BYTES = 1024 * 1024;
const MAX_CONFIG_LOCK_BYTES = 4096;
const CONFIG_LOCK_RETRY_MILLISECONDS = 10;
const CONFIG_LOCK_TIMEOUT_MILLISECONDS = 10_000;
const CONFIG_LOCK_FORMAT = "threadshare-config-lock@v1";
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function defaultConfig() {
  return {
    format: INSIGHTS_CONFIG_FORMAT,
    schemaVersion: 1,
    insights: {
      excludeProviders: [],
      excludeProjects: [],
      excludeSessions: [],
      quiescenceSeconds: DEFAULT_QUIESCENCE_SECONDS,
    },
  };
}

function configError(message, cause, validationErrors) {
  const error = cause === undefined ? new TypeError(message) : new TypeError(message, { cause });
  error.code = "TS_INSIGHTS_CONFIG_INVALID";
  if (validationErrors) error.validationErrors = validationErrors;
  return error;
}

function assertValidConfig(value, source) {
  if (!validateConfig(value)) {
    const validationErrors = (validateConfig.errors ?? []).map((item) => ({ ...item }));
    const detail = validationErrors
      .slice(0, 8)
      .map((item) => `${item.instancePath || "/"} ${item.message}`)
      .join("; ");
    throw configError(`Invalid insights config at ${source}: ${detail}`, undefined, validationErrors);
  }
}

async function secureConfigPath(target, kind, options) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    if (typeof options.windowsAcl !== "function") {
      const error = new Error("Windows insights config requires an owner-only ACL adapter");
      error.code = "TS_INSIGHTS_WINDOWS_ACL_REQUIRED";
      throw error;
    }
    await options.windowsAcl(target, { kind });
    return;
  }
  await chmod(target, kind === "directory" ? 0o700 : 0o600);
}

async function ensureConfigDirectory(directory, options, managed) {
  const created = await mkdir(directory, { recursive: true, mode: 0o700 });
  if (created !== undefined || managed) {
    await secureConfigPath(directory, "directory", options);
  }
}

async function syncDirectoryEntry(directory, options) {
  if (typeof options.syncDirectory === "function") {
    await options.syncDirectory(directory);
    return;
  }
  if ((options.platform ?? process.platform) === "win32") return;
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

function serializedConfig(value, source) {
  assertValidConfig(value, source);
  const serialized = `${JSON.stringify(value, null, 2)}\n`;
  if (Buffer.byteLength(serialized, "utf8") > MAX_CONFIG_BYTES) {
    throw configError(`Invalid insights config at ${source}: serialized form exceeds 1 MiB`);
  }
  return serialized;
}

async function waitForConfigLock() {
  await new Promise((resolve) => setTimeout(resolve, CONFIG_LOCK_RETRY_MILLISECONDS));
}

function configDirectoryIsManaged(paths, options) {
  if (typeof options.configDirectoryManaged === "boolean") {
    return options.configDirectoryManaged;
  }
  return paths.configDirectoryManaged === true;
}

async function secureManagedConfigDirectoryIfPresent(paths, options) {
  if (!configDirectoryIsManaged(paths, options)) return;
  const directory = path.dirname(paths.configFile);
  try {
    const directoryStat = await lstat(directory);
    if (!directoryStat.isDirectory()) return;
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  await secureConfigPath(directory, "directory", options);
}

function configLockDocument() {
  return {
    format: CONFIG_LOCK_FORMAT,
    pid: process.pid,
    token: randomUUID(),
  };
}

function parseConfigLock(raw) {
  if (raw.length === 0 || raw.length > MAX_CONFIG_LOCK_BYTES) return null;
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  if (
    !value ||
    typeof value !== "object" ||
    Array.isArray(value) ||
    value.format !== CONFIG_LOCK_FORMAT ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.token !== "string" ||
    !UUID_V4_PATTERN.test(value.token)
  ) {
    return null;
  }
  return { pid: value.pid, token: value.token.toLowerCase() };
}

async function readConfigLock(lockFile) {
  let handle;
  try {
    handle = await open(lockFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") return { raw: null, owner: null };
    throw error;
  }
  try {
    const raw = await readBoundedFile(handle, MAX_CONFIG_LOCK_BYTES);
    return { raw, owner: parseConfigLock(raw) };
  } finally {
    await handle.close();
  }
}

function processIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function createOwnedLock(lockFile, options) {
  const directory = path.dirname(lockFile);
  const owner = configLockDocument();
  const raw = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
  const candidate = path.join(
    directory,
    `.config-lock.${process.pid}.${owner.token}.tmp`,
  );
  let handle;
  let acquired = false;
  try {
    handle = await open(candidate, "wx", 0o600);
    await handle.writeFile(raw);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await secureConfigPath(candidate, "file", options);
    try {
      await link(candidate, lockFile);
      acquired = true;
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
    }
  } finally {
    await handle?.close();
    await unlink(candidate).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return acquired ? { owner, raw } : null;
}

async function removeOwnedLock(lockFile, ownership) {
  const current = await readConfigLock(lockFile);
  if (current === null) return;
  if (!current.raw?.equals(ownership.raw)) {
    const error = new Error(`Insights config lock ownership changed at ${lockFile}`);
    error.code = "TS_INSIGHTS_CONFIG_LOCK_COMPROMISED";
    throw error;
  }
  await unlink(lockFile);
}

async function recoverStaleConfigLock(lockFile, options) {
  const observed = await readConfigLock(lockFile);
  if (!observed?.owner || processIsRunning(observed.owner.pid)) return false;
  const recoveryFile = `${lockFile}.recovery-${observed.owner.token}`;
  const recoveryOwnership = await createOwnedLock(recoveryFile, options);
  if (recoveryOwnership === null) return false;
  try {
    const current = await readConfigLock(lockFile);
    if (
      current?.owner &&
      current.raw.equals(observed.raw) &&
      !processIsRunning(current.owner.pid)
    ) {
      await unlink(lockFile);
      await syncDirectoryEntry(path.dirname(lockFile), options);
      return true;
    }
    return false;
  } finally {
    await removeOwnedLock(recoveryFile, recoveryOwnership);
  }
}

async function withConfigLock(paths, options, operation) {
  const directory = path.dirname(paths.configFile);
  await ensureConfigDirectory(directory, options, configDirectoryIsManaged(paths, options));
  const lockFile = `${paths.configFile}.lock`;
  const timeout = options.configLockTimeoutMilliseconds ?? CONFIG_LOCK_TIMEOUT_MILLISECONDS;
  if (!Number.isSafeInteger(timeout) || timeout < 0) {
    throw new RangeError("configLockTimeoutMilliseconds must be a non-negative integer");
  }
  const deadline = Date.now() + timeout;
  let ownership;
  while (!ownership) {
    const existing = await readConfigLock(lockFile);
    if (existing !== null) {
      if (await recoverStaleConfigLock(lockFile, options)) continue;
      if (Date.now() >= deadline) {
        const lockError = new Error(`Timed out waiting for insights config lock at ${lockFile}`);
        lockError.code = "TS_INSIGHTS_CONFIG_LOCK_TIMEOUT";
        throw lockError;
      }
      await waitForConfigLock();
      continue;
    }
    ownership = await createOwnedLock(lockFile, options);
    if (ownership) break;
    if (Date.now() >= deadline) {
      const lockError = new Error(`Timed out waiting for insights config lock at ${lockFile}`);
      lockError.code = "TS_INSIGHTS_CONFIG_LOCK_TIMEOUT";
      throw lockError;
    }
    await waitForConfigLock();
  }
  try {
    await syncDirectoryEntry(directory, options);
    return await operation();
  } finally {
    await removeOwnedLock(lockFile, ownership);
    await syncDirectoryEntry(directory, options);
  }
}

async function secureConfigHandle(handle, target, options) {
  if ((options.platform ?? process.platform) === "win32") {
    await secureConfigPath(target, "file", options);
    return;
  }
  await handle.chmod(0o600);
}

function sameConfigSnapshot(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

async function readBoundedFile(handle, maximumBytes) {
  const buffer = Buffer.allocUnsafe(maximumBytes + 1);
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesRead } = await handle.read(
      buffer,
      offset,
      buffer.length - offset,
      offset,
    );
    if (bytesRead === 0) break;
    offset += bytesRead;
  }
  return buffer.subarray(0, offset);
}

export async function loadInsightsConfig(options = {}) {
  const paths = options.paths ?? resolveInsightsPaths(options);
  await secureManagedConfigDirectoryIfPresent(paths, options);
  let handle;
  try {
    handle = await open(
      paths.configFile,
      constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0),
    );
  } catch (error) {
    if (error?.code === "ENOENT") return defaultConfig();
    if (error?.code === "ELOOP") {
      throw configError(`Invalid insights config at ${paths.configFile}`, error);
    }
    throw error;
  }
  try {
    const before = await handle.stat({ bigint: true });
    const pathStat = await lstat(paths.configFile, { bigint: true });
    if (
      !before.isFile() ||
      !pathStat.isFile() ||
      before.dev !== pathStat.dev ||
      before.ino !== pathStat.ino ||
      before.size === 0n ||
      before.size > BigInt(MAX_CONFIG_BYTES)
    ) {
      throw configError(`Invalid insights config at ${paths.configFile}`);
    }
    await secureConfigHandle(handle, paths.configFile, options);
    const raw = await readBoundedFile(handle, MAX_CONFIG_BYTES);
    const after = await handle.stat({ bigint: true });
    if (
      raw.length !== Number(before.size) ||
      raw.length > MAX_CONFIG_BYTES ||
      !sameConfigSnapshot(before, after)
    ) {
      throw configError(`Invalid insights config at ${paths.configFile}`);
    }
    let value;
    try {
      value = JSON.parse(raw.toString("utf8"));
    } catch (cause) {
      throw configError(`Invalid insights config at ${paths.configFile}`, cause);
    }
    assertValidConfig(value, paths.configFile);
    return structuredClone(value);
  } finally {
    await handle.close();
  }
}

async function writeInsightsConfig(value, serialized, paths, options) {
  const directory = path.dirname(paths.configFile);
  const tempFile = path.join(directory, `.config.${process.pid}.${randomUUID()}.tmp`);
  let handle;
  try {
    handle = await open(tempFile, "wx", 0o600);
    await handle.writeFile(serialized, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await secureConfigPath(tempFile, "file", options);
    await rename(tempFile, paths.configFile);
    await secureConfigPath(paths.configFile, "file", options);
    await syncDirectoryEntry(directory, options);
  } finally {
    await handle?.close();
    await unlink(tempFile).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
  return structuredClone(value);
}

export async function saveInsightsConfig(value, options = {}) {
  const paths = options.paths ?? resolveInsightsPaths(options);
  const serialized = serializedConfig(value, paths.configFile);
  return withConfigLock(paths, options, () =>
    writeInsightsConfig(value, serialized, paths, options));
}

const EXCLUSION_FIELDS = Object.freeze({
  provider: "excludeProviders",
  project: "excludeProjects",
  session: "excludeSessions",
});

function normalizeExclusion(kind, value) {
  if (!Object.hasOwn(EXCLUSION_FIELDS, kind)) {
    throw configError("Exclusion kind must be provider, project, or session");
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw configError("Exclusion value must be a non-empty string");
  }
  const normalized = value.trim();
  if (kind === "provider") {
    const provider = normalized.toLowerCase();
    if (provider !== "codex" && provider !== "claude") {
      throw configError("Provider exclusion must be codex or claude");
    }
    return provider;
  }
  return kind === "session" ? normalized.toLowerCase() : normalized;
}

export async function updateInsightsExclusion(change, options = {}) {
  const operation = change?.operation;
  if (operation !== "add" && operation !== "remove") {
    throw configError("Exclusion operation must be add or remove");
  }
  const kind = change?.kind;
  const field = EXCLUSION_FIELDS[kind];
  const value = normalizeExclusion(kind, change?.value);
  const paths = options.paths ?? resolveInsightsPaths(options);
  return withConfigLock(paths, options, async () => {
    const config = await loadInsightsConfig({ ...options, paths });
    const current = new Set(config.insights[field]);
    const present = current.has(value);
    const changed = operation === "add" ? !present : present;
    if (operation === "add") current.add(value);
    else current.delete(value);
    config.insights[field] = [...current].sort();
    if (changed) {
      const serialized = serializedConfig(config, paths.configFile);
      await writeInsightsConfig(config, serialized, paths, options);
    }
    return { changed, config };
  });
}
