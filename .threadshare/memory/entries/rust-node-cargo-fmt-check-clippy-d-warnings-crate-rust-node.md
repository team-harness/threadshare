---
id: rust-node-cargo-fmt-check-clippy-d-warnings-crate-rust-node
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
跨层 Rust/Node 查询改动的收尾必须把 cargo fmt --check、Clippy -D warnings、全 crate Rust 测试，以及 Node query/protocol/client/reader 测试一起作为完成门禁；单元测试全绿但格式或 lint 未通过时不能宣称完成。
