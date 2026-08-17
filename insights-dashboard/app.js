import {
  INITIAL_STATE,
  buildDeliveryTraceRequest,
  buildInspectorEdgeRequest,
  buildSearchRequest,
  createDashboardStore,
  dashboardDiagnosticMessage,
  deliveryKindLabel,
  deliveryTraceViewModel,
  errorCode,
  formatAge,
  formatBytes,
  formatCount,
  humanizeDeliveryEdge,
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
  deliveryRepository: document.querySelector("#delivery-repository"),
  deliveryAfter: document.querySelector("#delivery-after"),
  deliveryBefore: document.querySelector("#delivery-before"),
  deliveryStatus: document.querySelector("#delivery-status"),
  deliverySummary: document.querySelector("#delivery-summary"),
  deliveryRailCount: document.querySelector("#delivery-rail-count"),
  deliveryRailHeading: document.querySelector("#delivery-rail-heading"),
  deliveryRailList: document.querySelector("#delivery-rail-list"),
  deliveryMore: document.querySelector("#delivery-more"),
  promptLane: document.querySelector("#prompt-lane"),
  activityLane: document.querySelector("#activity-lane"),
  deliveryLane: document.querySelector("#delivery-lane"),
  promptLaneCount: document.querySelector("#prompt-lane-count"),
  activityLaneCount: document.querySelector("#activity-lane-count"),
  deliveryLaneCount: document.querySelector("#delivery-lane-count"),
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
  const indexPresent = Number(status.index?.bytes ?? 0) > 0;
  if (!engineAvailable) {
    elements.statusStrip.append(
      badge(indexPresent ? "Index on disk" : "Not indexed", indexPresent ? "neutral" : "pending"),
      badge("Live status unavailable", "pending"),
    );
    elements.snapshotLabel.textContent = indexPresent
      ? "Saved index found; live health details were not checked"
      : "Run Insights sync to create the first index";
    clear(elements.indexMeta);
    elements.indexMeta.append(
      node("span", { className: "meta-label", text: "Index" }),
      node("strong", { text: formatBytes(status.index?.bytes) }),
      node("span", { className: "path-value", text: status.index?.location ?? "Not created", title: status.index?.location ?? "" }),
      node("span", { className: "meta-label", text: "Progress" }),
      node("span", { text: worker?.progress === null || worker?.progress === undefined
        ? "Idle"
        : `${formatCount(worker.progress.committed)} / ${formatCount(worker.progress.planned)} sessions` }),
      node("span", { className: "meta-label", text: "Health" }),
      node("span", { text: "Live check skipped" }),
    );
    return;
  }
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

function traceIdentity(value) {
  return `${value.kind}:${value.key}`;
}

function traceTone(strength) {
  if (strength === "direct") return "ok";
  if (strength === "observed") return "neutral";
  return "pending";
}

function readableSlug(value) {
  return String(value ?? "")
    .split("-")
    .filter(Boolean)
    .map((part) => `${part.slice(0, 1).toUpperCase()}${part.slice(1)}`)
    .join(" ");
}

function readableTimestamp(value) {
  const parsed = Date.parse(value ?? "");
  if (!Number.isFinite(parsed)) return "Time not recorded";
  return new Intl.DateTimeFormat("en-US", {
    dateStyle: "medium",
    timeStyle: "short",
    timeZone: "UTC",
  }).format(parsed);
}

function traceNodeButton(item, delivery) {
  const identity = traceIdentity(item);
  const selected = traceIdentity(delivery.selected ?? {}) === identity;
  const related = delivery.relatedNodeKeys.includes(identity);
  const button = node("button", {
    className: `trace-node${selected ? " is-selected" : ""}${related ? " is-related" : ""}`,
    type: "button",
  }, [
    node("span", { className: "trace-node-kind", text: deliveryKindLabel(item.kind) }),
    node("strong", { text: item.label || item.attributes?.path || item.key.slice(0, 12) }),
    node("span", { className: "trace-node-time", text: readableTimestamp(item.observedAt) }),
  ]);
  button.addEventListener("click", () => store.dispatch({ type: "delivery/select", node: item }));
  return button;
}

function renderDeliveryRepositories(delivery) {
  const signature = delivery.repositories.map((item) => `${item.repositoryKey}:${item.label}`).join("|");
  if (elements.deliveryRepository.dataset.signature === signature) return;
  clear(elements.deliveryRepository);
  if (delivery.repositories.length === 0) {
    elements.deliveryRepository.append(node("option", { value: "", text: "No registered repository" }));
  } else {
    for (const item of delivery.repositories) {
      elements.deliveryRepository.append(node("option", {
        value: item.repositoryKey,
        text: item.label,
      }));
    }
  }
  elements.deliveryRepository.value = delivery.repositoryKey;
  elements.deliveryRepository.dataset.signature = signature;
}

function deliveryScopes(edges) {
  const scopes = new Map();
  for (const edge of edges) {
    const identity = `${edge.fromKind}:${edge.fromKey}`;
    const current = scopes.get(identity) ?? {
      kind: edge.fromKind,
      key: edge.fromKey,
      commitHash: edge.commitHash,
      observedAt: edge.observedAt,
      fileCount: 0,
    };
    current.fileCount += 1;
    scopes.set(identity, current);
  }
  return [...scopes.values()];
}

function renderDelivery(state) {
  const delivery = state.delivery;
  renderDeliveryRepositories(delivery);
  elements.deliveryAfter.value = delivery.after;
  elements.deliveryBefore.value = delivery.before;
  for (const button of document.querySelectorAll("[data-delivery-mode]")) {
    const selected = button.dataset.deliveryMode === delivery.mode;
    button.setAttribute("aria-pressed", selected ? "true" : "false");
  }
  const intentMode = delivery.mode === "intent";
  elements.deliveryRepository.disabled = delivery.loading;
  elements.deliveryAfter.disabled = intentMode || delivery.loading;
  elements.deliveryBefore.disabled = intentMode || delivery.loading;
  document.querySelector("#delivery-form button").disabled = intentMode || delivery.loading ||
    delivery.repositoryKey === "";
  const intentUnavailable = intentMode && delivery.trace?.coverage?.intentState === "unavailable";
  const deliveryError = delivery.error === null ? null : dashboardDiagnosticMessage(delivery.error);
  elements.deliveryStatus.classList.toggle("is-error", deliveryError !== null);
  elements.deliveryStatus.title = delivery.error ?? "";
  elements.deliveryStatus.textContent = deliveryError ?? (intentMode
    ? delivery.traceLoading || delivery.loading
      ? "Reading committed Intent evidence..."
      : intentUnavailable
        ? "No Intent source is configured. Run insights sync with --repository and --intent."
        : delivery.trace === null
          ? "Select a registered repository to inspect Intent evidence."
          : `${delivery.trace.coverage.intentState === "complete" ? "Complete" : "Partial"} requirement coverage`
    : delivery.traceLoading
      ? "Reading snapshot-bound trace..."
      : delivery.loading
        ? "Reading committed delivery edges..."
        : delivery.trace === null
          ? ""
          : "Delivery evidence loaded");

  clear(elements.deliveryRailList);
  const scopes = intentMode ? delivery.intentRoots : deliveryScopes(delivery.edges);
  elements.deliveryRailHeading.textContent = intentMode ? "Requirements" : "Commits";
  elements.deliveryRailCount.textContent = formatCount(scopes.length);
  for (const scope of scopes) {
    const title = intentMode
      ? scope.label
      : `Commit ${scope.commitHash === null ? scope.key.slice(0, 8) : scope.commitHash.slice(0, 8)}`;
    const button = node("button", { className: "delivery-scope", type: "button" }, [
      node("strong", { text: title }),
      node("span", { text: intentMode ? readableSlug(scope.attributes.status) : readableTimestamp(scope.observedAt) }),
      node("span", { text: intentMode ? readableSlug(scope.attributes.intentKind) : `${formatCount(scope.fileCount)} changed files` }),
    ]);
    button.addEventListener("click", () => void loadDeliveryTrace(intentMode
      ? { kind: scope.kind, key: scope.key }
      : scope));
    elements.deliveryRailList.append(button);
  }
  if (scopes.length === 0) {
    elements.deliveryRailList.append(node("p", {
      className: "empty-copy",
      text: intentMode
        ? intentUnavailable
          ? "Add a repository Intent file during Insights sync to connect requirements to delivery."
          : "No requirements are linked in this repository yet."
        : "No commits were recorded in this date range.",
    }));
  }
  elements.deliveryMore.hidden = (intentMode ? delivery.intentCursor : delivery.edgeCursor) === null;
  elements.deliveryMore.disabled = delivery.loading;

  const trace = delivery.trace;
  clear(elements.deliverySummary);
  elements.deliverySummary.hidden = trace === null;
  if (trace !== null) {
    const view = deliveryTraceViewModel(trace);
    const summaryMeta = node("div", { className: "delivery-summary-meta" }, [
      badge(view.evidence, view.evidence.startsWith("Direct") ? "ok" : view.evidence.startsWith("Observed") ? "neutral" : "pending"),
      node("span", { text: `${formatCount(view.edgeCount)} evidence links` }),
    ]);
    const limitations = view.limitations.length === 0
      ? []
      : [node("p", { className: "delivery-boundary", text: view.limitations.join(" ") })];
    elements.deliverySummary.append(
      node("p", { className: "eyebrow", text: "Delivery summary" }),
      node("h2", { text: view.title }),
      node("p", { className: "delivery-summary-copy", text: view.summary }),
      summaryMeta,
      ...limitations,
    );
  }
  const groups = {
    prompt: [],
    activity: [],
    delivery: [],
  };
  for (const item of trace?.nodes ?? []) {
    if (item.kind === "intent" || item.kind === "turn") groups.prompt.push(item);
    else if (item.kind === "session" || item.kind === "capability-use") groups.activity.push(item);
    else groups.delivery.push(item);
  }
  clear(elements.promptLane);
  clear(elements.activityLane);
  clear(elements.deliveryLane);
  elements.promptLaneCount.textContent = formatCount(groups.prompt.length);
  elements.activityLaneCount.textContent = formatCount(groups.activity.length);
  elements.deliveryLaneCount.textContent = formatCount(groups.delivery.length);
  for (const item of groups.prompt) elements.promptLane.append(traceNodeButton(item, delivery));
  for (const item of groups.activity) elements.activityLane.append(traceNodeButton(item, delivery));
  for (const item of groups.delivery) elements.deliveryLane.append(traceNodeButton(item, delivery));
  if (groups.prompt.length === 0) elements.promptLane.append(node("p", { className: "lane-empty", text: "No requirement or Agent turn is linked yet." }));
  if (groups.activity.length === 0) elements.activityLane.append(node("p", { className: "lane-empty", text: "No Agent session or Tool use is linked yet." }));
  if (groups.delivery.length === 0) elements.deliveryLane.append(node("p", { className: "lane-empty", text: "Choose a commit to see delivered files." }));
  if (delivery.traceCursor !== null) {
    const more = node("button", { className: "quiet-button lane-more", type: "button", text: "Load more trace" });
    more.addEventListener("click", () => void loadDeliveryTrace(delivery.trace.root, true));
    elements.deliveryLane.append(more);
  }
}

function selectedCommit(delivery) {
  const selected = delivery.selected;
  if (selected?.kind === "git-commit") return selected;
  if (selected?.kind !== "file" || delivery.trace === null) return null;
  const edge = delivery.trace.edges.find((item) => item.relation === "commit-changed-file" &&
    traceIdentity(item.to) === traceIdentity(selected));
  if (edge === undefined) return null;
  return delivery.trace.nodes.find((item) => item.kind === "git-commit" && item.key === edge.from.key) ?? null;
}

function renderDeliveryDetail(state) {
  const delivery = state.delivery;
  const selected = delivery.selected;
  if (selected === null) return false;
  elements.inspectorTitle.textContent = selected.label || selected.attributes?.path || deliveryKindLabel(selected.kind);
  elements.inspectorBody.append(node("div", { className: "detail-list" }, [
    detailRow("Type", deliveryKindLabel(selected.kind)),
    detailRow("Recorded", readableTimestamp(selected.observedAt)),
    detailRow("Connections", formatCount(delivery.relatedNodeKeys.length)),
  ]));
  const selectedIdentity = traceIdentity(selected);
  const relatedEdges = (delivery.trace?.edges ?? []).filter((edge) =>
    traceIdentity(edge.from) === selectedIdentity || traceIdentity(edge.to) === selectedIdentity);
  if (relatedEdges.length > 0) {
    const evidenceList = node("div", { className: "connection-list" });
    for (const edge of relatedEdges) {
      const readable = humanizeDeliveryEdge(edge);
      evidenceList.append(node("div", { className: "connection-item" }, [
        node("div", { className: "connection-heading" }, [
          node("strong", { text: readable.relation }),
          badge(readable.strength, traceTone(edge.strength)),
        ]),
        node("span", { text: readable.source }),
        ...(readable.limitations.length === 0
          ? []
          : [node("p", { className: "connection-limit", text: readable.limitations.join(" ") })]),
      ]));
    }
    elements.inspectorBody.append(
      node("div", { className: "payload-heading", text: "Why this is linked" }),
      evidenceList,
    );
  }
  const actions = node("div", { className: "detail-actions" });
  const evidence = node("button", {
    className: "quiet-button",
    type: "button",
    text: delivery.evidenceLoading ? "Loading evidence..." : "View source evidence",
  });
  evidence.disabled = delivery.evidenceLoading;
  evidence.addEventListener("click", () => void loadDeliveryEvidence());
  actions.append(evidence);
  if (selected.kind === "session") {
    const timeline = node("button", {
      className: "quiet-button",
      type: "button",
      text: delivery.timelineLoading ? "Loading history..." : "View session history",
    });
    timeline.disabled = delivery.timelineLoading;
    timeline.addEventListener("click", () => void loadSessionTimeline());
    actions.append(timeline);
  }

  const commit = selectedCommit(delivery);
  const commitLink = commit?.attributes?.externalLinks?.commit;
  if (typeof commitLink === "string") {
    actions.append(node("a", {
      className: "quiet-button action-link",
      href: commitLink,
      target: "_blank",
      rel: "noopener noreferrer",
      text: "Open on GitHub / GitLab",
    }));
  }
  if (commit !== null) {
    const parents = commit.attributes.parentObjectIds ?? [];
    const parent = node("select", { className: "parent-select", "aria-label": "Git diff parent" });
    if (parents.length === 0) parent.append(node("option", { value: "", text: "Root commit" }));
    for (const objectId of parents) parent.append(node("option", { value: objectId, text: objectId.slice(0, 12) }));
    const diff = node("button", {
      className: "quiet-button",
      type: "button",
      text: delivery.diffLoading ? "Loading changes..." : "View code changes",
    });
    diff.disabled = delivery.diffLoading;
    diff.addEventListener("click", () => void loadDeliveryDiff(commit, parent.value || null));
    actions.append(parent, diff);
  }
  const continuation = node("button", { className: "quiet-button", type: "button", text: "Copy Agent handoff" });
  continuation.addEventListener("click", () => void copyDeliveryContinuation());
  actions.append(continuation);
  elements.inspectorBody.append(actions);
  const technical = node("details", { className: "technical-details" }, [
    node("summary", { text: "Technical evidence" }),
    node("div", { className: "detail-list" }, [
      detailRow("Kind", selected.kind),
      detailRow("Key", selected.key),
      detailRow("Revision", selected.revision ?? "Not recorded"),
    ]),
  ]);
  elements.inspectorBody.append(technical);

  if (delivery.timeline !== null) {
    const timeline = node("div", { className: "timeline-list" });
    for (const item of delivery.timeline.items ?? []) {
      const entry = node("button", { className: "timeline-entry", type: "button" }, [
        node("span", { className: "trace-node-kind", text: readableSlug(item.eventKind) }),
        node("strong", { text: item.metadata?.role ? readableSlug(item.metadata.role) : readableSlug(item.eventKind) }),
        node("span", { className: "trace-node-time", text: readableTimestamp(item.observedAt) }),
      ]);
      entry.addEventListener("click", () => void loadDeliveryEvidence(false, item.evidence));
      timeline.append(entry);
    }
    if ((delivery.timeline.items ?? []).length === 0) {
      timeline.append(node("p", { className: "empty-copy", text: "No retained timeline events." }));
    }
    elements.inspectorBody.append(
      node("div", { className: "payload-heading", text: "Session timeline" }),
      timeline,
    );
  }

  if (delivery.evidence !== null) {
    elements.inspectorBody.append(
      node("div", { className: "payload-heading", text: `Evidence ${delivery.evidence.range.start}-${delivery.evidence.range.end}` }),
      node("pre", { className: "payload-view", text: delivery.evidence.content }),
    );
    if (delivery.evidence.nextCursor !== null) {
      const more = node("button", { className: "quiet-button load-more", type: "button", text: "Load more evidence" });
      more.addEventListener("click", () => void loadDeliveryEvidence(true, delivery.evidenceTarget));
      elements.inspectorBody.append(more);
    }
  }
  if (delivery.diff !== null) {
    elements.inspectorBody.append(
      node("div", { className: "payload-heading", text: `Git diff ${delivery.diff.range.start}-${delivery.diff.range.end}` }),
      node("pre", { className: "payload-view diff-view", text: delivery.diff.content }),
    );
    if (delivery.diff.nextCursor !== null) {
      const more = node("button", { className: "quiet-button load-more", type: "button", text: "Load more diff" });
      more.addEventListener("click", () => void loadDeliveryDiff(commit, delivery.diff.parentObjectId, true));
      elements.inspectorBody.append(more);
    }
  }
  if (delivery.error) {
    elements.inspectorBody.append(node("p", {
      className: "error-copy",
      text: dashboardDiagnosticMessage(delivery.error),
    }));
  }
  return true;
}

function renderInspector(state) {
  const inspector = state.inspector;
  const deliveryOpen = state.activeView === "inspector" && state.delivery.selected !== null;
  const open = deliveryOpen || inspector.mode !== "closed";
  document.querySelector("#app").classList.toggle("inspector-open", open);
  elements.inspector.classList.toggle("is-closed", !open);
  elements.inspector.setAttribute("aria-hidden", open ? "false" : "true");
  elements.inspectorTitle.textContent = inspector.title;
  clear(elements.inspectorBody);
  elements.evidenceMore.hidden = true;
  if (deliveryOpen && renderDeliveryDetail(state)) return;
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
  renderDelivery(state);
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

async function loadDeliveryRepositories() {
  const delivery = store.getState().delivery;
  if (delivery.loading || delivery.repositories.length > 0) return;
  store.dispatch({ type: "delivery/repositories-loading" });
  try {
    const response = await requestJson("/api/v1/inspector/repositories");
    store.dispatch({ type: "delivery/repositories-loaded", response });
    const current = store.getState().delivery;
    if (current.repositoryKey !== "") {
      if (current.mode === "intent") await loadDeliveryIntents(false);
      else await loadDeliveryEdges(false);
    }
  } catch (error) {
    store.dispatch({ type: "delivery/failed", code: errorCode(error) });
  }
}

async function loadDeliveryIntents(append = false) {
  const delivery = store.getState().delivery;
  if (delivery.loading || delivery.mode !== "intent" || delivery.repositoryKey === "") return;
  store.dispatch({ type: "delivery/repositories-loading" });
  try {
    const response = await requestJson("/api/v1/inspector/trace", {
      method: "POST",
      body: JSON.stringify(buildDeliveryTraceRequest(
        { kind: "repository", key: delivery.repositoryKey },
        append ? delivery.intentCursor : null,
      )),
    });
    store.dispatch({ type: "delivery/intents-loaded", response, append });
  } catch (error) {
    store.dispatch({ type: "delivery/failed", code: errorCode(error) });
  }
}

async function loadDeliveryEdges(append = false) {
  const delivery = store.getState().delivery;
  if (delivery.loading || delivery.mode !== "date" || delivery.repositoryKey === "") return;
  store.dispatch({ type: "delivery/edges-loading" });
  try {
    const response = await requestJson("/api/v1/inspector/edges", {
      method: "POST",
      body: JSON.stringify(buildInspectorEdgeRequest(
        delivery,
        append ? delivery.edgeCursor : null,
      )),
    });
    store.dispatch({ type: "delivery/edges-loaded", response, append });
  } catch (error) {
    store.dispatch({ type: "delivery/failed", code: errorCode(error) });
  }
}

async function loadDeliveryTrace(root, append = false) {
  const delivery = store.getState().delivery;
  if (delivery.traceLoading) return;
  const selectedRoot = root.kind === undefined ? delivery.trace?.root : root;
  if (selectedRoot === null || selectedRoot === undefined) return;
  store.dispatch({ type: "delivery/trace-loading" });
  try {
    const response = await requestJson("/api/v1/inspector/trace", {
      method: "POST",
      body: JSON.stringify(buildDeliveryTraceRequest(
        selectedRoot,
        append ? delivery.traceCursor : null,
      )),
    });
    const selected = append
      ? delivery.selected
      : response.nodes.find((item) => traceIdentity(item) === traceIdentity(selectedRoot)) ?? response.root;
    store.dispatch({ type: "delivery/trace-loaded", response, selected, append });
  } catch (error) {
    store.dispatch({ type: "delivery/failed", code: errorCode(error) });
  }
}

async function loadDeliveryEvidence(append = false, target = null) {
  const delivery = store.getState().delivery;
  const selected = delivery.selected;
  if (selected === null || delivery.evidenceLoading) return;
  const requestTarget = target ?? {
    kind: "delivery-node",
    nodeKind: selected.kind,
    nodeKey: selected.key,
    revision: selected.revision,
  };
  store.dispatch({ type: "delivery/evidence-loading", target: requestTarget });
  try {
    const response = await requestJson("/api/v1/inspector/evidence", {
      method: "POST",
      body: JSON.stringify({
        format: "threadshare-insights-evidence-request@v2",
        target: requestTarget,
        include: ["envelope", "payload"],
        cursor: append ? delivery.evidence?.nextCursor ?? null : null,
        maxBytes: 65_536,
      }),
    });
    store.dispatch({ type: "delivery/evidence-loaded", response, append });
  } catch (error) {
    store.dispatch({ type: "delivery/failed", code: errorCode(error) });
  }
}

async function loadSessionTimeline() {
  const delivery = store.getState().delivery;
  const selected = delivery.selected;
  if (selected?.kind !== "session" || delivery.timelineLoading || delivery.trace === null) return;
  store.dispatch({ type: "delivery/timeline-loading" });
  try {
    const response = await requestJson("/api/v1/inspector/session-timeline", {
      method: "POST",
      body: JSON.stringify({
        format: "threadshare-insights-recipe-request@v1",
        window: { after: "1970-01-01T00:00:00.000Z", before: delivery.trace.evaluatedAt },
        comparisonWindow: null,
        filters: {
          providers: [],
          projectKeys: [],
          capabilityKeys: [],
          sessionKeys: [selected.key],
          eventKinds: [],
          text: null,
          bucket: null,
        },
        limit: 50,
        allowDegraded: true,
      }),
    });
    store.dispatch({ type: "delivery/timeline-loaded", response });
  } catch (error) {
    store.dispatch({ type: "delivery/failed", code: errorCode(error) });
  }
}

async function loadDeliveryDiff(commit, parentObjectId, append = false) {
  const delivery = store.getState().delivery;
  if (commit === null || delivery.diffLoading) return;
  store.dispatch({ type: "delivery/diff-loading" });
  try {
    const response = await requestJson("/api/v1/inspector/git-diff", {
      method: "POST",
      body: JSON.stringify({
        format: "threadshare-insights-git-diff-evidence-request@v1",
        repositoryKey: commit.attributes.repositoryKey,
        commitObjectId: commit.attributes.objectId,
        parentObjectId,
        path: delivery.selected?.kind === "file" ? delivery.selected.attributes.path : null,
        revision: commit.revision,
        contextLines: 3,
        maxBytes: 65_536,
        cursor: append ? delivery.diff?.nextCursor ?? null : null,
      }),
    });
    store.dispatch({ type: "delivery/diff-loaded", response, append });
  } catch (error) {
    store.dispatch({ type: "delivery/failed", code: errorCode(error) });
  }
}

async function copyDeliveryContinuation() {
  const trace = store.getState().delivery.trace;
  if (trace === null) return;
  try {
    const response = await requestJson("/api/v1/inspector/continuation", {
      method: "POST",
      body: JSON.stringify({ trace, recentPrompts: [], failureChains: [] }),
    });
    await navigator.clipboard.writeText(JSON.stringify(response, null, 2));
    showToast("Continuation context copied");
  } catch (error) {
    showToast(errorCode(error));
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
    if (view === "inspector") void loadDeliveryRepositories();
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
for (const button of document.querySelectorAll("[data-delivery-mode]")) {
  button.addEventListener("click", () => {
    store.dispatch({ type: "delivery/input", field: "mode", value: button.dataset.deliveryMode });
    if (store.getState().delivery.repositories.length === 0) {
      void loadDeliveryRepositories();
    } else if (button.dataset.deliveryMode === "intent") {
      void loadDeliveryIntents(false);
    } else {
      void loadDeliveryEdges(false);
    }
  });
}
elements.deliveryRepository.addEventListener("input", (event) => {
  store.dispatch({ type: "delivery/input", field: "repositoryKey", value: event.target.value });
  if (store.getState().delivery.mode === "intent") void loadDeliveryIntents(false);
});
elements.deliveryAfter.addEventListener("input", (event) => {
  store.dispatch({ type: "delivery/input", field: "after", value: event.target.value });
});
elements.deliveryBefore.addEventListener("input", (event) => {
  store.dispatch({ type: "delivery/input", field: "before", value: event.target.value });
});
document.querySelector("#delivery-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void loadDeliveryEdges(false);
});
elements.deliveryMore.addEventListener("click", () => {
  if (store.getState().delivery.mode === "intent") void loadDeliveryIntents(true);
  else void loadDeliveryEdges(true);
});
document.querySelector("#inspector-close").addEventListener("click", () => {
  store.dispatch({ type: "inspector/close" });
  store.dispatch({ type: "delivery/close" });
});
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
