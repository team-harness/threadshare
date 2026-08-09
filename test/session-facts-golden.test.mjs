import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";
import {
  canonicalJson,
  createPrivacyContext,
  hashKey,
  toWellFormedUnicode,
} from "../src/session-facts.mjs";

const fixtureUrl = new URL("./fixtures/session-facts-golden.v1.json", import.meta.url);

function decodePart(part) {
  if (part.encoding === "utf8") return part.value;
  if (part.encoding === "nfcUtf8") return part.value.normalize("NFC");
  if (part.encoding === "hex") return Buffer.from(part.value, "hex");
  if (part.encoding === "u64be") {
    const bytes = Buffer.alloc(8);
    bytes.writeBigUInt64BE(BigInt(part.value));
    return bytes;
  }
  if (part.encoding === "i32be") {
    const bytes = Buffer.alloc(4);
    bytes.writeInt32BE(Number(part.value));
    return bytes;
  }
  if (part.encoding === "u16be") {
    const bytes = Buffer.alloc(2);
    bytes.writeUInt16BE(Number(part.value));
    return bytes;
  }
  if (part.encoding === "u8") return Buffer.from([Number(part.value)]);
  if (part.encoding === "concat") return Buffer.concat(part.parts.map(decodePart));
  throw new TypeError(`unsupported golden part encoding: ${part.encoding}`);
}

test("Node matches the shared SessionFacts v1 golden vectors", async () => {
  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  assert.equal(fixture.version, 1);
  for (const vector of fixture.hashVectors) {
    assert.equal(
      hashKey(vector.domain, ...vector.parts.map(decodePart)),
      vector.expected,
      vector.name,
    );
  }
  for (const vector of fixture.canonicalVectors) {
    assert.equal(canonicalJson(vector.value), vector.expected, vector.name);
  }
  for (const vector of fixture.canonicalRejectVectors) {
    assert.throws(() => canonicalJson(vector.value), TypeError, vector.name);
  }
  assert.throws(() => canonicalJson(String.fromCharCode(0xd800)), TypeError);
  assert.throws(() => canonicalJson(`bad ${String.fromCharCode(0xd800)} text`), TypeError);
  for (const vector of fixture.wellFormedUnicodeVectors) {
    assert.equal(
      toWellFormedUnicode(String.fromCharCode(...vector.utf16)),
      vector.expected,
      vector.name,
    );
  }
  for (const vector of fixture.digestVectors) {
    const canonical = canonicalJson(vector.value);
    assert.equal(canonical, vector.expectedCanonical, vector.name);
    assert.equal(
      createHash("sha256").update(canonical).digest("hex"),
      vector.expectedSha256,
      vector.name,
    );
  }

  const privacy = createPrivacyContext({
    secret: Buffer.from(fixture.privacy.secretHex, "hex"),
    originSecretEpoch: fixture.privacy.originSecretEpoch,
  });
  for (const vector of fixture.privacy.vectors) {
    const actual = vector.kind === "input"
      ? privacy.inputFingerprint(
          vector.provider,
          vector.capabilityKind,
          vector.capabilityName,
          vector.input,
        )
      : privacy.pathFingerprint(vector.provider, vector.path);
    assert.equal(actual, vector.expected, vector.name);
  }
});
