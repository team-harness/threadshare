import {
  ANCHOR_VERSION,
  DOCUMENT_RENDERER,
  DOCUMENT_LIMITS as LIMITS,
  HTML_DOCUMENT_RENDERER,
  UUID,
  DIGEST,
  bytes,
  check,
  exactKeys,
  sha256,
  documentModel,
  imageMetadata,
  validateAnchor,
} from "./document-model.mjs";

const JSON_TYPE = "application/json; charset=utf-8";
const headers = {
  "cache-control": "no-store",
  "x-content-type-options": "nosniff",
  "referrer-policy": "no-referrer",
};
const HTML_DOCUMENT_CSP =
  "sandbox allow-scripts; default-src 'none'; script-src 'unsafe-inline' 'unsafe-eval' blob:; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; form-action 'none'; base-uri 'none'; frame-src 'none'; object-src 'none'";
const reply = (status, value) =>
  new Response(value === undefined ? null : JSON.stringify(value), {
    status,
    headers: { ...headers, "content-type": JSON_TYPE },
  });
const decode = (raw) =>
  raw === null
    ? null
    : JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(raw));
const keyFor = (id, suffix) => `documents/${id}/${suffix}`;
const missing = () => check(false, "Document was not found", 404);

// Resolve the public document URL to a native HTML response when its immutable
// snapshot is an HTML document. Markdown documents continue to use the Review
// Viewer, and Agent negotiation is handled by the caller before this helper.
export async function nativeHtmlDocumentResponse(request, service) {
  const url = new URL(request.url);
  const id = url.searchParams.get("id");
  if (!UUID.test(id ?? "")) return null;
  const metadataUrl = new URL(`/api/v1/documents/${id}/metadata`, url);
  const metadata = await service(
    new Request(metadataUrl, {
      method: "GET",
      headers: { accept: "application/json" },
    }),
  );
  if (!metadata) return null;
  if (metadata.status !== 200) {
    if (request.method === "HEAD")
      return new Response(null, {
        status: metadata.status,
        headers: metadata.headers,
      });
    return metadata;
  }
  let document;
  try {
    document = await metadata.json();
  } catch {
    return new Response(null, {
      status: 500,
      headers: { ...headers, "content-type": JSON_TYPE },
    });
  }
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    document.id !== id
  )
    return new Response(null, {
      status: 500,
      headers: { ...headers, "content-type": JSON_TYPE },
    });
  if (document.format === "threadshare-document@v1") return null;
  if (document.format !== "threadshare-document@v2")
    return new Response(null, {
      status: 500,
      headers: { ...headers, "content-type": JSON_TYPE },
    });
  return service(
    new Request(new URL(`/api/v1/documents/${id}/html`, url), {
      method: request.method,
      headers: request.headers,
    }),
  );
}

async function boundedBody(request, limit) {
  const length = request.headers.get("content-length");
  check(
    !length || (/^\d+$/.test(length) && Number(length) <= limit),
    "Request is too large",
    413,
  );
  const reader = request.body?.getReader();
  if (!reader) return new Uint8Array();
  const chunks = [];
  let size = 0;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      size += value.length;
      if (size > limit) {
        await reader.cancel();
        check(false, "Request is too large", 413);
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  const body = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    body.set(chunk, offset);
    offset += chunk.length;
  }
  return body;
}
async function jsonBody(request, limit = 32768) {
  check(
    /^application\/json(?:\s*;|$)/i.test(
      request.headers.get("content-type") ?? "",
    ),
    "Use application/json",
    415,
  );
  try {
    return JSON.parse(
      new TextDecoder("utf-8", { fatal: true }).decode(
        await boundedBody(request, limit),
      ),
    );
  } catch (error) {
    if (error.status) throw error;
    check(false, "Invalid JSON");
  }
}
function validateDeclaration(value) {
  exactKeys(
    value,
    [
      "title",
      "markdown",
      "html",
      "assets",
      "expiresInSeconds",
      "revokeTokenSha256",
    ],
    ["title", "assets"],
  );
  check(
    typeof value.title === "string" &&
      value.title.trim().length > 0 &&
      value.title.length <= 200,
    "Title must contain 1–200 characters",
  );
  const size = (part, max) => {
    check(
      DIGEST.test(part.sha256) &&
        Number.isSafeInteger(part.bytes) &&
        part.bytes > 0 &&
        part.bytes <= max,
      "Invalid file size or digest",
    );
  };
  check(
    (value.markdown !== undefined) !== (value.html !== undefined),
    "Declare exactly one Markdown or HTML payload",
  );
  if (value.html !== undefined) {
    exactKeys(value.html, ["sha256", "bytes"]);
    size(value.html, LIMITS.html);
    check(
      !value.assets || (Array.isArray(value.assets) && value.assets.length === 0),
      "HTML documents cannot declare image assets",
    );
    value.assets = [];
  } else {
    exactKeys(value.markdown, ["sha256", "bytes"]);
    size(value.markdown, LIMITS.markdown);
  }
  check(
    Array.isArray(value.assets) &&
      (value.html !== undefined || value.assets.length <= LIMITS.images),
    "At most 32 local images are supported",
  );
  const sources = new Set();
  const hashes = new Map();
  for (const asset of value.assets) {
    exactKeys(asset, ["source", "sha256", "bytes", "contentType"]);
    size(asset, LIMITS.image);
    check(
      typeof asset.source === "string" &&
        asset.source.length > 0 &&
        asset.source.length <= 2048 &&
        !/^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(asset.source),
      "Invalid local image reference",
    );
    check(!sources.has(asset.source), "Duplicate image reference");
    sources.add(asset.source);
    check(
      ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
        asset.contentType,
      ),
      "Unsupported image type",
    );
    check(
      !hashes.has(asset.sha256) ||
        hashes.get(asset.sha256) === `${asset.bytes}:${asset.contentType}`,
      "Conflicting image declaration",
    );
    hashes.set(asset.sha256, `${asset.bytes}:${asset.contentType}`);
  }
  const primaryBytes = value.markdown?.bytes ?? value.html.bytes;
  check(
    primaryBytes +
      [...hashes.values()].reduce(
        (n, entry) => n + Number(entry.split(":")[0]),
        0,
      ) <= LIMITS.total,
    "Document exceeds 32 MiB",
    413,
  );
  if (value.expiresInSeconds !== undefined)
    check(
      Number.isSafeInteger(value.expiresInSeconds) &&
        value.expiresInSeconds >= 60 &&
        value.expiresInSeconds <= 31536000,
      "Expiration must be 1 minute through 365 days",
    );
  if (value.revokeTokenSha256 !== undefined)
    check(DIGEST.test(value.revokeTokenSha256), "Invalid revoke digest");
  return value;
}
async function authorize(request, digest) {
  const token = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
    request.headers.get("authorization") ?? "",
  )?.[1];
  if (!token || !digest) return false;
  const observed = await sha256(token);
  let difference = 0;
  for (let i = 0; i < 64; i++)
    difference |= observed.charCodeAt(i) ^ digest.charCodeAt(i);
  return difference === 0;
}
function newToken() {
  return btoa(
    String.fromCharCode(...crypto.getRandomValues(new Uint8Array(32))),
  )
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}
function publicComment(comment) {
  const { requestDigest, ...visible } = comment;
  return visible;
}

export function createDocumentService(
  store,
  { now = Date.now, logger = console } = {},
) {
  const readJson = async (key) => decode(await store.get(key));
  async function rejectLateWrite(id, key) {
    if (!(await store.get(keyFor(id, "revoked.json")))) return;
    // Re-enrol before deleting: failed deletion remains discoverable by cleanup.
    await store.create(`document-maintenance/${id}.json`, "{}", JSON_TYPE);
    await store.delete(key);
    return missing();
  }
  async function available(id) {
    if (await store.get(keyFor(id, "revoked.json"))) return missing();
    const doc = await readJson(keyFor(id, "document.json"));
    if (!doc || (doc.expiresAt && Date.parse(doc.expiresAt) <= now()))
      return missing();
    return doc;
  }
  async function draft(id, request) {
    if (await store.get(keyFor(id, "revoked.json"))) return missing();
    const upload = await readJson(keyFor(id, "upload.json"));
    if (!upload || !(await authorize(request, upload.uploadTokenSha256)))
      return missing();
    check(
      now() < Date.parse(upload.uploadExpiresAt),
      "Upload expired; create a new upload",
      410,
    );
    return upload;
  }
  async function markdown(id) {
    const raw = await store.get(keyFor(id, "markdown.txt"));
    check(raw !== null, "Markdown is not uploaded", 409);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      raw,
    );
  }
  async function html(id) {
    const raw = await store.get(keyFor(id, "html.txt"));
    check(raw !== null, "HTML is not uploaded", 409);
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(raw);
  }
  async function htmlBytes(id) {
    const raw = await store.get(keyFor(id, "html.txt"));
    check(raw !== null, "HTML is not uploaded", 409);
    return raw;
  }
  async function comments(id, cursor, limit) {
    const prefix = keyFor(id, "comments/");
    const page = await store.list(prefix, cursor, limit);
    const items = [];
    for (const key of page.keys) {
      check(
        key.startsWith(prefix) &&
          UUID.test(key.slice(prefix.length, -5)) &&
          key.endsWith(".json"),
        "Invalid stored comment",
        500,
      );
    }
    // At most six open storage reads, independent of comment count.
    for (let offset = 0; offset < page.keys.length; offset += 6) {
      const chunk = await Promise.all(
        page.keys.slice(offset, offset + 6).map(readJson),
      );
      for (const item of chunk) if (item) items.push(publicComment(item));
    }
    return {
      format: "threadshare-document-comments@v1",
      comments: items,
      nextCursor: page.cursor,
      hasMore: page.cursor !== null,
    };
  }
  return async function handleDocument(request) {
    const url = new URL(request.url);
    const route = /^\/api\/v1\/documents(?:\/([^/]+))?(.*)$/.exec(url.pathname);
    if (!route) return null;
    try {
      const origin = request.headers.get("origin");
      if (!["GET", "HEAD"].includes(request.method) && origin !== null)
        check(
          origin === url.origin,
          "Cross-origin document writes are not allowed",
          403,
        );
      const id = route[1];
      const tail = route[2];
      if (id === "uploads" && tail === "" && request.method === "POST") {
        const declaration = validateDeclaration(await jsonBody(request));
        const newId = crypto.randomUUID();
        const token = newToken();
        const at = now();
        const upload = {
          ...declaration,
          id: newId,
          createdAt: new Date(at).toISOString(),
          uploadExpiresAt: new Date(at + 3600000).toISOString(),
          uploadTokenSha256: await sha256(token),
          expiresAt: declaration.expiresInSeconds
            ? new Date(at + declaration.expiresInSeconds * 1000).toISOString()
            : null,
        };
        check(
          await store.create(
            keyFor(newId, "upload.json"),
            JSON.stringify(upload),
            JSON_TYPE,
          ),
          "Upload collision",
          409,
        );
        await store.create(
          `document-maintenance/${newId}.json`,
          "{}",
          JSON_TYPE,
        );
        return reply(201, {
          id: newId,
          uploadToken: token,
          uploadExpiresAt: upload.uploadExpiresAt,
        });
      }
      if (!UUID.test(id ?? "")) return missing();
      if (
        request.method === "PUT" &&
        (tail === "/uploads/markdown" ||
          tail === "/uploads/html" ||
          /^\/uploads\/assets\/[0-9a-f]{64}$/.test(tail))
      ) {
        const upload = await draft(id, request);
        const isMarkdown = tail === "/uploads/markdown";
        const isHtml = tail === "/uploads/html";
        const digest = tail.split("/").at(-1);
        const expected = isMarkdown
          ? upload.markdown
          : isHtml
            ? upload.html
          : upload.assets.find((asset) => asset.sha256 === digest);
        check(expected, isHtml ? "HTML was not declared" : "Image was not declared");
        const data = await boundedBody(request, expected.bytes);
        check(
          data.length === expected.bytes &&
            (await sha256(data)) === expected.sha256,
          "Uploaded bytes do not match declaration",
        );
        if (isMarkdown) {
          let content;
          try {
            content = new TextDecoder("utf-8", {
              fatal: true,
              ignoreBOM: true,
            }).decode(data);
          } catch {
            check(false, "Markdown must be UTF-8");
          }
          const model = documentModel(content);
          const local = model.images.filter(
            (source) => !/^https?:\/\//i.test(source),
          );
          check(
            local.length === upload.assets.length &&
              local.every((source) =>
                upload.assets.some((asset) => asset.source === source),
              ),
            "Every local image must be declared",
          );
        } else if (!isHtml)
          check(
            imageMetadata(data).contentType === expected.contentType,
            "Image content type does not match declaration",
          );
        else {
          try {
            new TextDecoder("utf-8", { fatal: true }).decode(data);
          } catch {
            check(false, "HTML must be UTF-8");
          }
        }
        const key = keyFor(
          id,
          isMarkdown ? "markdown.txt" : isHtml ? "html.txt" : `assets/${digest}`,
        );
        if (
          !(await store.create(
            key,
            data,
            isMarkdown
              ? "text/markdown; charset=utf-8"
              : isHtml
                ? "text/html; charset=utf-8"
                : expected.contentType,
          ))
        ) {
          check(
            (await sha256(await store.get(key))) === expected.sha256,
            "Uploaded object conflicts",
            409,
          );
        }
        await rejectLateWrite(id, key);
        return reply(204);
      }
      if (request.method === "POST" && tail === "/publish") {
        const upload = await draft(id, request);
        check(
          !upload.expiresAt || Date.parse(upload.expiresAt) > now(),
          "Document already expired",
          410,
        );
        const isHtml = upload.html !== undefined;
        const content = isHtml ? await htmlBytes(id) : await markdown(id);
        const expectedDigest = isHtml ? upload.html.sha256 : upload.markdown.sha256;
        check((await sha256(content)) === expectedDigest, "Document digest mismatch", 409);
        if (!isHtml)
          for (const asset of upload.assets)
            check(
              (await store.get(keyFor(id, `assets/${asset.sha256}`))) !== null,
              "Images are not fully uploaded",
              409,
            );
        const revision = await sha256(
          JSON.stringify(
            isHtml
              ? { html: upload.html, renderer: HTML_DOCUMENT_RENDERER }
              : {
                  markdown: upload.markdown,
                  assets: upload.assets,
                  renderer: DOCUMENT_RENDERER,
                  textVersion: ANCHOR_VERSION,
                },
          ),
        );
        const doc = isHtml
          ? {
              format: "threadshare-document@v2",
              id,
              title: upload.title,
              revision,
              createdAt: upload.createdAt,
              expiresAt: upload.expiresAt,
              revocable: !!upload.revokeTokenSha256,
              renderer: HTML_DOCUMENT_RENDERER,
              textVersion: null,
              assets: [],
            }
          : {
              format: "threadshare-document@v1",
              id,
              title: upload.title,
              revision,
              createdAt: upload.createdAt,
              expiresAt: upload.expiresAt,
              revocable: !!upload.revokeTokenSha256,
              renderer: DOCUMENT_RENDERER,
              textVersion: ANCHOR_VERSION,
              assets: upload.assets,
            };
        await store.create(
          keyFor(id, "document.json"),
          JSON.stringify(doc),
          JSON_TYPE,
        );
        await rejectLateWrite(id, keyFor(id, "document.json"));
        await available(id); // A concurrent revoke dominates publication, permanently.
        return reply(201, {
          id,
          revision,
          expiresAt: doc.expiresAt,
          revocable: doc.revocable,
        });
      }
      if (request.method === "DELETE" && tail === "") {
        const upload = await readJson(keyFor(id, "upload.json"));
        if (!upload || !(await authorize(request, upload.revokeTokenSha256)))
          return missing();
        await store.create(
          keyFor(id, "revoked.json"),
          JSON.stringify({ revokedAt: new Date(now()).toISOString() }),
          JSON_TYPE,
        );
        await store.create(`document-maintenance/${id}.json`, "{}", JSON_TYPE);
        return reply(204);
      }
      const doc = await available(id);
      if (request.method === "GET" && tail === "/metadata")
        return reply(200, doc);
      if (request.method === "GET" && tail === "")
        return reply(
          200,
          doc.format === "threadshare-document@v2"
            ? { ...doc, html: await html(id) }
            : { ...doc, markdown: await markdown(id) },
        );
      if (["GET", "HEAD"].includes(request.method) && tail === "/html") {
        check(doc.format === "threadshare-document@v2", "HTML was not declared", 404);
        return new Response(request.method === "HEAD" ? null : await html(id), {
          headers: {
            ...headers,
            "content-type": "text/html; charset=utf-8",
            "content-security-policy": HTML_DOCUMENT_CSP,
            vary: "Accept",
          },
        });
      }
      if (request.method === "GET" && /^\/assets\/[0-9a-f]{64}$/.test(tail)) {
        const digest = tail.split("/").at(-1);
        const asset = doc.assets.find((item) => item.sha256 === digest);
        if (!asset) return missing();
        const data = await store.get(keyFor(id, `assets/${digest}`));
        if (!data) return missing();
        return new Response(data, {
          headers: {
            ...headers,
            "content-type": asset.contentType,
            "content-security-policy": "default-src 'none'; sandbox",
          },
        });
      }
      if (request.method === "GET" && tail === "/comments") {
        if (doc.format === "threadshare-document@v2")
          return reply(200, {
            format: "threadshare-document-comments@v1",
            revision: doc.revision,
            comments: [],
            nextCursor: null,
            hasMore: false,
          });
        check(
          [...url.searchParams.keys()].every((k) =>
            ["cursor", "limit"].includes(k),
          ),
        );
        const limitText = url.searchParams.get("limit") ?? "100";
        check(
          /^[1-9]\d{0,2}$/.test(limitText) && Number(limitText) <= 100,
          "Comment page limit is 1–100",
        );
        const cursor = url.searchParams.get("cursor");
        check(
          cursor === null || (cursor.length > 0 && cursor.length <= 4096),
          "Invalid cursor",
        );
        const result = await comments(id, cursor, Number(limitText));
        await available(id);
        return reply(200, { ...result, revision: doc.revision });
      }
      const commentId = /^\/comments\/([^/]+)$/.exec(tail)?.[1];
      if (request.method === "GET" && commentId) {
        if (!UUID.test(commentId)) return missing();
        const comment = await readJson(
          keyFor(id, `comments/${commentId}.json`),
        );
        if (!comment) return missing();
        await available(id);
        return reply(200, publicComment(comment));
      }
      if (request.method === "PUT" && commentId) {
        check(
          doc.format !== "threadshare-document@v2",
          "HTML documents do not support anchored comments",
          409,
        );
        check(UUID.test(commentId), "Invalid comment ID");
        const input = await jsonBody(request, LIMITS.comment);
        exactKeys(input, ["revision", "anchor", "authorName", "body"]);
        check(
          input.revision === doc.revision,
          "Document revision changed",
          409,
        );
        check(
          typeof input.authorName === "string" &&
            input.authorName.trim().length > 0 &&
            input.authorName.length <= 80,
          "Name must contain 1–80 characters",
        );
        check(
          typeof input.body === "string" &&
            input.body.trim().length > 0 &&
            input.body.length <= 4000 &&
            bytes(input.body).length <= 16384,
          "Comment must contain 1–4000 characters",
        );
        validateAnchor(documentModel(await markdown(id)).text, input.anchor);
        const anchor = Object.fromEntries(
          ["textVersion", "start", "end", "exact", "prefix", "suffix"].map(
            (key) => [key, input.anchor[key]],
          ),
        );
        const normalized = {
          revision: input.revision,
          anchor,
          authorName: input.authorName,
          body: input.body,
        };
        const requestDigest = await sha256(JSON.stringify(normalized));
        const comment = {
          format: "threadshare-document-comment@v1",
          commentId,
          ...normalized,
          serverCreatedAt: new Date(now()).toISOString(),
          requestDigest,
        };
        const key = keyFor(id, `comments/${commentId}.json`);
        const created = await store.create(
          key,
          JSON.stringify(comment),
          JSON_TYPE,
        );
        await rejectLateWrite(id, key);
        const saved = created ? comment : await readJson(key);
        await available(id);
        check(
          saved?.requestDigest === requestDigest,
          "Comment ID already has different content",
          409,
        );
        return reply(created ? 201 : 200, publicComment(saved));
      }
      return reply(405, { error: "Method not allowed" });
    } catch (error) {
      if (!error.status) logger.error("Document operation failed");
      return reply(error.status ?? 500, {
        error: error.status ? error.message : "Unable to process document",
      });
    }
  };
}

// Bounded, resumable maintenance. Tombstones and upload metadata are permanent
// replay barriers. Empty entries retire after a 24-hour late-write grace period.
export async function sweepDocuments(
  store,
  {
    cursor = null,
    now = Date.now,
    batchSize = 50,
    onProgress = async () => {},
    logger = console,
  } = {},
) {
  check(Number.isInteger(batchSize) && batchSize >= 1 && batchSize <= 50);
  let deleted = 0;
  let failed = 0;
  const started = Date.now();
  async function processEntry(entry) {
    const id = /^document-maintenance\/([0-9a-f-]+)\.json$/.exec(entry)?.[1];
    if (!UUID.test(id ?? "")) return;
    const key = keyFor(id, "upload.json");
    const prefix = keyFor(id, "");
    const upload = decode(await store.get(key));
    if (!upload) return;
    const doc = decode(await store.get(`${prefix}document.json`));
    const expired = doc
      ? doc.expiresAt && Date.parse(doc.expiresAt) <= now()
      : Date.parse(upload.uploadExpiresAt) <= now();
    if (!expired && !(await store.get(`${prefix}revoked.json`))) return;
    await store.create(
      `${prefix}revoked.json`,
      JSON.stringify({ revokedAt: new Date(now()).toISOString() }),
      JSON_TYPE,
    );
    const garbage = await store.list(prefix, null, Math.max(2, 100 - deleted));
    for (const object of garbage.keys) {
      if (object === key || object === `${prefix}revoked.json`) continue;
      if (deleted < 100) {
        await store.delete(object);
        deleted++;
      }
    }
    const tombstone = decode(await store.get(`${prefix}revoked.json`));
    if (
      !garbage.cursor &&
      garbage.keys.every(
        (key) =>
          key === `${prefix}revoked.json` || key === `${prefix}upload.json`,
      ) &&
      Date.parse(tombstone.revokedAt) + 86400000 <= now()
    ) {
      await store.delete(entry);
    }
  }
  for (let visited = 0; visited < batchSize; visited++) {
    if (visited && Date.now() - started >= 10000) break;
    // Persist the provider's opaque cursor after each entry, including failures.
    const page = await store.list("document-maintenance/", cursor, 1);
    for (const entry of page.keys) {
      try {
        await processEntry(entry);
      } catch {
        failed++;
        logger.error(
          "Document cleanup entry failed; will retry on the next traversal",
        );
      }
    }
    cursor = page.cursor;
    await onProgress(cursor);
    if (!cursor) break;
  }
  return { cursor, deleted, failed };
}
