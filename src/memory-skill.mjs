// Agent-neutral Skill documents used by Team Memory.
//
// The repository stores only a small, portable SKILL.md subset. Provider
// metadata (for example agents/openai.yaml) is deliberately not copied into
// the memory source tree; provider adapters may derive their own projections.

import { lintMemoryText } from "./memory-lint.mjs";

export const MEMORY_SKILL_CANDIDATE_FORMAT = "threadshare-memory-skill-candidate@v1";
export const MEMORY_SKILL_TARGET_PREFIX = ".threadshare/memory/skills/";
export const MEMORY_SKILL_MAX_BODY_BYTES = 64 * 1024;
export const MEMORY_SKILL_MAX_DESCRIPTION_CHARACTERS = 1024;

const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SKILL_FRONTMATTER_KEYS = new Set([
  "allowed-tools",
  "description",
  "license",
  "metadata",
  "name",
]);

function skillError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function parseFrontmatterValue(key, raw) {
  const value = raw.trim();
  if (value.length === 0) {
    throw skillError("MEMORY_SKILL_FORMAT_INVALID", `Skill frontmatter ${key} must not be empty`);
  }
  const first = value[0];
  if (first === '"' || first === "[" || first === "{" || value === "true" ||
      value === "false" || value === "null") {
    try {
      return JSON.parse(value);
    } catch {
      throw skillError("MEMORY_SKILL_FORMAT_INVALID", `Skill frontmatter ${key} must be valid JSON`);
    }
  }
  if (value.includes("#")) {
    throw skillError("MEMORY_SKILL_FORMAT_INVALID", "Skill frontmatter does not support comments");
  }
  return value;
}

function validateName(name) {
  if (typeof name !== "string" || name.length === 0 || name.length > 64 ||
      !SKILL_NAME_PATTERN.test(name)) {
    throw skillError(
      "MEMORY_SKILL_NAME_INVALID",
      "Skill name must be 1-64 lowercase letters, digits, or single hyphens",
    );
  }
  return name;
}

function validateDescription(description) {
  if (typeof description !== "string" || description.trim() === "" ||
      description.length > MEMORY_SKILL_MAX_DESCRIPTION_CHARACTERS ||
      /[<>\r\n]/u.test(description)) {
    throw skillError(
      "MEMORY_SKILL_DESCRIPTION_INVALID",
      "Skill description must be non-empty, at most 1024 characters, and contain no angle brackets or newlines",
    );
  }
  return description.trim();
}

function validateBody(body) {
  if (typeof body !== "string" || body.trim() === "") {
    throw skillError("MEMORY_SKILL_BODY_INVALID", "Skill body must be non-empty");
  }
  if (body.includes("\r") || body.charCodeAt(0) === 0xfeff) {
    throw skillError("MEMORY_SKILL_BODY_INVALID", "Skill body must be UTF-8 LF text without a BOM or CR");
  }
  const normalized = body.endsWith("\n") ? body : `${body}\n`;
  if (Buffer.byteLength(normalized, "utf8") > MEMORY_SKILL_MAX_BODY_BYTES) {
    throw skillError(
      "MEMORY_SKILL_BODY_TOO_LARGE",
      `Skill body exceeds ${MEMORY_SKILL_MAX_BODY_BYTES} bytes`,
    );
  }
  return normalized;
}

/** Serialize the portable subset of a Skill document deterministically. */
export function serializeSkillDocument({ name, description, body }) {
  validateName(name);
  validateDescription(description);
  const normalizedBody = validateBody(body);
  return [
    "---",
    `name: ${JSON.stringify(name)}`,
    `description: ${JSON.stringify(description.trim())}`,
    "---",
    normalizedBody,
  ].join("\n");
}

/** Parse and validate a SKILL.md generated or supplied by an Agent. */
export function parseSkillDocument(text, { expectedName } = {}) {
  if (typeof text !== "string") throw new TypeError("Skill document must be a string");
  if (text.charCodeAt(0) === 0xfeff) {
    throw skillError("MEMORY_SKILL_FORMAT_INVALID", "Skill document must not start with a BOM");
  }
  if (text.includes("\r")) {
    throw skillError("MEMORY_SKILL_FORMAT_INVALID", "Skill document must use LF line endings");
  }
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/u.exec(text);
  if (match === null) {
    throw skillError("MEMORY_SKILL_FORMAT_INVALID", "Skill document must start with a closed frontmatter block");
  }
  const frontmatter = {};
  for (const line of match[1].split("\n")) {
    const field = /^([a-z][a-z-]*): (.+)$/u.exec(line);
    if (field === null || !SKILL_FRONTMATTER_KEYS.has(field[1]) ||
        Object.hasOwn(frontmatter, field[1])) {
      throw skillError("MEMORY_SKILL_FORMAT_INVALID", "Skill frontmatter contains an invalid or duplicate field");
    }
    frontmatter[field[1]] = parseFrontmatterValue(field[1], field[2]);
  }
  const name = validateName(frontmatter.name);
  if (expectedName !== undefined && name !== expectedName) {
    throw skillError("MEMORY_SKILL_BINDING_DRIFT", "Skill name does not match its target directory");
  }
  const description = validateDescription(frontmatter.description);
  const body = validateBody(match[2]);
  return { name, description, body, frontmatter };
}

/** Secret/session lint for a Skill promotion. Warnings remain review-visible. */
export function lintSkillForPromotion(text, options = {}) {
  let parsed = null;
  let formatFinding = null;
  try {
    parsed = parseSkillDocument(text, options);
  } catch (error) {
    formatFinding = {
      code: error.code ?? "MEMORY_SKILL_FORMAT_INVALID",
      severity: "block",
      index: 0,
      excerpt: String(error.message).slice(0, 120),
    };
  }
  const findings = lintMemoryText(text);
  if (formatFinding !== null) findings.push(formatFinding);
  findings.sort((left, right) => left.index - right.index || left.code.localeCompare(right.code));
  return { ok: findings.every((finding) => finding.severity !== "block"), findings, parsed };
}

export function skillTargetPath(name) {
  validateName(name);
  return `${MEMORY_SKILL_TARGET_PREFIX}${name}/SKILL.md`;
}
