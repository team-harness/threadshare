#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { pathToFileURL } from "node:url";

export const QUERY_EVALUATION_FORMAT = "threadshare-insights-query-evaluation@v2";
export const QUERY_QUALITY_REPORT_FORMAT = "threadshare-insights-query-quality-report@v1";
export const QUERY_ABLATION_REPORT_FORMAT = "threadshare-insights-query-ablation-report@v1";
export const QUERY_LANGUAGES = Object.freeze(["en", "mixed-code", "zh"]);
export const QUERY_SPLITS = Object.freeze(["development", "evaluation"]);
export const QUERY_DATASETS = Object.freeze([
  "review-development",
  "real-acceptance",
  "synthetic-unit",
]);
export const CANONICAL_QUERY_THRESHOLDS = Object.freeze({
  candidateRecallAt300: 0.90,
  top20Recall: 0.85,
  ndcgAt10: 0.75,
});

const REQUIRED_COUNTS = Object.freeze({ development: 30, evaluation: 60 });
const REQUIRED_EVALUATION_LANGUAGE_COUNT = 20;
const MAX_TEXT_BYTES = 16 * 1024;
const JUDGMENT_POLICY_VERSION = "threadshare-query-judgments@v2";
const PRIVATE_TEXT_PATTERNS = Object.freeze([
  /\b[0-9a-f]{64}\b/iu,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
  /(?:file:\/\/|\/Users\/|\/home\/|[A-Za-z]:\\|~\/\.(?:codex|claude)\/)/u,
  /(?:\.codex\/sessions|\.claude\/projects)/u,
  /https?:\/\//iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
]);

function fail(message) {
  throw new TypeError(message);
}

function plainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function exactKeys(value, expected, name) {
  const actual = Object.keys(plainObject(value, name)).sort();
  const wanted = [...expected].sort();
  if (actual.length !== wanted.length || actual.some((key, index) => key !== wanted[index])) {
    fail(`${name} must contain exactly: ${wanted.join(", ")}`);
  }
}

function nonEmptyString(value, name, { maxBytes = MAX_TEXT_BYTES } = {}) {
  if (typeof value !== "string" || value.trim() === "") fail(`${name} must be a non-empty string`);
  if (Buffer.byteLength(value, "utf8") > maxBytes) fail(`${name} exceeds ${maxBytes} UTF-8 bytes`);
  return value;
}

function finiteUnitInterval(value, name) {
  if (typeof value !== "number" || !Number.isFinite(value) || value < 0 || value > 1) {
    fail(`${name} must be a finite number in [0, 1]`);
  }
  return value;
}

function assertDeidentifiedText(value, name) {
  nonEmptyString(value, name);
  for (const pattern of PRIVATE_TEXT_PATTERNS) {
    if (pattern.test(value)) fail(`${name} contains a forbidden real-session identifier or path shape`);
  }
}

function assertSortedUniqueStrings(values, name, { allowEmpty = true } = {}) {
  if (!Array.isArray(values) || (!allowEmpty && values.length === 0)) {
    fail(`${name} must be ${allowEmpty ? "an" : "a non-empty"} array`);
  }
  let previous = null;
  for (let index = 0; index < values.length; index += 1) {
    const value = nonEmptyString(values[index], `${name}[${index}]`, { maxBytes: 256 });
    if (previous !== null && previous.localeCompare(value, "en") >= 0) {
      fail(`${name} must be strictly sorted and unique`);
    }
    previous = value;
  }
}

function assertLanguage(value, name) {
  if (!QUERY_LANGUAGES.includes(value)) fail(`${name} must be one of ${QUERY_LANGUAGES.join(", ")}`);
}

function assertDocument(document, index) {
  const name = `documents[${index}]`;
  exactKeys(document, [
    "documentId",
    "finalAnswerExcerpt",
    "language",
    "problemText",
    "tags",
  ], name);
  if (!/^doc-(?:en|mixed-code|zh)-[0-9]{2}$/u.test(document.documentId)) {
    fail(`${name}.documentId must use the synthetic document ID shape`);
  }
  assertLanguage(document.language, `${name}.language`);
  if (!document.documentId.startsWith(`doc-${document.language}-`)) {
    fail(`${name}.documentId must agree with its language`);
  }
  assertDeidentifiedText(document.problemText, `${name}.problemText`);
  assertDeidentifiedText(document.finalAnswerExcerpt, `${name}.finalAnswerExcerpt`);
  assertSortedUniqueStrings(document.tags, `${name}.tags`, { allowEmpty: false });
}

function assertJudgment(judgment, name, documentIds) {
  exactKeys(judgment, ["documentId", "relevance"], name);
  if (!documentIds.has(judgment.documentId)) fail(`${name}.documentId references an unknown document`);
  if (!Number.isInteger(judgment.relevance) || judgment.relevance < 0 || judgment.relevance > 3) {
    fail(`${name}.relevance must be an integer in [0, 3]`);
  }
}

function assertCompleteJudgments(query, name, documentIds, judgmentPolicy) {
  if (!Array.isArray(query.judgments) || query.judgments.length !== documentIds.size) {
    fail(`${name}.judgments must exhaustively label all ${documentIds.size} documents`);
  }
  const judged = new Set();
  let directAnswerCount = 0;
  let recallTargetCount = 0;
  for (let judgmentIndex = 0; judgmentIndex < query.judgments.length; judgmentIndex += 1) {
    const judgmentName = `${name}.judgments[${judgmentIndex}]`;
    const judgment = query.judgments[judgmentIndex];
    assertJudgment(judgment, judgmentName, documentIds);
    if (judged.has(judgment.documentId)) fail(`${name}.judgments contains a duplicate document`);
    judged.add(judgment.documentId);
    if (judgment.relevance === 3) directAnswerCount += 1;
    if (judgment.relevance >= judgmentPolicy.recallMinRelevance) recallTargetCount += 1;
  }
  if (directAnswerCount === 0) fail(`${name}.judgments must contain at least one relevance 3 document`);
  if (recallTargetCount === 0) {
    fail(`${name}.judgments must contain at least one recall target`);
  }
  const sorted = [...query.judgments].sort((left, right) => left.documentId.localeCompare(right.documentId, "en"));
  if (query.judgments.some((judgment, judgmentIndex) => judgment !== sorted[judgmentIndex])) {
    fail(`${name}.judgments must be sorted by documentId`);
  }
}

function assertJudgmentPolicy(value) {
  exactKeys(value, ["recallMinRelevance", "unjudgedResults", "version"], "fixture.judgmentPolicy");
  if (value.version !== JUDGMENT_POLICY_VERSION) {
    fail(`fixture.judgmentPolicy.version must be ${JUDGMENT_POLICY_VERSION}`);
  }
  if (value.recallMinRelevance !== 2) fail("fixture.judgmentPolicy.recallMinRelevance must be 2");
  if (value.unjudgedResults !== "reject") fail("fixture.judgmentPolicy.unjudgedResults must be reject");
}

function assertQuery(query, index, documentIds, judgmentPolicy) {
  const name = `queries[${index}]`;
  exactKeys(query, ["judgments", "language", "queryId", "split", "text"], name);
  if (!/^q-(?:development|evaluation)-(?:en|mixed-code|zh)-[0-9]{2}[a-z]?$/u.test(query.queryId)) {
    fail(`${name}.queryId must use the synthetic query ID shape`);
  }
  if (!QUERY_SPLITS.includes(query.split)) fail(`${name}.split is invalid`);
  assertLanguage(query.language, `${name}.language`);
  if (!query.queryId.startsWith(`q-${query.split}-${query.language}-`)) {
    fail(`${name}.queryId must agree with split and language`);
  }
  assertDeidentifiedText(query.text, `${name}.text`);
  assertCompleteJudgments(query, name, documentIds, judgmentPolicy);
}

export function assertQueryEvaluationFixture(value) {
  exactKeys(value, [
    "acceptance",
    "documents",
    "developmentSource",
    "format",
    "judgmentPolicy",
    "provenance",
    "queries",
    "thresholds",
    "version",
  ], "fixture");
  if (value.format !== QUERY_EVALUATION_FORMAT) fail(`fixture.format must be ${QUERY_EVALUATION_FORMAT}`);
  if (value.version !== 2) fail("fixture.version must be 2");
  assertJudgmentPolicy(value.judgmentPolicy);
  if (value.provenance !== "review-derived-deidentified-development") {
    fail("fixture.provenance must be review-derived-deidentified-development");
  }
  if (value.developmentSource !== "pre-item5-independent-design-and-contract-review-findings") {
    fail("fixture.developmentSource must identify the frozen pre-ITEM-5 review findings");
  }
  exactKeys(value.thresholds, ["candidateRecallAt300", "ndcgAt10", "top20Recall"], "fixture.thresholds");
  for (const metric of ["candidateRecallAt300", "top20Recall", "ndcgAt10"]) {
    finiteUnitInterval(value.thresholds[metric], `fixture.thresholds.${metric}`);
    if (value.thresholds[metric] !== CANONICAL_QUERY_THRESHOLDS[metric]) {
      fail(`fixture.thresholds.${metric} must equal the frozen acceptance threshold`);
    }
  }
  if (!Array.isArray(value.documents) || value.documents.length === 0) fail("fixture.documents must be non-empty");
  const documentIds = new Set();
  for (let index = 0; index < value.documents.length; index += 1) {
    assertDocument(value.documents[index], index);
    const { documentId } = value.documents[index];
    if (documentIds.has(documentId)) fail(`fixture.documents contains duplicate ${documentId}`);
    documentIds.add(documentId);
  }
  if (!Array.isArray(value.queries)) fail("fixture.queries must be an array");
  const queryIds = new Set();
  const splitCounts = { development: 0, evaluation: 0 };
  const evaluationLanguages = { en: 0, "mixed-code": 0, zh: 0 };
  for (let index = 0; index < value.queries.length; index += 1) {
    const query = value.queries[index];
    assertQuery(query, index, documentIds, value.judgmentPolicy);
    if (queryIds.has(query.queryId)) fail(`fixture.queries contains duplicate ${query.queryId}`);
    queryIds.add(query.queryId);
    splitCounts[query.split] += 1;
    if (query.split === "evaluation") evaluationLanguages[query.language] += 1;
  }
  for (const split of QUERY_SPLITS) {
    if (splitCounts[split] < REQUIRED_COUNTS[split]) {
      fail(`fixture requires at least ${REQUIRED_COUNTS[split]} ${split} queries`);
    }
  }
  for (const language of QUERY_LANGUAGES) {
    if (evaluationLanguages[language] < REQUIRED_EVALUATION_LANGUAGE_COUNT) {
      fail(`fixture requires at least ${REQUIRED_EVALUATION_LANGUAGE_COUNT} evaluation queries for ${language}`);
    }
  }
  assertRealAcceptanceDataset(value.acceptance, value.judgmentPolicy);
  return value;
}

function assertRealAcceptanceDocument(document, index) {
  const name = `fixture.acceptance.documents[${index}]`;
  exactKeys(document, ["documentId", "finalAnswerExcerpt", "language", "problemText", "tags"], name);
  if (!/^real-doc-(?:en|mixed-code|zh)-[0-9]{2}$/u.test(document.documentId)) {
    fail(`${name}.documentId must use the real-derived document ID shape`);
  }
  assertLanguage(document.language, `${name}.language`);
  if (!document.documentId.startsWith(`real-doc-${document.language}-`)) {
    fail(`${name}.documentId must agree with its language`);
  }
  assertDeidentifiedText(document.problemText, `${name}.problemText`);
  assertDeidentifiedText(document.finalAnswerExcerpt, `${name}.finalAnswerExcerpt`);
  assertSortedUniqueStrings(document.tags, `${name}.tags`, { allowEmpty: false });
}

function assertRealAcceptanceQuery(query, index, documentLanguages, judgmentPolicy) {
  const name = `fixture.acceptance.queries[${index}]`;
  exactKeys(query, [
    "judgments",
    "language",
    "queryId",
    "sourceRef",
    "split",
    "text",
    "transformation",
  ], name);
  if (!/^real-q-[0-9]{3}$/u.test(query.queryId)) fail(`${name}.queryId is invalid`);
  if (!/^conversation-intent-[0-9]{3}$/u.test(query.sourceRef)) fail(`${name}.sourceRef is invalid`);
  if (query.queryId.slice(-3) !== query.sourceRef.slice(-3)) {
    fail(`${name}.queryId and sourceRef must identify the same atomic intent`);
  }
  if (query.split !== "evaluation") fail(`${name}.split must be evaluation`);
  assertLanguage(query.language, `${name}.language`);
  if (![
    "deidentified-language-preserving-paraphrase",
    "deidentified-translated-paraphrase",
  ].includes(query.transformation)) {
    fail(`${name}.transformation is invalid`);
  }
  assertDeidentifiedText(query.text, `${name}.text`);
  assertCompleteJudgments(query, name, new Set(documentLanguages.keys()), judgmentPolicy);
  for (const judgment of query.judgments) {
    if (judgment.relevance > 0 && documentLanguages.get(judgment.documentId) !== query.language) {
      fail(`${name}.judgments may only mark same-language documents relevant`);
    }
  }
}

function assertRealAcceptanceDataset(dataset, judgmentPolicy) {
  exactKeys(dataset, [
    "documents",
    "provenance",
    "queries",
    "source",
    "sourceIntentCount",
    "transformations",
  ], "fixture.acceptance");
  if (dataset.provenance !== "real-derived-deidentified") {
    fail("fixture.acceptance.provenance must be real-derived-deidentified");
  }
  if (dataset.source !== "current-conversation-user-prompts") {
    fail("fixture.acceptance.source must identify current-conversation user prompts");
  }
  if (!Number.isSafeInteger(dataset.sourceIntentCount) || dataset.sourceIntentCount < 60) {
    fail("fixture.acceptance.sourceIntentCount must be at least 60");
  }
  assertSortedUniqueStrings(dataset.transformations, "fixture.acceptance.transformations", { allowEmpty: false });
  const requiredTransformations = [
    "atomic-clause-extraction",
    "deidentified-language-preserving-paraphrase",
    "deidentified-translated-paraphrase",
  ];
  if (JSON.stringify(dataset.transformations) !== JSON.stringify(requiredTransformations)) {
    fail("fixture.acceptance.transformations must declare the frozen deidentification pipeline");
  }
  if (!Array.isArray(dataset.documents) || dataset.documents.length < 60) {
    fail("fixture.acceptance.documents must contain at least 60 documents");
  }
  const documentLanguages = new Map();
  const languageDocuments = { en: 0, "mixed-code": 0, zh: 0 };
  for (let index = 0; index < dataset.documents.length; index += 1) {
    assertRealAcceptanceDocument(dataset.documents[index], index);
    const { documentId, language } = dataset.documents[index];
    if (documentLanguages.has(documentId)) fail(`fixture.acceptance.documents contains duplicate ${documentId}`);
    documentLanguages.set(documentId, language);
    languageDocuments[language] += 1;
  }
  if (!Array.isArray(dataset.queries) || dataset.queries.length < 60) {
    fail("fixture.acceptance.queries must contain at least 60 queries");
  }
  const queryIds = new Set();
  const sourceRefs = new Set();
  const languages = { en: 0, "mixed-code": 0, zh: 0 };
  for (let index = 0; index < dataset.queries.length; index += 1) {
    const query = dataset.queries[index];
    assertRealAcceptanceQuery(query, index, documentLanguages, judgmentPolicy);
    if (queryIds.has(query.queryId)) fail(`fixture.acceptance.queries contains duplicate ${query.queryId}`);
    if (sourceRefs.has(query.sourceRef)) fail(`fixture.acceptance.queries reuses sourceRef ${query.sourceRef}`);
    queryIds.add(query.queryId);
    sourceRefs.add(query.sourceRef);
    languages[query.language] += 1;
  }
  if (sourceRefs.size !== dataset.sourceIntentCount) {
    fail("fixture.acceptance.sourceIntentCount must equal the unique atomic source references");
  }
  for (const language of QUERY_LANGUAGES) {
    if (languageDocuments[language] < REQUIRED_EVALUATION_LANGUAGE_COUNT) {
      fail(`fixture.acceptance requires at least ${REQUIRED_EVALUATION_LANGUAGE_COUNT} documents for ${language}`);
    }
    if (languages[language] < REQUIRED_EVALUATION_LANGUAGE_COUNT) {
      fail(`fixture.acceptance requires at least ${REQUIRED_EVALUATION_LANGUAGE_COUNT} queries for ${language}`);
    }
  }
}

export async function loadQueryEvaluationFixture(file) {
  const value = JSON.parse(await readFile(file, "utf8"));
  return assertQueryEvaluationFixture(value);
}

function queryDataset(fixture, dataset) {
  if (!QUERY_DATASETS.includes(dataset)) fail("dataset is invalid");
  if (dataset === "real-acceptance") {
    return {
      documents: fixture.acceptance.documents,
      queries: fixture.acceptance.queries,
      provenance: fixture.acceptance.provenance,
      source: fixture.acceptance.source,
    };
  }
  return {
    documents: fixture.documents,
    queries: fixture.queries,
    provenance: fixture.provenance,
    source: fixture.developmentSource,
  };
}

export function queryJudgmentDigest({ fixture, dataset = "real-acceptance", split = "evaluation" }) {
  assertQueryEvaluationFixture(fixture);
  if (!QUERY_SPLITS.includes(split)) fail("split is invalid");
  const selected = queryDataset(fixture, dataset);
  return qrelDigest(
    selected.queries.filter((query) => query.split === split),
    fixture.judgmentPolicy,
  );
}

function documentKeyMaps(dataset, documentKeyById) {
  const forward = new Map();
  if (documentKeyById === undefined) {
    for (const document of dataset.documents) forward.set(document.documentId, document.documentId);
  } else {
    const supplied = documentKeyById instanceof Map
      ? documentKeyById
      : new Map(Object.entries(plainObject(documentKeyById, "documentKeyById")));
    for (const document of dataset.documents) {
      if (!supplied.has(document.documentId)) fail(`documentKeyById is missing ${document.documentId}`);
      forward.set(document.documentId, nonEmptyString(
        supplied.get(document.documentId),
        `documentKeyById.${document.documentId}`,
        { maxBytes: 256 },
      ));
    }
    for (const documentId of supplied.keys()) {
      if (!forward.has(documentId)) fail(`documentKeyById contains unknown ${documentId}`);
    }
  }
  const reverse = new Map();
  for (const [documentId, documentKey] of forward) {
    if (reverse.has(documentKey)) fail("documentKeyById values must be unique");
    reverse.set(documentKey, documentId);
  }
  return { forward, reverse };
}

function normalizedCandidateKeys(searchTrace, name) {
  plainObject(searchTrace, name);
  const camel = searchTrace.candidateTurnKeys;
  const snake = searchTrace.candidate_turn_keys;
  if ((camel === undefined) === (snake === undefined)) {
    fail(`${name} must contain exactly one candidate key field`);
  }
  const keys = camel ?? snake;
  if (!Array.isArray(keys)) fail(`${name} candidate keys must be an array`);
  return keys;
}

function publicResultKey(result, name) {
  if (typeof result === "string") return nonEmptyString(result, name, { maxBytes: 256 });
  plainObject(result, name);
  const key = result.turnKey ?? result.turn_key;
  return nonEmptyString(key, `${name}.turnKey`, { maxBytes: 256 });
}

function normalizeRankedDocuments(keys, reverse, name) {
  const seen = new Set();
  return keys.map((key, index) => {
    const normalized = nonEmptyString(key, `${name}[${index}]`, { maxBytes: 256 });
    if (seen.has(normalized)) fail(`${name} contains a duplicate document key`);
    seen.add(normalized);
    const documentId = reverse.get(normalized);
    if (documentId === undefined) fail(`${name} contains an unknown document key`);
    return documentId;
  });
}

function queryMetrics(query, candidateDocumentIds, resultDocumentIds, judgmentPolicy) {
  const grades = new Map(query.judgments.map(({ documentId, relevance }) => [documentId, relevance]));
  const recallTargets = query.judgments.filter(
    ({ relevance }) => relevance >= judgmentPolicy.recallMinRelevance,
  );
  const recallTargetIds = new Set(recallTargets.map(({ documentId }) => documentId));
  const grade3Ids = new Set(query.judgments
    .filter(({ relevance }) => relevance === 3)
    .map(({ documentId }) => documentId));
  const grade1Ids = new Set(query.judgments
    .filter(({ relevance }) => relevance === 1)
    .map(({ documentId }) => documentId));
  for (const documentId of [...candidateDocumentIds, ...resultDocumentIds]) {
    if (!grades.has(documentId)) fail(`query ${query.queryId} returned an unjudged document`);
  }
  const recall = (ranked, limit) => {
    let hits = 0;
    for (const documentId of ranked.slice(0, limit)) if (recallTargetIds.has(documentId)) hits += 1;
    return hits / recallTargetIds.size;
  };
  const dcg = (ranked) => ranked.slice(0, 10).reduce((sum, documentId, index) => {
    const relevance = grades.get(documentId);
    return sum + ((2 ** relevance) - 1) / Math.log2(index + 2);
  }, 0);
  const idealGrades = query.judgments
    .filter(({ relevance }) => relevance > 0)
    .map(({ relevance }) => relevance)
    .sort((left, right) => right - left)
    .slice(0, 10);
  const idealDcg = idealGrades.reduce(
    (sum, relevance, index) => sum + ((2 ** relevance) - 1) / Math.log2(index + 2),
    0,
  );
  const top20 = resultDocumentIds.slice(0, 20);
  const grade1Hits = top20.filter((documentId) => grade1Ids.has(documentId)).length;
  return {
    candidateRecallAt300: recall(candidateDocumentIds, 300),
    top20Recall: recall(top20, 20),
    ndcgAt10: dcg(resultDocumentIds) / idealDcg,
    grade3HitAt20: top20.some((documentId) => grade3Ids.has(documentId)) ? 1 : 0,
    grade1ContextualCoverageAt20: grade1Ids.size === 0 ? null : grade1Hits / grade1Ids.size,
    recallTargetDocumentCount: recallTargetIds.size,
    grade3DocumentCount: grade3Ids.size,
    grade1DocumentCount: grade1Ids.size,
  };
}

function macroMetrics(queryRows) {
  if (queryRows.length === 0) fail("cannot calculate macro metrics for an empty query set");
  const output = {};
  for (const metric of ["candidateRecallAt300", "top20Recall", "ndcgAt10", "grade3HitAt20"]) {
    output[metric] = queryRows.reduce((sum, row) => sum + row.metrics[metric], 0) / queryRows.length;
  }
  const contextualRows = queryRows.filter((row) => row.metrics.grade1ContextualCoverageAt20 !== null);
  output.grade1ContextualCoverageAt20 = contextualRows.length === 0
    ? null
    : contextualRows.reduce((sum, row) => sum + row.metrics.grade1ContextualCoverageAt20, 0)
      / contextualRows.length;
  return output;
}

function qrelDigest(queries, judgmentPolicy) {
  const canonical = {
    judgmentPolicy,
    queries: [...queries]
      .sort((left, right) => left.queryId.localeCompare(right.queryId, "en"))
      .map((query) => ({ queryId: query.queryId, judgments: query.judgments })),
  };
  return createHash("sha256").update(JSON.stringify(canonical)).digest("hex");
}

export function assessQualityGates(metrics, thresholds) {
  const output = {};
  for (const metric of ["candidateRecallAt300", "top20Recall", "ndcgAt10"]) {
    const actual = finiteUnitInterval(metrics[metric], `metrics.${metric}`);
    const threshold = finiteUnitInterval(thresholds[metric], `thresholds.${metric}`);
    output[metric] = { actual, threshold, passed: actual >= threshold };
  }
  return output;
}

export function evaluateQueryQuality({
  fixture,
  outcomes,
  dataset = "real-acceptance",
  split = "evaluation",
  documentKeyById,
}) {
  assertQueryEvaluationFixture(fixture);
  if (!QUERY_SPLITS.includes(split)) fail("split is invalid");
  if (!Array.isArray(outcomes)) fail("outcomes must be an array");
  const selected = queryDataset(fixture, dataset);
  const { reverse } = documentKeyMaps(selected, documentKeyById);
  const expectedQueries = selected.queries.filter((query) => query.split === split);
  const queryById = new Map(expectedQueries.map((query) => [query.queryId, query]));
  const outcomeById = new Map();
  for (let index = 0; index < outcomes.length; index += 1) {
    const outcome = plainObject(outcomes[index], `outcomes[${index}]`);
    const queryId = nonEmptyString(outcome.queryId, `outcomes[${index}].queryId`, { maxBytes: 128 });
    if (!queryById.has(queryId)) fail(`outcomes contains unknown query ${queryId}`);
    if (outcomeById.has(queryId)) fail(`outcomes contains duplicate query ${queryId}`);
    if (!Array.isArray(outcome.publicResults)) fail(`outcome ${queryId}.publicResults must be an array`);
    const candidateKeys = normalizedCandidateKeys(outcome.searchTrace, `outcome ${queryId}.searchTrace`);
    if (candidateKeys.length > 300) fail(`outcome ${queryId} has more than 300 candidates`);
    const resultKeys = outcome.publicResults.map((result, resultIndex) => publicResultKey(
      result,
      `outcome ${queryId}.publicResults[${resultIndex}]`,
    ));
    const candidateKeySet = new Set(candidateKeys);
    if (resultKeys.some((key) => !candidateKeySet.has(key))) {
      fail(`outcome ${queryId}.publicResults must be a subset of candidates`);
    }
    outcomeById.set(queryId, {
      candidateDocumentIds: normalizeRankedDocuments(candidateKeys, reverse, `outcome ${queryId} candidates`),
      resultDocumentIds: normalizeRankedDocuments(resultKeys, reverse, `outcome ${queryId} results`),
    });
  }
  if (outcomeById.size !== expectedQueries.length) {
    const missing = expectedQueries.filter((query) => !outcomeById.has(query.queryId)).map((query) => query.queryId);
    fail(`outcomes is missing queries: ${missing.join(", ")}`);
  }
  const queries = expectedQueries
    .map((query) => {
      const outcome = outcomeById.get(query.queryId);
      return {
        queryId: query.queryId,
        language: query.language,
        metrics: queryMetrics(
          query,
          outcome.candidateDocumentIds,
          outcome.resultDocumentIds,
          fixture.judgmentPolicy,
        ),
      };
    })
    .sort((left, right) => left.queryId.localeCompare(right.queryId, "en"));
  const byLanguage = {};
  for (const language of QUERY_LANGUAGES) {
    const languageQueries = queries.filter((query) => query.language === language);
    if (languageQueries.length > 0) {
      byLanguage[language] = { queryCount: languageQueries.length, metrics: macroMetrics(languageQueries) };
    }
  }
  const metrics = macroMetrics(queries);
  return {
    format: QUERY_QUALITY_REPORT_FORMAT,
    fixtureVersion: fixture.version,
    judgmentPolicy: fixture.judgmentPolicy,
    qrelDigest: qrelDigest(expectedQueries, fixture.judgmentPolicy),
    dataset,
    provenance: selected.provenance,
    source: selected.source,
    split,
    queryCount: queries.length,
    metrics,
    byLanguage,
    gates: assessQualityGates(metrics, fixture.thresholds),
    queries,
  };
}

function metricDelta(metrics, baseline) {
  return Object.fromEntries([
    "candidateRecallAt300",
    "top20Recall",
    "ndcgAt10",
    "grade3HitAt20",
    "grade1ContextualCoverageAt20",
  ].map((metric) => [
    metric,
    metrics[metric] === null || baseline[metric] === null
      ? null
      : metrics[metric] - baseline[metric],
  ]));
}

export function evaluateComponentAblations({
  fixture,
  dataset = "review-development",
  split = "development",
  documentKeyById,
  baseline,
  variants,
}) {
  plainObject(baseline, "baseline");
  if (baseline.name !== "production") fail("baseline.name must be production");
  if (!Array.isArray(variants) || variants.length === 0) fail("variants must be a non-empty array");
  const baselineReport = evaluateQueryQuality({
    fixture,
    dataset,
    split,
    documentKeyById,
    outcomes: baseline.outcomes,
  });
  const names = new Set([baseline.name]);
  const reports = variants.map((variant, index) => {
    plainObject(variant, `variants[${index}]`);
    const name = nonEmptyString(variant.name, `variants[${index}].name`, { maxBytes: 128 });
    if (names.has(name)) fail(`duplicate ablation name ${name}`);
    names.add(name);
    assertSortedUniqueStrings(variant.removedComponents, `variants[${index}].removedComponents`, { allowEmpty: false });
    const report = evaluateQueryQuality({
      fixture,
      dataset,
      split,
      documentKeyById,
      outcomes: variant.outcomes,
    });
    return {
      name,
      removedComponents: [...variant.removedComponents],
      metrics: report.metrics,
      deltaFromBaseline: metricDelta(report.metrics, baselineReport.metrics),
      byLanguage: report.byLanguage,
    };
  }).sort((left, right) => left.name.localeCompare(right.name, "en"));
  return {
    format: QUERY_ABLATION_REPORT_FORMAT,
    fixtureVersion: fixture.version,
    judgmentPolicy: fixture.judgmentPolicy,
    qrelDigest: baselineReport.qrelDigest,
    dataset,
    provenance: queryDataset(fixture, dataset).provenance,
    source: baselineReport.source,
    split,
    queryCount: baselineReport.queryCount,
    baseline: {
      name: baseline.name,
      metrics: baselineReport.metrics,
      byLanguage: baselineReport.byLanguage,
    },
    variants: reports,
  };
}

async function main(argv) {
  if (argv.length !== 2) {
    throw new TypeError("Usage: insights-query-evaluation.mjs <fixture.json> <outcomes.json>");
  }
  const fixture = await loadQueryEvaluationFixture(argv[0]);
  const input = JSON.parse(await readFile(argv[1], "utf8"));
  const report = evaluateQueryQuality({ fixture, ...plainObject(input, "input") });
  process.stdout.write(`${JSON.stringify(report)}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
