import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import { canonicalJson } from "../src/canonical-json.mjs";
import { createInsightsEngineClient } from "../src/insights-engine-client.mjs";
import {
  MemoryStateClientError,
  memoryBindRepository,
  memoryClaimTask,
  memoryOpen,
  memoryPlanTasks,
  memoryRecall,
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
  assert.equal(opened.schemaVersion, 1);
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
  });
  assert.deepEqual(await memoryPlanTasks(client, plan), {
    insertedChunks: 0,
    skippedChunks: 1,
    insertedTasks: 0,
    skippedTasks: 2,
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
      entries,
    }),
    { generation: 1, coverage: "complete", unchanged: false, entryCount: 1 },
  );
  assert.deepEqual(
    await memorySyncApproved(client, {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
      sourceTreeDigest,
      coverage: "complete",
      entries,
    }),
    { generation: 1, coverage: "complete", unchanged: true, entryCount: 1 },
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
    },
  );

  // partial scans are rejected with a structured conflict code.
  await assert.rejects(
    memorySyncApproved(client, {
      repositoryKey: REPOSITORY_KEY,
      worktreeKey: WORKTREE_KEY,
      sourceTreeDigest: digestHex({ tree: 2 }),
      coverage: "partial",
      entries: [],
    }),
    (error) => error.code === "TS_MEMORY_SYNC_PARTIAL",
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
