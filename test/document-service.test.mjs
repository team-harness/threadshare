import assert from "node:assert/strict";
import test from "node:test";
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
import { sha256, documentModel, validatePublicDocument } from "../src/document-model.mjs";

import { memoryStore } from "./helpers/document-store.mjs";
const md = "# Design\n\nHello 😀 world.";
const html = "<!doctype html><html><head><title>Preview</title></head><body><h1>Hello</h1></body></html>";
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
test("HTML documents publish as v2 snapshots and reject anchored comments", async () => {
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
    title: "Preview",
    html: { sha256: await sha256(html), bytes: Buffer.byteLength(html) },
    assets: [],
  };
  const upload = await (await request("/uploads", "POST", declaration)).json();
  const put = await service(
    new Request(
      `https://test.local/api/v1/documents/${upload.id}/uploads/html`,
      {
        method: "PUT",
        headers: {
          authorization: `Bearer ${upload.uploadToken}`,
          "content-type": "text/html",
        },
        body: html,
      },
    ),
  );
  assert.equal(put.status, 204);
  assert.equal(
    (
      await request(`/${upload.id}/publish`, "POST", undefined, upload.uploadToken)
    ).status,
    201,
  );
  const doc = await (await request(`/${upload.id}`)).json();
  assert.equal(doc.format, "threadshare-document@v2");
  assert.equal(doc.renderer, "html-document-renderer@1");
  assert.equal(doc.textVersion, null);
  assert.deepEqual(doc.assets, []);
  assert.equal(doc.html, html);
  const preview = await service(
    new Request(`https://test.local/api/v1/documents/${upload.id}/html`),
  );
  assert.equal(preview.status, 200);
  assert.match(preview.headers.get("content-type") ?? "", /text\/html/);
  assert.match(
    preview.headers.get("content-security-policy") ?? "",
    /sandbox allow-scripts/,
  );
  assert.equal(await preview.text(), html);
  const comments = await (await request(`/${upload.id}/comments?limit=1`)).json();
  assert.deepEqual(comments.comments, []);
  assert.equal(
    (
      await request(`/${upload.id}/comments/${crypto.randomUUID()}`, "PUT", {
        revision: doc.revision,
        authorName: "Reviewer",
        body: "Feedback",
        anchor: null,
      })
    ).status,
    409,
  );
  assert.equal(
    new TextDecoder().decode(await store.get(`documents/${upload.id}/html.txt`)),
    html,
  );
});

test("HTML snapshots accept the 32 MiB boundary and reject the next byte", () => {
  const atLimit = "x".repeat(32 * 1024 * 1024);
  const base = {
    format: "threadshare-document@v2",
    id: "00000000-0000-4000-8000-000000000000",
    title: "Boundary",
    revision: "a".repeat(64),
    createdAt: "2026-01-01T00:00:00.000Z",
    expiresAt: null,
    revocable: false,
    renderer: "html-document-renderer@1",
    textVersion: null,
    assets: [],
  };
  assert.equal(validatePublicDocument({ ...base, html: atLimit }).html, atLimit);
  assert.throws(
    () => validatePublicDocument({ ...base, html: `${atLimit}x` }),
    /HTML exceeds 32 MiB/,
  );
});
test("HTML publication verifies the declared digest for UTF-8 documents with a BOM", async () => {
  const store = memoryStore();
  const service = createDocumentService(store);
  const source = "\uFEFF<!doctype html><html><body>BOM</body></html>";
  const sourceBytes = new TextEncoder().encode(source);
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
  const upload = await (
    await request("/uploads", "POST", {
      title: "BOM",
      html: { sha256: await sha256(sourceBytes), bytes: sourceBytes.length },
      assets: [],
    })
  ).json();
  assert.equal(
    (
      await service(
        new Request(`https://test.local/api/v1/documents/${upload.id}/uploads/html`, {
          method: "PUT",
          headers: {
            authorization: `Bearer ${upload.uploadToken}`,
            "content-type": "text/html; charset=utf-8",
          },
          body: sourceBytes,
        }),
      )
    ).status,
    204,
  );
  assert.equal(
    (
      await request(`/${upload.id}/publish`, "POST", undefined, upload.uploadToken)
    ).status,
    201,
  );
});
test("large valid HTML snapshots remain readable after JSON serialization", async () => {
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
  const largeHtml = `<pre>${"\u0001".repeat(1_500_000)}</pre>`;
  const upload = await (
    await request("/uploads", "POST", {
      title: "Large HTML",
      html: {
        sha256: await sha256(largeHtml),
        bytes: Buffer.byteLength(largeHtml),
      },
      assets: [],
    })
  ).json();
  const put = await service(
    new Request(`https://test.local/api/v1/documents/${upload.id}/uploads/html`, {
      method: "PUT",
      headers: {
        authorization: `Bearer ${upload.uploadToken}`,
        "content-type": "text/html",
      },
      body: largeHtml,
    }),
  );
  assert.equal(put.status, 204);
  assert.equal(
    (
      await request(`/${upload.id}/publish`, "POST", undefined, upload.uploadToken)
    ).status,
    201,
  );
  const report = await collectDocumentReviews(
    {
      id: upload.id,
      base: "https://test.local",
      url: `https://test.local/document.html?id=${upload.id}`,
    },
    { fetchImpl: (url, options) => service(new Request(url, options)) },
  );
  assert.equal(report.document.html, largeHtml);
  assert.equal(report.complete, true);
});
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
  ajv.addSchema(
    JSON.parse(
      await readFile(
        new URL(
          "../schema/threadshare-document.v2.schema.json",
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
