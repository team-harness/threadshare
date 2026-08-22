---
id: wire-rust-serde-usageorderby-lastusedat-last-used-ready-disp
type: work_method
status: approved
priority: 95
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
对外协议字段必须以 wire 值显式绑定 Rust serde（例如 UsageOrderBy::LastUsedAt 显式映射为 last-used），并用反序列化、旧别名拒绝、真实 READY dispatch 三层测试，避免合法请求在 expect 处 panic。
