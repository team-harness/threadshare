/**
 * Team Memory Stage 4a + 4c op wrappers over
 * `InsightsEngineClient.memoryCommand` (design doc
 * `docs/team-memory-phase1-design.md` §3, DEV-4).
 *
 * Each op gets one `memoryXxx(engine, input, options)` function that
 * validates the request payload with zod before sending, sends one
 * `MEMORY_COMMAND{op}` frame, and validates the `MEMORY_RESULT` payload with
 * zod before returning it. The zod schemas mirror the normative wire schema in
 * the documentation block at the top of
 * `crates/insights-engine/src/memory_protocol.rs`; the envelope-level checks
 * live in `insights-engine-protocol.mjs`.
 *
 * Structured stale outcomes of `submit-adjudication` are not exceptions: the
 * result is a discriminated union on `status` (`"applied" | "stale"`). The
 * same pattern covers `confirm-statement` (`"confirmed" | "drifted"`),
 * `promotion-apply` (`"applied" | "voided"`), and `sync-approved`
 * (`"synced" | "conflict"`, where `"conflict"` reports a lost
 * `expectedGeneration` CAS and the client must rescan). Engine failures
 * surface as `InsightsEngineClientError` with the remote `TS_MEMORY_*` code;
 * local schema failures throw `MemoryStateClientError` with
 * `TS_MEMORY_REQUEST_INVALID` / `TS_MEMORY_RESULT_INVALID`.
 *
 * The raw `engine.memoryCommand` transport gives envelope-level guarantees
 * only and provides no op-level result validation or typing whatsoever;
 * business code must always go through the typed `memoryXxx` wrappers in this
 * module and must never call `engine.memoryCommand` directly.
 */

import { z } from "zod";

// Bounds mirroring crates/insights-engine/src/memory_protocol.rs.
export const MEMORY_MAX_TEXT_BYTES = 64 * 1024;
export const MEMORY_MAX_PAYLOAD_ITEMS = 512;
export const MEMORY_MAX_RECALL_DRAFTS = 64;
export const MEMORY_MAX_SYNC_ENTRIES = 4096;
export const MEMORY_MAX_LEASE_MS = 86_400_000;
export const MEMORY_MAX_PLAN_FILES = 128;
export const MEMORY_MAX_PLAN_FILE_BYTES = 1024 * 1024;
export const MEMORY_MAX_PLAN_TOTAL_BYTES = 8 * 1024 * 1024;
export const MEMORY_MAX_TARGET_PATH_BYTES = 1024;

const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const HEX40_PATTERN = /^[0-9a-f]{40}$/;
const BASE64_PATTERN = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const CLAIM_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
// The engine mints memory-state UUIDs and plan IDs as RFC 4122 v4 (version
// nibble 4, variant [89ab]); pin the shape here so a non-v4 id is rejected.
const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

export class MemoryStateClientError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "MemoryStateClientError";
    this.code = code;
  }
}

const hex64 = z.string().regex(HEX64_PATTERN, "expected lowercase sha256 hex64");
const claimToken = z.string().regex(CLAIM_TOKEN_PATTERN, "expected a hex32 claim token");
const decimalString = z.string().regex(DECIMAL_PATTERN, "expected a canonical decimal string");
const uuidString = z.string().regex(UUID_PATTERN, "expected a lowercase uuid v4");
const nonEmptyString = z.string().min(1);
// Rust `valid_identifier`: non-empty, at most 256 bytes, no control characters
// (Unicode Cc: U+0000-U+001F and U+007F-U+009F, matching Rust char::is_control).
const CONTROL_CHARACTER_PATTERN = new RegExp("[\\u0000-\\u001f\\u007f-\\u009f]", "u");
const identifier = z.string().refine(
  (value) => value.length > 0 &&
    Buffer.byteLength(value, "utf8") <= 256 &&
    !CONTROL_CHARACTER_PATTERN.test(value),
  { message: "expected a non-empty control-free string of at most 256 bytes" },
);
// Rust `valid_text`: at most 64 KiB of UTF-8.
const boundedText = z.string().refine(
  (value) => Buffer.byteLength(value, "utf8") <= MEMORY_MAX_TEXT_BYTES,
  { message: "text exceeds 64 KiB" },
);
// Rust `valid_object`: any JSON object; the engine treats it as opaque.
const plainObject = z.custom(
  (value) => value !== null && typeof value === "object" && !Array.isArray(value) &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null),
  { message: "expected a plain JSON object" },
);
const safeInteger = z.number().int().min(Number.MIN_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER);
const nonNegativeInteger = safeInteger.min(0);
const positiveInteger = safeInteger.min(1);
const absolutePath = nonEmptyString.refine(
  (value) => value.startsWith("/") || /^[A-Za-z]:[\\/]/.test(value),
  { message: "expected an absolute path" },
);

const ownerFields = {
  repositoryKey: hex64,
  worktreeKey: hex64,
};

const hex40 = z.string().regex(HEX40_PATTERN, "expected a git blob OID (lowercase hex40)");
// Rust `decode_base64`: strict standard alphabet, mandatory padding, length
// a multiple of four; decoded size bounded per file.
const base64Content = z.string().refine(
  (value) => BASE64_PATTERN.test(value) &&
    Buffer.from(value, "base64").length <= MEMORY_MAX_PLAN_FILE_BYTES,
  { message: "expected strict padded base64 of at most 1 MiB decoded" },
);
// Rust `valid_target_path`: normalized relative path — no absolute paths,
// backslashes, colons, control characters, empty or dot segments.
const targetPath = z.string().refine(
  (value) => value.length > 0 &&
    value.length <= MEMORY_MAX_TARGET_PATH_BYTES &&
    !value.includes("\\") &&
    !value.includes(":") &&
    !CONTROL_CHARACTER_PATTERN.test(value) &&
    !value.startsWith("/") &&
    value.split("/").every((segment) => segment !== "" && segment !== "." && segment !== ".."),
  { message: "expected a normalized relative path without dot or empty segments" },
);

const taskKind = z.enum(["extraction", "adjudication", "consolidation"]);
const coverageState = z.enum(["complete", "partial"]);
const poolSourceKind = z.enum(["approved", "candidate"]);
const provenanceStrength = z.enum(["direct", "observed", "candidate", "contextual", "unknown"]);
const claimSupport = z.enum(["unverified", "typed-fact", "human-confirmed"]);
const assessedBy = z.enum(["deterministic", "human"]);
const adjudicationAction = z.enum(["store", "skip", "update", "merge"]);

// ---------------------------------------------------------------------------
// Request schemas (client → engine), per the memory_protocol.rs doc block.
// ---------------------------------------------------------------------------

const openRequest = z.object({
  stateDir: absolutePath,
}).strict();

const bindRepositoryRequest = z.object({
  ...ownerFields,
  publicRepositoryIdentity: identifier.nullable(),
  rootRealpath: absolutePath,
  rootRealpathDigest: hex64,
  commonDirDevice: decimalString,
  commonDirInode: decimalString,
  memoryRoot: identifier.default(".threadshare/memory"),
  status: z.enum(["active", "inactive"]).default("active"),
}).strict();

const memoryFileCollection = z.enum(["entries", "scenes", "doctrine"]);
const memoryFileName = identifier.refine(
  (value) => value.endsWith(".md") && value !== ".md" &&
    !value.includes("/") && !value.includes("\\"),
  { message: "expected one Markdown filename without path separators" },
);

const listMemoryFilesRequest = z.object({
  ...ownerFields,
  collection: memoryFileCollection.refine((value) => value !== "doctrine", {
    message: "doctrine is a single file and cannot be listed",
  }),
}).strict();

const readMemoryFileRequest = z.object({
  ...ownerFields,
  collection: memoryFileCollection,
  name: memoryFileName.nullable().default(null),
}).strict().superRefine((request, context) => {
  const valid = request.collection === "doctrine"
    ? request.name === null
    : request.name !== null;
  if (!valid) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: request.collection === "doctrine"
        ? "doctrine reads must omit name"
        : "entries and scenes reads require name",
      path: ["name"],
    });
  }
});

const planTasksRequest = z.object({
  ...ownerFields,
  chunks: z.array(z.object({
    chunkRef: identifier,
    sessionKey: hex64,
    turnRange: identifier,
    chunkDigest: hex64,
    provenanceSnapshotSeq: decimalString.nullable().default(null),
  }).strict()).max(MEMORY_MAX_PAYLOAD_ITEMS),
  tasks: z.array(z.object({
    taskId: identifier,
    kind: taskKind,
    chunkRef: identifier.nullable().default(null),
    draftBatchRef: identifier.nullable().default(null),
    binding: plainObject,
    authorizationPlanDigest: hex64.nullable().default(null),
  }).strict()).max(MEMORY_MAX_PAYLOAD_ITEMS),
}).strict();

const claimTaskRequest = z.object({
  taskId: identifier,
  leaseHolder: identifier,
  leaseMs: positiveInteger.max(MEMORY_MAX_LEASE_MS),
}).strict();

const abandonTaskRequest = z.object({
  taskId: identifier,
  claimToken,
  disposition: z.enum(["pending", "stale"]),
}).strict();

const submitExtractionRequest = z.object({
  taskId: identifier,
  claimToken: identifier,
  responseDigest: hex64,
  finalize: z.boolean().default(false),
  drafts: z.array(z.object({
    candidateId: identifier,
    payload: plainObject,
    searchableText: boundedText,
  }).strict()).max(MEMORY_MAX_PAYLOAD_ITEMS),
  evidenceRefs: z.array(z.object({
    candidateId: identifier,
    statementId: identifier,
    evidenceId: identifier,
    pointerDigest: hex64,
    sessionKey: hex64.nullable().default(null),
    turnKey: hex64.nullable().default(null),
    revision: hex64.nullable().default(null),
    payloadSha256: hex64.nullable().default(null),
    relation: identifier.nullable().default(null),
    strength: identifier.nullable().default(null),
    limitations: z.array(boundedText).nullable().default(null),
  }).strict()).max(MEMORY_MAX_PAYLOAD_ITEMS),
  assessments: z.array(z.object({
    candidateId: identifier,
    statementId: identifier,
    citationsDigest: hex64,
    provenanceStrength,
    limitations: z.array(boundedText),
    claimSupport,
    assessedBy,
    statementTextDigest: hex64,
    revision: positiveInteger,
  }).strict()).max(MEMORY_MAX_PAYLOAD_ITEMS),
}).strict().superRefine((request, context) => {
  const candidateIds = new Set();
  for (const draft of request.drafts) {
    if (candidateIds.has(draft.candidateId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "drafts[].candidateId must be unique",
        path: ["drafts"],
      });
    }
    candidateIds.add(draft.candidateId);
  }
  for (const [index, reference] of request.evidenceRefs.entries()) {
    if (!candidateIds.has(reference.candidateId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "evidenceRefs[].candidateId must reference a draft in this batch",
        path: ["evidenceRefs", index],
      });
    }
  }
  for (const [index, assessment] of request.assessments.entries()) {
    if (!candidateIds.has(assessment.candidateId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "assessments[].candidateId must reference a draft in this batch",
        path: ["assessments", index],
      });
    }
  }
});

const consolidationOperation = z.object({
  operationId: identifier,
  op: z.enum(["create", "update", "merge", "delete"]),
  target: z.enum(["scene", "doctrine"]),
  name: z.string().regex(/^[a-z0-9](?:[a-z0-9-]{0,62}[a-z0-9])?$/),
  newContent: boundedText.nullable(),
  basedOnEntryIds: z.array(identifier),
  mergeSources: z.array(identifier),
  rationale: boundedText.refine((value) => value.length > 0, {
    message: "rationale must not be empty",
  }),
}).strict();

const assessmentInput = z.object({
  candidateId: identifier,
  statementId: identifier,
  citationsDigest: hex64,
  provenanceStrength,
  limitations: z.array(boundedText),
  claimSupport,
  assessedBy,
  statementTextDigest: hex64,
  revision: positiveInteger,
}).strict();

const submitConsolidationRequest = z.object({
  taskId: identifier,
  claimToken: identifier,
  responseDigest: hex64,
  runId: identifier,
  candidateId: identifier.nullable(),
  operations: z.array(consolidationOperation).max(MEMORY_MAX_PAYLOAD_ITEMS),
  assessments: z.array(assessmentInput).max(MEMORY_MAX_PAYLOAD_ITEMS),
}).strict().superRefine((request, context) => {
  if ((request.operations.length === 0) !== (request.candidateId === null)) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "candidateId must be null exactly when operations is empty",
      path: ["candidateId"],
    });
  }
  if (request.operations.length !== request.assessments.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "every consolidation operation must have exactly one assessment",
      path: ["assessments"],
    });
  }
  const operationIds = new Set();
  for (const operation of request.operations) {
    if (operationIds.has(operation.operationId)) {
      context.addIssue({ code: z.ZodIssueCode.custom, message: "operationId must be unique",
        path: ["operations"] });
    }
    operationIds.add(operation.operationId);
  }
  const statementIds = new Set();
  for (const [index, assessment] of request.assessments.entries()) {
    if (assessment.candidateId !== request.candidateId || !operationIds.has(assessment.statementId)
      || statementIds.has(assessment.statementId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "assessment must uniquely bind one operation and the request candidate",
        path: ["assessments", index],
      });
    }
    statementIds.add(assessment.statementId);
  }
});

const consolidationBaselineRequest = z.object({ ...ownerFields }).strict();

const recallRequest = z.object({
  ...ownerFields,
  k: positiveInteger.max(50).default(5),
  drafts: z.array(z.object({
    draftRef: identifier,
    candidateId: identifier,
    queryText: boundedText,
  }).strict()).min(1).max(MEMORY_MAX_RECALL_DRAFTS),
}).strict().superRefine((request, context) => {
  const refs = new Set();
  for (const draft of request.drafts) {
    if (refs.has(draft.draftRef)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "drafts[].draftRef must be unique",
        path: ["drafts"],
      });
    }
    refs.add(draft.draftRef);
  }
});

const submitAdjudicationRequest = z.object({
  taskId: identifier,
  claimToken: identifier,
  responseDigest: hex64,
  recall: recallRequest,
  expectedResultSetDigest: hex64,
  adjudications: z.array(z.object({
    draftRef: identifier,
    action: adjudicationAction,
    targets: z.array(z.object({
      id: identifier,
      revision: positiveInteger,
    }).strict()).default([]),
    mergedPayload: plainObject.nullable().default(null),
    mergedSearchableText: boundedText.nullable().default(null),
  }).strict()),
}).strict().superRefine((request, context) => {
  const pending = new Set(request.recall.drafts.map((draft) => draft.draftRef));
  if (request.adjudications.length !== request.recall.drafts.length) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "every recall draft must be adjudicated exactly once",
      path: ["adjudications"],
    });
  }
  // A target may be consumed by at most one adjudication: ids are unique
  // across the whole request (mirrors the Rust-side validation; without it,
  // `[{T,1},{T,2}]` could ride the engine's own revision bump).
  const targetIds = new Set();
  for (const [index, adjudication] of request.adjudications.entries()) {
    if (!pending.delete(adjudication.draftRef)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adjudications[].draftRef must match a recall draft exactly once",
        path: ["adjudications", index, "draftRef"],
      });
    }
    for (const [targetIndex, target] of adjudication.targets.entries()) {
      if (
        (adjudication.action === "update" || adjudication.action === "merge") &&
        request.recall.drafts.some((draft) => draft.candidateId === target.id)
      ) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "update/merge targets must not reference a draft in the current batch",
          path: ["adjudications", index, "targets", targetIndex, "id"],
        });
      }
      if (targetIds.has(target.id)) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "adjudications[].targets[].id must be unique across the request",
          path: ["adjudications", index, "targets", targetIndex, "id"],
        });
      }
      targetIds.add(target.id);
    }
    if (adjudication.action === "store" || adjudication.action === "skip") {
      if (adjudication.targets.length !== 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "store/skip adjudications must not carry mutation targets",
          path: ["adjudications", index, "targets"],
        });
      }
      if (adjudication.mergedPayload !== null || adjudication.mergedSearchableText !== null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "store/skip adjudications must not carry merged fields",
          path: ["adjudications", index],
        });
      }
    } else {
      if (adjudication.targets.length === 0) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "update/merge adjudications require targets",
          path: ["adjudications", index, "targets"],
        });
      }
      if (adjudication.mergedPayload === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "update/merge adjudications require mergedPayload",
          path: ["adjudications", index, "mergedPayload"],
        });
      }
      if (adjudication.mergedSearchableText === null) {
        context.addIssue({
          code: z.ZodIssueCode.custom,
          message: "update/merge adjudications require mergedSearchableText",
          path: ["adjudications", index, "mergedSearchableText"],
        });
      }
    }
  }
});

const syncApprovedRequest = z.object({
  ...ownerFields,
  sourceTreeDigest: hex64,
  coverage: coverageState,
  // Generation CAS: must equal the owner's current approved projection
  // generation (0 before the first sync); a mismatch returns the structured
  // `"conflict"` result and the caller must rescan.
  expectedGeneration: nonNegativeInteger,
  entries: z.array(z.object({
    entryId: identifier,
    revision: positiveInteger,
    contentDigest: hex64,
    frontmatter: plainObject,
    bodyText: boundedText,
    status: identifier,
    searchableText: boundedText,
  }).strict()).max(MEMORY_MAX_SYNC_ENTRIES),
}).strict().superRefine((request, context) => {
  const ids = new Set();
  for (const entry of request.entries) {
    if (ids.has(entry.entryId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "entries[].entryId must be unique",
        path: ["entries"],
      });
    }
    ids.add(entry.entryId);
  }
});

const searchRequest = z.object({
  ...ownerFields,
  query: z.string().min(1).refine(
    (value) => Buffer.byteLength(value, "utf8") <= 1024,
    { message: "query must be between 1 and 1024 bytes" },
  ),
  limit: positiveInteger.max(100).default(10),
}).strict();

const reviewQueueRequest = z.object({
  ...ownerFields,
  limit: positiveInteger.max(200).default(50),
  kind: z.enum(["entry", "skill", "consolidation"]).default("entry"),
}).strict();

const statusRequest = z.object({ ...ownerFields }).strict();

const confirmStatementRequest = z.object({
  candidateId: identifier,
  statementId: identifier,
  statementTextDigest: hex64,
  citationsDigest: hex64,
}).strict();

const discardCandidateRequest = z.object({
  candidateId: identifier,
  expectedRevision: positiveInteger,
}).strict();

const promotionPlanRequest = z.object({
  owner: z.object({ ...ownerFields }).strict(),
  candidateIds: z.array(identifier).min(1).max(MEMORY_MAX_PAYLOAD_ITEMS),
  policyVersion: identifier,
  perFile: z.array(z.object({
    targetPath,
    operation: z.enum(["write", "delete"]).default("write"),
    sanitizedContent: base64Content.nullable(),
    targetBlobHash: hex40.nullable(),
  }).strict()).min(1).max(MEMORY_MAX_PLAN_FILES),
}).strict().superRefine((request, context) => {
  const candidateIds = new Set();
  for (const candidateId of request.candidateIds) {
    if (candidateIds.has(candidateId)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "candidateIds[] must be unique",
        path: ["candidateIds"],
      });
    }
    candidateIds.add(candidateId);
  }
  const targetPaths = new Set();
  let totalBytes = 0;
  for (const [index, file] of request.perFile.entries()) {
    if (targetPaths.has(file.targetPath)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "perFile[].targetPath must be unique",
        path: ["perFile", index, "targetPath"],
      });
    }
    targetPaths.add(file.targetPath);
    if (file.operation === "write") {
      if (file.sanitizedContent === null) {
        context.addIssue({ code: z.ZodIssueCode.custom,
          message: "write files require sanitizedContent", path: ["perFile", index] });
      } else {
        totalBytes += Buffer.from(file.sanitizedContent, "base64").length;
      }
    } else if (file.sanitizedContent !== null || file.targetBlobHash === null) {
      context.addIssue({ code: z.ZodIssueCode.custom,
        message: "delete files require null content and a target blob",
        path: ["perFile", index] });
    }
  }
  if (totalBytes > MEMORY_MAX_PLAN_TOTAL_BYTES) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "perFile decoded content exceeds 8 MiB in total",
      path: ["perFile"],
    });
  }
});

const promotionApproveRequest = z.object({
  planId: identifier,
  planDigest: hex64,
}).strict();

const promotionApplyRequest = z.object({
  planId: identifier,
  ownerRootRealpath: absolutePath,
}).strict();

const authorizeRequest = z.object({
  planDigest: hex64,
  taskId: identifier.nullable().default(null),
  runnerInputDigest: hex64.nullable().default(null),
  inputCoverageDigest: hex64.nullable().default(null),
  provider: identifier,
  model: identifier,
  endpoint: identifier,
  bytes: nonNegativeInteger,
  via: z.enum(["interactive", "digest", "manifest"]),
  manifestDigest: hex64.nullable().default(null),
}).strict();

// ---------------------------------------------------------------------------
// Result schemas (engine → client).
// ---------------------------------------------------------------------------

const openResult = z.object({
  memoryStateUuid: uuidString,
  // The Node RESULT contract only knows schema version 1; a different version is
  // an incompatible engine and must be rejected rather than silently accepted.
  schemaVersion: z.literal(2),
}).strict();

const bindRepositoryResult = z.object({
  ...ownerFields,
  publicRepositoryIdentity: nonEmptyString.nullable(),
  memoryRoot: nonEmptyString,
  status: z.enum(["active", "inactive"]),
}).strict();

const listMemoryFilesResult = z.object({
  names: z.array(memoryFileName).max(MEMORY_MAX_SYNC_ENTRIES),
}).strict();

const readMemoryFileResult = z.object({
  content: boundedText.nullable(),
}).strict();

const planTasksResult = z.object({
  insertedChunks: nonNegativeInteger,
  skippedChunks: nonNegativeInteger,
  insertedTasks: nonNegativeInteger,
  skippedTasks: nonNegativeInteger,
  tasks: z.array(z.object({
    taskId: identifier,
    status: z.enum(["pending", "claimed", "submitted", "stale"]),
    claimable: z.boolean(),
  }).strict()).max(MEMORY_MAX_PAYLOAD_ITEMS),
}).strict();

const claimTaskResult = z.object({
  task: z.object({
    taskId: identifier,
    kind: taskKind,
    ...ownerFields,
    chunkRef: identifier.nullable(),
    draftBatchRef: identifier.nullable(),
    binding: plainObject,
    authorizationPlanDigest: hex64.nullable(),
    status: z.literal("claimed"),
    createdAt: nonNegativeInteger,
    lease: z.object({
      holder: nonEmptyString,
      expiresAt: nonNegativeInteger,
      epoch: positiveInteger,
    }).strict(),
  }).strict(),
  claimToken,
}).strict();

const abandonTaskResult = z.object({
  taskId: identifier,
  status: z.enum(["pending", "stale"]),
}).strict();

const candidateState = z.object({
  candidateId: identifier,
  revision: positiveInteger,
  contentDigest: hex64,
  status: nonEmptyString,
}).strict();

const submitExtractionResult = z.object({
  taskId: identifier,
  idempotent: z.boolean(),
  candidates: z.array(candidateState),
  candidateGeneration: nonNegativeInteger,
}).strict();

const submitConsolidationResult = z.object({
  taskId: identifier,
  runId: identifier,
  status: z.enum(["pending_review", "no_op"]),
  idempotent: z.boolean(),
  candidate: candidateState.nullable(),
  candidateGeneration: nonNegativeInteger,
  entryCount: nonNegativeInteger,
}).strict();

const consolidationBaselineResult = z.object({
  successfulRunId: identifier.nullable(),
  entries: z.array(z.object({
    entryId: identifier,
    revision: positiveInteger,
    contentDigest: hex64,
  }).strict()),
  pendingRunId: identifier.nullable(),
  lastSuccessfulNoOp: z.boolean(),
}).strict();

const recallResult = z.object({
  recallAlgorithmVersion: z.literal("recall-rrf@1"),
  k: positiveInteger.max(50),
  approvedProjection: z.object({
    generation: nonNegativeInteger,
    analyzerVersion: nonEmptyString,
    coverage: coverageState,
  }).strict(),
  candidateProjection: z.object({
    generation: nonNegativeInteger,
    analyzerVersion: nonEmptyString,
  }).strict(),
  recallQueryDigest: hex64,
  resultSetDigest: hex64,
  recallSets: z.array(z.object({
    draftRef: identifier,
    ordered: z.array(z.object({
      rank: positiveInteger,
      sourceKind: poolSourceKind,
      id: identifier,
    }).strict()),
  }).strict()),
  pool: z.array(z.object({
    sourceKind: poolSourceKind,
    id: identifier,
    revision: positiveInteger,
    contentDigest: hex64,
    state: nonEmptyString,
    summary: z.string(),
  }).strict()),
}).strict();

const submitAdjudicationResult = z.union([
  z.object({
    taskId: identifier,
    status: z.literal("applied"),
    idempotent: z.boolean(),
    outcomes: z.array(z.object({
      draftRef: identifier,
      action: adjudicationAction,
      candidateId: identifier,
      candidateStatus: nonEmptyString,
      revision: positiveInteger,
    }).strict()),
    candidateGeneration: nonNegativeInteger,
  }).strict(),
  z.object({
    taskId: identifier,
    // `"stale"` whenever the engine's lease-scoped CAS marked the task; the
    // other values report the task's actual status after a zero-row CAS
    // (the lease was reissued or resolved between the gate and the marking).
    status: z.enum(["stale", "pending", "claimed", "submitted"]),
    reason: z.enum(["result-set-digest-mismatch", "revision-cas-failed"]),
    expectedResultSetDigest: hex64,
    actualResultSetDigest: hex64,
  }).strict(),
]);

const syncApprovedResult = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("synced"),
    generation: nonNegativeInteger,
    coverage: z.literal("complete"),
    unchanged: z.boolean(),
    entryCount: nonNegativeInteger,
  }).strict(),
  z.object({
    status: z.literal("conflict"),
    generation: nonNegativeInteger,
    coverage: coverageState,
    sourceTreeDigest: hex64.nullable(),
  }).strict(),
]);

const searchResult = z.object({
  generation: nonNegativeInteger,
  coverage: coverageState,
  items: z.array(z.object({
    rank: positiveInteger,
    entryId: identifier,
    revision: positiveInteger,
    contentDigest: hex64,
    status: nonEmptyString,
    summary: z.string(),
  }).strict()),
}).strict();

const reviewQueueResult = z.object({
  items: z.array(z.object({
    candidateId: identifier,
    candidateKind: z.enum(["entry", "skill", "consolidation-patch"]),
    chunkRef: identifier,
    revision: positiveInteger,
    contentDigest: hex64,
    payload: plainObject,
    assessments: z.array(z.object({
      statementId: identifier,
      citationsDigest: hex64,
      provenanceStrength: nonEmptyString,
      limitations: z.array(z.string()),
      claimSupport: nonEmptyString,
      assessedBy: nonEmptyString,
      statementTextDigest: hex64,
      revision: positiveInteger,
    }).strict()),
  }).strict()),
}).strict();

const statusResult = z.object({
  chunks: z.object({
    pending: nonNegativeInteger,
    drafted: nonNegativeInteger,
    extracted: nonNegativeInteger,
    stale: nonNegativeInteger,
  }).strict(),
  tasks: z.object({
    pending: nonNegativeInteger,
    claimed: nonNegativeInteger,
    submitted: nonNegativeInteger,
    stale: nonNegativeInteger,
  }).strict(),
  candidates: z.object({
    draft: nonNegativeInteger,
    quarantined: nonNegativeInteger,
    promoted: nonNegativeInteger,
    discarded: nonNegativeInteger,
  }).strict(),
  promotions: z.object({
    generated: nonNegativeInteger,
    approved: nonNegativeInteger,
    applying: nonNegativeInteger,
    applied: nonNegativeInteger,
    voided: nonNegativeInteger,
    applyingPlanIds: z.array(identifier),
  }).strict(),
  consolidations: z.object({
    pendingReview: nonNegativeInteger,
    noOp: nonNegativeInteger,
    applied: nonNegativeInteger,
    stale: nonNegativeInteger,
    lastSuccessfulEntryCount: nonNegativeInteger,
    lastSuccessfulNoOp: z.boolean(),
  }).strict(),
}).strict();

const confirmStatementResult = z.discriminatedUnion("status", [
  z.object({
    candidateId: identifier,
    statementId: identifier,
    status: z.literal("confirmed"),
    claimSupport: z.literal("human-confirmed"),
    assessedBy: z.literal("human"),
    revision: positiveInteger,
  }).strict(),
  z.object({
    candidateId: identifier,
    statementId: identifier,
    status: z.literal("drifted"),
    actualStatementTextDigest: hex64,
    actualCitationsDigest: hex64,
  }).strict(),
]);

const discardCandidateResult = z.object({
  candidateId: identifier,
  status: z.literal("discarded"),
  revision: positiveInteger,
  candidateGeneration: nonNegativeInteger,
}).strict();

const promotionPlanResult = z.object({
  planId: uuidString,
  planDigest: hex64,
  status: z.literal("generated"),
  owner: z.object({
    ...ownerFields,
    memoryRoot: identifier,
  }).strict(),
  candidateIds: z.array(identifier).min(1),
  policyVersion: identifier,
  assessmentDigest: hex64,
  files: z.array(z.object({
    targetPath,
    targetBlobHash: hex40.nullable(),
    operation: z.enum(["write", "delete"]),
    sanitizedDigest: hex64.nullable(),
    bytes: nonNegativeInteger,
  }).strict()).min(1),
}).strict();

const promotionApproveResult = z.object({
  planId: identifier,
  planDigest: hex64,
  status: z.literal("approved"),
  idempotent: z.boolean(),
}).strict();

const promotionApplyResult = z.discriminatedUnion("status", [
  z.object({
    planId: identifier,
    status: z.literal("applied"),
    idempotent: z.boolean(),
    appliedFiles: z.array(targetPath),
    candidates: z.array(z.object({
      candidateId: identifier,
      revision: positiveInteger,
      status: z.literal("promoted"),
    }).strict()),
    candidateGeneration: nonNegativeInteger,
  }).strict(),
  z.object({
    planId: identifier,
    status: z.literal("voided"),
    driftedPath: targetPath,
  }).strict(),
]);

const authorizeResult = z.object({
  planDigest: hex64,
  taskId: identifier.nullable(),
  via: z.enum(["interactive", "digest", "manifest"]),
  decidedAt: nonNegativeInteger,
}).strict();

const OP_SPECS = Object.freeze({
  "open": { request: openRequest, result: openResult },
  "bind-repository": { request: bindRepositoryRequest, result: bindRepositoryResult },
  "list-memory-files": { request: listMemoryFilesRequest, result: listMemoryFilesResult },
  "read-memory-file": { request: readMemoryFileRequest, result: readMemoryFileResult },
  "plan-tasks": { request: planTasksRequest, result: planTasksResult },
  "claim-task": { request: claimTaskRequest, result: claimTaskResult },
  "abandon-task": { request: abandonTaskRequest, result: abandonTaskResult },
  "submit-extraction": { request: submitExtractionRequest, result: submitExtractionResult },
  "submit-consolidation": { request: submitConsolidationRequest,
    result: submitConsolidationResult },
  "consolidation-baseline": { request: consolidationBaselineRequest,
    result: consolidationBaselineResult },
  "recall": { request: recallRequest, result: recallResult },
  "submit-adjudication": { request: submitAdjudicationRequest, result: submitAdjudicationResult },
  "sync-approved": { request: syncApprovedRequest, result: syncApprovedResult },
  "search": { request: searchRequest, result: searchResult },
  "review-queue": { request: reviewQueueRequest, result: reviewQueueResult },
  "status": { request: statusRequest, result: statusResult },
  "confirm-statement": { request: confirmStatementRequest, result: confirmStatementResult },
  "discard-candidate": { request: discardCandidateRequest, result: discardCandidateResult },
  "promotion-plan": { request: promotionPlanRequest, result: promotionPlanResult },
  "promotion-approve": { request: promotionApproveRequest, result: promotionApproveResult },
  "promotion-apply": { request: promotionApplyRequest, result: promotionApplyResult },
  "authorize": { request: authorizeRequest, result: authorizeResult },
});

function firstIssue(error) {
  const issue = error?.issues?.[0];
  if (issue === undefined) return error?.message ?? "schema validation failed";
  const path = issue.path?.length ? `${issue.path.join(".")}: ` : "";
  return `${path}${issue.message}`;
}

async function runMemoryOp(engine, op, input, options) {
  const spec = OP_SPECS[op];
  let payload;
  try {
    payload = spec.request.parse(input);
  } catch (cause) {
    throw new MemoryStateClientError(
      "TS_MEMORY_REQUEST_INVALID",
      `memory ${op} request is invalid: ${firstIssue(cause)}`,
      { cause },
    );
  }
  const result = await engine.memoryCommand({ op, payload }, options);
  try {
    return spec.result.parse(result);
  } catch (cause) {
    throw new MemoryStateClientError(
      "TS_MEMORY_RESULT_INVALID",
      `memory ${op} result is invalid: ${firstIssue(cause)}`,
      { cause },
    );
  }
}

// Only these typed wrappers are exported. Each validates the request payload
// with zod before sending and validates the MEMORY_RESULT payload with zod
// before returning, so callers get op-level request/result guarantees (pinned
// schemaVersion, v4 UUIDs, strict object shapes). The raw `engine.memoryCommand`
// on InsightsEngineClient carries only envelope-level checks and gives NO
// op-level guarantee — always go through these wrappers, never call
// `engine.memoryCommand` directly for a memory op.
export function memoryOpen(engine, input, options = {}) {
  return runMemoryOp(engine, "open", input, options);
}

export function memoryBindRepository(engine, input, options = {}) {
  return runMemoryOp(engine, "bind-repository", input, options);
}

export function memoryListFiles(engine, input, options = {}) {
  return runMemoryOp(engine, "list-memory-files", input, options);
}

export function memoryReadFile(engine, input, options = {}) {
  return runMemoryOp(engine, "read-memory-file", input, options);
}

export function memoryPlanTasks(engine, input, options = {}) {
  return runMemoryOp(engine, "plan-tasks", input, options);
}

export function memoryClaimTask(engine, input, options = {}) {
  return runMemoryOp(engine, "claim-task", input, options);
}

export function memoryAbandonTask(engine, input, options = {}) {
  return runMemoryOp(engine, "abandon-task", input, options);
}

export function memorySubmitExtraction(engine, input, options = {}) {
  return runMemoryOp(engine, "submit-extraction", input, options);
}

export function memorySubmitConsolidation(engine, input, options = {}) {
  return runMemoryOp(engine, "submit-consolidation", input, options);
}

export function memoryConsolidationBaseline(engine, input, options = {}) {
  return runMemoryOp(engine, "consolidation-baseline", input, options);
}

export function memoryRecall(engine, input, options = {}) {
  return runMemoryOp(engine, "recall", input, options);
}

export function memorySubmitAdjudication(engine, input, options = {}) {
  return runMemoryOp(engine, "submit-adjudication", input, options);
}

export function memorySyncApproved(engine, input, options = {}) {
  return runMemoryOp(engine, "sync-approved", input, options);
}

export function memorySearch(engine, input, options = {}) {
  return runMemoryOp(engine, "search", input, options);
}

export function memoryReviewQueue(engine, input, options = {}) {
  return runMemoryOp(engine, "review-queue", input, options);
}

export function memoryStatus(engine, input, options = {}) {
  return runMemoryOp(engine, "status", input, options);
}

export function memoryConfirmStatement(engine, input, options = {}) {
  return runMemoryOp(engine, "confirm-statement", input, options);
}

export function memoryDiscardCandidate(engine, input, options = {}) {
  return runMemoryOp(engine, "discard-candidate", input, options);
}

export function memoryPromotionPlan(engine, input, options = {}) {
  return runMemoryOp(engine, "promotion-plan", input, options);
}

export function memoryPromotionApprove(engine, input, options = {}) {
  return runMemoryOp(engine, "promotion-approve", input, options);
}

export function memoryPromotionApply(engine, input, options = {}) {
  return runMemoryOp(engine, "promotion-apply", input, options);
}

export function memoryAuthorize(engine, input, options = {}) {
  return runMemoryOp(engine, "authorize", input, options);
}
