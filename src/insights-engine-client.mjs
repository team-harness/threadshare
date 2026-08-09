import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  ProtocolFrameDecoder,
  assertBeginSessionCompatible,
  assertHandshakeCompatible,
  createAbortSessionMessage,
  createHelloMessage,
  createSessionDeltaMessages,
  encodeProtocolFrame,
} from "./insights-engine-protocol.mjs";
import { resolveInsightsEngine } from "./insights-engine-runtime.mjs";

const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_CLOSE_TIMEOUT_MS = 1_000;
const DEFAULT_STDERR_LIMIT_BYTES = 16 * 1_024;
const MAX_STDERR_LIMIT_BYTES = 1_048_576;
export class InsightsEngineClientError extends Error {
  constructor(code, message, options = {}) {
    super(message, options.cause === undefined ? {} : { cause: options.cause });
    this.name = "InsightsEngineClientError";
    this.code = code;
    this.category = options.category ?? "runtime";
    this.retryable = options.retryable ?? false;
    this.fatal = options.fatal ?? false;
    Object.defineProperty(this, "stderr", {
      value: options.stderr ?? "",
      enumerable: false,
    });
  }
}

function clientError(code, message, options) {
  return new InsightsEngineClientError(code, message, options);
}

function assertPositiveInteger(value, label, maximum = Number.MAX_SAFE_INTEGER) {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum) {
    throw new TypeError(`${label} must be a positive integer no greater than ${maximum}`);
  }
}

function disconnectedError(stderr, cause) {
  return clientError(
    "TS_INSIGHTS_ENGINE_DISCONNECTED",
    "Insights Engine disconnected before completing the request",
    { cause, fatal: true, stderr },
  );
}

function timeoutError(action, stderr) {
  return clientError(
    "TS_INSIGHTS_ENGINE_TIMEOUT",
    `Insights Engine timed out while ${action}`,
    { retryable: true, stderr },
  );
}

function abortedError(stderr, cause) {
  return clientError(
    "TS_INSIGHTS_ENGINE_ABORTED",
    "Insights Engine operation was aborted",
    { cause, retryable: true, stderr },
  );
}

function throwIfAborted(signal, stderr) {
  if (signal?.aborted) throw abortedError(stderr, signal.reason);
}

function protocolClientError(message, cause, stderr, { fatal = true } = {}) {
  return clientError(
    cause?.code ?? "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
    message,
    { cause, category: "protocol", fatal, stderr },
  );
}

function withTimeout(promise, timeoutMs, createError) {
  let timer;
  const timeout = new Promise((_, reject) => {
    timer = setTimeout(() => reject(createError()), timeoutMs);
    timer.unref?.();
  });
  return Promise.race([promise, timeout]).finally(() => clearTimeout(timer));
}

class FrameTransport {
  #child;
  #decoder = new ProtocolFrameDecoder();
  #frames = [];
  #waiters = [];
  #failure = null;
  #stderr = Buffer.alloc(0);
  #stderrLimitBytes;
  #timeoutMs;
  #closeTimeoutMs;
  #closing = false;
  #closed = false;
  #closePromise;

  constructor(child, { timeoutMs, closeTimeoutMs, stderrLimitBytes }) {
    this.#child = child;
    this.#timeoutMs = timeoutMs;
    this.#closeTimeoutMs = closeTimeoutMs;
    this.#stderrLimitBytes = stderrLimitBytes;

    child.stderr.on("data", (chunk) => this.#appendStderr(chunk));
    child.stdout.on("data", (chunk) => this.#acceptBytes(chunk));
    child.stdout.on("end", () => {
      try {
        this.#decoder.end();
      } catch (cause) {
        this.#fail(protocolClientError(cause.message, cause, this.stderr));
      }
    });
    child.stdout.on("error", (cause) => {
      this.#fail(disconnectedError(this.stderr, cause));
    });
    child.stdin.on("error", (cause) => {
      if (!this.#closing) this.#fail(disconnectedError(this.stderr, cause));
    });
    child.once("error", (cause) => {
      this.#fail(disconnectedError(this.stderr, cause));
    });
    this.#closePromise = new Promise((resolve) => {
      child.once("close", (code, signal) => {
        this.#closed = true;
        if (!this.#closing) {
          this.#fail(disconnectedError(
            this.stderr,
            Object.assign(new Error("Insights Engine process closed"), { code, signal }),
          ));
        }
        resolve({ code, signal });
      });
    });
  }

  get stderr() {
    return this.#stderr.toString("utf8");
  }

  get failed() {
    return this.#failure !== null;
  }

  #appendStderr(chunk) {
    const bytes = Buffer.from(chunk);
    if (bytes.byteLength >= this.#stderrLimitBytes) {
      this.#stderr = Buffer.from(bytes.subarray(bytes.byteLength - this.#stderrLimitBytes));
      return;
    }
    const retained = Math.max(0, this.#stderrLimitBytes - bytes.byteLength);
    const prefix = this.#stderr.byteLength > retained
      ? this.#stderr.subarray(this.#stderr.byteLength - retained)
      : this.#stderr;
    this.#stderr = Buffer.concat([prefix, bytes], prefix.byteLength + bytes.byteLength);
  }

  #acceptBytes(chunk) {
    if (this.#failure) return;
    let messages;
    try {
      messages = this.#decoder.push(chunk);
    } catch (cause) {
      this.#fail(protocolClientError(cause.message, cause, this.stderr));
      return;
    }
    for (const message of messages) {
      const waiter = this.#waiters.shift();
      if (waiter) waiter.resolve(message);
      else this.#frames.push(message);
    }
  }

  #fail(error) {
    if (this.#failure || this.#closing) return;
    this.#failure = error;
    for (const waiter of this.#waiters.splice(0)) waiter.reject(error);
  }

  async write(
    message,
    action = "writing a protocol frame",
    timeoutMs = this.#timeoutMs,
  ) {
    if (this.#failure) throw this.#failure;
    if (this.#closing || this.#closed || this.#child.stdin.destroyed) {
      throw disconnectedError(this.stderr);
    }
    const frame = encodeProtocolFrame(message);
    let accepted;
    let resolveWrite;
    let rejectWrite;
    const written = new Promise((resolve, reject) => {
      resolveWrite = resolve;
      rejectWrite = reject;
    });
    try {
      accepted = this.#child.stdin.write(frame, (error) => {
        if (error) rejectWrite(disconnectedError(this.stderr, error));
        else resolveWrite();
      });
    } catch (cause) {
      throw disconnectedError(this.stderr, cause);
    }

    const completion = accepted
      ? written
      : Promise.all([written, once(this.#child.stdin, "drain")]);
    try {
      await withTimeout(completion, timeoutMs, () => timeoutError(action, this.stderr));
    } catch (cause) {
      if (cause instanceof InsightsEngineClientError) throw cause;
      throw disconnectedError(this.stderr, cause);
    }
    if (this.#failure) throw this.#failure;
  }

  async read(
    action = "waiting for a protocol response",
    timeoutMs = this.#timeoutMs,
  ) {
    if (this.#frames.length > 0) return this.#frames.shift();
    if (this.#failure) throw this.#failure;
    if (this.#closed) throw disconnectedError(this.stderr);

    let waiter;
    const pending = new Promise((resolve, reject) => {
      waiter = { resolve, reject };
      this.#waiters.push(waiter);
    });
    try {
      return await withTimeout(
        pending,
        timeoutMs,
        () => timeoutError(action, this.stderr),
      );
    } finally {
      const index = this.#waiters.indexOf(waiter);
      if (index !== -1) this.#waiters.splice(index, 1);
    }
  }

  async close({ force = false } = {}) {
    if (this.#closing) return this.#closePromise;
    this.#closing = true;
    for (const waiter of this.#waiters.splice(0)) {
      waiter.reject(disconnectedError(this.stderr));
    }
    if (this.#closed) return this.#closePromise;

    if (force) {
      this.#child.stdin.destroy();
      this.#child.kill("SIGTERM");
    } else if (!this.#child.stdin.destroyed) {
      this.#child.stdin.end();
    }
    try {
      return await withTimeout(
        this.#closePromise,
        this.#closeTimeoutMs,
        () => timeoutError("stopping the process", this.stderr),
      );
    } catch {
      this.#child.kill("SIGTERM");
      try {
        return await withTimeout(
          this.#closePromise,
          this.#closeTimeoutMs,
          () => timeoutError("terminating the process", this.stderr),
        );
      } catch {
        this.#child.kill("SIGKILL");
        return this.#closePromise;
      }
    }
  }
}

function remoteEngineError(message, stderr) {
  const error = clientError(message.code, message.message, {
    category: message.category,
    retryable: message.retryable,
    fatal: message.fatal,
    stderr,
  });
  Object.defineProperty(error, "remote", { value: true });
  return error;
}

function unexpectedResponse(expectedType, message, stderr) {
  return protocolClientError(
    `Insights Engine returned ${String(message?.type)} while ${expectedType} was required`,
    undefined,
    stderr,
  );
}

function assertPackagedReadyIdentity(resolved, ready, stderr) {
  if (resolved.source !== "package") return;
  const compatible =
    ready.target === resolved.target &&
    ready.engineVersion === resolved.version &&
    ready.buildManifestDigest === resolved.buildManifestDigest &&
    ready.sqliteVersion === resolved.buildManifest?.sqliteVersion;
  if (!compatible) {
    throw clientError(
      "TS_INSIGHTS_ENGINE_INVALID",
      "Insights Engine READY identity does not match the installed platform package",
      { category: "compatibility", fatal: true, stderr },
    );
  }
}

class InsightsEngineClient {
  #transport;
  #ready;
  #requiredContract;
  #resolved;
  #timeoutMs;
  #requestId = 2n;
  #tail = Promise.resolve();
  #closed = false;
  #broken = false;
  #closePromise = null;

  constructor(transport, resolved, requiredContract, timeoutMs) {
    this.#transport = transport;
    this.#resolved = resolved;
    this.#requiredContract = requiredContract;
    this.#timeoutMs = timeoutMs;
  }

  async handshake(clientVersion) {
    const hello = createHelloMessage({
      requestId: "1",
      clientVersion,
      requiredContract: this.#requiredContract,
    });
    await this.#transport.write(hello, "sending HELLO");
    const ready = await this.#expect("READY", "1", {}, "waiting for READY");
    try {
      assertHandshakeCompatible(hello, ready);
    } catch (cause) {
      throw protocolClientError(cause.message, cause, this.#transport.stderr);
    }
    assertPackagedReadyIdentity(this.#resolved, ready, this.#transport.stderr);
    this.#requiredContract = Object.freeze({
      ...hello.requiredContract,
      providerAdapterVersions: Object.freeze([...hello.requiredContract.providerAdapterVersions]),
      projectionVersions: Object.freeze([...hello.requiredContract.projectionVersions]),
      analyzerCapabilities: Object.freeze([...hello.requiredContract.analyzerCapabilities]),
    });
    this.#ready = ready;
  }

  applySessionFacts(delta, options = {}) {
    if (this.#closed) {
      return Promise.reject(clientError(
        "TS_INSIGHTS_ENGINE_CLOSED",
        "Insights Engine client is closed",
      ));
    }
    const signal = options.signal;
    if (signal !== undefined && !(signal instanceof AbortSignal)) {
      return Promise.reject(new TypeError("signal must be an AbortSignal"));
    }
    const operation = this.#tail.then(() => this.#applySessionFacts(delta, signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  async #applySessionFacts(delta, signal) {
    throwIfAborted(signal, this.#transport.stderr);
    if (this.#broken || this.#transport.failed) {
      throw disconnectedError(this.#transport.stderr);
    }
    const requestId = this.#nextRequestId();
    const sessionOptions = {
      requestId,
      factStorageProfile: this.#requiredContract.factStorageProfile,
      storageSchemaVersion: this.#requiredContract.storageSchemaVersion,
      projectionVersions: this.#requiredContract.projectionVersions,
      analyzerCapabilities: this.#requiredContract.analyzerCapabilities,
      rankerVersion: this.#requiredContract.rankerVersion,
    };
    let began = false;
    let committed = false;
    let nextSequence = "0";

    try {
      for await (const message of createSessionDeltaMessages(delta, sessionOptions)) {
        if (message.type === "BEGIN_SESSION") {
          try {
            assertBeginSessionCompatible(message, this.#ready);
          } catch (cause) {
            throw protocolClientError(
              cause.message,
              cause,
              this.#transport.stderr,
              { fatal: false },
            );
          }
          throwIfAborted(signal, this.#transport.stderr);
          began = true;
          await this.#transport.write(message, "sending BEGIN_SESSION", this.#timeoutMs);
          await this.#expect(
            "SESSION_ACCEPTED",
            requestId,
            {
              sessionKey: delta.session.sessionKey,
              deltaId: delta.deltaId,
              nextSequence: "0",
            },
            "waiting for SESSION_ACCEPTED",
            this.#timeoutMs,
          );
          throwIfAborted(signal, this.#transport.stderr);
          continue;
        }

        if (message.type === "RETRACT_FACTS" || message.type === "UPSERT_FACTS") {
          throwIfAborted(signal, this.#transport.stderr);
          await this.#transport.write(
            message,
            `sending ${message.type}`,
            this.#timeoutMs,
          );
          // Frames on one stdin pipe are ordered, so ABORT must name the post-write sequence
          // even when cancellation wins the race with BATCH_ACCEPTED.
          nextSequence = (BigInt(message.sequence) + 1n).toString();
          await this.#expect(
            "BATCH_ACCEPTED",
            requestId,
            { sequence: message.sequence },
            "waiting for BATCH_ACCEPTED",
            this.#timeoutMs,
          );
          throwIfAborted(signal, this.#transport.stderr);
          continue;
        }

        if (message.type !== "COMMIT_SESSION") {
          throw unexpectedResponse("COMMIT_SESSION", message, this.#transport.stderr);
        }
        throwIfAborted(signal, this.#transport.stderr);
        await this.#transport.write(message, "sending COMMIT_SESSION", this.#timeoutMs);
        const response = await this.#expect(
          "SESSION_COMMITTED",
          requestId,
          { sessionKey: delta.session.sessionKey, deltaId: delta.deltaId },
          "waiting for SESSION_COMMITTED",
          this.#timeoutMs,
        );
        committed = true;
        return {
          snapshotSeq: response.snapshotSeq,
          sessionKey: response.sessionKey,
          idempotent: response.idempotent,
        };
      }
      throw protocolClientError(
        "Session delta stream ended before COMMIT_SESSION",
        undefined,
        this.#transport.stderr,
        { fatal: false },
      );
    } catch (cause) {
      const error = cause instanceof InsightsEngineClientError
        ? cause
        : protocolClientError(
          cause.message,
          cause,
          this.#transport.stderr,
          { fatal: false },
        );
      if (began && !committed && error.remote !== true) {
        const aborted = await this.#bestEffortAbort(
          requestId,
          nextSequence,
          delta.session.sessionKey,
          delta.deltaId,
        );
        if (!aborted) this.#broken = true;
      }
      if (error.fatal || error.code === "TS_INSIGHTS_ENGINE_TIMEOUT" ||
          error.code === "TS_INSIGHTS_ENGINE_DISCONNECTED") {
        this.#broken = true;
      }
      if (this.#broken) {
        error.fatal = true;
        await this.#transport.close({ force: true });
      }
      throw error;
    }
  }

  async #expect(
    type,
    requestId,
    fields,
    action,
    timeoutMs = this.#timeoutMs,
  ) {
    const message = await this.#transport.read(action, timeoutMs);
    if (message.type === "ERROR") {
      if (message.requestId !== requestId) throw unexpectedResponse(type, message, this.#transport.stderr);
      throw remoteEngineError(message, this.#transport.stderr);
    }
    if (message.type !== type || message.requestId !== requestId) {
      throw unexpectedResponse(type, message, this.#transport.stderr);
    }
    for (const [key, value] of Object.entries(fields)) {
      if (message[key] !== value) throw unexpectedResponse(type, message, this.#transport.stderr);
    }
    return message;
  }

  async #bestEffortAbort(requestId, nextSequence, sessionKey, deltaId) {
    if (this.#transport.failed) return false;
    const timeoutMs = Math.min(this.#timeoutMs, 250);
    try {
      const abort = createAbortSessionMessage({
        requestId,
        nextSequence,
        reason: "client-error",
      });
      await this.#transport.write(abort, "sending ABORT_SESSION", timeoutMs);
      await this.#expect(
        "SESSION_ABORTED",
        requestId,
        { sessionKey, deltaId, nextSequence },
        "waiting for SESSION_ABORTED",
        timeoutMs,
      );
      return true;
    } catch {
      return false;
    }
  }

  #nextRequestId() {
    if (this.#requestId > 0xffff_ffff_ffff_ffffn) {
      throw clientError(
        "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
        "Insights Engine requestId space is exhausted",
        { category: "protocol", fatal: true },
      );
    }
    const value = this.#requestId.toString();
    this.#requestId += 1n;
    return value;
  }

  close() {
    if (this.#closePromise) return this.#closePromise;
    this.#closed = true;
    this.#closePromise = (async () => {
      await this.#tail;
      await this.#transport.close({ force: this.#broken });
    })();
    return this.#closePromise;
  }
}

/** Resolves, starts, and performs protocol-v1 negotiation with one Insights Engine sidecar. */
export async function createInsightsEngineClient(options = {}) {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const closeTimeoutMs = options.closeTimeoutMs ?? DEFAULT_CLOSE_TIMEOUT_MS;
  const stderrLimitBytes = options.stderrLimitBytes ?? DEFAULT_STDERR_LIMIT_BYTES;
  assertPositiveInteger(timeoutMs, "timeoutMs");
  assertPositiveInteger(closeTimeoutMs, "closeTimeoutMs");
  assertPositiveInteger(stderrLimitBytes, "stderrLimitBytes", MAX_STDERR_LIMIT_BYTES);
  if (options.databasePath !== undefined &&
      (typeof options.databasePath !== "string" || options.databasePath.length === 0)) {
    throw new TypeError("databasePath must be a non-empty string");
  }
  if (options.requiredContract === undefined) {
    throw new TypeError("requiredContract is required");
  }

  const resolved = await resolveInsightsEngine(options.runtimeOptions);
  const arguments_ = options.databasePath === undefined ? [] : ["--db", options.databasePath];
  const child = spawn(resolved.binaryPath, arguments_, {
    stdio: ["pipe", "pipe", "pipe"],
    windowsHide: true,
    env: options.childEnv ?? process.env,
  });
  const transport = new FrameTransport(child, {
    timeoutMs,
    closeTimeoutMs,
    stderrLimitBytes,
  });
  const client = new InsightsEngineClient(
    transport,
    resolved,
    options.requiredContract,
    timeoutMs,
  );
  try {
    await client.handshake(options.clientVersion ?? "threadshare-node@1");
    return client;
  } catch (cause) {
    await transport.close({ force: true });
    if (cause instanceof InsightsEngineClientError) throw cause;
    throw protocolClientError(cause.message, cause, transport.stderr);
  }
}
