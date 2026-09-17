// Opt-in deployed browser smoke. Creates only synthetic, 60-second shares.
// Run: node scripts/smoke-share-cors.mjs https://your-deployed-origin
// Open the printed loopback URL in a real browser (not a Node fetch substitute).
import { createServer } from "node:http";
import { randomBytes, randomUUID, createHash } from "node:crypto";

const targets = process.argv.slice(2).map(value => {
  const url = new URL(value);
  if (url.protocol !== "https:" || url.href !== `${url.origin}/`) {
    throw new Error("Provide HTTPS service origins without paths, query, or credentials");
  }
  return url.origin;
});
if (!targets.length) throw new Error("Usage: node scripts/smoke-share-cors.mjs <https://origin> [...origins]");
const token = randomBytes(32).toString("base64url");
const digest = createHash("sha256").update(token).digest("base64url");
const runId = randomUUID();
const history = {
  format: "threadshare-history@v1", schemaVersion: 1, exportedAt: new Date().toISOString(),
  conversation: { id: runId, title: "Synthetic browser CORS regression" }, entries: [],
};
const config = JSON.stringify({ targets, digest, history }).replace(/</g, "\\u003c");
const html = `<!doctype html><meta charset="utf-8"><title>Threadshare browser CORS smoke</title>
<h1>浏览器跨域分享回归</h1><p>仅上传空的合成会话，60 秒到期；可读取到 ID 的测试分享会在完成后撤销。</p>
<pre id="result">Running…</pre><script>
const config = ${config};
(async () => {
  const results = [];
  for (const base of config.targets) {
    const result = { base, pass: false };
    results.push(result);
    try {
      const options = { method: "POST", credentials: "omit", headers: { "content-type": "application/json" } };
      const invalid = await fetch(base + "/api/v1/shares", { ...options, body: "{}" });
      result.invalidStatus = invalid.status;
      if (invalid.status !== 400) throw new Error("Invalid payload should return readable 400");
      const response = await fetch(base + "/api/v1/shares", { ...options,
        headers: { ...options.headers, "x-threadshare-expires-in": "60", "x-threadshare-revoke-token-sha256": config.digest },
        body: JSON.stringify(config.history) });
      result.createStatus = response.status;
      const created = await response.json();
      result.id = created.id;
      if (response.status !== 201 || !created.revocable || !created.expiresAt) throw new Error("Creation/lifecycle failed");
      const loaded = await fetch(base + "/api/v1/shares/" + created.id, { credentials: "omit" });
      result.readStatus = loaded.status;
      const exported = await loaded.json();
      if (loaded.status !== 200 || exported.conversation.id !== config.history.conversation.id) throw new Error("Read-back mismatch");
      if (loaded.headers.get("x-threadshare-expires-at") !== created.expiresAt) throw new Error("Expiry header is not exposed");
      result.pass = true;
    } catch (error) { result.error = String(error); }
  }
  document.getElementById("result").textContent = JSON.stringify(results, null, 2);
  const report = await fetch("/report", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(results) });
  document.getElementById("result").textContent += "\\n" + await report.text();
})();
</script>`;
let origin;
let reporting = false;
const server = createServer(async (request, response) => {
  if (request.headers.host !== new URL(origin).host) { response.writeHead(403).end(); return; }
  if (request.method === "GET" && request.url === "/") {
    response.writeHead(200, { "content-type": "text/html; charset=utf-8", "cache-control": "no-store" }).end(html);
    return;
  }
  if (request.method !== "POST" || request.url !== "/report" || request.headers.origin !== origin || reporting) {
    response.writeHead(403).end(); return;
  }
  reporting = true;
  // Chromium may leave a speculative loopback connection open. Close it only
  // after the report response has been flushed, so this one-shot command exits.
  response.once("finish", () => server.closeAllConnections());
  try {
    let body = "";
    for await (const chunk of request) {
      body += chunk;
      if (body.length > 16384) throw new Error("Report too large");
    }
    const results = JSON.parse(body);
    if (!Array.isArray(results) || results.length !== targets.length || results.some((r, i) => r.base !== targets[i])) {
      throw new Error("Unexpected report targets");
    }
    for (const result of results) {
      if (!/^[0-9a-f-]{36}$/.test(result.id || "")) continue;
      const removed = await fetch(`${result.base}/api/v1/shares/${result.id}`, {
        method: "DELETE", headers: { authorization: `Bearer ${token}` }, signal: AbortSignal.timeout(15000),
      });
      result.cleanupStatus = removed.status;
      if (removed.status !== 204) result.pass = false;
    }
    console.log(JSON.stringify({ runId, results }));
    process.exitCode = results.every(r => r.pass === true) ? 0 : 1;
    response.writeHead(200, { "content-type": "text/plain" }).end("Completed; see terminal for cleanup results.");
  } catch (error) {
    process.exitCode = 1;
    console.error(String(error));
    response.writeHead(500).end("Smoke failed; synthetic shares expire after 60 seconds.");
  } finally {
    clearTimeout(deadline);
    server.close();
    server.closeIdleConnections();
  }
});
const deadline = setTimeout(() => {
  console.error("Timed out waiting for browser report; synthetic shares expire after 60 seconds.");
  process.exitCode = 1;
  server.close();
  server.closeAllConnections();
}, 180000);
server.listen(0, "127.0.0.1", () => {
  origin = `http://127.0.0.1:${server.address().port}`;
  console.log(`Open in a browser: ${origin}/`);
});
