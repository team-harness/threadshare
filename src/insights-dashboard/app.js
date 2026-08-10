import {
  INITIAL_STATE,
  buildSearchRequest,
  createDashboardStore,
  errorCode,
  formatAge,
  formatBytes,
  formatCount,
  overviewCounts,
} from "/state.js";

const store = createDashboardStore(INITIAL_STATE);
const elements = Object.freeze({
  statusStrip: document.querySelector("#status-strip"),
  snapshotLabel: document.querySelector("#snapshot-label"),
  indexMeta: document.querySelector("#index-meta"),
  overviewMetrics: document.querySelector("#overview-metrics"),
  overviewUpdated: document.querySelector("#overview-updated"),
  coverageList: document.querySelector("#coverage-list"),
  providerRows: document.querySelector("#provider-rows"),
  diagnosticList: document.querySelector("#diagnostic-list"),
  projectFilter: document.querySelector("#project-filter"),
  projectOptions: document.querySelector("#project-options"),
  projectFilterState: document.querySelector("#project-filter-state"),
  searchSummary: document.querySelector("#search-summary"),
  searchRows: document.querySelector("#search-rows"),
  pathSummary: document.querySelector("#path-summary"),
  pathList: document.querySelector("#path-list"),
  skillRows: document.querySelector("#skill-rows"),
  toolRows: document.querySelector("#tool-rows"),
  inspector: document.querySelector("#inspector"),
  inspectorTitle: document.querySelector("#inspector-title"),
  inspectorBody: document.querySelector("#inspector-body"),
  evidenceMore: document.querySelector("#evidence-more"),
  toast: document.querySelector("#toast"),
});

let toastTimer = null;

function node(tag, options = {}, children = []) {
  const value = document.createElement(tag);
  for (const [key, item] of Object.entries(options)) {
    if (key === "className") value.className = item;
    else if (key === "text") value.textContent = item;
    else if (key === "dataset") Object.assign(value.dataset, item);
    else if (key === "title") value.title = item;
    else value.setAttribute(key, item);
  }
  for (const child of children) value.append(child);
  return value;
}

function clear(element) {
  element.replaceChildren();
}

function showToast(message) {
  clearTimeout(toastTimer);
  elements.toast.textContent = message;
  elements.toast.classList.remove("is-hidden");
  toastTimer = setTimeout(() => elements.toast.classList.add("is-hidden"), 4_000);
}

async function requestJson(url, options = {}) {
  const response = await fetch(url, {
    ...options,
    headers: {
      Accept: "application/json",
      ...(options.body === undefined ? {} : { "Content-Type": "application/json" }),
      ...options.headers,
    },
  });
  const value = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error("Dashboard request failed");
    error.code = value?.error?.code ?? "TS_OPERATION_FAILED";
    throw error;
  }
  return value;
}

function badge(label, tone = "neutral") {
  return node("span", { className: `badge badge-${tone}`, text: label });
}

function metric(label, value, detail) {
  const children = [
    node("span", { className: "metric-label", text: label }),
    node("strong", { text: formatCount(value) }),
  ];
  if (detail) children.push(node("span", { className: "metric-detail", text: detail }));
  return node("div", { className: "metric" }, children);
}

function cell(value, className) {
  return node("td", { ...(className ? { className } : {}), text: String(value ?? "-") });
}

function emptyRow(columns, label) {
  return node("tr", {}, [node("td", { className: "empty-cell", colspan: String(columns), text: label })]);
}

function renderStatus(state) {
  const status = state.status;
  clear(elements.statusStrip);
  if (state.statusState === "loading" && status === null) {
    elements.statusStrip.append(badge("Loading", "pending"));
    elements.snapshotLabel.textContent = "Loading committed snapshot";
    return;
  }
  if (state.statusState === "error") {
    elements.statusStrip.append(badge("Status unavailable", "danger"));
    elements.snapshotLabel.textContent = state.statusError;
    return;
  }
  if (status === null) return;
  const worker = status.worker;
  const engineAvailable = status.engine !== null;
  const purge = status.engine?.purge?.state ?? "idle";
  const pending = status.engine?.snapshotPending || worker?.running || worker?.queued;
  elements.statusStrip.append(
    badge(status.state === "ready" ? "Index ready" : status.state, status.state === "ready" ? "ok" : "pending"),
    badge(!engineAvailable ? "Snapshot unknown" : pending ? "Update pending" : "Snapshot committed", pending ? "pending" : "neutral"),
    badge(purge === "idle" || purge === "purged" ? "Purge clear" : purge, purge === "idle" || purge === "purged" ? "neutral" : "danger"),
  );
  elements.snapshotLabel.textContent = status.engine === null
    ? "Waiting for the first committed snapshot"
    : `Snapshot ${status.engine.snapshotSeq} / ${formatAge(status.engine.snapshotAgeMs)} old`;
  clear(elements.indexMeta);
  elements.indexMeta.append(
    node("span", { className: "meta-label", text: "Index" }),
    node("strong", { text: formatBytes(status.index?.bytes) }),
    node("span", { className: "path-value", text: status.index?.location ?? "Not created", title: status.index?.location ?? "" }),
    node("span", { className: "meta-label", text: "Progress" }),
    node("span", { text: worker?.progress === null || worker?.progress === undefined
      ? "Idle"
      : `${formatCount(worker.progress.committed)} / ${formatCount(worker.progress.planned)} sessions` }),
    node("span", { text: worker?.progress?.bytesTotal === null || worker?.progress?.bytesTotal === undefined
      ? "Byte progress unavailable"
      : `${formatBytes(worker.progress.bytesProcessed)} / ${formatBytes(worker.progress.bytesTotal)}` }),
    node("span", { className: "meta-label", text: "Facts" }),
    node("span", { text: status.engine?.factStorageProfile ?? "Unavailable" }),
  );
}

function renderProjectOptions(state) {
  const projectPage = overviewCounts(state.status).projects ?? { items: [], truncated: false };
  const projects = projectPage.items ?? [];
  const signature = `${projectPage.truncated}:${projects.map((item) => item.projectKey).join(":")}`;
  if (elements.projectOptions.dataset.signature === signature) return;
  const selected = state.search.projectKey;
  clear(elements.projectOptions);
  for (const project of projects) {
    const label = `${project.projectKey.slice(0, 10)} / ${formatCount(project.indexedTurnCount)} turns`;
    elements.projectOptions.append(node("option", {
      value: project.projectKey,
      label,
      title: project.projectKey,
    }));
  }
  elements.projectFilter.value = selected;
  elements.projectFilterState.hidden = !projectPage.truncated;
  elements.projectOptions.dataset.signature = signature;
}

function renderCapabilityOptions(state, kind) {
  const select = document.querySelector(`#${kind}-filter`);
  const page = state.capabilities[kind];
  const signature = page.items.map((item) => item.capabilityKey).join(":");
  if (select.dataset.signature === signature) return;
  const field = `${kind}CapabilityKey`;
  const selected = state.search[field];
  clear(select);
  select.append(node("option", { value: "", text: page.loading ? "Loading" : "All" }));
  for (const capability of page.items) {
    select.append(node("option", {
      value: capability.capabilityKey,
      text: `${capability.provider}:${capability.canonicalName}`,
    }));
  }
  select.value = page.items.some((item) => item.capabilityKey === selected) ? selected : "";
  select.dataset.signature = signature;
}

function renderOverview(state) {
  const status = state.status;
  const overview = overviewCounts(status);
  clear(elements.overviewMetrics);
  if (status === null || overview === null || Object.keys(overview).length === 0) {
    elements.overviewMetrics.append(node("p", { className: "empty-copy", text: "No committed index data yet." }));
    clear(elements.coverageList);
    clear(elements.providerRows);
    elements.providerRows.append(emptyRow(4, "Provider totals will appear after indexing."));
    return;
  }
  elements.overviewMetrics.append(
    metric("Eligible sessions", overview.sessions?.eligible, `${formatCount(overview.sessions?.raw)} observed`),
    metric("Excluded sessions", overview.sessions?.excluded, `${formatCount(overview.sessions?.subagentExcluded)} file subagent`),
    metric("Indexed turns", overview.turns?.indexed, `${formatCount(overview.turns?.open)} open`),
    metric("Hard sealed", overview.turns?.hardSealed, `${formatCount(overview.turns?.quiescent)} quiescent`),
    metric("Tools", overview.capabilities?.tool, `${formatCount(overview.capabilities?.total)} capabilities`),
    metric("Skills", overview.capabilities?.skill, "observed load evidence"),
    metric("Strong groups", overview.dedupe?.strongGroup, `${formatCount(overview.dedupe?.weakGroup)} weak`),
    metric("Provisional dedupe", overview.dedupe?.observedEofProvisionalSession, `${formatCount(overview.dedupe?.unknownSession)} unknown`),
    metric("Unknown scope", overview.scopes?.unknown, `${formatCount(overview.sessions?.unknown)} unknown sessions`),
    metric("Rolled back", overview.turns?.rolledBack, "excluded from search"),
  );
  elements.overviewUpdated.textContent = status.engine === null ? "" : `Snapshot age ${formatAge(status.engine.snapshotAgeMs)}`;

  const coverage = overview.coverage?.items ?? [];
  const coverageByKey = new Map(coverage.map((item) => [item.key, item]));
  const requiredCoverageKeys = [
    "file-subagent-excluded",
    "inline-subagent-record",
    "sidechain-record",
    "unnamed-subagent-file-skipped",
    "unknown-session-scope",
    "file-scope-unknown",
    "ambiguous-session-skipped",
    "records",
  ];
  const orderedCoverage = [
    ...requiredCoverageKeys.map((key) => coverageByKey.get(key) ?? { key, count: "0" }),
    ...coverage.filter((item) => !requiredCoverageKeys.includes(item.key)),
  ];
  clear(elements.coverageList);
  const maximum = Math.max(1, ...orderedCoverage.map((item) => Number(item.count ?? 0)));
  for (const item of orderedCoverage) {
    const fill = node("span", { className: "bar-fill" });
    fill.style.width = `${Math.max(2, Math.round(Number(item.count ?? 0) / maximum * 100))}%`;
    elements.coverageList.append(node("div", { className: "bar-row" }, [
      node("span", { className: "bar-label", text: item.key }),
      node("span", { className: "bar-track" }, [fill]),
      node("strong", { text: formatCount(item.count) }),
    ]));
  }
  if (overview.coverage?.truncated) {
    elements.coverageList.append(node("div", { className: "diagnostic-row" }, [
      node("code", { text: "coverage-signals-grouped" }),
      badge("bounded", "pending"),
    ]));
  }

  clear(elements.providerRows);
  for (const provider of overview.providers?.items ?? []) {
    elements.providerRows.append(node("tr", {}, [
      cell(provider.provider), cell(formatCount(provider.rawSessionCount), "numeric"),
      cell(formatCount(provider.eligibleSessionCount), "numeric"), cell(formatCount(provider.indexedTurnCount), "numeric"),
    ]));
  }
  if ((overview.providers?.items ?? []).length === 0) elements.providerRows.append(emptyRow(4, "No eligible provider data."));

  const diagnostics = [
    ...(status.worker?.recentError === null || status.worker?.recentError === undefined
      ? []
      : [{ code: status.worker.recentError.code, count: 1 }]),
    ...(status.recentError === null || status.recentError === undefined
      ? []
      : [{ code: status.recentError.code, count: 1 }]),
    ...(status.diagnostics ?? []).map((code) => ({ code, count: 1 })),
    ...(status.worker?.discoveryDiagnostics ?? []),
    ...(overview.diagnostics?.items ?? []),
  ];
  clear(elements.diagnosticList);
  for (const item of diagnostics) {
    elements.diagnosticList.append(node("div", { className: "diagnostic-row" }, [
      node("code", { text: item.code ?? item.key }),
      node("strong", { text: formatCount(item.count) }),
    ]));
  }
  if (overview.diagnostics?.truncated) {
    elements.diagnosticList.append(node("div", { className: "diagnostic-row" }, [
      node("code", { text: "diagnostic-signals-grouped" }),
      badge("bounded", "pending"),
    ]));
  }
  if (diagnostics.length === 0) elements.diagnosticList.append(node("p", { className: "empty-copy", text: "No recent diagnostics." }));
}

function scoreText(score) {
  if (score === null || score === undefined) return "-";
  return (Number(score.relevancePpm ?? 0) / 10_000).toFixed(1);
}

function renderSearch(state) {
  const search = state.search;
  const response = search.response;
  clear(elements.searchRows);
  clear(elements.pathList);
  if (search.loading) {
    elements.searchSummary.textContent = "Searching committed snapshot...";
    elements.searchRows.append(emptyRow(5, "Searching"));
    return;
  }
  if (search.error) {
    elements.searchSummary.textContent = search.error;
    elements.searchRows.append(emptyRow(5, "Search did not complete."));
    return;
  }
  if (response === null) {
    elements.searchSummary.textContent = "";
    elements.searchRows.append(emptyRow(5, "Enter a query to search indexed turns."));
    elements.pathSummary.textContent = "";
    return;
  }
  const results = response.results ?? [];
  elements.searchSummary.textContent = `${formatCount(results.length)} results / ${formatCount(response.searchTrace?.candidateCount)} candidates / snapshot ${response.snapshot?.snapshotSeq ?? "-"}`;
  for (const result of results) {
    const button = node("button", { className: "turn-button", type: "button", text: result.problemExcerpt || "Untitled turn" });
    button.addEventListener("click", () => loadEvidence(result, null, false));
    elements.searchRows.append(node("tr", {}, [
      node("td", {}, [button, node("span", { className: "row-detail", text: result.observedTimestamp ?? "Timestamp unavailable" })]),
      cell(result.provider), cell(result.closureState), cell(result.resultEvidence), cell(scoreText(result.score), "numeric"),
    ]));
  }
  if (results.length === 0) elements.searchRows.append(emptyRow(5, "No indexed turns matched this query."));

  const paths = response.evidencePaths;
  elements.pathSummary.textContent = paths === undefined
    ? ""
    : paths.insufficientSample
      ? `${formatCount(paths.eligibleTurnCount)} eligible turns / insufficient sample`
      : `${formatCount(paths.families?.length)} families / ${formatCount(paths.independentGroupCount)} independent groups`;
  for (const family of paths?.families ?? []) {
    const pathButton = node("button", { className: "path-button", type: "button" }, [
      node("span", { className: "path-sequence", text: (family.nodes ?? []).map((item) => `${item.providerScopedName} x${item.repeatBucket}`).join("  >  ") }),
      node("span", { className: "path-meta", text: `${formatCount(family.turnCount)} turns / ${formatCount(family.independentGroupCount)} groups` }),
    ]);
    pathButton.addEventListener("click", () => store.dispatch({ type: "inspector/family", family }));
    elements.pathList.append(pathButton);
  }
  if ((paths?.families ?? []).length === 0) elements.pathList.append(node("p", { className: "empty-copy", text: "No evidence-backed Tool path for this result set." }));
}

function capabilityResultSummary(item) {
  const states = item.terminal ?? {};
  const completed = formatCount(states.completed);
  const failed = formatCount(states.failed);
  return `${completed} complete / ${failed} failed`;
}

function capabilityEvidenceSummary(item) {
  const strengths = item.strength ?? {};
  return `observed ${formatCount(strengths.observed)} / confirmed ${formatCount(strengths.confirmed)} / inferred ${formatCount(strengths.inferred)}`;
}

function renderCapabilities(state, kind) {
  const page = state.capabilities[kind];
  const rows = kind === "tool" ? elements.toolRows : elements.skillRows;
  clear(rows);
  for (const item of page.items) {
    rows.append(node("tr", {}, [
      node("td", {}, [node("strong", { text: item.canonicalName }), node("span", { className: "row-detail", text: item.capabilityKey.slice(0, 12) })]),
      cell(item.provider), cell(formatCount(item.useCount), "numeric"), cell(formatCount(item.turnCount), "numeric"), cell(formatCount(item.sessionCount), "numeric"),
      cell(kind === "tool" ? capabilityResultSummary(item) : capabilityEvidenceSummary(item)),
    ]));
  }
  if (page.loading && page.items.length === 0) rows.append(emptyRow(6, `Loading ${kind}s...`));
  else if (page.error) rows.append(emptyRow(6, page.error));
  else if (page.items.length === 0) rows.append(emptyRow(6, `No indexed ${kind}s.`));
  const button = document.querySelector(`[data-load-more="${kind}"]`);
  button.hidden = page.cursor === null;
  button.disabled = page.loading;
  button.textContent = page.loading ? "Loading..." : page.items.length === 0 ? `Load ${kind}s` : "Load more";
}

function detailRow(label, value) {
  return node("div", { className: "detail-row" }, [node("span", { text: label }), node("strong", { text: String(value ?? "-") })]);
}

function renderInspector(state) {
  const inspector = state.inspector;
  document.querySelector("#app").classList.toggle("inspector-open", inspector.mode !== "closed");
  elements.inspector.classList.toggle("is-closed", inspector.mode === "closed");
  elements.inspector.setAttribute("aria-hidden", inspector.mode === "closed" ? "true" : "false");
  elements.inspectorTitle.textContent = inspector.title;
  clear(elements.inspectorBody);
  elements.evidenceMore.hidden = true;
  if (inspector.mode === "family" && inspector.family !== null) {
    const family = inspector.family;
    elements.inspectorBody.append(
      node("div", { className: "detail-list" }, [
        detailRow("Turns", formatCount(family.turnCount)),
        detailRow("Raw sessions", formatCount(family.rawSessionCount)),
        detailRow("Independent groups", formatCount(family.independentGroupCount)),
        detailRow("Strong / weak", `${formatCount(family.strongGroupCount)} / ${formatCount(family.weakGroupCount)}`),
        detailRow("Provisional", formatCount(family.observedEofProvisionalGroupCount)),
        detailRow("Unknown dedupe sessions", formatCount(family.unknownDedupeSessionCount)),
      ]),
      node("ol", { className: "path-detail" }, (family.nodes ?? []).map((item) => node("li", {}, [
        node("strong", { text: item.providerScopedName }),
        node("span", { text: `repeat ${item.repeatBucket}` }),
      ]))),
    );
    return;
  }
  if (inspector.mode === "turn") {
    if (inspector.loading && inspector.entries.length === 0) {
      elements.inspectorBody.append(node("p", { className: "empty-copy", text: "Loading evidence..." }));
      return;
    }
    if (inspector.error) {
      elements.inspectorBody.append(node("p", { className: "error-copy", text: inspector.error }));
      return;
    }
    const turn = inspector.turn;
    if (turn !== null) {
      elements.inspectorBody.append(
        node("p", { className: "turn-problem", text: turn.problemText ?? "Problem text unavailable" }),
        node("div", { className: "detail-list" }, [
          detailRow("Visibility", turn.providerVisibility),
          detailRow("Terminal", turn.providerTerminal ?? "unknown"),
          detailRow("Observed", turn.observedTimestamp ?? "unknown"),
          detailRow("Truncation", (turn.factTruncation ?? []).join(", ") || "none"),
        ]),
      );
    }
    const list = node("div", { className: "evidence-list" });
    for (const entry of inspector.entries) {
      const fact = entry.fact ?? {};
      const kind = entry.factKind ?? "fact";
      list.append(node("div", { className: "evidence-item" }, [
        node("div", { className: "evidence-kind" }, [badge(kind), node("span", { text: fact.payload?.kind ?? fact.capabilityKind ?? fact.role ?? "observed" })]),
        node("strong", { text: fact.canonicalName ?? fact.exactObservedName ?? fact.providerState ?? fact.payload?.providerState ?? "Recorded evidence" }),
        node("span", { className: "row-detail", text: fact.observedTimestamp ?? `origin ${fact.originScope ?? "unknown"}` }),
      ]));
    }
    if (inspector.entries.length === 0) list.append(node("p", { className: "empty-copy", text: "No retained evidence entries." }));
    elements.inspectorBody.append(list);
    elements.evidenceMore.hidden = inspector.cursor === null;
    elements.evidenceMore.disabled = inspector.loading;
  }
}

function render(state) {
  for (const button of document.querySelectorAll("[data-view]")) {
    const selected = button.dataset.view === state.activeView;
    button.setAttribute("aria-current", selected ? "page" : "false");
  }
  for (const panel of document.querySelectorAll("[data-view-panel]")) {
    panel.classList.toggle("is-hidden", panel.dataset.viewPanel !== state.activeView);
  }
  renderStatus(state);
  renderProjectOptions(state);
  renderCapabilityOptions(state, "tool");
  renderCapabilityOptions(state, "skill");
  renderOverview(state);
  renderSearch(state);
  renderCapabilities(state, "tool");
  renderCapabilities(state, "skill");
  renderInspector(state);
}

let statusRequest = null;
function loadStatus({ silent = false } = {}) {
  if (statusRequest !== null) return statusRequest;
  if (!silent) store.dispatch({ type: "status/loading" });
  statusRequest = (async () => {
    try {
      store.dispatch({ type: "status/loaded", status: await requestJson("/api/v1/status") });
    } catch (error) {
      store.dispatch({ type: "status/failed", code: errorCode(error) });
    }
  })().finally(() => { statusRequest = null; });
  return statusRequest;
}

async function loadCapabilities(kind, append = false) {
  const page = store.getState().capabilities[kind];
  if (page.loading || (append && page.cursor === null)) return;
  store.dispatch({ type: "capabilities/loading", kind });
  const parameters = new URLSearchParams({ kind, limit: "200" });
  if (append && page.cursor !== null) parameters.set("cursor", page.cursor);
  try {
    const response = await requestJson(`/api/v1/capabilities?${parameters}`);
    store.dispatch({ type: "capabilities/loaded", kind, page: response, append });
  } catch (error) {
    store.dispatch({ type: "capabilities/failed", kind, code: errorCode(error) });
  }
}

async function runSearch() {
  const request = buildSearchRequest(store.getState().search);
  store.dispatch({ type: "search/loading" });
  try {
    const response = await requestJson("/api/v1/search", { method: "POST", body: JSON.stringify(request) });
    store.dispatch({ type: "search/loaded", response });
  } catch (error) {
    store.dispatch({ type: "search/failed", code: errorCode(error) });
  }
}

async function loadEvidence(turn, cursor = null, append = false) {
  const current = turn ?? store.getState().inspector.turn;
  if (current === null) return;
  store.dispatch({ type: "inspector/evidence-loading", turn: current, append });
  try {
    const page = await requestJson("/api/v1/turn-evidence", {
      method: "POST",
      body: JSON.stringify({
        turnKey: current.turnKey,
        expectedRevision: current.revision,
        cursor,
        limit: 64,
      }),
    });
    store.dispatch({ type: "inspector/evidence-loaded", page, append });
  } catch (error) {
    store.dispatch({ type: "inspector/evidence-failed", code: errorCode(error) });
  }
}

store.subscribe(render);

for (const button of document.querySelectorAll("[data-view]")) {
  button.addEventListener("click", () => {
    const view = button.dataset.view;
    store.dispatch({ type: "view/select", view });
    if (view === "tool" || view === "skill") {
      const page = store.getState().capabilities[view];
      if (page.items.length === 0 && !page.loading) void loadCapabilities(view);
    }
    if (view === "search") {
      for (const kind of ["tool", "skill"]) {
        const page = store.getState().capabilities[kind];
        if (page.items.length === 0 && !page.loading) void loadCapabilities(kind);
      }
    }
    document.querySelector("#workspace").focus({ preventScroll: true });
  });
}

document.querySelector("#refresh-button").addEventListener("click", () => void loadStatus());
document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void runSearch();
});
for (const [selector, field] of [
  ["#search-query", "query"],
  ["#provider-filter", "provider"],
  ["#project-filter", "projectKey"],
  ["#after-filter", "observedAtOrAfter"],
  ["#before-filter", "observedBefore"],
  ["#tool-filter", "toolCapabilityKey"],
  ["#skill-filter", "skillCapabilityKey"],
  ["#closure-filter", "closure"],
  ["#result-filter", "resultEvidence"],
]) {
  document.querySelector(selector).addEventListener("input", (event) => {
    store.dispatch({ type: "search/input", field, value: event.target.value });
  });
}
for (const button of document.querySelectorAll("[data-load-more]")) {
  button.addEventListener("click", () => void loadCapabilities(button.dataset.loadMore, true));
}
document.querySelector("#inspector-close").addEventListener("click", () => store.dispatch({ type: "inspector/close" }));
elements.evidenceMore.addEventListener("click", () => {
  const inspector = store.getState().inspector;
  void loadEvidence(inspector.turn, inspector.cursor, true);
});
window.addEventListener("unhandledrejection", (event) => {
  event.preventDefault();
  showToast(errorCode(event.reason));
});
document.addEventListener("visibilitychange", () => {
  if (document.visibilityState === "visible") void loadStatus({ silent: true });
});

render(store.getState());
void loadStatus();
const statusTimer = setInterval(() => void loadStatus({ silent: true }), 30_000);
window.addEventListener("pagehide", () => clearInterval(statusTimer), { once: true });
