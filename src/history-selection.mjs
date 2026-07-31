import { stripVTControlCharacters } from "node:util";
import { getEntryProvenance, redactSecrets } from "./session-export.mjs";

export const DEFAULT_MESSAGE_PAGE_SIZE = 10;
export const MAX_MESSAGE_PAGE_SIZE = 50;

const USER_HOME_PATHS = [
  /\/(?:Users|home)\/[^/\s]+(?:\/[^\s"'`<>]*)*/gu,
  /\b[A-Za-z]:[\\/](?:Users|Documents and Settings)[\\/][^\\/\s]+(?:[\\/][^\s"'`<>]*)*/gu,
];

function requireProvenance(entry) {
  const provenance = getEntryProvenance(entry);
  if (!provenance || !Number.isInteger(provenance.recordIndex)) {
    throw new Error("Session entry provenance is unavailable; refusing a ranged export");
  }
  return provenance;
}

function validatePageNumber(name, value, minimum, maximum) {
  if (!Number.isInteger(value) || value < minimum || value > maximum) {
    const upper = Number.isFinite(maximum) ? ` to ${maximum}` : " or greater";
    throw new Error(`${name} must be an integer from ${minimum}${upper}`);
  }
}

function messageIdOption(options, name) {
  const value = options[name];
  if (value === undefined) return undefined;
  if (value === "") throw new Error(`--${name} must not be empty`);
  if (typeof value !== "string") throw new Error(`--${name} must be a string`);
  return value;
}

export function createMessagePreview(value, maximum = 160) {
  let text = redactSecrets(stripVTControlCharacters(String(value)));
  for (const pattern of USER_HOME_PATHS) text = text.replace(pattern, "[LOCAL_PATH]");
  text = text
    .replace(/(^|[\s([{"'`])~[\\/][^\s"'`<>]*/gu, "$1[LOCAL_PATH]")
    .replace(
      /[\u0000-\u001f\u007f-\u009f\u200e\u200f\u2028-\u202e\u2066-\u2069\ufeff]/gu,
      " ",
    )
    .replace(/\s+/gu, " ")
    .trim();
  const codePoints = Array.from(text);
  if (codePoints.length <= maximum) return text;
  return `${codePoints.slice(0, Math.max(0, maximum - 3)).join("")}...`;
}

function userTurns(history) {
  const turnsByRecord = new Map();
  for (const entry of history.entries) {
    if (entry.kind !== "message" || entry.role !== "user") continue;
    const { recordIndex } = requireProvenance(entry);
    const turn = turnsByRecord.get(recordIndex) ?? { recordIndex, entries: [] };
    turn.entries.push(entry);
    turnsByRecord.set(recordIndex, turn);
  }
  return [...turnsByRecord.values()].sort((left, right) => left.recordIndex - right.recordIndex);
}

function turnCandidate(turn) {
  const first = turn.entries[0];
  return {
    id: first.id,
    createdAt: first.createdAt,
    preview: createMessagePreview(turn.entries.map((entry) => entry.markdown).join("\n\n")),
  };
}

function resolveUserTurn(history, turns, id, option) {
  const matches = history.entries.filter((entry) => entry.id === id);
  if (matches.length === 0) throw new Error(`No user message matches ${option} ${id}`);
  if (matches.length > 1) throw new Error(`${option} ${id} matches multiple entries`);
  const [entry] = matches;
  if (entry.kind !== "message" || entry.role !== "user") {
    throw new Error(`${option} ${id} is not a user message`);
  }
  const { recordIndex } = requireProvenance(entry);
  const turn = turns.find((candidate) => candidate.recordIndex === recordIndex);
  if (!turn) throw new Error(`${option} ${id} is not a visible user turn`);
  return turn;
}

function paginateTurns(turns, offset, limit) {
  const messages = turns.slice(offset, offset + limit).map(turnCandidate);
  const hasMore = offset + messages.length < turns.length;
  return {
    messages,
    hasMore,
    nextOffset: hasMore ? offset + messages.length : null,
  };
}

function pageOptions(options) {
  const limit = options.limit ?? DEFAULT_MESSAGE_PAGE_SIZE;
  const offset = options.offset ?? 0;
  validatePageNumber("limit", limit, 1, MAX_MESSAGE_PAGE_SIZE);
  validatePageNumber("offset", offset, 0, Number.POSITIVE_INFINITY);
  return { limit, offset };
}

export function listUserMessagePage(history, options = {}) {
  const turns = userTurns(history);
  if (turns.length === 0) throw new Error("No visible user messages are available in this session");
  const beforeOption = messageIdOption(options, "before");
  const boundary = beforeOption !== undefined
    ? resolveUserTurn(history, turns, beforeOption, "--before")
    : turns.at(-1);
  const eligible = turns
    .filter((turn) => turn.recordIndex < boundary.recordIndex)
    .reverse();
  const { limit, offset } = pageOptions(options);
  const page = paginateTurns(eligible, offset, limit);
  return {
    boundaryId: boundary.entries[0].id,
    boundaryPreview: turnCandidate(boundary).preview,
    ...page,
  };
}

export function listStartMessagePage(history, options = {}) {
  const turns = userTurns(history);
  if (turns.length === 0) throw new Error("No visible user messages are available in this session");
  const { limit, offset } = pageOptions(options);
  return paginateTurns([...turns].reverse(), offset, limit);
}

function toolAtBoundary(entry, endRecordIndex) {
  const provenance = requireProvenance(entry);
  const result = provenance.toolResults
    .filter((candidate) => candidate.recordIndex < endRecordIndex)
    .at(-1);
  const selected = {
    ...entry,
    status: result ? (result.failed ? "failed" : "completed") : "running",
  };
  delete selected.output;
  delete selected.error;
  if (result?.failed) selected.error = result.value;
  else if (result) selected.output = result.value;
  return selected;
}

export function selectHistoryRange(history, options = {}) {
  const fromOption = messageIdOption(options, "from");
  const beforeOption = messageIdOption(options, "before");
  if (fromOption === undefined && beforeOption === undefined) return history;
  for (const entry of history.entries) requireProvenance(entry);

  const turns = userTurns(history);
  const before = beforeOption !== undefined
    ? resolveUserTurn(history, turns, beforeOption, "--before")
    : undefined;
  const endRecordIndex = before?.recordIndex ?? Number.POSITIVE_INFINITY;
  let from;
  if (fromOption === "last-user") {
    from = turns.filter((turn) => turn.recordIndex < endRecordIndex).at(-1);
    if (!from) throw new Error("No user message exists before the selected boundary");
  } else if (fromOption !== undefined) {
    from = resolveUserTurn(history, turns, fromOption, "--from");
  }

  if (from && before && from.recordIndex === before.recordIndex) {
    throw new Error("--from and --before identify the same user turn");
  }
  if (from && from.recordIndex > endRecordIndex) {
    throw new Error("--from must be before --before");
  }

  const startRecordIndex = from?.recordIndex ?? Number.NEGATIVE_INFINITY;
  const entries = history.entries
    .filter((entry) => {
      const { recordIndex } = requireProvenance(entry);
      return recordIndex >= startRecordIndex && recordIndex < endRecordIndex;
    })
    .map((entry) =>
      entry.kind === "tool" ? toolAtBoundary(entry, endRecordIndex) : entry,
    );
  if (entries.length === 0) throw new Error("The selected conversation range is empty");
  return { ...history, entries };
}
