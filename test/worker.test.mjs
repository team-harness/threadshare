import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import test from "node:test";
import worker, { createWorker } from "../worker.ts";
import {
  agentAlternateLink,
  agentProblemBody,
  formatAgentTranscript,
} from "../src/agent-transcript.mjs";
import { createStoredShare } from "../src/stored-share.ts";

const NOW = Date.parse("2026-08-01T10:00:00.000Z");
const REVOKE_TOKEN = Buffer.alloc(32, 17).toString("base64url");
const WRONG_REVOKE_TOKEN = Buffer.alloc(32, 18).toString("base64url");
const REVOKE_DIGEST = createHash("sha256").update(REVOKE_TOKEN).digest("base64url");

function history() {
  return {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    exportedAt: "2026-07-30T00:00:00.000Z",
    conversation: { id: "conversation-1", title: "Worker test" },
    entries: [],
  };
}

function environment(bucket, assetFetch = () => new Response("asset")) {
  return {
    ASSETS: { fetch: assetFetch },
    THREADSHARE_BUCKET: bucket,
  };
}

test("stores an expiring wrapper and reads only its history with equivalent headers", async () => {
  const objects = new Map();
  const bucket = {
    async put(key, value) {
      objects.set(key, value);
    },
    async get(key) {
      const value = objects.get(key);
      if (value === undefined) return null;
      return { body: new Response(value).body, httpEtag: "etag" };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  const env = environment(bucket);
  const testWorker = createWorker({ now: () => NOW });
  const created = await testWorker.fetch(
    new Request("https://threadshare.invalid/api/v1/shares", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-threadshare-expires-in": "60",
      },
      body: JSON.stringify(history()),
    }),
    env,
  );
  const { id, expiresAt } = await created.json();
  assert.equal(expiresAt, "2026-08-01T10:01:00.000Z");
  assert.deepEqual(JSON.parse(objects.get(`shares/${id}.json`)), {
    format: "threadshare-object@v1",
    createdAt: "2026-08-01T10:00:00.000Z",
    expiresAt,
    history: history(),
  });

  const loaded = await testWorker.fetch(
    new Request(`https://threadshare.invalid/api/v1/shares/${id.toUpperCase()}`),
    env,
  );

  assert.equal(loaded.status, 200);
  assert.deepEqual(Object.fromEntries(loaded.headers.entries()), {
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-threadshare-expires-at",
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "x-threadshare-expires-at": expiresAt,
  });
  assert.deepEqual(await loaded.json(), history());
});

test("keeps old bare objects readable and defaults new shares to no expiration", async () => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const objects = new Map([[`shares/${id}.json`, JSON.stringify(history())]]);
  const bucket = {
    async put(key, value) {
      objects.set(key, value);
    },
    async get(key) {
      const value = objects.get(key);
      return value === undefined ? null : { body: new Response(value).body, httpEtag: "etag" };
    },
    async delete(key) {
      objects.delete(key);
    },
  };
  const testWorker = createWorker({ now: () => NOW });
  const oldResponse = await testWorker.fetch(
    new Request(`https://threadshare.invalid/api/v1/shares/${id}`),
    environment(bucket),
  );
  assert.deepEqual(await oldResponse.json(), history());
  assert.equal(oldResponse.headers.get("x-threadshare-expires-at"), null);

  const created = await testWorker.fetch(
    new Request("https://threadshare.invalid/api/v1/shares", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(history()),
    }),
    environment(bucket),
  );
  const payload = await created.json();
  assert.deepEqual(Object.keys(payload), ["id"]);
  assert.deepEqual(JSON.parse(objects.get(`shares/${payload.id}.json`)), {
    format: "threadshare-object@v1",
    createdAt: "2026-08-01T10:00:00.000Z",
    history: history(),
  });
});

test("stores only a revoke digest and deletes with the matching bearer capability", async () => {
  const objects = new Map();
  const operations = [];
  const bucket = {
    async put(key, value) {
      operations.push(["put", key]);
      objects.set(key, value);
    },
    async get(key) {
      operations.push(["get", key]);
      const value = objects.get(key);
      return value === undefined ? null : { body: new Response(value).body };
    },
    async delete(key) {
      operations.push(["delete", key]);
      objects.delete(key);
    },
  };
  const testWorker = createWorker({ now: () => NOW });
  const created = await testWorker.fetch(
    new Request("https://threadshare.invalid/api/v1/shares", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-threadshare-revoke-token-sha256": REVOKE_DIGEST,
      },
      body: JSON.stringify(history()),
    }),
    environment(bucket),
  );

  assert.equal(created.status, 201);
  const payload = await created.json();
  assert.equal(payload.revocable, true);
  const key = `shares/${payload.id}.json`;
  const raw = objects.get(key);
  assert.equal(JSON.parse(raw).revokeTokenSha256, REVOKE_DIGEST);
  assert.doesNotMatch(raw, new RegExp(REVOKE_TOKEN));

  const wrong = await testWorker.fetch(
    new Request(`https://threadshare.invalid/api/v1/shares/${payload.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${WRONG_REVOKE_TOKEN}` },
    }),
    environment(bucket),
  );
  assert.equal(wrong.status, 404);
  assert.equal(wrong.headers.get("access-control-allow-origin"), null);
  assert.equal(objects.has(key), true);
  assert.deepEqual(operations.slice(-1), [["get", key]]);

  const revoked = await testWorker.fetch(
    new Request(`https://threadshare.invalid/api/v1/shares/${payload.id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${REVOKE_TOKEN}` },
    }),
    environment(bucket),
  );
  assert.equal(revoked.status, 204);
  assert.equal(revoked.headers.get("access-control-allow-origin"), null);
  assert.equal(objects.has(key), false);
  assert.deepEqual(operations.slice(-2), [["get", key], ["delete", key]]);
});

test("hides missing capabilities and lets a valid capability revoke an expired share", async () => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const key = `shares/${id}.json`;
  const objects = new Map([
    [
      key,
      JSON.stringify(
        createStoredShare(history(), NOW - 60_000, {
          expiresInSeconds: 60,
          revokeTokenSha256: REVOKE_DIGEST,
        }),
      ),
    ],
  ]);
  const bucket = {
    async put() {},
    async get(objectKey) {
      const value = objects.get(objectKey);
      return value === undefined ? null : { body: new Response(value).body };
    },
    async delete(objectKey) {
      objects.delete(objectKey);
    },
  };
  const testWorker = createWorker({ now: () => NOW });

  for (const authorization of [undefined, "Bearer short"]) {
    const response = await testWorker.fetch(
      new Request(`https://threadshare.invalid/api/v1/shares/${id}`, {
        method: "DELETE",
        ...(authorization ? { headers: { authorization } } : {}),
      }),
      environment(bucket),
    );
    assert.equal(response.status, 404);
    assert.deepEqual(await response.json(), { error: "Shared history was not found" });
    assert.equal(objects.has(key), true);
  }

  const response = await testWorker.fetch(
    new Request(`https://threadshare.invalid/api/v1/shares/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${REVOKE_TOKEN}` },
    }),
    environment(bucket),
  );
  assert.equal(response.status, 204);
  assert.equal(objects.has(key), false);

  objects.set(key, JSON.stringify(history()));
  const oldObject = await testWorker.fetch(
    new Request(`https://threadshare.invalid/api/v1/shares/${id}`, {
      method: "DELETE",
      headers: { authorization: `Bearer ${REVOKE_TOKEN}` },
    }),
    environment(bucket),
  );
  assert.equal(oldObject.status, 404);
  assert.equal(objects.has(key), true);
});

test("keeps DELETE storage failures outside the browser CORS contract", async () => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const raw = JSON.stringify(
    createStoredShare(history(), NOW, { revokeTokenSha256: REVOKE_DIGEST }),
  );
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const response = await worker.fetch(
      new Request(`https://threadshare.invalid/api/v1/shares/${id}`, {
        method: "DELETE",
        headers: { authorization: `Bearer ${REVOKE_TOKEN}` },
      }),
      environment({
        async put() {},
        async get() {
          return { body: new Response(raw).body };
        },
        async delete() {
          throw new Error("R2 delete failed");
        },
      }),
    );
    assert.equal(response.status, 500);
    assert.equal(response.headers.get("access-control-allow-origin"), null);
    assert.deepEqual(await response.json(), { error: "Unable to process shared history" });
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalError;
  }
});

test("expires at the boundary and keeps 404 when lazy deletion fails", async (t) => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const raw = JSON.stringify(
    createStoredShare(history(), NOW - 60_000, { expiresInSeconds: 60 }),
  );

  await t.test("deletes the expired object", async () => {
    const objects = new Map([[`shares/${id}.json`, raw]]);
    const deleted = [];
    const response = await createWorker({ now: () => NOW }).fetch(
      new Request(`https://threadshare.invalid/api/v1/shares/${id}`),
      environment({
        async put() {},
        async get(key) {
          return { body: new Response(objects.get(key)).body, httpEtag: "etag" };
        },
        async delete(key) {
          deleted.push(key);
          objects.delete(key);
        },
      }),
    );
    assert.equal(response.status, 404);
    assert.deepEqual(deleted, [`shares/${id}.json`]);
    assert.equal(objects.has(`shares/${id}.json`), false);
  });

  await t.test("does not turn a deletion failure into 500", async () => {
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    try {
      const response = await createWorker({ now: () => NOW }).fetch(
        new Request(`https://threadshare.invalid/api/v1/shares/${id}`),
        environment({
          async put() {},
          async get() {
            return { body: new Response(raw).body, httpEtag: "etag" };
          },
          async delete() {
            throw new Error("R2 delete failed");
          },
        }),
      );
      assert.equal(response.status, 404);
      assert.deepEqual(await response.json(), { error: "Shared history was not found" });
      assert.equal(errors.length, 1);
    } finally {
      console.error = originalError;
    }
  });
});

test("rejects invalid lifecycle headers before writing to R2", async () => {
  for (const headers of [
    { "x-threadshare-expires-in": "59" },
    { "x-threadshare-revoke-token-sha256": "not-a-digest" },
  ]) {
    let writes = 0;
    const response = await worker.fetch(
      new Request("https://threadshare.invalid/api/v1/shares", {
        method: "POST",
        headers: { "content-type": "application/json", ...headers },
        body: JSON.stringify(history()),
      }),
      environment({
        async put() {
          writes += 1;
        },
        async get() {
          return null;
        },
        async delete() {},
      }),
    );
    assert.equal(response.status, 400);
    assert.equal(writes, 0);
  }
});

test("returns JSON no-store 404 responses without reading invalid object keys", async () => {
  const keys = [];
  const env = environment({
    async put() {},
    async get(key) {
      keys.push(key);
      return null;
    },
  });

  const invalid = await worker.fetch(
    new Request("https://threadshare.invalid/api/v1/shares/not-a-uuid"),
    env,
  );
  const missing = await worker.fetch(
    new Request("https://threadshare.invalid/api/v1/shares/a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0"),
    env,
  );

  for (const response of [invalid, missing]) {
    assert.equal(response.status, 404);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Shared history was not found" });
  }
  assert.deepEqual(keys, ["shares/a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0.json"]);
});

test("returns equivalent JSON errors when R2 operations fail", async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const writeResponse = await worker.fetch(
      new Request("https://threadshare.invalid/api/v1/shares", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(history()),
      }),
      environment({
        async put() {
          throw new Error("R2 write failed");
        },
        async get() {
          return null;
        },
      }),
    );
    const readResponse = await worker.fetch(
      new Request("https://threadshare.invalid/api/v1/shares/a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0"),
      environment({
        async put() {},
        async get() {
          throw new Error("R2 read failed");
        },
      }),
    );

    for (const response of [writeResponse, readResponse]) {
      assert.equal(response.status, 500);
      assert.equal(response.headers.get("cache-control"), "no-store");
      assert.deepEqual(await response.json(), { error: "Unable to process shared history" });
    }
    assert.equal(errors.length, 2);
  } finally {
    console.error = originalError;
  }
});

test("converts late R2 body stream failures into JSON errors", async () => {
  const originalError = console.error;
  const errors = [];
  console.error = (...args) => errors.push(args);
  try {
    const response = await worker.fetch(
      new Request("https://threadshare.invalid/api/v1/shares/a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0"),
      environment({
        async put() {},
        async get() {
          return {
            httpEtag: "etag",
            body: new ReadableStream({
              pull(controller) {
                controller.error(new Error("R2 body failed"));
              },
            }),
          };
        },
      }),
    );

    assert.equal(response.status, 500);
    assert.equal(response.headers.get("cache-control"), "no-store");
    assert.deepEqual(await response.json(), { error: "Unable to process shared history" });
    assert.equal(errors.length, 1);
  } finally {
    console.error = originalError;
  }
});

test("negotiates compact Markdown on Viewer documents while preserving HTML and canonical JSON", async () => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const shared = history();
  shared.entries.push({
    id: "message-1",
    createdAt: "2026-08-01T09:59:00.000Z",
    kind: "message",
    role: "user",
    markdown: "Review this.",
  });
  const raw = JSON.stringify(createStoredShare(shared, NOW, { expiresInSeconds: 60 }));
  let reads = 0;
  let assetReads = 0;
  const assetUrls = [];
  const env = environment(
    {
      async put() {},
      async get() {
        reads += 1;
        return { body: new Response(raw).body };
      },
      async delete() {},
    },
    (request) => {
      assetReads += 1;
      assetUrls.push(request.url);
      return new Response("<main>Viewer</main>", {
        headers: {
          "cache-control": "public, max-age=60",
          link: '</styles.css>; rel="preload"',
          vary: "Origin",
        },
      });
    },
  );
  const testWorker = createWorker({ now: () => NOW });

  const browser = await testWorker.fetch(
    new Request(`https://threadshare.invalid/?id=${id}`, {
      headers: { accept: "text/html,application/xhtml+xml" },
    }),
    env,
  );
  assert.equal(await browser.text(), "<main>Viewer</main>");
  assert.equal(browser.headers.get("cache-control"), "no-store");
  assert.equal(browser.headers.get("vary"), "Origin, Accept");
  assert.equal(
    browser.headers.get("link"),
    `</styles.css>; rel="preload", ${agentAlternateLink(id)}`,
  );
  assert.equal(reads, 0);
  assert.equal(assetReads, 1);

  const indexBrowser = await testWorker.fetch(
    new Request(`https://threadshare.invalid/index.html?id=${id}`, {
      headers: { accept: "text/html" },
    }),
    env,
  );
  assert.equal(indexBrowser.status, 200);
  assert.equal(await indexBrowser.text(), "<main>Viewer</main>");
  assert.equal(new URL(assetUrls[1]).pathname, "/");
  assert.equal(new URL(assetUrls[1]).search, `?id=${id}`);

  const markdown = await testWorker.fetch(
    new Request(`https://threadshare.invalid/?id=${id}`, {
      headers: { accept: "text/markdown" },
    }),
    env,
  );
  assert.equal(markdown.status, 200);
  assert.equal(await markdown.text(), formatAgentTranscript(shared));
  assert.equal(markdown.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(markdown.headers.get("x-threadshare-format"), "agent-transcript@v1");
  assert.equal(markdown.headers.get("x-threadshare-expires-at"), "2026-08-01T10:01:00.000Z");
  assert.equal(markdown.headers.get("vary"), "Accept");

  const explicitHead = await testWorker.fetch(
    new Request(`https://threadshare.invalid/index.html?id=${id}&format=agent`, {
      method: "HEAD",
      headers: { accept: "text/html" },
    }),
    env,
  );
  assert.equal(explicitHead.status, 200);
  assert.equal(await explicitHead.text(), "");
  assert.equal(explicitHead.headers.get("x-threadshare-format"), "agent-transcript@v1");

  const canonical = await testWorker.fetch(
    new Request(`https://threadshare.invalid/api/v1/shares/${id}`, {
      headers: { accept: "text/markdown" },
    }),
    env,
  );
  assert.deepEqual(await canonical.json(), shared);
  assert.equal(canonical.headers.get("content-type"), "application/json; charset=utf-8");
  assert.equal(canonical.headers.get("vary"), null);
  assert.equal(canonical.headers.get("x-threadshare-format"), null);
  assert.equal(reads, 3);
  assert.equal(assetReads, 2);
});

test("returns private Agent problems and explicit Viewer method errors", async () => {
  let reads = 0;
  const env = environment({
    async put() {},
    async get() {
      reads += 1;
      return null;
    },
    async delete() {},
  });
  const testWorker = createWorker({ now: () => NOW });

  const invalid = await testWorker.fetch(
    new Request("https://threadshare.invalid/?id=not-a-uuid&format=agent"),
    env,
  );
  assert.equal(invalid.status, 404);
  assert.equal(await invalid.text(), agentProblemBody(404));
  assert.equal(invalid.headers.get("x-threadshare-format"), "agent-transcript@v1");
  assert.equal(reads, 0);

  const missing = await testWorker.fetch(
    new Request(
      "https://threadshare.invalid/?id=a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0&format=agent",
    ),
    env,
  );
  assert.equal(missing.status, 404);
  assert.equal(await missing.text(), agentProblemBody(404));
  assert.equal(reads, 1);

  const agentMethod = await testWorker.fetch(
    new Request("https://threadshare.invalid/?format=agent", { method: "POST" }),
    env,
  );
  assert.equal(agentMethod.status, 405);
  assert.equal(agentMethod.headers.get("allow"), "GET, HEAD");
  assert.equal(agentMethod.headers.get("cache-control"), "private, no-store");
  assert.equal(agentMethod.headers.get("vary"), "Accept");
  assert.equal(await agentMethod.text(), agentProblemBody(405));

  const browserMethod = await testWorker.fetch(
    new Request("https://threadshare.invalid/", {
      method: "POST",
      headers: { accept: "text/html" },
    }),
    env,
  );
  assert.equal(browserMethod.status, 405);
  assert.equal(browserMethod.headers.get("allow"), "GET, HEAD");
  assert.equal(browserMethod.headers.get("cache-control"), "no-store");
  assert.equal(browserMethod.headers.get("vary"), "Accept");
  assert.equal(browserMethod.headers.get("access-control-allow-origin"), null);
  assert.deepEqual(await browserMethod.json(), { error: "Method not allowed" });
});

test("keeps wildcard Vary and omits alternate links for invalid Viewer IDs", async () => {
  const env = environment(
    { async put() {}, async get() { return null; }, async delete() {} },
    () => new Response("asset", { headers: { vary: "*" } }),
  );
  const response = await createWorker().fetch(
    new Request("https://threadshare.invalid/?id=invalid"),
    env,
  );
  assert.equal(response.headers.get("vary"), "*");
  assert.equal(response.headers.get("link"), null);
  assert.equal(response.headers.get("cache-control"), "no-store");
});

test("keeps legacy, expiration, and decode behavior on the Agent Viewer path", async (t) => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  await t.test("renders migration-only legacy history", async () => {
    const legacy = history();
    delete legacy.format;
    const response = await createWorker({ now: () => NOW }).fetch(
      new Request(`https://threadshare.invalid/?id=${id}&format=agent`),
      environment({
        async put() {},
        async get() { return { body: new Response(JSON.stringify(legacy)).body }; },
        async delete() {},
      }),
    );
    assert.equal(response.status, 200);
    assert.match(await response.text(), /^# Threadshare Agent Transcript v1$/m);
  });

  await t.test("hides and lazily deletes expired history", async () => {
    const objects = new Map([
      [
        `shares/${id}.json`,
        JSON.stringify(createStoredShare(history(), NOW - 60_000, { expiresInSeconds: 60 })),
      ],
    ]);
    const response = await createWorker({ now: () => NOW }).fetch(
      new Request(`https://threadshare.invalid/?id=${id}&format=agent`),
      environment({
        async put() {},
        async get(key) { return { body: new Response(objects.get(key)).body }; },
        async delete(key) { objects.delete(key); },
      }),
    );
    assert.equal(response.status, 404);
    assert.equal(await response.text(), agentProblemBody(404));
    assert.equal(objects.size, 0);
  });

  await t.test("turns invalid stored data into a stable problem", async () => {
    const originalError = console.error;
    const errors = [];
    console.error = (...args) => errors.push(args);
    try {
      const response = await createWorker({ now: () => NOW }).fetch(
        new Request(`https://threadshare.invalid/?id=${id}&format=agent`),
        environment({
          async put() {},
          async get() { return { body: new Response("private invalid object").body }; },
          async delete() {},
        }),
      );
      assert.equal(response.status, 500);
      assert.equal(await response.text(), agentProblemBody(500));
      assert.equal(errors.length, 1);
    } finally {
      console.error = originalError;
    }
  });
});
