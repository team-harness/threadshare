import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_STATE,
  buildConversationMessagesRequest,
  buildConversationRequest,
  createDashboardStore,
  defaultHistoryDateRange,
  dashboardDiagnosticMessage,
  decimalCount,
  deliveryKindLabel,
  deliveryTraceViewModel,
  formatAge,
  formatBytes,
  humanizeDeliveryEdge,
  projectFilterViewModel,
  relatedTraceNodeKeys,
  reduceDashboardState,
  sourceCatalogViewModel,
} from "../src/insights-dashboard/state.js";

test("Dashboard state transitions keep capability pagination and evidence isolated", () => {
  const store = createDashboardStore();
  let notifications = 0;
  const unsubscribe = store.subscribe(() => { notifications += 1; });
  store.dispatch({ type: "view/select", view: "tool" });
  store.dispatch({ type: "capabilities/loading", kind: "tool" });
  store.dispatch({
    type: "capabilities/loaded",
    kind: "tool",
    append: false,
    page: { items: [{ capabilityKey: "a".repeat(64) }], nextCursor: "b".repeat(64) },
  });
  store.dispatch({
    type: "capabilities/loaded",
    kind: "tool",
    append: true,
    page: { items: [{ capabilityKey: "c".repeat(64) }], nextCursor: null },
  });
  store.dispatch({ type: "inspector/evidence-loading", turn: { turnKey: "d".repeat(64) }, append: false });
  store.dispatch({
    type: "inspector/evidence-loaded",
    append: false,
    page: { turn: { turnKey: "d".repeat(64) }, entries: [{ factKind: "event" }], nextCursor: "e".repeat(64) },
  });
  store.dispatch({
    type: "inspector/evidence-loaded",
    append: true,
    page: { turn: { turnKey: "d".repeat(64) }, entries: [{ factKind: "capability-use" }], nextCursor: null },
  });
  unsubscribe();
  assert.equal(notifications, 7);
  assert.deepEqual(store.getState().capabilities.tool.items.map((item) => item.capabilityKey), [
    "a".repeat(64),
    "c".repeat(64),
  ]);
  assert.equal(store.getState().capabilities.skill.items.length, 0);
  assert.deepEqual(store.getState().inspector.entries.map((item) => item.factKind), [
    "event",
    "capability-use",
  ]);
});

test("Dashboard reducer exposes loading, error, and empty states without mutation", () => {
  const loading = reduceDashboardState(INITIAL_STATE, { type: "status/loading" });
  const failed = reduceDashboardState(loading, { type: "status/failed", code: "TS_TEST" });
  const loaded = reduceDashboardState(failed, { type: "status/loaded", status: { state: "ready" } });
  assert.equal(INITIAL_STATE.statusState, "loading");
  assert.equal(INITIAL_STATE.delivery.mode, "date");
  assert.equal(failed.statusError, "TS_TEST");
  assert.equal(loaded.status.state, "ready");
  assert.equal(loaded.statusError, null);
});

test("Dashboard search loading state distinguishes a new query from pagination", () => {
  const fresh = reduceDashboardState(INITIAL_STATE, { type: "search/loading", append: false });
  const page = reduceDashboardState(INITIAL_STATE, { type: "search/loading", append: true });
  assert.equal(fresh.search.loading, true);
  assert.equal(fresh.search.loadingAppend, false);
  assert.equal(page.search.loadingAppend, true);
  const settled = reduceDashboardState(page, {
    type: "search/failed",
    code: "TS_QUERY_FAILED",
  });
  assert.equal(settled.search.loadingAppend, false);
});

test("Sources view model presents current adapters without inventing discovery state", () => {
  const status = {
    engine: { snapshotSeq: "17" },
    overview: {
      snapshotSeq: "17",
      providers: {
        items: [{
          provider: "codex",
          rawSessionCount: "12",
          eligibleSessionCount: "8",
          indexedTurnCount: "94",
        }],
      },
    },
  };
  const all = sourceCatalogViewModel(status, "all", "codex");
  assert.deepEqual(all.totals, {
    supportedSources: "2",
    snapshotSources: "1",
    eligibleSessions: "8",
    indexedTurns: "94",
  });
  assert.deepEqual(all.sources.map((source) => ({
    id: source.sourceAdapterId,
    inSnapshot: source.inSnapshot,
    eligible: source.hasEligibleSessions,
  })), [
    { id: "codex", inSnapshot: true, eligible: true },
    { id: "claude", inSnapshot: false, eligible: false },
  ]);
  assert.equal(all.selected.sourceAdapterId, "codex");
  assert.deepEqual(all.selected.operations.map((operation) => operation.state), [
    "supported", "supported", "indexed", "gated",
  ]);

  const eligible = sourceCatalogViewModel(status, "eligible", "claude");
  assert.deepEqual(eligible.visibleSources.map((source) => source.sourceAdapterId), ["codex"]);
  assert.equal(eligible.selected.sourceAdapterId, "codex");
  const empty = sourceCatalogViewModel({ overview: { providers: { items: [] } } }, "snapshot", "codex");
  assert.equal(empty.visibleSources.length, 0);
  assert.equal(empty.selected, null);
});

test("Dashboard source selection and scope are explicit state transitions", () => {
  const filtered = reduceDashboardState(INITIAL_STATE, { type: "sources/filter", filter: "eligible" });
  const selected = reduceDashboardState(filtered, { type: "sources/select", sourceAdapterId: "claude" });
  const invalid = reduceDashboardState(selected, { type: "sources/filter", filter: "future-value" });
  assert.equal(INITIAL_STATE.sources.filter, "all");
  assert.equal(filtered.sources.filter, "eligible");
  assert.equal(selected.sources.selectedId, "claude");
  assert.equal(invalid.sources.filter, "all");
});

test("Dashboard Experience repository and asset loading stay read-only state", () => {
  const repositoryKey = "a".repeat(64);
  const loading = reduceDashboardState(INITIAL_STATE, { type: "experience/repositories-loading" });
  const repositories = reduceDashboardState(loading, {
    type: "experience/repositories-loaded",
    response: { items: [{ repositoryKey, label: "threadshare" }] },
  });
  const assetsLoading = reduceDashboardState(repositories, { type: "experience/assets-loading" });
  const loaded = reduceDashboardState(assetsLoading, {
    type: "experience/assets-loaded",
    response: {
      format: "threadshare-insights-dashboard-memory-assets@v1",
      assets: [{ kind: "entry", id: "release-checks" }],
    },
  });
  assert.equal(INITIAL_STATE.activeView, "search");
  assert.equal(repositories.experience.repositoryKey, repositoryKey);
  assert.equal(loaded.experience.loading, false);
  assert.equal(loaded.experience.assets.assets[0].id, "release-checks");
});

test("Dashboard conversation requests are bounded and preserve UTC filters", () => {
  assert.deepEqual(defaultHistoryDateRange(Date.parse("2026-08-27T16:45:00.000Z")), {
    observedAtOrAfter: "2026-08-14",
    observedBefore: "2026-08-28",
  });
  assert.throws(() => defaultHistoryDateRange(Number.NaN), /valid timestamp/u);
  assert.deepEqual(buildConversationRequest({
    query: "  Bash timeout  ",
    provider: "codex",
    projectKey: "f".repeat(64),
    observedAtOrAfter: "2026-08-01",
    observedBefore: "2026-08-11",
    toolCapabilityKey: "a".repeat(64),
    skillCapabilityKey: "b".repeat(64),
    completeness: "full",
  }, "cursor-page-2"), {
    after: "2026-08-01T00:00:00.000Z",
    before: "2026-08-11T00:00:00.000Z",
    provider: "codex",
    projectKey: "f".repeat(64),
    query: "Bash timeout",
    toolCapabilityKey: "a".repeat(64),
    skillCapabilityKey: "b".repeat(64),
    completeness: "full",
    cursor: "cursor-page-2",
    limit: 30,
  });
  assert.deepEqual(buildConversationRequest({ query: "", provider: "claude" }), {
    after: null,
    before: null,
    provider: "claude",
    projectKey: null,
    query: "",
    toolCapabilityKey: null,
    skillCapabilityKey: null,
    completeness: null,
    cursor: null,
    limit: 30,
  });
  assert.deepEqual(buildConversationMessagesRequest("c".repeat(64), "page-2"), {
    sessionKey: "c".repeat(64), cursor: "page-2", limit: 20,
  });
});

test("Project filter exposes registered labels and never materializes anonymous rollups", () => {
  const registeredKey = "a".repeat(64);
  const anonymousKey = "b".repeat(64);
  const model = projectFilterViewModel({
    overview: {
      projects: {
        items: [
          { projectKey: registeredKey, rawSessionCount: "4", eligibleSessionCount: "4", indexedTurnCount: "18" },
          { projectKey: anonymousKey, rawSessionCount: "1", eligibleSessionCount: "1", indexedTurnCount: "1" },
        ],
        truncated: true,
      },
    },
  }, {
    loaded: true,
    items: [{ projectKey: registeredKey, repositoryKey: "c".repeat(64), provider: "codex", label: "threadshare" }],
  });
  assert.deepEqual(model.options, [{
    projectKey: registeredKey,
    repositoryKey: "c".repeat(64),
    provider: "codex",
    label: "threadshare",
    indexedTurnCount: "18",
    rawSessionCount: "4",
    eligibleSessionCount: "4",
  }]);
  assert.equal(model.options.some((item) => item.projectKey === anonymousKey), false);
  assert.match(model.message, /registered projects only/u);
});

test("Dashboard scalar formatters tolerate protocol decimal strings", () => {
  assert.equal(decimalCount("1200"), 1200);
  assert.equal(decimalCount("01"), 0);
  assert.equal(formatBytes("1536"), "1.5 KiB");
  assert.equal(formatAge(null), "unknown");
  assert.equal(formatAge(""), "unknown");
  assert.equal(formatAge(90_000), "2 min");
});

test("Inspector related highlighting is derived only from response edges", () => {
  const commitKey = "a".repeat(64);
  const linkedFileKey = "b".repeat(64);
  const sameNamedFileKey = "c".repeat(64);
  const trace = {
    nodes: [
      { kind: "git-commit", key: commitKey },
      { kind: "file", key: linkedFileKey, attributes: { path: "src/app.js" } },
      { kind: "file", key: sameNamedFileKey, attributes: { path: "src/app.js" } },
    ],
    edges: [{
      from: { kind: "git-commit", key: commitKey },
      to: { kind: "file", key: linkedFileKey },
      relation: "commit-changed-file",
    }],
  };
  assert.deepEqual(relatedTraceNodeKeys(trace, { kind: "git-commit", key: commitKey }), [
    `file:${linkedFileKey}`,
  ]);
  assert.deepEqual(relatedTraceNodeKeys({ ...trace, edges: [] }, {
    kind: "git-commit", key: commitKey,
  }), []);
});

test("Delivery Trace view model leads with a readable outcome and evidence boundary", () => {
  const commit = { kind: "git-commit", key: "a".repeat(64), label: "feat: ship trace" };
  const session = { kind: "session", key: "b".repeat(64), label: "Codex session" };
  const file = { kind: "file", key: "c".repeat(64), attributes: { path: "src/app.js" } };
  const trace = {
    root: { kind: commit.kind, key: commit.key },
    nodes: [commit, session, file],
    edges: [{
      relation: "session-correlates-commit",
      from: { kind: session.kind, key: session.key },
      to: { kind: commit.kind, key: commit.key },
      strength: "observed",
      source: "ordered-exact-path-overlap",
      limitations: ["not-authorship", "not-exclusive-line-attribution"],
    }],
  };
  const view = deliveryTraceViewModel(trace);
  assert.equal(view.title, "feat: ship trace");
  assert.equal(view.summary, "1 Agent session and 1 changed file are linked to this commit.");
  assert.equal(view.evidence, "Observed evidence links these items.");
  assert.equal(view.edgeCount, 1);
  assert.deepEqual(view.limitations, [
    "This link does not prove who authored the commit.",
    "This link does not prove that every changed line came from this Agent session.",
  ]);
  assert.equal(deliveryKindLabel("session"), "Agent session");
  assert.equal(deliveryTraceViewModel({ root: commit, nodes: [commit], edges: [] }).evidence,
    "No delivery evidence is linked yet.");
});

test("Delivery evidence and diagnostics never expose internal enum names as primary copy", () => {
  assert.deepEqual(humanizeDeliveryEdge({
    relation: "session-observed-commit",
    strength: "direct",
    source: "observed-git-result",
    limitations: ["not-authorship"],
  }), {
    relation: "Agent observed this commit result",
    strength: "Direct evidence",
    source: "Successful git commit output observed in the Agent session",
    limitations: ["This link does not prove who authored the commit."],
  });
  assert.equal(
    dashboardDiagnosticMessage("TS_INSIGHTS_STORAGE_FAILED"),
    "Some delivery details could not be read. Refresh this view, or run `threadshare insights sync --repository .`.",
  );
});
