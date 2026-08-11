import { lstat, realpath } from "node:fs/promises";
import path from "node:path";

import { insightsChildEnv, insightsRequiredContract } from "./insights-command.mjs";
import { createInsightsEngineClient } from "./insights-engine-client.mjs";
import { openExistingInsightsState } from "./insights-state.mjs";

const FATAL_READ_CODES = new Set([
  "TS_INSIGHTS_ENGINE_ABORTED",
  "TS_INSIGHTS_ENGINE_DISCONNECTED",
  "TS_INSIGHTS_ENGINE_TIMEOUT",
]);

function readerError(code, message, cause) {
  const error = cause === undefined ? new Error(message) : new Error(message, { cause });
  error.code = code;
  return error;
}

export async function insightsDatabaseIdentity(file) {
  let value;
  try {
    value = await lstat(file, { bigint: true });
  } catch (error) {
    if (error?.code === "ENOENT") return null;
    throw error;
  }
  if (!value.isFile() || value.isSymbolicLink()) {
    throw readerError("TS_INSIGHTS_STATE_INVALID", "Insights database is not a regular file");
  }
  return Object.freeze({
    dev: value.dev.toString(),
    ino: value.ino.toString(),
    size: value.size.toString(),
    mtimeNs: value.mtimeNs.toString(),
  });
}

function sameIdentity(left, right) {
  return left !== null && right !== null &&
    left.dev === right.dev && left.ino === right.ino &&
    left.size === right.size && left.mtimeNs === right.mtimeNs;
}

async function insightsDatabaseOpenPath(file) {
  const parent = await realpath(path.dirname(file));
  return path.join(parent, path.basename(file));
}

function fatalReadFailure(error) {
  return error?.fatal === true || FATAL_READ_CODES.has(error?.code);
}

export function createInsightsQueryReader(options) {
  if (!options?.paths || typeof options.originSecretEpoch !== "string") {
    throw new TypeError("paths and originSecretEpoch are required");
  }
  const createClient = options.createEngineClient ?? createInsightsEngineClient;
  let client = null;
  let identity = null;
  let opening = null;
  let invalidated = false;
  let closed = false;

  const closeClient = async (target = client) => {
    if (target === client) {
      client = null;
      identity = null;
    }
    if (target !== null) await target.close().catch(() => {});
  };

  const ensureClient = async () => {
    if (closed) {
      throw readerError("TS_INSIGHTS_ENGINE_CLOSED", "Insights query reader is closed");
    }
    if (opening !== null) return opening;
    opening = (async () => {
      for (let attempt = 0; attempt < 2; attempt += 1) {
        const before = await insightsDatabaseIdentity(options.paths.databaseFile);
        if (before === null) {
          await closeClient();
          invalidated = false;
          throw readerError("TS_INSIGHTS_NOT_INDEXED", "Insights index is not available yet");
        }
        if (!invalidated && client !== null && sameIdentity(identity, before)) return client;
        await closeClient();
        const databasePath = await insightsDatabaseOpenPath(options.paths.databaseFile);
        const next = await createClient({
          databasePath,
          openExisting: true,
          requiredContract: insightsRequiredContract(options.originSecretEpoch),
          runtimeOptions: options.runtimeOptions,
          childEnv: insightsChildEnv(options.paths, options),
          timeoutMs: options.timeoutMs,
          closeTimeoutMs: options.closeTimeoutMs,
        });
        let adopted = false;
        try {
          const after = await insightsDatabaseIdentity(options.paths.databaseFile);
          if (sameIdentity(before, after)) {
            client = next;
            identity = after;
            invalidated = false;
            adopted = true;
            return next;
          }
        } finally {
          if (!adopted) await next.close().catch(() => {});
        }
      }
      throw readerError(
        "TS_INSIGHTS_ENGINE_UNAVAILABLE",
        "Insights index changed while opening the query reader",
      );
    })().finally(() => {
      opening = null;
    });
    return opening;
  };

  const withClient = async (operation) => {
    const current = await ensureClient();
    try {
      return await operation(current);
    } catch (error) {
      if (fatalReadFailure(error)) await closeClient(current);
      throw error;
    }
  };
  const invoke = (method, input, requestOptions) =>
    withClient((current) => current[method](input, requestOptions));

  return Object.freeze({
    invalidate() {
      invalidated = true;
    },
    status(input) {
      return withClient(async (current) => {
        const [overview, purge] = await Promise.all([
          current.readInsightsOverview(input.overview, input.options),
          current.readPurgeStatus(null, input.options),
        ]);
        return Object.freeze({ overview, purge });
      });
    },
    overview(input, requestOptions) {
      return invoke("readInsightsOverview", input, requestOptions);
    },
    capabilities(input, requestOptions) {
      return invoke("listCapabilities", input, requestOptions);
    },
    search(input, requestOptions) {
      return invoke("searchTurns", input, requestOptions);
    },
    usage(input, requestOptions) {
      return invoke("readCapabilityUsage", input, requestOptions);
    },
    activity(input, requestOptions) {
      return invoke("readInsightsActivity", input, requestOptions);
    },
    evidence(input, requestOptions) {
      return invoke("readTurnEvidence", input, requestOptions);
    },
    async close() {
      if (closed) return;
      closed = true;
      if (opening !== null) await opening.catch(() => {});
      await closeClient();
    },
  });
}

export async function openInsightsQueryReader(options = {}) {
  const openState = options.openState ?? openExistingInsightsState;
  const state = await openState(options.stateOptions ?? options);
  return createInsightsQueryReader({
    ...options,
    paths: state.paths,
    originSecretEpoch: state.originSecretEpoch,
  });
}
