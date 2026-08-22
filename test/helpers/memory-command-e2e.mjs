import { execFile } from "node:child_process";
import { chmod, copyFile, mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";

import { executeInsightsCommand, parseInsightsInvocation } from "../../src/insights-command.mjs";
import { resolveInsightsPaths } from "../../src/insights-paths.mjs";
import { INSIGHTS_E2E_ENGINE } from "./insights-e2e.mjs";

const execFileAsync = promisify(execFile);
const fakeRunnerSource = fileURLToPath(
  new URL("../fixtures/memory-runner/fake-extraction-runner.mjs", import.meta.url),
);

export const MEMORY_FAKE_PROVIDER_SESSION_ID = "73737373-7373-4373-8373-737373737373";

function timestamp(index) {
  return new Date(Date.parse("2026-08-10T09:00:00.000Z") + index * 1_000).toISOString();
}

function codexSessionRecords(sessionId, repository, commitHash, sourceTurns) {
  const turns = structuredClone(sourceTurns).map((turn, index) => {
    const events = turn.events.filter((event) =>
      event.role === "user" || event.role === "assistant");
    if (!events.some((event) => event.role === "user")) {
      events.unshift({ role: "user", text: `Retrospective input ${index}` });
    }
    if (!events.some((event) => event.role === "assistant")) {
      events.push({ role: "assistant", text: "Recorded for retrospective analysis." });
    }
    return { ...turn, events };
  });
  while (turns.length < 3) {
    const index = turns.length;
    turns.push({
      turnIndex: index,
      events: [
        { role: "user", text: `Retrospective follow-up ${index}` },
        { role: "assistant", text: "The release evidence remains applicable." },
      ],
    });
  }
  const records = [{
    type: "session_meta",
    timestamp: timestamp(0),
    payload: { id: sessionId, cwd: repository },
  }];
  let observed = 1;
  for (const [index, turn] of turns.entries()) {
    const turnId = `memory-turn-${index + 1}`;
    records.push({
      type: "event_msg",
      timestamp: timestamp(observed++),
      payload: { type: "task_started", turn_id: turnId },
    });
    for (const event of turn.events) {
      if (event.role !== "user" && event.role !== "assistant") continue;
      records.push({
        type: "response_item",
        timestamp: timestamp(observed++),
        payload: {
          type: "message",
          role: event.role,
          content: [{
            type: event.role === "user" ? "input_text" : "output_text",
            text: event.text,
          }],
        },
      });
      if (index === 0 && event.role === "user") {
        records.push({
          type: "response_item",
          timestamp: timestamp(observed++),
          payload: {
            type: "function_call",
            call_id: "memory-git-commit",
            name: "exec_command",
            arguments: JSON.stringify({ cmd: "git commit -m test && git rev-parse HEAD" }),
          },
        }, {
          type: "response_item",
          timestamp: timestamp(observed++),
          payload: {
            type: "function_call_output",
            call_id: "memory-git-commit",
            output: `${commitHash}\n`,
            status: "completed",
          },
        });
      }
    }
    records.push({
      type: "event_msg",
      timestamp: timestamp(observed++),
      payload: { type: "task_complete", turn_id: turnId },
    });
  }
  return records;
}

export async function createMemoryCommandFixture(t, options = {}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-memory-command-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const repository = path.join(directory, "repository");
  const stateDirectory = path.join(directory, "state");
  const runnerBinaryPath = path.join(directory, "fake-extraction-runner");
  await mkdir(repository);
  const repositoryRealpath = await realpath(repository);
  await execFileAsync("git", ["init", "--quiet", repository]);
  await writeFile(path.join(repository, "README.md"), "# Memory command fixture\n");
  await execFileAsync("git", ["-C", repository, "add", "README.md"]);
  await execFileAsync("git", [
    "-C", repository,
    "-c", "user.name=Threadshare Test",
    "-c", "user.email=threadshare@example.invalid",
    "commit", "--quiet", "-m", "initial fixture",
  ], {
    env: {
      ...process.env,
      GIT_AUTHOR_DATE: "2026-08-10T09:00:03Z",
      GIT_COMMITTER_DATE: "2026-08-10T09:00:03Z",
    },
  });
  const { stdout: commitOutput } = await execFileAsync("git", ["-C", repository, "rev-parse", "HEAD"]);
  const commitHash = commitOutput.trim();
  await copyFile(fakeRunnerSource, runnerBinaryPath);
  await chmod(runnerBinaryPath, 0o755);
  const turns = options.turns ?? [{
    turnIndex: 0,
    events: [
      { role: "user", text: "How should release tests be run?" },
      { role: "assistant", text: "Run npm run test:release before publishing." },
    ],
  }];
  const paths = resolveInsightsPaths({
    currentDirectory: repository,
    environment: {
      ...process.env,
      THREADSHARE_INSIGHTS_HOME: stateDirectory,
      THREADSHARE_CONFIG: path.join(directory, "config.json"),
    },
  });
  const codexHome = path.join(directory, "codex-home");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "10");
  await mkdir(sessionDirectory, { recursive: true });
  const sessionId = options.sessionId ?? MEMORY_FAKE_PROVIDER_SESSION_ID;
  const sessionFile = path.join(sessionDirectory, `rollout-2026-08-10T09-00-00-${sessionId}.jsonl`);
  const records = codexSessionRecords(sessionId, repositoryRealpath, commitHash, turns);
  await writeFile(sessionFile, `${records.map((record) => JSON.stringify(record)).join("\n")}\n`, {
    mode: 0o600,
  });
  const requestFile = path.join(repository, "memory-request.json");
  await writeFile(requestFile, `${JSON.stringify({
    format: "threadshare-memory-extraction-request@v1",
    window: {
      after: "2026-08-10T08:00:00.000Z",
      before: "2026-08-10T10:00:00.000Z",
    },
    filters: { providers: ["codex"] },
  })}\n`);
  const commandOptions = {
    cwd: repository,
    paths,
    discoveryOptions: {
      environment: { ...process.env, HOME: directory, CODEX_HOME: codexHome },
    },
    runnerBinaryPath,
    runtimeOptions: {
      env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: INSIGHTS_E2E_ENGINE },
    },
    reindexOptions: { availableBytes: 1024n * 1024n * 1024n },
    timeoutMs: 30_000,
    now: () => Date.parse("2026-08-21T00:00:00.000Z"),
    ...(typeof options.onProgress === "function" ? { onProgress: options.onProgress } : {}),
  };
  await executeInsightsCommand(
    parseInsightsInvocation(["insights", "sync"], { format: "json", repository }),
    commandOptions,
  );
  return {
    directory,
    repository,
    requestFile,
    sessionFile,
    commitHash,
    options: commandOptions,
  };
}
