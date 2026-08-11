#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";

import {
  assessQualityGates,
  assertQueryEvaluationFixture,
  evaluateComponentAblations,
  evaluateQueryQuality,
  loadQueryEvaluationFixture,
  queryJudgmentDigest,
} from "./insights-query-evaluation.mjs";
import { createInsightsEngineClient } from "../src/insights-engine-client.mjs";
import { createInsightsRequiredContract } from "../src/insights-engine-protocol.mjs";
import { assertSessionFactsDelta, canonicalJson, hashKey } from "../src/session-facts.mjs";
import { createBenchmarkCorpus } from "./benchmark-insights-engine.mjs";

export const QUERY_QUALITY_RUN_FORMAT = "threadshare-insights-query-quality-run@v1";
export const QUERY_CANDIDATE_SCALE_FORMAT = "threadshare-insights-candidate-recall-scale@v1";
export const FORMAL_CANDIDATE_DISTRACTOR_TURNS = 25_000;
export const FORMAL_CANDIDATE_SEED = "threadshare-item5-candidate-scale-v1";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const RUNNER_SCRIPT_SHA256 = createHash("sha256").update(await readFile(SCRIPT_PATH)).digest("hex");

const ORIGIN_SECRET_EPOCH = "66666666-6666-4666-8666-666666666666";
const FIXED_NOW_UNIX_MS = "1786320000000";
const DEFAULT_FIXTURE = fileURLToPath(new URL(
  "../test/fixtures/insights-query-evaluation.v2.json",
  import.meta.url,
));
const ENGINE_NAME = process.platform === "win32"
  ? "threadshare-insights-engine.exe"
  : "threadshare-insights-engine";
const DEFAULT_ENGINE = fileURLToPath(new URL(
  `../crates/insights-engine/target/debug/${ENGINE_NAME}`,
  import.meta.url,
));

function fail(message) {
  throw new TypeError(message);
}

function datasetFor(fixture, dataset) {
  if (dataset === "real-acceptance") return fixture.acceptance;
  if (["review-development", "synthetic-unit"].includes(dataset)) {
    return {
      documents: fixture.documents,
      queries: fixture.queries,
      provenance: fixture.provenance,
      source: fixture.developmentSource,
    };
  }
  fail("dataset is invalid");
}

async function sourceIdentity() {
  const [{ stdout: revision }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), "..") }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: path.resolve(path.dirname(fileURLToPath(import.meta.url)), ".."),
      maxBuffer: 8 * 1024 * 1024,
    }),
  ]);
  return { revision: revision.trim(), worktreeDirty: status.length > 0 };
}

async function engineIdentity(binaryPath) {
  const { stdout } = await execFileAsync(binaryPath, ["--version", "--json"], {
    maxBuffer: 1024 * 1024,
  });
  return {
    ...JSON.parse(stdout),
    binarySha256: createHash("sha256").update(await readFile(binaryPath)).digest("hex"),
  };
}

async function indexedTurnCount(databasePath) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databasePath, { readOnly: true });
  try {
    return Number(database.prepare("SELECT COUNT(*) AS value FROM turn_fts_documents").get().value);
  } finally {
    database.close();
  }
}

function checkpoint(sessionKey, firstTurnKey, secondTurnKey, completeOffset) {
  return {
    completeOffset,
    eofObserved: true,
    partialTailLength: "0",
    partialTailDigest: "0".repeat(64),
    sourceSize: completeOffset,
    sourceMtimeNs: "0",
    sourceSnapshotStable: true,
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    generation: "1",
    pendingState: {
      currentTurnKey: null,
      replayFromOffset: null,
      pendingStarted: [],
      pendingUses: [],
      sessionState: {
        sessionKey,
        sessionScope: "main",
        eligibility: "eligible",
        originatorVersion: "query-quality-runner@1",
        projectKey: null,
        observedStart: "2026-08-10T00:00:00.000Z",
        observedEnd: "2026-08-10T00:00:20.000Z",
        firstTurnKey,
        secondTurnKey,
        factTruncation: [],
        dedupe: null,
      },
      catalogEntries: [],
      seenClaudeUuids: [],
    },
  };
}

function uint64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function finalizeDelta(delta) {
  const mutation = structuredClone(delta);
  delete mutation.deltaId;
  const mutationDigest = createHash("sha256").update(canonicalJson(mutation)).digest();
  delta.deltaId = hashKey(
    "delta",
    Buffer.from(delta.session.sessionKey, "hex"),
    delta.expectedGeneration,
    delta.mode,
    delta.originSecretEpoch,
    String(delta.duplicatePolicyVersion),
    mutationDigest,
    delta.checkpoint.completeOffset,
  );
  return assertSessionFactsDelta(delta);
}

export function createQueryQualityDelta(fixture, { dataset = "real-acceptance" } = {}) {
  assertQueryEvaluationFixture(fixture);
  const selected = datasetFor(fixture, dataset);
  const sessionKey = hashKey("session", "query-quality", selected.provenance);
  const documentKeyById = Object.fromEntries(selected.documents.map((document, index) => {
    const turnStartOffset = String(index * 1_024);
    return [
      document.documentId,
      hashKey("turn", Buffer.from(sessionKey, "hex"), uint64(turnStartOffset)),
    ];
  }));
  const turns = selected.documents.map((document, index) => ({
    turnKey: documentKeyById[document.documentId],
    ownerSessionKey: sessionKey,
    turnStartOffset: String(index * 1_024),
    problemText: document.problemText,
    finalAnswerExcerpt: document.finalAnswerExcerpt,
    observedTimestamp: new Date(Date.UTC(2026, 7, 10, 0, 0, index)).toISOString(),
    rawClosure: {
      nextUserBoundary: index + 1 < selected.documents.length,
      providerTerminal: "completed",
      observedEofClosed: false,
    },
    providerVisibility: "active",
    factTruncation: [],
  }));
  const completeOffset = String(selected.documents.length * 1_024);
  const delta = finalizeDelta({
    format: "session-facts-delta@v1",
    factSchemaVersion: 1,
    providerAdapterVersion: "codex@1",
    privacyPolicyVersion: 1,
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    duplicatePolicyVersion: 1,
    expectedGeneration: "0",
    targetGeneration: "1",
    mode: "append",
    deltaId: "0".repeat(64),
    session: {
      sessionKey,
      provider: "codex",
      sessionScope: "main",
      eligibility: "eligible",
      projectKey: null,
      observedStart: "2026-08-10T00:00:00.000Z",
      observedEnd: "2026-08-10T00:00:20.000Z",
      originatorVersion: "query-quality-runner@1",
      duplicateGroupKey: null,
      dedupeFingerprint: null,
      dedupeCorroborationFingerprint: null,
      duplicateMethod: null,
      duplicateConfidence: null,
      dedupeClosure: null,
      dedupeEvidenceEventKeys: [],
      duplicatePolicyVersion: 1,
      factTruncation: [],
    },
    retractions: { turnKeys: [], orphanEventKeys: [], authoritativeTurnKeys: [] },
    turns,
    sourceRecords: [],
    evidenceEvents: [],
    turnEvidence: [],
    capabilities: [],
    capabilityUses: [],
    capabilityUseEvidence: [],
    checkpoint: checkpoint(
      sessionKey,
      turns[0]?.turnKey ?? null,
      turns[1]?.turnKey ?? null,
      completeOffset,
    ),
    diagnostics: [],
    coverage: { "query-quality-document": turns.length },
  });
  return Object.freeze({
    delta,
    documentKeyById: Object.freeze(documentKeyById),
    corpusDigest: createHash("sha256").update(canonicalJson({
      provenance: selected.provenance,
      source: selected.source,
      documents: selected.documents,
      queries: selected.queries,
    })).digest("hex"),
  });
}

function emptyFilters() {
  return {
    providers: [],
    projectKeys: [],
    observedAtOrAfterUnixMs: null,
    observedBeforeUnixMs: null,
    toolCapabilityKeys: [],
    skillCapabilityKeys: [],
    resultEvidence: [],
    closureStates: [],
  };
}

function aggregateCounts(values) {
  return {
    minimum: Math.min(...values),
    maximum: Math.max(...values),
    total: values.reduce((sum, value) => sum + value, 0),
  };
}

async function runEngineQueryOutcomes({
  fixture,
  dataset = "real-acceptance",
  split = "evaluation",
  candidateScaleTurnCount = 0,
  candidateScaleSeed = FORMAL_CANDIDATE_SEED,
  enginePath = process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE,
  workingDirectory,
} = {}) {
  assertQueryEvaluationFixture(fixture);
  const selected = datasetFor(fixture, dataset);
  const selectedQueries = selected.queries.filter((query) => query.split === split);
  if (selectedQueries.length === 0) fail(`dataset ${dataset} has no ${split} queries`);
  const root = workingDirectory ?? tmpdir();
  await mkdir(root, { recursive: true });
  const directory = await mkdtemp(path.join(root, "threadshare-query-quality-"));
  const databasePath = path.join(directory, "quality.sqlite3");
  const binaryPath = path.resolve(enginePath);
  const prepared = createQueryQualityDelta(fixture, { dataset });
  let client;
  try {
    client = await createInsightsEngineClient({
      databasePath,
      requiredContract: createInsightsRequiredContract(ORIGIN_SECRET_EPOCH),
      runtimeOptions: {
        env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: binaryPath },
      },
      childEnv: {
        ...process.env,
        SQLITE_TMPDIR: directory,
        TMPDIR: directory,
        TEMP: directory,
        TMP: directory,
      },
      clientVersion: "threadshare-query-quality-runner@1",
      timeoutMs: 120_000,
    });
    await client.applySessionFacts(prepared.delta);
    let candidateScale = null;
    if (candidateScaleTurnCount > 0) {
      if (!Number.isSafeInteger(candidateScaleTurnCount) || candidateScaleTurnCount < 1) {
        fail("candidateScaleTurnCount must be a positive safe integer");
      }
      const distractorTerms = [];
      for (const query of selectedQueries) {
        const response = await client.searchTurns({
          query: query.text,
          filters: emptyFilters(),
          limit: 1,
          pathLimit: 0,
          nowUnixMs: FIXED_NOW_UNIX_MS,
          quiescenceSeconds: 300,
        });
        const term = response.scoringTerms.find(({ field }) => field !== "capability");
        if (term === undefined) fail(`query ${query.queryId} has no text scoring term for scale distractors`);
        distractorTerms.push(term);
      }
      const corpus = createBenchmarkCorpus({
        turnCount: candidateScaleTurnCount,
        turnsPerSession: 100,
        seed: candidateScaleSeed,
      });
      const submittedDeltaDigest = createHash("sha256");
      let globalTurnIndex = 0;
      for (const item of corpus.sessions) {
        const delta = structuredClone(item.delta);
        delta.originSecretEpoch = ORIGIN_SECRET_EPOCH;
        delta.checkpoint.originSecretEpoch = ORIGIN_SECRET_EPOCH;
        for (const turn of delta.turns) {
          const queryIndex = Math.min(
            distractorTerms.length - 1,
            Math.floor((globalTurnIndex * distractorTerms.length) / candidateScaleTurnCount),
          );
          const term = distractorTerms[queryIndex];
          const lexical = term.field === "code" ? `\`${term.logicalTerm}\`` : term.logicalTerm;
          turn.problemText = `${lexical} benchmark distractor item ${globalTurnIndex.toString(36)}`;
          globalTurnIndex += 1;
        }
        delta.deltaId = "0".repeat(64);
        const submitted = finalizeDelta(delta);
        submittedDeltaDigest.update(canonicalJson(submitted));
        await client.applySessionFacts(submitted);
      }
      candidateScale = {
        turnCount: candidateScaleTurnCount,
        sessionCount: corpus.sessionCount,
        seed: candidateScaleSeed,
        submittedDeltaDigest: submittedDeltaDigest.digest("hex"),
        construction:
          "each distractor contains one production scoring term selected before insertion; " +
          "gold query and document text remain frozen",
      };
    }
    const outcomes = [];
    const snapshots = [];
    const candidateCounts = [];
    const resultCounts = [];
    for (const query of selectedQueries) {
      const response = await client.searchTurns({
        query: query.text,
        filters: emptyFilters(),
        limit: Math.min(200, selected.documents.length),
        pathLimit: 0,
        nowUnixMs: FIXED_NOW_UNIX_MS,
        quiescenceSeconds: 300,
      });
      if (
        response.searchTrace === null ||
        typeof response.searchTrace !== "object" ||
        !Array.isArray(response.searchTrace.candidateTurnKeys)
      ) {
        fail("TURN_SEARCH_RESULTS must expose the production SearchTrace candidateTurnKeys");
      }
      outcomes.push({
        queryId: query.queryId,
        searchTrace: response.searchTrace,
        publicResults: response.results,
      });
      snapshots.push(response.snapshot);
      candidateCounts.push(response.searchTrace.candidateTurnKeys.length);
      resultCounts.push(response.results.length);
    }
    const snapshot = snapshots[0];
    if (snapshots.some((value) => canonicalJson(value) !== canonicalJson(snapshot))) {
      fail("query quality run crossed an Engine snapshot boundary");
    }
    const [source, engine, actualIndexedTurnCount] = await Promise.all([
      sourceIdentity(),
      engineIdentity(binaryPath),
      indexedTurnCount(databasePath),
    ]);
    return {
      outcomes,
      documentKeyById: prepared.documentKeyById,
      execution: {
        format: QUERY_QUALITY_RUN_FORMAT,
        backend: "rust-sidecar",
        requestType: "SEARCH_TURNS",
        candidateSource: "production-search-trace",
        sourceDocumentCount: selected.documents.length,
        indexedTurnCount: actualIndexedTurnCount,
        expectedIndexedTurnCount: selected.documents.length + (candidateScale?.turnCount ?? 0),
        queryCount: selectedQueries.length,
        corpusDigest: prepared.corpusDigest,
        sourceRevision: source.revision,
        sourceWorktreeDirty: source.worktreeDirty,
        runnerScriptSha256: RUNNER_SCRIPT_SHA256,
        fixtureJsonSha256: createHash("sha256").update(JSON.stringify(fixture)).digest("hex"),
        engine,
        snapshot,
        candidateCounts: aggregateCounts(candidateCounts),
        publicResultCounts: aggregateCounts(resultCounts),
        temporaryStatePersisted: false,
        candidateScale,
      },
    };
  } finally {
    await client?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true });
  }
}

export async function runProductionQueryQualityEvaluation(options = {}) {
  const fixture = options.fixture;
  const dataset = options.dataset ?? "real-acceptance";
  const split = options.split ?? "evaluation";
  const run = await runEngineQueryOutcomes({ ...options, dataset, split });
  const report = evaluateQueryQuality({
    fixture,
    outcomes: run.outcomes,
    dataset,
    split,
    documentKeyById: run.documentKeyById,
  });
  return {
    ...report,
    execution: run.execution,
  };
}

export function evaluateCandidateRecallAtScale({
  fixture,
  outcomes,
  documentKeyById,
  indexedTurnCount,
  distractorTurnCount = FORMAL_CANDIDATE_DISTRACTOR_TURNS,
}) {
  assertQueryEvaluationFixture(fixture);
  if (!Array.isArray(outcomes)) fail("outcomes must be an array");
  if (!Number.isSafeInteger(indexedTurnCount) || indexedTurnCount < 1) {
    fail("indexedTurnCount must be a positive safe integer");
  }
  const queries = fixture.acceptance.queries.filter((query) => query.split === "evaluation");
  const outcomeById = new Map(outcomes.map((outcome) => [outcome.queryId, outcome]));
  if (outcomeById.size !== queries.length || outcomes.length !== queries.length) {
    fail("candidate-scale outcomes must contain each acceptance query exactly once");
  }
  const rows = queries.map((query) => {
    const outcome = outcomeById.get(query.queryId);
    if (outcome === undefined) fail(`candidate-scale outcomes is missing ${query.queryId}`);
    const candidates = outcome.searchTrace?.candidateTurnKeys;
    if (!Array.isArray(candidates) || candidates.length > 300) {
      fail(`candidate-scale outcome ${query.queryId} must contain at most 300 candidate keys`);
    }
    const candidateSet = new Set(candidates);
    if (candidateSet.size !== candidates.length) {
      fail(`candidate-scale outcome ${query.queryId} contains duplicate candidate keys`);
    }
    const targets = query.judgments
      .filter(({ relevance }) => relevance >= fixture.judgmentPolicy.recallMinRelevance)
      .map(({ documentId }) => documentKeyById[documentId]);
    if (targets.some((key) => typeof key !== "string")) {
      fail(`documentKeyById is missing a target for ${query.queryId}`);
    }
    const hits = targets.filter((key) => candidateSet.has(key)).length;
    return {
      queryId: query.queryId,
      language: query.language,
      candidateCount: candidates.length,
      recallTargetCount: targets.length,
      recallTargetHits: hits,
      candidateRecallAt300: hits / targets.length,
    };
  }).sort((left, right) => left.queryId.localeCompare(right.queryId, "en"));
  const candidateRecallAt300 = rows.reduce((sum, row) => sum + row.candidateRecallAt300, 0) / rows.length;
  const candidateCounts = rows.map(({ candidateCount }) => candidateCount);
  const candidateLimitReachedQueryCount = candidateCounts.filter((count) => count === 300).length;
  const gates = {
    candidateRecallAt300: {
      actual: candidateRecallAt300,
      threshold: fixture.thresholds.candidateRecallAt300,
      passed: candidateRecallAt300 >= fixture.thresholds.candidateRecallAt300,
    },
    candidateLimitReached: {
      actual: candidateLimitReachedQueryCount,
      threshold: 1,
      passed: candidateLimitReachedQueryCount >= 1,
    },
    indexedTurnCount: {
      actual: indexedTurnCount,
      expected: fixture.acceptance.documents.length + FORMAL_CANDIDATE_DISTRACTOR_TURNS,
      passed: indexedTurnCount === fixture.acceptance.documents.length + FORMAL_CANDIDATE_DISTRACTOR_TURNS,
    },
    distractorTurnCount: {
      actual: distractorTurnCount,
      expected: FORMAL_CANDIDATE_DISTRACTOR_TURNS,
      passed: distractorTurnCount === FORMAL_CANDIDATE_DISTRACTOR_TURNS,
    },
  };
  return {
    format: QUERY_CANDIDATE_SCALE_FORMAT,
    fixtureVersion: fixture.version,
    judgmentPolicy: fixture.judgmentPolicy,
    qrelDigest: queryJudgmentDigest({ fixture }),
    queryCount: rows.length,
    indexedTurnCount,
    distractorTurnCount,
    candidateRecallAt300,
    candidateCounts: aggregateCounts(candidateCounts),
    candidateLimitReachedQueryCount,
    gates,
    allGatesPassed: Object.values(gates).every(({ passed }) => passed),
    queries: rows,
  };
}

export async function runProductionCandidateRecallAtScale({
  fixture,
  candidateScaleTurnCount = 25_000,
  candidateScaleSeed = FORMAL_CANDIDATE_SEED,
  formal = false,
  enginePath = process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE,
  workingDirectory,
} = {}) {
  if (formal && candidateScaleTurnCount !== FORMAL_CANDIDATE_DISTRACTOR_TURNS) {
    fail("formal candidate evidence requires exactly 25000 distractor Turns");
  }
  if (formal && candidateScaleSeed !== FORMAL_CANDIDATE_SEED) {
    fail(`formal candidate evidence requires seed ${FORMAL_CANDIDATE_SEED}`);
  }
  const run = await runEngineQueryOutcomes({
    fixture,
    dataset: "real-acceptance",
    split: "evaluation",
    candidateScaleTurnCount,
    candidateScaleSeed,
    enginePath,
    workingDirectory,
  });
  return {
    ...evaluateCandidateRecallAtScale({
      fixture,
      outcomes: run.outcomes,
      documentKeyById: run.documentKeyById,
      indexedTurnCount: run.execution.indexedTurnCount,
      distractorTurnCount: run.execution.candidateScale?.turnCount ?? 0,
    }),
    execution: run.execution,
  };
}

function ablatedResultScore(result, removedComponent) {
  if (result.score === null) return 0;
  const rank = removedComponent === "bm25-rank" ? 0 : 0.45 * result.score.rankComponentPpm;
  const coverage = removedComponent === "idf-coverage" ? 0 : 0.40 * result.score.idfCoveragePpm;
  const exact = removedComponent === "exact-substring" || !result.score.exact ? 0 : 0.15 * 1_000_000;
  return Math.round(rank + coverage + exact);
}

export function createProductionComponentAblationOutcomes(outcomes, removedComponent) {
  if (!["bm25-rank", "exact-substring", "idf-coverage"].includes(removedComponent)) {
    fail("removedComponent is invalid");
  }
  return outcomes.map((outcome) => ({
    queryId: outcome.queryId,
    searchTrace: outcome.searchTrace,
    publicResults: [...outcome.publicResults].sort((left, right) => {
      const score = ablatedResultScore(right, removedComponent) - ablatedResultScore(left, removedComponent);
      if (score !== 0) return score;
      const timestamp = right.observedTimestamp.localeCompare(left.observedTimestamp, "en");
      if (timestamp !== 0) return timestamp;
      return left.turnKey.localeCompare(right.turnKey, "en");
    }),
  }));
}

export async function runProductionQueryComponentAblations({
  fixture,
  enginePath = process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE,
  workingDirectory,
} = {}) {
  const run = await runEngineQueryOutcomes({
    fixture,
    dataset: "review-development",
    split: "development",
    enginePath,
    workingDirectory,
  });
  const variants = [
    ["without-bm25-rank", "bm25-rank"],
    ["without-exact-substring", "exact-substring"],
    ["without-idf-coverage", "idf-coverage"],
  ].map(([name, removedComponent]) => ({
    name,
    removedComponents: [removedComponent],
    outcomes: createProductionComponentAblationOutcomes(run.outcomes, removedComponent),
  }));
  return {
    ...evaluateComponentAblations({
      fixture,
      dataset: "review-development",
      split: "development",
      documentKeyById: run.documentKeyById,
      baseline: { name: "production", outcomes: run.outcomes },
      variants,
    }),
    execution: {
      ...run.execution,
      ablationScope: "fixed-production-candidates-rerank-only",
      candidateGenerationRerunPerVariant: false,
      developmentSetKind: "review-derived-deidentified-disjoint",
    },
  };
}

function parseArguments(argv) {
  const values = {
    ablationOutput: null,
    candidateOutput: null,
    fixture: DEFAULT_FIXTURE,
    engine: process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE,
    output: null,
    formal: false,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    if (argument === "--formal") {
      values.formal = true;
      continue;
    }
    if (![
      "--ablation-output",
      "--candidate-output",
      "--fixture",
      "--engine",
      "--output",
    ].includes(argument)) {
      fail(`unknown argument ${argument}`);
    }
    const value = argv[index + 1];
    if (typeof value !== "string" || value.length === 0 || value.startsWith("--")) {
      fail(`${argument} requires a value`);
    }
    values[argument === "--ablation-output"
      ? "ablationOutput"
      : argument === "--candidate-output"
        ? "candidateOutput"
        : argument.slice(2)] = value;
    index += 1;
  }
  return values;
}

function usage() {
  return "Usage: run-insights-query-quality.mjs [--formal] [--fixture FILE] [--engine FILE] [--output FILE] [--ablation-output FILE] [--candidate-output FILE]";
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  const fixture = await loadQueryEvaluationFixture(options.fixture);
  if (options.formal && [options.output, options.ablationOutput, options.candidateOutput].some((value) => value === null)) {
    fail("--formal requires --output, --ablation-output, and --candidate-output");
  }
  const report = await runProductionQueryQualityEvaluation({
    fixture,
    enginePath: options.engine,
  });
  const serialized = `${JSON.stringify(report, null, 2)}\n`;
  if (options.output === null) {
    process.stdout.write(serialized);
  } else {
    await mkdir(path.dirname(path.resolve(options.output)), { recursive: true });
    await writeFile(options.output, serialized, { mode: 0o600 });
  }
  if (options.ablationOutput !== null) {
    const ablation = await runProductionQueryComponentAblations({
      fixture,
      enginePath: options.engine,
    });
    await mkdir(path.dirname(path.resolve(options.ablationOutput)), { recursive: true });
    await writeFile(options.ablationOutput, `${JSON.stringify(ablation, null, 2)}\n`, { mode: 0o600 });
  }
  if (options.candidateOutput !== null) {
    const candidate = await runProductionCandidateRecallAtScale({
      fixture,
      enginePath: options.engine,
      formal: options.formal,
    });
    await mkdir(path.dirname(path.resolve(options.candidateOutput)), { recursive: true });
    await writeFile(options.candidateOutput, `${JSON.stringify(candidate, null, 2)}\n`, { mode: 0o600 });
    if (!candidate.allGatesPassed) throw new Error("production candidate-scale gates failed");
  }
  const gates = assessQualityGates(report.metrics, fixture.thresholds);
  if (Object.values(gates).some(({ passed }) => !passed)) {
    throw new Error("production query quality gates failed");
  }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
