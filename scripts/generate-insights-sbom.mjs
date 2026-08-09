#!/usr/bin/env node

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { canonicalJson } from "../src/canonical-json.mjs";

const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function packageId(package_) {
  const digest = createHash("sha256")
    .update(`${package_.name}\0${package_.version}\0${package_.source ?? ""}`)
    .digest("hex")
    .slice(0, 24);
  return `SPDXRef-Package-${digest}`;
}

function compareText(left, right) {
  return left < right ? -1 : left > right ? 1 : 0;
}

export function createInsightsSbom({ metadata, sourceSha, target, version, created }) {
  if (
    metadata?.version !== 1 ||
    !Array.isArray(metadata.packages) ||
    !GIT_OBJECT_ID.test(sourceSha) ||
    typeof target !== "string" ||
    typeof version !== "string" ||
    Number.isNaN(Date.parse(created))
  ) {
    throw new TypeError("SBOM input identity is invalid");
  }
  const packages = metadata.packages
    .map((package_) => ({
      SPDXID: packageId(package_),
      downloadLocation: "NOASSERTION",
      filesAnalyzed: false,
      licenseConcluded: "NOASSERTION",
      licenseDeclared: package_.license || "NOASSERTION",
      name: package_.name,
      versionInfo: package_.version,
    }))
    .sort((left, right) =>
      compareText(left.name, right.name) ||
      compareText(left.versionInfo, right.versionInfo) ||
      compareText(left.SPDXID, right.SPDXID)
    );
  const engine = packages.find((package_) => package_.name === "threadshare-insights-engine");
  if (!engine) throw new Error("Cargo metadata does not contain the Insights Engine package");
  return {
    SPDXID: "SPDXRef-DOCUMENT",
    creationInfo: {
      created: new Date(created).toISOString(),
      creators: ["Tool: threadshare-insights-sbom@1"],
    },
    dataLicense: "CC0-1.0",
    documentNamespace: `https://github.com/team-harness/threadshare/sbom/${sourceSha}/${target}`,
    name: `threadshare-insights-engine-${target}-${version}`,
    packages,
    relationships: [{
      relatedSpdxElement: engine.SPDXID,
      relationshipType: "DESCRIBES",
      spdxElementId: "SPDXRef-DOCUMENT",
    }],
    spdxVersion: "SPDX-2.3",
  };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!new Set([
      "--created",
      "--metadata",
      "--output",
      "--source-sha",
      "--target",
      "--version",
    ]).has(key) || !value) {
      throw new Error("Usage: generate-insights-sbom --metadata <json> --output <json> --source-sha <git-oid> --target <target> --version <version> --created <iso>");
    }
    options[key.slice(2).replaceAll("-", "_")] = value;
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const metadata = JSON.parse(await readFile(path.resolve(options.metadata), "utf8"));
  const document = createInsightsSbom({
    metadata,
    sourceSha: options.source_sha,
    target: options.target,
    version: options.version,
    created: options.created,
  });
  await writeFile(path.resolve(options.output), canonicalJson(document), { mode: 0o600 });
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
