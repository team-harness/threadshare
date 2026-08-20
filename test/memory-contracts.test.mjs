import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  MEMORY_ADJUDICATION_RESULT_FORMAT,
  MEMORY_ADJUDICATION_TASK_FORMAT,
  MEMORY_AUTHORIZATION_MANIFEST_FORMAT,
  MEMORY_CANDIDATE_DRAFT_BATCH_FORMAT,
  MEMORY_CONSOLIDATION_PATCH_FORMAT,
  MEMORY_CONTRACT_FORMATS,
  MEMORY_DECIMAL_PATTERN,
  MEMORY_EVIDENCE_ASSESSMENT_FORMAT,
  MEMORY_EXTRACTION_TASK_FORMAT,
  MEMORY_HEX40_PATTERN,
  MEMORY_HEX64_PATTERN,
  MEMORY_ID_PATTERN,
  MEMORY_PROMOTION_PLAN_FORMAT,
  MEMORY_REPOSITORY_BINDING_FORMAT,
  MEMORY_RESTRICTED_EXTRACTION_RUNNER_FORMAT,
  MEMORY_RUNNER_EXECUTION_PLAN_FORMAT,
  MEMORY_SLUG_PATTERN,
  adjudicationResultSchema,
  adjudicationTaskSchema,
  authorizationManifestSchema,
  candidateDraftBatchSchema,
  computeManifestDigest,
  computePlanDigest,
  computeRunnerInputDigest,
  consolidationPatchSchema,
  evidenceAssessmentSchema,
  extractionTaskSchema,
  memoryDigestHex,
  parseMemoryContract,
  promotionPlanSchema,
  repositoryBindingSchema,
  restrictedExtractionRunnerSchema,
  runnerExecutionPlanSchema,
} from "../src/memory-contracts.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";

const HEX = (character) => character.repeat(64);

function repositoryBinding() {
  return {
    format: MEMORY_REPOSITORY_BINDING_FORMAT,
    repositoryKey: HEX("1"),
    worktreeKey: HEX("2"),
    publicRepositoryIdentity: "github.com/team-harness/threadshare",
    rootRealpathDigest: HEX("3"),
    commonDirectoryIdentity: { device: "16777232", inode: "987654" },
    memoryRoot: ".threadshare/memory",
  };
}

function restrictedExtractionRunner() {
  return {
    format: MEMORY_RESTRICTED_EXTRACTION_RUNNER_FORMAT,
    adapter: "claude-cli",
    version: "2.1.0",
    argvTemplate: ["claude", "-p", "--tools", "none"],
    toolPolicy: "none",
    network: "model-only",
    ephemeral: "required",
    timeoutMs: 120000,
    maxOutputBytes: 1048576,
    conformance: {
      testVersion: "conformance-test@1",
      passedAt: "2026-08-20T00:00:00.000Z",
      cliVersionFingerprint: HEX("4"),
    },
  };
}

function runnerExecutionPlan() {
  return {
    format: MEMORY_RUNNER_EXECUTION_PLAN_FORMAT,
    planDigest: null,
    taskKind: "extraction",
    taskId: "task-0001",
    runnerInputDigest: HEX("5"),
    inputCoverageDigest: HEX("6"),
    inputCoverage: [{
      sourceKind: "transcript",
      opaqueSourceId: "chunk-1",
      revision: null,
      contentDigest: HEX("7"),
      bytes: 40960,
      truncated: false,
    }],
    runnerProfile: "claude-default",
    provider: "anthropic",
    model: "claude-example-model",
    endpoint: "https://api.anthropic.com/v1/messages",
    bytesToSend: 40960,
    localSessionPersistence: "none",
    providerRetention: "no-retention",
    authorization: "pending",
  };
}

function authorizationManifest() {
  return {
    format: MEMORY_AUTHORIZATION_MANIFEST_FORMAT,
    manifestDigest: null,
    plans: [{
      planDigest: HEX("8"),
      taskKind: "extraction",
      taskId: "task-0001",
      bytesToSend: 40960,
    }],
    totalBytes: 40960,
    authorization: "pending",
  };
}

function extractionBinding() {
  return {
    databaseUuid: "11111111-2222-4333-8444-555555555555",
    owner: { repositoryKey: HEX("1"), worktreeKey: HEX("2") },
    sourceInputDigest: HEX("9"),
    turnRevisions: [HEX("4"), HEX("5"), HEX("6")],
    payloadDigests: [HEX("a")],
    deliveryEdgeRevisions: [HEX("7")],
    promptVersion: "extraction-prompt@1",
    schemaVersion: "threadshare-memory-extraction-task@v1",
    chunkerVersion: "chunker@1",
    provenance: { snapshotSeq: "42", evaluatedAt: "2026-08-20T00:00:00.000Z" },
  };
}

function extractionTask() {
  return {
    format: MEMORY_EXTRACTION_TASK_FORMAT,
    taskId: "task-0001",
    lease: { holder: "cli-1234", expiresAt: 1766200000000 },
    binding: extractionBinding(),
    session: {
      project: "threadshare",
      repositoryKey: HEX("1"),
      timeWindow: { start: "2026-08-19T00:00:00.000Z", end: "2026-08-20T00:00:00.000Z" },
    },
    evidenceCatalog: [{
      evidenceId: "ev-1",
      kind: "commit",
      pointerDigest: HEX("b"),
      display: "483ce01 feat(insights): attribute delivery per turn",
    }],
    chunk: {
      turnRange: { start: 0, end: 7 },
      coverage: [{ sourceKind: "turn", ref: "turn:0", completeness: "full", bytes: 2048 }],
      transcript: "<<past-user>>\nhello\n\n<<end-of-transcript>>",
    },
    context: { sceneIndexSummary: null },
    contract: {
      draftSchema: "threadshare-memory-candidate-draft-batch@v1",
      prompts: { promptVersion: "extraction-prompt@1", extraction: "Extract memory candidates." },
    },
  };
}

function draftCandidate() {
  return {
    content: "Release tests are grouped under npm run test:release.",
    type: "work_method",
    priority: 60,
    confidence: "high",
    scene: "release-workflow",
    statements: [{ statementId: "s-1", text: "test:release covers protocol tests.", evidenceIds: ["ev-1"] }],
  };
}

function candidateDraftBatch() {
  return {
    format: MEMORY_CANDIDATE_DRAFT_BATCH_FORMAT,
    taskId: "task-0001",
    binding: extractionBinding(),
    candidates: [draftCandidate()],
  };
}

function evidenceAssessment() {
  return {
    format: MEMORY_EVIDENCE_ASSESSMENT_FORMAT,
    candidateId: "cand-1",
    statementId: "s-1",
    citations: [{ evidenceId: "ev-1", pointerDigest: HEX("b") }],
    provenanceStrength: "direct",
    limitations: ["single-session"],
    claimSupport: "unverified",
    assessedBy: "deterministic",
    statementTextDigest: HEX("c"),
    revision: 1,
  };
}

function adjudicationBinding() {
  return {
    databaseUuid: "11111111-2222-4333-8444-555555555555",
    memoryStateUuid: "66666666-7777-4888-9999-aaaaaaaaaaaa",
    owner: { repositoryKey: HEX("1"), worktreeKey: HEX("2") },
    draftBatchDigest: HEX("d"),
    approvedProjection: { generation: 3, analyzerVersion: "analyzer@1" },
    candidateProjection: { generation: 5, analyzerVersion: "analyzer@1" },
    recallAlgorithmVersion: "recall-rrf@1",
    recallQueryDigest: HEX("e"),
    resultSetDigest: HEX("f"),
    poolItemRevisions: [{ sourceKind: "approved", id: "release-workflow-notes", revision: 2 }],
    promptVersion: "adjudication-prompt@1",
    schemaVersion: "threadshare-memory-adjudication-task@v1",
  };
}

function adjudicationTask() {
  return {
    format: MEMORY_ADJUDICATION_TASK_FORMAT,
    taskId: "task-0002",
    lease: { holder: "cli-1234", expiresAt: 1766200000000 },
    binding: adjudicationBinding(),
    drafts: [{ candidateId: "cand-1", ...draftCandidate() }],
    recallSets: [{
      draftRef: "cand-1",
      ordered: [{ rank: 1, sourceKind: "approved", id: "release-workflow-notes" }],
    }],
    pool: [{
      sourceKind: "approved",
      id: "release-workflow-notes",
      revision: 2,
      contentDigest: HEX("0"),
      state: "active",
      summary: "Notes about the release workflow.",
    }],
    contract: {
      resultSchema: "threadshare-memory-adjudication-result@v1",
      prompts: { promptVersion: "adjudication-prompt@1", adjudication: "Adjudicate drafts." },
    },
  };
}

function adjudicationResult() {
  return {
    format: MEMORY_ADJUDICATION_RESULT_FORMAT,
    taskId: "task-0002",
    binding: adjudicationBinding(),
    adjudications: [{
      draftRef: "cand-1",
      action: "merge",
      targetIds: ["release-workflow-notes"],
      mergedFields: { content: "Merged release workflow content.", priority: 70, occurred: ["2026-08-20"] },
    }],
  };
}

function consolidationPatch() {
  return {
    format: MEMORY_CONSOLIDATION_PATCH_FORMAT,
    taskId: "task-0003",
    binding: adjudicationBinding(),
    operations: [{
      op: "merge",
      target: "scene",
      name: "release-workflow",
      newContent: "# Release workflow\nConsolidated notes.",
      basedOnEntryIds: ["release-workflow-notes"],
      mergeSources: ["release-steps"],
    }],
  };
}

function promotionPlan() {
  return {
    format: MEMORY_PROMOTION_PLAN_FORMAT,
    planId: "plan-0001",
    owner: repositoryBinding(),
    candidateIds: ["cand-1"],
    assessmentDigest: HEX("1"),
    perFile: [{
      targetPath: ".threadshare/memory/entries/release-workflow-notes.md",
      targetBlobHash: null,
      sanitizedContentDigest: HEX("2"),
    }],
    policyVersion: "promotion-policy@1",
    diff: "--- a/.threadshare/memory/entries/release-workflow-notes.md\n+++ b/...",
  };
}

const CONTRACT_CASES = [
  {
    name: "repository binding",
    schema: repositoryBindingSchema,
    sample: repositoryBinding,
    invalid: (value) => ({ ...value, repositoryKey: HEX("A") }),
    schemaFile: null,
  },
  {
    name: "restricted extraction runner",
    schema: restrictedExtractionRunnerSchema,
    sample: restrictedExtractionRunner,
    invalid: (value) => ({ ...value, adapter: "gemini-cli" }),
    schemaFile: null,
  },
  {
    name: "runner execution plan",
    schema: runnerExecutionPlanSchema,
    sample: runnerExecutionPlan,
    invalid: (value) => ({ ...value, runnerInputDigest: "not-a-digest" }),
    schemaFile: "threadshare-memory-runner-execution-plan.v1.schema.json",
  },
  {
    name: "authorization manifest",
    schema: authorizationManifestSchema,
    sample: authorizationManifest,
    invalid: (value) => ({ ...value, totalBytes: -1 }),
    schemaFile: "threadshare-memory-authorization-manifest.v1.schema.json",
  },
  {
    name: "extraction task",
    schema: extractionTaskSchema,
    sample: extractionTask,
    invalid: (value) => ({
      ...value,
      evidenceCatalog: [{ ...value.evidenceCatalog[0], kind: "screenshot" }],
    }),
    schemaFile: "threadshare-memory-extraction-task.v1.schema.json",
  },
  {
    name: "candidate draft batch",
    schema: candidateDraftBatchSchema,
    sample: candidateDraftBatch,
    invalid: (value) => ({ ...value, candidates: [{ ...value.candidates[0], priority: 101 }] }),
    schemaFile: "threadshare-memory-candidate-draft-batch.v1.schema.json",
  },
  {
    name: "evidence assessment",
    schema: evidenceAssessmentSchema,
    sample: evidenceAssessment,
    invalid: (value) => ({ ...value, claimSupport: "verified" }),
    schemaFile: null,
  },
  {
    name: "adjudication task",
    schema: adjudicationTaskSchema,
    sample: adjudicationTask,
    invalid: (value) => ({
      ...value,
      recallSets: [{
        ...value.recallSets[0],
        ordered: [{ ...value.recallSets[0].ordered[0], rank: 0 }],
      }],
    }),
    schemaFile: "threadshare-memory-adjudication-task.v1.schema.json",
  },
  {
    name: "adjudication result",
    schema: adjudicationResultSchema,
    sample: adjudicationResult,
    invalid: (value) => ({ ...value, adjudications: [{ ...value.adjudications[0], action: "discard" }] }),
    schemaFile: "threadshare-memory-adjudication-result.v1.schema.json",
  },
  {
    name: "consolidation patch",
    schema: consolidationPatchSchema,
    sample: consolidationPatch,
    invalid: (value) => ({ ...value, operations: [{ ...value.operations[0], target: "entry" }] }),
    schemaFile: null,
  },
  {
    name: "promotion plan",
    schema: promotionPlanSchema,
    sample: promotionPlan,
    invalid: (value) => ({
      ...value,
      perFile: [{ ...value.perFile[0], targetBlobHash: "z".repeat(40) }],
    }),
    schemaFile: "threadshare-memory-promotion-plan.v1.schema.json",
  },
];

test("every contract format has exactly one schema and case", () => {
  const formats = Object.keys(MEMORY_CONTRACT_FORMATS);
  assert.equal(formats.length, 11);
  assert.equal(CONTRACT_CASES.length, 11);
  for (const format of formats) {
    assert.match(format, /^threadshare-memory-[a-z0-9-]+@v1$/);
  }
  const caseFormats = CONTRACT_CASES.map(({ sample }) => sample().format).sort();
  assert.deepEqual(caseFormats, [...formats].sort());
});

for (const { name, schema, sample, invalid } of CONTRACT_CASES) {
  test(`${name}: valid sample parses`, () => {
    const value = sample();
    assert.deepEqual(schema.parse(value), value);
  });

  test(`${name}: extra field is rejected`, () => {
    assert.throws(() => schema.parse({ ...sample(), extraneous: true }));
  });

  test(`${name}: targeted invalid sample is rejected`, () => {
    assert.throws(() => schema.parse(invalid(sample())));
  });
}

test("parseMemoryContract dispatches by format", () => {
  for (const { sample } of CONTRACT_CASES) {
    const value = sample();
    assert.deepEqual(parseMemoryContract(value), value);
  }
});

test("parseMemoryContract rejects unknown and missing formats", () => {
  assert.throws(
    () => parseMemoryContract({ format: "threadshare-memory-unknown@v9" }),
    /unknown memory contract format: threadshare-memory-unknown@v9/,
  );
  assert.throws(() => parseMemoryContract({}), /unknown memory contract format/);
  assert.throws(() => parseMemoryContract(null), TypeError);
  assert.throws(() => parseMemoryContract([]), TypeError);
});

test("validation patterns pin the documented shapes", () => {
  assert.match("a".repeat(64), MEMORY_HEX64_PATTERN);
  assert.doesNotMatch("A".repeat(64), MEMORY_HEX64_PATTERN);
  assert.doesNotMatch("a".repeat(63), MEMORY_HEX64_PATTERN);
  assert.match("0".repeat(40), MEMORY_HEX40_PATTERN);
  assert.doesNotMatch("0".repeat(41), MEMORY_HEX40_PATTERN);
  assert.match("Task_1.alpha-2", MEMORY_ID_PATTERN);
  assert.doesNotMatch("-leading-dash", MEMORY_ID_PATTERN);
  assert.doesNotMatch(`x${"y".repeat(128)}`, MEMORY_ID_PATTERN);
  assert.match("release-workflow", MEMORY_SLUG_PATTERN);
  assert.doesNotMatch("Release-Workflow", MEMORY_SLUG_PATTERN);
  assert.doesNotMatch("-release", MEMORY_SLUG_PATTERN);
  assert.doesNotMatch(`a${"b".repeat(64)}`, MEMORY_SLUG_PATTERN);
});

test("rev2 type corrections: wire revisions are hex64, sequences and identity are decimal strings", () => {
  // provenance.snapshotSeq is a canonical decimal string.
  assert.match("0", MEMORY_DECIMAL_PATTERN);
  assert.match("42", MEMORY_DECIMAL_PATTERN);
  assert.doesNotMatch("042", MEMORY_DECIMAL_PATTERN);
  assert.doesNotMatch("", MEMORY_DECIMAL_PATTERN);
  assert.doesNotMatch("-1", MEMORY_DECIMAL_PATTERN);

  // RepositoryBinding.commonDirectoryIdentity.device/inode are decimal strings.
  const binding = repositoryBinding();
  assert.throws(() => repositoryBindingSchema.parse({
    ...binding,
    commonDirectoryIdentity: { device: 16777232, inode: "987654" },
  }));
  assert.throws(() => repositoryBindingSchema.parse({
    ...binding,
    commonDirectoryIdentity: { device: "016777232", inode: "987654" },
  }));

  // ExtractionTask binding turnRevisions/deliveryEdgeRevisions are hex64 arrays,
  // snapshotSeq is a decimal string.
  const task = extractionTask();
  assert.throws(() => extractionTaskSchema.parse({
    ...task,
    binding: { ...task.binding, turnRevisions: [1] },
  }));
  assert.throws(() => extractionTaskSchema.parse({
    ...task,
    binding: { ...task.binding, deliveryEdgeRevisions: [1] },
  }));
  assert.throws(() => extractionTaskSchema.parse({
    ...task,
    binding: {
      ...task.binding,
      provenance: { ...task.binding.provenance, snapshotSeq: 42 },
    },
  }));
});

test("candidate scene names are free-form bounded strings (Chinese scene names work)", () => {
  const batch = candidateDraftBatch();
  const withScene = (scene) => ({
    ...batch,
    candidates: [{ ...batch.candidates[0], scene }],
  });
  assert.deepEqual(
    candidateDraftBatchSchema.parse(withScene("发布流程")),
    withScene("发布流程"),
  );
  assert.deepEqual(candidateDraftBatchSchema.parse(withScene(null)), withScene(null));
  assert.throws(() => candidateDraftBatchSchema.parse(withScene("")));
  assert.throws(() => candidateDraftBatchSchema.parse(withScene("x".repeat(201))));

  const result = adjudicationResult();
  const merged = {
    ...result,
    adjudications: [{
      ...result.adjudications[0],
      mergedFields: { ...result.adjudications[0].mergedFields, scene: "发布流程" },
    }],
  };
  assert.deepEqual(adjudicationResultSchema.parse(merged), merged);
});

test("memoryDigestHex is key-order independent and value sensitive", () => {
  const left = { alpha: 1, nested: { deep: [1, 2, 3], flag: true }, zeta: "z" };
  const right = { zeta: "z", nested: { flag: true, deep: [1, 2, 3] }, alpha: 1 };
  assert.equal(memoryDigestHex(left), memoryDigestHex(right));
  assert.notEqual(memoryDigestHex(left), memoryDigestHex({ ...left, alpha: 2 }));
  assert.equal(
    memoryDigestHex(left),
    createHash("sha256").update(canonicalJson(left), "utf8").digest("hex"),
  );
});

test("computePlanDigest ignores planDigest and authorization but nothing else", () => {
  const plan = runnerExecutionPlan();
  const baseline = computePlanDigest(plan);
  assert.match(baseline, MEMORY_HEX64_PATTERN);
  assert.equal(computePlanDigest({ ...plan, planDigest: baseline }), baseline);
  assert.equal(computePlanDigest({ ...plan, authorization: "approved" }), baseline);
  assert.notEqual(computePlanDigest({ ...plan, bytesToSend: plan.bytesToSend + 1 }), baseline);
  assert.notEqual(computePlanDigest({ ...plan, model: "other-model" }), baseline);
});

test("computeManifestDigest ignores manifestDigest and authorization but nothing else", () => {
  const manifest = authorizationManifest();
  const baseline = computeManifestDigest(manifest);
  assert.match(baseline, MEMORY_HEX64_PATTERN);
  assert.equal(computeManifestDigest({ ...manifest, manifestDigest: baseline }), baseline);
  assert.equal(computeManifestDigest({ ...manifest, authorization: "approved" }), baseline);
  assert.notEqual(computeManifestDigest({ ...manifest, totalBytes: 1 }), baseline);
});

test("computeRunnerInputDigest hashes exact bytes", () => {
  const text = "memory runner input é中";
  assert.equal(computeRunnerInputDigest(text), computeRunnerInputDigest(Buffer.from(text, "utf8")));
  assert.equal(
    computeRunnerInputDigest("abc"),
    createHash("sha256").update(Buffer.from("abc", "utf8")).digest("hex"),
  );
  assert.equal(
    computeRunnerInputDigest(new Uint8Array([1, 2, 3])),
    createHash("sha256").update(Buffer.from([1, 2, 3])).digest("hex"),
  );
  assert.notEqual(computeRunnerInputDigest("abcd"), computeRunnerInputDigest("abce"));
  assert.notEqual(
    computeRunnerInputDigest(new Uint8Array([0, 0, 0, 1])),
    computeRunnerInputDigest(new Uint8Array([0, 0, 0, 2])),
  );
  assert.throws(() => computeRunnerInputDigest(42), TypeError);
});

const JSON_SCHEMA_FILES = CONTRACT_CASES.filter(({ schemaFile }) => schemaFile !== null);

async function loadJsonSchemaValidators() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const validators = new Map();
  for (const { name, schemaFile } of JSON_SCHEMA_FILES) {
    const url = new URL(`../schema/${schemaFile}`, import.meta.url);
    const document = JSON.parse(await readFile(url, "utf8"));
    validators.set(name, { validate: ajv.compile(document), document });
  }
  return validators;
}

test("all seven memory JSON Schema files compile under ajv 2020-12", async () => {
  const validators = await loadJsonSchemaValidators();
  assert.equal(validators.size, 7);
  for (const [, { document }] of validators) {
    assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(document.additionalProperties, false);
    assert.match(document.$id, /^https:\/\/threadshare\.team-harness\.com\/schema\/threadshare-memory-/);
  }
});

test("zod-valid samples also satisfy the JSON Schema representation", async () => {
  const validators = await loadJsonSchemaValidators();
  for (const { name, schema, sample, invalid } of JSON_SCHEMA_FILES) {
    const { validate } = validators.get(name);
    const value = schema.parse(sample());
    assert.equal(validate(value), true, `${name}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({ ...sample(), extraneous: true }), false, `${name}: extra field`);
    assert.equal(validate(invalid(sample())), false, `${name}: targeted invalid sample`);
  }
});
