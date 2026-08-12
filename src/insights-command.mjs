import { loadInsightsConfig, updateInsightsExclusion } from "./insights-config.mjs";
import { createInsightsEngineClient } from "./insights-engine-client.mjs";
import { createInsightsRequiredContract } from "./insights-engine-protocol.mjs";
import {
  createInsightsIndexWorker,
  hideConfiguredInsightsSources,
  runInsightsIndexer,
} from "./insights-indexer.mjs";
import { inspectInsightsState, resetInsightsState } from "./insights-lifecycle.mjs";
import { resolveInsightsPaths } from "./insights-paths.mjs";
import {
  INSIGHTS_REGENERATE_CONFIRMATION,
  recoverInsightsReindexSwap,
  reindexInsightsState,
} from "./insights-reindex.mjs";
import { openInsightsState } from "./insights-state.mjs";
import { withInsightsWriterLock } from "./insights-writer-lock.mjs";
import { discoverProviderEvidenceSources } from "./provider-evidence.mjs";
import { canonicalSessionId, sessionRoot } from "./session-files.mjs";

export const REGENERATE_SECRET_CONFIRMATION = INSIGHTS_REGENERATE_CONFIRMATION;

const ACTIONS = new Set(["status", "sync", "reindex", "reset", "exclude"]);
const EXCLUSION_OPERATIONS = new Set(["add", "remove", "list"]);
const EXCLUSION_KINDS = new Set(["provider", "project", "session"]);
const MAX_REINDEX_SOURCE_CHANGED_RETRIES = 3;
const REINDEX_SOURCE_CHANGED_RETRY_DELAY_MS = 100;

function commandError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function incompleteIndexError(index) {
  const counts = new Map();
  for (const diagnostic of index.diagnostics ?? []) {
    const provider = diagnostic?.provider === "codex" || diagnostic?.provider === "claude"
      ? diagnostic.provider
      : "unknown";
    const code = typeof diagnostic?.code === "string" ? diagnostic.code : "unknown";
    const errorCode = typeof diagnostic?.errorCode === "string"
      ? diagnostic.errorCode
      : "unknown";
    const key = `${provider}\0${code}\0${errorCode}`;
    counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  const failureSummary = Object.freeze({
    planned: index.planned,
    committed: index.committed,
    excluded: index.excluded,
    failed: index.failed,
    diagnostics: Object.freeze([...counts].sort(([left], [right]) => left.localeCompare(right))
      .map(([key, count]) => {
        const [provider, code, errorCode] = key.split("\0");
        return Object.freeze({ provider, code, errorCode, count });
      })),
  });
  const error = commandError(
    "TS_INSIGHTS_REINDEX_INCOMPLETE",
    "Insights candidate contains failed session operations",
  );
  Object.defineProperty(error, "failureSummary", {
    value: failureSummary,
    enumerable: false,
  });
  return error;
}

function onlySourceChangedFailures(index) {
  if (!Number.isSafeInteger(index?.failed) || index.failed < 1) return false;
  const matching = (index.diagnostics ?? []).filter((diagnostic) =>
    diagnostic?.code === "session-index-failed" &&
    diagnostic?.errorCode === "TS_INSIGHTS_SOURCE_CHANGED");
  return matching.length === index.failed;
}

function reindexSourceSetError() {
  return commandError(
    "TS_INSIGHTS_REINDEX_INCOMPLETE",
    "Insights source set changed while retrying candidate construction",
  );
}

function reindexSourceKey(source) {
  if (
    !source ||
    (source.provider !== "codex" && source.provider !== "claude") ||
    typeof source.sessionId !== "string" ||
    source.sessionId === ""
  ) {
    throw reindexSourceSetError();
  }
  return `${source.provider}\0${source.sessionId.toLowerCase()}`;
}

function reindexSourceSet(sources) {
  if (!Array.isArray(sources)) throw reindexSourceSetError();
  const keys = new Set();
  for (const source of sources) {
    const key = reindexSourceKey(source);
    if (keys.has(key)) throw reindexSourceSetError();
    keys.add(key);
  }
  return keys;
}

function assertSameReindexSourceSet(expected, actual) {
  if (expected.size !== actual.size) throw reindexSourceSetError();
  for (const key of expected) {
    if (!actual.has(key)) throw reindexSourceSetError();
  }
}

function mergeReindexRetryReport(index, committedSourceKeys) {
  const committed = committedSourceKeys.size;
  const previouslyCommitted = committed - index.committed;
  if (
    previouslyCommitted < 0 ||
    !Number.isSafeInteger(index.unchanged) ||
    index.unchanged < previouslyCommitted
  ) {
    throw reindexSourceSetError();
  }
  return {
    ...index,
    committed,
    unchanged: index.unchanged - previouslyCommitted,
  };
}

async function waitForSourceChangedRetry(signal) {
  await new Promise((resolve) => setTimeout(resolve, REINDEX_SOURCE_CHANGED_RETRY_DELAY_MS));
  signal?.throwIfAborted();
}

function assertFormat(format) {
  if (format !== "text" && format !== "json") {
    throw commandError("TS_USAGE_INVALID_VALUE", "--format must be text or json");
  }
}

export function parseInsightsInvocation(positionals, options = {}) {
  const [, action, operation, kind, value, ...extra] = positionals;
  const format = options.format ?? "text";
  assertFormat(format);
  if (action === undefined) {
    if (options["regenerate-secret"] === true) {
      throw commandError(
        "TS_USAGE_OPTION_NOT_ALLOWED",
        "--regenerate-secret is only valid for insights reindex",
      );
    }
    if (format !== "text") {
      throw commandError(
        "TS_USAGE_OPTION_NOT_ALLOWED",
        "--format is only valid for Insights maintenance actions",
      );
    }
    return Object.freeze({ action: "dashboard", format, regenerateSecret: false });
  }
  if (!ACTIONS.has(action)) {
    throw commandError(
      "TS_USAGE_INVALID_VALUE",
      "Insights action must be status, sync, reindex, reset, or exclude",
    );
  }
  if (extra.length > 0) {
    throw commandError("TS_USAGE_UNEXPECTED_ARGUMENT", "Unexpected Insights argument");
  }
  if (options["regenerate-secret"] === true && action !== "reindex") {
    throw commandError(
      "TS_USAGE_OPTION_NOT_ALLOWED",
      "--regenerate-secret is only valid for insights reindex",
    );
  }
  if (action !== "exclude") {
    if (operation !== undefined || kind !== undefined || value !== undefined) {
      throw commandError("TS_USAGE_UNEXPECTED_ARGUMENT", `Unexpected argument for insights ${action}`);
    }
    return Object.freeze({
      action,
      format,
      regenerateSecret: options["regenerate-secret"] === true,
    });
  }
  if (!EXCLUSION_OPERATIONS.has(operation)) {
    throw commandError(
      "TS_USAGE_INVALID_VALUE",
      "Insights exclusion operation must be add, remove, or list",
    );
  }
  if (operation === "list") {
    if (kind !== undefined || value !== undefined) {
      throw commandError("TS_USAGE_UNEXPECTED_ARGUMENT", "insights exclude list takes no value");
    }
    return Object.freeze({ action, operation, format, regenerateSecret: false });
  }
  if (!EXCLUSION_KINDS.has(kind)) {
    throw commandError(
      "TS_USAGE_INVALID_VALUE",
      "Insights exclusion kind must be provider, project, or session",
    );
  }
  if (typeof value !== "string" || value.trim() === "") {
    throw commandError("TS_USAGE_MISSING_ARGUMENT", "Insights exclusion value is required");
  }
  return Object.freeze({
    action,
    operation,
    kind,
    value,
    format,
    regenerateSecret: false,
  });
}

export function insightsRequiredContract(originSecretEpoch, options) {
  return createInsightsRequiredContract(originSecretEpoch, options);
}

async function discoverSources(options) {
  const discoveries = await Promise.all(
    ["codex", "claude"].map((provider) =>
      discoverProviderEvidenceSources(provider, options.discoveryOptions)),
  );
  return {
    sources: discoveries.flatMap(({ sources }) => sources),
    diagnostics: discoveries.flatMap(({ provider, diagnostics }) =>
      diagnostics.map((diagnostic) => ({ provider, ...diagnostic }))),
  };
}

export function insightsPurgeWorkPending(status) {
  const pending = (value) => {
    if (typeof value === "number") return Number.isSafeInteger(value) && value > 0;
    return typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value) && BigInt(value) > 0n;
  };
  return pending(status?.pendingFacts) || pending(status?.pendingMaintenance);
}

async function finishPurgeMaintenance(engine, options) {
  let status = await engine.readPurgeStatus(null, { signal: options.signal });
  let batches = 0;
  while (insightsPurgeWorkPending(status) && batches < 40) {
    status = await engine.runPurgeMaintenance({ limit: 256 }, { signal: options.signal });
    batches += 1;
  }
  return Object.freeze({ ...status, batches });
}

export function insightsChildEnv(paths, options) {
  return {
    ...process.env,
    ...options.childEnv,
    SQLITE_TMPDIR: paths.tempDirectory,
    TMPDIR: paths.tempDirectory,
    TEMP: paths.tempDirectory,
    TMP: paths.tempDirectory,
  };
}

function assertLockedInsightsState(status, stateChangedMessage) {
  if (!status.databasePresent) {
    throw commandError("TS_INSIGHTS_STATE_CHANGED", stateChangedMessage);
  }
  if (!status.originSecretPresent) {
    throw commandError(
      "TS_INSIGHTS_ORIGIN_SECRET_MISSING",
      "Insights origin secret is missing; explicit secret recovery is required",
    );
  }
}

async function hideActiveExclusions(config, options, paths) {
  const status = await inspectInsightsState({
    ...options.lifecycleOptions,
    paths,
    includeEngineStatus: false,
  });
  const recoveryRequired = status.diagnostics.includes(
    "TS_INSIGHTS_REINDEX_RECOVERY_REQUIRED",
  );
  if (!status.databasePresent && !recoveryRequired) {
    return Object.freeze({
      format: "threadshare-insights-exclusion-visibility@v1",
      scanned: 0,
      hidden: 0,
    });
  }
  if (!status.originSecretPresent && !recoveryRequired) {
    throw commandError(
      "TS_INSIGHTS_ORIGIN_SECRET_MISSING",
      "Insights origin secret is missing; explicit secret recovery is required",
    );
  }
  return withInsightsWriterLock(paths, async () => {
    await recoverInsightsReindexSwap({ ...options.reindexOptions, paths });
    const lockedStatus = await inspectInsightsState({
      ...options.lifecycleOptions,
      paths,
      includeEngineStatus: false,
    });
    assertLockedInsightsState(
      lockedStatus,
      "Insights state changed before exclusions could be applied",
    );
    const state = await openInsightsState({ ...options.stateOptions, paths });
    const engine = await createInsightsEngineClient({
      databasePath: paths.databaseFile,
      requiredContract: insightsRequiredContract(state.originSecretEpoch),
      runtimeOptions: options.runtimeOptions,
      childEnv: insightsChildEnv(paths, options),
      timeoutMs: options.timeoutMs,
    });
    try {
      return await hideConfiguredInsightsSources({
        config,
        engine,
        privacyContext: state.privacyContext,
        signal: options.signal,
      });
    } finally {
      await engine.close();
    }
  }, options.lockOptions);
}

export async function reconcileInsights(options = {}) {
  const paths = options.paths ?? resolveInsightsPaths(options);
  const regeneratedSecret = options.regenerateSecret === true;
  const swapped = await reindexInsightsState({
    ...options.reindexOptions,
    paths,
    signal: options.signal,
    regenerateSecret: regeneratedSecret,
    confirmation: options.confirmation,
    async buildCandidate({ databaseFile, originSecretEpoch, privacyContext, signal }) {
      const config = await loadInsightsConfig({ ...options.configOptions, paths });
      const requiredContract = (options.requiredContractFactory ?? insightsRequiredContract)(
        originSecretEpoch,
      );
      const createEngineClient = options.createEngineClient ?? createInsightsEngineClient;
      const engine = await createEngineClient({
        databasePath: databaseFile,
        requiredContract,
        runtimeOptions: options.runtimeOptions,
        childEnv: insightsChildEnv(paths, options),
        timeoutMs: options.timeoutMs,
      });
      try {
        let discovery;
        let index;
        let initialSourceKeys;
        const committedSourceKeys = new Set();
        for (let attempt = 0; attempt <= MAX_REINDEX_SOURCE_CHANGED_RETRIES; attempt += 1) {
          discovery = await discoverSources(options);
          const sourceKeys = reindexSourceSet(discovery.sources);
          if (initialSourceKeys === undefined) initialSourceKeys = sourceKeys;
          else assertSameReindexSourceSet(initialSourceKeys, sourceKeys);
          index = await runInsightsIndexer({
            sources: discovery.sources,
            config,
            engine,
            privacyContext,
            requiredContract,
            concurrency: options.concurrency,
            signal,
            adapterOptions: options.adapterOptions,
            statSource: options.statSource,
            sampleSource: options.sampleSource,
            readDelta: options.readDelta,
            onProgress: options.onProgress,
            onSourceCommitted(source) {
              committedSourceKeys.add(reindexSourceKey(source));
            },
          });
          if (index.failed === 0) break;
          if (!onlySourceChangedFailures(index) ||
              attempt === MAX_REINDEX_SOURCE_CHANGED_RETRIES) {
            throw incompleteIndexError(index);
          }
          await waitForSourceChangedRetry(signal);
        }
        index = mergeReindexRetryReport(index, committedSourceKeys);
        const purge = await finishPurgeMaintenance(engine, { ...options, signal });
        if (insightsPurgeWorkPending(purge)) {
          throw commandError(
            "TS_INSIGHTS_PURGE_PENDING",
            "Insights candidate purge did not finish within its bounded maintenance budget",
          );
        }
        return Object.freeze({
          index: Object.freeze({
            ...index,
            diagnostics: Object.freeze([...discovery.diagnostics, ...index.diagnostics]),
          }),
          purge,
        });
      } finally {
        await engine.close();
      }
    },
  });
  return Object.freeze({
    ...swapped,
    originSecretPreserved: !regeneratedSecret,
    report: swapped.report.index,
    purge: swapped.report.purge,
  });
}

export async function reconcileActiveInsights(options = {}) {
  const paths = options.paths ?? resolveInsightsPaths(options);
  const status = await inspectInsightsState({
    ...options.lifecycleOptions,
    paths,
    includeEngineStatus: false,
  });
  if (!status.databasePresent) return reconcileInsights({ ...options, paths });
  if (
    !status.originSecretPresent &&
    !status.diagnostics.includes("TS_INSIGHTS_REINDEX_RECOVERY_REQUIRED")
  ) {
    throw commandError(
      "TS_INSIGHTS_ORIGIN_SECRET_MISSING",
      "Insights origin secret is missing; explicit secret recovery is required",
    );
  }
  const migrationRequired = Symbol("migration-required");
  const result = await withInsightsWriterLock(paths, async () => {
    await recoverInsightsReindexSwap({ ...options.reindexOptions, paths });
    const lockedStatus = await inspectInsightsState({
      ...options.lifecycleOptions,
      paths,
      includeEngineStatus: false,
    });
    assertLockedInsightsState(
      lockedStatus,
      "Insights state changed before reconciliation could start",
    );
    const state = await openInsightsState({ ...options.stateOptions, paths });
    const [config, discovery] = await Promise.all([
      loadInsightsConfig({ ...options.configOptions, paths }),
      discoverSources(options),
    ]);
    const requiredContract = insightsRequiredContract(state.originSecretEpoch);
    const createEngineClient = options.createEngineClient ?? createInsightsEngineClient;
    const engine = await createEngineClient({
      databasePath: paths.databaseFile,
      requiredContract,
      runtimeOptions: options.runtimeOptions,
      childEnv: insightsChildEnv(paths, options),
      timeoutMs: options.timeoutMs,
    });
    try {
      if (requiredContract.factSchemaVersion === 2) {
        if (typeof engine.databaseIdentity !== "function") {
          throw new TypeError("Engine client must expose databaseIdentity() for Fact V2");
        }
        const identity = engine.databaseIdentity();
        if (identity?.factSchemaVersion !== null &&
            identity?.factSchemaVersion !== requiredContract.factSchemaVersion) {
          return migrationRequired;
        }
      }
      const index = await runInsightsIndexer({
        sources: discovery.sources,
        config,
        engine,
        privacyContext: state.privacyContext,
        requiredContract,
        concurrency: options.concurrency,
        signal: options.signal,
        adapterOptions: options.adapterOptions,
        statSource: options.statSource,
        sampleSource: options.sampleSource,
        readDelta: options.readDelta,
        onProgress: options.onProgress,
      });
      const purge = await finishPurgeMaintenance(engine, { ...options, signal: options.signal });
      return Object.freeze({
        format: "threadshare-insights-reconciliation@v1",
        report: Object.freeze({
          ...index,
          diagnostics: Object.freeze([...discovery.diagnostics, ...index.diagnostics]),
        }),
        purge,
      });
    } finally {
      await engine.close();
    }
  }, options.lockOptions);
  if (result === migrationRequired) return reconcileInsights({ ...options, paths });
  return result;
}

export function createInsightsBackgroundWorker(options = {}) {
  const environment = options.discoveryOptions?.environment ?? process.env;
  const workerOptions = options.workerOptions ?? {};
  const defaultWatchRoots = [
    { provider: "codex", root: sessionRoot("codex", environment) },
    { provider: "claude", root: sessionRoot("claude", environment) },
  ];
  const watchRoots = workerOptions.watchRoots ?? defaultWatchRoots.map(({ root }) => root);
  const providerByRoot = new Map(defaultWatchRoots.map(({ provider, root }) => [root, provider]));
  return createInsightsIndexWorker({
    ...workerOptions,
    watchRoots,
    resolveWatchHint: workerOptions.resolveWatchHint ?? (({ root, filename }) => {
      const provider = providerByRoot.get(root);
      if (provider === undefined || filename === null) return null;
      const sessionId = canonicalSessionId(provider, String(filename));
      return sessionId === null ? null : { provider, sessionId };
    }),
    reconcile: options.reconcile ?? (() => reconcileActiveInsights(options)),
  });
}

function exclusionResult(config) {
  return Object.freeze({
    providers: Object.freeze([...config.insights.excludeProviders]),
    projects: Object.freeze([...config.insights.excludeProjects]),
    sessions: Object.freeze([...config.insights.excludeSessions]),
  });
}

function defaultServices(options) {
  const paths = options.paths ?? resolveInsightsPaths(options);
  return {
    status: () => inspectInsightsState({ ...options.lifecycleOptions, paths }),
    reset: () => resetInsightsState({ ...options.lifecycleOptions, paths }),
    loadConfig: () => loadInsightsConfig({ ...options.configOptions, paths }),
    updateExclusion: (change) =>
      updateInsightsExclusion(change, { ...options.configOptions, paths }),
    hideExclusions: (config) => hideActiveExclusions(config, options, paths),
    shouldReconcile: async () => (await inspectInsightsState({
      ...options.lifecycleOptions,
      paths,
      includeEngineStatus: false,
    })).databasePresent,
    sync: () => reconcileActiveInsights({ ...options, paths }),
    reindex: (input) => reconcileInsights({
      ...options,
      ...input,
      paths,
      confirmation: options.regenerationConfirmation,
    }),
  };
}

export async function executeInsightsCommand(invocation, options = {}) {
  const services = options.services ?? defaultServices(options);
  if (invocation.action === "status") {
    const status = await services.status();
    return status.diagnostics?.includes("TS_INSIGHTS_ORIGIN_SECRET_MISSING")
      ? Object.freeze({
          ...status,
          recoveryCommand: "threadshare insights reindex --regenerate-secret",
        })
      : status;
  }
  if (invocation.action === "reset") {
    return services.reset();
  }
  if (invocation.action === "sync") {
    const result = await services.sync();
    const mode = result.format === "threadshare-insights-reindex@v1"
      ? "initialized"
      : result.format === "threadshare-insights-reconciliation@v1"
        ? "incremental"
        : null;
    if (mode === null) throw new TypeError("Unknown Insights sync result format");
    return Object.freeze({
      format: "threadshare-insights-sync@v1",
      mode,
      report: result.report,
      purge: result.purge,
    });
  }
  if (invocation.action === "reindex") {
    return services.reindex({ regenerateSecret: invocation.regenerateSecret });
  }
  if (invocation.operation === "list") {
    return Object.freeze({
      format: "threadshare-insights-exclusions@v1",
      exclusions: exclusionResult(await services.loadConfig()),
    });
  }
  const update = await services.updateExclusion({
    operation: invocation.operation,
    kind: invocation.kind,
    value: invocation.value,
  });
  let visibility = null;
  if (
    invocation.operation === "add" &&
    typeof services.hideExclusions === "function"
  ) {
    visibility = await services.hideExclusions(update.config);
  }
  let reconciliation = null;
  if ((update.changed || invocation.operation === "add") &&
      typeof services.shouldReconcile === "function" &&
      await services.shouldReconcile()) {
    reconciliation = await services.reindex({ regenerateSecret: false });
  }
  return Object.freeze({
    format: "threadshare-insights-exclusion-update@v1",
    operation: invocation.operation,
    kind: invocation.kind,
    changed: update.changed,
    exclusions: exclusionResult(update.config),
    visibility,
    reconciliation,
  });
}

function formatStatus(result) {
  const lines = [
    `Insights state: ${result.state}`,
    `Storage: ${result.bytes} bytes across ${result.entries} entries`,
    `Database: ${result.databasePresent ? "present" : "absent"}`,
    `Origin secret: ${result.originSecretPresent ? "present" : "absent"}`,
  ];
  if (result.diagnostics?.length > 0) lines.push(`Diagnostics: ${result.diagnostics.join(", ")}`);
  if (result.recoveryCommand) lines.push(`Recovery: ${result.recoveryCommand}`);
  return `${lines.join("\n")}\n`;
}

function formatExclusions(exclusions) {
  const list = (values) => values.length === 0 ? "(none)" : values.join(", ");
  return [
    "Insights exclusions",
    `Providers: ${list(exclusions.providers)}`,
    `Projects: ${list(exclusions.projects)}`,
    `Sessions: ${list(exclusions.sessions)}`,
  ].join("\n");
}

function formatByteCount(value) {
  const units = [
    [1_073_741_824n, "GiB"],
    [1_048_576n, "MiB"],
    [1_024n, "KiB"],
  ];
  for (const [unit, label] of units) {
    if (value < unit) continue;
    const whole = value / unit;
    const tenth = (value % unit) * 10n / unit;
    return `${whole}${tenth === 0n ? "" : `.${tenth}`} ${label}`;
  }
  return `${value} B`;
}

export function createInsightsProgressReporter({ format = "text", stream = process.stderr } = {}) {
  const enabled = format === "text" && stream?.isTTY === true && typeof stream.write === "function";
  let active = false;
  let finished = false;
  return Object.freeze({
    update(progress) {
      if (!enabled || finished) return;
      const processedText = progress?.bytesProcessed;
      const totalText = progress?.bytesTotal;
      if (!/^(?:0|[1-9][0-9]*)$/u.test(processedText) ||
          !/^(?:0|[1-9][0-9]*)$/u.test(totalText)) return;
      const processed = BigInt(processedText);
      const total = BigInt(totalText);
      const percent = total === 0n
        ? 100n
        : (processed * 100n / total > 100n ? 100n : processed * 100n / total);
      stream.write(
        `\rInsights indexing: ${percent}% (${formatByteCount(processed)} / ${formatByteCount(total)})`,
      );
      active = true;
    },
    finish() {
      if (!enabled || finished) return;
      finished = true;
      if (active) stream.write("\n");
    },
  });
}

export function formatInsightsCommandResult(result, format = "text") {
  assertFormat(format);
  if (format === "json") return `${JSON.stringify(result)}\n`;
  if (result.format === "threadshare-insights-status@v1") return formatStatus(result);
  if (result.format === "threadshare-insights-reset@v1") {
    return result.reset ? "Insights state reset.\n" : "Insights state was already empty.\n";
  }
  if (result.format === "threadshare-insights-exclusions@v1") {
    return `${formatExclusions(result.exclusions)}\n`;
  }
  if (result.format === "threadshare-insights-exclusion-update@v1") {
    const verb = result.operation === "add" ? "Added" : "Removed";
    const state = result.changed ? `${verb} ${result.kind} exclusion.` : "Exclusions unchanged.";
    const indexState = !result.changed
      ? null
      : result.reconciliation === null
        ? "Index: not created; the rule applies before first indexing."
        : `Index: rebuilt; purge state ${result.reconciliation.purge.state}.`;
    return `${[state, formatExclusions(result.exclusions), indexState]
      .filter(Boolean)
      .join("\n")}\n`;
  }
  if (result.format === "threadshare-insights-sync@v1") {
    const { report, purge } = result;
    return [
      "Insights sync complete.",
      `Mode: ${result.mode}`,
      `Committed: ${report.committed}; unchanged: ${report.unchanged}; excluded: ${report.excluded}; missing: ${report.missing}; failed: ${report.failed}`,
      `Purge: ${purge.state}; maintenance batches: ${purge.batches}`,
      "",
    ].join("\n");
  }
  if (result.format === "threadshare-insights-reindex@v1") {
    const { report, purge } = result;
    return [
      "Insights reindex complete.",
      `Committed: ${report.committed}; unchanged: ${report.unchanged}; excluded: ${report.excluded}; missing: ${report.missing}; failed: ${report.failed}`,
      `Purge: ${purge.state}; maintenance batches: ${purge.batches}`,
      `Origin secret: ${result.originSecretPreserved ? "preserved" : "changed"}`,
      "",
    ].join("\n");
  }
  throw new TypeError("Unknown Insights command result format");
}
