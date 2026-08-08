import markdownit from "markdown-it";

const markdownParser = markdownit({ html: false, linkify: true });

function normalizedText(value) {
  return String(value ?? "")
    .replace(/\s+/gu, " ")
    .trim();
}

function inlineTokenText(token) {
  if (Array.isArray(token.children)) return token.children.map(inlineTokenText).join(" ");
  if (token.type === "softbreak" || token.type === "hardbreak") return " ";
  if (["text", "code_inline"].includes(token.type)) return token.content;
  return "";
}

export function markdownPlainText(markdown) {
  const text = markdownParser
    .parse(String(markdown ?? ""), {})
    .map((token) => {
      if (token.type === "inline") return inlineTokenText(token);
      if (token.type === "fence" || token.type === "code_block") return token.content;
      return "";
    })
    .join(" ");
  return normalizedText(text);
}

function createTurn(user, entries) {
  let assistantIndex = -1;
  for (let index = 0; index < entries.length; index += 1) {
    const entry = entries[index];
    if (entry.kind === "message" && entry.role === "assistant") assistantIndex = index;
  }

  const processEntries = entries.filter((_, index) => index !== assistantIndex);
  const processCounts = {
    assistantMessages: 0,
    tools: 0,
    thoughts: 0,
    other: 0,
  };
  for (const entry of processEntries) {
    if (entry.kind === "message" && entry.role === "assistant") {
      processCounts.assistantMessages += 1;
    } else if (entry.kind === "tool") {
      processCounts.tools += 1;
    } else if (entry.kind === "thought") {
      processCounts.thoughts += 1;
    } else {
      processCounts.other += 1;
    }
  }

  return {
    user,
    entries,
    assistant: assistantIndex === -1 ? null : entries[assistantIndex],
    processEntries,
    processCounts,
  };
}

export function groupEntriesIntoTurns(entries) {
  const preamble = [];
  const turns = [];
  let user = null;
  let turnEntries = [];

  for (const entry of entries) {
    if (entry.kind === "message" && entry.role === "user") {
      if (user) turns.push(createTurn(user, turnEntries));
      user = entry;
      turnEntries = [];
    } else if (user) {
      turnEntries.push(entry);
    } else {
      preamble.push(entry);
    }
  }
  if (user) turns.push(createTurn(user, turnEntries));

  return { preamble, turns };
}

function truncatePreview(value, limit) {
  const characters = Array.from(value);
  if (characters.length <= limit) return value;
  if (limit <= 3) return ".".repeat(limit);
  return `${characters.slice(0, limit - 3).join("")}...`;
}

export function createTurnDirectory(entries, options = {}) {
  const previewLength =
    Number.isInteger(options.previewLength) && options.previewLength > 0
      ? options.previewLength
      : 96;

  return entries
    .filter((entry) => entry.kind === "message" && entry.role === "user")
    .map((entry, index) => ({
      id: entry.id,
      anchorId: `message-${entry.id}`,
      number: index + 1,
      preview: truncatePreview(markdownPlainText(entry.markdown) || "Empty message", previewLength),
    }));
}

export function findActiveTurnIndex(turnTops, options = {}) {
  if (turnTops.length === 0) return -1;
  if (options.atEnd) return turnTops.length - 1;

  const activationTop = Number.isFinite(options.activationTop) ? options.activationTop : 0;
  let activeIndex = 0;
  for (let index = 1; index < turnTops.length; index += 1) {
    if (turnTops[index] > activationTop) break;
    activeIndex = index;
  }
  return activeIndex;
}
