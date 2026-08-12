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
- [ ] Stage 5：正式 V2 evidence pipeline 已完成；当前迭代 25k/30% 正式运行与归档待 clean checkpoint，250k 延期

## 当前步骤

功能与发布候选验证已完成。Fact V2、七类 typed resource、records/aggregate、七个 Recipe、Evidence v2、CLI 与 stdio MCP 已落地；V1 查询命令与云端 share 边界保持兼容。Stage 5 已具备非空 V2 合成语料、固定 work budget、正式 runner、原始聚合报告打包器和历史 Git object verifier；当前只剩从 clean checkpoint 运行并归档正式 evidence。

25k 性能探针促成 `deep-query-coverage@3`：event kind、逐日 completeness、Activity、token、coverage、capability context 与共现都在 Session 事实事务内生成精确 rollup。records/aggregate 读取 coverage projection；Capability/Token/Activity Recipe 仅在完整 UTC day 与可证明排序等价时走 rollup，否则回退 exact typed SQL。Activity 的 recipe coverage 同样按完整 UTC day 汇总，不再为每次请求扫描窗口内全部事件。Activity rollup 的 nullable provider terminal 使用显式 `COALESCE(SUM(...),0)`；Rust 回归和 Node real-sidecar 样本均覆盖 open Turn，不再把合法 NULL 聚合成 SQLite NOT NULL 失败。

capacity corpus v7 每 Turn 生成 10 个 history event、8 个 payload 与 8 个 chunk，并为每个 Session 记录真实 commit ACK；额外用 2 MiB provider payload 驱动多页 Evidence，并用唯一 `solutionrecallprobe` 标记验证全局 Solution Recall。正式 100 次 records/aggregate/七 Recipe/Evidence 预算、25k 延迟门槛、每个 Recipe P95 <500 ms/P99 <1,000 ms、128 MiB RSS、1.8x persistent amplification、0.7x history FTS amplification、50 MiB/s paging 与 query-plan gate 均由 runner 和 packager 双向重算。30% 真实 Session runner 记录逐 Session commit ACK、单次 sync wall time、V2 storage/coverage 与 FTS integrity。250k 长期规模档按 owner 决策延期到后续迭代，manifest 必须显式记录 `deferredSyntheticTurns:[250000]`，不得把 25k 外推为 250k 已测。历史 ITEM-4/5 evidence 只覆盖 Fact V1，不能作为本功能的正式 V2 容量证明。

首次 clean 25k 正式运行暴露 `solution-recall@1` 单请求约 20 秒：旧 SQL 对每个候选事件重复执行全局 FTS MATCH，且 coverage 即使零命中仍扫描整个 HistoryEvent 窗口。该运行已主动终止，未生成或归档报告。修复后，session-scoped 查询以 scope rowid 约束 FTS，全局查询从 FTS match 起步；结果与 coverage 复用同一匹配 CTE，coverage 现在统计匹配全集而非整段历史。保留 25k 数据库上的 release 探针结果为：全局零 DF P95 1.08 ms（修复前约 2.38 秒），session-scoped 700 条宽匹配 P95 94.37 ms；执行计划测试分别锁定 `INDEX 0:M1` 与 `INDEX 0:=M1`。

第二次 clean 25k 正式运行暴露 `capability-contexts@1` 的详情富化仍对全部 capability 的代表 Turn 和共现投影做宽行外部排序：运行约 26 分钟时 Engine RSS 已达 318 MiB，调用栈停在 `projected_capability_representatives` 的 SQLite sorter。该运行同样主动终止，未生成或归档报告。修复后先用小型 capability rollup 确定最终前 `limit` 项，再仅为这些项聚合、排名和读取前 5 个代表 Turn/共现项；两张详情索引改为 capability-first，并在升级时删除旧 day-first 索引。保留 25k 数据库上的 release 实测为：120 次真实协议请求 P50 138.34 ms、P95 152.21 ms、P99 183.31 ms、max 303.37 ms，采样 Engine 峰值 30,288 KiB（修复前约 318 MiB）。执行计划测试锁定两张 capability-first 索引并拒绝详情投影表扫描，现有投影/精确事件路径差分测试保持全字段相等。

第三次 clean 25k 正式运行完整产出报告，但 `activity-shifts@1` 的 P95/P99 为 3,880.61/4,076.42 ms，未通过 500/1,000 ms Recipe gate，因此报告未归档。其余六个 Recipe、records、aggregate、Evidence、RSS 与存储门槛均通过（sidecar peak 50.48 MiB、persistent amplification 1.1491x、History FTS amplification 0.5717x、Evidence 51.04 MiB/s）。采样确认 Activity 本体已使用日级 rollup，剩余成本来自 `read_recipe` 每次仍扫描窗口内 250,001 条 `history_event_coverage`。`deep-query-coverage@3` 新增逐 UTC day completeness rollup，Activity 完整日窗口按 Session 可见性与 purge 状态精确汇总；非完整日路径继续扫描 typed event，旧 projection identity fail-closed 要求 shadow rebuild。投影/精确 coverage 差分、degraded fail-closed、旧 `@2` identity 拒绝与 bounded query plan 均有回归测试。

第四次 clean 25k 正式运行验证 Activity rollup 修复：`activity-shifts@1` P95 从 3,880.61 ms 降至 5.74 ms，但主机起始 load average 11.33 下 Evidence paging 为 48.43 MiB/s，低于固定 50 MiB/s 门槛，因此报告未归档。第五次同一 clean candidate 重跑全绿：Activity P95 6.70 ms、Evidence 51.03 MiB/s、sidecar peak 52.34 MiB、persistent amplification 1.1492x、History FTS amplification 0.5717x。随后启动的 250k 运行在约 44 分钟时按 owner 决策终止并延期，未生成或归档报告。

## 验收守卫

- Node/Rust/shared schema 对 event/payload key、revision、digest、completeness 逐字节一致。
- payload 大于协议帧时必须分块，任何 staging/apply 失败整 Session 回滚。
- timeout/crash/atomic swap 后不激活半成品；exclusion/purge 同时清理 payload 与派生索引。
- 每阶段执行 code-intel review、定向测试、`git diff --check`；migration/concurrency 阶段补独立 review。

## 已完成验证

- Rust：全 crate 单元、集成与 doctest 通过，含 lib 99/99、Fact V2 transaction/crash/migration、deep query 与 recipe 集成测试。
- Node：Insights 263/263；Deep Query 定向 82/82；`npm run test:cli` 185/185；`npm run test:release` 66/66；Deep Query evidence 负例 14/14。
- 质量：`cargo fmt --check`、Clippy `-D warnings`、`git diff --check` 与 `npm run validate:skill` 通过。
- 发布候选：`npm pack --dry-run --ignore-scripts --json` 为精确 62 文件；`verify:release -- source --tag 0.7.4` 通过。
- clean install：从 tarball 安装后 CLI help 与 stdio MCP 三工具可用；18 份 schema 全部经 Ajv 编译，其中 Agent Insights schema 15 份。

## Next Action

提交“25k 当前验收、250k 显式延期”的 evidence 契约 checkpoint；用该提交的 release Engine 重新生成 25k 与至少 30% 本机真实 Session byte sample 报告，原样打包进日期化 evidence 目录，接入根 verifier 后完成 Stage 5。
