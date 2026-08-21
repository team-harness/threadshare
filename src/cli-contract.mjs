import { createMessagePreview } from "./history-selection.mjs";

export const DEFAULT_THREADSHARE_URL = "https://cloud-thread.team-harness.com";

export const OPTION_DEFINITIONS = Object.freeze({
  before: {
    type: "value",
    placeholder: "<user-message-id>",
    description: "Exclude this user message and every later entry from the selected range.",
  },
  cursor: {
    type: "value",
    placeholder: "<cursor>",
    description: "Continue a bounded Insights page using its opaque authenticated cursor.",
  },
  "dry-run": {
    type: "boolean",
    description: "Validate and summarize a share locally without making a network request.",
  },
  expires: {
    type: "value",
    placeholder: "<duration>",
    description: "Request expiration from 1m through 365d using an integer and m, h, or d.",
  },
  format: {
    type: "value",
    placeholder: "<format>",
    description: "Select the command's documented output format.",
  },
  from: {
    type: "value",
    placeholder: "<user-message-id|last-user>",
    description: "Include this user message and every visible entry after it in the selected range.",
  },
  help: {
    type: "boolean",
    description: "Show help without reading user files, starting Paseo, or accessing the network.",
  },
  "regenerate-secret": {
    type: "boolean",
    description: "Rebuild keyed Facts with a newly generated origin secret after interactive confirmation.",
  },
  verify: {
    type: "boolean",
    description: "Run the explicit full SQLite and FTS integrity check for Insights status.",
  },
  json: {
    type: "boolean",
    description: "Write the command's documented one-line JSON success result.",
  },
  limit: {
    type: "value",
    placeholder: "<n>",
    description: "Return 1 through 50 items. The default is 10.",
  },
  runner: {
    type: "value",
    placeholder: "<claude>",
    description: "Select the restricted extraction runner. Only claude is available in Phase 1.",
  },
  "approve-plan": {
    type: "value",
    placeholder: "<digest>",
    description: "Authorize delivery of one pending extraction plan by its exact plan digest.",
  },
  "approve-manifest": {
    type: "value",
    placeholder: "<digest>",
    description: "Authorize delivery of a multi-plan run by its exact authorization manifest digest.",
  },
  plan: {
    type: "value",
    placeholder: "<plan-id>",
    description: "Apply the approved promotion plan with this id, writing only into the worktree.",
  },
  provider: {
    type: "value",
    placeholder: "<provider>",
    description: "Assemble team memory into this provider's context file. Only claude is implemented.",
  },
  offset: {
    type: "value",
    placeholder: "<n>",
    description: "Skip a non-negative safe-integer number of items. The default is 0.",
  },
  output: {
    type: "value",
    placeholder: "<file|->",
    description: "Write to a file, or use - for stdout. The default is stdout.",
  },
  "pick-start": {
    type: "boolean",
    description: "Interactively choose a starting user message in a TTY.",
  },
  "clear-intent": {
    type: "boolean",
    description: "Remove the optional Markdown checklist from a registered repository.",
  },
  query: {
    type: "value",
    placeholder: "<text>",
    description: "Search indexed Turn excerpts with a bounded UTF-8 query.",
  },
  report: {
    type: "boolean",
    description: "Add safe aggregate counts to a dry run. Requires --dry-run.",
  },
  repository: {
    type: "value",
    placeholder: "<path>",
    description: "Register and sync one local Git repository without scanning unrelated directories.",
  },
  intent: {
    type: "value",
    placeholder: "<repository-relative-markdown-file>",
    description: "Attach one explicit Markdown checklist intent source to the registered repository.",
  },
  request: {
    type: "value",
    placeholder: "<file|->",
    description: "Read a canonical Insights request from a file, or use - for stdin.",
  },
  revision: {
    type: "value",
    placeholder: "<revision>",
    description: "Require the exact revision returned by an Insights search result.",
  },
  stdio: {
    type: "boolean",
    description: "Run the local Insights MCP server over standard input and output.",
  },
  revoke: {
    type: "boolean",
    description: "Create a client-held revoke capability and ask the service to enable revocation.",
  },
  token: {
    type: "opaque",
    placeholder: "<token>",
    description: "Use the 256-bit base64url revoke capability shown once when the share was created.",
  },
  url: {
    type: "value",
    placeholder: "<service-url>",
    description: "Override the HTTP(S) Threadshare service for publish or share.",
  },
});

const argument = (name, placeholder, description, optional = false) =>
  Object.freeze({ name, placeholder, description, optional });

const SESSION_PROVIDER_DESCRIPTION =
  "Use codex or claude for a native session, or paseo for a Codex/Claude-backed Paseo agent.";
const SESSION_REFERENCE_DESCRIPTION =
  "For codex/claude, use a canonical ID, unique ID prefix, or JSONL path. For paseo, use an agent UUID or unique prefix from `paseo ls --json`.";

const command = ({
  summary,
  usage,
  arguments: args = [],
  options = [],
  optionDetails = {},
  defaults = [],
  output = [],
  constraints = [],
  examples = [],
  agentNotes = [],
  security = [],
  environment = [],
}) => Object.freeze({
  summary,
  usage,
  arguments: Object.freeze(args),
  options: Object.freeze(options),
  optionDetails: Object.freeze(optionDetails),
  defaults: Object.freeze(defaults),
  output: Object.freeze(output),
  constraints: Object.freeze(constraints),
  examples: Object.freeze(examples),
  agentNotes: Object.freeze(agentNotes),
  security: Object.freeze(security),
  environment: Object.freeze(environment),
});

export const COMMAND_SPECS = Object.freeze({
  sessions: command({
    summary: "List local Codex or Claude sessions for later selection.",
    usage: "threadshare sessions <codex|claude> [options]",
    arguments: [argument("provider", "<codex|claude>", "Native session provider to inspect.")],
    options: ["format", "limit", "offset"],
    optionDetails: {
      format: "Use text (default) for people or json for agents.",
    },
    defaults: ["--format text", "--limit 10", "--offset 0", "Newest sessions first."],
    output: ["text: numbered summaries.", "json: one-line page object with full IDs and pagination."],
    constraints: ["Threadshare lists only native Codex and Claude sessions."],
    examples: [
      "threadshare sessions codex",
      "threadshare sessions claude --format json --limit 10 --offset 0",
    ],
    agentNotes: [
      "Do not assume the newest session is the requested one; compare ID, time, project, branch, and preview.",
      "This command does not list Paseo agents. Discover them with `paseo ls --json`.",
    ],
    security: ["Session previews are redacted and truncated; full transcript content is not listed."],
  }),
  analyze: command({
    summary: "Analyze one local Codex or Claude session without uploading it.",
    usage: "threadshare analyze <codex|claude> <session-id|file> [options]",
    arguments: [
      argument("provider", "<codex|claude>", "Native session provider to analyze."),
      argument(
        "session",
        "<session-id|file>",
        "Canonical ID, unique ID prefix, or JSONL path.",
      ),
    ],
    options: ["format"],
    optionDetails: {
      format: "Use text (default) for people or json for agents.",
    },
    defaults: ["--format text", "Rolled-back Turns are excluded from the text view."],
    output: [
      "text: Turn closure, final answers, and bounded Tool/Skill evidence.",
      "json: one-line threadshare-session-analysis@v1 report.",
    ],
    constraints: ["Threadshare analyzes only native Codex and Claude sessions."],
    examples: [
      "threadshare analyze codex <session-id>",
      "threadshare analyze claude <session-id> --format json",
    ],
    agentNotes: ["Use JSON when another agent will inspect or extend the analysis."],
    security: [
      "Analysis stays local and omits source paths, Tool arguments and output, Skill bodies, system prompts, and thinking.",
    ],
  }),
  insights: command({
    summary: "Query the local Session Insights index, open its dashboard, or maintain it.",
    usage: "threadshare insights [action] [target] [options]",
    arguments: [
      argument("action", "[action]", "Query action, maintenance action, or omit to open the Dashboard.", true),
      argument("operation", "[target|operation]", "Capability kind, Turn key, or exclusion operation.", true),
      argument("kind", "[provider|project|session]", "Required only for exclusion add or remove.", true),
      argument("value", "[value]", "Provider, project path, or session ID to exclude.", true),
    ],
    options: ["clear-intent", "cursor", "format", "intent", "limit", "query", "regenerate-secret", "repository", "request", "revision", "stdio", "verify"],
    optionDetails: {
      format: "Queries require json; maintenance uses text by default or json for agents.",
      limit: "Return 1 through 50 query items; Insights query actions default to 50.",
      "regenerate-secret": "Only for reindex. Requires an interactive typed confirmation and atomically replaces the complete index.",
      repository: "Only for sync. Registers this Git repository for repository-scoped Delivery Trace ingestion.",
      intent: "Only with sync --repository. Registers one repository-relative Markdown checklist as optional Intent evidence.",
      "clear-intent": "Only with sync --repository. Removes the optional Intent source while preserving repository Delivery Trace.",
      verify: "Only for status. Runs the slower full SQLite and FTS integrity check.",
    },
    defaults: ["--format text", "A normal reindex preserves the origin secret and stable keyed Facts."],
    output: [
      "no action: opens the authenticated local Dashboard and waits until stopped.",
      "status: fast content-free index state and storage footprint; --verify adds full integrity checks.",
      "spec: static natural-language intent routing for Agents; it does not open the index.",
      "overview/search/capabilities/usage/activity/evidence/query/recipe: one-line versioned JSON for agents.",
      "mcp --stdio: local JSON-RPC MCP server for Agent tools.",
      "sync/reindex/reset/exclude: bounded text or one-line JSON result.",
    ],
    constraints: [
      "Queries require --format json and never scan raw provider session files or trigger reindex.",
      "search requires exactly one of --query or --request; Usage, Activity, Query, and Recipe require --request.",
      "evidence accepts either a v2 --request or a v1 Turn key plus --revision.",
      "mcp requires --stdio and does not listen on a network port.",
      "exclude uses: exclude list, or exclude <add|remove> <provider|project|session> <value>.",
      "reset removes derived state and the origin secret but preserves the external config file.",
      "sync initializes a missing index or incrementally applies only changed local Sessions.",
      "--regenerate-secret fails closed without a TTY and the exact typed confirmation.",
    ],
    examples: [
      "threadshare insights",
      "threadshare insights spec --format json",
      "threadshare insights overview --format json",
      "threadshare insights search --query timeout --format json",
      "threadshare insights capabilities tool --limit 20 --format json",
      "threadshare insights evidence <turn-key> --revision <revision> --format json",
      "threadshare insights query --request query.json --format json",
      "threadshare insights evidence --request evidence.json --format json",
      "threadshare insights mcp --stdio",
      "threadshare insights status --format json",
      "threadshare insights sync --repository . --intent docs/intent.md",
      "threadshare insights sync --repository . --clear-intent",
      "threadshare insights reindex",
      "threadshare insights exclude add project /work/private",
      "threadshare insights exclude list",
      "threadshare insights reset",
    ],
    agentNotes: [
      "When the user asks an analysis question, read `threadshare insights spec --format json` and choose the protocol for them.",
      "Do not ask the user to name a Query resource, Recipe, filter field, or Evidence target.",
      "Use Search results and their revision to request bounded evidence; repeat Search after a stale cursor or changed Turn.",
      "Do not use --regenerate-secret as routine repair; it intentionally changes all keyed identities.",
    ],
    security: [
      "Status and diagnostics never print the local state path or origin secret.",
      "Exclusion values remain local and are never uploaded.",
    ],
    environment: [
      "THREADSHARE_INSIGHTS_HOME overrides derived state; THREADSHARE_CONFIG overrides persistent config.",
    ],
  }),
  memory: command({
    summary: "Build and promote a repository's shared Team Memory from local sessions.",
    usage: "threadshare memory <action> [path...] [options]",
    arguments: [
      argument(
        "action",
        "<init|status|lint|extract|review|promote|assemble|reverify-runner>",
        "Team Memory lifecycle action.",
      ),
      argument("path", "[path...]", "Only for lint: entry files to check; defaults to the entries directory.", true),
    ],
    options: [
      "approve-manifest",
      "approve-plan",
      "format",
      "limit",
      "plan",
      "provider",
      "repository",
      "request",
      "runner",
    ],
    optionDetails: {
      format: "Queries and maintenance use text by default or json for agents.",
      repository: "Resolve the owner repository from this worktree path instead of the current directory.",
      runner: "Only for extract and reverify-runner. The only Phase 1 value is claude.",
      "approve-plan": "Only for extract. Authorizes exactly one pending extraction or adjudication plan by digest (D1).",
      "approve-manifest": "Only for extract. Authorizes exactly the pending plans in one extraction or adjudication manifest (D1).",
      limit: "Only for extract. Number of pending chunks to plan or deliver; 1 through 50, default 1.",
      request: "Only for a new extract preview. A bounded Insights retrospective request; use - for stdin.",
      plan: "Only for promote. The promotion plan id produced by review.",
      provider: "Only for assemble. The provider context file to update; only claude is implemented.",
    },
    defaults: [
      "--format text",
      "Each extraction and adjudication stage prints a pending plan and delivers nothing until its own approval digest is supplied.",
    ],
    output: [
      "init: creates the .threadshare/memory skeleton and confirms the memory-state id.",
      "status: chunk/task/candidate/promotion counters for the owner repository.",
      "lint: per-file block/warn findings; a block exits non-zero.",
      "extract: without approval, pending extraction plans; after extraction, separate pending adjudication plans.",
      "review: confirms statements and prints a promotion plan; promote applies it into the worktree.",
      "assemble: regenerates the provider memory block; reverify-runner refreshes the conformance cache.",
    ],
    constraints: [
      "init, status, extract, review, promote, and assemble require a non-bare Git worktree (owner resolution).",
      "extract never spawns a runner without a matching --approve-plan or --approve-manifest digest.",
      "Approving extraction does not approve adjudication; authorize the next-stage digest in a separate invocation.",
      "extract accepts at most one of --approve-plan or --approve-manifest.",
      "--request creates a new preview and cannot be combined with an approval digest.",
      "promote writes only into the worktree; it never stages, commits, or pushes.",
      "A new extraction preview requires --request and searches only its explicit time window and filters.",
      "Threadshare adds the bound worktree scope and hard-sealed closure filter; it never defaults to all Insights.",
    ],
    examples: [
      "threadshare memory init",
      "threadshare memory status --format json",
      "threadshare memory lint",
      "threadshare memory extract --runner claude --request memory-filter.json",
      "threadshare memory extract --runner claude --approve-plan <extraction-digest>",
      "threadshare memory extract --runner claude --approve-plan <adjudication-digest>",
      "threadshare memory review",
      "threadshare memory promote --plan <plan-id>",
      "threadshare memory assemble --provider claude",
      "threadshare memory reverify-runner --runner claude",
    ],
    agentNotes: [
      "Extraction requests use threadshare-memory-extraction-request@v1 with a required canonical UTC window and optional query/providers/sessionKeys/toolCapabilityKeys/skillCapabilityKeys/resultEvidence/capabilityTerminalStates filters.",
      "Treat each pending plan digest as a one-stage authorization token; only re-run with it after the user approves that exact delivery summary.",
      "Extraction and adjudication are separate deliveries and require separate user approvals.",
      "Never place transcript bytes in a shared location; extraction delivery is local and authorized per run.",
    ],
    security: [
      "Sanitized promotion content is linted for secrets and provider session ids before it can enter the worktree.",
      "Local paths, the memory-state path, and the origin secret are never printed.",
    ],
    environment: [
      "THREADSHARE_INSIGHTS_HOME overrides derived state; THREADSHARE_MEMORY_RUNNER_BIN overrides the runner binary.",
    ],
  }),
  messages: command({
    summary: "List user-message IDs that can bound a partial export or share.",
    usage: "threadshare messages <codex|claude|paseo> <session-id|file|agent-id> --format json [options]",
    arguments: [
      argument("provider", "<codex|claude|paseo>", SESSION_PROVIDER_DESCRIPTION),
      argument("session", "<session-id|file|agent-id>", SESSION_REFERENCE_DESCRIPTION),
    ],
    options: ["before", "format", "limit", "offset"],
    optionDetails: {
      format: "Required. The only accepted value is json.",
    },
    defaults: ["--limit 10", "--offset 0", "Newest eligible user messages first."],
    output: ["One-line JSON with boundaryId, redacted previews, hasMore, and nextOffset."],
    constraints: [
      "--before is an excluded original boundary; keep it unchanged while loading older pages.",
      "--limit is 1..50 and --offset is a non-negative safe integer.",
    ],
    examples: [
      "threadshare messages codex <session-id> --format json",
      "threadshare messages paseo <agent-id> --format json --before <boundary-id> --offset 10",
    ],
    agentNotes: ["Show numbered previews to the user without exposing message IDs until a choice is made."],
    security: ["Output contains redacted previews, not a substitute for the complete transcript."],
  }),
  export: command({
    summary: "Export a native session as threadshare-history@v1 without uploading it.",
    usage: "threadshare export <codex|claude|paseo> <session-id|file|agent-id> [options]",
    arguments: [
      argument("provider", "<codex|claude|paseo>", SESSION_PROVIDER_DESCRIPTION),
      argument("session", "<session-id|file|agent-id>", SESSION_REFERENCE_DESCRIPTION),
    ],
    options: ["before", "from", "output"],
    defaults: ["Without --from and --before, export the full visible snapshot.", "Without --output, write JSON to stdout."],
    output: ["Pretty-printed canonical threadshare-history@v1 JSON."],
    constraints: [
      "--from includes its user turn; --before excludes its user turn.",
      "Both boundaries must identify visible user messages and produce a non-empty range.",
    ],
    examples: [
      "threadshare export codex <session-id> --output history.json",
      "threadshare export paseo <agent-id> --from <message-id> --before <boundary-id>",
    ],
    agentNotes: [
      "Agents must not use --from last-user; list messages and pass a fixed user-message ID instead.",
    ],
    security: ["Exports visible conversation content only; provider settings and raw system prompts are excluded."],
  }),
  publish: command({
    summary: "Validate and upload an existing threadshare-history@v1 document.",
    usage: "threadshare publish <history-file|-> [options]",
    arguments: [argument("input", "<history-file|->", "Canonical JSON file, or - for stdin.")],
    options: ["expires", "json", "revoke", "url"],
    defaults: ["Shares are permanent and non-revocable unless explicitly requested."],
    output: [
      "Success: Viewer URL, or one-line JSON with at least id and url when --json is used.",
      "When --revoke is confirmed, JSON includes the one-time revokeToken; human mode writes the one-time Revoke command to stderr.",
      "Failure: exit 1, empty stdout, and a diagnostic on stderr.",
    ],
    constraints: ["The input must be canonical JSON and no larger than the service's 5 MiB limit."],
    examples: [
      "threadshare validate history.json",
      "threadshare publish history.json --expires 7d --revoke --json",
    ],
    agentNotes: [
      "There is no publish dry run. First run `threadshare validate <history-file|->`.",
      "When --json and --help appear together, help wins: exit 0 with plain-text help, not JSON.",
    ],
    security: ["A revoke token is shown once. Never put it in a URL, transcript, log, or issue."],
    environment: [
      `Service precedence: --url, then THREADSHARE_URL, then ${DEFAULT_THREADSHARE_URL}.`,
    ],
  }),
  share: command({
    summary: "Export, optionally select, validate, and share one native conversation.",
    usage: "threadshare share <codex|claude|paseo> <session-id|file|agent-id> [options]",
    arguments: [
      argument("provider", "<codex|claude|paseo>", SESSION_PROVIDER_DESCRIPTION),
      argument("session", "<session-id|file|agent-id>", SESSION_REFERENCE_DESCRIPTION),
    ],
    options: [
      "before",
      "dry-run",
      "expires",
      "from",
      "json",
      "pick-start",
      "report",
      "revoke",
      "url",
    ],
    defaults: [
      "Without --from and --before, share the full visible snapshot.",
      "Shares are permanent and non-revocable unless explicitly requested.",
    ],
    output: [
      "Success: Viewer URL, or one-line JSON with at least id and url when --json is used.",
      "When --revoke is confirmed, JSON includes the one-time revokeToken; human mode writes the one-time Revoke command to stderr.",
      "An invalid dry run exits 1; with --json, stdout is one JSON object and stderr is empty.",
      "Every other failure exits 1 with empty stdout and a diagnostic on stderr.",
    ],
    constraints: [
      "--from includes its user turn; --before excludes its user turn.",
      "--pick-start requires a TTY and conflicts with --from and --before.",
      "--report requires --dry-run. A dry run never accesses the network.",
    ],
    examples: [
      "threadshare share codex <session-id> --dry-run --report --json",
      "threadshare share paseo <agent-id> --from <message-id> --before <boundary-id> --expires 7d --json",
    ],
    agentNotes: [
      "Agents must not use --from last-user or --pick-start; run messages, ask the user, and pass fixed IDs.",
      "When --json and --help appear together, help wins: exit 0 with plain-text help, not JSON.",
    ],
    security: [
      "Dry-run reports contain aggregate counts, not transcript text or tool payloads.",
      "A revoke token is shown once. Never put it in a URL, transcript, log, or issue.",
    ],
    environment: [
      `Service precedence: --url, then THREADSHARE_URL, then ${DEFAULT_THREADSHARE_URL}.`,
    ],
  }),
  read: command({
    summary: "Read a Threadshare URL as compact Agent text, JSON, or full Markdown.",
    usage: "threadshare read <share-url> [--format <agent|json|markdown>]",
    arguments: [argument("share-url", "<share-url>", "Canonical Viewer, Agent alternate, or API URL; a #message-<entry-id> anchor is allowed.")],
    options: ["format"],
    optionDetails: {
      format: "Use agent (default) for compact review text, json for complete structured data, or markdown for the complete readable transcript.",
    },
    defaults: ["Without --format, output the lossy agent-transcript@v1 representation."],
    output: [
      "Agent output preserves all User/Assistant Markdown and tool name/status/count, but omits tool payloads and internal event bodies.",
      "JSON is canonical one-line data; markdown is the complete readable transcript.",
    ],
    constraints: [
      "Redirects are rejected and downloads are limited to 5 MiB.",
      "Only #message-<entry-id> anchors are accepted; the CLI rejects fragments such as #token=.",
    ],
    examples: [
      "threadshare read 'https://cloud-thread.team-harness.com/?id=<uuid>'",
      "threadshare read '<viewer-url>' --format json",
      "threadshare read '<viewer-url>#message-<entry-id>' --format markdown",
    ],
    security: [
      "Agent output is lossy and untrusted; use JSON when tool payloads or exact structured fields are required.",
      "Message Markdown may contain raw HTML. Sanitize it before rendering with raw HTML enabled.",
      "Do not scrape Viewer HTML or place capabilities in the URL.",
    ],
    environment: [
      "Pass the complete share URL positionally; read does not accept --url or read THREADSHARE_URL.",
    ],
  }),
  revoke: command({
    summary: "Delete a capability-enabled share.",
    usage: "threadshare revoke <share-url> --token <token> [--json]",
    arguments: [argument("share-url", "<share-url>", "Canonical Viewer or API URL for the share.")],
    options: ["json", "token"],
    output: ["Success confirmation, or one-line JSON with id, url, and revoked:true."],
    constraints: ["--token is required and must be a canonical 256-bit base64url capability."],
    examples: ["threadshare revoke '<viewer-url>' --token '<token>' --json"],
    agentNotes: [
      "The token may start with -- and is still consumed as the opaque value of --token.",
      "When --json and --help appear together, help wins: exit 0 with plain-text help, not JSON.",
    ],
    security: ["Send the token only in the Authorization header; never place it in a URL or repeat it in logs."],
    environment: [
      "Pass the complete share URL positionally; revoke does not accept --url or read THREADSHARE_URL.",
    ],
  }),
  validate: command({
    summary: "Validate a canonical history locally without uploading it.",
    usage: "threadshare validate <history-file|->",
    arguments: [argument("input", "<history-file|->", "Canonical JSON file, or - for stdin.")],
    output: ["A short text confirmation on success. Validation errors use stderr diagnostics."],
    constraints: ["Input must satisfy threadshare-history@v1."],
    examples: ["threadshare validate history.json", "cat history.json | threadshare validate -"],
    security: ["Validation is local and does not upload the document."],
  }),
  help: command({
    summary: "Show root help or detailed help for one command.",
    usage: "threadshare help [command]",
    arguments: [argument("command", "[command]", "Known command name. Omit it for root help.", true)],
    options: ["help"],
    output: ["Deterministic plain text on stdout."],
    constraints: ["help accepts at most one command name and does not support --json."],
    examples: ["threadshare help", "threadshare help share", "threadshare share --help"],
    agentNotes: ["Use command help as the canonical parameter reference."],
  }),
});

export const BOOLEAN_OPTIONS = new Set(
  Object.entries(OPTION_DEFINITIONS)
    .filter(([, definition]) => definition.type === "boolean")
    .map(([name]) => name),
);

export const OPAQUE_VALUE_OPTIONS = new Set(
  Object.entries(OPTION_DEFINITIONS)
    .filter(([, definition]) => definition.type === "opaque")
    .map(([name]) => name),
);

export const DIAGNOSTIC_CODES = Object.freeze([
  "TS_USAGE_UNKNOWN_COMMAND",
  "TS_USAGE_MISSING_ARGUMENT",
  "TS_USAGE_UNEXPECTED_ARGUMENT",
  "TS_USAGE_UNKNOWN_OPTION",
  "TS_USAGE_OPTION_NOT_ALLOWED",
  "TS_USAGE_DUPLICATE_OPTION",
  "TS_USAGE_MISSING_VALUE",
  "TS_USAGE_INVALID_VALUE",
  "TS_USAGE_OPTION_DEPENDENCY",
  "TS_USAGE_OPTION_CONFLICT",
  "TS_SESSION_NOT_FOUND",
  "TS_SESSION_AMBIGUOUS",
  "TS_SESSION_ACCESS_FAILED",
  "TS_RANGE_INVALID",
  "TS_RANGE_BOUNDARY_NOT_FOUND",
  "TS_INPUT_READ_FAILED",
  "TS_INPUT_INVALID_JSON",
  "TS_INPUT_SCHEMA_INVALID",
  "TS_OUTPUT_WRITE_FAILED",
  "TS_TTY_REQUIRED",
  "TS_PROVIDER_UNAVAILABLE",
  "TS_SHARE_URL_INVALID",
  "TS_SHARE_READ_FAILED",
  "TS_SHARE_REVOKE_FAILED",
  "TS_PUBLISH_REJECTED",
  "TS_PUBLISH_OUTCOME_UNKNOWN",
  "TS_PUBLISH_POLICY_UNCONFIRMED",
  "TS_QUERY_TOO_LONG",
  "TS_QUERY_TOO_BROAD",
  "TS_INSIGHTS_REQUEST_INVALID",
  "TS_INSIGHTS_NOT_INDEXED",
  "TS_INSIGHTS_DELIVERY_TRACE_NOT_READY",
  "TS_INSIGHTS_REPOSITORY_INVALID",
  "TS_INSIGHTS_QUERY_V2_NOT_READY",
  "TS_INSIGHTS_CURSOR_STALE",
  "TS_INSIGHTS_TURN_CHANGED",
  "TS_INSIGHTS_PAYLOAD_CHANGED",
  "TS_INSIGHTS_EVIDENCE_NOT_FOUND",
  "TS_INSIGHTS_COVERAGE_INCOMPLETE",
  "TS_INSIGHTS_ENGINE_STATUS_SKIPPED",
  "TS_INSIGHTS_ENGINE_TIMEOUT",
  "TS_INSIGHTS_ENGINE_DISCONNECTED",
  "TS_INSIGHTS_ENGINE_UNAVAILABLE",
  "TS_INSIGHTS_WRITER_LOCKED",
  "TS_INSIGHTS_ENGINE_INVALID",
  "TS_INSIGHTS_STORAGE_FAILED",
  "TS_INSIGHTS_STORAGE_CORRUPT",
  "TS_INSIGHTS_WAL_BACKPRESSURE",
  "TS_INSIGHTS_ORIGIN_SECRET_MISSING",
  "TS_INSIGHTS_ORIGIN_SECRET_INVALID",
  "TS_INSIGHTS_EXCLUSION_APPLY_FAILED",
  "TS_INSIGHTS_REINDEX_SPACE_REQUIRED",
  "TS_INSIGHTS_PROJECTION_SPACE_REQUIRED",
  "TS_INSIGHTS_REINDEX_RECOVERY_REQUIRED",
  "TS_INSIGHTS_REINDEX_INCOMPLETE",
  "TS_INSIGHTS_PURGE_PENDING",
  "TS_OPERATION_FAILED",
]);

const DIAGNOSTIC_CODE_SET = new Set(DIAGNOSTIC_CODES);
const OPERATIONAL_COMMANDS = Object.keys(COMMAND_SPECS).filter((name) => name !== "help");

function appendSection(lines, title, values) {
  if (!values || values.length === 0) return;
  lines.push("", `${title}:`);
  for (const value of values) lines.push(`  ${value}`);
}

export function renderRootHelp() {
  const lines = [
    "Threadshare shares AI agent conversation threads through a hosted or self-hosted service.",
    "",
    "Usage:",
    "  threadshare <command> [options]",
    "  threadshare help <command>",
    "  threadshare --version",
    "",
    "Commands:",
  ];
  for (const name of OPERATIONAL_COMMANDS) {
    lines.push(`  ${name.padEnd(10)} ${COMMAND_SPECS[name].summary}`);
  }
  lines.push(`  ${"help".padEnd(10)} ${COMMAND_SPECS.help.summary}`);
  lines.push(
    "",
    "Range safety: omit --from and --before for the full visible snapshot; empty values are rejected.",
    `Default service: ${DEFAULT_THREADSHARE_URL}`,
    "Run `threadshare <command> --help` for every argument, option, default, constraint, and output.",
  );
  return lines.join("\n");
}

export function renderCommandHelp(name) {
  const spec = COMMAND_SPECS[name];
  if (!spec) return undefined;
  const lines = [spec.summary, "", "Usage:", `  ${spec.usage}`];
  if (spec.arguments.length > 0) {
    lines.push("", "Arguments:");
    for (const item of spec.arguments) {
      lines.push(`  ${item.placeholder}`, `      ${item.description}`);
    }
  }
  if (spec.options.length > 0) {
    lines.push("", "Options:");
    for (const optionName of spec.options) {
      const definition = OPTION_DEFINITIONS[optionName];
      const suffix = definition.placeholder ? ` ${definition.placeholder}` : "";
      lines.push(
        `  --${optionName}${suffix}`,
        `      ${spec.optionDetails[optionName] ?? definition.description}`,
      );
    }
  }
  appendSection(lines, "Defaults", spec.defaults);
  appendSection(lines, "Output", spec.output);
  appendSection(lines, "Constraints", spec.constraints);
  appendSection(lines, "Examples", spec.examples);
  appendSection(lines, "Agent notes", spec.agentNotes);
  appendSection(lines, "Security", spec.security);
  appendSection(lines, "Environment", spec.environment);
  return lines.join("\n");
}

const INSIGHTS_ACTION_HELP = Object.freeze({
  spec: [
    "Return the static Agent routing spec for natural-language Insights questions.",
    "",
    "Usage:",
    "  threadshare insights spec --format json",
    "",
    "Output:",
    "  One-line threadshare-insights-agent-spec@v1 JSON.",
    "  Maps user questions to bounded action plans, required inputs, optional filters, and answer rules.",
    "",
    "Behavior:",
    "  Does not open the index, start the Engine, run sync, or read local Session data.",
    "",
    "Agent notes:",
    "  Users describe the analysis they need in natural language; the Agent chooses the protocol, actions, and Recipe names.",
    "  Use action-specific help and the published JSON Schemas after selecting an intent.",
  ],
  status: [
    "Inspect local Insights state without scanning the full database.",
    "",
    "Usage:",
    "  threadshare insights status [--verify] [--format text|json]",
    "",
    "Behavior:",
    "  The default reads only state metadata and does not start the Engine.",
    "  --verify explicitly runs SQLite quick_check and both FTS integrity checks; large indexes can take minutes.",
  ],
  sync: [
    "Incrementally index local provider Sessions into the committed Insights snapshot.",
    "",
    "Usage:",
    "  threadshare insights sync [--repository <path> [--intent <repository-relative-markdown-file> | --clear-intent]] [--format text|json]",
    "",
    "Behavior:",
    "  Creates the index when it is missing; otherwise processes only new, changed, deleted, or excluded Sessions.",
    "  --repository registers and syncs one Git repository. Without it, only previously registered repositories are scanned.",
    "  --intent attaches one explicit Markdown checklist to that repository; no other files are discovered.",
    "  --clear-intent removes that optional checklist registration and its derived Requirement evidence.",
    "  First sync never scans $HOME, ~/work, or historical Session working directories.",
    "  Progress is written to stderr in an interactive terminal. stdout remains the result channel.",
    "",
    "Agent notes:",
    "  Run sync before the first query or when status reports stale or missing data.",
    "  Queries never trigger sync implicitly. Use reindex only for a complete atomic rebuild or secret recovery.",
  ],
  query: [
    "Run a bounded typed records or aggregate query over the local Insights event store.",
    "",
    "Usage:",
    "  threadshare insights query --request <file|-> --format json",
    "",
    "Request:",
    "  JSON format: threadshare-insights-query-request@v2",
    "  resources: session, turn, event, capability-use, file-activity, token-usage, error-occurrence, delivery-edge",
    "  shape.kind: records (select fields, optional payloadMode omit|reference|inline) or aggregate (groupBy + metrics)",
    "  where: typed and/or/not predicates; orderBy: stable field/direction list; limit: 1..50",
    "  Use schema/threadshare-insights-query-request.v2.schema.json for the complete field registry and operators.",
    "",
    "Minimal request:",
    "  {\"format\":\"threadshare-insights-query-request@v2\",\"resource\":\"event\",\"where\":null,\"shape\":{\"kind\":\"records\",\"select\":[\"eventKey\",\"observedAt\"],\"payloadMode\":\"reference\"},\"orderBy\":[{\"field\":\"observedAt\",\"direction\":\"desc\"},{\"field\":\"eventKey\",\"direction\":\"asc\"}],\"limit\":20}",
    "",
    "Agent notes:",
    "  Run `threadshare insights sync` first. Query reads one committed snapshot and never scans raw provider files.",
    "  Save nextCursor and reuse it unchanged for the next page; payload content may require evidence paging.",
  ],
  recipe: [
    "Run a versioned, evidence-bearing analysis over a bounded local time window.",
    "",
    "Usage:",
    "  threadshare insights recipe <name> --request <file|-> --format json",
    "",
    "Recipe names:",
    "  capability-contexts@1  failure-chains@1  file-workflow-signals@1",
    "  activity-shifts@1      token-hotspots@1   solution-recall@1",
    "  session-timeline@1  delivery-trace@1",
    "",
    "Request:",
    "  JSON format: threadshare-insights-recipe-request@v1",
    "  required window: {after,before} as canonical UTC timestamps with milliseconds",
    "  optional comparisonWindow, filters, limit (1..50), allowDegraded (default false)",
    "  Use schema/threadshare-insights-recipe-request.v1.schema.json for filter bounds.",
    "",
    "Minimal request:",
    "  {\"format\":\"threadshare-insights-recipe-request@v1\",\"window\":{\"after\":\"2026-01-01T00:00:00.000Z\",\"before\":\"2026-02-01T00:00:00.000Z\"},\"limit\":20,\"allowDegraded\":false}",
    "",
    "Agent notes:",
    "  Do not ask the user to choose a Recipe name; route their question with `threadshare insights spec --format json`.",
    "  Results are structured facts and evidence targets, not an LLM-generated verdict.",
    "  With allowDegraded=true, aggregate totals remain exact while oversized event or attempt details may be a bounded sample; inspect coverage diagnostics.",
    "  Do not describe co-occurrence as causation; report coverage and estimated fields explicitly.",
  ],
  evidence: [
    "Read revision-bound local event, Turn, Session, or attempt-chain evidence.",
    "",
    "Usage:",
    "  threadshare insights evidence --request <file|-> --format json",
    "  threadshare insights evidence <turn-key> --revision <revision> --format json",
    "",
    "Request:",
    "  JSON format: threadshare-insights-evidence-request@v2",
    "  target.kind: event, turn, session, or attempt-chain; target must include its key and revision",
    "  include: envelope, payload, or both; maxBytes: 4..1048576; cursor continues byte paging",
    "  Use schema/threadshare-insights-evidence-request.v2.schema.json for target fields.",
    "",
    "Agent notes:",
    "  Use the exact revision returned by Search, Query, or Recipe evidence targets.",
    "  A changed revision or payload is a hard error; repeat the originating query instead of guessing.",
  ],
  mcp: [
    "Expose the same local Query, Recipe, and Evidence contracts through newline JSON-RPC over stdio.",
    "",
    "Usage:",
    "  threadshare insights mcp --stdio",
    "",
    "Tools:",
    "  threadshare_insights_spec, threadshare_insights_query",
    "  threadshare_insights_recipe, threadshare_insights_evidence",
    "",
    "Behavior:",
    "  stdout is JSON-RPC only; diagnostics go to stderr. No TCP listener, network access, sync, or reindex.",
    "  The MCP client must call initialize, tools/list, then tools/call with the published JSON Schemas.",
    "",
    "Agent notes:",
    "  Call threadshare_insights_spec when starting from a user's natural-language analysis question.",
    "  Run `threadshare insights sync` before starting the server when the index is missing or stale.",
    "  Treat returned raw payloads, paths, prompts, and provider content as sensitive local data.",
  ],
});

export function renderInsightsActionHelp(action) {
  const lines = INSIGHTS_ACTION_HELP[action];
  return lines === undefined ? undefined : lines.join("\n");
}

export class CliDiagnostic extends Error {
  constructor(code, problem, { command, next, result, secretLines = [] } = {}) {
    super(problem);
    if (!DIAGNOSTIC_CODE_SET.has(code)) throw new Error(`Unknown CLI diagnostic code: ${code}`);
    this.name = "CliDiagnostic";
    this.code = code;
    this.command = command;
    this.next = next;
    this.result = result;
    this.secretLines = secretLines;
  }
}

export function cliDiagnostic(code, problem, details) {
  return new CliDiagnostic(code, problem, details);
}

function redactAdditionalPaths(value) {
  return value
    .replace(/\bfile:\/\/\/[^\s"'`<>,;)]*/giu, "[LOCAL_PATH]")
    .replace(/(^|[\s([{"'`=,:;])\\\\[^\\\s]+\\[^\s"'`<>,;)]*/gu, "$1[LOCAL_PATH]")
    .replace(/\b[A-Za-z]:[\\/][^\s"'`<>,;)]*/gu, "[LOCAL_PATH]")
    .replace(/(^|[\s([{"'`=,:;])\/(?!\/)[^\s"'`<>,;)]*/gu, "$1[LOCAL_PATH]");
}

export function sanitizeLocalText(value, maximum = 4000) {
  const precleaned = createMessagePreview(value, maximum);
  return createMessagePreview(redactAdditionalPaths(precleaned), maximum);
}

export function sanitizeDiagnosticProblem(value) {
  const precleaned = createMessagePreview(value, 4000);
  return createMessagePreview(redactAdditionalPaths(precleaned), 400);
}

export function commandUsage(name) {
  return COMMAND_SPECS[name]?.usage ?? "threadshare <command> [options]";
}

export function renderDiagnostic(error) {
  const diagnostic = error instanceof CliDiagnostic
    ? error
    : new CliDiagnostic("TS_OPERATION_FAILED", error instanceof Error ? error.message : String(error), {
      next: "Run `threadshare --help` and retry only after checking the requested operation.",
    });
  const lines = [
    `threadshare: error ${diagnostic.code}`,
    `Problem: ${sanitizeDiagnosticProblem(diagnostic.message)}`,
  ];
  if (diagnostic.result) lines.push(`Result: ${diagnostic.result}`);
  lines.push(
    `Usage: ${commandUsage(diagnostic.command)}`,
    `Next: ${diagnostic.next ?? `Run \`threadshare ${diagnostic.command ?? ""} --help\` for details.`}`,
  );
  lines.push(...diagnostic.secretLines);
  return `${lines.join("\n")}\n`;
}

function unknownCommand(name) {
  return cliDiagnostic("TS_USAGE_UNKNOWN_COMMAND", `Unknown command: ${name}.`, {
    next: `Choose one of: ${OPERATIONAL_COMMANDS.join(", ")}. Run \`threadshare --help\`.`,
  });
}

export function preflightHelp(args) {
  if (args.length === 0 || args[0] === "--help") return renderRootHelp();
  const [first, second, ...rest] = args;
  if (first === "help") {
    if (second === undefined) return renderRootHelp();
    if (second === "--help" || second === "help") {
      if (rest.length > 0) {
        throw cliDiagnostic("TS_USAGE_UNEXPECTED_ARGUMENT", `Unexpected argument for help: ${rest[0]}.`, {
          command: "help",
          next: "Run `threadshare help --help`.",
        });
      }
      return renderCommandHelp("help");
    }
    if (second.startsWith("--")) {
      const name = second.slice(2);
      const known = Object.hasOwn(OPTION_DEFINITIONS, name);
      throw cliDiagnostic(
        known ? "TS_USAGE_OPTION_NOT_ALLOWED" : "TS_USAGE_UNKNOWN_OPTION",
        known ? `${second} is not valid for help.` : `Unknown option: ${second}.`,
        { command: "help", next: "Run `threadshare help --help`." },
      );
    }
    if (second === "insights" && rest.length === 1 && INSIGHTS_ACTION_HELP[rest[0]] !== undefined) {
      return renderInsightsActionHelp(rest[0]);
    }
    if (!Object.hasOwn(COMMAND_SPECS, second)) throw unknownCommand(second);
    if (rest.length > 0) {
      throw cliDiagnostic("TS_USAGE_UNEXPECTED_ARGUMENT", `Unexpected argument for help: ${rest[0]}.`, {
        command: "help",
        next: `Run \`threadshare help ${second}\` without extra arguments.`,
      });
    }
    return renderCommandHelp(second);
  }
  if (first === "insights" && INSIGHTS_ACTION_HELP[second] !== undefined && args.includes("--help")) {
    return renderInsightsActionHelp(second);
  }
  if (Object.hasOwn(COMMAND_SPECS, first) && first !== "help" && args.includes("--help")) {
    return renderCommandHelp(first);
  }
  if (!first.startsWith("--") && !Object.hasOwn(COMMAND_SPECS, first) && args.includes("--help")) {
    throw unknownCommand(first);
  }
  return null;
}

function optionNotAllowedNext(commandName, optionName) {
  if (optionName === "json" && ["sessions", "analyze", "insights", "memory", "messages", "read"].includes(commandName)) {
    return `Use --format json instead. Run \`threadshare ${commandName} --help\`.`;
  }
  if (optionName === "format" && ["publish", "share", "revoke"].includes(commandName)) {
    return `Use --json instead. Run \`threadshare ${commandName} --help\`.`;
  }
  return `Remove --${optionName}, or run \`threadshare ${commandName} --help\` for valid options.`;
}

export function validateCommandInvocation(commandName, positionals, options) {
  const spec = COMMAND_SPECS[commandName];
  if (!spec || commandName === "help") throw unknownCommand(commandName);
  const required = spec.arguments.filter((item) => !item.optional).length;
  const supplied = Math.max(0, positionals.length - 1);
  if (supplied < required) {
    const missing = spec.arguments[supplied];
    throw cliDiagnostic("TS_USAGE_MISSING_ARGUMENT", `Missing required argument ${missing.placeholder}.`, {
      command: commandName,
      next: `Provide ${missing.placeholder}. Run \`threadshare ${commandName} --help\`.`,
    });
  }
  if (supplied > spec.arguments.length) {
    throw cliDiagnostic(
      "TS_USAGE_UNEXPECTED_ARGUMENT",
      `Unexpected positional argument: ${positionals[spec.arguments.length + 1]}.`,
      {
        command: commandName,
        next: `Remove the extra argument. Run \`threadshare ${commandName} --help\`.`,
      },
    );
  }
  for (const optionName of Object.keys(options)) {
    if (!spec.options.includes(optionName)) {
      throw cliDiagnostic(
        "TS_USAGE_OPTION_NOT_ALLOWED",
        `--${optionName} is not valid for ${commandName}.`,
        { command: commandName, next: optionNotAllowedNext(commandName, optionName) },
      );
    }
  }
  return spec;
}
