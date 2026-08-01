import {
  historyResponseHeaders,
  JSON_CONTENT_TYPE,
  jsonResponse,
  parseShareRequest,
  SHARE_CORS_HEADERS,
} from "./src/share-api";
import { isShareId, shareKey } from "./src/share-schema";
import { createStoredShare, decodeStoredShare, isShareExpired } from "./src/stored-share";

interface R2StoredObject {
  body: ReadableStream<Uint8Array> | null;
}

interface ChatShareBucket {
  get(key: string): Promise<R2StoredObject | null>;
  put(
    key: string,
    value: string,
    options: { httpMetadata: { contentType: string } },
  ): Promise<void>;
  delete(key: string): Promise<void>;
}

interface Env {
  ASSETS: Fetcher;
  THREADSHARE_BUCKET: ChatShareBucket;
}

interface WorkerOptions {
  now?: () => number;
}

async function createShare(request: Request, env: Env, now: () => number): Promise<Response> {
  const parsed = await parseShareRequest(request);
  if (!parsed.ok) return jsonResponse(parsed.status, { error: parsed.error });

  const id = crypto.randomUUID();
  const stored = createStoredShare(parsed.history, now(), parsed.expiresInSeconds);
  await env.THREADSHARE_BUCKET.put(shareKey(id), JSON.stringify(stored), {
    httpMetadata: { contentType: JSON_CONTENT_TYPE },
  });
  return jsonResponse(201, { id, ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}) });
}

async function readShare(id: string, env: Env, now: () => number): Promise<Response> {
  if (!isShareId(id)) return jsonResponse(404, { error: "Shared history was not found" });

  const object = await env.THREADSHARE_BUCKET.get(shareKey(id));
  if (!object?.body) return jsonResponse(404, { error: "Shared history was not found" });
  const stored = decodeStoredShare(await new Response(object.body).text());
  if (isShareExpired(stored.expiresAt, now())) {
    try {
      await env.THREADSHARE_BUCKET.delete(shareKey(id));
    } catch (error) {
      console.error("Threadshare expired share deletion failed", error);
    }
    return jsonResponse(404, { error: "Shared history was not found" });
  }

  return new Response(JSON.stringify(stored.history), {
    headers: historyResponseHeaders(stored.expiresAt),
  });
}

export function createWorker({ now = Date.now }: WorkerOptions = {}) {
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);
      if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

      try {
        if (url.pathname === "/api/v1/shares") {
          if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: SHARE_CORS_HEADERS });
          }
          if (request.method === "POST") return await createShare(request, env, now);
          return jsonResponse(405, { error: "Method not allowed" });
        }

        const match = /^\/api\/v1\/shares\/([^/]+)$/.exec(url.pathname);
        if (match) {
          if (request.method === "GET") return await readShare(match[1], env, now);
          return jsonResponse(405, { error: "Method not allowed" });
        }

        return jsonResponse(404, { error: "Not found" });
      } catch (error) {
        console.error("Threadshare API request failed", error);
        return jsonResponse(500, { error: "Unable to process shared history" });
      }
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker();
