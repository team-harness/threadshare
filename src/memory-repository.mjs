// Repository owner resolution for team memory (design §9 RepositoryBinding@v1).
//
// The binding identifies a repository by the realpath of its git common
// directory and a worktree by the realpath of its worktree root. Both are
// keyed through HMAC-SHA256 with the local origin secret so that the contract
// object never carries an absolute path (the raw realpath is returned
// separately for the transactional store only).

import { execFile } from "node:child_process";
import { createHash, createHmac } from "node:crypto";
import { realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

const REPOSITORY_BINDING_FORMAT = "threadshare-memory-repository-binding@v1";
const MEMORY_ROOT = ".threadshare/memory";
const REPOSITORY_KEY_DOMAIN = "memory-repository\0";
const WORKTREE_KEY_DOMAIN = "memory-worktree\0";
const DEFAULT_TIMEOUT_MILLISECONDS = 10_000;
const MAX_GIT_OUTPUT_BYTES = 1024 * 1024;

function repositoryError(code, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

async function runGit(directory, argumentsList, options) {
  try {
    const { stdout } = await execFileAsync(
      options.gitExecutable ?? "git",
      ["-c", "core.hooksPath=/dev/null", "-C", directory, ...argumentsList],
      {
        env: {
          ...process.env,
          GIT_CONFIG_NOSYSTEM: "1",
          GIT_OPTIONAL_LOCKS: "0",
          GIT_TERMINAL_PROMPT: "0",
          GIT_PAGER: "cat",
          PAGER: "cat",
          LC_ALL: "C.UTF-8",
        },
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MILLISECONDS,
        maxBuffer: MAX_GIT_OUTPUT_BYTES,
        windowsHide: true,
        encoding: "utf8",
      },
    );
    return stdout;
  } catch (error) {
    if (error?.killed || error?.signal === "SIGTERM" || error?.signal === "SIGKILL") {
      throw repositoryError("MEMORY_REPOSITORY_GIT_TIMEOUT", "git did not answer within the timeout", error);
    }
    throw repositoryError("MEMORY_REPOSITORY_GIT_FAILED", "git invocation failed", error);
  }
}

function hmacHex(secret, domain, value) {
  return createHmac("sha256", secret).update(`${domain}${value}`, "utf8").digest("hex");
}

function sha256Hex(value) {
  return createHash("sha256").update(value, "utf8").digest("hex");
}

function toSafeInteger(field, value) {
  const asNumber = Number(value);
  if (!Number.isSafeInteger(asNumber)) {
    throw repositoryError("MEMORY_REPOSITORY_IDENTITY_UNAVAILABLE", `${field} exceeds the safe integer range`);
  }
  return asNumber;
}

function stripRepositoryPath(rawPath) {
  const withoutQuery = rawPath.split(/[?#]/, 1)[0];
  let value = withoutQuery.replace(/^\/+/, "").replace(/\/+$/, "");
  if (value.endsWith(".git")) value = value.slice(0, -".git".length);
  value = value.replace(/\/+$/, "");
  return value.length === 0 ? null : value;
}

/**
 * Sanitizes a git remote URL into a public repository identity of the shape
 * `host[:port]/org/repo`: credentials, query strings, and fragments are
 * stripped; the scp-like `git@host:org/repo.git` form is normalized to
 * `host/org/repo`. Local paths and `file:` remotes resolve to null because a
 * local filesystem path is not a public identity.
 */
export function sanitizeRemoteUrl(rawUrl) {
  if (typeof rawUrl !== "string") return null;
  const value = rawUrl.trim();
  if (value.length === 0) return null;
  if (!value.includes("://")) {
    // scp-like syntax: [user@]host:path — but not a Windows drive or local path.
    const match = /^(?:[^@/\s]+@)?([^:/\s]+):(.+)$/.exec(value);
    if (match === null || match[1].length < 2) return null;
    const strippedPath = stripRepositoryPath(match[2]);
    if (strippedPath === null) return null;
    return `${match[1].toLowerCase()}/${strippedPath}`;
  }
  let parsed;
  try {
    parsed = new URL(value);
  } catch {
    return null;
  }
  if (!["http:", "https:", "ssh:", "git:"].includes(parsed.protocol)) return null;
  if (parsed.host.length === 0) return null;
  const strippedPath = stripRepositoryPath(parsed.pathname);
  if (strippedPath === null) return null;
  // URL.host lowercases the hostname and drops default ports; credentials,
  // query, and fragment never reach the output.
  return `${parsed.host}/${strippedPath}`;
}

/**
 * Resolves the RepositoryBinding@v1 for a git worktree.
 *
 * Returns `{ binding, rootRealpath }`. `binding` matches design §9 exactly and
 * contains no absolute path; `rootRealpath` is returned separately so the
 * caller can decide whether to store it in the local transactional database.
 * Non-git directories and bare repositories fail hard with a coded error.
 */
export async function resolveRepositoryBinding({ cwd, repositoryPath, originSecret } = {}, options = {}) {
  const requested = repositoryPath ?? cwd;
  if (typeof requested !== "string" || requested.length === 0) {
    throw new TypeError("resolveRepositoryBinding requires cwd or repositoryPath");
  }
  if (!Buffer.isBuffer(originSecret) || originSecret.length !== 32) {
    throw new TypeError("originSecret must be a 32-byte Buffer");
  }
  const directory = path.resolve(requested);

  let probe;
  try {
    probe = await runGit(directory, ["rev-parse", "--is-bare-repository", "--git-common-dir"], options);
  } catch (error) {
    if (error.code === "MEMORY_REPOSITORY_GIT_TIMEOUT") throw error;
    throw repositoryError("MEMORY_REPOSITORY_NOT_GIT", "the directory is not inside a git repository", error);
  }
  const [isBare, commonDirRaw] = probe.split("\n");
  if (isBare === "true") {
    throw repositoryError("MEMORY_REPOSITORY_BARE", "bare repositories cannot own a team memory worktree");
  }
  if (typeof commonDirRaw !== "string" || commonDirRaw.length === 0) {
    throw repositoryError("MEMORY_REPOSITORY_GIT_FAILED", "git returned no common directory");
  }

  let toplevelRaw;
  try {
    toplevelRaw = await runGit(directory, ["rev-parse", "--show-toplevel"], options);
  } catch (error) {
    if (error.code === "MEMORY_REPOSITORY_GIT_TIMEOUT") throw error;
    throw repositoryError(
      "MEMORY_REPOSITORY_NO_WORKTREE",
      "the directory has no git worktree root (for example inside .git)",
      error,
    );
  }
  const toplevel = toplevelRaw.trim();
  if (toplevel.length === 0) {
    throw repositoryError("MEMORY_REPOSITORY_NO_WORKTREE", "git returned no worktree root");
  }

  let commonDirRealpath;
  let worktreeRealpath;
  let identity;
  try {
    commonDirRealpath = await realpath(path.resolve(directory, commonDirRaw));
    worktreeRealpath = await realpath(toplevel);
    identity = await stat(commonDirRealpath, { bigint: true });
  } catch (error) {
    throw repositoryError(
      "MEMORY_REPOSITORY_IDENTITY_UNAVAILABLE",
      "the repository identity paths could not be resolved",
      error,
    );
  }

  let publicRepositoryIdentity = null;
  try {
    const originUrl = await runGit(directory, ["remote", "get-url", "origin"], options);
    publicRepositoryIdentity = sanitizeRemoteUrl(originUrl.trim());
  } catch (error) {
    if (error.code === "MEMORY_REPOSITORY_GIT_TIMEOUT") throw error;
    publicRepositoryIdentity = null; // No origin remote configured.
  }

  const binding = Object.freeze({
    format: REPOSITORY_BINDING_FORMAT,
    repositoryKey: hmacHex(originSecret, REPOSITORY_KEY_DOMAIN, commonDirRealpath),
    worktreeKey: hmacHex(originSecret, WORKTREE_KEY_DOMAIN, worktreeRealpath),
    publicRepositoryIdentity,
    rootRealpathDigest: sha256Hex(worktreeRealpath),
    commonDirectoryIdentity: Object.freeze({
      device: toSafeInteger("device", identity.dev),
      inode: toSafeInteger("inode", identity.ino),
    }),
    memoryRoot: MEMORY_ROOT,
  });
  return Object.freeze({ binding, rootRealpath: worktreeRealpath });
}

/**
 * Validates that a memory-relative path stays inside the memory root: rejects
 * absolute paths, `..`, `.`, empty segments, and backslashes. Returns the
 * normalized relative path (`/`-separated).
 */
export function assertPathInsideMemoryRoot(memoryRootAbs, relPath) {
  if (typeof memoryRootAbs !== "string" || !path.isAbsolute(memoryRootAbs)) {
    throw new TypeError("memoryRootAbs must be an absolute path");
  }
  if (typeof relPath !== "string" || relPath.length === 0) {
    throw repositoryError("MEMORY_REPOSITORY_PATH_ESCAPE", "memory paths must be non-empty relative paths");
  }
  if (relPath.includes("\\") || relPath.includes("\0")) {
    throw repositoryError("MEMORY_REPOSITORY_PATH_ESCAPE", "memory paths must not contain backslashes or NUL");
  }
  if (path.isAbsolute(relPath) || /^[A-Za-z]:/.test(relPath)) {
    throw repositoryError("MEMORY_REPOSITORY_PATH_ESCAPE", "memory paths must be relative");
  }
  const segments = relPath.split("/");
  for (const segment of segments) {
    if (segment === "" || segment === "." || segment === "..") {
      throw repositoryError(
        "MEMORY_REPOSITORY_PATH_ESCAPE",
        "memory paths must not contain empty, '.', or '..' segments",
      );
    }
  }
  const normalized = segments.join("/");
  const resolved = path.resolve(memoryRootAbs, ...segments);
  const root = path.resolve(memoryRootAbs);
  if (resolved !== root && !resolved.startsWith(`${root}${path.sep}`)) {
    throw repositoryError("MEMORY_REPOSITORY_PATH_ESCAPE", "memory paths must stay inside the memory root");
  }
  return normalized;
}
