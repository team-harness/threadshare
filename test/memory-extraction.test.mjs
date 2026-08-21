import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { canonicalJson } from "../src/canonical-json.mjs";
import {
  MEMORY_ADJUDICATION_TASK_FORMAT,
  MEMORY_CANDIDATE_DRAFT_BATCH_FORMAT,
  MEMORY_EVIDENCE_ASSESSMENT_FORMAT,
  MEMORY_EXTRACTION_TASK_FORMAT,
  parseMemoryContract,
} from "../src/memory-contracts.mjs";
import { PROMPT_VERSION, TRANSCRIPT_PREAMBLE } from "../src/memory-prompts.mjs";
import {
  CHUNKER_VERSION,
  DEFAULT_CHUNK_BUDGET_BYTES,
  MemoryExtractionError,
  TOOL_PAYLOAD_EXCERPT_BYTES,
  TYPED_FACT_ALLOWLIST,
  buildAdjudicationTask,
  buildEvidenceCatalog,
  buildExtractionTask,
  chunkSession,
  collectPayloadDigests,
  computeChunkDigest,
  computeCitationsDigest,
  computeDraftBatchDigest,
  computeRecallQueryDigest,
  computeResultSetDigest,
  computeSourceInputDigest,
  computeStatementTextDigest,
  deriveEvidenceAssessments,
  loadSessionTurns,
  planSessionChunks,
  renderTypedFact,
  serializeTranscript,
} from "../src/memory-extraction.mjs";

const HEX = (character) => character.repeat(64);
const HEX40 = (character) => character.repeat(40);
const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex");

// ---------------------------------------------------------------------------
// §6.2 chunking
// ---------------------------------------------------------------------------

function userTurn(turnIndex, textLength, fill = "a") {
  return { turnIndex, events: [{ role: "user", text: fill.repeat(textLength) }] };
}

// A single-user-event turn serializes to `<<past-user>>\n{text}\n\n` = text + 16 bytes.
const USER_TURN_OVERHEAD = 16;

test("chunkSession packs an exact-fit budget into one chunk and overflows into the next", () => {
  const turns = [userTurn(0, 100), userTurn(1, 100), userTurn(2, 100)];
  const perTurn = 100 + USER_TURN_OVERHEAD;

  const exact = chunkSession({ turns, budgetBytes: perTurn * 2 });
  assert.equal(exact.length, 2);
  assert.deepEqual(exact[0].turnRange, { start: 0, end: 1 });
  assert.deepEqual(exact[1].turnRange, { start: 2, end: 2 });

  const oneShort = chunkSession({ turns, budgetBytes: perTurn * 2 - 1 });
  assert.equal(oneShort.length, 3);
  assert.deepEqual(oneShort.map((chunk) => chunk.turnRange), [
    { start: 0, end: 0 }, { start: 1, end: 1 }, { start: 2, end: 2 },
  ]);
  for (const chunk of exact) {
    for (const entry of chunk.coverage) assert.equal(entry.completeness, "full");
  }
});

test("chunkSession excerpts oversized tool payloads with declared truncation", () => {
  const payload = "x".repeat(10000);
  const userText = "please run the tool";
  const turns = [{
    turnIndex: 7,
    events: [
      { role: "user", text: userText },
      { role: "tool_call", text: "{\"tool\":\"run\"}" },
      { role: "tool_result", text: payload },
      { role: "assistant", text: "done" },
    ],
  }];
  const [chunk] = chunkSession({ turns, budgetBytes: 4096 });
  const toolResult = chunk.events.find((event) => event.role === "tool_result");
  assert.equal(toolResult.truncated, true);
  assert.equal(toolResult.payloadSha256, sha256(payload));
  assert.equal(toolResult.payloadBytes, 10000);
  assert.ok(toolResult.text.startsWith("x".repeat(TOOL_PAYLOAD_EXCERPT_BYTES)));
  assert.ok(toolResult.text.endsWith("x".repeat(TOOL_PAYLOAD_EXCERPT_BYTES)));
  assert.ok(toolResult.text.includes(`sha256=${sha256(payload)}`));

  const turnCoverage = chunk.coverage.find((entry) => entry.sourceKind === "turn");
  assert.deepEqual(
    { ref: turnCoverage.ref, completeness: turnCoverage.completeness },
    { ref: "turn:7", completeness: "truncated" });
  const payloadCoverage = chunk.coverage.find((entry) => entry.sourceKind === "tool-payload");
  assert.deepEqual(payloadCoverage, {
    sourceKind: "tool-payload",
    ref: `payload:${sha256(payload)}`,
    completeness: "truncated",
    bytes: 10000,
  });

  // user/assistant text is byte-identical and untouched.
  assert.equal(chunk.events.find((event) => event.role === "user").text, userText);
  assert.equal(chunk.events.find((event) => event.role === "assistant").text, "done");
  assert.deepEqual(collectPayloadDigests(chunk), [sha256(payload)]);
});

test("chunkSession never truncates user/assistant text even over budget", () => {
  const bigUser = "u".repeat(DEFAULT_CHUNK_BUDGET_BYTES + 5000);
  const turns = [userTurn(0, 10), { turnIndex: 1, events: [{ role: "user", text: bigUser }] }, userTurn(2, 10)];
  const chunks = chunkSession({ turns });
  assert.equal(chunks.length, 3);
  const solo = chunks[1];
  assert.deepEqual(solo.turnRange, { start: 1, end: 1 });
  assert.equal(solo.events[0].text, bigUser);
  assert.equal(solo.events[0].truncated, undefined);
  assert.deepEqual(solo.coverage, [{
    sourceKind: "turn",
    ref: "turn:1",
    completeness: "full",
    bytes: Buffer.byteLength(bigUser) + USER_TURN_OVERHEAD,
  }]);
  assert.ok(serializeTranscript(solo).includes(bigUser));
});

test("chunkDigest is stable for equal input and sensitive to content", () => {
  const make = () => chunkSession({
    turns: [userTurn(0, 50), userTurn(1, 50)],
    budgetBytes: 4096,
  });
  const [first] = make();
  const [second] = make();
  assert.equal(first.chunkDigest, second.chunkDigest);
  assert.equal(first.chunkDigest, computeChunkDigest(first));

  const [changed] = chunkSession({
    turns: [userTurn(0, 50, "b"), userTurn(1, 50)],
    budgetBytes: 4096,
  });
  assert.notEqual(first.chunkDigest, changed.chunkDigest);
});

// ---------------------------------------------------------------------------
// Transcript serialization
// ---------------------------------------------------------------------------

test("serializeTranscript is deterministic with full role markers", () => {
  const [chunk] = chunkSession({
    turns: [{
      turnIndex: 0,
      events: [
        { role: "user", text: "question" },
        { role: "assistant", text: "thinking" },
        { role: "tool_call", text: "{\"tool\":\"grep\"}" },
        { role: "tool_result", text: "matches" },
      ],
    }],
    budgetBytes: 4096,
  });
  const first = serializeTranscript(chunk);
  const second = serializeTranscript(chunk);
  assert.equal(first, second);
  assert.ok(first.startsWith(`${TRANSCRIPT_PREAMBLE}\n\n`));
  for (const role of ["user", "assistant", "tool_call", "tool_result"]) {
    assert.ok(first.includes(`<<past-${role}>>\n`), `missing <<past-${role}>> marker`);
  }
  assert.ok(first.endsWith("<<end-of-transcript>>"));
});

// ---------------------------------------------------------------------------
// Evidence catalog + assessments (D5)
// ---------------------------------------------------------------------------

function fixtureChunkAndEvidence() {
  const [chunk] = chunkSession({
    turns: [
      { turnIndex: 3, turnRevision: HEX("a"), events: [{ role: "user", text: "fix the bug" }] },
      {
        turnIndex: 4,
        turnRevision: HEX("b"),
        events: [{ role: "assistant", text: "committed the fix" }],
      },
    ],
    budgetBytes: 4096,
  });
  const deliveryEdges = [
    {
      kind: "commit",
      relation: "turn-observed-commit",
      strength: "direct",
      limitations: ["not-authorship"],
      revision: HEX("1"),
      pointer: { commitHash: HEX40("c"), repository: "github.com/team-harness/threadshare" },
    },
    {
      // Same commit observed through a weaker relation: dedupes to strongest.
      kind: "commit",
      relation: "session-correlates-commit",
      strength: "observed",
      limitations: ["not-exclusive-line-attribution"],
      revision: HEX("2"),
      pointer: { commitHash: HEX40("c"), repository: "github.com/team-harness/threadshare" },
    },
    {
      kind: "path",
      relation: "commit-changed-file",
      strength: "observed",
      limitations: ["not-authorship"],
      revision: HEX("3"),
      pointer: { path: "src/session-files.mjs" },
    },
  ];
  return { chunk, evidence: buildEvidenceCatalog({ deliveryEdges, chunk }) };
}

test("buildEvidenceCatalog keeps strength derivation out of the catalog", () => {
  const { evidence } = fixtureChunkAndEvidence();
  // commit (deduped) + 2 chunk turns + path
  assert.equal(evidence.catalog.length, 4);
  for (const entry of evidence.catalog) {
    assert.deepEqual(Object.keys(entry).sort(), ["display", "evidenceId", "kind", "pointerDigest"]);
    assert.match(entry.evidenceId, /^ev-\d+-[0-9a-f]{12}$/);
  }
  const commitEntry = evidence.catalog.find((entry) => entry.kind === "commit");
  const internal = evidence.internalIndex[commitEntry.evidenceId];
  assert.equal(internal.strength, "direct");
  assert.equal(internal.relation, "turn-observed-commit");
  assert.deepEqual(internal.limitations, ["not-authorship", "not-exclusive-line-attribution"]);
  assert.deepEqual(evidence.deliveryEdgeRevisions, [HEX("1"), HEX("2"), HEX("3")]);
  const turnEntries = evidence.catalog.filter((entry) => entry.kind === "turn");
  assert.deepEqual(turnEntries.map((entry) => entry.display), ["turn 3", "turn 4"]
    .toSorted((l, r) => {
      const li = evidence.catalog.findIndex((e) => e.display === l);
      const ri = evidence.catalog.findIndex((e) => e.display === r);
      return li - ri;
    }));
});

function draftBatchWith(candidates) {
  return { format: MEMORY_CANDIDATE_DRAFT_BATCH_FORMAT, taskId: "task-1", candidates };
}

test("deriveEvidenceAssessments rejects out-of-task evidence ids with a code", () => {
  const { evidence } = fixtureChunkAndEvidence();
  const [goodId] = Object.keys(evidence.internalIndex);
  const batch = draftBatchWith([
    {
      content: "fabricated", type: "work_fact", priority: 10, confidence: "low", scene: null,
      statements: [{ statementId: "s1", text: "made up", evidenceIds: ["ev-99-deadbeefdead"] }],
    },
    {
      content: "legit", type: "work_fact", priority: 10, confidence: "high", scene: null,
      statements: [{ statementId: "s1", text: "supported", evidenceIds: [goodId] }],
    },
  ]);
  const result = deriveEvidenceAssessments({
    draftBatch: batch,
    internalIndex: evidence.internalIndex,
    candidateIds: ["cand-bad", "cand-good"],
  });
  assert.deepEqual(result.rejected, [{
    candidateId: "cand-bad",
    statementId: "s1",
    evidenceId: "ev-99-deadbeefdead",
    code: "unknown-evidence-id",
  }]);
  assert.equal(result.assessments.length, 1);
  assert.equal(result.assessments[0].candidateId, "cand-good");
});

test("deriveEvidenceAssessments derives strength, limitations, and unverified support", () => {
  const { evidence } = fixtureChunkAndEvidence();
  const commitId = evidence.catalog.find((entry) => entry.kind === "commit").evidenceId;
  const pathId = evidence.catalog.find((entry) => entry.kind === "path").evidenceId;
  const batch = draftBatchWith([{
    content: "memory", type: "work_method", priority: 60, confidence: "high", scene: null,
    statements: [
      { statementId: "s-none", text: "uncited claim", evidenceIds: [] },
      { statementId: "s-multi", text: "cited claim", evidenceIds: [pathId, commitId] },
    ],
  }]);
  const { assessments, rejected, confirmationBindings } = deriveEvidenceAssessments({
    draftBatch: batch,
    internalIndex: evidence.internalIndex,
    candidateIds: ["cand-1"],
  });
  assert.equal(rejected.length, 0);
  const byStatement = new Map(assessments.map((a) => [a.statementId, a]));

  const none = byStatement.get("s-none");
  assert.equal(none.provenanceStrength, "unknown");
  assert.deepEqual(none.limitations, []);
  assert.deepEqual(none.citations, []);

  const multi = byStatement.get("s-multi");
  // Strongest cited relation wins: direct commit beats observed path.
  assert.equal(multi.provenanceStrength, "direct");
  assert.deepEqual(multi.limitations, ["not-authorship", "not-exclusive-line-attribution"]);
  assert.equal(multi.citations.length, 2);

  for (const assessment of assessments) {
    assert.equal(assessment.format, MEMORY_EVIDENCE_ASSESSMENT_FORMAT);
    assert.equal(assessment.claimSupport, "unverified");
    assert.equal(assessment.assessedBy, "deterministic");
    parseMemoryContract(assessment);
  }
  assert.equal(byStatement.get("s-multi").statementTextDigest,
    computeStatementTextDigest("cited claim"));
  const binding = confirmationBindings.find((entry) => entry.statementId === "s-multi");
  assert.equal(binding.citationsDigest, computeCitationsDigest(multi.citations));
});

test("deriveEvidenceAssessments rejects duplicate statement ids", () => {
  const { evidence } = fixtureChunkAndEvidence();
  const batch = draftBatchWith([{
    content: "dup", type: "work_fact", priority: 5, confidence: "low", scene: null,
    statements: [
      { statementId: "s1", text: "one", evidenceIds: [] },
      { statementId: "s1", text: "two", evidenceIds: [] },
    ],
  }]);
  const result = deriveEvidenceAssessments({
    draftBatch: batch, internalIndex: evidence.internalIndex, candidateIds: ["cand-dup"],
  });
  assert.equal(result.assessments.length, 0);
  assert.deepEqual(result.rejected, [{
    candidateId: "cand-dup", statementId: "s1", code: "duplicate-statement-id",
  }]);
});

// ---------------------------------------------------------------------------
// Typed facts
// ---------------------------------------------------------------------------

test("renderTypedFact renders stable allowlisted templates", () => {
  assert.deepEqual(Object.keys(TYPED_FACT_ALLOWLIST).sort(),
    ["command-exit@1", "commit-changed-path@1"]);
  const commit = renderTypedFact("commit-changed-path@1", {
    commitHash: HEX40("d"), path: "src/share-url.mjs",
  });
  assert.deepEqual(commit, {
    kind: "commit-changed-path@1",
    text: `Commit ${HEX40("d")} changed src/share-url.mjs.`,
  });
  const exit = renderTypedFact("command-exit@1", { command: "npm test", exitCode: 0 });
  assert.deepEqual(exit, {
    kind: "command-exit@1",
    text: "Command `npm test` exited with code 0.",
  });
  // Determinism across calls.
  assert.deepEqual(renderTypedFact("command-exit@1", { command: "npm test", exitCode: 0 }), exit);
});

test("renderTypedFact rejects non-allowlisted kinds and invalid params", () => {
  assert.throws(
    () => renderTypedFact("free-form-claim@1", {}),
    (error) => error instanceof MemoryExtractionError
      && error.code === "typed-fact-kind-not-allowlisted");
  assert.throws(
    () => renderTypedFact("commit-changed-path@1", { commitHash: "short", path: "a" }),
    (error) => error.code === "typed-fact-invalid-params");
  assert.throws(
    () => renderTypedFact("command-exit@1", { command: "has `tick`", exitCode: 0 }),
    (error) => error.code === "typed-fact-invalid-params");
  assert.throws(
    () => renderTypedFact("command-exit@1", { command: "ok", exitCode: 1.5 }),
    (error) => error.code === "typed-fact-invalid-params");
});

// ---------------------------------------------------------------------------
// ExtractionTask assembly + digest sensitivity
// ---------------------------------------------------------------------------

function extractionFixture({ turnText = "fix the bug", taskId = "task-extract-1", lease = { holder: "cli", expiresAt: 1000 }, snapshotSeq = "42", evaluatedAt = "2026-08-20T00:00:00.000Z", requestDigest = HEX("2") } = {}) {
  const [chunk] = chunkSession({
    turns: [
      { turnIndex: 3, turnRevision: HEX("a"), events: [{ role: "user", text: turnText }] },
      {
        turnIndex: 4,
        turnRevision: HEX("b"),
        events: [
          { role: "tool_result", text: "ok", payloadSha256: HEX("e") },
          { role: "assistant", text: "committed the fix" },
        ],
      },
    ],
    budgetBytes: 4096,
  });
  const evidence = buildEvidenceCatalog({
    deliveryEdges: [{
      kind: "commit",
      relation: "turn-observed-commit",
      strength: "direct",
      limitations: ["not-authorship"],
      revision: HEX("1"),
      pointer: { commitHash: HEX40("c") },
    }],
    chunk,
  });
  return buildExtractionTask({
    taskId,
    lease,
    databaseUuid: "db-uuid-1",
    owner: { repositoryKey: HEX("7"), worktreeKey: HEX("8") },
    session: {
      project: "threadshare",
      repositoryKey: HEX("7"),
      timeWindow: { start: "2026-08-19T00:00:00Z", end: "2026-08-20T00:00:00Z" },
    },
    chunk,
    evidenceCatalog: evidence.catalog,
    selection: {
      requestDigest,
      resultSetDigest: HEX("3"),
      sourceBindingDigest: HEX("4"),
    },
    deliveryEdgeRevisions: evidence.deliveryEdgeRevisions,
    snapshotSeq,
    evaluatedAt,
  });
}

test("buildExtractionTask emits a schema-valid task with canonical stdin bytes", () => {
  const { task, stdinBytes } = extractionFixture();
  assert.equal(task.format, MEMORY_EXTRACTION_TASK_FORMAT);
  parseMemoryContract(task);
  assert.equal(stdinBytes, canonicalJson(task));
  assert.equal(task.binding.promptVersion, PROMPT_VERSION);
  assert.equal(task.binding.chunkerVersion, CHUNKER_VERSION);
  assert.deepEqual(task.binding.turnRevisions, [HEX("a"), HEX("b")]);
  assert.deepEqual(task.binding.payloadDigests, [HEX("e")]);
  assert.deepEqual(task.binding.deliveryEdgeRevisions, [HEX("1")]);
  assert.equal(task.binding.selection.requestDigest, HEX("2"));
  assert.ok(task.chunk.transcript.startsWith(TRANSCRIPT_PREAMBLE));
  // Same inputs -> byte-identical stdin.
  assert.equal(extractionFixture().stdinBytes, stdinBytes);
});

test("extraction task package never leaks internalIndex strength data", () => {
  const { task, stdinBytes } = extractionFixture();
  for (const forbidden of ['"strength"', '"relation"', '"limitations"', '"relations"']) {
    assert.ok(!stdinBytes.includes(forbidden), `task stdin leaked ${forbidden}`);
  }
  for (const entry of task.evidenceCatalog) {
    assert.deepEqual(Object.keys(entry).sort(), ["display", "evidenceId", "kind", "pointerDigest"]);
  }
});

test("sourceInputDigest reacts to transcript bytes and ignores unrelated fields", () => {
  const base = extractionFixture();
  const changedTranscript = extractionFixture({ turnText: "fix the bug!" });
  assert.notEqual(
    base.task.binding.sourceInputDigest,
    changedTranscript.task.binding.sourceInputDigest);
  assert.notEqual(
    base.task.binding.sourceInputDigest,
    extractionFixture({ requestDigest: HEX("f") }).task.binding.sourceInputDigest,
  );

  const unrelated = extractionFixture({
    taskId: "task-extract-2",
    lease: { holder: "someone-else", expiresAt: 99999 },
    snapshotSeq: "4242",
    evaluatedAt: "2026-08-21T12:34:56.000Z",
  });
  assert.equal(base.task.binding.sourceInputDigest, unrelated.task.binding.sourceInputDigest);
});

test("computeSourceInputDigest is exported and matches the assembled binding", () => {
  const { task } = extractionFixture();
  const recomputed = computeSourceInputDigest({
    chunk: task.chunk,
    evidenceCatalog: task.evidenceCatalog,
    session: task.session,
    context: task.context,
    turnRevisions: task.binding.turnRevisions,
    payloadDigests: task.binding.payloadDigests,
    deliveryEdgeRevisions: task.binding.deliveryEdgeRevisions,
    selection: task.binding.selection,
    promptVersion: task.binding.promptVersion,
    schemaVersion: task.binding.schemaVersion,
    chunkerVersion: task.binding.chunkerVersion,
  });
  assert.equal(recomputed, task.binding.sourceInputDigest);
});

// ---------------------------------------------------------------------------
// AdjudicationTask assembly
// ---------------------------------------------------------------------------

function adjudicationFixture({ poolRevision = 2 } = {}) {
  const drafts = [{
    candidateId: "cand-1",
    content: "Use the staging mobile-e2e suite before auth changes.",
    type: "work_method",
    priority: 70,
    confidence: "high",
    scene: null,
    statements: [{ statementId: "s1", text: "verified on staging", evidenceIds: [] }],
  }];
  const recall = {
    approvedProjection: { generation: 3, analyzerVersion: "approved-analyzer@1" },
    candidateProjection: { generation: 5, analyzerVersion: "candidate-analyzer@1" },
    recallAlgorithmVersion: "recall-rrf@1",
    recallSets: [{
      draftRef: "cand-1",
      ordered: [{ rank: 1, sourceKind: "approved", id: "entry-a" }],
    }],
    pool: [{
      sourceKind: "approved",
      id: "entry-a",
      revision: poolRevision,
      contentDigest: HEX("9"),
      state: "approved",
      summary: "auth module caution",
    }],
  };
  return buildAdjudicationTask({
    taskId: "task-adjudicate-1",
    lease: { holder: "cli", expiresAt: 2000 },
    databaseUuid: "db-uuid-1",
    memoryStateUuid: "memory-state-uuid-1",
    owner: { repositoryKey: HEX("7"), worktreeKey: HEX("8") },
    drafts,
    recall,
  });
}

test("buildAdjudicationTask emits a schema-valid task bound to the recall result set", () => {
  const { task, stdinBytes } = adjudicationFixture();
  assert.equal(task.format, MEMORY_ADJUDICATION_TASK_FORMAT);
  parseMemoryContract(task);
  assert.equal(stdinBytes, canonicalJson(task));
  assert.equal(task.binding.draftBatchDigest, computeDraftBatchDigest(task.drafts));
  assert.equal(task.binding.recallQueryDigest, computeRecallQueryDigest({
    recallAlgorithmVersion: "recall-rrf@1",
    queries: [{ draftRef: "cand-1", query: task.drafts[0].content }],
  }));
  assert.equal(task.binding.resultSetDigest, computeResultSetDigest({
    recallSets: task.recallSets,
    pool: task.pool,
  }));
  assert.deepEqual(task.binding.poolItemRevisions,
    [{ sourceKind: "approved", id: "entry-a", revision: 2 }]);
  assert.equal(task.contract.prompts.promptVersion, PROMPT_VERSION);
});

test("resultSetDigest shifts when pool item revision drifts; missing pool item throws", () => {
  const base = adjudicationFixture();
  const drifted = adjudicationFixture({ poolRevision: 3 });
  assert.notEqual(base.task.binding.resultSetDigest, drifted.task.binding.resultSetDigest);
  assert.throws(
    () => computeResultSetDigest({
      recallSets: [{ draftRef: "cand-1", ordered: [{ rank: 1, sourceKind: "candidate", id: "ghost" }] }],
      pool: [],
    }),
    (error) => error instanceof MemoryExtractionError && error.code === "recall-pool-mismatch");
});

// ---------------------------------------------------------------------------
// Injected sources (in-memory fakes)
// ---------------------------------------------------------------------------

function fakeSources() {
  const payloadSha = HEX("d");
  return {
    readTurns: async (sessionKey, range) => {
      assert.equal(sessionKey, "s-a");
      assert.equal(range, null);
      return [{
        turnIndex: 0,
        turnRevision: HEX("a"),
        events: [
          { role: "user", text: "inspect the payload" },
          { role: "tool_result", payloadRef: "payload-ref-1" },
          { role: "assistant", text: "summarized" },
        ],
      }];
    },
    readToolPayloadExcerpt: async (payloadRef) => {
      assert.equal(payloadRef, "payload-ref-1");
      return { head: "HEAD-BYTES", tail: "TAIL-BYTES", totalBytes: 5000, payloadSha256: payloadSha };
    },
    deliveryEdges: async (sessionKey) => {
      assert.equal(sessionKey, "s-a");
      return [{
        kind: "commit",
        relation: "session-observed-commit",
        strength: "direct",
        limitations: [],
        revision: HEX("2"),
        pointer: { commitHash: HEX40("f") },
      }];
    },
  };
}

test("planSessionChunks runs on injected in-memory fakes", async () => {
  const sources = fakeSources();
  const turns = await loadSessionTurns({ sources, sessionKey: "s-a" });
  const payloadEvent = turns[0].events[1];
  assert.equal(payloadEvent.truncated, true);
  assert.equal(payloadEvent.payloadSha256, HEX("d"));
  assert.ok(payloadEvent.text.startsWith("HEAD-BYTES\n"));
  assert.ok(payloadEvent.text.endsWith("\nTAIL-BYTES"));

  const planned = await planSessionChunks({ sources, sessionKey: "s-a", budgetBytes: 4096 });
  assert.equal(planned.length, 1);
  const { chunk, evidence } = planned[0];
  assert.deepEqual(chunk.coverage.find((entry) => entry.sourceKind === "tool-payload"), {
    sourceKind: "tool-payload",
    ref: `payload:${HEX("d")}`,
    completeness: "truncated",
    bytes: 5000,
  });
  assert.equal(evidence.catalog.filter((entry) => entry.kind === "commit").length, 1);
  assert.equal(evidence.catalog.filter((entry) => entry.kind === "turn").length, 1);
  assert.deepEqual(evidence.deliveryEdgeRevisions, [HEX("2")]);
});
