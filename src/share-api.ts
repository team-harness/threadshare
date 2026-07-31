import { CHAT_SHARE_MAX_BYTES, ChatHistorySchema, type ChatHistory } from "./share-schema";

export const SHARE_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
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
    headers: { ...headers, "content-type": "application/json; charset=utf-8" },
  });
}

export type ParsedShare =
  | { ok: true; history: ChatHistory }
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

  return parseShareBody(contentType, chunks.join(""));
}
