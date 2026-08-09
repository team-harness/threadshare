import assert from "node:assert/strict";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";

import {
  INSIGHTS_ENGINE_TARGETS,
  insightsEnginePackageName,
  insightsEngineTarget,
  resolveInsightsEngine,
} from "../src/insights-engine-runtime.mjs";
import { canonicalJson } from "../src/session-facts.mjs";
import { createHash } from "node:crypto";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

test("target matrix covers six unique npm and Rust targets", () => {
  assert.equal(INSIGHTS_ENGINE_TARGETS.length, 6);
  assert.equal(new Set(INSIGHTS_ENGINE_TARGETS.map((item) => item.target)).size, 6);
  assert.equal(new Set(INSIGHTS_ENGINE_TARGETS.map((item) => item.rustTarget)).size, 6);
  assert.equal(insightsEngineTarget("darwin", "arm64").target, "darwin-arm64");
  assert.equal(insightsEngineTarget("freebsd", "x64"), null);
  assert.equal(
    insightsEnginePackageName("win32-x64"),
    "@team-harness/threadshare-win32-x64",
  );
});

test("explicit Engine path works without platform package metadata", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-engine-override-"));
  const binaryPath = path.join(directory, "engine");
  try {
    await writeFile(binaryPath, "#!/bin/sh\nexit 0\n", { mode: 0o700 });
    const resolved = await resolveInsightsEngine({
      platform: "darwin",
      arch: "arm64",
      env: { THREADSHARE_INSIGHTS_ENGINE_PATH: binaryPath },
    });
    assert.equal(resolved.source, "override");
    assert.equal(resolved.binaryPath, binaryPath);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("platform package requires canonical manifest and matching binary digest", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "threadshare-engine-package-"));
  const packageRoot = path.join(directory, "package");
  const binDirectory = path.join(packageRoot, "bin");
  const binaryPath = path.join(binDirectory, "threadshare-insights-engine");
  const packagePath = path.join(packageRoot, "package.json");
  const manifestPath = path.join(packageRoot, "build-manifest.json");
  const binary = Buffer.from("engine-binary");
  try {
    await mkdir(binDirectory, { recursive: true });
    await writeFile(binaryPath, binary, { mode: 0o700 });
    await writeFile(packagePath, canonicalJson({
      name: "@team-harness/threadshare-linux-x64",
      version: "0.6.1",
      os: ["linux"],
      cpu: ["x64"],
    }));
    const manifest = {
      abi: "musl-static",
      format: "threadshare-insights-build@v1",
      license: "MIT",
      minimumOs: "Linux 4.14",
      packageName: "@team-harness/threadshare-linux-x64",
      version: "0.6.1",
      target: "linux-x64",
      rustTarget: "x86_64-unknown-linux-musl",
      binary: "bin/threadshare-insights-engine",
      binarySha256: sha256(binary),
      sourceSha: "a".repeat(64),
      sqliteVersion: "3.53.2",
      protocolVersion: 1,
    };
    await writeFile(manifestPath, canonicalJson(manifest));
    const resolved = await resolveInsightsEngine({
      platform: "linux",
      arch: "x64",
      version: "0.6.1",
      env: {},
      resolvePackage(specifier) {
        assert.equal(specifier, "@team-harness/threadshare-linux-x64/package.json");
        return packagePath;
      },
    });
    assert.equal(resolved.target, "linux-x64");
    assert.equal(resolved.buildManifest.binarySha256, sha256(binary));
    assert.equal(
      resolved.buildManifestDigest,
      sha256(Buffer.from(await readFile(manifestPath))),
    );

    await writeFile(binaryPath, "tampered", { mode: 0o700 });
    await assert.rejects(
      resolveInsightsEngine({
        platform: "linux",
        arch: "x64",
        version: "0.6.1",
        env: {},
        resolvePackage: () => packagePath,
      }),
      { code: "TS_INSIGHTS_ENGINE_INVALID", failureKind: "engine_invalid" },
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("unsupported and missing platform packages only disable Insights", async () => {
  await assert.rejects(
    resolveInsightsEngine({ platform: "freebsd", arch: "x64", env: {} }),
    { code: "TS_INSIGHTS_ENGINE_UNAVAILABLE", failureKind: "engine_unavailable" },
  );
  await assert.rejects(
    resolveInsightsEngine({
      platform: "linux",
      arch: "arm64",
      version: "0.6.1",
      env: {},
      resolvePackage() {
        throw Object.assign(new Error("missing"), { code: "MODULE_NOT_FOUND" });
      },
    }),
    { code: "TS_INSIGHTS_ENGINE_UNAVAILABLE", failureKind: "engine_unavailable" },
  );
});
