import { randomBytes, randomUUID } from "node:crypto";
import {
  chmod,
  lstat,
  mkdir,
  open,
  readFile,
  rename,
  rm,
  statfs,
  unlink,
} from "node:fs/promises";
import path from "node:path";
import {
  INSIGHTS_ORIGIN_SECRET_FORMAT,
  openInsightsState,
  secureInsightsFile,
} from "./insights-state.mjs";
import { resolveInsightsPaths } from "./insights-paths.mjs";
import { acquireInsightsWriterLock } from "./insights-writer-lock.mjs";
import { createPrivacyContext } from "./session-facts.mjs";

export const INSIGHTS_REINDEX_FORMAT = "threadshare-insights-reindex@v1";
export const INSIGHTS_REGENERATE_CONFIRMATION = "regenerate-origin-secret";

const SWAP_FORMAT = "threadshare-insights-reindex-swap@v1";
const REINDEX_RESERVE_BYTES = 256n * 1024n * 1024n;
const SIDECAR_SUFFIXES = ["", "-wal", "-shm"];

function reindexError(code, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

async function fileStat(file) {
  try {
    return await lstat(file, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function syncDirectory(directory) {
  const handle = await open(directory, "r");
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

async function atomicJson(file, value) {
  const temp = `${file}.${process.pid}.${randomUUID()}.tmp`;
  const handle = await open(temp, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await chmod(temp, 0o600);
  await rename(temp, file);
  await syncDirectory(path.dirname(file));
}

function swapPaths(paths, id) {
  const directory = paths.stateDirectory;
  return Object.freeze({
    manifest: path.join(directory, ".reindex-swap.json"),
    candidateDatabase: path.join(directory, `.reindex-${id}.sqlite3`),
    backupDatabase: path.join(directory, ".reindex-backup.sqlite3"),
    candidateSecret: path.join(directory, `.reindex-${id}.origin-secret.json`),
    backupSecret: path.join(directory, ".reindex-backup.origin-secret.json"),
  });
}

function group(file) {
  return SIDECAR_SUFFIXES.map((suffix) => `${file}${suffix}`);
}

async function groupPresence(file) {
  const present = [];
  for (const suffix of SIDECAR_SUFFIXES) {
    if (await fileStat(`${file}${suffix}`) !== null) present.push(suffix);
  }
  return Object.freeze({
    any: present.length > 0,
    main: present.includes(""),
  });
}

async function removeIfPresent(file) {
  await unlink(file).catch((error) => {
    if (error?.code !== "ENOENT") throw error;
  });
}

async function removeGroup(file) {
  await Promise.all(group(file).map(removeIfPresent));
}

async function syncGroup(file) {
  for (const candidate of group(file)) {
    if (await fileStat(candidate) === null) continue;
    const handle = await open(candidate, "r+");
    try {
      await handle.sync();
    } finally {
      await handle.close();
    }
  }
}

async function moveIfPresent(from, to) {
  if (await fileStat(from) === null) return false;
  await rename(from, to);
  return true;
}

async function moveGroup(from, to) {
  let moved = false;
  for (const suffix of SIDECAR_SUFFIXES) {
    moved = (await moveIfPresent(`${from}${suffix}`, `${to}${suffix}`)) || moved;
  }
  return moved;
}

async function parseManifest(file) {
  const stat = await fileStat(file);
  if (stat === null) return null;
  if (!stat.isFile() || stat.size > 16_384n) {
    throw reindexError("TS_INSIGHTS_REINDEX_RECOVERY_REQUIRED", "Insights reindex swap manifest is invalid");
  }
  let value;
  try {
    value = JSON.parse(await readFile(file, "utf8"));
  } catch (cause) {
    throw reindexError(
      "TS_INSIGHTS_REINDEX_RECOVERY_REQUIRED",
      "Insights reindex swap manifest is invalid",
      cause,
    );
  }
  if (
    value?.format !== SWAP_FORMAT ||
    typeof value.id !== "string" ||
    !/^[0-9a-f-]{36}$/u.test(value.id) ||
    typeof value.regenerateSecret !== "boolean"
  ) {
    throw reindexError("TS_INSIGHTS_REINDEX_RECOVERY_REQUIRED", "Insights reindex swap manifest is invalid");
  }
  return value;
}

export async function recoverInsightsReindexSwap(options = {}) {
  const paths = options.paths ?? resolveInsightsPaths(options);
  const manifestFile = path.join(paths.stateDirectory, ".reindex-swap.json");
  const manifest = await parseManifest(manifestFile);
  if (manifest === null) return Object.freeze({ recovered: false });
  const swap = swapPaths(paths, manifest.id);
  const candidate = await groupPresence(swap.candidateDatabase);
  const active = await groupPresence(paths.databaseFile);

  if (candidate.any) {
    // A remaining candidate file means the group move did not finish. If its main
    // file remains, installation never began and old files can be merged back.
    // Otherwise remove the partially installed new group before restoring backup.
    if (candidate.main) {
      await moveGroup(swap.backupDatabase, paths.databaseFile);
    } else {
      await removeGroup(paths.databaseFile);
      await moveGroup(swap.backupDatabase, paths.databaseFile);
    }
    await removeGroup(swap.candidateDatabase);
    if (manifest.regenerateSecret) {
      if (await fileStat(swap.backupSecret) !== null) {
        await removeIfPresent(paths.originSecretFile);
        await rename(swap.backupSecret, paths.originSecretFile);
        await secureInsightsFile(paths.originSecretFile, options);
      }
      await removeIfPresent(swap.candidateSecret);
    }
  } else {
    if (!active.main) {
      throw reindexError(
        "TS_INSIGHTS_REINDEX_RECOVERY_REQUIRED",
        "Insights reindex swap lost both the active and candidate database",
      );
    }
    // The new database is installed. Complete the matching secret installation if needed.
    if (manifest.regenerateSecret && await fileStat(swap.candidateSecret) !== null) {
      if (await fileStat(paths.originSecretFile) !== null && await fileStat(swap.backupSecret) === null) {
        await rename(paths.originSecretFile, swap.backupSecret);
      }
      await rename(swap.candidateSecret, paths.originSecretFile);
      await secureInsightsFile(paths.originSecretFile, options);
    }
  }

  await removeGroup(swap.backupDatabase);
  await removeIfPresent(swap.backupSecret);
  await removeIfPresent(manifestFile);
  await syncDirectory(paths.stateDirectory);
  return Object.freeze({ recovered: true });
}

async function databaseBytes(file) {
  let total = 0n;
  for (const candidate of group(file)) {
    const stat = await fileStat(candidate);
    if (stat?.isFile()) total += stat.size;
  }
  return total;
}

async function assertCapacity(paths, options) {
  const activeBytes = await databaseBytes(paths.databaseFile);
  const requiredBytes = activeBytes * 2n + REINDEX_RESERVE_BYTES;
  const availableBytes = options.availableBytes === undefined
    ? (() => statfs(paths.stateDirectory, { bigint: true }).then((value) => value.bavail * value.bsize))()
    : Promise.resolve(BigInt(options.availableBytes));
  if (await availableBytes < requiredBytes) {
    throw reindexError(
      "TS_INSIGHTS_REINDEX_SPACE_REQUIRED",
      "Insights reindex requires space for the active and candidate snapshots",
    );
  }
  return { activeBytes, requiredBytes };
}

async function writeCandidateSecret(file, options) {
  const value = {
    format: INSIGHTS_ORIGIN_SECRET_FORMAT,
    originSecretEpoch: randomUUID(),
    secret: randomBytes(32).toString("base64url"),
  };
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await secureInsightsFile(file, options);
  return {
    originSecretEpoch: value.originSecretEpoch,
    privacyContext: createPrivacyContext({
      originSecretEpoch: value.originSecretEpoch,
      secret: Buffer.from(value.secret, "base64url"),
    }),
  };
}

async function installCandidate(paths, swap, regenerateSecret, options) {
  await atomicJson(swap.manifest, {
    format: SWAP_FORMAT,
    id: path.basename(swap.candidateDatabase).slice(9, -8),
    regenerateSecret,
  });
  await removeGroup(swap.backupDatabase);
  await removeIfPresent(swap.backupSecret);
  await moveGroup(paths.databaseFile, swap.backupDatabase);
  if (regenerateSecret && await fileStat(paths.originSecretFile) !== null) {
    await rename(paths.originSecretFile, swap.backupSecret);
  }
  if (!await moveGroup(swap.candidateDatabase, paths.databaseFile)) {
    throw reindexError("TS_INSIGHTS_REINDEX_CANDIDATE_MISSING", "Insights reindex candidate database is missing");
  }
  if (regenerateSecret) {
    await rename(swap.candidateSecret, paths.originSecretFile);
    await secureInsightsFile(paths.originSecretFile, options);
  }
  await syncDirectory(paths.stateDirectory);
  await removeGroup(swap.backupDatabase);
  await removeIfPresent(swap.backupSecret);
  await removeIfPresent(swap.manifest);
  await syncDirectory(paths.stateDirectory);
}

export async function reindexInsightsState(options = {}) {
  if (typeof options.buildCandidate !== "function") {
    throw new TypeError("buildCandidate is required");
  }
  const regenerateSecret = options.regenerateSecret === true;
  if (regenerateSecret && options.confirmation !== INSIGHTS_REGENERATE_CONFIRMATION) {
    throw reindexError(
      "TS_INSIGHTS_REGENERATE_CONFIRMATION_REQUIRED",
      `Secret recovery requires confirmation '${INSIGHTS_REGENERATE_CONFIRMATION}'`,
    );
  }
  const paths = options.paths ?? resolveInsightsPaths(options);
  await mkdir(paths.stateDirectory, { recursive: true, mode: 0o700 });
  await mkdir(paths.tempDirectory, { recursive: true, mode: 0o700 });
  if ((options.platform ?? process.platform) === "win32") {
    if (typeof options.windowsAcl !== "function") {
      throw reindexError(
        "TS_INSIGHTS_WINDOWS_ACL_REQUIRED",
        "Windows insights reindex requires an owner-only ACL adapter",
      );
    }
    await options.windowsAcl(paths.stateDirectory, { kind: "directory" });
    await options.windowsAcl(paths.tempDirectory, { kind: "directory" });
  } else {
    await chmod(paths.stateDirectory, 0o700);
    await chmod(paths.tempDirectory, 0o700);
  }
  const lock = await acquireInsightsWriterLock(paths, options);
  const id = randomUUID();
  const swap = swapPaths(paths, id);
  try {
    await recoverInsightsReindexSwap({ ...options, paths });
    const capacity = await assertCapacity(paths, options);
    const origin = regenerateSecret
      ? await writeCandidateSecret(swap.candidateSecret, options)
      : await openInsightsState({ ...options, paths });
    let report;
    try {
      report = await options.buildCandidate({
        databaseFile: swap.candidateDatabase,
        originSecretEpoch: origin.originSecretEpoch,
        privacyContext: origin.privacyContext,
        signal: options.signal,
      });
      const candidate = await fileStat(swap.candidateDatabase);
      if (!candidate?.isFile()) {
        throw reindexError(
          "TS_INSIGHTS_REINDEX_CANDIDATE_MISSING",
          "Insights reindex did not produce a candidate database",
        );
      }
      await syncGroup(swap.candidateDatabase);
      if (typeof options.stopEngine === "function") await options.stopEngine();
      await installCandidate(paths, swap, regenerateSecret, options);
      if (typeof options.onProgress === "function") {
        try {
          void Promise.resolve(options.onProgress(Object.freeze({
            phase: "ready",
            bytesProcessed: report?.index?.bytesProcessed ?? "0",
            bytesTotal: report?.index?.bytesTotal ?? "0",
          }))).catch(() => {});
        } catch {}
      }
    } catch (error) {
      if (await fileStat(swap.manifest) !== null) {
        await recoverInsightsReindexSwap({ ...options, paths });
      }
      await removeGroup(swap.candidateDatabase);
      await removeIfPresent(swap.candidateSecret);
      throw error;
    }
    return Object.freeze({
      format: INSIGHTS_REINDEX_FORMAT,
      reindexed: true,
      regeneratedSecret: regenerateSecret,
      originSecretEpoch: origin.originSecretEpoch,
      activeBytesBefore: capacity.activeBytes.toString(),
      requiredBytes: capacity.requiredBytes.toString(),
      report: report ?? null,
    });
  } finally {
    await lock.release();
  }
}
