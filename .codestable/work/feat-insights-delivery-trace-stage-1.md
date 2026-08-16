---
type: feat
status: complete
---

# Insights Delivery Trace Stage 1

## 目标

实现仓库级 Git ingestion 与 Delivery Graph 投影：只有显式注册的仓库会被扫描，`sync` 增量更新，`reindex` 可从已注册仓库重建，Deep Query 可以读取稳定的 `delivery-edge`。

## 现场

- Stage 0 的公开 schema、Rust/Node 协议校验、黄金夹具与 `TS_INSIGHTS_DELIVERY_TRACE_NOT_READY` 已在当前工作树完成，尚未提交。
- Stage 1 以 `docs/insights-delivery-trace-design.md` 与 ADR 0003 为冻结设计。
- 默认行为不得扫描 `$HOME`、`~/work` 或历史 Session cwd；Git 扫描只能来自显式 `sync --repository <path>` 注册或既有注册表。

## 边界

1. 外部配置保存 opaque repository ID、Git common directory 与当前 root locator；linked worktree 共享 identity。
2. Git adapter 只执行本地只读 plumbing，禁用 pager、optional locks、external diff/textconv、hooks、fetch 与网络。
3. `TraceSourceDeltaV1` 独立于 `SessionFactsDeltaV1`，通过 TEMP staging、canonical digest 与单事务写入 normalized tables。
4. projection version 为 `delivery-graph@1`；同步失败保留上一 committed snapshot。
5. Deep Query 只读取投影；Stage 1 不保存完整 diff/blob，也不新增 Dashboard UI。

## 证据

- [x] `sync --repository` 参数、注册持久化、旧配置迁移与默认零 Git 扫描红绿测试。
- [x] ref digest、fast-forward/rewrite/deleted-ref、worktree identity、SCM URL 裁剪测试。
- [x] TraceSourceDelta protocol、TEMP staging、ACK-loss replay、crash rollback 测试。
- [x] incremental 与 clean rebuild digest 等价、`delivery-edge` records/aggregate query 测试。
- [x] 25k repository-scoped ingestion/query 正式证据已在 Stage 4 归档；250k 延后到后续迭代。

## 下一步

进入 Stage 2：Agent Recipe、Evidence paging 与按需 Git diff；正式 25k 在 evidence 阶段统一运行，250k 保持延期。
