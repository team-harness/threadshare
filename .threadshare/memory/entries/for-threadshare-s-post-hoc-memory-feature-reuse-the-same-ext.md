---
id: for-threadshare-s-post-hoc-memory-feature-reuse-the-same-ext
type: work_method
status: approved
priority: 86
confidence: medium
provenance_strength: direct
claim_support: human-confirmed
limitations: ["source-local-only"]
scope: repo
scene: threadshare-memory
occurred: []
evidence: {"commits":[],"paths":[]}
superseded_by: null
---
For Threadshare's post-hoc memory feature, reuse the same extraction pipeline for both batch-imported history and any future real-time inputs; keep ingestion separate from memory algorithms so session import, extraction, deduplication, storage, and sharing follow one contract.
