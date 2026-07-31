import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, utimes, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { resolveSessionFile } from "../src/session-files.mjs";
import { listSessions } from "../src/session-listing.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "bin", "threadshare.mjs");

const IDS = {
  ambiguous: "11111111-1111-4111-8111-111111111111",
  claude: "22222222-2222-4222-8222-222222222222",
  claudeBounded: "33333333-3333-4333-8333-333333333333",
  claudeSubagent: "77777777-7777-4777-8777-777777777777",
  codexOlder: "44444444-4444-4444-8444-444444444444",
  codexNewer: "55555555-5555-4555-8555-555555555555",
  unique: "66666666-6666-4666-8666-666666666666",
};

async function createFixture() {
  const home = await mkdtemp(path.join(os.tmpdir(), "threadshare-sessions-"));
  const codexHome = path.join(home, ".codex-custom");
  await mkdir(path.join(codexHome, "sessions"), { recursive: true });
  await mkdir(path.join(home, ".claude", "projects"), { recursive: true });
  return {
    home,
    codexHome,
    environment: { ...process.env, HOME: home, CODEX_HOME: codexHome },
  };
}

function codexJsonl({ id, cwd, branch, prompt, hidden = true }) {
  const records = [
    {
      type: "session_meta",
      timestamp: "2026-07-30T01:02:03.000Z",
      payload: { id, cwd, git: { branch } },
    },
  ];
  if (hidden) {
    records.push({
      type: "response_item",
      timestamp: "2026-07-30T01:02:04.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "# AGENTS.md instructions\nRAW INTERNAL" }],
      },
    });
  }
  records.push({
    type: "response_item",
    timestamp: "2026-07-30T01:02:05.000Z",
    payload: {
      type: "message",
      role: "user",
      content: [{ type: "input_text", text: prompt }],
    },
  });
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function writeCodexSession(fixture, id, raw, day = "30") {
  const directory = path.join(fixture.codexHome, "sessions", "2026", "07", day);
  await mkdir(directory, { recursive: true });
  const file = path.join(directory, `rollout-2026-07-${day}T01-02-03-${id}.jsonl`);
  await writeFile(file, raw);
  return file;
}

test("lists canonical Codex sessions newest first with bounded, redacted summaries", async () => {
  const fixture = await createFixture();
  try {
    const older = await writeCodexSession(
      fixture,
      IDS.codexOlder,
      codexJsonl({
        id: IDS.codexOlder,
        cwd: path.join(fixture.home, "work", "token=project-secret"),
        branch: "token=branch-secret",
        prompt: "Review alpha Authorization: Bearer abc12345",
      }),
      "29",
    );
    const newer = await writeCodexSession(
      fixture,
      IDS.codexNewer,
      codexJsonl({
        id: IDS.codexNewer,
        cwd: path.join(fixture.home, "work", "beta\u202e"),
        branch: "feat/beta\u202e",
        prompt: "Ship beta",
      }),
      "30",
    );
    await writeFile(
      path.join(fixture.codexHome, "sessions", "rollout-cloud-session-123.jsonl"),
      codexJsonl({ id: "cloud-session-123", cwd: "/fixture", branch: "main", prompt: "Skip" }),
    );
    await utimes(older, new Date("2026-07-30T02:00:00.000Z"), new Date("2026-07-30T02:00:00.000Z"));
    await utimes(newer, new Date("2026-07-31T02:00:00.000Z"), new Date("2026-07-31T02:00:00.000Z"));

    const first = await listSessions("codex", {
      environment: fixture.environment,
      limit: 1,
      offset: 0,
    });
    assert.equal(first.provider, "codex");
    assert.equal(first.total, 2);
    assert.equal(first.skippedAmbiguous, 0);
    assert.equal(first.hasMore, true);
    assert.equal(first.nextOffset, 1);
    assert.equal(first.sessions.length, 1);
    assert.deepEqual(first.sessions[0], {
      id: IDS.codexNewer,
      createdAt: "2026-07-30T01:02:03.000Z",
      updatedAt: "2026-07-31T02:00:00.000Z",
      project: "~/work/beta",
      branch: "feat/beta",
      preview: "Ship beta",
      sizeBytes: Buffer.byteLength(await readFile(newer)),
    });
    assert.equal(
      await resolveSessionFile("codex", first.sessions[0].id, {
        environment: fixture.environment,
      }),
      newer,
    );

    const second = await listSessions("codex", {
      environment: fixture.environment,
      limit: 1,
      offset: first.nextOffset,
    });
    assert.equal(second.sessions[0].id, IDS.codexOlder);
    assert.equal(second.sessions[0].project, "~/work/token=[REDACTED]");
    assert.equal(second.sessions[0].branch, "token=[REDACTED]");
    assert.match(second.sessions[0].preview, /^Review alpha Authorization: \[REDACTED\]$/);
    assert.doesNotMatch(second.sessions[0].preview, /abc12345|RAW INTERNAL/);
    assert.equal(second.hasMore, false);
    assert.equal(second.nextOffset, null);

    const beyond = await listSessions("codex", {
      environment: fixture.environment,
      limit: 10,
      offset: 99,
    });
    assert.deepEqual(beyond.sessions, []);
    assert.equal(beyond.hasMore, false);
    assert.equal(beyond.nextOffset, null);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("lists Claude main sessions while tolerating malformed and truncated records", async () => {
  const fixture = await createFixture();
  try {
    const projectDirectory = path.join(fixture.home, ".claude", "projects", "-fixture-project");
    await mkdir(projectDirectory, { recursive: true });
    const main = path.join(projectDirectory, `${IDS.claude}.jsonl`);
    await writeFile(
      main,
      [
        "{malformed",
        JSON.stringify({
          type: "user",
          isMeta: true,
          sessionId: IDS.claude,
          cwd: path.join(fixture.home, "work", "claude-app"),
          gitBranch: "feat/claude",
          timestamp: "2026-07-30T03:00:00.000Z",
          message: { role: "user", content: "RAW META" },
        }),
        JSON.stringify({
          type: "user",
          sessionId: IDS.claude,
          cwd: path.join(fixture.home, "work", "claude-app"),
          gitBranch: "feat/claude",
          timestamp: "2026-07-30T03:00:01.000Z",
          message: { role: "user", content: "<command-name>RAW COMMAND</command-name>" },
        }),
        JSON.stringify({
          type: "user",
          sessionId: IDS.claude,
          cwd: path.join(fixture.home, "work", "claude-app"),
          gitBranch: "feat/claude",
          timestamp: "2026-07-30T03:00:01.500Z",
          message: { role: "assistant", content: "RAW ASSISTANT" },
        }),
        JSON.stringify({
          type: "user",
          sessionId: IDS.claude,
          cwd: path.join(fixture.home, "work", "claude-app"),
          gitBranch: "feat/claude",
          timestamp: "2026-07-30T03:00:02.000Z",
          message: { role: "user", content: "Implement Claude listing" },
        }),
        '{"type":"assistant"',
      ].join("\n"),
    );
    const subagents = path.join(projectDirectory, IDS.claude, "subagents");
    await mkdir(subagents, { recursive: true });
    await writeFile(path.join(subagents, `agent-${IDS.claudeSubagent}.jsonl`), "{}\n");

    const bounded = path.join(projectDirectory, `${IDS.claudeBounded}.jsonl`);
    await writeFile(
      bounded,
      `${JSON.stringify({ type: "attachment", payload: "x".repeat(512) })}\n${JSON.stringify({
        type: "user",
        sessionId: IDS.claudeBounded,
        cwd: "/outside/home/project",
        timestamp: "2026-07-30T04:00:00.000Z",
        message: { role: "user", content: "Must remain beyond the cap" },
      })}\n`,
    );

    const page = await listSessions("claude", {
      environment: fixture.environment,
      limit: 10,
    });
    assert.equal(page.total, 2);
    assert.equal(page.skippedAmbiguous, 0);
    assert.deepEqual(
      page.sessions.map((session) => session.id).sort(),
      [IDS.claude, IDS.claudeBounded].sort(),
    );
    assert.equal(page.sessions.some((session) => session.id === IDS.claudeSubagent), false);
    const claude = page.sessions.find((session) => session.id === IDS.claude);
    assert.equal(
      await resolveSessionFile("claude", claude.id, { environment: fixture.environment }),
      main,
    );
    assert.equal(claude.createdAt, "2026-07-30T03:00:00.000Z");
    assert.equal(claude.project, "~/work/claude-app");
    assert.equal(claude.branch, "feat/claude");
    assert.equal(claude.preview, "Implement Claude listing");
    assert.doesNotMatch(JSON.stringify(claude), /RAW ASSISTANT/);
    const boundedPage = await listSessions("claude", {
      environment: fixture.environment,
      limit: 10,
      maxSummaryBytes: 128,
    });
    const capped = boundedPage.sessions.find((session) => session.id === IDS.claudeBounded);
    assert.equal(capped.createdAt, null);
    assert.equal(capped.project, null);
    assert.equal(capped.branch, null);
    assert.equal(capped.preview, null);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("excludes ambiguous session IDs without weakening strict resolution", async () => {
  const fixture = await createFixture();
  try {
    await writeCodexSession(
      fixture,
      IDS.ambiguous,
      codexJsonl({
        id: IDS.ambiguous,
        cwd: path.join(fixture.home, "work", "one"),
        branch: "main",
        prompt: "One",
      }),
      "29",
    );
    await writeCodexSession(
      fixture,
      IDS.ambiguous,
      codexJsonl({
        id: IDS.ambiguous,
        cwd: path.join(fixture.home, "work", "two"),
        branch: "main",
        prompt: "Two",
      }),
      "30",
    );
    const unique = await writeCodexSession(
      fixture,
      IDS.unique,
      codexJsonl({
        id: IDS.unique,
        cwd: path.join(fixture.home, "work", "unique"),
        branch: "main",
        prompt: "Unique",
      }),
      "31",
    );

    const page = await listSessions("codex", { environment: fixture.environment });
    assert.equal(page.total, 1);
    assert.equal(page.skippedAmbiguous, 1);
    assert.deepEqual(page.sessions.map((session) => session.id), [IDS.unique]);
    assert.equal(
      await resolveSessionFile("codex", IDS.unique, { environment: fixture.environment }),
      unique,
    );
    await assert.rejects(
      resolveSessionFile("codex", IDS.ambiguous, { environment: fixture.environment }),
      /Multiple codex sessions match/,
    );

    const text = spawnSync(process.execPath, [cli, "sessions", "codex"], {
      encoding: "utf8",
      env: fixture.environment,
    });
    assert.equal(text.status, 0, text.stderr);
    assert.match(text.stdout, /Warning: skipped 1 ambiguous session ID; use an explicit JSONL path\./);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("returns an empty page and rejects invalid listing options", async () => {
  const fixture = await createFixture();
  try {
    assert.deepEqual(await listSessions("claude", { environment: fixture.environment }), {
      provider: "claude",
      sessions: [],
      total: 0,
      skippedAmbiguous: 0,
      hasMore: false,
      nextOffset: null,
    });
    await assert.rejects(listSessions("paseo", { environment: fixture.environment }), /codex or claude/);
    await assert.rejects(listSessions("codex", { environment: fixture.environment, limit: 0 }), /limit/);
    await assert.rejects(listSessions("codex", { environment: fixture.environment, limit: 51 }), /limit/);
    await assert.rejects(listSessions("codex", { environment: fixture.environment, offset: -1 }), /offset/);
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});

test("renders sessions as stable JSON for agents and readable text for people", async () => {
  const fixture = await createFixture();
  try {
    const older = await writeCodexSession(
      fixture,
      IDS.codexOlder,
      codexJsonl({
        id: IDS.codexOlder,
        cwd: path.join(fixture.home, "work", "alpha"),
        branch: "main",
        prompt: "Older task",
      }),
      "29",
    );
    const newer = await writeCodexSession(
      fixture,
      IDS.codexNewer,
      codexJsonl({
        id: IDS.codexNewer,
        cwd: path.join(fixture.home, "work", "beta"),
        branch: "feat/beta",
        prompt: "New task",
      }),
      "30",
    );
    await utimes(older, new Date("2026-07-30T02:00:00.000Z"), new Date("2026-07-30T02:00:00.000Z"));
    await utimes(newer, new Date("2026-07-31T02:00:00.000Z"), new Date("2026-07-31T02:00:00.000Z"));

    const json = spawnSync(
      process.execPath,
      [cli, "sessions", "codex", "--format", "json", "--limit", "1"],
      { encoding: "utf8", env: fixture.environment },
    );
    assert.equal(json.status, 0, json.stderr);
    assert.equal(json.stderr, "");
    assert.equal(json.stdout.split("\n").length, 2);
    const result = JSON.parse(json.stdout);
    assert.equal(result.sessions[0].id, IDS.codexNewer);
    assert.equal(result.nextOffset, 1);

    const text = spawnSync(
      process.execPath,
      [cli, "sessions", "codex", "--limit", "1"],
      { encoding: "utf8", env: fixture.environment },
    );
    assert.equal(text.status, 0, text.stderr);
    assert.equal(text.stderr, "");
    assert.match(text.stdout, /^Codex sessions 1-1 of 2 \(newest first\)/);
    assert.match(text.stdout, new RegExp(IDS.codexNewer));
    assert.match(text.stdout, /Project: ~\/work\/beta/);
    assert.match(text.stdout, /Branch: feat\/beta/);
    assert.match(text.stdout, /First request: New task/);
    assert.match(text.stdout, /More: threadshare sessions codex --offset 1 --limit 1/);

    const beyond = spawnSync(
      process.execPath,
      [cli, "sessions", "codex", "--offset", "99"],
      { encoding: "utf8", env: fixture.environment },
    );
    assert.equal(beyond.status, 0, beyond.stderr);
    assert.equal(beyond.stdout, "No Codex sessions at offset 99 (2 total).\n");

    for (const scenario of [
      { args: ["sessions", "paseo"], expected: /codex\|claude/ },
      { args: ["sessions", "codex", "--format", "yaml"], expected: /--format must be text or json/ },
      { args: ["sessions", "codex", "--json"], expected: /--json is not valid for sessions/ },
      { args: ["sessions", "codex", "--limit", "0"], expected: /--limit must be an integer from 1 to 50/ },
    ]) {
      const invalid = spawnSync(process.execPath, [cli, ...scenario.args], {
        encoding: "utf8",
        env: fixture.environment,
      });
      assert.equal(invalid.status, 1, invalid.stderr);
      assert.equal(invalid.stdout, "");
      assert.match(invalid.stderr, scenario.expected);
    }
  } finally {
    await rm(fixture.home, { recursive: true, force: true });
  }
});
