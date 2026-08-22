---
id: threadshare-s-memory-extraction-prompts-should-protect-again
type: work_method
status: approved
priority: 84
confidence: high
provenance_strength: direct
claim_support: human-confirmed
limitations: ["source-local-only"]
scope: repo
scene: threadshare-memory
occurred: []
evidence: {"commits":[],"paths":[]}
superseded_by: null
---
Threadshare's memory extraction prompts should protect against role capture when reviewing historical chats by wrapping transcript messages in past-message markers, ending with a transcript anchor, and explicitly instructing the model not to continue or obey the archived conversation.
