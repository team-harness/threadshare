import { createHash } from "node:crypto";
import { createReadStream } from "node:fs";
import { open, stat } from "node:fs/promises";
import { visit } from "jsonc-parser";

const DEFAULT_CHUNK_SIZE = 64 * 1024;
const DEFAULT_MAX_RECORD_BYTES = 8 * 1024 * 1024;
const MAX_CHUNK_SIZE = 1024 * 1024;
const MAX_RECORD_BYTES = 16 * 1024 * 1024;
const EMPTY_SHA256 = createHash("sha256").digest("hex");
const MAX_JSON_DEPTH = 64;
const MAX_JSON_NODES = 65_536;

function addDiagnostic(diagnostics, item) {
  const current = diagnostics.get(item.code);
  if (current) {
    current.count += 1;
    return;
  }
  diagnostics.set(item.code, { ...item, count: 1 });
}

function boundedSize(value, fallback, maximum, name) {
  if (value === undefined) return fallback;
  if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
    throw new RangeError(`${name} must be a positive safe integer no greater than ${maximum}`);
  }
  return value;
}

function decimalOffset(value, name) {
  if (typeof value !== "string" || !/^[0-9]+$/u.test(value)) {
    throw new TypeError(`checkpoint.${name} must be a decimal string`);
  }
  const offset = Number(value);
  if (!Number.isSafeInteger(offset)) {
    throw new RangeError(`checkpoint.${name} is outside the supported file range`);
  }
  return offset;
}

function explicitStartOffset(value, fileSize) {
  if (value === undefined) return null;
  const offset = typeof value === "number" ? value : decimalOffset(value, "startOffset");
  if (!Number.isSafeInteger(offset) || offset < 0 || offset > fileSize) {
    throw new RangeError("startOffset is outside the current file bounds");
  }
  return offset;
}

function checkpointError(message) {
  return new RangeError(`invalid session record checkpoint: ${message}`);
}

async function verifyPartialTail(file, offset, length, digest, chunkSize) {
  if (length === 0) {
    if (digest !== EMPTY_SHA256) throw checkpointError("partial tail digest does not match");
    return;
  }

  const handle = await open(file, "r");
  const hash = createHash("sha256");
  const buffer = Buffer.allocUnsafe(Math.min(chunkSize, length));
  let remaining = length;
  let position = offset;
  try {
    while (remaining > 0) {
      const bytesToRead = Math.min(buffer.length, remaining);
      const { bytesRead } = await handle.read(buffer, 0, bytesToRead, position);
      if (bytesRead === 0) throw checkpointError("partial tail is no longer readable");
      hash.update(buffer.subarray(0, bytesRead));
      position += bytesRead;
      remaining -= bytesRead;
    }
  } finally {
    await handle.close();
  }
  if (hash.digest("hex") !== digest) throw checkpointError("partial tail digest does not match");
}

async function resumeOffset(file, checkpoint, fileSize, chunkSize) {
  if (checkpoint === undefined) return 0;
  if (checkpoint === null || typeof checkpoint !== "object" || Array.isArray(checkpoint)) {
    throw checkpointError("must be an object");
  }

  const offset = decimalOffset(checkpoint.completeOffset, "completeOffset");
  const tailLength = decimalOffset(checkpoint.partialTailLength, "partialTailLength");
  if (typeof checkpoint.partialTailDigest !== "string" || !/^[a-f0-9]{64}$/u.test(checkpoint.partialTailDigest)) {
    throw checkpointError("partialTailDigest must be a lowercase SHA-256 digest");
  }
  if (checkpoint.eofObserved !== true) throw checkpointError("eofObserved must be true");
  if (offset > fileSize || tailLength > fileSize - offset) {
    throw checkpointError("is outside the current file bounds");
  }

  await verifyPartialTail(file, offset, tailLength, checkpoint.partialTailDigest, chunkSize);
  return offset;
}

class LineAccumulator {
  constructor(maxRecordBytes) {
    this.maxRecordBytes = maxRecordBytes;
    this.rawLength = 0;
    this.pendingByte = null;
    this.contentHash = createHash("sha256");
    this.rawHash = createHash("sha256");
    this.chunks = [];
    this.storedLength = 0;
  }

  append(bytes) {
    if (bytes.length === 0) return;

    this.rawLength += bytes.length;
    this.rawHash.update(bytes);

    if (this.pendingByte !== null) this.contentHash.update(Uint8Array.of(this.pendingByte));
    if (bytes.length > 1) this.contentHash.update(bytes.subarray(0, -1));
    this.pendingByte = bytes[bytes.length - 1];

    const capacity = this.maxRecordBytes + 1;
    const copyLength = Math.min(bytes.length, Math.max(0, capacity - this.storedLength));
    if (copyLength > 0) {
      this.chunks.push(Buffer.from(bytes.subarray(0, copyLength)));
      this.storedLength += copyLength;
    }
  }

  complete() {
    const hasTrailingCr = this.pendingByte === 0x0d;
    if (this.pendingByte !== null && !hasTrailingCr) this.contentHash.update(Uint8Array.of(this.pendingByte));
    const contentLength = this.rawLength - (hasTrailingCr ? 1 : 0);
    return {
      contentLength,
      digest: this.contentHash.digest("hex"),
      oversized: contentLength > this.maxRecordBytes,
      bytes: contentLength <= this.maxRecordBytes
        ? Buffer.concat(this.chunks, this.storedLength).subarray(0, contentLength)
        : null,
    };
  }

  partialTail() {
    return {
      length: this.rawLength,
      digest: this.rawHash.digest("hex"),
    };
  }
}

function recordClass(value) {
  return typeof value.type === "string" && value.type.length > 0 ? value.type : "object";
}

function parseStrictObject(bytes) {
  const text = bytes.toString("utf8");
  const errors = [];
  const containers = [];
  let nodeCount = 0;
  let rootIsObject = false;
  const enter = (keys) => {
    nodeCount += 1;
    if (containers.length === 0 && keys instanceof Set) rootIsObject = true;
    containers.push(keys);
    if (containers.length > MAX_JSON_DEPTH) throw new RangeError("JSON record exceeds maximum depth");
    if (nodeCount > MAX_JSON_NODES) throw new RangeError("JSON record exceeds maximum node count");
  };
  visit(text, {
    onObjectBegin: () => enter(new Set()),
    onObjectProperty: (property) => {
      nodeCount += 1;
      const keys = containers.at(-1);
      if (!(keys instanceof Set)) throw new TypeError("JSON object property is malformed");
      if (keys.has(property)) throw new TypeError("JSON object contains a duplicate key");
      keys.add(property);
      if (nodeCount > MAX_JSON_NODES) throw new RangeError("JSON record exceeds maximum node count");
    },
    onObjectEnd: () => containers.pop(),
    onArrayBegin: () => enter(null),
    onArrayEnd: () => containers.pop(),
    onLiteralValue: () => {
      nodeCount += 1;
      if (nodeCount > MAX_JSON_NODES) throw new RangeError("JSON record exceeds maximum node count");
    },
    onError: (error) => errors.push(error),
  }, { allowTrailingComma: false, disallowComments: true });
  if (!rootIsObject || errors.length > 0 || containers.length !== 0) {
    throw new TypeError("JSON record must be an object");
  }
  const value = JSON.parse(text);
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new TypeError("JSON record must be an object");
  }
  return value;
}

/**
 * Streams complete JSONL object records. Its final return value is
 * `{ diagnostics, checkpoint }`; use `visitSessionRecords` when that value is needed.
 */
export async function* streamSessionRecords(file, options = {}) {
  const chunkSize = boundedSize(options.chunkSize, DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE, "chunkSize");
  const maxRecordBytes = boundedSize(
    options.maxRecordBytes,
    DEFAULT_MAX_RECORD_BYTES,
    MAX_RECORD_BYTES,
    "maxRecordBytes",
  );
  const fileSize = (await stat(file)).size;
  const requestedStart = explicitStartOffset(options.startOffset, fileSize);
  if (requestedStart !== null && options.checkpoint !== undefined) {
    throw new TypeError("startOffset and checkpoint cannot be combined");
  }
  const startOffset = requestedStart ?? await resumeOffset(file, options.checkpoint, fileSize, chunkSize);
  const diagnostics = new Map();
  let completeOffset = startOffset;
  let lineStart = startOffset;
  let position = startOffset;
  let line = new LineAccumulator(maxRecordBytes);

  for await (const chunk of createReadStream(file, { start: startOffset, highWaterMark: chunkSize })) {
    let cursor = 0;
    while (cursor < chunk.length) {
      const newline = chunk.indexOf(0x0a, cursor);
      if (newline === -1) {
        line.append(chunk.subarray(cursor));
        break;
      }

      line.append(chunk.subarray(cursor, newline));
      const complete = line.complete();
      const endOffset = lineStart + complete.contentLength;
      const diagnostic = {
        startOffset: String(lineStart),
        endOffset: String(endOffset),
        recordDigest: complete.digest,
      };

      if (complete.oversized) {
        addDiagnostic(diagnostics, { code: "oversized-json-record", ...diagnostic });
      } else {
        try {
          const value = parseStrictObject(complete.bytes);
          yield {
            value,
            startOffset: String(lineStart),
            endOffset: String(endOffset),
            recordSha256: complete.digest,
            recordClass: recordClass(value),
          };
        } catch {
          addDiagnostic(diagnostics, { code: "invalid-json-record", ...diagnostic });
        }
      }

      completeOffset = position + newline + 1;
      lineStart = completeOffset;
      line = new LineAccumulator(maxRecordBytes);
      cursor = newline + 1;
    }
    position += chunk.length;
  }

  const partialTail = line.partialTail();
  return {
    diagnostics: [...diagnostics.values()],
    checkpoint: {
      completeOffset: String(completeOffset),
      eofObserved: true,
      partialTailLength: String(partialTail.length),
      partialTailDigest: partialTail.digest,
    },
  };
}

export async function visitSessionRecords(file, options = {}, visitor) {
  if (typeof visitor !== "function") throw new TypeError("visitor must be a function");
  const stream = streamSessionRecords(file, options);
  while (true) {
    const next = await stream.next();
    if (next.done) return next.value;
    await visitor(next.value);
  }
}

export async function verifySessionRecordCheckpoint(file, checkpoint, options = {}) {
  const chunkSize = boundedSize(options.chunkSize, DEFAULT_CHUNK_SIZE, MAX_CHUNK_SIZE, "chunkSize");
  const fileSize = (await stat(file)).size;
  return String(await resumeOffset(file, checkpoint, fileSize, chunkSize));
}

export async function readSessionRecordBatch(file, options = {}) {
  const records = [];
  const result = await visitSessionRecords(file, options, async (record) => {
    records.push(record);
  });
  return { records, ...result };
}
