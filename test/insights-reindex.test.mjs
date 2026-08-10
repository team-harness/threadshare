import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, readdir, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INSIGHTS_REGENERATE_CONFIRMATION,
  recoverInsightsReindexSwap,
  reindexInsightsState,
} from "../src/insights-reindex.mjs";
import { reconcileInsights } from "../src/insights-command.mjs";
import { openInsightsState } from "../src/insights-state.mjs";
import {
  createInsightsE2EFixture,
  INSIGHTS_E2E_SKIP,
  readInsightsDatabaseAudit,
} from "./helpers/insights-e2e.mjs";

function paths(root) {
  return {
    stateDirectory: root,
    configFile: path.join(path.dirname(root), "config.json"),
    databaseFile: path.join(root, "insights.sqlite3"),
    originSecretFile: path.join(root, "origin-secret.json"),
    lockFile: path.join(root, "insights.lock"),
    tempDirectory: path.join(root, "tmp"),
  };
}

async function fixture(t) {
  const root = await mkdtemp(path.join(os.tmpdir(), "threadshare-reindex-"));
  t.after(() => rm(root, { recursive: true, force: true }));
  const value = paths(root);
  await mkdir(value.tempDirectory, { recursive: true, mode: 0o700 });
  await chmod(root, 0o700);
  return value;
}

test("normal reindex keeps the origin secret and installs only a complete candidate", async (t) => {
  const value = await fixture(t);
  await openInsightsState({ paths: value });
  await writeFile(value.databaseFile, "old");
  const first = await reindexInsightsState({
    paths: value,
    availableBytes: 1024n * 1024n * 1024n,
    buildCandidate: async ({ databaseFile }) => {
      await writeFile(databaseFile, "new");
      return { committed: 1 };
    },
  });
  const secret = await readFile(value.originSecretFile);
  assert.equal(await readFile(value.databaseFile, "utf8"), "new");
  assert.equal(first.regeneratedSecret, false);

  await reindexInsightsState({
    paths: value,
    availableBytes: 1024n * 1024n * 1024n,
    buildCandidate: async ({ databaseFile }) => writeFile(databaseFile, "newer"),
  });
  assert.deepEqual(await readFile(value.originSecretFile), secret);
  assert.equal(await readFile(value.databaseFile, "utf8"), "newer");
});

test("a failed candidate build leaves the old snapshot readable", async (t) => {
  const value = await fixture(t);
  await openInsightsState({ paths: value });
  await writeFile(value.databaseFile, "old");
  await assert.rejects(
    reindexInsightsState({
      paths: value,
      availableBytes: 1024n * 1024n * 1024n,
      buildCandidate: async ({ databaseFile }) => {
        await writeFile(databaseFile, "partial");
        throw new Error("build failed");
      },
    }),
    /build failed/u,
  );
  assert.equal(await readFile(value.databaseFile, "utf8"), "old");
});

test("secret recovery requires stable confirmation and swaps database plus epoch", async (t) => {
  const value = await fixture(t);
  await writeFile(value.databaseFile, "old");
  await assert.rejects(
    reindexInsightsState({ paths: value, regenerateSecret: true, buildCandidate() {} }),
    { code: "TS_INSIGHTS_REGENERATE_CONFIRMATION_REQUIRED" },
  );
  let builtEpoch;
  const result = await reindexInsightsState({
    paths: value,
    regenerateSecret: true,
    confirmation: INSIGHTS_REGENERATE_CONFIRMATION,
    availableBytes: 1024n * 1024n * 1024n,
    buildCandidate: async ({ databaseFile, originSecretEpoch }) => {
      builtEpoch = originSecretEpoch;
      await writeFile(databaseFile, "recovered");
    },
  });
  const secret = JSON.parse(await readFile(value.originSecretFile, "utf8"));
  assert.equal(await readFile(value.databaseFile, "utf8"), "recovered");
  assert.equal(secret.originSecretEpoch, builtEpoch);
  assert.equal(result.regeneratedSecret, true);
});

test("real non-empty reindex preserves keyed Facts until confirmed secret recovery", {
  timeout: 60_000,
  skip: INSIGHTS_E2E_SKIP,
}, async (t) => {
  const fixture = await createInsightsE2EFixture(
    t,
    "11111111-2222-4333-8444-555555555555",
  );
  const first = await reconcileInsights(fixture.reconcileOptions);
  const secretBefore = await readFile(fixture.paths.originSecretFile);
  const parsedSecretBefore = JSON.parse(secretBefore.toString("utf8"));
  const firstAudit = await readInsightsDatabaseAudit(fixture.paths.databaseFile);

  assert.equal(first.report.committed, 1);
  assert.deepEqual(firstAudit.facts, { sessions: 1, turns: 2, events: 10, uses: 1 });
  assert.equal(firstAudit.fts.documents, 2);
  assert.equal(firstAudit.fts.naturalDocuments, 2);
  assert.equal(firstAudit.fts.terms > 0, true);
  assert.equal(firstAudit.fts.firstNaturalTermMatches > 0, true);
  assert.equal(firstAudit.projections.rollupRows > 0, true);
  assert.equal(firstAudit.keyedFacts.projectKeys.length, 1);
  assert.equal(firstAudit.keyedFacts.inputFingerprints.length, 1);
  assert.deepEqual(firstAudit.checkpointEpochs, [{
    originSecretEpoch: parsedSecretBefore.originSecretEpoch,
  }]);
  assert.equal(firstAudit.integrity, "ok");

  const normal = await reconcileInsights(fixture.reconcileOptions);
  const normalAudit = await readInsightsDatabaseAudit(fixture.paths.databaseFile);
  assert.equal(normal.regeneratedSecret, false);
  assert.equal(normal.originSecretPreserved, true);
  assert.equal(normal.originSecretEpoch, parsedSecretBefore.originSecretEpoch);
  assert.deepEqual(await readFile(fixture.paths.originSecretFile), secretBefore);
  assert.deepEqual(normalAudit.stableIdentity, firstAudit.stableIdentity);
  assert.deepEqual(normalAudit.keyedFacts, firstAudit.keyedFacts);
  assert.deepEqual(normalAudit.checkpointEpochs, firstAudit.checkpointEpochs);
  assert.deepEqual(normalAudit.fts, firstAudit.fts);
  assert.deepEqual(normalAudit.projections, firstAudit.projections);

  const installedBeforeRecovery = await stat(fixture.paths.databaseFile, { bigint: true });
  const aborted = new AbortController();
  const recoveryFailure = new Error("injected candidate failure");
  aborted.abort(recoveryFailure);
  await assert.rejects(
    reconcileInsights({
      ...fixture.reconcileOptions,
      regenerateSecret: true,
      confirmation: INSIGHTS_REGENERATE_CONFIRMATION,
      signal: aborted.signal,
    }),
    (error) => error === recoveryFailure,
  );
  assert.deepEqual(await readFile(fixture.paths.originSecretFile), secretBefore);
  assert.deepEqual(
    await readInsightsDatabaseAudit(fixture.paths.databaseFile),
    normalAudit,
  );
  assert.equal(
    (await readdir(fixture.paths.stateDirectory)).some((entry) => entry.startsWith(".reindex-")),
    false,
  );

  const recovered = await reconcileInsights({
    ...fixture.reconcileOptions,
    regenerateSecret: true,
    confirmation: INSIGHTS_REGENERATE_CONFIRMATION,
  });
  const secretAfter = await readFile(fixture.paths.originSecretFile);
  const parsedSecretAfter = JSON.parse(secretAfter.toString("utf8"));
  const recoveredAudit = await readInsightsDatabaseAudit(fixture.paths.databaseFile);
  const installedAfterRecovery = await stat(fixture.paths.databaseFile, { bigint: true });

  assert.equal(recovered.regeneratedSecret, true);
  assert.notDeepEqual(secretAfter, secretBefore);
  assert.notEqual(parsedSecretAfter.originSecretEpoch, parsedSecretBefore.originSecretEpoch);
  assert.equal(recovered.originSecretEpoch, parsedSecretAfter.originSecretEpoch);
  if (process.platform !== "win32") {
    assert.notEqual(installedAfterRecovery.ino, installedBeforeRecovery.ino);
  }
  assert.deepEqual(recoveredAudit.stableIdentity, normalAudit.stableIdentity);
  assert.notDeepEqual(recoveredAudit.keyedFacts.projectKeys, normalAudit.keyedFacts.projectKeys);
  assert.notDeepEqual(
    recoveredAudit.keyedFacts.inputFingerprints,
    normalAudit.keyedFacts.inputFingerprints,
  );
  assert.notDeepEqual(recoveredAudit.keyedFacts.turnRevisions, normalAudit.keyedFacts.turnRevisions);
  assert.deepEqual(recoveredAudit.keyedFacts.rollupBuckets, normalAudit.keyedFacts.rollupBuckets);
  assert.deepEqual(recoveredAudit.checkpointEpochs, [{
    originSecretEpoch: parsedSecretAfter.originSecretEpoch,
  }]);
  assert.deepEqual(recoveredAudit.facts, normalAudit.facts);
  assert.deepEqual(recoveredAudit.fts, normalAudit.fts);
  assert.equal(recoveredAudit.projections.rollupRows, normalAudit.projections.rollupRows);
  assert.equal(recoveredAudit.projections.rollupRows > 0, true);
  assert.equal(recoveredAudit.integrity, "ok");
});

test("recovery rolls back a candidate that was not installed", async (t) => {
  const value = await fixture(t);
  const id = "11111111-1111-4111-8111-111111111111";
  await writeFile(path.join(value.stateDirectory, ".reindex-backup.sqlite3"), "old");
  await writeFile(path.join(value.stateDirectory, `.reindex-${id}.sqlite3`), "candidate");
  await writeFile(
    path.join(value.stateDirectory, ".reindex-swap.json"),
    `${JSON.stringify({
      format: "threadshare-insights-reindex-swap@v1",
      id,
      regenerateSecret: false,
    })}\n`,
  );
  const result = await recoverInsightsReindexSwap({ paths: value });
  assert.equal(result.recovered, true);
  assert.equal(await readFile(value.databaseFile, "utf8"), "old");
});

test("recovery resolves every manifest-backed database and secret swap boundary", async (t) => {
  const id = "22222222-2222-4222-8222-222222222222";
  const cases = [
    {
      name: "manifest published before the active database moves",
      regenerateSecret: false,
      files: {
        "insights.sqlite3": "old-database",
        [`.reindex-${id}.sqlite3`]: "new-database",
        [`.reindex-${id}.sqlite3-wal`]: "new-wal",
      },
      expectedDatabase: "old-database",
      expectedSecret: null,
    },
    {
      name: "active database moved to backup before candidate installation",
      regenerateSecret: false,
      files: {
        ".reindex-backup.sqlite3": "old-database",
        ".reindex-backup.sqlite3-wal": "old-wal",
        [`.reindex-${id}.sqlite3`]: "new-database",
      },
      expectedDatabase: "old-database",
      expectedWal: "old-wal",
      expectedSecret: null,
    },
    {
      name: "active main moved before its WAL restores the split old group",
      regenerateSecret: false,
      files: {
        "insights.sqlite3-wal": "old-wal",
        ".reindex-backup.sqlite3": "old-database",
        [`.reindex-${id}.sqlite3`]: "new-database",
        [`.reindex-${id}.sqlite3-wal`]: "new-wal",
      },
      expectedDatabase: "old-database",
      expectedWal: "old-wal",
      expectedSecret: null,
    },
    {
      name: "candidate database installed before its secret",
      regenerateSecret: true,
      files: {
        "insights.sqlite3": "new-database",
        ".reindex-backup.sqlite3": "old-database",
        "origin-secret.json": "old-secret",
        [`.reindex-${id}.origin-secret.json`]: "new-secret",
      },
      expectedDatabase: "new-database",
      expectedSecret: "new-secret",
    },
    {
      name: "candidate main moved before its WAL rolls back the partial group",
      regenerateSecret: true,
      files: {
        "insights.sqlite3": "new-database",
        ".reindex-backup.sqlite3": "old-database",
        ".reindex-backup.sqlite3-wal": "old-wal",
        [`.reindex-${id}.sqlite3-wal`]: "new-wal",
        ".reindex-backup.origin-secret.json": "old-secret",
        [`.reindex-${id}.origin-secret.json`]: "new-secret",
      },
      expectedDatabase: "old-database",
      expectedWal: "old-wal",
      expectedSecret: "old-secret",
    },
    {
      name: "database and secret installed before obsolete backups are removed",
      regenerateSecret: true,
      files: {
        "insights.sqlite3": "new-database",
        ".reindex-backup.sqlite3": "old-database",
        "origin-secret.json": "new-secret",
        ".reindex-backup.origin-secret.json": "old-secret",
      },
      expectedDatabase: "new-database",
      expectedSecret: "new-secret",
    },
  ];

  for (const scenario of cases) {
    await t.test(scenario.name, async (caseTest) => {
      const value = await fixture(caseTest);
      for (const [name, contents] of Object.entries(scenario.files)) {
        await writeFile(path.join(value.stateDirectory, name), contents);
      }
      await writeFile(
        path.join(value.stateDirectory, ".reindex-swap.json"),
        `${JSON.stringify({
          format: "threadshare-insights-reindex-swap@v1",
          id,
          regenerateSecret: scenario.regenerateSecret,
        })}\n`,
      );

      assert.deepEqual(await recoverInsightsReindexSwap({ paths: value }), { recovered: true });
      assert.equal(await readFile(value.databaseFile, "utf8"), scenario.expectedDatabase);
      if (scenario.expectedWal !== undefined) {
        assert.equal(await readFile(`${value.databaseFile}-wal`, "utf8"), scenario.expectedWal);
      }
      if (scenario.expectedSecret !== null) {
        assert.equal(await readFile(value.originSecretFile, "utf8"), scenario.expectedSecret);
      }
      assert.equal(
        (await readdir(value.stateDirectory)).some((entry) => entry.startsWith(".reindex-")),
        false,
      );
    });
  }
});
