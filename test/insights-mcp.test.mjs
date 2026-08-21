import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import { createInsightsMcpServer } from "../src/insights-mcp.mjs";

async function runMessages(messages, options = {}) {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { text += chunk; });
  const server = createInsightsMcpServer(options);
  await server.run({
    input: Readable.from(messages.map((message) => `${JSON.stringify(message)}\n`)),
    output,
  });
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("Insights MCP exposes Agent discovery and three deep read tools over newline JSON-RPC", async () => {
  const calls = [];
  const responses = await runMessages([
    {
      jsonrpc: "2.0", id: 1, method: "initialize",
      params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "test", version: "1" } },
    },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: {
        name: "threadshare_insights_query",
        arguments: {
          format: "threadshare-insights-query-request@v2",
          resource: "event",
          shape: { kind: "records", select: ["eventKey"] },
          orderBy: [{ field: "eventKey", direction: "asc" }],
          limit: 1,
        },
      },
    },
  ], {
    async execute(invocation, request) {
      calls.push({ invocation, request });
      return { format: "threadshare-insights-query@v2", records: [] };
    },
  });
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.get(1).result.protocolVersion, "2025-11-25");
  assert.deepEqual(byId.get(2).result.tools.map((tool) => tool.name), [
    "threadshare_insights_spec",
    "threadshare_insights_query",
    "threadshare_insights_recipe",
    "threadshare_insights_evidence",
    "threadshare_memory_search",
    "threadshare_memory_status",
    "threadshare_memory_extract_preview",
  ]);
  assert.equal(byId.get(2).result.tools.every((tool) =>
    tool.annotations.openWorldHint === false), true);
  const recipeTool = byId.get(2).result.tools.find(({ name }) =>
    name === "threadshare_insights_recipe");
  assert.equal(recipeTool.inputSchema.properties.name.enum.includes("delivery-trace@1"), true);
  const evidenceTool = byId.get(2).result.tools.find(({ name }) =>
    name === "threadshare_insights_evidence");
  assert.deepEqual(evidenceTool.inputSchema.oneOf.map((schema) => schema.properties.format.const), [
    "threadshare-insights-evidence-request@v2",
    "threadshare-insights-git-diff-evidence-request@v1",
  ]);
  assert.equal(byId.get(3).result.isError, false);
  assert.deepEqual(byId.get(3).result.structuredContent, {
    format: "threadshare-insights-query@v2", records: [],
  });
  assert.equal(calls[0].invocation.action, "query");
});

test("Memory MCP exposes read-only recall plus pending-only extraction without transcript bytes", async () => {
  const calls = [];
  const request = {
    format: "threadshare-memory-extraction-request@v1",
    window: {
      after: "2026-08-01T00:00:00.000Z",
      before: "2026-08-02T00:00:00.000Z",
    },
    query: "release verification",
    filters: { providers: ["codex"] },
  };
  const responses = await runMessages([
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "threadshare_memory_search", arguments: { query: "release tests", limit: 5 } },
    },
    {
      jsonrpc: "2.0", id: 3, method: "tools/call",
      params: { name: "threadshare_memory_status", arguments: {} },
    },
    {
      jsonrpc: "2.0", id: 4, method: "tools/call",
      params: {
        name: "threadshare_memory_extract_preview",
        arguments: {
          runner: "codex",
          model: "gpt-5.6-sol",
          endpoint: "https://api.openai.com/v1",
          request,
          limit: 2,
        },
      },
    },
  ], {
    async memoryExecute(action, args) {
      calls.push({ action, args });
      if (action === "search") {
        return {
          format: "threadshare-memory-search@v1",
          generation: 3,
          coverage: "complete",
          items: [{ rank: 1, entryId: "release-notes", revision: 1, contentDigest: "a".repeat(64), status: "active", summary: "release" }],
        };
      }
      if (action === "status") return {
        format: "threadshare-memory-status@v1",
        chunks: { pending: 0, drafted: 0, extracted: 1, stale: 0 },
        tasks: { pending: 0, claimed: 0, submitted: 1, stale: 0 },
        candidates: { draft: 0, quarantined: 1, promoted: 0, discarded: 0 },
        promotions: { generated: 0, approved: 0, applied: 0, voided: 0 },
        extraction: { entrypoint: "cli", note: "no transcript here" },
      };
      return {
        format: "threadshare-memory-extraction-preview@v1",
        authorized: false,
        plans: [{
          planDigest: "b".repeat(64),
          taskKind: "extraction",
          provider: "openai",
          model: "gpt-5.6-sol",
          endpoint: "https://api.openai.com/v1",
          bytesToSend: 512,
          authorization: "pending",
        }],
        manifestDigest: null,
        selection: { matchedSessions: 1, rejectedSessions: 0, pendingChunks: 1 },
      };
    },
  });
  const byId = new Map(responses.map((response) => [response.id, response]));
  const memoryTools = byId.get(1).result.tools.filter((tool) => tool.name.startsWith("threadshare_memory_"));
  assert.deepEqual(memoryTools.map((tool) => tool.name), [
    "threadshare_memory_search",
    "threadshare_memory_status",
    "threadshare_memory_extract_preview",
  ]);
  assert.equal(memoryTools[0].annotations.readOnlyHint, true);
  assert.equal(memoryTools[1].annotations.readOnlyHint, true);
  assert.deepEqual(memoryTools[2].annotations, {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  });
  // search carries generation + coverage.
  assert.equal(byId.get(2).result.isError, false);
  assert.equal(byId.get(2).result.structuredContent.generation, 3);
  assert.equal(byId.get(2).result.structuredContent.coverage, "complete");
  // status is transcript-free and steers extraction to the CLI.
  assert.equal(byId.get(3).result.isError, false);
  assert.equal(byId.get(3).result.structuredContent.extraction.entrypoint, "cli");
  assert.equal(JSON.stringify(byId.get(3).result).includes("transcript"), true);
  // Preview persists only private pending plans; neither the request nor the response carries transcript bytes.
  assert.equal(byId.get(4).result.isError, false, JSON.stringify(byId.get(4).result));
  assert.equal(byId.get(4).result.structuredContent.authorized, false);
  assert.equal(byId.get(4).result.structuredContent.plans[0].authorization, "pending");
  assert.equal(JSON.stringify(byId.get(4).result).includes("release tests must stay private"), false);
  assert.deepEqual(calls.map((call) => call.action), ["search", "status", "extract-preview"]);
  assert.deepEqual(calls[0].args, { query: "release tests", limit: 5 });
  assert.deepEqual(calls[2].args, {
    runner: "codex",
    model: "gpt-5.6-sol",
    endpoint: "https://api.openai.com/v1",
    request,
    limit: 2,
  });
});

test("Memory MCP extraction preview rejects every authorization-shaped field", async () => {
  const responses = await runMessages([{
    jsonrpc: "2.0", id: "preview", method: "tools/call",
    params: {
      name: "threadshare_memory_extract_preview",
      arguments: {
        runner: "codex",
        request: {
          format: "threadshare-memory-extraction-request@v1",
          window: {
            after: "2026-08-01T00:00:00.000Z",
            before: "2026-08-02T00:00:00.000Z",
          },
        },
        approvePlan: "a".repeat(64),
      },
    },
  }], {
    async memoryExecute() {
      throw new Error("memoryExecute must not run for an authorization-shaped MCP request");
    },
  });
  assert.equal(responses[0].result.isError, true);
  assert.match(responses[0].result.structuredContent.problem, /preview/u);
});

test("Memory MCP rejects a malformed search request as a stable tool error", async () => {
  const responses = await runMessages([
    {
      jsonrpc: "2.0", id: "m1", method: "tools/call",
      params: { name: "threadshare_memory_search", arguments: { query: "" } },
    },
    { jsonrpc: "2.0", id: "m2", method: "ping" },
  ], {
    async memoryExecute() {
      throw new Error("memoryExecute must not run for a malformed request");
    },
  });
  const byId = new Map(responses.map((response) => [response.id, response]));
  // A malformed request never reaches memoryExecute; it surfaces as a JSON-RPC error.
  assert.ok(byId.get("m1").error || byId.get("m1").result?.isError);
  assert.deepEqual(byId.get("m2").result, {});
});

test("Insights MCP returns stable tool errors without breaking the JSON-RPC stream", async () => {
  const responses = await runMessages([
    {
      jsonrpc: "2.0", id: "bad", method: "tools/call",
      params: { name: "threadshare_insights_recipe", arguments: { name: "failure-chains@1", request: {} } },
    },
    { jsonrpc: "2.0", id: "ping", method: "ping" },
  ], {
    async execute() {
      const error = new Error("private payload must not become a protocol error");
      error.code = "TS_INSIGHTS_REQUEST_INVALID";
      throw error;
    },
  });
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.get("bad").result.isError, true);
  assert.match(byId.get("bad").result.content[0].text, /TS_INSIGHTS_REQUEST_INVALID/u);
  assert.deepEqual(byId.get("ping").result, {});
});
