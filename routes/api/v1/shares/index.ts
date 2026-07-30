import { defineHandler } from "void";
import { storage } from "void/storage";
import { jsonResponse, parseShareBody, SHARE_CORS_HEADERS } from "../../../../src/share-api";

export const OPTIONS = defineHandler(
  () => new Response(null, { status: 204, headers: SHARE_CORS_HEADERS }),
);

export const POST = defineHandler(async (context) => {
  const parsed = parseShareBody(context.req.header("content-type") ?? "", await context.req.text());
  if (!parsed.ok) return jsonResponse(parsed.status, { error: parsed.error });

  const id = crypto.randomUUID();
  await storage.put(`shares/${id}.json`, JSON.stringify(parsed.history), {
    httpMetadata: { contentType: "application/json; charset=utf-8" },
  });
  return jsonResponse(201, { id });
});
