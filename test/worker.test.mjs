import assert from "node:assert/strict";
import test from "node:test";
import worker from "../worker.ts";

function history() {
  return {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    exportedAt: "2026-07-30T00:00:00.000Z",
    conversation: { id: "conversation-1", title: "Worker test" },
    entries: [],
  };
}

function environment(bucket) {
  return {
    ASSETS: { fetch: () => new Response("asset") },
    THREADSHARE_BUCKET: bucket,
  };
}

test("reads a share when the UUID uses uppercase hex", async () => {
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
  };
  const env = environment(bucket);
  const created = await worker.fetch(
    new Request("https://threadshare.invalid/api/v1/shares", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(history()),
    }),
    env,
  );
  const { id } = await created.json();

  const loaded = await worker.fetch(
    new Request(`https://threadshare.invalid/api/v1/shares/${id.toUpperCase()}`),
    env,
  );

  assert.equal(loaded.status, 200);
  assert.equal(loaded.headers.get("cache-control"), "private, no-store");
  assert.deepEqual(await loaded.json(), history());
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
