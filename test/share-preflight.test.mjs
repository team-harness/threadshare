import assert from "node:assert/strict";
import test from "node:test";
import {
  createPreflightResult,
  formatPreflightResult,
} from "../src/share-preflight.mjs";
import { exportCodexJsonl } from "../src/session-export.mjs";

function history() {
  return {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    exportedAt: "2026-08-01T10:00:00.000Z",
    conversation: { id: "preflight", title: "Private conversation", source: "codex" },
    entries: [
      {
        id: "user-1",
        createdAt: "2026-08-01T09:00:00.000Z",
        kind: "message",
        role: "user",
        markdown: "Do not print this [REDACTED] body",
      },
      {
        id: "assistant-1",
        createdAt: "2026-08-01T09:00:01.000Z",
        kind: "message",
        role: "assistant",
        markdown: "Private answer",
      },
      {
        id: "tool-1",
        createdAt: "2026-08-01T09:00:02.000Z",
        kind: "tool",
        name: "secret_tool",
        status: "failed",
        input: { password: "[REDACTED]" },
        output: "Private tool output",
      },
      {
        id: "thought-1",
        createdAt: "2026-08-01T09:00:03.000Z",
        kind: "thought",
        text: "Private thought summary",
        status: "ready",
      },
      {
        id: "todo-1",
        createdAt: "2026-08-01T09:00:04.000Z",
        kind: "todo",
        items: [{ text: "Private todo", completed: false }],
      },
      {
        id: "activity-1",
        createdAt: "2026-08-01T09:00:05.000Z",
        kind: "activity",
        message: "Private activity",
        level: "info",
      },
      {
        id: "compaction-1",
        createdAt: "2026-08-01T09:00:06.000Z",
        kind: "compaction",
        status: "completed",
      },
    ],
  };
}

test("builds a content-free aggregate report and lifecycle intent", () => {
  const result = createPreflightResult(history(), {
    expiresInSeconds: 3600,
    includeReport: true,
    revoke: true,
  });
  assert.equal(result.dryRun, true);
  assert.equal(result.valid, true);
  assert.deepEqual(result.intent, { expiresInSeconds: 3600, revoke: true });
  assert.deepEqual(result.report.entryKinds, {
    message: 2,
    tool: 1,
    thought: 1,
    todo: 1,
    activity: 1,
    compaction: 1,
  });
  assert.deepEqual(result.report.messageRoles, { user: 1, assistant: 1 });
  assert.equal(result.report.entries, 7);
  assert.equal(result.report.userTurns, 1);
  assert.equal(result.report.redactionMarkers, 2);
  assert.ok(result.report.bytes > 0);
  assert.ok(result.report.limitBytes >= result.report.bytes);

  const rendered = `${JSON.stringify(result)}\n${formatPreflightResult(result)}`;
  assert.doesNotMatch(
    rendered,
    /Do not print|Private answer|Private tool|Private thought|Private todo|Private activity|secret_tool|password/,
  );
  assert.match(rendered, /No data was uploaded/);
});

test("counts multiple message blocks from one native record as one user turn", () => {
  const exported = exportCodexJsonl(
    [
      JSON.stringify({
        type: "session_meta",
        timestamp: "2026-08-01T09:00:00.000Z",
        payload: { session_id: "preflight-turns" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-08-01T09:00:01.000Z",
        payload: {
          type: "message",
          id: "multi-block-user",
          role: "user",
          content: [
            { type: "input_text", text: "First block" },
            { type: "input_text", text: "Second block" },
          ],
        },
      }),
    ].join("\n"),
    { exportedAt: "2026-08-01T10:00:00.000Z" },
  );
  const result = createPreflightResult(exported, { includeReport: true });
  assert.equal(result.report.entryKinds.message, 2);
  assert.equal(result.report.messageRoles.user, 2);
  assert.equal(result.report.userTurns, 1);
});
