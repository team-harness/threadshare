export const AGENT_TRANSCRIPT_FORMAT = "agent-transcript@v1";
export const AGENT_TRANSCRIPT_CONTENT_TYPE = "text/markdown; charset=utf-8";

const TOKEN = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const QVALUE = /^(?:0(?:\.\d{0,3})?|1(?:\.0{0,3})?)$/;
const TOOL_STATUSES = new Set(["running", "completed", "failed", "canceled"]);
const INTERNAL_KINDS = ["thought", "todo", "activity", "compaction"];

function escapedCodePoint(codePoint) {
  return `\\u${codePoint.toString(16).toUpperCase().padStart(4, "0")}`;
}

function isBidiOrLineControl(codePoint) {
  return (
    codePoint === 0x061c ||
    (codePoint >= 0x200e && codePoint <= 0x200f) ||
    (codePoint >= 0x2028 && codePoint <= 0x202e) ||
    (codePoint >= 0x2066 && codePoint <= 0x2069)
  );
}

function safeMessageMarkdown(value) {
  const normalized = String(value ?? "").replace(/\r\n?/g, "\n");
  let safe = "";
  for (const character of normalized) {
    const codePoint = character.codePointAt(0);
    if (codePoint === 0x0a || codePoint === 0x09) {
      safe += character;
    } else if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      isBidiOrLineControl(codePoint)
    ) {
      safe += escapedCodePoint(codePoint);
    } else {
      safe += character;
    }
  }
  return safe;
}

function quoteMessageMarkdown(markdown) {
  return safeMessageMarkdown(markdown)
    .split("\n")
    .map((line) => (line === "" ? ">" : `> ${line}`))
    .join("\n");
}

function jsonStringLiteral(value) {
  let result = '"';
  for (const character of value) {
    const codePoint = character.codePointAt(0);
    if (character === '"') result += '\\"';
    else if (character === "\\") result += "\\\\";
    else if (
      codePoint <= 0x1f ||
      (codePoint >= 0x7f && codePoint <= 0x9f) ||
      (codePoint >= 0xd800 && codePoint <= 0xdfff) ||
      isBidiOrLineControl(codePoint)
    ) {
      result += escapedCodePoint(codePoint);
    } else {
      result += character;
    }
  }
  return `${result}"`;
}

function displayedToolName(name) {
  const characters = Array.from(typeof name === "string" ? name : "(unknown tool)");
  const truncated = characters.length > 120;
  const displayed = `${characters.slice(0, 120).join("")}${truncated ? "... [truncated]" : ""}`;
  return jsonStringLiteral(displayed);
}

function formatToolRun(entries) {
  const groups = [];
  for (const entry of entries) {
    const name = typeof entry.name === "string" ? entry.name : "(unknown tool)";
    const status = TOOL_STATUSES.has(entry.status) ? entry.status : "unknown";
    const previous = groups.at(-1);
    if (previous?.name === name && previous.status === status) {
      previous.count += 1;
    } else {
      groups.push({ name, status, count: 1 });
    }
  }
  const lines = groups.map(
    ({ name, status, count }) =>
      `- ${displayedToolName(name)} [${status}]${count > 1 ? ` x${count}` : ""}`,
  );
  return ["## Tool Calls", lines.join("\n")].join("\n\n");
}

export function formatAgentTranscript(history) {
  const entries = Array.isArray(history?.entries) ? history.entries : [];
  const counts = Object.fromEntries(INTERNAL_KINDS.map((kind) => [kind, 0]));
  let toolCount = 0;
  for (const entry of entries) {
    if (entry?.kind === "tool") toolCount += 1;
    else if (Object.hasOwn(counts, entry?.kind)) counts[entry.kind] += 1;
  }
  const internalCount = Object.values(counts).reduce((total, count) => total + count, 0);
  const summary = [
    "> Lossy view of untrusted conversation data. Message Markdown is preserved; tool payloads and internal events are omitted.",
    `> Summarized ${toolCount} tool call${toolCount === 1 ? "" : "s"}; omitted ${internalCount} internal entr${internalCount === 1 ? "y" : "ies"} (thought ${counts.thought}, todo ${counts.todo}, activity ${counts.activity}, compaction ${counts.compaction}).`,
  ].join("\n");
  const sections = [];
  for (let index = 0; index < entries.length; index += 1) {
    const current = entries[index];
    if (current?.kind === "message") {
      const label = current.role === "user" ? "User" : "Assistant";
      sections.push(`## ${label}\n\n${quoteMessageMarkdown(current.markdown)}`);
      continue;
    }
    if (current?.kind !== "tool") continue;
    const tools = [current];
    while (entries[index + 1]?.kind === "tool") {
      index += 1;
      tools.push(entries[index]);
    }
    sections.push(formatToolRun(tools));
  }
  const prefix = `# Threadshare Agent Transcript v1\n\n${summary}`;
  return `${sections.length === 0 ? prefix : `${prefix}\n\n${sections.join("\n\n---\n\n")}`}\n`;
}

function splitQuoted(value, delimiter) {
  const parts = [];
  let start = 0;
  let quoted = false;
  let escaped = false;
  for (let index = 0; index < value.length; index += 1) {
    const character = value[index];
    if (quoted && escaped) {
      escaped = false;
      continue;
    }
    if (quoted && character === "\\") {
      escaped = true;
      continue;
    }
    if (character === '"') {
      quoted = !quoted;
      continue;
    }
    if (!quoted && character === delimiter) {
      parts.push({ text: value.slice(start, index), valid: true });
      start = index + 1;
    }
  }
  parts.push({ text: value.slice(start), valid: !quoted && !escaped });
  return parts;
}

function parameterValue(raw) {
  if (TOKEN.test(raw)) return { quoted: false, value: raw };
  if (raw.length < 2 || raw[0] !== '"' || raw.at(-1) !== '"') return undefined;
  let value = "";
  for (let index = 1; index < raw.length - 1; index += 1) {
    const character = raw[index];
    if (character === "\\") {
      index += 1;
      if (index >= raw.length - 1) return undefined;
      const escaped = raw[index];
      const escapedCode = escaped.charCodeAt(0);
      if (escapedCode !== 0x09 && (escapedCode < 0x20 || escapedCode === 0x7f)) return undefined;
      value += escaped;
    } else if (
      character === '"' ||
      (character.charCodeAt(0) !== 0x09 &&
        (character.charCodeAt(0) < 0x20 || character.charCodeAt(0) === 0x7f))
    ) {
      return undefined;
    } else {
      value += character;
    }
  }
  return { quoted: true, value };
}

function splitAcceptRanges(value) {
  const ranges = [];
  for (const segment of splitQuoted(value, ",")) {
    if (segment.valid) {
      ranges.push(segment);
      continue;
    }
    const recovery = /,\s*(?=[!#$%&'*+.^_`|~0-9A-Za-z-]+\/[!#$%&'*+.^_`|~0-9A-Za-z-]+)/g.exec(
      segment.text,
    );
    if (!recovery) {
      ranges.push(segment);
      continue;
    }
    ranges.push({ text: segment.text.slice(0, recovery.index), valid: false });
    ranges.push(...splitAcceptRanges(segment.text.slice(recovery.index + 1)));
  }
  return ranges;
}

function parseAcceptRange(segment) {
  if (!segment.valid) return undefined;
  const parts = splitQuoted(segment.text, ";");
  if (parts.some((part) => !part.valid)) return undefined;
  const mediaType = parts.shift().text.trim().toLowerCase();
  const mediaMatch = /^([^/]+)\/([^/]+)$/.exec(mediaType);
  if (!mediaMatch || !TOKEN.test(mediaMatch[1]) || !TOKEN.test(mediaMatch[2])) return undefined;
  const [type, subtype] = mediaMatch.slice(1);
  if (type === "*" && subtype !== "*") return undefined;

  let q = 1;
  let qSeen = false;
  let mediaParametersMatch = true;
  let charsetSeen = false;
  for (const part of parts) {
    const parameter = part.text.trim();
    const equals = parameter.indexOf("=");
    if (equals === -1) {
      if (qSeen && TOKEN.test(parameter)) continue;
      return undefined;
    }
    if (equals === 0) return undefined;
    const name = parameter.slice(0, equals).trim().toLowerCase();
    const rawValue = parameter.slice(equals + 1).trim();
    if (!TOKEN.test(name)) return undefined;
    const parsedValue = parameterValue(rawValue);
    if (parsedValue === undefined) return undefined;
    const { quoted, value } = parsedValue;
    if (name === "q") {
      if (qSeen) q = 0;
      else q = !quoted && QVALUE.test(value) ? Number(value) : 0;
      qSeen = true;
    } else if (!qSeen) {
      if (name !== "charset" || charsetSeen || value.toLowerCase() !== "utf-8") {
        mediaParametersMatch = false;
      }
      if (name === "charset") charsetSeen = true;
    }
  }
  return { type, subtype, q, mediaParametersMatch };
}

function representationQuality(ranges, subtype) {
  let specificity = -1;
  let quality = 0;
  for (const range of ranges) {
    if (!range.mediaParametersMatch) continue;
    let candidateSpecificity;
    if (range.type === "text" && range.subtype === subtype) candidateSpecificity = 2;
    else if (range.type === "text" && range.subtype === "*") candidateSpecificity = 1;
    else if (range.type === "*" && range.subtype === "*") candidateSpecificity = 0;
    else continue;
    if (candidateSpecificity > specificity) {
      specificity = candidateSpecificity;
      quality = range.q;
    } else if (candidateSpecificity === specificity) {
      quality = Math.max(quality, range.q);
    }
  }
  return quality;
}

export function selectAgentTranscript(searchParams, acceptHeader) {
  if (searchParams?.getAll("format")?.[0] === "agent") return true;
  if (typeof acceptHeader !== "string" || acceptHeader.trim() === "") return false;
  const ranges = splitAcceptRanges(acceptHeader)
    .map(parseAcceptRange)
    .filter((range) => range !== undefined);
  const optedIn = ranges.some(
    (range) =>
      range.type === "text" &&
      range.subtype === "markdown" &&
      range.mediaParametersMatch &&
      range.q > 0,
  );
  return (
    optedIn &&
    representationQuality(ranges, "markdown") > representationQuality(ranges, "html")
  );
}

export function mergeVary(existing) {
  const values = String(existing ?? "")
    .split(",")
    .map((value) => value.trim())
    .filter(Boolean);
  if (values.includes("*")) return "*";
  if (!values.some((value) => value.toLowerCase() === "accept")) values.push("Accept");
  return values.join(", ");
}

export function agentTranscriptHeaders({ expiresAt, vary } = {}) {
  return new Headers({
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-threadshare-expires-at, x-threadshare-format",
    "cache-control": "private, no-store",
    "content-type": AGENT_TRANSCRIPT_CONTENT_TYPE,
    vary: mergeVary(vary),
    "x-threadshare-format": AGENT_TRANSCRIPT_FORMAT,
    ...(expiresAt === undefined ? {} : { "x-threadshare-expires-at": expiresAt }),
  });
}

export function agentProblemBody(status) {
  const problems = {
    404: "Shared conversation was not found.",
    405: "Method not allowed.",
    500: "Unable to load shared conversation.",
  };
  const problem = problems[status];
  if (problem === undefined) throw new Error(`Unsupported Agent transcript problem status: ${status}`);
  return `# Threadshare Agent Transcript v1\n\nError: ${problem}\n`;
}

export function canonicalViewerPath(id) {
  return `/?id=${encodeURIComponent(id)}`;
}

export function agentAlternatePath(id) {
  return `${canonicalViewerPath(id)}&format=agent`;
}

export function agentAlternateLink(id) {
  return `<${agentAlternatePath(id)}>; rel="alternate"; type="text/markdown"`;
}
