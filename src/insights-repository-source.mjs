import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { stat, realpath } from "node:fs/promises";
import process from "node:process";
import { promisify } from "node:util";
import { canonicalJson } from "./canonical-json.mjs";
import { traceSourceDigestDocument } from "./insights-engine-protocol.mjs";
import { updateInsightsRepositoryRegistration } from "./insights-config.mjs";

const execFileAsync = promisify(execFile);
const MAX_GIT_OUTPUT_BYTES = 64 * 1024;
const GIT_TIMEOUT_MILLISECONDS = 30_000;
const MAX_GIT_SCAN_OUTPUT_BYTES = 16 * 1024 * 1024;
const DEFAULT_MAX_COMMITS = 50_000;
const DEFAULT_MAX_FILES = 2_000_000;
const GIT_COMMIT_BATCH_SIZE = 128;
const MAX_SUMMARY_BYTES = 4_096;
const OBJECT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function repositoryError() {
  const error = new Error("The selected path is not a readable local Git worktree");
  error.code = "TS_INSIGHTS_REPOSITORY_INVALID";
  return error;
}

async function runGit(arguments_, options) {
  const execute = options.execFile ?? execFileAsync;
  return execute(options.gitExecutable ?? "git", arguments_, {
    encoding: "utf8",
    maxBuffer: MAX_GIT_OUTPUT_BYTES,
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MILLISECONDS,
    signal: options.signal,
    windowsHide: true,
    env: {
      ...process.env,
      ...options.environment,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_EXTERNAL_DIFF: "",
      LC_ALL: "C",
    },
  });
}

async function runGitScan(arguments_, options) {
  const execute = options.execFile ?? execFileAsync;
  return execute(options.gitExecutable ?? "git", arguments_, {
    encoding: "buffer",
    maxBuffer: options.maxGitOutputBytes ?? MAX_GIT_SCAN_OUTPUT_BYTES,
    timeout: options.timeoutMs ?? GIT_TIMEOUT_MILLISECONDS,
    signal: options.signal,
    windowsHide: true,
    env: {
      ...process.env,
      ...options.environment,
      GIT_OPTIONAL_LOCKS: "0",
      GIT_TERMINAL_PROMPT: "0",
      GIT_PAGER: "cat",
      PAGER: "cat",
      GIT_EXTERNAL_DIFF: "",
      LC_ALL: "C.UTF-8",
    },
  });
}

function decodeGit(buffer) {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(buffer);
  } catch {
    throw repositoryError();
  }
}

function boundedSummary(value) {
  let result = value.replaceAll(/[\r\n\0]/gu, " ").trim();
  while (Buffer.byteLength(result, "utf8") > MAX_SUMMARY_BYTES) {
    result = result.slice(0, -1);
  }
  return result;
}

function parseObjectId(value) {
  if (!OBJECT_ID_PATTERN.test(value)) throw repositoryError();
  return value;
}

function parseRefs(raw) {
  if (raw.length === 0) return [];
  return raw.trimEnd().split("\n").map((line) => {
    const [name, objectId, ...extra] = line.split("\0");
    if (extra.length !== 0 || !name?.startsWith("refs/") || name.length > 4096) {
      throw repositoryError();
    }
    return Object.freeze({ name, objectId: parseObjectId(objectId) });
  });
}

function refDigest(refs) {
  return createHash("sha256").update(canonicalJson(refs), "utf8").digest("hex");
}

async function readRefs(registration, options) {
  const { stdout } = await runGitScan([
    "-C", registration.rootDirectory,
    "for-each-ref", "--sort=refname", "--format=%(refname)%00%(objectname)",
  ], options);
  return Object.freeze(parseRefs(decodeGit(stdout)));
}

function repositoryChangedError() {
  const error = new Error("Repository refs changed during the bounded scan");
  error.code = "TS_INSIGHTS_REPOSITORY_CHANGED";
  return error;
}

function canonicalTimestamp(value) {
  const timestamp = new Date(value);
  if (!Number.isFinite(timestamp.valueOf())) throw repositoryError();
  return timestamp.toISOString();
}

function stripGitRecordBreak(value) {
  return value.startsWith("\n") ? value.slice(1) : value;
}

function parseCommitBatch(raw, objectIds) {
  const tokens = raw.split("\0");
  const commits = [];
  let index = 0;
  for (let commitIndex = 0; commitIndex < objectIds.length; commitIndex += 1) {
    const objectId = objectIds[commitIndex];
    if (stripGitRecordBreak(tokens[index++]) !== objectId) throw repositoryError();
    const parents = tokens[index++];
    const authorTimestamp = tokens[index++];
    const committerTimestamp = tokens[index++];
    const treeObjectId = tokens[index++];
    const summary = tokens[index++];
    if (tokens[index] === "") index += 1;
    const files = [];
    while (index < tokens.length) {
      const token = stripGitRecordBreak(tokens[index]);
      if (commitIndex + 1 < objectIds.length && token === objectIds[commitIndex + 1]) break;
      if (token === "") {
        index += 1;
        continue;
      }
      index += 1;
      const status = token[0];
      const renamed = status === "R" || status === "C";
      const oldPath = renamed ? tokens[index++] : null;
      const filePath = tokens[index++];
      if (!new Set(["A", "C", "D", "M", "R", "T", "U", "X", "B"]).has(status) ||
          typeof filePath !== "string" || filePath === "" || filePath.startsWith("/") ||
          filePath.split("/").includes("..") || Buffer.byteLength(filePath, "utf8") > 12 * 1024 ||
          (renamed && (typeof oldPath !== "string" || oldPath === ""))) {
        throw repositoryError();
      }
      files.push({ path: filePath, oldPath, status, additions: null, deletions: null });
    }
    commits.push({
      objectId,
      parentObjectIds: parents === "" ? [] : parents.split(" ").map(parseObjectId),
      authorTimestamp: canonicalTimestamp(authorTimestamp),
      committerTimestamp: canonicalTimestamp(committerTimestamp),
      treeObjectId: parseObjectId(treeObjectId),
      summary: boundedSummary(summary),
      files,
    });
  }
  return commits;
}

function parseNumstatBatch(raw, objectIds) {
  const tokens = raw.split("\0");
  const result = new Map();
  let index = 0;
  for (let commitIndex = 0; commitIndex < objectIds.length; commitIndex += 1) {
    const objectId = objectIds[commitIndex];
    if (stripGitRecordBreak(tokens[index++]) !== objectId) throw repositoryError();
    if (tokens[index] === "") index += 1;
    const stats = new Map();
    while (index < tokens.length) {
      const token = stripGitRecordBreak(tokens[index]);
      if (commitIndex + 1 < objectIds.length && token === objectIds[commitIndex + 1]) break;
      if (token === "") {
        index += 1;
        continue;
      }
      index += 1;
      const fields = token.split("\t");
      if (fields.length !== 3) throw repositoryError();
      const [additions, deletions, inlinePath] = fields;
      const filePath = inlinePath === "" ? tokens[index + 1] : inlinePath;
      if (inlinePath === "") index += 2;
      if (typeof filePath !== "string" || filePath === "") throw repositoryError();
      const decimal = (value) => /^\d+$/u.test(value) ? value : null;
      stats.set(filePath, { additions: decimal(additions), deletions: decimal(deletions) });
    }
    result.set(objectId, stats);
  }
  return result;
}

async function readCommitBatch(registration, objectIds, options) {
  const gitPrefix = ["-C", registration.rootDirectory];
  const [names, stats] = await Promise.all([
    runGitScan([
      ...gitPrefix, "show", "--no-ext-diff",
      "--format=%H%x00%P%x00%aI%x00%cI%x00%T%x00%s%x00",
      "--name-status", "-r", "-z", "-M", ...objectIds,
    ], options),
    runGitScan([
      ...gitPrefix, "show", "--no-ext-diff", "--format=%H%x00",
      "--numstat", "-r", "-z", "-M", ...objectIds,
    ], options),
  ]);
  const commits = parseCommitBatch(decodeGit(names.stdout), objectIds);
  const statsByCommit = parseNumstatBatch(decodeGit(stats.stdout), objectIds);
  return commits.map((commit) => {
    const statsForCommit = statsByCommit.get(commit.objectId) ?? new Map();
    return Object.freeze({
      ...commit,
      files: Object.freeze(commit.files.map((file) => Object.freeze({
        ...file,
        ...(statsForCommit.get(file.path) ?? {}),
      }))),
    });
  });
}

export function sanitizeScmRemote(remote) {
  if (typeof remote !== "string" || remote === "" || remote.startsWith("file:")) return null;
  let host;
  let pathname;
  try {
    if (/^https:\/\//u.test(remote)) {
      const parsed = new URL(remote);
      host = parsed.hostname.toLowerCase();
      pathname = parsed.pathname;
    } else if (/^ssh:\/\//u.test(remote)) {
      const parsed = new URL(remote);
      host = parsed.hostname.toLowerCase();
      pathname = parsed.pathname;
    } else {
      const match = /^(?:[^@/:]+@)?([^/:]+):(.+)$/u.exec(remote);
      if (!match) return null;
      [, host, pathname] = match;
      host = host.toLowerCase();
    }
  } catch {
    return null;
  }
  const scmProvider = host === "github.com" ? "github" : host === "gitlab.com" ? "gitlab" : null;
  const repositoryPath = pathname.replace(/^\/+|\/+$/gu, "").replace(/\.git$/u, "");
  if (scmProvider === null || repositoryPath === "" || repositoryPath.split("/").some(
    (part) => part === "" || part === "." || part === "..",
  )) return null;
  return Object.freeze({
    repositoryPath,
    scmProvider,
    webBaseUrl: `https://${host}`,
  });
}

async function readScmMetadata(registration, options) {
  const { stdout: namesBytes } = await runGitScan([
    "-C", registration.rootDirectory, "remote",
  ], options);
  const names = decodeGit(namesBytes).trim().split("\n").filter(Boolean).sort();
  const ordered = names.includes("origin")
    ? ["origin", ...names.filter((name) => name !== "origin")]
    : names;
  for (const name of ordered) {
    if (name.length > 256 || name.includes("\0")) continue;
    try {
      const { stdout } = await runGitScan([
        "-C", registration.rootDirectory, "remote", "get-url", "--all", name,
      ], options);
      for (const remote of decodeGit(stdout).trim().split("\n")) {
        const scm = sanitizeScmRemote(remote);
        if (scm !== null) return scm;
      }
    } catch (error) {
      if (error?.code === "ABORT_ERR") throw error;
    }
  }
  return null;
}

export async function scanGitRepository(registration, options = {}) {
  if (!registration?.rootDirectory || !registration?.repositoryId) throw repositoryError();
  const refs = await readRefs(registration, options);
  const digest = refDigest(refs);
  const scm = await readScmMetadata(registration, options);
  if (options.priorState?.refDigest === digest) {
    return Object.freeze({ mode: "unchanged", refDigest: digest, refs, commits: Object.freeze([]), scm });
  }
  const initial = options.priorState === undefined || options.priorState?.refDigest === null;
  if (initial && typeof options.coverageAfter !== "string") {
    const error = new Error("Repository history range is required before initial Git ingestion");
    error.code = "TS_INSIGHTS_REPOSITORY_RANGE_REQUIRED";
    throw error;
  }
  const maxCommits = options.maxCommits ?? DEFAULT_MAX_COMMITS;
  const priorTips = (options.priorState?.refs ?? []).map(({ objectId }) => parseObjectId(objectId));
  const revListArguments = [
    "-C", registration.rootDirectory,
    "rev-list", "--topo-order", `--max-count=${maxCommits + 1}`,
    ...(initial ? [`--since=${options.coverageAfter}`] : []), "--all",
    ...(priorTips.length === 0 ? [] : ["--not", ...priorTips]),
  ];
  const { stdout: objectBytes } = await runGitScan(revListArguments, options);
  const objectIds = decodeGit(objectBytes).trim().split("\n").filter(Boolean).map(parseObjectId);
  if (objectIds.length > maxCommits) {
    const error = new Error("Repository history exceeds the bounded commit limit");
    error.code = "TS_INSIGHTS_REPOSITORY_TOO_BROAD";
    throw error;
  }
  const commits = [];
  let fileCount = 0;
  for (let index = 0; index < objectIds.length; index += GIT_COMMIT_BATCH_SIZE) {
    const batch = await readCommitBatch(
      registration,
      objectIds.slice(index, index + GIT_COMMIT_BATCH_SIZE),
      options,
    );
    for (const commit of batch) {
      fileCount += commit.files.length;
      if (fileCount > (options.maxFiles ?? DEFAULT_MAX_FILES)) {
        const error = new Error("Repository history exceeds the bounded file-change limit");
        error.code = "TS_INSIGHTS_REPOSITORY_TOO_BROAD";
        throw error;
      }
      commits.push(commit);
    }
  }
  const finalRefs = await readRefs(registration, options);
  if (refDigest(finalRefs) !== digest) throw repositoryChangedError();
  return Object.freeze({
    mode: options.priorState ? "incremental" : "initial",
    refDigest: digest,
    refs,
    commits: Object.freeze(commits),
    scm,
  });
}

export function createTraceSourceDelta(registration, scan, options) {
  const expectedGeneration = options?.expectedGeneration;
  if (!/^(?:0|[1-9][0-9]*)$/u.test(expectedGeneration ?? "") ||
      typeof options?.privacyContext?.fingerprint !== "function") {
    throw new TypeError("trace source delta requires a generation and privacy context");
  }
  const expected = BigInt(expectedGeneration);
  if (expected >= 0xffff_ffff_ffff_ffffn) {
    throw new RangeError("trace source generation exceeds uint64");
  }
  const repositoryKey = options.privacyContext.fingerprint(
    "repository",
    registration.repositoryId,
  );
  const intent = options.intentSource ?? null;
  const value = {
    format: "threadshare-insights-trace-source-delta@v1",
    expectedGeneration,
    targetGeneration: (expected + 1n).toString(),
    repository: {
      repositoryId: registration.repositoryId,
      repositoryKey,
      available: scan.available !== false,
      refDigest: scan.refDigest,
      scmProvider: scan.scm?.scmProvider ?? null,
      webBaseUrl: scan.scm?.webBaseUrl ?? null,
      repositoryPath: scan.scm?.repositoryPath ?? null,
      projectKeys: ["claude", "codex"].map((provider) =>
        options.privacyContext.projectFingerprint(provider, registration.rootDirectory)),
    },
    intent: intent === null ? null : {
      sourceKey: intent.sourceKey,
      adapterVersion: intent.adapterVersion,
      revision: intent.revision,
      locator: intent.locator,
      coverage: intent.coverage,
      diagnostics: intent.diagnostics.map(({ line, code }) => ({ line, code })),
    },
    refs: scan.refs.map(({ name, objectId }) => ({ name, objectId })),
    commits: scan.commits.map((commit) => ({
      objectId: commit.objectId,
      parentObjectIds: [...commit.parentObjectIds],
      authorTimestamp: commit.authorTimestamp,
      committerTimestamp: commit.committerTimestamp,
      treeObjectId: commit.treeObjectId,
      summary: commit.summary,
      files: commit.files.map((file) => ({
        path: file.path,
        oldPath: file.oldPath,
        status: file.status,
        additions: file.additions,
        deletions: file.deletions,
      })),
    })),
    intentNodes: intent?.nodes.map((node) => ({ ...node })) ?? [],
    intentRefs: intent?.refs.map((reference) => ({ ...reference })) ?? [],
  };
  const deltaId = createHash("sha256")
    .update(canonicalJson(traceSourceDigestDocument(value)), "utf8")
    .digest("hex");
  return Object.freeze({ ...value, deltaId });
}

export async function resolveGitRepository(repositoryPath, options = {}) {
  if (typeof repositoryPath !== "string" || repositoryPath.trim() === "") {
    throw repositoryError();
  }
  try {
    const { stdout } = await runGit([
      "-c", "core.hooksPath=/dev/null",
      "-c", "core.pager=cat",
      "-c", "pager.rev-parse=false",
      "-C", repositoryPath,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ], options);
    const lines = stdout.trimEnd().split("\n");
    if (lines.length !== 2 || lines.some((line) => line === "" || line.includes("\0"))) {
      throw repositoryError();
    }
    const [rootDirectory, commonDirectory] = await Promise.all(lines.map((line) => realpath(line)));
    const commonStat = await stat(commonDirectory, { bigint: true });
    if (!commonStat.isDirectory()) throw repositoryError();
    return Object.freeze({
      commonDirectory,
      rootDirectory,
      commonDirectoryDevice: commonStat.dev.toString(),
      commonDirectoryInode: commonStat.ino.toString(),
    });
  } catch (error) {
    if (error?.code === "ABORT_ERR") throw error;
    if (error?.code === "TS_INSIGHTS_REPOSITORY_INVALID") throw error;
    throw repositoryError();
  }
}

export async function registerInsightsRepository(repositoryPath, options = {}) {
  const resolveRepository = options.resolveRepository ?? resolveGitRepository;
  const updateRegistration = options.updateRegistration ?? ((registration) =>
    updateInsightsRepositoryRegistration(registration, options.configOptions ?? options));
  const registration = await resolveRepository(repositoryPath, options);
  return updateRegistration({
    ...registration,
    ...(options.clearIntent === true
      ? { clearIntent: true }
      : options.intentPath === undefined || options.intentPath === null
        ? {}
        : { intentPath: options.intentPath }),
  });
}

export async function registerRequestedInsightsRepository(repositoryPath, options = {}) {
  if (repositoryPath === null) return null;
  return registerInsightsRepository(repositoryPath, options);
}
