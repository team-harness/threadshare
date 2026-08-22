---
id: dogfood-apple-developer-macos-gatekeeper-developer-id-proven
type: work_fact
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
本机编译和 dogfood 不需要 Apple Developer 账号；面向其他 macOS 用户发布无 Gatekeeper 阻拦的稳定包，则需要 Developer ID 签名与公证。不能用本机预构建产物替代发布流水线的签名、公证、可复现构建和 provenance。
