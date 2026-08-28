import assert from "node:assert/strict";
import { appendFile, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createCommittedInsightsReader,
  launchInsightsDashboard,
  readDashboardMemoryAssets,
} from "../src/insights-dashboard.mjs";

test("committed reader reuses one Engine and reopens after database replacement", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-dashboard-reader-"));
  const databaseFile = path.join(root, "insights.sqlite3");
  await writeFile(databaseFile, "v1");
  const clients = [];
  const createOptions = [];
  const reader = createCommittedInsightsReader({
    paths: { databaseFile, stateDirectory: root, tempDirectory: path.join(root, "tmp") },
    originSecretEpoch: "11111111-2222-4333-8444-555555555555",
    async createEngineClient(options) {
      createOptions.push(options);
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
  assert.equal(createOptions[0].openExisting, true);
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

test("Dashboard reads only reviewed Git-visible Team Memory assets", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-dashboard-memory-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, ".threadshare", "memory", "entries"), { recursive: true });
  await mkdir(path.join(root, ".threadshare", "memory", "scenes"), { recursive: true });
  await mkdir(path.join(root, ".threadshare", "memory", "skills", "release-checks"), { recursive: true });
  await Promise.all([
    writeFile(path.join(root, ".threadshare", "memory", "entries", "release-checks.md"), [
      "---",
      "id: release-checks",
      "type: work_task",
      "status: approved",
      "priority: 90",
      "confidence: high",
      "provenance_strength: direct",
      "claim_support: human-confirmed",
      "limitations: [\"source-local-only\"]",
      "scope: repo",
      "scene: release-workflow",
      "occurred: []",
      "evidence: {\"commits\":[],\"paths\":[]}",
      "superseded_by: null",
      "---",
      "Run release checks before publishing.",
    ].join("\n")),
    writeFile(path.join(root, ".threadshare", "memory", "scenes", "release-workflow.md"), [
      "-----META-START-----",
      "created: 2026-08-27",
      "updated: 2026-08-27",
      "summary: \"Stable release workflow\"",
      "heat: 2",
      "-----META-END-----",
      "## Release workflow",
      "Use the pinned release path.",
    ].join("\n")),
    writeFile(path.join(root, ".threadshare", "memory", "skills", "release-checks", "SKILL.md"), [
      "---",
      "name: \"release-checks\"",
      "description: \"Run stable release checks.\"",
      "---",
      "## Procedure",
      "Run the verified release workflow.",
    ].join("\n")),
    writeFile(path.join(root, ".threadshare", "memory", "doctrine.md"), "# Team doctrine\n\nPrefer evidence-backed releases.\n"),
  ]);
  await symlink(
    path.join(root, ".threadshare", "memory", "doctrine.md"),
    path.join(root, ".threadshare", "memory", "entries", "linked.md"),
  );

  const result = await readDashboardMemoryAssets(root);
  assert.equal(result.initialized, true);
  assert.deepEqual(result.counts, { entries: "1", scenes: "1", doctrine: "1", skills: "1" });
  assert.deepEqual(result.assets.map((asset) => asset.kind), ["entry", "scene", "doctrine", "skill"]);
  assert.equal(result.assets[0].evidenceStrength, "direct");
  assert.deepEqual(result.assets[0].limitations, ["source-local-only"]);
  assert.equal(result.assets[1].heat, 2);
  assert.deepEqual(result.diagnostics, [{ code: "TS_MEMORY_ASSET_ENTRY_SKIPPED", count: 1 }]);
  assert.equal(JSON.stringify(result).includes(root), false);

  const empty = await readDashboardMemoryAssets(path.join(root, "not-initialized"));
  assert.equal(empty.initialized, false);
  assert.deepEqual(empty.assets, []);
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
  assert.equal(capturedStatus.engine.factStorageProfile, "normalized-row-v2");
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

test("Dashboard Inspector lists registered repositories and reads committed delivery edges", async () => {
  const repositoryKey = "a".repeat(64);
  const edgeKey = "b".repeat(64);
  const databaseUuid = "11111111-2222-4333-8444-555555555555";
  const capturedQueries = [];
  let capturedTrace;
  let resolveServerClosed;
  const serverClosed = new Promise((resolve) => { resolveServerClosed = resolve; });
  const state = {
    paths: { configFile: "/private/config.json" },
    originSecretEpoch: databaseUuid,
    privacyContext: {
      fingerprint(namespace) {
        return namespace === "repository" ? repositoryKey : "f".repeat(64);
      },
      projectFingerprint(provider, rootDirectory) {
        assert.equal(rootDirectory, "/private/work/threadshare");
        return provider === "codex" ? "1".repeat(64) : "2".repeat(64);
      },
    },
  };
  const coverage = {
    matching: {
      fullRecordCount: "1", summaryRecordCount: "0", unloadedRecordCount: "0",
      truncatedRecordCount: "0", unavailableRecordCount: "0", missingTimestampCount: "0",
      missingRevisionCount: "0", missingTokenMetricCount: "0", missingPayloadCount: "0",
    },
    indexedHistory: {
      visibleSessionCount: "1", excludedSessionCount: "0", subagentExcludedSessionCount: "0",
      unknownEligibilitySessionCount: "0", pendingPurgeSessionCount: "0", purgedSessionCount: "0",
      missingCoverageRollupSessionCount: "0",
      fts: {
        searchableEventCount: "1", storedNotSearchableEventCount: "0",
        searchablePayloadBytes: "1", storedNotSearchablePayloadBytes: "0",
      },
    },
    degraded: false,
    diagnostics: [],
  };
  const reader = {
    invalidate() {},
    async queryV2(request) {
      capturedQueries.push(request);
      const record = request.resource === "delivery-edge" ? {
        edgeKey,
        repositoryKey,
        fromKind: "git-commit",
        fromKey: "c".repeat(64),
        toKind: "file",
        toKey: "d".repeat(64),
        relation: "commit-changed-file",
        strength: "direct",
        source: "git-tree-diff",
        commitHash: "e".repeat(40),
        normalizedPath: "src/insights-dashboard/app.js",
        oldPath: null,
        changeKind: "M",
        additions: "3",
        deletions: "1",
        reachable: true,
        observedAt: "2026-08-16T03:00:00.000Z",
        revision: "e".repeat(64),
      } : request.resource === "session" ? {
        sessionKey: "f".repeat(64), provider: "codex", projectKey: repositoryKey,
        originScope: "main", completeness: "full", revision: "e".repeat(64),
        session: {
          startedAt: "2026-08-10T01:00:00.000Z",
          endedAt: "2026-08-10T02:00:00.000Z",
          title: "Review release failures",
          turnCount: "3",
        },
      } : {
        eventKey: "1".repeat(64), sessionKey: "f".repeat(64), turnKey: "2".repeat(64),
        provider: "codex", observedAt: "2026-08-10T01:00:00.000Z",
        completeness: "full", revision: "3".repeat(64), event: { kind: "visible-message" },
        message: { role: "user", content: { inline: "Review release failures", complete: true } },
      };
      return {
        format: "threadshare-insights-query@v2",
        databaseUuid,
        snapshotSeq: "9",
        resource: request.resource,
        records: [record],
        groups: null,
        nextCursor: null,
        totalMatchCount: "1",
        totalGroupCount: null,
        truncated: false,
        coverage,
        provenance: { default: "recorded", fields: [] },
        limits: { pageBytes: "3932160", payloadsMayRequireEvidencePaging: true },
      };
    },
    async deliveryTrace(request) {
      capturedTrace = request;
      return {
        format: "threadshare-insights-delivery-trace@v1",
        databaseUuid,
        snapshotSeq: "9",
        evaluatedAt: request.evaluatedAt,
        root: request.root,
        nodes: [{
          kind: "git-commit",
          key: request.root.key,
          revision: "e".repeat(64),
          attributes: {
            repositoryKey,
            objectId: "e".repeat(40),
            parentObjectIds: [],
            reachable: true,
          },
        }],
        edges: [],
        nextCursor: null,
        truncated: false,
        coverage: { degraded: false, diagnostics: [] },
      };
    },
    async close() {},
  };
  const dashboard = await launchInsightsDashboard({
    paths: {
      stateDirectory: "/private/insights",
      tempDirectory: "/private/insights/tmp",
      databaseFile: "/private/insights/insights.sqlite3",
    },
    async openState() { return state; },
    createReader() { return reader; },
    async readConfig() {
      return {
        insights: {
          repositories: [{
            repositoryId: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
            rootDirectory: "/private/work/threadshare",
          }],
        },
      };
    },
    async resolveRepository(repositoryPath) {
      assert.equal(repositoryPath, "/private/work/threadshare");
      return { rootDirectory: "/resolved/work/threadshare" };
    },
    async readMemoryAssets(rootDirectory) {
      assert.equal(rootDirectory, "/resolved/work/threadshare");
      return {
        format: "threadshare-insights-dashboard-memory-assets@v1",
        initialized: true,
        assets: [],
        counts: { entries: "1", scenes: "0", doctrine: "0", skills: "0" },
        diagnostics: [],
        truncated: false,
      };
    },
    async inspectState() {
      return { state: "ready", bytes: "10", entries: 1, databasePresent: true, diagnostics: [] };
    },
    async createServer({ api }) {
      assert.deepEqual(await api.inspectorRepositories(), {
        format: "threadshare-insights-dashboard-repositories@v1",
        items: [{ repositoryKey, label: "threadshare" }],
      });
      assert.deepEqual(await api.experienceRepositories(), {
        format: "threadshare-insights-dashboard-repositories@v1",
        items: [{ repositoryKey, label: "threadshare" }],
      });
      assert.deepEqual(await api.historyProjects(), {
        format: "threadshare-insights-dashboard-projects@v1",
        items: [
          { projectKey: "2".repeat(64), repositoryKey, provider: "claude", label: "threadshare" },
          { projectKey: "1".repeat(64), repositoryKey, provider: "codex", label: "threadshare" },
        ],
      });
      const memory = await api.experienceAssets({ repositoryKey });
      assert.equal(memory.repository.repositoryKey, repositoryKey);
      assert.equal(memory.repository.label, "threadshare");
      assert.equal(memory.counts.entries, "1");
      const edges = await api.inspectorEdges({
        repositoryKey,
        after: null,
        before: null,
        cursor: null,
        limit: 25,
      });
      assert.equal(edges.format, "threadshare-insights-query@v2");
      assert.equal(edges.records[0].edgeKey, edgeKey);
      const conversations = await api.conversationSessions({
        after: "2026-08-01T00:00:00.000Z",
        before: "2026-08-12T00:00:00.000Z",
        provider: "codex",
        projectKey: repositoryKey,
        query: "release failure",
        toolCapabilityKey: null,
        skillCapabilityKey: null,
        completeness: "full",
        cursor: null,
        limit: 30,
      });
      assert.equal(conversations.records[0].session.title, "Review release failures");
      const messages = await api.conversationMessages({
        sessionKey: "f".repeat(64), cursor: null, limit: 20,
      });
      assert.equal(messages.records[0].message.role, "user");
      const trace = await api.inspectorTrace({
        format: "threadshare-insights-recipe-request@v1",
        root: { kind: "git-commit", key: "c".repeat(64) },
        window: null,
        direction: "both",
        maxDepth: 2,
        includeCandidateEdges: false,
        includeContextualEdges: false,
        limit: 100,
        cursor: null,
      });
      assert.equal(trace.format, "threadshare-insights-delivery-trace@v1");
      assert.equal(trace.snapshotSeq, "9");
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
    now() { return 1_786_464_000_000; },
  });

  const edgeQuery = capturedQueries.find((request) => request.resource === "delivery-edge");
  const sessionQuery = capturedQueries.find((request) => request.resource === "session");
  const eventQuery = capturedQueries.find((request) => request.resource === "event");
  assert.deepEqual(edgeQuery.where, {
    field: "repositoryKey", op: "eq", value: repositoryKey,
  });
  assert.equal(sessionQuery.shape.select.includes("session.title"), true);
  assert.equal(sessionQuery.where.and.at(-1).field, "text");
  assert.deepEqual(eventQuery.where.and.map((item) => item.field), [
    "sessionKey", "originScope", "event.kind",
  ]);
  assert.equal(edgeQuery.evaluatedAt, "2026-08-11T16:00:00.000Z");
  assert.equal(capturedTrace.evaluatedAt, "2026-08-11T16:00:00.000Z");
  await dashboard.close();
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
