import { createHash } from "node:crypto";
import { stat } from "node:fs/promises";
import path from "node:path";
import {
  canonicalJson,
  hashKey,
  toWellFormedUnicode,
  validateSessionFactsDelta,
  validateSessionFactsDeltaV2,
} from "./session-facts.mjs";
import { visibleUserMarkdown, redactSecrets } from "./session-export.mjs";
import {
  SESSION_UUID_IN_TEXT_PATTERN,
  canonicalSessionId,
  discoverSessionFiles,
  sessionIdsInFileName,
} from "./session-files.mjs";
import {
  streamSessionRecords,
  verifySessionRecordCheckpoint,
  visitSessionRecords,
} from "./session-record-reader.mjs";

const FACT_SCHEMA_VERSION = 1;
const FACT_SCHEMA_VERSION_V2 = 2;
const PRIVACY_POLICY_VERSION = 1;
const PRIVACY_POLICY_VERSION_V2 = 2;
const DUPLICATE_POLICY_VERSION = 1;
const IDENTITY_VERSION = 1;
const MAX_PROBLEM_BYTES = 64 * 1024;
const MAX_EXCERPT_BYTES = 8 * 1024;
const MAX_DIAGNOSTICS = 128;
const MAX_TURN_EVENTS = 4_096;
const MAX_TURN_USES = 2_048;
const MAX_TURN_LINKS = 8_192;
const MAX_SESSION_EVENTS = 4_096;
const MAX_SESSION_CATALOG_EVENTS = 2_048;
const MAX_COVERAGE_KEYS = 256;
const MAX_CAPABILITY_NAME_BYTES = 512;
const MAX_CLAUDE_UUIDS = 4_096;
const MAX_METADATA_RECORDS = 256;
const MAX_PROVIDER_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_CONTENT_ITEMS = 4_096;
const MAX_TOOL_SUBTREE_BYTES = 1024 * 1024;
const HISTORY_PAYLOAD_CHUNK_BYTES = 64 * 1024;
const FACT_CAP_SLACK = Object.freeze({
  events: 512,
  uses: 256,
  links: 1_024,
  sessionEvents: 512,
  catalogEvents: 256,
});

export const PROVIDER_RECORD_AUTHORITY_V1 = Object.freeze({
  version: 1,
  codex: Object.freeze({
    userBoundary: Object.freeze({ authority: "response_item", twin: "event_msg:user_message" }),
    assistantMessage: Object.freeze({ authority: "response_item", twin: "event_msg:agent_message" }),
    toolInvocation: Object.freeze({ authority: "response_item", ignoredNamespace: "event_msg" }),
    toolResult: Object.freeze({ authority: "response_item", ignoredNamespace: "event_msg" }),
    lifecycle: Object.freeze({ authority: "event_msg", startedBelongsToNextUser: true }),
    inlineSubagent: Object.freeze({
      authority: Object.freeze([
        "inter_agent_communication_metadata",
        "response_item:agent_message",
        "event_msg:sub_agent_activity",
      ]),
      retainsIdentity: false,
    }),
    inferredSkillLoad: "session-catalog-before-complete-read",
  }),
  claude: Object.freeze({
    userBoundary: Object.freeze({ authority: "user", excludesToolResultOnly: true }),
    assistantMessage: Object.freeze({ authority: "assistant" }),
    toolInvocation: Object.freeze({ authority: "assistant:tool_use" }),
    toolResult: Object.freeze({ authority: "user:tool_result" }),
    inferredSkillLoad: "unsupported-without-session-catalog",
  }),
});

function assertProvider(provider) {
  if (provider !== "codex" && provider !== "claude") {
    throw new TypeError("provider must be codex or claude");
  }
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function canonicalMutationDigest(value) {
  const hash = createHash("sha256");
  const keys = Object.keys(value)
    .filter((key) => key !== "deltaId")
    .sort();
  hash.update("{");
  for (let index = 0; index < keys.length; index += 1) {
    if (index > 0) hash.update(",");
    const key = keys[index];
    hash.update(canonicalJson(key));
    hash.update(":");
    const field = value[key];
    if (!Array.isArray(field)) {
      hash.update(canonicalJson(field));
      continue;
    }
    hash.update("[");
    for (let itemIndex = 0; itemIndex < field.length; itemIndex += 1) {
      if (itemIndex > 0) hash.update(",");
      hash.update(canonicalJson(field[itemIndex]));
    }
    hash.update("]");
  }
  hash.update("}");
  return hash.digest();
}

function hexBytes(value) {
  return Buffer.from(value, "hex");
}

function uint64(value) {
  const buffer = Buffer.alloc(8);
  buffer.writeBigUInt64BE(BigInt(value));
  return buffer;
}

function int32(value) {
  const buffer = Buffer.alloc(4);
  buffer.writeInt32BE(value);
  return buffer;
}

function uint16(value) {
  const buffer = Buffer.alloc(2);
  buffer.writeUInt16BE(value);
  return buffer;
}

function normalizeName(value, fallback = "unknown") {
  if (typeof value !== "string") return fallback;
  const name = toWellFormedUnicode(value).normalize("NFC").trim();
  return name ? Array.from(name).slice(0, 512).join("") : fallback;
}

function canonicalCapabilityName(value) {
  if (typeof value !== "string") return null;
  const name = toWellFormedUnicode(value).normalize("NFC");
  return name.length > 0 && Buffer.byteLength(name) <= MAX_CAPABILITY_NAME_BYTES ? name : null;
}

function sanitizeUnicodeValues(value, seen = new Set()) {
  if (typeof value === "string") {
    const sanitized = toWellFormedUnicode(value);
    return { value: sanitized, replacements: sanitized === value ? 0 : 1 };
  }
  if (value === null || typeof value !== "object" || Buffer.isBuffer(value)) {
    return { value, replacements: 0 };
  }
  if (seen.has(value)) return { value, replacements: 0 };
  seen.add(value);
  let replacements = 0;
  for (const key of Object.keys(value)) {
    const sanitized = sanitizeUnicodeValues(value[key], seen);
    value[key] = sanitized.value;
    replacements += sanitized.replacements;
  }
  return { value, replacements };
}

function timestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function rawPartText(part) {
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return part.text;
  if (typeof part.output_text === "string") return part.output_text;
  if (typeof part.input_text === "string") return part.input_text;
  return "";
}

function rawContentText(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content.map(rawPartText).filter(Boolean).join("\n\n");
}

function visibleAssistantText(content) {
  return redactSecrets(rawContentText(content));
}

function truncateUtf8(value, headBytes, tailBytes = 0) {
  const normalized = toWellFormedUnicode(value);
  const buffer = Buffer.from(normalized, "utf8");
  if (buffer.length <= headBytes + tailBytes) return normalized;
  let headEnd = headBytes;
  while (headEnd > 0 && (buffer[headEnd] & 0xc0) === 0x80) headEnd -= 1;
  const head = buffer.subarray(0, headEnd).toString("utf8");
  if (tailBytes === 0) return head;
  let tailStart = buffer.length - tailBytes;
  while (tailStart < buffer.length && (buffer[tailStart] & 0xc0) === 0x80) tailStart += 1;
  const tail = buffer.subarray(tailStart).toString("utf8");
  return `${head}${tail}`;
}

function boundedProblem(value) {
  return truncateUtf8(value, 48 * 1024, 16 * 1024);
}

function boundedExcerpt(value) {
  return truncateUtf8(value, 6 * 1024, 2 * 1024);
}

function normalizedTextDigest(value) {
  return sha256(Buffer.from(toWellFormedUnicode(value).normalize("NFC").replace(/\r\n?/gu, "\n")));
}

function outputByteLength(value) {
  if (typeof value === "string") return String(Buffer.byteLength(value));
  try {
    return String(Buffer.byteLength(canonicalJson(value)));
  } catch {
    return String(Buffer.byteLength(JSON.stringify(value) ?? ""));
  }
}

const FULL_GIT_OBJECT_ID_PATTERN = /(?<![0-9a-f])([0-9a-f]{40})(?![0-9a-f])/giu;

function toolCommandText(input) {
  const value = parseJsonInput(input);
  if (typeof value === "string") return value;
  if (!value || typeof value !== "object" || Array.isArray(value)) return "";
  for (const field of ["cmd", "command", "script", "input"]) {
    if (typeof value[field] === "string") return value[field];
    if (Array.isArray(value[field]) && value[field].every((item) => typeof item === "string")) {
      return value[field].join(" ");
    }
  }
  return "";
}

function observedGitCommitObjectIds(name, input, output, state) {
  if (state !== "completed" || !/(?:bash|exec_command|shell|terminal|powershell)/iu.test(name)) {
    return [];
  }
  const command = toolCommandText(input);
  if (!/(?:^|[;&|\s])git\s+(?:commit|rev-parse|show|log)\b/iu.test(command)) return [];
  const text = typeof output === "string"
    ? output
    : (() => {
        try {
          return canonicalJson(output);
        } catch {
          return "";
        }
      })();
  return [...new Set([...text.matchAll(FULL_GIT_OBJECT_ID_PATTERN)]
    .map((match) => match[1].toLowerCase()))].slice(0, 16);
}

function semanticPayload(value, { parseJsonString = false } = {}) {
  if (value === undefined) return null;
  if (typeof value === "string") {
    if (parseJsonString) {
      try {
        return { content: canonicalJson(JSON.parse(value)), encoding: "canonical-json" };
      } catch {
        // Provider inputs that are not JSON remain exact UTF-8 text.
      }
    }
    return { content: value, encoding: "utf-8" };
  }
  try {
    return { content: canonicalJson(value), encoding: "canonical-json" };
  } catch (error) {
    if (!(error instanceof TypeError) || error.message !== "canonical JSON only permits integers") {
      throw error;
    }
    return { content: JSON.stringify(value), encoding: "utf-8" };
  }
}

function chunkUtf8(value, maxBytes = HISTORY_PAYLOAD_CHUNK_BYTES) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length === 0) return [""];
  const chunks = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + maxBytes, bytes.length);
    while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
    if (end === offset) throw new TypeError("history payload chunk boundary is invalid");
    chunks.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  return chunks;
}

function historyMetadata(fields) {
  const { kind: _kind, ...metadata } = fields;
  return Object.fromEntries(Object.entries(metadata).filter(([, value]) => value !== undefined));
}

function validDecimal(value) {
  if (typeof value === "bigint") return value >= 0n ? String(value) : null;
  return Number.isSafeInteger(value) && value >= 0 ? String(value) : null;
}

function eventState(payload) {
  if (payload?.error != null || payload?.is_error === true || payload?.status === "failed") {
    return "failed";
  }
  const exitCode = validDecimal(payload?.exit_code ?? payload?.exitCode);
  if (exitCode !== null) return exitCode === "0" ? "completed" : "failed";
  if (payload?.status === "completed" || payload?.status === "success" || payload?.is_error === false) {
    return "completed";
  }
  return "unknown";
}

function normalizedObservedPath(value) {
  if (typeof value !== "string" || value.length === 0) return null;
  const normalized = toWellFormedUnicode(value).normalize("NFC");
  const portable = /^[A-Za-z]:[\\/]/u.test(normalized) || normalized.startsWith("\\\\")
    ? normalized.replaceAll("\\", "/")
    : normalized;
  return path.posix.normalize(portable);
}

function observedPathDetails(rawPath, projectRoot, pathRole = "target") {
  const normalizedPath = normalizedObservedPath(rawPath);
  if (normalizedPath === null) return null;
  const root = normalizedObservedPath(projectRoot);
  const absolute = path.posix.isAbsolute(normalizedPath) || /^[A-Za-z]:\//u.test(normalizedPath) ||
    normalizedPath.startsWith("//");
  let relativePath = absolute ? null : normalizedPath;
  let projectRelative = !absolute && root !== null;
  if (absolute && root !== null) {
    const relative = path.posix.relative(root, normalizedPath);
    if (relative === "" || (relative !== ".." && !relative.startsWith("../") && !path.posix.isAbsolute(relative))) {
      relativePath = relative || ".";
      projectRelative = true;
    }
  }
  return {
    pathRole,
    rawPath: toWellFormedUnicode(rawPath).normalize("NFC"),
    normalizedPath,
    relativePath,
    absolute,
    projectRelative,
  };
}

function patchPaths(value) {
  if (typeof value !== "string") return [];
  const paths = [];
  for (const match of value.matchAll(/^\*\*\* (?:Add|Update|Delete) File: (.+)$/gmu)) {
    paths.push({ value: match[1], role: "target" });
  }
  for (const match of value.matchAll(/^\*\*\* Move to: (.+)$/gmu)) {
    paths.push({ value: match[1], role: "destination" });
  }
  return paths;
}

function toolFileActivities(provider, name, input, projectRoot) {
  const parsed = parseJsonInput(input);
  const object = parsed && typeof parsed === "object" && !Array.isArray(parsed) ? parsed : null;
  const canonicalName = name.toLowerCase();
  const action = new Map([
    ["read", "read"], ["write", "write"], ["edit", "edit"], ["multiedit", "edit"],
    ["notebookedit", "edit"], ["apply_patch", "edit"], ["delete", "delete"],
    ["move", "move"], ["rename", "move"], ["grep", "search"], ["search", "search"],
    ["glob", "search"], ["ls", "list"], ["list", "list"],
  ]).get(canonicalName);
  if (!action) return [];

  const candidates = [];
  if (canonicalName === "apply_patch") {
    candidates.push(...patchPaths(typeof parsed === "string" ? parsed : object?.patch));
  } else if (object) {
    for (const field of ["file_path", "path", "notebook_path"]) {
      if (typeof object[field] === "string") candidates.push({ value: object[field], role: "target" });
    }
    for (const field of ["source", "source_path", "from"]) {
      if (typeof object[field] === "string") candidates.push({ value: object[field], role: "source" });
    }
    for (const field of ["destination", "destination_path", "to"]) {
      if (typeof object[field] === "string") candidates.push({ value: object[field], role: "destination" });
    }
  }
  const seen = new Set();
  return candidates.flatMap(({ value, role }) => {
    const details = observedPathDetails(value, projectRoot, role);
    if (!details) return [];
    const identity = `${role}\0${details.rawPath}`;
    if (seen.has(identity)) return [];
    seen.add(identity);
    return [{ action, phase: "attempted", ...details }];
  });
}

function resultFileActivities(activities, state) {
  const phase = state === "completed" ? "confirmed" : state === "failed" ? "failed" : "unknown";
  return activities.map((activity) => ({ ...activity, phase }));
}

function errorSignature(value) {
  const semantic = semanticPayload(value, { parseJsonString: true });
  if (semantic === null) return null;
  const normalized = semantic.content
    .normalize("NFC")
    .toLowerCase()
    .replace(/[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}/gu, "<uuid>")
    .replace(/\b0x[0-9a-f]+\b/gu, "<hex>")
    .replace(/(?:[A-Za-z]:[\\/]|\/)(?:[^\s:'"`]+[\\/])*[^\s:'"`]*/gu, "<path>")
    .replace(/\b[0-9]+\b/gu, "<number>")
    .replace(/\s+/gu, " ")
    .trim();
  return sha256(Buffer.from(normalized, "utf8"));
}

function tokenMetadata(fields) {
  const entries = Object.entries(fields).filter(([, value]) => value !== null);
  return entries.length > 1 ? Object.fromEntries(entries) : null;
}

function codexTokenMetadata(payload) {
  const usage = payload?.info?.last_token_usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  return tokenMetadata({
    usageScope: "delta",
    inputTokens: validDecimal(usage.input_tokens),
    cachedInputTokens: validDecimal(usage.cached_input_tokens),
    outputTokens: validDecimal(usage.output_tokens),
    reasoningTokens: validDecimal(usage.reasoning_output_tokens),
    totalTokens: validDecimal(usage.total_tokens),
  });
}

function claudeTokenMetadata(message) {
  const usage = message?.usage;
  if (!usage || typeof usage !== "object" || Array.isArray(usage)) return null;
  return tokenMetadata({
    usageScope: "delta",
    model: typeof message.model === "string" && message.model ? normalizeName(message.model) : null,
    inputTokens: validDecimal(usage.input_tokens),
    cachedInputTokens: validDecimal(usage.cache_read_input_tokens),
    cacheWriteInputTokens: validDecimal(usage.cache_creation_input_tokens),
    outputTokens: validDecimal(usage.output_tokens),
  });
}

function sessionIdFromFile(file) {
  return path.basename(file).match(SESSION_UUID_IN_TEXT_PATTERN)?.[0]?.toLowerCase() ?? null;
}

function aggregateDiagnostics(items) {
  const aggregated = new Map();
  for (const item of items) {
    const code = normalizeName(item.code, "unknown-record");
    const current = aggregated.get(code);
    const amount = Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 1;
    if (current) {
      current.count += amount;
      continue;
    }
    if (aggregated.size >= MAX_DIAGNOSTICS) continue;
    aggregated.set(code, {
      code,
      count: amount,
      ...(item.startOffset !== undefined ? { firstOffset: String(item.startOffset) } : {}),
      ...(typeof item.recordDigest === "string" ? { digest: item.recordDigest } : {}),
    });
  }
  return [...aggregated.values()];
}

function contentItems(content) {
  return Array.isArray(content) ? content : [{ type: "text", text: content }];
}

function admittedContentEntries(builder, content, priority = () => false) {
  const items = contentItems(content);
  if (items.length <= MAX_CONTENT_ITEMS) {
    return { entries: items.map((item, index) => [index, item]), truncated: false };
  }
  builder.cover("record-content-items-truncated", items.length - MAX_CONTENT_ITEMS);
  builder.diagnose("record-content-items-truncated");
  const retained = new Set();
  for (let index = 0; index < 3_072; index += 1) retained.add(index);
  for (let index = Math.max(0, items.length - 1_024); index < items.length; index += 1) retained.add(index);
  for (let index = 0; index < items.length; index += 1) {
    if (priority(items[index], index)) retained.add(index);
  }
  if (retained.size > MAX_CONTENT_ITEMS) {
    const priorityIndices = [...retained].filter((index) => priority(items[index], index));
    const ordered = [...retained].sort((left, right) => left - right);
    retained.clear();
    for (const index of priorityIndices) retained.add(index);
    for (const index of ordered) {
      if (retained.size >= MAX_CONTENT_ITEMS) break;
      retained.add(index);
    }
  }
  return {
    entries: [...retained].sort((left, right) => left - right).map((index) => [index, items[index]]),
    truncated: true,
  };
}

function admittedToolInput(builder, input, record) {
  if (input === undefined) return undefined;
  if (typeof input === "string") {
    try {
      const decoded = JSON.parse(input);
      const unicode = sanitizeUnicodeValues(decoded);
      if (unicode.replacements > 0) {
        builder.cover("invalid-unicode-replaced", unicode.replacements);
        builder.diagnose("invalid-unicode-replaced", record);
      }
    } catch {
      // Invalid JSON is fingerprinted as raw UTF-8 by the privacy context.
    }
  }
  let bytes;
  try {
    bytes = Buffer.byteLength(JSON.stringify(input) ?? "");
  } catch {
    builder.diagnose("invalid-tool-input", record);
    return undefined;
  }
  if (bytes <= MAX_TOOL_SUBTREE_BYTES) return input;
  builder.cover("tool-input-truncated");
  builder.diagnose("oversized-tool-input", record);
  return undefined;
}

function parseJsonInput(value) {
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

function structuredSkill(value) {
  const match = /^\s*<skill>\s*<name>([^<]+)<\/name>(?:\s*<path>([^<]+)<\/path>)?/u.exec(value);
  if (!match) return null;
  return {
    name: normalizeName(match[1]),
    path: match[2] ? toWellFormedUnicode(match[2]).normalize("NFC") : null,
  };
}

function skillCatalogEntries(value) {
  if (!/^\s*<skills_instructions>/u.test(value)) return [];
  const entries = [];
  const pattern = /<skill>\s*<name>([^<]+)<\/name>\s*<path>([^<]+)<\/path>[\s\S]*?<\/skill>/gu;
  for (const match of value.matchAll(pattern)) {
    entries.push({
      name: normalizeName(match[1]),
      path: toWellFormedUnicode(match[2]).normalize("NFC"),
    });
  }
  return entries;
}

function claudeSkillName(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) return null;
  return normalizeName(input.skill ?? input.name ?? input.command, "") || null;
}

function readPath(provider, name, input) {
  if (provider === "codex" && name === "Read") {
    const parsed = parseJsonInput(input);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
    if (parsed.offset !== undefined || parsed.limit !== undefined) return null;
    return typeof parsed.file_path === "string" ? toWellFormedUnicode(parsed.file_path) : null;
  }
  if (provider === "claude" && name === "Read") {
    if (!input || typeof input !== "object" || Array.isArray(input)) return null;
    if (input.offset !== undefined || input.limit !== undefined) return null;
    return typeof input.file_path === "string" ? toWellFormedUnicode(input.file_path) : null;
  }
  return null;
}

class EvidenceBuilder {
  constructor(provider, file, privacyContext, options, metadata) {
    const priorState = options.checkpoint?.pendingState?.sessionState;
    this.provider = provider;
    this.factSchemaVersion = options.factSchemaVersion ?? FACT_SCHEMA_VERSION;
    this.file = file;
    this.readResult = null;
    this.privacyContext = privacyContext;
    this.options = options;
    this.metadata = metadata;
    this.sessionId = metadata.sessionId.toLowerCase();
    this.sessionKey = metadata.sessionKey ?? hashKey("session", provider, this.sessionId);
    this.sessionScope = metadata.sessionScope;
    this.eligibility = metadata.eligibility ?? (
      metadata.sessionScope === "main"
        ? "eligible"
        : metadata.sessionScope === "subagent"
          ? "subagent-excluded"
          : "unknown"
    );
    this.sessionFactTruncation = [...(priorState?.factTruncation ?? [])];
    this.sourceRecords = new Map();
    this.turns = [];
    this.turnByKey = new Map();
    this.evidenceEvents = [];
    this.historyEvents = [];
    this.historyEventByKey = new Map();
    this.historyPayloads = [];
    this.historyPayloadChunks = [];
    this.turnEvidence = [];
    this.turnEvidenceIds = new Set();
    this.capabilities = new Map();
    this.capabilityUses = [];
    this.useByKey = new Map();
    this.useSummaryByKey = new Map();
    this.capabilityUseEvidence = [];
    this.useEvidenceIds = new Set();
    this.pendingUses = new Map();
    this.pendingStarted = [];
    this.catalogByPath = new Map();
    this.diagnosticItems = new Map();
    this.coverage = {};
    this.ordinalByRecordContent = new Map();
    this.ordinalRecordStart = null;
    this.turnEventPressure = new Map();
    this.turnUsePressure = new Map();
    this.turnLinkPressure = new Map();
    this.sessionEventPressure = 0;
    this.sessionCatalogPressure = 0;
    this.factCapsDue = false;
    this.currentTurn = null;
    this.observedStart = priorState?.observedStart ?? null;
    this.observedEnd = priorState?.observedEnd ?? null;
    this.firstTurnKey = priorState?.firstTurnKey ?? null;
    this.secondTurnKey = priorState?.secondTurnKey ?? null;
    this.seenClaudeUuidDigests = new Map();
    this.claudeUuidOverflow = false;
    const replayFromOffset = options.checkpoint?.pendingState?.replayFromOffset;
    for (const item of (options.checkpoint?.pendingState?.seenClaudeUuids ?? []).slice(-MAX_CLAUDE_UUIDS)) {
      if (replayFromOffset == null || BigInt(item.recordStartOffset) < BigInt(replayFromOffset)) {
        this.seenClaudeUuidDigests.set(item.digest, item.recordStartOffset);
      }
    }
    for (const entry of options.checkpoint?.pendingState?.catalogEntries ?? []) {
      const capability = {
        capabilityKey: entry.capabilityKey,
        provider,
        kind: "skill",
        canonicalName: entry.canonicalName,
        identityVersion: IDENTITY_VERSION,
      };
      this.capabilities.set(capability.capabilityKey, capability);
      this.catalogByPath.set(entry.pathFingerprint, {
        capability,
        event: { eventKey: entry.eventKey },
      });
    }
    for (const item of options.checkpoint?.pendingState?.pendingStarted ?? []) {
      if (replayFromOffset == null || BigInt(item.recordStartOffset) < BigInt(replayFromOffset)) {
        this.pendingStarted.push({
          event: {
            eventKey: item.eventKey,
            sourceOrder: {
              recordStartOffset: item.recordStartOffset,
              contentIndex: -1,
              eventOrdinal: 0,
            },
          },
          providerTurnDigest: item.providerTurnDigest,
          turnKey: item.turnKey,
        });
      }
    }
  }

  cover(name, amount = 1) {
    if (Object.hasOwn(this.coverage, name)) {
      this.coverage[name] += amount;
      return;
    }
    const key = Object.keys(this.coverage).length < MAX_COVERAGE_KEYS - 1
      ? name
      : "coverage-key-overflow";
    this.coverage[key] = (this.coverage[key] ?? 0) + amount;
  }

  addDiagnostic(item) {
    const code = normalizeName(item.code, "unknown-record");
    const current = this.diagnosticItems.get(code);
    if (current) {
      current.count += Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 1;
      return;
    }
    if (this.diagnosticItems.size >= MAX_DIAGNOSTICS - 1) {
      const overflow = this.diagnosticItems.get("diagnostic-code-overflow") ?? {
        code: "diagnostic-code-overflow",
        count: 0,
      };
      overflow.count += Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 1;
      this.diagnosticItems.set(overflow.code, overflow);
      return;
    }
    this.diagnosticItems.set(code, {
      code,
      count: Number.isSafeInteger(item.count) && item.count > 0 ? item.count : 1,
      ...(item.startOffset !== undefined ? { startOffset: item.startOffset } : {}),
      ...(typeof item.recordDigest === "string" ? { recordDigest: item.recordDigest } : {}),
    });
  }

  diagnose(code, record) {
    this.addDiagnostic({
      code,
      ...(record ? { startOffset: record.startOffset, recordDigest: record.recordSha256 } : {}),
    });
  }

  observeTimestamp(value) {
    const normalized = timestamp(value);
    if (!normalized) return null;
    if (this.observedStart === null || normalized < this.observedStart) this.observedStart = normalized;
    if (this.observedEnd === null || normalized > this.observedEnd) this.observedEnd = normalized;
    return normalized;
  }

  nextOrdinal(record, contentIndex) {
    if (this.ordinalRecordStart !== record.startOffset) {
      this.ordinalByRecordContent.clear();
      this.ordinalRecordStart = record.startOffset;
    }
    const key = String(contentIndex);
    const ordinal = this.ordinalByRecordContent.get(key) ?? 0;
    if (ordinal > 65535) throw new RangeError("event ordinal exceeds uint16");
    this.ordinalByRecordContent.set(key, ordinal + 1);
    return ordinal;
  }

  bumpTurnPressure(map, turnKey, amount, limit, slack) {
    if (!turnKey) return;
    const value = (map.get(turnKey) ?? 0) + amount;
    map.set(turnKey, value);
    if (value > limit + slack) this.factCapsDue = true;
  }

  rebuildFactPressure() {
    this.turnEventPressure = new Map(this.turns.map((turn) => [turn.turnKey, 0]));
    this.turnUsePressure = new Map(this.turns.map((turn) => [turn.turnKey, 0]));
    this.turnLinkPressure = new Map(this.turns.map((turn) => [turn.turnKey, 0]));
    this.sessionEventPressure = 0;
    this.sessionCatalogPressure = 0;
    const eventKeysByTurn = new Map(this.turns.map((turn) => [turn.turnKey, new Set()]));
    for (const event of this.evidenceEvents) {
      if (event.occurredTurnKey === null) {
        this.sessionEventPressure += 1;
        if (event.kind === "skill-catalog-entry") this.sessionCatalogPressure += 1;
      } else {
        eventKeysByTurn.get(event.occurredTurnKey)?.add(event.eventKey);
      }
    }
    for (const use of this.capabilityUses) {
      this.turnUsePressure.set(use.turnKey, (this.turnUsePressure.get(use.turnKey) ?? 0) + 1);
    }
    for (const link of this.turnEvidence) {
      eventKeysByTurn.get(link.turnKey)?.add(link.eventKey);
      this.turnLinkPressure.set(link.turnKey, (this.turnLinkPressure.get(link.turnKey) ?? 0) + 1);
    }
    for (const link of this.capabilityUseEvidence) {
      const turnKey = this.useByKey.get(link.useKey)?.turnKey;
      if (!turnKey) continue;
      eventKeysByTurn.get(turnKey)?.add(link.eventKey);
      this.turnLinkPressure.set(turnKey, (this.turnLinkPressure.get(turnKey) ?? 0) + 1);
    }
    for (const [turnKey, eventKeys] of eventKeysByTurn) {
      this.turnEventPressure.set(turnKey, eventKeys.size);
    }
    this.factCapsDue =
      this.sessionEventPressure > MAX_SESSION_EVENTS + FACT_CAP_SLACK.sessionEvents ||
      this.sessionCatalogPressure > MAX_SESSION_CATALOG_EVENTS + FACT_CAP_SLACK.catalogEvents ||
      [...this.turnEventPressure.values()].some((value) => value > MAX_TURN_EVENTS + FACT_CAP_SLACK.events) ||
      [...this.turnUsePressure.values()].some((value) => value > MAX_TURN_USES + FACT_CAP_SLACK.uses) ||
      [...this.turnLinkPressure.values()].some((value) => value > MAX_TURN_LINKS + FACT_CAP_SLACK.links);
  }

  ensureSourceRecord(record, providerRecordClass) {
    let source = this.sourceRecords.get(record.startOffset);
    if (source) return source;
    source = {
      sourceRecordKey: hashKey(
        "source-record",
        hexBytes(this.sessionKey),
        uint64(record.startOffset),
      ),
      ownerSessionKey: this.sessionKey,
      startOffset: record.startOffset,
      endOffset: record.endOffset,
      recordSha256: record.recordSha256,
      providerRecordClass,
    };
    this.sourceRecords.set(record.startOffset, source);
    return source;
  }

  addEvent(
    record,
    contentIndex,
    providerRecordClass,
    fields,
    occurredTurnKey = null,
    originScope = "main",
    historyFields = {},
  ) {
    const source = this.ensureSourceRecord(record, providerRecordClass);
    const eventOrdinal = this.nextOrdinal(record, contentIndex);
    const event = {
      eventKey: hashKey(
        "event",
        hexBytes(this.sessionKey),
        uint64(record.startOffset),
        int32(contentIndex),
        uint16(eventOrdinal),
      ),
      ownerSessionKey: this.sessionKey,
      occurredTurnKey,
      sourceRecordKey: source.sourceRecordKey,
      sourceOrder: {
        recordStartOffset: record.startOffset,
        contentIndex,
        eventOrdinal,
      },
      pointer: {
        pointerKind: `${this.provider}:${providerRecordClass}`,
        contentIndex,
        eventOrdinal,
      },
      originScope,
      observedTimestamp: this.observeTimestamp(record.value.timestamp ?? record.value.payload?.timestamp),
      ...fields,
    };
    this.evidenceEvents.push(event);
    if (this.factSchemaVersion === FACT_SCHEMA_VERSION_V2) {
      const historyEvent = {
        eventKey: event.eventKey,
        ownerSessionKey: event.ownerSessionKey,
        occurredTurnKey: event.occurredTurnKey,
        sourceRecordKey: event.sourceRecordKey,
        sourceOrder: event.sourceOrder,
        originScope: event.originScope,
        observedTimestamp: event.observedTimestamp,
        kind: event.kind,
        completeness: "full",
        revision: "0".repeat(64),
        metadata: historyMetadata({ ...fields, ...historyFields }),
        payloadKeys: [],
      };
      this.historyEvents.push(historyEvent);
      this.historyEventByKey.set(event.eventKey, historyEvent);
    }
    if (occurredTurnKey === null) {
      this.sessionEventPressure += 1;
      if (event.kind === "skill-catalog-entry") this.sessionCatalogPressure += 1;
      if (
        this.sessionEventPressure > MAX_SESSION_EVENTS + FACT_CAP_SLACK.sessionEvents ||
        this.sessionCatalogPressure > MAX_SESSION_CATALOG_EVENTS + FACT_CAP_SLACK.catalogEvents
      ) {
        this.factCapsDue = true;
      }
    } else {
      this.bumpTurnPressure(
        this.turnEventPressure,
        occurredTurnKey,
        1,
        MAX_TURN_EVENTS,
        FACT_CAP_SLACK.events,
      );
    }
    return event;
  }

  addHistoryEvent(
    record,
    contentIndex,
    providerRecordClass,
    fields,
    occurredTurnKey = null,
    originScope = "main",
  ) {
    if (this.factSchemaVersion !== FACT_SCHEMA_VERSION_V2) return null;
    const source = this.ensureSourceRecord(record, providerRecordClass);
    const eventOrdinal = this.nextOrdinal(record, contentIndex);
    const event = {
      eventKey: hashKey(
        "event",
        hexBytes(this.sessionKey),
        uint64(record.startOffset),
        int32(contentIndex),
        uint16(eventOrdinal),
      ),
      ownerSessionKey: this.sessionKey,
      occurredTurnKey,
      sourceRecordKey: source.sourceRecordKey,
      sourceOrder: {
        recordStartOffset: record.startOffset,
        contentIndex,
        eventOrdinal,
      },
      originScope,
      observedTimestamp: this.observeTimestamp(record.value.timestamp ?? record.value.payload?.timestamp),
      kind: fields.kind,
      completeness: "full",
      revision: "0".repeat(64),
      metadata: historyMetadata(fields),
      payloadKeys: [],
    };
    this.historyEvents.push(event);
    this.historyEventByKey.set(event.eventKey, event);
    return event;
  }

  addHistoryPayload(event, payloadKind, value, options = {}) {
    if (this.factSchemaVersion !== FACT_SCHEMA_VERSION_V2 || !event) return null;
    const semantic = semanticPayload(value, options);
    if (semantic === null) return null;
    const content = toWellFormedUnicode(semantic.content).normalize("NFC");
    const historyEvent = this.historyEventByKey.get(event.eventKey);
    if (!historyEvent) throw new TypeError("history payload event is missing");
    const contentBytes = Buffer.from(content, "utf8");
    const payloadKey = hashKey(
      "history-payload",
      hexBytes(event.eventKey),
      payloadKind,
    );
    const chunks = chunkUtf8(content);
    const payload = {
      payloadKey,
      ownerSessionKey: this.sessionKey,
      eventKey: event.eventKey,
      payloadKind,
      encoding: semantic.encoding,
      byteLength: String(contentBytes.length),
      sha256: sha256(contentBytes),
      completeness: "full",
      chunkCount: String(chunks.length),
    };
    this.historyPayloads.push(payload);
    for (let ordinal = 0; ordinal < chunks.length; ordinal += 1) {
      const content = chunks[ordinal];
      const chunkBytes = Buffer.from(content, "utf8");
      this.historyPayloadChunks.push({
        payloadKey,
        ownerSessionKey: this.sessionKey,
        ordinal: String(ordinal),
        content,
        byteLength: String(chunkBytes.length),
        sha256: sha256(chunkBytes),
      });
    }
    historyEvent.payloadKeys.push(payloadKey);
    return payload;
  }

  preserveProviderRecord(record, firstHistoryEventIndex) {
    if (this.factSchemaVersion !== FACT_SCHEMA_VERSION_V2) return;
    let event = this.historyEvents[firstHistoryEventIndex] ?? null;
    if (event === null) {
      const source = this.ensureSourceRecord(
        record,
        normalizeName(record.value?.type ?? record.value?.kind, "provider-record"),
      );
      event = {
        eventKey: hashKey(
          "history-event",
          hexBytes(this.sessionKey),
          uint64(record.startOffset),
          "provider-record",
        ),
        ownerSessionKey: this.sessionKey,
        occurredTurnKey: this.currentTurn?.turnKey ?? null,
        sourceRecordKey: source.sourceRecordKey,
        sourceOrder: {
          recordStartOffset: record.startOffset,
          contentIndex: -1,
          eventOrdinal: 65535,
        },
        originScope: "main",
        observedTimestamp: this.observeTimestamp(
          record.value.timestamp ?? record.value.payload?.timestamp,
        ),
        kind: "provider-unknown",
        completeness: "full",
        revision: "0".repeat(64),
        metadata: {},
        payloadKeys: [],
      };
      this.historyEvents.push(event);
      this.historyEventByKey.set(event.eventKey, event);
    }
    this.addHistoryPayload(event, "provider-payload", record.value);
  }

  addTurnEvidence(turnKey, eventKey, role) {
    if (!turnKey) return;
    const identity = `${turnKey}:${eventKey}:${role}`;
    if (this.turnEvidenceIds.has(identity)) return;
    this.turnEvidenceIds.add(identity);
    this.turnEvidence.push({ identity, ownerSessionKey: this.sessionKey, turnKey, eventKey, role });
    this.bumpTurnPressure(
      this.turnEventPressure,
      turnKey,
      1,
      MAX_TURN_EVENTS,
      FACT_CAP_SLACK.events,
    );
    this.bumpTurnPressure(
      this.turnLinkPressure,
      turnKey,
      1,
      MAX_TURN_LINKS,
      FACT_CAP_SLACK.links,
    );
  }

  ensureCapability(kind, canonicalName) {
    const name = canonicalCapabilityName(canonicalName);
    if (name === null) throw new TypeError("capability name must be a non-empty string");
    const capabilityKey = hashKey(
      "capability",
      this.provider,
      kind,
      name,
      Buffer.from([IDENTITY_VERSION]),
    );
    let capability = this.capabilities.get(capabilityKey);
    if (!capability) {
      capability = {
        capabilityKey,
        provider: this.provider,
        kind,
        canonicalName: name,
        identityVersion: IDENTITY_VERSION,
      };
      this.capabilities.set(capabilityKey, capability);
    }
    return capability;
  }

  createUse({ turn, capability, observedName, correlationDigest, firstEventKey, originScope, input, strength }) {
    if (!turn) return null;
    const branch = correlationDigest
      ? Buffer.concat([Buffer.from([1]), hexBytes(correlationDigest)])
      : Buffer.concat([Buffer.from([0]), hexBytes(firstEventKey)]);
    const useKey = hashKey("capability-use", hexBytes(turn.turnKey), branch);
    let use = this.useByKey.get(useKey);
    if (use) return use;
    use = {
      useKey,
      ownerSessionKey: this.sessionKey,
      turnKey: turn.turnKey,
      capabilityKey: capability.capabilityKey,
      turnOrdinal: turn.nextUseOrdinal,
      exactObservedName: canonicalCapabilityName(observedName) ?? capability.canonicalName,
      originScope,
      ...(originScope !== "main"
        ? { originFingerprint: this.privacyContext.fingerprint("origin", this.provider, originScope) }
        : {}),
      ...(input !== undefined
        ? {
            inputFingerprint: this.privacyContext.inputFingerprint(
              this.provider,
              capability.kind,
              capability.canonicalName,
              input,
            ),
          }
        : {}),
      ...(correlationDigest ? { correlationDigest } : {}),
      providerTerminalState: "pending",
      strength,
    };
    turn.nextUseOrdinal += 1;
    const summary = {
      useKey,
      kind: capability.kind,
      name: capability.canonicalName,
      terminalState: "pending",
    };
    turn.useSummaries.push(summary);
    this.useSummaryByKey.set(useKey, summary);
    this.capabilityUses.push(use);
    this.useByKey.set(useKey, use);
    this.bumpTurnPressure(
      this.turnUsePressure,
      turn.turnKey,
      1,
      MAX_TURN_USES,
      FACT_CAP_SLACK.uses,
    );
    return use;
  }

  addUseEvidence(use, event, role) {
    if (!use || !event) return;
    const identity = `${use.useKey}:${event.eventKey}:${role}`;
    if (this.useEvidenceIds.has(identity)) return;
    this.useEvidenceIds.add(identity);
    this.capabilityUseEvidence.push({
      identity,
      ownerSessionKey: this.sessionKey,
      useKey: use.useKey,
      eventKey: event.eventKey,
      role,
    });
    this.bumpTurnPressure(
      this.turnEventPressure,
      use.turnKey,
      1,
      MAX_TURN_EVENTS,
      FACT_CAP_SLACK.events,
    );
    this.bumpTurnPressure(
      this.turnLinkPressure,
      use.turnKey,
      1,
      MAX_TURN_LINKS,
      FACT_CAP_SLACK.links,
    );
  }

  updateUseTerminal(use, state) {
    if (!use) return;
    use.providerTerminalState = state;
    const summary = this.useSummaryByKey.get(use.useKey);
    if (summary) summary.terminalState = state;
  }

  clearPendingUsesForTurn(turnKey) {
    for (const [correlation, pending] of this.pendingUses) {
      if (pending.use?.turnKey === turnKey) {
        if (pending.use.providerTerminalState === "pending") {
          this.updateUseTerminal(pending.use, "unknown");
        }
        this.pendingUses.delete(correlation);
      }
    }
  }

  startTurn(
    record,
    problemText,
    rawUserText,
    boundaryTimestamp,
    providerRecordClass,
    contentIndex = -1,
    deferPendingUseCleanup = false,
  ) {
    const previous = this.currentTurn;
    if (previous) previous.rawClosure.nextUserBoundary = true;
    const turnKey = hashKey(
      "turn",
      hexBytes(this.sessionKey),
      uint64(record.startOffset),
    );
    const factTruncation = [];
    if (Buffer.byteLength(problemText) > MAX_PROBLEM_BYTES) factTruncation.push("problem-text");
    const turn = {
      turnKey,
      ownerSessionKey: this.sessionKey,
      turnStartOffset: record.startOffset,
      replayStartOffset: this.pendingStarted
        .filter((item) => item.turnKey === null && item.event.sourceOrder?.recordStartOffset != null)
        .reduce(
          (earliest, item) =>
            BigInt(item.event.sourceOrder.recordStartOffset) < BigInt(earliest)
              ? item.event.sourceOrder.recordStartOffset
              : earliest,
          record.startOffset,
        ),
      problemText: boundedProblem(problemText),
      finalAnswerExcerpt: "",
      observedTimestamp: boundaryTimestamp,
      rawClosure: {
        nextUserBoundary: false,
        providerTerminal: null,
        observedEofClosed: false,
      },
      providerVisibility: "active",
      factTruncation,
      nextUseOrdinal: 0,
      userTextDigest: normalizedTextDigest(rawUserText),
      assistantDigests: [],
      useSummaries: [],
      boundaryEventKey: null,
    };
    this.turns.push(turn);
    if (this.firstTurnKey === null) this.firstTurnKey = turnKey;
    else if (this.secondTurnKey === null && turnKey !== this.firstTurnKey) this.secondTurnKey = turnKey;
    this.turnByKey.set(turnKey, turn);
    this.currentTurn = turn;
    const event = this.addEvent(
      record,
      contentIndex,
      providerRecordClass,
      { kind: "visible-message", role: "user" },
      turnKey,
    );
    this.addHistoryPayload(event, "message-content", rawUserText);
    turn.boundaryEventKey = event.eventKey;
    this.addTurnEvidence(turnKey, event.eventKey, "boundary");
    if (previous) this.addTurnEvidence(previous.turnKey, event.eventKey, "follow-up");
    for (const pending of this.pendingStarted) {
      if (pending.turnKey !== null) continue;
      pending.turnKey = turnKey;
      this.addTurnEvidence(turnKey, pending.event.eventKey, "lifecycle");
    }
    if (previous && !deferPendingUseCleanup) this.clearPendingUsesForTurn(previous.turnKey);
    return turn;
  }

  addAssistant(record, text, rawText, providerRecordClass, contentIndex = -1, originScope = "main") {
    if (!this.currentTurn || !text) return null;
    const event = this.addEvent(
      record,
      contentIndex,
      providerRecordClass,
      { kind: "visible-message", role: "assistant" },
      this.currentTurn.turnKey,
      originScope,
    );
    this.addHistoryPayload(event, "message-content", rawText);
    if (originScope === "main") {
      if (Buffer.byteLength(text) > MAX_EXCERPT_BYTES) {
        if (!this.currentTurn.factTruncation.includes("final-answer-excerpt")) {
          this.currentTurn.factTruncation.push("final-answer-excerpt");
        }
      }
      this.currentTurn.finalAnswerExcerpt = boundedExcerpt(text);
      this.currentTurn.assistantDigests.push({
        eventKey: event.eventKey,
        digest: normalizedTextDigest(rawText),
      });
    }
    return event;
  }
}

function providerTurnDigest(builder, value) {
  return typeof value === "string" && value
    ? builder.privacyContext.fingerprint("provider-turn", builder.provider, value)
    : null;
}

function correlationDigest(builder, value) {
  return typeof value === "string" && value
    ? hashKey("provider-correlation", hexBytes(builder.sessionKey), value)
    : null;
}

function addSkillUse(builder, record, contentIndex, providerRecordClass, skill, strength, evidenceSource, originScope = "main") {
  if (!builder.currentTurn) {
    builder.diagnose("orphan-skill-load", record);
    return null;
  }
  if (canonicalCapabilityName(skill.name) === null) {
    builder.diagnose("invalid-capability-name", record);
    return null;
  }
  const capability = builder.ensureCapability("skill", skill.name);
  const event = builder.addEvent(
    record,
    contentIndex,
    providerRecordClass,
    {
      kind: "skill-load",
      capabilityKey: capability.capabilityKey,
      strength,
      evidenceSource,
    },
    builder.currentTurn.turnKey,
    originScope,
  );
  const use = builder.createUse({
    turn: builder.currentTurn,
    capability,
    observedName: skill.name,
    correlationDigest: null,
    firstEventKey: event.eventKey,
    originScope,
    strength,
  });
  builder.addUseEvidence(use, event, "invocation");
  builder.updateUseTerminal(use, "unknown");
  return { event, use };
}

function processCodexMessage(builder, record, payload) {
  const role = payload.role;
  const rawText = rawContentText(payload.content);
  const providerRecordClass = `response_item:message:${role ?? "unknown"}`;

  if (role === "developer") {
    for (const entry of skillCatalogEntries(rawText)) {
      if (canonicalCapabilityName(entry.name) === null) {
        builder.diagnose("invalid-capability-name", record);
        continue;
      }
      const capability = builder.ensureCapability("skill", entry.name);
      const pathFingerprint = builder.privacyContext.pathFingerprint("codex", entry.path);
      const event = builder.addEvent(
        record,
        -1,
        providerRecordClass,
        {
          kind: "skill-catalog-entry",
          capabilityKey: capability.capabilityKey,
          pathFingerprint,
        },
      );
      builder.catalogByPath.set(pathFingerprint, { capability, event });
    }
    return;
  }

  if (role === "user") {
    const skill = structuredSkill(rawText);
    if (skill) {
      addSkillUse(
        builder,
        record,
        -1,
        providerRecordClass,
        skill,
        "confirmed",
        "structured-skill-injection",
      );
      return;
    }
    const problemText = visibleUserMarkdown("codex", record.value);
    if (!problemText) {
      builder.cover("ignored-hidden-user-message");
      return;
    }
    builder.startTurn(
      record,
      problemText,
      rawText,
      builder.observeTimestamp(record.value.timestamp ?? payload.timestamp),
      providerRecordClass,
    );
    return;
  }

  if (role === "assistant") {
    const text = visibleAssistantText(payload.content);
    builder.addAssistant(record, text, rawText, providerRecordClass);
  }
}

function processCodexInvocation(builder, record, payload) {
  const name = canonicalCapabilityName(payload.name);
  if (name === null) {
    builder.diagnose("invalid-capability-name", record);
    return;
  }
  const providerRecordClass = `response_item:${payload.type}`;
  const rawCorrelation = payload.call_id ?? payload.id;
  const correlation = correlationDigest(builder, rawCorrelation);
  const input = admittedToolInput(builder, payload.arguments ?? payload.input, record);
  const capability = builder.ensureCapability("tool", name);
  const inputFingerprint = input === undefined ? null : builder.privacyContext.inputFingerprint(
    "codex",
    "tool",
    capability.canonicalName,
    input,
  );
  const fileActivities = toolFileActivities(
    "codex",
    name,
    input,
    builder.metadata.projectRoot,
  );
  const event = builder.addEvent(
    record,
    -1,
    providerRecordClass,
    {
      kind: "capability-invocation",
      capabilityKey: capability.capabilityKey,
      ...(correlation ? { correlationDigest: correlation } : {}),
      ...(inputFingerprint ? { inputFingerprint } : {}),
    },
    builder.currentTurn?.turnKey ?? null,
    "main",
    fileActivities.length > 0 ? { fileActivities } : {},
  );
  builder.addHistoryPayload(
    event,
    "tool-input",
    payload.arguments ?? payload.input,
    { parseJsonString: true },
  );
  const use = builder.createUse({
    turn: builder.currentTurn,
    capability,
    observedName: name,
    correlationDigest: correlation,
    firstEventKey: event.eventKey,
    originScope: "main",
    input,
    strength: "observed",
  });
  builder.addUseEvidence(use, event, "invocation");
  if (correlation && use) {
    const fullReadPath = readPath("codex", name, input);
    builder.pendingUses.set(correlation, {
      use,
      invocationEvent: event,
      name,
      input,
      fileActivities,
      fullReadPathFingerprint: fullReadPath
        ? builder.privacyContext.pathFingerprint("codex", fullReadPath)
        : null,
    });
  }
}

function processCodexResult(builder, record, payload) {
  const providerRecordClass = `response_item:${payload.type}`;
  const correlation = correlationDigest(builder, payload.call_id ?? payload.id);
  const state = eventState(payload);
  const result = payload.error ?? payload.output;
  const pending = correlation ? builder.pendingUses.get(correlation) : null;
  const signature = state === "failed" ? errorSignature(result) : null;
  const observedCommitObjectIds = pending
    ? observedGitCommitObjectIds(pending.name, pending.input, result, state)
    : [];
  const event = builder.addEvent(
    record,
    -1,
    providerRecordClass,
    {
      kind: "capability-result",
      ...(correlation ? { correlationDigest: correlation } : {}),
      providerState: state,
      ...(validDecimal(payload.exit_code ?? payload.exitCode) !== null
        ? { exitCode: validDecimal(payload.exit_code ?? payload.exitCode) }
        : {}),
      outputBytes: outputByteLength(result),
      ...(validDecimal(payload.duration_ms ?? payload.durationMs) !== null
        ? { durationMs: validDecimal(payload.duration_ms ?? payload.durationMs) }
        : {}),
    },
    builder.currentTurn?.turnKey ?? null,
    "main",
    {
      ...(pending?.use ? { capabilityKey: pending.use.capabilityKey } : {}),
      ...(pending?.fileActivities?.length > 0
        ? { fileActivities: resultFileActivities(pending.fileActivities, state) }
        : {}),
      ...(signature
        ? { errorSignatureVersion: "error-signature@1", errorSignature: signature }
        : {}),
      ...(observedCommitObjectIds.length > 0
        ? { observedGitCommitObjectIds: observedCommitObjectIds }
        : {}),
    },
  );
  builder.addHistoryPayload(event, "tool-output", result, { parseJsonString: true });
  if (!pending?.use) {
    builder.diagnose("orphan-tool-result", record);
    return;
  }
  builder.addUseEvidence(pending.use, event, "result");
  builder.updateUseTerminal(pending.use, state);
  if (state !== "failed" && pending.fullReadPathFingerprint) {
    const catalog = builder.catalogByPath.get(pending.fullReadPathFingerprint);
    if (catalog) {
      const load = addSkillUse(
        builder,
        record,
        -1,
        providerRecordClass,
        { name: catalog.capability.canonicalName },
        "inferred",
        "session-catalog-complete-read",
      );
      if (load) {
        builder.addUseEvidence(load.use, pending.invocationEvent, "invocation");
        builder.addUseEvidence(load.use, catalog.event, "corroboration");
        builder.addUseEvidence(load.use, event, "result");
      }
    }
  }
}

function processCodexLifecycle(builder, record, payload) {
  const subtype = payload.type;
  const providerRecordClass = `event_msg:${subtype}`;
  if (subtype === "token_count") {
    const metadata = codexTokenMetadata(payload);
    if (metadata) {
      builder.addHistoryEvent(
        record,
        -1,
        providerRecordClass,
        { kind: "token-usage", ...metadata },
        builder.currentTurn?.turnKey ?? null,
      );
    } else {
      builder.cover("token-usage-unavailable");
    }
    return;
  }
  if (subtype === "task_started") {
    const turnDigest = providerTurnDigest(builder, payload.turn_id);
    const event = builder.addEvent(
      record,
      -1,
      providerRecordClass,
      {
        kind: "turn-lifecycle",
        lifecycleState: "started",
        ...(turnDigest ? { providerTurnDigest: turnDigest } : {}),
      },
    );
    builder.pendingStarted.push({ event, providerTurnDigest: turnDigest, turnKey: null });
    return;
  }
  if (subtype === "task_complete" || subtype === "turn_aborted") {
    const lifecycleState = subtype === "task_complete" ? "completed" : "aborted";
    const turnDigest = providerTurnDigest(builder, payload.turn_id);
    const matches = turnDigest
      ? builder.pendingStarted.filter((item) => item.providerTurnDigest === turnDigest && item.turnKey)
      : builder.pendingStarted.filter((item) => item.turnKey);
    const targetTurnKey = matches.length === 1 ? matches[0].turnKey : null;
    const unambiguous = matches.length === 1;
    const event = builder.addEvent(
      record,
      -1,
      providerRecordClass,
      {
        kind: "turn-lifecycle",
        lifecycleState,
        ...(turnDigest ? { providerTurnDigest: turnDigest } : {}),
      },
    );
    if (unambiguous && targetTurnKey) {
      builder.addTurnEvidence(targetTurnKey, event.eventKey, "lifecycle");
      const turn = builder.turnByKey.get(targetTurnKey);
      if (turn && !turn.rawClosure.nextUserBoundary) {
        turn.rawClosure.providerTerminal = lifecycleState;
      }
      for (const match of matches) {
        const index = builder.pendingStarted.indexOf(match);
        if (index !== -1) builder.pendingStarted.splice(index, 1);
      }
    } else {
      builder.diagnose("ambiguous-turn-terminal", record);
    }
    return;
  }
  if (subtype === "thread_rolled_back") {
    const count = validDecimal(payload.num_turns);
    const withinRange = count !== null && BigInt(count) >= 1n && BigInt(count) <= 512n;
    builder.addEvent(
      record,
      -1,
      providerRecordClass,
      {
        kind: "provider-status",
        statusKind: "thread-rolled-back",
        providerState: withinRange ? "observed" : "invalid",
        ...(withinRange ? { rolledBackTurnCount: count } : {}),
      },
    );
    if (!withinRange) builder.diagnose("invalid-rollback-count", record);
    return;
  }
  if (subtype === "user_message" || subtype === "agent_message") {
    builder.cover(`ignored-${subtype}-twin`);
    builder.diagnose("ignored-provider-twin", record);
    return;
  }
  if (/_begin$|_end$/u.test(subtype)) {
    builder.cover(`ignored-${subtype}`);
    builder.diagnose("ignored-tool-twin", record);
    return;
  }
  if (subtype === "context_compacted") {
    builder.cover("ignored-context-compacted");
    return;
  }
  if (subtype === "sub_agent_activity") {
    builder.addEvent(
      record,
      -1,
      providerRecordClass,
      {
        kind: "provider-status",
        statusKind: "inline-subagent-activity",
        providerState: "observed",
      },
      builder.currentTurn?.turnKey ?? null,
      "subagent",
    );
    builder.cover("inline-subagent-record");
    return;
  }
  builder.cover(`unknown-event-msg:${normalizeName(subtype)}`);
  builder.diagnose("unknown-provider-record", record);
}

function processCodexRecord(builder, record) {
  const value = record.value;
  if (value.type === "session_meta") return;
  if (value.type === "inter_agent_communication_metadata") {
    builder.addEvent(
      record,
      -1,
      "inter_agent_communication_metadata",
      {
        kind: "provider-status",
        statusKind: "inter-agent-communication",
        providerState: "observed",
      },
      builder.currentTurn?.turnKey ?? null,
      "subagent",
    );
    builder.cover("inline-subagent-record");
    return;
  }
  if (value.type === "compacted") {
    builder.cover("ignored-compacted");
    return;
  }
  if (value.type === "event_msg" && value.payload && typeof value.payload === "object") {
    processCodexLifecycle(builder, record, value.payload);
    return;
  }
  if (value.type !== "response_item" || !value.payload || typeof value.payload !== "object") {
    builder.cover(`unknown-record:${normalizeName(value.type)}`);
    builder.diagnose("unknown-provider-record", record);
    return;
  }
  const payload = value.payload;
  if (payload.type === "agent_message") {
    builder.addEvent(
      record,
      -1,
      "response_item:agent_message",
      { kind: "visible-message", role: "assistant" },
      builder.currentTurn?.turnKey ?? null,
      "subagent",
    );
    builder.cover("inline-subagent-record");
    return;
  }
  if (payload.type === "message") {
    processCodexMessage(builder, record, payload);
    return;
  }
  if (payload.type === "function_call" || payload.type === "custom_tool_call") {
    processCodexInvocation(builder, record, payload);
    return;
  }
  if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
    processCodexResult(builder, record, payload);
    return;
  }
  builder.cover(`ignored-response-item:${normalizeName(payload.type)}`);
}

function processClaudeInvocation(builder, record, part, contentIndex, originScope) {
  const name = canonicalCapabilityName(part.name);
  if (name === null) {
    builder.diagnose("invalid-capability-name", record);
    return;
  }
  const providerRecordClass = "assistant:tool_use";
  const correlation = correlationDigest(builder, part.id);
  const capability = builder.ensureCapability("tool", name);
  const input = admittedToolInput(builder, part.input, record);
  const inputFingerprint = input === undefined ? null : builder.privacyContext.inputFingerprint(
    "claude",
    "tool",
    capability.canonicalName,
    input,
  );
  const fileActivities = toolFileActivities(
    "claude",
    name,
    input,
    builder.metadata.projectRoot,
  );
  const event = builder.addEvent(
    record,
    contentIndex,
    providerRecordClass,
    {
      kind: "capability-invocation",
      capabilityKey: capability.capabilityKey,
      ...(correlation ? { correlationDigest: correlation } : {}),
      ...(inputFingerprint ? { inputFingerprint } : {}),
    },
    builder.currentTurn?.turnKey ?? null,
    originScope,
    fileActivities.length > 0 ? { fileActivities } : {},
  );
  builder.addHistoryPayload(event, "tool-input", part.input, { parseJsonString: true });
  const use = builder.createUse({
    turn: builder.currentTurn,
    capability,
    observedName: name,
    correlationDigest: correlation,
    firstEventKey: event.eventKey,
    originScope,
    input,
    strength: "observed",
  });
  builder.addUseEvidence(use, event, "invocation");
  if (correlation && use) {
    builder.pendingUses.set(correlation, {
      use,
      invocationEvent: event,
      name,
      input,
      fileActivities,
      originScope,
      skillName: name === "Skill" ? claudeSkillName(input) : null,
    });
  }
}

function processClaudeResult(builder, record, part, contentIndex, originScope) {
  const providerRecordClass = "user:tool_result";
  const correlation = correlationDigest(builder, part.tool_use_id);
  const state = eventState(part);
  const pending = correlation ? builder.pendingUses.get(correlation) : null;
  const signature = state === "failed" ? errorSignature(part.content) : null;
  const observedCommitObjectIds = pending
    ? observedGitCommitObjectIds(pending.name, pending.input, part.content, state)
    : [];
  const event = builder.addEvent(
    record,
    contentIndex,
    providerRecordClass,
    {
      kind: "capability-result",
      ...(correlation ? { correlationDigest: correlation } : {}),
      providerState: state,
      outputBytes: outputByteLength(part.content),
      ...(validDecimal(part.duration_ms ?? part.durationMs) !== null
        ? { durationMs: validDecimal(part.duration_ms ?? part.durationMs) }
        : {}),
    },
    builder.currentTurn?.turnKey ?? null,
    originScope,
    {
      ...(pending?.use ? { capabilityKey: pending.use.capabilityKey } : {}),
      ...(pending?.fileActivities?.length > 0
        ? { fileActivities: resultFileActivities(pending.fileActivities, state) }
        : {}),
      ...(signature
        ? { errorSignatureVersion: "error-signature@1", errorSignature: signature }
        : {}),
      ...(observedCommitObjectIds.length > 0
        ? { observedGitCommitObjectIds: observedCommitObjectIds }
        : {}),
    },
  );
  builder.addHistoryPayload(event, "tool-output", part.content, { parseJsonString: true });
  if (!pending?.use) {
    builder.diagnose("orphan-tool-result", record);
    return;
  }
  builder.addUseEvidence(pending.use, event, "result");
  builder.updateUseTerminal(pending.use, state);
  if (pending.skillName && state !== "failed") {
    const load = addSkillUse(
      builder,
      record,
      contentIndex,
      providerRecordClass,
      { name: pending.skillName },
      "confirmed",
      "claude-skill-tool-success",
      pending.originScope,
    );
    if (load) {
      builder.addUseEvidence(load.use, pending.invocationEvent, "invocation");
      builder.addUseEvidence(load.use, event, "result");
    }
  }
}

function processClaudeUser(builder, record, content, originScope) {
  const items = contentItems(content);
  const boundaryIndex = items.findIndex((part) => rawPartText(part).length > 0);
  const admission = admittedContentEntries(builder, content, (_part, index) => index === boundaryIndex);
  const visible = visibleUserMarkdown("claude", record.value);
  const previousTurnKey = builder.currentTurn?.turnKey ?? null;
  let boundaryCreated = false;
  for (const [contentIndex, part] of admission.entries) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "tool_result") {
      processClaudeResult(builder, record, part, contentIndex, originScope);
      if (builder.factCapsDue) applyFactCaps(builder);
      continue;
    }
    const rawText = rawPartText(part);
    if (originScope !== "main" && rawText && !boundaryCreated) {
      builder.addEvent(
        record,
        contentIndex,
        "user:sidechain-visible-text",
        { kind: "visible-message", role: "user" },
        builder.currentTurn?.turnKey ?? null,
        originScope,
      );
      boundaryCreated = true;
      continue;
    }
    if (!boundaryCreated && visible && rawText) {
      builder.startTurn(
        record,
        visible,
        rawContentText(content),
        builder.observeTimestamp(record.value.timestamp),
        "user:visible-text",
        contentIndex,
        true,
      );
      boundaryCreated = true;
    }
    if (builder.factCapsDue) applyFactCaps(builder);
  }
  if (!boundaryCreated && visible && originScope === "main") {
    builder.startTurn(
      record,
      visible,
      rawContentText(content),
      builder.observeTimestamp(record.value.timestamp),
      "user:visible-text",
      -1,
      true,
    );
    boundaryCreated = true;
  }
  if (admission.truncated && builder.currentTurn) {
    addTruncation(builder.currentTurn.factTruncation, "record-content-items");
  }
  if (originScope === "main" && boundaryCreated && previousTurnKey) {
    builder.clearPendingUsesForTurn(previousTurnKey);
  }
}

function processClaudeAssistant(builder, record, content, originScope) {
  const items = contentItems(content);
  let finalVisibleIndex = -1;
  for (let index = items.length - 1; index >= 0; index -= 1) {
    if (rawPartText(items[index]).length > 0 && items[index]?.type !== "thinking") {
      finalVisibleIndex = index;
      break;
    }
  }
  const admission = admittedContentEntries(builder, content, (_part, index) => index === finalVisibleIndex);
  for (const [contentIndex, part] of admission.entries) {
    if (!part || typeof part !== "object") continue;
    if (part.type === "tool_use") {
      processClaudeInvocation(builder, record, part, contentIndex, originScope);
      if (builder.factCapsDue) applyFactCaps(builder);
      continue;
    }
    if (part.type === "thinking") {
      builder.cover("ignored-thinking");
      continue;
    }
    const rawText = rawPartText(part);
    if (!rawText) continue;
    builder.addAssistant(
      record,
      redactSecrets(rawText),
      rawText,
      "assistant:visible-text",
      contentIndex,
      originScope,
    );
    if (builder.factCapsDue) applyFactCaps(builder);
  }
  if (admission.truncated && builder.currentTurn) {
    addTruncation(builder.currentTurn.factTruncation, "record-content-items");
  }
}

function processClaudeRecord(builder, record) {
  const value = record.value;
  if (typeof value.uuid === "string") {
    const uuidDigest = hashKey(
      "claude-record-uuid",
      hexBytes(builder.sessionKey),
      value.uuid,
    );
    if (builder.seenClaudeUuidDigests.has(uuidDigest)) {
      builder.cover("ignored-duplicate-uuid");
      return;
    }
    if (builder.seenClaudeUuidDigests.size < MAX_CLAUDE_UUIDS) {
      builder.seenClaudeUuidDigests.set(uuidDigest, record.startOffset);
    } else {
      builder.cover("claude-uuid-dedupe-overflow");
      if (!builder.claudeUuidOverflow) {
        builder.claudeUuidOverflow = true;
        builder.diagnose("claude-uuid-dedupe-overflow", record);
      }
    }
  }

  const knownIgnored = new Set([
    "attachment",
    "last-prompt",
    "queue-operation",
    "mode",
    "relocated",
    "worktree-state",
    "file-history-snapshot",
    "file-history-delta",
    "pr-link",
    "system",
  ]);
  if (knownIgnored.has(value.type)) {
    builder.cover(`ignored-${value.type}`);
    return;
  }
  if (value.type !== "user" && value.type !== "assistant") {
    builder.cover(`unknown-record:${normalizeName(value.type)}`);
    builder.diagnose("unknown-provider-record", record);
    return;
  }
  if (value.isMeta === true || value.isCompactSummary === true) {
    builder.cover(value.isMeta === true ? "ignored-meta" : "ignored-compact-summary");
    return;
  }
  const originScope = value.isSidechain === true ? "subagent" : "main";
  if (originScope === "subagent") builder.cover("sidechain-record");
  const role = value.message?.role === "assistant" || value.type === "assistant" ? "assistant" : "user";
  const content = value.message?.content;
  if (role === "user") processClaudeUser(builder, record, content, originScope);
  else {
    processClaudeAssistant(builder, record, content, originScope);
    const metadata = claudeTokenMetadata(value.message);
    if (metadata) {
      builder.addHistoryEvent(
        record,
        -1,
        "assistant:token-usage",
        { kind: "token-usage", ...metadata },
        builder.currentTurn?.turnKey ?? null,
        originScope,
      );
    }
  }
}

function createMetadataSummary() {
  return {
    codexMeta: null,
    conversation: null,
    originatorVersion: null,
    cwd: null,
  };
}

function observeMetadata(summary, provider, record) {
  const value = record.value;
  if (provider === "codex") {
    if (summary.codexMeta === null && value.type === "session_meta" && value.payload?.constructor === Object) {
      summary.codexMeta = value.payload;
    }
    return;
  }
  if (
    summary.conversation === null &&
    (value.type === "user" || value.type === "assistant") &&
    typeof value.sessionId === "string"
  ) {
    summary.conversation = value;
  }
  if (summary.originatorVersion === null && typeof value.version === "string") {
    summary.originatorVersion = value.version;
  }
  if (summary.cwd === null && typeof value.cwd === "string") summary.cwd = value.cwd;
}

async function scanMetadataSummary(provider, source, readerOptions) {
  const summary = createMetadataSummary();
  let seen = 0;
  for await (const record of streamSessionRecords(source, readerOptions)) {
    observeMetadata(summary, provider, record);
    seen += 1;
    if (provider === "codex" && summary.codexMeta !== null) break;
    if (
      provider === "claude" &&
      summary.conversation !== null &&
      summary.originatorVersion !== null &&
      summary.cwd !== null
    ) {
      break;
    }
    if (seen >= MAX_METADATA_RECORDS) break;
  }
  return summary;
}

function inspectMetadata(provider, file, summary, options, privacyContext) {
  const fallbackId = options.sessionId ?? sessionIdFromFile(file) ?? `${provider}-session`;
  const prior = options.checkpoint?.pendingState?.sessionState;
  if (provider === "codex") {
    const meta = summary.codexMeta;
    const sessionId = String(options.sessionId ?? meta?.session_id ?? meta?.id ?? fallbackId);
    const isSubagent = meta?.thread_source === "subagent" || meta?.source?.subagent?.thread_spawn != null;
    const root = meta?.forked_from_id ?? meta?.id ?? meta?.session_id;
    return {
      sessionId,
      sessionKey: prior?.sessionKey,
      sessionScope: isSubagent ? "subagent" : meta ? "main" : prior?.sessionScope ?? "unknown",
      eligibility: isSubagent ? "subagent-excluded" : prior?.eligibility,
      originatorVersion: typeof meta?.cli_version === "string"
        ? meta.cli_version
        : prior?.originatorVersion ?? null,
      projectKey: typeof meta?.cwd === "string"
        ? privacyContext.projectFingerprint("codex", meta.cwd)
        : prior?.projectKey ?? null,
      projectRoot: typeof meta?.cwd === "string" ? meta.cwd : null,
      explicitLineageFingerprint: !isSubagent && typeof root === "string"
        ? privacyContext.lineageFingerprint("codex", root.toLowerCase())
        : null,
      priorDedupe: prior?.dedupe ?? null,
      isAgentFile: false,
    };
  }

  const conversation = summary.conversation;
  const basename = path.basename(file);
  const isAgentFile = /^agent-.*\.jsonl$/u.test(basename) || file.split(path.sep).includes("subagents");
  const hasCanonicalMainShape =
    conversation !== null &&
    (options.sessionId != null || canonicalSessionId("claude", file) !== null);
  const sessionId = String(options.sessionId ?? conversation?.sessionId ?? fallbackId);
  const originator = summary.originatorVersion;
  const cwd = summary.cwd;
  return {
    sessionId,
    sessionKey: prior?.sessionKey,
    sessionScope: isAgentFile
      ? "subagent"
      : prior?.sessionScope ?? (hasCanonicalMainShape ? "main" : "unknown"),
    eligibility: isAgentFile ? "subagent-excluded" : prior?.eligibility,
    originatorVersion: originator ?? prior?.originatorVersion ?? null,
    projectKey: typeof cwd === "string"
      ? privacyContext.projectFingerprint("claude", cwd)
      : prior?.projectKey ?? null,
    projectRoot: typeof cwd === "string" ? cwd : null,
    explicitLineageFingerprint: null,
    priorDedupe: prior?.dedupe ?? null,
    isAgentFile,
  };
}

function turnSignature(turn) {
  if (!turn?.userTextDigest || !turn.observedTimestamp || turn.assistantDigests.length === 0) return null;
  return {
    userTextSha256: turn.userTextDigest,
    assistantContentDigests: turn.assistantDigests.map((item) => item.digest),
    capabilities: turn.useSummaries.map((item) => ({
      kind: item.kind,
      name: item.name,
      terminalState: item.terminalState,
    })),
  };
}

function deriveDedupe(builder, stableEof) {
  if (builder.metadata.explicitLineageFingerprint) {
    return {
      dedupeFingerprint: builder.metadata.explicitLineageFingerprint,
      duplicateMethod: "explicit-lineage",
      duplicateConfidence: "strong",
      dedupeClosure: "hard-sealed",
      dedupeEvidenceEventKeys: [],
    };
  }
  const prior = builder.metadata.priorDedupe;
  const first = builder.firstTurnKey ? builder.turnByKey.get(builder.firstTurnKey) : builder.turns[0];
  if (!first) {
    if (!prior) return {};
    const restored = {
      dedupeFingerprint: prior.dedupeFingerprint,
      duplicateMethod: prior.duplicateMethod,
      duplicateConfidence: prior.duplicateConfidence,
      dedupeClosure: prior.dedupeClosure,
      dedupeEvidenceEventKeys: [...prior.dedupeEvidenceEventKeys],
      ...(prior.dedupeCorroborationFingerprint
        ? { dedupeCorroborationFingerprint: prior.dedupeCorroborationFingerprint }
        : {}),
    };
    const second = builder.secondTurnKey
      ? builder.turnByKey.get(builder.secondTurnKey)
      : null;
    const secondHardSealed = second?.rawClosure.nextUserBoundary || second?.rawClosure.providerTerminal !== null;
    const secondSignature = secondHardSealed ? turnSignature(second) : null;
    if (secondSignature && restored.duplicateMethod === "exact-first-turn-prefix") {
      restored.dedupeCorroborationFingerprint = builder.privacyContext.dedupeFingerprint(
        builder.provider,
        sha256(canonicalJson(secondSignature)),
      );
    }
    return restored;
  }
  if (first?.factTruncation.some((item) =>
    item === "evidence-events" || item === "capability-uses" || item === "evidence-links"
  )) {
    builder.cover("dedupe-unknown-fact-truncation");
    return {};
  }
  const firstHardSealed = first?.rawClosure.nextUserBoundary || first?.rawClosure.providerTerminal !== null;
  const firstObservedEof =
    first === builder.currentTurn &&
    stableEof &&
    first.assistantDigests.length > 0;
  const signature = turnSignature(first);
  if (!signature || (!firstHardSealed && !firstObservedEof)) return {};
  const canonicalDigest = sha256(canonicalJson(signature));
  const result = {
    dedupeFingerprint: builder.privacyContext.dedupeFingerprint(builder.provider, canonicalDigest),
    duplicateMethod: "exact-first-turn-prefix",
    duplicateConfidence: "weak",
    dedupeClosure: firstHardSealed ? "hard-sealed" : "observed-eof",
    dedupeEvidenceEventKeys: [...new Set([
      first.boundaryEventKey,
      ...builder.evidenceEvents
        .filter((event) =>
          event.occurredTurnKey === first.turnKey && event.kind === "visible-message"
        )
        .map((event) => event.eventKey),
    ])],
  };
  const second = builder.secondTurnKey ? builder.turnByKey.get(builder.secondTurnKey) : builder.turns[1];
  const secondHardSealed = second?.rawClosure.nextUserBoundary || second?.rawClosure.providerTerminal !== null;
  const secondSignature = secondHardSealed ? turnSignature(second) : null;
  if (secondSignature) {
    result.dedupeCorroborationFingerprint = builder.privacyContext.dedupeFingerprint(
      builder.provider,
      sha256(canonicalJson(secondSignature)),
    );
  }
  return result;
}

function stableSort(items, selector) {
  return [...items].sort((left, right) => {
    const a = selector(left);
    const b = selector(right);
    return a < b ? -1 : a > b ? 1 : 0;
  });
}

function compareSourceOrder(left, right) {
  const offset = BigInt(left.recordStartOffset) - BigInt(right.recordStartOffset);
  if (offset !== 0n) return offset < 0n ? -1 : 1;
  if (left.contentIndex !== right.contentIndex) return left.contentIndex - right.contentIndex;
  return left.eventOrdinal - right.eventOrdinal;
}

function selectHeadTail(items, limit, keyOf, compare, isPriority = () => false) {
  const sorted = [...items].sort(compare);
  if (sorted.length <= limit) return new Set(sorted.map(keyOf));
  const priority = sorted.filter(isPriority);
  const ordinary = sorted.filter((item) => !isPriority(item));
  const take = (source, count) => {
    if (count <= 0) return [];
    if (source.length <= count) return source;
    const head = Math.ceil(count * 0.75);
    return [...source.slice(0, head), ...source.slice(source.length - (count - head))];
  };
  const selectedPriority = take(priority, limit);
  const selected = [
    ...selectedPriority,
    ...take(ordinary, Math.max(0, limit - selectedPriority.length)),
  ];
  return new Set(selected.map(keyOf));
}

function addTruncation(target, code) {
  if (!target.includes(code)) target.push(code);
}

function applyFactCaps(builder) {
  const eventByKey = new Map(builder.evidenceEvents.map((event) => [event.eventKey, event]));
  const usesByTurn = new Map(builder.turns.map((turn) => [turn.turnKey, []]));
  for (const use of builder.capabilityUses) usesByTurn.get(use.turnKey)?.push(use);
  const retainedUseKeys = new Set();

  for (const turn of builder.turns) {
    const uses = usesByTurn.get(turn.turnKey) ?? [];
    const selected = selectHeadTail(
      uses,
      MAX_TURN_USES,
      (use) => use.useKey,
      (left, right) => left.turnOrdinal - right.turnOrdinal || left.useKey.localeCompare(right.useKey),
    );
    for (const useKey of selected) retainedUseKeys.add(useKey);
    if (selected.size < uses.length) addTruncation(turn.factTruncation, "capability-uses");
  }

  builder.capabilityUses = builder.capabilityUses.filter((use) => retainedUseKeys.has(use.useKey));
  builder.useByKey = new Map(builder.capabilityUses.map((use) => [use.useKey, use]));
  for (const turn of builder.turns) {
    turn.useSummaries = turn.useSummaries.filter((summary) => retainedUseKeys.has(summary.useKey));
  }
  builder.useSummaryByKey = new Map(
    builder.turns.flatMap((turn) => turn.useSummaries.map((summary) => [summary.useKey, summary])),
  );
  for (const [correlation, pending] of builder.pendingUses) {
    if (pending.use && !retainedUseKeys.has(pending.use.useKey)) builder.pendingUses.delete(correlation);
  }

  const relevantByTurn = new Map(builder.turns.map((turn) => [turn.turnKey, new Map()]));
  const include = (turnKey, eventKey, priority = false) => {
    const relevant = relevantByTurn.get(turnKey);
    if (!relevant) return;
    const event = eventByKey.get(eventKey);
    const current = relevant.get(eventKey);
    relevant.set(eventKey, {
      eventKey,
      sourceOrder: event?.sourceOrder ?? {
        recordStartOffset: "0",
        contentIndex: -1,
        eventOrdinal: 0,
      },
      priority: priority || current?.priority === true ||
        event?.kind === "turn-lifecycle" ||
        (event?.kind === "visible-message" && event.role === "user"),
    });
  };
  for (const event of builder.evidenceEvents) {
    if (event.occurredTurnKey !== null) include(event.occurredTurnKey, event.eventKey);
  }
  for (const link of builder.turnEvidence) {
    include(
      link.turnKey,
      link.eventKey,
      link.role === "boundary" || link.role === "lifecycle",
    );
  }
  for (const link of builder.capabilityUseEvidence) {
    const use = builder.useByKey.get(link.useKey);
    if (use) include(use.turnKey, link.eventKey, link.role === "invocation");
  }

  const selectedEventsByTurn = new Map();
  for (const turn of builder.turns) {
    const relevant = relevantByTurn.get(turn.turnKey) ?? new Map();
    const selected = selectHeadTail(
      relevant.values(),
      MAX_TURN_EVENTS,
      (item) => item.eventKey,
      (left, right) => compareSourceOrder(left.sourceOrder, right.sourceOrder) ||
        left.eventKey.localeCompare(right.eventKey),
      (item) => item.priority,
    );
    selectedEventsByTurn.set(turn.turnKey, selected);
    if (selected.size < relevant.size) addTruncation(turn.factTruncation, "evidence-events");
  }

  const sessionEvents = builder.evidenceEvents.filter((event) => event.occurredTurnKey === null);
  const catalogEvents = sessionEvents.filter((event) => event.kind === "skill-catalog-entry");
  const retainedCatalog = selectHeadTail(
    catalogEvents,
    MAX_SESSION_CATALOG_EVENTS,
    (event) => event.eventKey,
    (left, right) => compareSourceOrder(left.sourceOrder, right.sourceOrder),
  );
  const sessionCandidates = sessionEvents.filter((event) =>
    event.kind !== "skill-catalog-entry" || retainedCatalog.has(event.eventKey),
  );
  const retainedSessionEvents = selectHeadTail(
    sessionCandidates,
    MAX_SESSION_EVENTS,
    (event) => event.eventKey,
    (left, right) => compareSourceOrder(left.sourceOrder, right.sourceOrder),
    (event) => event.kind === "turn-lifecycle" || event.kind === "capability-result" ||
      (event.kind === "provider-status" && event.statusKind === "thread-rolled-back"),
  );
  if (retainedSessionEvents.size < sessionEvents.length) {
    addTruncation(builder.sessionFactTruncation, "session-evidence-events");
  }
  if (retainedCatalog.size < catalogEvents.length) {
    addTruncation(builder.sessionFactTruncation, "skill-catalog-events");
  }

  const retainedEventKeys = new Set(retainedSessionEvents);
  for (const event of builder.evidenceEvents) {
    if (
      event.occurredTurnKey !== null &&
      selectedEventsByTurn.get(event.occurredTurnKey)?.has(event.eventKey)
    ) {
      retainedEventKeys.add(event.eventKey);
    }
  }
  const removedEventKeys = new Set(
    builder.evidenceEvents
      .filter((event) => !retainedEventKeys.has(event.eventKey))
      .map((event) => event.eventKey),
  );
  builder.evidenceEvents = builder.evidenceEvents.filter((event) => retainedEventKeys.has(event.eventKey));
  builder.turnEvidence = builder.turnEvidence.filter((link) =>
    !removedEventKeys.has(link.eventKey) &&
    (selectedEventsByTurn.get(link.turnKey)?.has(link.eventKey) ?? true),
  );
  builder.capabilityUseEvidence = builder.capabilityUseEvidence.filter((link) => {
    const use = builder.useByKey.get(link.useKey);
    return use && !removedEventKeys.has(link.eventKey) &&
      (selectedEventsByTurn.get(use.turnKey)?.has(link.eventKey) ?? true);
  });

  const currentEventByKey = new Map(builder.evidenceEvents.map((event) => [event.eventKey, event]));
  const linksByTurn = new Map(builder.turns.map((turn) => [turn.turnKey, []]));
  const retainedExternalLinkIds = new Set();
  for (const link of builder.turnEvidence) {
    const links = linksByTurn.get(link.turnKey);
    if (links) links.push({ type: "turn", link });
    else if (currentEventByKey.has(link.eventKey)) {
      retainedExternalLinkIds.add(`turn:${link.identity}`);
    }
  }
  for (const link of builder.capabilityUseEvidence) {
    const turnKey = builder.useByKey.get(link.useKey)?.turnKey;
    if (turnKey) linksByTurn.get(turnKey)?.push({ type: "use", link });
  }
  const retainedLinkIds = new Set(retainedExternalLinkIds);
  for (const turn of builder.turns) {
    const links = linksByTurn.get(turn.turnKey) ?? [];
    const selected = selectHeadTail(
      links,
      MAX_TURN_LINKS,
      (item) => `${item.type}:${item.link.identity}`,
      (left, right) => {
        const leftOrder = currentEventByKey.get(left.link.eventKey)?.sourceOrder ?? {
          recordStartOffset: "0", contentIndex: -1, eventOrdinal: 0,
        };
        const rightOrder = currentEventByKey.get(right.link.eventKey)?.sourceOrder ?? {
          recordStartOffset: "0", contentIndex: -1, eventOrdinal: 0,
        };
        return compareSourceOrder(leftOrder, rightOrder) || left.link.identity.localeCompare(right.link.identity);
      },
      (item) =>
        (item.type === "turn" && (item.link.role === "boundary" || item.link.role === "lifecycle")) ||
        (item.type === "use" && item.link.role === "invocation"),
    );
    if (selected.size < links.length) addTruncation(turn.factTruncation, "evidence-links");
    for (const identity of selected) retainedLinkIds.add(identity);
  }
  builder.turnEvidence = builder.turnEvidence.filter((link) => retainedLinkIds.has(`turn:${link.identity}`));
  builder.capabilityUseEvidence = builder.capabilityUseEvidence.filter((link) =>
    retainedLinkIds.has(`use:${link.identity}`),
  );

  for (const turn of builder.turns) {
    const selected = selectedEventsByTurn.get(turn.turnKey) ?? new Set();
    turn.assistantDigests = turn.assistantDigests.filter((item) => selected.has(item.eventKey));
  }
  for (let index = builder.pendingStarted.length - 1; index >= 0; index -= 1) {
    const eventKey = builder.pendingStarted[index].event.eventKey;
    if (removedEventKeys.has(eventKey)) builder.pendingStarted.splice(index, 1);
  }
  for (const [pathFingerprint, item] of builder.catalogByPath) {
    if (removedEventKeys.has(item.event.eventKey)) builder.catalogByPath.delete(pathFingerprint);
  }

  const referencedSourceKeys = new Set([
    ...builder.evidenceEvents.map((event) => event.sourceRecordKey),
    ...builder.historyEvents.map((event) => event.sourceRecordKey),
  ]);
  builder.sourceRecords = new Map(
    [...builder.sourceRecords].filter(([, source]) => referencedSourceKeys.has(source.sourceRecordKey)),
  );
  const referencedCapabilityKeys = new Set(builder.capabilityUses.map((use) => use.capabilityKey));
  for (const event of builder.evidenceEvents) {
    if (typeof event.capabilityKey === "string") referencedCapabilityKeys.add(event.capabilityKey);
  }
  builder.capabilities = new Map(
    [...builder.capabilities].filter(([key]) => referencedCapabilityKeys.has(key)),
  );
  builder.turnEvidenceIds = new Set(builder.turnEvidence.map((link) => link.identity));
  builder.useEvidenceIds = new Set(builder.capabilityUseEvidence.map((link) => link.identity));
  builder.rebuildFactPressure();
}

function publicTurn(turn) {
  const {
    replayStartOffset: _replayStartOffset,
    nextUseOrdinal: _nextUseOrdinal,
    userTextDigest: _userTextDigest,
    assistantDigests: _assistantDigests,
    useSummaries: _useSummaries,
    boundaryEventKey: _boundaryEventKey,
    ...fact
  } = turn;
  return fact;
}

function publicLink(link) {
  const { identity: _identity, ...fact } = link;
  return fact;
}

function finalizeHistoryFacts(builder) {
  if (builder.factSchemaVersion !== FACT_SCHEMA_VERSION_V2) {
    return { historyEvents: [], historyPayloads: [], historyPayloadChunks: [] };
  }
  const historyEvents = builder.historyEvents;
  const retainedPayloadKeys = new Set(historyEvents.flatMap((event) => event.payloadKeys));
  const historyPayloads = builder.historyPayloads.filter((payload) =>
    retainedPayloadKeys.has(payload.payloadKey),
  );
  const payloadByKey = new Map(historyPayloads.map((payload) => [payload.payloadKey, payload]));
  const historyPayloadChunks = builder.historyPayloadChunks.filter((chunk) =>
    retainedPayloadKeys.has(chunk.payloadKey),
  );
  for (const event of historyEvents) {
    event.payloadKeys.sort();
    event.revision = sha256(canonicalJson({
      eventKey: event.eventKey,
      ownerSessionKey: event.ownerSessionKey,
      occurredTurnKey: event.occurredTurnKey,
      sourceRecordKey: event.sourceRecordKey,
      sourceOrder: event.sourceOrder,
      originScope: event.originScope,
      observedTimestamp: event.observedTimestamp,
      kind: event.kind,
      completeness: event.completeness,
      metadata: event.metadata,
      payloads: event.payloadKeys.map((payloadKey) => {
        const payload = payloadByKey.get(payloadKey);
        if (!payload) throw new TypeError("history event references a missing payload");
        return { payloadKey, sha256: payload.sha256, byteLength: payload.byteLength };
      }),
    }));
  }
  return {
    historyEvents: stableSort(historyEvents, (item) => item.eventKey),
    historyPayloads: stableSort(historyPayloads, (item) => item.payloadKey),
    historyPayloadChunks: stableSort(
      historyPayloadChunks,
      (item) => `${item.payloadKey}:${item.ordinal.padStart(20, "0")}`,
    ),
  };
}

function finalizeDelta(builder, sourceSnapshot) {
  const stableEof = sourceSnapshot.atPhysicalEof ?? sourceSnapshot.stable;
  if (
    builder.currentTurn &&
    stableEof &&
    builder.currentTurn.assistantDigests.length > 0
  ) {
    builder.currentTurn.rawClosure.observedEofClosed = true;
  }
  if (builder.currentTurn && (builder.currentTurn.rawClosure.providerTerminal !== null || stableEof)) {
    builder.clearPendingUsesForTurn(builder.currentTurn.turnKey);
  }
  if (builder.factSchemaVersion !== FACT_SCHEMA_VERSION_V2) applyFactCaps(builder);
  const dedupe = builder.sessionScope === "main" ? deriveDedupe(builder, stableEof) : {};
  const checkpointGeneration = builder.options.checkpoint?.generation;
  const configuredGeneration = builder.options.expectedGeneration;
  if (
    checkpointGeneration !== undefined &&
    configuredGeneration !== undefined &&
    String(checkpointGeneration) !== String(configuredGeneration)
  ) {
    throw new TypeError("expectedGeneration must match checkpoint generation");
  }
  const expectedGeneration = String(configuredGeneration ?? checkpointGeneration ?? "0");
  if (!/^(?:0|[1-9][0-9]*)$/u.test(expectedGeneration)) {
    throw new TypeError("checkpoint generation must be a decimal string");
  }
  const targetGeneration = String(BigInt(expectedGeneration) + 1n);
  const pendingState = {
    currentTurnKey: builder.currentTurn?.turnKey ?? null,
    replayFromOffset:
      builder.currentTurn?.replayStartOffset ?? null,
    pendingStarted: builder.pendingStarted.map((item) => ({
      eventKey: item.event.eventKey,
      recordStartOffset: item.event.sourceOrder?.recordStartOffset ?? "0",
      providerTurnDigest: item.providerTurnDigest,
      turnKey: item.turnKey,
    })),
    pendingUses: [...builder.pendingUses.entries()].map(([correlation, item]) => ({
      correlationDigest: correlation,
      useKey: item.use?.useKey ?? null,
      capabilityKey: item.use?.capabilityKey ?? null,
    })),
    sessionState: {
      sessionKey: builder.sessionKey,
      sessionScope: builder.sessionScope,
      eligibility: builder.eligibility,
      originatorVersion: builder.metadata.originatorVersion ?? null,
      projectKey: builder.metadata.projectKey ?? null,
      observedStart: builder.observedStart,
      observedEnd: builder.observedEnd,
      firstTurnKey: builder.firstTurnKey,
      secondTurnKey: builder.secondTurnKey,
      factTruncation: [...builder.sessionFactTruncation],
      dedupe: dedupe.dedupeFingerprint ? {
        dedupeFingerprint: dedupe.dedupeFingerprint,
        duplicateMethod: dedupe.duplicateMethod,
        duplicateConfidence: dedupe.duplicateConfidence,
        dedupeClosure: dedupe.dedupeClosure,
        dedupeEvidenceEventKeys: [...dedupe.dedupeEvidenceEventKeys],
        ...(dedupe.dedupeCorroborationFingerprint
          ? { dedupeCorroborationFingerprint: dedupe.dedupeCorroborationFingerprint }
          : {}),
      } : null,
    },
    catalogEntries: [...builder.catalogByPath.entries()].map(([pathFingerprint, item]) => ({
      pathFingerprint,
      capabilityKey: item.capability.capabilityKey,
      canonicalName: item.capability.canonicalName,
      eventKey: item.event.eventKey,
    })),
    seenClaudeUuids: [...builder.seenClaudeUuidDigests.entries()]
      .map(([digest, recordStartOffset]) => ({ digest, recordStartOffset }))
      .sort((left, right) => left.digest.localeCompare(right.digest)),
  };
  const checkpoint = {
    ...builder.readResult.checkpoint,
    sourceSize: String(sourceSnapshot.size),
    sourceMtimeNs: String(sourceSnapshot.mtimeNs),
    sourceSnapshotStable: sourceSnapshot.stable,
    originSecretEpoch: builder.privacyContext.originSecretEpoch,
    generation: targetGeneration,
    pendingState,
  };
  const session = {
    sessionKey: builder.sessionKey,
    provider: builder.provider,
    ...(builder.metadata.originatorVersion
      ? { originatorVersion: normalizeName(builder.metadata.originatorVersion) }
      : {}),
    sessionScope: builder.sessionScope,
    ...(builder.metadata.projectKey ? { projectKey: builder.metadata.projectKey } : {}),
    observedStart: builder.observedStart,
    observedEnd: builder.observedEnd,
    eligibility: builder.eligibility,
    duplicatePolicyVersion: DUPLICATE_POLICY_VERSION,
    duplicateGroupKey: null,
    ...(builder.sessionFactTruncation.length > 0
      ? { factTruncation: builder.sessionFactTruncation }
      : {}),
    ...dedupe,
  };
  const historyFacts = finalizeHistoryFacts(builder);
  const isV2 = builder.factSchemaVersion === FACT_SCHEMA_VERSION_V2;
  const delta = {
    format: isV2 ? "session-facts-delta@v2" : "session-facts-delta@v1",
    factSchemaVersion: isV2 ? FACT_SCHEMA_VERSION_V2 : FACT_SCHEMA_VERSION,
    providerAdapterVersion: `${builder.provider}@${isV2 ? 2 : 1}`,
    privacyPolicyVersion: isV2 ? PRIVACY_POLICY_VERSION_V2 : PRIVACY_POLICY_VERSION,
    originSecretEpoch: builder.privacyContext.originSecretEpoch,
    duplicatePolicyVersion: DUPLICATE_POLICY_VERSION,
    expectedGeneration,
    targetGeneration,
    mode: builder.options.mode ?? "append",
    deltaId: "0".repeat(64),
    session,
    retractions: {
      turnKeys: [],
      orphanEventKeys: [],
      authoritativeTurnKeys: stableSort(builder.turns.map((turn) => turn.turnKey), (key) => key),
    },
    turns: stableSort(builder.turns.map(publicTurn), (item) => item.turnKey),
    sourceRecords: stableSort(builder.sourceRecords.values(), (item) => item.sourceRecordKey),
    evidenceEvents: stableSort(builder.evidenceEvents, (item) => item.eventKey),
    turnEvidence: stableSort(builder.turnEvidence.map(publicLink), (item) => `${item.turnKey}:${item.eventKey}:${item.role}`),
    capabilities: stableSort(builder.capabilities.values(), (item) => item.capabilityKey),
    capabilityUses: stableSort(builder.capabilityUses, (item) => item.useKey),
    capabilityUseEvidence: stableSort(
      builder.capabilityUseEvidence.map(publicLink),
      (item) => `${item.useKey}:${item.eventKey}:${item.role}`,
    ),
    ...(isV2 ? historyFacts : {}),
    checkpoint,
    diagnostics: aggregateDiagnostics(builder.diagnosticItems.values()),
    coverage: Object.fromEntries(Object.entries(builder.coverage).sort(([a], [b]) => a.localeCompare(b))),
  };
  const outboundUnicode = sanitizeUnicodeValues(delta);
  if (outboundUnicode.replacements > 0) {
    delta.coverage["invalid-unicode-replaced"] =
      (delta.coverage["invalid-unicode-replaced"] ?? 0) + outboundUnicode.replacements;
    delta.diagnostics.push({ code: "invalid-unicode-replaced", count: outboundUnicode.replacements });
    delta.diagnostics = aggregateDiagnostics(delta.diagnostics);
  }
  const mutationDigest = canonicalMutationDigest(delta);
  delta.deltaId = hashKey(
    "delta",
    hexBytes(builder.sessionKey),
    expectedGeneration,
    delta.mode,
    builder.privacyContext.originSecretEpoch,
    String(DUPLICATE_POLICY_VERSION),
    hexBytes(mutationDigest),
    checkpoint.completeOffset,
  );
  return delta;
}

export async function readProviderSessionDelta(provider, source, options = {}) {
  assertProvider(provider);
  if (options.factSchemaVersion !== undefined && ![1, 2].includes(options.factSchemaVersion)) {
    throw new TypeError("factSchemaVersion must be 1 or 2");
  }
  if (!options.privacyContext || typeof options.privacyContext.fingerprint !== "function") {
    throw new TypeError("privacyContext is required");
  }
  if (
    options.checkpoint?.originSecretEpoch &&
    options.checkpoint.originSecretEpoch.toLowerCase() !== options.privacyContext.originSecretEpoch
  ) {
    throw new TypeError("checkpoint origin secret epoch does not match privacyContext");
  }
  if (
    options.maxRecordBytes !== undefined &&
    (!Number.isSafeInteger(options.maxRecordBytes) ||
      options.maxRecordBytes <= 0 ||
      options.maxRecordBytes > MAX_PROVIDER_RECORD_BYTES)
  ) {
    throw new RangeError(`maxRecordBytes must be no greater than ${MAX_PROVIDER_RECORD_BYTES}`);
  }
  const before = await stat(source, { bigint: true });
  const readerOptions = {
    chunkSize: options.chunkSize,
    maxRecordBytes: options.maxRecordBytes ?? MAX_PROVIDER_RECORD_BYTES,
    onBytesRead: options.onBytesRead,
    endOffset: String(before.size),
  };
  const metadataSummary = options.checkpoint
    ? createMetadataSummary()
    : await scanMetadataSummary(provider, source, readerOptions);
  const metadata = inspectMetadata(
    provider,
    source,
    metadataSummary,
    options,
    options.privacyContext,
  );
  if (provider === "claude" && metadata.isAgentFile) {
    const error = new TypeError("Claude subagent session files are excluded from provider evidence");
    error.code = "TS_SESSION_SUBAGENT_EXCLUDED";
    throw error;
  }
  const builder = new EvidenceBuilder(provider, source, options.privacyContext, options, metadata);
  const replayFromOffset = options.checkpoint?.pendingState?.replayFromOffset;
  if (options.checkpoint && replayFromOffset !== null && replayFromOffset !== undefined) {
    await verifySessionRecordCheckpoint(source, options.checkpoint, readerOptions);
  }
  const readResult = await visitSessionRecords(
    source,
    replayFromOffset !== null && replayFromOffset !== undefined
      ? { ...readerOptions, startOffset: replayFromOffset }
      : { ...readerOptions, ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}) },
    (record) => {
      if (metadata.sessionScope === "main") {
        const unicode = sanitizeUnicodeValues(record.value);
        if (unicode.replacements > 0) {
          builder.cover("invalid-unicode-replaced", unicode.replacements);
          builder.diagnose("invalid-unicode-replaced", record);
        }
        const firstHistoryEventIndex = builder.historyEvents.length;
        if (provider === "codex") processCodexRecord(builder, record);
        else processClaudeRecord(builder, record);
        builder.preserveProviderRecord(record, firstHistoryEventIndex);
        if (
          builder.factSchemaVersion !== FACT_SCHEMA_VERSION_V2 &&
          builder.factCapsDue
        ) {
          applyFactCaps(builder);
        }
      }
    },
  );
  builder.readResult = readResult;
  for (const diagnostic of readResult.diagnostics) builder.addDiagnostic(diagnostic);
  if (metadata.sessionScope === "subagent") {
    builder.cover(provider === "codex" ? "file-subagent-excluded" : "unnamed-subagent-file-skipped");
  } else if (metadata.sessionScope === "unknown") {
    builder.cover("file-scope-unknown");
    builder.diagnose("unknown-session-scope");
  }
  const after = await stat(source, { bigint: true });
  const stableSnapshot =
    readResult.checkpoint.eofObserved === true &&
    before.dev === after.dev &&
    before.ino === after.ino &&
    after.size >= before.size &&
    (after.size > before.size || after.mtimeNs === before.mtimeNs);
  const delta = finalizeDelta(builder, {
    stable: stableSnapshot,
    atPhysicalEof:
      stableSnapshot &&
      readResult.checkpoint.partialTailLength === "0" &&
      before.size === after.size &&
      before.mtimeNs === after.mtimeNs,
    size: before.size,
    mtimeNs: before.mtimeNs,
  });
  const validation = delta.factSchemaVersion === FACT_SCHEMA_VERSION_V2
    ? validateSessionFactsDeltaV2(delta)
    : validateSessionFactsDelta(delta);
  if (!validation.valid) {
    const detail = validation.errors
      .slice(0, 8)
      .map((item) => `${item.instancePath || "/"} ${item.message}`)
      .join("; ");
    const error = new TypeError(
      `Provider adapter produced an invalid SessionFactsDeltaV${delta.factSchemaVersion}: ${detail}`,
    );
    error.validationErrors = validation.errors;
    throw error;
  }
  return delta;
}

export function getProviderEvidenceAdapter(provider) {
  assertProvider(provider);
  return Object.freeze({
    provider,
    providerAdapterVersion: `${provider}@1`,
    async readDelta(source, checkpoint, privacyContext, options = {}) {
      return readProviderSessionDelta(provider, source, {
        ...options,
        checkpoint,
        privacyContext,
      });
    },
  });
}

export async function discoverProviderEvidenceSources(provider, options = {}) {
  assertProvider(provider);
  const files = await discoverSessionFiles(provider, options);
  const matchesById = new Map();
  const canonicalById = new Map();
  let unnamedSubagentFiles = 0;
  for (const file of files) {
    const basename = path.basename(file);
    if (provider === "claude" && (/^agent-.*\.jsonl$/u.test(basename) || file.split(path.sep).includes("subagents"))) {
      unnamedSubagentFiles += 1;
      continue;
    }
    for (const id of new Set(sessionIdsInFileName(file))) {
      const normalized = id.toLowerCase();
      const matches = matchesById.get(normalized) ?? [];
      matches.push(file);
      matchesById.set(normalized, matches);
    }
    const canonical = canonicalSessionId(provider, file)?.toLowerCase();
    if (canonical) {
      const matches = canonicalById.get(canonical) ?? [];
      matches.push(file);
      canonicalById.set(canonical, matches);
    }
  }
  const sources = [];
  let ambiguous = 0;
  for (const [sessionId, canonicalFiles] of canonicalById) {
    if (canonicalFiles.length !== 1 || matchesById.get(sessionId)?.length !== 1) {
      ambiguous += 1;
      continue;
    }
    sources.push({ provider, sessionId, file: canonicalFiles[0] });
  }
  sources.sort((left, right) => left.sessionId.localeCompare(right.sessionId));
  const diagnostics = [];
  if (unnamedSubagentFiles > 0) {
    diagnostics.push({ code: "unnamed-subagent-file-skipped", count: unnamedSubagentFiles });
  }
  if (ambiguous > 0) diagnostics.push({ code: "ambiguous-session-skipped", count: ambiguous });
  return { provider, sources, diagnostics };
}
