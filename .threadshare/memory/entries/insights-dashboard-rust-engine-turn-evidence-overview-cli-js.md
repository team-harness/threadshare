---
id: insights-dashboard-rust-engine-turn-evidence-overview-cli-js
type: work_method
status: approved
priority: 90
confidence: high
provenance_strength: direct
claim_support: human-confirmed
limitations: ["source-local-only"]
scope: repo
scene: insights-agent
occurred: []
evidence: {"commits":[],"paths":[]}
superseded_by: null
---
Insights 不应只服务 Dashboard。Rust Engine 已有结构化搜索、Turn evidence 分页和 overview 能力，产品应通过稳定的 CLI/JSON（并保持 MCP 对等）向 Agent 暴露这些查询；Dashboard 只是人类视图，不应成为 Agent 接口。
