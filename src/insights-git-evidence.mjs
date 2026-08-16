import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, open, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { TextDecoder } from "node:util";

import {
  assertGitDiffEvidencePair,
  assertGitDiffEvidenceRequest,
} from "./insights-engine-protocol.mjs";

const DEFAULT_MAX_TOTAL_BYTES = 64 * 1024 * 1024;
const DEFAULT_TIMEOUT_MILLISECONDS = 60_000;
const MAX_STDERR_BYTES = 64 * 1024;
const BINARY_MARKER = Buffer.from("Binary files ", "ascii");

function evidenceError(code, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

function gitArguments(rootDirectory, request, oldPath = null) {
  const arguments_ = [
    "-c", "core.hooksPath=/dev/null",
    "-c", "core.pager=cat",
    "-C", rootDirectory,
    "diff-tree",
    "--no-commit-id",
    "-r",
    "-p",
    "--no-color",
    "--no-ext-diff",
    "--no-textconv",
    "--full-index",
    "--find-renames=50%",
    "--diff-algorithm=histogram",
    `--unified=${request.contextLines}`,
  ];
  if (request.parentObjectId === null) {
    arguments_.push("--root", request.commitObjectId);
  } else {
    arguments_.push(request.parentObjectId, request.commitObjectId);
  }
  if (request.path !== null) {
    arguments_.push("--");
    if (oldPath !== null) arguments_.push(oldPath);
    arguments_.push(request.path);
  }
  return arguments_;
}

async function readBoundedStream(stream, maximumBytes, onExceeded) {
  const chunks = [];
  let total = 0;
  for await (const chunk of stream) {
    total += chunk.length;
    if (total > maximumBytes) {
      onExceeded();
      throw evidenceError("TS_INSIGHTS_GIT_OBJECT_UNAVAILABLE", "Git diff diagnostics exceeded their bound");
    }
    chunks.push(chunk);
  }
  return Buffer.concat(chunks, total);
}

async function writeAll(handle, buffer) {
  let offset = 0;
  while (offset < buffer.length) {
    const { bytesWritten } = await handle.write(buffer, offset, buffer.length - offset, null);
    if (bytesWritten === 0) throw evidenceError("TS_INSIGHTS_GIT_OBJECT_UNAVAILABLE", "Git diff spool write failed");
    offset += bytesWritten;
  }
}

async function spoolGitDiff(rootDirectory, request, options) {
  const directory = await mkdtemp(path.join(options.tempRoot ?? os.tmpdir(), "threadshare-git-diff-"));
  const spoolFile = path.join(directory, "payload.diff");
  let handle;
  try {
    handle = await open(spoolFile, "wx+", 0o600);
    const child = (options.spawn ?? spawn)(
      options.gitExecutable ?? "git",
      gitArguments(rootDirectory, request, options.oldPath ?? null),
      {
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
      signal: options.signal,
      env: {
        ...process.env,
        ...options.environment,
        GIT_CONFIG_NOSYSTEM: "1",
        GIT_OPTIONAL_LOCKS: "0",
        GIT_TERMINAL_PROMPT: "0",
        GIT_PAGER: "cat",
        PAGER: "cat",
        GIT_EXTERNAL_DIFF: "",
        LC_ALL: "C.UTF-8",
      },
      },
    );
    const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MILLISECONDS;
    const timer = setTimeout(() => child.kill("SIGKILL"), timeout);
    timer.unref?.();
    let totalBytes = 0;
    let binary = false;
    let markerTail = Buffer.alloc(0);
    const digest = createHash("sha256");
    const maximumBytes = options.maxTotalBytes ?? DEFAULT_MAX_TOTAL_BYTES;
    const stdout = (async () => {
      for await (const chunk of child.stdout) {
        totalBytes += chunk.length;
        if (totalBytes > maximumBytes) {
          child.kill("SIGKILL");
          throw evidenceError(
            "TS_INSIGHTS_GIT_DIFF_TOO_LARGE",
            "Git diff exceeds the bounded hydration limit",
          );
        }
        const probe = markerTail.length === 0 ? chunk : Buffer.concat([markerTail, chunk]);
        binary ||= probe.includes(BINARY_MARKER);
        markerTail = probe.subarray(Math.max(0, probe.length - BINARY_MARKER.length));
        digest.update(chunk);
        await writeAll(handle, chunk);
      }
    })();
    const stderr = readBoundedStream(child.stderr, MAX_STDERR_BYTES, () => child.kill("SIGKILL"));
    const exit = new Promise((resolve, reject) => {
      child.once("error", reject);
      child.once("close", (code, signal) => resolve({ code, signal }));
    });
    let diagnostics;
    let status;
    try {
      [, diagnostics, status] = await Promise.all([stdout, stderr, exit]);
    } finally {
      clearTimeout(timer);
    }
    if (status.code !== 0) {
      throw evidenceError(
        "TS_INSIGHTS_GIT_OBJECT_UNAVAILABLE",
        "The projected Git object is unavailable in the registered repository",
      );
    }
    return {
      binary,
      handle,
      payloadSha256: digest.digest("hex"),
      totalBytes,
      diagnosticsBytes: diagnostics.length,
      async cleanup() {
        await handle?.close();
        handle = undefined;
        await rm(directory, { recursive: true, force: true });
      },
    };
  } catch (error) {
    await handle?.close().catch(() => {});
    await rm(directory, { recursive: true, force: true }).catch(() => {});
    if (error?.code?.startsWith?.("TS_INSIGHTS_")) throw error;
    if (error?.name === "AbortError") {
      throw evidenceError("TS_INSIGHTS_ENGINE_ABORTED", "Git diff hydration was aborted", error);
    }
    throw evidenceError(
      "TS_INSIGHTS_GIT_OBJECT_UNAVAILABLE",
      "The projected Git object is unavailable in the registered repository",
      error,
    );
  }
}

function decodePage(buffer, reachesEnd) {
  const decoder = new TextDecoder("utf-8", { fatal: true });
  const maximumTrim = reachesEnd ? 0 : Math.min(3, buffer.length);
  for (let trim = 0; trim <= maximumTrim; trim += 1) {
    try {
      return { bytes: buffer.subarray(0, buffer.length - trim), content: decoder.decode(buffer.subarray(0, buffer.length - trim)) };
    } catch {
      // A page boundary may split one UTF-8 scalar; no other decoding loss is accepted.
    }
  }
  throw evidenceError(
    "TS_INSIGHTS_GIT_DIFF_ENCODING_UNSUPPORTED",
    "Git diff text is not valid UTF-8",
  );
}

export async function readGitDiffEvidence(request, options = {}) {
  assertGitDiffEvidenceRequest(request);
  if (typeof options.rootDirectory !== "string" || options.rootDirectory.length === 0) {
    throw new TypeError("rootDirectory is required");
  }
  const offset = options.offset ?? 0;
  if (!Number.isSafeInteger(offset) || offset < 0) throw new TypeError("offset must be non-negative");
  const spool = await spoolGitDiff(options.rootDirectory, request, options);
  try {
    if ((options.expectedPayloadSha256 !== undefined &&
         options.expectedPayloadSha256 !== spool.payloadSha256) ||
        (options.expectedTotalBytes !== undefined &&
         options.expectedTotalBytes !== String(spool.totalBytes)) ||
        offset > spool.totalBytes) {
      throw evidenceError("TS_INSIGHTS_CURSOR_STALE", "Git diff cursor is stale or invalid");
    }
    const requestedLength = Math.min(request.maxBytes, spool.totalBytes - offset);
    const buffer = Buffer.allocUnsafe(requestedLength);
    let bytesRead = 0;
    while (bytesRead < requestedLength) {
      const result = await spool.handle.read(
        buffer,
        bytesRead,
        requestedLength - bytesRead,
        offset + bytesRead,
      );
      if (result.bytesRead === 0) break;
      bytesRead += result.bytesRead;
    }
    const decoded = decodePage(buffer.subarray(0, bytesRead), offset + bytesRead === spool.totalBytes);
    const end = offset + decoded.bytes.length;
    const complete = end === spool.totalBytes;
    let nextCursor = null;
    if (!complete) {
      if (typeof options.createCursor !== "function") {
        throw new TypeError("createCursor is required for paginated Git diff evidence");
      }
      nextCursor = options.createCursor({
        offset: end,
        payloadSha256: spool.payloadSha256,
        totalBytes: String(spool.totalBytes),
      });
    }
    const response = {
      format: "threadshare-insights-git-diff-evidence@v1",
      repositoryKey: request.repositoryKey,
      commitObjectId: request.commitObjectId,
      parentObjectId: request.parentObjectId,
      path: request.path,
      revision: request.revision,
      provenance: "local-git-object",
      payloadSha256: spool.payloadSha256,
      totalBytes: String(spool.totalBytes),
      range: { start: String(offset), end: String(end) },
      content: decoded.content,
      nextCursor,
      complete,
      binary: spool.binary,
    };
    assertGitDiffEvidencePair(request, response);
    return Object.freeze(response);
  } finally {
    await spool.cleanup();
  }
}
