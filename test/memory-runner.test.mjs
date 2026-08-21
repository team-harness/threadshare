import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import { appendFile, chmod, copyFile, mkdtemp, realpath, rm } from "node:fs/promises";
import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "../src/canonical-json.mjs";
import {
  computeManifestDigest,
  computePlanDigest,
  computeRunnerInputDigest,
} from "../src/memory-contracts.mjs";
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
  computeRunnerBinaryIdentity,
  computeRunnerProfileDigest,
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
const NETWORK_VIOLATING = path.join(FIXTURES, "fake-network-violating.mjs");
const LINGERING = path.join(FIXTURES, "fake-lingering.mjs");

// The fake runners rely on their shebang; make sure they are executable even on
// checkouts that lost the executable bit.
for (const script of [CONFORMANT, VIOLATING, ECHO, HANG, FLOOD, NETWORK_VIOLATING, LINGERING]) {
  await chmod(script, 0o755);
}

const HEX64_PATTERN = /^[0-9a-f]{64}$/;

// A stand-in for the origin-derived signing key the upper layer supplies. Two
// distinct keys let the tests prove key binding (a record signed under one is
// not accepted under the other). Both are >= 16 bytes.
const SIGNING_KEY = Buffer.from("a1b2c3d4e5f60718293a4b5c6d7e8f90", "hex");
const OTHER_SIGNING_KEY = Buffer.from("00112233445566778899aabbccddeeff", "hex");

// Independent re-implementation of the record HMAC (HMAC-SHA256 over the
// canonical record content, excluding the signature field). The test signs its
// hand-built records so they mirror what runConformanceTest would produce.
function signConformanceRecord(record, key = SIGNING_KEY) {
  const { signature: _signature, ...content } = record;
  return {
    ...content,
    signature: createHmac("sha256", key).update(canonicalJson(content), "utf8").digest("hex"),
  };
}

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

async function conformanceFor(binaryPath, profile = loadRunnerProfile("claude-cli"), key = SIGNING_KEY) {
  const identity = await computeRunnerBinaryIdentity(binaryPath);
  return signConformanceRecord({
    testVersion: CONFORMANCE_TEST_VERSION,
    profileDigest: computeRunnerProfileDigest(profile),
    binaryRealpath: identity.binaryRealpath,
    binaryContentSha256: identity.binaryContentSha256,
    cliVersionFingerprint: await computeCliVersionFingerprint(binaryPath),
    passedAt: new Date().toISOString(),
  }, key);
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

test("codex profile binds exact model/endpoint and disables every ambient execution surface", async () => {
  const codex = loadRunnerProfile("codex-cli", {
    model: "gpt-5.6-sol",
    endpoint: "https://api.openai.com/v1",
  });
  assert.equal(codex.adapter, "codex-cli");
  assert.equal(codex.version, "2");
  assert.ok(codex.argvTemplate.includes("exec"));
  assert.ok(codex.argvTemplate.includes("--ephemeral"));
  assert.ok(codex.argvTemplate.includes("--ignore-user-config"));
  assert.ok(codex.argvTemplate.includes("--ignore-rules"));
  assert.ok(codex.argvTemplate.includes("gpt-5.6-sol"));
  assert.ok(codex.argvTemplate.includes('model_providers.threadshare_memory.base_url="https://api.openai.com/v1"'));
  for (const feature of [
    "shell_tool", "unified_exec", "code_mode_host", "apps", "plugins", "browser_use",
    "computer_use", "hooks", "image_generation", "multi_agent", "view_image",
  ]) {
    const index = codex.argvTemplate.indexOf(feature);
    assert.notEqual(index, -1, `missing Codex deny flag for ${feature}`);
    assert.equal(codex.argvTemplate[index - 1], "--disable");
  }
  assert.deepEqual(codex.argvTemplate.slice(-1), ["-"]);
  assert.equal(codex.toolPolicy, "none");
  await assert.rejects(
    runConformanceTest(codex),
    assertCode("MEMORY_RUNNER_SIGNING_KEY_REQUIRED"),
  );
});

test("codex runner receives no arbitrary host environment secrets", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadshare-memory-codex-env-"));
  const previous = process.env.THREADSHARE_MEMORY_FORBIDDEN_SECRET;
  process.env.THREADSHARE_MEMORY_FORBIDDEN_SECRET = "must-not-reach-runner";
  try {
    const profile = loadRunnerProfile("codex-cli", {
      model: "gpt-test",
      endpoint: "https://api.example.invalid/v1",
    });
    const conformance = await runConformanceTest(profile, {
      binaryPath: CONFORMANT,
      codexAuthPath: path.join(root, "missing-auth.json"),
      tempRoot: root,
      signingKey: SIGNING_KEY,
    });
    assert.equal(conformance.passed, true);
    const stdinBytes = Buffer.from("bounded test input", "utf8");
    const pending = buildExecutionPlan({
      taskKind: "extraction",
      taskId: "codex-env-task",
      stdinBytes,
      inputCoverage: makeCoverage(),
      profile,
      provider: "openai",
      model: "gpt-test",
      endpoint: "https://api.example.invalid/v1",
    });
    const execution = await runExtractionRunner({
      profile,
      conformance: conformance.record,
      plan: approvePlan(pending, { approvedDigest: pending.planDigest }),
      stdinBytes,
      binaryPath: CONFORMANT,
      codexAuthPath: path.join(root, "missing-auth.json"),
      tempRoot: root,
      signingKey: SIGNING_KEY,
    });
    assert.equal(JSON.parse(execution.stdout).environmentLeak, null);
  } finally {
    if (previous === undefined) delete process.env.THREADSHARE_MEMORY_FORBIDDEN_SECRET;
    else process.env.THREADSHARE_MEMORY_FORBIDDEN_SECRET = previous;
    await rm(root, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Conformance test
// ---------------------------------------------------------------------------

test("conformant runner passes the deny-all probe and yields a bound identity record", async () => {
  const result = await runConformanceTest(loadRunnerProfile("claude-cli"), {
    binaryPath: CONFORMANT,
    timeoutMs: 30_000,
    signingKey: SIGNING_KEY,
  });
  assert.equal(result.passed, true);
  assert.deepEqual(result.failures, []);
  assert.equal(result.record.testVersion, CONFORMANCE_TEST_VERSION);
  // The passing record is HMAC-signed, and the signature verifies under the key.
  assert.match(result.record.signature, HEX64_PATTERN);
  assert.equal(result.record.signature, signConformanceRecord(result.record).signature);
  // The record binds the profile (including argvTemplate) and the binary bytes.
  assert.equal(
    result.record.profileDigest,
    computeRunnerProfileDigest(loadRunnerProfile("claude-cli")),
  );
  const identity = await computeRunnerBinaryIdentity(CONFORMANT);
  assert.equal(result.record.binaryRealpath, identity.binaryRealpath);
  assert.equal(result.record.binaryRealpath, await realpath(CONFORMANT));
  assert.equal(result.record.binaryContentSha256, identity.binaryContentSha256);
  assert.match(result.record.binaryContentSha256, HEX64_PATTERN);
  // cliVersionFingerprint is retained as supplemental information only.
  assert.match(result.record.cliVersionFingerprint, HEX64_PATTERN);
  assert.ok(!Number.isNaN(Date.parse(result.record.passedAt)));
});

test("registered runner command resolves from PATH before identity binding and execution", async () => {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadshare-memory-runner-path-"));
  const binary = path.join(root, "claude");
  const previousPath = process.env.PATH;
  try {
    await copyFile(CONFORMANT, binary);
    await chmod(binary, 0o755);
    process.env.PATH = `${root}${path.delimiter}${previousPath ?? ""}`;
    const result = await runConformanceTest(loadRunnerProfile("claude-cli"), {
      timeoutMs: 30_000,
      signingKey: SIGNING_KEY,
    });
    assert.equal(result.passed, true);
    assert.equal(result.record.binaryRealpath, await realpath(binary));
  } finally {
    if (previousPath === undefined) delete process.env.PATH;
    else process.env.PATH = previousPath;
    await rm(root, { recursive: true, force: true });
  }
});

test("runner connecting to the network canary fails conformance", async () => {
  const result = await runConformanceTest(loadRunnerProfile("claude-cli"), {
    binaryPath: NETWORK_VIOLATING,
    timeoutMs: 30_000,
    signingKey: SIGNING_KEY,
  });
  assert.equal(result.passed, false);
  assert.equal(result.record, null);
  const codes = result.failures.map((failure) => failure.code);
  assert.ok(
    codes.includes("MEMORY_RUNNER_CONFORMANCE_NETWORK"),
    `missing network failure: ${codes}`,
  );
});

test("runner leaving a lingering child process fails conformance", async () => {
  const result = await runConformanceTest(loadRunnerProfile("claude-cli"), {
    binaryPath: LINGERING,
    timeoutMs: 30_000,
    signingKey: SIGNING_KEY,
  });
  assert.equal(result.passed, false);
  assert.equal(result.record, null);
  const codes = result.failures.map((failure) => failure.code);
  assert.ok(
    codes.includes("MEMORY_RUNNER_CONFORMANCE_LINGERING"),
    `missing lingering-process failure: ${codes}`,
  );
});

test("violating runner fails on both the canary and the filesystem side effect", async () => {
  const result = await runConformanceTest(loadRunnerProfile("claude-cli"), {
    binaryPath: VIOLATING,
    timeoutMs: 30_000,
    signingKey: SIGNING_KEY,
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

test("binary or profile identity drift invalidates a cached conformance record", async () => {
  const record = (
    await runConformanceTest(loadRunnerProfile("claude-cli"), {
      binaryPath: CONFORMANT,
      timeoutMs: 30_000,
      signingKey: SIGNING_KEY,
    })
  ).record;
  const key = { signingKey: SIGNING_KEY };
  const profileDigest = computeRunnerProfileDigest(loadRunnerProfile("claude-cli"));
  const sameBinary = await computeRunnerBinaryIdentity(CONFORMANT);
  const otherBinary = await computeRunnerBinaryIdentity(ECHO);
  assert.equal(isConformanceValid(record, { profileDigest, ...sameBinary }, key), true);
  assert.equal(isConformanceValid(record, { profileDigest, ...otherBinary }, key), false);
  // Every field is compared individually: realpath and content hash both bind.
  assert.equal(
    isConformanceValid(record, {
      profileDigest,
      binaryRealpath: otherBinary.binaryRealpath,
      binaryContentSha256: sameBinary.binaryContentSha256,
    }, key),
    false,
  );
  assert.equal(
    isConformanceValid(record, {
      profileDigest,
      binaryRealpath: sameBinary.binaryRealpath,
      binaryContentSha256: otherBinary.binaryContentSha256,
    }, key),
    false,
  );
  // A profile change (any argvTemplate edit) invalidates the record too.
  const profile = loadRunnerProfile("claude-cli");
  const alteredDigest = computeRunnerProfileDigest({
    ...profile,
    argvTemplate: [...profile.argvTemplate, "--verbose"],
  });
  assert.equal(isConformanceValid(record, { profileDigest: alteredDigest, ...sameBinary }, key), false);
  assert.equal(
    isConformanceValid(record, {
      testVersion: "conformance-test@2",
      profileDigest,
      ...sameBinary,
    }, key),
    false,
  );
  assert.equal(isConformanceValid(null, { profileDigest, ...sameBinary }, key), false);
});

test("same binaryPath with replaced content but identical --version output fails conformance", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-memory-runner-swap-"));
  const binary = path.join(directory, "fake-echo.mjs");
  try {
    await copyFile(ECHO, binary);
    await chmod(binary, 0o755);
    const record = await conformanceFor(binary);
    // Replace the binary content in place; a trailing comment keeps the
    // --version output byte-identical, so the legacy fingerprint still matches.
    await appendFile(binary, "\n// tampered after conformance\n");
    assert.equal(await computeCliVersionFingerprint(binary), record.cliVersionFingerprint);
    const identity = await computeRunnerBinaryIdentity(binary);
    assert.notEqual(identity.binaryContentSha256, record.binaryContentSha256);
    assert.equal(
      isConformanceValid(record, {
        profileDigest: record.profileDigest,
        ...identity,
      }, { signingKey: SIGNING_KEY }),
      false,
    );
    const plan = makePlan("swap payload");
    const approved = approvePlan(plan, { approvedDigest: plan.planDigest });
    await withMarker(async (marker) => {
      await assert.rejects(
        runExtractionRunner({
          profile: loadRunnerProfile("claude-cli"),
          conformance: record,
          plan: approved,
          stdinBytes: "swap payload",
          binaryPath: binary,
          timeoutMs: 30_000,
          signingKey: SIGNING_KEY,
        }),
        assertCode("MEMORY_RUNNER_NOT_CONFORMANT"),
      );
      assert.equal(existsSync(marker), false, "tampered binary must not have executed");
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

// ---------------------------------------------------------------------------
// Conformance record authenticity (HMAC signature)
// ---------------------------------------------------------------------------

test("runConformanceTest fails closed without a signing key", async () => {
  await assert.rejects(
    runConformanceTest(loadRunnerProfile("claude-cli"), {
      binaryPath: CONFORMANT,
      timeoutMs: 30_000,
    }),
    assertCode("MEMORY_RUNNER_SIGNING_KEY_REQUIRED"),
  );
  // A too-short key is treated as no key at all.
  await assert.rejects(
    runConformanceTest(loadRunnerProfile("claude-cli"), {
      binaryPath: CONFORMANT,
      timeoutMs: 30_000,
      signingKey: Buffer.from("short"),
    }),
    assertCode("MEMORY_RUNNER_SIGNING_KEY_REQUIRED"),
  );
});

test("a record forged from public fields is rejected without a valid signature", async () => {
  const identity = await computeRunnerBinaryIdentity(ECHO);
  const current = {
    profileDigest: computeRunnerProfileDigest(loadRunnerProfile("claude-cli")),
    binaryRealpath: identity.binaryRealpath,
    binaryContentSha256: identity.binaryContentSha256,
  };
  // Anyone can assemble these public fields; without the origin-derived key they
  // cannot produce a verifying signature.
  const forged = {
    testVersion: CONFORMANCE_TEST_VERSION,
    ...current,
    cliVersionFingerprint: await computeCliVersionFingerprint(ECHO),
    passedAt: new Date().toISOString(),
  };
  // No signature at all.
  assert.equal(isConformanceValid(forged, current, { signingKey: SIGNING_KEY }), false);
  // A bogus signature does not verify.
  assert.equal(
    isConformanceValid({ ...forged, signature: "0".repeat(64) }, current, { signingKey: SIGNING_KEY }),
    false,
  );
  // Even a correctly signed record is invalid when checked with no key (fail-closed).
  const signed = signConformanceRecord(forged);
  assert.equal(isConformanceValid(signed, current), false);
  assert.equal(isConformanceValid(signed, current, {}), false);
  // Correctly signed and checked with the matching key: valid.
  assert.equal(isConformanceValid(signed, current, { signingKey: SIGNING_KEY }), true);
});

test("a record signed under a different key is not accepted", async () => {
  const identity = await computeRunnerBinaryIdentity(ECHO);
  const current = {
    profileDigest: computeRunnerProfileDigest(loadRunnerProfile("claude-cli")),
    binaryRealpath: identity.binaryRealpath,
    binaryContentSha256: identity.binaryContentSha256,
  };
  const record = await conformanceFor(ECHO, loadRunnerProfile("claude-cli"), OTHER_SIGNING_KEY);
  // Signed under OTHER_SIGNING_KEY: verifies with that key, not with SIGNING_KEY.
  assert.equal(isConformanceValid(record, current, { signingKey: OTHER_SIGNING_KEY }), true);
  assert.equal(isConformanceValid(record, current, { signingKey: SIGNING_KEY }), false);
});

test("runExtractionRunner refuses a forged or wrongly-keyed record and never spawns", async () => {
  const stdin = "forgery payload";
  const plan = makePlan(stdin);
  const approved = approvePlan(plan, { approvedDigest: plan.planDigest });
  const identity = await computeRunnerBinaryIdentity(ECHO);
  const forged = {
    testVersion: CONFORMANCE_TEST_VERSION,
    profileDigest: computeRunnerProfileDigest(loadRunnerProfile("claude-cli")),
    binaryRealpath: identity.binaryRealpath,
    binaryContentSha256: identity.binaryContentSha256,
    cliVersionFingerprint: await computeCliVersionFingerprint(ECHO),
    passedAt: new Date().toISOString(),
  };
  await withMarker(async (marker) => {
    // Unsigned forgery is refused before any spawn.
    await assert.rejects(
      runExtractionRunner({
        profile: loadRunnerProfile("claude-cli"),
        conformance: forged,
        plan: approved,
        stdinBytes: stdin,
        binaryPath: ECHO,
        timeoutMs: 30_000,
        signingKey: SIGNING_KEY,
      }),
      assertCode("MEMORY_RUNNER_NOT_CONFORMANT"),
    );
    // A record honestly signed under another key does not verify under this key.
    const otherKeyed = signConformanceRecord(forged, OTHER_SIGNING_KEY);
    await assert.rejects(
      runExtractionRunner({
        profile: loadRunnerProfile("claude-cli"),
        conformance: otherKeyed,
        plan: approved,
        stdinBytes: stdin,
        binaryPath: ECHO,
        timeoutMs: 30_000,
        signingKey: SIGNING_KEY,
      }),
      assertCode("MEMORY_RUNNER_NOT_CONFORMANT"),
    );
    // A properly signed record but no key supplied to the runner is fail-closed.
    const signed = signConformanceRecord(forged);
    await assert.rejects(
      runExtractionRunner({
        profile: loadRunnerProfile("claude-cli"),
        conformance: signed,
        plan: approved,
        stdinBytes: stdin,
        binaryPath: ECHO,
        timeoutMs: 30_000,
      }),
      assertCode("MEMORY_RUNNER_NOT_CONFORMANT"),
    );
    assert.equal(existsSync(marker), false, "runner process must not have executed");
  });

  // Positive control: the same record with the matching key executes.
  await withMarker(async (marker) => {
    const result = await runExtractionRunner({
      profile: loadRunnerProfile("claude-cli"),
      conformance: signConformanceRecord(forged),
      plan: approved,
      stdinBytes: stdin,
      binaryPath: ECHO,
      timeoutMs: 30_000,
      signingKey: SIGNING_KEY,
    });
    assert.equal(result.exitCode, 0);
    assert.equal(existsSync(marker), true, "runner process should have executed");
  });
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
  // The plan binds the full runner profile (including argvTemplate), not just
  // the adapter name.
  assert.match(plan.runnerProfile, HEX64_PATTERN);
  assert.equal(plan.runnerProfile, computeRunnerProfileDigest(loadRunnerProfile("claude-cli")));
});

test("any argvTemplate change makes the plan's profile digest mismatch", () => {
  const profile = loadRunnerProfile("claude-cli");
  const altered = { ...profile, argvTemplate: [...profile.argvTemplate, "--verbose"] };
  const plan = makePlan("argv payload", { profile: altered });
  assert.notEqual(plan.runnerProfile, computeRunnerProfileDigest(profile));
});

test("a plan built against a different argvTemplate is refused before any spawn", async () => {
  const profile = loadRunnerProfile("claude-cli");
  const altered = { ...profile, argvTemplate: [...profile.argvTemplate, "--verbose"] };
  const plan = makePlan("argv-drift payload", { profile: altered });
  const approved = approvePlan(plan, { approvedDigest: plan.planDigest });
  await withMarker(async (marker) => {
    await assert.rejects(
      runExtractionRunner({
        profile,
        conformance: await conformanceFor(ECHO),
        plan: approved,
        stdinBytes: "argv-drift payload",
        binaryPath: ECHO,
        timeoutMs: 30_000,
        signingKey: SIGNING_KEY,
      }),
      assertCode("MEMORY_RUNNER_PROFILE_MISMATCH"),
    );
    assert.equal(existsSync(marker), false, "runner process must not have executed");
  });
});

test("a conformance record probed under a different argvTemplate refuses execution", async () => {
  const profile = loadRunnerProfile("claude-cli");
  const altered = { ...profile, argvTemplate: [...profile.argvTemplate, "--verbose"] };
  const plan = makePlan("profile-drift payload");
  const approved = approvePlan(plan, { approvedDigest: plan.planDigest });
  await withMarker(async (marker) => {
    await assert.rejects(
      runExtractionRunner({
        profile,
        // The record binds the altered profile, not the one that would run now.
        conformance: await conformanceFor(ECHO, altered),
        plan: approved,
        stdinBytes: "profile-drift payload",
        binaryPath: ECHO,
        timeoutMs: 30_000,
        signingKey: SIGNING_KEY,
      }),
      assertCode("MEMORY_RUNNER_NOT_CONFORMANT"),
    );
    assert.equal(existsSync(marker), false, "runner process must not have executed");
  });
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

function forgeManifest({ plans, totalBytes }) {
  // A schema-valid manifest whose own digest is self-consistent, so only the
  // semantic cross-checks (totalBytes, entry/plan field binding) can reject it.
  const forged = {
    format: "threadshare-memory-authorization-manifest@v1",
    manifestDigest: null,
    plans,
    totalBytes,
    authorization: "pending",
  };
  return { ...forged, manifestDigest: computeManifestDigest(forged) };
}

test("approveManifest rejects a manifest whose totalBytes disagrees with its entries", () => {
  const plan = makePlan("fourteen bytes"); // 14 bytes
  const forged = forgeManifest({
    plans: [
      {
        planDigest: plan.planDigest,
        taskKind: plan.taskKind,
        taskId: plan.taskId,
        bytesToSend: plan.bytesToSend,
      },
    ],
    // The displayed total understates what would actually be sent.
    totalBytes: 1,
  });
  assert.throws(
    () => approveManifest(forged, { approvedDigest: forged.manifestDigest }),
    assertCode("MEMORY_RUNNER_MANIFEST_MISMATCH"),
  );
});

test("approvePlanFromManifest rejects entries whose display fields contradict the plan", () => {
  // Review-reproduced scenario: the manifest shows a benign 1-byte adjudication
  // entry while the listed planDigest actually belongs to a 14-byte extraction.
  const plan = makePlan("fourteen bytes", { taskId: "real-task" });
  assert.equal(plan.taskKind, "extraction");
  assert.equal(plan.bytesToSend, 14);
  const forged = forgeManifest({
    plans: [
      {
        planDigest: plan.planDigest,
        taskKind: "adjudication",
        taskId: "benign-label",
        bytesToSend: 1,
      },
    ],
    totalBytes: 1,
  });
  const approved = approveManifest(forged, { approvedDigest: forged.manifestDigest });
  assert.throws(
    () => approvePlanFromManifest(plan, approved),
    assertCode("MEMORY_RUNNER_MANIFEST_MISMATCH"),
  );

  // Each display field binds individually.
  for (const overrides of [
    { taskKind: "adjudication" },
    { taskId: "benign-label" },
    { bytesToSend: 1 },
  ]) {
    const entry = {
      planDigest: plan.planDigest,
      taskKind: plan.taskKind,
      taskId: plan.taskId,
      bytesToSend: plan.bytesToSend,
      ...overrides,
    };
    const variant = forgeManifest({ plans: [entry], totalBytes: entry.bytesToSend });
    const approvedVariant = approveManifest(variant, { approvedDigest: variant.manifestDigest });
    assert.throws(
      () => approvePlanFromManifest(plan, approvedVariant),
      assertCode("MEMORY_RUNNER_MANIFEST_MISMATCH"),
      `expected rejection for forged ${Object.keys(overrides).join(",")}`,
    );
  }

  // An honest manifest built from the same plan still approves it.
  const honest = buildAuthorizationManifest([plan]);
  const approvedHonest = approveManifest(honest, { approvedDigest: honest.manifestDigest });
  assert.equal(approvePlanFromManifest(plan, approvedHonest).authorization, "approved");
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
      signingKey: SIGNING_KEY,
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
    signingKey: SIGNING_KEY,
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
        signingKey: SIGNING_KEY,
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
        signingKey: SIGNING_KEY,
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
        signingKey: SIGNING_KEY,
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
        signingKey: SIGNING_KEY,
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
      signingKey: SIGNING_KEY,
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
      signingKey: SIGNING_KEY,
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
      signingKey: SIGNING_KEY,
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
