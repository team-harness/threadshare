import assert from "node:assert/strict";
import { createServer as createHttpServer, request } from "node:http";
import { access, chmod, mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { createServer as createNetServer } from "node:net";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { createInsightsDashboardServer } from "../src/insights-dashboard-server.mjs";

async function requestWithHost(url, host) {
  const target = new URL(url);
  return new Promise((resolve, reject) => {
    const incoming = request({
      hostname: target.hostname,
      port: target.port,
      path: target.pathname,
      method: "GET",
      headers: { Host: host },
    }, (response) => {
      const chunks = [];
      response.on("data", (chunk) => chunks.push(chunk));
      response.on("end", () => resolve({
        status: response.statusCode,
        headers: response.headers,
        body: Buffer.concat(chunks).toString("utf8"),
      }));
    });
    incoming.once("error", reject);
    incoming.end();
  });
}

async function dashboardFixture(t, options = {}) {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-dashboard-server-"));
  const tempDirectory = path.join(root, "state", "tmp");
  const assetsDirectory = path.join(root, "assets");
  await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
  await mkdir(assetsDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(assetsDirectory, "index.html"), "<!doctype html><title>Insights</title>"),
    writeFile(path.join(assetsDirectory, "app.js"), "export {};\n"),
    writeFile(path.join(assetsDirectory, "state.js"), "export {};\n"),
    writeFile(path.join(assetsDirectory, "styles.css"), "body { color: CanvasText; }\n"),
  ]);
  await chmod(tempDirectory, 0o700);
  let openedFile = null;
  const api = {
    status: async () => ({ format: "status@v1", state: "ready" }),
    capabilities: async (input) => ({ snapshotSeq: "1", input, items: [], nextCursor: null }),
    historyProjects: async () => ({
      format: "threadshare-insights-dashboard-projects@v1",
      items: [{
        projectKey: "b".repeat(64),
        repositoryKey: "a".repeat(64),
        provider: "codex",
        label: "threadshare",
      }],
    }),
    search: async (input) => ({ query: input.query, results: [] }),
    evidence: async (input) => ({ turnKey: input.turnKey, entries: [] }),
    inspectorRepositories: async () => ({
      format: "threadshare-insights-dashboard-repositories@v1",
      items: [{ repositoryKey: "a".repeat(64), label: "threadshare" }],
    }),
    experienceRepositories: async () => ({
      format: "threadshare-insights-dashboard-repositories@v1",
      items: [{ repositoryKey: "a".repeat(64), label: "threadshare" }],
    }),
    experienceAssets: async (input) => ({
      format: "threadshare-insights-dashboard-memory-assets@v1",
      repository: { repositoryKey: input.repositoryKey, label: "threadshare" },
      initialized: true,
      assets: [],
      counts: { entries: "1", scenes: "0", doctrine: "0", skills: "0" },
      diagnostics: [],
      truncated: false,
    }),
    inspectorEdges: async (input) => ({
      format: "threadshare-insights-query@v2",
      repositoryKey: input.repositoryKey,
      records: [],
    }),
    conversationSessions: async (input) => ({
      format: "conversation-sessions@v1",
      input,
    }),
    conversationMessages: async (input) => ({
      format: "conversation-messages@v1",
      input,
    }),
    inspectorTrace: async (input) => ({ format: "trace@v1", root: input.root }),
    inspectorEvidence: async (input) => ({ format: "evidence@v2", target: input.target }),
    inspectorSessionTimeline: async (input) => ({ format: "timeline@v1", window: input.window }),
    inspectorGitDiff: async (input) => ({ format: "diff@v1", path: input.path }),
    inspectorContinuation: async (input) => ({ format: "continuation@v1", focus: input.trace.root }),
  };
  const server = await createInsightsDashboardServer({
    ...options,
    api,
    assetsDirectory,
    paths: { tempDirectory },
    openBrowser(file) { openedFile = file; },
  });
  t.after(async () => {
    await server.close();
    await rm(root, { recursive: true, force: true });
  });
  return { server, openedFile };
}

test("Dashboard bootstrap is one-time, file-backed, and loopback Host bound", async (t) => {
  const { server, openedFile } = await dashboardFixture(t);
  assert.equal(server.url.includes("?"), false);
  assert.equal(server.url.includes("#"), false);
  assert.equal(openedFile, server.bootstrapFile);
  assert.equal((await stat(openedFile)).mode & 0o777, 0o600);
  const document = await readFile(openedFile, "utf8");
  const secret = document.match(/name="secret" value="([^"]+)"/u)?.[1];
  assert.equal(typeof secret, "string");
  assert.equal(server.url.includes(secret), false);
  assert.equal(openedFile.includes(secret), false);

  const authority = new URL(server.url).host;
  const maliciousHost = await requestWithHost(server.url, "attacker.invalid");
  assert.equal(maliciousHost.status, 421);
  assert.equal(maliciousHost.headers["access-control-allow-origin"], undefined);

  const unauthorized = await fetch(server.url);
  assert.equal(unauthorized.status, 401);

  const wrongOrigin = await fetch(server.url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: `http://${authority}`,
    },
    body: new URLSearchParams({ secret }),
  });
  assert.equal(wrongOrigin.status, 403);

  const bootstrap = await fetch(server.url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "null",
    },
    body: new URLSearchParams({ secret }),
  });
  assert.equal(bootstrap.status, 200);
  assert.match(await bootstrap.text(), /<title>Insights<\/title>/u);
  assert.equal(bootstrap.headers.get("location"), null);
  const cookie = bootstrap.headers.get("set-cookie");
  assert.match(cookie, /^threadshare_insights_session=[A-Za-z0-9_-]+; HttpOnly; SameSite=Strict; Path=\/$/u);
  await assert.rejects(access(openedFile), { code: "ENOENT" });

  const repeat = await fetch(server.url, {
    method: "POST",
    redirect: "manual",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Origin: "null",
    },
    body: new URLSearchParams({ secret }),
  });
  assert.equal(repeat.status, 401);
});

test("Dashboard keeps a content-free runtime listener after successful bind", async (t) => {
  let rawServer;
  let runtimeError;
  const { server } = await dashboardFixture(t, {
    createHttpServer(handler) {
      rawServer = createHttpServer(handler);
      return rawServer;
    },
    onRuntimeError(value) {
      runtimeError = value;
    },
  });

  rawServer.emit("error", new Error("private runtime socket detail"));
  assert.deepEqual(runtimeError, { code: "TS_INSIGHTS_DASHBOARD_RUNTIME_FAILED" });
  assert.equal((await fetch(server.url)).status, 401);
  assert.equal(JSON.stringify(runtimeError).includes("private runtime socket detail"), false);
});

test("Dashboard session enforces CSP, same-origin writes, and no CORS", async (t) => {
  const { server, openedFile } = await dashboardFixture(t);
  const document = await readFile(openedFile, "utf8");
  const secret = document.match(/name="secret" value="([^"]+)"/u)?.[1];
  const bootstrap = await fetch(server.url, {
    method: "POST",
    redirect: "manual",
    headers: { "Content-Type": "application/x-www-form-urlencoded", Origin: "null" },
    body: new URLSearchParams({ secret }),
  });
  const cookie = bootstrap.headers.get("set-cookie").split(";", 1)[0];
  const page = await fetch(server.url, { headers: { Cookie: cookie } });
  assert.equal(page.status, 200);
  assert.match(page.headers.get("content-security-policy"), /default-src 'self'/u);
  assert.equal(page.headers.get("referrer-policy"), "no-referrer");
  assert.equal(page.headers.get("access-control-allow-origin"), null);

  const status = await fetch(new URL("/api/v1/status", server.url), {
    headers: { Cookie: cookie },
  });
  assert.deepEqual(await status.json(), { format: "status@v1", state: "ready" });

  const historyProjects = await fetch(new URL("/api/v1/history/projects", server.url), {
    headers: { Cookie: cookie },
  });
  assert.equal(historyProjects.status, 200);
  assert.deepEqual(await historyProjects.json(), {
    format: "threadshare-insights-dashboard-projects@v1",
    items: [{
      projectKey: "b".repeat(64),
      repositoryKey: "a".repeat(64),
      provider: "codex",
      label: "threadshare",
    }],
  });
  const invalidHistoryProjects = await fetch(new URL(
    "/api/v1/history/projects?extra=1",
    server.url,
  ), { headers: { Cookie: cookie } });
  assert.equal(invalidHistoryProjects.status, 400);

  const repositories = await fetch(new URL("/api/v1/inspector/repositories", server.url), {
    headers: { Cookie: cookie },
  });
  assert.deepEqual(await repositories.json(), {
    format: "threadshare-insights-dashboard-repositories@v1",
    items: [{ repositoryKey: "a".repeat(64), label: "threadshare" }],
  });

  const experienceRepositories = await fetch(new URL("/api/v1/experience/repositories", server.url), {
    headers: { Cookie: cookie },
  });
  assert.deepEqual(await experienceRepositories.json(), {
    format: "threadshare-insights-dashboard-repositories@v1",
    items: [{ repositoryKey: "a".repeat(64), label: "threadshare" }],
  });
  const experienceAssets = await fetch(new URL(
    `/api/v1/experience/assets?repositoryKey=${"a".repeat(64)}`,
    server.url,
  ), { headers: { Cookie: cookie } });
  assert.deepEqual((await experienceAssets.json()).counts, {
    entries: "1", scenes: "0", doctrine: "0", skills: "0",
  });
  const invalidExperience = await fetch(new URL(
    `/api/v1/experience/assets?repositoryKey=${"a".repeat(64)}&extra=1`,
    server.url,
  ), { headers: { Cookie: cookie } });
  assert.equal(invalidExperience.status, 400);
  assert.deepEqual(await invalidExperience.json(), {
    error: { code: "TS_INSIGHTS_DASHBOARD_REQUEST_INVALID" },
  });

  const edgeRequest = {
    repositoryKey: "a".repeat(64), after: null, before: null, cursor: null, limit: 25,
  };
  const edgeResponse = await fetch(new URL("/api/v1/inspector/edges", server.url), {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: server.url.slice(0, -1),
    },
    body: JSON.stringify(edgeRequest),
  });
  assert.deepEqual(await edgeResponse.json(), {
    format: "threadshare-insights-query@v2",
    repositoryKey: edgeRequest.repositoryKey,
    records: [],
  });

  for (const [route, body, format] of [
    ["conversations", {
      after: null, before: null, provider: null, projectKey: null, query: "release",
      toolCapabilityKey: null, skillCapabilityKey: null, completeness: null,
      cursor: null, limit: 30,
    }, "conversation-sessions@v1"],
    ["conversation-messages", {
      sessionKey: "b".repeat(64), cursor: null, limit: 20,
    }, "conversation-messages@v1"],
  ]) {
    const result = await fetch(new URL(`/api/v1/${route}`, server.url), {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Origin: server.url.slice(0, -1),
      },
      body: JSON.stringify(body),
    });
    assert.equal(result.status, 200);
    assert.deepEqual(await result.json(), { format, input: body });
  }

  const inspectorRequests = [
    ["trace", { root: { kind: "git-commit", key: "b".repeat(64) } }, { format: "trace@v1", root: { kind: "git-commit", key: "b".repeat(64) } }],
    ["evidence", { target: { kind: "turn", key: "c".repeat(64) } }, { format: "evidence@v2", target: { kind: "turn", key: "c".repeat(64) } }],
    ["session-timeline", { window: { after: "2026-08-01T00:00:00.000Z" } }, { format: "timeline@v1", window: { after: "2026-08-01T00:00:00.000Z" } }],
    ["git-diff", { path: "src/app.js" }, { format: "diff@v1", path: "src/app.js" }],
    ["continuation", { trace: { root: { kind: "intent", key: "d".repeat(64) } } }, { format: "continuation@v1", focus: { kind: "intent", key: "d".repeat(64) } }],
  ];
  for (const [route, body, expected] of inspectorRequests) {
    const result = await fetch(new URL(`/api/v1/inspector/${route}`, server.url), {
      method: "POST",
      headers: {
        Cookie: cookie,
        "Content-Type": "application/json",
        Origin: server.url.slice(0, -1),
      },
      body: JSON.stringify(body),
    });
    assert.deepEqual(await result.json(), expected);
  }

  const rejected = await fetch(new URL("/api/v1/search", server.url), {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: "https://attacker.invalid",
    },
    body: JSON.stringify({ query: "needle" }),
  });
  assert.equal(rejected.status, 403);
  assert.deepEqual(await rejected.json(), { error: { code: "TS_INSIGHTS_DASHBOARD_ORIGIN_REJECTED" } });

  const accepted = await fetch(new URL("/api/v1/search", server.url), {
    method: "POST",
    headers: {
      Cookie: cookie,
      "Content-Type": "application/json",
      Origin: server.url.slice(0, -1),
    },
    body: JSON.stringify({ query: "needle" }),
  });
  assert.deepEqual(await accepted.json(), { query: "needle", results: [] });

  const preflight = await fetch(new URL("/api/v1/search", server.url), {
    method: "OPTIONS",
    headers: { Origin: "https://attacker.invalid" },
  });
  assert.equal(preflight.status, 405);
  assert.equal(preflight.headers.get("access-control-allow-origin"), null);
});

test("Dashboard reports a stable diagnostic when its requested loopback port is occupied", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-dashboard-port-"));
  const tempDirectory = path.join(root, "state", "tmp");
  const assetsDirectory = path.join(root, "assets");
  const blocker = createNetServer();
  await mkdir(tempDirectory, { recursive: true, mode: 0o700 });
  await mkdir(assetsDirectory, { recursive: true });
  await Promise.all([
    writeFile(path.join(assetsDirectory, "index.html"), "<!doctype html><title>Insights</title>"),
    writeFile(path.join(assetsDirectory, "app.js"), "export {};\n"),
    writeFile(path.join(assetsDirectory, "state.js"), "export {};\n"),
    writeFile(path.join(assetsDirectory, "styles.css"), "body {}\n"),
  ]);
  await new Promise((resolve, reject) => {
    blocker.once("error", reject);
    blocker.listen({ host: "127.0.0.1", port: 0 }, resolve);
  });
  try {
    const address = blocker.address();
    assert.notEqual(address, null);
    await assert.rejects(createInsightsDashboardServer({
      api: {},
      assetsDirectory,
      paths: { tempDirectory },
      port: address.port,
      openBrowser() {},
    }), { code: "TS_INSIGHTS_DASHBOARD_PORT_UNAVAILABLE" });
  } finally {
    await new Promise((resolve) => blocker.close(resolve));
    await rm(root, { recursive: true, force: true });
  }
});
