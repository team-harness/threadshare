import { jsonResponse, parseShareBody, SHARE_CORS_HEADERS } from "./src/share-api";
import { isShareId } from "./src/share-schema";

interface StoredShare {
  body: ReadableStream<Uint8Array> | null;
  httpEtag: string;
}

interface ChatShareBucket {
  get(key: string): Promise<StoredShare | null>;
  put(
    key: string,
    value: string,
    options: { httpMetadata: { contentType: string } },
  ): Promise<void>;
}

interface Env {
  ASSETS: Fetcher;
  THREADSHARE_BUCKET: ChatShareBucket;
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function shareKey(id: string): string {
  return `shares/${id}.json`;
}

async function createShare(request: Request, env: Env): Promise<Response> {
  const parsed = parseShareBody(request.headers.get("content-type"), await request.text());
  if (!parsed.ok) return jsonResponse(parsed.status, { error: parsed.error });

  const id = crypto.randomUUID();
  await env.THREADSHARE_BUCKET.put(shareKey(id), JSON.stringify(parsed.history), {
    httpMetadata: { contentType: JSON_CONTENT_TYPE },
  });
  return jsonResponse(201, { id });
}

async function readShare(id: string, env: Env): Promise<Response> {
  if (!isShareId(id)) return jsonResponse(404, { error: "Shared history was not found" });

  const object = await env.THREADSHARE_BUCKET.get(shareKey(id));
  if (!object?.body) return jsonResponse(404, { error: "Shared history was not found" });

  return new Response(object.body, {
    headers: {
      "cache-control": "private, no-store",
      "content-type": JSON_CONTENT_TYPE,
      etag: object.httpEtag,
    },
  });
}

export default {
  async fetch(request, env): Promise<Response> {
    const url = new URL(request.url);
    if (url.pathname === "/api/v1/shares") {
      if (request.method === "OPTIONS") {
        return new Response(null, { status: 204, headers: SHARE_CORS_HEADERS });
      }
      if (request.method === "POST") return createShare(request, env);
      return jsonResponse(405, { error: "Method not allowed" });
    }

    const match = /^\/api\/v1\/shares\/([^/]+)$/.exec(url.pathname);
    if (match) {
      if (request.method === "GET") return readShare(match[1], env);
      return jsonResponse(405, { error: "Method not allowed" });
    }

    if (url.pathname.startsWith("/api/")) return jsonResponse(404, { error: "Not found" });
    return env.ASSETS.fetch(request);
  },
} satisfies ExportedHandler<Env>;
