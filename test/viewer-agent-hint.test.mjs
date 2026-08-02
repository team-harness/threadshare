import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

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
