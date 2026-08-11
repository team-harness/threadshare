import assert from "node:assert/strict";
import {
  appendFile, mkdir, mkdtemp, realpath, rm, symlink, unlink, writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  createInsightsQueryReader,
  openInsightsQueryReader,
} from "../src/insights-query-reader.mjs";

const ORIGIN_SECRET_EPOCH = "11111111-2222-4333-8444-555555555555";

function fakeClient(number, overrides = {}) {
  return {
    closed: false,
    async readInsightsOverview(input) { return { number, input }; },
    async listCapabilities(input) { return { number, input }; },
    async searchTurns(input) { return { number, input }; },
    async readCapabilityUsage(input) { return { number, input }; },
    async readInsightsActivity(input) { return { number, input }; },
    async readTurnEvidence(input) { return { number, input }; },
    async close() { this.closed = true; },
    ...overrides,
  };
}

test("query reader opens existing state and reopens after database replacement", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-query-reader-"));
  const databaseFile = path.join(root, "insights.sqlite3");
  await writeFile(databaseFile, "v1");
  const clients = [];
  const createOptions = [];
  const reader = await openInsightsQueryReader({
    async openState() {
      return {
        paths: { databaseFile, stateDirectory: root, tempDirectory: path.join(root, "tmp") },
        originSecretEpoch: ORIGIN_SECRET_EPOCH,
      };
    },
    async createEngineClient(options) {
      createOptions.push(options);
      const client = fakeClient(clients.length + 1);
      clients.push(client);
      return client;
    },
  });
  t.after(async () => {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal((await reader.overview({ nowUnixMs: "1" })).number, 1);
  assert.equal((await reader.search({ query: "needle" })).number, 1);
  assert.equal(createOptions[0].openExisting, true);
  assert.equal(createOptions[0].databasePath, path.join(await realpath(root), "insights.sqlite3"));

  await appendFile(databaseFile, "-replacement");
  assert.equal((await reader.capabilities({ kind: "tool" })).number, 2);
  assert.equal(clients[0].closed, true);
});

test("query reader discards a client after every fatal read boundary", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-query-reader-fatal-"));
  const databaseFile = path.join(root, "insights.sqlite3");
  await writeFile(databaseFile, "v1");
  const clients = [];
  const failure = Object.assign(new Error("private sidecar detail"), {
    code: "TS_INSIGHTS_ENGINE_TIMEOUT",
  });
  const reader = createInsightsQueryReader({
    paths: { databaseFile, stateDirectory: root, tempDirectory: path.join(root, "tmp") },
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    async createEngineClient() {
      const client = clients.length === 0
        ? fakeClient(1, { async searchTurns() { throw failure; } })
        : fakeClient(clients.length + 1);
      clients.push(client);
      return client;
    },
  });
  t.after(async () => {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(reader.search({ query: "needle" }), failure);
  assert.equal(clients[0].closed, true);
  assert.equal((await reader.activity({ bucket: "day" })).number, 2);
  assert.equal(clients.length, 2);
});

test("query reader closes an unadopted client when the database becomes a symlink", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-query-reader-race-"));
  const databaseFile = path.join(root, "insights.sqlite3");
  const target = path.join(root, "replacement.sqlite3");
  await writeFile(databaseFile, "v1");
  await writeFile(target, "private target");
  let client;
  const reader = createInsightsQueryReader({
    paths: { databaseFile, stateDirectory: root, tempDirectory: path.join(root, "tmp") },
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    async createEngineClient() {
      client = fakeClient(1);
      await unlink(databaseFile);
      await symlink(target, databaseFile);
      return client;
    },
  });
  t.after(async () => {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  });

  await assert.rejects(
    reader.overview({ nowUnixMs: "1" }),
    (error) => error?.code === "TS_INSIGHTS_STATE_INVALID",
  );
  assert.equal(client.closed, true);
});

test("query reader canonicalizes only parent symlinks for SQLite NOFOLLOW", {
  skip: process.platform === "win32" ? "directory symlink fixture requires elevated privileges" : false,
}, async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-query-reader-parent-link-"));
  const actual = path.join(root, "actual");
  const linked = path.join(root, "linked");
  await mkdir(actual);
  await symlink(actual, linked);
  const databaseFile = path.join(linked, "insights.sqlite3");
  await writeFile(path.join(actual, "insights.sqlite3"), "v1");
  let openedPath;
  const reader = createInsightsQueryReader({
    paths: { databaseFile, stateDirectory: linked, tempDirectory: path.join(linked, "tmp") },
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    async createEngineClient(options) {
      openedPath = options.databasePath;
      return fakeClient(1);
    },
  });
  t.after(async () => {
    await reader.close();
    await rm(root, { recursive: true, force: true });
  });

  assert.equal((await reader.overview({ nowUnixMs: "1" })).number, 1);
  assert.equal(openedPath, path.join(await realpath(actual), "insights.sqlite3"));
});
