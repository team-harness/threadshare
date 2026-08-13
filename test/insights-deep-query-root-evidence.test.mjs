import assert from "node:assert/strict";
import test from "node:test";

import { verifyInsightsEvidence } from "../docs/benchmarks/local-session-insights/verify-evidence.mjs";

test("root Insights evidence verification includes the archived 25k Deep Query report", async () => {
  assert.deepEqual(await verifyInsightsEvidence(), {
    format: "threadshare-insights-evidence-verification@v1",
    item4Artifacts: 5,
    item5Artifacts: 6,
    item6Artifacts: 2,
    deepQueryArtifacts: 1,
  });
});
