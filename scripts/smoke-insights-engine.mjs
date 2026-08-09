#!/usr/bin/env node

import { execFile } from "node:child_process";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import { createInsightsEngineClient } from "../src/insights-engine-client.mjs";

const execFileAsync = promisify(execFile);

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const option = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--binary", "--target", "--version"]).has(option) || !value) {
      throw new Error("Usage: smoke-insights-engine --binary <path> --target <target> --version <version>");
    }
    options[option.slice(2)] = value;
  }
  for (const name of ["binary", "target", "version"]) {
    if (!options[name]) throw new Error(`missing --${name}`);
  }
  return options;
}

function requiredContract() {
  return {
    factSchemaVersion: 1,
    providerAdapterVersions: ["claude@1", "codex@1"],
    privacyPolicyVersion: 1,
    originSecretEpoch: "11111111-1111-4111-8111-111111111111",
    duplicatePolicyVersion: 1,
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: [],
    analyzerCapabilities: [],
    rankerVersion: 1,
  };
}

export async function smokeInsightsEngine({ binary, target, version }) {
  const binaryPath = path.resolve(binary);
  const { stdout } = await execFileAsync(binaryPath, ["--version", "--json"], {
    encoding: "utf8",
    maxBuffer: 1024 * 1024,
  });
  const document = JSON.parse(stdout);
  if (
    document?.format !== "threadshare-insights-engine-version@v1" ||
    document.engineVersion !== version ||
    document.target !== target ||
    document.protocolVersion !== 1 ||
    document.sqliteVersion !== "3.53.2" ||
    !/^[0-9a-f]{64}$/u.test(document.sqliteCompileOptionsDigest) ||
    !/^[0-9a-f]{64}$/u.test(document.buildManifestDigest)
  ) {
    throw new Error("Insights Engine version document does not match the release target");
  }
  const client = await createInsightsEngineClient({
    requiredContract: requiredContract(),
    runtimeOptions: {
      env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: binaryPath },
    },
    timeoutMs: 5_000,
  });
  await client.close();
  return document;
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (isMain) {
  const options = parseArguments(process.argv.slice(2));
  smokeInsightsEngine(options).then(
    (document) => process.stdout.write(`${JSON.stringify(document)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
