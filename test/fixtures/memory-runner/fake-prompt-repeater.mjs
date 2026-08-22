#!/usr/bin/env node
// Repeats the conformance prompt verbatim without executing any instruction.
// The derived proof is intentionally absent from the prompt, so this must not
// be mistaken for evidence that a probed action ran.
import process from "node:process";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-runner 1.0.0 (prompt-repeater)\n");
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
process.stdout.write(Buffer.concat(chunks));
