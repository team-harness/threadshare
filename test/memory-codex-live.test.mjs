import assert from "node:assert/strict";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  executeMemoryCommand,
  executeMemoryMcp,
  parseMemoryInvocation,
} from "../src/memory-command.mjs";
import { serializeMemoryEntry } from "../src/memory-format.mjs";
import { createMemoryCommandFixture } from "./helpers/memory-command-e2e.mjs";

function requiredEnvironment(name) {
  const value = process.env[name];
  if (typeof value !== "string" || value.length === 0) {
    throw new Error(`${name} is required for the real Codex Team Memory acceptance gate`);
  }
  return value;
}

const codexBinary = requiredEnvironment("THREADSHARE_MEMORY_CODEX_BIN");
const codexModel = requiredEnvironment("THREADSHARE_MEMORY_RUNNER_MODEL");
const codexEndpoint = requiredEnvironment("THREADSHARE_MEMORY_RUNNER_ENDPOINT");

function extractionInvocation(repository, overrides = {}) {
  return parseMemoryInvocation(["memory", "extract"], {
    repository,
    runner: "codex",
    format: "json",
    ...overrides,
  });
}

test("real Codex CLI completes extraction, adjudication, consolidation, review, and assembly", {
  timeout: 600_000,
}, async (t) => {
  const fixture = await createMemoryCommandFixture(t, {
    turns: [{
      turnIndex: 0,
      events: [
        {
          role: "user",
          text: "The team approved a durable repository policy today: run npm run test:release before every publish.",
        },
        {
          role: "assistant",
          text: "Confirmed. This is now the repository release-verification policy and should be retained as team guidance.",
        },
      ],
    }, {
      turnIndex: 1,
      events: [
        { role: "user", text: "Confirmed; the policy is adopted and not merely a suggestion." },
        { role: "assistant", text: "Recorded as an adopted team convention." },
      ],
    }],
  });
  const request = JSON.parse(await readFile(fixture.requestFile, "utf8"));
  const sourceSessionDirectory = path.dirname(fixture.sessionFile);
  const sourceSessionsBefore = (await readdir(sourceSessionDirectory)).sort();
  const liveOptions = {
    ...fixture.options,
    runnerBinaryPath: codexBinary,
    runnerTempRoot: fixture.directory,
    conformanceTimeoutMs: 300_000,
  };

  const pending = await executeMemoryMcp("extract-preview", {
    runner: "codex",
    model: codexModel,
    endpoint: codexEndpoint,
    request,
    limit: 1,
  }, {
    ...liveOptions,
    repository: fixture.repository,
  });
  assert.equal(pending.authorized, false);
  assert.equal(pending.plans.length, 1);
  assert.equal(pending.plans[0].provider, "openai");
  assert.equal(pending.plans[0].model, codexModel);
  assert.equal(pending.plans[0].endpoint, codexEndpoint);

  const extracted = await executeMemoryCommand(
    extractionInvocation(fixture.repository, {
      "approve-plan": pending.plans[0].planDigest,
    }),
    liveOptions,
  );
  assert.equal(extracted.authorized, true);
  assert.equal(extracted.delivered.length, 1);
  assert.equal(extracted.delivered[0].taskKind, "extraction");
  assert.ok(extracted.delivered[0].candidates > 0, "real Codex must produce a citable candidate");
  assert.equal(extracted.plans.length, 1);
  assert.equal(extracted.plans[0].taskKind, "adjudication");

  const adjudicated = await executeMemoryCommand(
    extractionInvocation(fixture.repository, {
      "approve-plan": extracted.plans[0].planDigest,
    }),
    liveOptions,
  );
  assert.equal(adjudicated.delivered.length, 1);
  assert.equal(adjudicated.delivered[0].taskKind, "adjudication");
  assert.equal(adjudicated.delivered[0].adjudication, "applied");

  await executeMemoryCommand(
    parseMemoryInvocation(["memory", "init"], { repository: fixture.repository }),
    liveOptions,
  );
  const approvedEntry = serializeMemoryEntry({
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
    body: [
      "Before every npm release, run npm run test:release and require it to pass.",
      "This durable repository method belongs in the reusable release-workflow scene.",
      "It prevents publishing artifacts that have not passed the release verification suite.",
      "",
    ].join("\n"),
  });
  const entriesDirectory = path.join(fixture.repository, ".threadshare", "memory", "entries");
  await mkdir(entriesDirectory, { recursive: true });
  await writeFile(path.join(entriesDirectory, "release-verification.md"), approvedEntry);

  const consolidationPreview = await executeMemoryMcp("consolidate-preview", {
    runner: "codex",
    model: codexModel,
    endpoint: codexEndpoint,
  }, {
    ...liveOptions,
    repository: fixture.repository,
  });
  assert.equal(consolidationPreview.authorized, false);
  assert.equal(consolidationPreview.entryCount, 1);
  assert.equal(consolidationPreview.plans.length, 1);
  assert.equal(consolidationPreview.plans[0].taskKind, "consolidation");
  assert.equal(consolidationPreview.plans[0].provider, "openai");
  assert.equal(consolidationPreview.plans[0].model, codexModel);
  assert.equal(consolidationPreview.plans[0].endpoint, codexEndpoint);
  assert.doesNotMatch(JSON.stringify(consolidationPreview), /Before every npm release/u,
    "MCP preview must not expose approved memory content");

  const consolidated = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "consolidate"], {
      repository: fixture.repository,
      runner: "codex",
      "approve-plan": consolidationPreview.plans[0].planDigest,
      format: "json",
    }),
    liveOptions,
  );
  assert.equal(consolidated.status, "pending_review",
    "real Codex must return a non-empty, host-valid consolidation patch");
  assert.match(consolidated.candidateId, /^patch-consolidate-/u);

  let reviewedOperations = 0;
  const reviewed = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "review"], {
      repository: fixture.repository,
      kind: "consolidation",
      format: "text",
    }),
    {
      ...liveOptions,
      async confirmStatement(item) {
        assert.equal(item.candidateKind, "consolidation-patch");
        assert.match(item.payload.reviewStatements[0].text, /\+\+\+ proposed/u);
        reviewedOperations += 1;
        return true;
      },
    },
  );
  assert.ok(reviewedOperations > 0);
  assert.notEqual(reviewed.plan, null);

  const promoted = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "promote"], {
      repository: fixture.repository,
      plan: reviewed.plan.planId,
      format: "json",
    }),
    liveOptions,
  );
  assert.equal(promoted.status, "applied");
  assert.ok(promoted.appliedFiles.some((file) =>
    file.startsWith(".threadshare/memory/scenes/") && file.endsWith(".md")),
  "real consolidation must materialize at least one L2 scene");
  const sceneNames = (await readdir(path.join(
    fixture.repository, ".threadshare", "memory", "scenes",
  ))).filter((name) => name.endsWith(".md"));
  assert.ok(sceneNames.length > 0);
  const sceneText = await readFile(path.join(
    fixture.repository, ".threadshare", "memory", "scenes", sceneNames[0],
  ), "utf8");
  assert.match(sceneText, /\nheat: 1\n/u, "host must calculate first-use scene heat");

  const assembled = await executeMemoryCommand(
    parseMemoryInvocation(["memory", "assemble"], {
      repository: fixture.repository,
      provider: "codex",
    }),
    liveOptions,
  );
  assert.equal(assembled.target, "AGENTS.md");
  assert.ok(assembled.scenes > 0);
  const agentsText = await readFile(path.join(fixture.repository, "AGENTS.md"), "utf8");
  assert.match(agentsText, /<!-- BEGIN THREADSHARE MEMORY/u);
  assert.match(agentsText, /\.threadshare\/memory\/scenes\//u);

  const noDelta = await executeMemoryMcp("consolidate-preview", {
    runner: "codex",
    model: codexModel,
    endpoint: codexEndpoint,
  }, {
    ...liveOptions,
    repository: fixture.repository,
  });
  assert.deepEqual(noDelta.plans, []);
  assert.equal(noDelta.entryCount, 0);

  const conformance = JSON.parse(await readFile(path.join(
    fixture.options.paths.stateDirectory,
    "memory",
    "conformance",
    "codex-cli.json",
  ), "utf8"));
  assert.match(conformance.profileDigest, /^[0-9a-f]{64}$/u);
  assert.match(conformance.binaryContentSha256, /^[0-9a-f]{64}$/u);
  assert.match(conformance.signature, /^[0-9a-f]{64}$/u);

  assert.deepEqual((await readdir(sourceSessionDirectory)).sort(), sourceSessionsBefore,
    "ephemeral Codex execution must not create an indexable source session");
  assert.equal((await readdir(fixture.directory)).some((name) =>
    name.startsWith("threadshare-memory-codex-") ||
    name.startsWith("threadshare-memory-conformance-")), false,
  "all ephemeral Codex and conformance directories must be removed");
});
