import assert from "node:assert/strict";
import { PassThrough, Readable } from "node:stream";
import test from "node:test";

import { createInsightsMcpServer } from "../src/insights-mcp.mjs";
import { MAX_PROTOCOL_PAYLOAD_BYTES } from "../src/insights-engine-protocol.mjs";
import {
  MAX_MEMORY_REQUEST_BYTES,
  readInsightsQueryRequest,
} from "../src/insights-query.mjs";
import { candidateDraftBatchSchema } from "../src/memory-contracts.mjs";
import { MEMORY_MCP_TOOL_NAMES } from "../src/memory-operation-registry.mjs";

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

function longCandidateDraftBatch() {
  return {
    format: "threadshare-memory-candidate-draft-batch@v1",
    taskId: "extract-long-binding",
    binding: {
      databaseUuid: "11111111-2222-4333-8444-555555555555",
      owner: { repositoryKey: "1".repeat(64), worktreeKey: "2".repeat(64) },
      sourceInputDigest: "3".repeat(64),
      selection: {
        requestDigest: "4".repeat(64),
        resultSetDigest: "5".repeat(64),
        sourceBindingDigest: "6".repeat(64),
      },
      turnRevisions: ["7".repeat(64)],
      payloadDigests: [],
      // A real long session can accumulate this many Delivery Trace revisions.
      deliveryEdgeRevisions: Array.from({ length: 2_200 }, (_, index) =>
        index.toString(16).padStart(64, "0")),
      promptVersion: "memory-extraction@1",
      schemaVersion: "threadshare-memory-candidate-draft-batch@v1",
      chunkerVersion: "memory-chunker@1",
      provenance: {
        snapshotSeq: "1",
        evaluatedAt: "2026-08-21T00:00:00.000Z",
      },
    },
    candidates: [],
  };
}

test("CLI and MCP accept the same long CandidateDraftBatch binding", async () => {
  const batch = longCandidateDraftBatch();
  const encoded = JSON.stringify(batch);
  assert.ok(Buffer.byteLength(encoded, "utf8") > 128 * 1024);
  assert.ok(Buffer.byteLength(encoded, "utf8") < MAX_MEMORY_REQUEST_BYTES);
  candidateDraftBatchSchema.parse(batch);

  // CLI memory --request uses the protocol-sized reader cap.
  const cliParsed = await readInsightsQueryRequest("-", {
    input: Readable.from([encoded]),
    maxBytes: MAX_MEMORY_REQUEST_BYTES,
  });
  assert.deepEqual(cliParsed, batch);

  // MCP must carry the identical structured document through its real
  // newline-JSON transport, rather than silently retaining the old 128 KiB cap.
  let received = null;
  const responses = await runMessages([{
    jsonrpc: "2.0",
    id: "long-binding",
    method: "tools/call",
    params: { name: "threadshare_memory_stage", arguments: batch },
  }], {
    async memoryExecute(action, args) {
      received = { action, args };
      return { format: "test-memory-stage@v1", accepted: true };
    },
  });
  assert.equal(responses.length, 1);
  assert.equal(responses[0].result.isError, false, JSON.stringify(responses[0]));
  assert.deepEqual(received, { action: "stage", args: batch });
});

test("MCP rejects an oversized unterminated tail after a valid message", async () => {
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { text += chunk; });
  const server = createInsightsMcpServer();
  const tail = Buffer.alloc(MAX_PROTOCOL_PAYLOAD_BYTES + 1, 0x20);
  await server.run({
    input: Readable.from([
      Buffer.concat([
        Buffer.from('{"jsonrpc":"2.0","id":"ping","method":"ping"}\n'),
        tail,
      ]),
    ]),
    output,
  });
  const responses = text.trim().split("\n").map((line) => JSON.parse(line));
  assert.equal(responses[0].result?.pong, undefined);
  assert.deepEqual(responses[0], {
    jsonrpc: "2.0",
    id: "ping",
    result: {},
  });
  assert.deepEqual(responses[1], {
    jsonrpc: "2.0",
    id: null,
    error: { code: -32600, message: "Invalid Request" },
  });
});

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
    ...MEMORY_MCP_TOOL_NAMES,
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

test("Memory MCP exposes Agent-native operations plus optional pending batch previews", async () => {
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
    {
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: {
        name: "threadshare_memory_consolidate_preview",
        arguments: {
          runner: "codex",
          model: "gpt-5.6-sol",
          endpoint: "https://api.openai.com/v1",
          ifDue: true,
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
      if (action === "extract-preview") return {
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
      return {
        format: "threadshare-memory-consolidation-preview@v1",
        authorized: false,
        plans: [{
          planDigest: "c".repeat(64),
          taskKind: "consolidation",
          provider: "openai",
          model: "gpt-5.6-sol",
          endpoint: "https://api.openai.com/v1",
          bytesToSend: 1024,
          authorization: "pending",
        }],
        entryCount: 20,
        pendingRunId: null,
      };
    },
  });
  const byId = new Map(responses.map((response) => [response.id, response]));
  const memoryTools = byId.get(1).result.tools.filter((tool) => tool.name.startsWith("threadshare_memory_"));
  assert.deepEqual(memoryTools.map((tool) => tool.name), MEMORY_MCP_TOOL_NAMES);
  const stageTool = memoryTools.find((tool) => tool.name === "threadshare_memory_stage");
  assert.deepEqual(stageTool.inputSchema.oneOf.map((schema) => schema.properties.format.const), [
    "threadshare-memory-skill-candidate@v1",
    "threadshare-memory-candidate-draft-batch@v1",
    "threadshare-memory-adjudication-result@v1",
    "threadshare-memory-consolidation-patch@v1",
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
  assert.equal(byId.get(5).result.structuredContent.authorized, false);
  assert.equal(byId.get(5).result.structuredContent.entryCount, 20);
  assert.equal(JSON.stringify(byId.get(5).result).includes("Run the release"), false);
  assert.deepEqual(calls.map((call) => call.action), [
    "search", "status", "extract-preview", "consolidate-preview",
  ]);
  assert.deepEqual(calls[0].args, { query: "release tests", limit: 5 });
  assert.deepEqual(calls[2].args, {
    runner: "codex",
    model: "gpt-5.6-sol",
    endpoint: "https://api.openai.com/v1",
    request,
    limit: 2,
  });
  assert.deepEqual(calls[3].args, {
    runner: "codex",
    model: "gpt-5.6-sol",
    endpoint: "https://api.openai.com/v1",
    ifDue: true,
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

test("Agent-native Memory MCP routes recall, stage, review, prepare, and promote", async () => {
  const calls = [];
  const binding = {
    databaseUuid: "11111111-2222-4333-8444-555555555555",
    owner: { repositoryKey: "1".repeat(64), worktreeKey: "2".repeat(64) },
    sourceInputDigest: "3".repeat(64),
    selection: {
      requestDigest: "4".repeat(64),
      resultSetDigest: "5".repeat(64),
      sourceBindingDigest: "6".repeat(64),
    },
    turnRevisions: ["7".repeat(64)],
    payloadDigests: [],
    deliveryEdgeRevisions: [],
    promptVersion: "memory-extraction@1",
    schemaVersion: "threadshare-memory-candidate-draft-batch@v1",
    chunkerVersion: "memory-chunker@1",
    provenance: { snapshotSeq: "1", evaluatedAt: "2026-08-01T00:00:00.000Z" },
  };
  const request = {
    format: "threadshare-memory-extraction-request@v1",
    window: {
      after: "2026-08-01T00:00:00.000Z",
      before: "2026-08-02T00:00:00.000Z",
    },
  };
  const batch = {
    format: "threadshare-memory-candidate-draft-batch@v1",
    taskId: `extract-${"a".repeat(64)}`,
    binding,
    candidates: [],
  };
  const adjudication = {
    format: "threadshare-memory-adjudication-result@v1",
    taskId: `adjudicate-agent-${"d".repeat(64)}`,
    binding: {
      databaseUuid: binding.databaseUuid,
      memoryStateUuid: "88888888-9999-4aaa-8bbb-cccccccccccc",
      owner: binding.owner,
      draftBatchDigest: "d".repeat(64),
      approvedProjection: { generation: 1, analyzerVersion: "memory-fts@1" },
      candidateProjection: { generation: 1, analyzerVersion: "memory-fts@1" },
      recallAlgorithmVersion: "recall-rrf@1",
      recallQueryDigest: "e".repeat(64),
      resultSetDigest: "f".repeat(64),
      poolItemRevisions: [],
      promptVersion: "memory-adjudication@1",
      schemaVersion: "threadshare-memory-adjudication-result@v1",
    },
    adjudications: [],
  };
  const prepare = {
    format: "threadshare-memory-prepare-request@v1",
    kind: "entry",
    candidates: [{
      candidateId: "candidate-1",
      expectedRevision: 2,
      statements: [{
        statementId: "statement-1",
        statementTextDigest: "b".repeat(64),
        citationsDigest: "c".repeat(64),
      }],
    }],
  };
  const messages = [
    ["threadshare_memory_recall", { request, limit: 1 }],
    ["threadshare_memory_synthesize", { full: true }],
    ["threadshare_memory_stage", batch],
    ["threadshare_memory_stage", adjudication],
    ["threadshare_memory_review", { kind: "entry" }],
    ["threadshare_memory_prepare", prepare],
    ["threadshare_memory_promote", { plan: "plan-1" }],
    ["threadshare_memory_assemble", { provider: "codex" }],
  ].map(([name, args], index) => ({
    jsonrpc: "2.0",
    id: index + 1,
    method: "tools/call",
    params: { name, arguments: args },
  }));
  const responses = await runMessages(messages, {
    async memoryExecute(action, args) {
      calls.push({ action, args });
      return { format: `test-${action}@v1`, action };
    },
  });
  assert.equal(responses.every((response) => response.result.isError === false), true);
  assert.deepEqual(calls.map(({ action }) => action), [
    "recall", "synthesize", "stage", "stage", "review", "prepare", "promote", "assemble",
  ]);
  assert.deepEqual(calls[0].args, { request, limit: 1 });
  assert.deepEqual(calls[1].args, { full: true });
  assert.deepEqual(calls[2].args, batch);
  assert.deepEqual(calls[3].args, adjudication);
  assert.deepEqual(calls[5].args, prepare);
  assert.deepEqual(calls[6].args, { plan: "plan-1" });
  assert.deepEqual(calls[7].args, { provider: "codex" });
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
