import { defineHandler } from "void";
import { storage } from "void/storage";
import { jsonResponse, parseShareRequest, SHARE_CORS_HEADERS } from "../../../../src/share-api";
import { shareKey } from "../../../../src/share-schema";

export const OPTIONS = defineHandler(
  () => new Response(null, { status: 204, headers: SHARE_CORS_HEADERS }),
);

export const POST = defineHandler(async (context) => {
  try {
    const parsed = await parseShareRequest(context.req.raw);
    if (!parsed.ok) return jsonResponse(parsed.status, { error: parsed.error });

    const id = crypto.randomUUID();
    await storage.put(shareKey(id), JSON.stringify(parsed.history), {
      httpMetadata: { contentType: "application/json; charset=utf-8" },
    });
    return jsonResponse(201, { id });
  } catch (error) {
    console.error("Threadshare API request failed", error);
    return jsonResponse(500, { error: "Unable to process shared history" });
  }
});
