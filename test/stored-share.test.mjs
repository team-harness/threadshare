import assert from "node:assert/strict";
import test from "node:test";
import {
  createStoredShare,
  decodeStoredShare,
  isShareExpired,
  parseRevokeAuthorization,
  revokeTokenMatches,
} from "../src/stored-share.ts";
import { createHash } from "node:crypto";

const NOW = Date.parse("2026-08-01T10:00:00.000Z");

function history() {
  return {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    exportedAt: "2026-08-01T09:00:00.000Z",
    conversation: { id: "conversation-1", title: "Stored share test" },
    entries: [],
  };
}

test("wraps new shares while decoding canonical and legacy storage", () => {
  const revokeToken = Buffer.alloc(32, 7).toString("base64url");
  const revokeTokenSha256 = createHash("sha256").update(revokeToken).digest("base64url");
  const stored = createStoredShare(history(), NOW, { expiresInSeconds: 60, revokeTokenSha256 });
  assert.deepEqual(stored, {
    format: "threadshare-object@v1",
    createdAt: "2026-08-01T10:00:00.000Z",
    expiresAt: "2026-08-01T10:01:00.000Z",
    revokeTokenSha256,
    history: history(),
  });

  assert.deepEqual(decodeStoredShare(JSON.stringify(stored)), {
    history: history(),
    expiresAt: "2026-08-01T10:01:00.000Z",
    revokeTokenSha256,
  });
  assert.deepEqual(decodeStoredShare(JSON.stringify(history())), {
    history: history(),
    expiresAt: undefined,
    revokeTokenSha256: undefined,
  });

  const legacy = history();
  delete legacy.format;
  assert.deepEqual(decodeStoredShare(JSON.stringify(legacy)), {
    history: legacy,
    expiresAt: undefined,
    revokeTokenSha256: undefined,
  });
});

test("parses bearer capabilities and compares their digests", async () => {
  const token = Buffer.alloc(32, 11).toString("base64url");
  const digest = createHash("sha256").update(token).digest("base64url");

  assert.equal(parseRevokeAuthorization(`Bearer ${token}`), token);
  assert.equal(parseRevokeAuthorization(`bearer ${token}`), token);
  for (const value of [undefined, "", token, "Bearer short", `Basic ${token}`]) {
    assert.equal(parseRevokeAuthorization(value), undefined);
  }
  assert.equal(await revokeTokenMatches(digest, token), true);
  assert.equal(await revokeTokenMatches(digest, Buffer.alloc(32, 12).toString("base64url")), false);
  assert.equal(await revokeTokenMatches(undefined, token), false);
  assert.equal(await revokeTokenMatches(digest, undefined), false);
});

test("treats the expiration instant as expired and rejects malformed storage", () => {
  const expiresAt = "2026-08-01T10:01:00.000Z";
  assert.equal(isShareExpired(expiresAt, NOW + 59_999), false);
  assert.equal(isShareExpired(expiresAt, NOW + 60_000), true);
  assert.equal(isShareExpired(undefined, Number.MAX_SAFE_INTEGER), false);

  assert.throws(
    () =>
      decodeStoredShare(
        JSON.stringify({
          format: "threadshare-object@v1",
          createdAt: "not-a-date",
          history: history(),
        }),
      ),
    /Stored share is invalid/,
  );
  assert.throws(() => decodeStoredShare("not json"), /Stored share is invalid/);
});
