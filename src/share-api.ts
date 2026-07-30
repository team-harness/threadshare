import { CHAT_SHARE_MAX_BYTES, ChatHistorySchema, type ChatHistory } from "./share-schema";

export const SHARE_CORS_HEADERS = {
  "access-control-allow-origin": "*",
  "access-control-allow-methods": "POST, OPTIONS",
  "access-control-allow-headers": "content-type",
  "cache-control": "no-store",
};

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

type ParsedShare =
  | { ok: true; history: ChatHistory }
  | { ok: false; status: number; error: string };

export function parseShareBody(contentType: string | null | undefined, raw: string): ParsedShare {
  if (!/^application\/json(?:\s*;|$)/i.test(contentType ?? "")) {
    return { ok: false, status: 415, error: "Content-Type must be application/json" };
  }

  if (new TextEncoder().encode(raw).byteLength > CHAT_SHARE_MAX_BYTES) {
    return { ok: false, status: 413, error: "Shared history is too large" };
  }

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
