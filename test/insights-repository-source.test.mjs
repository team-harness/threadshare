import assert from "node:assert/strict";
import { execFile, execFileSync } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { promisify } from "node:util";
import { createPrivacyContext } from "../src/session-facts.mjs";

import {
  registerInsightsRepository,
  registerRequestedInsightsRepository,
  resolveGitRepository,
  sanitizeScmRemote,
  scanGitRepository,
  createTraceSourceDelta,
} from "../src/insights-repository-source.mjs";

const execFileAsync = promisify(execFile);

function git(cwd, ...arguments_) {
  return execFileSync("git", ["-C", cwd, ...arguments_], {
    encoding: "utf8",
    env: { ...process.env, GIT_CONFIG_NOSYSTEM: "1" },
  }).trim();
}

test("linked Git worktrees resolve to one repository identity", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-repository-source-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repository");
  const worktree = path.join(directory, "worktree");
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  git(repository, "config", "user.name", "Threadshare Test");
  git(repository, "config", "user.email", "threadshare@example.invalid");
  await writeFile(path.join(repository, "README.md"), "delivery trace\n");
  git(repository, "add", "README.md");
  git(repository, "commit", "-m", "initial");
  git(repository, "worktree", "add", "-b", "linked", worktree);

  const primary = await resolveGitRepository(repository);
  const linked = await resolveGitRepository(worktree);
  assert.notEqual(primary.rootDirectory, linked.rootDirectory);
  assert.equal(primary.commonDirectory, linked.commonDirectory);
  assert.equal(primary.commonDirectoryDevice, linked.commonDirectoryDevice);
  assert.equal(primary.commonDirectoryInode, linked.commonDirectoryInode);
});

test("repository registration separates Git discovery from config persistence", async () => {
  const calls = [];
  const result = await registerInsightsRepository("./repo", {
    intentPath: "docs/intent.md",
    async resolveRepository(value) {
      calls.push(`resolve:${value}`);
      return {
        commonDirectory: "/work/repo/.git",
        rootDirectory: "/work/repo",
        commonDirectoryDevice: "7",
        commonDirectoryInode: "9",
      };
    },
    async updateRegistration(registration) {
      calls.push(`persist:${registration.commonDirectoryInode}:${registration.intentPath}`);
      return { changed: true, repository: { repositoryId: "opaque-id", ...registration } };
    },
  });
  assert.equal(result.repository.repositoryId, "opaque-id");
  assert.deepEqual(calls, ["resolve:./repo", "persist:9:docs/intent.md"]);
});

test("sync without an explicit repository performs zero Git discovery", async () => {
  let resolutions = 0;
  const result = await registerRequestedInsightsRepository(null, {
    async resolveRepository() {
      resolutions += 1;
      throw new Error("must not run");
    },
  });
  assert.equal(result, null);
  assert.equal(resolutions, 0);
});

test("non-repositories fail with a content-free stable error", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-not-repository-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await assert.rejects(
    resolveGitRepository(directory),
    (error) => {
      assert.equal(error?.code, "TS_INSIGHTS_REPOSITORY_INVALID");
      assert.equal(String(error.message).includes(directory), false);
      return true;
    },
  );
});

test("sanitizes supported SCM remotes without retaining credentials or local URLs", () => {
  assert.deepEqual(
    sanitizeScmRemote("https://token@example@github.com/team-harness/threadshare.git?token=x#fragment"),
    {
      repositoryPath: "team-harness/threadshare",
      scmProvider: "github",
      webBaseUrl: "https://github.com",
    },
  );
  assert.deepEqual(sanitizeScmRemote("git@gitlab.com:group/project.git"), {
    repositoryPath: "group/project",
    scmProvider: "gitlab",
    webBaseUrl: "https://gitlab.com",
  });
  assert.equal(sanitizeScmRemote("file:///work/private"), null);
  assert.equal(sanitizeScmRemote("../private"), null);
});

test("scans Git refs incrementally and skips an unchanged ref snapshot", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-repository-scan-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repository");
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  git(repository, "config", "user.name", "Threadshare Test");
  git(repository, "config", "user.email", "threadshare@example.invalid");
  git(repository, "remote", "add", "origin", "git@github.com:team-harness/threadshare.git");
  await writeFile(path.join(repository, "one.txt"), "one\n");
  git(repository, "add", "one.txt");
  git(repository, "commit", "-m", "first");
  const registration = {
    ...(await resolveGitRepository(repository)),
    repositoryId: "11111111-1111-4111-8111-111111111111",
  };

  const initial = await scanGitRepository(registration, {
    coverageAfter: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(initial.mode, "initial");
  assert.equal(initial.commits.length, 1);
  assert.deepEqual(initial.scm, {
    repositoryPath: "team-harness/threadshare",
    scmProvider: "github",
    webBaseUrl: "https://github.com",
  });
  assert.deepEqual(initial.commits[0].files.map(({ path: file }) => file), ["one.txt"]);
  assert.equal(initial.commits[0].files[0].additions, "1");

  const unchanged = await scanGitRepository(registration, {
    priorState: { refDigest: initial.refDigest, refs: initial.refs },
    coverageAfter: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(unchanged.mode, "unchanged");
  assert.deepEqual(unchanged.commits, []);

  await writeFile(path.join(repository, "two.txt"), "two\n");
  git(repository, "add", "two.txt");
  git(repository, "commit", "-m", "second");
  const incremental = await scanGitRepository(registration, {
    priorState: { refDigest: initial.refDigest, refs: initial.refs },
    coverageAfter: "2000-01-01T00:00:00.000Z",
  });
  assert.equal(incremental.mode, "incremental");
  assert.equal(incremental.commits.length, 1);
  assert.equal(incremental.commits[0].summary, "second");
  assert.deepEqual(incremental.commits[0].files.map(({ path: file }) => file), ["two.txt"]);

  const delta = createTraceSourceDelta(registration, incremental, {
    expectedGeneration: "1",
    privacyContext: createPrivacyContext({
      secret: Buffer.alloc(32, 7),
      originSecretEpoch: "11111111-1111-4111-8111-111111111111",
    }),
  });
  assert.equal(delta.format, "threadshare-insights-trace-source-delta@v1");
  assert.equal(delta.expectedGeneration, "1");
  assert.equal(delta.targetGeneration, "2");
  assert.match(delta.deltaId, /^[0-9a-f]{64}$/u);
  assert.match(delta.repository.repositoryKey, /^[0-9a-f]{64}$/u);
  assert.equal(delta.intent, null);
  assert.deepEqual(delta.intentNodes, []);
  assert.deepEqual(delta.intentRefs, []);
  assert.equal(JSON.stringify(delta).includes(directory), false);

  git(repository, "reset", "--hard", "HEAD~1");
  const rewritten = await scanGitRepository(registration, {
    priorState: { refDigest: incremental.refDigest, refs: incremental.refs },
  });
  assert.equal(rewritten.mode, "incremental");
  assert.deepEqual(rewritten.commits, []);
  assert.equal(rewritten.refs.length, 1);
  assert.equal(rewritten.refs[0].objectId, initial.refs[0].objectId);

  git(repository, "branch", "topic", incremental.commits[0].objectId);
  const addedRef = await scanGitRepository(registration, {
    priorState: { refDigest: rewritten.refDigest, refs: rewritten.refs },
  });
  assert.deepEqual(addedRef.commits.map(({ objectId }) => objectId), [
    incremental.commits[0].objectId,
  ]);
  git(repository, "branch", "-D", "topic");
  const deletedRef = await scanGitRepository(registration, {
    priorState: { refDigest: addedRef.refDigest, refs: addedRef.refs },
  });
  assert.deepEqual(deletedRef.commits, []);
  assert.deepEqual(deletedRef.refs, rewritten.refs);
});

test("fails a repository batch when refs move during the scan", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-repository-drift-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repository");
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  git(repository, "config", "user.name", "Threadshare Test");
  git(repository, "config", "user.email", "threadshare@example.invalid");
  await writeFile(path.join(repository, "one.txt"), "one\n");
  git(repository, "add", "one.txt");
  git(repository, "commit", "-m", "first");
  const registration = {
    ...(await resolveGitRepository(repository)),
    repositoryId: "11111111-1111-4111-8111-111111111111",
  };
  let moved = false;

  await assert.rejects(
    scanGitRepository(registration, {
      coverageAfter: "2000-01-01T00:00:00.000Z",
      async execFile(command, arguments_, options) {
        const result = await execFileAsync(command, arguments_, options);
        if (!moved && arguments_.includes("show")) {
          moved = true;
          await writeFile(path.join(repository, "two.txt"), "two\n");
          git(repository, "add", "two.txt");
          git(repository, "commit", "-m", "second");
        }
        return result;
      },
    }),
    (error) => {
      assert.equal(error?.code, "TS_INSIGHTS_REPOSITORY_CHANGED");
      assert.equal(String(error.message).includes(repository), false);
      return true;
    },
  );
});

test("reads commit metadata and file changes in bounded 128-commit batches", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-repository-batch-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repository");
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  git(repository, "config", "user.name", "Threadshare Test");
  git(repository, "config", "user.email", "threadshare@example.invalid");
  for (let index = 0; index < 129; index += 1) {
    await writeFile(path.join(repository, "counter.txt"), `${index}\n`);
    git(repository, "add", "counter.txt");
    git(repository, "commit", "-m", `commit ${index}`);
  }
  const registration = {
    ...(await resolveGitRepository(repository)),
    repositoryId: "11111111-1111-4111-8111-111111111111",
  };
  let showCalls = 0;
  const result = await scanGitRepository(registration, {
    coverageAfter: "2000-01-01T00:00:00.000Z",
    async execFile(command, arguments_, options) {
      if (arguments_.includes("show")) showCalls += 1;
      return execFileAsync(command, arguments_, options);
    },
  });
  assert.equal(result.commits.length, 129);
  assert.equal(showCalls, 4);
});

test("preserves rename and binary file-change semantics in batched scans", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-repository-files-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repository");
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  git(repository, "config", "user.name", "Threadshare Test");
  git(repository, "config", "user.email", "threadshare@example.invalid");
  await writeFile(path.join(repository, "old.txt"), "rename me\n");
  git(repository, "add", "old.txt");
  git(repository, "commit", "-m", "first");
  git(repository, "mv", "old.txt", "renamed.txt");
  await writeFile(path.join(repository, "binary.dat"), Buffer.from([0, 1, 2, 3]));
  git(repository, "add", "binary.dat");
  git(repository, "commit", "-m", "rename and binary");
  const result = await scanGitRepository({
    ...(await resolveGitRepository(repository)),
    repositoryId: "11111111-1111-4111-8111-111111111111",
  }, { coverageAfter: "2000-01-01T00:00:00.000Z" });
  const commit = result.commits.find(({ summary }) => summary === "rename and binary");
  assert.deepEqual(commit.files.find(({ path: file }) => file === "renamed.txt"), {
    path: "renamed.txt",
    oldPath: "old.txt",
    status: "R",
    additions: "0",
    deletions: "0",
  });
  assert.deepEqual(commit.files.find(({ path: file }) => file === "binary.dat"), {
    path: "binary.dat",
    oldPath: null,
    status: "A",
    additions: null,
    deletions: null,
  });
});
