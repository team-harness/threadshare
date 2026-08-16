# Delivery Trace with an Agent: a real repository example

This report shows how a user can ask an Agent about delivery history without learning Threadshare's
query schemas or internal identifiers. The Agent selected the bounded Insights operations, checked
coverage, and hydrated one Git diff only after it had verified the commit and path in the committed
trace.

The example uses Threadshare's own local index. It includes a public commit and repository-relative
paths, but no Session text, local filesystem paths, private keys, or opaque Insights identifiers.

## Question 1: what is planned, and what has verifiable delivery evidence?

> Review the current repository plan. Which items are complete, and which items still lack a
> verifiable Session or commit link?

The Agent resolved the repository containing its current working directory and read the registered
Markdown intent source. The source contained six acceptance items and had complete parse coverage.
At the time of the first read, all six were still marked open in the source document.

The trace contained no direct Intent-to-Session or Intent-to-Commit edge. Four candidate edges were
excluded from the answer, as required by the default evidence policy. The useful conclusion was not
that no implementation existed; it was that the plan did not yet contain an explicit, verifiable
reference connecting its checklist items to delivery evidence.

**Development decision:** finish the checklist from verified test results, and add explicit Session
or commit references when requirement-level traceability is important. Do not promote filename,
time proximity, or candidate similarity into authorship evidence.

## Question 2: what changed in the latest indexed delivery?

> Show the latest indexed commit for this repository, the files it changed, and the strongest
> evidence connecting them.

The Agent found the public commit
[`3f9edb2`](https://github.com/team-harness/threadshare/commit/3f9edb28e6a22506571c9ccf1832069af549e376),
`perf(insights): optimize indexing and recipe scans`. It was reachable from an indexed repository
ref and had nine `commit-changed-file` edges derived directly from the Git tree diff.

The changed paths covered the indexing implementation and tests, the recipe implementation,
performance ADRs and documentation, plus package metadata. This combination supported a precise
answer: the commit was a performance-oriented implementation change with corresponding tests and
architecture records. It did not prove which Agent Session authored the commit because no direct
Session-to-Commit evidence was present.

**Development decision:** treat the commit/file relationship as direct Git evidence, while keeping
the missing Session link visible during review or handoff.

## Question 3: what did the implementation actually change?

> For the indexing change, inspect only the relevant source diff and explain the operational effect.

After verifying the commit, parent, path, and revision against the committed trace, the Agent
requested Git evidence only for `src/insights-indexer.mjs`. The response was a complete 2,294-byte
text diff with `local-git-object` provenance.

The diff introduced a size-aware comparator and changed actionable indexing work from newest-first
to largest-first, while retaining newest-first as the deterministic tie-break. It also centralized
the byte accounting helper used by progress reporting. The practical effect is to start expensive
Sessions earlier so the fixed worker pool has a shorter tail, without loading file contents merely
to schedule work.

**Development decision:** evaluate the change through indexing tail latency and memory bounds, not
only total throughput. The diff explains the mechanism; benchmark evidence is still required to
claim a performance improvement.

## Evidence boundary

| Signal | What the Agent may say | What it must not say |
|---|---|---|
| Registered intent source parsed completely | The recorded checklist and its current statuses are available | Every checklist item was implemented |
| Reachable commit plus Git tree diff | The commit changed these exact paths | A particular Session authored the commit |
| Direct `commit-changed-file` edge | The file relationship is verified by Git | The changed lines satisfy a requirement |
| Excluded candidate edges | Possible relationships exist but were not used | Candidate similarity is delivery evidence |
| Revision-bound Git diff | The displayed bytes match the authorized local Git object | The diff is still current after its revision changes |

The Agent should include snapshot, coverage, truncation, evidence strength, and limitations in its
answer. Users ask the delivery question; `threadshare insights spec --format json` tells the Agent
which bounded Recipe and Evidence requests to use.
