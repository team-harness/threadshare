---
id: for-threadshare-team-memory-quarantined-candidates-raw-evide
type: work_method
status: approved
priority: 86
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
For Threadshare team memory, quarantined candidates, raw evidence references, submissions, and chunk state should live inside a memory-state SQLite database so extraction submission and cursor advancement can be transactional and idempotent; promotion to Git is a separate recoverable journaled workflow.
