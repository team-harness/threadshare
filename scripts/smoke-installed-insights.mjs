#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { createHash } from "node:crypto";
import { readFile, readdir, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { createRequire } from "node:module";
import { PassThrough, Readable } from "node:stream";
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
  "threadshare-insights-query-request@v2",
  "threadshare-insights-query@v2",
  "threadshare-insights-recipe-request@v1",
  "threadshare-insights-recipe@v1",
  "threadshare-insights-evidence-request@v2",
  "threadshare-insights-evidence@v2",
  "threadshare-insights-delivery-trace-request@v1",
  "threadshare-insights-delivery-trace@v1",
  "threadshare-insights-git-diff-evidence-request@v1",
  "threadshare-insights-git-diff-evidence@v1",
  "threadshare-insights-continuation-context@v1",
]);

function schemaFilename(format) {
  return `${format.replace(/@v([0-9]+)$/u, ".v$1")}.schema.json`;
}

async function loadInstalledSchemaValidators(rootDirectory) {
  const requireFromRoot = createRequire(path.join(rootDirectory, "package.json"));
  const [{ default: Ajv2020 }, { default: addFormats }] = await Promise.all([
    import(pathToFileURL(requireFromRoot.resolve("ajv/dist/2020.js")).href),
    import(pathToFileURL(requireFromRoot.resolve("ajv-formats")).href),
  ]);
  const ajv = new Ajv2020({ allErrors: true, strict: true });
  addFormats(ajv);
  const documents = await Promise.all(AGENT_QUERY_FORMATS.map(async (format) => ({
    format,
    document: JSON.parse(await readFile(
      path.join(rootDirectory, "schema", schemaFilename(format)),
      "utf8",
    )),
  })));
  for (const { document } of documents) ajv.addSchema(document);
  return new Map(documents.map(({ format, document }) => [format, ajv.getSchema(document.$id)]));
}

function traceSourceDelta({ canonicalJson, protocol }) {
  const value = {
    format: "threadshare-insights-trace-source-delta@v1",
    expectedGeneration: "0",
    targetGeneration: "1",
    repository: {
      repositoryId: "11111111-1111-4111-8111-111111111111",
      repositoryKey: "1".repeat(64),
      available: true,
      refDigest: "2".repeat(64),
      scmProvider: "github",
      webBaseUrl: "https://github.com",
      repositoryPath: "team-harness/threadshare",
    },
    refs: [{ name: "refs/heads/main", objectId: "a".repeat(40) }],
    commits: [{
      objectId: "a".repeat(40),
      parentObjectIds: [],
      authorTimestamp: "2026-08-16T00:00:00.000Z",
      committerTimestamp: "2026-08-16T00:00:00.000Z",
      treeObjectId: "b".repeat(40),
      summary: "installed Delivery Trace smoke",
      files: [{
        path: "src/insights-query.mjs",
        oldPath: null,
        status: "A",
        additions: "1",
        deletions: "0",
      }],
    }],
  };
  return {
    ...value,
    deltaId: createHash("sha256")
      .update(canonicalJson(protocol.traceSourceDigestDocument(value)))
      .digest("hex"),
  };
}

async function runInstalledMcp(rootDirectory, messages, queryOptions) {
  const { createInsightsMcpServer } = await import(
    pathToFileURL(path.join(rootDirectory, "src", "insights-mcp.mjs")).href
  );
  const output = new PassThrough();
  let text = "";
  output.setEncoding("utf8");
  output.on("data", (chunk) => { text += chunk; });
  await createInsightsMcpServer({ queryOptions }).run({
    input: Readable.from(messages.map((message) => `${JSON.stringify(message)}\n`)),
    output,
  });
  return text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
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
      await client.commitTraceSourceDelta(traceSourceDelta({ canonicalJson, protocol }));
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

    const commitKey = hashKey(
      "git-commit",
      Buffer.from("1".repeat(64), "hex"),
      "a".repeat(40),
    );
    const queryRequest = {
      format: "threadshare-insights-query-request@v2",
      resource: "event",
      where: null,
      shape: { kind: "records", select: ["eventKey"], payloadMode: "reference" },
      orderBy: [
        { field: "observedAt", direction: "desc" },
        { field: "eventKey", direction: "asc" },
      ],
      limit: 1,
      cursor: null,
      count: "exact",
    };
    const recipeRequest = {
      format: "threadshare-insights-recipe-request@v1",
      window: null,
      root: { kind: "git-commit", key: commitKey },
      direction: "outgoing",
      maxDepth: 1,
      includeCandidateEdges: false,
      includeContextualEdges: false,
      limit: 10,
      cursor: null,
    };
    validateInstalledQuery(validators, queryRequest);
    validateInstalledQuery(validators, recipeRequest);
    const { resolveInsightsPaths } = await import(
      pathToFileURL(path.join(rootDirectory, "src", "insights-paths.mjs")).href
    );
    const queryOptions = {
      runtimeOptions,
      stateOptions: {
        paths: resolveInsightsPaths({
          environment: { ...process.env, THREADSHARE_INSIGHTS_HOME: stateDirectory },
        }),
      },
    };
    const firstMcp = await runInstalledMcp(rootDirectory, [
      { jsonrpc: "2.0", id: 1, method: "tools/list", params: {} },
      {
        jsonrpc: "2.0", id: 2, method: "tools/call",
        params: { name: "threadshare_insights_spec", arguments: {} },
      },
      {
        jsonrpc: "2.0", id: 3, method: "tools/call",
        params: { name: "threadshare_insights_query", arguments: queryRequest },
      },
      {
        jsonrpc: "2.0", id: 4, method: "tools/call",
        params: {
          name: "threadshare_insights_recipe",
          arguments: { name: "delivery-trace@1", request: recipeRequest },
        },
      },
    ], queryOptions);
    const byId = new Map(firstMcp.map((message) => [message.id, message]));
    const toolNames = byId.get(1)?.result?.tools?.map(({ name }) => name);
    if (JSON.stringify(toolNames) !== JSON.stringify([
      "threadshare_insights_spec",
      "threadshare_insights_query",
      "threadshare_insights_recipe",
      "threadshare_insights_evidence",
    ])) {
      throw new Error("installed Insights MCP tool catalog is incomplete");
    }
    const mcpOutputs = [2, 3, 4].map((id) => {
      const result = byId.get(id)?.result;
      if (result?.isError !== false) {
        throw new Error(
          `installed Insights MCP tool ${id} failed: ${result?.structuredContent?.code ?? "missing response"}`,
        );
      }
      validateInstalledQuery(validators, result.structuredContent);
      return result.structuredContent;
    });
    const trace = mcpOutputs[2];
    const commit = trace.nodes.find((node) => node.kind === "git-commit" && node.key === commitKey);
    if (!commit) throw new Error("installed Delivery Trace recipe did not return its root commit");
    const evidenceRequest = {
      format: "threadshare-insights-evidence-request@v2",
      target: {
        kind: "delivery-node",
        nodeKind: commit.kind,
        nodeKey: commit.key,
        revision: commit.revision,
      },
      include: ["envelope"],
      cursor: null,
      maxBytes: 4096,
    };
    validateInstalledQuery(validators, evidenceRequest);
    const evidenceMcp = await runInstalledMcp(rootDirectory, [{
      jsonrpc: "2.0", id: 5, method: "tools/call",
      params: { name: "threadshare_insights_evidence", arguments: evidenceRequest },
    }], queryOptions);
    const evidence = evidenceMcp[0]?.result;
    if (evidence?.isError !== false) throw new Error("installed Insights MCP evidence tool failed");
    validateInstalledQuery(validators, evidence.structuredContent);
    return {
      queryCount: outputs.length,
      schemaCount: validators.size,
      mcpToolCount: toolNames.length,
    };
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
