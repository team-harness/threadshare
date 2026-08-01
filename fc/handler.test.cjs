const assert = require("node:assert/strict");
const test = require("node:test");

const { createHandler } = require("./dist/index.cjs");

const NOW = Date.parse("2026-08-01T10:00:00.000Z");

const environment = {
  THREADSHARE_OSS_ACCESS_KEY_ID: "test-key",
  THREADSHARE_OSS_ACCESS_KEY_SECRET: "test-secret",
  THREADSHARE_OSS_BUCKET: "test-bucket",
  THREADSHARE_OSS_REGION: "cn-shanghai",
};

function createTestHandler(options = {}) {
  const objects = new Map();
  const requests = [];
  const defaultFetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    const key = new URL(url).pathname.slice(1);
    if (init.method === "PUT") {
      objects.set(key, init.body);
      return new Response(null, { status: 200 });
    }
    if (init.method === "DELETE") {
      objects.delete(key);
      return new Response(null, { status: 204 });
    }
    const value = objects.get(key);
    return value === undefined
      ? new Response(null, { status: 404 })
      : new Response(value, { status: 200, headers: { "content-type": "application/json" } });
  };
  const fetchImpl = options.fetchImpl ?? defaultFetchImpl;
  return {
    handler: createHandler({
      environment,
      fetchImpl,
      logger: options.logger,
      now: options.now,
      assets: {
        "/index.html": {
          body: Buffer.from("<main>Threadshare</main>").toString("base64"),
          contentType: "text/html; charset=utf-8",
        },
      },
    }),
    objects,
    requests,
  };
}

function history() {
  return {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    exportedAt: "2026-07-29T00:00:00.000Z",
    conversation: { id: "conversation-1", title: "FC test" },
    entries: [],
  };
}

test("writes a validated history to the generated OSS key and reads it back", async () => {
  const { handler, objects, requests } = createTestHandler({ now: () => NOW });
  const created = await handler({
    rawPath: "/api/v1/shares",
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(history()),
  });

  assert.equal(created.statusCode, 201);
  const { id } = JSON.parse(created.body);
  assert.match(id, /^[0-9a-f-]{36}$/i);
  assert.deepEqual(JSON.parse(objects.get(`shares/${id}.json`)), {
    format: "threadshare-object@v1",
    createdAt: "2026-08-01T10:00:00.000Z",
    history: history(),
  });
  assert.equal(requests[0].init.headers["content-type"], "application/json; charset=utf-8");

  const loaded = await handler({
    rawPath: `/api/v1/shares/${id.toUpperCase()}`,
    httpMethod: "GET",
  });
  assert.equal(loaded.statusCode, 200);
  assert.deepEqual(loaded.headers, {
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
    "access-control-allow-origin": "*",
    "access-control-expose-headers": "x-threadshare-expires-at",
  });
  assert.deepEqual(JSON.parse(loaded.body.toString("utf8")), history());
});

test("reads an old bare history object without lifecycle metadata", async () => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const { handler, objects } = createTestHandler({ now: () => NOW });
  objects.set(`shares/${id}.json`, JSON.stringify(history()));

  const loaded = await handler({
    rawPath: `/api/v1/shares/${id}`,
    httpMethod: "GET",
  });

  assert.equal(loaded.statusCode, 200);
  assert.equal(loaded.headers["x-threadshare-expires-at"], undefined);
  assert.deepEqual(JSON.parse(loaded.body.toString("utf8")), history());
});

test("stores expiration metadata and lazily deletes at the boundary", async () => {
  let currentTime = NOW;
  const { handler, objects, requests } = createTestHandler({ now: () => currentTime });
  const created = await handler({
    rawPath: "/api/v1/shares",
    httpMethod: "POST",
    headers: {
      "content-type": "application/json",
      "x-threadshare-expires-in": "60",
    },
    body: JSON.stringify(history()),
  });

  assert.equal(created.statusCode, 201);
  const { id, expiresAt } = JSON.parse(created.body);
  assert.equal(expiresAt, "2026-08-01T10:01:00.000Z");
  assert.equal(JSON.parse(objects.get(`shares/${id}.json`)).expiresAt, expiresAt);

  const readable = await handler({
    rawPath: `/api/v1/shares/${id}`,
    httpMethod: "GET",
  });
  assert.equal(readable.statusCode, 200);
  assert.equal(readable.headers["x-threadshare-expires-at"], expiresAt);

  currentTime += 60_000;
  const expired = await handler({
    rawPath: `/api/v1/shares/${id}`,
    httpMethod: "GET",
  });
  assert.equal(expired.statusCode, 404);
  assert.deepEqual(JSON.parse(expired.body), { error: "Shared history was not found" });
  assert.equal(objects.has(`shares/${id}.json`), false);
  assert.equal(requests.at(-1).init.method, "DELETE");
});

test("keeps an expired share unavailable when OSS lazy deletion fails", async () => {
  const errors = [];
  const raw = JSON.stringify({
    format: "threadshare-object@v1",
    createdAt: "2026-08-01T09:59:00.000Z",
    expiresAt: "2026-08-01T10:00:00.000Z",
    history: history(),
  });
  const { handler } = createTestHandler({
    now: () => NOW,
    logger: { error: (...args) => errors.push(args) },
    fetchImpl: async (_url, init = {}) =>
      init.method === "DELETE"
        ? new Response(null, { status: 500 })
        : new Response(raw, { status: 200 }),
  });

  const response = await handler({
    rawPath: "/api/v1/shares/a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0",
    httpMethod: "GET",
  });
  assert.equal(response.statusCode, 404);
  assert.deepEqual(JSON.parse(response.body), { error: "Shared history was not found" });
  assert.equal(errors.length, 1);
});

test("rejects invalid expiration before writing to OSS", async () => {
  const { handler, requests } = createTestHandler();
  const response = await handler({
    rawPath: "/api/v1/shares",
    httpMethod: "POST",
    headers: {
      "content-type": "application/json",
      "x-threadshare-expires-in": "31536001",
    },
    body: JSON.stringify(history()),
  });

  assert.equal(response.statusCode, 400);
  assert.equal(requests.length, 0);
});

test("matches the canonical RFC 3339 timestamp contract", async () => {
  const { handler } = createTestHandler();
  const offsetHistory = history();
  offsetHistory.exportedAt = "2026-07-30T08:00:00+08:00";
  const accepted = await handler({
    rawPath: "/api/v1/shares",
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(offsetHistory),
  });

  const missingSeconds = history();
  missingSeconds.exportedAt = "2026-07-30T08:00Z";
  const rejected = await handler({
    rawPath: "/api/v1/shares",
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(missingSeconds),
  });

  assert.equal(accepted.statusCode, 201);
  assert.equal(rejected.statusCode, 400);
});

test("rejects a declared oversized body before reading it", async () => {
  const { handler } = createTestHandler();
  let bodyRead = false;
  const event = {
    rawPath: "/api/v1/shares",
    httpMethod: "POST",
    headers: {
      "content-length": String(5 * 1024 * 1024 + 1),
      "content-type": "application/json",
    },
  };
  Object.defineProperty(event, "body", {
    get() {
      bodyRead = true;
      throw new Error("body should not be read");
    },
  });

  const response = await handler(event);

  assert.equal(response.statusCode, 413);
  assert.equal(bodyRead, false);
});

test("logs storage failures while returning a stable JSON error", async () => {
  const errors = [];
  const { handler } = createTestHandler({
    logger: { error: (...args) => errors.push(args) },
    fetchImpl: async () => new Response(null, { status: 500 }),
  });

  const writeResponse = await handler({
    rawPath: "/api/v1/shares",
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(history()),
  });
  const readResponse = await handler({
    rawPath: "/api/v1/shares/a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0",
    httpMethod: "GET",
  });

  assert.equal(writeResponse.statusCode, 500);
  assert.deepEqual(JSON.parse(writeResponse.body), { error: "Unable to process shared history" });
  assert.equal(readResponse.statusCode, 500);
  assert.deepEqual(JSON.parse(readResponse.body), { error: "Unable to process shared history" });
  assert.equal(errors.length, 2);
});

test("accepts the legacy Paseo v1 shape during migration", async () => {
  const { handler, objects } = createTestHandler({ now: () => NOW });
  const legacyHistory = history();
  delete legacyHistory.format;

  const created = await handler({
    rawPath: "/api/v1/shares",
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(legacyHistory),
  });

  assert.equal(created.statusCode, 201);
  const { id } = JSON.parse(created.body);
  assert.deepEqual(JSON.parse(objects.get(`shares/${id}.json`)), {
    format: "threadshare-object@v1",
    createdAt: "2026-08-01T10:00:00.000Z",
    history: legacyHistory,
  });
});

test("rejects an arbitrary upload before it reaches OSS", async () => {
  const { handler, requests } = createTestHandler();
  const response = await handler({
    rawPath: "/api/v1/shares",
    httpMethod: "POST",
    headers: { "content-type": "text/plain" },
    body: "not a shared history",
  });

  assert.equal(response.statusCode, 415);
  assert.deepEqual(JSON.parse(response.body), { error: "Content-Type must be application/json" });
  assert.equal(requests.length, 0);
});

test("serves the viewer from the same FC origin", async () => {
  const { handler } = createTestHandler();
  const response = await handler({ rawPath: "/", httpMethod: "GET" });

  assert.equal(response.statusCode, 200);
  assert.equal(response.headers["content-type"], "text/html; charset=utf-8");
  assert.equal(response.body.toString("utf8"), "<main>Threadshare</main>");
});
