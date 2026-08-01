#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
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
import {
  DEFAULT_SESSION_PAGE_SIZE,
  MAX_SESSION_PAGE_SIZE,
  listSessions,
} from "../src/session-listing.mjs";
import {
  formatHistoryAsMarkdown,
  readSharedHistory,
  validateHistory,
} from "../src/share-read.mjs";
import {
  createPreflightResult,
  formatPreflightResult,
} from "../src/share-preflight.mjs";
import { parseShareReference } from "../src/share-url.mjs";

const DEFAULT_THREADSHARE_URL = "https://cloud-thread.team-harness.com";
const SESSION_PROVIDERS = new Set(["codex", "claude", "paseo"]);
const NATIVE_SESSION_PROVIDERS = new Set(["codex", "claude"]);
const BOOLEAN_OPTIONS = new Set(["dry-run", "help", "json", "pick-start", "report", "revoke"]);
const OPAQUE_VALUE_OPTIONS = new Set(["token"]);
const MAX_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;
function usage() {
  return `Usage:
  threadshare sessions <codex|claude> [--format <text|json>] [--offset <n>] [--limit <n>]
  threadshare messages <codex|claude|paseo> <session-id|file|agent-id> --format json [--before <user-message-id>] [--offset <n>] [--limit <n>]
  threadshare export <codex|claude|paseo> <session-id|file|agent-id> [--from <user-message-id|last-user>] [--before <user-message-id>] [--output <file|->]
  threadshare publish <history.json|-> [--expires <duration>] [--revoke] [--url <service-url>] [--json]
  threadshare share <codex|claude|paseo> <session-id|file|agent-id> [--from <user-message-id|last-user>] [--before <user-message-id>] [--pick-start] [--dry-run [--report]] [--expires <duration>] [--revoke] [--url <service-url>] [--json]
  threadshare read <share-url> --format <json|markdown>
  threadshare revoke <share-url> --token <token> [--json]
  threadshare validate <history.json|->

Range: omit --from and --before for the full visible snapshot; empty values are rejected.
Default service: ${DEFAULT_THREADSHARE_URL}`;
}

function parseExpiresDuration(value) {
  if (value === undefined) return undefined;
  const match = /^([1-9]\d*)([mhd])$/.exec(value);
  const multipliers = { m: 60, h: 60 * 60, d: 24 * 60 * 60 };
  const seconds = match ? Number(match[1]) * multipliers[match[2]] : Number.NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > MAX_EXPIRES_IN_SECONDS) {
    throw new Error("--expires must be a duration from 1m to 365d using m, h, or d");
  }
  return seconds;
}

function providerLabel(provider) {
  return provider === "codex" ? "Codex" : "Claude";
}

function formatSessionPage(page, offset, limit) {
  const label = providerLabel(page.provider);
  const lines = [];
  if (page.sessions.length === 0) {
    lines.push(page.total === 0
      ? `No ${label} sessions found.`
      : `No ${label} sessions at offset ${offset} (${page.total} total).`);
  } else {
    lines.push(
      `${label} sessions ${offset + 1}-${offset + page.sessions.length} of ${page.total} (newest first)`,
    );
    for (const [index, session] of page.sessions.entries()) {
      lines.push("", `${offset + index + 1}. ${session.id}`, `   Updated: ${session.updatedAt}`);
      if (session.project) lines.push(`   Project: ${session.project}`);
      if (session.branch) lines.push(`   Branch: ${session.branch}`);
      lines.push(`   First request: ${session.preview ?? "(unavailable)"}`);
    }
  }
  if (page.skippedAmbiguous > 0) {
    lines.push(
      "",
      `Warning: skipped ${page.skippedAmbiguous} ambiguous session ID${page.skippedAmbiguous === 1 ? "" : "s"}; use an explicit JSONL path.`,
    );
  }
  if (page.hasMore) {
    lines.push(
      "",
      `More: threadshare sessions ${page.provider} --offset ${page.nextOffset} --limit ${limit}`,
    );
  }
  return `${lines.join("\n")}\n`;
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
    if (!next || (next.startsWith("--") && !OPAQUE_VALUE_OPTIONS.has(key))) {
      throw new Error(`Missing value for --${key}`);
    }
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

function parsePageInteger(name, value, fallback, maximum = MAX_MESSAGE_PAGE_SIZE) {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw new Error(
      name === "limit"
        ? `--limit must be an integer from 1 to ${maximum}`
        : "--offset must be a non-negative integer",
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (name === "limit" && (parsed < 1 || parsed > maximum))
  ) {
    throw new Error(
      name === "limit"
        ? `--limit must be an integer from 1 to ${maximum}`
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

function createRevokeCapability() {
  const token = randomBytes(32).toString("base64url");
  return {
    token,
    digest: createHash("sha256").update(token).digest("base64url"),
  };
}

function validateRevokeToken(token) {
  if (!/^[A-Za-z0-9_-]{42}[AEIMQUYcgkosw048]$/.test(token ?? "")) {
    throw new Error("--token must be a 256-bit base64url capability");
  }
  return token;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
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

async function publish(history, url, { expiresInSeconds, revoke = false } = {}) {
  const headers = { "content-type": "application/json" };
  if (expiresInSeconds !== undefined) {
    headers["x-threadshare-expires-in"] = String(expiresInSeconds);
  }
  const revokeCapability = revoke ? createRevokeCapability() : undefined;
  if (revokeCapability) {
    headers["x-threadshare-revoke-token-sha256"] = revokeCapability.digest;
  }
  const response = await fetch(`${serviceUrl(url)}/api/v1/shares`, {
    method: "POST",
    headers,
    body: JSON.stringify(history),
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok || !payload?.id) {
    throw new Error(payload?.error || `Threadshare upload failed with HTTP ${response.status}`);
  }
  const expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : undefined;
  if (expiresInSeconds !== undefined && expiresAt === undefined) {
    throw new Error(
      "Threadshare server did not confirm the requested expiration; the share may have been created without expiration",
    );
  }
  if (revokeCapability && payload.revocable !== true) {
    throw new Error(
      "Threadshare server did not confirm revocation; the share may have been created without revocation",
    );
  }
  return {
    id: payload.id,
    url: `${serviceUrl(url)}/?id=${encodeURIComponent(payload.id)}`,
    ...(expiresAt === undefined ? {} : { expiresAt }),
    ...(revokeCapability === undefined ? {} : { revokeToken: revokeCapability.token }),
  };
}

function writePublishResult(result, json) {
  if (json) {
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  process.stdout.write(`${result.url}\n`);
  if (result.revokeToken) {
    process.stderr.write(
      `Revoke: threadshare revoke ${shellQuote(result.url)} --token ${shellQuote(result.revokeToken)}\n`,
    );
  }
}

async function revokeShare(reference, token) {
  const response = await fetch(reference.apiUrl, {
    method: "DELETE",
    headers: { authorization: `Bearer ${token}` },
    redirect: "error",
  });
  if (response.status !== 204) {
    const payload = await response.json().catch(() => null);
    throw new Error(payload?.error || `Threadshare revoke failed with HTTP ${response.status}`);
  }
  return { id: reference.id, url: reference.url, revoked: true };
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
  if (command === "sessions") {
    validateCommandShape(command, positionals, options, 2, new Set(["format", "limit", "offset"]));
    const provider = positionals[1];
    if (!NATIVE_SESSION_PROVIDERS.has(provider)) throw new Error(usage());
    const format = options.format ?? "text";
    if (format !== "text" && format !== "json") {
      throw new Error("--format must be text or json");
    }
    const limit = parsePageInteger(
      "limit",
      options.limit,
      DEFAULT_SESSION_PAGE_SIZE,
      MAX_SESSION_PAGE_SIZE,
    );
    const offset = parsePageInteger("offset", options.offset, 0);
    const result = await listSessions(provider, { limit, offset });
    process.stdout.write(
      format === "json" ? `${JSON.stringify(result)}\n` : formatSessionPage(result, offset, limit),
    );
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
    validateCommandShape(
      command,
      positionals,
      options,
      2,
      new Set(["expires", "json", "revoke", "url"]),
    );
    const expiresInSeconds = parseExpiresDuration(options.expires);
    const result = await publish(
      validateHistory(JSON.parse(await readInput(positionals[1]))),
      options.url,
      { expiresInSeconds, revoke: options.revoke === true },
    );
    writePublishResult(result, options.json === true);
    return;
  }
  if (command === "share") {
    const { provider, session } = sessionCommand(
      command,
      positionals,
      options,
      new Set([
        "before",
        "dry-run",
        "expires",
        "from",
        "json",
        "pick-start",
        "report",
        "revoke",
        "url",
      ]),
    );
    const dryRun = options["dry-run"] === true;
    if (options.report && !dryRun) throw new Error("--report requires --dry-run");
    if (options["pick-start"] && (options.from || options.before)) {
      throw new Error("--pick-start cannot be combined with --from or --before");
    }
    if (options["pick-start"]) requireInteractiveTerminal();
    const expiresInSeconds = parseExpiresDuration(options.expires);
    if (dryRun) serviceUrl(options.url);
    const exported = validateHistory(await exportProviderSession(provider, session));
    const from = options["pick-start"] ? await pickStartMessage(exported) : options.from;
    const history = rangedHistory(exported, { ...options, from });
    if (dryRun) {
      const result = createPreflightResult(history, {
        expiresInSeconds,
        includeReport: options.report === true,
        revoke: options.revoke === true,
      });
      process.stdout.write(
        options.json ? `${JSON.stringify(result)}\n` : formatPreflightResult(result),
      );
      if (!result.valid) process.exitCode = 1;
      return;
    }
    const result = await publish(history, options.url, {
      expiresInSeconds,
      revoke: options.revoke === true,
    });
    writePublishResult(result, options.json === true);
    return;
  }
  if (command === "revoke") {
    validateCommandShape(command, positionals, options, 2, new Set(["json", "token"]));
    const reference = parseShareReference(positionals[1]);
    const token = validateRevokeToken(options.token);
    const result = await revokeShare(reference, token);
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `Revoked ${result.url}\n`);
    return;
  }
  if (command === "read") {
    validateCommandShape(command, positionals, options, 2, new Set(["format"]));
    if (options.format !== "json" && options.format !== "markdown") {
      throw new Error("read requires --format json or markdown");
    }
    const history = await readSharedHistory(parseShareReference(positionals[1]));
    process.stdout.write(
      options.format === "json"
        ? `${JSON.stringify(history)}\n`
        : formatHistoryAsMarkdown(history),
    );
    return;
  }
  throw new Error(usage());
}

main().catch((error) => {
  process.stderr.write(`threadshare: ${error instanceof Error ? error.message : String(error)}\n`);
  process.exitCode = 1;
});
