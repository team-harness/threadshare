import assert from "node:assert/strict";
import { chmod, mkdir, mkdtemp, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  INSIGHTS_CONFIG_SCHEMA,
  loadInsightsConfig,
  saveInsightsConfig,
  updateInsightsExclusion,
} from "../src/insights-config.mjs";
import { resolveInsightsPaths } from "../src/insights-paths.mjs";
import { openInsightsState } from "../src/insights-state.mjs";

test("resolves platform state and config paths with explicit environment overrides", () => {
  const darwin = resolveInsightsPaths({
    platform: "darwin",
    homeDirectory: "/Users/tester",
    environment: {},
  });
  assert.equal(
    darwin.stateDirectory,
    "/Users/tester/Library/Application Support/threadshare/insights",
  );
  assert.equal(darwin.configFile, "/Users/tester/Library/Application Support/threadshare/config.json");

  const linux = resolveInsightsPaths({
    platform: "linux",
    homeDirectory: "/home/tester",
    environment: {
      XDG_STATE_HOME: "/var/state/tester",
      XDG_CONFIG_HOME: "/var/config/tester",
    },
  });
  assert.equal(linux.stateDirectory, "/var/state/tester/threadshare/insights");
  assert.equal(linux.configFile, "/var/config/tester/threadshare/config.json");

  const windows = resolveInsightsPaths({
    platform: "win32",
    homeDirectory: "C:\\Users\\tester",
    environment: {
      LOCALAPPDATA: "D:\\Local",
      APPDATA: "D:\\Roaming",
    },
  });
  assert.equal(windows.stateDirectory, "D:\\Local\\threadshare\\insights");
  assert.equal(windows.configFile, "D:\\Roaming\\threadshare\\config.json");

  const environmentHomes = [
    resolveInsightsPaths({ platform: "linux", environment: { HOME: "/srv/user" } }),
    resolveInsightsPaths({ platform: "win32", environment: { USERPROFILE: "E:\\User" } }),
  ];
  assert.equal(environmentHomes[0].stateDirectory, "/srv/user/.local/state/threadshare/insights");
  assert.equal(
    environmentHomes[1].stateDirectory,
    "E:\\User\\AppData\\Local\\threadshare\\insights",
  );

  const overridden = resolveInsightsPaths({
    platform: "linux",
    homeDirectory: "/home/tester",
    currentDirectory: "/work",
    environment: {
      THREADSHARE_INSIGHTS_HOME: "./private-state",
      THREADSHARE_CONFIG: "./settings.json",
    },
  });
  assert.equal(overridden.stateDirectory, "/work/private-state");
  assert.equal(overridden.configFile, "/work/settings.json");
  assert.equal(overridden.databaseFile, "/work/private-state/insights.sqlite3");
  assert.equal(overridden.originSecretFile, "/work/private-state/origin-secret.json");
  assert.equal(overridden.tempDirectory, "/work/private-state/tmp");
});

test("opens a persistent origin secret and enforces POSIX private modes", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-state-"));
  const stateDirectory = path.join(directory, "state");
  const options = {
    platform: "linux",
    homeDirectory: directory,
    environment: { THREADSHARE_INSIGHTS_HOME: stateDirectory },
  };
  try {
    const first = await openInsightsState(options);
    assert.equal(first.created, true);
    assert.match(
      first.originSecretEpoch,
      /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/u,
    );
    assert.equal((await stat(first.paths.stateDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(first.paths.tempDirectory)).mode & 0o777, 0o700);
    assert.equal((await stat(first.paths.originSecretFile)).mode & 0o777, 0o600);

    const databaseFiles = [
      first.paths.databaseFile,
      `${first.paths.databaseFile}-wal`,
      `${first.paths.databaseFile}-shm`,
      path.join(first.paths.tempDirectory, "index-batch.tmp"),
    ];
    for (const file of databaseFiles) {
      await writeFile(file, "private", { mode: 0o666 });
      await chmod(file, 0o666);
    }

    const second = await openInsightsState(options);
    for (const file of databaseFiles) {
      assert.equal((await stat(file)).mode & 0o777, 0o600);
    }
    assert.equal(second.created, false);
    assert.equal(second.originSecretEpoch, first.originSecretEpoch);
    assert.equal(
      second.privacyContext.fingerprint("fixture", "same-input"),
      first.privacyContext.fingerprint("fixture", "same-input"),
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("requires an explicit owner-only ACL adapter on Windows", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-acl-"));
  const paths = resolveInsightsPaths({
    platform: "linux",
    homeDirectory: directory,
    environment: { THREADSHARE_INSIGHTS_HOME: path.join(directory, "state") },
  });
  try {
    await assert.rejects(
      openInsightsState({ paths, platform: "win32" }),
      (error) => error?.code === "TS_INSIGHTS_WINDOWS_ACL_REQUIRED",
    );

    const calls = [];
    const state = await openInsightsState({
      paths,
      platform: "win32",
      windowsAcl(target, details) {
        calls.push([target, details.kind]);
      },
    });
    assert.equal(state.created, true);
    assert.ok(calls.some(([target, kind]) => target === paths.stateDirectory && kind === "directory"));
    assert.ok(calls.some(([target, kind]) => target === paths.tempDirectory && kind === "directory"));
    assert.ok(calls.some(([target, kind]) => target === paths.originSecretFile && kind === "file"));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads defaults and persists a versioned private insights config", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-config-"));
  const configFile = path.join(directory, "config", "threadshare.json");
  const options = {
    platform: "linux",
    homeDirectory: directory,
    environment: { THREADSHARE_CONFIG: configFile },
  };
  try {
    assert.equal(INSIGHTS_CONFIG_SCHEMA.properties.format.const, "threadshare-config@v1");
    const defaults = await loadInsightsConfig(options);
    assert.deepEqual(defaults, {
      format: "threadshare-config@v1",
      schemaVersion: 1,
      insights: {
        excludeProviders: [],
        excludeProjects: [],
        excludeSessions: [],
        quiescenceSeconds: 300,
      },
    });

    const saved = await saveInsightsConfig(defaults, options);
    assert.deepEqual(saved, defaults);
    assert.deepEqual(JSON.parse(await readFile(configFile, "utf8")), defaults);
    assert.equal((await stat(path.dirname(configFile))).mode & 0o777, 0o700);
    assert.equal((await stat(configFile)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("persists normalized provider, project, and session exclusions", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-exclude-"));
  const configFile = path.join(directory, "config.json");
  const options = {
    platform: "linux",
    homeDirectory: directory,
    environment: { THREADSHARE_CONFIG: configFile },
  };
  const sessionId = "AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA";
  try {
    const provider = await updateInsightsExclusion(
      { operation: "add", kind: "provider", value: "CODEX" },
      options,
    );
    assert.equal(provider.changed, true);
    const duplicate = await updateInsightsExclusion(
      { operation: "add", kind: "provider", value: "codex" },
      options,
    );
    assert.equal(duplicate.changed, false);
    await updateInsightsExclusion(
      { operation: "add", kind: "project", value: "/work/private-project" },
      options,
    );
    await updateInsightsExclusion(
      { operation: "add", kind: "session", value: sessionId },
      options,
    );

    let loaded = await loadInsightsConfig(options);
    assert.deepEqual(loaded.insights.excludeProviders, ["codex"]);
    assert.deepEqual(loaded.insights.excludeProjects, ["/work/private-project"]);
    assert.deepEqual(loaded.insights.excludeSessions, [sessionId.toLowerCase()]);
    assert.equal(loaded.insights.quiescenceSeconds, 300);

    const removed = await updateInsightsExclusion(
      { operation: "remove", kind: "provider", value: "CODEX" },
      options,
    );
    assert.equal(removed.changed, true);
    loaded = await loadInsightsConfig(options);
    assert.deepEqual(loaded.insights.excludeProviders, []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("serializes concurrent exclusion updates without losing privacy rules", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-concurrent-"));
  const options = {
    platform: "linux",
    environment: { THREADSHARE_CONFIG: path.join(directory, "config", "config.json") },
  };
  const projects = Array.from({ length: 12 }, (_, index) => `/work/private-${index}`);
  try {
    await Promise.all(projects.map((value) => updateInsightsExclusion(
      { operation: "add", kind: "project", value },
      options,
    )));
    const loaded = await loadInsightsConfig(options);
    assert.deepEqual(loaded.insights.excludeProjects, [...projects].sort());
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("recovers a config lock left by a dead writer", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-stale-lock-"));
  const configFile = path.join(directory, "config.json");
  const options = {
    platform: "linux",
    environment: { THREADSHARE_CONFIG: configFile },
    configLockTimeoutMilliseconds: 250,
  };
  try {
    await writeFile(`${configFile}.lock`, JSON.stringify({
      format: "threadshare-config-lock@v1",
      pid: 2_147_483_647,
      token: "11111111-1111-4111-8111-111111111111",
    }));
    const result = await updateInsightsExclusion(
      { operation: "add", kind: "provider", value: "codex" },
      options,
    );
    assert.equal(result.changed, true);
    assert.deepEqual(result.config.insights.excludeProviders, ["codex"]);
    await assert.rejects(stat(`${configFile}.lock`), (error) => error?.code === "ENOENT");
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects configs whose serialized UTF-8 form exceeds the read limit", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-large-config-"));
  const options = {
    platform: "linux",
    environment: { THREADSHARE_CONFIG: path.join(directory, "config.json") },
  };
  const config = await loadInsightsConfig(options);
  config.insights.excludeProjects = Array.from(
    { length: 3_000 },
    (_, index) => `/work/${String(index).padStart(4, "0")}/${"x".repeat(400)}`,
  );
  try {
    await assert.rejects(
      saveInsightsConfig(config, options),
      (error) => error?.code === "TS_INSIGHTS_CONFIG_INVALID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("does not change an existing config override parent directory mode", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-parent-mode-"));
  const options = {
    platform: "linux",
    environment: { THREADSHARE_CONFIG: path.join(directory, "config.json") },
  };
  try {
    await chmod(directory, 0o755);
    const config = await loadInsightsConfig(options);
    await saveInsightsConfig(config, options);
    assert.equal((await stat(directory)).mode & 0o777, 0o755);
    assert.equal((await stat(options.environment.THREADSHARE_CONFIG)).mode & 0o777, 0o600);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("keeps an existing default Threadshare config directory private on load", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-default-mode-"));
  const configHome = path.join(directory, "xdg-config");
  const configDirectory = path.join(configHome, "threadshare");
  const configFile = path.join(configDirectory, "config.json");
  const options = {
    platform: "linux",
    environment: { HOME: directory, XDG_CONFIG_HOME: configHome },
  };
  try {
    await mkdir(configDirectory, { recursive: true, mode: 0o777 });
    await chmod(configDirectory, 0o777);
    await loadInsightsConfig(options);
    assert.equal((await stat(configDirectory)).mode & 0o777, 0o700);

    await chmod(configDirectory, 0o777);
    await writeFile(configFile, JSON.stringify({
      format: "threadshare-config@v1",
      schemaVersion: 1,
      insights: {
        excludeProviders: [],
        excludeProjects: [],
        excludeSessions: [],
        quiescenceSeconds: 300,
      },
    }));
    await loadInsightsConfig(options);
    assert.equal((await stat(configDirectory)).mode & 0o777, 0o700);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("loads config from one file handle when its directory entry is replaced", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-config-race-"));
  const configFile = path.join(directory, "config.json");
  const replacementFile = path.join(directory, "replacement.json");
  const config = {
    format: "threadshare-config@v1",
    schemaVersion: 1,
    insights: {
      excludeProviders: ["codex"],
      excludeProjects: [],
      excludeSessions: [],
      quiescenceSeconds: 300,
    },
  };
  try {
    await writeFile(configFile, JSON.stringify(config));
    await writeFile(replacementFile, JSON.stringify({
      ...config,
      insights: { ...config.insights, excludeProviders: [] },
    }));
    let replaced = false;
    const loaded = await loadInsightsConfig({
      paths: { configFile },
      platform: "win32",
      async windowsAcl(target, details) {
        if (!replaced && target === configFile && details.kind === "file") {
          replaced = true;
          await rename(replacementFile, configFile);
        }
      },
    });
    assert.equal(replaced, true);
    assert.deepEqual(loaded.insights.excludeProviders, ["codex"]);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("syncs parent directories after config replacement and origin-secret linking", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-dir-sync-"));
  const configDirectory = path.join(directory, "config");
  const stateDirectory = path.join(directory, "state");
  const synced = [];
  const options = {
    platform: "linux",
    environment: {
      THREADSHARE_CONFIG: path.join(configDirectory, "config.json"),
      THREADSHARE_INSIGHTS_HOME: stateDirectory,
    },
    async syncDirectory(target) {
      synced.push(target);
    },
  };
  try {
    await saveInsightsConfig(await loadInsightsConfig(options), options);
    await openInsightsState(options);
    assert.ok(synced.includes(configDirectory));
    assert.ok(synced.includes(stateDirectory));
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("rejects unknown config fields and out-of-range quiescence", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-invalid-config-"));
  const configFile = path.join(directory, "config.json");
  const options = {
    platform: "linux",
    homeDirectory: directory,
    environment: { THREADSHARE_CONFIG: configFile },
  };
  try {
    await writeFile(
      configFile,
      JSON.stringify({
        format: "threadshare-config@v1",
        schemaVersion: 1,
        insights: {
          excludeProviders: [],
          excludeProjects: [],
          excludeSessions: [],
          quiescenceSeconds: 59,
          unexpected: true,
        },
      }),
    );
    await assert.rejects(
      loadInsightsConfig(options),
      (error) =>
        error?.code === "TS_INSIGHTS_CONFIG_INVALID" && error.validationErrors?.length >= 2,
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("never regenerates a missing or corrupt origin secret implicitly", async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-secret-recovery-"));
  const options = {
    platform: "linux",
    homeDirectory: directory,
    environment: { THREADSHARE_INSIGHTS_HOME: path.join(directory, "state") },
  };
  try {
    const state = await openInsightsState(options);
    await writeFile(state.paths.databaseFile, "derived state");
    await rm(state.paths.originSecretFile);
    await assert.rejects(
      openInsightsState(options),
      (error) => error?.code === "TS_INSIGHTS_ORIGIN_SECRET_MISSING",
    );

    await rm(state.paths.databaseFile);
    await writeFile(state.paths.originSecretFile, "{invalid-json", { mode: 0o600 });
    await assert.rejects(
      openInsightsState(options),
      (error) => error?.code === "TS_INSIGHTS_ORIGIN_SECRET_INVALID",
    );
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
