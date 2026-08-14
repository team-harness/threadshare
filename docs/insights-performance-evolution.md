# Local Insights 性能演进设计

状态：Stage 1 已实现并通过回归；Stage 2 实现暂缓；Stage 3 已完成三个候选 profiling，并优化两个 session-scoped Recipe；Stage 4–5 待独立实施与验收

日期：2026-08-14

适用范围：本机 Threadshare Insights 的 source discovery、增量索引、查询投影与性能验证；不改变云端 share、Viewer 或 `threadshare-history@v1`

设计参考：

- `ccusage/ccusage` `main@c1bfb45db99f0bdefa66a04d22d078d27e2550d7`
- `docs/insights-deep-query-design.md`
- `docs/adr/0001-local-insights-persistent-projection-architecture.md`
- `docs/adr/0002-evidence-gated-insights-performance-evolution.md`
- 大 Session TEMP file staging、流式 commit 与当前 25k Deep Query evidence

架构与实施边界由上述 ADR 冻结；本文负责阶段计划、测量结果和可变的实现细节。若本文与 ADR 冲突，必须先显式修订或 supersede ADR，不能在实现中静默偏移。

## 1. 决策摘要

`ccusage` 的汇总速度来自一个组合，而不是单一算法：它只抽取 token/cost 等窄字段，在 JSON 解析前做字节标记过滤，按文件大小均衡并行，一次装载基础数据后派生多种报表，并用进程内哈希表单趟去重和聚合。

Threadshare 不能直接采用“每条命令重新扫描所有 JSONL”的模型。Insights 需要保留完整 Turn、Tool/Skill、事件、payload、revision、dedupe、Evidence 与 FTS，且当前真实索引可超过 10 GiB。因此本设计采用以下演进路线：

1. **Stage 1：size-aware source scheduling**。先处理体积最大的待索引 Session，减少固定并发下的尾部拖延；不增加内存缓冲，不改变事务边界。
2. **Stage 2：profile-guided byte prefilter**。当前 profiling 显示 Engine commit 明显主导，触发条件不成立，因此不实现；只有后续证据反转时才重新开启。
3. **Stage 3：shared query base**。先消除已被 profile 证明的错误查询基座；同一 snapshot 内的后续组合分析再按证据复用 narrowed keyset、日级 rollup 与代表样本，不为每个 Recipe 重扫事实表。
4. **Stage 4：repeatable performance harness**。用 committed 小型 fixture、25k acceptance 和本机真实形状 fixture 分层验证，不让普通修复反复重建 10 GiB 索引。
5. **Stage 5：model/token/cost analysis**。在现有 token rollup 上增加带版本的离线价格投影，回答模型、缓存与成本问题；它不进入本轮实现。

Stage 1 与 Stage 3 的两个 session-scoped Recipe 查询计划是本轮代码变化。Stage 2 已完成一次当前代码穿刺并作出 no-go 决策；Stage 3 的 capability-contexts 候选同样作出 no-go 决策，failure-chains 与 file-workflow-signals 则因明确命中全局扫描而进入窄优化。Stage 4–5 是已确认方向，不得在缺少对应 profile、契约设计或 evidence 时顺手实现。

实施证据（2026-08-14）：size-aware 调度的测试先在旧 mtime-first 实现上精确失败，随后由 `size DESC -> mtime DESC -> source key ASC` 转绿；完整 `npm run test:insights-engine` 通过，包括 Rust tests、Clippy、Engine build、256 个 Node tests 与根 evidence verifier。

## 2. 现场基线

### 2.1 变更前索引路径

```text
discoverProviderEvidenceSources
        |
        v
planInsightsReconciliation
  - stat / fingerprint
  - append / replace / unchanged / missing / exclude
        |
        v
actionable.sort(compareNewest)
        |
        v
mapLimit(concurrency)
  readProviderSessionDelta -> captureSourceState -> commitSourceDelta
        |
        v
progress(bytesProcessed / bytesTotal)
```

`mapLimit` 是共享 next-index 队列。worker 完成一项后领取下一项，结果写回预分配数组，因此完成顺序不会改变最终计数。Stage 1 之前，actionable 只按 source mtime 降序；文件大小不参与调度。

### 2.2 已有能力

- Source metadata 已包含 canonical decimal `size` 与 `mtimeNs`，无需新增扫描或 schema。
- 默认并发为 4，上限为 16；每个 Session 的 Engine commit 保持事务原子。
- 大 Session 通过 TEMP file staging 和协议大小批次提交，不要求把整个 Session Facts 常驻内存。
- `history_activity_rollups`、`history_token_rollups`、`history_capability_rollups` 已按 Session/UTC day 在写事务内更新。
- 25k Deep Query runner 已覆盖 records、aggregate、七个 Recipe、Evidence、RSS、存储放大与 query plan。

### 2.3 已知问题

按“最新优先”启动时，较老但很大的 Session 可能直到队列末尾才开始。其他 worker 完成许多小文件后，最后只剩一两个大文件，占用一个 worker，整体 wall time 由长尾决定。增加并发不能消除该问题，还可能提高 I/O 与内存压力。

## 3. Stage 1：size-aware source scheduling

### 3.1 目标

- 在固定并发下尽早启动预计工作量最大的 Session。
- 排序完全确定，同一 source 集合在同一 metadata 下产生同一启动序列。
- 不新增文件读取、内容采样、全量排序副本或 Facts 缓冲。
- 不改变 report 格式、progress 字段、失败计数、retry、source state 或 Engine 协议。

### 3.2 算法

actionable source 使用以下全序：

```text
1. logical source bytes DESC
2. source mtimeNs DESC
3. provider + NUL + lowercase sessionId ASC
```

其中 logical source bytes 使用本轮 stat metadata 的 `size`；缺少本轮 metadata 时使用 previous source-state metadata；两者都缺失时为 `0`。所有值使用 `BigInt` 比较，不转换为 JS `Number`。

排序后继续使用现有共享 next-index 队列：最先空闲的 worker 领取尚未开始的最大 source。这是 longest-processing-time-first 的保守近似。文件字节不是精确 CPU 成本，但无需解析内容即可取得，并能直接识别已经出现过的超大 Session 长尾。

### 3.3 并发与顺序语义

- **启动顺序改变**：从 mtime-first 改为 size-first，这是有意的内部调度变化。
- **完成与 commit 顺序仍不承诺**：当前并发实现本来就由解析和 Engine ACK 时间决定完成顺序；公共契约没有 session commit order。
- **单 Session 原子性不变**：每个 `commitSourceDelta` 仍是独立 Session 的完整事务。
- **结果确定性不依赖 commit 顺序**：stable keys、generation、revision 与最终 projection 由事实内容和 source state 决定。
- **progress 不变**：`bytesTotal` 仍覆盖全部 plan item；unchanged 在初值中计入，lifecycle item 在直接处理后计入，actionable 在 finally 中计入；每项只累计一次，数值单调且最终相等。
- **失败隔离不变**：一个 source 失败只产生该 source diagnostic，其他 worker 继续；abort 仍立即向上抛出。

### 3.4 内存与 I/O 上界

Stage 1 不预读 source，不复制文件内容，也不按 worker 建立静态文件列表。新增状态只有 actionable 数组现有排序和常数级 `BigInt` 比较。

不采用 `ccusage` 的整文件 `fs::read`，因为 Insights 已观察到超过 32 MiB 的 Session，且完整事件/payload 远大于 usage-only 行。

### 3.5 验收

- 不同 size 时，较大的 source 必须先启动，即使它更旧。
- size 相同时，mtime 更新者先启动；size/mtime 都相同时，source key 决定稳定顺序。
- concurrency 上界保持不变。
- `committed`、`failed`、`bytesProcessed`、`bytesTotal` 与 progress 首尾值保持正确。
- `npm run test:insights-engine` 中的 Node indexer tests 通过；`git diff --check` 通过。
- 因为改变并发启动顺序，合入前执行独立 change review。

## 4. Stage 2：字节级预过滤与 typed decoding

### 4.1 触发条件

只有 profile 同时满足以下条件才进入实现：

- 增量 sync 或 reindex 的 provider parsing 占 wall time 的主要部分；
- JSON decode/动态对象构造是 parser 主要 CPU 或 allocation 来源；
- Engine commit、SQLite projection 或磁盘吞吐不是更大的瓶颈。

### 4.2 设计方向

```text
stream bytes
  -> newline framing
  -> conservative byte markers
  -> typed header/classification decode
  -> resource-specific full decode
  -> SessionFactsDeltaV2 streaming batches
```

预过滤只能拒绝可证明不产生任何 Fact、payload、coverage 或 parser checkpoint 的记录。每个 provider adapter 维护接受类别 golden；原始行 digest、offset 和 coverage 语义保持不变。

### 4.3 禁止项

- 不读取整个 Session 到内存。
- 不因 typed decode 失败静默跳行。
- 不把 unknown 当作 irrelevant。
- 不用不稳定哈希替代 stable key 或 canonical digest。
- 不在 Node worker、Rust parser 和 Engine commit 三层叠加无界并行。

### 4.4 2026-08-14 profiling 结论

使用现有 `--raw-backfill` runner 对当前工作树执行了一次非正式、可快速重复的穿刺：256 个 Codex/Claude Session、`75,955,305` raw bytes、每个 Session `262,144` 个 text characters。语料在 `/tmp` 生成并在运行后清理，没有读取或重建本机 10 GiB 索引。

| 指标 | 当前 256 Session 穿刺 | 既有 10k acceptance |
|---|---:|---:|
| Adapter 累计时间 | 5,318 ms | 137,241 ms |
| Engine commit ACK 累计时间 | 91,980 ms | 740,676 ms |
| Adapter / 两阶段累计时间 | 5.5% | 15.6% |
| Adapter P50 | 19.59 ms | 13.04 ms |
| commit ACK P50 | 356.83 ms | 72.43 ms |

当前穿刺使用 debug Engine 且工作树为 dirty，只用于阶段归因，不是 acceptance evidence；其 `2.95 MiB/s` 不能与 release-profile 的正式吞吐门槛直接比较。两组数据的方向一致：provider adapter 既不是最大可归因阶段，也没有证据显示 JSON decode 是主导成本。因此 Stage 2 的第一条触发条件已经失败，本轮不采集 CPU allocation profile，也不引入 byte prefilter 或 typed partial decoder。

重新开启 Stage 2 必须先出现当前版本、同一 corpus 上的反向证据：Adapter 成为最大可归因阶段；随后 CPU/allocation profile 还必须把 JSON decode 或动态对象构造识别为 Adapter 内主因。

## 5. Stage 3：共享查询基础与精确缓存

现有日级 rollup 继续作为聚合主路径。后续优化重点不是增加更多孤立 SQL，而是让一个 Agent 分析中的多步查询共享：

- `databaseUuid + snapshotSeq + evaluationClock`；
- 时间窗、provider/project/session 可见性 keyset；
- capability/error/attempt 的候选集合；
- 已选代表 Turn 与 Evidence revision。

精确缓存键必须至少包含 `databaseUuid + snapshotSeq + canonicalRequestDigest`。snapshot 变化后缓存立即失效。只允许 Dashboard 对明确标注 approximate 的视图使用 stale-while-refresh；CLI JSON 与 Agent/MCP 默认返回精确 snapshot，不返回旧结果冒充当前结果。

### 5.1 `capability-contexts@1` 候选 profiling

2026-08-14 使用一次保留数据库的 5k 穿刺复核旧 25k evidence 中最慢的 `capability-contexts@1`。语料为 5,000 Turn / 50 Session、约 186.9 MB canonical Facts，SQLite 约 204.7 MiB；生成一次后，三条 SQL 复用同一个只读数据库，不重复建库。

| 路径 | 结果规模 | P50 | P95 | 主要 query-plan 行为 |
|---|---:|---:|---:|---|
| 完整 Recipe round trip | 10 次 | 30.26 ms | 32.90 ms | 三条投影查询 + Rust 聚合和协议 |
| capability 主 rollup | 600 行 | 0.89 ms | 1.12 ms | `sessions_query_filters` + rollup PK |
| 代表 Turn | 50 行 | 12.04 ms | 13.05 ms | `history_capability_representatives_capability_day` + bounded Top-10 + materialized rank |
| 共现能力 | 20 行 | 2.83 ms | 4.71 ms | `history_capability_cooccurrences_capability_day` + bounded Top-10 |

代表 Turn 的分组和排名是该 Recipe 内最大的 SQL 阶段，但完整 P95 仅为门槛的 6.6%，所有主要表均命中既有索引。此时增加 TEMP shared base、新 projection 或 exact cache 会引入 snapshot/purge/重建复杂度，却没有足够收益证据，因此不实施。

同一当前版本的 5k 穿刺中，`failure-chains@1` P95 为 211.31 ms，已经取代 capability contexts 成为最慢 Recipe。因此第二个候选转向 failure-chain 的 7 日分段、detail materialization 与重复 scope 扫描，而不是继续依据旧 evidence 排名选择优化对象。

### 5.2 `failure-chains@1` session-scoped 查询计划

2026-08-14 复用 5.1 的同一 5k 数据库，对 benchmark 实际使用的单 Session 请求拆分测量。摘要阶段返回 600 个事件，最终选择 10 条失败链、24 个详情事件；所有测量均先 warmup 5 次，再读取 30 个样本。

| 路径 | P50 | P95 | 结论 |
|---|---:|---:|---|
| coverage | 4.91 ms | 5.42 ms | 非主因 |
| 原摘要 SQL | 145.09 ms | 153.01 ms | 强制 `history_events_observed`，先扫描全局时间窗 |
| Session-first 等价摘要 SQL | 3.09 ms | 3.72 ms | `session_key -> attempt_chain_events_correlation -> event` |
| 10 条链详情 | 13.06 ms | 14.92 ms | bounded，非主因 |
| 10 条链 revision | 0.04 ms | 0.05 ms | 非主因 |
| payload reference 批量读取 | 0.04 ms | 0.05 ms | 非主因 |

根因是摘要 SQL 无条件 `INDEXED BY history_events_observed`。即使 request 已给出 `sessionKeys`，SQLite 仍先遍历整个时间窗，再逐 event 过滤 Session。该成本随全库事件数增长，而不是随目标 Session 大小增长。

实现采用请求形状感知的双计划，不新增表或索引：

- 有 `sessionKeys`：从 `sessions.session_key` 唯一索引进入，再用既有 `attempt_chain_events_correlation(session_id, ...)` 限定候选；
- 无 `sessionKeys`：继续使用 `history_events_observed` 做全局时间窗扫描；
- coverage、详情、排序、revision、payload reference 和 response schema 不变。

真实 Engine 对同一 DB、同一 request 各执行 5 次 warmup + 30 次测量：已安装 0.8.4 Engine 的 P50/P95 为 205.31/284.53 ms，当前 release build 为 25.67/27.48 ms，P95 改善约 10.4 倍。两侧 response SHA-256 均为 `31fbee35d53c4afa7953d37940d741d3a383ee74154cc719f4c1359dcd2a7b7e`，证明结果逐字节一致。query-plan 回归测试同时钉住：session-scoped 请求必须使用 chain index 且不得扫描全局时间索引；全局请求必须保留时间索引。

### 5.3 `file-workflow-signals@1` session-scoped 查询计划

第一次 25k 验证发现 `failure-chains@1` 已降到 P95 61.10 ms，但 `file-workflow-signals@1` 仍为 737.54 ms，成为唯一超过 500 ms Recipe 门槛的路径。复用 5.1 的同一 5k 数据库后，摘要阶段的归因如下：

| 路径 | 结果规模 | P50 | P95 | 主要 query-plan 行为 |
|---|---:|---:|---:|---|
| 原摘要 SQL | 600 行 | 74.88 ms | 99.42 ms | 强制 `file_activity_observed`，先扫描全局时间窗 |
| Session-first 等价摘要 SQL | 600 行 | 1.20 ms | 1.30 ms | `session_key -> history_events_session_order -> file_activity PK` |

实现沿用 5.2 的双计划原则：有 `sessionKeys` 时从 Session 和事件顺序索引进入；无 `sessionKeys` 时保留全局 `file_activity_observed` 时间索引。详情读取与 response schema 均不变。5k 真实 Engine 的 P50/P95 从 124.14/130.93 ms 降到 53.11/56.29 ms；两侧 response SHA-256 均为 `46e7ba56bc43aaa0b146fde1b35bc646eb96fb177fd408ae615eaa1c8edf3d00`。

修复后只重跑一次 25k formal-shape 验证（25,000 Turn / 250 Session、约 925.9 MB canonical source）；不运行 250k：

| Recipe | P95 |
|---|---:|
| `capability-contexts@1` | 142.55 ms |
| `failure-chains@1` | 63.73 ms |
| `file-workflow-signals@1` | 77.43 ms |
| 其余四个 Recipe 中最高值 | 39.13 ms |

该次运行的 Deep Query paths、Recipe、Evidence、FTS integrity、query plan、128 MiB sidecar RSS 与 storage amplification gates 全部为 true；sidecar peak RSS 约 43.4 MiB，persistent storage amplification 为 1.15x。报告保存在 `/tmp`，由 dirty worktree 的本地 release build 生成，只作为本次实现验证，不作为已归档、可发布的 acceptance artifact。

## 6. Stage 4：性能回归体系

### 6.1 三层数据

| 层级 | 数据规模 | 运行时机 | 目的 |
|---|---:|---|---|
| PR fast fixture | 1k–5k Turn，含大/小 Session 长尾 | parser/indexer/SQL 变更 | 快速发现调度、解析和 query-plan 回退 |
| Formal 25k | 现有 deterministic corpus | milestone/release evidence | 延迟、RSS、存储、Recipe 与 Evidence 门槛 |
| Local real-shaped | metadata-derived synthetic 或本机现有索引 | 索引格式、调度或 projection 大改 | 大 Session、磁盘吞吐、完整 sync/reindex |

250k 继续是后续长期容量档，不进入普通 PR 或 CI。

### 6.2 分段归因

同一 fixture 分别测量：

- Node CLI 与 discovery；
- provider parse / Fact projection；
- Engine protocol / staging / commit；
- SQLite projection；
- warm records/aggregate/Recipe query。

基准必须使用同一 corpus 比较 base 与 candidate，记录 wall time、CPU、peak RSS、bytes/s 和 source-size percentile。不能只记录总时间后猜测瓶颈。

## 7. Stage 5：模型、token 与成本分析

在现有 `history_token_rollups` 上增加可版本化的离线价格数据，而不是在查询时访问网络。目标问题包括：

- 哪些项目、任务类型或模型消耗 token 最多；
- cached input 与 uncached input 的分布；
- 高成本失败链是否后来成功；
- 相似 Tool/Skill 场景下不同模型的 token/cost 差异。

价格是派生事实，response 必须回显 price catalog version、缺失价格覆盖和币种。没有价格的 token 不得被计为零成本。

## 8. 影响面

### 必须修改

- `src/insights-indexer.mjs`：新增 logical size comparator，actionable 改为 size-aware 全序。
- `test/insights-indexer.test.mjs`：以可控 source size/mtime 验证启动顺序、并发与 progress。
- `crates/insights-engine/src/recipe.rs`：为 `failure-chains@1` 与 `file-workflow-signals@1` 选择 session-scoped 或 global 摘要计划，并以 `EXPLAIN QUERY PLAN` 锁定索引入口。

### 需要验证

- `src/insights-command.mjs` 的 sync/reindex 调用无需传新选项。
- background worker 的 coalescing、abort 与 retry 语义不变。
- Engine protocol、Fact schema、SQLite schema、Query/Recipe schema 和 npm allowlist 不变。

### 仍待调查

- 一次 Agent 分析中重复 SQL/keyset 的实际比例；决定 Stage 3 cache 与 shared-base 的接口。
- token price catalog 的 owner、更新策略与离线发布体积；决定 Stage 5 契约。

### 已完成调查

- provider parsing 相对 Engine commit 的阶段占比已用当前 256 Session 穿刺和既有 10k acceptance 交叉验证；Stage 2 当前不值得实施。
- `capability-contexts@1` 当前完整 P95 远低于门槛且已命中投影索引，不值得增加 shared cache 或新 projection。
- session-scoped `failure-chains@1` 的全局时间索引扫描已定位并消除，响应 digest 保持不变。
- session-scoped `file-workflow-signals@1` 的同类全局扫描已定位并消除；25k 的七个 Recipe 全部回到门槛内。

## 9. 回滚与失败方向

Stage 1 是纯调度变化。若实测没有收益或特定磁盘上出现回退，可以恢复 mtime-first comparator，不涉及数据迁移或索引重建。任何 source metadata 异常继续在 planning 阶段 fail-closed；调度器不猜测或修复非法 size。

Stage 3 的两个 Recipe 优化同样不涉及 schema 或数据迁移。回滚只需恢复对应摘要 SQL；全局查询路径本来就保留旧计划。若未来 SQLite planner 或索引发生变化，query-plan 测试必须先失败，不能静默退回全库扫描。

Stage 2–5 每一阶段必须独立形成 red -> green、profile/evidence 与 rollback 条件，不能把本设计文档视为已完成实现证明。
