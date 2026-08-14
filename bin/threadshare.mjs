#!/usr/bin/env node
import { createHash, randomBytes } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import process from "node:process";
import { createInterface } from "node:readline/promises";
import {
  BOOLEAN_OPTIONS,
  COMMAND_SPECS,
  DEFAULT_THREADSHARE_URL,
  OPAQUE_VALUE_OPTIONS,
  OPTION_DEFINITIONS,
  cliDiagnostic,
  preflightHelp,
  renderDiagnostic,
  validateCommandInvocation,
} from "../src/cli-contract.mjs";
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
import { formatAgentTranscript } from "../src/agent-transcript.mjs";
import {
  createPreflightResult,
  formatPreflightResult,
} from "../src/share-preflight.mjs";
import { parseShareReference } from "../src/share-url.mjs";

const SESSION_PROVIDERS = new Set(["codex", "claude", "paseo"]);
const NATIVE_SESSION_PROVIDERS = new Set(["codex", "claude"]);
const INSIGHTS_QUERY_ACTIONS = new Set([
  "overview", "search", "capabilities", "usage", "activity", "evidence", "query", "recipe",
]);
const MAX_EXPIRES_IN_SECONDS = 365 * 24 * 60 * 60;

function parseExpiresDuration(value, command = "share") {
  if (value === undefined) return undefined;
  const match = /^([1-9]\d*)([mhd])$/.exec(value);
  const multipliers = { m: 60, h: 60 * 60, d: 24 * 60 * 60 };
  const seconds = match ? Number(match[1]) * multipliers[match[2]] : Number.NaN;
  if (!Number.isSafeInteger(seconds) || seconds < 60 || seconds > MAX_EXPIRES_IN_SECONDS) {
    throw cliDiagnostic(
      "TS_USAGE_INVALID_VALUE",
      "--expires must be a duration from 1m to 365d using m, h, or d.",
      {
        command,
        next: `Use a positive integer such as 30m, 24h, or 7d. Run \`threadshare ${command} --help\`.`,
      },
    );
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
  const command = Object.hasOwn(COMMAND_SPECS, args[0]) ? args[0] : undefined;
  for (let index = 0; index < args.length; index += 1) {
    const value = args[index];
    if (!value.startsWith("--")) {
      positionals.push(value);
      continue;
    }
    const key = value.slice(2);
    if (!Object.hasOwn(OPTION_DEFINITIONS, key)) {
      throw cliDiagnostic("TS_USAGE_UNKNOWN_OPTION", `Unknown option: --${key}.`, {
        command,
        next: command
          ? `Run \`threadshare ${command} --help\` for valid options.`
          : "Run `threadshare --help` for valid commands and options.",
      });
    }
    if (Object.hasOwn(options, key)) {
      const helpCommand = command ? `threadshare ${command} --help` : "threadshare --help";
      throw cliDiagnostic("TS_USAGE_DUPLICATE_OPTION", `Duplicate option --${key}.`, {
        command,
        next: `Pass --${key} only once. Run \`${helpCommand}\` for details.`,
      });
    }
    if (BOOLEAN_OPTIONS.has(key)) {
      options[key] = true;
      continue;
    }
    const next = args[++index];
    if (next === undefined || next === "" || (next.startsWith("--") && !OPAQUE_VALUE_OPTIONS.has(key))) {
      const helpCommand = command ? `threadshare ${command} --help` : "threadshare --help";
      throw cliDiagnostic("TS_USAGE_MISSING_VALUE", `A non-empty value is required for --${key}.`, {
        command,
        next: `Add ${OPTION_DEFINITIONS[key].placeholder}. Run \`${helpCommand}\` for details.`,
      });
    }
    options[key] = next;
  }
  return { positionals, options };
}

function sessionCommand(command, positionals, options) {
  validateCommandInvocation(command, positionals, options);
  const [, provider, session] = positionals;
  if (!SESSION_PROVIDERS.has(provider)) {
    throw cliDiagnostic(
      "TS_USAGE_INVALID_VALUE",
      `${command} provider must be codex, claude, or paseo.`,
      {
        command,
        next: `Choose a supported provider. Run \`threadshare ${command} --help\`.`,
      },
    );
  }
  return { provider, session };
}

function nativeSessionCommand(command, positionals, options) {
  validateCommandInvocation(command, positionals, options);
  const [, provider, session] = positionals;
  if (!NATIVE_SESSION_PROVIDERS.has(provider)) {
    throw cliDiagnostic(
      "TS_USAGE_INVALID_VALUE",
      `${command} provider must be codex or claude.`,
      {
        command,
        next: `Choose a native provider. Run \`threadshare ${command} --help\`.`,
      },
    );
  }
  return { provider, session };
}

function parsePageInteger(name, value, fallback, maximum = MAX_MESSAGE_PAGE_SIZE, command = "messages") {
  if (value === undefined) return fallback;
  if (!/^\d+$/.test(value)) {
    throw cliDiagnostic(
      "TS_USAGE_INVALID_VALUE",
      name === "limit"
        ? `--limit must be an integer from 1 to ${maximum}.`
        : "--offset must be a non-negative safe integer.",
      {
        command,
        next: `Provide a valid --${name} value. Run \`threadshare ${command} --help\`.`,
      },
    );
  }
  const parsed = Number(value);
  if (
    !Number.isSafeInteger(parsed) ||
    (name === "limit" && (parsed < 1 || parsed > maximum))
  ) {
    throw cliDiagnostic(
      "TS_USAGE_INVALID_VALUE",
      name === "limit"
        ? `--limit must be an integer from 1 to ${maximum}.`
        : "--offset must be a non-negative safe integer.",
      {
        command,
        next: `Provide a valid --${name} value. Run \`threadshare ${command} --help\`.`,
      },
    );
  }
  return parsed;
}

function serviceUrl(value, command = "share") {
  const fromEnvironment = value === undefined && process.env.THREADSHARE_URL !== undefined;
  let url;
  try {
    url = new URL(value ?? process.env.THREADSHARE_URL ?? DEFAULT_THREADSHARE_URL);
  } catch {
    throw cliDiagnostic(
      "TS_USAGE_INVALID_VALUE",
      fromEnvironment
        ? "THREADSHARE_URL must be an absolute HTTP(S) service URL."
        : "--url must be an absolute HTTP(S) service URL.",
      {
        command,
        next: fromEnvironment
          ? "Unset or correct THREADSHARE_URL, or pass a valid --url override."
          : `Pass a valid --url, or omit it to use ${DEFAULT_THREADSHARE_URL}.`,
      },
    );
  }
  if (url.protocol !== "https:" && url.protocol !== "http:") {
    throw cliDiagnostic(
      "TS_USAGE_INVALID_VALUE",
      fromEnvironment
        ? "THREADSHARE_URL must use HTTP or HTTPS."
        : "--url must use HTTP or HTTPS.",
      {
        command,
        next: fromEnvironment
          ? "Unset or correct THREADSHARE_URL, or pass a valid --url override."
          : `Pass a valid --url, or omit it to use ${DEFAULT_THREADSHARE_URL}.`,
      },
    );
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
    throw cliDiagnostic(
      "TS_USAGE_INVALID_VALUE",
      "The revoke capability must be a 256-bit base64url value.",
      {
        command: "revoke",
        next: "Place the original capability immediately after --token, even when it starts with --. Run `threadshare revoke --help`.",
      },
    );
  }
  return token;
}

function shellQuote(value) {
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

async function readInput(file, command) {
  try {
    if (file !== "-") return await readFile(file, "utf8");
    process.stdin.setEncoding("utf8");
    const chunks = [];
    for await (const chunk of process.stdin) chunks.push(chunk);
    return chunks.join("");
  } catch {
    throw cliDiagnostic("TS_INPUT_READ_FAILED", "Unable to read the input file.", {
      command,
      next: "Check that the input file exists and is readable, or use - to read from stdin.",
    });
  }
}

async function writeOutput(file, value, command = "export") {
  if (!file || file === "-") {
    process.stdout.write(value);
    return;
  }
  try {
    await writeFile(file, value);
  } catch {
    throw cliDiagnostic("TS_OUTPUT_WRITE_FAILED", "Unable to write the output file.", {
      command,
      next: "Check the output directory and permissions, or use --output - for stdout.",
    });
  }
}

async function readHistoryInput(file, command) {
  const raw = await readInput(file, command);
  let parsed;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw cliDiagnostic("TS_INPUT_INVALID_JSON", "The input file is not valid JSON.", {
      command,
      next: `Fix the JSON syntax, then run \`threadshare ${command} --help\` for the expected input.`,
    });
  }
  try {
    return validateHistory(parsed);
  } catch (error) {
    throw cliDiagnostic(
      "TS_INPUT_SCHEMA_INVALID",
      error instanceof Error
        ? error.message
        : "Input is not a valid threadshare-history@v1 document.",
      {
        command,
        next: command === "publish"
          ? "Run `threadshare validate <history-file|->` locally, fix the reported document, then retry."
          : "Provide a canonical threadshare-history@v1 document. Run `threadshare validate --help`.",
      },
    );
  }
}

function uploadOutcomeUnknown(problem, command) {
  return cliDiagnostic("TS_PUBLISH_OUTCOME_UNKNOWN", problem, {
    command,
    next: "Do not publish again automatically. Ask the owner to check the service and decide whether a retry is safe.",
  });
}

async function publish(history, url, { expiresInSeconds, revoke = false, command = "publish" } = {}) {
  const headers = { "content-type": "application/json" };
  if (expiresInSeconds !== undefined) {
    headers["x-threadshare-expires-in"] = String(expiresInSeconds);
  }
  const revokeCapability = revoke ? createRevokeCapability() : undefined;
  if (revokeCapability) {
    headers["x-threadshare-revoke-token-sha256"] = revokeCapability.digest;
  }
  const baseUrl = serviceUrl(url, command);
  let response;
  try {
    response = await fetch(`${baseUrl}/api/v1/shares`, {
      method: "POST",
      headers,
      body: JSON.stringify(history),
      redirect: "error",
    });
  } catch (error) {
    throw uploadOutcomeUnknown(
      `Threadshare upload outcome is unknown because the network request failed: ${error instanceof Error ? error.message : String(error)}.`,
      command,
    );
  }
  const payload = await response.json().catch(() => null);
  const uncertainClientStatus = [408, 425, 429].includes(response.status);
  if (response.status >= 400 && response.status < 500 && !uncertainClientStatus) {
    throw cliDiagnostic(
      "TS_PUBLISH_REJECTED",
      payload?.error
        ? `Threadshare server rejected the upload: ${payload.error}`
        : `Threadshare server rejected the upload with HTTP ${response.status}.`,
      {
        command,
        next: `Correct the rejected request, then retry. Run \`threadshare ${command} --help\`.`,
      },
    );
  }
  let createdReference;
  if (response.ok && typeof payload?.id === "string") {
    try {
      createdReference = parseShareReference(
        `${baseUrl}/?id=${encodeURIComponent(payload.id)}`,
      );
    } catch {
      // A successful response without a canonical share ID cannot prove what was created.
    }
  }
  if (!response.ok || !createdReference) {
    throw uploadOutcomeUnknown(
      `Threadshare upload outcome is unknown after HTTP ${response.status}; the response did not contain a confirmed share ID.`,
      command,
    );
  }
  const expiresAt = typeof payload.expiresAt === "string" ? payload.expiresAt : undefined;
  const expirationRequested = expiresInSeconds !== undefined;
  const expirationConfirmed = expirationRequested ? expiresAt !== undefined : expiresAt === undefined;
  const revocationRequested = revokeCapability !== undefined;
  const revocationConfirmed = revocationRequested
    ? payload.revocable === true
    : payload.revocable !== true;
  if (!expirationConfirmed || !revocationConfirmed) {
    const { url } = createdReference;
    const problems = [];
    if (expirationRequested && expiresAt === undefined) {
      problems.push(
        "Threadshare server did not confirm the requested expiration; the share may have been created without expiration",
      );
    } else if (!expirationRequested && expiresAt !== undefined) {
      problems.push("Threadshare server returned an unexpected expiration for a permanent share request");
    }
    if (revocationRequested && payload.revocable !== true) {
      problems.push(
        "Threadshare server did not confirm revocation; the share may have been created without revocation",
      );
    } else if (!revocationRequested && payload.revocable === true) {
      problems.push("Threadshare server returned unexpected revocation for a non-revocable share request");
    }
    const policyStatus = [
      expirationRequested
        ? `requested expiration was ${expirationConfirmed ? "confirmed" : "not confirmed"}`
        : expiresAt === undefined
          ? "expiration was not requested"
          : "expiration was not requested but the server returned one",
      revocationRequested
        ? `requested revocation was ${revocationConfirmed ? "confirmed" : "not confirmed"}`
        : payload.revocable === true
          ? "revocation was not requested but the server returned it as enabled"
          : "revocation was not requested",
    ].join("; ");
    const canRevoke = revocationRequested && revocationConfirmed;
    throw cliDiagnostic(
      "TS_PUBLISH_POLICY_UNCONFIRMED",
      `${problems.join("; ")}. Policy status: ${policyStatus}.`,
      {
        command,
        result: `Share was created at ${url}, but requested policy was not fully confirmed.`,
        next: canRevoke
          ? "Do not publish again; revoke the created share now. If revoke returns 404, report the result to the owner."
          : "Do not publish again. Report the created URL to the owner or storage administrator for cleanup.",
        secretLines: canRevoke
          ? [
            `Revoke (secret, shown once; do not log): threadshare revoke ${shellQuote(url)} --token ${shellQuote(revokeCapability.token)}`,
          ]
          : [],
      },
    );
  }
  return {
    id: createdReference.id,
    url: createdReference.url,
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
  let response;
  try {
    response = await fetch(reference.apiUrl, {
      method: "DELETE",
      headers: { authorization: `Bearer ${token}` },
      redirect: "error",
    });
  } catch (error) {
    throw cliDiagnostic(
      "TS_SHARE_REVOKE_FAILED",
      `Unable to revoke the share: ${error instanceof Error ? error.message : String(error)}.`,
      {
        command: "revoke",
        next: "Check network access and the share URL. Do not put the revoke token in the URL or logs.",
      },
    );
  }
  if (response.status !== 204) {
    const payload = await response.json().catch(() => null);
    throw cliDiagnostic(
      "TS_SHARE_REVOKE_FAILED",
      payload?.error || `Threadshare revoke failed with HTTP ${response.status}.`,
      {
        command: "revoke",
        next: "Check the URL, expiration or prior revocation state, and the local capability. A 404 intentionally does not identify which check failed.",
      },
    );
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

function sessionRecovery(provider) {
  return provider === "paseo"
    ? "Run `paseo ls --json`, choose the intended agent UUID, and retry with that fixed ID."
    : `Run \`threadshare sessions ${provider} --format json\`, choose the intended session, and retry with its full ID or JSONL path.`;
}

function sessionFailureCode(provider, error, message) {
  if (error?.threadshareSessionFailureKind === "analysis_engine") {
    return "TS_OPERATION_FAILED";
  }
  if (provider === "paseo") {
    switch (error?.threadshareSessionFailureKind) {
      case "invalid_reference":
        return "TS_USAGE_INVALID_VALUE";
      case "agent_not_found":
      case "local_session_not_found":
        return "TS_SESSION_NOT_FOUND";
      case "agent_ambiguous":
      case "local_session_ambiguous":
        return "TS_SESSION_AMBIGUOUS";
      case "provider_unavailable":
        return "TS_PROVIDER_UNAVAILABLE";
      default:
        return "TS_SESSION_ACCESS_FAILED";
    }
  }
  if (/^No (?:codex|claude) session matches\b/i.test(message)) {
    return "TS_SESSION_NOT_FOUND";
  }
  if (/^Multiple (?:codex|claude) sessions match\b/i.test(message)) {
    return "TS_SESSION_AMBIGUOUS";
  }
  return "TS_SESSION_ACCESS_FAILED";
}

function sessionFailureRecovery(provider, code, failureKind) {
  if (code === "TS_OPERATION_FAILED" && failureKind === "analysis_engine") {
    return "Retry once; if analysis still fails, update Threadshare and run `threadshare analyze --help` before reporting the stable error code.";
  }
  if (provider !== "paseo") {
    return sessionRecovery(provider);
  }
  if (
    failureKind === "invalid_reference" ||
    failureKind === "agent_not_found" ||
    failureKind === "agent_ambiguous"
  ) {
    return sessionRecovery(provider);
  }
  if (
    failureKind === "local_session_not_found" ||
    failureKind === "local_session_ambiguous"
  ) {
    return "Run `paseo agent inspect <agent-id> --json`, then repair the missing or ambiguous local Paseo state or native session before retrying with the same agent UUID.";
  }
  if (code === "TS_PROVIDER_UNAVAILABLE") {
    return "Restore the Paseo CLI or daemon, then run `paseo daemon status` and `paseo ls --json` before retrying.";
  }
  return "Run `paseo agent inspect <agent-id> --json`, then repair the reported provider, inspect response, local Paseo state, or native session issue before retrying with the same agent UUID.";
}

async function exportValidatedSession(provider, session, command) {
  let history;
  try {
    history = await exportProviderSession(provider, session);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const failureKind = error?.threadshareSessionFailureKind;
    const code = sessionFailureCode(provider, error, message);
    throw cliDiagnostic(code, message, {
      command,
      next: sessionFailureRecovery(provider, code, failureKind),
    });
  }
  try {
    return validateHistory(history);
  } catch {
    throw cliDiagnostic(
      "TS_SESSION_ACCESS_FAILED",
      `The exported ${provider} session is not a valid threadshare-history@v1 document.`,
      { command, next: sessionRecovery(provider) },
    );
  }
}

function parseReference(value, command) {
  try {
    return parseShareReference(value);
  } catch {
    throw cliDiagnostic(
      "TS_SHARE_URL_INVALID",
      "The share reference is not a valid Threadshare Viewer or API URL.",
      {
        command,
        next: `Use a Viewer URL like https://host/?id=<uuid> or API URL like https://host/api/v1/shares/<uuid>. Run \`threadshare ${command} --help\`.`,
      },
    );
  }
}

async function readShare(reference) {
  try {
    return await readSharedHistory(reference);
  } catch (error) {
    throw cliDiagnostic(
      "TS_SHARE_READ_FAILED",
      error instanceof Error ? error.message : String(error),
      {
        command: "read",
        next: "Check the URL and whether the share expired or was revoked. Redirects and responses above 5 MiB are rejected.",
      },
    );
  }
}

function rangedHistory(history, options, command) {
  try {
    return validateHistory(
      selectHistoryRange(history, { from: options.from, before: options.before }),
    );
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const boundaryFailure = /No user message matches|not a user message|not a visible user turn|before the selected boundary/i.test(message);
    throw cliDiagnostic(
      boundaryFailure ? "TS_RANGE_BOUNDARY_NOT_FOUND" : "TS_RANGE_INVALID",
      message,
      {
        command,
        next: `Run \`threadshare messages ${options.provider} <session> --format json\`, choose fixed user-message IDs, and retry.`,
      },
    );
  }
}

function requireInteractiveTerminal() {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw cliDiagnostic(
      "TS_TTY_REQUIRED",
      "--pick-start requires an interactive terminal; agents should use messages and --from/--before.",
      {
        command: "share",
        next: "Run `threadshare messages <provider> <session> --format json`, ask the user to choose, then pass fixed --from/--before IDs.",
      },
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

async function confirmInsightsSecretRegeneration(confirmation) {
  if (!process.stdin.isTTY || !process.stderr.isTTY) {
    throw cliDiagnostic(
      "TS_TTY_REQUIRED",
      "Secret regeneration requires an interactive terminal.",
      {
        command: "insights",
        next: "Run `threadshare insights reindex --regenerate-secret` in an interactive terminal, or omit --regenerate-secret to preserve keyed identities.",
      },
    );
  }
  const prompt = createInterface({ input: process.stdin, output: process.stderr });
  try {
    process.stderr.write(
      "This replaces the origin secret and every keyed local Insight only after a complete atomic rebuild.\n",
    );
    const answer = await prompt.question(`Type ${confirmation} to continue: `);
    if (answer !== confirmation) {
      throw cliDiagnostic(
        "TS_USAGE_INVALID_VALUE",
        "Secret regeneration confirmation did not match.",
        {
          command: "insights",
          next: "Retry only when you intend to replace all keyed local Insights, and type the exact confirmation shown.",
        },
      );
    }
  } finally {
    prompt.close();
  }
}

function insightsFailure(error, action) {
  if (typeof error?.code === "string" && error.code.startsWith("TS_USAGE_")) {
    return cliDiagnostic(error.code, error instanceof Error ? error.message : String(error), {
      command: "insights",
      next: "Run `threadshare insights --help` and correct the command arguments.",
    });
  }
  if (error?.code === "TS_INSIGHTS_ENGINE_UNAVAILABLE" ||
      error?.code === "TS_INSIGHTS_ENGINE_INVALID") {
    return cliDiagnostic(error.code, "The local Insights Engine is unavailable or invalid.", {
      command: "insights",
      next: "Install or repair the matching Threadshare platform package, then retry `threadshare insights status`.",
    });
  }
  if (error?.code === "TS_INSIGHTS_ENGINE_TIMEOUT") {
    return cliDiagnostic(error.code, "The local Insights maintenance operation exceeded its time limit.", {
      command: "insights",
      next: "Retry `threadshare insights sync`; if it recurs, run `threadshare insights status --verify`.",
    });
  }
  if (error?.code === "TS_INSIGHTS_ENGINE_DISCONNECTED") {
    return cliDiagnostic(error.code, "The local Insights Engine stopped during maintenance.", {
      command: "insights",
      next: "Retry `threadshare insights sync`; if it recurs, run `threadshare insights status --verify`.",
    });
  }
  if (error?.code === "TS_INSIGHTS_WRITER_LOCKED") {
    return cliDiagnostic(error.code, "Another local Insights sync, reindex, or maintenance writer is still running.", {
      command: "insights",
      next: "Wait for the active Insights command to finish, then retry; do not start concurrent writers.",
    });
  }
  if (error?.code === "TS_INSIGHTS_ORIGIN_SECRET_MISSING" ||
      error?.code === "TS_INSIGHTS_ORIGIN_SECRET_INVALID") {
    return cliDiagnostic(
      error.code,
      "The local Insights origin secret is missing or invalid while indexed state exists.",
      {
        command: "insights",
        next: "Run `threadshare insights reindex --regenerate-secret` interactively to perform a complete keyed rebuild.",
      },
    );
  }
  if (error?.code === "TS_INSIGHTS_PURGE_PENDING") {
    return cliDiagnostic(error.code, "Excluded Insight facts are hidden but secure purge is still pending.", {
      command: "insights",
      next: "Run `threadshare insights status`, then retry maintenance after the current writer finishes.",
    });
  }
  if (error?.code === "TS_INSIGHTS_REINDEX_INCOMPLETE") {
    const summary = error.failureSummary;
    const diagnostics = Array.isArray(summary?.diagnostics)
      ? summary.diagnostics
        .map(({ provider, code, errorCode, count }) =>
          `${provider}/${code}/${errorCode}: ${count}`)
        .join(", ")
      : "unavailable";
    const failed = Number.isSafeInteger(summary?.failed) ? summary.failed : "unknown";
    return cliDiagnostic(
      error.code,
      `Insights reindex failed for ${failed} session operation(s): ${diagnostics}.`,
      {
        command: "insights",
        next: "Retry `threadshare insights sync`; if it recurs, resolve the reported provider/error code.",
      },
    );
  }
  if (error?.code === "TS_INSIGHTS_EXCLUSION_APPLY_FAILED") {
    return cliDiagnostic(error.code, "Not all configured Insight exclusions could be hidden.", {
      command: "insights",
      next: "Retry the same `threadshare insights exclude add` command; the operation is idempotent.",
    });
  }
  if (error?.code === "TS_INSIGHTS_REINDEX_SPACE_REQUIRED" ||
      error?.code === "TS_INSIGHTS_PROJECTION_SPACE_REQUIRED") {
    return cliDiagnostic(error.code, "Local Insights needs more free disk space before rebuilding its index.", {
      command: "insights",
      next: "Free local disk space, then retry the requested Insights operation.",
    });
  }
  const next = action === "reset"
    ? "Resolve the reported local state or writer-lock problem, then retry `threadshare insights reset`."
    : "Run `threadshare insights status`, resolve its diagnostic, then retry the requested action.";
  return cliDiagnostic("TS_OPERATION_FAILED", "Unable to complete local Insights maintenance.", {
    command: "insights",
    next,
  });
}

async function main() {
  const args = process.argv.slice(2);
  const help = preflightHelp(args);
  if (help !== null) {
    process.stdout.write(`${help}\n`);
    return;
  }
  const { positionals, options } = parseArgs(args);
  const [command] = positionals;
  if (!command) {
    throw cliDiagnostic("TS_USAGE_MISSING_ARGUMENT", "Missing command.", {
      next: "Run `threadshare --help` and choose a command.",
    });
  }
  if (!Object.hasOwn(COMMAND_SPECS, command) || command === "help") {
    throw cliDiagnostic("TS_USAGE_UNKNOWN_COMMAND", `Unknown command: ${command}.`, {
      next: "Run `threadshare --help` and choose a listed command.",
    });
  }
  if (command === "validate") {
    validateCommandInvocation(command, positionals, options);
    await readHistoryInput(positionals[1], command);
    process.stdout.write("Valid threadshare-history@v1\n");
    return;
  }
  if (command === "sessions") {
    validateCommandInvocation(command, positionals, options);
    const provider = positionals[1];
    if (!NATIVE_SESSION_PROVIDERS.has(provider)) {
      throw cliDiagnostic(
        "TS_USAGE_INVALID_VALUE",
        provider === "paseo"
          ? "sessions does not list Paseo agents."
          : "sessions provider must be codex or claude.",
        {
          command,
          next: provider === "paseo"
            ? "Run `paseo ls --json` to list Paseo agents."
            : "Use codex or claude. Run `threadshare sessions --help`.",
        },
      );
    }
    const format = options.format ?? "text";
    if (format !== "text" && format !== "json") {
      throw cliDiagnostic("TS_USAGE_INVALID_VALUE", "--format must be text or json.", {
        command,
        next: "Use --format text for people or --format json for agents.",
      });
    }
    const limit = parsePageInteger(
      "limit",
      options.limit,
      DEFAULT_SESSION_PAGE_SIZE,
      MAX_SESSION_PAGE_SIZE,
      command,
    );
    const offset = parsePageInteger("offset", options.offset, 0, MAX_MESSAGE_PAGE_SIZE, command);
    let result;
    try {
      result = await listSessions(provider, { limit, offset });
    } catch {
      throw cliDiagnostic("TS_SESSION_ACCESS_FAILED", `Unable to list ${provider} sessions.`, {
        command,
        next: `Check the local ${provider} session directory and run \`threadshare sessions ${provider} --help\`.`,
      });
    }
    process.stdout.write(
      format === "json" ? `${JSON.stringify(result)}\n` : formatSessionPage(result, offset, limit),
    );
    return;
  }
  if (command === "analyze") {
    const { provider, session } = nativeSessionCommand(command, positionals, options);
    const format = options.format ?? "text";
    if (format !== "text" && format !== "json") {
      throw cliDiagnostic("TS_USAGE_INVALID_VALUE", "--format must be text or json.", {
        command,
        next: "Use --format text for people or --format json for agents.",
      });
    }
    let report;
    let formatReport;
    try {
      const {
        analyzeSession,
        formatSessionAnalysisJson,
        formatSessionAnalysisText,
      } = await import("../src/turn-analysis.mjs");
      report = await analyzeSession(provider, session);
      formatReport = format === "json"
        ? formatSessionAnalysisJson
        : formatSessionAnalysisText;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const code = sessionFailureCode(provider, error, message);
      const problem = code === "TS_OPERATION_FAILED"
        ? "Unable to complete local session analysis."
        : `Unable to analyze the requested ${provider} session.`;
      throw cliDiagnostic(code, problem, {
        command,
        next: sessionFailureRecovery(
          provider,
          code,
          error?.threadshareSessionFailureKind,
        ),
      });
    }
    process.stdout.write(formatReport(report));
    return;
  }
  if (command === "insights") {
    validateCommandInvocation(command, positionals, options);
    const { insightsEngineReleaseTarget } = await import("../src/insights-engine-targets.mjs");
    if (insightsEngineReleaseTarget() === null) {
      throw cliDiagnostic(
        "TS_INSIGHTS_ENGINE_UNAVAILABLE",
        "Local Insights is not available for this platform in this release.",
        {
          command: "insights",
          next: "Use Threadshare core commands on Windows, or run Insights on macOS or Linux.",
        },
      );
    }
    const queryOnlyOptions = {
      cursor: options.cursor,
      limit: options.limit,
      query: options.query,
      request: options.request,
      revision: options.revision,
      stdio: options.stdio,
    };
    if (positionals[1] === "mcp") {
      if (positionals.length !== 2) {
        throw cliDiagnostic("TS_USAGE_UNEXPECTED_ARGUMENT", "insights mcp takes no positional argument.", {
          command: "insights",
          next: "Run `threadshare insights mcp --stdio`.",
        });
      }
      for (const [optionName, optionValue] of Object.entries(options)) {
        if (optionValue !== undefined && optionName !== "stdio") {
          throw cliDiagnostic("TS_USAGE_OPTION_NOT_ALLOWED", `--${optionName} is not valid for insights mcp.`, {
            command: "insights",
            next: "Run `threadshare insights mcp --stdio`.",
          });
        }
      }
      if (options.stdio !== true) {
        throw cliDiagnostic("TS_USAGE_OPTION_DEPENDENCY", "insights mcp requires --stdio.", {
          command: "insights",
          next: "Run `threadshare insights mcp --stdio`.",
        });
      }
      const { runInsightsMcpServer } = await import("../src/insights-mcp.mjs");
      await runInsightsMcpServer();
      return;
    }
    if (INSIGHTS_QUERY_ACTIONS.has(positionals[1])) {
      let invocation;
      const controller = new AbortController();
      const onSignal = () => controller.abort();
      process.once("SIGINT", onSignal);
      process.once("SIGTERM", onSignal);
      try {
        const {
          executeInsightsQuery,
          formatInsightsQueryResult,
          parseInsightsQueryInvocation,
        } = await import("../src/insights-query.mjs");
        invocation = parseInsightsQueryInvocation(positionals, options);
        const result = await executeInsightsQuery(invocation, { signal: controller.signal });
        process.stdout.write(formatInsightsQueryResult(result));
        return;
      } catch (error) {
        const { insightsQueryDiagnostic } = await import("../src/insights-query.mjs");
        throw insightsQueryDiagnostic(error, invocation?.action ?? positionals[1]);
      } finally {
        process.off("SIGINT", onSignal);
        process.off("SIGTERM", onSignal);
      }
    }
    for (const [optionName, optionValue] of Object.entries(queryOnlyOptions)) {
      if (optionValue !== undefined) {
        throw cliDiagnostic(
          "TS_USAGE_OPTION_NOT_ALLOWED",
          `--${optionName} is only valid for an Insights query action.`,
          {
            command: "insights",
            next: "Remove the query option, or choose overview, search, capabilities, usage, activity, evidence, query, recipe, or mcp.",
          },
        );
      }
    }
    let invocation;
    try {
      const {
        REGENERATE_SECRET_CONFIRMATION,
        createInsightsProgressReporter,
        executeInsightsCommand,
        formatInsightsCommandResult,
        parseInsightsInvocation,
      } = await import("../src/insights-command.mjs");
      invocation = parseInsightsInvocation(positionals, {
        ...options,
        "regenerate-secret": options["regenerate-secret"],
        verify: options.verify,
      });
      if (invocation.action === "dashboard") {
        const { runInsightsDashboardUntilSignal } = await import("../src/insights-dashboard.mjs");
        await runInsightsDashboardUntilSignal();
        return;
      }
      if (invocation.regenerateSecret) {
        await confirmInsightsSecretRegeneration(REGENERATE_SECRET_CONFIRMATION);
      }
      const progress = createInsightsProgressReporter({ format: invocation.format });
      try {
        const result = await executeInsightsCommand(invocation, {
          regenerationConfirmation: invocation.regenerateSecret
            ? REGENERATE_SECRET_CONFIRMATION
            : undefined,
          onProgress: progress.update,
        });
        progress.finish();
        process.stdout.write(formatInsightsCommandResult(result, invocation.format));
      } finally {
        progress.finish();
      }
      return;
    } catch (error) {
      if (error?.name === "CliDiagnostic") throw error;
      throw insightsFailure(error, invocation?.action ?? positionals[1]);
    }
  }
  if (command === "messages") {
    const { provider, session } = sessionCommand(command, positionals, options);
    if (options.format !== "json") {
      throw cliDiagnostic(
        options.format === undefined ? "TS_USAGE_OPTION_DEPENDENCY" : "TS_USAGE_INVALID_VALUE",
        "messages requires --format json.",
        { command, next: "Add --format json. Run `threadshare messages --help`." },
      );
    }
    const history = await exportValidatedSession(provider, session, command);
    const limit = parsePageInteger(
      "limit",
      options.limit,
      DEFAULT_MESSAGE_PAGE_SIZE,
      MAX_MESSAGE_PAGE_SIZE,
      command,
    );
    const offset = parsePageInteger(
      "offset",
      options.offset,
      0,
      MAX_MESSAGE_PAGE_SIZE,
      command,
    );
    let result;
    try {
      result = listUserMessagePage(history, {
        before: options.before,
        limit,
        offset,
      });
    } catch (error) {
      throw cliDiagnostic("TS_RANGE_BOUNDARY_NOT_FOUND", error instanceof Error ? error.message : String(error), {
        command,
        next: `Retry without --before, or run \`threadshare messages ${provider} <session> --format json\` with a valid fixed boundary.`,
      });
    }
    process.stdout.write(`${JSON.stringify(result)}\n`);
    return;
  }
  if (command === "export") {
    const { provider, session } = sessionCommand(command, positionals, options);
    const history = rangedHistory(
      await exportValidatedSession(provider, session, command),
      { ...options, provider },
      command,
    );
    await writeOutput(options.output, `${JSON.stringify(history, null, 2)}\n`, command);
    return;
  }
  if (command === "publish") {
    validateCommandInvocation(command, positionals, options);
    const expiresInSeconds = parseExpiresDuration(options.expires, command);
    const result = await publish(
      await readHistoryInput(positionals[1], command),
      options.url,
      { command, expiresInSeconds, revoke: options.revoke === true },
    );
    writePublishResult(result, options.json === true);
    return;
  }
  if (command === "share") {
    const { provider, session } = sessionCommand(command, positionals, options);
    const dryRun = options["dry-run"] === true;
    if (options.report && !dryRun) {
      throw cliDiagnostic("TS_USAGE_OPTION_DEPENDENCY", "--report requires --dry-run.", {
        command,
        next: "Add --dry-run, or remove --report. Run `threadshare share --help` for details.",
      });
    }
    if (options["pick-start"] && (options.from || options.before)) {
      throw cliDiagnostic(
        "TS_USAGE_OPTION_CONFLICT",
        "--pick-start cannot be combined with --from or --before.",
        {
          command,
          next: "Use interactive --pick-start alone, or remove it and pass fixed --from/--before IDs.",
        },
      );
    }
    if (options["pick-start"]) requireInteractiveTerminal();
    const expiresInSeconds = parseExpiresDuration(options.expires, command);
    if (dryRun) serviceUrl(options.url, command);
    const exported = await exportValidatedSession(provider, session, command);
    const from = options["pick-start"] ? await pickStartMessage(exported) : options.from;
    const history = rangedHistory(exported, { ...options, from, provider }, command);
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
      command,
      expiresInSeconds,
      revoke: options.revoke === true,
    });
    writePublishResult(result, options.json === true);
    return;
  }
  if (command === "revoke") {
    validateCommandInvocation(command, positionals, options);
    const reference = parseReference(positionals[1], command);
    const token = validateRevokeToken(options.token);
    const result = await revokeShare(reference, token);
    process.stdout.write(options.json ? `${JSON.stringify(result)}\n` : `Revoked ${result.url}\n`);
    return;
  }
  if (command === "read") {
    validateCommandInvocation(command, positionals, options);
    if (
      options.format !== undefined &&
      options.format !== "agent" &&
      options.format !== "json" &&
      options.format !== "markdown"
    ) {
      throw cliDiagnostic(
        "TS_USAGE_INVALID_VALUE",
        "read format must be agent, json, or markdown.",
        {
          command,
          next: "Omit --format or use agent for compact review text, json for complete data, or markdown for the complete readable transcript.",
        },
      );
    }
    const history = await readShare(parseReference(positionals[1], command));
    process.stdout.write(
      options.format === "json"
        ? `${JSON.stringify(history)}\n`
        : options.format === "markdown"
          ? formatHistoryAsMarkdown(history)
          : formatAgentTranscript(history),
    );
    return;
  }
  throw cliDiagnostic("TS_USAGE_UNKNOWN_COMMAND", `Unknown command: ${command}.`, {
    next: "Run `threadshare --help` and choose a listed command.",
  });
}

main().catch((error) => {
  process.stderr.write(renderDiagnostic(error));
  process.exitCode = 1;
});
