import { execFile } from "node:child_process";
import { randomBytes, randomUUID, timingSafeEqual } from "node:crypto";
import { createServer } from "node:http";
import { open, readFile, unlink } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { secureInsightsFile } from "./insights-state.mjs";

const DASHBOARD_FILES = Object.freeze({
  "/": Object.freeze({ file: "index.html", type: "text/html; charset=utf-8" }),
  "/app.js": Object.freeze({ file: "app.js", type: "text/javascript; charset=utf-8" }),
  "/state.js": Object.freeze({ file: "state.js", type: "text/javascript; charset=utf-8" }),
  "/styles.css": Object.freeze({ file: "styles.css", type: "text/css; charset=utf-8" }),
});

const MAX_ASSET_BYTES = 512 * 1024;
const MAX_FORM_BYTES = 1024;
const MAX_JSON_BYTES = 32 * 1024;
const SESSION_COOKIE = "threadshare_insights_session";
const APP_CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self'",
  "img-src 'self' data:",
  "connect-src 'self'",
  "object-src 'none'",
  "base-uri 'none'",
  "form-action 'none'",
  "frame-ancestors 'none'",
].join("; ");

function dashboardError(code, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

function sameSecret(left, right) {
  if (typeof left !== "string" || typeof right !== "string") return false;
  const leftBytes = Buffer.from(left, "utf8");
  const rightBytes = Buffer.from(right, "utf8");
  return leftBytes.length === rightBytes.length && timingSafeEqual(leftBytes, rightBytes);
}

function escapeHtml(value) {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll('"', "&quot;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;");
}

function bootstrapDocument({ authority, secret, nonce }) {
  const action = `http://${authority}/`;
  const csp = [
    "default-src 'none'",
    `script-src 'nonce-${nonce}'`,
    `form-action ${action}`,
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8">
  <meta name="referrer" content="no-referrer">
  <meta http-equiv="Content-Security-Policy" content="${escapeHtml(csp)}">
  <title>Threadshare Insights</title>
</head>
<body>
  <form id="bootstrap" method="post" action="${escapeHtml(action)}">
    <input type="hidden" name="secret" value="${escapeHtml(secret)}">
  </form>
  <script nonce="${nonce}">document.getElementById("bootstrap").submit();</script>
</body>
</html>
`;
}

async function writeBootstrapFile(paths, authority, secret, options) {
  const nonce = randomBytes(18).toString("base64url");
  const file = path.join(
    paths.tempDirectory,
    `.dashboard-bootstrap-${process.pid}-${randomUUID()}.html`,
  );
  const handle = await open(file, "wx", 0o600);
  try {
    await handle.writeFile(bootstrapDocument({ authority, secret, nonce }), "utf8");
    await handle.sync();
  } finally {
    await handle.close();
  }
  await secureInsightsFile(file, options.stateOptions);
  return file;
}

function defaultOpenBrowser(file) {
  const command = process.platform === "darwin"
    ? { executable: "open", arguments: [file] }
    : process.platform === "win32"
      ? { executable: "explorer.exe", arguments: [file] }
      : { executable: "xdg-open", arguments: [file] };
  const child = execFile(command.executable, command.arguments, {
    windowsHide: true,
  }, () => {});
  child.unref();
  return Object.freeze({ executable: command.executable, arguments: Object.freeze([...command.arguments]) });
}

async function loadAssets(directory) {
  const assets = new Map();
  for (const [urlPath, descriptor] of Object.entries(DASHBOARD_FILES)) {
    const content = await readFile(path.join(directory, descriptor.file));
    if (content.length === 0 || content.length > MAX_ASSET_BYTES) {
      throw dashboardError(
        "TS_INSIGHTS_DASHBOARD_ASSET_INVALID",
        "Insights Dashboard asset is empty or exceeds its size limit",
      );
    }
    assets.set(urlPath, Object.freeze({ ...descriptor, content }));
  }
  return assets;
}

function responseHeaders(contentType, csp = APP_CSP) {
  return {
    "Cache-Control": "no-store",
    "Content-Security-Policy": csp,
    "Content-Type": contentType,
    "Cross-Origin-Opener-Policy": "same-origin",
    "Referrer-Policy": "no-referrer",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
  };
}

function send(response, status, body, contentType = "text/plain; charset=utf-8", headers = {}) {
  response.writeHead(status, { ...responseHeaders(contentType), ...headers });
  response.end(body);
}

function sendJson(response, status, value) {
  send(response, status, `${JSON.stringify(value)}\n`, "application/json; charset=utf-8");
}

function safeErrorCode(error) {
  return typeof error?.code === "string" && /^(?:TS_|QUERY_|EVIDENCE_)[A-Z0-9_]+$/u.test(error.code)
    ? error.code
    : "TS_OPERATION_FAILED";
}

function hostHeader(request) {
  let count = 0;
  let value = null;
  for (let index = 0; index < request.rawHeaders.length; index += 2) {
    if (request.rawHeaders[index].toLowerCase() !== "host") continue;
    count += 1;
    value = request.rawHeaders[index + 1];
  }
  return count === 1 ? value : null;
}

function requestPath(request, authority) {
  if (typeof request.url !== "string" || !request.url.startsWith("/") || request.url.startsWith("//")) {
    throw dashboardError("TS_INSIGHTS_DASHBOARD_REQUEST_INVALID", "Invalid request target");
  }
  return new URL(request.url, `http://${authority}`);
}

function cookieValue(request, name) {
  const raw = request.headers.cookie;
  if (typeof raw !== "string") return null;
  for (const item of raw.split(";")) {
    const separator = item.indexOf("=");
    if (separator < 0) continue;
    if (item.slice(0, separator).trim() === name) return item.slice(separator + 1).trim();
  }
  return null;
}

async function readBody(request, limit) {
  const chunks = [];
  let size = 0;
  for await (const chunk of request) {
    size += chunk.length;
    if (size > limit) {
      throw dashboardError("TS_INSIGHTS_DASHBOARD_BODY_TOO_LARGE", "Request body is too large");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString("utf8");
}

function assertOrigin(request, expected) {
  if (request.headers.origin !== expected) {
    throw dashboardError("TS_INSIGHTS_DASHBOARD_ORIGIN_REJECTED", "Request origin is not allowed");
  }
}

function authenticated(request, sessionSecret) {
  return sameSecret(cookieValue(request, SESSION_COOKIE), sessionSecret);
}

async function closeServer(server) {
  if (!server.listening) return;
  await new Promise((resolve, reject) => {
    server.close((error) => error === undefined ? resolve() : reject(error));
    server.closeIdleConnections?.();
  });
}

export async function createInsightsDashboardServer(options = {}) {
  if (!options.api || typeof options.api !== "object") {
    throw new TypeError("api is required");
  }
  const paths = options.paths;
  if (!paths || typeof paths.tempDirectory !== "string") {
    throw new TypeError("paths.tempDirectory is required");
  }
  const assetsDirectory = options.assetsDirectory ?? fileURLToPath(
    new URL("../insights-dashboard/", import.meta.url),
  );
  const assets = await loadAssets(assetsDirectory);
  const host = options.host ?? "127.0.0.1";
  const port = options.port ?? 0;
  if (host !== "127.0.0.1") {
    throw dashboardError(
      "TS_INSIGHTS_DASHBOARD_BIND_REJECTED",
      "Insights Dashboard must bind the numeric loopback address",
    );
  }
  if (!Number.isSafeInteger(port) || port < 0 || port > 65_535) {
    throw new RangeError("port must be an integer between 0 and 65535");
  }

  const bootstrapSecret = randomBytes(32).toString("base64url");
  const sessionSecret = randomBytes(32).toString("base64url");
  let bootstrapFile = null;
  let bootstrapAvailable = true;
  let authority = null;
  let closing = null;

  const createHttpServer = options.createHttpServer ?? createServer;
  const server = createHttpServer(async (request, response) => {
    try {
      if (hostHeader(request) !== authority) {
        send(response, 421, "Misdirected Request\n");
        return;
      }
      const url = requestPath(request, authority);
      if (request.method === "OPTIONS") {
        send(response, 405, "Method Not Allowed\n", undefined, { Allow: "GET, POST" });
        return;
      }
      if (url.pathname === "/" && request.method === "POST") {
        assertOrigin(request, "null");
        if (!bootstrapAvailable || request.headers["content-type"]?.split(";", 1)[0] !== "application/x-www-form-urlencoded") {
          send(response, 401, "Unauthorized\n");
          return;
        }
        const form = new URLSearchParams(await readBody(request, MAX_FORM_BYTES));
        if ([...form.keys()].length !== 1 || !sameSecret(form.get("secret"), bootstrapSecret)) {
          send(response, 401, "Unauthorized\n");
          return;
        }
        bootstrapAvailable = false;
        if (bootstrapFile !== null) await unlink(bootstrapFile).catch(() => {});
        const document = assets.get("/");
        response.writeHead(200, {
          ...responseHeaders(document.type),
          "Set-Cookie": `${SESSION_COOKIE}=${sessionSecret}; HttpOnly; SameSite=Strict; Path=/`,
        });
        response.end(document.content);
        return;
      }

      if (!authenticated(request, sessionSecret)) {
        send(response, 401, "Unauthorized\n");
        return;
      }

      const asset = assets.get(url.pathname);
      if (asset !== undefined) {
        if (request.method !== "GET") {
          send(response, 405, "Method Not Allowed\n", undefined, { Allow: "GET" });
          return;
        }
        send(response, 200, asset.content, asset.type);
        return;
      }

      if (url.pathname === "/api/v1/status" && request.method === "GET") {
        sendJson(response, 200, await options.api.status());
        return;
      }
      if (url.pathname === "/api/v1/capabilities" && request.method === "GET") {
        const kind = url.searchParams.get("kind");
        const cursor = url.searchParams.get("cursor");
        const limit = Number(url.searchParams.get("limit") ?? "100");
        if ((kind !== "tool" && kind !== "skill") ||
            (cursor !== null && !/^[0-9a-f]{64}$/u.test(cursor)) ||
            !Number.isSafeInteger(limit) || limit < 1 || limit > 200) {
          throw dashboardError("TS_INSIGHTS_DASHBOARD_REQUEST_INVALID", "Invalid capability query");
        }
        sendJson(response, 200, await options.api.capabilities({ kind, cursor, limit }));
        return;
      }
      if (url.pathname === "/api/v1/search" && request.method === "POST") {
        assertOrigin(request, `http://${authority}`);
        if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
          throw dashboardError("TS_INSIGHTS_DASHBOARD_REQUEST_INVALID", "Search body must be JSON");
        }
        sendJson(response, 200, await options.api.search(JSON.parse(await readBody(request, MAX_JSON_BYTES))));
        return;
      }
      if (url.pathname === "/api/v1/turn-evidence" && request.method === "POST") {
        assertOrigin(request, `http://${authority}`);
        if (request.headers["content-type"]?.split(";", 1)[0] !== "application/json") {
          throw dashboardError("TS_INSIGHTS_DASHBOARD_REQUEST_INVALID", "Evidence body must be JSON");
        }
        sendJson(response, 200, await options.api.evidence(JSON.parse(await readBody(request, MAX_JSON_BYTES))));
        return;
      }
      send(response, 404, "Not Found\n");
    } catch (error) {
      const code = safeErrorCode(error);
      const status = code === "TS_INSIGHTS_DASHBOARD_BODY_TOO_LARGE"
        ? 413
        : code === "TS_INSIGHTS_DASHBOARD_ORIGIN_REJECTED"
          ? 403
          : code === "TS_INSIGHTS_DASHBOARD_REQUEST_INVALID" || error instanceof SyntaxError
            ? 400
            : 500;
      sendJson(response, status, { error: { code } });
    }
  });
  server.on("clientError", (_error, socket) => {
    socket.end("HTTP/1.1 400 Bad Request\r\nConnection: close\r\n\r\n");
  });
  let startupReject = null;
  let listening = false;
  server.on("error", (error) => {
    if (!listening && startupReject !== null) {
      const reject = startupReject;
      startupReject = null;
      reject(error);
      return;
    }
    try {
      options.onRuntimeError?.(Object.freeze({ code: "TS_INSIGHTS_DASHBOARD_RUNTIME_FAILED" }));
    } catch {}
  });

  try {
    await new Promise((resolve, reject) => {
      startupReject = reject;
      server.listen({ host, port, exclusive: true }, () => {
        listening = true;
        startupReject = null;
        resolve();
      });
    });
    const address = server.address();
    if (address === null || typeof address === "string") {
      throw dashboardError("TS_INSIGHTS_DASHBOARD_BIND_FAILED", "Dashboard listener has no TCP address");
    }
    authority = `${host}:${address.port}`;
    bootstrapFile = await writeBootstrapFile(paths, authority, bootstrapSecret, options);
    const openBrowser = options.openBrowser ?? defaultOpenBrowser;
    await openBrowser(bootstrapFile);
  } catch (cause) {
    await closeServer(server).catch(() => {});
    if (bootstrapFile !== null) await unlink(bootstrapFile).catch(() => {});
    throw dashboardError(
      cause?.code === "EADDRINUSE" ? "TS_INSIGHTS_DASHBOARD_PORT_UNAVAILABLE" :
        cause?.code ?? "TS_INSIGHTS_DASHBOARD_START_FAILED",
      "Unable to start the local Insights Dashboard",
      cause,
    );
  }

  let resolveClosed;
  const closed = new Promise((resolve) => { resolveClosed = resolve; });
  const close = () => {
    if (closing !== null) return closing;
    closing = (async () => {
      await closeServer(server);
      if (bootstrapFile !== null) await unlink(bootstrapFile).catch(() => {});
      resolveClosed();
    })();
    return closing;
  };

  return Object.freeze({
    url: `http://${authority}/`,
    bootstrapFile,
    openedWithSecret: false,
    closed,
    close,
  });
}
