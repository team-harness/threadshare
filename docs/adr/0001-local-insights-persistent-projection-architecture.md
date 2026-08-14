---
adr: "0001"
title: Local Insights uses persistent transactional projections
status: Accepted
date: 2026-08-14
applies-to: Local Insights ingestion, storage, query, recipes, and evidence
enforcement: runtime
stage: [design, review, check, runtime]
lint: null
---

# Context

Local Insights must answer Agent queries over complete Turns, Tool and Skill use, provider events, revisions, dedupe evidence, payloads, and full-text search. Real local state can exceed 10 GiB and includes Sessions too large to materialize in memory.

A scan-on-query design can be fast for narrow usage summaries, but it would repeatedly parse provider JSONL, make query latency proportional to raw history size, and weaken snapshot, revision, purge, and evidence semantics.

# Decision

Local Insights uses a persistent, local SQLite index with transactionally maintained projections and rollups.

- Provider files are read only by sync, reindex, and source discovery. Public query, recipe, evidence, status-summary, and Dashboard paths do not rescan raw provider files.
- A Session commit atomically updates normalized Facts, source state, search projection, aggregate rollups, retry projection, and the committed snapshot sequence.
- Large Sessions remain streaming and bounded: provider input is newline-framed, Engine protocol batches are bounded, and per-Session staging uses SQLite TEMP storage rather than an unbounded in-memory delta.
- Query consistency is identified by database identity, snapshot sequence, and any frozen evaluation clock required by time-dependent semantics. Evidence reads remain revision-checked.
- New frequently used aggregates should extend transactional projections or share a narrowed snapshot-bound query base. They must not introduce a second scan-on-query data plane.

# Consequences

- First use requires sync or reindex, but subsequent sync is incremental and queries are independent of raw corpus size except where the indexed result set itself grows.
- Projection changes need migration or shadow rebuild semantics, crash recovery tests, and incremental-versus-clean equivalence evidence.
- The database is derived state and may be rebuilt, while provider files remain the source of truth.
- Storage usage is intentionally higher than a narrow usage-only cache because the index preserves the evidence needed for Agent analysis.

# Rejected alternatives

- **Parse all provider JSONL for every command.** Rejected because it repeats work, scales with raw history size, and cannot provide stable snapshot or evidence semantics.
- **Keep only usage and cost summaries.** Rejected because it cannot answer solution recall, failure-chain, Tool-path, and revision-checked evidence questions.
- **Materialize each Session fully in memory before commit.** Rejected because large real Sessions exceed safe process memory and protocol frame budgets.
- **Maintain an independent fast cache outside the Engine transaction.** Rejected because cache freshness and purge visibility could diverge from the committed snapshot.
