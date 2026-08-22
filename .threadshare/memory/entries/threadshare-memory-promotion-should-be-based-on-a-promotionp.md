---
id: threadshare-memory-promotion-should-be-based-on-a-promotionp
type: work_method
status: approved
priority: 82
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
Threadshare memory promotion should be based on a PromotionPlan that binds target file blob hashes, sanitized content digests, and sanitization policy versions; any drift between review and promote must void the approval and require a regenerated diff, and Phase 1 promotion should modify only the working tree.
