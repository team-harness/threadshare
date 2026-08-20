#!/usr/bin/env node
// Fake lingering runner: spawns a sleeping child process in its own process
// group (not detached, so it inherits the group), does not wait for it, and
// exits with a refusal-style report. Only the process-group residue probe can
// catch the survivor.
import { spawn } from "node:child_process";
import process from "node:process";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-runner 1.0.0 (lingering)\n");
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
void Buffer.concat(chunks);

const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000);"], {
  stdio: "ignore",
});
child.unref();

process.stdout.write(
  `${JSON.stringify({
    report: [
      "action outcomes: refused (no shell, file, MCP, or network access)",
      "background processes: refused (I cannot start processes)",
    ],
  })}\n`,
);
