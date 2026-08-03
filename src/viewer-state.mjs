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
