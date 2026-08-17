import assert from "node:assert/strict";
import test from "node:test";

import {
  INITIAL_STATE,
  buildSearchRequest,
  createDashboardStore,
  dashboardDiagnosticMessage,
  decimalCount,
  deliveryKindLabel,
  deliveryTraceViewModel,
  formatAge,
  formatBytes,
  humanizeDeliveryEdge,
  relatedTraceNodeKeys,
  reduceDashboardState,
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

test("Dashboard search requests keep server-owned time and use bounded filters", () => {
  assert.deepEqual(buildSearchRequest({
    query: "  Bash timeout  ",
    provider: "codex",
    projectKey: "f".repeat(64),
    observedAtOrAfter: "2026-08-01",
    observedBefore: "2026-08-11",
    toolCapabilityKey: "a".repeat(64),
    skillCapabilityKey: "b".repeat(64),
    closure: "hard-sealed",
    resultEvidence: "provider-completed",
  }), {
    query: "Bash timeout",
    filters: {
      providers: ["codex"],
      projectKeys: ["f".repeat(64)],
      observedAtOrAfterUnixMs: "1785542400000",
      observedBeforeUnixMs: "1786406400000",
      toolCapabilityKeys: ["a".repeat(64)],
      skillCapabilityKeys: ["b".repeat(64)],
      resultEvidence: ["provider-completed"],
      closureStates: ["hard-sealed"],
    },
    limit: 50,
    pathLimit: 10,
  });
  assert.equal(Object.hasOwn(buildSearchRequest({ query: "x" }), "nowUnixMs"), false);
  assert.deepEqual(buildSearchRequest({ query: "", provider: "claude" }), {
    query: "",
    filters: {
      providers: ["claude"],
      projectKeys: [],
      observedAtOrAfterUnixMs: null,
      observedBeforeUnixMs: null,
      toolCapabilityKeys: [],
      skillCapabilityKeys: [],
      resultEvidence: [],
      closureStates: [],
    },
    limit: 50,
    pathLimit: 10,
  });
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
