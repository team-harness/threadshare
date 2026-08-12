import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createDeepQueryBenchmarkReport,
  createBenchmarkCorpus,
  createCapacityBenchmarkPlan,
  evaluateCapacityGates,
  evaluateInsightsQueryGates,
  evaluateOverviewLatencyGate,
  FORMAL_DEEP_QUERY_COUNT,
  FORMAL_DEEP_QUERY_SEEDS,
  FORMAL_DEEP_QUERY_WARMUP_COUNT,
  parseBenchmarkArguments,
  runInsightsCapacityBenchmark,
  runInsightsDeepQueryBenchmark,
  runInsightsEngineBenchmark,
  runInsightsQueryBenchmark,
  runInsightsRawBackfillBenchmark,
  sqliteFileFormatPages,
} from "../scripts/benchmark-insights-engine.mjs";

const ENGINE_NAME = process.platform === "win32"
  ? "threadshare-insights-engine.exe"
  : "threadshare-insights-engine";
const DEBUG_ENGINE_PATH = fileURLToPath(new URL(
  `../crates/insights-engine/target/debug/${ENGINE_NAME}`,
  import.meta.url,
));

test("benchmark corpus is deterministic and changes every Turn identity", () => {
  const first = createBenchmarkCorpus({
    turnCount: 11,
    turnsPerSession: 4,
    seed: "benchmark-test-seed",
  });
  const second = createBenchmarkCorpus({
    turnCount: 11,
    turnsPerSession: 4,
    seed: "benchmark-test-seed",
  });
  assert.equal(first.digest, second.digest);
  assert.equal(first.canonicalBytes, second.canonicalBytes);
  assert.equal(first.sessionCount, 3);
  const turns = first.sessions.flatMap((item) => item.delta.turns);
  assert.equal(turns.length, 11);
  assert.equal(new Set(turns.map((turn) => turn.turnKey)).size, 11);
  assert.equal(new Set(turns.map((turn) => turn.problemText)).size, 11);
});

test("capacity corpus streams deterministic high-density Facts with bounded retention", () => {
  const first = createCapacityBenchmarkPlan({
    turnCount: 11,
    turnsPerSession: 4,
    seed: "capacity-test-seed",
  });
  const second = createCapacityBenchmarkPlan({
    turnCount: 11,
    turnsPerSession: 4,
    seed: "capacity-test-seed",
  });
  assert.equal(first.identityDigest, second.identityDigest);
  assert.equal(first.sessionCount, 3);
  assert.equal("sessions" in first, false);
  const firstSession = first.sessionAt(0);
  const repeated = second.sessionAt(0);
  assert.equal(firstSession.canonical, repeated.canonical);
  assert.equal(firstSession.delta.turns.length, 4);
  assert.equal(firstSession.delta.session.dedupeFingerprint === null, false);
  assert.equal(firstSession.delta.session.duplicateConfidence, "strong");
  assert.equal(firstSession.delta.session.dedupeEvidenceEventKeys.length, 3);
  assert.equal(first.corpusVersion, 6);
  assert.equal(firstSession.delta.sourceRecords.length, 4 * 10 + 1);
  assert.equal(firstSession.delta.evidenceEvents.length, 4 * 9);
  assert.equal(firstSession.delta.turnEvidence.length, 4 * 3);
  assert.equal(firstSession.delta.capabilityUses.length, 4 * 3);
  assert.equal(firstSession.delta.capabilityUseEvidence.length, 4 * 6);
  assert.equal(firstSession.delta.historyEvents.length, 4 * 10 + 1);
  assert.equal(firstSession.delta.historyPayloads.length, 4 * 8 + 1);
  assert.equal(firstSession.delta.historyPayloadChunks.length, 4 * 8 + 32);
  assert.equal(
    firstSession.delta.historyEvents.some(({ metadata }) => metadata.usageScope === "delta"),
    true,
  );
  assert.equal(
    firstSession.delta.historyEvents.some(({ metadata }) => metadata.fileActivities?.length > 0),
    true,
  );
  assert.equal(
    firstSession.delta.historyEvents.some(({ metadata }) =>
      metadata.errorSignatureVersion === "error-signature@1"),
    true,
  );
  assert.equal(new Set(firstSession.delta.sourceRecords.map((item) => item.sourceRecordKey)).size, 41);
  const replacement = first.sessionAt(0, { generation: 2, replacement: true });
  assert.equal(replacement.delta.session.sessionKey, firstSession.delta.session.sessionKey);
  assert.deepEqual(
    replacement.delta.turns.map((turn) => turn.turnKey),
    firstSession.delta.turns.map((turn) => turn.turnKey),
  );
  assert.notEqual(replacement.canonical, firstSession.canonical);
  const longTerm = createCapacityBenchmarkPlan({
    turnCount: 250_000,
    turnsPerSession: 100,
    seed: "capacity-long-term-shape",
  });
  assert.equal(longTerm.sessionCount, 2_500);
  assert.equal("sessions" in longTerm, false);
  assert.notEqual(longTerm.sessionKey(0), longTerm.sessionKey(2_499));
});

test("capacity gates mechanically require packed Facts only above frozen limits", () => {
  const gib = 1024 ** 3;
  assert.equal(evaluateCapacityGates({
    factBytes: 6 * gib,
    steadyStateBytes: 8 * gib,
  }).packedFactsRequired, false);
  assert.deepEqual(
    evaluateCapacityGates({ factBytes: 6 * gib + 1, steadyStateBytes: 1 }),
    {
      normalizedFactLimitBytes: 6 * gib,
      steadyStateLimitBytes: 8 * gib,
      normalizedFactExceeded: true,
      steadyStateExceeded: false,
      packedFactsRequired: true,
      decision: "packed-facts-v1-required",
    },
  );
  assert.equal(evaluateCapacityGates({
    factBytes: 1,
    steadyStateBytes: 8 * gib + 1,
  }).packedFactsRequired, true);
});

test("Deep Query benchmark CLI freezes formal defaults without overriding explicit inputs", () => {
  const formal = parseBenchmarkArguments([
    "--deep-query-benchmark", "--formal", "--turns", "250000",
  ]);
  assert.equal(formal.queryCount, FORMAL_DEEP_QUERY_COUNT);
  assert.equal(formal.warmupCount, FORMAL_DEEP_QUERY_WARMUP_COUNT);
  assert.equal(formal.seed, FORMAL_DEEP_QUERY_SEEDS[250000]);

  const explicit = parseBenchmarkArguments([
    "--deep-query-benchmark", "--turns", "800", "--queries", "3",
    "--warmup", "2", "--seed", "explicit-deep-seed",
  ]);
  assert.equal(explicit.queryCount, 3);
  assert.equal(explicit.warmupCount, 2);
  assert.equal(explicit.seed, "explicit-deep-seed");
});

test("formal Deep Query benchmark rejects non-frozen corpus and work budgets before launch", async () => {
  await assert.rejects(
    runInsightsDeepQueryBenchmark({ turnCount: 800, formal: true }),
    /exactly 25000 or 250000 Turns/u,
  );
  await assert.rejects(
    runInsightsDeepQueryBenchmark({
      turnCount: 25_000,
      turnsPerSession: 50,
      seed: FORMAL_DEEP_QUERY_SEEDS[25000],
      formal: true,
    }),
    /exactly 100 Turns per session/u,
  );
  await assert.rejects(
    runInsightsDeepQueryBenchmark({
      turnCount: 25_000,
      seed: "wrong-deep-seed",
      formal: true,
    }),
    /requires seed threadshare-insights-deep-query-25k-v1/u,
  );
  await assert.rejects(
    runInsightsDeepQueryBenchmark({
      turnCount: 25_000,
      queryCount: FORMAL_DEEP_QUERY_COUNT - 1,
      seed: FORMAL_DEEP_QUERY_SEEDS[25000],
      formal: true,
    }),
    /exactly 100 measured runs/u,
  );
});

test("overview latency gate fails closed at the 25k and 250k budgets", () => {
  assert.equal(evaluateOverviewLatencyGate({
    turnCount: 25_000,
    roundTripMs: { p95: 99, p99: 249 },
  }).withinLimit, true);
  assert.equal(evaluateOverviewLatencyGate({
    turnCount: 25_000,
    roundTripMs: { p95: 100, p99: 249 },
  }).withinLimit, false);
  assert.equal(evaluateOverviewLatencyGate({
    turnCount: 250_000,
    roundTripMs: { p95: 199, p99: 500 },
  }).withinLimit, false);
  assert.throws(
    () => evaluateOverviewLatencyGate({ turnCount: 250_001, roundTripMs: { p95: 1, p99: 1 } }),
    /at most 250000 Turns/u,
  );
});

test("query gates enforce both path modes and the frozen current/long-term budgets", async () => {
  const group = (pathLimit, queryCount, p95, p99, overrides = {}) => ({
    pathLimit,
    queryCount,
    warmupCount: 100,
    roundTripMs: { p95, p99 },
    emptyResultCount: 0,
    insufficientSampleCount: 0,
    evidencePathFamilyCount: pathLimit === 0 ? 0 : queryCount,
    ...overrides,
  });
  const current = evaluateInsightsQueryGates({
    turnCount: 25_000,
    groups: [group(0, 1_000, 99.9, 249.9), group(10, 1_000, 80, 200)],
    sidecarPeakBytes: 96 * 1024 * 1024 - 1,
    detailFullFtsBytes: 400 * 1024 * 1024 - 1,
    derivedStateBytes: 1024 ** 3 - 1,
  });
  assert.equal(current.budget.name, "current-25k");
  assert.equal(current.acceptanceCorpusExact, true);
  assert.equal(current.warmupCountAtLeast100, true);
  assert.equal(current.allQueriesReturnedResults, true);
  assert.equal(current.toolPathWorkloadComplete, true);
  assert.equal(current.allMeasuredQueryGatesPassed, true);

  const longTerm = evaluateInsightsQueryGates({
    turnCount: 250_000,
    groups: [group(0, 999, 200, 499), group(10, 1_000, 199, 500)],
    sidecarPeakBytes: 128 * 1024 * 1024,
    detailFullFtsBytes: 400 * 1024 * 1024,
    derivedStateBytes: 8 * 1024 ** 3,
  });
  assert.equal(longTerm.budget.name, "long-term-250k");
  assert.equal(longTerm.queryCountAtLeast1000, false);
  assert.equal(longTerm.allLatencyWithinLimit, false);
  assert.equal(longTerm.sidecarRssWithinLimit, false);
  assert.equal(longTerm.detailFullFtsWithinLimit, false);
  assert.equal(longTerm.derivedStateWithinLimit, false);
  assert.equal(longTerm.allMeasuredQueryGatesPassed, false);
  assert.throws(
    () => evaluateInsightsQueryGates({
      turnCount: 25_000,
      groups: [group(0, 1_000, 1, 1), group(5, 1_000, 1, 1)],
      sidecarPeakBytes: 1,
      detailFullFtsBytes: 1,
      derivedStateBytes: 1,
    }),
    /pathLimit=0 and pathLimit=10/u,
  );
  await assert.rejects(
    runInsightsQueryBenchmark({ turnCount: 25_000, queryCount: 999 }),
    /at least 1000 measured queries per path mode/u,
  );
  await assert.rejects(
    runInsightsQueryBenchmark({ turnCount: 24_999, formal: true }),
    /exactly 25000 or 250000 Turns/u,
  );
  await assert.rejects(
    runInsightsQueryBenchmark({ turnCount: 25_000, turnsPerSession: 50, formal: true }),
    /exactly 100 Turns per session/u,
  );
  await assert.rejects(
    runInsightsQueryBenchmark({
      turnCount: 25_000,
      queryCount: 1_000,
      warmupCount: 100,
      seed: "wrong-formal-seed",
      formal: true,
    }),
    /requires seed threadshare-insights-query-25k-v1/u,
  );
  await assert.rejects(
    runInsightsQueryBenchmark({
      turnCount: 25_000,
      queryCount: 1_000,
      warmupCount: 99,
      seed: "threadshare-insights-query-25k-v1",
      formal: true,
    }),
    /at least 100 warmup queries per path mode/u,
  );
});

test("SQLite page accounting includes the lock-byte and freelist pages outside dbstat", () => {
  assert.deepEqual(sqliteFileFormatPages({
    pageCount: 262_144,
    pageSize: 4_096,
    freelistCount: 0,
  }), {
    lockBytePageBytes: 0,
    freelistBytes: 0,
    totalBytes: 0,
  });
  assert.deepEqual(sqliteFileFormatPages({
    pageCount: 262_145,
    pageSize: 4_096,
    freelistCount: 3,
  }), {
    lockBytePageBytes: 4_096,
    freelistBytes: 12_288,
    totalBytes: 16_384,
  });
});

test("small benchmark compares the real Rust commit protocol with node:sqlite", {
  timeout: 30_000,
  skip: Number(process.versions.node.split(".")[0]) < 22 || !existsSync(DEBUG_ENGINE_PATH)
    ? "requires Node 22.5+ and a debug Insights Engine build"
    : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-benchmark-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await runInsightsEngineBenchmark({
    turnCount: 12,
    turnsPerSession: 4,
    queryCount: 8,
    warmupCount: 2,
    seed: "benchmark-e2e-test",
    binaryPath: DEBUG_ENGINE_PATH,
    workingDirectory: directory,
  });

  assert.equal(report.format, "threadshare-insights-engine-benchmark@v1");
  assert.equal(report.measuredScope, "item-3-session-commit-substrate");
  assert.equal(report.environment.hostLoad.atStart.oneMinute >= 0, true);
  assert.equal(report.environment.hostLoad.atReport.oneMinute >= 0, true);
  assert.equal(report.corpus.turns, 12);
  assert.equal(report.rustSidecar.query.rustProtocolQueryAvailable, false);
  assert.equal(report.comparison.queryResultsEqual, true);
  assert.equal(report.rustSidecar.protocol.requestFrames > report.corpus.sessions, true);
  assert.equal(
    report.rustSidecar.databaseBytes >= report.nodeSqliteReference.databaseBytes,
    true,
  );
  assert.equal(report.deferredToItem4.length > 0, true);
});

test("small capacity benchmark audits real Fact, FTS, Projection, and lifecycle mutations", {
  timeout: 240_000,
  skip: Number(process.versions.node.split(".")[0]) < 22 || !existsSync(DEBUG_ENGINE_PATH)
    ? "requires Node 22.5+ and a debug Insights Engine build"
    : false,
}, async (t) => {
  const turnCount = 800;
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-capacity-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await runInsightsCapacityBenchmark({
    turnCount,
    turnsPerSession: 100,
    queryCount: 8,
    warmupCount: 2,
    deepQueryCount: 2,
    deepQueryWarmupCount: 1,
    mutationQueryEquivalenceCount: 8,
    seed: "capacity-e2e-test",
    binaryPath: DEBUG_ENGINE_PATH,
    workingDirectory: directory,
  });

  assert.equal(report.format, "threadshare-insights-capacity-benchmark@v1");
  assert.equal(report.measuredScope, "item-4-normalized-fact-fts-projection-capacity");
  assert.equal(report.environment.hostLoad.atStart.oneMinute >= 0, true);
  assert.equal(report.environment.hostLoad.atReport.oneMinute >= 0, true);
  assert.equal(report.corpus.turns, turnCount);
  assert.equal(report.corpus.corpusVersion, 6);
  assert.equal(report.corpus.density.evidenceEventsPerTurn, 9);
  const audit = report.rustSidecar.capacity;
  assert.equal(audit.rowCounts.turns, turnCount);
  assert.equal(audit.rowCounts.source_records, turnCount * 10 + 1);
  assert.equal(audit.rowCounts.evidence_events, turnCount * 9);
  assert.equal(audit.rowCounts.history_events, turnCount * 10 + 1);
  assert.equal(audit.rowCounts.history_payloads, turnCount * 8 + 1);
  assert.equal(audit.rowCounts.history_payload_chunks, turnCount * 8 + 32);
  assert.equal(audit.deepHistory.ftsIntegrity, "ok");
  assert.equal(audit.rowCounts.capability_uses, turnCount * 3);
  assert.equal(audit.rowCounts.turn_fts_documents, turnCount);
  assert.equal(audit.rowCounts.turn_rollup_contributions >= turnCount, true);
  assert.equal(audit.ftsMetrics.documents, turnCount);
  const naturalFts = audit.ftsMetrics.byField.find(({ field }) => field === "natural");
  const codeFts = audit.ftsMetrics.byField.find(({ field }) => field === "code");
  const capabilityFts = audit.ftsMetrics.byField.find(({ field }) => field === "capability");
  assert.equal(
    naturalFts.fieldTerms >=
      report.corpus.turns * report.corpus.density.uniqueNaturalTermsPerTurn,
    true,
  );
  assert.equal(
    naturalFts.postings >=
      report.corpus.turns * report.corpus.density.naturalTermsPerTurn,
    true,
  );
  assert.deepEqual(
    { fieldTerms: codeFts.fieldTerms, postings: codeFts.postings },
    { fieldTerms: 0, postings: 0 },
  );
  assert.equal(
    capabilityFts.postings >=
      report.corpus.turns * report.corpus.density.capabilityUsesPerTurn,
    true,
  );
  assert.equal(audit.ftsMetrics.density.natural.meetsExpectedDensity, true);
  assert.equal(audit.ftsMetrics.density.code.meetsExpectedDensity, true);
  assert.equal(audit.ftsMetrics.density.capability.meetsExpectedDensity, true);
  assert.equal(audit.ftsMetrics.backendReevaluationRequired, false);
  assert.equal(audit.categories.fact.bytes > 0, true);
  assert.equal(audit.categories.fts.bytes > 0, true);
  assert.equal(audit.categories.projection.bytes > 0, true);
  assert.equal(
    Object.values(audit.categories).reduce((total, item) => total + item.bytes, 0),
    audit.dbstatBytes,
  );
  assert.equal(
    audit.dbstatBytes + audit.fileFormatPages.totalBytes,
    audit.databasePageBytes,
  );
  assert.equal(audit.dbstatAccountedPageBytes, audit.databasePageBytes);
  assert.equal(audit.fileFormatPages.lockBytePageBytes, 0);
  assert.equal(audit.fileFormatPages.freelistBytes, 0);
  assert.deepEqual(audit.unclassifiedObjects, []);
  assert.equal(audit.byObject.history_events.category, "fact");
  assert.equal(audit.byObject.history_event_fts_data.category, "fts");
  assert.equal(audit.byObject.history_coverage_rollups.category, "projection");
  assert.equal(audit.categories.unclassified.bytes, 0);
  assert.equal(audit.compactedSteadyStateBytes > audit.postVacuumPersistentBytes, true);
  assert.equal(
    audit.observedDerivedStatePeakBytes >= audit.compactedSteadyStateBytes,
    true,
  );
  assert.deepEqual(audit.integrity, ["ok"]);
  assert.equal(audit.foreignKeyViolations, 0);
  assert.equal(audit.gates.packedFactsRequired, false);
  assert.equal(audit.gates.storageClassificationComplete, true);
  assert.equal(audit.gates.dbstatMatchesPageBytes, true);
  assert.equal(audit.gates.engineRssWithinLimit, true);
  assert.equal(audit.gates.ftsDensityMatchesCorpus, true);
  assert.equal(audit.gates.ftsBackendWithinLimit, true);
  assert.equal(audit.gates.populatedWarmOpenUnder500Ms, true);
  assert.equal(audit.gates.productAppendWithin2Seconds, true);
  assert.equal(audit.gates.overviewLatencyWithinLimit, true);
  assert.equal(audit.gates.allMeasuredCapacityGatesPassed, true);
  assert.equal(audit.engineRss.sidecarPeakBytes, report.rustSidecar.rss.sidecarPeakBytes);
  assert.equal(report.rustSidecar.rss.peakSampled, true);
  assert.equal(report.rustSidecar.overview.measuredRequestCount, 8);
  assert.equal(report.rustSidecar.overview.warmupRequestCount, 2);
  assert.equal(report.rustSidecar.overview.totalRequestCount, 10);
  assert.deepEqual(report.rustSidecar.overview.requestIdRange, {
    first: "2000000",
    last: "2000009",
  });
  assert.equal(report.rustSidecar.overview.roundTripMs.count, 8);
  assert.equal(report.rustSidecar.overview.payloadMismatchCount, 0);
  assert.equal(report.rustSidecar.overview.snapshotMismatchCount, 0);
  assert.equal(report.rustSidecar.overview.gates.allMeasuredOverviewGatesPassed, true);
  assert.match(report.rustSidecar.overview.measurement, /transactional rollups/u);
  const deepQuery = report.rustSidecar.deepQuery;
  assert.equal(deepQuery.measuredRequestCount, 2);
  assert.equal(deepQuery.warmupRequestCount, 1);
  assert.equal(deepQuery.records.emptyResultCount, 0);
  assert.equal(deepQuery.aggregate.emptyResultCount, 0);
  assert.equal(
    Object.values(deepQuery.recipes).every(({ emptyResultCount }) => emptyResultCount === 0),
    true,
  );
  assert.equal(deepQuery.evidence.completedReadCount, 2);
  assert.equal(deepQuery.evidence.multiPageReadCount, 2);
  assert.equal(deepQuery.evidence.returnedBytes > 2 * 1024 * 1024, true);
  assert.equal(deepQuery.evidence.firstPageRoundTripMs.count, 2);
  assert.equal(deepQuery.evidence.payloadMiBPerSecond > 0, true);
  assert.equal(deepQuery.gates.allDeepQueryPathsExercised, true);
  const deepReport = createDeepQueryBenchmarkReport(report);
  assert.equal(deepReport.format, "threadshare-insights-deep-query-benchmark@v1");
  assert.equal(
    deepReport.measuredScope,
    "local-insights-fact-v2-deep-query-capacity-and-performance",
  );
  assert.equal(deepReport.rowCounts.history_events, turnCount * 10 + 1);
  assert.equal(deepReport.rowCounts.history_payloads, turnCount * 8 + 1);
  assert.equal(deepReport.storage.historyEventMetadataBytes > 0, true);
  assert.equal(deepReport.storage.historyPayloadBytes > 0, true);
  assert.equal(deepReport.storage.historyFtsBytes > 0, true);
  assert.equal(deepReport.storage.persistentStorageAmplification > 0, true);
  assert.equal(deepReport.storage.historyFtsAmplification > 0, true);
  assert.equal(deepReport.gates.v2CorpusComplete, true);
  assert.equal(deepReport.gates.deepQueryPathsComplete, true);
  assert.equal(deepReport.gates.historyFtsIntegrityPassed, true);
  assert.equal(deepReport.gates.storageClassificationComplete, true);
  assert.equal(deepReport.gates.queryPlanUsesEventKindIndex, true);
  const backfill = report.rustSidecar.backfill;
  assert.equal(backfill.commitAckMs.count, turnCount / 100);
  assert.equal(backfill.commitAckMs.p50 > 0, true);
  assert.equal(backfill.commitAckMs.p50 <= backfill.commitAckMs.p95, true);
  assert.equal(backfill.commitAckMs.p95 <= backfill.commitAckMs.p99, true);
  assert.equal(backfill.corpusGenerationMs > 0, true);
  assert.equal(backfill.protocolPreparationMs > 0, true);
  assert.equal(backfill.engineBackfillMs > 0, true);
  assert.equal(
    Math.abs(
      backfill.wallMs - backfill.corpusGenerationMs -
      backfill.protocolPreparationMs - backfill.engineBackfillMs,
    ) < 0.001,
    true,
  );
  assert.equal(backfill.endToEndTurnsPerSecond > 0, true);
  assert.equal(backfill.engineTurnsPerSecond > 0, true);
  assert.equal(
    report.rustSidecar.query.measurementPhase,
    "before-vacuum-capacity-maintenance",
  );
  const search = report.rustSidecar.search;
  assert.deepEqual(search.groups.map(({ pathLimit }) => pathLimit), [0, 10]);
  assert.equal(search.groups.every(({ queryCount }) => queryCount === 8), true);
  assert.equal(search.groups.every(({ emptyResultCount }) => emptyResultCount === 0), true);
  assert.equal(search.groups.every(({ roundTripMs }) => roundTripMs.count === 8), true);
  assert.equal(
    search.groups.every(({ diagnosticStages }) =>
      diagnosticStages.postingAndFilterCombined.attribution.includes("not expose")),
    true,
  );
  assert.equal(search.rss.sidecarPeakBytes > 0, true);
  assert.equal(search.storage.detailFullFtsBytes, audit.categories.fts.bytes);
  assert.equal(search.gates.toolPathWorkloadComplete, true);
  assert.equal(search.gates.acceptanceCorpusExact, false);
  assert.equal(search.gates.queryCountAtLeast1000, false);
  assert.equal(search.gates.warmupCountAtLeast100, false);
  assert.equal(search.gates.allMeasuredQueryGatesPassed, false);
  assert.equal(report.rustSidecar.startup.emptyDatabase.readyMs >= 0, true);
  const populatedStartup = report.rustSidecar.startup.populatedDatabase;
  assert.equal(populatedStartup.readyMs >= 0, true);
  assert.equal(populatedStartup.firstOverviewReadMs > 0, true);
  assert.equal(
    populatedStartup.readyAndFirstOverviewMs >= populatedStartup.readyMs,
    true,
  );
  assert.equal(populatedStartup.integrityStatusReadMs > 0, true);
  assert.equal(
    populatedStartup.readyOverviewAndIntegrityStatusMs >=
      populatedStartup.readyAndFirstOverviewMs,
    true,
  );
  assert.equal(populatedStartup.status.type, "ENGINE_STATUS");
  assert.equal(populatedStartup.status.snapshotSeq, String(report.corpus.sessions));
  assert.equal(populatedStartup.status.snapshotPending, false);
  assert.equal(BigInt(populatedStartup.status.changeLog.rows) > 0n, true);
  assert.equal(populatedStartup.sampleCount, 3);
  assert.equal(populatedStartup.samples.length, 3);
  assert.equal(populatedStartup.gate.medianReadyAndFirstOverviewUnder500Ms, true);
  const productFreshness = report.rustSidecar.productAppendFreshness;
  assert.match(productFreshness.measurement, /reconcileActiveInsights.*SEARCH_TURNS/u);
  assert.equal(productFreshness.corpusTurnCount, turnCount);
  assert.deepEqual(productFreshness.baseline, {
    sessions: turnCount / 100,
    turns: turnCount,
    ftsDocuments: turnCount,
  });
  assert.equal(productFreshness.append.committed, 1);
  assert.equal(productFreshness.append.commitAckMs !== null, true);
  assert.equal(productFreshness.append.searchResultCount, 1);
  assert.equal(productFreshness.append.appendToSearchableMs <= 2_000, true);
  assert.equal(productFreshness.cleanup.missing, 1);
  assert.equal(productFreshness.cleanup.searchResultCount, 0);
  assert.equal(productFreshness.cleanup.restored, true);
  assert.deepEqual(productFreshness.gate, {
    limitMs: 2_000,
    productPathUsed: true,
    commitAcknowledged: true,
    markerUniquelySearchable: true,
    cleanupRestored: true,
    appendedTurnWithin2Seconds: true,
  });
  assert.deepEqual(report.mutations.verified, {
    replace: true,
    delete: true,
    purge: true,
    expectedRemainingFacts: true,
    projectionCleanup: true,
    replacementSearchable: true,
    boundedChangeLog: true,
    integrity: true,
  });
  assert.equal(report.mutations.corpus.turns, report.corpus.turns);
  assert.equal(report.mutations.corpus.sessions, report.corpus.sessions);
  assert.deepEqual(
    {
      count: report.mutations.queryEquivalence.count,
      pathLimit: report.mutations.queryEquivalence.pathLimit,
      allEqual: report.mutations.queryEquivalence.allEqual,
    },
    { count: 8, pathLimit: 10, allEqual: true },
  );
  assert.equal(report.mutations.queryEquivalence.clockIdentity.equal, true);
  assert.deepEqual(report.mutations.queryEquivalence.coverage, {
    distinctQueryCount: { incremental: 8, cleanRebuild: 8, equal: true },
    resultQueryCount: { incremental: 8, cleanRebuild: 8, equal: true },
    toolPathFamilyQueryCount: { incremental: 8, cleanRebuild: 8, equal: true },
  });
  assert.equal(report.mutations.queryEquivalence.allQueriesExercised, true);
  assert.equal(
    Object.values(report.mutations.queryEquivalence.digests)
      .every(({ incremental, cleanRebuild, equal }) =>
        equal && incremental === cleanRebuild && /^[0-9a-f]{64}$/u.test(incremental)),
    true,
  );
});

test("small ITEM-5 benchmark measures real Rust search with and without Tool paths", {
  timeout: 120_000,
  skip: Number(process.versions.node.split(".")[0]) < 22 || !existsSync(DEBUG_ENGINE_PATH)
    ? "requires Node 22.5+ and a debug Insights Engine build"
    : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-query-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await runInsightsQueryBenchmark({
    turnCount: 600,
    turnsPerSession: 100,
    queryCount: 8,
    warmupCount: 2,
    seed: "query-e2e-test",
    binaryPath: DEBUG_ENGINE_PATH,
    workingDirectory: directory,
  });

  assert.equal(report.format, "threadshare-insights-query-benchmark@v1");
  assert.equal(report.measuredScope, "item-5-rust-search-and-tool-path-query");
  assert.equal(report.corpus.turns, 600);
  assert.deepEqual(report.query.groups.map(({ pathLimit }) => pathLimit), [0, 10]);
  assert.equal(report.query.groups.every(({ resultCount }) => resultCount > 0), true);
  assert.equal(report.query.groups[0].evidencePathFamilyCount, 0);
  assert.equal(report.query.groups[1].insufficientSampleCount, 0);
  assert.equal(report.query.groups[1].evidencePathFamilyCount > 0, true);
  assert.equal(
    report.query.groups.every(({ resultDigest }) => /^[0-9a-f]{64}$/u.test(resultDigest)),
    true,
  );
  assert.equal(report.query.stageAttribution.includes("not falsely separated"), true);
  assert.equal(report.query.storage.detailFullFtsBytes > 0, true);
  assert.equal(report.gates.toolPathWorkloadComplete, true);
  assert.equal(report.gates.allLatencyWithinLimit, true);
  assert.equal(report.gates.queryCountAtLeast1000, false);
  assert.equal(report.gates.allMeasuredQueryGatesPassed, false);
});

test("small raw benchmark crosses discovery, Adapter, worker, Engine, and append freshness", {
  timeout: 120_000,
  skip: Number(process.versions.node.split(".")[0]) < 22 || !existsSync(DEBUG_ENGINE_PATH)
    ? "requires Node 22.5+ and a debug Insights Engine build"
    : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-raw-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await runInsightsRawBackfillBenchmark({
    sessionCount: 4,
    rawTextCharacters: 512,
    seed: "raw-backfill-e2e-test",
    binaryPath: DEBUG_ENGINE_PATH,
    workingDirectory: directory,
  });

  assert.equal(report.format, "threadshare-insights-raw-backfill-benchmark@v1");
  assert.equal(report.measuredScope, "item-4-raw-provider-adapter-worker-engine-backfill");
  assert.equal(report.environment.hostLoad.atStart.oneMinute >= 0, true);
  assert.equal(report.environment.hostLoad.atReport.oneMinute >= 0, true);
  assert.equal(report.corpus.sessions, 4);
  assert.equal(report.corpus.uniqueSessionIds, 4);
  assert.equal(report.corpus.rawBytes > 0, true);
  assert.equal(report.backfill.report.committed, 4);
  assert.equal(report.backfill.report.failed, 0);
  assert.equal(report.backfill.report.cycles >= 1, true);
  assert.deepEqual(report.backfill.report.discoveryDiagnostics, []);
  assert.deepEqual(report.backfill.report.indexDiagnostics, []);
  assert.equal(
    report.backfill.report.discoveredPerCycle.every((count) => count === 4),
    true,
  );
  assert.equal(
    report.backfill.report.uniqueDiscoveredPerCycle.every((count) => count === 4),
    true,
  );
  assert.equal(report.backfill.uniqueCommittedSources, 4);
  assert.equal(report.backfill.latestSessions.committed, 4);
  assert.equal(report.backfill.adapter.count, 4);
  assert.equal(report.backfill.commitAck.count, 4);
  assert.equal(report.backfill.physicalBytesRead >= report.corpus.rawBytes, true);
  assert.equal(report.appendFreshness.productPath, "reconcileActiveInsights");
  assert.equal(report.appendFreshness.report.report.committed, 1);
  assert.deepEqual(report.appendFreshness.report.reasons, ["filesystem"]);
  assert.equal(report.appendFreshness.commitAck.count, 1);
  assert.equal(report.appendFreshness.target.committed, true);
  assert.equal(report.appendFreshness.searchableMatches, 1);
  assert.equal(report.appendFreshness.engineSearchResultCount, 1);
  assert.equal(report.appendFreshness.wallMs <= 2_000, true);
  assert.equal(report.facts.sessions, 4);
  assert.equal(report.facts.turns, 5);
  assert.equal(report.facts.ftsDocuments, 5);
  assert.equal(report.facts.sourceStates, 4);
  assert.equal(report.gates.discoveryComplete, true);
  assert.equal(report.gates.commitComplete, true);
  assert.equal(report.gates.persistedCorpusComplete, true);
  assert.equal(report.gates.rawBackfillCorpusComplete, true);
  assert.equal(report.gates.appendedTurnWithin2Seconds, true);
});
