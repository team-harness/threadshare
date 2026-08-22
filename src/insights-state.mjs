import { randomBytes, randomUUID } from "node:crypto";
import { chmod, link, lstat, mkdir, open, readFile, readdir, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { resolveInsightsPaths } from "./insights-paths.mjs";
import { createPrivacyContext } from "./session-facts.mjs";

export const INSIGHTS_ORIGIN_SECRET_FORMAT = "threadshare-insights-origin-secret@v1";

const MAX_ORIGIN_SECRET_BYTES = 4096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function errorWithCode(code, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

async function applyPrivateMode(target, kind, options = {}) {
  const platform = options.platform ?? process.platform;
  if (platform === "win32") {
    if (typeof options.windowsAcl !== "function") {
      throw errorWithCode(
        "TS_INSIGHTS_WINDOWS_ACL_REQUIRED",
        "Windows insights state requires an owner-only ACL adapter",
      );
    }
    await options.windowsAcl(target, { kind });
    return;
  }
  await chmod(target, kind === "directory" ? 0o700 : 0o600);
}

async function secureInsightsDirectory(directory, options) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  await applyPrivateMode(directory, "directory", options);
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

export async function secureInsightsFile(file, options = {}) {
  await applyPrivateMode(file, "file", options);
}

function parseOriginSecret(raw, source) {
  if (raw.length === 0 || raw.length > MAX_ORIGIN_SECRET_BYTES) {
    throw errorWithCode(
      "TS_INSIGHTS_ORIGIN_SECRET_INVALID",
      `Invalid insights origin secret at ${source}`,
    );
  }
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch (cause) {
    throw errorWithCode(
      "TS_INSIGHTS_ORIGIN_SECRET_INVALID",
      `Invalid insights origin secret at ${source}`,
      cause,
    );
  }
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (
    keys.join(",") !== "format,originSecretEpoch,secret" ||
    value.format !== INSIGHTS_ORIGIN_SECRET_FORMAT ||
    typeof value.originSecretEpoch !== "string" ||
    !UUID_V4_PATTERN.test(value.originSecretEpoch) ||
    typeof value.secret !== "string"
  ) {
    throw errorWithCode(
      "TS_INSIGHTS_ORIGIN_SECRET_INVALID",
      `Invalid insights origin secret at ${source}`,
    );
  }
  const secret = Buffer.from(value.secret, "base64url");
  if (secret.length !== 32 || secret.toString("base64url") !== value.secret) {
    throw errorWithCode(
      "TS_INSIGHTS_ORIGIN_SECRET_INVALID",
      `Invalid insights origin secret at ${source}`,
    );
  }
  return {
    secret,
    originSecretEpoch: value.originSecretEpoch.toLowerCase(),
  };
}

async function readOriginSecret(file, options) {
  const fileStat = await lstat(file);
  if (!fileStat.isFile() || fileStat.size > MAX_ORIGIN_SECRET_BYTES) {
    throw errorWithCode(
      "TS_INSIGHTS_ORIGIN_SECRET_INVALID",
      `Invalid insights origin secret at ${file}`,
    );
  }
  await secureInsightsFile(file, options);
  return parseOriginSecret(await readFile(file), file);
}

async function readExistingOriginSecret(file) {
  let entry;
  try {
    entry = await lstat(file, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw errorWithCode(
        "TS_INSIGHTS_ORIGIN_SECRET_MISSING",
        "Insights origin secret is missing while indexed state still exists",
        error,
      );
    }
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink() || entry.size > BigInt(MAX_ORIGIN_SECRET_BYTES)) {
    throw errorWithCode(
      "TS_INSIGHTS_ORIGIN_SECRET_INVALID",
      `Invalid insights origin secret at ${file}`,
    );
  }

  let handle;
  try {
    handle = await open(file, "r");
    const opened = await handle.stat({ bigint: true });
    if (!opened.isFile() || opened.dev !== entry.dev || opened.ino !== entry.ino ||
        opened.size !== entry.size || opened.mtimeNs !== entry.mtimeNs ||
        opened.size > BigInt(MAX_ORIGIN_SECRET_BYTES)) {
      throw errorWithCode(
        "TS_INSIGHTS_ORIGIN_SECRET_INVALID",
        `Invalid insights origin secret at ${file}`,
      );
    }
    return parseOriginSecret(await handle.readFile(), file);
  } finally {
    await handle?.close();
  }
}

async function assertExistingDatabase(file) {
  let entry;
  try {
    entry = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") {
      throw errorWithCode(
        "TS_INSIGHTS_NOT_INDEXED",
        "Insights index is not available yet",
        error,
      );
    }
    throw error;
  }
  if (!entry.isFile() || entry.isSymbolicLink()) {
    throw errorWithCode(
      "TS_INSIGHTS_STATE_INVALID",
      "Insights database is not a regular file",
    );
  }
}

async function stateDatabaseExists(databaseFile) {
  for (const file of [databaseFile, `${databaseFile}-wal`, `${databaseFile}-shm`]) {
    try {
      await lstat(file);
      return true;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return false;
}

async function secureExistingStateFile(file, options) {
  let fileStat;
  try {
    fileStat = await lstat(file);
  } catch (error) {
    if (error?.code === "ENOENT") return;
    throw error;
  }
  if (!fileStat.isFile()) {
    throw errorWithCode(
      "TS_INSIGHTS_STATE_INVALID",
      "Insights state contains a non-regular private file",
    );
  }
  await secureInsightsFile(file, options);
}

async function secureExistingStateFiles(paths, options) {
  for (const file of [
    paths.databaseFile,
    `${paths.databaseFile}-wal`,
    `${paths.databaseFile}-shm`,
  ]) {
    await secureExistingStateFile(file, options);
  }
  for (const entry of await readdir(paths.tempDirectory, { withFileTypes: true })) {
    await secureExistingStateFile(path.join(paths.tempDirectory, entry.name), options);
  }
}

async function createOriginSecret(paths, options) {
  if (await stateDatabaseExists(paths.databaseFile)) {
    throw errorWithCode(
      "TS_INSIGHTS_ORIGIN_SECRET_MISSING",
      "Insights origin secret is missing while indexed state still exists",
    );
  }
  const value = {
    format: INSIGHTS_ORIGIN_SECRET_FORMAT,
    originSecretEpoch: randomUUID(),
    secret: randomBytes(32).toString("base64url"),
  };
  const tempFile = path.join(
    paths.stateDirectory,
    `.origin-secret.${process.pid}.${randomUUID()}.tmp`,
  );
  let handle;
  let tempRemoved = false;
  try {
    handle = await open(tempFile, "wx", 0o600);
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
    await handle.close();
    handle = undefined;
    await secureInsightsFile(tempFile, options);
    try {
      await link(tempFile, paths.originSecretFile);
      await secureInsightsFile(paths.originSecretFile, options);
      await syncDirectoryEntry(paths.stateDirectory, options);
      return {
        ...parseOriginSecret(Buffer.from(JSON.stringify(value)), paths.originSecretFile),
        created: true,
      };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      return { ...(await readOriginSecret(paths.originSecretFile, options)), created: false };
    }
  } finally {
    await handle?.close();
    await unlink(tempFile)
      .then(() => {
        tempRemoved = true;
      })
      .catch((error) => {
        if (error?.code !== "ENOENT") throw error;
      });
    if (tempRemoved) await syncDirectoryEntry(paths.stateDirectory, options);
  }
}

async function loadOrCreateOriginSecret(paths, options) {
  try {
    return { ...(await readOriginSecret(paths.originSecretFile, options)), created: false };
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
  }
  return createOriginSecret(paths, options);
}

export async function openInsightsState(options = {}) {
  const paths = options.paths ?? resolveInsightsPaths(options);
  await secureInsightsDirectory(paths.stateDirectory, options);
  await secureInsightsDirectory(paths.tempDirectory, options);
  const origin = await loadOrCreateOriginSecret(paths, options);
  await secureExistingStateFiles(paths, options);
  const privacyContext = createPrivacyContext(origin);
  return Object.freeze({
    paths,
    created: origin.created,
    originSecretEpoch: privacyContext.originSecretEpoch,
    // Raw 32-byte machine-local origin secret. Team Memory derives its
    // repository keys and the runner conformance signing key from it
    // (docs/team-memory-phase1-design.md §8); it never leaves this process.
    originSecret: Buffer.from(origin.secret),
    privacyContext,
  });
}

export async function openExistingInsightsState(options = {}) {
  const paths = options.paths ?? resolveInsightsPaths(options);
  await assertExistingDatabase(paths.databaseFile);
  const origin = await readExistingOriginSecret(paths.originSecretFile);
  const privacyContext = createPrivacyContext(origin);
  return Object.freeze({
    paths,
    created: false,
    originSecretEpoch: privacyContext.originSecretEpoch,
    originSecret: Buffer.from(origin.secret),
    privacyContext,
  });
}
