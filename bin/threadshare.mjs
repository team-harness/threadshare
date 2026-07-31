#!/usr/bin/env node
import Ajv2020 from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { readFileSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import {
  DEFAULT_MESSAGE_PAGE_SIZE,
  MAX_MESSAGE_PAGE_SIZE,
  listStartMessagePage,
  listUserMessagePage,
  selectHistoryRange,
} from "../src/history-selection.mjs";
import { exportSession } from "../src/session-export.mjs";

const DEFAULT_THREADSHARE_URL = "https://cloud-thread.team-harness.com";
const SESSION_PROVIDERS = new Set(["codex", "claude", "paseo"]);
const BOOLEAN_OPTIONS = new Set(["help", "json", "pick-start"]);
const historySchema = JSON.parse(
  readFileSync(new URL("../schema/threadshare-history.v1.schema.json", import.meta.url), "utf8"),
);
const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats(ajv);
const validateCanonicalHistory = ajv.compile(historySchema);

function usage() {
  return `Usage:
  threadshare messages <codex|claude|paseo> <session-id|file|agent-id> --format json [--before <user-message-id>] [--offset <n>] [--limit <n>]
  threadshare export <codex|claude|paseo> <session-id|file|agent-id> [--from <user-message-id|last-user>] [--before <user-message-id>] [--output <file|->]
  threadshare publish <history.json|-> [--url <service-url>] [--json]
  threadshare share <codex|claude|paseo> <session-id|file|agent-id> [--from <user-message-id|last-user>] [--before <user-message-id>] [--pick-start] [--url <service-url>] [--json]
  threadshare validate <history.json|->

Range: omit --from and --before for the full visible snapshot; empty values are rejected.
Default service: ${DEFAULT_THREADSHARE_URL}`;
}

function parseArgs(args) {
  const positionals = [];
  const options = Object.create(null);
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    if (Object.hasOwn(options, key)) throw new Error(`Duplicate option --${key}`);
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const next = args[++index];
    if (!next || next.startsWith("--")) throw new Error(`Missing value for --${key}`);
    options[key] = next;
  }
  return { positionals, options };
}

function validateCommandShape(command, positionals, options, expected, allowed) {
  if (positionals.length > expected) {
    throw new Error(`Unexpected positional argument: ${positionals[expected]}`);
  }
  if (positionals.length < expected) throw new Error(usage());
  for (const option of Object.keys(options)) {
    if (option === "help") continue;
    if (!allowed.has(option)) throw new Error(`--${option} is not valid for ${command}`);
  }
}

function sessionCommand(command, positionals, options, allowed) {
  validateCommandShape(command, positionals, options, 3, allowed);
  const [, provider, session] = positionals;
  if (!SESSION_PROVIDERS.has(provider) || !session) throw new Error(usage());
  return { provider, session };
}

function parsePageInteger(name, value, fallback) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(
      name === "limit"
        ? `--limit must be an integer from 1 to ${MAX_MESSAGE_PAGE_SIZE}`
        : "--offset must be a non-negative integer",
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (name === "limit" && (parsed < 1 || parsed > MAX_MESSAGE_PAGE_SIZE))
  ) {
    throw new Error(
      name === "limit"
        ? `--limit must be an integer from 1 to ${MAX_MESSAGE_PAGE_SIZE}`
        : "--offset must be a non-negative integer",
    );
  }
  return parsed;
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

function rangedHistory(history, options) {
  return validateHistory(
    selectHistoryRange(history, { from: options.from, before: options.before }),
  );
}

function requireInteractiveTerminal() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw new Error(
      "--pick-start requires an interactive terminal; agents should use messages and --from/--before",
    );
  }
}

async function pickStartMessage(history) {
  requireInteractiveTerminal();
  const prompt = createInterface({ input: process.stdin, output: process.stderr, terminal: true });
  const loaded = [];
  let offset = 0;
  try {
    while (true) {
      const page = listStartMessagePage(history, {
        limit: DEFAULT_MESSAGE_PAGE_SIZE,
        offset,
      });
      const firstNumber = loaded.length + 1;
      loaded.push(...page.messages);
      for (let index = firstNumber - 1; index < loaded.length; index += 1) {
        const message = loaded[index];
        process.stderr.write(`${index + 1}. ${message.preview}\n`);
      }

      while (true) {
        const choices = page.hasMore
          ? `Choose 1-${loaded.length}, m for more, or q to cancel: `
          : `Choose 1-${loaded.length}, or q to cancel: `;
        const answer = (await prompt.question(choices)).trim().toLowerCase();
        if (answer === "q") throw new Error("Selection canceled");
        if (answer === "m" && page.hasMore) {
          offset = page.nextOffset;
          break;
        }
        if (/^\d+$/.test(answer)) {
          const selected = Number(answer);
          if (selected >= 1 && selected <= loaded.length) return loaded[selected - 1].id;
        }
        process.stderr.write("Invalid selection.\n");
      }
    }
  } finally {
    prompt.close();
  }
}

async function main() {
  const { positionals, options } = parseArgs(process.argv.slice(2));
  const [command] = positionals;
  if (!command || command === "help" || options.help) {
    process.stdout.write(`${usage()}\n`);
    return;
  }
  if (command === "validate") {
    validateCommandShape(command, positionals, options, 2, new Set());
    validateHistory(JSON.parse(await readInput(positionals[1])));
    process.stdout.write("Valid threadshare-history@v1\n");
    return;
  }
  if (command === "messages") {
    const { provider, session } = sessionCommand(
      command,
      positionals,
      options,
      new Set(["before", "format", "limit", "offset"]),
    );
    if (options.format !== "json") throw new Error("messages requires --format json");
    const history = validateHistory(await exportProviderSession(provider, session));
    const result = listUserMessagePage(history, {
      before: options.before,
      limit: parsePageInteger("limit", options.limit, DEFAULT_MESSAGE_PAGE_SIZE),
      offset: parsePageInteger("offset", options.offset, 0),
    });
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "export") {
    const { provider, session } = sessionCommand(
      command,
      positionals,
      options,
      new Set(["before", "from", "output"]),
    );
    const history = rangedHistory(
      validateHistory(await exportProviderSession(provider, session)),
      options,
    );
    await writeOutput(options.output, `${JSON.stringify(history, null, 2)}\n`);
    return;
  }
  if (command === "publish") {
    validateCommandShape(command, positionals, options, 2, new Set(["json", "url"]));
    const result = await publish(
      validateHistory(JSON.parse(await readInput(positionals[1]))),
      options.url,
    );
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.url}\n`);
    return;
  }
  if (command === "share") {
    const { provider, session } = sessionCommand(
      command,
      positionals,
      options,
      new Set(["before", "from", "json", "pick-start", "url"]),
    );
    if (options["pick-start"] && (options.from || options.before)) {
      throw new Error("--pick-start cannot be combined with --from or --before");
    }
    if (options["pick-start"]) requireInteractiveTerminal();
    const exported = validateHistory(await exportProviderSession(provider, session));
    const from = options["pick-start"] ? await pickStartMessage(exported) : options.from;
    const history = rangedHistory(exported, { ...options, from });
    const result = await publish(history, options.url);
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `${result.url}\n`);
    return;
  }
  throw new Error(usage());
}

main().catch((error) => {
  process.stderr.write(`threadshare: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
