const assert = require("node:assert/strict");
const test = require("node:test");

const { createHandler } = require("./dist/index.cjs");

const environment = {
  THREADSHARE_OSS_ACCESS_KEY_ID: "test-key",
  THREADSHARE_OSS_ACCESS_KEY_SECRET: "test-secret",
  THREADSHARE_OSS_BUCKET: "test-bucket",
  THREADSHARE_OSS_REGION: "cn-shanghai",
};

function createTestHandler() {
  const objects = new Map();
  const requests = [];
  const fetchImpl = async (url, init = {}) => {
    requests.push({ url, init });
    const key = new URL(url).pathname.slice(1);
    if (init.method === "PUT") {
      objects.set(key, init.body);
      return new Response(null, { status: 200 });
    }
    const value = objects.get(key);
    return value === undefined
      ? new Response(null, { status: 404 })
      : new Response(value, { status: 200, headers: { "content-type": "application/json" } });
  };
  return {
    handler: createHandler({
      environment,
      fetchImpl,
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
  const { handler, objects, requests } = createTestHandler();
  const created = await handler({
    rawPath: "/api/v1/shares",
    httpMethod: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(history()),
  });

  assert.equal(created.statusCode, 201);
  const { id } = JSON.parse(created.body);
  assert.match(id, /^[0-9a-f-]{36}$/i);
  assert.equal(objects.get(`shares/${id}.json`), JSON.stringify(history()));
  assert.equal(requests[0].init.headers["content-type"], "application/json; charset=utf-8");

  const loaded = await handler({
    rawPath: `/api/v1/shares/${id}`,
    httpMethod: "GET",
  });
  assert.equal(loaded.statusCode, 200);
  assert.deepEqual(JSON.parse(loaded.body.toString("utf8")), history());
});

test("accepts the legacy Paseo v1 shape during migration", async () => {
  const { handler, objects } = createTestHandler();
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
  assert.equal(objects.get(`shares/${id}.json`), JSON.stringify(legacyHistory));
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
