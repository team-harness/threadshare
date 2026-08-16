---
type: feat
status: complete
---

# Insights Delivery Trace Stage 4

## 目标

完成 Delivery Trace 的最后阶段：Markdown `IntentSourceV1`、Intent 关系投影、Dashboard Intent 模式、正式 25k evidence、用户文档与参考报告。

## 现场

- Stage 0-3 已在当前工作树完成，尚未提交或发布。
- `docs/insights-delivery-trace-design.md` 与 ADR-0003 是冻结设计。
- 25k 是本阶段正式门槛；250k 按 owner 决策延期到后续迭代，不得用 25k 外推。

## 边界

- Intent 是可选、仓库内显式配置的 Markdown checklist source；不扫描全局目录，不联网补全 issue。
- Engine 独占 node/edge 分类；Node、Dashboard 和 Agent 不推断 Intent-to-Session/Commit 关系。
- malformed 行产生 line-local diagnostic 并保留可用树；重复显式 ID fail-closed。
- 正式 evidence 只归档 aggregate/digest，禁止本机路径、Session 内容、Git repository 或 SQLite 数据。
- 不实现 self-contained HTML export，不改变 Windows core-only 发布矩阵。

## 证据

- [x] Adapter malformed/partial/duplicate-ID red -> green。
- [x] Intent staging、持久化、direct/candidate edge 与 clean/incremental equivalence 通过。
- [x] Agent Recipe/Evidence 与 Dashboard Intent 模式只消费 committed Trace response。
- [x] 25k correctness、latency、RSS、query-plan、response-bound、incremental-equivalence gate 非空通过。
- [x] 250k 在 artifact、README 与 verifier 中明确 deferred/not measured。
- [x] installed smoke、全量回归、隐私校验与 code-deep review 通过。

## 验收

1. 仓库可显式注册一个 Markdown intent source，普通 sync/reindex 增量更新且不触碰未注册文件。
2. direct edge 只来自可验证 Session/Commit ref；candidate 保持独立并默认不进入 Agent 结论。
3. partial source 不伪装完整覆盖，重复显式 ID 不提交半个 graph。
4. Dashboard Intent 模式可浏览真实 Intent node 与关联 evidence；无 Intent 时给出准确配置指引。
5. 25k aggregate evidence 可由 root verifier 独立复核，且不含私有内容。

## 状态

Stage 4 第 6/6 步：功能、25k 正式证据、文档、真实本机查询、全量回归与终审全部闭合。

## 实现记录

- Markdown Intent adapter 只读取显式登记的仓库相对文件；line-local malformed 诊断保留可用树，重复显式 ID fail-closed。
- 普通 `sync` 与 `reindex` 同步已登记的 Git/Intent source，Delivery Graph 由 Engine 单独分类 direct、observed、candidate 与 contextual edge。
- Agent 可从当前 checkout 解析已登记仓库，无需用户提供 opaque repository key；Git diff hydration 仍要求 committed commit/path 与 revision 授权。
- Dashboard Intent 模式、Detail Drawer、按需 Evidence/Git diff 与 continuation context 只消费 committed Trace response。
- 25k 正式语料包含 25,000 Turns、5,000 commits、20,000 changed-file rows 与 100 intents；四条路径 P95 为 4.30、10.24、34.06、10.86 ms，peak RSS 37,683,200 bytes，incremental/clean digest 相等。
- 真实本机索引完成仓库与 Intent sync，并从公开 commit 下钻 9 条 direct changed-file edge；单文件 Git diff 为完整 2,294 bytes。参考报告不保留本机路径、Session 内容或 opaque key。
- 最终 `npm run test:insights-engine` 通过 Rust 全套、Clippy `-D warnings`、Node 305/305 与 root evidence verifier；CLI 203/203、release 72/72、Viewer 7/7、API 32/32、FC 19/19、Cloudflare build、Skill validation 与 73-file npm pack 均通过。
- Dashboard 在真实索引上完成 1440x900 与 390x844 浏览器验收：仓库、commit、direct changed-file edge、Detail Drawer、SCM commit/diff 控件可用，移动端页面无横向溢出。
- code-deep 终审对 Deep Query 字段映射、Fact 事务与 Delivery Trace 协议分发做了定向调用链复核；高风险信号来自大 diff 与符号映射遗漏，未确认新的可复现缺陷。

## 未决

- 无；250k 已明确延期，不阻塞本阶段。
