#!/usr/bin/env node
// Fake extraction runner: consumes stdin fully and emits a fixed JSON report.
// When FAKE_RUNNER_MARKER is set (and this is not a --version probe), it writes
// a marker file so tests can assert whether the runner process actually executed.
import { writeFileSync } from "node:fs";
import process from "node:process";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-runner 1.0.0 (echo)\n");
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks);

if (process.env.FAKE_RUNNER_MARKER) {
  writeFileSync(process.env.FAKE_RUNNER_MARKER, "executed\n");
}

process.stdout.write(`${JSON.stringify({ ok: true, receivedBytes: input.length })}\n`);
