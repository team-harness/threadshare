import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import {
  assertSourceManifestHasNoPlatformPackages,
  createStagedRootManifest,
  stageInsightsRelease,
} from "../scripts/prepare-insights-release.mjs";
import {
  packReleaseArtifacts,
  verifyReleaseArtifacts,
} from "../scripts/package-insights-release.mjs";
import { createInsightsSbom } from "../scripts/generate-insights-sbom.mjs";
import { smokeInsightsEngine } from "../scripts/smoke-insights-engine.mjs";
import { smokeInstalledCore } from "../scripts/smoke-installed-core.mjs";
import {
  createInstalledSmokeTraceSourceDelta,
  smokeInstalledInsights,
} from "../scripts/smoke-installed-insights.mjs";
import { EXPECTED_PACKAGE_FILES } from "../scripts/verify-release.mjs";
import {
  INSIGHTS_ENGINE_RELEASE_TARGETS,
  INSIGHTS_ENGINE_TARGETS,
  insightsEnginePackageName,
} from "../src/insights-engine-runtime.mjs";
import { canonicalJson } from "../src/session-facts.mjs";
import {
  createBeginTraceSourceMessage,
  traceSourceDigestDocument,
} from "../src/insights-engine-protocol.mjs";

const version = "0.6.1";
const sourceSha = "a".repeat(40);

test("installed Insights smoke trace fixture satisfies the current protocol", () => {
  const delta = createInstalledSmokeTraceSourceDelta({
    canonicalJson,
    protocol: { traceSourceDigestDocument },
  });
  const begin = createBeginTraceSourceMessage(delta, { requestId: "1" });

  assert.deepEqual(begin.repository.projectKeys, ["3".repeat(64), "4".repeat(64)]);
  assert.equal(begin.intent, null);
  assert.deepEqual(delta.intentNodes, []);
  assert.deepEqual(delta.intentRefs, []);
});

async function writeFixtureRoot(root) {
  const manifest = {
    name: "@team-harness/threadshare",
    version,
    description: "fixture",
    license: "MIT",
    files: EXPECTED_PACKAGE_FILES.filter((relative) =>
      !new Set(["LICENSE", "README.md", "package.json"]).has(relative)
    ),
  };
  const lock = {
    name: manifest.name,
    version,
    packages: { "": { name: manifest.name, version } },
  };
  for (const relative of EXPECTED_PACKAGE_FILES) {
    const pathname = path.join(root, relative);
    await mkdir(path.dirname(pathname), { recursive: true });
    if (relative === "package.json") await writeFile(pathname, `${JSON.stringify(manifest)}\n`);
    else await writeFile(pathname, `${relative}\n`);
  }
  const dashboardSource = path.join(root, "src", "insights-dashboard");
  await mkdir(dashboardSource, { recursive: true });
  for (const relative of ["app.js", "index.html", "state.js", "styles.css"]) {
    await writeFile(
      path.join(dashboardSource, relative),
      await readFile(path.join(root, "insights-dashboard", relative)),
    );
  }
  await writeFile(path.join(root, "package-lock.json"), `${JSON.stringify(lock)}\n`);
  return { lock, manifest };
}

async function writeFixtureBinaries(directory, fixtureSourceSha = sourceSha) {
  for (const target of INSIGHTS_ENGINE_TARGETS) {
    const binaryName = target.platform === "win32"
      ? "threadshare-insights-engine.exe"
      : "threadshare-insights-engine";
    const targetDirectory = path.join(directory, target.target);
    await mkdir(targetDirectory, { recursive: true });
    const versionDocument = canonicalJson({
      format: "threadshare-insights-engine-version@v1",
      engineVersion: version,
      protocolVersion: 1,
      target: target.target,
      sqliteVersion: "3.53.2",
      sqliteCompileOptionsDigest: "b".repeat(64),
      buildManifestDigest: "c".repeat(64),
    });
    await writeFile(
      path.join(targetDirectory, binaryName),
      `fixture binary for ${target.target}\n`,
      { mode: target.platform === "win32" ? 0o600 : 0o755 },
    );
    await writeFile(path.join(targetDirectory, "version.json"), versionDocument);
    await writeFile(path.join(targetDirectory, "sbom.spdx.json"), canonicalJson({
      SPDXID: "SPDXRef-DOCUMENT",
      creationInfo: { created: "2026-08-10T00:00:00.000Z", creators: ["Tool: fixture"] },
      dataLicense: "CC0-1.0",
      documentNamespace: `https://github.com/team-harness/threadshare/sbom/${fixtureSourceSha}/${target.target}`,
      name: `fixture-${target.target}`,
      packages: [],
      relationships: [],
      spdxVersion: "SPDX-2.3",
    }));
  }
}

test("source manifests stay platform-package free and staged root injects exact versions", () => {
  const source = { name: "@team-harness/threadshare", version };
  const lock = { name: source.name, version, packages: { "": { ...source } } };
  assert.doesNotThrow(() => assertSourceManifestHasNoPlatformPackages(source, lock));
  const staged = createStagedRootManifest(source, version);
  assert.deepEqual(
    staged.optionalDependencies,
    Object.fromEntries(
      INSIGHTS_ENGINE_RELEASE_TARGETS
        .map((target) => insightsEnginePackageName(target.target))
        .sort()
        .map((name) => [name, version]),
    ),
  );
  assert.deepEqual(
    INSIGHTS_ENGINE_RELEASE_TARGETS.map(({ target }) => target),
    ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64"],
  );
  for (const target of INSIGHTS_ENGINE_TARGETS) {
    const polluted = {
      ...source,
      optionalDependencies: { [insightsEnginePackageName(target.target)]: version },
    };
    assert.throws(
      () => assertSourceManifestHasNoPlatformPackages(polluted, lock),
      /must not contain/,
    );
  }
});

test("release identity accepts current and future Git object id lengths", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-git-oid-"));
  const root = path.join(fixture, "source");
  const binaries = path.join(fixture, "binaries");
  try {
    await mkdir(root);
    await writeFixtureRoot(root);
    for (const gitObjectId of ["a".repeat(40), "b".repeat(64)]) {
      const objectBinaries = path.join(binaries, gitObjectId.length.toString());
      await writeFixtureBinaries(objectBinaries, gitObjectId);
      const output = path.join(fixture, gitObjectId.length.toString());
      await assert.doesNotReject(stageInsightsRelease({
        root,
        binariesDirectory: objectBinaries,
        outputDirectory: output,
        version,
        sourceSha: gitObjectId,
      }));
    }
    await assert.rejects(stageInsightsRelease({
      root,
      binariesDirectory: binaries,
      outputDirectory: path.join(fixture, "invalid"),
      version,
      sourceSha: "c".repeat(41),
    }), /Git object id/);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("SPDX generation is deterministic and omits Cargo workspace paths", () => {
  const metadata = {
    version: 1,
    packages: [
      { name: "rusqlite", version: "0.40.2", license: "MIT", source: "registry+index" },
      {
        name: "threadshare-insights-engine",
        version,
        license: "MIT",
        source: null,
        manifest_path: "/private/workspace/Cargo.toml",
      },
    ],
  };
  const input = {
    metadata,
    sourceSha,
    target: "linux-x64",
    version,
    created: "2026-08-10T00:00:00Z",
  };
  const first = canonicalJson(createInsightsSbom(input));
  const second = canonicalJson(createInsightsSbom({ ...input, metadata: structuredClone(metadata) }));
  assert.equal(first, second);
  assert.doesNotMatch(first, /private\/workspace/);
  assert.match(first, /SPDX-2\.3/);
});

test("staging produces one isolated root and four minimal Engine packages", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-stage-"));
  const root = path.join(fixture, "source");
  const binaries = path.join(fixture, "binaries");
  const output = path.join(fixture, "output");
  try {
    await mkdir(root);
    const source = await writeFixtureRoot(root);
    await writeFixtureBinaries(binaries);
    const result = await stageInsightsRelease({
      root,
      binariesDirectory: binaries,
      outputDirectory: output,
      version,
      sourceSha,
    });
    assert.equal(result.packages.length, INSIGHTS_ENGINE_RELEASE_TARGETS.length);
    assert.deepEqual(
      JSON.parse(await readFile(path.join(root, "package.json"), "utf8")),
      source.manifest,
      "staging must not rewrite the source manifest",
    );
    const rootManifest = JSON.parse(await readFile(path.join(output, "root", "package.json"), "utf8"));
    assert.equal(
      Object.keys(rootManifest.optionalDependencies).length,
      INSIGHTS_ENGINE_RELEASE_TARGETS.length,
    );

    for (const target of INSIGHTS_ENGINE_RELEASE_TARGETS) {
      const directory = path.join(output, target.target);
      assert.deepEqual((await readdir(directory)).sort(), [
        "LICENSE",
        "bin",
        "build-manifest.json",
        "package.json",
      ]);
      const platformManifest = JSON.parse(await readFile(path.join(directory, "package.json"), "utf8"));
      assert.deepEqual(platformManifest.os, [target.os]);
      assert.deepEqual(platformManifest.cpu, [target.cpu]);
      assert.equal(platformManifest.version, version);
      assert.deepEqual(platformManifest.repository, {
        type: "git",
        url: "git+https://github.com/team-harness/threadshare.git",
      });
      const rawBuildManifest = await readFile(path.join(directory, "build-manifest.json"), "utf8");
      const buildManifest = JSON.parse(rawBuildManifest);
      assert.equal(rawBuildManifest, canonicalJson(buildManifest));
      assert.equal(buildManifest.abi, target.abi);
      assert.equal(buildManifest.minimumOs, target.minimumOs);
      assert.equal(buildManifest.sqliteVersion, "3.53.2");
    }
    for (const target of INSIGHTS_ENGINE_TARGETS.filter(({ platform }) => platform === "win32")) {
      await assert.rejects(readdir(path.join(output, target.target)), { code: "ENOENT" });
    }
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("artifact-first packaging records and rechecks four Engine tarballs plus root", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-artifacts-"));
  const root = path.join(fixture, "source");
  const binaries = path.join(fixture, "binaries");
  const staging = path.join(fixture, "staging");
  const artifacts = path.join(fixture, "artifacts");
  try {
    await mkdir(root);
    await writeFixtureRoot(root);
    await writeFixtureBinaries(binaries);
    await stageInsightsRelease({
      root,
      binariesDirectory: binaries,
      outputDirectory: staging,
      version,
      sourceSha,
    });
    const packed = await packReleaseArtifacts({
      stagingDirectory: staging,
      outputDirectory: artifacts,
      version,
      sourceSha,
      runId: "123",
      runAttempt: "2",
    });
    assert.equal(packed.packages.length, INSIGHTS_ENGINE_RELEASE_TARGETS.length + 1);
    assert.equal(packed.packages.at(-1).kind, "root", "root must publish after platforms");
    assert.equal(
      (await readdir(artifacts)).filter((name) => name.endsWith(".tgz")).length,
      INSIGHTS_ENGINE_RELEASE_TARGETS.length + 1,
    );
    assert.equal(
      (await readdir(artifacts)).filter((name) => name.endsWith(".spdx.json")).length,
      INSIGHTS_ENGINE_RELEASE_TARGETS.length,
    );
    const verified = await verifyReleaseArtifacts({
      artifactDirectory: artifacts,
      version,
      sourceSha,
      runId: "123",
      runAttempt: "2",
    });
    assert.deepEqual(verified, packed);
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("release reruns preserve a verified registry platform tarball byte for byte", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-rerun-"));
  const root = path.join(fixture, "source");
  const binaries = path.join(fixture, "binaries");
  const firstStaging = path.join(fixture, "first-staging");
  const firstArtifacts = path.join(fixture, "first-artifacts");
  const rerunStaging = path.join(fixture, "rerun-staging");
  const rerunArtifacts = path.join(fixture, "rerun-artifacts");
  try {
    await mkdir(root);
    await writeFixtureRoot(root);
    await writeFixtureBinaries(binaries);
    await stageInsightsRelease({
      root,
      binariesDirectory: binaries,
      outputDirectory: firstStaging,
      version,
      sourceSha,
    });
    const first = await packReleaseArtifacts({
      stagingDirectory: firstStaging,
      outputDirectory: firstArtifacts,
      version,
      sourceSha,
      runId: "123",
      runAttempt: "1",
    });
    const reusedTarget = INSIGHTS_ENGINE_TARGETS[0];
    const firstItem = first.packages.find((item) => item.target === reusedTarget.target);
    const targetDirectory = path.join(binaries, reusedTarget.target);
    await Promise.all([
      copyFile(
        path.join(firstArtifacts, firstItem.tarball),
        path.join(targetDirectory, "existing.tgz"),
      ),
      writeFile(path.join(targetDirectory, "registry.json"), canonicalJson({
        buildManifestDigest: firstItem.buildManifestDigest,
        format: "threadshare-insights-registry-artifact@v1",
        integrity: firstItem.integrity,
        packageName: firstItem.packageName,
        rawSha256: firstItem.rawSha256,
        sourceSha,
        target: reusedTarget.target,
        version,
      })),
    ]);

    const staged = await stageInsightsRelease({
      root,
      binariesDirectory: binaries,
      outputDirectory: rerunStaging,
      version,
      sourceSha,
    });
    assert.equal(
      staged.packages.find((item) => item.target === reusedTarget.target).existing,
      true,
    );
    const rerun = await packReleaseArtifacts({
      stagingDirectory: rerunStaging,
      outputDirectory: rerunArtifacts,
      version,
      sourceSha,
      runId: "123",
      runAttempt: "2",
    });
    const rerunItem = rerun.packages.find((item) => item.target === reusedTarget.target);
    assert.deepEqual(
      {
        buildManifestDigest: rerunItem.buildManifestDigest,
        integrity: rerunItem.integrity,
        rawSha256: rerunItem.rawSha256,
      },
      {
        buildManifestDigest: firstItem.buildManifestDigest,
        integrity: firstItem.integrity,
        rawSha256: firstItem.rawSha256,
      },
    );
    assert.deepEqual(
      await readFile(path.join(rerunArtifacts, rerunItem.tarball)),
      await readFile(path.join(firstArtifacts, firstItem.tarball)),
    );
    await verifyReleaseArtifacts({
      artifactDirectory: rerunArtifacts,
      version,
      sourceSha,
      runId: "123",
      runAttempt: "2",
    });
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});

test("source Engine smoke negotiates the current analyzer and projection contract", async () => {
  let requiredContract;
  const target = "darwin-arm64";
  const document = {
    format: "threadshare-insights-engine-version@v1",
    engineVersion: version,
    protocolVersion: 1,
    target,
    sqliteVersion: "3.53.2",
    sqliteCompileOptionsDigest: "b".repeat(64),
    buildManifestDigest: "c".repeat(64),
  };

  await smokeInsightsEngine({
    binary: "/not-used/threadshare-insights-engine",
    target,
    version,
    execFile: async () => ({ stdout: JSON.stringify(document) }),
    createEngineClient: async (options) => {
      requiredContract = options.requiredContract;
      return { close: async () => {} };
    },
  });

  assert.deepEqual(requiredContract.projectionVersions, ["turn-search@2", "turn-summary@1"]);
  assert.deepEqual(requiredContract.analyzerCapabilities, ["mixed-cjk-code@1"]);
});

test("installed smoke obtains the current contract from the installed root package", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-installed-smoke-"));
  const scope = path.join(fixture, "node_modules", "@team-harness");
  const root = path.join(scope, "threadshare");
  const platform = path.join(scope, "threadshare-darwin-arm64");
  const contractCapture = Symbol.for("threadshare.test.installed-smoke-contract");
  const protocolCapture = Symbol.for("threadshare.test.installed-smoke-protocol-calls");
  let querySmokeRoot;
  try {
    await Promise.all([
      mkdir(path.join(root, "src"), { recursive: true }),
      mkdir(platform, { recursive: true }),
    ]);
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({
      name: "@team-harness/threadshare",
      version,
    })}\n`);
    await writeFile(path.join(root, "src", "insights-engine-client.mjs"), `
export async function createInsightsEngineClient(options) {
  globalThis[Symbol.for("threadshare.test.installed-smoke-contract")] = options.requiredContract;
  return { close: async () => {} };
}
`);
    await writeFile(path.join(root, "src", "insights-engine-runtime.mjs"), `
export function insightsEngineTarget() { return { target: "darwin-arm64" }; }
export function insightsEnginePackageName() { return "@team-harness/threadshare-darwin-arm64"; }
`);
    await writeFile(path.join(root, "src", "insights-engine-protocol.mjs"), `
export function createInsightsRequiredContract(originSecretEpoch) {
  globalThis[Symbol.for("threadshare.test.installed-smoke-protocol-calls")] = 1;
  return {
    factSchemaVersion: 1,
    providerAdapterVersions: ["claude@1", "codex@1"],
    privacyPolicyVersion: 1,
    originSecretEpoch,
    duplicatePolicyVersion: 1,
    factStorageProfile: "normalized-row-v1",
    storageSchemaVersion: 1,
    projectionVersions: ["turn-search@2", "turn-summary@1"],
    analyzerCapabilities: ["mixed-cjk-code@1"],
    rankerVersion: 1,
  };
}
`);

    const result = await smokeInstalledInsights({
      prefix: fixture,
      version,
      runAgentQuerySmoke: async ({ rootDirectory }) => {
        querySmokeRoot = rootDirectory;
        return { queryCount: 7, schemaCount: 10 };
      },
    });

    assert.equal(globalThis[protocolCapture], 1);
    assert.equal(querySmokeRoot, root);
    assert.deepEqual(result.agentQueries, { queryCount: 7, schemaCount: 10 });
    assert.deepEqual(globalThis[contractCapture].projectionVersions, [
      "turn-search@2",
      "turn-summary@1",
    ]);
    assert.deepEqual(globalThis[contractCapture].analyzerCapabilities, ["mixed-cjk-code@1"]);
  } finally {
    delete globalThis[contractCapture];
    delete globalThis[protocolCapture];
    await rm(fixture, { recursive: true, force: true });
  }
});

test("installed core smoke accepts a root-only Windows-style installation", async () => {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-installed-core-smoke-"));
  const root = path.join(fixture, "node_modules", "@team-harness", "threadshare");
  try {
    await mkdir(path.join(root, "bin"), { recursive: true });
    await mkdir(path.join(root, "src"), { recursive: true });
    await writeFile(path.join(root, "package.json"), `${JSON.stringify({
      name: "@team-harness/threadshare",
      version,
    })}\n`);
    await writeFile(path.join(root, "bin", "threadshare.mjs"), "export {};\n");
    await writeFile(
      path.join(root, "src", "cli-contract.mjs"),
      'export function renderRootHelp() { return "canonical installed help"; }\n',
    );
    const calls = [];
    const result = await smokeInstalledCore({
      prefix: fixture,
      platform: "win32",
      version,
      runCli: async (binary, arguments_) => {
        assert.equal(binary, path.join(root, "bin", "threadshare.mjs"));
        calls.push(arguments_);
        if (arguments_[0] === "--help") {
          return { exitCode: 0, stderr: "", stdout: "canonical installed help\n" };
        }
        if (arguments_[0] === "--version") {
          return { exitCode: 0, stderr: "", stdout: `${version}\n` };
        }
        return {
          exitCode: 1,
          stderr: [
            "threadshare: error TS_INSIGHTS_ENGINE_UNAVAILABLE",
            "Problem: Local Insights is not available for this platform in this release.",
            "Usage: threadshare insights [status|reindex|reset|exclude] [subcommand] [options]",
            "Next: Use Threadshare core commands on Windows, or run Insights on macOS or Linux.",
            "",
          ].join("\n"),
          stdout: "",
        };
      },
    });
    assert.deepEqual(calls, [
      ["--help"],
      ["--version"],
      ["insights", "status"],
    ]);
    assert.deepEqual(result, {
      packageName: "@team-harness/threadshare",
      platformPackageCount: 0,
      version,
    });

    const nestedPlatform = path.join(
      root,
      "node_modules",
      "@team-harness",
      "threadshare-linux-x64",
    );
    await mkdir(nestedPlatform, { recursive: true });
    await assert.rejects(
      smokeInstalledCore({
        prefix: fixture,
        platform: "win32",
        version,
        runCli: async () => {
          throw new Error("nested platform package must be rejected before the CLI runs");
        },
      }),
      /must not resolve an Insights Engine package/,
    );
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
});
