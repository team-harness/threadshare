#!/usr/bin/env node
// Fake flooding runner: writes unbounded stdout until killed.
import process from "node:process";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-runner 1.0.0 (flood)\n");
  process.exit(0);
}

process.stdin.resume();
const chunk = Buffer.alloc(65_536, 0x41);
function pump() {
  while (process.stdout.write(chunk)) {
    // Keep writing until backpressure engages.
  }
  process.stdout.once("drain", pump);
}
pump();
