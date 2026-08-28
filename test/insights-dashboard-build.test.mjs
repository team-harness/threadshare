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

test("Dashboard source exposes conversation filters and detail without turn-level result controls", async () => {
  const html = await readFile(path.join(repositoryRoot, "src", "insights-dashboard", "index.html"), "utf8");
  const app = await readFile(path.join(repositoryRoot, "src", "insights-dashboard", "app.js"), "utf8");
  const styles = await readFile(path.join(repositoryRoot, "src", "insights-dashboard", "styles.css"), "utf8");
  for (const controlId of [
    "search-query",
    "provider-filter",
    "project-filter",
    "completeness-filter",
    "after-filter",
    "before-filter",
    "tool-filter",
    "skill-filter",
  ]) {
    assert.match(html, new RegExp(`id="${controlId}"`, "u"));
  }
  assert.doesNotMatch(html, /closure-filter|result-filter|provider-completed|abandoned/u);
  assert.match(html, /id="conversation-rows"/u);
  assert.match(html, /id="conversation-detail"[^>]+aria-label="Conversation detail"/u);
  assert.match(html, /id="conversation-messages"/u);
  assert.match(app, /requestJson\("\/api\/v1\/conversations"/u);
  assert.match(app, /requestJson\("\/api\/v1\/conversation-messages"/u);
  assert.match(app, /requestJson\("\/api\/v1\/history\/projects"\)/u);
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
  assert.match(app, /text: dashboardDiagnosticMessage\(delivery\.error\)/u);
  assert.match(app, /projectFilterViewModel\(state\.status, state\.projectCatalog\)/u);
  assert.match(app, /projectFilterState\.hidden = model\.message === null/u);
  assert.doesNotMatch(app, /project\.projectKey\.slice\(0, 10\)/u);
  assert.match(
    styles,
    /\.inspector\.is-closed\s*\{[^}]*display:\s*none;/su,
  );
});

test("Dashboard source workspace stays capability-honest and responsive", async () => {
  const html = await readFile(path.join(repositoryRoot, "src/insights-dashboard", "index.html"), "utf8");
  const app = await readFile(path.join(repositoryRoot, "src/insights-dashboard", "app.js"), "utf8");
  const state = await readFile(path.join(repositoryRoot, "src/insights-dashboard", "state.js"), "utf8");
  const styles = await readFile(path.join(repositoryRoot, "src/insights-dashboard", "styles.css"), "utf8");
  assert.match(html, /data-view="sources"/u);
  assert.match(html, /data-view-panel="sources"/u);
  assert.match(html, /data-source-filter="all"/u);
  assert.match(html, /data-source-filter="snapshot"/u);
  assert.match(html, /data-source-filter="eligible"/u);
  assert.match(app, /sourceCatalogViewModel\(/u);
  assert.match(app, /text: "Search this source"/u);
  assert.match(state, /const CURRENT_SOURCE_CATALOG/u);
  assert.doesNotMatch(state, /sourceAdapterId: "(?:pi|opencode)"/u);
  assert.match(styles, /\.source-workbench\s*\{/u);
  assert.match(styles, /@media \(max-width: 900px\)[\s\S]*?\.source-workbench\s*\{\s*grid-template-columns: 1fr;/u);
  assert.match(styles, /@media \(max-width: 640px\)[\s\S]*?\.view-nav\s*\{[\s\S]*?display: flex;[\s\S]*?overflow-x: auto;/u);
});

test("Dashboard leads with history and exposes only reviewed Team Memory assets", async () => {
  const html = await readFile(path.join(repositoryRoot, "src", "insights-dashboard", "index.html"), "utf8");
  const app = await readFile(path.join(repositoryRoot, "src", "insights-dashboard", "app.js"), "utf8");
  const styles = await readFile(path.join(repositoryRoot, "src", "insights-dashboard", "styles.css"), "utf8");
  assert.match(html, /data-view="search" aria-current="page">History</u);
  assert.match(html, /<h1 id="search-heading">Conversations<\/h1>/u);
  assert.match(html, /id="experience-repository"/u);
  assert.match(html, /id="experience-rows"/u);
  assert.match(html, /Git-visible assets/u);
  assert.doesNotMatch(html, /Member|成员|ranking|排名|efficiency score/iu);
  assert.match(app, /requestJson\("\/api\/v1\/experience\/repositories"\)/u);
  assert.match(app, /requestJson\(`\/api\/v1\/experience\/assets\?\$\{parameters\}`\)/u);
  assert.match(app, /search: Object\.freeze\(\{ \.\.\.INITIAL_STATE\.search, \.\.\.defaultHistoryDateRange\(\) \}\)/u);
  assert.match(app, /\[elements\.observedAfter, state\.search\.observedAtOrAfter\]/u);
  assert.match(app, /\[elements\.observedBefore, state\.search\.observedBefore\]/u);
  assert.match(app, /void runSearch\(false\);/u);
  assert.match(styles, /\.history-metrics,\s*\.memory-metrics/u);
  assert.match(styles, /grid-template-areas:[\s\S]*?"after before project source query query"/u);
  assert.match(styles, /\.conversation-detail\s*\{/u);
  assert.match(
    styles,
    /@media \(max-width: 640px\)[\s\S]*?\.app-shell,[\s\S]*?\.app-shell\.inspector-open\s*\{[\s\S]*?grid-template-columns: minmax\(0, 1fr\);/u,
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
