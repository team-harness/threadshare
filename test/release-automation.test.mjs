import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { createHash } from "node:crypto";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath, pathToFileURL } from "node:url";
import { promisify } from "node:util";
import { parse as parseYaml } from "yaml";
import {
  EXPECTED_PACKAGE_FILES,
  PLATFORM_PACKAGE_NAMES,
  assertPreparedIntegrity,
  compareStableVersions,
  decidePublish,
  fetchPackument,
  npmPackFilename,
  parseArguments,
  validatePackOutput,
  validatePublishedRelease,
  validateReleaseMetadata,
  writeOutputs,
} from "../scripts/verify-release.mjs";
import { validateSkillDirectory } from "../scripts/validate-skill.mjs";
import { fetchExistingInsightsEngine } from "../scripts/fetch-existing-insights-engine.mjs";
import {
  createBuildManifest,
  createPlatformManifest,
} from "../scripts/prepare-insights-release.mjs";
import {
  publishReleaseArtifacts,
  validateNpmProvenance,
  verifyRegistryAttestations,
} from "../scripts/publish-insights-release.mjs";
import { canonicalJson } from "../src/canonical-json.mjs";
import {
  INSIGHTS_ENGINE_RELEASE_TARGETS,
  INSIGHTS_ENGINE_TARGETS,
  insightsEnginePackageName,
} from "../src/insights-engine-targets.mjs";

const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const execFileAsync = promisify(execFile);
const expectedPackageFiles = [
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
  "schema/threadshare-history.v1.schema.json",
  "schema/threadshare-insights-activity-request.v1.schema.json",
  "schema/threadshare-insights-activity.v1.schema.json",
  "schema/threadshare-insights-capabilities.v1.schema.json",
  "schema/threadshare-insights-evidence.v1.schema.json",
  "schema/threadshare-insights-overview.v1.schema.json",
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
];
const integrity = "sha512-AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
const allowedJobEnvContexts = new Set([
  "github",
  "inputs",
  "matrix",
  "needs",
  "secrets",
  "strategy",
  "vars",
]);

function expressionContextRoots(value) {
  const roots = [];
  for (const expressionMatch of value.matchAll(/\$\{\{([\s\S]*?)\}\}/g)) {
    for (const contextMatch of expressionMatch[1].matchAll(
      /(?:^|[^\w.])([A-Za-z_][A-Za-z0-9_]*)\s*(?=\.|\[|\s*$)/g,
    )) {
      roots.push(contextMatch[1].toLowerCase());
    }
  }
  return roots;
}

function packument({ latest = "0.4.1", versions = {} } = {}) {
  return {
    name: "@team-harness/threadshare",
    "dist-tags": { latest },
    versions: { [latest]: {}, ...versions },
  };
}

test("validates stable release metadata and numeric semver ordering", () => {
  assert.deepEqual(
    validateReleaseMetadata({
      tag: "0.4.2",
      packageJson: { name: "@team-harness/threadshare", version: "0.4.2" },
      packageLock: {
        name: "@team-harness/threadshare",
        version: "0.4.2",
        packages: { "": { name: "@team-harness/threadshare", version: "0.4.2" } },
      },
    }),
    { name: "@team-harness/threadshare", version: "0.4.2" },
  );
  assert.equal(compareStableVersions("0.10.0", "0.9.9"), 1);
  assert.equal(compareStableVersions("1.0.0", "1.0.0"), 0);
  assert.throws(
    () =>
      validateReleaseMetadata({
        tag: "v0.4.2",
        packageJson: { name: "@team-harness/threadshare", version: "0.4.2" },
        packageLock: { version: "0.4.2", packages: { "": { version: "0.4.2" } } },
      }),
    /stable semver/,
  );
});

test("locks npm pack to the exact public root files", () => {
  assert.deepEqual(EXPECTED_PACKAGE_FILES, expectedPackageFiles);
  const packed = {
    name: "@team-harness/threadshare",
    version: "0.4.2",
    integrity,
    size: 128 * 1024,
    unpackedSize: 512 * 1024,
    entryCount: expectedPackageFiles.length,
    files: expectedPackageFiles.map((filePath) => ({ path: filePath })),
  };
  assert.deepEqual(
    validatePackOutput(
      { "@team-harness/threadshare": packed },
      { name: "@team-harness/threadshare", version: "0.4.2" },
    ),
    { integrity, files: expectedPackageFiles },
  );
  assert.deepEqual(
    validatePackOutput([packed], {
      name: "@team-harness/threadshare",
      version: "0.4.2",
    }),
    { integrity, files: expectedPackageFiles },
  );
  assert.throws(
    () =>
      validatePackOutput(
        [
          {
            name: "@team-harness/threadshare",
            version: "0.4.2",
            integrity,
            entryCount: expectedPackageFiles.length + 1,
            files: [...expectedPackageFiles, "scripts/verify-release.mjs"].map((filePath) => ({
              path: filePath,
            })),
          },
        ],
        { name: "@team-harness/threadshare", version: "0.4.2" },
      ),
    /package files/,
  );
  assert.throws(
    () => validatePackOutput([{ ...packed, size: 256 * 1024 + 1 }], {
      name: "@team-harness/threadshare",
      version: "0.4.2",
    }),
    /compressed size/,
  );
  assert.throws(
    () => validatePackOutput([{ ...packed, unpackedSize: 1024 * 1024 + 1 }], {
      name: "@team-harness/threadshare",
      version: "0.4.2",
    }),
    /unpacked size/,
  );
});

test("reads npm pack filenames from npm 12 objects and legacy arrays", async (t) => {
  const filename = "team-harness-threadshare-0.7.0.tgz";
  const packed = {
    filename,
    name: "@team-harness/threadshare",
  };
  assert.equal(
    npmPackFilename({ "@team-harness/threadshare": packed }, "@team-harness/threadshare"),
    filename,
  );
  assert.equal(npmPackFilename([packed], "@team-harness/threadshare"), filename);
  assert.throws(
    () => npmPackFilename({ "@team-harness/other": packed }, "@team-harness/threadshare"),
    /exactly one package/,
  );
  assert.throws(
    () => npmPackFilename([{ ...packed, name: "@team-harness/other" }], "@team-harness/threadshare"),
    /name must match/,
  );

  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-pack-output-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const inputFile = path.join(directory, "pack.json");
  await writeFile(inputFile, JSON.stringify({ "@team-harness/threadshare": packed }));
  const resolved = await execFileAsync(process.execPath, [
    path.join(root, "scripts", "resolve-npm-pack-filename.mjs"),
    inputFile,
    "@team-harness/threadshare",
  ]);
  assert.equal(resolved.stdout, `${filename}\n`);
  assert.equal(resolved.stderr, "");
});

test("platform packages use a separate four-file allowlist", () => {
  const packageName = "@team-harness/threadshare-linux-x64";
  const files = [
    "LICENSE",
    "bin/threadshare-insights-engine",
    "build-manifest.json",
    "package.json",
  ];
  assert.equal(PLATFORM_PACKAGE_NAMES.length, 6);
  assert.deepEqual(
    validatePackOutput(
      [{ name: packageName, version: "0.4.2", integrity, entryCount: 4, files: files.map((path) => ({ path })) }],
      { name: packageName, version: "0.4.2", kind: "platform", target: "linux-x64" },
    ),
    { integrity, files },
  );
});

test("publishes only above the highest stable version and skips identical existing content", () => {
  assert.deepEqual(
    decidePublish({
      packument: packument(),
      packageName: "@team-harness/threadshare",
      version: "0.4.2",
      integrity,
    }),
    { latest: "0.4.1", shouldPublish: true },
  );
  assert.throws(
    () =>
      decidePublish({
        packument: packument({ latest: "0.4.3" }),
        packageName: "@team-harness/threadshare",
        version: "0.4.2",
        integrity,
      }),
    /newer than highest published stable/,
  );
  assert.throws(
    () =>
      decidePublish({
        packument: packument({ latest: "0.4.1", versions: { "0.4.3": {} } }),
        packageName: "@team-harness/threadshare",
        version: "0.4.2",
        integrity,
      }),
    /highest published stable 0\.4\.3/,
  );
  assert.deepEqual(
    decidePublish({
      packument: packument({
        latest: "0.4.3",
        versions: { "0.4.2": { dist: { integrity } } },
      }),
      packageName: "@team-harness/threadshare",
      version: "0.4.2",
      integrity,
    }),
    { latest: "0.4.3", shouldPublish: false },
  );
  assert.throws(
    () =>
      decidePublish({
        packument: packument({
          versions: { "0.4.2": { dist: { integrity: "sha512-different" } } },
        }),
        packageName: "@team-harness/threadshare",
        version: "0.4.2",
        integrity,
      }),
    /integrity differs/,
  );
});

test("platform reruns trust immutable registry provenance instead of new signed bytes", () => {
  const packageName = "@team-harness/threadshare-linux-x64";
  const registryIntegrity = "sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB=";
  assert.deepEqual(
    decidePublish({
      packument: {
        name: packageName,
        "dist-tags": {
          bootstrap: "0.0.0-bootstrap.0",
          latest: "0.0.0-bootstrap.0",
        },
        versions: { "0.0.0-bootstrap.0": {} },
      },
      packageName,
      version: "0.4.2",
      integrity,
      kind: "platform",
    }),
    { latest: "0.0.0-bootstrap.0", shouldPublish: true },
  );
  const platformPackument = {
    name: packageName,
    "dist-tags": {
      bootstrap: "0.0.0-bootstrap.0",
      latest: "0.0.0-bootstrap.0",
    },
    versions: {
      "0.0.0-bootstrap.0": {},
      "0.4.2": {
        dist: {
          integrity: registryIntegrity,
          attestations: {
            url: "https://registry.npmjs.org/-/npm/v1/attestations/platform",
            provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          },
        },
      },
    },
  };
  assert.deepEqual(
    decidePublish({
      packument: platformPackument,
      packageName,
      version: "0.4.2",
      integrity,
      kind: "platform",
    }),
    { latest: "0.0.0-bootstrap.0", registryIntegrity, shouldPublish: false },
  );
  assert.doesNotThrow(() => assertPreparedIntegrity(integrity, registryIntegrity, { kind: "platform" }));
  assert.deepEqual(
    validatePublishedRelease({
      packument: platformPackument,
      packageName,
      version: "0.4.2",
      integrity,
      kind: "platform",
      sourceSha: "a".repeat(64),
      provenance: {
        workflow: "publish-npm.yml",
        gitCommit: "a".repeat(64),
        subjectIntegrity: registryIntegrity,
      },
    }),
    { latest: "0.0.0-bootstrap.0", registryIntegrity },
  );
});

test("validates verifier arguments, GitHub outputs, and prepared integrity", async () => {
  assert.deepEqual(parseArguments(["source", "--tag", "0.4.2"]), {
    command: "source",
    options: { tag: "0.4.2" },
  });
  assert.deepEqual(
    parseArguments(["prepare", "--tag", "0.4.2", "--github-output", "/tmp/output"]),
    {
      command: "prepare",
      options: { tag: "0.4.2", github_output: "/tmp/output" },
    },
  );
  assert.throws(
    () => parseArguments(["prepare", "--tag", "0.4.2", "--tag", "0.4.3"]),
    /Duplicate release verifier option/,
  );
  assert.throws(() => parseArguments(["confirm", "--tag", "0.4.2"]), /expected-integrity/);

  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-release-output-"));
  const outputPath = path.join(fixture, "github-output");
  try {
    await writeOutputs(outputPath, { integrity, should_publish: true, version: "0.4.2" });
    assert.equal(
      await readFile(outputPath, "utf8"),
      `integrity=${integrity}\nshould_publish=true\nversion=0.4.2\n`,
    );
    await assert.rejects(
      writeOutputs(outputPath, { unsafe: "value\nforged=true" }),
      /unsupported characters/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }

  assert.doesNotThrow(() => assertPreparedIntegrity(integrity, integrity));
  assert.throws(
    () => assertPreparedIntegrity(integrity, "sha512-BBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBBB="),
    /changed between prepare and confirm/,
  );
});

test("requires SLSA provenance and never treats registry signatures as attestations", () => {
  const published = packument({
    latest: "0.4.2",
    versions: {
      "0.4.2": {
        dist: {
          integrity,
          attestations: {
            url: "https://registry.npmjs.org/-/npm/v1/attestations/threadshare@0.4.2",
            provenance: { predicateType: "https://slsa.dev/provenance/v1" },
          },
        },
      },
    },
  });
  assert.deepEqual(
    validatePublishedRelease({
      packument: published,
      packageName: "@team-harness/threadshare",
      version: "0.4.2",
      integrity,
    }),
    { latest: "0.4.2" },
  );
  published.versions["0.4.3"] = {};
  published["dist-tags"].latest = "0.4.3";
  assert.deepEqual(
    validatePublishedRelease({
      packument: published,
      packageName: "@team-harness/threadshare",
      version: "0.4.2",
      integrity,
    }),
    { latest: "0.4.3" },
  );
  published.versions["0.4.1"] = {};
  published["dist-tags"].latest = "0.4.1";
  assert.throws(
    () =>
      validatePublishedRelease({
        packument: published,
        packageName: "@team-harness/threadshare",
        version: "0.4.2",
        integrity,
      }),
    /older than published release/,
  );
  published["dist-tags"].latest = "0.4.2";
  published.versions["0.4.2"].dist = { integrity, signatures: [{ sig: "registry" }] };
  assert.throws(
    () =>
      validatePublishedRelease({
        packument: published,
        packageName: "@team-harness/threadshare",
        version: "0.4.2",
        integrity,
      }),
    /provenance/,
  );
});

test("validates the npm DSSE subject, workflow, tag, and resolved git commit", () => {
  const realIntegrity = `sha512-${Buffer.alloc(64, 7).toString("base64")}`;
  const sourceSha = "a".repeat(64);
  const statement = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [{ digest: { sha512: Buffer.alloc(64, 7).toString("hex") } }],
    predicateType: "https://slsa.dev/provenance/v1",
    predicate: {
      buildDefinition: {
        buildType: "https://github.com/npm/cli/gha/v2",
        externalParameters: {
          workflow: {
            path: ".github/workflows/publish-npm.yml",
            ref: "refs/tags/0.4.2",
          },
        },
        resolvedDependencies: [{ digest: { gitCommit: sourceSha } }],
      },
    },
  };
  const document = {
    attestations: [{ dsseEnvelope: { payload: Buffer.from(JSON.stringify(statement)).toString("base64url") } }],
  };
  assert.deepEqual(
    validateNpmProvenance(document, { integrity: realIntegrity, sourceSha, tag: "0.4.2" }),
    {
      gitCommit: sourceSha,
      subjectIntegrity: realIntegrity,
      workflow: "publish-npm.yml",
    },
  );
  const npm12Statement = structuredClone(statement);
  npm12Statement.predicate.buildDefinition.buildType =
    "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1";
  assert.deepEqual(
    validateNpmProvenance(
      { dsseEnvelope: { payload: Buffer.from(JSON.stringify(npm12Statement)).toString("base64url") } },
      { integrity: realIntegrity, sourceSha, tag: "0.4.2" },
    ),
    {
      gitCommit: sourceSha,
      subjectIntegrity: realIntegrity,
      workflow: "publish-npm.yml",
    },
  );
  const wrongCommit = structuredClone(statement);
  wrongCommit.predicate.buildDefinition.resolvedDependencies[0].digest.gitCommit = "b".repeat(64);
  const tampered = {
    dsseEnvelope: { payload: Buffer.from(JSON.stringify(wrongCommit)).toString("base64url") },
  };
  assert.throws(
    () => validateNpmProvenance(tampered, { integrity: realIntegrity, sourceSha, tag: "0.4.2" }),
    /does not match/,
  );
  const spoofedWorkflow = structuredClone(statement);
  spoofedWorkflow.predicate.buildDefinition.externalParameters.workflow = {
    path: ".github/workflows/other.yml",
    ref: "refs/tags/other",
  };
  spoofedWorkflow.untrustedNote =
    ".github/workflows/publish-npm.yml refs/tags/0.4.2";
  assert.throws(
    () => validateNpmProvenance(
      { dsseEnvelope: { payload: Buffer.from(JSON.stringify(spoofedWorkflow)).toString("base64url") } },
      { integrity: realIntegrity, sourceSha, tag: "0.4.2" },
    ),
    /does not match/,
  );
});

test("registry probing accepts only a successful JSON packument", async () => {
  const valid = packument();
  let requestOptions;
  const result = await fetchPackument({
    packageName: "@team-harness/threadshare",
    maxAttempts: 1,
    fetchImpl: async (_url, options) => {
      requestOptions = options;
      return new Response(JSON.stringify(valid), {
        status: 200,
        headers: { "content-type": "application/json" },
      });
    },
    sleep: async () => {},
  });
  assert.deepEqual(result, valid);
  assert.equal(requestOptions.headers["cache-control"], "no-cache");
  for (const response of [
    new Response("missing", { status: 404 }),
    new Response("unavailable", { status: 503 }),
    new Response("not-json", {
      status: 200,
      headers: { "content-type": "application/json" },
    }),
  ]) {
    await assert.rejects(
      fetchPackument({
        packageName: "@team-harness/threadshare",
        maxAttempts: 1,
        fetchImpl: async () => response.clone(),
        sleep: async () => {},
      }),
      /registry packument/,
    );
  }
});

test("platform registry probing accepts the bootstrap and not-yet-created states", async () => {
  const packageName = "@team-harness/threadshare-linux-arm64";
  const missing = await fetchPackument({
    packageName,
    allowMissing: true,
    maxAttempts: 1,
    fetchImpl: async () => new Response("missing", { status: 404 }),
  });
  assert.deepEqual(missing, { name: packageName, "dist-tags": {}, versions: {} });
  const bootstrap = {
    name: packageName,
    "dist-tags": {
      bootstrap: "0.0.0-bootstrap.0",
      latest: "0.0.0-bootstrap.0",
    },
    versions: { "0.0.0-bootstrap.0": {} },
  };
  assert.deepEqual(
    await fetchPackument({
      packageName,
      allowMissing: true,
      maxAttempts: 1,
      fetchImpl: async () => Response.json(bootstrap),
    }),
    bootstrap,
  );
  await assert.rejects(
    fetchPackument({
      packageName,
      allowMissing: true,
      maxAttempts: 1,
      fetchImpl: async () => Response.json({
        ...bootstrap,
        "dist-tags": {
          bootstrap: "0.0.0-bootstrap.0",
          latest: "0.0.0-other.0",
        },
        versions: {
          ...bootstrap.versions,
          "0.0.0-other.0": {},
        },
      }),
    }),
    /registry latest must be a stable semver/,
  );
});

test("missing platform probe records the build path without creating package state", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-engine-probe-"));
  const githubOutput = path.join(fixture, "github-output");
  try {
    await writeFile(githubOutput, "");
    const result = await fetchExistingInsightsEngine({
      outputDirectory: path.join(fixture, "engine"),
      sourceSha: "a".repeat(40),
      targetName: "linux-x64",
      version: "0.6.1",
      githubOutput,
      fetchImpl: async () => new Response("missing", { status: 404 }),
    });
    assert.deepEqual(result, {
      exists: false,
      packageName: "@team-harness/threadshare-linux-x64",
      target: "linux-x64",
      version: "0.6.1",
    });
    assert.equal(await readFile(githubOutput, "utf8"), "exists=false\n");
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("platform build probe retries four transient registry failures", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-engine-retry-"));
  let attempts = 0;
  try {
    const result = await fetchExistingInsightsEngine({
      outputDirectory: path.join(fixture, "engine"),
      sourceSha: "a".repeat(40),
      targetName: "linux-x64",
      version: "0.6.1",
      fetchImpl: async () => {
        attempts += 1;
        return attempts < 4
          ? new Response("unavailable", { status: 503 })
          : new Response("missing", { status: 404 });
      },
      sleep: async () => {},
    });
    assert.equal(result.exists, false);
    assert.equal(attempts, 4);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("publish rechecks a platform tarball when build saw 404 and publish sees 200", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-engine-publish-race-"));
  const artifactDirectory = path.join(fixture, "artifacts");
  const version = "0.6.1";
  const sourceSha = "a".repeat(40);
  const sha256 = (value) => createHash("sha256").update(value).digest("hex");
  const sha512Integrity = (value) =>
    `sha512-${createHash("sha512").update(value).digest("base64")}`;
  const packages = [];
  let publishCalls = 0;
  try {
    await mkdir(artifactDirectory, { recursive: true });
    for (const target of INSIGHTS_ENGINE_RELEASE_TARGETS) {
      const packageParent = path.join(fixture, `package-${target.target}`);
      const packageDirectory = path.join(packageParent, "package");
      const binaryName = target.platform === "win32"
        ? "threadshare-insights-engine.exe"
        : "threadshare-insights-engine";
      const binaryBytes = Buffer.from(`fixture binary for ${target.target}\n`);
      const buildManifestBytes = Buffer.from(canonicalJson(createBuildManifest({
        target,
        version,
        sourceSha,
        binaryBytes,
        sqliteVersion: "3.53.2",
      })));
      await mkdir(path.join(packageDirectory, "bin"), { recursive: true });
      await Promise.all([
        writeFile(path.join(packageDirectory, "LICENSE"), "fixture license\n"),
        writeFile(path.join(packageDirectory, "bin", binaryName), binaryBytes),
        writeFile(path.join(packageDirectory, "build-manifest.json"), buildManifestBytes),
        writeFile(
          path.join(packageDirectory, "package.json"),
          canonicalJson(createPlatformManifest(target, version)),
        ),
      ]);
      const tarball = `${target.target}.tgz`;
      await execFileAsync(
        "tar",
        ["-czf", path.join(artifactDirectory, tarball), "-C", packageParent, "package"],
        { env: { ...process.env, COPYFILE_DISABLE: "1" } },
      );
      const tarballBytes = await readFile(path.join(artifactDirectory, tarball));
      const sbom = `${target.target}.spdx.json`;
      const sbomBytes = Buffer.from(canonicalJson({
        documentNamespace: `https://github.com/team-harness/threadshare/sbom/${sourceSha}/${target.target}`,
        spdxVersion: "SPDX-2.3",
      }));
      await writeFile(path.join(artifactDirectory, sbom), sbomBytes);
      packages.push({
        buildManifestDigest: sha256(buildManifestBytes),
        integrity: sha512Integrity(tarballBytes),
        kind: "platform",
        packageName: insightsEnginePackageName(target.target),
        rawSha256: sha256(tarballBytes),
        sbom,
        sbomSha256: sha256(sbomBytes),
        sourceSha,
        tarball,
        target: target.target,
        version,
      });
    }

    const rootParent = path.join(fixture, "package-root");
    const rootPackageDirectory = path.join(rootParent, "package");
    const optionalDependencies = Object.fromEntries(
      INSIGHTS_ENGINE_RELEASE_TARGETS
        .map((target) => insightsEnginePackageName(target.target))
        .sort()
        .map((packageName) => [packageName, version]),
    );
    await mkdir(rootPackageDirectory, { recursive: true });
    await writeFile(path.join(rootPackageDirectory, "package.json"), canonicalJson({
      name: "@team-harness/threadshare",
      optionalDependencies,
      version,
    }));
    const rootTarball = "root.tgz";
    await execFileAsync(
      "tar",
      ["-czf", path.join(artifactDirectory, rootTarball), "-C", rootParent, "package"],
      { env: { ...process.env, COPYFILE_DISABLE: "1" } },
    );
    const rootTarballBytes = await readFile(path.join(artifactDirectory, rootTarball));
    packages.push({
      buildManifestDigest: null,
      integrity: sha512Integrity(rootTarballBytes),
      kind: "root",
      packageName: "@team-harness/threadshare",
      rawSha256: sha256(rootTarballBytes),
      sbom: null,
      sbomSha256: null,
      sourceSha,
      tarball: rootTarball,
      target: null,
      version,
    });
    const manifest = {
      format: "threadshare-insights-release@v1",
      packages,
      runAttempt: "1",
      runId: "123",
      sourceSha,
      version,
    };
    await writeFile(
      path.join(artifactDirectory, "release-manifest.json"),
      canonicalJson(manifest),
    );

    const platformItem = packages.find((item) => item.target === "linux-x64");
    const buildProbe = await fetchExistingInsightsEngine({
      outputDirectory: path.join(fixture, "engine"),
      sourceSha,
      targetName: platformItem.target,
      version,
      fetchImpl: async () => new Response("missing", { status: 404 }),
    });
    assert.equal(buildProbe.exists, false);

    const responses = new Map();
    const tarballUrls = new Set();
    for (const item of packages.filter((candidate) => candidate.kind === "platform")) {
      const tarballBytes = await readFile(path.join(artifactDirectory, item.tarball));
      const packageUrl = `https://registry.npmjs.org/${item.packageName.replace("/", "%2f")}`;
      const tarballUrl = `https://registry.npmjs.org/${item.target}/${version}.tgz`;
      const attestationsUrl = `https://registry.npmjs.org/-/npm/v1/attestations/${item.target}`;
      const statement = {
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ digest: { sha512: createHash("sha512").update(tarballBytes).digest("hex") } }],
        predicateType: "https://slsa.dev/provenance/v1",
        predicate: {
          buildDefinition: {
            buildType: "https://github.com/npm/cli/gha/v2",
            externalParameters: {
              workflow: {
                path: ".github/workflows/publish-npm.yml",
                ref: `refs/tags/${version}`,
              },
            },
            resolvedDependencies: [{ digest: { gitCommit: sourceSha } }],
          },
        },
      };
      responses.set(packageUrl, () => Response.json({
        name: item.packageName,
        "dist-tags": { latest: version },
        versions: {
          [version]: {
            dist: {
              attestations: {
                provenance: { predicateType: "https://slsa.dev/provenance/v1" },
                url: attestationsUrl,
              },
              integrity: item.integrity,
              tarball: tarballUrl,
            },
          },
        },
      }));
      responses.set(tarballUrl, () => new Response(tarballBytes));
      responses.set(attestationsUrl, () => Response.json({
        attestations: [{
          dsseEnvelope: {
            payload: Buffer.from(JSON.stringify(statement)).toString("base64url"),
          },
        }],
      }));
      tarballUrls.add(tarballUrl);
    }
    const fetchedTarballs = [];
    const outcomes = await publishReleaseArtifacts({
      artifactDirectory,
      version,
      sourceSha,
      runId: "123",
      runAttempt: "1",
      kind: "platform",
      fetchImpl: async (url) => {
        const factory = responses.get(url);
        assert.ok(factory, `unexpected registry request: ${url}`);
        if (tarballUrls.has(url)) fetchedTarballs.push(url);
        return factory();
      },
      exec: async () => {
        publishCalls += 1;
      },
      auditExec: async () => ({ stdout: "{}", stderr: "" }),
    });
    assert.equal(publishCalls, 0);
    assert.equal(outcomes.length, INSIGHTS_ENGINE_RELEASE_TARGETS.length);
    assert.ok(outcomes.every((outcome) => outcome.latest === version && !outcome.published));
    assert.deepEqual(fetchedTarballs.sort(), [...tarballUrls].sort());
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release-time modules import from a clean tree without node_modules", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-release-clean-import-"));
  const modulePaths = [
    "src/canonical-json.mjs",
    "src/insights-engine-targets.mjs",
    "src/insights-engine-protocol.mjs",
    "src/insights-engine-runtime.mjs",
    "src/insights-engine-client.mjs",
    "scripts/build-insights-dashboard.mjs",
    "scripts/verify-release.mjs",
    "scripts/prepare-insights-release.mjs",
    "scripts/package-insights-release.mjs",
    "scripts/publish-insights-release.mjs",
    "scripts/fetch-existing-insights-engine.mjs",
    "scripts/generate-insights-sbom.mjs",
    "scripts/smoke-insights-engine.mjs",
    "scripts/smoke-installed-core.mjs",
    "scripts/smoke-installed-insights.mjs",
  ];
  try {
    for (const relative of modulePaths) {
      const destination = path.join(fixture, relative);
      await mkdir(path.dirname(destination), { recursive: true });
      await copyFile(path.join(root, relative), destination);
    }
    for (const relative of modulePaths) {
      await import(`${pathToFileURL(path.join(fixture, relative)).href}?clean-import`);
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("published platform verification delegates cryptography to npm audit signatures", async () => {
  const calls = [];
  let auditDirectory;
  await verifyRegistryAttestations({
    packageName: "@team-harness/threadshare-linux-x64",
    version: "0.6.1",
    npmCommand: "pinned-npm",
    exec: async (command, arguments_, options) => {
      calls.push({ command, arguments_, options });
      auditDirectory = options.cwd;
      return { stdout: "{}", stderr: "" };
    },
  });
  assert.equal(calls.length, 2);
  assert.equal(calls[0].command, "pinned-npm");
  assert.deepEqual(calls[0].arguments_.slice(0, 3), [
    "install",
    "@team-harness/threadshare-linux-x64@0.6.1",
    "--ignore-scripts",
  ]);
  assert.equal(
    calls[0].arguments_.includes("--force"),
    true,
    "registry attestation verification must install platform packages cross-platform",
  );
  assert.deepEqual(calls[1].arguments_.slice(0, 4), [
    "audit",
    "signatures",
    "--json",
    "--include-attestations",
  ]);
  await assert.rejects(readFile(path.join(auditDirectory, "package.json")), /ENOENT/);
});

test("validates the bundled Skill and rejects metadata drift", async () => {
  await assert.doesNotReject(validateSkillDirectory(path.join(root, "skills", "threadshare")));
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-skill-"));
  const skillDirectory = path.join(fixture, "threadshare");
  try {
    await mkdir(path.join(skillDirectory, "agents"), { recursive: true });
    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: wrong-name\ndescription: Share a thread safely.\n---\n\n# Test\n",
    );
    await writeFile(
      path.join(skillDirectory, "agents", "openai.yaml"),
      'interface:\n  display_name: "Threadshare"\n  short_description: "Share agent threads with teammates"\n  default_prompt: "Use $threadshare to share this session."\n',
    );
    await assert.rejects(validateSkillDirectory(skillDirectory), /match the skill directory/);

    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: threadshare\ndescription: Share a thread safely.\nunexpected: true\n---\n\n# Test\n",
    );
    await assert.rejects(validateSkillDirectory(skillDirectory), /unexpected keys/);

    await writeFile(
      path.join(skillDirectory, "SKILL.md"),
      "---\nname: threadshare\ndescription: Share a thread safely.\n---\n\n# Test\n",
    );
    await writeFile(
      path.join(skillDirectory, "agents", "openai.yaml"),
      'interface:\n  display_name: "Threadshare"\n  short_description: "Share agent threads with teammates"\n  default_prompt: "Share this session."\n',
    );
    await assert.rejects(validateSkillDirectory(skillDirectory), /must mention \$threadshare/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("workflow builds, signs, stages, and publishes one attempt-scoped release bundle", async () => {
  const source = await readFile(path.join(root, ".github", "workflows", "publish-npm.yml"), "utf8");
  const workflow = parseYaml(source);
  assert.deepEqual(workflow.on, { release: { types: ["published"] } });
  assert.deepEqual(workflow.concurrency, {
    group: "threadshare-npm-publish",
    "cancel-in-progress": false,
  });
  const verify = workflow.jobs.verify;
  const build = workflow.jobs["build-engine"];
  const packageRelease = workflow.jobs["package-release"];
  const publishPlatforms = workflow.jobs["publish-platforms"];
  const consumerSmoke = workflow.jobs["consumer-smoke"];
  const publishRoot = workflow.jobs["publish-root"];
  assert.match(verify.if, /release\.draft == false/);
  assert.match(verify.if, /release\.prerelease == false/);
  assert.equal(build.needs, "verify");
  assert.deepEqual(packageRelease.needs, ["verify", "build-engine"]);
  assert.equal(publishPlatforms.needs, "package-release");
  assert.equal(consumerSmoke.needs, "publish-platforms");
  assert.equal(publishRoot.needs, "consumer-smoke");
  assert.equal(verify["runs-on"], "ubuntu-24.04");
  assert.equal(packageRelease["runs-on"], "ubuntu-24.04");
  assert.equal(publishPlatforms["runs-on"], "ubuntu-24.04");
  assert.equal(publishRoot["runs-on"], "ubuntu-24.04");
  assert.deepEqual(verify.permissions, { contents: "read" });
  assert.deepEqual(build.permissions, {
    attestations: "write",
    contents: "read",
    "id-token": "write",
  });
  assert.deepEqual(packageRelease.permissions, build.permissions);
  assert.deepEqual(publishPlatforms.permissions, { contents: "read", "id-token": "write" });
  assert.deepEqual(publishRoot.permissions, publishPlatforms.permissions);

  const buildTargets = build.strategy.matrix.include.map((entry) => entry.target).sort();
  const consumerTargets = consumerSmoke.strategy.matrix.include.map((entry) => entry.target).sort();
  assert.deepEqual(buildTargets, [
    "darwin-arm64",
    "darwin-x64",
    "linux-arm64",
    "linux-x64",
  ]);
  assert.deepEqual(consumerTargets, INSIGHTS_ENGINE_TARGETS.map(({ target }) => target).sort());
  assert.deepEqual(buildTargets, INSIGHTS_ENGINE_RELEASE_TARGETS.map(({ target }) => target).sort());
  const consumerSmokeByTarget = new Map(
    consumerSmoke.strategy.matrix.include.map((entry) => [entry.target, entry.smoke]),
  );
  assert.deepEqual(Object.fromEntries(consumerSmokeByTarget), {
    "darwin-arm64": "insights",
    "darwin-x64": "insights",
    "linux-arm64": "insights",
    "linux-x64": "insights",
    "win32-arm64": "core",
    "win32-x64": "core",
  });
  const buildMatrixByTarget = new Map(
    build.strategy.matrix.include.map((entry) => [entry.target, entry]),
  );
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    assert.equal(
      buildMatrixByTarget.get(target).rustflags,
      "",
      `${target} must preserve the LC_UUID load command required by dyld`,
    );
  }
  const uuidBuildCommands = build.steps.map((step) => step.run ?? "").join("\n");
  assert.match(uuidBuildCommands, /\/usr\/bin\/otool -l/);
  assert.match(uuidBuildCommands, /\/usr\/bin\/grep -q "cmd LC_UUID"/);
  assert.match(uuidBuildCommands, /assert_macho_uuid .*engine-build-a/);
  assert.match(uuidBuildCommands, /assert_macho_uuid .*engine-build-b/);

  for (const invalidValue of [
    "${{ runner.temp }}",
    "${{ RUNNER['temp'] }}",
    "${{ env.CACHE }}",
    "${{ steps.pack.outputs.integrity }}",
    "${{ job.status }}",
  ]) {
    assert.ok(
      expressionContextRoots(invalidValue).some((rootContext) =>
        !allowedJobEnvContexts.has(rootContext)
      ),
    );
  }

  for (const job of [verify, build, packageRelease, publishPlatforms, consumerSmoke, publishRoot]) {
    const checkout = job.steps.find((step) => step.name === "Checkout release commit");
    assert.equal(checkout.uses, "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803");
    assert.equal(checkout.with.ref, "${{ github.sha }}");
    if (job === verify || job === build || job === packageRelease) {
      assert.equal(checkout.with["fetch-depth"], 0);
    }
    assert.equal(checkout.with["persist-credentials"], false);
    const setupNode = job.steps.find((step) => step.name === "Set up Node.js");
    assert.equal(setupNode.uses, "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38");
    assert.equal(setupNode.with["node-version"], "22.22.3");
    assert.equal(Object.hasOwn(setupNode.with, "cache"), false);
    assert.equal(Object.hasOwn(job, "environment"), false);
    for (const [name, value] of Object.entries(job.env)) {
      for (const rootContext of expressionContextRoots(String(value))) {
        assert.ok(
          allowedJobEnvContexts.has(rootContext),
          `job env ${name} uses unsupported context ${rootContext}`,
        );
      }
    }
    assert.equal(Object.hasOwn(job.env, "NPM_CONFIG_CACHE"), false);
    if (job === verify) {
      const configureCache = job.steps.find((step) => step.name === "Configure npm cache");
      assert.equal(
        configureCache.run,
        "set -euo pipefail\nprintf 'NPM_CONFIG_CACHE=%s\\n' \"$RUNNER_TEMP/threadshare-npm-cache\" >> \"$GITHUB_ENV\"\n",
      );
    }
  }

  const verifyCommands = verify.steps.map((step) => step.run ?? "").join("\n");
  const buildCommands = build.steps.map((step) => step.run ?? "").join("\n");
  const packageCommands = packageRelease.steps.map((step) => step.run ?? "").join("\n");
  const platformCommands = publishPlatforms.steps.map((step) => step.run ?? "").join("\n");
  const consumerCommands = consumerSmoke.steps.map((step) => step.run ?? "").join("\n");
  const rootCommands = publishRoot.steps.map((step) => step.run ?? "").join("\n");
  assert.match(verifyCommands, /npm ci/);
  assert.match(verifyCommands, /npm test/);
  assert.match(verifyCommands, /npm run test:insights-engine/);
  assert.match(verifyCommands, /rustup toolchain install 1\.94\.1 --profile minimal --component clippy/);
  assert.match(verifyCommands, /npm run build:cloudflare/);
  assert.match(verifyCommands, /npm run validate:skill/);
  assert.match(verifyCommands, /verify:release -- source/);
  assert.match(buildCommands, /fetch-existing-insights-engine\.mjs/);
  assert.match(buildCommands, /--github-output "\$GITHUB_OUTPUT"/);
  assert.match(buildCommands, /engine-build-a/);
  assert.match(buildCommands, /engine-build-b/);
  assert.match(buildCommands, /MACOSX_DEPLOYMENT_TARGET="13\.0"/);
  assert.match(buildCommands, /codesign --force/);
  assert.match(buildCommands, /notarytool submit/);
  assert.doesNotMatch(buildCommands, /signtool\.exe|WINDOWS_CERTIFICATE/);
  assert.match(buildCommands, /generate-insights-sbom/);

  const reuseStep = build.steps.find(
    (step) => step.name === "Reuse matching published Engine when available",
  );
  assert.equal(reuseStep.id, "existing");
  assert.ok(
    build.steps.indexOf(reuseStep) <
      build.steps.findIndex((step) => step.name === "Install Rust build target"),
  );
  assert.match(reuseStep.run, /--source-sha "\$RELEASE_SHA"/);
  assert.match(reuseStep.run, /--target "\$\{\{ matrix\.target \}\}"/);
  assert.match(reuseStep.run, /--version "\$RELEASE_TAG"/);
  for (const stepName of [
    "Install Rust build target",
    "Install musl linker",
    "Build unsigned Engine twice",
    "Sign and notarize macOS Engine",
    "Attest signed Engine and SBOM",
  ]) {
    const step = build.steps.find((candidate) => candidate.name === stepName);
    assert.match(
      step.if,
      /steps\.existing\.outputs\.exists != 'true'/,
      `${stepName} must run only for a missing platform artifact`,
    );
  }
  const cleanupStep = build.steps.find(
    (step) => step.name === "Remove temporary macOS signing keychain",
  );
  assert.match(cleanupStep.if, /always\(\)/);
  assert.match(cleanupStep.if, /steps\.existing\.outputs\.exists != 'true'/);
  for (const stepName of [
    "Generate SPDX SBOM",
    "Smoke selected Engine and record native identity",
    "Upload selected Engine artifact",
  ]) {
    const step = build.steps.find((candidate) => candidate.name === stepName);
    assert.equal(
      Object.hasOwn(step, "if"),
      false,
      `${stepName} must run for both reused and newly built artifacts`,
    );
  }
  const engineUpload = build.steps.find(
    (step) => step.name === "Upload selected Engine artifact",
  );
  assert.equal(engineUpload.with.path, "engine");
  assert.equal(
    [...packageCommands.matchAll(/prepare-insights-release\.mjs/g)].length,
    2,
    "the staged root must be built independently twice",
  );
  assert.match(packageCommands, /release-staging-a\/root/);
  assert.match(packageCommands, /release-staging-b\/root/);
  assert.match(packageCommands, /root-pack-a/);
  assert.match(packageCommands, /root-pack-b/);
  assert.match(packageCommands, /resolve-npm-pack-filename\.mjs/);
  assert.doesNotMatch(packageCommands, /\[0\]\.filename/);
  assert.match(packageCommands, /cmp "\$RUNNER_TEMP\/root-pack-a/);
  assert.match(packageCommands, /package-insights-release\.mjs pack/);
  assert.match(packageCommands, /package-insights-release\.mjs verify/);
  assert.match(platformCommands, /publish-insights-release\.mjs/);
  assert.match(platformCommands, /--kind platform/);
  assert.match(consumerCommands, /npm install --prefix/);
  assert.match(consumerCommands, /smoke-installed-insights/);
  assert.match(consumerCommands, /smoke-installed-core/);
  assert.match(rootCommands, /publish-insights-release\.mjs/);
  assert.match(rootCommands, /--kind root/);
  assert.doesNotMatch(
    `${platformCommands}\n${rootCommands}`,
    /cargo build|codesign|signtool|prepare-insights-release|package-insights-release\.mjs pack/,
  );
  assert.match(source, /git merge-base --is-ancestor/);
  assert.match(source, /refs\/tags\/\$\{RELEASE_TAG\}\^\{commit\}/);
  assert.match(source, /npm install --global npm@12\.0\.2/);
  assert.match(source, /test "\$\(node --version\)" = "v22\.22\.3"/);
  assert.match(source, /release-bundle-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(source, /engine-\$\{\{ matrix\.target \}\}-\$\{\{ github\.run_id \}\}-\$\{\{ github\.run_attempt \}\}/);
  assert.match(source, /actions\/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d/);
  assert.match(source, /actions\/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093/);
  const pinnedActions = new Set([
    "actions/attest@508db95dd578ae2727ebd6217d5ba78e4fbda05d",
    "actions/checkout@d23441a48e516b6c34aea4fa41551a30e30af803",
    "actions/download-artifact@d3f86a106a0bac45b974a628896c90dbdf5c8093",
    "actions/setup-node@249970729cb0ef3589644e2896645e5dc5ba9c38",
    "actions/upload-artifact@ea165f8d65b6e75b540449e92b4886f43607fa02",
  ]);
  for (const job of Object.values(workflow.jobs)) {
    for (const step of job.steps) {
      if (step.uses) assert.ok(pinnedActions.has(step.uses), `unapproved action pin ${step.uses}`);
    }
  }
  assert.doesNotMatch(source, /npm publish(?!-insights-release)/);
  assert.doesNotMatch(source, /NPM_TOKEN|NODE_AUTH_TOKEN|_authToken/i);
  const signingSecrets = [...source.matchAll(/\$\{\{\s*secrets\.([A-Z0-9_]+)\s*\}\}/g)]
    .map((match) => match[1]);
  assert.deepEqual([...new Set(signingSecrets)].sort(), [
    "APPLE_APP_PASSWORD",
    "APPLE_CERTIFICATE_P12",
    "APPLE_CERTIFICATE_PASSWORD",
    "APPLE_ID",
    "APPLE_SIGNING_IDENTITY",
    "APPLE_TEAM_ID",
  ]);
});

test("Engine CI gates all six reproducible target builds on the contract suite", async () => {
  const source = await readFile(
    path.join(root, ".github", "workflows", "insights-engine-ci.yml"),
    "utf8",
  );
  const workflow = parseYaml(source);
  assert.deepEqual(workflow.on, { pull_request: null, push: { branches: ["main"] } });
  assert.equal(workflow.jobs.engine.needs, "contract");
  assert.match(
    workflow.jobs.contract.steps.map((step) => step.run ?? "").join("\n"),
    /npm run test:insights-engine/,
  );
  assert.match(
    workflow.jobs.contract.steps.map((step) => step.run ?? "").join("\n"),
    /rustup toolchain install 1\.94\.1 --profile minimal --component clippy/,
  );
  assert.deepEqual(
    workflow.jobs.engine.strategy.matrix.include.map((entry) => entry.target).sort(),
    [
      "darwin-arm64",
      "darwin-x64",
      "linux-arm64",
      "linux-x64",
      "win32-arm64",
      "win32-x64",
    ],
  );
  const engineMatrixByTarget = new Map(
    workflow.jobs.engine.strategy.matrix.include.map((entry) => [entry.target, entry]),
  );
  for (const target of ["darwin-arm64", "darwin-x64"]) {
    assert.equal(
      engineMatrixByTarget.get(target).rustflags,
      "",
      `${target} must preserve the LC_UUID load command required by dyld`,
    );
  }
  const commands = workflow.jobs.engine.steps.map((step) => step.run ?? "").join("\n");
  assert.match(commands, /engine-build-a/);
  assert.match(commands, /engine-build-b/);
  assert.match(commands, /\/usr\/bin\/otool -l/);
  assert.match(commands, /\/usr\/bin\/grep -q "cmd LC_UUID"/);
  assert.match(commands, /assert_macho_uuid .*engine-build-a/);
  assert.match(commands, /assert_macho_uuid .*engine-build-b/);
  assert.match(commands, /MACOSX_DEPLOYMENT_TARGET="13\.0"/);
  assert.match(commands, /> "engine\/\$\{\{ matrix\.target \}\}\/version\.json"/);
  assert.doesNotMatch(source, /secrets\s*(?:\.|\[)|npm publish/i);
});
