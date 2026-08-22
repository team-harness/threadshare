import assert from "node:assert/strict";
import test from "node:test";

import { COMMAND_SPECS } from "../src/cli-contract.mjs";
import {
  MEMORY_CLI_ACTIONS,
  MEMORY_MCP_TOOL_NAMES,
  MEMORY_OPERATION_SPECS,
  memoryOperationForCliAction,
  memoryOperationForMcpTool,
  validateMemoryOperationSpecs,
} from "../src/memory-operation-registry.mjs";

const EXPECTED_CLI_ACTIONS = [
  "init",
  "status",
  "lint",
  "extract",
  "consolidate",
  "review",
  "recall",
  "synthesize",
  "stage",
  "prepare",
  "promote",
  "assemble",
  "reverify-runner",
];

const EXPECTED_MCP_TOOLS = [
  "threadshare_memory_search",
  "threadshare_memory_status",
  "threadshare_memory_extract_preview",
  "threadshare_memory_consolidate_preview",
  "threadshare_memory_review",
  "threadshare_memory_recall",
  "threadshare_memory_synthesize",
  "threadshare_memory_stage",
  "threadshare_memory_prepare",
  "threadshare_memory_promote",
];

test("Team Memory operation registry owns the public CLI and MCP names", () => {
  assert.deepEqual(MEMORY_CLI_ACTIONS, EXPECTED_CLI_ACTIONS);
  assert.deepEqual(MEMORY_MCP_TOOL_NAMES, EXPECTED_MCP_TOOLS);
  assert.equal(COMMAND_SPECS.memory.arguments[0].placeholder, `<${MEMORY_CLI_ACTIONS.join("|")}>`);
  assert.equal(Object.isFrozen(MEMORY_OPERATION_SPECS), true);

  for (const action of EXPECTED_CLI_ACTIONS) {
    assert.equal(memoryOperationForCliAction(action)?.cli.action, action);
  }
  for (const tool of EXPECTED_MCP_TOOLS) {
    assert.equal(memoryOperationForMcpTool(tool)?.mcp.tool, tool);
  }
  assert.equal(memoryOperationForCliAction("search"), undefined);
  assert.equal(memoryOperationForMcpTool("threadshare_memory_promote")?.mcp.action, "promote");
});

test("stable Team Memory operations must have equal real CLI and MCP capabilities", () => {
  assert.doesNotThrow(() => validateMemoryOperationSpecs(MEMORY_OPERATION_SPECS));
  const stable = MEMORY_OPERATION_SPECS.filter((operation) => operation.stability === "stable");
  assert.deepEqual(stable.map((operation) => operation.id), [
    "status", "review", "recall", "synthesize", "stage", "prepare", "promote",
  ]);
  for (const operation of stable) {
    assert.deepEqual(operation.cli.capabilities, operation.capabilityVector);
    assert.deepEqual(operation.mcp.capabilities, operation.capabilityVector);
  }

  const invalid = structuredClone(MEMORY_OPERATION_SPECS);
  const status = invalid.find((operation) => operation.id === "status");
  status.mcp.capabilities = [];
  assert.throws(
    () => validateMemoryOperationSpecs(invalid),
    /operation status mcp exposure must match its capabilities/,
  );
});

test("one-sided public memory operations remain explicit legacy debt", () => {
  const asymmetric = MEMORY_OPERATION_SPECS.filter((operation) =>
    JSON.stringify(operation.cli.capabilities) !== JSON.stringify(operation.mcp.capabilities));
  assert.ok(asymmetric.length > 0, "the registry must expose the current parity debt");
  assert.ok(asymmetric.every((operation) => operation.stability === "legacy-debt"));

  const invalid = structuredClone(MEMORY_OPERATION_SPECS);
  invalid.find((operation) => operation.id === "search").stability = "stable";
  assert.throws(
    () => validateMemoryOperationSpecs(invalid),
    /stable operation search must expose equal non-empty CLI and MCP capabilities/,
  );
});
