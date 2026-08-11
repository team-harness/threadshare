---
type: feat
epic: local-session-insights
status: review-pending
---

# Agent Insights Query

## 目标

把 Dashboard 已使用的隐私裁剪 Insights 结果提升为稳定、Agent-first、JSON-only 的本地 CLI 契约。Agent 应能检索历史 Turn、核查证据、统计 Skill/Tool 使用、观察时间趋势，并基于可复核事实回答问题；CLI 本身不内嵌 LLM。

## 现场

- 当前公开 `insights` 只支持 Dashboard 与维护动作；Engine 已支持 Overview、Capability Page、Turn Search、Turn Evidence。
- 当前 `LIST_CAPABILITIES` 只有全历史计数并按 capability key 排序，不能回答时间窗排行。
- 当前 Search 支持 provider/project/capability/time/result-evidence/closure 过滤，但不支持 capability terminal state 或显式 recent 排序。
- 当前 retry projection 提供全历史 capability failed/same-input-repeat/retry-after-failure 汇总，不支持时间窗。
- 开始设计时 HEAD 为 `3eea6b86acd7137c77bb72a62057a3af2cfef468`；已审大 Session staged diff SHA-256 为 `6fdb1528eb6a98cdee772669a73086faf75c18052d1402246d55cc39baf40438`。本功能不得修改该 staged 集合。

## 边界

### 公开命令

```text
threadshare insights overview --format json
threadshare insights search (--query <text> | --request <file|->) --format json
threadshare insights capabilities <tool|skill> [--cursor <cursor>] [--limit <n>] --format json
threadshare insights usage <tool|skill> --request <file|-> --format json
threadshare insights activity --request <file|-> --format json
threadshare insights evidence <turn-key> --revision <revision> [--cursor <cursor>] [--limit <n>] --format json
```

- 六个查询动作均为 JSON-only；成功为单行 JSON、stderr 空。
- 失败保持现有公共 CLI 契约：exit 1、stdout 空、stderr 只有稳定 code 与 `Problem/Usage/Next`。
- `--query` 是简单 Search 的便捷入口；`--request` 是 canonical automation path，二者互斥。
- `--request` 最大 64 KiB；Search query 最大 8 KiB；公开 result/page limit 最大 50；pathLimit 最大 20。

### 公共格式

```text
threadshare-insights-overview@v1
threadshare-insights-search-request@v1
threadshare-insights-search@v1
threadshare-insights-capabilities@v1
threadshare-insights-usage-request@v1
threadshare-insights-usage@v1
threadshare-insights-activity-request@v1
threadshare-insights-activity@v1
threadshare-insights-evidence@v1
```

每个格式有随 npm 包发布的 JSON Schema，`additionalProperties:false`。字段增加或语义变化必须发布新的 format 版本，不能把 Engine protocol envelope 当作公共格式。所有可能超过 JS safe integer 的 count、snapshot seq 与有符号 delta 都使用 canonical 十进制字符串。

### Search

Request 暴露现有 typed filters：providers、projectKeys、toolCapabilityKeys、skillCapabilityKeys、RFC3339 `[observedAtOrAfter, observedBefore)`、resultEvidence、closureStates；新增：

```text
orderBy: relevance | observed-desc
capabilityTerminalStates: pending | completed | failed | cancelled | unknown
```

Search 必须有非空 query 或至少一个 structured filter。`relevance` 只允许非空 query；默认值为「有 query 时 relevance，否则 observed-desc」。非空 query 若 analyzer 产出零 scoring term，必须返回 `TS_QUERY_TOO_BROAD`，与是否同时存在 structured filter 无关；禁止静默丢弃 query 后退化为纯 filter/时间排序。此项会修正既有 Search 的 analyzer 降级行为，必须更新 Search golden。`observed-desc` 必须在全部 FTS/structured matches 上按 `observedTimestamp DESC, turnKey ASC` 取结果，不能先截 BM25 Top-300 再重排；该模式不返回 relevance score。

`query + observed-desc` 还必须提供完整时间窗且跨度不超过 366 天。Engine 在同一 read transaction 内先做最多 10,001 个 filtered FTS match 的 bounded probe：超过 10,000 直接返回 `TS_QUERY_TOO_BROAD`，不产生抽样结果；未超过才对完整 match set 做 timestamp 排序，并返回精确 `totalMatchCount`。因此该模式只能「真 newest」或明确拒绝，不能退化为近似排行。

`capabilityTerminalStates` 必须与至少一个 tool/skill capability key filter 同时出现，并与 capability key、kind、`origin_scope='main'` 放在同一个 `EXISTS` 中。若 tool 与 skill 两组 key 都存在，两个子查询都必须各自命中所选 terminal state；禁止由同 Turn 的另一 Capability 串线命中。`unknown` 对应已知四态之外的 Engine 兼容桶。

返回 committed snapshot、projection/analyzer/ranker versions、裁剪后的 results 与 query-scoped evidencePaths。公开结果只保留 contract IDs、revision、provider/project、timestamp、problem/final excerpts、closure/result evidence、稳定语义 score，以及可选的 `dedupe` 对象 `{duplicateGroupKey, confidence, observedEofProvisional}`；移除 requestId/type、searchTrace、timings、BM25/term-index 实现细节。duplicate group 只表示证据支持关系，不表示整个 Session 可删除或所有后续 Turn 等价。

`--query` 便捷入口只允许 `--limit`；全部 structured filters、orderBy 与 pathLimit 走 `--request`。

### Capability directory

公开 `capabilities` 与 Usage/Search 使用同一事实全集：eligible main-scope session、active Turn、main-scope use、revision 非空、canonical observed timestamp 非空且未处于 purge。它是按 key 的目录，不是排行，item 只稳定公开 capabilityKey/provider/kind/canonicalName。响应 coverage 分别返回 `excludedUndatedInvocationCount` / `excludedUndatedTurnCount` 与 `excludedUnrevisionedInvocationCount` / `excludedUnrevisionedTurnCount`，注明两类可能重叠，并返回 `fullyExcludedCapabilityCount`；因此 Agent 能区分「不存在」与「全部调用被 query universe 排除」，也不会与既有内部 all-history Capability 统计混用。

### Usage

Usage request 包含显式 UTC window、可选 comparisonWindow、provider/project/closure filters、orderBy、limit 与可选 cursor。两个窗口必须在同一 SQLite read transaction/snapshot 内，以包含该 invocation 的 Turn `observedTimestamp` 归窗；无 canonical timestamp 或 revision 的 use 不进入窗口，并使用与 Capability directory 相同的四个 coverage 排除计数。

```text
orderBy: recorded-invocation-count | recorded-failing-invocation-count |
         distinct-turn-count | distinct-session-count |
         distinct-dedupe-group-count | last-used |
         absolute-recorded-invocation-change
```

`orderBy` 必填，不设可能误导 Agent 的默认值。回答「索引记录里调用最多」使用 `recorded-invocation-count`；回答「出现于多少个 dedupe group」使用 `distinct-dedupe-group-count`，两者不得互换。

v1 不声称能从 session-level、首 Turn 前缀 dedupe 事实推导「真实去重 invocation 次数」：resume/fork 后续 Turn 可能分叉，禁止折叠整个 Session。每项明确返回：

- `recordedInvocationCount`、`recordedFailingInvocationCount`、`distinctTurnCount`、`distinctSessionCount`、`lastUsedAt`；禁止裸 `useCount` / `failureCount`。
- `invocationTerminalCounts`，带 `invocationTotal` 与 pending/completed/failed/cancelled/unknown 五态。
- `containingTurnOutcomeCounts`，带 `distinctTurnTotal` 与 providerCompleted/abandoned/unknown 三态；它只表示共现，不表示 Capability 导致 Turn 结果。
- `groupedInvocationCount` 与 `ungroupedInvocationCount`，两者之和必须等于 `recordedInvocationCount`；null-group 只表示无法评估 dedupe，不能当成独立或重复。
- `support`：distinctDedupeGroupCount、strongDedupeGroupCount、weakDedupeGroupCount、observedEofProvisionalGroupCount、unknownDedupeSessionCount 与 sessionDuplicateMethodCounts。strong+weak 必须等于 distinct dedupe group；observed-EOF provisional 是单独证据轴且只适用于 prefix 方法，不能与 confidence 相加。
- observed/confirmed/inferred strength counts。

响应必须回显 `orderBy`。Agent 回答「使用最多」时必须写成「索引中 recorded invocation 最多」，并始终报告 grouped/ungrouped invocation 与 dedupe support；只要 ungrouped 非零，就明确说明这部分无法评估独立性。当 `distinctSessionCount > distinctDedupeGroupCount` 时，还必须同时给出这两个数，并说明 recorded invocation 可能包含由重复证据关联的多个 Session 的重复记账，不能表述为同等数量的独立使用。固定 tie-break 为选定 metric DESC，再按 distinctTurnCount DESC、distinctSessionCount DESC、lastUsedAt DESC、capabilityKey ASC；聚合 cursor 绑定完整排序 tuple，`lastUsedAt=null` 排在非 null 之后。

comparison candidate universe 是两个窗口 Capability 的并集。未请求 comparisonWindow 时 `comparison:null`；请求后缺失一侧的 count 为十进制字符串 `"0"`。delta 是 current-baseline 的有符号十进制绝对差（例如 `"-12"|"0"|"12"`），不返回比率；`absolute-recorded-invocation-change` 按绝对 delta 排序且要求 comparisonWindow，否则返回 `TS_INSIGHTS_REQUEST_INVALID`。分页/截断必须返回 decimal `totalCandidateCount` 与 `truncated`，不能让只在 baseline 出现的 Capability 静默消失。

现有 retry projection 只放在 `outOfWindow.retrySummary`，明确标注 `scope: all-indexed-history`；v1 不声称它受 Usage window/comparisonWindow 限制，也不按 retry 指标做时间窗排序。精确 windowed retry 需要新的 per-use relation projection，属于后续设计。

### Activity

Activity 强制显式 canonical RFC3339 UTC window，bucket 为 `day|week`，`timeZone` 固定返回 `UTC`；day 从 00:00Z 开始，week 使用 ISO-8601 周一 00:00Z。window 两端必须与所选 bucket 边界对齐；每 bucket 返回完整 `bucketStart`/`bucketEnd`，最多 366 buckets；未对齐或超限直接拒绝，不能生成含糊的 partial bucket 或截断。

每 bucket 返回 distinct session/Turn counts、`currentClosureCounts`、Turn result-evidence counts、recorded tool/skill invocation counts与 dedupe support coverage。`currentClosureCounts` 必须带 `closureEvaluatedAt`，明确它是同一冻结时刻 as-of 的当前 closure，不是该历史 bucket 当时的 closure。Activity v1 不返回 provider/project rollups；调用方可用 provider/project filter 分别查询，避免 bucket×rollup 的额外无界 GROUP BY。它只提供聚合事实；具体主题由 Agent 对相同时间窗执行 Search 后总结。

### Evidence 与 Cursor

- Evidence 在公共层和 Rust Engine 层都强制 search result revision；缺 revision 直接拒绝，revision 变化返回 `TS_INSIGHTS_TURN_CHANGED`。
- 新建数据库时在 `engine_metadata` 生成不可变 `database_uuid`；atomic reindex candidate 必须生成新 UUID。它只用于 generation identity，不直接公开。
- Evidence public cursor 认证绑定 database UUID、turnKey、revision 与 Engine cursor。
- Capability/Usage public cursor 认证绑定 database UUID、snapshotSeq、kind、去掉 cursor 后的完整 canonical request digest、冻结的 `closureEvaluatedAt`/quiescence 配置与 Engine cursor；漂移返回 `TS_INSIGHTS_CURSOR_STALE`。续页复用 cursor 中的 evaluation clock，不能重取 wall clock。
- cursor 是不透明、带 MAC 的本地 token，不泄露 origin secret、路径或 inode。
- `dev/ino/size/mtimeNs` 只用于进程内 client cache 与原子替换检测，不能作为公共 cursor generation identity。
- 每个 Engine request 内部为一致 SQLite snapshot；跨命令不承诺同一 snapshot。snapshotSeq 不能被描述为跨 atomic reindex 全局单调。
- 所有公开响应使用 `snapshot:{seq, token}`；token 是 database UUID 与 snapshotSeq 的 MAC 投影，不暴露原始 UUID。Overview/Search/Usage/Activity 只要返回 closure 统计或字段，就同时返回冻结的 `closureEvaluatedAt` 与 `quiescenceSeconds`。

### 隐私与只读语义

- 允许本地 Agent 读取裁剪后的 visible user problem excerpt 与 assistant final excerpt。
- 允许 contract IDs：turnKey/sessionKey/projectKey/capabilityKey/duplicateGroupKey/revision。
- 禁止原始 transcript、Tool 参数/输出、system/thinking、Skill body/path、绝对路径、provider pointer、exactObservedName、input/origin/path fingerprint、correlation/provider-turn digest、Engine stderr/SQL/serde 文本进入公共 DTO 或诊断。
- Query 是产品语义只读：不扫描 raw provider files、不自动 reindex、不改 exclusion/config、不创建缺失 DB 或 origin secret、不取应用 writer lock。
- Engine 可能维护派生 projection，因此不声称 SQLite 文件物理只读。缺库或 snapshot 0 返回 `TS_INSIGHTS_NOT_INDEXED`。
- `openExistingInsightsState()` 只允许 `lstat` 已有文件与读取已有 secret epoch：不 mkdir、不 chmod、不写 temp、不修复状态。DB 存在但 secret 缺失返回现有 origin-secret diagnostic，不能静默创建。
- 查询 sidecar 使用独立的 `EngineStorage::open_existing()`：必须同时绕过 `persistent_file_permissions::prepare()` 与 `enforce()`，以 `SQLITE_OPEN_READ_WRITE | SQLITE_OPEN_NOFOLLOW` 且不含 `SQLITE_OPEN_CREATE` 的模式打开已有 DB，全程不得 chmod DB/`-wal`/`-shm`。Node 预检后 DB 被移走时不得误建空文件；DB 被替换为 symlink 时必须在连接前后都 fail-closed，且不得改变 symlink 目标的 inode 或 mode。该模式仍允许同一现有 DB 内已声明的 schema/projection maintenance。
- source freshness 固定声明 `not-evaluated`；不得把 committed snapshot 冒充 raw source 最新状态。

### 公共错误

- 请求形状、跨字段组合或 UTC bucket 对齐错误：`TS_INSIGHTS_REQUEST_INVALID`。
- query 过长/过宽：既有 `TS_QUERY_TOO_LONG` / `TS_QUERY_TOO_BROAD`。
- DB 缺失或 snapshot 0、cursor generation/snapshot 漂移、Turn revision 漂移：`TS_INSIGHTS_NOT_INDEXED` / `TS_INSIGHTS_CURSOR_STALE` / `TS_INSIGHTS_TURN_CHANGED`。
- busy、timeout、abort、disconnect/fatal 统一映射为 content-free 的稳定 Insights code；stderr 不得包含 Engine code、SQL、路径、query 或 excerpt。

### 模块归属

- `src/insights-query-reader.mjs`：从 Dashboard 抽出 database identity、existing-state open、Engine client 生命周期与 atomic reindex 竞态处理；Dashboard 和 CLI 共享，npm 不公开导出。
- `src/insights-query.mjs`：公开 request 校验、DTO 白名单投影、cursor 认证和 Engine/public error mapping。
- `src/insights-state.mjs`：新增 `openExistingInsightsState()`；缺失状态绝不创建目录/secret，且只读 helper 本身不 chmod。
- `src/insights-engine-client.mjs`：任何读请求 timeout/abort/disconnect/fatal 都置 broken 并强制关闭 transport；reader 捕获后 invalidate，防止迟到 frame 污染下一请求。
- Rust Engine 增加 bounded Usage/Activity request/response、Search terminal/order、必填 Evidence revision、database UUID、必要 query indexes，以及绕过 `prepare()`/`enforce()` 的 `EngineStorage::open_existing()`；v1 尽量使用现有 normalized tables/rollups/retry projection，不新增 windowed retry schema。

### 查询与索引不变量

- canonical UTC timestamp 使用直接字符串 `[after,before)` range，禁止用 `unixepoch(column)` 包裹索引列。
- 实现至少评估 `turns(observed_timestamp, turn_id)` 与 `capability_uses(capability_id, turn_id, provider_terminal_state)`；最终索引由 25k/250k EXPLAIN 与 latency/RSS 证据确定。
- recent-window formal plan 禁止出现无界 `SCAN turns`、`SCAN capability_uses` 或未被 match-count 上界约束的 `USE TEMP B-TREE FOR ORDER BY`；all-history path 可以选择扫描，但仍须通过正式 P95/P99/RSS gate。
- Usage 排名使用两阶段查询：selection 只计算所选排序指标和完整 keyset tuple，随后只对当前 ≤50 个 item enrichment 其余 counts，避免对全量 Capability 同时建立多棵 DISTINCT 临时树；语义上仍对完整 candidate universe 排名。
- Usage/Activity 聚合禁止 N+1 per-row 查询。group confidence 与 Search `dedupe.confidence` 共用提升后的 group-level classifier；classifier 在同一 read transaction 内按全局 eligible/main/nonpurged membership 计算，窗口只选择支持 group。为排除 purge 成员而改变既有 Search confidence 属 v1 明示行为修正，必须更新 Search golden。observed-EOF provisional 是单独轴，但只出现在 prefix 方法上。

### Agent recipes

Skill 固化至少五条组合流程：最近 recorded invocation 最多或 distinct dedupe group 最广的 Skill/Tool 及场景；调用失败热点及失败场景；类似问题的历史解法与 Tool path；open/abandoned/unknown follow-up queue；当前窗口与基线窗口的活动变化。回答必须携带 window、snapshot、grouped/ungrouped invocation、dedupe support 和 evidence Turn；ungrouped 非零时必须明确「这部分无法评估独立性」；`distinctSessionCount > distinctDedupeGroupCount` 时必须同时给出两者，并说明 recorded invocation 可能含重复记账。调用终态与 containing-Turn outcome 必须分别陈述，相关性不得表述为因果。recipe golden 禁止「导致/造成/提升/降低成功率」等因果措辞。

### 非目标

- Dashboard HTTP/Cookie API、公共 Node export、MCP server、daemon 或自动 reindex。
- 任意 SQL、任意 group-by、通用 analytics DSL 或 CLI 内置自然语言 `ask`。
- 全局主题聚类、因果推断、生产力评分、原始 Session 导出。
- v1 精确 windowed retry/co-occurrence projection。

## 证据

- `crates/insights-engine/src/query.rs`：现有 Search filters、snapshot 和 evidencePaths。
- `crates/insights-engine/src/insights_overview.rs`：Overview 与全历史 Capability Page。
- `crates/insights-engine/src/retry_projection.rs`：全历史 retry summary。
- `crates/insights-engine/src/evidence_path.rs`：query-scoped Tool path 与 revision-checked evidence。
- `src/insights-dashboard.mjs`：现有 committed reader seam；不得复用 Dashboard HTTP。
- 2026-08-11：9 份公开 schema 已补齐，`node --test test/insights-query-schema.test.mjs` 1/1 通过，并由 Ajv 2020 strict 模式逐份编译。
- 2026-08-11：installed-package smoke 已扩展为合成建库后执行 6 个 Agent query action、加载并校验 9 份已安装 schema；注入层定向测试 1/1 通过，真实 sidecar 运行待跨语言 dispatch 集成完成后执行。
- 2026-08-11：协议/存储分支定向验证为 Rust protocol 12/12、Node protocol 20/20；`database_uuid`、existing-open、Evidence 必填 revision 与 Usage/Activity request wire 已落地，response dispatch 等待 Rust DTO。
- 2026-08-11：`npm run test:cli` 完整回归为 147 个测试项 / 172 tests / 0 fail，覆盖新增 query parser/schema/DTO 与既有 share/read/export/analyze 契约。
- 2026-08-11：`npm pack --dry-run --ignore-scripts --json` 精确返回 54 个文件；9 个 query schemas 与 `insights-query-reader.mjs` / `insights-query.mjs` 均在包内，未带 docs、scripts 或 node_modules。
- 2026-08-11：`npm run test:release` 58/58 通过，installed-smoke 注入、54-file root allowlist、六平台发布矩阵与 clean-tree release imports 均保持有效。
- 2026-08-11：Rust Usage/Activity/Search、Engine dispatch、Node protocol/client/reader 与六个 JSON-only CLI 动作已集成；真实 installed-package smoke 执行 6 个查询动作并解析 9 份 schema，返回 `queryCount:6` / `schemaCount:9`。
- 2026-08-11：Usage selection 已收敛为两阶段：第一阶段只计算所选 metric 与固定 tie-break tuple，第二阶段只 enrich 当前页最多 50 项；comparison 仍对两窗口候选取并集。
- 2026-08-11：实库与同源单测 `EXPLAIN QUERY PLAN` 均证明 recent Usage selection 使用既有 `turns_query_filters` 与 `capability_uses_query_filter`，无 `SCAN turns` / `SCAN capability_uses`；coverage 是显式标记为 `all-indexed-history` 的全域聚合，成本随索引总量线性；候选新索引未被采用，已移除，避免增加容量占用。
- 2026-08-11：最终验证：`npm run test:insights-engine` Rust 全绿、Node 234/234、ITEM-4/5/6 evidence verifier 全绿；CLI 176/176、Viewer 7/7、API 32/32、release 59/59、FC 19/19、Cloudflare build 与 Skill validation 全绿；Clippy `-D warnings`、rustfmt、`git diff --check` 全绿；npm dry-run 精确 54 files。
- 2026-08-11：独立终审 0 blocking；唯一 important 的 coverage scope 披露已补为 `all-indexed-history`，三份 schema、投影测试与 Skill 同步，selection/coverage 性能证据边界已改为准确措辞。

## 验收

1. TDD：公共 parser/schema/DTO exact-key golden 先红后绿，所有成功严格单行 JSON。
2. 真实 sidecar 链：overview → usage/activity/search → evidence/capabilities；从 `npm pack` tarball 安装后执行全部六个查询命令，并逐一 parse 9 个随包 schema。
3. 一致性：同 snapshot 双窗口；Rust 层缺 Evidence revision 必须拒绝；closure clock/cursor stale、database UUID 原子 reindex、concurrent writer 均 fail-closed。
4. 生命周期：读请求 timeout/abort/disconnect/fatal 后立刻发不同类型请求，只允许干净错误或全新 client；单测 `openExistingInsightsState()` 本身前后 state 目录 mode/mtime 不变且不创建文件。完整 CLI 查询允许已声明的 projection/schema maintenance 改变 DB 内容/mtime，但 DB/`-wal`/`-shm` 的 mode 必须前后不变。预检后删除 DB 必须拒绝且不得新建文件；替换 symlink 必须拒绝，并断言目标文件 inode 与 mode 前后不变。
5. 隐私 canary：stdout/stderr 不含路径、Tool payload、system/thinking、internal digests；visible excerpts 与允许的 contract IDs 保留。
6. 性能：25k/250k 上 Usage/Activity/Search 新路径有界，不能回扫 raw files；recent-window EXPLAIN 无无界 turns/uses scan。`query+observed-desc` 用 250k 高文档频率词验证 >10,000 及时拒绝，并用 ≤10,000 matches 验证真 newest 与 P95/P99/RSS 既有 long-term gates。
7. 统计 golden：resume/fork、全 unknown-group 的高 recorded-count Capability、grouped+ungrouped=recorded、`distinctSessionCount > distinctDedupeGroupCount` 的已知重复披露、undated/unrevisioned fully excluded Capability、comparison 两窗口并集、UTC 日/ISO 周边界、terminal/capability 同行关联、双轴分母与禁止因果 recipe 均有可杀伤用例。
8. 更新 CLI help、README/README.zh-CN、Skill、9 个 schemas、release exact allowlist；运行受影响 Node/Rust/CLI/release/skill 验证。
9. 因公开多消费者契约、隐私边界和一致性语义变化，design 与最终 diff 均需独立 review。

## 状态与未决

- Owner 已确认方案 A，以及 `usage + activity + search terminal/order` 进入 v1。
- Round 1 reviewer 的 B1-B5/I1-I8 与 Round 2 的 B1/I1-I3/S1-S3 已关闭；Round 3 为 0 blocking，并已补齐 existing open 的三步副作用边界、analyzer 零 scoring term 拒绝，以及已知重复 session 的披露条件。
- 当前阶段：实现与全量验证完成，等待 exact diff 的独立 review。
- 实现基线：大 Session staging 修复已作为 `8bf8c83` 提交；功能 worktree 必须保留该提交的全部行为，不得回退。
- 待 reviewer 重点检查：Usage/Activity 统计轴与去重披露是否仍有误导面、公共 cursor 对 UUID/snapshot/request/clock 的绑定是否充分、Search newest 全集计数是否 fail-closed、existing-state 读路径是否真正不创建/不 chmod、两阶段 Usage 聚合在 250k 上是否仍有退化路径。
