---
id: insights-coverage-scope-all-indexed-history
type: work_fact
status: approved
priority: 90
confidence: high
provenance_strength: direct
claim_support: human-confirmed
limitations: ["source-local-only"]
scope: repo
scene: insights-query
occurred: []
evidence: {"commits":[],"paths":[]}
superseded_by: null
---
对外 Insights 响应的 coverage 要明确标注 scope: all-indexed-history，避免把全历史排除量误解成当前查询窗口的数据。
