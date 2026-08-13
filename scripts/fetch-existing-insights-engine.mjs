#!/usr/bin/env node

import { createHash } from "node:crypto";
import { chmod, mkdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import {
  fetchProvenance,
  validateNpmProvenance,
  verifyRegistryAttestations,
} from "./publish-insights-release.mjs";
import { inspectPlatformTarball } from "./package-insights-release.mjs";
import {
  fetchPublishedVersion,
  validatePublishedRelease,
} from "./verify-release.mjs";
import {
  INSIGHTS_ENGINE_TARGETS,
  insightsEnginePackageName,
} from "../src/insights-engine-targets.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";

const REGISTRY = "https://registry.npmjs.org";
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function sha512Integrity(value) {
  return `sha512-${createHash("sha512").update(value).digest("base64")}`;
}

async function writeGithubOutput(filePath, exists) {
  if (!filePath) return;
  await writeFile(filePath, `exists=${exists ? "true" : "false"}\n`, { flag: "a" });
}

export async function fetchExistingInsightsEngine({
  outputDirectory,
  sourceSha,
  targetName,
  version,
  githubOutput,
  fetchImpl = globalThis.fetch,
  npmCommand = "npm",
  exec,
  sleep,
}) {
  if (!GIT_OBJECT_ID.test(sourceSha)) throw new TypeError("sourceSha must be a Git object id");
  const target = INSIGHTS_ENGINE_TARGETS.find((candidate) => candidate.target === targetName);
  if (!target) throw new TypeError("target is unsupported");
  const packageName = insightsEnginePackageName(target.target);
  // Probe the immutable version endpoint first. It avoids a stale full
  // packument and lets a missing target return immediately without waiting
  // for CDN retries.
  const published = await fetchPublishedVersion({
    packageName,
    version,
    allowMissing: true,
    fetchImpl,
    maxAttempts: 4,
    sleep,
  });
  if (!published) {
    await writeGithubOutput(githubOutput, false);
    return { exists: false, packageName, target: target.target, version };
  }
  const packument = {
    name: packageName,
    "dist-tags": {},
    versions: { [version]: published },
  };
  const integrity = published.dist?.integrity;
  const provenanceDocument = await fetchProvenance(
    published.dist?.attestations?.url,
    fetchImpl,
  );
  const provenance = validateNpmProvenance(provenanceDocument, {
    integrity,
    sourceSha,
    tag: version,
  });
  validatePublishedRelease({
    packument,
    packageName,
    version,
    integrity,
    kind: "platform",
    provenance,
    sourceSha,
  });
  await verifyRegistryAttestations({ packageName, version, npmCommand, exec });
  const tarballUrl = published.dist?.tarball;
  if (typeof tarballUrl !== "string" || !tarballUrl.startsWith(`${REGISTRY}/`)) {
    throw new Error("published platform tarball URL is invalid");
  }
  const response = await fetchImpl(tarballUrl, {
    headers: { "cache-control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`platform tarball request returned HTTP ${response.status}`);
  const bytes = Buffer.from(await response.arrayBuffer());
  if (sha512Integrity(bytes) !== integrity) {
    throw new Error("published platform tarball integrity is invalid");
  }
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const tarballPath = path.join(outputDirectory, "existing.tgz");
  await writeFile(tarballPath, bytes, { mode: 0o600 });
  const inspection = await inspectPlatformTarball({
    tarballPath,
    target,
    version,
    sourceSha,
    integrity,
  });
  const { binaryBytes } = inspection;
  const binaryName = target.platform === "win32"
    ? "threadshare-insights-engine.exe"
    : "threadshare-insights-engine";
  await Promise.all([
    writeFile(path.join(outputDirectory, binaryName), binaryBytes, {
      mode: target.platform === "win32" ? 0o600 : 0o755,
    }),
    writeFile(
      path.join(outputDirectory, "registry.json"),
      canonicalJson({
        buildManifestDigest: inspection.buildManifestDigest,
        format: "threadshare-insights-registry-artifact@v1",
        integrity,
        packageName,
        rawSha256: inspection.rawSha256,
        sourceSha,
        target: target.target,
        version,
      }),
      { mode: 0o600 },
    ),
  ]);
  if (target.platform !== "win32") await chmod(path.join(outputDirectory, binaryName), 0o755);
  await writeGithubOutput(githubOutput, true);
  return { exists: true, packageName, target: target.target, version };
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!new Set([
      "--github-output",
      "--output",
      "--source-sha",
      "--target",
      "--version",
    ]).has(key) || !value) {
      throw new Error("Usage: fetch-existing-insights-engine --output <dir> --source-sha <git-oid> --target <target> --version <version> [--github-output <file>]");
    }
    options[key.slice(2).replaceAll("-", "_")] = value;
  }
  return options;
}

if (import.meta.url === pathToFileURL(path.resolve(process.argv[1] ?? "")).href) {
  const options = parseArguments(process.argv.slice(2));
  fetchExistingInsightsEngine({
    outputDirectory: path.resolve(options.output),
    sourceSha: options.source_sha,
    targetName: options.target,
    version: options.version,
    githubOutput: options.github_output,
  }).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
