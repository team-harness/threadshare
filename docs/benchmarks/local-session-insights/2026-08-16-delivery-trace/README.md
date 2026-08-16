# Delivery Trace 25k acceptance evidence

This directory archives the aggregate-only Stage 4 acceptance evidence for Insights Delivery Trace.
The measured corpus contains 25,000 Turns, 250 Sessions, 5,000 Git commits, 20,000 changed-file
rows, and 100 Intent nodes. It exercises direct, observed, candidate, and contextual edges, plus
unresolved references and one unreachable commit.

## Result

| Path | P95 | P99 | Frozen gate |
|---|---:|---:|---:|
| Trace initial page | 4.30 ms | 4.49 ms | P95 < 200 ms; P99 < 500 ms |
| Depth expansion | 10.24 ms | 11.42 ms | P95 < 250 ms; P99 < 500 ms |
| Evidence first page | 34.06 ms | 35.39 ms | P95 < 100 ms |
| Local Git diff first page | 10.86 ms | 11.12 ms | P95 < 500 ms |

Incremental two-generation ingestion and a clean one-generation build produced the same graph
digest. Peak Engine RSS was 37,683,200 bytes and the largest response was 47,901 bytes. All three
frozen query-plan probes used bounded indexed access.

## Boundary

The evidence directory contains one aggregate report and one manifest. It contains no raw Session,
repository, Git diff, SQLite database, local path, or stable key. The report records a dirty source
worktree because Stage 4 evidence was generated before the implementation checkpoint; script and
design digests bind the exact measured worktree inputs.

The 250,000-Turn Delivery Trace capacity point is deliberately deferred to a later iteration. These
25k measurements do not claim or predict 250k latency, RSS, or storage behavior.

Re-run the root verifier with:

```bash
npm run verify:insights-evidence
```
