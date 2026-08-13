import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  createInsightsIndexWorker,
  hideConfiguredInsightsSources,
  planInsightsReconciliation,
  runInsightsIndexer,
} from "../src/insights-indexer.mjs";
import { createPrivacyContext, hashKey } from "../src/session-facts.mjs";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const SESSION_KEY = hashKey("session", "codex", SESSION_ID);

function metadata(overrides = {}) {
  return {
    dev: "1",
    ino: "2",
    size: "8192",
    mtimeNs: "1000000000",
    ...overrides,
  };
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function jsonl(records) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function waitFor(predicate) {
  for (let attempt = 0; attempt < 100; attempt += 1) {
    if (predicate()) return;
    await new Promise((resolve) => setImmediate(resolve));
  }
  throw new Error("condition was not reached");
}

test("background worker coalesces filesystem bursts without overlapping reconciliation", async () => {
  let notify;
  let active = 0;
  let maxActive = 0;
  const cycles = [];
  const gates = [];
  const worker = createInsightsIndexWorker({
    watchRoots: ["/sessions"],
    debounceMs: 1,
    pollIntervalMs: 60_000,
    watchFactory(_root, _options, listener) {
      notify = listener;
      return { close() {}, on() {} };
    },
    async reconcile({ reasons }) {
      active += 1;
      maxActive = Math.max(maxActive, active);
      cycles.push(reasons);
      await new Promise((resolve) => gates.push(resolve));
      active -= 1;
      return { committed: 1 };
    },
  });

  assert.equal(worker.start(), true);
  await waitFor(() => gates.length === 1);
  notify("change", "active.jsonl");
  notify("change", "active.jsonl");
  worker.trigger("manual");
  gates.shift()();
  await waitFor(() => gates.length === 1 && cycles.length === 2);
  gates.shift()();
  await worker.whenIdle();

  assert.equal(maxActive, 1);
  assert.deepEqual(cycles, [
    ["startup"],
    ["filesystem", "manual"],
  ]);
  assert.equal(worker.status().cycleCount, 2);
  assert.equal(await worker.stop(), true);
});

test("background worker schedules periodic polling after reconciliation completes", async () => {
  const cycles = [];
  let releaseStartup;
  const worker = createInsightsIndexWorker({
    debounceMs: 0,
    pollIntervalMs: 30,
    async reconcile({ reasons }) {
      cycles.push(reasons);
      if (cycles.length === 1) {
        await new Promise((resolve) => {
          releaseStartup = resolve;
        });
      }
      return { failed: 0, diagnostics: [] };
    },
  });

  worker.start();
  await waitFor(() => typeof releaseStartup === "function");
  await new Promise((resolve) => setTimeout(resolve, 60));
  assert.deepEqual(cycles, [["startup"]]);

  releaseStartup();
  await worker.whenIdle();
  assert.deepEqual(cycles, [["startup"]]);
  await new Promise((resolve) => setTimeout(resolve, 45));
  await waitFor(() => cycles.length === 2);
  assert.deepEqual(cycles, [["startup"], ["poll"]]);
  assert.equal(await worker.stop(), true);
});

test("background worker retries a failed cycle and closes watchers on stop", async () => {
  let calls = 0;
  let closed = 0;
  const errors = [];
  const worker = createInsightsIndexWorker({
    watchRoots: ["/sessions"],
    debounceMs: 0,
    retryDelayMs: 0,
    pollIntervalMs: 60_000,
    watchFactory() {
      return { close() { closed += 1; }, on() {} };
    },
    async onError(item) {
      errors.push(item);
      throw new Error("error observer failed");
    },
    async reconcile() {
      calls += 1;
      if (calls === 1) throw new Error("transient failure");
      return { committed: calls };
    },
  });

  worker.start();
  await worker.whenIdle();
  assert.equal(errors.length, 1);
  assert.equal(errors[0].phase, "reconcile");
  assert.equal(worker.status().cycleCount, 1);
  assert.deepEqual(worker.status().lastReport, { committed: 2 });
  assert.equal(await worker.stop(), true);
  assert.equal(closed, 1);
});

test("background worker isolates observer callback failures from reconciliation", async () => {
  let calls = 0;
  const unhandled = [];
  const onUnhandled = (error) => unhandled.push(error);
  process.on("unhandledRejection", onUnhandled);
  const worker = createInsightsIndexWorker({
    debounceMs: 0,
    pollIntervalMs: 60_000,
    async onCycle() {
      throw new Error("async observer failed");
    },
    async onError() {
      throw new Error("async error observer failed");
    },
    async reconcile() {
      calls += 1;
      return { committed: calls };
    },
  });

  try {
    worker.start();
    await worker.whenIdle();
    assert.equal(worker.status().cycleCount, 1);
    assert.deepEqual(worker.status().lastReport, { committed: 1 });
    worker.trigger("retry", { immediate: true });
    await worker.whenIdle();
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal(worker.status().cycleCount, 2);
    assert.deepEqual(worker.status().lastReport, { committed: 2 });
    assert.deepEqual(unhandled, []);
    assert.equal(await worker.stop(), true);
  } finally {
    process.off("unhandledRejection", onUnhandled);
  }
});

test("background worker does not lose a trigger accepted before active cleanup", async () => {
  let calls = 0;
  let worker;
  worker = createInsightsIndexWorker({
    debounceMs: 0,
    pollIntervalMs: 60_000,
    onCycle({ cycle }) {
      if (cycle === 1) {
        queueMicrotask(() => worker.trigger("late", { immediate: true }));
      }
    },
    async reconcile() {
      calls += 1;
      return { committed: calls };
    },
  });

  worker.start();
  await waitFor(() => calls === 2);
  await worker.whenIdle();
  assert.equal(worker.status().queued, false);
  assert.equal(worker.status().cycleCount, 2);
  assert.equal(await worker.stop(), true);
});

test("background worker retains failed pending sessions and retries without waiting for poll", async () => {
  let notify;
  let calls = 0;
  const failedSessionId = "22222222-2222-4222-8222-222222222222";
  const worker = createInsightsIndexWorker({
    watchRoots: ["/sessions"],
    debounceMs: 0,
    retryDelayMs: 60_000,
    pollIntervalMs: 60_000,
    resolveWatchHint({ filename }) {
      return filename === null ? null : { provider: "codex", sessionId: String(filename) };
    },
    watchFactory(_root, _options, listener) {
      notify = listener;
      return { close() {}, on() {} };
    },
    async reconcile() {
      calls += 1;
      if (calls === 2) {
        return {
          failed: 1,
          diagnostics: [{
            code: "session-index-failed",
            provider: "codex",
            sessionId: failedSessionId,
          }],
        };
      }
      return { failed: 0, diagnostics: [], committed: 1 };
    },
  });

  worker.start();
  await worker.whenIdle();
  notify("change", failedSessionId);
  await waitFor(() => worker.status().cycleCount === 2);
  assert.deepEqual(worker.status().pendingSessions, [
    { provider: "codex", sessionId: failedSessionId },
  ]);
  assert.equal(worker.status().stale, true);
  worker.trigger("manual-retry", { immediate: true });
  await worker.whenIdle();
  assert.equal(calls, 3);
  assert.equal(worker.status().pendingSessionCount, 0);
  assert.equal(worker.status().stale, false);
  assert.equal(await worker.stop(), true);
});

test("background worker keeps watcher degradation visible after a successful poll", async () => {
  let watcherError;
  const worker = createInsightsIndexWorker({
    watchRoots: ["/sessions"],
    debounceMs: 0,
    pollIntervalMs: 60_000,
    watchFactory() {
      return {
        close() {},
        on(event, listener) {
          if (event === "error") watcherError = listener;
        },
      };
    },
    async reconcile() {
      return { failed: 0, diagnostics: [] };
    },
  });

  worker.start();
  await worker.whenIdle();
  watcherError(new Error("watcher unavailable"));
  worker.trigger("poll", { immediate: true });
  await worker.whenIdle();
  assert.equal(worker.status().watcherDegraded, true);
  assert.equal(worker.status().watcherErrorCount, 1);
  assert.equal(worker.status().staleAll, true);
  assert.equal(await worker.stop(), true);
});

test("background worker marks a partial reconciliation stale without watcher hints", async () => {
  const worker = createInsightsIndexWorker({
    debounceMs: 0,
    retryDelayMs: 60_000,
    pollIntervalMs: 60_000,
    async reconcile() {
      return { failed: 1, diagnostics: [] };
    },
  });

  worker.start();
  await waitFor(() => worker.status().cycleCount === 1);
  assert.equal(worker.status().pendingSessionCount, 0);
  assert.equal(worker.status().pendingUnknown, false);
  assert.equal(worker.status().stale, true);
  assert.equal(worker.status().staleAll, true);
  assert.equal(await worker.stop(), true);
});

test("background worker stays stale until each start completes a successful reconciliation", async () => {
  const gates = [];
  const worker = createInsightsIndexWorker({
    debounceMs: 0,
    pollIntervalMs: 60_000,
    reconcile() {
      return new Promise((resolve) => gates.push(resolve));
    },
  });

  worker.start();
  await waitFor(() => gates.length === 1);
  gates.shift()({ failed: 0, diagnostics: [] });
  await worker.whenIdle();
  assert.equal(worker.status().staleAll, false);
  await worker.stop();

  worker.start();
  await waitFor(() => gates.length === 1);
  assert.equal(worker.status().running, true);
  assert.equal(worker.status().stale, true);
  assert.equal(worker.status().staleAll, true);
  gates.shift()({ failed: 0, diagnostics: [] });
  await worker.whenIdle();
  assert.equal(worker.status().staleAll, false);
  assert.equal(await worker.stop(), true);
});

test("background worker finishes stopping when one watcher fails to close", async () => {
  let created = 0;
  const closed = [];
  const worker = createInsightsIndexWorker({
    watchRoots: ["/sessions-a", "/sessions-b"],
    debounceMs: 0,
    pollIntervalMs: 60_000,
    watchFactory(root) {
      created += 1;
      const instance = created;
      return {
        on() {},
        close() {
          closed.push({ instance, root });
          if (instance === 1) throw new Error("close failed");
        },
      };
    },
    async reconcile() {
      return { failed: 0, diagnostics: [] };
    },
  });

  worker.start();
  await worker.whenIdle();
  await assert.rejects(worker.stop(), /close failed/u);
  assert.deepEqual(closed, [
    { instance: 1, root: "/sessions-a" },
    { instance: 2, root: "/sessions-b" },
  ]);
  assert.equal(worker.status().started, false);
  assert.equal(worker.status().stale, true);
  assert.equal(worker.status().staleAll, true);

  assert.equal(worker.start(), true);
  await worker.whenIdle();
  assert.equal(worker.status().staleAll, false);
  assert.equal(await worker.stop(), true);
});

test("metadata-first reconciliation performs zero body reads for unchanged sources", async () => {
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/unchanged.jsonl",
  };
  let bodyReads = 0;
  const plan = await planInsightsReconciliation({
    sources: [source],
    sourceStates: [
      {
        provider: source.provider,
        sessionId: source.sessionId,
        file: source.file,
        metadata: metadata(),
        checkpoint: { completeOffset: "4096" },
        fingerprints: { head: "a".repeat(64), boundary: "b".repeat(64) },
      },
    ],
    async statSource(file) {
      assert.equal(file, source.file);
      return metadata();
    },
    async sampleSource() {
      bodyReads += 1;
      throw new Error("unchanged source body must not be sampled");
    },
  });

  assert.equal(bodyReads, 0);
  assert.deepEqual(plan.items.map(({ action, reason }) => ({ action, reason })), [
    { action: "unchanged", reason: "metadata-unchanged" },
  ]);
  assert.deepEqual(plan.diagnostics, []);
});

test("reconciles 10,000 unchanged sessions with one metadata read each and zero body reads", async () => {
  const count = 10_000;
  const sources = Array.from({ length: count }, (_, index) => ({
    provider: index % 2 === 0 ? "codex" : "claude",
    sessionId: `synthetic-${index.toString().padStart(5, "0")}`,
    file: `/sessions/synthetic-${index}.jsonl`,
  }));
  const sourceStates = sources.map((source) => ({
    ...source,
    metadata: metadata({ ino: String(Number(source.sessionId.slice(-5)) + 1) }),
    checkpoint: { completeOffset: "4096" },
    fingerprints: {},
  }));
  const metadataByFile = new Map(sourceStates.map((source) => [source.file, source.metadata]));
  let metadataReads = 0;
  let bodyReads = 0;
  const plan = await planInsightsReconciliation({
    sources,
    sourceStates,
    concurrency: 4,
    async statSource(file) {
      metadataReads += 1;
      return metadataByFile.get(file);
    },
    async sampleSource() {
      bodyReads += 1;
      return Buffer.alloc(0);
    },
  });

  assert.equal(plan.items.length, count);
  assert.equal(plan.items.every(({ action }) => action === "unchanged"), true);
  assert.equal(metadataReads, count);
  assert.equal(bodyReads, 0);
});

test("hides configured contributions in the active snapshot before a rebuild", async () => {
  const privacyContext = createPrivacyContext({
    originSecretEpoch: "22222222-2222-4222-8222-222222222222",
    secret: Buffer.alloc(32, 0x41),
  });
  const projectKey = privacyContext.projectFingerprint("codex", "/work/private");
  const sourceStates = [
    { provider: "claude", sessionId: "provider-match", projectKey: null },
    { provider: "codex", sessionId: "session-match", projectKey: null },
    { provider: "codex", sessionId: "project-match", projectKey },
    { provider: "codex", sessionId: "visible", projectKey: null },
  ];
  const excluded = [];
  const result = await hideConfiguredInsightsSources({
    config: {
      insights: {
        excludeProviders: ["claude"],
        excludeProjects: ["/work/private"],
        excludeSessions: ["session-match"],
      },
    },
    privacyContext,
    engine: {
      async readSourceStates() {
        return sourceStates;
      },
      async excludeSource(input) {
        excluded.push({
          sessionId: input.previous.sessionId,
          reason: input.reason,
        });
      },
    },
  });

  assert.deepEqual(result, {
    format: "threadshare-insights-exclusion-visibility@v1",
    scanned: 4,
    hidden: 3,
  });
  assert.deepEqual(excluded, [
    { sessionId: "provider-match", reason: "provider-excluded" },
    { sessionId: "session-match", reason: "session-excluded" },
    { sessionId: "project-match", reason: "project-excluded" },
  ]);
});

test("attempts every configured exclusion before reporting a partial failure", async () => {
  const privacyContext = createPrivacyContext({
    originSecretEpoch: "22222222-2222-4222-8222-222222222223",
    secret: Buffer.alloc(32, 0x42),
  });
  const attempted = [];
  await assert.rejects(
    hideConfiguredInsightsSources({
      config: {
        insights: {
          excludeProviders: ["codex"],
          excludeProjects: [],
          excludeSessions: [],
        },
      },
      privacyContext,
      engine: {
        async readSourceStates() {
          return ["first", "second", "third"].map((sessionId) => ({
            provider: "codex",
            sessionId,
            projectKey: null,
          }));
        },
        async excludeSource(input) {
          attempted.push(input.previous.sessionId);
          if (input.previous.sessionId === "second") {
            throw new Error("injected exclusion failure");
          }
          return { excluded: true };
        },
      },
    }),
    (error) => {
      assert.equal(error.code, "TS_INSIGHTS_EXCLUSION_APPLY_FAILED");
      assert.equal(error.scanned, 3);
      assert.equal(error.hidden, 2);
      assert.equal(error.failed, 1);
      return true;
    },
  );
  assert.deepEqual(attempted, ["first", "second", "third"]);
});

test("selects append only after fixed head and checkpoint-boundary fingerprints match", async () => {
  const raw = Buffer.alloc(8192, 0x61);
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/appended.jsonl",
  };
  const ranges = [];
  const plan = await planInsightsReconciliation({
    sources: [source],
    sourceStates: [
      {
        ...source,
        metadata: metadata({ size: "7000" }),
        checkpoint: { completeOffset: "6000" },
        fingerprints: {
          head: { offset: "0", length: 4096, sha256: sha256(raw.subarray(0, 4096)) },
          boundary: {
            offset: "1904",
            length: 4096,
            sha256: sha256(raw.subarray(1904, 6000)),
          },
        },
      },
    ],
    async statSource() {
      return metadata({ size: "8192", mtimeNs: "2000000000" });
    },
    async sampleSource(file, range) {
      assert.equal(file, source.file);
      ranges.push(range);
      const start = Number(range.offset);
      return raw.subarray(start, start + range.length);
    },
  });

  assert.deepEqual(ranges, [
    { kind: "head", offset: "0", length: 4096 },
    { kind: "boundary", offset: "1904", length: 4096 },
  ]);
  assert.equal(plan.items[0].action, "append");
  assert.equal(plan.items[0].reason, "append-boundary-matched");
});

test("rebuilds unchanged sources for fact contract changes but never rotates origin identity", async () => {
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/contract.jsonl",
  };
  const epoch = "22222222-2222-4222-8222-222222222222";
  const previous = {
    ...source,
    metadata: metadata(),
    checkpoint: { completeOffset: "4096" },
    fingerprints: {
      head: { offset: "0", length: 4096, sha256: "a".repeat(64) },
      boundary: { offset: "0", length: 4096, sha256: "b".repeat(64) },
    },
    contract: {
      factSchemaVersion: 1,
      providerAdapterVersion: "codex@1",
      privacyPolicyVersion: 1,
      duplicatePolicyVersion: 1,
      originSecretEpoch: epoch,
    },
  };
  const requiredContract = {
    factSchemaVersion: 2,
    providerAdapterVersions: ["claude@1", "codex@1"],
    privacyPolicyVersion: 1,
    duplicatePolicyVersion: 1,
    originSecretEpoch: epoch,
  };
  const plan = await planInsightsReconciliation({
    sources: [source],
    sourceStates: [previous],
    requiredContract,
    async statSource() {
      return metadata();
    },
  });
  assert.equal(plan.items[0].action, "replace-session");
  assert.equal(plan.items[0].reason, "fact-schema-changed");

  await assert.rejects(
    planInsightsReconciliation({
      sources: [source],
      sourceStates: [previous],
      requiredContract: {
        ...requiredContract,
        originSecretEpoch: "33333333-3333-4333-8333-333333333333",
      },
      async statSource() {
        return metadata();
      },
    }),
    (error) => error?.code === "TS_INSIGHTS_INVALID_ORIGIN_EPOCH",
  );
});

test("applies provider, session, and known project exclusions before stat or body reads", async () => {
  const sources = [
    { provider: "codex", sessionId: SESSION_ID, file: "/sessions/provider.jsonl" },
    {
      provider: "claude",
      sessionId: "22222222-2222-4222-8222-222222222222",
      file: "/sessions/project.jsonl",
    },
    {
      provider: "claude",
      sessionId: "33333333-3333-4333-8333-333333333333",
      file: "/sessions/session.jsonl",
    },
  ];
  let statCalls = 0;
  const plan = await planInsightsReconciliation({
    sources,
    sourceStates: [
      { ...sources[0], metadata: metadata() },
      { ...sources[1], metadata: metadata(), projectKey: "claude:/work/private" },
    ],
    config: {
      format: "threadshare-config@v1",
      schemaVersion: 1,
      insights: {
        excludeProviders: ["codex"],
        excludeProjects: ["/work/private"],
        excludeSessions: [sources[2].sessionId],
        quiescenceSeconds: 300,
      },
    },
    privacyContext: {
      projectFingerprint(provider, project) {
        return `${provider}:${project}`;
      },
    },
    async statSource() {
      statCalls += 1;
      return metadata();
    },
  });

  assert.equal(statCalls, 0);
  assert.deepEqual(
    plan.items.map(({ action, reason }) => ({ action, reason })),
    [
      { action: "exclude", reason: "provider-excluded" },
      { action: "exclude", reason: "project-excluded" },
      { action: "exclude", reason: "session-excluded" },
    ],
  );
});

test("runs session batches newest first with fixed concurrency", async () => {
  const sources = Array.from({ length: 5 }, (_, index) => ({
    provider: "codex",
    sessionId: `00000000-0000-4000-8000-00000000000${index}`,
    file: `/sessions/${index}.jsonl`,
  }));
  const metadataByFile = new Map(sources.map((source, index) => [
    source.file,
    metadata({ size: "10", mtimeNs: String((index + 1) * 100) }),
  ]));
  const started = [];
  const releases = [];
  const commits = [];
  const progress = [];
  let active = 0;
  let maximumActive = 0;

  const running = runInsightsIndexer({
    sources,
    concurrency: 2,
    onProgress(value) {
      progress.push(value);
    },
    privacyContext: { originSecretEpoch: "44444444-4444-4444-8444-444444444444" },
    engine: {
      async readSourceStates() {
        return [];
      },
      async commitSourceDelta(batch) {
        commits.push(batch);
        return { snapshotId: String(commits.length) };
      },
    },
    async statSource(file) {
      return metadataByFile.get(file);
    },
    async sampleSource(_file, range) {
      return Buffer.alloc(range.length);
    },
    async readDelta(provider, file, options) {
      assert.equal(provider, "codex");
      assert.equal(options.mode, "replace-session");
      started.push(file);
      active += 1;
      maximumActive = Math.max(maximumActive, active);
      await new Promise((resolve) => releases.push(resolve));
      active -= 1;
      const sourceMetadata = metadataByFile.get(file);
      return {
        format: "session-facts-delta@v1",
        factSchemaVersion: 1,
        providerAdapterVersion: "codex@1",
        privacyPolicyVersion: 1,
        duplicatePolicyVersion: 1,
        originSecretEpoch: options.privacyContext.originSecretEpoch,
        mode: options.mode,
        session: {
          provider,
          sessionKey: hashKey("session", provider, options.sessionId.toLowerCase()),
        },
        checkpoint: {
          completeOffset: "0",
          sourceSize: sourceMetadata.size,
          sourceMtimeNs: sourceMetadata.mtimeNs,
          sourceSnapshotStable: true,
          generation: "1",
        },
      };
    },
  });

  await waitFor(() => started.length === 2);
  assert.deepEqual(started, ["/sessions/4.jsonl", "/sessions/3.jsonl"]);
  for (let index = 0; index < sources.length; index += 1) {
    releases[index]();
    if (index + 2 < sources.length) {
      await waitFor(() => started.length === index + 3);
    }
  }
  const report = await running;
  assert.equal(maximumActive, 2);
  assert.deepEqual(started, [
    "/sessions/4.jsonl",
    "/sessions/3.jsonl",
    "/sessions/2.jsonl",
    "/sessions/1.jsonl",
    "/sessions/0.jsonl",
  ]);
  assert.equal(commits.length, 5);
  assert.equal(report.committed, 5);
  assert.equal(report.bytesProcessed, "50");
  assert.equal(report.bytesTotal, "50");
  assert.deepEqual(progress[0], { bytesProcessed: "0", bytesTotal: "50" });
  assert.deepEqual(progress.at(-1), { bytesProcessed: "50", bytesTotal: "50" });
  assert.deepEqual(report.diagnostics, []);
});

test("feeds generations into the real provider adapter for append and replacement", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-incremental-"));
  const file = path.join(directory, `rollout-${SESSION_ID}.jsonl`);
  const source = { provider: "codex", sessionId: SESSION_ID, file };
  const privacyContext = createPrivacyContext({
    secret: Buffer.from(
      "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
      "hex",
    ),
    originSecretEpoch: "44444444-4444-4444-8444-444444444444",
  });
  let sourceStates = [];
  let parserCheckpoint = null;
  let checkpointReads = 0;
  const commits = [];
  const engine = {
    async readSourceStates() {
      return structuredClone(sourceStates);
    },
    async readSourceCheckpoint(sessionKey) {
      assert.equal(sessionKey, SESSION_KEY);
      checkpointReads += 1;
      return structuredClone(parserCheckpoint);
    },
    async commitSourceDelta(batch) {
      commits.push(structuredClone(batch));
      parserCheckpoint = structuredClone(batch.sourceState.checkpoint);
      const { checkpoint: _checkpoint, ...state } = batch.sourceState;
      sourceStates = [{
        ...structuredClone(state),
        checkpoint: {
          completeOffset: parserCheckpoint.completeOffset,
          sourceSnapshotStable: parserCheckpoint.sourceSnapshotStable,
          generation: parserCheckpoint.generation,
        },
      }];
      return { snapshotId: String(commits.length) };
    },
  };
  const sealedPrefix = Array.from({ length: 32 }, (_, index) => [
    { type: "event_msg", payload: { type: "task_started", turn_id: `sealed-${index}` } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Sealed prompt ${index} ${"x".repeat(128)}` }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `Sealed answer ${index} ${"y".repeat(128)}` }],
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: `sealed-${index}` } },
  ]).flat();
  const initialRecords = [
    {
      type: "session_meta",
      payload: { id: SESSION_ID, cwd: "/work/incremental", cli_version: "1.2.3" },
    },
    ...sealedPrefix,
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    {
      type: "response_item",
      timestamp: "2026-08-10T01:00:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Finish the incremental task" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-1",
        name: "Bash",
        arguments: JSON.stringify({ command: "private command" }),
      },
    },
  ];
  const appendedRecords = [
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-1",
        output: "private output",
        status: "completed",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Incremental task complete." }],
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
  ];

  try {
    const initialRaw = jsonl(initialRecords);
    const appendedRaw = jsonl(appendedRecords);
    await writeFile(file, initialRaw);
    const first = await runInsightsIndexer({
      sources: [source],
      engine,
      privacyContext,
      concurrency: 1,
    });
    assert.equal(first.committed, 1);
    assert.equal(commits[0].delta.mode, "replace-session");
    assert.equal(commits[0].delta.expectedGeneration, "0");
    const firstOffset = commits[0].sourceState.checkpoint.completeOffset;
    const replayFromOffset = Number(parserCheckpoint.pendingState.replayFromOffset);
    assert.equal(replayFromOffset > Buffer.byteLength(initialRaw) * 0.9, true);

    await appendFile(file, appendedRaw);
    const reads = [];
    const second = await runInsightsIndexer({
      sources: [source],
      engine,
      privacyContext,
      concurrency: 1,
      adapterOptions: {
        chunkSize: 37,
        onBytesRead: (read) => reads.push(read),
      },
    });
    assert.equal(second.committed, 1);
    assert.equal(commits[1].delta.mode, "append");
    assert.equal(commits[1].delta.expectedGeneration, "1");
    assert.equal(commits[1].delta.targetGeneration, "2");
    assert.ok(BigInt(commits[1].sourceState.checkpoint.completeOffset) > BigInt(firstOffset));
    assert.equal(commits[1].delta.turns[0].finalAnswerExcerpt, "Incremental task complete.");
    assert.doesNotMatch(JSON.stringify(commits[1].delta), /private command|private output/u);
    assert.equal(checkpointReads, 1);
    const totalSize = Buffer.byteLength(initialRaw) + Buffer.byteLength(appendedRaw);
    assert.equal(
      reads.reduce((sum, read) => sum + read.bytesRead, 0),
      totalSize - replayFromOffset,
    );
    assert.equal(reads.every((read) => Number(read.startOffset) >= replayFromOffset), true);

    await writeFile(file, jsonl([
      {
        type: "session_meta",
        payload: { id: SESSION_ID, cwd: "/work/incremental", cli_version: "1.2.3" },
      },
      { type: "event_msg", payload: { type: "task_started", turn_id: "turn-2" } },
      {
        type: "response_item",
        timestamp: "2026-08-10T02:00:00.000Z",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Rebuild the rewritten session" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Replacement complete." }],
        },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-2" } },
    ]));
    const third = await runInsightsIndexer({
      sources: [source],
      engine,
      privacyContext,
      concurrency: 1,
      adapterOptions: {
        checkpoint: parserCheckpoint,
        expectedGeneration: "999",
      },
    });
    assert.equal(third.committed, 1);
    assert.equal(commits[2].delta.mode, "replace-session");
    assert.equal(commits[2].delta.expectedGeneration, "2");
    assert.equal(commits[2].delta.targetGeneration, "3");
    assert.equal(commits[2].delta.turns[0].finalAnswerExcerpt, "Replacement complete.");
    assert.equal(checkpointReads, 1);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("passes cancellation to source-state reads", async () => {
  const controller = new AbortController();
  const abortError = Object.assign(new Error("read cancelled"), { name: "AbortError" });

  await assert.rejects(
    runInsightsIndexer({
      sources: [],
      privacyContext: { originSecretEpoch: "44444444-4444-4444-8444-444444444444" },
      signal: controller.signal,
      engine: {
        async readSourceStates(options = {}) {
          assert.equal(options.signal, controller.signal);
          throw abortError;
        },
        async commitSourceDelta() {
          throw new Error("must not commit after a cancelled read");
        },
      },
    }),
    (error) => error === abortError,
  );
});

test("passes cancellation to commits without downgrading aborts to diagnostics", async () => {
  const controller = new AbortController();
  const abortError = Object.assign(new Error("commit cancelled"), { name: "AbortError" });
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/cancelled-commit.jsonl",
  };

  await assert.rejects(
    runInsightsIndexer({
      sources: [source],
      concurrency: 1,
      privacyContext: { originSecretEpoch: "44444444-4444-4444-8444-444444444444" },
      signal: controller.signal,
      engine: {
        async readSourceStates(options = {}) {
          assert.equal(options.signal, controller.signal);
          return [];
        },
        async commitSourceDelta(_batch, options = {}) {
          assert.equal(options.signal, controller.signal);
          throw abortError;
        },
      },
      async statSource() {
        return metadata({ size: "10" });
      },
      async sampleSource(_file, range) {
        return Buffer.alloc(range.length);
      },
      async readDelta(provider, _file, options) {
        return {
          format: "session-facts-delta@v1",
          factSchemaVersion: 1,
          providerAdapterVersion: "codex@1",
          privacyPolicyVersion: 1,
          duplicatePolicyVersion: 1,
          originSecretEpoch: options.privacyContext.originSecretEpoch,
          mode: options.mode,
          session: { provider, sessionKey: SESSION_KEY },
          checkpoint: {
            completeOffset: "0",
            sourceSize: "10",
            sourceMtimeNs: "1000000000",
            sourceSnapshotStable: true,
            generation: "1",
          },
        };
      },
    }),
    (error) => error === abortError,
  );
});

test("does not report an existing contribution excluded without an engine lifecycle operation", async () => {
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/excluded-existing.jsonl",
  };
  const report = await runInsightsIndexer({
    sources: [source],
    privacyContext: { originSecretEpoch: "44444444-4444-4444-8444-444444444444" },
    config: {
      insights: {
        excludeProviders: ["codex"],
        excludeProjects: [],
        excludeSessions: [],
      },
    },
    engine: {
      async readSourceStates() {
        return [{ ...source, metadata: metadata() }];
      },
      async commitSourceDelta() {
        throw new Error("must not commit excluded sources");
      },
    },
    async statSource() {
      throw new Error("excluded sources must not be stated");
    },
  });

  assert.equal(report.excluded, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.diagnostics[0].code, "engine-lifecycle-operation-unavailable");
});

test("counts source stat and fingerprint planning failures as failed work", async () => {
  const statFailure = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/stat-failure.jsonl",
  };
  const fingerprintFailure = {
    provider: "claude",
    sessionId: "22222222-2222-4222-8222-222222222222",
    file: "/sessions/fingerprint-failure.jsonl",
  };
  const report = await runInsightsIndexer({
    sources: [statFailure, fingerprintFailure],
    privacyContext: { originSecretEpoch: "44444444-4444-4444-8444-444444444444" },
    engine: {
      async readSourceStates() {
        return [{
          ...fingerprintFailure,
          metadata: metadata({ size: "7000" }),
          checkpoint: { completeOffset: "6000" },
          fingerprints: {
            head: { offset: "0", length: 4096, sha256: "a".repeat(64) },
            boundary: { offset: "1904", length: 4096, sha256: "b".repeat(64) },
          },
          contract: {
            originSecretEpoch: "44444444-4444-4444-8444-444444444444",
            providerAdapterVersion: "claude@1",
          },
        }];
      },
      async commitSourceDelta() {
        throw new Error("planning failures must not commit");
      },
    },
    async statSource(file) {
      if (file === statFailure.file) {
        throw Object.assign(new Error("injected stat failure"), { code: "EACCES" });
      }
      return metadata({ size: "8000", mtimeNs: "2000000000" });
    },
    async sampleSource() {
      throw Object.assign(new Error("injected fingerprint failure"), { code: "EIO" });
    },
  });

  assert.equal(report.planned, 2);
  assert.equal(report.committed, 0);
  assert.equal(report.failed, 2);
  assert.deepEqual(
    report.diagnostics.map(({ code, errorCode }) => ({ code, errorCode })).sort((left, right) =>
      left.code.localeCompare(right.code)),
    [
      { code: "source-fingerprint-failed", errorCode: "EIO" },
      { code: "source-stat-failed", errorCode: "EACCES" },
    ],
  );
});

test("rejects reconciliation fingerprints that do not cover the fixed ranges", async () => {
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/invalid-fingerprint-range.jsonl",
  };
  let samples = 0;
  const emptyDigest = sha256(Buffer.alloc(0));
  const plan = await planInsightsReconciliation({
    sources: [source],
    sourceStates: [
      {
        ...source,
        metadata: metadata({ size: "7000" }),
        checkpoint: { completeOffset: "6000" },
        fingerprints: {
          head: { offset: "0", length: 0, sha256: emptyDigest },
          boundary: { offset: "6000", length: 0, sha256: emptyDigest },
        },
      },
    ],
    async statSource() {
      return metadata({ size: "8000", mtimeNs: "2000000000" });
    },
    async sampleSource() {
      samples += 1;
      return Buffer.alloc(0);
    },
  });

  assert.equal(samples, 0);
  assert.equal(plan.items[0].action, "replace-session");
  assert.equal(plan.items[0].reason, "reconciliation-fingerprint-missing");
});

test("rejects an adapter delta that does not match the planned source and mode", async () => {
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/mismatched-delta.jsonl",
  };
  let commitCalls = 0;
  const epoch = "44444444-4444-4444-8444-444444444444";
  const report = await runInsightsIndexer({
    sources: [source],
    concurrency: 1,
    privacyContext: { originSecretEpoch: epoch },
    engine: {
      async readSourceStates() {
        return [];
      },
      async commitSourceDelta() {
        commitCalls += 1;
      },
    },
    async statSource() {
      return metadata({ size: "10" });
    },
    async sampleSource(_file, range) {
      return Buffer.alloc(range.length);
    },
    async readDelta() {
      return {
        format: "session-facts-delta@v1",
        factSchemaVersion: 1,
        providerAdapterVersion: "codex@1",
        privacyPolicyVersion: 1,
        duplicatePolicyVersion: 1,
        originSecretEpoch: epoch,
        mode: "append",
        session: { provider: "codex", sessionKey: SESSION_KEY },
        checkpoint: {
          completeOffset: "0",
          sourceSize: "10",
          sourceMtimeNs: "1000000000",
          generation: "1",
        },
      };
    },
  });

  assert.equal(commitCalls, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.diagnostics[0].errorCode, "TS_INSIGHTS_DELTA_MISMATCH");
});

test("reschedules an unstable committed snapshot even when metadata is unchanged", async () => {
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/unstable.jsonl",
  };
  let samples = 0;
  const plan = await planInsightsReconciliation({
    sources: [source],
    sourceStates: [
      {
        ...source,
        metadata: metadata(),
        checkpoint: { completeOffset: "4096", sourceSnapshotStable: false },
        fingerprints: {
          head: { offset: "0", length: 4096, sha256: "a".repeat(64) },
          boundary: { offset: "0", length: 4096, sha256: "b".repeat(64) },
        },
      },
    ],
    async statSource() {
      return metadata();
    },
    async sampleSource() {
      samples += 1;
      return Buffer.alloc(4096);
    },
  });

  assert.equal(samples, 0);
  assert.equal(plan.items[0].action, "append");
  assert.equal(plan.items[0].reason, "unstable-source-snapshot");
});

test("rejects an append when stored-prefix bytes change after adapter parsing", async () => {
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/raced-rewrite.jsonl",
  };
  const epoch = "44444444-4444-4444-8444-444444444444";
  const previousBytes = Buffer.alloc(8_192, 0x61);
  const appendedBytes = Buffer.concat([previousBytes, Buffer.alloc(4_096, 0x63)]);
  const rewrittenBytes = Buffer.alloc(appendedBytes.length, 0x62);
  let rewritten = false;
  let commits = 0;
  const report = await runInsightsIndexer({
    sources: [source],
    concurrency: 1,
    privacyContext: { originSecretEpoch: epoch },
    engine: {
      async readSourceStates() {
        return [{
          ...source,
          metadata: metadata(),
          checkpoint: {
            completeOffset: "8192",
            sourceSize: "8192",
            sourceMtimeNs: "1000000000",
            sourceSnapshotStable: true,
            generation: "1",
          },
          fingerprints: {
            head: { offset: "0", length: 4096, sha256: sha256(previousBytes.subarray(0, 4096)) },
            boundary: {
              offset: "4096",
              length: 4096,
              sha256: sha256(previousBytes.subarray(4096)),
            },
          },
          contract: {
            factSchemaVersion: 1,
            providerAdapterVersion: "codex@1",
            privacyPolicyVersion: 1,
            duplicatePolicyVersion: 1,
            originSecretEpoch: epoch,
          },
        }];
      },
      async commitSourceDelta() {
        commits += 1;
      },
    },
    async statSource() {
      return metadata({ size: "12288", mtimeNs: "2000000000" });
    },
    async sampleSource(_file, range) {
      const bytes = rewritten ? rewrittenBytes : appendedBytes;
      const start = Number(range.offset);
      return bytes.subarray(start, start + range.length);
    },
    async readDelta(provider, _file, options) {
      rewritten = true;
      return {
        format: "session-facts-delta@v1",
        factSchemaVersion: 1,
        providerAdapterVersion: "codex@1",
        privacyPolicyVersion: 1,
        duplicatePolicyVersion: 1,
        originSecretEpoch: epoch,
        mode: options.mode,
        session: { provider, sessionKey: SESSION_KEY },
        checkpoint: {
          completeOffset: "12288",
          sourceSize: "12288",
          sourceMtimeNs: "2000000000",
          sourceSnapshotStable: true,
          generation: "2",
        },
      };
    },
  });

  assert.equal(commits, 0);
  assert.equal(report.committed, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.diagnostics[0].errorCode, "TS_INSIGHTS_SOURCE_CHANGED");
});

test("rejects a checkpoint whose size or mtime differs from the sampled snapshot", async () => {
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/stale-checkpoint.jsonl",
  };
  const epoch = "44444444-4444-4444-8444-444444444444";
  let commits = 0;
  const report = await runInsightsIndexer({
    sources: [source],
    concurrency: 1,
    privacyContext: { originSecretEpoch: epoch },
    engine: {
      async readSourceStates() {
        return [];
      },
      async commitSourceDelta() {
        commits += 1;
      },
    },
    async statSource() {
      return metadata({ size: "10", mtimeNs: "2000000000" });
    },
    async sampleSource(_file, range) {
      return Buffer.alloc(range.length);
    },
    async readDelta(provider, _file, options) {
      return {
        format: "session-facts-delta@v1",
        factSchemaVersion: 1,
        providerAdapterVersion: "codex@1",
        privacyPolicyVersion: 1,
        duplicatePolicyVersion: 1,
        originSecretEpoch: epoch,
        mode: options.mode,
        session: { provider, sessionKey: SESSION_KEY },
        checkpoint: {
          completeOffset: "0",
          sourceSize: "9",
          sourceMtimeNs: "1000000000",
          sourceSnapshotStable: true,
          generation: "1",
        },
      };
    },
  });

  assert.equal(commits, 0);
  assert.equal(report.committed, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.diagnostics[0].errorCode, "TS_INSIGHTS_SOURCE_CHANGED");
});

test("commits a stable prefix when an active session appends after the adapter snapshot", async () => {
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/active.jsonl",
  };
  const epoch = "44444444-4444-4444-8444-444444444444";
  let statCalls = 0;
  const commits = [];
  const report = await runInsightsIndexer({
    sources: [source],
    concurrency: 1,
    privacyContext: { originSecretEpoch: epoch },
    engine: {
      async readSourceStates() { return []; },
      async commitSourceDelta(batch) { commits.push(batch); },
    },
    async statSource() {
      statCalls += 1;
      return metadata(statCalls === 1
        ? { size: "8192", mtimeNs: "1000000000" }
        : { size: "12288", mtimeNs: "2000000000" });
    },
    async sampleSource(_file, range) { return Buffer.alloc(range.length); },
    async readDelta(provider, _file, options) {
      return {
        format: "session-facts-delta@v1",
        factSchemaVersion: 1,
        providerAdapterVersion: "codex@1",
        privacyPolicyVersion: 1,
        duplicatePolicyVersion: 1,
        originSecretEpoch: epoch,
        mode: options.mode,
        session: { provider, sessionKey: SESSION_KEY },
        checkpoint: {
          completeOffset: "8192",
          sourceSize: "8192",
          sourceMtimeNs: "1000000000",
          sourceSnapshotStable: true,
          generation: "1",
        },
      };
    },
  });

  assert.equal(report.failed, 0);
  assert.equal(report.committed, 1);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].sourceState.metadata.size, "8192");
  assert.equal(commits[0].sourceState.checkpoint.completeOffset, "8192");
});

test("rejects a provider delta that violates the required index contract", async () => {
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/wrong-contract.jsonl",
  };
  const epoch = "44444444-4444-4444-8444-444444444444";
  let commits = 0;
  const report = await runInsightsIndexer({
    sources: [source],
    concurrency: 1,
    privacyContext: { originSecretEpoch: epoch },
    requiredContract: {
      factSchemaVersion: 2,
      providerAdapterVersions: ["claude@2", "codex@2"],
      privacyPolicyVersion: 2,
      duplicatePolicyVersion: 2,
    },
    engine: {
      async readSourceStates() {
        return [];
      },
      async commitSourceDelta() {
        commits += 1;
      },
    },
    async statSource() {
      return metadata({ size: "10" });
    },
    async sampleSource(_file, range) {
      return Buffer.alloc(range.length);
    },
    async readDelta(provider, _file, options) {
      return {
        format: "session-facts-delta@v1",
        factSchemaVersion: 1,
        providerAdapterVersion: "codex@1",
        privacyPolicyVersion: 1,
        duplicatePolicyVersion: 1,
        originSecretEpoch: epoch,
        mode: options.mode,
        session: { provider, sessionKey: SESSION_KEY },
        checkpoint: {
          completeOffset: "0",
          sourceSize: "10",
          sourceMtimeNs: "1000000000",
          sourceSnapshotStable: true,
          generation: "1",
        },
      };
    },
  });

  assert.equal(commits, 0);
  assert.equal(report.committed, 0);
  assert.equal(report.failed, 1);
  assert.equal(report.diagnostics[0].errorCode, "TS_INSIGHTS_DELTA_MISMATCH");
});

test("binds delta session identity and adapter version to the planned source", async () => {
  const source = {
    provider: "codex",
    sessionId: SESSION_ID,
    file: "/sessions/cross-boundary-delta.jsonl",
  };
  const epoch = "44444444-4444-4444-8444-444444444444";
  const cases = [
    { sessionKey: "b".repeat(64), providerAdapterVersion: "codex@1" },
    { sessionKey: SESSION_KEY, providerAdapterVersion: "claude@1" },
  ];
  for (const invalid of cases) {
    let commits = 0;
    const report = await runInsightsIndexer({
      sources: [source],
      concurrency: 1,
      privacyContext: { originSecretEpoch: epoch },
      requiredContract: {
        factSchemaVersion: 1,
        providerAdapterVersions: ["claude@1", "codex@1"],
        privacyPolicyVersion: 1,
        duplicatePolicyVersion: 1,
      },
      engine: {
        async readSourceStates() {
          return [];
        },
        async commitSourceDelta() {
          commits += 1;
        },
      },
      async statSource() {
        return metadata({ size: "10" });
      },
      async sampleSource(_file, range) {
        return Buffer.alloc(range.length);
      },
      async readDelta(provider, _file, options) {
        return {
          format: "session-facts-delta@v1",
          factSchemaVersion: 1,
          providerAdapterVersion: invalid.providerAdapterVersion,
          privacyPolicyVersion: 1,
          duplicatePolicyVersion: 1,
          originSecretEpoch: epoch,
          mode: options.mode,
          session: { provider, sessionKey: invalid.sessionKey },
          checkpoint: {
            completeOffset: "0",
            sourceSize: "10",
            sourceMtimeNs: "1000000000",
            sourceSnapshotStable: true,
            generation: "1",
          },
        };
      },
    });
    assert.equal(commits, 0);
    assert.equal(report.failed, 1);
    assert.equal(report.diagnostics[0].errorCode, "TS_INSIGHTS_DELTA_MISMATCH");
  }
});
