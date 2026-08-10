import { spawn } from "node:child_process";
import { once } from "node:events";

import {
  ProtocolFrameDecoder,
  assertBeginSessionCompatible,
  assertHandshakeCompatible,
  createAbortSessionMessage,
  createExcludeSourceMessage,
  createHelloMessage,
  createListCapabilitiesMessage,
  createListSourceStatesMessage,
  createReadEngineStatusMessage,
  createReadInsightsOverviewMessage,
  createReadPurgeStatusMessage,
  createReadTurnEvidenceMessage,
  createReadSourceCheckpointMessage,
  createRemoveSourceMessage,
  createRunPurgeMaintenanceMessage,
  createSearchTurnsMessage,
  createSessionDeltaMessages,
  decodeSourceStateFromProtocol,
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

function lifecycleSessionKey(input, operation) {
  if (!input || typeof input !== "object" ||
      !input.previous || typeof input.previous !== "object" ||
      typeof input.previous.sessionKey !== "string") {
    throw new TypeError(`${operation} requires previous.sessionKey`);
  }
  return input.previous.sessionKey;
}

function freezeEngineStatus(response) {
  return Object.freeze({
    snapshotSeq: response.snapshotSeq,
    snapshotAgeMs: response.snapshotAgeMs,
    snapshotPending: response.snapshotPending,
    factStorageProfile: response.factStorageProfile,
    projections: Object.freeze(response.projections.map((projection) =>
      Object.freeze({ ...projection }))),
    changeLog: Object.freeze({ ...response.changeLog }),
    purge: Object.freeze({ ...response.purge }),
    storage: Object.freeze({ ...response.storage }),
    integrity: Object.freeze({ ...response.integrity }),
  });
}

function freezeProtocolValue(value) {
  if (Array.isArray(value)) return Object.freeze(value.map(freezeProtocolValue));
  if (value !== null && typeof value === "object") {
    return Object.freeze(Object.fromEntries(
      Object.entries(value).map(([key, item]) => [key, freezeProtocolValue(item)]),
    ));
  }
  return value;
}

function freezeSearchResults(response) {
  return freezeProtocolValue(response);
}

function freezeEvidencePage(response) {
  return freezeProtocolValue(response);
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
    const operation = this.#tail.then(() => this.#applySessionFacts(delta, null, signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  commitSourceDelta(input, options = {}) {
    if (!input || typeof input !== "object" || !input.delta || !input.sourceState) {
      return Promise.reject(new TypeError("commitSourceDelta requires delta and sourceState"));
    }
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
    const operation = this.#tail.then(() =>
      this.#applySessionFacts(input.delta, input.sourceState, signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  readSourceStates(options = {}) {
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
    const operation = this.#tail.then(() => this.#readSourceStates(signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  readSourceCheckpoint(sessionKey, options = {}) {
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
    const operation = this.#tail.then(() =>
      this.#readSourceCheckpoint(sessionKey, signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  removeSource(input, options = {}) {
    let sessionKey;
    try {
      sessionKey = lifecycleSessionKey(input, "removeSource");
    } catch (error) {
      return Promise.reject(error);
    }
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
    const operation = this.#tail.then(() => this.#removeSource(sessionKey, signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  excludeSource(input, options = {}) {
    let sessionKey;
    try {
      sessionKey = lifecycleSessionKey(input, "excludeSource");
    } catch (error) {
      return Promise.reject(error);
    }
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
    const operation = this.#tail.then(() => this.#excludeSource(sessionKey, signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  readPurgeStatus(sessionKey = null, options = {}) {
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
    const operation = this.#tail.then(() => this.#readPurgeStatus(sessionKey, signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  readEngineStatus(options = {}) {
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
    const operation = this.#tail.then(() => this.#readEngineStatus(signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  readInsightsOverview(input, options = {}) {
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
    const operation = this.#tail.then(() => this.#readInsightsOverview(input, signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  listCapabilities(input, options = {}) {
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
    const operation = this.#tail.then(() => this.#listCapabilities(input, signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  searchTurns(input, options = {}) {
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
    const operation = this.#tail.then(() => this.#searchTurns(input, signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  readTurnEvidence(input, options = {}) {
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
    const operation = this.#tail.then(() => this.#readTurnEvidence(input, signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  runPurgeMaintenance(input = {}, options = {}) {
    const limit = input.limit ?? 64;
    if (!Number.isSafeInteger(limit) || limit < 1 || limit > 256) {
      return Promise.reject(new TypeError("limit must be an integer between 1 and 256"));
    }
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
    const operation = this.#tail.then(() => this.#runPurgeMaintenance(limit, signal));
    this.#tail = operation.catch(() => {});
    return operation;
  }

  async #applySessionFacts(delta, sourceState, signal) {
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
      sourceState,
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

  async #readSourceStates(signal) {
    throwIfAborted(signal, this.#transport.stderr);
    if (this.#broken || this.#transport.failed) {
      throw disconnectedError(this.#transport.stderr);
    }
    const states = [];
    const seenCursors = new Set();
    let cursor = null;
    for (;;) {
      throwIfAborted(signal, this.#transport.stderr);
      const requestId = this.#nextRequestId();
      const request = createListSourceStatesMessage({ requestId, cursor, limit: 256 });
      await this.#transport.write(request, "sending LIST_SOURCE_STATES", this.#timeoutMs);
      const response = await this.#expect(
        "SOURCE_STATES",
        requestId,
        {},
        "waiting for SOURCE_STATES",
        this.#timeoutMs,
      );
      if (cursor !== null && response.states.some((state) => state.sessionKey <= cursor)) {
        throw unexpectedResponse("SOURCE_STATES", response, this.#transport.stderr);
      }
      states.push(...response.states.map(decodeSourceStateFromProtocol));
      if (response.nextCursor === null) return states;
      if (seenCursors.has(response.nextCursor)) {
        throw unexpectedResponse("SOURCE_STATES", response, this.#transport.stderr);
      }
      seenCursors.add(response.nextCursor);
      cursor = response.nextCursor;
    }
  }

  async #readSourceCheckpoint(sessionKey, signal) {
    throwIfAborted(signal, this.#transport.stderr);
    if (this.#broken || this.#transport.failed) {
      throw disconnectedError(this.#transport.stderr);
    }
    const requestId = this.#nextRequestId();
    const request = createReadSourceCheckpointMessage({ requestId, sessionKey });
    await this.#transport.write(request, "sending READ_SOURCE_CHECKPOINT", this.#timeoutMs);
    const response = await this.#expect(
      "SOURCE_CHECKPOINT",
      requestId,
      { sessionKey },
      "waiting for SOURCE_CHECKPOINT",
      this.#timeoutMs,
    );
    return response.checkpoint;
  }

  async #removeSource(sessionKey, signal) {
    throwIfAborted(signal, this.#transport.stderr);
    if (this.#broken || this.#transport.failed) throw disconnectedError(this.#transport.stderr);
    const requestId = this.#nextRequestId();
    const request = createRemoveSourceMessage({ requestId, sessionKey });
    await this.#transport.write(request, "sending REMOVE_SOURCE", this.#timeoutMs);
    const response = await this.#expect(
      "SOURCE_REMOVED",
      requestId,
      { sessionKey },
      "waiting for SOURCE_REMOVED",
      this.#timeoutMs,
    );
    throwIfAborted(signal, this.#transport.stderr);
    return Object.freeze({ sessionKey, removed: response.removed });
  }

  async #excludeSource(sessionKey, signal) {
    throwIfAborted(signal, this.#transport.stderr);
    if (this.#broken || this.#transport.failed) throw disconnectedError(this.#transport.stderr);
    const requestId = this.#nextRequestId();
    const request = createExcludeSourceMessage({ requestId, sessionKey });
    await this.#transport.write(request, "sending EXCLUDE_SOURCE", this.#timeoutMs);
    const response = await this.#expect(
      "SOURCE_EXCLUDED",
      requestId,
      { sessionKey },
      "waiting for SOURCE_EXCLUDED",
      this.#timeoutMs,
    );
    throwIfAborted(signal, this.#transport.stderr);
    return Object.freeze({
      sessionKey,
      excluded: response.excluded,
      purgeState: response.purgeState,
    });
  }

  async #readPurgeStatus(sessionKey, signal) {
    throwIfAborted(signal, this.#transport.stderr);
    if (this.#broken || this.#transport.failed) throw disconnectedError(this.#transport.stderr);
    const requestId = this.#nextRequestId();
    const request = createReadPurgeStatusMessage({ requestId, sessionKey });
    await this.#transport.write(request, "sending READ_PURGE_STATUS", this.#timeoutMs);
    const response = await this.#expect(
      "PURGE_STATUS",
      requestId,
      { sessionKey },
      "waiting for PURGE_STATUS",
      this.#timeoutMs,
    );
    throwIfAborted(signal, this.#transport.stderr);
    return Object.freeze({
      state: response.state,
      pendingFacts: response.pendingFacts,
      pendingMaintenance: response.pendingMaintenance,
      purged: response.purged,
    });
  }

  async #readEngineStatus(signal) {
    throwIfAborted(signal, this.#transport.stderr);
    if (this.#broken || this.#transport.failed) throw disconnectedError(this.#transport.stderr);
    const requestId = this.#nextRequestId();
    const request = createReadEngineStatusMessage({ requestId });
    await this.#transport.write(request, "sending READ_ENGINE_STATUS", this.#timeoutMs);
    const response = await this.#expect(
      "ENGINE_STATUS",
      requestId,
      {},
      "waiting for ENGINE_STATUS",
      this.#timeoutMs,
    );
    throwIfAborted(signal, this.#transport.stderr);
    return freezeEngineStatus(response);
  }

  async #readInsightsOverview(input, signal) {
    throwIfAborted(signal, this.#transport.stderr);
    if (this.#broken || this.#transport.failed) throw disconnectedError(this.#transport.stderr);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("readInsightsOverview input must be an object");
    }
    const requestId = this.#nextRequestId();
    const request = createReadInsightsOverviewMessage({ ...input, requestId });
    await this.#transport.write(request, "sending READ_INSIGHTS_OVERVIEW", this.#timeoutMs);
    const response = await this.#expect(
      "INSIGHTS_OVERVIEW",
      requestId,
      {},
      "waiting for INSIGHTS_OVERVIEW",
      this.#timeoutMs,
    );
    throwIfAborted(signal, this.#transport.stderr);
    return freezeProtocolValue(response);
  }

  async #listCapabilities(input, signal) {
    throwIfAborted(signal, this.#transport.stderr);
    if (this.#broken || this.#transport.failed) throw disconnectedError(this.#transport.stderr);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("listCapabilities input must be an object");
    }
    const requestId = this.#nextRequestId();
    const request = createListCapabilitiesMessage({ ...input, requestId });
    await this.#transport.write(request, "sending LIST_CAPABILITIES", this.#timeoutMs);
    const response = await this.#expect(
      "CAPABILITY_PAGE",
      requestId,
      {},
      "waiting for CAPABILITY_PAGE",
      this.#timeoutMs,
    );
    if (response.items.some((item) => item.kind !== request.kind)) {
      throw unexpectedResponse("CAPABILITY_PAGE", response, this.#transport.stderr);
    }
    throwIfAborted(signal, this.#transport.stderr);
    return freezeProtocolValue(response);
  }

  async #searchTurns(input, signal) {
    throwIfAborted(signal, this.#transport.stderr);
    if (this.#broken || this.#transport.failed) throw disconnectedError(this.#transport.stderr);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("searchTurns input must be an object");
    }
    const requestId = this.#nextRequestId();
    const request = createSearchTurnsMessage({ ...input, requestId });
    await this.#transport.write(request, "sending SEARCH_TURNS", this.#timeoutMs);
    const response = await this.#expect(
      "TURN_SEARCH_RESULTS",
      requestId,
      {},
      "waiting for TURN_SEARCH_RESULTS",
      this.#timeoutMs,
    );
    throwIfAborted(signal, this.#transport.stderr);
    return freezeSearchResults(response);
  }

  async #readTurnEvidence(input, signal) {
    throwIfAborted(signal, this.#transport.stderr);
    if (this.#broken || this.#transport.failed) throw disconnectedError(this.#transport.stderr);
    if (input === null || typeof input !== "object" || Array.isArray(input)) {
      throw new TypeError("readTurnEvidence input must be an object");
    }
    const requestId = this.#nextRequestId();
    const request = createReadTurnEvidenceMessage({ ...input, requestId });
    await this.#transport.write(request, "sending READ_TURN_EVIDENCE", this.#timeoutMs);
    const response = await this.#expect(
      "TURN_EVIDENCE_PAGE",
      requestId,
      {},
      "waiting for TURN_EVIDENCE_PAGE",
      this.#timeoutMs,
    );
    throwIfAborted(signal, this.#transport.stderr);
    return freezeEvidencePage(response);
  }

  async #runPurgeMaintenance(limit, signal) {
    throwIfAborted(signal, this.#transport.stderr);
    if (this.#broken || this.#transport.failed) throw disconnectedError(this.#transport.stderr);
    const requestId = this.#nextRequestId();
    const request = createRunPurgeMaintenanceMessage({ requestId, limit });
    await this.#transport.write(request, "sending RUN_PURGE_MAINTENANCE", this.#timeoutMs);
    const response = await this.#expect(
      "PURGE_MAINTENANCE_STATUS",
      requestId,
      {},
      "waiting for PURGE_MAINTENANCE_STATUS",
      this.#timeoutMs,
    );
    throwIfAborted(signal, this.#transport.stderr);
    return Object.freeze({
      processedSessions: response.processedSessions,
      purgedSessions: response.purgedSessions,
      state: response.state,
      pendingFacts: response.pendingFacts,
      pendingMaintenance: response.pendingMaintenance,
      purged: response.purged,
    });
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
