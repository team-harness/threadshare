import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import test from "node:test";

import Ajv2020 from "ajv/dist/2020.js";

import {
  collectMemoryInsightsSelection,
  normalizeMemoryExtractionRequest,
  resolveMemoryInsightsScope,
} from "../src/memory-insights-source.mjs";

const DATABASE_UUID = "11111111-2222-4333-8444-555555555555";
const SESSION_KEY = "a".repeat(64);
const REPOSITORY_KEY = "b".repeat(64);
const PROJECT_KEY = "c".repeat(64);
const COMMIT_KEY = "d".repeat(64);
const FILE_KEY = "e".repeat(64);
const COMMIT_HASH = "f".repeat(40);
const EDGE_REVISION = "1".repeat(64);
const TURN_KEYS = ["2".repeat(64), "3".repeat(64), "4".repeat(64)];
const TURN_REVISIONS = ["5".repeat(64), "6".repeat(64), "7".repeat(64)];
const WINDOW = {
  after: "2026-08-01T00:00:00.000Z",
  before: "2026-08-22T00:00:00.000Z",
};

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function extractionRequest(overrides = {}) {
  return {
    format: "threadshare-memory-extraction-request@v1",
    window: WINDOW,
    filters: {
      providers: ["codex"],
      sessionKeys: [SESSION_KEY],
      resultEvidence: ["provider-completed"],
    },
    ...overrides,
  };
}

function evidenceContent(turnIndex) {
  const eventKey = `${8 + turnIndex}`.repeat(64);
  const payloadKey = `${turnIndex + 1}`.repeat(64);
  const text = turnIndex === 0
    ? "How should release evidence be checked?"
    : `Follow-up release question ${turnIndex}`;
  const payloadSha = sha256(text);
  return [
    JSON.stringify({
      format: "threadshare-insights-evidence-line@v1",
      event: {
        eventKey,
        sessionKey: SESSION_KEY,
        turnKey: TURN_KEYS[turnIndex],
        provider: "codex",
        projectKey: PROJECT_KEY,
        originScope: "main",
        observedAt: `2026-08-10T09:00:0${turnIndex}.000Z`,
        kind: "visible-message",
        completeness: "full",
        revision: `${turnIndex + 1}`.repeat(64),
        metadata: { role: "user" },
      },
    }),
    JSON.stringify({
      format: "threadshare-insights-evidence-line@v1",
      payload: {
        payloadKey,
        eventKey,
        kind: "message-content",
        encoding: "utf-8",
        byteLength: String(Buffer.byteLength(text)),
        sha256: payloadSha,
        completeness: "full",
      },
    }),
    JSON.stringify({
      format: "threadshare-insights-evidence-line@v1",
      payloadChunk: {
        payloadKey,
        ordinal: "0",
        content: text,
        byteLength: String(Buffer.byteLength(text)),
        sha256: payloadSha,
      },
    }),
    "",
  ].join("\n");
}

function traceResponse(snapshotSeq) {
  return {
    databaseUuid: DATABASE_UUID,
    snapshotSeq,
    evaluatedAt: "2026-08-21T00:00:00.000Z",
    root: { kind: "session", key: SESSION_KEY },
    nodes: [
      {
        kind: "git-commit",
        key: COMMIT_KEY,
        revision: "9".repeat(64),
        label: "release evidence",
        observedAt: "2026-08-10T09:30:00.000Z",
        attributes: {
          repositoryKey: REPOSITORY_KEY,
          objectId: COMMIT_HASH,
          parentObjectIds: [],
          reachable: true,
          externalLinks: { commit: null },
        },
      },
      {
        kind: "file",
        key: FILE_KEY,
        revision: "0".repeat(64),
        label: "package.json",
        observedAt: "2026-08-10T09:20:00.000Z",
        attributes: { repositoryKey: REPOSITORY_KEY, path: "package.json" },
      },
    ],
    edges: [
      {
        relation: "session-observed-commit",
        from: { kind: "session", key: SESSION_KEY },
        to: { kind: "git-commit", key: COMMIT_KEY },
        strength: "direct",
        source: "observed-git-result",
        facts: [{ kind: "full-commit-hash" }],
        limitations: ["not-authorship"],
        revision: EDGE_REVISION,
      },
      {
        relation: "session-touched-file",
        from: { kind: "session", key: SESSION_KEY },
        to: { kind: "file", key: FILE_KEY },
        strength: "direct",
        source: "normalized-file-event",
        facts: [],
        limitations: ["not-exclusive-line-attribution"],
        revision: "a".repeat(64),
      },
    ],
    nextCursor: null,
    truncated: false,
    coverage: {
      repositoryState: "complete",
      intentState: "complete",
      unresolvedRefCount: "0",
      excludedCandidateEdgeCount: "0",
      excludedContextualEdgeCount: "0",
      unreachableCommitCount: "0",
      unselectedRepositoryCount: "0",
    },
  };
}

function fakeReader(snapshotSeq = "7", options = {}) {
  return {
    async search(request) {
      assert.deepEqual(request.filters.projectKeys, [PROJECT_KEY]);
      assert.deepEqual(request.filters.sessionKeys, [SESSION_KEY]);
      assert.deepEqual(request.filters.closureStates, ["hard-sealed"]);
      const results = TURN_KEYS.map((turnKey, index) => ({
        turnKey,
        sessionKey: SESSION_KEY,
        revision: TURN_REVISIONS[index],
        provider: "codex",
        projectKey: PROJECT_KEY,
        observedTimestamp: `2026-08-10T09:00:0${index}.000Z`,
        problemExcerpt: `release ${index}`,
        problemTruncated: false,
        finalAnswerExcerpt: index === 2 ? "Run the release checks." : null,
        finalAnswerTruncated: false,
        closureState: "hard-sealed",
        resultEvidence: "provider-completed",
        score: null,
      }));
      return {
        databaseUuid: DATABASE_UUID,
        snapshot: { snapshotSeq, projectionVersion: 2, analyzerVersion: 1, rankerVersion: 1 },
        totalMatchCount: options.totalMatchCount ?? String(results.length),
        results: options.results ?? results,
      };
    },
    async evidenceV2(request) {
      const index = TURN_KEYS.indexOf(request.target.turnKey);
      assert.notEqual(index, -1);
      assert.equal(request.target.revision, TURN_REVISIONS[index]);
      const content = evidenceContent(index);
      return {
        format: "threadshare-insights-evidence@v2",
        databaseUuid: DATABASE_UUID,
        snapshotSeq,
        target: request.target,
        revision: request.target.revision,
        payloadSha256: sha256(content),
        totalBytes: String(Buffer.byteLength(content)),
        range: { start: "0", end: String(Buffer.byteLength(content)) },
        content,
        nextCursor: null,
        complete: true,
      };
    },
    async deliveryTrace() {
      return traceResponse(snapshotSeq);
    },
    async recipe(request) {
      assert.equal(request.name, "extraction-candidates@1");
      assert.deepEqual(request.filters.turnKeys, [...TURN_KEYS].sort());
      assert.deepEqual(request.filters.sessionKeys, []);
      assert.equal(request.limit, 66);
      assert.equal(request.allowDegraded, false);
      return {
        name: "extraction-candidates@1",
        databaseUuid: DATABASE_UUID,
        snapshotSeq: options.recipeSnapshotSeq ?? snapshotSeq,
        items: options.candidateItems ?? [{
          sessionKey: SESSION_KEY,
          eligibleTurnCount: "3",
          directDeliveryEdgeCount: "1",
          observedDeliveryEdgeCount: "0",
          recoveredFailureChainCount: "1",
          mainCapabilityInvocationCount: "0",
          hasConclusiveFinalAnswer: true,
          contributions: {
            directDelivery: "40",
            observedDelivery: "0",
            recoveredFailureChains: "15",
            capabilityDensity: "0",
            conclusiveFinalAnswer: "5",
          },
          score: "60",
          evidence: {
            kind: "session",
            sessionKey: SESSION_KEY,
            revision: "9".repeat(64),
          },
        }],
        totalItemCount: "1",
        truncated: false,
      };
    },
  };
}

test("memory extraction requires an explicit bounded window and rejects owner overrides", () => {
  for (const invalid of [
    { format: "threadshare-memory-extraction-request@v1" },
    extractionRequest({ window: undefined }),
    extractionRequest({
      window: {
        after: "2025-01-01T00:00:00.000Z",
        before: "2026-08-22T00:00:00.000Z",
      },
    }),
    extractionRequest({ filters: { projectKeys: [PROJECT_KEY] } }),
    extractionRequest({ filters: { closureStates: ["open"] } }),
  ]) {
    assert.throws(
      () => normalizeMemoryExtractionRequest(invalid),
      (error) => error?.code === "TS_INSIGHTS_REQUEST_INVALID",
    );
  }

  const normalized = normalizeMemoryExtractionRequest(extractionRequest());
  assert.deepEqual(normalized.window, WINDOW);
  assert.deepEqual(normalized.filters.sessionKeys, [SESSION_KEY]);
  assert.equal(Object.isFrozen(normalized), true);
});

test("published extraction request schema matches normalization and rejects owner overrides", async () => {
  const document = JSON.parse(await readFile(new URL(
    "../schema/threadshare-memory-extraction-request.v1.schema.json",
    import.meta.url,
  ), "utf8"));
  const validate = new Ajv2020({ allErrors: true, strict: true }).compile(document);
  assert.equal(validate(normalizeMemoryExtractionRequest(extractionRequest())), true,
    JSON.stringify(validate.errors));
  assert.equal(validate({
    ...extractionRequest(),
    filters: { projectKeys: [PROJECT_KEY] },
  }), false);
  assert.equal(validate({
    ...extractionRequest(),
    filters: { capabilityTerminalStates: ["failed"] },
  }), false);
});

test("repository scope is derived from the registered worktree and never caller supplied", () => {
  const privacyContext = {
    projectFingerprint(provider, root) {
      assert.equal(root, "/work/threadshare");
      return provider === "codex" ? PROJECT_KEY : "0".repeat(64);
    },
    fingerprint(domain, id) {
      assert.equal(domain, "repository");
      assert.equal(id, "repo-registration-id");
      return REPOSITORY_KEY;
    },
  };
  const scope = resolveMemoryInsightsScope({
    config: {
      insights: {
        repositories: [{
          repositoryId: "repo-registration-id",
          rootDirectory: "/work/threadshare",
        }],
      },
    },
    privacyContext,
    rootRealpath: "/work/threadshare",
    providers: ["codex"],
    publicRepositoryIdentity: "team-harness/threadshare",
  });
  assert.deepEqual(scope.projectKeys, [PROJECT_KEY]);
  assert.equal(scope.repositoryKey, REPOSITORY_KEY);
});

test("automatic selection restores complete Turns and injects commit/path Delivery Trace evidence", async () => {
  const request = normalizeMemoryExtractionRequest(extractionRequest());
  const input = {
    reader: fakeReader("7"),
    request,
    scope: {
      projectKeys: [PROJECT_KEY],
      repositoryKey: REPOSITORY_KEY,
      publicRepositoryIdentity: "team-harness/threadshare",
    },
    evaluatedAt: "2026-08-21T00:00:00.000Z",
  };
  const selection = await collectMemoryInsightsSelection(input);
  assert.equal(selection.databaseUuid, DATABASE_UUID);
  assert.equal(selection.sessions.length, 1);
  assert.equal(selection.sessions[0].turns.length, 3);
  assert.equal(selection.sessions[0].turns[0].events[0].role, "user");
  assert.match(selection.sessions[0].turns[0].events[0].text, /release evidence/);
  assert.deepEqual(
    selection.sessions[0].deliveryEdges.map((edge) => edge.kind).sort(),
    ["commit", "path"],
  );
  assert.equal(selection.sessions[0].deliveryEdges[0].pointer.commitHash, COMMIT_HASH);
  assert.equal(selection.sessions[0].directDeliveryEdges, 1);
  assert.equal(selection.sessions[0].recoveredFailureChains, 1);
  assert.equal(selection.sessions[0].score, 60);

  const advanced = await collectMemoryInsightsSelection({ ...input, reader: fakeReader("8") });
  assert.equal(advanced.snapshotSeq, "8");
  assert.equal(advanced.requestDigest, selection.requestDigest);
  assert.equal(advanced.resultSetDigest, selection.resultSetDigest);
  assert.equal(advanced.sessions[0].sourceBindingDigest, selection.sessions[0].sourceBindingDigest);
});

test("automatic selection refuses a partial Search result instead of taking the first page", async () => {
  await assert.rejects(
    collectMemoryInsightsSelection({
      reader: fakeReader("7", { totalMatchCount: "201" }),
      request: normalizeMemoryExtractionRequest(extractionRequest()),
      scope: {
        projectKeys: [PROJECT_KEY],
        repositoryKey: REPOSITORY_KEY,
        publicRepositoryIdentity: "team-harness/threadshare",
      },
      evaluatedAt: "2026-08-21T00:00:00.000Z",
    }),
    (error) => error?.code === "TS_QUERY_TOO_BROAD",
  );
});
