# Conversation Hierarchy 与本机 Dashboard 设计

状态：Proposed（rev1；2026-08-27）

日期：2026-08-27

适用范围：本机 Session 发现、Local Insights Fact V3、Deep Query、Delivery Trace、Team Memory 只读投影与本机 Dashboard；不改变云端 Share API、Viewer、`threadshare-history@v1` 或远端组织能力。

关联决策与设计：

- [ADR-0001：Local Insights 使用持久事务投影](adr/0001-local-insights-persistent-projection-architecture.md)
- [ADR-0003：Delivery Trace 是共享的 snapshot-bound evidence graph](adr/0003-insights-delivery-trace-evidence-graph.md)
- [ADR-0004：Conversation 是证据支持的 Session lineage graph](adr/0004-conversation-session-lineage-graph.md)
- [Session Source Adapter 扩展设计](session-source-adapter-design.md)
- [Local Insights Deep Query 设计](insights-deep-query-design.md)
- [Team Memory 提案](team-memory-proposal.md)

## 1. 决策摘要

本机 Dashboard 采用目标 UI 的信息架构和交互模型，但其数据事实由 Local Insights 持久投影提供，不在浏览器中临时拼装：

```text
Conversation
  -> Root Session
  -> Subagent / Fork / Resume Session
       -> Turn
            -> Event
                 -> Evidence
```

核心决策：

1. `Conversation` 成为 Fact V3 的一等聚合根，不再与单个 Provider Session 同义。
2. Session Source Adapter 提交有证据的 lineage claim；`ConversationGraph` 深 module 负责解析、校验、持久化和重算。
3. 子 Agent Session 从 `subagent-excluded` 改为可索引、可检查；默认历史效率指标继续只读 Primary Work，Delegated Work 单列。
4. Conversation 列表、Session 树、Turn 目录、Transcript、Process 和 Evidence Inspector 使用同一 committed snapshot。
5. Fact V2 不增加临时 hierarchy sidecar；本能力并入既定 Fact V3 shadow rebuild，一次完成 identity、排序和 lineage 迁移。

## 2. 产品命题

### 2.1 Visual thesis

安静、紧凑、偏工作台的本机分析界面：深色导航只负责定位，浅色主工作区负责阅读，绿色只表示选中或可执行状态。使用列、分隔线、表格和抽屉建立层级，不使用 Dashboard 卡片拼贴。

### 2.2 Content plan

第一屏直接展示可操作的数据面：同步状态、Conversation 列表、筛选和当前证据范围。顶层导航固定为：

```text
概览 / 对话记录 / 效率洞察 / 交付关联 / 经验资产
```

现有 Search 并入“对话记录”；Skills 和 Tools 并入“效率洞察”；Delivery 保留并升级为 Conversation-aware；Team Memory 首版只提供“经验资产”的只读状态和证据导航。

### 2.3 Interaction thesis

- 选择 Conversation、Session、Turn 或 Event 时，主工作区与 Evidence Inspector 使用同一 selection state 联动。
- Transcript 与 Process 是同一 Turn 的两个视图，不把 Tool payload 混入聊天气泡。
- 动效只用于 selection indicator、Inspector 出入和移动端 Turn rail 定位；遵守 `prefers-reduced-motion`，不使用装饰性动画。

## 3. 目标与非目标

### 3.1 目标

- 有证据地回答“一个用户工作上下文包含哪些主 Session、子 Agent Session、Turn 和 Event”。
- 让每个列表结论都能定位到 Session、Turn、Event 和 revision-bound Evidence。
- 在不改变旧指标含义的前提下，展示 delegation volume、子 Agent 失败恢复和交付贡献。
- 将 Delivery Trace 扩展为 `Intent -> Conversation -> Session -> Turn -> File -> Commit`。
- 让 Desktop、Tablet 和 Mobile 使用同一信息层级，不因响应式布局丢失证据或状态。

### 3.2 非目标

- 不提供组织成员、团队排名、工时、绩效分或工作量判断。
- 不通过标题、文本、时间接近、同一仓库或相同 cwd 推断 Conversation membership。
- 不把 inline subagent activity 自动提升为一个独立 Session。
- 不在浏览器读取 Provider 文件、扫描 Git 或解析 Team Memory state。
- 本阶段不接入 GitLab MR/CI、云端协作、多用户身份或可写 Memory promotion。

## 4. 领域模型与不变量

规范术语以仓库根目录 [CONTEXT.md](../CONTEXT.md) 为准。

### 4.1 基数

| 关系 | 基数 | 约束 |
|---|---:|---|
| Conversation : resolved Root Session | 1:1 | 没有可解析根时不是完整 Conversation |
| Conversation : Session | 1:N | 每个 resolved Session 同一 snapshot 只属于一个 Conversation |
| Session : parent Session | N:0..1 | 根没有 parent；其他 resolved Session 恰好一个 parent |
| Session : Turn | 1:N | Turn identity 不跨 Session |
| Turn : Event | 1:N | Event 可缺 Turn，但不能跨 Session |
| Session : composite source | 1:1 | 延续 Session Source Adapter 的 source-state/CAS 单位 |

### 4.2 不可混淆的维度

| 维度 | 值 | 含义 |
|---|---|---|
| `sessionRole` | `main | subagent | unknown` | 整个 Session 的执行角色 |
| `lineageRelation` | `root | spawned | forked | resumed` | Session 与 parent 的关系 |
| `originScope` | `main | subagent | unknown` | 单个 Event 或 capability use 的来源范围 |
| `eligibility` | `eligible | excluded | unknown` | source quality 与读取资格，不再编码执行角色 |
| `lineageState` | `resolved | orphan | contradictory` | Conversation membership 是否可成立 |

`originScope=subagent` 只说明一个 Event 记录了 delegation，不证明存在单独的 Subagent Session。`sessionRole=subagent` 也不意味着该 Session 的每个 Event 都来自子范围。

### 4.3 Conversation 完整性

Conversation 公开以下 coverage：

- `lineageComplete`：所有声明 parent 的成员均已解析，且不存在冲突或环；
- `sessionInventoryComplete`：本次 source inventory 没有权限、schema、budget 或 active-tail 缺口；
- `historyComplete`：成员 Session 的 History coverage 汇总；
- `deliveryCovered`：成员涉及的仓库证据是否可读；
- `memoryCovered`：是否存在可用于 Memory 的 qualified Evidence。

UI 不把 coverage 不完整渲染成“0 个子 Agent”“无失败”或“无交付”。未知与零必须分开。

## 5. 必须通过的领域场景

### 5.1 单 Session

一个 Codex 主 Session 没有 parent/child claim。它形成一个只含 Root Session 的 Conversation；现有 Turn、Event、Delivery 和 Memory 语义不变。

### 5.2 明确 spawn

Codex child Session 的 provider metadata 带有受 adapter 验证的 parent/root identity。父子 Session 分别索引，ConversationGraph 生成 recorded lineage；spawn Event 若可精确相关，则作为 edge Evidence。

### 5.3 结构化 Claude child

Claude `subagents/agent-*.jsonl` 只有在 adapter 能通过受验证目录结构绑定到一个 canonical parent Session 时才进入该 Conversation。目录名、文件名和 native Agent ID 不离开本机 source seam。

### 5.4 Inline-only delegation

主 Session 含 `sub_agent_activity` 或 `inter_agent_communication_metadata`，但没有独立 child source。它仍是一个 Session；delegation 进入 Event/Capability 统计，不生成虚构 child。

### 5.5 Orphan、冲突与重绑定

child 声明的 parent 尚未发现时进入 Orphan Sessions。后续 parent 出现可使其原子重绑定；两个同级 authority 的 parent claim 冲突、跨 source-instance claim 或成环 claim 均保持 orphan/contradictory，不择一猜测。

## 6. 架构与 module seam

```text
Provider files / database
          |
          v
SessionSourceAdapter implementations
          |
          +--> CanonicalSessionEvent@v1
          +--> private SourceLineageDescriptor
          |
          v
SessionSources deep module
          |
          +--> SessionFactsDeltaV3
          +--> SessionLineageClaimV1
          |
          v
ConversationGraph projection module
          |
          +--> conversations / session_lineage / conversation_rollups
          |
          v
ConversationWorkbench query module
          |
          +--> Agent Query / Recipe
          +--> local HTTP adapter
                    |
                    v
               Dashboard
```

### 6.1 `SessionSources`

`SessionSources` 继续拥有 discovery、read、sync、source snapshot、provider authority 和私有 native identity。它输出 Session 与 lineage claim，不输出已经聚合好的 Conversation；聚合规则不能散落到 adapter。

`DiscoveredSession` 增加内部字段：

```ts
type SourceLineageDescriptor = {
  sessionRole: "main" | "subagent" | "unknown";
  relation: "root" | "spawned" | "forked" | "resumed" | null;
  nativeParentRef: string | null; // private, adapter-owned
  nativeRootRef: string | null;   // private, adapter-owned
  authority: "provider-explicit" | "source-structure" | "none";
  proofDigest: string | null;
};
```

调用方不得读取 `nativeParentRef` 或 `nativeRootRef`。共享 projection 在 source snapshot 内把它们转换为 opaque key，再丢弃原文。

### 6.2 `ConversationGraph`

`ConversationGraph` 是 in-process + local-substitutable 的深 module。其 Interface 只接受规范化 claim，并返回投影结果：

```ts
interface ConversationGraph {
  project(input: SessionLineageDeltaV1): ConversationProjectionReceipt;
}
```

Interface 包含以下行为：key derivation、parent/root resolution、cycle detection、authority conflict、orphan preservation、affected Conversation rollup rebuild、purge/retraction 和 deterministic diagnostics。测试通过同一 Interface 使用内存 SQLite，不为内部 resolver 额外暴露 port。

删除该 module 后，复杂度会重新出现在每个 adapter、Deep Query、Delivery Trace、Memory 和 Dashboard，满足 deep module 的 deletion test。

### 6.3 `ConversationWorkbench`

`ConversationWorkbench` 隐藏 Deep Query、timeline、rollup 和 Evidence pointer 的组合：

```ts
interface ConversationWorkbench {
  list(request: ConversationListRequestV1): ConversationPageV1;
  read(request: ConversationReadRequestV1): ConversationWorkbenchV1;
}
```

`list` 只返回有界 summary；`read` 返回 Session tree、Turn directory、coverage 和 Evidence references，不内联无界 Transcript 或 Tool payload。完整内容继续通过现有 Evidence paging Interface 读取。

### 6.4 所有权

| 责任 | owner module |
|---|---|
| provider lineage extraction、native refs、proof | `src/session-sources/adapters/*` / Rust source reader profile |
| key projection、Fact V3 lineage DTO | `src/session-sources/projection.mjs` / Rust equivalent |
| graph validation、storage、rollup | `crates/insights-engine/src/conversation_graph.rs` |
| list/detail query 与 recipe | `crates/insights-engine/src/conversation_workbench.rs` |
| Node 白名单映射 | `src/insights-dashboard.mjs` |
| navigation、selection、responsive rendering | `src/insights-dashboard/` |

浏览器不拥有 membership、lineage authority、analytics universe、delivery attribution 或 Memory qualification。

## 7. Identity 与 lineage contract

### 7.1 Stable identity

在同一 origin secret epoch 下：

```text
nativeSessionRef = HMAC("native-session-ref", sourceAdapterId, sourceInstanceKey, nativeSessionId)
sessionKey       = HMAC("session", sourceKey)  // 由 Session Source Adapter 设计定义
conversationKey  = HMAC("conversation", rootSessionKey)
lineageEdgeKey   = HMAC("session-lineage", childSessionKey, parentSessionKey, relation)
lineageRevision  = SHA-256(canonical claim keys + authority + proof digest + source revision)
```

`nativeSessionRef` 只用于同一个 qualified source inventory 内解析 parent/root，不进入 public Query、Memory git 文件或 diagnostic。Orphan Session 没有 `conversationKey`，通过自己的 `sessionKey` 稳定引用。

### 7.2 `SessionLineageClaimV1`

```json
{
  "sessionKey": "64-hex",
  "sessionRole": "subagent",
  "relation": "spawned",
  "parentSessionKey": "64-hex-or-null",
  "rootSessionKey": "64-hex-or-null",
  "authority": "provider-explicit",
  "evidenceEventKey": "64-hex-or-null",
  "proofDigest": "64-hex",
  "lineageRevision": "64-hex"
}
```

约束：

- Root claim 使用 `relation=root`、`parentSessionKey=null`、`rootSessionKey=sessionKey`。
- 非 root resolved claim 必须同时有 parent/root，且 parent/root 属于同一 adapter 与 source instance。
- `evidenceEventKey` 可空；存在时必须属于 parent Session，且只作为 relationship Evidence。
- `proofDigest` 绑定 authority 所依赖的 provider fields/source structure 与 source revision，但不能反推出原始值。
- 同一 Session 同一 revision 只能有一个 canonical claim；冲突不能按数组顺序裁决。

### 7.3 Authority 与冲突

v1 authority 只有 `provider-explicit`、`source-structure` 和 `none`。不使用浮点 confidence，也不为标题/时间相似度预留 authority。

- provider 明确 parent/root 字段可产生 `provider-explicit`；
- adapter 文档化且通过 conformance fixture 的容器结构可产生 `source-structure`；
- 只有 `none` 时保留 Session，但 lineage state 是 orphan；
- 两个不同 parent 的 provider-explicit claim 是 contradictory，不以 source-structure 覆盖；
- child 指向自己、root 链不一致或图成环时，受影响 claim 全部 fail closed。

## 8. Fact V3 与持久投影

### 8.1 Session Fact

`SessionFactsDeltaV3.session` 增加：

```json
{
  "conversationKey": "64-hex-or-null",
  "sessionRole": "main",
  "lineageState": "resolved",
  "lineage": {
    "relation": "root",
    "parentSessionKey": null,
    "rootSessionKey": "64-hex",
    "authority": "provider-explicit",
    "evidenceEventKey": null,
    "proofDigest": "64-hex",
    "revision": "64-hex"
  }
}
```

`eligibility` 继续表示 source 是否可用于索引与分析。可完整读取的 Subagent Session 使用 `eligibility=eligible`；`sessionRole` 决定它是否进入 Primary Work。旧 `subagent-excluded` 只作为 V2 compatibility/coverage 值，不进入 V3 active schema。

SourceStateV2 增加 `lineageProofDigest` 和 `lineageInventoryRevision`。正文未变但 parent/root proof 改变时不能返回 `unchanged`；本次 source commit 至少更新 lineage claim 和受影响 rollup。

### 8.2 Storage

V3 candidate DB 新增：

```text
conversations
  conversation_key, root_session_key, observed_start, observed_end,
  lineage_revision, lineage_state, coverage_json

session_lineage
  child_session_id, parent_session_key, root_session_key,
  relation, authority, evidence_event_key, proof_digest,
  lineage_revision, resolution_state

conversation_rollups
  conversation_id, projection_version,
  session/turn/event/capability/error/recovery/delivery counts,
  primary/delegated partitions, coverage_json
```

`sessions` 增加 nullable `conversation_key` 和 `session_role` 索引列。`parent_session_key` 在 resolution 前可以指向尚未提交的 key，因此 claim 表不以 parent row FK 强制存在；Graph projection 负责在同一 transaction 内物化 resolved membership。

### 8.3 Transaction semantics

一个 Session commit：

1. 提交 Session/Turn/Event/Capability/History Facts；
2. upsert 该 Session 的 lineage claim；
3. 解析以该 Session 为 child、parent 或 root 的受影响 claims；
4. 重建受影响的旧/new Conversation membership 与 rollup；
5. 记录 projection changes 并推进 committed snapshot sequence。

任何一步失败整次 Session transaction 回滚。parent 后到达、parent purge、reparent 或 source revision 变化都走同一 projection Interface，不直接 patch rollup。

### 8.4 Rollup semantics

Conversation rollup 至少分区保存：

- Primary / Delegated Session、Turn、Event 数；
- Tool 与 Skill confirmed/inferred 数；
- failed、recovered、unrecovered attempt chain 数；
- file activity、Direct/Observed/Gap delivery 数；
- token metrics 与缺失 coverage；
- Memory candidate、approved entry 和 synthesis 引用数。

没有 coverage 的维度返回 unknown/coverage gap，不以零填充。

## 9. Query 与本地 HTTP mapping

### 9.1 Deep Query

Fact V3 发布一个新的 Query contract revision，不原地扩展当前 `threadshare-insights-query-request@v2` 的 resource enum。新增：

- resource `conversation`；
- Session fields：`conversationKey`、`sessionRole`、`lineageState`、`lineage.relation`、`lineage.parentSessionKey`、`lineage.rootSessionKey`；
- Conversation fields：span、project/source dimensions、primary/delegated rollups、delivery、coverage；
- stable order：`conversation.endedAt desc, conversationKey asc`；
- predicates 不允许 native ID、path、raw parent ref 或 provider payload。

已有 `session`、`turn`、`event`、`capability-use`、`file-activity`、`delivery-edge` 资源保留；V3 compatibility reader 只服务迁移期间的 V2 active DB。

### 9.2 `conversation-workbench@1`

Recipe 请求绑定 `conversationKey`，可选 selected Session/Turn 与 bounded page size。响应：

```json
{
  "conversation": {},
  "sessions": [],
  "turns": [],
  "selection": {},
  "coverage": {},
  "evidence": [],
  "next": {
    "sessions": null,
    "turns": null
  }
}
```

约束：

- 不内联完整 Transcript、Tool input/output、analysis 或 diff；
- Session tree 按 lineage depth、observed start、session key 稳定排序；
- Turn 复用现有 Session 内 source order；
- 每个显示结论携带 revision 或 Evidence pointer；
- response、cursor 和 continuation 都绑定 database UUID、snapshot sequence、request digest 与 evaluation clock。

### 9.3 Dashboard mapping

本地 Dashboard server 增加两个窄映射：Conversation list 与 Conversation workbench。Timeline、Evidence、Git diff 和 continuation 复用已有 Inspector Interface。HTTP adapter 只做 exact-key validation、请求上限和稳定错误映射，不重复 Engine 查询规则。

## 10. Dashboard 信息架构

### 10.1 对话记录

每行一个 Conversation，列固定为：

| 列 | 内容 |
|---|---|
| 最近活动 | observed end、record span、active/incomplete 状态 |
| 工作主题 | bounded title/summary、project/repository context |
| Sessions | root、subagent、fork/resume、orphan/gap 数 |
| Turns | human/agent/automation initiator 与 Primary/Delegated 分区 |
| 执行 | Tool、Skill、failure、recovery 数与 coverage |
| 交付 | Direct、Observed、Gap 与 repository availability |

“记录跨度”只表达首末观察时间，不渲染成工时。

### 10.2 Conversation detail

顶部提供 Session selector 和 coverage/status。主视图 tabs：

```text
对话正文 | 执行轨迹 | 代码与交付 | 关联洞察
```

Desktop 三栏：

```text
Turn directory | Transcript / Process workspace | Evidence Inspector
```

- Turn directory 显示编号、initiator、observed time、Open/Complete/Incomplete 与 anchor；
- Transcript 只显示 visible user/assistant content；
- Process 按 `turnKey + source order` 组合 invocation/result、file activity、failure/recovery 和 child lineage；
- 重复 Tool group 可折叠，输入输出默认折叠并按 Evidence paging 加载；
- Inspector 显示当前对象的 facts、strength、limitations、revision 和 source coverage。

### 10.3 效率洞察

Tabs 调整为本机可证明的维度：

```text
活动概览 | 能力使用 | 风险与改进 | 交付结果 | 经验资产
```

不显示成员排名或效率分。规则必须明确，例如“5 天内观察到 3 个 projectKey”而不是“上下文切换过多”。每个异常、风险或建议都能打开同一个 Evidence Inspector。

### 10.4 交付关联

Delivery Trace 增加 recorded `conversation-contains-session` 和 lineage navigation，但不改变 Direct/Observed/Candidate/Contextual 的强度规则。三条主 lane 仍是 Why / Agent Work / Delivered；Agent Work 可在 Conversation、Session、Turn 三层缩放。

### 10.5 经验资产

首版只读展示：candidate、pending review、approved entry、scene/doctrine、Skill projection。每项显示 Evidence、coverage、版本和限制；Dashboard 不直接执行 approve、promote、consolidate 或文件写入。

### 10.6 Responsive

- Desktop `>= 1180px`：Turn / workspace / Inspector 三栏；
- Tablet `760–1179px`：Turn rail + workspace 两栏，Inspector 为右侧 drawer；
- Mobile `< 760px`：Session selector、横向 Turn rail、正文、底部 Evidence sheet 依次排列；
- 导航不得遮挡正文；长 key/title 使用安全换行或截断 + tooltip；
- 固定 rail、toolbar、counter 与 icon button 尺寸，selection/loading 不改变布局。

## 11. Analytics 语义

### 11.1 默认 universe

现有 solution recall、failure chain、tool path、activity shift 和 delivery outcome 的默认 universe 保持：

```text
eligibility = eligible
AND sessionRole = main
AND provider visibility = active
AND not purged
```

这保证 V2 与 V3 的 Primary Work 历史比较不因子 Agent 纳入索引而改变含义。

### 11.2 Delegated Work

Conversation-aware 视图额外返回：

- delegated Session/Turn/Event 数；
- delegated capability、failure/recovery 和 token 数；
- child delivery edge 与 evidence gap；
- inline delegation 与 persisted child Session 的分开计数；
- unresolved/orphan coverage。

UI 不把更多 delegation 解释成更高效率，也不把较少 delegation 解释成协作不足。

### 11.3 Deduplication

`forked`/`resumed` Session 可能携带复制历史。Conversation membership 不覆盖既有 duplicate group、provider visibility 和 rollback 规则；rollup 只统计 active canonical contribution，并单独返回 raw member count 与 deduped contribution count。

## 12. Privacy、安全与资源边界

- native Session/Agent/parent/root ID、绝对路径和 source member locator 不进入 public Query、Dashboard state、Memory 文件或 diagnostic；
- lineage key 使用 origin-secret 派生，origin epoch 变化按 V3 identity migration 处理；
- Dashboard 继续 same-origin、no CORS、no-store，不上传本机历史；
- 浏览器不能提交 SQL、任意 path、native ID、provider payload selector 或未绑定 snapshot 的 Evidence pointer；
- child Session 使用与 main Session 相同的 payload chunking、redaction、FTS 和 Evidence 上限；
- Conversation list 和 workbench 均有 page/item/byte/time budgets，超限返回 coverage/continuation，不静默截断；
- Memory write、Git mutation、Share publish 和任何网络访问不因打开 Dashboard 被触发。

## 13. V2 -> V3 migration

Hierarchy 并入 [Session Source Adapter 设计的 shadow rebuild](session-source-adapter-design.md#94-migration)：

1. V2 active DB 继续服务现有 Query；V3 candidate 从当前 raw Session sources 全量重建；
2. candidate 同时生成 V3 source identity、Session Facts、lineage graph、Conversation rollups、FTS、Delivery 与 Memory binding；
3. 以前跳过的 qualified subagent files 作为新 V3 Sessions 进入 candidate；无法安全读取的文件生成 migration diagnostic；
4. graph cycle/conflict、previously-included source 缺失、payload/rollup mismatch 或 inventory drift 均阻止激活；
5. validation、fsync 后原子交换；失败删除 candidate，V2 保持 active。

交换后 database UUID、cursor、V2 source/session/record key 和 Memory extraction binding 按既定 contract 失效。不得以“查询为空”表示旧 key；resolver 返回 migration-required/stale diagnostic。

## 14. 实现阶段与工期

本设计只要求 Codex/Claude vertical slice；pi/OpenCode 继续按 Session Source Adapter 自己的 Stage 推进。

| Stage | 工期 | 交付物 | 退出门 |
|---|---:|---|---|
| H0 Contract | 2–3 工程日 | glossary、ADR、lineage schema、fixtures、V2 baseline | 五类领域场景与旧指标 golden 冻结 |
| H1 Projection | 8–12 工程日 | Codex/Claude child discovery、Fact V3、ConversationGraph、shadow rebuild | clean/incremental 等价；orphan/cycle/purge 正确 |
| H2 Workbench | 5–8 工程日 | Query resource、recipe、HTTP mapping、三栏 Dashboard、responsive | snapshot/evidence/keyboard/mobile 验收通过 |
| H3 Memory/Release | 4–6 工程日 | 经验资产只读、binding migration、性能与 release evidence | 完整 verification、25k evidence、installed smoke 通过 |

单工程师合计 19–29 工程日。若 Fact V3/SessionSources H0 基础已由其他工作完成，可按共享完成门扣除，不以并行重复实现换取表面进度。

## 15. 测试与验收

### 15.1 Contract cases

| Case | Fixture | 必须证明 |
|---|---|---|
| `CONV-001` | main-only Codex | 单 Session Conversation 与 V2 可观察结果等价 |
| `CONV-002` | Codex explicit spawn + child file | parent/root、spawn Evidence、Session tree 正确 |
| `CONV-003` | Claude main + qualified subagents directory | source-structure authority 不泄露 path/native ID |
| `CONV-004` | inline delegation without child | 不生成虚构 Session，不重复计数 |
| `CONV-005` | missing parent, conflict, self-loop, cycle | orphan/contradictory fail closed，排序确定 |
| `CONV-006` | parent appears/disappears/reparents | incremental 与 clean rebuild 逐字段等价 |
| `CONV-007` | fork/resume with copied history | membership 不绕过 dedupe/rollback |
| `CONV-008` | subagent delivery + repository unavailable | Primary/Delegated 与 covered/uncovered 分区正确 |

### 15.2 Interface tests

- Session Source Adapter conformance 测试 native metadata -> normalized claim，不断言内部 parser 分支；
- ConversationGraph 测试通过 `project()` Interface 观察 graph、diagnostic、rollup 和 snapshot，不直接测试 private resolver；
- ConversationWorkbench 测试 list/read 的 stable order、cursor binding、coverage 和 Evidence pointer；
- Dashboard state 测试 selection、loading/error、route、responsive drawer 与 stale snapshot；
- Delivery/Memory 测试 Conversation edge 不改变既有 strength、qualification 和 limitation。

### 15.3 Verification

实现阶段至少运行：

```bash
npm run test:cli
npm run test:viewer
npm run test:api
npm run test:release
npm run test:insights-engine
npm run build:cloudflare
npm run test:fc
npm run validate:skill
```

另需新增 Session Source/Conversation contract runner、Rust clean-vs-incremental golden、Dashboard Playwright desktop/tablet/mobile screenshot、keyboard navigation、canvas/DOM nonblank 和 25k formal evidence。当前 Dashboard 四资产、单资产 512 KiB 和 deterministic committed-output contract 保持不变；只有正式决定引入 source bundling 时才能另立构建决策。

新增 `conversation` resource、`conversation-workbench@1` recipe 和 Conversation-aware Delivery Trace 后，必须同步更新 `scripts/package-insights-deep-query-evidence.mjs`、`scripts/package-insights-delivery-trace-evidence.mjs` 的严格 allowlist、validator、formal report manifest 与 `docs/benchmarks/local-session-insights/verify-evidence.mjs`。不能只让 runtime tests 通过而留下 release evidence contract 漂移。

## 16. 风险与处置

| 风险 | 处置 |
|---|---|
| Provider parent metadata 漂移 | adapter version + qualified fixture；未知 schema 退为 orphan/diagnostic |
| 子 Agent 纳入导致指标跳变 | eligibility 与 sessionRole 分离；旧 recipes 保持 main-only golden |
| graph 在增量 sync 中短暂不完整 | 每次 Session transaction 内重算受影响图；coverage 显示 orphan/inventory state |
| lineage 变化导致旧导航失效 | Session key 稳定；Conversation membership revision/cursor stale 明确返回 |
| Dashboard 复杂度压入浏览器 | ConversationWorkbench 返回可展示 read model；浏览器不 join/infer |
| V3 migration 与 Memory binding 冲突 | candidate 全量重建；swap 前校验 Evidence/Memory refs；V2 active 可回滚 |

## 17. 拒绝的替代方案

### 17.1 用时间和标题聚类 Conversation

拒绝。它无法形成可审计 membership，平行任务、复制 prompt 和相同仓库会产生普通误合并。

### 17.2 只改 Dashboard，把 Session 当 Conversation row

拒绝。可以做视觉原型，但无法支持 Session selector、子 Agent谱系、跨 Session Turn 导航或 Agent Query parity。

### 17.3 在 Fact V2 增加独立 lineage JSON

拒绝。V2 identity 与 source position 已计划被 V3 替换；sidecar 会带来第二套 CAS、purge、cursor 和 migration 语义。

### 17.4 把所有子 Agent 活动当 child Session

拒绝。inline Event 与 persisted child 是不同事实，混用会重复消息、Tool、token 和 failure chain。

### 17.5 将 Subagent Session 直接加入主效率指标

拒绝。delegation volume 不是 root Agent 效率，且会改变现有历史比较的 universe。

### 17.6 为 UI 暴露通用图查询

拒绝。目标工作流只需要 Conversation list 与 workbench 两个深 Interface；任意图查询扩大攻击、测试和兼容面。

## 18. 完成定义

- `Conversation`、`Session`、`Turn`、`Event` 和 inline delegation 在 schema、代码、CLI、MCP、Dashboard 与文档中含义一致；
- Codex/Claude main、child、fork/resume、inline-only、orphan 和 conflict fixtures 全部通过；
- V3 candidate rebuild 可失败回滚，clean/incremental graph、rollup、Evidence 和 Memory binding 等价；
- Agent Query 与 Dashboard 在同一 snapshot 上返回相同 Conversation membership 和限制；
- Primary Work 历史结果与冻结 baseline 等价，Delegated Work 单列且 coverage 完整；
- Desktop/Tablet/Mobile 无重叠、无水平溢出、键盘可达，Transcript/Process/Inspector selection 同步；
- Dashboard 保持本机只读、no-store、same-origin、无隐式 source scan、Memory write 或网络访问；
- 完整 verification、release allowlist、installed-package smoke 和性能 evidence 通过。
