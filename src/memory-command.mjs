/**
 * Team Memory CLI orchestration (Stage 7). Wires the completed lower modules
 * (memory-repository / memory-format / memory-lint / memory-state-client /
 * memory-extraction / memory-runner) into the user-facing `threadshare memory`
 * command group, its read-only MCP tools, and its two pending-only previews.
 *
 * Design references: docs/team-memory-phase1-design.md §5 (CLI surface), §8
 * (wiring), DEV-1/DEV-3; docs/team-memory-proposal.md §6.5 (review->promote),
 * §7 (assemble), D1 (authorization: an explicit `--approve-plan` /
 * `--approve-manifest` on the CLI is the authorization to deliver transcript
 * bytes to a provider; without it the runner is never spawned).
 *
 * Extraction selection is a bounded retrospective query over the local
 * Insights index. The caller supplies a canonical window and optional
 * filters; Threadshare injects the bound worktree and hard-sealed scope.
 */

import { createHash, randomBytes } from "node:crypto";
import { constants } from "node:fs";
import { access, lstat, mkdir, open, readFile, readdir, rename, stat, unlink, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { createInterface } from "node:readline/promises";

import { canonicalJson } from "./canonical-json.mjs";
import { cliDiagnostic, DIAGNOSTIC_CODES } from "./cli-contract.mjs";
import { readExistingInsightsConfig } from "./insights-config.mjs";
import { createInsightsEngineClient } from "./insights-engine-client.mjs";
import { insightsChildEnv, insightsRequiredContract } from "./insights-command.mjs";
import { resolveInsightsPaths } from "./insights-paths.mjs";
import { readInsightsQueryRequest } from "./insights-query.mjs";
import { createInsightsQueryReader } from "./insights-query-reader.mjs";
import { openInsightsState } from "./insights-state.mjs";
import { withInsightsWriterLock } from "./insights-writer-lock.mjs";
import {
  adjudicationResultSchema,
  adjudicationTaskSchema,
  authorizationManifestSchema,
  candidateDraftBatchSchema,
  consolidationPatchSchema,
  consolidationTaskSchema,
  extractionTaskSchema,
  memoryDigestHex,
  restrictedExtractionRunnerSchema,
  runnerExecutionPlanSchema,
} from "./memory-contracts.mjs";
import {
  buildConsolidationTask,
  consolidationFilesFromOperations,
  materializeConsolidationPatch,
} from "./memory-consolidation.mjs";
import {
  buildAdjudicationTask,
  buildEvidenceCatalog,
  buildExtractionTask,
  chunkSession,
  collectPayloadDigests,
  computeCitationsDigest,
  deriveEvidenceAssessments,
} from "./memory-extraction.mjs";
import {
  collectMemoryInsightsSelection,
  normalizeMemoryExtractionRequest,
  resolveMemoryInsightsScope,
} from "./memory-insights-source.mjs";
import { parseMemoryEntry, serializeMemoryEntry, validateDoctrine, parseSceneMeta } from "./memory-format.mjs";
import { lintEntryForPromotion } from "./memory-lint.mjs";
import { resolveRepositoryBinding } from "./memory-repository.mjs";
import {
  memoryBindRepository,
  memoryAuthorize,
  memoryClaimTask,
  memoryConfirmStatement,
  memoryConsolidationBaseline,
  memoryListFiles,
  memoryOpen,
  memoryPlanTasks,
  memoryPromotionApply,
  memoryPromotionApprove,
  memoryPromotionPlan,
  memoryRecall,
  memoryReadFile,
  memoryReviewQueue,
  memorySearch,
  memoryStatus,
  memorySubmitAdjudication,
  memorySubmitConsolidation,
  memorySubmitExtraction,
  memorySyncApproved,
  MEMORY_MAX_SYNC_ENTRIES,
  MEMORY_MAX_TEXT_BYTES,
} from "./memory-state-client.mjs";
import {
  approveManifest,
  approvePlan,
  approvePlanFromManifest,
  buildAuthorizationManifest,
  buildExecutionPlan,
  computeRunnerBinaryIdentity,
  CONFORMANCE_TEST_VERSION,
  computeRunnerProfileDigest,
  isConformanceValid,
  loadRunnerProfile,
  resolveRunnerBinaryPath,
  runConformanceTest,
  runExtractionRunner,
} from "./memory-runner.mjs";

const DIAGNOSTIC_CODE_SET = new Set(DIAGNOSTIC_CODES);
const MEMORY_ACTIONS = Object.freeze([
  "init", "status", "lint", "extract", "consolidate", "review", "promote", "assemble",
  "reverify-runner",
]);
const MEMORY_ROOT = ".threadshare/memory";
const MEMORY_SUBDIRS = Object.freeze(["entries", "scenes", "skills"]);
const POLICY_VERSION = "sanitize@1";
const RUNNER_ADAPTERS = Object.freeze({ claude: "claude-cli", codex: "codex-cli" });
const ASSEMBLE_BEGIN = "<!-- BEGIN THREADSHARE MEMORY (generated; do not edit by hand) -->";
const ASSEMBLE_END = "<!-- END THREADSHARE MEMORY -->";

function memoryDiagnostic(code, problem, next, result) {
  return cliDiagnostic(code, problem, { command: "memory", next, result });
}

/** Map a lower-module error to a registered CLI diagnostic. */
export function memoryFailure(error, action) {
  if (error?.name === "CliDiagnostic") return error;
  const code = error?.code;
  const next = `Run \`threadshare memory ${action ?? ""} --help\` and retry.`;
  if (typeof code === "string" && code.startsWith("MEMORY_REPOSITORY_")) {
    return memoryDiagnostic(
      "TS_INSIGHTS_REPOSITORY_INVALID",
      error.message ?? "the team memory repository could not be resolved",
      "Run `threadshare memory` from inside a non-bare Git worktree, or pass --repository <path>.",
    );
  }
  if (typeof code === "string" && DIAGNOSTIC_CODE_SET.has(code)) {
    return memoryDiagnostic(code, error.message ?? "memory command failed", next);
  }
  return memoryDiagnostic(
    "TS_OPERATION_FAILED",
    error instanceof Error ? error.message : String(error),
    next,
  );
}

// ---------------------------------------------------------------------------
// Invocation parsing (usage-level validation only; no I/O)
// ---------------------------------------------------------------------------

function assertAllowedOptions(action, options, allowed) {
  for (const [name, value] of Object.entries(options)) {
    if (value === undefined) continue;
    if (!allowed.includes(name)) {
      throw memoryDiagnostic(
        "TS_USAGE_OPTION_NOT_ALLOWED",
        `--${name} is not valid for memory ${action}.`,
        `Remove --${name}. Run \`threadshare memory ${action} --help\`.`,
      );
    }
  }
}

function parseFormat(action, options) {
  const format = options.format ?? "text";
  if (format !== "text" && format !== "json") {
    throw memoryDiagnostic(
      "TS_USAGE_INVALID_VALUE",
      `memory ${action} --format must be text or json.`,
      "Use --format text for people or --format json for agents.",
    );
  }
  return format;
}

function parseRunner(action, options, { required = true } = {}) {
  if (options.runner === undefined) {
    if (!required) return null;
    throw memoryDiagnostic(
      "TS_USAGE_OPTION_DEPENDENCY",
      `memory ${action} requires --runner <claude|codex>.`,
      `Run \`threadshare memory ${action} --runner codex\` or choose claude.`,
    );
  }
  if (!Object.hasOwn(RUNNER_ADAPTERS, options.runner)) {
    throw memoryDiagnostic(
      "TS_USAGE_INVALID_VALUE",
      `memory ${action} --runner must be claude or codex.`,
      "Choose a restricted runner that can pass deny-all conformance.",
    );
  }
  return options.runner;
}

/** Parse a `threadshare memory ...` invocation into a typed action object. */
export function parseMemoryInvocation(positionals, options) {
  const action = positionals[1];
  if (action === undefined) {
    throw memoryDiagnostic(
      "TS_USAGE_MISSING_ARGUMENT",
      "memory requires an action.",
      `Choose one of: ${MEMORY_ACTIONS.join(", ")}.`,
    );
  }
  if (!MEMORY_ACTIONS.includes(action)) {
    throw memoryDiagnostic(
      "TS_USAGE_INVALID_VALUE",
      `Unknown memory action: ${action}.`,
      `Choose one of: ${MEMORY_ACTIONS.join(", ")}.`,
    );
  }
  const rest = positionals.slice(2);
  switch (action) {
    case "init":
      assertAllowedOptions(action, options, ["repository"]);
      if (rest.length > 0) throw unexpectedPositional(action, rest[0]);
      return { action, repository: options.repository };
    case "status":
      assertAllowedOptions(action, options, ["repository", "format"]);
      if (rest.length > 0) throw unexpectedPositional(action, rest[0]);
      return { action, repository: options.repository, format: parseFormat(action, options) };
    case "lint":
      assertAllowedOptions(action, options, ["format", "repository"]);
      return {
        action,
        repository: options.repository,
        paths: rest,
        format: parseFormat(action, options),
      };
    case "assemble": {
      assertAllowedOptions(action, options, ["provider", "repository"]);
      if (rest.length > 0) throw unexpectedPositional(action, rest[0]);
      const provider = options.provider;
      if (provider === undefined) {
        throw memoryDiagnostic(
          "TS_USAGE_OPTION_DEPENDENCY",
          "memory assemble requires --provider <claude|codex>.",
          "Run `threadshare memory assemble --provider codex` or choose claude.",
        );
      }
      if (provider !== "claude" && provider !== "codex") {
        throw memoryDiagnostic(
          "TS_USAGE_INVALID_VALUE",
          "memory assemble --provider must be claude or codex.",
          "Choose the provider context file to update.",
        );
      }
      return { action, repository: options.repository, provider };
    }
    case "review":
      assertAllowedOptions(action, options, ["format", "repository", "kind"]);
      if (rest.length > 0) throw unexpectedPositional(action, rest[0]);
      if (options.kind !== undefined && options.kind !== "entry" && options.kind !== "consolidation") {
        throw memoryDiagnostic(
          "TS_USAGE_INVALID_VALUE",
          "memory review --kind must be entry or consolidation.",
          "Use --kind consolidation to review generated scene/doctrine operations.",
        );
      }
      return {
        action,
        repository: options.repository,
        kind: options.kind ?? "entry",
        format: parseFormat(action, options),
      };
    case "promote": {
      assertAllowedOptions(action, options, ["plan", "repository", "format"]);
      if (rest.length > 0) throw unexpectedPositional(action, rest[0]);
      if (options.plan === undefined) {
        throw memoryDiagnostic(
          "TS_USAGE_OPTION_DEPENDENCY",
          "memory promote requires --plan <planId>.",
          "Run `threadshare memory review` first, then `threadshare memory promote --plan <planId>`.",
        );
      }
      return {
        action,
        repository: options.repository,
        plan: options.plan,
        format: parseFormat(action, options),
      };
    }
    case "reverify-runner":
      assertAllowedOptions(action, options, ["runner", "runner-model", "runner-endpoint", "format"]);
      if (rest.length > 0) throw unexpectedPositional(action, rest[0]);
      return {
        action,
        runner: parseRunner(action, options),
        runnerModel: options["runner-model"],
        runnerEndpoint: options["runner-endpoint"],
        format: parseFormat(action, options),
      };
    case "consolidate": {
      assertAllowedOptions(action, options, [
        "repository", "runner", "runner-model", "runner-endpoint", "approve-plan",
        "if-due", "full", "format",
      ]);
      if (rest.length > 0) throw unexpectedPositional(action, rest[0]);
      if (options.full === true && options["if-due"] === true) {
        throw memoryDiagnostic(
          "TS_USAGE_OPTION_CONFLICT",
          "memory consolidate --full cannot be combined with --if-due.",
          "Choose a full replay or the 20-entry due gate.",
        );
      }
      if (options["approve-plan"] !== undefined &&
          (options.full === true || options["if-due"] === true ||
           options["runner-model"] !== undefined || options["runner-endpoint"] !== undefined)) {
        throw memoryDiagnostic(
          "TS_USAGE_OPTION_CONFLICT",
          "memory consolidate approval cannot change the pending task or runner settings.",
          "Approve the stored plan using only --runner and --approve-plan.",
        );
      }
      if ((options["runner-model"] === undefined) !== (options["runner-endpoint"] === undefined)) {
        throw memoryDiagnostic(
          "TS_USAGE_OPTION_DEPENDENCY",
          "--runner-model and --runner-endpoint must be supplied together.",
          "Provide both exact Codex delivery settings, or neither when approving a stored plan.",
        );
      }
      return {
        action,
        repository: options.repository,
        runner: parseRunner(action, options),
        runnerModel: options["runner-model"],
        runnerEndpoint: options["runner-endpoint"],
        approvePlan: options["approve-plan"],
        ifDue: options["if-due"] === true,
        full: options.full === true,
        format: parseFormat(action, options),
      };
    }
    case "extract": {
      assertAllowedOptions(action, options, [
        "repository", "runner", "runner-model", "runner-endpoint", "approve-plan",
        "approve-manifest", "limit", "format", "request",
      ]);
      if (rest.length > 0) throw unexpectedPositional(action, rest[0]);
      if (options["approve-plan"] !== undefined && options["approve-manifest"] !== undefined) {
        throw memoryDiagnostic(
          "TS_USAGE_OPTION_CONFLICT",
          "memory extract accepts only one of --approve-plan or --approve-manifest.",
          "Pass a single authorization digest.",
        );
      }
      if ((options["approve-plan"] !== undefined || options["approve-manifest"] !== undefined) &&
          options.request !== undefined) {
        throw memoryDiagnostic(
          "TS_USAGE_OPTION_CONFLICT",
          "memory extract approval cannot be combined with --request.",
          "Approve the stored plan by digest alone; use --request only to create a new preview.",
        );
      }
      if ((options["approve-plan"] !== undefined || options["approve-manifest"] !== undefined) &&
          (options["runner-model"] !== undefined || options["runner-endpoint"] !== undefined)) {
        throw memoryDiagnostic(
          "TS_USAGE_OPTION_CONFLICT",
          "memory extract approval cannot override the pending runner model or endpoint.",
          "Approve the stored plan by digest; its exact runner profile is already bound and private.",
        );
      }
      if ((options["runner-model"] === undefined) !== (options["runner-endpoint"] === undefined)) {
        throw memoryDiagnostic(
          "TS_USAGE_OPTION_DEPENDENCY",
          "--runner-model and --runner-endpoint must be supplied together.",
          "Provide both exact Codex delivery settings, or neither when approving a stored plan.",
        );
      }
      if (options["approve-plan"] === undefined && options["approve-manifest"] === undefined &&
          options.request === undefined) {
        throw memoryDiagnostic(
          "TS_USAGE_OPTION_DEPENDENCY",
          "memory extract requires --request <file|-> when creating a new plan.",
          "Provide an explicit Insights time window and optional filters in the request.",
        );
      }
      let limit = 1;
      if (options.limit !== undefined) {
        if (!/^[1-9][0-9]*$/.test(options.limit) || Number(options.limit) > 50) {
          throw memoryDiagnostic(
            "TS_USAGE_INVALID_VALUE",
            "memory extract --limit must be an integer from 1 to 50.",
            "Use a small positive integer.",
          );
        }
        limit = Number(options.limit);
      }
      return {
        action,
        repository: options.repository,
        runner: parseRunner(action, options),
        runnerModel: options["runner-model"],
        runnerEndpoint: options["runner-endpoint"],
        approvePlan: options["approve-plan"],
        approveManifest: options["approve-manifest"],
        requestSource: options.request,
        limit,
        format: parseFormat(action, options),
      };
    }
    default:
      throw unexpectedPositional(action, rest[0]);
  }
}

function unexpectedPositional(action, value) {
  return memoryDiagnostic(
    "TS_USAGE_UNEXPECTED_ARGUMENT",
    `Unexpected argument for memory ${action}: ${value}.`,
    `Run \`threadshare memory ${action} --help\`.`,
  );
}

// ---------------------------------------------------------------------------
// Engine + owner bootstrap
// ---------------------------------------------------------------------------

function sha256Hex(value) {
  return createHash("sha256").update(value).digest("hex");
}

/** git hash-object semantics: sha1("blob <len>\0" + bytes). */
function gitBlobOid(buffer) {
  return createHash("sha1")
    .update(`blob ${buffer.length}\0`)
    .update(buffer)
    .digest("hex");
}

async function pathExists(target) {
  try {
    await access(target);
    return true;
  } catch {
    return false;
  }
}

async function existingPathInfo(target) {
  try {
    return await lstat(target);
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

function unsafeMemoryPath(target, reason) {
  const memoryMarker = `${path.sep}.threadshare${path.sep}`;
  const memoryIndex = target.indexOf(memoryMarker);
  const display = memoryIndex === -1
    ? path.basename(target)
    : `.threadshare/${target.slice(memoryIndex + memoryMarker.length).replaceAll(path.sep, "/")}`;
  throw memoryDiagnostic(
    "TS_OPERATION_FAILED",
    `Refusing unsafe Team Memory path ${display}: ${reason}.`,
    "Replace the path with a real directory or regular file inside the bound worktree, then retry.",
  );
}

async function ensureDirectoryNoSymlink(target) {
  try {
    await mkdir(target);
    return true;
  } catch (error) {
    if (error?.code !== "EEXIST") throw error;
  }
  const info = await lstat(target);
  if (info.isSymbolicLink()) unsafeMemoryPath(target, "symbolic links are not allowed");
  if (!info.isDirectory()) unsafeMemoryPath(target, "a directory is required");
  return false;
}

async function assertExistingPathKind(target, kind) {
  const info = await existingPathInfo(target);
  if (info === null) return null;
  if (info.isSymbolicLink()) unsafeMemoryPath(target, "symbolic links are not allowed");
  if (kind === "directory" && !info.isDirectory()) unsafeMemoryPath(target, "a directory is required");
  if (kind === "file" && !info.isFile()) unsafeMemoryPath(target, "a regular file is required");
  return info;
}

async function writeTextAtomic(directory, filename, text, mode = 0o644) {
  const temporary = path.join(
    directory,
    `.${filename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, text, { flag: "wx", mode });
    await rename(temporary, path.join(directory, filename));
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function readTextNoFollow(filename, { missing = false } = {}) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile()) unsafeMemoryPath(filename, "a regular file is required");
    return { text: await handle.readFile("utf8"), mode: info.mode & 0o777 };
  } catch (error) {
    if (missing && error?.code === "ENOENT") return null;
    if (error?.code === "ELOOP") unsafeMemoryPath(filename, "symbolic links are not allowed");
    throw error;
  } finally {
    await handle?.close();
  }
}

/**
 * Open the shared machine origin secret, spawn an in-memory engine (no `--db`,
 * so insights.sqlite3 is never created or touched — design DEV-5), open the
 * on-disk memory-state under `<state-dir>/memory/`, and resolve + bind the
 * owner repository. Returns a context whose `close()` shuts the engine down.
 */
async function openMemoryContext(invocation, options) {
  const paths = options.paths ?? resolveInsightsPaths(options);
  const state = await openInsightsState({ ...options.stateOptions, paths });
  const memoryStateDir = path.join(paths.stateDirectory, "memory");
  await mkdir(memoryStateDir, { recursive: true, mode: 0o700 });

  const engine = await createInsightsEngineClient({
    requiredContract: insightsRequiredContract(state.originSecretEpoch),
    childEnv: insightsChildEnv(paths, options),
    runtimeOptions: options.runtimeOptions,
    timeoutMs: options.timeoutMs,
  });

  try {
    const opened = await memoryOpen(engine, { stateDir: paths.stateDirectory });
    let binding = null;
    let rootRealpath = null;
    if (invocation.resolveOwner !== false) {
      const resolved = await resolveRepositoryBinding({
        cwd: invocation.repository ?? options.cwd ?? process.cwd(),
        repositoryPath: invocation.repository,
        originSecret: state.originSecret,
      }, options.repositoryOptions);
      binding = resolved.binding;
      rootRealpath = resolved.rootRealpath;
      await memoryBindRepository(engine, {
        repositoryKey: binding.repositoryKey,
        worktreeKey: binding.worktreeKey,
        publicRepositoryIdentity: binding.publicRepositoryIdentity,
        rootRealpath,
        rootRealpathDigest: binding.rootRealpathDigest,
        commonDirDevice: binding.commonDirectoryIdentity.device,
        commonDirInode: binding.commonDirectoryIdentity.inode,
      });
    }
    return {
      paths, state, engine, memoryStateDir,
      memoryStateUuid: opened.memoryStateUuid,
      binding, rootRealpath,
      originSecret: state.originSecret,
      insightsReader: null,
      owner: binding === null
        ? null
        : { repositoryKey: binding.repositoryKey, worktreeKey: binding.worktreeKey },
      async close() {
        try {
          await this.insightsReader?.close();
        } finally {
          await engine.close();
        }
      },
    };
  } catch (error) {
    await engine.close();
    throw error;
  }
}

function memoryInsightsReader(context, options) {
  if (context.insightsReader === null) {
    const createReader = options.createInsightsReader ?? createInsightsQueryReader;
    context.insightsReader = createReader({
      paths: context.paths,
      originSecretEpoch: context.state.originSecretEpoch,
      runtimeOptions: options.runtimeOptions,
      childEnv: options.childEnv,
      timeoutMs: options.timeoutMs,
    });
  }
  return context.insightsReader;
}

function approvedTreeDigest(entries) {
  return sha256Hex(canonicalJson({
    format: "threadshare-memory-source-tree@v1",
    entries: entries.map((entry) => ({ path: entry.path, contentDigest: entry.contentDigest })),
  }));
}

function contentRevision(contentDigest) {
  return Number.parseInt(contentDigest.slice(0, 13), 16) + 1;
}

function partialApprovedScan(entries = []) {
  return { coverage: "partial", sourceTreeDigest: approvedTreeDigest(entries), entries: [] };
}

async function readApprovedEntry(context, name) {
  const filename = `${MEMORY_ROOT}/entries/${name}`;
  const { content: text } = await memoryReadFile(context.engine, {
    ...context.owner,
    collection: "entries",
    name,
  });
  if (text === null) return null;
  const bytes = Buffer.from(text, "utf8");
  try {
    const gate = lintEntryForPromotion(text);
    if (!gate.ok) {
      const codes = gate.findings.filter((finding) => finding.severity === "block")
        .map((finding) => finding.code).join(", ");
      unsafeMemoryPath(filename, `the promotion lint gate failed${codes ? ` (${codes})` : ""}`);
    }
    const parsed = parseMemoryEntry(text);
    const expectedId = name.slice(0, -3);
    if (parsed.frontmatter.id !== expectedId) {
      unsafeMemoryPath(filename, `frontmatter id must match filename ${expectedId}`);
    }
    const searchableText = [
      parsed.frontmatter.id,
      parsed.frontmatter.type,
      parsed.frontmatter.scene,
      parsed.body,
    ].filter((value) => typeof value === "string" && value.length > 0).join("\n");
    if (Buffer.byteLength(searchableText, "utf8") > MEMORY_MAX_TEXT_BYTES) {
      unsafeMemoryPath(filename, "searchable entry text exceeds 64 KiB");
    }
    const contentDigest = sha256Hex(bytes);
    return {
      path: filename,
      contentDigest,
      projected: {
        entryId: parsed.frontmatter.id,
        revision: contentRevision(contentDigest),
        contentDigest,
        frontmatter: parsed.frontmatter,
        bodyText: parsed.body,
        status: parsed.frontmatter.status,
        searchableText,
      },
    };
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
}

async function scanApprovedEntries(context) {
  const { names: namesBefore } = await memoryListFiles(context.engine, {
    ...context.owner,
    collection: "entries",
  });
  if (namesBefore.length > MEMORY_MAX_SYNC_ENTRIES) {
    unsafeMemoryPath(`${MEMORY_ROOT}/entries`, `approved entry count exceeds ${MEMORY_MAX_SYNC_ENTRIES}`);
  }
  const observed = [];
  for (const name of namesBefore) {
    const entry = await readApprovedEntry(context, name);
    if (entry === null) return partialApprovedScan(observed);
    observed.push(entry);
  }
  const { names: namesAfter } = await memoryListFiles(context.engine, {
    ...context.owner,
    collection: "entries",
  });
  if (canonicalJson(namesAfter) !== canonicalJson(namesBefore)) {
    return partialApprovedScan(observed);
  }
  return {
    coverage: "complete",
    sourceTreeDigest: approvedTreeDigest(observed),
    entries: observed.map((entry) => entry.projected),
  };
}

async function syncApprovedProjectionSnapshot(context) {
  const current = await memorySearch(context.engine, {
    ...context.owner,
    query: "threadshare",
    limit: 1,
  });
  let expectedGeneration = current.generation;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const scan = await scanApprovedEntries(context);
    const result = await memorySyncApproved(context.engine, {
      ...context.owner,
      sourceTreeDigest: scan.sourceTreeDigest,
      coverage: scan.coverage,
      expectedGeneration,
      entries: scan.entries,
    });
    if (result.status === "synced") return { projection: result, scan };
    expectedGeneration = result.generation;
  }
  throw memoryDiagnostic(
    "TS_OPERATION_FAILED",
    "Approved Team Memory changed concurrently during projection sync.",
    "Retry the same explicit memory command after repository writes finish.",
  );
}

async function syncApprovedProjection(context) {
  return (await syncApprovedProjectionSnapshot(context)).projection;
}

async function readConsolidationSources(context) {
  const scenes = [];
  const { names: namesBefore } = await memoryListFiles(context.engine, {
    ...context.owner,
    collection: "scenes",
  });
  for (const filename of namesBefore) {
    const name = filename.slice(0, -3);
    const { content } = await memoryReadFile(context.engine, {
      ...context.owner,
      collection: "scenes",
      name: filename,
    });
    if (content === null) {
      throw memoryDiagnostic(
        "TS_MEMORY_BINDING_DRIFT",
        "A scene changed while consolidation sources were read.",
        "Retry after repository writes finish.",
      );
    }
    const parsed = parseSceneMeta(content);
    scenes.push({
      name,
      contentDigest: sha256Hex(Buffer.from(content, "utf8")),
      heat: parsed.meta.heat,
      content,
    });
  }
  const { names: namesAfter } = await memoryListFiles(context.engine, {
    ...context.owner,
    collection: "scenes",
  });
  if (canonicalJson(namesBefore) !== canonicalJson(namesAfter)) {
    throw memoryDiagnostic(
      "TS_MEMORY_BINDING_DRIFT",
      "The scene set changed while consolidation sources were read.",
      "Retry after repository writes finish.",
    );
  }
  const { content: doctrineSource } = await memoryReadFile(context.engine, {
    ...context.owner,
    collection: "doctrine",
    name: null,
  });
  let doctrine = null;
  if (doctrineSource !== null) {
    validateDoctrine(doctrineSource);
    doctrine = {
      contentDigest: sha256Hex(Buffer.from(doctrineSource, "utf8")),
      content: doctrineSource,
    };
  }
  return { scenes, doctrine };
}

function assertConsolidationSourcesMatch(binding, sources) {
  const sceneRevisions = sources.scenes.map(({ name, contentDigest, heat }) => ({
    name, contentDigest, heat,
  }));
  const doctrineDigest = sources.doctrine?.contentDigest ?? null;
  if (canonicalJson(sceneRevisions) !== canonicalJson(binding?.sceneRevisions)
      || memoryDigestHex(sceneRevisions) !== binding?.sceneIndexDigest
      || doctrineDigest !== binding?.doctrineDigest) {
    throw memoryDiagnostic(
      "TS_MEMORY_BINDING_DRIFT",
      "Scenes or doctrine changed after the consolidation patch was generated.",
      "Discard or regenerate the consolidation patch before reviewing it.",
    );
  }
}

async function consolidationDatabaseUuid(context, options) {
  const readConfig = options.readInsightsConfig ?? readExistingInsightsConfig;
  const config = await readConfig({ paths: context.paths });
  const scope = resolveMemoryInsightsScope({
    config,
    privacyContext: context.state.privacyContext,
    rootRealpath: context.rootRealpath,
    providers: [],
    publicRepositoryIdentity: context.binding.publicRepositoryIdentity,
  });
  const response = await memoryInsightsReader(context, options).search({
    query: "",
    filters: {
      providers: [],
      projectKeys: scope.projectKeys,
      observedAtOrAfterUnixMs: null,
      observedBeforeUnixMs: null,
      toolCapabilityKeys: [],
      skillCapabilityKeys: [],
      resultEvidence: [],
      closureStates: ["hard-sealed"],
      capabilityTerminalStates: [],
    },
    orderBy: "observed-desc",
    limit: 1,
    pathLimit: 0,
    nowUnixMs: String(typeof options.now === "function" ? options.now() : Date.now()),
    quiescenceSeconds: 300,
  }, { signal: options.signal });
  if (typeof response?.databaseUuid !== "string" || response.databaseUuid.length === 0) {
    throw memoryDiagnostic(
      "TS_INSIGHTS_ENGINE_PROTOCOL",
      "Insights Search omitted the database identity needed for consolidation binding.",
      "Run `threadshare insights sync`, then retry consolidation.",
    );
  }
  return response.databaseUuid;
}

// ---------------------------------------------------------------------------
// init / status
// ---------------------------------------------------------------------------

async function runInit(invocation, options) {
  const context = await openMemoryContext(invocation, options);
  try {
    const memoryRootAbs = path.join(context.rootRealpath, MEMORY_ROOT);
    const created = [];
    await ensureDirectoryNoSymlink(path.join(context.rootRealpath, ".threadshare"));
    await ensureDirectoryNoSymlink(memoryRootAbs);
    for (const sub of MEMORY_SUBDIRS) {
      const dir = path.join(memoryRootAbs, sub);
      if (await ensureDirectoryNoSymlink(dir)) created.push(path.join(MEMORY_ROOT, sub));
    }
    const indexFile = path.join(memoryRootAbs, "index.json");
    const indexInfo = await assertExistingPathKind(indexFile, "file");
    if (indexInfo === null) {
      try {
        await writeFile(
          indexFile,
          `${JSON.stringify({ format: "threadshare-memory-index@v1", entries: [], scenes: [] }, null, 2)}\n`,
          { flag: "wx", mode: 0o644 },
        );
      } catch (error) {
        if (error?.code !== "EEXIST") throw error;
        await assertExistingPathKind(indexFile, "file");
      }
      created.push(path.join(MEMORY_ROOT, "index.json"));
    }
    const approvedProjection = await syncApprovedProjection(context);
    return {
      action: "init",
      memoryStateUuid: context.memoryStateUuid,
      publicRepositoryIdentity: context.binding.publicRepositoryIdentity,
      memoryRoot: MEMORY_ROOT,
      created,
      approvedProjection,
    };
  } finally {
    await context.close();
  }
}

async function runStatus(invocation, options) {
  const context = await openMemoryContext(invocation, options);
  try {
    const status = await memoryStatus(context.engine, context.owner);
    return { action: "status", memoryRoot: MEMORY_ROOT, ...status };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// lint
// ---------------------------------------------------------------------------

async function collectLintTargets(invocation, options) {
  const cwd = invocation.repository ?? options.cwd ?? process.cwd();
  if (invocation.paths.length > 0) {
    return invocation.paths.map((p) => path.resolve(cwd, p));
  }
  const entriesDir = path.join(cwd, MEMORY_ROOT, "entries");
  let names;
  try {
    names = await readdir(entriesDir);
  } catch {
    return [];
  }
  return names.filter((n) => n.endsWith(".md")).sort().map((n) => path.join(entriesDir, n));
}

async function runLint(invocation, options) {
  const targets = await collectLintTargets(invocation, options);
  const files = [];
  let blocked = false;
  for (const target of targets) {
    let text;
    try {
      text = await readFile(target, "utf8");
    } catch (error) {
      throw memoryDiagnostic(
        "TS_INPUT_READ_FAILED",
        `Unable to read ${path.basename(target)} for lint.`,
        "Pass existing entry files, or run from the repository root.",
      );
    }
    const { ok, findings } = lintEntryForPromotion(text);
    if (!ok) blocked = true;
    files.push({
      path: path.relative(invocation.repository ?? options.cwd ?? process.cwd(), target),
      ok,
      findings: findings.map((f) => ({ code: f.code, severity: f.severity, excerpt: f.excerpt })),
    });
  }
  return { action: "lint", blocked, files };
}

// ---------------------------------------------------------------------------
// review -> promotion plan
// ---------------------------------------------------------------------------

function reviewStatement(item, assessment) {
  const statements = Array.isArray(item.payload?.reviewStatements)
    ? item.payload.reviewStatements
    : [];
  return statements.find((statement) => statement.statementId === assessment.statementId) ?? {
    statementId: assessment.statementId,
    text: "(statement text unavailable)",
    evidence: [],
  };
}

async function consolidationReviewItem(context, item) {
  const approved = await scanApprovedEntries(context);
  const baseline = await memoryConsolidationBaseline(context.engine, context.owner);
  if (approved.coverage !== "complete" ||
      approved.sourceTreeDigest !== item.payload?.binding?.approvedProjection?.sourceTreeDigest ||
      baseline.successfulRunId !== item.payload?.binding?.replay?.afterSuccessfulRunId) {
    throw memoryDiagnostic(
      "TS_MEMORY_BINDING_DRIFT",
      "Approved L1 memory changed after the consolidation patch was generated.",
      "Discard or regenerate the consolidation patch before reviewing it.",
    );
  }
  const sources = await readConsolidationSources(context);
  assertConsolidationSourcesMatch(item.payload?.binding, sources);
  const sceneByName = new Map(sources.scenes.map((scene) => [scene.name, scene.content]));
  const currentContent = (operation) => operation.target === "doctrine"
    ? sources.doctrine?.content ?? null
    : sceneByName.get(operation.name) ?? null;
  const reviewTargetBlobHashes = new Map();
  for (const file of consolidationFilesFromOperations(item.payload?.operations ?? [])) {
    const name = path.basename(file.targetPath, ".md");
    const content = file.targetPath === `${MEMORY_ROOT}/doctrine.md`
      ? sources.doctrine?.content ?? null
      : sceneByName.get(name) ?? null;
    reviewTargetBlobHashes.set(
      file.targetPath,
      content === null ? null : gitBlobOid(Buffer.from(content, "utf8")),
    );
  }
  const statements = [];
  for (const statement of item.payload?.statements ?? []) {
    const operation = statement.operation;
    if (operation === null || typeof operation !== "object") continue;
    const targetPath = operation.target === "doctrine"
      ? `${MEMORY_ROOT}/doctrine.md`
      : `${MEMORY_ROOT}/scenes/${operation.name}.md`;
    const before = currentContent(operation) ?? "(file does not exist)";
    const after = operation.op === "delete" ? "(file will be deleted)" : operation.newContent;
    const mergeDeletes = operation.op === "merge"
      ? operation.mergeSources
          .filter((source) => source !== operation.name)
          .flatMap((source) => [
            `--- delete ${MEMORY_ROOT}/scenes/${source}.md`,
            sceneByName.get(source) ?? "(file does not exist)",
            "+++ deleted",
            "(file will be deleted)",
          ])
      : [];
    statements.push({
      statementId: statement.statementId,
      text: [
        `${operation.op.toUpperCase()} ${operation.target} ${operation.name}`,
        `Target: ${targetPath}`,
        `Merge sources: ${operation.mergeSources.length > 0 ? operation.mergeSources.join(", ") : "none"}`,
        `Rationale: ${operation.rationale}`,
        "--- current",
        before,
        "+++ proposed",
        after,
        ...mergeDeletes,
      ].join("\n"),
      evidence: operation.basedOnEntryIds.map((entryId) => ({
        kind: "approved-entry",
        display: entryId,
        excerpt: null,
      })),
    });
  }
  return {
    ...item,
    reviewTargetBlobHashes,
    payload: { ...item.payload, reviewStatements: statements },
  };
}

/** Create the human-only adapter used by `memory review` in a real TTY. */
export function createMemoryReviewConfirmer({ input, output }) {
  if (input?.isTTY !== true || output?.isTTY !== true) return null;
  const prompt = createInterface({ input, output });
  return {
    async confirmStatement(item, assessment) {
      const statement = reviewStatement(item, assessment);
      output.write(`\nCandidate: ${item.candidateId}\n`);
      output.write(`Statement: ${statement.text}\n`);
      for (const evidence of statement.evidence ?? []) {
        output.write(`Evidence (${evidence.kind}): ${evidence.display}\n`);
        if (evidence.excerpt) output.write(`  Excerpt: ${evidence.excerpt}\n`);
      }
      output.write(`Provenance: ${assessment.provenanceStrength}\n`);
      output.write(`Claim support: ${assessment.claimSupport}\n`);
      output.write(`Limitations: ${assessment.limitations.length > 0 ? assessment.limitations.join(", ") : "none"}\n`);
      const answer = await prompt.question("Confirm this statement? [y/N]: ");
      return answer.trim().toLowerCase() === "y";
    },
    close() {
      prompt.close();
    },
  };
}

function slugify(value) {
  const slug = String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
  return slug.length > 0 ? slug : "memory-entry";
}

const STRENGTH_TO_FRONTMATTER = new Set(["direct", "observed", "candidate", "contextual", "unknown"]);
const STRENGTH_RANK = Object.freeze({ direct: 0, observed: 1, candidate: 2, contextual: 3, unknown: 4 });

function sanitizedEntryFor(item, confirmedStatements) {
  const payload = item.payload ?? {};
  const type = ["work_fact", "work_task", "work_method", "work_artifact"].includes(payload.type)
    ? payload.type
    : "work_fact";
  const confidence = ["high", "medium", "low"].includes(payload.confidence) ? payload.confidence : "medium";
  const priority = Number.isSafeInteger(payload.priority) && payload.priority >= 0 && payload.priority <= 100
    ? payload.priority
    : 50;
  const strengths = confirmedStatements
    .map((s) => s.provenanceStrength)
    .filter((s) => STRENGTH_TO_FRONTMATTER.has(s));
  const provenanceStrength = strengths.length === 0
    ? "unknown"
    : strengths.reduce(
        (weakest, strength) => STRENGTH_RANK[strength] > STRENGTH_RANK[weakest] ? strength : weakest,
        strengths[0],
      );
  const limitations = [...new Set(confirmedStatements.flatMap((s) => s.limitations ?? []))].sort();
  const supports = new Set(confirmedStatements.map((statement) => statement.claimSupport));
  const claimSupport = supports.size === 1
    ? supports.values().next().value
    : "mixed";
  const id = slugify(payload.id ?? payload.content ?? item.candidateId);
  const frontmatter = {
    id,
    type,
    status: "approved",
    priority,
    confidence,
    provenance_strength: provenanceStrength,
    claim_support: claimSupport,
    limitations,
    scope: "repo",
    scene: typeof payload.scene === "string" && payload.scene.length > 0 ? payload.scene : null,
    occurred: [],
    evidence: { commits: [], paths: [] },
    superseded_by: null,
  };
  const body = `${String(payload.content ?? "").trim()}\n`;
  return { id, text: serializeMemoryEntry({ frontmatter, body }) };
}

async function runReview(invocation, options) {
  const context = await openMemoryContext(invocation, options);
  try {
    const queue = await memoryReviewQueue(context.engine, {
      ...context.owner,
      kind: invocation.kind ?? "entry",
    });
    const interactive = invocation.format !== "json" &&
      typeof options.confirmStatement === "function";
    const pending = [];
    const confirmedCandidates = [];
    for (const queuedItem of queue.items) {
      const item = queuedItem.candidateKind === "consolidation-patch"
        ? await consolidationReviewItem(context, queuedItem)
        : queuedItem;
      const confirmedStatements = [];
      let allConfirmed = item.assessments.length > 0;
      for (const assessment of item.assessments) {
        const alreadySupported =
          (assessment.claimSupport === "typed-fact" && assessment.assessedBy === "deterministic") ||
          (assessment.claimSupport === "human-confirmed" && assessment.assessedBy === "human");
        if (alreadySupported) {
          confirmedStatements.push(assessment);
          continue;
        }
        const decision = interactive ? await options.confirmStatement(item, assessment) : false;
        if (!decision) {
          allConfirmed = false;
          continue;
        }
        const result = await memoryConfirmStatement(context.engine, {
          candidateId: item.candidateId,
          statementId: assessment.statementId,
          statementTextDigest: assessment.statementTextDigest,
          citationsDigest: assessment.citationsDigest,
        });
        if (result.status !== "confirmed") {
          allConfirmed = false;
          continue;
        }
        confirmedStatements.push({
          ...assessment,
          claimSupport: "human-confirmed",
          assessedBy: "human",
        });
      }
      if (allConfirmed && confirmedStatements.length > 0) {
        confirmedCandidates.push({ item, confirmedStatements });
      } else {
        pending.push({ candidateId: item.candidateId, statements: item.assessments.length });
      }
    }

    if (confirmedCandidates.length === 0) {
      return {
        action: "review",
        interactive,
        pending,
        plan: null,
        note: interactive
          ? "No candidate was fully confirmed; nothing to promote."
          : "Non-interactive review lists pending confirmations only; weak evidence is never auto-confirmed. Re-run in a TTY to confirm.",
      };
    }

    const perFile = [];
    const candidateIds = [];
    const rootRealpath = context.rootRealpath;
    for (const { item, confirmedStatements } of confirmedCandidates) {
      if (item.candidateKind === "consolidation-patch") {
        const files = consolidationFilesFromOperations(item.payload.operations ?? []);
        for (const file of files) {
          if (!item.reviewTargetBlobHashes?.has(file.targetPath)) {
            throw memoryDiagnostic(
              "TS_MEMORY_BINDING_DRIFT",
              `Consolidation target ${file.targetPath} was not part of the reviewed snapshot.`,
              "Discard or regenerate the consolidation patch.",
            );
          }
          const targetBlobHash = item.reviewTargetBlobHashes.get(file.targetPath);
          if (file.operation === "delete" && targetBlobHash === null) {
            throw memoryDiagnostic(
              "TS_MEMORY_BINDING_DRIFT",
              `Consolidation delete target ${file.targetPath} no longer exists.`,
              "Discard or regenerate the consolidation patch.",
            );
          }
          perFile.push({
            targetPath: file.targetPath,
            operation: file.operation,
            sanitizedContent: file.content === null
              ? null
              : Buffer.from(file.content, "utf8").toString("base64"),
            targetBlobHash,
          });
        }
        candidateIds.push(item.candidateId);
        continue;
      }
      const entry = sanitizedEntryFor(item, confirmedStatements);
      const gate = lintEntryForPromotion(entry.text);
      if (!gate.ok) {
        pending.push({ candidateId: item.candidateId, blockedByLint: true });
        continue;
      }
      const targetPath = `${MEMORY_ROOT}/entries/${entry.id}.md`;
      const buffer = Buffer.from(entry.text, "utf8");
      let targetBlobHash = null;
      const absolute = path.join(rootRealpath, targetPath);
      if (await pathExists(absolute)) {
        targetBlobHash = gitBlobOid(await readFile(absolute));
      }
      perFile.push({
        targetPath,
        operation: "write",
        sanitizedContent: buffer.toString("base64"),
        targetBlobHash,
      });
      candidateIds.push(item.candidateId);
    }

    if (perFile.length === 0) {
      return { action: "review", interactive, pending, plan: null,
        note: "Every confirmed candidate was blocked by the sanitization lint gate." };
    }

    const planned = await memoryPromotionPlan(context.engine, {
      owner: context.owner,
      candidateIds,
      policyVersion: POLICY_VERSION,
      perFile,
    });

    await persistPlanArtifact(context.memoryStateDir, {
      planId: planned.planId,
      planDigest: planned.planDigest,
      owner: context.owner,
      files: planned.files,
    });

    return {
      action: "review",
      interactive,
      pending,
      plan: {
        planId: planned.planId,
        planDigest: planned.planDigest,
        status: planned.status,
        candidateIds: planned.candidateIds,
        files: planned.files,
      },
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// promote
// ---------------------------------------------------------------------------

function planArtifactPath(memoryStateDir, planId) {
  return path.join(memoryStateDir, "plans", `${planId}.json`);
}

async function persistPlanArtifact(memoryStateDir, artifact) {
  await writePrivateJsonAtomic(
    path.join(memoryStateDir, "plans"),
    `${artifact.planId}.json`,
    artifact,
  );
}

async function runPromote(invocation, options) {
  const context = await openMemoryContext(invocation, options);
  try {
    let artifact;
    try {
      artifact = JSON.parse(await readFile(planArtifactPath(context.memoryStateDir, invocation.plan), "utf8"));
    } catch {
      throw memoryDiagnostic(
        "TS_INPUT_READ_FAILED",
        `No local record for plan ${invocation.plan}.`,
        "Run `threadshare memory review` to (re)generate the plan, then promote it.",
      );
    }
    try {
      await memoryPromotionApprove(context.engine, {
        planId: invocation.plan,
        planDigest: artifact.planDigest,
      });
    } catch (error) {
      if (error?.code !== "TS_MEMORY_PLAN_STATE_INVALID") throw error;
      // An applied plan cannot be approved again, but promotion-apply is
      // intentionally idempotent. Let apply distinguish applied from voided or
      // otherwise invalid states so a failed projection sync can be retried.
    }
    const applied = await memoryPromotionApply(context.engine, {
      planId: invocation.plan,
      ownerRootRealpath: context.rootRealpath,
    });
    if (applied.status === "voided") {
      return {
        action: "promote",
        planId: invocation.plan,
        status: "voided",
        driftedPath: applied.driftedPath,
        note: "A target blob drifted since the plan was generated; the plan is voided. Re-run `threadshare memory review`.",
      };
    }
    let approvedProjection;
    try {
      approvedProjection = await syncApprovedProjection(context);
    } catch {
      throw memoryDiagnostic(
        "TS_OPERATION_FAILED",
        `Promotion plan ${invocation.plan} was applied, but the approved search projection did not sync.`,
        `Re-run \`threadshare memory promote --plan ${invocation.plan}\` after repository writes finish.`,
        `Plan ${invocation.plan} is already applied; worktree files were not rolled back.`,
      );
    }
    return {
      action: "promote",
      planId: invocation.plan,
      status: "applied",
      idempotent: applied.idempotent,
      appliedFiles: applied.appliedFiles,
      candidates: applied.candidates,
      approvedProjection,
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// assemble
// ---------------------------------------------------------------------------

async function runAssemble(invocation, options) {
  const context = await openMemoryContext(invocation, options);
  try {
    const cwd = context.rootRealpath;
    const memoryRootAbs = path.join(cwd, MEMORY_ROOT);
    await assertExistingPathKind(path.join(cwd, ".threadshare"), "directory");
    await assertExistingPathKind(memoryRootAbs, "directory");

    let doctrine = null;
    const doctrineFile = path.join(memoryRootAbs, "doctrine.md");
    if (await assertExistingPathKind(doctrineFile, "file")) {
      const { text } = await readTextNoFollow(doctrineFile);
      validateDoctrine(text);
      doctrine = text.trim();
    }

    const scenes = [];
    const scenesDir = path.join(memoryRootAbs, "scenes");
    if (await assertExistingPathKind(scenesDir, "directory")) {
      const names = (await readdir(scenesDir)).filter((n) => n.endsWith(".md")).sort();
      for (const name of names) {
        const sceneFile = path.join(scenesDir, name);
        await assertExistingPathKind(sceneFile, "file");
        const meta = parseSceneMeta((await readTextNoFollow(sceneFile)).text);
        scenes.push({
          name: name.replace(/\.md$/, ""),
          summary: meta.meta.summary,
          heat: meta.meta.heat,
        });
      }
    }
    scenes.sort((left, right) => right.heat - left.heat || left.name.localeCompare(right.name));
    const omittedScenes = Math.max(0, scenes.length - 15);
    const visibleScenes = scenes.slice(0, 15);

    const blockLines = [ASSEMBLE_BEGIN, ""];
    blockLines.push("## Team memory", "");
    if (doctrine !== null) {
      blockLines.push(doctrine, "");
    } else {
      blockLines.push("_No approved team doctrine yet._", "");
    }
    if (visibleScenes.length > 0) {
      blockLines.push("### Scenes", "");
      for (const scene of visibleScenes) {
        blockLines.push(
          `- ${MEMORY_ROOT}/scenes/${scene.name}.md (heat ${scene.heat}) — ${scene.summary}`,
        );
      }
      if (omittedScenes > 0) blockLines.push(`- _${omittedScenes} additional scene(s) omitted._`);
      blockLines.push("");
    }
    blockLines.push(ASSEMBLE_END);
    const block = blockLines.join("\n");

    const approvedProjection = await syncApprovedProjection(context);
    const targetName = invocation.provider === "codex" ? "AGENTS.md" : "CLAUDE.md";
    const targetFile = path.join(cwd, targetName);
    const target = await readTextNoFollow(targetFile, { missing: true });
    const existing = target?.text ?? "";
    const next = spliceGeneratedBlock(existing, block);
    const changed = next !== existing;
    if (changed) {
      await writeTextAtomic(cwd, targetName, next, target?.mode ?? 0o644);
    }
    return {
      action: "assemble",
      provider: invocation.provider,
      target: targetName,
      doctrine: doctrine !== null,
      scenes: visibleScenes.length,
      omittedScenes,
      changed,
      approvedProjection,
    };
  } finally {
    await context.close();
  }
}

function spliceGeneratedBlock(existing, block) {
  const begin = existing.indexOf(ASSEMBLE_BEGIN);
  const nextBegin = begin === -1 ? -1 : existing.indexOf(ASSEMBLE_BEGIN, begin + ASSEMBLE_BEGIN.length);
  const endMarker = existing.indexOf(ASSEMBLE_END);
  const nextEnd = endMarker === -1 ? -1 : existing.indexOf(ASSEMBLE_END, endMarker + ASSEMBLE_END.length);
  if (begin === -1 && endMarker === -1) {
    const separator = existing.length === 0 || existing.endsWith("\n\n")
      ? ""
      : existing.endsWith("\n") ? "\n" : "\n\n";
    return `${existing}${separator}${block}\n`;
  }
  if (begin === -1 || endMarker === -1 || nextBegin !== -1 || nextEnd !== -1 || begin >= endMarker) {
    throw memoryDiagnostic(
      "TS_OPERATION_FAILED",
      "The provider context file has missing, duplicate, or out-of-order Threadshare memory markers.",
      "Repair the single BEGIN/END marker pair without changing user content, then rerun assemble.",
    );
  }
  const end = endMarker + ASSEMBLE_END.length;
  return `${existing.slice(0, begin)}${block}${existing.slice(end)}`;
}

// ---------------------------------------------------------------------------
// runner conformance (local signed cache; there is no engine op for it)
// ---------------------------------------------------------------------------

function conformancePath(memoryStateDir, profileName) {
  return path.join(memoryStateDir, "conformance", `${profileName}.json`);
}

async function loadConformance(memoryStateDir, profileName) {
  try {
    return JSON.parse(await readFile(conformancePath(memoryStateDir, profileName), "utf8"));
  } catch {
    return null;
  }
}

async function storeConformance(memoryStateDir, profileName, record) {
  await writePrivateJsonAtomic(
    path.join(memoryStateDir, "conformance"),
    `${profileName}.json`,
    record,
  );
}

function runnerBinaryPath(options, profile) {
  if (options.runnerBinaryPath !== undefined) return options.runnerBinaryPath;
  if (profile.adapter === "codex-cli" && process.env.THREADSHARE_MEMORY_CODEX_BIN) {
    return process.env.THREADSHARE_MEMORY_CODEX_BIN;
  }
  return process.env.THREADSHARE_MEMORY_RUNNER_BIN ?? undefined;
}

function runnerConfiguration(invocation, options) {
  if (invocation.runner === "claude") {
    if (invocation.runnerModel !== undefined || invocation.runnerEndpoint !== undefined) {
      throw memoryDiagnostic(
        "TS_USAGE_INVALID_VALUE",
        "Explicit runner model/endpoint settings are currently supported only for codex.",
        "Remove those options or choose --runner codex.",
      );
    }
    return {
      profileName: RUNNER_ADAPTERS.claude,
      profile: loadRunnerProfile(RUNNER_ADAPTERS.claude),
      provider: "claude",
      model: options.runnerModel ?? process.env.THREADSHARE_MEMORY_RUNNER_MODEL ?? "claude-latest",
      endpoint: "api.anthropic.com",
    };
  }
  const model = invocation.runnerModel ?? options.runnerModel ??
    process.env.THREADSHARE_MEMORY_RUNNER_MODEL;
  const endpoint = invocation.runnerEndpoint ?? options.runnerEndpoint ??
    process.env.THREADSHARE_MEMORY_RUNNER_ENDPOINT;
  if (typeof model !== "string" || model.length === 0 ||
      typeof endpoint !== "string" || endpoint.length === 0) {
    throw memoryDiagnostic(
      "TS_USAGE_OPTION_DEPENDENCY",
      "The codex runner requires an exact model and HTTPS endpoint for plan binding.",
      "Pass --runner-model <model> and --runner-endpoint <https-url> when creating the preview.",
    );
  }
  return {
    profileName: RUNNER_ADAPTERS.codex,
    profile: loadRunnerProfile(RUNNER_ADAPTERS.codex, { model, endpoint }),
    provider: "openai",
    model,
    endpoint,
  };
}

function assertPendingRunner(pending, runner) {
  const expected = RUNNER_ADAPTERS[runner];
  if (pending.profile.adapter !== expected) {
    throw memoryDiagnostic(
      "TS_USAGE_INVALID_VALUE",
      `The pending plan belongs to ${pending.profile.adapter}, not ${expected}.`,
      `Re-run approval with --runner ${pending.profile.adapter === "codex-cli" ? "codex" : "claude"}.`,
    );
  }
}

async function ensureConformance(context, profile, profileName, options, { force = false } = {}) {
  const binaryPath = await resolveRunnerBinaryPath(profile, runnerBinaryPath(options, profile));
  const signingKey = context.originSecret;
  const cached = force ? null : await loadConformance(context.memoryStateDir, profileName);
  if (cached !== null) {
    const identity = await computeRunnerBinaryIdentity(binaryPath);
    const current = {
      testVersion: CONFORMANCE_TEST_VERSION,
      profileDigest: computeRunnerProfileDigest(profile),
      binaryRealpath: identity.binaryRealpath,
      binaryContentSha256: identity.binaryContentSha256,
    };
    if (isConformanceValid(cached, current, { signingKey })) return cached;
  }
  const result = await runConformanceTest(profile, {
    binaryPath,
    signingKey,
    timeoutMs: options.conformanceTimeoutMs,
    codexAuthPath: options.codexAuthPath,
    tempRoot: options.runnerTempRoot,
  });
  if (result.passed !== true || result.record === null) {
    const failureCodes = result.failures.map((failure) => failure.code).join(", ");
    throw memoryDiagnostic(
      "TS_OPERATION_FAILED",
      `The restricted runner failed deny-all conformance${failureCodes ? ` (${failureCodes})` : ""}.`,
      "Fix or replace the runner before authorizing transcript delivery; there is no degraded path.",
    );
  }
  await storeConformance(context.memoryStateDir, profileName, result.record);
  return result.record;
}

async function runReverifyRunner(invocation, options) {
  const { profileName, profile } = runnerConfiguration(invocation, options);
  const context = await openMemoryContext({ ...invocation, resolveOwner: false }, options);
  try {
    const record = await ensureConformance(context, profile, profileName, options, { force: true });
    return {
      action: "reverify-runner",
      runner: invocation.runner,
      profile: profileName,
      profileDigest: record.profileDigest,
      passedAt: record.passedAt,
    };
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// extract (D1 authorization gate + two-phase runner pipeline)
// ---------------------------------------------------------------------------

async function readMemoryExtractionRequest(invocation, options) {
  if (invocation.requestSource === undefined) {
    throw memoryDiagnostic(
      "TS_USAGE_OPTION_DEPENDENCY",
      "memory extract requires --request <file|-> when creating a new plan.",
      "Provide an explicit Insights time window and optional filters in the request.",
    );
  }
  const source = invocation.requestSource === "-"
    ? "-"
    : path.resolve(invocation.repository ?? options.cwd ?? process.cwd(), invocation.requestSource);
  const input = await readInsightsQueryRequest(source, {
    input: options.input,
    signal: options.signal,
  });
  return normalizeMemoryExtractionRequest(input);
}

function extractionEvaluatedAt(options) {
  const milliseconds = typeof options.now === "function" ? options.now() : Date.now();
  return new Date(milliseconds).toISOString();
}

async function collectExtractionSelection(context, request, options, evaluatedAt) {
  const readConfig = options.readInsightsConfig ?? readExistingInsightsConfig;
  const config = await readConfig({ paths: context.paths });
  const scope = resolveMemoryInsightsScope({
    config,
    privacyContext: context.state.privacyContext,
    rootRealpath: context.rootRealpath,
    providers: request.filters.providers,
    publicRepositoryIdentity: context.binding.publicRepositoryIdentity,
  });
  const selection = await collectMemoryInsightsSelection({
    reader: memoryInsightsReader(context, options),
    request,
    scope,
    evaluatedAt,
    signal: options.signal,
  });
  return { scope, selection };
}

function summarizePlan(plan) {
  return {
    planDigest: plan.planDigest,
    taskKind: plan.taskKind,
    taskId: plan.taskId,
    provider: plan.provider,
    model: plan.model,
    endpoint: plan.endpoint,
    bytesToSend: plan.bytesToSend,
    providerRetention: plan.providerRetention,
    inputCoverage: plan.inputCoverage,
    authorization: plan.authorization,
  };
}

const PENDING_RUNNER_PLAN_FORMAT = "threadshare-memory-pending-runner-plan@v1";
const PENDING_RUNNER_MANIFEST_FORMAT = "threadshare-memory-pending-runner-manifest@v1";
const HEX64_PATTERN = /^[0-9a-f]{64}$/u;

function ownerMatches(left, right) {
  return left?.repositoryKey === right.repositoryKey && left?.worktreeKey === right.worktreeKey;
}

async function writePrivateJsonAtomic(directory, filename, value) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const target = path.join(directory, filename);
  const temporary = path.join(
    directory,
    `.${filename}.${process.pid}.${randomBytes(8).toString("hex")}.tmp`,
  );
  try {
    await writeFile(temporary, `${JSON.stringify(value)}\n`, { flag: "wx", mode: 0o600 });
    await rename(temporary, target);
  } finally {
    await unlink(temporary).catch((error) => {
      if (error?.code !== "ENOENT") throw error;
    });
  }
}

async function readPrivateJson(filename) {
  let raw;
  try {
    raw = await readFile(filename, "utf8");
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  try {
    return JSON.parse(raw);
  } catch {
    throw memoryDiagnostic(
      "TS_INSIGHTS_STATE_INVALID",
      "A pending Team Memory runner artifact is not valid JSON.",
      "Remove the corrupt local artifact only after preserving it for diagnosis, then regenerate the plan.",
    );
  }
}

function pendingRunnerPlanPath(memoryStateDir, planDigest) {
  if (!HEX64_PATTERN.test(planDigest)) return null;
  return path.join(memoryStateDir, "runner-plans", `${planDigest}.json`);
}

async function persistPendingRunnerPlan(context, plan, stdinBytes, extraction = null, profile) {
  const parsedPlan = runnerExecutionPlanSchema.parse(plan);
  const parsedProfile = restrictedExtractionRunnerSchema.parse(profile);
  if (computeRunnerProfileDigest(parsedProfile) !== parsedPlan.runnerProfile) {
    throw memoryDiagnostic(
      "TS_INSIGHTS_STATE_INVALID",
      "The pending runner profile does not match its execution plan.",
      "Regenerate the extraction preview.",
    );
  }
  const buffer = Buffer.from(stdinBytes);
  let extractionSource;
  if (extraction !== null) {
    const request = normalizeMemoryExtractionRequest(extraction.request);
    const task = extractionTaskSchema.parse(JSON.parse(buffer.toString("utf8")));
    if (parsedPlan.taskKind !== "extraction" || task.taskId !== parsedPlan.taskId) {
      throw memoryDiagnostic(
        "TS_INSIGHTS_STATE_INVALID",
        "The pending extraction source does not match its runner plan.",
        "Regenerate the extraction preview from the bound worktree.",
      );
    }
    extractionSource = { request, task };
  }
  await writePrivateJsonAtomic(
    path.join(context.memoryStateDir, "runner-plans"),
    `${parsedPlan.planDigest}.json`,
    {
      format: PENDING_RUNNER_PLAN_FORMAT,
      owner: context.owner,
      plan: parsedPlan,
      profile: parsedProfile,
      stdinBase64: buffer.toString("base64"),
      ...(extractionSource === undefined ? {} : { extraction: extractionSource }),
    },
  );
}

async function loadPendingRunnerPlan(context, planDigest) {
  const artifactPath = pendingRunnerPlanPath(context.memoryStateDir, planDigest);
  if (artifactPath === null) return null;
  const artifact = await readPrivateJson(artifactPath);
  if (artifact === null) return null;
  let plan;
  let profile;
  try {
    plan = runnerExecutionPlanSchema.parse(artifact.plan);
    profile = restrictedExtractionRunnerSchema.parse(artifact.profile);
  } catch {
    throw memoryDiagnostic(
      "TS_INSIGHTS_STATE_INVALID",
      "A pending Team Memory runner plan failed contract validation.",
      "Preserve the local artifact for diagnosis, then regenerate the plan.",
    );
  }
  const stdinBytes = typeof artifact.stdinBase64 === "string"
    ? Buffer.from(artifact.stdinBase64, "base64")
    : null;
  if (
    artifact.format !== PENDING_RUNNER_PLAN_FORMAT ||
    !ownerMatches(artifact.owner, context.owner) ||
    plan.planDigest !== planDigest ||
    computeRunnerProfileDigest(profile) !== plan.runnerProfile ||
    stdinBytes === null ||
    stdinBytes.toString("base64") !== artifact.stdinBase64
  ) {
    throw memoryDiagnostic(
      "TS_INSIGHTS_STATE_INVALID",
      "A pending Team Memory runner plan is corrupt or belongs to another worktree.",
      "Do not authorize it; regenerate the plan from the bound worktree.",
    );
  }
  let extraction = null;
  if (artifact.extraction !== undefined) {
    try {
      const request = normalizeMemoryExtractionRequest(artifact.extraction.request);
      const task = extractionTaskSchema.parse(artifact.extraction.task);
      const stdinTask = extractionTaskSchema.parse(JSON.parse(stdinBytes.toString("utf8")));
      if (
        plan.taskKind !== "extraction" ||
        task.taskId !== plan.taskId ||
        canonicalJson(task) !== canonicalJson(stdinTask)
      ) {
        throw new Error("extraction binding mismatch");
      }
      extraction = { request, task };
    } catch {
      throw memoryDiagnostic(
        "TS_INSIGHTS_STATE_INVALID",
        "A pending Team Memory extraction source failed contract validation.",
        "Do not authorize it; regenerate the extraction plan from the bound worktree.",
      );
    }
  }
  return { plan, profile, stdinBytes, extraction };
}

function pendingRunnerManifestPath(memoryStateDir, manifestDigest) {
  if (!HEX64_PATTERN.test(manifestDigest)) return null;
  return path.join(memoryStateDir, "runner-manifests", `${manifestDigest}.json`);
}

async function persistPendingRunnerManifest(context, manifest) {
  const parsed = authorizationManifestSchema.parse(manifest);
  await writePrivateJsonAtomic(
    path.join(context.memoryStateDir, "runner-manifests"),
    `${parsed.manifestDigest}.json`,
    { format: PENDING_RUNNER_MANIFEST_FORMAT, owner: context.owner, manifest: parsed },
  );
}

async function loadPendingRunnerManifest(context, manifestDigest) {
  const artifactPath = pendingRunnerManifestPath(context.memoryStateDir, manifestDigest);
  if (artifactPath === null) return null;
  const artifact = await readPrivateJson(artifactPath);
  if (artifact === null) return null;
  let manifest;
  try {
    manifest = authorizationManifestSchema.parse(artifact.manifest);
  } catch {
    throw memoryDiagnostic(
      "TS_INSIGHTS_STATE_INVALID",
      "A pending Team Memory runner manifest failed contract validation.",
      "Preserve the local artifact for diagnosis, then regenerate the manifest.",
    );
  }
  if (
    artifact.format !== PENDING_RUNNER_MANIFEST_FORMAT ||
    !ownerMatches(artifact.owner, context.owner) ||
    manifest.manifestDigest !== manifestDigest
  ) {
    throw memoryDiagnostic(
      "TS_INSIGHTS_STATE_INVALID",
      "A pending Team Memory runner manifest is corrupt or belongs to another worktree.",
      "Do not authorize it; regenerate the manifest from the bound worktree.",
    );
  }
  return manifest;
}

async function recordRunnerAuthorization(context, plan, { via, manifestDigest = null }) {
  await memoryAuthorize(context.engine, {
    planDigest: plan.planDigest,
    taskId: plan.taskId,
    runnerInputDigest: plan.runnerInputDigest,
    inputCoverageDigest: plan.inputCoverageDigest,
    provider: plan.provider,
    model: plan.model,
    endpoint: plan.endpoint,
    bytes: plan.bytesToSend,
    via,
    manifestDigest,
  });
}

function buildExtractionArtifacts(context, selection, configuration) {
  const { provider, model, endpoint, profile } = configuration;
  const artifacts = [];
  for (const session of selection.sessions) {
    const chunks = chunkSession({ turns: session.turns });
    for (const chunk of chunks) {
      const evidence = buildEvidenceCatalog({ deliveryEdges: session.deliveryEdges, chunk });
      const selectionBinding = {
        requestDigest: selection.requestDigest,
        resultSetDigest: selection.resultSetDigest,
        sourceBindingDigest: session.sourceBindingDigest,
      };
      const identityDigest = sha256Hex(canonicalJson({
        sessionKey: session.sessionKey,
        chunkDigest: chunk.chunkDigest,
        turnRange: chunk.turnRange,
        selection: selectionBinding,
      }));
      const taskInput = {
        lease: { holder: "threadshare-memory-cli", expiresAt: 0 },
        databaseUuid: selection.databaseUuid,
        owner: context.owner,
        session: {
          project: session.project,
          repositoryKey: context.owner.repositoryKey,
          timeWindow: session.timeWindow,
        },
        chunk,
        evidenceCatalog: evidence.catalog,
        selection: selectionBinding,
        turnRevisions: chunk.turnRevisions,
        payloadDigests: collectPayloadDigests(chunk),
        deliveryEdgeRevisions: evidence.deliveryEdgeRevisions,
        snapshotSeq: selection.snapshotSeq,
        evaluatedAt: selection.evaluatedAt,
      };
      const preview = buildExtractionTask({
        ...taskInput,
        taskId: `extract-${identityDigest}`,
      });
      const taskId = `extract-${preview.task.binding.sourceInputDigest}`;
      const chunkRef = [
        session.sessionKey,
        chunk.turnRange.start,
        chunk.turnRange.end,
        preview.task.binding.sourceInputDigest,
      ].join(":");
      const { task, stdinBytes } = buildExtractionTask({
        ...taskInput,
        taskId,
      });
      const plan = buildExecutionPlan({
        taskKind: "extraction",
        taskId,
        stdinBytes,
        profile,
        provider,
        model,
        endpoint,
      });
      artifacts.push({
        taskId,
        chunkRef,
        sessionKey: session.sessionKey,
        chunk,
        evidence,
        task,
        stdinBytes,
        plan,
      });
    }
  }
  return { profile, provider, model, endpoint, artifacts, selection };
}

async function planExtractionArtifacts(context, built, limit) {
  const planned = await memoryPlanTasks(context.engine, {
    ...context.owner,
    chunks: built.artifacts.map((artifact) => ({
      chunkRef: artifact.chunkRef,
      sessionKey: artifact.sessionKey,
      turnRange: `${artifact.chunk.turnRange.start}-${artifact.chunk.turnRange.end}`,
      chunkDigest: artifact.chunk.chunkDigest,
      provenanceSnapshotSeq: built.selection.snapshotSeq,
    })),
    tasks: built.artifacts.map((artifact) => ({
      taskId: artifact.taskId,
      kind: "extraction",
      chunkRef: artifact.chunkRef,
      binding: artifact.task.binding,
    })),
  });
  const claimable = new Set(planned.tasks
    .filter((task) => task.claimable)
    .map((task) => task.taskId));
  return built.artifacts.filter((artifact) => claimable.has(artifact.taskId)).slice(0, limit);
}

async function persistExtractionPlans(context, artifacts, request, profile) {
  for (const artifact of artifacts) {
    await persistPendingRunnerPlan(context, artifact.plan, artifact.stdinBytes, {
      request,
    }, profile);
  }
  const manifest = artifacts.length > 1
    ? buildAuthorizationManifest(artifacts.map((artifact) => artifact.plan))
    : null;
  if (manifest !== null) await persistPendingRunnerManifest(context, manifest);
  return manifest;
}

function extractionInputMatches(storedTask, currentTask) {
  return storedTask.taskId === currentTask.taskId &&
    storedTask.binding.databaseUuid === currentTask.binding.databaseUuid &&
    storedTask.binding.sourceInputDigest === currentTask.binding.sourceInputDigest &&
    canonicalJson(storedTask.binding.selection) === canonicalJson(currentTask.binding.selection) &&
    ownerMatches(storedTask.binding.owner, currentTask.binding.owner);
}

async function revalidatePendingExtraction(context, pending, options) {
  if (pending.extraction === null || pending.plan.taskKind !== "extraction") {
    throw memoryDiagnostic(
      "TS_INSIGHTS_STATE_INVALID",
      "The pending extraction plan has no bound Insights source.",
      "Do not authorize it; regenerate the extraction preview.",
    );
  }
  const evaluatedAt = extractionEvaluatedAt(options);
  const { selection } = await collectExtractionSelection(
    context,
    pending.extraction.request,
    options,
    evaluatedAt,
  );
  const current = buildExtractionArtifacts(context, selection, {
    profile: pending.profile,
    provider: pending.plan.provider,
    model: pending.plan.model,
    endpoint: pending.plan.endpoint,
  }).artifacts
    .find((artifact) => artifact.taskId === pending.plan.taskId);
  if (current === undefined || !extractionInputMatches(pending.extraction.task, current.task)) {
    throw memoryDiagnostic(
      "TS_INSIGHTS_PAYLOAD_CHANGED",
      "The Insights Turns or Delivery Trace bound to this extraction plan changed.",
      "Run memory extract with the original --request to preview and approve a new plan.",
    );
  }
  return {
    ...current,
    task: pending.extraction.task,
    stdinBytes: pending.stdinBytes,
    plan: pending.plan,
  };
}

function candidateIdsFor(taskId, draftBatch) {
  return draftBatch.candidates.map((_, index) => `${taskId}-c${index + 1}`);
}

const REVIEW_EVIDENCE_EXCERPT_MAX_CHARS = 480;

function compactReviewExcerpt(value) {
  const compact = value.replace(/\s+/g, " ").trim();
  if (compact.length <= REVIEW_EVIDENCE_EXCERPT_MAX_CHARS) return compact;
  return `${compact.slice(0, REVIEW_EVIDENCE_EXCERPT_MAX_CHARS - 3)}...`;
}

function buildReviewStatements(candidate, artifact) {
  const catalog = new Map(artifact.evidence.catalog.map((entry) => [entry.evidenceId, entry]));
  return candidate.statements.map((statement) => ({
    statementId: statement.statementId,
    text: statement.text,
    evidence: statement.evidenceIds.map((evidenceId) => {
      const publicEntry = catalog.get(evidenceId);
      const internalEntry = artifact.evidence.internalIndex[evidenceId];
      const turnIndex = internalEntry?.kind === "turn" ? internalEntry.pointer.turnIndex : null;
      const turnText = turnIndex === null
        ? ""
        : artifact.chunk.events
            .filter((event) => event.turnIndex === turnIndex)
            .map((event) => `${event.role}: ${event.text}`)
            .join("\n");
      return {
        evidenceId,
        kind: publicEntry.kind,
        display: publicEntry.display,
        excerpt: turnText.length > 0 ? compactReviewExcerpt(turnText) : null,
        localOnly: publicEntry.kind === "turn",
      };
    }),
  }));
}

async function deliverExtraction(
  context,
  profile,
  artifact,
  approvedPlan,
  conformance,
  options,
  authorization,
  revalidate = null,
) {
  await memoryPlanTasks(context.engine, {
    ...context.owner,
    chunks: [{
      chunkRef: artifact.chunkRef,
      sessionKey: artifact.sessionKey,
      turnRange: `${artifact.chunk.turnRange.start}-${artifact.chunk.turnRange.end}`,
      chunkDigest: artifact.chunk.chunkDigest,
      provenanceSnapshotSeq: artifact.task.binding.provenance.snapshotSeq,
    }],
    tasks: [{
      taskId: artifact.taskId,
      kind: "extraction",
      chunkRef: artifact.chunkRef,
      binding: artifact.task.binding,
    }],
  });
  const claim = await memoryClaimTask(context.engine, {
    taskId: artifact.taskId,
    leaseHolder: "threadshare-memory-cli",
    leaseMs: 300_000,
  });
  await recordRunnerAuthorization(context, approvedPlan, authorization);
  const execution = await runExtractionRunner({
    profile,
    conformance,
    plan: approvedPlan,
    stdinBytes: artifact.stdinBytes,
    binaryPath: runnerBinaryPath(options, profile),
    signingKey: context.originSecret,
    codexAuthPath: options.codexAuthPath,
    tempRoot: options.runnerTempRoot,
  });
  const draftBatch = candidateDraftBatchSchema.parse(JSON.parse(execution.stdout.toString("utf8")));
  if (
    draftBatch.taskId !== artifact.task.taskId ||
    canonicalJson(draftBatch.binding) !== canonicalJson(artifact.task.binding)
  ) {
    throw memoryDiagnostic(
      "TS_INPUT_SCHEMA_INVALID",
      "The extraction runner did not echo the authorized task binding.",
      "Treat the runner result as failed; do not submit candidates from another input.",
    );
  }
  const currentArtifact = artifact;
  const candidateIds = candidateIdsFor(currentArtifact.taskId, draftBatch);
  const derived = deriveEvidenceAssessments({
    draftBatch,
    internalIndex: currentArtifact.evidence.internalIndex,
    candidateIds,
  });
  if (derived.assessments.length === 0) {
    throw memoryDiagnostic(
      "TS_OPERATION_FAILED",
      "The extraction runner produced no citable statements.",
      "Inspect the selected Insights Turns and re-run with a narrower request if needed.",
    );
  }
  const citationsByStatement = new Map(
    derived.confirmationBindings.map((b) => [`${b.candidateId}:${b.statementId}`, b.citationsDigest]),
  );
  const drafts = draftBatch.candidates.map((candidate, index) => ({
    candidateId: candidateIds[index],
    payload: {
      content: candidate.content,
      type: candidate.type,
      priority: candidate.priority,
      confidence: candidate.confidence,
      scene: candidate.scene,
      reviewStatements: buildReviewStatements(candidate, currentArtifact),
    },
    searchableText: candidate.content.slice(0, 1024),
  }));
  const submittedIds = new Set(derived.assessments.map((a) => a.candidateId));
  const evidenceRefs = [];
  for (const assessment of derived.assessments) {
    for (const citation of assessment.citations) {
      evidenceRefs.push({
        candidateId: assessment.candidateId,
        statementId: assessment.statementId,
        evidenceId: citation.evidenceId,
        pointerDigest: citation.pointerDigest,
        strength: assessment.provenanceStrength,
        limitations: assessment.limitations.length > 0 ? assessment.limitations : null,
      });
    }
  }
  const submission = {
    taskId: currentArtifact.taskId,
    claimToken: claim.claimToken,
    responseDigest: sha256Hex(canonicalJson(draftBatch)),
    drafts: drafts.filter((d) => submittedIds.has(d.candidateId)),
    evidenceRefs,
    assessments: derived.assessments.map((a) => ({
      candidateId: a.candidateId,
      statementId: a.statementId,
      citationsDigest: citationsByStatement.get(`${a.candidateId}:${a.statementId}`)
        ?? computeCitationsDigest(a.citations),
      provenanceStrength: a.provenanceStrength,
      limitations: a.limitations,
      claimSupport: a.claimSupport,
      assessedBy: a.assessedBy,
      statementTextDigest: a.statementTextDigest,
      revision: a.revision,
    })),
  };
  const accepted = revalidate === null
    ? await memorySubmitExtraction(context.engine, submission)
    : await withInsightsWriterLock(context.paths, async () => {
        await revalidate();
        return memorySubmitExtraction(context.engine, submission);
      }, options.writerLockOptions);
  return { draftBatch, candidateIds, accepted, drafts: submission.drafts };
}

async function deliverPendingExtraction(
  context,
  profile,
  pending,
  approvedPlan,
  conformance,
  options,
  authorization,
) {
  const artifact = await revalidatePendingExtraction(context, pending, options);
  const extraction = await deliverExtraction(
    context,
    profile,
    artifact,
    approvedPlan,
    conformance,
    options,
    authorization,
    () => revalidatePendingExtraction(context, pending, options),
  );
  const adjudication = await prepareAdjudication(context, profile, artifact, extraction);
  return {
    delivered: {
      taskId: artifact.taskId,
      taskKind: "extraction",
      candidates: extraction.accepted.candidates.length,
      candidateGeneration: extraction.accepted.candidateGeneration,
      adjudication: "pending",
    },
    adjudication,
  };
}

async function prepareAdjudication(context, profile, artifact, extractionResult) {
  const recallInput = {
    ...context.owner,
    drafts: extractionResult.drafts.map((draft) => ({
      draftRef: draft.candidateId,
      candidateId: draft.candidateId,
      queryText: draft.searchableText,
    })),
  };
  const recall = await memoryRecall(context.engine, recallInput);
  if (recall.approvedProjection.coverage !== "complete") {
    throw memoryDiagnostic(
      "TS_OPERATION_FAILED",
      "Approved Team Memory search coverage is partial; adjudication cannot use an incomplete pool.",
      "Run a complete approved-memory sync, then retry extraction.",
    );
  }
  const drafts = extractionResult.drafts.map((draft) => ({
    candidateId: draft.candidateId,
    content: draft.payload.content,
    type: draft.payload.type,
    priority: draft.payload.priority,
    confidence: draft.payload.confidence,
    scene: draft.payload.scene,
    statements: draft.payload.reviewStatements.map((statement) => ({
      statementId: statement.statementId,
      text: statement.text,
      evidenceIds: statement.evidence.map((evidence) => evidence.evidenceId),
    })),
  }));
  const adjTaskId = `${artifact.taskId}-adj`;
  const { stdinBytes } = buildAdjudicationTask({
    taskId: adjTaskId,
    lease: { holder: "threadshare-memory-cli", expiresAt: 0 },
    databaseUuid: context.memoryStateUuid,
    memoryStateUuid: context.memoryStateUuid,
    owner: context.owner,
    drafts,
    recall,
    recallQueryDigest: recall.recallQueryDigest,
    resultSetDigest: recall.resultSetDigest,
  });
  const plan = buildExecutionPlan({
    taskKind: "adjudication",
    taskId: adjTaskId,
    stdinBytes,
    profile,
    provider: artifact.plan.provider,
    model: artifact.plan.model,
    endpoint: artifact.plan.endpoint,
  });
  await persistPendingRunnerPlan(context, plan, stdinBytes, null, profile);
  return { plan, stdinBytes };
}

async function deliverPendingAdjudication(
  context,
  profile,
  pending,
  approvedPlan,
  conformance,
  options,
  authorization,
) {
  let task;
  try {
    task = adjudicationTaskSchema.parse(JSON.parse(pending.stdinBytes.toString("utf8")));
  } catch {
    throw memoryDiagnostic(
      "TS_INSIGHTS_STATE_INVALID",
      "The pending adjudication input failed contract validation.",
      "Do not authorize it; regenerate the adjudication plan from the extraction result.",
    );
  }
  if (
    task.taskId !== approvedPlan.taskId ||
    !ownerMatches(task.binding.owner, context.owner)
  ) {
    throw memoryDiagnostic(
      "TS_INSIGHTS_STATE_INVALID",
      "The pending adjudication input is not bound to this plan and worktree.",
      "Do not authorize it; regenerate the plan from the bound worktree.",
    );
  }
  await memoryPlanTasks(context.engine, {
    ...context.owner,
    chunks: [],
    tasks: [{
      taskId: task.taskId,
      kind: "adjudication",
      draftBatchRef: task.taskId,
      binding: task.binding,
    }],
  });
  const claim = await memoryClaimTask(context.engine, {
    taskId: task.taskId,
    leaseHolder: "threadshare-memory-cli",
    leaseMs: 300_000,
  });
  await recordRunnerAuthorization(context, approvedPlan, authorization);
  const execution = await runExtractionRunner({
    profile,
    conformance,
    plan: approvedPlan,
    stdinBytes: pending.stdinBytes,
    binaryPath: runnerBinaryPath(options, profile),
    signingKey: context.originSecret,
    codexAuthPath: options.codexAuthPath,
    tempRoot: options.runnerTempRoot,
  });
  const result = adjudicationResultSchema.parse(JSON.parse(execution.stdout.toString("utf8")));
  if (
    result.taskId !== task.taskId ||
    canonicalJson(result.binding) !== canonicalJson(task.binding)
  ) {
    throw memoryDiagnostic(
      "TS_INPUT_SCHEMA_INVALID",
      "The adjudication runner did not echo the authorized task binding.",
      "Treat the runner result as failed; do not apply adjudication from another input.",
    );
  }
  const poolByKey = new Map(task.pool.map((item) => [`${item.sourceKind}:${item.id}`, item]));
  const adjudications = result.adjudications.map((a) => {
    const base = { draftRef: a.draftRef, action: a.action };
    if (a.action === "store" || a.action === "skip") return base;
    const targets = a.targetIds.map((id) => {
      const item = poolByKey.get(`candidate:${id}`) ?? poolByKey.get(`approved:${id}`);
      if (item === undefined) {
        throw memoryDiagnostic(
          "TS_INPUT_SCHEMA_INVALID",
          `The adjudication runner referenced target ${id}, which was not in its recall pool.`,
          "Treat the result as failed and regenerate the adjudication plan; do not apply a guessed revision.",
        );
      }
      return { id, revision: item.revision };
    });
    return {
      ...base,
      targets,
      mergedPayload: a.mergedFields ?? {},
      mergedSearchableText: (a.mergedFields?.content ?? "").slice(0, 1024),
    };
  });
  const recallInput = {
    ...context.owner,
    drafts: task.drafts.map((draft) => ({
      draftRef: draft.candidateId,
      candidateId: draft.candidateId,
      queryText: draft.content.slice(0, 1024),
    })),
  };
  const outcome = await memorySubmitAdjudication(context.engine, {
    taskId: task.taskId,
    claimToken: claim.claimToken,
    responseDigest: sha256Hex(canonicalJson(result)),
    recall: recallInput,
    expectedResultSetDigest: task.binding.resultSetDigest,
    adjudications,
  });
  return outcome;
}

function failedRunnerPlan(entry, error) {
  return {
    taskId: entry.taskId,
    planDigest: entry.planDigest,
    status: "failed",
    code: typeof error?.code === "string" ? error.code : "TS_OPERATION_FAILED",
    problem: error instanceof Error ? error.message : String(error),
  };
}

async function deliverStoredManifest(context, manifest, runner, options) {
  const approvedManifest = approveManifest(manifest, { approvedDigest: manifest.manifestDigest });
  const conformanceByProfile = new Map();
  const delivered = [];
  const failed = [];
  const pendingAdjudications = [];
  for (const entry of approvedManifest.plans) {
    try {
      const pending = await loadPendingRunnerPlan(context, entry.planDigest);
      if (pending === null) {
        throw memoryDiagnostic(
          "TS_INPUT_READ_FAILED",
          `No pending runner plan matches ${entry.planDigest}.`,
          "Regenerate the manifest; approvals never extend to missing or future plans.",
        );
      }
      assertPendingRunner(pending, runner);
      const profile = pending.profile;
      const profileDigest = computeRunnerProfileDigest(profile);
      let conformance = conformanceByProfile.get(profileDigest);
      if (conformance === undefined) {
        conformance = await ensureConformance(
          context,
          profile,
          profile.adapter,
          options,
        );
        conformanceByProfile.set(profileDigest, conformance);
      }
      const approvedPlan = approvePlanFromManifest(pending.plan, approvedManifest);
      const authorization = {
        via: "manifest",
        manifestDigest: approvedManifest.manifestDigest,
      };
      if (pending.plan.taskKind === "extraction") {
        const result = await deliverPendingExtraction(
          context, profile, pending, approvedPlan, conformance, options, authorization,
        );
        delivered.push(result.delivered);
        pendingAdjudications.push(result.adjudication);
      } else if (pending.plan.taskKind === "adjudication") {
        const outcome = await deliverPendingAdjudication(
          context, profile, pending, approvedPlan, conformance, options, authorization,
        );
        delivered.push({
          taskId: pending.plan.taskId,
          taskKind: "adjudication",
          adjudication: outcome.status,
          ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
        });
      } else {
        throw memoryDiagnostic(
          "TS_INPUT_SCHEMA_INVALID",
          `Unsupported pending task kind ${pending.plan.taskKind}.`,
          "Regenerate the pending Team Memory plan.",
        );
      }
    } catch (error) {
      failed.push(failedRunnerPlan(entry, error));
    }
  }
  const nextManifest = pendingAdjudications.length > 1
    ? buildAuthorizationManifest(pendingAdjudications.map((artifact) => artifact.plan))
    : null;
  if (nextManifest !== null) await persistPendingRunnerManifest(context, nextManifest);
  return {
    delivered,
    failed,
    plans: pendingAdjudications.map((artifact) => summarizePlan(artifact.plan)),
    manifestDigest: nextManifest?.manifestDigest ?? null,
  };
}

async function createExtractionPreview(context, invocation, request, limit, options) {
  const configuration = runnerConfiguration(invocation, options);
  const evaluatedAt = extractionEvaluatedAt(options);
  const { selection } = await collectExtractionSelection(
    context, normalizeMemoryExtractionRequest(request), options, evaluatedAt,
  );
  const built = buildExtractionArtifacts(context, selection, configuration);
  const selected = await planExtractionArtifacts(context, built, limit);
  const manifest = await persistExtractionPlans(context, selected, request, built.profile);
  return {
    action: "extract",
    authorized: false,
    dataSource: "insights-retrospective",
    plans: selected.map((artifact) => summarizePlan(artifact.plan)),
    manifestDigest: manifest?.manifestDigest ?? null,
    selection: {
      requestDigest: selection.requestDigest,
      resultSetDigest: selection.resultSetDigest,
      matchedSessions: selection.sessions.length,
      rejectedSessions: selection.rejected.length,
      pendingChunks: selected.length,
    },
    note: selected.length === 0
      ? "No claimable chunks matched the request. No transcript was delivered."
      : "No transcript was delivered. Re-run in the CLI with --approve-plan <digest> (or --approve-manifest <digest>) to authorize exactly the listed delivery.",
  };
}

const CONSOLIDATION_DUE_ENTRY_COUNT = 20;

function consolidationEntry(projected) {
  return {
    entryId: projected.entryId,
    revision: projected.revision,
    contentDigest: projected.contentDigest,
    type: projected.frontmatter.type,
    scene: projected.frontmatter.scene,
    priority: projected.frontmatter.priority,
    confidence: projected.frontmatter.confidence,
    body: projected.bodyText,
  };
}

async function currentConsolidationInput(context, options) {
  const { projection, scan } = await syncApprovedProjectionSnapshot(context);
  if (scan.coverage !== "complete" || projection.coverage !== "complete") {
    throw memoryDiagnostic(
      "TS_INSIGHTS_COVERAGE_INCOMPLETE",
      "Approved Team Memory could not be scanned completely for consolidation.",
      "Wait for repository writes to finish, then retry.",
    );
  }
  const [databaseUuid, sources] = await Promise.all([
    consolidationDatabaseUuid(context, options),
    readConsolidationSources(context),
  ]);
  return {
    databaseUuid,
    approvedProjection: {
      generation: projection.generation,
      analyzerVersion: "memory-approved@1",
      coverage: "complete",
      sourceTreeDigest: scan.sourceTreeDigest,
    },
    entries: scan.entries.filter((entry) => entry.status === "approved").map(consolidationEntry),
    ...sources,
  };
}

function buildCurrentConsolidationTask(context, input, entries, replay) {
  return buildConsolidationTask({
    databaseUuid: input.databaseUuid,
    memoryStateUuid: context.memoryStateUuid,
    owner: context.owner,
    approvedProjection: input.approvedProjection,
    entries,
    scenes: input.scenes,
    doctrine: input.doctrine,
    replay,
    dueEntryCount: CONSOLIDATION_DUE_ENTRY_COUNT,
  });
}

function consolidationCoverage(task) {
  const coverage = task.entries.map((entry) => ({
    sourceKind: "approved-entry",
    opaqueSourceId: entry.entryId,
    revision: entry.revision,
    contentDigest: entry.contentDigest,
    bytes: Buffer.byteLength(entry.body, "utf8"),
    truncated: false,
  }));
  for (const scene of task.scenes) {
    coverage.push({
      sourceKind: "scene",
      opaqueSourceId: scene.name,
      revision: scene.heat,
      contentDigest: scene.contentDigest,
      bytes: Buffer.byteLength(scene.content, "utf8"),
      truncated: false,
    });
  }
  if (task.doctrine !== null) {
    coverage.push({
      sourceKind: "doctrine",
      opaqueSourceId: "doctrine",
      revision: null,
      contentDigest: task.doctrine.contentDigest,
      bytes: Buffer.byteLength(task.doctrine.content, "utf8"),
      truncated: false,
    });
  }
  coverage.push({
    sourceKind: "prompt",
    opaqueSourceId: task.binding.promptVersion,
    revision: null,
    contentDigest: sha256Hex(task.contract.prompts.consolidation),
    bytes: Buffer.byteLength(task.contract.prompts.consolidation, "utf8"),
    truncated: false,
  });
  return coverage;
}

async function createConsolidationPreview(context, invocation, options) {
  const baseline = await memoryConsolidationBaseline(context.engine, context.owner);
  if (baseline.pendingRunId !== null) {
    return {
      action: "consolidate",
      authorized: false,
      plans: [],
      pendingRunId: baseline.pendingRunId,
      note: "A consolidation patch is already awaiting review; review or discard it before creating another.",
    };
  }
  const input = await currentConsolidationInput(context, options);
  const baselineById = new Map(baseline.entries.map((entry) => [entry.entryId, entry]));
  const selected = invocation.full
    ? input.entries
    : input.entries.filter((entry) => {
        const previous = baselineById.get(entry.entryId);
        return previous === undefined || previous.revision !== entry.revision ||
          previous.contentDigest !== entry.contentDigest;
      });
  if (selected.length === 0) {
    return {
      action: "consolidate",
      authorized: false,
      plans: [],
      entryCount: 0,
      full: invocation.full,
      note: "No new or changed approved L1 entries require consolidation.",
    };
  }
  if (invocation.ifDue && selected.length < CONSOLIDATION_DUE_ENTRY_COUNT) {
    return {
      action: "consolidate",
      authorized: false,
      plans: [],
      entryCount: selected.length,
      dueAt: CONSOLIDATION_DUE_ENTRY_COUNT,
      note: `Consolidation is not due: ${selected.length}/${CONSOLIDATION_DUE_ENTRY_COUNT} new or changed approved L1 entries.`,
    };
  }
  const configuration = runnerConfiguration(invocation, options);
  const task = buildCurrentConsolidationTask(context, input, selected, {
    mode: invocation.full ? "full" : "incremental",
    afterSuccessfulRunId: baseline.successfulRunId,
  });
  const stdinBytes = Buffer.from(canonicalJson(task), "utf8");
  const plan = buildExecutionPlan({
    taskKind: "consolidation",
    taskId: task.taskId,
    stdinBytes,
    inputCoverage: consolidationCoverage(task),
    profile: configuration.profile,
    provider: configuration.provider,
    model: configuration.model,
    endpoint: configuration.endpoint,
  });
  const planned = await memoryPlanTasks(context.engine, {
    ...context.owner,
    chunks: [],
    tasks: [{
      taskId: task.taskId,
      kind: "consolidation",
      binding: task.binding,
    }],
  });
  if (!planned.tasks[0]?.claimable) {
    return {
      action: "consolidate",
      authorized: false,
      plans: [],
      entryCount: selected.length,
      note: `Consolidation task ${task.taskId} is already claimed or submitted.`,
    };
  }
  await persistPendingRunnerPlan(context, plan, stdinBytes, null, configuration.profile);
  return {
    action: "consolidate",
    authorized: false,
    plans: [summarizePlan(plan)],
    entryCount: selected.length,
    full: invocation.full,
    note: "No memory content was delivered. Approve the exact plan digest in the CLI to run consolidation.",
  };
}

async function revalidatePendingConsolidation(context, pending, options) {
  if (pending.plan.taskKind !== "consolidation") {
    throw memoryDiagnostic(
      "TS_INSIGHTS_STATE_INVALID",
      "The pending runner plan is not a consolidation task.",
      "Generate a new plan with `threadshare memory consolidate`.",
    );
  }
  let storedTask;
  try {
    storedTask = consolidationTaskSchema.parse(JSON.parse(pending.stdinBytes.toString("utf8")));
  } catch (cause) {
    throw memoryDiagnostic(
      "TS_INSIGHTS_STATE_INVALID",
      "The pending consolidation task failed contract validation.",
      "Do not authorize it; regenerate the consolidation preview.",
    );
  }
  const input = await currentConsolidationInput(context, options);
  const baseline = await memoryConsolidationBaseline(context.engine, context.owner);
  const currentById = new Map(input.entries.map((entry) => [entry.entryId, entry]));
  const selected = storedTask.entries.map((entry) => currentById.get(entry.entryId)).filter(Boolean);
  if (selected.length !== storedTask.entries.length) {
    throw memoryDiagnostic(
      "TS_MEMORY_BINDING_DRIFT",
      "An approved L1 entry bound to the pending consolidation plan is no longer current.",
      "Regenerate and approve a new consolidation plan.",
    );
  }
  const currentTask = buildCurrentConsolidationTask(context, input, selected, {
    mode: storedTask.binding.replay.mode,
    afterSuccessfulRunId: baseline.successfulRunId,
  });
  if (canonicalJson(currentTask) !== canonicalJson(storedTask)) {
    throw memoryDiagnostic(
      "TS_MEMORY_BINDING_DRIFT",
      "Approved entries, scenes, doctrine, owner, or projection changed after consolidation preview.",
      "Regenerate and approve a new consolidation plan.",
    );
  }
  return storedTask;
}

async function deliverPendingConsolidation(
  context,
  pending,
  approvedPlan,
  conformance,
  options,
) {
  const task = await revalidatePendingConsolidation(context, pending, options);
  await memoryPlanTasks(context.engine, {
    ...context.owner,
    chunks: [],
    tasks: [{ taskId: task.taskId, kind: "consolidation", binding: task.binding }],
  });
  const claim = await memoryClaimTask(context.engine, {
    taskId: task.taskId,
    leaseHolder: "threadshare-memory-cli",
    leaseMs: 300_000,
  });
  await recordRunnerAuthorization(context, approvedPlan, { via: "digest" });
  const execution = await runExtractionRunner({
    profile: pending.profile,
    conformance,
    plan: approvedPlan,
    stdinBytes: pending.stdinBytes,
    binaryPath: runnerBinaryPath(options, pending.profile),
    signingKey: context.originSecret,
    codexAuthPath: options.codexAuthPath,
    tempRoot: options.runnerTempRoot,
  });
  let patch;
  try {
    patch = consolidationPatchSchema.parse(JSON.parse(execution.stdout));
  } catch (cause) {
    throw memoryDiagnostic(
      "TS_INPUT_SCHEMA_INVALID",
      "The consolidation runner did not return a valid ConsolidationPatch@v1.",
      "Treat the runner result as failed and regenerate the plan.",
    );
  }
  const runId = `run-${task.taskId}`;
  const candidateId = patch.operations.length === 0 ? null : `patch-${task.taskId}`;
  const materialized = materializeConsolidationPatch({ task, patch, candidateId, runId });
  const accepted = await memorySubmitConsolidation(context.engine, {
    taskId: task.taskId,
    claimToken: claim.claimToken,
    responseDigest: sha256Hex(canonicalJson(patch)),
    runId,
    candidateId,
    operations: materialized.operations,
    assessments: materialized.assessments,
  });
  return { accepted, materialized };
}

async function runConsolidate(invocation, options) {
  const context = await openMemoryContext(invocation, options);
  try {
    if (invocation.approvePlan === undefined) {
      return await createConsolidationPreview(context, invocation, options);
    }
    const pending = await loadPendingRunnerPlan(context, invocation.approvePlan);
    if (pending === null) {
      throw memoryDiagnostic(
        "TS_INPUT_READ_FAILED",
        `No pending consolidation plan matches ${invocation.approvePlan}.`,
        "Run `threadshare memory consolidate --runner <provider>` to generate it first.",
      );
    }
    assertPendingRunner(pending, invocation.runner);
    if (pending.plan.taskKind !== "consolidation") {
      throw memoryDiagnostic(
        "TS_INPUT_SCHEMA_INVALID",
        `Pending task ${pending.plan.taskId} is ${pending.plan.taskKind}, not consolidation.`,
        "Approve this digest with the command that created it.",
      );
    }
    const approvedPlan = approvePlan(pending.plan, { approvedDigest: invocation.approvePlan });
    const conformance = await ensureConformance(
      context,
      pending.profile,
      pending.profile.adapter,
      options,
    );
    const { accepted } = await deliverPendingConsolidation(
      context,
      pending,
      approvedPlan,
      conformance,
      options,
    );
    return {
      action: "consolidate",
      authorized: true,
      taskId: accepted.taskId,
      runId: accepted.runId,
      status: accepted.status,
      entryCount: accepted.entryCount,
      candidateId: accepted.candidate?.candidateId ?? null,
      note: accepted.status === "no_op"
        ? `This run marked ${accepted.entryCount} approved L1 entries as consolidated with no changes.`
        : "The patch is quarantined. Review every operation with `threadshare memory review --kind consolidation`.",
    };
  } finally {
    await context.close();
  }
}

async function runExtract(invocation, options) {
  const context = await openMemoryContext(invocation, options);
  try {
    const authorizedDigest = invocation.approvePlan;
    const manifestDigest = invocation.approveManifest;

    if (authorizedDigest !== undefined) {
      const pending = await loadPendingRunnerPlan(context, authorizedDigest);
      if (pending === null) {
        throw memoryDiagnostic(
          "TS_INPUT_READ_FAILED",
          `No pending runner plan matches ${authorizedDigest}.`,
          "Run memory extract with --request to generate the plan before authorizing it.",
        );
      }
      assertPendingRunner(pending, invocation.runner);
      const profile = pending.profile;
      const approvedPlan = approvePlan(pending.plan, { approvedDigest: authorizedDigest });
      const conformance = await ensureConformance(
        context,
        profile,
        profile.adapter,
        options,
      );
      if (pending.plan.taskKind === "extraction") {
        const result = await deliverPendingExtraction(
          context,
          profile,
          pending,
          approvedPlan,
          conformance,
          options,
          { via: "digest" },
        );
        return {
          action: "extract",
          authorized: true,
          dataSource: "pending-insights-retrospective",
          delivered: [result.delivered],
          failed: [],
          plans: [summarizePlan(result.adjudication.plan)],
          manifestDigest: null,
          note: "Extraction completed. No adjudication input was delivered; approve the listed plan in a separate invocation.",
        };
      }
      if (pending.plan.taskKind === "adjudication") {
        const outcome = await deliverPendingAdjudication(
          context,
          profile,
          pending,
          approvedPlan,
          conformance,
          options,
          { via: "digest" },
        );
        return {
          action: "extract",
          authorized: true,
          dataSource: "pending-runner-artifact",
          delivered: [{
            taskId: pending.plan.taskId,
            taskKind: "adjudication",
            adjudication: outcome.status,
            ...(outcome.reason === undefined ? {} : { reason: outcome.reason }),
          }],
          failed: [],
          plans: [],
          manifestDigest: null,
        };
      }
      throw memoryDiagnostic(
        "TS_INPUT_SCHEMA_INVALID",
        `Unsupported pending task kind ${pending.plan.taskKind}.`,
        "Regenerate the pending Team Memory plan.",
      );
    }

    if (manifestDigest !== undefined) {
      const storedManifest = await loadPendingRunnerManifest(context, manifestDigest);
      if (storedManifest === null) {
        throw memoryDiagnostic(
          "TS_INPUT_READ_FAILED",
          `No pending runner manifest matches ${manifestDigest}.`,
          "Run memory extract with --request to generate the manifest before authorizing it.",
        );
      }
      const result = await deliverStoredManifest(context, storedManifest, invocation.runner, options);
      return {
        action: "extract",
        authorized: true,
        dataSource: "pending-runner-artifact",
        ...result,
        ...(result.plans.length === 0 ? {} : {
          note: "Extraction completed. No adjudication input was delivered; approve the listed next-stage plans separately.",
        }),
      };
    }

    const request = await readMemoryExtractionRequest(invocation, options);
    return await createExtractionPreview(context, invocation, request, invocation.limit, options);
  } finally {
    await context.close();
  }
}

// ---------------------------------------------------------------------------
// Dispatch + formatting
// ---------------------------------------------------------------------------

export async function executeMemoryCommand(invocation, options = {}) {
  switch (invocation.action) {
    case "init": return runInit(invocation, options);
    case "status": return runStatus(invocation, options);
    case "lint": return runLint(invocation, options);
    case "review": return runReview(invocation, options);
    case "promote": return runPromote(invocation, options);
    case "assemble": return runAssemble(invocation, options);
    case "reverify-runner": return runReverifyRunner(invocation, options);
    case "extract": return runExtract(invocation, options);
    case "consolidate": return runConsolidate(invocation, options);
    default:
      throw memoryDiagnostic("TS_USAGE_INVALID_VALUE", `Unknown memory action: ${invocation.action}.`,
        `Choose one of: ${MEMORY_ACTIONS.join(", ")}.`);
  }
}

function line(lines, value) {
  lines.push(value);
}

export function formatMemoryCommandResult(result, invocation) {
  if (invocation.format === "json") return `${JSON.stringify(result)}\n`;
  const lines = [];
  switch (result.action) {
    case "init":
      line(lines, `Initialized team memory under ${result.memoryRoot}.`);
      line(lines, `memory-state: ${result.memoryStateUuid}`);
      line(lines, result.created.length > 0
        ? `Created: ${result.created.join(", ")}`
        : "Skeleton already present.");
      break;
    case "status":
      line(lines, `Team memory status (${result.memoryRoot})`);
      line(lines, `  chunks:     pending ${result.chunks.pending}, drafted ${result.chunks.drafted}, extracted ${result.chunks.extracted}, stale ${result.chunks.stale}`);
      line(lines, `  tasks:      pending ${result.tasks.pending}, claimed ${result.tasks.claimed}, submitted ${result.tasks.submitted}, stale ${result.tasks.stale}`);
      line(lines, `  candidates: draft ${result.candidates.draft}, quarantined ${result.candidates.quarantined}, promoted ${result.candidates.promoted}, discarded ${result.candidates.discarded}`);
      line(lines, `  promotions: generated ${result.promotions.generated}, approved ${result.promotions.approved}, applied ${result.promotions.applied}, voided ${result.promotions.voided}`);
      line(lines, `  consolidation: pending review ${result.consolidations.pendingReview}, no-op ${result.consolidations.noOp}, applied ${result.consolidations.applied}, stale ${result.consolidations.stale}`);
      if (result.consolidations.lastSuccessfulEntryCount > 0) {
        line(lines, `  last baseline: ${result.consolidations.lastSuccessfulEntryCount} L1 entr${result.consolidations.lastSuccessfulEntryCount === 1 ? "y" : "ies"}${result.consolidations.lastSuccessfulNoOp ? " (no changes)" : ""}`);
      }
      break;
    case "lint":
      if (result.files.length === 0) {
        line(lines, "No entry files to lint.");
      } else {
        for (const file of result.files) {
          line(lines, `${file.ok ? "ok  " : "BLOCK"} ${file.path}`);
          for (const finding of file.findings) {
            line(lines, `      [${finding.severity}] ${finding.code}${finding.excerpt ? `: ${finding.excerpt}` : ""}`);
          }
        }
      }
      line(lines, result.blocked ? "Lint found blocking findings." : "Lint passed.");
      break;
    case "review":
      if (result.plan) {
        line(lines, `Promotion plan ${result.plan.planId} (digest ${result.plan.planDigest.slice(0, 12)}…)`);
        for (const file of result.plan.files) {
          line(lines, `  ${file.operation === "delete" ? "-" : "+"} ${file.targetPath} (${file.bytes} bytes)`);
        }
        line(lines, `Run \`threadshare memory promote --plan ${result.plan.planId}\`.`);
      } else {
        line(lines, result.note);
      }
      if (result.pending.length > 0) {
        line(lines, `Pending confirmation: ${result.pending.length} candidate(s).`);
      }
      break;
    case "promote":
      if (result.status === "voided") {
        line(lines, `Plan ${result.planId} voided: ${result.driftedPath} drifted.`);
        line(lines, result.note);
      } else {
        line(lines, `Applied plan ${result.planId}${result.idempotent ? " (idempotent replay)" : ""}.`);
        for (const file of result.appliedFiles) line(lines, `  wrote ${file}`);
      }
      break;
    case "assemble":
      line(lines, result.changed
        ? `Updated ${result.target} team memory block (${result.scenes} scene(s), doctrine ${result.doctrine ? "present" : "absent"}).`
        : `${result.target} already up to date.`);
      break;
    case "reverify-runner":
      line(lines, `Runner ${result.runner} (${result.profile}) passed conformance at ${result.passedAt}.`);
      break;
    case "consolidate":
      if (!result.authorized) {
        if (result.plans.length === 0) {
          line(lines, result.note);
        } else {
          const plan = result.plans[0];
          line(lines, `Pending consolidation plan ${plan.planDigest} (${result.entryCount} approved L1 entries, ${plan.bytesToSend} bytes).`);
          line(lines, result.note);
        }
      } else {
        line(lines, result.status === "no_op"
          ? `Consolidation completed with no changes for ${result.entryCount} approved L1 entries.`
          : `Consolidation patch ${result.candidateId} is awaiting operation review.`);
        line(lines, result.note);
      }
      break;
    case "extract":
      if (!result.authorized) {
        line(lines, result.plans.length === 0
          ? `No pending extraction plans; data source: ${result.dataSource}.`
          : `Pending extraction plan(s); data source: ${result.dataSource}.`);
        if (result.selection !== undefined) {
          line(lines, `  matched sessions=${result.selection.matchedSessions} rejected=${result.selection.rejectedSessions} pending chunks=${result.selection.pendingChunks}`);
        }
        for (const plan of result.plans) {
          line(lines, `  ${plan.taskKind} plan ${plan.planDigest} ${plan.provider}/${plan.model} ${plan.bytesToSend} bytes retention=${plan.providerRetention}`);
        }
        if (result.manifestDigest) line(lines, `  manifest ${result.manifestDigest}`);
        line(lines, result.note);
      } else {
        line(lines, `Delivered ${result.delivered.length} authorized runner task(s).`);
        for (const item of result.delivered) {
          if (item.taskKind === "extraction") {
            line(lines, `  extraction ${item.taskId}: ${item.candidates} candidate(s)`);
          } else {
            line(lines, `  adjudication ${item.taskId}: ${item.adjudication}${item.reason ? ` (${item.reason})` : ""}`);
          }
        }
        for (const item of result.failed ?? []) {
          line(lines, `  failed ${item.taskId}: ${item.code} ${item.problem}`);
        }
        if ((result.plans ?? []).length > 0) {
          line(lines, "Pending next-stage plan(s); no input for these tasks was delivered.");
          for (const plan of result.plans) {
            line(lines, `  ${plan.taskKind} plan ${plan.planDigest} ${plan.provider}/${plan.model} ${plan.bytesToSend} bytes retention=${plan.providerRetention}`);
          }
          if (result.manifestDigest) line(lines, `  manifest ${result.manifestDigest}`);
          line(lines, result.note);
        }
      }
      break;
    default:
      line(lines, JSON.stringify(result));
  }
  return `${lines.join("\n")}\n`;
}

// ---------------------------------------------------------------------------
// MCP executors: read-only search/status plus pending-only extraction preview
// ---------------------------------------------------------------------------

/**
 * `search` and `status` are read-only. `extract-preview` may persist private
 * pending plans, but never approves or starts a runner. No MCP result carries
 * transcript bytes.
 */
export async function executeMemoryMcp(action, args, options = {}) {
  const context = await openMemoryContext({ resolveOwner: true, repository: options.repository }, options);
  try {
    if (action === "search") {
      const result = await memorySearch(context.engine, {
        ...context.owner,
        query: args.query,
        ...(args.limit === undefined ? {} : { limit: args.limit }),
      });
      return {
        format: "threadshare-memory-search@v1",
        generation: result.generation,
        coverage: result.coverage,
        items: result.items,
      };
    }
    if (action === "status") {
      const status = await memoryStatus(context.engine, context.owner);
      return {
        format: "threadshare-memory-status@v1",
        chunks: status.chunks,
        tasks: status.tasks,
        candidates: status.candidates,
        promotions: {
          generated: status.promotions.generated,
          approved: status.promotions.approved,
          applied: status.promotions.applied,
          voided: status.promotions.voided,
        },
        consolidations: status.consolidations,
        extraction: {
          entrypoint: "mcp-preview-cli-approval",
          note: "MCP can create pending extraction plans only. Use the CLI to approve each exact delivery digest; no transcript is ever returned here.",
        },
      };
    }
    if (action === "extract-preview") {
      const preview = await createExtractionPreview(context, {
        runner: args.runner,
        runnerModel: args.model,
        runnerEndpoint: args.endpoint,
      }, args.request, args.limit ?? 1, options);
      return {
        format: "threadshare-memory-extraction-preview@v1",
        authorized: false,
        dataSource: preview.dataSource,
        plans: preview.plans,
        manifestDigest: preview.manifestDigest,
        selection: preview.selection,
        note: preview.note,
      };
    }
    if (action === "consolidate-preview") {
      const preview = await createConsolidationPreview(context, {
        action: "consolidate",
        runner: args.runner,
        runnerModel: args.model,
        runnerEndpoint: args.endpoint,
        ifDue: args.ifDue === true,
        full: args.full === true,
      }, options);
      return {
        format: "threadshare-memory-consolidation-preview@v1",
        authorized: false,
        plans: preview.plans,
        entryCount: preview.entryCount ?? 0,
        pendingRunId: preview.pendingRunId ?? null,
        note: preview.note,
      };
    }
    throw new Error(`unknown memory mcp action: ${action}`);
  } finally {
    await context.close();
  }
}
