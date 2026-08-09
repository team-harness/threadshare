import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import { canonicalJson } from "../src/session-facts.mjs";
import {
  INSIGHTS_PROTOCOL_FORMAT,
  INSIGHTS_PROTOCOL_VERSION,
  MAX_PROTOCOL_PAYLOAD_BYTES,
  RETRACTION_COLLECTION_ORDER,
  UPSERT_COLLECTION_ORDER,
  ProtocolFrameDecoder,
  SessionBatchSequenceValidator,
  assertBeginSessionCompatible,
  assertHandshakeCompatible,
  assertProtocolMessage,
  createAbortSessionMessage,
  createBatchAcceptedMessage,
  createBeginSessionMessage,
  createHelloMessage,
  createProtocolErrorMessage,
  createReadyMessage,
  createRetractionBatchMessage,
  createSessionAbortedMessage,
  createSessionAcceptedMessage,
  createSessionCommittedMessage,
  createSessionDeltaMessages,
  createUpsertBatchMessage,
  decodeProtocolFrames,
  encodeProtocolFrame,
  protocolPayloadByteLength,
} from "../src/insights-engine-protocol.mjs";

const fixtureUrl = new URL("./fixtures/insights-protocol-v1/frames.json", import.meta.url);
const SESSION_KEY = "a".repeat(64);
const DELTA_ID = "b".repeat(64);
const EPOCH = "11111111-2222-4333-8444-555555555555";
const COMPILE_OPTIONS_DIGEST = "c".repeat(64);
const BUILD_MANIFEST_DIGEST = "d".repeat(64);

function handshakeContract(overrides = {}) {
  return {
    factSchemaVersion: 1,
    providerAdapterVersions: ["claude@1", "codex@1"],
    privacyPolicyVersion: 1,
    originSecretEpoch: EPOCH,
    duplicatePolicyVersion: 1,
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: [],
    analyzerCapabilities: [],
    rankerVersion: 1,
    ...overrides,
  };
}

function sessionOptions(overrides = {}) {
  return {
    requestId: "2",
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: [],
    analyzerCapabilities: [],
    rankerVersion: 1,
    ...overrides,
  };
}

function sampleDelta(overrides = {}) {
  return {
    format: "session-facts-delta@v1",
    factSchemaVersion: 1,
    providerAdapterVersion: "codex@1",
    privacyPolicyVersion: 1,
    originSecretEpoch: EPOCH,
    duplicatePolicyVersion: 1,
    expectedGeneration: "0",
    targetGeneration: "1",
    mode: "append",
    deltaId: DELTA_ID,
    session: { sessionKey: SESSION_KEY, provider: "codex", marker: "session" },
    retractions: {
      turnKeys: [],
      orphanEventKeys: [],
      authoritativeTurnKeys: [],
    },
    turns: [],
    sourceRecords: [],
    evidenceEvents: [],
    turnEvidence: [],
    capabilities: [],
    capabilityUses: [],
    capabilityUseEvidence: [],
    checkpoint: { generation: "1", marker: "checkpoint" },
    diagnostics: [],
    coverage: {},
    ...overrides,
  };
}

function helloMessage() {
  return createHelloMessage({
    requestId: "1",
    clientVersion: "threadshare@0.6.1",
    requiredContract: handshakeContract({
      providerAdapterVersions: ["codex@1", "claude@1"],
    }),
  });
}

function readyMessage(contractOverrides = {}) {
  return createReadyMessage({
    requestId: "1",
    engineVersion: "threadshare-insights-engine@0.6.1",
    target: "aarch64-apple-darwin",
    sqliteVersion: "3.53.2",
    sqliteCompileOptionsDigest: COMPILE_OPTIONS_DIGEST,
    buildManifestDigest: BUILD_MANIFEST_DIGEST,
    acceptedContract: handshakeContract(contractOverrides),
  });
}

function rawFrame(payload) {
  const bytes = Buffer.isBuffer(payload) ? payload : Buffer.from(payload);
  const header = Buffer.alloc(4);
  header.writeUInt32BE(bytes.length);
  return Buffer.concat([header, bytes]);
}

async function collect(iterable) {
  const values = [];
  for await (const value of iterable) values.push(value);
  return values;
}

test("protocol constants and shared frame vectors stay byte-for-byte stable", async () => {
  assert.equal(INSIGHTS_PROTOCOL_FORMAT, "threadshare-insights-protocol@v1");
  assert.equal(INSIGHTS_PROTOCOL_VERSION, 1);
  assert.equal(MAX_PROTOCOL_PAYLOAD_BYTES, 4_194_304);
  assert.deepEqual(RETRACTION_COLLECTION_ORDER, [
    "turnKeys",
    "orphanEventKeys",
    "authoritativeTurnKeys",
  ]);
  assert.deepEqual(UPSERT_COLLECTION_ORDER, [
    "turns",
    "sourceRecords",
    "evidenceEvents",
    "turnEvidence",
    "capabilities",
    "capabilityUses",
    "capabilityUseEvidence",
  ]);

  const fixture = JSON.parse(await readFile(fixtureUrl, "utf8"));
  assert.equal(fixture.format, "threadshare-insights-protocol-frames@v1");
  for (const vector of fixture.frames) {
    const canonical = canonicalJson(vector.message);
    const payload = Buffer.from(canonical);
    assert.equal(canonical, vector.canonicalPayload, vector.name);
    assert.equal(payload.length, vector.payloadByteLength, vector.name);
    assert.equal(createHash("sha256").update(payload).digest("hex"), vector.payloadSha256, vector.name);
    assert.equal(
      encodeProtocolFrame(vector.message).subarray(0, 4).toString("hex"),
      vector.lengthPrefixHex,
      vector.name,
    );
  }
});

test("decoder accepts fragmented prefix/payload and coalesced canonical frames", async () => {
  const hello = helloMessage();
  const ready = readyMessage();
  const helloFrame = encodeProtocolFrame(hello);
  const readyFrame = encodeProtocolFrame(ready);

  const bytewise = new ProtocolFrameDecoder();
  const decoded = [];
  for (const byte of helloFrame) decoded.push(...bytewise.push(Buffer.from([byte])));
  bytewise.end();
  assert.deepEqual(decoded, [hello]);

  const coalesced = new ProtocolFrameDecoder();
  assert.deepEqual(coalesced.push(Buffer.concat([helloFrame, readyFrame])), [hello, ready]);
  coalesced.end();

  assert.deepEqual(
    await collect(
      decodeProtocolFrames([
        helloFrame.subarray(0, 3),
        Buffer.concat([helloFrame.subarray(3), readyFrame.subarray(0, 11)]),
        readyFrame.subarray(11),
      ]),
    ),
    [hello, ready],
  );
});

test("decoder rejects EOF, oversize, invalid JSON/UTF-8, duplicate/non-canonical, and unknown fields", () => {
  const hello = helloMessage();
  const frame = encodeProtocolFrame(hello);
  for (const truncated of [frame.subarray(0, 2), frame.subarray(0, frame.length - 1)]) {
    const decoder = new ProtocolFrameDecoder();
    decoder.push(truncated);
    assert.throws(
      () => decoder.end(),
      (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
    );
  }

  const oversizedHeader = Buffer.alloc(4);
  oversizedHeader.writeUInt32BE(65);
  assert.throws(
    () => new ProtocolFrameDecoder({ maxPayloadBytes: 64 }).push(oversizedHeader),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_FRAME_TOO_LARGE",
  );
  assert.throws(
    () => new ProtocolFrameDecoder().push(rawFrame(Buffer.from([0xc3, 0x28]))),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
  assert.throws(
    () => new ProtocolFrameDecoder().push(rawFrame("{")),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
  assert.throws(
    () => new ProtocolFrameDecoder().push(rawFrame(JSON.stringify(hello))),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
  const duplicateKey = canonicalJson(hello).replace(
    "{",
    "{\"format\":\"threadshare-insights-protocol@v1\",",
  );
  assert.throws(
    () => new ProtocolFrameDecoder().push(rawFrame(duplicateKey)),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
  assert.throws(
    () => new ProtocolFrameDecoder().push(rawFrame(canonicalJson({ ...hello, future: true }))),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
  assert.throws(
    () => assertProtocolMessage({ ...hello, type: "FUTURE_MESSAGE" }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
  );
});

test("payload cap uses canonical UTF-8 bytes and permits an exactly full payload", () => {
  const empty = createUpsertBatchMessage({
    requestId: "2",
    sequence: "0",
    collection: "turns",
    items: [{ text: "" }],
  });
  const baseBytes = protocolPayloadByteLength(empty);
  const exact = createUpsertBatchMessage({
    requestId: "2",
    sequence: "0",
    collection: "turns",
    items: [{ text: "x".repeat(31) }],
  });
  const exactBytes = baseBytes + 31;
  assert.equal(protocolPayloadByteLength(exact), exactBytes);
  assert.equal(encodeProtocolFrame(exact, { maxPayloadBytes: exactBytes }).length, exactBytes + 4);
  assert.throws(
    () => encodeProtocolFrame(exact, { maxPayloadBytes: exactBytes - 1 }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_FRAME_TOO_LARGE",
  );

  const multibyte = createUpsertBatchMessage({
    requestId: "2",
    sequence: "0",
    collection: "turns",
    items: [{ text: "界".repeat(31) }],
  });
  assert.equal(protocolPayloadByteLength(multibyte), baseBytes + 31 * 3);
});

test("HELLO/READY and BEGIN negotiate every contract axis", () => {
  const hello = helloMessage();
  assert.deepEqual(hello.requiredContract.providerAdapterVersions, ["claude@1", "codex@1"]);
  const ready = readyMessage();
  assert.equal(assertHandshakeCompatible(hello, ready), true);

  const begin = createBeginSessionMessage(sampleDelta(), sessionOptions());
  assert.equal(assertBeginSessionCompatible(begin, ready), true);
  assert.deepEqual(begin.counts, {
    turnKeys: "0",
    orphanEventKeys: "0",
    authoritativeTurnKeys: "0",
    turns: "0",
    sourceRecords: "0",
    evidenceEvents: "0",
    turnEvidence: "0",
    capabilities: "0",
    capabilityUses: "0",
    capabilityUseEvidence: "0",
  });
  assert.deepEqual(begin.session, sampleDelta().session);

  const unsupported = readyMessage({ storageSchemaVersion: 2 });
  assert.throws(
    () => assertHandshakeCompatible(hello, unsupported),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_CONTRACT_UNSUPPORTED",
  );
  assert.throws(
    () => assertBeginSessionCompatible(begin, unsupported),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_CONTRACT_UNSUPPORTED",
  );
});

test("response and abort envelopes use request-scoped decimal sequence", () => {
  const begin = createBeginSessionMessage(sampleDelta(), sessionOptions());
  const messages = [
    createSessionAcceptedMessage(begin),
    createBatchAcceptedMessage({ requestId: "2", sequence: "0" }),
    createSessionCommittedMessage({
      requestId: "2",
      sessionKey: SESSION_KEY,
      deltaId: DELTA_ID,
      snapshotSeq: "9",
      idempotent: false,
    }),
    createAbortSessionMessage({ requestId: "2", nextSequence: "1", reason: "cancelled" }),
    createSessionAbortedMessage({
      requestId: "2",
      sessionKey: SESSION_KEY,
      deltaId: DELTA_ID,
      nextSequence: "1",
    }),
    createProtocolErrorMessage({
      requestId: "2",
      code: "TS_INSIGHTS_GENERATION_CONFLICT",
      category: "conflict",
      message: "generation conflict",
      retryable: true,
      fatal: false,
    }),
  ];
  for (const message of messages) {
    assert.deepEqual(new ProtocolFrameDecoder().push(encodeProtocolFrame(message)), [message]);
  }
  assert.throws(
    () => createProtocolErrorMessage({
      requestId: "2",
      code: "X",
      category: "protocol",
      message: "界".repeat(342),
    }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
});

test("session generator greedily batches actual canonical bytes in fixed collection order", async () => {
  const first = { turnKey: "1".repeat(64), text: "界".repeat(120) };
  const second = { turnKey: "2".repeat(64), text: "界".repeat(120) };
  const twoTurnBytes = protocolPayloadByteLength(
    createUpsertBatchMessage({
      requestId: "2",
      sequence: "3",
      collection: "turns",
      items: [first, second],
    }),
  );
  const maxPayloadBytes = twoTurnBytes - 1;
  const delta = sampleDelta({
    retractions: {
      turnKeys: ["3".repeat(64)],
      orphanEventKeys: ["4".repeat(64)],
      authoritativeTurnKeys: ["1".repeat(64), "2".repeat(64)],
    },
    turns: [first, second],
    sourceRecords: [{ sourceRecordKey: "5".repeat(64) }],
    capabilities: [{ capabilityKey: "6".repeat(64) }],
  });
  const beginBytes = protocolPayloadByteLength(createBeginSessionMessage(delta, sessionOptions()));
  assert.ok(maxPayloadBytes > beginBytes);

  const messages = await collect(
    createSessionDeltaMessages(delta, sessionOptions({ maxPayloadBytes })),
  );
  assert.equal(messages[0].type, "BEGIN_SESSION");
  assert.equal(messages.at(-1).type, "COMMIT_SESSION");
  for (const message of messages) {
    assert.ok(protocolPayloadByteLength(message) <= maxPayloadBytes, message.type);
  }

  const batches = messages.slice(1, -1);
  assert.deepEqual(
    batches.map((message) => `${message.type}:${message.collection}`),
    [
      "RETRACT_FACTS:turnKeys",
      "RETRACT_FACTS:orphanEventKeys",
      "RETRACT_FACTS:authoritativeTurnKeys",
      "UPSERT_FACTS:turns",
      "UPSERT_FACTS:turns",
      "UPSERT_FACTS:sourceRecords",
      "UPSERT_FACTS:capabilities",
    ],
  );
  assert.deepEqual(
    batches.map((message) => message.sequence),
    batches.map((_, index) => String(index)),
  );
  assert.equal(messages.at(-1).nextSequence, String(batches.length));
  assert.deepEqual(
    batches.filter((message) => message.collection === "turns").flatMap((message) => message.items),
    [first, second],
  );

  const validator = new SessionBatchSequenceValidator(messages[0]);
  for (const message of messages.slice(1)) validator.accept(message);
  assert.equal(validator.done, true);
  assert.equal(validator.nextSequence, String(batches.length));
});

test("session sequence rejects gaps, count mismatch, collection regression, and request mismatch", () => {
  const begin = createBeginSessionMessage(
    sampleDelta({
      retractions: {
        turnKeys: ["1".repeat(64)],
        orphanEventKeys: [],
        authoritativeTurnKeys: [],
      },
      turns: [{ turnKey: "2".repeat(64) }],
    }),
    sessionOptions(),
  );
  const gap = new SessionBatchSequenceValidator(begin);
  assert.throws(
    () => gap.accept(createRetractionBatchMessage({
      requestId: "2",
      sequence: "1",
      collection: "turnKeys",
      items: ["1".repeat(64)],
    })),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
  );

  const overflow = new SessionBatchSequenceValidator(begin);
  assert.throws(
    () => overflow.accept(createRetractionBatchMessage({
      requestId: "2",
      sequence: "0",
      collection: "turnKeys",
      items: ["1".repeat(64), "3".repeat(64)],
    })),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
  );

  const regression = new SessionBatchSequenceValidator(begin);
  regression.accept(createUpsertBatchMessage({
    requestId: "2",
    sequence: "0",
    collection: "turns",
    items: [{ turnKey: "2".repeat(64) }],
  }));
  assert.throws(
    () => regression.accept(createRetractionBatchMessage({
      requestId: "2",
      sequence: "1",
      collection: "turnKeys",
      items: ["1".repeat(64)],
    })),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
  );

  const foreign = new SessionBatchSequenceValidator(begin);
  assert.throws(
    () => foreign.accept(createRetractionBatchMessage({
      requestId: "3",
      sequence: "0",
      collection: "turnKeys",
      items: ["1".repeat(64)],
    })),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_UNEXPECTED_FRAME",
  );

  for (const sequence of ["01", "18446744073709551616"]) {
    assert.throws(
      () => createRetractionBatchMessage({
        requestId: "2",
        sequence,
        collection: "turnKeys",
        items: ["1".repeat(64)],
      }),
      (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
    );
  }
  assert.throws(
    () => createHelloMessage({
      requestId: "1",
      clientVersion: "threadshare@0.6.1",
      requiredContract: handshakeContract({ providerAdapterVersions: ["cödex@1"] }),
    }),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_INVALID_FRAME",
  );
});

test("single Fact cannot split and async generator does not pre-encode later collections", async () => {
  let turnsCanonicalized = 0;
  const lazyTurn = new Proxy(
    { turnKey: "1".repeat(64), text: "lazy" },
    {
      ownKeys(target) {
        turnsCanonicalized += 1;
        return Reflect.ownKeys(target);
      },
    },
  );
  const iterator = createSessionDeltaMessages(
    sampleDelta({ turns: [lazyTurn] }),
    sessionOptions({ maxPayloadBytes: 1_024 }),
  );
  assert.equal((await iterator.next()).value.type, "BEGIN_SESSION");
  assert.equal(turnsCanonicalized, 0);
  assert.equal((await iterator.next()).value.collection, "turns");
  assert.ok(turnsCanonicalized > 0);

  await assert.rejects(
    () => collect(
      createSessionDeltaMessages(
        sampleDelta({ turns: [{ turnKey: "1".repeat(64), text: "x".repeat(2_000) }] }),
        sessionOptions({ maxPayloadBytes: 1_024 }),
      ),
    ),
    (error) => error.code === "TS_INSIGHTS_PROTOCOL_ITEM_TOO_LARGE",
  );
});
