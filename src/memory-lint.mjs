// Sanitization lint for team memory text (design §4 "secret lint").
//
// `block` findings must keep content out of the git-tracked memory library;
// `warn` findings flag material a reviewer should confirm. Excerpts are always
// redacted (a short prefix plus the match length) so findings themselves never
// leak the detected secret.

import { parseMemoryEntry } from "./memory-format.mjs";

const HIGH_ENTROPY_MIN_LENGTH = 20;
const HIGH_ENTROPY_THRESHOLD_BITS = 4.0;
const HIGH_ENTROPY_TOKEN_PATTERN = /[A-Za-z0-9+/=_-]{20,}/g;

// Long hex runs (sha256/sha1/md5 digests, hex-encoded keys) are a blind spot for
// the Shannon-entropy rule: hex's 16-symbol alphabet caps entropy at 4.0 bits per
// character, and a real digest's skewed character distribution sits well below the
// >= 4.0 block threshold. So a genuine hex-encoded credential slips past the block
// rule entirely. This independent, entropy-free rule warns (not blocks — a long
// hex reference in prose can be legitimate) on any contiguous hex run of at least
// 32 characters that a caller has not marked as structured context via
// allowedSpans. A bare commit hash in the body is exactly this shape, so it warns
// too, nudging the author to move it into structured evidence.
const ENCODED_SECRET_MIN_LENGTH = 32;
const ENCODED_SECRET_HEX_PATTERN = /(?<![0-9a-fA-F])[0-9a-fA-F]{32,}(?![0-9a-fA-F])/g;

const UUID_V4_PATTERN =
  /[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-4[0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}/g;
const SESSION_CONTEXT_PATTERN = /session|agent/i;
const SESSION_CONTEXT_WINDOW = 48;

const BLOCK_PATTERN_RULES = [
  { code: "MEMORY_LINT_AWS_ACCESS_KEY", pattern: /(?<![A-Za-z0-9])(?:AKIA|ASIA)[0-9A-Z]{16}/g },
  {
    code: "MEMORY_LINT_GITHUB_TOKEN",
    pattern: /(?<![A-Za-z0-9])(?:gh[oprsu]_[A-Za-z0-9]{16,}|github_pat_[A-Za-z0-9_]{16,})/g,
  },
  { code: "MEMORY_LINT_GITLAB_TOKEN", pattern: /(?<![A-Za-z0-9])glpat-[A-Za-z0-9_-]{16,}/g },
  { code: "MEMORY_LINT_NPM_TOKEN", pattern: /(?<![A-Za-z0-9])npm_[A-Za-z0-9]{16,}/g },
  {
    code: "MEMORY_LINT_GOOGLE_API_KEY",
    pattern: /(?<![A-Za-z0-9])AIza[0-9A-Za-z_-]{35}/g,
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
  // Windows session path shapes (backslash separators).
  { code: "MEMORY_LINT_PROVIDER_SESSION_ID", pattern: /\\\.claude\\projects\\/g },
  { code: "MEMORY_LINT_PROVIDER_SESSION_ID", pattern: /\.codex\\sessions/g },
  { code: "MEMORY_LINT_PROVIDER_SESSION_ID", pattern: /AppData\\(?:[^\\\s]+\\)*Claude(?![A-Za-z0-9])/g },
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

function isWithinAllowedSpan(allowedSpans, start, end) {
  return allowedSpans.some((span) => span.start <= start && end <= span.end);
}

function collectHighEntropyFindings(text, findings, allowedSpans) {
  HIGH_ENTROPY_TOKEN_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(HIGH_ENTROPY_TOKEN_PATTERN)) {
    const token = match[0];
    if (token.length < HIGH_ENTROPY_MIN_LENGTH) continue;
    // There is no unconditional hex exemption: a bare hex40/hex64 in prose is
    // treated like any other token. Expected digests (e.g. the evidence
    // commit hashes a caller has already parsed out of structured context)
    // are exempted only via caller-provided allowedSpans that fully cover
    // the token.
    if (isWithinAllowedSpan(allowedSpans, match.index, match.index + token.length)) continue;
    if (shannonEntropyBitsPerCharacter(token) >= HIGH_ENTROPY_THRESHOLD_BITS) {
      findings.push(finding("MEMORY_LINT_HIGH_ENTROPY", "block", match.index, token));
    }
  }
}

function collectEncodedSecretFindings(text, findings, allowedSpans) {
  ENCODED_SECRET_HEX_PATTERN.lastIndex = 0;
  for (const match of text.matchAll(ENCODED_SECRET_HEX_PATTERN)) {
    const token = match[0];
    if (token.length < ENCODED_SECRET_MIN_LENGTH) continue;
    const start = match.index;
    const end = start + token.length;
    // Structured evidence (e.g. evidence.commits[].hash, located from parsed
    // frontmatter) is exempt exactly like the high-entropy rule.
    if (isWithinAllowedSpan(allowedSpans, start, end)) continue;
    findings.push(finding("MEMORY_LINT_POSSIBLE_ENCODED_SECRET", "warn", start, token));
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

function normalizeAllowedSpans(allowedSpans) {
  if (allowedSpans === undefined) return [];
  if (!Array.isArray(allowedSpans)) {
    throw new TypeError("allowedSpans must be an array of { start, end } spans");
  }
  return allowedSpans.map((span) => {
    if (
      span === null ||
      typeof span !== "object" ||
      !Number.isSafeInteger(span.start) ||
      !Number.isSafeInteger(span.end) ||
      span.start < 0 ||
      span.end < span.start
    ) {
      throw new TypeError("each allowed span must be { start, end } with 0 <= start <= end");
    }
    return { start: span.start, end: span.end };
  });
}

/**
 * Lints memory text for secrets and private material. Returns findings sorted
 * by index, each `{ code, severity: "block"|"warn", index, excerpt }` with a
 * redacted excerpt.
 *
 * `options.allowedSpans` is an optional list of `{ start, end }` character
 * ranges (end exclusive) marking structured context — e.g. evidence commit
 * hashes a caller located from parsed frontmatter. High-entropy tokens and long
 * hex runs (the `MEMORY_LINT_POSSIBLE_ENCODED_SECRET` warn) fully contained in
 * an allowed span are exempt; nothing else is.
 */
export function lintMemoryText(text, { allowedSpans } = {}) {
  if (typeof text !== "string") throw new TypeError("lintMemoryText requires a string");
  const spans = normalizeAllowedSpans(allowedSpans);
  const findings = [];
  collectPatternFindings(text, BLOCK_PATTERN_RULES, "block", findings);
  collectHighEntropyFindings(text, findings, spans);
  collectEncodedSecretFindings(text, findings, spans);
  collectSessionIdFindings(text, findings);
  collectPatternFindings(text, WARN_PATTERN_RULES, "warn", findings);
  findings.sort((left, right) => left.index - right.index || (left.code < right.code ? -1 : left.code > right.code ? 1 : 0));
  return findings;
}

const FRONTMATTER_TERMINATOR = "\n---\n";

// Locations of evidence.commits[].hash values inside the frontmatter region.
// Only the frontmatter (structured, schema-validated context) is searched:
// the same hex appearing in the body gets no exemption.
function evidenceHashSpans(entryText, frontmatter) {
  const terminator = entryText.indexOf(FRONTMATTER_TERMINATOR);
  if (terminator === -1) return [];
  const frontmatterEnd = terminator + FRONTMATTER_TERMINATOR.length;
  const spans = [];
  for (const commit of frontmatter.evidence.commits) {
    let cursor = 0;
    while (cursor < frontmatterEnd) {
      const index = entryText.indexOf(commit.hash, cursor);
      if (index === -1 || index >= frontmatterEnd) break;
      spans.push({ start: index, end: index + commit.hash.length });
      cursor = index + commit.hash.length;
    }
  }
  return spans;
}

function frontmatterIdSpan(entryText, frontmatter) {
  const terminator = entryText.indexOf(FRONTMATTER_TERMINATOR);
  if (terminator === -1) return [];
  const marker = `\nid: ${frontmatter.id}\n`;
  const markerIndex = entryText.indexOf(marker, 3);
  if (markerIndex === -1 || markerIndex >= terminator) return [];
  const start = markerIndex + "\nid: ".length;
  return [{ start, end: start + frontmatter.id.length }];
}

/**
 * Promotion gate for a single entry file: sanitization lint plus frontmatter
 * validation via memory-format. `ok` is true only when the entry parses and no
 * `block` finding is present (warnings alone do not block promotion).
 * The parsed evidence.commits[].hash locations are passed to the linter as
 * allowedSpans, so structured evidence hashes never block promotion while the
 * same material in the body still does.
 */
export function lintEntryForPromotion(entryText, { allowedSpans = [] } = {}) {
  if (typeof entryText !== "string") throw new TypeError("lintEntryForPromotion requires a string");
  let parsed = null;
  let formatFinding = null;
  try {
    parsed = parseMemoryEntry(entryText);
  } catch (error) {
    formatFinding = {
      code: typeof error.code === "string" ? error.code : "MEMORY_FORMAT_INVALID",
      severity: "block",
      index: 0,
      // Format error messages name fields, never raw values, so they are safe
      // to surface here.
      excerpt: String(error.message).slice(0, 120),
    };
  }
  const structuredSpans = parsed === null
    ? allowedSpans
    : [
        ...allowedSpans,
        ...frontmatterIdSpan(entryText, parsed.frontmatter),
        ...evidenceHashSpans(entryText, parsed.frontmatter),
      ];
  const findings = lintMemoryText(entryText, { allowedSpans: structuredSpans });
  if (formatFinding !== null) findings.push(formatFinding);
  const ok = findings.every((item) => item.severity !== "block");
  return { ok, findings };
}
