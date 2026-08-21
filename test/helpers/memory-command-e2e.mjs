import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { resolveInsightsPaths } from "../../src/insights-paths.mjs";
import { INSIGHTS_E2E_ENGINE } from "./insights-e2e.mjs";

const execFileAsync = promisify(execFile);
const fakeRunnerSource = fileURLToPath(
  new URL("../fixtures/memory-runner/fake-extraction-runner.mjs", import.meta.url),
);

export const MEMORY_FAKE_PROVIDER_SESSION_ID = "provider-session-id-must-stay-local";

export async function createMemoryCommandFixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-memory-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repository");
  const stateDirectory = path.join(directory, "state");
  const runnerBinaryPath = path.join(directory, "fake-extraction-runner");
  await mkdir(repository);
  await execFileAsync("git", ["init", "--quiet", repository]);
  await writeFile(path.join(repository, "README.md"), "# Memory command fixture\n");
  await execFileAsync("git", ["-C", repository, "add", "README.md"]);
  await execFileAsync("git", [
    "-C", repository,
    "-c", "user.name=Threadshare Test",
    "-c", "user.email=threadshare@example.invalid",
    "commit", "--quiet", "-m", "initial fixture",
  ]);
  await copyFile(fakeRunnerSource, runnerBinaryPath);
  await chmod(runnerBinaryPath, 0o755);
  const turns = options.turns ?? [{
    turnIndex: 0,
    events: [
      { role: "user", text: "How should release tests be run?" },
      { role: "assistant", text: "Run npm run test:release before publishing." },
    ],
  }];
  await writeFile(path.join(repository, "session.json"), `${JSON.stringify({
    sessionId: options.sessionId ?? MEMORY_FAKE_PROVIDER_SESSION_ID,
    project: "team-harness/threadshare",
    turns,
  })}\n`);
  const paths = resolveInsightsPaths({
    currentDirectory: repository,
    environment: { ...process.env, THREADSHARE_INSIGHTS_HOME: stateDirectory },
  });
  return {
    directory,
    repository,
    options: {
      cwd: repository,
      paths,
      runnerBinaryPath,
      runtimeOptions: {
        env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: INSIGHTS_E2E_ENGINE },
      },
      timeoutMs: 30_000,
    },
  };
}
