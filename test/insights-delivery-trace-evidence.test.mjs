import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  DELIVERY_TRACE_REPORT,
  packageDeliveryTraceEvidence,
  validateDeliveryTraceReport,
  verifyDeliveryTraceEvidenceDirectory,
} from "../scripts/package-insights-delivery-trace-evidence.mjs";

const ROOT = path.resolve(import.meta.dirname, "..");
const sha256 = (value) => createHash("sha256").update(value).digest("hex");
const latency = (p95, p99) => ({
  unit: "ms", count: 100, total: 1_000, p50: 5, p95, p99, max: p99 + 1,
});

async function report() {
  const revision = (await import("node:child_process")).execFileSync(
    "git", ["rev-parse", "HEAD"], { cwd: ROOT, encoding: "utf8" },
  ).trim();
  const benchmark = await readFile(path.join(ROOT, "scripts/benchmark-insights-engine.mjs"));
  return {
    format: "threadshare-insights-delivery-trace-benchmark@v1",
    measuredScope: "local-insights-delivery-trace-25k",
    sourceRevision: revision,
    sourceWorktreeDirty: true,
    benchmarkScriptSha256: sha256(benchmark),
    environment: { platform: "test" },
    corpus: {
      seed: "threadshare-insights-delivery-trace-25k-v1",
      turns: 25_000, sessions: 250, commits: 5_000, changedFiles: 20_000, intents: 100,
    },
    coverage: {
      commits: 5_000, changedFiles: 20_000, intents: 100, unresolvedRefs: 10,
      unreachableCommits: 1, directEdges: 20_000, observedEdges: 10,
      candidateEdges: 1, contextualEdges: 10,
    },
    incrementalEquivalence: {
      incrementalDigest: "a".repeat(64), cleanDigest: "a".repeat(64), equal: true,
    },
    latency: {
      measuredRequestCount: 100, warmupRequestCount: 20,
      traceInitial: latency(10, 20), traceExpansion: latency(15, 25),
      evidenceFirstPage: latency(5, 10), gitDiffFirstPage: latency(25, 50),
    },
    resources: { sidecarPeakBytes: 64 * 1024 * 1024, maxResponseBytes: 64 * 1024 },
    queryPlans: Object.fromEntries(["edgeBySource", "changedFileByPath", "repositoryByProject"].map((name) => [name, {
      detailDigest: sha256(name), indexed: true,
    }])),
    resultDigest: "b".repeat(64),
    engineIdentity: {
      format: "threadshare-insights-engine-version@v1",
      engineVersion: "0.0.0",
      protocolVersion: 1,
      sqliteVersion: "3.53.2",
      target: "development",
      buildManifestDigest: "c".repeat(64),
      sqliteCompileOptionsDigest: "d".repeat(64),
      binarySha256: "e".repeat(64),
    },
    gates: {
      corpusComplete: true, incrementalEqualsClean: true, traceInitialWithinLimit: true,
      traceExpansionWithinLimit: true, evidenceFirstPageWithinLimit: true,
      gitDiffFirstPageWithinLimit: true, engineRssWithin128MiB: true,
      responseWithin4MiB: true, indexedQueryPlans: true,
      allMeasuredDeliveryTraceGatesPassed: true,
    },
    notMeasured: [
      "250k Delivery Trace capacity is deferred to a later iteration",
      "network SCM availability and remote issue trackers are outside the local evidence boundary",
      "cross-repository and global filesystem discovery are intentionally unsupported",
    ],
  };
}

test("Delivery Trace packager validates and installs one aggregate-only 25k report", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-delivery-evidence-"));
  const input = path.join(root, "raw.json");
  const output = path.join(root, "evidence");
  try {
    await writeFile(input, `${JSON.stringify(await report(), null, 2)}\n`);
    const manifest = await packageDeliveryTraceEvidence({ inputFile: input, outputDirectory: output });
    assert.equal(manifest.formalConfiguration.measuredTurns[0], 25_000);
    assert.deepEqual(manifest.formalConfiguration.deferredTurns, [250_000]);
    assert.equal(await verifyDeliveryTraceEvidenceDirectory({ directory: output }), 1);
    assert.equal(JSON.parse(await readFile(path.join(output, DELIVERY_TRACE_REPORT), "utf8")).corpus.commits, 5_000);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Delivery Trace verifier rejects empty, forged, over-budget, and drifted evidence", async () => {
  const cases = [
    (value) => { value.coverage.observedEdges = 0; },
    (value) => { value.incrementalEquivalence.cleanDigest = "c".repeat(64); },
    (value) => { value.latency.traceInitial.p95 = 200; value.latency.traceInitial.p99 = 201; },
    (value) => { value.resources.sidecarPeakBytes = 128 * 1024 * 1024; },
    (value) => { value.gates.indexedQueryPlans = false; },
    (value) => { value.unreviewed = true; },
  ];
  for (const mutate of cases) {
    const value = structuredClone(await report());
    mutate(value);
    assert.throws(() => validateDeliveryTraceReport(value));
  }
});
