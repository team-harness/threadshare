---
adr: "0003"
title: Insights Delivery Trace is a shared snapshot-bound evidence graph
status: Accepted
date: 2026-08-16
applies-to: Local Insights repository evidence, intent adapters, trace projections, recipes, evidence, and Dashboard
enforcement: test
stage: [design, review, check, runtime]
lint: null
---

# Context

Threadshare Insights can answer cross-session questions from a persistent local event index, but it does not yet connect product intent, Agent sessions, Tool calls, files, and Git commits into one inspectable delivery story. The current Dashboard can inspect a search result or Tool-path family, but it does not provide synchronized intent, activity, and delivery views.

Better Harness Inspector demonstrates a useful interaction and evidence model: Feature/Date navigation, Prompt/Activity/Commit lanes, session replay, related-object selection, and explicit limitations on every inferred relationship. Its primary runtime is a bounded workspace rescan followed by a self-contained HTML report. Copying that runtime would create a second scan-on-query data plane and would not preserve Insights snapshot, cursor, incremental sync, or Agent query contracts.

Delivery correlation is also epistemically risky. Time proximity, text similarity, or a shared path can provide context without proving that a Session authored a Commit. A durable design must make that distinction executable rather than relying on UI wording.

# Decision

Insights Delivery Trace uses a persistent, versioned evidence graph shared by Agent queries and the local Dashboard.

- Trace nodes represent versioned intent, repository, Session, Turn, capability use, file, and Git commit identities. Trace edges carry a typed relation plus `strength`, `source`, typed `facts`, stable `limitations`, and `revision`.
- The Dashboard and Agent Recipe surfaces consume the same Engine-owned graph contract. Browser code must not independently infer Session-to-Commit, Story-to-Session, or File-to-Commit relationships.
- Repository and intent evidence are independent read-only sync sources. Only explicitly registered repositories are scanned; ordinary sync updates their changed refs incrementally and never discovers repositories by walking global directories or historical Session cwd values.
- Query, Recipe, and initial Dashboard reads use only committed SQLite facts. An explicit Git-diff Evidence request is the sole exception: it may read one selected immutable commit object through a bounded, revision-checked, read-only source adapter. Sync does not precompute every full diff.
- Explicit declarations and observed commit operations may create direct edges. Exact path overlap and bounded event ordering may create observed edges. Text, date, or contextual overlap remains candidate or contextual evidence and must not be presented as authorship.
- Candidate and contextual edges are excluded from Agent conclusions by default. A request may include them only with their facts and limitations intact.
- Intent structure is optional and adapter-owned. A Markdown Feature Tree may be supported as one `IntentSourceV1` adapter, but Threadshare does not require Better Harness, a particular planning tool, or a network issue tracker.
- A sanitized, explicitly selected GitHub or GitLab web remote may produce external commit/diff links. Threadshare does not fetch, authenticate, or verify those URLs; link availability is not evidence that a commit was pushed.
- Local Trace queries retain full local Insights fidelity and hydrate large payloads only through bounded Evidence reads. Any future portable HTML or shared export is a separate explicit contract and must not become the canonical runtime.
- Trace reads are bounded and snapshot-bound. Cursors bind database UUID, snapshot sequence, canonical request, evaluation clock, and continuation frontier. Reindex, repository replacement, or request drift makes old cursors stale.
- Trace projections follow the existing evidence-gated performance policy: deterministic fixtures, incremental-versus-clean equivalence, query-plan assertions, formal 25k evidence, and bounded RSS. The 250k corpus remains a deferred periodic capacity check.

# Consequences

- Threadshare gains a human delivery workbench without creating a second truth model beside Agent Query and Recipe.
- Sync and reindex acquire repository and optional intent source lifecycles, including source-change retry, crash recovery, purge visibility, and schema migration work.
- Repository registration must preserve a stable local identity, ref watermarks, scan budgets, and an optional credential-free SCM web mapping.
- Git history mutation must be modeled. Commit hashes remain immutable evidence; reachability is an observed state that may change after rebase or amend.
- A useful first version requires new storage and projection identities, protocol schemas, installed-package tests, Dashboard assets, and 25k performance evidence. It is not only a frontend feature.
- Correlation may remain incomplete. Coverage and unresolved references are first-class response fields; the implementation must prefer unknown over an unsupported causal claim.
- The user-facing Dashboard surface is named `Insights Inspector`; its existing side inspector becomes a detail drawer within that workbench. The Engine and protocol retain the `Delivery Trace` name.

# Rejected alternatives

- **Copy Better Harness' self-contained report as the primary implementation.** Rejected because every open would rescan bounded local state, duplicate normalization, and lose committed snapshot semantics.
- **Discover and scan every Git repository under the user's home or historical cwd values.** Rejected because cost and side effects grow with unrelated local work instead of the registered Trace scope.
- **Precompute or persist every full commit diff during sync.** Rejected because most diffs are never inspected and large repositories would pay avoidable CPU, I/O, and storage costs.
- **Fetch GitHub or GitLab during Trace queries.** Rejected because private authentication, network availability, rate limits, and remote mutation would weaken local deterministic evidence. External URLs remain user-initiated navigation only.
- **Join Sessions, files, and commits in browser JavaScript.** Rejected because Agent and Dashboard answers would drift and the relationship rules would evade transactional tests.
- **Treat time, shared paths, or text similarity as authorship.** Rejected because these signals are correlational and produce ordinary false positives during parallel work, rebases, and reused files.
- **Make Feature Tree mandatory.** Rejected because Date and Session trace remain valuable without declared intent, and Threadshare must stay independent of a planning product.
- **Add one CLI command for every delivery question.** Rejected because it recreates a wide, shallow API. A typed Trace resource and versioned Recipe support both stable common questions and composition.
- **Store only a rendered report.** Rejected because it cannot support Agent queries, revision-checked evidence, incremental updates, or alternative local views.
