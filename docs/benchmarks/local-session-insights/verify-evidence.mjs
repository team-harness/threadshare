import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

function assert(condition, message) {
  if (!condition) throw new Error(message);
}

function digest(bytes) {
  return createHash("sha256").update(bytes).digest("hex");
}

async function readJson(url) {
  const bytes = await readFile(url);
  return { bytes, value: JSON.parse(bytes.toString("utf8")) };
}

async function verifyItem4() {
  const directory = new URL("./2026-08-10/", import.meta.url);
  const { value: manifest } = await readJson(new URL("manifest.json", directory));
  assert(Array.isArray(manifest.runs) && manifest.runs.length === 5, "ITEM-4 manifest must list five runs");
  for (const run of manifest.runs) {
    const { bytes } = await readJson(new URL(run.file, directory));
    assert(bytes.length === run.fileBytes, `ITEM-4 byte count mismatch: ${run.file}`);
    assert(digest(bytes) === run.outputSha256, `ITEM-4 digest mismatch: ${run.file}`);
  }
  return manifest.runs.length;
}

async function verifyItem5() {
  const directory = new URL("./2026-08-10-item-5/evidence/", import.meta.url);
  const { value: manifest } = await readJson(new URL("manifest.json", directory));
  const artifacts = Object.entries(manifest.artifacts ?? {});
  assert(artifacts.length === 6, "ITEM-5 manifest must list six reports");
  for (const [file, expected] of artifacts) {
    const { bytes } = await readJson(new URL(file, directory));
    assert(bytes.length === expected.bytes, `ITEM-5 byte count mismatch: ${file}`);
    assert(digest(bytes) === expected.sha256, `ITEM-5 digest mismatch: ${file}`);
  }
  return artifacts.length;
}

const [item4Artifacts, item5Artifacts] = await Promise.all([verifyItem4(), verifyItem5()]);
process.stdout.write(`${JSON.stringify({
  format: "threadshare-insights-evidence-verification@v1",
  item4Artifacts,
  item5Artifacts,
})}\n`);
