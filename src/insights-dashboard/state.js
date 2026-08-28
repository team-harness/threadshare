const EMPTY_COUNTS = Object.freeze({});

export const INITIAL_STATE = Object.freeze({
  activeView: "search",
  status: null,
  statusState: "loading",
  statusError: null,
  projectCatalog: Object.freeze({
    items: Object.freeze([]),
    loaded: false,
    loading: false,
    error: null,
  }),
  sources: Object.freeze({
    filter: "all",
    selectedId: "codex",
  }),
  search: Object.freeze({
    query: "",
    provider: "",
    projectKey: "",
    observedAtOrAfter: "",
    observedBefore: "",
    toolCapabilityKey: "",
    skillCapabilityKey: "",
    completeness: "",
    loading: false,
    loadingAppend: false,
    error: null,
    response: null,
    selected: null,
    messages: Object.freeze([]),
    messageCursor: null,
    messageTotal: null,
    messagesLoading: false,
    messagesError: null,
    detailTab: "transcript",
    selectedTurnKey: null,
  }),
  capabilities: Object.freeze({
    tool: Object.freeze({ items: Object.freeze([]), cursor: null, loading: false, error: null }),
    skill: Object.freeze({ items: Object.freeze([]), cursor: null, loading: false, error: null }),
  }),
  experience: Object.freeze({
    repositories: Object.freeze([]),
    repositoriesLoaded: false,
    repositoryKey: "",
    assets: null,
    loading: false,
    error: null,
  }),
  delivery: Object.freeze({
    mode: "date",
    repositories: Object.freeze([]),
    repositoryKey: "",
    after: "",
    before: "",
    edges: Object.freeze([]),
    edgeCursor: null,
    intentRoots: Object.freeze([]),
    intentCursor: null,
    trace: null,
    traceCursor: null,
    selected: null,
    relatedNodeKeys: Object.freeze([]),
    evidence: null,
    evidenceTarget: null,
    evidenceLoading: false,
    timeline: null,
    timelineLoading: false,
    diff: null,
    diffLoading: false,
    loading: false,
    traceLoading: false,
    error: null,
  }),
  inspector: Object.freeze({
    mode: "closed",
    title: "Evidence",
    family: null,
    turn: null,
    entries: Object.freeze([]),
    cursor: null,
    loading: false,
    error: null,
  }),
});

function capabilityPage(state, kind) {
  return state.capabilities[kind] ?? state.capabilities.tool;
}

function freezeList(value) {
  return Object.freeze(Array.isArray(value) ? [...value] : []);
}

const CURRENT_SOURCE_CATALOG = Object.freeze([
  Object.freeze({
    sourceAdapterId: "codex",
    displayName: "Codex",
    storage: "Local JSONL sessions",
    runtime: "Built in",
  }),
  Object.freeze({
    sourceAdapterId: "claude",
    displayName: "Claude Code",
    storage: "Local JSONL sessions",
    runtime: "Built in",
  }),
]);

const SOURCE_FILTERS = new Set(["all", "snapshot", "eligible"]);

function hasCount(value) {
  return typeof value === "number"
    ? Number.isSafeInteger(value) && value > 0
    : typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value) && value !== "0";
}

function sumCounts(items, field) {
  let total = 0n;
  for (const item of items) {
    const value = item?.[field];
    if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) {
      total += BigInt(value);
    } else if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
      total += BigInt(value);
    }
  }
  return total.toString();
}

function sourceOperations(source) {
  return Object.freeze([
    Object.freeze({ id: "sessions", label: "Sessions", state: "supported", detail: "Local discovery and bounded reads" }),
    Object.freeze({ id: "share", label: "Share", state: "supported", detail: "Portable history export" }),
    Object.freeze({
      id: "insights",
      label: "Insights",
      state: source.inSnapshot ? "indexed" : "sync-required",
      detail: source.inSnapshot ? `${source.indexedTurnCount} committed turns` : "No committed source data",
    }),
    Object.freeze({
      id: "memory",
      label: "Team Memory",
      state: "gated",
      detail: source.inSnapshot ? "Eligibility checked at recall" : "Insights sync required",
    }),
  ]);
}

export function sourceCatalogViewModel(status, filter = "all", selectedId = "codex") {
  const overview = status?.overview;
  const rollups = new Map((overview?.providers?.items ?? []).map((item) => [item.provider, item]));
  const sourceDefinitions = [...CURRENT_SOURCE_CATALOG];
  for (const item of overview?.providers?.items ?? []) {
    if (sourceDefinitions.some((source) => source.sourceAdapterId === item.provider)) continue;
    sourceDefinitions.push(Object.freeze({
      sourceAdapterId: item.provider,
      displayName: item.provider,
      storage: "Committed provider records",
      runtime: "Observed",
    }));
  }
  const sources = sourceDefinitions.map((definition) => {
    const rollup = rollups.get(definition.sourceAdapterId) ?? {};
    const source = {
      ...definition,
      rawSessionCount: rollup.rawSessionCount ?? "0",
      eligibleSessionCount: rollup.eligibleSessionCount ?? "0",
      indexedTurnCount: rollup.indexedTurnCount ?? "0",
      inSnapshot: hasCount(rollup.rawSessionCount),
      hasEligibleSessions: hasCount(rollup.eligibleSessionCount),
    };
    return Object.freeze({ ...source, operations: sourceOperations(source) });
  });
  const normalizedFilter = SOURCE_FILTERS.has(filter) ? filter : "all";
  const visibleSources = sources.filter((source) => normalizedFilter === "all" ||
    (normalizedFilter === "snapshot" && source.inSnapshot) ||
    (normalizedFilter === "eligible" && source.hasEligibleSessions));
  const selected = visibleSources.find((source) => source.sourceAdapterId === selectedId) ??
    visibleSources[0] ?? null;
  return Object.freeze({
    filter: normalizedFilter,
    sources: Object.freeze(sources),
    visibleSources: Object.freeze(visibleSources),
    selected,
    snapshotSeq: overview?.snapshotSeq ?? status?.engine?.snapshotSeq ?? null,
    totals: Object.freeze({
      supportedSources: String(CURRENT_SOURCE_CATALOG.length),
      snapshotSources: String(sources.filter((source) => source.inSnapshot).length),
      eligibleSessions: sumCounts(sources, "eligibleSessionCount"),
      indexedTurns: sumCounts(sources, "indexedTurnCount"),
    }),
  });
}

function nodeIdentity(value) {
  return typeof value?.kind === "string" && typeof value?.key === "string"
    ? `${value.kind}:${value.key}`
    : null;
}

const DELIVERY_KIND_LABELS = Object.freeze({
  intent: "Requirement",
  repository: "Repository",
  session: "Agent session",
  turn: "Agent turn",
  "capability-use": "Tool or Skill use",
  file: "Changed file",
  "git-commit": "Commit",
});

const DELIVERY_RELATION_LABELS = Object.freeze({
  "intent-declares-session": "Requirement names this Agent session",
  "intent-declares-commit": "Requirement names this commit",
  "session-contains-turn": "Turn belongs to this Agent session",
  "turn-contains-capability-use": "Tool or Skill was used in this turn",
  "session-touched-file": "Agent session touched this file",
  "commit-changed-file": "Commit changed this file",
  "session-observed-commit": "Agent observed this commit result",
  "session-correlates-commit": "Agent session is linked to this commit",
  "intent-correlates-session": "Requirement is linked to this Agent session",
  "contextual-same-file": "Items touched the same file",
});

const DELIVERY_SOURCE_LABELS = Object.freeze({
  "intent-explicit-session-ref": "Explicit session reference in the requirement",
  "intent-explicit-commit-ref": "Explicit commit reference in the requirement",
  "session-membership": "Recorded Agent session membership",
  "turn-membership": "Recorded Agent turn membership",
  "normalized-file-event": "Recorded file activity",
  "git-tree-diff": "Git commit tree",
  "observed-git-result": "Successful git commit output observed in the Agent session",
  "ordered-exact-path-overlap": "Matching file paths in the same delivery window",
  "unique-text-overlap": "Unique text overlap",
  "same-file-history": "Shared file history",
});

const DELIVERY_LIMITATION_LABELS = Object.freeze({
  "not-authorship": "This link does not prove who authored the commit.",
  "not-exclusive-line-attribution": "This link does not prove that every changed line came from this Agent session.",
  "not-causality": "This link shows association, not causation.",
  "incomplete-timestamps": "Some timestamps were unavailable.",
  "unverified-intent-reference": "The requirement reference could not be independently verified.",
  "unreachable-commit": "The commit is not reachable from the current repository state.",
  "path-only-context": "This link is based only on shared file paths.",
  "candidate-not-default": "This possible link is hidden unless candidate evidence is requested.",
});

export function deliveryKindLabel(kind) {
  return DELIVERY_KIND_LABELS[kind] ?? "Evidence item";
}

export function humanizeDeliveryEdge(edge) {
  const limitations = Array.isArray(edge?.limitations)
    ? edge.limitations.map((value) => DELIVERY_LIMITATION_LABELS[value] ?? "This evidence has an unspecified limitation.")
    : [];
  return Object.freeze({
    relation: DELIVERY_RELATION_LABELS[edge?.relation] ?? "These items are linked",
    source: DELIVERY_SOURCE_LABELS[edge?.source] ?? "Recorded delivery evidence",
    strength: edge?.strength === "direct"
      ? "Direct evidence"
      : edge?.strength === "observed"
        ? "Observed evidence"
        : edge?.strength === "candidate"
          ? "Possible link"
          : "Context only",
    limitations: Object.freeze(limitations),
  });
}

export function deliveryTraceViewModel(trace) {
  const counts = {
    intent: 0,
    repository: 0,
    session: 0,
    turn: 0,
    "capability-use": 0,
    file: 0,
    "git-commit": 0,
  };
  for (const item of trace?.nodes ?? []) {
    if (Object.hasOwn(counts, item.kind)) counts[item.kind] += 1;
  }
  const rootIdentity = nodeIdentity(trace?.root);
  const root = (trace?.nodes ?? []).find((item) => nodeIdentity(item) === rootIdentity) ?? trace?.root ?? null;
  const title = root?.label || root?.attributes?.path || (root?.kind === "git-commit"
    ? root?.attributes?.shortHash
    : null) || (typeof root?.key === "string" ? root.key.slice(0, 12) : "Select delivery evidence");
  let summary;
  if (root?.kind === "git-commit") {
    summary = `${counts.session} Agent session${counts.session === 1 ? "" : "s"} and ${counts.file} changed file${counts.file === 1 ? "" : "s"} are linked to this commit.`;
  } else if (root?.kind === "intent") {
    summary = `${counts.session} Agent session${counts.session === 1 ? "" : "s"} and ${counts["git-commit"]} commit${counts["git-commit"] === 1 ? "" : "s"} are linked to this requirement.`;
  } else if (root?.kind === "session") {
    summary = `This Agent session is linked to ${counts["git-commit"]} commit${counts["git-commit"] === 1 ? "" : "s"} and ${counts.file} changed file${counts.file === 1 ? "" : "s"}.`;
  } else {
    summary = `${counts.intent} requirement${counts.intent === 1 ? "" : "s"}, ${counts.session} Agent session${counts.session === 1 ? "" : "s"}, and ${counts["git-commit"]} commit${counts["git-commit"] === 1 ? "" : "s"} are linked in this delivery trace.`;
  }
  const strengths = new Set((trace?.edges ?? []).map((edge) => edge.strength));
  const evidence = strengths.has("direct")
    ? "Direct evidence is available."
    : strengths.has("observed")
      ? "Observed evidence links these items."
      : strengths.has("candidate")
        ? "Only possible links are available."
        : strengths.has("contextual")
          ? "Only contextual links are available."
          : "No delivery evidence is linked yet.";
  const limitations = [...new Set((trace?.edges ?? [])
    .flatMap((edge) => humanizeDeliveryEdge(edge).limitations))];
  return Object.freeze({
    title,
    summary,
    evidence,
    counts: Object.freeze(counts),
    edgeCount: (trace?.edges ?? []).length,
    limitations: Object.freeze(limitations),
  });
}

export function dashboardDiagnosticMessage(code) {
  const messages = {
    TS_INSIGHTS_STORAGE_FAILED: "Some delivery details could not be read. Refresh this view, or run `threadshare insights sync --repository .`.",
    TS_INSIGHTS_ENGINE_UNAVAILABLE: "The saved index was found, but live Insights queries are unavailable.",
    TS_OPERATION_FAILED: "The request did not complete. Refresh this view and try again.",
  };
  return messages[code] ?? "The request did not complete. Refresh this view and try again.";
}

export function relatedTraceNodeKeys(trace, selected) {
  const selectedIdentity = nodeIdentity(selected);
  if (selectedIdentity === null || !Array.isArray(trace?.edges)) return [];
  const related = new Set();
  for (const edge of trace.edges) {
    const from = nodeIdentity(edge?.from);
    const to = nodeIdentity(edge?.to);
    if (from === selectedIdentity && to !== null && to !== selectedIdentity) related.add(to);
    if (to === selectedIdentity && from !== null && from !== selectedIdentity) related.add(from);
  }
  return Object.freeze([...related].sort());
}

function replaceCapabilityPage(state, kind, patch) {
  const current = capabilityPage(state, kind);
  return {
    ...state,
    capabilities: Object.freeze({
      ...state.capabilities,
      [kind]: Object.freeze({ ...current, ...patch }),
    }),
  };
}

export function reduceDashboardState(state = INITIAL_STATE, action) {
  switch (action?.type) {
    case "view/select":
      return { ...state, activeView: action.view };
    case "sources/filter":
      return {
        ...state,
        sources: Object.freeze({
          ...state.sources,
          filter: SOURCE_FILTERS.has(action.filter) ? action.filter : "all",
        }),
      };
    case "sources/select":
      return {
        ...state,
        sources: Object.freeze({ ...state.sources, selectedId: action.sourceAdapterId }),
      };
    case "status/loading":
      return { ...state, statusState: "loading", statusError: null };
    case "status/loaded":
      return { ...state, status: action.status, statusState: "ready", statusError: null };
    case "status/failed":
      return { ...state, statusState: "error", statusError: action.code ?? "TS_OPERATION_FAILED" };
    case "project-catalog/loading":
      return {
        ...state,
        projectCatalog: Object.freeze({
          ...state.projectCatalog,
          loading: true,
          error: null,
        }),
      };
    case "project-catalog/loaded":
      return {
        ...state,
        projectCatalog: Object.freeze({
          ...state.projectCatalog,
          items: freezeList(action.response?.items),
          loaded: true,
          loading: false,
          error: null,
        }),
      };
    case "project-catalog/failed":
      return {
        ...state,
        projectCatalog: Object.freeze({
          ...state.projectCatalog,
          loading: false,
          error: action.code ?? "TS_OPERATION_FAILED",
        }),
      };
    case "search/input":
      return { ...state, search: Object.freeze({ ...state.search, [action.field]: action.value }) };
    case "search/loading":
      return {
        ...state,
        search: Object.freeze({
          ...state.search,
          loading: true,
          loadingAppend: action.append === true,
          error: null,
        }),
      };
    case "search/loaded": {
      const records = action.append
        ? [...(state.search.response?.records ?? []), ...(action.response?.records ?? [])]
        : action.response?.records ?? [];
      return {
        ...state,
        search: Object.freeze({
          ...state.search,
          loading: false,
          loadingAppend: false,
          response: Object.freeze({ ...action.response, records: freezeList(records) }),
          error: null,
        }),
      };
    }
    case "search/failed":
      return {
        ...state,
        search: Object.freeze({
          ...state.search,
          loading: false,
          loadingAppend: false,
          error: action.code ?? "TS_OPERATION_FAILED",
        }),
      };
    case "conversation/select":
      return {
        ...state,
        search: Object.freeze({
          ...state.search,
          selected: action.session,
          messages: Object.freeze([]),
          messageCursor: null,
          messageTotal: null,
          messagesLoading: false,
          messagesError: null,
          detailTab: "transcript",
          selectedTurnKey: null,
        }),
      };
    case "conversation/close":
      return {
        ...state,
        search: Object.freeze({
          ...state.search,
          selected: null,
          messages: Object.freeze([]),
          messageCursor: null,
          messageTotal: null,
          messagesLoading: false,
          messagesError: null,
          detailTab: "transcript",
          selectedTurnKey: null,
        }),
      };
    case "conversation/tab":
      return {
        ...state,
        search: Object.freeze({
          ...state.search,
          detailTab: ["transcript", "execution", "delivery", "insights"].includes(action.tab)
            ? action.tab
            : "transcript",
        }),
      };
    case "conversation/turn":
      return {
        ...state,
        search: Object.freeze({
          ...state.search,
          selectedTurnKey: typeof action.turnKey === "string" ? action.turnKey : null,
        }),
      };
    case "conversation/messages-loading":
      return {
        ...state,
        search: Object.freeze({ ...state.search, messagesLoading: true, messagesError: null }),
      };
    case "conversation/messages-loaded":
      return {
        ...state,
        search: Object.freeze({
          ...state.search,
          messages: freezeList(action.append
            ? [...state.search.messages, ...(action.response?.records ?? [])]
            : action.response?.records),
          messageCursor: action.response?.nextCursor ?? null,
          messageTotal: action.response?.totalMatchCount ?? null,
          messagesLoading: false,
          messagesError: null,
        }),
      };
    case "conversation/messages-failed":
      return {
        ...state,
        search: Object.freeze({
          ...state.search,
          messagesLoading: false,
          messagesError: action.code ?? "TS_OPERATION_FAILED",
        }),
      };
    case "capabilities/loading":
      return replaceCapabilityPage(state, action.kind, { loading: true, error: null });
    case "capabilities/loaded": {
      const current = capabilityPage(state, action.kind);
      return replaceCapabilityPage(state, action.kind, {
        items: freezeList(action.append ? [...current.items, ...action.page.items] : action.page.items),
        cursor: action.page.nextCursor ?? null,
        loading: false,
        error: null,
      });
    }
    case "capabilities/failed":
      return replaceCapabilityPage(state, action.kind, { loading: false, error: action.code ?? "TS_OPERATION_FAILED" });
    case "experience/repositories-loading":
      return {
        ...state,
        experience: Object.freeze({ ...state.experience, loading: true, error: null }),
      };
    case "experience/repositories-loaded": {
      const repositories = freezeList(action.response?.items);
      const repositoryKey = repositories.some(
        (repository) => repository.repositoryKey === state.experience.repositoryKey,
      ) ? state.experience.repositoryKey : repositories[0]?.repositoryKey ?? "";
      return {
        ...state,
        experience: Object.freeze({
          ...state.experience,
          repositories,
          repositoriesLoaded: true,
          repositoryKey,
          loading: false,
          error: null,
        }),
      };
    }
    case "experience/repository-select":
      return {
        ...state,
        experience: Object.freeze({
          ...state.experience,
          repositoryKey: action.repositoryKey,
          assets: null,
          error: null,
        }),
      };
    case "experience/assets-loading":
      return {
        ...state,
        experience: Object.freeze({ ...state.experience, loading: true, error: null }),
      };
    case "experience/assets-loaded":
      return {
        ...state,
        experience: Object.freeze({
          ...state.experience,
          assets: action.response,
          loading: false,
          error: null,
        }),
      };
    case "experience/failed":
      return {
        ...state,
        experience: Object.freeze({
          ...state.experience,
          loading: false,
          error: action.code ?? "TS_OPERATION_FAILED",
        }),
      };
    case "delivery/repositories-loading":
      return { ...state, delivery: Object.freeze({ ...state.delivery, loading: true, error: null }) };
    case "delivery/repositories-loaded": {
      const repositories = freezeList(action.response?.items);
      const repositoryKey = state.delivery.repositoryKey || repositories[0]?.repositoryKey || "";
      return {
        ...state,
        delivery: Object.freeze({
          ...state.delivery,
          repositories,
          repositoryKey,
          loading: false,
          error: null,
        }),
      };
    }
    case "delivery/input":
      return {
        ...state,
        delivery: Object.freeze({
          ...state.delivery,
          [action.field]: action.value,
          edges: Object.freeze([]),
          edgeCursor: null,
          intentRoots: Object.freeze([]),
          intentCursor: null,
          trace: null,
          traceCursor: null,
          selected: null,
          relatedNodeKeys: Object.freeze([]),
          evidence: null,
          evidenceTarget: null,
          evidenceLoading: false,
          timeline: null,
          timelineLoading: false,
          diff: null,
          diffLoading: false,
          error: null,
        }),
      };
    case "delivery/edges-loading":
      return { ...state, delivery: Object.freeze({ ...state.delivery, loading: true, error: null }) };
    case "delivery/edges-loaded":
      return {
        ...state,
        delivery: Object.freeze({
          ...state.delivery,
          edges: freezeList(action.append
            ? [...state.delivery.edges, ...(action.response.records ?? [])]
            : action.response.records),
          edgeCursor: action.response.nextCursor ?? null,
          loading: false,
          error: null,
        }),
      };
    case "delivery/intents-loaded":
      {
        const intentNodes = (action.response.nodes ?? []).filter((node) => node.kind === "intent");
      return {
        ...state,
        delivery: Object.freeze({
          ...state.delivery,
          intentRoots: freezeList(action.append
            ? [...state.delivery.intentRoots, ...intentNodes]
            : intentNodes),
          intentCursor: action.response.nextCursor ?? null,
          trace: action.append ? state.delivery.trace : action.response,
          traceCursor: action.append ? state.delivery.traceCursor : null,
          selected: action.append ? state.delivery.selected : null,
          relatedNodeKeys: Object.freeze([]),
          loading: false,
          error: null,
        }),
      };
      }
    case "delivery/trace-loading":
      return { ...state, delivery: Object.freeze({ ...state.delivery, traceLoading: true, error: null }) };
    case "delivery/trace-loaded": {
      const selected = action.selected ?? action.response.root;
      const response = action.append && state.delivery.trace !== null
        ? Object.freeze({
            ...action.response,
            nodes: freezeList([...state.delivery.trace.nodes, ...action.response.nodes]),
            edges: freezeList([...state.delivery.trace.edges, ...action.response.edges]),
          })
        : action.response;
      return {
        ...state,
        delivery: Object.freeze({
          ...state.delivery,
          trace: response,
          traceCursor: response.nextCursor ?? null,
          selected,
          relatedNodeKeys: relatedTraceNodeKeys(response, selected),
          evidence: null,
          evidenceTarget: null,
          evidenceLoading: false,
          timeline: null,
          timelineLoading: false,
          diff: null,
          diffLoading: false,
          traceLoading: false,
          error: null,
        }),
      };
    }
    case "delivery/select":
      return {
        ...state,
        delivery: Object.freeze({
          ...state.delivery,
          selected: action.node,
          relatedNodeKeys: relatedTraceNodeKeys(state.delivery.trace, action.node),
          evidence: null,
          evidenceTarget: null,
          evidenceLoading: false,
          timeline: null,
          timelineLoading: false,
          diff: null,
          diffLoading: false,
        }),
      };
    case "delivery/evidence-loading":
      return {
        ...state,
        delivery: Object.freeze({
          ...state.delivery,
          evidenceLoading: true,
          evidenceTarget: action.target ?? state.delivery.evidenceTarget,
          error: null,
        }),
      };
    case "delivery/evidence-loaded":
      return {
        ...state,
        delivery: Object.freeze({
          ...state.delivery,
          evidenceLoading: false,
          evidence: action.append && state.delivery.evidence !== null
            ? Object.freeze({
                ...action.response,
                content: `${state.delivery.evidence.content}${action.response.content}`,
                range: Object.freeze({
                  start: state.delivery.evidence.range.start,
                  end: action.response.range.end,
                }),
              })
            : action.response,
          error: null,
        }),
      };
    case "delivery/timeline-loading":
      return { ...state, delivery: Object.freeze({ ...state.delivery, timelineLoading: true, error: null }) };
    case "delivery/timeline-loaded":
      return { ...state, delivery: Object.freeze({ ...state.delivery, timelineLoading: false, timeline: action.response, error: null }) };
    case "delivery/diff-loading":
      return { ...state, delivery: Object.freeze({ ...state.delivery, diffLoading: true, error: null }) };
    case "delivery/diff-loaded":
      return {
        ...state,
        delivery: Object.freeze({
          ...state.delivery,
          diffLoading: false,
          diff: action.append && state.delivery.diff !== null
            ? Object.freeze({
                ...action.response,
                content: `${state.delivery.diff.content}${action.response.content}`,
                range: Object.freeze({
                  start: state.delivery.diff.range.start,
                  end: action.response.range.end,
                }),
              })
            : action.response,
          error: null,
        }),
      };
    case "delivery/close":
      return {
        ...state,
        delivery: Object.freeze({
          ...state.delivery,
          selected: null,
          relatedNodeKeys: Object.freeze([]),
          evidence: null,
          evidenceTarget: null,
          evidenceLoading: false,
          timeline: null,
          timelineLoading: false,
          diff: null,
          diffLoading: false,
        }),
      };
    case "delivery/failed":
      return {
        ...state,
        delivery: Object.freeze({
          ...state.delivery,
          loading: false,
          traceLoading: false,
          evidenceLoading: false,
          timelineLoading: false,
          diffLoading: false,
          error: action.code ?? "TS_OPERATION_FAILED",
        }),
      };
    case "inspector/family":
      return {
        ...state,
        inspector: Object.freeze({
          ...INITIAL_STATE.inspector,
          mode: "family",
          title: "Tool path",
          family: action.family,
        }),
      };
    case "inspector/evidence-loading":
      return {
        ...state,
        inspector: Object.freeze({
          ...state.inspector,
          mode: "turn",
          title: "Turn evidence",
          loading: true,
          error: null,
          turn: action.turn,
          entries: action.append ? state.inspector.entries : Object.freeze([]),
        }),
      };
    case "inspector/evidence-loaded":
      return {
        ...state,
        inspector: Object.freeze({
          ...state.inspector,
          mode: "turn",
          loading: false,
          error: null,
          turn: action.page.turn,
          entries: freezeList(action.append
            ? [...state.inspector.entries, ...action.page.entries]
            : action.page.entries),
          cursor: action.page.nextCursor ?? null,
        }),
      };
    case "inspector/evidence-failed":
      return {
        ...state,
        inspector: Object.freeze({
          ...state.inspector,
          mode: "turn",
          loading: false,
          error: action.code ?? "TS_OPERATION_FAILED",
        }),
      };
    case "inspector/close":
      return { ...state, inspector: INITIAL_STATE.inspector };
    default:
      return state;
  }
}

export function createDashboardStore(initialState = INITIAL_STATE) {
  let state = initialState;
  const listeners = new Set();
  return Object.freeze({
    getState() {
      return state;
    },
    dispatch(action) {
      state = reduceDashboardState(state, action);
      for (const listener of listeners) listener(state);
      return state;
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => listeners.delete(listener);
    },
  });
}

export function errorCode(error) {
  return typeof error?.code === "string"
    ? error.code
    : typeof error?.error?.code === "string"
      ? error.error.code
      : "TS_OPERATION_FAILED";
}

export function decimalCount(value) {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(?:0|[1-9][0-9]*)$/u.test(value)) {
    const parsed = Number(value);
    return Number.isSafeInteger(parsed) ? parsed : value;
  }
  return 0;
}

export function formatCount(value) {
  const count = decimalCount(value);
  return typeof count === "number" ? new Intl.NumberFormat("en-US").format(count) : count;
}

export function formatBytes(value) {
  const bytes = Number(decimalCount(value));
  if (!Number.isFinite(bytes) || bytes <= 0) return "0 B";
  const units = ["B", "KiB", "MiB", "GiB", "TiB"];
  const unit = Math.min(Math.floor(Math.log(bytes) / Math.log(1024)), units.length - 1);
  const number = bytes / 1024 ** unit;
  return `${number >= 10 || unit === 0 ? number.toFixed(0) : number.toFixed(1)} ${units[unit]}`;
}

export function formatAge(value) {
  if (value === null || value === undefined || value === "") return "unknown";
  const milliseconds = Number(value);
  if (!Number.isFinite(milliseconds) || milliseconds < 0) return "unknown";
  if (milliseconds < 1000) return `${Math.round(milliseconds)} ms`;
  if (milliseconds < 60_000) return `${Math.round(milliseconds / 1000)} s`;
  if (milliseconds < 3_600_000) return `${Math.round(milliseconds / 60_000)} min`;
  return `${Math.round(milliseconds / 3_600_000)} hr`;
}

export function defaultHistoryDateRange(nowUnixMs = Date.now()) {
  const now = new Date(nowUnixMs);
  if (!Number.isFinite(now.getTime())) throw new RangeError("nowUnixMs must be a valid timestamp");
  const before = new Date(Date.UTC(
    now.getUTCFullYear(),
    now.getUTCMonth(),
    now.getUTCDate() + 1,
  ));
  const after = new Date(before.getTime() - 14 * 24 * 60 * 60 * 1000);
  return Object.freeze({
    observedAtOrAfter: after.toISOString().slice(0, 10),
    observedBefore: before.toISOString().slice(0, 10),
  });
}

export function buildConversationRequest(search, cursor = null) {
  return Object.freeze({
    after: utcDateTimestamp(search.observedAtOrAfter),
    before: utcDateTimestamp(search.observedBefore),
    provider: search.provider || null,
    projectKey: search.projectKey || null,
    query: String(search.query ?? "").trim(),
    toolCapabilityKey: search.toolCapabilityKey || null,
    skillCapabilityKey: search.skillCapabilityKey || null,
    completeness: search.completeness || null,
    cursor,
    limit: 30,
  });
}

export function buildConversationMessagesRequest(sessionKey, cursor = null) {
  return Object.freeze({ sessionKey, cursor, limit: 20 });
}

function utcDateTimestamp(value) {
  if (typeof value !== "string" || !/^\d{4}-\d{2}-\d{2}$/u.test(value)) return null;
  const milliseconds = Date.parse(`${value}T00:00:00.000Z`);
  return Number.isFinite(milliseconds) ? new Date(milliseconds).toISOString() : null;
}

export function buildInspectorEdgeRequest(delivery, cursor = null) {
  return Object.freeze({
    repositoryKey: delivery.repositoryKey,
    after: utcDateTimestamp(delivery.after),
    before: utcDateTimestamp(delivery.before),
    cursor,
    limit: 50,
  });
}

export function buildDeliveryTraceRequest(root, cursor = null) {
  return Object.freeze({
    format: "threadshare-insights-recipe-request@v1",
    root: Object.freeze({ kind: root.kind, key: root.key }),
    window: null,
    direction: "both",
    maxDepth: 1,
    includeCandidateEdges: false,
    includeContextualEdges: false,
    limit: 100,
    cursor,
  });
}

export function overviewCounts(status) {
  const overview = status?.overview;
  if (overview === null || typeof overview !== "object") return EMPTY_COUNTS;
  return overview;
}

const PROJECT_KEY_PATTERN = /^[0-9a-f]{64}$/u;

/**
 * Builds the human-facing project choices without exposing every anonymous
 * project fingerprint returned by the bounded overview rollup.
 */
export function projectFilterViewModel(status, catalog = {}) {
  const projectPage = overviewCounts(status).projects ?? {};
  const overviewItems = Array.isArray(projectPage.items) ? projectPage.items : [];
  const rollups = new Map(
    overviewItems
      .filter((item) => PROJECT_KEY_PATTERN.test(item?.projectKey ?? ""))
      .map((item) => [item.projectKey, item]),
  );
  const seen = new Set();
  const options = [];
  for (const item of Array.isArray(catalog.items) ? catalog.items : []) {
    const projectKey = item?.projectKey;
    if (!PROJECT_KEY_PATTERN.test(projectKey ?? "") || seen.has(projectKey)) continue;
    seen.add(projectKey);
    const rollup = rollups.get(projectKey) ?? {};
    options.push({
      projectKey,
      repositoryKey: item.repositoryKey,
      provider: item.provider,
      label: item.label,
      indexedTurnCount: rollup.indexedTurnCount ?? "0",
      rawSessionCount: rollup.rawSessionCount ?? "0",
      eligibleSessionCount: rollup.eligibleSessionCount ?? "0",
    });
  }
  options.sort((left, right) =>
    String(left.label).localeCompare(String(right.label)) ||
    String(left.provider).localeCompare(String(right.provider)) ||
    left.projectKey.localeCompare(right.projectKey));

  const anonymousCount = overviewItems.filter((item) => !seen.has(item?.projectKey)).length;
  let message = null;
  if (catalog.loading === true) {
    message = "Loading registered projects...";
  } else if (catalog.error !== null && catalog.error !== undefined) {
    message = "Project labels unavailable; paste an exact 64-character project key.";
  } else if (catalog.loaded !== true) {
    message = "Project labels are loaded separately from anonymous history rollups.";
  } else if (options.length === 0) {
    message = "No registered projects are in this index; paste an exact 64-character project key.";
  } else if (anonymousCount > 0 || projectPage.truncated === true) {
    message = "Showing registered projects only; other project identities require an exact key.";
  }
  return Object.freeze({
    options: Object.freeze(options.map((item) => Object.freeze(item))),
    message,
    anonymousCount,
    overviewTruncated: projectPage.truncated === true,
  });
}
