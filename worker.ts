import { jsonResponse, parseShareRequest, SHARE_CORS_HEADERS } from "./src/share-api";
import { isShareId, shareKey } from "./src/share-schema";

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

async function createShare(request: Request, env: Env): Promise<Response> {
  const parsed = await parseShareRequest(request);
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
  const body = await new Response(object.body).arrayBuffer();

  return new Response(body, {
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
    if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

    try {
      if (url.pathname === "/api/v1/shares") {
        if (request.method === "OPTIONS") {
          return new Response(null, { status: 204, headers: SHARE_CORS_HEADERS });
        }
        if (request.method === "POST") return await createShare(request, env);
        return jsonResponse(405, { error: "Method not allowed" });
      }

      const match = /^\/api\/v1\/shares\/([^/]+)$/.exec(url.pathname);
      if (match) {
        if (request.method === "GET") return await readShare(match[1], env);
        return jsonResponse(405, { error: "Method not allowed" });
      }

      return jsonResponse(404, { error: "Not found" });
    } catch (error) {
      console.error("Threadshare API request failed", error);
      return jsonResponse(500, { error: "Unable to process shared history" });
    }
  },
} satisfies ExportedHandler<Env>;
