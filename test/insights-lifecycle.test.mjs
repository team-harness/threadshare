import assert from "node:assert/strict";
import { access, chmod, mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { inspectInsightsState, resetInsightsState } from "../src/insights-lifecycle.mjs";
import { resolveInsightsPaths } from "../src/insights-paths.mjs";
import { reconcileInsights } from "../src/insights-command.mjs";
import { updateInsightsExclusion } from "../src/insights-config.mjs";
import {
  createInsightsE2EFixture,
  INSIGHTS_E2E_SKIP,
  readInsightsDatabaseAudit,
} from "./helpers/insights-e2e.mjs";

const ENGINE_NAME = process.platform === "win32"
  ? "threadshare-insights-engine.exe"
  : "threadshare-insights-engine";
const ENGINE_PATH = fileURLToPath(
  new URL(`../crates/insights-engine/target/debug/${ENGINE_NAME}`, import.meta.url),
);

function engineStatus() {
  return Object.freeze({
    snapshotSeq: "7",
    snapshotAgeMs: "12",
    snapshotPending: false,
    factStorageProfile: "normalized-row-v1",
    projections: Object.freeze([]),
    changeLog: Object.freeze({
      rows: "0",
      payloadBytes: "0",
      maxRows: "1000000",
      maxPayloadBytes: "67108864",
      state: "within-cap",
    }),
    purge: Object.freeze({
      state: "idle",
      pendingFacts: "0",
      pendingMaintenance: "0",
      purged: "0",
    }),
    storage: Object.freeze({
      databaseBytes: "4096",
      walBytes: "0",
      walPressureAction: "none",
      recentDiagnostic: null,
    }),
    integrity: Object.freeze({ quickCheck: "ok", fts: "ok" }),
  });
}

async function lifecycleFixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-lifecycle-"));
  const paths = resolveInsightsPaths({
    platform: "linux",
    environment: {
      THREADSHARE_INSIGHTS_HOME: path.join(directory, "state"),
      THREADSHARE_CONFIG: path.join(directory, "config", "config.json"),
    },
  });
  return { directory, paths };
}

test("status is content-free and never creates a missing secret", async () => {
  const fixture = await lifecycleFixture();
  try {
    assert.deepEqual(await inspectInsightsState({ paths: fixture.paths }), {
      format: "threadshare-insights-status@v1",
      state: "empty",
      location: "platform-state-directory",
      bytes: "0",
      entries: 0,
      databasePresent: false,
      originSecretPresent: false,
      diagnostics: [],
    });
    await mkdir(fixture.paths.stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(fixture.paths.databaseFile, "private problem text", { mode: 0o600 });
    const status = await inspectInsightsState({ paths: fixture.paths });
    assert.equal(status.state, "origin-secret-missing");
    assert.deepEqual(status.diagnostics, ["TS_INSIGHTS_ORIGIN_SECRET_MISSING"]);
    assert.equal(JSON.stringify(status).includes("private problem text"), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("status starts the sidecar and publishes its content-free health snapshot", async () => {
  const fixture = await lifecycleFixture();
  try {
    await mkdir(fixture.paths.stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(fixture.paths.databaseFile, "database", { mode: 0o600 });
    await writeFile(fixture.paths.originSecretFile, "secret", { mode: 0o600 });
    const expectedEngine = engineStatus();
    let startedWith;
    let reads = 0;
    let closes = 0;
    const status = await inspectInsightsState({
      paths: fixture.paths,
      async createEngineClient(options) {
        startedWith = options;
        return {
          async readEngineStatus() {
            reads += 1;
            return expectedEngine;
          },
          async close() {
            closes += 1;
          },
        };
      },
    });

    assert.equal(startedWith.databasePath, fixture.paths.databaseFile);
    assert.equal(startedWith.requiredContract.factStorageProfile, "normalized-row-v2");
    assert.equal(reads, 1);
    assert.equal(closes, 1);
    assert.equal(status.state, "ready");
    assert.equal(status.engine, expectedEngine);
    assert.deepEqual(status.diagnostics, []);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("status never calls an unverified database ready when Engine validation is skipped", async () => {
  const fixture = await lifecycleFixture();
  try {
    await mkdir(fixture.paths.stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(fixture.paths.databaseFile, "private database bytes", { mode: 0o600 });
    await writeFile(fixture.paths.originSecretFile, "secret", { mode: 0o600 });
    const status = await inspectInsightsState({
      paths: fixture.paths,
      includeEngineStatus: false,
      createEngineClient() {
        throw new Error("Engine validation must stay skipped");
      },
    });

    assert.equal(status.state, "engine-status-skipped");
    assert.deepEqual(status.diagnostics, ["TS_INSIGHTS_ENGINE_STATUS_SKIPPED"]);
    assert.equal(Object.hasOwn(status, "engine"), false);
    assert.equal(JSON.stringify(status).includes("private database bytes"), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("status reports an unfinished reindex swap without exposing its contents", async () => {
  const fixture = await lifecycleFixture();
  try {
    await mkdir(fixture.paths.stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(fixture.paths.databaseFile, "database", { mode: 0o600 });
    await writeFile(fixture.paths.originSecretFile, "secret", { mode: 0o600 });
    await writeFile(
      path.join(fixture.paths.stateDirectory, ".reindex-swap.json"),
      '{"private":"excluded source content"}\n',
      { mode: 0o600 },
    );
    const status = await inspectInsightsState({
      paths: fixture.paths,
      async createEngineClient() {
        return {
          async readEngineStatus() {
            return engineStatus();
          },
          async close() {},
        };
      },
    });

    assert.equal(status.state, "ready");
    assert.deepEqual(status.diagnostics, ["TS_INSIGHTS_REINDEX_RECOVERY_REQUIRED"]);
    assert.equal(JSON.stringify(status).includes("excluded source content"), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("status never reports a garbage database as ready", { timeout: 15_000 }, async () => {
  await access(ENGINE_PATH);
  const fixture = await lifecycleFixture();
  try {
    await mkdir(fixture.paths.stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(fixture.paths.databaseFile, "not a sqlite database", { mode: 0o600 });
    await writeFile(fixture.paths.originSecretFile, "secret", { mode: 0o600 });
    const status = await inspectInsightsState({
      paths: fixture.paths,
      runtimeOptions: {
        env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: ENGINE_PATH },
      },
      timeoutMs: 5_000,
    });

    assert.equal(status.state, "corrupt");
    assert.deepEqual(status.diagnostics, ["TS_INSIGHTS_STORAGE_CORRUPT"]);
    assert.equal(Object.hasOwn(status, "engine"), false);
    assert.equal(JSON.stringify(status).includes("not a sqlite database"), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("status diagnoses an openable FTS corruption without touching the raw session", {
  timeout: 60_000,
  skip: INSIGHTS_E2E_SKIP,
}, async (t) => {
  const fixture = await createInsightsE2EFixture(
    t,
    "99999999-8888-4777-8666-555555555555",
  );
  const indexed = await reconcileInsights(fixture.reconcileOptions);
  assert.equal(indexed.report.committed, 1);
  const rawSessionBefore = await readFile(fixture.sessionFile);

  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(fixture.paths.databaseFile);
  try {
    const segment = database.prepare(
      "SELECT id FROM turns_fts_data WHERE id > 10 ORDER BY id DESC LIMIT 1",
    ).get();
    assert.notEqual(segment, undefined);
    database.prepare("DELETE FROM turns_fts_data WHERE id=?").run(segment.id);
  } finally {
    database.close();
  }

  const status = await inspectInsightsState({
    paths: fixture.paths,
    runtimeOptions: fixture.reconcileOptions.runtimeOptions,
    timeoutMs: fixture.reconcileOptions.timeoutMs,
  });
  assert.equal(status.state, "corrupt");
  assert.deepEqual(status.diagnostics, ["TS_INSIGHTS_STORAGE_CORRUPT"]);
  assert.equal(Object.hasOwn(status, "engine"), false);
  assert.deepEqual(await readFile(fixture.sessionFile), rawSessionBefore);
});

test("reset removes only derived state and preserves persistent exclusions", async () => {
  const fixture = await lifecycleFixture();
  try {
    await mkdir(fixture.paths.tempDirectory, { recursive: true, mode: 0o700 });
    await mkdir(path.dirname(fixture.paths.configFile), { recursive: true, mode: 0o700 });
    await writeFile(fixture.paths.databaseFile, "database", { mode: 0o600 });
    await writeFile(`${fixture.paths.databaseFile}-wal`, "wal", { mode: 0o600 });
    await writeFile(fixture.paths.originSecretFile, "secret", { mode: 0o600 });
    await writeFile(path.join(fixture.paths.tempDirectory, "staging"), "pending", { mode: 0o600 });
    const unrelatedFile = path.join(fixture.paths.stateDirectory, "raw-session.jsonl");
    const unrelatedDirectory = path.join(fixture.paths.stateDirectory, "user-owned");
    await writeFile(unrelatedFile, "must survive reset\n", { mode: 0o600 });
    await mkdir(unrelatedDirectory, { mode: 0o700 });
    await writeFile(path.join(unrelatedDirectory, "notes.txt"), "also survives\n", { mode: 0o600 });
    await writeFile(fixture.paths.configFile, '{"excluded":true}\n', { mode: 0o600 });
    let stopped = 0;
    const result = await resetInsightsState({
      paths: fixture.paths,
      stopEngine() {
        stopped += 1;
      },
    });
    assert.deepEqual(result, { format: "threadshare-insights-reset@v1", reset: true });
    assert.equal(stopped, 1);
    assert.equal((await inspectInsightsState({ paths: fixture.paths })).state, "empty");
    assert.equal(await readFile(fixture.paths.configFile, "utf8"), '{"excluded":true}\n');
    assert.equal(await readFile(unrelatedFile, "utf8"), "must survive reset\n");
    assert.equal(
      await readFile(path.join(unrelatedDirectory, "notes.txt"), "utf8"),
      "also survives\n",
    );
    assert.deepEqual(await resetInsightsState({ paths: fixture.paths }), {
      format: "threadshare-insights-reset@v1",
      reset: false,
    });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("reset rotates derived identity while retained exclusions prevent source access on reconcile", {
  timeout: 60_000,
  skip: INSIGHTS_E2E_SKIP || (process.platform === "win32"
    ? "requires POSIX unreadable-file enforcement"
    : false),
}, async (t) => {
  const fixture = await createInsightsE2EFixture(
    t,
    "22222222-3333-4444-8555-666666666666",
  );
  const first = await reconcileInsights(fixture.reconcileOptions);
  const firstAudit = await readInsightsDatabaseAudit(fixture.paths.databaseFile);
  const firstSecret = JSON.parse(await readFile(fixture.paths.originSecretFile, "utf8"));
  assert.equal(first.report.committed, 1);
  assert.equal(firstAudit.facts.sessions, 1);
  assert.equal(firstAudit.fts.documents > 0, true);
  assert.equal(firstAudit.projections.rollupRows > 0, true);

  const exclusion = await updateInsightsExclusion({
    operation: "add",
    kind: "session",
    value: fixture.sessionId,
  }, { paths: fixture.paths });
  assert.equal(exclusion.changed, true);
  const configBeforeReset = await readFile(fixture.paths.configFile);
  const reset = await resetInsightsState({ paths: fixture.paths });
  assert.deepEqual(reset, { format: "threadshare-insights-reset@v1", reset: true });
  assert.deepEqual(await readFile(fixture.paths.configFile), configBeforeReset);
  assert.equal((await inspectInsightsState({ paths: fixture.paths })).state, "empty");

  await chmod(fixture.sessionFile, 0o000);
  try {
    const reconciled = await reconcileInsights(fixture.reconcileOptions);
    const audit = await readInsightsDatabaseAudit(fixture.paths.databaseFile);
    const secretAfterReset = JSON.parse(await readFile(fixture.paths.originSecretFile, "utf8"));
    const status = await inspectInsightsState({
      paths: fixture.paths,
      runtimeOptions: fixture.reconcileOptions.runtimeOptions,
      timeoutMs: fixture.reconcileOptions.timeoutMs,
    });

    assert.equal(reconciled.report.planned, 1);
    assert.equal(reconciled.report.excluded, 1);
    assert.equal(reconciled.report.committed, 0);
    assert.equal(reconciled.report.failed, 0);
    assert.deepEqual(reconciled.report.diagnostics, []);
    assert.notEqual(secretAfterReset.originSecretEpoch, firstSecret.originSecretEpoch);
    assert.deepEqual(audit.facts, { sessions: 0, turns: 0, events: 0, uses: 0 });
    assert.equal(audit.fts.documents, 0);
    assert.equal(audit.fts.naturalDocuments, 0);
    assert.equal(audit.fts.firstNaturalTermMatches, 0);
    assert.equal(audit.projections.rollupRows, 0);
    assert.equal(audit.projections.retryRows, 0);
    assert.equal(audit.integrity, "ok");
    assert.equal(status.state, "ready");
    assert.equal(status.engine.purge.state, "idle");
  } finally {
    await chmod(fixture.sessionFile, 0o600);
  }
});

test("reset refuses broad or config-containing targets", async () => {
  const fixture = await lifecycleFixture();
  try {
    await assert.rejects(
      resetInsightsState({
        paths: { ...fixture.paths, stateDirectory: path.parse(fixture.directory).root },
      }),
      (error) => error?.code === "TS_INSIGHTS_RESET_TARGET_UNSAFE",
    );
    await mkdir(fixture.paths.stateDirectory, { recursive: true, mode: 0o700 });
    await assert.rejects(
      resetInsightsState({
        paths: {
          ...fixture.paths,
          configFile: path.join(fixture.paths.stateDirectory, "config.json"),
        },
      }),
      (error) => error?.code === "TS_INSIGHTS_CONFIG_INSIDE_STATE",
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});
