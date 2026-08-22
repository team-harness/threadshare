---
id: threadshare-phase-2-scene-and-doctrine-validators-should-spe
type: work_method
status: approved
priority: 76
confidence: high
provenance_strength: direct
claim_support: human-confirmed
limitations: ["source-local-only"]
scope: repo
scene: team-memory-phase2
occurred: []
evidence: {"commits":[],"paths":[]}
superseded_by: null
---
Threadshare Phase 2 scene and doctrine validators should specify Unicode scalar value counting consistently across Node and Rust, with golden vectors covering CJK text, emoji, combining characters, CRLF, and boundary lengths, because Node already treats character budgets as Unicode code points.
