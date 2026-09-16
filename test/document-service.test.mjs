import test from "node:test";
import assert from "node:assert/strict";
import {
  createDocumentService,
  sweepDocuments,
} from "../src/document-service.mjs";
import {
  collectDocumentReviews,
  documentAgentResponse,
} from "../src/document-read.mjs";
import Ajv from "ajv";
import addFormats from "ajv-formats";
import { readFile } from "node:fs/promises";
import { sha256, documentModel } from "../src/document-model.mjs";

import { memoryStore } from "./helpers/document-store.mjs";
const md = "# Design\n\nHello 😀 world.";
async function setup() {
  const store = memoryStore();
  const service = createDocumentService(store);
  const request = (path, method = "GET", body, token) =>
    service(
      new Request(`https://test.local/api/v1/documents${path}`, {
        method,
        headers: {
          "content-type": "application/json",
          ...(token ? { authorization: `Bearer ${token}` } : {}),
        },
        body: body === undefined ? undefined : JSON.stringify(body),
      }),
    );
  const declaration = {
    title: "Design",
    markdown: { sha256: await sha256(md), bytes: Buffer.byteLength(md) },
    assets: [],
    revokeTokenSha256: await sha256("r".repeat(43)),
  };
  const upload = await (await request("/uploads", "POST", declaration)).json();
  const raw = await service(
    new Request(
      `https://test.local/api/v1/documents/${upload.id}/uploads/markdown`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${upload.uploadToken}`,
          "content-type": "text/markdown",
        },
        body: md,
      },
    ),
  );
  assert.equal(raw.status, 204);
  assert.equal(
    (
      await request(
        `/${upload.id}/publish`,
        "POST",
        undefined,
        upload.uploadToken,
      )
    ).status,
    201,
  );
  return { store, service, request, upload };
}
test("publish, concurrent append, idempotent retry, anchor validation and revoke", async () => {
  const { request, upload } = await setup();
  const doc = await (await request(`/${upload.id}`)).json();
  const text = documentModel(md).text;
  const start = text.indexOf("Hello");
  const end = start + 5;
  const body = {
    revision: doc.revision,
    authorName: "Reviewer",
    body: "Explain this",
    anchor: {
      textVersion: "document-anchor-text@1",
      start,
      end,
      exact: "Hello",
      prefix: text.slice(0, start),
      suffix: text.slice(end),
    },
  };
  const ids = [crypto.randomUUID(), crypto.randomUUID()];
  const responses = await Promise.all(
    ids.map((id) => request(`/${upload.id}/comments/${id}`, "PUT", body)),
  );
  assert.deepEqual(
    responses.map((r) => r.status),
    [201, 201],
  );
  const retry = await request(`/${upload.id}/comments/${ids[0]}`, "PUT", body);
  assert.equal(retry.status, 200);
  assert.equal(
    (
      await request(`/${upload.id}/comments/${ids[0]}`, "PUT", {
        ...body,
        anchor: Object.fromEntries(Object.entries(body.anchor).reverse()),
      })
    ).status,
    200,
  );
  assert.equal(
    (
      await request(`/${upload.id}/comments/${ids[0]}`, "PUT", {
        ...body,
        body: "different",
      })
    ).status,
    409,
  );
  assert.equal(
    (
      await request(`/${upload.id}/comments/${crypto.randomUUID()}`, "PUT", {
        ...body,
        anchor: { ...body.anchor, start: 0 },
      })
    ).status,
    400,
  );
  const page = await (await request(`/${upload.id}/comments?limit=1`)).json();
  assert.equal(page.comments.length, 1);
  assert.ok(page.nextCursor);
  assert.equal(
    (
      await (
        await request(
          `/${upload.id}/comments?limit=1&cursor=${encodeURIComponent(page.nextCursor)}`,
        )
      ).json()
    ).comments.length,
    1,
  );
  assert.equal(
    (await request(`/${upload.id}`, "DELETE", undefined, "bad")).status,
    404,
  );
  assert.equal(
    (await request(`/${upload.id}`, "DELETE", undefined, "r".repeat(43)))
      .status,
    204,
  );
  assert.equal((await request(`/${upload.id}`)).status, 404);
  assert.equal(
    (
      await request(
        `/${upload.id}/publish`,
        "POST",
        undefined,
        upload.uploadToken,
      )
    ).status,
    404,
  );
  assert.equal((await request(`/${upload.id}/comments`)).status, 404);
});
test("review exports satisfy shipped schemas and identify bounded/continuation collections", async () => {
  const { request, service, upload } = await setup();
  const doc = await (await request(`/${upload.id}`)).json();
  const text = documentModel(md).text;
  for (let i = 0; i < 3; i++)
    await request(`/${upload.id}/comments/${crypto.randomUUID()}`, "PUT", {
      revision: doc.revision,
      authorName: "Test",
      body: `Feedback ${i}`,
      anchor: {
        textVersion: "document-anchor-text@1",
        start: 0,
        end: 6,
        exact: "Design",
        prefix: "",
        suffix: text.slice(6, 70),
      },
    });
  const location = {
    id: upload.id,
    base: "https://test.local",
    url: `https://test.local/document.html?id=${upload.id}`,
  };
  const first = await collectDocumentReviews(location, {
    fetchImpl: (url, options) => service(new Request(url, options)),
    maxComments: 2,
  });
  assert.equal(first.comments.length, 2);
  assert.equal(first.complete, false);
  assert.equal(first.hasMore, true);
  const next = await collectDocumentReviews(location, {
    fetchImpl: (url, options) => service(new Request(url, options)),
    initialCursor: first.nextCursor,
  });
  assert.equal(next.comments.length, 1);
  assert.equal(next.complete, false);
  assert.equal(next.hasMore, false);
  const ajv = new Ajv({ strict: true });
  addFormats(ajv);
  ajv.addSchema(
    JSON.parse(
      await readFile(
        new URL(
          "../schema/threadshare-document.v1.schema.json",
          import.meta.url,
        ),
      ),
    ),
  );
  const validate = ajv.compile(
    JSON.parse(
      await readFile(
        new URL(
          "../schema/threadshare-document-review.v1.schema.json",
          import.meta.url,
        ),
      ),
    ),
  );
  assert.equal(validate(first), true, JSON.stringify(validate.errors));
  assert.equal(validate(next), true, JSON.stringify(validate.errors));
});

test("revocation racing publication cannot resurrect the document", async () => {
  const { store, request, upload } = await setup();
  const create = store.create.bind(store);
  store.create = async (key, value, type) => {
    if (key.endsWith("/document.json"))
      await create(`documents/${upload.id}/revoked.json`, "{}");
    return create(key, value, type);
  };
  assert.equal(
    (
      await request(
        `/${upload.id}/publish`,
        "POST",
        undefined,
        upload.uploadToken,
      )
    ).status,
    404,
  );
  assert.equal((await request(`/${upload.id}`)).status, 404);
});

test("comment page reads are parallel but bounded to six storage requests", async () => {
  const { store, request, upload } = await setup();
  for (let i = 0; i < 20; i++)
    await store.create(
      `documents/${upload.id}/comments/${crypto.randomUUID()}.json`,
      JSON.stringify({ commentId: String(i) }),
    );
  const get = store.get.bind(store);
  let active = 0,
    peak = 0;
  store.get = async (key) => {
    if (!key.includes("/comments/")) return get(key);
    peak = Math.max(peak, ++active);
    await new Promise((resolve) => setImmediate(resolve));
    const value = await get(key);
    active--;
    return value;
  };
  const page = await (await request(`/${upload.id}/comments`)).json();
  assert.equal(page.comments.length, 20);
  assert.equal(peak, 6);
});

test("Web agent export stays under one-invocation storage budget and exposes continuation", async () => {
  const { store, service, request, upload } = await setup();
  const doc = await (await request(`/${upload.id}`)).json();
  const text = documentModel(md).text;
  for (let i = 0; i < 1001; i++) {
    const commentId = crypto.randomUUID();
    await store.create(
      `documents/${upload.id}/comments/${commentId}.json`,
      JSON.stringify({
        format: "threadshare-document-comment@v1",
        commentId,
        revision: doc.revision,
        authorName: "Reviewer",
        body: "Feedback",
        serverCreatedAt: new Date().toISOString(),
        anchor: {
          textVersion: "document-anchor-text@1",
          start: 0,
          end: 6,
          exact: text.slice(0, 6),
          prefix: "",
          suffix: text.slice(6, 70),
        },
      }),
    );
  }
  let calls = 0;
  for (const name of ["get", "list"]) {
    const original = store[name].bind(store);
    store[name] = (...args) => {
      calls++;
      return original(...args);
    };
  }
  const response = await documentAgentResponse(
    new Request(
      `https://test.local/document.html?id=${upload.id}&format=agent`,
    ),
    service,
  );
  const body = await response.text();
  assert.equal(response.status, 200);
  assert.equal((body.match(/^### https:/gm) ?? []).length, 500);
  assert.match(body, /Complete traversal: false/);
  assert.match(body, /More comments: true/);
  assert.match(body, /Continuation cursor/);
  assert.ok(calls < 600, `expected bounded reads, got ${calls}`);
});

test("late comment after maintenance retirement is removed and re-enrolled for cleanup", async () => {
  const { store, request, upload } = await setup();
  const doc = await (await request(`/${upload.id}`)).json();
  const text = documentModel(md).text;
  const create = store.create.bind(store);
  const id = crypto.randomUUID();
  const key = `documents/${upload.id}/comments/${id}.json`;
  store.create = async (object, value, type) => {
    if (object === key) {
      await create(
        `documents/${upload.id}/revoked.json`,
        JSON.stringify({
          revokedAt: new Date(Date.now() - 86400001).toISOString(),
        }),
      );
      await sweepDocuments(store);
      await sweepDocuments(store);
      assert.equal(
        await store.get(`document-maintenance/${upload.id}.json`),
        null,
      );
    }
    return create(object, value, type);
  };
  const response = await request(`/${upload.id}/comments/${id}`, "PUT", {
    revision: doc.revision,
    authorName: "A",
    body: "Review",
    anchor: {
      textVersion: "document-anchor-text@1",
      start: 0,
      end: 6,
      exact: text.slice(0, 6),
      prefix: "",
      suffix: text.slice(6, 70),
    },
  });
  assert.equal(response.status, 404);
  assert.equal(await store.get(key), null);
  assert.notEqual(
    await store.get(`document-maintenance/${upload.id}.json`),
    null,
  );
});

test("BOM bytes survive publication; oversized bodies and wrong digests fail closed", async () => {
  const { request, service } = await setup();
  const content = "\uFEFF# BOM";
  const upload = await (
    await request("/uploads", "POST", {
      title: "BOM",
      markdown: {
        sha256: await sha256(content),
        bytes: Buffer.byteLength(content),
      },
      assets: [],
    })
  ).json();
  const put = (body) =>
    service(
      new Request(
        `https://test.local/api/v1/documents/${upload.id}/uploads/markdown`,
        {
          method: "PUT",
          headers: { authorization: `Bearer ${upload.uploadToken}` },
          body,
        },
      ),
    );
  assert.equal((await put("wrong")).status, 400);
  assert.equal((await put("x".repeat(100))).status, 413);
  assert.equal((await put(content)).status, 204);
  assert.equal(
    (
      await request(
        `/${upload.id}/publish`,
        "POST",
        undefined,
        upload.uploadToken,
      )
    ).status,
    201,
  );
  assert.equal(
    (await (await request(`/${upload.id}`)).json()).markdown,
    content,
  );
});
test("cross-origin browser writes and incomplete publish are refused", async () => {
  const { service, request } = await setup();
  const cross = await service(
    new Request("https://test.local/api/v1/documents/uploads", {
      method: "POST",
      headers: {
        origin: "https://evil.test",
        "content-type": "application/json",
      },
      body: "{}",
    }),
  );
  assert.equal(cross.status, 403);
  const upload = await (
    await request("/uploads", "POST", {
      title: "Missing",
      markdown: { sha256: await sha256(md), bytes: Buffer.byteLength(md) },
      assets: [],
    })
  ).json();
  assert.equal(
    (
      await request(
        `/${upload.id}/publish`,
        "POST",
        undefined,
        upload.uploadToken,
      )
    ).status,
    409,
  );
});
