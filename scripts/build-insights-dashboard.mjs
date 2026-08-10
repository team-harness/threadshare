#!/usr/bin/env node

import { createHash } from "node:crypto";
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";
import { fileURLToPath, pathToFileURL } from "node:url";

export const INSIGHTS_DASHBOARD_FILES = Object.freeze([
  "app.js",
  "index.html",
  "state.js",
  "styles.css",
]);

const MAX_ASSET_BYTES = 512 * 1024;

function sha256(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function assertExactFiles(directory, label) {
  const entries = (await readdir(directory, { withFileTypes: true }))
    .map((entry) => entry.isFile() ? entry.name : `${entry.name}/`)
    .sort();
  if (
    entries.length !== INSIGHTS_DASHBOARD_FILES.length ||
    entries.some((entry, index) => entry !== INSIGHTS_DASHBOARD_FILES[index])
  ) {
    throw new Error(`${label} must contain exactly ${INSIGHTS_DASHBOARD_FILES.join(", ")}`);
  }
}

async function manifest(directory, label) {
  await assertExactFiles(directory, label);
  const files = [];
  let totalBytes = 0;
  for (const relative of INSIGHTS_DASHBOARD_FILES) {
    const bytes = await readFile(path.join(directory, relative));
    if (bytes.byteLength === 0 || bytes.byteLength > MAX_ASSET_BYTES) {
      throw new Error(`${label}/${relative} is empty or exceeds ${MAX_ASSET_BYTES} bytes`);
    }
    totalBytes += bytes.byteLength;
    files.push(Object.freeze({ path: relative, bytes: bytes.byteLength, sha256: sha256(bytes) }));
  }
  return Object.freeze({ files: Object.freeze(files), totalBytes });
}

function assertMatchingManifests(left, right, label) {
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error(`${label} differs from the deterministic Dashboard build`);
  }
}

async function buildOnce(sourceDirectory, outputDirectory) {
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  if ((await readdir(outputDirectory)).length !== 0) {
    throw new Error("Dashboard clean build directory must be empty");
  }
  await assertExactFiles(sourceDirectory, "Dashboard source directory");
  for (const relative of INSIGHTS_DASHBOARD_FILES) {
    const bytes = await readFile(path.join(sourceDirectory, relative));
    await writeFile(path.join(outputDirectory, relative), bytes, { mode: 0o600 });
  }
  return manifest(outputDirectory, "Dashboard build directory");
}

async function cleanBuildPair(root) {
  const fixture = await mkdtemp(path.join(os.tmpdir(), "threadshare-dashboard-build-"));
  const sourceDirectory = path.join(root, "src", "insights-dashboard");
  try {
    const first = await buildOnce(sourceDirectory, path.join(fixture, "first"));
    const second = await buildOnce(sourceDirectory, path.join(fixture, "second"));
    assertMatchingManifests(first, second, "Dashboard clean builds");
    return first;
  } finally {
    await rm(fixture, { recursive: true, force: true });
  }
}

export async function verifyInsightsDashboardBuild({ root }) {
  const built = await cleanBuildPair(root);
  const committed = await manifest(
    path.join(root, "insights-dashboard"),
    "Committed Dashboard directory",
  );
  assertMatchingManifests(built, committed, "Committed Dashboard output");
  return committed;
}

export async function buildInsightsDashboard({ root, outputDirectory = path.join(root, "insights-dashboard") }) {
  const built = await cleanBuildPair(root);
  await mkdir(outputDirectory, { recursive: true, mode: 0o700 });
  const existing = await readdir(outputDirectory);
  if (existing.length > 0) await assertExactFiles(outputDirectory, "Dashboard output directory");
  const sourceDirectory = path.join(root, "src", "insights-dashboard");
  for (const relative of INSIGHTS_DASHBOARD_FILES) {
    await writeFile(
      path.join(outputDirectory, relative),
      await readFile(path.join(sourceDirectory, relative)),
      { mode: 0o600 },
    );
  }
  const output = await manifest(outputDirectory, "Dashboard output directory");
  assertMatchingManifests(built, output, "Dashboard output");
  return output;
}

async function main() {
  const root = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
  const check = process.argv.slice(2);
  if (check.length > 1 || (check.length === 1 && check[0] !== "--check")) {
    throw new Error("Usage: build-insights-dashboard [--check]");
  }
  const result = check[0] === "--check"
    ? await verifyInsightsDashboardBuild({ root })
    : await buildInsightsDashboard({ root });
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
