import assert from "node:assert/strict";
import test from "node:test";

import {
  QUERY_ABLATION_REPORT_FORMAT,
  QUERY_QUALITY_REPORT_FORMAT,
  assertQueryEvaluationFixture,
  assessQualityGates,
  evaluateComponentAblations,
  evaluateQueryQuality,
  loadQueryEvaluationFixture,
} from "../scripts/insights-query-evaluation.mjs";

const fixtureUrl = new URL("./fixtures/insights-query-evaluation.v2.json", import.meta.url);
const fixture = await loadQueryEvaluationFixture(fixtureUrl);

function clone(value) {
  return structuredClone(value);
}

function dataset(name) {
  return name === "real-acceptance" ? fixture.acceptance : fixture;
}

function documentKeys(datasetName = "synthetic-unit") {
  return Object.fromEntries(dataset(datasetName).documents.map(({ documentId }) => [
    documentId,
    `runtime-key-${documentId}`,
  ]));
}

function rankedDocumentIds(query, documents, { reverseRelevant = false, omitRelevant = 0 } = {}) {
  const judgedIds = new Set(query.judgments.map(({ documentId }) => documentId));
  const relevant = query.judgments
    .filter(({ relevance }) => relevance >= fixture.judgmentPolicy.recallMinRelevance)
    .sort((left, right) => {
      if (reverseRelevant) return left.relevance - right.relevance;
      return right.relevance - left.relevance;
    })
    .slice(omitRelevant)
    .map(({ documentId }) => documentId);
  const contextual = query.judgments
    .filter(({ relevance }) => relevance > 0 && relevance < fixture.judgmentPolicy.recallMinRelevance)
    .sort((left, right) => right.relevance - left.relevance)
    .map(({ documentId }) => documentId);
  const judgedZero = query.judgments
    .filter(({ relevance }) => relevance === 0)
    .map(({ documentId }) => documentId);
  const remaining = documents
    .map(({ documentId }) => documentId)
    .filter((documentId) => !judgedIds.has(documentId));
  return [...relevant, ...contextual, ...judgedZero, ...remaining];
}

function outcomesFor(
  split,
  optionsByQuery = new Map(),
  { snakeTrace = false, datasetName = "synthetic-unit" } = {},
) {
  const selected = dataset(datasetName);
  const keys = documentKeys(datasetName);
  return selected.queries
    .filter((query) => query.split === split)
    .map((query, index) => {
      const ranked = rankedDocumentIds(query, selected.documents, optionsByQuery.get(query.queryId));
      const candidateKeys = ranked.map((documentId) => keys[documentId]);
      return {
        queryId: query.queryId,
        searchTrace: snakeTrace && index === 0
          ? { candidate_turn_keys: candidateKeys }
          : { candidateTurnKeys: candidateKeys },
        publicResults: candidateKeys.map((turnKey, resultIndex) => (
          resultIndex % 2 === 0 ? { turnKey } : { turn_key: turnKey }
        )),
      };
    });
}

test("frozen fixture keeps review-derived development data separate from real acceptance queries", () => {
  assert.equal(assertQueryEvaluationFixture(fixture), fixture);
  assert.equal(fixture.version, 2);
  assert.deepEqual(fixture.judgmentPolicy, {
    version: "threadshare-query-judgments@v2",
    recallMinRelevance: 2,
    unjudgedResults: "reject",
  });
  assert.equal(fixture.documents.length, 30);
  assert.deepEqual(
    Object.fromEntries(["development", "evaluation"].map((split) => [
      split,
      fixture.queries.filter((query) => query.split === split).length,
    ])),
    { development: 30, evaluation: 60 },
  );
  assert.deepEqual(
    Object.fromEntries(["en", "mixed-code", "zh"].map((language) => [
      language,
      fixture.queries.filter((query) => query.split === "evaluation" && query.language === language).length,
    ])),
    { en: 20, "mixed-code": 20, zh: 20 },
  );
  assert.deepEqual(
    [...new Set(fixture.queries.flatMap((query) => query.judgments.map(({ relevance }) => relevance)))].sort(),
    [0, 1, 2, 3],
  );
  assert.equal(JSON.stringify(fixture).includes("/Users/"), false);
  assert.equal(JSON.stringify(fixture).includes(".codex/sessions"), false);
  assert.equal(fixture.provenance, "review-derived-deidentified-development");
  assert.equal(
    fixture.developmentSource,
    "pre-item5-independent-design-and-contract-review-findings",
  );
  assert.equal(fixture.acceptance.provenance, "real-derived-deidentified");
  assert.equal(fixture.acceptance.source, "current-conversation-user-prompts");
  assert.equal(fixture.acceptance.sourceIntentCount, 60);
  assert.equal(fixture.acceptance.documents.length, 60);
  assert.equal(fixture.acceptance.queries.length, 60);
  assert.equal(new Set(fixture.acceptance.queries.map(({ sourceRef }) => sourceRef)).size, 60);
  assert.deepEqual(
    Object.fromEntries(["en", "mixed-code", "zh"].map((language) => [
      language,
      fixture.acceptance.queries.filter((query) => query.language === language).length,
    ])),
    { en: 20, "mixed-code": 20, zh: 20 },
  );
  assert.deepEqual(
    Object.fromEntries(["en", "mixed-code", "zh"].map((language) => [
      language,
      fixture.acceptance.documents.filter((document) => document.language === language).length,
    ])),
    { en: 20, "mixed-code": 20, zh: 20 },
  );
  assert.deepEqual(
    [...new Set(fixture.acceptance.queries.flatMap(
      (query) => query.judgments.map(({ relevance }) => relevance),
    ))].sort(),
    [0, 1, 2, 3],
  );
  const acceptanceDocuments = new Map(fixture.acceptance.documents.map((document) => [
    document.documentId,
    document,
  ]));
  for (const query of fixture.acceptance.queries) {
    const recallTargets = query.judgments.filter(({ relevance }) => relevance >= 2);
    assert.equal(recallTargets.length >= 1, true, `${query.queryId} must retain a recall target`);
    assert.equal(query.judgments.length, fixture.acceptance.documents.length);
    assert.equal(
      query.judgments
        .filter(({ relevance }) => relevance > 0)
        .every(({ documentId }) => acceptanceDocuments.get(documentId).language === query.language),
      true,
      `${query.queryId} must only mark same-language documents relevant`,
    );
    const primary = acceptanceDocuments.get(query.judgments.find(({ relevance }) => relevance === 3).documentId);
    assert.notEqual(query.text.toLocaleLowerCase("en"), primary.problemText.toLocaleLowerCase("en"));
  }
});

test("real acceptance provenance and deidentification constraints fail closed", () => {
  const syntheticClaim = clone(fixture);
  syntheticClaim.acceptance.provenance = "synthetic-deidentified";
  assert.throws(
    () => assertQueryEvaluationFixture(syntheticClaim),
    /real-derived-deidentified/u,
  );

  for (const leakedText of [
    "open https://private.invalid/?id=secret",
    "read /Users/example/.codex/sessions/private.jsonl",
    "resume 11111111-2222-4333-8444-555555555555",
  ]) {
    const leakedFixture = clone(fixture);
    leakedFixture.acceptance.queries[0].text = leakedText;
    assert.throws(
      () => assertQueryEvaluationFixture(leakedFixture),
      /forbidden real-session identifier or path shape/u,
    );
  }

  const repeatedSource = clone(fixture);
  repeatedSource.acceptance.queries[1].sourceRef = repeatedSource.acceptance.queries[0].sourceRef;
  assert.throws(
    () => assertQueryEvaluationFixture(repeatedSource),
    /same atomic intent|reuses sourceRef/u,
  );

  const undersized = clone(fixture);
  undersized.acceptance.queries.pop();
  assert.throws(
    () => assertQueryEvaluationFixture(undersized),
    /at least 60 queries/u,
  );

  const noRelevantLabel = clone(fixture);
  for (const judgment of noRelevantLabel.acceptance.queries[0].judgments) judgment.relevance = 0;
  assert.throws(
    () => assertQueryEvaluationFixture(noRelevantLabel),
    /at least one relevance 3 document/u,
  );

  const crossLanguage = clone(fixture);
  crossLanguage.acceptance.queries[0].judgments
    .find(({ documentId }) => documentId === "real-doc-en-01").relevance = 1;
  assert.throws(
    () => assertQueryEvaluationFixture(crossLanguage),
    /only mark same-language documents relevant/u,
  );
});

test("acceptance reports default to the real-derived gold set", () => {
  const report = evaluateQueryQuality({
    fixture,
    outcomes: outcomesFor("evaluation", new Map(), { datasetName: "real-acceptance" }),
    documentKeyById: documentKeys("real-acceptance"),
  });
  assert.equal(report.format, QUERY_QUALITY_REPORT_FORMAT);
  assert.equal(report.dataset, "real-acceptance");
  assert.equal(report.provenance, "real-derived-deidentified");
  assert.equal(report.source, "current-conversation-user-prompts");
  assert.equal(report.queryCount, 60);
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.byLanguage).map(([language, value]) => [language, value.queryCount])),
    { en: 20, "mixed-code": 20, zh: 20 },
  );
});

test("fixture validation rejects duplicate, unknown, empty-relevance, and loose-schema data", () => {
  const duplicateDocument = clone(fixture);
  duplicateDocument.documents.push(clone(duplicateDocument.documents[0]));
  assert.throws(
    () => assertQueryEvaluationFixture(duplicateDocument),
    /duplicate doc-en-01/u,
  );

  const unknownDocument = clone(fixture);
  unknownDocument.queries[0].judgments[0].documentId = "doc-en-99";
  assert.throws(
    () => assertQueryEvaluationFixture(unknownDocument),
    /unknown document/u,
  );

  const emptyRelevantSet = clone(fixture);
  for (const judgment of emptyRelevantSet.queries[0].judgments) judgment.relevance = 0;
  assert.throws(
    () => assertQueryEvaluationFixture(emptyRelevantSet),
    /at least one relevance 3 document/u,
  );

  const incompleteJudgments = clone(fixture);
  incompleteJudgments.queries[0].judgments.pop();
  assert.throws(
    () => assertQueryEvaluationFixture(incompleteJudgments),
    /exhaustively label all/u,
  );

  const looseSchema = clone(fixture);
  looseSchema.documents[0].sourcePath = "synthetic";
  assert.throws(
    () => assertQueryEvaluationFixture(looseSchema),
    /must contain exactly/u,
  );

  const loosenedThreshold = clone(fixture);
  loosenedThreshold.thresholds.ndcgAt10 = 0.70;
  assert.throws(
    () => assertQueryEvaluationFixture(loosenedThreshold),
    /frozen acceptance threshold/u,
  );
});

test("quality metrics consume production-shaped trace keys and public results", () => {
  const report = evaluateQueryQuality({
    fixture,
    dataset: "synthetic-unit",
    split: "evaluation",
    outcomes: outcomesFor("evaluation", new Map(), { snakeTrace: true }),
    documentKeyById: documentKeys(),
  });
  assert.equal(report.format, QUERY_QUALITY_REPORT_FORMAT);
  assert.equal(report.dataset, "synthetic-unit");
  assert.equal(report.provenance, "review-derived-deidentified-development");
  assert.equal(report.source, "pre-item5-independent-design-and-contract-review-findings");
  assert.equal(report.queryCount, 60);
  assert.deepEqual(report.metrics, {
    candidateRecallAt300: 1,
    top20Recall: 1,
    ndcgAt10: 1,
    grade3HitAt20: 1,
    grade1ContextualCoverageAt20: 1,
  });
  assert.match(report.qrelDigest, /^[0-9a-f]{64}$/u);
  assert.deepEqual(report.judgmentPolicy, fixture.judgmentPolicy);
  assert.deepEqual(
    Object.fromEntries(Object.entries(report.byLanguage).map(([language, value]) => [language, value.queryCount])),
    { en: 20, "mixed-code": 20, zh: 20 },
  );
  assert.equal(Object.values(report.gates).every(({ passed }) => passed), true);
});

test("metrics are query-level macros and use graded NDCG", () => {
  const first = fixture.queries.find((query) => query.split === "evaluation");
  const report = evaluateQueryQuality({
    fixture,
    dataset: "synthetic-unit",
    split: "evaluation",
    outcomes: outcomesFor("evaluation", new Map([[
      first.queryId,
      { reverseRelevant: true, omitRelevant: 1 },
    ]])),
    documentKeyById: documentKeys(),
  });
  assert.equal(report.metrics.candidateRecallAt300, 59.5 / 60);
  assert.equal(report.metrics.top20Recall, 59.5 / 60);
  assert.equal(report.metrics.ndcgAt10 < 1, true);
  const firstMetrics = report.queries.find(({ queryId }) => queryId === first.queryId).metrics;
  assert.equal(firstMetrics.recallTargetDocumentCount, 2);
  assert.equal(firstMetrics.grade3HitAt20, 1);
  assert.equal(firstMetrics.grade1ContextualCoverageAt20, null);
  assert.equal(firstMetrics.ndcgAt10, 7 / (7 + (3 / Math.log2(3))));
});

test("gate assessment treats equality as pass and any lower value as fail", () => {
  const thresholds = {
    candidateRecallAt300: 0.9,
    top20Recall: 0.85,
    ndcgAt10: 0.75,
  };
  assert.deepEqual(assessQualityGates(thresholds, thresholds), {
    candidateRecallAt300: { actual: 0.9, threshold: 0.9, passed: true },
    top20Recall: { actual: 0.85, threshold: 0.85, passed: true },
    ndcgAt10: { actual: 0.75, threshold: 0.75, passed: true },
  });
  const below = assessQualityGates({
    candidateRecallAt300: 0.9 - 1e-12,
    top20Recall: 0.85 - 1e-12,
    ndcgAt10: 0.75 - 1e-12,
  }, thresholds);
  assert.equal(Object.values(below).every(({ passed }) => !passed), true);
});

test("evaluation rejects duplicate and unknown runtime documents", () => {
  const duplicate = outcomesFor("evaluation");
  duplicate[0].publicResults[1] = duplicate[0].publicResults[0];
  assert.throws(
    () => evaluateQueryQuality({
      fixture,
      dataset: "synthetic-unit",
      outcomes: duplicate,
      documentKeyById: documentKeys(),
    }),
    /duplicate document key/u,
  );

  const unknown = outcomesFor("evaluation");
  unknown[0].searchTrace.candidateTurnKeys[0] = "runtime-key-unknown";
  unknown[0].publicResults[0].turnKey = "runtime-key-unknown";
  assert.throws(
    () => evaluateQueryQuality({
      fixture,
      dataset: "synthetic-unit",
      outcomes: unknown,
      documentKeyById: documentKeys(),
    }),
    /unknown document key/u,
  );

  const outsideCandidates = outcomesFor("evaluation");
  outsideCandidates[0].searchTrace.candidateTurnKeys.pop();
  assert.throws(
    () => evaluateQueryQuality({
      fixture,
      dataset: "synthetic-unit",
      outcomes: outsideCandidates,
      documentKeyById: documentKeys(),
    }),
    /subset of candidates/u,
  );
});

test("report ordering is deterministic regardless of outcome order", () => {
  const outcomes = outcomesFor("evaluation");
  const forward = evaluateQueryQuality({
    fixture,
    dataset: "synthetic-unit",
    outcomes,
    documentKeyById: documentKeys(),
  });
  const reverse = evaluateQueryQuality({
    fixture,
    dataset: "synthetic-unit",
    outcomes: [...outcomes].reverse(),
    documentKeyById: documentKeys(),
  });
  assert.equal(JSON.stringify(forward), JSON.stringify(reverse));
  assert.deepEqual(
    forward.queries.map(({ queryId }) => queryId),
    [...forward.queries.map(({ queryId }) => queryId)].sort(),
  );
});

test("component ablation report has deterministic variants and explicit deltas", () => {
  const perfect = outcomesFor("development");
  const first = fixture.queries.find((query) => query.split === "development");
  const degraded = outcomesFor("development", new Map([[
    first.queryId,
    { reverseRelevant: true, omitRelevant: 1 },
  ]]));
  const report = evaluateComponentAblations({
    fixture,
    split: "development",
    documentKeyById: documentKeys(),
    baseline: { name: "production", outcomes: perfect },
    variants: [
      { name: "without-rerank", removedComponents: ["rerank"], outcomes: degraded },
      { name: "without-exact", removedComponents: ["exact"], outcomes: perfect },
    ],
  });
  assert.equal(report.format, QUERY_ABLATION_REPORT_FORMAT);
  assert.equal(report.dataset, "review-development");
  assert.equal(report.provenance, "review-derived-deidentified-development");
  assert.equal(report.source, "pre-item5-independent-design-and-contract-review-findings");
  assert.equal(report.queryCount, 30);
  assert.deepEqual(report.baseline.metrics, {
    candidateRecallAt300: 1,
    top20Recall: 1,
    ndcgAt10: 1,
    grade3HitAt20: 1,
    grade1ContextualCoverageAt20: 1,
  });
  assert.deepEqual(report.variants.map(({ name }) => name), ["without-exact", "without-rerank"]);
  assert.deepEqual(Object.keys(report.variants[0].deltaFromBaseline), [
    "candidateRecallAt300",
    "top20Recall",
    "ndcgAt10",
    "grade3HitAt20",
    "grade1ContextualCoverageAt20",
  ]);
  assert.equal(report.variants[0].deltaFromBaseline.ndcgAt10, 0);
  assert.equal(report.variants[1].deltaFromBaseline.ndcgAt10 < 0, true);
});
