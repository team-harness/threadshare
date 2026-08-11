#!/usr/bin/env node

import { createHash } from "node:crypto";
import { execFile, spawn } from "node:child_process";
import { once } from "node:events";
import { constants as fsConstants } from "node:fs";
import {
  access,
  appendFile,
  copyFile,
  mkdir,
  mkdtemp,
  readFile,
  rm,
  stat,
  utimes,
  writeFile,
} from "node:fs/promises";
import {
  cpus,
  loadavg,
  platform as osPlatform,
  release as osRelease,
  totalmem,
} from "node:os";
import { tmpdir } from "node:os";
import path from "node:path";
import { performance } from "node:perf_hooks";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import {
  ACTIVE_INSIGHTS_ANALYZER_CAPABILITIES,
  ACTIVE_INSIGHTS_PROJECTION_VERSIONS,
  assertHandshakeCompatible,
  createExcludeSourceMessage,
  createHelloMessage,
  createReadEngineStatusMessage,
  createReadInsightsOverviewMessage,
  createRemoveSourceMessage,
  createRunPurgeMaintenanceMessage,
  createSearchTurnsMessage,
  createSessionDeltaMessages,
  decodeProtocolFrames,
  encodeProtocolFrame,
} from "../src/insights-engine-protocol.mjs";
import {
  assertSessionFactsDelta,
  canonicalJson,
  createPrivacyContext,
  hashKey,
} from "../src/session-facts.mjs";
import { createInsightsEngineClient } from "../src/insights-engine-client.mjs";
import {
  createInsightsIndexWorker,
  runInsightsIndexer,
} from "../src/insights-indexer.mjs";
import {
  createInsightsBackgroundWorker,
  insightsRequiredContract,
  reconcileActiveInsights,
} from "../src/insights-command.mjs";
import { INSIGHTS_ORIGIN_SECRET_FORMAT } from "../src/insights-state.mjs";
import {
  discoverProviderEvidenceSources,
  readProviderSessionDelta,
} from "../src/provider-evidence.mjs";

const execFileAsync = promisify(execFile);
const SCRIPT_PATH = fileURLToPath(import.meta.url);
const REPOSITORY_ROOT = path.resolve(path.dirname(SCRIPT_PATH), "..");
const ENGINE_NAME = process.platform === "win32"
  ? "threadshare-insights-engine.exe"
  : "threadshare-insights-engine";
const DEFAULT_ENGINE_PATH = path.join(
  REPOSITORY_ROOT,
  "crates",
  "insights-engine",
  "target",
  "release",
  ENGINE_NAME,
);
const DEFAULT_SEED = "threadshare-insights-benchmark-v1";
const ORIGIN_SECRET_EPOCH = "33333333-3333-4333-8333-333333333333";
const PROTOCOL_FORMAT = "threadshare-insights-protocol@v1";
const BENCHMARK_FORMAT = "threadshare-insights-engine-benchmark@v1";
const CAPACITY_BENCHMARK_FORMAT = "threadshare-insights-capacity-benchmark@v1";
const RAW_BACKFILL_BENCHMARK_FORMAT = "threadshare-insights-raw-backfill-benchmark@v1";
const QUERY_BENCHMARK_FORMAT = "threadshare-insights-query-benchmark@v1";
export const FORMAL_QUERY_BENCHMARK_TURN_COUNTS = Object.freeze([25_000, 250_000]);
export const FORMAL_QUERY_BENCHMARK_QUERY_COUNT = 1_000;
export const FORMAL_QUERY_BENCHMARK_WARMUP_COUNT = 100;
export const FORMAL_MUTATION_QUERY_EQUIVALENCE_COUNT = 100;
export const FORMAL_QUERY_BENCHMARK_SEEDS = Object.freeze({
  25000: "threadshare-insights-query-25k-v1",
  250000: "threadshare-insights-query-250k-v1",
});
const BASE_TIME_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const GIB = 1024 ** 3;
const SQLITE_LOCK_BYTE_OFFSET = 1_073_741_824;
const NORMALIZED_FACT_LIMIT_BYTES = 6 * GIB;
const STEADY_STATE_LIMIT_BYTES = 8 * GIB;
const CURRENT_ENGINE_RSS_LIMIT_BYTES = 96 * 1024 * 1024;
const LONG_TERM_ENGINE_RSS_LIMIT_BYTES = 128 * 1024 * 1024;
const DETAIL_FULL_FTS_LIMIT_BYTES = 400 * 1024 * 1024;
const QUERY_BUDGETS = Object.freeze({
  current: Object.freeze({
    maximumTurns: 25_000,
    p95Ms: 100,
    p99Ms: 250,
    sidecarRssBytes: CURRENT_ENGINE_RSS_LIMIT_BYTES,
    derivedStateBytes: 1 * GIB,
  }),
  longTerm: Object.freeze({
    maximumTurns: 250_000,
    p95Ms: 200,
    p99Ms: 500,
    sidecarRssBytes: LONG_TERM_ENGINE_RSS_LIMIT_BYTES,
    derivedStateBytes: 8 * GIB,
  }),
});
const CAPACITY_CORPUS_VERSION = 4;
const CAPACITY_TOPIC_COUNT = 47;
const CAPACITY_DENSITY = Object.freeze({
  sourceRecordsPerTurn: 9,
  evidenceEventsPerTurn: 9,
  turnEvidencePerTurn: 3,
  capabilityUsesPerTurn: 3,
  capabilityUseEvidencePerTurn: 6,
  capabilitiesPerProvider: 12,
  naturalTermsPerTurn: 135,
  uniqueNaturalTermsPerTurn: 6,
  problemTextCharacters: 1_600,
  finalAnswerCharacters: 1_100,
});
const CAPABILITY_NAMES = Object.freeze([
  "Read", "Search", "Shell", "Edit", "Write", "ApplyPatch",
  "WebSearch", "ListFiles", "GitStatus", "Test", "Build", "Deploy",
]);

export function sqliteFileFormatPages({ pageCount, pageSize, freelistCount }) {
  const databasePageBytes = pageCount * pageSize;
  // SQLite reserves one whole page containing the fixed 1 GiB lock-byte offset.
  // dbstat intentionally does not attribute that page to a table or index.
  const lockBytePageBytes = databasePageBytes > SQLITE_LOCK_BYTE_OFFSET
    ? pageSize
    : 0;
  const freelistBytes = freelistCount * pageSize;
  return {
    lockBytePageBytes,
    freelistBytes,
    totalBytes: lockBytePageBytes + freelistBytes,
  };
}

const FACT_TABLES = new Set([
  "sessions", "session_commits", "session_fact_truncation", "source_checkpoints",
  "turns", "turn_fact_truncation", "source_records", "capabilities",
  "evidence_events", "visible_message_events", "capability_invocation_events",
  "capability_result_events", "skill_catalog_entry_events", "skill_load_events",
  "turn_lifecycle_events", "provider_status_events", "turn_evidence",
  "capability_uses", "capability_use_evidence", "checkpoint_turn_pins",
  "checkpoint_event_pins", "checkpoint_use_pins", "checkpoint_capability_pins",
  "session_dedupe_evidence", "fact_diagnostics", "fact_coverage",
]);
const FTS_TABLES = new Set([
  "turn_fts_documents",
  "field_stats",
  "fts_analyzer_identity",
  "turn_analyzer_diagnostics",
]);
const PROJECTION_TABLES = new Set([
  "turn_rollup_contributions", "projection_state", "projection_change_log",
  "capability_retry_contributions", "retry_projection_build_cursor",
  "turn_search_build_cursor", "overview_rollup_state", "overview_session_rollups",
  "overview_session_capabilities", "overview_session_fact_signals",
]);
const SOURCE_STATE_TABLES = new Set([
  "source_ingestion_states", "source_ingestion_staging", "source_purge_states",
]);
const ENGINE_OTHER_TABLES = new Set(["engine_metadata"]);

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function encodeBenchmarkTerm(value) {
  const bytes = Buffer.from(value, "utf8");
  if (bytes.length > 256) return `h${sha256(bytes)}`;
  const alphabet = "abcdefghijklmnopqrstuvwxyz234567";
  let accumulator = 0;
  let bits = 0;
  let encoded = "t";
  for (const byte of bytes) {
    accumulator = (accumulator << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      bits -= 5;
      encoded += alphabet[(accumulator >>> bits) & 31];
    }
  }
  if (bits > 0) encoded += alphabet[(accumulator << (5 - bits)) & 31];
  return encoded;
}

function positiveInteger(value, name) {
  if (!/^[1-9][0-9]*$/u.test(String(value))) {
    throw new TypeError(`${name} must be a positive integer`);
  }
  const number = Number(value);
  if (!Number.isSafeInteger(number)) throw new TypeError(`${name} is too large`);
  return number;
}

function ratio(numerator, denominator) {
  return denominator === 0 ? null : numerator / denominator;
}

function percentile(values, quantile) {
  if (values.length === 0) return null;
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil(sorted.length * quantile) - 1)];
}

function round(value, digits = 3) {
  if (value === null || value === undefined || !Number.isFinite(value)) return value;
  const scale = 10 ** digits;
  return Math.round(value * scale) / scale;
}

function uint64(value) {
  const output = Buffer.alloc(8);
  output.writeBigUInt64BE(BigInt(value));
  return output;
}

function int32(value) {
  const output = Buffer.alloc(4);
  output.writeInt32BE(value);
  return output;
}

function uint16(value) {
  const output = Buffer.alloc(2);
  output.writeUInt16BE(value);
  return output;
}

function sizedText(prefix, characters) {
  const vocabulary = " search index query retry evidence tool workflow code_path flag-name topic ";
  if (prefix.length >= characters) return prefix.slice(0, characters);
  const repeats = Math.ceil((characters - prefix.length) / vocabulary.length);
  return `${prefix}${vocabulary.repeat(repeats)}`.slice(0, characters);
}

function alphabeticOrdinal(value) {
  let remaining = positiveInteger(value + 1, "alphabetic ordinal");
  let result = "";
  while (remaining > 0) {
    remaining -= 1;
    result = String.fromCharCode(97 + (remaining % 26)) + result;
    remaining = Math.floor(remaining / 26);
  }
  return result;
}

function capacityProblemText(globalIndex, provider, replacementMarker) {
  const terms = [
    "capacity",
    "problem",
    `provider${provider}`,
    `topic${alphabeticOrdinal(globalIndex % CAPACITY_TOPIC_COUNT)}`,
  ];
  if (replacementMarker !== "") terms.push("replacementvtwo");
  const document = alphabeticOrdinal(globalIndex);
  for (let index = 0; index < CAPACITY_DENSITY.uniqueNaturalTermsPerTurn; index += 1) {
    terms.push(`unique${document}x${alphabeticOrdinal(index)}`);
  }
  const sharedTerms =
    CAPACITY_DENSITY.naturalTermsPerTurn - CAPACITY_DENSITY.uniqueNaturalTermsPerTurn;
  for (let index = 0; index < sharedTerms; index += 1) {
    const vocabularyIndex = (globalIndex * 131 + index * 17) % 10_000;
    terms.push(`shared${alphabeticOrdinal(vocabularyIndex)}`);
  }
  const text = terms.join(" ");
  return text.length >= CAPACITY_DENSITY.problemTextCharacters
    ? text.slice(0, CAPACITY_DENSITY.problemTextCharacters)
    : text.padEnd(CAPACITY_DENSITY.problemTextCharacters, "x");
}

function capability(provider, name) {
  return {
    capabilityKey: hashKey("capability", provider, "tool", name, Buffer.from([1])),
    provider,
    kind: "tool",
    canonicalName: name,
    identityVersion: 1,
  };
}

function eventIdentity(sessionKey, recordStartOffset) {
  return hashKey(
    "event",
    Buffer.from(sessionKey, "hex"),
    uint64(recordStartOffset),
    int32(-1),
    uint16(0),
  );
}

function sourceRecord(sessionKey, startOffset, providerRecordClass, identity) {
  return {
    sourceRecordKey: hashKey(
      "source-record",
      Buffer.from(sessionKey, "hex"),
      uint64(startOffset),
    ),
    ownerSessionKey: sessionKey,
    startOffset: String(startOffset),
    endOffset: String(startOffset + 512),
    recordSha256: sha256(`capacity-record:${identity}`),
    providerRecordClass,
  };
}

function commonEvent(record, turnKey, kind, pointerKind, timestamp) {
  return {
    eventKey: eventIdentity(record.ownerSessionKey, record.startOffset),
    ownerSessionKey: record.ownerSessionKey,
    occurredTurnKey: turnKey,
    sourceRecordKey: record.sourceRecordKey,
    sourceOrder: {
      recordStartOffset: record.startOffset,
      contentIndex: -1,
      eventOrdinal: 0,
    },
    pointer: { pointerKind, contentIndex: -1, eventOrdinal: 0 },
    originScope: "main",
    observedTimestamp: timestamp,
    kind,
  };
}

function checkpoint(sessionKey, generation, completeOffset) {
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
        sessionKey,
        sessionScope: "main",
        eligibility: "eligible",
        originatorVersion: "benchmark@1",
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
  assertSessionFactsDelta(delta);
  return {
    delta,
    canonical: canonicalJson(delta),
  };
}

export function createBenchmarkCorpus({
  turnCount = 25_000,
  turnsPerSession = 100,
  seed = DEFAULT_SEED,
} = {}) {
  positiveInteger(turnCount, "turnCount");
  positiveInteger(turnsPerSession, "turnsPerSession");
  if (typeof seed !== "string" || seed.length === 0) {
    throw new TypeError("seed must be a non-empty string");
  }

  const sessions = [];
  const digest = createHash("sha256");
  let canonicalBytes = 0;
  let nextTurn = 0;
  for (let sessionIndex = 0; nextTurn < turnCount; sessionIndex += 1) {
    const sessionKey = hashKey("session", "benchmark", seed, String(sessionIndex));
    const remaining = turnCount - nextTurn;
    const sessionTurnCount = Math.min(turnsPerSession, remaining);
    const turns = [];
    const observedStart = new Date(BASE_TIME_MS + nextTurn * 1_000).toISOString();
    for (let localIndex = 0; localIndex < sessionTurnCount; localIndex += 1) {
      const globalIndex = nextTurn + localIndex;
      const offset = String(globalIndex * 1_024);
      const topic = globalIndex % 97;
      const language = ["zh", "en", "mixed", "code"][globalIndex % 4];
      turns.push({
        turnKey: hashKey(
          "turn",
          Buffer.from(sessionKey, "hex"),
          offset,
          String(localIndex),
        ),
        ownerSessionKey: sessionKey,
        turnStartOffset: offset,
        problemText: `benchmark problem ${globalIndex} topic-${topic} ${language} identifier-${globalIndex.toString(36)}`,
        finalAnswerExcerpt: `benchmark answer ${globalIndex} route-${globalIndex % 31} evidence-${globalIndex % 17}`,
        observedTimestamp: new Date(BASE_TIME_MS + globalIndex * 1_000).toISOString(),
        rawClosure: {
          nextUserBoundary: localIndex + 1 < sessionTurnCount,
          providerTerminal: localIndex + 1 === sessionTurnCount ? "completed" : null,
          observedEofClosed: false,
        },
        providerVisibility: "active",
        factTruncation: [],
      });
    }
    const lastTurnIndex = nextTurn + sessionTurnCount - 1;
    const completeOffset = String((lastTurnIndex + 1) * 1_024);
    const finalized = finalizeDelta({
      format: "session-facts-delta@v1",
      factSchemaVersion: 1,
      providerAdapterVersion: sessionIndex % 2 === 0 ? "codex@1" : "claude@1",
      privacyPolicyVersion: 1,
      originSecretEpoch: ORIGIN_SECRET_EPOCH,
      duplicatePolicyVersion: 1,
      expectedGeneration: "0",
      targetGeneration: "1",
      mode: "append",
      deltaId: "0".repeat(64),
      session: {
        sessionKey,
        provider: sessionIndex % 2 === 0 ? "codex" : "claude",
        sessionScope: "main",
        eligibility: "eligible",
        projectKey: hashKey("project", "benchmark", String(sessionIndex % 13)),
        observedStart,
        observedEnd: new Date(BASE_TIME_MS + lastTurnIndex * 1_000).toISOString(),
        originatorVersion: "benchmark@1",
        duplicateGroupKey: null,
        dedupeFingerprint: null,
        dedupeCorroborationFingerprint: null,
        duplicateMethod: null,
        duplicateConfidence: null,
        dedupeClosure: null,
        dedupeEvidenceEventKeys: [],
        duplicatePolicyVersion: 1,
        factTruncation: [],
      },
      retractions: {
        turnKeys: [],
        orphanEventKeys: [],
        authoritativeTurnKeys: [],
      },
      turns,
      sourceRecords: [],
      evidenceEvents: [],
      turnEvidence: [],
      capabilities: [],
      capabilityUses: [],
      capabilityUseEvidence: [],
      checkpoint: checkpoint(sessionKey, "1", completeOffset),
      diagnostics: [],
      coverage: {},
    });
    canonicalBytes += Buffer.byteLength(finalized.canonical, "utf8");
    digest.update(finalized.canonical);
    sessions.push(finalized);
    nextTurn += sessionTurnCount;
  }

  return Object.freeze({
    seed,
    turnCount,
    turnsPerSession,
    sessionCount: sessions.length,
    canonicalBytes,
    digest: digest.digest("hex"),
    sessions: Object.freeze(sessions),
  });
}

function createCapacitySession(plan, sessionIndex, {
  generation = 1,
  replacement = false,
} = {}) {
  if (!Number.isSafeInteger(sessionIndex) || sessionIndex < 0 || sessionIndex >= plan.sessionCount) {
    throw new RangeError("sessionIndex is outside the capacity corpus");
  }
  const firstGlobalTurn = sessionIndex * plan.turnsPerSession;
  const sessionTurnCount = Math.min(
    plan.turnsPerSession,
    plan.turnCount - firstGlobalTurn,
  );
  const provider = sessionIndex % 2 === 0 ? "codex" : "claude";
  const sessionKey = hashKey("session", provider, `${plan.seed}:${sessionIndex}`);
  const observedStart = new Date(BASE_TIME_MS + firstGlobalTurn * 1_000).toISOString();
  const turns = [];
  const sourceRecords = [];
  const evidenceEvents = [];
  const turnEvidence = [];
  const capabilityUses = [];
  const capabilityUseEvidence = [];
  const usedCapabilities = new Map();

  for (let localIndex = 0; localIndex < sessionTurnCount; localIndex += 1) {
    const globalIndex = firstGlobalTurn + localIndex;
    const turnStartOffset = localIndex * 16_384;
    const turnKey = hashKey("turn", Buffer.from(sessionKey, "hex"), uint64(turnStartOffset));
    const timestamp = new Date(BASE_TIME_MS + globalIndex * 1_000).toISOString();
    const replacementMarker = replacement && localIndex === 0 ? " replacement-v2" : "";
    turns.push({
      turnKey,
      ownerSessionKey: sessionKey,
      turnStartOffset: String(turnStartOffset),
      problemText: capacityProblemText(globalIndex, provider, replacementMarker),
      finalAnswerExcerpt: sizedText(
        `capacity answer ${globalIndex} outcome-${globalIndex % 17}`,
        CAPACITY_DENSITY.finalAnswerCharacters,
      ),
      observedTimestamp: timestamp,
      rawClosure: {
        nextUserBoundary: localIndex + 1 < sessionTurnCount,
        providerTerminal: "completed",
        observedEofClosed: false,
      },
      providerVisibility: "active",
      factTruncation: [],
    });

    const addEvent = (slot, providerRecordClass, identity, fields) => {
      const recordStartOffset = turnStartOffset + slot * 1_024 + 1;
      const record = sourceRecord(
        sessionKey,
        recordStartOffset,
        providerRecordClass,
        `${plan.seed}:${sessionIndex}:${globalIndex}:${identity}:${replacementMarker}`,
      );
      const event = {
        ...commonEvent(
          record,
          turnKey,
          fields.kind,
          `benchmark:${fields.kind}`,
          timestamp,
        ),
        ...fields,
      };
      sourceRecords.push(record);
      evidenceEvents.push(event);
      return event;
    };

    const user = addEvent(0, "benchmark:visible-user", "user", {
      kind: "visible-message",
      role: "user",
    });
    const assistant = addEvent(1, "benchmark:visible-assistant", "assistant", {
      kind: "visible-message",
      role: "assistant",
    });
    const lifecycle = addEvent(2, "benchmark:turn-complete", "lifecycle", {
      kind: "turn-lifecycle",
      lifecycleState: "completed",
      providerTurnDigest: hashKey("benchmark-provider-turn", sessionKey, String(globalIndex)),
    });
    turnEvidence.push(
      { ownerSessionKey: sessionKey, turnKey, eventKey: user.eventKey, role: "boundary" },
      { ownerSessionKey: sessionKey, turnKey, eventKey: assistant.eventKey, role: "result" },
      { ownerSessionKey: sessionKey, turnKey, eventKey: lifecycle.eventKey, role: "lifecycle" },
    );

    for (let useIndex = 0; useIndex < CAPACITY_DENSITY.capabilityUsesPerTurn; useIndex += 1) {
      // Keep one Tool path per topic across independent sessions so the
      // per-family evidence threshold is measurable instead of globally pooled.
      const name = CAPABILITY_NAMES[
        ((globalIndex % CAPACITY_TOPIC_COUNT) * 3 + useIndex) % CAPABILITY_NAMES.length
      ];
      const tool = capability(provider, name);
      usedCapabilities.set(tool.capabilityKey, tool);
      const correlationDigest = hashKey(
        "provider-correlation",
        Buffer.from(sessionKey, "hex"),
        `benchmark-call:${globalIndex}:${useIndex}`,
      );
      const inputFingerprint = hashKey(
        "benchmark-input",
        Buffer.from(sessionKey, "hex"),
        String(globalIndex),
        String(useIndex),
      );
      const invocation = addEvent(3 + useIndex * 2, "benchmark:tool-invocation", `invoke:${useIndex}`, {
        kind: "capability-invocation",
        capabilityKey: tool.capabilityKey,
        correlationDigest,
        inputFingerprint,
      });
      const failed = (globalIndex + useIndex) % 7 === 0;
      const result = addEvent(4 + useIndex * 2, "benchmark:tool-result", `result:${useIndex}`, {
        kind: "capability-result",
        correlationDigest,
        providerState: failed ? "failed" : "completed",
        exitCode: failed ? "1" : "0",
        outputBytes: String(512 + (globalIndex * 37 + useIndex * 101) % 16_384),
        durationMs: String(5 + (globalIndex * 13 + useIndex * 17) % 2_000),
      });
      const branch = Buffer.concat([Buffer.from([1]), Buffer.from(correlationDigest, "hex")]);
      const useKey = hashKey("capability-use", Buffer.from(turnKey, "hex"), branch);
      capabilityUses.push({
        useKey,
        ownerSessionKey: sessionKey,
        turnKey,
        capabilityKey: tool.capabilityKey,
        turnOrdinal: useIndex,
        exactObservedName: name,
        originScope: "main",
        inputFingerprint,
        providerTerminalState: failed ? "failed" : "completed",
        strength: "observed",
        correlationDigest,
      });
      capabilityUseEvidence.push(
        { ownerSessionKey: sessionKey, useKey, eventKey: invocation.eventKey, role: "invocation" },
        { ownerSessionKey: sessionKey, useKey, eventKey: result.eventKey, role: "result" },
      );
    }
  }

  const lastGlobalTurn = firstGlobalTurn + sessionTurnCount - 1;
  const completeOffset = String(sessionTurnCount * 16_384);
  const targetGeneration = String(generation);
  const expectedGeneration = String(generation - 1);
  const projectKey = hashKey("project", "benchmark-capacity", String(sessionIndex % 29));
  const dedupeFingerprint = hashKey(
    "benchmark-capacity-dedupe",
    provider,
    plan.seed,
    String(sessionIndex),
  );
  const dedupeEvidenceEventKeys = evidenceEvents
    .slice(0, 3)
    .map(({ eventKey }) => eventKey);
  const sourceCheckpoint = checkpoint(sessionKey, targetGeneration, completeOffset);
  Object.assign(sourceCheckpoint.pendingState.sessionState, {
    projectKey,
    observedStart,
    observedEnd: new Date(BASE_TIME_MS + lastGlobalTurn * 1_000).toISOString(),
    dedupe: {
      dedupeFingerprint,
      duplicateMethod: "explicit-lineage",
      duplicateConfidence: "strong",
      dedupeClosure: "hard-sealed",
      dedupeEvidenceEventKeys,
    },
  });
  const finalized = finalizeDelta({
    format: "session-facts-delta@v1",
    factSchemaVersion: 1,
    providerAdapterVersion: `${provider}@1`,
    privacyPolicyVersion: 1,
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    duplicatePolicyVersion: 1,
    expectedGeneration,
    targetGeneration,
    mode: replacement ? "replace-session" : "append",
    deltaId: "0".repeat(64),
    session: {
      sessionKey,
      provider,
      sessionScope: "main",
      eligibility: "eligible",
      projectKey,
      observedStart,
      observedEnd: new Date(BASE_TIME_MS + lastGlobalTurn * 1_000).toISOString(),
      originatorVersion: "benchmark-capacity@1",
      duplicateGroupKey: null,
      dedupeFingerprint,
      dedupeCorroborationFingerprint: null,
      duplicateMethod: "explicit-lineage",
      duplicateConfidence: "strong",
      dedupeClosure: "hard-sealed",
      dedupeEvidenceEventKeys,
      duplicatePolicyVersion: 1,
      factTruncation: [],
    },
    retractions: { turnKeys: [], orphanEventKeys: [], authoritativeTurnKeys: [] },
    turns,
    sourceRecords,
    evidenceEvents,
    turnEvidence,
    capabilities: [...usedCapabilities.values()].sort((left, right) =>
      left.capabilityKey < right.capabilityKey ? -1 : left.capabilityKey > right.capabilityKey ? 1 : 0),
    capabilityUses: capabilityUses.sort((left, right) =>
      left.useKey < right.useKey ? -1 : left.useKey > right.useKey ? 1 : 0),
    capabilityUseEvidence: capabilityUseEvidence.sort((left, right) =>
      left.useKey.localeCompare(right.useKey) || left.eventKey.localeCompare(right.eventKey)),
    checkpoint: sourceCheckpoint,
    diagnostics: [],
    coverage: {
      "benchmark-capability-invocation": sessionTurnCount * 3,
      "benchmark-capability-result": sessionTurnCount * 3,
    },
  });
  return Object.freeze({
    ...finalized,
    sessionIndex,
    turnCount: sessionTurnCount,
  });
}

export function createCapacityBenchmarkPlan({
  turnCount = 25_000,
  turnsPerSession = 100,
  seed = `${DEFAULT_SEED}-capacity`,
} = {}) {
  positiveInteger(turnCount, "turnCount");
  positiveInteger(turnsPerSession, "turnsPerSession");
  if (typeof seed !== "string" || seed.length === 0) {
    throw new TypeError("seed must be a non-empty string");
  }
  const sessionCount = Math.ceil(turnCount / turnsPerSession);
  const identity = Object.freeze({
    corpusVersion: CAPACITY_CORPUS_VERSION,
    seed,
    turnCount,
    turnsPerSession,
    sessionCount,
    density: CAPACITY_DENSITY,
  });
  const plan = {
    ...identity,
    identityDigest: sha256(canonicalJson(identity)),
    sessionKey(sessionIndex) {
      const provider = sessionIndex % 2 === 0 ? "codex" : "claude";
      return hashKey("session", provider, `${seed}:${sessionIndex}`);
    },
    sessionAt(sessionIndex, options) {
      return createCapacitySession(plan, sessionIndex, options);
    },
    *stream() {
      for (let sessionIndex = 0; sessionIndex < sessionCount; sessionIndex += 1) {
        yield createCapacitySession(plan, sessionIndex);
      }
    },
  };
  return Object.freeze(plan);
}

function requiredContract() {
  return {
    factSchemaVersion: 1,
    providerAdapterVersions: ["claude@1", "codex@1"],
    privacyPolicyVersion: 1,
    originSecretEpoch: ORIGIN_SECRET_EPOCH,
    duplicatePolicyVersion: 1,
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: [...ACTIVE_INSIGHTS_PROJECTION_VERSIONS],
    analyzerCapabilities: [...ACTIVE_INSIGHTS_ANALYZER_CAPABILITIES],
    rankerVersion: 1,
  };
}

async function writeEncodedFrame(stream, frame) {
  if (!stream.write(frame)) await once(stream, "drain");
}

async function nextResponse(iterator, expectedType, requestId) {
  const result = await iterator.next();
  if (result.done) throw new Error(`Insights Engine exited before ${expectedType}`);
  const message = result.value;
  if (message.type === "ERROR") {
    throw new Error(`${message.code ?? "TS_INSIGHTS_ENGINE_ERROR"}: ${message.message ?? "unknown error"}`);
  }
  if (message.format !== PROTOCOL_FORMAT || message.type !== expectedType ||
      message.requestId !== requestId) {
    throw new Error(`expected ${expectedType} for request ${requestId}, received ${message.type}`);
  }
  return message;
}

async function readProcessRssBytes(pid) {
  if (process.platform === "linux") {
    try {
      const status = await readFile(`/proc/${pid}/status`, "utf8");
      const match = /^VmRSS:\s+([0-9]+)\s+kB$/mu.exec(status);
      return match ? Number(match[1]) * 1_024 : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "darwin") {
    try {
      const { stdout } = await execFileAsync("ps", ["-o", "rss=", "-p", String(pid)], {
        encoding: "utf8",
      });
      const kibibytes = Number(stdout.trim());
      return Number.isFinite(kibibytes) ? kibibytes * 1_024 : null;
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    try {
      const command = `(Get-Process -Id ${pid}).WorkingSet64`;
      const { stdout } = await execFileAsync(
        "powershell.exe",
        ["-NoProfile", "-NonInteractive", "-Command", command],
        { encoding: "utf8" },
      );
      const bytes = Number(stdout.trim());
      return Number.isFinite(bytes) ? bytes : null;
    } catch {
      return null;
    }
  }
  return null;
}

function startRssSampler(pid) {
  let sidecarPeakBytes = 0;
  let nodeHarnessPeakBytes = process.memoryUsage().rss;
  let combinedPeakBytes = nodeHarnessPeakBytes;
  let stopped = false;
  let pending = Promise.resolve();

  const sample = async () => {
    const nodeBytes = process.memoryUsage().rss;
    const sidecarBytes = await readProcessRssBytes(pid);
    nodeHarnessPeakBytes = Math.max(nodeHarnessPeakBytes, nodeBytes);
    if (sidecarBytes !== null) {
      sidecarPeakBytes = Math.max(sidecarPeakBytes, sidecarBytes);
      combinedPeakBytes = Math.max(combinedPeakBytes, nodeBytes + sidecarBytes);
    }
  };
  const sampleIntervalMs = process.platform === "linux"
    ? 100
    : process.platform === "darwin" || process.platform === "win32"
      ? 500
      : null;
  const timer = sampleIntervalMs !== null
    ? setInterval(() => {
      if (stopped) return;
      pending = pending.then(sample, sample);
    }, sampleIntervalMs)
    : null;
  timer?.unref();
  pending = sample();

  return async () => {
    stopped = true;
    if (timer) clearInterval(timer);
    await pending;
    await sample();
    return {
      samplingMode: sampleIntervalMs === null
        ? "process-start-end-observations"
        : `${process.platform}-${sampleIntervalMs}ms`,
      peakSampled: sampleIntervalMs !== null,
      sidecarPeakBytes,
      nodeHarnessPeakBytes,
      combinedPeakBytes,
    };
  };
}

async function databaseFootprint(databasePath) {
  let bytes = 0;
  for (const suffix of ["", "-wal", "-shm"]) {
    try {
      bytes += (await stat(`${databasePath}${suffix}`)).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return bytes;
}

function storageOwner(name) {
  const autoIndex = /^sqlite_autoindex_(.+)_[0-9]+$/u.exec(name)?.[1] ?? null;
  const owner = autoIndex ?? name;
  if (FACT_TABLES.has(owner) || [
    "turns_session_order",
    "source_records_session_order",
    "evidence_events_session_order",
    "evidence_events_source_record",
    "evidence_events_occurred_turn",
    "capability_invocation_events_capability",
    "skill_catalog_entry_events_capability",
    "skill_load_events_capability",
    "turn_evidence_session_role",
    "turn_evidence_event",
    "capability_uses_session_key",
    "capability_uses_turn",
    "capability_uses_capability",
    "capability_use_evidence_session",
    "capability_use_evidence_event",
    "checkpoint_turn_pins_turn",
    "checkpoint_event_pins_event",
    "checkpoint_use_pins_use",
    "checkpoint_capability_pins_capability",
    "session_dedupe_evidence_event",
    "sessions_dedupe_support",
    "sessions_query_filters",
    "turns_query_filters",
    "capability_uses_query_filter",
  ].includes(name)) return "fact";
  if (FTS_TABLES.has(owner) || owner === "turns_fts" || owner.startsWith("turns_fts_")) {
    return "fts";
  }
  if (PROJECTION_TABLES.has(owner) || [
    "turn_rollup_by_turn",
    "turn_rollup_lookup",
    "projection_state_one_active",
    "projection_state_build_watermark",
    "projection_change_log_owner",
    "capability_retry_summary_lookup",
    "overview_session_provider",
    "overview_session_project",
    "overview_session_dedupe",
    "overview_capability_kind_key",
    "overview_fact_signal_lookup",
  ].includes(name)) return "projection";
  if (SOURCE_STATE_TABLES.has(owner)) return "sourceState";
  if (name === "sqlite_schema" || name === "sqlite_sequence") return "sqliteInternal";
  if (ENGINE_OTHER_TABLES.has(owner)) return "engineOther";
  return "unclassified";
}

function quoteIdentifier(value) {
  return `"${value.replaceAll('"', '""')}"`;
}

export function evaluateCapacityGates({ factBytes, steadyStateBytes }) {
  if (!Number.isSafeInteger(factBytes) || factBytes < 0 ||
      !Number.isSafeInteger(steadyStateBytes) || steadyStateBytes < 0) {
    throw new TypeError("capacity bytes must be non-negative safe integers");
  }
  const normalizedFactExceeded = factBytes > NORMALIZED_FACT_LIMIT_BYTES;
  const steadyStateExceeded = steadyStateBytes > STEADY_STATE_LIMIT_BYTES;
  const packedFactsRequired = normalizedFactExceeded || steadyStateExceeded;
  return Object.freeze({
    normalizedFactLimitBytes: NORMALIZED_FACT_LIMIT_BYTES,
    steadyStateLimitBytes: STEADY_STATE_LIMIT_BYTES,
    normalizedFactExceeded,
    steadyStateExceeded,
    packedFactsRequired,
    decision: packedFactsRequired
      ? "packed-facts-v1-required"
      : "normalized-row-v1-within-capacity-gates",
  });
}

async function auditCapacityDatabase(databasePath, {
  stagingUpperBoundBytes,
  rss,
  turnCount,
}) {
  const preVacuumPersistentBytes = await databaseFootprint(databasePath);
  const database = await openNodeDatabase(databasePath);
  const vacuumStarted = performance.now();
  database.exec("PRAGMA wal_checkpoint(TRUNCATE); VACUUM; PRAGMA wal_checkpoint(TRUNCATE);");
  const vacuumMs = performance.now() - vacuumStarted;

  const pageRows = database.prepare(
    "SELECT name, SUM(pgsize) AS bytes FROM dbstat GROUP BY name ORDER BY name",
  ).all();
  const byObject = {};
  const categories = {
    fact: { bytes: 0, rows: 0, objects: 0 },
    fts: { bytes: 0, rows: 0, objects: 0 },
    projection: { bytes: 0, rows: 0, objects: 0 },
    sourceState: { bytes: 0, rows: 0, objects: 0 },
    sqliteInternal: { bytes: 0, rows: 0, objects: 0 },
    engineOther: { bytes: 0, rows: 0, objects: 0 },
    unclassified: { bytes: 0, rows: 0, objects: 0 },
  };
  for (const row of pageRows) {
    const bytes = Number(row.bytes);
    const category = storageOwner(row.name);
    byObject[row.name] = { bytes, category };
    categories[category].bytes += bytes;
    categories[category].objects += 1;
  }

  const rowCounts = {};
  const logicalTables = [...new Set([
    ...FACT_TABLES,
    ...FTS_TABLES,
    ...PROJECTION_TABLES,
    ...SOURCE_STATE_TABLES,
  ])].sort();
  const existingTables = new Set(database.prepare(
    "SELECT name FROM sqlite_schema WHERE type IN ('table','view')",
  ).all().map((row) => row.name));
  for (const table of logicalTables) {
    if (!existingTables.has(table)) continue;
    const rows = Number(database.prepare(
      `SELECT COUNT(*) AS value FROM ${quoteIdentifier(table)}`,
    ).get().value);
    rowCounts[table] = rows;
    categories[storageOwner(table)].rows += rows;
  }
  const ftsRows = existingTables.has("turns_fts_vocab")
    ? database.prepare(
      `SELECT col AS field, COUNT(*) AS fieldTerms,
              COALESCE(SUM(doc),0) AS postings,
              COALESCE(SUM(cnt),0) AS occurrences
         FROM turns_fts_vocab GROUP BY col ORDER BY col`,
    ).all().map((row) => ({
      field: row.field,
      fieldTerms: Number(row.fieldTerms),
      postings: Number(row.postings),
      occurrences: Number(row.occurrences),
    }))
    : [];
  const ftsRowsByField = new Map(ftsRows.map((row) => [row.field, row]));
  const ftsByField = ["natural", "code", "capability"].map((field) =>
    ftsRowsByField.get(field) ?? {
      field,
      fieldTerms: 0,
      postings: 0,
      occurrences: 0,
    });
  const naturalFts = ftsByField.find(({ field }) => field === "natural");
  const codeFts = ftsByField.find(({ field }) => field === "code");
  const capabilityFts = ftsByField.find(({ field }) => field === "capability");
  const ftsDensity = {
    natural: {
      minimumFieldTerms:
        (rowCounts.turn_fts_documents ?? 0) * CAPACITY_DENSITY.uniqueNaturalTermsPerTurn,
      minimumPostings:
        (rowCounts.turn_fts_documents ?? 0) * CAPACITY_DENSITY.naturalTermsPerTurn,
      actualFieldTerms: naturalFts.fieldTerms,
      actualPostings: naturalFts.postings,
      meetsExpectedDensity:
        naturalFts.fieldTerms >=
          (rowCounts.turn_fts_documents ?? 0) * CAPACITY_DENSITY.uniqueNaturalTermsPerTurn &&
        naturalFts.postings >=
          (rowCounts.turn_fts_documents ?? 0) * CAPACITY_DENSITY.naturalTermsPerTurn,
    },
    code: {
      expectedPostings: 0,
      actualFieldTerms: codeFts.fieldTerms,
      actualPostings: codeFts.postings,
      meetsExpectedDensity: codeFts.fieldTerms === 0 && codeFts.postings === 0,
    },
    capability: {
      minimumPostings:
        (rowCounts.turn_fts_documents ?? 0) * CAPACITY_DENSITY.capabilityUsesPerTurn,
      actualFieldTerms: capabilityFts.fieldTerms,
      actualPostings: capabilityFts.postings,
      meetsExpectedDensity:
        capabilityFts.postings >=
          (rowCounts.turn_fts_documents ?? 0) * CAPACITY_DENSITY.capabilityUsesPerTurn,
    },
  };
  const ftsMetrics = {
    documents: rowCounts.turn_fts_documents ?? 0,
    fieldTerms: ftsByField.reduce((total, item) => total + item.fieldTerms, 0),
    postings: ftsByField.reduce((total, item) => total + item.postings, 0),
    occurrences: ftsByField.reduce((total, item) => total + item.occurrences, 0),
    byField: ftsByField,
    density: ftsDensity,
    detailFullBytes: categories.fts.bytes,
    backendReevaluationLimitBytes: 400 * 1024 * 1024,
    backendReevaluationRequired: categories.fts.bytes > 400 * 1024 * 1024,
  };
  const integrity = database.prepare("PRAGMA integrity_check").all()
    .map((row) => row.integrity_check);
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
  const pageCount = Number(database.prepare("PRAGMA page_count").get().page_count);
  const pageSize = Number(database.prepare("PRAGMA page_size").get().page_size);
  const freelistCount = Number(
    database.prepare("PRAGMA freelist_count").get().freelist_count,
  );
  database.close();

  const postVacuumPersistentBytes = await databaseFootprint(databasePath);
  const dbstatBytes = Object.values(categories)
    .reduce((total, category) => total + category.bytes, 0);
  const databasePageBytes = pageCount * pageSize;
  const fileFormatPages = sqliteFileFormatPages({
    pageCount,
    pageSize,
    freelistCount,
  });
  const dbstatAccountedPageBytes = dbstatBytes + fileFormatPages.totalBytes;
  const unclassifiedObjects = Object.entries(byObject)
    .filter(([, value]) => value.category === "unclassified")
    .map(([name]) => name)
    .sort();
  const observedPersistentPeakBytes = Math.max(
    preVacuumPersistentBytes,
    postVacuumPersistentBytes,
    dbstatBytes,
  );
  const compactedSteadyStateBytes = postVacuumPersistentBytes + stagingUpperBoundBytes;
  const observedDerivedStatePeakBytes = observedPersistentPeakBytes + stagingUpperBoundBytes;
  const engineRssLimitBytes = turnCount <= 25_000
    ? CURRENT_ENGINE_RSS_LIMIT_BYTES
    : LONG_TERM_ENGINE_RSS_LIMIT_BYTES;
  const diskGates = evaluateCapacityGates({
    factBytes: categories.fact.bytes,
    steadyStateBytes: observedDerivedStatePeakBytes,
  });
  const storageClassificationComplete = unclassifiedObjects.length === 0;
  const dbstatMatchesPageBytes = dbstatAccountedPageBytes === databasePageBytes;
  const engineRssWithinLimit =
    rss.sidecarPeakBytes > 0 && rss.sidecarPeakBytes <= engineRssLimitBytes;
  const ftsDensityMatchesCorpus = Object.values(ftsDensity)
    .every(({ meetsExpectedDensity }) => meetsExpectedDensity);
  const ftsBackendWithinLimit = !ftsMetrics.backendReevaluationRequired;
  return {
    measurement:
      "pre-maintenance persistent peak plus bounded staging for the 8 GiB gate; " +
      "VACUUM then dbstat for category attribution",
    vacuumMs,
    preVacuumPersistentBytes,
    postVacuumPersistentBytes,
    dbstatBytes,
    dbstatAccountedPageBytes,
    databasePageBytes,
    pageCount,
    pageSize,
    freelistCount,
    fileFormatPages,
    stagingUpperBoundBytes,
    stagingMeasurement: "maximum canonical SessionFactsDeltaV1 bytes",
    observedPersistentPeakBytes,
    compactedSteadyStateBytes,
    observedDerivedStatePeakBytes,
    engineRss: {
      limitBytes: engineRssLimitBytes,
      sidecarPeakBytes: rss.sidecarPeakBytes,
      nodeHarnessPeakBytes: rss.nodeHarnessPeakBytes,
      combinedPeakBytes: rss.combinedPeakBytes,
      withinLimit: engineRssWithinLimit,
    },
    categories,
    byObject,
    unclassifiedObjects,
    rowCounts,
    ftsMetrics,
    integrity,
    foreignKeyViolations,
    gates: {
      ...diskGates,
      storageClassificationComplete,
      dbstatMatchesPageBytes,
      engineRssWithinLimit,
      ftsDensityMatchesCorpus,
      ftsBackendWithinLimit,
      allMeasuredCapacityGatesPassed:
        !diskGates.packedFactsRequired && storageClassificationComplete &&
        dbstatMatchesPageBytes && engineRssWithinLimit &&
        ftsDensityMatchesCorpus && ftsBackendWithinLimit,
    },
  };
}

function querySummary(database, sessionKeys, queryCount, warmupCount) {
  const point = database.prepare(
    `SELECT hex(c.generation) AS generation, hex(c.delta_id) AS deltaId,
            hex(c.canonical_digest) AS canonicalDigest, c.snapshot_seq AS snapshotSeq
     FROM session_commits AS c
     JOIN sessions AS s ON s.session_id=c.session_id
     WHERE s.session_key=?`,
  );
  const count = database.prepare("SELECT COUNT(*) AS value FROM session_commits");
  const pick = (index) => sessionKeys[(index * 7_919 + 17) % sessionKeys.length];
  for (let index = 0; index < warmupCount; index += 1) {
    point.get(Buffer.from(pick(index), "hex"));
  }
  const latencies = [];
  const digest = createHash("sha256");
  const start = performance.now();
  for (let index = 0; index < queryCount; index += 1) {
    const queryStart = performance.now();
    const row = point.get(Buffer.from(pick(index + warmupCount), "hex"));
    latencies.push(performance.now() - queryStart);
    if (row === undefined) throw new Error("point lookup missed a deterministic session key");
    digest.update(canonicalJson(row));
  }
  const wallMs = performance.now() - start;
  const committedSessions = Number(count.get().value);
  return {
    kind: "session-commit-point-lookup",
    implementation: "node:sqlite direct database read",
    queryCount,
    warmupCount,
    wallMs,
    p50Ms: percentile(latencies, 0.50),
    p95Ms: percentile(latencies, 0.95),
    p99Ms: percentile(latencies, 0.99),
    resultDigest: digest.digest("hex"),
    committedSessions,
  };
}

function latencySummary(values, unit = "ms") {
  if (values.length === 0) {
    return { unit, count: 0, total: 0, p50: 0, p95: 0, p99: 0, max: 0 };
  }
  return {
    unit,
    count: values.length,
    total: values.reduce((sum, value) => sum + value, 0),
    p50: percentile(values, 0.50),
    p95: percentile(values, 0.95),
    p99: percentile(values, 0.99),
    max: values.reduce((maximum, value) => Math.max(maximum, value), 0),
  };
}

function queryBudget(turnCount) {
  if (turnCount <= QUERY_BUDGETS.current.maximumTurns) {
    return { name: "current-25k", ...QUERY_BUDGETS.current };
  }
  if (turnCount > QUERY_BUDGETS.longTerm.maximumTurns) {
    throw new RangeError("query benchmark supports at most 250000 Turns");
  }
  return { name: "long-term-250k", ...QUERY_BUDGETS.longTerm };
}

export function evaluateOverviewLatencyGate({ turnCount, roundTripMs }) {
  positiveInteger(turnCount, "turnCount");
  const { p95, p99 } = roundTripMs ?? {};
  if (!Number.isFinite(p95) || !Number.isFinite(p99) || p95 < 0 || p99 < p95) {
    throw new TypeError("overview round-trip P95/P99 must be finite, non-negative, and ordered");
  }
  const budget = queryBudget(turnCount);
  const p95WithinLimit = p95 < budget.p95Ms;
  const p99WithinLimit = p99 < budget.p99Ms;
  return {
    budget: budget.name,
    p95LimitMs: budget.p95Ms,
    p99LimitMs: budget.p99Ms,
    p95WithinLimit,
    p99WithinLimit,
    withinLimit: p95WithinLimit && p99WithinLimit,
  };
}

export function evaluateInsightsQueryGates({
  turnCount,
  groups,
  sidecarPeakBytes,
  detailFullFtsBytes,
  derivedStateBytes,
}) {
  positiveInteger(turnCount, "turnCount");
  if (!Array.isArray(groups) || groups.length !== 2) {
    throw new TypeError("groups must contain the path-disabled and path-enabled measurements");
  }
  const pathLimits = groups.map(({ pathLimit }) => pathLimit).sort((left, right) => left - right);
  if (pathLimits[0] !== 0 || pathLimits[1] !== 10) {
    throw new TypeError("groups must measure pathLimit=0 and pathLimit=10");
  }
  for (const [name, value] of Object.entries({
    sidecarPeakBytes,
    detailFullFtsBytes,
    derivedStateBytes,
  })) {
    if (!Number.isSafeInteger(value) || value < 1) {
      throw new TypeError(`${name} must be a positive safe integer`);
    }
  }
  const budget = queryBudget(turnCount);
  const latency = groups.map((group) => {
    if (!Number.isSafeInteger(group.queryCount) || group.queryCount < 1) {
      throw new TypeError("group.queryCount must be a positive safe integer");
    }
    for (const name of [
      "emptyResultCount",
      "insufficientSampleCount",
      "evidencePathFamilyCount",
    ]) {
      if (!Number.isSafeInteger(group[name]) || group[name] < 0) {
        throw new TypeError(`group.${name} must be a non-negative safe integer`);
      }
    }
    const { p95, p99 } = group.roundTripMs ?? {};
    if (!Number.isFinite(p95) || !Number.isFinite(p99) || p95 < 0 || p99 < p95) {
      throw new TypeError("group round-trip P95/P99 must be finite, non-negative, and ordered");
    }
    return {
      pathLimit: group.pathLimit,
      queryCount: group.queryCount,
      p95Ms: p95,
      p99Ms: p99,
      p95WithinLimit: p95 < budget.p95Ms,
      p99WithinLimit: p99 < budget.p99Ms,
    };
  });
  const queryCountAtLeast1000 = groups.every(({ queryCount }) => queryCount >= 1_000);
  const warmupCountAtLeast100 = groups.every(
    ({ warmupCount }) => Number.isSafeInteger(warmupCount) && warmupCount >= 100,
  );
  const acceptanceCorpusExact = FORMAL_QUERY_BENCHMARK_TURN_COUNTS.includes(turnCount);
  const allQueriesReturnedResults = groups.every(({ emptyResultCount }) => emptyResultCount === 0);
  const pathDisabled = groups.find(({ pathLimit }) => pathLimit === 0);
  const pathEnabled = groups.find(({ pathLimit }) => pathLimit === 10);
  const toolPathWorkloadComplete =
    pathDisabled.evidencePathFamilyCount === 0 &&
    pathEnabled.insufficientSampleCount === 0 &&
    pathEnabled.evidencePathFamilyCount >= pathEnabled.queryCount;
  const allLatencyWithinLimit = latency.every(
    ({ p95WithinLimit, p99WithinLimit }) => p95WithinLimit && p99WithinLimit,
  );
  const sidecarRssWithinLimit = sidecarPeakBytes < budget.sidecarRssBytes;
  const detailFullFtsWithinLimit = detailFullFtsBytes < DETAIL_FULL_FTS_LIMIT_BYTES;
  const derivedStateWithinLimit = derivedStateBytes < budget.derivedStateBytes;
  return {
    budget: {
      name: budget.name,
      maximumTurns: budget.maximumTurns,
      p95Ms: budget.p95Ms,
      p99Ms: budget.p99Ms,
      sidecarRssBytes: budget.sidecarRssBytes,
      detailFullFtsBytes: DETAIL_FULL_FTS_LIMIT_BYTES,
      derivedStateBytes: budget.derivedStateBytes,
    },
    latency,
    acceptanceCorpusExact,
    queryCountAtLeast1000,
    warmupCountAtLeast100,
    allQueriesReturnedResults,
    toolPathWorkloadComplete,
    allLatencyWithinLimit,
    sidecarRssWithinLimit,
    detailFullFtsWithinLimit,
    derivedStateWithinLimit,
    allMeasuredQueryGatesPassed:
      acceptanceCorpusExact && queryCountAtLeast1000 && warmupCountAtLeast100 &&
      allQueriesReturnedResults && toolPathWorkloadComplete &&
      allLatencyWithinLimit && sidecarRssWithinLimit && detailFullFtsWithinLimit &&
      derivedStateWithinLimit,
  };
}

async function openNodeDatabase(databasePath) {
  const major = Number(process.versions.node.split(".")[0]);
  if (major < 22) {
    throw new Error("the node:sqlite reference benchmark requires Node 22.5 or newer");
  }
  const { DatabaseSync } = await import("node:sqlite");
  return new DatabaseSync(databasePath);
}

function configureReferenceDatabase(database) {
  database.exec(`
    PRAGMA foreign_keys=ON;
    PRAGMA synchronous=NORMAL;
    PRAGMA temp_store=FILE;
    PRAGMA journal_mode=WAL;
    CREATE TABLE engine_metadata (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    ) WITHOUT ROWID;
    INSERT INTO engine_metadata(key, value) VALUES ('snapshot_seq', '0');
    CREATE TABLE sessions (
      session_id INTEGER PRIMARY KEY,
      session_key BLOB NOT NULL UNIQUE,
      provider TEXT NOT NULL,
      session_scope TEXT NOT NULL,
      eligibility TEXT NOT NULL,
      duplicate_policy_version INTEGER NOT NULL
    );
    CREATE TABLE session_commits (
      session_id INTEGER PRIMARY KEY REFERENCES sessions(session_id) ON DELETE CASCADE,
      generation BLOB NOT NULL,
      delta_id BLOB NOT NULL,
      canonical_digest BLOB NOT NULL,
      snapshot_seq INTEGER NOT NULL
    );
  `);
}

export async function benchmarkNodeSqliteReference({
  databasePath,
  turnCount,
  turnsPerSession,
  queryCount,
  warmupCount,
  seed = DEFAULT_SEED,
}) {
  const corpus = createBenchmarkCorpus({ turnCount, turnsPerSession, seed });
  const database = await openNodeDatabase(databasePath);
  configureReferenceDatabase(database);
  const version = database.prepare("SELECT sqlite_version() AS value").get().value;
  const compileOptions = database.prepare("PRAGMA compile_options").all().map((row) => row.compile_options);
  const updateMetadata = database.prepare(
    "UPDATE engine_metadata SET value=? WHERE key='snapshot_seq'",
  );
  const insertSession = database.prepare(`
    INSERT INTO sessions(
      session_key, provider, session_scope, eligibility, duplicate_policy_version
    ) VALUES (?, ?, ?, ?, ?)
    RETURNING session_id AS sessionId
  `);
  const upsert = database.prepare(`
    INSERT INTO session_commits(session_id, generation, delta_id, canonical_digest, snapshot_seq)
    VALUES (?, ?, ?, ?, ?)
    ON CONFLICT(session_id) DO UPDATE SET
      generation=excluded.generation,
      delta_id=excluded.delta_id,
      canonical_digest=excluded.canonical_digest,
      snapshot_seq=excluded.snapshot_seq
  `);
  let peakRssBytes = process.memoryUsage().rss;
  const start = performance.now();
  for (let index = 0; index < corpus.sessions.length; index += 1) {
    const { delta, canonical } = corpus.sessions[index];
    const snapshotSeq = index + 1;
    database.exec("BEGIN IMMEDIATE");
    try {
      updateMetadata.run(String(snapshotSeq));
      const session = delta.session;
      const { sessionId } = insertSession.get(
        Buffer.from(session.sessionKey, "hex"),
        session.provider,
        session.sessionScope,
        session.eligibility,
        session.duplicatePolicyVersion,
      );
      upsert.run(
        sessionId,
        Buffer.from(BigInt(delta.targetGeneration).toString(16).padStart(16, "0"), "hex"),
        Buffer.from(delta.deltaId, "hex"),
        createHash("sha256").update(canonical).digest(),
        snapshotSeq,
      );
      database.exec("COMMIT");
    } catch (error) {
      database.exec("ROLLBACK");
      throw error;
    }
    peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  }
  const backfillMs = performance.now() - start;
  const query = querySummary(
    database,
    corpus.sessions.map((item) => item.delta.session.sessionKey),
    queryCount,
    warmupCount,
  );
  peakRssBytes = Math.max(peakRssBytes, process.memoryUsage().rss);
  database.close();

  return {
    engine: "node:sqlite-reference",
    sqliteVersion: version,
    fts5Enabled: compileOptions.includes("ENABLE_FTS5"),
    corpusDigest: corpus.digest,
    backfill: {
      wallMs: backfillMs,
      turnsPerSecond: corpus.turnCount / (backfillMs / 1_000),
      canonicalMiBPerSecond: (corpus.canonicalBytes / 1_048_576) / (backfillMs / 1_000),
    },
    rss: { peakBytes: peakRssBytes },
    databaseBytes: await databaseFootprint(databasePath),
    query,
  };
}

async function benchmarkRustSidecar({
  binaryPath,
  databasePath,
  corpus,
  queryCount,
  warmupCount,
}) {
  await access(binaryPath);
  const { stdout: versionStdout } = await execFileAsync(binaryPath, ["--version", "--json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const versionDocument = JSON.parse(versionStdout);
  const child = spawn(binaryPath, ["--db", databasePath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const responses = decodeProtocolFrames(child.stdout)[Symbol.asyncIterator]();
  const stopRssSampler = startRssSampler(child.pid);
  let requestWireBytes = 0;
  let responseWireBytes = 0;
  let requestFrameCount = 0;
  let responseFrameCount = 0;
  let preparationMs = 0;

  const processStart = performance.now();
  const hello = createHelloMessage({
    requestId: "1",
    clientVersion: "threadshare-benchmark@1",
    requiredContract: requiredContract(),
  });
  const helloFrame = encodeProtocolFrame(hello);
  await writeEncodedFrame(child.stdin, helloFrame);
  const ready = await nextResponse(responses, "READY", "1");
  assertHandshakeCompatible(hello, ready);
  const warmOpenMs = performance.now() - processStart;

  const backfillStart = performance.now();
  try {
    for (let index = 0; index < corpus.sessions.length; index += 1) {
      const { delta } = corpus.sessions[index];
      const requestId = String(index + 2);
      const messages = [];
      const prepareStart = performance.now();
      for await (const message of createSessionDeltaMessages(delta, {
        requestId,
        factStorageProfile: "normalized-row-v1",
        storageSchemaVersion: 1,
        projectionVersions: [...ACTIVE_INSIGHTS_PROJECTION_VERSIONS],
        analyzerCapabilities: [...ACTIVE_INSIGHTS_ANALYZER_CAPABILITIES],
        rankerVersion: 1,
      })) {
        messages.push({ message, frame: encodeProtocolFrame(message) });
      }
      preparationMs += performance.now() - prepareStart;

      for (const { message, frame } of messages) {
        requestWireBytes += frame.length;
        requestFrameCount += 1;
        await writeEncodedFrame(child.stdin, frame);
        const expectedType = message.type === "BEGIN_SESSION"
          ? "SESSION_ACCEPTED"
          : message.type === "COMMIT_SESSION"
            ? "SESSION_COMMITTED"
            : "BATCH_ACCEPTED";
        const response = await nextResponse(responses, expectedType, requestId);
        if (expectedType === "SESSION_COMMITTED" && response.idempotent !== false) {
          throw new Error("fresh benchmark corpus unexpectedly produced an idempotent commit");
        }
        responseWireBytes += encodeProtocolFrame(response).length;
        responseFrameCount += 1;
      }
    }
  } catch (error) {
    child.kill();
    throw new Error(`${error.message}${stderr ? `; engine stderr: ${stderr}` : ""}`);
  }
  const backfillMs = performance.now() - backfillStart;
  const rss = await stopRssSampler();
  child.stdin.end();
  const [exitCode] = await once(child, "close");
  if (exitCode !== 0) throw new Error(`Insights Engine exited ${exitCode}: ${stderr}`);

  const database = await openNodeDatabase(databasePath);
  const query = querySummary(
    database,
    corpus.sessions.map((item) => item.delta.session.sessionKey),
    queryCount,
    warmupCount,
  );
  database.close();

  return {
    engine: "rust-sidecar",
    engineVersion: versionDocument.engineVersion,
    target: versionDocument.target,
    sqliteVersion: ready.sqliteVersion,
    warmOpenMs,
    backfill: {
      wallMs: backfillMs,
      protocolPreparationMs: preparationMs,
      transportValidationStorageMs: Math.max(0, backfillMs - preparationMs),
      turnsPerSecond: corpus.turnCount / (backfillMs / 1_000),
      canonicalMiBPerSecond: (corpus.canonicalBytes / 1_048_576) / (backfillMs / 1_000),
    },
    protocol: {
      requestFrames: requestFrameCount,
      responseFrames: responseFrameCount,
      requestBytes: requestWireBytes,
      responseBytes: responseWireBytes,
      totalWireBytes: requestWireBytes + responseWireBytes,
      canonicalCorpusBytes: corpus.canonicalBytes,
      wireAmplification: ratio(requestWireBytes + responseWireBytes, corpus.canonicalBytes),
    },
    rss,
    databaseBytes: await databaseFootprint(databasePath),
    query: {
      ...query,
      implementation: "node:sqlite direct read of the Rust-created database",
      rustProtocolQueryAvailable: false,
    },
  };
}

async function openCapacitySidecar(binaryPath, databasePath, { sampleRss = true } = {}) {
  await access(binaryPath);
  const { stdout: versionStdout } = await execFileAsync(binaryPath, ["--version", "--json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const versionDocument = JSON.parse(versionStdout);
  const child = spawn(binaryPath, ["--db", databasePath], {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
  });
  let stderr = "";
  child.stderr.setEncoding("utf8");
  child.stderr.on("data", (chunk) => {
    stderr = `${stderr}${chunk}`.slice(-16_384);
  });
  const responses = decodeProtocolFrames(child.stdout)[Symbol.asyncIterator]();
  const stopRssSampler = sampleRss ? startRssSampler(child.pid) : null;
  const stats = {
    requestFrames: 0,
    responseFrames: 0,
    requestBytes: 0,
    responseBytes: 0,
    protocolPreparationMs: 0,
  };
  const start = performance.now();
  const hello = createHelloMessage({
    requestId: "1",
    clientVersion: "threadshare-capacity-benchmark@1",
    requiredContract: requiredContract(),
  });
  const helloFrame = encodeProtocolFrame(hello);
  await writeEncodedFrame(child.stdin, helloFrame);
  stats.requestFrames += 1;
  stats.requestBytes += helloFrame.length;
  const ready = await nextResponse(responses, "READY", "1");
  const readyFrame = encodeProtocolFrame(ready);
  stats.responseFrames += 1;
  stats.responseBytes += readyFrame.length;
  assertHandshakeCompatible(hello, ready);
  return {
    child,
    responses,
    ready,
    versionDocument,
    stats,
    warmOpenMs: performance.now() - start,
    stopRssSampler,
    stderr: () => stderr,
  };
}

async function sendCapacityDelta(runtime, delta, requestId) {
  let committed = null;
  let prepareCursor = performance.now();
  const messages = createSessionDeltaMessages(delta, {
    requestId,
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: [...ACTIVE_INSIGHTS_PROJECTION_VERSIONS],
    analyzerCapabilities: [...ACTIVE_INSIGHTS_ANALYZER_CAPABILITIES],
    rankerVersion: 1,
  });
  for await (const message of messages) {
    const frame = encodeProtocolFrame(message);
    runtime.stats.protocolPreparationMs += performance.now() - prepareCursor;
    runtime.stats.requestFrames += 1;
    runtime.stats.requestBytes += frame.length;
    await writeEncodedFrame(runtime.child.stdin, frame);
    const expectedType = message.type === "BEGIN_SESSION"
      ? "SESSION_ACCEPTED"
      : message.type === "COMMIT_SESSION"
        ? "SESSION_COMMITTED"
        : "BATCH_ACCEPTED";
    const response = await nextResponse(runtime.responses, expectedType, requestId);
    const responseFrame = encodeProtocolFrame(response);
    runtime.stats.responseFrames += 1;
    runtime.stats.responseBytes += responseFrame.length;
    if (expectedType === "SESSION_COMMITTED") committed = response;
    prepareCursor = performance.now();
  }
  if (committed === null) throw new Error("capacity delta did not commit");
  return committed;
}

async function sendCapacityRequest(runtime, message, expectedType) {
  const frame = encodeProtocolFrame(message);
  runtime.stats.requestFrames += 1;
  runtime.stats.requestBytes += frame.length;
  await writeEncodedFrame(runtime.child.stdin, frame);
  const response = await nextResponse(runtime.responses, expectedType, message.requestId);
  const responseFrame = encodeProtocolFrame(response);
  runtime.stats.responseFrames += 1;
  runtime.stats.responseBytes += responseFrame.length;
  return response;
}

function capacitySearchFilters() {
  return {
    providers: [],
    projectKeys: [],
    observedAtOrAfterUnixMs: null,
    observedBeforeUnixMs: null,
    toolCapabilityKeys: [],
    skillCapabilityKeys: [],
    resultEvidence: [],
    closureStates: [],
  };
}

function capacitySearchText(plan, queryIndex) {
  const topicCount = Math.min(CAPACITY_TOPIC_COUNT, plan.turnCount);
  const topicIndex = (queryIndex * 37 + 11) % topicCount;
  return `topic${alphabeticOrdinal(topicIndex)}`;
}

function mutationCapacitySearchText(plan, queryIndex) {
  const topic = capacitySearchText(plan, queryIndex);
  const uniqueTerm = `unique${alphabeticOrdinal(queryIndex)}xa`;
  return `${topic} ${uniqueTerm}`;
}

function mutationQueryClock(plan) {
  return Object.freeze({
    nowUnixMs: String(BASE_TIME_MS + (plan.turnCount + 3_600) * 1_000),
    quiescenceSeconds: 300,
  });
}

function normalizedToolPathFamilies(evidencePaths) {
  return {
    pathsTruncated: evidencePaths.pathsTruncated,
    families: evidencePaths.families.map((family) => ({
      fingerprint: family.fingerprint,
      medoid: family.nodes.map((node) => ({
        providerScopedName: node.providerScopedName,
        repeatBucket: node.repeatBucket,
      })),
      members: [...family.evidenceTurnKeys],
    })),
  };
}

async function collectMutationQuerySnapshot({
  runtime,
  plan,
  count,
  clock,
  requestIdStart,
}) {
  const digests = {
    candidateTurnKeys: [],
    resultTurnOrder: [],
    toolPathFamilies: [],
  };
  const distinctQueries = new Set();
  let resultQueryCount = 0;
  let toolPathFamilyQueryCount = 0;
  for (let index = 0; index < count; index += 1) {
    const query = mutationCapacitySearchText(plan, index);
    distinctQueries.add(query);
    const response = await sendCapacityRequest(
      runtime,
      createSearchTurnsMessage({
        requestId: String(requestIdStart + index),
        query,
        filters: capacitySearchFilters(),
        limit: 20,
        pathLimit: 10,
        nowUnixMs: clock.nowUnixMs,
        quiescenceSeconds: clock.quiescenceSeconds,
      }),
      "TURN_SEARCH_RESULTS",
    );
    if (response.results.length > 0) resultQueryCount += 1;
    if (response.evidencePaths.families.length > 0) toolPathFamilyQueryCount += 1;
    digests.candidateTurnKeys.push(sha256(canonicalJson({
      index,
      query,
      candidateTurnKeys: response.searchTrace.candidateTurnKeys,
    })));
    digests.resultTurnOrder.push(sha256(canonicalJson({
      index,
      query,
      results: response.results.map(({ turnKey }) => turnKey),
    })));
    digests.toolPathFamilies.push(sha256(canonicalJson({
      index,
      query,
      ...normalizedToolPathFamilies(response.evidencePaths),
    })));
  }
  return {
    count,
    distinctQueryCount: distinctQueries.size,
    resultQueryCount,
    toolPathFamilyQueryCount,
    clockIdentity: sha256(canonicalJson(clock)),
    digests,
  };
}

function mutationQueryEquivalence(incremental, cleanRebuild) {
  const equality = (incrementalValues, cleanRebuildValues) => ({
    incremental: sha256(canonicalJson(incrementalValues)),
    cleanRebuild: sha256(canonicalJson(cleanRebuildValues)),
    equal:
      incrementalValues.length === cleanRebuildValues.length &&
      incrementalValues.every((value, index) => value === cleanRebuildValues[index]),
  });
  const clockIdentity = {
    incremental: incremental.clockIdentity,
    cleanRebuild: cleanRebuild.clockIdentity,
    equal: incremental.clockIdentity === cleanRebuild.clockIdentity,
  };
  const countEquality = (name) => ({
    incremental: incremental[name],
    cleanRebuild: cleanRebuild[name],
    equal: incremental[name] === cleanRebuild[name],
  });
  const coverage = {
    distinctQueryCount: countEquality("distinctQueryCount"),
    resultQueryCount: countEquality("resultQueryCount"),
    toolPathFamilyQueryCount: countEquality("toolPathFamilyQueryCount"),
  };
  const allQueriesExercised = Object.values(coverage).every(
    ({ incremental: value, cleanRebuild: clean, equal }) =>
      equal && value === incremental.count && clean === cleanRebuild.count,
  );
  const digests = {
    candidateTurnKeys: equality(
      incremental.digests.candidateTurnKeys,
      cleanRebuild.digests.candidateTurnKeys,
    ),
    resultTurnOrder: equality(
      incremental.digests.resultTurnOrder,
      cleanRebuild.digests.resultTurnOrder,
    ),
    toolPathFamilies: equality(
      incremental.digests.toolPathFamilies,
      cleanRebuild.digests.toolPathFamilies,
    ),
  };
  return {
    count: incremental.count,
    pathLimit: 10,
    clockIdentity,
    coverage,
    digests,
    allQueriesExercised,
    allEqual:
      incremental.count === cleanRebuild.count &&
      clockIdentity.equal &&
      allQueriesExercised &&
      Object.values(digests).every(({ equal }) => equal),
  };
}

async function benchmarkCapacitySearchGroup({
  runtime,
  plan,
  queryCount,
  warmupCount,
  pathLimit,
  requestIdStart,
}) {
  const stageValues = {
    analyzeMicros: [],
    dfMicros: [],
    postingFilterMicros: [],
    rerankMicros: [],
    pathMicros: [],
  };
  const roundTrips = [];
  const digest = createHash("sha256");
  let resultCount = 0;
  let emptyResultCount = 0;
  let insufficientSampleCount = 0;
  let evidencePathFamilyCount = 0;
  const total = warmupCount + queryCount;
  for (let index = 0; index < total; index += 1) {
    const query = capacitySearchText(plan, index);
    const requestId = String(requestIdStart + index);
    const message = createSearchTurnsMessage({
      requestId,
      query,
      filters: capacitySearchFilters(),
      limit: 20,
      pathLimit,
      nowUnixMs: String(BASE_TIME_MS + (plan.turnCount + 3_600) * 1_000),
      quiescenceSeconds: 300,
    });
    const started = performance.now();
    const response = await sendCapacityRequest(runtime, message, "TURN_SEARCH_RESULTS");
    const roundTripMs = performance.now() - started;
    if (index < warmupCount) continue;
    roundTrips.push(roundTripMs);
    for (const name of Object.keys(stageValues)) {
      stageValues[name].push(response.diagnostic[name]);
    }
    resultCount += response.results.length;
    if (response.results.length === 0) emptyResultCount += 1;
    if (response.evidencePaths.insufficientSample) insufficientSampleCount += 1;
    evidencePathFamilyCount += response.evidencePaths.families.length;
    digest.update(canonicalJson({
      query,
      snapshot: response.snapshot,
      scoringTerms: response.scoringTerms,
      results: response.results,
      evidencePaths: response.evidencePaths,
    }));
  }
  return {
    pathLimit,
    queryCount,
    warmupCount,
    resultCount,
    emptyResultCount,
    insufficientSampleCount,
    evidencePathFamilyCount,
    resultDigest: digest.digest("hex"),
    roundTripMs: latencySummary(roundTrips, "ms"),
    diagnosticStages: {
      analyze: latencySummary(stageValues.analyzeMicros, "microseconds"),
      documentFrequencySeek: latencySummary(stageValues.dfMicros, "microseconds"),
      postingAndFilterCombined: {
        ...latencySummary(stageValues.postingFilterMicros, "microseconds"),
        attribution:
          "combined FTS posting traversal and SQL filter intersection; " +
          "the Engine diagnostic does not expose a defensible split",
      },
      rerank: latencySummary(stageValues.rerankMicros, "microseconds"),
      toolPath: latencySummary(stageValues.pathMicros, "microseconds"),
    },
  };
}

async function benchmarkCapacitySearch(runtime, plan, queryCount, warmupCount) {
  const stopQueryRssSampler = startRssSampler(runtime.child.pid);
  try {
    const groups = [];
    let requestIdStart = plan.sessionCount + 10_000;
    for (const pathLimit of [0, 10]) {
      groups.push(await benchmarkCapacitySearchGroup({
        runtime,
        plan,
        queryCount,
        warmupCount,
        pathLimit,
        requestIdStart,
      }));
      requestIdStart += queryCount + warmupCount + 1;
    }
    return {
      queryShape:
        "deterministic low-frequency topic term over the capacity corpus; no raw-session reads",
      stageAttribution:
        "analyze, df seek, combined posting/filter, rerank, and Tool-path timings are " +
        "reported from the Engine; posting and filter are not falsely separated",
      groups,
      rss: await stopQueryRssSampler(),
    };
  } catch (error) {
    await stopQueryRssSampler();
    throw error;
  }
}

async function benchmarkCapacityOverview(
  runtime,
  plan,
  queryCount,
  warmupCount,
  expectedSnapshotSeq,
) {
  const roundTrips = [];
  const total = warmupCount + queryCount;
  const requestIdStart = 2_000_000;
  let payloadDigest = null;
  let payloadMismatchCount = 0;
  let snapshotMismatchCount = 0;
  for (let index = 0; index < total; index += 1) {
    const message = createReadInsightsOverviewMessage({
      requestId: String(requestIdStart + index),
      nowUnixMs: String(BASE_TIME_MS + (plan.turnCount + 3_600) * 1_000),
      quiescenceSeconds: 300,
    });
    const started = performance.now();
    const response = await sendCapacityRequest(runtime, message, "INSIGHTS_OVERVIEW");
    const roundTripMs = performance.now() - started;
    if (index < warmupCount) continue;
    roundTrips.push(roundTripMs);
    if (response.snapshotSeq !== expectedSnapshotSeq) snapshotMismatchCount += 1;
    const { requestId: _requestId, ...payload } = response;
    const currentDigest = sha256(canonicalJson(payload));
    if (payloadDigest === null) payloadDigest = currentDigest;
    else if (payloadDigest !== currentDigest) payloadMismatchCount += 1;
  }
  const latency = latencySummary(roundTrips, "ms");
  const latencyGate = evaluateOverviewLatencyGate({
    turnCount: plan.turnCount,
    roundTripMs: latency,
  });
  const requestsComplete = roundTrips.length === queryCount;
  const snapshotStable = snapshotMismatchCount === 0;
  const payloadStable = payloadDigest !== null && payloadMismatchCount === 0;
  return {
    measurement: "Rust sidecar READ_INSIGHTS_OVERVIEW over transactional rollups",
    measuredRequestCount: queryCount,
    warmupRequestCount: warmupCount,
    totalRequestCount: total,
    requestIdRange: {
      first: String(requestIdStart),
      last: String(requestIdStart + total - 1),
    },
    payloadDigest,
    payloadMismatchCount,
    snapshotMismatchCount,
    roundTripMs: latency,
    gates: {
      ...latencyGate,
      requestsComplete,
      snapshotStable,
      payloadStable,
      allMeasuredOverviewGatesPassed:
        latencyGate.withinLimit && requestsComplete && snapshotStable && payloadStable,
    },
  };
}

async function closeCapacitySidecar(runtime) {
  const rss = runtime.stopRssSampler ? await runtime.stopRssSampler() : null;
  runtime.child.stdin.end();
  const [exitCode] = await once(runtime.child, "close");
  if (exitCode !== 0) {
    throw new Error(`Insights Engine exited ${exitCode}: ${runtime.stderr()}`);
  }
  return rss;
}

async function measurePopulatedCapacityStartupOnce(
  binaryPath,
  databasePath,
  plan,
  expectedSnapshotSeq,
) {
  const runtime = await openCapacitySidecar(binaryPath, databasePath, { sampleRss: false });
  const overviewStarted = performance.now();
  try {
    const overview = await sendCapacityRequest(
      runtime,
      createReadInsightsOverviewMessage({
        requestId: "2",
        nowUnixMs: String(BASE_TIME_MS + (plan.turnCount + 3_600) * 1_000),
        quiescenceSeconds: 300,
      }),
      "INSIGHTS_OVERVIEW",
    );
    const firstOverviewReadMs = performance.now() - overviewStarted;
    if (overview.snapshotSeq !== expectedSnapshotSeq) {
      throw new Error(
        `populated capacity overview reopened at snapshot ${overview.snapshotSeq}; ` +
        `expected committed snapshot ${expectedSnapshotSeq}`,
      );
    }
    const statusStarted = performance.now();
    const status = await sendCapacityRequest(
      runtime,
      createReadEngineStatusMessage({ requestId: "3" }),
      "ENGINE_STATUS",
    );
    const integrityStatusReadMs = performance.now() - statusStarted;
    if (status.snapshotSeq !== expectedSnapshotSeq || status.snapshotPending !== false) {
      throw new Error(
        `populated capacity database reopened at snapshot ${status.snapshotSeq}; ` +
        `expected committed snapshot ${expectedSnapshotSeq}`,
      );
    }
    await closeCapacitySidecar(runtime);
    return {
      readyMs: runtime.warmOpenMs,
      firstOverviewReadMs,
      readyAndFirstOverviewMs: runtime.warmOpenMs + firstOverviewReadMs,
      integrityStatusReadMs,
      readyOverviewAndIntegrityStatusMs:
        runtime.warmOpenMs + firstOverviewReadMs + integrityStatusReadMs,
      status,
    };
  } catch (error) {
    runtime.child.kill();
    throw new Error(
      `${error.message}${runtime.stderr() ? `; engine stderr: ${runtime.stderr()}` : ""}`,
    );
  }
}

async function measurePopulatedCapacityStartup(
  binaryPath,
  databasePath,
  plan,
  expectedSnapshotSeq,
  sampleCount = 3,
) {
  const samples = [];
  for (let index = 0; index < sampleCount; index += 1) {
    samples.push(await measurePopulatedCapacityStartupOnce(
      binaryPath,
      databasePath,
      plan,
      expectedSnapshotSeq,
    ));
  }
  const readyMs = percentile(samples.map((sample) => sample.readyMs), 0.5);
  const firstOverviewReadMs = percentile(
    samples.map((sample) => sample.firstOverviewReadMs),
    0.5,
  );
  const readyAndFirstOverviewMs = percentile(
    samples.map((sample) => sample.readyAndFirstOverviewMs),
    0.5,
  );
  const integrityStatusReadMs = percentile(
    samples.map((sample) => sample.integrityStatusReadMs),
    0.5,
  );
  const readyOverviewAndIntegrityStatusMs = percentile(
    samples.map((sample) => sample.readyOverviewAndIntegrityStatusMs),
    0.5,
  );
  return {
    readyMs,
    firstOverviewReadMs,
    readyAndFirstOverviewMs,
    integrityStatusReadMs,
    readyOverviewAndIntegrityStatusMs,
    status: samples[0].status,
    sampleCount: samples.length,
    samples: samples.map(({
      readyMs,
      firstOverviewReadMs,
      readyAndFirstOverviewMs,
      integrityStatusReadMs,
      readyOverviewAndIntegrityStatusMs,
    }) => ({
      readyMs,
      firstOverviewReadMs,
      readyAndFirstOverviewMs,
      integrityStatusReadMs,
      readyOverviewAndIntegrityStatusMs,
    })),
    gate: {
      limitMs: 500,
      medianReadyAndFirstOverviewUnder500Ms: readyAndFirstOverviewMs < 500,
    },
  };
}

async function productFreshnessFactCounts(databasePath) {
  const database = await openNodeDatabase(databasePath);
  try {
    return {
      sessions: Number(database.prepare("SELECT COUNT(*) AS value FROM sessions").get().value),
      turns: Number(database.prepare("SELECT COUNT(*) AS value FROM turns").get().value),
      ftsDocuments: Number(
        database.prepare("SELECT COUNT(*) AS value FROM turn_fts_documents").get().value,
      ),
    };
  } finally {
    database.close();
  }
}

async function searchProductFreshnessMarker({
  binaryPath,
  databasePath,
  paths,
  turnCount,
  marker,
}) {
  const client = await createInsightsEngineClient({
    databasePath,
    requiredContract: insightsRequiredContract(ORIGIN_SECRET_EPOCH),
    runtimeOptions: {
      env: {
        ...process.env,
        THREADSHARE_INSIGHTS_ENGINE_PATH: path.resolve(binaryPath),
      },
    },
    childEnv: {
      ...process.env,
      SQLITE_TMPDIR: paths.tempDirectory,
      TMPDIR: paths.tempDirectory,
      TEMP: paths.tempDirectory,
      TMP: paths.tempDirectory,
    },
    timeoutMs: 120_000,
  });
  try {
    return await client.searchTurns({
      query: marker,
      filters: capacitySearchFilters(),
      limit: 20,
      pathLimit: 0,
      nowUnixMs: String(BASE_TIME_MS + (turnCount + 7_200) * 1_000),
      quiescenceSeconds: 300,
    });
  } finally {
    await client.close();
  }
}

async function measureCapacityProductAppendFreshness({
  binaryPath,
  databasePath,
  plan,
}) {
  const stateDirectory = `${databasePath}.product-freshness`;
  const probeDatabasePath = path.join(stateDirectory, "insights.sqlite3");
  const paths = {
    stateDirectory,
    configFile: path.join(stateDirectory, "config.json"),
    databaseFile: probeDatabasePath,
    originSecretFile: path.join(stateDirectory, "origin-secret.json"),
    lockFile: path.join(stateDirectory, "insights.lock"),
    tempDirectory: path.join(stateDirectory, "tmp"),
  };
  let worker = null;
  try {
    await rm(stateDirectory, { recursive: true, force: true });
    await mkdir(paths.tempDirectory, { recursive: true, mode: 0o700 });
    await copyFile(databasePath, probeDatabasePath, fsConstants.COPYFILE_FICLONE);
    await writeFile(paths.originSecretFile, `${JSON.stringify({
      format: INSIGHTS_ORIGIN_SECRET_FORMAT,
      originSecretEpoch: ORIGIN_SECRET_EPOCH,
      secret: Buffer.alloc(32, 0x52).toString("base64url"),
    })}\n`, { mode: 0o600, flag: "wx" });
    const corpus = await writeRawBackfillCorpus({
      directory: path.join(stateDirectory, "corpus"),
      sessionCount: 1,
      textCharacters: 4_096,
      seed: `${plan.seed}-product-freshness`,
    });
    const target = corpus.sessions[0];
    const baseline = await productFreshnessFactCounts(probeDatabasePath);
    if (
      baseline.sessions !== plan.sessionCount ||
      baseline.turns !== plan.turnCount ||
      baseline.ftsDocuments !== plan.turnCount
    ) {
      throw new Error("product freshness clone does not match the formal capacity corpus");
    }
    const requiredContract = insightsRequiredContract(ORIGIN_SECRET_EPOCH);
    const runtimeOptions = {
      env: {
        ...process.env,
        THREADSHARE_INSIGHTS_ENGINE_PATH: path.resolve(binaryPath),
      },
    };
    const reconciliationOptions = {
      paths,
      discoveryOptions: { environment: corpus.environment },
      runtimeOptions,
      timeoutMs: 120_000,
      concurrency: 1,
    };
    const seeded = await reconcileActiveInsights(reconciliationOptions);
    if (seeded.report.committed !== 1 || seeded.report.failed !== 0) {
      throw new Error("product freshness baseline source did not commit exactly once");
    }

    let appendStarted = null;
    let commitAckMs = null;
    const createMeasuredEngineClient = async (options) => instrumentEngine(
      await createInsightsEngineClient(options),
      (input) => {
        if (
          appendStarted !== null &&
          commitAckMs === null &&
          input.sourceState.file === target.file
        ) {
          commitAckMs = performance.now() - appendStarted;
        }
      },
    );
    const observer = createWorkerCycleObserver();
    worker = createInsightsBackgroundWorker({
      ...reconciliationOptions,
      createEngineClient: createMeasuredEngineClient,
      workerOptions: {
        watchRoots: corpus.watchRoots,
        debounceMs: 100,
        pollIntervalMs: 60_000,
        onCycle({ reasons, report }) {
          observer.onCycle({
            report: Object.freeze({ reasons, report: report?.report }),
          });
        },
        onError: observer.onError,
      },
    });
    const startupCycle = observer.waitFor(
      (report) => report?.report?.unchanged === 1 && report.report.failed === 0,
      30_000,
    );
    worker.start();
    await startupCycle;
    await worker.whenIdle();

    const marker = `capacityfresh${plan.turnCount.toString(36)}`;
    const appendCycle = observer.waitFor(
      (report) =>
        report?.report?.committed === 1 &&
        report.report.failed === 0 &&
        report.reasons.includes("filesystem"),
      30_000,
    );
    appendStarted = performance.now();
    const appended = rawBenchmarkRecords(
      target.provider,
      target.sessionId,
      target.index,
      4_096,
      marker,
    ).filter((record) => record.type !== "session_meta");
    await appendFile(target.file, jsonlBytes(appended));
    const appendedReport = await appendCycle;
    await worker.whenIdle();
    const search = await searchProductFreshnessMarker({
      binaryPath,
      databasePath: probeDatabasePath,
      paths,
      turnCount: plan.turnCount,
      marker,
    });
    const appendToSearchableMs = performance.now() - appendStarted;

    const cleanupCycle = observer.waitFor(
      (report) => report?.report?.missing === 1 && report.report.failed === 0,
      30_000,
    );
    await rm(target.file);
    const cleanupReport = await cleanupCycle;
    await worker.whenIdle();
    const cleanupSearch = await searchProductFreshnessMarker({
      binaryPath,
      databasePath: probeDatabasePath,
      paths,
      turnCount: plan.turnCount,
      marker,
    });
    const afterCleanup = await productFreshnessFactCounts(probeDatabasePath);
    const cleanupRestored = canonicalJson(afterCleanup) === canonicalJson(baseline) &&
      cleanupSearch.results.length === 0;
    const productPathUsed = appendedReport.reasons.includes("filesystem");
    const gate = {
      limitMs: 2_000,
      productPathUsed,
      commitAcknowledged: commitAckMs !== null,
      markerUniquelySearchable: search.results.length === 1,
      cleanupRestored,
      appendedTurnWithin2Seconds:
        commitAckMs !== null &&
        search.results.length === 1 &&
        cleanupRestored &&
        appendToSearchableMs <= 2_000,
    };
    return {
      measurement:
        "createInsightsBackgroundWorker -> reconcileActiveInsights -> SEARCH_TURNS",
      corpusTurnCount: plan.turnCount,
      baseline,
      append: {
        commitAckMs,
        appendToSearchableMs,
        committed: appendedReport.report.committed,
        searchResultCount: search.results.length,
      },
      cleanup: {
        missing: cleanupReport.report.missing,
        searchResultCount: cleanupSearch.results.length,
        restored: cleanupRestored,
      },
      gate,
    };
  } finally {
    await worker?.stop().catch(() => {});
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

async function benchmarkCapacitySidecar({
  binaryPath,
  databasePath,
  plan,
  queryCount,
  warmupCount,
}) {
  const runtime = await openCapacitySidecar(binaryPath, databasePath);
  const digest = createHash("sha256");
  const sessionKeys = [];
  let canonicalBytes = 0;
  let maxSessionCanonicalBytes = 0;
  let lastCommittedSnapshotSeq = null;
  let corpusGenerationMs = 0;
  const started = performance.now();
  try {
    const sessions = plan.stream()[Symbol.iterator]();
    while (true) {
      const generationStarted = performance.now();
      const next = sessions.next();
      if (next.done) {
        corpusGenerationMs += performance.now() - generationStarted;
        break;
      }
      const session = next.value;
      digest.update(session.canonical);
      const bytes = Buffer.byteLength(session.canonical, "utf8");
      canonicalBytes += bytes;
      maxSessionCanonicalBytes = Math.max(maxSessionCanonicalBytes, bytes);
      sessionKeys.push(session.delta.session.sessionKey);
      corpusGenerationMs += performance.now() - generationStarted;
      const response = await sendCapacityDelta(
        runtime,
        session.delta,
        String(session.sessionIndex + 2),
      );
      if (response.idempotent !== false) {
        throw new Error("fresh capacity corpus unexpectedly produced an idempotent commit");
      }
      lastCommittedSnapshotSeq = response.snapshotSeq;
    }
  } catch (error) {
    runtime.child.kill();
    throw new Error(`${error.message}${runtime.stderr() ? `; engine stderr: ${runtime.stderr()}` : ""}`);
  }
  const backfillMs = performance.now() - started;
  let search;
  let overview;
  let rss;
  try {
    search = await benchmarkCapacitySearch(runtime, plan, queryCount, warmupCount);
    overview = await benchmarkCapacityOverview(
      runtime,
      plan,
      queryCount,
      warmupCount,
      lastCommittedSnapshotSeq,
    );
    rss = await closeCapacitySidecar(runtime);
  } catch (error) {
    runtime.child.kill();
    throw new Error(`${error.message}${runtime.stderr() ? `; engine stderr: ${runtime.stderr()}` : ""}`);
  }
  if (lastCommittedSnapshotSeq === null) {
    throw new Error("capacity corpus did not commit any sessions");
  }
  const populatedStartup = await measurePopulatedCapacityStartup(
    binaryPath,
    databasePath,
    plan,
    lastCommittedSnapshotSeq,
  );
  const database = await openNodeDatabase(databasePath);
  const query = querySummary(database, sessionKeys, queryCount, warmupCount);
  database.close();
  const capacityAudit = await auditCapacityDatabase(databasePath, {
    stagingUpperBoundBytes: maxSessionCanonicalBytes,
    rss,
    turnCount: plan.turnCount,
  });
  const productAppendFreshness = await measureCapacityProductAppendFreshness({
    binaryPath,
    databasePath,
    plan,
  });
  const populatedWarmOpenUnder500Ms =
    populatedStartup.gate.medianReadyAndFirstOverviewUnder500Ms;
  const productAppendWithin2Seconds =
    productAppendFreshness.gate.appendedTurnWithin2Seconds;
  const capacity = {
    ...capacityAudit,
    gates: {
      ...capacityAudit.gates,
      populatedWarmOpenUnder500Ms,
      productAppendWithin2Seconds,
      overviewLatencyWithinLimit: overview.gates.allMeasuredOverviewGatesPassed,
      allMeasuredCapacityGatesPassed:
        capacityAudit.gates.allMeasuredCapacityGatesPassed && populatedWarmOpenUnder500Ms &&
        productAppendWithin2Seconds && overview.gates.allMeasuredOverviewGatesPassed,
    },
  };
  const searchWithGates = {
    ...search,
    storage: {
      measurementPhase: "post-vacuum capacity audit",
      detailFullFtsBytes: capacity.categories.fts.bytes,
      derivedStateBytes: capacity.compactedSteadyStateBytes,
      observedDerivedStatePeakBytes: capacity.observedDerivedStatePeakBytes,
      databasePageBytes: capacity.databasePageBytes,
    },
    gates: evaluateInsightsQueryGates({
      turnCount: plan.turnCount,
      groups: search.groups,
      sidecarPeakBytes: search.rss.sidecarPeakBytes,
      detailFullFtsBytes: capacity.categories.fts.bytes,
      derivedStateBytes: capacity.compactedSteadyStateBytes,
    }),
  };
  const engineBackfillMs = Math.max(
    0,
    backfillMs - corpusGenerationMs - runtime.stats.protocolPreparationMs,
  );
  if (engineBackfillMs === 0) {
    throw new Error("capacity engine backfill time was not measurable");
  }
  return {
    engine: "rust-sidecar",
    engineIdentity: {
      ...runtime.versionDocument,
      binarySha256: sha256(await readFile(binaryPath)),
    },
    engineVersion: runtime.versionDocument.engineVersion,
    target: runtime.versionDocument.target,
    sqliteVersion: runtime.ready.sqliteVersion,
    startup: {
      emptyDatabase: { readyMs: runtime.warmOpenMs },
      populatedDatabase: populatedStartup,
    },
    productAppendFreshness,
    corpusDigest: digest.digest("hex"),
    canonicalBytes,
    maxSessionCanonicalBytes,
    backfill: {
      wallMs: backfillMs,
      corpusGenerationMs,
      protocolPreparationMs: runtime.stats.protocolPreparationMs,
      engineBackfillMs,
      endToEndTurnsPerSecond: plan.turnCount / (backfillMs / 1_000),
      engineTurnsPerSecond: plan.turnCount / (engineBackfillMs / 1_000),
      endToEndCanonicalMiBPerSecond:
        (canonicalBytes / 1_048_576) / (backfillMs / 1_000),
      engineCanonicalMiBPerSecond:
        (canonicalBytes / 1_048_576) / (engineBackfillMs / 1_000),
    },
    protocol: {
      ...runtime.stats,
      totalWireBytes: runtime.stats.requestBytes + runtime.stats.responseBytes,
      wireAmplification: ratio(
        runtime.stats.requestBytes + runtime.stats.responseBytes,
        canonicalBytes,
      ),
    },
    rss,
    query: {
      ...query,
      measurementPhase: "before-vacuum-capacity-maintenance",
    },
    search: searchWithGates,
    overview,
    capacity,
  };
}

async function removeDatabaseGroup(databasePath) {
  await Promise.all(
    ["", "-wal", "-shm"].map((suffix) => rm(`${databasePath}${suffix}`, { force: true })),
  );
}

async function collectCleanMutationQuerySnapshot({
  binaryPath,
  databasePath,
  plan,
  count,
  clock,
}) {
  const cleanDatabasePath = `${databasePath}.query-equivalence-clean`;
  await removeDatabaseGroup(cleanDatabasePath);
  const runtime = await openCapacitySidecar(binaryPath, cleanDatabasePath, { sampleRss: false });
  try {
    let requestId = 1_000;
    for (let sessionIndex = 0; sessionIndex < plan.sessionCount; sessionIndex += 1) {
      if (sessionIndex === 1 || sessionIndex === 2) continue;
      const session = sessionIndex === 0
        ? plan.sessionAt(0, { generation: 1, replacement: true })
        : plan.sessionAt(sessionIndex);
      await sendCapacityDelta(runtime, session.delta, String(requestId));
      requestId += 1;
    }
    const snapshot = await collectMutationQuerySnapshot({
      runtime,
      plan,
      count,
      clock,
      requestIdStart: 1_000_000,
    });
    await closeCapacitySidecar(runtime);
    return snapshot;
  } catch (error) {
    runtime.child.kill();
    throw new Error(`${error.message}${runtime.stderr() ? `; engine stderr: ${runtime.stderr()}` : ""}`);
  } finally {
    await removeDatabaseGroup(cleanDatabasePath);
  }
}

async function runCapacityMutationTrace({
  binaryPath,
  databasePath,
  plan,
  queryEquivalenceCount = 0,
}) {
  if (plan.sessionCount < 3) {
    throw new RangeError("capacity mutation trace requires at least three sessions");
  }
  if (!Number.isSafeInteger(queryEquivalenceCount) || queryEquivalenceCount < 0) {
    throw new RangeError("capacity mutation query count must be a non-negative safe integer");
  }
  const runtime = await openCapacitySidecar(binaryPath, databasePath, { sampleRss: false });
  const steps = [];
  const clock = mutationQueryClock(plan);
  let incrementalQuerySnapshot = null;
  const time = async (kind, action) => {
    const started = performance.now();
    const outcome = await action();
    steps.push({ kind, wallMs: performance.now() - started, outcome });
    return outcome;
  };
  try {
    const replacement = plan.sessionAt(0, { generation: 2, replacement: true });
    await time("replace-session", async () => {
      const response = await sendCapacityDelta(runtime, replacement.delta, "10");
      return { committed: response.idempotent === false, snapshotSeq: response.snapshotSeq };
    });
    await time("delete-source", async () => {
      const response = await sendCapacityRequest(
        runtime,
        createRemoveSourceMessage({ requestId: "11", sessionKey: plan.sessionKey(1) }),
        "SOURCE_REMOVED",
      );
      return { removed: response.removed };
    });
    await time("exclude-source", async () => {
      const response = await sendCapacityRequest(
        runtime,
        createExcludeSourceMessage({ requestId: "12", sessionKey: plan.sessionKey(2) }),
        "SOURCE_EXCLUDED",
      );
      return { excluded: response.excluded, purgeState: response.purgeState };
    });
    await time("purge-maintenance", async () => {
      const response = await sendCapacityRequest(
        runtime,
        createRunPurgeMaintenanceMessage({ requestId: "13", limit: 8 }),
        "PURGE_MAINTENANCE_STATUS",
      );
      return {
        processedSessions: response.processedSessions,
        purgedSessions: response.purgedSessions,
        state: response.state,
      };
    });
    if (queryEquivalenceCount > 0) {
      incrementalQuerySnapshot = await collectMutationQuerySnapshot({
        runtime,
        plan,
        count: queryEquivalenceCount,
        clock,
        requestIdStart: 100_000,
      });
    }
    await closeCapacitySidecar(runtime);
  } catch (error) {
    runtime.child.kill();
    throw new Error(`${error.message}${runtime.stderr() ? `; engine stderr: ${runtime.stderr()}` : ""}`);
  }

  const database = await openNodeDatabase(databasePath);
  const remainingSessions = Number(database.prepare("SELECT COUNT(*) AS value FROM sessions").get().value);
  const remainingTurns = Number(database.prepare("SELECT COUNT(*) AS value FROM turns").get().value);
  const remainingFtsDocuments = Number(
    database.prepare("SELECT COUNT(*) AS value FROM turn_fts_documents").get().value,
  );
  const remainingRollups = Number(
    database.prepare("SELECT COUNT(*) AS value FROM turn_rollup_contributions").get().value,
  );
  const replacementFtsDocuments = Number(
    database.prepare(
      "SELECT COUNT(*) AS value FROM turns_fts WHERE turns_fts MATCH ?",
    ).get(encodeBenchmarkTerm("replacementvtwo")).value,
  );
  const fieldStats = Object.fromEntries(
    database.prepare(
      "SELECT field,fts_doc_count AS documents FROM field_stats ORDER BY field",
    ).all().map((row) => [row.field, Number(row.documents)]),
  );
  const changeLogRows = Number(
    database.prepare("SELECT COUNT(*) AS value FROM projection_change_log").get().value,
  );
  const replacementGeneration = database.prepare(
    `SELECT hex(c.generation) AS value
       FROM session_commits c JOIN sessions s ON s.session_id=c.session_id
      WHERE s.session_key=?`,
  ).get(Buffer.from(plan.sessionKey(0), "hex"))?.value ?? null;
  const purgedState = database.prepare(
    "SELECT purge_state AS value FROM source_purge_states WHERE session_key=?",
  ).get(Buffer.from(plan.sessionKey(2), "hex"))?.value ?? null;
  const integrity = database.prepare("PRAGMA integrity_check").all()
    .map((row) => row.integrity_check);
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
  database.close();
  const removedTurns =
    plan.sessionAt(1).delta.turns.length + plan.sessionAt(2).delta.turns.length;
  const expectedRemainingTurns = plan.turnCount - removedTurns;
  const cleanQuerySnapshot = incrementalQuerySnapshot === null
    ? null
    : await collectCleanMutationQuerySnapshot({
      binaryPath,
      databasePath,
      plan,
      count: queryEquivalenceCount,
      clock,
    });
  const queryEquivalence = incrementalQuerySnapshot === null
    ? null
    : mutationQueryEquivalence(incrementalQuerySnapshot, cleanQuerySnapshot);
  return {
    format: "threadshare-insights-capacity-mutation-trace@v1",
    corpus: { turns: plan.turnCount, sessions: plan.sessionCount, seed: plan.seed },
    steps,
    finalState: {
      remainingSessions,
      remainingTurns,
      remainingFtsDocuments,
      remainingRollups,
      replacementFtsDocuments,
      fieldStats,
      changeLogRows,
      replacementGeneration,
      purgedState,
      integrity,
      foreignKeyViolations,
    },
    verified: {
      replace: replacementGeneration === "0000000000000002",
      delete: steps.find((step) => step.kind === "delete-source")?.outcome.removed === true,
      purge: purgedState === "purged",
      expectedRemainingFacts:
        remainingSessions === plan.sessionCount - 2 &&
        remainingTurns === expectedRemainingTurns,
      projectionCleanup:
        remainingFtsDocuments === expectedRemainingTurns &&
        remainingRollups === expectedRemainingTurns &&
        fieldStats.natural === expectedRemainingTurns &&
        fieldStats.capability === expectedRemainingTurns,
      replacementSearchable: replacementFtsDocuments === 1,
      boundedChangeLog: changeLogRows <= plan.turnsPerSession + 16,
      integrity: integrity.length === 1 && integrity[0] === "ok" && foreignKeyViolations === 0,
    },
    ...(queryEquivalence === null ? {} : { queryEquivalence }),
  };
}

function hostLoad() {
  const [oneMinute, fiveMinutes, fifteenMinutes] = loadavg();
  const logicalCpuCount = cpus().length;
  return {
    oneMinute,
    fiveMinutes,
    fifteenMinutes,
    oneMinutePerLogicalCpu: logicalCpuCount === 0 ? null : oneMinute / logicalCpuCount,
  };
}

function sanitizedEnvironment(hostLoadAtStart) {
  const processors = cpus();
  return {
    platform: process.platform,
    arch: process.arch,
    os: `${osPlatform()} ${osRelease()}`,
    cpuModel: processors[0]?.model ?? "unknown",
    logicalCpuCount: processors.length,
    totalMemoryBytes: totalmem(),
    nodeVersion: process.version,
    v8Version: process.versions.v8,
    hostLoad: {
      atStart: hostLoadAtStart,
      atReport: hostLoad(),
    },
  };
}

async function sourceRevision() {
  try {
    const { stdout } = await execFileAsync("git", ["rev-parse", "HEAD"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
    });
    return stdout.trim();
  } catch {
    return null;
  }
}

async function sourceWorktreeDirty() {
  try {
    const { stdout } = await execFileAsync("git", ["status", "--porcelain"], {
      cwd: REPOSITORY_ROOT,
      encoding: "utf8",
      maxBuffer: 4 * 1024 * 1024,
    });
    return stdout.length > 0;
  } catch {
    return null;
  }
}

async function runNodeReferenceWorker(options) {
  const args = [
    SCRIPT_PATH,
    "--node-reference-worker",
    "--db", options.databasePath,
    "--turns", String(options.turnCount),
    "--turns-per-session", String(options.turnsPerSession),
    "--queries", String(options.queryCount),
    "--warmup", String(options.warmupCount),
    "--seed", options.seed,
  ];
  const { stdout } = await execFileAsync(process.execPath, args, {
    cwd: REPOSITORY_ROOT,
    encoding: "utf8",
    env: { ...process.env, NODE_NO_WARNINGS: "1" },
    maxBuffer: 16 * 1024 * 1024,
  });
  return JSON.parse(stdout);
}

export async function runInsightsEngineBenchmark({
  turnCount = 25_000,
  turnsPerSession = 100,
  queryCount = 1_000,
  warmupCount = 100,
  seed = DEFAULT_SEED,
  binaryPath = process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE_PATH,
  workingDirectory,
} = {}) {
  const hostLoadAtStart = hostLoad();
  positiveInteger(turnCount, "turnCount");
  positiveInteger(turnsPerSession, "turnsPerSession");
  positiveInteger(queryCount, "queryCount");
  positiveInteger(warmupCount, "warmupCount");
  const ownsDirectory = workingDirectory === undefined;
  const directory = workingDirectory ?? await mkdtemp(
    path.join(tmpdir(), "threadshare-insights-benchmark-"),
  );
  const rustDatabasePath = path.join(directory, "rust.sqlite3");
  const nodeDatabasePath = path.join(directory, "node.sqlite3");

  try {
    const corpusStart = performance.now();
    const corpus = createBenchmarkCorpus({ turnCount, turnsPerSession, seed });
    const corpusBuildMs = performance.now() - corpusStart;
    const rust = await benchmarkRustSidecar({
      binaryPath: path.resolve(binaryPath),
      databasePath: rustDatabasePath,
      corpus,
      queryCount,
      warmupCount,
    });
    const node = await runNodeReferenceWorker({
      databasePath: nodeDatabasePath,
      turnCount,
      turnsPerSession,
      queryCount,
      warmupCount,
      seed,
    });
    if (node.corpusDigest !== corpus.digest) {
      throw new Error("Rust and Node paths did not use the same deterministic corpus");
    }
    if (node.query.resultDigest !== rust.query.resultDigest) {
      throw new Error("Rust-created and Node-created databases returned different query results");
    }

    return {
      format: BENCHMARK_FORMAT,
      measuredScope: "item-3-session-commit-substrate",
      sourceRevision: await sourceRevision(),
      sourceWorktreeDirty: await sourceWorktreeDirty(),
      benchmarkScriptSha256: sha256(await readFile(SCRIPT_PATH)),
      environment: sanitizedEnvironment(hostLoadAtStart),
      corpus: {
        seed,
        turns: corpus.turnCount,
        sessions: corpus.sessionCount,
        turnsPerSession,
        canonicalBytes: corpus.canonicalBytes,
        digest: corpus.digest,
        buildMs: corpusBuildMs,
      },
      rustSidecar: rust,
      nodeSqliteReference: node,
      comparison: {
        rustToNodeBackfillWallRatio: ratio(rust.backfill.wallMs, node.backfill.wallMs),
        rustToNodeDatabaseSizeRatio: ratio(rust.databaseBytes, node.databaseBytes),
        directReadP95Ratio: ratio(rust.query.p95Ms, node.query.p95Ms),
        queryResultsEqual: true,
        selectionBasis: [
          "Rust preserves the public Node >=20 contract while node:sqlite requires Node >=22.5.",
          "Rust pins the SQLite patch and compile options independently of the user's Node runtime.",
          "The sidecar provides process fault and memory isolation; this benchmark reports that cost explicitly.",
          "Performance is not a final backend decision until ITEM-4 adds normalized Fact and FTS workloads.",
        ],
      },
      deferredToItem4: [
        "raw-session parsing and Fact repository backfill",
        "detail-full FTS indexing and BM25/field-df query",
        "rollup, delete/replace, purge, projection rebuild, and crash-recovery costs",
        "the Epic's raw-byte throughput and final warm Top-20 latency gates",
      ],
    };
  } finally {
    if (ownsDirectory) await rm(directory, { recursive: true, force: true });
  }
}

export async function runInsightsCapacityBenchmark({
  turnCount = 25_000,
  turnsPerSession = 100,
  queryCount = 100,
  warmupCount = 20,
  seed = `${DEFAULT_SEED}-capacity`,
  binaryPath = process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE_PATH,
  workingDirectory,
  mutationTrace = true,
  mutationQueryEquivalenceCount = 0,
} = {}) {
  const hostLoadAtStart = hostLoad();
  positiveInteger(turnCount, "turnCount");
  positiveInteger(turnsPerSession, "turnsPerSession");
  positiveInteger(queryCount, "queryCount");
  positiveInteger(warmupCount, "warmupCount");
  if (
    !Number.isSafeInteger(mutationQueryEquivalenceCount) ||
    mutationQueryEquivalenceCount < 0
  ) {
    throw new RangeError("mutationQueryEquivalenceCount must be a non-negative safe integer");
  }
  const ownsDirectory = workingDirectory === undefined;
  const directory = workingDirectory ?? await mkdtemp(
    path.join(tmpdir(), "threadshare-insights-capacity-benchmark-"),
  );
  const capacityDatabasePath = path.join(directory, "capacity.sqlite3");
  try {
    const plan = createCapacityBenchmarkPlan({ turnCount, turnsPerSession, seed });
    const rust = await benchmarkCapacitySidecar({
      binaryPath: path.resolve(binaryPath),
      databasePath: capacityDatabasePath,
      plan,
      queryCount,
      warmupCount,
    });
    const mutations = mutationTrace
      ? await runCapacityMutationTrace({
        binaryPath: path.resolve(binaryPath),
        databasePath: capacityDatabasePath,
        plan,
        queryEquivalenceCount: mutationQueryEquivalenceCount,
      })
      : null;
    return {
      format: CAPACITY_BENCHMARK_FORMAT,
      measuredScope: "item-4-normalized-fact-fts-projection-capacity",
      sourceRevision: await sourceRevision(),
      sourceWorktreeDirty: await sourceWorktreeDirty(),
      benchmarkScriptSha256: sha256(await readFile(SCRIPT_PATH)),
      environment: sanitizedEnvironment(hostLoadAtStart),
      corpus: {
        corpusVersion: plan.corpusVersion,
        seed,
        identityDigest: plan.identityDigest,
        contentDigest: rust.corpusDigest,
        turns: plan.turnCount,
        sessions: plan.sessionCount,
        turnsPerSession,
        density: plan.density,
        canonicalBytes: rust.canonicalBytes,
        maxSessionCanonicalBytes: rust.maxSessionCanonicalBytes,
        boundedMemoryModel: "one generated SessionFactsDeltaV1 plus one protocol batch",
      },
      rustSidecar: rust,
      mutations,
      packedFactsDecision: rust.capacity.gates,
      notMeasured: [
        "raw provider JSONL parsing throughput; this corpus starts at SessionFactsDeltaV1",
        "Recall@300, Top-20 Recall/NDCG, and ranker ablations; capacity search latency is in rustSidecar.search",
        "packed-facts-v1 comparison unless the mechanical 6/8 GiB gates require that branch",
        "crash injection and projection shadow rebuild, which have dedicated integration suites",
      ],
    };
  } finally {
    if (ownsDirectory) await rm(directory, { recursive: true, force: true });
  }
}

export async function runInsightsQueryBenchmark({
  turnCount = 25_000,
  turnsPerSession = 100,
  queryCount = 1_000,
  warmupCount = 100,
  seed = `${DEFAULT_SEED}-query`,
  binaryPath = process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE_PATH,
  workingDirectory,
  formal = false,
} = {}) {
  if (formal && !FORMAL_QUERY_BENCHMARK_TURN_COUNTS.includes(turnCount)) {
    throw new RangeError("formal query evidence requires exactly 25000 or 250000 Turns");
  }
  if (formal && turnsPerSession !== 100) {
    throw new RangeError("formal query evidence requires exactly 100 Turns per session");
  }
  if (formal && seed !== FORMAL_QUERY_BENCHMARK_SEEDS[turnCount]) {
    throw new RangeError(`formal query evidence requires seed ${FORMAL_QUERY_BENCHMARK_SEEDS[turnCount]}`);
  }
  if (
    (formal || FORMAL_QUERY_BENCHMARK_TURN_COUNTS.includes(turnCount)) &&
    queryCount < FORMAL_QUERY_BENCHMARK_QUERY_COUNT
  ) {
    throw new RangeError("formal query evidence requires at least 1000 measured queries per path mode");
  }
  if (
    (formal || FORMAL_QUERY_BENCHMARK_TURN_COUNTS.includes(turnCount)) &&
    warmupCount < FORMAL_QUERY_BENCHMARK_WARMUP_COUNT
  ) {
    throw new RangeError("formal query evidence requires at least 100 warmup queries per path mode");
  }
  const capacity = await runInsightsCapacityBenchmark({
    turnCount,
    turnsPerSession,
    queryCount,
    warmupCount,
    seed,
    binaryPath,
    workingDirectory,
    mutationTrace: formal,
    mutationQueryEquivalenceCount:
      formal && turnCount === 25_000
        ? FORMAL_MUTATION_QUERY_EQUIVALENCE_COUNT
        : 0,
  });
  const formalEvidenceContext = formal ? {
    startup: capacity.rustSidecar.startup,
    overview: capacity.rustSidecar.overview,
    mutations: capacity.mutations,
    capacityGates: capacity.rustSidecar.capacity.gates,
  } : null;
  const formalEvidenceGates = formal ? {
    queryGatesPassed: capacity.rustSidecar.search.gates.allMeasuredQueryGatesPassed,
    capacityGatesPassed: capacity.rustSidecar.capacity.gates.allMeasuredCapacityGatesPassed,
    populatedStartupPassed:
      capacity.rustSidecar.startup.populatedDatabase.gate
        .medianReadyAndFirstOverviewUnder500Ms,
    mutationTracePassed:
      Object.keys(capacity.mutations.verified).length > 0 &&
      Object.values(capacity.mutations.verified).every((passed) => passed === true) &&
      (turnCount !== 25_000 || capacity.mutations.queryEquivalence?.allEqual === true),
  } : null;
  if (formalEvidenceGates) {
    formalEvidenceGates.allFormalEvidenceGatesPassed = Object.values(formalEvidenceGates)
      .every((passed) => passed === true);
  }
  return {
    format: QUERY_BENCHMARK_FORMAT,
    measuredScope: "item-5-rust-search-and-tool-path-query",
    sourceRevision: capacity.sourceRevision,
    sourceWorktreeDirty: capacity.sourceWorktreeDirty,
    benchmarkScriptSha256: capacity.benchmarkScriptSha256,
    environment: capacity.environment,
    corpus: capacity.corpus,
    query: capacity.rustSidecar.search,
    backfillContext: {
      engine: capacity.rustSidecar.engine,
      engineVersion: capacity.rustSidecar.engineVersion,
      target: capacity.rustSidecar.target,
      sqliteVersion: capacity.rustSidecar.sqliteVersion,
      wallMs: capacity.rustSidecar.backfill.wallMs,
      engineTurnsPerSecond: capacity.rustSidecar.backfill.engineTurnsPerSecond,
    },
    engineIdentity: capacity.rustSidecar.engineIdentity,
    formalEvidenceContext,
    formalEvidenceGates,
    gates: capacity.rustSidecar.search.gates,
    notMeasured: [
      "quality Recall/NDCG and ranker ablations use the frozen query evaluation fixture",
      "30% real-session detail-full capacity is recorded separately as aggregate-only evidence",
      "posting traversal and SQL filter intersection remain one honestly labelled Engine timing",
    ],
  };
}

function deterministicUuid(seed, index) {
  const digest = sha256(`${seed}\u0000${index}`);
  return [
    digest.slice(0, 8),
    digest.slice(8, 12),
    `4${digest.slice(13, 16)}`,
    `8${digest.slice(17, 20)}`,
    digest.slice(20, 32),
  ].join("-");
}

function rawBenchmarkText(index, characters, suffix = "initial") {
  const identity = index.toString(36).padStart(6, "0");
  const chunk = [
    `session_${identity}_${suffix}`,
    `identifier_${((index * 17) % 65_521).toString(36)}`,
    `error_${((index * 31) % 8_191).toString(16)}`,
    "分析 Rust SQLite FTS 增量索引 rollback retry projection",
  ].join(" ");
  return `${chunk} ${chunk.repeat(Math.ceil(characters / chunk.length))}`.slice(0, characters);
}

function rawBenchmarkRecords(provider, sessionId, index, textCharacters, suffix = "initial") {
  const timestamp = new Date(BASE_TIME_MS + index * 1_000).toISOString();
  const question = rawBenchmarkText(index, textCharacters, suffix);
  const answer = `Resolved ${rawBenchmarkText(index, Math.min(1_024, textCharacters), suffix)}`;
  if (provider === "codex") {
    const turnId = `turn-${index}-${suffix}`;
    const callId = `call_${index}_${suffix}`;
    return [
      {
        type: "session_meta",
        timestamp,
        payload: {
          id: sessionId,
          cwd: `/benchmark/project-${index % 97}`,
          cli_version: "1.0.0-benchmark",
        },
      },
      { type: "event_msg", payload: { type: "task_started", turn_id: turnId } },
      {
        type: "response_item",
        timestamp,
        payload: {
          type: "message",
          role: "user",
          content: [{ type: "input_text", text: question }],
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: callId,
          name: index % 2 === 0 ? "Read" : "Bash",
          arguments: JSON.stringify({ benchmark: index, suffix }),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: callId,
          output: `benchmark output ${index}`,
          status: "completed",
          exit_code: 0,
          duration_ms: 5 + (index % 17),
        },
      },
      {
        type: "response_item",
        payload: {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: answer }],
        },
      },
      { type: "event_msg", payload: { type: "task_complete", turn_id: turnId } },
    ];
  }
  const userUuid = deterministicUuid(`${sessionId}-user-${suffix}`, index);
  const assistantUuid = deterministicUuid(`${sessionId}-assistant-${suffix}`, index);
  const resultUuid = deterministicUuid(`${sessionId}-result-${suffix}`, index);
  const finalUuid = deterministicUuid(`${sessionId}-final-${suffix}`, index);
  const toolId = `tool-${index}-${suffix}`;
  return [
    {
      type: "user",
      sessionId,
      uuid: userUuid,
      timestamp,
      cwd: `/benchmark/project-${index % 97}`,
      version: "2.1.222",
      message: { role: "user", content: [{ type: "text", text: question }] },
    },
    {
      type: "assistant",
      sessionId,
      uuid: assistantUuid,
      timestamp,
      message: {
        role: "assistant",
        content: [{
          type: "tool_use",
          id: toolId,
          name: index % 2 === 0 ? "Read" : "Bash",
          input: { benchmark: index, suffix },
        }],
      },
    },
    {
      type: "user",
      sessionId,
      uuid: resultUuid,
      timestamp,
      message: {
        role: "user",
        content: [{ type: "tool_result", tool_use_id: toolId, content: "benchmark output" }],
      },
    },
    {
      type: "assistant",
      sessionId,
      uuid: finalUuid,
      timestamp,
      message: { role: "assistant", content: [{ type: "text", text: answer }] },
    },
  ];
}

function jsonlBytes(records) {
  return Buffer.from(`${records.map((record) => JSON.stringify(record)).join("\n")}\n`);
}

async function writeRawBackfillCorpus({ directory, sessionCount, textCharacters, seed }) {
  const providerHome = path.join(directory, "providers");
  const codexRoot = path.join(providerHome, "codex", "sessions", "2026", "08", "10");
  const claudeRoot = path.join(providerHome, ".claude", "projects", "benchmark-project");
  await Promise.all([
    mkdir(codexRoot, { recursive: true }),
    mkdir(claudeRoot, { recursive: true }),
  ]);
  const sessions = [];
  let rawBytes = 0;
  for (let batchStart = 0; batchStart < sessionCount; batchStart += 64) {
    const batch = [];
    for (let index = batchStart; index < Math.min(sessionCount, batchStart + 64); index += 1) {
      const provider = index % 2 === 0 ? "codex" : "claude";
      const sessionId = deterministicUuid(seed, index);
      const file = provider === "codex"
        ? path.join(codexRoot, `rollout-2026-08-10T00-00-00-${sessionId}.jsonl`)
        : path.join(claudeRoot, `${sessionId}.jsonl`);
      const bytes = jsonlBytes(rawBenchmarkRecords(
        provider,
        sessionId,
        index,
        textCharacters,
      ));
      rawBytes += bytes.length;
      sessions.push({ provider, sessionId, file, index, bytes: bytes.length });
      const observed = new Date(BASE_TIME_MS + index * 1_000);
      batch.push((async () => {
        await writeFile(file, bytes);
        await utimes(file, observed, observed);
      })());
    }
    await Promise.all(batch);
  }
  return Object.freeze({
    environment: Object.freeze({
      HOME: providerHome,
      CODEX_HOME: path.join(providerHome, "codex"),
    }),
    watchRoots: Object.freeze([
      path.join(providerHome, "codex", "sessions"),
      path.join(providerHome, ".claude", "projects"),
    ]),
    sessions: Object.freeze(sessions),
    rawBytes,
  });
}

function phaseTimings(values) {
  if (values.length === 0) return { count: 0, totalMs: 0, p50Ms: 0, p95Ms: 0, maxMs: 0 };
  const totals = values.reduce(
    (summary, value) => ({
      totalMs: summary.totalMs + value,
      maxMs: Math.max(summary.maxMs, value),
    }),
    { totalMs: 0, maxMs: 0 },
  );
  return {
    count: values.length,
    totalMs: totals.totalMs,
    p50Ms: percentile(values, 0.50),
    p95Ms: percentile(values, 0.95),
    maxMs: totals.maxMs,
  };
}

function createWorkerCycleObserver() {
  const waiters = new Set();
  const settle = (waiter, action, value) => {
    clearTimeout(waiter.timer);
    waiters.delete(waiter);
    action(value);
  };
  return Object.freeze({
    waitFor(predicate, timeoutMs) {
      return new Promise((resolve, reject) => {
        const waiter = { predicate, resolve, reject, timer: null };
        waiter.timer = setTimeout(() => {
          settle(
            waiter,
            reject,
            new Error("Insights worker did not observe the expected report"),
          );
        }, timeoutMs);
        waiters.add(waiter);
      });
    },
    onCycle({ report }) {
      for (const waiter of [...waiters]) {
        try {
          if (waiter.predicate(report)) settle(waiter, waiter.resolve, report);
        } catch (error) {
          settle(waiter, waiter.reject, error);
        }
      }
    },
    onError(error) {
      for (const waiter of [...waiters]) settle(waiter, waiter.reject, error);
    },
  });
}

function summarizeRawBackfillCycles(cycles) {
  const sum = (field) => cycles.reduce((total, cycle) => total + cycle.report[field], 0);
  return Object.freeze({
    format: "threadshare-insights-index-benchmark-summary@v1",
    cycles: cycles.length,
    reasons: cycles.map(({ reasons }) => reasons),
    discoveredPerCycle: cycles.map(({ discovered }) => discovered),
    uniqueDiscoveredPerCycle: cycles.map(({ uniqueDiscovered }) => uniqueDiscovered),
    planned: sum("planned"),
    unchanged: sum("unchanged"),
    excluded: sum("excluded"),
    missing: sum("missing"),
    committed: sum("committed"),
    failed: sum("failed"),
    discoveryDiagnostics: cycles.flatMap(({ discoveryDiagnostics }) => discoveryDiagnostics),
    indexDiagnostics: cycles.flatMap(({ report }) => report.diagnostics),
  });
}

function instrumentEngine(engine, observeCommit) {
  return new Proxy(engine, {
    get(target, property) {
      if (property === "commitSourceDelta") {
        return async (input, options) => {
          const started = performance.now();
          const response = await target.commitSourceDelta(input, options);
          observeCommit(input, response, performance.now() - started);
          return response;
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
}

export async function runInsightsRawBackfillBenchmark({
  sessionCount = 10_000,
  rawTextCharacters = 262_144,
  seed = `${DEFAULT_SEED}-raw-backfill`,
  binaryPath = process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE_PATH,
  workingDirectory,
} = {}) {
  const hostLoadAtStart = hostLoad();
  positiveInteger(sessionCount, "sessionCount");
  positiveInteger(rawTextCharacters, "rawTextCharacters");
  const ownsDirectory = workingDirectory === undefined;
  const directory = workingDirectory ?? await mkdtemp(
    path.join(tmpdir(), "threadshare-insights-raw-backfill-"),
  );
  const databasePath = path.join(directory, "raw-backfill.sqlite3");
  const paths = {
    stateDirectory: directory,
    configFile: path.join(directory, "config.json"),
    databaseFile: databasePath,
    originSecretFile: path.join(directory, "origin-secret.json"),
    lockFile: path.join(directory, "insights.lock"),
    tempDirectory: path.join(directory, "tmp"),
  };
  const corpus = await writeRawBackfillCorpus({
    directory,
    sessionCount,
    textCharacters: rawTextCharacters,
    seed,
  });
  const originSecretEpoch = "55555555-5555-4555-8555-555555555555";
  const privacyContext = createPrivacyContext({
    originSecretEpoch,
    secret: Buffer.alloc(32, 0x52),
  });
  const requiredContract = insightsRequiredContract(originSecretEpoch);
  const latestTarget = Math.min(100, sessionCount);
  const newestFiles = new Set(
    corpus.sessions.slice(-latestTarget).map(({ file }) => file),
  );
  const newestCommitted = new Set();
  const backfillCommittedFiles = new Set();
  const phase = {
    name: "backfill",
    backfill: { adapter: [], commit: [], physicalBytes: 0 },
    append: { adapter: [], commit: [], physicalBytes: 0 },
  };
  const cycleReports = [];
  let latestSessionsCommittedMs = null;
  let appendCommittedMs = null;
  let backfillStarted = performance.now();
  let appendStarted = null;
  let appendTargetFile = null;
  let activeCycleCommittedFiles = null;
  let worker;
  let engine;
  const cycleObserver = createWorkerCycleObserver();
  try {
    engine = await createInsightsEngineClient({
      databasePath,
      requiredContract,
      runtimeOptions: {
        env: {
          ...process.env,
          THREADSHARE_INSIGHTS_ENGINE_PATH: path.resolve(binaryPath),
        },
      },
      childEnv: {
        ...process.env,
        SQLITE_TMPDIR: directory,
        TMPDIR: directory,
        TEMP: directory,
        TMP: directory,
      },
      timeoutMs: 120_000,
    });
    const measuredEngine = instrumentEngine(engine, (input, _response, wallMs) => {
      phase[phase.name].commit.push(wallMs);
      const file = input.sourceState.file;
      activeCycleCommittedFiles?.add(file);
      if (phase.name === "backfill") {
        backfillCommittedFiles.add(file);
        if (newestFiles.has(file)) newestCommitted.add(file);
        if (newestCommitted.size === latestTarget && latestSessionsCommittedMs === null) {
          latestSessionsCommittedMs = performance.now() - backfillStarted;
        }
      } else if (file === appendTargetFile && appendCommittedMs === null) {
        appendCommittedMs = performance.now() - appendStarted;
      }
    });
    const reconcile = async ({ reasons }) => {
      const discoveries = await Promise.all(
        ["codex", "claude"].map((provider) =>
          discoverProviderEvidenceSources(provider, { environment: corpus.environment })),
      );
      const diagnostics = discoveries.flatMap(({ diagnostics }) => diagnostics);
      const sources = discoveries.flatMap(({ sources }) => sources);
      const committedFiles = new Set();
      activeCycleCommittedFiles = committedFiles;
      let report;
      try {
        report = await runInsightsIndexer({
          sources,
          config: {
            insights: {
              excludeProviders: [],
              excludeProjects: [],
              excludeSessions: [],
            },
          },
          engine: measuredEngine,
          privacyContext,
          requiredContract,
          concurrency: 4,
          adapterOptions: {
            onBytesRead({ bytesRead }) {
              phase[phase.name].physicalBytes += bytesRead;
            },
          },
          async readDelta(...arguments_) {
            const started = performance.now();
            try {
              return await readProviderSessionDelta(...arguments_);
            } finally {
              phase[phase.name].adapter.push(performance.now() - started);
            }
          },
        });
      } finally {
        activeCycleCommittedFiles = null;
      }
      const cycle = Object.freeze({
        reasons,
        discovered: sources.length,
        uniqueDiscovered: new Set(sources.map(({ file }) => file)).size,
        committedTarget: appendTargetFile !== null && committedFiles.has(appendTargetFile),
        report,
        discoveryDiagnostics: diagnostics,
      });
      cycleReports.push(cycle);
      if (report.failed > 0) {
        const codes = report.diagnostics.map((diagnostic) => JSON.stringify(diagnostic)).join(",");
        throw new Error(
          `raw backfill cycle failed ${report.failed} session operations` +
          (codes ? ` (${codes})` : ""),
        );
      }
      return cycle;
    };
    worker = createInsightsIndexWorker({
      reconcile,
      watchRoots: corpus.watchRoots,
      debounceMs: 100,
      pollIntervalMs: 60_000,
      onCycle: cycleObserver.onCycle,
      onError: cycleObserver.onError,
    });
    const initialCycle = cycleObserver.waitFor(
      (cycle) => cycle.reasons.includes("startup"),
      24 * 60 * 60 * 1_000,
    );
    worker.start();
    await initialCycle;
    await worker.whenIdle();
    if (worker.status().lastError) throw worker.status().lastError;
    const backfillWallMs = performance.now() - backfillStarted;
    const backfillCycles = cycleReports.slice();
    const backfillReport = summarizeRawBackfillCycles(backfillCycles);

    await worker.stop();
    worker = null;
    await engine.close();
    engine = null;
    await mkdir(paths.tempDirectory, { recursive: true, mode: 0o700 });
    await writeFile(paths.originSecretFile, `${JSON.stringify({
      format: INSIGHTS_ORIGIN_SECRET_FORMAT,
      originSecretEpoch,
      secret: Buffer.alloc(32, 0x52).toString("base64url"),
    })}\n`, { mode: 0o600, flag: "wx" });

    phase.name = "append";
    const appendTarget = corpus.sessions.at(-1);
    appendTargetFile = appendTarget.file;
    const appendMarker = `freshmarker${appendTarget.index.toString(36)}`;
    const productCycleObserver = createWorkerCycleObserver();
    const createMeasuredEngineClient = async (options) => instrumentEngine(
      await createInsightsEngineClient(options),
      (input, _response, wallMs) => {
        phase.append.commit.push(wallMs);
        if (input.sourceState.file === appendTargetFile && appendCommittedMs === null) {
          appendCommittedMs = performance.now() - appendStarted;
        }
      },
    );
    worker = createInsightsBackgroundWorker({
      paths,
      discoveryOptions: { environment: corpus.environment },
      runtimeOptions: {
        env: {
          ...process.env,
          THREADSHARE_INSIGHTS_ENGINE_PATH: path.resolve(binaryPath),
        },
      },
      timeoutMs: 120_000,
      concurrency: 4,
      createEngineClient: createMeasuredEngineClient,
      adapterOptions: {
        onBytesRead({ bytesRead }) {
          phase.append.physicalBytes += bytesRead;
        },
      },
      async readDelta(...arguments_) {
        const started = performance.now();
        try {
          return await readProviderSessionDelta(...arguments_);
        } finally {
          phase.append.adapter.push(performance.now() - started);
        }
      },
      workerOptions: {
        watchRoots: corpus.watchRoots,
        debounceMs: 100,
        pollIntervalMs: 60_000,
        onCycle({ reasons, report }) {
          productCycleObserver.onCycle({
            report: Object.freeze({
              reasons,
              committedTarget:
                appendCommittedMs !== null && report?.report?.committed === 1,
              productPath: "reconcileActiveInsights",
              report: report?.report,
            }),
          });
        },
        onError: productCycleObserver.onError,
      },
    });
    const productStartupCycle = productCycleObserver.waitFor(
      (cycle) => cycle.reasons.includes("startup") &&
        cycle.report.failed === 0 && cycle.report.unchanged === sessionCount,
      120_000,
    );
    worker.start();
    await productStartupCycle;
    await worker.whenIdle();
    const appendCycle = productCycleObserver.waitFor(
      (cycle) => cycle.reasons.includes("filesystem") &&
        cycle.report.committed === 1 && cycle.committedTarget,
      30_000,
    );
    appendStarted = performance.now();
    const appended = rawBenchmarkRecords(
      appendTarget.provider,
      appendTarget.sessionId,
      appendTarget.index,
      Math.min(rawTextCharacters, 4_096),
      appendMarker,
    ).filter((record) => record.type !== "session_meta");
    await appendFile(appendTarget.file, jsonlBytes(appended));
    const appendReport = await appendCycle;
    await worker.whenIdle();
    if (worker.status().lastError) throw worker.status().lastError;
    const appendSearch = await searchProductFreshnessMarker({
      binaryPath,
      databasePath,
      paths,
      turnCount: sessionCount + 1,
      marker: appendMarker,
    });
    const appendSearchableMs = performance.now() - appendStarted;
    await worker.stop();
    worker = null;

    const database = await openNodeDatabase(databasePath);
    const facts = {
      sessions: Number(database.prepare("SELECT COUNT(*) AS value FROM sessions").get().value),
      turns: Number(database.prepare("SELECT COUNT(*) AS value FROM turns").get().value),
      ftsDocuments: Number(
        database.prepare("SELECT COUNT(*) AS value FROM turn_fts_documents").get().value,
      ),
      sourceStates: Number(
        database.prepare("SELECT COUNT(*) AS value FROM source_ingestion_states").get().value,
      ),
      appendMatches: Number(
        database.prepare(
          "SELECT COUNT(*) AS value FROM turns_fts WHERE turns_fts MATCH ?",
        ).get(encodeBenchmarkTerm(appendMarker)).value,
      ),
    };
    database.close();
    const rawMiBPerSecond =
      (corpus.rawBytes / 1_048_576) / (backfillWallMs / 1_000);
    const discoveryComplete =
      backfillCycles.length > 0 &&
      backfillCycles.every((cycle) =>
        cycle.discovered === sessionCount && cycle.uniqueDiscovered === sessionCount) &&
      backfillReport.discoveryDiagnostics.length === 0;
    const commitComplete =
      backfillCommittedFiles.size === sessionCount &&
      backfillReport.committed === sessionCount &&
      backfillReport.failed === 0 &&
      backfillReport.indexDiagnostics.length === 0;
    const persistedCorpusComplete =
      facts.sessions === sessionCount &&
      facts.sourceStates === sessionCount &&
      facts.turns === sessionCount + 1 &&
      facts.ftsDocuments === sessionCount + 1;
    const rawBackfillCorpusComplete =
      discoveryComplete && commitComplete && persistedCorpusComplete;
    return {
      format: RAW_BACKFILL_BENCHMARK_FORMAT,
      measuredScope: "item-4-raw-provider-adapter-worker-engine-backfill",
      sourceRevision: await sourceRevision(),
      sourceWorktreeDirty: await sourceWorktreeDirty(),
      benchmarkScriptSha256: sha256(await readFile(SCRIPT_PATH)),
      environment: sanitizedEnvironment(hostLoadAtStart),
      corpus: {
        seed,
        sessions: sessionCount,
        providers: { codex: Math.ceil(sessionCount / 2), claude: Math.floor(sessionCount / 2) },
        rawTextCharacters,
        rawBytes: corpus.rawBytes,
        uniqueSessionIds: new Set(corpus.sessions.map(({ sessionId }) => sessionId)).size,
      },
      backfill: {
        wallMs: backfillWallMs,
        rawMiBPerSecond,
        physicalBytesRead: phase.backfill.physicalBytes,
        latestSessions: {
          target: latestTarget,
          committed: newestCommitted.size,
          allCommittedMs: latestSessionsCommittedMs,
        },
        adapter: phaseTimings(phase.backfill.adapter),
        commitAck: phaseTimings(phase.backfill.commit),
        uniqueCommittedSources: backfillCommittedFiles.size,
        report: backfillReport,
      },
      appendFreshness: {
        productPath: appendReport.productPath,
        wallMs: appendSearchableMs,
        committedMs: appendCommittedMs,
        physicalBytesRead: phase.append.physicalBytes,
        adapter: phaseTimings(phase.append.adapter),
        commitAck: phaseTimings(phase.append.commit),
        target: {
          provider: appendTarget.provider,
          sessionId: appendTarget.sessionId,
          committed: appendReport.committedTarget,
        },
        searchableMatches: facts.appendMatches,
        engineSearchResultCount: appendSearch.results.length,
        report: appendReport,
      },
      facts,
      gates: {
        rawBackfillCorpusComplete,
        discoveryComplete,
        commitComplete,
        persistedCorpusComplete,
        rawBackfillAtLeast10MiBPerSecond:
          rawBackfillCorpusComplete && rawMiBPerSecond >= 10,
        newest100Within30Seconds:
          latestSessionsCommittedMs !== null && latestSessionsCommittedMs <= 30_000,
        appendedTurnWithin2Seconds:
          appendReport.committedTarget && appendCommittedMs !== null &&
          appendSearchableMs <= 2_000 && facts.appendMatches > 0 &&
          appendSearch.results.length === 1,
      },
    };
  } finally {
    if (worker) await worker.stop();
    if (engine) await engine.close();
    if (ownsDirectory) await rm(directory, { recursive: true, force: true });
  }
}

function parseArguments(argv) {
  const options = {
    turnCount: 25_000,
    turnsPerSession: 100,
    queryCount: 1_000,
    warmupCount: 100,
    seed: DEFAULT_SEED,
    binaryPath: process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE_PATH,
    outputPath: null,
    json: false,
    nodeReferenceWorker: false,
    capacity: false,
    queryBenchmark: false,
    formal: false,
    rawBackfill: false,
    sessionCount: 10_000,
    rawTextCharacters: 262_144,
    mutationTrace: true,
    databasePath: null,
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--formal") options.formal = true;
    else if (argument === "--capacity") options.capacity = true;
    else if (argument === "--query-benchmark") options.queryBenchmark = true;
    else if (argument === "--raw-backfill") options.rawBackfill = true;
    else if (argument === "--skip-mutations") options.mutationTrace = false;
    else if (argument === "--node-reference-worker") options.nodeReferenceWorker = true;
    else if (argument === "--turns") options.turnCount = positiveInteger(argv[++index], "--turns");
    else if (argument === "--sessions") {
      options.sessionCount = positiveInteger(argv[++index], "--sessions");
    } else if (argument === "--raw-text-characters") {
      options.rawTextCharacters = positiveInteger(argv[++index], "--raw-text-characters");
    } else if (argument === "--turns-per-session") {
      options.turnsPerSession = positiveInteger(argv[++index], "--turns-per-session");
    } else if (argument === "--queries") options.queryCount = positiveInteger(argv[++index], "--queries");
    else if (argument === "--warmup") options.warmupCount = positiveInteger(argv[++index], "--warmup");
    else if (argument === "--seed") options.seed = argv[++index];
    else if (argument === "--engine") options.binaryPath = argv[++index];
    else if (argument === "--output") options.outputPath = argv[++index];
    else if (argument === "--db") options.databasePath = argv[++index];
    else throw new Error(`unknown argument: ${argument}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  if (options.nodeReferenceWorker) {
    if (!options.databasePath) throw new Error("--db is required for the reference worker");
    const result = await benchmarkNodeSqliteReference({
      databasePath: options.databasePath,
      turnCount: options.turnCount,
      turnsPerSession: options.turnsPerSession,
      queryCount: options.queryCount,
      warmupCount: options.warmupCount,
      seed: options.seed,
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }

  const result = options.rawBackfill
    ? await runInsightsRawBackfillBenchmark(options)
    : options.queryBenchmark
      ? await runInsightsQueryBenchmark(options)
      : options.capacity
        ? await runInsightsCapacityBenchmark(options)
        : await runInsightsEngineBenchmark(options);
  const rendered = options.json ? JSON.stringify(result) : `${JSON.stringify(result, null, 2)}\n`;
  if (options.outputPath) await writeFile(options.outputPath, `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(options.json ? `${rendered}\n` : rendered);
  if (
    options.queryBenchmark && options.formal &&
    !result.formalEvidenceGates?.allFormalEvidenceGatesPassed
  ) {
    throw new Error("ITEM-5 query benchmark gates failed");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`benchmark-insights-engine: ${error.message}\n`);
    process.exitCode = 1;
  });
}
