---
id: smoke-canonical-hash-deltaid-fixture
type: work_method
status: approved
priority: 90
confidence: high
provenance_strength: direct
claim_support: human-confirmed
limitations: ["source-local-only"]
scope: repo
scene: release-readiness
occurred: []
evidence: {"commits":[],"paths":[]}
superseded_by: null
---
已安装包 smoke 必须从已安装包自身的 canonical/hash 实现生成 deltaId，不能复用仓库 fixture 的静态摘要；这样才能验证发布包自身的真实契约。
