import { randomBytes, randomUUID } from "node:crypto";

import { sanitizeLocalText } from "./cli-contract.mjs";
import { canonicalJson, createPrivacyContext } from "./session-facts.mjs";
import { readProviderSessionDelta } from "./provider-evidence.mjs";
import { resolveSessionFile } from "./session-files.mjs";

const REPORT_FORMAT = "threadshare-session-analysis@v1";
const DEFAULT_QUIESCENCE_SECONDS = 300;
const MIN_QUIESCENCE_SECONDS = 60;
const MAX_QUIESCENCE_SECONDS = 86_400;

function values(value) {
  if (value instanceof Map) return [...value.values()];
  return Array.isArray(value) ? [...value] : [];
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

function compareDecimal(left, right) {
  const difference = BigInt(left) - BigInt(right);
  return difference < 0n ? -1 : difference > 0n ? 1 : 0;
}

function compareSourceOrder(left, right) {
  return compareDecimal(left.recordStartOffset, right.recordStartOffset) ||
    left.contentIndex - right.contentIndex ||
    left.eventOrdinal - right.eventOrdinal;
}

function sourceOrderOf(event) {
  return event?.sourceOrder ?? {
    recordStartOffset: "0",
    contentIndex: -1,
    eventOrdinal: 0,
  };
}

function normalizeNow(value) {
  const milliseconds = value instanceof Date ? value.getTime() : Number(value ?? Date.now());
  if (!Number.isSafeInteger(milliseconds) || milliseconds < 0) {
    throw new TypeError("now must be a non-negative safe-integer millisecond value");
  }
  return String(milliseconds);
}

function normalizeQuiescence(value) {
  const seconds = value ?? DEFAULT_QUIESCENCE_SECONDS;
  if (
    !Number.isSafeInteger(seconds) ||
    seconds < MIN_QUIESCENCE_SECONDS ||
    seconds > MAX_QUIESCENCE_SECONDS
  ) {
    throw new RangeError("quiescenceSeconds must be an integer between 60 and 86400");
  }
  return seconds;
}

function checkpointAllowsQuiescence(checkpoint, nowUnixMs, quiescenceSeconds) {
  if (
    checkpoint?.eofObserved !== true ||
    checkpoint?.sourceSnapshotStable !== true ||
    checkpoint?.partialTailLength !== "0" ||
    !/^(?:0|[1-9][0-9]*)$/u.test(checkpoint?.sourceMtimeNs ?? "")
  ) {
    return false;
  }
  const nowNs = BigInt(nowUnixMs) * 1_000_000n;
  const threshold = BigInt(checkpoint.sourceMtimeNs) + BigInt(quiescenceSeconds) * 1_000_000_000n;
  return nowNs >= threshold;
}

function closureFor(turn, isTail, quiescent) {
  const reasons = [];
  if (turn.rawClosure?.nextUserBoundary === true) reasons.push("next-user-boundary");
  if (turn.rawClosure?.providerTerminal === "completed") reasons.push("provider-completed");
  if (turn.rawClosure?.providerTerminal === "aborted") reasons.push("provider-aborted");
  if (reasons.length > 0) {
    return { state: "hard-sealed", reasons, provisional: false };
  }
  if (isTail && quiescent) {
    return { state: "quiescent", reasons: ["stable-eof-timeout"], provisional: true };
  }
  return { state: "open", reasons: [], provisional: true };
}

function safeEvent(event, source) {
  const summary = {
    eventKey: event.eventKey,
    kind: event.kind,
    occurredTurnKey: event.occurredTurnKey,
    originScope: event.originScope,
    observedTimestamp: event.observedTimestamp,
    sourceOrder: event.sourceOrder,
    pointer: source ? {
      recordStartOffset: source.startOffset,
      recordEndOffset: source.endOffset,
      recordSha256: source.recordSha256,
      providerRecordClass: source.providerRecordClass,
      pointerKind: event.pointer.pointerKind,
      contentIndex: event.pointer.contentIndex,
      eventOrdinal: event.pointer.eventOrdinal,
    } : null,
  };
  if (event.kind === "visible-message") summary.role = event.role;
  if (event.kind === "capability-invocation") summary.capabilityKey = event.capabilityKey;
  if (event.kind === "capability-result") {
    summary.providerState = event.providerState;
    if (event.exitCode !== undefined) summary.exitCode = event.exitCode;
    if (event.outputBytes !== undefined) summary.outputBytes = event.outputBytes;
    if (event.durationMs !== undefined) summary.durationMs = event.durationMs;
  }
  if (event.kind === "skill-catalog-entry") summary.capabilityKey = event.capabilityKey;
  if (event.kind === "skill-load") {
    summary.capabilityKey = event.capabilityKey;
    summary.strength = event.strength;
    summary.evidenceSource = event.evidenceSource;
  }
  if (event.kind === "turn-lifecycle") summary.lifecycleState = event.lifecycleState;
  if (event.kind === "provider-status") {
    summary.statusKind = event.statusKind;
    summary.providerState = event.providerState;
    if (event.rolledBackTurnCount !== undefined) {
      summary.rolledBackTurnCount = event.rolledBackTurnCount;
    }
  }
  return summary;
}

function useRelation(use, priorByInput) {
  if (typeof use.inputFingerprint !== "string") return null;
  const identity = `${use.turnKey}:${use.capabilityKey}:${use.inputFingerprint}`;
  const previous = priorByInput.get(identity);
  priorByInput.set(identity, use);
  if (!previous) return null;
  return {
    kind: previous.providerTerminalState === "failed" ||
        previous.providerTerminalState === "cancelled"
      ? "retry-after-failure"
      : "same-input-repeat",
    previousUseKey: previous.useKey,
  };
}

function sessionSummary(session) {
  const dedupe = session.duplicateMethod ? {
    method: session.duplicateMethod,
    confidence: session.duplicateConfidence,
    closure: session.dedupeClosure,
  } : null;
  return {
    sessionKey: session.sessionKey,
    provider: session.provider,
    scope: session.sessionScope,
    eligibility: session.eligibility,
    originatorVersion: session.originatorVersion
      ? sanitizeLocalText(session.originatorVersion, 256)
      : null,
    observedStart: session.observedStart ?? null,
    observedEnd: session.observedEnd ?? null,
    dedupe,
    factTruncation: [...(session.factTruncation ?? [])].sort(compareText),
  };
}

export function analyzeSessionFacts(snapshot, options = {}) {
  if (!snapshot?.session || !snapshot?.checkpoint) {
    throw new TypeError("a committed Session Fact snapshot is required");
  }
  const nowUnixMs = normalizeNow(options.now);
  const quiescenceSeconds = normalizeQuiescence(options.quiescenceSeconds);
  const session = snapshot.session;
  const sourceRecords = values(snapshot.sourceRecords);
  const events = values(snapshot.evidenceEvents);
  const turnLinks = values(snapshot.turnEvidence);
  const capabilities = values(snapshot.capabilities);
  const uses = values(snapshot.capabilityUses);
  const useLinks = values(snapshot.capabilityUseEvidence);

  const sourceByKey = new Map(sourceRecords.map((source) => [source.sourceRecordKey, source]));
  const eventByKey = new Map(events.map((event) => [event.eventKey, event]));
  const capabilityByKey = new Map(capabilities.map((item) => [item.capabilityKey, item]));
  const orderedTurns = values(snapshot.turns).sort((left, right) =>
    compareDecimal(left.turnStartOffset, right.turnStartOffset) || compareText(left.turnKey, right.turnKey)
  );
  const tailTurnKey = orderedTurns.at(-1)?.turnKey ?? null;
  const quiescent = checkpointAllowsQuiescence(
    snapshot.checkpoint,
    nowUnixMs,
    quiescenceSeconds,
  );

  const linksByTurn = new Map(orderedTurns.map((turn) => [turn.turnKey, []]));
  for (const link of turnLinks) linksByTurn.get(link.turnKey)?.push(link);
  const usesByTurn = new Map(orderedTurns.map((turn) => [turn.turnKey, []]));
  for (const use of uses) usesByTurn.get(use.turnKey)?.push(use);
  const linksByUse = new Map(uses.map((use) => [use.useKey, []]));
  for (const link of useLinks) linksByUse.get(link.useKey)?.push(link);

  const priorByInput = new Map();
  const allReportUses = [];
  for (const turn of orderedTurns) {
    const turnUses = (usesByTurn.get(turn.turnKey) ?? []).sort((left, right) =>
      left.turnOrdinal - right.turnOrdinal || compareText(left.useKey, right.useKey)
    );
    for (const use of turnUses) {
      const reportUse = {
        useKey: use.useKey,
        turnKey: use.turnKey,
        capabilityKey: use.capabilityKey,
        ordinal: use.turnOrdinal,
        exactObservedName: sanitizeLocalText(use.exactObservedName, 512),
        kind: capabilityByKey.get(use.capabilityKey)?.kind ?? "unknown",
        originScope: use.originScope,
        executionState: use.providerTerminalState,
        strength: use.strength,
        inputRelation: useRelation(use, priorByInput),
        evidence: (linksByUse.get(use.useKey) ?? [])
          .sort((left, right) =>
            compareSourceOrder(sourceOrderOf(eventByKey.get(left.eventKey)), sourceOrderOf(eventByKey.get(right.eventKey))) ||
            compareText(left.role, right.role) ||
            compareText(left.eventKey, right.eventKey)
          )
          .map(({ role, eventKey }) => ({ role, eventKey })),
      };
      allReportUses.push(reportUse);
    }
  }

  const mainSession = session.sessionScope === "main" && session.eligibility === "eligible";
  const allReportTurns = orderedTurns.map((turn, index) => {
    const links = (linksByTurn.get(turn.turnKey) ?? []).sort((left, right) =>
      compareSourceOrder(sourceOrderOf(eventByKey.get(left.eventKey)), sourceOrderOf(eventByKey.get(right.eventKey))) ||
      compareText(left.role, right.role) ||
      compareText(left.eventKey, right.eventKey)
    );
    const closure = closureFor(turn, turn.turnKey === tailTurnKey, quiescent);
    const lifecycle = links
      .map((link) => eventByKey.get(link.eventKey))
      .filter((event) => event?.kind === "turn-lifecycle" &&
        (event.lifecycleState === "completed" || event.lifecycleState === "aborted"))
      .sort((left, right) => compareSourceOrder(left.sourceOrder, right.sourceOrder))
      .at(-1);
    const terminalState = lifecycle?.lifecycleState ?? turn.rawClosure?.providerTerminal;
    const visibility = turn.effectiveVisibility ?? turn.providerVisibility ?? "unknown";
    const exclusionReasons = [];
    if (closure.state === "open") exclusionReasons.push("open");
    if (visibility === "rolled-back") exclusionReasons.push("rolled-back");
    if (session.sessionScope !== "main") exclusionReasons.push("session-scope");
    if (session.eligibility !== "eligible") exclusionReasons.push("session-ineligible");
    return {
      turnKey: turn.turnKey,
      ordinal: index + 1,
      turnStartOffset: turn.turnStartOffset,
      observedTimestamp: turn.observedTimestamp ?? null,
      problemText: sanitizeLocalText(turn.problemText, 65_536),
      finalAnswerExcerpt: turn.finalAnswerExcerpt
        ? sanitizeLocalText(turn.finalAnswerExcerpt, 8192)
        : null,
      visibility,
      closure,
      resultEvidence: {
        display: terminalState === "aborted"
          ? "abandoned"
          : terminalState === "completed" ? "provider-completed" : "unknown",
        terminalEventKey: lifecycle?.eventKey ?? null,
        followUpObserved: links.some((link) => link.role === "follow-up"),
      },
      aggregationEligible: mainSession && visibility === "active" && closure.state !== "open",
      exclusionReasons,
      useKeys: (usesByTurn.get(turn.turnKey) ?? [])
        .sort((left, right) => left.turnOrdinal - right.turnOrdinal || compareText(left.useKey, right.useKey))
        .map((use) => use.useKey),
      evidence: links.map(({ role, eventKey }) => ({ role, eventKey })),
      factTruncation: [...(turn.factTruncation ?? [])].sort(compareText),
    };
  });

  const hiddenTurnKeys = new Set(
    allReportTurns
      .filter((turn) => turn.visibility === "rolled-back")
      .map((turn) => turn.turnKey),
  );
  const visibleTurns = allReportTurns.filter((turn) => !hiddenTurnKeys.has(turn.turnKey));
  const visibleTurnKeys = new Set(visibleTurns.map((turn) => turn.turnKey));
  const reportUses = allReportUses.filter((use) => visibleTurnKeys.has(use.turnKey));
  const visibleUseKeys = new Set(reportUses.map((use) => use.useKey));
  const hiddenUseKeys = new Set(
    allReportUses.filter((use) => hiddenTurnKeys.has(use.turnKey)).map((use) => use.useKey),
  );

  const directlyVisibleEventKeys = new Set();
  const directlyHiddenEventKeys = new Set();
  const visiblyLinkedEventKeys = new Set();
  const hiddenLinkedEventKeys = new Set();
  const rollbackEventKeys = new Set();
  for (const event of events) {
    if (visibleTurnKeys.has(event.occurredTurnKey)) directlyVisibleEventKeys.add(event.eventKey);
    if (hiddenTurnKeys.has(event.occurredTurnKey)) directlyHiddenEventKeys.add(event.eventKey);
  }
  for (const link of turnLinks) {
    if (visibleTurnKeys.has(link.turnKey)) visiblyLinkedEventKeys.add(link.eventKey);
    if (hiddenTurnKeys.has(link.turnKey)) hiddenLinkedEventKeys.add(link.eventKey);
    if (link.role === "rollback") rollbackEventKeys.add(link.eventKey);
  }
  for (const link of useLinks) {
    if (visibleUseKeys.has(link.useKey)) visiblyLinkedEventKeys.add(link.eventKey);
    if (hiddenUseKeys.has(link.useKey)) hiddenLinkedEventKeys.add(link.eventKey);
  }

  const includedTurnKeys = new Set(
    visibleTurns.filter((turn) => turn.aggregationEligible).map((turn) => turn.turnKey),
  );
  const includedUses = reportUses.filter((use) =>
    includedTurnKeys.has(use.turnKey) && use.originScope === "main"
  );
  const toolUses = includedUses.filter((use) => use.kind === "tool");
  const skillUses = includedUses.filter((use) => use.kind === "skill");
  const reportedEvents = events.filter((event) => {
    if (rollbackEventKeys.has(event.eventKey)) return true;
    if (directlyHiddenEventKeys.has(event.eventKey)) return false;
    if (directlyVisibleEventKeys.has(event.eventKey)) return true;
    if (hiddenLinkedEventKeys.has(event.eventKey)) return false;
    if (visiblyLinkedEventKeys.has(event.eventKey)) return true;
    return event.occurredTurnKey === null;
  });
  const reportedEventKeys = new Set(reportedEvents.map((event) => event.eventKey));
  const reportTurns = visibleTurns.map((turn) => {
    const evidence = turn.evidence.filter((link) => reportedEventKeys.has(link.eventKey));
    const followUpEvidenceHiddenByRollback = turn.evidence.some((link) =>
      link.role === "follow-up" && !reportedEventKeys.has(link.eventKey)
    );
    return {
      ...turn,
      closure: {
        ...turn.closure,
        evidenceHiddenByRollback: followUpEvidenceHiddenByRollback,
      },
      resultEvidence: {
        ...turn.resultEvidence,
        terminalEventKey: reportedEventKeys.has(turn.resultEvidence.terminalEventKey)
          ? turn.resultEvidence.terminalEventKey
          : null,
      },
      evidence,
    };
  });
  const reportEvents = reportedEvents
    .sort((left, right) => compareSourceOrder(left.sourceOrder, right.sourceOrder) ||
      compareText(left.eventKey, right.eventKey))
    .map((event) => safeEvent(event, sourceByKey.get(event.sourceRecordKey)));
  const capabilityUseCounts = new Map();
  for (const use of reportUses) {
    capabilityUseCounts.set(use.capabilityKey, (capabilityUseCounts.get(use.capabilityKey) ?? 0) + 1);
  }
  const eligibleCapabilityUseCounts = new Map();
  for (const use of includedUses) {
    eligibleCapabilityUseCounts.set(
      use.capabilityKey,
      (eligibleCapabilityUseCounts.get(use.capabilityKey) ?? 0) + 1,
    );
  }
  const visibleCapabilityKeys = new Set(reportUses.map((use) => use.capabilityKey));
  for (const event of reportEvents) {
    if (typeof event.capabilityKey === "string") visibleCapabilityKeys.add(event.capabilityKey);
  }

  return {
    format: REPORT_FORMAT,
    analysisVersion: 1,
    factSchemaVersion: snapshot.factSchemaVersion ?? 1,
    evaluation: { nowUnixMs, quiescenceSeconds },
    session: sessionSummary(session),
    summary: {
      inventory: {
        turns: allReportTurns.length,
        capabilityUses: allReportUses.length,
        evidenceEvents: events.length,
      },
      aggregateEligible: {
        turns: reportTurns.filter((turn) => turn.aggregationEligible).length,
        hardSealed: reportTurns.filter((turn) => turn.aggregationEligible && turn.closure.state === "hard-sealed").length,
        quiescent: reportTurns.filter((turn) => turn.aggregationEligible && turn.closure.state === "quiescent").length,
        toolUses: toolUses.length,
        skillUses: skillUses.length,
        confirmedSkillLoads: skillUses.filter((use) => use.strength === "confirmed").length,
        inferredSkillLoads: skillUses.filter((use) => use.strength === "inferred").length,
      },
      excluded: {
        openTurns: reportTurns.filter((turn) => turn.closure.state === "open").length,
        rolledBackTurns: hiddenTurnKeys.size,
        rolledBackUses: hiddenUseKeys.size,
        subagentUses: allReportUses.filter((use) => use.originScope === "subagent").length,
        unknownScopeUses: allReportUses.filter((use) => use.originScope === "unknown").length,
      },
    },
    turns: reportTurns,
    capabilities: capabilities
      .filter((capability) => visibleCapabilityKeys.has(capability.capabilityKey))
      .map((capability) => ({
        capabilityKey: capability.capabilityKey,
        provider: capability.provider,
        kind: capability.kind,
        canonicalName: sanitizeLocalText(capability.canonicalName, 512),
        useCount: capabilityUseCounts.get(capability.capabilityKey) ?? 0,
        aggregateEligibleUseCount:
          eligibleCapabilityUseCounts.get(capability.capabilityKey) ?? 0,
      }))
      .sort((left, right) => compareText(left.capabilityKey, right.capabilityKey)),
    uses: reportUses,
    events: reportEvents,
    diagnostics: values(snapshot.diagnostics)
      .map((item) => ({ code: item.code, count: item.count }))
      .sort((left, right) => compareText(left.code, right.code)),
    coverage: Object.fromEntries(
      Object.entries(snapshot.coverage ?? {}).sort(([left], [right]) => compareText(left, right)),
    ),
  };
}

function oneLine(value, limit) {
  const normalized = String(value ?? "").replace(/\s+/gu, " ").trim();
  return normalized.length <= limit ? normalized : `${normalized.slice(0, limit - 1)}...`;
}

export function formatSessionAnalysisText(report) {
  const useByKey = new Map(report.uses.map((use) => [use.useKey, use]));
  const lines = [
    `Session ${report.session.provider} ${report.session.sessionKey}`,
    `Scope: ${report.session.scope}; eligibility: ${report.session.eligibility}`,
    `Turns ${report.summary.inventory.turns}: ${report.summary.aggregateEligible.hardSealed} hard-sealed, ${report.summary.aggregateEligible.quiescent} quiescent, ${report.summary.excluded.openTurns} open, ${report.summary.excluded.rolledBackTurns} rolled-back`,
    `Uses: ${report.summary.aggregateEligible.toolUses} tools, ${report.summary.aggregateEligible.skillUses} skills`,
  ];
  for (const turn of report.turns) {
    if (turn.visibility === "rolled-back") continue;
    lines.push("");
    lines.push(`${String(turn.ordinal).padStart(2, "0")} [${turn.closure.state}] User: ${oneLine(turn.problemText, 180)}`);
    if (turn.finalAnswerExcerpt) {
      lines.push(`   Assistant: ${oneLine(turn.finalAnswerExcerpt, 220)}`);
    }
    const names = turn.useKeys
      .map((useKey) => useByKey.get(useKey))
      .filter(Boolean)
      .map((use) => `${use.exactObservedName} (${use.executionState})`);
    if (names.length > 0) lines.push(`   Uses: ${names.join(", ")}`);
  }
  if (report.summary.excluded.rolledBackTurns > 0) {
    lines.push("");
    lines.push(`Rolled-back Turns hidden: ${report.summary.excluded.rolledBackTurns}`);
  }
  if (report.diagnostics.length > 0) {
    lines.push("");
    lines.push(`Diagnostics: ${report.diagnostics.map(({ code, count }) => `${code}=${count}`).join(", ")}`);
  }
  return `${lines.join("\n")}\n`;
}

export function formatSessionAnalysisJson(report) {
  return `${canonicalJson(report)}\n`;
}

export async function analyzeSession(provider, sessionReference, options = {}) {
  const source = await resolveSessionFile(provider, sessionReference, options);
  const privacyContext = options.privacyContext ?? createPrivacyContext({
    secret: randomBytes(32),
    originSecretEpoch: randomUUID(),
  });
  try {
    const readDelta = options.readDelta ?? readProviderSessionDelta;
    const delta = await readDelta(provider, source, {
      privacyContext,
      mode: "replace-session",
    });
    const engine = options.engine ?? await import("./insights-reference-engine.mjs")
      .then(({ createInMemoryInsightsEngine }) => createInMemoryInsightsEngine());
    await engine.applySessionFacts(delta);
    const snapshot = await engine.readCommittedSession(delta.session.sessionKey);
    return analyzeSessionFacts(snapshot, options);
  } catch (error) {
    if (typeof error?.errno === "number" && typeof error?.code === "string") throw error;
    const failure = error instanceof Error ? error : new Error(String(error));
    failure.threadshareSessionFailureKind = "analysis_engine";
    throw failure;
  }
}
