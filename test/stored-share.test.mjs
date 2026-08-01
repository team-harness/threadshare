import assert from "node:assert/strict";
import test from "node:test";
import {
  createStoredShare,
  decodeStoredShare,
  isShareExpired,
} from "../src/stored-share.ts";

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
  const stored = createStoredShare(history(), NOW, 60);
  assert.deepEqual(stored, {
    format: "threadshare-object@v1",
    createdAt: "2026-08-01T10:00:00.000Z",
    expiresAt: "2026-08-01T10:01:00.000Z",
    history: history(),
  });

  assert.deepEqual(decodeStoredShare(JSON.stringify(stored)), {
    history: history(),
    expiresAt: "2026-08-01T10:01:00.000Z",
  });
  assert.deepEqual(decodeStoredShare(JSON.stringify(history())), {
    history: history(),
    expiresAt: undefined,
  });

  const legacy = history();
  delete legacy.format;
  assert.deepEqual(decodeStoredShare(JSON.stringify(legacy)), {
    history: legacy,
    expiresAt: undefined,
  });
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
