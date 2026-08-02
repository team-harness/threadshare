#!/usr/bin/env node

import { readFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { pathToFileURL } from "node:url";
import { parse as parseYaml } from "yaml";

const ALLOWED_FRONTMATTER_KEYS = new Set([
  "allowed-tools",
  "description",
  "license",
  "metadata",
  "name",
]);
const SKILL_NAME_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

function requireNonEmptyString(value, label) {
  if (typeof value !== "string" || value.trim() === "") {
    throw new Error(`${label} must be a non-empty string`);
  }
  return value.trim();
}

function parseYamlDocument(source, label) {
  try {
    const value = parseYaml(source);
    if (!value || typeof value !== "object" || Array.isArray(value)) {
      throw new Error("must be a YAML dictionary");
    }
    return value;
  } catch (error) {
    throw new Error(`${label} is invalid: ${error.message}`);
  }
}

function validateFrontmatter(source, skillDirectory) {
  const match = /^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/.exec(source);
  if (!match) {
    throw new Error("SKILL.md must start with YAML frontmatter");
  }
  const frontmatter = parseYamlDocument(match[1], "SKILL.md frontmatter");
  const unexpected = Object.keys(frontmatter).filter((key) => !ALLOWED_FRONTMATTER_KEYS.has(key));
  if (unexpected.length > 0) {
    throw new Error(`SKILL.md frontmatter has unexpected keys: ${unexpected.sort().join(", ")}`);
  }

  const name = requireNonEmptyString(frontmatter.name, "SKILL.md name");
  if (name.length > 64 || !SKILL_NAME_PATTERN.test(name)) {
    throw new Error("SKILL.md name must be 1-64 lowercase letters, digits, or single hyphens");
  }
  if (name !== path.basename(skillDirectory)) {
    throw new Error("SKILL.md name must match the skill directory");
  }

  const description = requireNonEmptyString(frontmatter.description, "SKILL.md description");
  if (description.length > 1024 || /[<>]/.test(description)) {
    throw new Error("SKILL.md description must be at most 1024 characters without angle brackets");
  }
  return { description, name };
}

function validateOpenAiMetadata(source, skillName) {
  const document = parseYamlDocument(source, "agents/openai.yaml");
  const interfaceMetadata = document.interface;
  if (!interfaceMetadata || typeof interfaceMetadata !== "object" || Array.isArray(interfaceMetadata)) {
    throw new Error("agents/openai.yaml interface must be a YAML dictionary");
  }
  requireNonEmptyString(interfaceMetadata.display_name, "agents/openai.yaml display_name");
  const shortDescription = requireNonEmptyString(
    interfaceMetadata.short_description,
    "agents/openai.yaml short_description",
  );
  if (shortDescription.length < 25 || shortDescription.length > 64) {
    throw new Error("agents/openai.yaml short_description must be 25-64 characters");
  }
  const defaultPrompt = requireNonEmptyString(
    interfaceMetadata.default_prompt,
    "agents/openai.yaml default_prompt",
  );
  if (!defaultPrompt.includes(`$${skillName}`)) {
    throw new Error(`agents/openai.yaml default_prompt must mention $${skillName}`);
  }
}

export async function validateSkillDirectory(skillDirectory) {
  const resolvedDirectory = path.resolve(skillDirectory);
  let skillSource;
  let openAiSource;
  try {
    [skillSource, openAiSource] = await Promise.all([
      readFile(path.join(resolvedDirectory, "SKILL.md"), "utf8"),
      readFile(path.join(resolvedDirectory, "agents", "openai.yaml"), "utf8"),
    ]);
  } catch (error) {
    throw new Error(`Skill files are incomplete: ${error.message}`);
  }
  const { name } = validateFrontmatter(skillSource, resolvedDirectory);
  validateOpenAiMetadata(openAiSource, name);
  return { directory: resolvedDirectory, name };
}

async function main() {
  if (process.argv.length !== 3) {
    throw new Error("Usage: node scripts/validate-skill.mjs <skill-directory>");
  }
  await validateSkillDirectory(process.argv[2]);
  process.stdout.write("Skill is valid!\n");
}

const isMain = process.argv[1]
  ? import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href
  : false;
if (isMain) {
  main().catch((error) => {
    process.stderr.write(`${error.message}\n`);
    process.exitCode = 1;
  });
}
