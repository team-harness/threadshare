import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INSIGHTS_WRITER_LOCK_FORMAT,
  acquireInsightsWriterLock,
  withInsightsWriterLock,
} from "../src/insights-writer-lock.mjs";

async function fixture() {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-writer-lock-"));
  const stateDirectory = path.join(directory, "state");
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  return {
    directory,
    paths: { stateDirectory, lockFile: path.join(stateDirectory, "insights.lock") },
  };
}

test("rejects a second live writer with a stable diagnostic", async () => {
  const state = await fixture();
  try {
    const lock = await acquireInsightsWriterLock(state.paths, {
      processIsRunning: () => true,
    });
    await assert.rejects(
      acquireInsightsWriterLock(state.paths, { processIsRunning: () => true }),
      (error) => error?.code === "TS_INSIGHTS_WRITER_LOCKED",
    );
    assert.equal(JSON.parse(await readFile(state.paths.lockFile, "utf8")).format, INSIGHTS_WRITER_LOCK_FORMAT);
    await lock.release();
    await lock.release();
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("recovers a dead owner only when the observed lock is unchanged", async () => {
  const state = await fixture();
  try {
    await writeFile(
      state.paths.lockFile,
      `${JSON.stringify({
        format: INSIGHTS_WRITER_LOCK_FORMAT,
        pid: 424242,
        token: "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa",
      })}\n`,
      { mode: 0o600 },
    );
    const lock = await acquireInsightsWriterLock(state.paths, {
      processIsRunning: (pid) => pid !== 424242,
    });
    assert.notEqual(lock.owner.pid, 424242);
    await lock.release();
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("recovers a dead recovery guard before reclaiming the writer lock", async () => {
  const state = await fixture();
  try {
    const owner = (pid, token) => `${JSON.stringify({
      format: INSIGHTS_WRITER_LOCK_FORMAT,
      pid,
      token,
    })}\n`;
    await Promise.all([
      writeFile(
        state.paths.lockFile,
        owner(424242, "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa"),
        { mode: 0o600 },
      ),
      writeFile(
        `${state.paths.lockFile}.recovery`,
        owner(434343, "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"),
        { mode: 0o600 },
      ),
    ]);
    const lock = await acquireInsightsWriterLock(state.paths, {
      processIsRunning: (pid) => pid !== 424242 && pid !== 434343,
    });
    assert.notEqual(lock.owner.pid, 424242);
    await lock.release();
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("releases the writer lock after success and failure", async () => {
  const state = await fixture();
  try {
    assert.equal(
      await withInsightsWriterLock(state.paths, async () => "committed"),
      "committed",
    );
    await assert.rejects(
      withInsightsWriterLock(state.paths, async () => {
        throw new Error("injected failure");
      }),
      /injected failure/u,
    );
    const final = await acquireInsightsWriterLock(state.paths);
    await final.release();
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});

test("does not delete malformed or replaced lock state", async () => {
  const state = await fixture();
  try {
    await writeFile(state.paths.lockFile, "not-json\n", { mode: 0o600 });
    await assert.rejects(
      acquireInsightsWriterLock(state.paths),
      (error) => error?.code === "TS_INSIGHTS_WRITER_LOCK_INVALID",
    );
    assert.equal(await readFile(state.paths.lockFile, "utf8"), "not-json\n");
  } finally {
    await rm(state.directory, { recursive: true, force: true });
  }
});
