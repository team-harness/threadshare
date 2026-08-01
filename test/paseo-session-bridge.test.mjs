import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { exportPaseoSession } from "../src/paseo-session-bridge.mjs";

const execFileAsync = promisify(execFile);
const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "bin", "threadshare.mjs");
const DEFAULT_AGENT_ID = "f74b2222-1f3c-4d35-b790-c14d253a78d2";
const DEFAULT_CODEX_SESSION_ID = "019f6e08-8538-7423-a293-7f553379f212";
const DEFAULT_CLAUDE_SESSION_ID = "95ad00c9-bd1a-4148-b98a-aa8fd95348d6";

const fakePaseoSource = `#!/usr/bin/env node
import { readFileSync } from "node:fs";

const fixture = JSON.parse(readFileSync(process.env.THREADSHARE_TEST_PASEO_FIXTURE, "utf8"));
const args = process.argv.slice(2);
let response;
if (args[0] === "daemon" && args[1] === "status" && args[2] === "--json") {
  response = fixture.status;
} else if (
  args[0] === "agent" &&
  args[1] === "inspect" &&
  args[3] === "--json"
) {
  if (fixture.expectedAgentRef && args[2] !== fixture.expectedAgentRef) {
    process.stderr.write("unexpected agent reference");
    process.exit(9);
  }
  response = fixture.inspect;
} else {
  process.stderr.write("unexpected paseo invocation: " + JSON.stringify(args));
  process.exit(8);
}

if (response.delayMs) {
  await new Promise((resolve) => setTimeout(resolve, response.delayMs));
}
if (response.stderr) process.stderr.write(response.stderr);
if (response.exitCode) {
  process.exitCode = response.exitCode;
} else {
  process.stdout.write(
    typeof response.body === "string" ? response.body : JSON.stringify(response.body),
  );
}
`;

function hasOwn(object, key) {
  return Object.prototype.hasOwnProperty.call(object, key);
}

function codexJsonl(sessionId, { truncated = false } = {}) {
  const lines = [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-31T00:00:00.000Z",
      payload: { session_id: sessionId },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-31T00:00:01.000Z",
      payload: {
        type: "message",
        id: "paseo-user",
        role: "user",
        content: [{ type: "input_text", text: "Paseo Codex fixture" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-31T00:00:02.000Z",
      payload: {
        type: "function_call",
        call_id: "paseo-tool",
        name: "fixture_tool",
        arguments: "{}",
      },
    }),
  ];
  if (truncated) lines.push('{"type":"response_item"');
  return `${lines.join("\n")}\n`;
}

function claudeJsonl() {
  return `${JSON.stringify({
    type: "user",
    uuid: "paseo-claude-user",
    timestamp: "2026-07-31T00:00:01.000Z",
    message: { role: "user", content: "Paseo Claude fixture" },
  })}\n`;
}

async function createPaseoFixture(options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-paseo-test-"));
  const binDirectory = path.join(directory, "bin");
  const paseoHome = path.join(directory, "paseo-home");
  const userHome = path.join(directory, "user-home");
  const codexHome = path.join(directory, "codex-home");
  const agentsDirectory = path.join(paseoHome, "agents");
  const fixtureFile = path.join(directory, "paseo-fixture.json");
  const paseoCommand = path.join(binDirectory, "paseo");
  const provider = options.provider ?? "codex";
  const agentId = options.agentId ?? DEFAULT_AGENT_ID;
  const agentRef = options.agentRef ?? agentId.slice(0, 8);
  const nativeSessionId =
    options.nativeSessionId ??
    (provider === "claude" ? DEFAULT_CLAUDE_SESSION_ID : DEFAULT_CODEX_SESSION_ID);

  await mkdir(binDirectory, { recursive: true });
  await mkdir(agentsDirectory, { recursive: true });
  await mkdir(userHome, { recursive: true });
  await writeFile(paseoCommand, fakePaseoSource);
  await chmod(paseoCommand, 0o755);

  const statusBody = {
    connectedDaemon: "reachable",
    home: paseoHome,
    cliVersion: "0.2.4-test",
    daemonVersion: "0.2.4-test",
    ...(options.statusOverrides ?? {}),
  };
  const inspectBody = {
    Id: agentId,
    Provider: provider,
    Status: options.agentStatus ?? "idle",
  };
  inspectBody.Name = hasOwn(options, "name") ? options.name : "Paseo fixture";
  inspectBody.Model = hasOwn(options, "model") ? options.model : "fixture-model";
  Object.assign(inspectBody, options.inspectOverrides ?? {});

  const fixture = {
    expectedAgentRef: agentRef,
    status: options.statusResponse ?? { body: statusBody },
    inspect: options.inspectResponse ?? { body: inspectBody },
  };
  await writeFile(fixtureFile, JSON.stringify(fixture));

  const state = {
    id: agentId,
    provider,
    persistence: {
      nativeHandle: hasOwn(options, "nativeHandle")
        ? options.nativeHandle
        : nativeSessionId,
    },
    runtimeInfo: {
      sessionId: hasOwn(options, "runtimeSessionId")
        ? options.runtimeSessionId
        : nativeSessionId,
    },
    ...(options.stateOverrides ?? {}),
  };
  const stateContents = hasOwn(options, "stateRaw")
    ? options.stateRaw
    : JSON.stringify(state);
  const stateMode = options.stateMode ?? "regular";
  const writeState = async (parent) => {
    await mkdir(parent, { recursive: true });
    await writeFile(path.join(parent, `${agentId}.json`), stateContents);
  };
  if (stateMode === "regular") {
    await writeState(path.join(agentsDirectory, "nested", "workspace"));
  } else if (stateMode === "multiple") {
    await writeState(path.join(agentsDirectory, "workspace-a"));
    await writeState(path.join(agentsDirectory, "workspace-b"));
  } else if (stateMode === "file-symlink") {
    const target = path.join(directory, "outside-state.json");
    const parent = path.join(agentsDirectory, "workspace");
    await mkdir(parent, { recursive: true });
    await writeFile(target, stateContents);
    await symlink(target, path.join(parent, `${agentId}.json`));
  } else if (stateMode === "directory-symlink") {
    const target = path.join(directory, "outside-workspace");
    await writeState(target);
    await symlink(target, path.join(agentsDirectory, "linked-workspace"), "dir");
  }

  if (options.nativeFile !== false && (provider === "codex" || provider === "claude")) {
    if (provider === "codex") {
      const sessionDirectory = path.join(codexHome, "sessions", "2026", "07", "31");
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(
        path.join(sessionDirectory, `rollout-${nativeSessionId}.jsonl`),
        options.nativeRaw ?? codexJsonl(nativeSessionId, { truncated: options.truncated }),
      );
    } else {
      const sessionDirectory = path.join(userHome, ".claude", "projects", "fixture");
      await mkdir(sessionDirectory, { recursive: true });
      await writeFile(
        path.join(sessionDirectory, `${nativeSessionId}.jsonl`),
        options.nativeRaw ?? claudeJsonl(),
      );
    }
  }

  const env = {
    ...process.env,
    PATH: `${binDirectory}${path.delimiter}${process.env.PATH ?? ""}`,
    HOME: userHome,
    CODEX_HOME: codexHome,
    THREADSHARE_TEST_PASEO_FIXTURE: fixtureFile,
  };

  return {
    agentId,
    agentRef,
    directory,
    env,
    nativeSessionId,
    paseoCommand,
    async cleanup() {
      await rm(directory, { recursive: true, force: true });
    },
  };
}

function runCli(fixture, args) {
  return spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: fixture.env,
    timeout: 5_000,
  });
}

test("exports a Codex-backed Paseo agent by unique prefix", async () => {
  const fixture = await createPaseoFixture({
    agentStatus: "running",
    name: "Paseo Codex agent",
    model: "gpt-fixture",
    truncated: true,
  });
  try {
    const result = runCli(fixture, ["export", "paseo", fixture.agentRef]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    const history = JSON.parse(result.stdout);
    assert.deepEqual(history.conversation, {
      id: fixture.agentId,
      title: "Paseo Codex agent",
      provider: "codex",
      model: "gpt-fixture",
      source: "paseo",
    });
    assert.deepEqual(history.entries.map((entry) => entry.kind), ["message", "tool"]);
    assert.equal(history.entries[0].markdown, "Paseo Codex fixture");
    assert.equal(history.entries[1].status, "running");
    assert.doesNotMatch(result.stdout, new RegExp(fixture.nativeSessionId));
    assert.doesNotMatch(result.stdout, new RegExp(fixture.directory));
  } finally {
    await fixture.cleanup();
  }
});

test("exports a Claude-backed Paseo agent by full ID using runtimeInfo fallback", async () => {
  const fixture = await createPaseoFixture({
    provider: "claude",
    agentRef: DEFAULT_AGENT_ID,
    nativeHandle: "",
    name: "   ",
    model: undefined,
  });
  try {
    const result = runCli(fixture, ["export", "paseo", fixture.agentRef]);
    assert.equal(result.status, 0, result.stderr);
    const history = JSON.parse(result.stdout);
    assert.deepEqual(history.conversation, {
      id: fixture.agentId,
      title: "Paseo conversation",
      provider: "claude",
      source: "paseo",
    });
    assert.equal(history.entries[0].markdown, "Paseo Claude fixture");
  } finally {
    await fixture.cleanup();
  }
});

test("shares a Paseo agent with one-line JSON output", async () => {
  const fixture = await createPaseoFixture();
  let received;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = {
        contentType: request.headers["content-type"],
        method: request.method,
        path: request.url,
        history: JSON.parse(Buffer.concat(chunks).toString("utf8")),
      };
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "11111111-2222-4333-8444-555555555555" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await execFileAsync(
      process.execPath,
      [cli, "share", "paseo", fixture.agentRef, "--url", serviceUrl, "--json"],
      { encoding: "utf8", env: fixture.env },
    );
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.split("\n").length, 2);
    assert.deepEqual(JSON.parse(result.stdout), {
      id: "11111111-2222-4333-8444-555555555555",
      url: `${serviceUrl}/?id=11111111-2222-4333-8444-555555555555`,
    });
    assert.equal(received.method, "POST");
    assert.equal(received.path, "/api/v1/shares");
    assert.equal(received.contentType, "application/json");
    assert.equal(received.history.conversation.id, fixture.agentId);
    assert.equal(received.history.conversation.source, "paseo");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fixture.cleanup();
  }
});

test("dry-runs a Paseo agent without contacting the share service", async () => {
  const fixture = await createPaseoFixture();
  try {
    const result = runCli(fixture, [
      "share",
      "paseo",
      fixture.agentRef,
      "--dry-run",
      "--report",
      "--revoke",
      "--url",
      "http://127.0.0.1:1",
      "--json",
    ]);
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.split("\n").length, 2);
    const payload = JSON.parse(result.stdout);
    assert.equal(payload.dryRun, true);
    assert.equal(payload.valid, true);
    assert.deepEqual(payload.intent, { expiresInSeconds: null, revoke: true });
    assert.equal(payload.report.entryKinds.message, 1);
    assert.equal(payload.report.entryKinds.tool, 1);
    assert.equal(payload.report.userTurns, 1);
    assert.equal(Object.hasOwn(payload, "id"), false);
    assert.equal(Object.hasOwn(payload, "url"), false);
    assert.equal(Object.hasOwn(payload, "revokeToken"), false);
    assert.doesNotMatch(result.stdout, new RegExp(fixture.nativeSessionId));
    assert.doesNotMatch(result.stdout, new RegExp(fixture.directory));
  } finally {
    await fixture.cleanup();
  }
});

test("lists candidates and publishes a bounded Paseo range through the shared selector", async () => {
  const nativeRaw = (sessionId) =>
    [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-31T00:00:00.000Z",
        payload: { session_id: sessionId },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-31T00:00:01.000Z",
        payload: {
          type: "message",
          id: "paseo-range-start",
          role: "user",
          content: [{ type: "input_text", text: "Start Paseo range" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-31T00:00:02.000Z",
        payload: {
          type: "message",
          id: "paseo-range-answer",
          role: "assistant",
          content: [{ type: "output_text", text: "Included answer" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-31T00:00:03.000Z",
        payload: {
          type: "message",
          id: "paseo-range-boundary",
          role: "user",
          content: [{ type: "input_text", text: "Share this Paseo session" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-31T00:00:04.000Z",
        payload: {
          type: "message",
          id: "paseo-range-orchestration",
          role: "assistant",
          content: [{ type: "output_text", text: "PRIVATE ORCHESTRATION" }],
        },
      }),
    ].join("\n");
  const fixture = await createPaseoFixture();
  await writeFile(
    path.join(
      fixture.env.CODEX_HOME,
      "sessions",
      "2026",
      "07",
      "31",
      `rollout-${fixture.nativeSessionId}.jsonl`,
    ),
    nativeRaw(fixture.nativeSessionId),
  );

  let received;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "11111111-2222-4333-8444-555555555555" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    const candidates = runCli(fixture, [
      "messages",
      "paseo",
      fixture.agentRef,
      "--format",
      "json",
    ]);
    assert.equal(candidates.status, 0, candidates.stderr);
    const page = JSON.parse(candidates.stdout);
    assert.equal(page.boundaryId, "paseo-range-boundary");
    assert.deepEqual(page.messages.map((message) => message.id), ["paseo-range-start"]);

    const shared = await execFileAsync(
      process.execPath,
      [
        cli,
        "share",
        "paseo",
        fixture.agentRef,
        "--from",
        "paseo-range-start",
        "--before",
        page.boundaryId,
        "--url",
        serviceUrl,
        "--json",
      ],
      { encoding: "utf8", env: fixture.env },
    );
    assert.equal(shared.stderr, "");
    assert.deepEqual(
      received.entries.map((entry) => entry.id),
      ["paseo-range-start", "paseo-range-answer"],
    );
    assert.equal(received.conversation.source, "paseo");
    assert.doesNotMatch(JSON.stringify(received), /PRIVATE ORCHESTRATION/);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await fixture.cleanup();
  }
});

test("rejects malformed Paseo agent references before invoking Paseo", async () => {
  const fixture = await createPaseoFixture();
  try {
    const result = runCli(fixture, ["export", "paseo", "../../agent.json"]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Paseo agent reference must be a UUID or UUID prefix/);
  } finally {
    await fixture.cleanup();
  }
});

test("maps Paseo CLI absence, timeout, and structured errors", async (t) => {
  await t.test("CLI absence", async () => {
    await assert.rejects(
      exportPaseoSession(DEFAULT_AGENT_ID.slice(0, 8), {
        paseoCommand: path.join(os.tmpdir(), "threadshare-no-such-paseo"),
      }),
      /Paseo CLI was not found/,
    );
  });

  await t.test("timeout", async () => {
    const fixture = await createPaseoFixture({
      statusResponse: { body: {}, delayMs: 200 },
    });
    try {
      await assert.rejects(
        exportPaseoSession(fixture.agentRef, {
          env: fixture.env,
          paseoCommand: fixture.paseoCommand,
          timeoutMs: 20,
        }),
        /timed out/,
      );
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("structured stderr", async () => {
    const fixture = await createPaseoFixture({
      inspectResponse: {
        exitCode: 1,
        stderr: JSON.stringify({
          error: { code: "INSPECT_FAILED", message: "Agent not found: fixture-prefix" },
        }),
      },
    });
    try {
      const result = runCli(fixture, ["export", "paseo", fixture.agentRef]);
      assert.equal(result.status, 1);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, /Agent not found: fixture-prefix/);
      assert.doesNotMatch(result.stderr, /INSPECT_FAILED/);
    } finally {
      await fixture.cleanup();
    }
  });

  await t.test("output limit", async () => {
    const fixture = await createPaseoFixture({
      statusResponse: { body: "x".repeat(512) },
    });
    try {
      await assert.rejects(
        exportPaseoSession(fixture.agentRef, {
          env: fixture.env,
          maxBuffer: 64,
          paseoCommand: fixture.paseoCommand,
        }),
        /output exceeded 64 bytes/,
      );
    } finally {
      await fixture.cleanup();
    }
  });
});

test("fails closed on malformed Paseo status and inspect responses", async (t) => {
  const scenarios = [
    {
      name: "invalid status JSON",
      options: { statusResponse: { body: "{" } },
      expected: /daemon status returned invalid JSON/,
    },
    {
      name: "unreachable daemon",
      options: { statusOverrides: { connectedDaemon: "unreachable" } },
      expected: /daemon is not reachable.*0\.2\.4-test/,
    },
    {
      name: "relative daemon home",
      options: { statusOverrides: { home: "relative/paseo-home" } },
      expected: /daemon status returned an invalid home/,
    },
    {
      name: "invalid inspect JSON",
      options: { inspectResponse: { body: "not json" } },
      expected: /agent inspect returned invalid JSON/,
    },
    {
      name: "non-UUID inspected ID",
      options: { inspectOverrides: { Id: "f74b2222" } },
      expected: /agent inspect returned an invalid Id/,
    },
    {
      name: "inspected ID does not match requested prefix",
      options: {
        inspectOverrides: { Id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      },
      expected: /inspected agent ID does not match the requested reference/,
    },
    {
      name: "wrong status type",
      options: { inspectOverrides: { Status: 1 } },
      expected: /agent inspect returned an invalid Status/,
    },
    {
      name: "wrong name type",
      options: { name: 1 },
      expected: /agent inspect returned an invalid Name/,
    },
    {
      name: "unsupported provider",
      options: { provider: "deepseek" },
      expected: /does not support Paseo provider deepseek/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = await createPaseoFixture(scenario.options);
      try {
        const result = runCli(fixture, ["export", "paseo", fixture.agentRef]);
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, scenario.expected);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("fails closed on malformed or inconsistent Paseo state", async (t) => {
  const scenarios = [
    {
      name: "invalid JSON",
      options: { stateRaw: "{" },
      expected: /state file contains invalid JSON/,
    },
    {
      name: "agent ID mismatch",
      options: {
        stateOverrides: { id: "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee" },
      },
      expected: /state agent ID does not match/,
    },
    {
      name: "provider mismatch",
      options: { stateOverrides: { provider: "claude" } },
      expected: /state provider does not match/,
    },
    {
      name: "missing handle",
      options: { nativeHandle: "", runtimeSessionId: "" },
      expected: /does not contain a native session ID/,
    },
    {
      name: "path-shaped native handle",
      options: {
        nativeHandle: "../../private-session.jsonl",
        runtimeSessionId: DEFAULT_CODEX_SESSION_ID,
      },
      expected: /native session ID must be a complete UUID/,
    },
    {
      name: "wrong persistence type",
      options: { stateOverrides: { persistence: "invalid" } },
      expected: /state persistence must be an object/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = await createPaseoFixture(scenario.options);
      try {
        const result = runCli(fixture, ["export", "paseo", fixture.agentRef]);
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, scenario.expected);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("requires one regular Paseo state file and ignores symlinks", async (t) => {
  const scenarios = [
    { name: "missing", stateMode: "missing", expected: /No Paseo state file found/ },
    { name: "multiple", stateMode: "multiple", expected: /Multiple Paseo state files found/ },
    { name: "file symlink", stateMode: "file-symlink", expected: /No Paseo state file found/ },
    {
      name: "directory symlink",
      stateMode: "directory-symlink",
      expected: /No Paseo state file found/,
    },
  ];

  for (const scenario of scenarios) {
    await t.test(scenario.name, async () => {
      const fixture = await createPaseoFixture({ stateMode: scenario.stateMode });
      try {
        const result = runCli(fixture, ["export", "paseo", fixture.agentRef]);
        assert.equal(result.status, 1, result.stderr);
        assert.equal(result.stdout, "");
        assert.match(result.stderr, scenario.expected);
      } finally {
        await fixture.cleanup();
      }
    });
  }
});

test("reports a missing native Codex session without exposing state paths", async () => {
  const fixture = await createPaseoFixture({ nativeFile: false });
  try {
    const result = runCli(fixture, ["export", "paseo", fixture.agentRef]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /No native codex session found/);
    assert.doesNotMatch(result.stderr, new RegExp(fixture.directory));
  } finally {
    await fixture.cleanup();
  }
});

test("rejects a native transcript whose embedded session ID does not match", async () => {
  const otherSessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const fixture = await createPaseoFixture({
    nativeRaw: codexJsonl(otherSessionId),
  });
  try {
    const result = runCli(fixture, ["export", "paseo", fixture.agentRef]);
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /Native codex session ID does not match Paseo state/);
    assert.doesNotMatch(result.stderr, new RegExp(fixture.nativeSessionId));
    assert.doesNotMatch(result.stderr, new RegExp(otherSessionId));
  } finally {
    await fixture.cleanup();
  }
});
