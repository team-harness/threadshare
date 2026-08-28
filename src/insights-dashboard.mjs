import { constants } from "node:fs";
import { lstat, open, readdir } from "node:fs/promises";
import process from "node:process";
import path from "node:path";

import {
  createInsightsBackgroundWorker,
  insightsRequiredContract,
} from "./insights-command.mjs";
import { createInsightsDashboardServer } from "./insights-dashboard-server.mjs";
import { inspectInsightsState } from "./insights-lifecycle.mjs";
import { readExistingInsightsConfig } from "./insights-config.mjs";
import { createInsightsContinuationContext } from "./insights-continuation-context.mjs";
import { readGitDiffEvidence } from "./insights-git-evidence.mjs";
import { resolveInsightsPaths } from "./insights-paths.mjs";
import {
  executeInsightsDeepEvidenceRequest,
  executeInsightsDeepQueryRequest,
  executeInsightsDeliveryTraceRequest,
  executeInsightsGitDiffEvidenceRequest,
  executeInsightsRecipeRequest,
} from "./insights-query.mjs";
import { createInsightsQueryReader } from "./insights-query-reader.mjs";
import { resolveGitRepository } from "./insights-repository-source.mjs";
import { openExistingInsightsState } from "./insights-state.mjs";
import { parseMemoryEntry, parseSceneMeta, validateDoctrine } from "./memory-format.mjs";
import { parseSkillDocument } from "./memory-skill.mjs";

const DEFAULT_QUIESCENCE_SECONDS = 300;
const ENGINE_STATUS_SKIPPED = "TS_INSIGHTS_ENGINE_STATUS_SKIPPED";
const CONTRACT_KEY = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;
const SOURCE_ID = /^[a-z][a-z0-9-]{0,63}$/u;
const MAX_MEMORY_ASSETS = 100;
const MAX_MEMORY_COLLECTION_ENTRIES = 256;
const MAX_MEMORY_ASSET_BYTES = 1024 * 1024;
const MEMORY_ASSET_ID = /^[a-z0-9](?:[a-z0-9-]{0,126}[a-z0-9])?$/u;
const PROJECT_PROVIDERS = Object.freeze(["codex", "claude"]);

function dashboardError(code, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

function dashboardIndexLocation(environment = process.env) {
  return typeof environment?.THREADSHARE_INSIGHTS_HOME === "string" &&
    environment.THREADSHARE_INSIGHTS_HOME.trim() !== ""
    ? "THREADSHARE_INSIGHTS_HOME override"
    : "Platform state directory";
}

function boundedText(value, maximum = 240) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  const characters = [...normalized];
  return characters.length <= maximum
    ? normalized
    : `${characters.slice(0, Math.max(0, maximum - 1)).join("")}\u2026`;
}

function markdownTitle(body, fallback) {
  const heading = /^#{1,3}\s+(.+)$/mu.exec(body)?.[1];
  return boundedText(heading ?? body, 120) || fallback;
}

async function directoryEntries(root, segments) {
  let current = root;
  for (const segment of segments) {
    current = path.join(current, segment);
    let info;
    try {
      info = await lstat(current);
    } catch (error) {
      if (error?.code === "ENOENT") return null;
      throw error;
    }
    if (info.isSymbolicLink() || !info.isDirectory()) {
      throw dashboardError(
        "TS_MEMORY_ASSET_INVALID",
        "Team Memory asset directory is not a regular directory",
      );
    }
  }
  return Object.freeze({
    directory: current,
    entries: Object.freeze((await readdir(current, { withFileTypes: true }))
      .sort((left, right) => left.name.localeCompare(right.name))),
  });
}

async function readRegularFile(filename) {
  let handle;
  try {
    handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    const info = await handle.stat();
    if (!info.isFile() || info.size <= 0 || info.size > MAX_MEMORY_ASSET_BYTES) {
      throw dashboardError("TS_MEMORY_ASSET_INVALID", "Team Memory asset is invalid");
    }
    return await handle.readFile("utf8");
  } catch (error) {
    if (error?.code === "ELOOP") {
      throw dashboardError("TS_MEMORY_ASSET_INVALID", "Team Memory asset cannot be a symbolic link");
    }
    throw error;
  } finally {
    await handle?.close();
  }
}

function countDiagnostic(diagnostics, code) {
  diagnostics.set(code, (diagnostics.get(code) ?? 0) + 1);
}

function assetRecord(kind, values) {
  return Object.freeze({
    kind,
    id: values.id,
    title: values.title,
    summary: values.summary,
    state: values.state,
    evidenceStrength: values.evidenceStrength ?? null,
    limitations: Object.freeze([...(values.limitations ?? [])]),
    updatedAt: values.updatedAt ?? null,
    heat: values.heat ?? null,
  });
}

/** Read only the reviewed, Git-visible Team Memory projection for Dashboard display. */
export async function readDashboardMemoryAssets(rootDirectory) {
  const assets = [];
  const diagnostics = new Map();
  const counts = { entries: 0, scenes: 0, doctrine: 0, skills: 0 };
  let truncated = false;
  const push = (asset) => {
    if (assets.length >= MAX_MEMORY_ASSETS) {
      truncated = true;
      return;
    }
    assets.push(asset);
  };
  const boundedEntries = (snapshot, diagnostic) => {
    const entries = snapshot?.entries ?? [];
    if (entries.length <= MAX_MEMORY_COLLECTION_ENTRIES) return entries;
    truncated = true;
    countDiagnostic(diagnostics, diagnostic);
    return entries.slice(0, MAX_MEMORY_COLLECTION_ENTRIES);
  };
  const memory = await directoryEntries(rootDirectory, [".threadshare", "memory"]);
  if (memory === null) {
    return Object.freeze({
      format: "threadshare-insights-dashboard-memory-assets@v1",
      initialized: false,
      assets: Object.freeze([]),
      counts: Object.freeze({ entries: "0", scenes: "0", doctrine: "0", skills: "0" }),
      diagnostics: Object.freeze([]),
      truncated: false,
    });
  }

  const entries = await directoryEntries(rootDirectory, [".threadshare", "memory", "entries"]);
  for (const entry of boundedEntries(entries, "TS_MEMORY_ASSET_ENTRY_LIMIT")) {
    if (!entry.isFile() || !entry.name.endsWith(".md")) {
      countDiagnostic(diagnostics, "TS_MEMORY_ASSET_ENTRY_SKIPPED");
      continue;
    }
    try {
      const parsed = parseMemoryEntry(await readRegularFile(path.join(entries.directory, entry.name)));
      counts.entries += 1;
      push(assetRecord("entry", {
        id: parsed.frontmatter.id,
        title: markdownTitle(parsed.body, parsed.frontmatter.id),
        summary: boundedText(parsed.body),
        state: parsed.frontmatter.status,
        evidenceStrength: parsed.frontmatter.provenance_strength,
        limitations: parsed.frontmatter.limitations,
      }));
    } catch {
      countDiagnostic(diagnostics, "TS_MEMORY_ASSET_ENTRY_INVALID");
    }
  }

  const scenes = await directoryEntries(rootDirectory, [".threadshare", "memory", "scenes"]);
  for (const entry of boundedEntries(scenes, "TS_MEMORY_ASSET_SCENE_LIMIT")) {
    const id = entry.name.endsWith(".md") ? entry.name.slice(0, -3) : "";
    if (!entry.isFile() || !MEMORY_ASSET_ID.test(id)) {
      countDiagnostic(diagnostics, "TS_MEMORY_ASSET_SCENE_SKIPPED");
      continue;
    }
    try {
      const parsed = parseSceneMeta(await readRegularFile(path.join(scenes.directory, entry.name)));
      counts.scenes += 1;
      push(assetRecord("scene", {
        id,
        title: markdownTitle(parsed.body, id),
        summary: parsed.meta.summary,
        state: "synthesized",
        updatedAt: parsed.meta.updated,
        heat: parsed.meta.heat,
      }));
    } catch {
      countDiagnostic(diagnostics, "TS_MEMORY_ASSET_SCENE_INVALID");
    }
  }

  const doctrineFile = path.join(memory.directory, "doctrine.md");
  try {
    const doctrineInfo = await lstat(doctrineFile);
    if (doctrineInfo.isSymbolicLink() || !doctrineInfo.isFile()) {
      throw dashboardError("TS_MEMORY_ASSET_INVALID", "Team Memory doctrine is invalid");
    }
    const doctrine = await readRegularFile(doctrineFile);
    validateDoctrine(doctrine);
    counts.doctrine += 1;
    push(assetRecord("doctrine", {
      id: "doctrine",
      title: markdownTitle(doctrine, "Team doctrine"),
      summary: boundedText(doctrine),
      state: "synthesized",
    }));
  } catch (error) {
    if (error?.code !== "ENOENT") countDiagnostic(diagnostics, "TS_MEMORY_ASSET_DOCTRINE_INVALID");
  }

  const skills = await directoryEntries(rootDirectory, [".threadshare", "memory", "skills"]);
  for (const entry of boundedEntries(skills, "TS_MEMORY_ASSET_SKILL_LIMIT")) {
    if (!entry.isDirectory() || !MEMORY_ASSET_ID.test(entry.name)) {
      countDiagnostic(diagnostics, "TS_MEMORY_ASSET_SKILL_SKIPPED");
      continue;
    }
    try {
      const skillDirectory = await directoryEntries(rootDirectory, [
        ".threadshare", "memory", "skills", entry.name,
      ]);
      const parsed = parseSkillDocument(
        await readRegularFile(path.join(skillDirectory.directory, "SKILL.md")),
        { expectedName: entry.name },
      );
      counts.skills += 1;
      push(assetRecord("skill", {
        id: parsed.name,
        title: parsed.name,
        summary: parsed.description,
        state: "projected",
      }));
    } catch {
      countDiagnostic(diagnostics, "TS_MEMORY_ASSET_SKILL_INVALID");
    }
  }

  return Object.freeze({
    format: "threadshare-insights-dashboard-memory-assets@v1",
    initialized: true,
    assets: Object.freeze(assets),
    counts: Object.freeze(Object.fromEntries(
      Object.entries(counts).map(([key, value]) => [key, String(value)]),
    )),
    diagnostics: Object.freeze([...diagnostics]
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([code, count]) => Object.freeze({ code, count }))),
    truncated,
  });
}

export function createCommittedInsightsReader(options) {
  const reader = createInsightsQueryReader(options);

  return Object.freeze({
    invalidate() {
      reader.invalidate();
    },
    async readStatus(input) {
      try {
        return await reader.status(input);
      } catch (error) {
        if (error?.code === "TS_INSIGHTS_NOT_INDEXED") return null;
        throw error;
      }
    },
    async search(input, options_) {
      return reader.search(input, options_);
    },
    async evidence(input, options_) {
      return reader.evidence(input, options_);
    },
    async capabilities(input, options_) {
      return reader.capabilities(input, options_);
    },
    async queryV2(input, options_) {
      return reader.queryV2(input, options_);
    },
    async evidenceV2(input, options_) {
      return reader.evidenceV2(input, options_);
    },
    async deliveryTrace(input, options_) {
      return reader.deliveryTrace(input, options_);
    },
    async recipe(input, options_) {
      return reader.recipe(input, options_);
    },
    async close() {
      await reader.close();
    },
  });
}

function inspectorRequestError() {
  return dashboardError(
    "TS_INSIGHTS_DASHBOARD_REQUEST_INVALID",
    "Insights Inspector request is invalid",
  );
}

function exactKeys(value, expected) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    Object.keys(value).sort().join("\0") === [...expected].sort().join("\0");
}

function optionalTimestamp(value) {
  return value === null || (typeof value === "string" && TIMESTAMP.test(value) &&
    Number.isFinite(Date.parse(value)) && new Date(value).toISOString() === value);
}

function inspectorEdgeQuery(input) {
  if (!exactKeys(input, ["repositoryKey", "after", "before", "cursor", "limit"]) ||
      !CONTRACT_KEY.test(input.repositoryKey ?? "") ||
      !optionalTimestamp(input.after) || !optionalTimestamp(input.before) ||
      (input.after !== null && input.before !== null && input.after >= input.before) ||
      (input.cursor !== null && (typeof input.cursor !== "string" || input.cursor.length === 0)) ||
      !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw inspectorRequestError();
  }
  const predicates = [
    { field: "repositoryKey", op: "eq", value: input.repositoryKey },
    ...(input.after === null ? [] : [{ field: "observedAt", op: "gte", value: input.after }]),
    ...(input.before === null ? [] : [{ field: "observedAt", op: "lt", value: input.before }]),
  ];
  return {
    format: "threadshare-insights-query-request@v2",
    resource: "delivery-edge",
    where: predicates.length === 1 ? predicates[0] : { and: predicates },
    shape: {
      kind: "records",
      select: [
        "edgeKey", "repositoryKey", "fromKind", "fromKey", "toKind", "toKey",
        "relation", "strength", "source", "commitHash", "normalizedPath", "oldPath",
        "changeKind", "additions", "deletions", "reachable", "observedAt", "revision",
      ],
      payloadMode: "reference",
    },
    orderBy: [
      { field: "observedAt", direction: "desc" },
      { field: "edgeKey", direction: "asc" },
    ],
    limit: input.limit,
    cursor: input.cursor,
    count: "exact",
  };
}

function optionalCursor(value) {
  return value === null || (typeof value === "string" && value.length > 0 && value.length <= 32_768);
}

function conversationSessionsQuery(input) {
  if (!exactKeys(input, [
    "after", "before", "provider", "projectKey", "query", "toolCapabilityKey",
    "skillCapabilityKey", "completeness", "cursor", "limit",
  ]) || !optionalTimestamp(input.after) || !optionalTimestamp(input.before) ||
      (input.after !== null && input.before !== null && input.after >= input.before) ||
      (input.provider !== null && !SOURCE_ID.test(input.provider ?? "")) ||
      (input.projectKey !== null && !CONTRACT_KEY.test(input.projectKey ?? "")) ||
      (input.toolCapabilityKey !== null && !CONTRACT_KEY.test(input.toolCapabilityKey ?? "")) ||
      (input.skillCapabilityKey !== null && !CONTRACT_KEY.test(input.skillCapabilityKey ?? "")) ||
      (input.completeness !== null && !["full", "truncated"].includes(input.completeness)) ||
      typeof input.query !== "string" || [...input.query].length > 8192 ||
      !optionalCursor(input.cursor) ||
      !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw inspectorRequestError();
  }
  const query = input.query.trim();
  const predicates = [
    ...(input.after === null ? [] : [{ field: "observedAt", op: "gte", value: input.after }]),
    ...(input.before === null ? [] : [{ field: "observedAt", op: "lt", value: input.before }]),
    ...(input.provider === null ? [] : [{ field: "provider", op: "eq", value: input.provider }]),
    ...(input.projectKey === null ? [] : [{ field: "projectKey", op: "eq", value: input.projectKey }]),
    ...(input.toolCapabilityKey === null ? [] : [{ field: "capability.key", op: "eq", value: input.toolCapabilityKey }]),
    ...(input.skillCapabilityKey === null ? [] : [{ field: "capability.key", op: "eq", value: input.skillCapabilityKey }]),
    ...(input.completeness === null ? [] : [{ field: "completeness", op: "eq", value: input.completeness }]),
    ...(query === "" ? [] : [{ field: "text", op: "match", value: query }]),
  ];
  return {
    format: "threadshare-insights-query-request@v2",
    resource: "session",
    where: predicates.length === 0 ? null : predicates.length === 1 ? predicates[0] : { and: predicates },
    shape: {
      kind: "records",
      select: [
        "sessionKey", "provider", "projectKey", "originScope", "completeness",
        "session.startedAt", "session.endedAt", "session.title",
        "session.turnCount", "revision",
      ],
      payloadMode: "omit",
    },
    orderBy: [
      { field: "session.endedAt", direction: "desc" },
      { field: "sessionKey", direction: "asc" },
    ],
    limit: input.limit,
    cursor: input.cursor,
    count: "exact",
  };
}

function conversationMessagesQuery(input, payloadMode = "inline") {
  if (!exactKeys(input, ["sessionKey", "cursor", "limit"]) ||
      !CONTRACT_KEY.test(input.sessionKey ?? "") || !optionalCursor(input.cursor) ||
      !Number.isSafeInteger(input.limit) || input.limit < 1 || input.limit > 50) {
    throw inspectorRequestError();
  }
  return {
    format: "threadshare-insights-query-request@v2",
    resource: "event",
    where: { and: [
      { field: "sessionKey", op: "eq", value: input.sessionKey },
      { field: "originScope", op: "eq", value: "main" },
      { field: "event.kind", op: "eq", value: "visible-message" },
    ] },
    shape: {
      kind: "records",
      select: [
        "eventKey", "sessionKey", "turnKey", "provider", "observedAt",
        "completeness", "revision", "event.kind", "message.role", "message.content",
      ],
      payloadMode,
    },
    orderBy: [
      { field: "observedAt", direction: "desc" },
      { field: "eventKey", direction: "asc" },
    ],
    limit: input.limit,
    cursor: input.cursor,
    count: "exact",
  };
}

export function createInsightsInspectorApi(options) {
  const readConfig = options.readConfig ?? readExistingInsightsConfig;
  const resolveRepository = options.resolveRepository ?? resolveGitRepository;
  const readGitDiff = options.readGitDiff ?? readGitDiffEvidence;
  const readMemoryAssets = options.readMemoryAssets ?? readDashboardMemoryAssets;
  const evaluatedAt = () => new Date(options.now()).toISOString();
  const registeredRepositories = async () => {
    const config = await readConfig({ paths: options.state.paths });
    return (config.insights.repositories ?? []).map((repository) => Object.freeze({
      repositoryKey: options.state.privacyContext.fingerprint(
        "repository",
        repository.repositoryId,
      ),
      label: path.basename(repository.rootDirectory) || "Local repository",
      rootDirectory: repository.rootDirectory,
    })).sort((left, right) => left.repositoryKey.localeCompare(right.repositoryKey));
  };
  const publicRepositoryPage = async () => Object.freeze({
    format: "threadshare-insights-dashboard-repositories@v1",
    items: Object.freeze((await registeredRepositories()).map((repository) => Object.freeze({
      repositoryKey: repository.repositoryKey,
      label: repository.label,
    }))),
  });
  const publicProjectPage = async () => {
    const projectFingerprint = options.state.privacyContext?.projectFingerprint;
    if (typeof projectFingerprint !== "function") {
      throw dashboardError(
        "TS_INSIGHTS_DASHBOARD_PROJECT_CATALOG_UNAVAILABLE",
        "Project catalog is unavailable for this Insights state",
      );
    }
    const projects = [];
    const seen = new Set();
    for (const repository of await registeredRepositories()) {
      for (const provider of PROJECT_PROVIDERS) {
        const projectKey = projectFingerprint(provider, repository.rootDirectory);
        if (seen.has(projectKey)) continue;
        seen.add(projectKey);
        projects.push(Object.freeze({
          projectKey,
          repositoryKey: repository.repositoryKey,
          provider,
          label: repository.label,
        }));
      }
    }
    projects.sort((left, right) =>
      left.label.localeCompare(right.label) ||
      left.provider.localeCompare(right.provider) ||
      left.projectKey.localeCompare(right.projectKey));
    return Object.freeze({
      format: "threadshare-insights-dashboard-projects@v1",
      items: Object.freeze(projects),
    });
  };
  return Object.freeze({
    inspectorRepositories: publicRepositoryPage,
    experienceRepositories: publicRepositoryPage,
    historyProjects: publicProjectPage,
    async experienceAssets(input) {
      if (!exactKeys(input, ["repositoryKey"]) || !CONTRACT_KEY.test(input.repositoryKey ?? "")) {
        throw inspectorRequestError();
      }
      const repository = (await registeredRepositories()).find(
        (item) => item.repositoryKey === input.repositoryKey,
      );
      if (repository === undefined) {
        throw dashboardError(
          "TS_INSIGHTS_DASHBOARD_REPOSITORY_NOT_FOUND",
          "Registered repository was not found",
        );
      }
      const resolved = await resolveRepository(repository.rootDirectory);
      return Object.freeze({
        ...(await readMemoryAssets(resolved.rootDirectory)),
        repository: Object.freeze({
          repositoryKey: repository.repositoryKey,
          label: repository.label,
        }),
      });
    },
    inspectorEdges(input) {
      return executeInsightsDeepQueryRequest(inspectorEdgeQuery(input), {
        privacyContext: options.state.privacyContext,
        reader: options.reader,
        signal: options.signal,
        evaluatedAt: evaluatedAt(),
      });
    },
    conversationSessions(input) {
      return executeInsightsDeepQueryRequest(conversationSessionsQuery(input), {
        privacyContext: options.state.privacyContext,
        reader: options.reader,
        signal: options.signal,
        evaluatedAt: evaluatedAt(),
      });
    },
    async conversationMessages(input) {
      const execute = (payloadMode) => executeInsightsDeepQueryRequest(
        conversationMessagesQuery(input, payloadMode),
        {
          privacyContext: options.state.privacyContext,
          reader: options.reader,
          signal: options.signal,
          evaluatedAt: evaluatedAt(),
        },
      );
      try {
        return await execute("inline");
      } catch (error) {
        if (error?.code !== "TS_QUERY_TOO_BROAD") throw error;
        return execute("reference");
      }
    },
    inspectorTrace(input) {
      return executeInsightsDeliveryTraceRequest(input, {
        privacyContext: options.state.privacyContext,
        reader: options.reader,
        signal: options.signal,
        evaluatedAt: evaluatedAt(),
      });
    },
    inspectorEvidence(input) {
      return executeInsightsDeepEvidenceRequest(input, {
        privacyContext: options.state.privacyContext,
        reader: options.reader,
        signal: options.signal,
      });
    },
    inspectorSessionTimeline(input) {
      return executeInsightsRecipeRequest("session-timeline@1", input, {
        privacyContext: options.state.privacyContext,
        reader: options.reader,
        signal: options.signal,
        evaluatedAt: evaluatedAt(),
      });
    },
    inspectorGitDiff(input) {
      return executeInsightsGitDiffEvidenceRequest(input, {
        state: options.state,
        reader: options.reader,
        evaluatedAt: evaluatedAt(),
        signal: options.signal,
        readConfig,
        resolveRepository,
        readGitDiff,
      });
    },
    inspectorContinuation(input) {
      if (!exactKeys(input, ["trace", "recentPrompts", "failureChains"]) ||
          !Array.isArray(input.recentPrompts) || !Array.isArray(input.failureChains)) {
        throw inspectorRequestError();
      }
      return createInsightsContinuationContext(input.trace, {
        recentPrompts: input.recentPrompts,
        failureChains: input.failureChains,
      });
    },
  });
}

function countDiagnostics(diagnostics) {
  const counts = new Map();
  for (const item of diagnostics ?? []) {
    const code = typeof item?.code === "string" ? item.code : "unknown";
    const count = Number.isSafeInteger(item?.count) && item.count > 0 ? item.count : 1;
    counts.set(code, (counts.get(code) ?? 0) + count);
  }
  return Object.freeze([...counts]
    .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
    .map(([code, count]) => Object.freeze({ code, count })));
}

function workerView(status) {
  const report = status.lastReport?.report ?? status.lastReport ?? null;
  const lastError = status.lastError?.error;
  return Object.freeze({
    started: status.started,
    running: status.running,
    queued: status.queued,
    stale: status.stale,
    staleAll: status.staleAll,
    watcherDegraded: status.watcherDegraded,
    cycleCount: status.cycleCount,
    snapshotAgeMs: status.snapshotAgeMs,
    pendingSessionCount: status.pendingSessionCount,
    pendingUnknown: status.pendingUnknown,
    progress: report === null ? null : Object.freeze({
      planned: report.planned ?? 0,
      committed: report.committed ?? 0,
      unchanged: report.unchanged ?? 0,
      excluded: report.excluded ?? 0,
      missing: report.missing ?? 0,
      failed: report.failed ?? 0,
      bytesProcessed: report.bytesProcessed ?? null,
      bytesTotal: report.bytesTotal ?? null,
    }),
    discoveryDiagnostics: countDiagnostics(report?.diagnostics),
    recentError: lastError === undefined || lastError === null
      ? null
      : Object.freeze({
          phase: status.lastError.phase,
          code: typeof lastError.code === "string" ? lastError.code : "TS_OPERATION_FAILED",
        }),
  });
}

function normalizeSearchInput(input, nowUnixMs) {
  if (input === null || typeof input !== "object" || Array.isArray(input)) {
    throw dashboardError("TS_INSIGHTS_DASHBOARD_REQUEST_INVALID", "Search input must be an object");
  }
  return {
    query: input.query,
    filters: input.filters,
    limit: input.limit,
    pathLimit: input.pathLimit,
    nowUnixMs: String(nowUnixMs),
    quiescenceSeconds: DEFAULT_QUIESCENCE_SECONDS,
  };
}

export async function launchInsightsDashboard(options = {}) {
  const paths = options.paths ?? resolveInsightsPaths(options);
  const openState = options.openState ?? openExistingInsightsState;
  const inspectState = options.inspectState ?? inspectInsightsState;
  const createReader = options.createReader ?? createCommittedInsightsReader;
  const createServer = options.createServer ?? createInsightsDashboardServer;
  const createWorker = options.createWorker ?? createInsightsBackgroundWorker;
  const state = await openState({ ...options.stateOptions, paths });
  const requiredContract = insightsRequiredContract(state.originSecretEpoch);
  const reader = createReader({
    ...options,
    paths,
    originSecretEpoch: state.originSecretEpoch,
  });
  let worker = null;
  let latestProgress = null;
  let runtimeError = null;
  const now = options.now ?? Date.now;
  const inspectorApi = createInsightsInspectorApi({
    state,
    reader,
    now,
    signal: options.signal,
    readConfig: options.readConfig,
    resolveRepository: options.resolveRepository,
    readGitDiff: options.readGitDiff,
    readMemoryAssets: options.readMemoryAssets,
  });
  const api = Object.freeze({
    async status() {
      const filesystem = await inspectState({
        ...options.lifecycleOptions,
        paths,
        includeEngineStatus: false,
      });
      let committed = null;
      let readError = null;
      try {
        committed = await reader.readStatus({
          overview: {
            nowUnixMs: String(now()),
            quiescenceSeconds: DEFAULT_QUIESCENCE_SECONDS,
          },
          options: { signal: options.signal },
        });
      } catch (error) {
        readError = Object.freeze({
          code: typeof error?.code === "string" ? error.code : "TS_OPERATION_FAILED",
        });
      }
      const currentWorker = worker === null ? null : workerView(worker.status());
      const engine = committed === null ? null : Object.freeze({
        snapshotSeq: committed.overview.snapshotSeq,
        snapshotAgeMs: currentWorker?.snapshotAgeMs ?? null,
        snapshotPending: committed.overview.snapshotSeq === "0" ||
          currentWorker?.stale === true || currentWorker?.running === true || currentWorker?.queued === true,
        factStorageProfile: requiredContract.factStorageProfile,
        purge: committed.purge,
      });
      return Object.freeze({
        format: "threadshare-insights-dashboard-status@v1",
        state: committed === null && readError !== null ? "engine-unavailable"
          : committed === null ? filesystem.state : "ready",
        index: Object.freeze({
          location: dashboardIndexLocation(options.environment),
          bytes: filesystem.bytes,
          entries: filesystem.entries,
          databasePresent: filesystem.databasePresent,
        }),
        worker: currentWorker === null ? null : Object.freeze({
          ...currentWorker,
          progress: latestProgress ?? currentWorker.progress,
        }),
        engine,
        overview: committed?.overview ?? null,
        recentError: readError ?? runtimeError,
        diagnostics: Object.freeze((filesystem.diagnostics ?? []).filter(
          (code) => committed === null || code !== ENGINE_STATUS_SKIPPED,
        )),
      });
    },
    search(input) {
      return reader.search(normalizeSearchInput(input, now()), { signal: options.signal });
    },
    evidence(input) {
      return reader.evidence(input, { signal: options.signal });
    },
    capabilities(input) {
      return reader.capabilities(input, { signal: options.signal });
    },
    ...inspectorApi,
  });

  let server;
  try {
    const existingRuntimeError = options.serverOptions?.onRuntimeError;
    server = await createServer({
      ...options.serverOptions,
      api,
      paths,
      stateOptions: options.stateOptions,
      onRuntimeError(value) {
        runtimeError = Object.freeze({
          code: typeof value?.code === "string"
            ? value.code
            : "TS_INSIGHTS_DASHBOARD_RUNTIME_FAILED",
        });
        existingRuntimeError?.(value);
        options.onRuntimeError?.(runtimeError);
      },
    });
    const existingOnCycle = options.workerOptions?.onCycle;
    worker = createWorker({
      ...options,
      paths,
      onProgress(progress) {
        latestProgress = Object.freeze({ ...progress });
        options.onProgress?.(progress);
      },
      workerOptions: {
        ...options.workerOptions,
        onCycle(payload) {
          reader.invalidate();
          latestProgress = null;
          existingOnCycle?.(payload);
        },
      },
    });
    worker.start();
  } catch (error) {
    await reader.close();
    throw error;
  }

  let closing = null;
  const close = () => {
    if (closing !== null) return closing;
    closing = (async () => {
      await server.close();
      await worker.stop().catch(() => {});
      await reader.close();
    })();
    return closing;
  };
  const closed = server.closed.then(() => close());
  if (options.signal instanceof AbortSignal) {
    if (options.signal.aborted) void close();
    else options.signal.addEventListener("abort", () => { void close(); }, { once: true });
  }
  return Object.freeze({ url: server.url, closed, close });
}

export async function runInsightsDashboardUntilSignal(options = {}) {
  const controller = new AbortController();
  const onSignal = () => controller.abort();
  process.once("SIGINT", onSignal);
  process.once("SIGTERM", onSignal);
  try {
    const dashboard = await launchInsightsDashboard({ ...options, signal: controller.signal });
    process.stdout.write(`Threadshare Insights: ${dashboard.url}\n`);
    await dashboard.closed;
  } finally {
    process.off("SIGINT", onSignal);
    process.off("SIGTERM", onSignal);
  }
}
