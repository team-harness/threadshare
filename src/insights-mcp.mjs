import { readFile } from "node:fs/promises";
import process from "node:process";
import { Readable } from "node:stream";
import { TextDecoder } from "node:util";

import { createInsightsAgentSpec } from "./insights-agent-spec.mjs";
import { executeInsightsQuery, insightsQueryDiagnostic } from "./insights-query.mjs";

const PROTOCOL_VERSION = "2025-11-25";
const MAX_MESSAGE_BYTES = 128 * 1024;
const TOOL_NAMES = Object.freeze([
  "threadshare_insights_spec",
  "threadshare_insights_query",
  "threadshare_insights_recipe",
  "threadshare_insights_evidence",
]);

function plainObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null);
}

function exactKeys(value, allowed) {
  return plainObject(value) && Object.keys(value).every((key) => allowed.includes(key));
}

async function readSchema(name) {
  return JSON.parse(await readFile(new URL(`../schema/${name}`, import.meta.url), "utf8"));
}

async function toolCatalog() {
  const [spec, query, recipe, evidence] = await Promise.all([
    readSchema("threadshare-insights-agent-spec.v1.schema.json"),
    readSchema("threadshare-insights-query-request.v2.schema.json"),
    readSchema("threadshare-insights-recipe-request.v1.schema.json"),
    readSchema("threadshare-insights-evidence-request.v2.schema.json"),
  ]);
  const annotations = {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  };
  return Object.freeze([
    {
      name: TOOL_NAMES[0],
      title: "Choose a local Threadshare Insights analysis plan",
      description: "Map a user's natural-language question to bounded Insights actions and answer rules.",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
      },
      outputSchema: spec,
      annotations,
    },
    {
      name: TOOL_NAMES[1],
      title: "Query local Threadshare Insights",
      description: "Run a bounded typed records or aggregate query over the committed local Insights index.",
      inputSchema: query,
      annotations,
    },
    {
      name: TOOL_NAMES[2],
      title: "Run a local Threadshare Insights recipe",
      description: "Run the versioned evidence-bearing Recipe selected by threadshare_insights_spec.",
      inputSchema: {
        $schema: "https://json-schema.org/draft/2020-12/schema",
        type: "object",
        additionalProperties: false,
        required: ["name", "request"],
        properties: {
          name: {
            type: "string",
            enum: [
              "capability-contexts@1", "failure-chains@1", "file-workflow-signals@1",
              "activity-shifts@1", "token-hotspots@1", "solution-recall@1",
              "session-timeline@1",
            ],
          },
          request: recipe,
        },
      },
      annotations,
    },
    {
      name: TOOL_NAMES[3],
      title: "Read local Threadshare Insights evidence",
      description: "Read revision-bound unredacted local evidence using a bounded byte page.",
      inputSchema: evidence,
      annotations,
    },
  ]);
}

async function defaultExecute(invocation, request, options) {
  return executeInsightsQuery(invocation, {
    ...options.queryOptions,
    signal: options.signal,
    input: Readable.from([JSON.stringify(request)]),
  });
}

function toolInvocation(name, args) {
  if (!plainObject(args)) throw Object.assign(new Error("tool arguments must be an object"), {
    code: "TS_INSIGHTS_REQUEST_INVALID",
  });
  if (name === TOOL_NAMES[0]) {
    if (!exactKeys(args, [])) {
      throw Object.assign(new Error("spec arguments must be empty"), {
        code: "TS_INSIGHTS_REQUEST_INVALID",
      });
    }
    return { result: createInsightsAgentSpec() };
  }
  if (name === TOOL_NAMES[1]) {
    return { invocation: { action: "query", requestSource: "-" }, request: args };
  }
  if (name === TOOL_NAMES[2]) {
    if (!exactKeys(args, ["name", "request"]) || typeof args.name !== "string" ||
        !plainObject(args.request)) {
      throw Object.assign(new Error("recipe arguments must contain name and request"), {
        code: "TS_INSIGHTS_REQUEST_INVALID",
      });
    }
    return {
      invocation: { action: "recipe", name: args.name, requestSource: "-" },
      request: args.request,
    };
  }
  if (name === TOOL_NAMES[3]) {
    return { invocation: { action: "evidence-v2", requestSource: "-" }, request: args };
  }
  return null;
}

function rpcError(id, code, message) {
  return { jsonrpc: "2.0", id, error: { code, message } };
}

function toolError(error, action) {
  const diagnostic = insightsQueryDiagnostic(error, action);
  const value = {
    code: diagnostic.code,
    problem: diagnostic.message,
    next: diagnostic.next ?? "Run `threadshare insights --help` and retry.",
  };
  return {
    content: [{ type: "text", text: JSON.stringify(value) }],
    structuredContent: value,
    isError: true,
  };
}

async function writeMessage(output, message) {
  const line = `${JSON.stringify(message)}\n`;
  if (output.write(line)) return;
  await new Promise((resolve, reject) => {
    output.once("drain", resolve);
    output.once("error", reject);
  });
}

async function* readMessages(input) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  let pending = Buffer.alloc(0);
  for await (const chunk of input) {
    pending = Buffer.concat([pending, Buffer.from(chunk)]);
    if (pending.byteLength > MAX_MESSAGE_BYTES && pending.indexOf(0x0a) === -1) {
      throw new Error("MCP message exceeds 128 KiB");
    }
    for (;;) {
      const newline = pending.indexOf(0x0a);
      if (newline === -1) break;
      const line = pending.subarray(0, newline);
      pending = pending.subarray(newline + 1);
      if (line.byteLength === 0) continue;
      if (line.byteLength > MAX_MESSAGE_BYTES) throw new Error("MCP message exceeds 128 KiB");
      yield decoder.decode(line);
    }
  }
  if (pending.byteLength > 0) yield decoder.decode(pending);
}

export function createInsightsMcpServer(options = {}) {
  const execute = options.execute ?? defaultExecute;
  const catalog = options.catalog ?? toolCatalog;
  const handle = async (message) => {
    const id = plainObject(message) && Object.hasOwn(message, "id") ? message.id : null;
    if (!plainObject(message) || message.jsonrpc !== "2.0" || typeof message.method !== "string" ||
        (Object.hasOwn(message, "id") && typeof message.id !== "string" &&
         typeof message.id !== "number")) {
      return rpcError(id, -32600, "Invalid Request");
    }
    const notification = !Object.hasOwn(message, "id");
    if (message.method === "notifications/initialized" || message.method === "notifications/cancelled") {
      return null;
    }
    if (message.method === "initialize") {
      if (notification) return null;
      return {
        jsonrpc: "2.0", id: message.id,
        result: {
          protocolVersion: PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: "threadshare-insights", version: "1.0.0" },
          instructions: "Users ask natural-language questions. Call threadshare_insights_spec to choose the bounded read-only plan; ask before sync when freshness matters.",
        },
      };
    }
    if (message.method === "ping") {
      return notification ? null : { jsonrpc: "2.0", id: message.id, result: {} };
    }
    if (message.method === "tools/list") {
      if (notification) return null;
      if (message.params !== undefined && !exactKeys(message.params, ["cursor"])) {
        return rpcError(message.id, -32602, "Invalid params");
      }
      return { jsonrpc: "2.0", id: message.id, result: { tools: await catalog() } };
    }
    if (message.method === "tools/call") {
      if (notification) return null;
      if (!exactKeys(message.params, ["name", "arguments"]) ||
          typeof message.params.name !== "string") {
        return rpcError(message.id, -32602, "Invalid params");
      }
      const target = toolInvocation(message.params.name, message.params.arguments ?? {});
      if (target === null) return rpcError(message.id, -32602, "Unknown tool");
      if (Object.hasOwn(target, "result")) {
        return {
          jsonrpc: "2.0", id: message.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(target.result) }],
            structuredContent: target.result,
            isError: false,
          },
        };
      }
      try {
        const result = await execute(target.invocation, target.request, options);
        return {
          jsonrpc: "2.0", id: message.id,
          result: {
            content: [{ type: "text", text: JSON.stringify(result) }],
            structuredContent: result,
            isError: false,
          },
        };
      } catch (error) {
        return {
          jsonrpc: "2.0", id: message.id,
          result: toolError(error, target.invocation.action),
        };
      }
    }
    return notification ? null : rpcError(message.id, -32601, "Method not found");
  };
  return Object.freeze({
    async run({ input = process.stdin, output = process.stdout } = {}) {
      try {
        for await (const line of readMessages(input)) {
          let message;
          try {
            message = JSON.parse(line);
          } catch {
            await writeMessage(output, rpcError(null, -32700, "Parse error"));
            continue;
          }
          const response = await handle(message);
          if (response !== null) await writeMessage(output, response);
        }
      } catch (error) {
        await writeMessage(output, rpcError(null, -32600, "Invalid Request"));
        if (options.logErrors === true) process.stderr.write(`${error.message}\n`);
      }
    },
  });
}

export async function runInsightsMcpServer(options = {}) {
  await createInsightsMcpServer(options).run();
}
