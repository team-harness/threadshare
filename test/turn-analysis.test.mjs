import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  analyzeSession,
  analyzeSessionFacts,
  formatSessionAnalysisJson,
  formatSessionAnalysisText,
} from "../src/turn-analysis.mjs";

const KEY = {
  session: "1".repeat(64),
  turn1: "2".repeat(64),
  turn2: "3".repeat(64),
  source1: "4".repeat(64),
  source2: "5".repeat(64),
  event1: "6".repeat(64),
  event2: "7".repeat(64),
  event3: "8".repeat(64),
  tool: "9".repeat(64),
  use1: "a".repeat(64),
  use2: "b".repeat(64),
};

function snapshot() {
  return {
    factSchemaVersion: 1,
    session: {
      sessionKey: KEY.session,
      provider: "codex",
      sessionScope: "main",
      eligibility: "eligible",
      observedStart: "2026-08-01T00:00:00.000Z",
      observedEnd: "2026-08-01T00:00:02.000Z",
      duplicatePolicyVersion: 1,
      duplicateGroupKey: null,
    },
    checkpoint: {
      eofObserved: true,
      partialTailLength: "0",
      sourceSnapshotStable: true,
      sourceMtimeNs: "1000000000",
      generation: "1",
    },
    turns: [
      {
        turnKey: KEY.turn1,
        ownerSessionKey: KEY.session,
        turnStartOffset: "10",
        problemText: "First question with /private/input hidden upstream",
        finalAnswerExcerpt: "First answer",
        observedTimestamp: "2026-08-01T00:00:00.000Z",
        rawClosure: {
          nextUserBoundary: true,
          providerTerminal: null,
          observedEofClosed: false,
        },
        providerVisibility: "active",
        factTruncation: [],
        revision: "c".repeat(64),
      },
      {
        turnKey: KEY.turn2,
        ownerSessionKey: KEY.session,
        turnStartOffset: "20",
        problemText: "Second question",
        finalAnswerExcerpt: "Second answer",
        observedTimestamp: "2026-08-01T00:00:02.000Z",
        rawClosure: {
          nextUserBoundary: false,
          providerTerminal: null,
          observedEofClosed: true,
        },
        providerVisibility: "active",
        factTruncation: [],
        revision: "d".repeat(64),
      },
    ],
    sourceRecords: [
      {
        sourceRecordKey: KEY.source1,
        ownerSessionKey: KEY.session,
        startOffset: "10",
        endOffset: "15",
        recordSha256: "e".repeat(64),
        providerRecordClass: "response_item:function_call",
      },
      {
        sourceRecordKey: KEY.source2,
        ownerSessionKey: KEY.session,
        startOffset: "30",
        endOffset: "35",
        recordSha256: "f".repeat(64),
        providerRecordClass: "event_msg:turn_aborted",
      },
    ],
    evidenceEvents: [
      {
        eventKey: KEY.event1,
        ownerSessionKey: KEY.session,
        occurredTurnKey: KEY.turn1,
        sourceRecordKey: KEY.source1,
        sourceOrder: { recordStartOffset: "10", contentIndex: -1, eventOrdinal: 0 },
        pointer: { pointerKind: "codex:response_item:function_call", contentIndex: -1, eventOrdinal: 0 },
        originScope: "main",
        observedTimestamp: null,
        kind: "capability-invocation",
        capabilityKey: KEY.tool,
        inputFingerprint: "0".repeat(64),
        correlationDigest: "1".repeat(64),
      },
      {
        eventKey: KEY.event2,
        ownerSessionKey: KEY.session,
        occurredTurnKey: KEY.turn1,
        sourceRecordKey: KEY.source1,
        sourceOrder: { recordStartOffset: "11", contentIndex: -1, eventOrdinal: 0 },
        pointer: { pointerKind: "codex:response_item:function_call_output", contentIndex: -1, eventOrdinal: 0 },
        originScope: "main",
        observedTimestamp: null,
        kind: "capability-result",
        correlationDigest: "1".repeat(64),
        providerState: "failed",
        outputBytes: "12",
      },
      {
        eventKey: KEY.event3,
        ownerSessionKey: KEY.session,
        occurredTurnKey: null,
        sourceRecordKey: KEY.source2,
        sourceOrder: { recordStartOffset: "30", contentIndex: -1, eventOrdinal: 0 },
        pointer: { pointerKind: "codex:event_msg:turn_aborted", contentIndex: -1, eventOrdinal: 0 },
        originScope: "main",
        observedTimestamp: null,
        kind: "turn-lifecycle",
        lifecycleState: "aborted",
        providerTurnDigest: "2".repeat(64),
      },
    ],
    turnEvidence: [
      { ownerSessionKey: KEY.session, turnKey: KEY.turn1, eventKey: KEY.event3, role: "lifecycle" },
    ],
    capabilities: [
      {
        capabilityKey: KEY.tool,
        ownerSessionKey: KEY.session,
        provider: "codex",
        kind: "tool",
        canonicalName: "Bash",
        identityVersion: 1,
      },
    ],
    capabilityUses: [
      {
        useKey: KEY.use1,
        ownerSessionKey: KEY.session,
        turnKey: KEY.turn1,
        capabilityKey: KEY.tool,
        turnOrdinal: 0,
        exactObservedName: "Bash",
        originScope: "main",
        inputFingerprint: "3".repeat(64),
        providerTerminalState: "failed",
        strength: "observed",
      },
      {
        useKey: KEY.use2,
        ownerSessionKey: KEY.session,
        turnKey: KEY.turn1,
        capabilityKey: KEY.tool,
        turnOrdinal: 1,
        exactObservedName: "Bash",
        originScope: "main",
        inputFingerprint: "3".repeat(64),
        providerTerminalState: "completed",
        strength: "observed",
      },
    ],
    capabilityUseEvidence: [
      { ownerSessionKey: KEY.session, useKey: KEY.use1, eventKey: KEY.event1, role: "invocation" },
      { ownerSessionKey: KEY.session, useKey: KEY.use1, eventKey: KEY.event2, role: "result" },
    ],
    diagnostics: [{ code: "fixture-diagnostic", count: 1 }],
    coverage: { fixture: 2 },
  };
}

test("analyzes closure, retry, evidence, and privacy from committed facts", () => {
  const facts = snapshot();
  facts.turns[0].problemText += " \u001b]0;owned\u0007";
  facts.turns[0].finalAnswerExcerpt += " \u001b[31mred\u001b[0m \u202eunsafe";
  facts.capabilities[0].canonicalName = "Bash\u001b[31m";
  facts.capabilityUses[0].exactObservedName = "Bash\u001b]0;owned\u0007";
  facts.capabilityUses[1].exactObservedName = "Bash\u001b[31m";
  const report = analyzeSessionFacts(facts, {
    now: 61_000,
    quiescenceSeconds: 60,
  });
  assert.equal(report.format, "threadshare-session-analysis@v1");
  assert.equal(report.turns[0].closure.state, "hard-sealed");
  assert.equal(report.turns[0].closure.evidenceHiddenByRollback, false);
  assert.equal(report.turns[0].resultEvidence.display, "abandoned");
  assert.equal(report.turns[1].closure.state, "quiescent");
  assert.equal(report.turns[1].closure.provisional, true);
  assert.equal(report.summary.aggregateEligible.turns, 2);
  assert.equal(report.summary.aggregateEligible.toolUses, 2);
  assert.match(report.turns[0].problemText, /\[LOCAL_PATH\]/u);
  assert.doesNotMatch(report.turns[0].problemText, /\/private\/input|\u001b/u);
  assert.doesNotMatch(report.turns[0].finalAnswerExcerpt, /\u001b|\u202e/u);
  assert.doesNotMatch(report.capabilities[0].canonicalName, /\u001b/u);
  assert.deepEqual(report.uses[1].inputRelation, {
    kind: "retry-after-failure",
    previousUseKey: KEY.use1,
  });
  assert.deepEqual(report.events[0].pointer, {
    recordStartOffset: "10",
    recordEndOffset: "15",
    recordSha256: "e".repeat(64),
    providerRecordClass: "response_item:function_call",
    pointerKind: "codex:response_item:function_call",
    contentIndex: -1,
    eventOrdinal: 0,
  });
  const serialized = formatSessionAnalysisJson(report);
  assert.equal(serialized.endsWith("\n"), true);
  assert.doesNotMatch(
    serialized,
    /inputFingerprint|correlationDigest|providerTurnDigest|duplicateGroupKey|revision/u,
  );
  assert.match(serialized, /First question/u);
  assert.doesNotMatch(serialized, /\/private\/input|\u001b|\u202e/u);
  const text = formatSessionAnalysisText(report);
  assert.doesNotMatch(text, /\u001b|\u202e/u);
  assert.match(text, /Scope: main; eligibility: eligible/u);
  assert.match(text, /Diagnostics: fixture-diagnostic=1/u);
});

test("hides rolled-back event pointers while retaining the rollback evidence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-analysis-rollback-"));
  const sessionId = "bbbbbbbb-cccc-4ddd-8eee-ffffffffffff";
  const file = path.join(directory, `rollout-${sessionId}.jsonl`);
  const records = [{ type: "session_meta", payload: { id: sessionId } }];
  for (let index = 1; index <= 3; index += 1) {
    records.push(
      { type: "event_msg", payload: { type: "task_started", turn_id: `turn-${index}` } },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: `Question ${index}` }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: `Answer ${index}` }],
        },
      },
    );
    if (index === 2) {
      records.push({
        type: "event_msg",
        payload: { type: "task_complete", turn_id: `turn-${index}` },
      });
    }
  }
  records.push({
    type: "event_msg",
    payload: { type: "thread_rolled_back", num_turns: 1 },
  });
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  try {
    const report = await analyzeSession("codex", file, {
      now: Date.now(),
      quiescenceSeconds: 60,
    });
    assert.equal(report.summary.excluded.rolledBackTurns, 1);
    assert.deepEqual(report.turns.map((turn) => turn.problemText), ["Question 1", "Question 3"]);
    assert.equal(report.turns[0].closure.state, "hard-sealed");
    assert.deepEqual(report.turns[0].closure.reasons, ["next-user-boundary"]);
    assert.equal(report.turns[0].closure.evidenceHiddenByRollback, true);
    assert.equal(report.turns[0].resultEvidence.followUpObserved, true);
    assert.equal(report.turns[0].evidence.some((event) => event.role === "follow-up"), false);
    assert.equal(
      report.events.some((event) =>
        event.kind === "provider-status" && event.statusKind === "thread-rolled-back"
      ),
      true,
    );
    const visibleTurnKeys = new Set(report.turns.map((turn) => turn.turnKey));
    assert.equal(
      report.events.every((event) =>
        event.occurredTurnKey === null || visibleTurnKeys.has(event.occurredTurnKey)
      ),
      true,
    );
    const visibleEventKeys = new Set(report.events.map((event) => event.eventKey));
    assert.equal(
      report.turns.every((turn) =>
        turn.evidence.every((evidence) => visibleEventKeys.has(evidence.eventKey))
      ),
      true,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("classifies same-input Codex retries from real result exit codes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-analysis-retry-"));
  const sessionId = "cccccccc-dddd-4eee-8fff-000000000000";
  const file = path.join(directory, `rollout-${sessionId}.jsonl`);
  const records = [
    { type: "session_meta", payload: { id: sessionId } },
    { type: "event_msg", payload: { type: "task_started", turn_id: "turn-1" } },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Run the command" }],
      },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-1",
        name: "Bash",
        arguments: JSON.stringify({ command: "false" }),
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-1", output: "failed", exit_code: 1 },
    },
    {
      type: "response_item",
      payload: {
        type: "function_call",
        call_id: "call-2",
        name: "Bash",
        arguments: JSON.stringify({ command: "false" }),
      },
    },
    {
      type: "response_item",
      payload: { type: "function_call_output", call_id: "call-2", output: "ok", exit_code: 0 },
    },
    {
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Retried successfully" }],
      },
    },
    { type: "event_msg", payload: { type: "task_complete", turn_id: "turn-1" } },
  ];
  await writeFile(file, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
  try {
    const report = await analyzeSession("codex", file, {
      now: Date.now(),
      quiescenceSeconds: 60,
    });
    assert.equal(report.uses[0].executionState, "failed");
    assert.equal(report.uses[1].executionState, "completed");
    assert.deepEqual(report.uses[1].inputRelation, {
      kind: "retry-after-failure",
      previousUseKey: report.uses[0].useKey,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps open and rolled-back Turns out of aggregates and hides rollback in reports", () => {
  const facts = snapshot();
  facts.turns[0].providerVisibility = "rolled-back";
  const report = analyzeSessionFacts(facts, {
    now: 1_500,
    quiescenceSeconds: 60,
  });
  assert.equal(report.turns.length, 1);
  assert.equal(report.turns[0].turnKey, KEY.turn2);
  assert.equal(report.turns[0].closure.state, "open");
  assert.deepEqual(report.uses, []);
  assert.deepEqual(report.events, []);
  assert.deepEqual(report.capabilities, []);
  assert.equal(report.summary.aggregateEligible.turns, 0);
  assert.equal(report.summary.excluded.rolledBackTurns, 1);
  assert.equal(report.summary.excluded.rolledBackUses, 2);
  assert.equal(report.summary.excluded.openTurns, 1);
  const text = formatSessionAnalysisText(report);
  assert.doesNotMatch(text, /First question/u);
  assert.match(text, /Rolled-back Turns hidden: 1/u);
  assert.match(text, /Second question/u);
});

test("rejects clock and quiescence values that cannot be replayed deterministically", () => {
  assert.throws(() => analyzeSessionFacts(snapshot(), { now: -1 }), /now/u);
  assert.throws(
    () => analyzeSessionFacts(snapshot(), { now: 1_000, quiescenceSeconds: 59 }),
    /quiescenceSeconds/u,
  );
});

test("renders deterministically without mutating committed snapshot order", () => {
  const facts = snapshot();
  facts.turns.reverse();
  facts.sourceRecords.reverse();
  facts.evidenceEvents.reverse();
  facts.capabilityUses.reverse();
  facts.capabilityUseEvidence.reverse();
  const before = structuredClone(facts);
  const options = { now: 61_000, quiescenceSeconds: 60 };
  const first = formatSessionAnalysisJson(analyzeSessionFacts(facts, options));
  const second = formatSessionAnalysisJson(analyzeSessionFacts(facts, options));
  assert.equal(first, second);
  assert.deepEqual(facts, before);
  assert.equal(JSON.parse(first).turns[0].turnKey, KEY.turn1);
});

test("marks Engine failures separately from session resolution failures", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-analysis-engine-"));
  const sessionId = "aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee";
  const file = path.join(directory, `rollout-${sessionId}.jsonl`);
  await writeFile(file, [
    JSON.stringify({ type: "session_meta", payload: { id: sessionId } }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Analyze this" }],
      },
    }),
    JSON.stringify({
      type: "response_item",
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "Done" }],
      },
    }),
  ].join("\n") + "\n");
  try {
    const engine = {
      applySessionFacts() {
        const error = new Error("internal Engine invariant");
        error.code = "TS_INSIGHTS_TEST_FAILURE";
        throw error;
      },
      readCommittedSession() {
        return null;
      },
    };
    await assert.rejects(
      analyzeSession("codex", file, { engine }),
      (error) =>
        error?.code === "TS_INSIGHTS_TEST_FAILURE" &&
        error?.threadshareSessionFailureKind === "analysis_engine",
    );
    await assert.rejects(
      analyzeSession("codex", file, {
        readDelta() {
          throw new TypeError("invalid Adapter delta");
        },
      }),
      (error) =>
        error instanceof TypeError &&
        error?.threadshareSessionFailureKind === "analysis_engine",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
