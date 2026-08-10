import assert from "node:assert/strict";
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCommittedInsightsReader,
  launchInsightsDashboard,
} from "../src/insights-dashboard.mjs";

test("committed reader reuses one Engine and reopens after database replacement", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-dashboard-reader-"));
  const databaseFile = path.join(root, "insights.sqlite3");
  await writeFile(databaseFile, "v1");
  const clients = [];
  const reader = createCommittedInsightsReader({
    paths: { databaseFile, stateDirectory: root, tempDirectory: path.join(root, "tmp") },
    originSecretEpoch: "11111111-2222-4333-8444-555555555555",
    async createEngineClient() {
      const number = clients.length + 1;
      const client = {
        number,
        closed: false,
        async readEngineStatus() { throw new Error("Dashboard status must not run full integrity checks"); },
        async readInsightsOverview() { return { snapshotSeq: String(number), sessions: { raw: "1" } }; },
        async readPurgeStatus() { return { state: "idle", pendingFacts: "0", pendingMaintenance: "0", purged: "0" }; },
        async searchTurns(input) { return { query: input.query, client: number }; },
        async readTurnEvidence(input) { return { turnKey: input.turnKey, client: number }; },
        async listCapabilities(input) { return { kind: input.kind, client: number }; },
        async close() { this.closed = true; },
      };
      clients.push(client);
      return client;
    },
  });
  t.after(async () => {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  });

  const first = await reader.readStatus({ overview: {}, options: {} });
  const repeated = await reader.readStatus({ overview: {}, options: {} });
  assert.equal(first.overview.snapshotSeq, "1");
  assert.equal(first.purge.state, "idle");
  assert.equal(repeated.overview.snapshotSeq, "1");
  assert.equal(clients.length, 1);
  assert.deepEqual(await reader.search({ query: "needle" }), { query: "needle", client: 1 });

  await appendFile(databaseFile, "-replacement");
  const replaced = await reader.readStatus({ overview: {}, options: {} });
  assert.equal(replaced.overview.snapshotSeq, "2");
  assert.equal(clients.length, 2);
  assert.equal(clients[0].closed, true);

  reader.invalidate();
  await reader.capabilities({ kind: "tool", cursor: null, limit: 10 });
  assert.equal(clients.length, 3);
  assert.equal(clients[1].closed, true);
});

test("Dashboard serves the committed snapshot before starting background reconciliation", async () => {
  const order = [];
  let resolveServerClosed;
  const serverClosed = new Promise((resolve) => { resolveServerClosed = resolve; });
  let capturedStatus;
  let capturedSearch;
  let runtimeErrorHandler;
  let readDashboardStatus;
  const fakeReader = {
    invalidate() { order.push("reader-invalidate"); },
    async readStatus() {
      order.push("read-committed");
      return {
        overview: { snapshotSeq: "8" },
        purge: { state: "idle", pendingFacts: "0", pendingMaintenance: "0", purged: "0" },
      };
    },
    async search(input) { capturedSearch = input; return { results: [] }; },
    async evidence() {},
    async capabilities() {},
    async close() { order.push("reader-close"); },
  };
  const worker = {
    start() { order.push("worker-start"); return true; },
    status() { return { started: true, running: true, queued: false, cycleCount: 0 }; },
    async stop() { order.push("worker-stop"); },
  };
  const dashboard = await launchInsightsDashboard({
    paths: {
      stateDirectory: "/private/insights",
      tempDirectory: "/private/insights/tmp",
      databaseFile: "/private/insights/insights.sqlite3",
    },
    async openState() {
      order.push("open-state");
      return { originSecretEpoch: "11111111-2222-4333-8444-555555555555" };
    },
    createReader() { order.push("create-reader"); return fakeReader; },
    async inspectState() {
      order.push("inspect-state");
      return {
        state: "ready", bytes: "10", entries: 1, databasePresent: true, diagnostics: [],
      };
    },
    async createServer({ api, onRuntimeError }) {
      order.push("create-server");
      runtimeErrorHandler = onRuntimeError;
      readDashboardStatus = api.status;
      capturedStatus = await api.status();
      await api.search({
        query: "needle",
        filters: {},
        limit: 12,
        pathLimit: 3,
        nowUnixMs: "1",
        quiescenceSeconds: 86_400,
        ignored: "client-controlled",
      });
      order.push("server-ready");
      return {
        url: "http://127.0.0.1:43123/",
        closed: serverClosed,
        async close() { order.push("server-close"); resolveServerClosed(); },
      };
    },
    createWorker() { order.push("create-worker"); return worker; },
    now() { return 1_786_320_000_000; },
  });

  assert.equal(capturedStatus.state, "ready");
  assert.equal(capturedStatus.overview.snapshotSeq, "8");
  assert.equal(capturedStatus.engine.snapshotSeq, "8");
  assert.equal(capturedStatus.engine.factStorageProfile, "normalized-row-v1");
  assert.equal(capturedStatus.index.location, "Platform state directory");
  assert.equal(JSON.stringify(capturedStatus).includes("/private/insights"), false);
  assert.equal(capturedStatus.worker, null);
  assert.deepEqual(capturedSearch, {
    query: "needle",
    filters: {},
    limit: 12,
    pathLimit: 3,
    nowUnixMs: "1786320000000",
    quiescenceSeconds: 300,
  });
  assert.ok(order.indexOf("read-committed") < order.indexOf("worker-start"));
  assert.deepEqual(order.slice(0, 7), [
    "open-state", "create-reader", "create-server", "inspect-state",
    "read-committed", "server-ready", "create-worker",
  ]);
  assert.equal(order[7], "worker-start");
  runtimeErrorHandler({ code: "TS_INSIGHTS_DASHBOARD_RUNTIME_FAILED", private: "socket detail" });
  const runtimeFailure = await readDashboardStatus();
  assert.deepEqual(runtimeFailure.recentError, { code: "TS_INSIGHTS_DASHBOARD_RUNTIME_FAILED" });
  assert.equal(JSON.stringify(runtimeFailure).includes("socket detail"), false);
  await dashboard.close();
  assert.ok(order.includes("worker-stop"));
  assert.ok(order.includes("reader-close"));
});

test("Dashboard reports committed Engine read failures instead of presenting stale readiness", async () => {
  let resolveServerClosed;
  const serverClosed = new Promise((resolve) => { resolveServerClosed = resolve; });
  let capturedStatus;
  const dashboard = await launchInsightsDashboard({
    paths: {
      stateDirectory: "/private/insights",
      tempDirectory: "/private/insights/tmp",
      databaseFile: "/private/insights/insights.sqlite3",
    },
    async openState() {
      return { originSecretEpoch: "11111111-2222-4333-8444-555555555555" };
    },
    createReader() {
      return {
        invalidate() {},
        async readStatus() {
          const error = new Error("private storage detail");
          error.code = "TS_INSIGHTS_ENGINE_UNAVAILABLE";
          throw error;
        },
        async close() {},
      };
    },
    async inspectState() {
      return {
        state: "ready", bytes: "10", entries: 1, databasePresent: true, diagnostics: [],
      };
    },
    async createServer({ api }) {
      capturedStatus = await api.status();
      return {
        url: "http://127.0.0.1:43123/",
        closed: serverClosed,
        async close() { resolveServerClosed(); },
      };
    },
    createWorker() {
      return {
        start() { return true; },
        status() { return { started: true, running: false, queued: false, cycleCount: 0 }; },
        async stop() {},
      };
    },
  });

  assert.equal(capturedStatus.state, "engine-unavailable");
  assert.deepEqual(capturedStatus.recentError, { code: "TS_INSIGHTS_ENGINE_UNAVAILABLE" });
  assert.equal(JSON.stringify(capturedStatus).includes("private storage detail"), false);
  await dashboard.close();
});
