#!/usr/bin/env node
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { exportSession } from "../src/session-export.mjs";

const DEFAULT_THREADSHARE_URL = "https://cloud-thread.team-harness.com";
const SESSION_PROVIDERS = new Set(["codex", "claude", "paseo"]);
const historySchema = JSON.parse(
  readFileSync(new URL("../schema/threadshare-history.v1.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateCanonicalHistory = ajv.compile(historySchema);

function usage() {
  return `Usage:
  threadshare export <codex|claude|paseo> <session-id|file|agent-id> [--output <file|->]
  threadshare publish <history.json|-> [--url <service-url>] [--json]
  threadshare share <codex|claude|paseo> <session-id|file|agent-id> [--url <service-url>] [--json]
  threadshare validate <history.json|->

Default service: ${DEFAULT_THREADSHARE_URL}`;
}

function parseArgs(args) {
  const positionals = [];
  const options = {};
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    if (key === "json" || key === "help") {
      options[key] = true;
      continue;
    }
    const next = args[++index];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = next;
  }
  return { positionals, options };
}

function serviceUrl(value) {
  const url = new URL(value ?? process.env.THREADSHARE_URL ?? DEFAULT_THREADSHARE_URL);
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw new Error("Threadshare service URL must use HTTP or HTTPS");
  }
  return url.toString().replace(/\/$/, "");
}

async function readInput(file) {
  if (file !== "-") return readFile(file, "utf8");
  process.stdin.setEncoding("utf8");
  const chunks = [];
  for await (const chunk of process.stdin) chunks.push(chunk);
  return chunks.join("");
}

async function writeOutput(file, value) {
  if (!file || file === "-") {
    process.stdout.write(value);
    return;
  }
  await writeFile(file, value);
}

function validateHistory(history) {
  if (!validateCanonicalHistory(history)) {
    const issue = validateCanonicalHistory.errors?.[0];
    const detail = issue ? `: ${issue.instancePath || "/"} ${issue.message}` : "";
    throw new Error(`Input is not a valid threadshare-history@v1 document${detail}`);
  }
  return history;
}

async function publish(history, url) {
  const response = await fetch(`${serviceUrl(url)}/api/v1/shares`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(history),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.id) {
    throw new Error(payload?.error || `Threadshare upload failed with HTTP ${response.status}`);
  }
  return { id: payload.id, url: `${serviceUrl(url)}/?id=${encodeURIComponent(payload.id)}` };
}

async function exportProviderSession(provider, session) {
  if (provider === "paseo") {
    const { exportPaseoSession } = await import("../src/paseo-session-bridge.mjs");
    return exportPaseoSession(session);
  }
  return exportSession(provider, session);
}

async function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [command, provider, session] = positionals;
  if (!command || command === "help" || options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === "validate") {
    if (!provider) throw new Error(usage());
    validateHistory(JSON.parse(await readInput(provider)));
    process.stdout.write("Valid threadshare-history@v1\n");
    return;
  }
  if (command === "export") {
    if (!SESSION_PROVIDERS.has(provider) || !session) throw new Error(usage());
    const history = validateHistory(await exportProviderSession(provider, session));
    await writeOutput(options.output, `${JSON.stringify(history, null, 2)}\n`);
    return;
  }
  if (command === "publish") {
    if (!provider) throw new Error(usage());
    const result = await publish(validateHistory(JSON.parse(await readInput(provider))), options.url);
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.url}\n`);
    return;
  }
  if (command === "share") {
    if (!SESSION_PROVIDERS.has(provider) || !session) throw new Error(usage());
    const result = await publish(
      validateHistory(await exportProviderSession(provider, session)),
      options.url,
    );
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.url}\n`);
    return;
  }
  throw new Error(usage());
}

main().catch((error) => {
  process.stderr.write(`threadshare: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
