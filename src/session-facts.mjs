import Ajv2020 from "ajv/dist/2020.js";
import { createHash, createHmac } from "node:crypto";
import { readFileSync } from "node:fs";

import {
  assertWellFormedUnicode,
  canonicalJson,
  canonicalString,
  isPlainObject,
} from "./canonical-json.mjs";

export { canonicalJson };

const deltaSchema = JSON.parse(
  readFileSync(new URL("../schema/session-facts-delta.v1.schema.json", import.meta.url), "utf8"),
);
const deltaSchemaV2 = JSON.parse(
  readFileSync(new URL("../schema/session-facts-delta.v2.schema.json", import.meta.url), "utf8"),
);
const ajvOptions = { allErrors: true, strict: false };
const validateDelta = new Ajv2020(ajvOptions).compile(deltaSchema);
const ajvV2 = new Ajv2020(ajvOptions);
ajvV2.addSchema(deltaSchema);
const validateDeltaV2 = ajvV2.compile(deltaSchemaV2);
const eventValidatorNames = Object.freeze({
  "visible-message": "visibleMessage",
  "capability-invocation": "capabilityInvocation",
  "capability-result": "capabilityResult",
  "skill-catalog-entry": "skillCatalogEntry",
  "skill-load": "skillLoad",
  "turn-lifecycle": "turnLifecycle",
  "provider-status": "providerStatus",
});
const eventValidators = new Map(Object.entries(eventValidatorNames).map(([kind, definition]) => [
  kind,
  new Ajv2020(ajvOptions).compile({
    $schema: deltaSchema.$schema,
    $ref: `#/$defs/${definition}`,
    $defs: deltaSchema.$defs,
  }),
]));
const UUID_PATTERN = /^[0-9a-fA-F]{8}-(?:[0-9a-fA-F]{4}-){3}[0-9a-fA-F]{12}$/u;
const MAX_PART_BYTES = 0xffff_ffff;

function assertAsciiDomain(domain) {
  if (typeof domain !== "string" || domain.length === 0 || /[^\x20-\x7e]/u.test(domain)) {
    throw new TypeError("hash domain must be a non-empty ASCII string");
  }
}

function partBuffer(part) {
  if (typeof part === "string") return Buffer.from(part, "utf8");
  if (Buffer.isBuffer(part)) return Buffer.from(part);
  throw new TypeError("hash parts must be strings or Buffers; encode integers as fixed-width Buffers");
}

function encodedParts(domain, parts) {
  assertAsciiDomain(domain);
  const buffers = [Buffer.from(`threadshare:${domain}:v1`, "ascii"), Buffer.from([0])];
  for (const part of parts) {
    const bytes = partBuffer(part);
    if (bytes.length > MAX_PART_BYTES) throw new RangeError("hash part exceeds uint32 length");
    const length = Buffer.allocUnsafe(4);
    length.writeUInt32BE(bytes.length);
    buffers.push(length, bytes);
  }
  return buffers;
}

/** SHA-256 over Threadshare's domain-separated length-prefixed key encoding. */
export function hashKey(domain, ...parts) {
  const hash = createHash("sha256");
  for (const buffer of encodedParts(domain, parts)) hash.update(buffer);
  return hash.digest("hex");
}

/** Replaces unpaired UTF-16 surrogates with U+FFFD without changing valid pairs. */
export function toWellFormedUnicode(value) {
  if (typeof value !== "string") throw new TypeError("Unicode normalization requires a string");
  let output = "";
  let segmentStart = 0;
  for (let index = 0; index < value.length; index += 1) {
    const code = value.charCodeAt(index);
    if (code >= 0xd800 && code <= 0xdbff) {
      const next = index + 1 < value.length ? value.charCodeAt(index + 1) : -1;
      if (next >= 0xdc00 && next <= 0xdfff) {
        index += 1;
        continue;
      }
    } else if (code < 0xdc00 || code > 0xdfff) {
      continue;
    }
    output += `${value.slice(segmentStart, index)}\ufffd`;
    segmentStart = index + 1;
  }
  return segmentStart === 0 ? value : output + value.slice(segmentStart);
}

function jcsValue(value, ancestors) {
  if (value === null) return "null";
  if (typeof value === "boolean") return value ? "true" : "false";
  if (typeof value === "string") {
    assertWellFormedUnicode(value);
    return JSON.stringify(value);
  }
  if (typeof value === "number") {
    if (!Number.isFinite(value)) throw new TypeError("JCS only permits finite numbers");
    return JSON.stringify(value);
  }
  if (typeof value === "undefined") throw new TypeError("JCS does not permit undefined");
  if (typeof value !== "object") throw new TypeError("JCS only permits JSON values");
  if (ancestors.has(value)) throw new TypeError("JCS does not permit cycles");

  ancestors.add(value);
  try {
    if (Array.isArray(value)) {
      const values = [];
      for (let index = 0; index < value.length; index += 1) {
        values.push(jcsValue(value[index], ancestors));
      }
      return `[${values.join(",")}]`;
    }
    if (!isPlainObject(value)) throw new TypeError("JCS only permits plain objects");
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new TypeError("JCS objects may not contain symbol keys");
    }
    const entries = Object.keys(value).map((key) => {
      assertWellFormedUnicode(key);
      const descriptor = Object.getOwnPropertyDescriptor(value, key);
      if (!descriptor || !("value" in descriptor)) {
        throw new TypeError("JCS objects may not contain accessors");
      }
      return [key, descriptor.value];
    });
    entries.sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${jcsValue(item, ancestors)}`).join(",")}}`;
  } finally {
    ancestors.delete(value);
  }
}

function normalizeLexicalPath(path) {
  if (typeof path !== "string") throw new TypeError("path fingerprint requires a string path");
  const canonical = canonicalString(toWellFormedUnicode(path));
  const windowsDrive = /^[A-Za-z]:/u.test(canonical);
  const windowsUnc = canonical.startsWith("\\\\");
  const input = windowsDrive || windowsUnc ? canonical.replaceAll("\\", "/") : canonical;
  const drive = /^([A-Za-z]):/u.exec(input);
  const prefix = drive ? `${drive[1].toUpperCase()}:` : "";
  const uncPrefix = windowsUnc ? "//" : "";
  const remaining = drive
    ? input.slice(drive[0].length)
    : windowsUnc
      ? input.slice(2)
      : input;
  const absolute = windowsUnc || remaining.startsWith("/");
  const segments = [];
  const protectedSegments = windowsUnc ? 2 : 0;
  for (const segment of remaining.split("/")) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (segments.length > protectedSegments && segments.at(-1) !== "..") segments.pop();
      else if (!absolute) segments.push(segment);
    } else {
      segments.push(segment);
    }
  }
  const body = segments.join("/");
  if (prefix) return `${prefix}${absolute ? "/" : ""}${body}` || prefix;
  if (uncPrefix) return `${uncPrefix}${body}`;
  if (absolute) return `/${body}`;
  return body || ".";
}

function inputBytes(input) {
  if (Buffer.isBuffer(input)) return Buffer.from(input);
  if (typeof input === "string") {
    let parsed;
    try {
      parsed = JSON.parse(input);
    } catch (error) {
      if (!(error instanceof SyntaxError)) throw error;
      return Buffer.from(input, "utf8");
    }
    try {
      return Buffer.from(jcsValue(parsed, new WeakSet()), "utf8");
    } catch (error) {
      if (!(error instanceof TypeError)) throw error;
      return Buffer.from(input, "utf8");
    }
  }
  try {
    return Buffer.from(jcsValue(input, new WeakSet()), "utf8");
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    return Buffer.from(JSON.stringify(input), "utf8");
  }
}

/**
 * Creates non-reversible, index-local fingerprint helpers. The secret stays in
 * this function's lexical scope and is copied so later caller mutation cannot
 * alter fingerprints.
 */
export function createPrivacyContext({ secret, originSecretEpoch } = {}) {
  if (!Buffer.isBuffer(secret) || secret.length !== 32) {
    throw new TypeError("privacy secret must be a 32-byte Buffer");
  }
  if (typeof originSecretEpoch !== "string" || !UUID_PATTERN.test(originSecretEpoch)) {
    throw new TypeError("originSecretEpoch must be a UUID");
  }
  const key = Buffer.from(secret);
  const epoch = originSecretEpoch.toLowerCase();
  const fingerprint = (domain, ...parts) => {
    const hmac = createHmac("sha256", key);
    for (const buffer of encodedParts(domain, parts)) hmac.update(buffer);
    return hmac.digest("hex");
  };

  return Object.freeze({
    epoch,
    originSecretEpoch: epoch,
    fingerprint,
    pathFingerprint: (provider, path) => fingerprint("path", provider, normalizeLexicalPath(path)),
    inputFingerprint: (provider, kind, name, input) =>
      fingerprint("input", provider, kind, name, inputBytes(input)),
    projectFingerprint: (provider, path) => fingerprint("project", provider, normalizeLexicalPath(path)),
    lineageFingerprint: (provider, id) => fingerprint("lineage", provider, id),
    dedupeFingerprint: (provider, canonicalDigest) =>
      fingerprint("dedupe", provider, canonicalDigest),
  });
}

/** Returns structured Ajv errors without throwing for an invalid delta. */
export function validateSessionFactsDelta(delta) {
  if (!delta || typeof delta !== "object" || Array.isArray(delta)) {
    const valid = Boolean(validateDelta(delta));
    return { valid, errors: valid ? [] : [...(validateDelta.errors ?? [])] };
  }
  const hasEventArray = Array.isArray(delta.evidenceEvents);
  const events = hasEventArray ? delta.evidenceEvents : [];
  const envelopeValid = Boolean(validateDelta(hasEventArray ? { ...delta, evidenceEvents: [] } : delta));
  const errors = envelopeValid ? [] : [...(validateDelta.errors ?? [])];
  for (let index = 0; index < events.length; index += 1) {
    const event = events[index];
    const validator = eventValidators.get(event?.kind);
    if (!validator) {
      errors.push({
        instancePath: `/evidenceEvents/${index}/kind`,
        keyword: "enum",
        message: "must be a supported evidence event kind",
        params: {},
        schemaPath: "#/$defs/evidenceEvent/oneOf",
      });
      continue;
    }
    if (!validator(event)) {
      for (const error of validator.errors ?? []) {
        errors.push({ ...error, instancePath: `/evidenceEvents/${index}${error.instancePath}` });
      }
    }
  }
  return { valid: errors.length === 0, errors };
}

/** Validates the unredacted, chunked SessionFactsDeltaV2 contract. */
export function validateSessionFactsDeltaV2(delta) {
  const valid = Boolean(validateDeltaV2(delta));
  return { valid, errors: valid ? [] : [...(validateDeltaV2.errors ?? [])] };
}

export function assertSessionFactsDelta(delta) {
  const result = validateSessionFactsDelta(delta);
  if (!result.valid) throw new TypeError(`Invalid SessionFactsDeltaV1: ${result.errors[0]?.message ?? "schema validation failed"}`);
  return delta;
}

export function assertSessionFactsDeltaV2(delta) {
  const result = validateSessionFactsDeltaV2(delta);
  if (!result.valid) throw new TypeError(`Invalid SessionFactsDeltaV2: ${result.errors[0]?.message ?? "schema validation failed"}`);
  return delta;
}
