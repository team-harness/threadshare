import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import {
  CONTINUATION_CONTEXT_NOTICE,
  createInsightsContinuationContext,
} from "../src/insights-continuation-context.mjs";

const TRACE_URL = new URL("./fixtures/insights-delivery-trace-golden.v1.json", import.meta.url);

test("continuation context keeps evidence strengths separate and states its restore boundary", async () => {
  const fixture = JSON.parse(await readFile(TRACE_URL, "utf8"));
  const value = createInsightsContinuationContext(fixture.response, {
    recentPrompts: [{
      turnKey: "1".repeat(64), revision: "2".repeat(64),
      text: "Continue the Delivery Trace implementation", complete: true,
    }],
    failureChains: [{
      chainKey: "3".repeat(64), revision: "4".repeat(64), outcome: "recovered",
      summary: "The bounded retry later committed successfully.",
    }],
  });
  assert.equal(value.notice, CONTINUATION_CONTEXT_NOTICE);
  assert.equal(value.edges.direct.length, 2);
  assert.equal(value.edges.observed.length, 1);
  assert.deepEqual(value.edges.candidate, []);
  assert.equal(value.commits.length, 1);
  assert.equal(value.files.length, 1);
  assert.equal(value.recentPrompts[0].complete, true);

  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const traceSchema = JSON.parse(await readFile(
    new URL("../schema/threadshare-insights-delivery-trace.v1.schema.json", import.meta.url),
  ));
  const contextSchema = JSON.parse(await readFile(
    new URL("../schema/threadshare-insights-continuation-context.v1.schema.json", import.meta.url),
  ));
  ajv.addSchema(traceSchema);
  const validate = ajv.compile(contextSchema);
  assert.equal(validate(value), true, JSON.stringify(validate.errors));
});

test("continuation context bounds supplied prompt and failure evidence", async () => {
  const fixture = JSON.parse(await readFile(TRACE_URL, "utf8"));
  const prompts = Array.from({ length: 9 }, (_, index) => ({
    turnKey: index.toString(16).padStart(64, "0"),
    revision: "f".repeat(64),
    text: `prompt ${index}`,
    complete: true,
  }));
  const value = createInsightsContinuationContext(fixture.response, { recentPrompts: prompts });
  assert.equal(value.recentPrompts.length, 8);
  assert.equal(value.recentPrompts[0].text, "prompt 1");
  assert.equal(value.truncation.recentPrompts, true);
});
