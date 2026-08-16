import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import test from "node:test";

import { createPrivacyContext } from "../src/session-facts.mjs";
import {
  parseMarkdownIntentSource,
  readMarkdownIntentSource,
} from "../src/insights-intent-source.mjs";

const privacyContext = createPrivacyContext({
  secret: Buffer.alloc(32, 17),
  originSecretEpoch: "11111111-1111-4111-8111-111111111111",
});

test("parses a bounded Markdown checklist into stable feature and story nodes", () => {
  const source = parseMarkdownIntentSource([
    "- [ ] Ship Delivery Trace {#delivery}",
    `  - [x] Index intent refs {#intent-refs} {session:${"a".repeat(64)}}`,
    `  - [ ] Link release {commit:${"b".repeat(40)}} {spec:docs/design.md}`,
    "",
  ].join("\n"), {
    locator: "docs/intent.md",
    repositoryId: "11111111-1111-4111-8111-111111111111",
    privacyContext,
  });

  assert.equal(source.coverage, "complete");
  assert.deepEqual(source.nodes.map(({ id, parentId, kind, status, stableId }) => ({
    id, parentId, kind, status, stableId,
  })), [
    { id: "delivery", parentId: null, kind: "feature", status: "todo", stableId: true },
    { id: "intent-refs", parentId: "delivery", kind: "story", status: "complete", stableId: true },
    {
      id: source.nodes[2].id,
      parentId: "delivery",
      kind: "story",
      status: "todo",
      stableId: false,
    },
  ]);
  assert.match(source.nodes[2].id, /^generated-[0-9a-f]{32}$/u);
  assert.deepEqual(source.refs.map(({ nodeId, kind }) => ({ nodeId, kind })), [
    { nodeId: "intent-refs", kind: "session" },
    { nodeId: source.nodes[2].id, kind: "commit" },
    { nodeId: source.nodes[2].id, kind: "spec" },
  ]);
  assert.equal(source.diagnostics.length, 0);
});

test("retains useful nodes and reports line-local malformed input", () => {
  const source = parseMarkdownIntentSource([
    "- [ ] Valid root {#root}",
    "   - [ ] Bad indentation {#bad}",
    "  - [ ] Useful child {session:not-a-key}",
  ].join("\n"), {
    locator: "intent.md",
    repositoryId: "11111111-1111-4111-8111-111111111111",
    privacyContext,
  });
  assert.equal(source.coverage, "partial");
  assert.equal(source.nodes.length, 2);
  assert.deepEqual(source.diagnostics.map(({ line, code }) => ({ line, code })), [
    { line: "2", code: "TS_INSIGHTS_INTENT_INDENT_INVALID" },
    { line: "3", code: "TS_INSIGHTS_INTENT_REF_INVALID" },
  ]);
});

test("duplicate explicit intent IDs fail closed", () => {
  assert.throws(
    () => parseMarkdownIntentSource("- [ ] One {#same}\n- [ ] Two {#same}\n", {
      locator: "intent.md",
      repositoryId: "11111111-1111-4111-8111-111111111111",
      privacyContext,
    }),
    (error) => error?.code === "TS_INSIGHTS_INTENT_DUPLICATE_ID" &&
      !String(error.message).includes("same"),
  );
});

test("reads only the configured repository-relative intent file", async (t) => {
  const rootDirectory = await mkdtemp(path.join(os.tmpdir(), "threadshare-intent-"));
  t.after(() => rm(rootDirectory, { recursive: true, force: true }));
  await writeFile(path.join(rootDirectory, "intent.md"), "- [ ] Ship {#ship}\n");
  const source = await readMarkdownIntentSource({
    repositoryId: "11111111-1111-4111-8111-111111111111",
    rootDirectory,
    intentPath: "intent.md",
  }, { privacyContext });
  assert.equal(source.locator, "intent.md");
  assert.equal(source.nodes[0].id, "ship");

  await assert.rejects(
    readMarkdownIntentSource({
      repositoryId: "11111111-1111-4111-8111-111111111111",
      rootDirectory,
      intentPath: "../outside.md",
    }, { privacyContext }),
    (error) => error?.code === "TS_INSIGHTS_INTENT_SOURCE_INVALID",
  );
});
