import assert from "node:assert/strict";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  assertAllowedEngineIdentity,
  evaluateRealSampleByteFraction,
  mapLimitSettled,
  projectedDetailFullFtsBytes,
  realSampleSizeStratum,
  runInsightsRealSampleBenchmark,
  selectStratifiedRealSample,
} from "../scripts/benchmark-insights-real-sample.mjs";
import { assertAggregateArtifactPrivacy } from "../scripts/package-insights-benchmark-evidence.mjs";

const ENGINE_NAME = process.platform === "win32"
  ? "threadshare-insights-engine.exe"
  : "threadshare-insights-engine";
const DEBUG_ENGINE_PATH = fileURLToPath(new URL(
  `../crates/insights-engine/target/debug/${ENGINE_NAME}`,
  import.meta.url,
));
const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const E2E_SKIP = nodeMajor < 22 || (nodeMajor === 22 && nodeMinor < 5) ||
  !existsSync(DEBUG_ENGINE_PATH)
  ? "requires Node 22.5+ and a debug Insights Engine build"
  : false;

function uuid(index) {
  return `00000000-0000-4000-8000-${index.toString(16).padStart(12, "0")}`;
}

function candidate(provider, index, bytes) {
  return {
    provider,
    sessionId: uuid(index),
    file: `/private/source/${provider}/${index}.jsonl`,
    bytes,
  };
}

test("real-session sampling is deterministic within provider and fixed size strata", () => {
  assert.equal(realSampleSizeStratum(0), "under-64-kib");
  assert.equal(realSampleSizeStratum(64 * 1024), "64-kib-to-1-mib");
  assert.equal(realSampleSizeStratum(1024 * 1024), "1-mib-to-16-mib");
  assert.equal(realSampleSizeStratum(16 * 1024 * 1024), "16-mib-and-over");

  const sources = [];
  for (const [providerIndex, provider] of ["codex", "claude"].entries()) {
    for (const [stratumIndex, bytes] of [1024, 128 * 1024].entries()) {
      for (let index = 0; index < 10; index += 1) {
        sources.push(candidate(
          provider,
          1 + providerIndex * 100 + stratumIndex * 20 + index,
          bytes + index,
        ));
      }
    }
  }
  const first = selectStratifiedRealSample(sources, { seed: "real-sample-test" });
  const second = selectStratifiedRealSample([...sources].reverse(), { seed: "real-sample-test" });
  assert.equal(first.populationFiles, 40);
  assert.equal(first.selectedFiles, 12);
  assert.equal(first.strata.length, 4);
  assert.equal(first.strata.every(({ populationFiles, selectedFiles }) =>
    populationFiles === 10 && selectedFiles === 3), true);
  assert.equal(first.populationDigest, second.populationDigest);
  assert.equal(first.selectionDigest, second.selectionDigest);
  assert.deepEqual(
    first.selected.map(({ token }) => token),
    second.selected.map(({ token }) => token),
  );
  assert.equal(evaluateRealSampleByteFraction(0.25).withinAcceptanceRange, true);
  assert.equal(evaluateRealSampleByteFraction(0.35).withinAcceptanceRange, true);
  assert.equal(evaluateRealSampleByteFraction(0.249).withinAcceptanceRange, false);
  assert.equal(evaluateRealSampleByteFraction(0.351).withinAcceptanceRange, false);
});

test("discrete strata choose the closest seeded byte prefix and retain a huge-file stratum", () => {
  const mib = 1024 * 1024;
  const sources = [
    candidate("claude", 1, 1_000),
    candidate("claude", 2, 2_000),
    candidate("claude", 3, 7_000),
    candidate("claude", 4, 11_000),
    candidate("codex", 5, 2 * mib),
    candidate("codex", 6, 5 * mib),
    candidate("codex", 7, 12 * mib),
    candidate("codex", 8, 64 * mib),
  ];
  const options = { seed: "discrete-byte-prefix" };
  const selection = selectStratifiedRealSample(sources, options);
  const completeOrder = selectStratifiedRealSample(sources, {
    ...options,
    fraction: 1,
  });

  for (const stratum of selection.strata) {
    const matches = ({ provider, stratum: sizeStratum }) =>
      provider === stratum.provider && sizeStratum === stratum.sizeStratum;
    const ordered = completeOrder.selected.filter(matches);
    const chosen = selection.selected.filter(matches);
    assert.equal(chosen.length >= 1, true);
    assert.deepEqual(
      chosen.map(({ token }) => token),
      ordered.slice(0, stratum.selectedFiles).map(({ token }) => token),
    );
    assert.equal(chosen.reduce((total, source) => total + source.bytes, 0), stratum.selectedBytes);

    const undershootError = Math.abs(stratum.undershootBytes - stratum.targetBytes);
    const overshootError = Math.abs(stratum.overshootBytes - stratum.targetBytes);
    if (["undershoot", "undershoot-tie"].includes(stratum.decision)) {
      assert.equal(stratum.selectedBytes, stratum.undershootBytes);
      assert.equal(undershootError <= overshootError, true);
    } else {
      assert.equal(stratum.selectedBytes, stratum.overshootBytes);
      if (stratum.decision === "overshoot") {
        assert.equal(overshootError < undershootError, true);
      }
    }
  }

  const huge = selection.strata.find(({ provider, sizeStratum }) =>
    provider === "codex" && sizeStratum === "16-mib-and-over");
  assert.deepEqual(
    {
      populationFiles: huge?.populationFiles,
      selectedFiles: huge?.selectedFiles,
      selectedBytes: huge?.selectedBytes,
      decision: huge?.decision,
    },
    {
      populationFiles: 1,
      selectedFiles: 1,
      selectedBytes: 64 * mib,
      decision: "at-least-one",
    },
  );
});

test("detail-full capacity projects the measured live-document density to 250k Turns", () => {
  assert.equal(projectedDetailFullFtsBytes(5_554_176, 3_334), 416_479_905);
  assert.throws(() => projectedDetailFullFtsBytes(1, 0), /at least one document/u);
});

test("bounded workers settle in-flight operations before rethrowing the first failure", async () => {
  let release;
  let inFlightFinished = false;
  const blocker = new Promise((resolve) => {
    release = resolve;
  });
  const running = mapLimitSettled(["fail", "slow", "unstarted"], 2, async (value) => {
    if (value === "fail") throw Object.assign(new Error("first failure"), { code: "FIRST" });
    if (value === "slow") {
      await blocker;
      inFlightFinished = true;
    }
  });
  await new Promise((resolve) => setImmediate(resolve));
  assert.equal(inFlightFinished, false);
  release();
  await assert.rejects(running, (error) => error.code === "FIRST");
  assert.equal(inFlightFinished, true);
});

function codexRecords(sessionId, marker) {
  return [
    {
      type: "session_meta",
      timestamp: "2026-08-10T00:00:00.000Z",
      payload: { id: sessionId, cwd: "/private/real-sample-project" },
    },
    { type: "event_msg", payload: { type: "task_started", turn_id: `turn-${marker}` } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `PRIVATE_REAL_SAMPLE_${marker}` }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "private answer must not enter evidence" }],
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: `turn-${marker}` } },
  ];
}

function claudeRecords(sessionId, marker) {
  return [
    {
      type: "user",
      sessionId,
      uuid: uuid(10_000 + marker * 2),
      timestamp: "2026-08-10T00:00:00.000Z",
      cwd: "/private/real-sample-project",
      message: {
        role: "user",
        content: [{ type: "text", text: `PRIVATE_REAL_SAMPLE_${marker}` }],
      },
    },
    {
      type: "assistant",
      sessionId,
      uuid: uuid(10_001 + marker * 2),
      timestamp: "2026-08-10T00:00:01.000Z",
      message: {
        role: "assistant",
        content: [{ type: "text", text: "private answer must not enter evidence" }],
      },
    },
  ];
}

test("small real-provider sample runs through discovery, reconciliation, and detail-full FTS", {
  timeout: 90_000,
  skip: E2E_SKIP,
}, async (t) => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-real-sample-test-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const sourceHome = path.join(directory, "source-home");
  const codexHome = path.join(sourceHome, "codex");
  const codexRoot = path.join(codexHome, "sessions", "2026", "08", "10");
  const claudeRoot = path.join(sourceHome, ".claude", "projects", "fixture");
  const scratch = path.join(directory, "scratch");
  await Promise.all([
    mkdir(codexRoot, { recursive: true }),
    mkdir(claudeRoot, { recursive: true }),
    mkdir(scratch, { recursive: true }),
  ]);

  const sessionIds = [];
  for (let index = 1; index <= 20; index += 1) {
    const provider = index <= 10 ? "codex" : "claude";
    const sessionId = uuid(index);
    sessionIds.push(sessionId);
    const file = provider === "codex"
      ? path.join(codexRoot, `rollout-fixture-${sessionId}.jsonl`)
      : path.join(claudeRoot, `${sessionId}.jsonl`);
    const records = provider === "codex"
      ? codexRecords(sessionId, index)
      : claudeRecords(sessionId, index);
    await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  }

  const report = await runInsightsRealSampleBenchmark({
    sourceEnvironment: { HOME: sourceHome, CODEX_HOME: codexHome },
    enginePath: DEBUG_ENGINE_PATH,
    temporaryParent: scratch,
    seed: "real-sample-e2e",
    timeoutMs: 60_000,
    deepQueryV2: true,
  });
  assert.equal(report.format, "threadshare-insights-real-sample-benchmark@v1");
  assert.equal(report.sampling.populationFiles, 20);
  assert.equal(report.sampling.selectedFiles, 6);
  assert.equal(report.sampling.strata.length, 2);
  assert.equal(report.sampling.fileFraction, 0.3);
  assert.equal(report.sampling.byteFraction >= 0.25, true);
  assert.equal(report.sampling.byteFraction <= 0.35, true);
  assert.equal(report.indexing.planned, 6);
  assert.equal(report.indexing.committed, 6);
  assert.equal(report.indexing.failed, 0);
  assert.equal(report.facts.sessions, 6);
  assert.equal(report.facts.sourceCheckpoints, 6);
  assert.equal(report.fts.detail, "full");
  assert.equal(report.gates.analyzerIdentityMatches, true);
  assert.equal(report.fts.documents > 0, true);
  assert.equal(report.fts.detailFullBytes > 0, true);
  assert.equal(report.fts.projectedAt250000TurnsBytes > report.fts.detailFullBytes, true);
  assert.match(report.hashes.selectedSnapshotContentDigest, /^[0-9a-f]{64}$/u);
  assert.equal(report.storage.ftsIntegrityCheck, "ok");
  assert.equal(report.deepQueryV2.committedDeltaCount, 6);
  assert.equal(report.deepQueryV2.syncWallMs > 0, true);
  assert.equal(report.deepQueryV2.commitAckMs.count, 6);
  assert.equal(report.deepQueryV2.commitAckMs.p50 > 0, true);
  assert.equal(report.deepQueryV2.rows.historyEvents > 0, true);
  assert.equal(report.deepQueryV2.rows.historyPayloads > 0, true);
  assert.equal(report.deepQueryV2.rows.historyPayloadChunks > 0, true);
  assert.equal(report.deepQueryV2.storage.historyEventMetadataBytes > 0, true);
  assert.equal(report.deepQueryV2.storage.historyPayloadBytes > 0, true);
  assert.equal(report.deepQueryV2.storage.historyFtsBytes > 0, true);
  assert.equal(report.deepQueryV2.historyFtsIntegrity, "ok");
  assert.equal(report.deepQueryV2.gates.committedDeltaCoverage, true);
  assert.equal(report.deepQueryV2.gates.nonemptyHistory, true);
  assert.equal(report.deepQueryV2.gates.historyFtsIntegrityPassed, true);
  assert.equal(report.gates.ftsIntegrityCheckPassed, true);
  assert.equal(report.gates.dedupeCountsConsistent, true);
  assert.equal(Object.hasOwn(report.gates, "longTermProjectionGateSkipped"), false);
  assert.equal(report.gates.overallByteFractionWithinRange, true);
  assert.equal(report.gates.allMeasuredGatesPassed, report.gates.detailFullFtsWithinLimit);
  assert.equal(report.privacy.temporaryStatePersisted, false);
  assert.equal(assertAggregateArtifactPrivacy(report), report);
  assert.deepEqual(await readdir(scratch), []);

  const serialized = JSON.stringify(report);
  assert.equal(serialized.includes(directory), false);
  assert.equal(serialized.includes("PRIVATE_REAL_SAMPLE"), false);
  assert.equal(serialized.includes("private answer"), false);
  assert.equal(sessionIds.some((sessionId) => serialized.includes(sessionId)), false);

  await assert.rejects(runInsightsRealSampleBenchmark({
    sourceEnvironment: { HOME: sourceHome, CODEX_HOME: codexHome },
    enginePath: path.join(directory, "missing-engine"),
    temporaryParent: scratch,
    seed: "real-sample-failure-cleanup",
    timeoutMs: 5_000,
  }));
  assert.deepEqual(await readdir(scratch), []);
});

test("real-sample Engine identity allowlist fails closed", () => {
  const valid = {
    format: "threadshare-insights-engine-version@v1",
    engineVersion: "0.0.0",
    protocolVersion: 1,
    target: "development",
    sqliteVersion: "3.53.2",
    sqliteCompileOptionsDigest: "a".repeat(64),
    buildManifestDigest: "b".repeat(64),
  };
  assert.equal(assertAllowedEngineIdentity(valid), valid);
  assert.throws(
    () => assertAllowedEngineIdentity({ ...valid, sqliteVersion: "3.53.3" }),
    /outside the frozen ITEM-5 allowlist/u,
  );
  assert.throws(
    () => assertAllowedEngineIdentity({ ...valid, sourcePath: "/tmp/private" }),
    /unexpected shape/u,
  );
});
