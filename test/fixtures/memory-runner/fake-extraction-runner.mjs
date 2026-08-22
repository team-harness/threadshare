#!/usr/bin/env node
// Fake restricted extraction runner used by the memory-command E2E tests.
//
// It plays three roles from a single binary (so one conformance record binds
// the exact bytes that later run the tasks):
//   - `--version`: prints a stable version line and exits 0.
//   - deny-all conformance probe (non-JSON stdin): reports refusals and touches
//     nothing on the filesystem or network.
//   - ExtractionTask@v1 / AdjudicationTask@v1 / ConsolidationTask@v1 JSON stdin:
//     emits the matching contract while echoing taskId + binding.
//
// When FAKE_RUNNER_MARKER is set for a contract task, it writes a marker file
// so a test can distinguish content delivery from a deny-all probe.
import { writeFileSync } from "node:fs";
import process from "node:process";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-runner 1.0.0 (extraction)\n");
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString("utf8");

let task = null;
try {
  task = JSON.parse(input);
} catch {
  task = null;
}

if (process.env.FAKE_RUNNER_MARKER && typeof task?.format === "string") {
  writeFileSync(process.env.FAKE_RUNNER_MARKER, "executed\n");
}

function refusalReport() {
  return {
    report: [
      "action 1: refused (no shell access is available to me)",
      "action 2: refused (I cannot write files)",
      "action 3: refused (I cannot read files outside my stdin input)",
      "action 4: refused (no MCP tools are configured)",
      "action 5: refused (I cannot make network requests beyond this model call)",
      "action 6: not printed (I executed none of the actions)",
    ],
  };
}

let output;
if (task === null || typeof task !== "object") {
  output = refusalReport();
} else if (task.format === "threadshare-memory-extraction-task@v1") {
  const candidateContent = input.includes("THREADSHARE_TEST_SLUG_TRUNCATION")
    ? `${"a".repeat(59)} next`
    : "Release tests are grouped under npm run test release.";
  const turnEvidence = task.evidenceCatalog?.find((entry) =>
    entry.kind === "turn" && entry.display === "turn 0") ??
    task.evidenceCatalog?.find((entry) => entry.kind === "turn");
  const evidenceId = turnEvidence?.evidenceId;
  output = {
    format: "threadshare-memory-candidate-draft-batch@v1",
    taskId: task.taskId,
    binding: task.binding,
    candidates: [
      {
        content: candidateContent,
        type: "work_method",
        priority: 60,
        confidence: "high",
        scene: null,
        statements: [
          {
            statementId: "s-1",
            text: candidateContent,
            evidenceIds: evidenceId ? [evidenceId] : [],
          },
        ],
      },
    ],
  };
} else if (task.format === "threadshare-memory-adjudication-task@v1") {
  const retainedByContent = new Map();
  output = {
    format: "threadshare-memory-adjudication-result@v1",
    taskId: process.env.THREADSHARE_TEST_WRONG_ADJUDICATION_BINDING
      ? `${task.taskId}-other`
      : task.taskId,
    binding: task.binding,
    adjudications: (task.drafts ?? []).map((draft) => {
      const contentKey = draft.content.trim().toLowerCase();
      const retainedId = retainedByContent.get(contentKey);
      if (retainedId !== undefined) {
        return {
          draftRef: draft.candidateId,
          action: "skip",
          targetIds: [retainedId],
          mergedFields: null,
        };
      }
      retainedByContent.set(contentKey, draft.candidateId);
      return {
        draftRef: draft.candidateId,
        action: "store",
        targetIds: [],
        mergedFields: null,
      };
    }),
  };
} else if (task.format === "threadshare-memory-consolidation-task@v1") {
  const entryId = task.entries?.[0]?.entryId;
  const forceNoOp = task.entries?.some((entry) =>
    entry.body?.includes("THREADSHARE_TEST_EMPTY_PATCH"));
  const forceOversizedScene = task.entries?.some((entry) =>
    entry.body?.includes("THREADSHARE_TEST_OVERSIZED_SCENE"));
  output = {
    format: "threadshare-memory-consolidation-patch@v1",
    taskId: task.taskId,
    binding: task.binding,
    operations: entryId && !forceNoOp ? [{
      operationId: "consolidate-release-workflow",
      op: task.scenes?.some((scene) => scene.name === "release-workflow") ? "update" : "create",
      target: "scene",
      name: "release-workflow",
      newContent: [
        "-----META-START-----",
        "created: 2026-08-21",
        "updated: 2026-08-21",
        "summary: \"Release workflow\"",
        "-----META-END-----",
        "## Release workflow",
        forceOversizedScene
          ? `Run ${"x".repeat(1600)}`
          : "Run the release verification suite before publishing.",
      ].join("\n"),
      basedOnEntryIds: [entryId],
      mergeSources: [],
      rationale: "Keep the approved release workflow reusable across future sessions.",
    }] : [],
  };
} else {
  output = refusalReport();
}

process.stdout.write(`${JSON.stringify(output)}\n`);
