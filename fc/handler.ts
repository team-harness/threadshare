import { createHmac, randomUUID } from "node:crypto";
import { parseShareBody, SHARE_CORS_HEADERS } from "../src/share-api";
import { isShareId } from "../src/share-schema";
import staticAssets from "./static-assets";

type Environment = Record<string, string | undefined>;
type StaticAssets = Record<string, { body: string; contentType: string }>;

interface FcEvent {
  body?: string;
  headers?: Record<string, string | string[] | undefined>;
  httpMethod?: string;
  isBase64Encoded?: boolean;
  path?: string;
  rawPath?: string;
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
}

const JSON_CONTENT_TYPE = "application/json; charset=utf-8";

function json(statusCode: number, payload: object, cors = true): FcResponse {
  return {
    statusCode,
    headers: {
      ...(cors ? SHARE_CORS_HEADERS : {}),
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

function eventMethod(event: FcEvent): string {
  return event.httpMethod ?? event.requestContext?.http?.method ?? "GET";
}

function eventPath(event: FcEvent): string {
  return event.rawPath ?? event.path ?? event.requestContext?.http?.path ?? "/";
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

function shareKey(id: string): string {
  return `shares/${id}.json`;
}

function encodeObjectKey(key: string): string {
  return key.split("/").map(encodeURIComponent).join("/");
}

function ossRequest(
  environment: Environment,
  method: "GET" | "PUT",
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
): Promise<FcResponse> {
  const request = ossRequest(environment, "GET", shareKey(id));
  const response = await fetchImpl(request.url, { headers: request.headers });
  if (response.status === 404) return json(404, { error: "Shared history was not found" });
  if (!response.ok) throw new Error(`OSS read failed with ${response.status}`);
  return {
    statusCode: 200,
    headers: {
      "cache-control": "private, no-store",
      "content-type": JSON_CONTENT_TYPE,
    },
    body: Buffer.from(await response.arrayBuffer()),
  };
}

function staticResponse(path: string, method: string, assets: StaticAssets): FcResponse {
  if (method !== "GET" && method !== "HEAD")
    return json(405, { error: "Method not allowed" }, false);
  const asset = assets[path === "/" ? "/index.html" : path];
  if (!asset) return json(404, { error: "Not found" }, false);
  return {
    statusCode: 200,
    headers: {
      "cache-control":
        path === "/" || path === "/index.html" ? "no-store" : "public, max-age=31536000, immutable",
      "content-type": asset.contentType,
    },
    body: method === "HEAD" ? undefined : Buffer.from(asset.body, "base64"),
  };
}

export function createHandler({
  assets = staticAssets,
  environment = process.env,
  fetchImpl = fetch,
}: HandlerOptions = {}) {
  return async function handler(event: FcEvent): Promise<FcResponse> {
    const method = eventMethod(event);
    const path = eventPath(event);
    try {
      if (path === "/api/v1/shares") {
        if (method === "OPTIONS") {
          return { statusCode: 204, headers: SHARE_CORS_HEADERS };
        }
        if (method !== "POST") return json(405, { error: "Method not allowed" });

        const parsed = parseShareBody(header(event, "content-type"), eventBody(event));
        if (!parsed.ok) return json(parsed.status, { error: parsed.error });
        const id = randomUUID();
        await saveHistory(JSON.stringify(parsed.history), id, environment, fetchImpl);
        return json(201, { id });
      }

      const match = /^\/api\/v1\/shares\/([^/]+)$/.exec(path);
      if (match) {
        if (method !== "GET") return json(405, { error: "Method not allowed" });
        if (!isShareId(match[1])) return json(404, { error: "Shared history was not found" });
        return loadHistory(match[1], environment, fetchImpl);
      }

      if (path.startsWith("/api/")) return json(404, { error: "Not found" });
      return staticResponse(path, method, assets);
    } catch {
      return json(500, { error: "Unable to process shared history" });
    }
  };
}

export const handler = createHandler();
