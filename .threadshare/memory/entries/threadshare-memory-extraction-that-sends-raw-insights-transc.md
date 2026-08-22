---
id: threadshare-memory-extraction-that-sends-raw-insights-transc
type: work_method
status: approved
priority: 80
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
Threadshare memory extraction that sends raw Insights transcripts to a model endpoint requires an explicit RunnerExecutionPlan and user authorization; MCP-triggered extraction may only create a pending plan, and runners must use ephemeral or no-session-persistence settings to avoid creating new indexable sessions from the extraction run itself.
