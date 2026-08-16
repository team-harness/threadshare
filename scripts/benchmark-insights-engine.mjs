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
  realpath,
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
  createInsightsRequiredContract,
  createExcludeSourceMessage,
  createHelloMessage,
  createReadEngineStatusMessage,
  createReadInsightsEvidenceV2Message,
  createReadInsightsOverviewMessage,
  createReadInsightsQueryV2Message,
  createReadInsightsRecipeMessage,
  createRemoveSourceMessage,
  createRunPurgeMaintenanceMessage,
  createSearchTurnsMessage,
  createSessionDeltaMessages,
  decodeProtocolFrames,
  encodeProtocolFrame,
  traceSourceDigestDocument,
} from "../src/insights-engine-protocol.mjs";
import {
  assertSessionFactsDeltaV2,
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
import { readGitDiffEvidence } from "../src/insights-git-evidence.mjs";

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
const DEEP_QUERY_BENCHMARK_FORMAT = "threadshare-insights-deep-query-benchmark@v1";
const DELIVERY_TRACE_BENCHMARK_FORMAT =
  "threadshare-insights-delivery-trace-benchmark@v1";
export const FORMAL_QUERY_BENCHMARK_TURN_COUNTS = Object.freeze([25_000, 250_000]);
export const FORMAL_QUERY_BENCHMARK_QUERY_COUNT = 1_000;
export const FORMAL_QUERY_BENCHMARK_WARMUP_COUNT = 100;
export const FORMAL_MUTATION_QUERY_EQUIVALENCE_COUNT = 100;
export const FORMAL_QUERY_BENCHMARK_SEEDS = Object.freeze({
  25000: "threadshare-insights-query-25k-v1",
  250000: "threadshare-insights-query-250k-v1",
});
export const FORMAL_DEEP_QUERY_COUNT = 100;
export const FORMAL_DEEP_QUERY_WARMUP_COUNT = 20;
export const FORMAL_DEEP_QUERY_SEEDS = Object.freeze({
  25000: "threadshare-insights-deep-query-25k-v1",
  250000: "threadshare-insights-deep-query-250k-v1",
});
export const FORMAL_DELIVERY_TRACE_COUNT = 100;
export const FORMAL_DELIVERY_TRACE_WARMUP_COUNT = 20;
export const FORMAL_DELIVERY_TRACE_SEED = "threadshare-insights-delivery-trace-25k-v1";
const BASE_TIME_MS = Date.UTC(2026, 0, 1, 0, 0, 0);
const GIB = 1024 ** 3;
const SQLITE_LOCK_BYTE_OFFSET = 1_073_741_824;
const NORMALIZED_FACT_LIMIT_BYTES = 6 * GIB;
const STEADY_STATE_LIMIT_BYTES = 8 * GIB;
const CURRENT_ENGINE_RSS_LIMIT_BYTES = 96 * 1024 * 1024;
const LONG_TERM_ENGINE_RSS_LIMIT_BYTES = 128 * 1024 * 1024;
const DETAIL_FULL_FTS_LIMIT_BYTES = 400 * 1024 * 1024;
const DEEP_STORAGE_AMPLIFICATION_LIMIT = 1.8;
const DEEP_FTS_AMPLIFICATION_LIMIT = 0.7;
export const DEEP_QUERY_RECIPE_P95_LIMIT_MS = 500;
export const DEEP_QUERY_RECIPE_P99_LIMIT_MS = 1_000;
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
const CAPACITY_CORPUS_VERSION = 7;
const CAPACITY_TOPIC_COUNT = 47;
const CAPACITY_DENSITY = Object.freeze({
  sourceRecordsPerTurn: 10,
  evidenceEventsPerTurn: 9,
  turnEvidencePerTurn: 3,
  capabilityUsesPerTurn: 3,
  capabilityUseEvidencePerTurn: 6,
  historyEventsPerTurn: 10,
  historyPayloadsPerTurn: 8,
  historyPayloadChunksPerTurn: 8,
  evidencePagingProbeBytes: 2 * 1024 * 1024,
  evidencePagingProbeEvents: 1,
  evidencePagingProbePayloads: 1,
  evidencePagingProbeChunks: 32,
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
  "history_events", "history_payloads", "history_payload_chunks",
  "attempt_chain_events", "file_activity", "token_usage", "error_occurrences",
]);
const FTS_TABLES = new Set([
  "turn_fts_documents",
  "history_event_fts_documents",
  "field_stats",
  "fts_analyzer_identity",
  "turn_analyzer_diagnostics",
]);
const PROJECTION_TABLES = new Set([
  "turn_rollup_contributions", "projection_state", "projection_change_log",
  "capability_retry_contributions", "retry_projection_build_cursor",
  "turn_search_build_cursor", "overview_rollup_state", "overview_session_rollups",
  "overview_session_capabilities", "overview_session_fact_signals",
  "history_coverage_rollups", "history_event_coverage",
  "history_event_kind_rollups", "history_event_day_coverage_rollups",
  "history_activity_rollups", "history_token_rollups",
  "history_query_session_coverage", "history_capability_rollups",
  "history_capability_representatives", "history_capability_cooccurrences",
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

function capacityHistoryEvent(event, metadata) {
  return {
    eventKey: event.eventKey,
    ownerSessionKey: event.ownerSessionKey,
    occurredTurnKey: event.occurredTurnKey,
    sourceRecordKey: event.sourceRecordKey,
    sourceOrder: event.sourceOrder,
    originScope: event.originScope,
    observedTimestamp: event.observedTimestamp,
    kind: event.kind,
    completeness: "full",
    revision: "0".repeat(64),
    metadata,
    payloadKeys: [],
  };
}

function addCapacityHistoryPayload({
  event,
  ownerSessionKey,
  payloadKind,
  content,
  encoding,
  payloads,
  chunks,
}) {
  const bytes = Buffer.from(content, "utf8");
  const payloadKey = hashKey(
    "history-payload",
    Buffer.from(event.eventKey, "hex"),
    payloadKind,
  );
  const payloadChunks = [];
  let offset = 0;
  while (offset < bytes.length) {
    let end = Math.min(offset + 64 * 1_024, bytes.length);
    while (end < bytes.length && end > offset && (bytes[end] & 0xc0) === 0x80) end -= 1;
    if (end === offset) throw new TypeError("capacity payload chunk boundary is invalid");
    payloadChunks.push(bytes.subarray(offset, end).toString("utf8"));
    offset = end;
  }
  if (payloadChunks.length === 0) payloadChunks.push("");
  payloads.push({
    payloadKey,
    ownerSessionKey,
    eventKey: event.eventKey,
    payloadKind,
    encoding,
    byteLength: String(bytes.length),
    sha256: sha256(bytes),
    completeness: "full",
    chunkCount: String(payloadChunks.length),
  });
  for (let ordinal = 0; ordinal < payloadChunks.length; ordinal += 1) {
    const chunk = payloadChunks[ordinal];
    const chunkBytes = Buffer.from(chunk, "utf8");
    chunks.push({
      payloadKey,
      ownerSessionKey,
      ordinal: String(ordinal),
      content: chunk,
      byteLength: String(chunkBytes.length),
      sha256: sha256(chunkBytes),
    });
  }
  event.payloadKeys.push(payloadKey);
}

function finalizeCapacityHistory(events, payloads, chunks) {
  const payloadByKey = new Map(payloads.map((payload) => [payload.payloadKey, payload]));
  for (const event of events) {
    event.payloadKeys.sort();
    event.revision = sha256(canonicalJson({
      eventKey: event.eventKey,
      ownerSessionKey: event.ownerSessionKey,
      occurredTurnKey: event.occurredTurnKey,
      sourceRecordKey: event.sourceRecordKey,
      sourceOrder: event.sourceOrder,
      originScope: event.originScope,
      observedTimestamp: event.observedTimestamp,
      kind: event.kind,
      completeness: event.completeness,
      metadata: event.metadata,
      payloads: event.payloadKeys.map((payloadKey) => {
        const payload = payloadByKey.get(payloadKey);
        if (!payload) throw new TypeError("capacity history event references a missing payload");
        return { payloadKey, sha256: payload.sha256, byteLength: payload.byteLength };
      }),
    }));
  }
  events.sort((left, right) => left.eventKey.localeCompare(right.eventKey));
  payloads.sort((left, right) => left.payloadKey.localeCompare(right.payloadKey));
  chunks.sort((left, right) =>
    left.payloadKey.localeCompare(right.payloadKey) || Number(left.ordinal) - Number(right.ordinal));
}

function capacityFileActivity(globalIndex, useIndex, phase) {
  const relativePath = useIndex === 0
    ? `docs/topic-${globalIndex % CAPACITY_TOPIC_COUNT}.md`
    : `src/module-${globalIndex % 97}.${useIndex === 1 ? "rs" : "mjs"}`;
  return {
    action: useIndex === 0 ? "read" : useIndex === 1 ? "edit" : "search",
    phase,
    pathRole: "target",
    rawPath: `/benchmark/project-${globalIndex % 29}/${relativePath}`,
    normalizedPath: `/benchmark/project-${globalIndex % 29}/${relativePath}`,
    relativePath,
    absolute: true,
    projectRelative: true,
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
  assertSessionFactsDeltaV2(delta);
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
      format: "session-facts-delta@v2",
      factSchemaVersion: 2,
      providerAdapterVersion: sessionIndex % 2 === 0 ? "codex@3" : "claude@3",
      privacyPolicyVersion: 2,
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
      historyEvents: [],
      historyPayloads: [],
      historyPayloadChunks: [],
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
  const historyEvents = [];
  const historyPayloads = [];
  const historyPayloadChunks = [];
  const usedCapabilities = new Map();

  for (let localIndex = 0; localIndex < sessionTurnCount; localIndex += 1) {
    const globalIndex = firstGlobalTurn + localIndex;
    const turnStartOffset = localIndex * 16_384;
    const turnKey = hashKey("turn", Buffer.from(sessionKey, "hex"), uint64(turnStartOffset));
    const timestamp = new Date(BASE_TIME_MS + globalIndex * 1_000).toISOString();
    const replacementMarker = replacement && localIndex === 0 ? " replacement-v2" : "";
    const problemText = capacityProblemText(globalIndex, provider, replacementMarker);
    const finalAnswerExcerpt = sizedText(
      `capacity answer ${globalIndex} outcome-${globalIndex % 17}`,
      CAPACITY_DENSITY.finalAnswerCharacters,
    );
    turns.push({
      turnKey,
      ownerSessionKey: sessionKey,
      turnStartOffset: String(turnStartOffset),
      problemText,
      finalAnswerExcerpt,
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
    const userHistory = capacityHistoryEvent(user, { role: "user" });
    const assistantHistory = capacityHistoryEvent(assistant, { role: "assistant" });
    historyEvents.push(
      userHistory,
      assistantHistory,
      capacityHistoryEvent(lifecycle, {
        lifecycleState: lifecycle.lifecycleState,
        providerTurnDigest: lifecycle.providerTurnDigest,
      }),
    );
    addCapacityHistoryPayload({
      event: userHistory,
      ownerSessionKey: sessionKey,
      payloadKind: "message-content",
      content: problemText,
      encoding: "utf-8",
      payloads: historyPayloads,
      chunks: historyPayloadChunks,
    });
    addCapacityHistoryPayload({
      event: assistantHistory,
      ownerSessionKey: sessionKey,
      payloadKind: "message-content",
      content: finalAnswerExcerpt,
      encoding: "utf-8",
      payloads: historyPayloads,
      chunks: historyPayloadChunks,
    });

    const retryCorrelationDigest = globalIndex % 7 === 0
      ? hashKey(
        "benchmark-retry-correlation",
        Buffer.from(sessionKey, "hex"),
        String(globalIndex),
      )
      : null;
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
      const historyCorrelationDigest = retryCorrelationDigest !== null && useIndex < 2
        ? retryCorrelationDigest
        : correlationDigest;
      const invocationHistory = capacityHistoryEvent(invocation, {
        capabilityKey: tool.capabilityKey,
        correlationDigest: historyCorrelationDigest,
        inputFingerprint,
        fileActivities: [capacityFileActivity(globalIndex, useIndex, "attempted")],
      });
      const solutionRecallMarker = failed && globalIndex === 0 && useIndex === 0
        ? " solutionrecallprobe"
        : "";
      const resultText = failed
        ? `benchmark retry error${solutionRecallMarker} ` +
          `topic${alphabeticOrdinal(globalIndex % CAPACITY_TOPIC_COUNT)} ` +
          `for ${name} at turn ${globalIndex}`
        : `benchmark result completed topic${alphabeticOrdinal(globalIndex % CAPACITY_TOPIC_COUNT)} ` +
          `for ${name} at turn ${globalIndex}`;
      const resultHistory = capacityHistoryEvent(result, {
        capabilityKey: tool.capabilityKey,
        correlationDigest: historyCorrelationDigest,
        providerState: result.providerState,
        exitCode: result.exitCode,
        outputBytes: result.outputBytes,
        durationMs: result.durationMs,
        fileActivities: [capacityFileActivity(
          globalIndex,
          useIndex,
          failed ? "failed" : "confirmed",
        )],
        ...(failed
          ? {
            errorSignatureVersion: "error-signature@1",
            errorSignature: sha256(resultText.toLowerCase()),
          }
          : {}),
      });
      historyEvents.push(invocationHistory, resultHistory);
      addCapacityHistoryPayload({
        event: invocationHistory,
        ownerSessionKey: sessionKey,
        payloadKind: "tool-input",
        content: canonicalJson({
          path: capacityFileActivity(globalIndex, useIndex, "attempted").rawPath,
          topic: globalIndex % CAPACITY_TOPIC_COUNT,
          useIndex,
        }),
        encoding: "canonical-json",
        payloads: historyPayloads,
        chunks: historyPayloadChunks,
      });
      addCapacityHistoryPayload({
        event: resultHistory,
        ownerSessionKey: sessionKey,
        payloadKind: failed ? "error-content" : "tool-output",
        content: resultText,
        encoding: "utf-8",
        payloads: historyPayloads,
        chunks: historyPayloadChunks,
      });
    }

    const tokenRecord = sourceRecord(
      sessionKey,
      turnStartOffset + 9 * 1_024 + 1,
      "benchmark:token-usage",
      `${plan.seed}:${sessionIndex}:${globalIndex}:token:${replacementMarker}`,
    );
    const tokenEvent = capacityHistoryEvent({
      ...commonEvent(tokenRecord, turnKey, "token-usage", "benchmark:token-usage", timestamp),
      kind: "token-usage",
    }, {
      usageScope: "delta",
      model: provider === "codex" ? "gpt-benchmark" : "claude-benchmark",
      inputTokens: String(1_000 + globalIndex % 2_000),
      cachedInputTokens: String(200 + globalIndex % 500),
      cacheWriteInputTokens: String(50 + globalIndex % 100),
      outputTokens: String(300 + globalIndex % 700),
      reasoningTokens: String(100 + globalIndex % 300),
      totalTokens: String(1_650 + globalIndex % 3_600),
    });
    sourceRecords.push(tokenRecord);
    historyEvents.push(tokenEvent);
  }

  if (sessionIndex === 0) {
    const probeStartOffset = sessionTurnCount * 16_384 + 1;
    const probeContent = sizedText(
      "benchmark evidence paging probe provider payload ",
      CAPACITY_DENSITY.evidencePagingProbeBytes,
    );
    const probeRecord = sourceRecord(
      sessionKey,
      probeStartOffset,
      "benchmark:provider-unknown",
      `${plan.seed}:evidence-paging-probe:${replacement ? "replacement" : "initial"}`,
    );
    probeRecord.endOffset = String(probeStartOffset + Buffer.byteLength(probeContent, "utf8"));
    const probeEvent = capacityHistoryEvent({
      ...commonEvent(
        probeRecord,
        turns[0].turnKey,
        "provider-unknown",
        "benchmark:provider-unknown",
        observedStart,
      ),
      kind: "provider-unknown",
    }, {});
    sourceRecords.push(probeRecord);
    historyEvents.push(probeEvent);
    addCapacityHistoryPayload({
      event: probeEvent,
      ownerSessionKey: sessionKey,
      payloadKind: "provider-payload",
      content: probeContent,
      encoding: "utf-8",
      payloads: historyPayloads,
      chunks: historyPayloadChunks,
    });
  }
  finalizeCapacityHistory(historyEvents, historyPayloads, historyPayloadChunks);

  const lastGlobalTurn = firstGlobalTurn + sessionTurnCount - 1;
  const completeOffset = String(
    sessionTurnCount * 16_384 +
    (sessionIndex === 0 ? CAPACITY_DENSITY.evidencePagingProbeBytes + 1 : 0),
  );
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
    format: "session-facts-delta@v2",
    factSchemaVersion: 2,
      providerAdapterVersion: `${provider}@3`,
    privacyPolicyVersion: 2,
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
    historyEvents,
    historyPayloads,
    historyPayloadChunks,
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
  const files = await databaseGroupFootprint(databasePath);
  return files.databaseBytes + files.walBytes + files.shmBytes;
}

async function databaseGroupFootprint(databasePath) {
  const files = { databaseBytes: 0, walBytes: 0, shmBytes: 0 };
  for (const [suffix, field] of [
    ["", "databaseBytes"],
    ["-wal", "walBytes"],
    ["-shm", "shmBytes"],
  ]) {
    try {
      files[field] = (await stat(`${databasePath}${suffix}`)).size;
    } catch (error) {
      if (error?.code !== "ENOENT") throw error;
    }
  }
  return files;
}

function sqliteObjectOwner(name) {
  const autoIndex = /^sqlite_autoindex_(.+)_[0-9]+$/u.exec(name)?.[1] ?? null;
  return autoIndex ?? name;
}

function storageOwner(name) {
  const owner = sqliteObjectOwner(name);
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
    "history_events_session_revision",
    "history_events_session_order",
    "history_events_source_record",
    "history_events_occurred_turn",
    "history_events_observed",
    "history_events_kind_observed",
    "history_events_kind_order",
    "attempt_chain_events_chain",
    "attempt_chain_events_correlation",
    "history_payloads_event",
    "file_activity_path_observed",
    "file_activity_observed",
    "token_usage_model_observed",
    "token_usage_observed",
    "error_occurrences_signature_observed",
    "error_occurrences_observed",
  ].includes(name)) return "fact";
  if (FTS_TABLES.has(owner) || owner === "turns_fts" || owner.startsWith("turns_fts_") ||
      owner === "history_event_fts" || owner.startsWith("history_event_fts_")) {
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
    "history_event_coverage_kind",
    "history_event_coverage_observed",
    "history_event_kind_rollups_kind",
    "history_event_day_coverage_rollups_day",
    "history_activity_rollups_day",
    "history_token_rollups_session",
    "history_token_rollups_day",
    "history_capability_rollups_day",
    "history_capability_representatives_capability_day",
    "history_capability_cooccurrences_capability_day",
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
      : "normalized-row-v2-within-capacity-gates",
  });
}

async function auditCapacityDatabase(databasePath, {
  stagingUpperBoundBytes,
  rss,
  turnCount,
}) {
  const preVacuumFiles = await databaseGroupFootprint(databasePath);
  const preVacuumPersistentBytes =
    preVacuumFiles.databaseBytes + preVacuumFiles.walBytes + preVacuumFiles.shmBytes;
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
  let historyFtsIntegrity = "not-present";
  if (existingTables.has("history_event_fts")) {
    database.exec(
      "INSERT INTO history_event_fts(history_event_fts) VALUES('integrity-check')",
    );
    historyFtsIntegrity = "ok";
  }
  const foreignKeyViolations = database.prepare("PRAGMA foreign_key_check").all().length;
  const pageCount = Number(database.prepare("PRAGMA page_count").get().page_count);
  const pageSize = Number(database.prepare("PRAGMA page_size").get().page_size);
  const freelistCount = Number(
    database.prepare("PRAGMA freelist_count").get().freelist_count,
  );
  const deepHistory = existingTables.has("history_coverage_rollups")
    ? database.prepare(
      `SELECT COALESCE(SUM(fts_searchable_payload_bytes),0) AS searchablePayloadBytes,
              COALESCE(SUM(fts_stored_not_searchable_payload_bytes),0)
                AS storedNotSearchablePayloadBytes,
              COALESCE(SUM(fts_searchable_event_count),0) AS searchableEventCount,
              COALESCE(SUM(fts_stored_not_searchable_event_count),0)
                AS storedNotSearchableEventCount
         FROM history_coverage_rollups`,
    ).get()
    : {
      searchablePayloadBytes: 0,
      storedNotSearchablePayloadBytes: 0,
      searchableEventCount: 0,
      storedNotSearchableEventCount: 0,
    };
  const explainDeepQuery = existingTables.has("history_events")
    ? database.prepare(
      `EXPLAIN QUERY PLAN
       SELECT he.event_key FROM history_events he
       JOIN sessions s ON s.session_id=he.session_id
       WHERE s.eligibility='eligible' AND s.session_scope='main'
         AND he.event_kind='capability-result'
       ORDER BY he.observed_timestamp IS NULL ASC,
                he.observed_timestamp DESC,he.event_key ASC LIMIT 20`,
    ).all().map((row) => row.detail)
    : [];
  database.close();

  const postVacuumFiles = await databaseGroupFootprint(databasePath);
  const postVacuumPersistentBytes =
    postVacuumFiles.databaseBytes + postVacuumFiles.walBytes + postVacuumFiles.shmBytes;
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
    preVacuumFiles,
    preVacuumPersistentBytes,
    postVacuumFiles,
    postVacuumPersistentBytes,
    dbstatBytes,
    dbstatAccountedPageBytes,
    databasePageBytes,
    pageCount,
    pageSize,
    freelistCount,
    fileFormatPages,
    stagingUpperBoundBytes,
    stagingMeasurement: "maximum canonical SessionFactsDeltaV2 bytes",
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
    deepHistory: {
      searchablePayloadBytes: Number(deepHistory.searchablePayloadBytes),
      storedNotSearchablePayloadBytes: Number(deepHistory.storedNotSearchablePayloadBytes),
      searchableEventCount: Number(deepHistory.searchableEventCount),
      storedNotSearchableEventCount: Number(deepHistory.storedNotSearchableEventCount),
      ftsIntegrity: historyFtsIntegrity,
    },
    explain: {
      recordsByEventKind: explainDeepQuery,
    },
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
    requiredContract: createInsightsRequiredContract(ORIGIN_SECRET_EPOCH),
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
        factStorageProfile: "normalized-row-v2",
        storageSchemaVersion: 2,
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
    requiredContract: createInsightsRequiredContract(ORIGIN_SECRET_EPOCH),
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
  const started = prepareCursor;
  const messages = createSessionDeltaMessages(delta, {
    requestId,
    factStorageProfile: "normalized-row-v2",
    storageSchemaVersion: 2,
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
  return { response: committed, roundTripMs: performance.now() - started };
}

async function exchangeCapacityRequest(runtime, message, expectedType) {
  const started = performance.now();
  const frame = encodeProtocolFrame(message);
  runtime.stats.requestFrames += 1;
  runtime.stats.requestBytes += frame.length;
  await writeEncodedFrame(runtime.child.stdin, frame);
  const response = await nextResponse(runtime.responses, expectedType, message.requestId);
  const roundTripMs = performance.now() - started;
  const responseFrame = encodeProtocolFrame(response);
  runtime.stats.responseFrames += 1;
  runtime.stats.responseBytes += responseFrame.length;
  return { response, roundTripMs };
}

async function sendCapacityRequest(runtime, message, expectedType) {
  return (await exchangeCapacityRequest(runtime, message, expectedType)).response;
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

const DEEP_QUERY_RECIPE_NAMES = Object.freeze([
  "capability-contexts@1",
  "failure-chains@1",
  "file-workflow-signals@1",
  "activity-shifts@1",
  "token-hotspots@1",
  "solution-recall@1",
  "session-timeline@1",
]);

function deepQueryClock(plan) {
  const dayMs = 24 * 60 * 60 * 1_000;
  const after = BASE_TIME_MS;
  const before = Math.ceil((BASE_TIME_MS + (plan.turnCount + 1) * 1_000) / dayMs) * dayMs;
  return Object.freeze({
    window: Object.freeze({
      after: new Date(after).toISOString(),
      before: new Date(before).toISOString(),
    }),
    evaluatedAt: new Date(before + 60 * 60 * 1_000).toISOString(),
  });
}

function deepRecipeRequest(name, plan, sessionKey) {
  const clock = deepQueryClock(plan);
  const sessionScoped = new Set([
    "failure-chains@1",
    "file-workflow-signals@1",
    "session-timeline@1",
  ]).has(name);
  return {
    format: "threadshare-insights-recipe-request@v1",
    name,
    window: clock.window,
    comparisonWindow: null,
    filters: {
      providers: [],
      projectKeys: [],
      capabilityKeys: [],
      sessionKeys: sessionScoped ? [sessionKey] : [],
      eventKinds: [],
      text: name === "solution-recall@1" ? "solutionrecallprobe" : null,
      bucket: name === "activity-shifts@1" ? "day" : null,
    },
    limit: 10,
    allowDegraded: false,
    evaluatedAt: clock.evaluatedAt,
  };
}

function deepRecordsRequest(plan) {
  return {
    format: "threadshare-insights-query-request@v2",
    resource: "event",
    where: { field: "event.kind", op: "eq", value: "capability-result" },
    shape: {
      kind: "records",
      select: ["eventKey", "turnKey", "observedAt", "event.kind", "payloadRef"],
      payloadMode: "reference",
    },
    orderBy: [
      { field: "observedAt", direction: "desc" },
      { field: "eventKey", direction: "asc" },
    ],
    limit: 20,
    cursor: null,
    count: "exact",
    evaluatedAt: deepQueryClock(plan).evaluatedAt,
  };
}

function deepAggregateRequest(plan) {
  return {
    format: "threadshare-insights-query-request@v2",
    resource: "token-usage",
    where: null,
    shape: {
      kind: "aggregate",
      groupBy: ["provider"],
      metrics: [
        { name: "total-token-count", op: "sum", field: "token.total" },
        { name: "event-count", op: "count" },
      ],
    },
    orderBy: [
      { field: "total-token-count", direction: "desc" },
      { field: "provider", direction: "asc" },
    ],
    limit: 20,
    cursor: null,
    count: "exact",
    evaluatedAt: deepQueryClock(plan).evaluatedAt,
  };
}

function deepEvidenceTarget(plan) {
  const first = plan.sessionAt(0);
  const payload = first.delta.historyPayloads.reduce((largest, candidate) =>
    BigInt(candidate.byteLength) > BigInt(largest.byteLength) ? candidate : largest);
  const event = first.delta.historyEvents.find(({ eventKey }) => eventKey === payload.eventKey);
  if (!event) throw new Error("capacity evidence target event is missing");
  return {
    target: {
      kind: "event",
      eventKey: event.eventKey,
      revision: event.revision,
      payloadKey: payload.payloadKey,
    },
    payloadBytes: Number(payload.byteLength),
  };
}

async function benchmarkDeepQuery({ runtime, plan, queryCount, warmupCount }) {
  const total = queryCount + warmupCount;
  const digest = createHash("sha256");
  const records = [];
  const aggregates = [];
  const recipes = new Map(DEEP_QUERY_RECIPE_NAMES.map((name) => [name, []]));
  const evidenceFirstPages = [];
  const evidencePages = [];
  const evidenceReads = [];
  let requestId = 3_000_000;
  let recordsEmptyCount = 0;
  let aggregateEmptyCount = 0;
  const recipeEmptyCounts = Object.fromEntries(DEEP_QUERY_RECIPE_NAMES.map((name) => [name, 0]));
  let evidenceReadCount = 0;
  let evidenceMultiPageReadCount = 0;
  let evidencePayloadBytes = 0;
  const sessionKey = plan.sessionKey(0);
  const evidence = deepEvidenceTarget(plan);

  for (let index = 0; index < total; index += 1) {
    const measured = index >= warmupCount;
    const recordsExchange = await exchangeCapacityRequest(
      runtime,
      createReadInsightsQueryV2Message({
        requestId: String(requestId++),
        request: deepRecordsRequest(plan),
      }),
      "INSIGHTS_QUERY_V2",
    );
    const recordsResponse = recordsExchange.response;
    if (recordsResponse.response.records.length === 0) recordsEmptyCount += measured ? 1 : 0;
    if (measured) {
      records.push(recordsExchange.roundTripMs);
      digest.update(canonicalJson(recordsResponse.response));
    }

    const aggregateExchange = await exchangeCapacityRequest(
      runtime,
      createReadInsightsQueryV2Message({
        requestId: String(requestId++),
        request: deepAggregateRequest(plan),
      }),
      "INSIGHTS_QUERY_V2",
    );
    const aggregateResponse = aggregateExchange.response;
    if (aggregateResponse.response.groups.length === 0) aggregateEmptyCount += measured ? 1 : 0;
    if (measured) {
      aggregates.push(aggregateExchange.roundTripMs);
      digest.update(canonicalJson(aggregateResponse.response));
    }

    for (const name of DEEP_QUERY_RECIPE_NAMES) {
      const recipeExchange = await exchangeCapacityRequest(
        runtime,
        createReadInsightsRecipeMessage({
          requestId: String(requestId++),
          request: deepRecipeRequest(name, plan, sessionKey),
        }),
        "INSIGHTS_RECIPE",
      );
      const recipeResponse = recipeExchange.response;
      if (recipeResponse.response.items.length === 0) {
        recipeEmptyCounts[name] += measured ? 1 : 0;
      }
      if (measured) {
        recipes.get(name).push(recipeExchange.roundTripMs);
        digest.update(canonicalJson(recipeResponse.response));
      }
    }

    let cursor = null;
    let pageCount = 0;
    let readBytes = 0;
    let readMs = 0;
    do {
      const evidenceExchange = await exchangeCapacityRequest(
        runtime,
        createReadInsightsEvidenceV2Message({
          requestId: String(requestId++),
          request: {
            format: "threadshare-insights-evidence-request@v2",
            target: evidence.target,
            include: ["envelope", "payload"],
            cursor,
            maxBytes: 1_024 * 1_024,
          },
        }),
        "INSIGHTS_EVIDENCE_V2",
      );
      const evidenceResponse = evidenceExchange.response;
      pageCount += 1;
      readMs += evidenceExchange.roundTripMs;
      readBytes += Buffer.byteLength(evidenceResponse.response.content, "utf8");
      cursor = evidenceResponse.response.nextCursor;
      if (measured) {
        if (pageCount === 1) evidenceFirstPages.push(evidenceExchange.roundTripMs);
        evidencePages.push(evidenceExchange.roundTripMs);
        digest.update(canonicalJson(evidenceResponse.response));
      }
    } while (cursor !== null);
    if (measured) {
      evidenceReadCount += 1;
      if (pageCount > 1) evidenceMultiPageReadCount += 1;
      evidencePayloadBytes += readBytes;
      evidenceReads.push({ bytes: readBytes, wallMs: readMs });
    }
  }

  const budget = queryBudget(plan.turnCount);
  const recordLatency = latencySummary(records, "ms");
  const aggregateLatency = latencySummary(aggregates, "ms");
  const evidenceFirstPageLatency = latencySummary(evidenceFirstPages, "ms");
  const evidencePageLatency = latencySummary(evidencePages, "ms");
  const evidenceReadWallMs = evidenceReads.reduce((sum, read) => sum + read.wallMs, 0);
  const evidenceMiBPerSecond = evidenceReadWallMs === 0
    ? 0
    : (evidencePayloadBytes / 1_048_576) / (evidenceReadWallMs / 1_000);
  const recipeLatency = Object.fromEntries(
    [...recipes].map(([name, values]) => [name, latencySummary(values, "ms")]),
  );
  const allRecipesExercised = Object.values(recipeEmptyCounts).every((count) => count === 0);
  const allRecipesWithinLimit = Object.values(recipeLatency).every(
    ({ p95, p99 }) =>
      p95 < DEEP_QUERY_RECIPE_P95_LIMIT_MS && p99 < DEEP_QUERY_RECIPE_P99_LIMIT_MS,
  );
  const allDeepQueryPathsExercised =
    recordsEmptyCount === 0 && aggregateEmptyCount === 0 && allRecipesExercised &&
    evidenceReadCount === queryCount && evidenceMultiPageReadCount === queryCount;
  const allMeasuredDeepQueryGatesPassed =
    allDeepQueryPathsExercised &&
    recordLatency.p95 < budget.p95Ms && recordLatency.p99 < budget.p99Ms &&
    aggregateLatency.p95 < budget.p95Ms && aggregateLatency.p99 < budget.p99Ms &&
    allRecipesWithinLimit && evidenceFirstPageLatency.p95 < 100 && evidenceMiBPerSecond >= 50;
  return {
    measuredRequestCount: queryCount,
    warmupRequestCount: warmupCount,
    records: {
      emptyResultCount: recordsEmptyCount,
      roundTripMs: recordLatency,
    },
    aggregate: {
      emptyResultCount: aggregateEmptyCount,
      roundTripMs: aggregateLatency,
    },
    recipes: Object.fromEntries(DEEP_QUERY_RECIPE_NAMES.map((name) => [name, {
      emptyResultCount: recipeEmptyCounts[name],
      roundTripMs: recipeLatency[name],
    }])),
    evidence: {
      targetPayloadBytes: evidence.payloadBytes,
      completedReadCount: evidenceReadCount,
      multiPageReadCount: evidenceMultiPageReadCount,
      returnedBytes: evidencePayloadBytes,
      firstPageRoundTripMs: evidenceFirstPageLatency,
      pageRoundTripMs: evidencePageLatency,
      readWallMs: evidenceReadWallMs,
      payloadMiBPerSecond: evidenceMiBPerSecond,
    },
    resultDigest: digest.digest("hex"),
    gates: {
      budget: budget.name,
      recordsWithinLimit: recordLatency.p95 < budget.p95Ms && recordLatency.p99 < budget.p99Ms,
      aggregateWithinLimit:
        aggregateLatency.p95 < budget.p95Ms && aggregateLatency.p99 < budget.p99Ms,
      evidenceFirstPageWithinLimit: evidenceFirstPageLatency.p95 < 100,
      evidencePagingAtLeast50MiBPerSecond: evidenceMiBPerSecond >= 50,
      allRecordsReturnedResults: recordsEmptyCount === 0,
      allAggregatesReturnedGroups: aggregateEmptyCount === 0,
      allRecipesExercised,
      allRecipesWithinLimit,
      allEvidenceReadsCompleted:
        evidenceReadCount === queryCount && evidenceMultiPageReadCount === queryCount,
      allDeepQueryPathsExercised,
      allMeasuredDeepQueryGatesPassed,
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
  deepQueryCount,
  deepQueryWarmupCount,
}) {
  const runtime = await openCapacitySidecar(binaryPath, databasePath);
  const digest = createHash("sha256");
  const sessionKeys = [];
  let canonicalBytes = 0;
  let maxSessionCanonicalBytes = 0;
  let lastCommittedSnapshotSeq = null;
  let corpusGenerationMs = 0;
  const commitAckLatencies = [];
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
      const committed = await sendCapacityDelta(
        runtime,
        session.delta,
        String(session.sessionIndex + 2),
      );
      const response = committed.response;
      commitAckLatencies.push(committed.roundTripMs);
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
  let deepQuery = null;
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
    if (deepQueryCount > 0) {
      deepQuery = await benchmarkDeepQuery({
        runtime,
        plan,
        queryCount: deepQueryCount,
        warmupCount: deepQueryWarmupCount,
      });
    }
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
      commitAckMs: latencySummary(commitAckLatencies, "ms"),
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
    ...(deepQuery === null ? {} : { deepQuery }),
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
      const { response } = await sendCapacityDelta(runtime, replacement.delta, "10");
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
  deepQueryCount = 0,
  deepQueryWarmupCount = 0,
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
  if (!Number.isSafeInteger(deepQueryCount) || deepQueryCount < 0) {
    throw new RangeError("deepQueryCount must be a non-negative safe integer");
  }
  if (!Number.isSafeInteger(deepQueryWarmupCount) || deepQueryWarmupCount < 0) {
    throw new RangeError("deepQueryWarmupCount must be a non-negative safe integer");
  }
  if (deepQueryCount === 0 && deepQueryWarmupCount !== 0) {
    throw new RangeError("deepQueryWarmupCount requires deepQueryCount");
  }
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
      deepQueryCount,
      deepQueryWarmupCount,
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
        boundedMemoryModel: "one generated SessionFactsDeltaV2 plus one protocol batch",
      },
      rustSidecar: rust,
      mutations,
      packedFactsDecision: rust.capacity.gates,
      notMeasured: [
        "raw provider JSONL parsing throughput; this corpus starts at SessionFactsDeltaV2",
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

function deepStorageSummary(capacity) {
  const audit = capacity.rustSidecar.capacity;
  const canonicalIndexedSourceBytes = capacity.corpus.canonicalBytes;
  const persistentBytes = audit.postVacuumPersistentBytes;
  const searchablePayloadBytes = audit.deepHistory.searchablePayloadBytes;
  const historyFtsBytes = Object.entries(audit.byObject)
    .filter(([name, value]) =>
      value.category === "fts" && sqliteObjectOwner(name).startsWith("history_event_fts"))
    .reduce((total, [, value]) => total + value.bytes, 0);
  const historyPayloadBytes = Object.entries(audit.byObject)
    .filter(([name]) => {
      const owner = sqliteObjectOwner(name);
      return owner === "history_payloads" || owner === "history_payload_chunks" ||
        name === "history_payloads_event";
    })
    .reduce((total, [, value]) => total + value.bytes, 0);
  const historyEventMetadataBytes = Object.entries(audit.byObject)
    .filter(([name]) => {
      const owner = sqliteObjectOwner(name);
      return owner === "history_events" || owner === "attempt_chain_events" ||
        owner === "file_activity" || owner === "token_usage" ||
        owner === "error_occurrences" || name.startsWith("history_events_") ||
        name.startsWith("attempt_chain_events_") || name.startsWith("file_activity_") ||
        name.startsWith("token_usage_") || name.startsWith("error_occurrences_");
    })
    .reduce((total, [, value]) => total + value.bytes, 0);
  const persistentStorageAmplification = ratio(persistentBytes, canonicalIndexedSourceBytes);
  const historyFtsAmplification = ratio(historyFtsBytes, searchablePayloadBytes);
  return {
    canonicalIndexedSourceBytes,
    preVacuum: audit.preVacuumFiles,
    postVacuum: audit.postVacuumFiles,
    persistentBytes,
    stagingUpperBoundBytes: audit.stagingUpperBoundBytes,
    historyEventMetadataBytes,
    historyPayloadBytes,
    historyFtsBytes,
    projectionBytes: audit.categories.projection.bytes,
    searchablePayloadBytes,
    storedNotSearchablePayloadBytes: audit.deepHistory.storedNotSearchablePayloadBytes,
    persistentStorageAmplification,
    historyFtsAmplification,
    limits: {
      persistentStorageAmplification: DEEP_STORAGE_AMPLIFICATION_LIMIT,
      historyFtsAmplification: DEEP_FTS_AMPLIFICATION_LIMIT,
    },
  };
}

export function createDeepQueryBenchmarkReport(capacity) {
  if (capacity?.format !== CAPACITY_BENCHMARK_FORMAT || capacity.rustSidecar?.deepQuery === undefined) {
    throw new TypeError("Deep Query evidence requires a completed capacity report");
  }
  const turnCount = capacity.corpus.turns;
  const deepQuery = capacity.rustSidecar.deepQuery;
  const storage = deepStorageSummary(capacity);
  const rows = capacity.rustSidecar.capacity.rowCounts;
  const density = capacity.corpus.density;
  const v2CorpusComplete =
    rows.history_events === turnCount * density.historyEventsPerTurn +
      density.evidencePagingProbeEvents &&
    rows.history_payloads === turnCount * density.historyPayloadsPerTurn +
      density.evidencePagingProbePayloads &&
    rows.history_payload_chunks === turnCount * density.historyPayloadChunksPerTurn +
      density.evidencePagingProbeChunks;
  const storageAmplificationWithinLimit =
    storage.persistentStorageAmplification !== null &&
    storage.persistentStorageAmplification <= DEEP_STORAGE_AMPLIFICATION_LIMIT;
  const historyFtsAmplificationWithinLimit =
    storage.historyFtsAmplification !== null &&
    storage.historyFtsAmplification <= DEEP_FTS_AMPLIFICATION_LIMIT;
  const recordsPlan = capacity.rustSidecar.capacity.explain.recordsByEventKind;
  const queryPlanUsesEventKindIndex =
    recordsPlan.some((detail) => detail.includes("history_events_kind_order")) &&
    !recordsPlan.some((detail) => /\bSCAN he\b/u.test(detail));
  const gates = {
    v2CorpusComplete,
    deepQueryPathsComplete: deepQuery.gates.allDeepQueryPathsExercised,
    deepQueryPerformanceWithinLimit: deepQuery.gates.allMeasuredDeepQueryGatesPassed,
    historyFtsIntegrityPassed:
      capacity.rustSidecar.capacity.deepHistory.ftsIntegrity === "ok",
    engineRssWithin128MiB:
      capacity.rustSidecar.capacity.engineRss.sidecarPeakBytes > 0 &&
      capacity.rustSidecar.capacity.engineRss.sidecarPeakBytes <= LONG_TERM_ENGINE_RSS_LIMIT_BYTES,
    storageAmplificationWithinLimit,
    historyFtsAmplificationWithinLimit,
    storageClassificationComplete:
      capacity.rustSidecar.capacity.gates.storageClassificationComplete,
    queryPlanUsesEventKindIndex,
  };
  gates.allMeasuredDeepQueryEvidenceGatesPassed = Object.values(gates)
    .every((value) => value === true);
  return {
    format: DEEP_QUERY_BENCHMARK_FORMAT,
    measuredScope: "local-insights-fact-v2-deep-query-capacity-and-performance",
    sourceRevision: capacity.sourceRevision,
    sourceWorktreeDirty: capacity.sourceWorktreeDirty,
    benchmarkScriptSha256: capacity.benchmarkScriptSha256,
    environment: capacity.environment,
    corpus: capacity.corpus,
    engineIdentity: capacity.rustSidecar.engineIdentity,
    backfill: capacity.rustSidecar.backfill,
    protocol: capacity.rustSidecar.protocol,
    rss: capacity.rustSidecar.rss,
    deepQuery,
    storage,
    rowCounts: Object.fromEntries([
      "history_events", "history_payloads", "history_payload_chunks", "attempt_chain_events",
      "file_activity", "token_usage", "error_occurrences", "history_event_fts_documents",
    ].map((name) => [name, rows[name] ?? 0])),
    explain: capacity.rustSidecar.capacity.explain,
    gates,
    notMeasured: [
      "raw provider parsing; the synthetic corpus starts at SessionFactsDeltaV2",
      "30% real Session byte sample; it is recorded as an independent evidence artifact",
      "single-Session 512 MiB logical payload boundary; the dedicated Rust boundary test owns it",
    ],
  };
}

export async function runInsightsDeepQueryBenchmark({
  turnCount = 25_000,
  turnsPerSession = 100,
  queryCount = FORMAL_DEEP_QUERY_COUNT,
  warmupCount = FORMAL_DEEP_QUERY_WARMUP_COUNT,
  seed = FORMAL_DEEP_QUERY_SEEDS[turnCount] ?? `${DEFAULT_SEED}-deep-query`,
  binaryPath = process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE_PATH,
  workingDirectory,
  formal = false,
} = {}) {
  positiveInteger(queryCount, "queryCount");
  positiveInteger(warmupCount, "warmupCount");
  if (formal && !FORMAL_QUERY_BENCHMARK_TURN_COUNTS.includes(turnCount)) {
    throw new RangeError("formal Deep Query evidence requires exactly 25000 or 250000 Turns");
  }
  if (formal && turnsPerSession !== 100) {
    throw new RangeError("formal Deep Query evidence requires exactly 100 Turns per session");
  }
  if (formal && seed !== FORMAL_DEEP_QUERY_SEEDS[turnCount]) {
    throw new RangeError(
      `formal Deep Query evidence requires seed ${FORMAL_DEEP_QUERY_SEEDS[turnCount]}`,
    );
  }
  if (formal && queryCount !== FORMAL_DEEP_QUERY_COUNT) {
    throw new RangeError(
      `formal Deep Query evidence requires exactly ${FORMAL_DEEP_QUERY_COUNT} measured runs`,
    );
  }
  if (formal && warmupCount !== FORMAL_DEEP_QUERY_WARMUP_COUNT) {
    throw new RangeError(
      `formal Deep Query evidence requires exactly ${FORMAL_DEEP_QUERY_WARMUP_COUNT} warmups`,
    );
  }
  const capacity = await runInsightsCapacityBenchmark({
    turnCount,
    turnsPerSession,
    queryCount: Math.min(queryCount, 100),
    warmupCount: Math.min(warmupCount, 20),
    deepQueryCount: queryCount,
    deepQueryWarmupCount: warmupCount,
    seed,
    binaryPath,
    workingDirectory,
    mutationTrace: false,
  });
  return createDeepQueryBenchmarkReport(capacity);
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

function deliveryObjectId(seed, index, domain = "commit") {
  return createHash("sha1").update(`${seed}:${domain}:${index}`).digest("hex");
}

function deliveryCommitFiles(index, turnCount) {
  const globalIndex = index * 5;
  const deferredRustPath = index >= 4_903
    ? `src/module-${index - 4_903}.rs`
    : `src/generated-${globalIndex % 257}.rs`;
  return [
    {
      path: `docs/topic-${globalIndex % CAPACITY_TOPIC_COUNT}.md`, oldPath: null,
      status: "M", additions: "3", deletions: "1",
    },
    {
      path: deferredRustPath, oldPath: null,
      status: "M", additions: "5", deletions: "2",
    },
    {
      path: `src/module-${globalIndex % 97}.mjs`,
      oldPath: index === 100 ? "src/legacy-module.mjs" : null,
      status: index === 100 ? "R" : "M", additions: "4", deletions: "2",
    },
    {
      path: `tests/case-${globalIndex % 211}.test.mjs`, oldPath: null,
      status: "M", additions: "6", deletions: "1",
    },
  ].map(Object.freeze);
}

function deliveryTraceCorpus(plan) {
  const commitCount = 5_000;
  const repositoryKey = hashKey("benchmark-delivery-repository", plan.seed);
  const commits = Array.from({ length: commitCount }, (_, index) => {
    const timestampIndex = index >= 4_903 ? plan.turnCount + 86_400 + index : index * 5;
    return Object.freeze({
      objectId: deliveryObjectId(plan.seed, index),
      parentObjectIds: index <= 1 ? [] : [deliveryObjectId(plan.seed, index - 1)],
      authorTimestamp: new Date(BASE_TIME_MS + timestampIndex * 1_000).toISOString(),
      committerTimestamp: new Date(BASE_TIME_MS + timestampIndex * 1_000).toISOString(),
      treeObjectId: deliveryObjectId(plan.seed, index, "tree"),
      summary: `synthetic delivery commit ${index}`,
      files: deliveryCommitFiles(index, plan.turnCount),
    });
  });
  const intentNodes = Array.from({ length: 100 }, (_, index) => Object.freeze({
    id: `delivery-${String(index).padStart(3, "0")}`,
    parentId: null,
    kind: "feature",
    title: index === 99
      ? "uniqueaxa uniqueaxb"
      : `Synthetic delivery intent ${index}`,
    status: index % 3 === 0 ? "complete" : "todo",
    stableId: true,
  }));
  const intentRefs = [];
  for (let index = 0; index < 20; index += 1) {
    intentRefs.push({
      nodeId: intentNodes[index].id,
      kind: "commit",
      value: commits[index * 7].objectId,
    });
  }
  for (let index = 20; index < 40; index += 1) {
    intentRefs.push({
      nodeId: intentNodes[index].id,
      kind: "session",
      value: plan.sessionKey(index % 2),
    });
  }
  for (let index = 40; index < 50; index += 1) {
    intentRefs.push({
      nodeId: intentNodes[index].id,
      kind: index % 2 === 0 ? "spec" : "issue",
      value: index % 2 === 0 ? `docs/spec-${index}.md` : `ISSUE-${index}`,
    });
  }
  return Object.freeze({
    repositoryId: "44444444-4444-4444-8444-444444444444",
    repositoryKey,
    projectKeys: Object.freeze([
      plan.sessionAt(0).delta.session.projectKey,
      plan.sessionAt(1).delta.session.projectKey,
    ]),
    commits: Object.freeze(commits),
    intentNodes: Object.freeze(intentNodes),
    intentRefs: Object.freeze(intentRefs.map(Object.freeze)),
  });
}

function deliveryTraceDelta(corpus, { expectedGeneration, targetGeneration, commits }) {
  const last = commits.at(-1) ?? corpus.commits.at(-1);
  const value = {
    format: "threadshare-insights-trace-source-delta@v1",
    expectedGeneration: String(expectedGeneration),
    targetGeneration: String(targetGeneration),
    repository: {
      repositoryId: corpus.repositoryId,
      repositoryKey: corpus.repositoryKey,
      available: true,
      refDigest: sha256(canonicalJson([{ name: "refs/heads/main", objectId: last.objectId }])),
      scmProvider: "github",
      webBaseUrl: "https://github.com",
      repositoryPath: "team-harness/threadshare-synthetic",
      projectKeys: [...corpus.projectKeys],
    },
    intent: {
      sourceKey: hashKey("benchmark-intent-source", corpus.repositoryKey),
      adapterVersion: "markdown-checklist@1",
      revision: hashKey("benchmark-intent-revision", corpus.repositoryKey, "1"),
      locator: "docs/intent.md",
      coverage: "partial",
      diagnostics: [{ line: "51", code: "TS_INSIGHTS_INTENT_REF_UNRESOLVED" }],
    },
    refs: [{ name: "refs/heads/main", objectId: last.objectId }],
    commits: [...commits],
    intentNodes: [...corpus.intentNodes],
    intentRefs: [...corpus.intentRefs],
  };
  return Object.freeze({
    ...value,
    deltaId: sha256(canonicalJson(traceSourceDigestDocument(value))),
  });
}

async function copySqliteSnapshot(source, target) {
  await rm(target, { force: true });
  const database = await openNodeDatabase(source);
  try {
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
    database.exec(`VACUUM INTO '${target.replaceAll("'", "''")}'`);
  } finally {
    database.close();
  }
}

async function deliveryGraphSummary(databasePath, repositoryId) {
  const database = await openNodeDatabase(databasePath);
  const digest = createHash("sha256");
  const statements = [
    "SELECT repository_id,lower(hex(repository_key)),available FROM repository_sources ORDER BY repository_id",
    "SELECT repository_id,ref_name,object_id FROM repository_refs ORDER BY repository_id,ref_name",
    "SELECT repository_id,object_id,lower(hex(commit_key)),parent_object_ids_json,author_timestamp,committer_timestamp,tree_object_id,summary,reachable,lower(hex(revision)) FROM git_commits ORDER BY repository_id,object_id",
    "SELECT repository_id,object_id,path,old_path,status,lower(hex(additions)),lower(hex(deletions)),lower(hex(file_key)),lower(hex(revision)) FROM git_commit_files ORDER BY repository_id,object_id,path",
    "SELECT repository_id,object_id,lower(hex(edge_key)),from_kind,lower(hex(from_key)),to_kind,lower(hex(to_key)),relation,strength,source,lower(hex(revision)) FROM delivery_trace_edges ORDER BY repository_id,object_id,edge_key",
    "SELECT lower(hex(edge_key)),facts_json,limitations_json FROM delivery_trace_edge_evidence ORDER BY edge_key",
    "SELECT repository_id,lower(hex(intent_key)),node_id,kind,title,status,lower(hex(revision)) FROM intent_nodes ORDER BY repository_id,node_id",
    "SELECT repository_id,node_id,ref_kind,ref_value,lower(hex(revision)) FROM intent_refs ORDER BY repository_id,node_id,ref_kind,ref_value",
    "SELECT repository_id,lower(hex(edge_key)),lower(hex(from_key)),to_kind,lower(hex(to_key)),relation,strength,source,facts_json,limitations_json,lower(hex(revision)) FROM intent_trace_edges ORDER BY repository_id,edge_key",
  ];
  for (const sql of statements) digest.update(canonicalJson(database.prepare(sql).all()));
  const scalar = (sql) => Number(database.prepare(sql).get().value);
  const counts = {
    commits: scalar("SELECT COUNT(*) value FROM git_commits"),
    changedFiles: scalar("SELECT COUNT(*) value FROM git_commit_files"),
    intents: scalar("SELECT COUNT(*) value FROM intent_nodes"),
    unresolvedRefs: scalar("SELECT COUNT(*) value FROM intent_refs WHERE ref_kind IN ('spec','issue')"),
    unreachableCommits: scalar("SELECT COUNT(*) value FROM git_commits WHERE reachable=0"),
    directEdges: scalar("SELECT (SELECT COUNT(*) FROM delivery_trace_edges WHERE strength='direct')+(SELECT COUNT(*) FROM intent_trace_edges WHERE strength='direct') value"),
    observedEdges: scalar("SELECT COUNT(*) value FROM delivery_trace_edges WHERE strength='observed'"),
    candidateEdges: scalar("SELECT COUNT(*) value FROM intent_trace_edges WHERE strength='candidate'"),
    contextualEdges: scalar("SELECT COUNT(*) value FROM delivery_trace_edges WHERE strength='contextual'"),
  };
  const one = (sql) => database.prepare(sql).get();
  const roots = {
    session: one("SELECT lower(hex(s.session_key)) key FROM sessions s JOIN repository_project_keys p ON p.project_key=s.project_key ORDER BY s.session_key LIMIT 1").key,
    project: one("SELECT lower(hex(s.project_key)) key FROM sessions s JOIN repository_project_keys p ON p.project_key=s.project_key ORDER BY s.session_key LIMIT 1").key,
    commit: one("SELECT lower(hex(commit_key)) key FROM git_commits WHERE reachable=1 ORDER BY object_id LIMIT 1").key,
    intent: one("SELECT lower(hex(n.intent_key)) key FROM intent_nodes n JOIN intent_trace_edges e ON e.repository_id=n.repository_id AND e.from_key=n.intent_key ORDER BY n.intent_key LIMIT 1").key,
  };
  const edge = one("SELECT relation,from_kind,lower(hex(from_key)) from_key,to_kind,lower(hex(to_key)) to_key,lower(hex(revision)) revision FROM delivery_trace_edges ORDER BY CASE strength WHEN 'observed' THEN 0 WHEN 'contextual' THEN 1 ELSE 2 END,edge_key LIMIT 1");
  const explain = {
    edgeBySource: database.prepare("EXPLAIN QUERY PLAN SELECT edge_key FROM delivery_trace_edges WHERE repository_id=? AND from_kind=? AND from_key=? ORDER BY edge_key LIMIT 201").all(repositoryId, "session", Buffer.from(roots.session, "hex")).map(({ detail }) => detail),
    changedFileByPath: database.prepare("EXPLAIN QUERY PLAN SELECT object_id FROM git_commit_files WHERE repository_id=? AND path=? ORDER BY object_id").all(repositoryId, "src/module-0.rs").map(({ detail }) => detail),
    repositoryByProject: database.prepare("EXPLAIN QUERY PLAN SELECT repository_id FROM repository_project_keys WHERE project_key=? ORDER BY repository_id").all(Buffer.from(roots.project, "hex")).map(({ detail }) => detail),
  };
  database.close();
  return { digest: digest.digest("hex"), counts, roots, edge, explain };
}

function deliveryTraceRequest(root, evaluatedAt, options = {}) {
  return {
    format: "threadshare-insights-delivery-trace-request@v1",
    root,
    window: null,
    direction: "both",
    maxDepth: options.maxDepth ?? 1,
    includeCandidateEdges: options.includeCandidateEdges ?? false,
    includeContextualEdges: options.includeContextualEdges ?? false,
    limit: 50,
    cursor: null,
    evaluatedAt,
  };
}

async function openDeliveryBenchmarkClient(binaryPath, databasePath, onSpawn) {
  return createInsightsEngineClient({
    databasePath,
    openExisting: true,
    requiredContract: createInsightsRequiredContract(ORIGIN_SECRET_EPOCH),
    timeoutMs: 30_000,
    commitTimeoutMs: 120_000,
    runtimeOptions: {
      env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: path.resolve(binaryPath) },
    },
    onSpawn,
  });
}

async function deliveryRepositoryGeneration(databasePath, repositoryId) {
  const database = await openNodeDatabase(databasePath);
  try {
    return Number(database.prepare(
      "SELECT generation FROM repository_sources WHERE repository_id=?",
    ).get(repositoryId)?.generation ?? 0);
  } finally {
    database.close();
  }
}

async function resetDeliveryTraceBenchmarkState(databasePath) {
  const database = await openNodeDatabase(databasePath);
  try {
    database.exec("PRAGMA foreign_keys=ON; BEGIN IMMEDIATE; DELETE FROM repository_sources; COMMIT;");
    database.exec("PRAGMA wal_checkpoint(TRUNCATE)");
  } catch (error) {
    try { database.exec("ROLLBACK"); } catch {}
    throw error;
  } finally {
    database.close();
  }
}

async function applyDeliveryTrace(binaryPath, databasePath, deltas, onSpawn) {
  const client = await openDeliveryBenchmarkClient(binaryPath, databasePath, onSpawn);
  try {
    for (const delta of deltas) await client.commitTraceSourceDelta(delta);
  } finally {
    await client.close();
  }
}

async function benchmarkGitDiff(directory, queryCount, warmupCount) {
  const repository = path.join(directory, "git-diff-fixture");
  await mkdir(repository, { recursive: true });
  const git = async (...args) => execFileAsync("git", ["-C", repository, ...args], {
    encoding: "utf8", env: { ...process.env, GIT_AUTHOR_NAME: "Benchmark", GIT_AUTHOR_EMAIL: "benchmark@example.invalid", GIT_COMMITTER_NAME: "Benchmark", GIT_COMMITTER_EMAIL: "benchmark@example.invalid" },
  });
  await git("init", "--quiet");
  await git("config", "commit.gpgSign", "false");
  await writeFile(path.join(repository, "probe.txt"), "first\n");
  await git("add", "probe.txt");
  await git("commit", "--quiet", "-m", "first");
  const parent = (await git("rev-parse", "HEAD")).stdout.trim();
  await writeFile(path.join(repository, "probe.txt"), "first\nsecond\n");
  await git("add", "probe.txt");
  await git("commit", "--quiet", "-m", "second");
  const commit = (await git("rev-parse", "HEAD")).stdout.trim();
  const values = [];
  for (let index = 0; index < queryCount + warmupCount; index += 1) {
    const started = performance.now();
    const response = await readGitDiffEvidence({
      format: "threadshare-insights-git-diff-evidence-request@v1",
      repositoryKey: "1".repeat(64), commitObjectId: commit, parentObjectId: parent,
      path: "probe.txt", contextLines: 3, maxBytes: 65_536, revision: "2".repeat(64),
      cursor: null,
    }, { rootDirectory: repository });
    if (index >= warmupCount) values.push(performance.now() - started);
    if (!response.complete || !response.content.includes("second")) {
      throw new Error("Git diff benchmark returned incomplete evidence");
    }
  }
  return latencySummary(values, "ms");
}

export async function runInsightsDeliveryTraceBenchmark({
  turnCount = 25_000,
  turnsPerSession = 100,
  queryCount = FORMAL_DELIVERY_TRACE_COUNT,
  warmupCount = FORMAL_DELIVERY_TRACE_WARMUP_COUNT,
  seed = FORMAL_DELIVERY_TRACE_SEED,
  binaryPath = process.env.THREADSHARE_INSIGHTS_ENGINE_PATH || DEFAULT_ENGINE_PATH,
  workingDirectory,
  reuseWorkingDirectory = false,
  onProgress = () => {},
} = {}) {
  if (turnCount !== 25_000 || turnsPerSession !== 100) {
    throw new RangeError("Delivery Trace formal benchmark requires the frozen 25k corpus");
  }
  positiveInteger(queryCount, "queryCount");
  positiveInteger(warmupCount, "warmupCount");
  const ownsDirectory = workingDirectory === undefined;
  const requestedDirectory = workingDirectory ??
    await mkdtemp(path.join(tmpdir(), "threadshare-delivery-trace-"));
  await mkdir(requestedDirectory, { recursive: true });
  const directory = await realpath(requestedDirectory);
  const databasePath = path.join(directory, "capacity.sqlite3");
  const cleanDatabasePath = path.join(directory, "clean.sqlite3");
  const hostLoadAtStart = hostLoad();
  try {
    let capacity;
    if (reuseWorkingDirectory) {
      onProgress("validating reusable frozen 25k capacity corpus");
      const counts = await productFreshnessFactCounts(databasePath);
      if (counts.sessions !== 250 || counts.turns !== 25_000 || counts.ftsDocuments !== 25_000) {
        throw new Error("reusable Delivery Trace workdir does not contain the frozen 25k corpus");
      }
      const { stdout } = await execFileAsync(binaryPath, ["--version", "--json"], {
        encoding: "utf8", maxBuffer: 1024 * 1024,
      });
      capacity = {
        rustSidecar: {
          engineIdentity: {
            ...JSON.parse(stdout),
            binarySha256: sha256(await readFile(binaryPath)),
          },
          rss: { sidecarPeakBytes: 0 },
        },
      };
    } else {
      onProgress("building frozen 25k capacity corpus");
      capacity = await runInsightsCapacityBenchmark({
        turnCount, turnsPerSession, queryCount: 5, warmupCount: 1, seed,
        binaryPath, workingDirectory: directory, mutationTrace: false,
      });
    }
    if (reuseWorkingDirectory) {
      onProgress("resetting prior Delivery Trace projection in reusable workdir");
      await resetDeliveryTraceBenchmarkState(databasePath);
    }
    onProgress("copying clean comparison database");
    await copySqliteSnapshot(databasePath, cleanDatabasePath);
    const plan = createCapacityBenchmarkPlan({ turnCount, turnsPerSession, seed });
    const corpus = deliveryTraceCorpus(plan);
    const split = Math.floor(corpus.commits.length / 2);
    const incrementalGeneration = await deliveryRepositoryGeneration(
      databasePath,
      corpus.repositoryId,
    );
    const cleanGeneration = await deliveryRepositoryGeneration(
      cleanDatabasePath,
      corpus.repositoryId,
    );
    const first = deliveryTraceDelta(corpus, {
      expectedGeneration: incrementalGeneration,
      targetGeneration: incrementalGeneration + 1,
      commits: corpus.commits.slice(0, split),
    });
    const second = deliveryTraceDelta(corpus, {
      expectedGeneration: incrementalGeneration + 1,
      targetGeneration: incrementalGeneration + 2,
      commits: corpus.commits.slice(split),
    });
    const clean = deliveryTraceDelta(corpus, {
      expectedGeneration: cleanGeneration,
      targetGeneration: cleanGeneration + 1,
      commits: corpus.commits,
    });
    let child;
    let stopRss = null;
    onProgress("applying incremental Delivery Trace generations");
    await applyDeliveryTrace(binaryPath, databasePath, [first, second], (spawned) => {
      child = spawned;
      stopRss = startRssSampler(spawned.pid);
    });
    const buildRss = stopRss === null ? null : await stopRss();
    onProgress("applying clean Delivery Trace generation");
    await applyDeliveryTrace(binaryPath, cleanDatabasePath, [clean]);
    onProgress("comparing incremental and clean graph state");
    const incremental = await deliveryGraphSummary(databasePath, corpus.repositoryId);
    const cleanSummary = await deliveryGraphSummary(cleanDatabasePath, corpus.repositoryId);
    const equivalent = incremental.digest === cleanSummary.digest;
    const evaluatedAt = new Date(BASE_TIME_MS + (turnCount + 172_800) * 1_000).toISOString();
    const initial = [];
    const expansion = [];
    const evidence = [];
    const responseDigest = createHash("sha256");
    let maxResponseBytes = 0;
    let queryStopRss = null;
    const client = await openDeliveryBenchmarkClient(binaryPath, databasePath, (spawned) => {
      queryStopRss = startRssSampler(spawned.pid);
    });
    try {
      onProgress("measuring trace, expansion, and evidence queries");
      const repositoryRoot = { kind: "repository", key: corpus.repositoryKey };
      const expansionRoots = [
        { kind: "intent", key: incremental.roots.intent },
        { kind: "session", key: incremental.roots.session },
        { kind: "git-commit", key: incremental.roots.commit },
      ];
      for (let index = 0; index < queryCount + warmupCount; index += 1) {
        let started = performance.now();
        const firstPage = await client.readInsightsDeliveryTrace(
          deliveryTraceRequest(repositoryRoot, evaluatedAt),
        );
        if (index >= warmupCount) initial.push(performance.now() - started);
        started = performance.now();
        const expanded = await client.readInsightsDeliveryTrace(deliveryTraceRequest(
          expansionRoots[index % expansionRoots.length], evaluatedAt,
          { includeCandidateEdges: true, includeContextualEdges: true },
        ));
        if (index >= warmupCount) expansion.push(performance.now() - started);
        started = performance.now();
        const evidencePage = await client.readInsightsEvidenceV2({
          format: "threadshare-insights-evidence-request@v2",
          target: {
            kind: "delivery-edge", relation: incremental.edge.relation,
            from: { kind: incremental.edge.from_kind, key: incremental.edge.from_key },
            to: { kind: incremental.edge.to_kind, key: incremental.edge.to_key },
            revision: incremental.edge.revision,
          },
          include: ["envelope"], cursor: null, maxBytes: 4096,
        });
        if (index >= warmupCount) evidence.push(performance.now() - started);
        for (const response of [firstPage, expanded, evidencePage]) {
          const rendered = canonicalJson(response);
          maxResponseBytes = Math.max(maxResponseBytes, Buffer.byteLength(rendered));
          if (index >= warmupCount) responseDigest.update(rendered);
        }
        if (firstPage.nodes.length < 2 || expanded.edges.length === 0 ||
            evidencePage.range.end <= evidencePage.range.start) {
          throw new Error(
            `Delivery Trace benchmark exercised an empty response path: ` +
            `initialNodes=${firstPage.nodes.length}, expansionEdges=${expanded.edges.length}, ` +
            `evidenceBytes=${evidencePage.range.end - evidencePage.range.start}`,
          );
        }
      }
    } finally {
      await client.close();
    }
    const queryRss = queryStopRss === null ? null : await queryStopRss();
    onProgress("measuring local Git diff evidence");
    const diff = await benchmarkGitDiff(directory, queryCount, warmupCount);
    const initialLatency = latencySummary(initial, "ms");
    const expansionLatency = latencySummary(expansion, "ms");
    const evidenceLatency = latencySummary(evidence, "ms");
    const sidecarPeakBytes = Math.max(
      capacity.rustSidecar.rss.sidecarPeakBytes,
      buildRss?.sidecarPeakBytes ?? 0,
      queryRss?.sidecarPeakBytes ?? 0,
    );
    const plans = Object.values(incremental.explain).flat();
    const indexedPlans = plans.length > 0 && plans.every((detail) => !/SCAN (?:delivery_trace_edges|git_commit_files|history_events)/u.test(detail));
    const countsComplete = incremental.counts.commits >= 5_000 &&
      incremental.counts.changedFiles >= 20_000 && incremental.counts.intents >= 100 &&
      incremental.counts.unresolvedRefs > 0 && incremental.counts.unreachableCommits > 0 &&
      incremental.counts.directEdges > 0 && incremental.counts.observedEdges > 0 &&
      incremental.counts.candidateEdges > 0 && incremental.counts.contextualEdges > 0;
    const gates = {
      corpusComplete: countsComplete,
      incrementalEqualsClean: equivalent,
      traceInitialWithinLimit: initialLatency.p95 < 200 && initialLatency.p99 < 500,
      traceExpansionWithinLimit: expansionLatency.p95 < 250 && expansionLatency.p99 < 500,
      evidenceFirstPageWithinLimit: evidenceLatency.p95 < 100,
      gitDiffFirstPageWithinLimit: diff.p95 < 500,
      engineRssWithin128MiB: sidecarPeakBytes > 0 && sidecarPeakBytes < 128 * 1024 * 1024,
      responseWithin4MiB: maxResponseBytes > 0 && maxResponseBytes < 4 * 1024 * 1024,
      indexedQueryPlans: indexedPlans,
    };
    return {
      format: DELIVERY_TRACE_BENCHMARK_FORMAT,
      measuredScope: "local-insights-delivery-trace-25k",
      sourceRevision: await sourceRevision(),
      sourceWorktreeDirty: await sourceWorktreeDirty(),
      benchmarkScriptSha256: sha256(await readFile(SCRIPT_PATH)),
      environment: sanitizedEnvironment(hostLoadAtStart),
      corpus: {
        seed, turns: turnCount, sessions: plan.sessionCount,
        commits: incremental.counts.commits, changedFiles: incremental.counts.changedFiles,
        intents: incremental.counts.intents,
      },
      coverage: incremental.counts,
      incrementalEquivalence: {
        incrementalDigest: incremental.digest,
        cleanDigest: cleanSummary.digest,
        equal: equivalent,
      },
      latency: {
        measuredRequestCount: queryCount, warmupRequestCount: warmupCount,
        traceInitial: initialLatency, traceExpansion: expansionLatency,
        evidenceFirstPage: evidenceLatency, gitDiffFirstPage: diff,
      },
      resources: { sidecarPeakBytes, maxResponseBytes },
      queryPlans: Object.fromEntries(Object.entries(incremental.explain).map(([name, details]) => [
        name, { detailDigest: sha256(canonicalJson(details)), indexed: details.every((detail) => !detail.startsWith("SCAN ")) },
      ])),
      resultDigest: responseDigest.digest("hex"),
      engineIdentity: capacity.rustSidecar.engineIdentity,
      gates: {
        ...gates,
        allMeasuredDeliveryTraceGatesPassed: Object.values(gates).every(Boolean),
      },
      notMeasured: [
        "250k Delivery Trace capacity is deferred to a later iteration",
        "network SCM availability and remote issue trackers are outside the local evidence boundary",
        "cross-repository and global filesystem discovery are intentionally unsupported",
      ],
    };
  } finally {
    if (ownsDirectory) await rm(directory, { recursive: true, force: true });
  }
}

export function parseBenchmarkArguments(argv) {
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
    deepQueryBenchmark: false,
    deliveryTraceBenchmark: false,
    formal: false,
    rawBackfill: false,
    sessionCount: 10_000,
    rawTextCharacters: 262_144,
    mutationTrace: true,
    databasePath: null,
    workingDirectory: undefined,
    reuseWorkingDirectory: false,
  };
  let explicitQueryCount = false;
  let explicitWarmupCount = false;
  let explicitSeed = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === "--json") options.json = true;
    else if (argument === "--formal") options.formal = true;
    else if (argument === "--capacity") options.capacity = true;
    else if (argument === "--query-benchmark") options.queryBenchmark = true;
    else if (argument === "--deep-query-benchmark") options.deepQueryBenchmark = true;
    else if (argument === "--delivery-trace-benchmark") options.deliveryTraceBenchmark = true;
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
    } else if (argument === "--queries") {
      options.queryCount = positiveInteger(argv[++index], "--queries");
      explicitQueryCount = true;
    } else if (argument === "--warmup") {
      options.warmupCount = positiveInteger(argv[++index], "--warmup");
      explicitWarmupCount = true;
    } else if (argument === "--seed") {
      options.seed = argv[++index];
      explicitSeed = true;
    }
    else if (argument === "--engine") options.binaryPath = argv[++index];
    else if (argument === "--output") options.outputPath = argv[++index];
    else if (argument === "--db") options.databasePath = argv[++index];
    else if (argument === "--workdir") options.workingDirectory = path.resolve(argv[++index]);
    else if (argument === "--reuse-workdir") options.reuseWorkingDirectory = true;
    else throw new Error(`unknown argument: ${argument}`);
  }
  if (options.deepQueryBenchmark) {
    if (!explicitQueryCount) options.queryCount = FORMAL_DEEP_QUERY_COUNT;
    if (!explicitWarmupCount) options.warmupCount = FORMAL_DEEP_QUERY_WARMUP_COUNT;
    if (!explicitSeed) {
      options.seed = FORMAL_DEEP_QUERY_SEEDS[options.turnCount] ?? `${DEFAULT_SEED}-deep-query`;
    }
  }
  if (options.deliveryTraceBenchmark) {
    if (!explicitQueryCount) options.queryCount = FORMAL_DELIVERY_TRACE_COUNT;
    if (!explicitWarmupCount) options.warmupCount = FORMAL_DELIVERY_TRACE_WARMUP_COUNT;
    if (!explicitSeed) options.seed = FORMAL_DELIVERY_TRACE_SEED;
  }
  return options;
}

async function main() {
  const options = parseBenchmarkArguments(process.argv.slice(2));
  if (options.deliveryTraceBenchmark) {
    options.onProgress = (message) => process.stderr.write(`delivery-trace: ${message}\n`);
  }
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
    : options.deliveryTraceBenchmark
      ? await runInsightsDeliveryTraceBenchmark(options)
    : options.deepQueryBenchmark
      ? await runInsightsDeepQueryBenchmark(options)
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
  if (
    options.deepQueryBenchmark && options.formal &&
    !result.gates.allMeasuredDeepQueryEvidenceGatesPassed
  ) {
    throw new Error("Deep Query v2 benchmark gates failed");
  }
  if (
    options.deliveryTraceBenchmark && options.formal &&
    !result.gates.allMeasuredDeliveryTraceGatesPassed
  ) {
    throw new Error("Delivery Trace benchmark gates failed");
  }
}

if (process.argv[1] && path.resolve(process.argv[1]) === SCRIPT_PATH) {
  main().catch((error) => {
    process.stderr.write(`benchmark-insights-engine: ${error.message}\n`);
    process.exitCode = 1;
  });
}
