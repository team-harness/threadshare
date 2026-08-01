import { CHAT_SHARE_MAX_BYTES, ChatHistorySchema, type ChatHistory } from "./share-schema";

export const JSON_CONTENT_TYPE = "application/json; charset=utf-8";
export const EXPIRES_IN_HEADER = "x-threadshare-expires-in";
export const EXPIRES_AT_HEADER = "x-threadshare-expires-at";
export const REVOKE_TOKEN_SHA256_HEADER = "x-threadshare-revoke-token-sha256";
export const MIN_EXPIRES_IN_SECONDS = 60;
export const MAX_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

export const SHARE_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers":
    "content-type, x-threadshare-expires-in, x-threadshare-revoke-token-sha256",
  "cache-control": "no-store",
};

const TOO_LARGE_SHARE = {
  ok: false,
  status: 413,
  error: "Shared history is too large",
} as const;

export function jsonResponse(
  status: number,
  payload: object,
  headers = SHARE_CORS_HEADERS,
): Response {
  return new Response(JSON.stringify(payload), {
    status,
    headers: { ...headers, "content-type": JSON_CONTENT_TYPE },
  });
}

export function historyResponseHeaders(expiresAt?: string): Record<string, string> {
  return {
    "cache-control": "private, no-store",
    "content-type": JSON_CONTENT_TYPE,
    "access-control-allow-origin": "*",
    "access-control-expose-headers": EXPIRES_AT_HEADER,
    ...(expiresAt === undefined ? {} : { [EXPIRES_AT_HEADER]: expiresAt }),
  };
}

export type ParsedShareCreationOptions =
  | { ok: true; expiresInSeconds?: number }
  | { ok: false; status: 400; error: string };

export function parseShareCreationOptions({
  expiresIn,
  revokeTokenSha256,
}: {
  expiresIn: string | null | undefined;
  revokeTokenSha256: string | null | undefined;
}): ParsedShareCreationOptions {
  if (revokeTokenSha256 !== null && revokeTokenSha256 !== undefined) {
    return {
      ok: false,
      status: 400,
      error: `${REVOKE_TOKEN_SHA256_HEADER} is not supported`,
    };
  }
  if (expiresIn === null || expiresIn === undefined) return { ok: true };
  if (!/^\d+$/.test(expiresIn)) {
    return {
      ok: false,
      status: 400,
      error: `${EXPIRES_IN_HEADER} must be an integer from ${MIN_EXPIRES_IN_SECONDS} to ${MAX_EXPIRES_IN_SECONDS}`,
    };
  }
  const expiresInSeconds = Number(expiresIn);
  if (
    !Number.isSafeInteger(expiresInSeconds) ||
    expiresInSeconds < MIN_EXPIRES_IN_SECONDS ||
    expiresInSeconds > MAX_EXPIRES_IN_SECONDS
  ) {
    return {
      ok: false,
      status: 400,
      error: `${EXPIRES_IN_HEADER} must be an integer from ${MIN_EXPIRES_IN_SECONDS} to ${MAX_EXPIRES_IN_SECONDS}`,
    };
  }
  return { ok: true, expiresInSeconds };
}

export type ParsedShare =
  | { ok: true; history: ChatHistory; expiresInSeconds?: number }
  | { ok: false; status: number; error: string };

export function isJsonContentType(contentType: string | null | undefined): boolean {
  return /^application\/json(?:\s*;|$)/i.test(contentType ?? "");
}

function exceedsUtf8ByteLimit(value: string, limit: number): boolean {
  let bytes = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code < 0x80) bytes += 1;
    else if (code < 0x800) bytes += 2;
    else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index += 1;
      } else {
        bytes += 3;
      }
    } else {
      bytes += 3;
    }
    if (bytes > limit) return true;
  }
  return false;
}

export function declaredBodyIsTooLarge(contentLength: string | null): boolean {
  if (contentLength === null || !/^\d+$/.test(contentLength.trim())) return false;
  return Number(contentLength) > CHAT_SHARE_MAX_BYTES;
}

export function parseShareBody(contentType: string | null | undefined, raw: string): ParsedShare {
  if (!isJsonContentType(contentType)) {
    return { ok: false, status: 415, error: "Content-Type must be application/json" };
  }

  if (exceedsUtf8ByteLimit(raw, CHAT_SHARE_MAX_BYTES)) return TOO_LARGE_SHARE;

  let parsedBody: unknown;
  try {
    parsedBody = JSON.parse(raw);
  } catch {
    return { ok: false, status: 400, error: "Request body must be valid JSON" };
  }

  const history = ChatHistorySchema.safeParse(parsedBody);
  if (!history.success) {
    return { ok: false, status: 400, error: "Unsupported Threadshare history" };
  }

  return { ok: true, history: history.data };
}

export async function parseShareRequest(request: Request): Promise<ParsedShare> {
  const contentType = request.headers.get("content-type");
  if (!isJsonContentType(contentType)) {
    return { ok: false, status: 415, error: "Content-Type must be application/json" };
  }
  if (declaredBodyIsTooLarge(request.headers.get("content-length"))) return TOO_LARGE_SHARE;
  const creationOptions = parseShareCreationOptions({
    expiresIn: request.headers.get(EXPIRES_IN_HEADER),
    revokeTokenSha256: request.headers.get(REVOKE_TOKEN_SHA256_HEADER),
  });
  if (!creationOptions.ok) return creationOptions;
  if (!request.body) return parseShareBody(contentType, "");

  const reader = request.body.getReader();
  const decoder = new TextDecoder();
  const chunks: string[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > CHAT_SHARE_MAX_BYTES) {
        await reader.cancel().catch(() => undefined);
        return TOO_LARGE_SHARE;
      }
      chunks.push(decoder.decode(value, { stream: true }));
    }
    chunks.push(decoder.decode());
  } catch (error) {
    await reader.cancel().catch(() => undefined);
    throw error;
  }

  const parsed = parseShareBody(contentType, chunks.join(""));
  if (!parsed.ok) return parsed;
  return { ...parsed, ...creationOptions };
}
