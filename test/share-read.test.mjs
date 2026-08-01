import assert from "node:assert/strict";
import test from "node:test";
import {
  CHAT_SHARE_MAX_BYTES,
  formatHistoryAsMarkdown,
  readSharedHistory,
  validateHistory,
} from "../src/share-read.mjs";
import { parseShareReference } from "../src/share-url.mjs";

const ID = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";

function fullHistory() {
  return {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    exportedAt: "2026-08-01T10:00:00.000Z",
    conversation: {
      id: "conversation-read",
      title: "Agent read test",
      provider: "codex",
      model: "gpt-test",
      source: "codex",
    },
    entries: [
      {
        id: "user-1",
        createdAt: "2026-08-01T09:00:00.000Z",
        kind: "message",
        role: "user",
        markdown: "User request with **markdown**",
      },
      {
        id: "tool-1",
        createdAt: "2026-08-01T09:00:01.000Z",
        kind: "tool",
        name: "lookup",
        status: "failed",
        input: { query: "alpha" },
        output: "partial-result",
        error: { message: "lookup failed" },
      },
      {
        id: "thought-1",
        createdAt: "2026-08-01T09:00:02.000Z",
        kind: "thought",
        text: "Visible reasoning summary",
        status: "ready",
      },
      {
        id: "todo-1",
        createdAt: "2026-08-01T09:00:03.000Z",
        kind: "todo",
        items: [
          { text: "Completed item", completed: true },
          { text: "Pending item\nwith detail", completed: false },
        ],
      },
      {
        id: "activity-1",
        createdAt: "2026-08-01T09:00:04.000Z",
        kind: "activity",
        message: "Agent resumed",
        level: "info",
      },
      {
        id: "compaction-1",
        createdAt: "2026-08-01T09:00:05.000Z",
        kind: "compaction",
        status: "completed",
        trigger: "auto",
        preTokens: 1234,
      },
      {
        id: "assistant-1",
        createdAt: "2026-08-01T09:00:06.000Z",
        kind: "message",
        role: "assistant",
        markdown: "Assistant answer with ![image](https://example.invalid/image.png)",
      },
    ],
  };
}

test("reads and validates a canonical share without following redirects", async () => {
  const history = fullHistory();
  const reference = parseShareReference(`https://threadshare.example/?id=${ID}#message-user-1`);
  let received;
  const result = await readSharedHistory(reference, {
    fetchImpl: async (url, options) => {
      received = { url, options };
      const raw = JSON.stringify(history);
      return new Response(raw, {
        headers: {
          "content-length": String(Buffer.byteLength(raw)),
          "content-type": "application/json; charset=utf-8",
        },
      });
    },
  });

  assert.deepEqual(result, history);
  assert.equal(received.url, `https://threadshare.example/api/v1/shares/${ID}`);
  assert.equal(received.options.redirect, "error");
  assert.equal(received.options.headers.accept, "application/json");
});

test("renders every canonical entry kind in source order without dropping visible fields", () => {
  const markdown = formatHistoryAsMarkdown(fullHistory());
  const markers = [
    "# Agent read test",
    "User request with **markdown**",
    "## Tool: lookup",
    '"query": "alpha"',
    '"partial-result"',
    '"lookup failed"',
    "Visible reasoning summary",
    "Completed item",
    "Pending item\n  with detail",
    "Agent resumed",
    "Pre-compaction tokens: 1234",
    "Assistant answer with ![image](https://example.invalid/image.png)",
  ];
  let previous = -1;
  for (const marker of markers) {
    const current = markdown.indexOf(marker);
    assert.ok(current > previous, `expected ${JSON.stringify(marker)} after offset ${previous}`);
    previous = current;
  }
  assert.match(markdown, /Conversation ID: conversation-read/);
  assert.match(markdown, /Provider: codex/);
  assert.match(markdown, /Model: gpt-test/);
  assert.match(markdown, /Source: codex/);
  assert.match(markdown, /Status: failed/);
  assert.match(markdown, /Trigger: auto/);
});

test("rejects declared and streamed responses above the 5 MiB contract", async () => {
  const reference = parseShareReference(`https://threadshare.example/?id=${ID}`);
  const exactHistory = fullHistory();
  exactHistory.entries = [];
  exactHistory.conversation.title = "";
  const emptyTitleRaw = JSON.stringify(exactHistory);
  exactHistory.conversation.title = "x".repeat(
    CHAT_SHARE_MAX_BYTES - Buffer.byteLength(emptyTitleRaw),
  );
  const exactRaw = JSON.stringify(exactHistory);
  assert.equal(Buffer.byteLength(exactRaw), CHAT_SHARE_MAX_BYTES);
  assert.deepEqual(
    await readSharedHistory(reference, {
      fetchImpl: async () =>
        new Response(exactRaw, {
          headers: { "content-length": String(CHAT_SHARE_MAX_BYTES) },
        }),
    }),
    exactHistory,
  );

  let opened = false;
  await assert.rejects(
    readSharedHistory(reference, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers({ "content-length": String(CHAT_SHARE_MAX_BYTES + 1) }),
        body: {
          getReader() {
            opened = true;
            throw new Error("body should not be read");
          },
        },
      }),
    }),
    /exceeds the 5 MiB limit/,
  );
  assert.equal(opened, false);

  let reads = 0;
  let cancelCount = 0;
  await assert.rejects(
    readSharedHistory(reference, {
      fetchImpl: async () => ({
        ok: true,
        status: 200,
        headers: new Headers(),
        body: {
          getReader() {
            return {
              async read() {
                reads += 1;
                return { done: false, value: new Uint8Array(3 * 1024 * 1024) };
              },
              async cancel() {
                cancelCount += 1;
              },
            };
          },
        },
      }),
    }),
    /exceeds the 5 MiB limit/,
  );
  assert.equal(reads, 2);
  assert.equal(cancelCount, 1);
});

test("maps HTTP, malformed JSON, legacy Paseo, and non-history responses to strict errors", async () => {
  const reference = parseShareReference(`https://threadshare.example/api/v1/shares/${ID}`);
  const legacy = {
    schemaVersion: 1,
    exportedAt: "2026-08-01T10:00:00.000Z",
    conversation: { id: "legacy", title: "Legacy" },
    entries: [],
  };
  assert.throws(
    () => validateHistory(legacy),
    /not a valid threadshare-history@v1 document/,
  );
  const responses = [
    {
      response: new Response(JSON.stringify({ error: "missing" }), { status: 404 }),
      expected: /failed with HTTP 404/,
    },
    { response: new Response("not json"), expected: /did not return valid JSON/ },
    {
      response: new Response(JSON.stringify(legacy)),
      expected: /legacy Paseo history.*republish/i,
    },
    {
      response: new Response(JSON.stringify({ format: "something-else", entries: [] })),
      expected: /not a valid threadshare-history@v1 document/,
    },
  ];

  for (const scenario of responses) {
    await assert.rejects(
      readSharedHistory(reference, { fetchImpl: async () => scenario.response }),
      scenario.expected,
    );
  }
});
