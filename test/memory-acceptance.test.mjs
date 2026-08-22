import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";

import {
  executeMemoryCommand,
  parseMemoryInvocation,
} from "../src/memory-command.mjs";
import { INSIGHTS_E2E_SKIP } from "./helpers/insights-e2e.mjs";
import {
  createMemoryCommandFixture,
  MEMORY_FAKE_PROVIDER_SESSION_ID,
} from "./helpers/memory-command-e2e.mjs";

const execFileAsync = promisify(execFile);

function extractionInvocation(repository, overrides = {}) {
  return parseMemoryInvocation(["memory", "extract"], {
    repository,
    runner: "claude",
    format: "json",
    ...overrides,
  });
}

async function extractAndAdjudicate(fixture) {
  const pending = await executeMemoryCommand(
    extractionInvocation(fixture.repository, { request: "memory-request.json" }),
    fixture.options,
  );
  const extracted = await executeMemoryCommand(
    extractionInvocation(fixture.repository, {
      "approve-plan": pending.plans[0].planDigest,
    }),
    fixture.options,
  );
  const adjudicated = await executeMemoryCommand(
    extractionInvocation(fixture.repository, {
      "approve-plan": extracted.plans[0].planDigest,
    }),
    fixture.options,
  );
  assert.equal(adjudicated.delivered[0].adjudication, "applied");
}

test("cross-chunk recall uses one shared adjudication and input drift blocks the whole batch", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t, {
    turns: [
      { turnIndex: 0, events: [{ role: "user", text: "a".repeat(30_000) }] },
      { turnIndex: 1, events: [{ role: "assistant", text: "b".repeat(30_000) }] },
    ],
  });
  const pending = await executeMemoryCommand(
    extractionInvocation(fixture.repository, { request: "memory-request.json", limit: "2" }),
    fixture.options,
  );
  assert.equal(pending.plans.length, 2);
  assert.match(pending.manifestDigest, /^[0-9a-f]{64}$/);

  const extracted = await executeMemoryCommand(
    extractionInvocation(fixture.repository, {
      limit: "2",
      "approve-manifest": pending.manifestDigest,
    }),
    fixture.options,
  );
  assert.equal(extracted.delivered.length, 2);
  assert.equal(extracted.plans.length, 1);
  assert.equal(extracted.plans[0].taskKind, "adjudication");
  assert.equal(extracted.manifestDigest, null);

  const runnerPlans = path.join(fixture.options.paths.stateDirectory, "memory", "runner-plans");
  const sharedArtifactPath = path.join(
    runnerPlans,
    `${extracted.plans[0].planDigest}.json`,
  );
  const sharedArtifact = JSON.parse(await readFile(
    sharedArtifactPath,
    "utf8",
  ));
  const sharedTask = JSON.parse(
    Buffer.from(sharedArtifact.stdinBase64, "base64").toString("utf8"),
  );
  assert.equal(
    sharedTask.pool.filter((item) => item.sourceKind === "candidate").length,
    2,
    "the shared adjudication must recall candidates from both chunks",
  );

  const changedInput = Buffer.concat([
    Buffer.from(sharedArtifact.stdinBase64, "base64"),
    Buffer.from(" ", "utf8"),
  ]);
  sharedArtifact.stdinBase64 = changedInput.toString("base64");
  await writeFile(sharedArtifactPath, `${JSON.stringify(sharedArtifact)}\n`, { mode: 0o600 });

  await assert.rejects(
    executeMemoryCommand(
      extractionInvocation(fixture.repository, {
        "approve-plan": extracted.plans[0].planDigest,
      }),
      fixture.options,
    ),
    (error) => error?.code === "MEMORY_RUNNER_PLAN_MISMATCH",
  );

  const status = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "status"], {
      repository: fixture.repository,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(status.candidates.draft, 2);
  assert.equal(status.candidates.quarantined, 0);
});

test("approved Git memory contains no provider id or local evidence pointer", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await extractAndAdjudicate(fixture);
  const review = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "review"], { repository: fixture.repository }),
    { ...fixture.options, confirmStatement: async () => true },
  );
  const promoted = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "promote"], {
      repository: fixture.repository,
      plan: review.plan.planId,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(promoted.status, "applied");
  await execFileAsync("git", ["-C", fixture.repository, "add", ".threadshare/memory"]);

  const staged = (await execFileAsync("git", [
    "-C", fixture.repository,
    "diff", "--cached", "--", ".threadshare/memory",
  ])).stdout;
  assert.match(staged, /status: approved/);
  assert.doesNotMatch(staged, new RegExp(MEMORY_FAKE_PROVIDER_SESSION_ID));
  assert.doesNotMatch(staged, /sessionId|sessionKey|turnKey|payloadSha256|pointerDigest/);

  await assert.rejects(
    execFileAsync("git", [
      "-C", fixture.repository,
      "grep", "--cached", "-n", MEMORY_FAKE_PROVIDER_SESSION_ID,
    ]),
    (error) => error.code === 1 && error.stdout === "",
  );
});

test("internal autoConfirm cannot approve generated statements", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await extractAndAdjudicate(fixture);
  const review = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "review"], {
      repository: fixture.repository,
    }),
    { ...fixture.options, autoConfirm: true },
  );
  assert.equal(review.interactive, false);
  assert.equal(review.plan, null);
  assert.equal(review.pending.length, 1);
});
