import assert from "node:assert/strict";
import { copyFile, mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { fileURLToPath } from "node:url";

import {
  INSIGHTS_DASHBOARD_FILES,
  buildInsightsDashboard,
  verifyInsightsDashboardBuild,
} from "../scripts/build-insights-dashboard.mjs";

const repositoryRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));

async function fixtureRoot() {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadshare-dashboard-test-"));
  const source = path.join(root, "src", "insights-dashboard");
  await mkdir(source, { recursive: true });
  for (const relative of INSIGHTS_DASHBOARD_FILES) {
    await copyFile(path.join(repositoryRoot, "src", "insights-dashboard", relative), path.join(source, relative));
  }
  return root;
}

test("Dashboard clean builds and committed output are byte deterministic", async () => {
  const root = await fixtureRoot();
  try {
    const first = await buildInsightsDashboard({ root });
    const second = await verifyInsightsDashboardBuild({ root });
    assert.deepEqual(second, first);
    assert.equal(first.files.length, 4);
    assert.equal(first.totalBytes > 0, true);
    assert.equal(first.files.every((file) => /^[0-9a-f]{64}$/u.test(file.sha256)), true);
    const serialized = await Promise.all(INSIGHTS_DASHBOARD_FILES.map((relative) =>
      readFile(path.join(root, "insights-dashboard", relative), "utf8")));
    assert.equal(serialized.some((value) => value.includes(root)), false);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Dashboard source exposes every supported search dimension without unsupported result states", async () => {
  const html = await readFile(path.join(repositoryRoot, "src", "insights-dashboard", "index.html"), "utf8");
  const app = await readFile(path.join(repositoryRoot, "src", "insights-dashboard", "app.js"), "utf8");
  const styles = await readFile(path.join(repositoryRoot, "src", "insights-dashboard", "styles.css"), "utf8");
  for (const controlId of [
    "search-query",
    "provider-filter",
    "project-filter",
    "closure-filter",
    "result-filter",
    "after-filter",
    "before-filter",
    "tool-filter",
    "skill-filter",
  ]) {
    assert.match(html, new RegExp(`id="${controlId}"`, "u"));
  }
  assert.match(html, /value="provider-completed"/u);
  assert.match(html, /value="abandoned"/u);
  assert.match(html, /value="unknown"/u);
  assert.doesNotMatch(html, /provider-failed/u);
  assert.match(html, /id="project-filter"[^>]+list="project-options"[^>]+pattern="\[0-9a-f\]\{64\}"/u);
  assert.match(html, /<datalist id="project-options"><\/datalist>/u);
  assert.match(html, /id="project-filter-state" hidden/u);
  for (const coverageKey of [
    "file-subagent-excluded",
    "inline-subagent-record",
    "sidechain-record",
    "unnamed-subagent-file-skipped",
  ]) {
    assert.match(app, new RegExp(`"${coverageKey}"`, "u"));
  }
  assert.doesNotMatch(app, /coverage\.slice\(/u);
  assert.doesNotMatch(app, /diagnostics\.slice\(/u);
  assert.match(app, /projectFilterState\.hidden = !projectPage\.truncated/u);
  assert.match(
    styles,
    /\.inspector\.is-closed\s*\{[^}]*display:\s*none;/su,
  );
});

test("Dashboard build rejects extra source assets and committed drift", async () => {
  const root = await fixtureRoot();
  try {
    await writeFile(path.join(root, "src", "insights-dashboard", "extra.js"), "extra\n");
    await assert.rejects(buildInsightsDashboard({ root }), /exactly/);
    await rm(path.join(root, "src", "insights-dashboard", "extra.js"));
    await buildInsightsDashboard({ root });
    await writeFile(path.join(root, "insights-dashboard", "app.js"), "changed\n");
    await assert.rejects(verifyInsightsDashboardBuild({ root }), /differs/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("Dashboard build rejects extra generated assets instead of silently packaging them", async () => {
  const root = await fixtureRoot();
  try {
    await buildInsightsDashboard({ root });
    await writeFile(path.join(root, "insights-dashboard", "chunk.js"), "chunk\n");
    await assert.rejects(buildInsightsDashboard({ root }), /exactly/);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
