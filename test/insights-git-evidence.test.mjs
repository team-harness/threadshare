import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { readGitDiffEvidence } from "../src/insights-git-evidence.mjs";

function git(cwd, ...arguments_) {
  return execFileSync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

function gitBuffer(cwd, ...arguments_) {
  return execFileSync("git", ["-C", cwd, ...arguments_], {
    encoding: "buffer",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  });
}

function requestFor(commitObjectId, parentObjectId, overrides = {}) {
  return {
    format: "threadshare-insights-git-diff-evidence-request@v1",
    repositoryKey: "1".repeat(64),
    commitObjectId,
    parentObjectId,
    path: null,
    revision: "2".repeat(64),
    contextLines: 3,
    maxBytes: 64,
    cursor: null,
    ...overrides,
  };
}

async function repositoryFixture(t) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-git-evidence-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repository");
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  git(repository, "config", "user.name", "Threadshare Test");
  git(repository, "config", "user.email", "threadshare@example.invalid");
  await writeFile(path.join(repository, "old.txt"), "alpha\nbeta\n");
  git(repository, "add", "old.txt");
  git(repository, "commit", "-m", "root");
  const root = git(repository, "rev-parse", "HEAD");
  git(repository, "mv", "old.txt", "renamed.txt");
  await writeFile(path.join(repository, "renamed.txt"), "alpha\nbeta\ngamma\n");
  git(repository, "add", "renamed.txt");
  git(repository, "commit", "-m", "rename");
  const commit = git(repository, "rev-parse", "HEAD");
  return { repository, root, commit };
}

test("Git diff evidence pages concatenate to the fixed Git object oracle", async (t) => {
  const { repository, root, commit } = await repositoryFixture(t);
  const request = requestFor(commit, root);
  const oracle = gitBuffer(
    repository,
    "diff-tree", "--no-commit-id", "-r", "-p", "--no-color", "--no-ext-diff",
    "--no-textconv", "--full-index", "--find-renames=50%", "--diff-algorithm=histogram",
    "--unified=3", root, commit,
  );
  const pages = [];
  let offset = 0;
  let cursor = null;
  let expectedPayloadSha256;
  let expectedTotalBytes;
  do {
    const response = await readGitDiffEvidence({ ...request, cursor }, {
      rootDirectory: repository,
      offset,
      expectedPayloadSha256,
      expectedTotalBytes,
      createCursor(value) { return `offset:${value.offset}`; },
    });
    pages.push(Buffer.from(response.content, "utf8"));
    expectedPayloadSha256 = response.payloadSha256;
    expectedTotalBytes = response.totalBytes;
    cursor = response.nextCursor;
    offset = Number(response.range.end);
  } while (cursor !== null);

  const actual = Buffer.concat(pages);
  assert.deepEqual(actual, oracle);
  assert.equal(expectedPayloadSha256, createHash("sha256").update(oracle).digest("hex"));
  assert.equal(expectedTotalBytes, String(oracle.length));
});

test("Git diff evidence supports a root commit and path-scoped rename evidence", async (t) => {
  const { repository, root, commit } = await repositoryFixture(t);
  const rootResponse = await readGitDiffEvidence(requestFor(root, null, { maxBytes: 1_048_576 }), {
    rootDirectory: repository,
  });
  assert.equal(rootResponse.complete, true);
  assert.match(rootResponse.content, /new file mode/u);

  const renameResponse = await readGitDiffEvidence(requestFor(commit, root, {
    path: "renamed.txt",
    maxBytes: 1_048_576,
  }), { rootDirectory: repository, oldPath: "old.txt" });
  assert.equal(renameResponse.complete, true);
  assert.match(renameResponse.content, /rename (?:from old\.txt|to renamed\.txt)/u);
});

test("Git diff evidence emits metadata rather than binary blob bytes", async (t) => {
  const { repository, commit: parent } = await repositoryFixture(t);
  await writeFile(path.join(repository, "payload.bin"), Buffer.from([0, 1, 2, 3, 255]));
  git(repository, "add", "payload.bin");
  git(repository, "commit", "-m", "binary");
  const commit = git(repository, "rev-parse", "HEAD");
  const response = await readGitDiffEvidence(requestFor(commit, parent, {
    path: "payload.bin",
    maxBytes: 1_048_576,
  }), { rootDirectory: repository });
  assert.equal(response.binary, true);
  assert.match(response.content, /Binary files/u);
  assert.equal(response.content.includes("\0"), false);
});

test("Git diff evidence requires an explicit merge parent and preserves parent semantics", async (t) => {
  const { repository, root } = await repositoryFixture(t);
  git(repository, "checkout", "-b", "topic", root);
  await writeFile(path.join(repository, "topic.txt"), "topic\n");
  git(repository, "add", "topic.txt");
  git(repository, "commit", "-m", "topic");
  git(repository, "checkout", "main");
  await writeFile(path.join(repository, "main.txt"), "main\n");
  git(repository, "add", "main.txt");
  git(repository, "commit", "-m", "main");
  git(repository, "merge", "--no-ff", "topic", "-m", "merge");
  const [commit, firstParent, secondParent] = git(
    repository, "rev-list", "--parents", "-n", "1", "HEAD",
  ).split(" ");
  const first = await readGitDiffEvidence(requestFor(commit, firstParent, {
    maxBytes: 1_048_576,
  }), { rootDirectory: repository });
  const second = await readGitDiffEvidence(requestFor(commit, secondParent, {
    maxBytes: 1_048_576,
  }), { rootDirectory: repository });
  assert.notEqual(first.content, second.content);
  assert.match(first.content, /topic\.txt/u);
  assert.match(second.content, /main\.txt/u);
});

test("Git diff evidence fails closed for missing objects and bounded output", async (t) => {
  const { repository, root, commit } = await repositoryFixture(t);
  await assert.rejects(
    readGitDiffEvidence(requestFor("f".repeat(40), root), { rootDirectory: repository }),
    (error) => error.code === "TS_INSIGHTS_GIT_OBJECT_UNAVAILABLE",
  );
  await assert.rejects(
    readGitDiffEvidence(requestFor(commit, root), {
      rootDirectory: repository,
      maxTotalBytes: 16,
    }),
    (error) => error.code === "TS_INSIGHTS_GIT_DIFF_TOO_LARGE",
  );
});
