import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open, realpath } from "node:fs/promises";
import path from "node:path";

const MAX_INTENT_SOURCE_BYTES = 1024 * 1024;
const EXPLICIT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/u;
const SESSION_KEY_PATTERN = /^[0-9a-f]{64}$/u;
const COMMIT_ID_PATTERN = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const CHECKLIST_PATTERN = /^( *)(?:- \[([ xX])\] )(.*)$/u;
const REFERENCE_PATTERN = /\{(session|commit|spec|issue):([^{}\s]+)\}/gu;
const REFERENCE_LIKE_PATTERN = /\{(?:session|commit|spec|issue):[^{}]*\}/gu;
const EXPLICIT_ID_TOKEN_PATTERN = /\{#([^{}\s]+)\}/gu;

function intentError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function validLocator(value) {
  return typeof value === "string" && value !== "" && value.length <= 4096 &&
    !path.isAbsolute(value) && !value.split(/[\\/]/u).includes("..");
}

function validReference(kind, value) {
  if (kind === "session") return SESSION_KEY_PATTERN.test(value);
  if (kind === "commit") return COMMIT_ID_PATTERN.test(value);
  if (kind === "spec") return validLocator(value);
  return kind === "issue" && value.length <= 4096 && !/[\0\r\n]/u.test(value);
}

function generatedId(locator, line, title) {
  return `generated-${createHash("sha256")
    .update(`${locator}\0${line}\0${title}`, "utf8")
    .digest("hex")
    .slice(0, 32)}`;
}

function sourceRevision(raw) {
  return createHash("sha256").update(raw, "utf8").digest("hex");
}

function diagnostic(line, code) {
  return Object.freeze({ line: String(line), code });
}

export function parseMarkdownIntentSource(raw, options) {
  if (typeof raw !== "string" || Buffer.byteLength(raw, "utf8") > MAX_INTENT_SOURCE_BYTES ||
      !validLocator(options?.locator) ||
      typeof options?.repositoryId !== "string" ||
      typeof options?.privacyContext?.fingerprint !== "function") {
    throw intentError("TS_INSIGHTS_INTENT_SOURCE_INVALID", "Intent source is invalid");
  }
  const nodes = [];
  const refs = [];
  const diagnostics = [];
  const explicitIds = new Set();
  const stack = [];
  const lines = raw.replaceAll("\r\n", "\n").replaceAll("\r", "\n").split("\n");

  for (let index = 0; index < lines.length; index += 1) {
    const lineNumber = index + 1;
    const line = lines[index];
    if (line.includes("\t")) {
      if (/^\s*- \[[ xX]\] /u.test(line)) {
        diagnostics.push(diagnostic(lineNumber, "TS_INSIGHTS_INTENT_INDENT_INVALID"));
      }
      continue;
    }
    const match = CHECKLIST_PATTERN.exec(line);
    if (!match) continue;
    const indentation = match[1].length;
    if (indentation % 2 !== 0) {
      diagnostics.push(diagnostic(lineNumber, "TS_INSIGHTS_INTENT_INDENT_INVALID"));
      continue;
    }
    const level = indentation / 2;
    if (level > stack.length || (level > 0 && stack[level - 1] === undefined)) {
      diagnostics.push(diagnostic(lineNumber, "TS_INSIGHTS_INTENT_INDENT_INVALID"));
      continue;
    }
    const body = match[3];
    const ids = [...body.matchAll(EXPLICIT_ID_TOKEN_PATTERN)];
    if (ids.length > 1 || ids.some((entry) => !EXPLICIT_ID_PATTERN.test(entry[1]))) {
      diagnostics.push(diagnostic(lineNumber, "TS_INSIGHTS_INTENT_ID_INVALID"));
      continue;
    }
    const stableId = ids.length === 1;
    const id = stableId ? ids[0][1] : generatedId(options.locator, lineNumber, body);
    if (stableId && explicitIds.has(id)) {
      throw intentError(
        "TS_INSIGHTS_INTENT_DUPLICATE_ID",
        "Intent source contains a duplicate explicit ID",
      );
    }
    if (stableId) explicitIds.add(id);

    const matchedReferenceTokens = new Set();
    for (const reference of body.matchAll(REFERENCE_PATTERN)) {
      matchedReferenceTokens.add(reference[0]);
      if (!validReference(reference[1], reference[2])) {
        diagnostics.push(diagnostic(lineNumber, "TS_INSIGHTS_INTENT_REF_INVALID"));
        continue;
      }
      refs.push(Object.freeze({ nodeId: id, kind: reference[1], value: reference[2] }));
    }
    for (const token of body.match(REFERENCE_LIKE_PATTERN) ?? []) {
      if (!matchedReferenceTokens.has(token)) {
        diagnostics.push(diagnostic(lineNumber, "TS_INSIGHTS_INTENT_REF_INVALID"));
      }
    }
    const title = body
      .replace(EXPLICIT_ID_TOKEN_PATTERN, "")
      .replace(REFERENCE_LIKE_PATTERN, "")
      .replaceAll(/\s+/gu, " ")
      .trim();
    if (title === "") {
      diagnostics.push(diagnostic(lineNumber, "TS_INSIGHTS_INTENT_TITLE_INVALID"));
      continue;
    }
    const parentId = level === 0 ? null : stack[level - 1];
    nodes.push({
      id,
      parentId,
      kind: "story",
      title,
      status: match[2].toLowerCase() === "x" ? "complete" : "todo",
      stableId,
    });
    stack[level] = id;
    stack.length = level + 1;
  }

  const parentIds = new Set(nodes.map(({ parentId }) => parentId).filter(Boolean));
  const normalizedNodes = nodes.map((node) => Object.freeze({
    ...node,
    kind: parentIds.has(node.id) ? "feature" : "story",
  }));
  const locator = options.locator.replaceAll("\\", "/");
  return Object.freeze({
    sourceKey: options.privacyContext.fingerprint(
      "intent-source",
      `${options.repositoryId}\0${locator}`,
    ),
    adapterVersion: "markdown-checklist@1",
    revision: sourceRevision(raw),
    locator,
    coverage: diagnostics.length === 0 ? "complete" : "partial",
    nodes: Object.freeze(normalizedNodes),
    refs: Object.freeze(refs),
    diagnostics: Object.freeze(diagnostics),
  });
}

export async function readMarkdownIntentSource(registration, options = {}) {
  const locator = registration?.intentPath;
  if (!validLocator(locator)) {
    throw intentError("TS_INSIGHTS_INTENT_SOURCE_INVALID", "Intent source locator is invalid");
  }
  try {
    const root = await realpath(registration.rootDirectory);
    const target = await realpath(path.resolve(root, locator));
    if (target !== root && !target.startsWith(`${root}${path.sep}`)) {
      throw intentError("TS_INSIGHTS_INTENT_SOURCE_INVALID", "Intent source is outside the repository");
    }
    const handle = await open(target, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
    try {
      const before = await handle.stat({ bigint: true });
      if (!before.isFile() || before.size === 0n || before.size > BigInt(MAX_INTENT_SOURCE_BYTES)) {
        throw intentError("TS_INSIGHTS_INTENT_SOURCE_INVALID", "Intent source is invalid");
      }
      const raw = await handle.readFile({ encoding: "utf8" });
      const after = await handle.stat({ bigint: true });
      if (before.dev !== after.dev || before.ino !== after.ino || before.size !== after.size ||
          before.mtimeNs !== after.mtimeNs) {
        throw intentError("TS_INSIGHTS_INTENT_SOURCE_CHANGED", "Intent source changed during sync");
      }
      return parseMarkdownIntentSource(raw, {
        locator: locator.replaceAll("\\", "/"),
        repositoryId: registration.repositoryId,
        privacyContext: options.privacyContext,
      });
    } finally {
      await handle.close();
    }
  } catch (error) {
    if (error?.code?.startsWith?.("TS_INSIGHTS_INTENT_")) throw error;
    if (error?.code === "ENOENT") {
      const locator = registration.intentPath.replaceAll("\\", "/");
      return Object.freeze({
        sourceKey: options.privacyContext.fingerprint(
          "intent-source",
          `${registration.repositoryId}\0${locator}`,
        ),
        adapterVersion: "markdown-checklist@1",
        revision: sourceRevision(`unavailable\0${locator}`),
        locator,
        coverage: "unavailable",
        nodes: Object.freeze([]),
        refs: Object.freeze([]),
        diagnostics: Object.freeze([
          Object.freeze({ line: "0", code: "TS_INSIGHTS_INTENT_SOURCE_UNAVAILABLE" }),
        ]),
      });
    }
    throw intentError("TS_INSIGHTS_INTENT_SOURCE_INVALID", "Intent source is unavailable");
  }
}
