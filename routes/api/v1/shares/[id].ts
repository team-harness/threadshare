import { defineHandler } from "void";
import { storage } from "void/storage";
import { jsonResponse } from "../../../../src/share-api";
import { isShareId, shareKey } from "../../../../src/share-schema";

export const GET = defineHandler(async (context) => {
  try {
    const id = context.req.param("id");
    if (!isShareId(id)) return jsonResponse(404, { error: "Shared history was not found" });

    const object = await storage.get(shareKey(id));
    if (!object) return jsonResponse(404, { error: "Shared history was not found" });
    const body = await new Response(object.body).arrayBuffer();

    const headers = new Headers();
    object.writeHttpMetadata(headers);
    headers.set("cache-control", "private, no-store");
    headers.set("content-type", "application/json; charset=utf-8");
    headers.set("etag", object.httpEtag);
    return new Response(body, { headers });
  } catch (error) {
    console.error("Threadshare API request failed", error);
    return jsonResponse(500, { error: "Unable to process shared history" });
  }
});
