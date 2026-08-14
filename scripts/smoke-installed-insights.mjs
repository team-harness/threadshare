#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const ROOT_PACKAGE = "@team-harness/threadshare";
const SMOKE_ORIGIN_SECRET_EPOCH = "11111111-2222-4333-8444-555555555555";
const execFile = promisify(execFileCallback);
const AGENT_QUERY_FORMATS = Object.freeze([
  "threadshare-insights-agent-spec@v1",
  "threadshare-insights-overview@v1",
  "threadshare-insights-search-request@v1",
  "threadshare-insights-search@v1",
  "threadshare-insights-capabilities@v1",
  "threadshare-insights-usage-request@v1",
  "threadshare-insights-usage@v1",
  "threadshare-insights-activity-request@v1",
  "threadshare-insights-activity@v1",
  "threadshare-insights-evidence@v1",
]);

function schemaFilename(format) {
  return `${format.replace("@v1", ".v1")}.schema.json`;
}

async function loadInstalledSchemaValidators(rootDirectory) {
  const requireFromRoot = createRequire(path.join(rootDirectory, "package.json"));
  const [{ default: Ajv2020 }, { default: addFormats }] = await Promise.all([
    import(pathToFileURL(requireFromRoot.resolve("ajv/dist/2020.js")).href),
    import(pathToFileURL(requireFromRoot.resolve("ajv-formats")).href),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  return new Map(await Promise.all(AGENT_QUERY_FORMATS.map(async (format) => {
    const document = JSON.parse(await readFile(
      path.join(rootDirectory, "schema", schemaFilename(format)),
      "utf8",
    ));
    return [format, ajv.compile(document)];
  })));
}

async function runInstalledQuery(rootDirectory, stateDirectory, arguments_) {
  const { stdout, stderr } = await execFile(
    process.execPath,
    [path.join(rootDirectory, "bin", "threadshare.mjs"), ...arguments_],
    {
      cwd: rootDirectory,
      env: { ...process.env, THREADSHARE_INSIGHTS_HOME: stateDirectory },
      maxBuffer: 4 * 1024 * 1024,
      timeout: 30_000,
    },
  );
  if (stderr !== "") throw new Error(`installed Insights query wrote stderr: ${stderr.trim()}`);
  const trimmed = stdout.trim();
  if (trimmed.length === 0 || trimmed.includes("\n")) {
    throw new Error("installed Insights query must emit exactly one JSON line");
  }
  return JSON.parse(trimmed);
}

function validateInstalledQuery(validators, value) {
  const validate = validators.get(value?.format);
  if (!validate || !validate(value)) {
    const detail = validate?.errors?.map((item) => `${item.instancePath} ${item.message}`).join("; ");
    throw new Error(`installed Insights query returned invalid ${value?.format ?? "output"}: ${detail}`);
  }
}

export async function smokeInstalledAgentQueries({
  rootDirectory,
  createInsightsEngineClient,
  protocol,
  runtimeOptions = undefined,
}) {
  const stateDirectory = await mkdtemp(path.join(os.tmpdir(), "threadshare-agent-insights-smoke-"));
  try {
    await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(stateDirectory, "origin-secret.json"), `${JSON.stringify({
      format: "threadshare-insights-origin-secret@v1",
      originSecretEpoch: SMOKE_ORIGIN_SECRET_EPOCH,
      secret: Buffer.alloc(32, 7).toString("base64url"),
    })}\n`, { mode: 0o600 });
    const fixture = JSON.parse(await readFile(
      new URL("../test/fixtures/insights-fact-mutations/v1-basic.json", import.meta.url),
      "utf8",
    ));
    const { assertSessionFactsDeltaV2, canonicalJson, hashKey } = await import(
      pathToFileURL(path.join(rootDirectory, "src", "session-facts.mjs")).href
    );
    const delta = structuredClone(fixture.initial);
    delta.format = "session-facts-delta@v2";
    delta.factSchemaVersion = 2;
    delta.providerAdapterVersion = "codex@2";
    delta.privacyPolicyVersion = 2;
    delta.historyEvents = [];
    delta.historyPayloads = [];
    delta.historyPayloadChunks = [];
    const mutation = structuredClone(delta);
    delete mutation.deltaId;
    const mutationDigest = createHash("sha256").update(canonicalJson(mutation)).digest();
    delta.deltaId = hashKey(
      "delta",
      Buffer.from(delta.session.sessionKey, "hex"),
      delta.expectedGeneration,
      delta.mode,
      delta.originSecretEpoch,
      String(delta.duplicatePolicyVersion),
      mutationDigest,
      delta.checkpoint.completeOffset,
    );
    const client = await createInsightsEngineClient({
      databasePath: path.join(stateDirectory, "insights.sqlite3"),
      requiredContract: protocol.createInsightsRequiredContract(SMOKE_ORIGIN_SECRET_EPOCH),
      runtimeOptions,
      timeoutMs: 10_000,
      commitTimeoutMs: 30_000,
    });
    try {
      await client.applySessionFacts(assertSessionFactsDeltaV2(delta));
    } finally {
      await client.close();
    }

    const validators = await loadInstalledSchemaValidators(rootDirectory);
    const usageRequest = path.join(stateDirectory, "usage-request.json");
    const activityRequest = path.join(stateDirectory, "activity-request.json");
    await Promise.all([
      writeFile(usageRequest, `${JSON.stringify({
        format: "threadshare-insights-usage-request@v1",
        window: {
          observedAtOrAfter: "2026-08-10T00:00:00.000Z",
          observedBefore: "2026-08-11T00:00:00.000Z",
        },
        orderBy: "recorded-invocation-count",
        limit: 5,
      })}\n`),
      writeFile(activityRequest, `${JSON.stringify({
        format: "threadshare-insights-activity-request@v1",
        window: {
          observedAtOrAfter: "2026-08-10T00:00:00.000Z",
          observedBefore: "2026-08-11T00:00:00.000Z",
        },
        bucket: "day",
      })}\n`),
    ]);

    const outputs = [];
    outputs.push(await runInstalledQuery(rootDirectory, stateDirectory,
      ["insights", "spec", "--format", "json"]));
    outputs.push(await runInstalledQuery(rootDirectory, stateDirectory,
      ["insights", "overview", "--format", "json"]));
    outputs.push(await runInstalledQuery(rootDirectory, stateDirectory,
      ["insights", "capabilities", "tool", "--limit", "5", "--format", "json"]));
    const search = await runInstalledQuery(rootDirectory, stateDirectory,
      ["insights", "search", "--query", "normalized fact store", "--limit", "5", "--format", "json"]);
    outputs.push(search);
    outputs.push(await runInstalledQuery(rootDirectory, stateDirectory,
      ["insights", "usage", "tool", "--request", usageRequest, "--format", "json"]));
    outputs.push(await runInstalledQuery(rootDirectory, stateDirectory,
      ["insights", "activity", "--request", activityRequest, "--format", "json"]));
    const firstResult = search.results?.[0];
    if (!firstResult?.turnKey || !firstResult?.revision) {
      throw new Error("installed Insights search did not return an evidence target");
    }
    outputs.push(await runInstalledQuery(rootDirectory, stateDirectory, [
      "insights", "evidence", firstResult.turnKey, "--revision", firstResult.revision,
      "--limit", "5", "--format", "json",
    ]));
    for (const output of outputs) validateInstalledQuery(validators, output);
    return { queryCount: outputs.length, schemaCount: validators.size };
  } finally {
    await rm(stateDirectory, { recursive: true, force: true });
  }
}

export async function smokeInstalledInsights({
  prefix,
  version,
  runtimeOptions = undefined,
  runAgentQuerySmoke = smokeInstalledAgentQueries,
}) {
  const scopeDirectory = path.join(path.resolve(prefix), "node_modules", "@team-harness");
  const rootDirectory = path.join(scopeDirectory, "threadshare");
  const packageDocument = JSON.parse(await readFile(path.join(rootDirectory, "package.json"), "utf8"));
  if (packageDocument.name !== ROOT_PACKAGE || packageDocument.version !== version) {
    throw new Error("installed Threadshare package identity is invalid");
  }
  const platformPackages = (await readdir(scopeDirectory))
    .filter((name) => name.startsWith("threadshare-") && name !== "threadshare");
  if (platformPackages.length !== 1) {
    throw new Error("consumer install must resolve exactly one platform Insights Engine");
  }
  const [{ createInsightsEngineClient }, runtime, protocol] = await Promise.all([
    import(pathToFileURL(path.join(rootDirectory, "src", "insights-engine-client.mjs")).href),
    import(pathToFileURL(path.join(rootDirectory, "src", "insights-engine-runtime.mjs")).href),
    import(pathToFileURL(path.join(rootDirectory, "src", "insights-engine-protocol.mjs")).href),
  ]);
  const target = runtime.insightsEngineTarget();
  if (
    !target ||
    platformPackages[0] !== runtime.insightsEnginePackageName(target.target).split("/").at(-1)
  ) {
    throw new Error("consumer install resolved the wrong platform Insights Engine");
  }
  const client = await createInsightsEngineClient({
    requiredContract: protocol.createInsightsRequiredContract(SMOKE_ORIGIN_SECRET_EPOCH),
    runtimeOptions,
    timeoutMs: 5_000,
  });
  await client.close();
  const agentQueries = await runAgentQuerySmoke({
    rootDirectory,
    createInsightsEngineClient,
    protocol,
    runtimeOptions,
  });
  return { packageName: packageDocument.name, target: target.target, version, agentQueries };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--prefix", "--version"]).has(key) || !value) {
      throw new Error("Usage: smoke-installed-insights --prefix <dir> --version <semver>");
    }
    options[key.slice(2)] = value;
  }
  if (!options.prefix || !options.version) {
    throw new Error("installed Insights smoke requires --prefix and --version");
  }
  return options;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  smokeInstalledInsights(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
