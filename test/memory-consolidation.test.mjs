import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  MEMORY_CONSOLIDATION_PATCH_FORMAT,
  MEMORY_CONSOLIDATION_TASK_FORMAT,
  memoryDigestHex,
} from "../src/memory-contracts.mjs";
import {
  CONSOLIDATION_HEAT_MAX,
  MemoryConsolidationError,
  countConsolidationCharacters,
  materializeConsolidationPatch,
  normalizeConsolidationText,
} from "../src/memory-consolidation.mjs";

const HEX = (character) => character.repeat(64);
const digestText = (value) => createHash("sha256").update(value, "utf8").digest("hex");

function sceneText(name, heat, body = `# ${name}\n\nExisting guidance.\n`) {
  return [
    "-----META-START-----",
    "created: 2026-08-01",
    "updated: 2026-08-20",
    `summary: ${name}`,
    `heat: ${heat}`,
    "-----META-END-----",
    body,
  ].join("\n");
}

function runnerSceneText(name, body = `# ${name}\n\nNew guidance.\n`, heat = "999999") {
  return [
    "-----META-START-----",
    "created: 2026-08-01",
    "updated: 2026-08-21",
    `summary: ${name}`,
    `heat: ${heat}`,
    "-----META-END-----",
    body,
  ].join("\n");
}

function task({ sceneCount = 2, sceneHeats = [], entries = null, doctrine = null } = {}) {
  const taskEntries = entries ?? [{
    entryId: "release.entry-1",
    revision: 2,
    contentDigest: HEX("1"),
    type: "work_method",
    scene: "release",
    priority: 80,
    confidence: "high",
    body: "Run release verification before publishing.",
  }];
  const scenes = Array.from({ length: sceneCount }, (_, index) => {
    const name = `scene-${String(index + 1).padStart(2, "0")}`;
    const heat = sceneHeats[index] ?? index + 1;
    const content = sceneText(name, heat);
    return { name, heat, content, contentDigest: digestText(content) };
  });
  const doctrineValue = doctrine === null ? null : {
    content: doctrine,
    contentDigest: digestText(doctrine),
  };
  const binding = {
    databaseUuid: "database-1",
    memoryStateUuid: "memory-state-1",
    owner: { repositoryKey: HEX("a"), worktreeKey: HEX("b") },
    approvedProjection: {
      generation: 7,
      analyzerVersion: "memory-approved@1",
      coverage: "complete",
      sourceTreeDigest: HEX("c"),
    },
    entrySetDigest: memoryDigestHex(taskEntries.map(({ entryId, revision, contentDigest }) => ({
      entryId, revision, contentDigest,
    }))),
    entryRevisions: taskEntries.map(({ entryId, revision, contentDigest }) => ({
      entryId, revision, contentDigest,
    })),
    sceneIndexDigest: memoryDigestHex(scenes.map(({ name, contentDigest, heat }) => ({
      name, contentDigest, heat,
    }))),
    sceneRevisions: scenes.map(({ name, contentDigest, heat }) => ({ name, contentDigest, heat })),
    doctrineDigest: doctrineValue?.contentDigest ?? null,
    replay: { mode: "incremental", afterSuccessfulRunId: null },
    promptVersion: "memory-prompts@1",
    schemaVersion: MEMORY_CONSOLIDATION_TASK_FORMAT,
    policyVersion: "consolidation-policy@1",
  };
  return {
    format: MEMORY_CONSOLIDATION_TASK_FORMAT,
    taskId: "consolidation-task-1",
    lease: { holder: "cli-1", expiresAt: 2_000_000_000_000 },
    binding,
    entries: taskEntries,
    scenes,
    doctrine: doctrineValue,
    policy: {
      maxScenes: 15,
      mergePreferredAt: 12,
      createForbiddenAt: 14,
      dueEntryCount: 20,
      heatAlgorithm: "scene-heat@1",
    },
    contract: {
      patchSchema: MEMORY_CONSOLIDATION_PATCH_FORMAT,
      prompts: { promptVersion: "memory-prompts@1", consolidation: "Consolidate." },
    },
  };
}

function operation(overrides = {}) {
  return {
    operationId: "operation-1",
    op: "update",
    target: "scene",
    name: "scene-01",
    newContent: runnerSceneText("scene-01"),
    basedOnEntryIds: ["release.entry-1"],
    mergeSources: [],
    rationale: "Fold the approved release guidance into the existing scene.",
    ...overrides,
  };
}

function patchFor(inputTask, operations) {
  return {
    format: MEMORY_CONSOLIDATION_PATCH_FORMAT,
    taskId: inputTask.taskId,
    binding: structuredClone(inputTask.binding),
    operations,
  };
}

function assertCode(fn, code) {
  assert.throws(fn, (error) => {
    assert.ok(error instanceof MemoryConsolidationError);
    assert.equal(error.code, code, error.message);
    return true;
  });
}

test("normalizes CRLF and trailing whitespace before Unicode code-point counting", () => {
  const normalized = normalizeConsolidationText("中文  \r\n😀\t\r\ne\u0301 \r\n\r\n");
  assert.equal(normalized, "中文\n😀\ne\u0301\n\n");
  assert.equal(countConsolidationCharacters(normalized), 9);
  assert.equal(countConsolidationCharacters("👩‍💻"), 3);
});

test("shares Unicode normalization, digest, and boundary vectors with Rust", async () => {
  const fixture = JSON.parse(await readFile(new URL(
    "./fixtures/memory-consolidation-unicode-vectors.v1.json",
    import.meta.url,
  ), "utf8"));
  assert.equal(fixture.format, "threadshare-memory-consolidation-unicode-vectors@v1");
  for (const vector of fixture.vectors) {
    const input = vector.input.unit.repeat(vector.input.repeat);
    const expected = vector.normalized.unit.repeat(vector.normalized.repeat);
    const normalized = normalizeConsolidationText(input);
    assert.equal(normalized, expected, vector.name);
    assert.equal(countConsolidationCharacters(normalized), vector.codePointCount, vector.name);
    assert.equal(digestText(normalized), vector.sha256, vector.name);
    assert.equal(
      countConsolidationCharacters(normalized) <= vector.maxCodePoints,
      vector.accepted,
      vector.name,
    );
  }
});

test("host rewrites Runner heat and binds the materialized operation", () => {
  const inputTask = task({ sceneCount: 1, sceneHeats: [7] });
  const result = materializeConsolidationPatch({
    task: inputTask,
    patch: patchFor(inputTask, [operation()]),
    candidateId: "candidate-consolidation-1",
    runId: "run-1",
  });

  assert.equal(result.operations[0].newContent.includes("heat: 8"), true);
  assert.equal(result.operations[0].newContent.includes("999999"), false);
  assert.deepEqual(result.files, [{
    operation: "write",
    targetPath: ".threadshare/memory/scenes/scene-01.md",
    content: result.operations[0].newContent,
  }]);
  assert.equal(result.assessments[0].provenanceStrength, "contextual");
  assert.equal(result.assessments[0].claimSupport, "unverified");
  assert.equal(
    result.assessments[0].statementTextDigest,
    memoryDigestHex(result.operations[0]),
  );
  assert.deepEqual(result.candidatePayload.statements, [{
    statementId: "operation-1",
    operation: result.operations[0],
  }]);
});

test("create heat is 1 and merge heat is source sum plus 1", () => {
  const createTask = task({ sceneCount: 2 });
  const created = materializeConsolidationPatch({
    task: createTask,
    patch: patchFor(createTask, [operation({
      op: "create",
      name: "new-scene",
      newContent: runnerSceneText("new-scene", "# New\n", "not-a-number"),
      rationale: "This approved workflow has no coherent existing scene.",
    })]),
    candidateId: "candidate-1",
    runId: "run-1",
  });
  assert.match(created.operations[0].newContent, /\nheat: 1\n/);

  const mergeTask = task({ sceneCount: 3, sceneHeats: [3, 5, 7] });
  const merged = materializeConsolidationPatch({
    task: mergeTask,
    patch: patchFor(mergeTask, [operation({
      op: "merge",
      name: "scene-01",
      mergeSources: ["scene-01", "scene-02"],
      rationale: "These two scenes are one reusable workflow.",
    })]),
    candidateId: "candidate-2",
    runId: "run-2",
  });
  assert.match(merged.operations[0].newContent, /\nheat: 9\n/);
  assert.deepEqual(merged.files.map(({ operation: op, targetPath }) => ({ op, targetPath })), [
    { op: "write", targetPath: ".threadshare/memory/scenes/scene-01.md" },
    { op: "delete", targetPath: ".threadshare/memory/scenes/scene-02.md" },
  ]);
});

test("rejects binding drift, unknown entries, duplicate operation ids, and conflicting writers", () => {
  const inputTask = task({ sceneCount: 2 });
  const drifted = patchFor(inputTask, [operation()]);
  drifted.binding.entrySetDigest = HEX("f");
  assertCode(() => materializeConsolidationPatch({ task: inputTask, patch: drifted }), "binding-drift");

  assertCode(() => materializeConsolidationPatch({
    task: inputTask,
    patch: patchFor(inputTask, [operation({ basedOnEntryIds: ["unknown-entry"] })]),
  }), "unknown-entry");

  assertCode(() => materializeConsolidationPatch({
    task: inputTask,
    patch: patchFor(inputTask, [operation(), operation({ name: "scene-02" })]),
  }), "duplicate-operation-id");

  assertCode(() => materializeConsolidationPatch({
    task: inputTask,
    patch: patchFor(inputTask, [
      operation(),
      operation({ operationId: "operation-2", op: "delete", newContent: null }),
    ]),
  }), "conflicting-file-operation");
});

test("enforces scene capacity at 12, 14, and 15", () => {
  const atTwelve = task({ sceneCount: 12 });
  assertCode(() => materializeConsolidationPatch({
    task: atTwelve,
    patch: patchFor(atTwelve, [operation({
      op: "create",
      name: "new-scene",
      rationale: "A useful new scene.",
    })]),
  }), "create-rationale-required");
  assert.doesNotThrow(() => materializeConsolidationPatch({
    task: atTwelve,
    patch: patchFor(atTwelve, [operation({
      op: "create",
      name: "new-scene",
      rationale: "This cannot fit any existing scene without mixing unrelated workflows.",
    })]),
  }));

  const atFourteen = task({ sceneCount: 14 });
  assertCode(() => materializeConsolidationPatch({
    task: atFourteen,
    patch: patchFor(atFourteen, [operation({ op: "create", name: "new-scene" })]),
  }), "create-forbidden");

  const atFifteen = task({ sceneCount: 15 });
  assertCode(() => materializeConsolidationPatch({
    task: atFifteen,
    patch: patchFor(atFifteen, [operation()]),
  }), "scene-reduction-required");
  assert.doesNotThrow(() => materializeConsolidationPatch({
    task: atFifteen,
    patch: patchFor(atFifteen, [operation({
      op: "merge",
      name: "scene-01",
      mergeSources: ["scene-01", "scene-02"],
    })]),
  }));
});

test("rejects merge source conflicts, heat overflow, and invalid doctrine operations", () => {
  const mergeTask = task({ sceneCount: 3 });
  assertCode(() => materializeConsolidationPatch({
    task: mergeTask,
    patch: patchFor(mergeTask, [
      operation({ op: "merge", mergeSources: ["scene-01", "scene-02"] }),
      operation({ operationId: "operation-2", name: "scene-02" }),
    ]),
  }), "merge-source-conflict");

  const hotTask = task({ sceneCount: 1, sceneHeats: [CONSOLIDATION_HEAT_MAX] });
  assertCode(() => materializeConsolidationPatch({
    task: hotTask,
    patch: patchFor(hotTask, [operation()]),
  }), "heat-overflow");

  const doctrineTask = task({ sceneCount: 1 });
  assertCode(() => materializeConsolidationPatch({
    task: doctrineTask,
    patch: patchFor(doctrineTask, [operation({
      target: "doctrine",
      name: "team-rules",
      newContent: "Stable rule.",
    })]),
  }), "invalid-doctrine-name");
  assertCode(() => materializeConsolidationPatch({
    task: doctrineTask,
    patch: patchFor(doctrineTask, [operation({
      target: "doctrine",
      name: "doctrine",
      op: "merge",
      mergeSources: ["scene-01", "scene-02"],
      newContent: "Stable rule.",
    })]),
  }), "invalid-doctrine-operation");
});

test("rejects over-budget normalized scene and doctrine text", () => {
  const inputTask = task({ sceneCount: 1 });
  assertCode(() => materializeConsolidationPatch({
    task: inputTask,
    patch: patchFor(inputTask, [operation({
      newContent: runnerSceneText("scene-01", "😀".repeat(1501)),
    })]),
  }), "invalid-scene-content");
  assertCode(() => materializeConsolidationPatch({
    task: inputTask,
    patch: patchFor(inputTask, [operation({
      target: "doctrine",
      name: "doctrine",
      op: "create",
      newContent: "中".repeat(1201),
      mergeSources: [],
    })]),
  }), "invalid-doctrine-content");
});

test("empty patch is a visible no-op without a candidate", () => {
  const inputTask = task({ sceneCount: 1 });
  const result = materializeConsolidationPatch({
    task: inputTask,
    patch: patchFor(inputTask, []),
    candidateId: "candidate-unused",
    runId: "run-1",
  });
  assert.equal(result.noOp, true);
  assert.equal(result.entryCount, 1);
  assert.equal(result.candidatePayload, null);
  assert.deepEqual(result.assessments, []);
  assert.deepEqual(result.files, []);
});
