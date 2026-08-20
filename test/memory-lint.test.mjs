import assert from "node:assert/strict";
import test from "node:test";

import { serializeMemoryEntry } from "../src/memory-format.mjs";
import { lintEntryForPromotion, lintMemoryText } from "../src/memory-lint.mjs";

const COMMIT_HASH = "7fd2f23a1b04c9e8d2f6a35b7c01d94e8f123456";

function codes(findings) {
  return findings.map((item) => item.code);
}

function assertBlocked(text, code) {
  const findings = lintMemoryText(text);
  const hits = findings.filter((item) => item.code === code);
  assert.ok(hits.length > 0, `expected ${code} in ${JSON.stringify(codes(findings))}`);
  for (const hit of hits) {
    assert.equal(hit.severity, "block");
    assert.equal(typeof hit.index, "number");
  }
}

function assertClean(text, code) {
  const findings = lintMemoryText(text).filter((item) => item.code === code);
  assert.deepEqual(findings, [], `expected no ${code} finding`);
}

test("detects AWS access keys", () => {
  assertBlocked("key AKIAIOSFODNN7EXAMPLE used in deploy", "MEMORY_LINT_AWS_ACCESS_KEY");
  assertBlocked("temporary key ASIAIOSFODNN7EXAMPLE from STS", "MEMORY_LINT_AWS_ACCESS_KEY");
  assertClean("AKIAIOSF is too short", "MEMORY_LINT_AWS_ACCESS_KEY");
  assertClean("ASIAIOSF is too short", "MEMORY_LINT_AWS_ACCESS_KEY");
  assertClean("BAKIAIOSFODNN7EXAMPLE has a letter prefix", "MEMORY_LINT_AWS_ACCESS_KEY");
});

test("detects GitHub tokens", () => {
  assertBlocked("ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "MEMORY_LINT_GITHUB_TOKEN");
  assertBlocked("gho_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "MEMORY_LINT_GITHUB_TOKEN");
  assertBlocked("ghs_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "MEMORY_LINT_GITHUB_TOKEN");
  assertBlocked("ghu_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "MEMORY_LINT_GITHUB_TOKEN");
  assertBlocked("ghr_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "MEMORY_LINT_GITHUB_TOKEN");
  assertBlocked("github_pat_11ABCDEFG0abcdefghijklmnopqrstuv", "MEMORY_LINT_GITHUB_TOKEN");
  assertClean("ghp_short", "MEMORY_LINT_GITHUB_TOKEN");
  assertClean("ghu_short", "MEMORY_LINT_GITHUB_TOKEN");
  assertClean("use the github pat workflow", "MEMORY_LINT_GITHUB_TOKEN");
});

test("detects GitLab, npm, and Google API tokens", () => {
  assertBlocked("glpat-AbCdEfGhIjKlMnOpQrSt", "MEMORY_LINT_GITLAB_TOKEN");
  assertClean("glpat-short", "MEMORY_LINT_GITLAB_TOKEN");
  assertBlocked("npm_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789", "MEMORY_LINT_NPM_TOKEN");
  assertClean("npm_short", "MEMORY_LINT_NPM_TOKEN");
  assertClean("run npm_install alias", "MEMORY_LINT_NPM_TOKEN");
  assertBlocked("AIzaSyA1bC2dE3fG4hI5jK6lM7nO8pQ9rS0tUvW", "MEMORY_LINT_GOOGLE_API_KEY");
  assertClean("AIzaShort", "MEMORY_LINT_GOOGLE_API_KEY");
});

test("detects Slack tokens", () => {
  assertBlocked("xox" + "b-1234567890-abcdefghijklmn", "MEMORY_LINT_SLACK_TOKEN");
  assertBlocked("xox" + "p-1234567890-abcdefghijklmn", "MEMORY_LINT_SLACK_TOKEN");
  assertClean("xoxz-1234567890-abcdefghijklmn", "MEMORY_LINT_SLACK_TOKEN");
});

test("detects OpenAI/Anthropic style API keys", () => {
  assertBlocked("sk-ant-api03-AbCdEf0123456789AbCdEf", "MEMORY_LINT_MODEL_API_KEY");
  assertBlocked("sk-proj-AbCdEf0123456789AbCdEf01", "MEMORY_LINT_MODEL_API_KEY");
  assertClean("sk-short", "MEMORY_LINT_MODEL_API_KEY");
});

test("detects private key blocks", () => {
  assertBlocked("-----BEGIN OPENSSH PRIVATE KEY-----", "MEMORY_LINT_PRIVATE_KEY_BLOCK");
  assertBlocked("-----BEGIN RSA PRIVATE KEY-----", "MEMORY_LINT_PRIVATE_KEY_BLOCK");
  assertBlocked("-----BEGIN PRIVATE KEY-----", "MEMORY_LINT_PRIVATE_KEY_BLOCK");
  assertClean("-----BEGIN PUBLIC KEY-----", "MEMORY_LINT_PRIVATE_KEY_BLOCK");
});

test("detects JWTs", () => {
  assertBlocked(
    "token eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiIxMjM0NTY3ODkwIn0.c2lnbmF0dXJlLXNpZ25hdHVyZQ",
    "MEMORY_LINT_JWT",
  );
  assertClean("eyJhbGciOiJIUzI1NiJ9 alone is not a JWT", "MEMORY_LINT_JWT");
  assertClean("prefix.eyJz.short", "MEMORY_LINT_JWT");
});

test("detects credentials embedded in URLs", () => {
  assertBlocked("clone https://alice:hunter2@git.example.com/repo.git", "MEMORY_LINT_URL_CREDENTIALS");
  assertClean("clone https://git.example.com/repo.git", "MEMORY_LINT_URL_CREDENTIALS");
  assertClean("ssh://git@github.com/org/repo.git has no password", "MEMORY_LINT_URL_CREDENTIALS");
});

test("detects high-entropy strings from 20 characters up, with no hex exemption in prose", () => {
  assertBlocked("secret A7fK9mQ2xVbZ8cRt4YwPl6NhE3sDgU1oZq5J here", "MEMORY_LINT_HIGH_ENTROPY");
  // Contract: tokens of 20+ characters are scanned. A 27-character high-entropy
  // token must alert (the previous 28 minimum let it slip through).
  assertBlocked("token A7fK9mQ2xVbZ8cRt4YwPl6NhE3s leaked", "MEMORY_LINT_HIGH_ENTROPY");
  // Contract: a hex64 in prose is NOT exempt — `secret: <64-hex>` must alert
  // regardless of case (the previous unconditional hex exemption hid it).
  assertBlocked(`secret: ${"0123456789abcdef".repeat(4)}`, "MEMORY_LINT_HIGH_ENTROPY");
  assertBlocked(`secret: ${"0123456789ABCDEF".repeat(4)}`, "MEMORY_LINT_HIGH_ENTROPY");
  // A real git commit hash in prose stays clean because hex40 entropy cannot
  // reach the threshold — not because of any hex exemption.
  assertClean(`fixed in commit ${COMMIT_HASH}`, "MEMORY_LINT_HIGH_ENTROPY");
  // Low-entropy long tokens, ordinary prose, and sub-20-character tokens stay clean.
  assertClean("abcabcabcabcabcabcabcabcabcabcabc", "MEMORY_LINT_HIGH_ENTROPY");
  assertClean("staging-mobile-e2e-suite-verification-notes", "MEMORY_LINT_HIGH_ENTROPY");
  assertClean("short A7fK9mQ2xVbZ8cRt4Y", "MEMORY_LINT_HIGH_ENTROPY");
});

test("allowedSpans exempts structured evidence context, and only that", () => {
  const digest = "0123456789abcdef".repeat(4);
  const text = `evidence {"hash":"${digest}"} and prose ${digest}`;
  const first = text.indexOf(digest);
  const second = text.indexOf(digest, first + 1);
  // Without spans both occurrences alert.
  assert.equal(
    lintMemoryText(text).filter((item) => item.code === "MEMORY_LINT_HIGH_ENTROPY").length,
    2,
  );
  // With a span covering only the structured occurrence, the prose one still alerts.
  const findings = lintMemoryText(text, {
    allowedSpans: [{ start: first, end: first + digest.length }],
  }).filter((item) => item.code === "MEMORY_LINT_HIGH_ENTROPY");
  assert.equal(findings.length, 1);
  assert.equal(findings[0].index, second);
  // A span must fully cover the token to exempt it.
  const partial = lintMemoryText(text, {
    allowedSpans: [{ start: first, end: first + digest.length - 1 }],
  }).filter((item) => item.code === "MEMORY_LINT_HIGH_ENTROPY");
  assert.equal(partial.length, 2);
});

test("detects provider session ids by uuid context and path fragments", () => {
  assertBlocked(
    "resume session 6f9619ff-8b86-4d11-b42d-00c04fc964ff for details",
    "MEMORY_LINT_PROVIDER_SESSION_ID",
  );
  assertBlocked(
    "the agent id was 6f9619ff-8b86-4d11-b42d-00c04fc964ff",
    "MEMORY_LINT_PROVIDER_SESSION_ID",
  );
  assertBlocked("logs under ~/.claude/projects/-Users-x/", "MEMORY_LINT_PROVIDER_SESSION_ID");
  assertBlocked("stored in .codex/sessions on the laptop", "MEMORY_LINT_PROVIDER_SESSION_ID");
  // Windows session path shapes are provider session material too.
  assertBlocked(
    "logs under C:\\Users\\x\\.claude\\projects\\-Users-x\\",
    "MEMORY_LINT_PROVIDER_SESSION_ID",
  );
  assertBlocked("stored in C:\\Users\\x\\.codex\\sessions", "MEMORY_LINT_PROVIDER_SESSION_ID");
  assertBlocked(
    "cache at C:\\Users\\x\\AppData\\Roaming\\Claude\\logs",
    "MEMORY_LINT_PROVIDER_SESSION_ID",
  );
  // A v4 uuid without session/agent context is allowed.
  assertClean(
    "deployment 6f9619ff-8b86-4d11-b42d-00c04fc964ff finished",
    "MEMORY_LINT_PROVIDER_SESSION_ID",
  );
  // A non-v4 uuid near session context is allowed.
  assertClean(
    "session 6f9619ff-8b86-1d11-b42d-00c04fc964ff legacy id",
    "MEMORY_LINT_PROVIDER_SESSION_ID",
  );
});

test("warns on absolute home paths, emails, and ip:port", () => {
  for (const [text, code] of [
    ["see /Users/wyatt/work/threadshare/notes.md", "MEMORY_LINT_ABSOLUTE_PATH"],
    ["see /home/alice/notes.md", "MEMORY_LINT_ABSOLUTE_PATH"],
    ["contact dev@example.com for access", "MEMORY_LINT_EMAIL"],
    ["listens on 10.0.0.1:8080 internally", "MEMORY_LINT_IP_PORT"],
  ]) {
    const findings = lintMemoryText(text).filter((item) => item.code === code);
    assert.equal(findings.length, 1, `expected one ${code}`);
    assert.equal(findings[0].severity, "warn");
  }
  assertClean("see docs/Users-guide.md", "MEMORY_LINT_ABSOLUTE_PATH");
  assertClean("release 1.2.3 shipped", "MEMORY_LINT_IP_PORT");
  assertClean("versions 1.2.3.4 are documented", "MEMORY_LINT_IP_PORT");
});

test("findings are sorted by index and excerpts are redacted", () => {
  const secret = "sk-abcdefghijklmnopqrstuvwx";
  const text = `first AKIAIOSFODNN7EXAMPLE then ${secret}`;
  const findings = lintMemoryText(text);
  // The secret may legitimately trip several rules (pattern + entropy); the
  // contract is that both expected rules fire and results are index-sorted.
  const patternFindings = findings.filter((item) =>
    ["MEMORY_LINT_AWS_ACCESS_KEY", "MEMORY_LINT_MODEL_API_KEY"].includes(item.code),
  );
  assert.deepEqual(codes(patternFindings), [
    "MEMORY_LINT_AWS_ACCESS_KEY",
    "MEMORY_LINT_MODEL_API_KEY",
  ]);
  for (let index = 1; index < findings.length; index += 1) {
    assert.ok(findings[index - 1].index <= findings[index].index, "findings must be index-sorted");
  }
  for (const item of findings) {
    assert.ok(!item.excerpt.includes(secret), "excerpt must not contain the full secret");
    assert.ok(item.excerpt.length <= 24);
    assert.match(item.excerpt, /…\[\d+ chars\]$/);
  }
});

function validEntryText(body) {
  return serializeMemoryEntry({
    frontmatter: {
      id: "auth-module-do-not-refactor",
      type: "work_method",
      status: "approved",
      priority: 85,
      confidence: "high",
      provenance_strength: "observed",
      claim_support: "human-confirmed",
      limitations: ["not-authorship"],
      scope: "repo",
      scene: "鉴权模块维护",
      occurred: ["2026-08-12"],
      evidence: {
        commits: [{ repo: "github.com/team-harness/threadshare", hash: COMMIT_HASH }],
        paths: ["routes/api/session.ts"],
      },
      superseded_by: null,
    },
    body,
  });
}

test("lintEntryForPromotion accepts a clean, valid entry", () => {
  const result = lintEntryForPromotion(validEntryText("别重构旧鉴权模块的 session 中间件。\n"));
  assert.equal(result.ok, true);
  assert.deepEqual(
    result.findings.filter((item) => item.severity === "block"),
    [],
  );
});

test("lintEntryForPromotion keeps ok=true when only warnings are present", () => {
  const result = lintEntryForPromotion(validEntryText("联系 dev@example.com 获取权限。\n"));
  assert.equal(result.ok, true);
  assert.deepEqual(codes(result.findings), ["MEMORY_LINT_EMAIL"]);
});

test("lintEntryForPromotion blocks entries carrying secrets", () => {
  const result = lintEntryForPromotion(validEntryText("token ghp_AbCdEfGhIjKlMnOpQrStUvWxYz0123456789\n"));
  assert.equal(result.ok, false);
  assert.ok(codes(result.findings).includes("MEMORY_LINT_GITHUB_TOKEN"));
});

test("lintEntryForPromotion exempts evidence hashes but not hex secrets in the body", () => {
  // Negative case: the evidence commit hash lives in the frontmatter's
  // structured context (evidence.commits[].hash), which the promotion gate
  // passes to the linter as allowedSpans — the entry stays promotable.
  const clean = lintEntryForPromotion(validEntryText("别重构旧鉴权模块。\n"));
  assert.equal(clean.ok, true);

  // Positive case: the same shape of hex material in the body has no
  // structured context and must block promotion.
  const hexSecret = "0123456789abcdef".repeat(4);
  const leaked = lintEntryForPromotion(validEntryText(`db seed secret: ${hexSecret}\n`));
  assert.equal(leaked.ok, false);
  assert.ok(codes(leaked.findings).includes("MEMORY_LINT_HIGH_ENTROPY"));
});

test("lintEntryForPromotion blocks entries with invalid frontmatter", () => {
  const result = lintEntryForPromotion("---\nid: broken\n---\nbody\n");
  assert.equal(result.ok, false);
  assert.ok(codes(result.findings).includes("MEMORY_FORMAT_MISSING_FIELD"));

  const unverified = validEntryText("body\n").replace(
    "claim_support: human-confirmed",
    "claim_support: unverified",
  );
  const rejected = lintEntryForPromotion(unverified);
  assert.equal(rejected.ok, false);
  assert.ok(codes(rejected.findings).includes("MEMORY_FORMAT_UNVERIFIED_CLAIM_SUPPORT"));
});
