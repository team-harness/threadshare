import assert from "node:assert/strict";
import test from "node:test";
import {
  documentModel,
  validateAnchor,
  imageMetadata,
} from "../src/document-model.mjs";

test("shared Markdown text uses rendered entities, code, Unicode and deterministic blocks", () => {
  const model = documentModel(
    "# Hello &amp; **世界**\n\nSame 😀 text.\n\nSame 😀 text.",
  );
  assert.equal(model.text, "Hello & 世界\nSame 😀 text.\nSame 😀 text.");
  assert.equal(model.title, "Hello & 世界");
  const start = model.text.lastIndexOf("Same");
  const anchor = {
    textVersion: "document-anchor-text@1",
    start,
    end: start + 4,
    exact: "Same",
    prefix: model.text.slice(Math.max(0, start - 64), start),
    suffix: model.text.slice(start + 4, start + 68),
  };
  assert.deepEqual(validateAnchor(model.text, anchor), anchor);
  assert.throws(() => validateAnchor(model.text, { ...anchor, start: 0 }));
  assert.match(model.html, /data-start=/);
  assert.doesNotMatch(
    documentModel("<script>alert(1)</script>").html,
    /<script>/,
  );
});

test("reference images are inventoried, code is not, remote images require opt-in", () => {
  const model = documentModel(
    "![x][ref]\n\n[ref]: ./a.png\n\n`![fake](b.png)`\n\n![remote](https://example.com/a.png)",
  );
  assert.deepEqual(model.images, ["./a.png", "https://example.com/a.png"]);
  assert.match(model.html, /data-remote-src=/);
  assert.doesNotMatch(model.html, /<img[^>]*https:/);
  assert.throws(() => documentModel('<img src="local.png">'));
  assert.throws(() => documentModel("![x](data:image/png;base64,YQ==)"));
});

test("image validation checks signature and dimensions instead of extension", () => {
  const png = Buffer.from(
    "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=",
    "base64",
  );
  assert.deepEqual(imageMetadata(png), {
    contentType: "image/png",
    width: 1,
    height: 1,
  });
  assert.throws(() => imageMetadata(Buffer.from("<svg/>")));
  const huge = Buffer.from(png);
  huge.writeUInt32BE(17000000, 16);
  assert.throws(() => imageMetadata(huge));
});

test("HTML and data image examples inside code remain literal text", () => {
  const model = documentModel(
    '```html\n<img src="local.png">\n![x](data:image/png;base64,YQ==)\n```\n\n`<img src="inline.png">`',
  );
  assert.deepEqual(model.images, []);
  assert.match(model.text, /<img src="local.png">/);
  assert.doesNotMatch(model.html, /<img\b/);
  assert.throws(() => documentModel('outside <img src="local.png">'));
  assert.throws(() =>
    documentModel("![x][unsafe]\n\n[unsafe]: data:image/png;base64,YQ=="),
  );
  assert.equal(
    documentModel("```md\n# Fake title\n```\n\n# Real title").title,
    "Real title",
  );
});
