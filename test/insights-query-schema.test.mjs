import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const FORMATS = Object.freeze([
  "threadshare-insights-overview@v1",
  "threadshare-insights-search-request@v1",
  "threadshare-insights-search@v1",
  "threadshare-insights-capabilities@v1",
  "threadshare-insights-usage-request@v1",
  "threadshare-insights-usage@v1",
  "threadshare-insights-activity-request@v1",
  "threadshare-insights-activity@v1",
  "threadshare-insights-evidence@v1",
]);

function schemaFilename(format) {
  return `${format.replace("@v1", ".v1")}.schema.json`;
}

async function compiledSchemas() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const result = new Map();
  for (const format of FORMATS) {
    const filename = schemaFilename(format);
    const document = JSON.parse(await readFile(new URL(`../schema/${filename}`, import.meta.url)));
    assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(document.$id, `https://threadshare.team-harness.com/schema/${filename}`);
    assert.equal(document.type, "object");
    assert.equal(document.additionalProperties, false);
    assert.deepEqual(document.properties.format, { const: format });
    assert.equal(document.required.includes("format"), true);
    result.set(format, ajv.compile(document));
  }
  return result;
}

test("ships nine strict Agent Insights JSON schemas", async () => {
  assert.equal((await compiledSchemas()).size, 9);
});

test("usage and activity schemas lock the non-causal aggregate axes", async () => {
  const schemas = await compiledSchemas();
  const snapshot = { seq: "1", token: "a".repeat(64) };
  const coverage = {
    excludedUndatedInvocationCount: "0",
    excludedUndatedTurnCount: "0",
    excludedUnrevisionedInvocationCount: "0",
    excludedUnrevisionedTurnCount: "0",
    categoriesMayOverlap: true,
  };
  const usage = {
    format: "threadshare-insights-usage@v1",
    snapshot,
    sourceFreshness: "not-evaluated",
    kind: "tool",
    orderBy: "recorded-invocation-count",
    window: {
      observedAtOrAfter: "2026-08-10T00:00:00.000Z",
      observedBefore: "2026-08-11T00:00:00.000Z",
    },
    comparisonWindow: null,
    closureEvaluatedAt: "2026-08-11T01:00:00.000Z",
    quiescenceSeconds: 300,
    items: [{
      capabilityKey: "b".repeat(64),
      provider: "codex",
      kind: "tool",
      canonicalName: "Read",
      recordedInvocationCount: "3",
      recordedFailingInvocationCount: "1",
      distinctTurnCount: "2",
      distinctSessionCount: "2",
      lastUsedAt: "2026-08-10T01:00:00.000Z",
      invocationTerminalCounts: {
        invocationTotal: "3", pending: "0", completed: "2", failed: "1",
        cancelled: "0", unknown: "0",
      },
      containingTurnOutcomeCounts: {
        distinctTurnTotal: "2", providerCompleted: "1", abandoned: "0", unknown: "1",
      },
      groupedInvocationCount: "2",
      ungroupedInvocationCount: "1",
      support: {
        distinctDedupeGroupCount: "1",
        strongDedupeGroupCount: "1",
        weakDedupeGroupCount: "0",
        observedEofProvisionalGroupCount: "0",
        unknownDedupeSessionCount: "1",
        sessionDuplicateMethodCounts: { explicitLineage: "1", exactFirstTurnPrefix: "0" },
      },
      strengthCounts: { observed: "2", confirmed: "1", inferred: "0" },
      outOfWindow: { scope: "all-indexed-history", retrySummary: null },
      comparison: null,
    }],
    totalCandidateCount: "1",
    truncated: false,
    coverage: { ...coverage, fullyExcludedCapabilityCount: "0" },
    nextCursor: null,
  };
  const activity = {
    format: "threadshare-insights-activity@v1",
    snapshot,
    sourceFreshness: "not-evaluated",
    bucket: "day",
    timeZone: "UTC",
    window: usage.window,
    closureEvaluatedAt: usage.closureEvaluatedAt,
    quiescenceSeconds: 300,
    buckets: [{
      bucketStart: "2026-08-10T00:00:00.000Z",
      bucketEnd: "2026-08-11T00:00:00.000Z",
      distinctSessionCount: "2",
      distinctTurnCount: "2",
      currentClosureCounts: { hardSealed: "1", quiescent: "0", open: "1" },
      turnResultEvidenceCounts: { providerCompleted: "1", abandoned: "0", unknown: "1" },
      recordedToolInvocationCount: "3",
      recordedSkillInvocationCount: "0",
      support: {
        distinctDedupeGroupCount: "1", strongDedupeGroupCount: "1",
        weakDedupeGroupCount: "0", observedEofProvisionalGroupCount: "0",
        unknownDedupeSessionCount: "1",
      },
    }],
    coverage,
  };
  const validateUsage = schemas.get(usage.format);
  const validateActivity = schemas.get(activity.format);
  assert.equal(validateUsage(usage), true, JSON.stringify(validateUsage.errors));
  assert.equal(validateActivity(activity), true, JSON.stringify(validateActivity.errors));
  assert.equal(validateUsage({ ...usage, causedAbandonedTurnCount: "1" }), false);
  const negativeZero = structuredClone(usage);
  negativeZero.comparisonWindow = usage.window;
  negativeZero.items[0].comparison = {
    baselineRecordedInvocationCount: "0",
    currentRecordedInvocationCount: "0",
    absoluteRecordedInvocationChange: "-0",
  };
  assert.equal(validateUsage(negativeZero), false);
  assert.equal(validateActivity({
    ...activity,
    buckets: [{ ...activity.buckets[0], successfulToolInvocationCount: "3" }],
  }), false);
});
