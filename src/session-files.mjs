import { readdir } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import process from "node:process";

const SESSION_UUID_SOURCE =
  "[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}";

export const SESSION_UUID_PATTERN = new RegExp(`^${SESSION_UUID_SOURCE}$`, "i");
export const SESSION_UUID_IN_TEXT_PATTERN = new RegExp(SESSION_UUID_SOURCE, "i");

const SESSION_UUIDS_IN_TEXT_PATTERN = new RegExp(SESSION_UUID_SOURCE, "gi");
const SESSION_UUID_AT_END_PATTERN = new RegExp(`(${SESSION_UUID_SOURCE})\\.jsonl$`, "i");

function requireNativeProvider(provider) {
  if (provider !== "codex" && provider !== "claude") {
    throw new Error("Native session provider must be codex or claude");
  }
}

export function sessionRoot(provider, environment = process.env) {
  requireNativeProvider(provider);
  const home = environment.HOME || os.homedir();
  return provider === "codex"
    ? path.join(environment.CODEX_HOME ?? path.join(home, ".codex"), "sessions")
    : path.join(home, ".claude", "projects");
}

async function walkJsonl(root) {
  let entries;
  try {
    entries = await readdir(root, { withFileTypes: true });
  } catch (error) {
    if (error?.code === "ENOENT") return [];
    throw error;
  }

  const files = [];
  for (const entry of entries) {
    const file = path.join(root, entry.name);
    if (entry.isDirectory()) files.push(...(await walkJsonl(file)));
    else if (entry.isFile() && entry.name.endsWith(".jsonl")) files.push(file);
  }
  return files;
}

export async function discoverSessionFiles(provider, options = {}) {
  const environment = options.environment ?? process.env;
  return walkJsonl(sessionRoot(provider, environment));
}

export function canonicalSessionId(provider, file) {
  requireNativeProvider(provider);
  const basename = path.basename(file);
  const id = SESSION_UUID_AT_END_PATTERN.exec(basename)?.[1];
  if (!id) return null;
  if (provider === "claude" && basename !== `${id}.jsonl`) return null;
  return id;
}

export function sessionIdsInFileName(file) {
  return [...path.basename(file).matchAll(SESSION_UUIDS_IN_TEXT_PATTERN)].map((match) => match[0]);
}

export async function resolveSessionFile(provider, value, options = {}) {
  if (value.includes("/") || value.endsWith(".jsonl")) return path.resolve(value);
  const files = await discoverSessionFiles(provider, options);
  const matches = files.filter((file) => path.basename(file).includes(value));
  if (matches.length === 0) throw new Error(`No ${provider} session matches ${value}`);
  if (matches.length > 1) {
    throw new Error(`Multiple ${provider} sessions match ${value}; pass a file path`);
  }
  return matches[0];
}
