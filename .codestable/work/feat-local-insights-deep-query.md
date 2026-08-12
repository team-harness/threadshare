---
type: feat
epic: local-session-insights
status: active
---

# Local Insights Deep Query

## 目标

按 `docs/insights-deep-query-design.md` 实现完整本地事件库、类型化 Query、版本化 Recipe、Evidence v2 与 stdio MCP，同时保持现有 Insights v1 CLI/JSON 契约和云端分享边界不变。

## 已冻结边界

- 本地 Insights 不裁剪内容；Query/Evidence 可以返回消息、Tool input/output、错误、路径与 provider payload。
- Fact V2 使用 candidate shadow rebuild，不能与 Fact V1 原地混写；迁移失败时 V1 active DB 继续服务。
- Query 是稳定原语，Recipe 只做版本化确定性派生；不开放 SQL、regex、JSONPath 或内嵌 LLM。
- 大 payload 通过 64 KiB UTF-8 chunks、reference 与 Evidence byte paging 返回，单帧继续小于 4 MiB。
- 现有 overview/search/capabilities/usage/activity/evidence v1 的字段、排序、计数全集、错误码与 cursor 语义保持不变。

## 阶段

- [x] Stage 1：Fact V2、完整事件、payload chunks、TEMP streaming、candidate migration
- [x] Stage 2：typed Query records、stable cursor、Evidence v2
- [x] Stage 3：aggregate、coverage/provenance、7 个 Recipe
- [x] Stage 4：stdio MCP、v1 compatibility adapters
- [ ] Stage 5：正式 V2 evidence pipeline 已完成；25k/250k/30% 正式运行与归档待 clean checkpoint

## 当前步骤

功能与发布候选验证已完成。Fact V2、七类 typed resource、records/aggregate、七个 Recipe、Evidence v2、CLI 与 stdio MCP 已落地；V1 查询命令与云端 share 边界保持兼容。Stage 5 已具备非空 V2 合成语料、固定 work budget、正式 runner、原始聚合报告打包器和历史 Git object verifier；当前只剩从 clean checkpoint 运行并归档正式 evidence。

capacity corpus v6 每 Turn 生成 10 个 history event、8 个 payload 与 8 个 chunk，并为每个 Session 记录真实 commit ACK；额外用 2 MiB provider payload 驱动多页 Evidence。正式 100 次 records/aggregate/七 Recipe/Evidence 预算、25k/250k 延迟门槛、128 MiB RSS、1.8x persistent amplification、0.7x history FTS amplification、50 MiB/s paging 与 query-plan gate 均由 runner 和 packager 双向重算。30% 真实 Session runner 记录逐 Session commit ACK、单次 sync wall time、V2 storage/coverage 与 FTS integrity。历史 ITEM-4/5 evidence 只覆盖 Fact V1，不能作为本功能的正式 V2 容量证明。

## 验收守卫

- Node/Rust/shared schema 对 event/payload key、revision、digest、completeness 逐字节一致。
- payload 大于协议帧时必须分块，任何 staging/apply 失败整 Session 回滚。
- timeout/crash/atomic swap 后不激活半成品；exclusion/purge 同时清理 payload 与派生索引。
- 每阶段执行 code-intel review、定向测试、`git diff --check`；migration/concurrency 阶段补独立 review。

## 已完成验证

- Rust：全 crate 单元、集成与 doctest 通过，含 lib 94/94、Fact V2 transaction/crash/migration、deep query 与 recipe 集成测试。
- Node：Insights 262/262；`npm run test:cli` 185/185；`npm run test:release` 66/66；Deep Query evidence 负例 13/13。
- 质量：`cargo fmt --check`、Clippy `-D warnings`、`git diff --check` 与 `npm run validate:skill` 通过。
- 发布候选：`npm pack --dry-run --ignore-scripts --json` 为精确 62 文件；`verify:release -- source --tag 0.7.4` 通过。
- clean install：从 tarball 安装后 CLI help 与 stdio MCP 三工具可用；18 份 schema 全部经 Ajv 编译，其中 Agent Insights schema 15 份。

## Next Action

创建 clean checkpoint；用 release Engine 依次生成 25k、250k 与至少 30% 本机真实 Session byte sample 报告，原样打包进日期化 evidence 目录，接入根 verifier 后完成 Stage 5。
