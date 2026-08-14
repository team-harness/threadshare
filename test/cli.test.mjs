import assert from "node:assert/strict";
import { execFile, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import test, { after } from "node:test";
import { promisify } from "node:util";
import { fileURLToPath } from "node:url";
import {
  cliDiagnostic,
  COMMAND_SPECS,
  DIAGNOSTIC_CODES,
  OPTION_DEFINITIONS,
  renderCommandHelp,
  renderInsightsActionHelp,
  renderDiagnostic,
  renderRootHelp,
  sanitizeDiagnosticProblem,
} from "../src/cli-contract.mjs";
import {
  exportClaudeJsonl,
  exportCodexJsonl,
  exportSessionById,
  resolveSessionFile,
} from "../src/session-export.mjs";
import { CHAT_SHARE_MAX_BYTES } from "../src/share-read.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cli = path.join(root, "bin", "threadshare.mjs");
const execFileAsync = promisify(execFile);
const observedDiagnosticCodes = new Set();
const focusedTestRun = [...process.execArgv, ...process.argv]
  .some((argument) => argument.startsWith("--test-name-pattern"));

function assertDiagnosticCode(result, code) {
  assert.equal(result.status ?? result.code, 1, result.stderr);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, new RegExp(`^threadshare: error ${code}\\n`));
  observedDiagnosticCodes.add(code);
}

after(() => {
  if (focusedTestRun) return;
  assert.deepEqual(
    [...observedDiagnosticCodes].sort(),
    [...DIAGNOSTIC_CODES].sort(),
    "every stable diagnostic code must be exercised through behavior",
  );
});

function canonicalHistory() {
  return {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    exportedAt: "2026-07-30T00:00:00.000Z",
    conversation: { id: "conversation-1", title: "CLI test" },
    entries: [],
  };
}

function codexCliJsonl(turns) {
  const records = [
    {
      type: "session_meta",
      timestamp: "2026-07-31T00:00:00.000Z",
      payload: { session_id: "cli-selection" },
    },
  ];
  for (let index = 1; index <= turns; index += 1) {
    records.push(
      {
        type: "response_item",
        timestamp: `2026-07-31T00:00:${String(index * 2 - 1).padStart(2, "0")}.000Z`,
        payload: {
          type: "message",
          id: `cli-user-${index}`,
          role: "user",
          content: [{ type: "input_text", text: `CLI request ${index}` }],
        },
      },
      {
        type: "response_item",
        timestamp: `2026-07-31T00:00:${String(index * 2).padStart(2, "0")}.000Z`,
        payload: {
          type: "message",
          id: `cli-assistant-${index}`,
          role: "assistant",
          content: [{ type: "output_text", text: `CLI answer ${index}` }],
        },
      },
    );
  }
  return `${records.map((record) => JSON.stringify(record)).join("\n")}\n`;
}

async function createCliSession(raw = codexCliJsonl(13), name = "session.jsonl") {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-range-"));
  const file = path.join(directory, name);
  await writeFile(file, raw);
  return { directory, file };
}

test("renders a self-describing root and command help contract", () => {
  const expectedOptions = {
    sessions: ["format", "limit", "offset"],
    analyze: ["format"],
    insights: [
      "cursor",
      "format",
      "limit",
      "query",
      "regenerate-secret",
      "request",
      "revision",
      "stdio",
      "verify",
    ],
    messages: ["before", "format", "limit", "offset"],
    export: ["before", "from", "output"],
    publish: ["expires", "json", "revoke", "url"],
    share: [
      "before",
      "dry-run",
      "expires",
      "from",
      "json",
      "pick-start",
      "report",
      "revoke",
      "url",
    ],
    read: ["format"],
    revoke: ["json", "token"],
    validate: [],
    help: ["help"],
  };
  const expectedDiagnosticCodes = [
    "TS_USAGE_UNKNOWN_COMMAND",
    "TS_USAGE_MISSING_ARGUMENT",
    "TS_USAGE_UNEXPECTED_ARGUMENT",
    "TS_USAGE_UNKNOWN_OPTION",
    "TS_USAGE_OPTION_NOT_ALLOWED",
    "TS_USAGE_DUPLICATE_OPTION",
    "TS_USAGE_MISSING_VALUE",
    "TS_USAGE_INVALID_VALUE",
    "TS_USAGE_OPTION_DEPENDENCY",
    "TS_USAGE_OPTION_CONFLICT",
    "TS_SESSION_NOT_FOUND",
    "TS_SESSION_AMBIGUOUS",
    "TS_SESSION_ACCESS_FAILED",
    "TS_RANGE_INVALID",
    "TS_RANGE_BOUNDARY_NOT_FOUND",
    "TS_INPUT_READ_FAILED",
    "TS_INPUT_INVALID_JSON",
    "TS_INPUT_SCHEMA_INVALID",
    "TS_OUTPUT_WRITE_FAILED",
    "TS_TTY_REQUIRED",
    "TS_PROVIDER_UNAVAILABLE",
    "TS_SHARE_URL_INVALID",
    "TS_SHARE_READ_FAILED",
    "TS_SHARE_REVOKE_FAILED",
    "TS_PUBLISH_REJECTED",
    "TS_PUBLISH_OUTCOME_UNKNOWN",
    "TS_PUBLISH_POLICY_UNCONFIRMED",
    "TS_QUERY_TOO_LONG",
    "TS_QUERY_TOO_BROAD",
    "TS_INSIGHTS_REQUEST_INVALID",
    "TS_INSIGHTS_NOT_INDEXED",
    "TS_INSIGHTS_QUERY_V2_NOT_READY",
    "TS_INSIGHTS_CURSOR_STALE",
    "TS_INSIGHTS_TURN_CHANGED",
    "TS_INSIGHTS_PAYLOAD_CHANGED",
    "TS_INSIGHTS_EVIDENCE_NOT_FOUND",
    "TS_INSIGHTS_COVERAGE_INCOMPLETE",
    "TS_INSIGHTS_ENGINE_STATUS_SKIPPED",
    "TS_INSIGHTS_ENGINE_TIMEOUT",
    "TS_INSIGHTS_ENGINE_DISCONNECTED",
    "TS_INSIGHTS_ENGINE_UNAVAILABLE",
    "TS_INSIGHTS_WRITER_LOCKED",
    "TS_INSIGHTS_ENGINE_INVALID",
    "TS_INSIGHTS_STORAGE_FAILED",
    "TS_INSIGHTS_STORAGE_CORRUPT",
    "TS_INSIGHTS_WAL_BACKPRESSURE",
    "TS_INSIGHTS_ORIGIN_SECRET_MISSING",
    "TS_INSIGHTS_ORIGIN_SECRET_INVALID",
    "TS_INSIGHTS_EXCLUSION_APPLY_FAILED",
    "TS_INSIGHTS_REINDEX_SPACE_REQUIRED",
    "TS_INSIGHTS_PROJECTION_SPACE_REQUIRED",
    "TS_INSIGHTS_REINDEX_RECOVERY_REQUIRED",
    "TS_INSIGHTS_REINDEX_INCOMPLETE",
    "TS_INSIGHTS_PURGE_PENDING",
    "TS_OPERATION_FAILED",
  ];
  assert.deepEqual(Object.keys(COMMAND_SPECS), Object.keys(expectedOptions));
  assert.deepEqual(DIAGNOSTIC_CODES, expectedDiagnosticCodes);
  const cliSource = readFileSync(cli, "utf8");
  const referencedOptions = new Set(
    [...cliSource.matchAll(/\boptions(?:\.([a-z][a-z0-9-]*)|\["([^"]+)"\])/gu)]
      .map((match) => match[1] ?? match[2]),
  );
  referencedOptions.delete("provider");
  assert.deepEqual(
    [...referencedOptions].sort(),
    Object.keys(OPTION_DEFINITIONS).filter((name) => name !== "help").sort(),
    "every public option must be consumed by the CLI",
  );
  assert.deepEqual(
    Object.keys(OPTION_DEFINITIONS).sort(),
    [...new Set(Object.values(expectedOptions).flat())].sort(),
  );
  assert.match(renderRootHelp(), /Threadshare shares AI agent conversation threads/);
  assert.match(renderRootHelp(), /threadshare <command> --help/);
  assert.match(renderRootHelp(), /threadshare --version/);
  assert.match(renderRootHelp(), /https:\/\/cloud-thread\.team-harness\.com/);
  for (const [command, optionNames] of Object.entries(expectedOptions)) {
    const spec = COMMAND_SPECS[command];
    assert.deepEqual([...spec.options].sort(), [...optionNames].sort(), command);
    const help = renderCommandHelp(command);
    assert.match(help, new RegExp(`Usage:\\n  threadshare ${command}`));
    for (const argument of spec.arguments) {
      assert.ok(help.includes(argument.placeholder), `${command} omits ${argument.placeholder}`);
    }
    for (const option of optionNames) {
      assert.ok(OPTION_DEFINITIONS[option], `${command} references unknown --${option}`);
      assert.match(help, new RegExp(`--${option}(?:\\s|$)`));
    }
  }
  assert.match(renderCommandHelp("share"), /Agents must not use --from last-user/);
  assert.match(renderCommandHelp("share"), /canonical ID, unique ID prefix, or JSONL path/);
  assert.match(renderCommandHelp("share"), /paseo ls --json/);
  assert.match(renderCommandHelp("share"), /invalid dry run.*exits 1.*stdout.*JSON.*stderr.*empty/is);
  assert.match(renderCommandHelp("sessions"), /does not list Paseo agents.*paseo ls --json/is);
  assert.match(renderCommandHelp("insights"), /normal reindex preserves the origin secret/is);
  assert.match(renderCommandHelp("insights"), /sync initializes a missing index or incrementally applies/is);
  assert.match(renderCommandHelp("insights"), /status.*--verify.*full integrity/is);
  assert.match(renderCommandHelp("insights"), /fails closed without a TTY/is);
  assert.match(renderCommandHelp("insights"), /overview.*search.*capabilities.*usage.*activity.*evidence/is);
  assert.match(renderCommandHelp("insights"), /natural-language.*spec/is);
  assert.match(renderCommandHelp("insights"), /Queries require --format json/is);
  assert.match(renderInsightsActionHelp("query"), /threadshare insights query --request <file\|-> --format json/);
  assert.match(renderInsightsActionHelp("query"), /threadshare-insights-query-request@v2/);
  assert.match(renderInsightsActionHelp("spec"), /Users describe.*natural language/is);
  assert.match(renderInsightsActionHelp("spec"), /Agent chooses the protocol/is);
  assert.match(renderInsightsActionHelp("recipe"), /capability-contexts@1.*failure-chains@1/is);
  assert.match(renderInsightsActionHelp("evidence"), /target\.kind: event, turn, session, or attempt-chain/);
  assert.match(renderInsightsActionHelp("mcp"), /stdout is JSON-RPC only/);
  assert.match(renderInsightsActionHelp("status"), /does not start the Engine/is);
  assert.match(renderCommandHelp("publish"), /run `threadshare validate/);
  assert.match(renderCommandHelp("publish"), /revokeToken.*human mode.*stderr/is);
  assert.match(renderCommandHelp("share"), /revokeToken.*human mode.*stderr/is);
  assert.match(renderCommandHelp("read"), /rejects fragments such as #token=/);
  assert.match(renderCommandHelp("read"), /does not accept --url or read THREADSHARE_URL/);
  assert.match(renderCommandHelp("revoke"), /does not accept --url or read THREADSHARE_URL/);
});

test("prints the installed package version without touching local state", () => {
  const packageDocument = JSON.parse(readFileSync(
    new URL("../package.json", import.meta.url),
    "utf8",
  ));
  const result = spawnSync(process.execPath, [cli, "--version"], {
    encoding: "utf8",
    env: {
      ...process.env,
      CODEX_HOME: "/definitely/not/read",
      THREADSHARE_INSIGHTS_HOME: "/definitely/not/read",
    },
  });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stderr, "");
  assert.equal(result.stdout, `${packageDocument.version}\n`);

  const extra = spawnSync(process.execPath, [cli, "--version", "extra"], { encoding: "utf8" });
  assert.equal(extra.status, 1);
  assert.equal(extra.stdout, "");
  assert.match(extra.stderr, /TS_USAGE_UNEXPECTED_ARGUMENT/u);
});

test("renders action-specific Insights help without touching the index", () => {
  for (const action of ["status", "sync", "spec", "query", "recipe", "evidence", "mcp"]) {
    const result = spawnSync(process.execPath, [cli, "insights", action, "--help"], {
      encoding: "utf8",
      env: { ...process.env, THREADSHARE_INSIGHTS_HOME: "/definitely/not/read" },
    });
    assert.equal(result.status, 0, result.stderr);
    assert.equal(result.stderr, "");
    assert.equal(result.stdout, `${renderInsightsActionHelp(action)}\n`);
  }
});

test("prints root help without arguments and equivalent command help offline", () => {
  for (const args of [[], ["help"], ["--help"]]) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assert.equal(result.status, 0);
    assert.equal(result.stdout, `${renderRootHelp()}\n`);
    assert.match(result.stdout, /omit --from and --before for the full visible snapshot/);
    assert.equal(result.stderr, "");
  }

  for (const command of Object.keys(COMMAND_SPECS)) {
    const direct = spawnSync(process.execPath, [cli, command, "--help"], { encoding: "utf8" });
    const meta = spawnSync(process.execPath, [cli, "help", command], { encoding: "utf8" });
    assert.equal(direct.status, 0, direct.stderr);
    assert.equal(meta.status, 0, meta.stderr);
    assert.equal(direct.stdout, `${renderCommandHelp(command)}\n`);
    assert.equal(meta.stdout, direct.stdout);
    assert.equal(direct.stderr, "");
    assert.equal(meta.stderr, "");
  }

  const rescued = spawnSync(
    process.execPath,
    [cli, "share", "codex", "/definitely/missing.jsonl", "--bogus", "--json", "--help"],
    { encoding: "utf8" },
  );
  assert.equal(rescued.status, 0);
  assert.equal(rescued.stdout, `${renderCommandHelp("share")}\n`);
  assert.equal(rescued.stderr, "");
});

test("Insights query CLI rejects invalid automation input before touching raw sessions", async (t) => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-insights-query-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDirectory = path.join(directory, "state");
  const environment = {
    ...process.env,
    THREADSHARE_INSIGHTS_HOME: stateDirectory,
  };
  const run = (args, input) => spawnSync(process.execPath, [cli, ...args], {
    encoding: "utf8",
    env: environment,
    input,
  });

  assertDiagnosticCode(run(["insights", "overview"]), "TS_USAGE_OPTION_DEPENDENCY");
  assertDiagnosticCode(
    run(["insights", "overview", "--format", "json"]),
    "TS_INSIGHTS_NOT_INDEXED",
  );
  assertDiagnosticCode(
    run(["insights", "search", "--query", "界".repeat(3_000), "--format", "json"]),
    "TS_QUERY_TOO_LONG",
  );
  assertDiagnosticCode(
    run(["insights", "status", "--query", "ignored"]),
    "TS_USAGE_OPTION_NOT_ALLOWED",
  );

  await mkdir(stateDirectory, { recursive: true });
  await writeFile(path.join(stateDirectory, "insights.sqlite3"), "existing");
  await writeFile(path.join(stateDirectory, "origin-secret.json"), `${JSON.stringify({
    format: "threadshare-insights-origin-secret@v1",
    originSecretEpoch: "11111111-2222-4333-8444-555555555555",
    secret: Buffer.alloc(32, 4).toString("base64url"),
  })}\n`);
  assertDiagnosticCode(
    run(["insights", "activity", "--request", "-", "--format", "json"], "{bad"),
    "TS_INSIGHTS_REQUEST_INVALID",
  );
  assertDiagnosticCode(
    run([
      "insights", "capabilities", "tool", "--cursor", "tampered",
      "--format", "json",
    ]),
    "TS_INSIGHTS_CURSOR_STALE",
  );
});

test("sanitizes every diagnostic problem without damaging HTTP URLs", () => {
  const token = Buffer.alloc(32, 17).toString("base64url");
  const problem = sanitizeDiagnosticProblem(
    `Failed at /var/tmp/private/input.json, /workspace/output.json, C:\\Users\\alice\\secret.json, \\\\server\\share\\secret.json and file:///opt/private/data.json; POST https://threadshare.example.com/api/v1/shares --token ${token}`,
  );
  assert.doesNotMatch(problem, /var\/tmp|workspace|Users\\alice|server\\share|opt\/private/);
  assert.doesNotMatch(problem, new RegExp(token));
  assert.match(problem, /\[LOCAL_PATH\]/);
  assert.match(problem, /https:\/\/threadshare\.example\.com\/api\/v1\/shares/);

  const fallback = {
    status: 1,
    stdout: "",
    stderr: renderDiagnostic(new Error("Unexpected local failure")),
  };
  assertDiagnosticCode(fallback, "TS_OPERATION_FAILED");
  assert.match(fallback.stderr, /Next: Run `threadshare --help`/);

  for (const code of [
    "TS_QUERY_TOO_LONG",
    "TS_QUERY_TOO_BROAD",
    "TS_INSIGHTS_REQUEST_INVALID",
    "TS_INSIGHTS_NOT_INDEXED",
    "TS_INSIGHTS_QUERY_V2_NOT_READY",
    "TS_INSIGHTS_CURSOR_STALE",
    "TS_INSIGHTS_TURN_CHANGED",
    "TS_INSIGHTS_PAYLOAD_CHANGED",
    "TS_INSIGHTS_EVIDENCE_NOT_FOUND",
    "TS_INSIGHTS_COVERAGE_INCOMPLETE",
    "TS_INSIGHTS_ENGINE_STATUS_SKIPPED",
    "TS_INSIGHTS_ENGINE_TIMEOUT",
    "TS_INSIGHTS_ENGINE_DISCONNECTED",
    "TS_INSIGHTS_ENGINE_UNAVAILABLE",
    "TS_INSIGHTS_WRITER_LOCKED",
    "TS_INSIGHTS_ENGINE_INVALID",
    "TS_INSIGHTS_STORAGE_FAILED",
    "TS_INSIGHTS_STORAGE_CORRUPT",
    "TS_INSIGHTS_WAL_BACKPRESSURE",
    "TS_INSIGHTS_ORIGIN_SECRET_MISSING",
    "TS_INSIGHTS_ORIGIN_SECRET_INVALID",
    "TS_INSIGHTS_EXCLUSION_APPLY_FAILED",
    "TS_INSIGHTS_REINDEX_SPACE_REQUIRED",
    "TS_INSIGHTS_PROJECTION_SPACE_REQUIRED",
    "TS_INSIGHTS_REINDEX_RECOVERY_REQUIRED",
    "TS_INSIGHTS_REINDEX_INCOMPLETE",
    "TS_INSIGHTS_PURGE_PENDING",
  ]) {
    const reserved = {
      status: 1,
      stdout: "",
      stderr: renderDiagnostic(cliDiagnostic(code, "Reserved Insights diagnostic", {
        command: "analyze",
      })),
    };
    assertDiagnosticCode(reserved, code);
  }
});

test("returns deterministic help diagnostics that tell agents how to recover", () => {
  const scenarios = [
    {
      args: ["bogus", "--help"],
      code: "TS_USAGE_UNKNOWN_COMMAND",
      next: /Choose one of: sessions, analyze, insights, messages, export, publish, share, read, revoke, validate/,
    },
    {
      args: ["help", "bogus"],
      code: "TS_USAGE_UNKNOWN_COMMAND",
      next: /threadshare --help/,
    },
    {
      args: ["help", "share", "extra"],
      code: "TS_USAGE_UNEXPECTED_ARGUMENT",
      next: /threadshare help share/,
    },
    {
      args: ["help", "--json"],
      code: "TS_USAGE_OPTION_NOT_ALLOWED",
      next: /threadshare help --help/,
    },
    {
      args: ["--bogus"],
      code: "TS_USAGE_UNKNOWN_OPTION",
      next: /threadshare --help/,
    },
    {
      args: ["--json"],
      code: "TS_USAGE_MISSING_ARGUMENT",
      next: /threadshare --help/,
    },
    {
      args: ["sessions", "paseo"],
      code: "TS_USAGE_INVALID_VALUE",
      next: /paseo ls --json/,
    },
    {
      args: ["sessions", "codex", "--json"],
      code: "TS_USAGE_OPTION_NOT_ALLOWED",
      next: /--format json/,
    },
  ];
  for (const { args, code, next } of scenarios) {
    const result = spawnSync(process.execPath, [cli, ...args], { encoding: "utf8" });
    assertDiagnosticCode(result, code);
    assert.match(result.stderr, /\nProblem: .+\n/);
    assert.match(result.stderr, /\nUsage: threadshare /);
    assert.match(result.stderr, /\nNext: .+\n$/);
    assert.match(result.stderr, next);
  }
});

test("does not expose input paths when a command fails", () => {
  const missing = path.join(os.tmpdir(), "threadshare-private", "missing-history.json");
  const result = spawnSync(process.execPath, [cli, "validate", missing], { encoding: "utf8" });
  assert.equal(result.status, 1);
  assertDiagnosticCode(result, "TS_INPUT_READ_FAILED");
  assert.match(result.stderr, /Problem: Unable to read the input file\./);
  assert.match(result.stderr, /Usage: threadshare validate <history-file\|->/);
  assert.match(result.stderr, /Next: Check that the input file exists and is readable/);
  assert.doesNotMatch(result.stderr, new RegExp(missing.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));
  assert.doesNotMatch(result.stderr, /threadshare-private|missing-history\.json/);
});

test("keeps docs concise and the bundled Skill aligned with the agent workflow", () => {
  const exhaustiveUsageBlock = /```(?:text)?\r?\n(?:(?:threadshare (?:sessions|analyze|messages|export|publish|share|read|revoke|validate)[^\n]*\r?\n)){4,}/;
  for (const fileName of ["README.md", "README.zh-CN.md"]) {
    const document = readFileSync(path.join(root, fileName), "utf8");
    assert.match(document, /threadshare <command> --help/);
    assert.doesNotMatch(document, exhaustiveUsageBlock);
  }
  const skill = readFileSync(path.join(root, "skills", "threadshare", "SKILL.md"), "utf8");
  assert.match(skill, /Treat `threadshare <command> --help` as the canonical parameter reference/);
  assert.match(skill, /TS_PUBLISH_OUTCOME_UNKNOWN.*TS_PUBLISH_POLICY_UNCONFIRMED/);
  assert.match(skill, /sessions <codex\|claude> --format json/);
  assert.match(skill, /analyze <codex\|claude> <session> --format json/);
  assert.match(skill, /local-only, calls no external model/);
  assert.match(skill, /Do not assume the newest result is the requested session/);
  assert.match(skill, /messages <provider> <session> --format json/);
  assert.match(skill, /--before <original-boundary-id> --offset <next-offset>/);
  assert.match(
    skill,
    /--from <selected-message-id> --before <original-boundary-id> --json/,
  );
  assert.match(skill, /Show the user numbered candidate previews without IDs/);
  assert.match(skill, /must not use interactive `--pick-start` or `--from last-user`/);
});

test("lists ten user-message candidates and loads an older page as one-line JSON", async () => {
  const fixture = await createCliSession();
  try {
    const first = spawnSync(
      process.execPath,
      [cli, "messages", "codex", fixture.file, "--format", "json"],
      { encoding: "utf8" },
    );
    assert.equal(first.status, 0, first.stderr);
    assert.equal(first.stderr, "");
    assert.equal(first.stdout.split("\n").length, 2);
    const firstPage = JSON.parse(first.stdout);
    assert.equal(firstPage.boundaryId, "cli-user-13");
    assert.equal(firstPage.messages.length, 10);
    assert.equal(firstPage.messages[0].id, "cli-user-12");
    assert.equal(firstPage.messages[9].id, "cli-user-3");
    assert.equal(firstPage.nextOffset, 10);

    const second = spawnSync(
      process.execPath,
      [
        cli,
        "messages",
        "codex",
        fixture.file,
        "--format",
        "json",
        "--before",
        firstPage.boundaryId,
        "--offset",
        String(firstPage.nextOffset),
      ],
      { encoding: "utf8" },
    );
    assert.equal(second.status, 0, second.stderr);
    assert.deepEqual(
      JSON.parse(second.stdout).messages.map((message) => message.id),
      ["cli-user-2", "cli-user-1"],
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("analyzes a native session as a human summary or one-line JSON", async () => {
  const fixture = await createCliSession(codexCliJsonl(2), "analysis.jsonl");
  const claudeId = "11111111-2222-4333-8444-555555555555";
  const claude = await createCliSession(
    [
      JSON.stringify({
        type: "user",
        uuid: "claude-analysis-user",
        sessionId: claudeId,
        timestamp: "2026-07-31T00:00:01.000Z",
        message: { role: "user", content: "Claude request" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "claude-analysis-assistant",
        sessionId: claudeId,
        timestamp: "2026-07-31T00:00:02.000Z",
        message: { role: "assistant", content: "Claude answer" },
      }),
    ].join("\n") + "\n",
    `${claudeId}.jsonl`,
  );
  try {
    const textResult = spawnSync(
      process.execPath,
      [cli, "analyze", "codex", fixture.file],
      { encoding: "utf8" },
    );
    assert.equal(textResult.status, 0, textResult.stderr);
    assert.equal(textResult.stderr, "");
    assert.match(textResult.stdout, /^Session codex [a-f0-9]{64}\n/);
    assert.match(textResult.stdout, /01 \[hard-sealed\] User: CLI request 1/);
    assert.match(textResult.stdout, /Assistant: CLI answer 1/);

    const jsonResult = spawnSync(
      process.execPath,
      [cli, "analyze", "codex", fixture.file, "--format", "json"],
      { encoding: "utf8" },
    );
    assert.equal(jsonResult.status, 0, jsonResult.stderr);
    assert.equal(jsonResult.stderr, "");
    assert.equal(jsonResult.stdout.split("\n").length, 2);
    const report = JSON.parse(jsonResult.stdout);
    assert.equal(report.format, "threadshare-session-analysis@v1");
    assert.equal(report.session.provider, "codex");
    assert.equal(report.turns.length, 2);
    assert.equal(report.turns[0].problemText, "CLI request 1");
    assert.equal(report.turns[0].finalAnswerExcerpt, "CLI answer 1");
    assert.doesNotMatch(jsonResult.stdout, /sourceLocator|inputFingerprint|originFingerprint/);
    assert.doesNotMatch(jsonResult.stdout, new RegExp(fixture.directory.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")));

    const claudeResult = spawnSync(
      process.execPath,
      [cli, "analyze", "claude", claude.file, "--format", "json"],
      { encoding: "utf8" },
    );
    assert.equal(claudeResult.status, 0, claudeResult.stderr);
    const claudeReport = JSON.parse(claudeResult.stdout);
    assert.equal(claudeReport.session.provider, "claude");
    assert.equal(claudeReport.turns[0].problemText, "Claude request");
    assert.equal(claudeReport.turns[0].finalAnswerExcerpt, "Claude answer");
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
    await rm(claude.directory, { recursive: true, force: true });
  }
});

test("exports a selected Codex and Claude range while preserving full-export compatibility", async () => {
  const codex = await createCliSession(codexCliJsonl(5), "codex.jsonl");
  const claude = await createCliSession(
    [
      JSON.stringify({ type: "user", uuid: "claude-user-1", message: { role: "user", content: "One" } }),
      JSON.stringify({ type: "assistant", uuid: "claude-assistant-1", message: { role: "assistant", content: "Answer one" } }),
      JSON.stringify({ type: "user", uuid: "claude-user-2", message: { role: "user", content: "Two" } }),
      JSON.stringify({ type: "assistant", uuid: "claude-assistant-2", message: { role: "assistant", content: "Answer two" } }),
      JSON.stringify({ type: "user", uuid: "claude-user-3", message: { role: "user", content: "Share" } }),
    ].join("\n"),
    "claude.jsonl",
  );
  try {
    const selectedCodex = spawnSync(
      process.execPath,
      [
        cli,
        "export",
        "codex",
        codex.file,
        "--from",
        "cli-user-3",
        "--before",
        "cli-user-5",
      ],
      { encoding: "utf8" },
    );
    assert.equal(selectedCodex.status, 0, selectedCodex.stderr);
    assert.deepEqual(
      JSON.parse(selectedCodex.stdout).entries.map((entry) => entry.id),
      ["cli-user-3", "cli-assistant-3", "cli-user-4", "cli-assistant-4"],
    );

    const fullCodex = spawnSync(process.execPath, [cli, "export", "codex", codex.file], {
      encoding: "utf8",
    });
    assert.equal(fullCodex.status, 0, fullCodex.stderr);
    assert.equal(JSON.parse(fullCodex.stdout).entries.length, 10);

    const selectedClaude = spawnSync(
      process.execPath,
      [
        cli,
        "export",
        "claude",
        claude.file,
        "--from",
        "claude-user-2",
        "--before",
        "claude-user-3",
      ],
      { encoding: "utf8" },
    );
    assert.equal(selectedClaude.status, 0, selectedClaude.stderr);
    assert.deepEqual(
      JSON.parse(selectedClaude.stdout).entries.map((entry) => entry.id),
      ["claude-user-2", "claude-assistant-2"],
    );
  } finally {
    await rm(codex.directory, { recursive: true, force: true });
    await rm(claude.directory, { recursive: true, force: true });
  }
});

test("publishes only the selected range and keeps share JSON output stable", async () => {
  const fixture = await createCliSession(codexCliJsonl(3));
  let received;
  const server = http.createServer((request, response) => {
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      received = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      response.writeHead(200, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "11111111-2222-4333-8444-555555555555" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await execFileAsync(
      process.execPath,
      [
        cli,
        "share",
        "codex",
        fixture.file,
        "--from",
        "cli-user-1",
        "--before",
        "cli-user-2",
        "--url",
        serviceUrl,
        "--json",
      ],
      { encoding: "utf8" },
    );
    assert.equal(result.stderr, "");
    assert.equal(result.stdout.split("\n").length, 2);
    assert.deepEqual(JSON.parse(result.stdout), {
      id: "11111111-2222-4333-8444-555555555555",
      url: `${serviceUrl}/?id=11111111-2222-4333-8444-555555555555`,
    });
    assert.deepEqual(
      received.entries.map((entry) => entry.id),
      ["cli-user-1", "cli-assistant-1"],
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("publishes a strict duration and reports the server-confirmed expiration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-expires-"));
  const file = path.join(directory, "history.json");
  await writeFile(file, JSON.stringify(canonicalHistory()));
  let receivedExpiresIn;
  const expiresAt = "2026-08-08T10:00:00.000Z";
  const server = http.createServer((request, response) => {
    receivedExpiresIn = request.headers["x-threadshare-expires-in"];
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", expiresAt }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await execFileAsync(
      process.execPath,
      [cli, "publish", file, "--expires", "7d", "--url", serviceUrl, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(receivedExpiresIn, "604800");
    assert.deepEqual(JSON.parse(result.stdout), {
      id: "11111111-2222-4333-8444-555555555555",
      url: `${serviceUrl}/?id=11111111-2222-4333-8444-555555555555`,
      expiresAt,
    });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when the server does not confirm a requested expiration", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-expires-missing-"));
  const file = path.join(directory, "history.json");
  await writeFile(file, JSON.stringify(canonicalHistory()));
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "11111111-2222-4333-8444-555555555555" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cli, "publish", file, "--expires", "1h", "--url", serviceUrl, "--json"],
        { encoding: "utf8" },
      ),
      (error) => {
        assertDiagnosticCode(error, "TS_PUBLISH_POLICY_UNCONFIRMED");
        assert.match(
          error.stderr,
          /server did not confirm the requested expiration; the share may have been created without expiration/,
        );
        assert.match(
          error.stderr,
          /requested expiration was not confirmed; revocation was not requested/,
        );
        assert.match(
          error.stderr,
          new RegExp(
            `Result: Share was created at ${serviceUrl.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\/\\?id=11111111-2222-4333-8444-555555555555`,
          ),
        );
        assert.match(error.stderr, /Next: Do not publish again/);
        return true;
      },
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("shares a revocable session without sending or storing the raw capability", async () => {
  const fixture = await createCliSession(codexCliJsonl(1));
  let receivedDigest;
  let receivedBody;
  const server = http.createServer((request, response) => {
    receivedDigest = request.headers["x-threadshare-revoke-token-sha256"];
    const chunks = [];
    request.on("data", (chunk) => chunks.push(chunk));
    request.on("end", () => {
      receivedBody = Buffer.concat(chunks).toString("utf8");
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", revocable: true }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await execFileAsync(
      process.execPath,
      [cli, "share", "codex", fixture.file, "--revoke", "--url", serviceUrl, "--json"],
      { encoding: "utf8" },
    );
    const payload = JSON.parse(result.stdout);
    assert.match(payload.revokeToken, /^[A-Za-z0-9_-]{43}$/);
    assert.equal(
      receivedDigest,
      createHash("sha256").update(payload.revokeToken).digest("base64url"),
    );
    assert.doesNotMatch(receivedBody, new RegExp(payload.revokeToken));
    assert.deepEqual(Object.keys(payload).sort(), ["id", "revokeToken", "url"]);
    assert.equal(result.stdout.split("\n").length, 2);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("prints a one-time revoke command to stderr while keeping human stdout stable", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-revoke-human-"));
  const file = path.join(directory, "history.json");
  await writeFile(file, JSON.stringify(canonicalHistory()));
  let receivedDigest;
  const server = http.createServer((request, response) => {
    receivedDigest = request.headers["x-threadshare-revoke-token-sha256"];
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", revocable: true }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    const result = await execFileAsync(
      process.execPath,
      [cli, "publish", file, "--revoke", "--url", serviceUrl],
      { encoding: "utf8" },
    );
    const url = `${serviceUrl}/?id=11111111-2222-4333-8444-555555555555`;
    assert.equal(result.stdout, `${url}\n`);
    const match = /^Revoke: threadshare revoke '([^']+)' --token '([A-Za-z0-9_-]{43})'\n$/.exec(
      result.stderr,
    );
    assert.ok(match);
    assert.equal(match[1], url);
    assert.equal(receivedDigest, createHash("sha256").update(match[2]).digest("base64url"));
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("fails closed when the server does not confirm requested revocation", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-revoke-missing-"));
  const file = path.join(directory, "history.json");
  await writeFile(file, JSON.stringify(canonicalHistory()));
  const server = http.createServer((request, response) => {
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "11111111-2222-4333-8444-555555555555" }));
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cli, "publish", file, "--revoke", "--url", serviceUrl, "--json"],
        { encoding: "utf8" },
      ),
      (error) => {
        assertDiagnosticCode(error, "TS_PUBLISH_POLICY_UNCONFIRMED");
        assert.match(
          error.stderr,
          /server did not confirm revocation; the share may have been created without revocation/,
        );
        assert.match(
          error.stderr,
          /expiration was not requested; requested revocation was not confirmed/,
        );
        assert.match(error.stderr, /Result: Share was created at http:\/\/127\.0\.0\.1:/);
        assert.match(error.stderr, /Next: Do not publish again/);
        assert.doesNotMatch(error.stderr, /--token [A-Za-z0-9_-]{43}|Revoke:/);
        return true;
      },
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("preserves a confirmed cleanup capability when another requested policy is unconfirmed", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-policy-partial-"));
  const file = path.join(directory, "history.json");
  await writeFile(file, JSON.stringify(canonicalHistory()));
  let receivedDigest;
  const server = http.createServer((request, response) => {
    receivedDigest = request.headers["x-threadshare-revoke-token-sha256"];
    request.resume();
    request.on("end", () => {
      response.writeHead(201, { "content-type": "application/json" });
      response.end(
        JSON.stringify({ id: "11111111-2222-4333-8444-555555555555", revocable: true }),
      );
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cli, "publish", file, "--expires", "1h", "--revoke", "--url", serviceUrl, "--json"],
        { encoding: "utf8" },
      ),
      (error) => {
        assertDiagnosticCode(error, "TS_PUBLISH_POLICY_UNCONFIRMED");
        assert.match(
          error.stderr,
          /requested expiration was not confirmed; requested revocation was confirmed/,
        );
        const match = /Revoke \(secret, shown once; do not log\): threadshare revoke '([^']+)' --token '([A-Za-z0-9_-]{43})'/.exec(
          error.stderr,
        );
        assert.ok(match);
        assert.equal(receivedDigest, createHash("sha256").update(match[2]).digest("base64url"));
        assert.match(error.stderr, /Next: Do not publish again; revoke the created share now/);
        return true;
      },
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("classifies rejected, uncertain, redirected, and contradictory publish responses", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-publish-errors-"));
  const file = path.join(directory, "history.json");
  await writeFile(file, JSON.stringify(canonicalHistory()));
  const responses = [
    { status: 400, body: { error: "invalid upload" } },
    { status: 429, body: { error: "rate limited" } },
    { status: 503, body: { error: "temporarily unavailable" } },
    { status: 200, body: { id: "not-a-canonical-share-id" } },
    {
      status: 201,
      body: {
        id: "11111111-2222-4333-8444-555555555555",
        expiresAt: "2026-08-08T10:00:00.000Z",
      },
    },
    { status: 307, location: "/redirect-target" },
  ];
  let responseIndex = 0;
  let redirectTargetHits = 0;
  const server = http.createServer((request, response) => {
    if (request.url === "/redirect-target") {
      redirectTargetHits += 1;
      response.writeHead(201, { "content-type": "application/json" });
      response.end(JSON.stringify({ id: "22222222-3333-4444-8555-666666666666" }));
      return;
    }
    const planned = responses[responseIndex++];
    request.resume();
    request.on("end", () => {
      response.writeHead(planned.status, {
        ...(planned.body ? { "content-type": "application/json" } : {}),
        ...(planned.location ? { location: planned.location } : {}),
      });
      response.end(planned.body ? JSON.stringify(planned.body) : undefined);
    });
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;
  const expectedCodes = [
    "TS_PUBLISH_REJECTED",
    "TS_PUBLISH_OUTCOME_UNKNOWN",
    "TS_PUBLISH_OUTCOME_UNKNOWN",
    "TS_PUBLISH_OUTCOME_UNKNOWN",
    "TS_PUBLISH_POLICY_UNCONFIRMED",
    "TS_PUBLISH_OUTCOME_UNKNOWN",
  ];

  try {
    for (const expectedCode of expectedCodes) {
      await assert.rejects(
        execFileAsync(
          process.execPath,
          [cli, "publish", file, "--url", serviceUrl, "--json"],
          { encoding: "utf8" },
        ),
        (error) => {
          assertDiagnosticCode(error, expectedCode);
          if (expectedCode === "TS_PUBLISH_REJECTED") {
            assert.match(error.stderr, /Correct the rejected request, then retry/);
          } else if (expectedCode === "TS_PUBLISH_OUTCOME_UNKNOWN") {
            assert.match(error.stderr, /Do not publish again automatically/);
          } else {
            assert.match(error.stderr, /unexpected expiration/);
            assert.match(error.stderr, /Result: Share was created at/);
          }
          return true;
        },
      );
    }
    assert.equal(responseIndex, responses.length);
    assert.equal(redirectTargetHits, 0);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
    await rm(directory, { recursive: true, force: true });
  }
});

test("diagnoses an invalid THREADSHARE_URL without exposing its value", () => {
  const environmentValue = "ftp://credential-user-9f31:private-token@example.invalid/private-path";
  const result = spawnSync(
    process.execPath,
    [cli, "share", "codex", "/not/read.jsonl", "--dry-run"],
    {
      encoding: "utf8",
      env: { ...process.env, THREADSHARE_URL: environmentValue },
    },
  );
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /^threadshare: error TS_USAGE_INVALID_VALUE\n/);
  assert.match(result.stderr, /Problem: THREADSHARE_URL must use HTTP or HTTPS\./);
  assert.match(result.stderr, /Next: Unset or correct THREADSHARE_URL/);
  assert.doesNotMatch(
    result.stderr,
    /credential-user-9f31|private-token|private-path|example\.invalid/,
  );
});

test("revokes a normalized share URL with bearer authorization", async () => {
  const token = Buffer.alloc(32, 21).toString("base64url");
  let received;
  const server = http.createServer((request, response) => {
    received = { method: request.method, path: request.url, authorization: request.headers.authorization };
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const id = "11111111-2222-4333-8444-555555555555";
  const serviceUrl = `http://127.0.0.1:${address.port}`;
  const viewerUrl = `${serviceUrl}/?id=${id}`;

  try {
    const result = await execFileAsync(
      process.execPath,
      [cli, "revoke", `${viewerUrl}#message-user-1`, "--token", token, "--json"],
      { encoding: "utf8" },
    );
    assert.deepEqual(received, {
      method: "DELETE",
      path: `/api/v1/shares/${id}`,
      authorization: `Bearer ${token}`,
    });
    assert.deepEqual(JSON.parse(result.stdout), { id, url: viewerUrl, revoked: true });
    assert.equal(result.stdout.split("\n").length, 2);
    assert.equal(result.stderr, "");
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("revokes with a valid capability that starts with an option prefix", async () => {
  const tokenBytes = Buffer.alloc(32);
  tokenBytes[0] = 0xfb;
  tokenBytes[1] = 0xe0;
  const token = tokenBytes.toString("base64url");
  assert.match(token, /^--/);

  let authorization;
  const server = http.createServer((request, response) => {
    authorization = request.headers.authorization;
    response.writeHead(204);
    response.end();
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const id = "11111111-2222-4333-8444-555555555555";
  const viewerUrl = `http://127.0.0.1:${address.port}/?id=${id}`;

  try {
    const result = await execFileAsync(
      process.execPath,
      [cli, "revoke", viewerUrl, "--token", token, "--json"],
      { encoding: "utf8" },
    );
    assert.equal(authorization, `Bearer ${token}`);
    assert.deepEqual(JSON.parse(result.stdout), { id, url: viewerUrl, revoked: true });
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("returns a stable diagnostic when a revoke request fails", async () => {
  const token = Buffer.alloc(32, 23).toString("base64url");
  const server = http.createServer((request, response) => {
    request.resume();
    response.writeHead(404, { "content-type": "application/json" });
    response.end(JSON.stringify({ error: "not found" }));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const viewerUrl = `http://127.0.0.1:${address.port}/?id=11111111-2222-4333-8444-555555555555`;

  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cli, "revoke", viewerUrl, "--token", token, "--json"],
        { encoding: "utf8" },
      ),
      (error) => {
        assertDiagnosticCode(error, "TS_SHARE_REVOKE_FAILED");
        assert.match(error.stderr, /404 intentionally does not identify which check failed/);
        assert.doesNotMatch(error.stderr, new RegExp(token));
        return true;
      },
    );
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("reads Viewer and API URLs as compact Agent text, JSON, or full Markdown without redirects", async () => {
  const id = "11111111-2222-4333-8444-555555555555";
  const redirectId = "22222222-3333-4444-8555-666666666666";
  const targetId = "33333333-4444-4555-8666-777777777777";
  const history = canonicalHistory();
  history.entries = [
    {
      id: "read-user",
      createdAt: "2026-07-30T00:00:01.000Z",
      kind: "message",
      role: "user",
      markdown: "Read this request",
    },
    {
      id: "read-activity",
      createdAt: "2026-07-30T00:00:02.000Z",
      kind: "activity",
      message: "Read activity",
      level: "success",
    },
  ];
  const paths = [];
  let redirectTargetHits = 0;
  const server = http.createServer((request, response) => {
    paths.push(request.url);
    if (request.url === `/api/v1/shares/${redirectId}`) {
      response.writeHead(302, { location: `/api/v1/shares/${targetId}` });
      response.end();
      return;
    }
    if (request.url === `/api/v1/shares/${targetId}`) redirectTargetHits += 1;
    response.writeHead(200, { "content-type": "application/json" });
    response.end(JSON.stringify(history));
  });
  await new Promise((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  assert.ok(address && typeof address === "object");
  const serviceUrl = `http://127.0.0.1:${address.port}`;

  try {
    const json = await execFileAsync(
      process.execPath,
      [cli, "read", `${serviceUrl}/?id=${id}#message-read-user`, "--format", "json"],
      { encoding: "utf8" },
    );
    assert.deepEqual(JSON.parse(json.stdout), history);
    assert.equal(json.stdout.split("\n").length, 2);
    assert.equal(json.stderr, "");

    const markdown = await execFileAsync(
      process.execPath,
      [cli, "read", `${serviceUrl}/api/v1/shares/${id}`, "--format", "markdown"],
      { encoding: "utf8" },
    );
    assert.match(markdown.stdout, /# CLI test/);
    assert.ok(markdown.stdout.indexOf("Read this request") < markdown.stdout.indexOf("Read activity"));
    assert.equal(markdown.stderr, "");

    const agent = await execFileAsync(
      process.execPath,
      [cli, "read", `${serviceUrl}/?id=${id}`],
      { encoding: "utf8" },
    );
    assert.match(agent.stdout, /^# Threadshare Agent Transcript v1$/m);
    assert.match(agent.stdout, /^## User$/m);
    assert.match(agent.stdout, /^> Read this request$/m);
    assert.match(agent.stdout, /omitted 1 internal entry/);
    assert.doesNotMatch(agent.stdout, /Read activity/);
    assert.equal(agent.stderr, "");

    const explicitAgent = await execFileAsync(
      process.execPath,
      [cli, "read", `${serviceUrl}/?id=${id}&format=agent`, "--format", "agent"],
      { encoding: "utf8" },
    );
    assert.equal(explicitAgent.stdout, agent.stdout);
    assert.equal(explicitAgent.stderr, "");

    await assert.rejects(
      execFileAsync(
        process.execPath,
        [cli, "read", `${serviceUrl}/?id=${redirectId}`, "--format", "json"],
        { encoding: "utf8" },
      ),
      (error) => {
        assertDiagnosticCode(error, "TS_SHARE_READ_FAILED");
        assert.match(error.stderr, /read request failed/i);
        return true;
      },
    );
    assert.equal(redirectTargetHits, 0);
    assert.deepEqual(paths, [
      `/api/v1/shares/${id}`,
      `/api/v1/shares/${id}`,
      `/api/v1/shares/${id}`,
      `/api/v1/shares/${id}`,
      `/api/v1/shares/${redirectId}`,
    ]);
  } finally {
    await new Promise((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve())),
    );
  }
});

test("dry-runs Codex and Claude shares with safe aggregate reports and no network", async () => {
  const codex = await createCliSession(codexCliJsonl(3), "codex-dry-run.jsonl");
  const claude = await createCliSession(
    [
      JSON.stringify({
        type: "user",
        uuid: "claude-dry-user",
        timestamp: "2026-07-31T00:00:01.000Z",
        message: { role: "user", content: "api_key: claude-dry-secret" },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "claude-dry-assistant",
        timestamp: "2026-07-31T00:00:02.000Z",
        message: { role: "assistant", content: "Claude dry answer" },
      }),
    ].join("\n"),
    "claude-dry-run.jsonl",
  );
  const unreachableService = "http://127.0.0.1:1";

  try {
    const codexResult = await execFileAsync(
      process.execPath,
      [
        cli,
        "share",
        "codex",
        codex.file,
        "--from",
        "cli-user-2",
        "--before",
        "cli-user-3",
        "--dry-run",
        "--report",
        "--expires",
        "2h",
        "--revoke",
        "--url",
        unreachableService,
        "--json",
      ],
      { encoding: "utf8" },
    );
    const codexPayload = JSON.parse(codexResult.stdout);
    assert.equal(codexResult.stderr, "");
    assert.equal(codexResult.stdout.split("\n").length, 2);
    assert.equal(codexPayload.dryRun, true);
    assert.equal(codexPayload.valid, true);
    assert.deepEqual(codexPayload.intent, { expiresInSeconds: 7200, revoke: true });
    assert.deepEqual(codexPayload.report.entryKinds, {
      message: 2,
      tool: 0,
      thought: 0,
      todo: 0,
      activity: 0,
      compaction: 0,
    });
    assert.deepEqual(codexPayload.report.messageRoles, { user: 1, assistant: 1 });
    assert.equal(codexPayload.report.userTurns, 1);
    assert.equal(codexPayload.report.redactionMarkers, 0);
    assert.equal(Object.hasOwn(codexPayload, "id"), false);
    assert.equal(Object.hasOwn(codexPayload, "url"), false);
    assert.equal(Object.hasOwn(codexPayload, "revokeToken"), false);

    const claudeResult = await execFileAsync(
      process.execPath,
      [
        cli,
        "share",
        "claude",
        claude.file,
        "--dry-run",
        "--report",
        "--url",
        unreachableService,
        "--json",
      ],
      { encoding: "utf8" },
    );
    const claudePayload = JSON.parse(claudeResult.stdout);
    assert.equal(claudePayload.valid, true);
    assert.deepEqual(claudePayload.intent, { expiresInSeconds: null, revoke: false });
    assert.deepEqual(claudePayload.report.messageRoles, { user: 1, assistant: 1 });
    assert.ok(claudePayload.report.redactionMarkers >= 1);
    assert.doesNotMatch(claudeResult.stdout, /claude-dry-secret|Claude dry answer/);

    const human = await execFileAsync(
      process.execPath,
      [cli, "share", "codex", codex.file, "--dry-run", "--report", "--url", unreachableService],
      { encoding: "utf8" },
    );
    assert.equal(human.stderr, "");
    assert.match(human.stdout, /Dry run: valid/);
    assert.match(human.stdout, /No data was uploaded/);
    assert.match(human.stdout, /Entries:/);
    assert.match(human.stdout, /User turns:/);
    assert.doesNotMatch(human.stdout, /CLI request|CLI answer|codex-dry-run|threadshare-cli-range/);
  } finally {
    await rm(codex.directory, { recursive: true, force: true });
    await rm(claude.directory, { recursive: true, force: true });
  }
});

test("returns a machine-readable invalid dry run for an oversized export", async () => {
  const raw = [
    JSON.stringify({
      type: "session_meta",
      timestamp: "2026-07-31T00:00:00.000Z",
      payload: { session_id: "oversized-dry-run" },
    }),
    JSON.stringify({
      type: "response_item",
      timestamp: "2026-07-31T00:00:01.000Z",
      payload: {
        type: "message",
        id: "oversized-user",
        role: "user",
        content: [{ type: "input_text", text: "x".repeat(CHAT_SHARE_MAX_BYTES) }],
      },
    }),
  ].join("\n");
  const fixture = await createCliSession(raw, "oversized-dry-run.jsonl");
  try {
    await assert.rejects(
      execFileAsync(
        process.execPath,
        [
          cli,
          "share",
          "codex",
          fixture.file,
          "--dry-run",
          "--report",
          "--revoke",
          "--url",
          "http://127.0.0.1:1",
          "--json",
        ],
        { encoding: "utf8" },
      ),
      (error) => {
        assert.equal(error.code, 1);
        assert.equal(error.stderr, "");
        const payload = JSON.parse(error.stdout);
        assert.equal(payload.dryRun, true);
        assert.equal(payload.valid, false);
        assert.match(payload.error, /5 MiB/);
        assert.ok(payload.report.bytes > payload.report.limitBytes);
        assert.deepEqual(payload.intent, { expiresInSeconds: null, revoke: true });
        assert.equal(Object.hasOwn(payload, "revokeToken"), false);
        return true;
      },
    );
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("rejects unsafe command option combinations before exporting or publishing", async () => {
  const fixture = await createCliSession(codexCliJsonl(2));
  const scenarios = [
    {
      args: ["analyze", "paseo", fixture.file],
      code: "TS_USAGE_INVALID_VALUE",
      expected: /analyze provider must be codex or claude/,
    },
    {
      args: ["analyze", "codex", fixture.file, "--format", "yaml"],
      code: "TS_USAGE_INVALID_VALUE",
      expected: /--format must be text or json/,
    },
    {
      args: ["analyze", "codex", fixture.file, "--json"],
      code: "TS_USAGE_OPTION_NOT_ALLOWED",
      expected: /--json is not valid for analyze/,
    },
    {
      args: ["messages", "codex", fixture.file],
      code: "TS_USAGE_OPTION_DEPENDENCY",
      expected: /messages requires --format json/,
    },
    {
      args: ["messages", "codex", fixture.file, "--format", "json", "--json"],
      code: "TS_USAGE_OPTION_NOT_ALLOWED",
      expected: /--json is not valid for messages/,
    },
    {
      args: ["messages", "codex", fixture.file, "--format", "json", "--url", "https://example.invalid"],
      code: "TS_USAGE_OPTION_NOT_ALLOWED",
      expected: /--url is not valid for messages/,
    },
    {
      args: ["share", "codex", fixture.file, "--limit", "1"],
      code: "TS_USAGE_OPTION_NOT_ALLOWED",
      expected: /--limit is not valid for share/,
    },
    {
      args: ["share", "codex", fixture.file, "--form", "cli-user-1"],
      code: "TS_USAGE_UNKNOWN_OPTION",
      expected: /Unknown option: --form/,
    },
    {
      args: ["share", "codex", fixture.file, "--from"],
      code: "TS_USAGE_MISSING_VALUE",
      expected: /A non-empty value is required for --from/,
    },
    {
      args: ["share", "codex", fixture.file, "--from", ""],
      code: "TS_USAGE_MISSING_VALUE",
      expected: /A non-empty value is required for --from/,
    },
    {
      args: ["share", "codex", fixture.file, "--expires", "0m"],
      code: "TS_USAGE_INVALID_VALUE",
      expected: /--expires must be a duration from 1m to 365d using m, h, or d/,
    },
    {
      args: ["share", "codex", fixture.file, "--expires", "366d"],
      code: "TS_USAGE_INVALID_VALUE",
      expected: /--expires must be a duration from 1m to 365d using m, h, or d/,
    },
    {
      args: ["share", "codex", fixture.file, "--expires", "60s"],
      code: "TS_USAGE_INVALID_VALUE",
      expected: /--expires must be a duration from 1m to 365d using m, h, or d/,
    },
    {
      args: [
        "revoke",
        "https://threadshare.invalid/?id=11111111-2222-4333-8444-555555555555&token=secret",
        "--token",
        Buffer.alloc(32, 1).toString("base64url"),
      ],
      code: "TS_SHARE_URL_INVALID",
      expected: /valid Threadshare Viewer or API URL/,
    },
    {
      args: [
        "revoke",
        "https://threadshare.invalid/?id=11111111-2222-4333-8444-555555555555",
        "--token",
        "short",
      ],
      code: "TS_USAGE_INVALID_VALUE",
      expected: /The revoke capability must be a 256-bit base64url value/,
    },
    {
      args: [
        "read",
        "https://threadshare.invalid/?id=11111111-2222-4333-8444-555555555555",
        "--format",
        "yaml",
      ],
      code: "TS_USAGE_INVALID_VALUE",
      expected: /read format must be agent, json, or markdown/,
    },
    {
      args: [
        "read",
        "https://threadshare.invalid/?id=11111111-2222-4333-8444-555555555555#token=secret",
        "--format",
        "json",
      ],
      code: "TS_SHARE_URL_INVALID",
      expected: /valid Threadshare Viewer or API URL/,
    },
    {
      args: ["share", "codex", fixture.file, "--report"],
      code: "TS_USAGE_OPTION_DEPENDENCY",
      expected: /--report requires --dry-run/,
    },
    {
      args: ["share", "codex", fixture.file, "--pick-start", "--from", "cli-user-1"],
      code: "TS_USAGE_OPTION_CONFLICT",
      expected: /--pick-start cannot be combined with --from or --before/,
    },
    {
      args: ["publish", fixture.file, "--dry-run"],
      code: "TS_USAGE_OPTION_NOT_ALLOWED",
      expected: /--dry-run is not valid for publish/,
    },
    {
      args: ["messages", "codex", fixture.file, "--format", "json", "--format", "json"],
      code: "TS_USAGE_DUPLICATE_OPTION",
      expected: /Duplicate option --format/,
    },
    {
      args: ["messages", "codex", fixture.file, "extra", "--format", "json"],
      code: "TS_USAGE_UNEXPECTED_ARGUMENT",
      expected: /Unexpected positional argument/,
    },
    {
      args: ["messages", "codex", fixture.file, "--format", "json", "--limit", "0"],
      code: "TS_USAGE_INVALID_VALUE",
      expected: /--limit must be an integer from 1 to 50/,
    },
    {
      args: ["messages", "codex", fixture.file, "--format", "json", "--offset", "-1"],
      code: "TS_USAGE_INVALID_VALUE",
      expected: /--offset must be a non-negative safe integer/,
    },
  ];

  try {
    for (const scenario of scenarios) {
      const result = spawnSync(process.execPath, [cli, ...scenario.args], { encoding: "utf8" });
      assertDiagnosticCode(result, scenario.code);
      assert.match(result.stderr, scenario.expected);
    }
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("keeps session, range, output, and provider diagnostic classifications stable", async () => {
  const sandbox = await mkdtemp(path.join(os.tmpdir(), "threadshare-cli-diagnostic-codes-"));
  const codexHome = path.join(sandbox, "codex-home");
  const sessions = path.join(codexHome, "sessions");
  const validSession = path.join(sandbox, "valid.jsonl");
  const missingSessionFile = path.join(sandbox, "missing.jsonl");
  const environment = { ...process.env, CODEX_HOME: codexHome };

  try {
    await mkdir(sessions, { recursive: true });
    await writeFile(validSession, codexCliJsonl(2));

    const notFound = spawnSync(process.execPath, [cli, "export", "codex", "missing-id"], {
      encoding: "utf8",
      env: environment,
    });
    assertDiagnosticCode(notFound, "TS_SESSION_NOT_FOUND");

    await writeFile(path.join(sessions, "rollout-shared-prefix-a.jsonl"), "");
    await writeFile(path.join(sessions, "rollout-shared-prefix-b.jsonl"), "");
    const ambiguous = spawnSync(
      process.execPath,
      [cli, "export", "codex", "shared-prefix"],
      { encoding: "utf8", env: environment },
    );
    assertDiagnosticCode(ambiguous, "TS_SESSION_AMBIGUOUS");

    const inaccessible = spawnSync(
      process.execPath,
      [cli, "export", "codex", missingSessionFile],
      { encoding: "utf8", env: environment },
    );
    assertDiagnosticCode(inaccessible, "TS_SESSION_ACCESS_FAILED");
    assert.doesNotMatch(inaccessible.stderr, /threadshare-cli-diagnostic-codes|missing\.jsonl/);

    const missingBoundary = spawnSync(
      process.execPath,
      [cli, "export", "codex", validSession, "--from", "missing-user"],
      { encoding: "utf8", env: environment },
    );
    assertDiagnosticCode(missingBoundary, "TS_RANGE_BOUNDARY_NOT_FOUND");

    const invalidRange = spawnSync(
      process.execPath,
      [
        cli,
        "export",
        "codex",
        validSession,
        "--from",
        "cli-user-2",
        "--before",
        "cli-user-1",
      ],
      { encoding: "utf8", env: environment },
    );
    assertDiagnosticCode(invalidRange, "TS_RANGE_INVALID");

    const outputFailure = spawnSync(
      process.execPath,
      [cli, "export", "codex", validSession, "--output", sandbox],
      { encoding: "utf8", env: environment },
    );
    assertDiagnosticCode(outputFailure, "TS_OUTPUT_WRITE_FAILED");

    const fakeBin = path.join(sandbox, "bin");
    const fakePaseo = path.join(fakeBin, "paseo");
    await mkdir(fakeBin);
    await writeFile(fakePaseo, "#!/bin/sh\nprintf '%s\\n' 'daemon unavailable' >&2\nexit 1\n");
    await chmod(fakePaseo, 0o755);
    const providerUnavailable = spawnSync(
      process.execPath,
      [cli, "export", "paseo", "11111111-2222-4333-8444-555555555555"],
      { encoding: "utf8", env: { ...process.env, PATH: fakeBin } },
    );
    assertDiagnosticCode(providerUnavailable, "TS_PROVIDER_UNAVAILABLE");
  } finally {
    await rm(sandbox, { recursive: true, force: true });
  }
});

test("rejects interactive selection outside a TTY without publishing", async () => {
  const fixture = await createCliSession(codexCliJsonl(2));
  try {
    const result = spawnSync(
      process.execPath,
      [cli, "share", "codex", fixture.file, "--pick-start"],
      { encoding: "utf8" },
    );
    assertDiagnosticCode(result, "TS_TTY_REQUIRED");
    assert.match(result.stderr, /--pick-start requires an interactive terminal/);
  } finally {
    await rm(fixture.directory, { recursive: true, force: true });
  }
});

test("validates a canonical history from stdin", () => {
  const result = spawnSync(
    process.execPath,
    [path.join(root, "bin/threadshare.mjs"), "validate", "-"],
    { encoding: "utf8", input: JSON.stringify(canonicalHistory()) },
  );

  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "Valid threadshare-history@v1\n");
  assert.equal(result.stderr, "");
});

test("rejects invalid JSON from stdin with a stable diagnostic", () => {
  const result = spawnSync(process.execPath, [cli, "validate", "-"], {
    encoding: "utf8",
    input: "{not-json",
  });
  assertDiagnosticCode(result, "TS_INPUT_INVALID_JSON");
  assert.match(result.stderr, /Fix the JSON syntax/);
});

test("rejects a malformed canonical history from stdin", () => {
  const invalid = {
    format: "threadshare-history@v1",
    schemaVersion: 1,
    conversation: {},
    entries: [{ kind: "bogus" }],
    extra: true,
  };
  const result = spawnSync(
    process.execPath,
    [path.join(root, "bin/threadshare.mjs"), "validate", "-"],
    { encoding: "utf8", input: JSON.stringify(invalid) },
  );

  assertDiagnosticCode(result, "TS_INPUT_SCHEMA_INVALID");
  assert.match(
    result.stderr,
    /Input is not a valid threadshare-history@v1 document at document root: must have required property 'exportedAt'/,
  );
});

test("finds Codex Cloud sessions below CODEX_HOME", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "threadshare-codex-home-"));
  const previousCodexHome = process.env.CODEX_HOME;
  try {
    const sessions = path.join(codexHome, "sessions", "2026", "07", "30");
    await mkdir(sessions, { recursive: true });
    const sessionFile = path.join(sessions, "rollout-cloud-session-123.jsonl");
    await writeFile(sessionFile, "");
    process.env.CODEX_HOME = codexHome;

    assert.equal(await resolveSessionFile("codex", "cloud-session-123"), sessionFile);
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME;
    else process.env.CODEX_HOME = previousCodexHome;
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("extracts the canonical UUID from a timestamped Codex rollout filename", async () => {
  const codexHome = await mkdtemp(path.join(os.tmpdir(), "threadshare-codex-uuid-"));
  const sessionId = "019f6e08-8538-7423-a293-7f553379f212";
  try {
    const sessions = path.join(codexHome, "sessions", "2026", "07", "31");
    await mkdir(sessions, { recursive: true });
    await writeFile(
      path.join(sessions, `rollout-2026-07-31T11-04-40-${sessionId}.jsonl`),
      `${JSON.stringify({
        type: "session_meta",
        timestamp: "2026-07-31T11:04:40.000Z",
        payload: { cwd: "/fixture" },
      })}\n`,
    );

    const history = await exportSessionById("codex", sessionId, {
      environment: { ...process.env, CODEX_HOME: codexHome },
    });
    assert.equal(history.conversation.id, sessionId);
  } finally {
    await rm(codexHome, { recursive: true, force: true });
  }
});

test("exports Codex messages and tool calls without session metadata", () => {
  const history = exportCodexJsonl(
    [
      JSON.stringify({ type: "session_meta", timestamp: "2026-07-30T00:00:00.000Z", payload: { session_id: "codex-1" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:00.500Z", payload: { type: "message", role: "developer", content: [{ type: "input_text", text: "RAW SYSTEM PROMPT" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:00.750Z", payload: { type: "message", id: "injected-agents", role: "user", content: [{ type: "input_text", text: "# AGENTS.md instructions for /private/workspace\n\n<INSTRUCTIONS>RAW AGENT INSTRUCTIONS</INSTRUCTIONS>" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:01.000Z", payload: { type: "message", id: "user-1", role: "user", content: [{ type: "input_text", text: "Review this" }] } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:02.000Z", payload: { type: "function_call", call_id: "call-1", name: "read_file", arguments: "{\"path\":\"README.md\",\"authorization\":\"Bearer secret-token\"}" } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:02.500Z", payload: { type: "function_call_output", call_id: "call-1", output: "README contents", error: null } }),
      JSON.stringify({ type: "response_item", timestamp: "2026-07-30T00:00:03.000Z", payload: { type: "message", id: "assistant-1", role: "assistant", content: [{ type: "output_text", text: "Done" }] } }),
    ].join("\n"),
    { exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  assert.equal(history.format, "threadshare-history@v1");
  assert.equal(history.exportedAt, "2026-07-30T01:00:00.000Z");
  assert.deepEqual(history.conversation, { id: "codex-1", title: "Codex session", provider: "codex", source: "codex" });
  assert.deepEqual(history.entries.map((entry) => entry.kind), ["message", "tool", "message"]);
  assert.deepEqual(history.entries[1].input, { path: "README.md", authorization: "[REDACTED]" });
  assert.equal(history.entries[1].status, "completed");
  assert.equal(history.entries[1].output, "README contents");
  assert.doesNotMatch(
    JSON.stringify(history),
    /secret-token|RAW SYSTEM PROMPT|RAW AGENT INSTRUCTIONS/,
  );
});

test("uses the actual export time instead of the session creation time", () => {
  const before = Date.now();
  const history = exportCodexJsonl(
    JSON.stringify({
      type: "session_meta",
      timestamp: "2020-01-01T00:00:00.000Z",
      payload: { session_id: "old-session" },
    }),
  );
  const after = Date.now();

  const exportedAt = Date.parse(history.exportedAt);
  assert.ok(exportedAt >= before && exportedAt <= after);
  assert.notEqual(history.exportedAt, "2020-01-01T00:00:00.000Z");
});

test("exports Claude blocks in order while omitting metadata and recording tool failure", () => {
  const history = exportClaudeJsonl(
    [
      JSON.stringify({ type: "user", isMeta: true, uuid: "meta-1", timestamp: "2026-07-30T00:00:00.000Z", message: { role: "user", content: "RAW SYSTEM REMINDER" } }),
      JSON.stringify({ type: "user", isCompactSummary: true, uuid: "compact-1", timestamp: "2026-07-30T00:00:00.500Z", message: { role: "user", content: "RAW COMPACTION SUMMARY" } }),
      JSON.stringify({ type: "user", uuid: "command-1", timestamp: "2026-07-30T00:00:00.750Z", message: { role: "user", content: "<command-name>RAW COMMAND METADATA</command-name>" } }),
      JSON.stringify({ type: "user", uuid: "user-1", timestamp: "2026-07-30T00:00:01.000Z", message: { role: "user", content: "Implement it" } }),
      JSON.stringify({ type: "assistant", uuid: "assistant-1", timestamp: "2026-07-30T00:00:02.000Z", message: { role: "assistant", content: [{ type: "thinking", thinking: "Plan" }, { type: "text", text: "Before" }, { type: "tool_use", id: "tool-1", name: "Read", input: { file_path: "README.md", apiKey: "sk-secret-key" } }, { type: "text", text: "After" }] } }),
      JSON.stringify({ type: "user", uuid: "result-1", timestamp: "2026-07-30T00:00:03.000Z", message: { role: "user", content: [{ type: "tool_result", tool_use_id: "tool-1", is_error: true, content: "request failed" }] } }),
    ].join("\n"),
    { sessionId: "claude-1", exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  assert.equal(history.conversation.id, "claude-1");
  assert.equal(history.exportedAt, "2026-07-30T01:00:00.000Z");
  assert.deepEqual(history.entries.map((entry) => entry.kind), ["message", "thought", "message", "tool", "message"]);
  assert.equal(history.entries[2].markdown, "Before");
  assert.equal(history.entries[4].markdown, "After");
  assert.deepEqual(history.entries[3].input, { file_path: "README.md", apiKey: "[REDACTED]" });
  assert.equal(history.entries[3].status, "failed");
  assert.equal(history.entries[3].error, "request failed");
  assert.doesNotMatch(
    JSON.stringify(history),
    /sk-secret-key|RAW SYSTEM REMINDER|RAW COMPACTION SUMMARY|RAW COMMAND METADATA/,
  );
});

test("keeps exported entry IDs unique and links Codex tool results by item ID", () => {
  const history = exportCodexJsonl(
    [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-30T00:00:01.000Z",
        payload: {
          type: "message",
          id: "reasoning-1",
          role: "assistant",
          content: [{ type: "reasoning", text: "Only thought" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-30T00:00:02.000Z",
        payload: { type: "function_call", id: "tool-by-id", name: "lookup", arguments: "{}" },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-30T00:00:03.000Z",
        payload: { type: "function_call_output", id: "tool-by-id", output: "found" },
      }),
    ].join("\n"),
    { exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  assert.equal(new Set(history.entries.map((entry) => entry.id)).size, history.entries.length);
  assert.deepEqual(history.entries.map((entry) => entry.kind), ["thought", "tool"]);
  assert.equal(history.entries[1].status, "completed");
  assert.equal(history.entries[1].output, "found");
});

test("exports Codex reasoning summaries and custom tool activity", () => {
  const history = exportCodexJsonl(
    [
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-30T00:00:01.000Z",
        payload: {
          type: "reasoning",
          id: "reasoning-top",
          summary: [{ type: "summary_text", text: "Visible plan" }],
          content: [{ type: "reasoning_text", text: "RAW PRIVATE REASONING" }],
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-30T00:00:02.000Z",
        payload: {
          type: "custom_tool_call",
          call_id: "custom-call",
          name: "shell",
          input: '{"command":"pwd"}',
        },
      }),
      JSON.stringify({
        type: "response_item",
        timestamp: "2026-07-30T00:00:03.000Z",
        payload: { type: "custom_tool_call_output", call_id: "custom-call", output: "/workspace" },
      }),
    ].join("\n"),
    { exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  assert.deepEqual(history.entries.map((entry) => entry.kind), ["thought", "tool"]);
  assert.equal(history.entries[0].text, "Visible plan");
  assert.equal(history.entries[1].status, "completed");
  assert.deepEqual(history.entries[1].input, { command: "pwd" });
  assert.equal(history.entries[1].output, "/workspace");
  assert.doesNotMatch(JSON.stringify(history), /RAW PRIVATE REASONING/);
});

test("redacts common credentials embedded in visible text", () => {
  const jwt = "eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.signature123";
  const revokeToken = Buffer.alloc(32, 31).toString("base64url");
  const jsonRevokeToken = Buffer.alloc(32, 32).toString("base64url");
  const history = exportClaudeJsonl(
    JSON.stringify({
      type: "user",
      uuid: "user-secrets",
      timestamp: "2026-07-30T00:00:01.000Z",
      message: {
        role: "user",
        content: `token: "two words" ${jwt} postgres://alice:database-password@db.invalid/app Basic dTpw Bearer abc12345 Bearer AbCdEfGhIjKlMnOp sk-secret-key ghp_1234567890\nthreadshare revoke 'https://threadshare.invalid/?id=11111111-2222-4333-8444-555555555555' --token '${revokeToken}'\n{"revokeToken":"${jsonRevokeToken}"}\nBasic authentication by a ghostwriter near a skyscraper. Bearer authentication is standardized. Explain bearer authorization headers.\nAuthorization: Bearer authentication\nAuthorization: Token auth-scheme-secret\nBearer a1b2c3\nBearer middleware validates requests.\nBearer ABCDEFGHIJKLMNOP expires tomorrow.\nThe Bearer middleware validates HTTP requests.\n- Bearer middleware validates HTTP requests.\nBearer authentication.\nAuthorization: Signature keyId="client",algorithm="hmac",signature="opaque-signature-secret"\nauth=inline-auth-secret status=ok\nBearer a1b2c3.`,
      },
    }),
    { exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  const toolHistory = exportCodexJsonl(
    [
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call",
          call_id: "secret-tool",
          name: "lookup",
          arguments: JSON.stringify({
            AWS_SECRET_ACCESS_KEY: "aws-secret-value",
            cookie: "session=private-cookie",
            credentials: "plural-credential-value",
            cookies: "plural-cookie-value",
            secrets: "plural-secret-value",
            auth: "auth-value",
            accessKey: "access-key-value",
            passwordHash: "password-hash-value",
            authHeader: "auth-header-value",
            tokenCount: 42,
            input_tokens: 100,
            maxTokens: 200,
            authorizationStatus: "enabled",
          }),
        },
      }),
      JSON.stringify({
        type: "response_item",
        payload: {
          type: "function_call_output",
          call_id: "secret-tool",
          output:
            '{"snowflake":9007199254740993,"precise":0.12345678901234567890,"password":"hunter2","credential":"opaque-value","secrets":"plural-secrets-output","passwords":"plural-passwords-output","tokens":"plural-tokens-output","apiKeys":"plural-api-keys-output","auths":"plural-auths-output"}',
        },
      }),
    ].join("\n"),
    { exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  const claudeToolHistory = exportClaudeJsonl(
    [
      JSON.stringify({
        type: "assistant",
        uuid: "claude-secret-tool",
        message: {
          role: "assistant",
          content: [{ type: "tool_use", id: "claude-secret-call", name: "lookup", input: {} }],
        },
      }),
      JSON.stringify({
        type: "user",
        uuid: "claude-secret-result",
        message: {
          role: "user",
          content: [
            {
              type: "tool_result",
              tool_use_id: "claude-secret-call",
              content:
                '{"snowflake":9007199254740995,"precise":0.98765432109876543210,"credentials":"claude-credentials-output","cookies":"claude-cookies-output"}',
            },
          ],
        },
      }),
    ].join("\n"),
    { exportedAt: "2026-07-30T01:00:00.000Z" },
  );

  assert.equal(toolHistory.entries[0].input.credentials, "[REDACTED]");
  assert.equal(toolHistory.entries[0].input.tokenCount, 42);
  assert.equal(toolHistory.entries[0].input.input_tokens, 100);
  assert.equal(toolHistory.entries[0].input.maxTokens, 200);
  assert.equal(toolHistory.entries[0].input.authorizationStatus, "enabled");
  assert.equal(
    toolHistory.entries[0].output,
    '{"snowflake":9007199254740993,"precise":0.12345678901234567890,"password":"[REDACTED]","credential":"[REDACTED]","secrets":"[REDACTED]","passwords":"[REDACTED]","tokens":"[REDACTED]","apiKeys":"[REDACTED]","auths":"[REDACTED]"}',
  );
  assert.equal(
    claudeToolHistory.entries[0].output,
    '{"snowflake":9007199254740995,"precise":0.98765432109876543210,"credentials":"[REDACTED]","cookies":"[REDACTED]"}',
  );

  const exported = JSON.stringify([history, toolHistory, claudeToolHistory]);
  assert.match(
    history.entries[0].markdown,
    /Basic authentication by a ghostwriter near a skyscraper\. Bearer authentication is standardized\. Explain bearer authorization headers\.\nAuthorization: \[REDACTED\]\nAuthorization: \[REDACTED\]\nBearer \[REDACTED\]\nBearer middleware validates requests\.\nBearer \[REDACTED\] expires tomorrow\.\nThe Bearer middleware validates HTTP requests\.\n- Bearer middleware validates HTTP requests\.\nBearer authentication\.\nAuthorization: \[REDACTED\]\nauth=\[REDACTED\] status=ok\nBearer \[REDACTED\]\.$/,
  );
  assert.doesNotMatch(
    exported,
    /two words|signature123|database-password|dTpw|abc12345|AbCdEfGhIjKlMnOp|sk-secret-key|ghp_1234567890|auth-scheme-secret|a1b2c3|ABCDEFGHIJKLMNOP|opaque-signature-secret|inline-auth-secret/,
  );
  assert.doesNotMatch(exported, /hunter2|opaque-value/);
  assert.doesNotMatch(exported, /aws-secret-value|private-cookie/);
  assert.doesNotMatch(
    exported,
    /plural-credential-value|plural-cookie-value|plural-secret-value|auth-value/,
  );
  assert.doesNotMatch(exported, /access-key-value|password-hash-value|auth-header-value/);
  assert.doesNotMatch(
    exported,
    /plural-secrets-output|plural-passwords-output|plural-tokens-output|plural-api-keys-output|plural-auths-output|claude-credentials-output|claude-cookies-output/,
  );
  assert.doesNotMatch(exported, new RegExp(`${revokeToken}|${jsonRevokeToken}`));
});
