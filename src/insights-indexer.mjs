import { createHash } from "node:crypto";
import { watch as watchFileSystem } from "node:fs";
import { open, stat } from "node:fs/promises";
import { readProviderSessionDelta } from "./provider-evidence.mjs";
import { hashKey } from "./session-facts.mjs";

export const DEFAULT_INSIGHTS_INDEX_CONCURRENCY = 4;
export const MAX_INSIGHTS_INDEX_CONCURRENCY = 16;
export const INSIGHTS_FINGERPRINT_BYTES = 4096;
export const DEFAULT_INSIGHTS_WATCH_DEBOUNCE_MS = 100;
export const DEFAULT_INSIGHTS_RECONCILE_INTERVAL_MS = 30_000;

function normalizeDelay(value, label, { minimum = 0 } = {}) {
  if (!Number.isSafeInteger(value) || value < minimum || value > 86_400_000) {
    throw new RangeError(`${label} must be an integer between ${minimum} and 86400000`);
  }
  return value;
}

function workerError(error, phase, root = null) {
  return Object.freeze({
    phase,
    root,
    error,
  });
}

export function createInsightsIndexWorker(options = {}) {
  if (typeof options.reconcile !== "function") {
    throw new TypeError("reconcile must be a function");
  }
  if (options.watchFactory !== undefined && typeof options.watchFactory !== "function") {
    throw new TypeError("watchFactory must be a function");
  }
  if (options.onCycle !== undefined && typeof options.onCycle !== "function") {
    throw new TypeError("onCycle must be a function");
  }
  if (options.onError !== undefined && typeof options.onError !== "function") {
    throw new TypeError("onError must be a function");
  }
  if (
    options.resolveWatchHint !== undefined &&
    typeof options.resolveWatchHint !== "function"
  ) {
    throw new TypeError("resolveWatchHint must be a function");
  }
  const debounceMs = normalizeDelay(
    options.debounceMs ?? DEFAULT_INSIGHTS_WATCH_DEBOUNCE_MS,
    "debounceMs",
  );
  const pollIntervalMs = normalizeDelay(
    options.pollIntervalMs ?? DEFAULT_INSIGHTS_RECONCILE_INTERVAL_MS,
    "pollIntervalMs",
    { minimum: 1 },
  );
  const retryDelayMs = normalizeDelay(options.retryDelayMs ?? 1_000, "retryDelayMs");
  const roots = Object.freeze([...(options.watchRoots ?? [])]);
  if (roots.some((root) => typeof root !== "string" || root.length === 0)) {
    throw new TypeError("watchRoots must contain non-empty strings");
  }

  let started = false;
  let stopping = false;
  let timer = null;
  let pollTimer = null;
  let active = null;
  let queued = false;
  let cycleCount = 0;
  let lastReport = null;
  let lastReconcileError = null;
  let lastWatcherError = null;
  let watcherDegraded = false;
  let watcherErrorCount = 0;
  let lastSuccessfulAtMs = null;
  let successfulSinceStart = false;
  let lastCycleIncomplete = false;
  let hintSequence = 0;
  let unknownPendingSequence = null;
  let retryRequested = false;
  const reasons = new Set();
  const pendingSessions = new Map();
  const watchers = [];
  const watchFactory = options.watchFactory ?? watchFileSystem;
  const idleWaiters = new Set();

  const settleIdle = () => {
    if (active !== null || queued || timer !== null) return;
    for (const resolve of idleWaiters) resolve();
    idleWaiters.clear();
  };
  const notifyObserver = (callback, payload) => {
    if (callback === undefined) return;
    try {
      void Promise.resolve(callback(payload)).catch(() => {});
    } catch {
      // Observer failures cannot stop or mutate reconciliation state.
    }
  };
  const reportError = (error, phase, root = null) => {
    const item = workerError(error, phase, root);
    if (phase === "watch" || phase === "watch-hint") {
      watcherDegraded = true;
      watcherErrorCount += 1;
      lastWatcherError = item;
    } else {
      lastReconcileError = item;
    }
    notifyObserver(options.onError, item);
  };
  const recordWatchHint = (root, eventType, filename) => {
    hintSequence += 1;
    let hint = null;
    try {
      hint = options.resolveWatchHint?.({ root, eventType, filename }) ?? null;
    } catch (error) {
      reportError(error, "watch-hint", root);
    }
    if (
      hint !== null &&
      typeof hint === "object" &&
      typeof hint.provider === "string" &&
      hint.provider.length > 0 &&
      typeof hint.sessionId === "string" &&
      hint.sessionId.length > 0
    ) {
      const provider = hint.provider;
      const sessionId = hint.sessionId.toLowerCase();
      pendingSessions.set(sourceKey(provider, sessionId), {
        provider,
        sessionId,
        sequence: hintSequence,
      });
      return;
    }
    unknownPendingSequence = hintSequence;
  };
  const reconcileReport = (report) => {
    if (report?.report && typeof report.report === "object") return report.report;
    return report && typeof report === "object" ? report : {};
  };
  const settlePending = (report, throughSequence) => {
    const indexReport = reconcileReport(report);
    const failedCount = Number.isSafeInteger(indexReport.failed) ? indexReport.failed : 0;
    const failedKeys = new Set();
    for (const diagnostic of indexReport.diagnostics ?? []) {
      if (
        typeof diagnostic?.provider === "string" &&
        typeof diagnostic?.sessionId === "string"
      ) {
        failedKeys.add(sourceKey(diagnostic.provider, diagnostic.sessionId));
      }
    }
    const hasUnresolvedFailures = failedCount > failedKeys.size;
    for (const [key, pending] of pendingSessions) {
      if (pending.sequence > throughSequence) continue;
      if (hasUnresolvedFailures || failedKeys.has(key)) continue;
      pendingSessions.delete(key);
    }
    if (
      unknownPendingSequence !== null &&
      unknownPendingSequence <= throughSequence &&
      failedCount === 0
    ) {
      unknownPendingSequence = null;
    }
    return failedCount;
  };
  const scheduleRetry = () => {
    if (stopping || timer !== null) return;
    timer = setTimeout(() => {
      timer = null;
      void run();
    }, retryDelayMs);
    timer.unref?.();
    if (idleWaiters.size > 0) timer.ref?.();
  };
  const schedulePoll = () => {
    if (!started || stopping) return;
    if (pollTimer !== null) clearTimeout(pollTimer);
    pollTimer = setTimeout(() => {
      pollTimer = null;
      trigger("poll", { immediate: true });
    }, pollIntervalMs);
    pollTimer.unref?.();
  };
  const run = () => {
    if (active !== null || stopping) return active;
    active = (async () => {
      do {
        queued = false;
        const cycleReasons = Object.freeze([...reasons].sort());
        reasons.clear();
        const cycleHintSequence = hintSequence;
        try {
          const report = await options.reconcile({ reasons: cycleReasons });
          cycleCount += 1;
          lastReport = report;
          lastReconcileError = null;
          const failedCount = settlePending(report, cycleHintSequence);
          lastCycleIncomplete = failedCount > 0;
          if (!lastCycleIncomplete) {
            lastSuccessfulAtMs = Date.now();
            successfulSinceStart = true;
          }
          notifyObserver(
            options.onCycle,
            Object.freeze({ cycle: cycleCount, reasons: cycleReasons, report }),
          );
          if (failedCount > 0) {
            for (const reason of cycleReasons) reasons.add(reason);
            reasons.add("retry");
            retryRequested = true;
            if (!queued) break;
          } else {
            retryRequested = false;
          }
        } catch (error) {
          lastCycleIncomplete = true;
          reportError(error, "reconcile");
          for (const reason of cycleReasons) reasons.add(reason);
          reasons.add("retry");
          retryRequested = true;
          if (!queued) break;
        }
      } while (queued && !stopping);
    })().finally(() => {
      active = null;
      if (queued && !stopping) {
        retryRequested = false;
        void run();
      } else if (retryRequested && !stopping) {
        retryRequested = false;
        scheduleRetry();
      } else {
        schedulePoll();
      }
      settleIdle();
    });
    return active;
  };
  const trigger = (reason = "manual", { immediate = false } = {}) => {
    if (typeof reason !== "string" || reason.length === 0) {
      throw new TypeError("worker trigger reason must be a non-empty string");
    }
    if (!started || stopping) return false;
    reasons.add(reason);
    if (active !== null) {
      queued = true;
      return true;
    }
    if (timer !== null) clearTimeout(timer);
    if (immediate || debounceMs === 0) {
      timer = null;
      void run();
    } else {
      timer = setTimeout(() => {
        timer = null;
        void run();
      }, debounceMs);
    }
    return true;
  };

  return Object.freeze({
    start() {
      if (started) return false;
      started = true;
      stopping = false;
      watcherDegraded = false;
      watcherErrorCount = 0;
      lastWatcherError = null;
      successfulSinceStart = false;
      lastCycleIncomplete = false;
      if (roots.length > 0) {
        for (const root of roots) {
          try {
            const watcher = watchFactory(
              root,
              { recursive: true, persistent: false },
              (eventType, filename) => {
                recordWatchHint(root, eventType, filename);
                trigger("filesystem");
              },
            );
            watcher.on?.("error", (error) => reportError(error, "watch", root));
            watchers.push(watcher);
          } catch (error) {
            reportError(error, "watch", root);
          }
        }
      }
      trigger("startup", { immediate: true });
      return true;
    },
    trigger,
    async whenIdle() {
      if (active === null && !queued && timer === null) return;
      timer?.ref?.();
      await new Promise((resolve) => idleWaiters.add(resolve));
    },
    async stop() {
      if (!started) return false;
      stopping = true;
      if (timer !== null) {
        clearTimeout(timer);
        timer = null;
      }
      if (pollTimer !== null) {
        clearTimeout(pollTimer);
        pollTimer = null;
      }
      reasons.clear();
      queued = false;
      retryRequested = false;
      let stopError = null;
      try {
        for (const watcher of watchers.splice(0)) {
          try {
            await watcher.close?.();
          } catch (error) {
            stopError ??= error;
            reportError(error, "watch");
          }
        }
        if (active !== null) await active;
      } finally {
        reasons.clear();
        queued = false;
        retryRequested = false;
        started = false;
        stopping = false;
        settleIdle();
      }
      if (stopError !== null) throw stopError;
      return true;
    },
    status() {
      const pending = [...pendingSessions.values()]
        .map(({ provider, sessionId }) => Object.freeze({ provider, sessionId }))
        .sort((left, right) => {
          const leftKey = sourceKey(left.provider, left.sessionId);
          const rightKey = sourceKey(right.provider, right.sessionId);
          return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
        });
      const pendingUnknown = unknownPendingSequence !== null;
      const snapshotAgeMs = lastSuccessfulAtMs === null
        ? null
        : Math.max(0, Date.now() - lastSuccessfulAtMs);
      const staleAll =
        !started ||
        stopping ||
        !successfulSinceStart ||
        lastSuccessfulAtMs === null ||
        lastCycleIncomplete ||
        pendingUnknown ||
        watcherDegraded ||
        lastReconcileError !== null;
      return Object.freeze({
        started,
        running: active !== null,
        queued,
        cycleCount,
        lastReport,
        lastError: lastReconcileError ?? lastWatcherError,
        lastReconcileError,
        lastWatcherError,
        watcherDegraded,
        watcherErrorCount,
        snapshotAgeMs,
        pendingSessionCount: pending.length,
        pendingSessions: Object.freeze(pending),
        pendingUnknown,
        stale: staleAll || pending.length > 0,
        staleAll,
      });
    },
  });
}

function sourceKey(provider, sessionId) {
  return `${provider}\u0000${sessionId.toLowerCase()}`;
}

function normalizeConcurrency(value) {
  if (
    !Number.isSafeInteger(value) ||
    value < 1 ||
    value > MAX_INSIGHTS_INDEX_CONCURRENCY
  ) {
    throw new RangeError(
      `concurrency must be an integer between 1 and ${MAX_INSIGHTS_INDEX_CONCURRENCY}`,
    );
  }
  return value;
}

async function mapLimit(values, concurrency, visit) {
  const results = new Array(values.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < values.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await visit(values[index], index);
    }
  }
  await Promise.all(
    Array.from({ length: Math.min(concurrency, values.length) }, () => worker()),
  );
  return results;
}

function decimal(value, label) {
  const normalized = typeof value === "bigint" ? value.toString() : String(value);
  if (!/^(?:0|[1-9][0-9]*)$/u.test(normalized)) {
    throw new TypeError(`${label} must be an unsigned decimal integer`);
  }
  return normalized;
}

function normalizeMetadata(value) {
  if (!value || typeof value !== "object") {
    throw new TypeError("source metadata is required");
  }
  return Object.freeze({
    dev: decimal(value.dev, "metadata.dev"),
    ino: decimal(value.ino, "metadata.ino"),
    size: decimal(value.size, "metadata.size"),
    mtimeNs: decimal(value.mtimeNs, "metadata.mtimeNs"),
  });
}

async function defaultStatSource(file) {
  const value = await stat(file, { bigint: true });
  if (!value.isFile()) {
    const error = new TypeError("Insights source is not a regular file");
    error.code = "TS_INSIGHTS_SOURCE_NOT_FILE";
    throw error;
  }
  return normalizeMetadata(value);
}

async function defaultSampleSource(file, range) {
  const offset = BigInt(range.offset);
  if (offset > BigInt(Number.MAX_SAFE_INTEGER)) {
    throw new RangeError("sample offset exceeds the local filesystem reader limit");
  }
  if (range.length === 0) return Buffer.alloc(0);
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.allocUnsafe(range.length);
    const { bytesRead } = await handle.read(buffer, 0, range.length, Number(offset));
    return buffer.subarray(0, bytesRead);
  } finally {
    await handle.close();
  }
}

function sameMetadata(left, right) {
  return (
    left.dev === right.dev &&
    left.ino === right.ino &&
    left.size === right.size &&
    left.mtimeNs === right.mtimeNs
  );
}

function normalizeFingerprint(value, kind) {
  if (
    !value ||
    typeof value !== "object" ||
    !Number.isSafeInteger(value.length) ||
    value.length < 0 ||
    value.length > INSIGHTS_FINGERPRINT_BYTES ||
    typeof value.sha256 !== "string" ||
    !/^[0-9a-f]{64}$/u.test(value.sha256)
  ) {
    return null;
  }
  let offset;
  try {
    offset = decimal(value.offset, `fingerprints.${kind}.offset`);
  } catch {
    return null;
  }
  return { kind, offset, length: value.length, sha256: value.sha256 };
}

function reconciliationRanges(previous) {
  const head = normalizeFingerprint(previous.fingerprints?.head, "head");
  const boundary = normalizeFingerprint(previous.fingerprints?.boundary, "boundary");
  let completeOffset;
  try {
    completeOffset = BigInt(decimal(previous.checkpoint?.completeOffset, "checkpoint.completeOffset"));
  } catch {
    return null;
  }
  if (
    !head ||
    !boundary ||
    BigInt(boundary.offset) + BigInt(boundary.length) !== completeOffset ||
    completeOffset > BigInt(previous.metadata.size)
  ) {
    return null;
  }
  const expected = rangesForCheckpoint(previous.metadata.size, completeOffset.toString());
  if (
    head.offset !== expected[0].offset ||
    head.length !== expected[0].length ||
    boundary.offset !== expected[1].offset ||
    boundary.length !== expected[1].length
  ) {
    return null;
  }
  return [head, boundary];
}

async function fingerprintsMatch(file, previous, sampleSource) {
  const ranges = reconciliationRanges(previous);
  if (!ranges) return null;
  for (const { sha256, ...range } of ranges) {
    const sampled = await sampleSource(file, range);
    if (!Buffer.isBuffer(sampled) && !(sampled instanceof Uint8Array)) {
      throw new TypeError("sampleSource must return a Buffer or Uint8Array");
    }
    const bytes = Buffer.from(sampled);
    if (
      bytes.length !== range.length ||
      createHash("sha256").update(bytes).digest("hex") !== sha256
    ) {
      return false;
    }
  }
  return true;
}

function assertSource(source, label) {
  if (
    !source ||
    (source.provider !== "codex" && source.provider !== "claude") ||
    typeof source.sessionId !== "string" ||
    source.sessionId === "" ||
    typeof source.file !== "string" ||
    source.file === ""
  ) {
    throw new TypeError(`${label} must identify a Codex or Claude session source`);
  }
}

function contractReason(previous, requiredContract) {
  if (!requiredContract) return null;
  const current = previous.contract;
  if (!current || typeof current !== "object") return "index-contract-missing";
  if (typeof requiredContract.originSecretEpoch === "string") {
    if (typeof current.originSecretEpoch !== "string") return "index-contract-missing";
    if (current.originSecretEpoch.toLowerCase() !== requiredContract.originSecretEpoch.toLowerCase()) {
      const error = new Error("Indexed state belongs to a different origin secret epoch");
      error.code = "TS_INSIGHTS_INVALID_ORIGIN_EPOCH";
      throw error;
    }
  }
  if (
    requiredContract.factSchemaVersion !== undefined &&
    current.factSchemaVersion !== requiredContract.factSchemaVersion
  ) {
    return "fact-schema-changed";
  }
  if (
    requiredContract.privacyPolicyVersion !== undefined &&
    current.privacyPolicyVersion !== requiredContract.privacyPolicyVersion
  ) {
    return "privacy-policy-changed";
  }
  if (
    requiredContract.duplicatePolicyVersion !== undefined &&
    current.duplicatePolicyVersion !== requiredContract.duplicatePolicyVersion
  ) {
    return "duplicate-policy-changed";
  }
  if (!providerAdapterVersionMatches(
    requiredContract.providerAdapterVersions,
    previous.provider,
    current.providerAdapterVersion,
  )) {
    return "provider-adapter-changed";
  }
  return null;
}

function providerAdapterVersionMatches(requirement, provider, actual) {
  if (typeof actual !== "string" || !actual.startsWith(`${provider}@`)) return false;
  if (requirement === undefined) return true;
  if (Array.isArray(requirement)) return requirement.includes(actual);
  if (requirement && typeof requirement === "object") {
    const expected = requirement[provider];
    return expected === undefined || actual === expected;
  }
  throw new TypeError("requiredContract.providerAdapterVersions must be an array or object");
}

function buildExclusions(config, privacyContext) {
  const insights = config?.insights ?? {};
  const providers = new Set((insights.excludeProviders ?? []).map((value) => value.toLowerCase()));
  const sessions = new Set((insights.excludeSessions ?? []).map((value) => value.toLowerCase()));
  const projects = insights.excludeProjects ?? [];
  if (projects.length > 0 && typeof privacyContext?.projectFingerprint !== "function") {
    throw new TypeError("privacyContext.projectFingerprint is required for project exclusions");
  }
  const projectKeys = new Map(["codex", "claude"].map((provider) => [
    provider,
    new Set(projects.map((project) => privacyContext.projectFingerprint(provider, project))),
  ]));
  return { providers, sessions, projectKeys };
}

function exclusionReason(source, previous, exclusions) {
  if (exclusions.providers.has(source.provider)) return "provider-excluded";
  if (exclusions.sessions.has(source.sessionId.toLowerCase())) return "session-excluded";
  if (
    typeof previous?.projectKey === "string" &&
    exclusions.projectKeys.get(source.provider)?.has(previous.projectKey)
  ) {
    return "project-excluded";
  }
  return null;
}

export async function planInsightsReconciliation(options = {}) {
  const sources = options.sources ?? [];
  const sourceStates = options.sourceStates ?? [];
  if (!Array.isArray(sources) || !Array.isArray(sourceStates)) {
    throw new TypeError("sources and sourceStates must be arrays");
  }
  const concurrency = normalizeConcurrency(
    options.concurrency ?? DEFAULT_INSIGHTS_INDEX_CONCURRENCY,
  );
  const statSource = options.statSource ?? defaultStatSource;
  const sampleSource = options.sampleSource ?? defaultSampleSource;
  const requiredContract = options.requiredContract;
  const exclusions = buildExclusions(options.config, options.privacyContext);
  const stateBySource = new Map();
  for (const [index, state] of sourceStates.entries()) {
    assertSource(state, `sourceStates[${index}]`);
    const key = sourceKey(state.provider, state.sessionId);
    if (stateBySource.has(key)) throw new TypeError(`duplicate source state for ${state.provider}`);
    stateBySource.set(key, { ...state, metadata: normalizeMetadata(state.metadata) });
  }

  const diagnostics = [];
  let planningFailed = 0;
  const seen = new Set();
  const planned = await mapLimit(sources, concurrency, async (source, index) => {
    assertSource(source, `sources[${index}]`);
    const key = sourceKey(source.provider, source.sessionId);
    if (seen.has(key)) throw new TypeError(`duplicate source for ${source.provider}`);
    seen.add(key);
    const previous = stateBySource.get(key) ?? null;
    const excluded = exclusionReason(source, previous, exclusions);
    if (excluded) {
      return {
        action: "exclude",
        reason: excluded,
        source,
        previous,
        metadata: previous?.metadata ?? null,
      };
    }
    let sourceMetadata;
    try {
      sourceMetadata = normalizeMetadata(await statSource(source.file));
    } catch (error) {
      planningFailed += 1;
      diagnostics.push({
        code: "source-stat-failed",
        provider: source.provider,
        sessionId: source.sessionId.toLowerCase(),
        errorCode: typeof error?.code === "string" ? error.code : null,
      });
      return null;
    }
    const requiredRebuild = previous ? contractReason(previous, requiredContract) : null;
    if (requiredRebuild) {
      return {
        action: "replace-session",
        reason: requiredRebuild,
        source,
        previous,
        metadata: sourceMetadata,
      };
    }
    if (previous && sameMetadata(previous.metadata, sourceMetadata)) {
      if (previous.checkpoint?.sourceSnapshotStable === false) {
        return {
          action: "append",
          reason: "unstable-source-snapshot",
          source,
          previous,
          metadata: sourceMetadata,
        };
      }
      return {
        action: "unchanged",
        reason: "metadata-unchanged",
        source,
        previous,
        metadata: sourceMetadata,
      };
    }
    if (previous) {
      let matched;
      try {
        matched = await fingerprintsMatch(source.file, previous, sampleSource);
      } catch (error) {
        planningFailed += 1;
        diagnostics.push({
          code: "source-fingerprint-failed",
          provider: source.provider,
          sessionId: source.sessionId.toLowerCase(),
          errorCode: typeof error?.code === "string" ? error.code : null,
        });
        return null;
      }
      const identityMatches =
        previous.metadata.dev === sourceMetadata.dev &&
        previous.metadata.ino === sourceMetadata.ino;
      const sizeGrew = BigInt(sourceMetadata.size) > BigInt(previous.metadata.size);
      if (identityMatches && sizeGrew && matched === true) {
        return {
          action: "append",
          reason: "append-boundary-matched",
          source,
          previous,
          metadata: sourceMetadata,
        };
      }
      let reason = "fingerprint-mismatch";
      if (matched === null) reason = "reconciliation-fingerprint-missing";
      else if (!identityMatches) reason = "identity-changed";
      else if (BigInt(sourceMetadata.size) < BigInt(previous.metadata.size)) reason = "source-shrunk";
      else if (!sizeGrew) reason = "mtime-without-growth";
      return {
        action: "replace-session",
        reason,
        source,
        previous,
        metadata: sourceMetadata,
      };
    }
    return {
      action: "replace-session",
      reason: "new-source",
      source,
      previous,
      metadata: sourceMetadata,
    };
  });

  const items = planned.filter(Boolean);
  for (const [key, previous] of stateBySource) {
    if (!seen.has(key)) {
      const excluded = exclusionReason(previous, previous, exclusions);
      items.push({
        action: excluded ? "exclude" : "missing",
        reason: excluded ?? "source-missing",
        source: null,
        previous,
        metadata: null,
      });
    }
  }
  return { items, diagnostics, planningFailed };
}

function compareNewest(left, right) {
  const leftMtime = BigInt(left.metadata?.mtimeNs ?? left.previous?.metadata?.mtimeNs ?? "0");
  const rightMtime = BigInt(right.metadata?.mtimeNs ?? right.previous?.metadata?.mtimeNs ?? "0");
  if (leftMtime !== rightMtime) return leftMtime > rightMtime ? -1 : 1;
  const leftKey = left.source
    ? sourceKey(left.source.provider, left.source.sessionId)
    : sourceKey(left.previous.provider, left.previous.sessionId);
  const rightKey = right.source
    ? sourceKey(right.source.provider, right.source.sessionId)
    : sourceKey(right.previous.provider, right.previous.sessionId);
  return leftKey < rightKey ? -1 : leftKey > rightKey ? 1 : 0;
}

function reconciliationItemBytes(item) {
  return BigInt(item.metadata?.size ?? item.previous?.metadata?.size ?? "0");
}

function compareLargestFirst(left, right) {
  const leftBytes = reconciliationItemBytes(left);
  const rightBytes = reconciliationItemBytes(right);
  if (leftBytes !== rightBytes) return leftBytes > rightBytes ? -1 : 1;
  return compareNewest(left, right);
}

function reconciliationFingerprint(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function rangesForCheckpoint(sourceSize, completeOffset) {
  const size = BigInt(sourceSize);
  const boundaryEnd = BigInt(completeOffset);
  if (boundaryEnd > size) {
    throw new TypeError("checkpoint completeOffset exceeds its sourceSize");
  }
  const headLength = Number(size < BigInt(INSIGHTS_FINGERPRINT_BYTES)
    ? size
    : BigInt(INSIGHTS_FINGERPRINT_BYTES));
  const boundaryLength = Number(boundaryEnd < BigInt(INSIGHTS_FINGERPRINT_BYTES)
    ? boundaryEnd
    : BigInt(INSIGHTS_FINGERPRINT_BYTES));
  return [
    { kind: "head", offset: "0", length: headLength },
    {
      kind: "boundary",
      offset: String(boundaryEnd - BigInt(boundaryLength)),
      length: boundaryLength,
    },
  ];
}

function sourceChangedError() {
  const error = new Error("Insights source identity changed while preparing its commit");
  error.code = "TS_INSIGHTS_SOURCE_CHANGED";
  return error;
}

async function captureSourceState(item, delta, dependencies) {
  const checkpoint = delta?.checkpoint;
  const committedSize = decimal(checkpoint?.sourceSize, "checkpoint.sourceSize");
  const committedMtime = decimal(checkpoint?.sourceMtimeNs, "checkpoint.sourceMtimeNs");
  const completeOffset = decimal(checkpoint?.completeOffset, "checkpoint.completeOffset");
  const before = normalizeMetadata(await dependencies.statSource(item.source.file));
  const committedMetadata = {
    dev: item.metadata.dev,
    ino: item.metadata.ino,
    size: committedSize,
    mtimeNs: committedMtime,
  };
  if (
    checkpoint?.sourceSnapshotStable !== true ||
    item.metadata.dev !== committedMetadata.dev ||
    item.metadata.ino !== committedMetadata.ino ||
    BigInt(committedMetadata.size) < BigInt(item.metadata.size) ||
    (committedMetadata.size === item.metadata.size &&
      committedMetadata.mtimeNs !== item.metadata.mtimeNs) ||
    before.dev !== committedMetadata.dev ||
    before.ino !== committedMetadata.ino ||
    BigInt(before.size) < BigInt(committedMetadata.size)
  ) {
    throw sourceChangedError();
  }
  if (item.action === "append") {
    const priorPrefixMatched = await fingerprintsMatch(
      item.source.file,
      item.previous,
      dependencies.sampleSource,
    );
    if (priorPrefixMatched !== true) throw sourceChangedError();
  }
  const fingerprints = {};
  for (const range of rangesForCheckpoint(committedSize, completeOffset)) {
    const sampled = await dependencies.sampleSource(item.source.file, range);
    if (!Buffer.isBuffer(sampled) && !(sampled instanceof Uint8Array)) {
      throw new TypeError("sampleSource must return a Buffer or Uint8Array");
    }
    const bytes = Buffer.from(sampled);
    if (bytes.length !== range.length) throw sourceChangedError();
    fingerprints[range.kind] = {
      offset: range.offset,
      length: range.length,
      sha256: reconciliationFingerprint(bytes),
    };
  }
  const after = normalizeMetadata(await dependencies.statSource(item.source.file));
  if (
    after.dev !== committedMetadata.dev ||
    after.ino !== committedMetadata.ino ||
    BigInt(after.size) < BigInt(committedMetadata.size)
  ) {
    throw sourceChangedError();
  }
  return {
    provider: item.source.provider,
    sessionId: item.source.sessionId.toLowerCase(),
    file: item.source.file,
    sessionKey: delta.session.sessionKey,
    projectKey: delta.session.projectKey ?? null,
    metadata: {
      dev: before.dev,
      ino: before.ino,
      size: committedSize,
      mtimeNs: committedMtime,
    },
    fingerprints,
    checkpoint: structuredClone(checkpoint),
    contract: {
      factSchemaVersion: delta.factSchemaVersion,
      providerAdapterVersion: delta.providerAdapterVersion,
      privacyPolicyVersion: delta.privacyPolicyVersion,
      duplicatePolicyVersion: delta.duplicatePolicyVersion,
      originSecretEpoch: delta.originSecretEpoch,
    },
  };
}

function diagnosticForItem(code, item, error) {
  const source = item.source ?? item.previous;
  return {
    code,
    provider: source.provider,
    sessionId: source.sessionId.toLowerCase(),
    errorCode: typeof error?.code === "string" ? error.code : null,
  };
}

function isAbort(error, signal) {
  return signal?.aborted === true || error?.name === "AbortError";
}

function checkpointIsComplete(checkpoint) {
  return (
    checkpoint &&
    typeof checkpoint === "object" &&
    typeof checkpoint.sourceSize === "string" &&
    typeof checkpoint.sourceMtimeNs === "string"
  );
}

async function adapterCheckpointOptions(engine, item, signal) {
  if (item.action === "append") {
    if (checkpointIsComplete(item.previous.checkpoint)) {
      return { checkpoint: item.previous.checkpoint };
    }
    if (typeof engine.readSourceCheckpoint !== "function") {
      const error = new Error("Engine cannot read the committed parser checkpoint");
      error.code = "TS_INSIGHTS_SOURCE_CHECKPOINT_UNAVAILABLE";
      throw error;
    }
    const checkpoint = await engine.readSourceCheckpoint(
      item.previous.sessionKey,
      { signal },
    );
    if (
      !checkpointIsComplete(checkpoint) ||
      checkpoint.generation !== item.previous.checkpoint.generation ||
      checkpoint.completeOffset !== item.previous.checkpoint.completeOffset ||
      checkpoint.sourceSnapshotStable !== item.previous.checkpoint.sourceSnapshotStable ||
      checkpoint.sourceSize !== item.previous.metadata.size ||
      checkpoint.sourceMtimeNs !== item.previous.metadata.mtimeNs
    ) {
      const error = new Error("Committed parser checkpoint does not match its source-state summary");
      error.code = "TS_INSIGHTS_SOURCE_CHECKPOINT_MISMATCH";
      throw error;
    }
    return { checkpoint };
  }
  if (!item.previous) return {};
  return {
    expectedGeneration: decimal(
      item.previous.checkpoint?.generation,
      "checkpoint.generation",
    ),
  };
}

function assertIndexerEngine(engine) {
  if (
    !engine ||
    typeof engine.readSourceStates !== "function" ||
    typeof engine.commitSourceDelta !== "function"
  ) {
    throw new TypeError(
      "engine must provide readSourceStates() and transactional commitSourceDelta(batch)",
    );
  }
}

function projectExcluded(delta, exclusions) {
  return (
    typeof delta.session?.projectKey === "string" &&
    exclusions.projectKeys.get(delta.session.provider)?.has(delta.session.projectKey)
  );
}

function assertDeltaMatchesItem(delta, item, privacyContext, requiredContract) {
  const factSchemaVersion = requiredContract.factSchemaVersion ?? 1;
  const expectedSessionKey = hashKey(
    "session",
    item.source.provider,
    item.source.sessionId.toLowerCase(),
  );
  const valid =
    delta &&
    typeof delta === "object" &&
    delta.format === `session-facts-delta@v${factSchemaVersion}` &&
    delta.mode === item.action &&
    delta.session?.provider === item.source.provider &&
    delta.session?.sessionKey === expectedSessionKey &&
    (item.previous?.sessionKey === undefined ||
      item.previous.sessionKey === expectedSessionKey) &&
    typeof delta.originSecretEpoch === "string" &&
    delta.originSecretEpoch.toLowerCase() === privacyContext.originSecretEpoch.toLowerCase() &&
    (requiredContract.factSchemaVersion === undefined ||
      delta.factSchemaVersion === requiredContract.factSchemaVersion) &&
    (requiredContract.privacyPolicyVersion === undefined ||
      delta.privacyPolicyVersion === requiredContract.privacyPolicyVersion) &&
    (requiredContract.duplicatePolicyVersion === undefined ||
      delta.duplicatePolicyVersion === requiredContract.duplicatePolicyVersion) &&
    providerAdapterVersionMatches(
      requiredContract.providerAdapterVersions,
      item.source.provider,
      delta.providerAdapterVersion,
    );
  if (!valid) {
    const error = new TypeError("Provider adapter delta does not match its reconciliation item");
    error.code = "TS_INSIGHTS_DELTA_MISMATCH";
    throw error;
  }
}

export async function runInsightsIndexer(options = {}) {
  assertIndexerEngine(options.engine);
  if (options.onProgress !== undefined && typeof options.onProgress !== "function") {
    throw new TypeError("onProgress must be a function");
  }
  if (
    options.onSourceCommitted !== undefined &&
    typeof options.onSourceCommitted !== "function"
  ) {
    throw new TypeError("onSourceCommitted must be a function");
  }
  if (!options.privacyContext || typeof options.privacyContext.originSecretEpoch !== "string") {
    throw new TypeError("privacyContext is required");
  }
  const concurrency = normalizeConcurrency(
    options.concurrency ?? DEFAULT_INSIGHTS_INDEX_CONCURRENCY,
  );
  const statSource = options.statSource ?? defaultStatSource;
  const sampleSource = options.sampleSource ?? defaultSampleSource;
  const readDelta = options.readDelta ?? readProviderSessionDelta;
  const {
    checkpoint: _untrustedCheckpoint,
    expectedGeneration: _untrustedGeneration,
    ...adapterOptions
  } = options.adapterOptions ?? {};
  options.signal?.throwIfAborted();
  const sourceStates = await options.engine.readSourceStates({ signal: options.signal });
  const requiredContract = {
    ...(options.requiredContract ?? {}),
    originSecretEpoch: options.privacyContext.originSecretEpoch,
  };
  const plan = await planInsightsReconciliation({
    sources: options.sources ?? [],
    sourceStates,
    config: options.config,
    privacyContext: options.privacyContext,
    requiredContract,
    concurrency,
    statSource,
    sampleSource,
  });
  const bytesTotal = plan.items.reduce(
    (total, item) => total + reconciliationItemBytes(item),
    0n,
  );
  let bytesProcessed = plan.items
    .filter(({ action }) => action === "unchanged")
    .reduce((total, item) => total + reconciliationItemBytes(item), 0n);
  const notifyProgress = () => {
    if (options.onProgress === undefined) return;
    try {
      void Promise.resolve(options.onProgress(Object.freeze({
        bytesProcessed: bytesProcessed.toString(),
        bytesTotal: bytesTotal.toString(),
      }))).catch(() => {});
    } catch {
      // Progress observers cannot affect reconciliation or commit ordering.
    }
  };
  const markProcessed = (item) => {
    bytesProcessed += reconciliationItemBytes(item);
    notifyProgress();
  };
  notifyProgress();
  const diagnostics = [...plan.diagnostics];
  let excluded = 0;
  let missing = 0;
  let lifecycleFailed = 0;

  for (const item of plan.items.filter(({ action }) => action === "exclude" || action === "missing")) {
    const operation = item.action === "exclude" ? "excludeSource" : "removeSource";
    let completed = true;
    if (item.previous) {
      if (typeof options.engine[operation] !== "function") {
        diagnostics.push(diagnosticForItem("engine-lifecycle-operation-unavailable", item));
        completed = false;
      } else {
        try {
          await options.engine[operation](
            {
              source: item.source,
              previous: item.previous,
              reason: item.reason,
            },
            { signal: options.signal },
          );
        } catch (error) {
          if (isAbort(error, options.signal)) throw error;
          diagnostics.push(diagnosticForItem("engine-lifecycle-operation-failed", item, error));
          completed = false;
        }
      }
    }
    if (!completed) lifecycleFailed += 1;
    else if (item.action === "exclude") excluded += 1;
    else missing += 1;
    markProcessed(item);
  }

  const actionable = plan.items
    .filter(({ action }) => action === "append" || action === "replace-session")
    .sort(compareLargestFirst);
  const exclusions = buildExclusions(options.config, options.privacyContext);
  const results = await mapLimit(actionable, concurrency, async (item) => {
    try {
      options.signal?.throwIfAborted();
      const delta = await readDelta(item.source.provider, item.source.file, {
        ...adapterOptions,
        factSchemaVersion: requiredContract.factSchemaVersion,
        privacyContext: options.privacyContext,
        sessionId: item.source.sessionId,
        mode: item.action,
        ...(await adapterCheckpointOptions(options.engine, item, options.signal)),
      });
      assertDeltaMatchesItem(delta, item, options.privacyContext, requiredContract);
      if (projectExcluded(delta, exclusions)) {
        if (item.previous) {
          if (typeof options.engine.excludeSource !== "function") {
            const error = new Error("Engine cannot hide the existing excluded contribution");
            error.code = "TS_INSIGHTS_EXCLUDE_OPERATION_UNAVAILABLE";
            throw error;
          }
          await options.engine.excludeSource(
            {
              source: item.source,
              previous: item.previous,
              reason: "project-excluded",
            },
            { signal: options.signal },
          );
        }
        return { status: "excluded" };
      }
      const sourceState = await captureSourceState(item, delta, { statSource, sampleSource });
      await options.engine.commitSourceDelta(
        {
          delta,
          sourceState,
          reason: item.reason,
        },
        { signal: options.signal },
      );
      if (options.onSourceCommitted !== undefined) {
        await options.onSourceCommitted(Object.freeze({
          provider: item.source.provider,
          sessionId: item.source.sessionId.toLowerCase(),
        }));
      }
      await new Promise((resolve) => setImmediate(resolve));
      return { status: "committed" };
    } catch (error) {
      if (isAbort(error, options.signal)) throw error;
      diagnostics.push(diagnosticForItem("session-index-failed", item, error));
      return { status: "failed" };
    } finally {
      markProcessed(item);
    }
  });

  return {
    format: "threadshare-insights-index-report@v1",
    planned: plan.items.length + plan.planningFailed,
    unchanged: plan.items.filter(({ action }) => action === "unchanged").length,
    excluded: excluded + results.filter(({ status }) => status === "excluded").length,
    missing,
    committed: results.filter(({ status }) => status === "committed").length,
    bytesProcessed: bytesProcessed.toString(),
    bytesTotal: bytesTotal.toString(),
    failed:
      plan.planningFailed +
      lifecycleFailed +
      results.filter(({ status }) => status === "failed").length,
    diagnostics,
  };
}

export async function hideConfiguredInsightsSources(options = {}) {
  const engine = options.engine;
  if (
    engine === null ||
    typeof engine !== "object" ||
    typeof engine.readSourceStates !== "function" ||
    typeof engine.excludeSource !== "function"
  ) {
    throw new TypeError("engine must support readSourceStates and excludeSource");
  }
  if (!options.privacyContext || typeof options.privacyContext.originSecretEpoch !== "string") {
    throw new TypeError("privacyContext is required");
  }
  options.signal?.throwIfAborted();
  const exclusions = buildExclusions(options.config, options.privacyContext);
  const sourceStates = await engine.readSourceStates({ signal: options.signal });
  let hidden = 0;
  let failed = 0;
  for (const state of sourceStates) {
    options.signal?.throwIfAborted();
    const reason = exclusionReason(state, state, exclusions);
    if (reason === null) continue;
    try {
      const result = await engine.excludeSource(
        { previous: state, reason },
        { signal: options.signal },
      );
      if (result?.excluded !== false) hidden += 1;
    } catch (error) {
      if (options.signal?.aborted) throw error;
      failed += 1;
    }
  }
  if (failed > 0) {
    const error = new Error("Unable to apply all configured Insights exclusions");
    error.code = "TS_INSIGHTS_EXCLUSION_APPLY_FAILED";
    error.scanned = sourceStates.length;
    error.hidden = hidden;
    error.failed = failed;
    throw error;
  }
  return Object.freeze({
    format: "threadshare-insights-exclusion-visibility@v1",
    scanned: sourceStates.length,
    hidden,
  });
}
