import { defineHandler } from "void";
import { storage } from "void/storage";
import { isShareId } from "../../../../src/share-schema";

export const GET = defineHandler(async (context) => {
  const id = context.req.param("id");
  if (!isShareId(id)) return context.notFound();

  const object = await storage.get(`shares/${id}.json`);
  if (!object) return context.notFound();

  const headers = new Headers({
    "cache-control": "private, no-store",
    "content-type": "application/json; charset=utf-8",
  });
  object.writeHttpMetadata(headers);
  headers.set("etag", object.httpEtag);
  return new Response(object.body, { headers });
});
