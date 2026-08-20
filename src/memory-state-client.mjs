/**
 * Team Memory Stage 4a op wrappers over `InsightsEngineClient.memoryCommand`
 * (design doc `docs/team-memory-phase1-design.md` §3, DEV-4).
 *
 * Each Stage 4a op gets one `memoryXxx(engine, input, options)` function that
 * validates the request payload with zod before sending, sends one
 * `MEMORY_COMMAND{op}` frame, and validates the `MEMORY_RESULT` payload with
 * zod before returning it. The zod schemas mirror the normative wire schema in
 * the documentation block at the top of
 * `crates/insights-engine/src/memory_protocol.rs`; the envelope-level checks
 * live in `insights-engine-protocol.mjs`.
 *
 * Structured stale outcomes of `submit-adjudication` are not exceptions: the
 * result is a discriminated union on `status` (`"applied" | "stale"`). Engine
 * failures surface as `InsightsEngineClientError` with the remote
 * `TS_MEMORY_*` code; local schema failures throw `MemoryStateClientError`
 * with `TS_MEMORY_REQUEST_INVALID` / `TS_MEMORY_RESULT_INVALID`.
 */

import { z } from "zod";

// Bounds mirroring crates/insights-engine/src/memory_protocol.rs.
export const MEMORY_MAX_TEXT_BYTES = 64 * 1024;
export const MEMORY_MAX_PAYLOAD_ITEMS = 512;
export const MEMORY_MAX_RECALL_DRAFTS = 64;
export const MEMORY_MAX_SYNC_ENTRIES = 4096;
export const MEMORY_MAX_LEASE_MS = 86_400_000;

const HEX64_PATTERN = /^[0-9a-f]{64}$/;
const CLAIM_TOKEN_PATTERN = /^[0-9a-f]{32}$/;
const DECIMAL_PATTERN = /^(0|[1-9][0-9]*)$/;
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

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
const uuidString = z.string().regex(UUID_PATTERN, "expected a lowercase uuid");
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

const submitExtractionRequest = z.object({
  taskId: identifier,
  claimToken: identifier,
  responseDigest: hex64,
  drafts: z.array(z.object({
    candidateId: identifier,
    payload: plainObject,
    searchableText: boundedText,
  }).strict()).min(1).max(MEMORY_MAX_PAYLOAD_ITEMS),
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
  for (const [index, adjudication] of request.adjudications.entries()) {
    if (!pending.delete(adjudication.draftRef)) {
      context.addIssue({
        code: z.ZodIssueCode.custom,
        message: "adjudications[].draftRef must match a recall draft exactly once",
        path: ["adjudications", index, "draftRef"],
      });
    }
    if (adjudication.action === "store" || adjudication.action === "skip") {
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
}).strict();

const statusRequest = z.object({ ...ownerFields }).strict();

// ---------------------------------------------------------------------------
// Result schemas (engine → client).
// ---------------------------------------------------------------------------

const openResult = z.object({
  memoryStateUuid: uuidString,
  schemaVersion: positiveInteger,
}).strict();

const bindRepositoryResult = z.object({
  ...ownerFields,
  publicRepositoryIdentity: nonEmptyString.nullable(),
  memoryRoot: nonEmptyString,
  status: z.enum(["active", "inactive"]),
}).strict();

const planTasksResult = z.object({
  insertedChunks: nonNegativeInteger,
  skippedChunks: nonNegativeInteger,
  insertedTasks: nonNegativeInteger,
  skippedTasks: nonNegativeInteger,
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

const submitAdjudicationResult = z.discriminatedUnion("status", [
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
    status: z.literal("stale"),
    reason: z.enum(["result-set-digest-mismatch", "revision-cas-failed"]),
    expectedResultSetDigest: hex64,
    actualResultSetDigest: hex64,
  }).strict(),
]);

const syncApprovedResult = z.object({
  generation: nonNegativeInteger,
  coverage: z.literal("complete"),
  unchanged: z.boolean(),
  entryCount: nonNegativeInteger,
}).strict();

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
}).strict();

const OP_SPECS = Object.freeze({
  "open": { request: openRequest, result: openResult },
  "bind-repository": { request: bindRepositoryRequest, result: bindRepositoryResult },
  "plan-tasks": { request: planTasksRequest, result: planTasksResult },
  "claim-task": { request: claimTaskRequest, result: claimTaskResult },
  "submit-extraction": { request: submitExtractionRequest, result: submitExtractionResult },
  "recall": { request: recallRequest, result: recallResult },
  "submit-adjudication": { request: submitAdjudicationRequest, result: submitAdjudicationResult },
  "sync-approved": { request: syncApprovedRequest, result: syncApprovedResult },
  "search": { request: searchRequest, result: searchResult },
  "review-queue": { request: reviewQueueRequest, result: reviewQueueResult },
  "status": { request: statusRequest, result: statusResult },
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

export function memoryOpen(engine, input, options = {}) {
  return runMemoryOp(engine, "open", input, options);
}

export function memoryBindRepository(engine, input, options = {}) {
  return runMemoryOp(engine, "bind-repository", input, options);
}

export function memoryPlanTasks(engine, input, options = {}) {
  return runMemoryOp(engine, "plan-tasks", input, options);
}

export function memoryClaimTask(engine, input, options = {}) {
  return runMemoryOp(engine, "claim-task", input, options);
}

export function memorySubmitExtraction(engine, input, options = {}) {
  return runMemoryOp(engine, "submit-extraction", input, options);
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
