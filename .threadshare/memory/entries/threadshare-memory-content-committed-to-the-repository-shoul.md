---
id: threadshare-memory-content-committed-to-the-repository-shoul
type: work_method
status: approved
priority: 84
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
Threadshare memory content committed to the repository should contain only sanitized memory text, opaque memory identifiers, and public evidence references; raw provider session or turn references stay in local private state, and lint or PR review is not treated as a privacy boundary because content has already entered Git history by then.
