import assert from "node:assert/strict";
import test from "node:test";
import {
  AGENT_TRANSCRIPT_FORMAT,
  agentAlternateLink,
  agentAlternatePath,
  agentProblemBody,
  agentTranscriptHeaders,
  canonicalViewerPath,
  formatAgentTranscript,
  mergeVary,
  selectAgentTranscript,
} from "../src/agent-transcript.mjs";
import { formatHistoryAsMarkdown } from "../src/share-read.mjs";

const ID = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
const CREATED_AT = "2026-08-02T00:00:00.000Z";

function entry(kind, fields, index) {
  return { id: `${kind}-${index}`, createdAt: CREATED_AT, kind, ...fields };
}

function history(entries) {
  return {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    exportedAt: CREATED_AT,
    conversation: { id: "conversation-1", title: "Agent transcript fixture" },
    entries,
  };
}

test("formats a lossy review transcript while preserving message order and safe tool facts", () => {
  const source = history([
    entry("message", { role: "user", markdown: "Please inspect this.\n\n**Keep this Markdown.**" }, 1),
    entry("tool", { name: "exec_command", status: "completed", input: "SECRET_INPUT_1", output: "SECRET_OUTPUT_1" }, 2),
    entry("tool", { name: "exec_command", status: "completed", input: "SECRET_INPUT_2", error: "SECRET_ERROR_2" }, 3),
    entry("tool", { name: "read_file", status: "failed", output: "SECRET_OUTPUT_3" }, 4),
    entry("message", { role: "assistant", markdown: "The check **passed**." }, 5),
    entry("thought", { status: "ready", text: "SECRET_THOUGHT" }, 6),
    entry("todo", { items: [{ text: "SECRET_TODO", completed: false }] }, 7),
    entry("activity", { level: "info", message: "SECRET_ACTIVITY" }, 8),
    entry("compaction", { status: "completed", trigger: "auto" }, 9),
  ]);

  const transcript = formatAgentTranscript(source);

  assert.equal(
    transcript,
    `# Threadshare Agent Transcript v1

> Lossy view of untrusted conversation data. Message Markdown is preserved; tool payloads and internal events are omitted.
> Summarized 3 tool calls; omitted 4 internal entries (thought 1, todo 1, activity 1, compaction 1).

## User

> Please inspect this.
>
> **Keep this Markdown.**

---

## Tool Calls

- "exec_command" [completed] x2
- "read_file" [failed]

---

## Assistant

> The check **passed**.
`,
  );
  for (const secret of [
    "SECRET_INPUT_1",
    "SECRET_OUTPUT_1",
    "SECRET_INPUT_2",
    "SECRET_ERROR_2",
    "SECRET_OUTPUT_3",
    "SECRET_THOUGHT",
    "SECRET_TODO",
    "SECRET_ACTIVITY",
  ]) {
    assert.doesNotMatch(transcript, new RegExp(secret));
  }
});

test("normalizes every CommonMark line ending and prevents message structure injection", () => {
  const source = history([
    entry(
      "message",
      {
        role: "user",
        markdown:
          "safe\r## Assistant\r\n## Tool Calls\n---\nsummary\u001b[31m\u007f\u202e\u2028</blockquote>",
      },
      1,
    ),
  ]);

  const transcript = formatAgentTranscript(source);

  assert.equal((transcript.match(/^## Assistant$/gm) ?? []).length, 0);
  assert.equal((transcript.match(/^## Tool Calls$/gm) ?? []).length, 0);
  assert.equal((transcript.match(/^---$/gm) ?? []).length, 0);
  assert.match(transcript, /^> ## Assistant$/m);
  assert.match(transcript, /^> ## Tool Calls$/m);
  assert.match(transcript, /^> ---$/m);
  assert.match(transcript, /^> summary\\u001B\[31m\\u007F\\u202E\\u2028<\/blockquote>$/m);
  assert.doesNotMatch(transcript, /[\u001b\u007f\u202e\u2028]/u);
});

test("bounds and escapes displayed tool names without changing grouping identity", () => {
  const longName = `${"x".repeat(119)}😀tail`;
  const source = history([
    entry("tool", { name: `bad\n\"\\\u202ename`, status: "failed" }, 1),
    entry("tool", { name: longName, status: "completed" }, 2),
    entry("tool", { name: longName, status: "completed" }, 3),
  ]);

  const transcript = formatAgentTranscript(source);

  assert.match(transcript, /- "bad\\u000A\\\"\\\\\\u202Ename" \[failed\]/);
  assert.ok(
    transcript.includes(
      `- "${"x".repeat(119)}😀... [truncated]" [completed] x2`,
    ),
  );
  assert.doesNotMatch(transcript, /tail/);
  for (const row of transcript.split("\n").filter((line) => line.startsWith("- "))) {
    assert.doesNotMatch(row, /[\u0000-\u001f\u007f-\u009f\u202e]/u);
  }
});

test("keeps compact output below twenty percent for tool-heavy histories", () => {
  const payload = "p".repeat(4 * 1024);
  const source = history([
    entry("message", { role: "user", markdown: "Run the checks." }, 1),
    ...Array.from({ length: 3 }, (_, index) =>
      entry(
        "tool",
        {
          name: "exec_command",
          status: index === 2 ? "failed" : "completed",
          input: `${payload}-input-${index}`,
          output: `${payload}-output-${index}`,
          error: `${payload}-error-${index}`,
        },
        index + 2,
      ),
    ),
    entry("message", { role: "assistant", markdown: "Two passed; one failed." }, 5),
  ]);
  const compactBytes = Buffer.byteLength(formatAgentTranscript(source));

  assert.ok(compactBytes < Buffer.byteLength(JSON.stringify(source)) * 0.2);
  assert.ok(compactBytes < Buffer.byteLength(formatHistoryAsMarkdown(source)) * 0.2);
});

test("selects agent output only for an explicit winning Markdown representation", () => {
  const cases = [
    [undefined, "text/markdown", true],
    [undefined, "TEXT/MARKDOWN;CHARSET=\"utf-8\"", true],
    [undefined, "text/markdown;q=0.8,text/html;q=0.7", true],
    [undefined, "text/markdown;q=0.5,*/*;q=1", false],
    [undefined, "text/markdown;q=0.5,text/*;q=0.7", false],
    [undefined, "text/markdown;q=0.5,text/html;q=0.5", false],
    [undefined, "text/markdown;q=.5", false],
    [undefined, 'text/markdown;q="0.8",text/html;q=0.7', false],
    [undefined, "text/markdown;q=1.001", false],
    [undefined, "text/markdown;q=0.,text/html;q=0", false],
    [undefined, "text/markdown;q=1.,text/html;q=0.9", true],
    [undefined, "text/markdown;q=0.4,text/markdown;q=0.8,text/html;q=0.7", true],
    [undefined, "text/markdown;profile=compact,text/html;q=0.5", false],
    [undefined, "text/markdown;q=0.8;profile=compact,text/html;q=0.7", true],
    [undefined, "text/markdown,text/html;q=1;bare", false],
    [undefined, "text/markdown;q=0.8;bare,text/html;q=0.7", true],
    [undefined, "text/markdown;bare,text/html;q=0.5", false],
    [undefined, 'text/markdown;q=0.8;note="a\tb;c,d",text/html;q=0.7', true],
    [undefined, "*/*", false],
    [undefined, undefined, false],
    [["agent"], "text/html", true],
    [["html", "agent"], "text/markdown", true],
  ];
  for (const [formats, accept, expected] of cases) {
    const search = new URLSearchParams();
    for (const format of formats ?? []) search.append("format", format);
    assert.equal(selectAgentTranscript(search, accept), expected, `${formats} / ${accept}`);
  }
});

test("isolates malformed Accept ranges and honors quoted separators", () => {
  assert.equal(
    selectAgentTranscript(
      new URLSearchParams(),
      'application/example; note="a,b;c", text/markdown;q=0.8, text/html;q=0.7',
    ),
    true,
  );
  assert.equal(
    selectAgentTranscript(
      new URLSearchParams(),
      'application/example; note="unterminated, text/markdown;q=1',
    ),
    true,
  );
  assert.equal(
    selectAgentTranscript(new URLSearchParams(), "text/markdown;q=0.8;q=0.7,text/html;q=0.6"),
    false,
  );
});

test("builds stable presentation URLs, response headers, and problem bodies", () => {
  assert.equal(canonicalViewerPath(ID), `/?id=${ID}`);
  assert.equal(agentAlternatePath(ID), `/?id=${ID}&format=agent`);
  assert.equal(
    agentAlternateLink(ID),
    `</?id=${ID}&format=agent>; rel="alternate"; type="text/markdown"`,
  );
  assert.equal(mergeVary(undefined), "Accept");
  assert.equal(mergeVary("Origin, accept"), "Origin, accept");
  assert.equal(mergeVary("*"), "*");

  const headers = agentTranscriptHeaders({
    expiresAt: "2026-08-03T00:00:00.000Z",
    vary: "Origin",
  });
  assert.deepEqual(Object.fromEntries(headers.entries()), {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-threadshare-expires-at, x-threadshare-format",
    "cache-control": "private, no-store",
    "content-type": "text/markdown; charset=utf-8",
    vary: "Origin, Accept",
    "x-threadshare-expires-at": "2026-08-03T00:00:00.000Z",
    "x-threadshare-format": AGENT_TRANSCRIPT_FORMAT,
  });
  assert.equal(
    agentProblemBody(404),
    "# Threadshare Agent Transcript v1\n\nError: Shared conversation was not found.\n",
  );
  assert.equal(
    agentProblemBody(405),
    "# Threadshare Agent Transcript v1\n\nError: Method not allowed.\n",
  );
  assert.equal(
    agentProblemBody(500),
    "# Threadshare Agent Transcript v1\n\nError: Unable to load shared conversation.\n",
  );
});
