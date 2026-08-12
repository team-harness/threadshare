import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { appendFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  canonicalJson,
  createPrivacyContext,
  hashKey,
  validateSessionFactsDelta,
  validateSessionFactsDeltaV2,
} from "../src/session-facts.mjs";
import {
  PROVIDER_RECORD_AUTHORITY_V1,
  discoverProviderEvidenceSources,
  readProviderSessionDelta,
} from "../src/provider-evidence.mjs";
import { readSessionRecordBatch } from "../src/session-record-reader.mjs";
import { exportClaudeJsonl, exportCodexJsonl } from "../src/session-export.mjs";

const IDS = {
  codex: "11111111-1111-4111-8111-111111111111",
  codexRoot: "22222222-2222-4222-8222-222222222222",
  claude: "33333333-3333-4333-8333-333333333333",
};

const SECRET = Buffer.from(
  "000102030405060708090a0b0c0d0e0f101112131415161718191a1b1c1d1e1f",
  "hex",
);

function jsonl(records, trailingNewline = true) {
  return `${records.map((record) => JSON.stringify(record)).join("\n")}${trailingNewline ? "\n" : ""}`;
}

async function fixtureFile(name, raw) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-evidence-"));
  const file = path.join(directory, name);
  await writeFile(file, raw);
  return { directory, file };
}

function privacyContext() {
  return createPrivacyContext({
    secret: SECRET,
    originSecretEpoch: "44444444-4444-4444-8444-444444444444",
  });
}

function historyPayloadContent(delta, payloadKind) {
  const payload = delta.historyPayloads.find((item) => item.payloadKind === payloadKind);
  assert.ok(payload, `missing ${payloadKind} payload`);
  const chunks = delta.historyPayloadChunks
    .filter((item) => item.payloadKey === payload.payloadKey)
    .sort((left, right) => BigInt(left.ordinal) < BigInt(right.ordinal) ? -1 : 1);
  assert.equal(chunks.length, Number(payload.chunkCount));
  assert.equal(chunks.every((item) => Buffer.byteLength(item.content) <= 64 * 1024), true);
  const content = chunks.map((item) => item.content).join("");
  assert.equal(String(Buffer.byteLength(content)), payload.byteLength);
  assert.equal(createHash("sha256").update(content).digest("hex"), payload.sha256);
  return { payload, chunks, content };
}

test("stream reader preserves byte ranges and resumes an incomplete tail", async () => {
  const first = JSON.stringify({ type: "one", value: "alpha" });
  const invalid = "{not-json}";
  const second = JSON.stringify({ type: "two", value: "beta" });
  const partial = '{"type":"three"';
  const fixture = await fixtureFile("records.jsonl", `${first}\n${invalid}\n${second}\n${partial}`);
  try {
    const batch = await readSessionRecordBatch(fixture.file, {
      chunkSize: 7,
      maxRecordBytes: 1024,
    });
    assert.deepEqual(batch.records.map(({ value }) => value.type), ["one", "two"]);
    assert.deepEqual(
      batch.records.map(({ startOffset, endOffset }) => [startOffset, endOffset]),
      [
        ["0", String(Buffer.byteLength(first))],
        [
          String(Buffer.byteLength(`${first}\n${invalid}\n`)),
          String(Buffer.byteLength(`${first}\n${invalid}\n${second}`)),
        ],
      ],
    );
    assert.equal(batch.diagnostics.length, 1);
    assert.equal(batch.diagnostics[0].code, "invalid-json-record");
    assert.equal(batch.checkpoint.completeOffset, String(Buffer.byteLength(`${first}\n${invalid}\n${second}\n`)));
    assert.equal(batch.checkpoint.partialTailLength, String(Buffer.byteLength(partial)));
    assert.equal(
      batch.checkpoint.partialTailDigest,
      createHash("sha256").update(partial).digest("hex"),
    );

    await writeFile(fixture.file, `${first}\n${invalid}\n${second}\n${partial}}\n`);
    const resumed = await readSessionRecordBatch(fixture.file, {
      checkpoint: batch.checkpoint,
      chunkSize: 5,
      maxRecordBytes: 1024,
    });
    assert.deepEqual(resumed.records.map(({ value }) => value.type), ["three"]);
    assert.equal(resumed.checkpoint.partialTailLength, "0");
    assert.equal(resumed.checkpoint.eofObserved, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("stream reader rejects duplicate JSON object keys before semantic validation", async () => {
  const fixture = await fixtureFile("duplicate.jsonl", '{"type":"first","type":"second"}\n');
  try {
    const batch = await readSessionRecordBatch(fixture.file);
    assert.deepEqual(batch.records, []);
    assert.equal(batch.diagnostics.length, 1);
    assert.equal(batch.diagnostics[0].code, "invalid-json-record");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("stream reader rejects records beyond the fixed JSON depth bound", async () => {
  const nested = `${'{"value":'.repeat(65)}0${"}".repeat(65)}\n`;
  const fixture = await fixtureFile("too-deep.jsonl", nested);
  try {
    const batch = await readSessionRecordBatch(fixture.file);
    assert.deepEqual(batch.records, []);
    assert.equal(batch.diagnostics[0].code, "invalid-json-record");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("stream reader skips an oversized record and continues at the next boundary", async () => {
  const oversized = JSON.stringify({ type: "oversized", value: "x".repeat(128) });
  const accepted = JSON.stringify({ x: 1 });
  const fixture = await fixtureFile("oversized.jsonl", `${oversized}\n${accepted}\n`);
  try {
    const batch = await readSessionRecordBatch(fixture.file, { maxRecordBytes: 32 });
    assert.deepEqual(batch.records.map(({ value }) => value), [{ x: 1 }]);
    assert.deepEqual(batch.diagnostics.map(({ code }) => code), ["oversized-json-record"]);
    assert.equal(batch.checkpoint.partialTailLength, "0");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("stream reader aggregates repeated diagnostics without retaining one entry per record", async () => {
  const fixture = await fixtureFile("invalid-many.jsonl", "{invalid}\n".repeat(300));
  try {
    const batch = await readSessionRecordBatch(fixture.file);
    assert.deepEqual(batch.records, []);
    assert.equal(batch.diagnostics.length, 1);
    assert.equal(batch.diagnostics[0].code, "invalid-json-record");
    assert.equal(batch.diagnostics[0].count, 300);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("stable keys and canonical JSON have a language-neutral golden form", () => {
  assert.equal(
    hashKey("session", "codex", IDS.codex),
    "eb08db94876deefcc2497f95f2c06e31623110d48a35d3d0e60a5698e5260fc3",
  );
  assert.equal(
    canonicalJson({ z: [3, { b: false, a: "x" }], a: 1 }),
    '{"a":1,"z":[3,{"a":"x","b":false}]}',
  );
  assert.throws(() => canonicalJson({ value: 1.5 }), /integer/u);
  assert.throws(() => canonicalJson({ value: Number.MAX_SAFE_INTEGER + 1 }), /safe integer/u);
});

test("Codex adapter uses only authoritative records and keeps sensitive bodies out of Fact", async () => {
  const records = [
    {
      type: "session_meta",
      timestamp: "2026-08-01T00:00:00.000Z",
      payload: {
        id: IDS.codex,
        forked_from_id: IDS.codexRoot,
        cwd: "/private/work/project-alpha",
        cli_version: "1.2.3",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "developer",
        content: [{ type: "input_text", text: "<skills_instructions><skill><name>alpha-skill</name><path>/secret/alpha/SKILL.md</path></skill></skills_instructions>" }],
      },
    },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    {
      type: "response_item",
      timestamp: "2026-08-01T00:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "How do I inspect alpha?" }],
      },
    },
    { type: "event_msg", payload: { type: "user_message", message: "How do I inspect alpha?" } },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-real",
        name: "Read",
        arguments: JSON.stringify({ file_path: "/secret/alpha/SKILL.md", token: "do-not-store" }),
      },
    },
    { type: "event_msg", payload: { type: "mcp_tool_call_end", call_id: "exec-other", result: "do-not-store" } },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-real",
        output: "full secret skill body",
        status: "completed",
        exit_code: 0,
        duration_ms: 23,
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "<skill>\n<name>alpha-skill</name>\n<path>/secret/alpha/SKILL.md</path>\n---\nfull secret skill body" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Use the indexed evidence." }],
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
    { type: "event_msg", payload: { type: "thread_rolled_back", num_turns: 1 } },
  ];
  const raw = jsonl(records);
  const fixture = await fixtureFile(`rollout-${IDS.codex}.jsonl`, raw);
  try {
    const before = exportCodexJsonl(raw, { sessionId: IDS.codex, exportedAt: 0 });
    const delta = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.equal(validateSessionFactsDelta(delta).valid, true);
    assert.equal(delta.session.sessionScope, "main");
    assert.equal(delta.session.originatorVersion, "1.2.3");
    assert.equal(delta.session.duplicateMethod, "explicit-lineage");
    assert.equal(delta.turns.length, 1);
    assert.equal(delta.turns[0].problemText, "How do I inspect alpha?");
    assert.equal(delta.turns[0].finalAnswerExcerpt, "Use the indexed evidence.");

    const kinds = delta.evidenceEvents.map((event) => event.kind);
    assert.equal(kinds.filter((kind) => kind === "capability-invocation").length, 1);
    assert.equal(kinds.filter((kind) => kind === "capability-result").length, 1);
    assert.equal(kinds.filter((kind) => kind === "skill-load").length, 2);
    assert.equal(kinds.filter((kind) => kind === "provider-status").length, 1);
    assert.equal(delta.capabilityUses.some((use) => use.exactObservedName === "Read"), true);
    assert.equal(delta.capabilityUses.some((use) => use.exactObservedName === "alpha-skill"), true);
    assert.equal(
      delta.turnEvidence.some((link) => link.role === "lifecycle" && link.turnKey === delta.turns[0].turnKey),
      true,
    );
    assert.equal(delta.diagnostics.some((item) => item.code === "ignored-provider-twin"), true);
    assert.equal(delta.diagnostics.some((item) => item.code === "ignored-tool-twin"), true);
    const readUse = delta.capabilityUses.find((use) => use.exactObservedName === "Read");
    assert.equal(
      readUse.inputFingerprint,
      privacyContext().inputFingerprint(
        "codex",
        "tool",
        "Read",
        JSON.stringify({ file_path: "/secret/alpha/SKILL.md", token: "do-not-store" }),
      ),
    );
    const resultEvent = delta.evidenceEvents.find((event) => event.kind === "capability-result");
    assert.equal(resultEvent.exitCode, "0");
    assert.equal(resultEvent.durationMs, "23");
    assert.match(resultEvent.outputBytes, /^(0|[1-9][0-9]*)$/u);

    const serialized = JSON.stringify(delta);
    assert.doesNotMatch(serialized, /do-not-store|full secret skill body|\/secret\/alpha/u);
    assert.deepEqual(exportCodexJsonl(raw, { sessionId: IDS.codex, exportedAt: 0 }), before);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Codex Fact V2 preserves canonical Tool input and chunked unredacted output", async () => {
  const output = `begin:${"界".repeat(30_000)}:end`;
  const records = [
    { type: "session_meta", payload: { id: IDS.codex } },
    {
      type: "response_item",
      timestamp: "2026-08-01T00:00:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Inspect the private build" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-01T00:00:01.000Z",
      payload: {
        type: "function_call",
        call_id: "v2-call",
        name: "Bash",
        arguments: "{\"token\":\"private\",\"command\":\"npm test\"}",
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-01T00:00:02.000Z",
      payload: {
        type: "function_call_output",
        call_id: "v2-call",
        output,
        status: "completed",
      },
    },
  ];
  const fixture = await fixtureFile(`rollout-${IDS.codex}.jsonl`, jsonl(records));
  try {
    const delta = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
      factSchemaVersion: 2,
    });
    assert.equal(validateSessionFactsDeltaV2(delta).valid, true);
    assert.equal(delta.format, "session-facts-delta@v2");
    assert.equal(delta.factSchemaVersion, 2);
    assert.equal(delta.providerAdapterVersion, "codex@2");
    assert.equal(delta.historyEvents.length >= 3, true);

    const input = historyPayloadContent(delta, "tool-input");
    assert.equal(input.payload.encoding, "canonical-json");
    assert.equal(input.content, "{\"command\":\"npm test\",\"token\":\"private\"}");
    const result = historyPayloadContent(delta, "tool-output");
    assert.equal(result.payload.encoding, "utf-8");
    assert.equal(result.content, output);
    assert.equal(result.chunks.length > 1, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Codex Fact V2 records file attempts, failed results, exact errors, and token usage", async () => {
  const errorText = "Error 731: write failed at /tmp/threadshare-build-42";
  const records = [
    {
      type: "session_meta",
      payload: { id: IDS.codex, cwd: "/private/work/project" },
    },
    {
      type: "response_item",
      timestamp: "2026-08-01T00:00:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Update the source file" }],
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-01T00:00:01.000Z",
      payload: {
        type: "function_call",
        call_id: "file-call",
        name: "Write",
        arguments: JSON.stringify({ file_path: "/private/work/project/src/app.js", content: "private" }),
      },
    },
    {
      type: "response_item",
      timestamp: "2026-08-01T00:00:02.000Z",
      payload: {
        type: "function_call_output",
        call_id: "file-call",
        output: errorText,
        status: "failed",
      },
    },
    {
      type: "event_msg",
      timestamp: "2026-08-01T00:00:03.000Z",
      payload: {
        type: "token_count",
        info: {
          last_token_usage: {
            input_tokens: 120,
            cached_input_tokens: 80,
            output_tokens: 25,
            reasoning_output_tokens: 5,
            total_tokens: 150,
          },
        },
      },
    },
  ];
  const fixture = await fixtureFile(`rollout-${IDS.codex}.jsonl`, jsonl(records));
  try {
    const delta = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
      factSchemaVersion: 2,
    });
    assert.equal(validateSessionFactsDeltaV2(delta).valid, true);

    const invocation = delta.historyEvents.find((event) => event.kind === "capability-invocation");
    assert.deepEqual(invocation.metadata.fileActivities, [{
      action: "write",
      phase: "attempted",
      pathRole: "target",
      rawPath: "/private/work/project/src/app.js",
      normalizedPath: "/private/work/project/src/app.js",
      relativePath: "src/app.js",
      absolute: true,
      projectRelative: true,
    }]);

    const result = delta.historyEvents.find((event) => event.kind === "capability-result");
    assert.equal(result.metadata.capabilityKey, invocation.metadata.capabilityKey);
    assert.equal(result.metadata.fileActivities[0].phase, "failed");
    assert.equal(result.metadata.errorSignatureVersion, "error-signature@1");
    assert.match(result.metadata.errorSignature, /^[0-9a-f]{64}$/u);
    assert.equal(historyPayloadContent(delta, "tool-output").content, errorText);

    const tokens = delta.historyEvents.find((event) => event.kind === "token-usage");
    assert.deepEqual(tokens.metadata, {
      usageScope: "delta",
      inputTokens: "120",
      cachedInputTokens: "80",
      outputTokens: "25",
      reasoningTokens: "5",
      totalTokens: "150",
    });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Codex Fact V2 preserves provider records without a V1 evidence projection", async () => {
  const unknown = {
    type: "future_provider_record",
    payload: { nested: { private: "complete provider payload" } },
  };
  const fixture = await fixtureFile(
    `rollout-${IDS.codex}.jsonl`,
    jsonl([
      { type: "session_meta", payload: { id: IDS.codex } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Preserve future records" }],
        },
      },
      unknown,
    ]),
  );
  try {
    const delta = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
      factSchemaVersion: 2,
    });
    const targetContent = canonicalJson(unknown);
    const payload = delta.historyPayloads.find((candidate) => {
      if (candidate.payloadKind !== "provider-payload") return false;
      return delta.historyPayloadChunks
        .filter((item) => item.payloadKey === candidate.payloadKey)
        .sort((left, right) => Number(left.ordinal) - Number(right.ordinal))
        .map((item) => item.content)
        .join("") === targetContent;
    });
    assert.ok(payload);
    const event = delta.historyEvents.find((item) => item.eventKey === payload.eventKey);
    assert.equal(event?.kind, "provider-unknown");
    assert.equal(delta.evidenceEvents.some((item) => item.eventKey === payload.eventKey), false);
    assert.equal(validateSessionFactsDeltaV2(delta).valid, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Codex canonical file identity overrides a different provider lineage id", async () => {
  const fixture = await fixtureFile(
    `rollout-${IDS.codex}.jsonl`,
    jsonl([
      { type: "session_meta", payload: { id: IDS.codexRoot } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Keep canonical file identity" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "Provider id remains lineage evidence" }],
        },
      },
    ]),
  );
  try {
    const delta = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
      sessionId: IDS.codex,
    });
    assert.equal(delta.session.sessionKey, hashKey("session", "codex", IDS.codex));
    assert.notEqual(delta.session.sessionKey, hashKey("session", "codex", IDS.codexRoot));
    assert.equal(delta.session.duplicateMethod, "explicit-lineage");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Codex file-level subagent scope is decided before Turn parsing", async () => {
  const cases = [
    { thread_source: "subagent" },
    { source: { subagent: { thread_spawn: { parent: "do-not-store" } } } },
  ];
  for (const metadata of cases) {
    const fixture = await fixtureFile(
      `rollout-${IDS.codex}.jsonl`,
      jsonl([
        {
          type: "response_item",
          payload: { type: "message", role: "user", content: [{ type: "input_text", text: "Must not become a Turn" }] },
        },
        { type: "session_meta", payload: { id: IDS.codex, ...metadata } },
      ]),
    );
    try {
      const delta = await readProviderSessionDelta("codex", fixture.file, {
        privacyContext: privacyContext(),
      });
      assert.equal(delta.session.sessionScope, "subagent");
      assert.equal(delta.session.eligibility, "subagent-excluded");
      assert.deepEqual(delta.turns, []);
      assert.deepEqual(delta.evidenceEvents, []);
      assert.deepEqual(delta.capabilityUses, []);
      assert.doesNotMatch(JSON.stringify(delta), /Must not become a Turn|do-not-store/u);
    } finally {
      await rm(fixture.directory, { recursive: true, force: true });
    }
  }
});

test("Codex sessions without authoritative metadata stay unknown and emit no Turn facts", async () => {
  const fixture = await fixtureFile(
    `rollout-${IDS.codex}.jsonl`,
    jsonl([
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Do not infer main scope" }],
        },
      },
    ]),
  );
  try {
    const delta = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.equal(delta.session.sessionScope, "unknown");
    assert.equal(delta.session.eligibility, "unknown");
    assert.deepEqual(delta.turns, []);
    assert.equal(delta.diagnostics.some((item) => item.code === "unknown-session-scope"), true);
    assert.doesNotMatch(JSON.stringify(delta), /Do not infer main scope/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Codex inline subagent records retain scoped evidence without reclassifying main Tool uses", async () => {
  const records = [
    { type: "session_meta", payload: { id: IDS.codex } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "main-turn" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Coordinate the work" }],
      },
    },
    { type: "inter_agent_communication_metadata", payload: { trigger_turn: false } },
    {
      type: "response_item",
      payload: {
        type: "agent_message",
        author: "private-agent-id",
        recipient: "private-recipient-id",
        content: [{ type: "output_text", text: "private inline agent content" }],
      },
    },
    {
      type: "event_msg",
      payload: {
        type: "sub_agent_activity",
        kind: "interacted",
        agent_path: "private-agent-path",
        agent_thread_id: "private-agent-id",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "main-call",
        name: "Bash",
        arguments: "{}",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "main-call",
        output: "private output",
        status: "completed",
      },
    },
  ];
  const fixture = await fixtureFile(`rollout-${IDS.codex}.jsonl`, jsonl(records));
  try {
    const delta = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    const scoped = delta.evidenceEvents.filter((event) => event.originScope === "subagent");
    assert.equal(scoped.length, 3);
    assert.equal(scoped.filter((event) => event.kind === "provider-status").length, 2);
    assert.equal(scoped.filter((event) => event.kind === "visible-message").length, 1);
    assert.equal(delta.capabilityUses.length, 1);
    assert.equal(delta.capabilityUses[0].exactObservedName, "Bash");
    assert.equal(delta.capabilityUses[0].originScope, "main");
    assert.equal(delta.coverage["inline-subagent-record"], 3);
    assert.doesNotMatch(
      JSON.stringify(delta),
      /private-agent-id|private-recipient-id|private-agent-path|private inline agent content|private output/u,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Codex keeps multiple results, exact capability names, and ignores compacted message copies", async () => {
  const records = [
    { type: "session_meta", payload: { id: IDS.codex } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-real" } },
    {
      type: "response_item",
      timestamp: "2026-08-02T00:00:00.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Run the exact tool" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-multi",
        name: "  Namespaced.Tool  ",
        arguments: "{}",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-multi",
        output: "first result",
        status: "failed",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-multi",
        output: "second result",
        status: "completed",
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-other" } },
    {
      type: "compacted",
      replacement_history: [
        { type: "message", role: "user", content: [{ type: "input_text", text: "Copied prompt" }] },
      ],
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done." }],
      },
    },
  ];
  const fixture = await fixtureFile(`rollout-${IDS.codex}.jsonl`, jsonl(records));
  try {
    const delta = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.equal(delta.turns.length, 1);
    assert.equal(delta.turns[0].problemText, "Run the exact tool");
    assert.equal(delta.turns[0].rawClosure.providerTerminal, null);
    assert.equal(delta.capabilityUses.length, 1);
    assert.equal(delta.capabilityUses[0].exactObservedName, "  Namespaced.Tool  ");
    assert.equal(delta.capabilityUses[0].providerTerminalState, "completed");
    assert.equal(
      delta.capabilityUseEvidence.filter((link) => link.role === "result").length,
      2,
    );
    assert.equal(
      delta.evidenceEvents.filter((event) => event.kind === "visible-message" && event.role === "user").length,
      1,
    );
    assert.equal(delta.diagnostics.some((item) => item.code === "ambiguous-turn-terminal"), true);
    assert.doesNotMatch(JSON.stringify(delta), /Copied prompt|first result|second result/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Codex append replays only the open Turn while preserving Fact identities", async () => {
  const firstRecords = [
    {
      type: "session_meta",
      payload: { id: IDS.codex, cwd: "/private/work/incremental", cli_version: "1.2.3" },
    },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-incremental" } },
    {
      type: "response_item",
      timestamp: "2026-08-01T00:00:01.000Z",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Continue the open Turn" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-incremental",
        name: "Bash",
        arguments: JSON.stringify({ command: "private command" }),
      },
    },
  ];
  const appendedRecords = [
    {
      type: "response_item",
      payload: {
        type: "function_call_output",
        call_id: "call-incremental",
        output: "private output",
        status: "completed",
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The open Turn is complete." }],
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-incremental" } },
  ];
  const fixture = await fixtureFile(`rollout-${IDS.codex}.jsonl`, jsonl(firstRecords));
  try {
    const initial = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    const initialTurnKey = initial.turns[0].turnKey;
    const initialUseKey = initial.capabilityUses[0].useKey;
    await appendFile(fixture.file, jsonl(appendedRecords));

    const resumed = await readProviderSessionDelta("codex", fixture.file, {
      checkpoint: initial.checkpoint,
      privacyContext: privacyContext(),
    });
    assert.equal(resumed.session.sessionKey, initial.session.sessionKey);
    assert.equal(resumed.session.sessionScope, "main");
    assert.equal(resumed.turns.length, 1);
    assert.equal(resumed.turns[0].turnKey, initialTurnKey);
    assert.equal(resumed.turns[0].problemText, "Continue the open Turn");
    assert.equal(resumed.turns[0].finalAnswerExcerpt, "The open Turn is complete.");
    assert.equal(resumed.capabilityUses[0].useKey, initialUseKey);
    assert.equal(resumed.capabilityUses[0].providerTerminalState, "completed");
    assert.equal(resumed.expectedGeneration, "1");
    assert.equal(resumed.targetGeneration, "2");
    assert.doesNotMatch(JSON.stringify(resumed), /private command|private output/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Codex append reads only the replay window regardless of sealed history size", async () => {
  const sealedHistory = Array.from({ length: 64 }, (_, index) => [
    { type: "event_msg", payload: { type: "task_started", turn_id: `sealed-${index}` } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: `Sealed prompt ${index} ${"x".repeat(128)}` }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: `Sealed answer ${index} ${"y".repeat(128)}` }],
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: `sealed-${index}` } },
  ]).flat();
  const initialRaw = jsonl([
    { type: "session_meta", payload: { id: IDS.codex, cwd: "/private/work/incremental" } },
    ...sealedHistory,
    { type: "event_msg", payload: { type: "task_started", turn_id: "open-tail" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Read only this open tail" }],
      },
    },
  ]);
  const appendedRaw = jsonl([
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The tail is complete." }],
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "open-tail" } },
  ]);
  const fixture = await fixtureFile(`rollout-${IDS.codex}.jsonl`, initialRaw);
  try {
    const initial = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    const replayFromOffset = Number(initial.checkpoint.pendingState.replayFromOffset);
    assert.equal(Number.isSafeInteger(replayFromOffset), true);
    assert.equal(replayFromOffset > Buffer.byteLength(initialRaw) * 0.9, true);

    await appendFile(fixture.file, appendedRaw);
    const reads = [];
    const resumed = await readProviderSessionDelta("codex", fixture.file, {
      checkpoint: initial.checkpoint,
      privacyContext: privacyContext(),
      chunkSize: 37,
      onBytesRead: (read) => reads.push(read),
    });
    const totalSize = Buffer.byteLength(initialRaw) + Buffer.byteLength(appendedRaw);
    const bytesRead = reads.reduce((sum, read) => sum + read.bytesRead, 0);

    assert.equal(bytesRead, totalSize - replayFromOffset);
    assert.equal(bytesRead < totalSize / 10, true);
    assert.equal(reads.every((read) => read.phase === "records"), true);
    assert.equal(
      reads.every((read) => Number(read.startOffset) >= replayFromOffset),
      true,
    );
    assert.equal(resumed.turns.length, 1);
    assert.equal(resumed.turns[0].problemText, "Read only this open tail");
    assert.equal(resumed.turns[0].finalAnswerExcerpt, "The tail is complete.");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Codex append replays the last sealed Turn so a new boundary emits follow-up evidence", async () => {
  const firstRecords = [
    { type: "session_meta", payload: { id: IDS.codex } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "sealed-1" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "First Turn" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "First answer" }],
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "sealed-1" } },
  ];
  const secondRecords = [
    { type: "event_msg", payload: { type: "task_started", turn_id: "open-2" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Second Turn" }],
      },
    },
  ];
  const fixture = await fixtureFile(`rollout-${IDS.codex}.jsonl`, jsonl(firstRecords));
  try {
    const initial = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.notEqual(initial.checkpoint.pendingState.replayFromOffset, null);
    assert.equal(
      initial.checkpoint.pendingState.replayFromOffset,
      initial.evidenceEvents.find((event) => event.kind === "turn-lifecycle")?.sourceOrder.recordStartOffset,
    );
    await appendFile(fixture.file, jsonl(secondRecords));
    const resumed = await readProviderSessionDelta("codex", fixture.file, {
      checkpoint: initial.checkpoint,
      privacyContext: privacyContext(),
    });
    assert.equal(resumed.turns.length, 2);
    assert.equal(resumed.turns[0].turnKey, initial.turns[0].turnKey);
    assert.equal(resumed.turns[0].rawClosure.nextUserBoundary, true);
    assert.equal(
      resumed.turnEvidence.some((link) =>
        link.turnKey === initial.turns[0].turnKey && link.role === "follow-up"
      ),
      true,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Codex append correlates a terminal that arrives after the next user boundary", async () => {
  const firstRecords = [
    { type: "session_meta", payload: { id: IDS.codex } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "late-terminal-1" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "First late-terminal Turn" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "First answer" }],
      },
    },
    { type: "event_msg", payload: { type: "task_started", turn_id: "late-terminal-2" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Second late-terminal Turn" }],
      },
    },
  ];
  const lateTerminal = {
    type: "event_msg",
    payload: { type: "task_complete", turn_id: "late-terminal-1" },
  };
  const fixture = await fixtureFile(`rollout-${IDS.codex}.jsonl`, jsonl(firstRecords));
  try {
    const initial = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    const firstTurnKey = initial.turns.find((turn) =>
      turn.problemText === "First late-terminal Turn"
    )?.turnKey;
    assert.match(firstTurnKey, /^[0-9a-f]{64}$/u);
    await appendFile(fixture.file, jsonl([lateTerminal]));
    const incremental = await readProviderSessionDelta("codex", fixture.file, {
      checkpoint: initial.checkpoint,
      privacyContext: privacyContext(),
    });
    const clean = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    const incrementalTerminal = incremental.evidenceEvents.find((event) =>
      event.kind === "turn-lifecycle" && event.lifecycleState === "completed"
    );
    const cleanTerminal = clean.evidenceEvents.find((event) =>
      event.kind === "turn-lifecycle" && event.lifecycleState === "completed"
    );
    assert.deepEqual(incrementalTerminal, cleanTerminal);
    assert.equal(incrementalTerminal?.occurredTurnKey, null);
    assert.equal(
      clean.turns.find((turn) => turn.turnKey === firstTurnKey)?.rawClosure.providerTerminal,
      null,
    );
    assert.equal(
      incremental.turnEvidence.some((link) =>
        link.turnKey === firstTurnKey &&
        link.eventKey === incrementalTerminal?.eventKey &&
        link.role === "lifecycle"
      ),
      true,
    );
    assert.equal(
      incremental.diagnostics.some((item) => item.code === "ambiguous-turn-terminal"),
      false,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("provider records replace unpaired surrogates without dropping the session", async () => {
  const high = String.fromCharCode(0xd800);
  const low = String.fromCharCode(0xdc00);
  const fixture = await fixtureFile(
    `rollout-${IDS.codex}.jsonl`,
    jsonl([
      { type: "session_meta", payload: { id: IDS.codex } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `bad ${high} text` }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "unicode-input",
          name: "Bash",
          arguments: JSON.stringify({ command: `echo ${high}` }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `done ${low}` }],
        },
      },
    ]),
  );
  try {
    const delta = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.equal(delta.turns[0].problemText, "bad \ufffd text");
    assert.equal(delta.turns[0].finalAnswerExcerpt, "done \ufffd");
    assert.match(delta.capabilityUses[0].inputFingerprint, /^[0-9a-f]{64}$/u);
    assert.equal(delta.coverage["invalid-unicode-replaced"] > 0, true);
    assert.equal(
      delta.diagnostics.some((item) => item.code === "invalid-unicode-replaced"),
      true,
    );
    assert.doesNotThrow(() => canonicalJson(delta));
    assert.equal(JSON.stringify(delta).includes("\\ud800"), false);
    assert.equal(JSON.stringify(delta).includes("\\udc00"), false);
    assert.doesNotThrow(() => privacyContext().inputFingerprint(
      "codex",
      "tool",
      "Bash",
      `{"command":"echo ${high}"}`,
    ));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("bounded problem text truncates on UTF-8 character boundaries", async () => {
  const question = `${"界".repeat(100_000)}xx`;
  const fixture = await fixtureFile(
    `rollout-${IDS.codex}.jsonl`,
    jsonl([
      { type: "session_meta", payload: { id: IDS.codex } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: question }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: "done" }],
        },
      },
    ]),
  );
  try {
    const delta = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    const problemText = delta.turns[0].problemText;
    assert.equal(Buffer.byteLength(problemText, "utf8") <= 64 * 1024, true);
    assert.equal(problemText.includes("\ufffd"), false);
    assert.equal(problemText.endsWith("xx"), true);
    assert.deepEqual(delta.turns[0].factTruncation, ["problem-text"]);
    assert.doesNotThrow(() => validateSessionFactsDelta(delta));
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("replace-session advances the committed generation without resuming parser state", async () => {
  const fixture = await fixtureFile(
    `${IDS.claude}.jsonl`,
    jsonl([
      {
        type: "user",
        sessionId: IDS.claude,
        uuid: "replace-user",
        timestamp: "2026-08-01T01:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Rebuild this session" }] },
      },
      {
        type: "assistant",
        sessionId: IDS.claude,
        uuid: "replace-assistant",
        timestamp: "2026-08-01T01:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Rebuilt." }] },
      },
    ]),
  );
  try {
    const delta = await readProviderSessionDelta("claude", fixture.file, {
      privacyContext: privacyContext(),
      mode: "replace-session",
      expectedGeneration: "7",
    });
    assert.equal(delta.mode, "replace-session");
    assert.equal(delta.expectedGeneration, "7");
    assert.equal(delta.targetGeneration, "8");
    assert.equal(delta.checkpoint.generation, "8");
    assert.equal(delta.turns[0].problemText, "Rebuild this session");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Claude adapter keeps tool-result-only records inside the current Turn and confirms Skill only on success", async () => {
  const records = [
    {
      type: "user",
      sessionId: IDS.claude,
      uuid: "u-1",
      timestamp: "2026-08-01T01:00:00.000Z",
      cwd: "/private/work/claude-project",
      version: "2.1.222",
      message: { role: "user", content: [{ type: "text", text: "Diagnose the build" }] },
    },
    {
      type: "assistant",
      sessionId: IDS.claude,
      uuid: "a-1",
      timestamp: "2026-08-01T01:00:01.000Z",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "tool-1", name: "Bash", input: { command: "secret command" } },
          { type: "tool_use", id: "skill-1", name: "Skill", input: { skill: "release-check" } },
        ],
      },
    },
    {
      type: "user",
      sessionId: IDS.claude,
      uuid: "u-result",
      timestamp: "2026-08-01T01:00:02.000Z",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "tool-1", content: "secret output" },
          { type: "tool_result", tool_use_id: "skill-1", content: "loaded", is_error: false },
        ],
      },
    },
    {
      type: "assistant",
      sessionId: IDS.claude,
      uuid: "a-side",
      isSidechain: true,
      timestamp: "2026-08-01T01:00:03.000Z",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "side-1", name: "Read", input: { file_path: "/secret" } }],
      },
    },
    {
      type: "assistant",
      sessionId: IDS.claude,
      uuid: "a-2",
      timestamp: "2026-08-01T01:00:04.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "The build is fixed." }] },
    },
  ];
  const raw = jsonl(records);
  const fixture = await fixtureFile(`${IDS.claude}.jsonl`, raw);
  try {
    const before = exportClaudeJsonl(raw, { sessionId: IDS.claude, exportedAt: 0 });
    const delta = await readProviderSessionDelta("claude", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.equal(validateSessionFactsDelta(delta).valid, true);
    assert.equal(delta.session.originatorVersion, "2.1.222");
    assert.equal(delta.turns.length, 1);
    assert.equal(delta.turns[0].finalAnswerExcerpt, "The build is fixed.");
    assert.equal(delta.capabilityUses.filter((use) => use.exactObservedName === "Bash").length, 1);
    assert.equal(delta.capabilityUses.filter((use) => use.exactObservedName === "release-check").length, 1);
    assert.equal(delta.capabilityUses.some((use) => use.exactObservedName === "Read" && use.originScope === "subagent"), true);
    const sidechainUse = delta.capabilityUses.find((use) =>
      use.exactObservedName === "Read" && use.originScope === "subagent"
    );
    assert.equal(
      sidechainUse.originFingerprint,
      privacyContext().fingerprint("origin", "claude", "subagent"),
    );
    assert.equal(
      delta.evidenceEvents.filter((event) => event.kind === "visible-message" && event.role === "user").length,
      1,
    );
    assert.equal(
      delta.evidenceEvents.filter((event) => event.kind === "skill-load" && event.strength === "confirmed").length,
      1,
    );
    assert.equal(delta.session.duplicateMethod, "exact-first-turn-prefix");
    assert.equal(delta.session.dedupeClosure, "observed-eof");
    assert.equal(
      new Set(delta.session.dedupeEvidenceEventKeys).size,
      delta.session.dedupeEvidenceEventKeys.length,
    );
    assert.doesNotMatch(JSON.stringify(delta), /secret command|secret output|\/secret/u);
    assert.deepEqual(exportClaudeJsonl(raw, { sessionId: IDS.claude, exportedAt: 0 }), before);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Claude Fact V2 preserves Tool object input and result content", async () => {
  const records = [
    {
      type: "user",
      sessionId: IDS.claude,
      uuid: "v2-u-1",
      timestamp: "2026-08-01T01:00:00.000Z",
      cwd: "/private/work/claude-v2",
      message: { role: "user", content: [{ type: "text", text: "Run the private command" }] },
    },
    {
      type: "assistant",
      sessionId: IDS.claude,
      uuid: "v2-a-1",
      timestamp: "2026-08-01T01:00:01.000Z",
      message: {
        role: "assistant",
        model: "claude-test-model",
        usage: {
          input_tokens: 40,
          cache_read_input_tokens: 12,
          cache_creation_input_tokens: 3,
          output_tokens: 9,
        },
        content: [{ type: "tool_use", id: "v2-tool", name: "Bash", input: { token: "private", command: "pwd" } }],
      },
    },
    {
      type: "user",
      sessionId: IDS.claude,
      uuid: "v2-r-1",
      timestamp: "2026-08-01T01:00:02.000Z",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "v2-tool", content: "private result", is_error: false }],
      },
    },
  ];
  const fixture = await fixtureFile(`${IDS.claude}.jsonl`, jsonl(records));
  try {
    const delta = await readProviderSessionDelta("claude", fixture.file, {
      privacyContext: privacyContext(),
      factSchemaVersion: 2,
    });
    assert.equal(validateSessionFactsDeltaV2(delta).valid, true);
    assert.equal(delta.providerAdapterVersion, "claude@2");
    assert.equal(historyPayloadContent(delta, "tool-input").content, "{\"command\":\"pwd\",\"token\":\"private\"}");
    assert.equal(historyPayloadContent(delta, "tool-output").content, "private result");
    const tokenUsage = delta.historyEvents.find((event) => event.kind === "token-usage");
    assert.deepEqual(tokenUsage.metadata, {
      usageScope: "delta",
      model: "claude-test-model",
      inputTokens: "40",
      cachedInputTokens: "12",
      cacheWriteInputTokens: "3",
      outputTokens: "9",
    });
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Claude append preserves the complete Session Fact and exact-content dedupe state", async () => {
  const first = [
    {
      type: "user",
      sessionId: IDS.claude,
      uuid: "incremental-user-1",
      timestamp: "2026-08-05T01:00:00.000Z",
      cwd: "/private/work/incremental-claude",
      version: "2.1.222",
      message: { role: "user", content: [{ type: "text", text: "First question" }] },
    },
    {
      type: "assistant",
      sessionId: IDS.claude,
      uuid: "incremental-assistant-1",
      timestamp: "2026-08-05T01:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "First answer" }] },
    },
  ];
  const second = [
    {
      type: "user",
      sessionId: IDS.claude,
      uuid: "incremental-user-2",
      timestamp: "2026-08-05T02:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Second question" }] },
    },
    {
      type: "assistant",
      sessionId: IDS.claude,
      uuid: "incremental-assistant-2",
      timestamp: "2026-08-05T02:00:01.000Z",
      message: { role: "assistant", content: [{ type: "text", text: "Second answer" }] },
    },
  ];
  const fixture = await fixtureFile(`${IDS.claude}.jsonl`, jsonl(first));
  try {
    const initial = await readProviderSessionDelta("claude", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.equal(initial.session.duplicateMethod, "exact-first-turn-prefix");
    assert.equal(initial.session.duplicateConfidence, "weak");
    assert.equal(initial.session.dedupeClosure, "observed-eof");
    assert.equal(initial.turns[0].rawClosure.observedEofClosed, true);
    assert.equal(initial.checkpoint.sourceSnapshotStable, true);
    assert.match(initial.checkpoint.sourceSize, /^(0|[1-9][0-9]*)$/u);
    assert.match(initial.checkpoint.sourceMtimeNs, /^(0|[1-9][0-9]*)$/u);
    assert.equal(Object.hasOwn(initial.checkpoint, "sourceLocator"), false);
    assert.deepEqual(initial.retractions.authoritativeTurnKeys, initial.turns.map((turn) => turn.turnKey));

    await appendFile(fixture.file, jsonl(second));
    const incremental = await readProviderSessionDelta("claude", fixture.file, {
      checkpoint: initial.checkpoint,
      privacyContext: privacyContext(),
    });
    const clean = await readProviderSessionDelta("claude", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.deepEqual(incremental.session, clean.session);
    assert.equal(incremental.session.observedStart, "2026-08-05T01:00:00.000Z");
    assert.equal(incremental.session.observedEnd, "2026-08-05T02:00:01.000Z");
    assert.equal(incremental.session.duplicateMethod, "exact-first-turn-prefix");
    assert.equal(incremental.session.duplicateConfidence, "weak");
    assert.equal(incremental.session.dedupeClosure, "hard-sealed");
    assert.equal(incremental.session.dedupeEvidenceEventKeys.length > 0, true);
    assert.doesNotMatch(JSON.stringify(incremental), /\/private\/work\/incremental-claude/u);

    await appendFile(fixture.file, jsonl([
      {
        type: "user",
        sessionId: IDS.claude,
        uuid: "incremental-user-3",
        timestamp: "2026-08-05T03:00:00.000Z",
        message: { role: "user", content: [{ type: "text", text: "Third question" }] },
      },
      {
        type: "assistant",
        sessionId: IDS.claude,
        uuid: "incremental-assistant-3",
        timestamp: "2026-08-05T03:00:01.000Z",
        message: { role: "assistant", content: [{ type: "text", text: "Third answer" }] },
      },
    ]));
    const secondIncremental = await readProviderSessionDelta("claude", fixture.file, {
      checkpoint: incremental.checkpoint,
      privacyContext: privacyContext(),
    });
    const secondClean = await readProviderSessionDelta("claude", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.deepEqual(secondIncremental.session, secondClean.session);
    assert.match(secondIncremental.session.dedupeCorroborationFingerprint, /^[0-9a-f]{64}$/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("observedEofClosed requires a non-empty visible assistant message", async () => {
  const fixture = await fixtureFile(
    `${IDS.claude}.jsonl`,
    jsonl([{
      type: "user",
      sessionId: IDS.claude,
      uuid: "user-only",
      timestamp: "2026-08-06T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "No answer yet" }] },
    }]),
  );
  try {
    const delta = await readProviderSessionDelta("claude", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.equal(delta.turns[0].rawClosure.observedEofClosed, false);
    assert.equal(delta.session.dedupeFingerprint, undefined);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Claude agent files are rejected before they can overwrite a main Session Fact", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-agent-file-"));
  const file = path.join(directory, "subagents", "agent-child.jsonl");
  await mkdir(path.dirname(file), { recursive: true });
  await writeFile(file, jsonl([{
    type: "user",
    sessionId: IDS.claude,
    uuid: "agent-user",
    message: { role: "user", content: [{ type: "text", text: "Do not ingest" }] },
  }]));
  try {
    await assert.rejects(
      readProviderSessionDelta("claude", file, { privacyContext: privacyContext() }),
      (error) => error?.code === "TS_SESSION_SUBAGENT_EXCLUDED",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("capability names and Claude UUID checkpoint state have hard bounds", async () => {
  const records = [
    {
      type: "user",
      sessionId: IDS.claude,
      uuid: "bounded-user",
      timestamp: "2026-08-07T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Exercise bounds" }] },
    },
    {
      type: "assistant",
      sessionId: IDS.claude,
      uuid: "bounded-name",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "too-long", name: "x".repeat(513), input: {} }],
      },
    },
    ...Array.from({ length: 4_100 }, (_, index) => ({
      type: "system",
      sessionId: IDS.claude,
      uuid: `bounded-${index}`,
    })),
  ];
  const fixture = await fixtureFile(`${IDS.claude}.jsonl`, jsonl(records));
  try {
    const delta = await readProviderSessionDelta("claude", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.equal(delta.capabilities.length, 0);
    assert.equal(delta.diagnostics.some((item) => item.code === "invalid-capability-name"), true);
    assert.equal(delta.checkpoint.pendingState.seenClaudeUuids.length, 4_096);
    assert.equal(Buffer.byteLength(canonicalJson(delta.checkpoint)) < 3_932_160, true);
    assert.equal(delta.coverage["claude-uuid-dedupe-overflow"] > 0, true);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("overlong Skill names become diagnostics across provider Skill paths", async () => {
  const skillName = "\u6280".repeat(300);
  const codex = await fixtureFile(
    `rollout-${IDS.codex}.jsonl`,
    jsonl([
      { type: "session_meta", payload: { id: IDS.codex } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "developer",
          content: [{
            type: "input_text",
            text: `<skills_instructions><skill><name>${skillName}</name><path>/tmp/SKILL.md</path></skill></skills_instructions>`,
          }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Start a normal Turn" }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `<skill>\n<name>${skillName}</name>` }],
        },
      },
    ]),
  );
  const claude = await fixtureFile(
    `${IDS.claude}.jsonl`,
    jsonl([
      {
        type: "user",
        sessionId: IDS.claude,
        uuid: "overlong-skill-user",
        message: { role: "user", content: [{ type: "text", text: "Load the Skill" }] },
      },
      {
        type: "assistant",
        sessionId: IDS.claude,
        uuid: "overlong-skill-assistant",
        message: {
          role: "assistant",
          content: [{
            type: "tool_use",
            id: "overlong-skill-use",
            name: "Skill",
            input: { skill: skillName },
          }],
        },
      },
      {
        type: "user",
        sessionId: IDS.claude,
        uuid: "overlong-skill-result",
        message: {
          role: "user",
          content: [{
            type: "tool_result",
            tool_use_id: "overlong-skill-use",
            content: "loaded",
            is_error: false,
          }],
        },
      },
    ]),
  );
  try {
    for (const [provider, fixture] of [["codex", codex], ["claude", claude]]) {
      const delta = await readProviderSessionDelta(provider, fixture.file, {
        privacyContext: privacyContext(),
      });
      assert.equal(delta.capabilities.some((item) => item.kind === "skill"), false);
      assert.equal(
        delta.diagnostics.some((item) => item.code === "invalid-capability-name"),
        true,
        provider,
      );
    }
  } finally {
    await rm(codex.directory, { recursive: true, force: true });
    await rm(claude.directory, { recursive: true, force: true });
  }
});

test("Claude failed Skill results do not create Skill facts and sidechain user text does not open a Turn", async () => {
  const records = [
    {
      type: "user",
      sessionId: IDS.claude,
      uuid: "failed-u-1",
      timestamp: "2026-08-03T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Load the release skill" }] },
    },
    {
      type: "assistant",
      sessionId: IDS.claude,
      uuid: "failed-a-1",
      message: {
        role: "assistant",
        content: [{ type: "tool_use", id: "failed-skill", name: "Skill", input: { skill: "release" } }],
      },
    },
    {
      type: "user",
      sessionId: IDS.claude,
      uuid: "failed-result",
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: "failed-skill", content: "private failure", is_error: true }],
      },
    },
    {
      type: "user",
      sessionId: IDS.claude,
      uuid: "sidechain-user",
      isSidechain: true,
      message: { role: "user", content: [{ type: "text", text: "Subagent-only question" }] },
    },
    {
      type: "assistant",
      sessionId: IDS.claude,
      uuid: "failed-a-2",
      message: { role: "assistant", content: [{ type: "text", text: "Skill load failed." }] },
    },
  ];
  const fixture = await fixtureFile(`${IDS.claude}.jsonl`, jsonl(records));
  try {
    const delta = await readProviderSessionDelta("claude", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.equal(delta.turns.length, 1);
    assert.equal(delta.capabilities.some((item) => item.kind === "skill"), false);
    assert.equal(delta.evidenceEvents.some((item) => item.kind === "skill-load"), false);
    assert.equal(delta.capabilityUses.find((item) => item.exactObservedName === "Skill")?.providerTerminalState, "failed");
    assert.equal(
      delta.evidenceEvents.some((item) => item.kind === "visible-message" && item.originScope === "subagent"),
      true,
    );
    assert.doesNotMatch(JSON.stringify(delta), /private failure|Subagent-only question/u);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Claude result state updates the correlated Use when Tool names are identical", async () => {
  const records = [
    {
      type: "user",
      sessionId: IDS.claude,
      uuid: "same-u-1",
      timestamp: "2026-08-04T00:00:00.000Z",
      message: { role: "user", content: [{ type: "text", text: "Run both" }] },
    },
    {
      type: "assistant",
      sessionId: IDS.claude,
      uuid: "same-a-1",
      message: {
        role: "assistant",
        content: [
          { type: "tool_use", id: "same-1", name: "Read", input: { file_path: "a" } },
          { type: "tool_use", id: "same-2", name: "Read", input: { file_path: "b" } },
        ],
      },
    },
    {
      type: "user",
      sessionId: IDS.claude,
      uuid: "same-result",
      message: {
        role: "user",
        content: [
          { type: "tool_result", tool_use_id: "same-2", content: "ok", is_error: false },
          { type: "tool_result", tool_use_id: "same-1", content: "failed", is_error: true },
        ],
      },
    },
    {
      type: "assistant",
      sessionId: IDS.claude,
      uuid: "same-a-2",
      message: { role: "assistant", content: [{ type: "text", text: "Done" }] },
    },
  ];
  const fixture = await fixtureFile(`${IDS.claude}.jsonl`, jsonl(records));
  try {
    const delta = await readProviderSessionDelta("claude", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.deepEqual(
      delta.capabilityUses
        .filter((use) => use.exactObservedName === "Read")
        .sort((left, right) => left.turnOrdinal - right.turnOrdinal)
        .map((use) => use.providerTerminalState),
      ["failed", "completed"],
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("Fact caps retain a deterministic head and tail of Capability Uses", async () => {
  const calls = Array.from({ length: 2_500 }, (_, index) => ({
    type: "response_item",
    payload: {
      type: "function_call",
      call_id: `call-${index}`,
      name: "Tool",
      arguments: JSON.stringify({ index }),
    },
  }));
  const fixture = await fixtureFile(
    `rollout-${IDS.codex}.jsonl`,
    jsonl([
      { type: "session_meta", payload: { id: IDS.codex } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: "Exercise the cap" }],
        },
      },
      ...calls,
    ]),
  );
  try {
    const delta = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.equal(delta.capabilityUses.length, 2_048);
    assert.equal(delta.capabilityUseEvidence.length, 2_048);
    assert.equal(delta.turns[0].factTruncation.includes("capability-uses"), true);
    const ordinals = new Set(delta.capabilityUses.map((use) => use.turnOrdinal));
    assert.equal(ordinals.has(0), true);
    assert.equal(ordinals.has(1_535), true);
    assert.equal(ordinals.has(1_536), false);
    assert.equal(ordinals.has(1_537), false);
    assert.equal(ordinals.has(1_987), false);
    assert.equal(ordinals.has(1_988), true);
    assert.equal(ordinals.has(2_499), true);
    const priorTailKey = delta.capabilityUses.find((use) => use.turnOrdinal === 1_988)?.useKey;
    await appendFile(fixture.file, jsonl(calls.slice(0, 10).map((record, index) => ({
      ...record,
      payload: { ...record.payload, call_id: `appended-${index}` },
    }))));
    const incremental = await readProviderSessionDelta("codex", fixture.file, {
      checkpoint: delta.checkpoint,
      privacyContext: privacyContext(),
    });
    const clean = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.deepEqual(
      incremental.capabilityUses.map((use) => use.useKey),
      clean.capabilityUses.map((use) => use.useKey),
    );
    assert.deepEqual(
      incremental.capabilityUseEvidence,
      clean.capabilityUseEvidence,
    );
    assert.deepEqual(
      incremental.retractions.authoritativeTurnKeys,
      incremental.turns.map((turn) => turn.turnKey),
    );
    assert.equal(incremental.capabilityUses.some((use) => use.useKey === priorTailKey), false);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("provider coverage and diagnostics aggregate unknown record classes within fixed key bounds", async () => {
  const unknown = Array.from({ length: 300 }, (_, index) => ({ type: `unknown-${index}` }));
  const fixture = await fixtureFile(
    `rollout-${IDS.codex}.jsonl`,
    jsonl([{ type: "session_meta", payload: { id: IDS.codex } }, ...unknown]),
  );
  try {
    const delta = await readProviderSessionDelta("codex", fixture.file, {
      privacyContext: privacyContext(),
    });
    assert.equal(Object.keys(delta.coverage).length, 256);
    assert.equal(delta.coverage["coverage-key-overflow"], 45);
    assert.deepEqual(
      delta.diagnostics.find((item) => item.code === "unknown-provider-record")?.count,
      300,
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("provider authority index is explicit and versioned", () => {
  assert.equal(PROVIDER_RECORD_AUTHORITY_V1.version, 1);
  assert.equal(PROVIDER_RECORD_AUTHORITY_V1.codex.toolInvocation.authority, "response_item");
  assert.equal(PROVIDER_RECORD_AUTHORITY_V1.codex.toolResult.ignoredNamespace, "event_msg");
  assert.equal(PROVIDER_RECORD_AUTHORITY_V1.claude.userBoundary.excludesToolResultOnly, true);
  assert.equal(PROVIDER_RECORD_AUTHORITY_V1.claude.inferredSkillLoad, "unsupported-without-session-catalog");
});

test("Claude evidence discovery reports unnamed subagent files instead of silently dropping them", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "threadshare-discovery-"));
  const project = path.join(home, ".claude", "projects", "fixture");
  const subagents = path.join(project, IDS.claude, "subagents");
  await mkdir(subagents, { recursive: true });
  await writeFile(path.join(project, `${IDS.claude}.jsonl`), "{}\n");
  await writeFile(path.join(subagents, "agent-55555555-5555-4555-8555-555555555555.jsonl"), "{}\n");
  try {
    const result = await discoverProviderEvidenceSources("claude", {
      environment: { HOME: home },
    });
    assert.deepEqual(result.sources.map(({ sessionId }) => sessionId), [IDS.claude]);
    assert.deepEqual(result.diagnostics, [
      { code: "unnamed-subagent-file-skipped", count: 1 },
    ]);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("Claude evidence discovery scales across 10,000 real session files without reading bodies", async () => {
  const home = await mkdtemp(path.join(os.tmpdir(), "threadshare-discovery-scale-"));
  const project = path.join(home, ".claude", "projects", "fixture");
  await mkdir(project, { recursive: true });
  const sessionIds = Array.from(
    { length: 10_000 },
    (_, index) => `00000000-0000-4000-8000-${String(index).padStart(12, "0")}`,
  );
  try {
    for (let offset = 0; offset < sessionIds.length; offset += 250) {
      await Promise.all(sessionIds.slice(offset, offset + 250).map((sessionId) =>
        writeFile(
          path.join(project, `${sessionId}.jsonl`),
          "{}\n",
          process.platform === "win32" ? undefined : { mode: 0o000 },
        )
      ));
    }

    const result = await discoverProviderEvidenceSources("claude", {
      environment: { HOME: home },
    });
    assert.equal(result.sources.length, 10_000);
    assert.deepEqual(result.diagnostics, []);
    assert.equal(result.sources[0].sessionId, sessionIds[0]);
    assert.equal(result.sources.at(-1).sessionId, sessionIds.at(-1));
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});
