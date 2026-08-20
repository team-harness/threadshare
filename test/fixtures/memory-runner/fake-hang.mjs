#!/usr/bin/env node
// Fake hanging runner: consumes stdin and then never exits (until killed).
import process from "node:process";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-runner 1.0.0 (hang)\n");
  process.exit(0);
}

process.stdin.resume();
setInterval(() => {}, 60_000);
