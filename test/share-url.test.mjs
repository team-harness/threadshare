import assert from "node:assert/strict";
import test from "node:test";
import { parseShareReference } from "../src/share-url.mjs";

const ID = "a4f2927b-7079-4a1e-ae5d-6b80c43c7ba0";

test("normalizes viewer and API share references without carrying fragments", () => {
  assert.deepEqual(
    parseShareReference(`https://threadshare.example/?id=${ID}#message-user-1`),
    {
      id: ID,
      apiUrl: `https://threadshare.example/api/v1/shares/${ID}`,
      url: `https://threadshare.example/?id=${ID}`,
    },
  );
  assert.deepEqual(
    parseShareReference(`https://threadshare.example/base/api/v1/shares/${ID.toUpperCase()}`),
    {
      id: ID,
      apiUrl: `https://threadshare.example/base/api/v1/shares/${ID}`,
      url: `https://threadshare.example/base/?id=${ID}`,
    },
  );
  assert.deepEqual(
    parseShareReference(`https://threadshare.example/?id=${ID}&format=agent`),
    {
      id: ID,
      apiUrl: `https://threadshare.example/api/v1/shares/${ID}`,
      url: `https://threadshare.example/?id=${ID}`,
    },
  );
});

test("rejects arbitrary URLs, credentials, and capability data in URLs", () => {
  for (const value of [
    `ftp://threadshare.example/?id=${ID}`,
    `https://user:password@threadshare.example/?id=${ID}`,
    `https://threadshare.example/thread/${ID}`,
    `https://threadshare.example/?id=not-a-uuid`,
    `https://threadshare.example/?id=${ID}&token=secret`,
    `https://threadshare.example/?id=${ID}&format=json`,
    `https://threadshare.example/?id=${ID}&format=Agent`,
    `https://threadshare.example/?id=${ID}&format=agent&format=agent`,
    `https://threadshare.example/?id=${ID}&format=agent&extra=value`,
    `https://threadshare.example/?id=${ID}&format=agent&token=secret`,
    `https://threadshare.example/api/v1/shares/${ID}?token=secret`,
    `https://threadshare.example/api/v1/shares/${ID}?format=agent`,
    `https://threadshare.example/api/v1/shares/${ID}/extra`,
    `https://threadshare.example//attacker.example/?id=${ID}`,
    `https://threadshare.example//attacker.example/api/v1/shares/${ID}`,
    `https://threadshare.example/?id=${ID}#token=secret`,
    `https://threadshare.example/?id=${ID}#message-`,
    `https://threadshare.example/?id=${ID}#message-%E0%A4%A`,
  ]) {
    assert.throws(() => parseShareReference(value), /valid Threadshare viewer or API URL/);
  }
});
