#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";

import { npmPackFilename } from "./verify-release.mjs";

async function main() {
  const [inputFile, packageName] = process.argv.slice(2);
  if (!inputFile || !packageName) {
    throw new Error("Usage: resolve-npm-pack-filename <pack-output.json> <package-name>");
  }
  const output = JSON.parse(await readFile(path.resolve(inputFile), "utf8"));
  process.stdout.write(`${npmPackFilename(output, packageName)}\n`);
}

main().catch((error) => {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
});
