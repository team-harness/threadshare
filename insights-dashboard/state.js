const EMPTY_COUNTS = Object.freeze({});

export const INITIAL_STATE = Object.freeze({
  activeView: "overview",
  status: null,
  statusState: "loading",
  statusError: null,
  search: Object.freeze({
    query: "",
    provider: "",
    projectKey: "",
    observedAtOrAfter: "",
    observedBefore: "",
    toolCapabilityKey: "",
    skillCapabilityKey: "",
    closure: "",
    resultEvidence: "",
    loading: false,
    error: null,
    response: null,
  }),
  capabilities: Object.freeze({
    tool: Object.freeze({ items: Object.freeze([]), cursor: null, loading: false, error: null }),
    skill: Object.freeze({ items: Object.freeze([]), cursor: null, loading: false, error: null }),
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
    case "status/loading":
      return { ...state, statusState: "loading", statusError: null };
    case "status/loaded":
      return { ...state, status: action.status, statusState: "ready", statusError: null };
    case "status/failed":
      return { ...state, statusState: "error", statusError: action.code ?? "TS_OPERATION_FAILED" };
    case "search/input":
      return { ...state, search: Object.freeze({ ...state.search, [action.field]: action.value }) };
    case "search/loading":
      return { ...state, search: Object.freeze({ ...state.search, loading: true, error: null }) };
    case "search/loaded":
      return { ...state, search: Object.freeze({ ...state.search, loading: false, response: action.response, error: null }) };
    case "search/failed":
      return { ...state, search: Object.freeze({ ...state.search, loading: false, error: action.code ?? "TS_OPERATION_FAILED" }) };
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

export function buildSearchRequest(search) {
  const query = String(search.query ?? "").trim();
  const start = Date.parse(`${search.observedAtOrAfter ?? ""}T00:00:00.000Z`);
  const before = Date.parse(`${search.observedBefore ?? ""}T00:00:00.000Z`);
  const filters = {
    providers: search.provider ? [search.provider] : [],
    projectKeys: search.projectKey ? [search.projectKey] : [],
    observedAtOrAfterUnixMs: Number.isFinite(start) ? String(start) : null,
    observedBeforeUnixMs: Number.isFinite(before) ? String(before) : null,
    toolCapabilityKeys: search.toolCapabilityKey ? [search.toolCapabilityKey] : [],
    skillCapabilityKeys: search.skillCapabilityKey ? [search.skillCapabilityKey] : [],
    resultEvidence: search.resultEvidence ? [search.resultEvidence] : [],
    closureStates: search.closure ? [search.closure] : [],
  };
  return Object.freeze({ query, filters, limit: 50, pathLimit: 10 });
}

export function overviewCounts(status) {
  const overview = status?.overview;
  if (overview === null || typeof overview !== "object") return EMPTY_COUNTS;
  return overview;
}
