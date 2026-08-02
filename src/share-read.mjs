import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";

export const CHAT_SHARE_MAX_BYTES = 5 * 1024 * 1024;

const historySchema = JSON.parse(
  readFileSync(new URL("../schema/threadshare-history.v1.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateCanonicalHistory = ajv.compile(historySchema);

function looksLikeLegacyPaseoHistory(value) {
  return (
    value !== null &&
    typeof value === "object" &&
    !Array.isArray(value) &&
    !Object.hasOwn(value, "format") &&
    value.schemaVersion === 1 &&
    typeof value.exportedAt === "string" &&
    value.conversation !== null &&
    typeof value.conversation === "object" &&
    !Array.isArray(value.conversation) &&
    Array.isArray(value.entries)
  );
}

function validationLocation(instancePath) {
  if (!instancePath) return "document root";
  const segments = instancePath
    .slice(1)
    .split("/")
    .map((segment) => segment.replaceAll("~1", "/").replaceAll("~0", "~"));
  return `field ${segments.join(".")}`;
}

export function validateHistory(history) {
  if (validateCanonicalHistory(history)) return history;
  const issue = validateCanonicalHistory.errors?.[0];
  const detail = issue
    ? ` at ${validationLocation(issue.instancePath)}: ${issue.message}`
    : "";
  throw new Error(`Input is not a valid threadshare-history@v1 document${detail}`);
}

function responseIsDeclaredTooLarge(contentLength) {
  return /^\d+$/.test(contentLength ?? "") && Number(contentLength) > CHAT_SHARE_MAX_BYTES;
}

async function readBoundedResponseBody(response) {
  if (responseIsDeclaredTooLarge(response.headers.get("content-length"))) {
    throw new Error("Threadshare response exceeds the 5 MiB limit");
  }
  if (!response.body) return "";

  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  const chunks = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > CHAT_SHARE_MAX_BYTES) {
        throw new Error("Threadshare response exceeds the 5 MiB limit");
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
    return chunks.join("");
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }
}

export async function readSharedHistory(reference, { fetchImpl = fetch } = {}) {
  let response;
  try {
    response = await fetchImpl(reference.apiUrl, {
      headers: { accept: "application/json" },
      redirect: "error",
    });
  } catch (error) {
    const detail = error instanceof Error && error.message ? `: ${error.message}` : "";
    throw new Error(`Threadshare read request failed${detail}`);
  }
  if (!response.ok) {
    throw new Error(`Threadshare read failed with HTTP ${response.status}`);
  }

  const raw = await readBoundedResponseBody(response);
  let history;
  try {
    history = JSON.parse(raw);
  } catch {
    throw new Error("Threadshare did not return valid JSON");
  }
  if (looksLikeLegacyPaseoHistory(history)) {
    throw new Error(
      "Threadshare read does not accept a legacy Paseo history; republish it with a current Threadshare producer",
    );
  }
  return validateHistory(history);
}

function entryMetadata(entry, details = []) {
  return `_${[`ID: ${entry.id}`, `Created: ${entry.createdAt}`, ...details].join(" · ")}_`;
}

function indentedJson(value) {
  return JSON.stringify(value, null, 2)
    .split("\n")
    .map((line) => `    ${line}`)
    .join("\n");
}

function formatEntry(entry) {
  if (entry.kind === "message") {
    const label = entry.role === "user" ? "User" : "Assistant";
    return [`## ${label}`, entryMetadata(entry, [`Role: ${entry.role}`]), entry.markdown].join(
      "\n\n",
    );
  }
  if (entry.kind === "tool") {
    const sections = [
      `## Tool: ${entry.name}`,
      entryMetadata(entry, [`Status: ${entry.status}`]),
    ];
    for (const field of ["input", "output", "error"]) {
      if (!Object.hasOwn(entry, field)) continue;
      sections.push(`### ${field[0].toUpperCase()}${field.slice(1)}`, indentedJson(entry[field]));
    }
    return sections.join("\n\n");
  }
  if (entry.kind === "thought") {
    return [
      "## Thought",
      entryMetadata(entry, [`Status: ${entry.status}`]),
      entry.text,
    ].join("\n\n");
  }
  if (entry.kind === "todo") {
    const items = entry.items
      .map(
        (item) =>
          `- [${item.completed ? "x" : " "}] ${item.text.replaceAll("\n", "\n  ")}`,
      )
      .join("\n");
    return ["## Todo", entryMetadata(entry), items].join("\n\n");
  }
  if (entry.kind === "activity") {
    return [
      "## Activity",
      entryMetadata(entry, [`Level: ${entry.level}`]),
      entry.message,
    ].join("\n\n");
  }
  const details = [`Status: ${entry.status}`];
  if (entry.trigger !== undefined) details.push(`Trigger: ${entry.trigger}`);
  if (entry.preTokens !== undefined) details.push(`Pre-compaction tokens: ${entry.preTokens}`);
  return ["## Compaction", entryMetadata(entry, details)].join("\n\n");
}

export function formatHistoryAsMarkdown(history) {
  const metadata = [
    `- Conversation ID: ${history.conversation.id}`,
    `- Format: ${history.format}`,
    `- Schema version: ${history.schemaVersion}`,
    `- Exported: ${history.exportedAt}`,
  ];
  for (const field of ["provider", "model", "source"]) {
    const value = history.conversation[field];
    if (value !== undefined) {
      metadata.push(`- ${field[0].toUpperCase()}${field.slice(1)}: ${value}`);
    }
  }
  const sections = [`# ${history.conversation.title}`, metadata.join("\n")];
  if (history.entries.length > 0) {
    sections.push(history.entries.map(formatEntry).join("\n\n---\n\n"));
  }
  return `${sections.join("\n\n")}\n`;
}
