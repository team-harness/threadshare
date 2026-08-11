#!/usr/bin/env node

import { execFile as execFileCallback } from "node:child_process";
import { readFile, readdir } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

const ROOT_PACKAGE = "@team-harness/threadshare";
function runInstalledCli(binary, arguments_) {
  return new Promise((resolve, reject) => {
    execFileCallback(process.execPath, [binary, ...arguments_], {
      encoding: "utf8",
      maxBuffer: 1024 * 1024,
      timeout: 10_000,
    }, (error, stdout, stderr) => {
      if (error !== null && !Number.isInteger(error.code)) {
        reject(error);
        return;
      }
      resolve({ exitCode: error?.code ?? 0, stdout, stderr });
    });
  });
}

async function installedPlatformPackages(directory) {
  const found = [];
  const walk = async (current) => {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch (error) {
      if (error?.code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue;
      const child = path.join(current, entry.name);
      if (
        path.basename(current) === "@team-harness" &&
        entry.name.startsWith("threadshare-") &&
        entry.name !== "threadshare"
      ) {
        found.push(child);
      }
      await walk(child);
    }
  };
  await walk(directory);
  return found.sort();
}

export async function smokeInstalledCore({
  prefix,
  platform = process.platform,
  version,
  runCli = runInstalledCli,
}) {
  if (platform !== "win32") {
    throw new Error("installed core smoke must run on Windows");
  }
  const scopeDirectory = path.join(path.resolve(prefix), "node_modules", "@team-harness");
  const rootDirectory = path.join(scopeDirectory, "threadshare");
  const packageDocument = JSON.parse(await readFile(path.join(rootDirectory, "package.json"), "utf8"));
  if (packageDocument.name !== ROOT_PACKAGE || packageDocument.version !== version) {
    throw new Error("installed Threadshare package identity is invalid");
  }
  const platformPackages = await installedPlatformPackages(
    path.join(path.resolve(prefix), "node_modules"),
  );
  if (platformPackages.length !== 0) {
    throw new Error("core-only consumer install must not resolve an Insights Engine package");
  }
  const binary = path.join(rootDirectory, "bin", "threadshare.mjs");
  const { renderRootHelp } = await import(
    pathToFileURL(path.join(rootDirectory, "src", "cli-contract.mjs")).href
  );
  const help = await runCli(binary, ["--help"]);
  if (
    help.exitCode !== 0 ||
    help.stderr !== "" ||
    help.stdout !== `${renderRootHelp()}\n`
  ) {
    throw new Error("installed Threadshare core CLI help is invalid");
  }
  const insights = await runCli(binary, ["insights", "status"]);
  if (
    insights.exitCode !== 1 ||
    insights.stdout !== "" ||
    !insights.stderr.includes("threadshare: error TS_INSIGHTS_ENGINE_UNAVAILABLE") ||
    !insights.stderr.includes(
      "Problem: Local Insights is not available for this platform in this release.",
    ) ||
    !insights.stderr.includes(
      "Next: Use Threadshare core commands on Windows, or run Insights on macOS or Linux.",
    )
  ) {
    throw new Error("installed Threadshare Insights command must fail closed on Windows");
  }
  return {
    packageName: packageDocument.name,
    platformPackageCount: platformPackages.length,
    version,
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--prefix", "--version"]).has(key) || !value) {
      throw new Error("Usage: smoke-installed-core --prefix <dir> --version <semver>");
    }
    options[key.slice(2)] = value;
  }
  if (!options.prefix || !options.version) {
    throw new Error("installed core smoke requires --prefix and --version");
  }
  return options;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  smokeInstalledCore(parseArguments(process.argv.slice(2))).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
