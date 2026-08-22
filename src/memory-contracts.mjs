import { createHash } from "node:crypto";

import { z } from "zod";

import { canonicalJson } from "./canonical-json.mjs";

export const MEMORY_HEX64_PATTERN = /^[0-9a-f]{64}$/;
export const MEMORY_HEX40_PATTERN = /^[0-9a-f]{40}$/;
export const MEMORY_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
export const MEMORY_SLUG_PATTERN = /^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/;
export const MEMORY_DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;

export const MEMORY_REPOSITORY_BINDING_FORMAT = "threadshare-memory-repository-binding@v1";
export const MEMORY_RESTRICTED_EXTRACTION_RUNNER_FORMAT =
  "threadshare-memory-restricted-extraction-runner@v1";
export const MEMORY_RUNNER_EXECUTION_PLAN_FORMAT = "threadshare-memory-runner-execution-plan@v1";
export const MEMORY_AUTHORIZATION_MANIFEST_FORMAT = "threadshare-memory-authorization-manifest@v1";
export const MEMORY_EXTRACTION_TASK_FORMAT = "threadshare-memory-extraction-task@v1";
export const MEMORY_CANDIDATE_DRAFT_BATCH_FORMAT = "threadshare-memory-candidate-draft-batch@v1";
export const MEMORY_MAX_EXTRACTION_CANDIDATES = 8;
export const MEMORY_EVIDENCE_ASSESSMENT_FORMAT = "threadshare-memory-evidence-assessment@v1";
export const MEMORY_ADJUDICATION_TASK_FORMAT = "threadshare-memory-adjudication-task@v1";
export const MEMORY_ADJUDICATION_RESULT_FORMAT = "threadshare-memory-adjudication-result@v1";
export const MEMORY_CONSOLIDATION_TASK_FORMAT = "threadshare-memory-consolidation-task@v1";
export const MEMORY_CONSOLIDATION_PATCH_FORMAT = "threadshare-memory-consolidation-patch@v1";
export const MEMORY_PROMOTION_PLAN_FORMAT = "threadshare-memory-promotion-plan@v1";
export const MEMORY_PREPARE_REQUEST_FORMAT = "threadshare-memory-prepare-request@v1";

const hex64 = z.string().regex(MEMORY_HEX64_PATTERN, "expected lowercase sha256 hex64");
const hex40 = z.string().regex(MEMORY_HEX40_PATTERN, "expected lowercase git object hex40");
const identifier = z.string().regex(MEMORY_ID_PATTERN, "expected memory identifier");
const slug = z.string().regex(MEMORY_SLUG_PATTERN, "expected memory slug");
const decimalString = z.string().regex(MEMORY_DECIMAL_PATTERN, "expected canonical decimal string");
// Scene names are free-form (Chinese scene names must work), only bounded.
const sceneName = z.string().min(1).max(200);
const nonEmptyString = z.string().min(1);
const nonNegativeInteger = z.number().int().min(0).max(Number.MAX_SAFE_INTEGER);
const positiveInteger = z.number().int().min(1).max(Number.MAX_SAFE_INTEGER);
const priorityInteger = z.number().int().min(0).max(100);

const taskKindSchema = z.enum(["extraction", "adjudication", "consolidation"]);
const authorizationStateSchema = z.enum(["pending", "approved"]);
const candidateTypeSchema = z.enum(["work_fact", "work_task", "work_method", "work_artifact"]);
const poolSourceKindSchema = z.enum(["approved", "candidate"]);

const leaseSchema = z.object({
  holder: nonEmptyString,
  expiresAt: nonNegativeInteger,
}).strict();

const ownerKeysSchema = z.object({
  repositoryKey: hex64,
  worktreeKey: hex64,
}).strict();

export const repositoryBindingSchema = z.object({
  format: z.literal(MEMORY_REPOSITORY_BINDING_FORMAT),
  repositoryKey: hex64,
  worktreeKey: hex64,
  publicRepositoryIdentity: nonEmptyString.nullable(),
  rootRealpathDigest: hex64,
  commonDirectoryIdentity: z.object({
    device: decimalString,
    inode: decimalString,
  }).strict(),
  memoryRoot: z.literal(".threadshare/memory"),
}).strict();

export const restrictedExtractionRunnerSchema = z.object({
  format: z.literal(MEMORY_RESTRICTED_EXTRACTION_RUNNER_FORMAT),
  adapter: z.enum(["claude-cli", "codex-cli"]),
  version: nonEmptyString,
  argvTemplate: z.array(z.string()),
  toolPolicy: z.literal("none"),
  network: z.literal("model-only"),
  ephemeral: z.literal("required"),
  timeoutMs: positiveInteger,
  maxOutputBytes: positiveInteger,
  conformance: z.object({
    testVersion: nonEmptyString,
    passedAt: nonEmptyString,
    cliVersionFingerprint: nonEmptyString,
  }).strict().nullable(),
}).strict();

export const runnerExecutionPlanSchema = z.object({
  format: z.literal(MEMORY_RUNNER_EXECUTION_PLAN_FORMAT),
  planDigest: hex64.nullable(),
  taskKind: taskKindSchema,
  taskId: identifier,
  runnerInputDigest: hex64,
  inputCoverageDigest: hex64,
  inputCoverage: z.array(z.object({
    sourceKind: z.enum([
      "transcript", "draft", "candidate-pool", "approved-entry", "scene", "doctrine",
      "scene-index", "prompt",
    ]),
    opaqueSourceId: nonEmptyString,
    revision: nonNegativeInteger.nullable(),
    contentDigest: hex64,
    bytes: nonNegativeInteger,
    truncated: z.boolean(),
  }).strict()),
  runnerProfile: nonEmptyString,
  provider: nonEmptyString,
  model: nonEmptyString,
  endpoint: nonEmptyString,
  bytesToSend: nonNegativeInteger,
  localSessionPersistence: z.literal("none"),
  providerRetention: z.enum(["unknown", "no-retention", "provider-policy"]),
  authorization: authorizationStateSchema,
}).strict();

export const authorizationManifestSchema = z.object({
  format: z.literal(MEMORY_AUTHORIZATION_MANIFEST_FORMAT),
  manifestDigest: hex64.nullable(),
  plans: z.array(z.object({
    planDigest: hex64,
    taskKind: taskKindSchema,
    taskId: identifier,
    bytesToSend: nonNegativeInteger,
  }).strict()),
  totalBytes: nonNegativeInteger,
  authorization: authorizationStateSchema,
}).strict();

const extractionBindingSchema = z.object({
  databaseUuid: nonEmptyString,
  owner: ownerKeysSchema,
  sourceInputDigest: hex64,
  selection: z.object({
    requestDigest: hex64,
    resultSetDigest: hex64,
    sourceBindingDigest: hex64,
  }).strict(),
  turnRevisions: z.array(hex64),
  payloadDigests: z.array(hex64),
  deliveryEdgeRevisions: z.array(hex64),
  promptVersion: nonEmptyString,
  schemaVersion: nonEmptyString,
  chunkerVersion: nonEmptyString,
  provenance: z.object({
    snapshotSeq: decimalString,
    evaluatedAt: nonEmptyString,
  }).strict(),
}).strict();

export const extractionTaskSchema = z.object({
  format: z.literal(MEMORY_EXTRACTION_TASK_FORMAT),
  taskId: identifier,
  lease: leaseSchema,
  binding: extractionBindingSchema,
  session: z.object({
    project: nonEmptyString.nullable(),
    repositoryKey: hex64,
    timeWindow: z.object({
      start: nonEmptyString,
      end: nonEmptyString,
    }).strict().nullable(),
  }).strict(),
  evidenceCatalog: z.array(z.object({
    evidenceId: identifier,
    kind: z.enum(["commit", "turn", "path"]),
    pointerDigest: hex64,
    display: nonEmptyString,
  }).strict()),
  chunk: z.object({
    turnRange: z.object({
      start: nonNegativeInteger,
      end: nonNegativeInteger,
    }).strict(),
    coverage: z.array(z.object({
      sourceKind: z.enum(["turn", "tool-payload"]),
      ref: nonEmptyString,
      completeness: z.enum(["full", "truncated"]),
      bytes: nonNegativeInteger,
    }).strict()),
    turnEvidence: z.array(z.object({
      turnIndex: nonNegativeInteger,
      evidenceId: identifier,
    }).strict()).optional(),
    transcript: z.string(),
  }).strict(),
  context: z.object({
    sceneIndexSummary: nonEmptyString.nullable(),
  }).strict(),
  contract: z.object({
    draftSchema: z.literal(MEMORY_CANDIDATE_DRAFT_BATCH_FORMAT),
    prompts: z.object({
      promptVersion: nonEmptyString,
      extraction: nonEmptyString,
    }).strict(),
  }).strict(),
}).strict();

const statementSchema = z.object({
  statementId: identifier,
  text: nonEmptyString,
  evidenceIds: z.array(identifier),
}).strict();

const draftCandidateShape = {
  content: nonEmptyString,
  type: candidateTypeSchema,
  priority: priorityInteger,
  confidence: z.enum(["high", "medium", "low"]),
  scene: sceneName.nullable(),
  statements: z.array(statementSchema),
};

export const candidateDraftBatchSchema = z.object({
  format: z.literal(MEMORY_CANDIDATE_DRAFT_BATCH_FORMAT),
  taskId: identifier,
  binding: extractionBindingSchema,
  candidates: z.array(z.object(draftCandidateShape).strict())
    .max(MEMORY_MAX_EXTRACTION_CANDIDATES),
}).strict();

export const memoryPrepareRequestSchema = z.object({
  format: z.literal(MEMORY_PREPARE_REQUEST_FORMAT),
  kind: z.enum(["entry", "consolidation"]).default("entry"),
  candidates: z.array(z.object({
    candidateId: identifier,
    expectedRevision: positiveInteger,
    statements: z.array(z.object({
      statementId: identifier,
      statementTextDigest: hex64,
      citationsDigest: hex64,
    }).strict()).min(1),
  }).strict()).min(1).max(50),
}).strict().superRefine((request, context) => {
  const candidateIds = request.candidates.map((candidate) => candidate.candidateId);
  if (new Set(candidateIds).size !== candidateIds.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["candidates"],
      message: "candidate ids must be unique",
    });
  }
  for (const [index, candidate] of request.candidates.entries()) {
    const statementIds = candidate.statements.map((statement) => statement.statementId);
    if (new Set(statementIds).size !== statementIds.length) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["candidates", index, "statements"],
        message: "statement ids must be unique per candidate",
      });
    }
  }
});

export const evidenceAssessmentSchema = z.object({
  format: z.literal(MEMORY_EVIDENCE_ASSESSMENT_FORMAT),
  candidateId: identifier,
  statementId: identifier,
  citations: z.array(z.object({
    evidenceId: identifier,
    pointerDigest: hex64,
  }).strict()),
  provenanceStrength: z.enum(["direct", "observed", "candidate", "contextual", "unknown"]),
  limitations: z.array(nonEmptyString),
  claimSupport: z.enum(["unverified", "typed-fact", "human-confirmed"]),
  assessedBy: z.enum(["deterministic", "human"]),
  statementTextDigest: hex64,
  revision: nonNegativeInteger,
}).strict();

const adjudicationBindingSchema = z.object({
  databaseUuid: nonEmptyString,
  memoryStateUuid: nonEmptyString,
  owner: ownerKeysSchema,
  draftBatchDigest: hex64,
  approvedProjection: z.object({
    generation: nonNegativeInteger,
    analyzerVersion: nonEmptyString,
  }).strict(),
  candidateProjection: z.object({
    generation: nonNegativeInteger,
    analyzerVersion: nonEmptyString,
  }).strict(),
  recallAlgorithmVersion: nonEmptyString,
  recallQueryDigest: hex64,
  resultSetDigest: hex64,
  poolItemRevisions: z.array(z.object({
    sourceKind: poolSourceKindSchema,
    id: identifier,
    revision: nonNegativeInteger,
  }).strict()),
  promptVersion: nonEmptyString,
  schemaVersion: nonEmptyString,
}).strict();

export const adjudicationTaskSchema = z.object({
  format: z.literal(MEMORY_ADJUDICATION_TASK_FORMAT),
  taskId: identifier,
  lease: leaseSchema,
  binding: adjudicationBindingSchema,
  drafts: z.array(z.object({
    candidateId: identifier,
    ...draftCandidateShape,
  }).strict()),
  recallSets: z.array(z.object({
    draftRef: identifier,
    ordered: z.array(z.object({
      rank: positiveInteger,
      sourceKind: poolSourceKindSchema,
      id: identifier,
    }).strict()),
  }).strict()),
  pool: z.array(z.object({
    sourceKind: poolSourceKindSchema,
    id: identifier,
    revision: nonNegativeInteger,
    contentDigest: hex64,
    state: nonEmptyString,
    summary: z.string(),
  }).strict()),
  contract: z.object({
    resultSchema: z.literal(MEMORY_ADJUDICATION_RESULT_FORMAT),
    prompts: z.object({
      promptVersion: nonEmptyString,
      adjudication: nonEmptyString,
    }).strict(),
  }).strict(),
}).strict();

export const adjudicationResultSchema = z.object({
  format: z.literal(MEMORY_ADJUDICATION_RESULT_FORMAT),
  taskId: identifier,
  binding: adjudicationBindingSchema,
  adjudications: z.array(z.object({
    draftRef: identifier,
    action: z.enum(["store", "skip", "update", "merge"]),
    targetIds: z.array(identifier),
    mergedFields: z.object({
      content: nonEmptyString.optional(),
      type: candidateTypeSchema.optional(),
      priority: priorityInteger.optional(),
      scene: sceneName.nullable().optional(),
      occurred: z.array(nonEmptyString).optional(),
    }).strict().nullable(),
  }).strict()),
}).strict();

const consolidationBindingSchema = z.object({
  databaseUuid: nonEmptyString,
  memoryStateUuid: nonEmptyString,
  owner: ownerKeysSchema,
  approvedProjection: z.object({
    generation: nonNegativeInteger,
    analyzerVersion: nonEmptyString,
    coverage: z.literal("complete"),
    sourceTreeDigest: hex64,
  }).strict(),
  entrySetDigest: hex64,
  entryRevisions: z.array(z.object({
    entryId: identifier,
    revision: positiveInteger,
    contentDigest: hex64,
  }).strict()),
  sceneIndexDigest: hex64,
  sceneRevisions: z.array(z.object({
    name: slug,
    contentDigest: hex64,
    heat: positiveInteger,
  }).strict()),
  doctrineDigest: hex64.nullable(),
  replay: z.object({
    mode: z.enum(["incremental", "full"]),
    afterSuccessfulRunId: identifier.nullable(),
  }).strict(),
  promptVersion: nonEmptyString,
  schemaVersion: z.literal(MEMORY_CONSOLIDATION_TASK_FORMAT),
  policyVersion: nonEmptyString,
}).strict();

export const consolidationTaskSchema = z.object({
  format: z.literal(MEMORY_CONSOLIDATION_TASK_FORMAT),
  taskId: identifier,
  lease: leaseSchema,
  binding: consolidationBindingSchema,
  entries: z.array(z.object({
    entryId: identifier,
    revision: positiveInteger,
    contentDigest: hex64,
    type: candidateTypeSchema,
    scene: sceneName.nullable(),
    priority: priorityInteger,
    confidence: z.enum(["high", "medium", "low"]),
    body: nonEmptyString,
  }).strict()),
  scenes: z.array(z.object({
    name: slug,
    contentDigest: hex64,
    heat: positiveInteger,
    content: nonEmptyString,
  }).strict()),
  doctrine: z.object({
    contentDigest: hex64,
    content: nonEmptyString,
  }).strict().nullable(),
  policy: z.object({
    maxScenes: z.literal(15),
    mergePreferredAt: z.literal(12),
    createForbiddenAt: z.literal(14),
    dueEntryCount: positiveInteger,
    heatAlgorithm: z.literal("scene-heat@1"),
  }).strict(),
  contract: z.object({
    patchSchema: z.literal(MEMORY_CONSOLIDATION_PATCH_FORMAT),
    prompts: z.object({
      promptVersion: nonEmptyString,
      consolidation: nonEmptyString,
    }).strict(),
  }).strict(),
}).strict();

export const consolidationPatchSchema = z.object({
  format: z.literal(MEMORY_CONSOLIDATION_PATCH_FORMAT),
  taskId: identifier,
  binding: consolidationBindingSchema,
  operations: z.array(z.object({
    operationId: identifier,
    op: z.enum(["create", "update", "merge", "delete"]),
    target: z.enum(["scene", "doctrine"]),
    name: slug,
    newContent: z.string().nullable(),
    basedOnEntryIds: z.array(identifier),
    mergeSources: z.array(slug),
    rationale: nonEmptyString,
  }).strict()),
}).strict();

const promotionPlanFileSchema = z.object({
  targetPath: nonEmptyString,
  targetBlobHash: hex40.nullable(),
  sanitizedContentDigest: hex64.nullable(),
  operation: z.enum(["write", "delete"]).optional(),
}).strict().superRefine((file, context) => {
  const operation = file.operation ?? "write";
  if (operation === "write" && file.sanitizedContentDigest === null) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      path: ["sanitizedContentDigest"],
      message: "write files require a sanitized content digest",
    });
  }
  if (operation === "delete") {
    if (file.sanitizedContentDigest !== null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["sanitizedContentDigest"],
        message: "delete files must not carry a sanitized content digest",
      });
    }
    if (file.targetBlobHash === null) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        path: ["targetBlobHash"],
        message: "delete files require an existing target blob hash",
      });
    }
  }
});

export const promotionPlanSchema = z.object({
  format: z.literal(MEMORY_PROMOTION_PLAN_FORMAT),
  planId: identifier,
  owner: repositoryBindingSchema,
  candidateIds: z.array(identifier),
  assessmentDigest: hex64,
  perFile: z.array(promotionPlanFileSchema),
  policyVersion: nonEmptyString,
  diff: z.string(),
}).strict();

export const MEMORY_CONTRACT_FORMATS = Object.freeze({
  [MEMORY_REPOSITORY_BINDING_FORMAT]: repositoryBindingSchema,
  [MEMORY_RESTRICTED_EXTRACTION_RUNNER_FORMAT]: restrictedExtractionRunnerSchema,
  [MEMORY_RUNNER_EXECUTION_PLAN_FORMAT]: runnerExecutionPlanSchema,
  [MEMORY_AUTHORIZATION_MANIFEST_FORMAT]: authorizationManifestSchema,
  [MEMORY_EXTRACTION_TASK_FORMAT]: extractionTaskSchema,
  [MEMORY_CANDIDATE_DRAFT_BATCH_FORMAT]: candidateDraftBatchSchema,
  [MEMORY_EVIDENCE_ASSESSMENT_FORMAT]: evidenceAssessmentSchema,
  [MEMORY_ADJUDICATION_TASK_FORMAT]: adjudicationTaskSchema,
  [MEMORY_ADJUDICATION_RESULT_FORMAT]: adjudicationResultSchema,
  [MEMORY_CONSOLIDATION_TASK_FORMAT]: consolidationTaskSchema,
  [MEMORY_CONSOLIDATION_PATCH_FORMAT]: consolidationPatchSchema,
  [MEMORY_PROMOTION_PLAN_FORMAT]: promotionPlanSchema,
  [MEMORY_PREPARE_REQUEST_FORMAT]: memoryPrepareRequestSchema,
});

export function parseMemoryContract(value) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("memory contract must be an object with a format field");
  }
  const format = value.format;
  if (typeof format !== "string" || !Object.hasOwn(MEMORY_CONTRACT_FORMATS, format)) {
    throw new Error(`unknown memory contract format: ${String(format)}`);
  }
  return MEMORY_CONTRACT_FORMATS[format].parse(value);
}

export function memoryDigestHex(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

export function computeRunnerInputDigest(bytesOrString) {
  if (typeof bytesOrString === "string") {
    return createHash("sha256").update(Buffer.from(bytesOrString, "utf8")).digest("hex");
  }
  if (bytesOrString instanceof Uint8Array) {
    return createHash("sha256").update(bytesOrString).digest("hex");
  }
  throw new TypeError("runner input must be a string, Buffer, or Uint8Array");
}

export function computePlanDigest(plan) {
  const { planDigest: _planDigest, authorization: _authorization, ...digestFields } = plan;
  return memoryDigestHex(digestFields);
}

export function computeManifestDigest(manifest) {
  const { manifestDigest: _manifestDigest, authorization: _authorization, ...digestFields } = manifest;
  return memoryDigestHex(digestFields);
}
