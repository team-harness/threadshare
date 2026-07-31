import { open, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { stripVTControlCharacters } from "node:util";
import {
  DEFAULT_MESSAGE_PAGE_SIZE,
  MAX_MESSAGE_PAGE_SIZE,
  createMessagePreview,
} from "./history-selection.mjs";
import {
  canonicalSessionId,
  discoverSessionFiles,
  sessionIdsInFileName,
} from "./session-files.mjs";
import { redactSecrets, visibleUserMarkdown } from "./session-export.mjs";

export const DEFAULT_SESSION_PAGE_SIZE = DEFAULT_MESSAGE_PAGE_SIZE;
export const MAX_SESSION_PAGE_SIZE = MAX_MESSAGE_PAGE_SIZE;
export const DEFAULT_SESSION_SUMMARY_BYTES = 1024 * 1024;

async function mapLimit(items, concurrency, mapper) {
  const results = new Array(items.length);
  let nextIndex = 0;
  async function worker() {
    while (nextIndex < items.length) {
      const index = nextIndex;
      nextIndex += 1;
      results[index] = await mapper(items[index], index);
    }
  }
  const workers = Array.from(
    { length: Math.min(concurrency, items.length) },
    () => worker(),
  );
  await Promise.all(workers);
  return results;
}

function boundedInteger(name, value, fallback, minimum, maximum) {
  const selected = value ?? fallback;
  if (!Number.isSafeInteger(selected) || selected < minimum || selected > maximum) {
    const upper = Number.isFinite(maximum) ? ` to ${maximum}` : " or greater";
    throw new Error(`${name} must be an integer from ${minimum}${upper}`);
  }
  return selected;
}

function validTimestamp(value) {
  if (typeof value !== "string" && typeof value !== "number") return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function cleanMetadata(value, maximum = 512) {
  if (typeof value !== "string") return null;
  const text = redactSecrets(stripVTControlCharacters(value))
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .trim();
  if (!text) return null;
  return Array.from(text).slice(0, maximum).join("");
}

function displayProject(value, environment) {
  const project = cleanMetadata(value);
  if (!project) return null;
  const home = cleanMetadata(environment.HOME || os.homedir());
  if (!home) return project;
  const relative = path.relative(home, project);
  if (relative === "") return "~";
  if (relative !== ".." && !relative.startsWith(`..${path.sep}`) && !path.isAbsolute(relative)) {
    return `~/${relative.split(path.sep).join("/")}`;
  }
  return project;
}

async function readCompletePrefix(file, maximum) {
  const handle = await open(file, "r");
  try {
    const buffer = Buffer.alloc(maximum);
    const { bytesRead } = await handle.read(buffer, 0, maximum, 0);
    let text = buffer.subarray(0, bytesRead).toString("utf8");
    if (bytesRead === maximum && !text.endsWith("\n")) {
      const lastNewline = text.lastIndexOf("\n");
      text = lastNewline === -1 ? "" : text.slice(0, lastNewline + 1);
    }
    return text.split(/\r?\n/u);
  } finally {
    await handle.close();
  }
}

async function summarizeSession(provider, file, environment, maximum) {
  const summary = { createdAt: null, project: null, branch: null, preview: null };
  let lines;
  try {
    lines = await readCompletePrefix(file, maximum);
  } catch {
    return summary;
  }

  for (const line of lines) {
    if (!line.trim()) continue;
    let record;
    try {
      record = JSON.parse(line);
    } catch {
      continue;
    }
    if (!record || typeof record !== "object" || Array.isArray(record)) continue;

    const timestamp = validTimestamp(record.timestamp ?? record.payload?.timestamp);
    if (timestamp && (!summary.createdAt || timestamp < summary.createdAt)) {
      summary.createdAt = timestamp;
    }

    if (provider === "codex" && record.type === "session_meta") {
      summary.project ??= displayProject(record.payload?.cwd, environment);
      summary.branch ??= cleanMetadata(record.payload?.git?.branch, 160);
    }
    if (provider === "claude") {
      summary.project ??= displayProject(record.cwd, environment);
      summary.branch ??= cleanMetadata(record.gitBranch, 160);
    }

    const markdown = visibleUserMarkdown(provider, record);
    if (markdown) summary.preview ??= createMessagePreview(markdown);
    if (summary.preview && summary.project) break;
  }
  return summary;
}

async function sessionCandidates(provider, environment) {
  const files = await discoverSessionFiles(provider, { environment });
  const matchesById = new Map();
  for (const file of files) {
    for (const id of new Set(sessionIdsInFileName(file))) {
      const matches = matchesById.get(id) ?? [];
      matches.push(file);
      matchesById.set(id, matches);
    }
  }

  const canonicalById = new Map();
  for (const file of files) {
    const id = canonicalSessionId(provider, file);
    if (!id) continue;
    const matches = canonicalById.get(id) ?? [];
    matches.push(file);
    canonicalById.set(id, matches);
  }

  let skippedAmbiguous = 0;
  const unique = [];
  for (const [id, canonicalFiles] of canonicalById) {
    if (canonicalFiles.length !== 1 || matchesById.get(id)?.length !== 1) {
      skippedAmbiguous += 1;
      continue;
    }
    unique.push({ id, file: canonicalFiles[0] });
  }

  const withStats = await mapLimit(unique, 32, async (candidate) => {
    try {
      const details = await stat(candidate.file);
      return details.isFile() ? { ...candidate, details } : null;
    } catch {
      return null;
    }
  });
  return {
    candidates: withStats.filter(Boolean),
    skippedAmbiguous,
  };
}

export async function listSessions(provider, options = {}) {
  if (provider !== "codex" && provider !== "claude") {
    throw new Error("Session provider must be codex or claude");
  }
  const limit = boundedInteger(
    "limit",
    options.limit,
    DEFAULT_SESSION_PAGE_SIZE,
    1,
    MAX_SESSION_PAGE_SIZE,
  );
  const offset = boundedInteger("offset", options.offset, 0, 0, Number.MAX_SAFE_INTEGER);
  const maximum = boundedInteger(
    "maxSummaryBytes",
    options.maxSummaryBytes,
    DEFAULT_SESSION_SUMMARY_BYTES,
    1,
    16 * 1024 * 1024,
  );
  const environment = options.environment ?? process.env;
  const { candidates, skippedAmbiguous } = await sessionCandidates(provider, environment);
  candidates.sort((left, right) => {
    const timeOrder = right.details.mtimeMs - left.details.mtimeMs;
    if (timeOrder !== 0) return timeOrder;
    return left.id < right.id ? -1 : left.id > right.id ? 1 : 0;
  });

  const selected = candidates.slice(offset, offset + limit);
  const sessions = await mapLimit(selected, 8, async ({ id, file, details }) => ({
    id,
    ...(await summarizeSession(provider, file, environment, maximum)),
    updatedAt: details.mtime.toISOString(),
    sizeBytes: details.size,
  }));
  const hasMore = offset + sessions.length < candidates.length;
  return {
    provider,
    sessions,
    total: candidates.length,
    skippedAmbiguous,
    hasMore,
    nextOffset: hasMore ? offset + sessions.length : null,
  };
}
