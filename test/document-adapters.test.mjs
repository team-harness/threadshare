import assert from "node:assert/strict";
import test from "node:test";
import { createHmac } from "node:crypto";
import { createWorker } from "../worker.ts";
import { createHandler } from "../fc/handler.ts";
import { documentOssStore } from "../fc/document-oss-store.ts";
import { sha256, documentModel } from "../src/document-model.mjs";
import {
  sweepDocuments,
  createDocumentService,
} from "../src/document-service.mjs";
import { memoryStore } from "./helpers/document-store.mjs";

function r2(store) {
  return {
    async get(key) {
      const value = await store.get(key);
      return value ? { body: new Response(value).body } : null;
    },
    async put(key, value, options) {
      assert.equal(options.onlyIf?.etagDoesNotMatch, "*");
      return (await store.create(key, value)) ? { key } : null;
    },
    async list({ prefix, cursor, limit }) {
      const page = await store.list(prefix, cursor, limit);
      return {
        objects: page.keys.map((key) => ({ key })),
        truncated: !!page.cursor,
        cursor: page.cursor,
      };
    },
    async delete(key) {
      await store.delete(key);
    },
  };
}
const env = {
  THREADSHARE_OSS_BUCKET: "test",
  THREADSHARE_OSS_REGION: "test",
  THREADSHARE_OSS_ACCESS_KEY_ID: "id",
  THREADSHARE_OSS_ACCESS_KEY_SECRET: "secret",
};
function ossFetch(store) {
  return async (url, options) => {
    const target = new URL(url);
    const key = decodeURIComponent(target.pathname.slice(1));
    const headers = options.headers;
    const immutable = headers["x-oss-forbid-overwrite"] === "true";
    const signed = [
      options.method,
      "",
      headers["content-type"] ?? "",
      headers.date,
      `${immutable ? "x-oss-forbid-overwrite:true\n" : ""}/test/${key}`,
    ].join("\n");
    assert.equal(
      headers.authorization,
      `OSS id:${createHmac("sha1", "secret").update(signed).digest("base64")}`,
    );
    if (!key) {
      const page = await store.list(
        target.searchParams.get("prefix"),
        target.searchParams.get("marker"),
        Number(target.searchParams.get("max-keys")),
      );
      return new Response(
        `<ListBucketResult>${page.keys.map((key) => `<Contents><Key>${key}</Key></Contents>`).join("")}<IsTruncated>${!!page.cursor}</IsTruncated>${page.cursor ? `<NextMarker>${page.cursor}</NextMarker>` : ""}</ListBucketResult>`,
      );
    }
    if (options.method === "GET") {
      const data = await store.get(key);
      return new Response(data, { status: data ? 200 : 404 });
    }
    if (options.method === "PUT") {
      assert.equal(immutable, true);
      return (await store.create(key, options.body))
        ? new Response(null, { status: 200 })
        : new Response("<Error><Code>FileAlreadyExists</Code></Error>", {
            status: 409,
          });
    }
    if (options.method === "DELETE") {
      await store.delete(key);
      return new Response(null, { status: 204 });
    }
    throw new Error("unexpected storage request");
  };
}
for (const adapter of ["r2", "oss"])
  test(`${adapter}: binary upload, JSON/Agent reads, concurrent reviews and expiry`, async () => {
    const store = memoryStore();
    let time = Date.now();
    let fetchAdapter;
    if (adapter === "r2") {
      const worker = createWorker({ now: () => time });
      fetchAdapter = (request) =>
        worker.fetch(request, {
          THREADSHARE_BUCKET: r2(store),
          ASSETS: { fetch: async () => new Response("<html>viewer</html>") },
        });
    } else {
      const handler = createHandler({
        environment: env,
        fetchImpl: ossFetch(store),
        now: () => time,
      });
      fetchAdapter = async (request) => {
        const url = new URL(request.url);
        const response = await handler({
          httpMethod: request.method,
          path: url.pathname,
          rawQueryString: url.search.slice(1),
          headers: { host: url.host, ...Object.fromEntries(request.headers) },
          body: Buffer.from(await request.arrayBuffer()).toString("base64"),
          isBase64Encoded: true,
        });
        return new Response(
          response.statusCode === 204 ? null : response.body,
          { status: response.statusCode, headers: response.headers },
        );
      };
    }
    const call = (path, method = "GET", body, token) =>
      fetchAdapter(
        new Request(`https://test.local${path}`, {
          method,
          headers: {
            "content-type":
              typeof body === "string" ? "text/markdown" : "application/json",
            ...(token ? { authorization: `Bearer ${token}` } : {}),
          },
          body:
            body === undefined
              ? undefined
              : typeof body === "string"
                ? body
                : JSON.stringify(body),
        }),
      );
    const content = "# Adapter\n\n![diagram](diagram.png)\n\nHello **world**.";
    const image = Buffer.from(
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=",
      "base64",
    );
    const imageDigest = await sha256(image);
    const root = "/api/v1/documents";
    const upload = await (
      await call(`${root}/uploads`, "POST", {
        title: "Adapter",
        markdown: {
          sha256: await sha256(content),
          bytes: Buffer.byteLength(content),
        },
        assets: [
          {
            source: "diagram.png",
            sha256: imageDigest,
            bytes: image.length,
            contentType: "image/png",
          },
        ],
        expiresInSeconds: 60,
      })
    ).json();
    assert.ok(upload.id);
    assert.equal(
      (
        await call(
          `${root}/${upload.id}/uploads/markdown`,
          "PUT",
          content,
          upload.uploadToken,
        )
      ).status,
      204,
    );
    assert.equal(
      (
        await fetchAdapter(
          new Request(
            `https://test.local${root}/${upload.id}/uploads/assets/${imageDigest}`,
            {
              method: "PUT",
              headers: {
                authorization: `Bearer ${upload.uploadToken}`,
                "content-type": "image/png",
              },
              body: image,
            },
          ),
        )
      ).status,
      204,
    );
    assert.equal(
      (
        await call(
          `${root}/${upload.id}/publish`,
          "POST",
          undefined,
          upload.uploadToken,
        )
      ).status,
      201,
    );
    const doc = await (await call(`${root}/${upload.id}`)).json();
    assert.deepEqual(
      Buffer.from(
        await (
          await call(`${root}/${upload.id}/assets/${imageDigest}`)
        ).arrayBuffer(),
      ),
      image,
    );
    const text = documentModel(content).text;
    const start = text.indexOf("world");
    const input = {
      revision: doc.revision,
      authorName: "<script>x</script>",
      body: "Review it",
      anchor: {
        textVersion: "document-anchor-text@1",
        start,
        end: start + 5,
        exact: "world",
        prefix: text.slice(0, start),
        suffix: ".",
      },
    };
    const ids = Array.from({ length: 20 }, () => crypto.randomUUID());
    const results = await Promise.all(
      ids.map((id) =>
        call(`${root}/${upload.id}/comments/${id}`, "PUT", input),
      ),
    );
    assert.ok(results.every((response) => response.status === 201));
    const page = await (
      await call(`${root}/${upload.id}/comments?limit=5`)
    ).json();
    assert.equal(page.comments.length, 5);
    assert.ok(page.nextCursor);
    assert.equal(
      (
        await (
          await call(
            `${root}/${upload.id}/comments?limit=100&cursor=${encodeURIComponent(page.nextCursor)}`,
          )
        ).json()
      ).comments.length,
      15,
    );
    const agent = await call(`/document.html?id=${upload.id}&format=agent`);
    assert.equal(agent.status, 200);
    assert.match(agent.headers.get("content-type"), /text\/markdown/);
    assert.match(await agent.text(), /Review it/);
    assert.equal(
      (await call(`${root}/${upload.id}/comments/${ids[0]}`, "PUT", input))
        .status,
      200,
    );
    time += 60000;
    assert.equal((await call(`${root}/${upload.id}`)).status, 404);
    await sweepDocuments(store, { now: () => time });
    assert.equal(await store.get(`documents/${upload.id}/markdown.txt`), null);
    assert.ok(await store.get(`documents/${upload.id}/revoked.json`));
  });

test("OSS does not misclassify an unrelated 409 as an idempotent create", async () => {
  const store = documentOssStore(
    env,
    async () =>
      new Response("<Error><Code>FileImmutable</Code></Error>", {
        status: 409,
      }),
  );
  await assert.rejects(
    store.create("documents/test/a", "x", "text/plain"),
    /create failed/,
  );
});
test("bounded maintenance eventually visits later uploads and never revives expired drafts", async () => {
  const store = memoryStore();
  let time = 100000;
  const service = createDocumentService(store, { now: () => time });
  for (let i = 0; i < 8; i++) {
    const upload = await (
      await service(
        new Request("https://test.local/api/v1/documents/uploads", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({
            title: "Draft",
            markdown: { sha256: await sha256("a"), bytes: 1 },
            assets: [],
          }),
        }),
      )
    ).json();
    await store.create(`documents/${upload.id}/markdown.txt`, "a");
  }
  time += 3600001;
  const first = await sweepDocuments(store, { now: () => time, batchSize: 5 });
  assert.ok(first.cursor);
  const last = await sweepDocuments(store, {
    now: () => time,
    cursor: first.cursor,
  });
  assert.equal(last.cursor, null);
  assert.equal(
    [...store.data.keys()].filter((key) => key.endsWith("/markdown.txt"))
      .length,
    0,
  );
  time += 86400001;
  await sweepDocuments(store, { now: () => time });
  assert.equal(
    [...store.data.keys()].filter((key) =>
      key.startsWith("document-maintenance/"),
    ).length,
    0,
  );
  assert.equal(
    [...store.data.keys()].filter((key) => key.endsWith("/revoked.json"))
      .length,
    8,
  );
});

test("FC public origin configuration supports HTTP gateways without trusting browser Origin", async () => {
  const handler = createHandler({
    environment: { ...env, THREADSHARE_PUBLIC_ORIGIN: "http://public.test" },
    fetchImpl: ossFetch(memoryStore()),
  });
  const event = {
    httpMethod: "POST",
    rawPath: "/api/v1/documents/uploads",
    headers: {
      host: "internal.test",
      origin: "http://public.test",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      title: "Doc",
      markdown: { sha256: await sha256("x"), bytes: 1 },
      assets: [],
    }),
  };
  assert.equal((await handler(event)).statusCode, 201);
  assert.equal(
    (
      await handler({
        ...event,
        headers: { ...event.headers, origin: "http://attacker.test" },
      })
    ).statusCode,
    403,
  );
});

test("cleanup checkpoints each entry and skips corrupt metadata without starving later entries", async () => {
  const store = memoryStore();
  const first = "00000000-0000-4000-8000-000000000001",
    second = "00000000-0000-4000-8000-000000000002";
  for (const id of [first, second])
    await store.create(`document-maintenance/${id}.json`, "{}");
  await store.create(`documents/${first}/upload.json`, "broken json");
  await store.create(
    `documents/${second}/upload.json`,
    JSON.stringify({ uploadExpiresAt: new Date(0).toISOString() }),
  );
  await store.create(`documents/${second}/markdown.txt`, "expired");
  const checkpoints = [];
  const result = await sweepDocuments(store, {
    onProgress: async (cursor) => checkpoints.push(cursor),
    logger: { error() {} },
  });
  assert.equal(result.failed, 1);
  assert.equal(checkpoints.length, 2);
  assert.equal(checkpoints[0], `document-maintenance/${first}.json`);
  assert.equal(checkpoints[1], null);
  assert.equal(await store.get(`documents/${second}/markdown.txt`), null);

  const list = store.list.bind(store);
  let saved = null,
    calls = 0;
  store.list = async (...args) => {
    if (args[0] === "document-maintenance/" && ++calls === 2)
      throw new Error("Storage offline");
    return list(...args);
  };
  await assert.rejects(
    sweepDocuments(store, {
      onProgress: async (cursor) => {
        saved = cursor;
      },
      logger: { error() {} },
    }),
    /Storage offline/,
  );
  assert.equal(saved, `document-maintenance/${first}.json`);
  store.list = list;
  const resumed = await sweepDocuments(store, {
    cursor: saved,
    logger: { error() {} },
  });
  assert.equal(resumed.cursor, null);
  assert.equal(resumed.failed, 0);
});
