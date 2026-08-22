---
id: the-team-memory-proposal-rev5-split-runner-retention-reporti
type: work_fact
status: approved
priority: 78
confidence: high
provenance_strength: direct
claim_support: human-confirmed
limitations: ["source-local-only"]
scope: repo
scene: team-memory-proposal
occurred: []
evidence: {"commits":[],"paths":[]}
superseded_by: null
---
The team-memory proposal rev5 split Runner retention reporting into localSessionPersistence and providerRetention: localSessionPersistence is set to none for the local Runner session, while providerRetention records unknown, no-retention, or provider-policy and is treated as an authorization input rather than a local technical guarantee.
