import { createHmac, randomUUID } from "node:crypto";
import {
  declaredBodyIsTooLarge,
  EXPIRES_IN_HEADER,
  historyResponseHeaders,
  isJsonContentType,
  JSON_CONTENT_TYPE,
  parseShareBody,
  parseShareCreationOptions,
  REVOKE_TOKEN_SHA256_HEADER,
  SHARE_CORS_HEADERS,
} from "../src/share-api";
import { CHAT_SHARE_MAX_BYTES, isShareId, shareKey } from "../src/share-schema";
import {
  createStoredShare,
  decodeStoredShare,
  isShareExpired,
  parseRevokeAuthorization,
  revokeTokenMatches,
} from "../src/stored-share";
import {
  agentAlternateLink,
  agentProblemBody,
  agentTranscriptHeaders,
  formatAgentTranscript,
  mergeVary,
  selectAgentTranscript,
} from "../src/agent-transcript.mjs";
import staticAssets from "./static-assets";

type Environment = Record<string, string | undefined>;
type StaticAssets = Record<
  string,
  { body: string; contentType: string; headers?: Record<string, string> }
>;

interface FcEvent {
  body?: string;
  headers?: Record<string, string | string[] | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
  path?: string;
  queries?: Record<string, unknown>;
  queryParameters?: Record<string, unknown>;
  rawPath?: string;
  rawQueryString?: string;
  requestContext?: { http?: { method?: string; path?: string } };
}

interface FcResponse {
  body?: Buffer | string;
  headers: Record<string, string>;
  statusCode: number;
}

interface HandlerOptions {
  assets?: StaticAssets;
  environment?: Environment;
  fetchImpl?: typeof fetch;
  logger?: Pick<Console, "error">;
  now?: () => number;
}

function json(statusCode: number, payload: object, cors = true): FcResponse {
  return {
    statusCode,
    headers: {
      ...(cors ? SHARE_CORS_HEADERS : { "cache-control": "no-store" }),
      "content-type": JSON_CONTENT_TYPE,
    },
    body: JSON.stringify(payload),
  };
}

function header(event: FcEvent, name: string): string | undefined {
  const headers = event.headers ?? {};
  const matchingKey = Object.keys(headers).find((key) => key.toLowerCase() === name.toLowerCase());
  const value = matchingKey ? headers[matchingKey] : undefined;
  return Array.isArray(value) ? value[0] : value;
}

function acceptHeader(event: FcEvent): string | undefined {
  const values = [];
  for (const [name, value] of Object.entries(event.headers ?? {})) {
    if (name.toLowerCase() !== "accept") continue;
    if (typeof value === "string") values.push(value);
    else if (Array.isArray(value)) {
      for (const item of value) if (typeof item === "string") values.push(item);
    }
  }
  return values.length === 0 ? undefined : values.join(",");
}

function eventMethod(event: FcEvent): string {
  return event.httpMethod ?? event.requestContext?.http?.method ?? "GET";
}

function queryFromMap(value: Record<string, unknown>): URLSearchParams {
  const search = new URLSearchParams();
  for (const [name, raw] of Object.entries(value)) {
    const selected =
      typeof raw === "string"
        ? raw
        : Array.isArray(raw)
          ? raw.find((item) => typeof item === "string")
          : undefined;
    if (typeof selected === "string") search.append(name, selected);
  }
  return search;
}

function eventLocation(event: FcEvent): { path: string; searchParams: URLSearchParams } {
  const selectedPath = event.rawPath ?? event.path ?? event.requestContext?.http?.path ?? "/";
  const queryIndex = selectedPath.indexOf("?");
  const path = (queryIndex === -1 ? selectedPath : selectedPath.slice(0, queryIndex)) || "/";
  const pathQuery = queryIndex === -1 ? "" : selectedPath.slice(queryIndex + 1);
  let searchParams;
  if (typeof event.rawQueryString === "string") {
    searchParams = new URLSearchParams(event.rawQueryString);
  } else if (
    event.queryParameters !== null &&
    typeof event.queryParameters === "object" &&
    !Array.isArray(event.queryParameters)
  ) {
    searchParams = queryFromMap(event.queryParameters);
  } else if (
    event.queries !== null &&
    typeof event.queries === "object" &&
    !Array.isArray(event.queries)
  ) {
    searchParams = queryFromMap(event.queries);
  } else {
    searchParams = new URLSearchParams(pathQuery);
  }
  return { path, searchParams };
}

function eventBody(event: FcEvent): string {
  if (!event.body) return "";
  return event.isBase64Encoded ? Buffer.from(event.body, "base64").toString("utf8") : event.body;
}

function environmentValue(environment: Environment, name: string, legacyName?: string): string {
  const value = environment[name]?.trim() ?? environment[legacyName ?? ""]?.trim();
  if (!value) throw new Error(`Missing ${name}`);
  return value;
}

function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function ossRequest(
  environment: Environment,
  method: "DELETE" | "GET" | "PUT",
  key: string,
  contentType = "",
): { headers: Record<string, string>; url: string } {
  const bucket = environmentValue(environment, "THREADSHARE_OSS_BUCKET", "CHAT_SHARE_OSS_BUCKET");
  const region = environmentValue(environment, "THREADSHARE_OSS_REGION", "CHAT_SHARE_OSS_REGION");
  const accessKeyId = environmentValue(
    environment,
    "THREADSHARE_OSS_ACCESS_KEY_ID",
    "CHAT_SHARE_OSS_ACCESS_KEY_ID",
  );
  const accessKeySecret = environmentValue(
    environment,
    "THREADSHARE_OSS_ACCESS_KEY_SECRET",
    "CHAT_SHARE_OSS_ACCESS_KEY_SECRET",
  );
  const date = new Date().toUTCString();
  const resource = `/${bucket}/${key}`;
  const stringToSign = [method, "", contentType, date, resource].join("\n");
  const signature = createHmac("sha1", accessKeySecret).update(stringToSign).digest("base64");
  const headers: Record<string, string> = {
    authorization: `OSS ${accessKeyId}:${signature}`,
    date,
  };
  if (contentType) headers["content-type"] = contentType;
  return {
    headers,
    url: `https://${bucket}.oss-${region}.aliyuncs.com/${encodeObjectKey(key)}`,
  };
}

async function saveHistory(
  raw: string,
  id: string,
  environment: Environment,
  fetchImpl: typeof fetch,
): Promise<void> {
  const request = ossRequest(environment, "PUT", shareKey(id), JSON_CONTENT_TYPE);
  const response = await fetchImpl(request.url, {
    method: "PUT",
    headers: request.headers,
    body: raw,
  });
  if (!response.ok) throw new Error(`OSS write failed with ${response.status}`);
}

async function loadHistory(
  id: string,
  environment: Environment,
  fetchImpl: typeof fetch,
  now: () => number,
  logger: Pick<Console, "error">,
): Promise<FcResponse> {
  const stored = await loadAvailableShare(id, environment, fetchImpl, now, logger);
  if (!stored) return json(404, { error: "Shared history was not found" });
  return {
    statusCode: 200,
    headers: historyResponseHeaders(stored.expiresAt),
    body: Buffer.from(JSON.stringify(stored.history)),
  };
}

async function loadAvailableShare(
  id: string,
  environment: Environment,
  fetchImpl: typeof fetch,
  now: () => number,
  logger: Pick<Console, "error">,
) {
  if (!isShareId(id)) return undefined;
  const stored = await loadStoredShare(id, environment, fetchImpl);
  if (!stored) return undefined;
  if (isShareExpired(stored.expiresAt, now())) {
    try {
      await deleteHistory(id, environment, fetchImpl);
    } catch (error) {
      logger.error("Threadshare expired share deletion failed", error);
    }
    return undefined;
  }
  return stored;
}

async function loadStoredShare(
  id: string,
  environment: Environment,
  fetchImpl: typeof fetch,
): Promise<ReturnType<typeof decodeStoredShare> | undefined> {
  const request = ossRequest(environment, "GET", shareKey(id));
  const response = await fetchImpl(request.url, { headers: request.headers });
  if (response.status === 404) return undefined;
  if (!response.ok) throw new Error(`OSS read failed with ${response.status}`);
  return decodeStoredShare(await response.text());
}

async function deleteHistory(
  id: string,
  environment: Environment,
  fetchImpl: typeof fetch,
): Promise<void> {
  const request = ossRequest(environment, "DELETE", shareKey(id));
  const response = await fetchImpl(request.url, { method: "DELETE", headers: request.headers });
  if (!response.ok && response.status !== 404) {
    throw new Error(`OSS delete failed with ${response.status}`);
  }
}

async function revokeHistory(
  id: string,
  authorization: string | undefined,
  environment: Environment,
  fetchImpl: typeof fetch,
): Promise<FcResponse> {
  if (!isShareId(id)) return json(404, { error: "Shared history was not found" }, false);
  const stored = await loadStoredShare(id, environment, fetchImpl);
  if (!stored) return json(404, { error: "Shared history was not found" }, false);
  const token = parseRevokeAuthorization(authorization);
  if (!(await revokeTokenMatches(stored.revokeTokenSha256, token))) {
    return json(404, { error: "Shared history was not found" }, false);
  }
  await deleteHistory(id, environment, fetchImpl);
  return { statusCode: 204, headers: {} };
}

function agentResponse(
  method: string,
  status: 200 | 404 | 405 | 500,
  { history, expiresAt }: { history?: unknown; expiresAt?: string } = {},
): FcResponse {
  const headers = Object.fromEntries(agentTranscriptHeaders({ expiresAt }).entries());
  if (status === 405) headers.allow = "GET, HEAD";
  const body = status === 200 ? formatAgentTranscript(history) : agentProblemBody(status);
  return { statusCode: status, headers, ...(method === "HEAD" ? {} : { body }) };
}

async function readAgentShare(
  method: string,
  searchParams: URLSearchParams,
  environment: Environment,
  fetchImpl: typeof fetch,
  now: () => number,
  logger: Pick<Console, "error">,
): Promise<FcResponse> {
  const id = searchParams.get("id");
  if (!id || !isShareId(id)) return agentResponse(method, 404);
  const stored = await loadAvailableShare(id, environment, fetchImpl, now, logger);
  return stored ? agentResponse(method, 200, stored) : agentResponse(method, 404);
}

function viewerMethodNotAllowed(): FcResponse {
  return {
    statusCode: 405,
    headers: {
      allow: "GET, HEAD",
      "cache-control": "no-store",
      "content-type": JSON_CONTENT_TYPE,
      vary: "Accept",
    },
    body: JSON.stringify({ error: "Method not allowed" }),
  };
}

function normalizedAssetHeaders(source: Record<string, string> | undefined): Record<string, string> {
  const headers: Record<string, string> = {};
  for (const [name, value] of Object.entries(source ?? {})) {
    const normalizedName = name.toLowerCase();
    headers[normalizedName] = headers[normalizedName]
      ? `${headers[normalizedName]}, ${value}`
      : value;
  }
  return headers;
}

function staticResponse(
  path: string,
  method: string,
  assets: StaticAssets,
  searchParams = new URLSearchParams(),
): FcResponse {
  if (method !== "GET" && method !== "HEAD")
    return json(405, { error: "Method not allowed" }, false);
  const asset = assets[path === "/" ? "/index.html" : path];
  if (!asset) return json(404, { error: "Not found" }, false);
  const viewerDocument = path === "/" || path === "/index.html";
  const headers = normalizedAssetHeaders(asset.headers);
  headers["cache-control"] = viewerDocument
    ? "no-store"
    : "public, max-age=31536000, immutable";
  headers["content-type"] = asset.contentType;
  if (viewerDocument) {
    headers.vary = mergeVary(headers.vary);
    const id = searchParams.get("id");
    if (id && isShareId(id)) {
      const alternate = agentAlternateLink(id.toLowerCase());
      headers.link = headers.link ? `${headers.link}, ${alternate}` : alternate;
    }
  }
  return {
    statusCode: 200,
    headers,
    body: method === "HEAD" ? undefined : Buffer.from(asset.body, "base64"),
  };
}

export function createHandler({
  assets = staticAssets,
  environment = process.env,
  fetchImpl = fetch,
  logger = console,
  now = Date.now,
}: HandlerOptions = {}) {
  return async function handler(event: FcEvent): Promise<FcResponse> {
    const method = eventMethod(event);
    const { path, searchParams } = eventLocation(event);
    const viewerDocument = path === "/" || path === "/index.html";
    const agentSelected =
      viewerDocument && selectAgentTranscript(searchParams, acceptHeader(event));
    try {
      if (path === "/api/v1/shares") {
        if (method === "OPTIONS") {
          return { statusCode: 204, headers: SHARE_CORS_HEADERS };
        }
        if (method !== "POST") {
          return json(405, { error: "Method not allowed" }, method !== "DELETE");
        }

        const contentType = header(event, "content-type");
        if (!isJsonContentType(contentType)) {
          return json(415, { error: "Content-Type must be application/json" });
        }
        const contentLength = header(event, "content-length");
        if (declaredBodyIsTooLarge(contentLength ?? null)) {
          return json(413, { error: "Shared history is too large" });
        }
        const creationOptions = parseShareCreationOptions({
          expiresIn: header(event, EXPIRES_IN_HEADER),
          revokeTokenSha256: header(event, REVOKE_TOKEN_SHA256_HEADER),
        });
        if (!creationOptions.ok) {
          return json(creationOptions.status, { error: creationOptions.error });
        }
        if (
          event.isBase64Encoded &&
          event.body &&
          Buffer.byteLength(event.body, "base64") > CHAT_SHARE_MAX_BYTES
        ) {
          return json(413, { error: "Shared history is too large" });
        }
        const parsed = parseShareBody(contentType, eventBody(event));
        if (!parsed.ok) return json(parsed.status, { error: parsed.error });
        const id = randomUUID();
        const stored = createStoredShare(parsed.history, now(), {
          expiresInSeconds: creationOptions.expiresInSeconds,
          revokeTokenSha256: creationOptions.revokeTokenSha256,
        });
        await saveHistory(JSON.stringify(stored), id, environment, fetchImpl);
        return json(201, {
          id,
          ...(stored.expiresAt ? { expiresAt: stored.expiresAt } : {}),
          ...(stored.revokeTokenSha256 ? { revocable: true } : {}),
        });
      }

      const match = /^\/api\/v1\/shares\/([^/]+)$/.exec(path);
      if (match) {
        if (method === "GET") {
          if (!isShareId(match[1])) return json(404, { error: "Shared history was not found" });
          return await loadHistory(match[1], environment, fetchImpl, now, logger);
        }
        if (method === "DELETE") {
          return await revokeHistory(
            match[1],
            header(event, "authorization"),
            environment,
            fetchImpl,
          );
        }
        return json(405, { error: "Method not allowed" }, method !== "DELETE");
      }

      if (path.startsWith("/api/")) {
        return json(404, { error: "Not found" }, method !== "DELETE");
      }
      if (viewerDocument) {
        if (method !== "GET" && method !== "HEAD") {
          return agentSelected ? agentResponse(method, 405) : viewerMethodNotAllowed();
        }
        if (agentSelected) {
          return await readAgentShare(
            method,
            searchParams,
            environment,
            fetchImpl,
            now,
            logger,
          );
        }
      }
      return staticResponse(path, method, assets, searchParams);
    } catch (error) {
      logger.error("Threadshare API request failed", error);
      if (agentSelected) return agentResponse(method, 500);
      return json(500, { error: "Unable to process shared history" }, method !== "DELETE");
    }
  };
}

export const handler = createHandler();
