import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

export const INSIGHTS_E2E_ENGINE = fileURLToPath(new URL(
  process.platform === "win32"
    ? "../../crates/insights-engine/target/debug/threadshare-insights-engine.exe"
    : "../../crates/insights-engine/target/debug/threadshare-insights-engine",
  import.meta.url,
));

const [nodeMajor, nodeMinor] = process.versions.node.split(".").map(Number);
const nodeSqliteAvailable = nodeMajor > 22 || (nodeMajor === 22 && nodeMinor >= 5);

export const INSIGHTS_E2E_SKIP = !nodeSqliteAvailable ||
  !existsSync(INSIGHTS_E2E_ENGINE)
  ? "requires Node 22.5+ and a debug Insights Engine build"
  : false;

function timestamp(second) {
  return `2026-08-10T09:00:${String(second).padStart(2, "0")}.000Z`;
}

function codexSessionRecords(sessionId) {
  return [
    {
      type: "session_meta",
      timestamp: timestamp(0),
      payload: { id: sessionId, cwd: "/private/threadshare-insights-project" },
    },
    {
      type: "event_msg",
      timestamp: timestamp(1),
      payload: { type: "task_started", turn_id: "turn-one" },
    },
    {
      type: "response_item",
      timestamp: timestamp(2),
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Find the continuity token in this project" }],
      },
    },
    {
      type: "response_item",
      timestamp: timestamp(3),
      payload: {
        type: "function_call",
        call_id: "call-one",
        name: "Read",
        arguments: JSON.stringify({ file_path: "/private/threadshare-insights-project/notes.md" }),
      },
    },
    {
      type: "response_item",
      timestamp: timestamp(4),
      payload: {
        type: "function_call_output",
        call_id: "call-one",
        output: "continuity token located",
        exit_code: 0,
      },
    },
    {
      type: "response_item",
      timestamp: timestamp(5),
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The continuity token is present." }],
      },
    },
    {
      type: "event_msg",
      timestamp: timestamp(6),
      payload: { type: "task_complete", turn_id: "turn-one" },
    },
    {
      type: "event_msg",
      timestamp: timestamp(7),
      payload: { type: "task_started", turn_id: "turn-two" },
    },
    {
      type: "response_item",
      timestamp: timestamp(8),
      payload: {
        type: "message",
        role: "user",
        content: [{ type: "input_text", text: "Summarize the indexed evidence" }],
      },
    },
    {
      type: "response_item",
      timestamp: timestamp(9),
      payload: {
        type: "message",
        role: "assistant",
        content: [{ type: "output_text", text: "The evidence is indexed and searchable." }],
      },
    },
    {
      type: "event_msg",
      timestamp: timestamp(10),
      payload: { type: "task_complete", turn_id: "turn-two" },
    },
  ];
}

export async function createInsightsE2EFixture(t, sessionId) {
  const directory = await mkdtemp(path.join(os.tmpdir(), "threadshare-insights-e2e-"));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const stateDirectory = path.join(directory, "state");
  const providerHome = path.join(directory, "providers");
  const codexHome = path.join(providerHome, "codex");
  const sessionDirectory = path.join(codexHome, "sessions", "2026", "08", "10");
  const sessionFile = path.join(
    sessionDirectory,
    `rollout-2026-08-10T09-00-00-${sessionId}.jsonl`,
  );
  const paths = {
    stateDirectory,
    configFile: path.join(directory, "config", "config.json"),
    databaseFile: path.join(stateDirectory, "insights.sqlite3"),
    originSecretFile: path.join(stateDirectory, "origin-secret.json"),
    lockFile: path.join(stateDirectory, "insights.lock"),
    tempDirectory: path.join(stateDirectory, "tmp"),
  };
  await mkdir(sessionDirectory, { recursive: true });
  await writeFile(
    sessionFile,
    `${codexSessionRecords(sessionId).map((record) => JSON.stringify(record)).join("\n")}\n`,
    { mode: 0o600 },
  );
  const reconcileOptions = {
    paths,
    discoveryOptions: {
      environment: { HOME: providerHome, CODEX_HOME: codexHome },
    },
    runtimeOptions: {
      env: { ...process.env, THREADSHARE_INSIGHTS_ENGINE_PATH: INSIGHTS_E2E_ENGINE },
    },
    reindexOptions: { availableBytes: 1024n * 1024n * 1024n },
    timeoutMs: 15_000,
  };
  return { directory, paths, providerHome, codexHome, sessionFile, sessionId, reconcileOptions };
}

function rows(database, sql) {
  return database.prepare(sql).all().map((row) => ({ ...row }));
}

function scalar(database, sql, ...parameters) {
  return Number(database.prepare(sql).get(...parameters).value);
}

export async function readInsightsDatabaseAudit(databaseFile) {
  const { DatabaseSync } = await import("node:sqlite");
  const database = new DatabaseSync(databaseFile, { readOnly: true });
  try {
    const firstNaturalTerm = database.prepare(
      "SELECT term FROM turns_fts_vocab WHERE col='natural' ORDER BY term LIMIT 1",
    ).get()?.term ?? null;
    return {
      stableIdentity: {
        sessions: rows(database, `
          SELECT lower(hex(session_key)) AS sessionKey, provider, session_scope AS sessionScope,
                 eligibility, duplicate_method AS duplicateMethod,
                 duplicate_confidence AS duplicateConfidence
          FROM sessions ORDER BY sessionKey
        `),
        turns: rows(database, `
          SELECT lower(hex(turn_key)) AS turnKey, problem_text AS problemText,
                 final_answer_excerpt AS finalAnswerExcerpt, provider_terminal AS providerTerminal,
                 effective_provider_visibility AS providerVisibility
          FROM turns ORDER BY turnKey
        `),
        sourceRecords: rows(database, `
          SELECT lower(hex(source_record_key)) AS sourceRecordKey, provider_record_class AS recordClass
          FROM source_records ORDER BY sourceRecordKey
        `),
        events: rows(database, `
          SELECT lower(hex(event_key)) AS eventKey, event_kind AS eventKind
          FROM evidence_events ORDER BY eventKey
        `),
        capabilities: rows(database, `
          SELECT lower(hex(capability_key)) AS capabilityKey, capability_kind AS capabilityKind,
                 canonical_name AS canonicalName
          FROM capabilities ORDER BY capabilityKey
        `),
        uses: rows(database, `
          SELECT lower(hex(use_key)) AS useKey, exact_observed_name AS observedName,
                 provider_terminal_state AS terminalState, strength
          FROM capability_uses ORDER BY useKey
        `),
      },
      keyedFacts: {
        projectKeys: rows(database, `
          SELECT lower(hex(project_key)) AS value FROM sessions
          WHERE project_key IS NOT NULL ORDER BY value
        `),
        inputFingerprints: rows(database, `
          SELECT lower(hex(input_fingerprint)) AS value FROM capability_uses
          WHERE input_fingerprint IS NOT NULL ORDER BY value
        `),
        turnRevisions: rows(database, `
          SELECT lower(hex(revision)) AS value FROM turns
          WHERE revision IS NOT NULL ORDER BY value
        `),
        rollupBuckets: rows(database, `
          SELECT DISTINCT dimension, lower(hex(bucket_key)) AS bucketKey
          FROM turn_rollup_contributions ORDER BY dimension, bucketKey
        `),
      },
      checkpointEpochs: rows(database, `
        SELECT DISTINCT origin_secret_epoch AS originSecretEpoch
        FROM source_checkpoints ORDER BY originSecretEpoch
      `),
      facts: {
        sessions: scalar(database, "SELECT COUNT(*) AS value FROM sessions"),
        turns: scalar(database, "SELECT COUNT(*) AS value FROM turns"),
        events: scalar(database, "SELECT COUNT(*) AS value FROM evidence_events"),
        uses: scalar(database, "SELECT COUNT(*) AS value FROM capability_uses"),
      },
      fts: {
        documents: scalar(database, "SELECT COUNT(*) AS value FROM turn_fts_documents"),
        naturalDocuments: scalar(
          database,
          "SELECT fts_doc_count AS value FROM field_stats WHERE field='natural'",
        ),
        terms: scalar(database, "SELECT COUNT(*) AS value FROM turns_fts_vocab"),
        firstNaturalTerm,
        firstNaturalTermMatches: firstNaturalTerm === null
          ? 0
          : scalar(
              database,
              "SELECT COUNT(*) AS value FROM turns_fts WHERE turns_fts MATCH ?",
              firstNaturalTerm,
            ),
      },
      projections: {
        rollupRows: scalar(database, "SELECT COUNT(*) AS value FROM turn_rollup_contributions"),
        retryRows: scalar(database, "SELECT COUNT(*) AS value FROM capability_retry_contributions"),
      },
      integrity: database.prepare("PRAGMA quick_check").get().quick_check,
    };
  } finally {
    database.close();
  }
}
