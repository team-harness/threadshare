import { open, realpath } from "node:fs/promises";
import { constants } from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import {
  DOCUMENT_LIMITS as LIMITS,
  check,
  documentModel,
  imageMetadata,
  sha256,
  UUID,
  validatePublicDocument,
  DOCUMENT_RENDERER,
  ANCHOR_VERSION,
} from "./document-model.mjs";
import {
  documentLocation,
  collectDocumentReviews,
  formatDocumentReview,
  readDocumentJson,
} from "./document-read.mjs";
import { cliDiagnostic } from "./cli-contract.mjs";

async function readSnapshot(file, limit) {
  const handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW);
  try {
    const before = await handle.stat({ bigint: true });
    check(
      before.isFile() && before.size > 0 && before.size <= BigInt(limit),
      "File is empty, unsupported, or too large",
    );
    const data = Buffer.alloc(Number(before.size));
    let offset = 0;
    while (offset < data.length) {
      const { bytesRead } = await handle.read(
        data,
        offset,
        data.length - offset,
        offset,
      );
      check(bytesRead > 0, "File changed while reading");
      offset += bytesRead;
    }
    const after = await handle.stat({ bigint: true });
    check(
      before.size === after.size &&
        before.mtimeNs === after.mtimeNs &&
        before.ctimeNs === after.ctimeNs,
      "File changed while reading; retry sharing",
    );
    return data;
  } finally {
    await handle.close();
  }
}
export async function prepareDocument(file, { assetRoot } = {}) {
  check(
    path.extname(file).toLowerCase() === ".md",
    "Only .md documents are supported",
  );
  const documentPath = await realpath(file);
  const root = await realpath(assetRoot ?? path.dirname(documentPath));
  const markdownBytes = await readSnapshot(documentPath, LIMITS.markdown);
  let markdown;
  try {
    markdown = new TextDecoder("utf-8", {
      fatal: true,
      ignoreBOM: true,
    }).decode(markdownBytes);
  } catch {
    check(false, "Markdown must be UTF-8");
  }
  const model = documentModel(markdown);
  const assets = [];
  const data = new Map();
  const externalImages = [];
  for (const source of model.images) {
    if (/^https?:\/\//i.test(source)) {
      externalImages.push(source);
      continue;
    }
    check(
      assets.length < LIMITS.images,
      "At most 32 local images are supported",
    );
    let decoded;
    try {
      decoded = decodeURIComponent(source);
    } catch {
      check(false, "Invalid image path encoding");
    }
    check(
      !/[\0?#]/.test(decoded) &&
        !path.isAbsolute(decoded) &&
        !decoded.includes("\\"),
      "Use relative local image paths without query strings",
    );
    const imagePath = await realpath(
      path.resolve(path.dirname(documentPath), decoded),
    );
    const relative = path.relative(root, imagePath);
    check(
      relative !== ".." &&
        !relative.startsWith(`..${path.sep}`) &&
        !path.isAbsolute(relative),
      "Image escapes asset root; use --asset-root to explicitly include it",
    );
    const image = await readSnapshot(imagePath, LIMITS.image);
    const metadata = imageMetadata(image);
    const digest = await sha256(image);
    data.set(digest, image);
    assets.push({
      source,
      sha256: digest,
      bytes: image.length,
      contentType: metadata.contentType,
    });
    check(
      markdownBytes.length +
        [...data.values()].reduce((sum, item) => sum + item.length, 0) <=
        LIMITS.total,
      "Document and images exceed 32 MiB",
    );
  }
  const title = (
    model.title ||
    path.basename(file, path.extname(file)).trim() ||
    "Document"
  )
    .slice(0, 200)
    .replace(/[\uD800-\uDBFF]$/, "");
  return {
    declaration: {
      title,
      markdown: {
        sha256: await sha256(markdownBytes),
        bytes: markdownBytes.length,
      },
      assets,
    },
    markdownBytes,
    data,
    externalImages,
  };
}

export async function runDocumentCommand(action, reference, options = {}) {
  const { fetchImpl = fetch } = options;
  const endpoint = new URL(options.url);
  check(
    ["http:", "https:"].includes(endpoint.protocol) &&
      !endpoint.username &&
      !endpoint.password &&
      endpoint.pathname === "/" &&
      !endpoint.search &&
      !endpoint.hash,
    "Use a server HTTP(S) origin",
  );
  const allowed = {
    share: ["asset-root", "dry-run", "expires", "revoke", "json", "url"],
    read: ["format", "url"],
    reviews: ["format", "url", "limit", "cursor"],
    revoke: ["token", "json", "url"],
  };
  check(
    Object.hasOwn(allowed, action),
    "Use document share, read, reviews, or revoke",
  );
  for (const option of options.suppliedOptions ?? [])
    check(
      allowed[action].includes(option),
      `--${option} is not valid for document ${action}`,
    );
  const request = (url, init) =>
    fetchImpl(url, {
      ...init,
      redirect: "error",
      signal: AbortSignal.timeout(60000),
    });
  async function rejectKnownFailure(response) {
    if (
      response.status < 400 ||
      response.status >= 500 ||
      [408, 425, 429].includes(response.status)
    )
      return;
    let detail = `Server rejected document request (${response.status})`;
    try {
      const body = await readDocumentJson(
        new Response(response.body, { headers: response.headers }),
        32768,
      );
      if (typeof body.error === "string")
        detail += `: ${body.error.slice(0, 500)}`;
    } catch {
      /* Status alone still proves rejection. */
    }
    throw cliDiagnostic("TS_PUBLISH_REJECTED", detail, {
      command: "document",
      next: "Resolve the reported document or upload error, then share again. Expired upload sessions require a new share.",
    });
  }
  if (action === "share") {
    const prepared = await prepareDocument(reference, options);
    const { declaration, data, markdownBytes } = prepared;
    if (options.expiresInSeconds !== undefined)
      declaration.expiresInSeconds = options.expiresInSeconds;
    const token = options.revoke ? randomBytes(32).toString("base64url") : null;
    if (token) declaration.revokeTokenSha256 = await sha256(token);
    if (options.dryRun)
      return {
        json: true,
        value: {
          dryRun: true,
          valid: true,
          title: declaration.title,
          markdownBytes: markdownBytes.length,
          localImages: declaration.assets.length,
          uniqueImageCount: data.size,
          imageBytes: [...data.values()].reduce(
            (sum, item) => sum + item.length,
            0,
          ),
          externalImageCount: prepared.externalImages.length,
          externalImages: prepared.externalImages,
        },
      };
    const base = `${endpoint.origin}/api/v1/documents`;
    const uploadResponse = await request(`${base}/uploads`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(declaration),
    });
    await rejectKnownFailure(uploadResponse);
    const upload = await readDocumentJson(uploadResponse);
    check(
      UUID.test(upload.id) && /^[A-Za-z0-9_-]{43}$/.test(upload.uploadToken),
      "Invalid upload response",
    );
    const authorization = `Bearer ${upload.uploadToken}`;
    const put = async (suffix, body, type) => {
      const response = await request(`${base}/${upload.id}/uploads/${suffix}`, {
        method: "PUT",
        headers: { authorization, "content-type": type },
        body,
      });
      await rejectKnownFailure(response);
      check(
        response.status === 204,
        `Document upload failed (${response.status}); no publication was attempted`,
      );
    };
    await put("markdown", markdownBytes, "text/markdown; charset=utf-8");
    for (const [digest, image] of data)
      await put(
        `assets/${digest}`,
        image,
        declaration.assets.find((item) => item.sha256 === digest).contentType,
      );
    const url = `${endpoint.origin}/document.html?id=${upload.id}`;
    let published;
    try {
      const response = await request(`${base}/${upload.id}/publish`, {
        method: "POST",
        headers: { authorization },
      });
      await rejectKnownFailure(response);
      published = await readDocumentJson(response);
      const expires =
        published.expiresAt === null ? null : Date.parse(published.expiresAt);
      check(
        published.id === upload.id &&
          published.revocable === !!token &&
          (options.expiresInSeconds === undefined
            ? expires === null
            : Number.isFinite(expires) &&
              expires > Date.now() &&
              expires <= Date.now() + options.expiresInSeconds * 1000) &&
          published.revision ===
            (await sha256(
              JSON.stringify({
                markdown: declaration.markdown,
                assets: declaration.assets,
                renderer: DOCUMENT_RENDERER,
                textVersion: ANCHOR_VERSION,
              }),
            )),
        "Document publication could not be verified",
      );
    } catch (error) {
      if (error.code === "TS_PUBLISH_REJECTED") throw error;
      throw cliDiagnostic(
        "TS_PUBLISH_OUTCOME_UNKNOWN",
        "Document publication was not confirmed. It may already exist; do not create a duplicate automatically.",
        {
          command: "document",
          result: url,
          next: "Read this document URL to verify it; retain the capability below if revocation was requested.",
          secretLines: token
            ? [
                `Unconfirmed revoke capability (secret, save privately): ${token}`,
              ]
            : [],
        },
      );
    }
    return {
      json: options.json,
      value: {
        id: upload.id,
        url,
        revision: published.revision,
        ...(published.expiresAt ? { expiresAt: published.expiresAt } : {}),
        ...(token ? { revocable: true, revokeToken: token } : {}),
      },
    };
  }
  const location = documentLocation(reference, endpoint.origin);
  if (action === "revoke") {
    check(
      /^[A-Za-z0-9_-]{43}$/.test(options.token ?? ""),
      "Provide the saved revoke token with --token",
    );
    const response = await request(
      `${location.base}/api/v1/documents/${location.id}`,
      {
        method: "DELETE",
        headers: { authorization: `Bearer ${options.token}` },
      },
    );
    check(
      response.status === 204,
      `Document revoke failed (${response.status})`,
    );
    return { json: options.json, value: { id: location.id, revoked: true } };
  }
  const format = options.format ?? "agent";
  check(
    ["agent", "json", "markdown"].includes(format),
    "Use --format agent, json, or markdown",
  );
  if (action === "read" && format !== "agent") {
    const doc = validatePublicDocument(
      await readDocumentJson(
        await request(`${location.base}/api/v1/documents/${location.id}`, {}),
      ),
    );
    check(
      doc.format === "threadshare-document@v1" &&
        typeof doc.markdown === "string",
      "Invalid document response",
    );
    return {
      json: format === "json",
      value: format === "json" ? doc : doc.markdown,
    };
  }
  const limit = options.limit === undefined ? 1000 : Number(options.limit);
  check(
    Number.isInteger(limit) && limit >= 1 && limit <= 1000,
    "Review limit must be 1–1000",
  );
  const report = await collectDocumentReviews(location, {
    fetchImpl,
    maxComments: limit,
    initialCursor: options.cursor ?? null,
  });
  return {
    json: format === "json",
    value:
      format === "json"
        ? report
        : formatDocumentReview(report, { includeDocument: action === "read" }),
  };
}
