#!/usr/bin/env node

import { execFile } from "node:child_process";
import { appendFile, readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

const execFileAsync = promisify(execFile);
const PACKAGE_NAME = "@team-harness/threadshare";
const REGISTRY_URL = "https://registry.npmjs.org";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const STABLE_VERSION_PATTERN = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

export const EXPECTED_PACKAGE_FILES = Object.freeze([
  "LICENSE",
  "README.md",
  "README.zh-CN.md",
  "bin/threadshare.mjs",
  "package.json",
  "schema/session-facts-delta.v1.schema.json",
  "schema/threadshare-history.v1.schema.json",
  "skills/threadshare/SKILL.md",
  "skills/threadshare/agents/openai.yaml",
  "src/agent-transcript.mjs",
  "src/cli-contract.mjs",
  "src/history-selection.mjs",
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
]);

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
  return { name: PACKAGE_NAME, version: tag };
}

function requireIntegrity(value, label) {
  if (typeof value !== "string" || !/^sha512-[A-Za-z0-9+/]+={0,2}$/.test(value)) {
    throw new Error(`${label} must be a sha512 integrity value`);
  }
  return value;
}

export function validatePackOutput(packOutput, metadata) {
  let packages;
  if (Array.isArray(packOutput)) {
    packages = packOutput;
  } else if (packOutput && typeof packOutput === "object") {
    const entries = Object.entries(packOutput);
    if (entries.length === 1 && entries[0][0] === metadata.name) {
      packages = [entries[0][1]];
    }
  }
  if (!packages || packages.length !== 1) {
    throw new Error("npm pack must return exactly one package");
  }
  const packed = packages[0];
  if (packed?.name !== metadata.name || packed?.version !== metadata.version) {
    throw new Error("npm pack name and version must match release metadata");
  }
  const files = Array.isArray(packed.files)
    ? packed.files.map((entry) => entry?.path).sort()
    : [];
  if (
    packed.entryCount !== EXPECTED_PACKAGE_FILES.length ||
    files.length !== EXPECTED_PACKAGE_FILES.length ||
    files.some((file, index) => file !== EXPECTED_PACKAGE_FILES[index])
  ) {
    throw new Error(`npm package files must exactly match the ${EXPECTED_PACKAGE_FILES.length}-file allowlist`);
  }
  return { files, integrity: requireIntegrity(packed.integrity, "npm pack integrity") };
}

function validatePackument(packument, packageName) {
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
  parseStableVersion(latest, "registry latest");
  if (!packument.versions || typeof packument.versions !== "object" || Array.isArray(packument.versions)) {
    throw new Error("registry packument must contain versions");
  }
  if (!Object.hasOwn(packument.versions, latest)) {
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

export function decidePublish({ packument, packageName, version, integrity }) {
  validatePackument(packument, packageName);
  parseStableVersion(version, "release version");
  requireIntegrity(integrity, "expected integrity");
  const latest = packument["dist-tags"].latest;
  const existing = packument.versions[version];
  if (existing !== undefined) {
    const registryIntegrity = existing?.dist?.integrity;
    if (registryIntegrity !== integrity) {
      throw new Error(`Published ${packageName}@${version} integrity differs from this release`);
    }
    return { latest, shouldPublish: false };
  }
  const highest = highestStableVersion(packument.versions);
  if (highest === undefined || compareStableVersions(version, highest) <= 0) {
    throw new Error(`Release ${version} must be newer than highest published stable ${highest ?? "<none>"}`);
  }
  return { latest, shouldPublish: true };
}

export function validatePublishedRelease({ packument, packageName, version, integrity }) {
  validatePackument(packument, packageName);
  parseStableVersion(version, "release version");
  requireIntegrity(integrity, "expected integrity");
  const published = packument.versions[version];
  if (!published || published?.dist?.integrity !== integrity) {
    throw new Error(`Published ${packageName}@${version} is missing or has unexpected integrity`);
  }
  const attestations = published.dist.attestations;
  if (
    typeof attestations?.url !== "string" ||
    attestations.url.trim() === "" ||
    attestations?.provenance?.predicateType !== SLSA_PROVENANCE_V1
  ) {
    throw new Error(`Published ${packageName}@${version} does not expose SLSA provenance`);
  }
  const latest = packument["dist-tags"].latest;
  if (compareStableVersions(latest, version) < 0) {
    throw new Error(`Registry latest ${latest} is older than published release ${version}`);
  }
  return { latest };
}

function registryPackageUrl(packageName) {
  const encodedName = packageName.startsWith("@")
    ? packageName.replace("/", "%2f")
    : encodeURIComponent(packageName);
  return `${REGISTRY_URL}/${encodedName}`;
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
      if (response.status !== 200) {
        throw new Error(`registry packument returned HTTP ${response.status}`);
      }
      let document;
      try {
        document = await response.json();
      } catch (error) {
        throw new Error(`registry packument returned invalid JSON: ${error.message}`);
      }
      return validatePackument(document, packageName);
    } catch (error) {
      lastError = error;
      if (attempt + 1 < maxAttempts) {
        await sleep(retryDelay(attempt));
      }
    }
  }
  throw new Error(`registry packument probe failed after ${maxAttempts} attempt(s): ${lastError.message}`);
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
  if (!new Set(["prepare", "confirm"]).has(command)) {
    throw new Error("Usage: node scripts/verify-release.mjs <prepare|confirm> --tag <version> [options]");
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

export function assertPreparedIntegrity(actualIntegrity, expectedIntegrity) {
  requireIntegrity(expectedIntegrity, "expected integrity");
  if (actualIntegrity !== expectedIntegrity) {
    throw new Error("npm pack integrity changed between prepare and confirm");
  }
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  const cwd = process.cwd();
  const metadata = await releaseMetadata(options.tag, cwd);
  const packed = await inspectPackage(metadata, cwd);

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
