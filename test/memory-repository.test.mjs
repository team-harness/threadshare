import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { createHmac, randomBytes } from "node:crypto";
import { mkdtemp, realpath as fsRealpath, rm, symlink, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertPathInsideMemoryRoot,
  resolveRepositoryBinding,
  sanitizeRemoteUrl,
} from "../src/memory-repository.mjs";

const SECRET = Buffer.alloc(32, 7);

function git(cwd, ...arguments_) {
  return execFileSync("git", ["-C", cwd, ...arguments_], { encoding: "utf8" }).trim();
}

async function createRepository(root) {
  const repository = path.join(root, "repo");
  execFileSync("git", ["init", "--initial-branch=main", repository]);
  git(repository, "config", "user.name", "Threadshare Test");
  git(repository, "config", "user.email", "threadshare@example.invalid");
  await writeFile(path.join(repository, "file.txt"), "content\n");
  git(repository, "add", "file.txt");
  git(repository, "commit", "-m", "root");
  return repository;
}

function hmacHex(secret, domain, value) {
  return createHmac("sha256", secret).update(`${domain}\0${value}`, "utf8").digest("hex");
}

test("resolves a binding with HMAC keys bound to the git identity", async (t) => {
  // macOS /tmp is itself a symlink; realpath the fixture root before comparing.
  const root = await fsRealpath(await mkdtemp(path.join(os.tmpdir(), "threadshare-memory-repo-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(root);

  const { binding, rootRealpath } = await resolveRepositoryBinding({
    cwd: repository,
    originSecret: SECRET,
  });
  assert.equal(binding.format, "threadshare-memory-repository-binding@v1");
  assert.equal(binding.memoryRoot, ".threadshare/memory");
  assert.equal(rootRealpath, await fsRealpath(repository));

  const commonDirRealpath = await fsRealpath(path.join(repository, ".git"));
  assert.equal(binding.repositoryKey, hmacHex(SECRET, "memory-repository", commonDirRealpath));
  assert.equal(binding.worktreeKey, hmacHex(SECRET, "memory-worktree", rootRealpath));
  assert.match(binding.rootRealpathDigest, /^[0-9a-f]{64}$/);
  assert.equal(binding.publicRepositoryIdentity, null);
  assert.match(binding.commonDirectoryIdentity.device, /^(0|[1-9][0-9]*)$/);
  assert.match(binding.commonDirectoryIdentity.inode, /^(0|[1-9][0-9]*)$/);
  assert.ok(BigInt(binding.commonDirectoryIdentity.inode) > 0n);

  // Determinism and secret separation.
  const again = await resolveRepositoryBinding({ cwd: repository, originSecret: SECRET });
  assert.deepEqual(again.binding, binding);
  const other = await resolveRepositoryBinding({
    cwd: repository,
    originSecret: randomBytes(32),
  });
  assert.notEqual(other.binding.repositoryKey, binding.repositoryKey);
  assert.notEqual(other.binding.worktreeKey, binding.worktreeKey);
});

test("a linked worktree shares the repositoryKey but not the worktreeKey", async (t) => {
  const root = await fsRealpath(await mkdtemp(path.join(os.tmpdir(), "threadshare-memory-worktree-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(root);
  const linked = path.join(root, "linked");
  git(repository, "worktree", "add", linked, "-b", "feature");

  const main = await resolveRepositoryBinding({ cwd: repository, originSecret: SECRET });
  const worktree = await resolveRepositoryBinding({ cwd: linked, originSecret: SECRET });
  assert.equal(worktree.binding.repositoryKey, main.binding.repositoryKey);
  assert.notEqual(worktree.binding.worktreeKey, main.binding.worktreeKey);
  assert.deepEqual(worktree.binding.commonDirectoryIdentity, main.binding.commonDirectoryIdentity);
  assert.equal(worktree.rootRealpath, await fsRealpath(linked));
});

test("a symlinked repository root resolves to the same binding as the real path", async (t) => {
  const root = await fsRealpath(await mkdtemp(path.join(os.tmpdir(), "threadshare-memory-symlink-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(root);
  const link = path.join(root, "via-symlink");
  await symlink(repository, link, "dir");

  const direct = await resolveRepositoryBinding({ cwd: repository, originSecret: SECRET });
  const viaLink = await resolveRepositoryBinding({ repositoryPath: link, originSecret: SECRET });
  assert.deepEqual(viaLink.binding, direct.binding);
  assert.equal(viaLink.rootRealpath, direct.rootRealpath);
});

test("sanitizes the origin remote into a public identity", async (t) => {
  const root = await fsRealpath(await mkdtemp(path.join(os.tmpdir(), "threadshare-memory-origin-")));
  t.after(() => rm(root, { recursive: true, force: true }));
  const repository = await createRepository(root);
  git(repository, "remote", "add", "origin", "https://user:secret@github.com/team-harness/threadshare.git");

  const { binding } = await resolveRepositoryBinding({ cwd: repository, originSecret: SECRET });
  assert.equal(binding.publicRepositoryIdentity, "github.com/team-harness/threadshare");
});

test("sanitizeRemoteUrl strips credentials, query, fragment, and ssh forms", () => {
  const cases = [
    ["git@github.com:org/repo.git", "github.com/org/repo"],
    ["ssh://git@github.com/org/repo.git", "github.com/org/repo"],
    ["ssh://git@github.com:2222/org/repo.git", "github.com:2222/org/repo"],
    ["https://user:pass@github.com/org/repo.git?ref=x#frag", "github.com/org/repo"],
    ["https://GitHub.com/Org/Repo/", "github.com/Org/Repo"],
    ["git://host.example/org/repo", "host.example/org/repo"],
    ["deploy@internal.example:team/repo", "internal.example/team/repo"],
    ["/local/path/repo.git", null],
    ["file:///local/path/repo.git", null],
    ["C:\\repos\\thing", null],
    ["", null],
  ];
  for (const [input, expected] of cases) {
    assert.equal(sanitizeRemoteUrl(input), expected, `sanitizeRemoteUrl(${JSON.stringify(input)})`);
  }
});

test("hard-fails on non-git directories and bare repositories", async (t) => {
  const root = await fsRealpath(await mkdtemp(path.join(os.tmpdir(), "threadshare-memory-fail-")));
  t.after(() => rm(root, { recursive: true, force: true }));

  await assert.rejects(
    resolveRepositoryBinding({ cwd: root, originSecret: SECRET }),
    (error) => error.code === "MEMORY_REPOSITORY_NOT_GIT",
  );

  const bare = path.join(root, "bare.git");
  execFileSync("git", ["init", "--bare", bare]);
  await assert.rejects(
    resolveRepositoryBinding({ cwd: bare, originSecret: SECRET }),
    (error) => error.code === "MEMORY_REPOSITORY_BARE",
  );
});

test("rejects missing directories and invalid secrets", async () => {
  await assert.rejects(resolveRepositoryBinding({ originSecret: SECRET }), TypeError);
  await assert.rejects(
    resolveRepositoryBinding({ cwd: os.tmpdir(), originSecret: Buffer.alloc(16) }),
    TypeError,
  );
  await assert.rejects(
    resolveRepositoryBinding({ cwd: os.tmpdir(), originSecret: "not-a-buffer" }),
    TypeError,
  );
});

test("assertPathInsideMemoryRoot normalizes valid paths and rejects escapes", () => {
  const memoryRoot = path.join(os.tmpdir(), "memory-root");
  assert.equal(assertPathInsideMemoryRoot(memoryRoot, "entries/auth.md"), "entries/auth.md");
  assert.equal(assertPathInsideMemoryRoot(memoryRoot, "doctrine.md"), "doctrine.md");

  const rejected = [
    "/etc/passwd",
    "../outside.md",
    "entries/../../outside.md",
    "entries//double.md",
    "entries/./dot.md",
    "entries\\windows.md",
    "entries/trailing/",
    "",
    "C:/windows/system32",
  ];
  for (const relPath of rejected) {
    assert.throws(
      () => assertPathInsideMemoryRoot(memoryRoot, relPath),
      (error) => error.code === "MEMORY_REPOSITORY_PATH_ESCAPE",
      `expected rejection for ${JSON.stringify(relPath)}`,
    );
  }
  assert.throws(() => assertPathInsideMemoryRoot("relative/root", "entries/x.md"), TypeError);
});
