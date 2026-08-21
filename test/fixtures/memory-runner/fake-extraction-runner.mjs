#!/usr/bin/env node
// Fake restricted extraction runner used by the memory-command E2E tests.
//
// It plays three roles from a single binary (so one conformance record binds
// the exact bytes that later run the tasks):
//   - `--version`: prints a stable version line and exits 0.
//   - deny-all conformance probe (non-JSON stdin): reports refusals and touches
//     nothing on the filesystem or network.
//   - ExtractionTask@v1 / AdjudicationTask@v1 JSON stdin: emits the matching
//     CandidateDraftBatch@v1 / AdjudicationResult@v1, echoing taskId + binding.
//
// When FAKE_RUNNER_MARKER is set and this is not a `--version` probe, it writes
// a marker file so a test can prove whether the process actually ran.
import { writeFileSync } from "node:fs";
import process from "node:process";

if (process.argv.includes("--version")) {
  process.stdout.write("fake-runner 1.0.0 (extraction)\n");
  process.exit(0);
}

const chunks = [];
for await (const chunk of process.stdin) chunks.push(chunk);
const input = Buffer.concat(chunks).toString("utf8");

if (process.env.FAKE_RUNNER_MARKER) {
  writeFileSync(process.env.FAKE_RUNNER_MARKER, "executed\n");
}

let task = null;
try {
  task = JSON.parse(input);
} catch {
  task = null;
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
        content: "Release tests are grouped under npm run test release.",
        type: "work_method",
        priority: 60,
        confidence: "high",
        scene: null,
        statements: [
          {
            statementId: "s-1",
            text: "Release tests are grouped under npm run test release.",
            evidenceIds: evidenceId ? [evidenceId] : [],
          },
        ],
      },
    ],
  };
} else if (task.format === "threadshare-memory-adjudication-task@v1") {
  output = {
    format: "threadshare-memory-adjudication-result@v1",
    taskId: task.taskId,
    binding: task.binding,
    adjudications: (task.drafts ?? []).map((draft) => ({
      draftRef: draft.candidateId,
      action: "store",
      targetIds: [],
      mergedFields: null,
    })),
  };
} else {
  output = refusalReport();
}

process.stdout.write(`${JSON.stringify(output)}\n`);
