import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  exportClaudeJsonl,
  exportCodexJsonl,
  exportSessionById,
  resolveSessionFile,
} from "../src/session-export.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "bin", "threadshare.mjs");
const execFileAsync = promisify(execFile);

function canonicalHistory() {
  return {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    exportedAt: "2026-07-30T00:00:00.000Z",
    conversation: { id: "conversation-1", title: "CLI test" },
    entries: [],
  };
}

function codexCliJsonl(turns) {
  const records = [
    {
      type: "session_meta",
      timestamp: "2026-07-31T00:00:00.000Z",
      payload: { session_id: "cli-selection" },
    },
  ];
  for (let index = 1; index <= turns; index += 1) {
    records.push(
      {
        type: "response_item",
        timestamp: `2026-07-31T00:00:${String(index * 2 - 1).padStart(2, "0")}.000Z`,
        payload: {
          type: "message",
          id: `cli-user-${index}`,
          role: "user",
          content: [{ type: "input_text", text: `CLI request ${index}` }],
        },
      },
      {
        type: "response_item",
        timestamp: `2026-07-31T00:00:${String(index * 2).padStart(2, "0")}.000Z`,
        payload: {
          type: "message",
          id: `cli-assistant-${index}`,
          role: "assistant",
          content: [{ type: "output_text", text: `CLI answer ${index}` }],
        },
      },
    );
  }
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function createCliSession(raw = codexCliJsonl(13), name = "session.jsonl") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-range-"));
  const file = path.join(directory, name);
  await writeFile(file, raw);
  return { directory, file };
}

test("prints CLI help with either help spelling", () => {
  for (const argument of ["help", "--help"]) {
    const result = spawnSync(process.execPath, [path.join(root, "bin/threadshare.mjs"), argument], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /threadshare share <codex\|claude\|paseo>/);
    assert.match(result.stdout, /threadshare sessions <codex\|claude>/);
    assert.match(result.stdout, /threadshare messages <codex\|claude\|paseo>/);
    assert.match(result.stdout, /threadshare read <share-url> --format <json\|markdown>/);
    assert.match(result.stdout, /--from <user-message-id\|last-user>/);
    assert.match(result.stdout, /--pick-start/);
    assert.match(result.stdout, /omit --from and --before for the full visible snapshot/);
    assert.match(result.stdout, /https:\/\/cloud-thread\.team-harness\.com/);
    assert.equal(result.stderr, "");
  }
});

test("keeps the bundled Skill aligned with the agent pagination workflow", () => {
  const skill = readFileSync(path.join(root, "skills", "threadshare", "SKILL.md"), "utf8");
  assert.match(skill, /sessions <codex\|claude> --format json/);
  assert.match(skill, /Do not assume the newest result is the requested session/);
  assert.match(skill, /messages <provider> <session> --format json/);
  assert.match(skill, /--before <original-boundary-id> --offset <next-offset>/);
  assert.match(
    skill,
    /--from <selected-message-id> --before <original-boundary-id> --json/,
  );
  assert.match(skill, /Show the user numbered candidate previews without IDs/);
  assert.match(skill, /must not use interactive `--pick-start` or `--from last-user`/);
});

test("lists ten user-message candidates and loads an older page as one-line JSON", async () => {
  const fixture = await createCliSession();
  try {
    const first = spawnSync(
      process.execPath,
      [cli, "messages", "codex", fixture.file, "--format", "json"],
      { encoding: "utf8" },
    );
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, "");
    assert.equal(first.stdout.split("\n").length, 2);
    const firstPage = JSON.parse(first.stdout);
    assert.equal(firstPage.boundaryId, "cli-user-13");
    assert.equal(firstPage.messages.length, 10);
    assert.equal(firstPage.messages[0].id, "cli-user-12");
    assert.equal(firstPage.messages[9].id, "cli-user-3");
    assert.equal(firstPage.nextOffset, 10);

    const second = spawnSync(
      process.execPath,
      [
        cli,
        "messages",
        "codex",
        fixture.file,
        "--format",
        "json",
        "--before",
        firstPage.boundaryId,
        "--offset",
        String(firstPage.nextOffset),
      ],
      { encoding: "utf8" },
    );
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(
      JSON.parse(second.stdout).messages.map((message) => message.id),
      ["cli-user-2", "cli-user-1"],
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("exports a selected Codex and Claude range while preserving full-export compatibility", async () => {
  const codex = await createCliSession(codexCliJsonl(5), "codex.jsonl");
  const claude = await createCliSession(
    [
      JSON.stringify({ type: "user", uuid: "claude-user-1", message: { role: "user", content: "One" } }),
      JSON.stringify({ type: "assistant", uuid: "claude-assistant-1", message: { role: "assistant", content: "Answer one" } }),
      JSON.stringify({ type: "user", uuid: "claude-user-2", message: { role: "user", content: "Two" } }),
      JSON.stringify({ type: "assistant", uuid: "claude-assistant-2", message: { role: "assistant", content: "Answer two" } }),
      JSON.stringify({ type: "user", uuid: "claude-user-3", message: { role: "user", content: "Share" } }),
    ].join("\n"),
    "claude.jsonl",
  );
  try {
    const selectedCodex = spawnSync(
      process.execPath,
      [
        cli,
        "export",
        "codex",
        codex.file,
        "--from",
        "cli-user-3",
        "--before",
        "cli-user-5",
      ],
      { encoding: "utf8" },
    );
    assert.equal(selectedCodex.status, 0, selectedCodex.stderr);
    assert.deepEqual(
      JSON.parse(selectedCodex.stdout).entries.map((entry) => entry.id),
      ["cli-user-3", "cli-assistant-3", "cli-user-4", "cli-assistant-4"],
    );

    const fullCodex = spawnSync(process.execPath, [cli, "export", "codex", codex.file], {
      encoding: "utf8",
    });
    assert.equal(fullCodex.status, 0, fullCodex.stderr);
    assert.equal(JSON.parse(fullCodex.stdout).entries.length, 10);

    const selectedClaude = spawnSync(
      process.execPath,
      [
        cli,
        "export",
        "claude",
        claude.file,
        "--from",
        "claude-user-2",
        "--before",
        "claude-user-3",
      ],
      { encoding: "utf8" },
    );
    assert.equal(selectedClaude.status, 0, selectedClaude.stderr);
    assert.deepEqual(
      JSON.parse(selectedClaude.stdout).entries.map((entry) => entry.id),
      ["claude-user-2", "claude-assistant-2"],
    );
  } finally {
    await rm(codex.directory, { recursive: true, force: true });
    await rm(claude.directory, { recursive: true, force: true });
  }
});

test("publishes only the selected range and keeps share JSON output stable", async () => {
  const fixture = await createCliSession(codexCliJsonl(3));
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
    const result = await execFileAsync(
      process.execPath,
      [
        cli,
        "share",
        "codex",
        fixture.file,
        "--from",
        "cli-user-1",
        "--before",
        "cli-user-2",
        "--url",
        serviceUrl,
        "--json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.split("\n").length, 2);
    assert.deepEqual(JSON.parse(result.stdout), {
      id: "11111111-2222-4333-8444-555555555555",
      url: `${serviceUrl}/?id=11111111-2222-4333-8444-555555555555`,
    });
    assert.deepEqual(
      received.entries.map((entry) => entry.id),
      ["cli-user-1", "cli-assistant-1"],
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("publishes a strict duration and reports the server-confirmed expiration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-expires-"));
  const file = path.join(directory, "history.json");
  await writeFile(file, JSON.stringify(canonicalHistory()));
  let receivedExpiresIn;
  const expiresAt = "2026-08-08T10:00:00.000Z";
  const server = http.createServer((request, response) => {
    receivedExpiresIn = request.headers["x-threadshare-expires-in"];
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", expiresAt }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await execFileAsync(
      process.execPath,
      [cli, "publish", file, "--expires", "7d", "--url", serviceUrl, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(receivedExpiresIn, "604800");
    assert.deepEqual(JSON.parse(result.stdout), {
      id: "11111111-2222-4333-8444-555555555555",
      url: `${serviceUrl}/?id=11111111-2222-4333-8444-555555555555`,
      expiresAt,
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when the server does not confirm a requested expiration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-expires-missing-"));
  const file = path.join(directory, "history.json");
  await writeFile(file, JSON.stringify(canonicalHistory()));
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "11111111-2222-4333-8444-555555555555" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cli, "publish", file, "--expires", "1h", "--url", serviceUrl, "--json"],
        { encoding: "utf8" },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.match(
          error.stderr,
          /server did not confirm the requested expiration; the share may have been created without expiration/,
        );
        return true;
      },
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("shares a revocable session without sending or storing the raw capability", async () => {
  const fixture = await createCliSession(codexCliJsonl(1));
  let receivedDigest;
  let receivedBody;
  const server = http.createServer((request, response) => {
    receivedDigest = request.headers["x-threadshare-revoke-token-sha256"];
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      receivedBody = Buffer.concat(chunks).toString("utf8");
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", revocable: true }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await execFileAsync(
      process.execPath,
      [cli, "share", "codex", fixture.file, "--revoke", "--url", serviceUrl, "--json"],
      { encoding: "utf8" },
    );
    const payload = JSON.parse(result.stdout);
    assert.match(payload.revokeToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      receivedDigest,
      createHash("sha256").update(payload.revokeToken).digest("base64url"),
    );
    assert.doesNotMatch(receivedBody, new RegExp(payload.revokeToken));
    assert.deepEqual(Object.keys(payload).sort(), ["id", "revokeToken", "url"]);
    assert.equal(result.stdout.split("\n").length, 2);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("prints a one-time revoke command to stderr while keeping human stdout stable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-revoke-human-"));
  const file = path.join(directory, "history.json");
  await writeFile(file, JSON.stringify(canonicalHistory()));
  let receivedDigest;
  const server = http.createServer((request, response) => {
    receivedDigest = request.headers["x-threadshare-revoke-token-sha256"];
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", revocable: true }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await execFileAsync(
      process.execPath,
      [cli, "publish", file, "--revoke", "--url", serviceUrl],
      { encoding: "utf8" },
    );
    const url = `${serviceUrl}/?id=11111111-2222-4333-8444-555555555555`;
    assert.equal(result.stdout, `${url}\n`);
    const match = /^Revoke: threadshare revoke '([^']+)' --token '([A-Za-z0-9_-]{43})'\n$/.exec(
      result.stderr,
    );
    assert.ok(match);
    assert.equal(match[1], url);
    assert.equal(receivedDigest, createHash("sha256").update(match[2]).digest("base64url"));
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when the server does not confirm requested revocation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-revoke-missing-"));
  const file = path.join(directory, "history.json");
  await writeFile(file, JSON.stringify(canonicalHistory()));
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "11111111-2222-4333-8444-555555555555" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cli, "publish", file, "--revoke", "--url", serviceUrl, "--json"],
        { encoding: "utf8" },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.match(
          error.stderr,
          /server did not confirm revocation; the share may have been created without revocation/,
        );
        return true;
      },
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("revokes a normalized share URL with bearer authorization", async () => {
  const token = Buffer.alloc(32, 21).toString("base64url");
  let received;
  const server = http.createServer((request, response) => {
    received = { method: request.method, path: request.url, authorization: request.headers.authorization };
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const id = "11111111-2222-4333-8444-555555555555";
  const serviceUrl = `http://127.0.0.1:${address.port}`;
  const viewerUrl = `${serviceUrl}/?id=${id}`;

  try {
    const result = await execFileAsync(
      process.execPath,
      [cli, "revoke", `${viewerUrl}#message-user-1`, "--token", token, "--json"],
      { encoding: "utf8" },
    );
    assert.deepEqual(received, {
      method: "DELETE",
      path: `/api/v1/shares/${id}`,
      authorization: `Bearer ${token}`,
    });
    assert.deepEqual(JSON.parse(result.stdout), { id, url: viewerUrl, revoked: true });
    assert.equal(result.stdout.split("\n").length, 2);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("reads Viewer and API URLs as JSON or Markdown without following redirects", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const redirectId = "22222222-3333-4444-8555-666666666666";
  const targetId = "33333333-4444-4555-8666-777777777777";
  const history = canonicalHistory();
  history.entries = [
    {
      id: "read-user",
      createdAt: "2026-07-30T00:00:01.000Z",
      kind: "message",
      role: "user",
      markdown: "Read this request",
    },
    {
      id: "read-activity",
      createdAt: "2026-07-30T00:00:02.000Z",
      kind: "activity",
      message: "Read activity",
      level: "success",
    },
  ];
  const paths = [];
  let redirectTargetHits = 0;
  const server = http.createServer((request, response) => {
    paths.push(request.url);
    if (request.url === `/api/v1/shares/${redirectId}`) {
      response.writeHead(302, { location: `/api/v1/shares/${targetId}` });
      response.end();
      return;
    }
    if (request.url === `/api/v1/shares/${targetId}`) redirectTargetHits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(history));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    const json = await execFileAsync(
      process.execPath,
      [cli, "read", `${serviceUrl}/?id=${id}#message-read-user`, "--format", "json"],
      { encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(json.stdout), history);
    assert.equal(json.stdout.split("\n").length, 2);
    assert.equal(json.stderr, "");

    const markdown = await execFileAsync(
      process.execPath,
      [cli, "read", `${serviceUrl}/api/v1/shares/${id}`, "--format", "markdown"],
      { encoding: "utf8" },
    );
    assert.match(markdown.stdout, /# CLI test/);
    assert.ok(markdown.stdout.indexOf("Read this request") < markdown.stdout.indexOf("Read activity"));
    assert.equal(markdown.stderr, "");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cli, "read", `${serviceUrl}/?id=${redirectId}`, "--format", "json"],
        { encoding: "utf8" },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stdout, "");
        assert.match(error.stderr, /read request failed/i);
        return true;
      },
    );
    assert.equal(redirectTargetHits, 0);
    assert.deepEqual(paths, [
      `/api/v1/shares/${id}`,
      `/api/v1/shares/${id}`,
      `/api/v1/shares/${redirectId}`,
    ]);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("rejects unsafe command option combinations before exporting or publishing", async () => {
  const fixture = await createCliSession(codexCliJsonl(2));
  const scenarios = [
    {
      args: ["messages", "codex", fixture.file],
      expected: /messages requires --format json/,
    },
    {
      args: ["messages", "codex", fixture.file, "--format", "json", "--json"],
      expected: /--json is not valid for messages/,
    },
    {
      args: ["messages", "codex", fixture.file, "--format", "json", "--url", "https://example.invalid"],
      expected: /--url is not valid for messages/,
    },
    {
      args: ["share", "codex", fixture.file, "--limit", "1"],
      expected: /--limit is not valid for share/,
    },
    {
      args: ["share", "codex", fixture.file, "--form", "cli-user-1"],
      expected: /--form is not valid for share/,
    },
    {
      args: ["share", "codex", fixture.file, "--from"],
      expected: /Missing value for --from/,
    },
    {
      args: ["share", "codex", fixture.file, "--from", ""],
      expected: /Missing value for --from/,
    },
    {
      args: ["share", "codex", fixture.file, "--expires", "0m"],
      expected: /--expires must be a duration from 1m to 365d using m, h, or d/,
    },
    {
      args: ["share", "codex", fixture.file, "--expires", "366d"],
      expected: /--expires must be a duration from 1m to 365d using m, h, or d/,
    },
    {
      args: ["share", "codex", fixture.file, "--expires", "60s"],
      expected: /--expires must be a duration from 1m to 365d using m, h, or d/,
    },
    {
      args: [
        "revoke",
        "https://threadshare.invalid/?id=11111111-2222-4333-8444-555555555555&token=secret",
        "--token",
        Buffer.alloc(32, 1).toString("base64url"),
      ],
      expected: /valid Threadshare viewer or API URL/,
    },
    {
      args: [
        "revoke",
        "https://threadshare.invalid/?id=11111111-2222-4333-8444-555555555555",
        "--token",
        "short",
      ],
      expected: /--token must be a 256-bit base64url capability/,
    },
    {
      args: ["read", "https://threadshare.invalid/?id=11111111-2222-4333-8444-555555555555"],
      expected: /read requires --format json or markdown/,
    },
    {
      args: [
        "read",
        "https://threadshare.invalid/?id=11111111-2222-4333-8444-555555555555",
        "--format",
        "yaml",
      ],
      expected: /read requires --format json or markdown/,
    },
    {
      args: [
        "read",
        "https://threadshare.invalid/?id=11111111-2222-4333-8444-555555555555#token=secret",
        "--format",
        "json",
      ],
      expected: /valid Threadshare viewer or API URL/,
    },
    {
      args: ["messages", "codex", fixture.file, "--format", "json", "--format", "json"],
      expected: /Duplicate option --format/,
    },
    {
      args: ["messages", "codex", fixture.file, "extra", "--format", "json"],
      expected: /Unexpected positional argument/,
    },
    {
      args: ["messages", "codex", fixture.file, "--format", "json", "--limit", "0"],
      expected: /--limit must be an integer from 1 to 50/,
    },
    {
      args: ["messages", "codex", fixture.file, "--format", "json", "--offset", "-1"],
      expected: /--offset must be a non-negative integer/,
    },
  ];

  try {
    for (const scenario of scenarios) {
      const result = spawnSync(process.execPath, [cli, ...scenario.args], { encoding: "utf8" });
      assert.equal(result.status, 1, `${scenario.args.join(" ")}\n${result.stderr}`);
      assert.equal(result.stdout, "");
      assert.match(result.stderr, scenario.expected);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects interactive selection outside a TTY without publishing", async () => {
  const fixture = await createCliSession(codexCliJsonl(2));
  try {
    const result = spawnSync(
      process.execPath,
      [cli, "share", "codex", fixture.file, "--pick-start"],
      { encoding: "utf8" },
    );
    assert.equal(result.status, 1);
    assert.equal(result.stdout, "");
    assert.match(result.stderr, /--pick-start requires an interactive terminal/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("validates a canonical history from stdin", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "bin/threadshare.mjs"), "validate", "-"],
    { encoding: "utf8", input: JSON.stringify(canonicalHistory()) },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Valid threadshare-history@v1\n");
  assert.equal(result.stderr, "");
});

test("rejects a malformed canonical history from stdin", () => {
  const invalid = {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    conversation: {},
    entries: [{ kind: "bogus" }],
    extra: true,
  };
  const result = spawnSync(
    process.execPath,
    [path.join(root, "bin/threadshare.mjs"), "validate", "-"],
    { encoding: "utf8", input: JSON.stringify(invalid) },
  );

  assert.equal(result.status, 1);
  assert.match(result.stderr, /Input is not a valid threadshare-history@v1 document/);
  assert.equal(result.stdout, "");
});

test("finds Codex Cloud sessions below CODEX_HOME", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "threadshare-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    const sessions = path.join(codexHome, "sessions", "2026", "07", "30");
    await mkdir(sessions, { recursive: true });
    const sessionFile = path.join(sessions, "rollout-cloud-session-123.jsonl");
    await writeFile(sessionFile, "");
    process.env.CODEX_HOME = codexHome;

    assert.equal(await resolveSessionFile("codex", "cloud-session-123"), sessionFile);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("extracts the canonical UUID from a timestamped Codex rollout filename", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "threadshare-codex-uuid-"));
  const sessionId = "019f6e08-8538-7423-a293-7f553379f212";
  try {
    const sessions = path.join(codexHome, "sessions", "2026", "07", "31");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      path.join(sessions, `rollout-2026-07-31T11-04-40-${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-31T11:04:40.000Z",
        payload: { cwd: "/fixture" },
      })}\n`,
    );

    const history = await exportSessionById("codex", sessionId, {
      environment: { ...process.env, CODEX_HOME: codexHome },
    });
    assert.equal(history.conversation.id, sessionId);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("exports Codex messages and tool calls without session metadata", () => {
  const history = exportCodexJsonl(
    [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-30T00:00:00.000Z", payload: { session_id: "codex-1" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:00.500Z", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "RAW SYSTEM PROMPT" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:00.750Z", payload: { type: "message", id: "injected-agents", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /private/workspace\n\n<INSTRUCTIONS>RAW AGENT INSTRUCTIONS</INSTRUCTIONS>" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:01.000Z", payload: { type: "message", id: "user-1", role: "user", content: [{ type: "input_text", text: "Review this" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:02.000Z", payload: { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"README.md\",\"authorization\":\"Bearer secret-token\"}" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:02.500Z", payload: { type: "function_call_output", call_id: "call-1", output: "README contents", error: null } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:03.000Z", payload: { type: "message", id: "assistant-1", role: "assistant", content: [{ type: "output_text", text: "Done" }] } }),
    ].join("\n"),
    { exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  assert.equal(history.format, "threadshare-history@v1");
  assert.equal(history.exportedAt, "2026-07-30T01:00:00.000Z");
  assert.deepEqual(history.conversation, { id: "codex-1", title: "Codex session", provider: "codex", source: "codex" });
  assert.deepEqual(history.entries.map((entry) => entry.kind), ["message", "tool", "message"]);
  assert.deepEqual(history.entries[1].input, { path: "README.md", authorization: "[REDACTED]" });
  assert.equal(history.entries[1].status, "completed");
  assert.equal(history.entries[1].output, "README contents");
  assert.doesNotMatch(
    JSON.stringify(history),
    /secret-token|RAW SYSTEM PROMPT|RAW AGENT INSTRUCTIONS/,
  );
});

test("uses the actual export time instead of the session creation time", () => {
  const before = Date.now();
  const history = exportCodexJsonl(
    JSON.stringify({
      type: "session_meta",
      timestamp: "2020-01-01T00:00:00.000Z",
      payload: { session_id: "old-session" },
    }),
  );
  const after = Date.now();

  const exportedAt = Date.parse(history.exportedAt);
  assert.ok(exportedAt >= before && exportedAt <= after);
  assert.notEqual(history.exportedAt, "2020-01-01T00:00:00.000Z");
});

test("exports Claude blocks in order while omitting metadata and recording tool failure", () => {
  const history = exportClaudeJsonl(
    [
      JSON.stringify({ type: "user", isMeta: true, uuid: "meta-1", timestamp: "2026-07-30T00:00:00.000Z", message: { role: "user", content: "RAW SYSTEM REMINDER" } }),
      JSON.stringify({ type: "user", isCompactSummary: true, uuid: "compact-1", timestamp: "2026-07-30T00:00:00.500Z", message: { role: "user", content: "RAW COMPACTION SUMMARY" } }),
      JSON.stringify({ type: "user", uuid: "command-1", timestamp: "2026-07-30T00:00:00.750Z", message: { role: "user", content: "<command-name>RAW COMMAND METADATA</command-name>" } }),
      JSON.stringify({ type: "user", uuid: "user-1", timestamp: "2026-07-30T00:00:01.000Z", message: { role: "user", content: "Implement it" } }),
      JSON.stringify({ type: "assistant", uuid: "assistant-1", timestamp: "2026-07-30T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Plan" }, { type: "text", text: "Before" }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md", apiKey: "sk-secret-key" } }, { type: "text", text: "After" }] } }),
      JSON.stringify({ type: "user", uuid: "result-1", timestamp: "2026-07-30T00:00:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "request failed" }] } }),
    ].join("\n"),
    { sessionId: "claude-1", exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  assert.equal(history.conversation.id, "claude-1");
  assert.equal(history.exportedAt, "2026-07-30T01:00:00.000Z");
  assert.deepEqual(history.entries.map((entry) => entry.kind), ["message", "thought", "message", "tool", "message"]);
  assert.equal(history.entries[2].markdown, "Before");
  assert.equal(history.entries[4].markdown, "After");
  assert.deepEqual(history.entries[3].input, { file_path: "README.md", apiKey: "[REDACTED]" });
  assert.equal(history.entries[3].status, "failed");
  assert.equal(history.entries[3].error, "request failed");
  assert.doesNotMatch(
    JSON.stringify(history),
    /sk-secret-key|RAW SYSTEM REMINDER|RAW COMPACTION SUMMARY|RAW COMMAND METADATA/,
  );
});

test("keeps exported entry IDs unique and links Codex tool results by item ID", () => {
  const history = exportCodexJsonl(
    [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-30T00:00:01.000Z",
        payload: {
          type: "message",
          id: "reasoning-1",
          role: "assistant",
          content: [{ type: "reasoning", text: "Only thought" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-30T00:00:02.000Z",
        payload: { type: "function_call", id: "tool-by-id", name: "lookup", arguments: "{}" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-30T00:00:03.000Z",
        payload: { type: "function_call_output", id: "tool-by-id", output: "found" },
      }),
    ].join("\n"),
    { exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  assert.equal(new Set(history.entries.map((entry) => entry.id)).size, history.entries.length);
  assert.deepEqual(history.entries.map((entry) => entry.kind), ["thought", "tool"]);
  assert.equal(history.entries[1].status, "completed");
  assert.equal(history.entries[1].output, "found");
});

test("exports Codex reasoning summaries and custom tool activity", () => {
  const history = exportCodexJsonl(
    [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-30T00:00:01.000Z",
        payload: {
          type: "reasoning",
          id: "reasoning-top",
          summary: [{ type: "summary_text", text: "Visible plan" }],
          content: [{ type: "reasoning_text", text: "RAW PRIVATE REASONING" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-30T00:00:02.000Z",
        payload: {
          type: "custom_tool_call",
          call_id: "custom-call",
          name: "shell",
          input: '{"command":"pwd"}',
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-30T00:00:03.000Z",
        payload: { type: "custom_tool_call_output", call_id: "custom-call", output: "/workspace" },
      }),
    ].join("\n"),
    { exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  assert.deepEqual(history.entries.map((entry) => entry.kind), ["thought", "tool"]);
  assert.equal(history.entries[0].text, "Visible plan");
  assert.equal(history.entries[1].status, "completed");
  assert.deepEqual(history.entries[1].input, { command: "pwd" });
  assert.equal(history.entries[1].output, "/workspace");
  assert.doesNotMatch(JSON.stringify(history), /RAW PRIVATE REASONING/);
});

test("redacts common credentials embedded in visible text", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123";
  const revokeToken = Buffer.alloc(32, 31).toString("base64url");
  const jsonRevokeToken = Buffer.alloc(32, 32).toString("base64url");
  const history = exportClaudeJsonl(
    JSON.stringify({
      type: "user",
      uuid: "user-secrets",
      timestamp: "2026-07-30T00:00:01.000Z",
      message: {
        role: "user",
        content: `token: "two words" ${jwt} postgres://alice:database-password@db.invalid/app Basic dTpw Bearer abc12345 Bearer AbCdEfGhIjKlMnOp sk-secret-key ghp_1234567890\nthreadshare revoke 'https://threadshare.invalid/?id=11111111-2222-4333-8444-555555555555' --token '${revokeToken}'\n{"revokeToken":"${jsonRevokeToken}"}\nBasic authentication by a ghostwriter near a skyscraper. Bearer authentication is standardized. Explain bearer authorization headers.\nAuthorization: Bearer authentication\nAuthorization: Token auth-scheme-secret\nBearer a1b2c3\nBearer middleware validates requests.\nBearer ABCDEFGHIJKLMNOP expires tomorrow.\nThe Bearer middleware validates HTTP requests.\n- Bearer middleware validates HTTP requests.\nBearer authentication.\nAuthorization: Signature keyId="client",algorithm="hmac",signature="opaque-signature-secret"\nauth=inline-auth-secret status=ok\nBearer a1b2c3.`,
      },
    }),
    { exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  const toolHistory = exportCodexJsonl(
    [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "secret-tool",
          name: "lookup",
          arguments: JSON.stringify({
            AWS_SECRET_ACCESS_KEY: "aws-secret-value",
            cookie: "session=private-cookie",
            credentials: "plural-credential-value",
            cookies: "plural-cookie-value",
            secrets: "plural-secret-value",
            auth: "auth-value",
            accessKey: "access-key-value",
            passwordHash: "password-hash-value",
            authHeader: "auth-header-value",
            tokenCount: 42,
            input_tokens: 100,
            maxTokens: 200,
            authorizationStatus: "enabled",
          }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "secret-tool",
          output:
            '{"snowflake":9007199254740993,"precise":0.12345678901234567890,"password":"hunter2","credential":"opaque-value","secrets":"plural-secrets-output","passwords":"plural-passwords-output","tokens":"plural-tokens-output","apiKeys":"plural-api-keys-output","auths":"plural-auths-output"}',
        },
      }),
    ].join("\n"),
    { exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  const claudeToolHistory = exportClaudeJsonl(
    [
      JSON.stringify({
        type: "assistant",
        uuid: "claude-secret-tool",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "claude-secret-call", name: "lookup", input: {} }],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "claude-secret-result",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "claude-secret-call",
              content:
                '{"snowflake":9007199254740995,"precise":0.98765432109876543210,"credentials":"claude-credentials-output","cookies":"claude-cookies-output"}',
            },
          ],
        },
      }),
    ].join("\n"),
    { exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  assert.equal(toolHistory.entries[0].input.credentials, "[REDACTED]");
  assert.equal(toolHistory.entries[0].input.tokenCount, 42);
  assert.equal(toolHistory.entries[0].input.input_tokens, 100);
  assert.equal(toolHistory.entries[0].input.maxTokens, 200);
  assert.equal(toolHistory.entries[0].input.authorizationStatus, "enabled");
  assert.equal(
    toolHistory.entries[0].output,
    '{"snowflake":9007199254740993,"precise":0.12345678901234567890,"password":"[REDACTED]","credential":"[REDACTED]","secrets":"[REDACTED]","passwords":"[REDACTED]","tokens":"[REDACTED]","apiKeys":"[REDACTED]","auths":"[REDACTED]"}',
  );
  assert.equal(
    claudeToolHistory.entries[0].output,
    '{"snowflake":9007199254740995,"precise":0.98765432109876543210,"credentials":"[REDACTED]","cookies":"[REDACTED]"}',
  );

  const exported = JSON.stringify([history, toolHistory, claudeToolHistory]);
  assert.match(
    history.entries[0].markdown,
    /Basic authentication by a ghostwriter near a skyscraper\. Bearer authentication is standardized\. Explain bearer authorization headers\.\nAuthorization: \[REDACTED\]\nAuthorization: \[REDACTED\]\nBearer \[REDACTED\]\nBearer middleware validates requests\.\nBearer \[REDACTED\] expires tomorrow\.\nThe Bearer middleware validates HTTP requests\.\n- Bearer middleware validates HTTP requests\.\nBearer authentication\.\nAuthorization: \[REDACTED\]\nauth=\[REDACTED\] status=ok\nBearer \[REDACTED\]\.$/,
  );
  assert.doesNotMatch(
    exported,
    /two words|signature123|database-password|dTpw|abc12345|AbCdEfGhIjKlMnOp|sk-secret-key|ghp_1234567890|auth-scheme-secret|a1b2c3|ABCDEFGHIJKLMNOP|opaque-signature-secret|inline-auth-secret/,
  );
  assert.doesNotMatch(exported, /hunter2|opaque-value/);
  assert.doesNotMatch(exported, /aws-secret-value|private-cookie/);
  assert.doesNotMatch(
    exported,
    /plural-credential-value|plural-cookie-value|plural-secret-value|auth-value/,
  );
  assert.doesNotMatch(exported, /access-key-value|password-hash-value|auth-header-value/);
  assert.doesNotMatch(
    exported,
    /plural-secrets-output|plural-passwords-output|plural-tokens-output|plural-api-keys-output|plural-auths-output|claude-credentials-output|claude-cookies-output/,
  );
  assert.doesNotMatch(exported, new RegExp(`${revokeToken}|${jsonRevokeToken}`));
});
