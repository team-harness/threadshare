#!/usr/bin/env node

import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import {
  access,
  chmod,
  copyFile,
  mkdir,
  readFile,
  readdir,
  writeFile,
} from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

import {
  INSIGHTS_ENGINE_RELEASE_TARGETS,
  INSIGHTS_ENGINE_TARGETS,
  insightsEnginePackageName,
} from "../src/insights-engine-targets.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";
import { verifyInsightsDashboardBuild } from "./build-insights-dashboard.mjs";
import { EXPECTED_PACKAGE_FILES } from "./verify-release.mjs";

const ENGINE_BASENAME = "threadshare-insights-engine";
const STABLE_VERSION = /^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u;
const HEX_64 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function assertReleaseIdentity(version, sourceSha) {
  if (!STABLE_VERSION.test(version)) throw new TypeError("version must be a stable semver");
  if (!GIT_OBJECT_ID.test(sourceSha)) {
    throw new TypeError("sourceSha must be a lowercase Git object id");
  }
}

function knownPlatformDependencyNames() {
  return INSIGHTS_ENGINE_TARGETS.map((target) => insightsEnginePackageName(target.target)).sort();
}

function releasePlatformDependencyNames() {
  return INSIGHTS_ENGINE_RELEASE_TARGETS
    .map((target) => insightsEnginePackageName(target.target))
    .sort();
}

export function assertSourceManifestHasNoPlatformPackages(packageJson, packageLock) {
  const forbidden = knownPlatformDependencyNames();
  const documents = [
    ["package.json", packageJson],
    ["package-lock.json", packageLock],
  ];
  for (const [label, document] of documents) {
    const serialized = JSON.stringify(document);
    for (const packageName of forbidden) {
      if (serialized.includes(packageName)) {
        throw new Error(`${label} must not contain ${packageName}`);
      }
    }
  }
  if (Object.hasOwn(packageJson, "workspaces")) {
    throw new Error("platform packages must not be npm workspaces");
  }
}

export function createStagedRootManifest(sourceManifest, version) {
  if (sourceManifest.version !== version) {
    throw new Error("source package version must equal the staged release version");
  }
  const optionalDependencies = Object.fromEntries(
    releasePlatformDependencyNames().map((packageName) => [packageName, version]),
  );
  return { ...structuredClone(sourceManifest), optionalDependencies };
}

export function createPlatformManifest(target, version) {
  const packageName = insightsEnginePackageName(target.target);
  return {
    name: packageName,
    version,
    description: `Threadshare Insights Engine for ${target.target}`,
    license: "MIT",
    os: [target.os],
    cpu: [target.cpu],
    files: ["bin/", "build-manifest.json", "LICENSE"],
    publishConfig: { access: "public" },
  };
}

export function createBuildManifest({ target, version, sourceSha, binaryBytes, sqliteVersion }) {
  assertReleaseIdentity(version, sourceSha);
  if (!/^3\.[0-9]+\.[0-9]+$/u.test(sqliteVersion)) {
    throw new TypeError("sqliteVersion must be an exact SQLite patch version");
  }
  const binaryName = target.platform === "win32" ? `${ENGINE_BASENAME}.exe` : ENGINE_BASENAME;
  return {
    abi: target.abi,
    binary: `bin/${binaryName}`,
    binarySha256: sha256(binaryBytes),
    format: "threadshare-insights-build@v1",
    license: "MIT",
    minimumOs: target.minimumOs,
    packageName: insightsEnginePackageName(target.target),
    protocolVersion: 1,
    rustTarget: target.rustTarget,
    sourceSha,
    sqliteVersion,
    target: target.target,
    version,
  };
}

async function ensureEmptyDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length !== 0) {
    throw new Error("release staging directory must be empty");
  }
}

async function copyRootAllowlist(root, destination, stagedManifest) {
  for (const relative of EXPECTED_PACKAGE_FILES) {
    const output = path.join(destination, relative);
    await mkdir(path.dirname(output), { recursive: true });
    if (relative === "package.json") {
      await writeFile(output, `${JSON.stringify(stagedManifest, null, 2)}\n`, { mode: 0o600 });
    } else {
      await copyFile(path.join(root, relative), output);
    }
  }
}

async function readEngineVersionDocument(targetDirectory) {
  const document = JSON.parse(await readFile(path.join(targetDirectory, "version.json"), "utf8"));
  const expectedKeys = [
    "buildManifestDigest",
    "engineVersion",
    "format",
    "protocolVersion",
    "sqliteCompileOptionsDigest",
    "sqliteVersion",
    "target",
  ];
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    Object.keys(document).sort().join("\n") !== expectedKeys.join("\n") ||
    document.format !== "threadshare-insights-engine-version@v1" ||
    document.protocolVersion !== 1 ||
    !HEX_64.test(document.sqliteCompileOptionsDigest) ||
    !HEX_64.test(document.buildManifestDigest) ||
    !/^3\.[0-9]+\.[0-9]+$/u.test(document.sqliteVersion)
  ) {
    throw new Error("Engine version document is incompatible");
  }
  return document;
}

async function optionalFile(pathname) {
  try {
    await access(pathname, fsConstants.R_OK);
    return true;
  } catch (error) {
    if (error?.code === "ENOENT") return false;
    throw error;
  }
}

function assertRegistryArtifact(document, { sourceSha, target, version }) {
  const expectedKeys = [
    "buildManifestDigest",
    "format",
    "integrity",
    "packageName",
    "rawSha256",
    "sourceSha",
    "target",
    "version",
  ];
  if (
    !document ||
    typeof document !== "object" ||
    Array.isArray(document) ||
    Object.keys(document).sort().join("\n") !== expectedKeys.join("\n") ||
    document.format !== "threadshare-insights-registry-artifact@v1" ||
    document.packageName !== insightsEnginePackageName(target.target) ||
    document.sourceSha !== sourceSha ||
    document.target !== target.target ||
    document.version !== version ||
    !HEX_64.test(document.buildManifestDigest) ||
    !HEX_64.test(document.rawSha256) ||
    !/^sha512-[A-Za-z0-9+/]+={0,2}$/u.test(document.integrity)
  ) {
    throw new Error(`Registry artifact does not match ${target.target}`);
  }
}

export async function stageInsightsRelease({ root, binariesDirectory, outputDirectory, version, sourceSha }) {
  assertReleaseIdentity(version, sourceSha);
  await verifyInsightsDashboardBuild({ root });
  const [sourceManifest, packageLock] = await Promise.all([
    readFile(path.join(root, "package.json"), "utf8").then(JSON.parse),
    readFile(path.join(root, "package-lock.json"), "utf8").then(JSON.parse),
  ]);
  assertSourceManifestHasNoPlatformPackages(sourceManifest, packageLock);
  await ensureEmptyDirectory(outputDirectory);

  const rootDirectory = path.join(outputDirectory, "root");
  await mkdir(rootDirectory, { recursive: true, mode: 0o700 });
  await copyRootAllowlist(root, rootDirectory, createStagedRootManifest(sourceManifest, version));
  const metadataDirectory = path.join(outputDirectory, "metadata");
  await mkdir(metadataDirectory, { recursive: true, mode: 0o700 });
  const existingDirectory = path.join(outputDirectory, "existing");

  const packages = [];
  for (const target of INSIGHTS_ENGINE_RELEASE_TARGETS) {
    const binaryName = target.platform === "win32" ? `${ENGINE_BASENAME}.exe` : ENGINE_BASENAME;
    const targetDirectory = path.join(binariesDirectory, target.target);
    const versionDocument = await readEngineVersionDocument(targetDirectory);
    if (versionDocument.engineVersion !== version || versionDocument.target !== target.target) {
      throw new Error(`Engine version probe does not match ${target.target}`);
    }
    const packageDirectory = path.join(outputDirectory, target.target);
    const sourceSbom = path.join(targetDirectory, "sbom.spdx.json");
    const sbomBytes = await readFile(sourceSbom);
    const sbom = JSON.parse(sbomBytes);
    if (
      !Buffer.from(canonicalJson(sbom)).equals(sbomBytes) ||
      sbom?.spdxVersion !== "SPDX-2.3" ||
      !String(sbom?.documentNamespace).includes(`/${sourceSha}/${target.target}`)
    ) {
      throw new Error(`Engine SBOM does not match ${target.target}`);
    }
    await copyFile(sourceSbom, path.join(metadataDirectory, `${target.target}.spdx.json`));

    const existingTarball = path.join(targetDirectory, "existing.tgz");
    const existingRegistry = path.join(targetDirectory, "registry.json");
    const [hasExistingTarball, hasExistingRegistry] = await Promise.all([
      optionalFile(existingTarball),
      optionalFile(existingRegistry),
    ]);
    if (hasExistingTarball !== hasExistingRegistry) {
      throw new Error(`Registry artifact for ${target.target} is incomplete`);
    }
    if (hasExistingTarball) {
      const registryBytes = await readFile(existingRegistry);
      const registry = JSON.parse(registryBytes);
      if (!Buffer.from(canonicalJson(registry)).equals(registryBytes)) {
        throw new Error(`Registry artifact for ${target.target} is not canonical JSON`);
      }
      assertRegistryArtifact(registry, { sourceSha, target, version });
      await mkdir(existingDirectory, { recursive: true, mode: 0o700 });
      const stagedTarball = path.join(existingDirectory, `${target.target}.tgz`);
      const stagedRegistry = path.join(existingDirectory, `${target.target}.registry.json`);
      await Promise.all([
        copyFile(existingTarball, stagedTarball),
        copyFile(existingRegistry, stagedRegistry),
      ]);
      packages.push({
        existing: true,
        registry: stagedRegistry,
        target: target.target,
        tarball: stagedTarball,
      });
      continue;
    }

    const sourceBinary = path.join(targetDirectory, binaryName);
    await access(sourceBinary, fsConstants.R_OK);
    const binaryBytes = await readFile(sourceBinary);
    const binDirectory = path.join(packageDirectory, "bin");
    await mkdir(binDirectory, { recursive: true, mode: 0o700 });
    await Promise.all([
      copyFile(path.join(root, "LICENSE"), path.join(packageDirectory, "LICENSE")),
      writeFile(
        path.join(packageDirectory, "package.json"),
        `${JSON.stringify(createPlatformManifest(target, version), null, 2)}\n`,
        { mode: 0o600 },
      ),
      writeFile(
        path.join(packageDirectory, "build-manifest.json"),
        canonicalJson(createBuildManifest({
          target,
          version,
          sourceSha,
          binaryBytes,
          sqliteVersion: versionDocument.sqliteVersion,
        })),
        { mode: 0o600 },
      ),
      copyFile(sourceBinary, path.join(binDirectory, binaryName)),
    ]);
    if (target.platform !== "win32") await chmod(path.join(binDirectory, binaryName), 0o755);
    packages.push({ existing: false, packageDirectory, target: target.target });
  }
  return { rootDirectory, packages };
}

export function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!new Set(["--binaries", "--output", "--source-sha", "--version"]).has(key) || !value) {
      throw new Error("Usage: prepare-insights-release --binaries <dir> --output <empty-dir> --source-sha <sha256> --version <semver>");
    }
    options[key.slice(2).replaceAll("-", "_")] = value;
  }
  for (const key of ["binaries", "output", "source_sha", "version"]) {
    if (!options[key]) throw new Error(`missing --${key.replaceAll("_", "-")}`);
  }
  return options;
}

async function main() {
  const options = parseArguments(process.argv.slice(2));
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const result = await stageInsightsRelease({
    root,
    binariesDirectory: path.resolve(options.binaries),
    outputDirectory: path.resolve(options.output),
    sourceSha: options.source_sha,
    version: options.version,
  });
  process.stdout.write(`${JSON.stringify(result)}\n`);
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
