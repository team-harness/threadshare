const MAX_SELECTED_NODES = 32;
const MAX_EDGES_PER_STRENGTH = 32;
const MAX_RECENT_PROMPTS = 8;
const MAX_FAILURE_CHAINS = 8;
const MAX_TEXT_BYTES = 8 * 1024;
const KEY = /^[0-9a-f]{64}$/u;

export const CONTINUATION_CONTEXT_NOTICE =
  "This evidence summary cannot restore a Session, code state, or Git state.";

function boundedText(value, label) {
  if (typeof value !== "string" || value.length === 0 ||
      Buffer.byteLength(value, "utf8") > MAX_TEXT_BYTES) {
    throw new TypeError(`${label} must be a bounded non-empty string`);
  }
  return value;
}

function contractKey(value, label) {
  if (typeof value !== "string" || !KEY.test(value)) {
    throw new TypeError(`${label} must be a contract key`);
  }
  return value;
}

function clone(value) {
  return structuredClone(value);
}

function prompt(value) {
  return Object.freeze({
    turnKey: contractKey(value?.turnKey, "recent prompt turnKey"),
    revision: contractKey(value?.revision, "recent prompt revision"),
    text: boundedText(value?.text, "recent prompt text"),
    complete: value?.complete === true,
  });
}

function failureChain(value) {
  if (!new Set(["recovered", "never-succeeded", "abandoned", "unknown"]).has(value?.outcome)) {
    throw new TypeError("failure chain outcome is invalid");
  }
  return Object.freeze({
    chainKey: contractKey(value?.chainKey, "failure chain key"),
    revision: contractKey(value?.revision, "failure chain revision"),
    outcome: value.outcome,
    summary: boundedText(value?.summary, "failure chain summary"),
  });
}

function deepFreeze(value) {
  if (value !== null && typeof value === "object" && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) deepFreeze(child);
    Object.freeze(value);
  }
  return value;
}

export function createInsightsContinuationContext(trace, options = {}) {
  if (trace?.format !== "threadshare-insights-delivery-trace@v1" ||
      typeof trace.databaseUuid !== "string" || typeof trace.snapshotSeq !== "string" ||
      typeof trace.evaluatedAt !== "string" || !Array.isArray(trace.nodes) ||
      !Array.isArray(trace.edges) || trace.root === null || typeof trace.root !== "object") {
    throw new TypeError("a Delivery Trace response is required");
  }
  const intents = trace.nodes.filter(({ kind }) => kind === "intent");
  const commits = trace.nodes.filter(({ kind }) => kind === "git-commit");
  const files = trace.nodes.filter(({ kind }) => kind === "file");
  const byStrength = Object.fromEntries(
    ["direct", "observed", "candidate", "contextual"].map((strength) => [
      strength,
      trace.edges.filter((edge) => edge.strength === strength),
    ]),
  );
  const recentPrompts = (options.recentPrompts ?? []).map(prompt);
  const failureChains = (options.failureChains ?? []).map(failureChain);
  const boundedEdges = Object.fromEntries(Object.entries(byStrength).map(([strength, edges]) => [
    strength,
    clone(edges.slice(0, MAX_EDGES_PER_STRENGTH)),
  ]));
  return deepFreeze({
    format: "threadshare-insights-continuation-context@v1",
    snapshot: {
      databaseUuid: trace.databaseUuid,
      snapshotSeq: trace.snapshotSeq,
      evaluatedAt: trace.evaluatedAt,
    },
    focus: clone(trace.root),
    selectedIntent: clone(
      (trace.root.kind === "intent"
        ? intents.find(({ key }) => key === trace.root.key)
        : intents[0]) ?? null,
    ),
    recentPrompts: clone(recentPrompts.slice(-MAX_RECENT_PROMPTS)),
    commits: clone(commits.slice(0, MAX_SELECTED_NODES)),
    files: clone(files.slice(0, MAX_SELECTED_NODES)),
    failureChains: clone(failureChains.slice(-MAX_FAILURE_CHAINS)),
    edges: boundedEdges,
    coverage: clone(trace.coverage),
    truncation: {
      commits: commits.length > MAX_SELECTED_NODES,
      files: files.length > MAX_SELECTED_NODES,
      recentPrompts: recentPrompts.length > MAX_RECENT_PROMPTS,
      failureChains: failureChains.length > MAX_FAILURE_CHAINS,
      directEdges: byStrength.direct.length > MAX_EDGES_PER_STRENGTH,
      observedEdges: byStrength.observed.length > MAX_EDGES_PER_STRENGTH,
      candidateEdges: byStrength.candidate.length > MAX_EDGES_PER_STRENGTH,
      contextualEdges: byStrength.contextual.length > MAX_EDGES_PER_STRENGTH,
    },
    notice: CONTINUATION_CONTEXT_NOTICE,
  });
}
