---
id: insights-engine-ingestion-session-facts-session-facts-sqlite
type: work_method
status: approved
priority: 95
confidence: medium
provenance_strength: direct
claim_support: human-confirmed
limitations: ["source-local-only"]
scope: repo
scene: insights-ingestion
occurred: []
evidence: {"commits":[],"paths":[]}
superseded_by: null
---
Insights Engine 的 ingestion 大小限制应约束单批内存窗口，而不是限制整个 session 的 Facts 总量。大型 session 应把 Facts 暂存到同一 SQLite 连接，在 COMMIT_SESSION 中完成校验、替换和 Projection 更新，并在 ABORT、协议错误或断连时清理 staging。同时，projection 的 forced Turn membership 必须通过可失败的查询回调直接访问 TEMP 表，不能把最多 1,000,000 个 retraction key 全载入内存；不得用排除 session、提高内存上限或裁剪 Facts 代替根因修复。
