import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { exportClaudeJsonl, exportCodexJsonl } from "../src/session-export.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("prints CLI help with either help spelling", () => {
  for (const argument of ["help", "--help"]) {
    const result = spawnSync(process.execPath, [path.join(root, "bin/threadshare.mjs"), argument], {
      encoding: "utf8",
    });
    assert.equal(result.status, 0);
    assert.match(result.stdout, /threadshare share <codex\|claude>/);
    assert.equal(result.stderr, "");
  }
});

test("exports Codex messages and tool calls without session metadata", () => {
  const history = exportCodexJsonl(
    [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-30T00:00:00.000Z", payload: { session_id: "codex-1" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:01.000Z", payload: { type: "message", id: "user-1", role: "user", content: [{ type: "input_text", text: "Review this" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:02.000Z", payload: { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"README.md\"}" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:03.000Z", payload: { type: "message", id: "assistant-1", role: "assistant", content: [{ type: "output_text", text: "Done" }] } }),
    ].join("\n"),
  );

  assert.equal(history.format, "threadshare-history@v1");
  assert.deepEqual(history.conversation, { id: "codex-1", title: "Codex session", provider: "codex", source: "codex" });
  assert.deepEqual(history.entries.map((entry) => entry.kind), ["message", "tool", "message"]);
  assert.deepEqual(history.entries[1].input, { path: "README.md" });
});

test("exports Claude text, thoughts, and tool calls", () => {
  const history = exportClaudeJsonl(
    [
      JSON.stringify({ type: "user", uuid: "user-1", timestamp: "2026-07-30T00:00:01.000Z", message: { role: "user", content: "Implement it" } }),
      JSON.stringify({ type: "assistant", uuid: "assistant-1", timestamp: "2026-07-30T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Plan" }, { type: "text", text: "Working" }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md" } }] } }),
    ].join("\n"),
    { sessionId: "claude-1" },
  );

  assert.equal(history.conversation.id, "claude-1");
  assert.deepEqual(history.entries.map((entry) => entry.kind), ["message", "message", "thought", "tool"]);
  assert.equal(history.entries[1].markdown, "Working");
});
