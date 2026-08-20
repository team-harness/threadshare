// Team memory file formats (proposal §5.1–§5.4, design §0 DEV-2).
//
// The repository intentionally has no YAML dependency, so memory files use a
// strict frontmatter dialect instead of YAML:
//   - the file starts with "---\n" and the frontmatter ends at the first "\n---\n";
//   - every frontmatter line is exactly `key: value` with key matching [a-z_]+;
//   - a value starting with "[", "{", or '"', or equal to true/false/null, or
//     forming a complete JSON number token, MUST be valid JSON (JSON.parse);
//   - a value starting with "[" or "{" that does not close on its own line may
//     span multiple lines (design §0 DEV-2 rev2): subsequent lines are consumed
//     until the brackets balance — brackets inside JSON string literals do not
//     participate, and escaped quotes ('\"') do not end a string — and the
//     whole run must then be valid JSON; if the frontmatter ends before the
//     brackets balance, the file is rejected (MEMORY_FORMAT_UNTERMINATED_JSON);
//   - any other value is a bare string (trimmed); bare strings must not contain
//     "#" — there are no comments in this dialect, so "#" is always an error;
//   - the multi-line form above is the only multi-line value; duplicate keys
//     are not supported.
// The dialect is deterministic: `serializeMemoryEntry` emits one canonical byte
// form (non-scalar values always serialize as single-line canonical JSON) and
// `parseMemoryEntry(serializeMemoryEntry(x))` deep-equals `x`.
//
// Read-stage hardening (stable error codes):
//   - a UTF-8 BOM is rejected (MEMORY_FORMAT_BOM_NOT_ALLOWED) and CR/CRLF line
//     endings are rejected (MEMORY_FORMAT_CRLF_NOT_ALLOWED) — the write path
//     refuses CR in bodies for the same reason;
//   - capacity caps: frontmatter ≤ 64 KiB total (MEMORY_FORMAT_FRONTMATTER_TOO_LARGE),
//     ≤ 8 KiB per line (MEMORY_FORMAT_LINE_TOO_LONG), ≤ 512 lines
//     (MEMORY_FORMAT_TOO_MANY_LINES), JSON nesting ≤ 16 (MEMORY_FORMAT_JSON_TOO_DEEP);
//   - multi-line JSON values are scanned by an incremental cross-line state
//     machine (inString/escaped/depth carried between lines), so each byte is
//     visited once and an unterminated large value cannot cause quadratic work.

const FRONTMATTER_OPEN = "---\n";
const FRONTMATTER_TERMINATOR = "\n---\n";
const META_START = "-----META-START-----";
const META_END = "-----META-END-----";

// Read-stage capacity limits (DoS hardening): enforced before/while parsing,
// each with a stable error code.
const MAX_FRONTMATTER_BYTES = 64 * 1024;
const MAX_FRONTMATTER_LINE_BYTES = 8 * 1024;
const MAX_FRONTMATTER_LINES = 512;
const MAX_JSON_DEPTH = 16;

const LINE_PATTERN = /^([a-z_]+): (.+)$/;
const JSON_NUMBER_PATTERN = /^-?(?:0|[1-9][0-9]*)(?:\.[0-9]+)?(?:[eE][+-]?[0-9]+)?$/;
const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const MAX_SLUG_LENGTH = 128;
const HEX40_PATTERN = /^[0-9a-f]{40}$/;
const ISO_DATE_PATTERN = /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/;

const ENTRY_TYPES = new Set(["work_fact", "work_task", "work_method", "work_artifact"]);
const ENTRY_STATUSES = new Set(["approved", "deprecated"]);
const CONFIDENCE_VALUES = new Set(["high", "medium", "low"]);
const PROVENANCE_STRENGTHS = new Set(["direct", "observed", "candidate", "contextual", "unknown"]);
const CLAIM_SUPPORTS = new Set(["typed-fact", "human-confirmed", "mixed"]);

// Proposal §5.1 field order; serialization always emits fields in this order.
const ENTRY_FIELDS = [
  "id",
  "type",
  "status",
  "priority",
  "confidence",
  "provenance_strength",
  "claim_support",
  "limitations",
  "scope",
  "scene",
  "occurred",
  "evidence",
  "superseded_by",
];

const SCENE_META_FIELDS = ["created", "updated", "summary", "heat"];
const MAX_SCENE_SUMMARY_CHARACTERS = 40;
const MAX_SCENE_BODY_CHARACTERS = 1500;
const MAX_DOCTRINE_CHARACTERS = 1200;

function formatError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function isPlainObject(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function isIsoDate(value) {
  if (typeof value !== "string") return false;
  const match = ISO_DATE_PATTERN.exec(value);
  if (match === null) return false;
  const year = Number(match[1]);
  const month = Number(match[2]);
  const day = Number(match[3]);
  const timestamp = Date.UTC(year, month - 1, day);
  const date = new Date(timestamp);
  return (
    date.getUTCFullYear() === year &&
    date.getUTCMonth() === month - 1 &&
    date.getUTCDate() === day
  );
}

function isSlug(value) {
  return (
    typeof value === "string" &&
    value.length <= MAX_SLUG_LENGTH &&
    SLUG_PATTERN.test(value)
  );
}

function countCharacters(text) {
  // "字" counts are implemented as Unicode code points: one CJK character, one
  // ASCII letter, and one emoji scalar each count as 1.
  let count = 0;
  for (const _ of text) count += 1;
  return count;
}

function parseScalarValue(key, rawValue) {
  const value = rawValue.trim();
  if (value.length === 0) {
    throw formatError("MEMORY_FORMAT_INVALID_LINE", `frontmatter value for "${key}" is empty`);
  }
  const first = value[0];
  const mustBeJson =
    first === "[" ||
    first === "{" ||
    first === '"' ||
    value === "true" ||
    value === "false" ||
    value === "null" ||
    JSON_NUMBER_PATTERN.test(value);
  if (mustBeJson) {
    try {
      return JSON.parse(value);
    } catch {
      throw formatError(
        "MEMORY_FORMAT_INVALID_JSON_VALUE",
        `frontmatter value for "${key}" must be valid JSON`,
      );
    }
  }
  if (value.includes("#")) {
    throw formatError(
      "MEMORY_FORMAT_COMMENT_NOT_ALLOWED",
      `frontmatter value for "${key}" contains "#"; comments are not supported`,
    );
  }
  return value;
}

// Incremental JSON bracket scanner: consumes each chunk exactly once and
// carries inString/escaped/depth state across chunks (O(n) over the whole
// value, never re-scanning the accumulated text). Brackets inside JSON string
// literals do not participate in balancing, and an escaped quote ('\"') does
// not end a string. `push` returns true once the leading "["/"{" has found its
// matching closer; content after the balancing closer is left for JSON.parse
// to reject. Nesting deeper than MAX_JSON_DEPTH is rejected during the scan.
function createJsonBalanceScanner(key) {
  let depth = 0;
  let inString = false;
  let escaped = false;
  let balanced = false;
  return {
    push(chunk) {
      if (balanced) return true;
      for (const character of chunk) {
        if (inString) {
          if (escaped) escaped = false;
          else if (character === "\\") escaped = true;
          else if (character === '"') inString = false;
          continue;
        }
        if (character === '"') inString = true;
        else if (character === "{" || character === "[") {
          depth += 1;
          if (depth > MAX_JSON_DEPTH) {
            throw formatError(
              "MEMORY_FORMAT_JSON_TOO_DEEP",
              `frontmatter value for "${key}" nests JSON deeper than the limit of ${MAX_JSON_DEPTH}`,
            );
          }
        } else if (character === "}" || character === "]") {
          depth -= 1;
          if (depth <= 0) {
            balanced = true;
            return true;
          }
        }
      }
      return false;
    },
  };
}

function parseFrontmatterLines(lines, { lineErrorCode }) {
  if (lines.length > MAX_FRONTMATTER_LINES) {
    throw formatError(
      "MEMORY_FORMAT_TOO_MANY_LINES",
      `frontmatter has ${lines.length} lines; the limit is ${MAX_FRONTMATTER_LINES}`,
    );
  }
  for (const line of lines) {
    if (Buffer.byteLength(line, "utf8") > MAX_FRONTMATTER_LINE_BYTES) {
      throw formatError(
        "MEMORY_FORMAT_LINE_TOO_LONG",
        `a frontmatter line exceeds the ${MAX_FRONTMATTER_LINE_BYTES}-byte limit`,
      );
    }
  }
  const result = {};
  for (let index = 0; index < lines.length; index += 1) {
    const match = LINE_PATTERN.exec(lines[index]);
    if (match === null) {
      throw formatError(lineErrorCode, "frontmatter lines must be `key: value` with a [a-z_]+ key");
    }
    const key = match[1];
    if (Object.hasOwn(result, key)) {
      throw formatError("MEMORY_FORMAT_DUPLICATE_KEY", `frontmatter key "${key}" appears more than once`);
    }
    const trimmed = match[2].trim();
    const first = trimmed[0];
    if (first === "[" || first === "{") {
      const scanner = createJsonBalanceScanner(key);
      if (!scanner.push(trimmed)) {
        // Multi-line JSON value (design §0 DEV-2 rev2): consume lines until the
        // brackets balance — each line is scanned exactly once by the
        // incremental scanner — then parse the whole run as JSON.
        let value = trimmed;
        let balanced = false;
        while (index + 1 < lines.length) {
          index += 1;
          value += `\n${lines[index]}`;
          if (scanner.push(lines[index])) {
            balanced = true;
            break;
          }
        }
        if (!balanced) {
          throw formatError(
            "MEMORY_FORMAT_UNTERMINATED_JSON",
            `frontmatter value for "${key}" starts a JSON ${first === "[" ? "array" : "object"} whose brackets never balance before the frontmatter ends`,
          );
        }
        try {
          result[key] = JSON.parse(value);
        } catch {
          throw formatError(
            "MEMORY_FORMAT_INVALID_JSON_VALUE",
            `frontmatter value for "${key}" must be valid JSON`,
          );
        }
        continue;
      }
    }
    result[key] = parseScalarValue(key, match[2]);
  }
  return result;
}

function assertNoBom(text, subject) {
  if (text.charCodeAt(0) === 0xfeff) {
    throw formatError(
      "MEMORY_FORMAT_BOM_NOT_ALLOWED",
      `${subject} must not start with a UTF-8 byte order mark`,
    );
  }
}

function assertNoCarriageReturn(text, subject) {
  if (text.includes("\r")) {
    throw formatError(
      "MEMORY_FORMAT_CRLF_NOT_ALLOWED",
      `${subject} must use LF line endings only; CRLF (or a bare CR) is not allowed`,
    );
  }
}

function invalidField(field, expectation) {
  return formatError("MEMORY_FORMAT_INVALID_FIELD", `frontmatter field "${field}" ${expectation}`);
}

function validateStringArray(field, value) {
  if (!Array.isArray(value)) throw invalidField(field, "must be an array of strings");
  for (const item of value) {
    if (typeof item !== "string" || item.length === 0) {
      throw invalidField(field, "must contain only non-empty strings");
    }
  }
  return [...value];
}

function validateEvidence(value) {
  if (!isPlainObject(value)) throw invalidField("evidence", "must be an object");
  for (const key of Object.keys(value)) {
    if (key !== "commits" && key !== "paths") {
      throw formatError("MEMORY_FORMAT_UNKNOWN_FIELD", `evidence contains unknown key "${key}"`);
    }
  }
  if (!Array.isArray(value.commits)) throw invalidField("evidence.commits", "must be an array");
  if (!Array.isArray(value.paths)) throw invalidField("evidence.paths", "must be an array");
  const commits = value.commits.map((commit) => {
    if (!isPlainObject(commit)) throw invalidField("evidence.commits", "must contain objects");
    for (const key of Object.keys(commit)) {
      if (key !== "repo" && key !== "hash") {
        throw formatError("MEMORY_FORMAT_UNKNOWN_FIELD", `evidence commit contains unknown key "${key}"`);
      }
    }
    if (typeof commit.repo !== "string" || commit.repo.length === 0) {
      throw invalidField("evidence.commits[].repo", "must be a non-empty string");
    }
    if (typeof commit.hash !== "string" || !HEX40_PATTERN.test(commit.hash)) {
      throw invalidField("evidence.commits[].hash", "must be a lowercase 40-character hex commit hash");
    }
    return { repo: commit.repo, hash: commit.hash };
  });
  const paths = validateStringArray("evidence.paths", value.paths);
  return { commits, paths };
}

/**
 * Validates entry frontmatter per proposal §5.1 and returns a normalized plain
 * object with fields in canonical order. Unknown fields are rejected.
 */
export function validateEntryFrontmatter(frontmatter) {
  if (!isPlainObject(frontmatter)) {
    throw formatError("MEMORY_FORMAT_INVALID_FIELD", "entry frontmatter must be a plain object");
  }
  for (const key of Object.keys(frontmatter)) {
    if (!ENTRY_FIELDS.includes(key)) {
      throw formatError("MEMORY_FORMAT_UNKNOWN_FIELD", `entry frontmatter contains unknown field "${key}"`);
    }
  }
  for (const field of ENTRY_FIELDS) {
    if (!Object.hasOwn(frontmatter, field)) {
      throw formatError("MEMORY_FORMAT_MISSING_FIELD", `entry frontmatter is missing field "${field}"`);
    }
  }

  const { id, type, status, priority, confidence, scene } = frontmatter;
  if (!isSlug(id)) throw invalidField("id", "must be a slug ([a-z0-9]+ segments joined by single dashes)");
  if (!ENTRY_TYPES.has(type)) {
    throw invalidField("type", "must be one of work_fact | work_task | work_method | work_artifact");
  }
  if (!ENTRY_STATUSES.has(status)) throw invalidField("status", "must be approved or deprecated");
  if (!Number.isSafeInteger(priority) || priority < 0 || priority > 100) {
    throw invalidField("priority", "must be an integer between 0 and 100");
  }
  if (!CONFIDENCE_VALUES.has(confidence)) throw invalidField("confidence", "must be high, medium, or low");
  if (!PROVENANCE_STRENGTHS.has(frontmatter.provenance_strength)) {
    throw invalidField(
      "provenance_strength",
      "must be one of direct | observed | candidate | contextual | unknown",
    );
  }
  if (frontmatter.claim_support === "unverified") {
    // Proposal §5.1: git-tracked entries never carry unverified claims.
    throw formatError(
      "MEMORY_FORMAT_UNVERIFIED_CLAIM_SUPPORT",
      'frontmatter field "claim_support" must not be "unverified" in a memory entry',
    );
  }
  if (!CLAIM_SUPPORTS.has(frontmatter.claim_support)) {
    throw invalidField("claim_support", "must be one of typed-fact | human-confirmed | mixed");
  }
  const limitations = validateStringArray("limitations", frontmatter.limitations);
  if (frontmatter.scope !== "repo") throw invalidField("scope", 'must be "repo" in Phase 1');
  if (scene !== null && (typeof scene !== "string" || scene.length === 0)) {
    throw invalidField("scene", "must be a non-empty string or null");
  }
  if (!Array.isArray(frontmatter.occurred)) throw invalidField("occurred", "must be an array");
  for (const item of frontmatter.occurred) {
    if (!isIsoDate(item)) throw invalidField("occurred", "must contain only ISO dates (YYYY-MM-DD)");
  }
  const evidence = validateEvidence(frontmatter.evidence);
  if (frontmatter.superseded_by !== null && !isSlug(frontmatter.superseded_by)) {
    throw invalidField("superseded_by", "must be a slug or null");
  }

  return {
    id,
    type,
    status,
    priority,
    confidence,
    provenance_strength: frontmatter.provenance_strength,
    claim_support: frontmatter.claim_support,
    limitations,
    scope: "repo",
    scene,
    occurred: [...frontmatter.occurred],
    evidence,
    superseded_by: frontmatter.superseded_by,
  };
}

/** Parses an `entries/<slug>.md` file into `{ frontmatter, body }`. */
export function parseMemoryEntry(text) {
  if (typeof text !== "string") throw new TypeError("entry text must be a string");
  assertNoBom(text, "entry files");
  assertNoCarriageReturn(text, "entry files");
  if (!text.startsWith(FRONTMATTER_OPEN)) {
    throw formatError("MEMORY_FORMAT_MISSING_FRONTMATTER", 'entry files must start with "---\\n"');
  }
  const terminator = text.indexOf(FRONTMATTER_TERMINATOR, FRONTMATTER_OPEN.length - 1);
  if (terminator === -1) {
    throw formatError(
      "MEMORY_FORMAT_UNTERMINATED_FRONTMATTER",
      'entry frontmatter must be terminated by "\\n---\\n"',
    );
  }
  const rawFrontmatter = text.slice(FRONTMATTER_OPEN.length, terminator);
  if (Buffer.byteLength(rawFrontmatter, "utf8") > MAX_FRONTMATTER_BYTES) {
    throw formatError(
      "MEMORY_FORMAT_FRONTMATTER_TOO_LARGE",
      `entry frontmatter exceeds the ${MAX_FRONTMATTER_BYTES}-byte limit`,
    );
  }
  const body = text.slice(terminator + FRONTMATTER_TERMINATOR.length);
  const lines = rawFrontmatter === "" ? [] : rawFrontmatter.split("\n");
  const parsed = parseFrontmatterLines(lines, { lineErrorCode: "MEMORY_FORMAT_INVALID_LINE" });
  return { frontmatter: validateEntryFrontmatter(parsed), body };
}

function serializeScalarValue(value) {
  if (value === null) return "null";
  if (typeof value === "number") return JSON.stringify(value);
  if (typeof value !== "string") return JSON.stringify(value);
  const bareEligible =
    value.length > 0 &&
    value === value.trim() &&
    !value.includes("\n") &&
    !value.includes("\r") &&
    !value.includes("#") &&
    value[0] !== "[" &&
    value[0] !== "{" &&
    value[0] !== '"' &&
    value !== "true" &&
    value !== "false" &&
    value !== "null" &&
    !JSON_NUMBER_PATTERN.test(value);
  return bareEligible ? value : JSON.stringify(value);
}

/**
 * Serializes `{ frontmatter, body }` to the canonical entry byte form: fields
 * in proposal §5.1 order, deterministic value encodings (non-scalar values are
 * always emitted as single-line canonical JSON, even when they were parsed
 * from the multi-line form), body verbatim.
 * Round-trip guarantee: `parseMemoryEntry(serializeMemoryEntry(x))` deep-equals
 * the validated form of `x`.
 */
export function serializeMemoryEntry({ frontmatter, body }) {
  if (typeof body !== "string") throw new TypeError("entry body must be a string");
  // The write path never produces what the read path would reject.
  assertNoCarriageReturn(body, "entry bodies");
  const normalized = validateEntryFrontmatter(frontmatter);
  const lines = ENTRY_FIELDS.map((field) => {
    const value = normalized[field];
    if (field === "limitations" || field === "occurred") {
      return `${field}: ${JSON.stringify(value)}`;
    }
    if (field === "evidence") {
      const commits = value.commits.map((commit) => ({ repo: commit.repo, hash: commit.hash }));
      return `${field}: ${JSON.stringify({ commits, paths: value.paths })}`;
    }
    return `${field}: ${serializeScalarValue(value)}`;
  });
  return `---\n${lines.join("\n")}\n---\n${body}`;
}

function invalidMetaField(field, expectation) {
  return formatError("MEMORY_FORMAT_META_INVALID_FIELD", `scene META field "${field}" ${expectation}`);
}

/**
 * Parses a scene document (proposal §5.2): a `-----META-START-----` /
 * `-----META-END-----` block holding created/updated/summary/heat, followed by
 * the narrative body.
 */
export function parseSceneMeta(text) {
  if (typeof text !== "string") throw new TypeError("scene text must be a string");
  assertNoBom(text, "scene files");
  assertNoCarriageReturn(text, "scene files");
  const lines = text.split("\n");
  if (lines[0] !== META_START) {
    throw formatError("MEMORY_FORMAT_MISSING_META", `scene files must start with "${META_START}"`);
  }
  const endIndex = lines.indexOf(META_END, 1);
  if (endIndex === -1) {
    throw formatError("MEMORY_FORMAT_UNTERMINATED_META", `scene META block must end with "${META_END}"`);
  }
  const parsed = parseFrontmatterLines(lines.slice(1, endIndex), {
    lineErrorCode: "MEMORY_FORMAT_META_INVALID_LINE",
  });
  for (const key of Object.keys(parsed)) {
    if (!SCENE_META_FIELDS.includes(key)) {
      throw formatError("MEMORY_FORMAT_META_UNKNOWN_FIELD", `scene META contains unknown field "${key}"`);
    }
  }
  for (const field of SCENE_META_FIELDS) {
    if (!Object.hasOwn(parsed, field)) {
      throw formatError("MEMORY_FORMAT_META_MISSING_FIELD", `scene META is missing field "${field}"`);
    }
  }
  if (!isIsoDate(parsed.created)) throw invalidMetaField("created", "must be an ISO date (YYYY-MM-DD)");
  if (!isIsoDate(parsed.updated)) throw invalidMetaField("updated", "must be an ISO date (YYYY-MM-DD)");
  if (typeof parsed.summary !== "string" || parsed.summary.length === 0) {
    throw invalidMetaField("summary", "must be a non-empty string");
  }
  if (countCharacters(parsed.summary) > MAX_SCENE_SUMMARY_CHARACTERS) {
    throw invalidMetaField("summary", `must be at most ${MAX_SCENE_SUMMARY_CHARACTERS} characters`);
  }
  if (!Number.isSafeInteger(parsed.heat) || parsed.heat < 1) {
    throw invalidMetaField("heat", "must be an integer >= 1");
  }
  return {
    meta: {
      created: parsed.created,
      updated: parsed.updated,
      summary: parsed.summary,
      heat: parsed.heat,
    },
    body: lines.slice(endIndex + 1).join("\n"),
  };
}

/** Parses a scene document and enforces the body budget (≤1500 characters). */
export function validateSceneBlock(text) {
  const parsed = parseSceneMeta(text);
  const bodyCharacterCount = countCharacters(parsed.body);
  if (bodyCharacterCount > MAX_SCENE_BODY_CHARACTERS) {
    throw formatError(
      "MEMORY_FORMAT_SCENE_BODY_TOO_LONG",
      `scene body has ${bodyCharacterCount} characters; the limit is ${MAX_SCENE_BODY_CHARACTERS}`,
    );
  }
  return { ...parsed, bodyCharacterCount };
}

/**
 * Validates a doctrine document (proposal §5.3, "≤1200 字"). The proposal's
 * 字 budget is implemented as Unicode code points: each CJK character, ASCII
 * character, or emoji scalar counts as one.
 */
export function validateDoctrine(text) {
  if (typeof text !== "string") throw new TypeError("doctrine text must be a string");
  const characterCount = countCharacters(text);
  if (characterCount > MAX_DOCTRINE_CHARACTERS) {
    throw formatError(
      "MEMORY_FORMAT_DOCTRINE_TOO_LONG",
      `doctrine has ${characterCount} characters; the limit is ${MAX_DOCTRINE_CHARACTERS}`,
    );
  }
  return { characterCount };
}
