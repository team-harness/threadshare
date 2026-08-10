import { randomUUID } from "node:crypto";
import { constants } from "node:fs";
import { link, open, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { secureInsightsFile } from "./insights-state.mjs";

export const INSIGHTS_WRITER_LOCK_FORMAT = "threadshare-insights-writer-lock@v1";

const MAX_LOCK_BYTES = 4096;
const UUID_V4_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/iu;

function lockError(code, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

async function syncDirectory(directory, options) {
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

async function readBounded(handle) {
  const stat = await handle.stat();
  if (!stat.isFile() || stat.size < 1 || stat.size > MAX_LOCK_BYTES) return null;
  const bytes = Buffer.alloc(Number(stat.size));
  const { bytesRead } = await handle.read(bytes, 0, bytes.length, 0);
  return bytesRead === bytes.length ? bytes : null;
}

function parseOwner(raw) {
  if (raw === null) return null;
  let value;
  try {
    value = JSON.parse(raw.toString("utf8"));
  } catch {
    return null;
  }
  const keys = value && typeof value === "object" && !Array.isArray(value)
    ? Object.keys(value).sort()
    : [];
  if (
    keys.join(",") !== "format,pid,token" ||
    value.format !== INSIGHTS_WRITER_LOCK_FORMAT ||
    !Number.isSafeInteger(value.pid) ||
    value.pid <= 0 ||
    typeof value.token !== "string" ||
    !UUID_V4_PATTERN.test(value.token)
  ) {
    return null;
  }
  return { pid: value.pid, token: value.token.toLowerCase() };
}

async function readLock(lockFile) {
  let handle;
  try {
    handle = await open(lockFile, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") return { raw: null, owner: null };
    throw error;
  }
  try {
    const raw = await readBounded(handle);
    return { raw, owner: parseOwner(raw) };
  } finally {
    await handle.close();
  }
}

function defaultProcessIsRunning(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (error) {
    return error?.code !== "ESRCH";
  }
}

async function createOwnedLock(lockFile, options) {
  const owner = {
    format: INSIGHTS_WRITER_LOCK_FORMAT,
    pid: options.pid ?? process.pid,
    token: randomUUID(),
  };
  const raw = Buffer.from(`${JSON.stringify(owner)}\n`, "utf8");
  const candidate = path.join(
    path.dirname(lockFile),
    `.writer-lock.${owner.pid}.${owner.token}.tmp`,
  );
  let handle;
  let acquired = false;
  try {
    handle = await open(candidate, "wx", 0o600);
    await handle.writeFile(raw);
    await handle.sync();
    await handle.close();
    handle = undefined;
    await secureInsightsFile(candidate, options);
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

async function removeOwnedLock(lockFile, ownership, options) {
  const current = await readLock(lockFile);
  if (current === null) return;
  if (!current.raw?.equals(ownership.raw)) {
    throw lockError(
      "TS_INSIGHTS_WRITER_LOCK_COMPROMISED",
      "Insights writer lock ownership changed before release",
    );
  }
  await unlink(lockFile);
  await syncDirectory(path.dirname(lockFile), options);
}

async function recoverStaleLock(lockFile, observed, options) {
  const recoveryFile = `${lockFile}.recovery`;
  let recovery = await createOwnedLock(recoveryFile, options);
  if (recovery === null) {
    const staleRecovery = await readLock(recoveryFile);
    const processIsRunning = options.processIsRunning ?? defaultProcessIsRunning;
    if (
      !staleRecovery?.owner ||
      processIsRunning(staleRecovery.owner.pid)
    ) {
      return false;
    }
    const currentRecovery = await readLock(recoveryFile);
    if (!currentRecovery?.raw?.equals(staleRecovery.raw)) return false;
    await unlink(recoveryFile).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
    await syncDirectory(path.dirname(recoveryFile), options);
    recovery = await createOwnedLock(recoveryFile, options);
  }
  if (recovery === null) return false;
  try {
    const current = await readLock(lockFile);
    const processIsRunning = options.processIsRunning ?? defaultProcessIsRunning;
    if (
      current?.owner &&
      current.raw?.equals(observed.raw) &&
      !processIsRunning(current.owner.pid)
    ) {
      await unlink(lockFile);
      await syncDirectory(path.dirname(lockFile), options);
      return true;
    }
    return false;
  } finally {
    await removeOwnedLock(recoveryFile, recovery, options);
  }
}

export async function acquireInsightsWriterLock(paths, options = {}) {
  const lockFile = paths?.lockFile;
  if (typeof lockFile !== "string" || lockFile.length === 0) {
    throw new TypeError("paths.lockFile is required");
  }
  let ownership = await createOwnedLock(lockFile, options);
  if (ownership === null) {
    const observed = await readLock(lockFile);
    if (!observed?.owner) {
      throw lockError(
        "TS_INSIGHTS_WRITER_LOCK_INVALID",
        "Insights writer lock is not a valid owner record",
      );
    }
    const processIsRunning = options.processIsRunning ?? defaultProcessIsRunning;
    if (processIsRunning(observed.owner.pid)) {
      throw lockError(
        "TS_INSIGHTS_WRITER_LOCKED",
        "Another Insights writer is already active",
      );
    }
    if (!(await recoverStaleLock(lockFile, observed, options))) {
      throw lockError(
        "TS_INSIGHTS_WRITER_LOCKED",
        "Insights writer lock changed while recovering stale state",
      );
    }
    ownership = await createOwnedLock(lockFile, options);
    if (ownership === null) {
      throw lockError(
        "TS_INSIGHTS_WRITER_LOCKED",
        "Another Insights writer became active during stale-lock recovery",
      );
    }
  }
  await syncDirectory(path.dirname(lockFile), options);
  let released = false;
  return Object.freeze({
    owner: Object.freeze({ ...ownership.owner }),
    async release() {
      if (released) return;
      await removeOwnedLock(lockFile, ownership, options);
      released = true;
    },
  });
}

export async function withInsightsWriterLock(paths, operation, options = {}) {
  if (typeof operation !== "function") throw new TypeError("operation must be a function");
  const lock = await acquireInsightsWriterLock(paths, options);
  try {
    return await operation(lock.owner);
  } finally {
    await lock.release();
  }
}
