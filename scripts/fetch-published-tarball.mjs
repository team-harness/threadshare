#!/usr/bin/env node

import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";

import { fetchPublishedVersion } from "./verify-release.mjs";

const REGISTRY = "https://registry.npmjs.org/";

export async function fetchPublishedTarball({
  packageName,
  version,
  outputPath,
  fetchImpl = globalThis.fetch,
  maxAttempts = 8,
} = {}) {
  if (
    typeof packageName !== "string" ||
    typeof version !== "string" ||
    typeof outputPath !== "string" ||
    typeof fetchImpl !== "function" ||
    !Number.isInteger(maxAttempts) ||
    maxAttempts < 1
  ) {
    throw new TypeError("published tarball probe configuration is invalid");
  }
  const published = await fetchPublishedVersion({
    packageName,
    version,
    fetchImpl,
    maxAttempts,
  });
  const tarballUrl = published.dist?.tarball;
  if (typeof tarballUrl !== "string" || !tarballUrl.startsWith(REGISTRY)) {
    throw new Error("published package tarball URL is invalid");
  }
  const response = await fetchImpl(tarballUrl, {
    headers: { accept: "application/octet-stream", "cache-control": "no-cache, no-store" },
    redirect: "error",
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) {
    throw new Error(`published package tarball returned HTTP ${response.status}`);
  }
  const bytes = Buffer.from(await response.arrayBuffer());
  const integrity = `sha512-${createHash("sha512").update(bytes).digest("base64")}`;
  if (integrity !== published.dist?.integrity) {
    throw new Error("published package tarball integrity is invalid");
  }
  await writeFile(outputPath, bytes, { mode: 0o600 });
  return Object.freeze({
    packageName,
    version,
    outputPath,
    bytes: bytes.length,
    integrity,
  });
}

function parseArguments(argv) {
  const options = {};
  for (let index = 0; index < argv.length; index += 2) {
    const key = argv[index];
    const value = argv[index + 1];
    if (!key?.startsWith("--") || !value || Object.hasOwn(options, key.slice(2))) {
      throw new Error("Usage: node scripts/fetch-published-tarball.mjs --package <name> --version <version> --output <file>");
    }
    options[key.slice(2)] = value;
  }
  if (!options.package || !options.version || !options.output) {
    throw new Error("Usage: node scripts/fetch-published-tarball.mjs --package <name> --version <version> --output <file>");
  }
  return options;
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (isMain) {
  const options = parseArguments(process.argv.slice(2));
  fetchPublishedTarball({
    packageName: options.package,
    version: options.version,
    outputPath: options.output,
  }).then(
    (result) => process.stdout.write(`${JSON.stringify(result)}\n`),
    (error) => {
      process.stderr.write(`${error.message}\n`);
      process.exitCode = 1;
    },
  );
}
