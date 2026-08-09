import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";

import { createInMemoryInsightsEngine } from "../src/insights-reference-engine.mjs";
import { canonicalJson, hashKey } from "../src/session-facts.mjs";

const SESSION_ID = "11111111-1111-4111-8111-111111111111";
const ORIGIN_SECRET_EPOCH = "22222222-2222-4222-8222-222222222222";
const REPLACEMENT_ORIGIN_SECRET_EPOCH = "33333333-3333-4333-8333-333333333333";
const SESSION_KEY = hashKey("session", "codex", SESSION_ID);

function u64(value) {
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(BigInt(value));
  return bytes;
}

function i32(value) {
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
}

function u16(value) {
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function turnAt(offset, rawClosure = {}) {
  return {
    turnKey: hashKey("turn", Buffer.from(SESSION_KEY, "hex"), u64(offset)),
    ownerSessionKey: SESSION_KEY,
    turnStartOffset: String(offset),
    problemText: `Turn at ${offset}`,
    finalAnswerExcerpt: null,
    observedTimestamp: null,
    rawClosure: {
      nextUserBoundary: false,
      providerTerminal: null,
      observedEofClosed: false,
      ...rawClosure,
    },
    providerVisibility: "active",
    factTruncation: [],
  };
}

function recordAt(offset, providerRecordClass = "response_item:message") {
  return {
    sourceRecordKey: hashKey("source-record", Buffer.from(SESSION_KEY, "hex"), u64(offset)),
    ownerSessionKey: SESSION_KEY,
    startOffset: String(offset),
    endOffset: String(offset + 1),
    recordSha256: createHash("sha256").update(`record:${offset}`).digest("hex"),
    providerRecordClass,
  };
}

function eventAt(offset, eventOrdinal, occurredTurnKey, fields, providerRecordClass) {
  const sourceRecord = recordAt(offset, providerRecordClass);
  const contentIndex = -1;
  const event = {
    eventKey: hashKey(
      "event",
      Buffer.from(SESSION_KEY, "hex"),
      u64(offset),
      i32(contentIndex),
      u16(eventOrdinal),
    ),
    ownerSessionKey: SESSION_KEY,
    occurredTurnKey,
    sourceRecordKey: sourceRecord.sourceRecordKey,
    sourceOrder: {
      recordStartOffset: String(offset),
      contentIndex,
      eventOrdinal,
    },
    pointer: {
      pointerKind: `codex:${providerRecordClass}`,
      contentIndex,
      eventOrdinal,
    },
    originScope: "main",
    observedTimestamp: null,
    ...fields,
  };
  return { sourceRecord, event };
}

function toolCapability(name = "Read", provider = "codex") {
  return {
    capabilityKey: hashKey("capability", provider, "tool", name, Buffer.from([1])),
    provider,
    kind: "tool",
    canonicalName: name,
    identityVersion: 1,
  };
}

function correlatedUse(turn, capability, correlationDigest) {
  return {
    useKey: hashKey(
      "capability-use",
      Buffer.from(turn.turnKey, "hex"),
      Buffer.concat([Buffer.from([1]), Buffer.from(correlationDigest, "hex")]),
    ),
    ownerSessionKey: SESSION_KEY,
    turnKey: turn.turnKey,
    capabilityKey: capability.capabilityKey,
    turnOrdinal: 0,
    exactObservedName: capability.canonicalName,
    originScope: "main",
    providerTerminalState: "pending",
    strength: "observed",
    correlationDigest,
  };
}

function checkpoint(generation, completeOffset = "0") {
  return {
    completeOffset,
    eofObserved: true,
    partialTailLength: "0",
    partialTailDigest: "0".repeat(64),
    sourceSize: completeOffset,
    sourceMtimeNs: "0",
    sourceSnapshotStable: true,
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    generation,
    pendingState: {
      currentTurnKey: null,
      replayFromOffset: null,
      pendingStarted: [],
      pendingUses: [],
      sessionState: {
        sessionKey: SESSION_KEY,
        sessionScope: "main",
        eligibility: "eligible",
        originatorVersion: null,
        projectKey: null,
        observedStart: null,
        observedEnd: null,
        firstTurnKey: null,
        secondTurnKey: null,
        factTruncation: [],
        dedupe: null,
      },
      catalogEntries: [],
      seenClaudeUuids: [],
    },
  };
}

function finalizeDelta(delta) {
  const mutation = structuredClone(delta);
  delete mutation.deltaId;
  const mutationDigest = createHash("sha256").update(canonicalJson(mutation)).digest();
  delta.deltaId = hashKey(
    "delta",
    Buffer.from(delta.session.sessionKey, "hex"),
    delta.expectedGeneration,
    delta.mode,
    delta.originSecretEpoch,
    String(delta.duplicatePolicyVersion),
    mutationDigest,
    delta.checkpoint.completeOffset,
  );
  return delta;
}

function emptyDelta({
  expectedGeneration = "0",
  targetGeneration = String(BigInt(expectedGeneration) + 1n),
  completeOffset = targetGeneration,
  mode = "append",
} = {}) {
  return finalizeDelta({
    format: "session-facts-delta@v1",
    factSchemaVersion: 1,
    providerAdapterVersion: "codex@1",
    privacyPolicyVersion: 1,
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    duplicatePolicyVersion: 1,
    expectedGeneration,
    targetGeneration,
    mode,
    deltaId: "0".repeat(64),
    session: {
      sessionKey: SESSION_KEY,
      provider: "codex",
      sessionScope: "main",
      eligibility: "eligible",
      duplicateGroupKey: null,
      duplicatePolicyVersion: 1,
    },
    retractions: {
      turnKeys: [],
      orphanEventKeys: [],
      authoritativeTurnKeys: [],
    },
    turns: [],
    sourceRecords: [],
    evidenceEvents: [],
    turnEvidence: [],
    capabilities: [],
    capabilityUses: [],
    capabilityUseEvidence: [],
    checkpoint: checkpoint(targetGeneration, completeOffset),
    diagnostics: [],
    coverage: {},
  });
}

function logicalFacts(snapshot) {
  const { snapshotSeq: _snapshotSeq, checkpoint: _checkpoint, ...facts } = snapshot;
  return facts;
}

test("commits one generation, replays the same delta idempotently, and rejects stale CAS", () => {
  const engine = createInMemoryInsightsEngine();
  const first = emptyDelta();

  assert.deepEqual(engine.applySessionFacts(first), {
    snapshotSeq: 1,
    sessionKey: SESSION_KEY,
    idempotent: false,
  });
  assert.deepEqual(engine.readCommittedSession(SESSION_KEY), {
    snapshotSeq: 1,
    factSchemaVersion: 1,
    session: first.session,
    checkpoint: first.checkpoint,
    turns: [],
    sourceRecords: [],
    evidenceEvents: [],
    turnEvidence: [],
    capabilities: [],
    capabilityUses: [],
    capabilityUseEvidence: [],
    diagnostics: [],
    coverage: {},
  });
  assert.deepEqual(engine.applySessionFacts(first), {
    snapshotSeq: 1,
    sessionKey: SESSION_KEY,
    idempotent: true,
  });

  const stale = emptyDelta({ completeOffset: "2" });
  assert.throws(
    () => engine.applySessionFacts(stale),
    (error) => error?.code === "TS_INSIGHTS_GENERATION_CONFLICT",
  );
  assert.equal(engine.readCommittedSession(SESSION_KEY).snapshotSeq, 1);
});

test("rejects origin-secret epoch changes on append but accepts an atomic replacement", () => {
  const engine = createInMemoryInsightsEngine();
  engine.applySessionFacts(emptyDelta());
  const before = canonicalJson(engine.readCommittedSession(SESSION_KEY));

  const mixedEpoch = emptyDelta({ expectedGeneration: "1" });
  mixedEpoch.originSecretEpoch = REPLACEMENT_ORIGIN_SECRET_EPOCH;
  mixedEpoch.checkpoint.originSecretEpoch = REPLACEMENT_ORIGIN_SECRET_EPOCH;
  finalizeDelta(mixedEpoch);
  assert.throws(
    () => engine.applySessionFacts(mixedEpoch),
    (error) => error?.code === "TS_INSIGHTS_INVALID_ORIGIN_EPOCH",
  );
  assert.equal(canonicalJson(engine.readCommittedSession(SESSION_KEY)), before);

  const replacement = emptyDelta({ expectedGeneration: "1", mode: "replace-session" });
  replacement.originSecretEpoch = REPLACEMENT_ORIGIN_SECRET_EPOCH;
  replacement.checkpoint.originSecretEpoch = REPLACEMENT_ORIGIN_SECRET_EPOCH;
  finalizeDelta(replacement);
  assert.deepEqual(engine.applySessionFacts(replacement), {
    snapshotSeq: 2,
    sessionKey: SESSION_KEY,
    idempotent: false,
  });
  const committed = engine.readCommittedSession(SESSION_KEY);
  assert.equal(committed.factSchemaVersion, 1);
  assert.equal(committed.checkpoint.originSecretEpoch, REPLACEMENT_ORIGIN_SECRET_EPOCH);
});

test("reconciles authoritative Turn roots while preserving unrelated append facts and collecting garbage", () => {
  const engine = createInMemoryInsightsEngine();
  const turn = turnAt(10);
  const boundary = eventAt(
    10,
    0,
    turn.turnKey,
    { kind: "visible-message", role: "user" },
    "response_item:message",
  );
  const capability = toolCapability();
  const correlationDigest = hashKey(
    "provider-correlation",
    Buffer.from(SESSION_KEY, "hex"),
    "call-1",
  );
  const invocation = eventAt(
    20,
    0,
    turn.turnKey,
    { kind: "capability-invocation", capabilityKey: capability.capabilityKey, correlationDigest },
    "response_item:function_call",
  );
  const use = correlatedUse(turn, capability, correlationDigest);
  const orphan = eventAt(
    30,
    0,
    null,
    {
      kind: "provider-status",
      statusKind: "inline-subagent-activity",
      providerState: "observed",
    },
    "event_msg:inline_subagent_activity",
  );
  const first = emptyDelta();
  first.turns = [turn];
  first.sourceRecords = [boundary.sourceRecord, invocation.sourceRecord, orphan.sourceRecord];
  first.evidenceEvents = [boundary.event, invocation.event, orphan.event];
  first.turnEvidence = [{
    ownerSessionKey: SESSION_KEY,
    turnKey: turn.turnKey,
    eventKey: boundary.event.eventKey,
    role: "boundary",
  }];
  first.capabilities = [capability];
  first.capabilityUses = [use];
  first.capabilityUseEvidence = [{
    ownerSessionKey: SESSION_KEY,
    useKey: use.useKey,
    eventKey: invocation.event.eventKey,
    role: "invocation",
  }];
  first.retractions.authoritativeTurnKeys = [turn.turnKey];
  first.checkpoint.pendingState.currentTurnKey = turn.turnKey;
  first.checkpoint.pendingState.sessionState.firstTurnKey = turn.turnKey;
  finalizeDelta(first);
  engine.applySessionFacts(first);

  const second = emptyDelta({ expectedGeneration: "1" });
  second.turns = [turn];
  second.sourceRecords = [boundary.sourceRecord];
  second.evidenceEvents = [boundary.event];
  second.turnEvidence = [first.turnEvidence[0]];
  second.retractions.authoritativeTurnKeys = [turn.turnKey];
  second.checkpoint.pendingState.currentTurnKey = turn.turnKey;
  second.checkpoint.pendingState.sessionState.firstTurnKey = turn.turnKey;
  finalizeDelta(second);
  engine.applySessionFacts(second);

  const reconciled = engine.readCommittedSession(SESSION_KEY);
  assert.deepEqual(reconciled.evidenceEvents.map((event) => event.eventKey).sort(), [
    boundary.event.eventKey,
    orphan.event.eventKey,
  ].sort());
  assert.deepEqual(reconciled.sourceRecords.map((record) => record.sourceRecordKey).sort(), [
    boundary.sourceRecord.sourceRecordKey,
    orphan.sourceRecord.sourceRecordKey,
  ].sort());
  assert.deepEqual(reconciled.capabilityUses, []);
  assert.deepEqual(reconciled.capabilities, []);

  const retractOrphan = emptyDelta({ expectedGeneration: "2" });
  retractOrphan.retractions.orphanEventKeys = [orphan.event.eventKey];
  finalizeDelta(retractOrphan);
  engine.applySessionFacts(retractOrphan);
  assert.deepEqual(
    engine.readCommittedSession(SESSION_KEY).sourceRecords.map((record) => record.sourceRecordKey),
    [boundary.sourceRecord.sourceRecordKey],
  );

  const retractTurn = emptyDelta({ expectedGeneration: "3" });
  retractTurn.retractions.turnKeys = [turn.turnKey];
  finalizeDelta(retractTurn);
  engine.applySessionFacts(retractTurn);
  const empty = engine.readCommittedSession(SESSION_KEY);
  assert.deepEqual(empty.turns, []);
  assert.deepEqual(empty.sourceRecords, []);
  assert.deepEqual(empty.evidenceEvents, []);
  assert.deepEqual(empty.turnEvidence, []);
});

test("keeps checkpoint-referenced Capabilities until pending state releases them", () => {
  const engine = createInMemoryInsightsEngine();
  const capability = toolCapability();
  const first = emptyDelta();
  first.capabilities = [capability];
  first.checkpoint.pendingState.pendingUses = [{
    correlationDigest: "a".repeat(64),
    useKey: null,
    capabilityKey: capability.capabilityKey,
  }];
  finalizeDelta(first);
  engine.applySessionFacts(first);
  assert.deepEqual(engine.readCommittedSession(SESSION_KEY).capabilities, [capability]);

  const released = emptyDelta({ expectedGeneration: "1" });
  engine.applySessionFacts(released);
  assert.deepEqual(engine.readCommittedSession(SESSION_KEY).capabilities, []);
});

test("derives duplicate groups and rejects untrusted or dangling dedupe identity", () => {
  const fingerprint = "d".repeat(64);
  const dedupe = {
    dedupeFingerprint: fingerprint,
    duplicateMethod: "explicit-lineage",
    duplicateConfidence: "strong",
    dedupeClosure: "hard-sealed",
    dedupeEvidenceEventKeys: [],
  };
  const engine = createInMemoryInsightsEngine();
  const valid = emptyDelta();
  Object.assign(valid.session, { duplicateGroupKey: null, ...dedupe });
  valid.checkpoint.pendingState.sessionState.dedupe = structuredClone(dedupe);
  finalizeDelta(valid);
  engine.applySessionFacts(valid);
  assert.equal(
    engine.readCommittedSession(SESSION_KEY).session.duplicateGroupKey,
    hashKey("duplicate-group", "codex", Buffer.from(fingerprint, "hex")),
  );

  const untrusted = emptyDelta();
  Object.assign(untrusted.session, {
    duplicateGroupKey: "e".repeat(64),
    ...dedupe,
  });
  untrusted.checkpoint.pendingState.sessionState.dedupe = structuredClone(dedupe);
  finalizeDelta(untrusted);
  assert.throws(
    () => createInMemoryInsightsEngine().applySessionFacts(untrusted),
    (error) => error?.code === "TS_INSIGHTS_DEDUPE_AUTHORITY",
  );

  const dangling = emptyDelta();
  const danglingDedupe = {
    ...dedupe,
    dedupeEvidenceEventKeys: ["f".repeat(64)],
  };
  Object.assign(dangling.session, { duplicateGroupKey: null, ...danglingDedupe });
  dangling.checkpoint.pendingState.sessionState.dedupe = structuredClone(danglingDedupe);
  finalizeDelta(dangling);
  assert.throws(
    () => createInMemoryInsightsEngine().applySessionFacts(dangling),
    (error) => error?.code === "TS_INSIGHTS_FOREIGN_KEY",
  );
});

test("rejects checkpoint Capability references from another provider", () => {
  const engine = createInMemoryInsightsEngine();
  const claudeSessionKey = hashKey(
    "session",
    "claude",
    "99999999-9999-4999-8999-999999999999",
  );
  const capability = toolCapability("Read", "claude");
  const claude = emptyDelta();
  claude.providerAdapterVersion = "claude@1";
  claude.session.sessionKey = claudeSessionKey;
  claude.session.provider = "claude";
  claude.checkpoint.pendingState.sessionState.sessionKey = claudeSessionKey;
  claude.capabilities = [capability];
  claude.checkpoint.pendingState.pendingUses = [{
    correlationDigest: "a".repeat(64),
    useKey: null,
    capabilityKey: capability.capabilityKey,
  }];
  finalizeDelta(claude);
  engine.applySessionFacts(claude);

  const codex = emptyDelta();
  codex.checkpoint.pendingState.pendingUses = [{
    correlationDigest: "b".repeat(64),
    useKey: null,
    capabilityKey: capability.capabilityKey,
  }];
  finalizeDelta(codex);
  assert.throws(
    () => engine.applySessionFacts(codex),
    (error) => error?.code === "TS_INSIGHTS_FOREIGN_KEY",
  );
});

test("rejects owner, stable-key, and foreign-key violations without contaminating committed state", () => {
  const engine = createInMemoryInsightsEngine();
  const turn = turnAt(10);
  const boundary = eventAt(
    10,
    0,
    turn.turnKey,
    { kind: "visible-message", role: "user" },
    "response_item:message",
  );
  const initial = emptyDelta();
  initial.turns = [turn];
  initial.sourceRecords = [boundary.sourceRecord];
  initial.evidenceEvents = [boundary.event];
  initial.turnEvidence = [{
    ownerSessionKey: SESSION_KEY,
    turnKey: turn.turnKey,
    eventKey: boundary.event.eventKey,
    role: "boundary",
  }];
  initial.retractions.authoritativeTurnKeys = [turn.turnKey];
  finalizeDelta(initial);
  engine.applySessionFacts(initial);
  const before = canonicalJson(engine.readCommittedSession(SESSION_KEY));

  const wrongOwner = emptyDelta({ expectedGeneration: "1" });
  wrongOwner.turns = [{ ...turn, ownerSessionKey: "f".repeat(64) }];
  wrongOwner.retractions.authoritativeTurnKeys = [turn.turnKey];
  finalizeDelta(wrongOwner);
  assert.throws(
    () => engine.applySessionFacts(wrongOwner),
    (error) => error?.code === "TS_INSIGHTS_OWNER_MISMATCH",
  );
  assert.equal(canonicalJson(engine.readCommittedSession(SESSION_KEY)), before);

  const invalidTurnKey = `${turn.turnKey.slice(0, -1)}${turn.turnKey.endsWith("0") ? "1" : "0"}`;
  const wrongStableKey = emptyDelta({ expectedGeneration: "1", completeOffset: "2" });
  wrongStableKey.turns = [{ ...turn, turnKey: invalidTurnKey }];
  wrongStableKey.retractions.authoritativeTurnKeys = [invalidTurnKey];
  finalizeDelta(wrongStableKey);
  assert.throws(
    () => engine.applySessionFacts(wrongStableKey),
    (error) => error?.code === "TS_INSIGHTS_INVALID_STABLE_KEY",
  );
  assert.equal(canonicalJson(engine.readCommittedSession(SESSION_KEY)), before);

  const danglingEvent = eventAt(
    20,
    0,
    turn.turnKey,
    { kind: "visible-message", role: "assistant" },
    "response_item:message",
  ).event;
  danglingEvent.sourceRecordKey = "e".repeat(64);
  const missingForeignKey = emptyDelta({ expectedGeneration: "1", completeOffset: "3" });
  missingForeignKey.evidenceEvents = [danglingEvent];
  finalizeDelta(missingForeignKey);
  assert.throws(
    () => engine.applySessionFacts(missingForeignKey),
    (error) => error?.code === "TS_INSIGHTS_FOREIGN_KEY",
  );
  assert.equal(canonicalJson(engine.readCommittedSession(SESSION_KEY)), before);
});

test("revisions cover linked lifecycle and follow-up facts without importing cross-Turn attributes", () => {
  const engine = createInMemoryInsightsEngine();
  const firstTurn = turnAt(10);
  const firstBoundary = eventAt(
    10,
    0,
    firstTurn.turnKey,
    { kind: "visible-message", role: "user" },
    "response_item:message",
  );
  const initial = emptyDelta();
  initial.turns = [firstTurn];
  initial.sourceRecords = [firstBoundary.sourceRecord];
  initial.evidenceEvents = [firstBoundary.event];
  initial.turnEvidence = [{
    ownerSessionKey: SESSION_KEY,
    turnKey: firstTurn.turnKey,
    eventKey: firstBoundary.event.eventKey,
    role: "boundary",
  }];
  finalizeDelta(initial);
  engine.applySessionFacts(initial);
  const initialRevision = engine.readCommittedSession(SESSION_KEY).turns[0].revision;

  const terminal = eventAt(
    20,
    0,
    null,
    { kind: "turn-lifecycle", lifecycleState: "completed" },
    "event_msg:task_complete",
  );
  const addTerminal = emptyDelta({ expectedGeneration: "1" });
  addTerminal.sourceRecords = [terminal.sourceRecord];
  addTerminal.evidenceEvents = [terminal.event];
  addTerminal.turnEvidence = [{
    ownerSessionKey: SESSION_KEY,
    turnKey: firstTurn.turnKey,
    eventKey: terminal.event.eventKey,
    role: "lifecycle",
  }];
  finalizeDelta(addTerminal);
  engine.applySessionFacts(addTerminal);
  const terminalRevision = engine.readCommittedSession(SESSION_KEY).turns[0].revision;
  assert.notEqual(terminalRevision, initialRevision);

  const laterStarted = eventAt(
    30,
    0,
    null,
    { kind: "turn-lifecycle", lifecycleState: "started" },
    "event_msg:task_started",
  );
  const addUnrelatedStarted = emptyDelta({ expectedGeneration: "2" });
  addUnrelatedStarted.sourceRecords = [laterStarted.sourceRecord];
  addUnrelatedStarted.evidenceEvents = [laterStarted.event];
  finalizeDelta(addUnrelatedStarted);
  engine.applySessionFacts(addUnrelatedStarted);
  assert.equal(engine.readCommittedSession(SESSION_KEY).turns[0].revision, terminalRevision);

  const secondTurn = turnAt(40);
  const secondBoundary = eventAt(
    40,
    0,
    secondTurn.turnKey,
    { kind: "visible-message", role: "user" },
    "response_item:message",
  );
  const addFollowUp = emptyDelta({ expectedGeneration: "3" });
  addFollowUp.turns = [secondTurn];
  addFollowUp.sourceRecords = [secondBoundary.sourceRecord];
  addFollowUp.evidenceEvents = [secondBoundary.event];
  addFollowUp.turnEvidence = [
    {
      ownerSessionKey: SESSION_KEY,
      turnKey: secondTurn.turnKey,
      eventKey: secondBoundary.event.eventKey,
      role: "boundary",
    },
    {
      ownerSessionKey: SESSION_KEY,
      turnKey: firstTurn.turnKey,
      eventKey: secondBoundary.event.eventKey,
      role: "follow-up",
    },
  ];
  finalizeDelta(addFollowUp);
  engine.applySessionFacts(addFollowUp);
  const afterFollowUp = engine.readCommittedSession(SESSION_KEY);
  const followedRevision = afterFollowUp.turns.find((turn) =>
    turn.turnKey === firstTurn.turnKey
  ).revision;
  const secondRevision = afterFollowUp.turns.find((turn) =>
    turn.turnKey === secondTurn.turnKey
  ).revision;
  assert.notEqual(followedRevision, terminalRevision);

  const updateCrossTurnEvent = emptyDelta({ expectedGeneration: "4" });
  updateCrossTurnEvent.evidenceEvents = [{
    ...secondBoundary.event,
    observedTimestamp: "2026-08-10T00:00:00.000Z",
  }];
  finalizeDelta(updateCrossTurnEvent);
  engine.applySessionFacts(updateCrossTurnEvent);
  const afterCrossTurnUpdate = engine.readCommittedSession(SESSION_KEY);
  assert.equal(
    afterCrossTurnUpdate.turns.find((turn) => turn.turnKey === firstTurn.turnKey).revision,
    followedRevision,
  );
  assert.notEqual(
    afterCrossTurnUpdate.turns.find((turn) => turn.turnKey === secondTurn.turnKey).revision,
    secondRevision,
  );
});

test("replays consecutive rollback Events, includes aborted Turns, excludes open Turns, and restores retractions", () => {
  const engine = createInMemoryInsightsEngine();
  const firstTurn = turnAt(10, { nextUserBoundary: true });
  const secondTurn = turnAt(20, { nextUserBoundary: true });
  const abortedTurn = turnAt(30, { providerTerminal: "aborted" });
  const openTurn = turnAt(40);
  const firstBoundary = eventAt(10, 0, firstTurn.turnKey, {
    kind: "visible-message",
    role: "user",
  }, "response_item:message");
  const secondBoundary = eventAt(20, 0, secondTurn.turnKey, {
    kind: "visible-message",
    role: "user",
  }, "response_item:message");
  const abortedBoundary = eventAt(30, 0, abortedTurn.turnKey, {
    kind: "visible-message",
    role: "user",
  }, "response_item:message");
  const terminal = eventAt(35, 0, null, {
    kind: "turn-lifecycle",
    lifecycleState: "aborted",
  }, "event_msg:turn_aborted");
  const openBoundary = eventAt(40, 0, openTurn.turnKey, {
    kind: "visible-message",
    role: "user",
  }, "response_item:message");
  const initial = emptyDelta();
  initial.turns = [firstTurn, secondTurn, abortedTurn, openTurn];
  initial.sourceRecords = [
    firstBoundary.sourceRecord,
    secondBoundary.sourceRecord,
    abortedBoundary.sourceRecord,
    terminal.sourceRecord,
    openBoundary.sourceRecord,
  ];
  initial.evidenceEvents = [
    firstBoundary.event,
    secondBoundary.event,
    abortedBoundary.event,
    terminal.event,
    openBoundary.event,
  ];
  initial.turnEvidence = [
    ...[
      [firstTurn, firstBoundary],
      [secondTurn, secondBoundary],
      [abortedTurn, abortedBoundary],
      [openTurn, openBoundary],
    ].map(([turn, boundary]) => ({
      ownerSessionKey: SESSION_KEY,
      turnKey: turn.turnKey,
      eventKey: boundary.event.eventKey,
      role: "boundary",
    })),
    {
      ownerSessionKey: SESSION_KEY,
      turnKey: firstTurn.turnKey,
      eventKey: secondBoundary.event.eventKey,
      role: "follow-up",
    },
    {
      ownerSessionKey: SESSION_KEY,
      turnKey: secondTurn.turnKey,
      eventKey: abortedBoundary.event.eventKey,
      role: "follow-up",
    },
    {
      ownerSessionKey: SESSION_KEY,
      turnKey: abortedTurn.turnKey,
      eventKey: terminal.event.eventKey,
      role: "lifecycle",
    },
  ];
  finalizeDelta(initial);
  engine.applySessionFacts(initial);
  const baseRevisions = new Map(
    engine.readCommittedSession(SESSION_KEY).turns.map((turn) => [turn.turnKey, turn.revision]),
  );

  const rollbackTwo = eventAt(50, 0, null, {
    kind: "provider-status",
    statusKind: "thread-rolled-back",
    providerState: "observed",
    rolledBackTurnCount: "2",
  }, "event_msg:thread_rolled_back");
  const firstRollback = emptyDelta({ expectedGeneration: "1" });
  firstRollback.sourceRecords = [rollbackTwo.sourceRecord];
  firstRollback.evidenceEvents = [rollbackTwo.event];
  finalizeDelta(firstRollback);
  engine.applySessionFacts(firstRollback);
  const afterFirst = engine.readCommittedSession(SESSION_KEY);
  assert.deepEqual(
    Object.fromEntries(afterFirst.turns.map((turn) => [turn.turnStartOffset, turn.effectiveVisibility])),
    { 10: "active", 20: "rolled-back", 30: "rolled-back", 40: "active" },
  );
  assert.deepEqual(
    afterFirst.turnEvidence.filter((link) => link.role === "rollback").map((link) => link.turnKey).sort(),
    [secondTurn.turnKey, abortedTurn.turnKey].sort(),
  );
  assert.equal(
    afterFirst.turns.find((turn) => turn.turnKey === openTurn.turnKey).revision,
    baseRevisions.get(openTurn.turnKey),
  );

  const rollbackOne = eventAt(60, 0, null, {
    kind: "provider-status",
    statusKind: "thread-rolled-back",
    providerState: "observed",
    rolledBackTurnCount: "1",
  }, "event_msg:thread_rolled_back");
  const secondRollback = emptyDelta({ expectedGeneration: "2" });
  secondRollback.sourceRecords = [rollbackOne.sourceRecord];
  secondRollback.evidenceEvents = [rollbackOne.event];
  finalizeDelta(secondRollback);
  engine.applySessionFacts(secondRollback);
  const afterSecond = engine.readCommittedSession(SESSION_KEY);
  assert.equal(
    afterSecond.turns.find((turn) => turn.turnKey === firstTurn.turnKey).effectiveVisibility,
    "rolled-back",
  );
  assert.equal(afterSecond.turnEvidence.filter((link) => link.role === "rollback").length, 3);

  const retractSecond = emptyDelta({ expectedGeneration: "3" });
  retractSecond.retractions.orphanEventKeys = [rollbackOne.event.eventKey];
  finalizeDelta(retractSecond);
  engine.applySessionFacts(retractSecond);
  const restoredFirst = engine.readCommittedSession(SESSION_KEY);
  assert.equal(
    restoredFirst.turns.find((turn) => turn.turnKey === firstTurn.turnKey).effectiveVisibility,
    "active",
  );
  assert.equal(
    restoredFirst.turns.find((turn) => turn.turnKey === firstTurn.turnKey).revision,
    baseRevisions.get(firstTurn.turnKey),
  );

  const retractFirst = emptyDelta({ expectedGeneration: "4" });
  retractFirst.retractions.orphanEventKeys = [rollbackTwo.event.eventKey];
  finalizeDelta(retractFirst);
  engine.applySessionFacts(retractFirst);
  const restoredAll = engine.readCommittedSession(SESSION_KEY);
  assert.equal(restoredAll.turns.every((turn) => turn.effectiveVisibility === "active"), true);
  assert.deepEqual(restoredAll.turnEvidence.filter((link) => link.role === "rollback"), []);
  assert.deepEqual(
    new Map(restoredAll.turns.map((turn) => [turn.turnKey, turn.revision])),
    baseRevisions,
  );
});

test("keeps rollback replay atomic when truncation, invalid counts, or target shortage make it unresolved", () => {
  const engine = createInMemoryInsightsEngine();
  const sealedTurn = turnAt(10, { nextUserBoundary: true });
  sealedTurn.factTruncation = ["events"];
  const openTurn = turnAt(20);
  const sealedBoundary = eventAt(10, 0, sealedTurn.turnKey, {
    kind: "visible-message",
    role: "user",
  }, "response_item:message");
  const openBoundary = eventAt(20, 0, openTurn.turnKey, {
    kind: "visible-message",
    role: "user",
  }, "response_item:message");
  const rollback = eventAt(30, 0, null, {
    kind: "provider-status",
    statusKind: "thread-rolled-back",
    providerState: "observed",
    rolledBackTurnCount: "1",
  }, "event_msg:thread_rolled_back");
  const initial = emptyDelta();
  initial.turns = [sealedTurn, openTurn];
  initial.sourceRecords = [sealedBoundary.sourceRecord, openBoundary.sourceRecord, rollback.sourceRecord];
  initial.evidenceEvents = [sealedBoundary.event, openBoundary.event, rollback.event];
  initial.turnEvidence = [
    {
      ownerSessionKey: SESSION_KEY,
      turnKey: sealedTurn.turnKey,
      eventKey: sealedBoundary.event.eventKey,
      role: "boundary",
    },
    {
      ownerSessionKey: SESSION_KEY,
      turnKey: openTurn.turnKey,
      eventKey: openBoundary.event.eventKey,
      role: "boundary",
    },
    {
      ownerSessionKey: SESSION_KEY,
      turnKey: sealedTurn.turnKey,
      eventKey: openBoundary.event.eventKey,
      role: "follow-up",
    },
  ];
  finalizeDelta(initial);
  engine.applySessionFacts(initial);
  const unresolved = engine.readCommittedSession(SESSION_KEY);
  assert.equal(unresolved.turns.every((turn) => turn.effectiveVisibility === "active"), true);
  assert.deepEqual(unresolved.turnEvidence.filter((link) => link.role === "rollback"), []);
  assert.equal(unresolved.coverage["rollback-unresolved"], 1);
  assert.equal(unresolved.diagnostics.some((item) => item.code === "rollback-unresolved"), true);

  const completeFacts = emptyDelta({ expectedGeneration: "1" });
  completeFacts.turns = [{ ...sealedTurn, factTruncation: [] }];
  finalizeDelta(completeFacts);
  engine.applySessionFacts(completeFacts);
  const resolved = engine.readCommittedSession(SESSION_KEY);
  assert.equal(
    resolved.turns.find((turn) => turn.turnKey === sealedTurn.turnKey).effectiveVisibility,
    "rolled-back",
  );
  assert.equal(resolved.coverage["rollback-unresolved"], undefined);

  const invalid = eventAt(40, 0, null, {
    kind: "provider-status",
    statusKind: "thread-rolled-back",
    providerState: "invalid",
    rolledBackTurnCount: null,
  }, "event_msg:thread_rolled_back");
  const shortage = eventAt(50, 0, null, {
    kind: "provider-status",
    statusKind: "thread-rolled-back",
    providerState: "observed",
    rolledBackTurnCount: "1",
  }, "event_msg:thread_rolled_back");
  const addUnresolved = emptyDelta({ expectedGeneration: "2" });
  addUnresolved.sourceRecords = [invalid.sourceRecord, shortage.sourceRecord];
  addUnresolved.evidenceEvents = [invalid.event, shortage.event];
  finalizeDelta(addUnresolved);
  engine.applySessionFacts(addUnresolved);
  const retained = engine.readCommittedSession(SESSION_KEY);
  assert.equal(retained.coverage["rollback-unresolved"], 2);
  assert.equal(retained.evidenceEvents.some((event) => event.eventKey === invalid.event.eventKey), true);
  assert.equal(retained.evidenceEvents.some((event) => event.eventKey === shortage.event.eventKey), true);
  assert.equal(retained.turnEvidence.filter((link) => link.role === "rollback").length, 1);
});

test("produces equivalent logical Facts for incremental ingestion and replace-session rebuilds", () => {
  const sealedTurn = turnAt(10, { nextUserBoundary: true });
  const openTurn = turnAt(20);
  const firstBoundary = eventAt(10, 0, sealedTurn.turnKey, {
    kind: "visible-message",
    role: "user",
  }, "response_item:message");
  const secondBoundary = eventAt(20, 0, openTurn.turnKey, {
    kind: "visible-message",
    role: "user",
  }, "response_item:message");
  const rollback = eventAt(30, 0, null, {
    kind: "provider-status",
    statusKind: "thread-rolled-back",
    providerState: "observed",
    rolledBackTurnCount: "1",
  }, "event_msg:thread_rolled_back");
  const facts = {
    turns: [sealedTurn, openTurn],
    sourceRecords: [firstBoundary.sourceRecord, secondBoundary.sourceRecord, rollback.sourceRecord],
    evidenceEvents: [firstBoundary.event, secondBoundary.event, rollback.event],
    turnEvidence: [
      {
        ownerSessionKey: SESSION_KEY,
        turnKey: sealedTurn.turnKey,
        eventKey: firstBoundary.event.eventKey,
        role: "boundary",
      },
      {
        ownerSessionKey: SESSION_KEY,
        turnKey: openTurn.turnKey,
        eventKey: secondBoundary.event.eventKey,
        role: "boundary",
      },
      {
        ownerSessionKey: SESSION_KEY,
        turnKey: sealedTurn.turnKey,
        eventKey: secondBoundary.event.eventKey,
        role: "follow-up",
      },
    ],
  };

  const incremental = createInMemoryInsightsEngine();
  const first = emptyDelta();
  first.turns = facts.turns;
  first.sourceRecords = facts.sourceRecords.slice(0, 2);
  first.evidenceEvents = facts.evidenceEvents.slice(0, 2);
  first.turnEvidence = facts.turnEvidence;
  finalizeDelta(first);
  incremental.applySessionFacts(first);
  const second = emptyDelta({ expectedGeneration: "1" });
  second.sourceRecords = [rollback.sourceRecord];
  second.evidenceEvents = [rollback.event];
  finalizeDelta(second);
  incremental.applySessionFacts(second);
  const incrementalFacts = logicalFacts(incremental.readCommittedSession(SESSION_KEY));

  const rebuilt = createInMemoryInsightsEngine();
  const clean = emptyDelta({ mode: "replace-session" });
  Object.assign(clean, facts);
  finalizeDelta(clean);
  rebuilt.applySessionFacts(clean);
  assert.deepEqual(logicalFacts(rebuilt.readCommittedSession(SESSION_KEY)), incrementalFacts);

  const replaceExisting = emptyDelta({ expectedGeneration: "2", mode: "replace-session" });
  Object.assign(replaceExisting, facts);
  finalizeDelta(replaceExisting);
  incremental.applySessionFacts(replaceExisting);
  assert.deepEqual(logicalFacts(incremental.readCommittedSession(SESSION_KEY)), incrementalFacts);
});
