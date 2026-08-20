import assert from "node:assert/strict";
import { chmod, mkdtemp, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { computePlanDigest, computeRunnerInputDigest } from "../src/memory-contracts.mjs";
import {
  ADJUDICATION_PROMPT,
  EXTRACTION_PROMPT,
  MEMORY_PROMPTS,
  PROMPT_VERSION,
  TRANSCRIPT_PREAMBLE,
} from "../src/memory-prompts.mjs";
import {
  CONFORMANCE_TEST_VERSION,
  approveManifest,
  approvePlan,
  approvePlanFromManifest,
  buildAuthorizationManifest,
  buildExecutionPlan,
  computeCliVersionFingerprint,
  isConformanceValid,
  loadRunnerProfile,
  runConformanceTest,
  runExtractionRunner,
} from "../src/memory-runner.mjs";

const FIXTURES = fileURLToPath(new URL("./fixtures/memory-runner/", import.meta.url));
const CONFORMANT = path.join(FIXTURES, "fake-conformant.mjs");
const VIOLATING = path.join(FIXTURES, "fake-violating.mjs");
const ECHO = path.join(FIXTURES, "fake-echo.mjs");
const HANG = path.join(FIXTURES, "fake-hang.mjs");
const FLOOD = path.join(FIXTURES, "fake-flood.mjs");

// The fake runners rely on their shebang; make sure they are executable even on
// checkouts that lost the executable bit.
for (const script of [CONFORMANT, VIOLATING, ECHO, HANG, FLOOD]) {
  await chmod(script, 0o755);
}

const HEX64_PATTERN = /^[0-9a-f]{64}$/;

function makeCoverage(sourceId = "chunk-0001") {
  return [
    {
      sourceKind: "transcript",
      opaqueSourceId: sourceId,
      revision: null,
      contentDigest: "a".repeat(64),
      bytes: 123,
      truncated: false,
    },
  ];
}

function makePlan(stdinBytes, overrides = {}) {
  return buildExecutionPlan({
    taskKind: "extraction",
    taskId: "task-0001",
    stdinBytes,
    inputCoverage: makeCoverage(),
    profile: loadRunnerProfile("claude-cli"),
    provider: "anthropic",
    model: "claude-fake",
    endpoint: "https://api.example.invalid/v1/messages",
    ...overrides,
  });
}

async function conformanceFor(binaryPath) {
  return {
    testVersion: CONFORMANCE_TEST_VERSION,
    cliVersionFingerprint: await computeCliVersionFingerprint(binaryPath),
    passedAt: new Date().toISOString(),
  };
}

function assertCode(code) {
  return (error) => {
    assert.equal(error.code, code, `expected code ${code}, got ${error.code}: ${error.message}`);
    return true;
  };
}

// ---------------------------------------------------------------------------
// Profiles
// ---------------------------------------------------------------------------

test("loadRunnerProfile returns a schema-valid claude-cli profile", () => {
  const profile = loadRunnerProfile("claude-cli");
  assert.equal(profile.adapter, "claude-cli");
  assert.deepEqual(profile.argvTemplate, [
    "--tools",
    "",
    "--bare",
    "--safe-mode",
    "--no-session-persistence",
    "--strict-mcp-config",
    "-p",
  ]);
  assert.equal(profile.toolPolicy, "none");
  assert.equal(profile.network, "model-only");
  assert.equal(profile.ephemeral, "required");
  assert.equal(profile.conformance, null);
});

test("loadRunnerProfile rejects unknown profile names", () => {
  assert.throws(() => loadRunnerProfile("gemini-cli"), assertCode("MEMORY_RUNNER_UNKNOWN_PROFILE"));
});

test("codex profile hard-fails on every execution entry point", async () => {
  const codex = loadRunnerProfile("codex-cli");
  assert.equal(codex.adapter, "codex-cli");
  await assert.rejects(runConformanceTest(codex), (error) => {
    assert.equal(error.code, "MEMORY_RUNNER_CODEX_UNSUPPORTED");
    assert.match(error.message, /no-tools/);
    assert.match(error.message, /re-evaluate/i);
    return true;
  });
  await assert.rejects(
    runExtractionRunner({ profile: codex, conformance: null, plan: null, stdinBytes: "x" }),
    assertCode("MEMORY_RUNNER_CODEX_UNSUPPORTED"),
  );
});

// ---------------------------------------------------------------------------
// Conformance test
// ---------------------------------------------------------------------------

test("conformant runner passes the deny-all probe and yields a fingerprint record", async () => {
  const result = await runConformanceTest(loadRunnerProfile("claude-cli"), {
    binaryPath: CONFORMANT,
    timeoutMs: 30_000,
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.record.testVersion, CONFORMANCE_TEST_VERSION);
  assert.match(result.record.cliVersionFingerprint, HEX64_PATTERN);
  assert.ok(!Number.isNaN(Date.parse(result.record.passedAt)));
  assert.equal(
    result.record.cliVersionFingerprint,
    await computeCliVersionFingerprint(CONFORMANT),
  );
});

test("violating runner fails on both the canary and the filesystem side effect", async () => {
  const result = await runConformanceTest(loadRunnerProfile("claude-cli"), {
    binaryPath: VIOLATING,
    timeoutMs: 30_000,
  });
  assert.equal(result.passed, false);
  assert.equal(result.record, null);
  const codes = result.failures.map((failure) => failure.code);
  assert.ok(codes.includes("MEMORY_RUNNER_CONFORMANCE_CANARY"), `missing canary failure: ${codes}`);
  assert.ok(
    codes.includes("MEMORY_RUNNER_CONFORMANCE_SIDE_EFFECT"),
    `missing side-effect failure: ${codes}`,
  );
});

test("fingerprint drift invalidates a cached conformance record", async () => {
  const record = (
    await runConformanceTest(loadRunnerProfile("claude-cli"), {
      binaryPath: CONFORMANT,
      timeoutMs: 30_000,
    })
  ).record;
  const sameBinary = await computeCliVersionFingerprint(CONFORMANT);
  const otherBinary = await computeCliVersionFingerprint(ECHO);
  assert.equal(isConformanceValid(record, { cliVersionFingerprint: sameBinary }), true);
  assert.equal(isConformanceValid(record, { cliVersionFingerprint: otherBinary }), false);
  assert.equal(
    isConformanceValid(record, {
      testVersion: "conformance-test@2",
      cliVersionFingerprint: sameBinary,
    }),
    false,
  );
  assert.equal(isConformanceValid(null, { cliVersionFingerprint: sameBinary }), false);
});

// ---------------------------------------------------------------------------
// Plans, approval, manifests
// ---------------------------------------------------------------------------

test("buildExecutionPlan binds exact input bytes and starts pending", () => {
  const stdin = "extraction task payload";
  const plan = makePlan(stdin);
  assert.equal(plan.authorization, "pending");
  assert.equal(plan.localSessionPersistence, "none");
  assert.equal(plan.providerRetention, "unknown");
  assert.equal(plan.bytesToSend, Buffer.byteLength(stdin, "utf8"));
  assert.equal(plan.runnerInputDigest, computeRunnerInputDigest(stdin));
  assert.match(plan.inputCoverageDigest, HEX64_PATTERN);
  assert.equal(plan.planDigest, computePlanDigest(plan));
});

test("approvePlan only accepts the exact plan digest", () => {
  const plan = makePlan("payload");
  assert.throws(
    () => approvePlan(plan, { approvedDigest: "f".repeat(64) }),
    assertCode("MEMORY_RUNNER_APPROVAL_MISMATCH"),
  );
  assert.throws(() => approvePlan(plan, {}), assertCode("MEMORY_RUNNER_APPROVAL_MISMATCH"));
  const approved = approvePlan(plan, { approvedDigest: plan.planDigest });
  assert.equal(approved.authorization, "approved");
  assert.equal(approved.planDigest, plan.planDigest);
  assert.ok(Object.isFrozen(approved));
});

test("same byte count with different content produces a different plan digest", () => {
  const planA = makePlan("content-A!");
  const planB = makePlan("content-B!");
  assert.equal(planA.bytesToSend, planB.bytesToSend);
  assert.notEqual(planA.runnerInputDigest, planB.runnerInputDigest);
  assert.notEqual(planA.planDigest, planB.planDigest);
});

test("manifest lists every plan digest and approves plans individually", () => {
  const planA = makePlan("manifest payload A", { taskId: "task-a" });
  const planB = makePlan("manifest payload B!", { taskId: "task-b" });
  const manifest = buildAuthorizationManifest([planA, planB]);
  assert.equal(manifest.authorization, "pending");
  assert.deepEqual(
    manifest.plans.map((entry) => entry.planDigest),
    [planA.planDigest, planB.planDigest],
  );
  assert.equal(manifest.totalBytes, planA.bytesToSend + planB.bytesToSend);

  assert.throws(
    () => approveManifest(manifest, { approvedDigest: "f".repeat(64) }),
    assertCode("MEMORY_RUNNER_APPROVAL_MISMATCH"),
  );
  assert.throws(
    () => approvePlanFromManifest(planA, manifest),
    assertCode("MEMORY_RUNNER_MANIFEST_NOT_APPROVED"),
  );

  const approvedManifest = approveManifest(manifest, { approvedDigest: manifest.manifestDigest });
  const approvedA = approvePlanFromManifest(planA, approvedManifest);
  const approvedB = approvePlanFromManifest(planB, approvedManifest);
  assert.equal(approvedA.authorization, "approved");
  assert.equal(approvedB.authorization, "approved");
});

test("a single plan's input change invalidates only that plan within the manifest", async () => {
  const planA = makePlan("manifest input A1", { taskId: "task-a" });
  const planB = makePlan("manifest input B1", { taskId: "task-b" });
  const manifest = approveManifest(buildAuthorizationManifest([planA, planB]), {
    approvedDigest: buildAuthorizationManifest([planA, planB]).manifestDigest,
  });
  const approvedA = approvePlanFromManifest(planA, manifest);
  const approvedB = approvePlanFromManifest(planB, manifest);

  // Plan A's input changed after authorization: the rebuilt plan is not listed in
  // the manifest, and the previously approved plan no longer matches the new bytes.
  const rebuiltA = makePlan("manifest input A2", { taskId: "task-a" });
  assert.throws(
    () => approvePlanFromManifest(rebuiltA, manifest),
    assertCode("MEMORY_RUNNER_PLAN_NOT_IN_MANIFEST"),
  );
  const conformance = await conformanceFor(ECHO);
  await assert.rejects(
    runExtractionRunner({
      profile: loadRunnerProfile("claude-cli"),
      conformance,
      plan: approvedA,
      stdinBytes: "manifest input A2",
      binaryPath: ECHO,
      timeoutMs: 30_000,
    }),
    assertCode("MEMORY_RUNNER_PLAN_MISMATCH"),
  );

  // Plan B is unaffected and still executes.
  const result = await runExtractionRunner({
    profile: loadRunnerProfile("claude-cli"),
    conformance,
    plan: approvedB,
    stdinBytes: "manifest input B1",
    binaryPath: ECHO,
    timeoutMs: 30_000,
  });
  assert.equal(result.exitCode, 0);
  assert.equal(JSON.parse(result.stdout).ok, true);
});

// ---------------------------------------------------------------------------
// Execution gating
// ---------------------------------------------------------------------------

async function withMarker(run) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-memory-runner-test-"));
  const marker = path.join(directory, "marker");
  process.env.FAKE_RUNNER_MARKER = marker;
  try {
    await run(marker);
  } finally {
    delete process.env.FAKE_RUNNER_MARKER;
    await rm(directory, { recursive: true, force: true });
  }
}

test("pending plans never execute", async () => {
  const plan = makePlan("pending payload");
  await withMarker(async (marker) => {
    await assert.rejects(
      runExtractionRunner({
        profile: loadRunnerProfile("claude-cli"),
        conformance: await conformanceFor(ECHO),
        plan,
        stdinBytes: "pending payload",
        binaryPath: ECHO,
        timeoutMs: 30_000,
      }),
      assertCode("MEMORY_RUNNER_PLAN_NOT_APPROVED"),
    );
    assert.equal(existsSync(marker), false, "runner process must not have executed");
  });
});

test("stdin digest mismatch refuses without starting the runner process", async () => {
  const plan = makePlan("content-A!");
  const approved = approvePlan(plan, { approvedDigest: plan.planDigest });
  await withMarker(async (marker) => {
    await assert.rejects(
      runExtractionRunner({
        profile: loadRunnerProfile("claude-cli"),
        conformance: await conformanceFor(ECHO),
        plan: approved,
        // Same byte count, different content: the digest must change and be refused.
        stdinBytes: "content-B!",
        binaryPath: ECHO,
        timeoutMs: 30_000,
      }),
      assertCode("MEMORY_RUNNER_PLAN_MISMATCH"),
    );
    assert.equal(existsSync(marker), false, "runner process must not have executed");
  });
});

test("missing or stale conformance refuses execution with no degraded path", async () => {
  const plan = makePlan("conformance payload");
  const approved = approvePlan(plan, { approvedDigest: plan.planDigest });
  await withMarker(async (marker) => {
    await assert.rejects(
      runExtractionRunner({
        profile: loadRunnerProfile("claude-cli"),
        conformance: null,
        plan: approved,
        stdinBytes: "conformance payload",
        binaryPath: ECHO,
        timeoutMs: 30_000,
      }),
      assertCode("MEMORY_RUNNER_NOT_CONFORMANT"),
    );
    await assert.rejects(
      runExtractionRunner({
        profile: loadRunnerProfile("claude-cli"),
        // Fingerprint taken from a different binary: stale for ECHO.
        conformance: await conformanceFor(CONFORMANT),
        plan: approved,
        stdinBytes: "conformance payload",
        binaryPath: ECHO,
        timeoutMs: 30_000,
      }),
      assertCode("MEMORY_RUNNER_NOT_CONFORMANT"),
    );
    assert.equal(existsSync(marker), false, "runner process must not have executed");
  });
});

test("approved plan with matching stdin executes and returns stdout", async () => {
  const stdin = "extraction task stdin bytes";
  const plan = makePlan(stdin);
  const approved = approvePlan(plan, { approvedDigest: plan.planDigest });
  await withMarker(async (marker) => {
    const result = await runExtractionRunner({
      profile: loadRunnerProfile("claude-cli"),
      conformance: await conformanceFor(ECHO),
      plan: approved,
      stdinBytes: stdin,
      binaryPath: ECHO,
      timeoutMs: 30_000,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(typeof result.durationMs, "number");
    assert.deepEqual(JSON.parse(result.stdout), {
      ok: true,
      receivedBytes: Buffer.byteLength(stdin, "utf8"),
    });
    assert.equal(existsSync(marker), true, "runner process should have executed");
  });
});

test("runner exceeding the timeout is killed", async () => {
  const stdin = "hang payload";
  const plan = makePlan(stdin);
  const approved = approvePlan(plan, { approvedDigest: plan.planDigest });
  await assert.rejects(
    runExtractionRunner({
      profile: loadRunnerProfile("claude-cli"),
      conformance: await conformanceFor(HANG),
      plan: approved,
      stdinBytes: stdin,
      binaryPath: HANG,
      timeoutMs: 500,
    }),
    assertCode("MEMORY_RUNNER_TIMEOUT"),
  );
});

test("runner exceeding the output limit is killed", async () => {
  const stdin = "flood payload";
  const plan = makePlan(stdin);
  const approved = approvePlan(plan, { approvedDigest: plan.planDigest });
  await assert.rejects(
    runExtractionRunner({
      profile: loadRunnerProfile("claude-cli"),
      conformance: await conformanceFor(FLOOD),
      plan: approved,
      stdinBytes: stdin,
      binaryPath: FLOOD,
      timeoutMs: 30_000,
      maxOutputBytes: 64 * 1024,
    }),
    assertCode("MEMORY_RUNNER_OUTPUT_LIMIT"),
  );
});

// ---------------------------------------------------------------------------
// Prompts
// ---------------------------------------------------------------------------

test("prompts are versioned and carry the contract vocabulary", () => {
  assert.equal(PROMPT_VERSION, "memory-prompts@1");
  assert.equal(MEMORY_PROMPTS.version, PROMPT_VERSION);
  assert.equal(MEMORY_PROMPTS.extraction, EXTRACTION_PROMPT);
  assert.equal(MEMORY_PROMPTS.adjudication, ADJUDICATION_PROMPT);
  assert.equal(MEMORY_PROMPTS.transcriptPreamble, TRANSCRIPT_PREAMBLE);
});

test("extraction prompt states the CandidateDraftBatch contract without skill sentinels", () => {
  assert.ok(EXTRACTION_PROMPT.includes("threadshare-memory-candidate-draft-batch@v1"));
  for (const type of ["work_fact", "work_task", "work_method", "work_artifact"]) {
    assert.ok(EXTRACTION_PROMPT.includes(type), `missing memory type ${type}`);
  }
  assert.ok(EXTRACTION_PROMPT.includes("evidenceIds"));
  assert.ok(EXTRACTION_PROMPT.includes("evidenceCatalog"));
  assert.match(EXTRACTION_PROMPT, /suggestion is not a decision/i);
  assert.match(EXTRACTION_PROMPT, /never output secrets/i);
  // "Nothing to save." belongs to the separate skill-extraction contract (§6.7).
  assert.ok(!EXTRACTION_PROMPT.includes("Nothing to save."));
});

test("adjudication prompt states the AdjudicationResult contract", () => {
  assert.ok(ADJUDICATION_PROMPT.includes("threadshare-memory-adjudication-result@v1"));
  for (const action of ['"store"', '"skip"', '"update"', '"merge"']) {
    assert.ok(ADJUDICATION_PROMPT.includes(action), `missing action ${action}`);
  }
  assert.match(ADJUDICATION_PROMPT, /unified/i);
  assert.match(ADJUDICATION_PROMPT, /many-to-many/i);
  assert.match(ADJUDICATION_PROMPT, /union/i);
});

test("transcript preamble defends against role capture", () => {
  assert.ok(TRANSCRIPT_PREAMBLE.includes("<<past-"));
  assert.ok(TRANSCRIPT_PREAMBLE.includes("<<end-of-transcript>>"));
  assert.match(TRANSCRIPT_PREAMBLE, /NOT addressed to you/);
  assert.match(TRANSCRIPT_PREAMBLE, /replying to the past user/i);
  assert.match(TRANSCRIPT_PREAMBLE, /stop immediately/i);
});
