import assert from "node:assert/strict";
import test from "node:test";

import {
  parseMemoryEntry,
  parseSceneMeta,
  serializeMemoryEntry,
  validateDoctrine,
  validateSceneBlock,
} from "../src/memory-format.mjs";

const COMMIT_HASH = "7fd2f23a1b04c9e8d2f6a35b7c01d94e8f123456";

const CANONICAL_FRONTMATTER = {
  id: "auth-module-do-not-refactor",
  type: "work_method",
  status: "approved",
  priority: 85,
  confidence: "high",
  provenance_strength: "observed",
  claim_support: "human-confirmed",
  limitations: ["not-authorship", "not-causality"],
  scope: "repo",
  scene: "鉴权模块维护",
  occurred: ["2026-08-12", "2026-08-18"],
  evidence: {
    commits: [{ repo: "github.com/team-harness/threadshare", hash: COMMIT_HASH }],
    paths: ["routes/api/session.ts"],
  },
  superseded_by: null,
};

const CANONICAL_BODY =
  "别重构旧鉴权模块的 session 中间件，移动端 v2.3 之前的客户端仍依赖其\n非标准 cookie 行为。\n";

const CANONICAL_TEXT = [
  "---",
  "id: auth-module-do-not-refactor",
  "type: work_method",
  "status: approved",
  "priority: 85",
  "confidence: high",
  "provenance_strength: observed",
  "claim_support: human-confirmed",
  'limitations: ["not-authorship","not-causality"]',
  "scope: repo",
  "scene: 鉴权模块维护",
  'occurred: ["2026-08-12","2026-08-18"]',
  `evidence: {"commits":[{"repo":"github.com/team-harness/threadshare","hash":"${COMMIT_HASH}"}],"paths":["routes/api/session.ts"]}`,
  "superseded_by: null",
  "---",
  CANONICAL_BODY,
].join("\n");

function entryText(overrides = {}, body = CANONICAL_BODY) {
  return serializeMemoryEntry({ frontmatter: { ...CANONICAL_FRONTMATTER, ...overrides }, body });
}

function frontmatterTextWithLine(replacedKey, rawLine) {
  const lines = CANONICAL_TEXT.split("\n");
  const index = lines.findIndex((line) => line.startsWith(`${replacedKey}:`));
  assert.notEqual(index, -1);
  if (rawLine === null) lines.splice(index, 1);
  else lines[index] = rawLine;
  return lines.join("\n");
}

function assertThrowsCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.equal(error.code, code, `expected ${code}, got ${error.code}: ${error.message}`);
    return true;
  });
}

test("parses the canonical entry and round-trips byte-for-byte", () => {
  const parsed = parseMemoryEntry(CANONICAL_TEXT);
  assert.deepEqual(parsed.frontmatter, CANONICAL_FRONTMATTER);
  assert.equal(parsed.body, CANONICAL_BODY);
  assert.equal(serializeMemoryEntry(parsed), CANONICAL_TEXT);
});

test("parse(serialize(x)) deep-equals x regardless of input key order", () => {
  const shuffled = Object.fromEntries(Object.entries(CANONICAL_FRONTMATTER).reverse());
  const serialized = serializeMemoryEntry({ frontmatter: shuffled, body: CANONICAL_BODY });
  assert.equal(serialized, CANONICAL_TEXT);
  const reparsed = parseMemoryEntry(serialized);
  assert.deepEqual(reparsed, { frontmatter: CANONICAL_FRONTMATTER, body: CANONICAL_BODY });
});

test("strings needing escapes serialize as JSON and round-trip", () => {
  const frontmatter = {
    ...CANONICAL_FRONTMATTER,
    scene: "  padded # scene ",
    evidence: { commits: [], paths: [] },
    occurred: [],
  };
  const text = serializeMemoryEntry({ frontmatter, body: "" });
  assert.match(text, /^scene: " {2}padded # scene "$/m);
  assert.deepEqual(parseMemoryEntry(text).frontmatter, frontmatter);
});

test("bare values are trimmed and JSON scalars are typed", () => {
  const parsed = parseMemoryEntry(frontmatterTextWithLine("scene", "scene:    鉴权模块维护   "));
  assert.equal(parsed.frontmatter.scene, "鉴权模块维护");
  assert.equal(typeof parseMemoryEntry(CANONICAL_TEXT).frontmatter.priority, "number");
});

test("rejects malformed frontmatter framing", () => {
  assertThrowsCode(() => parseMemoryEntry("id: x\n"), "MEMORY_FORMAT_MISSING_FRONTMATTER");
  assertThrowsCode(() => parseMemoryEntry("---\nid: x\n"), "MEMORY_FORMAT_UNTERMINATED_FRONTMATTER");
  assertThrowsCode(() => parseMemoryEntry("---\nid: x\n---"), "MEMORY_FORMAT_UNTERMINATED_FRONTMATTER");
});

test("rejects malformed lines, keys, duplicates, comments, and bad JSON", () => {
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("scene", "scene:no-space")),
    "MEMORY_FORMAT_INVALID_LINE",
  );
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("scene", "Scene: value")),
    "MEMORY_FORMAT_INVALID_LINE",
  );
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("scene", "scene: a\nscene: b")),
    "MEMORY_FORMAT_DUPLICATE_KEY",
  );
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("scene", "scene: 鉴权 # comment")),
    "MEMORY_FORMAT_COMMENT_NOT_ALLOWED",
  );
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("occurred", "occurred: [2026-08-12]")),
    "MEMORY_FORMAT_INVALID_JSON_VALUE",
  );
  // An unbalanced "{" now scans forward for a closing line (DEV-2 rev2); when
  // the frontmatter ends first, the dedicated unterminated code is reported.
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("priority", 'priority: {"broken"')),
    "MEMORY_FORMAT_UNTERMINATED_JSON",
  );
});

test("rejects unknown and missing fields", () => {
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("scene", "scene: x\nextra_field: y")),
    "MEMORY_FORMAT_UNKNOWN_FIELD",
  );
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("scene", null)),
    "MEMORY_FORMAT_MISSING_FIELD",
  );
  assertThrowsCode(
    () => serializeMemoryEntry({ frontmatter: { ...CANONICAL_FRONTMATTER, extra: 1 }, body: "" }),
    "MEMORY_FORMAT_UNKNOWN_FIELD",
  );
});

test("rejects unverified claim_support with a dedicated code", () => {
  assertThrowsCode(
    () => serializeMemoryEntry({ frontmatter: { ...CANONICAL_FRONTMATTER, claim_support: "unverified" }, body: "" }),
    "MEMORY_FORMAT_UNVERIFIED_CLAIM_SUPPORT",
  );
});

test("validates every entry field", () => {
  const invalidValues = [
    ["id", "Bad_Slug"],
    ["id", "-leading-dash"],
    ["id", "a".repeat(129)],
    ["type", "work_note"],
    ["status", "pending"],
    ["priority", 101],
    ["priority", -1],
    ["confidence", "certain"],
    ["provenance_strength", "strong"],
    ["claim_support", "verified"],
    ["limitations", ["ok", ""]],
    ["limitations", "not-authorship"],
    ["scope", "org"],
    ["scene", ""],
    ["occurred", ["2026-08-12", "2026-13-01"]],
    ["occurred", ["2026-02-30"]],
    ["occurred", "2026-08-12"],
    ["evidence", { commits: [], paths: [], extra: [] }],
    ["evidence", { commits: [{ repo: "", hash: COMMIT_HASH }], paths: [] }],
    ["evidence", { commits: [{ repo: "r", hash: "ABC123" }], paths: [] }],
    ["evidence", { commits: [{ repo: "r", hash: COMMIT_HASH, branch: "main" }], paths: [] }],
    ["superseded_by", "Not A Slug"],
  ];
  for (const [field, value] of invalidValues) {
    assert.throws(
      () => serializeMemoryEntry({ frontmatter: { ...CANONICAL_FRONTMATTER, [field]: value }, body: "" }),
      (error) => typeof error.code === "string" && error.code.startsWith("MEMORY_FORMAT_"),
      `expected rejection for ${field}=${JSON.stringify(value)}`,
    );
  }
});

test("priority with a leading zero is a bare string, not an integer", () => {
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("priority", "priority: 085")),
    "MEMORY_FORMAT_INVALID_FIELD",
  );
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("priority", "priority: 8.5")),
    "MEMORY_FORMAT_INVALID_FIELD",
  );
});

// Proposal §5.1 sample (multi-line evidence JSON object, quoted array
// elements), verbatim minus the doc's trailing `# …` annotation callouts —
// the dialect itself has no comments.
const PROPOSAL_5_1_BODY =
  "别重构旧鉴权模块的 session 中间件，移动端 v2.3 之前的客户端仍依赖其\n非标准 cookie 行为。改动前必须先在 staging 用 mobile-e2e 套件验证。\n";

const PROPOSAL_5_1_TEXT = [
  "---",
  "id: auth-module-do-not-refactor",
  "type: work_method",
  "status: approved",
  "priority: 85",
  "confidence: high",
  "provenance_strength: observed",
  "claim_support: human-confirmed",
  'limitations: ["not-authorship", "not-causality"]',
  "scope: repo",
  "scene: 鉴权模块维护",
  'occurred: ["2026-08-12", "2026-08-18"]',
  "evidence: {",
  '  "commits": [',
  '    { "repo": "github.com/team-harness/threadshare",',
  `      "hash": "${COMMIT_HASH}" }`,
  "  ],",
  '  "paths": ["routes/api/session.ts"]',
  "}",
  "superseded_by: null",
  "---",
  PROPOSAL_5_1_BODY,
].join("\n");

test("parses the proposal §5.1 sample and round-trips through canonical form", () => {
  const parsed = parseMemoryEntry(PROPOSAL_5_1_TEXT);
  assert.deepEqual(parsed.frontmatter, CANONICAL_FRONTMATTER);
  assert.equal(parsed.body, PROPOSAL_5_1_BODY);
  // Serialization is deterministic: the multi-line evidence value collapses to
  // single-line canonical JSON, and reparsing deep-equals the original parse.
  const serialized = serializeMemoryEntry(parsed);
  assert.match(
    serialized,
    /^evidence: \{"commits":\[\{"repo":"github\.com\/team-harness\/threadshare","hash":"[0-9a-f]{40}"\}\],"paths":\["routes\/api\/session\.ts"\]\}$/m,
  );
  assert.equal(serialized.split("\n---\n").length, 2);
  assert.deepEqual(parseMemoryEntry(serialized), parsed);
});

test("multi-line arrays and nested objects parse and serialize to canonical single-line JSON", () => {
  const text = frontmatterTextWithLine(
    "occurred",
    'occurred: [\n  "2026-08-12",\n  "2026-08-18"\n]',
  );
  const parsed = parseMemoryEntry(text);
  assert.deepEqual(parsed.frontmatter.occurred, ["2026-08-12", "2026-08-18"]);
  assert.equal(serializeMemoryEntry(parsed), CANONICAL_TEXT);
  assert.deepEqual(parseMemoryEntry(serializeMemoryEntry(parsed)), parsed);
});

test("brackets, colons, and hashes inside JSON string literals do not affect balancing", () => {
  const limitations =
    'limitations: [\n  "closing } inside",\n  "closing ] inside",\n  "colon: and # hash",\n  "escaped \\" quote with { and ["\n]';
  const parsed = parseMemoryEntry(frontmatterTextWithLine("limitations", limitations));
  assert.deepEqual(parsed.frontmatter.limitations, [
    "closing } inside",
    "closing ] inside",
    "colon: and # hash",
    'escaped " quote with { and [',
  ]);
  const evidence = [
    "evidence: {",
    '  "commits": [],',
    '  "paths": ["deep/[dir]/file}:{name#1.ts"]',
    "}",
  ].join("\n");
  const parsedEvidence = parseMemoryEntry(frontmatterTextWithLine("evidence", evidence));
  assert.deepEqual(parsedEvidence.frontmatter.evidence, {
    commits: [],
    paths: ["deep/[dir]/file}:{name#1.ts"],
  });
  const roundTripped = parseMemoryEntry(serializeMemoryEntry(parsedEvidence));
  assert.deepEqual(roundTripped, parsedEvidence);
});

test("multi-line JSON that never closes is rejected with the unterminated code", () => {
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("evidence", 'evidence: {\n  "commits": [],\n  "paths": []')),
    "MEMORY_FORMAT_UNTERMINATED_JSON",
  );
  // An unterminated string literal swallows the closing brackets too.
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("evidence", 'evidence: {\n  "commits": [],\n  "paths": ["unterminated\n}')),
    "MEMORY_FORMAT_UNTERMINATED_JSON",
  );
});

test("multi-line JSON that balances but is not valid JSON is rejected", () => {
  // Trailing comma: brackets balance, JSON.parse fails.
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("evidence", 'evidence: {\n  "commits": [],\n  "paths": [],\n}')),
    "MEMORY_FORMAT_INVALID_JSON_VALUE",
  );
  // Trailing garbage after the balancing closer stays part of the value.
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("evidence", 'evidence: {\n  "commits": [],\n  "paths": []\n} trailing')),
    "MEMORY_FORMAT_INVALID_JSON_VALUE",
  );
});

test("duplicate keys are still rejected when the first value spans multiple lines", () => {
  const lines = [
    "evidence: {",
    '  "commits": [],',
    '  "paths": []',
    "}",
    'evidence: {"commits":[],"paths":[]}',
  ].join("\n");
  assertThrowsCode(
    () => parseMemoryEntry(frontmatterTextWithLine("evidence", lines)),
    "MEMORY_FORMAT_DUPLICATE_KEY",
  );
});

test("accepts deprecated entries pointing at their successor", () => {
  const parsed = parseMemoryEntry(entryText({ status: "deprecated", superseded_by: "new-entry" }));
  assert.equal(parsed.frontmatter.status, "deprecated");
  assert.equal(parsed.frontmatter.superseded_by, "new-entry");
});

const SCENE_TEXT = [
  "-----META-START-----",
  "created: 2026-08-12",
  "updated: 2026-08-18",
  "summary: 鉴权模块维护要点",
  "heat: 3",
  "-----META-END-----",
  "## 工作场景",
  "鉴权模块的维护流程。",
].join("\n");

test("parses the scene META block and preserves the body", () => {
  const parsed = parseSceneMeta(SCENE_TEXT);
  assert.deepEqual(parsed.meta, {
    created: "2026-08-12",
    updated: "2026-08-18",
    summary: "鉴权模块维护要点",
    heat: 3,
  });
  assert.equal(parsed.body, "## 工作场景\n鉴权模块的维护流程。");
});

test("rejects malformed scene META blocks", () => {
  assertThrowsCode(() => parseSceneMeta("no meta\n"), "MEMORY_FORMAT_MISSING_META");
  assertThrowsCode(() => parseSceneMeta("-----META-START-----\ncreated: 2026-08-12\n"), "MEMORY_FORMAT_UNTERMINATED_META");
  assertThrowsCode(
    () => parseSceneMeta(SCENE_TEXT.replace("heat: 3", "heat: 3\nowner: me")),
    "MEMORY_FORMAT_META_UNKNOWN_FIELD",
  );
  assertThrowsCode(
    () => parseSceneMeta(SCENE_TEXT.replace("heat: 3\n", "")),
    "MEMORY_FORMAT_META_MISSING_FIELD",
  );
  assertThrowsCode(
    () => parseSceneMeta(SCENE_TEXT.replace("created: 2026-08-12", "created: yesterday")),
    "MEMORY_FORMAT_META_INVALID_FIELD",
  );
  assertThrowsCode(
    () => parseSceneMeta(SCENE_TEXT.replace("heat: 3", "heat: 0")),
    "MEMORY_FORMAT_META_INVALID_FIELD",
  );
  assertThrowsCode(
    () => parseSceneMeta(SCENE_TEXT.replace("summary: 鉴权模块维护要点", `summary: ${"长".repeat(41)}`)),
    "MEMORY_FORMAT_META_INVALID_FIELD",
  );
});

test("scene summary limit counts characters, so 40 CJK characters pass", () => {
  const parsed = parseSceneMeta(SCENE_TEXT.replace("summary: 鉴权模块维护要点", `summary: ${"长".repeat(40)}`));
  assert.equal(parsed.meta.summary.length, 40);
});

test("validateSceneBlock enforces the 1500-character body budget", () => {
  const header = SCENE_TEXT.split("-----META-END-----")[0] + "-----META-END-----\n";
  const atLimit = validateSceneBlock(header + "场".repeat(1500));
  assert.equal(atLimit.bodyCharacterCount, 1500);
  assertThrowsCode(() => validateSceneBlock(header + "场".repeat(1501)), "MEMORY_FORMAT_SCENE_BODY_TOO_LONG");
});

test("validateDoctrine counts Unicode code points against the 1200 limit", () => {
  assert.deepEqual(validateDoctrine("守".repeat(1200)), { characterCount: 1200 });
  assertThrowsCode(() => validateDoctrine("守".repeat(1201)), "MEMORY_FORMAT_DOCTRINE_TOO_LONG");
  // Astral characters count once per code point, not per UTF-16 unit.
  assert.deepEqual(validateDoctrine("🚀".repeat(1200)), { characterCount: 1200 });
});
