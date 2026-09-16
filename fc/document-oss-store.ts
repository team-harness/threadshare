import { createHmac } from "node:crypto";

// OSS V1 canonical resource excludes ordinary ListObjects query parameters.
// x-oss-forbid-overwrite is signed and enforced by OSS, never emulated by GET.
export function documentOssStore(
  environment: Record<string, string | undefined>,
  fetchImpl = fetch,
) {
  const setting = (name: string) => {
    const value =
      environment[`THREADSHARE_OSS_${name}`] ??
      environment[`CHAT_SHARE_OSS_${name}`];
    if (!value) throw new Error("Document object storage is not configured");
    return value;
  };
  async function request(
    method: string,
    key: string,
    body?: string | Uint8Array,
    contentType = "",
    query = "",
    createOnly = true,
  ) {
    const bucket = setting("BUCKET");
    const date = new Date().toUTCString();
    const immutable = method === "PUT" && createOnly;
    const canonicalHeaders = immutable ? "x-oss-forbid-overwrite:true\n" : "";
    const resource = `/${bucket}/${key}`;
    const signature = createHmac("sha1", setting("ACCESS_KEY_SECRET"))
      .update(
        [method, "", contentType, date, canonicalHeaders + resource].join("\n"),
      )
      .digest("base64");
    const headers: Record<string, string> = {
      date,
      authorization: `OSS ${setting("ACCESS_KEY_ID")}:${signature}`,
    };
    if (immutable) headers["x-oss-forbid-overwrite"] = "true";
    if (contentType) headers["content-type"] = contentType;
    const url = `https://${bucket}.oss-${setting("REGION")}.aliyuncs.com/${key.split("/").map(encodeURIComponent).join("/")}${query}`;
    return fetchImpl(url, { method, headers, body, redirect: "error", signal: AbortSignal.timeout(5000) });
  }
  const xmlText = (value: string) =>
    value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity) => {
      if (entity[0] === "#")
        return String.fromCodePoint(
          entity[1].toLowerCase() === "x"
            ? parseInt(entity.slice(2), 16)
            : Number(entity.slice(1)),
        );
      return (
        { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'" } as Record<
          string,
          string
        >
      )[entity];
    });
  return {
    async saveMaintenanceCursor(cursor: string | null) {
      const response = await request(
        "PUT",
        "document-maintenance-cursor.json",
        JSON.stringify({ cursor }),
        "application/json",
        "",
        false,
      );
      if (!response.ok) throw new Error("Unable to save maintenance cursor");
    },
    async get(key: string) {
      const response = await request("GET", key);
      if (response.status === 404) return null;
      if (!response.ok) throw new Error("Document storage read failed");
      return new Uint8Array(await response.arrayBuffer());
    },
    async create(key: string, value: string | Uint8Array, type: string) {
      const response = await request("PUT", key, value, type);
      if (response.status === 409 || response.status === 412) {
        const error = await response.text();
        if (
          /<Code>(?:FileAlreadyExists|PreconditionFailed)<\/Code>/.test(error)
        )
          return false;
      }
      if (!response.ok) throw new Error("Document storage create failed");
      return true;
    },
    async list(prefix: string, cursor: string | null, limit: number) {
      if (cursor && !cursor.startsWith(prefix))
        throw Object.assign(new Error("Invalid cursor"), { status: 400 });
      const query = new URLSearchParams({
        prefix,
        "max-keys": String(limit),
        ...(cursor ? { marker: cursor } : {}),
      });
      const response = await request("GET", "", undefined, "", `?${query}`);
      if (!response.ok) throw new Error("Document storage listing failed");
      const xml = await response.text();
      if (xml.length > 1024 * 1024 || !xml.includes("<ListBucketResult"))
        throw new Error("Invalid storage list response");
      const keys = [
        ...xml.matchAll(
          /<Contents>\s*[\s\S]*?<Key>([\s\S]*?)<\/Key>[\s\S]*?<\/Contents>/g,
        ),
      ].map((match) => xmlText(match[1]));
      if (keys.length > limit || keys.some((key) => !key.startsWith(prefix)))
        throw new Error("Storage listing escaped prefix");
      const truncated = /<IsTruncated>true<\/IsTruncated>/.test(xml);
      const next = xml.match(/<NextMarker>([\s\S]*?)<\/NextMarker>/)?.[1];
      if (truncated && !next) throw new Error("Missing storage continuation");
      return { keys, cursor: truncated ? xmlText(next!) : null };
    },
    async delete(key: string) {
      const response = await request("DELETE", key);
      if (!response.ok && response.status !== 404)
        throw new Error("Document storage deletion failed");
    },
  };
}
