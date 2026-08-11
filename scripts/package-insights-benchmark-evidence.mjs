#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile } from "node:child_process";
import {
  chmod,
  mkdir,
  mkdtemp,
  readFile,
  rename,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import { promisify } from "node:util";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  CANONICAL_QUERY_THRESHOLDS,
  loadQueryEvaluationFixture,
  queryJudgmentDigest,
} from "./insights-query-evaluation.mjs";
import {
  FORMAL_CANDIDATE_DISTRACTOR_TURNS,
  FORMAL_CANDIDATE_SEED,
} from "./run-insights-query-quality.mjs";
import { assertAllowedEngineIdentity } from "./benchmark-insights-real-sample.mjs";

export const ITEM5_EVIDENCE_MANIFEST_FORMAT = "threadshare-insights-item5-evidence-manifest@v1";
export const ITEM5_FORMAL_FIXTURE_SHA256 = "e9663b7f6dea10f54b14a725a3135a756ee4a570d4eae7b7c3192222d058f211";
export const ITEM5_FORMAL_EPIC_SHA256 = "46e2cc8fdc974dac26a67ab3f448bcc0df458b5ae33a28da4e2f469fe8daf582";
export const ITEM5_FORMAL_QREL_SHA256 = "5d45b38259b63c009a0554edbd01cfeb87580fd9ada0d0110488ce8b09ee31fd";
export const ITEM5_DEVELOPMENT_QREL_SHA256 = "16b1d360903a51197d78e45e4973df26aa60fec149f0cdf49a469accaeb60b5f";
export const ITEM5_FORMAL_REPORTS = Object.freeze([
  "ablation.acceptance.json",
  "candidate-25k.acceptance.json",
  "capacity-25k-query.acceptance.json",
  "capacity-250k-query.acceptance.json",
  "quality.acceptance.json",
  "real-sample-30pct.acceptance.json",
]);

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const DEFAULT_FIXTURE = path.join(REPOSITORY_ROOT, "test", "fixtures", "insights-query-evaluation.v2.json");
const DEFAULT_EPIC = path.join(REPOSITORY_ROOT, ".codestable", "epics", "local-session-insights.md");
const SCRIPT_FILES = Object.freeze([
  "scripts/benchmark-insights-engine.mjs",
  "scripts/benchmark-insights-real-sample.mjs",
  "scripts/insights-query-evaluation.mjs",
  "scripts/package-insights-benchmark-evidence.mjs",
  "scripts/run-insights-query-quality.mjs",
]);
const FORMAL_QUERY_SEEDS = Object.freeze({
  25000: "threadshare-insights-query-25k-v1",
  250000: "threadshare-insights-query-250k-v1",
});
const FORMAL_MUTATION_CHECKS = Object.freeze([
  "boundedChangeLog",
  "delete",
  "expectedRemainingFacts",
  "integrity",
  "projectionCleanup",
  "purge",
  "replace",
  "replacementSearchable",
]);
const PRIVATE_VALUE_PATTERNS = Object.freeze([
  /(?:file:\/\/|\/(?:Users|home|tmp|var|private|workspace|opt)\/|[A-Za-z]:\\|~\/\.(?:codex|claude)\/)/u,
  /(?:\.codex\/sessions|\.claude\/projects)/u,
  /https?:\/\//iu,
  /\b[A-Z0-9._%+-]+@[A-Z0-9.-]+\.[A-Z]{2,}\b/iu,
  /\b[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}\b/iu,
  /\b(?:ghp_|github_pat_|npm_|sk-)[A-Za-z0-9_-]{8,}\b/u,
  /\bBearer\s+[A-Za-z0-9._~-]+/iu,
]);

function fail(message) {
  throw new TypeError(message);
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function plainObject(value, name) {
  if (value === null || typeof value !== "object" || Array.isArray(value)) {
    fail(`${name} must be an object`);
  }
  return value;
}

function requireHex(value, name, bytes = 32) {
  if (typeof value !== "string" || !new RegExp(`^[0-9a-f]{${bytes * 2}}$`, "u").test(value)) {
    fail(`${name} must be a lowercase ${bytes}-byte hex digest`);
  }
  return value;
}

function requireGate(value, name) {
  if (value !== true) fail(`${name} did not pass`);
}

function canonicalIdentity(value) {
  return JSON.stringify(Object.fromEntries(Object.entries(plainObject(value, "engine identity")).sort()));
}

function assertFormalEngineIdentity(identity) {
  const value = plainObject(identity, "formal Engine identity");
  if (
    value.engineVersion === "0.0.0" ||
    value.target === "development" ||
    value.buildProfile === "development"
  ) {
    fail("formal evidence requires a release Engine build");
  }
  const { binarySha256, ...versionDocument } = value;
  requireHex(binarySha256, "formal Engine binary SHA-256");
  assertAllowedEngineIdentity(versionDocument);
  return value;
}

export function assertAggregateArtifactPrivacy(value, name = "artifact") {
  const visit = (current, cursor) => {
    if (typeof current === "string") {
      for (const pattern of PRIVATE_VALUE_PATTERNS) {
        if (pattern.test(current)) fail(`${cursor} contains forbidden private or network-shaped content`);
      }
      if (!/version/iu.test(cursor) && /\b(?:\d{1,3}\.){3}\d{1,3}\b/u.test(current)) {
        fail(`${cursor} contains a forbidden IP address shape`);
      }
      return;
    }
    if (Array.isArray(current)) {
      current.forEach((item, index) => visit(item, `${cursor}[${index}]`));
      return;
    }
    if (current === null || typeof current !== "object") return;
    for (const [key, item] of Object.entries(current)) {
      if (/^(?:password|secret|accessToken|refreshToken|sessionId|sessionKey|turnKey|sourcePath|sourceLocator|sourceFile|databasePath|projectKey)$/iu.test(key)) {
        fail(`${cursor}.${key} is forbidden in aggregate evidence`);
      }
      visit(item, `${cursor}.${key}`);
    }
  };
  visit(value, name);
  return value;
}

function reportIdentity(report, name) {
  const sourceRevision = report.sourceRevision ?? report.execution?.sourceRevision;
  const sourceWorktreeDirty = report.sourceWorktreeDirty ?? report.execution?.sourceWorktreeDirty;
  const identity = report.engineIdentity ?? report.execution?.engine ?? (
    report.engine && report.hashes?.engineBinarySha256
      ? { ...report.engine, binarySha256: report.hashes.engineBinarySha256 }
      : null
  );
  requireHex(sourceRevision, `${name}.sourceRevision`, 20);
  if (sourceWorktreeDirty !== false) fail(`${name} was not generated from a clean worktree`);
  requireHex(identity?.binarySha256, `${name}.engine binary SHA-256`);
  return { sourceRevision, identity };
}

function validateDigestEquality(value, name) {
  const pair = plainObject(value, name);
  requireHex(pair.incremental, `${name}.incremental`);
  requireHex(pair.cleanRebuild, `${name}.cleanRebuild`);
  requireGate(pair.equal, `${name}.equal`);
  if (pair.incremental !== pair.cleanRebuild) {
    fail(`${name} differs between incremental and clean-rebuild snapshots`);
  }
}

function validateMutationQueryEquivalence(value, turns) {
  const equivalence = plainObject(value, `capacity ${turns} mutation query equivalence`);
  if (equivalence.count !== 100) {
    fail(`capacity ${turns} mutation query equivalence must contain exactly 100 queries`);
  }
  if (equivalence.pathLimit !== 10) {
    fail(`capacity ${turns} mutation query equivalence must use pathLimit=10`);
  }
  validateDigestEquality(
    equivalence.clockIdentity,
    `capacity ${turns} mutation query clock identity`,
  );
  const coverage = plainObject(
    equivalence.coverage,
    `capacity ${turns} mutation query coverage`,
  );
  const expectedCoverageNames = [
    "distinctQueryCount",
    "resultQueryCount",
    "toolPathFamilyQueryCount",
  ];
  if (
    JSON.stringify(Object.keys(coverage).sort()) !==
    JSON.stringify([...expectedCoverageNames].sort())
  ) {
    fail(`capacity ${turns} mutation query coverage is incomplete`);
  }
  for (const name of expectedCoverageNames) {
    const pair = plainObject(coverage[name], `capacity ${turns} mutation query ${name}`);
    if (
      pair.incremental !== equivalence.count ||
      pair.cleanRebuild !== equivalence.count ||
      pair.equal !== true
    ) {
      fail(`capacity ${turns} mutation query ${name} did not exercise every query`);
    }
  }
  const digests = plainObject(
    equivalence.digests,
    `capacity ${turns} mutation query digests`,
  );
  const expectedDigestNames = [
    "candidateTurnKeys",
    "resultTurnOrder",
    "toolPathFamilies",
  ];
  if (
    JSON.stringify(Object.keys(digests).sort()) !==
    JSON.stringify([...expectedDigestNames].sort())
  ) {
    fail(`capacity ${turns} mutation query digests are incomplete`);
  }
  for (const name of expectedDigestNames) {
    validateDigestEquality(
      digests[name],
      `capacity ${turns} mutation query ${name} digest`,
    );
  }
  requireGate(
    equivalence.allQueriesExercised,
    `capacity ${turns} mutation query coverage`,
  );
  requireGate(equivalence.allEqual, `capacity ${turns} mutation query equivalence`);
}

function validateCapacity(report, turns, expected) {
  if (report.format !== "threadshare-insights-query-benchmark@v1") fail(`capacity ${turns} format is invalid`);
  if (report.corpus?.turns !== turns || report.corpus?.turnsPerSession !== 100) {
    fail(`capacity ${turns} must contain exactly ${turns} Turns at 100 Turns/session`);
  }
  if (report.corpus?.seed !== FORMAL_QUERY_SEEDS[turns]) fail(`capacity ${turns} seed is invalid`);
  if (report.benchmarkScriptSha256 !== expected.scriptHashes["scripts/benchmark-insights-engine.mjs"]?.sha256) {
    fail(`capacity ${turns} was not generated by the current benchmark script`);
  }
  const groups = report.query?.groups;
  if (!Array.isArray(groups) || groups.length !== 2) fail(`capacity ${turns} query groups are invalid`);
  const pathLimits = groups.map((candidate, index) => {
    const group = plainObject(candidate, `capacity ${turns} query.groups[${index}]`);
    if (!Number.isSafeInteger(group.pathLimit) || ![0, 10].includes(group.pathLimit)) {
      fail(`capacity ${turns} query group pathLimit must be exactly 0 or 10`);
    }
    if (!Number.isSafeInteger(group.queryCount) || group.queryCount < 1_000) {
      fail(`capacity ${turns} pathLimit=${group.pathLimit} lacks a formal query count`);
    }
    if (!Number.isSafeInteger(group.warmupCount) || group.warmupCount < 100) {
      fail(`capacity ${turns} pathLimit=${group.pathLimit} lacks a formal warmup count`);
    }
    return group.pathLimit;
  }).sort((left, right) => left - right);
  if (pathLimits[0] !== 0 || pathLimits[1] !== 10) {
    fail(`capacity ${turns} query groups must contain pathLimit 0 and 10 exactly once`);
  }
  requireGate(report.gates?.acceptanceCorpusExact, `capacity ${turns} exact-corpus gate`);
  requireGate(report.gates?.allMeasuredQueryGatesPassed, `capacity ${turns} query gates`);
  requireGate(report.formalEvidenceGates?.queryGatesPassed, `capacity ${turns} formal query gate`);
  requireGate(report.formalEvidenceGates?.capacityGatesPassed, `capacity ${turns} formal capacity gate`);
  requireGate(report.formalEvidenceGates?.populatedStartupPassed, `capacity ${turns} formal startup gate`);
  requireGate(report.formalEvidenceGates?.mutationTracePassed, `capacity ${turns} formal mutation gate`);
  requireGate(report.formalEvidenceGates?.allFormalEvidenceGatesPassed, `capacity ${turns} formal gates`);
  requireGate(
    report.formalEvidenceContext?.capacityGates?.allMeasuredCapacityGatesPassed,
    `capacity ${turns} measured capacity gates`,
  );
  requireGate(
    report.formalEvidenceContext?.startup?.populatedDatabase?.gate
      ?.medianReadyAndFirstOverviewUnder500Ms,
    `capacity ${turns} populated startup gate`,
  );
  const mutationChecks = report.formalEvidenceContext?.mutations?.verified;
  if (
    !mutationChecks ||
    JSON.stringify(Object.keys(mutationChecks).sort()) !== JSON.stringify(FORMAL_MUTATION_CHECKS) ||
    Object.values(mutationChecks).some((passed) => passed !== true)
  ) {
    fail(`capacity ${turns} mutation trace did not pass every check`);
  }
  if (
    report.formalEvidenceContext?.mutations?.corpus?.turns !== turns ||
    report.formalEvidenceContext?.mutations?.corpus?.sessions !== turns / 100
  ) {
    fail(`capacity ${turns} mutation trace did not use the formal corpus`);
  }
  if (turns === 25_000) {
    validateMutationQueryEquivalence(
      report.formalEvidenceContext?.mutations?.queryEquivalence,
      turns,
    );
  } else if (report.formalEvidenceContext?.mutations?.queryEquivalence !== undefined) {
    fail(`capacity ${turns} must not contain a partial mutation query equivalence report`);
  }
}

function validateQuality(report, expected) {
  if (
    report.format !== "threadshare-insights-query-quality-report@v1" ||
    report.dataset !== "real-acceptance" || report.split !== "evaluation" || report.queryCount !== 60 ||
    report.source !== "current-conversation-user-prompts" ||
    report.qrelDigest !== ITEM5_FORMAL_QREL_SHA256
  ) {
    fail("quality report is not the frozen 60-query acceptance evaluation");
  }
  if (report.execution?.runnerScriptSha256 !== expected.scriptHashes["scripts/run-insights-query-quality.mjs"]?.sha256) {
    fail("quality report was not generated by the current runner script");
  }
  for (const [metric, threshold] of Object.entries(CANONICAL_QUERY_THRESHOLDS)) {
    const gate = report.gates?.[metric];
    if (gate?.threshold !== threshold || gate?.passed !== true) fail(`quality ${metric} gate is invalid`);
  }
}

function validateAblation(report, expected) {
  if (
    report.format !== "threadshare-insights-query-ablation-report@v1" ||
    report.dataset !== "review-development" || report.split !== "development" ||
    report.queryCount !== 30 || report.qrelDigest !== ITEM5_DEVELOPMENT_QREL_SHA256 ||
    report.provenance !== "review-derived-deidentified-development" ||
    report.source !== "pre-item5-independent-design-and-contract-review-findings"
  ) {
    fail("ablation report is not the frozen deidentified development set");
  }
  if (
    report.execution?.ablationScope !== "fixed-production-candidates-rerank-only" ||
    report.execution?.candidateGenerationRerunPerVariant !== false ||
    report.execution?.developmentSetKind !== "review-derived-deidentified-disjoint"
  ) {
    fail("ablation report must disclose its fixed-candidate rerank-only scope");
  }
  if (report.execution?.runnerScriptSha256 !== expected.scriptHashes["scripts/run-insights-query-quality.mjs"]?.sha256) {
    fail("ablation report was not generated by the current runner script");
  }
}

function validateCandidate(report, expected) {
  const expectedIndexedTurns = 60 + FORMAL_CANDIDATE_DISTRACTOR_TURNS;
  if (
    report.format !== "threadshare-insights-candidate-recall-scale@v1" ||
    report.queryCount !== 60 || report.qrelDigest !== ITEM5_FORMAL_QREL_SHA256 ||
    report.indexedTurnCount !== expectedIndexedTurns ||
    report.distractorTurnCount !== FORMAL_CANDIDATE_DISTRACTOR_TURNS ||
    report.execution?.candidateScale?.seed !== FORMAL_CANDIDATE_SEED
  ) {
    fail("candidate report is not the frozen 25000-distractor plus 60-gold run");
  }
  if (report.execution?.runnerScriptSha256 !== expected.scriptHashes["scripts/run-insights-query-quality.mjs"]?.sha256) {
    fail("candidate report was not generated by the current runner script");
  }
  requireHex(report.execution?.candidateScale?.submittedDeltaDigest, "candidate submitted delta digest");
  requireGate(report.allGatesPassed, "candidate gates");
}

function validateRealSample(report, expected) {
  if (
    report.format !== "threadshare-insights-real-sample-benchmark@v1" ||
    report.sampling?.fraction !== 0.30 || report.sampling?.seed !== "threadshare-insights-real-sample-v1"
  ) {
    fail("real-sample report is not the frozen 30% sample");
  }
  if (report.hashes?.benchmarkScriptSha256 !== expected.scriptHashes["scripts/benchmark-insights-real-sample.mjs"]?.sha256) {
    fail("real-sample report was not generated by the current benchmark script");
  }
  requireHex(report.hashes?.selectedSnapshotContentDigest, "real-sample selected content digest");
  requireGate(report.gates?.detailFullFtsWithinLimit, "real-sample long-term FTS gate");
  requireGate(report.gates?.ftsIntegrityCheckPassed, "real-sample FTS integrity gate");
  requireGate(report.gates?.dedupeCountsConsistent, "real-sample dedupe gate");
  requireGate(report.gates?.allMeasuredGatesPassed, "real-sample gates");
  if (Object.hasOwn(report.gates, "longTermProjectionGateSkipped")) {
    fail("real-sample evidence may not contain a skipped long-term gate");
  }
  const dedupe = report.dedupe;
  if (!dedupe || !dedupe.overall || !dedupe.byProvider) fail("real-sample dedupe aggregates are missing");
  for (const [name, counts] of [
    ["overall", dedupe.overall],
    ["claude", dedupe.byProvider.claude],
    ["codex", dedupe.byProvider.codex],
  ]) {
    for (const field of [
      "rawSessions",
      "eligibleMainSessions",
      "independentGroups",
      "strongGroups",
      "weakGroups",
      "observedEofProvisionalGroups",
      "unknownSessions",
    ]) {
      if (!Number.isSafeInteger(counts?.[field]) || counts[field] < 0) {
        fail(`real-sample dedupe ${name}.${field} is invalid`);
      }
    }
    if (
      counts.eligibleMainSessions > counts.rawSessions ||
      counts.strongGroups + counts.weakGroups !== counts.independentGroups ||
      counts.observedEofProvisionalGroups > counts.independentGroups ||
      counts.unknownSessions > counts.eligibleMainSessions
    ) {
      fail(`real-sample dedupe ${name} invariants failed`);
    }
  }
}

export function validateFormalEvidenceReports(reports, expected) {
  plainObject(expected?.scriptHashes, "expected.scriptHashes");
  const formalEngineIdentity = assertFormalEngineIdentity(expected?.engineIdentity);
  for (const name of ITEM5_FORMAL_REPORTS) {
    assertAggregateArtifactPrivacy(plainObject(reports[name], name), name);
  }
  validateCapacity(reports["capacity-25k-query.acceptance.json"], 25_000, expected);
  validateCapacity(reports["capacity-250k-query.acceptance.json"], 250_000, expected);
  validateQuality(reports["quality.acceptance.json"], expected);
  validateAblation(reports["ablation.acceptance.json"], expected);
  validateCandidate(reports["candidate-25k.acceptance.json"], expected);
  validateRealSample(reports["real-sample-30pct.acceptance.json"], expected);

  const identities = ITEM5_FORMAL_REPORTS.map((name) => reportIdentity(reports[name], name));
  if (identities.some(({ sourceRevision }) => sourceRevision !== expected.sourceRevision)) {
    fail("formal reports do not share the current source revision");
  }
  if (identities.some(({ identity }) => identity.binarySha256 !== expected.engineBinarySha256)) {
    fail("formal reports do not share the selected Engine binary");
  }
  const expectedIdentity = canonicalIdentity(formalEngineIdentity);
  if (identities.some(({ identity }) => canonicalIdentity(identity) !== expectedIdentity)) {
    fail("formal reports do not share one Engine build identity");
  }
  return true;
}

async function pathExists(file) {
  try {
    await stat(file);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

async function gitIdentity(repositoryRoot) {
  const [{ stdout: revision }, { stdout: status }] = await Promise.all([
    execFileAsync("git", ["rev-parse", "HEAD"], { cwd: repositoryRoot }),
    execFileAsync("git", ["status", "--porcelain", "--untracked-files=normal"], {
      cwd: repositoryRoot,
      maxBuffer: 8 * 1024 * 1024,
    }),
  ]);
  if (status.length !== 0) fail("formal evidence packaging requires a clean worktree");
  return revision.trim();
}

async function readReports(inputDirectory) {
  const reports = {};
  const raw = {};
  for (const name of ITEM5_FORMAL_REPORTS) {
    const bytes = await readFile(path.join(inputDirectory, name));
    raw[name] = bytes;
    reports[name] = JSON.parse(bytes.toString("utf8"));
  }
  return { reports, raw };
}

export async function packageFormalEvidence({
  inputDirectory,
  outputDirectory,
  enginePath,
  fixturePath = DEFAULT_FIXTURE,
  epicPath = DEFAULT_EPIC,
  repositoryRoot = REPOSITORY_ROOT,
}) {
  if (await pathExists(outputDirectory)) fail("formal evidence output directory must not already exist");
  const [sourceRevision, engineBytes, fixtureBytes, epicBytes, fixture, loaded] = await Promise.all([
    gitIdentity(repositoryRoot),
    readFile(enginePath),
    readFile(fixturePath),
    readFile(epicPath),
    loadQueryEvaluationFixture(fixturePath),
    readReports(inputDirectory),
  ]);
  if (sha256(fixtureBytes) !== ITEM5_FORMAL_FIXTURE_SHA256) fail("formal fixture SHA-256 drifted");
  if (sha256(epicBytes) !== ITEM5_FORMAL_EPIC_SHA256) fail("approved Epic SHA-256 drifted");
  if (queryJudgmentDigest({ fixture }) !== ITEM5_FORMAL_QREL_SHA256) fail("acceptance qrel digest drifted");
  if (queryJudgmentDigest({ fixture, dataset: "review-development", split: "development" }) !== ITEM5_DEVELOPMENT_QREL_SHA256) {
    fail("development qrel digest drifted");
  }
  const scriptHashes = {};
  for (const relative of SCRIPT_FILES) {
    const bytes = await readFile(path.join(repositoryRoot, relative));
    scriptHashes[relative] = { bytes: bytes.length, sha256: sha256(bytes) };
  }
  const engineBinarySha256 = sha256(engineBytes);
  const { stdout } = await execFileAsync(enginePath, ["--version", "--json"], { maxBuffer: 1024 * 1024 });
  const engineIdentity = {
    ...assertAllowedEngineIdentity(JSON.parse(stdout)),
    binarySha256: engineBinarySha256,
  };
  validateFormalEvidenceReports(loaded.reports, {
    sourceRevision,
    engineBinarySha256,
    engineIdentity,
    scriptHashes,
  });
  const artifacts = Object.fromEntries(ITEM5_FORMAL_REPORTS.map((name) => [
    name,
    { bytes: loaded.raw[name].length, sha256: sha256(loaded.raw[name]) },
  ]));
  const manifest = {
    format: ITEM5_EVIDENCE_MANIFEST_FORMAT,
    sourceRevision,
    approvedEpicSha256: ITEM5_FORMAL_EPIC_SHA256,
    fixtureSha256: ITEM5_FORMAL_FIXTURE_SHA256,
    acceptanceQrelSha256: ITEM5_FORMAL_QREL_SHA256,
    developmentQrelSha256: ITEM5_DEVELOPMENT_QREL_SHA256,
    thresholds: CANONICAL_QUERY_THRESHOLDS,
    formalConfiguration: {
      capacity: {
        turns: [25_000, 250_000],
        turnsPerSession: 100,
        queriesPerPathMode: 1_000,
        warmupsPerPathMode: 100,
        pathLimits: [0, 10],
        seeds: FORMAL_QUERY_SEEDS,
      },
      mutationQueryEquivalence: {
        turns: 25_000,
        queries: 100,
        pathLimit: 10,
        comparison: ["candidateTurnKeys", "resultTurnOrder", "toolPathFamilies"],
      },
      candidate: {
        distractorTurns: FORMAL_CANDIDATE_DISTRACTOR_TURNS,
        goldTurns: 60,
        seed: FORMAL_CANDIDATE_SEED,
      },
      realSample: { fraction: 0.30, seed: "threadshare-insights-real-sample-v1" },
    },
    engineIdentity,
    engineBinary: { bytes: engineBytes.length, sha256: engineBinarySha256 },
    scripts: scriptHashes,
    artifacts,
    privacy: {
      aggregateOnly: true,
      rawSessionsIncluded: false,
      temporaryDatabasesIncluded: false,
      sourcePathsIncluded: false,
      sessionIdentifiersIncluded: false,
    },
  };
  assertAggregateArtifactPrivacy(manifest, "manifest");

  const parent = path.dirname(outputDirectory);
  await mkdir(parent, { recursive: true });
  const temporary = await mkdtemp(path.join(parent, ".item5-evidence-"));
  let installed = false;
  try {
    await chmod(temporary, 0o700);
    for (const name of ITEM5_FORMAL_REPORTS) {
      await writeFile(path.join(temporary, name), loaded.raw[name], { mode: 0o600 });
    }
    await writeFile(path.join(temporary, "manifest.json"), `${JSON.stringify(manifest, null, 2)}\n`, { mode: 0o600 });
    await rename(temporary, outputDirectory);
    installed = true;
  } finally {
    if (!installed) await rm(temporary, { recursive: true, force: true });
  }
  return manifest;
}

function parseArguments(argv) {
  const values = { fixturePath: DEFAULT_FIXTURE, epicPath: DEFAULT_EPIC };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--help") return { help: true };
    const key = {
      "--input-dir": "inputDirectory",
      "--output-dir": "outputDirectory",
      "--engine": "enginePath",
      "--fixture": "fixturePath",
      "--epic": "epicPath",
    }[argument];
    if (key === undefined) fail(`unknown argument ${argument}`);
    const value = argv[++index];
    if (!value || value.startsWith("--")) fail(`${argument} requires a value`);
    values[key] = path.resolve(value);
  }
  return values;
}

async function main(argv) {
  const options = parseArguments(argv);
  if (options.help) {
    process.stdout.write("Usage: package-insights-benchmark-evidence.mjs --input-dir DIR --output-dir DIR --engine FILE [--fixture FILE] [--epic FILE]\n");
    return;
  }
  for (const name of ["inputDirectory", "outputDirectory", "enginePath"]) {
    if (!options[name]) fail(`${name} is required`);
  }
  const manifest = await packageFormalEvidence(options);
  process.stdout.write(`${JSON.stringify({ format: manifest.format, sourceRevision: manifest.sourceRevision })}\n`);
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? "").href) {
  main(process.argv.slice(2)).catch((error) => {
    process.stderr.write(`package-insights-benchmark-evidence: ${error instanceof Error ? error.message : String(error)}\n`);
    process.exitCode = 1;
  });
}
