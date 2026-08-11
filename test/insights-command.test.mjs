import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { appendFile, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createInsightsBackgroundWorker,
  executeInsightsCommand,
  formatInsightsCommandResult,
  insightsPurgeWorkPending,
  insightsRequiredContract,
  parseInsightsInvocation,
  reconcileActiveInsights,
  reconcileInsights,
} from "../src/insights-command.mjs";
import { readProviderSessionDelta } from "../src/provider-evidence.mjs";
import {
  createInsightsE2EFixture,
  INSIGHTS_E2E_SKIP,
} from "./helpers/insights-e2e.mjs";

const cli = fileURLToPath(new URL("../bin/threadshare.mjs", import.meta.url));
const engine = fileURLToPath(new URL(
  process.platform === "win32"
    ? "../crates/insights-engine/target/debug/threadshare-insights-engine.exe"
    : "../crates/insights-engine/target/debug/threadshare-insights-engine",
  import.meta.url,
));

function emptyConfig() {
  return {
    format: "threadshare-config@v1",
    schemaVersion: 1,
    insights: {
      excludeProviders: [],
      excludeProjects: [],
      excludeSessions: [],
      quiescenceSeconds: 300,
    },
  };
}

test("parses the bounded insights subcommand grammar", () => {
  assert.deepEqual(
    parseInsightsInvocation(["insights", "status"], {}),
    { action: "status", format: "text", regenerateSecret: false },
  );
  assert.deepEqual(
    parseInsightsInvocation(
      ["insights", "exclude", "add", "project", "/work/private"],
      { format: "json" },
    ),
    {
      action: "exclude",
      operation: "add",
      kind: "project",
      value: "/work/private",
      format: "json",
      regenerateSecret: false,
    },
  );
  assert.deepEqual(
    parseInsightsInvocation(["insights", "reindex"], { "regenerate-secret": true }),
    { action: "reindex", format: "text", regenerateSecret: true },
  );
  for (const [positionals, options, code] of [
    [["insights", "unknown"], {}, "TS_USAGE_INVALID_VALUE"],
    [["insights", "status", "extra"], {}, "TS_USAGE_UNEXPECTED_ARGUMENT"],
    [["insights", "exclude", "add", "unknown", "value"], {}, "TS_USAGE_INVALID_VALUE"],
    [["insights", "exclude", "remove", "session"], {}, "TS_USAGE_MISSING_ARGUMENT"],
    [["insights", "reset"], { "regenerate-secret": true }, "TS_USAGE_OPTION_NOT_ALLOWED"],
  ]) {
    assert.throws(() => parseInsightsInvocation(positionals, options), { code });
  }
});

test("executes status, exclusions, reset, and reindex through injectable services", async () => {
  const config = emptyConfig();
  const calls = [];
  const services = {
    async status() {
      calls.push("status");
      return {
        format: "threadshare-insights-status@v1",
        state: "ready",
        bytes: "12",
        entries: 2,
        databasePresent: true,
        originSecretPresent: true,
        diagnostics: [],
      };
    },
    async reset() {
      calls.push("reset");
      return { format: "threadshare-insights-reset@v1", reset: true };
    },
    async loadConfig() {
      calls.push("list");
      return structuredClone(config);
    },
    async updateExclusion(change) {
      calls.push(`${change.operation}:${change.kind}:${change.value}`);
      config.insights.excludeProviders = [change.value];
      return { changed: true, config: structuredClone(config) };
    },
    async hideExclusions(updatedConfig) {
      calls.push(`hide:${updatedConfig.insights.excludeProviders.join(",")}`);
      return {
        format: "threadshare-insights-exclusion-visibility@v1",
        scanned: 2,
        hidden: 1,
      };
    },
    async shouldReconcile() {
      return true;
    },
    async reindex({ regenerateSecret }) {
      calls.push(`reindex:${regenerateSecret}`);
      return {
        format: "threadshare-insights-reindex@v1",
        originSecretPreserved: !regenerateSecret,
        report: { committed: 1, unchanged: 0, excluded: 0, missing: 0, failed: 0 },
        purge: { state: "purged", batches: 0 },
      };
    },
  };

  const status = await executeInsightsCommand(
    parseInsightsInvocation(["insights", "status"]),
    { services },
  );
  assert.match(formatInsightsCommandResult(status), /^Insights state: ready/mu);
  assert.equal(formatInsightsCommandResult(status, "json"), `${JSON.stringify(status)}\n`);

  const updated = await executeInsightsCommand(
    parseInsightsInvocation(["insights", "exclude", "add", "provider", "codex"]),
    { services },
  );
  assert.equal(updated.changed, true);
  assert.equal(updated.visibility.hidden, 1);
  assert.equal(updated.reconciliation.format, "threadshare-insights-reindex@v1");
  assert.match(formatInsightsCommandResult(updated), /Added provider exclusion/u);

  const listed = await executeInsightsCommand(
    parseInsightsInvocation(["insights", "exclude", "list"]),
    { services },
  );
  assert.deepEqual(listed.exclusions.providers, ["codex"]);

  const reset = await executeInsightsCommand(
    parseInsightsInvocation(["insights", "reset"]),
    { services },
  );
  assert.equal(formatInsightsCommandResult(reset), "Insights state reset.\n");

  const reindexed = await executeInsightsCommand(
    parseInsightsInvocation(["insights", "reindex"]),
    { services },
  );
  assert.match(formatInsightsCommandResult(reindexed), /Origin secret: preserved/u);
  assert.deepEqual(calls, [
    "status",
    "add:provider:codex",
    "hide:codex",
    "reindex:false",
    "list",
    "reset",
    "reindex:false",
  ]);
});

test("retries exclusion visibility and reconciliation after the config is already saved", async () => {
  const config = emptyConfig();
  config.insights.excludeProviders = ["codex"];
  const calls = [];
  let hideAttempts = 0;
  const services = {
    async updateExclusion() {
      calls.push("update");
      return { changed: false, config: structuredClone(config) };
    },
    async hideExclusions() {
      hideAttempts += 1;
      calls.push(`hide:${hideAttempts}`);
      if (hideAttempts === 1) throw new Error("injected partial visibility failure");
      return {
        format: "threadshare-insights-exclusion-visibility@v1",
        scanned: 2,
        hidden: 1,
      };
    },
    async shouldReconcile() {
      calls.push("should-reconcile");
      return true;
    },
    async reindex({ regenerateSecret }) {
      calls.push(`reindex:${regenerateSecret}`);
      return { format: "threadshare-insights-reindex@v1" };
    },
  };
  const invocation = parseInsightsInvocation([
    "insights", "exclude", "add", "provider", "codex",
  ]);

  await assert.rejects(executeInsightsCommand(invocation, { services }), {
    message: "injected partial visibility failure",
  });
  const retried = await executeInsightsCommand(invocation, { services });

  assert.equal(retried.changed, false);
  assert.equal(retried.visibility.hidden, 1);
  assert.equal(retried.reconciliation.format, "threadshare-insights-reindex@v1");
  assert.deepEqual(calls, [
    "update",
    "hide:1",
    "update",
    "hide:2",
    "should-reconcile",
    "reindex:false",
  ]);
});

test("the required Engine contract binds the current Fact identity versions", () => {
  const epoch = "11111111-1111-4111-8111-111111111111";
  assert.deepEqual(insightsRequiredContract(epoch), {
    factSchemaVersion: 1,
    providerAdapterVersions: ["claude@1", "codex@1"],
    privacyPolicyVersion: 1,
    originSecretEpoch: epoch,
    duplicatePolicyVersion: 1,
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: ["turn-search@2", "turn-summary@1"],
    analyzerCapabilities: ["mixed-cjk-code@1"],
    rankerVersion: 1,
  });
});

test("purge maintenance treats protocol decimal zero as idle", () => {
  assert.equal(insightsPurgeWorkPending({ pendingFacts: "0", pendingMaintenance: "0" }), false);
  assert.equal(insightsPurgeWorkPending({ pendingFacts: "1", pendingMaintenance: "0" }), true);
  assert.equal(insightsPurgeWorkPending({ pendingFacts: "0", pendingMaintenance: "2" }), true);
});

test("background worker watches both provider roots and reconciles on changes", async () => {
  const roots = [];
  const listeners = [];
  const reasons = [];
  const providerHome = path.join(os.tmpdir(), "threadshare-worker-providers");
  const worker = createInsightsBackgroundWorker({
    discoveryOptions: {
      environment: {
        HOME: providerHome,
        CODEX_HOME: path.join(providerHome, "codex-home"),
      },
    },
    async reconcile({ reasons: cycleReasons }) {
      reasons.push(cycleReasons);
      return { report: { committed: 1 } };
    },
    workerOptions: {
      debounceMs: 1,
      pollIntervalMs: 60_000,
      watchFactory(root, watchOptions, listener) {
        roots.push(root);
        listeners.push(listener);
        assert.equal(watchOptions.recursive, true);
        return { close() {}, on() {} };
      },
    },
  });

  worker.start();
  await worker.whenIdle();
  assert.deepEqual(roots, [
    path.join(providerHome, "codex-home", "sessions"),
    path.join(providerHome, ".claude", "projects"),
  ]);
  const pendingSessionId = "11111111-1111-4111-8111-111111111111";
  listeners[0]("change", `rollout-2026-08-10T00-00-00-${pendingSessionId}.jsonl`);
  assert.deepEqual(worker.status().pendingSessions, [
    { provider: "codex", sessionId: pendingSessionId },
  ]);
  assert.equal(worker.status().stale, true);
  await worker.whenIdle();
  assert.deepEqual(reasons, [["startup"], ["filesystem"]]);
  assert.equal(worker.status().pendingSessionCount, 0);
  assert.equal(worker.status().stale, false);
  await worker.stop();
});

test("real sidecar reindex atomically replaces an empty snapshot and preserves its secret", {
  timeout: 30_000,
  skip: existsSync(engine) ? false : "requires a debug Insights Engine build",
}, async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-reindex-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDirectory = path.join(directory, "state");
  const configFile = path.join(directory, "config.json");
  const providerHome = path.join(directory, "providers");
  const value = {
    stateDirectory,
    configFile,
    databaseFile: path.join(stateDirectory, "insights.sqlite3"),
    originSecretFile: path.join(stateDirectory, "origin-secret.json"),
    lockFile: path.join(stateDirectory, "insights.lock"),
    tempDirectory: path.join(stateDirectory, "tmp"),
  };
  const options = {
    paths: value,
    discoveryOptions: {
      environment: {
        HOME: providerHome,
        CODEX_HOME: path.join(providerHome, "codex"),
      },
    },
    runtimeOptions: {
      env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: engine },
    },
    reindexOptions: { availableBytes: 1024n * 1024n * 1024n },
    timeoutMs: 5_000,
  };

  const first = await reconcileInsights(options);
  const secret = await readFile(value.originSecretFile);
  const second = await reconcileInsights(options);
  assert.equal(first.report.failed, 0);
  assert.equal(second.report.failed, 0);
  assert.equal(first.purge.batches, 0);
  assert.equal(second.purge.batches, 0);
  assert.deepEqual(await readFile(value.originSecretFile), secret);
  assert.equal(await readFile(value.databaseFile).then((bytes) => bytes.length > 0), true);

  const activeDatabase = await readFile(value.databaseFile);
  const sessionDirectory = path.join(providerHome, "codex", "sessions", "2026", "08", "10");
  const sessionFile = path.join(
    sessionDirectory,
    "rollout-2026-08-10T00-00-00-11111111-1111-4111-8111-111111111111.jsonl",
  );
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(sessionFile, "{}\n");
  await assert.rejects(
    reconcileInsights({
      ...options,
      async statSource(file) {
        assert.equal(file, sessionFile);
        throw Object.assign(new Error("injected source stat failure"), { code: "EACCES" });
      },
    }),
    (error) => {
      assert.equal(error.code, "TS_INSIGHTS_REINDEX_INCOMPLETE");
      assert.equal(Object.keys(error).includes("failureSummary"), false);
      assert.deepEqual(error.failureSummary, {
        planned: 1,
        committed: 0,
        excluded: 0,
        failed: 1,
        diagnostics: [{
          provider: "codex",
          code: "source-stat-failed",
          errorCode: "EACCES",
          count: 1,
        }],
      });
      return true;
    },
  );
  assert.deepEqual(await readFile(value.databaseFile), activeDatabase);
  assert.deepEqual(await readFile(value.originSecretFile), secret);
});

test("real sidecar reindex reports unique committed sources across source-change retries", {
  timeout: 30_000,
  skip: INSIGHTS_E2E_SKIP,
}, async (t) => {
  const fixture = await createInsightsE2EFixture(
    t,
    "88888888-8888-4888-8888-888888888888",
  );
  const secondSessionId = "88888888-8888-4888-8888-999999999999";
  const secondSessionFile = path.join(
    path.dirname(fixture.sessionFile),
    path.basename(fixture.sessionFile).replace(fixture.sessionId, secondSessionId),
  );
  await writeFile(
    secondSessionFile,
    (await readFile(fixture.sessionFile, "utf8")).replaceAll(fixture.sessionId, secondSessionId),
    { mode: 0o600 },
  );
  const reads = new Map();
  const result = await reconcileInsights({
    ...fixture.reconcileOptions,
    async readDelta(provider, file, options) {
      const delta = await readProviderSessionDelta(provider, file, options);
      const count = (reads.get(file) ?? 0) + 1;
      reads.set(file, count);
      if (file === fixture.sessionFile && count === 1) {
        await appendFile(file, `${JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-10T09:00:11.000Z",
          payload: { type: "token_count", info: {} },
        })}\n`);
      }
      return delta;
    },
  });

  assert.equal(reads.get(fixture.sessionFile), 2);
  assert.equal(reads.get(secondSessionFile), 1);
  assert.equal(result.report.planned, 2);
  assert.equal(result.report.committed, 2);
  assert.equal(result.report.unchanged, 0);
  assert.equal(result.report.failed, 0);
});

test("real sidecar reindex rejects source-set drift between retries", {
  timeout: 30_000,
  skip: INSIGHTS_E2E_SKIP,
}, async (t) => {
  const fixture = await createInsightsE2EFixture(
    t,
    "77777777-7777-4777-8777-777777777777",
  );
  let reads = 0;
  let stats = 0;
  await assert.rejects(
    reconcileInsights({
      ...fixture.reconcileOptions,
      async readDelta(provider, file, options) {
        const delta = await readProviderSessionDelta(provider, file, options);
        reads += 1;
        await appendFile(file, `${JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-10T09:00:11.000Z",
          payload: { type: "token_count", info: {} },
        })}\n`);
        return delta;
      },
      async statSource(file) {
        const metadata = await stat(file, { bigint: true });
        stats += 1;
        if (stats === 2) await rm(file);
        return metadata;
      },
    }),
    { code: "TS_INSIGHTS_REINDEX_INCOMPLETE" },
  );
  assert.equal(reads, 1);
  assert.equal(stats, 2);
});

test("real sidecar reindex does not retry mixed source-change and read failures", {
  timeout: 30_000,
  skip: INSIGHTS_E2E_SKIP,
}, async (t) => {
  const fixture = await createInsightsE2EFixture(
    t,
    "66666666-6666-4666-8666-666666666666",
  );
  const secondSessionId = "66666666-6666-4666-8666-777777777777";
  const secondSessionFile = path.join(
    path.dirname(fixture.sessionFile),
    path.basename(fixture.sessionFile).replace(fixture.sessionId, secondSessionId),
  );
  await writeFile(
    secondSessionFile,
    (await readFile(fixture.sessionFile, "utf8")).replaceAll(fixture.sessionId, secondSessionId),
    { mode: 0o600 },
  );
  const reads = new Map();
  await assert.rejects(
    reconcileInsights({
      ...fixture.reconcileOptions,
      async readDelta(provider, file, options) {
        reads.set(file, (reads.get(file) ?? 0) + 1);
        if (file === secondSessionFile) {
          throw Object.assign(new Error("injected read failure"), { code: "EACCES" });
        }
        const delta = await readProviderSessionDelta(provider, file, options);
        await appendFile(file, `${JSON.stringify({
          type: "event_msg",
          timestamp: "2026-08-10T09:00:11.000Z",
          payload: { type: "token_count", info: {} },
        })}\n`);
        return delta;
      },
    }),
    (error) => {
      assert.equal(error.code, "TS_INSIGHTS_REINDEX_INCOMPLETE");
      assert.equal(error.failureSummary.failed, 2);
      assert.deepEqual(
        error.failureSummary.diagnostics.map(({ errorCode }) => errorCode),
        ["EACCES", "TS_INSIGHTS_SOURCE_CHANGED"],
      );
      return true;
    },
  );
  assert.equal(reads.get(fixture.sessionFile), 1);
  assert.equal(reads.get(secondSessionFile), 1);
});

test("real sidecar reindex bounds repeated source-change retries", {
  timeout: 30_000,
  skip: INSIGHTS_E2E_SKIP,
}, async (t) => {
  const fixture = await createInsightsE2EFixture(
    t,
    "99999999-9999-4999-8999-999999999999",
  );
  let reads = 0;
  await assert.rejects(
    reconcileInsights({
      ...fixture.reconcileOptions,
      async readDelta(provider, file, options) {
        const delta = await readProviderSessionDelta(provider, file, options);
        reads += 1;
        await appendFile(file, `${JSON.stringify({
          type: "event_msg",
          timestamp: `2026-08-10T09:00:${String(11 + reads).padStart(2, "0")}.000Z`,
          payload: { type: "token_count", info: {} },
        })}\n`);
        return delta;
      },
    }),
    { code: "TS_INSIGHTS_REINDEX_INCOMPLETE" },
  );
  assert.equal(reads, 4);
});

test("background reconciliation finishes an installed reindex swap before indexing", {
  timeout: 60_000,
  skip: INSIGHTS_E2E_SKIP,
}, async (t) => {
  const fixture = await createInsightsE2EFixture(
    t,
    "77777777-8888-4999-8aaa-bbbbbbbbbbbb",
  );
  await reconcileInsights(fixture.reconcileOptions);
  const id = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const backup = path.join(fixture.paths.stateDirectory, ".reindex-backup.sqlite3");
  const manifest = path.join(fixture.paths.stateDirectory, ".reindex-swap.json");
  await writeFile(backup, "excluded source content", { mode: 0o600 });
  await writeFile(manifest, `${JSON.stringify({
    format: "threadshare-insights-reindex-swap@v1",
    id,
    regenerateSecret: false,
  })}\n`, { mode: 0o600 });

  let statusEngineClientCreations = 0;
  const result = await reconcileActiveInsights({
    ...fixture.reconcileOptions,
    lifecycleOptions: {
      createEngineClient() {
        statusEngineClientCreations += 1;
        throw new Error("background reconciliation must not run full integrity checks");
      },
    },
  });

  assert.equal(result.report.failed, 0);
  assert.equal(statusEngineClientCreations, 0);
  assert.equal(existsSync(backup), false);
  assert.equal(existsSync(manifest), false);
});

test("reconciliation reports a missing secret after completing swap recovery", {
  timeout: 60_000,
  skip: INSIGHTS_E2E_SKIP,
}, async (t) => {
  const fixture = await createInsightsE2EFixture(
    t,
    "55555555-6666-4777-8888-999999999999",
  );
  await reconcileInsights(fixture.reconcileOptions);
  const manifest = path.join(fixture.paths.stateDirectory, ".reindex-swap.json");
  await writeFile(manifest, `${JSON.stringify({
    format: "threadshare-insights-reindex-swap@v1",
    id: "cccccccc-dddd-4eee-8fff-000000000000",
    regenerateSecret: false,
  })}\n`, { mode: 0o600 });
  await rm(fixture.paths.originSecretFile);

  await assert.rejects(
    reconcileActiveInsights(fixture.reconcileOptions),
    { code: "TS_INSIGHTS_ORIGIN_SECRET_MISSING" },
  );
  assert.equal(existsSync(manifest), false);
});

test("exclusion updates recover a pre-install reindex swap before applying visibility", {
  timeout: 60_000,
  skip: INSIGHTS_E2E_SKIP,
}, async (t) => {
  const fixture = await createInsightsE2EFixture(
    t,
    "66666666-7777-4888-8999-aaaaaaaaaaaa",
  );
  await reconcileInsights(fixture.reconcileOptions);
  const id = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const backup = path.join(fixture.paths.stateDirectory, ".reindex-backup.sqlite3");
  const candidate = path.join(fixture.paths.stateDirectory, `.reindex-${id}.sqlite3`);
  const manifest = path.join(fixture.paths.stateDirectory, ".reindex-swap.json");
  await rename(fixture.paths.databaseFile, backup);
  await writeFile(candidate, "incomplete candidate", { mode: 0o600 });
  await writeFile(manifest, `${JSON.stringify({
    format: "threadshare-insights-reindex-swap@v1",
    id,
    regenerateSecret: false,
  })}\n`, { mode: 0o600 });

  let statusEngineClientCreations = 0;
  const result = await executeInsightsCommand(
    parseInsightsInvocation(["insights", "exclude", "add", "provider", "claude"]),
    {
      ...fixture.reconcileOptions,
      lifecycleOptions: {
        ...fixture.reconcileOptions.lifecycleOptions,
        createEngineClient() {
          statusEngineClientCreations += 1;
          throw new Error("exclusion updates must not run full integrity checks");
        },
      },
    },
  );

  assert.equal(statusEngineClientCreations, 0);
  assert.equal(result.visibility.scanned > 0, true);
  assert.equal(result.visibility.hidden, 0);
  assert.equal(result.reconciliation.report.failed, 0);
  assert.equal(existsSync(fixture.paths.databaseFile), true);
  assert.equal(existsSync(backup), false);
  assert.equal(existsSync(candidate), false);
  assert.equal(existsSync(manifest), false);
});

test("CLI status, exclusion config, and reset stay local and machine-readable", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-cli-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDirectory = path.join(directory, "private-state");
  const configFile = path.join(directory, "private-config.json");
  const environment = {
    ...process.env,
    THREADSHARE_INSIGHTS_HOME: stateDirectory,
    THREADSHARE_CONFIG: configFile,
  };
  const run = (...args) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: environment,
  });

  const status = run("insights", "status", "--format", "json");
  assert.equal(status.status, 0, status.stderr);
  assert.equal(status.stderr, "");
  assert.deepEqual(JSON.parse(status.stdout), {
    format: "threadshare-insights-status@v1",
    state: "empty",
    location: "platform-state-directory",
    bytes: "0",
    entries: 0,
    databasePresent: false,
    originSecretPresent: false,
    diagnostics: [],
  });
  assert.equal(status.stdout.includes(directory), false);

  const added = run(
    "insights", "exclude", "add", "provider", "codex", "--format", "json",
  );
  assert.equal(added.status, 0, added.stderr);
  assert.equal(JSON.parse(added.stdout).changed, true);
  const listed = run("insights", "exclude", "list", "--format", "json");
  assert.deepEqual(JSON.parse(listed.stdout).exclusions.providers, ["codex"]);
  const configBeforeReset = await readFile(configFile, "utf8");

  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(stateDirectory, "origin-secret.json"), "derived\n");
  const reset = run("insights", "reset", "--format", "json");
  assert.equal(reset.status, 0, reset.stderr);
  assert.deepEqual(JSON.parse(reset.stdout), {
    format: "threadshare-insights-reset@v1",
    reset: true,
  });
  assert.equal(await readFile(configFile, "utf8"), configBeforeReset);

  const removed = run(
    "insights", "exclude", "remove", "provider", "codex", "--format", "json",
  );
  assert.equal(removed.status, 0, removed.stderr);
  assert.equal(JSON.parse(removed.stdout).changed, true);
});

test("secret regeneration fails closed without a TTY and diagnostics hide paths", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-cli-errors-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configFile = path.join(directory, "sensitive-project-config.json");
  const environment = {
    ...process.env,
    THREADSHARE_INSIGHTS_HOME: path.join(directory, "sensitive-state"),
    THREADSHARE_CONFIG: configFile,
  };
  const regeneration = spawnSync(
    process.execPath,
    [cli, "insights", "reindex", "--regenerate-secret"],
    { encoding: "utf8", env: environment },
  );
  assert.equal(regeneration.status, 1);
  assert.equal(regeneration.stdout, "");
  assert.match(regeneration.stderr, /^threadshare: error TS_TTY_REQUIRED\n/u);
  assert.match(regeneration.stderr, /reindex --regenerate-secret/u);

  await mkdir(environment.THREADSHARE_INSIGHTS_HOME, { recursive: true });
  await writeFile(
    path.join(environment.THREADSHARE_INSIGHTS_HOME, "insights.sqlite3"),
    "incomplete derived state\n",
  );
  const missingSecretStatus = spawnSync(
    process.execPath,
    [cli, "insights", "status", "--format", "json"],
    { encoding: "utf8", env: environment },
  );
  assert.equal(missingSecretStatus.status, 0, missingSecretStatus.stderr);
  assert.deepEqual(
    JSON.parse(missingSecretStatus.stdout).diagnostics,
    ["TS_INSIGHTS_ORIGIN_SECRET_MISSING"],
  );
  const missingSecretReindex = spawnSync(
    process.execPath,
    [cli, "insights", "reindex"],
    { encoding: "utf8", env: environment },
  );
  assert.equal(missingSecretReindex.status, 1);
  assert.match(
    missingSecretReindex.stderr,
    /^threadshare: error TS_INSIGHTS_ORIGIN_SECRET_MISSING\n/u,
  );
  assert.equal(missingSecretReindex.stderr.includes(directory), false);

  await writeFile(configFile, "{invalid\n");
  const invalid = spawnSync(
    process.execPath,
    [cli, "insights", "exclude", "list"],
    { encoding: "utf8", env: environment },
  );
  assert.equal(invalid.status, 1);
  assert.equal(invalid.stdout, "");
  assert.match(invalid.stderr, /^threadshare: error TS_OPERATION_FAILED\n/u);
  assert.equal(invalid.stderr.includes(directory), false);
  assert.equal(invalid.stderr.includes("sensitive-project-config.json"), false);
});
