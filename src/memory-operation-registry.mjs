const STABILITIES = new Set(["experimental", "stable", "legacy-debt"]);
const SIDE_EFFECTS = new Set(["none", "private-state", "external-delivery", "worktree"]);
const APPROVAL_POLICIES = new Set(["none", "history-read", "canonical-write"]);

function adapter({ action = null, tool = null, capabilities = [], order = null } = {}) {
  return { action, tool, capabilities, order };
}

const RAW_MEMORY_OPERATION_SPECS = [
  {
    id: "init",
    version: 1,
    stability: "legacy-debt",
    requestSchema: "threadshare-memory-init-request@v1",
    responseSchema: "threadshare-memory-init@v1",
    sideEffects: "worktree",
    capabilityVector: ["execute"],
    approvalPolicy: "none",
    cli: adapter({ action: "init", capabilities: ["execute"], order: 0 }),
    mcp: adapter(),
  },
  {
    id: "status",
    version: 1,
    stability: "stable",
    requestSchema: "threadshare-memory-status-request@v1",
    responseSchema: "threadshare-memory-status@v1",
    sideEffects: "none",
    capabilityVector: ["read"],
    approvalPolicy: "none",
    cli: adapter({ action: "status", capabilities: ["read"], order: 1 }),
    mcp: adapter({
      action: "status",
      tool: "threadshare_memory_status",
      capabilities: ["read"],
      order: 1,
    }),
  },
  {
    id: "lint",
    version: 1,
    stability: "legacy-debt",
    requestSchema: "threadshare-memory-lint-request@v1",
    responseSchema: "threadshare-memory-lint@v1",
    sideEffects: "none",
    capabilityVector: ["read"],
    approvalPolicy: "none",
    cli: adapter({ action: "lint", capabilities: ["read"], order: 2 }),
    mcp: adapter(),
  },
  {
    id: "extract",
    version: 1,
    stability: "legacy-debt",
    requestSchema: "threadshare-memory-extraction-request@v1",
    responseSchema: "threadshare-memory-extraction-result@v1",
    sideEffects: "external-delivery",
    capabilityVector: ["preview", "execute"],
    approvalPolicy: "history-read",
    cli: adapter({ action: "extract", capabilities: ["preview", "execute"], order: 3 }),
    mcp: adapter({
      action: "extract-preview",
      tool: "threadshare_memory_extract_preview",
      capabilities: ["preview"],
      order: 2,
    }),
  },
  {
    id: "consolidate",
    version: 1,
    stability: "legacy-debt",
    requestSchema: "threadshare-memory-consolidation-request@v1",
    responseSchema: "threadshare-memory-consolidation-result@v1",
    sideEffects: "external-delivery",
    capabilityVector: ["preview", "execute"],
    approvalPolicy: "history-read",
    cli: adapter({ action: "consolidate", capabilities: ["preview", "execute"], order: 4 }),
    mcp: adapter({
      action: "consolidate-preview",
      tool: "threadshare_memory_consolidate_preview",
      capabilities: ["preview"],
      order: 3,
    }),
  },
  {
    id: "review",
    version: 1,
    stability: "stable",
    requestSchema: "threadshare-memory-review-request@v1",
    responseSchema: "threadshare-memory-review@v1",
    sideEffects: "none",
    capabilityVector: ["read"],
    approvalPolicy: "none",
    cli: adapter({ action: "review", capabilities: ["read"], order: 5 }),
    mcp: adapter({
      action: "review",
      tool: "threadshare_memory_review",
      capabilities: ["read"],
      order: 4,
    }),
  },
  {
    id: "recall",
    version: 1,
    stability: "stable",
    requestSchema: "threadshare-memory-agent-recall-request@v1",
    responseSchema: "threadshare-memory-agent-recall@v1",
    sideEffects: "private-state",
    capabilityVector: ["execute"],
    approvalPolicy: "none",
    cli: adapter({ action: "recall", capabilities: ["execute"], order: 6 }),
    mcp: adapter({
      action: "recall",
      tool: "threadshare_memory_recall",
      capabilities: ["execute"],
      order: 5,
    }),
  },
  {
    id: "synthesize",
    version: 1,
    stability: "stable",
    requestSchema: "threadshare-memory-synthesis-request@v1",
    responseSchema: "threadshare-memory-synthesis@v1",
    sideEffects: "private-state",
    capabilityVector: ["execute"],
    approvalPolicy: "none",
    cli: adapter({ action: "synthesize", capabilities: ["execute"], order: 7 }),
    mcp: adapter({
      action: "synthesize",
      tool: "threadshare_memory_synthesize",
      capabilities: ["execute"],
      order: 6,
    }),
  },
  {
    id: "stage",
    version: 1,
    stability: "stable",
    requestSchema: "threadshare-memory-agent-stage-request@v1",
    responseSchema: "threadshare-memory-agent-stage@v1",
    sideEffects: "private-state",
    capabilityVector: ["execute"],
    approvalPolicy: "none",
    cli: adapter({ action: "stage", capabilities: ["execute"], order: 8 }),
    mcp: adapter({
      action: "stage",
      tool: "threadshare_memory_stage",
      capabilities: ["execute"],
      order: 7,
    }),
  },
  {
    id: "prepare",
    version: 1,
    stability: "stable",
    requestSchema: "threadshare-memory-prepare-request@v1",
    responseSchema: "threadshare-memory-prepare@v1",
    sideEffects: "private-state",
    capabilityVector: ["execute"],
    approvalPolicy: "canonical-write",
    cli: adapter({ action: "prepare", capabilities: ["execute"], order: 9 }),
    mcp: adapter({
      action: "prepare",
      tool: "threadshare_memory_prepare",
      capabilities: ["execute"],
      order: 8,
    }),
  },
  {
    id: "promote",
    version: 1,
    stability: "stable",
    requestSchema: "threadshare-memory-promote-request@v1",
    responseSchema: "threadshare-memory-promote@v1",
    sideEffects: "worktree",
    capabilityVector: ["execute"],
    approvalPolicy: "canonical-write",
    cli: adapter({ action: "promote", capabilities: ["execute"], order: 10 }),
    mcp: adapter({
      action: "promote",
      tool: "threadshare_memory_promote",
      capabilities: ["execute"],
      order: 9,
    }),
  },
  {
    id: "assemble",
    version: 1,
    stability: "stable",
    requestSchema: "threadshare-memory-assemble-request@v1",
    responseSchema: "threadshare-memory-assemble@v1",
    sideEffects: "worktree",
    capabilityVector: ["execute"],
    approvalPolicy: "none",
    cli: adapter({ action: "assemble", capabilities: ["execute"], order: 11 }),
    mcp: adapter({
      action: "assemble",
      tool: "threadshare_memory_assemble",
      capabilities: ["execute"],
      order: 10,
    }),
  },
  {
    id: "reverify-runner",
    version: 1,
    stability: "legacy-debt",
    requestSchema: "threadshare-memory-reverify-runner-request@v1",
    responseSchema: "threadshare-memory-reverify-runner@v1",
    sideEffects: "external-delivery",
    capabilityVector: ["execute"],
    approvalPolicy: "none",
    cli: adapter({ action: "reverify-runner", capabilities: ["execute"], order: 12 }),
    mcp: adapter(),
  },
  {
    id: "search",
    version: 1,
    stability: "legacy-debt",
    requestSchema: "threadshare-memory-search-request@v1",
    responseSchema: "threadshare-memory-search@v1",
    sideEffects: "none",
    capabilityVector: ["read"],
    approvalPolicy: "none",
    cli: adapter(),
    mcp: adapter({
      action: "search",
      tool: "threadshare_memory_search",
      capabilities: ["read"],
      order: 0,
    }),
  },
];

function sameValues(left, right) {
  return left.length === right.length && left.every((value, index) => value === right[index]);
}

function assertUnique(values, label) {
  const seen = new Set();
  for (const value of values) {
    if (value === null) continue;
    if (seen.has(value)) throw new TypeError(`duplicate Team Memory ${label}: ${value}`);
    seen.add(value);
  }
}

function validateAdapter(operation, name) {
  const value = operation[name];
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError(`operation ${operation.id} ${name} adapter must be an object`);
  }
  if (value.action !== null && (typeof value.action !== "string" || value.action.length === 0)) {
    throw new TypeError(`operation ${operation.id} ${name} action must be null or non-empty`);
  }
  if (name === "mcp" && value.tool !== null &&
      (typeof value.tool !== "string" || !value.tool.startsWith("threadshare_memory_"))) {
    throw new TypeError(`operation ${operation.id} MCP tool must use the threadshare_memory_ prefix`);
  }
  if (!Array.isArray(value.capabilities) ||
      value.capabilities.some((capability) => !operation.capabilityVector.includes(capability))) {
    throw new TypeError(`operation ${operation.id} ${name} capabilities must be a subset of its vector`);
  }
  if (new Set(value.capabilities).size !== value.capabilities.length) {
    throw new TypeError(`operation ${operation.id} ${name} capabilities must be unique`);
  }
  const exposed = name === "cli" ? value.action !== null : value.tool !== null;
  if (exposed !== (value.capabilities.length > 0)) {
    throw new TypeError(`operation ${operation.id} ${name} exposure must match its capabilities`);
  }
  if (exposed && (!Number.isInteger(value.order) || value.order < 0)) {
    throw new TypeError(`operation ${operation.id} ${name} order must be a non-negative integer`);
  }
}

export function validateMemoryOperationSpecs(specs) {
  if (!Array.isArray(specs) || specs.length === 0) {
    throw new TypeError("Team Memory operation registry must be a non-empty array");
  }
  assertUnique(specs.map((operation) => operation.id), "operation id");
  for (const operation of specs) {
    if (!operation || typeof operation !== "object" || Array.isArray(operation) ||
        typeof operation.id !== "string" || operation.id.length === 0 ||
        !Number.isInteger(operation.version) || operation.version < 1 ||
        !STABILITIES.has(operation.stability) ||
        typeof operation.requestSchema !== "string" || operation.requestSchema.length === 0 ||
        typeof operation.responseSchema !== "string" || operation.responseSchema.length === 0 ||
        !SIDE_EFFECTS.has(operation.sideEffects) ||
        !APPROVAL_POLICIES.has(operation.approvalPolicy) ||
        !Array.isArray(operation.capabilityVector) || operation.capabilityVector.length === 0 ||
        new Set(operation.capabilityVector).size !== operation.capabilityVector.length) {
      throw new TypeError(`invalid Team Memory operation spec: ${operation?.id ?? "unknown"}`);
    }
    validateAdapter(operation, "cli");
    validateAdapter(operation, "mcp");
    if (operation.stability === "stable" &&
        (!sameValues(operation.cli.capabilities, operation.capabilityVector) ||
         !sameValues(operation.mcp.capabilities, operation.capabilityVector))) {
      throw new TypeError(
        `stable operation ${operation.id} must expose equal non-empty CLI and MCP capabilities`,
      );
    }
  }
  assertUnique(specs.map((operation) => operation.cli.action), "CLI action");
  assertUnique(specs.map((operation) => operation.mcp.tool), "MCP tool");
  assertUnique(
    specs.filter((operation) => operation.cli.action !== null).map((operation) => operation.cli.order),
    "CLI order",
  );
  assertUnique(
    specs.filter((operation) => operation.mcp.tool !== null).map((operation) => operation.mcp.order),
    "MCP order",
  );
  return specs;
}

function deepFreeze(value) {
  if (value && typeof value === "object" && !Object.isFrozen(value)) {
    for (const nested of Object.values(value)) deepFreeze(nested);
    Object.freeze(value);
  }
  return value;
}

validateMemoryOperationSpecs(RAW_MEMORY_OPERATION_SPECS);
export const MEMORY_OPERATION_SPECS = deepFreeze(RAW_MEMORY_OPERATION_SPECS);

export const MEMORY_CLI_ACTIONS = Object.freeze(MEMORY_OPERATION_SPECS
  .filter((operation) => operation.cli.action !== null)
  .toSorted((left, right) => left.cli.order - right.cli.order)
  .map((operation) => operation.cli.action));

export const MEMORY_MCP_TOOL_NAMES = Object.freeze(MEMORY_OPERATION_SPECS
  .filter((operation) => operation.mcp.tool !== null)
  .toSorted((left, right) => left.mcp.order - right.mcp.order)
  .map((operation) => operation.mcp.tool));

const OPERATION_BY_CLI_ACTION = new Map(
  MEMORY_OPERATION_SPECS
    .filter((operation) => operation.cli.action !== null)
    .map((operation) => [operation.cli.action, operation]),
);
const OPERATION_BY_ID = new Map(
  MEMORY_OPERATION_SPECS.map((operation) => [operation.id, operation]),
);
const OPERATION_BY_MCP_TOOL = new Map(
  MEMORY_OPERATION_SPECS
    .filter((operation) => operation.mcp.tool !== null)
    .map((operation) => [operation.mcp.tool, operation]),
);

export function memoryOperationForCliAction(action) {
  return OPERATION_BY_CLI_ACTION.get(action);
}

export function memoryOperationForMcpTool(tool) {
  return OPERATION_BY_MCP_TOOL.get(tool);
}

export function memoryOperationById(id) {
  return OPERATION_BY_ID.get(id);
}
