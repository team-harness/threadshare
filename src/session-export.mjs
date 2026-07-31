import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { parseTree } from "jsonc-parser";

export const THREADSHARE_HISTORY_FORMAT = "threadshare-history@v1";

const SESSION_UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const SESSION_UUID_IN_TEXT_PATTERN =
  /[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i;

const BEARER_PROSE_TERMS = new Set([
  "authentication",
  "authorization",
  "credential",
  "credentials",
  "grant",
  "grants",
  "header",
  "headers",
  "mechanism",
  "mechanisms",
  "middleware",
  "protocol",
  "protocols",
  "scheme",
  "schemes",
  "specification",
  "specifications",
  "standard",
  "standards",
  "token",
  "tokens",
]);

function iso(value, fallback) {
  const parsed = new Date(value ?? fallback);
  return Number.isNaN(parsed.getTime()) ? new Date(fallback).toISOString() : parsed.toISOString();
}

function textFromContent(content) {
  if (typeof content === "string") return redactSecrets(content);
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object")
    .map(textFromPart)
    .filter(Boolean)
    .join("\n\n");
}

function textFromPart(part) {
  if (!part || typeof part !== "object") return "";
  if (typeof part.text === "string") return redactSecrets(part.text);
  if (typeof part.output_text === "string") return redactSecrets(part.output_text);
  if (typeof part.input_text === "string") return redactSecrets(part.input_text);
  return "";
}

function isSensitiveKey(key) {
  const normalized = key.replace(/[^a-z0-9]/gi, "").toLowerCase();
  const isTokenMetric =
    /^(?:input|output|prompt|completion|cached|reasoning|total|max|min)tokens?(?:count|used|usage|limit|remaining|type|status|expires|expiry|ttl|length)?$/.test(
      normalized,
    ) ||
    /^tokens?(?:count|used|usage|limit|remaining|max|min|type|status|expires|expiry|ttl|length)$/.test(
      normalized,
    );
  const isAuthMetadata =
    /^(?:auth|oauth|authentication|authorization)(?:status|state|enabled|mode|type|scheme|required)$/.test(
      normalized,
    );
  if (isTokenMetric || isAuthMetadata) return false;

  const words = key
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .split(/[^a-z0-9]+/)
    .filter(Boolean);
  const wordForms = words.flatMap((word) =>
    word.endsWith("s") ? [word, word.slice(0, -1)] : [word],
  );
  if (
    wordForms.some((word) =>
      [
        "auth",
        "authentication",
        "authorization",
        "cookie",
        "credential",
        "oauth",
        "passphrase",
        "passwd",
        "password",
        "secret",
        "token",
      ].includes(word),
    )
  ) {
    return true;
  }
  if (
    wordForms.includes("key") &&
    ["access", "api", "encryption", "private", "secret", "signing", "ssh"].some((word) =>
      wordForms.includes(word),
    )
  ) {
    return true;
  }

  const forms = normalized.endsWith("s") ? [normalized, normalized.slice(0, -1)] : [normalized];
  const sensitiveNames = [
    "accesskey",
    "apikey",
    "auth",
    "authentication",
    "authorization",
    "credential",
    "clientsecret",
    "passphrase",
    "passwd",
    "password",
    "privatekey",
    "secret",
    "secretkey",
    "token",
    "accesskeyid",
    "accesskeysecret",
    "secretaccesskey",
    "refreshtoken",
    "sessiontoken",
    "cookie",
  ];
  return forms.some((form) =>
    sensitiveNames.some((name) => form === name || form.endsWith(name)),
  );
}

function redactSecrets(value) {
  return value
    .replace(
      /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
      "[REDACTED]",
    )
    .replace(/\b([a-z][a-z0-9+.-]*:\/\/[^:\s/@]+:)[^@\s/]+@/gi, "$1[REDACTED]@")
    .replace(
      /((?:"|')?(?:auths?|authentications?|authorizations?)(?:"|')?\s*:\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|[^\r\n]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:"|')?(?:auths?|authentications?|authorizations?)(?:"|')?\s*=\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:AWS4-HMAC-SHA256|Basic|Bearer|Digest|HOBA|Mutual|Negotiate|OAuth|SCRAM-SHA-256(?:-PLUS)?|Signature|Token)\s+[^\s;]+|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(
      /((?:"|')?(?:api[_-]?keys?|access[_-]?key(?:s|[_-]?(?:ids?|secrets?))?|secret[_-]?access[_-]?keys?|access[_-]?tokens?|refresh[_-]?tokens?|session[_-]?tokens?|auths?|authentications?|authorizations?|cookies?|credentials?|client[_-]?secrets?|passwords?|private[_-]?keys?|secrets?|tokens?)(?:"|')?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|(?:Basic|Bearer)\s+[A-Za-z0-9._~+/=-]+|[^\s,;]+)/gi,
      "$1[REDACTED]",
    )
    .replace(/\b(Basic)\s+([A-Za-z0-9+/]+={0,2})/gi, (match, scheme, token) => {
      const decoded = Buffer.from(token, "base64");
      const canonical = decoded.toString("base64").replace(/=+$/, "");
      return canonical === token.replace(/=+$/, "") && decoded.toString("utf8").includes(":")
        ? `${scheme} [REDACTED]`
        : match;
    })
    .replace(
      /\b(Bearer)\s+([A-Za-z0-9._~+/=-]+)/gi,
      (match, scheme, token, offset, source) => {
        const following = source.slice(offset + match.length);
        const punctuation = /^(.*?)(\.+)$/.exec(token);
        const hasTrailingPunctuation =
          punctuation && (following === "" || /^[\s)\]}]/.test(following));
        const candidate = hasTrailingPunctuation ? punctuation[1] : token;
        const suffix = hasTrailingPunctuation ? punctuation[2] : "";
        return /^[A-Za-z]+$/.test(candidate) &&
          BEARER_PROSE_TERMS.has(candidate.toLowerCase())
          ? match
          : `${scheme} [REDACTED]${suffix}`;
      },
    )
    .replace(/\b[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:sk|rk)[-_][A-Za-z0-9_-]{8,}\b/g, "[REDACTED]")
    .replace(/\b(?:ghp|gho|ghu|ghs|github_pat)_[A-Za-z0-9_]{8,}\b/g, "[REDACTED]")
    .replace(
      /\b(?:AKIA[0-9A-Z]{16}|LTAI[A-Za-z0-9]{8,}|AIza[A-Za-z0-9_-]{20,}|xox[baprs]-[A-Za-z0-9-]{8,})\b/g,
      "[REDACTED]",
    );
}

function redactJsonText(value) {
  const errors = [];
  const root = parseTree(value, errors, { disallowComments: true, allowTrailingComma: false });
  if (!root || errors.length > 0) return undefined;

  const replacements = [];
  const visit = (node) => {
    if (node.type === "property") {
      const [keyNode, valueNode] = node.children ?? [];
      if (!valueNode) return;
      if (typeof keyNode?.value === "string" && isSensitiveKey(keyNode.value)) {
        replacements.push({ offset: valueNode.offset, length: valueNode.length, text: '"[REDACTED]"' });
      } else {
        visit(valueNode);
      }
      return;
    }
    if (node.type === "string" && typeof node.value === "string") {
      const redacted = redactSecrets(node.value);
      if (redacted !== node.value) {
        replacements.push({
          offset: node.offset,
          length: node.length,
          text: JSON.stringify(redacted),
        });
      }
      return;
    }
    for (const child of node.children ?? []) visit(child);
  };
  visit(root);

  return replacements
    .sort((left, right) => right.offset - left.offset)
    .reduce(
      (result, replacement) =>
        result.slice(0, replacement.offset) +
        replacement.text +
        result.slice(replacement.offset + replacement.length),
      value,
    );
}

function sanitizeVisibleValue(value) {
  if (typeof value === "string") {
    return redactJsonText(value) ?? redactSecrets(value);
  }
  if (Array.isArray(value)) return value.map(sanitizeVisibleValue);
  if (!value || typeof value !== "object") return value;
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => [
      key,
      isSensitiveKey(key) ? "[REDACTED]" : sanitizeVisibleValue(item),
    ]),
  );
}

function parseJsonLines(raw) {
  return raw
    .split("\n")
    .filter(Boolean)
    .flatMap((line) => {
      try {
        return [JSON.parse(line)];
      } catch {
        return [];
      }
    });
}

function baseHistory(provider, source, sessionId, title, exportedAt = Date.now()) {
  return {
    format: THREADSHARE_HISTORY_FORMAT,
    schemaVersion: 1,
    exportedAt: iso(exportedAt, Date.now()),
    conversation: {
      id: sessionId,
      title: title || `${provider === "claude" ? "Claude" : "Codex"} session`,
      provider,
      source,
    },
    entries: [],
  };
}

function entryId(provider, index, kind) {
  return `${provider}:${kind}:${index + 1}`;
}

function parseToolInput(value) {
  if (typeof value !== "string") return sanitizeVisibleValue(value);
  try {
    return sanitizeVisibleValue(JSON.parse(value));
  } catch {
    return sanitizeVisibleValue(value);
  }
}

function contentEntryId(base, kind, partIndex, partCount) {
  return partCount === 1 ? base : `${base}:${kind}:${partIndex + 1}`;
}

function applyToolResult(tool, result, failed) {
  if (!tool) return;
  tool.status = failed ? "failed" : "completed";
  if (failed) tool.error = sanitizeVisibleValue(result);
  else tool.output = sanitizeVisibleValue(result);
}

export function exportCodexJsonl(raw, options = {}) {
  const records = parseJsonLines(raw);
  const meta = records.find((record) => record.type === "session_meta")?.payload ?? {};
  const sessionId = meta.session_id ?? meta.id ?? options.sessionId ?? "codex-session";
  const history = baseHistory(
    "codex",
    "codex",
    sessionId,
    options.title,
    options.exportedAt,
  );
  const tools = new Map();

  for (const [index, record] of records.entries()) {
    if (record.type !== "response_item" || !record.payload) continue;
    const payload = record.payload;
    const createdAt = iso(record.timestamp ?? payload.timestamp, history.exportedAt);
    if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
      if (!Array.isArray(payload.content)) {
        const markdown = textFromContent(payload.content);
        if (markdown) {
          history.entries.push({
            id: payload.id ?? entryId("codex", index, payload.role),
            createdAt,
            kind: "message",
            role: payload.role,
            markdown,
          });
        }
        continue;
      }
      const baseId = payload.id ?? entryId("codex", index, payload.role);
      for (const [partIndex, part] of payload.content.entries()) {
        const isThought = part?.type === "reasoning" || part?.type === "thinking";
        if (isThought) {
          const text =
            typeof part.text === "string"
              ? redactSecrets(part.text)
              : typeof part.summary === "string"
                ? redactSecrets(part.summary)
                : "";
          if (!text) continue;
          history.entries.push({
            id: contentEntryId(baseId, "thought", partIndex, payload.content.length),
            createdAt,
            kind: "thought",
            text,
            status: "ready",
          });
          continue;
        }

        const markdown = textFromPart(part);
        if (markdown) {
          history.entries.push({
            id: contentEntryId(baseId, "message", partIndex, payload.content.length),
            createdAt,
            kind: "message",
            role: payload.role,
            markdown,
          });
        }
      }
      continue;
    }
    if (payload.type === "reasoning") {
      const text = textFromContent(payload.summary);
      if (text) {
        history.entries.push({
          id: payload.id ?? entryId("codex", index, "thought"),
          createdAt,
          kind: "thought",
          text,
          status: "ready",
        });
      }
      continue;
    }
    if (payload.type === "function_call" || payload.type === "custom_tool_call") {
      const id = payload.call_id ?? payload.id ?? entryId("codex", index, "tool");
      const tool = {
        id,
        createdAt,
        kind: "tool",
        name: payload.name ?? "tool",
        status: "running",
        input: parseToolInput(payload.arguments ?? payload.input),
      };
      history.entries.push(tool);
      tools.set(id, tool);
      continue;
    }
    if (payload.type === "function_call_output" || payload.type === "custom_tool_call_output") {
      applyToolResult(
        tools.get(payload.call_id ?? payload.id),
        payload.error ?? payload.output,
        payload.status === "failed" || payload.error != null,
      );
    }
  }
  return history;
}

export function exportClaudeJsonl(raw, options = {}) {
  const records = parseJsonLines(raw);
  const first = records.find((record) => record.type === "user" || record.type === "assistant");
  const sessionId = options.sessionId ?? first?.sessionId ?? path.basename(options.file ?? "claude-session", ".jsonl");
  const history = baseHistory(
    "claude",
    "claude",
    sessionId,
    options.title,
    options.exportedAt,
  );
  const seen = new Set();
  const tools = new Map();

  for (const [index, record] of records.entries()) {
    if (record.type !== "user" && record.type !== "assistant") continue;
    if (record.isMeta === true || record.isSidechain === true || record.isCompactSummary === true) continue;
    if (record.uuid && seen.has(record.uuid)) continue;
    if (record.uuid) seen.add(record.uuid);
    const content = record.message?.content;
    const createdAt = iso(record.timestamp, history.exportedAt);
    const role = record.message?.role === "assistant" || record.type === "assistant" ? "assistant" : "user";
    if (!Array.isArray(content)) {
      const markdown = textFromContent(content);
      if (markdown) {
        history.entries.push({
          id: record.uuid ?? entryId("claude", index, role),
          createdAt,
          kind: "message",
          role,
          markdown,
        });
      }
      continue;
    }
    const baseId = record.uuid ?? entryId("claude", index, role);
    for (const [partIndex, part] of content.entries()) {
      if (!part || typeof part !== "object") continue;
      if (part.type !== "thinking" && part.type !== "tool_use" && part.type !== "tool_result") {
        const markdown = textFromPart(part);
        if (markdown) {
          history.entries.push({
            id: contentEntryId(baseId, "message", partIndex, content.length),
            createdAt,
            kind: "message",
            role,
            markdown,
          });
        }
      }
      if (part.type === "thinking" && typeof part.thinking === "string") {
        const text = redactSecrets(part.thinking);
        if (!text) continue;
        history.entries.push({
          id: contentEntryId(baseId, "thought", partIndex, content.length),
          createdAt,
          kind: "thought",
          text,
          status: "ready",
        });
      }
      if (part.type === "tool_use") {
        const id = part.id ?? contentEntryId(baseId, "tool", partIndex, content.length);
        const tool = {
          id,
          createdAt,
          kind: "tool",
          name: part.name ?? "tool",
          status: "running",
          input: sanitizeVisibleValue(part.input),
        };
        history.entries.push(tool);
        tools.set(id, tool);
      }
      if (part.type === "tool_result") {
        applyToolResult(
          tools.get(part.tool_use_id),
          part.content,
          part.is_error === true || part.status === "failed",
        );
      }
    }
  }
  return history;
}

async function walk(root) {
  const files = [];
  for (const entry of await readdir(root, { withFileTypes: true })) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(file)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
  }
  return files;
}

export async function resolveSessionFile(provider, value, options = {}) {
  if (value.includes("/") || value.endsWith(".jsonl")) return path.resolve(value);
  const environment = options.environment ?? process.env;
  const home = environment.HOME || os.homedir();
  const root =
    provider === "codex"
      ? path.join(environment.CODEX_HOME ?? path.join(home, ".codex"), "sessions")
      : path.join(home, ".claude", "projects");
  let files;
  try {
    files = await walk(root);
  } catch (error) {
    if (error?.code !== "ENOENT") throw error;
    files = [];
  }
  const matches = files.filter((file) => path.basename(file).includes(value));
  if (matches.length === 0) throw new Error(`No ${provider} session matches ${value}`);
  if (matches.length > 1) throw new Error(`Multiple ${provider} sessions match ${value}; pass a file path`);
  return matches[0];
}

export async function exportSession(provider, session, options = {}) {
  const file = await resolveSessionFile(provider, session, options);
  const raw = await readFile(file, "utf8");
  return provider === "codex"
    ? exportCodexJsonl(raw, {
        sessionId: path.basename(file).match(SESSION_UUID_IN_TEXT_PATTERN)?.[0],
        file,
      })
    : exportClaudeJsonl(raw, { sessionId: path.basename(file, ".jsonl"), file });
}

export async function exportSessionById(provider, sessionId, options = {}) {
  if (provider !== "codex" && provider !== "claude") {
    throw new Error(`Unsupported native session provider: ${provider}`);
  }
  if (!SESSION_UUID_PATTERN.test(sessionId)) {
    throw new Error("Native session ID must be a complete UUID");
  }
  return exportSession(provider, sessionId, options);
}
