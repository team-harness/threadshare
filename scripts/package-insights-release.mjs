#!/usr/bin/env node

import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  INSIGHTS_ENGINE_RELEASE_TARGETS,
  insightsEnginePackageName,
} from "../src/insights-engine-targets.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";
import {
  createBuildManifest,
  createPlatformManifest,
} from "./prepare-insights-release.mjs";
import {
  PACKAGE_NAME,
  npmPackFilename,
  validatePackOutput,
} from "./verify-release.mjs";

const execFileAsync = promisify(execFile);
const MANIFEST_NAME = "release-manifest.json";
const HEX_64 = /^[0-9a-f]{64}$/u;
const GIT_OBJECT_ID = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u;
const INTEGRITY = /^sha512-[A-Za-z0-9+/]+={0,2}$/u;

function digest(algorithm, value, encoding) {
  return createHash(algorithm).update(value).digest(encoding);
}

function sha256(value) {
  return digest("sha256", value, "hex");
}

function sha512Integrity(value) {
  return `sha512-${digest("sha512", value, "base64")}`;
}

async function ensureEmptyDirectory(directory) {
  await mkdir(directory, { recursive: true, mode: 0o700 });
  if ((await readdir(directory)).length !== 0) {
    throw new Error("release artifact directory must be empty");
  }
}

function descriptors(stagingDirectory, version) {
  return [
    ...INSIGHTS_ENGINE_RELEASE_TARGETS.map((target) => ({
      directory: path.join(stagingDirectory, target.target),
      kind: "platform",
      name: insightsEnginePackageName(target.target),
      target: target.target,
      version,
    })),
    {
      directory: path.join(stagingDirectory, "root"),
      kind: "root",
      name: PACKAGE_NAME,
      target: null,
      version,
    },
  ];
}

async function packOne(descriptor, outputDirectory, npmCommand) {
  const { stdout } = await execFileAsync(
    npmCommand,
    ["pack", descriptor.directory, "--ignore-scripts", "--json", "--pack-destination", outputDirectory],
    { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
  );
  const output = JSON.parse(stdout);
  const verified = validatePackOutput(output, descriptor);
  const tarball = npmPackFilename(output, descriptor.name);
  const bytes = await readFile(path.join(outputDirectory, tarball));
  if (sha512Integrity(bytes) !== verified.integrity) {
    throw new Error(`${descriptor.name} tarball bytes do not match npm integrity`);
  }
  const buildManifestDigest = descriptor.kind === "platform"
    ? sha256(await readFile(path.join(descriptor.directory, "build-manifest.json")))
    : null;
  const sbom = descriptor.kind === "platform" ? `${descriptor.target}.spdx.json` : null;
  let sbomSha256 = null;
  if (sbom) {
    const sbomBytes = await readFile(path.join(path.dirname(descriptor.directory), "metadata", sbom));
    sbomSha256 = sha256(sbomBytes);
    await writeFile(path.join(outputDirectory, sbom), sbomBytes, { mode: 0o600 });
  }
  return {
    buildManifestDigest,
    integrity: verified.integrity,
    kind: descriptor.kind,
    packageName: descriptor.name,
    rawSha256: sha256(bytes),
    sbom,
    sbomSha256,
    sourceSha: null,
    tarball,
    target: descriptor.target,
    version: descriptor.version,
  };
}

async function tarEntry(tarball, entry) {
  const { stdout } = await execFileAsync("tar", ["-xOf", tarball, entry], {
    encoding: null,
    maxBuffer: 128 * 1024 * 1024,
  });
  return stdout;
}

async function tarFiles(tarball) {
  const { stdout } = await execFileAsync("tar", ["-tf", tarball], {
    encoding: "utf8",
    maxBuffer: 8 * 1024 * 1024,
  });
  return stdout
    .split(/\r?\n/u)
    .filter((entry) => entry.startsWith("package/") && !entry.endsWith("/"))
    .map((entry) => entry.slice("package/".length))
    .sort();
}

export async function inspectPlatformTarball({ tarballPath, target, version, sourceSha, integrity }) {
  const descriptor = {
    kind: "platform",
    name: insightsEnginePackageName(target.target),
    target: target.target,
    version,
  };
  const [tarballBytes, rawPackageDocument, rawBuildManifest, files] = await Promise.all([
    readFile(tarballPath),
    tarEntry(tarballPath, "package/package.json"),
    tarEntry(tarballPath, "package/build-manifest.json"),
    tarFiles(tarballPath),
  ]);
  const actualIntegrity = sha512Integrity(tarballBytes);
  if (integrity && actualIntegrity !== integrity) {
    throw new Error(`${descriptor.name} tarball integrity mismatch`);
  }
  validatePackOutput(
    [{
      entryCount: files.length,
      files: files.map((file) => ({ path: file })),
      integrity: actualIntegrity,
      name: descriptor.name,
      version,
    }],
    descriptor,
  );
  const packageDocument = JSON.parse(rawPackageDocument);
  if (canonicalJson(packageDocument) !== canonicalJson(createPlatformManifest(target, version))) {
    throw new Error(`${descriptor.name} package metadata mismatch`);
  }
  const buildManifest = JSON.parse(rawBuildManifest);
  if (!Buffer.from(canonicalJson(buildManifest)).equals(rawBuildManifest)) {
    throw new Error(`${descriptor.name} build manifest must be canonical JSON`);
  }
  const binaryBytes = await tarEntry(tarballPath, `package/${buildManifest.binary}`);
  const expectedBuildManifest = createBuildManifest({
    target,
    version,
    sourceSha,
    binaryBytes,
    sqliteVersion: buildManifest.sqliteVersion,
  });
  if (canonicalJson(buildManifest) !== canonicalJson(expectedBuildManifest)) {
    throw new Error(`${descriptor.name} build manifest is invalid`);
  }
  return {
    binaryBytes,
    buildManifest,
    buildManifestDigest: sha256(rawBuildManifest),
    integrity: actualIntegrity,
    packageDocument,
    rawSha256: sha256(tarballBytes),
  };
}

function assertRegistryArtifact(document, descriptor, sourceSha, inspection) {
  const keys = [
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
    Object.keys(document).sort().join("\n") !== keys.join("\n") ||
    document.format !== "threadshare-insights-registry-artifact@v1" ||
    document.packageName !== descriptor.name ||
    document.sourceSha !== sourceSha ||
    document.target !== descriptor.target ||
    document.version !== descriptor.version ||
    document.buildManifestDigest !== inspection.buildManifestDigest ||
    document.integrity !== inspection.integrity ||
    document.rawSha256 !== inspection.rawSha256
  ) {
    throw new Error(`${descriptor.name} registry artifact is invalid`);
  }
}

async function copySbom(descriptor, stagingDirectory, outputDirectory) {
  const sbom = `${descriptor.target}.spdx.json`;
  const sbomBytes = await readFile(path.join(stagingDirectory, "metadata", sbom));
  await writeFile(path.join(outputDirectory, sbom), sbomBytes, { mode: 0o600 });
  return { sbom, sbomSha256: sha256(sbomBytes) };
}

async function packExisting(descriptor, stagingDirectory, outputDirectory, sourceSha) {
  const sourceTarball = path.join(stagingDirectory, "existing", `${descriptor.target}.tgz`);
  const registryBytes = await readFile(
    path.join(stagingDirectory, "existing", `${descriptor.target}.registry.json`),
  );
  const registry = JSON.parse(registryBytes);
  if (!Buffer.from(canonicalJson(registry)).equals(registryBytes)) {
    throw new Error(`${descriptor.name} registry artifact must be canonical JSON`);
  }
  const target = INSIGHTS_ENGINE_RELEASE_TARGETS.find(
    (candidate) => candidate.target === descriptor.target,
  );
  const inspection = await inspectPlatformTarball({
    tarballPath: sourceTarball,
    target,
    version: descriptor.version,
    sourceSha,
    integrity: registry.integrity,
  });
  assertRegistryArtifact(registry, descriptor, sourceSha, inspection);
  const tarball = `threadshare-insights-${descriptor.target}-${descriptor.version}.tgz`;
  await copyFile(sourceTarball, path.join(outputDirectory, tarball));
  const { sbom, sbomSha256 } = await copySbom(descriptor, stagingDirectory, outputDirectory);
  return {
    buildManifestDigest: inspection.buildManifestDigest,
    integrity: inspection.integrity,
    kind: descriptor.kind,
    packageName: descriptor.name,
    rawSha256: inspection.rawSha256,
    sbom,
    sbomSha256,
    sourceSha,
    tarball,
    target: descriptor.target,
    version: descriptor.version,
  };
}

export async function packReleaseArtifacts({
  stagingDirectory,
  outputDirectory,
  version,
  sourceSha,
  runId,
  runAttempt,
  npmCommand = "npm",
}) {
  if (!GIT_OBJECT_ID.test(sourceSha)) {
    throw new TypeError("sourceSha must be a lowercase Git object id");
  }
  if (!/^[1-9][0-9]*$/u.test(String(runId)) || !/^[1-9][0-9]*$/u.test(String(runAttempt))) {
    throw new TypeError("runId and runAttempt must be positive decimal values");
  }
  await ensureEmptyDirectory(outputDirectory);
  const packages = [];
  for (const descriptor of descriptors(stagingDirectory, version)) {
    let item;
    if (descriptor.kind === "platform") {
      try {
        item = await packExisting(descriptor, stagingDirectory, outputDirectory, sourceSha);
      } catch (error) {
        if (error?.code !== "ENOENT") throw error;
      }
    }
    item ??= await packOne(descriptor, outputDirectory, npmCommand);
    item.sourceSha = sourceSha;
    packages.push(item);
  }
  const manifest = {
    format: "threadshare-insights-release@v1",
    packages,
    runAttempt: String(runAttempt),
    runId: String(runId),
    sourceSha,
    version,
  };
  await writeFile(path.join(outputDirectory, MANIFEST_NAME), canonicalJson(manifest), { mode: 0o600 });
  return manifest;
}

function assertReleaseManifest(manifest, expected = {}) {
  const manifestKeys = ["format", "packages", "runAttempt", "runId", "sourceSha", "version"];
  const itemKeys = [
    "buildManifestDigest",
    "integrity",
    "kind",
    "packageName",
    "rawSha256",
    "sbom",
    "sbomSha256",
    "sourceSha",
    "tarball",
    "target",
    "version",
  ];
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join("\n") !== manifestKeys.join("\n") ||
    manifest?.format !== "threadshare-insights-release@v1" ||
    !Array.isArray(manifest.packages) ||
    manifest.packages.length !== INSIGHTS_ENGINE_RELEASE_TARGETS.length + 1 ||
    !GIT_OBJECT_ID.test(manifest.sourceSha) ||
    !/^(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)\.(?:0|[1-9][0-9]*)$/u.test(manifest.version) ||
    !/^[1-9][0-9]*$/u.test(manifest.runId) ||
    !/^[1-9][0-9]*$/u.test(manifest.runAttempt) ||
    (expected.sourceSha && manifest.sourceSha !== expected.sourceSha) ||
    (expected.version && manifest.version !== expected.version) ||
    (expected.runId && manifest.runId !== String(expected.runId)) ||
    (expected.runAttempt && manifest.runAttempt !== String(expected.runAttempt))
  ) {
    throw new Error("release manifest identity is invalid");
  }
  for (const item of manifest.packages) {
    if (
      !item ||
      typeof item !== "object" ||
      Array.isArray(item) ||
      Object.keys(item).sort().join("\n") !== itemKeys.join("\n") ||
      !new Set(["platform", "root"]).has(item.kind) ||
      typeof item.packageName !== "string" ||
      item.version !== manifest.version ||
      item.sourceSha !== manifest.sourceSha ||
      !HEX_64.test(item.rawSha256) ||
      !INTEGRITY.test(item.integrity) ||
      typeof item.tarball !== "string" ||
      path.basename(item.tarball) !== item.tarball ||
      (item.kind === "root" &&
        (item.target !== null || item.buildManifestDigest !== null ||
          item.sbom !== null || item.sbomSha256 !== null)) ||
      (item.kind === "platform" &&
        (typeof item.target !== "string" || !HEX_64.test(item.buildManifestDigest) ||
          typeof item.sbom !== "string" || path.basename(item.sbom) !== item.sbom ||
          !HEX_64.test(item.sbomSha256)))
    ) {
      throw new Error("release manifest package entry is invalid");
    }
  }
}

export async function verifyReleaseArtifacts({ artifactDirectory, ...expected }) {
  const manifestBytes = await readFile(path.join(artifactDirectory, MANIFEST_NAME));
  const manifest = JSON.parse(manifestBytes);
  if (!Buffer.from(canonicalJson(manifest)).equals(manifestBytes)) {
    throw new Error("release manifest must be canonical JSON");
  }
  assertReleaseManifest(manifest, expected);
  const expectedNames = new Set([
    ...INSIGHTS_ENGINE_RELEASE_TARGETS.map((target) => insightsEnginePackageName(target.target)),
    PACKAGE_NAME,
  ]);
  for (const item of manifest.packages) {
    if (!expectedNames.delete(item.packageName) || !INTEGRITY.test(item.integrity)) {
      throw new Error("release manifest package set is invalid");
    }
    const tarballPath = path.join(artifactDirectory, path.basename(item.tarball));
    if (path.basename(item.tarball) !== item.tarball) throw new Error("tarball name must be local");
    const tarballBytes = await readFile(tarballPath);
    if (sha256(tarballBytes) !== item.rawSha256 || sha512Integrity(tarballBytes) !== item.integrity) {
      throw new Error(`${item.packageName} artifact digest mismatch`);
    }
    const packageDocument = JSON.parse(await tarEntry(tarballPath, "package/package.json"));
    if (packageDocument.name !== item.packageName || packageDocument.version !== manifest.version) {
      throw new Error(`${item.packageName} package metadata mismatch`);
    }
    if (item.kind === "root") {
      const expectedOptional = Object.fromEntries(
        INSIGHTS_ENGINE_RELEASE_TARGETS
          .map((target) => insightsEnginePackageName(target.target))
          .sort()
          .map((name) => [name, manifest.version]),
      );
      if (canonicalJson(packageDocument.optionalDependencies) !== canonicalJson(expectedOptional)) {
        throw new Error("staged root optional dependencies are invalid");
      }
    } else {
      const target = INSIGHTS_ENGINE_RELEASE_TARGETS.find(
        (candidate) => candidate.target === item.target,
      );
      if (!target) throw new Error("platform artifact target is invalid");
      const rawBuildManifest = await tarEntry(tarballPath, "package/build-manifest.json");
      if (sha256(rawBuildManifest) !== item.buildManifestDigest) {
        throw new Error(`${item.packageName} build manifest digest mismatch`);
      }
      const buildManifest = JSON.parse(rawBuildManifest);
      if (
        !Buffer.from(canonicalJson(buildManifest)).equals(rawBuildManifest) ||
        buildManifest.sourceSha !== manifest.sourceSha ||
        buildManifest.target !== target.target ||
        buildManifest.version !== manifest.version
      ) {
        throw new Error(`${item.packageName} build manifest is invalid`);
      }
      const binaryBytes = await tarEntry(tarballPath, `package/${buildManifest.binary}`);
      if (sha256(binaryBytes) !== buildManifest.binarySha256) {
        throw new Error(`${item.packageName} binary digest mismatch`);
      }
      const sbomBytes = await readFile(path.join(artifactDirectory, item.sbom));
      const sbom = JSON.parse(sbomBytes);
      if (
        sha256(sbomBytes) !== item.sbomSha256 ||
        !Buffer.from(canonicalJson(sbom)).equals(sbomBytes) ||
        sbom.spdxVersion !== "SPDX-2.3" ||
        !String(sbom.documentNamespace).includes(`/${manifest.sourceSha}/${target.target}`)
      ) {
        throw new Error(`${item.packageName} SBOM is invalid`);
      }
    }
  }
  if (expectedNames.size !== 0) throw new Error("release manifest is missing packages");
  return manifest;
}

function parseArguments(argv) {
  const [command, ...tokens] = argv;
  if (!new Set(["pack", "verify"]).has(command)) {
    throw new Error("Usage: package-insights-release <pack|verify> [options]");
  }
  const options = {};
  for (let index = 0; index < tokens.length; index += 2) {
    const key = tokens[index];
    const value = tokens[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("release artifact option is invalid");
    options[key.slice(2).replaceAll("-", "_")] = value;
  }
  return { command, options };
}

async function main() {
  const { command, options } = parseArguments(process.argv.slice(2));
  if (command === "pack") {
    const manifest = await packReleaseArtifacts({
      stagingDirectory: path.resolve(options.staging),
      outputDirectory: path.resolve(options.output),
      version: options.version,
      sourceSha: options.source_sha,
      runId: options.run_id,
      runAttempt: options.run_attempt,
    });
    process.stdout.write(`${canonicalJson(manifest)}\n`);
    return;
  }
  const manifest = await verifyReleaseArtifacts({
    artifactDirectory: path.resolve(options.artifacts),
    version: options.version,
    sourceSha: options.source_sha,
    runId: options.run_id,
    runAttempt: options.run_attempt,
  });
  process.stdout.write(`${canonicalJson(manifest)}\n`);
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
