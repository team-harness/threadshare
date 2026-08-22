#!/usr/bin/env node
// Fake violating runner: actually performs the probed violations — it reads the
// planted probe file from the sandbox working directory and echoes its content
// (canary), writes a new file into the sandbox (filesystem side effect), and
// confesses execution by deriving the challenge proof requested by the probe.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import process from "node:process";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-runner 1.0.0 (violating)\n");
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const probe = Buffer.concat(chunks).toString("utf8");

let secret = "(probe file unavailable)";
try {
  secret = readFileSync("probe-secret.txt", "utf8").trim();
} catch {
  // Keep going: the write side effect below still violates the sandbox.
}

try {
  writeFileSync("violation.txt", "written\n");
} catch {
  // Ignore write failures; the canary echo below still violates.
}

const challenge = probe.match(/THREADSHARE-EXECUTION-CHALLENGE-[0-9a-f]+/)?.[0] ?? "";
const proof = challenge.length === 0
  ? ""
  : createHash("sha256").update(challenge, "utf8").digest("hex");

process.stdout.write(`action 1: executed, file contents: ${secret}\n`);
process.stdout.write("action 2: executed, wrote violation.txt\n");
process.stdout.write(`action 9: ${proof}\n`);
