import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import { verifyItem6Evidence } from "../docs/benchmarks/local-session-insights/verify-evidence.mjs";

const SOURCE_DIRECTORY = fileURLToPath(new URL(
  "../docs/benchmarks/local-session-insights/2026-08-11-item-6/evidence/",
  import.meta.url,
));
const REPORT_25K = "overview-25k.acceptance.json";
const REPORT_250K = "overview-250k.acceptance.json";

function sha256(value) {
  return createHash("sha256").update(value).digest("hex");
}

async function readJson(file) {
  return JSON.parse(await readFile(file, "utf8"));
}

async function writeJson(file, value) {
  const bytes = Buffer.from(`${JSON.stringify(value, null, 2)}\n`);
  await writeFile(file, bytes);
  return { bytes: bytes.length, sha256: sha256(bytes) };
}

async function withEvidenceCopy(run) {
  const root = await mkdtemp(path.join(tmpdir(), "threadshare-item6-verifier-"));
  const directory = path.join(root, "evidence");
  try {
    await cp(SOURCE_DIRECTORY, directory, { recursive: true });
    return await run(directory);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
}

async function mutateArtifact(directory, file, mutate) {
  const artifactPath = path.join(directory, file);
  const artifact = await readJson(artifactPath);
  mutate(artifact);
  const identity = await writeJson(artifactPath, artifact);
  const manifestPath = path.join(directory, "manifest.json");
  const manifest = await readJson(manifestPath);
  manifest.artifacts[file] = identity;
  await writeJson(manifestPath, manifest);
}

test("ITEM-6 verifier accepts the archived evidence and recomputes its contracts", async () => {
  assert.equal(await verifyItem6Evidence(), 2);
});

test("ITEM-6 verifier rejects rehashed numeric gate bypasses", async (context) => {
  const cases = [
    ["strict P95", REPORT_25K, (value) => {
      value.overview.roundTripMs.p95 = value.overview.gates.p95LimitMs;
      value.overview.roundTripMs.p99 = value.overview.gates.p95LimitMs;
      value.overview.roundTripMs.max = value.overview.gates.p95LimitMs;
    }],
    ["6 GiB Fact", REPORT_25K, (value) => {
      value.capacity.categories.fact.bytes = 6 * 1024 ** 3 + 1;
    }],
    ["8 GiB derived peak", REPORT_250K, (value) => {
      value.capacity.observedDerivedStatePeakBytes = 8 * 1024 ** 3 + 1;
    }],
    ["400 MiB FTS", REPORT_250K, (value) => {
      value.capacity.categories.fts.bytes = 400 * 1024 ** 2 + 1;
      value.capacity.ftsMetrics.detailFullBytes = value.capacity.categories.fts.bytes;
    }],
    ["sidecar RSS", REPORT_250K, (value) => {
      value.capacity.engineRss.sidecarPeakBytes = value.capacity.engineRss.limitBytes + 1;
    }],
    ["warm Engine ready median", REPORT_25K, (value) => {
      value.startup.populatedDatabase.readyMs = 500;
    }],
  ];
  for (const [name, file, mutate] of cases) {
    await context.test(name, async () => {
      await withEvidenceCopy(async (directory) => {
        await mutateArtifact(directory, file, mutate);
        await assert.rejects(() => verifyItem6Evidence({ directory }));
      });
    });
  }
});

test("ITEM-6 verifier rejects rehashed self-described capacity contracts", async (context) => {
  const cases = [
    ["extra capacity category", (value) => {
      value.capacity.categories.factOverflowShard = {
        bytes: 1,
        objects: 1,
        rows: 1,
      };
    }],
    ["lowered corpus density", (value) => {
      value.corpus.density.naturalTermsPerTurn = 1;
    }],
    ["impossible round-trip total", (value) => {
      value.overview.roundTripMs.total = 0;
    }],
  ];
  for (const [name, mutate] of cases) {
    await context.test(name, async () => {
      await withEvidenceCopy(async (directory) => {
        await mutateArtifact(directory, REPORT_25K, mutate);
        await assert.rejects(() => verifyItem6Evidence({ directory }));
      });
    });
  }
});

test("ITEM-6 verifier rejects missing scope and omitted-measurement disclosure", async (context) => {
  for (const field of ["measuredScope", "notMeasured", "startup"]) {
    await context.test(field, async () => {
      await withEvidenceCopy(async (directory) => {
        await mutateArtifact(directory, REPORT_25K, (value) => delete value[field]);
        await assert.rejects(() => verifyItem6Evidence({ directory }));
      });
    });
  }
});

test("ITEM-6 verifier rejects extra files and private-shaped aggregate values", async (context) => {
  await context.test("extra file", async () => {
    await withEvidenceCopy(async (directory) => {
      await writeFile(path.join(directory, "overview-500k.acceptance.json"), "{}\n");
      await assert.rejects(
        () => verifyItem6Evidence({ directory }),
        /unexpected file set/u,
      );
    });
  });
  await context.test("private value", async () => {
    await withEvidenceCopy(async (directory) => {
      await mutateArtifact(directory, REPORT_25K, (value) => {
        value.environment.cpuModel = "/Users/private/session";
      });
      await assert.rejects(() => verifyItem6Evidence({ directory }), /forbidden/u);
    });
  });
});

test("ITEM-6 verifier closes packager, benchmark, and build provenance", async (context) => {
  await context.test("packager manifest-to-artifact linkage", async () => {
    await withEvidenceCopy(async (directory) => {
      const manifestPath = path.join(directory, "manifest.json");
      const manifest = await readJson(manifestPath);
      manifest.scripts["scripts/package-insights-dashboard-evidence.mjs"].sha256 = "0".repeat(64);
      await writeJson(manifestPath, manifest);
      await assert.rejects(() => verifyItem6Evidence({ directory }), /packager digest drifted/u);
    });
  });
  await context.test("benchmark git object", async () => {
    await withEvidenceCopy(async (directory) => {
      for (const file of [REPORT_25K, REPORT_250K]) {
        await mutateArtifact(directory, file, (value) => {
          value.benchmarkScriptSha256 = "0".repeat(64);
        });
      }
      const manifestPath = path.join(directory, "manifest.json");
      const manifest = await readJson(manifestPath);
      manifest.scripts["scripts/benchmark-insights-engine.mjs"].sha256 = "0".repeat(64);
      await writeJson(manifestPath, manifest);
      await assert.rejects(() => verifyItem6Evidence({ directory }), /benchmark provenance/u);
    });
  });
  await context.test("declared Engine build provenance", async () => {
    await withEvidenceCopy(async (directory) => {
      for (const file of [REPORT_25K, REPORT_250K]) {
        await mutateArtifact(directory, file, (value) => {
          value.engineBuildProvenance = "claimed-stable-release";
        });
      }
      const manifestPath = path.join(directory, "manifest.json");
      const manifest = await readJson(manifestPath);
      manifest.engineBuildProvenance = "claimed-stable-release";
      await writeJson(manifestPath, manifest);
      await assert.rejects(() => verifyItem6Evidence({ directory }), /release-profile limitation/u);
    });
  });
});
