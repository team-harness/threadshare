# Local Insights Deep Query 设计

状态：Accepted；功能、契约、clean-install 与正式 evidence pipeline 已完成，正式 Fact V2 运行待 clean checkpoint  
日期：2026-08-12  
适用范围：本机 Threadshare Insights；不改变云端 share、Viewer 或 `threadshare-history@v1`

设计输入：

- [Threadshare 建议讨论](https://cloud-thread.team-harness.com/?id=72c296b6-58b4-4b07-bcbe-56a85b68f4a7)
- 现有 Agent Insights Query v1、Fact/Projection、retry correlation、atomic reindex 与大 Session streaming staging
- meta-cc 的原始事件检索、时间线、错误分析、文件读写序列和完整性建模

采纳建议中的 `dataSource/estimatedFields`、有界降级诊断、完整性状态、lifecycle-only Turn、compaction 独立事件、文件工作流信号与 Agent-native 查询入口。没有照搬任意 SQL/jq、位置型失败启发式或“一种分析一条命令”；这些能力由类型化 Query、可靠 attempt chain 与 Recipe 层承载。

实施状态（2026-08-12）：Stage 1–4 已完成；README、Skill、62-file release allowlist 与 tarball clean-install smoke 已通过。Stage 5 的非空 Fact V2 合成语料、固定 work budget、正式 runner、双层 fail-closed packager/verifier 与 800-Turn 真实 sidecar smoke 已完成；25k/250k 与至少 30% 本机真实 Session byte sample 必须从 clean checkpoint 运行并归档。历史 Fact V1 evidence 与仅携带空 history collection 的 V2 envelope smoke 均不得冒充该证据。

## 1. 决策摘要

本设计把 Insights 从“几个固定报表命令”提升为三层本地分析能力：

1. **完整本地事件库**：保留可查询的用户/助手消息、system/developer/analysis 内容、Tool 输入输出、命令、错误、文件路径、Skill 使用、token 统计与生命周期事件。
2. **一个类型化 Query 引擎**：所有记录检索、过滤、聚合、排序和分页使用同一请求模型；不为每个问题新增一条专用 CLI。
3. **一组有证据的 Recipe**：把高价值问题固化成可复核的结构化分析，例如 Tool/Skill 使用场景、重复失败、文件工作流、上下文切换和 token 热点。

CLI 与后续 MCP 适配器只调用同一 Query/Recipe 模块。已有 `overview`、`search`、`capabilities`、`usage`、`activity`、`evidence` v1 契约继续工作，并逐步改为深查询模块的兼容适配器。

本地 Insights **不做内容隐私裁剪**。查询可以返回原始消息和 Tool payload。边界改为：

- 数据与查询只在本机执行；
- 不自动上传、分享或遥测；
- `threadshare share` 和 Viewer 不得自动读取此原始事件库；
- 输出可能包含密钥、路径和私有内容，调用方应把它视为本机原始历史数据。

## 2. 为什么不是继续增加命令

meta-cc 证明了原始事件查询、时间线、错误链和文件序列具有直接价值；现有 Insights 则已经具备更强的 snapshot、一致性、dedupe、retry correlation、全文检索与容量约束。两者应组合，而不是互相替代。

直接增加 `bugs`、`timeline`、`files`、`tokens`、`tech-debt` 等命令会产生三个问题：

- 每个命令重新定义时间窗、分页、未知值和证据语义；
- Agent 无法组合新问题，只能等待产品增加新命令；
- 同一事实会在多个 SQL 路径中逐渐出现统计漂移。

因此，设计的稳定接口是 Query；Recipe 只是可版本化的命名查询与确定性派生，不拥有第二套事实语义。

## 3. 目标与非目标

### 3.1 目标

- Agent 能检索本机完整历史，而不是只看 problem/final excerpt。
- Agent 能按时间、项目、Provider、Session、Turn、事件类型、Tool/Skill、状态、文件和文本组合过滤。
- Agent 能做有界聚合，并追溯到原始事件和完整 payload。
- 查询结果明确区分 recorded、derived、estimated，且 unknown 不等于 zero/absent。
- 分页始终绑定 database generation、snapshot、request 和 evaluation clock，禁止混代。
- 大 Session、长 Tool 输出和大规模索引仍使用流式 staging 与有界响应内存。
- CLI 与 MCP 使用同一模块、同一 JSON Schema 和同一错误语义。

### 3.2 非目标

- 不在 CLI 内嵌 LLM，也不提供 `insights ask "..."`。
- 不开放任意 SQL、SQLite 文件路径或 provider JSONL 文件路径。
- v1 不提供任意 JSONPath、正则表达式或用户自定义聚合函数。
- 不扫描当前 workspace 源码来推断事实；文件分析只基于 Session 中实际观察到的 Tool 事件。
- 不把启发式信号包装成因果结论、质量分数或生产力评分。
- 不让云端 share、Viewer 或 API 自动访问完整本地 Insights 数据。

## 4. 核心使用场景

| 场景 | 需要的原语 | 推荐入口 |
|---|---|---|
| 哪个 Skill/Tool 最近用得最多，用在什么情况下 | capability-use 聚合、时间窗、代表 Turn/事件 | `recipe capability-contexts` |
| 哪些命令或 Tool 一直失败，后来有没有成功 | invocation/result correlation、input fingerprint、attempt chain | `recipe failure-chains` |
| 最近反复阅读很多文档但仍大量修改代码的任务有哪些 | file-activity、read/edit 序列、会话级估计 | `recipe file-workflow-signals` |
| 我在多个项目之间切换得多不多，主要发生在什么时候 | 按时间排序的 project/session 事件与 UTC bucket | `recipe activity-shifts` |
| 哪类工作消耗 token 最多，缓存命中如何 | token-usage 聚合、model/provider/project | `recipe token-hotspots` |
| 以前遇到相似错误时最后怎么解决 | error/text FTS、后续成功 attempt、完整 evidence | `recipe solution-recall` |
| 某个 Session 在 compaction、resume、rollback 前后发生了什么 | 完整 event timeline、lifecycle-only Turn | `query resource=event` |

Recipe 不生成自然语言答案。它返回统计、代表样本、证据键和完整性信息，由 Agent 形成回答。

## 5. 总体架构

```text
Codex / Claude local records
          |
          v
Provider adapters
  - normalized typed facts
  - unredacted semantic payload
  - completeness/provenance
          |
          v
SessionFactsDeltaV2
          |
          v
TEMP file staging -> one SQLite commit -> projections
          |
          +---------------------------+
          |                           |
          v                           v
LocalEventStore                  QueryProjections
  event metadata                  FTS / capability / file
  payload chunks                  token / error / retry
          |                           |
          +-------------+-------------+
                        v
                 LocalInsightsQuery
                 - records
                 - aggregates
                 - evidence
                 - recipes
                        |
              +---------+---------+
              v                   v
        CLI JSON adapter       MCP stdio adapter
```

`LocalInsightsQuery` 是深模块边界。Provider shape、SQLite 表、FTS 语法和 projection 实现不能泄漏到 CLI/MCP 契约。

## 6. 公共命令

### 6.1 新命令

```text
threadshare insights query --request <file|-> --format json
threadshare insights recipe <name> --request <file|-> --format json
threadshare insights evidence --request <file|-> --format json
threadshare insights mcp --stdio
```

- `query`：类型化记录查询或聚合查询。
- `recipe`：执行版本化的命名分析。
- `evidence`：读取 Turn、event 或 payload 的完整证据；保留现有 v1 shorthand。
- `mcp`：仅启动本机 stdio MCP server，不监听 TCP，不访问网络。

### 6.2 兼容命令

以下命令和 v1 response format 保持不变：

```text
threadshare insights overview
threadshare insights search
threadshare insights capabilities
threadshare insights usage
threadshare insights activity
threadshare insights evidence <turn-key> --revision <revision>
```

兼容适配器可以调用新 Query 模块，但不得改变字段、排序、计数全集、错误码或 cursor 语义。

### 6.3 公共格式

新增格式：

```text
threadshare-insights-query-request@v2
threadshare-insights-query@v2
threadshare-insights-recipe-request@v1
threadshare-insights-recipe@v1
threadshare-insights-evidence-request@v2
threadshare-insights-evidence@v2
```

每个格式都有随 npm 包发布的 JSON Schema，顶层与所有闭合对象均为 `additionalProperties:false`。所有可能超过 JS safe integer 的整数使用 canonical 十进制字符串。

## 7. Query 请求模型

### 7.1 顶层结构

```json
{
  "format": "threadshare-insights-query-request@v2",
  "resource": "event",
  "where": {
    "and": [
      { "field": "event.kind", "op": "in", "value": ["tool-invocation", "tool-result"] },
      { "field": "tool.canonicalName", "op": "eq", "value": "Bash" },
      { "field": "observedAt", "op": "gte", "value": "2026-08-01T00:00:00.000Z" }
    ]
  },
  "shape": {
    "kind": "records",
    "select": ["eventKey", "turnKey", "observedAt", "tool", "payloadRef"],
    "payloadMode": "reference"
  },
  "orderBy": [
    { "field": "observedAt", "direction": "desc" },
    { "field": "eventKey", "direction": "asc" }
  ],
  "limit": 50,
  "cursor": null,
  "count": "none"
}
```

请求最大 64 KiB；`limit` 为 1..50；完整 predicate AST 最大深度 8、最多 64 个叶子；`orderBy` 最多 4 项。每个 resource 有固定 field registry，非法字段、类型不匹配或不支持的 field/operator 组合直接返回 `TS_INSIGHTS_REQUEST_INVALID`。

### 7.2 Resource

| Resource | 说明 | 主要记录字段 |
|---|---|---|
| `session` | 已索引 Session 与 source 状态 | provider、project、scope、completeness、timestamps |
| `turn` | Turn 事实与 revision | problem、final answer、closure、outcome、token totals |
| `event` | 完整顺序事件流 | kind、role、text、tool、lifecycle、payloadRef |
| `capability-use` | Tool/Skill invocation 与结果 | capability、input、terminal state、duration、attempt chain |
| `file-activity` | Session 中观察到的文件操作 | raw/relative path、action、attempt/result、tool event |
| `token-usage` | Provider 报告的 token 事实 | model、input/cache/output/reasoning/total、coverage |
| `error-occurrence` | 原始错误与稳定派生 signature | exact text、exit/status、capability、attempt resolution |

一个请求只查询一个 resource。跨 resource 关系通过返回的 contract key 和 `evidence` 继续读取，不提供任意 join DSL。

### 7.3 通用过滤字段

所有 resource 共享以下字段中适用的子集：

- `provider`、`projectKey`、`sessionKey`、`turnKey`、`originScope`；
- `observedAt`、`session.startedAt`、`session.endedAt`；
- `completeness`、`sourceState`、`revision`；
- `text`，使用 `mixed-cjk-code` analyzer 做 FTS；
- `event.kind` 与 resource-specific typed fields。

时间范围统一为 canonical RFC3339 UTC 的 `[after,before)`。SQL 必须直接比较 canonical timestamp 列，不得用函数包裹索引列。

### 7.4 Predicate AST

组合节点：

```text
and | or | not
```

叶子操作符：

```text
eq | ne | in | not-in | exists
lt | lte | gt | gte | between
prefix | contains | match
```

- `match` 仅用于声明为 searchable 的文本字段，使用版本化 analyzer。
- `contains` 是大小写敏感的字面子串，不隐式正则化。
- `prefix` 主要用于路径和稳定枚举。
- v1 不支持 regex、脚本表达式、任意 JSONPath 或 SQL fragment。

### 7.5 Records shape

```json
{
  "kind": "records",
  "select": ["eventKey", "observedAt", "message.role", "message.content", "payload"],
  "payloadMode": "reference"
}
```

`select` 必须来自 resource field registry。`payloadMode`：

- `omit`：不返回 payload content；
- `reference`：返回 byte length、SHA-256、revision 与 evidence request；默认值；
- `inline`：在 page byte budget 内返回完整 content，否则仍返回 reference，绝不静默截断。

所有可能较大的原始内容字段都使用稳定的 `ContentValue`，包括 `message.content`、`tool.input`、`tool.output`、`error.content` 与完整 provider payload：

```json
{
  "byteLength": "1024",
  "sha256": "64-hex",
  "encoding": "utf-8",
  "inline": "unredacted content or null",
  "reference": null,
  "complete": true
}
```

`inline` 与 `reference` 恰有一个非 null。`reference` 是完整的 Evidence target，不是文件路径。这样同一字段不会因为内容大小从 string 变成 object，也不会把截断文本冒充全文。`payloadMode` 只控制完整 provider payload；显式选择 message/tool/error content 时仍返回 `ContentValue`，但 page budget 可以让它采用 reference 分支。

### 7.6 Aggregate shape

```json
{
  "kind": "aggregate",
  "groupBy": ["capability.kind", "capability.canonicalName"],
  "metrics": [
    { "name": "invocations", "op": "count" },
    { "name": "sessions", "op": "distinct-count", "field": "sessionKey" },
    { "name": "lastUsedAt", "op": "max", "field": "observedAt" }
  ]
}
```

约束：groupBy 最多 3 项，metrics 最多 8 项。支持：

```text
count | distinct-count | sum | min | max | average
```

每个 metric 的可用性由 resource registry 固定。禁止聚合 payload、任意 JSON 字段或 estimated 字段。聚合对完整 candidate set 计算；不能先取前 N 条记录再聚合。

### 7.7 排序、精确计数与拒绝

- 所有排序必须以稳定 contract key 作为最后 tie-break，形成全序。
- `count:"none"` 不计算总数；`count:"exact"` 返回精确 `totalMatchCount`。
- 对预计超过 query work budget 的 `exact` count、全文 newest 或高基数 group-by，Engine 必须先做 bounded probe，再返回 `TS_QUERY_TOO_BROAD`；不能返回抽样后冒充完整结果。
- aggregate 响应始终返回精确 candidate/group count，无法在预算内完成时整次拒绝。

## 8. Query 响应模型

```json
{
  "format": "threadshare-insights-query@v2",
  "snapshot": { "seq": "1842", "token": "opaque-mac" },
  "sourceFreshness": {
    "state": "not-evaluated",
    "lastCommittedAt": "2026-08-12T10:00:00.000Z"
  },
  "resource": "event",
  "records": [],
  "groups": null,
  "nextCursor": null,
  "totalMatchCount": null,
  "truncated": false,
  "coverage": {},
  "provenance": {},
  "limits": {
    "pageBytes": "3932160",
    "payloadsMayRequireEvidencePaging": true
  }
}
```

`records` 与 `groups` 恰有一个非 null。`sourceFreshness.state` 在 Query 中固定为 `not-evaluated`，因为查询不扫描 provider files。调用者若需要最新数据，先运行 `threadshare insights sync`。

### 8.1 Coverage

Coverage 至少包含：

- 匹配全集中 full/summary/unloaded/truncated/unavailable 的记录数；
- 缺 timestamp、revision、token 字段或 payload 的记录数；
- 因 exclusion/purge 不在可见全集的聚合计数；
- FTS searchable 与 stored-but-not-searchable 的字节/事件计数；
- `degraded` 与稳定 diagnostics。

任何 excluded/unknown/unavailable 计数非零时，Recipe 不得把结果表述为“所有历史”。

### 8.2 Provenance

每个可观察字段属于以下一类：

```text
recorded   Provider/source 中直接记录
derived    由确定性、版本化算法从 recorded facts 计算
estimated  由启发式规则估计，不能表述为事实或因果
```

响应使用紧凑的字段级声明：

```json
{
  "default": "recorded",
  "fields": [
    { "path": "records.*.errorSignature", "kind": "derived", "method": "error-signature@1" },
    { "path": "records.*.docVoid", "kind": "estimated", "method": "file-workflow-signals@1" }
  ]
}
```

所有 Recipe response 必须带 `provenance`；estimated 结果必须同时给出构成它的 recorded counts。

## 9. Evidence 与完整 payload

Query page 最大 3.75 MiB，Engine protocol frame 继续小于 4 MiB。完整 Tool 输出或 provider event 可能超过单页，因此使用 evidence 分页，不用截断字符串冒充全文。

Evidence request：

```json
{
  "format": "threadshare-insights-evidence-request@v2",
  "target": { "kind": "event", "eventKey": "...", "revision": "..." },
  "include": ["envelope", "payload"],
  "cursor": null,
  "maxBytes": 1048576
}
```

也支持 `target.kind=turn|session|attempt-chain`。响应：

- 返回目标 revision、payload SHA-256、总字节数、当前 `[start,end)`；
- `content` 是原始 UTF-8 内容；JSON payload 以 canonical JSON 字节表达；
- `nextCursor` 绑定 database UUID、snapshot、target、revision、byte offset；
- revision 或 generation 变化返回稳定 stale/changed 错误；
- 最后一页才返回 `complete:true`，调用方不能把中间页当完整 payload。

“原始”在此定义为**未裁剪的语义 payload**，不是 provider JSONL 原始行的空白、字段顺序或文件字节复刻。Provider adapter 仍可在 `providerPayload` 中保存未识别字段的 canonical JSON，以避免解析层丢失信息。

## 10. Recipe 契约

Recipe request 统一包含：

```json
{
  "format": "threadshare-insights-recipe-request@v1",
  "window": { "after": "...Z", "before": "...Z" },
  "comparisonWindow": null,
  "filters": {},
  "limit": 20,
  "allowDegraded": false
}
```

所有 Recipe 在一个 SQLite read transaction 中完成。默认 `allowDegraded:false`：当完成度不足以支持 Recipe 的结论时返回 `TS_INSIGHTS_COVERAGE_INCOMPLETE`；显式允许后返回结果，但 `coverage.degraded:true` 且列出缺失范围。

### 10.1 `capability-contexts@1`

回答 Tool/Skill 的使用量与使用场景：

- recorded invocation、failing invocation、distinct Turn/Session/dedupe group；
- grouped/ungrouped invocation 与 dedupe confidence；
- top projects、co-occurring capabilities、terminal state；
- 最多 5 个代表 Turn，返回完整 evidence key 和上下文消息；
- 不做无证据的自动主题聚类。

“最近用得最多”必须明确 metric，例如 recorded invocation 或 distinct dedupe group。null-group invocation 不得被当成独立使用，也不得被静默丢弃。

### 10.2 `failure-chains@1`

以 capability key、input fingerprint、correlation digest 和事件顺序构建 attempt chain：

- `resolved`：同一 chain 后续有 confirmed completed result；
- `never-succeeded`：可观察 chain 内没有成功；
- `abandoned`：Turn/session 结束前没有 terminal result；
- `unknown`：输入、correlation 或 completeness 不足。

不能采用“同 Tool 在后 3 次调用中成功就算解决”之类位置启发式。返回原始错误、命令、exit/status、后续 attempt 与证据。

### 10.3 `file-workflow-signals@1`

从 recorded file activity 计算会话级信号：

- read/edit/write/delete/move/search/list 的 attempted 与 confirmed 计数；
- implementation-like 与 document-like 文件的共现序列；
- `docVoid` 与 `specPrecisionGap` 作为 estimated 字段；
- 完整文件路径、Tool input/result 与事件证据。

初始启发式沿用参考建议并显式版本化：read/edit ratio >=3 为 research-heavy，<=0.8 且 edits>=5 为 implementation-heavy；`docVoid` 与 `specPrecisionGap` 必须返回构成判断的全部计数。该信号只描述观察到的工作流，不评价代码质量。

### 10.4 `activity-shifts@1`

返回 UTC 日/周 bucket：

- distinct sessions/turns/projects；
- 连续事件中 project 变化形成的 observed context switch；
- Tool/Skill invocations、token totals、closure/outcome；
- 可选 comparison window 的绝对 delta。

context switch 是事件顺序的 derived count，不等价于注意力损耗或生产力下降。

### 10.5 `token-hotspots@1`

按 provider/model/project 聚合 recorded token：input、cached input、output、reasoning、total。只有 Provider 直接记录 capability-scoped token 时才允许细分到 capability；当前 Codex/Claude 适配器返回 `capability:null` 与 `capabilityAttribution:"unavailable"`，禁止用同 Turn 共现关系冒充单次 Tool 的 token 归因。缺失字段保持 unknown，并返回各 metric 的 coverage denominator；禁止把缺失 token 当 0。

### 10.6 `solution-recall@1`

对问题文本、错误、命令和 Tool 输出做全文检索，返回相似历史 Turn、后续成功 attempt、final answer 与 evidence。它只返回“历史上随后观察到成功”的相关案例，不声称该步骤对当前问题一定有效。

### 10.7 `session-timeline@1`

按原始顺序返回消息、Tool、token、file、compaction、rollback、resume/fork 和 lifecycle 事件。生命周期事件即使没有可见消息也必须保留；compaction summary 作为独立事件，不能并入用户或助手正文。

## 11. MCP 适配器

`threadshare insights mcp --stdio` 只公开三个深工具：

```text
threadshare_insights_query
threadshare_insights_recipe
threadshare_insights_evidence
```

- input/output 直接使用同版本 JSON Schema；
- stdio stdout 只输出 JSON-RPC，日志与诊断写 stderr；
- MCP server 不持有第二套 query builder，不改写 Recipe 语义；
- 同一 reader 可复用 Engine client，但 timeout、abort、disconnect、fatal 后必须淘汰 client；
- MCP 不自动运行 sync/reindex，未就绪时返回可执行的 `threadshare insights sync` 指引。

这样 Agent 可以先聚合，再取代表证据，而不是一次把整个历史塞进上下文。

## 12. Fact V2 与本地存储

### 12.1 Event envelope

Provider adapter 为每个可观察事件输出：

```text
eventKey
sessionKey / turnKey?
sourceRecordKey
provider / projectKey / originScope
ordinal / observedAt?
kind / role? / terminalState?
completeness
revision
typed metadata
unredacted semantic payload
```

`eventKey` 由 provider、session key、source record identity、事件 ordinal 和 kind 的 canonical tuple 派生；`revision` 由 canonical envelope 与 payload digest 派生。事件内容改变时 revision 必须改变。

### 12.2 表边界

建议逻辑表：

| 表 | 责任 |
|---|---|
| `history_events` | 小而热的 event metadata、typed discriminator、revision |
| `history_payloads` | payload identity、总字节数、digest、encoding、completeness |
| `history_payload_chunks` | 按 ordinal 存储有界 payload chunk |
| `message_events` | role、text class、message-specific typed fields |
| `capability_uses_v2` | invocation/result correlation、input fingerprint、terminal state |
| `file_activity` | observed path、action、attempt/result 与 event relation |
| `token_usage` | nullable token dimensions 与 model/provider relation |
| `error_occurrences` | exact error、derived signature、attempt relation |
| `history_event_fts` | message/input/output/error/path 的完整 chunked FTS projection |
| `history_*_rollups` | event kind、Activity、token、coverage、capability context 与共现的精确增量聚合 |

物理实现可以合并低基数字段，但模块接口和 migration 必须按这些责任分层。热查询先选 event key，再按当前页 hydration payload；禁止在候选选择阶段读取大 payload。

`deep-query-coverage@2` 是首个包含上述 rollup 的内部 projection identity。每个 Session 的正式事实写入与 rollup 重建处于同一 SQLite transaction；任何一侧失败都不得提交。只在可证明与精确事件路径等价时读取 rollup：时间窗必须覆盖完整 UTC day，Activity 的 Session 时间范围不得交叠到可能改变全局排序；否则回退到有界的 typed event SQL。版本缺失或不匹配时，Query/Recipe 必须返回 `TS_INSIGHTS_QUERY_V2_NOT_READY`，由 candidate shadow rebuild 生成新库，禁止在旧 active DB 原地混写。

### 12.3 Payload chunking

- payload 按 UTF-8 边界切分，目标 chunk 64 KiB；
- 单个 Engine frame 仍受 4 MiB 限制；
- Session 总 logical payload 继续受明确上限约束，超过时 fail-closed，不落半个 Session；
- staging、digest、apply 和 projection 都流式执行，不把完整 Session 或全部 retraction key 载入内存；
- FTS 对每个 searchable chunk 建文档，查询后按 event key 去重。

压缩属于 `PayloadStore` 内部策略，不进入公共契约。无论是否压缩，evidence 返回的 digest 必须针对解码后的 canonical payload 字节。

### 12.4 Completeness

每个 source/session/turn/event 使用同一集合：

```text
full | summary | unloaded | truncated | unavailable
```

- `full`：该 adapter 声明的全部可查询字段已解析；
- `summary`：Provider 只提供摘要或 compaction 内容；
- `unloaded`：记录存在，但 payload 按 Provider 状态未加载；
- `truncated`：Provider 或输入明确截断；
- `unavailable`：损坏、超限或不支持的记录，保留诊断占位。

v1 迁移数据不能默认标记为 full；未重读 raw source 前应为 unavailable/summary，并由 Query coverage 显示。

## 13. Provider adapter 规则

Codex 与 Claude adapter 必须输出共同 event vocabulary，同时保留 provider-specific payload。统一规则：

- visible/system/developer/analysis 消息分别建 event，不合并角色；
- Tool invocation 与 result 分开，使用 correlation relation 连接；
- compaction、resume、fork、rollback、turn lifecycle 分开建 event；
- 无消息但有 lifecycle 的 Turn 仍进入 Fact；
- token 字段逐项 nullable，只有 Provider 明确给出时才 recorded；
- 文件操作从 Tool input 解析为 attempted action，从 result 解析 confirmed/failed/unknown；不访问文件系统验证；
- 无法识别的 provider event 仍保存 canonical provider payload，kind 为 `provider-unknown`。

共享 golden fixture 必须证明 Node adapter、Rust decode 与 SQLite round-trip 对相同输入产生一致 event keys、revision、payload digest 和 completeness。

## 14. Sync、reindex 与 migration

Fact V2 无法从现有 Fact V1 完整恢复，因为 v1 有意丢弃了原始 payload。升级必须重新读取本地 Provider Session。

迁移流程：

1. `threadshare insights sync` 检测 V2 缺失，创建 candidate DB 并执行全量 backfill；现有 V1 DB 在整个过程中继续服务兼容查询。
2. 进度按 discovered/planned/committed/unchanged/failed、当前 provider/session 和 canonical bytes 展示；TTY 使用单行更新，`--format jsonl` 输出稳定 progress events。
3. candidate 完整、验证与 fsync 后原子交换；失败保留 V1 active DB，不激活半成品。
4. 后续 `sync` 只处理 source metadata/digest 发生变化的 Session；后台 worker 使用同一路径。
5. exclusion、purge 与 reset 同时覆盖 metadata、payload chunks、FTS 和派生表；物理 purge 完成前不得声称 payload 已清除。

V2 query 在 migration 未完成时返回 `TS_INSIGHTS_QUERY_V2_NOT_READY`，并给出 `threadshare insights sync`。不能在 query 过程中隐式扫描 raw files。

## 15. Snapshot、Cursor 与并发

- 每个数据库生成不可变 `database_uuid`；atomic reindex 生成新 UUID。
- 每个 read request 在一个 SQLite read transaction/snapshot 内完成。
- cursor MAC 绑定 database UUID、snapshotSeq、去掉 cursor 后的 canonical request digest、完整排序 tuple 和 evaluation clock。
- evidence cursor 额外绑定 target/revision/byte offset。
- 任一绑定值漂移返回 `TS_INSIGHTS_CURSOR_STALE`；target revision 漂移返回 `TS_INSIGHTS_TURN_CHANGED`。
- closure/quiescence 等依赖 wall clock 的字段使用请求首屏冻结的 `evaluatedAt`，续页从 cursor 恢复。
- Engine client 的 timeout/abort/disconnect/fatal 会强制关闭 transport；迟到 frame 不得污染下一请求。

Query 只读取 committed Insights DB，不在请求开始时检查 raw source freshness。`sourceFreshness:not-evaluated` 是契约事实，不是警告文案。

## 16. Query planner 与有界性

### 16.1 规划顺序

```text
validate request
-> resolve resource field registry
-> compile typed predicates
-> choose indexed candidate query
-> bounded work probe
-> select stable keys/order tuple
-> hydrate current page
-> compute coverage/provenance
-> encode bounded response
```

大 payload、provider JSON 和 evidence 不参与 candidate selection。聚合先从 typed projection 计算，禁止逐 candidate N+1 查询。

### 16.2 初始索引候选

- `history_events(session_key, ordinal, event_key)`
- `history_events(observed_at, event_key)`
- `history_events(kind, observed_at, event_key)`
- `capability_uses_v2(capability_key, observed_at, terminal_state, event_key)`
- `file_activity(normalized_path, observed_at, event_key)`
- `token_usage(model, observed_at, event_key)`
- `error_occurrences(signature, observed_at, event_key)`

最终索引必须由 25k/250k EXPLAIN、延迟、RSS 与写放大证据决定；不能仅凭列表全部加入。

### 16.3 Work budget

Engine 对以下量设置独立上限：candidate rows、FTS matches、aggregate groups、DISTINCT working set、hydrated payload bytes 和响应 bytes。超过预算返回 `TS_QUERY_TOO_BROAD`，不得悄悄采样、截断聚合或把 approximate 当 exact。

## 17. Retry、错误与文件语义

### 17.1 Attempt chain

Attempt chain 优先使用 recorded correlation；缺失时只在 capability、input fingerprint、Turn 与顺序均满足版本化规则时 derived。无法建立可靠 chain 时为 unknown，不猜测成功/失败关系。

### 17.2 Error signature

`error-signature@1` 可以归一化不稳定数字、临时路径片段和 request id 以便聚合，但响应同时保留 exact recorded error。Agent 应引用 exact evidence；signature 只用于 grouping。

### 17.3 File identity

同时保存：

- Tool payload 中的 raw path；
- 基于 Session project root 的 lexical relative path（若可计算）；
- normalized path（只做 lexical normalization）；
- 是否 absolute、是否 project-relative。

不得 `realpath`、stat 或读取当前文件来改变历史事实。rename/move 保存 from/to 两端。文件 action 必须分 attempted 与 result-confirmed，不能把 invocation 等价为成功写入。

## 18. 本地数据边界

本设计没有内容裁剪保证。以下内容都可能出现在 Query/evidence stdout：

- 用户、助手、system、developer、analysis 文本；
- Tool 参数、Tool 输出、shell 命令、错误和环境片段；
- 绝对路径、项目名、文件内容与 Provider-specific payload；
- token、model、session/turn/event contract keys。

必须保留的系统边界：

- Insights state 目录 0700，文件 0600；Windows 使用 owner-only ACL；
- CLI/MCP 不监听网络，不发送 telemetry；
- `share`、`read`、Viewer 与云 API 不引用 LocalEventStore；
- 不提供把 Query response 自动 publish 的命令；用户显式重定向或复制输出属于本机调用行为；
- 诊断仍保持稳定、简洁，不把大 payload 或 SQL 自动写入 stderr。

这不是隐私裁剪，而是本地数据与云端分享能力的架构隔离。

## 19. 模块边界

### Rust

```text
fact_model_v2.rs       Event envelope、completeness、typed facts
fact_staging.rs        流式 TEMP staging 与 payload chunk ingest
event_repository.rs    LocalEventStore 事务写入/读取
query_model.rs         公共 typed request/response DTO
query_registry.rs      resource/field/operator registry
query_planner.rs       predicate 编译、work probe、stable ordering
query_executor.rs      records/aggregate execution 与 hydration
recipe.rs              Recipe registry 与公共执行边界
recipes/*.rs           每个版本化 Recipe 的窄实现
evidence.rs            Turn/event/payload paging
```

现有 `query.rs`、`agent_query.rs`、`evidence_path.rs` 和 `retry_projection.rs` 通过 adapter 复用；实现阶段可逐步拆分，不要求一次机械改名。

### Node

```text
insights-query.mjs          schema 校验、CLI DTO 与 error mapping
insights-query-reader.mjs   existing-state reader/client 生命周期
insights-recipes.mjs        recipe name/version registry
insights-mcp.mjs            stdio MCP adapter
```

Node 不实现统计逻辑，不解析 SQL，也不重新计算 Rust 返回的 metric。

## 20. 稳定错误

| Code | 含义 |
|---|---|
| `TS_INSIGHTS_NOT_INDEXED` | 没有可查询数据库或 snapshot 0 |
| `TS_INSIGHTS_QUERY_V2_NOT_READY` | V2 event store 尚未完成 migration |
| `TS_INSIGHTS_REQUEST_INVALID` | schema、field/operator 或跨字段组合错误 |
| `TS_QUERY_TOO_LONG` | query/request 文本超过上限 |
| `TS_QUERY_TOO_BROAD` | exact 查询无法在 work budget 内完成 |
| `TS_INSIGHTS_CURSOR_STALE` | generation/snapshot/request/clock 漂移 |
| `TS_INSIGHTS_TURN_CHANGED` | evidence revision 已变化 |
| `TS_INSIGHTS_COVERAGE_INCOMPLETE` | Recipe 要求 full coverage 但数据不足 |
| `TS_INSIGHTS_PAYLOAD_CHANGED` | payload revision/digest 在分页间变化 |

错误消息不包含 SQL 或巨大 payload；Query 成功结果可以包含未裁剪内容。

## 21. 性能与容量门槛

现有 ITEM-4/5 的 6 GiB Fact、8 GiB derived state、400 MiB FTS 证据只覆盖裁剪后的 Fact V1，**不能冒充 Fact V2 的容量证明**。

V2 必须重新建立正式证据：

- 25k 与 250k Turn 合成语料；
- 至少 30% 的本机真实 Session byte sample；
- 两个已知 >32 MiB Session 和单 Session 512 MiB logical payload 边界；
- synthetic 写入按每 Session commit ACK 报告 P50/P95/P99；真实 30% sample 的每 Session
  commit ACK 同样报告 P50/P95/P99；完整产品 `sync` 报告单次 wall time，不把一次正式运行
  伪装成延迟百分位；records、aggregate、recipe、evidence paging 报告 P50/P95/P99；
- sidecar RSS 继续以 128 MiB 为硬上限；
- 存储分别报告 event metadata、payload、FTS、projection、WAL/staging，禁止只给总量。

初始工程目标而非既成验收事实：

- records/aggregate 在 25k P95 <100 ms，250k P95 <200 ms、P99 <500 ms；
- 每个版本化 recipe 在 25k/250k 均须 P95 <500 ms、P99 <1,000 ms；任一 recipe
  超限即使返回非空结果也不能通过正式 evidence gate；
- evidence 首页 P95 <100 ms；
- payload paging 吞吐 >=50 MiB/s；
- persistent storage amplification 目标 <= canonical indexed source bytes 的 1.8 倍；
- FTS 目标 <= searchable UTF-8 bytes 的 0.7 倍。

最后两个比率必须经 prototype 与正式 evidence 冻结；达不到时先调整存储/索引设计，不能在报告中放宽门槛。

## 22. 测试与验收

### 22.1 契约

- Query/Recipe/Evidence 的 Node/Rust DTO 与 JSON Schema exact-key golden；
- 每个 resource 的 field/operator 正反例；
- CLI 单行 JSON、stderr 空；失败保持稳定 code + Problem/Usage/Next；
- npm tarball 中执行新命令并逐个编译 schema；MCP tools 使用同一 schema。

### 22.2 数据正确性

- Codex/Claude shared golden 覆盖消息角色、Tool payload、token、文件、error、compaction、resume/fork/rollback；
- payload round-trip digest 与 source adapter canonical bytes 完全一致；
- lifecycle-only Turn 不丢失，compaction 不混入正文；
- unknown、zero、absent、unavailable 的响应不同；
- incremental sync 与 clean rebuild 对 query records/order/aggregate/recipe digest 等价。

### 22.3 查询一致性

- 同 snapshot records/aggregate 精确对照直接 SQL oracle；
- cursor 绑定 UUID/snapshot/request/order/clock；atomic reindex 后旧 cursor 必须 stale；
- evidence revision/payload byte cursor 的 mutation test；
- timeout/abort/fatal 后下一种请求只能使用全新 client 或干净失败；
- exact work budget 只能返回完整或拒绝，不能返回 silent partial。

### 22.4 Recipe 杀伤力

- Capability 的 recorded/grouped/ungrouped/dedupe 口径；
- failure chain 的 resolved/never-succeeded/abandoned/unknown；
- file attempted 与 confirmed 不串线，docVoid/specPrecisionGap 显示 estimated；
- token 缺失不计 0；
- context switch 不使用因果/生产力措辞；
- solution recall 必须给 evidence，不把相似性写成确定解法。

### 22.5 迁移与恢复

- V1 active DB 在 V2 candidate build/crash/failure 时继续可用；
- swap 每个 crash window 都能恢复且清理旧 payload 副本；
- exclusion/purge canary 在 logical hide 与 physical purge 两阶段准确表述；
- staging 超限整 Session 回滚，无半写 payload/FTS/projection；
- sync progress 的 TTY 与 JSONL 事件计数可复核。

### 22.6 本地隔离

- CLI/MCP 测试禁止任何网络 socket；
- Query 不触发 share/API/Viewer 模块；
- state 权限不降级；
- Windows core-only 继续明确拒绝 Insights，直到 owner-only ACL adapter 单独批准。

## 23. 实现阶段

### Stage 1：Fact V2 与完整事件

先写 shared golden；实现 event envelope、payload chunks、completeness、Codex/Claude adapters、TEMP streaming 和原子 migration。此阶段不开放新公共命令。

### Stage 2：Query records 与 evidence

实现 field registry、typed predicates、stable order/cursor、records hydration、完整 payload paging；先以内部 protocol 测试，再开放 `insights query/evidence`。

### Stage 3：Aggregate 与 Recipe

实现有界 group/metrics、provenance/coverage 和首批 Recipe；用 differential oracle 与 25k/250k evidence 冻结语义和预算。

### Stage 4：MCP 与兼容适配器

加入 stdio MCP 三工具；让现有 v1 query commands 通过 adapter 复用深模块，并证明响应逐字节兼容。

### Stage 5：发布与本机验证

更新 README/README.zh-CN/Skill/help/schema/release allowlist；完成 clean-install CLI/MCP smoke、macOS/Linux Engine 包和 Windows core-only smoke，再按稳定发布流程发布。

每个 Stage 单独 checkpoint、独立 review；任何公开 schema 或 projection identity 变化都要求新版本和 shadow rebuild。

## 24. 明确拒绝的替代方案

### 24.1 任意 SQLite/SQL

虽然灵活，但会暴露物理 schema、绕过 work budget、破坏 migration 自由，并使 Agent 依赖 SQLite 实现细节。拒绝。

### 24.2 原始 JSON + jq 作为唯一接口

适合探索，不适合作为稳定 Agent 契约：Provider shape 分叉、统计口径不统一、无法保证 snapshot/cursor。完整 provider payload 仍可通过 evidence 取得，稳定查询走 typed registry。

### 24.3 每个分析一个 CLI 命令

会形成宽而浅的 API，并重复实现过滤、分页和完整性。拒绝；使用 Query + versioned Recipe。

### 24.4 在查询时读取 raw Session

会造成慢查询、source race 和不可复核分页。拒绝；先 `sync`，查询只读 committed snapshot。

### 24.5 继续沿用 Fact V1 的裁剪 payload

无法回答 Tool 输入输出、错误详情、文件工作流、token 与完整 timeline。拒绝；Fact V2 重新 backfill。

## 25. 已冻结的设计决定

- Insights 本地输出不做内容隐私裁剪。
- Query 是稳定原语，Recipe 是同一引擎上的版本化派生。
- v1 不开放 SQL、regex、JSONPath 或自定义函数。
- 原始大 payload 通过 reference + evidence byte paging 返回，不静默截断。
- recorded/derived/estimated 与 completeness 是公共契约，不是文档备注。
- compaction/lifecycle 单独建模，unknown 不等于 absent。
- query 不自动 sync，source freshness 固定如实声明 not-evaluated。
- MCP 只提供 query/recipe/evidence 三个工具，不复制业务逻辑。
- Fact V2 通过 candidate shadow rebuild 迁移，不能与 V1 原地混写。
- 既有 v1 CLI/JSON 契约和云端 Threadshare 分享边界保持不变。

## 26. 实现前确认点

Owner 确认本设计后，实施计划只需再冻结两个工程参数，不改变产品语义：

1. PayloadStore 的物理压缩策略与 chunk size，以 prototype 的存储放大/吞吐结果选择。
2. 250k 正式 benchmark 的 exact work-budget 数值，以真实 query plan 和 128 MiB RSS 硬门槛确定。

除此之外，命令、资源、Query AST、Recipe、完整性、证据、迁移与 MCP 边界视为已定设计；实现中如需改名或改变语义，必须先修订本文并重新 review。
