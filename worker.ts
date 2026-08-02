import {
  historyResponseHeaders,
  JSON_CONTENT_TYPE,
  jsonResponse,
  parseShareRequest,
  SHARE_CORS_HEADERS,
} from "./src/share-api";
import { isShareId, shareKey } from "./src/share-schema";
import {
  createStoredShare,
  decodeStoredShare,
  isShareExpired,
  parseRevokeAuthorization,
  revokeTokenMatches,
} from "./src/stored-share";
import {
  agentAlternateLink,
  agentProblemBody,
  agentTranscriptHeaders,
  formatAgentTranscript,
  mergeVary,
  selectAgentTranscript,
} from "./src/agent-transcript.mjs";

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

function apiJsonResponse(method: string, status: number, payload: object): Response {
  return method === "DELETE"
    ? jsonResponse(status, payload, { "cache-control": "no-store" })
    : jsonResponse(status, payload);
}

async function createShare(request: Request, env: Env, now: () => number): Promise<Response> {
  const parsed = await parseShareRequest(request);
  if (!parsed.ok) return jsonResponse(parsed.status, { error: parsed.error });

  const id = crypto.randomUUID();
  const stored = createStoredShare(parsed.history, now(), {
    expiresInSeconds: parsed.expiresInSeconds,
    revokeTokenSha256: parsed.revokeTokenSha256,
  });
  await env.THREADSHARE_BUCKET.put(shareKey(id), JSON.stringify(stored), {
    httpMetadata: { contentType: JSON_CONTENT_TYPE },
  });
  return jsonResponse(201, {
    id,
    ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
    ...(stored.revokeTokenSha256 ? { revocable: true } : {}),
  });
}

async function loadAvailableShare(id: string, env: Env, now: () => number) {
  if (!isShareId(id)) return undefined;
  const object = await env.THREADSHARE_BUCKET.get(shareKey(id));
  if (!object?.body) return undefined;
  const stored = decodeStoredShare(await new Response(object.body).text());
  if (isShareExpired(stored.expiresAt, now())) {
    try {
      await env.THREADSHARE_BUCKET.delete(shareKey(id));
    } catch (error) {
      console.error("Threadshare expired share deletion failed", error);
    }
    return undefined;
  }
  return stored;
}

async function readShare(id: string, env: Env, now: () => number): Promise<Response> {
  const stored = await loadAvailableShare(id, env, now);
  if (!stored) return jsonResponse(404, { error: "Shared history was not found" });

  return new Response(JSON.stringify(stored.history), {
    headers: historyResponseHeaders(stored.expiresAt),
  });
}

function agentResponse(
  method: string,
  status: 200 | 404 | 405 | 500,
  { history, expiresAt }: { history?: unknown; expiresAt?: string } = {},
): Response {
  const headers = agentTranscriptHeaders({ expiresAt });
  if (status === 405) headers.set("allow", "GET, HEAD");
  const body = status === 200 ? formatAgentTranscript(history) : agentProblemBody(status);
  return new Response(method === "HEAD" ? null : body, { status, headers });
}

async function readAgentShare(
  request: Request,
  url: URL,
  env: Env,
  now: () => number,
): Promise<Response> {
  const id = url.searchParams.get("id");
  if (!id || !isShareId(id)) return agentResponse(request.method, 404);
  const stored = await loadAvailableShare(id, env, now);
  if (!stored) return agentResponse(request.method, 404);
  return agentResponse(request.method, 200, stored);
}

function viewerMethodNotAllowed(): Response {
  return new Response(JSON.stringify({ error: "Method not allowed" }), {
    status: 405,
    headers: {
      allow: "GET, HEAD",
      "cache-control": "no-store",
      "content-type": JSON_CONTENT_TYPE,
      vary: "Accept",
    },
  });
}

async function readViewerHtml(request: Request, url: URL, env: Env): Promise<Response> {
  let assetRequest = request;
  if (url.pathname === "/index.html") {
    const assetUrl = new URL(request.url);
    assetUrl.pathname = "/";
    assetRequest = new Request(assetUrl, request);
  }
  const asset = await env.ASSETS.fetch(assetRequest);
  const headers = new Headers(asset.headers);
  headers.set("cache-control", "no-store");
  headers.set("vary", mergeVary(headers.get("vary")));
  const id = url.searchParams.get("id");
  if (id && isShareId(id)) headers.append("link", agentAlternateLink(id.toLowerCase()));
  return new Response(request.method === "HEAD" ? null : asset.body, {
    status: asset.status,
    statusText: asset.statusText,
    headers,
  });
}

function revokeNotFoundResponse(): Response {
  return apiJsonResponse("DELETE", 404, { error: "Shared history was not found" });
}

async function revokeShare(id: string, authorization: string | null, env: Env): Promise<Response> {
  if (!isShareId(id)) return revokeNotFoundResponse();

  const key = shareKey(id);
  const object = await env.THREADSHARE_BUCKET.get(key);
  if (!object?.body) return revokeNotFoundResponse();
  const stored = decodeStoredShare(await new Response(object.body).text());
  const token = parseRevokeAuthorization(authorization);
  if (!(await revokeTokenMatches(stored.revokeTokenSha256, token))) {
    return revokeNotFoundResponse();
  }

  await env.THREADSHARE_BUCKET.delete(key);
  return new Response(null, { status: 204 });
}

export function createWorker({ now = Date.now }: WorkerOptions = {}) {
  return {
    async fetch(request, env): Promise<Response> {
      const url = new URL(request.url);
      const isViewerDocument = url.pathname === "/" || url.pathname === "/index.html";
      if (isViewerDocument) {
        const agentSelected = selectAgentTranscript(
          url.searchParams,
          request.headers.get("accept") ?? undefined,
        );
        if (request.method !== "GET" && request.method !== "HEAD") {
          return agentSelected ? agentResponse(request.method, 405) : viewerMethodNotAllowed();
        }
        if (agentSelected) {
          try {
            return await readAgentShare(request, url, env, now);
          } catch (error) {
            console.error("Threadshare Agent transcript request failed", error);
            return agentResponse(request.method, 500);
          }
        }
        return readViewerHtml(request, url, env);
      }
      if (!url.pathname.startsWith("/api/")) return env.ASSETS.fetch(request);

      try {
        if (url.pathname === "/api/v1/shares") {
          if (request.method === "OPTIONS") {
            return new Response(null, { status: 204, headers: SHARE_CORS_HEADERS });
          }
          if (request.method === "POST") return await createShare(request, env, now);
          return apiJsonResponse(request.method, 405, { error: "Method not allowed" });
        }

        const match = /^\/api\/v1\/shares\/([^/]+)$/.exec(url.pathname);
        if (match) {
          if (request.method === "GET") return await readShare(match[1], env, now);
          if (request.method === "DELETE") {
            return await revokeShare(match[1], request.headers.get("authorization"), env);
          }
          return apiJsonResponse(request.method, 405, { error: "Method not allowed" });
        }

        return apiJsonResponse(request.method, 404, { error: "Not found" });
      } catch (error) {
        console.error("Threadshare API request failed", error);
        return apiJsonResponse(request.method, 500, { error: "Unable to process shared history" });
      }
    },
  } satisfies ExportedHandler<Env>;
}

export default createWorker();
