import assert from "node:assert/strict";
import { readdir, readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";

import {
  executeMemoryCommand,
  executeMemoryMcp,
  parseMemoryInvocation,
} from "../src/memory-command.mjs";
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

test("real Codex CLI passes conformance and completes extraction plus adjudication", {
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
