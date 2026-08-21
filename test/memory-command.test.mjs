import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, stat, symlink, writeFile } from "node:fs/promises";
import path from "node:path";
import { PassThrough } from "node:stream";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  createMemoryReviewConfirmer,
  executeMemoryCommand,
  executeMemoryMcp,
  formatMemoryCommandResult,
  parseMemoryInvocation,
} from "../src/memory-command.mjs";
import { executeInsightsCommand, parseInsightsInvocation } from "../src/insights-command.mjs";
import { parseMemoryEntry } from "../src/memory-format.mjs";
import { INSIGHTS_E2E_ENGINE, INSIGHTS_E2E_SKIP } from "./helpers/insights-e2e.mjs";
import {
  createMemoryCommandFixture,
  MEMORY_FAKE_PROVIDER_SESSION_ID,
} from "./helpers/memory-command-e2e.mjs";

const execFileAsync = promisify(execFile);
const ttyCli = fileURLToPath(new URL("./fixtures/run-threadshare-cli-as-tty.mjs", import.meta.url));

function ttyStream(stream) {
  Object.defineProperty(stream, "isTTY", { value: true });
  return stream;
}

test("memory init, status, lint, and assemble form an idempotent repository workflow", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  const initInvocation = parseMemoryInvocation(["memory", "init"], {
    repository: fixture.repository,
  });
  const initialized = await executeMemoryCommand(initInvocation, fixture.options);
  assert.deepEqual(initialized.created, [
    ".threadshare/memory/entries",
    ".threadshare/memory/scenes",
    ".threadshare/memory/skills",
    ".threadshare/memory/index.json",
  ]);
  assert.equal(initialized.approvedProjection.generation, 1);
  assert.equal(initialized.approvedProjection.unchanged, false);
  const repeated = await executeMemoryCommand(initInvocation, fixture.options);
  assert.deepEqual(repeated.created, []);
  assert.equal(repeated.approvedProjection.generation, 1);
  assert.equal(repeated.approvedProjection.unchanged, true);

  const status = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "status"], { repository: fixture.repository, format: "json" }),
    fixture.options,
  );
  assert.deepEqual(status.candidates, { draft: 0, quarantined: 0, promoted: 0, discarded: 0 });

  const memoryRoot = path.join(fixture.repository, ".threadshare", "memory");
  await writeFile(path.join(memoryRoot, "doctrine.md"), "Run release checks before publishing.\n");
  await writeFile(path.join(memoryRoot, "scenes", "release.md"), [
    "-----META-START-----",
    "created: 2026-08-21",
    "updated: 2026-08-21",
    "summary: Release verification",
    "heat: 3",
    "-----META-END-----",
    "## Release",
    "Run the release verification suite.",
  ].join("\n"));
  const nested = path.join(fixture.repository, "src", "nested");
  await mkdir(nested, { recursive: true });
  const assembleInvocation = parseMemoryInvocation(["memory", "assemble"], { provider: "claude" });
  const assembled = await executeMemoryCommand(assembleInvocation, { ...fixture.options, cwd: nested });
  assert.equal(assembled.changed, true);
  assert.match(await readFile(path.join(fixture.repository, "CLAUDE.md"), "utf8"),
    /\.threadshare\/memory\/scenes\/release\.md — Release verification/);
  const assembledAgain = await executeMemoryCommand(assembleInvocation, { ...fixture.options, cwd: nested });
  assert.equal(assembledAgain.changed, false);
  assert.equal(assembledAgain.approvedProjection.unchanged, true);

  const leakingEntry = path.join(memoryRoot, "entries", "leaking-entry.md");
  await writeFile(leakingEntry, "token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\n");
  const linted = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "lint", leakingEntry], {
      repository: fixture.repository,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(linted.blocked, true);
  assert.ok(linted.files[0].findings.some((finding) => finding.code === "MEMORY_LINT_GITHUB_TOKEN"));
});

test("memory init refuses an existing symlink in the public memory path", {
  skip: INSIGHTS_E2E_SKIP || process.platform === "win32",
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  const outside = path.join(fixture.directory, "outside");
  await mkdir(outside);
  await symlink(outside, path.join(fixture.repository, ".threadshare"));

  await assert.rejects(
    executeMemoryCommand(
      parseMemoryInvocation(["memory", "init"], { repository: fixture.repository }),
      fixture.options,
    ),
    (error) => error.code === "TS_OPERATION_FAILED" &&
      /symbolic links/.test(error.message) &&
      !error.message.includes(fixture.repository),
  );
  assert.deepEqual(await readdir(outside), []);
});

test("memory review shows statement evidence and limitations before confirmation", async () => {
  const input = ttyStream(new PassThrough());
  const output = ttyStream(new PassThrough());
  let rendered = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    rendered += chunk;
  });

  const reviewer = createMemoryReviewConfirmer({ input, output });
  assert.notEqual(reviewer, null);

  const confirmation = reviewer.confirmStatement(
    {
      candidateId: "candidate-1",
      payload: {
        content: "Release tests are grouped under npm run test:release.",
        reviewStatements: [{
          statementId: "statement-1",
          text: "Run the release suite before publishing.",
          evidence: [{
            evidenceId: "evidence-1",
            kind: "commit",
            display: "commit 0123456789abcdef @ team-harness/threadshare",
            excerpt: "package.json defines test:release.",
          }],
        }],
      },
    },
    {
      statementId: "statement-1",
      provenanceStrength: "direct",
      claimSupport: "unverified",
      limitations: ["single-session"],
    },
  );
  input.end("y\n");
  const confirmed = await confirmation;
  reviewer.close();

  assert.equal(confirmed, true);
  assert.match(rendered, /Run the release suite before publishing\./);
  assert.match(rendered, /commit 0123456789abcdef @ team-harness\/threadshare/);
  assert.match(rendered, /package\.json defines test:release\./);
  assert.match(rendered, /Provenance: direct/);
  assert.match(rendered, /Limitations: single-session/);
  assert.match(rendered, /Confirm this statement\? \[y\/N\]:/);
});

test("memory extract text exposes every next-stage authorization digest", () => {
  const digest = "a".repeat(64);
  const manifestDigest = "b".repeat(64);
  const output = formatMemoryCommandResult({
    action: "extract",
    authorized: true,
    delivered: [{
      taskId: "extract-1",
      taskKind: "extraction",
      candidates: 1,
      adjudication: "pending",
    }],
    failed: [],
    plans: [{
      planDigest: digest,
      taskKind: "adjudication",
      taskId: "extract-1-adj",
      provider: "claude",
      model: "claude-latest",
      bytesToSend: 512,
      providerRetention: "unknown",
    }],
    manifestDigest,
    note: "No adjudication input was delivered.",
  }, { action: "extract", format: "text" });

  assert.match(output, /extraction extract-1: 1 candidate\(s\)/);
  assert.match(output, new RegExp(`adjudication plan ${digest}`));
  assert.match(output, new RegExp(`manifest ${manifestDigest}`));
  assert.doesNotMatch(output, /undefined/);
});

test("memory extract requires a filtered Insights request for a new plan", () => {
  const invocation = parseMemoryInvocation(["memory", "extract"], {
    repository: "/work/threadshare",
    runner: "claude",
    request: "memory-filter.json",
    format: "json",
  });
  assert.equal(invocation.requestSource, "memory-filter.json");
  assert.equal(invocation.session, undefined);

  assert.throws(
    () => parseMemoryInvocation(["memory", "extract"], {
      repository: "/work/threadshare",
      runner: "claude",
      format: "json",
    }),
    (error) => error?.code === "TS_USAGE_OPTION_DEPENDENCY",
  );
  assert.throws(
    () => parseMemoryInvocation(["memory", "extract"], {
      repository: "/work/threadshare",
      runner: "claude",
      session: "bundle.json",
      format: "json",
    }),
    (error) => error?.code === "TS_USAGE_OPTION_NOT_ALLOWED",
  );
  assert.throws(
    () => parseMemoryInvocation(["memory", "extract"], {
      runner: "claude",
      request: "memory-filter.json",
      "approve-plan": "a".repeat(64),
    }),
    (error) => error?.code === "TS_USAGE_OPTION_CONFLICT",
  );
});

async function extractCandidate(fixture) {
  const pendingInvocation = parseMemoryInvocation(["memory", "extract"], {
    repository: fixture.repository,
    runner: "claude",
    request: "memory-request.json",
    format: "json",
  });
  const pending = await executeMemoryCommand(pendingInvocation, fixture.options);
  assert.equal(pending.authorized, false);
  assert.equal(pending.plans.length, 1);

  const approvedInvocation = parseMemoryInvocation(["memory", "extract"], {
    repository: fixture.repository,
    runner: "claude",
    format: "json",
    "approve-plan": pending.plans[0].planDigest,
  });
  const delivered = await executeMemoryCommand(approvedInvocation, fixture.options);
  assert.equal(delivered.authorized, true);
  assert.equal(delivered.plans.length, 1);
  assert.equal(delivered.plans[0].taskKind, "adjudication");
  const adjudicated = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "extract"], {
      repository: fixture.repository,
      runner: "claude",
      format: "json",
      "approve-plan": delivered.plans[0].planDigest,
    }),
    fixture.options,
  );
  assert.equal(adjudicated.delivered[0].adjudication, "applied");
  return { pending, delivered, adjudicated };
}

test("Insights extraction binds Delivery Trace and advances the chunk cursor only after submit", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  const pending = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "extract"], {
      repository: fixture.repository,
      runner: "claude",
      request: "memory-request.json",
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(pending.plans.length, 1);
  const sidecar = JSON.parse(await readFile(path.join(
    fixture.options.paths.stateDirectory,
    "memory",
    "runner-plans",
    `${pending.plans[0].planDigest}.json`,
  ), "utf8"));
  const taskText = Buffer.from(sidecar.stdinBase64, "base64").toString("utf8");
  const task = JSON.parse(taskText);
  assert.notEqual(task.binding.provenance.snapshotSeq, "0");
  assert.match(task.binding.selection.requestDigest, /^[0-9a-f]{64}$/);
  assert.equal(task.binding.deliveryEdgeRevisions.length > 0, true);
  assert.equal(task.evidenceCatalog.some((entry) =>
    entry.kind === "commit" && entry.display.includes(fixture.commitHash)), true);
  assert.equal(task.evidenceCatalog.some((entry) =>
    entry.kind === "path" && entry.display === "path README.md"), true);
  assert.equal(taskText.includes(MEMORY_FAKE_PROVIDER_SESSION_ID), false);

  await executeMemoryCommand(
    parseMemoryInvocation(["memory", "extract"], {
      repository: fixture.repository,
      runner: "claude",
      format: "json",
      "approve-plan": pending.plans[0].planDigest,
    }),
    fixture.options,
  );
  const repeated = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "extract"], {
      repository: fixture.repository,
      runner: "claude",
      request: "memory-request.json",
      format: "json",
    }),
    fixture.options,
  );
  assert.deepEqual(repeated.plans, []);
  assert.equal(repeated.selection.pendingChunks, 0);
});

test("extraction approval rejects a related Insights revision change", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  const pending = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "extract"], {
      repository: fixture.repository,
      runner: "claude",
      request: "memory-request.json",
      format: "json",
    }),
    fixture.options,
  );
  await appendFile(fixture.sessionFile, `${[
    {
      type: "event_msg",
      timestamp: "2026-08-10T09:10:00.000Z",
      payload: { type: "task_started", turn_id: "memory-turn-4" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-10T09:10:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Add a changed retrospective input" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-10T09:10:02.000Z",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The selected input has changed." }],
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-10T09:10:03.000Z",
      payload: { type: "task_complete", turn_id: "memory-turn-4" },
    },
  ].map((record) => JSON.stringify(record)).join("\n")}\n`);
  await executeInsightsCommand(
    parseInsightsInvocation(["insights", "sync"], { format: "json" }),
    fixture.options,
  );

  await assert.rejects(
    executeMemoryCommand(
      parseMemoryInvocation(["memory", "extract"], {
        repository: fixture.repository,
        runner: "claude",
        format: "json",
        "approve-plan": pending.plans[0].planDigest,
      }),
      fixture.options,
    ),
    (error) => error?.code === "TS_INSIGHTS_PAYLOAD_CHANGED",
  );
});

test("extracted candidates retain reviewable statements and local evidence", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await extractCandidate(fixture);

  let reviewed = null;
  const reviewInvocation = parseMemoryInvocation(["memory", "review"], {
    repository: fixture.repository,
  });
  const review = await executeMemoryCommand(reviewInvocation, {
    ...fixture.options,
    async confirmStatement(item, assessment) {
      reviewed = { item, assessment };
      return false;
    },
  });

  assert.equal(review.plan, null);
  assert.equal(reviewed.item.payload.reviewStatements[0].text,
    "Release tests are grouped under npm run test release.");
  assert.match(reviewed.item.payload.reviewStatements[0].evidence[0].excerpt,
    /npm run test:release before publishing/);
  assert.equal(reviewed.item.payload.reviewStatements[0].evidence[0].display, "turn 0");
  assert.ok(reviewed.assessment.limitations.includes("source-local-only"));
});

test("review confirmation promotes a sanitized entry without creating Git history", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await extractCandidate(fixture);
  const beforeHead = (await execFileAsync("git", ["-C", fixture.repository, "rev-parse", "HEAD"]))
    .stdout.trim();

  let confirmations = 0;
  const review = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "review"], { repository: fixture.repository }),
    {
      ...fixture.options,
      async confirmStatement() {
        confirmations += 1;
        return true;
      },
    },
  );
  assert.equal(confirmations, 1);
  assert.notEqual(review.plan, null);
  assert.equal(review.plan.files.length, 1);
  const planStat = await stat(path.join(
    fixture.options.paths.stateDirectory,
    "memory",
    "plans",
    `${review.plan.planId}.json`,
  ));
  if (process.platform !== "win32") assert.equal(planStat.mode & 0o777, 0o600);

  const promoted = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "promote"], {
      repository: fixture.repository,
      plan: review.plan.planId,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(promoted.status, "applied");
  assert.equal(promoted.appliedFiles.length, 1);

  const entryText = await readFile(path.join(fixture.repository, promoted.appliedFiles[0]), "utf8");
  const entry = parseMemoryEntry(entryText);
  assert.equal(entry.frontmatter.status, "approved");
  assert.equal(entry.frontmatter.claim_support, "human-confirmed");
  assert.ok(entry.frontmatter.limitations.includes("source-local-only"));
  assert.doesNotMatch(entryText, /provider-session-id-must-stay-local/);
  const searchable = await executeMemoryMcp("search", { query: "release", limit: 5 }, {
    ...fixture.options,
    repository: fixture.repository,
  });
  assert.equal(searchable.coverage, "complete");
  assert.equal(searchable.generation, promoted.approvedProjection.generation);
  assert.deepEqual(searchable.items.map((item) => item.entryId), [entry.frontmatter.id]);
  const replayed = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "promote"], {
      repository: fixture.repository,
      plan: review.plan.planId,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(replayed.idempotent, true);
  assert.equal(replayed.approvedProjection.unchanged, true);
  assert.equal(replayed.approvedProjection.generation, promoted.approvedProjection.generation);

  await writeFile(
    path.join(fixture.repository, promoted.appliedFiles[0]),
    `${entryText.trimEnd()}\nProjection refresh marker.\n`,
  );
  const assembled = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "assemble"], {
      repository: fixture.repository,
      provider: "claude",
    }),
    fixture.options,
  );
  assert.equal(assembled.approvedProjection.generation, promoted.approvedProjection.generation + 1);
  const refreshed = await executeMemoryMcp("search", { query: "marker", limit: 5 }, {
    ...fixture.options,
    repository: fixture.repository,
  });
  assert.deepEqual(refreshed.items.map((item) => item.entryId), [entry.frontmatter.id]);

  const afterHead = (await execFileAsync("git", ["-C", fixture.repository, "rev-parse", "HEAD"]))
    .stdout.trim();
  assert.equal(afterHead, beforeHead);
});

test("the real CLI wires TTY statement confirmation into memory review", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await extractCandidate(fixture);
  const cliEnvironment = {
    ...process.env,
    THREADSHARE_INSIGHTS_ENGINE_PATH: INSIGHTS_E2E_ENGINE,
    THREADSHARE_INSIGHTS_HOME: fixture.options.paths.stateDirectory,
  };

  const nonInteractive = await execFileAsync(process.execPath, [
    ttyCli,
    "memory", "review",
    "--repository", fixture.repository,
    "--format", "json",
  ], {
    cwd: fixture.repository,
    env: cliEnvironment,
  });
  assert.equal(nonInteractive.stderr, "");
  const pendingReview = JSON.parse(nonInteractive.stdout);
  assert.equal(pendingReview.interactive, false);
  assert.equal(pendingReview.plan, null);
  assert.equal(pendingReview.pending.length, 1);

  const result = await new Promise((resolve, reject) => {
    const child = spawn(process.execPath, [
      ttyCli,
      "memory", "review",
      "--repository", fixture.repository,
    ], {
      cwd: fixture.repository,
      env: cliEnvironment,
      stdio: ["pipe", "pipe", "pipe"],
    });
    let stdout = "";
    let stderr = "";
    let answered = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr.on("data", (chunk) => {
      stderr += chunk;
      if (!answered && stderr.includes("Confirm this statement? [y/N]:")) {
        answered = true;
        child.stdin.end("y\n");
      }
    });
    child.once("error", reject);
    child.once("close", (status) => resolve({ status, stdout, stderr }));
  });

  assert.equal(result.status, 0, result.stderr);
  assert.match(result.stderr, /Statement: Release tests are grouped under npm run test release\./);
  assert.match(result.stderr, /Evidence \(turn\): turn 0/);
  assert.match(result.stderr, /Confirm this statement\? \[y\/N\]:/);
  assert.match(result.stdout, /Promotion plan/);
});

test("promotion voids the whole plan when a target blob drifts", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await extractCandidate(fixture);
  const review = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "review"], { repository: fixture.repository }),
    { ...fixture.options, confirmStatement: async () => true },
  );
  assert.notEqual(review.plan, null);
  const target = path.join(fixture.repository, review.plan.files[0].targetPath);
  await mkdir(path.dirname(target), { recursive: true });
  await writeFile(target, "manual edit that must survive\n");

  const promoted = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "promote"], {
      repository: fixture.repository,
      plan: review.plan.planId,
      format: "json",
    }),
    fixture.options,
  );

  assert.equal(promoted.status, "voided");
  assert.equal(promoted.driftedPath, review.plan.files[0].targetPath);
  assert.equal(await readFile(target, "utf8"), "manual edit that must survive\n");
});

test("adjudication requires a second exact runner-plan approval", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  const pending = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "extract"], {
      repository: fixture.repository,
      runner: "claude",
      request: "memory-request.json",
      format: "json",
    }),
    fixture.options,
  );
  const afterExtraction = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "extract"], {
      repository: fixture.repository,
      runner: "claude",
      format: "json",
      "approve-plan": pending.plans[0].planDigest,
    }),
    fixture.options,
  );

  assert.equal(afterExtraction.delivered[0].taskKind, "extraction");
  assert.equal(afterExtraction.plans.length, 1);
  assert.equal(afterExtraction.plans[0].taskKind, "adjudication");
  const beforeAdjudication = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "status"], {
      repository: fixture.repository,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(beforeAdjudication.candidates.draft, 1);
  assert.equal(beforeAdjudication.candidates.quarantined, 0);

  const afterAdjudication = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "extract"], {
      repository: fixture.repository,
      runner: "claude",
      format: "json",
      "approve-plan": afterExtraction.plans[0].planDigest,
    }),
    fixture.options,
  );
  assert.equal(afterAdjudication.delivered[0].taskKind, "adjudication");
  assert.equal(
    afterAdjudication.delivered[0].adjudication,
    "applied",
    JSON.stringify(afterAdjudication.delivered[0]),
  );
  assert.deepEqual(afterAdjudication.plans, []);
  const complete = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "status"], {
      repository: fixture.repository,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(complete.candidates.draft, 0);
  assert.equal(complete.candidates.quarantined, 1);

  const databaseFile = path.join(
    fixture.options.paths.stateDirectory,
    "memory",
    "memory-state.sqlite3",
  );
  const databaseStat = await stat(databaseFile);
  if (process.platform !== "win32") assert.equal(databaseStat.mode & 0o777, 0o600);
  const conformanceStat = await stat(path.join(
    fixture.options.paths.stateDirectory,
    "memory",
    "conformance",
    "claude-cli.json",
  ));
  if (process.platform !== "win32") assert.equal(conformanceStat.mode & 0o777, 0o600);
  const runnerPlanStat = await stat(path.join(
    fixture.options.paths.stateDirectory,
    "memory",
    "runner-plans",
    `${afterExtraction.plans[0].planDigest}.json`,
  ));
  if (process.platform !== "win32") assert.equal(runnerPlanStat.mode & 0o777, 0o600);
  await assert.rejects(
    stat(path.join(fixture.options.paths.stateDirectory, "memory", "memory", "memory-state.sqlite3")),
    (error) => error.code === "ENOENT",
  );
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const authorizations = database.prepare(`
      SELECT lower(hex(plan_digest)) AS planDigest, task_id AS taskId,
             lower(hex(runner_input_digest)) AS runnerInputDigest,
             lower(hex(input_coverage_digest)) AS inputCoverageDigest,
             via, manifest_digest AS manifestDigest
      FROM authorization_log ORDER BY rowid
    `).all().map((row) => ({ ...row }));
    assert.deepEqual(authorizations.map((row) => ({
      planDigest: row.planDigest,
      taskId: row.taskId,
      via: row.via,
      manifestDigest: row.manifestDigest,
    })), [
      {
        planDigest: pending.plans[0].planDigest,
        taskId: afterExtraction.delivered[0].taskId,
        via: "digest",
        manifestDigest: null,
      },
      {
        planDigest: afterExtraction.plans[0].planDigest,
        taskId: afterAdjudication.delivered[0].taskId,
        via: "digest",
        manifestDigest: null,
      },
    ]);
    for (const row of authorizations) {
      assert.match(row.runnerInputDigest, /^[0-9a-f]{64}$/);
      assert.match(row.inputCoverageDigest, /^[0-9a-f]{64}$/);
    }
  } finally {
    database.close();
  }
});
