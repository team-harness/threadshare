import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import {
  assertGitDiffEvidenceRequest,
  assertGitDiffEvidencePair,
  assertProtocolMessage,
  createInsightsDeliveryTraceMessage,
  createReadInsightsEvidenceV2Message,
  createReadInsightsDeliveryTraceMessage,
} from "../src/insights-engine-protocol.mjs";

const fixtureUrl = new URL("./fixtures/insights-delivery-trace-golden.v1.json", import.meta.url);

async function fixture() {
  return JSON.parse(await readFile(fixtureUrl, "utf8"));
}

test("Delivery Trace protocol accepts the shared strict fixture", async () => {
  const value = await fixture();
  const request = createReadInsightsDeliveryTraceMessage({
    requestId: "91",
    request: value.request,
  });
  const response = createInsightsDeliveryTraceMessage({
    requestId: "91",
    request: value.request,
    response: value.response,
  });

  assert.equal(assertProtocolMessage(request), request);
  assert.equal(assertProtocolMessage(response), response);
});

test("Delivery Trace accepts a uniquely resolved abbreviated commit result", async () => {
  const value = await fixture();
  const response = structuredClone(value.response);
  response.edges[2].source = "observed-git-result";
  response.edges[2].facts = [{ kind: "unique-abbreviated-commit-hash" }];

  const message = createInsightsDeliveryTraceMessage({
    requestId: "95",
    request: value.request,
    response,
  });
  assert.equal(assertProtocolMessage(message), message);
});

/**
 * Adds the Turn that the fixture's Session already owns, plus the two Turn-level commit
 * attributions the Engine now projects. A commit attributed to a Session says which day of
 * work produced it; the same commit attributed to a Turn says which attempt produced it, which
 * is the granularity a reader needs to separate the attempt that landed from the ones before it.
 */
function withTurnLevelCommitEdges(response) {
  const clone = structuredClone(response);
  const session = clone.nodes.find((node) => node.kind === "session");
  const commit = clone.nodes.find((node) => node.kind === "git-commit");
  const turnKey = "1".repeat(64);
  clone.nodes.push({
    kind: "turn",
    key: turnKey,
    revision: session.revision,
    label: "Commit the delivery trace",
    observedAt: session.observedAt,
    attributes: { sessionKey: session.key },
  });
  clone.edges.push({
    relation: "session-contains-turn",
    from: { kind: "session", key: session.key },
    to: { kind: "turn", key: turnKey },
    strength: "direct",
    source: "session-membership",
    facts: [],
    limitations: [],
    revision: session.revision,
  });
  clone.edges.push({
    relation: "turn-observed-commit",
    from: { kind: "turn", key: turnKey },
    to: { kind: "git-commit", key: commit.key },
    strength: "direct",
    source: "observed-git-result",
    facts: [{ kind: "full-commit-hash" }],
    limitations: ["not-authorship", "not-exclusive-line-attribution"],
    revision: session.revision,
  });
  return clone;
}

test("Delivery Trace accepts Turn-level commit attribution and keeps correlation weak", async () => {
  const value = await fixture();
  const response = withTurnLevelCommitEdges(value.response);
  const message = createInsightsDeliveryTraceMessage({
    requestId: "96",
    request: value.request,
    response,
  });
  assert.equal(assertProtocolMessage(message), message);

  const abbreviated = structuredClone(response);
  const turnEdge = abbreviated.edges.at(-1);
  turnEdge.relation = "turn-correlates-commit";
  turnEdge.strength = "observed";
  turnEdge.facts = [{ kind: "unique-abbreviated-commit-hash" }];
  const correlated = createInsightsDeliveryTraceMessage({
    requestId: "97",
    request: value.request,
    response: abbreviated,
  });
  assert.equal(assertProtocolMessage(correlated), correlated);

  // A prefix match resolves to one commit today and can resolve to another after more
  // commits land, so the edge it produces must never claim the strength of a full hash.
  const upgraded = structuredClone(abbreviated);
  upgraded.edges.at(-1).strength = "direct";
  assert.throws(
    () => createInsightsDeliveryTraceMessage({
      requestId: "98",
      request: value.request,
      response: upgraded,
    }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
});

test("Delivery Trace rejects missing endpoints and hidden weak edges", async () => {
  const value = await fixture();
  const missingEndpoint = structuredClone(value.response);
  missingEndpoint.nodes = missingEndpoint.nodes.filter((node) => node.kind !== "file");
  assert.throws(
    () => createInsightsDeliveryTraceMessage({
      requestId: "92",
      request: value.request,
      response: missingEndpoint,
    }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );

  for (const strength of ["candidate", "contextual"]) {
    const hiddenEdge = structuredClone(value.response);
    hiddenEdge.edges[2].strength = strength;
    assert.throws(
      () => createInsightsDeliveryTraceMessage({
        requestId: strength === "candidate" ? "93" : "94",
        request: value.request,
        response: hiddenEdge,
      }),
      (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
    );
  }
});

test("Delivery Trace rejects correlation upgrades and malformed evidence", async () => {
  const value = await fixture();
  const mutations = [
    (response) => { response.edges[2].strength = "direct"; },
    (response) => { response.edges[2].strength = "certain"; },
    (response) => { response.edges[2].facts = []; },
    (response) => { response.edges[2].limitations = []; },
    (response) => { response.edges[2].limitations = ["proves-authorship"]; },
    (response) => { response.edges[2].revision = "not-a-revision"; },
    (response) => { response.nodes[0].attributes.unknown = true; },
  ];
  for (const mutate of mutations) {
    const response = structuredClone(value.response);
    mutate(response);
    assert.throws(
      () => createInsightsDeliveryTraceMessage({
        requestId: "96",
        request: value.request,
        response,
      }),
      (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
    );
  }
});

test("Delivery Trace requires non-null evaluation and window timestamps", async () => {
  const value = await fixture();
  const mutations = [
    (request) => { request.evaluatedAt = null; },
    (request) => {
      request.window = {
        after: null,
        before: "2026-08-16T02:00:00.000Z",
      };
    },
  ];
  for (const mutate of mutations) {
    const request = structuredClone(value.request);
    mutate(request);
    assert.throws(
      () => createReadInsightsDeliveryTraceMessage({ requestId: "97", request }),
      (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
    );
  }

  const response = structuredClone(value.response);
  response.evaluatedAt = null;
  assert.throws(
    () => createInsightsDeliveryTraceMessage({
      requestId: "98",
      request: value.request,
      response,
    }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
});

test("Git diff evidence binds commit, parent, path, and revision", async () => {
  const value = await fixture();
  assert.equal(assertGitDiffEvidencePair(value.gitDiff.request, value.gitDiff.response), true);

  for (const field of ["commitObjectId", "parentObjectId", "path", "revision"]) {
    const response = structuredClone(value.gitDiff.response);
    response[field] = field === "path" ? "src/other.rs" : "3".repeat(response[field].length);
    assert.throws(
      () => assertGitDiffEvidencePair(value.gitDiff.request, response),
      (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
      field,
    );
  }
});

test("Git diff evidence represents a root commit with an explicit null parent", async () => {
  const value = await fixture();
  const request = { ...value.gitDiff.request, parentObjectId: null };
  const response = { ...value.gitDiff.response, parentObjectId: null };
  assert.equal(assertGitDiffEvidenceRequest(request), undefined);
  assert.equal(assertGitDiffEvidencePair(request, response), true);
});

test("Trace node and edge Evidence targets are revision-bound protocol values", async () => {
  const value = await fixture();
  const node = value.response.nodes.find(({ kind }) => kind === "git-commit");
  const edge = value.response.edges[0];
  const targets = [
    {
      kind: "delivery-node",
      nodeKind: node.kind,
      nodeKey: node.key,
      revision: node.revision,
    },
    {
      kind: "delivery-edge",
      relation: edge.relation,
      from: edge.from,
      to: edge.to,
      revision: edge.revision,
    },
  ];
  for (const [index, target] of targets.entries()) {
    const message = createReadInsightsEvidenceV2Message({
      requestId: String(110 + index),
      request: {
        format: "threadshare-insights-evidence-request@v2",
        target,
        include: ["envelope"],
        cursor: null,
        maxBytes: 4096,
      },
    });
    assert.equal(assertProtocolMessage(message), message);
    const invalid = structuredClone(message);
    invalid.request.target.revision = "stale";
    assert.throws(
      () => assertProtocolMessage(invalid),
      (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
    );
  }
});

test("SCM fallback stays unverified and never changes Delivery Trace strength", async () => {
  const value = await fixture();
  const commitIndex = value.response.nodes.findIndex(({ kind }) => kind === "git-commit");
  const withoutScm = structuredClone(value.response);
  withoutScm.nodes[commitIndex].attributes.externalLinks.commit = null;
  const response = createInsightsDeliveryTraceMessage({
    requestId: "120",
    request: value.request,
    response: withoutScm,
  });
  assert.deepEqual(response.response.edges, value.response.edges);

  for (const suffix of ["?token=private", "#private"]) {
    const invalid = structuredClone(value.response);
    invalid.nodes[commitIndex].attributes.externalLinks.commit += suffix;
    assert.throws(
      () => createInsightsDeliveryTraceMessage({
        requestId: "121",
        request: value.request,
        response: invalid,
      }),
      (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
    );
  }
});
