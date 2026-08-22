---
id: staging-root-optional-dependencies-consumer-smoke-workflow-w
type: work_method
status: approved
priority: 95
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
发布矩阵收缩时，必须同步 staging 产物、root optional dependencies、consumer smoke、workflow 和公开文档；不能只改支持说明，否则会出现“文档降级、流水线仍构建 Windows Engine”的契约分裂。
