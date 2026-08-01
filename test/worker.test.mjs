import assert from "node:assert/strict";
import test from "node:test";
import worker, { createWorker } from "../worker.ts";
import { createStoredShare } from "../src/stored-share.ts";

const NOW = Date.parse("2026-08-01T10:00:00.000Z");

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

test("expires at the boundary and keeps 404 when lazy deletion fails", async (t) => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const raw = JSON.stringify(createStoredShare(history(), NOW - 60_000, 60));

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

test("rejects invalid expiration before writing to R2", async () => {
  let writes = 0;
  const response = await worker.fetch(
    new Request("https://threadshare.invalid/api/v1/shares", {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "x-threadshare-expires-in": "59",
      },
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
