import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createBenchmarkCorpus,
  createCapacityBenchmarkPlan,
  evaluateCapacityGates,
  evaluateInsightsQueryGates,
  runInsightsCapacityBenchmark,
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
  assert.equal(firstSession.delta.sourceRecords.length, 4 * 9);
  assert.equal(firstSession.delta.evidenceEvents.length, 4 * 9);
  assert.equal(firstSession.delta.turnEvidence.length, 4 * 3);
  assert.equal(firstSession.delta.capabilityUses.length, 4 * 3);
  assert.equal(firstSession.delta.capabilityUseEvidence.length, 4 * 6);
  assert.equal(new Set(firstSession.delta.sourceRecords.map((item) => item.sourceRecordKey)).size, 36);
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
  timeout: 120_000,
  skip: Number(process.versions.node.split(".")[0]) < 22 || !existsSync(DEBUG_ENGINE_PATH)
    ? "requires Node 22.5+ and a debug Insights Engine build"
    : false,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-insights-capacity-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const report = await runInsightsCapacityBenchmark({
    turnCount: 12,
    turnsPerSession: 4,
    queryCount: 8,
    warmupCount: 2,
    seed: "capacity-e2e-test",
    binaryPath: DEBUG_ENGINE_PATH,
    workingDirectory: directory,
  });

  assert.equal(report.format, "threadshare-insights-capacity-benchmark@v1");
  assert.equal(report.measuredScope, "item-4-normalized-fact-fts-projection-capacity");
  assert.equal(report.environment.hostLoad.atStart.oneMinute >= 0, true);
  assert.equal(report.environment.hostLoad.atReport.oneMinute >= 0, true);
  assert.equal(report.corpus.turns, 12);
  assert.equal(report.corpus.density.evidenceEventsPerTurn, 9);
  const audit = report.rustSidecar.capacity;
  assert.equal(audit.rowCounts.turns, 12);
  assert.equal(audit.rowCounts.source_records, 12 * 9);
  assert.equal(audit.rowCounts.evidence_events, 12 * 9);
  assert.equal(audit.rowCounts.capability_uses, 12 * 3);
  assert.equal(audit.rowCounts.turn_fts_documents, 12);
  assert.equal(audit.rowCounts.turn_rollup_contributions >= 12, true);
  assert.equal(audit.ftsMetrics.documents, 12);
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
  assert.equal(audit.gates.allMeasuredCapacityGatesPassed, true);
  assert.equal(audit.engineRss.sidecarPeakBytes, report.rustSidecar.rss.sidecarPeakBytes);
  assert.equal(report.rustSidecar.rss.peakSampled, true);
  const backfill = report.rustSidecar.backfill;
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
  assert.equal(search.gates.toolPathWorkloadComplete, false);
  assert.equal(search.gates.allMeasuredQueryGatesPassed, false);
  assert.equal(report.rustSidecar.startup.emptyDatabase.readyMs >= 0, true);
  const populatedStartup = report.rustSidecar.startup.populatedDatabase;
  assert.equal(populatedStartup.readyMs >= 0, true);
  assert.equal(populatedStartup.statusReadMs >= 0, true);
  assert.equal(
    populatedStartup.readyAndStatusMs >= populatedStartup.readyMs,
    true,
  );
  assert.equal(populatedStartup.status.type, "ENGINE_STATUS");
  assert.equal(populatedStartup.status.snapshotSeq, String(report.corpus.sessions));
  assert.equal(populatedStartup.status.snapshotPending, false);
  assert.equal(BigInt(populatedStartup.status.changeLog.rows) > 0n, true);
  assert.equal(populatedStartup.sampleCount, 3);
  assert.equal(populatedStartup.samples.length, 3);
  assert.equal(populatedStartup.gate.medianReadyUnder500Ms, true);
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
  assert.equal(report.appendFreshness.report.report.committed, 1);
  assert.deepEqual(report.appendFreshness.report.reasons, ["filesystem"]);
  assert.equal(report.appendFreshness.commitAck.count, 1);
  assert.equal(report.appendFreshness.target.committed, true);
  assert.equal(report.appendFreshness.searchableMatches, 1);
  assert.equal(report.facts.sessions, 4);
  assert.equal(report.facts.turns, 5);
  assert.equal(report.facts.ftsDocuments, 5);
  assert.equal(report.facts.sourceStates, 4);
  assert.equal(report.gates.discoveryComplete, true);
  assert.equal(report.gates.commitComplete, true);
  assert.equal(report.gates.persistedCorpusComplete, true);
  assert.equal(report.gates.rawBackfillCorpusComplete, true);
});
