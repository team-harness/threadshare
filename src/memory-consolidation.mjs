// Deterministic host-side materialization for L2/L3 Team Memory consolidation.
// Runner output is only a proposal: this module validates every reference and
// policy constraint, normalizes text, rewrites scene heat, and derives the
// exact candidate statements and file mutations later reviewed by a human.

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.mjs";
import {
  MEMORY_CONSOLIDATION_PATCH_FORMAT,
  MEMORY_CONSOLIDATION_TASK_FORMAT,
  consolidationPatchSchema,
  consolidationTaskSchema,
  memoryDigestHex,
} from "./memory-contracts.mjs";
import { validateDoctrine, validateSceneBlock } from "./memory-format.mjs";
import { CONSOLIDATION_PROMPT, CONSOLIDATION_PROMPT_VERSION } from "./memory-prompts.mjs";

const META_START = "-----META-START-----";
const META_END = "-----META-END-----";
const CANNOT_FIT_PATTERN = /(?:cannot|can't|unable to).{0,100}(?:fit|merge|fold|incorporat)|(?:无法|不能).{0,60}(?:并入|合并|纳入)/iu;

export const CONSOLIDATION_HEAT_MAX = 2_147_483_647;

export class MemoryConsolidationError extends Error {
  constructor(message, code, meta = {}) {
    super(message);
    this.name = "MemoryConsolidationError";
    this.code = code;
    Object.assign(this, meta);
  }
}

function consolidationError(message, code, meta) {
  return new MemoryConsolidationError(message, code, meta);
}

function sha256Text(text) {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

/** Normalize before any count or digest: CRLF -> LF and strip line-end whitespace. */
export function normalizeConsolidationText(value) {
  if (typeof value !== "string") {
    throw consolidationError("consolidation content must be a string", "invalid-content");
  }
  if (value.startsWith("\uFEFF")) {
    throw consolidationError("consolidation content must not contain a UTF-8 BOM", "invalid-content");
  }
  const lf = value.replaceAll("\r\n", "\n");
  if (lf.includes("\r")) {
    throw consolidationError("consolidation content contains a bare carriage return", "invalid-content");
  }
  return lf.split("\n").map((line) => line.replace(/[\t ]+$/u, "")).join("\n");
}

/** Character budgets use Unicode scalar values/code points, matching Rust chars().count(). */
export function countConsolidationCharacters(value) {
  if (typeof value !== "string") throw new TypeError("value must be a string");
  return [...value].length;
}

function parseContract(schema, value, code) {
  const parsed = schema.safeParse(value);
  if (!parsed.success) {
    throw consolidationError(parsed.error.issues[0]?.message ?? `invalid ${code}`, code, {
      issues: parsed.error.issues,
    });
  }
  return parsed.data;
}

function assertUnique(values, code, label) {
  const seen = new Set();
  for (const value of values) {
    if (seen.has(value)) throw consolidationError(`${label} must be unique: ${value}`, code, { value });
    seen.add(value);
  }
}

function assertTaskIntegrity(task) {
  assertUnique(task.entries.map((entry) => entry.entryId), "duplicate-entry-id", "task entry ids");
  assertUnique(task.scenes.map((scene) => scene.name), "duplicate-scene-name", "task scene names");

  const entryRevisions = task.entries.map(({ entryId, revision, contentDigest }) => ({
    entryId, revision, contentDigest,
  }));
  if (canonicalJson(entryRevisions) !== canonicalJson(task.binding.entryRevisions)
    || memoryDigestHex(entryRevisions) !== task.binding.entrySetDigest) {
    throw consolidationError("task entries do not match the bound entry set", "invalid-task-binding");
  }

  const sceneRevisions = [];
  for (const scene of task.scenes) {
    if (sha256Text(scene.content) !== scene.contentDigest) {
      throw consolidationError(`scene ${scene.name} content digest does not match`, "invalid-task-binding");
    }
    let parsed;
    try {
      parsed = validateSceneBlock(scene.content);
    } catch (cause) {
      throw consolidationError(`scene ${scene.name} is invalid: ${cause.message}`, "invalid-task-scene", { cause });
    }
    if (parsed.meta.heat !== scene.heat || scene.heat > CONSOLIDATION_HEAT_MAX) {
      throw consolidationError(`scene ${scene.name} heat does not match its metadata`, "invalid-task-binding");
    }
    sceneRevisions.push({ name: scene.name, contentDigest: scene.contentDigest, heat: scene.heat });
  }
  if (canonicalJson(sceneRevisions) !== canonicalJson(task.binding.sceneRevisions)
    || memoryDigestHex(sceneRevisions) !== task.binding.sceneIndexDigest) {
    throw consolidationError("task scenes do not match the bound scene index", "invalid-task-binding");
  }

  const doctrineDigest = task.doctrine === null ? null : sha256Text(task.doctrine.content);
  if (doctrineDigest !== task.binding.doctrineDigest
    || (task.doctrine !== null && doctrineDigest !== task.doctrine.contentDigest)) {
    throw consolidationError("task doctrine does not match its binding", "invalid-task-binding");
  }
}

function checkedHeatAdd(left, right) {
  if (!Number.isSafeInteger(left) || !Number.isSafeInteger(right)
    || left < 0 || right < 0 || left > CONSOLIDATION_HEAT_MAX
    || right > CONSOLIDATION_HEAT_MAX || left > CONSOLIDATION_HEAT_MAX - right) {
    throw consolidationError("scene heat exceeds the supported range", "heat-overflow");
  }
  return left + right;
}

function materializeSceneContent(rawContent, heat, name) {
  let normalized;
  try {
    normalized = normalizeConsolidationText(rawContent);
  } catch (cause) {
    throw consolidationError(`scene ${name} content is invalid: ${cause.message}`, "invalid-scene-content", { cause });
  }
  const lines = normalized.split("\n");
  if (lines[0] !== META_START) {
    throw consolidationError(`scene ${name} must start with ${META_START}`, "invalid-scene-content");
  }
  const endIndex = lines.indexOf(META_END, 1);
  if (endIndex === -1) {
    throw consolidationError(`scene ${name} has no ${META_END}`, "invalid-scene-content");
  }
  const heatLines = lines.slice(1, endIndex).filter((line) => line.startsWith("heat: "));
  if (heatLines.length > 1) {
    throw consolidationError(`scene ${name} contains duplicate heat fields`, "invalid-scene-content");
  }
  const metaWithoutHeat = lines.slice(1, endIndex).filter((line) => !line.startsWith("heat: "));
  const temporary = [
    META_START,
    ...metaWithoutHeat,
    `heat: ${heat}`,
    META_END,
    ...lines.slice(endIndex + 1),
  ].join("\n");
  let parsed;
  try {
    parsed = validateSceneBlock(temporary);
  } catch (cause) {
    throw consolidationError(`scene ${name} content is invalid: ${cause.message}`, "invalid-scene-content", { cause });
  }
  return [
    META_START,
    `created: ${parsed.meta.created}`,
    `updated: ${parsed.meta.updated}`,
    `summary: ${JSON.stringify(parsed.meta.summary)}`,
    `heat: ${heat}`,
    META_END,
    parsed.body,
  ].join("\n");
}

function materializeDoctrineContent(rawContent) {
  let normalized;
  try {
    normalized = normalizeConsolidationText(rawContent);
    if (normalized.length === 0) throw new Error("doctrine content must not be empty");
    validateDoctrine(normalized);
  } catch (cause) {
    throw consolidationError(`doctrine content is invalid: ${cause.message}`, "invalid-doctrine-content", { cause });
  }
  return normalized;
}

function scenePath(name) {
  return `.threadshare/memory/scenes/${name}.md`;
}

function targetPath(operation) {
  return operation.target === "doctrine"
    ? ".threadshare/memory/doctrine.md"
    : scenePath(operation.name);
}

function validateReferences(operation, entryById, sceneByName, doctrinePresent) {
  assertUnique(operation.basedOnEntryIds, "duplicate-entry-reference", "basedOnEntryIds");
  assertUnique(operation.mergeSources, "duplicate-merge-source", "mergeSources");
  for (const entryId of operation.basedOnEntryIds) {
    if (!entryById.has(entryId)) {
      throw consolidationError(`operation ${operation.operationId} references unknown entry ${entryId}`, "unknown-entry");
    }
  }

  const writesContent = operation.op !== "delete";
  if (writesContent && (operation.newContent === null || operation.basedOnEntryIds.length === 0)) {
    throw consolidationError(
      `operation ${operation.operationId} requires content and at least one approved entry`,
      "invalid-operation-content",
    );
  }
  if (!writesContent && operation.newContent !== null) {
    throw consolidationError(`delete ${operation.operationId} must have null content`, "invalid-operation-content");
  }

  if (operation.target === "doctrine") {
    if (operation.name !== "doctrine") {
      throw consolidationError("doctrine operations must use name=doctrine", "invalid-doctrine-name");
    }
    if (operation.op === "merge" || operation.mergeSources.length > 0) {
      throw consolidationError("doctrine operations cannot merge scenes", "invalid-doctrine-operation");
    }
    if (operation.op === "create" && doctrinePresent) {
      throw consolidationError("doctrine already exists", "target-already-exists");
    }
    if ((operation.op === "update" || operation.op === "delete") && !doctrinePresent) {
      throw consolidationError("doctrine does not exist", "target-not-found");
    }
    return;
  }

  if (operation.op !== "merge" && operation.mergeSources.length > 0) {
    throw consolidationError("only merge may contain mergeSources", "invalid-merge-sources");
  }
  if (operation.op === "create" && sceneByName.has(operation.name)) {
    throw consolidationError(`scene ${operation.name} already exists`, "target-already-exists");
  }
  if ((operation.op === "update" || operation.op === "delete") && !sceneByName.has(operation.name)) {
    throw consolidationError(`scene ${operation.name} does not exist`, "target-not-found");
  }
  if (operation.op === "merge") {
    if (operation.mergeSources.length < 2) {
      throw consolidationError("merge requires at least two source scenes", "invalid-merge-sources");
    }
    for (const source of operation.mergeSources) {
      if (!sceneByName.has(source)) {
        throw consolidationError(`merge source ${source} does not exist`, "unknown-merge-source");
      }
    }
    if (sceneByName.has(operation.name) && !operation.mergeSources.includes(operation.name)) {
      throw consolidationError(
        `merge target ${operation.name} exists but is not one of its sources`,
        "conflicting-file-operation",
      );
    }
  }
}

function validateOperationConflicts(operations) {
  assertUnique(operations.map((operation) => operation.operationId),
    "duplicate-operation-id", "operation ids");
  const primaryWriters = new Map();
  let doctrineOperations = 0;
  let sceneCreates = 0;
  for (const operation of operations) {
    const file = targetPath(operation);
    if (primaryWriters.has(file)) {
      throw consolidationError(`multiple operations target ${file}`, "conflicting-file-operation");
    }
    primaryWriters.set(file, operation.operationId);
    if (operation.target === "doctrine") doctrineOperations += 1;
    if (operation.target === "scene" && operation.op === "create") sceneCreates += 1;
  }
  if (doctrineOperations > 1) {
    throw consolidationError("a patch may contain at most one doctrine operation", "conflicting-file-operation");
  }
  if (sceneCreates > 1) {
    throw consolidationError("a patch may create at most one scene", "too-many-scene-creates");
  }

  const mergeSourceOwners = new Map();
  for (const operation of operations.filter((item) => item.op === "merge")) {
    for (const source of operation.mergeSources) {
      const sourceFile = scenePath(source);
      if (mergeSourceOwners.has(sourceFile)) {
        throw consolidationError(`scene ${source} is used by multiple merges`, "merge-source-conflict");
      }
      mergeSourceOwners.set(sourceFile, operation.operationId);
      const primary = primaryWriters.get(sourceFile);
      if (primary !== undefined && primary !== operation.operationId) {
        throw consolidationError(`merge source ${source} is changed by another operation`, "merge-source-conflict");
      }
    }
  }
}

function deriveSceneHeat(operation, sceneByName) {
  if (operation.op === "create") return 1;
  if (operation.op === "update") return checkedHeatAdd(sceneByName.get(operation.name).heat, 1);
  if (operation.op === "merge") {
    let heat = 1;
    for (const source of operation.mergeSources) {
      heat = checkedHeatAdd(heat, sceneByName.get(source).heat);
    }
    return heat;
  }
  return null;
}

function applySceneCardinality(operations, initialNames) {
  const finalNames = new Set(initialNames);
  for (const operation of operations) {
    if (operation.target !== "scene") continue;
    if (operation.op === "delete") finalNames.delete(operation.name);
    else if (operation.op === "create") finalNames.add(operation.name);
    else if (operation.op === "merge") {
      for (const source of operation.mergeSources) finalNames.delete(source);
      finalNames.add(operation.name);
    }
  }
  return finalNames.size;
}

function validateCapacity(task, operations, finalSceneCount) {
  const currentSceneCount = task.scenes.length;
  const creates = operations.filter((operation) => operation.target === "scene" && operation.op === "create");
  if (currentSceneCount >= task.policy.createForbiddenAt && creates.length > 0) {
    throw consolidationError("scene creation is forbidden at the current capacity", "create-forbidden");
  }
  if (currentSceneCount >= task.policy.mergePreferredAt) {
    for (const operation of creates) {
      if (!CANNOT_FIT_PATTERN.test(operation.rationale)) {
        throw consolidationError(
          "scene creation at this capacity must explicitly say why it cannot fit an existing scene",
          "create-rationale-required",
        );
      }
    }
  }
  if (finalSceneCount > task.policy.maxScenes) {
    throw consolidationError("patch exceeds the maximum scene count", "scene-capacity-exceeded");
  }
  if (currentSceneCount >= task.policy.maxScenes
    && (finalSceneCount >= task.policy.maxScenes
      || !operations.some((operation) => operation.target === "scene"
        && (operation.op === "merge" || operation.op === "delete")))) {
    throw consolidationError("a full scene index must be reduced below capacity", "scene-reduction-required");
  }
}

function materializedFiles(operations) {
  const files = [];
  for (const operation of operations) {
    const file = targetPath(operation);
    if (operation.op === "delete") {
      files.push({ operation: "delete", targetPath: file, content: null });
      continue;
    }
    files.push({ operation: "write", targetPath: file, content: operation.newContent });
    if (operation.op === "merge") {
      for (const source of operation.mergeSources) {
        if (source !== operation.name) {
          files.push({ operation: "delete", targetPath: scenePath(source), content: null });
        }
      }
    }
  }
  assertUnique(files.map((file) => file.targetPath), "conflicting-file-operation", "derived file paths");
  files.sort((left, right) => (
    (left.operation === right.operation ? 0 : left.operation === "write" ? -1 : 1)
    || left.targetPath.localeCompare(right.targetPath)
  ));
  return files;
}

export function consolidationFilesFromOperations(operations) {
  if (!Array.isArray(operations)) throw new TypeError("operations must be an array");
  return materializedFiles(operations).map((file) => ({ ...file }));
}

export function buildConsolidationTask({
  databaseUuid,
  memoryStateUuid,
  owner,
  approvedProjection,
  entries,
  scenes,
  doctrine,
  replay = { mode: "incremental", afterSuccessfulRunId: null },
  lease = { holder: "threadshare-memory-cli", expiresAt: 0 },
  dueEntryCount = 20,
  policyVersion = "consolidation-policy@1",
}) {
  const orderedEntries = [...entries].sort((left, right) => left.entryId.localeCompare(right.entryId));
  const orderedScenes = [...scenes].sort((left, right) => left.name.localeCompare(right.name));
  const entryRevisions = orderedEntries.map(({ entryId, revision, contentDigest }) => ({
    entryId, revision, contentDigest,
  }));
  const sceneRevisions = orderedScenes.map(({ name, contentDigest, heat }) => ({
    name, contentDigest, heat,
  }));
  const binding = {
    databaseUuid,
    memoryStateUuid,
    owner,
    approvedProjection,
    entrySetDigest: memoryDigestHex(entryRevisions),
    entryRevisions,
    sceneIndexDigest: memoryDigestHex(sceneRevisions),
    sceneRevisions,
    doctrineDigest: doctrine?.contentDigest ?? null,
    replay,
    promptVersion: CONSOLIDATION_PROMPT_VERSION,
    schemaVersion: MEMORY_CONSOLIDATION_TASK_FORMAT,
    policyVersion,
  };
  const taskId = `consolidate-${memoryDigestHex(binding)}`;
  return consolidationTaskSchema.parse({
    format: MEMORY_CONSOLIDATION_TASK_FORMAT,
    taskId,
    lease,
    binding,
    entries: orderedEntries,
    scenes: orderedScenes,
    doctrine,
    policy: {
      maxScenes: 15,
      mergePreferredAt: 12,
      createForbiddenAt: 14,
      dueEntryCount,
      heatAlgorithm: "scene-heat@1",
    },
    contract: {
      patchSchema: MEMORY_CONSOLIDATION_PATCH_FORMAT,
      prompts: {
        promptVersion: CONSOLIDATION_PROMPT_VERSION,
        consolidation: CONSOLIDATION_PROMPT,
      },
    },
  });
}

/**
 * Validate and materialize one Runner patch. This function is side-effect free;
 * Rust repeats the same gates transactionally before accepting the submission.
 */
export function materializeConsolidationPatch({ task: rawTask, patch: rawPatch, candidateId, runId }) {
  const task = parseContract(consolidationTaskSchema, rawTask, "invalid-consolidation-task");
  const patch = parseContract(consolidationPatchSchema, rawPatch, "invalid-consolidation-patch");
  assertTaskIntegrity(task);
  if (patch.taskId !== task.taskId || canonicalJson(patch.binding) !== canonicalJson(task.binding)) {
    throw consolidationError("patch task id or binding does not match the task", "binding-drift");
  }

  if (patch.operations.length === 0) {
    return {
      noOp: true,
      entryCount: task.entries.length,
      finalSceneCount: task.scenes.length,
      operations: [],
      files: [],
      assessments: [],
      candidatePayload: null,
    };
  }

  validateOperationConflicts(patch.operations);
  const entryById = new Map(task.entries.map((entry) => [entry.entryId, entry]));
  const sceneByName = new Map(task.scenes.map((scene) => [scene.name, scene]));
  const materialized = patch.operations.map((operation) => {
    validateReferences(operation, entryById, sceneByName, task.doctrine !== null);
    let newContent = operation.newContent;
    if (operation.op !== "delete") {
      if (operation.target === "scene") {
        newContent = materializeSceneContent(
          operation.newContent,
          deriveSceneHeat(operation, sceneByName),
          operation.name,
        );
      } else {
        newContent = materializeDoctrineContent(operation.newContent);
      }
    }
    return { ...operation, newContent };
  });

  const finalSceneCount = applySceneCardinality(materialized, sceneByName.keys());
  validateCapacity(task, materialized, finalSceneCount);

  const resolvedCandidateId = candidateId ?? `consolidation-${task.taskId}`;
  const resolvedRunId = runId ?? task.taskId;
  const assessments = materialized.map((operation) => {
    const citations = [...operation.basedOnEntryIds]
      .sort()
      .map((entryId) => {
        const { revision, contentDigest } = entryById.get(entryId);
        return { entryId, revision, contentDigest };
      });
    return {
      candidateId: resolvedCandidateId,
      statementId: operation.operationId,
      citationsDigest: memoryDigestHex(citations),
      provenanceStrength: "contextual",
      limitations: ["generated-consolidation-content", "source-approved-memory-only"],
      claimSupport: "unverified",
      assessedBy: "deterministic",
      statementTextDigest: memoryDigestHex(operation),
      revision: 1,
    };
  });
  const statements = materialized.map((operation) => ({
    statementId: operation.operationId,
    operation,
  }));
  return {
    noOp: false,
    entryCount: task.entries.length,
    finalSceneCount,
    operations: materialized,
    files: materializedFiles(materialized),
    assessments,
    candidatePayload: {
      candidateKind: "consolidation-patch",
      runId: resolvedRunId,
      binding: task.binding,
      operations: materialized,
      statements,
    },
  };
}
