import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";
import { createTestHarness, unstable_readConfig } from "wrangler";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const ID = "733f4878-3f77-4875-965d-a3e3c399b79c";
const history = {
  format: "threadshare-history@v1",
  schemaVersion: 1,
  exportedAt: "2026-08-02T00:00:00.000Z",
  conversation: { id: "routing-test", title: "Routing test" },
  entries: [
    {
      id: "message-1",
      createdAt: "2026-08-02T00:00:00.000Z",
      kind: "message",
      role: "user",
      markdown: "Review the Worker route.",
    },
  ],
};

test("routes negotiated Viewer documents through the Worker before static assets", async (t) => {
  const config = unstable_readConfig(
    { config: path.join(root, "wrangler.jsonc") },
    { hideWarnings: true },
  );
  assert.equal(config.assets?.run_worker_first, true);

  const server = createTestHarness({ root, workers: [{ configPath: "wrangler.jsonc" }] });
  t.after(() => server.close());
  await server.listen();

  const env = await server.getWorker().getEnv();
  await env.THREADSHARE_BUCKET.put(`shares/${ID}.json`, JSON.stringify(history));

  const viewer = await server.fetch(`/?id=${ID}`, {
    headers: { accept: "text/html" },
  });
  assert.equal(viewer.status, 200);
  assert.match(viewer.headers.get("content-type") ?? "", /^text\/html\b/);
  assert.equal(viewer.headers.get("cache-control"), "no-store");
  assert.match(viewer.headers.get("vary") ?? "", /(?:^|,\s*)Accept(?:\s*,|$)/i);
  assert.equal(
    viewer.headers.get("link"),
    `</?id=${ID}&format=agent>; rel="alternate"; type="text/markdown"`,
  );

  const agent = await server.fetch(`/?id=${ID}&format=agent`);
  assert.equal(agent.status, 200);
  assert.equal(agent.headers.get("content-type"), "text/markdown; charset=utf-8");
  assert.equal(agent.headers.get("x-threadshare-format"), "agent-transcript@v1");
  assert.match(await agent.text(), /Review the Worker route\./);

  const api = await server.fetch(`/api/v1/shares/${ID}`, {
    headers: { accept: "text/markdown" },
  });
  assert.equal(api.status, 200);
  assert.match(api.headers.get("content-type") ?? "", /^application\/json\b/);
  assert.equal(api.headers.get("x-threadshare-format"), null);
  assert.deepEqual(await api.json(), history);

  const post = await server.fetch("/", { method: "POST" });
  assert.equal(post.status, 405);
  assert.equal(post.headers.get("allow"), "GET, HEAD");
  assert.equal(post.headers.get("cache-control"), "no-store");
  assert.deepEqual(await post.json(), { error: "Method not allowed" });

  const index = await server.fetch(`/index.html?id=${ID}`, {
    headers: { accept: "text/html" },
    redirect: "manual",
  });
  assert.equal(index.status, 200);
  assert.equal(index.headers.get("cache-control"), "no-store");

  const builtHtml = await readFile(path.join(root, "dist", "index.html"), "utf8");
  const assetPath = /(?:src|href)="(\/assets\/[^"]+)"/u.exec(builtHtml)?.[1];
  assert.ok(assetPath, "the production build must reference a hashed static asset");
  const asset = await server.fetch(assetPath);
  assert.equal(asset.status, 200);
  assert.notEqual(asset.headers.get("cache-control"), "no-store");
  assert.equal(asset.headers.get("x-threadshare-format"), null);
});
