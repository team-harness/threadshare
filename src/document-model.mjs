import MarkdownIt from "markdown-it";

export const DOCUMENT_LIMITS = Object.freeze({
  markdown: 1024 * 1024,
  image: 4 * 1024 * 1024,
  total: 32 * 1024 * 1024,
  images: 32,
  pixels: 16_000_000,
  comment: 32 * 1024,
});
export const ANCHOR_VERSION = "document-anchor-text@1";
export const DOCUMENT_RENDERER = "document-renderer@1";
export const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
export const DIGEST = /^[0-9a-f]{64}$/;
export const bytes = (value) => new TextEncoder().encode(value);
export const escapeHtml = (value) =>
  String(value).replace(
    /[&<>"']/g,
    (c) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[
        c
      ],
  );
export function check(
  condition,
  message = "Invalid document request",
  status = 400,
) {
  if (!condition) throw Object.assign(new Error(message), { status });
}
export function exactKeys(value, allowed, required = allowed) {
  check(value && typeof value === "object" && !Array.isArray(value));
  check(
    Object.keys(value).every((key) => allowed.includes(key)) &&
      required.every((key) => Object.hasOwn(value, key)),
  );
}
export async function sha256(value) {
  return [
    ...new Uint8Array(
      await crypto.subtle.digest(
        "SHA-256",
        typeof value === "string" ? bytes(value) : value,
      ),
    ),
  ]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

// The text stream is generated from the same tokens as the visible spans. Offsets
// are UTF-16; block separators are synthetic newlines, images have no text range.
export function documentModel(markdown, assets = [], assetBase = "") {
  check(
    typeof markdown === "string" &&
      bytes(markdown).length <= DOCUMENT_LIMITS.markdown,
    "Markdown exceeds 1 MiB",
    413,
  );
  // Inspection parses markup but never renders it. Code examples stay code;
  // allowing destinations here exposes unsafe image tokens for rejection below.
  const inspector = new MarkdownIt({ html: true });
  inspector.validateLink = () => true;
  const inspect = (tokens) => {
    for (const token of tokens) {
      if (token.type === "html_inline" || token.type === "html_block")
        check(!/<img\b/i.test(token.content), "HTML images are not supported");
      if (token.type === "image")
        check(
          !/^(?:data|javascript|vbscript):/i.test(token.attrGet("src") ?? ""),
          "Data URL images are not supported",
        );
      if (token.children) inspect(token.children);
    }
  };
  inspect(inspector.parse(markdown, {}));
  const md = new MarkdownIt({
    html: false,
    linkify: false,
    typographer: false,
  });
  const tokens = md.parse(markdown, {});
  const images = [];
  let text = "";
  let hasBlock = false;
  const span = (content) => {
    const start = text.length;
    text += content;
    return `<span data-start="${start}" data-end="${text.length}">${escapeHtml(content)}</span>`;
  };
  const block = () => {
    if (hasBlock) text += "\n";
    hasBlock = true;
  };
  md.renderer.rules.text = (ts, i) => span(ts[i].content);
  md.renderer.rules.code_inline = (ts, i) =>
    `<code>${span(ts[i].content)}</code>`;
  md.renderer.rules.softbreak = () => span("\n");
  md.renderer.rules.hardbreak = () => `${span("\n")}<br>`;
  md.renderer.rules.fence = md.renderer.rules.code_block = (ts, i) => {
    block();
    return `<pre><code>${span(ts[i].content.replace(/\n$/, ""))}</code></pre>\n`;
  };
  md.renderer.rules.image = (ts, i) => {
    const token = ts[i];
    const source = token.attrGet("src");
    check(
      typeof source === "string" && source.length <= 2048,
      "Invalid image path",
    );
    images.push(source);
    const alt = escapeHtml(token.content);
    if (/^https?:\/\//i.test(source)) {
      const url = new URL(source);
      check(
        !url.username && !url.password,
        "Image URLs cannot contain credentials",
      );
      return `<button type="button" class="external-image" data-remote-src="${escapeHtml(source)}">Load image from ${escapeHtml(url.hostname)}: ${alt || "image"}</button>`;
    }
    check(
      !/^(?:[a-z][a-z0-9+.-]*:|\/|\\)/i.test(source),
      "Only relative local images and HTTP(S) images are supported",
    );
    const asset = assets.find((entry) => entry.source === source);
    return asset
      ? `<img src="${escapeHtml(assetBase + asset.sha256)}" alt="${alt}" loading="lazy" referrerpolicy="no-referrer">`
      : `<span class="image-placeholder">${alt || "Image"}</span>`;
  };
  md.renderer.rules.link_open = (ts, i, opts, env, self) => {
    const href = ts[i].attrGet("href") ?? "";
    if (!/^(https?:|mailto:|#)/i.test(href)) ts[i].attrSet("href", "#");
    ts[i].attrSet("rel", "noopener noreferrer");
    return self.renderToken(ts, i, opts);
  };
  // Render sequentially so offsets match document order, including fenced code.
  let html = "";
  for (const token of tokens) {
    if (token.type === "inline") {
      block();
      html += md.renderer.renderInline(token.children ?? [], md.options, {});
    } else html += md.renderer.render([token], md.options, {});
  }
  return {
    text,
    html,
    title: (() => {
      const heading = tokens.findIndex(
        (token) => token.type === "heading_open" && token.tag === "h1",
      );
      return heading >= 0
        ? (tokens[heading + 1]?.children ?? [])
            .map((token) => token.content)
            .join("")
            .trim()
        : null;
    })(),
    images: [...new Set(images)],
    textVersion: ANCHOR_VERSION,
  };
}

export function validateAnchor(text, anchor) {
  exactKeys(anchor, [
    "textVersion",
    "start",
    "end",
    "exact",
    "prefix",
    "suffix",
  ]);
  const { start, end, exact, prefix, suffix } = anchor;
  check(
    anchor.textVersion === ANCHOR_VERSION &&
      Number.isSafeInteger(start) &&
      Number.isSafeInteger(end),
  );
  check(
    start >= 0 && end > start && end <= text.length && end - start <= 2048,
    "Select 1–2048 characters",
  );
  const splitsSurrogate = (at) =>
    at > 0 &&
    /[\uD800-\uDBFF]/.test(text[at - 1]) &&
    /[\uDC00-\uDFFF]/.test(text[at] ?? "");
  check(
    !splitsSurrogate(start) && !splitsSurrogate(end),
    "Selection splits a Unicode character",
  );
  check(
    typeof exact === "string" && exact === text.slice(start, end),
    "Selection does not match this document",
  );
  check(
    prefix === text.slice(Math.max(0, start - 64), start) &&
      suffix === text.slice(end, end + 64),
    "Selection context does not match",
  );
  return anchor;
}

export function validatePublicDocument(doc) {
  exactKeys(doc, [
    "format",
    "id",
    "title",
    "revision",
    "createdAt",
    "expiresAt",
    "revocable",
    "renderer",
    "textVersion",
    "assets",
    "markdown",
  ]);
  check(
    doc.format === "threadshare-document@v1" &&
      UUID.test(doc.id) &&
      DIGEST.test(doc.revision),
    "Invalid document identity",
  );
  check(
    doc.renderer === DOCUMENT_RENDERER && doc.textVersion === ANCHOR_VERSION,
    "Unsupported document rendering version",
  );
  check(
    typeof doc.title === "string" &&
      doc.title.length > 0 &&
      doc.title.length <= 200 &&
      typeof doc.revocable === "boolean",
  );
  check(
    typeof doc.createdAt === "string" &&
      Number.isFinite(Date.parse(doc.createdAt)) &&
      (doc.expiresAt === null ||
        (typeof doc.expiresAt === "string" &&
          Number.isFinite(Date.parse(doc.expiresAt)))),
  );
  check(
    typeof doc.markdown === "string" &&
      bytes(doc.markdown).length <= DOCUMENT_LIMITS.markdown,
  );
  check(
    Array.isArray(doc.assets) && doc.assets.length <= DOCUMENT_LIMITS.images,
  );
  const sources = new Set();
  for (const asset of doc.assets) {
    exactKeys(asset, ["source", "sha256", "bytes", "contentType"]);
    check(
      typeof asset.source === "string" &&
        asset.source.length <= 2048 &&
        !sources.has(asset.source) &&
        DIGEST.test(asset.sha256),
    );
    check(
      Number.isSafeInteger(asset.bytes) &&
        asset.bytes > 0 &&
        asset.bytes <= DOCUMENT_LIMITS.image &&
        ["image/png", "image/jpeg", "image/webp", "image/gif"].includes(
          asset.contentType,
        ),
    );
    sources.add(asset.source);
  }
  return doc;
}
export function validatePublicComment(comment, doc, text) {
  exactKeys(comment, [
    "format",
    "commentId",
    "revision",
    "anchor",
    "authorName",
    "body",
    "serverCreatedAt",
  ]);
  check(
    comment.format === "threadshare-document-comment@v1" &&
      UUID.test(comment.commentId) &&
      comment.revision === doc.revision,
  );
  check(
    typeof comment.authorName === "string" &&
      comment.authorName.trim().length > 0 &&
      comment.authorName.length <= 80,
  );
  check(
    typeof comment.body === "string" &&
      comment.body.trim().length > 0 &&
      comment.body.length <= 4000 &&
      bytes(comment.body).length <= 16384,
  );
  check(
    typeof comment.serverCreatedAt === "string" &&
      Number.isFinite(Date.parse(comment.serverCreatedAt)),
  );
  validateAnchor(text, comment.anchor);
  return comment;
}

export function imageMetadata(input) {
  const data = new Uint8Array(input);
  check(
    data.length > 12 && data.length <= DOCUMENT_LIMITS.image,
    "Image must be at most 4 MiB",
    413,
  );
  const view = new DataView(data.buffer, data.byteOffset, data.byteLength);
  const ascii = (start, end) => String.fromCharCode(...data.slice(start, end));
  let width, height, contentType;
  if (
    data.length >= 33 &&
    ascii(1, 4) === "PNG" &&
    data[0] === 137 &&
    ascii(12, 16) === "IHDR" &&
    ascii(4, 8) === "\r\n\x1a\n"
  ) {
    width = view.getUint32(16);
    height = view.getUint32(20);
    contentType = "image/png";
  } else if (/^GIF8[79]a$/.test(ascii(0, 6))) {
    width = view.getUint16(6, true);
    height = view.getUint16(8, true);
    contentType = "image/gif";
  } else if (data[0] === 255 && data[1] === 216) {
    for (let at = 2; at + 9 < data.length;) {
      check(data[at] === 255, "Invalid JPEG");
      const marker = data[at + 1];
      if (marker === 217 || marker === 218) break;
      const length = view.getUint16(at + 2);
      check(length >= 2 && at + 2 + length <= data.length, "Invalid JPEG");
      if (
        [
          192, 193, 194, 195, 197, 198, 199, 201, 202, 203, 205, 206, 207,
        ].includes(marker)
      ) {
        height = view.getUint16(at + 5);
        width = view.getUint16(at + 7);
        break;
      }
      at += 2 + length;
    }
    contentType = "image/jpeg";
  } else if (
    ascii(0, 4) === "RIFF" &&
    ascii(8, 12) === "WEBP" &&
    data.length >= 30
  ) {
    const kind = ascii(12, 16);
    if (kind === "VP8X") {
      width = 1 + data[24] + (data[25] << 8) + (data[26] << 16);
      height = 1 + data[27] + (data[28] << 8) + (data[29] << 16);
    } else if (kind === "VP8 " && ascii(23, 26) === "\x9d\x01\x2a") {
      width = view.getUint16(26, true) & 0x3fff;
      height = view.getUint16(28, true) & 0x3fff;
    } else if (kind === "VP8L" && data[20] === 0x2f) {
      const bits = view.getUint32(21, true);
      width = (bits & 0x3fff) + 1;
      height = ((bits >>> 14) & 0x3fff) + 1;
    }
    contentType = "image/webp";
  }
  check(
    width > 0 && height > 0 && width * height <= DOCUMENT_LIMITS.pixels,
    "Unsupported image or image exceeds 16 million pixels",
  );
  return { contentType, width, height };
}
