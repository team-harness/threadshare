// Sanitization lint for team memory text (design §4 "secret lint").
//
// `block` findings must keep content out of the git-tracked memory library;
// `warn` findings flag material a reviewer should confirm. Excerpts are always
// redacted (a short prefix plus the match length) so findings themselves never
// leak the detected secret.

import { parseMemoryEntry } from "./memory-format.mjs";

const HIGH_ENTROPY_MIN_LENGTH = 28;
const HIGH_ENTROPY_THRESHOLD_BITS = 4.0;
const HIGH_ENTROPY_TOKEN_PATTERN = /[A-Za-z0-9+/=_-]{28,}/g;
const GIT_HASH_HEX40_PATTERN = /^[0-9a-f]{40}$/;
const GIT_HASH_HEX64_PATTERN = /^[0-9a-f]{64}$/;

const UUID_V4_PATTERN =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/g;
const SESSION_CONTEXT_PATTERN = /session|agent/i;
const SESSION_CONTEXT_WINDOW = 48;

const BLOCK_PATTERN_RULES = [
  { code: "MEMORY_LINT_AWS_ACCESS_KEY", pattern: /(?<![A-Za-z0-9])AKIA[0-9A-Z]{16}/g },
  {
    code: "MEMORY_LINT_GITHUB_TOKEN",
    pattern: /(?<![A-Za-z0-9])(?:gh[pos]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g,
  },
  { code: "MEMORY_LINT_SLACK_TOKEN", pattern: /(?<![A-Za-z0-9])xox[abps]-[A-Za-z0-9-]{8,}/g },
  { code: "MEMORY_LINT_MODEL_API_KEY", pattern: /(?<![A-Za-z0-9])sk-[A-Za-z0-9_-]{20,}/g },
  { code: "MEMORY_LINT_PRIVATE_KEY_BLOCK", pattern: /-----BEGIN [A-Z ]*PRIVATE KEY-----/g },
  {
    code: "MEMORY_LINT_JWT",
    pattern: /(?<![A-Za-z0-9_-])eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  { code: "MEMORY_LINT_URL_CREDENTIALS", pattern: /:\/\/[^\s/@:]+:[^\s/@]+@/g },
  { code: "MEMORY_LINT_PROVIDER_SESSION_ID", pattern: /~\/\.claude\/projects\//g },
  { code: "MEMORY_LINT_PROVIDER_SESSION_ID", pattern: /\.codex\/sessions/g },
];

const WARN_PATTERN_RULES = [
  { code: "MEMORY_LINT_ABSOLUTE_PATH", pattern: /\/(?:Users|home)\/[^\s"'`)\]]+/g },
  {
    code: "MEMORY_LINT_EMAIL",
    pattern: /(?<![A-Za-z0-9._%+-])[A-Za-z0-9._%+-]+@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)*\.[A-Za-z]{2,}/g,
  },
  { code: "MEMORY_LINT_IP_PORT", pattern: /(?<![\d.])(?:\d{1,3}\.){3}\d{1,3}:\d{1,5}(?!\d)/g },
];

function redactedExcerpt(match) {
  const prefix = match.slice(0, 6);
  return `${prefix}…[${match.length} chars]`;
}

function finding(code, severity, index, match) {
  return { code, severity, index, excerpt: redactedExcerpt(match) };
}

function shannonEntropyBitsPerCharacter(token) {
  const counts = new Map();
  for (const character of token) {
    counts.set(character, (counts.get(character) ?? 0) + 1);
  }
  let entropy = 0;
  for (const count of counts.values()) {
    const probability = count / token.length;
    entropy -= probability * Math.log2(probability);
  }
  return entropy;
}

function collectPatternFindings(text, rules, severity, findings) {
  for (const rule of rules) {
    rule.pattern.lastIndex = 0;
    for (const match of text.matchAll(rule.pattern)) {
      findings.push(finding(rule.code, severity, match.index, match[0]));
    }
  }
}

function collectHighEntropyFindings(text, findings) {
  HIGH_ENTROPY_TOKEN_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(HIGH_ENTROPY_TOKEN_PATTERN)) {
    const token = match[0];
    if (token.length < HIGH_ENTROPY_MIN_LENGTH) continue;
    // Git object ids are expected memory content (evidence commits, digests):
    // an all-lowercase hex string of exactly 40 or 64 characters is exempt.
    if (GIT_HASH_HEX40_PATTERN.test(token) || GIT_HASH_HEX64_PATTERN.test(token)) continue;
    if (shannonEntropyBitsPerCharacter(token) >= HIGH_ENTROPY_THRESHOLD_BITS) {
      findings.push(finding("MEMORY_LINT_HIGH_ENTROPY", "block", match.index, token));
    }
  }
}

function collectSessionIdFindings(text, findings) {
  UUID_V4_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(UUID_V4_PATTERN)) {
    const start = Math.max(0, match.index - SESSION_CONTEXT_WINDOW);
    const end = Math.min(text.length, match.index + match[0].length + SESSION_CONTEXT_WINDOW);
    const window = text.slice(start, end);
    if (SESSION_CONTEXT_PATTERN.test(window)) {
      findings.push(finding("MEMORY_LINT_PROVIDER_SESSION_ID", "block", match.index, match[0]));
    }
  }
}

/**
 * Lints memory text for secrets and private material. Returns findings sorted
 * by index, each `{ code, severity: "block"|"warn", index, excerpt }` with a
 * redacted excerpt.
 */
export function lintMemoryText(text) {
  if (typeof text !== "string") throw new TypeError("lintMemoryText requires a string");
  const findings = [];
  collectPatternFindings(text, BLOCK_PATTERN_RULES, "block", findings);
  collectHighEntropyFindings(text, findings);
  collectSessionIdFindings(text, findings);
  collectPatternFindings(text, WARN_PATTERN_RULES, "warn", findings);
  findings.sort((left, right) => left.index - right.index || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
  return findings;
}

/**
 * Promotion gate for a single entry file: sanitization lint plus frontmatter
 * validation via memory-format. `ok` is true only when the entry parses and no
 * `block` finding is present (warnings alone do not block promotion).
 */
export function lintEntryForPromotion(entryText) {
  if (typeof entryText !== "string") throw new TypeError("lintEntryForPromotion requires a string");
  const findings = lintMemoryText(entryText);
  try {
    parseMemoryEntry(entryText);
  } catch (error) {
    findings.push({
      code: typeof error.code === "string" ? error.code : "MEMORY_FORMAT_INVALID",
      severity: "block",
      index: 0,
      // Format error messages name fields, never raw values, so they are safe
      // to surface here.
      excerpt: String(error.message).slice(0, 120),
    });
  }
  const ok = findings.every((item) => item.severity !== "block");
  return { ok, findings };
}
