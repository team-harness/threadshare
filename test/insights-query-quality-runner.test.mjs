import assert from "node:assert/strict";
import { access, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  FORMAL_CANDIDATE_DISTRACTOR_TURNS,
  FORMAL_CANDIDATE_SEED,
  createProductionComponentAblationOutcomes,
  createQueryQualityDelta,
  evaluateCandidateRecallAtScale,
  runProductionCandidateRecallAtScale,
  runProductionQueryComponentAblations,
  runProductionQueryQualityEvaluation,
} from "../scripts/run-insights-query-quality.mjs";
import { loadQueryEvaluationFixture } from "../scripts/insights-query-evaluation.mjs";

const fixtureUrl = new URL("./fixtures/insights-query-evaluation.v2.json", import.meta.url);
const fixture = await loadQueryEvaluationFixture(fixtureUrl);
const engineName = process.platform === "win32"
  ? "threadshare-insights-engine.exe"
  : "threadshare-insights-engine";
const enginePath = fileURLToPath(new URL(
  `../crates/insights-engine/target/debug/${engineName}`,
  import.meta.url,
));

test("quality corpus maps every deidentified document to one deterministic Turn", () => {
  const first = createQueryQualityDelta(fixture);
  const second = createQueryQualityDelta(fixture);
  assert.deepEqual(first, second);
  assert.equal(first.delta.turns.length, fixture.acceptance.documents.length);
  assert.deepEqual(
    Object.keys(first.documentKeyById),
    fixture.acceptance.documents.map(({ documentId }) => documentId),
  );
  assert.equal(new Set(Object.values(first.documentKeyById)).size, fixture.acceptance.documents.length);
  assert.equal(first.delta.sourceRecords.length, 0);
  assert.equal(first.delta.evidenceEvents.length, 0);
});

test("component ablations rerank production scores with stable timestamp and key ties", () => {
  const result = (turnKey, observedTimestamp, score) => ({ turnKey, observedTimestamp, score });
  const outcomes = [{
    queryId: "q-development-en-01",
    searchTrace: { candidateTurnKeys: ["a", "b", "c"] },
    publicResults: [
      result("a", "2026-08-10T00:00:00.000Z", {
        rankComponentPpm: 900_000, idfCoveragePpm: 100_000, exact: false,
      }),
      result("b", "2026-08-10T00:00:01.000Z", {
        rankComponentPpm: 100_000, idfCoveragePpm: 900_000, exact: false,
      }),
      result("c", "2026-08-10T00:00:01.000Z", {
        rankComponentPpm: 100_000, idfCoveragePpm: 900_000, exact: false,
      }),
    ],
  }];
  assert.deepEqual(
    createProductionComponentAblationOutcomes(outcomes, "bm25-rank")[0]
      .publicResults.map(({ turnKey }) => turnKey),
    ["b", "c", "a"],
  );
  assert.deepEqual(
    createProductionComponentAblationOutcomes(outcomes, "idf-coverage")[0]
      .publicResults.map(({ turnKey }) => turnKey),
    ["a", "b", "c"],
  );
});

test("candidate-scale recall requires real Top-300 competition without judging distractors", () => {
  const documentKeyById = Object.fromEntries(fixture.acceptance.documents.map(({ documentId }) => [
    documentId,
    `gold-${documentId}`,
  ]));
  const outcomes = fixture.acceptance.queries.map((query) => {
    const targets = query.judgments
      .filter(({ relevance }) => relevance >= fixture.judgmentPolicy.recallMinRelevance)
      .map(({ documentId }) => documentKeyById[documentId]);
    const distractors = Array.from({ length: 300 - targets.length }, (_, index) =>
      `distractor-${query.queryId}-${index}`);
    return {
      queryId: query.queryId,
      searchTrace: { candidateTurnKeys: [...targets, ...distractors] },
      publicResults: [],
    };
  });
  const report = evaluateCandidateRecallAtScale({
    fixture,
    outcomes,
    documentKeyById,
    indexedTurnCount: 25_060,
  });
  assert.equal(report.candidateRecallAt300, 1);
  assert.equal(report.candidateLimitReachedQueryCount, 60);
  assert.equal(report.allGatesPassed, true);
  assert.match(report.qrelDigest, /^[0-9a-f]{64}$/u);

  const withoutCompetition = structuredClone(outcomes);
  for (const outcome of withoutCompetition) outcome.searchTrace.candidateTurnKeys.length = 2;
  const failed = evaluateCandidateRecallAtScale({
    fixture,
    outcomes: withoutCompetition,
    documentKeyById,
    indexedTurnCount: 25_060,
  });
  assert.equal(failed.gates.candidateLimitReached.passed, false);
  assert.equal(failed.allGatesPassed, false);

  for (const indexedTurnCount of [25_059, 25_061]) {
    const wrongScale = evaluateCandidateRecallAtScale({
      fixture,
      outcomes,
      documentKeyById,
      indexedTurnCount,
    });
    assert.equal(wrongScale.gates.indexedTurnCount.passed, false);
    assert.equal(wrongScale.allGatesPassed, false);
  }
  const wrongDistractorCount = evaluateCandidateRecallAtScale({
    fixture,
    outcomes,
    documentKeyById,
    indexedTurnCount: 25_060,
    distractorTurnCount: 24_999,
  });
  assert.equal(wrongDistractorCount.gates.distractorTurnCount.passed, false);
  assert.equal(wrongDistractorCount.allGatesPassed, false);
});

test("real Rust Engine produces the acceptance quality report without persisting raw state", {
  timeout: 120_000,
}, async (t) => {
  await access(enginePath);
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-query-quality-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await runProductionQueryQualityEvaluation({
    fixture,
    enginePath,
    workingDirectory: root,
  });
  assert.equal(report.dataset, "real-acceptance");
  assert.equal(report.provenance, "real-derived-deidentified");
  assert.equal(report.source, "current-conversation-user-prompts");
  assert.equal(report.queryCount, 60);
  assert.equal(report.execution.backend, "rust-sidecar");
  assert.equal(report.execution.candidateSource, "production-search-trace");
  assert.equal(report.execution.sourceDocumentCount, fixture.acceptance.documents.length);
  assert.equal(report.execution.indexedTurnCount, fixture.acceptance.documents.length);
  assert.equal(report.execution.expectedIndexedTurnCount, fixture.acceptance.documents.length);
  assert.match(report.execution.runnerScriptSha256, /^[0-9a-f]{64}$/u);
  assert.match(report.execution.engine.binarySha256, /^[0-9a-f]{64}$/u);
  assert.equal(report.execution.temporaryStatePersisted, false);
  assert.equal(
    Object.values(report.gates).every(({ passed }) => typeof passed === "boolean"),
    true,
  );
  assert.deepEqual(await readdir(root), []);
  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(fixture.acceptance.documents[0].problemText), false);
  assert.equal(serialized.includes(fixture.acceptance.queries[0].text), false);
  assert.equal(serialized.includes("quality.sqlite3"), false);
});

test("real Rust Engine produces development-set component ablations", {
  timeout: 120_000,
}, async (t) => {
  await access(enginePath);
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-query-ablation-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await runProductionQueryComponentAblations({
    fixture,
    enginePath,
    workingDirectory: root,
  });
  assert.equal(report.dataset, "review-development");
  assert.equal(report.provenance, "review-derived-deidentified-development");
  assert.equal(report.source, "pre-item5-independent-design-and-contract-review-findings");
  assert.equal(report.split, "development");
  assert.equal(report.queryCount, 30);
  assert.deepEqual(
    report.variants.map(({ name }) => name),
    ["without-bm25-rank", "without-exact-substring", "without-idf-coverage"],
  );
  assert.equal(report.execution.backend, "rust-sidecar");
  assert.equal(report.execution.ablationScope, "fixed-production-candidates-rerank-only");
  assert.equal(report.execution.candidateGenerationRerunPerVariant, false);
  assert.equal(report.execution.developmentSetKind, "review-derived-deidentified-disjoint");
  assert.match(report.execution.runnerScriptSha256, /^[0-9a-f]{64}$/u);
  assert.deepEqual(await readdir(root), []);
});

test("candidate runner reports actual indexed rows and submitted canonical delta digest", {
  timeout: 120_000,
}, async (t) => {
  await access(enginePath);
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-query-candidate-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const report = await runProductionCandidateRecallAtScale({
    fixture,
    candidateScaleTurnCount: 20,
    candidateScaleSeed: "candidate-small-e2e",
    enginePath,
    workingDirectory: root,
  });
  assert.equal(report.execution.candidateScale.turnCount, 20);
  assert.equal(report.execution.candidateScale.seed, "candidate-small-e2e");
  assert.match(report.execution.candidateScale.submittedDeltaDigest, /^[0-9a-f]{64}$/u);
  assert.equal(report.execution.indexedTurnCount, fixture.acceptance.documents.length + 20);
  assert.equal(report.execution.expectedIndexedTurnCount, fixture.acceptance.documents.length + 20);
  assert.equal(report.gates.indexedTurnCount.passed, false);
  assert.equal(report.gates.distractorTurnCount.passed, false);
  assert.equal(report.allGatesPassed, false);
  assert.deepEqual(await readdir(root), []);
});

test("formal candidate mode rejects scale and seed drift before starting the Engine", async () => {
  await assert.rejects(
    runProductionCandidateRecallAtScale({
      fixture,
      formal: true,
      candidateScaleTurnCount: FORMAL_CANDIDATE_DISTRACTOR_TURNS - 1,
    }),
    /exactly 25000 distractor Turns/u,
  );
  await assert.rejects(
    runProductionCandidateRecallAtScale({
      fixture,
      formal: true,
      candidateScaleSeed: `${FORMAL_CANDIDATE_SEED}-drift`,
    }),
    /requires seed/u,
  );
});
