import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  createBenchmarkCorpus,
  runInsightsEngineBenchmark,
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
  assert.equal(report.corpus.turns, 12);
  assert.equal(report.rustSidecar.query.rustProtocolQueryAvailable, false);
  assert.equal(report.comparison.queryResultsEqual, true);
  assert.equal(report.rustSidecar.protocol.requestFrames > report.corpus.sessions, true);
  assert.equal(report.rustSidecar.databaseBytes, report.nodeSqliteReference.databaseBytes);
  assert.equal(report.deferredToItem4.length > 0, true);
});
