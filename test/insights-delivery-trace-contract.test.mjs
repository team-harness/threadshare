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
