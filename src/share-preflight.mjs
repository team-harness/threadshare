import { getEntryProvenance } from "./session-export.mjs";
import { CHAT_SHARE_MAX_BYTES } from "./share-read.mjs";

const ENTRY_KINDS = ["message", "tool", "thought", "todo", "activity", "compaction"];

function countRedactionMarkers(value, seen = new WeakSet()) {
  if (typeof value === "string") return value.split("[REDACTED]").length - 1;
  if (value === null || typeof value !== "object" || seen.has(value)) return 0;
  seen.add(value);
  const values = Array.isArray(value) ? value : Object.values(value);
  return values.reduce((total, item) => total + countRedactionMarkers(item, seen), 0);
}

function summarizeHistory(history, bytes) {
  const entryKinds = Object.fromEntries(ENTRY_KINDS.map((kind) => [kind, 0]));
  const messageRoles = { user: 0, assistant: 0 };
  const userTurns = new Set();
  for (const entry of history.entries) {
    entryKinds[entry.kind] += 1;
    if (entry.kind !== "message") continue;
    messageRoles[entry.role] += 1;
    if (entry.role !== "user") continue;
    const provenance = getEntryProvenance(entry);
    userTurns.add(
      provenance?.recordIndex === undefined
        ? `entry:${entry.id}`
        : `record:${provenance.recordIndex}`,
    );
  }
  return {
    bytes,
    limitBytes: CHAT_SHARE_MAX_BYTES,
    entries: history.entries.length,
    entryKinds,
    messageRoles,
    userTurns: userTurns.size,
    redactionMarkers: countRedactionMarkers(history),
  };
}

export function createPreflightResult(
  history,
  { expiresInSeconds, includeReport = false, revoke = false } = {},
) {
  const bytes = new TextEncoder().encode(JSON.stringify(history)).byteLength;
  const valid = bytes <= CHAT_SHARE_MAX_BYTES;
  return {
    dryRun: true,
    valid,
    intent: { expiresInSeconds: expiresInSeconds ?? null, revoke },
    ...(valid ? {} : { error: "History exceeds the 5 MiB limit" }),
    ...(includeReport ? { report: summarizeHistory(history, bytes) } : {}),
  };
}

export function formatPreflightResult(result) {
  const lines = [
    result.valid
      ? "Dry run: valid. No data was uploaded."
      : `Dry run: invalid (${result.error}). No data was uploaded.`,
    result.intent.expiresInSeconds === null
      ? "Expiration: permanent"
      : `Expiration: ${result.intent.expiresInSeconds} seconds`,
    `Revocation: ${result.intent.revoke ? "requested" : "not requested"}`,
  ];
  if (result.report) {
    const kinds = result.report.entryKinds;
    lines.push(
      `Bytes: ${result.report.bytes} / ${result.report.limitBytes}`,
      `Entries: ${result.report.entries} (message ${kinds.message}, tool ${kinds.tool}, thought ${kinds.thought}, todo ${kinds.todo}, activity ${kinds.activity}, compaction ${kinds.compaction})`,
      `Message roles: user ${result.report.messageRoles.user}, assistant ${result.report.messageRoles.assistant}`,
      `User turns: ${result.report.userTurns}`,
      `Redaction markers: ${result.report.redactionMarkers}`,
    );
  }
  return `${lines.join("\n")}\n`;
}
