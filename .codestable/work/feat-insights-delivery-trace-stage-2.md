---
type: feat
status: complete
---

# Insights Delivery Trace Stage 2

## 目标

把 Stage 1 已提交到 Engine 的 Delivery Trace 图提升为 Agent 可发现、可分页、可追溯的稳定查询能力：

- `delivery-trace@1` versioned Recipe；
- revision-bound 的 Trace node / edge Evidence；
- 只按需读取已登记仓库 Git object 的 diff Evidence；
- 面向 Agent 的五类高价值问题与 continuation context。

## 现场

- Stage 0-1 已在当前 worktree 完成，尚未由本阶段改写或回退。
- Engine 已有 `READ_INSIGHTS_DELIVERY_TRACE`、Delivery Trace request/response schema、repo registration 与 TraceSource ingest。
- MCP 公开面固定为 `spec` / `query` / `recipe` / `evidence` 四个工具。

## 边界

- 不新增第五个 MCP tool；Recipe 与 Evidence 承担 Stage 2 能力。
- 不扫描全局仓库，只读取用户显式登记仓库内、投影已授权的 commit/path。
- Git diff 不写 active DB、不写 Git worktree、不访问网络；允许使用 `0600` 临时 spool 并确保清理。
- observed/candidate/contextual edge 不表述为 Agent authorship 或因果。
- 不实现 Dashboard（Stage 3）、Intent Projection、25k/250k 正式证据。

## 证据

- [x] `delivery-trace@1` public red -> green（CLI / MCP / installed package）。
- [x] Trace node / edge Evidence revision 与 cursor stale 反例。
- [x] Git diff byte oracle：root/merge parent、rename、binary、超限、missing object、分页 digest。
- [x] SCM link 裁剪：credential/query/fragment 不进入公开响应，SCM unavailable 不改变 evidence strength。
- [x] Agent spec 五类问题 golden，包含措辞约束与 continuation context。
- [x] 定向测试、全量回归、clippy/fmt、pack allowlist、code-deep review。

## 验收

1. Agent 只需自然语言提问，即可经 spec 选择 `delivery-trace@1`，无需用户记协议名。
2. Recipe 返回的节点和边可以用同一 revision 继续读取 Evidence；任何 snapshot/request/clock/frontier/database UUID 漂移均 fail-closed。
3. Git diff 只允许投影中已提交的 commit/path，分页合并结果与固定 Git oracle 字节一致。
4. 五类问题能形成带证据的回答计划，并明确 evidence strength、partial/truncated/unavailable/stale。
5. npm tarball 中四个 MCP 工具真实执行，新 schema 可解析且 allowlist 精确。

## 状态

Stage 2 第 6/6 步完成：功能、安装 smoke、全量回归与 code-deep 最终审查全部通过。

## 未决

- Stage 3 才实现 Dashboard `Insights Inspector`；Stage 2 不增加浏览器数据面。
