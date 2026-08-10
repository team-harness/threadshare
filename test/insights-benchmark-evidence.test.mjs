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
  ITEM5_FORMAL_REPORTS,
  assertAggregateArtifactPrivacy,
  packageFormalEvidence,
  validateFormalEvidenceReports,
} from "../scripts/package-insights-benchmark-evidence.mjs";

const execFileAsync = promisify(execFile);
const FIXTURE_PATH = fileURLToPath(new URL(
  "./fixtures/insights-query-evaluation.v2.json",
  import.meta.url,
));
const EPIC_PATH = fileURLToPath(new URL(
  "../.codestable/epics/local-session-insights.md",
  import.meta.url,
));
const SCRIPT_FILES = [
  "scripts/benchmark-insights-engine.mjs",
  "scripts/benchmark-insights-real-sample.mjs",
  "scripts/insights-query-evaluation.mjs",
  "scripts/package-insights-benchmark-evidence.mjs",
  "scripts/run-insights-query-quality.mjs",
];

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function engineIdentity(binarySha256 = "b".repeat(64), overrides = {}) {
  return {
    format: "threadshare-insights-engine-version@v1",
    engineVersion: "0.6.1",
    protocolVersion: 1,
    target: "darwin-arm64",
    sqliteVersion: "3.53.2",
    sqliteCompileOptionsDigest: "c".repeat(64),
    buildManifestDigest: "d".repeat(64),
    binarySha256,
    ...overrides,
  };
}

function scriptHashes(values = Object.fromEntries(SCRIPT_FILES.map((file) => [file, file]))) {
  return Object.fromEntries(SCRIPT_FILES.map((file) => {
    const bytes = Buffer.from(values[file]);
    return [file, { bytes: bytes.length, sha256: sha256(bytes) }];
  }));
}

function dedupeCounts(overrides = {}) {
  return {
    rawSessions: 12,
    eligibleMainSessions: 10,
    independentGroups: 4,
    strongGroups: 1,
    weakGroups: 3,
    observedEofProvisionalGroups: 2,
    unknownSessions: 2,
    ...overrides,
  };
}

function mutationQueryEquivalence(overrides = {}) {
  const digest = (character) => character.repeat(64);
  return {
    count: 100,
    pathLimit: 10,
    clockIdentity: {
      incremental: digest("1"),
      cleanRebuild: digest("1"),
      equal: true,
    },
    coverage: {
      distinctQueryCount: { incremental: 100, cleanRebuild: 100, equal: true },
      resultQueryCount: { incremental: 100, cleanRebuild: 100, equal: true },
      toolPathFamilyQueryCount: { incremental: 100, cleanRebuild: 100, equal: true },
    },
    digests: {
      candidateTurnKeys: {
        incremental: digest("2"),
        cleanRebuild: digest("2"),
        equal: true,
      },
      resultTurnOrder: {
        incremental: digest("3"),
        cleanRebuild: digest("3"),
        equal: true,
      },
      toolPathFamilies: {
        incremental: digest("4"),
        cleanRebuild: digest("4"),
        equal: true,
      },
    },
    allQueriesExercised: true,
    allEqual: true,
    ...overrides,
  };
}

function formalReports({
  sourceRevision = "a".repeat(40),
  identity = engineIdentity(),
  scripts = scriptHashes(),
} = {}) {
  const execution = {
    sourceRevision,
    sourceWorktreeDirty: false,
    runnerScriptSha256: scripts["scripts/run-insights-query-quality.mjs"].sha256,
    engine: identity,
  };
  const capacity = (turns, seed) => ({
    format: "threadshare-insights-query-benchmark@v1",
    sourceRevision,
    sourceWorktreeDirty: false,
    benchmarkScriptSha256: scripts["scripts/benchmark-insights-engine.mjs"].sha256,
    engineIdentity: identity,
    corpus: { turns, turnsPerSession: 100, seed },
    query: {
      groups: [0, 10].map((pathLimit) => ({ pathLimit, queryCount: 1_000, warmupCount: 100 })),
    },
    gates: { acceptanceCorpusExact: true, allMeasuredQueryGatesPassed: true },
    formalEvidenceGates: {
      queryGatesPassed: true,
      capacityGatesPassed: true,
      populatedStartupPassed: true,
      mutationTracePassed: true,
      allFormalEvidenceGatesPassed: true,
    },
    formalEvidenceContext: {
      startup: { populatedDatabase: { gate: { medianReadyUnder500Ms: true } } },
      capacityGates: { allMeasuredCapacityGatesPassed: true },
      mutations: {
        corpus: { turns, sessions: turns / 100 },
        verified: {
          replace: true,
          delete: true,
          purge: true,
          expectedRemainingFacts: true,
          projectionCleanup: true,
          replacementSearchable: true,
          boundedChangeLog: true,
          integrity: true,
        },
        ...(turns === 25_000
          ? { queryEquivalence: mutationQueryEquivalence() }
          : {}),
      },
    },
  });
  return {
    "capacity-25k-query.acceptance.json": capacity(25_000, "threadshare-insights-query-25k-v1"),
    "capacity-250k-query.acceptance.json": capacity(250_000, "threadshare-insights-query-250k-v1"),
    "quality.acceptance.json": {
      format: "threadshare-insights-query-quality-report@v1",
      dataset: "real-acceptance",
      source: "current-conversation-user-prompts",
      split: "evaluation",
      queryCount: 60,
      qrelDigest: "5d45b38259b63c009a0554edbd01cfeb87580fd9ada0d0110488ce8b09ee31fd",
      gates: {
        candidateRecallAt300: { threshold: 0.90, passed: true },
        top20Recall: { threshold: 0.85, passed: true },
        ndcgAt10: { threshold: 0.75, passed: true },
      },
      execution,
    },
    "ablation.acceptance.json": {
      format: "threadshare-insights-query-ablation-report@v1",
      dataset: "review-development",
      provenance: "review-derived-deidentified-development",
      source: "pre-item5-independent-design-and-contract-review-findings",
      split: "development",
      queryCount: 30,
      qrelDigest: "16b1d360903a51197d78e45e4973df26aa60fec149f0cdf49a469accaeb60b5f",
      execution: {
        ...execution,
        ablationScope: "fixed-production-candidates-rerank-only",
        candidateGenerationRerunPerVariant: false,
        developmentSetKind: "review-derived-deidentified-disjoint",
      },
    },
    "candidate-25k.acceptance.json": {
      format: "threadshare-insights-candidate-recall-scale@v1",
      queryCount: 60,
      qrelDigest: "5d45b38259b63c009a0554edbd01cfeb87580fd9ada0d0110488ce8b09ee31fd",
      indexedTurnCount: 25_060,
      distractorTurnCount: 25_000,
      allGatesPassed: true,
      execution: {
        ...execution,
        candidateScale: {
          seed: "threadshare-item5-candidate-scale-v1",
          submittedDeltaDigest: "e".repeat(64),
        },
      },
    },
    "real-sample-30pct.acceptance.json": {
      format: "threadshare-insights-real-sample-benchmark@v1",
      sourceRevision,
      sourceWorktreeDirty: false,
      hashes: {
        benchmarkScriptSha256: scripts["scripts/benchmark-insights-real-sample.mjs"].sha256,
        engineBinarySha256: identity.binarySha256,
        selectedSnapshotContentDigest: "f".repeat(64),
      },
      engine: Object.fromEntries(Object.entries(identity).filter(([key]) => key !== "binarySha256")),
      sampling: { fraction: 0.30, seed: "threadshare-insights-real-sample-v1" },
      dedupe: {
        definitions: "provisional is an overlapping closure axis",
        overall: dedupeCounts(),
        byProvider: { claude: dedupeCounts(), codex: dedupeCounts() },
      },
      gates: {
        detailFullFtsWithinLimit: true,
        ftsIntegrityCheckPassed: true,
        dedupeCountsConsistent: true,
        allMeasuredGatesPassed: true,
      },
    },
  };
}

test("formal evidence validation rejects every acceptance bypass", () => {
  const scripts = scriptHashes();
  const identity = engineIdentity();
  const expected = {
    sourceRevision: "a".repeat(40),
    engineBinarySha256: identity.binarySha256,
    engineIdentity: identity,
    scriptHashes: scripts,
  };
  assert.equal(validateFormalEvidenceReports(formalReports({ identity, scripts }), expected), true);

  const mutations = [
    ["false formal gate", (reports) => {
      reports["capacity-25k-query.acceptance.json"].gates.allMeasuredQueryGatesPassed = false;
    }],
    ["wrong exact scale", (reports) => {
      reports["capacity-250k-query.acceptance.json"].corpus.turns = 249_999;
    }],
    ["wrong seed", (reports) => {
      reports["capacity-25k-query.acceptance.json"].corpus.seed = "drift";
    }],
    ["missing warmup", (reports) => {
      reports["capacity-25k-query.acceptance.json"].query.groups[0].warmupCount = 99;
    }],
    ["missing measured query", (reports) => {
      reports["capacity-25k-query.acceptance.json"].query.groups[1].queryCount = 999;
    }],
    ["duplicate path mode", (reports) => {
      reports["capacity-25k-query.acceptance.json"].query.groups[1].pathLimit = 0;
    }],
    ["missing path mode", (reports) => {
      delete reports["capacity-25k-query.acceptance.json"].query.groups[1].pathLimit;
    }],
    ["string path mode", (reports) => {
      reports["capacity-25k-query.acceptance.json"].query.groups[0].pathLimit = "0";
    }],
    ["non-object query group", (reports) => {
      reports["capacity-25k-query.acceptance.json"].query.groups[0] = null;
    }],
    ["missing query count", (reports) => {
      delete reports["capacity-25k-query.acceptance.json"].query.groups[0].queryCount;
    }],
    ["string query count", (reports) => {
      reports["capacity-25k-query.acceptance.json"].query.groups[0].queryCount = "1000";
    }],
    ["missing warmup count", (reports) => {
      delete reports["capacity-25k-query.acceptance.json"].query.groups[1].warmupCount;
    }],
    ["fractional warmup count", (reports) => {
      reports["capacity-25k-query.acceptance.json"].query.groups[1].warmupCount = 100.5;
    }],
    ["empty mutation proof", (reports) => {
      reports["capacity-25k-query.acceptance.json"].formalEvidenceContext.mutations.verified = {};
    }],
    ["missing mutation query equivalence", (reports) => {
      delete reports["capacity-25k-query.acceptance.json"]
        .formalEvidenceContext.mutations.queryEquivalence;
    }],
    ["wrong mutation query count", (reports) => {
      reports["capacity-25k-query.acceptance.json"]
        .formalEvidenceContext.mutations.queryEquivalence.count = 99;
    }],
    ["mutation query clock drift", (reports) => {
      reports["capacity-25k-query.acceptance.json"]
        .formalEvidenceContext.mutations.queryEquivalence.clockIdentity.cleanRebuild = "5".repeat(64);
    }],
    ["duplicate mutation queries", (reports) => {
      reports["capacity-25k-query.acceptance.json"]
        .formalEvidenceContext.mutations.queryEquivalence
        .coverage.distinctQueryCount.cleanRebuild = 99;
    }],
    ["empty mutation query snapshots", (reports) => {
      const coverage = reports["capacity-25k-query.acceptance.json"]
        .formalEvidenceContext.mutations.queryEquivalence.coverage;
      coverage.resultQueryCount.incremental = 0;
      coverage.resultQueryCount.cleanRebuild = 0;
      coverage.toolPathFamilyQueryCount.incremental = 0;
      coverage.toolPathFamilyQueryCount.cleanRebuild = 0;
    }],
    ["mutation candidate drift", (reports) => {
      reports["capacity-25k-query.acceptance.json"]
        .formalEvidenceContext.mutations.queryEquivalence
        .digests.candidateTurnKeys.cleanRebuild = "5".repeat(64);
    }],
    ["mutation result ordering drift", (reports) => {
      reports["capacity-25k-query.acceptance.json"]
        .formalEvidenceContext.mutations.queryEquivalence
        .digests.resultTurnOrder.cleanRebuild = "5".repeat(64);
    }],
    ["mutation Tool path grouping drift", (reports) => {
      reports["capacity-25k-query.acceptance.json"]
        .formalEvidenceContext.mutations.queryEquivalence
        .digests.toolPathFamilies.cleanRebuild = "5".repeat(64);
    }],
    ["mutation query allEqual false", (reports) => {
      reports["capacity-25k-query.acceptance.json"]
        .formalEvidenceContext.mutations.queryEquivalence.allEqual = false;
    }],
    ["mutation query coverage gate false", (reports) => {
      reports["capacity-25k-query.acceptance.json"]
        .formalEvidenceContext.mutations.queryEquivalence.allQueriesExercised = false;
    }],
    ["unexpected long-term mutation query proof", (reports) => {
      reports["capacity-250k-query.acceptance.json"]
        .formalEvidenceContext.mutations.queryEquivalence = mutationQueryEquivalence();
    }],
    ["wrong runner hash", (reports) => {
      reports["quality.acceptance.json"].execution.runnerScriptSha256 = "0".repeat(64);
    }],
    ["wrong source commit", (reports) => {
      reports["quality.acceptance.json"].execution.sourceRevision = "9".repeat(40);
    }],
    ["wrong Engine binary", (reports) => {
      reports["ablation.acceptance.json"].execution.engine.binarySha256 = "8".repeat(64);
    }],
    ["wrong candidate count", (reports) => {
      reports["candidate-25k.acceptance.json"].indexedTurnCount = 25_059;
    }],
    ["skipped long-term gate", (reports) => {
      reports["real-sample-30pct.acceptance.json"].gates.longTermProjectionGateSkipped = true;
    }],
    ["missing copied-byte digest", (reports) => {
      reports["real-sample-30pct.acceptance.json"].hashes.selectedSnapshotContentDigest = "short";
    }],
    ["overlapping dedupe miscount", (reports) => {
      reports["real-sample-30pct.acceptance.json"].dedupe.overall.weakGroups = 4;
    }],
  ];
  for (const [name, mutate] of mutations) {
    const reports = formalReports({ identity, scripts });
    mutate(reports);
    assert.throws(
      () => validateFormalEvidenceReports(reports, expected),
      undefined,
      name,
    );
  }

  for (const developmentIdentity of [
    engineIdentity("b".repeat(64), { engineVersion: "0.0.0", target: "development" }),
    engineIdentity("b".repeat(64), { buildProfile: "development" }),
  ]) {
    assert.throws(() => validateFormalEvidenceReports(
      formalReports({ identity: developmentIdentity, scripts }),
      { ...expected, engineIdentity: developmentIdentity },
    ));
  }
});

test("aggregate privacy rejects paths, network values, credentials, and identity keys", () => {
  for (const value of [
    { note: "/tmp/private/session.jsonl" },
    { note: "https://private.invalid/share" },
    { note: "10.0.0.8" },
    { note: "Bearer secret-token" },
    { note: "11111111-2222-4333-8444-555555555555" },
    { sessionKey: "a".repeat(64) },
    { turnKey: "b".repeat(64) },
    { sourceLocator: "opaque" },
    { sourceFile: "opaque" },
    { projectKey: "c".repeat(64) },
  ]) {
    assert.throws(() => assertAggregateArtifactPrivacy(value));
  }
  assert.equal(assertAggregateArtifactPrivacy({ sqliteVersion: "3.53.2", count: 1 }).count, 1);
});

test("packager validates before atomically installing exactly seven aggregate artifacts", async (t) => {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-item5-packager-test-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = path.join(root, "repository");
  const input = path.join(root, "input");
  const failedInput = path.join(root, "failed-input");
  const output = path.join(root, "evidence");
  const failedOutput = path.join(root, "failed-evidence");
  await Promise.all([mkdir(repository, { recursive: true }), mkdir(input), mkdir(failedInput)]);

  const contents = Object.fromEntries(SCRIPT_FILES.map((file) => [file, `fixture for ${file}\n`]));
  for (const [relative, content] of Object.entries(contents)) {
    const file = path.join(repository, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, content);
  }
  const version = Object.fromEntries(Object.entries(engineIdentity()).filter(([key]) => key !== "binarySha256"));
  const enginePath = path.join(repository, "threadshare-insights-engine");
  await writeFile(enginePath, `#!/bin/sh\nprintf '%s\\n' '${JSON.stringify(version)}'\n`);
  await chmod(enginePath, 0o755);
  await execFileAsync("git", ["init", "-q"], { cwd: repository });
  await execFileAsync("git", ["add", "."], { cwd: repository });
  await execFileAsync("git", [
    "-c", "user.name=Threadshare Test", "-c", "user.email=test@example.invalid",
    "commit", "-qm", "fixture",
  ], { cwd: repository });
  const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repository });
  const sourceRevision = stdout.trim();
  const binarySha256 = sha256(await readFile(enginePath));
  const identity = { ...version, binarySha256 };
  const scripts = scriptHashes(contents);
  const reports = formalReports({ sourceRevision, identity, scripts });
  for (const name of ITEM5_FORMAL_REPORTS) {
    await writeFile(path.join(input, name), `${JSON.stringify(reports[name])}\n`);
    await writeFile(path.join(failedInput, name), `${JSON.stringify(reports[name])}\n`);
  }
  const invalid = structuredClone(reports["quality.acceptance.json"]);
  invalid.gates.ndcgAt10.passed = false;
  await writeFile(path.join(failedInput, "quality.acceptance.json"), `${JSON.stringify(invalid)}\n`);

  await assert.rejects(packageFormalEvidence({
    inputDirectory: failedInput,
    outputDirectory: failedOutput,
    enginePath,
    fixturePath: FIXTURE_PATH,
    epicPath: EPIC_PATH,
    repositoryRoot: repository,
  }));
  await assert.rejects(readdir(failedOutput), { code: "ENOENT" });

  const manifest = await packageFormalEvidence({
    inputDirectory: input,
    outputDirectory: output,
    enginePath,
    fixturePath: FIXTURE_PATH,
    epicPath: EPIC_PATH,
    repositoryRoot: repository,
  });
  assert.equal(manifest.sourceRevision, sourceRevision);
  assert.equal(manifest.engineIdentity.binarySha256, binarySha256);
  assert.equal(manifest.engineBinary.sha256, binarySha256);
  assert.equal(manifest.engineBinary.bytes > 0, true);
  assert.deepEqual(
    (await readdir(output)).sort(),
    [...ITEM5_FORMAL_REPORTS, "manifest.json"].sort(),
  );
});
