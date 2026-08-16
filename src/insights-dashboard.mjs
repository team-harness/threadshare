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

const DEFAULT_QUIESCENCE_SECONDS = 300;
const ENGINE_STATUS_SKIPPED = "TS_INSIGHTS_ENGINE_STATUS_SKIPPED";
const CONTRACT_KEY = /^[0-9a-f]{64}$/u;
const TIMESTAMP = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/u;

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

export function createInsightsInspectorApi(options) {
  const readConfig = options.readConfig ?? readExistingInsightsConfig;
  const resolveRepository = options.resolveRepository ?? resolveGitRepository;
  const readGitDiff = options.readGitDiff ?? readGitDiffEvidence;
  const evaluatedAt = () => new Date(options.now()).toISOString();
  return Object.freeze({
    async inspectorRepositories() {
      const config = await readConfig({ paths: options.state.paths });
      const items = (config.insights.repositories ?? []).map((repository) => Object.freeze({
        repositoryKey: options.state.privacyContext.fingerprint(
          "repository",
          repository.repositoryId,
        ),
        label: path.basename(repository.rootDirectory) || "Local repository",
      })).sort((left, right) => left.repositoryKey.localeCompare(right.repositoryKey));
      return Object.freeze({
        format: "threadshare-insights-dashboard-repositories@v1",
        items: Object.freeze(items),
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
