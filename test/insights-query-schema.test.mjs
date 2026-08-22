import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

const FORMATS = Object.freeze([
  "threadshare-insights-agent-spec@v1",
  "threadshare-insights-overview@v1",
  "threadshare-insights-search-request@v1",
  "threadshare-insights-search@v1",
  "threadshare-insights-capabilities@v1",
  "threadshare-insights-continuation-context@v1",
  "threadshare-insights-usage-request@v1",
  "threadshare-insights-usage@v1",
  "threadshare-insights-activity-request@v1",
  "threadshare-insights-activity@v1",
  "threadshare-insights-evidence@v1",
  "threadshare-insights-query-request@v2",
  "threadshare-insights-query@v2",
  "threadshare-insights-recipe-request@v1",
  "threadshare-insights-recipe@v1",
  "threadshare-insights-evidence-request@v2",
  "threadshare-insights-evidence@v2",
  "threadshare-insights-delivery-trace-request@v1",
  "threadshare-insights-delivery-trace@v1",
  "threadshare-insights-git-diff-evidence-request@v1",
  "threadshare-insights-git-diff-evidence@v1",
]);
const RECIPE_ITEMS_URL = new URL("./fixtures/insights-recipe-items.v1.json", import.meta.url);
const DELIVERY_TRACE_URL = new URL(
  "./fixtures/insights-delivery-trace-golden.v1.json",
  import.meta.url,
);

function completeCoverage() {
  return {
    matching: {
      fullRecordCount: "1", summaryRecordCount: "0", unloadedRecordCount: "0",
      truncatedRecordCount: "0", unavailableRecordCount: "0", missingTimestampCount: "0",
      missingRevisionCount: "0", missingTokenMetricCount: "0", missingPayloadCount: "0",
    },
    indexedHistory: {
      visibleSessionCount: "1", excludedSessionCount: "0", subagentExcludedSessionCount: "0",
      unknownEligibilitySessionCount: "0", pendingPurgeSessionCount: "0",
      purgedSessionCount: "0", missingCoverageRollupSessionCount: "0",
      fts: {
        searchableEventCount: "1", storedNotSearchableEventCount: "0",
        searchablePayloadBytes: "7", storedNotSearchablePayloadBytes: "0",
      },
    },
    degraded: false,
    diagnostics: [],
  };
}

function schemaFilename(format) {
  return `${format.replace(/@v([12])$/u, ".v$1")}.schema.json`;
}

async function compiledSchemas() {
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const documents = new Map();
  for (const format of FORMATS) {
    const filename = schemaFilename(format);
    const document = JSON.parse(await readFile(new URL(`../schema/${filename}`, import.meta.url)));
    assert.equal(document.$schema, "https://json-schema.org/draft/2020-12/schema");
    assert.equal(document.$id, `https://threadshare.team-harness.com/schema/${filename}`);
    assert.equal(document.type, "object");
    assert.equal(document.additionalProperties, false);
    assert.deepEqual(document.properties.format, { const: format });
    assert.equal(document.required.includes("format"), true);
    documents.set(format, document);
    ajv.addSchema(document);
  }
  const result = new Map();
  for (const [format, document] of documents) result.set(format, ajv.getSchema(document.$id));
  return result;
}

test("ships twenty-one strict Agent Insights JSON schemas", async () => {
  assert.equal((await compiledSchemas()).size, 21);
});

test("Delivery Trace and Git diff schemas accept the shared fixture", async () => {
  const schemas = await compiledSchemas();
  const fixture = JSON.parse(await readFile(DELIVERY_TRACE_URL, "utf8"));
  for (const [format, value] of [
    [fixture.request.format, fixture.request],
    [fixture.response.format, fixture.response],
    [fixture.gitDiff.request.format, fixture.gitDiff.request],
    [fixture.gitDiff.response.format, fixture.gitDiff.response],
  ]) {
    const validate = schemas.get(format);
    assert.equal(validate(value), true, JSON.stringify(validate.errors));
    assert.equal(validate({ ...value, unknown: true }), false, format);
  }

  const invalidDerivedEdge = structuredClone(fixture.response);
  invalidDerivedEdge.edges[2].facts = [];
  const validateTrace = schemas.get(fixture.response.format);
  assert.equal(validateTrace(invalidDerivedEdge), false, "derived edges require auditable facts");

  const validateRecipeRequest = schemas.get("threadshare-insights-recipe-request@v1");
  const traceRecipeRequest = {
    format: "threadshare-insights-recipe-request@v1",
    root: fixture.request.root,
    window: fixture.request.window,
    direction: fixture.request.direction,
    maxDepth: fixture.request.maxDepth,
    includeCandidateEdges: false,
    includeContextualEdges: false,
    limit: fixture.request.limit,
    cursor: null,
  };
  assert.equal(validateRecipeRequest(traceRecipeRequest), true, JSON.stringify(validateRecipeRequest.errors));
  const implicitRepositoryTrace = { ...traceRecipeRequest };
  delete implicitRepositoryTrace.root;
  assert.equal(validateRecipeRequest(implicitRepositoryTrace), true,
    JSON.stringify(validateRecipeRequest.errors));
  assert.equal(validateRecipeRequest({ ...traceRecipeRequest, maxDepth: 4 }), false);

  const validateGitRequest = schemas.get("threadshare-insights-git-diff-evidence-request@v1");
  const rootGitRequest = { ...fixture.gitDiff.request, parentObjectId: null };
  assert.equal(validateGitRequest(rootGitRequest), true, JSON.stringify(validateGitRequest.errors));

  const validateEvidence = schemas.get("threadshare-insights-evidence-request@v2");
  const commitNode = fixture.response.nodes.find(({ kind }) => kind === "git-commit");
  const commitEdge = fixture.response.edges[0];
  for (const target of [
    {
      kind: "delivery-node", nodeKind: commitNode.kind,
      nodeKey: commitNode.key, revision: commitNode.revision,
    },
    {
      kind: "delivery-edge", relation: commitEdge.relation,
      from: commitEdge.from, to: commitEdge.to, revision: commitEdge.revision,
    },
  ]) {
    const request = {
      format: "threadshare-insights-evidence-request@v2",
      target,
      include: ["envelope"],
      cursor: null,
      maxBytes: 4096,
    };
    assert.equal(validateEvidence(request), true, JSON.stringify(validateEvidence.errors));
  }

  // Turn-level commit attribution reaches the reader through the same response and the same
  // Evidence request, so both schemas have to accept the relation the Engine now projects.
  const sessionNode = fixture.response.nodes.find(({ kind }) => kind === "session");
  const turnKey = "1".repeat(64);
  const turnTrace = structuredClone(fixture.response);
  turnTrace.nodes.push({
    kind: "turn", key: turnKey, revision: sessionNode.revision,
    label: "Commit the delivery trace", observedAt: sessionNode.observedAt,
    attributes: { sessionKey: sessionNode.key },
  });
  const turnCommitEdge = {
    relation: "turn-observed-commit",
    from: { kind: "turn", key: turnKey },
    to: { kind: "git-commit", key: commitNode.key },
    strength: "direct", source: "observed-git-result",
    facts: [{ kind: "full-commit-hash" }],
    limitations: ["not-authorship", "not-exclusive-line-attribution"],
    revision: sessionNode.revision,
  };
  turnTrace.edges.push(turnCommitEdge);
  assert.equal(validateTrace(turnTrace), true, JSON.stringify(validateTrace.errors));
  assert.equal(validateEvidence({
    format: "threadshare-insights-evidence-request@v2",
    target: {
      kind: "delivery-edge", relation: turnCommitEdge.relation,
      from: turnCommitEdge.from, to: turnCommitEdge.to, revision: turnCommitEdge.revision,
    },
    include: ["envelope"],
    cursor: null,
    maxBytes: 4096,
  }), true, JSON.stringify(validateEvidence.errors));

  // A prefix match is Derived: it resolves to one commit today and can resolve to a different
  // one once more commits land. So the schema has to demand the recomputable facts and the
  // limitations that say so, the same way it does for the Session-level correlation.
  const correlated = structuredClone(turnTrace);
  const correlatedEdge = correlated.edges.at(-1);
  correlatedEdge.relation = "turn-correlates-commit";
  correlatedEdge.strength = "observed";
  correlatedEdge.facts = [{ kind: "unique-abbreviated-commit-hash" }];
  assert.equal(validateTrace(correlated), true, JSON.stringify(validateTrace.errors));
  for (const field of ["facts", "limitations"]) {
    const bare = structuredClone(correlated);
    bare.edges.at(-1)[field] = [];
    assert.equal(validateTrace(bare), false, field);
  }
});

test("usage and activity schemas lock the non-causal aggregate axes", async () => {
  const schemas = await compiledSchemas();
  const snapshot = { seq: "1", token: "a".repeat(64) };
  const coverage = {
    scope: "all-indexed-history",
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

test("all eight Recipe schemas accept reviewed items and reject unknown fields", async () => {
  const schemas = await compiledSchemas();
  const validate = schemas.get("threadshare-insights-recipe@v1");
  const recipes = JSON.parse(await readFile(RECIPE_ITEMS_URL, "utf8"));
  assert.equal(recipes.length, 8);
  for (const { name, item } of recipes) {
    const response = {
      format: "threadshare-insights-recipe@v1",
      snapshot: { seq: "7", token: "a".repeat(64) },
      sourceFreshness: { state: "not-evaluated", lastCommittedAt: null },
      name,
      window: {
        after: "2026-08-01T00:00:00.000Z",
        before: "2026-09-01T00:00:00.000Z",
      },
      comparisonWindow: null,
      evaluatedAt: "2026-08-12T00:00:00.000Z",
      items: [item],
      totalItemCount: "1",
      truncated: false,
      coverage: completeCoverage(),
      provenance: { default: "recorded", fields: [] },
    };
    assert.equal(validate(response), true, `${name}: ${JSON.stringify(validate.errors)}`);
    assert.equal(validate({
      ...response,
      items: [{ ...item, unreviewed: "private surprise" }],
    }), false, name);
  }
});
