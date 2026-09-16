export function documentR2Store(bucket) {
  return {
    async get(key) {
      const object = await bucket.get(key);
      return object
        ? new Uint8Array(await new Response(object.body).arrayBuffer())
        : null;
    },
    async create(key, value, contentType) {
      const result = await bucket.put(key, value, {
        onlyIf: { etagDoesNotMatch: "*" },
        httpMetadata: { contentType },
      });
      return result !== null;
    },
    async list(prefix, cursor, limit) {
      const page = await bucket.list({
        prefix,
        limit,
        ...(cursor ? { cursor } : {}),
      });
      return {
        keys: page.objects.map((object) => object.key),
        cursor: page.truncated ? page.cursor : null,
      };
    },
    async delete(key) {
      await bucket.delete(key);
    },
  };
}
