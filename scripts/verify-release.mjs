#!/usr/bin/env node

import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  INSIGHTS_ENGINE_TARGETS,
  insightsEnginePackageName,
} from "../src/insights-engine-targets.mjs";
import { verifyInsightsDashboardBuild } from "./build-insights-dashboard.mjs";

const execFileAsync = promisify(execFile);
export const PACKAGE_NAME = "@team-harness/threadshare";
const REGISTRY_URL = "https://registry.npmjs.org";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const BOOTSTRAP_VERSION = "0.0.0-bootstrap.0";

export const EXPECTED_PACKAGE_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "bin/threadshare.mjs",
  "insights-dashboard/app.js",
  "insights-dashboard/index.html",
  "insights-dashboard/state.js",
  "insights-dashboard/styles.css",
  "package.json",
  "schema/session-facts-delta.v1.schema.json",
  "schema/session-facts-delta.v2.schema.json",
  "schema/threadshare-history.v1.schema.json",
  "schema/threadshare-insights-activity-request.v1.schema.json",
  "schema/threadshare-insights-activity.v1.schema.json",
  "schema/threadshare-insights-capabilities.v1.schema.json",
  "schema/threadshare-insights-evidence-request.v2.schema.json",
  "schema/threadshare-insights-evidence.v1.schema.json",
  "schema/threadshare-insights-evidence.v2.schema.json",
  "schema/threadshare-insights-overview.v1.schema.json",
  "schema/threadshare-insights-query-request.v2.schema.json",
  "schema/threadshare-insights-query.v2.schema.json",
  "schema/threadshare-insights-recipe-request.v1.schema.json",
  "schema/threadshare-insights-recipe.v1.schema.json",
  "schema/threadshare-insights-search-request.v1.schema.json",
  "schema/threadshare-insights-search.v1.schema.json",
  "schema/threadshare-insights-usage-request.v1.schema.json",
  "schema/threadshare-insights-usage.v1.schema.json",
  "skills/threadshare/SKILL.md",
  "skills/threadshare/agents/openai.yaml",
  "src/agent-transcript.mjs",
  "src/canonical-json.mjs",
  "src/cli-contract.mjs",
  "src/history-selection.mjs",
  "src/insights-command.mjs",
  "src/insights-config.mjs",
  "src/insights-dashboard-server.mjs",
  "src/insights-dashboard.mjs",
  "src/insights-engine-client.mjs",
  "src/insights-engine-protocol.mjs",
  "src/insights-engine-runtime.mjs",
  "src/insights-engine-targets.mjs",
  "src/insights-indexer.mjs",
  "src/insights-lifecycle.mjs",
  "src/insights-mcp.mjs",
  "src/insights-paths.mjs",
  "src/insights-query-reader.mjs",
  "src/insights-query.mjs",
  "src/insights-reference-engine.mjs",
  "src/insights-reindex.mjs",
  "src/insights-state.mjs",
  "src/insights-writer-lock.mjs",
  "src/paseo-session-bridge.mjs",
  "src/provider-evidence.mjs",
  "src/session-export.mjs",
  "src/session-facts.mjs",
  "src/session-files.mjs",
  "src/session-listing.mjs",
  "src/session-record-reader.mjs",
  "src/share-preflight.mjs",
  "src/share-read.mjs",
  "src/share-url.mjs",
  "src/turn-analysis.mjs",
]);

export const PLATFORM_PACKAGE_NAMES = Object.freeze(
  INSIGHTS_ENGINE_TARGETS.map((target) => insightsEnginePackageName(target.target)).sort(),
);

export function expectedPlatformPackageFiles(target) {
  const match = INSIGHTS_ENGINE_TARGETS.find((candidate) => candidate.target === target);
  if (!match) throw new TypeError(`unknown Insights Engine target: ${target}`);
  const binary = match.platform === "win32"
    ? "bin/threadshare-insights-engine.exe"
    : "bin/threadshare-insights-engine";
  return Object.freeze(["LICENSE", binary, "build-manifest.json", "package.json"].sort());
}

function parseStableVersion(value, label = "version") {
  if (typeof value !== "string") {
    throw new Error(`${label} must be a stable semver`);
  }
  const match = STABLE_VERSION_PATTERN.exec(value);
  if (!match) {
    throw new Error(`${label} must be a stable semver without a prefix or prerelease`);
  }
  return match.slice(1).map((part) => BigInt(part));
}

export function compareStableVersions(left, right) {
  const leftParts = parseStableVersion(left, "left version");
  const rightParts = parseStableVersion(right, "right version");
  for (let index = 0; index < leftParts.length; index += 1) {
    if (leftParts[index] > rightParts[index]) return 1;
    if (leftParts[index] < rightParts[index]) return -1;
  }
  return 0;
}

export function validateReleaseMetadata({ tag, packageJson, packageLock }) {
  parseStableVersion(tag, "release tag");
  if (packageJson?.name !== PACKAGE_NAME) {
    throw new Error(`package.json name must be ${PACKAGE_NAME}`);
  }
  const versions = [
    ["package.json version", packageJson?.version],
    ["package-lock.json version", packageLock?.version],
    ["package-lock.json root version", packageLock?.packages?.[""]?.version],
  ];
  for (const [label, version] of versions) {
    parseStableVersion(version, label);
    if (version !== tag) {
      throw new Error(`${label} must equal release tag ${tag}`);
    }
  }
  if (packageLock?.name !== PACKAGE_NAME || packageLock?.packages?.[""]?.name !== PACKAGE_NAME) {
    throw new Error(`package-lock.json package names must be ${PACKAGE_NAME}`);
  }
  const sourceDocuments = [JSON.stringify(packageJson), JSON.stringify(packageLock)];
  for (const packageName of PLATFORM_PACKAGE_NAMES) {
    if (sourceDocuments.some((document) => document.includes(packageName))) {
      throw new Error(`source manifests must not contain platform package ${packageName}`);
    }
  }
  return { name: PACKAGE_NAME, version: tag };
}

function npmPackEntry(packOutput, packageName) {
  if (Array.isArray(packOutput)) {
    if (packOutput.length === 1) return packOutput[0];
  } else if (packOutput && typeof packOutput === "object") {
    const entries = Object.entries(packOutput);
    if (entries.length === 1 && entries[0][0] === packageName) return entries[0][1];
  }
  throw new Error("npm pack must return exactly one package");
}

export function npmPackFilename(packOutput, packageName) {
  const packed = npmPackEntry(packOutput, packageName);
  if (packed?.name !== packageName) {
    throw new Error("npm pack name must match the requested package");
  }
  const filename = packed.filename;
  if (
    typeof filename !== "string" ||
    filename === "" ||
    path.basename(filename) !== filename ||
    !filename.endsWith(".tgz")
  ) {
    throw new Error("npm pack filename must be a local tarball name");
  }
  return filename;
}

function requireIntegrity(value, label) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} must be a sha512 integrity value`);
  }
  return value;
}

export function validatePackOutput(packOutput, metadata) {
  const packed = npmPackEntry(packOutput, metadata.name);
  if (packed?.name !== metadata.name || packed?.version !== metadata.version) {
    throw new Error("npm pack name and version must match release metadata");
  }
  const files = Array.isArray(packed.files)
    ? packed.files.map((entry) => entry?.path).sort()
    : [];
  const expectedFiles = metadata.kind === "platform"
    ? expectedPlatformPackageFiles(metadata.target)
    : EXPECTED_PACKAGE_FILES;
  if (
    packed.entryCount !== expectedFiles.length ||
    files.length !== expectedFiles.length ||
    files.some((file, index) => file !== expectedFiles[index])
  ) {
    throw new Error(`npm package files must exactly match the ${expectedFiles.length}-file allowlist`);
  }
  if (metadata.kind !== "platform") {
    if (!Number.isSafeInteger(packed.size) || packed.size < 1 || packed.size > 256 * 1024) {
      throw new Error("npm root package compressed size must not exceed 256 KiB");
    }
    if (!Number.isSafeInteger(packed.unpackedSize) || packed.unpackedSize < 1 || packed.unpackedSize > 1024 * 1024) {
      throw new Error("npm root package unpacked size must not exceed 1 MiB");
    }
  }
  return { files, integrity: requireIntegrity(packed.integrity, "npm pack integrity") };
}

function validatePackument(packument, packageName, { allowBootstrap = false } = {}) {
  if (!packument || typeof packument !== "object" || Array.isArray(packument)) {
    throw new Error("registry packument must be a JSON object");
  }
  if (packument.name !== packageName) {
    throw new Error(`registry packument name must be ${packageName}`);
  }
  if (!packument["dist-tags"] || typeof packument["dist-tags"] !== "object") {
    throw new Error("registry packument must contain dist-tags");
  }
  const latest = packument["dist-tags"].latest;
  const bootstrapLatest = allowBootstrap &&
    latest === BOOTSTRAP_VERSION &&
    packument["dist-tags"].bootstrap === BOOTSTRAP_VERSION;
  if (latest !== undefined && !bootstrapLatest) parseStableVersion(latest, "registry latest");
  else if (latest === undefined && !allowBootstrap) {
    throw new Error("registry packument must contain stable latest");
  }
  if (!packument.versions || typeof packument.versions !== "object" || Array.isArray(packument.versions)) {
    throw new Error("registry packument must contain versions");
  }
  if (latest !== undefined && !Object.hasOwn(packument.versions, latest)) {
    throw new Error("registry latest must identify a published version");
  }
  return packument;
}

function highestStableVersion(versions) {
  let highest;
  for (const version of Object.keys(versions)) {
    if (!STABLE_VERSION_PATTERN.test(version)) continue;
    if (highest === undefined || compareStableVersions(version, highest) > 0) {
      highest = version;
    }
  }
  return highest;
}

export function decidePublish({ packument, packageName, version, integrity, kind = "root" }) {
  validatePackument(packument, packageName, { allowBootstrap: kind === "platform" });
  parseStableVersion(version, "release version");
  requireIntegrity(integrity, "expected integrity");
  const latest = packument["dist-tags"].latest;
  const existing = packument.versions[version];
  if (existing !== undefined) {
    const registryIntegrity = existing?.dist?.integrity;
    requireIntegrity(registryIntegrity, "published package integrity");
    if (kind === "root" && registryIntegrity !== integrity) {
      throw new Error(`Published ${packageName}@${version} integrity differs from this release`);
    }
    return kind === "root"
      ? { latest, shouldPublish: false }
      : { latest: latest ?? null, registryIntegrity, shouldPublish: false };
  }
  const highest = highestStableVersion(packument.versions);
  if (highest !== undefined && compareStableVersions(version, highest) <= 0) {
    throw new Error(`Release ${version} must be newer than highest published stable ${highest}`);
  }
  return { latest: latest ?? null, shouldPublish: true };
}

export function validatePublishedRelease({
  packument,
  packageName,
  version,
  integrity,
  kind = "root",
  provenance,
  sourceSha,
}) {
  validatePackument(packument, packageName, { allowBootstrap: kind === "platform" });
  parseStableVersion(version, "release version");
  requireIntegrity(integrity, "expected integrity");
  const published = packument.versions[version];
  if (!published || (kind === "root" && published?.dist?.integrity !== integrity)) {
    throw new Error(`Published ${packageName}@${version} is missing or has unexpected integrity`);
  }
  requireIntegrity(published?.dist?.integrity, "published package integrity");
  const attestations = published.dist.attestations;
  if (
    typeof attestations?.url !== "string" ||
    attestations.url.trim() === "" ||
    attestations?.provenance?.predicateType !== SLSA_PROVENANCE_V1
  ) {
    throw new Error(`Published ${packageName}@${version} does not expose SLSA provenance`);
  }
  const latest = packument["dist-tags"].latest;
  if (kind === "root" && compareStableVersions(latest, version) < 0) {
    throw new Error(`Registry latest ${latest} is older than published release ${version}`);
  }
  if (kind === "platform") {
    if (
      !provenance ||
      provenance.workflow !== "publish-npm.yml" ||
      provenance.gitCommit !== sourceSha ||
      provenance.subjectIntegrity !== published.dist.integrity
    ) {
      throw new Error(`Published ${packageName}@${version} provenance does not match this release`);
    }
  }
  return kind === "root"
    ? { latest }
    : { latest: latest ?? null, registryIntegrity: published.dist.integrity };
}

function registryPackageUrl(packageName) {
  const encodedName = packageName.startsWith("@")
    ? packageName.replace("/", "%2f")
    : encodeURIComponent(packageName);
  return `${REGISTRY_URL}/${encodedName}`;
}

function registryVersionUrl(packageName, version) {
  return `${registryPackageUrl(packageName)}/${encodeURIComponent(version)}`;
}

function registryDistTagsUrl(packageName) {
  const encodedName = packageName.startsWith("@")
    ? packageName.replace("/", "%2f")
    : encodeURIComponent(packageName);
  return `${REGISTRY_URL}/-/package/${encodedName}/dist-tags`;
}

function defaultSleep(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

export async function fetchPackument({
  packageName,
  fetchImpl = globalThis.fetch,
  maxAttempts = 4,
  sleep = defaultSleep,
  retryDelay = (attempt) => 1_000 * 2 ** attempt,
  allowMissing = false,
} = {}) {
  if (typeof fetchImpl !== "function" || !Number.isInteger(maxAttempts) || maxAttempts < 1) {
    throw new Error("registry packument probe configuration is invalid");
  }
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(registryPackageUrl(packageName), {
        headers: { accept: "application/json", "cache-control": "no-cache" },
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (allowMissing && response.status === 404) {
        return { name: packageName, "dist-tags": {}, versions: {} };
      }
      if (response.status !== 200) {
        throw new Error(`registry packument returned HTTP ${response.status}`);
      }
      let document;
      try {
        document = await response.json();
      } catch (error) {
        throw new Error(`registry packument returned invalid JSON: ${error.message}`);
      }
      return validatePackument(document, packageName, { allowBootstrap: allowMissing });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) {
        await sleep(retryDelay(attempt));
      }
    }
  }
  throw new Error(`registry packument probe failed after ${maxAttempts} attempt(s): ${lastError.message}`);
}

/**
 * The full packument is CDN-cached for several minutes after a publish. The
 * version endpoint is the authoritative, low-latency publication probe and is
 * intentionally separate so release retries do not mistake stale tags for a
 * missing package.
 */
export async function fetchPublishedVersion({
  packageName,
  version,
  fetchImpl = globalThis.fetch,
  maxAttempts = 4,
  sleep = defaultSleep,
  retryDelay = (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
  allowMissing = false,
} = {}) {
  if (
    typeof packageName !== "string" ||
    typeof version !== "string" ||
    typeof fetchImpl !== "function" ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1
  ) {
    throw new Error("registry version probe configuration is invalid");
  }
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(registryVersionUrl(packageName, version), {
        headers: {
          accept: "application/json",
          "cache-control": "no-cache, no-store",
          pragma: "no-cache",
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (allowMissing && response.status === 404) return null;
      if (response.status !== 200) {
        throw new Error(`registry version probe returned HTTP ${response.status}`);
      }
      let document;
      try {
        document = await response.json();
      } catch (error) {
        throw new Error(`registry version probe returned invalid JSON: ${error.message}`);
      }
      if (
        !document ||
        typeof document !== "object" ||
        Array.isArray(document) ||
        document.name !== packageName ||
        document.version !== version
      ) {
        throw new Error("registry version probe returned mismatched package metadata");
      }
      return document;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) await sleep(retryDelay(attempt));
    }
  }
  throw new Error(`registry version probe failed after ${maxAttempts} attempt(s): ${lastError.message}`);
}

export async function fetchPublishedDistTags({
  packageName,
  fetchImpl = globalThis.fetch,
  maxAttempts = 4,
  sleep = defaultSleep,
  retryDelay = (attempt) => Math.min(1_000 * 2 ** attempt, 10_000),
} = {}) {
  if (
    typeof packageName !== "string" ||
    typeof fetchImpl !== "function" ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1
  ) {
    throw new Error("registry dist-tags probe configuration is invalid");
  }
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const response = await fetchImpl(registryDistTagsUrl(packageName), {
        headers: {
          accept: "application/json",
          "cache-control": "no-cache, no-store",
          pragma: "no-cache",
        },
        cache: "no-store",
        redirect: "error",
        signal: AbortSignal.timeout(15_000),
      });
      if (response.status !== 200) {
        throw new Error(`registry dist-tags probe returned HTTP ${response.status}`);
      }
      const document = await response.json();
      if (!document || typeof document !== "object" || Array.isArray(document)) {
        throw new Error("registry dist-tags probe returned invalid JSON");
      }
      for (const [tag, version] of Object.entries(document)) {
        if (typeof tag !== "string" || typeof version !== "string") {
          throw new Error("registry dist-tags probe returned invalid tag metadata");
        }
      }
      return document;
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) await sleep(retryDelay(attempt));
    }
  }
  throw new Error(`registry dist-tags probe failed after ${maxAttempts} attempt(s): ${lastError.message}`);
}

async function readJson(filePath) {
  return JSON.parse(await readFile(filePath, "utf8"));
}

async function releaseMetadata(tag, cwd) {
  const [packageJson, packageLock] = await Promise.all([
    readJson(path.join(cwd, "package.json")),
    readJson(path.join(cwd, "package-lock.json")),
  ]);
  return validateReleaseMetadata({ tag, packageJson, packageLock });
}

async function inspectPackage(metadata, cwd) {
  await verifyInsightsDashboardBuild({ root: cwd });
  const { stdout } = await execFileAsync(
    "npm",
    [
      "pack",
      "--dry-run",
      "--ignore-scripts",
      "--json",
      `--registry=${REGISTRY_URL}`,
    ],
    { cwd, encoding: "utf8", maxBuffer: 5 * 1024 * 1024 },
  );
  let output;
  try {
    output = JSON.parse(stdout);
  } catch (error) {
    throw new Error(`npm pack returned invalid JSON: ${error.message}`);
  }
  return validatePackOutput(output, metadata);
}

export function parseArguments(argv) {
  const [command, ...tokens] = argv;
  if (!new Set(["source", "prepare", "confirm"]).has(command)) {
    throw new Error("Usage: node scripts/verify-release.mjs <source|prepare|confirm> --tag <version> [options]");
  }
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const option = tokens[index];
    const value = tokens[index + 1];
    if (!new Set(["--expected-integrity", "--github-output", "--tag"]).has(option)) {
      throw new Error(`Unknown release verifier option: ${option ?? "<empty>"}`);
    }
    if (!value || value.startsWith("--")) {
      throw new Error(`Missing value for ${option}`);
    }
    const key = option.slice(2).replaceAll("-", "_");
    if (Object.hasOwn(options, key)) {
      throw new Error(`Duplicate release verifier option: ${option}`);
    }
    options[key] = value;
  }
  if (!options.tag) {
    throw new Error("Missing value for --tag");
  }
  if (command === "prepare" && !options.github_output) {
    throw new Error("prepare requires --github-output");
  }
  if (command === "confirm" && !options.expected_integrity) {
    throw new Error("confirm requires --expected-integrity");
  }
  return { command, options };
}

export async function writeOutputs(filePath, values) {
  const lines = Object.entries(values).map(([key, value]) => {
    const rendered = String(value);
    if (!/^[A-Za-z0-9_@./+=:-]+$/.test(rendered)) {
      throw new Error(`GitHub output ${key} contains unsupported characters`);
    }
    return `${key}=${rendered}`;
  });
  await appendFile(filePath, `${lines.join("\n")}\n`, "utf8");
}

async function confirmWithRetry({ packageName, version, integrity }) {
  const maxAttempts = 8;
  let lastError;
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    try {
      const packument = await fetchPackument({ packageName, maxAttempts: 1 });
      return validatePublishedRelease({ packument, packageName, version, integrity });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) {
        await defaultSleep(Math.min(5_000 * 2 ** attempt, 30_000));
      }
    }
  }
  throw new Error(`Published release confirmation failed: ${lastError.message}`);
}

export function assertPreparedIntegrity(actualIntegrity, expectedIntegrity, { kind = "root" } = {}) {
  requireIntegrity(actualIntegrity, "actual integrity");
  requireIntegrity(expectedIntegrity, "expected integrity");
  if (kind === "root" && actualIntegrity !== expectedIntegrity) {
    throw new Error("npm pack integrity changed between prepare and confirm");
  }
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const cwd = process.cwd();
  const metadata = await releaseMetadata(options.tag, cwd);
  const packed = await inspectPackage(metadata, cwd);

  if (command === "source") {
    process.stdout.write(`${JSON.stringify({ phase: "source", ...metadata, integrity: packed.integrity })}\n`);
    return;
  }

  if (command === "prepare") {
    const packument = await fetchPackument({ packageName: metadata.name });
    const decision = decidePublish({
      packument,
      packageName: metadata.name,
      version: metadata.version,
      integrity: packed.integrity,
    });
    await writeOutputs(options.github_output, {
      integrity: packed.integrity,
      latest: decision.latest,
      package_name: metadata.name,
      should_publish: decision.shouldPublish,
      version: metadata.version,
    });
    process.stdout.write(`${JSON.stringify({ phase: "prepare", ...metadata, ...decision, integrity: packed.integrity })}\n`);
    return;
  }

  assertPreparedIntegrity(packed.integrity, options.expected_integrity);
  const confirmation = await confirmWithRetry({
    packageName: metadata.name,
    version: metadata.version,
    integrity: options.expected_integrity,
  });
  process.stdout.write(`${JSON.stringify({ phase: "confirm", ...metadata, ...confirmation, integrity: packed.integrity })}\n`);
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
