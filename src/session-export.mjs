import { readFile, readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

export const THREADSHARE_HISTORY_FORMAT = "threadshare-history@v1";

function iso(value, fallback) {
  const parsed = new Date(value ?? fallback);
  return Number.isNaN(parsed.getTime()) ? new Date(fallback).toISOString() : parsed.toISOString();
}

function textFromContent(content) {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .filter((part) => part && typeof part === "object")
    .map((part) => {
      if (typeof part.text === "string") return part.text;
      if (typeof part.output_text === "string") return part.output_text;
      if (typeof part.input_text === "string") return part.input_text;
      return "";
    })
    .filter(Boolean)
    .join("\n\n");
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

function baseHistory(provider, source, sessionId, title, exportedAt) {
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
  if (typeof value !== "string") return value;
  try {
    return JSON.parse(value);
  } catch {
    return value;
  }
}

export function exportCodexJsonl(raw, options = {}) {
  const records = parseJsonLines(raw);
  const meta = records.find((record) => record.type === "session_meta")?.payload ?? {};
  const sessionId = options.sessionId ?? meta.session_id ?? meta.id ?? "codex-session";
  const history = baseHistory(
    "codex",
    "codex",
    sessionId,
    options.title,
    meta.timestamp ?? records[0]?.timestamp ?? Date.now(),
  );

  for (const [index, record] of records.entries()) {
    if (record.type !== "response_item" || !record.payload) continue;
    const payload = record.payload;
    const createdAt = iso(record.timestamp ?? payload.timestamp, history.exportedAt);
    if (payload.type === "message" && (payload.role === "user" || payload.role === "assistant")) {
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
      for (const [partIndex, part] of (payload.content ?? []).entries()) {
        if (part?.type !== "reasoning" && part?.type !== "thinking") continue;
        const text = typeof part.text === "string" ? part.text : typeof part.summary === "string" ? part.summary : "";
        if (!text) continue;
        history.entries.push({
          id: `${payload.id ?? entryId("codex", index, "thought")}:thought:${partIndex + 1}`,
          createdAt,
          kind: "thought",
          text,
          status: "ready",
        });
      }
      continue;
    }
    if (payload.type === "function_call") {
      history.entries.push({
        id: payload.call_id ?? payload.id ?? entryId("codex", index, "tool"),
        createdAt,
        kind: "tool",
        name: payload.name ?? "tool",
        status: "completed",
        input: parseToolInput(payload.arguments),
      });
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
    first?.timestamp ?? Date.now(),
  );
  const seen = new Set();

  for (const [index, record] of records.entries()) {
    if (record.type !== "user" && record.type !== "assistant") continue;
    if (record.uuid && seen.has(record.uuid)) continue;
    if (record.uuid) seen.add(record.uuid);
    const content = record.message?.content;
    const createdAt = iso(record.timestamp, history.exportedAt);
    const role = record.message?.role === "assistant" || record.type === "assistant" ? "assistant" : "user";
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
    if (!Array.isArray(content)) continue;
    for (const [partIndex, part] of content.entries()) {
      if (!part || typeof part !== "object") continue;
      if (part.type === "thinking" && typeof part.thinking === "string") {
        history.entries.push({
          id: `${record.uuid ?? entryId("claude", index, "thought")}:thought:${partIndex + 1}`,
          createdAt,
          kind: "thought",
          text: part.thinking,
          status: "ready",
        });
      }
      if (part.type === "tool_use") {
        history.entries.push({
          id: part.id ?? `${record.uuid ?? entryId("claude", index, "tool")}:tool:${partIndex + 1}`,
          createdAt,
          kind: "tool",
          name: part.name ?? "tool",
          status: "completed",
          input: part.input,
        });
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

export async function resolveSessionFile(provider, value) {
  if (value.includes("/") || value.endsWith(".jsonl")) return path.resolve(value);
  const root =
    provider === "codex"
      ? path.join(process.env.CODEX_HOME ?? path.join(os.homedir(), ".codex"), "sessions")
      : path.join(os.homedir(), ".claude", "projects");
  const matches = (await walk(root)).filter((file) => path.basename(file).includes(value));
  if (matches.length === 0) throw new Error(`No ${provider} session matches ${value}`);
  if (matches.length > 1) throw new Error(`Multiple ${provider} sessions match ${value}; pass a file path`);
  return matches[0];
}

export async function exportSession(provider, session) {
  const file = await resolveSessionFile(provider, session);
  const raw = await readFile(file, "utf8");
  return provider === "codex"
    ? exportCodexJsonl(raw, { sessionId: path.basename(file).match(/[0-9a-f-]{36}/i)?.[0], file })
    : exportClaudeJsonl(raw, { sessionId: path.basename(file, ".jsonl"), file });
}
