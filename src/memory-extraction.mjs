// Team-memory extraction pipeline orchestration (proposal §6.1–§6.4, D4/D5; design §1/§4/§9).
//
// This module is deterministic and pure-function first. It never queries insights
// directly: callers inject a `sources` interface (listCandidateSessions / readTurns /
// readToolPayloadExcerpt / deliveryEdges) so tests can use in-memory fakes and future
// wiring can pass real insights adapters.
//
// Responsibilities:
//   - chunking of whole consecutive Turns under a byte budget with lossless
//     user/assistant text and declared tool-payload excerpting (§6.2, design §4);
//   - deterministic `<<past-*>>` transcript serialization (role-capture defense);
//   - opaque evidence catalogs whose strength derivation data stays host-side (D5);
//   - ExtractionTask@v1 / AdjudicationTask@v1 assembly with binding digests (D4);
//   - deterministic EvidenceAssessment@v1 derivation (claimSupport always
//     "unverified"; typed-fact text may only come from the allowlist renderer here).

import { createHash } from "node:crypto";

import { canonicalJson } from "./canonical-json.mjs";
import {
  MEMORY_ADJUDICATION_RESULT_FORMAT,
  MEMORY_ADJUDICATION_TASK_FORMAT,
  MEMORY_CANDIDATE_DRAFT_BATCH_FORMAT,
  MEMORY_EVIDENCE_ASSESSMENT_FORMAT,
  MEMORY_EXTRACTION_TASK_FORMAT,
  adjudicationTaskSchema,
  evidenceAssessmentSchema,
  extractionTaskSchema,
  memoryDigestHex,
} from "./memory-contracts.mjs";
import {
  ADJUDICATION_PROMPT,
  EXTRACTION_PROMPT,
  PROMPT_VERSION,
  TRANSCRIPT_PREAMBLE,
} from "./memory-prompts.mjs";

export const CHUNKER_VERSION = "memory-chunker@1";
export const DEFAULT_CHUNK_BUDGET_BYTES = 40960;
export const TOOL_PAYLOAD_EXCERPT_BYTES = 1024;

const TRANSCRIPT_ROLES = Object.freeze(["user", "assistant", "tool_call", "tool_result"]);
const TOOL_ROLES = new Set(["tool_call", "tool_result"]);
const END_OF_TRANSCRIPT = "<<end-of-transcript>>";

const EVIDENCE_KINDS = Object.freeze(["commit", "turn", "path"]);
const STRENGTH_RANK = Object.freeze({ direct: 0, observed: 1, candidate: 2, contextual: 3 });

export class MemoryExtractionError extends Error {
  constructor(message, code, meta = {}) {
    super(message);
    this.name = "MemoryExtractionError";
    this.code = code;
    Object.assign(this, meta);
  }
}

function sha256Hex(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

function byteLength(text) {
  return Buffer.byteLength(text, "utf8");
}

// ---------------------------------------------------------------------------
// §6.2 chunking (design §4)
// ---------------------------------------------------------------------------

function excerptMarker(totalBytes, payloadSha256) {
  return `[[tool payload truncated by ${CHUNKER_VERSION}: total ${totalBytes} bytes, `
    + `sha256=${payloadSha256}; head/tail ${TOOL_PAYLOAD_EXCERPT_BYTES}-byte excerpts]]`;
}

function buildExcerptText(head, tail, totalBytes, payloadSha256) {
  return `${head}\n${excerptMarker(totalBytes, payloadSha256)}\n${tail}`;
}

function excerptInlinePayload(text, providedSha256) {
  const buffer = Buffer.from(text, "utf8");
  const head = buffer.subarray(0, TOOL_PAYLOAD_EXCERPT_BYTES).toString("utf8");
  const tail = buffer
    .subarray(Math.max(buffer.length - TOOL_PAYLOAD_EXCERPT_BYTES, 0))
    .toString("utf8");
  const payloadSha256 = providedSha256 ?? sha256Hex(buffer);
  return {
    text: buildExcerptText(head, tail, buffer.length, payloadSha256),
    payloadSha256,
    payloadBytes: buffer.length,
  };
}

function eventBlockBytes(event) {
  // `<<past-role>>\n` + text + `\n\n` separator; matches serializeTranscript shape.
  return byteLength(`<<past-${event.role}>>\n${event.text}\n\n`);
}

function normalizeEvent(rawEvent, turnIndex, eventIndex) {
  if (!rawEvent || typeof rawEvent !== "object") {
    throw new MemoryExtractionError(
      `turn ${turnIndex} event ${eventIndex} must be an object`, "invalid-event");
  }
  if (!TRANSCRIPT_ROLES.includes(rawEvent.role)) {
    throw new MemoryExtractionError(
      `turn ${turnIndex} event ${eventIndex} has unsupported role ${String(rawEvent.role)}`,
      "invalid-event-role");
  }
  if (typeof rawEvent.text !== "string") {
    throw new MemoryExtractionError(
      `turn ${turnIndex} event ${eventIndex} requires materialized text`, "invalid-event-text");
  }
  const event = { turnIndex, role: rawEvent.role, text: rawEvent.text };
  if (rawEvent.truncated === true) {
    event.truncated = true;
    if (typeof rawEvent.payloadSha256 !== "string") {
      throw new MemoryExtractionError(
        `turn ${turnIndex} event ${eventIndex} is truncated but lacks payloadSha256`,
        "invalid-event-truncation");
    }
    event.payloadSha256 = rawEvent.payloadSha256;
    event.payloadBytes = rawEvent.payloadBytes ?? byteLength(rawEvent.text);
  } else if (typeof rawEvent.payloadSha256 === "string") {
    event.payloadSha256 = rawEvent.payloadSha256;
  }
  return event;
}

function prepareTurn(rawTurn, arrayIndex, budgetBytes) {
  if (!rawTurn || typeof rawTurn !== "object" || !Array.isArray(rawTurn.events)) {
    throw new MemoryExtractionError(`turn at index ${arrayIndex} must have events`, "invalid-turn");
  }
  const turnIndex = Number.isInteger(rawTurn.turnIndex) ? rawTurn.turnIndex : arrayIndex;
  const events = rawTurn.events.map((event, i) => normalizeEvent(event, turnIndex, i));
  let bytes = events.reduce((sum, event) => sum + eventBlockBytes(event), 0);

  // A single over-budget Turn: user/assistant text is never compressed; oversized
  // tool payloads become head/tail excerpts with a payloadSha256 pointer, largest
  // first, each declared truncated in coverage (§6.2 "有损必申报").
  if (bytes > budgetBytes) {
    const excerptable = events
      .map((event, position) => ({ event, position, size: byteLength(event.text) }))
      .filter(({ event, size }) =>
        TOOL_ROLES.has(event.role)
        && event.truncated !== true
        && size > TOOL_PAYLOAD_EXCERPT_BYTES * 2)
      .sort((left, right) => right.size - left.size || left.position - right.position);
    for (const { event } of excerptable) {
      if (bytes <= budgetBytes) break;
      const before = eventBlockBytes(event);
      const excerpt = excerptInlinePayload(event.text, event.payloadSha256);
      event.text = excerpt.text;
      event.truncated = true;
      event.payloadSha256 = excerpt.payloadSha256;
      event.payloadBytes = excerpt.payloadBytes;
      bytes += eventBlockBytes(event) - before;
    }
  }
  return {
    turnIndex,
    turnRevision: typeof rawTurn.turnRevision === "string" ? rawTurn.turnRevision : null,
    events,
    bytes,
  };
}

function finalizeChunk(turns) {
  const events = [];
  const coverage = [];
  const turnRevisions = [];
  for (const turn of turns) {
    let truncatedInTurn = false;
    for (const event of turn.events) {
      const chunkEvent = { turnIndex: event.turnIndex, role: event.role, text: event.text };
      if (event.truncated === true) {
        truncatedInTurn = true;
        chunkEvent.truncated = true;
        chunkEvent.payloadSha256 = event.payloadSha256;
        chunkEvent.payloadBytes = event.payloadBytes;
      } else if (typeof event.payloadSha256 === "string") {
        chunkEvent.payloadSha256 = event.payloadSha256;
      }
      events.push(chunkEvent);
    }
    coverage.push({
      sourceKind: "turn",
      ref: `turn:${turn.turnIndex}`,
      completeness: truncatedInTurn ? "truncated" : "full",
      bytes: turn.bytes,
    });
    if (turn.turnRevision !== null) turnRevisions.push(turn.turnRevision);
  }
  for (const turn of turns) {
    for (const event of turn.events) {
      if (event.truncated === true) {
        coverage.push({
          sourceKind: "tool-payload",
          ref: `payload:${event.payloadSha256}`,
          completeness: "truncated",
          bytes: event.payloadBytes,
        });
      }
    }
  }
  const turnRange = { start: turns[0].turnIndex, end: turns[turns.length - 1].turnIndex };
  const chunk = { turnRange, coverage, events, turnRevisions };
  chunk.chunkDigest = computeChunkDigest(chunk);
  return chunk;
}

/**
 * Greedy fill of whole consecutive Turns under `budgetBytes` (default 40960).
 * A Turn is never split; an over-budget Turn is excerpted (tool payloads only)
 * and, if still over budget, occupies its own chunk. Returns
 * `[{ turnRange, coverage, events, turnRevisions, chunkDigest }]`.
 */
export function chunkSession({ turns, budgetBytes = DEFAULT_CHUNK_BUDGET_BYTES }) {
  if (!Array.isArray(turns) || turns.length === 0) {
    throw new MemoryExtractionError("turns must be a non-empty array", "invalid-turns");
  }
  if (!Number.isInteger(budgetBytes) || budgetBytes <= 0) {
    throw new MemoryExtractionError("budgetBytes must be a positive integer", "invalid-budget");
  }
  const prepared = turns.map((turn, index) => prepareTurn(turn, index, budgetBytes));
  const chunks = [];
  let current = [];
  let currentBytes = 0;
  for (const turn of prepared) {
    if (current.length > 0 && currentBytes + turn.bytes > budgetBytes) {
      chunks.push(finalizeChunk(current));
      current = [];
      currentBytes = 0;
    }
    current.push(turn);
    currentBytes += turn.bytes;
  }
  if (current.length > 0) chunks.push(finalizeChunk(current));
  return chunks;
}

/** Canonical digest over the chunk's content identity (versioned). */
export function computeChunkDigest({ turnRange, coverage, events }) {
  return memoryDigestHex({ chunkerVersion: CHUNKER_VERSION, turnRange, coverage, events });
}

/** Sorted unique payloadSha256 digests referenced by the chunk's events. */
export function collectPayloadDigests(chunk) {
  const digests = new Set();
  for (const event of chunk.events) {
    if (typeof event.payloadSha256 === "string") digests.add(event.payloadSha256);
  }
  return [...digests].sort();
}

// ---------------------------------------------------------------------------
// Transcript serialization (§6.2 role-capture defense; design §4)
// ---------------------------------------------------------------------------

/**
 * Deterministic transcript: TRANSCRIPT_PREAMBLE, one `<<past-role>>` block per
 * event in stable order, closed by the `<<end-of-transcript>>` anchor.
 */
export function serializeTranscript(chunk) {
  if (!chunk || !Array.isArray(chunk.events) || chunk.events.length === 0) {
    throw new MemoryExtractionError("chunk must contain events", "invalid-chunk");
  }
  const blocks = chunk.events.map((event) => {
    if (!TRANSCRIPT_ROLES.includes(event.role)) {
      throw new MemoryExtractionError(
        `unsupported transcript role ${String(event.role)}`, "invalid-event-role");
    }
    return `<<past-${event.role}>>\n${event.text}`;
  });
  return `${TRANSCRIPT_PREAMBLE}\n\n${blocks.join("\n\n")}\n\n${END_OF_TRANSCRIPT}`;
}

// ---------------------------------------------------------------------------
// Evidence catalog (D5: strength derivation data never enters the task package)
// ---------------------------------------------------------------------------

function evidencePointer(kind, edge, turnIndex) {
  if (kind === "commit") {
    const pointer = { kind: "commit", commitHash: edge.pointer.commitHash };
    if (typeof edge.pointer.repository === "string") pointer.repository = edge.pointer.repository;
    return pointer;
  }
  if (kind === "path") return { kind: "path", path: edge.pointer.path };
  return { kind: "turn", turnIndex };
}

function defaultDisplay(pointer) {
  if (pointer.kind === "commit") {
    return pointer.repository
      ? `commit ${pointer.commitHash} @ ${pointer.repository}`
      : `commit ${pointer.commitHash}`;
  }
  if (pointer.kind === "path") return `path ${pointer.path}`;
  return `turn ${pointer.turnIndex}`;
}

/**
 * Build the opaque evidence catalog for one chunk from injected delivery edges
 * plus the chunk's own turns. The returned `catalog` entries carry only
 * `{ evidenceId, kind, pointerDigest, display }` (the ExtractionTask shape);
 * relation/strength/limitations derivation data stays in `internalIndex`,
 * which must never be serialized into a task package.
 */
export function buildEvidenceCatalog({ deliveryEdges = [], chunk }) {
  const byPointer = new Map();
  const deliveryEdgeRevisions = new Set();

  const merge = (pointer, relation, strength, limitations, display, revision) => {
    if (!EVIDENCE_KINDS.includes(pointer.kind)) {
      throw new MemoryExtractionError(
        `unsupported evidence kind ${String(pointer.kind)}`, "invalid-evidence-kind");
    }
    if (!(strength in STRENGTH_RANK)) {
      throw new MemoryExtractionError(
        `unsupported evidence strength ${String(strength)}`, "invalid-evidence-strength");
    }
    const pointerDigest = memoryDigestHex(pointer);
    if (typeof revision === "string") deliveryEdgeRevisions.add(revision);
    const existing = byPointer.get(pointerDigest);
    if (!existing) {
      byPointer.set(pointerDigest, {
        kind: pointer.kind,
        pointer,
        pointerDigest,
        display: display ?? defaultDisplay(pointer),
        relation,
        strength,
        relations: [relation],
        limitations: [...new Set(limitations)].sort(),
      });
      return;
    }
    if (STRENGTH_RANK[strength] < STRENGTH_RANK[existing.strength]) {
      existing.strength = strength;
      existing.relation = relation;
    }
    if (!existing.relations.includes(relation)) existing.relations.push(relation);
    existing.limitations = [...new Set([...existing.limitations, ...limitations])].sort();
  };

  for (const edge of deliveryEdges) {
    if (!edge || typeof edge !== "object" || !edge.pointer) {
      throw new MemoryExtractionError("delivery edge requires a pointer", "invalid-delivery-edge");
    }
    merge(
      evidencePointer(edge.kind, edge, edge.pointer.turnIndex),
      edge.relation,
      edge.strength,
      Array.isArray(edge.limitations) ? edge.limitations : [],
      typeof edge.display === "string" ? edge.display : null,
      edge.revision,
    );
  }
  const seenTurns = new Set();
  for (const event of chunk.events) {
    if (seenTurns.has(event.turnIndex)) continue;
    seenTurns.add(event.turnIndex);
    // Recorded session-contains-turn relation: the chunk turn itself is a direct
    // observation of session content (Delivery Trace recorded relation).
    merge(
      { kind: "turn", turnIndex: event.turnIndex },
      "session-contains-turn",
      "direct",
      ["source-local-only"],
      null,
      undefined,
    );
  }

  const kindOrder = { commit: 0, turn: 1, path: 2 };
  const ordered = [...byPointer.values()].sort((left, right) =>
    kindOrder[left.kind] - kindOrder[right.kind]
    || (left.pointerDigest < right.pointerDigest ? -1 : 1));

  const catalog = [];
  const internalIndex = {};
  ordered.forEach((entry, index) => {
    const evidenceId = `ev-${index + 1}-${entry.pointerDigest.slice(0, 12)}`;
    catalog.push({
      evidenceId,
      kind: entry.kind,
      pointerDigest: entry.pointerDigest,
      display: entry.display,
    });
    internalIndex[evidenceId] = {
      evidenceId,
      kind: entry.kind,
      pointer: entry.pointer,
      pointerDigest: entry.pointerDigest,
      relation: entry.relation,
      relations: entry.relations,
      strength: entry.strength,
      limitations: entry.limitations,
    };
  });
  return { catalog, internalIndex, deliveryEdgeRevisions: [...deliveryEdgeRevisions].sort() };
}

// ---------------------------------------------------------------------------
// ExtractionTask@v1 assembly (D4 binding; design §9)
// ---------------------------------------------------------------------------

/**
 * Canonical digest over every input that participates in transcript assembly.
 * Sensitive to any transcript byte change; deliberately excludes taskId, lease,
 * and provenance (snapshotSeq/evaluatedAt are assembly provenance only, D4).
 */
export function computeSourceInputDigest({
  chunk,
  evidenceCatalog,
  session,
  context,
  selection,
  turnRevisions,
  payloadDigests,
  deliveryEdgeRevisions,
  promptVersion,
  schemaVersion,
  chunkerVersion,
}) {
  return memoryDigestHex({
    chunk,
    evidenceCatalog,
    session,
    context,
    selection,
    turnRevisions,
    payloadDigests,
    deliveryEdgeRevisions,
    promptVersion,
    schemaVersion,
    chunkerVersion,
  });
}

/**
 * Assemble a schema-valid ExtractionTask@v1 plus its canonical stdin bytes
 * (the exact Runner stdin). The transcript is serialized here from the chunk;
 * `stdinBytes` is the canonical JSON of the validated task.
 */
export function buildExtractionTask({
  taskId,
  lease,
  databaseUuid,
  owner,
  session,
  chunk,
  evidenceCatalog,
  selection,
  sceneIndexSummary = null,
  turnRevisions,
  payloadDigests,
  deliveryEdgeRevisions = [],
  snapshotSeq,
  evaluatedAt,
  promptVersion = PROMPT_VERSION,
  schemaVersion = MEMORY_CANDIDATE_DRAFT_BATCH_FORMAT,
  chunkerVersion = CHUNKER_VERSION,
}) {
  const transcript = serializeTranscript(chunk);
  const taskChunk = {
    turnRange: chunk.turnRange,
    coverage: chunk.coverage,
    transcript,
  };
  const context = { sceneIndexSummary };
  const resolvedTurnRevisions = turnRevisions ?? chunk.turnRevisions ?? [];
  const resolvedPayloadDigests = payloadDigests ?? collectPayloadDigests(chunk);
  const sourceInputDigest = computeSourceInputDigest({
    chunk: taskChunk,
    evidenceCatalog,
    session,
    context,
    selection,
    turnRevisions: resolvedTurnRevisions,
    payloadDigests: resolvedPayloadDigests,
    deliveryEdgeRevisions,
    promptVersion,
    schemaVersion,
    chunkerVersion,
  });
  const task = extractionTaskSchema.parse({
    format: MEMORY_EXTRACTION_TASK_FORMAT,
    taskId,
    lease,
    binding: {
      databaseUuid,
      owner,
      sourceInputDigest,
      selection,
      turnRevisions: resolvedTurnRevisions,
      payloadDigests: resolvedPayloadDigests,
      deliveryEdgeRevisions,
      promptVersion,
      schemaVersion,
      chunkerVersion,
      provenance: { snapshotSeq, evaluatedAt },
    },
    session,
    evidenceCatalog,
    chunk: taskChunk,
    context,
    contract: {
      draftSchema: MEMORY_CANDIDATE_DRAFT_BATCH_FORMAT,
      prompts: { promptVersion, extraction: EXTRACTION_PROMPT },
    },
  });
  return { task, stdinBytes: canonicalJson(task) };
}

// ---------------------------------------------------------------------------
// EvidenceAssessment@v1 derivation (D5)
// ---------------------------------------------------------------------------

/** sha256 of the statement text's exact UTF-8 bytes. */
export function computeStatementTextDigest(text) {
  return sha256Hex(Buffer.from(text, "utf8"));
}

/** Canonical digest over a sorted citations array (human-confirmation binding). */
export function computeCitationsDigest(citations) {
  return memoryDigestHex(citations);
}

function lookupInternal(internalIndex, evidenceId) {
  if (internalIndex instanceof Map) return internalIndex.get(evidenceId);
  return Object.hasOwn(internalIndex, evidenceId) ? internalIndex[evidenceId] : undefined;
}

/**
 * Deterministically derive EvidenceAssessment@v1 rows from a runner draft batch.
 *
 * D5 rules: every cited evidenceId must belong to the current task's internal
 * index (out-of-task/fabricated ids reject the whole candidate with a code);
 * provenanceStrength is the strongest cited relation strength
 * (direct > observed > candidate > contextual), limitations are the union,
 * no citations means "unknown"; claimSupport is always "unverified" here.
 *
 * Returns { assessments, rejected, confirmationBindings } where
 * confirmationBindings carries the statementTextDigest + citationsDigest pair a
 * later human confirmation must bind to.
 */
export function deriveEvidenceAssessments({ draftBatch, internalIndex, candidateIds = null }) {
  const candidates = draftBatch?.candidates;
  if (!Array.isArray(candidates)) {
    throw new MemoryExtractionError("draftBatch.candidates must be an array", "invalid-draft-batch");
  }
  const assessments = [];
  const rejected = [];
  const confirmationBindings = [];
  candidates.forEach((candidate, index) => {
    const candidateId = candidateIds?.[index]
      ?? `cand-${index + 1}-${memoryDigestHex(candidate).slice(0, 12)}`;
    const statements = Array.isArray(candidate.statements) ? candidate.statements : [];
    const seenStatementIds = new Set();
    let rejection = null;
    for (const statement of statements) {
      if (seenStatementIds.has(statement.statementId)) {
        rejection = { candidateId, statementId: statement.statementId, code: "duplicate-statement-id" };
        break;
      }
      seenStatementIds.add(statement.statementId);
      for (const evidenceId of statement.evidenceIds ?? []) {
        if (!lookupInternal(internalIndex, evidenceId)) {
          rejection = {
            candidateId,
            statementId: statement.statementId,
            evidenceId,
            code: "unknown-evidence-id",
          };
          break;
        }
      }
      if (rejection) break;
    }
    if (rejection) {
      rejected.push(rejection);
      return;
    }
    for (const statement of statements) {
      const uniqueIds = [...new Set(statement.evidenceIds ?? [])].sort();
      const cited = uniqueIds.map((evidenceId) => lookupInternal(internalIndex, evidenceId));
      const citations = uniqueIds.map((evidenceId, i) => ({
        evidenceId,
        pointerDigest: cited[i].pointerDigest,
      }));
      let provenanceStrength = "unknown";
      const limitations = new Set();
      for (const entry of cited) {
        if (provenanceStrength === "unknown"
          || STRENGTH_RANK[entry.strength] < STRENGTH_RANK[provenanceStrength]) {
          provenanceStrength = entry.strength;
        }
        for (const limitation of entry.limitations) limitations.add(limitation);
      }
      const statementTextDigest = computeStatementTextDigest(statement.text);
      const assessment = evidenceAssessmentSchema.parse({
        format: MEMORY_EVIDENCE_ASSESSMENT_FORMAT,
        candidateId,
        statementId: statement.statementId,
        citations,
        provenanceStrength,
        limitations: [...limitations].sort(),
        claimSupport: "unverified",
        assessedBy: "deterministic",
        statementTextDigest,
        revision: 1,
      });
      assessments.push(assessment);
      confirmationBindings.push({
        candidateId,
        statementId: statement.statementId,
        statementTextDigest,
        citationsDigest: computeCitationsDigest(citations),
      });
    }
  });
  return { assessments, rejected, confirmationBindings };
}

// ---------------------------------------------------------------------------
// Typed-fact renderers (D5 allowlist; Phase 1: two fixed templates)
// ---------------------------------------------------------------------------

/**
 * Versioned allowlist. Only statement text produced by renderTypedFact for one
 * of these kinds may be marked claimSupport "typed-fact" by upper layers.
 */
export const TYPED_FACT_ALLOWLIST = Object.freeze({
  "commit-changed-path@1": Object.freeze({
    kind: "commit-changed-path@1",
    version: 1,
    params: Object.freeze(["commitHash", "path"]),
  }),
  "command-exit@1": Object.freeze({
    kind: "command-exit@1",
    version: 1,
    params: Object.freeze(["command", "exitCode"]),
  }),
});

function assertSingleLine(value, name, kind) {
  if (typeof value !== "string" || value.length === 0 || /[\r\n]/.test(value)) {
    throw new MemoryExtractionError(
      `${name} must be a non-empty single-line string for ${kind}`, "typed-fact-invalid-params");
  }
}

/** Render one allowlisted typed-fact statement text; rejects unknown kinds. */
export function renderTypedFact(kind, params = {}) {
  if (!Object.hasOwn(TYPED_FACT_ALLOWLIST, kind)) {
    throw new MemoryExtractionError(
      `typed-fact kind ${String(kind)} is not allowlisted`, "typed-fact-kind-not-allowlisted");
  }
  if (kind === "commit-changed-path@1") {
    const { commitHash, path } = params;
    if (typeof commitHash !== "string" || !/^[0-9a-f]{40}$/.test(commitHash)) {
      throw new MemoryExtractionError(
        "commitHash must be a lowercase 40-hex git hash", "typed-fact-invalid-params");
    }
    assertSingleLine(path, "path", kind);
    return { kind, text: `Commit ${commitHash} changed ${path}.` };
  }
  const { command, exitCode } = params;
  assertSingleLine(command, "command", kind);
  if (command.includes("`")) {
    throw new MemoryExtractionError(
      "command must not contain backticks", "typed-fact-invalid-params");
  }
  if (!Number.isInteger(exitCode) || exitCode < 0) {
    throw new MemoryExtractionError(
      "exitCode must be a non-negative integer", "typed-fact-invalid-params");
  }
  return { kind, text: `Command \`${command}\` exited with code ${exitCode}.` };
}

// ---------------------------------------------------------------------------
// AdjudicationTask@v1 assembly (§6.4; design §9)
// ---------------------------------------------------------------------------

/** Canonical digest over the draft batch handed to adjudication. */
export function computeDraftBatchDigest(drafts) {
  return memoryDigestHex({ candidates: drafts });
}

/** Canonical digest over the recall query set (algorithm version + per-draft query). */
export function computeRecallQueryDigest({ recallAlgorithmVersion, queries }) {
  return memoryDigestHex({ recallAlgorithmVersion, queries });
}

/**
 * Result-set digest per D4: covers each draft's ordered recall set joined with
 * the pool item's revision/contentDigest/state, so rank changes, new entries,
 * and pool item drift are all visible. Throws if a recall ref has no pool item.
 */
export function computeResultSetDigest({ recallSets, pool }) {
  const poolByKey = new Map();
  for (const item of pool) poolByKey.set(`${item.sourceKind}:${item.id}`, item);
  const resultSet = recallSets.map((set) => ({
    draftRef: set.draftRef,
    ordered: set.ordered.map((entry) => {
      const item = poolByKey.get(`${entry.sourceKind}:${entry.id}`);
      if (!item) {
        throw new MemoryExtractionError(
          `recall set for ${set.draftRef} references missing pool item `
            + `${entry.sourceKind}:${entry.id}`,
          "recall-pool-mismatch");
      }
      return {
        rank: entry.rank,
        sourceKind: entry.sourceKind,
        id: entry.id,
        revision: item.revision,
        contentDigest: item.contentDigest,
        state: item.state,
      };
    }),
  }));
  return memoryDigestHex({ resultSet });
}

/**
 * Assemble a schema-valid AdjudicationTask@v1 plus its canonical stdin bytes.
 * `recall` carries the recallSets/pool plus both projection provenances; the
 * binding digests (draftBatchDigest / recallQueryDigest / resultSetDigest /
 * poolItemRevisions) are computed here unless explicitly provided.
 */
export function buildAdjudicationTask({
  taskId,
  lease,
  databaseUuid,
  memoryStateUuid,
  owner,
  drafts,
  recall,
  draftBatchDigest = null,
  recallQueryDigest = null,
  resultSetDigest = null,
  promptVersion = PROMPT_VERSION,
  schemaVersion = MEMORY_ADJUDICATION_RESULT_FORMAT,
}) {
  if (!recall || !Array.isArray(recall.recallSets) || !Array.isArray(recall.pool)) {
    throw new MemoryExtractionError(
      "recall must provide recallSets and pool arrays", "invalid-recall");
  }
  const poolItemRevisions = [...recall.pool]
    .map((item) => ({ sourceKind: item.sourceKind, id: item.id, revision: item.revision }))
    .sort((left, right) =>
      (left.sourceKind < right.sourceKind ? -1 : left.sourceKind > right.sourceKind ? 1 : 0)
      || (left.id < right.id ? -1 : left.id > right.id ? 1 : 0));
  const task = adjudicationTaskSchema.parse({
    format: MEMORY_ADJUDICATION_TASK_FORMAT,
    taskId,
    lease,
    binding: {
      databaseUuid,
      memoryStateUuid,
      owner,
      draftBatchDigest: draftBatchDigest ?? computeDraftBatchDigest(drafts),
      approvedProjection: {
        generation: recall.approvedProjection.generation,
        analyzerVersion: recall.approvedProjection.analyzerVersion,
      },
      candidateProjection: {
        generation: recall.candidateProjection.generation,
        analyzerVersion: recall.candidateProjection.analyzerVersion,
      },
      recallAlgorithmVersion: recall.recallAlgorithmVersion,
      recallQueryDigest: recallQueryDigest ?? computeRecallQueryDigest({
        recallAlgorithmVersion: recall.recallAlgorithmVersion,
        queries: drafts.map((draft) => ({ draftRef: draft.candidateId, query: draft.content })),
      }),
      resultSetDigest: resultSetDigest ?? computeResultSetDigest({
        recallSets: recall.recallSets,
        pool: recall.pool,
      }),
      poolItemRevisions,
      promptVersion,
      schemaVersion,
    },
    drafts,
    recallSets: recall.recallSets,
    pool: recall.pool,
    contract: {
      resultSchema: MEMORY_ADJUDICATION_RESULT_FORMAT,
      prompts: { promptVersion, adjudication: ADJUDICATION_PROMPT },
    },
  });
  return { task, stdinBytes: canonicalJson(task) };
}

// ---------------------------------------------------------------------------
// Injected-sources orchestration (design §1: no direct insights access here)
// ---------------------------------------------------------------------------

/**
 * Materialize turns for chunking. Events that carry only a payloadRef (payload
 * stored out of line) are resolved through sources.readToolPayloadExcerpt into
 * a pre-truncated head/tail excerpt with a payloadSha256 pointer.
 */
export async function loadSessionTurns({ sources, sessionKey, range = null }) {
  const turns = await sources.readTurns(sessionKey, range);
  const materialized = [];
  for (const turn of turns) {
    const events = [];
    for (const event of turn.events) {
      if (typeof event.text === "string" || event.payloadRef === undefined) {
        events.push(event);
        continue;
      }
      const excerpt = await sources.readToolPayloadExcerpt(event.payloadRef);
      events.push({
        role: event.role,
        text: buildExcerptText(
          excerpt.head, excerpt.tail, excerpt.totalBytes, excerpt.payloadSha256),
        truncated: true,
        payloadSha256: excerpt.payloadSha256,
        payloadBytes: excerpt.totalBytes,
      });
    }
    materialized.push({ ...turn, events });
  }
  return materialized;
}

/**
 * Load a session through the injected sources, chunk it, and pair every chunk
 * with its evidence catalog (catalog + host-side internalIndex + edge revisions).
 */
export async function planSessionChunks({
  sources,
  sessionKey,
  range = null,
  budgetBytes = DEFAULT_CHUNK_BUDGET_BYTES,
}) {
  const turns = await loadSessionTurns({ sources, sessionKey, range });
  const deliveryEdges = await sources.deliveryEdges(sessionKey);
  return chunkSession({ turns, budgetBytes }).map((chunk) => ({
    chunk,
    evidence: buildEvidenceCatalog({ deliveryEdges, chunk }),
  }));
}
