import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson } from "../src/canonical-json.mjs";
import { createInsightsEngineClient } from "../src/insights-engine-client.mjs";
import {
  MemoryStateClientError,
  memoryAuthorize,
  memoryBindRepository,
  memoryClaimTask,
  memoryConfirmStatement,
  memoryDiscardCandidate,
  memoryListFiles,
  memoryOpen,
  memoryPlanTasks,
  memoryPromotionApply,
  memoryPromotionApprove,
  memoryPromotionPlan,
  memoryRecall,
  memoryReadFile,
  memoryReviewQueue,
  memorySearch,
  memoryStatus,
  memorySubmitAdjudication,
  memorySubmitExtraction,
  memorySyncApproved,
} from "../src/memory-state-client.mjs";
import { INSIGHTS_E2E_ENGINE, INSIGHTS_E2E_SKIP } from "./helpers/insights-e2e.mjs";

const ORIGIN_SECRET_EPOCH = "33333333-3333-4333-8333-333333333333";
const REPOSITORY_KEY = "1".repeat(64);
const WORKTREE_KEY = "2".repeat(64);
const SESSION_KEY = "3".repeat(64);
const HEX32_PATTERN = /^[0-9a-f]{32}$/;
const UUID_PATTERN = /^[0-9a-f]{8}-(?:[0-9a-f]{4}-){3}[0-9a-f]{12}$/;

function handshakeContract() {
  return {
    factSchemaVersion: 1,
    providerAdapterVersions: ["claude@1", "codex@1"],
    privacyPolicyVersion: 1,
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    duplicatePolicyVersion: 1,
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: ["turn-search@2", "turn-summary@1"],
    analyzerCapabilities: ["mixed-cjk-code@1"],
    rankerVersion: 1,
  };
}

function clientOptions(databasePath) {
  return {
    runtimeOptions: {
      env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: INSIGHTS_E2E_ENGINE },
    },
    databasePath,
    requiredContract: handshakeContract(),
    timeoutMs: 10_000,
  };
}

async function temporaryDirectory(t) {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-memory-state-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  return directory;
}

async function startClient(t, directory, name) {
  const client = await createInsightsEngineClient(clientOptions(path.join(directory, name)));
  t.after(() => client.close());
  return client;
}

function digestHex(value) {
  return createHash("sha256").update(canonicalJson(value), "utf8").digest("hex");
}

function extractionSubmission(claimToken) {
  return {
    taskId: "task-extract-1",
    claimToken,
    responseDigest: digestHex({ response: "extraction-1" }),
    drafts: [
      {
        candidateId: "c-1",
        payload: {
          content: "Release tests are grouped under npm run test:release.",
          type: "work_method",
          priority: 60,
        },
        searchableText: "release tests are grouped under npm run test:release",
      },
      {
        candidateId: "c-2",
        payload: {
          content: "Memory recall fuses approved and candidate hits with RRF.",
          type: "work_fact",
          priority: 40,
        },
        searchableText: "memory recall fuses approved and candidate hits with rrf",
      },
    ],
    evidenceRefs: [
      {
        candidateId: "c-1",
        statementId: "s-1",
        evidenceId: "ev-1",
        pointerDigest: digestHex({ pointer: "commit" }),
        sessionKey: SESSION_KEY,
        relation: "supports",
        strength: "direct",
        limitations: ["single-session"],
      },
    ],
    assessments: [
      {
        candidateId: "c-1",
        statementId: "s-1",
        citationsDigest: digestHex([{ evidenceId: "ev-1" }]),
        provenanceStrength: "direct",
        limitations: ["single-session"],
        claimSupport: "unverified",
        assessedBy: "deterministic",
        statementTextDigest: digestHex("test:release covers protocol tests."),
        revision: 1,
      },
    ],
  };
}

test("memory ops run end-to-end against a real engine", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const directory = await temporaryDirectory(t);
  const client = await startClient(t, directory, "insights.sqlite3");
  const stateDir = path.join(directory, "state");

  // open is idempotent for the same stateDir and rejects a different one.
  const opened = await memoryOpen(client, { stateDir });
  assert.match(opened.memoryStateUuid, UUID_PATTERN);
  assert.equal(opened.schemaVersion, 2);
  assert.deepEqual(await memoryOpen(client, { stateDir }), opened);
  await assert.rejects(
    memoryOpen(client, { stateDir: path.join(directory, "other-state") }),
    (error) => error.code === "TS_MEMORY_REQUEST_INVALID",
  );

  // bind-repository upserts and never echoes rootRealpath (strict result schema).
  const binding = await memoryBindRepository(client, {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    publicRepositoryIdentity: "github.com/team-harness/threadshare",
    rootRealpath: directory,
    rootRealpathDigest: digestHex(directory),
    commonDirDevice: "16777232",
    commonDirInode: "987654",
  });
  assert.deepEqual(binding, {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    publicRepositoryIdentity: "github.com/team-harness/threadshare",
    memoryRoot: ".threadshare/memory",
    status: "active",
  });

  await mkdir(path.join(directory, ".threadshare", "memory", "entries"), { recursive: true });
  await mkdir(path.join(directory, ".threadshare", "memory", "scenes"), { recursive: true });
  await writeFile(path.join(directory, ".threadshare", "memory", "entries", "entry-a.md"),
    "approved entry\n");
  await writeFile(path.join(directory, ".threadshare", "memory", "scenes", "scene-a.md"),
    "scene content\n");
  await writeFile(path.join(directory, ".threadshare", "memory", "doctrine.md"),
    "doctrine content\n");
  assert.deepEqual(await memoryListFiles(client, {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    collection: "entries",
  }), { names: ["entry-a.md"] });
  assert.deepEqual(await memoryReadFile(client, {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    collection: "entries",
    name: "entry-a.md",
  }), { content: "approved entry\n" });
  assert.deepEqual(await memoryReadFile(client, {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    collection: "doctrine",
  }), { content: "doctrine content\n" });
  await assert.rejects(
    memoryListFiles(client, {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
      collection: "doctrine",
    }),
    (error) => error.code === "TS_MEMORY_REQUEST_INVALID",
  );

  // plan-tasks is idempotent per chunkRef/taskId.
  const plan = {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    chunks: [{
      chunkRef: "chunk-1",
      sessionKey: SESSION_KEY,
      turnRange: "0-7",
      chunkDigest: digestHex({ chunk: 1 }),
      provenanceSnapshotSeq: "42",
    }],
    tasks: [
      {
        taskId: "task-extract-1",
        kind: "extraction",
        chunkRef: "chunk-1",
        binding: { owner: { repositoryKey: REPOSITORY_KEY, worktreeKey: WORKTREE_KEY } },
      },
      {
        taskId: "task-adjudicate-1",
        kind: "adjudication",
        draftBatchRef: "batch-1",
        binding: { draftBatchRef: "batch-1" },
      },
    ],
  };
  assert.deepEqual(await memoryPlanTasks(client, plan), {
    insertedChunks: 1,
    skippedChunks: 0,
    insertedTasks: 2,
    skippedTasks: 0,
    tasks: [
      { taskId: "task-extract-1", status: "pending", claimable: true },
      { taskId: "task-adjudicate-1", status: "pending", claimable: true },
    ],
  });
  assert.deepEqual(await memoryPlanTasks(client, plan), {
    insertedChunks: 0,
    skippedChunks: 1,
    insertedTasks: 0,
    skippedTasks: 2,
    tasks: [
      { taskId: "task-extract-1", status: "pending", claimable: true },
      { taskId: "task-adjudicate-1", status: "pending", claimable: true },
    ],
  });

  // claim-task issues a lease and a hex32 claim token.
  await assert.rejects(
    memoryClaimTask(client, { taskId: "task-missing", leaseHolder: "e2e", leaseMs: 60_000 }),
    (error) => error.code === "TS_MEMORY_TASK_NOT_FOUND",
  );
  const claim = await memoryClaimTask(client, {
    taskId: "task-extract-1",
    leaseHolder: "e2e-holder",
    leaseMs: 60_000,
  });
  assert.match(claim.claimToken, HEX32_PATTERN);
  assert.equal(claim.task.taskId, "task-extract-1");
  assert.equal(claim.task.kind, "extraction");
  assert.equal(claim.task.status, "claimed");
  assert.equal(claim.task.chunkRef, "chunk-1");
  assert.equal(claim.task.lease.holder, "e2e-holder");
  assert.equal(claim.task.lease.epoch, 1);
  assert.deepEqual(claim.task.binding, plan.tasks[0].binding);

  // submit-extraction accepts once and replays idempotently on the same digest.
  const submission = extractionSubmission(claim.claimToken);
  const accepted = await memorySubmitExtraction(client, submission);
  assert.equal(accepted.taskId, "task-extract-1");
  assert.equal(accepted.idempotent, false);
  assert.equal(accepted.candidateGeneration, 1);
  assert.deepEqual(
    accepted.candidates.map(({ candidateId, revision, status }) =>
      ({ candidateId, revision, status })),
    [
      { candidateId: "c-1", revision: 1, status: "draft" },
      { candidateId: "c-2", revision: 1, status: "draft" },
    ],
  );
  const replayed = await memorySubmitExtraction(client, submission);
  assert.equal(replayed.idempotent, true);
  assert.deepEqual(replayed.candidates, accepted.candidates);
  await assert.rejects(
    memorySubmitExtraction(client, {
      ...submission,
      responseDigest: digestHex({ response: "different" }),
    }),
    (error) => error.code === "TS_MEMORY_SUBMISSION_CONFLICT",
  );

  // recall is read-only with stable digests.
  const recallInput = {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    k: 5,
    drafts: [{
      draftRef: "c-1",
      candidateId: "c-1",
      queryText: "release tests npm",
    }],
  };
  const recall = await memoryRecall(client, recallInput);
  assert.equal(recall.recallAlgorithmVersion, "recall-rrf@1");
  assert.equal(recall.k, 5);
  assert.deepEqual(recall.approvedProjection, {
    generation: 0,
    analyzerVersion: recall.approvedProjection.analyzerVersion,
    coverage: "complete",
  });
  assert.equal(
    recall.recallQueryDigest,
    digestHex({
      algorithm: "recall-rrf@1",
      k: 5,
      owner: { repositoryKey: REPOSITORY_KEY, worktreeKey: WORKTREE_KEY },
      drafts: recallInput.drafts,
    }),
  );
  // The batch's own candidate (c-1) is excluded from the candidate side.
  assert.equal(recall.pool.some((item) => item.id === "c-1"), false);
  assert.deepEqual(await memoryRecall(client, recallInput), recall);

  // submit-adjudication happy path: recall re-run matches, store quarantines.
  const adjudicationClaim = await memoryClaimTask(client, {
    taskId: "task-adjudicate-1",
    leaseHolder: "e2e-holder",
    leaseMs: 60_000,
  });
  const applied = await memorySubmitAdjudication(client, {
    taskId: "task-adjudicate-1",
    claimToken: adjudicationClaim.claimToken,
    responseDigest: digestHex({ response: "adjudication-1" }),
    recall: recallInput,
    expectedResultSetDigest: recall.resultSetDigest,
    adjudications: [{ draftRef: "c-1", action: "store" }],
  });
  assert.equal(applied.status, "applied");
  assert.equal(applied.idempotent, false);
  // Every adjudication action bumps the candidate revision (store included),
  // so the quarantined draft reports revision 2.
  assert.deepEqual(applied.outcomes, [{
    draftRef: "c-1",
    action: "store",
    candidateId: "c-1",
    candidateStatus: "quarantined",
    revision: 2,
  }]);

  // submit-adjudication stale path is a structured result, not an exception.
  await memoryPlanTasks(client, {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    chunks: [],
    tasks: [{
      taskId: "task-adjudicate-2",
      kind: "adjudication",
      draftBatchRef: "batch-2",
      binding: { draftBatchRef: "batch-2" },
    }],
  });
  const staleClaim = await memoryClaimTask(client, {
    taskId: "task-adjudicate-2",
    leaseHolder: "e2e-holder",
    leaseMs: 60_000,
  });
  const stale = await memorySubmitAdjudication(client, {
    taskId: "task-adjudicate-2",
    claimToken: staleClaim.claimToken,
    responseDigest: digestHex({ response: "adjudication-2" }),
    recall: {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
      drafts: [{ draftRef: "c-2", candidateId: "c-2", queryText: "memory recall" }],
    },
    expectedResultSetDigest: "0".repeat(64),
    adjudications: [{ draftRef: "c-2", action: "store" }],
  });
  assert.equal(stale.status, "stale");
  assert.equal(stale.taskId, "task-adjudicate-2");
  assert.equal(stale.reason, "result-set-digest-mismatch");
  assert.equal(stale.expectedResultSetDigest, "0".repeat(64));
  assert.match(stale.actualResultSetDigest, /^[0-9a-f]{64}$/);
  assert.notEqual(stale.actualResultSetDigest, stale.expectedResultSetDigest);

  // sync-approved replaces the owner projection and short-circuits when unchanged.
  const entries = [{
    entryId: "release-workflow-notes",
    revision: 1,
    contentDigest: digestHex({ entry: "release-workflow-notes" }),
    frontmatter: { type: "work_method" },
    bodyText: "Release tests are grouped under npm run test:release.",
    status: "active",
    searchableText: "release tests are grouped under npm run test:release",
  }];
  const sourceTreeDigest = digestHex({ tree: 1 });
  assert.deepEqual(
    await memorySyncApproved(client, {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
      sourceTreeDigest,
      coverage: "complete",
      expectedGeneration: 0,
      entries,
    }),
    { status: "synced", generation: 1, coverage: "complete", unchanged: false, entryCount: 1 },
  );
  assert.deepEqual(
    await memorySyncApproved(client, {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
      sourceTreeDigest,
      coverage: "complete",
      expectedGeneration: 1,
      entries,
    }),
    { status: "synced", generation: 1, coverage: "complete", unchanged: true, entryCount: 1 },
  );

  // A scan that raced a newer sync (stale expectedGeneration) is a structured
  // conflict carrying the current generation and stored tree digest.
  assert.deepEqual(
    await memorySyncApproved(client, {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
      sourceTreeDigest: digestHex({ tree: "raced" }),
      coverage: "complete",
      expectedGeneration: 0,
      entries: [],
    }),
    { status: "conflict", generation: 1, coverage: "complete", sourceTreeDigest },
  );

  // search finds the approved entry with generation/coverage provenance.
  const search = await memorySearch(client, {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    query: "release tests",
  });
  assert.equal(search.generation, 1);
  assert.equal(search.coverage, "complete");
  assert.equal(search.items[0].entryId, "release-workflow-notes");
  assert.equal(search.items[0].rank, 1);

  // review-queue lists the quarantined candidate with its assessments.
  const review = await memoryReviewQueue(client, {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
  });
  assert.equal(review.items.length, 1);
  assert.equal(review.items[0].candidateId, "c-1");
  assert.equal(review.items[0].chunkRef, "chunk-1");
  assert.equal(review.items[0].assessments.length, 1);
  assert.equal(review.items[0].assessments[0].statementId, "s-1");

  // status reports per-owner counters for the whole flow.
  assert.deepEqual(
    await memoryStatus(client, {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
    }),
    {
      chunks: { pending: 0, drafted: 0, extracted: 1, stale: 0 },
      tasks: { pending: 0, claimed: 0, submitted: 2, stale: 1 },
      candidates: { draft: 1, quarantined: 1, promoted: 0, discarded: 0 },
      promotions: { generated: 0, approved: 0, applying: 0, applied: 0, voided: 0,
        applyingPlanIds: [] },
      consolidations: {
        pendingReview: 0,
        noOp: 0,
        applied: 0,
        stale: 0,
        lastSuccessfulEntryCount: 0,
        lastSuccessfulNoOp: false,
      },
    },
  );

  // partial scans are rejected with a structured conflict code (and must pass
  // the same generation CAS as complete scans).
  await assert.rejects(
    memorySyncApproved(client, {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
      sourceTreeDigest: digestHex({ tree: 2 }),
      coverage: "partial",
      expectedGeneration: 1,
      entries: [],
    }),
    (error) => error.code === "TS_MEMORY_SYNC_PARTIAL",
  );

  // --- Stage 4c: confirmation and the full promotion chain. ---

  // A plan over the still-unverified candidate is refused.
  const sanitizedContent = Buffer.from(
    "# Release workflow notes\n\nRelease tests are grouped under npm run test:release.\n",
    "utf8",
  );
  const targetPath = ".threadshare/memory/entries/release-workflow-notes.md";
  const planInput = {
    owner: { repositoryKey: REPOSITORY_KEY, worktreeKey: WORKTREE_KEY },
    candidateIds: ["c-1"],
    policyVersion: "sanitize@1",
    perFile: [{
      targetPath,
      sanitizedContent: sanitizedContent.toString("base64"),
      targetBlobHash: null,
    }],
  };
  await assert.rejects(
    memoryPromotionPlan(client, planInput),
    (error) => error.code === "TS_MEMORY_UNVERIFIED_CLAIM",
  );

  // confirm-statement is digest-bound: drift is a structured result.
  const statementTextDigest = digestHex("test:release covers protocol tests.");
  const citationsDigest = digestHex([{ evidenceId: "ev-1" }]);
  const drifted = await memoryConfirmStatement(client, {
    candidateId: "c-1",
    statementId: "s-1",
    statementTextDigest: digestHex("some other statement text"),
    citationsDigest,
  });
  assert.equal(drifted.status, "drifted");
  assert.equal(drifted.actualStatementTextDigest, statementTextDigest);
  assert.equal(drifted.actualCitationsDigest, citationsDigest);
  const confirmed = await memoryConfirmStatement(client, {
    candidateId: "c-1",
    statementId: "s-1",
    statementTextDigest,
    citationsDigest,
  });
  assert.deepEqual(confirmed, {
    candidateId: "c-1",
    statementId: "s-1",
    status: "confirmed",
    claimSupport: "human-confirmed",
    assessedBy: "human",
    revision: 2,
  });

  // promotion-plan persists the sanitized bytes and the canonical digest.
  const planned = await memoryPromotionPlan(client, planInput);
  assert.equal(planned.status, "generated");
  assert.deepEqual(planned.owner, {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    memoryRoot: ".threadshare/memory",
  });
  assert.deepEqual(planned.candidateIds, ["c-1"]);
  assert.deepEqual(planned.files, [{
    targetPath,
    targetBlobHash: null,
    operation: "write",
    sanitizedDigest: createHash("sha256").update(sanitizedContent).digest("hex"),
    bytes: sanitizedContent.length,
  }]);

  // promotion-approve binds the exact plan digest.
  await assert.rejects(
    memoryPromotionApprove(client, {
      planId: planned.planId,
      planDigest: digestHex({ tampered: true }),
    }),
    (error) => error.code === "TS_MEMORY_PLAN_DIGEST_MISMATCH",
  );
  assert.deepEqual(
    await memoryPromotionApprove(client, {
      planId: planned.planId,
      planDigest: planned.planDigest,
    }),
    { planId: planned.planId, planDigest: planned.planDigest, status: "approved",
      idempotent: false },
  );

  // promotion-apply re-resolves the owner root before touching the worktree.
  await assert.rejects(
    memoryPromotionApply(client, {
      planId: planned.planId,
      ownerRootRealpath: path.join(directory, "elsewhere"),
    }),
    (error) => error.code === "TS_MEMORY_OWNER_MISMATCH",
  );
  const appliedPlan = await memoryPromotionApply(client, {
    planId: planned.planId,
    ownerRootRealpath: directory,
  });
  assert.equal(appliedPlan.status, "applied");
  assert.equal(appliedPlan.idempotent, false);
  assert.deepEqual(appliedPlan.appliedFiles, [targetPath]);
  assert.deepEqual(appliedPlan.candidates, [{
    candidateId: "c-1",
    revision: 3,
    status: "promoted",
  }]);
  assert.equal(appliedPlan.candidateGeneration, 3);

  // The exact approved bytes landed in the bound worktree.
  assert.deepEqual(await readFile(path.join(directory, targetPath)), sanitizedContent);

  // Re-applying an applied plan replays idempotently.
  const replayApply = await memoryPromotionApply(client, {
    planId: planned.planId,
    ownerRootRealpath: directory,
  });
  assert.equal(replayApply.status, "applied");
  assert.equal(replayApply.idempotent, true);

  // The promoted candidate left the recall pool and the review queue.
  const promotedRecall = await memoryRecall(client, {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    drafts: [{ draftRef: "p-1", candidateId: "p-1", queryText: "release tests npm" }],
  });
  assert.equal(promotedRecall.pool.some((item) => item.id === "c-1"), false);
  assert.deepEqual(
    (await memoryReviewQueue(client, {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
    })).items,
    [],
  );

  // discard-candidate is a revision CAS.
  await assert.rejects(
    memoryDiscardCandidate(client, { candidateId: "c-2", expectedRevision: 7 }),
    (error) => error.code === "TS_MEMORY_CANDIDATE_STALE",
  );
  assert.deepEqual(
    await memoryDiscardCandidate(client, { candidateId: "c-2", expectedRevision: 1 }),
    { candidateId: "c-2", status: "discarded", revision: 2, candidateGeneration: 4 },
  );

  // authorize appends an audit row bound to the plan digest.
  const authorized = await memoryAuthorize(client, {
    planDigest: planned.planDigest,
    provider: "claude",
    model: "claude-test-1",
    endpoint: "api.anthropic.com",
    bytes: 2048,
    via: "interactive",
  });
  assert.equal(authorized.planDigest, planned.planDigest);
  assert.equal(authorized.taskId, null);
  assert.equal(authorized.via, "interactive");
  assert.equal(typeof authorized.decidedAt, "number");

  // The status counters reflect the finished promotion.
  assert.deepEqual(
    await memoryStatus(client, {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
    }),
    {
      chunks: { pending: 0, drafted: 0, extracted: 1, stale: 0 },
      tasks: { pending: 0, claimed: 0, submitted: 2, stale: 1 },
      candidates: { draft: 0, quarantined: 0, promoted: 1, discarded: 1 },
      promotions: { generated: 0, approved: 0, applying: 0, applied: 1, voided: 0,
        applyingPlanIds: [] },
      consolidations: {
        pendingReview: 0,
        noOp: 0,
        applied: 0,
        stale: 0,
        lastSuccessfulEntryCount: 0,
        lastSuccessfulNoOp: false,
      },
    },
  );

  // Local zod validation rejects before any frame is sent.
  await assert.rejects(
    memoryClaimTask(client, { taskId: "task-extract-1", leaseHolder: "e2e", leaseMs: 0 }),
    (error) => error instanceof MemoryStateClientError &&
      error.code === "TS_MEMORY_REQUEST_INVALID",
  );
  await assert.rejects(
    memorySubmitAdjudication(client, {
      taskId: "task-adjudicate-1",
      claimToken: "deadbeef",
      responseDigest: digestHex({ response: "x" }),
      recall: recallInput,
      expectedResultSetDigest: recall.resultSetDigest,
      adjudications: [{ draftRef: "c-1", action: "merge" }],
    }),
    (error) => error instanceof MemoryStateClientError &&
      error.code === "TS_MEMORY_REQUEST_INVALID" &&
      /update\/merge/.test(error.message),
  );
  for (const badTargetPath of ["/abs.md", "../escape.md", "a//b.md", "a\\b.md", "a/./b.md"]) {
    await assert.rejects(
      memoryPromotionPlan(client, {
        ...planInput,
        perFile: [{ targetPath: badTargetPath, sanitizedContent: "", targetBlobHash: null }],
      }),
      (error) => error instanceof MemoryStateClientError &&
        error.code === "TS_MEMORY_REQUEST_INVALID",
      badTargetPath,
    );
  }
});

test("concurrent claims from two engine processes award exactly one lease", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const directory = await temporaryDirectory(t);
  const stateDir = path.join(directory, "state");
  const first = await startClient(t, directory, "insights-a.sqlite3");
  const second = await startClient(t, directory, "insights-b.sqlite3");

  const openedFirst = await memoryOpen(first, { stateDir });
  const openedSecond = await memoryOpen(second, { stateDir });
  assert.deepEqual(openedSecond, openedFirst);

  await memoryBindRepository(first, {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    publicRepositoryIdentity: null,
    rootRealpath: directory,
    rootRealpathDigest: digestHex(directory),
    commonDirDevice: "1",
    commonDirInode: "2",
  });
  await memoryPlanTasks(first, {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    chunks: [{
      chunkRef: "chunk-race",
      sessionKey: SESSION_KEY,
      turnRange: "0-1",
      chunkDigest: digestHex({ chunk: "race" }),
    }],
    tasks: [{
      taskId: "task-race",
      kind: "extraction",
      chunkRef: "chunk-race",
      binding: { race: true },
    }],
  });

  const outcomes = await Promise.allSettled([
    memoryClaimTask(first, { taskId: "task-race", leaseHolder: "holder-a", leaseMs: 60_000 }),
    memoryClaimTask(second, { taskId: "task-race", leaseHolder: "holder-b", leaseMs: 60_000 }),
  ]);
  const winners = outcomes.filter((outcome) => outcome.status === "fulfilled");
  const losers = outcomes.filter((outcome) => outcome.status === "rejected");
  assert.equal(winners.length, 1);
  assert.equal(losers.length, 1);
  assert.equal(winners[0].value.task.status, "claimed");
  assert.match(winners[0].value.claimToken, HEX32_PATTERN);
  assert.equal(losers[0].reason.code, "TS_MEMORY_TASK_NOT_CLAIMABLE");
});

// A minimal engine stub that echoes a fixed RESULT, so the RESULT schema
// tightening can be exercised without a debug engine binary.
function stubEngine(result) {
  return { memoryCommand: async () => result };
}

const V4_UUID = "6f9619ff-8b86-4d11-b42d-00c04fc964ff";
const OPEN_INPUT = { stateDir: "/tmp/threadshare-open" };

test("open RESULT pins schemaVersion to literal 2", async () => {
  const valid = { memoryStateUuid: V4_UUID, schemaVersion: 2 };
  assert.deepEqual(await memoryOpen(stubEngine(valid), OPEN_INPUT), valid);
  await assert.rejects(
    memoryOpen(stubEngine({ memoryStateUuid: V4_UUID, schemaVersion: 1 }), OPEN_INPUT),
    (error) => error instanceof MemoryStateClientError &&
      error.code === "TS_MEMORY_RESULT_INVALID",
  );
});

test("open RESULT rejects UUIDs that are not v4", async () => {
  // Wrong version nibble (position 14: "1" instead of "4").
  await assert.rejects(
    memoryOpen(
      stubEngine({ memoryStateUuid: "6f9619ff-8b86-1d11-b42d-00c04fc964ff", schemaVersion: 2 }),
      OPEN_INPUT,
    ),
    (error) => error instanceof MemoryStateClientError &&
      error.code === "TS_MEMORY_RESULT_INVALID",
  );
  // Wrong variant nibble (position 19: "c" is not in [89ab]).
  await assert.rejects(
    memoryOpen(
      stubEngine({ memoryStateUuid: "6f9619ff-8b86-4d11-c42d-00c04fc964ff", schemaVersion: 2 }),
      OPEN_INPUT,
    ),
    (error) => error instanceof MemoryStateClientError &&
      error.code === "TS_MEMORY_RESULT_INVALID",
  );
  // Uppercase hex is not the lowercase v4 shape the engine emits.
  await assert.rejects(
    memoryOpen(
      stubEngine({ memoryStateUuid: V4_UUID.toUpperCase(), schemaVersion: 2 }),
      OPEN_INPUT,
    ),
    (error) => error instanceof MemoryStateClientError &&
      error.code === "TS_MEMORY_RESULT_INVALID",
  );
});

test("sync-approved requires the expectedGeneration CAS and parses conflicts", async () => {
  const neverSend = { memoryCommand: async () => { throw new Error("must not send"); } };
  // The request without expectedGeneration is rejected locally.
  await assert.rejects(
    memorySyncApproved(neverSend, {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
      sourceTreeDigest: digestHex({ tree: 1 }),
      coverage: "complete",
      entries: [],
    }),
    (error) => error instanceof MemoryStateClientError &&
      error.code === "TS_MEMORY_REQUEST_INVALID" &&
      /expectedGeneration/.test(error.message),
  );

  // Both branches of the result union parse strictly.
  const request = {
    repositoryKey: REPOSITORY_KEY,
    worktreeKey: WORKTREE_KEY,
    sourceTreeDigest: digestHex({ tree: 1 }),
    coverage: "complete",
    expectedGeneration: 0,
    entries: [],
  };
  const conflict = {
    status: "conflict",
    generation: 4,
    coverage: "partial",
    sourceTreeDigest: digestHex({ tree: "stored" }),
  };
  assert.deepEqual(await memorySyncApproved(stubEngine(conflict), request), conflict);
  const synced = {
    status: "synced", generation: 5, coverage: "complete", unchanged: false, entryCount: 0,
  };
  assert.deepEqual(await memorySyncApproved(stubEngine(synced), request), synced);
  // The legacy status-less shape is no longer a valid result.
  await assert.rejects(
    memorySyncApproved(
      stubEngine({ generation: 1, coverage: "complete", unchanged: false, entryCount: 0 }),
      request,
    ),
    (error) => error instanceof MemoryStateClientError &&
      error.code === "TS_MEMORY_RESULT_INVALID",
  );
});

test("submit-adjudication rejects duplicate target ids across the request", async () => {
  const neverSend = { memoryCommand: async () => { throw new Error("must not send"); } };
  const base = {
    taskId: "task-adj",
    claimToken: "0".repeat(32),
    responseDigest: digestHex({ response: "adjudication" }),
    recall: {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
      drafts: [
        { draftRef: "d1", candidateId: "c-1", queryText: "alpha" },
        { draftRef: "d2", candidateId: "c-2", queryText: "beta" },
      ],
    },
    expectedResultSetDigest: digestHex({ resultSet: 1 }),
  };
  const merged = { mergedPayload: { content: "m" }, mergedSearchableText: "m" };
  // Duplicate ids inside one adjudication.
  await assert.rejects(
    memorySubmitAdjudication(neverSend, {
      ...base,
      adjudications: [
        {
          draftRef: "d1",
          action: "merge",
          targets: [{ id: "t-1", revision: 1 }, { id: "t-1", revision: 2 }],
          ...merged,
        },
        { draftRef: "d2", action: "skip" },
      ],
    }),
    (error) => error instanceof MemoryStateClientError &&
      error.code === "TS_MEMORY_REQUEST_INVALID" &&
      /targets\..*id.*unique|unique across the request/.test(error.message),
  );
  // Duplicate ids across two adjudications.
  await assert.rejects(
    memorySubmitAdjudication(neverSend, {
      ...base,
      adjudications: [
        { draftRef: "d1", action: "merge", targets: [{ id: "t-1", revision: 1 }], ...merged },
        { draftRef: "d2", action: "update", targets: [{ id: "t-1", revision: 1 }], ...merged },
      ],
    }),
    (error) => error instanceof MemoryStateClientError &&
      error.code === "TS_MEMORY_REQUEST_INVALID",
  );
  // Distinct target ids still validate locally (the stub then replies stale).
  const stale = {
    taskId: "task-adj",
    status: "stale",
    reason: "revision-cas-failed",
    expectedResultSetDigest: base.expectedResultSetDigest,
    actualResultSetDigest: digestHex({ resultSet: 2 }),
  };
  assert.deepEqual(
    await memorySubmitAdjudication(stubEngine(stale), {
      ...base,
      adjudications: [
        { draftRef: "d1", action: "merge", targets: [{ id: "t-1", revision: 1 }], ...merged },
        { draftRef: "d2", action: "update", targets: [{ id: "t-2", revision: 1 }], ...merged },
      ],
    }),
    stale,
  );
});
