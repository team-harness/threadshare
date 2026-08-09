#!/usr/bin/env node

import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT_PACKAGE = "@team-harness/threadshare";

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

export async function smokeInstalledInsights({ prefix, version }) {
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
  const [{ createInsightsEngineClient }, runtime] = await Promise.all([
    import(pathToFileURL(path.join(rootDirectory, "src", "insights-engine-client.mjs")).href),
    import(pathToFileURL(path.join(rootDirectory, "src", "insights-engine-runtime.mjs")).href),
  ]);
  const target = runtime.insightsEngineTarget();
  if (
    !target ||
    platformPackages[0] !== runtime.insightsEnginePackageName(target.target).split("/").at(-1)
  ) {
    throw new Error("consumer install resolved the wrong platform Insights Engine");
  }
  const client = await createInsightsEngineClient({
    requiredContract: requiredContract(),
    timeoutMs: 5_000,
  });
  await client.close();
  return { packageName: packageDocument.name, target: target.target, version };
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
