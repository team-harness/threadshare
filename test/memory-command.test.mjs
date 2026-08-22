import assert from "node:assert/strict";
import { execFile, spawn } from "node:child_process";
import { appendFile, mkdir, readFile, readdir, rename, stat, symlink, unlink, writeFile } from "node:fs/promises";
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
import { parseMemoryEntry, serializeMemoryEntry } from "../src/memory-format.mjs";
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
  const emptyReview = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "review"], {
      repository: fixture.repository,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(emptyReview.note, "No candidates are awaiting review.");

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
  await writeFile(path.join(memoryRoot, "scenes", "lower-heat.md"), [
    "-----META-START-----",
    "created: 2026-08-21",
    "updated: 2026-08-21",
    "summary: Lower priority context",
    "heat: 1",
    "-----META-END-----",
    "## Context",
    "Read this after release guidance.",
  ].join("\n"));
  const nested = path.join(fixture.repository, "src", "nested");
  await mkdir(nested, { recursive: true });
  const assembleInvocation = parseMemoryInvocation(["memory", "assemble"], { provider: "claude" });
  const assembled = await executeMemoryCommand(assembleInvocation, { ...fixture.options, cwd: nested });
  assert.equal(assembled.changed, true);
  const claudeText = await readFile(path.join(fixture.repository, "CLAUDE.md"), "utf8");
  assert.match(claudeText,
    /\.threadshare\/memory\/scenes\/release\.md \(heat 3\) — Release verification/);
  assert.ok(claudeText.indexOf("release.md") < claudeText.indexOf("lower-heat.md"));
  const assembledAgain = await executeMemoryCommand(assembleInvocation, { ...fixture.options, cwd: nested });
  assert.equal(assembledAgain.changed, false);
  assert.equal(assembledAgain.approvedProjection.unchanged, true);

  await writeFile(path.join(fixture.repository, "AGENTS.md"), "# User instructions\n\nKeep this byte-for-byte.\n");
  const codexAssembled = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "assemble"], { provider: "codex" }),
    { ...fixture.options, cwd: nested },
  );
  assert.equal(codexAssembled.target, "AGENTS.md");
  const agentsText = await readFile(path.join(fixture.repository, "AGENTS.md"), "utf8");
  assert.ok(agentsText.startsWith("# User instructions\n\nKeep this byte-for-byte.\n"));
  assert.equal(await readFile(path.join(fixture.repository, "CLAUDE.md"), "utf8"), claudeText);

  const malformed = `${agentsText}\n<!-- BEGIN THREADSHARE MEMORY (generated; do not edit by hand) -->\n`;
  await writeFile(path.join(fixture.repository, "AGENTS.md"), malformed);
  await assert.rejects(
    executeMemoryCommand(
      parseMemoryInvocation(["memory", "assemble"], { provider: "codex" }),
      { ...fixture.options, cwd: nested },
    ),
    (error) => error.code === "TS_OPERATION_FAILED" && /marker/.test(error.message),
  );
  assert.equal(await readFile(path.join(fixture.repository, "AGENTS.md"), "utf8"), malformed);

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

test("memory consolidate is pending-only, human-reviewed, promotable, and replayable with --full", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await executeMemoryCommand(
    parseMemoryInvocation(["memory", "init"], { repository: fixture.repository }),
    fixture.options,
  );
  const entryText = serializeMemoryEntry({
    frontmatter: {
      id: "release-verification",
      type: "work_method",
      status: "approved",
      priority: 80,
      confidence: "high",
      provenance_strength: "direct",
      claim_support: "human-confirmed",
      limitations: [],
      scope: "repo",
      scene: null,
      occurred: [],
      evidence: { commits: [], paths: ["package.json"] },
      superseded_by: null,
    },
    body: "Run the release verification suite before publishing.\n",
  });
  await writeFile(path.join(
    fixture.repository,
    ".threadshare",
    "memory",
    "entries",
    "release-verification.md",
  ), entryText);

  const preview = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "consolidate"], {
      repository: fixture.repository,
      runner: "claude",
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(preview.authorized, false);
  assert.equal(preview.entryCount, 1);
  assert.equal(preview.plans.length, 1);
  assert.equal(preview.plans[0].taskKind, "consolidation");

  const consolidated = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "consolidate"], {
      repository: fixture.repository,
      runner: "claude",
      "approve-plan": preview.plans[0].planDigest,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(consolidated.status, "pending_review");
  assert.match(consolidated.candidateId, /^patch-consolidate-/u);

  const entryFile = path.join(
    fixture.repository,
    ".threadshare",
    "memory",
    "entries",
    "release-verification.md",
  );
  await writeFile(entryFile, entryText.replace(
    "Run the release verification suite before publishing.",
    "Changed after consolidation submission.",
  ));
  await assert.rejects(
    executeMemoryCommand(
      parseMemoryInvocation(["memory", "review"], {
        repository: fixture.repository,
        kind: "consolidation",
      }),
      { ...fixture.options, confirmStatement: async () => true },
    ),
    (error) => error.code === "TS_MEMORY_BINDING_DRIFT",
  );
  await writeFile(entryFile, entryText);

  const unexpectedScene = path.join(
    fixture.repository,
    ".threadshare",
    "memory",
    "scenes",
    "unexpected.md",
  );
  await writeFile(unexpectedScene, [
    "-----META-START-----",
    "created: 2026-08-21",
    "updated: 2026-08-21",
    "summary: \"unexpected\"",
    "heat: 1",
    "-----META-END-----",
    "# Unexpected",
    "",
  ].join("\n"));
  await assert.rejects(
    executeMemoryCommand(
      parseMemoryInvocation(["memory", "review"], {
        repository: fixture.repository,
        kind: "consolidation",
      }),
      { ...fixture.options, confirmStatement: async () => true },
    ),
    (error) => error.code === "TS_MEMORY_BINDING_DRIFT",
  );
  await unlink(unexpectedScene);

  let reviewedText = "";
  const reviewed = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "review"], {
      repository: fixture.repository,
      kind: "consolidation",
      format: "text",
    }),
    {
      ...fixture.options,
      async confirmStatement(item) {
        assert.equal(item.candidateKind, "consolidation-patch");
        reviewedText = item.payload.reviewStatements[0].text;
        return true;
      },
    },
  );
  assert.match(reviewedText, /CREATE scene release-workflow/u);
  assert.match(reviewedText, /\+\+\+ proposed/u);
  assert.notEqual(reviewed.plan, null);

  const promoted = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "promote"], {
      repository: fixture.repository,
      plan: reviewed.plan.planId,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(promoted.status, "applied");
  const scene = await readFile(path.join(
    fixture.repository,
    ".threadshare",
    "memory",
    "scenes",
    "release-workflow.md",
  ), "utf8");
  assert.match(scene, /heat: 1/u);

  const noDelta = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "consolidate"], {
      repository: fixture.repository,
      runner: "claude",
      format: "json",
    }),
    fixture.options,
  );
  assert.deepEqual(noDelta.plans, []);
  assert.equal(noDelta.entryCount, 0);

  const replay = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "consolidate"], {
      repository: fixture.repository,
      runner: "claude",
      full: true,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(replay.entryCount, 1);
  assert.equal(replay.plans.length, 1);
});

test("memory consolidate --full replays the same approved set after an empty patch", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await executeMemoryCommand(
    parseMemoryInvocation(["memory", "init"], { repository: fixture.repository }),
    fixture.options,
  );
  const entryText = serializeMemoryEntry({
    frontmatter: {
      id: "empty-consolidation",
      type: "work_method",
      status: "approved",
      priority: 50,
      confidence: "high",
      provenance_strength: "direct",
      claim_support: "human-confirmed",
      limitations: [],
      scope: "repo",
      scene: null,
      occurred: [],
      evidence: { commits: [], paths: [] },
      superseded_by: null,
    },
    body: "THREADSHARE_TEST_EMPTY_PATCH\n",
  });
  await writeFile(path.join(
    fixture.repository,
    ".threadshare",
    "memory",
    "entries",
    "empty-consolidation.md",
  ), entryText);

  const firstPreview = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "consolidate"], {
      repository: fixture.repository,
      runner: "claude",
      format: "json",
    }),
    fixture.options,
  );
  const first = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "consolidate"], {
      repository: fixture.repository,
      runner: "claude",
      "approve-plan": firstPreview.plans[0].planDigest,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(first.status, "no_op");

  const replayPreview = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "consolidate"], {
      repository: fixture.repository,
      runner: "claude",
      full: true,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(replayPreview.plans.length, 1);
  assert.notEqual(replayPreview.plans[0].taskId, firstPreview.plans[0].taskId);
  const replayed = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "consolidate"], {
      repository: fixture.repository,
      runner: "claude",
      "approve-plan": replayPreview.plans[0].planDigest,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(replayed.status, "no_op");
});

test("invalid consolidation output releases its task claim for an exact retry", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await executeMemoryCommand(
    parseMemoryInvocation(["memory", "init"], { repository: fixture.repository }),
    fixture.options,
  );
  const entryText = serializeMemoryEntry({
    frontmatter: {
      id: "oversized-scene",
      type: "work_method",
      status: "approved",
      priority: 50,
      confidence: "high",
      provenance_strength: "direct",
      claim_support: "human-confirmed",
      limitations: [],
      scope: "repo",
      scene: null,
      occurred: [],
      evidence: { commits: [], paths: [] },
      superseded_by: null,
    },
    body: "THREADSHARE_TEST_OVERSIZED_SCENE\n",
  });
  await writeFile(path.join(
    fixture.repository,
    ".threadshare",
    "memory",
    "entries",
    "oversized-scene.md",
  ), entryText);
  const preview = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "consolidate"], {
      repository: fixture.repository,
      runner: "claude",
      format: "json",
    }),
    fixture.options,
  );
  await assert.rejects(
    executeMemoryCommand(
      parseMemoryInvocation(["memory", "consolidate"], {
        repository: fixture.repository,
        runner: "claude",
        "approve-plan": preview.plans[0].planDigest,
        format: "json",
      }),
      fixture.options,
    ),
    (error) => /1500/u.test(error.message),
  );
  const status = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "status"], {
      repository: fixture.repository,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(status.tasks.claimed, 0);
  assert.equal(status.tasks.pending, 1);
});

test("memory consolidation never sends content through a symlinked parent", {
  skip: INSIGHTS_E2E_SKIP || process.platform === "win32",
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await executeMemoryCommand(
    parseMemoryInvocation(["memory", "init"], { repository: fixture.repository }),
    fixture.options,
  );
  const entryText = serializeMemoryEntry({
    frontmatter: {
      id: "symlink-secret",
      type: "work_method",
      status: "approved",
      priority: 50,
      confidence: "high",
      provenance_strength: "direct",
      claim_support: "human-confirmed",
      limitations: [],
      scope: "repo",
      scene: null,
      occurred: [],
      evidence: { commits: [], paths: [] },
      superseded_by: null,
    },
    body: "This content must never cross a symlinked parent.\n",
  });
  await writeFile(path.join(
    fixture.repository,
    ".threadshare",
    "memory",
    "entries",
    "symlink-secret.md",
  ), entryText);
  const preview = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "consolidate"], {
      repository: fixture.repository,
      runner: "claude",
      format: "json",
    }),
    fixture.options,
  );

  const realThreadshare = path.join(fixture.directory, "outside-threadshare");
  await rename(path.join(fixture.repository, ".threadshare"), realThreadshare);
  await symlink(realThreadshare, path.join(fixture.repository, ".threadshare"));
  const marker = path.join(fixture.directory, "runner-executed");
  const previousMarker = process.env.FAKE_RUNNER_MARKER;
  process.env.FAKE_RUNNER_MARKER = marker;
  t.after(() => {
    if (previousMarker === undefined) delete process.env.FAKE_RUNNER_MARKER;
    else process.env.FAKE_RUNNER_MARKER = previousMarker;
  });

  await assert.rejects(
    executeMemoryCommand(
      parseMemoryInvocation(["memory", "consolidate"], {
        repository: fixture.repository,
        runner: "claude",
        "approve-plan": preview.plans[0].planDigest,
        format: "json",
      }),
      fixture.options,
    ),
    (error) => error.code === "TS_MEMORY_BINDING_DRIFT",
  );
  await assert.rejects(stat(marker), (error) => error.code === "ENOENT");
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
  assert.match(rendered, /Confirm this statement, discard its candidate, or defer\? \[y\/d\/N\]:/);
});

test("memory review offers an explicit discard for candidates blocked by lint", async () => {
  const input = ttyStream(new PassThrough());
  const output = ttyStream(new PassThrough());
  let rendered = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => {
    rendered += chunk;
  });

  const reviewer = createMemoryReviewConfirmer({ input, output });
  assert.notEqual(reviewer, null);
  const decision = reviewer.discardCandidate(
    { candidateId: "candidate-blocked" },
    "the sanitization lint gate blocked the generated entry",
  );
  input.end("d\n");
  assert.equal(await decision, true);
  reviewer.close();

  assert.match(rendered, /Candidate: candidate-blocked/u);
  assert.match(rendered, /sanitization lint gate/u);
  assert.match(rendered, /Discard this candidate or defer\? \[d\/N\]:/u);
});

test("memory review can explicitly discard a candidate", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await extractCandidate(fixture);

  const review = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "review"], { repository: fixture.repository }),
    { ...fixture.options, confirmStatement: async () => "discard" },
  );

  assert.equal(review.plan, null);
  assert.equal(review.discarded.length, 1);
  assert.match(review.discarded[0], /^extract-/u);
  assert.deepEqual(review.pending, []);

  const status = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "status"], {
      repository: fixture.repository,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(status.candidates.quarantined, 0);
  assert.equal(status.candidates.discarded, 1);
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

  const codex = parseMemoryInvocation(["memory", "extract"], {
    repository: "/work/threadshare",
    runner: "codex",
    "runner-model": "gpt-5.6-sol",
    "runner-endpoint": "https://api.openai.com/v1",
    request: "memory-filter.json",
    format: "json",
  });
  assert.equal(codex.runner, "codex");
  assert.equal(codex.runnerModel, "gpt-5.6-sol");
  assert.equal(codex.runnerEndpoint, "https://api.openai.com/v1");

  const sessionKey = "1".repeat(64);
  const toolKey = "2".repeat(64);
  const skillKey = "3".repeat(64);
  const parameterized = parseMemoryInvocation(["memory", "extract"], {
    repository: "/work/threadshare",
    runner: "claude",
    since: "2026-08-01T00:00:00.000Z",
    until: "2026-08-22T00:00:00.000Z",
    query: "release verification",
    providers: "codex, claude",
    "session-keys": sessionKey,
    "tool-capability-keys": toolKey,
    "skill-capability-keys": skillKey,
    "result-evidence": "unknown,provider-completed",
    "capability-terminal-states": "failed,completed",
    format: "json",
  });
  assert.equal(parameterized.requestSource, undefined);
  assert.deepEqual(parameterized.extractionRequest, {
    format: "threadshare-memory-extraction-request@v1",
    window: {
      after: "2026-08-01T00:00:00.000Z",
      before: "2026-08-22T00:00:00.000Z",
    },
    query: "release verification",
    filters: {
      providers: ["claude", "codex"],
      sessionKeys: [sessionKey],
      toolCapabilityKeys: [toolKey],
      skillCapabilityKeys: [skillKey],
      resultEvidence: ["provider-completed", "unknown"],
      capabilityTerminalStates: ["completed", "failed"],
    },
  });

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
  assert.throws(
    () => parseMemoryInvocation(["memory", "extract"], {
      runner: "claude",
      request: "memory-filter.json",
      since: "2026-08-01T00:00:00.000Z",
      until: "2026-08-22T00:00:00.000Z",
    }),
    (error) => error?.code === "TS_USAGE_OPTION_CONFLICT",
  );
  assert.throws(
    () => parseMemoryInvocation(["memory", "extract"], {
      runner: "claude",
      since: "2026-08-01T00:00:00.000Z",
    }),
    (error) => error?.code === "TS_USAGE_OPTION_DEPENDENCY",
  );
  assert.throws(
    () => parseMemoryInvocation(["memory", "extract"], {
      runner: "claude",
      query: "release verification",
      "approve-plan": "a".repeat(64),
    }),
    (error) => error?.code === "TS_USAGE_OPTION_CONFLICT",
  );
  assert.throws(
    () => parseMemoryInvocation(["memory", "extract"], {
      runner: "claude",
      request: "memory-filter.json",
      limit: "9",
    }),
    (error) => error?.code === "TS_USAGE_INVALID_VALUE" && /1 to 8/u.test(error.message),
  );
});

test("Agent-native memory actions do not require a runner and keep bounded request inputs", () => {
  const recall = parseMemoryInvocation(["memory", "recall"], {
    repository: "/work/threadshare",
    since: "2026-08-01T00:00:00.000Z",
    until: "2026-08-22T00:00:00.000Z",
    query: "release failures",
    providers: "codex,claude",
    limit: "2",
    format: "json",
  });
  assert.equal(recall.runner, undefined);
  assert.equal(recall.limit, 2);
  assert.equal(recall.extractionRequest.query, "release failures");
  assert.deepEqual(recall.extractionRequest.filters.providers, ["claude", "codex"]);

  assert.deepEqual(parseMemoryInvocation(["memory", "stage"], {
    repository: "/work/threadshare",
    request: "-",
    format: "json",
  }), {
    action: "stage",
    repository: "/work/threadshare",
    requestSource: "-",
    format: "json",
  });
  assert.equal(parseMemoryInvocation(["memory", "prepare"], {
    request: "prepare.json",
  }).requestSource, "prepare.json");
  assert.throws(
    () => parseMemoryInvocation(["memory", "recall"], { runner: "codex" }),
    (error) => error?.code === "TS_USAGE_OPTION_NOT_ALLOWED",
  );
});

test("Memory MCP creates a private Codex pending preview and never runs it", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  const request = JSON.parse(await readFile(fixture.requestFile, "utf8"));
  const preview = await executeMemoryMcp("extract-preview", {
    runner: "codex",
    model: "gpt-5.6-sol",
    endpoint: "https://api.openai.com/v1",
    request,
    limit: 1,
  }, {
    ...fixture.options,
    repository: fixture.repository,
  });
  assert.equal(preview.format, "threadshare-memory-extraction-preview@v1");
  assert.equal(preview.authorized, false);
  assert.equal(preview.plans.length, 1);
  assert.equal(preview.plans[0].provider, "openai");
  assert.equal(preview.plans[0].model, "gpt-5.6-sol");
  assert.equal(preview.plans[0].endpoint, "https://api.openai.com/v1");
  assert.equal(preview.plans[0].authorization, "pending");

  const sidecar = JSON.parse(await readFile(path.join(
    fixture.options.paths.stateDirectory,
    "memory",
    "runner-plans",
    `${preview.plans[0].planDigest}.json`,
  ), "utf8"));
  assert.equal(sidecar.profile.adapter, "codex-cli");
  assert.equal(sidecar.profile.argvTemplate.includes("--ephemeral"), true);
  assert.equal(sidecar.profile.argvTemplate.includes("shell_tool"), true);
  assert.equal(Buffer.from(sidecar.stdinBase64, "base64").toString("utf8")
    .includes(MEMORY_FAKE_PROVIDER_SESSION_ID), false);
});

test("Agent-native recall, stage, prepare, and promote form a runner-free CLI workflow", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await executeMemoryCommand(
    parseMemoryInvocation(["memory", "init"], { repository: fixture.repository }),
    fixture.options,
  );

  const recalled = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "recall"], {
      repository: fixture.repository,
      request: "memory-request.json",
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(recalled.format, "threadshare-memory-agent-recall@v1");
  assert.equal(recalled.sources.length, 1);
  assert.match(recalled.sources[0].chunk.transcript, /Run npm run test:release before publishing/u);
  const source = recalled.sources[0];
  const turnBinding = source.chunk.turnEvidence.find((item) => item.turnIndex === 0);
  assert.ok(turnBinding);
  const turnEvidence = source.evidenceCatalog.find((evidence) =>
    evidence.evidenceId === turnBinding.evidenceId);
  assert.ok(turnEvidence);
  assert.equal(turnEvidence.display, "turn 0");
  assert.ok(source.chunk.transcript.includes(
    `<<past-turn index="0" evidence-id="${turnEvidence.evidenceId}">>`,
  ));
  const candidateContent = "Team Memory submission chunk memory state SQLite3 Git CAS promotion journal: Run npm run test:release before publishing.";

  const stageFile = path.join(fixture.repository, "agent-stage.json");
  await writeFile(stageFile, `${JSON.stringify({
    format: "threadshare-memory-candidate-draft-batch@v1",
    taskId: source.taskId,
    binding: source.binding,
    candidates: [{
      content: candidateContent,
      type: "work_method",
      priority: 80,
      confidence: "high",
      scene: "release-workflow",
      statements: [{
        statementId: "release-check",
        text: candidateContent,
        evidenceIds: [turnEvidence.evidenceId],
      }],
    }],
  })}\n`);
  const staged = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "stage"], {
      repository: fixture.repository,
      request: "agent-stage.json",
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(staged.status, "adjudication-required");
  assert.equal(staged.adjudicationTask.format, "threadshare-memory-adjudication-task@v1");
  assert.equal(staged.reviewItems.length, 0);
  const stagedReplay = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "stage"], {
      repository: fixture.repository,
      request: "agent-stage.json",
      format: "json",
    }),
    fixture.options,
  );
  assert.deepEqual(stagedReplay.adjudicationTask, staged.adjudicationTask);

  const adjudicationFile = path.join(fixture.repository, "agent-adjudication.json");
  await writeFile(adjudicationFile, `${JSON.stringify({
    format: "threadshare-memory-adjudication-result@v1",
    taskId: staged.adjudicationTask.taskId,
    binding: staged.adjudicationTask.binding,
    adjudications: staged.adjudicationTask.drafts.map((draft) => ({
      draftRef: draft.candidateId,
      action: "store",
      targetIds: [],
      mergedFields: null,
    })),
  })}\n`);
  const adjudicated = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "stage"], {
      repository: fixture.repository,
      request: "agent-adjudication.json",
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(adjudicated.status, "staged");
  assert.equal(adjudicated.candidates[0].candidateStatus, "quarantined");
  const adjudicatedReplay = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "stage"], {
      repository: fixture.repository,
      request: "agent-adjudication.json",
      format: "json",
    }),
    fixture.options,
  );
  assert.deepEqual(adjudicatedReplay.candidates, adjudicated.candidates);

  const reviewed = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "review"], {
      repository: fixture.repository,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(reviewed.items.length, 1);
  const candidate = reviewed.items[0];
  const prepareFile = path.join(fixture.repository, "agent-prepare.json");
  await writeFile(prepareFile, `${JSON.stringify({
    format: "threadshare-memory-prepare-request@v1",
    kind: "entry",
    candidates: [{
      candidateId: candidate.candidateId,
      expectedRevision: candidate.revision,
      statements: candidate.assessments.map((assessment) => ({
        statementId: assessment.statementId,
        statementTextDigest: assessment.statementTextDigest,
        citationsDigest: assessment.citationsDigest,
      })),
    }],
  })}\n`);
  const prepared = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "prepare"], {
      repository: fixture.repository,
      request: "agent-prepare.json",
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(prepared.format, "threadshare-memory-prepare@v1");
  assert.equal(prepared.plan.changes.length, 1);
  assert.match(prepared.plan.changes[0].content, /npm run test:release/u);

  const promoted = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "promote"], {
      repository: fixture.repository,
      plan: prepared.plan.planId,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(promoted.status, "applied");
  assert.match(
    await readFile(path.join(fixture.repository, prepared.plan.changes[0].targetPath), "utf8"),
    /npm run test:release/u,
  );
});

test("Agent-native empty stage advances the chunk as an explicit no-op", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await executeMemoryCommand(
    parseMemoryInvocation(["memory", "init"], { repository: fixture.repository }),
    fixture.options,
  );
  const request = JSON.parse(await readFile(fixture.requestFile, "utf8"));
  const recalled = await executeMemoryMcp("recall", { request }, {
    ...fixture.options,
    repository: fixture.repository,
  });
  const source = recalled.sources[0];
  const staged = await executeMemoryMcp("stage", {
    format: "threadshare-memory-candidate-draft-batch@v1",
    taskId: source.taskId,
    binding: source.binding,
    candidates: [],
  }, {
    ...fixture.options,
    repository: fixture.repository,
  });
  assert.equal(staged.noOp, true);
  assert.deepEqual(staged.candidates, []);

  const status = await executeMemoryMcp("status", {}, {
    ...fixture.options,
    repository: fixture.repository,
  });
  assert.equal(status.chunks.extracted, 1);
  assert.equal(status.candidates.quarantined, 0);
  const repeated = await executeMemoryMcp("recall", { request }, {
    ...fixture.options,
    repository: fixture.repository,
  });
  assert.deepEqual(repeated.sources, []);
});

test("Agent-native adjudication can skip a draft covered by approved memory", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await executeMemoryCommand(
    parseMemoryInvocation(["memory", "init"], { repository: fixture.repository }),
    fixture.options,
  );
  const existingId = "existing-release-check";
  const existingText = serializeMemoryEntry({
    frontmatter: {
      id: existingId,
      type: "work_method",
      status: "approved",
      priority: 80,
      confidence: "high",
      provenance_strength: "direct",
      claim_support: "human-confirmed",
      limitations: [],
      scope: "repo",
      scene: null,
      occurred: [],
      evidence: { commits: [], paths: [] },
      superseded_by: null,
    },
    body: "Run npm run test:release before publishing.\n",
  });
  await writeFile(path.join(
    fixture.repository,
    ".threadshare",
    "memory",
    "entries",
    `${existingId}.md`,
  ), existingText);
  await executeMemoryCommand(
    parseMemoryInvocation(["memory", "assemble"], {
      repository: fixture.repository,
      provider: "codex",
    }),
    fixture.options,
  );

  const options = { ...fixture.options, repository: fixture.repository };
  const request = JSON.parse(await readFile(fixture.requestFile, "utf8"));
  const recalled = await executeMemoryMcp("recall", { request }, options);
  const source = recalled.sources[0];
  const evidenceId = source.evidenceCatalog.find((evidence) => evidence.kind === "turn").evidenceId;
  const staged = await executeMemoryMcp("stage", {
    format: "threadshare-memory-candidate-draft-batch@v1",
    taskId: source.taskId,
    binding: source.binding,
    candidates: [{
      content: "Run npm run test:release before publishing.",
      type: "work_method",
      priority: 80,
      confidence: "high",
      scene: null,
      statements: [{
        statementId: "release-check",
        text: "Run npm run test:release before publishing.",
        evidenceIds: [evidenceId],
      }],
    }],
  }, options);
  const covering = staged.adjudicationTask.pool.find((item) =>
    item.sourceKind === "approved" && item.id === existingId);
  assert.ok(covering);

  const adjudicated = await executeMemoryMcp("stage", {
    format: "threadshare-memory-adjudication-result@v1",
    taskId: staged.adjudicationTask.taskId,
    binding: staged.adjudicationTask.binding,
    adjudications: [{
      draftRef: staged.adjudicationTask.drafts[0].candidateId,
      action: "skip",
      targetIds: [covering.id],
      mergedFields: null,
    }],
  }, options);
  assert.equal(adjudicated.candidates[0].candidateStatus, "discarded");
  assert.deepEqual(adjudicated.reviewItems, []);
  assert.equal(adjudicated.next, null);
});

test("Agent-native MCP exposes the same recall-to-promote workflow as the CLI", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await executeMemoryCommand(
    parseMemoryInvocation(["memory", "init"], { repository: fixture.repository }),
    fixture.options,
  );
  const options = { ...fixture.options, repository: fixture.repository };
  const request = JSON.parse(await readFile(fixture.requestFile, "utf8"));
  const recalled = await executeMemoryMcp("recall", { request }, options);
  const source = recalled.sources[0];
  const evidenceId = source.evidenceCatalog.find((evidence) => evidence.kind === "turn").evidenceId;
  const staged = await executeMemoryMcp("stage", {
    format: "threadshare-memory-candidate-draft-batch@v1",
    taskId: source.taskId,
    binding: source.binding,
    candidates: [{
      content: "Run npm run test:release before publishing.",
      type: "work_method",
      priority: 80,
      confidence: "high",
      scene: "release-workflow",
      statements: [{
        statementId: "release-check",
        text: "Run npm run test:release before publishing.",
        evidenceIds: [evidenceId],
      }],
    }],
  }, options);
  assert.equal(staged.status, "adjudication-required");
  assert.equal(staged.reviewItems.length, 0);
  const adjudicated = await executeMemoryMcp("stage", {
    format: "threadshare-memory-adjudication-result@v1",
    taskId: staged.adjudicationTask.taskId,
    binding: staged.adjudicationTask.binding,
    adjudications: staged.adjudicationTask.drafts.map((draft) => ({
      draftRef: draft.candidateId,
      action: "store",
      targetIds: [],
      mergedFields: null,
    })),
  }, options);
  assert.equal(adjudicated.reviewItems.length, 1);
  const candidate = (await executeMemoryMcp("review", { kind: "entry" }, options)).items[0];
  const prepared = await executeMemoryMcp("prepare", {
    format: "threadshare-memory-prepare-request@v1",
    kind: "entry",
    candidates: [{
      candidateId: candidate.candidateId,
      expectedRevision: candidate.revision,
      statements: candidate.assessments.map((assessment) => ({
        statementId: assessment.statementId,
        statementTextDigest: assessment.statementTextDigest,
        citationsDigest: assessment.citationsDigest,
      })),
    }],
  }, options);
  assert.equal(prepared.plan.changes.length, 1);
  const promoted = await executeMemoryMcp("promote", { plan: prepared.plan.planId }, options);
  assert.equal(promoted.status, "applied");
});

test("Agent-native synthesis promotes approved L1 into a reviewed scene without a runner", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  await executeMemoryCommand(
    parseMemoryInvocation(["memory", "init"], { repository: fixture.repository }),
    fixture.options,
  );
  const entry = serializeMemoryEntry({
    frontmatter: {
      id: "release-verification",
      type: "work_method",
      status: "approved",
      priority: 80,
      confidence: "high",
      provenance_strength: "direct",
      claim_support: "human-confirmed",
      limitations: [],
      scope: "repo",
      scene: "release-workflow",
      occurred: [],
      evidence: { commits: [], paths: ["package.json"] },
      superseded_by: null,
    },
    body: "Run npm run test:release before publishing.\n",
  });
  await writeFile(path.join(
    fixture.repository,
    ".threadshare",
    "memory",
    "entries",
    "release-verification.md",
  ), entry);
  const options = { ...fixture.options, repository: fixture.repository };
  const synthesis = await executeMemoryMcp("synthesize", { full: true }, options);
  assert.equal(synthesis.format, "threadshare-memory-synthesis@v1");
  assert.equal(synthesis.entryCount, 1);
  assert.equal(synthesis.task.entries[0].entryId, "release-verification");
  const patch = {
    format: "threadshare-memory-consolidation-patch@v1",
    taskId: synthesis.task.taskId,
    binding: synthesis.task.binding,
    operations: [{
      operationId: "create-release-workflow",
      op: "create",
      target: "scene",
      name: "release-workflow",
      newContent: [
        "-----META-START-----",
        "created: 2026-08-22",
        "updated: 2026-08-22",
        "summary: Release workflow",
        "-----META-END-----",
        "## Release workflow",
        "Run npm run test:release before publishing.",
      ].join("\n"),
      basedOnEntryIds: ["release-verification"],
      mergeSources: [],
      rationale: "Keep the confirmed release check reusable across future sessions.",
    }],
  };
  const staged = await executeMemoryMcp("stage", patch, options);
  assert.equal(staged.candidates.length, 1);
  assert.equal(staged.reviewItems[0].candidateKind, "consolidation-patch");
  const candidate = (await executeMemoryMcp(
    "review",
    { kind: "consolidation" },
    options,
  )).items[0];
  const prepared = await executeMemoryMcp("prepare", {
    format: "threadshare-memory-prepare-request@v1",
    kind: "consolidation",
    candidates: [{
      candidateId: candidate.candidateId,
      expectedRevision: candidate.revision,
      statements: candidate.assessments.map((assessment) => ({
        statementId: assessment.statementId,
        statementTextDigest: assessment.statementTextDigest,
        citationsDigest: assessment.citationsDigest,
      })),
    }],
  }, options);
  assert.equal(prepared.plan.changes[0].targetPath,
    ".threadshare/memory/scenes/release-workflow.md");
  const promoted = await executeMemoryMcp("promote", { plan: prepared.plan.planId }, options);
  assert.equal(promoted.status, "applied");
  assert.match(await readFile(path.join(
    fixture.repository,
    ".threadshare",
    "memory",
    "scenes",
    "release-workflow.md",
  ), "utf8"), /heat: 1/u);
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

test("an extraction manifest produces one adjudication over the shared candidate snapshot", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t, {
    turns: Array.from({ length: 6 }, (_, index) => ({
      turnIndex: index,
      events: [
        { role: "user", text: `Question ${index} ${"u".repeat(6_000)}` },
        { role: "assistant", text: `Answer ${index} ${"a".repeat(6_000)}` },
      ],
    })),
  });
  const preview = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "extract"], {
      repository: fixture.repository,
      runner: "claude",
      request: "memory-request.json",
      limit: "2",
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(preview.plans.length, 2);
  assert.match(preview.manifestDigest, /^[0-9a-f]{64}$/u);

  const extracted = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "extract"], {
      repository: fixture.repository,
      runner: "claude",
      "approve-manifest": preview.manifestDigest,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(extracted.delivered.length, 2);
  assert.equal(extracted.plans.length, 1);
  assert.equal(extracted.plans[0].taskKind, "adjudication");
  assert.equal(extracted.manifestDigest, null);

  const adjudicated = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "extract"], {
      repository: fixture.repository,
      runner: "claude",
      "approve-plan": extracted.plans[0].planDigest,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(adjudicated.delivered[0].adjudication, "applied");
  const status = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "status"], {
      repository: fixture.repository,
      format: "json",
    }),
    fixture.options,
  );
  assert.equal(status.candidates.draft, 0);
  assert.equal(status.candidates.quarantined, 1);
  assert.equal(status.candidates.discarded, 1);
});

test("Insights extraction binds Delivery Trace and advances the chunk cursor only after submit", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t);
  const pending = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "extract"], {
      repository: fixture.repository,
      runner: "claude",
      since: "2026-08-10T08:00:00.000Z",
      until: "2026-08-10T10:00:00.000Z",
      providers: "codex",
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

test("review keeps a generated entry slug valid when its title is truncated", {
  skip: INSIGHTS_E2E_SKIP,
  timeout: 120_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t, {
    turns: [{
      turnIndex: 0,
      events: [
        { role: "user", text: "THREADSHARE_TEST_SLUG_TRUNCATION" },
        { role: "assistant", text: "Record the reusable repository guidance." },
      ],
    }],
  });
  await extractCandidate(fixture);

  const review = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "review"], { repository: fixture.repository }),
    { ...fixture.options, confirmStatement: async () => true },
  );

  assert.notEqual(review.plan, null);
  assert.equal(
    review.plan.files[0].targetPath,
    `.threadshare/memory/entries/${"a".repeat(59)}.md`,
  );
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
      if (!answered && stderr.includes("Confirm this statement, discard its candidate, or defer? [y/d/N]:")) {
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
  assert.match(result.stderr, /Confirm this statement, discard its candidate, or defer\? \[y\/d\/N\]:/);
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

test("adjudication rejects a schema-valid result bound to another task", {
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
  const previous = process.env.THREADSHARE_TEST_WRONG_ADJUDICATION_BINDING;
  process.env.THREADSHARE_TEST_WRONG_ADJUDICATION_BINDING = "1";
  try {
    await assert.rejects(
      executeMemoryCommand(
        parseMemoryInvocation(["memory", "extract"], {
          repository: fixture.repository,
          runner: "claude",
          format: "json",
          "approve-plan": afterExtraction.plans[0].planDigest,
        }),
        fixture.options,
      ),
      (error) => error.code === "TS_INPUT_SCHEMA_INVALID" && /task binding/.test(error.message),
    );
  } finally {
    if (previous === undefined) delete process.env.THREADSHARE_TEST_WRONG_ADJUDICATION_BINDING;
    else process.env.THREADSHARE_TEST_WRONG_ADJUDICATION_BINDING = previous;
  }
});
