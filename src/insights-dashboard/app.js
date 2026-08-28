import {
  INITIAL_STATE,
  buildDeliveryTraceRequest,
  buildInspectorEdgeRequest,
  buildConversationMessagesRequest,
  buildConversationRequest,
  createDashboardStore,
  defaultHistoryDateRange,
  dashboardDiagnosticMessage,
  deliveryKindLabel,
  deliveryTraceViewModel,
  errorCode,
  formatAge,
  formatBytes,
  formatCount,
  humanizeDeliveryEdge,
  overviewCounts,
  projectFilterViewModel,
  sourceCatalogViewModel,
} from "/state.js";

const store = createDashboardStore({
  ...INITIAL_STATE,
  search: Object.freeze({ ...INITIAL_STATE.search, ...defaultHistoryDateRange() }),
});
const elements = Object.freeze({
  statusStrip: document.querySelector("#status-strip"),
  snapshotLabel: document.querySelector("#snapshot-label"),
  indexMeta: document.querySelector("#index-meta"),
  overviewMetrics: document.querySelector("#overview-metrics"),
  overviewUpdated: document.querySelector("#overview-updated"),
  coverageList: document.querySelector("#coverage-list"),
  providerRows: document.querySelector("#provider-rows"),
  diagnosticList: document.querySelector("#diagnostic-list"),
  historyMetrics: document.querySelector("#history-metrics"),
  historySnapshot: document.querySelector("#history-snapshot"),
  historyQualityStrip: document.querySelector("#history-quality-strip"),
  sourceMetrics: document.querySelector("#source-metrics"),
  sourcesSnapshot: document.querySelector("#sources-snapshot"),
  sourceFilterSummary: document.querySelector("#source-filter-summary"),
  sourceRows: document.querySelector("#source-rows"),
  sourceDetail: document.querySelector("#source-detail"),
  experienceRepository: document.querySelector("#experience-repository"),
  experienceStatus: document.querySelector("#experience-status"),
  experienceMetrics: document.querySelector("#experience-metrics"),
  experienceRows: document.querySelector("#experience-rows"),
  providerFilter: document.querySelector("#provider-filter"),
  projectFilter: document.querySelector("#project-filter"),
  projectOptions: document.querySelector("#project-options"),
  projectFilterState: document.querySelector("#project-filter-state"),
  searchQuery: document.querySelector("#search-query"),
  observedAfter: document.querySelector("#after-filter"),
  observedBefore: document.querySelector("#before-filter"),
  completenessFilter: document.querySelector("#completeness-filter"),
  searchSummary: document.querySelector("#search-summary"),
  conversationRows: document.querySelector("#conversation-rows"),
  conversationMore: document.querySelector("#conversation-more"),
  conversationBackdrop: document.querySelector("#conversation-backdrop"),
  conversationDetail: document.querySelector("#conversation-detail"),
  conversationBack: document.querySelector("#conversation-back"),
  conversationTitle: document.querySelector("#conversation-title"),
  conversationSubtitle: document.querySelector("#conversation-subtitle"),
  conversationKey: document.querySelector("#conversation-key"),
  conversationStateBadge: document.querySelector("#conversation-state-badge"),
  conversationSessionBar: document.querySelector("#conversation-session-bar"),
  conversationTurnCount: document.querySelector("#conversation-turn-count"),
  conversationTurnList: document.querySelector("#conversation-turn-list"),
  conversationFacts: document.querySelector("#conversation-facts"),
  conversationEvidence: document.querySelector("#conversation-evidence"),
  conversationEvidenceState: document.querySelector("#conversation-evidence-state"),
  conversationMessageStatus: document.querySelector("#conversation-message-status"),
  conversationMessages: document.querySelector("#conversation-messages"),
  conversationEarlier: document.querySelector("#conversation-earlier"),
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
  const model = projectFilterViewModel(state.status, state.projectCatalog);
  const signature = `${model.message ?? ""}:${model.options.map((item) =>
    `${item.projectKey}:${item.label}:${item.provider}:${item.indexedTurnCount}`).join(":")}`;
  if (elements.projectOptions.dataset.signature === signature) return;
  const selected = state.search.projectKey;
  clear(elements.projectOptions);
  for (const project of model.options) {
    const label = `${project.label} · ${project.provider} / ${formatCount(project.indexedTurnCount)} turns`;
    elements.projectOptions.append(node("option", {
      value: project.projectKey,
      label,
      title: project.projectKey,
    }));
  }
  elements.projectFilter.value = selected;
  elements.projectFilterState.textContent = model.message ?? "";
  elements.projectFilterState.hidden = model.message === null;
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

function renderSourceOptions(state) {
  const catalog = sourceCatalogViewModel(state.status, "all", state.sources.selectedId);
  const signature = `${state.search.provider}:${catalog.sources.map((source) => source.sourceAdapterId).join(":")}`;
  if (elements.providerFilter.dataset.signature === signature) return;
  clear(elements.providerFilter);
  elements.providerFilter.append(node("option", { value: "", text: "All sources" }));
  for (const source of catalog.sources) {
    elements.providerFilter.append(node("option", {
      value: source.sourceAdapterId,
      text: source.displayName,
    }));
  }
  elements.providerFilter.value = catalog.sources.some((source) =>
    source.sourceAdapterId === state.search.provider) ? state.search.provider : "";
  elements.providerFilter.dataset.signature = signature;
}

function renderHistoryMetrics(state) {
  const overview = overviewCounts(state.status);
  clear(elements.historyMetrics);
  clear(elements.historyQualityStrip);
  elements.historySnapshot.textContent = state.status?.engine === null || state.status?.engine === undefined
    ? "Snapshot unavailable"
    : `Snapshot ${state.status.engine.snapshotSeq} · ${formatAge(state.status.engine.snapshotAgeMs)} old`;
  if (Object.keys(overview).length === 0) {
    elements.historyMetrics.append(node("p", { className: "empty-copy", text: "No committed history yet." }));
    elements.historyQualityStrip.append(
      badge("No committed snapshot", "pending"),
      node("span", { text: "Run Insights sync to make conversation history available." }),
    );
    return;
  }
  elements.historyMetrics.append(
    metric("Conversations", overview.sessions?.eligible, `${formatCount(overview.sessions?.raw)} observed`),
    metric("Indexed turns", overview.turns?.indexed, `${formatCount(overview.turns?.open)} open`),
    metric("Capabilities", overview.capabilities?.total, `${formatCount(overview.capabilities?.tool)} tools · ${formatCount(overview.capabilities?.skill)} skills`),
    metric("Coverage signals", overview.coverage?.items?.length ?? 0, "Visible data-quality hints"),
  );
  const coverageItems = overview.coverage?.items ?? [];
  const hasCoverageGaps = coverageItems.some((item) => Number(item.count ?? 0) > 0);
  const snapshot = state.status?.engine?.snapshotSeq ?? overview.snapshotSeq ?? "-";
  elements.historyQualityStrip.append(
    node("div", { className: "quality-copy" }, [
      node("strong", { text: `Snapshot ${snapshot} is the query boundary` }),
      node("span", { text: hasCoverageGaps
        ? "Some records carry coverage limits. Inspect the evidence rail before drawing conclusions."
        : "All visible rows are read from the committed local snapshot." }),
    ]),
    badge(hasCoverageGaps ? `${formatCount(coverageItems.length)} data hints` : "Coverage clear", hasCoverageGaps ? "pending" : "ok"),
  );
}

function renderSearchControlValues(state) {
  for (const [element, value] of [
    [elements.searchQuery, state.search.query],
    [elements.observedAfter, state.search.observedAtOrAfter],
    [elements.observedBefore, state.search.observedBefore],
    [elements.completenessFilter, state.search.completeness],
  ]) {
    const next = value ?? "";
    if (element.value !== next) element.value = next;
  }
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
    metric("Indexed turns", overview.turns?.indexed, `${formatCount(overview.turns?.open)} open`),
    metric("Hard sealed", overview.turns?.hardSealed, `${formatCount(overview.turns?.quiescent)} quiescent`),
    metric("Capabilities", overview.capabilities?.total, `${formatCount(overview.capabilities?.tool)} tools / ${formatCount(overview.capabilities?.skill)} skills`),
    metric("Repeated patterns", overview.dedupe?.strongGroup, `${formatCount(overview.dedupe?.weakGroup)} weak groups`),
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

function renderExperienceRepositoryOptions(state) {
  const experience = state.experience;
  const signature = experience.repositories
    .map((repository) => `${repository.repositoryKey}:${repository.label}`)
    .join("|");
  if (elements.experienceRepository.dataset.signature === signature) {
    elements.experienceRepository.value = experience.repositoryKey;
    elements.experienceRepository.disabled = experience.loading || experience.repositories.length === 0;
    return;
  }
  clear(elements.experienceRepository);
  if (experience.repositories.length === 0) {
    elements.experienceRepository.append(node("option", {
      value: "",
      text: experience.repositoriesLoaded ? "No registered repository" : "Loading repositories",
    }));
  } else {
    for (const repository of experience.repositories) {
      elements.experienceRepository.append(node("option", {
        value: repository.repositoryKey,
        text: repository.label,
      }));
    }
  }
  elements.experienceRepository.value = experience.repositoryKey;
  elements.experienceRepository.disabled = experience.loading || experience.repositories.length === 0;
  elements.experienceRepository.dataset.signature = signature;
}

function assetTypeLabel(kind) {
  if (kind === "entry") return "Entry";
  if (kind === "scene") return "Scene";
  if (kind === "doctrine") return "Doctrine";
  if (kind === "skill") return "Skill";
  return "Asset";
}

function renderExperience(state) {
  renderExperienceRepositoryOptions(state);
  const experience = state.experience;
  const response = experience.assets;
  clear(elements.experienceMetrics);
  clear(elements.experienceRows);
  elements.experienceStatus.classList.toggle("is-error", experience.error !== null);
  if (experience.loading && response === null) {
    elements.experienceStatus.textContent = "Reading reviewed assets...";
    elements.experienceRows.append(emptyRow(5, "Loading Team Memory assets"));
    return;
  }
  if (experience.error !== null) {
    elements.experienceStatus.textContent = dashboardDiagnosticMessage(experience.error);
    elements.experienceRows.append(emptyRow(5, "Reviewed assets could not be read."));
    return;
  }
  if (!experience.repositoriesLoaded) {
    elements.experienceStatus.textContent = "";
    elements.experienceRows.append(emptyRow(5, "Select Experience to load registered repositories."));
    return;
  }
  if (experience.repositoryKey === "") {
    elements.experienceStatus.textContent = "No registered repository.";
    elements.experienceRows.append(emptyRow(5, "No reviewed Team Memory assets."));
    return;
  }
  if (response === null) {
    elements.experienceStatus.textContent = "";
    elements.experienceRows.append(emptyRow(5, "Reviewed assets have not been loaded."));
    return;
  }
  const diagnosticCount = (response.diagnostics ?? []).reduce(
    (total, item) => total + Number(item.count ?? 0),
    0,
  );
  elements.experienceStatus.textContent = response.initialized
    ? `${formatCount(response.assets?.length)} reviewed assets${response.truncated ? " / bounded result" : ""}${diagnosticCount > 0 ? ` / ${formatCount(diagnosticCount)} invalid or skipped` : ""}`
    : "Team Memory is not initialized for this repository.";
  elements.experienceMetrics.append(
    metric("Approved entries", response.counts?.entries, "reviewed statements"),
    metric("Scenes", response.counts?.scenes, "synthesized context"),
    metric("Doctrine", response.counts?.doctrine, "team-wide guidance"),
    metric("Skills", response.counts?.skills, "reusable procedures"),
  );
  for (const asset of response.assets ?? []) {
    const evidence = asset.evidenceStrength ?? (asset.kind === "entry" ? "unknown" : "reviewed asset");
    const limit = asset.heat === null
      ? asset.limitations.length === 0 ? "-" : asset.limitations.join(", ")
      : `heat ${formatCount(asset.heat)}`;
    elements.experienceRows.append(node("tr", {}, [
      node("td", {}, [
        node("strong", { text: asset.title }),
        node("span", { className: "row-detail", text: asset.summary || asset.id, title: asset.summary || asset.id }),
      ]),
      cell(assetTypeLabel(asset.kind)),
      cell(asset.state),
      cell(evidence),
      cell(limit),
    ]));
  }
  if ((response.assets ?? []).length === 0) {
    elements.experienceRows.append(emptyRow(5, "No reviewed Team Memory assets."));
  }
}

function sourceStateBadge(source, statusState) {
  if (statusState === "loading") return badge("Checking snapshot", "pending");
  if (statusState === "error") return badge("Status unavailable", "danger");
  if (source.hasEligibleSessions) return badge("Eligible data", "ok");
  if (source.inSnapshot) return badge("No eligible sessions", "pending");
  return badge("Not indexed", "neutral");
}

function operationBadge(operation) {
  if (operation.state === "supported") return badge("Supported", "ok");
  if (operation.state === "indexed") return badge("Indexed", "ok");
  if (operation.state === "sync-required") return badge("Sync required", "pending");
  return badge("Evidence gate", "neutral");
}

function renderSources(state) {
  const catalog = sourceCatalogViewModel(
    state.status,
    state.sources.filter,
    state.sources.selectedId,
  );
  elements.sourcesSnapshot.textContent = catalog.snapshotSeq === null
    ? state.statusState === "error" ? "Snapshot unavailable" : "Loading committed snapshot"
    : `Committed snapshot ${catalog.snapshotSeq}`;
  clear(elements.sourceMetrics);
  if (state.status === null && state.statusState === "loading") {
    elements.sourceMetrics.append(node("p", { className: "empty-copy", text: "Loading source totals." }));
  } else {
    elements.sourceMetrics.append(
      metric("Supported sources", catalog.totals.supportedSources, "current release"),
      metric("In snapshot", catalog.totals.snapshotSources, "committed source data"),
      metric("Eligible sessions", catalog.totals.eligibleSessions, "main sessions"),
      metric("Indexed turns", catalog.totals.indexedTurns, "active turns"),
    );
  }
  for (const button of document.querySelectorAll("[data-source-filter]")) {
    button.setAttribute("aria-pressed", String(button.dataset.sourceFilter === catalog.filter));
  }
  elements.sourceFilterSummary.textContent = `${formatCount(catalog.visibleSources.length)} of ${formatCount(catalog.sources.length)} sources`;

  clear(elements.sourceRows);
  for (const source of catalog.visibleSources) {
    const select = node("button", {
      className: "source-select",
      type: "button",
      text: source.displayName,
      title: `Inspect ${source.displayName}`,
    });
    select.append(node("code", { text: source.sourceAdapterId }));
    select.addEventListener("click", () => store.dispatch({
      type: "sources/select",
      sourceAdapterId: source.sourceAdapterId,
    }));
    const row = node("tr", {
      className: source.sourceAdapterId === catalog.selected?.sourceAdapterId ? "is-selected" : "",
    }, [
      node("td", {}, [select]),
      node("td", {}, [sourceStateBadge(source, state.statusState)]),
      cell(formatCount(source.rawSessionCount), "numeric"),
      cell(formatCount(source.eligibleSessionCount), "numeric"),
      cell(formatCount(source.indexedTurnCount), "numeric"),
    ]);
    elements.sourceRows.append(row);
  }
  if (catalog.visibleSources.length === 0) {
    elements.sourceRows.append(emptyRow(5, "No sources match this scope."));
  }

  clear(elements.sourceDetail);
  const source = catalog.selected;
  if (source === null) {
    elements.sourceDetail.append(node("p", { className: "empty-copy", text: "Select another source scope." }));
    return;
  }
  const heading = node("div", { className: "source-detail-heading" }, [
    node("div", {}, [
      node("p", { className: "eyebrow", text: source.sourceAdapterId }),
      node("h2", { text: source.displayName }),
    ]),
    sourceStateBadge(source, state.statusState),
  ]);
  const operations = node("div", { className: "source-operation-list" });
  for (const operation of source.operations) {
    operations.append(node("div", { className: "source-operation" }, [
      node("div", {}, [
        node("strong", { text: operation.label }),
        node("span", { text: operation.detail }),
      ]),
      operationBadge(operation),
    ]));
  }
  elements.sourceDetail.append(
    heading,
    node("div", { className: "detail-list source-facts" }, [
      detailRow("Storage", source.storage),
      detailRow("Runtime", source.runtime),
      detailRow("Observed sessions", formatCount(source.rawSessionCount)),
      detailRow("Eligible sessions", formatCount(source.eligibleSessionCount)),
    ]),
    node("div", { className: "source-operation-heading", text: "Available operations" }),
    operations,
  );
  if (source.inSnapshot) {
    const search = node("button", { className: "primary-button source-action", type: "button", text: "Search this source" });
    search.addEventListener("click", () => {
      store.dispatch({ type: "search/input", field: "provider", value: source.sourceAdapterId });
      store.dispatch({ type: "view/select", view: "search" });
      document.querySelector("#workspace").focus({ preventScroll: true });
    });
    elements.sourceDetail.append(search);
  }
}

function renderSearch(state) {
  const search = state.search;
  const response = search.response;
  for (const button of document.querySelectorAll("[data-history-scope]")) {
    const active = (search.completeness || "all") === button.dataset.historyScope;
    button.setAttribute("aria-pressed", active ? "true" : "false");
  }
  clear(elements.conversationRows);
  if (search.loading) {
    elements.searchSummary.textContent = search.loadingAppend
      ? "Loading more conversations..."
      : "Searching the committed snapshot...";
    if (response === null) elements.conversationRows.append(emptyRow(6, "Loading conversations"));
    elements.conversationMore.disabled = true;
    renderConversationDetail(search);
    return;
  }
  if (search.error) {
    elements.searchSummary.textContent = dashboardDiagnosticMessage(search.error);
    elements.conversationRows.append(emptyRow(6, "Conversation history did not load."));
    elements.conversationMore.hidden = true;
    renderConversationDetail(search);
    return;
  }
  if (response === null) {
    elements.searchSummary.textContent = "";
    elements.conversationRows.append(emptyRow(6, "Loading recent conversations."));
    elements.conversationMore.hidden = true;
    renderConversationDetail(search);
    return;
  }
  const sessions = response.records ?? [];
  const snapshot = response.snapshot?.seq ?? "-";
  elements.searchSummary.textContent = `${formatCount(response.totalMatchCount)} conversations / ${formatCount(sessions.length)} shown / snapshot ${snapshot}`;
  for (const session of sessions) {
    const title = session.session?.title?.trim() || "Untitled conversation";
    const button = node("button", {
      className: "conversation-button",
      type: "button",
      text: title,
      title,
    });
    button.addEventListener("click", () => openConversation(session));
    const row = node("tr", {
      className: search.selected?.sessionKey === session.sessionKey ? "is-selected" : "",
      dataset: { sessionKey: session.sessionKey },
      tabindex: "0",
      "aria-selected": search.selected?.sessionKey === session.sessionKey ? "true" : "false",
    }, [
      node("td", {}, [
        node("strong", { text: readableTimestamp(session.session?.endedAt) }),
        node("span", {
          className: "row-detail",
          text: conversationDuration(session.session?.startedAt, session.session?.endedAt),
        }),
      ]),
      node("td", {}, [
        button,
        node("span", {
          className: "row-detail",
          text: `${session.session?.turnCount ?? 0} turns · ${session.sessionKey.slice(0, 12)}`,
        }),
      ]),
      node("td", {}, [
        badge(readableSlug(session.provider), session.provider === "codex" ? "ok" : "neutral"),
        node("span", { className: "row-detail", text: session.originScope === "main" ? "Main session" : readableSlug(session.originScope || "unknown") }),
      ]),
      node("td", {}, [
        node("code", {
          className: "context-key",
          text: session.projectKey?.slice(0, 16) ?? "No project context",
          title: session.projectKey ?? "",
        }),
        node("span", { className: "row-detail", text: session.projectKey ? "Registered project context" : "Context not recorded" }),
      ]),
      node("td", { className: "turn-count-cell" }, [
        node("strong", { text: formatCount(session.session?.turnCount) }),
        node("span", { className: "row-detail", text: "indexed turns" }),
      ]),
      node("td", {}, [
        badge(
          session.completeness === "full" ? "Complete" : "Partial",
          session.completeness === "full" ? "ok" : "pending",
        ),
        node("span", { className: "row-detail", text: session.completeness === "full" ? "Evidence boundary closed" : "Coverage needs review" }),
      ]),
    ]);
    row.addEventListener("click", (event) => {
      if (!(event.target instanceof Element) || event.target.closest("button") === null) openConversation(session);
    });
    row.addEventListener("keydown", (event) => {
      if (event.key === "Enter" || event.key === " ") {
        event.preventDefault();
        openConversation(session);
      }
    });
    elements.conversationRows.append(row);
  }
  if (sessions.length === 0) {
    elements.conversationRows.append(emptyRow(6, "No conversations matched these filters."));
  }
  elements.conversationMore.hidden = response.nextCursor === null;
  elements.conversationMore.disabled = search.loading;
  renderConversationDetail(search);
}

function conversationDuration(startedAt, endedAt) {
  const start = Date.parse(startedAt ?? "");
  const end = Date.parse(endedAt ?? "");
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return "Duration unavailable";
  const minutes = Math.max(1, Math.round((end - start) / 60_000));
  if (minutes < 60) return `${minutes} min`;
  const hours = Math.floor(minutes / 60);
  const remainder = minutes % 60;
  return remainder === 0 ? `${hours} hr` : `${hours} hr ${remainder} min`;
}

function messageRoleLabel(role) {
  if (role === "user") return "User";
  if (role === "assistant") return "Agent";
  if (role === "system") return "System";
  return readableSlug(role || "Message");
}

function clipText(value, limit = 96) {
  const text = String(value ?? "").replace(/\s+/gu, " ").trim();
  if (text.length <= limit) return text;
  return `${[...text].slice(0, Math.max(0, limit - 1)).join("")}…`;
}

function messageContent(message) {
  const content = message?.message?.content;
  return typeof content?.inline === "string"
    ? content.inline || "(Empty message)"
    : `Message content is stored as paged evidence (${formatBytes(content?.byteLength)}).`;
}

function conversationTurnGroups(messages) {
  const groups = new Map();
  for (const message of messages) {
    const key = typeof message.turnKey === "string" ? message.turnKey : `event:${message.eventKey}`;
    const existing = groups.get(key);
    if (existing === undefined) {
      groups.set(key, { key, messages: [message] });
    } else {
      existing.messages.push(message);
    }
  }
  return [...groups.values()]
    .map((group) => ({
      ...group,
      messages: [...group.messages].sort((left, right) => {
        const leftTime = Date.parse(left.observedAt ?? "");
        const rightTime = Date.parse(right.observedAt ?? "");
        const time = (Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER) -
          (Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER);
        return time || String(left.eventKey).localeCompare(String(right.eventKey));
      }),
    }))
    .sort((left, right) => {
      const leftTime = Date.parse(left.messages[0]?.observedAt ?? "");
      const rightTime = Date.parse(right.messages[0]?.observedAt ?? "");
      const time = (Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER) -
        (Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER);
      return time || String(left.key).localeCompare(String(right.key));
    });
}

function conversationTurnTitle(group) {
  const prompt = group.messages.find((message) => message.message?.role === "user");
  return clipText(prompt ? messageContent(prompt) : messageContent(group.messages[0]), 68) || "Untitled turn";
}

function conversationMessageNode(message) {
  const role = message.message?.role ?? "unknown";
  const content = message.message?.content;
  return node("article", {
    className: `conversation-message role-${role}`,
  }, [
    node("div", { className: "message-avatar", "aria-hidden": "true", text: role === "assistant" ? "✦" : role === "user" ? "●" : "·" }),
    node("div", { className: "conversation-message-body" }, [
      node("header", {}, [
        node("strong", { text: messageRoleLabel(role) }),
        node("time", { text: readableTimestamp(message.observedAt) }),
      ]),
      node("div", { className: "conversation-message-copy", text: messageContent(message) }),
      content?.complete === false
        ? node("span", { className: "message-limitation", text: "Partial retained content · inspect coverage before reuse" })
        : node("span", { className: "message-limitation", text: "" }),
    ]),
  ]);
}

function renderConversationTurnRail(groups, selectedTurnKey) {
  clear(elements.conversationTurnList);
  elements.conversationTurnCount.textContent = formatCount(groups.length);
  for (const [index, group] of groups.entries()) {
    const first = group.messages[0];
    const item = node("button", {
      className: `conversation-turn-item${group.key === selectedTurnKey ? " is-selected" : ""}`,
      type: "button",
      "aria-current": group.key === selectedTurnKey ? "true" : "false",
    }, [
      node("span", { className: "conversation-turn-number", text: String(index + 1).padStart(2, "0") }),
      node("span", { className: "conversation-turn-copy" }, [
        node("strong", { text: conversationTurnTitle(group) }),
        node("small", { text: `${group.messages.length} messages · ${readableTimestamp(first?.observedAt)}` }),
      ]),
    ]);
    item.addEventListener("click", () => {
      store.dispatch({ type: "conversation/turn", turnKey: group.key });
      requestAnimationFrame(() => document.querySelector(`[data-turn-key="${CSS.escape(group.key)}"]`)?.scrollIntoView({ block: "nearest" }));
    });
    elements.conversationTurnList.append(item);
  }
  if (groups.length === 0) elements.conversationTurnList.append(node("p", { className: "empty-copy", text: "No turns loaded" }));
}

function renderConversationTranscript(groups, selectedTurnKey) {
  clear(elements.conversationMessages);
  for (const [index, group] of groups.entries()) {
    const card = node("article", {
      className: `conversation-turn-card${group.key === selectedTurnKey ? " is-selected" : ""}`,
      dataset: { turnKey: group.key },
    }, [
      node("header", { className: "conversation-turn-card-heading" }, [
        node("div", {}, [
          node("span", { className: "turn-label", text: `Turn ${String(index + 1).padStart(2, "0")}` }),
          node("h3", { text: conversationTurnTitle(group) }),
          node("span", { className: "row-detail", text: `${group.messages.length} retained messages` }),
        ]),
        node("div", { className: "turn-card-meta" }, [
          badge(group.messages.some((message) => message.message?.role === "user") ? "User initiated" : "Agent activity", "neutral"),
          badge(group.messages.some((message) => message.message?.content?.complete === false) ? "Partial" : "Complete", group.messages.some((message) => message.message?.content?.complete === false) ? "pending" : "ok"),
        ]),
      ]),
      node("div", { className: "turn-card-context" }, [
        node("span", { text: "Source order retained" }),
        node("span", { text: readableTimestamp(group.messages[0]?.observedAt) }),
      ]),
      node("div", { className: "conversation-turn-messages" }, group.messages.map(conversationMessageNode)),
      node("footer", { className: "conversation-turn-card-footer" }, [
        node("span", { text: `${group.messages.length} messages linked to this Turn` }),
        node("span", { text: "Visible content only" }),
      ]),
    ]);
    elements.conversationMessages.append(card);
  }
  if (groups.length === 0) elements.conversationMessages.append(node("p", { className: "empty-copy", text: "No visible messages were retained for this conversation." }));
}

function conversationInsightRows(selected, messages, groups) {
  const userCount = messages.filter((message) => message.message?.role === "user").length;
  const assistantCount = messages.filter((message) => message.message?.role === "assistant").length;
  const partialCount = messages.filter((message) => message.message?.content?.complete === false).length;
  const totalCharacters = messages.reduce((total, message) => total + [...messageContent(message)].length, 0);
  return [
    ["Visible messages", formatCount(messages.length), "Retained message records in this snapshot"],
    ["Turn groups", formatCount(groups.length), "Grouped by recorded turn key"],
    ["User / Agent", `${formatCount(userCount)} / ${formatCount(assistantCount)}`, "Role labels from visible records"],
    ["Retained text", `${formatCount(totalCharacters)} chars`, "Unicode code points; tool payloads may be referenced"],
    ["Coverage", selected.completeness === "full" ? "Complete" : "Partial", selected.completeness === "full" ? "Snapshot reports a closed evidence boundary" : "Some content or terminal evidence is incomplete"],
  ];
}

function renderConversationTab(tab, selected, messages, groups) {
  clear(elements.conversationMessages);
  elements.conversationEarlier.hidden = tab !== "transcript" || store.getState().search.messageCursor === null;
  if (tab === "transcript") {
    renderConversationTranscript(groups, store.getState().search.selectedTurnKey ?? groups[0]?.key ?? null);
    return;
  }
  const panel = node("section", { className: "conversation-tab-panel" });
  if (tab === "execution") {
    panel.append(
      node("div", { className: "tab-panel-heading" }, [
        node("span", { className: "eyebrow", text: "EXECUTION TRACE" }),
        node("h3", { text: "Recorded work around this conversation" }),
        node("p", { text: "Execution facts remain separate from transcript text. Use the Delivery view when you need repository or commit evidence." }),
      ]),
      node("div", { className: "conversation-signal-grid" }, [
        metric("Turns", selected.session?.turnCount ?? groups.length, "Session rollup"),
        metric("Visible messages", messages.length, "Current page"),
        metric("Provider", readableSlug(selected.provider), "Recorded source"),
      ]),
      node("div", { className: "boundary-note" }, [
        badge("Read-only evidence", "neutral"),
        node("span", { text: "This dashboard does not infer an action from message text. Process facts are exposed through the Delivery workspace." }),
      ]),
    );
  } else if (tab === "delivery") {
    panel.append(
      node("div", { className: "tab-panel-heading" }, [
        node("span", { className: "eyebrow", text: "CODE & DELIVERY" }),
        node("h3", { text: "Repository links are inspected separately" }),
        node("p", { text: "A conversation can be a useful pointer, but it is not authorship proof. Follow the recorded delivery edges for commits, files, and limitations." }),
      ]),
      node("div", { className: "conversation-delivery-summary" }, [
        detailRow("Project context", selected.projectKey?.slice(0, 20) ?? "Not recorded"),
        detailRow("Provider", readableSlug(selected.provider)),
        detailRow("Evidence boundary", selected.completeness === "full" ? "Complete" : "Partial"),
      ]),
      node("button", { className: "primary-button", type: "button", text: "Open Delivery workspace" }),
    );
    panel.querySelector("button").addEventListener("click", () => {
      store.dispatch({ type: "conversation/close" });
      store.dispatch({ type: "view/select", view: "inspector" });
      document.querySelector("#workspace").focus({ preventScroll: true });
    });
  } else {
    const rows = node("div", { className: "conversation-insight-list" });
    for (const [label, value, detail] of conversationInsightRows(selected, messages, groups)) {
      rows.append(node("div", { className: "conversation-insight-row" }, [
        node("span", { className: "insight-row-label", text: label }),
        node("strong", { text: value }),
        node("small", { text: detail }),
      ]));
    }
    panel.append(
      node("div", { className: "tab-panel-heading" }, [
        node("span", { className: "eyebrow", text: "OBSERVED INSIGHTS" }),
        node("h3", { text: "What this snapshot can support" }),
        node("p", { text: "These are descriptive signals from retained records, not a productivity score or causal conclusion." }),
      ]),
      rows,
    );
  }
  elements.conversationMessages.append(panel);
}

function renderConversationEvidence(selected, messages, groups) {
  clear(elements.conversationFacts);
  clear(elements.conversationEvidence);
  const complete = selected.completeness === "full";
  elements.conversationEvidenceState.replaceChildren(badge(complete ? "Complete" : "Review limits", complete ? "ok" : "pending"));
  elements.conversationFacts.append(
    detailRow("Provider", readableSlug(selected.provider)),
    detailRow("Started", readableTimestamp(selected.session?.startedAt)),
    detailRow("Last activity", readableTimestamp(selected.session?.endedAt)),
    detailRow("Duration", conversationDuration(selected.session?.startedAt, selected.session?.endedAt)),
    detailRow("Turns", formatCount(selected.session?.turnCount ?? groups.length)),
    detailRow("Project", selected.projectKey?.slice(0, 20) ?? "Not recorded"),
  );
  elements.conversationEvidence.append(
    node("div", { className: "evidence-summary-block" }, [
      node("div", { className: "evidence-summary-title" }, [
        node("span", { className: "eyebrow", text: "SNAPSHOT FACTS" }),
        badge(complete ? "Boundary closed" : "Boundary open", complete ? "ok" : "pending"),
      ]),
      node("div", { className: "evidence-summary-grid" }, [
        detailRow("Visible messages", formatCount(messages.length)),
        detailRow("Turn groups", formatCount(groups.length)),
        detailRow("Session scope", selected.originScope === "main" ? "Main" : readableSlug(selected.originScope || "unknown")),
        detailRow("Revision", selected.revision?.slice(0, 12) ?? "Not recorded"),
      ]),
      node("p", { className: "boundary-note", text: complete
        ? "All visible rows are bounded by the committed snapshot. Message payloads may still be paged."
        : "This conversation has a coverage limitation. Keep the limitation attached when using it for memory or delivery analysis." }),
    ]),
  );
}

function renderConversationDetail(search) {
  const selected = search.selected;
  const open = selected !== null;
  elements.conversationDetail.classList.toggle("is-closed", !open);
  elements.conversationDetail.setAttribute("aria-hidden", open ? "false" : "true");
  elements.conversationBackdrop.classList.toggle("is-hidden", !open);
  elements.conversationBackdrop.setAttribute("aria-hidden", open ? "false" : "true");
  document.querySelector("#app").classList.toggle("conversation-open", open);
  if (!open) return;

  elements.conversationTitle.textContent = selected.session?.title?.trim() || "Untitled conversation";
  const messages = [...search.messages].sort((left, right) => {
    const leftTime = Date.parse(left.observedAt ?? "");
    const rightTime = Date.parse(right.observedAt ?? "");
    const time = (Number.isFinite(leftTime) ? leftTime : Number.MAX_SAFE_INTEGER) -
      (Number.isFinite(rightTime) ? rightTime : Number.MAX_SAFE_INTEGER);
    return time || String(left.eventKey).localeCompare(String(right.eventKey));
  });
  const groups = conversationTurnGroups(messages);
  const selectedTurnKey = search.selectedTurnKey ?? groups[0]?.key ?? null;
  elements.conversationSubtitle.textContent = `${readableSlug(selected.provider)} · ${formatCount(selected.session?.turnCount ?? groups.length)} turns · ${conversationDuration(selected.session?.startedAt, selected.session?.endedAt)}`;
  elements.conversationKey.textContent = `Session ${selected.sessionKey?.slice(0, 16) ?? "-"}`;
  clear(elements.conversationStateBadge);
  elements.conversationStateBadge.append(badge(selected.completeness === "full" ? "Complete" : "Partial", selected.completeness === "full" ? "ok" : "pending"));
  clear(elements.conversationSessionBar);
  elements.conversationSessionBar.append(
    node("div", { className: "session-bar-primary" }, [
      node("span", { className: "session-bar-label", text: "Session" }),
      node("strong", { text: `${readableSlug(selected.provider)} · Main session` }),
    ]),
    badge(selected.originScope === "main" ? "Main" : readableSlug(selected.originScope || "unknown"), "neutral"),
    node("span", { className: "session-bar-model", text: selected.projectKey ? `Project ${selected.projectKey.slice(0, 16)}` : "Project context unavailable" }),
  );
  for (const tab of document.querySelectorAll("[data-conversation-tab]")) {
    tab.setAttribute("aria-selected", tab.dataset.conversationTab === search.detailTab ? "true" : "false");
  }
  renderConversationTurnRail(groups, selectedTurnKey);
  renderConversationEvidence(selected, messages, groups);
  if (search.messagesLoading && messages.length === 0) {
    clear(elements.conversationMessages);
    elements.conversationMessages.append(node("p", { className: "empty-copy", text: "Loading messages..." }));
  } else if (search.messagesError !== null && messages.length === 0) {
    clear(elements.conversationMessages);
    elements.conversationMessages.append(node("p", {
      className: "empty-copy is-error",
      text: dashboardDiagnosticMessage(search.messagesError),
    }));
  } else {
    renderConversationTab(search.detailTab, selected, messages, groups);
  }
  elements.conversationMessageStatus.textContent = search.messagesLoading && messages.length > 0
    ? `Loading earlier messages / ${formatCount(messages.length)} shown`
    : `${formatCount(messages.length)} of ${formatCount(search.messageTotal)} visible messages`;
  elements.conversationEarlier.hidden = search.detailTab !== "transcript" || search.messageCursor === null;
  elements.conversationEarlier.disabled = search.messagesLoading;
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
  renderSourceOptions(state);
  renderCapabilityOptions(state, "tool");
  renderCapabilityOptions(state, "skill");
  renderSearchControlValues(state);
  renderHistoryMetrics(state);
  renderOverview(state);
  renderExperience(state);
  renderSources(state);
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

async function loadProjectCatalog() {
  const catalog = store.getState().projectCatalog;
  if (catalog.loading || catalog.loaded) return;
  store.dispatch({ type: "project-catalog/loading" });
  try {
    const response = await requestJson("/api/v1/history/projects");
    store.dispatch({ type: "project-catalog/loaded", response });
  } catch (error) {
    store.dispatch({ type: "project-catalog/failed", code: errorCode(error) });
  }
}

async function loadExperienceAssets(repositoryKey = store.getState().experience.repositoryKey) {
  const experience = store.getState().experience;
  if (experience.loading || repositoryKey === "") return;
  store.dispatch({ type: "experience/assets-loading" });
  try {
    const parameters = new URLSearchParams({ repositoryKey });
    const response = await requestJson(`/api/v1/experience/assets?${parameters}`);
    if (store.getState().experience.repositoryKey !== repositoryKey) return;
    store.dispatch({ type: "experience/assets-loaded", response });
  } catch (error) {
    store.dispatch({ type: "experience/failed", code: errorCode(error) });
  }
}

async function loadExperienceRepositories() {
  const experience = store.getState().experience;
  if (experience.loading || experience.repositoriesLoaded) {
    if (experience.repositoriesLoaded && experience.assets === null) {
      await loadExperienceAssets(experience.repositoryKey);
    }
    return;
  }
  store.dispatch({ type: "experience/repositories-loading" });
  try {
    const response = await requestJson("/api/v1/experience/repositories");
    store.dispatch({ type: "experience/repositories-loaded", response });
    await loadExperienceAssets();
  } catch (error) {
    store.dispatch({ type: "experience/failed", code: errorCode(error) });
  }
}

async function runSearch(append = false) {
  const current = store.getState().search;
  if (current.loading || (append && current.response?.nextCursor === null)) return;
  const request = buildConversationRequest(
    current,
    append ? current.response?.nextCursor ?? null : null,
  );
  if (!append) store.dispatch({ type: "conversation/close" });
  store.dispatch({ type: "search/loading", append });
  try {
    const response = await requestJson("/api/v1/conversations", {
      method: "POST",
      body: JSON.stringify(request),
    });
    store.dispatch({ type: "search/loaded", response, append });
  } catch (error) {
    store.dispatch({ type: "search/failed", code: errorCode(error) });
  }
}

function openConversation(session) {
  store.dispatch({ type: "conversation/select", session });
  elements.conversationDetail.scrollTop = 0;
  void loadConversationMessages(false);
}

async function loadConversationMessages(append = false) {
  const search = store.getState().search;
  const selected = search.selected;
  if (selected === null || search.messagesLoading || (append && search.messageCursor === null)) return;
  const sessionKey = selected.sessionKey;
  const request = buildConversationMessagesRequest(
    sessionKey,
    append ? search.messageCursor : null,
  );
  store.dispatch({ type: "conversation/messages-loading" });
  try {
    const response = await requestJson("/api/v1/conversation-messages", {
      method: "POST",
      body: JSON.stringify(request),
    });
    if (store.getState().search.selected?.sessionKey !== sessionKey) return;
    store.dispatch({ type: "conversation/messages-loaded", response, append });
  } catch (error) {
    if (store.getState().search.selected?.sessionKey !== sessionKey) return;
    store.dispatch({ type: "conversation/messages-failed", code: errorCode(error) });
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
    if (view === "overview") void loadExperienceRepositories();
    if (view === "inspector") void loadDeliveryRepositories();
    document.querySelector("#workspace").focus({ preventScroll: true });
  });
}

for (const button of document.querySelectorAll("[data-source-filter]")) {
  button.addEventListener("click", () => {
    store.dispatch({ type: "sources/filter", filter: button.dataset.sourceFilter });
  });
}

document.querySelector("#refresh-button").addEventListener("click", () => {
  void loadStatus();
  if (store.getState().activeView === "overview") {
    void loadExperienceAssets();
  }
});
document.querySelector("#search-form").addEventListener("submit", (event) => {
  event.preventDefault();
  void runSearch(false);
});
document.querySelector("#history-reset").addEventListener("click", () => {
  const range = defaultHistoryDateRange();
  for (const [field, value] of Object.entries({
    query: "",
    provider: "",
    projectKey: "",
    toolCapabilityKey: "",
    skillCapabilityKey: "",
    completeness: "",
    observedAtOrAfter: range.observedAtOrAfter,
    observedBefore: range.observedBefore,
  })) {
    store.dispatch({ type: "search/input", field, value });
  }
  void runSearch(false);
});
for (const button of document.querySelectorAll("[data-history-scope]")) {
  button.addEventListener("click", () => {
    store.dispatch({
      type: "search/input",
      field: "completeness",
      value: button.dataset.historyScope === "all" ? "" : button.dataset.historyScope,
    });
    void runSearch(false);
  });
}
for (const [selector, field] of [
  ["#search-query", "query"],
  ["#provider-filter", "provider"],
  ["#project-filter", "projectKey"],
  ["#after-filter", "observedAtOrAfter"],
  ["#before-filter", "observedBefore"],
  ["#tool-filter", "toolCapabilityKey"],
  ["#skill-filter", "skillCapabilityKey"],
  ["#completeness-filter", "completeness"],
]) {
  document.querySelector(selector).addEventListener("input", (event) => {
    store.dispatch({ type: "search/input", field, value: event.target.value });
  });
}
elements.conversationMore.addEventListener("click", () => void runSearch(true));
elements.conversationEarlier.addEventListener("click", () => void loadConversationMessages(true));
for (const button of document.querySelectorAll("[data-conversation-tab]")) {
  button.addEventListener("click", () => {
    store.dispatch({ type: "conversation/tab", tab: button.dataset.conversationTab });
  });
}
elements.conversationBack.addEventListener("click", () => store.dispatch({ type: "conversation/close" }));
for (const element of [elements.conversationBackdrop, document.querySelector("#conversation-close")]) {
  element.addEventListener("click", () => store.dispatch({ type: "conversation/close" }));
}
for (const button of document.querySelectorAll("[data-load-more]")) {
  button.addEventListener("click", () => void loadCapabilities(button.dataset.loadMore, true));
}
elements.experienceRepository.addEventListener("input", (event) => {
  store.dispatch({ type: "experience/repository-select", repositoryKey: event.target.value });
  void loadExperienceAssets(event.target.value);
});
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
document.addEventListener("keydown", (event) => {
  if (event.key === "Escape" && store.getState().search.selected !== null) {
    store.dispatch({ type: "conversation/close" });
  }
});

render(store.getState());
void loadStatus();
void loadProjectCatalog();
void loadCapabilities("tool");
void loadCapabilities("skill");
void runSearch(false);
const statusTimer = setInterval(() => void loadStatus({ silent: true }), 30_000);
window.addEventListener("pagehide", () => clearInterval(statusTimer), { once: true });
