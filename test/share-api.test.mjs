import assert from "node:assert/strict";
import test from "node:test";
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import * as shareApi from "../src/share-api.ts";
import { CHAT_SHARE_MAX_BYTES, ChatHistorySchema, shareKey } from "../src/share-schema.ts";

const ajv = new Ajv2020({ strict: false });
addFormats(ajv);
const validateCanonicalHistory = ajv.compile(
  JSON.parse(readFileSync(new URL("../schema/threadshare-history.v1.schema.json", import.meta.url), "utf8")),
);

function history(exportedAt) {
  return {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    exportedAt,
    conversation: { id: "conversation-1", title: "API test" },
    entries: [],
  };
}

test("uses the canonical RFC 3339 timestamp contract", () => {
  const cases = [
    ["2026-07-30T20:34:56+08:00", true],
    ["2026-07-30t20:34:56z", true],
    ["2026-07-30T20:34Z", false],
    ["2026-07-30 20:34:56Z", false],
    ["2026-07-30T20:34:56+0800", false],
    ["2026-07-30T20:34:56+24:00", false],
    ["2026-07-30T20:34:56+00:60", false],
    ["2026-07-30T24:59:00+01:00", false],
    ["2026-07-30T29:59:60+06:00", false],
    ["2026-07-30T23:59:60Z", true],
    ["2026-07-31T07:59:60+08:00", true],
    ["2026-07-30T08:00:60Z", false],
  ];

  for (const [timestamp, expected] of cases) {
    assert.equal(validateCanonicalHistory(history(timestamp)), expected, `JSON Schema: ${timestamp}`);
    assert.equal(ChatHistorySchema.safeParse(history(timestamp)).success, expected, `Zod: ${timestamp}`);
  }
});

test("normalizes UUID object keys", () => {
  assert.equal(
    shareKey("A4F2927B-7079-4A1E-AE5D-6B80C43C7BA0"),
    "shares/a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0.json",
  );
});

test("stops reading a request once it crosses 5 MiB", async () => {
  assert.equal(typeof shareApi.parseShareRequest, "function");
  let pulls = 0;
  let canceled = false;
  const body = new ReadableStream({
    pull(controller) {
      pulls += 1;
      controller.enqueue(new Uint8Array(1024 * 1024));
      if (pulls === 10) controller.close();
    },
    cancel() {
      canceled = true;
    },
  });
  const request = new Request("https://threadshare.invalid/api/v1/shares", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body,
    duplex: "half",
  });

  const parsed = await shareApi.parseShareRequest(request);

  assert.deepEqual(parsed, { ok: false, status: 413, error: "Shared history is too large" });
  assert.ok(pulls < 10, `expected an early stop, read ${pulls} chunks`);
  assert.equal(canceled, true);
});

test("rejects an oversized declared body without consuming it", async () => {
  assert.equal(typeof shareApi.parseShareRequest, "function");
  const request = new Request("https://threadshare.invalid/api/v1/shares", {
    method: "POST",
    headers: {
      "content-length": String(CHAT_SHARE_MAX_BYTES + 1),
      "content-type": "application/json",
    },
    body: "{}",
    duplex: "half",
  });

  const parsed = await shareApi.parseShareRequest(request);

  assert.deepEqual(parsed, { ok: false, status: 413, error: "Shared history is too large" });
  assert.equal(request.bodyUsed, false);
});

test("enforces JSON-only requests and the exact 5 MiB boundary", async () => {
  const wrongType = new Request("https://threadshare.invalid/api/v1/shares", {
    method: "POST",
    headers: { "content-type": "text/plain" },
    body: "{}",
    duplex: "half",
  });
  assert.deepEqual(await shareApi.parseShareRequest(wrongType), {
    ok: false,
    status: 415,
    error: "Content-Type must be application/json",
  });
  assert.equal(wrongType.bodyUsed, false);

  const exactLimit = history("2026-07-30T00:00:00.000Z");
  exactLimit.conversation.title = "";
  const emptyTitleBody = JSON.stringify(exactLimit);
  exactLimit.conversation.title = "x".repeat(CHAT_SHARE_MAX_BYTES - Buffer.byteLength(emptyTitleBody));
  const exactLimitBody = JSON.stringify(exactLimit);
  assert.equal(Buffer.byteLength(exactLimitBody), CHAT_SHARE_MAX_BYTES);
  assert.equal(shareApi.parseShareBody("application/json", exactLimitBody).ok, true);
  assert.deepEqual(shareApi.parseShareBody("application/json", `${exactLimitBody} `), {
    ok: false,
    status: 413,
    error: "Shared history is too large",
  });
});

test("rejects extra canonical fields", () => {
  const canonical = history("2026-07-30T00:00:00.000Z");
  canonical.unexpected = true;
  assert.equal(ChatHistorySchema.safeParse(canonical).success, false);
});

test("keeps the legacy conversation contract frozen", () => {
  const legacy = history("2026-07-30T00:00:00.000Z");
  delete legacy.format;
  assert.equal(ChatHistorySchema.safeParse(legacy).success, true);

  assert.equal(
    ChatHistorySchema.safeParse({ ...legacy, exportedAt: "2026-07-30T08:00:00+08:00" }).success,
    false,
  );
  assert.equal(
    ChatHistorySchema.safeParse({ ...legacy, exportedAt: "2026-07-30t00:00:00z" }).success,
    false,
  );
  assert.equal(
    ChatHistorySchema.safeParse({
      ...legacy,
      conversation: { ...legacy.conversation, source: "paseo" },
    }).success,
    false,
  );
});
