const assert = require("node:assert/strict");
const { createHash } = require("node:crypto");
const test = require("node:test");

const { createHandler } = require("./dist/index.cjs");

const NOW = Date.parse("2026-08-01T10:00:00.000Z");
const REVOKE_TOKEN = Buffer.alloc(32, 17).toString("base64url");
const WRONG_REVOKE_TOKEN = Buffer.alloc(32, 18).toString("base64url");
const REVOKE_DIGEST = createHash("sha256").update(REVOKE_TOKEN).digest("base64url");

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
      assets: options.assets ?? {
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

test("stores only a revoke digest and deletes with the matching bearer capability", async () => {
  const { handler, objects, requests } = createTestHandler({ now: () => NOW });
  const created = await handler({
    rawPath: "/api/v1/shares",
    httpMethod: "POST",
    headers: {
      "content-type": "application/json",
      "x-threadshare-revoke-token-sha256": REVOKE_DIGEST,
    },
    body: JSON.stringify(history()),
  });

  assert.equal(created.statusCode, 201);
  const payload = JSON.parse(created.body);
  assert.equal(payload.revocable, true);
  const key = `shares/${payload.id}.json`;
  const raw = objects.get(key);
  assert.equal(JSON.parse(raw).revokeTokenSha256, REVOKE_DIGEST);
  assert.doesNotMatch(raw, new RegExp(REVOKE_TOKEN));

  const wrong = await handler({
    rawPath: `/api/v1/shares/${payload.id}`,
    httpMethod: "DELETE",
    headers: { authorization: `Bearer ${WRONG_REVOKE_TOKEN}` },
  });
  assert.equal(wrong.statusCode, 404);
  assert.equal(wrong.headers["access-control-allow-origin"], undefined);
  assert.equal(objects.has(key), true);
  assert.equal(requests.at(-1).init.method, undefined);

  const revoked = await handler({
    rawPath: `/api/v1/shares/${payload.id}`,
    httpMethod: "DELETE",
    headers: { authorization: `Bearer ${REVOKE_TOKEN}` },
  });
  assert.equal(revoked.statusCode, 204);
  assert.equal(revoked.headers["access-control-allow-origin"], undefined);
  assert.equal(objects.has(key), false);
  assert.deepEqual(requests.slice(-2).map((request) => request.init.method), [undefined, "DELETE"]);
});

test("hides missing capabilities and lets a valid capability revoke an expired share", async () => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const key = `shares/${id}.json`;
  const { handler, objects } = createTestHandler({ now: () => NOW });
  objects.set(
    key,
    JSON.stringify({
      format: "threadshare-object@v1",
      createdAt: "2026-08-01T09:59:00.000Z",
      expiresAt: "2026-08-01T10:00:00.000Z",
      revokeTokenSha256: REVOKE_DIGEST,
      history: history(),
    }),
  );

  for (const authorization of [undefined, "Bearer short"]) {
    const response = await handler({
      rawPath: `/api/v1/shares/${id}`,
      httpMethod: "DELETE",
      ...(authorization ? { headers: { authorization } } : {}),
    });
    assert.equal(response.statusCode, 404);
    assert.deepEqual(JSON.parse(response.body), { error: "Shared history was not found" });
    assert.equal(objects.has(key), true);
  }

  const revoked = await handler({
    rawPath: `/api/v1/shares/${id}`,
    httpMethod: "DELETE",
    headers: { authorization: `Bearer ${REVOKE_TOKEN}` },
  });
  assert.equal(revoked.statusCode, 204);
  assert.equal(objects.has(key), false);

  objects.set(key, JSON.stringify(history()));
  const oldObject = await handler({
    rawPath: `/api/v1/shares/${id}`,
    httpMethod: "DELETE",
    headers: { authorization: `Bearer ${REVOKE_TOKEN}` },
  });
  assert.equal(oldObject.statusCode, 404);
  assert.equal(objects.has(key), true);
});

test("keeps DELETE storage failures outside the browser CORS contract", async () => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const errors = [];
  const raw = JSON.stringify({
    format: "threadshare-object@v1",
    createdAt: "2026-08-01T10:00:00.000Z",
    revokeTokenSha256: REVOKE_DIGEST,
    history: history(),
  });
  const { handler } = createTestHandler({
    logger: { error: (...args) => errors.push(args) },
    fetchImpl: async (_url, init = {}) =>
      init.method === "DELETE"
        ? new Response(null, { status: 500 })
        : new Response(raw, { status: 200 }),
  });

  const response = await handler({
    rawPath: `/api/v1/shares/${id}`,
    httpMethod: "DELETE",
    headers: { authorization: `Bearer ${REVOKE_TOKEN}` },
  });
  assert.equal(response.statusCode, 500);
  assert.equal(response.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(JSON.parse(response.body), { error: "Unable to process shared history" });
  assert.equal(errors.length, 1);
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

test("rejects invalid lifecycle headers before writing to OSS", async () => {
  for (const headers of [
    { "x-threadshare-expires-in": "31536001" },
    { "x-threadshare-revoke-token-sha256": "not-a-digest" },
  ]) {
    const { handler, requests } = createTestHandler();
    const response = await handler({
      rawPath: "/api/v1/shares",
      httpMethod: "POST",
      headers: { "content-type": "application/json", ...headers },
      body: JSON.stringify(history()),
    });

    assert.equal(response.statusCode, 400);
    assert.equal(requests.length, 0);
  }
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
  assert.equal(response.headers["content-disposition"], "inline");
  assert.equal(response.body.toString("utf8"), "<main>Threadshare</main>");
});

test("negotiates the Agent transcript across FC query and list-valued Accept shapes", async () => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const shared = history();
  shared.entries.push({
    id: "message-1",
    createdAt: "2026-08-01T09:59:00.000Z",
    kind: "message",
    role: "user",
    markdown: "Review this.",
  });
  const { handler, objects, requests } = createTestHandler({ now: () => NOW });
  objects.set(
    `shares/${id}.json`,
    JSON.stringify({
      format: "threadshare-object@v1",
      createdAt: "2026-08-01T10:00:00.000Z",
      expiresAt: "2026-08-01T10:01:00.000Z",
      history: shared,
    }),
  );
  const events = [
    { rawPath: "/", rawQueryString: `id=${id}&format=agent` },
    { rawPath: "/", queryParameters: { id, format: "agent" } },
    { rawPath: "/", queries: { id: [id, "ignored"], format: ["agent"] } },
    { rawPath: `/?id=${id}&format=agent` },
    {
      rawPath: "/",
      queryParameters: { id },
      headers: { Accept: ["text/html;q=0.7"], accept: ["text/markdown;q=0.8"] },
    },
  ];
  let expectedBody;
  for (const event of events) {
    const response = await handler({ httpMethod: "GET", ...event });
    assert.equal(response.statusCode, 200);
    assert.equal(response.headers["content-type"], "text/markdown; charset=utf-8");
    assert.equal(response.headers["content-disposition"], "inline");
    assert.equal(response.headers["cache-control"], "private, no-store");
    assert.equal(response.headers.vary, "Accept");
    assert.equal(response.headers["x-threadshare-format"], "agent-transcript@v1");
    assert.equal(response.headers["x-threadshare-expires-at"], "2026-08-01T10:01:00.000Z");
    const body = response.body.toString("utf8");
    assert.match(body, /^# Threadshare Agent Transcript v1$/m);
    assert.match(body, /^> Review this\.$/m);
    expectedBody ??= body;
    assert.equal(body, expectedBody);
  }
  assert.equal(requests.length, events.length);

  const ignoredLowerPriority = await handler({
    rawPath: `/?id=${id}&format=agent`,
    rawQueryString: "",
    queryParameters: { id, format: "agent" },
    httpMethod: "GET",
    headers: { accept: "text/markdown" },
  });
  assert.equal(ignoredLowerPriority.statusCode, 404);
  assert.match(ignoredLowerPriority.body, /Shared conversation was not found/);
  assert.equal(requests.length, events.length);

  const head = await handler({
    rawPath: "/index.html",
    rawQueryString: `id=${id}&format=agent`,
    httpMethod: "HEAD",
  });
  assert.equal(head.statusCode, 200);
  assert.equal(head.body, undefined);

  const canonical = await handler({
    rawPath: `/api/v1/shares/${id}`,
    httpMethod: "GET",
    headers: { accept: "text/markdown" },
  });
  assert.deepEqual(JSON.parse(canonical.body.toString("utf8")), shared);
  assert.equal(canonical.headers["content-type"], "application/json; charset=utf-8");
  assert.equal(canonical.headers.vary, undefined);
  assert.equal(canonical.headers["x-threadshare-format"], undefined);
});

test("serves no-store Viewer HTML with alternate discovery and explicit 405 responses", async () => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const { handler, requests } = createTestHandler({
    assets: {
      "/index.html": {
        body: Buffer.from("<main>Threadshare</main>").toString("base64"),
        contentType: "text/html; charset=utf-8",
        headers: { Vary: "Origin", Link: '</existing>; rel="preload"' },
      },
    },
  });
  const html = await handler({
    rawPath: "/",
    rawQueryString: `id=${id}`,
    httpMethod: "GET",
    headers: { accept: "text/html" },
  });
  assert.equal(html.statusCode, 200);
  assert.equal(html.headers["cache-control"], "no-store");
  assert.equal(html.headers["content-disposition"], "inline");
  assert.equal(html.headers.vary, "Origin, Accept");
  assert.equal(
    html.headers.link,
    `</existing>; rel="preload", </?id=${id}&format=agent>; rel="alternate"; type="text/markdown"`,
  );
  assert.equal(html.headers.Vary, undefined);
  assert.equal(html.headers.Link, undefined);
  assert.equal(requests.length, 0);

  const agentMethod = await handler({
    rawPath: "/",
    rawQueryString: "format=agent",
    httpMethod: "POST",
  });
  assert.equal(agentMethod.statusCode, 405);
  assert.equal(agentMethod.headers.allow, "GET, HEAD");
  assert.equal(agentMethod.headers.vary, "Accept");
  assert.match(agentMethod.body, /Error: Method not allowed\./);

  const htmlMethod = await handler({ rawPath: "/", httpMethod: "POST" });
  assert.equal(htmlMethod.statusCode, 405);
  assert.equal(htmlMethod.headers.allow, "GET, HEAD");
  assert.equal(htmlMethod.headers["cache-control"], "no-store");
  assert.equal(htmlMethod.headers.vary, "Accept");
  assert.equal(htmlMethod.headers["access-control-allow-origin"], undefined);
  assert.deepEqual(JSON.parse(htmlMethod.body), { error: "Method not allowed" });
});

test("returns stable Agent 404 and 500 problems without leaking storage details", async () => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const missing = createTestHandler();
  const missingResponse = await missing.handler({
    rawPath: "/",
    rawQueryString: `id=${id}&format=agent`,
    httpMethod: "GET",
  });
  assert.equal(missingResponse.statusCode, 404);
  assert.equal(missingResponse.headers["x-threadshare-format"], "agent-transcript@v1");
  assert.match(missingResponse.body, /Shared conversation was not found/);

  const errors = [];
  const failed = createTestHandler({
    logger: { error: (...args) => errors.push(args) },
    fetchImpl: async () => new Response("private OSS failure", { status: 500 }),
  });
  const failedResponse = await failed.handler({
    rawPath: "/",
    rawQueryString: `id=${id}&format=agent`,
    httpMethod: "GET",
  });
  assert.equal(failedResponse.statusCode, 500);
  assert.match(failedResponse.body, /Unable to load shared conversation/);
  assert.doesNotMatch(failedResponse.body, /private OSS failure/);
  assert.equal(errors.length, 1);
});

test("keeps legacy and expiration behavior on the FC Agent Viewer path", async () => {
  const id = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";
  const legacy = history();
  delete legacy.format;
  const legacyFixture = createTestHandler({ now: () => NOW });
  legacyFixture.objects.set(`shares/${id}.json`, JSON.stringify(legacy));
  const legacyResponse = await legacyFixture.handler({
    rawPath: "/",
    rawQueryString: `id=${id}&format=agent`,
    httpMethod: "GET",
  });
  assert.equal(legacyResponse.statusCode, 200);
  assert.match(legacyResponse.body, /^# Threadshare Agent Transcript v1$/m);

  const expiredFixture = createTestHandler({ now: () => NOW });
  expiredFixture.objects.set(
    `shares/${id}.json`,
    JSON.stringify({
      format: "threadshare-object@v1",
      createdAt: "2026-08-01T09:59:00.000Z",
      expiresAt: "2026-08-01T10:00:00.000Z",
      history: history(),
    }),
  );
  const expiredResponse = await expiredFixture.handler({
    rawPath: "/",
    rawQueryString: `id=${id}&format=agent`,
    httpMethod: "GET",
  });
  assert.equal(expiredResponse.statusCode, 404);
  assert.match(expiredResponse.body, /Shared conversation was not found/);
  assert.equal(expiredFixture.objects.size, 0);
  assert.equal(expiredFixture.requests.at(-1).init.method, "DELETE");
});
