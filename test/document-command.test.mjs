import assert from "node:assert/strict";
import test from "node:test";
import { mkdtemp, writeFile, symlink, rm, mkdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { createServer } from "node:http";
import {
  prepareDocument,
  runDocumentCommand,
} from "../src/document-command.mjs";
import { createDocumentService } from "../src/document-service.mjs";
import { memoryStore } from "./helpers/document-store.mjs";
const exec = promisify(execFile);
const png = Buffer.from(
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+a9S8AAAAASUVORK5CYII=",
  "base64",
);

test("CLI shares a frozen Markdown/image snapshot, reads and revokes through HTTP", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "document-cli-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await writeFile(path.join(dir, "image.png"), png);
  await writeFile(
    path.join(dir, "design.md"),
    "# Review me\n\n![image](image.png)\n\nHello world.",
  );
  const service = createDocumentService(memoryStore());
  const server = createServer(async (req, res) => {
    const chunks = [];
    for await (const chunk of req) chunks.push(chunk);
    const response = await service(
      new Request(`http://127.0.0.1:${server.address().port}${req.url}`, {
        method: req.method,
        headers: req.headers,
        ...(!["GET", "HEAD"].includes(req.method)
          ? { body: Buffer.concat(chunks) }
          : {}),
      }),
    );
    res.writeHead(response.status, Object.fromEntries(response.headers));
    res.end(Buffer.from(await response.arrayBuffer()));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  t.after(() => {
    server.closeAllConnections();
    server.close();
  });
  const base = `http://127.0.0.1:${server.address().port}`;
  const cli = async (...args) =>
    JSON.parse(
      (
        await exec(process.execPath, [
          "bin/threadshare.mjs",
          "document",
          ...args,
        ])
      ).stdout,
    );
  const dry = await cli(
    "share",
    path.join(dir, "design.md"),
    "--dry-run",
    "--json",
    "--url",
    base,
  );
  assert.equal(dry.localImages, 1);
  assert.equal(dry.dryRun, true);
  const shared = await cli(
    "share",
    path.join(dir, "design.md"),
    "--json",
    "--revoke",
    "--url",
    base,
  );
  assert.match(shared.url, /document.html\?id=/);
  assert.equal(shared.revokeToken.length, 43);
  const read = await cli("read", shared.url, "--format", "json");
  assert.equal(read.title, "Review me");
  assert.equal(read.assets.length, 1);
  const image = await fetch(
    `${base}/api/v1/documents/${shared.id}/assets/${read.assets[0].sha256}`,
  );
  assert.deepEqual(Buffer.from(await image.arrayBuffer()), png);
  const report = await cli("reviews", shared.url, "--format", "json");
  assert.equal(report.complete, true);
  assert.deepEqual(report.comments, []);
  assert.equal(
    (await cli("revoke", shared.url, "--token", shared.revokeToken, "--json"))
      .revoked,
    true,
  );
  assert.equal(
    (await fetch(`${base}/api/v1/documents/${shared.id}`)).status,
    404,
  );
});
test("asset-root is explicit, realpath bounded, and bytes are frozen before upload", async (t) => {
  const dir = await mkdtemp(path.join(os.tmpdir(), "document-assets-"));
  t.after(() => rm(dir, { recursive: true, force: true }));
  await mkdir(path.join(dir, "docs"));
  await writeFile(path.join(dir, "image.png"), png);
  const file = path.join(dir, "docs/design.md");
  await writeFile(file, "![x](../image.png)");
  await assert.rejects(prepareDocument(file), /escapes asset root/);
  const prepared = await prepareDocument(file, { assetRoot: dir });
  assert.equal(prepared.data.size, 1);
  await writeFile(path.join(dir, "image.png"), "modified");
  assert.deepEqual([...prepared.data.values()][0], png);
  await symlink(path.join(dir, "image.png"), path.join(dir, "docs/link.png"));
  await writeFile(file, "![x](link.png)");
  await assert.rejects(prepareDocument(file), /escapes asset root/);
  await assert.rejects(
    runDocumentCommand("share", file, {
      url: "https://test.local",
      suppliedOptions: ["token"],
    }),
    /not valid/,
  );
});

test("known upload/publication rejection is distinct from a lost publication response", async () => {
  for (const stage of ["uploads", "uploads/markdown", "publish"]) {
    const service = createDocumentService(memoryStore());
    await assert.rejects(
      runDocumentCommand("share", "test/fixtures/document-review.md", {
        url: "https://test.local",
        fetchImpl: async (url, init) =>
          url.endsWith(`/${stage}`)
            ? new Response(JSON.stringify({ error: "Upload expired" }), {
                status: 410,
                headers: { "content-type": "application/json" },
              })
            : service(new Request(url, init)),
      }),
      (error) =>
        error.code === "TS_PUBLISH_REJECTED" &&
        /Upload expired/.test(error.message),
    );
  }
  const service = createDocumentService(memoryStore());
  let committed = false;
  await assert.rejects(
    runDocumentCommand("share", "test/fixtures/document-review.md", {
      url: "https://test.local",
      revoke: true,
      fetchImpl: async (url, init) => {
        const response = await service(new Request(url, init));
        if (url.endsWith("/publish")) {
          assert.equal(response.status, 201);
          committed = true;
          throw new Error("Disconnected");
        }
        return response;
      },
    }),
    (error) => error.code === "TS_PUBLISH_OUTCOME_UNKNOWN",
  );
  assert.equal(committed, true);
});
