import { execFile } from "node:child_process";
import { constants as fsConstants } from "node:fs";
import { lstat, open, readdir, realpath, stat } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { exportSessionById } from "./session-export.mjs";

const UUID_PATTERN =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const UUID_SHAPE = "00000000-0000-0000-0000-000000000000";
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_BUFFER = 1024 * 1024;

function isObject(value) {
  return value !== null && typeof value === "object" && !Array.isArray(value);
}

function isUuidPrefix(value) {
  if (typeof value !== "string" || value.length === 0 || value.length > UUID_SHAPE.length) {
    return false;
  }
  for (let index = 0; index < value.length; index += 1) {
    if (UUID_SHAPE[index] === "-") {
      if (value[index] !== "-") return false;
    } else if (!/[0-9a-f]/i.test(value[index])) {
      return false;
    }
  }
  return true;
}

function parseJsonObject(value, label) {
  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch {
    throw new Error(`${label} returned invalid JSON`);
  }
  if (!isObject(parsed)) throw new Error(`${label} returned an invalid JSON object`);
  return parsed;
}

function optionalVersion(value, field) {
  if (value === undefined) return "unknown";
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`Paseo daemon status returned an invalid ${field}`);
  }
  return value.trim();
}

function parseDaemonStatus(stdout) {
  const status = parseJsonObject(stdout, "Paseo daemon status");
  const cliVersion = optionalVersion(status.cliVersion, "cliVersion");
  const daemonVersion = optionalVersion(status.daemonVersion, "daemonVersion");
  const versions = `Paseo CLI ${cliVersion}, daemon ${daemonVersion}`;
  if (typeof status.connectedDaemon !== "string") {
    throw new Error(`Paseo daemon status returned an invalid connectedDaemon (${versions})`);
  }
  if (status.connectedDaemon !== "reachable") {
    throw new Error(`Paseo daemon is not reachable (${versions})`);
  }
  if (typeof status.home !== "string" || !path.isAbsolute(status.home)) {
    throw new Error(`Paseo daemon status returned an invalid home (${versions})`);
  }
  return { home: status.home, versions };
}

function parseAgentInspect(stdout, versions, agentReference) {
  const agent = parseJsonObject(stdout, "Paseo agent inspect");
  if (typeof agent.Id !== "string" || !UUID_PATTERN.test(agent.Id)) {
    throw new Error(`Paseo agent inspect returned an invalid Id (${versions})`);
  }
  if (!agent.Id.toLowerCase().startsWith(agentReference.toLowerCase())) {
    throw new Error(
      `Paseo inspected agent ID does not match the requested reference (${versions})`,
    );
  }
  if (typeof agent.Provider !== "string" || agent.Provider.trim() === "") {
    throw new Error(`Paseo agent inspect returned an invalid Provider (${versions})`);
  }
  const provider = agent.Provider.trim();
  if (provider !== "codex" && provider !== "claude") {
    throw new Error(`Threadshare does not support Paseo provider ${provider} (${versions})`);
  }
  if (typeof agent.Status !== "string" || agent.Status.trim() === "") {
    throw new Error(`Paseo agent inspect returned an invalid Status (${versions})`);
  }
  if (agent.Name !== undefined && typeof agent.Name !== "string") {
    throw new Error(`Paseo agent inspect returned an invalid Name (${versions})`);
  }
  if (agent.Model !== undefined && typeof agent.Model !== "string") {
    throw new Error(`Paseo agent inspect returned an invalid Model (${versions})`);
  }
  const title = agent.Name?.trim() || "Paseo conversation";
  const model = agent.Model?.trim() || undefined;
  return {
    id: agent.Id,
    model,
    provider,
    status: agent.Status.trim(),
    title,
  };
}

function stderrMessage(stderr) {
  const value = typeof stderr === "string" ? stderr.trim() : "";
  if (!value) return undefined;
  try {
    const payload = JSON.parse(value);
    if (typeof payload?.error?.message === "string" && payload.error.message.trim()) {
      return payload.error.message.trim();
    }
    if (typeof payload?.message === "string" && payload.message.trim()) {
      return payload.message.trim();
    }
  } catch {
    // Fall through to the first useful text line.
  }
  return value
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line && line !== "{" && line !== "}");
}

function runPaseo(args, options = {}) {
  const command = options.paseoCommand ?? "paseo";
  const timeout = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const maxBuffer = options.maxBuffer ?? DEFAULT_MAX_BUFFER;
  return new Promise((resolve, reject) => {
    execFile(
      command,
      args,
      {
        encoding: "utf8",
        env: options.env ?? process.env,
        killSignal: "SIGTERM",
        maxBuffer,
        timeout,
        windowsHide: true,
      },
      (error, stdout, stderr) => {
        if (!error) {
          resolve(stdout);
          return;
        }
        if (error.code === "ENOENT") {
          reject(new Error("Paseo CLI was not found on PATH"));
          return;
        }
        if (error.killed || error.signal === "SIGTERM") {
          reject(new Error(`Paseo CLI timed out after ${timeout} ms`));
          return;
        }
        if (
          error.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER" ||
          error.message.includes("maxBuffer")
        ) {
          reject(new Error(`Paseo CLI output exceeded ${maxBuffer} bytes`));
          return;
        }
        const detail = stderrMessage(stderr);
        reject(new Error(detail ? `Paseo CLI failed: ${detail}` : "Paseo CLI failed"));
      },
    );
  });
}

function addVersions(error, versions, fallback) {
  const message = error instanceof Error ? error.message : fallback;
  if (message.includes(versions)) return new Error(message);
  return new Error(`${message} (${versions})`);
}

function stateFailure(error, versions) {
  if (error instanceof Error && /^(?:No|Multiple|Paseo) /.test(error.message)) {
    return addVersions(error, versions, "Unable to read Paseo agent state");
  }
  return new Error(`Unable to read Paseo agent state (${versions})`);
}

function isInside(root, candidate) {
  const relative = path.relative(root, candidate);
  return (
    relative !== "" &&
    relative !== ".." &&
    !relative.startsWith(`..${path.sep}`) &&
    !path.isAbsolute(relative)
  );
}

async function findStateFiles(agentsDirectory, agentId) {
  let rootMetadata;
  try {
    rootMetadata = await lstat(agentsDirectory);
  } catch {
    throw new Error("Paseo agents state directory is unavailable");
  }
  if (rootMetadata.isSymbolicLink() || !rootMetadata.isDirectory()) {
    throw new Error("Paseo agents state directory is not a regular directory");
  }
  const root = await realpath(agentsDirectory);
  const expectedName = `${agentId}.json`;
  const matches = [];

  async function visit(directory) {
    const directoryMetadata = await lstat(directory);
    if (directoryMetadata.isSymbolicLink() || !directoryMetadata.isDirectory()) return;
    const resolvedDirectory = await realpath(directory);
    if (resolvedDirectory !== root && !isInside(root, resolvedDirectory)) return;

    const entries = await readdir(directory);
    for (const name of entries) {
      const candidate = path.join(directory, name);
      let metadata;
      try {
        metadata = await lstat(candidate);
      } catch {
        throw new Error("Paseo state changed while it was being inspected");
      }
      if (metadata.isSymbolicLink()) continue;
      if (metadata.isDirectory()) {
        await visit(candidate);
      } else if (metadata.isFile() && name === expectedName) {
        matches.push(candidate);
      }
    }
  }

  await visit(root);
  return { matches, root };
}

function sameFile(left, right) {
  return left.dev === right.dev && left.ino === right.ino;
}

async function readStateFile(root, candidate) {
  const before = await lstat(candidate);
  if (before.isSymbolicLink() || !before.isFile()) {
    throw new Error("Paseo state file is not a regular file");
  }
  const noFollow = typeof fsConstants.O_NOFOLLOW === "number" ? fsConstants.O_NOFOLLOW : 0;
  let handle;
  try {
    handle = await open(candidate, fsConstants.O_RDONLY | noFollow);
  } catch {
    throw new Error("Paseo state file changed before it could be opened");
  }
  try {
    const opened = await handle.stat();
    if (!opened.isFile() || !sameFile(before, opened)) {
      throw new Error("Paseo state file changed before it could be read");
    }
    const resolved = await realpath(candidate);
    if (!isInside(root, resolved)) {
      throw new Error("Paseo state file resolves outside the agents directory");
    }
    const linked = await stat(resolved);
    if (!sameFile(opened, linked)) {
      throw new Error("Paseo state file changed before it could be read");
    }
    return await handle.readFile({ encoding: "utf8" });
  } finally {
    await handle.close();
  }
}

function stateContainer(state, field) {
  const value = state[field];
  if (value === undefined) return undefined;
  if (!isObject(value)) throw new Error(`Paseo state ${field} must be an object`);
  return value;
}

function stateHandle(container, field) {
  if (!container || container[field] === undefined) return undefined;
  const value = container[field];
  if (typeof value !== "string") {
    throw new Error(`Paseo state ${field} must be a string`);
  }
  if (value.trim() === "") return undefined;
  if (value !== value.trim() || !UUID_PATTERN.test(value)) {
    throw new Error("Paseo native session ID must be a complete UUID");
  }
  return value;
}

function parseState(raw, agent) {
  let state;
  try {
    state = JSON.parse(raw);
  } catch {
    throw new Error("Paseo state file contains invalid JSON");
  }
  if (!isObject(state)) throw new Error("Paseo state file must contain a JSON object");
  if (typeof state.id !== "string" || !UUID_PATTERN.test(state.id)) {
    throw new Error("Paseo state contains an invalid agent ID");
  }
  if (state.id !== agent.id) throw new Error("Paseo state agent ID does not match inspect");
  if (typeof state.provider !== "string") {
    throw new Error("Paseo state contains an invalid provider");
  }
  if (state.provider !== agent.provider) {
    throw new Error("Paseo state provider does not match inspect");
  }

  const persistence = stateContainer(state, "persistence");
  const nativeHandle = stateHandle(persistence, "nativeHandle");
  if (nativeHandle) return nativeHandle;
  const runtimeInfo = stateContainer(state, "runtimeInfo");
  const sessionId = stateHandle(runtimeInfo, "sessionId");
  if (!sessionId) throw new Error("Paseo state does not contain a native session ID");
  return sessionId;
}

export async function exportPaseoSession(agentReference, options = {}) {
  if (!isUuidPrefix(agentReference)) {
    throw new Error("Paseo agent reference must be a UUID or UUID prefix");
  }

  const statusStdout = await runPaseo(["daemon", "status", "--json"], options);
  const daemon = parseDaemonStatus(statusStdout);
  let inspectStdout;
  try {
    inspectStdout = await runPaseo(
      ["agent", "inspect", agentReference, "--json"],
      options,
    );
  } catch (error) {
    throw addVersions(error, daemon.versions, "Paseo agent inspect failed");
  }
  let agent;
  try {
    agent = parseAgentInspect(inspectStdout, daemon.versions, agentReference);
  } catch (error) {
    throw addVersions(error, daemon.versions, "Paseo agent inspect failed");
  }

  let nativeSessionId;
  try {
    const { matches, root } = await findStateFiles(
      path.join(daemon.home, "agents"),
      agent.id,
    );
    if (matches.length === 0) {
      throw new Error("No Paseo state file found for inspected agent");
    }
    if (matches.length > 1) {
      throw new Error("Multiple Paseo state files found for inspected agent");
    }
    nativeSessionId = parseState(await readStateFile(root, matches[0]), agent);
  } catch (error) {
    throw stateFailure(error, daemon.versions);
  }

  let history;
  try {
    history = await exportSessionById(agent.provider, nativeSessionId, {
      environment: options.env ?? process.env,
    });
  } catch (error) {
    if (error instanceof Error && error.message.startsWith(`No ${agent.provider} session matches`)) {
      throw new Error(
        `No native ${agent.provider} session found for Paseo agent (${daemon.versions})`,
      );
    }
    if (
      error instanceof Error &&
      error.message.startsWith(`Multiple ${agent.provider} sessions match`)
    ) {
      throw new Error(
        `Multiple native ${agent.provider} sessions found for Paseo agent (${daemon.versions})`,
      );
    }
    if (error && typeof error === "object" && "code" in error) {
      throw new Error(
        `Unable to read native ${agent.provider} session for Paseo agent (${daemon.versions})`,
      );
    }
    throw error;
  }
  if (
    typeof history.conversation?.id !== "string" ||
    history.conversation.id.toLowerCase() !== nativeSessionId.toLowerCase()
  ) {
    throw new Error(
      `Native ${agent.provider} session ID does not match Paseo state (${daemon.versions})`,
    );
  }

  const conversation = {
    ...history.conversation,
    id: agent.id,
    title: agent.title,
    provider: agent.provider,
    source: "paseo",
  };
  if (agent.model) conversation.model = agent.model;
  else delete conversation.model;
  return { ...history, conversation };
}
