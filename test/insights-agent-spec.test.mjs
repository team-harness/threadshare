import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFile } from "node:fs/promises";
import test from "node:test";
import { fileURLToPath } from "node:url";

import Ajv2020 from "ajv/dist/2020.js";

import { createInsightsAgentSpec } from "../src/insights-agent-spec.mjs";
import { createInsightsMcpServer } from "../src/insights-mcp.mjs";

const cli = fileURLToPath(new URL("../bin/threadshare.mjs", import.meta.url));
const INTENT_IDS = Object.freeze([
  "capability-use-context",
  "failure-recovery",
  "file-workflow",
  "activity-change",
  "token-hotspot",
  "solution-reuse",
  "session-explanation",
  "delivery-trace",
  "memory-candidate-selection",
  "custom-query",
]);
const RECIPE_NAMES = Object.freeze([
  "capability-contexts@1",
  "failure-chains@1",
  "file-workflow-signals@1",
  "activity-shifts@1",
  "token-hotspots@1",
  "solution-recall@1",
  "session-timeline@1",
  "extraction-candidates@1",
  "delivery-trace@1",
]);

async function runMcp(messages, options = {}) {
  const { PassThrough, Readable } = await import("node:stream");
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { text += chunk; });
  await createInsightsMcpServer(options).run({
    input: Readable.from(messages.map((message) => `${JSON.stringify(message)}\n`)),
    output,
  });
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
}

test("Agent spec maps natural-language questions to every Insights protocol path", async () => {
  const spec = createInsightsAgentSpec();
  const schema = JSON.parse(await readFile(
    new URL("../schema/threadshare-insights-agent-spec.v1.schema.json", import.meta.url),
  ));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(schema);
  assert.equal(validate(spec), true, JSON.stringify(validate.errors));
  assert.deepEqual(spec.intents.map((intent) => intent.id), INTENT_IDS);
  assert.equal(spec.userContract.userProvidesNaturalLanguageQuestion, true);
  assert.equal(spec.userContract.agentChoosesProtocol, true);
  assert.equal(spec.userContract.maintenanceNeverImplicit, true);
  assert.equal(spec.intents.every((intent) =>
    intent.userQuestions.length > 0 &&
    intent.userQuestions.every((question) => !question.includes("@1"))), true);
  assert.deepEqual(
    spec.intents.flatMap((intent) => intent.plan.map((step) => step.recipe).filter(Boolean)).sort(),
    [...RECIPE_NAMES].sort(),
  );
  const delivery = spec.intents.find(({ id }) => id === "delivery-trace");
  assert.deepEqual(delivery.userQuestions, [
    "Which Sessions and commits delivered this feature, and what evidence connects them?",
    "How was this failure resolved, and what code changed in the successful delivery?",
    "Which requirements still have no recorded commit evidence?",
    "Which commits have no recorded Agent or intent evidence?",
    "What should I know before continuing this work?",
  ]);
  assert.equal(delivery.answerRules.some((rule) => rule.includes("never Agent authorship")), true);
  assert.equal(delivery.answerRules.some((rule) =>
    rule.includes("cannot restore a Session, code state, or Git state")), true);
  assert.equal(spec.actions.every((action) => action.help.startsWith("threadshare insights ")), true);
});

test("CLI prints the Agent spec without opening the index", () => {
  const result = spawnSync(process.execPath, [cli, "insights", "spec", "--format", "json"], {
    encoding: "utf8",
    env: { ...process.env, THREADSHARE_INSIGHTS_HOME: "/definitely/not-read" },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.deepEqual(JSON.parse(result.stdout), createInsightsAgentSpec());

  const missingFormat = spawnSync(process.execPath, [cli, "insights", "spec"], {
    encoding: "utf8",
  });
  assert.equal(missingFormat.status, 1);
  assert.equal(missingFormat.stdout, "");
  assert.match(missingFormat.stderr, /TS_USAGE_OPTION_DEPENDENCY/u);
});

test("MCP exposes the same Agent spec without invoking the Engine", async () => {
  let executed = 0;
  const responses = await runMcp([
    { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
    {
      jsonrpc: "2.0", id: 2, method: "tools/call",
      params: { name: "threadshare_insights_spec", arguments: {} },
    },
  ], {
    async execute() { executed += 1; throw new Error("Engine must not run for spec"); },
  });
  const byId = new Map(responses.map((response) => [response.id, response]));
  assert.equal(byId.get(1).result.tools[0].name, "threadshare_insights_spec");
  assert.equal(byId.get(1).result.tools[0].description.includes("natural-language"), true);
  assert.equal(byId.get(2).result.isError, false);
  assert.deepEqual(byId.get(2).result.structuredContent, createInsightsAgentSpec());
  assert.equal(executed, 0);
});
