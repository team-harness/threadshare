---
id: threadshare-team-memory-extraction-should-process-insights-h
type: work_method
status: approved
priority: 90
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
Threadshare team-memory extraction should process Insights history as complete Turn-bounded chunks with explicit coverage and related-input CAS, not with head-tail truncation or global snapshot CAS; stale checks should bind only the actual task inputs such as turn revisions, payload revisions, delivery-edge revisions, related-memory revisions, and prompt/schema/chunker versions.
