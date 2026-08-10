import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";

import {
  ITEM6_APPROVED_EPIC_SHA256,
  ITEM6_OVERVIEW_EVIDENCE_FORMAT,
  ITEM6_OVERVIEW_MANIFEST_FORMAT,
  ITEM6_OVERVIEW_REPORTS,
  packageDashboardOverviewEvidence,
  validateDashboardOverviewReports,
} from "../scripts/package-insights-dashboard-evidence.mjs";

const execFileAsync = promisify(execFile);
const EPIC_PATH = fileURLToPath(new URL(
  "../.codestable/epics/local-session-insights.md",
  import.meta.url,
));

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identity(overrides = {}) {
  return {
    buildManifestDigest: "a".repeat(64),
    engineVersion: "0.0.0",
    format: "threadshare-insights-engine-version@v1",
    protocolVersion: 1,
    sqliteCompileOptionsDigest: "b".repeat(64),
    sqliteVersion: "3.53.2",
    target: "development",
    binarySha256: "c".repeat(64),
    ...overrides,
  };
}

function capacityGates() {
  return {
    normalizedFactLimitBytes: 6 * 1024 ** 3,
    steadyStateLimitBytes: 8 * 1024 ** 3,
    normalizedFactExceeded: false,
    steadyStateExceeded: false,
    packedFactsRequired: false,
    decision: "normalized-row-v1-within-capacity-gates",
    storageClassificationComplete: true,
    dbstatMatchesPageBytes: true,
    engineRssWithinLimit: true,
    ftsDensityMatchesCorpus: true,
    ftsBackendWithinLimit: true,
    allMeasuredCapacityGatesPassed: true,
    populatedWarmOpenUnder500Ms: true,
    overviewLatencyWithinLimit: true,
  };
}

function categories() {
  return {
    fact: { bytes: 900, rows: 1_000, objects: 61 },
    fts: { bytes: 50, rows: 100, objects: 8 },
    projection: { bytes: 30, rows: 80, objects: 22 },
    sourceState: { bytes: 10, rows: 0, objects: 3 },
    sqliteInternal: { bytes: 5, rows: 0, objects: 1 },
    engineOther: { bytes: 5, rows: 0, objects: 1 },
    unclassified: { bytes: 0, rows: 0, objects: 0 },
  };
}

function startup() {
  return {
    populatedDatabase: {
      readyMs: 4,
      statusReadMs: 20,
      readyAndStatusMs: 24,
      status: { type: "ENGINE_STATUS" },
      sampleCount: 3,
      samples: [
        { readyMs: 3, statusReadMs: 19, readyAndStatusMs: 22 },
        { readyMs: 4, statusReadMs: 20, readyAndStatusMs: 24 },
        { readyMs: 5, statusReadMs: 21, readyAndStatusMs: 26 },
      ],
      gate: { limitMs: 500, medianReadyUnder500Ms: true },
    },
  };
}

function ftsMetrics(turns) {
  return {
    documents: turns,
    fieldTerms: 19,
    postings: turns * 2,
    occurrences: turns * 2,
    byField: [
      { field: "natural", fieldTerms: 10, postings: turns, occurrences: turns },
      { field: "code", fieldTerms: 0, postings: 0, occurrences: 0 },
      { field: "capability", fieldTerms: 9, postings: turns, occurrences: turns },
    ],
    density: {
      natural: {
        minimumFieldTerms: 10,
        minimumPostings: turns,
        actualFieldTerms: 10,
        actualPostings: turns,
        meetsExpectedDensity: true,
      },
      code: {
        expectedPostings: 0,
        actualFieldTerms: 0,
        actualPostings: 0,
        meetsExpectedDensity: true,
      },
      capability: {
        minimumPostings: turns,
        actualFieldTerms: 9,
        actualPostings: turns,
        meetsExpectedDensity: true,
      },
    },
    detailFullBytes: 50,
    backendReevaluationLimitBytes: 400 * 1024 ** 2,
    backendReevaluationRequired: false,
  };
}

function rawReport(turns, {
  sourceRevision = "d".repeat(40),
  benchmarkScriptSha256 = "e".repeat(64),
  engineIdentity = identity(),
} = {}) {
  const longTerm = turns === 250_000;
  const gates = capacityGates();
  const contentDigest = longTerm ? "2".repeat(64) : "1".repeat(64);
  return {
    format: "threadshare-insights-capacity-benchmark@v1",
    sourceRevision,
    sourceWorktreeDirty: false,
    benchmarkScriptSha256,
    environment: {
      platform: "darwin",
      arch: "arm64",
      os: "darwin 25.5.0",
      cpuModel: "Apple M4",
      logicalCpuCount: 10,
      totalMemoryBytes: 32 * 1024 ** 3,
      nodeVersion: "v22.22.2",
      v8Version: "12.4.254.21-node.39",
      hostLoad: {
        atStart: {
          oneMinute: 1,
          fiveMinutes: 2,
          fifteenMinutes: 3,
          oneMinutePerLogicalCpu: 0.1,
        },
        atReport: {
          oneMinute: 2,
          fiveMinutes: 3,
          fifteenMinutes: 4,
          oneMinutePerLogicalCpu: 0.2,
        },
      },
    },
    corpus: {
      corpusVersion: 4,
      seed: longTerm
        ? "threadshare-insights-dashboard-250k-v1"
        : "threadshare-insights-dashboard-25k-v1",
      identityDigest: longTerm ? "4".repeat(64) : "3".repeat(64),
      contentDigest,
      turns,
      sessions: turns / 100,
      turnsPerSession: 100,
      density: {
        sourceRecordsPerTurn: 9,
        evidenceEventsPerTurn: 9,
        turnEvidencePerTurn: 3,
        capabilityUsesPerTurn: 3,
        capabilityUseEvidencePerTurn: 6,
        capabilitiesPerProvider: 12,
        naturalTermsPerTurn: 135,
        uniqueNaturalTermsPerTurn: 6,
        problemTextCharacters: 1_600,
        finalAnswerCharacters: 1_100,
      },
      canonicalBytes: turns * 1_000,
      maxSessionCanonicalBytes: 100_000,
      boundedMemoryModel: "one generated SessionFactsDeltaV1 plus one protocol batch",
    },
    measuredScope: "item-4-normalized-fact-fts-projection-capacity",
    mutations: null,
    notMeasured: ["raw provider parsing is outside this capacity fixture"],
    packedFactsDecision: { ...gates },
    rustSidecar: {
      engine: "rust-sidecar",
      engineIdentity: { ...engineIdentity },
      engineVersion: engineIdentity.engineVersion,
      target: engineIdentity.target,
      sqliteVersion: engineIdentity.sqliteVersion,
      corpusDigest: contentDigest,
      canonicalBytes: turns * 1_000,
      maxSessionCanonicalBytes: 100_000,
      startup: startup(),
      overview: {
        measurement: "Rust sidecar READ_INSIGHTS_OVERVIEW over transactional rollups",
        measuredRequestCount: 1_000,
        warmupRequestCount: 100,
        totalRequestCount: 1_100,
        requestIdRange: { first: "2000000", last: "2001099" },
        payloadDigest: longTerm ? "6".repeat(64) : "5".repeat(64),
        payloadMismatchCount: 0,
        snapshotMismatchCount: 0,
        roundTripMs: {
          unit: "ms",
          count: 1_000,
          total: longTerm ? 12_000 : 2_000,
          p50: longTerm ? 12 : 2,
          p95: longTerm ? 15 : 3,
          p99: longTerm ? 18 : 4,
          max: longTerm ? 25 : 5,
        },
        gates: {
          budget: longTerm ? "long-term-250k" : "current-25k",
          p95LimitMs: longTerm ? 200 : 100,
          p99LimitMs: longTerm ? 500 : 250,
          p95WithinLimit: true,
          p99WithinLimit: true,
          withinLimit: true,
          requestsComplete: true,
          snapshotStable: true,
          payloadStable: true,
          allMeasuredOverviewGatesPassed: true,
        },
      },
      capacity: {
        measurement: "pre-maintenance persistent peak plus bounded staging for the 8 GiB gate; VACUUM then dbstat for category attribution",
        preVacuumPersistentBytes: 1_100,
        postVacuumPersistentBytes: 1_000,
        compactedSteadyStateBytes: 101_000,
        observedDerivedStatePeakBytes: 101_100,
        databasePageBytes: 1_000,
        dbstatBytes: 1_000,
        dbstatAccountedPageBytes: 1_000,
        fileFormatPages: {
          lockBytePageBytes: 0,
          freelistBytes: 0,
          totalBytes: 0,
        },
        integrity: ["ok"],
        foreignKeyViolations: 0,
        unclassifiedObjects: [],
        categories: categories(),
        ftsMetrics: ftsMetrics(turns),
        engineRss: {
          limitBytes: longTerm ? 128 * 1024 ** 2 : 96 * 1024 ** 2,
          sidecarPeakBytes: 50 * 1024 ** 2,
          nodeHarnessPeakBytes: 160 * 1024 ** 2,
          combinedPeakBytes: 210 * 1024 ** 2,
          withinLimit: true,
        },
        gates: { ...gates },
      },
    },
  };
}

function reportIdentity(report) {
  const bytes = Buffer.from(`${JSON.stringify(report)}\n`);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

function fixture(overrides = {}) {
  const sourceRevision = overrides.sourceRevision ?? "d".repeat(40);
  const benchmarkScriptSha256 = overrides.benchmarkScriptSha256 ?? "e".repeat(64);
  const packagerScriptSha256 = overrides.packagerScriptSha256 ?? "f".repeat(64);
  const engineIdentity = overrides.engineIdentity ?? identity();
  const reports = {
    25_000: rawReport(25_000, { sourceRevision, benchmarkScriptSha256, engineIdentity }),
    250_000: rawReport(250_000, { sourceRevision, benchmarkScriptSha256, engineIdentity }),
  };
  return {
    reports,
    expected: {
      sourceRevision,
      benchmarkScriptSha256,
      packagerScriptSha256,
      approvedEpicSha256: ITEM6_APPROVED_EPIC_SHA256,
      engineIdentity,
      sourceReports: {
        25_000: reportIdentity(reports[25_000]),
        250_000: reportIdentity(reports[250_000]),
      },
    },
  };
}

test("Dashboard evidence validation rejects identity, scale, gate, and privacy bypasses", () => {
  const valid = fixture();
  const evidence = validateDashboardOverviewReports(valid.reports, valid.expected);
  assert.equal(evidence[25_000].format, ITEM6_OVERVIEW_EVIDENCE_FORMAT);
  assert.equal(evidence[250_000].overview.roundTripMs.p95, 15);
  assert.equal(evidence[250_000].capacity.categories.fact.bytes, 900);
  assert.equal(evidence[250_000].capacity.ftsMetrics.documents, 250_000);
  assert.equal(evidence[250_000].startup.populatedDatabase.readyMs, 4);
  assert.deepEqual(evidence[250_000].notMeasured, [
    "raw provider parsing is outside this capacity fixture",
  ]);

  const postVacuumPeak = fixture();
  for (const report of Object.values(postVacuumPeak.reports)) {
    report.rustSidecar.capacity.preVacuumPersistentBytes = 900;
    report.rustSidecar.capacity.observedDerivedStatePeakBytes = 101_000;
  }
  assert.doesNotThrow(() => validateDashboardOverviewReports(
    postVacuumPeak.reports,
    postVacuumPeak.expected,
  ));

  const mutations = [
    ["dirty source", ({ reports }) => { reports[25_000].sourceWorktreeDirty = true; }],
    ["wrong revision", ({ reports }) => { reports[250_000].sourceRevision = "0".repeat(40); }],
    ["wrong scale", ({ reports }) => { reports[250_000].corpus.turns = 249_999; }],
    ["wrong seed", ({ reports }) => { reports[25_000].corpus.seed = "drift"; }],
    ["wrong request count", ({ reports }) => { reports[25_000].rustSidecar.overview.measuredRequestCount = 999; }],
    ["payload mismatch", ({ reports }) => { reports[25_000].rustSidecar.overview.payloadMismatchCount = 1; }],
    ["false Overview gate", ({ reports }) => { reports[25_000].rustSidecar.overview.gates.payloadStable = false; }],
    ["false capacity gate", ({ reports }) => {
      reports[250_000].rustSidecar.capacity.gates.ftsBackendWithinLimit = false;
      reports[250_000].packedFactsDecision.ftsBackendWithinLimit = false;
    }],
    ["missing FTS measurements", ({ reports }) => {
      delete reports[25_000].rustSidecar.capacity.ftsMetrics;
    }],
    ["FTS density contradicts gate", ({ reports }) => {
      reports[25_000].rustSidecar.capacity.ftsMetrics.density.natural.actualPostings = 0;
    }],
    ["missing populated startup measurements", ({ reports }) => {
      delete reports[250_000].rustSidecar.startup.populatedDatabase;
    }],
    ["warm-open sample contradicts median", ({ reports }) => {
      reports[250_000].rustSidecar.startup.populatedDatabase.readyMs = 499;
    }],
    ["empty notMeasured", ({ reports }) => { reports[25_000].notMeasured = []; }],
    ["capacity arithmetic drift", ({ reports }) => { reports[25_000].rustSidecar.capacity.compactedSteadyStateBytes += 1; }],
    ["threshold drift", ({ reports }) => { reports[250_000].rustSidecar.overview.gates.p95LimitMs = 201; }],
    ["private environment value", ({ reports }) => { reports[25_000].environment.cpuModel = "/tmp/private/session.jsonl"; }],
    ["script drift", ({ reports }) => { reports[250_000].benchmarkScriptSha256 = "9".repeat(64); }],
    ["Engine drift", ({ reports }) => { reports[250_000].rustSidecar.engineIdentity.binarySha256 = "8".repeat(64); }],
    ["selected Engine drift", ({ expected }) => { expected.engineIdentity.binarySha256 = "7".repeat(64); }],
  ];
  for (const [name, mutate] of mutations) {
    const candidate = fixture();
    mutate(candidate);
    assert.throws(
      () => validateDashboardOverviewReports(candidate.reports, candidate.expected),
      undefined,
      name,
    );
  }

  const epicDrift = fixture();
  epicDrift.expected.approvedEpicSha256 = "0".repeat(64);
  assert.throws(
    () => validateDashboardOverviewReports(epicDrift.reports, epicDrift.expected),
  );
});

test("Dashboard packager validates before atomically installing deterministic aggregate evidence", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-item6-evidence-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const benchmarkPath = path.join(repository, "scripts", "benchmark-insights-engine.mjs");
  const enginePath = path.join(root, "threadshare-insights-engine");
  const report25kPath = path.join(root, "capacity-25k.json");
  const report250kPath = path.join(root, "capacity-250k.json");
  const invalidPath = path.join(root, "invalid-25k.json");
  const output = path.join(root, "evidence-a");
  const outputSecond = path.join(root, "evidence-b");
  const failedOutput = path.join(root, "failed-evidence");
  await mkdir(path.dirname(benchmarkPath), { recursive: true });
  const benchmarkBytes = Buffer.from("// deterministic Dashboard benchmark fixture\n");
  await writeFile(benchmarkPath, benchmarkBytes);
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", [
    "-c", "user.name=Threadshare Test",
    "-c", "user.email=test@example.invalid",
    "commit", "-qm", "fixture",
  ], { cwd: repository });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository });
  const sourceRevision = stdout.trim();
  const benchmarkScriptSha256 = sha256(benchmarkBytes);
  await writeFile(benchmarkPath, "// dirty packaging worktree must not change source evidence\n");
  const versionDocument = Object.fromEntries(
    Object.entries(identity()).filter(([key]) => key !== "binarySha256"),
  );
  await writeFile(
    enginePath,
    `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(versionDocument)}'\n`,
  );
  await chmod(enginePath, 0o755);
  const engineIdentity = {
    ...versionDocument,
    binarySha256: sha256(await readFile(enginePath)),
  };
  const reports = {
    25_000: rawReport(25_000, { sourceRevision, benchmarkScriptSha256, engineIdentity }),
    250_000: rawReport(250_000, { sourceRevision, benchmarkScriptSha256, engineIdentity }),
  };
  await writeFile(report25kPath, `${JSON.stringify(reports[25_000])}\n`);
  await writeFile(report250kPath, `${JSON.stringify(reports[250_000])}\n`);
  const invalid = structuredClone(reports[25_000]);
  invalid.rustSidecar.capacity.gates.allMeasuredCapacityGatesPassed = false;
  await writeFile(invalidPath, `${JSON.stringify(invalid)}\n`);

  await assert.rejects(packageDashboardOverviewEvidence({
    report25kPath: invalidPath,
    report250kPath,
    outputDirectory: failedOutput,
    enginePath,
    epicPath: EPIC_PATH,
    repositoryRoot: repository,
  }));
  await assert.rejects(readdir(failedOutput), { code: "ENOENT" });

  const manifest = await packageDashboardOverviewEvidence({
    report25kPath,
    report250kPath,
    outputDirectory: output,
    enginePath,
    epicPath: EPIC_PATH,
    repositoryRoot: repository,
  });
  await packageDashboardOverviewEvidence({
    report25kPath,
    report250kPath,
    outputDirectory: outputSecond,
    enginePath,
    epicPath: EPIC_PATH,
    repositoryRoot: repository,
  });
  assert.equal(manifest.format, ITEM6_OVERVIEW_MANIFEST_FORMAT);
  assert.equal(manifest.sourceRevision, sourceRevision);
  assert.equal(
    manifest.scripts["scripts/benchmark-insights-engine.mjs"].sha256,
    benchmarkScriptSha256,
  );
  assert.equal(
    manifest.scripts["scripts/package-insights-dashboard-evidence.mjs"].sha256,
    sha256(await readFile(fileURLToPath(new URL(
      "../scripts/package-insights-dashboard-evidence.mjs",
      import.meta.url,
    )))),
  );
  const packaged25k = JSON.parse(await readFile(
    path.join(output, ITEM6_OVERVIEW_REPORTS[0]),
    "utf8",
  ));
  assert.equal(
    packaged25k.packagerScriptSha256,
    manifest.scripts["scripts/package-insights-dashboard-evidence.mjs"].sha256,
  );
  assert.deepEqual(
    (await readdir(output)).sort(),
    [...ITEM6_OVERVIEW_REPORTS, "manifest.json"].sort(),
  );
  for (const name of [...ITEM6_OVERVIEW_REPORTS, "manifest.json"]) {
    assert.deepEqual(await readFile(path.join(output, name)), await readFile(path.join(outputSecond, name)));
  }
  assert.equal(packaged25k.format, ITEM6_OVERVIEW_EVIDENCE_FORMAT);
  assert.equal(packaged25k.sourceReport.sha256, sha256(await readFile(report25kPath)));
  assert.equal(JSON.stringify(packaged25k).includes("requestIdRange"), false);
  assert.equal(JSON.stringify(packaged25k).includes("byObject"), false);
});
