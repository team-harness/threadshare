import assert from "node:assert/strict";
import test from "node:test";

import {
  lintSkillForPromotion,
  MEMORY_SKILL_MAX_BODY_BYTES,
  parseSkillDocument,
  serializeSkillDocument,
  skillTargetPath,
} from "../src/memory-skill.mjs";
import {
  candidateDraftBatchSchema,
  MEMORY_SKILL_CANDIDATE_FORMAT,
  skillCandidateSchema,
} from "../src/memory-contracts.mjs";

test("Skill documents have a deterministic portable SKILL.md form", () => {
  const text = serializeSkillDocument({
    name: "release-checks",
    description: "Run the release checks before publishing.",
    body: "## Procedure\n\n1. Run the checks.\n",
  });
  assert.equal(text, [
    "---",
    'name: "release-checks"',
    'description: "Run the release checks before publishing."',
    "---",
    "## Procedure",
    "",
    "1. Run the checks.",
    "",
  ].join("\n"));
  assert.deepEqual(parseSkillDocument(text, { expectedName: "release-checks" }), {
    name: "release-checks",
    description: "Run the release checks before publishing.",
    body: "## Procedure\n\n1. Run the checks.\n",
    frontmatter: {
      name: "release-checks",
      description: "Run the release checks before publishing.",
    },
  });
  assert.equal(skillTargetPath("release-checks"), ".threadshare/memory/skills/release-checks/SKILL.md");
  assert.doesNotThrow(() => serializeSkillDocument({
    name: "max-body",
    description: "A body at the canonical byte boundary.",
    body: "x".repeat(MEMORY_SKILL_MAX_BODY_BYTES - 1),
  }));
  assert.throws(() => serializeSkillDocument({
    name: "oversized-after-normalization",
    description: "A body whose required newline crosses the byte boundary.",
    body: "x".repeat(MEMORY_SKILL_MAX_BODY_BYTES),
  }), (error) => error.code === "MEMORY_SKILL_BODY_TOO_LARGE");
});

test("Skill promotion lint rejects secrets, provider paths, and malformed documents", () => {
  const secret = serializeSkillDocument({
    name: "bad-skill",
    description: "A bad skill",
    body: "Use npm token npm_12345678901234567890 from ~/.claude/projects/private.\n",
  });
  const result = lintSkillForPromotion(secret, { expectedName: "bad-skill" });
  assert.equal(result.ok, false);
  assert.ok(result.findings.some((finding) => finding.code === "MEMORY_LINT_NPM_TOKEN"));
  assert.ok(result.findings.some((finding) => finding.code === "MEMORY_LINT_PROVIDER_SESSION_ID"));
  assert.equal(lintSkillForPromotion("not a skill").ok, false);
});

test("SkillCandidate@v1 requires evidence and explicit create/update semantics", () => {
  const binding = {
    databaseUuid: "db-1",
    owner: { repositoryKey: "a".repeat(64), worktreeKey: "b".repeat(64) },
    sourceInputDigest: "c".repeat(64),
    selection: {
      requestDigest: "d".repeat(64),
      resultSetDigest: "e".repeat(64),
      sourceBindingDigest: "f".repeat(64),
    },
    turnRevisions: [],
    payloadDigests: [],
    deliveryEdgeRevisions: [],
    promptVersion: "agent-skill@1",
    schemaVersion: "threadshare-history@v1",
    chunkerVersion: "turn-chunk@1",
    provenance: { snapshotSeq: "1", evaluatedAt: "2026-08-22T00:00:00.000Z" },
  };
  const candidate = skillCandidateSchema.parse({
    format: MEMORY_SKILL_CANDIDATE_FORMAT,
    taskId: "recall-task-1",
    binding,
    memoryContextDigest: "9".repeat(64),
    skill: {
      name: "release-checks",
      description: "Run release checks.",
      body: "## Procedure\nRun the checks.\n",
      action: "create",
      expectedContentDigest: null,
    },
    statements: [{ statementId: "s1", text: "The team runs checks.", evidenceIds: ["ev-1"] }],
  });
  assert.equal(candidate.skill.name, "release-checks");
  assert.throws(() => skillCandidateSchema.parse((({ memoryContextDigest: _, ...value }) => value)(candidate)));
  assert.throws(() => skillCandidateSchema.parse({
    ...candidate,
    skill: { ...candidate.skill, action: "update", expectedContentDigest: null },
  }));
  assert.throws(() => skillCandidateSchema.parse({
    ...candidate,
    statements: [{ ...candidate.statements[0], evidenceIds: [] }],
  }));
  assert.throws(() => skillCandidateSchema.parse({
    ...candidate,
    statements: [candidate.statements[0], candidate.statements[0]],
  }));
  assert.throws(() => skillCandidateSchema.parse({
    ...candidate,
    statements: [{ ...candidate.statements[0], evidenceIds: ["ev-1", "ev-1"] }],
  }));
  assert.throws(() => candidateDraftBatchSchema.parse({
    format: "threadshare-memory-candidate-draft-batch@v1",
    taskId: candidate.taskId,
    binding,
    candidates: [{
      content: candidate.skill.body,
      type: "work_method",
      priority: 50,
      confidence: "medium",
      scene: null,
      statements: candidate.statements,
      skill: candidate.skill,
    }],
  }));
});
