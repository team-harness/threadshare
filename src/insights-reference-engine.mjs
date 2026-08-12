import { createHash } from "node:crypto";

import {
  assertSessionFactsDelta,
  assertSessionFactsDeltaV2,
  canonicalJson,
  hashKey,
} from "./session-facts.mjs";

function engineError(code, message, ErrorType = TypeError) {
  const error = new ErrorType(message);
  error.code = code;
  return error;
}

function verifyDeltaIdentity(delta) {
  const mutation = structuredClone(delta);
  delete mutation.deltaId;
  const mutationDigest = createHash("sha256").update(canonicalJson(mutation)).digest();
  const expected = hashKey(
    "delta",
    Buffer.from(delta.session.sessionKey, "hex"),
    delta.expectedGeneration,
    delta.mode,
    delta.originSecretEpoch,
    String(delta.duplicatePolicyVersion),
    mutationDigest,
    delta.checkpoint.completeOffset,
  );
  if (delta.deltaId !== expected) {
    throw engineError("TS_INSIGHTS_INVALID_DELTA_ID", "deltaId does not match its canonical mutation");
  }
}

function validateCommitEnvelope(delta) {
  try {
    if (delta?.factSchemaVersion === 2) assertSessionFactsDeltaV2(delta);
    else assertSessionFactsDelta(delta);
  } catch (cause) {
    const error = engineError("TS_INSIGHTS_INVALID_DELTA", cause.message);
    error.cause = cause;
    throw error;
  }
  verifyDeltaIdentity(delta);
  if (BigInt(delta.targetGeneration) !== BigInt(delta.expectedGeneration) + 1n) {
    throw engineError(
      "TS_INSIGHTS_INVALID_GENERATION",
      "targetGeneration must immediately follow expectedGeneration",
    );
  }
  if (delta.checkpoint.generation !== delta.targetGeneration) {
    throw engineError(
      "TS_INSIGHTS_INVALID_GENERATION",
      "checkpoint generation must equal targetGeneration",
    );
  }
  if (
    delta.checkpoint.originSecretEpoch.toLowerCase() !==
    delta.originSecretEpoch.toLowerCase()
  ) {
    throw engineError(
      "TS_INSIGHTS_INVALID_ORIGIN_EPOCH",
      "checkpoint and delta origin secret epochs differ",
    );
  }
}

function hexBytes(value) {
  return Buffer.from(value, "hex");
}

function uint64(value, label) {
  const number = BigInt(value);
  if (number < 0n || number > 0xffff_ffff_ffff_ffffn) {
    throw engineError("TS_INSIGHTS_INVALID_STABLE_KEY", `${label} is outside u64 range`);
  }
  const bytes = Buffer.alloc(8);
  bytes.writeBigUInt64BE(number);
  return bytes;
}

function int32(value, label) {
  if (!Number.isInteger(value) || value < -0x8000_0000 || value > 0x7fff_ffff) {
    throw engineError("TS_INSIGHTS_INVALID_STABLE_KEY", `${label} is outside i32 range`);
  }
  const bytes = Buffer.alloc(4);
  bytes.writeInt32BE(value);
  return bytes;
}

function uint16(value, label) {
  if (!Number.isInteger(value) || value < 0 || value > 0xffff) {
    throw engineError("TS_INSIGHTS_INVALID_STABLE_KEY", `${label} is outside u16 range`);
  }
  const bytes = Buffer.alloc(2);
  bytes.writeUInt16BE(value);
  return bytes;
}

function assertStableKey(actual, expected, label) {
  if (actual !== expected) {
    throw engineError("TS_INSIGHTS_INVALID_STABLE_KEY", `${label} does not match its Fact identity`);
  }
}

function assertUnique(values, key, label) {
  const seen = new Set();
  for (const value of values) {
    const identity = key(value);
    if (seen.has(identity)) {
      throw engineError("TS_INSIGHTS_DUPLICATE_FACT", `${label} contains duplicate ${identity}`);
    }
    seen.add(identity);
  }
}

function assertOwned(ownerSessionKey, sessionKey, label) {
  if (ownerSessionKey !== sessionKey) {
    throw engineError("TS_INSIGHTS_OWNER_MISMATCH", `${label} belongs to another session`);
  }
}

function findFactOwner(state, collection, key) {
  for (const [sessionKey, sessionState] of state.sessions) {
    if (sessionState[collection].has(key)) return sessionKey;
  }
  return null;
}

function duplicateGroupKey(session) {
  return session.dedupeFingerprint
    ? hashKey("duplicate-group", session.provider, hexBytes(session.dedupeFingerprint))
    : null;
}

function validateIncomingSemantics(state, delta) {
  const sessionKey = delta.session.sessionKey;
  const current = state.sessions.get(sessionKey);
  if (current?.session && current.session.provider !== delta.session.provider) {
    throw engineError("TS_INSIGHTS_OWNER_MISMATCH", "session provider cannot change");
  }
  if (
    current?.checkpoint &&
    delta.mode === "append" &&
    current.checkpoint.originSecretEpoch.toLowerCase() !== delta.originSecretEpoch.toLowerCase()
  ) {
    throw engineError(
      "TS_INSIGHTS_INVALID_ORIGIN_EPOCH",
      "append cannot mix keyed Facts from different origin secret epochs",
    );
  }
  if (delta.checkpoint.pendingState.sessionState.sessionKey !== sessionKey) {
    throw engineError("TS_INSIGHTS_OWNER_MISMATCH", "checkpoint session state belongs elsewhere");
  }
  if (delta.session.duplicateGroupKey !== null && delta.session.duplicateGroupKey !== undefined) {
    throw engineError(
      "TS_INSIGHTS_DEDUPE_AUTHORITY",
      "duplicateGroupKey is derived by the Engine",
    );
  }

  const collections = [
    [delta.turns, (item) => item.turnKey, "turns"],
    [delta.sourceRecords, (item) => item.sourceRecordKey, "sourceRecords"],
    [delta.evidenceEvents, (item) => item.eventKey, "evidenceEvents"],
    [delta.turnEvidence, turnEvidenceKey, "turnEvidence"],
    [delta.capabilities, (item) => item.capabilityKey, "capabilities"],
    [delta.capabilityUses, (item) => item.useKey, "capabilityUses"],
    [delta.capabilityUseEvidence, useEvidenceKey, "capabilityUseEvidence"],
  ];
  for (const [items, key, label] of collections) assertUnique(items, key, label);
  assertUnique(delta.retractions.turnKeys, (item) => item, "turn retractions");
  assertUnique(delta.retractions.orphanEventKeys, (item) => item, "orphan Event retractions");
  assertUnique(
    delta.retractions.authoritativeTurnKeys,
    (item) => item,
    "authoritative Turn roots",
  );

  const incomingTurnKeys = new Set(delta.turns.map((turn) => turn.turnKey));
  for (const turnKey of delta.retractions.authoritativeTurnKeys) {
    if (!incomingTurnKeys.has(turnKey)) {
      throw engineError(
        "TS_INSIGHTS_INVALID_AUTHORITATIVE_ROOT",
        `authoritative Turn ${turnKey} is missing its Turn upsert`,
      );
    }
  }

  for (const turn of delta.turns) {
    assertOwned(turn.ownerSessionKey, sessionKey, `Turn ${turn.turnKey}`);
    if (turn.providerVisibility === "rolled-back") {
      throw engineError(
        "TS_INSIGHTS_ROLLBACK_AUTHORITY",
        "Adapter Turn facts cannot pre-resolve rollback visibility",
      );
    }
    assertStableKey(
      turn.turnKey,
      hashKey("turn", hexBytes(sessionKey), uint64(turn.turnStartOffset, "turnStartOffset")),
      `Turn ${turn.turnKey}`,
    );
  }
  for (const record of delta.sourceRecords) {
    assertOwned(record.ownerSessionKey, sessionKey, `SourceRecord ${record.sourceRecordKey}`);
    assertStableKey(
      record.sourceRecordKey,
      hashKey("source-record", hexBytes(sessionKey), uint64(record.startOffset, "startOffset")),
      `SourceRecord ${record.sourceRecordKey}`,
    );
    uint64(record.endOffset, "endOffset");
    if (BigInt(record.endOffset) < BigInt(record.startOffset)) {
      throw engineError("TS_INSIGHTS_INVALID_SOURCE_RECORD", "SourceRecord end precedes start");
    }
  }
  for (const event of delta.evidenceEvents) {
    assertOwned(event.ownerSessionKey, sessionKey, `Event ${event.eventKey}`);
    const order = event.sourceOrder;
    assertStableKey(
      event.eventKey,
      hashKey(
        "event",
        hexBytes(sessionKey),
        uint64(order.recordStartOffset, "recordStartOffset"),
        int32(order.contentIndex, "contentIndex"),
        uint16(order.eventOrdinal, "eventOrdinal"),
      ),
      `Event ${event.eventKey}`,
    );
    if (
      event.pointer.contentIndex !== order.contentIndex ||
      event.pointer.eventOrdinal !== order.eventOrdinal
    ) {
      throw engineError("TS_INSIGHTS_INVALID_POINTER", "Event pointer disagrees with source order");
    }
    if (event.kind === "provider-status" && event.statusKind === "thread-rolled-back") {
      if (event.occurredTurnKey !== null) {
        throw engineError("TS_INSIGHTS_ROLLBACK_AUTHORITY", "rollback Event must be session-scoped");
      }
    }
  }
  for (const link of delta.turnEvidence) {
    assertOwned(link.ownerSessionKey, sessionKey, `TurnEvidence ${turnEvidenceKey(link)}`);
    if (link.role === "rollback") {
      throw engineError(
        "TS_INSIGHTS_ROLLBACK_AUTHORITY",
        "Adapter deltas cannot provide rollback links",
      );
    }
  }
  for (const capability of delta.capabilities) {
    if (capability.provider !== delta.session.provider) {
      throw engineError("TS_INSIGHTS_OWNER_MISMATCH", "Capability provider differs from Session");
    }
    if (capability.canonicalName !== capability.canonicalName.normalize("NFC")) {
      throw engineError("TS_INSIGHTS_INVALID_STABLE_KEY", "Capability name is not NFC-normalized");
    }
    assertStableKey(
      capability.capabilityKey,
      hashKey(
        "capability",
        capability.provider,
        capability.kind,
        capability.canonicalName,
        Buffer.from([capability.identityVersion]),
      ),
      `Capability ${capability.capabilityKey}`,
    );
  }
  for (const use of delta.capabilityUses) {
    assertOwned(use.ownerSessionKey, sessionKey, `CapabilityUse ${use.useKey}`);
  }
  for (const link of delta.capabilityUseEvidence) {
    assertOwned(link.ownerSessionKey, sessionKey, `UseEvidence ${useEvidenceKey(link)}`);
  }

  for (const turnKey of delta.retractions.turnKeys) {
    const owner = findFactOwner(state, "turns", turnKey);
    if (owner && owner !== sessionKey) {
      throw engineError("TS_INSIGHTS_OWNER_MISMATCH", "cannot retract another session's Turn");
    }
  }
  for (const eventKey of delta.retractions.orphanEventKeys) {
    const owner = findFactOwner(state, "events", eventKey);
    if (owner && owner !== sessionKey) {
      throw engineError("TS_INSIGHTS_OWNER_MISMATCH", "cannot retract another session's Event");
    }
  }
}

function foreignKey(condition, message) {
  if (!condition) throw engineError("TS_INSIGHTS_FOREIGN_KEY", message);
}

function compareSourceOrder(left, right) {
  const offset = BigInt(left.recordStartOffset) - BigInt(right.recordStartOffset);
  if (offset !== 0n) return offset < 0n ? -1 : 1;
  if (left.contentIndex !== right.contentIndex) return left.contentIndex - right.contentIndex;
  return left.eventOrdinal - right.eventOrdinal;
}

function validateUseStableKey(sessionState, use) {
  let branch;
  if (typeof use.correlationDigest === "string") {
    branch = Buffer.concat([Buffer.from([1]), hexBytes(use.correlationDigest)]);
  } else {
    const evidence = [...sessionState.useEvidence.values()]
      .filter((link) => link.useKey === use.useKey)
      .map((link) => sessionState.events.get(link.eventKey))
      .filter(Boolean)
      .sort((left, right) =>
        compareSourceOrder(left.sourceOrder, right.sourceOrder) || left.eventKey.localeCompare(right.eventKey)
      );
    foreignKey(evidence.length > 0, `CapabilityUse ${use.useKey} has no identity evidence`);
    branch = Buffer.concat([Buffer.from([0]), hexBytes(evidence[0].eventKey)]);
  }
  assertStableKey(
    use.useKey,
    hashKey("capability-use", hexBytes(use.turnKey), branch),
    `CapabilityUse ${use.useKey}`,
  );
}

function validateCheckpointCapability(state, capabilityKey, provider, label) {
  const capability = state.capabilities.get(capabilityKey);
  foreignKey(capability, `${label} Capability ${capabilityKey} is missing`);
  foreignKey(
    capability.provider === provider,
    `${label} Capability ${capabilityKey} belongs to another provider`,
  );
}

function validateCheckpointReferences(state, sessionState, checkpoint) {
  const pending = checkpoint.pendingState;
  const provider = sessionState.session.provider;
  if (pending.currentTurnKey !== null) {
    foreignKey(
      sessionState.turns.has(pending.currentTurnKey),
      `checkpoint current Turn ${pending.currentTurnKey} is missing`,
    );
  }
  for (const item of pending.pendingStarted) {
    foreignKey(sessionState.events.has(item.eventKey), `pending Event ${item.eventKey} is missing`);
    if (item.turnKey !== null) {
      foreignKey(sessionState.turns.has(item.turnKey), `pending Turn ${item.turnKey} is missing`);
    }
  }
  for (const item of pending.pendingUses) {
    if (item.useKey !== null) {
      foreignKey(sessionState.uses.has(item.useKey), `pending CapabilityUse ${item.useKey} is missing`);
    }
    if (item.capabilityKey !== null) {
      validateCheckpointCapability(state, item.capabilityKey, provider, "pending");
    }
  }
  for (const turnKey of [pending.sessionState.firstTurnKey, pending.sessionState.secondTurnKey]) {
    if (turnKey !== null) foreignKey(sessionState.turns.has(turnKey), `Session Turn ${turnKey} is missing`);
  }
  for (const eventKey of pending.sessionState.dedupe?.dedupeEvidenceEventKeys ?? []) {
    foreignKey(sessionState.events.has(eventKey), `dedupe Event ${eventKey} is missing`);
  }
  for (const eventKey of sessionState.session.dedupeEvidenceEventKeys ?? []) {
    foreignKey(sessionState.events.has(eventKey), `Session dedupe Event ${eventKey} is missing`);
  }
  for (const item of pending.catalogEntries) {
    validateCheckpointCapability(state, item.capabilityKey, provider, "catalog");
    foreignKey(sessionState.events.has(item.eventKey), `catalog Event ${item.eventKey} is missing`);
  }
}

function validateFinalSemantics(state, sessionState, delta) {
  const sessionKey = delta.session.sessionKey;
  const provider = delta.session.provider;
  if (
    delta.checkpoint.pendingState.sessionState.sessionScope !== delta.session.sessionScope ||
    delta.checkpoint.pendingState.sessionState.eligibility !== delta.session.eligibility
  ) {
    throw engineError("TS_INSIGHTS_OWNER_MISMATCH", "checkpoint Session attributes disagree with Session");
  }

  for (const record of sessionState.sourceRecords.values()) {
    assertOwned(record.ownerSessionKey, sessionKey, `SourceRecord ${record.sourceRecordKey}`);
  }
  for (const event of sessionState.events.values()) {
    assertOwned(event.ownerSessionKey, sessionKey, `Event ${event.eventKey}`);
    const record = sessionState.sourceRecords.get(event.sourceRecordKey);
    foreignKey(record, `Event ${event.eventKey} references missing SourceRecord ${event.sourceRecordKey}`);
    foreignKey(
      record.startOffset === event.sourceOrder.recordStartOffset,
      `Event ${event.eventKey} source order disagrees with its SourceRecord`,
    );
    if (event.occurredTurnKey !== null) {
      foreignKey(
        sessionState.turns.has(event.occurredTurnKey),
        `Event ${event.eventKey} references missing Turn ${event.occurredTurnKey}`,
      );
    }
    if (typeof event.capabilityKey === "string") {
      const capability = state.capabilities.get(event.capabilityKey);
      foreignKey(capability, `Event ${event.eventKey} references missing Capability ${event.capabilityKey}`);
      foreignKey(capability.provider === provider, `Event ${event.eventKey} references another provider`);
    }
  }
  for (const link of sessionState.turnEvidence.values()) {
    assertOwned(link.ownerSessionKey, sessionKey, `TurnEvidence ${turnEvidenceKey(link)}`);
    foreignKey(sessionState.turns.has(link.turnKey), `TurnEvidence references missing Turn ${link.turnKey}`);
    foreignKey(sessionState.events.has(link.eventKey), `TurnEvidence references missing Event ${link.eventKey}`);
  }
  for (const use of sessionState.uses.values()) {
    assertOwned(use.ownerSessionKey, sessionKey, `CapabilityUse ${use.useKey}`);
    foreignKey(sessionState.turns.has(use.turnKey), `CapabilityUse ${use.useKey} references missing Turn`);
    const capability = state.capabilities.get(use.capabilityKey);
    foreignKey(capability, `CapabilityUse ${use.useKey} references missing Capability`);
    foreignKey(capability.provider === provider, `CapabilityUse ${use.useKey} references another provider`);
  }
  for (const link of sessionState.useEvidence.values()) {
    assertOwned(link.ownerSessionKey, sessionKey, `UseEvidence ${useEvidenceKey(link)}`);
    foreignKey(sessionState.uses.has(link.useKey), `UseEvidence references missing Use ${link.useKey}`);
    foreignKey(sessionState.events.has(link.eventKey), `UseEvidence references missing Event ${link.eventKey}`);
  }
  for (const use of sessionState.uses.values()) validateUseStableKey(sessionState, use);
  validateCheckpointReferences(state, sessionState, delta.checkpoint);
}

function turnEvidenceKey(link) {
  return `${link.turnKey}:${link.eventKey}:${link.role}`;
}

function useEvidenceKey(link) {
  return `${link.useKey}:${link.eventKey}:${link.role}`;
}

function sorted(values, key) {
  return [...values].sort((left, right) => key(left).localeCompare(key(right)));
}

function emptySessionState() {
  return {
    factSchemaVersion: null,
    generation: "0",
    deltaId: null,
    canonicalDelta: null,
    snapshotSeq: 0,
    session: null,
    checkpoint: null,
    turns: new Map(),
    sourceRecords: new Map(),
    events: new Map(),
    turnEvidence: new Map(),
    rollbackEvidence: new Map(),
    uses: new Map(),
    useEvidence: new Map(),
    diagnostics: [],
    coverage: {},
  };
}

function deleteUse(sessionState, useKey) {
  for (const [key, link] of sessionState.useEvidence) {
    if (link.useKey === useKey) sessionState.useEvidence.delete(key);
  }
  sessionState.uses.delete(useKey);
}

function deleteEvent(sessionState, eventKey) {
  for (const [key, link] of sessionState.turnEvidence) {
    if (link.eventKey === eventKey) sessionState.turnEvidence.delete(key);
  }
  for (const [key, link] of sessionState.useEvidence) {
    if (link.eventKey === eventKey) sessionState.useEvidence.delete(key);
  }
  sessionState.events.delete(eventKey);
}

function deleteTurn(sessionState, turnKey) {
  for (const [key, link] of sessionState.turnEvidence) {
    if (link.turnKey === turnKey) sessionState.turnEvidence.delete(key);
  }
  for (const [key, link] of sessionState.rollbackEvidence) {
    if (link.turnKey === turnKey) sessionState.rollbackEvidence.delete(key);
  }
  for (const use of [...sessionState.uses.values()]) {
    if (use.turnKey === turnKey) deleteUse(sessionState, use.useKey);
  }
  for (const event of [...sessionState.events.values()]) {
    if (event.occurredTurnKey === turnKey) deleteEvent(sessionState, event.eventKey);
  }
  sessionState.turns.delete(turnKey);
}

function garbageCollectSourceRecords(sessionState) {
  const referenced = new Set(
    [...sessionState.events.values()].map((event) => event.sourceRecordKey),
  );
  for (const key of sessionState.sourceRecords.keys()) {
    if (!referenced.has(key)) sessionState.sourceRecords.delete(key);
  }
}

function referencedCapabilityKeys(sessionState) {
  const keys = new Set([...sessionState.uses.values()].map((use) => use.capabilityKey));
  for (const event of sessionState.events.values()) {
    if (typeof event.capabilityKey === "string") keys.add(event.capabilityKey);
  }
  for (const item of sessionState.checkpoint?.pendingState.pendingUses ?? []) {
    if (item.capabilityKey !== null) keys.add(item.capabilityKey);
  }
  for (const item of sessionState.checkpoint?.pendingState.catalogEntries ?? []) {
    keys.add(item.capabilityKey);
  }
  return keys;
}

function garbageCollectCapabilities(state) {
  const referenced = new Set();
  for (const sessionState of state.sessions.values()) {
    for (const key of referencedCapabilityKeys(sessionState)) referenced.add(key);
  }
  for (const key of state.capabilities.keys()) {
    if (!referenced.has(key)) state.capabilities.delete(key);
  }
}

function eventForLink(link, incomingEvents, sessionState) {
  return incomingEvents.get(link.eventKey) ?? sessionState.events.get(link.eventKey);
}

function useForLink(link, incomingUses, sessionState) {
  return incomingUses.get(link.useKey) ?? sessionState.uses.get(link.useKey);
}

function reconcileAuthoritativeTurns(sessionState, delta) {
  const authoritative = new Set(delta.retractions.authoritativeTurnKeys);
  const incomingTurns = new Map(delta.turns.map((turn) => [turn.turnKey, turn]));
  const incomingEvents = new Map(delta.evidenceEvents.map((event) => [event.eventKey, event]));
  const incomingUses = new Map(delta.capabilityUses.map((use) => [use.useKey, use]));
  const incomingTurnLinks = new Map(delta.turnEvidence.map((link) => [turnEvidenceKey(link), link]));
  const incomingUseLinks = new Map(
    delta.capabilityUseEvidence.map((link) => [useEvidenceKey(link), link]),
  );

  for (const turnKey of authoritative) {
    if (!incomingTurns.has(turnKey)) {
      throw engineError(
        "TS_INSIGHTS_INVALID_AUTHORITATIVE_ROOT",
        `authoritative Turn ${turnKey} is missing its Turn upsert`,
      );
    }
    for (const event of [...sessionState.events.values()]) {
      if (event.occurredTurnKey === turnKey && !incomingEvents.has(event.eventKey)) {
        deleteEvent(sessionState, event.eventKey);
      }
    }
    for (const use of [...sessionState.uses.values()]) {
      if (use.turnKey === turnKey && !incomingUses.has(use.useKey)) {
        deleteUse(sessionState, use.useKey);
      }
    }
    for (const [key, link] of sessionState.turnEvidence) {
      const event = eventForLink(link, incomingEvents, sessionState);
      const rootedHere = link.turnKey === turnKey || event?.occurredTurnKey === turnKey;
      if (rootedHere && !incomingTurnLinks.has(key)) sessionState.turnEvidence.delete(key);
    }
    for (const [key, link] of sessionState.useEvidence) {
      const event = eventForLink(link, incomingEvents, sessionState);
      const use = useForLink(link, incomingUses, sessionState);
      const rootedHere = use?.turnKey === turnKey || event?.occurredTurnKey === turnKey;
      if (rootedHere && !incomingUseLinks.has(key)) sessionState.useEvidence.delete(key);
    }
  }
}

function applyRetractions(sessionState, delta) {
  const authoritative = new Set(delta.retractions.authoritativeTurnKeys);
  for (const turnKey of delta.retractions.turnKeys) {
    if (authoritative.has(turnKey)) {
      throw engineError(
        "TS_INSIGHTS_INVALID_RETRACTION",
        `Turn ${turnKey} cannot be both retracted and authoritative`,
      );
    }
    deleteTurn(sessionState, turnKey);
  }
  for (const eventKey of delta.retractions.orphanEventKeys) {
    const event = sessionState.events.get(eventKey);
    if (event && event.occurredTurnKey !== null) {
      throw engineError(
        "TS_INSIGHTS_INVALID_RETRACTION",
        `Event ${eventKey} is not a session-scoped orphan`,
      );
    }
    deleteEvent(sessionState, eventKey);
  }
}

function applyUpserts(state, sessionState, delta) {
  sessionState.session = {
    ...structuredClone(delta.session),
    duplicateGroupKey: duplicateGroupKey(delta.session),
  };
  for (const turn of delta.turns) {
    sessionState.turns.set(turn.turnKey, {
      fact: structuredClone(turn),
      effectiveVisibility: turn.providerVisibility,
      revision: null,
    });
  }
  for (const record of delta.sourceRecords) {
    sessionState.sourceRecords.set(record.sourceRecordKey, structuredClone(record));
  }
  for (const event of delta.evidenceEvents) {
    sessionState.events.set(event.eventKey, structuredClone(event));
  }
  for (const link of delta.turnEvidence) {
    sessionState.turnEvidence.set(turnEvidenceKey(link), structuredClone(link));
  }
  for (const capability of delta.capabilities) {
    const current = state.capabilities.get(capability.capabilityKey);
    if (current && canonicalJson(current) !== canonicalJson(capability)) {
      throw engineError(
        "TS_INSIGHTS_CAPABILITY_CONFLICT",
        `Capability ${capability.capabilityKey} is immutable`,
      );
    }
    state.capabilities.set(capability.capabilityKey, structuredClone(capability));
  }
  for (const use of delta.capabilityUses) {
    sessionState.uses.set(use.useKey, structuredClone(use));
  }
  for (const link of delta.capabilityUseEvidence) {
    sessionState.useEvidence.set(useEvidenceKey(link), structuredClone(link));
  }
}

function recomputeTurnRevisions(state, sessionState) {
  const allLinks = [
    ...sessionState.turnEvidence.values(),
    ...sessionState.rollbackEvidence.values(),
  ];
  for (const item of sessionState.turns.values()) {
    const turnKey = item.fact.turnKey;
    const evidenceEvents = sorted(
      [...sessionState.events.values()].filter((event) => event.occurredTurnKey === turnKey),
      (event) => event.eventKey,
    );
    const sourceRecordKeys = new Set(evidenceEvents.map((event) => event.sourceRecordKey));
    const sourceRecords = sorted(
      [...sourceRecordKeys].map((key) => sessionState.sourceRecords.get(key)).filter(Boolean),
      (record) => record.sourceRecordKey,
    );
    const turnEvidence = sorted(
      allLinks.filter((link) => link.turnKey === turnKey),
      turnEvidenceKey,
    );
    const capabilityUses = sorted(
      [...sessionState.uses.values()].filter((use) => use.turnKey === turnKey),
      (use) => use.useKey,
    );
    const useKeys = new Set(capabilityUses.map((use) => use.useKey));
    const capabilityUseEvidence = sorted(
      [...sessionState.useEvidence.values()].filter((link) => useKeys.has(link.useKey)),
      useEvidenceKey,
    );
    const capabilityKeys = new Set(capabilityUses.map((use) => use.capabilityKey));
    const capabilities = sorted(
      [...capabilityKeys].map((key) => state.capabilities.get(key)).filter(Boolean),
      (capability) => capability.capabilityKey,
    );
    const turn = {
      ...structuredClone(item.fact),
      providerVisibility: item.effectiveVisibility,
    };
    item.revision = createHash("sha256").update(canonicalJson({
      turn,
      sourceRecords,
      evidenceEvents,
      turnEvidence,
      capabilities,
      capabilityUses,
      capabilityUseEvidence,
    })).digest("hex");
  }
}

function rollbackEvents(sessionState) {
  return [...sessionState.events.values()].filter((event) =>
    event.kind === "provider-status" && event.statusKind === "thread-rolled-back"
  );
}

function hardSealEvent(sessionState, item) {
  const candidates = [];
  for (const link of sessionState.turnEvidence.values()) {
    if (link.turnKey !== item.fact.turnKey) continue;
    const event = sessionState.events.get(link.eventKey);
    if (!event) continue;
    if (
      item.fact.rawClosure.nextUserBoundary === true &&
      link.role === "follow-up" &&
      event.kind === "visible-message" &&
      event.role === "user"
    ) {
      candidates.push(event);
    }
    if (
      item.fact.rawClosure.providerTerminal !== null &&
      link.role === "lifecycle" &&
      event.kind === "turn-lifecycle" &&
      event.lifecycleState === item.fact.rawClosure.providerTerminal
    ) {
      candidates.push(event);
    }
  }
  return candidates.sort((left, right) =>
    compareSourceOrder(left.sourceOrder, right.sourceOrder) || left.eventKey.localeCompare(right.eventKey)
  )[0] ?? null;
}

function addRollbackUnresolved(sessionState, events) {
  if (events.length === 0) return;
  sessionState.coverage["rollback-unresolved"] =
    (sessionState.coverage["rollback-unresolved"] ?? 0) + events.length;
  const firstOffset = events
    .map((event) => event.sourceOrder.recordStartOffset)
    .sort((left, right) => {
      const difference = BigInt(left) - BigInt(right);
      return difference < 0n ? -1 : difference > 0n ? 1 : 0;
    })[0];
  const existing = sessionState.diagnostics.find((item) => item.code === "rollback-unresolved");
  if (existing) {
    existing.count += events.length;
    if (
      existing.firstOffset === undefined ||
      existing.firstOffset === null ||
      BigInt(firstOffset) < BigInt(existing.firstOffset)
    ) {
      existing.firstOffset = firstOffset;
    }
  } else {
    sessionState.diagnostics.push({
      code: "rollback-unresolved",
      count: events.length,
      firstOffset,
    });
  }
}

function replayRollbackVisibility(sessionState) {
  sessionState.rollbackEvidence.clear();
  for (const item of sessionState.turns.values()) {
    item.effectiveVisibility = item.fact.providerVisibility;
  }

  const rollbacks = rollbackEvents(sessionState);
  if (rollbacks.length === 0) return;
  const incompleteTurnKeys = new Set();
  const timeline = rollbacks.map((event) => ({ kind: "rollback", event }));
  for (const item of sessionState.turns.values()) {
    const declaresHardSeal =
      item.fact.rawClosure.nextUserBoundary === true ||
      item.fact.rawClosure.providerTerminal !== null;
    const event = hardSealEvent(sessionState, item);
    if (declaresHardSeal && event === null) incompleteTurnKeys.add(item.fact.turnKey);
    if (event) timeline.push({ kind: "seal", event, turnKey: item.fact.turnKey });
  }
  timeline.sort((left, right) =>
    compareSourceOrder(left.event.sourceOrder, right.event.sourceOrder) ||
    left.event.eventKey.localeCompare(right.event.eventKey) ||
    left.kind.localeCompare(right.kind)
  );

  const sessionIncomplete = (sessionState.session.factTruncation ?? []).length > 0;
  const sealedActive = new Set();
  const observedSeals = new Set();
  const unresolved = [];
  for (const action of timeline) {
    if (action.kind === "seal") {
      if (observedSeals.has(action.turnKey)) continue;
      observedSeals.add(action.turnKey);
      if (sessionState.turns.get(action.turnKey)?.fact.providerVisibility === "active") {
        sealedActive.add(action.turnKey);
      }
      continue;
    }

    const countValue = action.event.rolledBackTurnCount;
    const count = typeof countValue === "string" ? BigInt(countValue) : 0n;
    const priorIncomplete = [...sessionState.turns.values()].some((item) =>
      BigInt(item.fact.turnStartOffset) < BigInt(action.event.sourceOrder.recordStartOffset) &&
      ((item.fact.factTruncation ?? []).length > 0 || incompleteTurnKeys.has(item.fact.turnKey))
    );
    if (
      action.event.providerState !== "observed" ||
      count < 1n ||
      count > 512n ||
      sessionState.session.sessionScope !== "main" ||
      sessionIncomplete ||
      priorIncomplete
    ) {
      unresolved.push(action.event);
      continue;
    }

    const active = [...sealedActive]
      .map((turnKey) => sessionState.turns.get(turnKey))
      .filter(Boolean)
      .sort((left, right) => {
        const difference = BigInt(left.fact.turnStartOffset) - BigInt(right.fact.turnStartOffset);
        if (difference !== 0n) return difference < 0n ? -1 : 1;
        return left.fact.turnKey.localeCompare(right.fact.turnKey);
      });
    const targetCount = Number(count);
    if (active.length < targetCount) {
      unresolved.push(action.event);
      continue;
    }
    for (const target of active.slice(-targetCount)) {
      sealedActive.delete(target.fact.turnKey);
      target.effectiveVisibility = "rolled-back";
      const link = {
        ownerSessionKey: sessionState.session.sessionKey,
        turnKey: target.fact.turnKey,
        eventKey: action.event.eventKey,
        role: "rollback",
      };
      sessionState.rollbackEvidence.set(turnEvidenceKey(link), link);
    }
  }
  addRollbackUnresolved(sessionState, unresolved);
}

function readView(state, sessionState) {
  const capabilityKeys = referencedCapabilityKeys(sessionState);
  const links = [
    ...sessionState.turnEvidence.values(),
    ...sessionState.rollbackEvidence.values(),
  ];
  return {
    snapshotSeq: sessionState.snapshotSeq,
    factSchemaVersion: sessionState.factSchemaVersion,
    session: structuredClone(sessionState.session),
    checkpoint: structuredClone(sessionState.checkpoint),
    turns: sorted(sessionState.turns.values(), (item) => item.fact.turnKey).map((item) => ({
      ...structuredClone(item.fact),
      baseProviderVisibility: item.fact.providerVisibility,
      providerVisibility: item.effectiveVisibility,
      effectiveVisibility: item.effectiveVisibility,
      revision: item.revision,
    })),
    sourceRecords: sorted(sessionState.sourceRecords.values(), (item) => item.sourceRecordKey),
    evidenceEvents: sorted(sessionState.events.values(), (item) => item.eventKey),
    turnEvidence: sorted(links, turnEvidenceKey),
    capabilities: sorted(
      [...capabilityKeys].map((key) => state.capabilities.get(key)).filter(Boolean),
      (item) => item.capabilityKey,
    ),
    capabilityUses: sorted(sessionState.uses.values(), (item) => item.useKey),
    capabilityUseEvidence: sorted(sessionState.useEvidence.values(), useEvidenceKey),
    diagnostics: structuredClone(sessionState.diagnostics),
    coverage: structuredClone(sessionState.coverage),
  };
}

export function createInMemoryInsightsEngine() {
  let committed = {
    snapshotSeq: 0,
    sessions: new Map(),
    capabilities: new Map(),
  };

  return Object.freeze({
    applySessionFacts(delta, _options = {}) {
      validateCommitEnvelope(delta);
      const sessionKey = delta.session.sessionKey;
      const current = committed.sessions.get(sessionKey);
      const canonicalDelta = canonicalJson(delta);

      if (current?.deltaId === delta.deltaId) {
        if (current.canonicalDelta !== canonicalDelta) {
          throw engineError(
            "TS_INSIGHTS_DELTA_ID_CONFLICT",
            "the committed deltaId belongs to different canonical bytes",
          );
        }
        return {
          snapshotSeq: current.snapshotSeq,
          sessionKey,
          idempotent: true,
        };
      }

      const actualGeneration = current?.generation ?? "0";
      if (delta.expectedGeneration !== actualGeneration) {
        throw engineError(
          "TS_INSIGHTS_GENERATION_CONFLICT",
          `expected generation ${delta.expectedGeneration}, committed generation is ${actualGeneration}`,
        );
      }

      validateIncomingSemantics(committed, delta);

      const snapshotSeq = committed.snapshotSeq + 1;
      const working = structuredClone(committed);
      let sessionState = working.sessions.get(sessionKey) ?? emptySessionState();
      if (delta.mode === "replace-session") {
        const metadata = {
          generation: sessionState.generation,
          deltaId: sessionState.deltaId,
          canonicalDelta: sessionState.canonicalDelta,
          snapshotSeq: sessionState.snapshotSeq,
        };
        sessionState = { ...emptySessionState(), ...metadata };
      } else {
        applyRetractions(sessionState, delta);
        reconcileAuthoritativeTurns(sessionState, delta);
      }
      applyUpserts(working, sessionState, delta);
      validateFinalSemantics(working, sessionState, delta);
      garbageCollectSourceRecords(sessionState);
      sessionState.checkpoint = structuredClone(delta.checkpoint);
      sessionState.diagnostics = structuredClone(delta.diagnostics);
      sessionState.coverage = structuredClone(delta.coverage);
      replayRollbackVisibility(sessionState);
      recomputeTurnRevisions(working, sessionState);
      sessionState.factSchemaVersion = delta.factSchemaVersion;
      sessionState.generation = delta.targetGeneration;
      sessionState.deltaId = delta.deltaId;
      sessionState.canonicalDelta = canonicalDelta;
      sessionState.snapshotSeq = snapshotSeq;
      working.sessions.set(sessionKey, sessionState);
      garbageCollectCapabilities(working);
      working.snapshotSeq = snapshotSeq;
      committed = working;
      return { snapshotSeq, sessionKey, idempotent: false };
    },

    readCommittedSession(sessionKey) {
      const record = committed.sessions.get(sessionKey);
      return record ? structuredClone(readView(committed, record)) : null;
    },
  });
}
