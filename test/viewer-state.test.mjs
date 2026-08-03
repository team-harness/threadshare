import assert from "node:assert/strict";
import test from "node:test";
import {
  createTurnDirectory,
  findActiveTurnIndex,
  markdownPlainText,
} from "../src/viewer-state.mjs";

const CREATED_AT = "2026-08-01T08:00:00.000Z";

const entries = [
  {
    id: "user-1",
    createdAt: CREATED_AT,
    kind: "message",
    role: "user",
    markdown: "**First request** with `inline code`",
  },
  {
    id: "assistant-1",
    createdAt: CREATED_AT,
    kind: "message",
    role: "assistant",
    markdown: "The literal marker is `[draft]`.",
  },
  { id: "tool-1", createdAt: CREATED_AT, kind: "tool", name: "read_file" },
  {
    id: "user-2",
    createdAt: CREATED_AT,
    kind: "message",
    role: "user",
    markdown:
      "## Second question\n\n<script>alert('preview')</script> " + "long ".repeat(30) + "ending",
  },
];

test("converts Markdown to normalized plain text for turn previews", () => {
  assert.equal(
    markdownPlainText("**First request**\n\nwith `inline code`"),
    "First request with inline code",
  );
});

test("builds user-turn directory previews as short plain text", () => {
  const turns = createTurnDirectory(entries, { previewLength: 72 });

  assert.deepEqual(
    turns.map(({ id, anchorId }) => ({ id, anchorId })),
    [
      { id: "user-1", anchorId: "message-user-1" },
      { id: "user-2", anchorId: "message-user-2" },
    ],
  );
  assert.equal(turns[0].preview, "First request with inline code");
  assert.doesNotMatch(turns[1].preview, /##/);
  assert.match(turns[1].preview, /<script>alert\('preview'\)<\/script>/);
  assert.ok(Array.from(turns[1].preview).length <= 72);
  assert.match(turns[1].preview, /\.\.\.$/);
});

test("selects the current turn from viewport positions", () => {
  assert.equal(findActiveTurnIndex([], { activationTop: 180 }), -1);
  assert.equal(findActiveTurnIndex([260, 780], { activationTop: 180 }), 0);
  assert.equal(findActiveTurnIndex([-420, 140, 820], { activationTop: 180 }), 1);
  assert.equal(
    findActiveTurnIndex([-980, -360, 440], { activationTop: 180, atEnd: true }),
    2,
  );
});
