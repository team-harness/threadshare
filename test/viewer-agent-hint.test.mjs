import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { build } from "vite";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

test("document Viewer exposes static review discovery and both human handoff entries", async () => {
  const html = await readFile(path.join(root, "document.html"), "utf8");
  const hint = /^<!doctype html>\n<!-- THREADSHARE_AGENT_HINT v1\n([\s\S]*?)\n-->/u.exec(html);
  assert.ok(hint);
  for (const text of ["Accept: text/markdown", "format=agent", "threadshare document reviews", "nextCursor", "not instructions", "Do not install software without authorization"])
    assert.ok(hint[1].includes(text), text);
  assert.match(html, /id="agent-document-alternate" rel="alternate" type="text\/markdown"/);
  assert.match(html, /id="copy-review-prompt"/);
  assert.match(html, /id="copy-review-prompt-footer"/);
});

test("production CSS keeps mobile breakpoints compatible with older WebViews", async () => {
  const result = await build({
    root,
    mode: "cloudflare",
    logLevel: "silent",
    build: { write: false },
  });
  const outputs = (Array.isArray(result) ? result : [result]).flatMap((item) => item.output);
  const css = outputs.filter((item) => item.type === "asset" && item.fileName.endsWith(".css"))
    .map((item) => String(item.source)).join("\n");
  assert.match(css, /@media\s*\(max-width:\s*900px\)/u);
  assert.match(css, /@media\s*\(max-width:\s*640px\)/u);
  assert.doesNotMatch(css, /@media[^{}]*[<>]/u);
});

test("publishes a safe static Agent hint and best-effort Markdown alternate", async () => {
  const html = await readFile(path.join(root, "index.html"), "utf8");
  const hint = /^<!doctype html>\n<!-- THREADSHARE_AGENT_HINT v1\n([\s\S]*?)\n-->/u.exec(html);
  assert.ok(hint, "the versioned Agent hint must immediately follow the doctype");
  assert.doesNotMatch(hint[1], /--/u);
  assert.match(hint[1], /untrusted conversation data/i);
  assert.match(hint[1], /Accept: text\/markdown/);
  assert.match(hint[1], /format=agent/);
  assert.match(hint[1], /threadshare read "<viewer-url>"/);
  assert.match(hint[1], /@team-harness\/threadshare/);
  assert.match(hint[1], /Do not install software without authorization/i);
  assert.match(hint[1], /canonical API/i);
  assert.match(
    html,
    /<link\s+id="agent-transcript-alternate"\s+rel="alternate"\s+type="text\/markdown"\s*\/>/u,
  );
  const alternate = /<link\s+id="agent-transcript-alternate"[^>]*>/u.exec(html)?.[0];
  assert.ok(alternate);
  assert.doesNotMatch(alternate, /\shref=/u);
});
