import { createHash } from "node:crypto";
import { constants as fsConstants } from "node:fs";
import { access, readFile, stat } from "node:fs/promises";
import { createRequire } from "node:module";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { canonicalJson } from "./canonical-json.mjs";
import {
  INSIGHTS_ENGINE_TARGETS,
  insightsEnginePackageName,
  insightsEngineTarget,
} from "./insights-engine-targets.mjs";

export {
  INSIGHTS_ENGINE_TARGETS,
  insightsEnginePackageName,
  insightsEngineTarget,
};

const require = createRequire(import.meta.url);
const ROOT_PACKAGE_PATH = fileURLToPath(new URL("../package.json", import.meta.url));
const ENGINE_BASENAME = "threadshare-insights-engine";
const BUILD_MANIFEST = "build-manifest.json";

export class InsightsEngineRuntimeError extends Error {
  constructor(code, message, options = {}) {
    super(message, options);
    this.name = "InsightsEngineRuntimeError";
    this.code = code;
    this.failureKind = options.failureKind ?? "engine_runtime";
  }
}

function runtimeError(code, message, cause) {
  return new InsightsEngineRuntimeError(code, message, {
    cause,
    failureKind: code === "TS_INSIGHTS_ENGINE_UNAVAILABLE"
      ? "engine_unavailable"
      : "engine_invalid",
  });
}

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

function validHex64(value) {
  return typeof value === "string" && /^[0-9a-f]{64}$/u.test(value);
}

function validGitObjectId(value) {
  return typeof value === "string" && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/u.test(value);
}

async function assertBinary(pathname, platform) {
  try {
    const info = await stat(pathname);
    if (!info.isFile()) throw new Error("not a file");
    if (platform !== "win32") await access(pathname, fsConstants.X_OK);
  } catch (cause) {
    throw runtimeError(
      "TS_INSIGHTS_ENGINE_UNAVAILABLE",
      "the Insights Engine binary is missing or not executable",
      cause,
    );
  }
}

async function rootVersion(packagePath = ROOT_PACKAGE_PATH) {
  const metadata = JSON.parse(await readFile(packagePath, "utf8"));
  if (typeof metadata.version !== "string" || metadata.version.length === 0) {
    throw runtimeError(
      "TS_INSIGHTS_ENGINE_INVALID",
      "the Threadshare package version is invalid",
    );
  }
  return metadata.version;
}

function validateBuildManifest(manifest, expected) {
  const expectedKeys = [
    "abi",
    "binary",
    "binarySha256",
    "format",
    "license",
    "minimumOs",
    "packageName",
    "protocolVersion",
    "rustTarget",
    "sourceSha",
    "sqliteVersion",
    "target",
    "version",
  ];
  if (
    !manifest ||
    typeof manifest !== "object" ||
    Array.isArray(manifest) ||
    Object.keys(manifest).sort().join("\n") !== expectedKeys.join("\n") ||
    manifest.format !== "threadshare-insights-build@v1" ||
    manifest.packageName !== expected.packageName ||
    manifest.version !== expected.version ||
    manifest.target !== expected.target.target ||
    manifest.rustTarget !== expected.target.rustTarget ||
    manifest.abi !== expected.target.abi ||
    manifest.minimumOs !== expected.target.minimumOs ||
    manifest.license !== "MIT" ||
    manifest.protocolVersion !== 1 ||
    manifest.binary !== expected.binaryName ||
    !validHex64(manifest.binarySha256) ||
    !validGitObjectId(manifest.sourceSha) ||
    typeof manifest.sqliteVersion !== "string" ||
    !/^3\.[0-9]+\.[0-9]+$/u.test(manifest.sqliteVersion)
  ) {
    throw runtimeError(
      "TS_INSIGHTS_ENGINE_INVALID",
      "the Insights Engine build manifest is incompatible",
    );
  }
}

export async function resolveInsightsEngine(options = {}) {
  const platform = options.platform ?? process.platform;
  const arch = options.arch ?? process.arch;
  const environment = options.env ?? process.env;
  const override = environment.THREADSHARE_INSIGHTS_ENGINE_PATH;
  if (override) {
    const binaryPath = path.resolve(override);
    await assertBinary(binaryPath, platform);
    return Object.freeze({
      source: "override",
      binaryPath,
      target: insightsEngineTarget(platform, arch)?.target ?? null,
      packageName: null,
      version: null,
      buildManifest: null,
      buildManifestDigest: null,
    });
  }

  const target = insightsEngineTarget(platform, arch);
  if (!target) {
    throw runtimeError(
      "TS_INSIGHTS_ENGINE_UNAVAILABLE",
      "Insights is not available for this operating system and architecture",
    );
  }
  const packageName = insightsEnginePackageName(target.target);
  const version = options.version ?? await rootVersion(options.rootPackagePath);
  let packagePath;
  try {
    packagePath = (options.resolvePackage ?? require.resolve)(`${packageName}/package.json`);
  } catch (cause) {
    throw runtimeError(
      "TS_INSIGHTS_ENGINE_UNAVAILABLE",
      "the platform Insights Engine package is not installed",
      cause,
    );
  }
  const packageRoot = path.dirname(packagePath);
  const binaryName = platform === "win32" ? `${ENGINE_BASENAME}.exe` : ENGINE_BASENAME;
  const binaryPath = path.join(packageRoot, "bin", binaryName);
  const manifestPath = path.join(packageRoot, BUILD_MANIFEST);
  let packageMetadata;
  let buildManifest;
  let manifestBytes;
  try {
    [packageMetadata, manifestBytes] = await Promise.all([
      readFile(packagePath, "utf8").then(JSON.parse),
      readFile(manifestPath),
    ]);
    buildManifest = JSON.parse(manifestBytes.toString("utf8"));
  } catch (cause) {
    throw runtimeError(
      "TS_INSIGHTS_ENGINE_INVALID",
      "the platform Insights Engine package metadata is invalid",
      cause,
    );
  }
  if (
    packageMetadata.name !== packageName ||
    packageMetadata.version !== version ||
    packageMetadata.os?.length !== 1 ||
    packageMetadata.os[0] !== target.os ||
    packageMetadata.cpu?.length !== 1 ||
    packageMetadata.cpu[0] !== target.cpu
  ) {
    throw runtimeError(
      "TS_INSIGHTS_ENGINE_INVALID",
      "the platform Insights Engine package does not match this installation",
    );
  }
  validateBuildManifest(buildManifest, {
    packageName,
    version,
    target,
    binaryName: `bin/${binaryName}`,
  });
  await assertBinary(binaryPath, platform);
  const binaryBytes = await readFile(binaryPath);
  if (sha256(binaryBytes) !== buildManifest.binarySha256) {
    throw runtimeError(
      "TS_INSIGHTS_ENGINE_INVALID",
      "the Insights Engine binary checksum does not match its build manifest",
    );
  }
  const canonicalManifest = Buffer.from(canonicalJson(buildManifest));
  if (!canonicalManifest.equals(manifestBytes)) {
    throw runtimeError(
      "TS_INSIGHTS_ENGINE_INVALID",
      "the Insights Engine build manifest is not canonical JSON",
    );
  }
  return Object.freeze({
    source: "package",
    binaryPath,
    target: target.target,
    packageName,
    version,
    buildManifest: Object.freeze({ ...buildManifest }),
    buildManifestDigest: sha256(canonicalManifest),
  });
}
