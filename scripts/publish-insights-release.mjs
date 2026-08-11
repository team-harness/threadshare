#!/usr/bin/env node

import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { promisify } from "node:util";
import { pathToFileURL } from "node:url";

import {
  inspectPlatformTarball,
  verifyReleaseArtifacts,
} from "./package-insights-release.mjs";
import { INSIGHTS_ENGINE_RELEASE_TARGETS } from "../src/insights-engine-targets.mjs";
import {
  decidePublish,
  fetchPackument,
  validatePublishedRelease,
} from "./verify-release.mjs";

const execFileAsync = promisify(execFile);
const REGISTRY = "https://registry.npmjs.org";
const SLSA_PROVENANCE_V1 = "https://slsa.dev/provenance/v1";
const NPM_PROVENANCE_BUILD_TYPES = new Set([
  "https://github.com/npm/cli/gha/v2",
  "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
]);

function sha512HexFromIntegrity(integrity) {
  const encoded = integrity?.startsWith("sha512-") ? integrity.slice(7) : "";
  const bytes = Buffer.from(encoded, "base64");
  if (bytes.length !== 64 || `sha512-${bytes.toString("base64")}` !== integrity) {
    throw new Error("published integrity is not canonical SHA-512");
  }
  return bytes.toString("hex");
}

function attestationBundles(document) {
  if (Array.isArray(document)) return document.flatMap(attestationBundles);
  if (!document || typeof document !== "object") return [];
  const own = document.dsseEnvelope?.payload ? [document] : [];
  return [...own, ...Object.values(document).flatMap(attestationBundles)];
}

export function validateNpmProvenance(document, { integrity, sourceSha, tag }) {
  const expectedDigest = sha512HexFromIntegrity(integrity);
  for (const bundle of attestationBundles(document)) {
    let statement;
    try {
      statement = JSON.parse(Buffer.from(bundle.dsseEnvelope.payload, "base64url"));
    } catch {
      continue;
    }
    if (statement.predicateType !== SLSA_PROVENANCE_V1) continue;
    const subjectDigest = statement.subject
      ?.map((subject) => subject?.digest?.sha512)
      .find((digest) => typeof digest === "string" && digest.toLowerCase() === expectedDigest);
    const buildDefinition = statement.predicate?.buildDefinition;
    const dependencies = buildDefinition?.resolvedDependencies ?? [];
    const gitCommit = dependencies
      .map((dependency) => dependency?.digest?.gitCommit)
      .find((commit) => typeof commit === "string" && commit.toLowerCase() === sourceSha);
    const workflow = buildDefinition?.externalParameters?.workflow;
    const workflowMatches =
      statement._type === "https://in-toto.io/Statement/v1" &&
      NPM_PROVENANCE_BUILD_TYPES.has(buildDefinition?.buildType) &&
      workflow?.path === ".github/workflows/publish-npm.yml" &&
      workflow?.ref === `refs/tags/${tag}`;
    if (subjectDigest && gitCommit && workflowMatches) {
      return {
        gitCommit: gitCommit.toLowerCase(),
        subjectIntegrity: `sha512-${Buffer.from(subjectDigest, "hex").toString("base64")}`,
        workflow: workflow.path.slice(workflow.path.lastIndexOf("/") + 1),
      };
    }
  }
  throw new Error("npm provenance does not match the release artifact, workflow, tag, and source SHA");
}

export async function fetchProvenance(url, fetchImpl = globalThis.fetch) {
  if (typeof url !== "string" || !url.startsWith(`${REGISTRY}/`)) {
    throw new Error("npm attestation URL is invalid");
  }
  const response = await fetchImpl(url, {
    headers: { accept: "application/json", "cache-control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(15_000),
  });
  if (!response.ok) throw new Error(`npm attestation request returned HTTP ${response.status}`);
  return response.json();
}

export async function verifyRegistryAttestations({
  packageName,
  version,
  npmCommand = "npm",
  exec = execFileAsync,
}) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-npm-attestation-"));
  try {
    await mkdir(directory, { recursive: true, mode: 0o700 });
    await writeFile(path.join(directory, "package.json"), `${JSON.stringify({
      name: "threadshare-attestation-verifier",
      private: true,
      version: "0.0.0",
    })}\n`, { mode: 0o600 });
    await exec(
      npmCommand,
      [
        "install",
        `${packageName}@${version}`,
        "--ignore-scripts",
        "--no-audit",
        "--no-fund",
        "--force",
        "--save-exact",
        `--registry=${REGISTRY}`,
      ],
      { cwd: directory, encoding: "utf8", maxBuffer: 16 * 1024 * 1024 },
    );
    await exec(
      npmCommand,
      [
        "audit",
        "signatures",
        "--json",
        "--include-attestations",
        `--registry=${REGISTRY}`,
      ],
      { cwd: directory, encoding: "utf8", maxBuffer: 32 * 1024 * 1024 },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

async function confirmPackage(item, manifest, fetchImpl, auditExec, npmCommand) {
  let lastError;
  for (let attempt = 0; attempt < 8; attempt += 1) {
    try {
      const packument = await fetchPackument({
        packageName: item.packageName,
        allowMissing: item.kind === "platform",
        fetchImpl,
        maxAttempts: 1,
      });
      await verifyRegistryAttestations({
        packageName: item.packageName,
        version: manifest.version,
        npmCommand,
        exec: auditExec,
      });
      const published = packument.versions[manifest.version];
      const provenanceDocument = await fetchProvenance(published?.dist?.attestations?.url, fetchImpl);
      const provenance = validateNpmProvenance(provenanceDocument, {
        integrity: published.dist.integrity,
        sourceSha: manifest.sourceSha,
        tag: manifest.version,
      });
      return validatePublishedRelease({
        packument,
        packageName: item.packageName,
        version: manifest.version,
        integrity: item.integrity,
        kind: item.kind,
        provenance,
        sourceSha: manifest.sourceSha,
      });
    } catch (error) {
      lastError = error;
      if (attempt + 1 < 8) await new Promise((resolve) => setTimeout(resolve, 2_000 * (attempt + 1)));
    }
  }
  throw new Error(`${item.packageName} registry confirmation failed: ${lastError.message}`);
}

async function inspectPublishedPlatform({
  item,
  manifest,
  packument,
  fetchImpl,
}) {
  const target = INSIGHTS_ENGINE_RELEASE_TARGETS.find(
    (candidate) => candidate.target === item.target,
  );
  if (!target) throw new Error(`${item.packageName} release target is invalid`);
  const published = packument.versions[manifest.version];
  const tarballUrl = published?.dist?.tarball;
  if (typeof tarballUrl !== "string" || !tarballUrl.startsWith(`${REGISTRY}/`)) {
    throw new Error(`${item.packageName} registry tarball URL is invalid`);
  }
  const response = await fetchImpl(tarballUrl, {
    headers: { "cache-control": "no-cache" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`${item.packageName} registry tarball request returned HTTP ${response.status}`);
  }
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-published-platform-"));
  try {
    const tarballPath = path.join(directory, "package.tgz");
    await writeFile(tarballPath, Buffer.from(await response.arrayBuffer()), { mode: 0o600 });
    await inspectPlatformTarball({
      tarballPath,
      target,
      version: manifest.version,
      sourceSha: manifest.sourceSha,
      integrity: published.dist.integrity,
    });
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
}

export async function publishReleaseArtifacts({
  artifactDirectory,
  version,
  sourceSha,
  runId,
  runAttempt,
  kind = "all",
  fetchImpl = globalThis.fetch,
  exec = execFileAsync,
  auditExec = execFileAsync,
  npmCommand = "npm",
}) {
  if (!new Set(["all", "platform", "root"]).has(kind)) {
    throw new TypeError("kind must be all, platform, or root");
  }
  const manifest = await verifyReleaseArtifacts({
    artifactDirectory,
    version,
    sourceSha,
    runId,
    runAttempt,
  });
  const outcomes = [];
  const packages = kind === "all"
    ? manifest.packages
    : manifest.packages.filter((item) => item.kind === kind);
  if (packages.length === 0) throw new Error(`release manifest has no ${kind} packages`);
  for (const item of packages) {
    const packument = await fetchPackument({
      packageName: item.packageName,
      allowMissing: item.kind === "platform",
      fetchImpl,
    });
    const decision = decidePublish({
      packument,
      packageName: item.packageName,
      version,
      integrity: item.integrity,
      kind: item.kind,
    });
    if (decision.shouldPublish) {
      await exec(
        "npm",
        [
          "publish",
          path.join(artifactDirectory, item.tarball),
          "--ignore-scripts",
          "--access",
          "public",
          "--provenance",
          `--registry=${REGISTRY}`,
        ],
        { encoding: "utf8", maxBuffer: 8 * 1024 * 1024 },
      );
    } else if (item.kind === "platform") {
      await inspectPublishedPlatform({
        item,
        manifest,
        packument,
        fetchImpl,
      });
    }
    const confirmed = await confirmPackage(item, manifest, fetchImpl, auditExec, npmCommand);
    outcomes.push({ packageName: item.packageName, published: decision.shouldPublish, ...confirmed });
  }
  return outcomes;
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value) throw new Error("publish release option is invalid");
    options[key.slice(2).replaceAll("-", "_")] = value;
  }
  return options;
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (isMain) {
  const options = parseArguments(process.argv.slice(2));
  publishReleaseArtifacts({
    artifactDirectory: path.resolve(options.artifacts),
    version: options.version,
    sourceSha: options.source_sha,
    runId: options.run_id,
    runAttempt: options.run_attempt,
    kind: options.kind ?? "all",
  }).then(
    (outcomes) => process.stdout.write(`${JSON.stringify(outcomes)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
