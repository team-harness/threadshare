---
id: threadshare-team-memory-extraction-uses-a-two-stage-pipeline
type: work_method
status: approved
priority: 88
confidence: high
provenance_strength: direct
claim_support: human-confirmed
limitations: ["source-local-only"]
scope: repo
scene: team-memory-design
occurred: []
evidence: {"commits":[],"paths":[]}
superseded_by: null
---
Threadshare team-memory extraction uses a two-stage pipeline: a restricted runner produces CandidateDraftBatch output from an ExtractionTask, Threadshare performs BM25 recall for related memories locally, and a separate AdjudicationTask produces the deduplication or merge decision before transactional quarantine.
