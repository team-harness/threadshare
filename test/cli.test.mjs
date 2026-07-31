import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test from "node:test";
import { fileURLToPath } from "node:url";
import {
  exportClaudeJsonl,
  exportCodexJsonl,
  exportSessionById,
  resolveSessionFile,
} from "../src/session-export.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

function canonicalHistory() {
  return {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    exportedAt: "2026-07-30T00:00:00.000Z",
    conversation: { id: "conversation-1", title: "CLI test" },
    entries: [],
  };
}

test("prints CLI help with either help spelling", () => {
  for (const argument of ["help", "--help"]) {
    const result = spawnSync(process.execPath, [path.join(root, "bin/threadshare.mjs"), argument], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /threadshare share <codex\|claude\|paseo>/);
    assert.match(result.stdout, /https:\/\/cloud-thread\.team-harness\.com/);
    assert.equal(result.stderr, "");
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
  assert.doesNotMatch(JSON.stringify(history), /secret-token|RAW SYSTEM PROMPT/);
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
  assert.doesNotMatch(JSON.stringify(history), /sk-secret-key|RAW SYSTEM REMINDER|RAW COMPACTION SUMMARY/);
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
  const history = exportClaudeJsonl(
    JSON.stringify({
      type: "user",
      uuid: "user-secrets",
      timestamp: "2026-07-30T00:00:01.000Z",
      message: {
        role: "user",
        content: `token: "two words" ${jwt} postgres://alice:database-password@db.invalid/app Basic dTpw Bearer abc12345 Bearer AbCdEfGhIjKlMnOp sk-secret-key ghp_1234567890\nBasic authentication by a ghostwriter near a skyscraper. Bearer authentication is standardized. Explain bearer authorization headers.\nAuthorization: Bearer authentication\nAuthorization: Token auth-scheme-secret\nBearer a1b2c3\nBearer middleware validates requests.\nBearer ABCDEFGHIJKLMNOP expires tomorrow.\nThe Bearer middleware validates HTTP requests.\n- Bearer middleware validates HTTP requests.\nBearer authentication.\nAuthorization: Signature keyId="client",algorithm="hmac",signature="opaque-signature-secret"\nauth=inline-auth-secret status=ok\nBearer a1b2c3.`,
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
});
