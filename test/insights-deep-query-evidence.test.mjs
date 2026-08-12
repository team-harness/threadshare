import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import {
  cp,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DEEP_QUERY_DEFERRED_RUNS,
  DEEP_QUERY_DEFERRED_SYNTHETIC_TURNS,
  DEEP_QUERY_REPORTS,
  packageDeepQueryEvidence,
  validateDeepQueryEvidenceReports,
  verifyDeepQueryEvidenceDirectory,
} from "../scripts/package-insights-deep-query-evidence.mjs";

const REVISION = "a".repeat(40);
const RECIPE_NAMES = [
  "activity-shifts@1",
  "capability-contexts@1",
  "failure-chains@1",
  "file-workflow-signals@1",
  "session-timeline@1",
  "solution-recall@1",
  "token-hotspots@1",
];
const SOURCE_FILES = new Map([
  ["scripts/benchmark-insights-engine.mjs", Buffer.from("synthetic benchmark\n")],
  ["scripts/package-insights-deep-query-evidence.mjs", Buffer.from("packager\n")],
  ["docs/insights-deep-query-design.md", Buffer.from("accepted design\n")],
]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function identity() {
  return {
    format: "threadshare-insights-engine-version@v1",
    protocolVersion: 1,
    engineVersion: "0.8.0",
    target: "darwin-arm64",
    sqliteVersion: "3.53.2",
    buildManifestDigest: "b".repeat(64),
    sqliteCompileOptionsDigest: "c".repeat(64),
    binarySha256: "d".repeat(64),
  };
}

function latency(count, p95 = 10, p99 = 12) {
  return {
    unit: "ms",
    count,
    total: count * 15,
    p50: 5,
    p95,
    p99,
    max: 15,
  };
}

function syntheticStorage() {
  return {
    canonicalIndexedSourceBytes: 1_000_000,
    preVacuum: { databaseBytes: 1_600_000, walBytes: 0, shmBytes: 0 },
    postVacuum: { databaseBytes: 1_500_000, walBytes: 0, shmBytes: 0 },
    persistentBytes: 1_500_000,
    stagingUpperBoundBytes: 10_000,
    historyEventMetadataBytes: 200_000,
    historyPayloadBytes: 600_000,
    historyFtsBytes: 500_000,
    projectionBytes: 100_000,
    searchablePayloadBytes: 1_000_000,
    storedNotSearchablePayloadBytes: 50_000,
    persistentStorageAmplification: 1.5,
    historyFtsAmplification: 0.5,
    limits: {
      persistentStorageAmplification: 1.8,
      historyFtsAmplification: 0.7,
    },
  };
}

function syntheticReport(turns) {
  const sessions = turns / 100;
  const budget = turns === 25_000 ? "current-25k" : "long-term-250k";
  const recipe = Object.fromEntries(RECIPE_NAMES.map((name) => [name, {
    emptyResultCount: 0,
    roundTripMs: latency(100),
  }]));
  return {
    format: "threadshare-insights-deep-query-benchmark@v1",
    measuredScope: "local-insights-fact-v2-deep-query-capacity-and-performance",
    sourceRevision: REVISION,
    sourceWorktreeDirty: false,
    benchmarkScriptSha256: sha256(SOURCE_FILES.get("scripts/benchmark-insights-engine.mjs")),
    corpus: {
      corpusVersion: 7,
      seed: `threadshare-insights-deep-query-${turns === 25_000 ? "25k" : "250k"}-v1`,
      turns,
      sessions,
      turnsPerSession: 100,
      canonicalBytes: 1_000_000,
      density: {
        historyEventsPerTurn: 10,
        historyPayloadsPerTurn: 8,
        historyPayloadChunksPerTurn: 8,
        evidencePagingProbeEvents: 1,
        evidencePagingProbePayloads: 1,
        evidencePagingProbeChunks: 32,
      },
    },
    engineIdentity: identity(),
    backfill: {
      wallMs: 1_000,
      commitAckMs: latency(sessions),
    },
    protocol: { requestFrames: sessions * 3 },
    rss: {
      samplingMode: "darwin-500ms",
      peakSampled: true,
      sidecarPeakBytes: 64 * 1024 * 1024,
      nodeHarnessPeakBytes: 96 * 1024 * 1024,
      combinedPeakBytes: 160 * 1024 * 1024,
    },
    deepQuery: {
      measuredRequestCount: 100,
      warmupRequestCount: 20,
      records: { emptyResultCount: 0, roundTripMs: latency(100) },
      aggregate: { emptyResultCount: 0, roundTripMs: latency(100) },
      recipes: recipe,
      evidence: {
        targetPayloadBytes: 2 * 1024 * 1024,
        completedReadCount: 100,
        multiPageReadCount: 100,
        returnedBytes: 200 * 1024 * 1024,
        firstPageRoundTripMs: latency(100),
        pageRoundTripMs: latency(300),
        readWallMs: 1_000,
        payloadMiBPerSecond: 200,
      },
      resultDigest: "e".repeat(64),
      gates: {
        budget,
        recordsWithinLimit: true,
        aggregateWithinLimit: true,
        evidenceFirstPageWithinLimit: true,
        evidencePagingAtLeast50MiBPerSecond: true,
        allRecordsReturnedResults: true,
        allAggregatesReturnedGroups: true,
        allRecipesExercised: true,
        allRecipesWithinLimit: true,
        allEvidenceReadsCompleted: true,
        allDeepQueryPathsExercised: true,
        allMeasuredDeepQueryGatesPassed: true,
      },
    },
    storage: syntheticStorage(),
    rowCounts: {
      history_events: turns * 10 + 1,
      history_payloads: turns * 8 + 1,
      history_payload_chunks: turns * 8 + 32,
      attempt_chain_events: turns,
      file_activity: turns,
      token_usage: turns,
      error_occurrences: turns,
      history_event_fts_documents: turns * 8,
    },
    explain: {
      recordsByEventKind: ["SEARCH he USING INDEX history_events_kind_order"],
    },
    gates: {
      v2CorpusComplete: true,
      deepQueryPathsComplete: true,
      deepQueryPerformanceWithinLimit: true,
      historyFtsIntegrityPassed: true,
      engineRssWithin128MiB: true,
      storageAmplificationWithinLimit: true,
      historyFtsAmplificationWithinLimit: true,
      storageClassificationComplete: true,
      queryPlanUsesEventKindIndex: true,
      allMeasuredDeepQueryEvidenceGatesPassed: true,
    },
    notMeasured: ["raw provider parsing is covered by the real sample"],
  };
}

function reports() {
  return {
    [DEEP_QUERY_REPORTS[0]]: syntheticReport(25_000),
  };
}

async function writeReports(directory, values = reports()) {
  await mkdir(directory, { recursive: true });
  for (const file of DEEP_QUERY_REPORTS) {
    await writeFile(path.join(directory, file), `${JSON.stringify(values[file], null, 2)}\n`);
  }
}

async function readSourceFile(_root, revision, file) {
  assert.equal(revision, REVISION);
  const bytes = SOURCE_FILES.get(file);
  if (bytes === undefined) throw new Error(`missing fixture source ${file}`);
  return bytes;
}

async function createPackagedEvidence(root) {
  const input = path.join(root, "input");
  const output = path.join(root, "evidence");
  await writeReports(input);
  await packageDeepQueryEvidence({
    inputDirectory: input,
    outputDirectory: output,
    repositoryRoot: root,
    readSourceIdentity: async () => REVISION,
    readSourceFile,
  });
  return { input, output };
}

async function mutateArtifact(directory, file, mutate) {
  const artifactPath = path.join(directory, file);
  const value = JSON.parse(await readFile(artifactPath, "utf8"));
  mutate(value);
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(artifactPath, bytes);
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
  const artifact = { bytes: bytes.length, sha256: sha256(bytes) };
  manifest.artifacts[file] = artifact;
  manifest.sourceReports[file] = artifact;
  await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
}

async function withFixture(run) {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-deep-query-evidence-"));
  try {
    return await run(root);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

test("Deep Query evidence packager preserves raw reports and verifies historical provenance", async () => {
  await withFixture(async (root) => {
    const { input, output } = await createPackagedEvidence(root);
    assert.equal(await verifyDeepQueryEvidenceDirectory({
      directory: output,
      repositoryRoot: root,
      readSourceFile,
    }), 1);
    assert.deepEqual(
      (await readdir(output)).sort(),
      ["manifest.json", ...DEEP_QUERY_REPORTS].sort(),
    );
    for (const file of DEEP_QUERY_REPORTS) {
      assert.deepEqual(await readFile(path.join(output, file)), await readFile(path.join(input, file)));
      assert.equal((await stat(path.join(output, file))).mode & 0o777, 0o600);
    }
    const manifest = JSON.parse(await readFile(path.join(output, "manifest.json"), "utf8"));
    assert.deepEqual(manifest.formalConfiguration.syntheticTurns, [25_000]);
    assert.deepEqual(
      manifest.formalConfiguration.deferredSyntheticTurns,
      DEEP_QUERY_DEFERRED_SYNTHETIC_TURNS,
    );
    assert.deepEqual(manifest.formalConfiguration.deferredRuns, DEEP_QUERY_DEFERRED_RUNS);
    assert.equal(manifest.formalConfiguration.deferredRealSampleFraction, 0.30);
  });
});

test("Deep Query evidence rejects rehashed metric and coverage bypasses", async (context) => {
  const cases = [
    ["records P95", DEEP_QUERY_REPORTS[0], (value) => {
      value.deepQuery.records.roundTripMs.p95 = 100;
      value.deepQuery.records.roundTripMs.p99 = 100;
      value.deepQuery.records.roundTripMs.max = 100;
    }],
    ["empty Recipe", DEEP_QUERY_REPORTS[0], (value) => {
      value.deepQuery.recipes["solution-recall@1"].emptyResultCount = 100;
    }],
    ["slow Recipe", DEEP_QUERY_REPORTS[0], (value) => {
      value.deepQuery.recipes["solution-recall@1"].roundTripMs.p95 = 500;
      value.deepQuery.recipes["solution-recall@1"].roundTripMs.p99 = 1_000;
      value.deepQuery.recipes["solution-recall@1"].roundTripMs.max = 1_000;
      value.deepQuery.recipes["solution-recall@1"].roundTripMs.total = 100_000;
    }],
    ["Evidence throughput", DEEP_QUERY_REPORTS[0], (value) => {
      value.deepQuery.evidence.payloadMiBPerSecond = 49.99;
    }],
    ["storage amplification", DEEP_QUERY_REPORTS[0], (value) => {
      value.storage.persistentBytes = 1_900_000;
      value.storage.postVacuum.databaseBytes = 1_900_000;
      value.storage.persistentStorageAmplification = 1.9;
    }],
  ];
  for (const [name, file, mutate] of cases) {
    await context.test(name, async () => {
      await withFixture(async (root) => {
        const { output } = await createPackagedEvidence(root);
        await mutateArtifact(output, file, mutate);
        await assert.rejects(() => verifyDeepQueryEvidenceDirectory({
          directory: output,
          repositoryRoot: root,
          readSourceFile,
        }));
      });
    });
  }
});

test("Deep Query evidence rejects provenance, file-set, and private-shape drift", async (context) => {
  await context.test("script provenance", async () => {
    await withFixture(async (root) => {
      const { output } = await createPackagedEvidence(root);
      const manifestPath = path.join(output, "manifest.json");
      const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
      manifest.scripts["scripts/benchmark-insights-engine.mjs"].sha256 = "0".repeat(64);
      await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
      await assert.rejects(() => verifyDeepQueryEvidenceDirectory({
        directory: output,
        repositoryRoot: root,
        readSourceFile,
      }), /script provenance/u);
    });
  });
  await context.test("deferred 250k report", async () => {
    await withFixture(async (root) => {
      const { output } = await createPackagedEvidence(root);
      await writeFile(path.join(output, "deep-query-250k.acceptance.json"), "{}\n");
      await assert.rejects(() => verifyDeepQueryEvidenceDirectory({
        directory: output,
        repositoryRoot: root,
        readSourceFile,
      }), /file set/u);
    });
  });
  await context.test("extra file", async () => {
    await withFixture(async (root) => {
      const { output } = await createPackagedEvidence(root);
      await writeFile(path.join(output, "raw-session.json"), "{}\n");
      await assert.rejects(() => verifyDeepQueryEvidenceDirectory({
        directory: output,
        repositoryRoot: root,
        readSourceFile,
      }), /file set/u);
    });
  });
  await context.test("private-shaped value", async () => {
    await withFixture(async (root) => {
      const { output } = await createPackagedEvidence(root);
      await mutateArtifact(output, DEEP_QUERY_REPORTS[0], (value) => {
        value.environment = { sourcePath: "/Users/private/session.jsonl" };
      });
      await assert.rejects(() => verifyDeepQueryEvidenceDirectory({
        directory: output,
        repositoryRoot: root,
        readSourceFile,
      }), /forbidden/u);
    });
  });
});

test("Deep Query report validation rejects a dirty or cross-build report set", () => {
  const dirty = reports();
  dirty[DEEP_QUERY_REPORTS[0]].sourceWorktreeDirty = true;
  assert.throws(() => validateDeepQueryEvidenceReports(dirty), /clean tree/u);

});

test("Deep Query verifier requires the deferred 250k disclosure", async () => {
  await withFixture(async (root) => {
    const { output } = await createPackagedEvidence(root);
    const manifestPath = path.join(output, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.formalConfiguration.deferredSyntheticTurns = [];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(() => verifyDeepQueryEvidenceDirectory({
      directory: output,
      repositoryRoot: root,
      readSourceFile,
    }), /formal configuration drifted/u);
  });
});

test("Deep Query verifier requires deferred real-sample disclosure", async () => {
  await withFixture(async (root) => {
    const { output } = await createPackagedEvidence(root);
    const manifestPath = path.join(output, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
    manifest.formalConfiguration.deferredRuns = [];
    await writeFile(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    await assert.rejects(() => verifyDeepQueryEvidenceDirectory({
      directory: output,
      repositoryRoot: root,
      readSourceFile,
    }), /formal configuration drifted/u);
  });
});
