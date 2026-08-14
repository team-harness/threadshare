---
adr: "0002"
title: Insights performance changes are evidence-gated and bounded
status: Accepted
date: 2026-08-14
applies-to: Local Insights discovery, parsing, indexing, projections, queries, and benchmarks
enforcement: test
stage: [design, review, check, runtime]
lint: null
---

# Context

Insights performance spans source discovery, provider parsing, Fact construction, Engine protocol transfer, SQLite commit and projection work, and snapshot-bound queries. Optimizing the wrong phase can add format coupling or memory risk without improving end-to-end latency.

The `ccusage` implementation demonstrates useful techniques such as size-aware scheduling, conservative byte filtering, typed decoding, and shared report bases. Its narrower usage-only model does not justify copying whole-file reads, scan-on-query behavior, or permissive malformed-record handling into Insights.

# Decision

Performance work proceeds as independently reviewable stages with a measured trigger, a bounded implementation, and a rollback condition.

1. Use metadata-only, largest-source-first scheduling to reduce backfill tail latency without pre-reading content or changing commit semantics.
2. Add a provider byte prefilter or typed partial decoder only when a current raw-backfill profile shows provider adaptation is the largest attributable phase and CPU or allocation evidence identifies JSON decoding or dynamic object construction as the dominant adapter cost.
3. Optimize repeated Agent analysis through snapshot-bound shared keysets, transactional rollups, or exact caches keyed by database identity, snapshot sequence, and canonical request digest. Never return stale data as an exact CLI or Agent result.
4. Validate changes with three layers: a committed 1k-5k Turn fast fixture, the formal 25k corpus, and an opt-in local real-shaped run. The 250k corpus is a periodic long-term capacity check, not a normal PR or CI requirement.
5. Preserve streaming input, bounded protocol batches, bounded TEMP staging, deterministic stable keys and digests, fail-closed malformed input, and capped concurrency at every stage.

Every performance change must record the compared corpus, phase measurements, wall time, peak RSS where relevant, correctness gates, and the condition under which the change should be reverted. A faster total without phase attribution is insufficient evidence for a parser or schema optimization.

# Consequences

- Some plausible optimizations will be deliberately deferred when the measured bottleneck is elsewhere.
- Benchmarks must separate provider adapter time from Engine commit and query time instead of reporting only one wall-clock number.
- Fast fixtures protect mechanics and query plans; formal evidence protects milestone claims; large local runs remain opt-in so CI stays bounded.
- Adding a projection or cache carries correctness work: snapshot invalidation, purge visibility, incremental-versus-clean equivalence, and package-contract tests.

# Rejected alternatives

- **Adopt every optimization used by a faster adjacent tool.** Rejected because data models and correctness contracts differ.
- **Read complete Session files into memory for throughput.** Rejected because real Sessions are large and memory bounds are a product requirement.
- **Silently skip records that a fast decoder cannot classify.** Rejected because unknown or malformed records may affect coverage, checkpoints, payloads, or future adapters.
- **Increase concurrency at every layer.** Rejected because nested parallelism can amplify disk contention and peak RSS while worsening tail latency.
- **Run 250k generation in normal CI.** Rejected because it slows iteration without replacing the smaller deterministic and 25k gates.
