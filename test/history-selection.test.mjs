import assert from "node:assert/strict";
import test from "node:test";
import {
  createMessagePreview,
  listStartMessagePage,
  listUserMessagePage,
  selectHistoryRange,
} from "../src/history-selection.mjs";
import { exportClaudeJsonl, exportCodexJsonl } from "../src/session-export.mjs";

const EXPORTED_AT = "2026-07-31T12:00:00.000Z";

function codexTurns(count) {
  const records = [
    {
      type: "session_meta",
      timestamp: "2026-07-31T00:00:00.000Z",
      payload: { session_id: "selection-codex" },
    },
  ];
  for (let index = 1; index <= count; index += 1) {
    records.push(
      {
        type: "response_item",
        timestamp: `2026-07-31T00:00:${String(index * 2 - 1).padStart(2, "0")}.000Z`,
        payload: {
          type: "message",
          id: `user-${index}`,
          role: "user",
          content: [{ type: "input_text", text: `Request ${index}` }],
        },
      },
      {
        type: "response_item",
        timestamp: `2026-07-31T00:00:${String(index * 2).padStart(2, "0")}.000Z`,
        payload: {
          type: "message",
          id: `assistant-${index}`,
          role: "assistant",
          content: [{ type: "output_text", text: `Answer ${index}` }],
        },
      },
    );
  }
  return exportCodexJsonl(records.map((record) => JSON.stringify(record)).join("\n"), {
    exportedAt: EXPORTED_AT,
  });
}

test("lists ten recent user turns and keeps the first boundary while loading more", () => {
  const firstSnapshot = codexTurns(13);
  const firstPage = listUserMessagePage(firstSnapshot);

  assert.equal(firstPage.boundaryId, "user-13");
  assert.equal(firstPage.boundaryPreview, "Request 13");
  assert.deepEqual(
    firstPage.messages.map((message) => message.id),
    Array.from({ length: 10 }, (_, index) => `user-${12 - index}`),
  );
  assert.equal(firstPage.hasMore, true);
  assert.equal(firstPage.nextOffset, 10);

  const laterSnapshot = codexTurns(14);
  const secondPage = listUserMessagePage(laterSnapshot, {
    before: firstPage.boundaryId,
    offset: firstPage.nextOffset,
  });
  assert.equal(secondPage.boundaryId, "user-13");
  assert.deepEqual(secondPage.messages.map((message) => message.id), ["user-2", "user-1"]);
  assert.equal(secondPage.hasMore, false);
  assert.equal(secondPage.nextOffset, null);
  assert.doesNotMatch(JSON.stringify(secondPage), /Request 14/);
});

test("returns an empty candidate page when the session contains only the boundary turn", () => {
  const page = listUserMessagePage(codexTurns(1));
  assert.equal(page.boundaryId, "user-1");
  assert.deepEqual(page.messages, []);
  assert.equal(page.hasMore, false);
  assert.equal(page.nextOffset, null);
});

test("fails candidate lookup when no visible user turn exists", () => {
  const history = exportCodexJsonl(
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        id: "assistant-only",
        role: "assistant",
        content: [{ type: "output_text", text: "No user input" }],
      },
    }),
    { exportedAt: EXPORTED_AT },
  );
  assert.throws(() => listUserMessagePage(history), /No visible user messages/);
});

test("omits injected user context from exports and message candidates", () => {
  const history = exportCodexJsonl(
    [
      JSON.stringify({ type: "response_item", payload: { type: "message", id: "start", role: "user", content: "Real request" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", id: "environment", role: "user", content: [{ type: "input_text", text: "<environment_context>RAW INTERNAL CONTEXT</environment_context>" }, { type: "input_text", text: "RAW INTERNAL DETAILS" }] } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", id: "answer", role: "assistant", content: "Answer" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", id: "boundary", role: "user", content: "Share this" } }),
    ].join("\n"),
    { exportedAt: EXPORTED_AT },
  );

  assert.doesNotMatch(JSON.stringify(history), /RAW INTERNAL/);
  const page = listUserMessagePage(history);
  assert.equal(page.boundaryId, "boundary");
  assert.deepEqual(page.messages.map((message) => message.id), ["start"]);
});

test("builds terminal-safe, redacted, single-line Unicode previews", () => {
  const raw =
    "\u001b]8;;https://evil.invalid\u0007Open\u001b]8;;\u0007\u001b[31m red\u001b[0m\u202e\n" +
    "/Users/wyattfang/private/project token=preview-secret " +
    "😀".repeat(200);
  const preview = createMessagePreview(raw);

  assert.doesNotMatch(preview, /\u001b|\u0007|\u202e|\r|\n/);
  assert.doesNotMatch(preview, /wyattfang|preview-secret/);
  assert.match(preview, /\[LOCAL_PATH\]/);
  assert.ok(Array.from(preview).length <= 160);
  assert.match(preview, /\.\.\.$/);
});

test("groups multiple canonical message blocks into one native user turn", () => {
  const history = exportCodexJsonl(
    [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-31T00:00:01.000Z",
        payload: {
          type: "message",
          id: "multi-user",
          role: "user",
          content: [
            { type: "input_text", text: "First block" },
            { type: "input_text", text: "Second block" },
          ],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-31T00:00:02.000Z",
        payload: {
          type: "message",
          id: "multi-answer",
          role: "assistant",
          content: [{ type: "output_text", text: "Answer" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-31T00:00:03.000Z",
        payload: {
          type: "message",
          id: "boundary-user",
          role: "user",
          content: [{ type: "input_text", text: "Share this" }],
        },
      }),
    ].join("\n"),
    { exportedAt: EXPORTED_AT },
  );

  const page = listUserMessagePage(history);
  assert.deepEqual(page.messages, [
    {
      id: "multi-user:message:1",
      createdAt: "2026-07-31T00:00:01.000Z",
      preview: "First block Second block",
    },
  ]);

  const selected = selectHistoryRange(history, {
    from: "multi-user:message:2",
    before: "boundary-user",
  });
  assert.deepEqual(
    selected.entries.map((entry) => entry.id),
    ["multi-user:message:1", "multi-user:message:2", "multi-answer"],
  );
});

test("keeps boundary-later tool results out of a selected Codex range", () => {
  const history = exportCodexJsonl(
    [
      JSON.stringify({ type: "response_item", payload: { type: "message", id: "start", role: "user", content: "Start" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call", call_id: "call", name: "read", arguments: "{}" } }),
      JSON.stringify({ type: "response_item", payload: { type: "message", id: "boundary", role: "user", content: "Share now" } }),
      JSON.stringify({ type: "response_item", payload: { type: "function_call_output", call_id: "call", output: "PRIVATE AFTER BOUNDARY" } }),
    ].join("\n"),
    { exportedAt: EXPORTED_AT },
  );
  assert.equal(history.entries[1].output, "PRIVATE AFTER BOUNDARY");

  const selected = selectHistoryRange(history, { from: "start", before: "boundary" });
  assert.deepEqual(selected.entries.map((entry) => entry.id), ["start", "call"]);
  assert.deepEqual(selected.entries[1], {
    id: "call",
    createdAt: EXPORTED_AT,
    kind: "tool",
    name: "read",
    status: "running",
    input: {},
  });
  assert.doesNotMatch(JSON.stringify(selected), /PRIVATE AFTER BOUNDARY/);
});

test("retains a tool result that completed before the boundary", () => {
  const history = exportClaudeJsonl(
    [
      JSON.stringify({ type: "user", uuid: "start", message: { role: "user", content: "Start" } }),
      JSON.stringify({ type: "assistant", uuid: "tool-record", message: { role: "assistant", content: [{ type: "tool_use", id: "tool", name: "read", input: {} }] } }),
      JSON.stringify({ type: "user", uuid: "tool-result", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "Visible result" }] } }),
      JSON.stringify({ type: "user", uuid: "boundary", message: { role: "user", content: "Share now" } }),
      JSON.stringify({ type: "user", uuid: "late-result", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", content: "PRIVATE LATE RESULT" }] } }),
    ].join("\n"),
    { sessionId: "selection-claude", exportedAt: EXPORTED_AT },
  );

  const selected = selectHistoryRange(history, { from: "start", before: "boundary" });
  const tool = selected.entries.find((entry) => entry.kind === "tool");
  assert.equal(tool.status, "completed");
  assert.equal(tool.output, "Visible result");
  assert.doesNotMatch(JSON.stringify(selected), /PRIVATE LATE RESULT/);
});

test("retains a failed tool result that completed before the boundary", () => {
  const history = exportClaudeJsonl(
    [
      JSON.stringify({ type: "user", uuid: "start", message: { role: "user", content: "Start" } }),
      JSON.stringify({ type: "assistant", uuid: "tool-record", message: { role: "assistant", content: [{ type: "tool_use", id: "tool", name: "read", input: {} }] } }),
      JSON.stringify({ type: "user", uuid: "tool-result", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool", is_error: true, content: "Visible failure" }] } }),
      JSON.stringify({ type: "user", uuid: "boundary", message: { role: "user", content: "Share now" } }),
    ].join("\n"),
    { sessionId: "selection-claude", exportedAt: EXPORTED_AT },
  );

  const selected = selectHistoryRange(history, { from: "start", before: "boundary" });
  const tool = selected.entries.find((entry) => entry.kind === "tool");
  assert.equal(tool.status, "failed");
  assert.equal(tool.error, "Visible failure");
  assert.equal("output" in tool, false);
});

test("resolves last-user relative to the exclusive boundary", () => {
  const history = codexTurns(3);
  const beforeBoundary = selectHistoryRange(history, { from: "last-user", before: "user-3" });
  assert.deepEqual(beforeBoundary.entries.map((entry) => entry.id), ["user-2", "assistant-2"]);

  const snapshotTail = selectHistoryRange(history, { from: "last-user" });
  assert.deepEqual(snapshotTail.entries.map((entry) => entry.id), ["user-3", "assistant-3"]);
});

test("lists the latest real turn for the interactive picker", () => {
  const page = listStartMessagePage(codexTurns(12));
  assert.equal(page.messages.length, 10);
  assert.equal(page.messages[0].id, "user-12");
  assert.equal(page.messages[9].id, "user-3");
  assert.equal(page.hasMore, true);
  assert.equal(page.nextOffset, 10);
});

test("fails closed on invalid IDs, invalid ranges, and missing provenance", () => {
  const history = codexTurns(3);
  assert.throws(() => selectHistoryRange(history, { from: "" }), /--from must not be empty/);
  assert.throws(() => selectHistoryRange(history, { before: "" }), /--before must not be empty/);
  assert.throws(() => listUserMessagePage(history, { before: "" }), /--before must not be empty/);
  assert.throws(() => selectHistoryRange(history, { from: "missing" }), /No user message matches/);
  assert.throws(() => selectHistoryRange(history, { from: "assistant-1" }), /not a user message/);
  assert.throws(
    () => selectHistoryRange(history, { from: "user-3", before: "user-2" }),
    /must be before/,
  );
  assert.throws(
    () => selectHistoryRange(history, { from: "user-2", before: "user-2" }),
    /same user turn/,
  );
  assert.throws(() => selectHistoryRange(history, { before: "user-1" }), /empty/);

  history.entries.find((entry) => entry.id === "assistant-1").id = "user-1";
  assert.throws(() => selectHistoryRange(history, { from: "user-1" }), /multiple entries/);

  const manual = {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    exportedAt: EXPORTED_AT,
    conversation: { id: "manual", title: "Manual" },
    entries: [
      { id: "manual-user", createdAt: EXPORTED_AT, kind: "message", role: "user", markdown: "Manual" },
    ],
  };
  assert.throws(
    () => selectHistoryRange(manual, { from: "manual-user" }),
    /provenance is unavailable/,
  );
});

test("validates candidate pagination numbers", () => {
  const history = codexTurns(3);
  for (const limit of [0, 51, 1.5, Number.NaN]) {
    assert.throws(() => listUserMessagePage(history, { limit }), /limit must be an integer/);
  }
  for (const offset of [-1, 1.5, Number.NaN]) {
    assert.throws(() => listUserMessagePage(history, { offset }), /offset must be an integer/);
  }
});
