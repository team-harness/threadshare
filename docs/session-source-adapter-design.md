# Session Source Adapter 扩展设计

状态：Proposed（rev2.2；2026-08-27）

日期：2026-08-27

适用范围：本机 Session 发现与导出、Local Insights ingestion、Team Memory source selection、CLI/MCP 能力发现；不改变云端 Share API、Viewer、Memory Runner 或 Skill 投影格式。

本版已采纳独立 Opus 5 评审的裁决：OpenCode 读取采用 Engine-native 单一 source-sync seam；一个逻辑 Session 只有一个 composite ingestion source；V3 保留现有三元排序语义；pi 在 V2 期间只做 Session/Share 试点，不进入 Insights/Memory。rev2.2 同时冻结 `Conversation` 与 `Session` 的分层：本设计只负责 Session source，跨 Session 的 Conversation hierarchy 由独立设计和 ADR-0004 拥有。

rev2 落点：

- B1：Engine-native discovery/sync/read 分为 bounded source-reader、`InSourceSync` 和独立 `--source-read` 三条明确路径，禁止在 `InSession` 交错读库；
- B2：写死 logical Session/composite source/member 的基数、唯一键和 DB/legacy JSON 合并证明；
- B3：保留 `recordOrdinal`/`contentIndex`/`eventOrdinal` 三元排序，规定 WireU64 编码、`-1` sentinel、索引重建和 replace-session 条件；
- B4：pi 在 V2 只做 Session/Share，V3 使用 protocol@v2，旧 Engine 不猜测兼容；
- I1–I5：补齐 receipt/descriptor、稳定 record identity、exact probe、动态 Memory source selection 和 config v1→v2 迁移；
- E：为 v1 遗留的半完成 promotion journal 回填阶段，明确 `legacy_write_only` 的 fail-closed 漂移处置；
- rev2.1-R1：`memory recall` 与 batch `memory extract` 共用 v2 source-selection contract，v1 只在兼容入口归一化；
- rev2.1-R2：M0–M5 与 Stage 0–5 一一映射，补齐每阶段的前置条件、交付物和回滚点；
- rev2.1-R3：§17 改为带 case ID、fixture、命令、通过条件和证据产物的验收表，并加入真实 Codex/Claude CLI E2E 门。
- rev2.2-H1：外部深 module 与 DTO 从 `Conversation*` 统一改为 `Session*`；Provider 所称 conversation/thread/run 在 canonical source contract 中都是 Session；
- rev2.2-H2：`DiscoveredSession` 增加 private lineage descriptor，source revision 绑定 lineage proof；Fact V3 的 Conversation 聚合、graph 和 Dashboard 由关联设计拥有。

关联决策与设计：

- [ADR-0001：Local Insights 使用持久事务投影](./adr/0001-local-insights-persistent-projection-architecture.md)
- [ADR-0002：Insights 性能演进由证据门控](./adr/0002-evidence-gated-insights-performance-evolution.md)
- [ADR-0004：Conversation 是证据支持的 Session lineage graph](./adr/0004-conversation-session-lineage-graph.md)
- [Conversation Hierarchy 与本机 Dashboard 设计](./conversation-hierarchy-dashboard-design.md)
- [Local Insights Deep Query 设计](./insights-deep-query-design.md)
- [Team Memory 提案](./team-memory-proposal.md)
- [Agent-native Team Memory 设计](./team-memory-interactive-design.md)

## 1. 决策摘要

Threadshare 采用一个内建、版本化的 **Session Source Adapter registry**，逐步支持 Codex、Claude Code 之外的 Agent 会话来源。

```text
Agent files / database
          |
          v
Source storage reader
append JSONL / replace JSON / read-only SQLite snapshot
          |
          +--> node-stream adapter (JSONL/JSON)
          |       -> CanonicalSessionEvent@v1
          |       -> shared compatibility/V3 projection
          |
          +--> engine-native adapter (SQLite)
                  -> Engine source-sync state
                  -> Rust reader + semantic mapping + V3 projection
                                      |
                                      v
                    Session / History / Insights / Memory
```

核心决策：

1. 借鉴 ccusage 的“每个 Agent 一个 adapter、公共层统一处理”的组织方式；不照搬其每个命令和统一 loader 手工枚举 Agent 的接线方式。
2. Adapter 遵守同一个 provider-neutral 语义事件契约；迁移期允许 Node 与 Rust 有两个实现，但必须用同一组 golden 做差分验证，不能让下游各自解析原始记录。
3. 来源存储按 `append-log | replace-document | database-snapshot` 建模；不能继续把所有来源伪装成 UUID 命名的 JSONL 文件。
4. “能发现/能统计 token”不等于“能用于 Team Memory”。静态能力声明与每次读取的实际 coverage 共同决定 Share、Insights 和 Memory 准入。
5. v1 只接收随 Threadshare 发布的内建 adapter，不加载第三方运行时插件。pi-agent 先做不触碰 Engine 契约的 Session/Share 试点；OpenCode 用 Engine-native source-sync 作为第一个 SQLite 公开候选。
6. Stage 0/1 先验证 registry 和兼容投影；Fact V3、source-state v2 与 OpenCode 不再被伪装成可以在现有 V2 上提前完成的工作。

## 2. 背景与 ccusage 参考

ccusage 在固定源码版本 `130a5181b69c08d9e7cfba66d4075c88a9a78c9d` 中采用“一种 Agent 来源一个 Rust crate”的结构。每个 adapter 负责路径发现、记录解析、模型/token 映射和 source-specific metadata，common crate 负责文件遍历、去重、聚合和报告。参考：

- [ccusage adapter architecture](https://github.com/ccusage/ccusage/blob/130a5181b69c08d9e7cfba66d4075c88a9a78c9d/rust/adapters/README.md)
- [ccusage agent source workflow](https://github.com/ccusage/ccusage/blob/130a5181b69c08d9e7cfba66d4075c88a9a78c9d/.agents/skills/agent-sources/SKILL.md)
- [ccusage OpenCode adapter](https://github.com/ccusage/ccusage/blob/130a5181b69c08d9e7cfba66d4075c88a9a78c9d/rust/adapters/opencode/README.md)
- [ccusage pi-agent adapter](https://github.com/ccusage/ccusage/blob/130a5181b69c08d9e7cfba66d4075c88a9a78c9d/rust/adapters/pi/README.md)

Threadshare 采纳：

- provider-specific discovery、schema drift 和记录语义留在各自 adapter；
- 公共文件读取、排序、去重、错误映射和测试规范集中维护；
- 每个 adapter 必须有合成 fixture、真实数据 smoke 和独立文档；
- SQLite 与 legacy file 并存时由 adapter 决定优先级和去重，调用方不猜。

Threadshare 不采纳：

- 查询时重新扫描全部原始日志；这违反 ADR-0001 的 snapshot、revision 和稳定 Evidence 约束；
- 为每个 Agent 新增一个顶层报告命令；Threadshare 的 Query、Share 和 Memory 是共享消费面；
- 把 usage adapter 自动宣传成完整聊天支持；token/session aggregate 不能证明消息、Tool、Turn 和生命周期完整；
- 在 CLI enum、loader、文档和 unified report 中分别维护支持列表；唯一真相源必须是 registry。

## 3. 目标与非目标

### 3.1 目标

- 新增一个 file-based Agent 时，provider-specific 改动集中在一个 adapter 目录和一组 fixture；CLI、MCP、Insights 与 Memory 不再分别加分支。
- 同一份规范化事件生成 `threadshare-history@v1` 与 Insights Fact，消除 Share exporter 和 Insights parser 漂移。
- 同时支持 append-only JSONL、整体改写 JSON 和只读 SQLite snapshot，并保持增量同步与 clean rebuild 等价。
- 每个来源公开准确的 capabilities、runtime coverage、平台限制和 Memory eligibility，不静默降级。
- Agent 能通过 CLI 或 MCP 查询“安装了什么、检测到什么、哪些能力可用”，用户不需要记 provider 参数。
- 保持 Insights 查询只读持久化投影；新增来源不能建立第二条 scan-on-query 数据面。

### 3.2 非目标

- v1 不提供任意第三方插件加载、远程 adapter 下载或 adapter marketplace。
- 不调用 Agent 自己的 CLI/API 导出历史；事实源仍是用户机器上已经持久化的本地记录。
- 不为 usage-only 来源伪造 Turn、Tool correlation、hard-sealed 或完整正文。
- 不把 session source、batch runner、Skill projection target 合成一个 `provider` 概念。
- 不在本设计中新增云端同步、跨仓 Memory 或 Share 服务端格式。
- 不承诺一次性追平 ccusage 的 Agent 数量；每个来源按证据级别逐个晋升。

## 4. 术语与不可混淆的三个维度

仓库级术语以根目录 `CONTEXT.md` 为准。本设计中的 source object 始终是一个 Session；只有 [Conversation Hierarchy 设计](./conversation-hierarchy-dashboard-design.md) 可以把多个有 lineage evidence 的 Sessions 聚合为 Conversation。

| 名称 | 含义 | 示例 |
|---|---|---|
| `sourceAdapterId` | 原始会话来源的解析器 | `codex`、`claude`、`pi`、`opencode` |
| `sourceAdapterVersion` | 影响事实输出的 adapter 契约版本 | `opencode@1` |
| `runnerProfileId` | 可选 batch 提取使用的模型 CLI profile | `codex-cli`、`claude-cli` |
| `projectionTargetId` | 将 agent-neutral Memory/Skill 投影到哪个宿主 | `codex`、`claude` |
| `nativeSessionId` | 来源自身的 Session 标识；本机敏感 | UUID、路径内 slug、数据库主键 |
| `sessionKey` | Insights 内 HMAC 后的逻辑会话键 | 64 hex |
| `sourceKey` | 一个物理/逻辑 ingestion source 的 HMAC 键 | 64 hex |
| `sourceInstanceKey` | 一个安装根目录或数据库实例的 HMAC 键 | 64 hex |

硬约束：

- 新增 `opencode` source adapter 不要求存在 OpenCode runner，也不要求生成 OpenCode Skill 投影。
- `--runner` 继续只选择 batch runner；`memory assemble` 选择 projection target；Insights/Memory 筛选选择 source adapter。
- public query 中现有 `provider` 维度在兼容期仍表示 `sourceAdapterId`，但新源码变量和协议不得复用它表示 runner/model provider。

## 5. 当前实现的结构性限制

| 位置 | 当前假设 | 扩展影响 |
|---|---|---|
| `src/session-files.mjs` | 只有 Codex/Claude、递归 JSONL、UUID 文件名 | JSON、SQLite、非 UUID Session 无法发现 |
| `src/provider-evidence.mjs` | discovery、authority、parser、projection 混在单文件 | 每加一个 Agent 都扩大条件分支和回归面 |
| `src/session-export.mjs` | Codex/Claude exporter 单独解析原始 JSONL | 与 Insights 的可见性、Tool 结果和去重规则可能漂移 |
| `src/session-listing.mjs` | 再次实现 provider-specific metadata 扫描 | 第三套 parser/summary 规则 |
| `src/insights-indexer.mjs` | source 是文件 metadata + byte offset/fingerprint | replace JSON 和 SQLite snapshot 无法诚实表达 |
| `src/insights-command.mjs` | discovery/watch/reindex 枚举两个 provider | CLI 支持列表散落 |
| `src/insights-engine-protocol.mjs` | adapter version 与 source state 固定文件语义 | 每个新来源需要手改握手，数据库来源无 checkpoint 表达 |
| `schema/session-facts-delta.v2.schema.json` | adapter enum 两项、record/turn 使用 byte offset | 非字节流来源只能伪造 offset |
| `schema/threadshare-memory-extraction-request.v1.schema.json` | provider enum 与 `maxItems: 2` | Memory 不能选择新来源 |
| `src/memory-command.mjs` | source、runner、projection 多处都叫 provider | Agent 和维护者容易把三种能力错误绑定 |

现有 `getProviderEvidenceAdapter()` 只是把同一 monolith 包一层 `readDelta()`，并没有把 discovery、记录 authority 和投影从调用方隐藏起来。删除这层后复杂度几乎不变，因此它尚未形成有深度的 module。

## 6. 目标模块

### 6.1 外部 seam：`SessionSources`

Session CLI、Share 和 Insights 只依赖一个深 module：

```ts
interface SessionSources {
  capabilities(request?: CapabilityRequest): Promise<SourceCapabilityReport>;
  list(request: SessionListRequest): Promise<SessionPage>;
  read(
    request: SessionReadRequest & { execution: "node-stream" },
    consumer: SessionConsumer,
  ): Promise<SessionReadReceipt>;
  read(
    request: SessionReadRequest & { execution: "engine-native" },
  ): Promise<SessionReadReceipt>;
  sync(
    request: SessionSyncRequest & { execution: "node-stream" },
    consumer: SessionConsumer,
  ): Promise<SessionSyncReceipt>;
  sync(
    request: SessionSyncRequest & { execution: "engine-native" },
  ): Promise<SessionSyncReceipt>;
}

interface SessionConsumer {
  begin(session: DiscoveredSession): Promise<void>;
  accept(event: CanonicalSessionEventV1): Promise<void>;
  commit(receipt: SessionReadReceipt): Promise<void>;
  abort(problem: SourceReadProblem): Promise<void>;
}

type DiscoveredSession = {
  sourceAdapterId: string;
  sourceInstanceKey: string;
  sourceKey: string;
  sessionKey: string;
  nativeSessionId: string; // internal only; never leaves the local state boundary
  members: SourceMember[];       // DB/JSON members of one composite source
  lineage: SourceLineageDescriptor;
  probe: SourceProbe;
  capabilityCeiling: CapabilityVector;
};

type SessionReadReceipt = {
  applyMode: "append" | "replace-session";
  sourceRevision: string; // canonical digest, 64 lowercase hex
  lineageProofDigest: string | null;
  sourceSnapshotStable: boolean;
  atSourceEnd: boolean;
  checkpoint: { format: string; digest: string; payload: object }; // canonical JSON <= 256 KiB
  coverage: Record<string, number>;
  diagnostics: Array<{ code: string; count: number }>;
  eventCount: string;
  canonicalBytes: string;
  projection: {
    format: "threadshare-history@v1";
    digest: string;
    bytes: string; // UTF-8 portable history, <= 5 MiB
  } | null;
};

type SessionSyncReceipt = SessionReadReceipt & {
  committed: boolean;
  databaseUuid: string | null;
  snapshotSeq: string | null;
};

type SessionReadRequest = {
  sourceKey: string;
  sessionKey: string;
  selection: { after?: string; before?: string; maxEvents: number };
  expectedSourceRevision?: string; // lowercase hex digest when present
};

type SessionSyncRequest = {
  sourceAdapterIds?: string[];
  worktreeRoot: string; // resolved against the local registration, never a raw remote path
  maxSessions: number;
  dryRun?: boolean;
};

type SourceCapabilityReport = {
  sessionSourceRegistryRevision: string;
  sources: Array<{
    sourceAdapterId: string;
    registered: boolean;
    runtimeAvailable: boolean;
    detected: boolean;
    capabilities: CapabilityVector;
    diagnostics: Array<{ code: string; count: number }>;
  }>;
};

type SessionPage = {
  items: SessionSummary[];
  nextCursor: string | null; // opaque cursor bound to registry/source snapshot
  snapshotDigest: string;
};

type SessionSummary = {
  sourceAdapterId: string;
  sourceKey: string;
  sessionKey: string;
  title: string | null;
  observedStart: string | null;
  observedEnd: string | null;
  sourceRevision: string | null;
  lineageAvailability: "claimed" | "none" | "unknown";
  capabilities: CapabilityVector;
};
```

请求约束也属于接口：`sourceAdapterIds` 最多 16 个、`maxSessions` 最多 256、`selection.maxEvents` 最多 100,000；所有十进制计数使用 canonical `WireU64`。`list` 按 `(sourceAdapterId, sourceInstanceKey, nativeSessionId)` 的 UTF-8 byte order 排序，cursor 是绑定 registry/source snapshot 的 opaque tuple，不能使用无快照 offset；cursor snapshot 不匹配时返回 `TS_SOURCE_CHANGED`（diagnostic=`cursor-stale`），不跳过或重置到第一页；超限在读取前返回 `TS_SOURCE_REQUEST_TOO_LARGE`，不能靠截断继续执行。

接口语义：

- `capabilities`：返回 registry 声明、当前平台 runtime 和本机 detection，不读取聊天正文；
- `list`：有界列出 Session metadata/preview，不返回 Tool payload；
- `read`：读取一个精确解析的 Session，用于 Share/ranged export；
- `sync`：发现并读取变更来源，用于 Insights ingestion；不会执行 Query；
- `node-stream` 的正文通过 `SessionConsumer` 流式传递，module 不返回无界 Session 数组；`engine-native` 的正文只在 Rust source reader 与 projection 内流动，Node 只收到有界 metadata、progress 或 portable projection；
- `read` 与 `sync` 使用同一个 adapter 语义契约；`node-stream` adapter 共享 Node projection，`engine-native` adapter 在 Engine 内完成 projection，二者必须通过相同 canonical-event golden 做差分验证。
- 对 `node-stream`，`read`/`sync` 通过 consumer 流式发事件；对 `engine-native`，`read` 委托给独立 source-read binary，`sync` 委托给 Engine source-sync，二者只把有界 receipt/projection 返回给 Node。

Share 从 `list` 选择 Session 时若 summary 带有 `sourceRevision`，必须回传它作为 `expectedSourceRevision`；若 probe 只能给出 `null`，read 必须在同一 bounded snapshot 内计算完整 revision。直接按 opaque key 读取也要先重新 discover 并建立同样的 revision binding。source revision 不匹配返回 `TS_SOURCE_CHANGED`，不能发布旧快照。

Consumer 顺序是接口的一部分：每个 Session 恰好一次 `begin`，随后是零到多个串行、逐次 `await` 的 `accept`；只有 adapter 完成稳定 snapshot 复核后才调用一次 `commit`。读取、校验或 consumer 任一步失败时调用一次 `abort`，且不得再 `commit`。`sync` 可处理多个 Sessions，但每个 Session 独立遵守这套顺序；Insights consumer 在 `commit` 中提交 Engine staging，History consumer 在自身 5 MiB 预算内完成 portable history。`node-stream` 必须提供 consumer，`engine-native` 必须省略 consumer 并由 Engine 自己完成 staging；不能让同一请求同时选择两种执行模式。这样 backpressure、取消和 Session 原子性不依赖调用方约定。

`SessionReadReceipt` 固定包含 `applyMode`、`sourceRevision`、`lineageProofDigest`、`sourceSnapshotStable`、`atSourceEnd`、opaque checkpoint、coverage、diagnostics、event count、canonical byte count 和可选 bounded portable projection。`projection` 只在 Share/source-read 需要时返回，正文仍受 5 MiB 上限；`sourceSnapshotStable=false` 只用于构造 diagnostic，`SessionSources` 必须走 `abort`，不能把该 receipt 交给下游提交。`SessionSyncReceipt.committed=false` 同样不可被当作已索引。
`projection.bytes` 是 source-read framed chunks 在 Node Share 层按 5 MiB 预算组装的本地返回值，绝不作为单个 Engine protocol frame；Insights `sync` 的 receipt 将其固定为 `null`。

`SessionPage` 只返回净化的 `SessionSummary` 与三态 `lineageAvailability`；它只说明 source 是否提供 claim，不宣称 ConversationGraph 已解析。`DiscoveredSession`、native ID、native parent/root refs、members 和 descriptor 只在本机 adapter/Engine seam 内部使用。`SessionSources` 必须在 summary 到内部 selection 的转换处重新校验 source snapshot，不能让调用方伪造 opaque key。

`SessionConsumer` 只用于 `node-stream` 读取，且此时必须提供；`engine-native` 的 `sync` 禁止提供 consumer，不把 source rows 或 canonical events 发回 Node，而是调用 Engine 的顶层 source-sync 事务并只返回 `SessionSyncReceipt`。这两个执行模式是接口不变量，不是调用方的约定；违反时返回 `TS_SOURCE_EXECUTION_MISMATCH`。因此不会在既有 `InSession` 状态中插入读库请求。

调用方不得接触 source path、SQLite schema、JSONL checkpoint 或 provider raw record。删除 `SessionSources` 后，这些复杂度会重新散落到 Session、Share、Insights 和 Memory，满足 deep module 的 deletion test。

### 6.2 内部 seam：`SessionSourceAdapter`

内建 adapter 按执行模式满足以下内部接口；执行模式是一个 discriminated union，不允许在运行时把 SQLite adapter 当成 Node stream adapter：

```ts
interface SessionSourceAdapterBase {
  readonly manifest: SourceAdapterManifest;

  discover(
    request: SourceDiscoveryRequest,
  ): AsyncIterable<DiscoveredSession>;
}

interface NodeStreamSourceAdapter extends SessionSourceAdapterBase {
  readonly manifest: SourceAdapterManifest & { execution: "node-stream" };
  read(
    request: SourceReadRequest,
    emit: (event: CanonicalSessionEventV1) => Promise<void>,
  ): Promise<SessionReadReceipt>;
}

interface EngineNativeSourceAdapter extends SessionSourceAdapterBase {
  readonly manifest: SourceAdapterManifest & { execution: "engine-native" };
  readonly sourceReaderProfile: string;
  // discover/read are delegated to the short-lived Rust source reader;
  // Node never opens the source database.
}

type SessionSourceAdapter =
  | NodeStreamSourceAdapter
  | EngineNativeSourceAdapter;
```

完整接口约束：

- `discover` 只在 adapter 声明的 roots 中只读发现，不跟随 symlink，不访问网络；
- 输出按 `nativeSessionId` 的 UTF-8 byte order 稳定排序；调用方不得依赖文件系统遍历顺序；
- `read` 必须在一个 adapter-defined stable snapshot 上工作，并返回 snapshot 是否稳定；
- `read` 每次只 emit 一个有界 event；单 raw record 默认上限 8 MiB、硬上限 16 MiB，事件 payload 必须按现有 chunking 拆分以保证单个 Engine frame <4 MiB；超限保留 digest/diagnostic，不截断成看似完整的正文；
- adapter checkpoint 是版本化、canonical JSON、最大 256 KiB 的 opaque value；外部调用方只持久化和回传，不解释字段；
- adapter lineage descriptor 只能来自 provider-explicit metadata 或 adapter-qualified source structure；title/time/project/text proximity 永远不是 authority；
- `sourceRevision` 必须绑定 `lineage.proofDigest`；parent/root proof 改变时不能仅因正文未变而返回 unchanged；
- adapter 可以根据 checkpoint/source drift 把本次 apply mode 提升为 `replace-session`，不能把 replace source 伪装成 append；
- unknown record 必须 emit `provider-unknown` 或 coverage diagnostic，不能静默丢弃；
- adapter 不生成 HMAC key、Memory eligibility、Share redaction 或 Engine Fact，这些属于共享 projection。

`manifest.execution` 为 `node-stream` 或 `engine-native`。前者由 Node adapter 产生 canonical event；后者只提供能力声明和一个受 registry 约束的 `sourceReaderProfile`，`discover` 通过独立 source-reader 的 bounded metadata mode 完成，行读取、语义映射与 Insights commit 全部在 Rust Engine 内完成。`engine-native` 没有 Node `read` 方法，不得通过“先把整个 Session 读回 Node，再重新发送 Facts”绕过这个约束。

`SourceReadProblem`、`SourceProbe`、`SourceMember` 和 `SourceLineageDescriptor` 是内部 DTO，定义如下：

```ts
type SourceProbe = {
  state: "unchanged" | "changed" | "inconclusive";
  kind: "append-fingerprint" | "provider-revision" | "database-watermark" | "none";
  observed: object; // fixed scalar fields only; serialized size <= 4 KiB
  digest: string | null;
};

type SourceMember = {
  memberKey: string;
  kind: "jsonl" | "json" | "sqlite";
  locatorDigest: string;
  authority: "primary" | "fallback" | "unknown";
};

type SourceLineageDescriptor = {
  sessionRole: "main" | "subagent" | "unknown";
  relation: "root" | "spawned" | "forked" | "resumed" | null;
  nativeParentRef: string | null; // private adapter value
  nativeRootRef: string | null;   // private adapter value
  authority: "provider-explicit" | "source-structure" | "none";
  proofDigest: string | null;
};

type SourceReadProblem = {
  code: string;
  retryable: boolean;
  coverage: Record<string, number>;
};
```

### 6.3 Registry

唯一 registry 位于：

```text
src/session-sources/
  registry.mjs
  contract.mjs
  session-sources.mjs
  canonical-event.mjs
  projection.mjs
  storage/
    jsonl-reader.mjs
    json-document-reader.mjs
    source-sync-client.mjs
  adapters/
    codex.mjs
    claude.mjs
    pi.mjs
    opencode.mjs
```

`registry.mjs` 可以手工 import 内建 adapter，但 CLI、MCP、config schema、help、Indexer 和文档测试都必须从它派生，禁止再维护第二个 source ID set。

Manifest 示例：

```json
{
  "id": "pi",
  "displayName": "pi-agent",
  "adapterVersion": "pi@1",
  "status": "experimental",
  "runtime": "node",
  "execution": "node-stream",
  "identityVersion": 2,
  "changeModels": ["append-log"],
  "probeKinds": ["append-fingerprint"],
  "platforms": ["darwin-arm64", "darwin-x64", "linux-arm64", "linux-x64", "win32-core"],
  "capabilityClaims": {
    "messages": "candidate-full",
    "turnBoundaries": "unqualified",
    "toolCorrelation": "unqualified",
    "lifecycle": "unqualified",
    "tokenUsage": "recorded",
    "projectIdentity": "unqualified"
  }
}
```

Manifest 是 adapter 能力上限，不是单个 Session 的事实。`candidate-*` 和 `unqualified` 不允许直接转换为产品承诺。

OpenCode manifest 的关键差异是 `runtime: "rust-engine"`、`execution: "engine-native"` 和 `sourceReaderProfile: "opencode-sqlite@1"`；它不能被标成 `node-stream` 来复用 Node JSONL reader。平台 capability 由实际 Engine binary 决定，Windows core-only 即使 registry 中有该 ID 也必须报告 `runtimeAvailable=false`。

## 7. CanonicalSessionEvent@v1

### 7.1 Envelope

Adapter 输出的内部事件至少包含：

```ts
type CanonicalSessionEventV1 = {
  format: "canonical-session-event@v1";
  sourceAdapterId: string;
  nativeRecordRef: string;
  nativeRecordRevision: string;
  sourceOrder: {
    recordOrdinal: string;
    contentIndex: number;
    eventOrdinal: number;
  };
  observedAt: string | null;
  originScope: "main" | "subagent" | "unknown";
  kind: CanonicalEventKind;
  completeness: "full" | "summary" | "unloaded" | "truncated" | "unavailable";
  authority: "recorded" | "derived" | "unknown";
  metadata: object;
  payloads: CanonicalPayload[];
  providerPayload: object | null;
};
```

约束：

- `nativeRecordRef` 是 adapter 生成的、可重复计算的稳定 opaque record identity，只在当前进程/本机 state 边界内使用，绝不能把绝对路径、row key 或 JSON Pointer 原文发给调用方；Projection 在持久化前将其 HMAC 为 `sourceRecordKey`。若 adapter 只能生成随内容变化的临时 ref，则不得声称 stable identity，必须改用 content-addressed + `replace-session`；
- `nativeRecordRevision` 是 canonical raw record 的 SHA-256；字段变化必须改变 revision；
- `recordOrdinal` 是无前导零的 canonical 十进制字符串，数值范围 0 到 `2^64-1`；`contentIndex` 是大于等于 `-1` 的有符号整数，`eventOrdinal` 是 0 到 65535 的整数，溢出必须拒绝而不能回绕；Projection 按 source/session identity 计算稳定 `eventKey`，三元组再以它作最终 tie-breaker，形成总序；adapter 不可用运行时序号代替 `eventKey`；
- 对 append JSONL，`recordOrdinal` **原样使用记录起始 byte offset**，因此 Codex/Claude 的 V2 顺序可以无损映射；超过 `u64` 或无法安全转换时整份 Session 拒绝。对 replace JSON/SQLite，adapter 使用稳定记录 identity 的快照内 ordinal。不能证明记录 identity 稳定时，整个 Session 必须 `replace-session`；
- `providerPayload` 保留未识别的 canonical JSON，受 0600 本地存储和 Evidence 分页约束；Share 不直接输出它；
- `provider-unknown` 只作为本地 Evidence/coverage 留痕，默认 Query/Share/Memory 不展开其 raw body；需要诊断时也只能通过有界、脱敏的 evidence view 读取；
- `metadata` 只允许 adapter contract 声明的标量/有限数组，canonical JSON 不超过 16 KiB；超限按 `metadata-oversize` diagnostic 处理，不把任意 provider object 带入 projection；
- payload 使用现有 UTF-8 chunking 和 4 MiB Engine frame 预算；adapter 不自行截成 head/tail 后声称 `full`。

### 7.2 事件词汇

v1 固定以下共同 kind：

| kind | 语义 |
|---|---|
| `session-metadata` | 标题、model、originator version、project/branch candidate |
| `user-boundary` | 一个权威或派生的用户 Turn 起点 |
| `message` | user/assistant/system/developer/analysis 内容 |
| `thought` | Provider 明确存储并允许导出的 reasoning/thinking 内容 |
| `capability-invocation` | Tool/Skill 调用及 correlation ref |
| `capability-result` | Tool/Skill 结果、terminal state、exit code |
| `turn-lifecycle` | started/completed/aborted 等 Provider 记录状态 |
| `session-lifecycle` | resume/fork/rollback/compaction/session terminal |
| `token-usage` | Provider 直接记录的 nullable token 维度 |
| `provider-unknown` | 未理解但保留 revision/payload 的原始记录 |

Adapter authority table 仍由各 adapter 版本拥有。例如 Codex 的 `response_item` 与 `event_msg` twin 去重、Claude 的 tool-result-only user record 不形成用户边界，都留在对应 adapter；共享 Projection 只消费已经裁决过的 canonical events。

### 7.3 共享 Projection

`SessionProjection` 从同一 canonical stream 生成：

- Session list summary：首个可见用户请求、创建/更新时间、project/branch display；
- `threadshare-history@v1`：可见 message、thought、Tool invocation/result；
- `SessionFactsDeltaV3`：Turn、Evidence、capability、history payload、coverage；
- ranged Share selection 使用的稳定 entry provenance；
- Team Memory 使用的 hard-sealed/active/eligible Turn facts。

Node 的 `projection.mjs` 与 Rust 的 `portable_projection.rs` 是同一行为规范的两种实现，而不是两套语义；规范以 canonical JSON golden、hidden-content negative golden 和 5 MiB boundary golden 定义。Engine-native 路径若与 Node 路径的 visible entries、排序、redaction 或 digest 不一致，来源不得标为 `qualified`。

`src/session-export.mjs`、`src/session-listing.mjs` 和 `src/provider-evidence.mjs` 的 provider-specific parser 在迁移完成后删除。Secret redaction、隐藏 orchestration wrapper 和 portable history validation 保留在共享 Projection，而不是复制到 adapter。

`threadshare-history@v1` 不升级：Codex/Claude 继续使用现有 `conversation.source`；新来源写 `source: "other"` 与 `provider: <sourceAdapterId>`。服务端与 Viewer 无需知道 adapter registry。

## 8. Source identity、locator 与变更模型

### 8.1 Identity

V3 使用 `identityVersion=2`。一个 Engine ingestion row 表示一个**逻辑 Session**，并且逻辑 Session 与 composite ingestion source 固定为 1:1；一个 composite source 可以包含多个物理 store member。

| 关系 | 基数 | 说明 |
|---|---:|---|
| source adapter : source instance | 1:N | 同一 adapter 可发现多个安装根/数据库实例 |
| logical Session : composite source | 1:1 | Engine source state、generation、checkpoint 和 CAS 的唯一单位 |
| composite source : physical member | 1:N | 例如同一 OpenCode 数据目录下的 SQLite 与 legacy JSON |
| logical Session : `sessionKey` | 1:1 | 一个逻辑 Session 只有一个公开查询键 |
| physical member : `memberKey` | 1:1 | 只存在于本机 adapter state，不单独写 Engine source state |

共享 Projection 使用 origin secret 派生：

```text
sourceInstanceKey = HMAC("source-instance", adapterId, canonical root/database identity)
sourceMemberKey   = HMAC("source-member", adapterId, sourceInstanceKey, member kind, stable locator)
sourceKey         = HMAC("source", adapterId, sourceInstanceKey, identity mode, logical session id, disambiguator)
sessionKey        = HMAC("session", sourceKey)
sourceRecordKey   = HMAC("source-record", sourceKey, nativeRecordRef)
eventKey          = HMAC("event", sourceRecordKey, contentIndex, eventOrdinal, kind)
```

- native ID、绝对路径、数据库 row key 不进入公开 Query、Memory git 文件或 diagnostic；
- 所有 HMAC 参数使用 length-prefixed canonical UTF-8/unsigned-wire encoding，禁止直接字符串拼接；同一 origin secret/epoch 下跨语言实现必须通过 identity golden；
- 上述 HMAC 的 key 是当前 origin-secret epoch；Engine-native 通过一次性 V3 `projectionKey` 取得同一语义，不能把 epoch UUID 本身当作 key；
- `sourceInstanceKey` 的 identity 不含 inode、mtime、内容 digest 或 revision；通常取经过逐级 no-follow 校验后的 normalized root identity，或 Provider 自带的稳定 store id，数据库同路径原子替换仍属于同一 instance；不能直接对未校验的 symlink `realpath` 求值；
- `disambiguator` 是 canonical 字段，不能省略：`identity mode=composite` 使用空字符串，`identity mode=physical` 使用稳定的 `sourceMemberKey`。因此同一 logical Session 在 composite 模式下只有一个 `sourceKey`，物理来源无法证明合并时必然得到不同的 key；
- `sourceRecordKey` 不包含 record revision；同一逻辑记录内容变化时 key 保持不变、`nativeRecordRevision` 改变。Provider 没有稳定 record id 时，append log 使用稳定 byte origin/record ordinal；replace document 使用 adapter 明确声明的结构位置；结构位置也不稳定时才允许 content-addressed identity，但该 adapter **只能使用 `replace-session`**，由 Engine 对整份旧 Session 做 retraction，不得在 append 模式伪造删除；
- `identity mode=composite` 只在 adapter 能证明多个 member 属于同一逻辑 Session 时使用。证明至少要求 native Session ID 一致，并满足 Provider 明确的 creation/project/source-member 关系；Session lineage 的 parent/root proof 独立进入 lineage descriptor，不能拿它替代 composite member 的同源证明；标题、时间相近或模糊相似度不能作为合并证明；
- composite source 的 `sourceKey` 只出现一次，所有 member 的 locator、优先级、canonical logical session id 和 merge proof 放在 private checkpoint/state 中；DB 主记录优先提供它拥有的字段，legacy JSON 只能填补 DB 明确缺失的字段；两个 primary 值冲突时保留 primary 值并增加 `source-member-conflict` coverage，无法判定的语义字段置 unknown，不能进入 Memory。member 到 canonical logical ID 的映射一旦变化，必须提升 source revision/identity migration，不能复用旧 checkpoint；
- 不能证明合并时使用 `identity mode=physical`，将 member kind + locator digest 作为 disambiguator，产生不同 `sourceKey/sessionKey`。generic resolver 对同一用户输入返回 `TS_SOURCE_AMBIGUOUS`，sync 可以分别索引，不能任意覆盖；
- Engine 的 source state 仍按一个 `sessionKey` 行保存。任何 adapter 都不得为同一 `sessionKey` 同时提交两个独立 checkpoint/generation。

### 8.2 `append-log`

适用 Codex、Claude、pi 等 append JSONL：

- checkpoint 保存 complete byte offset、partial tail digest、next record ordinal 和 adapter pending state；
- resume 前验证 head/boundary fingerprint 与 partial tail；
- inode 替换、收缩、历史字节变化、adapter version 变化触发 `replace-session`；
- 只处理完整 newline record；活跃尾部不被当作损坏，也不能使当前 Turn hard-sealed；
- 现有 `src/session-record-reader.mjs` 迁移为 `src/session-sources/storage/jsonl-reader.mjs`，只保留通用记录边界/checkpoint 逻辑，不再拥有 provider identity。

### 8.3 `replace-document`

适用整体 JSON、按 Session 重写的文件：

- bounded streaming JSON parser 读取整个文档；禁止 `readFile + JSON.parse` 无上限物化；
- source revision 是完整 canonical document digest；
- revision 不变则 unchanged；变化后整个 Session 以 `replace-session` 原子重投影；
- JSON array index 只能作为当前 snapshot 的 `recordOrdinal` 候选，event identity 必须绑定稳定 provider record id；没有稳定 id 时采用 content-addressed record 并强制 `replace-session`；
- 文档在读取期间发生 metadata/revision 变化时返回 `TS_SOURCE_CHANGED`，本轮不提交。

### 8.4 `database-snapshot`

适用 OpenCode、后续可能的 Goose/Hermes/Kilo：

- 使用只读 SQLite connection、`query_only=ON` 和显式 read transaction；不运行 migration、PRAGMA write、extension、trigger 或任意 SQL；
- SQL 固定在版本化的 built-in reader profile 中，Node/MCP/用户不能提交 SQL、表名或任意数据库路径；
- 每个 Session revision 由稳定排序后的相关 row identity/revision/content digest 派生；若数据库没有可信更新时间，读取并 hash 全部相关 row；
- `sourceRevision` 固定为 canonical JSON 中按 `memberKey`、stable record identity、record revision、merge proof 排序后的 SHA-256；不得使用 SQLite page bytes、mtime 或未排序 row iteration 作为 revision；
- adapter 只对白名单 schema variant 宣称能力；未知 schema 返回 `schema-unsupported`，不能用列缺失 fallback 生成看似完整历史；
- SQLite snapshot 只代表本次稳定读取；写方随后更新数据库是正常情况，下次 sync 通过 per-session revision 捕获；
- DB 与 legacy JSON 同时存在时优先读取已资格验证的 DB，仅用 JSON 补齐 DB 中不存在的 Session；相同 Session 的跨存储去重由 adapter 完成。
- 任何 member `authority=unknown`、merge proof 缺失或两 member 的同一字段无法裁决时，仍可生成 history-grade/diagnostic，但不得生成 `memoryEvidence=qualified`。

项目支持 Node >=20，不能依赖 `node:sqlite`，也不能把大型 WASM/native SQLite dependency 注入受 release size 限制的 root package。OpenCode 的固定 SQLite reader 因此由 Rust Engine-native source reader 执行：

```text
Node SessionSources
  -> `threadshare-insights-engine --source-read --mode discover --adapter opencode`
  -> source-reader metadata mode 返回 bounded Session descriptors
  -> READY 状态下发起一次 SOURCE_SYNC_BEGIN(opencode, bounded source descriptor)
  -> Engine 进入 InSourceSync（独立于 InSession）
  -> Rust fixed reader profile + rusqlite read-only source transaction
  -> Rust row mapping + CanonicalSessionEvent@v1 + V3 staging
  -> SOURCE_SYNC_COMMITTED（只返回 receipt/progress，不返回原始 rows）
```

`SOURCE_SYNC_BEGIN/ABORT` 是 Engine 的**顶层 source-sync request family**，只能在 `Ready` 状态开始，期间只接受 source-sync frames，完成后回到 `Ready`；Rust 在内部按有界 batch 写 TEMP staging，但这些 batch 不是 Node 可发送的协议帧。`InSession` 和 `InTraceSource` 永远不接受 `READ_SOURCE_SNAPSHOT` 或其它 source-read frame。因此不会发生“写 Facts/Trace 过程中插入读库请求”的状态机冲突，也不会建立第二个写数据库的 Engine 进程。实现阶段要新增 `InSourceSync` 状态和 `SOURCE_SYNC_PROGRESS/COMMITTED` 响应，不能复用 `InSession` 的 batch handler。

一个 `SOURCE_SYNC_BEGIN` 只绑定一个 composite source/session，字段至少包括 `requestId`、`sourceAdapterId`、`sourceAdapterVersion`、`sourceKey`、`sessionKey`、descriptor digest、selection 上限和 expected generation；Node 按 Session 逐个发起请求，Rust 用 projection key 重新计算并比较两个 key。`SOURCE_SYNC_PROGRESS` 只返回计数、digest、coverage 和阶段，`SOURCE_SYNC_COMMITTED` 才返回新的 generation/snapshot sequence；Node 不发送 source rows、Facts batch 或任意 SQL。这样 source-sync 的有界性和 CAS 单位都与 §8.1 的 1:1 invariant 对齐。
expected generation/source revision 在 `SOURCE_SYNC_BEGIN` 与最终 commit 都复核；任一不匹配返回 `TS_SOURCE_STATE_CONFLICT`，清理 staging，不推进 checkpoint、FTS 或 snapshot sequence。

Engine-native adapter 的 `sync` 由同一 Engine 进程完成：Rust 读取 SQLite、做 provider authority mapping、写 V3 TEMP staging 并在一个 Session transaction 内提交。Node 只传经过 registry 校验的 adapter ID、composite source descriptor 和 selection，不接触 SQL、表名、row payload 或中间事件。

Descriptor 不把任意绝对路径当作权限令牌。Node launcher 先按 built-in registry 打开 source root 和 member（Unix 使用 `openat`/`O_NOFOLLOW`，必要时继承只读 directory fd），再把 `sourceInstanceKey`、相对 locator、fd slot、locator digest 和 expected file identity 传给 Engine；Rust 重新 `fstat`/`openat` 校验后才开始读取，并以同一安全 parent fd 解析 SQLite 的 `-wal`/`-shm` companion。协议拒绝未由 registry 生成的 root、SQL、表名和路径；fd、locator 或 descriptor digest 不匹配返回 `TS_SOURCE_DESCRIPTOR_INVALID`，不支持安全 fd 传递的平台返回 `TS_SOURCE_RUNTIME_UNAVAILABLE`。DB 与 legacy JSON member 的 merge proof、优先级和上限一并进入 descriptor digest，Rust 不接受 Node 在读取中途改写。

Engine-native 不能自行另造一套 key 算法。Node privacy context 从 origin secret 和 epoch 派生稳定的 32-byte `projectionKey`（HKDF domain=`threadshare-engine-projection-v3`），通过受父子进程权限保护的本地 side channel（不落盘、不进 progress/diagnostic）交给 Rust；Node 与 Rust 都用该 subkey 和 §8.1 的 length-prefixed HMAC 编码计算 `sourceKey`/`sourceRecordKey`/`eventKey`，因此同一 epoch 下跨请求的 key 稳定。`SOURCE_SYNC_BEGIN` 只携带 key handle、epoch 和 descriptor digest，Rust 完成 request 后立即 zeroize；缺少或不匹配 key handle 返回 `TS_SOURCE_EXECUTION_MISMATCH`。`--source-read` 使用同一机制，绝不把 origin secret 写入 Engine DB 或 portable history。
key handle 另绑定随机 request nonce、source/session key 和 descriptor digest，单次使用且不可重放；nonce 只用于握手防重放，不参与稳定 key 的派生。进程崩溃或连接关闭时由父子管道销毁。source state 只保存 epoch 和 digest，不保存 `projectionKey` 本身。

Share 需要独立的短生命周期 `threadshare-insights-engine --source-read --mode read --adapter opencode` 模式。该模式只打开 source DB 的只读 transaction，以 bounded framed stdout 返回 portable `threadshare-history@v1`，不打开 Insights target DB，也不进入常规 Engine state machine。它有自己的 `SOURCE_READ_HELLO`/`SOURCE_READ_REQUEST`/`SOURCE_READ_PROGRESS`/`SOURCE_READ_RESULT` framing，只接受 registry 生成的 bounded descriptor 和单个 source/session selection，不接受 `--sql`、任意表名或任意路径；它与 sync 共用 Rust canonical event/portable projection golden。任何 source-read 失败都不降级为空历史。

`--source-read` 不是用户可用的通用 SQLite CLI：只有 Threadshare launcher 能提供 descriptor/fd handshake，缺少该 handshake 的直接执行立即返回 `TS_SOURCE_EXECUTION_MISMATCH`。这样即使用户或 Agent 能启动 Engine binary，也不能借该模式读取任意本机数据库。

这条内部 seam 只读取 adapter 已知 schema，不开放通用 SQLite reader。OpenCode 的 SQLite 与 legacy JSON composite member 都由 Rust profile 读取；缺少 Insights Engine 的平台即使发现 legacy JSON，也必须报告 `runtimeAvailable=false`，不能偷偷切换到未经资格验证的 Node fallback。若未来要提供纯 Node legacy profile，必须作为单独 execution profile 通过同一 conformance/qualification 流程。

### 8.5 Cheap unchanged probe

每次 sync 先运行不读取完整正文的 bounded probe。Probe 结果只有三种，只有 `unchanged` 才允许跳过：

| change model | `unchanged` 的充分条件 | `inconclusive` 时的动作 |
|---|---|---|
| `append-log` | inode/dev/size/mtime、头部与 boundary fingerprint、partial-tail digest 均符合 adapter 的 append contract，且该 contract 明确声明 complete prefix 不可变；source 未收缩且 checkpoint generation 匹配 | 重新读取并决定 append 或 replace-session |
| `replace-document` | Provider 提供的单调 revision/etag 未变；若没有可信 revision，probe 永远只能返回 inconclusive | 计算完整 canonical document revision，再决定 unchanged/replace |
| `database-snapshot` | Provider/SQLite 提供经 adapter 验证的单调 database watermark，且该 source 的 member/schema fingerprint、相关 row count/max revision probe 均未变 | 在只读 transaction 内读取白名单 row identity/revision；不能用 mtime 单独跳过 |

Probe 不能用“大小 + mtime + 头尾采样”对任意 replace source 宣称 exact unchanged；中间字节可能变化。只有 adapter 能证明 append prefix 不可变时才允许上述 cheap probe，否则必须计算完整 revision。`SourceStateV2` 必须保存 `probeKind`、probe metadata、`probeDigest`、`probeConfidence` 和上次 exact `sourceRevision`。对于 append source，probe 还必须保存当前 file identity、complete offset、partial-tail digest 和 boundary fingerprints；对于 database source，若没有可信 watermark，probe 永远是 `inconclusive`，不能靠 SQLite 文件 mtime 代替。probe inconclusive 不算 unchanged，也不产生 silent partial。

## 9. Fact V3 与 source-state v2

### 9.1 为什么不能继续复用 V2

当前 `SessionFactsDeltaV2` 的 `turnStartOffset`、`sourceRecord.startOffset/endOffset`、`sourceOrder.recordStartOffset` 和 checkpoint `completeOffset/partialTail` 都把“来源”定义成一个 append file。给 SQLite row 或整体 JSON 编造 offset 会让 revision、Evidence 和崩溃恢复语义失真。

因此，在公开任何非 append-file 的 Insights 来源前引入 `SessionFactsDeltaV3` 与 source-state v2。V2 继续只接受已发布的 `claude@3`/`codex@3`；pi 试点在 V2 期间只能验证 registry、Session listing 和 Share，**不产生 pi V2 Facts，也不进入 Insights/Memory**。Fact V3 发布后，pi 才进入 Insights/Memory。

V3 是一次协同 Engine/root 发布，不是可以只改 Node schema 的小版本。任何 `sourceAdapterVersion`、identity 或排序语义变化都先构建 shadow DB，再原子切换；旧 V2 key、cursor、Memory binding 和 source checkpoint 不假设可继续复用。

V3 delta envelope 的 canonical 字段名是 `sourceAdapterVersion`；V2 的 `providerAdapterVersion` 只在 V2 parser 中有效。`threadshare-insights-protocol@v2`、`session-facts-delta.v3` 和 Engine contract 必须同一版本发布，不能在同一 frame 同时放两个字段来“兼容”解析。V3 顶层 checkpoint 不再暴露 `completeOffset`/`partialTail`；append adapter 可以把这些字段放进受版本约束的 opaque payload，replace/SQLite adapter 使用自己的 revision/cursor payload。

### 9.2 SourceRecordV3

```json
{
  "sourceRecordKey": "64-hex",
  "ownerSessionKey": "64-hex",
  "sourceOrder": {
    "recordOrdinal": "42",
    "contentIndex": -1,
    "eventOrdinal": 0
  },
  "recordRevision": "64-hex",
  "providerRecordClass": "message",
  "sourcePosition": {
    "kind": "opaque-record",
    "locatorDigest": "64-hex"
  }
}
```

- Event/Turn 引用 `sourceRecordKey + sourceOrder`。V3 的 `recordOrdinal` 是 8-byte big-endian `WireU64`，不是可变长字符串；`contentIndex=-1` 与 V2 相同地表示没有内容索引；`eventOrdinal` 保持 V2 的 `u16` 范围；
- 对 Codex/Claude/pi 的 append reader，V2 `recordStartOffset` 原样映射到 V3 `recordOrdinal`，所以既有三元组排序不变；对 replace/SQLite，按稳定 record identity 的 length-prefixed UTF-8 byte order 排序后分配 `WireU64` ordinal。若新 snapshot 使该 ordinal 或成员集合变化，必须走 `replace-session`，不能把顺序变化伪装成增量 append；同一 snapshot 的 clean rebuild 必须得到完全相同的 ordinal；
- Wire 层的 `recordOrdinal` 用 canonical 十进制字符串，Rust 解析后编码为 big-endian 8-byte BLOB；物理列使用 `turn_start_ordinal`、`source_records.record_ordinal NOT NULL`、`source_records.end_ordinal NULL`，以及 evidence/history 的 `(record_ordinal, content_index, event_ordinal, event_key)` 复合索引。`end_ordinal` 只有 byte-range source 才填值，replace/SQLite 必须为 NULL，并使用 `sourcePosition.kind=opaque-record` + `locatorDigest`，禁止用 `0`/`recordOrdinal` 伪造范围。迁移需要重建这些列和索引，不能只改 JSON 字段名；
- `contentIndex=-1` 必须保持为有符号 sentinel，不能编码成 `0` 或从排序中删除；
- `locatorDigest` 可用于本机 source mutation 验证，但不能反推出路径、row id 或 JSON Pointer；
- Evidence 正文继续从已持久化 payload 读取，不在 Query 时回源。

V3 的 `retractions` 增加 `sourceRecordKeys`。对于 stable record identity，adapter 可以逐项声明删除；对于 content-addressed record，必须 `replace-session` 并提交完整当前 Session，由 Engine 根据旧 snapshot 计算所有 retraction，禁止 append 模式的 delete + add。

### 9.3 SourceStateV2

```json
{
  "format": "threadshare-source-state@v2",
  "sourceKey": "64-hex",
  "sessionKey": "64-hex",
  "sourceInstanceKey": "64-hex",
  "sourceAdapterId": "opencode",
  "sourceAdapterVersion": "opencode@1",
  "originSecretEpoch": "uuid",
  "identityVersion": 2,
  "identityMode": "composite",
  "changeModel": "database-snapshot",
  "locator": {
    "visibility": "private",
    "digest": "64-hex",
    "metadata": {}
  },
  "sourceRevision": "64-hex",
  "lineageProofDigest": "64-hex-or-null",
  "probe": {
    "kind": "database-watermark",
    "confidence": "exact",
    "digest": "64-hex",
    "metadata": {}
  },
  "members": [
    { "memberKey": "64-hex", "kind": "sqlite", "authority": "primary" },
    { "memberKey": "64-hex", "kind": "json", "authority": "fallback" }
  ],
  "mergeProofDigest": "64-hex",
  "snapshotState": "stable",
  "generation": "3",
  "checkpoint": {
    "format": "opencode-checkpoint@v1",
    "digest": "64-hex",
    "payload": {}
  }
}
```

Engine 只验证 envelope、generation、digest、origin-secret epoch、identity version、probe 和 adapter contract；checkpoint payload 由相同 adapter version 验证。Adapter version 或 identity version 变化只使受影响 source stale，不强迫无关来源重建。`members` 的顺序、authority、merge proof 和 `lineageProofDigest` 也在 source revision 中，不能由 Node 在提交后自行修改。一个 `sourceKey`、一个 `sessionKey` 和一个 source-state row 必须分别唯一；physical member 的增删或 locator 变化不能偷偷创建第二个 row，无法证明仍是同一 composite source 时必须显式转为 `identity mode=physical`。`locator`、native lineage refs 和 proof 原文只保存在本机 0600 状态，示例中的 digest/metadata 才是可序列化的审计投影。

V2 中以 `(provider, session_id)` 表达的 source state 仅是兼容读取字段；V3 的主键/唯一约束改为 `sessionKey`（同时唯一 `sourceKey`），`sourceAdapterId` 是普通属性而不是分片键。`source_member` 只作为该 composite source 的私有子表/状态，不拥有独立 Insights checkpoint。这样 DB 与 legacy JSON 合并时不会在 Engine 中互相覆盖，也不会因为 member 数量变化产生第二个 Session。

面向 CLI/MCP 的 source-state/read receipt 会删去 `members`、`locator`、native ID 和 merge proof 原文，只返回 member count、authority summary 与 digest；完整 member state 仅供本机 Engine/adapter 恢复使用。

`createInsightsRequiredContract()` 在 V3 升级为 `threadshare-insights-protocol@v2`，并将 V2 的 `providerAdapterVersions` 数组改为 registry 生成的 `sourceAdapterVersions` map：

```json
{
  "registryRevision": "64-hex",
  "sourceAdapterVersions": {
    "claude": "claude@4",
    "codex": "codex@4",
    "pi": "pi@1",
    "opencode": "opencode@1"
  }
}
```

JSON Schema 对 adapter ID/version 校验 ASCII pattern 和长度，实际 membership 由 registry/Engine handshake 校验；handshake 同时携带 `registryRevision`/manifest digest，Engine 只接受自身编译进来的 built-in profile，不能信任 Node 单方面宣称的 adapter。`registryRevision` 仅对本次 contract 中的 Engine-visible source/profile 集合计算；Node 全量能力页可另有 `sessionSourceRegistryRevision`。V3 map 只列出本次参与 Insights ingestion 的 source；只做 Session/Share 的纯 Node adapter 可留在 Node registry，不得被强行塞进 Engine map。`registryRevision` 是能力清单校验值，不是全局数据 snapshot identity；新增无关 adapter 不使已有 source row 失效，只有受影响 source 的 manifest/version 变化才触发 stale/rebuild。以后新增纯 Node adapter 不再改 schema enum。

V2 的 `INSIGHTS_PROVIDER_ADAPTER_VERSIONS[2]`、`providerAdapterVersions` 字段和 Rust `SessionFactsDeltaV1::validate()` 保持原样，直到 V3 Engine 发布。V3 handshake 必须一次性传递并校验 `sourceAdapterVersions` map；旧 V2 Engine 或旧 root 不得猜测读取 V3 frame，直接返回 `TS_INSIGHTS_CONTRACT_UNSUPPORTED`。仅把 `pi@1` 加入 Node enum 而不升级 Engine 是协议错误，返回 `TS_INSIGHTS_DELTA_MISMATCH`，不能作为兼容路径。

### 9.4 Migration

Fact V2 不能完整、诚实地原地转换为 V3 source positions。迁移沿用 Deep Query 的 shadow rebuild：

1. `insights sync` 创建 V3 candidate DB，V2 active DB 继续服务现有 Query。
2. 从当前可发现的 raw sources 全量生成 V3；任一 previously-included 且未被用户显式 remove/exclude 的 source 读取失败则 candidate 不激活。已确认 purge/remove 的 source 由 lifecycle journal 记录，不作为迁移失败。
3. candidate 完成 schema/coverage/FTS/rollup validation、fsync 后原子交换。
4. 崩溃或失败删除 candidate，V2 active DB 保持不变；不得把半迁移 DB 标记 ready。
   V3-capable root 在此期间只读挂载 V2 active DB，使用明确的 V2 query compatibility reader；不得把 V2 rows 与 V3 rows 混写在同一 transaction。
5. 交换后 Query contract、cursor database UUID、Memory extraction binding 和所有 V2 opaque source/session/record keys 自动失效；客户端收到 `TS_INSIGHTS_SNAPSHOT_REPLACED` 或 cursor stale 后必须重新 discovery/recall。旧 key 不能被当成“没有结果”，resolver 必须返回 `TS_INSIGHTS_IDENTITY_MIGRATION_REQUIRED` 并给出新的 source/session ref。
6. V2→V3 不做原地 ALTER：重建 source state、turn/source-record/evidence/history 排序列与复合索引，并保留旧数据库只读回滚副本，直到新库首次完整 sync 成功。V2 的 `sourceRecordKey`（`sessionKey + byte offset`）和 V3 的 `sourceRecordKey`（`sourceKey + nativeRecordRef`）不是同一命名空间；即便同一记录仍存在，也必须重新建立 Evidence/Memory binding。

迁移还必须显式处理 v1 遗留的非终态 promotion journal：对旧 `promotion_files` 按 `applied=1` 回填 `intent_state='applied'`、按 `applied=0` 回填 `intent_state='pending'`，并将 `originally_present` 标为 `NULL`、`legacy_write_only=1`。这类行没有 v1 保存的 rollback 原文，不能假装具备 v2 的补偿能力；若在 v2 恢复时发现目标发生漂移，沿用 v1 的 fail-closed 语义直接将 plan 标记 `voided`/candidate 收口，不进入需要原文的 `rolling_back`，并保留人工复核所需的审计摘要。只有迁移后新建且已写入 intent 的 plan 才适用 v2 的 forward/rollback 阶段化恢复。

迁移实现的最小顺序固定为：

1. 在 candidate DB 中先创建 V3 的 `sessions`/source-state 与 `turns`、`source_records` 表，使用 `record_ordinal`、`end_ordinal` 和新的 identity/version 列；旧表和旧 active DB 保持只读。
2. 按 registry 重新读每个 source，生成 V3 `sourceRecordKey`、Turn、Evidence、History 和 payload；不能从 V2 offset 行猜测 V3 native identity，也不能只改列名后复用旧 key。
3. 以 V3 顺序列重建 `turns_session_order`、`source_records_session_order`、`evidence_events_session_order`、`history_events_session_order` 及所有引用这些表的 FK 表、FTS、coverage/rollup；语义上的 `provider` 列在 V3 改为 `source_adapter_id`（旧 Query 字段只在读取层作 alias）；每个复合索引都必须包含 `event_key` 作为最终稳定 tie-breaker。
4. 完成 row count、canonical digest、payload digest、Query/FTS/coverage golden 校验后 fsync candidate，再执行一次原子交换；任何一步失败都删除 candidate，不修改 V2 active DB。

若 V2 的 `(provider, session_id)` 无法唯一映射到一个经过校验的 `sourceInstanceKey`/composite source，迁移将该行标记为 orphan 并返回 `TS_INSIGHTS_IDENTITY_MIGRATION_REQUIRED`，不会按标题、时间或相似度猜测合并。

迁移在开始时冻结 registry revision、source inventory 和每个 source 的 exact revision；candidate 构建结束后重新执行 bounded probe。inventory/source revision 变化则放弃 candidate 并重试，不能把不同时间点的来源拼成一个“成功” snapshot。

V3 物理表将 V2 的 byte-offset 字段**重命名并泛化为固定宽度 `record_ordinal`**，而不是改成可变长字符串；append 来源保持 byte offset 数值，非文件来源使用 stable ordinal。`sessions.provider`、`capabilities.provider` 等语义列同步改为 `source_adapter_id`，只在兼容读取层保留 `provider` alias。Turn、history payload、FTS 和 rollup 的查询语义保持不变，但所有直接读取旧排序列或 provider 列的 Rust query/projection/index 代码必须随迁移改列名和 golden。

## 10. Capability 与资格模型

### 10.1 两层事实

能力判断必须同时检查：

1. **Manifest claim**：该 adapter 版本在资格测试中最多能提供什么；
2. **Runtime coverage**：这个 Session/snapshot 实际观察到什么，是否有 unknown、truncated、schema drift 或 active tail。

Manifest 不能把 runtime 缺失补成完整；runtime 也不能越过 adapter 尚未通过的资格门。

### 10.2 Capability vector

| 维度 | 值 |
|---|---|
| `messages` | `full | partial | unavailable` |
| `turnBoundaries` | `authoritative | derived | unavailable` |
| `toolCorrelation` | `authoritative | invocation-only | uncorrelated | unavailable` |
| `lifecycle` | `authoritative | boundary-derived | unavailable` |
| `tokenUsage` | `recorded | session-aggregate | unavailable` |
| `projectIdentity` | `authoritative | derived | unavailable` |
| `incremental` | `append | revision | full-replace` |
| `historyExport` | `qualified | unavailable` |
| `memoryEvidence` | `qualified | unavailable` |

产品展示可以将 vector 派生为三个等级，但存储和准入只使用原始 vector：

- `evidence-grade`：完整历史、权威 Turn/Tool/lifecycle，可进入 Team Memory；
- `history-grade`：可以 Share/Insights，但缺少 Memory 所需的权威闭合证据；
- `usage-only`：只提供 token/session aggregate，不能搜索解决方案或提炼 Memory。

### 10.3 Memory 准入

新来源的 Turn 只有同时满足以下条件才进入 `memory recall`：

- adapter manifest 的 `memoryEvidence=qualified`；
- user/assistant content 对该 Turn 为 `full`，不存在 `truncated/unloaded/unavailable`；
- Turn boundary 满足现有确定性 closure 规则；单纯“文件 N 分钟没变化”不能充当 provider completion；
- visibility 为 active，未被 rollback/fork 规则排除；
- source snapshot、event revision 和 Delivery Trace binding 完整；
- Tool payload 摘录/指针 coverage 与当前 Memory chunking 契约一致；
- 同一 Turn 的 unknown provider record 不影响语义；若 adapter 无法证明，则 fail closed。

Usage-only/History-grade 来源可以出现在 Insights 的 source filter 中（旧 `provider` 字段仅作兼容别名），但 `memory recall` 返回 `TS_SOURCE_CAPABILITY_UNAVAILABLE`，并准确列出缺少的维度。

`experimental`/Session-Share-only adapter 被请求执行 `insights sync` 或 `memory recall` 时，也必须返回 `TS_SOURCE_CAPABILITY_UNAVAILABLE`；不能因为它已经能列出或导出 Session 就写入空 Fact。

调用者显式传入 `sourceIds` 时，其中任一来源未达到 `memoryEvidence=qualified` 都拒绝整个请求，不静默跳过。未传 `sourceIds` 时只选择 registry 中 evidence-grade 且当前 worktree 有完整 coverage 的已索引来源；响应单独列出检测到但因能力不足未参与的来源。单个合格来源内仍按既有规则筛掉 active/coverage 不合格的 Turn，并在 selection coverage 中申报数量。

`threadshare-memory-extraction-request@v2` 是 Memory 的**来源选择/输入契约**，不是某一个操作的输出契约；Agent-native `memory recall` 与 batch `memory extract` 必须消费完全相同的 v2 envelope。两者都使用 `filters.sourceIds`、同一 worktree/snapshot/coverage binding 和同一 selected/skipped 语义；`recall` 不启动 Runner，`extract` 只有在用户选择 batch 流程时才交给独立的 Runner。这样新来源不会出现“能被 extract 选择、却不能被当前 Agent recall”的第二套路径。

v2 的 `filters.sourceIds` 只校验稳定 ID pattern（最多 16 个），执行时再由 registry 校验 membership、platform 和 capability；schema 不写死 `claude`/`codex` 枚举。v1 envelope 仍可被 `recall` 和 `extract` 接受，但只在兼容入口由独立 v1 parser 将 `filters.providers` 映射为同名 `sourceIds`，并保留 v1 的默认范围；v2 请求同时出现 `providers` 和 `sourceIds` 必须拒绝，避免两个筛选集合产生不同快照。v2 未传 `sourceIds` 时采用“当前 worktree 已注册且 evidence-grade 的所有已索引来源”，并在响应中返回 `selectedSourceIds`、`skippedSourceIds` 和每个 source 的 exclusion reason，不能静默把新来源排除。

v2 schema 的 `filters` 只接受 `sourceIds`；v1 JSON 先由独立的 v1 parser 校验并归一化，再进入 recall/extract 共用的执行器，不会让 v2 JSON 同时接受两个同义字段。`sourceIds` 的上限 16 是为了界定一次请求的 fingerprint/trace fan-out，不代表 registry 只有 16 个来源；未指定 source 时由宿主分页枚举并在同一个 snapshot binding 中冻结选择集，超过 16 个时拆成带同一 `selectionSetDigest` 的有界批次，任何批次失败都使整组失败并可重试，不能留下部分可用的候选或 recall 结果。已有 v1 调用和 v1 配置的默认来源集合不因安装新 adapter 而扩大，只有显式使用 v2 无 source filter 才采用动态 qualified 集合。

Project fingerprint、Delivery Trace 查询和 Query provider 兼容字段也由选中的 source ID 动态派生。`sourceIds` 明确指定时，每个 source 都必须有独立 fingerprint/trace binding；缺一项即整批拒绝，不得用 Codex/Claude 的 fingerprint 代填。Recall/Extraction binding 持久化规范化后的 source set、`selectionSetDigest`、database UUID/snapshot sequence 和每个 source revision，后续 Agent、runner 和 CAS 必须逐项复核；跨 batch 的 `selectionSetDigest` 不一致时整组作废。

Delivery Trace 的 source evidence 在 V3 使用 `(sourceAdapterId, sourceKey, sessionKey, sourceRevision)` 绑定；旧的 provider-only trace 只能服务 Codex/Claude V2 snapshot。Trace 缺失、跨 source 混用或 revision 不一致时，Memory 任务返回 coverage incomplete，不得把“有同名项目”当作证据。

### 10.4 候选路线

| 来源 | ccusage 已证明的存储发现 | Threadshare 首个目标 | 晋升前缺口 |
|---|---|---|---|
| pi-agent | `${PI_AGENT_DIR:-~/.pi/agent/sessions}` JSONL | 内部架构试点 | Turn/Tool/lifecycle authority fixture |
| OpenCode | data dir 下 SQLite，兼容 legacy JSON | 首个公开新来源、最终 evidence-grade | SQLite V3、schema variants、完整内容/Tool qualification |
| Gemini CLI | JSON/JSONL chat files | 第二批 history/evidence 候选 | 多格式等价、active/terminal 语义 |
| Qwen/OpenClaw | JSONL | 第二批候选 | subagent、Tool correlation、rollback/compaction 语义 |
| Amp/Droid/Codebuff/Kimi | JSON 或 wire JSONL | 资格审计后决定 | 隐私、完整正文、稳定 record identity |
| Hermes/Goose/Copilot/Grok | ccusage 当前主要消费 aggregate/telemetry | 初始最多 usage-only | 找到并验证完整会话事实源后另行晋升 |

ccusage 的 loader 能证明路径和 usage 读取方式，不能单独作为 Threadshare `evidence-grade` 的验收证据。每个来源仍需使用对应 Agent 的真实、脱敏 fixture 做资格审计。

## 11. 关键流程

### 11.1 Agent 能力发现

```text
User asks Agent to inspect history
  -> Agent calls threadshare_sources_list or `threadshare sources --format json`
  -> Threadshare returns built-in/detected/runtime/capability state
  -> Agent chooses an eligible source and bounded operation
```

返回中必须区分：

- `registered`：Threadshare 包含该 adapter；
- `runtimeAvailable`：当前平台具备 Node/Engine reader；
- `detected`：找到至少一个可读 store；
- `qualifiedCapabilities`：公开承诺上限；
- `diagnostics`：permission/schema/ambiguity 等内容无关计数。

### 11.2 Insights sync

```text
registry -> discover all enabled adapters
         -> bounded probe + compare source-state v2 revision/contract
         -> unchanged: skip
         -> changed: node-stream adapter.read -> canonical events
         -> changed: engine-native SOURCE_SYNC_BEGIN -> Rust reader/projection
         -> shared projection -> SessionFactsDeltaV3 staging
         -> Engine TEMP staging + atomic Session commit
         -> source-state/checkpoint/FTS/rollup/snapshotSeq same transaction
```

- 一个 adapter/session 失败不提交半个 Session；sync 总报告列出失败，不能把整体显示为 complete；
- `unchanged` 只能由 adapter-defined exact probe 产生；`changed` 与 `inconclusive` 都必须进入读取路径，不能因 probe 不确定而跳过；
- public Query 不触发 discover/read；用户或 Agent 先显式 sync；
- watch hint 是可选优化，最终正确性来自下次 discover + revision comparison；
- JSON/SQLite 来源没有可靠 filesystem event 时允许 bounded polling，不允许漏更新后永久 unchanged；连接断开、超时或 source transaction 失败时清理 TEMP staging，既不推进 checkpoint/generation，也不把失败 Session 计入 snapshot。

### 11.3 Share

```text
sessions <source> -> generic resolver
  -> node-stream adapter.read OR source-read Engine mode
  -> canonical stream -> portable history projection
  -> existing range selection / preflight / explicit publish
```

- Share 的 5 MiB、hidden wrapper、secret redaction 和 JSON-only API 契约不变；
- adapter 原始 payload、system configuration、native DB row metadata 不进入 history；
- Engine-native source-read 通过 bounded framed stream 直接生成 portable projection，不把完整 Session materialize 到 Node；超出预算或 snapshot 不稳定时整个 share 失败并返回稳定 diagnostic；
- 新来源必须通过 full-history export fixture 后才能开放 `share <source>`；usage-only 来源直接拒绝。

### 11.4 Team Memory

Memory 只读取已经提交的 Insights V3 snapshot：

```text
memory recall sourceIds
  -> Query/Recipe sourceIds filter (legacy provider alias normalized first)
  -> capability + runtime coverage gate
  -> eligible + active + hard-sealed Turns
  -> existing chunk/binding/evidence workflow
```

Memory 不直接打开 pi/OpenCode 文件，不新增 adapter-specific extraction path。Provider session id、row key 和 file path 继续只留在本机 0600 状态，不进入 `.threadshare/memory/**`。

## 12. CLI、MCP 与 Agent-native 交互

### 12.1 新的共享发现面

CLI：

```bash
threadshare sources --format json
threadshare sessions pi --format json
threadshare sessions opencode --format json
```

MCP：

```text
threadshare_sources_list
threadshare_sessions_list
```

两端从同一 registry 和 `SessionSources` module 返回相同业务字段、排序、diagnostic code 和 pagination；MCP 不维护第二套 provider enum。

本设计要求 `sources`、`sessions`、Share 读取/发布以及由其驱动的 Insights/Memory 操作保持 CLI/MCP 对等：两端调用同一个 operation registry、同一套参数归一化和同一 stable diagnostic。CLI/MCP parity 是所有**已暴露操作**的发布不变量，包含 `experimental` source；如果一端没有实现，另一端也不得把该操作宣称为可用。若当前云端 Share transport 只有 CLI 入口，必须先补上 MCP wrapper；不能以“transport 不属于 adapter”为由保留 CLI-only 能力。

### 12.2 命名迁移

为避免一次破坏现有自动化，分两个 release line 迁移：

| 现有 | 新 canonical 名称 | 兼容策略 |
|---|---|---|
| Memory `recall/extract.filters.providers` | `recall/extract.filters.sourceIds` | 共用 memory extraction request v2；v1 继续读取并映射，不能在 v2 混用 |
| CLI `--providers` | `--sources` | 两个 minor release 保留 deprecated alias，不能同时传 |
| `memory assemble --provider` | `memory assemble --target` | 保留 alias；MCP 新 request 使用 `target` |
| Query field `provider` | `sourceIds`（V3 canonical） | 两个 minor release 保留读取 alias；同一请求不能同时传两者，值明确为 source adapter ID |
| `--runner` | 不改 | 始终表示 batch runner，与 source 无关 |

稳定 schema 中的 source ID 使用 `^[a-z][a-z0-9-]{0,31}$` 和 runtime registry membership，不再用枚举；未知 ID 返回 `TS_SOURCE_UNSUPPORTED`。

Insights 配置同时从 `threadshare-config@v1` 升为 `threadshare-config@v2`：`format`、`schemaVersion` 和 `insights.excludeSources` 一起升级，`excludeSources` 替代 `excludeProviders`，其值只校验 ID pattern，允许尚未安装的未来 source ID 被提前排除；对当前 registry 尚未知的排除项保留原值，并在 capabilities 中报告 pending exclusion，不能静默忽略。读取 v1 时在配置锁内执行一次 v1→v2 迁移：把 `excludeProviders` 原样映射到 `excludeSources`，保留其它 registration/repository 字段，写临时文件并 fsync 后原子 rename；原文件保留为只读 `.v1` 备份直到 v2 首次成功读取。若用户同时提供两字段且集合不同，返回 `TS_INSIGHTS_CONFIG_MIGRATION_CONFLICT`，不猜测、不覆盖。迁移失败保持 v1 可读，不能写半份 v2。旧 CLI 的 `--exclude-provider` 仅作为两个 minor release 的 deprecated alias，新的 exclusion 解析、诊断和 purge 全部按 source ID 走 registry。

### 12.3 Agent 文档

README/Skill 首先教 Agent：

```text
“用 Threadshare 看一下本机有哪些可分析的 Agent 历史，再分析 OpenCode 最近两周的发布失败。”
```

Agent 先查询 sources，再选择 Share/Insights/Memory。文档不要求用户提前知道 `pi`、`opencode`、change model 或 adapter capability，也不让用户准备 JSON 文件。

推荐的 Agent-native 交互是：用户只描述“回看哪个时间窗、哪个仓库、哪个问题”；Agent 先调用 `sources`/`sessions` 获取可用 source 和 opaque Session ref，再把 `sourceIds`、snapshot digest、能力约束带入 Insights/Memory 请求，最后把证据、缺口和需要确认的写入动作呈现给用户。CLI 与 MCP 传递同一结构化 request；`memory recall` 与 `memory extract` 共用 v2 source-selection envelope，`--runner` 只在确实需要 batch LLM 提取时由 Agent 选择，不让 source adapter 与 runner 绑定。

## 13. 隐私、安全与资源边界

- Adapter 读取本机敏感历史，v1 只允许随 Threadshare 发布并经 review 的 built-in code；动态插件另开 ADR。
- 自动 discovery 不跟随 symlink；显式 path 也必须先通过 `openat`/`O_NOFOLLOW` 验证根目录和数据库文件 identity，再以只读句柄交给 SQLite，并在读取前后复核 identity。SQLite reader 使用 read-only connection、`query_only=ON` 与 read transaction；“no-follow”是路径解析层保证，不是 SQLite SQL 选项。
- Adapter 不运行 shell、Agent hook、SQLite extension、用户 SQL、网络请求或 provider executable。
- absolute root、native ID、DB schema sample 和 row key 只存 0600 本地 state；CLI JSON 默认只返回用户本来可见的 Session ref 和净化 display metadata。
- diagnostics 只输出稳定 code、retryability、计数和经过净化的摘要；不得透传 SQLite/OS error text、路径、SQL、row id 或 provider 原文。
- provider raw payload 只用于本地 Evidence；Share 使用 portable projection，Memory git 使用现有 sanitization/promotion gate。
- record、event、payload、checkpoint、diagnostic 和 Session 总量全部有上限；超限整 Session fail closed，不提交半份投影。
- detection/report diagnostic 不包含聊天正文、Tool input/output、token、secret、绝对路径或原始 native ID。
- source exclusion、purge 和 regenerate-secret 必须覆盖新 adapter 的 source state、payload、FTS 和 HMAC keys。

## 14. 稳定错误与可观测性

| Code | 含义 |
|---|---|
| `TS_SOURCE_UNSUPPORTED` | registry 中没有该 source ID |
| `TS_SOURCE_NOT_FOUND` | 已支持但当前未发现匹配 Session/store |
| `TS_SOURCE_RUNTIME_UNAVAILABLE` | 当前平台缺少该 adapter 所需 Engine reader |
| `TS_SOURCE_PERMISSION_DENIED` | store 存在但不可读 |
| `TS_SOURCE_SCHEMA_UNSUPPORTED` | SQLite/JSON schema variant 未资格验证 |
| `TS_SOURCE_CHANGED` | snapshot 读取期间变化，本轮未提交 |
| `TS_SOURCE_CORRUPT` | 记录违反严格格式或 checkpoint 不可验证 |
| `TS_SOURCE_CAPABILITY_UNAVAILABLE` | 请求需要该来源未具备的能力 |
| `TS_SOURCE_AMBIGUOUS` | 多个来源匹配同一输入，未任意选择 |
| `TS_SOURCE_REQUEST_TOO_LARGE` | source/session/event selection 超过有界预算 |
| `TS_SOURCE_EXECUTION_MISMATCH` | `node-stream`/`engine-native` 与 consumer 或 runtime 不匹配 |
| `TS_SOURCE_STATE_CONFLICT` | source generation/revision CAS 不匹配，未写入新状态 |
| `TS_SOURCE_DESCRIPTOR_INVALID` | descriptor/fd/locator digest 不符合 registry 或 file identity |
| `TS_INSIGHTS_CONTRACT_UNSUPPORTED` | V2 Engine/root 无法理解 V3 source contract |
| `TS_INSIGHTS_IDENTITY_MIGRATION_REQUIRED` | 旧 V2 source/session/record key 已失效，需重新发现 |
| `TS_INSIGHTS_CONFIG_MIGRATION_CONFLICT` | v1/v2 exclusion 字段同时存在且值冲突 |
| `TS_SOURCE_EXCLUSION_PENDING` | 配置已排除未知 source ID，等待对应 adapter 注册 |

`insights sync --format jsonl` 为每个 adapter/source 输出 content-free progress：`discovered/planned/reading/staged/committed/unchanged/failed`。最终报告按 source ID 给出数量、canonical bytes、coverage 和 diagnostic count，不输出正文。

Dashboard 的 provider selector 从 Query 返回的已索引 source IDs 构建；不得硬编码 Codex/Claude。没有数据的 registered adapter 只出现在 sources capability 页面，不污染 Query filter。

## 15. 实现文件与所有权

### 15.1 Node

| 新 module | 责任 |
|---|---|
| `src/session-sources/registry.mjs` | built-in adapter 唯一注册表、manifest validation |
| `src/session-sources/session-sources.mjs` | 外部深 module；capabilities/list/read/sync |
| `src/session-sources/canonical-event.mjs` | event contract、limits、canonical validation |
| `src/session-sources/projection.mjs` | list/history/Fact V3 共享投影 |
| `src/session-sources/storage/*.mjs` | JSONL、replace JSON reader；SQLite 只通过 Engine source-sync/read client |
| `src/session-sources/adapters/*.mjs` | provider discovery、authority、schema mapping |
| `src/source-operation-registry.mjs` | CLI/MCP source/session 操作与 parity metadata |
| `src/memory-insights-source.mjs` | recall/extract 共用的 v1 `providers` 兼容映射、v2 `sourceIds` 归一化、动态 project/coverage gate |
| `src/insights-config.mjs` | `excludeProviders`→`excludeSources` 的锁内迁移与原子写入 |
| `src/insights-query.mjs` | Query/Recipe 的 source ID filter 与旧 provider alias |
| `src/insights-engine-protocol.mjs` | V2/V3 contract 分支、source ID pattern/membership 和 migration diagnostics |
| `scripts/test-session-sources.mjs` | source/CLI/MCP conformance、边界/竞态用例与可归档的验收 case runner（Stage 0 起建立） |
| `scripts/generate-source-matrix.mjs` | 从 registry 生成支持矩阵/docs snapshot，并支持 `--check` 漂移校验（Stage 5 起纳入 release job） |

迁移后删除/收窄：

- `src/session-files.mjs` 的 provider enum/discovery 移入 adapter；JSONL walk 下沉 storage reader；
- `src/provider-evidence.mjs` 拆为 Codex/Claude adapter + shared projection；
- `src/session-export.mjs` 只保留 portable history sanitation/validation helper；
- `src/session-listing.mjs` 变为 `SessionSources.list` 的薄 CLI formatter；
- `src/insights-command.mjs`、`src/insights-indexer.mjs` 从 registry 获取 sources，不再枚举；
- `src/memory-insights-source.mjs` 使用 source capability gate 和 v2 filter。

### 15.2 Rust Engine

| 新/调整 module | 责任 |
|---|---|
| `source_state.rs`（逻辑版本 SourceState@v2） | generic source revision、checkpoint envelope、generation/CAS |
| `fact_model.rs`（新增 Fact V3 类型） | source-neutral record order/pointer/checkpoint DTO |
| `source_reader.rs` | 固定 built-in reader profile dispatch；无任意 SQL |
| `source_readers/opencode.rs` | OpenCode SQLite schema variants、只读 snapshot、row batches |
| `source_sync.rs` | `Ready`/`InSourceSync` 状态、bounded progress、staging/abort/commit 协调 |
| `source_read_main.rs` | 独立 `--source-read` framing；只输出 portable history，不打开 target DB |
| `portable_projection.rs` | Engine-native 的可见性、redaction、history@v1 投影；与 Node projection 共用 golden |
| `normalized_repository.rs`（V3 schema/queries） | V3 staging/commit/readback 与 source-neutral tables |
| `conversation_graph.rs` | lineage claim resolution、cycle/conflict/orphan、Conversation membership 与 rollup；详见 hierarchy 设计 |
| `conversation_workbench.rs` | Conversation list/detail read model、stable order、coverage 与 Evidence pointer |
| `delivery_trace.rs` | recorded Conversation-to-Session edges；不改变既有 strength/limitation |
| `protocol.rs` | V3 handshake、source-sync/read frames、stable errors |

SQLite reader 只是 adapter implementation 的内部 seam。Query、Memory 和 Dashboard 不能直接调用它。

### 15.3 Schema

新增：

- `canonical-session-event.v1.schema.json`
- `session-lineage-claim.v1.schema.json`
- `threadshare-source-capability-report.v1.schema.json`
- `threadshare-session-list-request.v2.schema.json`
- `threadshare-session-list.v2.schema.json`
- `threadshare-source-state.v2.schema.json`
- `session-facts-delta.v3.schema.json`
- `threadshare-memory-extraction-request.v2.schema.json`（`memory recall` 与 batch `memory extract` 共用）
- `threadshare-config.v2.schema.json`
- `threadshare-source-sync.v1.schema.json`（Node/Engine 顶层 descriptor、progress、receipt）
- `threadshare-source-read.v1.schema.json`（独立 source-read framing，不含任意 SQL/path）
- `threadshare-source-test-manifest.v1.schema.json`（case ID、Stage、fixture、command、owner、frame/history/RSS/wall budgets 和 expected capability）

调整：CLI contract、MCP tool schemas、release source-root allowlist 和 schema compilation tests。云端 `threadshare-history.v1.schema.json` 不变。

## 16. 实现阶段

### 16.0 最小可落地路径

不要把 registry、pi、OpenCode、Fact V3 和 Memory 作为一次大迁移同时上线。可发布的最小路径是：

M 编号与下面的 Stage 编号固定一一对应，不再使用两套错位的里程碑：

| 里程碑 | 对应 Stage | 交付物 | 进入/退出门 |
|---|---|---|---|
| **M0** | Stage 0 | 基线 golden、manifest、registry 外壳、sources/sessions/Share CLI 与 MCP | 进入前冻结 V2 行为；退出时确定性 Codex/Claude fixture 逐字节兼容、CLI/MCP parity 通过 |
| **M1** | Stage 1 | `SessionSources`、Canonical Event、共享 list/history projection、V2 compatibility projector | 进入前 M0 registry 可发现；退出时调用方无新增 source hardcode、旧 Facts/Memory 结果保持 |
| **M2** | Stage 2 | pi JSONL 的 Session/Share（`experimental`） | 进入前 M1 seam 与 MCP/CLI parity 通过；退出时 pi 只做 list/share，不能进入 V2 Facts/Memory |
| **M3** | Stage 3 | protocol@v2、Fact V3、source-state v2、shadow migration、recall/extract v2 | 进入前 M1 golden 稳定，M2 已完成或由发布记录明确 deferred；退出时 Codex/Claude V3 等价、旧 key 失效行为可验证 |
| **M4** | Stage 4 | OpenCode Engine-native reader、SQLite/legacy composite、V3 vertical slice | 进入前 M3 candidate migration 通过；退出时仅按 capability/Delivery Trace gate 暴露 OpenCode |
| **M5** | Stage 5 | qualification、文档、支持矩阵、release package 与后续 adapter 评估 | 进入前 M4 的正负路径和真实 smoke 完成；退出时 registry、CLI/MCP/docs/release 一致 |

每个里程碑都可以独立回滚到上一个 active DB/registry 状态；数据库迁移使用 §9.4 的 shadow candidate，代码/registry 回滚必须同时撤销对应 capability exposure。未通过资格门的来源只能返回明确 diagnostic，不能以空结果冒充成功。

### Stage 0：锁定现有行为与最小 registry（1–2 工程日）

- 为 Codex/Claude 冻结 Session list JSON、portable history、Fact V2、hidden wrapper、Tool correlation、active tail 和 clean/incremental golden；LLM 生成内容只比较规范化结构与 digest，不承诺运行时字节恒定；
- 建立 adapter conformance harness 与 manifest schema；
- 新增同一 operation registry 驱动的 `sources`/`sessions` CLI 与 MCP 工具，只报告现有两个 adapter；
- 为既有 Codex/Claude Share read、dry-run、publish 补齐同一 operation registry 的 MCP wrapper；任何已暴露 CLI operation 都必须同时可由 MCP 调用；
- 建立 CLI/MCP parity harness（比较规范化业务 JSON、排序、分页和 stable diagnostics）；
- 通过门：确定性 fixture 输出逐字节兼容、LLM/动态字段的规范化 digest 等价，CLI/MCP capability、list、Share 输出与错误等价，未通过的一端不得对外宣称支持。

### Stage 1：Registry 与 Canonical Event（4–6 工程日）

- 把 Codex/Claude discovery/authority/parser 移入两个 adapter；
- 建立 `SessionSources` 与共享 list/history projection；
- Insights 先通过 compatibility projector 继续生成 Fact V2；
- 删除 CLI/Indexer/config/Dashboard 的 source ID hardcode；
- 通过门：现有完整验证集通过，source ID 列表只允许出现在 registry/fixture/docs 和明确标注的 V2 compatibility allowlist；新增来源不得再增加调用方条件分支，且 Share parity wrapper 已覆盖。

### Stage 2：pi-agent Session/Share 试点（2–3 工程日）

- 接入 JSONL root、非 UUID identity、metadata 和 canonical events；
- 先标记 `experimental`，真实 smoke 不把原始内容写入测试输出；
- 只验证 Session list、Share dry-run/full export、对应 MCP wrapper 和 source capability；**不调用 V2 Facts，不进入 Insights/Memory**；
- 只有后续 V3 authority fixture 证明 Turn/Tool/lifecycle 后才打开 Memory，不以试点完成代替资格。

### Stage 3：Fact V3、source-state v2 与 Engine protocol（7–10 工程日）

- 实现 V3 protocol@v2、source-neutral order/pointer/checkpoint、registry version map 和 `InSourceSync`；
- 让 Codex/Claude adapters 输出 private lineage descriptor，并在共享 projection 中生成 `SessionLineageClaimV1`；Conversation graph、rollup 与 workbench 按关联设计进入同一个 candidate DB；
- 按 §9.4 重建 candidate DB、排序列/索引、crash recovery 和 V2 fallback；
- 发布 `threadshare-memory-extraction-request@v2`，由 `memory recall` 与 batch `memory extract` 共用，并覆盖 sourceIds、动态批次和 v1 兼容归一化；
- 先让 Codex/Claude 通过 V3 shadow rebuild，再加入 pi 的 V3 Facts；
- 通过门：增量结果、clean rebuild、V2 对照 Query 的业务结果、payload digest、cursor stale 行为一致；recall/extract 对同一 v2 request 的 source selection 和 binding 完全一致。
- hierarchy 追加通过门：`CONV-001` 至 `CONV-008` 通过；Primary Work baseline 不变，Delegated Work、orphan、cycle 和 reparent 结果可复算。

### Stage 4：OpenCode Engine-native source reader（5–8 工程日）

- Rust fixed read-only reader、`InSourceSync`/独立 `--source-read` framing；Node 只传 registry-validated descriptor，不做 SQLite 语义映射；
- 覆盖 SQLite schema variants、WAL snapshot、legacy JSON fallback、DB/JSON dedupe；
- 完成 OpenCode list/share/Insights vertical slice，并在 capability/Delivery Trace 资格满足后开启 Memory；
- 对 evidence-grade 路径执行真实 `codex` 或 `claude` CLI 的 extraction/consolidation E2E；fake runner 不能作为 qualification 证据；
- 通过门：OpenCode 达到声明的 capability vector，未知 schema/active update/permission failure 全部 fail loud，且 CLI/MCP/真实 Runner 结果可复现。

### Stage 5：公开文档与后续 adapter（2–3 工程日）

- README/中文 README/Skill/usage guides 改为 Agent 先发现 sources；
- 从 registry 生成支持矩阵和文档 snapshot（`npm run generate:source-matrix -- --check`），避免文档漂移；生成器和 snapshot 校验必须纳入 release job；
- 按同一 conformance kit 评估 Gemini、Qwen、OpenClaw；
- 每个新增 adapter 独立 PR，不把多个未经资格验证的来源捆绑发布。

单工程师首轮预计 21–32 工程日；Stage 0–3 是 registry、协议与迁移主成本，后续通过同一 conformance kit 的 file-based adapter 目标增量为 2–5 工程日/个，database adapter 另按 schema variant 评估。

## 17. 测试与验收矩阵

### 17.0 执行规约

下面的条目是发布门，而不是建议清单。每个 case 必须登记 `caseId`、对应 Stage、fixture/输入、执行命令、规范化的通过条件、证据产物和 owner；`not-run`、`skipped` 或只有本机结果都不能算通过。计划在 Stage 0 建立统一入口 `npm run test:session-sources -- --case <caseId>`，真实 Runner 用同一入口增加 `--live --runner codex|claude`，凭证或二进制缺失时返回 `not-qualified`，不得自动降级为 fake。

CLI/MCP parity 采用同一 canonical JSON comparator：忽略 transport `requestId`、运行时 timestamp 和 stderr 排版，严格比较业务字段、排序、分页 cursor、coverage、diagnostic code/retryability；不能用“都返回 200”作为等价证据。每个 fixture manifest 同时声明 `maxFrameBytes`、`maxHistoryBytes`、`rssBudgetBytes` 和 `wallBudgetMs`，因此“有界”有可复核数值，不能只写 RSS 有界。

最小 case 注册表：

| Case ID | Stage | fixture | command | 必须满足 | 证据产物 | owner |
|---|---:|---|---|---|---|---|
| `REG-001` | 0 | registry + Codex/Claude synthetic fixture | `npm run test:session-sources -- --case REG-001` | ID/version/能力声明稳定；sources/sessions 与 Share dry-run/publish 的 CLI/MCP canonical JSON 等价 | registry digest、parity JSON | source-platform |
| `REG-002` | 0–1 | unknown source、16/17 source、256/257 session、cursor stale | `npm run test:session-sources -- --case REG-002` | 超限在读取前拒绝；过期 cursor 返回 `TS_SOURCE_CHANGED`，不回到第一页 | request/diagnostic vectors | source-platform |
| `CAN-001` | 1 | Codex/Claude canonical-event golden | `npm run test:session-sources -- --case CAN-001` | visible/hidden、Tool correlation、active tail 与 V2 projector 结果保持兼容 | golden digest diff | source-platform |
| `PI-001` | 2 | pi JSONL fixture + CLI/MCP Share | `npm run test:session-sources -- --case PI-001` | 只开放 list/share；不写 V2 Facts/Memory；两传输一致 | share digest、state diff | source-platform |
| `V3-001` | 3 | triple-order/Unicode/replace fixture | `npm run test:session-sources -- --case V3-001` | 三元排序、`-1` sentinel、WireU64、增量/clean rebuild 完全一致 | V3 golden、query/FTS diff | insights-engine |
| `MIG-001` | 3 | v1 DB、半完成 promotion、断电/崩溃注入 | `npm run test:session-sources -- --case MIG-001` | V2 active 不变；旧 key 返回 migration error；legacy plan 按 progress fail-closed | candidate/journal audit | insights-engine |
| `MEM-001` | 3 | recall/extract v1/v2 request，含 >16 source batch | `npm run test:session-sources -- --case MEM-001` | 两操作共用 source selection/binding；v1 仅映射旧默认；任一 batch 失败不留下部分结果 | binding/selection digest | memory |
| `SRC-001` | 4 | OpenCode SQLite/WAL/legacy composite fixture | `npm run test:session-sources -- --case SRC-001` | snapshot、dedupe、schema drift、retraction 和 capability gate 正确 | source receipt/coverage | source-platform/insights-engine |
| `SEC-001` | 4 | fd/path/WAL race、symlink、key-rotation fixture | `npm run test:session-sources -- --case SEC-001` | fail closed；projection key 不落盘；native ID/path 不出 public/diagnostic | sanitized security log | source-platform |
| `LIVE-001` | 4–5 | Codex/Claude real CLI + sanitized evidence fixture | `npm run test:session-sources -- --case LIVE-001 --live --runner codex`；再执行 `npm run test:session-sources -- --case LIVE-001 --live --runner claude` | 使用真实已安装 CLI 完成 extraction/consolidation→review→prepare→promote；fake/未运行均不合格 | binary/profile/version digest、E2E receipt | memory/release |
| `PAR-001` | 0–5 | 每个公开 source 的 CLI/MCP 操作矩阵 | `npm run test:session-sources -- --case PAR-001` | sources、sessions、Share、Insights、Memory 的业务结果/错误/分页严格等价 | normalized parity report | source-platform |
| `REL-001` | 5 | macOS arm64/x64、Linux arm64/x64、Windows core-only clean install | `npm run test:session-sources -- --case REL-001 --platform-matrix` | Engine 包与 root 包 allowlist、macOS/Linux 的 Engine-native 能力暴露，以及 Windows 对 OpenCode/Engine-native 能力的明确拒绝路径均符合平台声明 | release manifest/smoke | release |

### 17.1 Registry/contract

- source ID、display name、adapter version 唯一且稳定；manifest capability dependency 合法；
- CLI help、MCP schemas、config validation、Dashboard 与 docs snapshot 均从 registry 派生；
- unknown source 在 CLI/MCP 返回同一 stable code，不降级成 empty result；
- source、runner、projection target 的类型和测试 fixture 不可互换。
- V2 Engine 收到 V3 handshake/frame 必须拒绝并返回 `TS_INSIGHTS_CONTRACT_UNSUPPORTED`；只把新 source ID 加入 Node 列表不得让 V2 Facts 通过。
- `node-stream` 必须要求 consumer，`engine-native` 必须拒绝 consumer；`InSession` 收到 source-sync/read frame 必须保持状态并返回 unexpected-frame error。
- 新 root/旧 Engine 与旧 root/新 Engine 两个方向都必须拒绝不兼容 contract；不能只测试“旧 Engine 收到新 frame”。
- source/session list 的 worktree scope、opaque ref、cursor snapshot 和 request caps 必须在 CLI/MCP 两端用同一组 vectors 验证；空结果必须区分“没有来源”和“来源未资格”。

### 17.2 每个 adapter 的 conformance

- missing root、env override、permission denied、symlink、ambiguous ID、duplicate store；
- discovery 顺序和 source/session keys 在相同 origin secret 下确定；
- DB + legacy JSON 能证明同一逻辑 Session 时只生成一个 composite source/state row；不能证明时生成不同 physical key，并返回 `TS_SOURCE_AMBIGUOUS` 而不是覆盖；
- parser golden 覆盖 message、Tool、result、thinking、token、lifecycle、unknown、invalid Unicode；
- active partial tail、record oversize、source replacement、schema drift、read-during-write；
- incremental sync 与 clean rebuild 的 event keys、revisions、coverage、history、Query 和 FTS 等价；
- Share export 与 Insights visible-message projection 来自同一 canonical event，hidden content 不泄漏；
- adapter 声称 unavailable 的能力不能由共现或默认值补成 recorded。
- 同一来源在两个注册 worktree 间不得串用 project fingerprint、session ref 或 Delivery Trace；native ID、绝对路径和 member locator 不得出现在 public receipt/diagnostic。

### 17.3 Storage readers

- JSONL checkpoint 在 append、partial tail、inode replace、truncate、boundary mutation 后准确恢复/拒绝；
- replace JSON 在完整 digest 未变时 unchanged，变化时只允许原子 replace-session；
- SQLite WAL 并发写、read transaction snapshot、schema variant、DB replace、legacy fallback；
- 读取器 RSS 有界，无 Session 整体 materialization；Engine frame 始终小于 4 MiB；
- SQLite profile 无用户 SQL、extension、write statement 或非白名单表访问；独立 `--source-read` 不打开 target DB。
- source descriptor 的 fd/path race、symlink swap、WAL companion swap 必须 fail closed，不得读到 descriptor 之外的文件。
- read/sync 在 abort、SIGINT、超时、连接断开和 source revision 改变后必须清理 staging，不能推进 checkpoint/generation；重复提交同一 receipt 必须幂等。
- V3 golden 覆盖 `contentIndex=-1`、CJK/emoji、最大 `WireU64`、big-endian 编解码、record ordinal 变化触发 replace-session，以及 event-key tie-breaker；clean rebuild 与增量结果必须相同。
- content-addressed record 的删除、member 变化和 source replacement 必须产生完整 retraction/replace-session，不能只新增当前记录。
- probe 的 exact/changed/inconclusive 三态有负例；replace source 不得用 mtime/头尾采样误报 unchanged，database 无 watermark 时不得跳过读取。
- checkpoint/descriptor 256 KiB、Engine frame 4 MiB、portable history 5 MiB 的边界及分块重组都必须有 1 byte below/at/above vectors。
- V2→V3 candidate 失败、进程崩溃、交换前断电均保留 V2 active DB；交换后旧 key 返回 identity migration error，而非空结果。
- v1 遗留的部分已应用 promotion plan 迁移后能按 `applied` 回填阶段；发生漂移时直接 fail-closed void，不进入无 rollback 原文可用的 v2 rollback，并保留审计/人工复核记录。
- V3 Query 的 `provider` 兼容 alias 与 `source_adapter_id` 对同一 snapshot 返回相同集合、排序和 cursor；未知 source ID 不被当作空 provider。
- v1→v2 config 的成功迁移、临时文件断电、锁冲突和读取失败都必须保留可读旧配置；`excludeProviders` 与 `excludeSources` 冲突不得覆盖任一方。
- origin secret regenerate 后 source/session/record key、cursor、Trace 和 Memory binding 必须全部失效，并返回明确 migration error，不能留下旧 key alias。

### 17.4 产品 vertical slice

每个公开 source 至少验证：

```text
sources CLI == sources MCP
sessions CLI == sessions MCP
share dry-run/publish CLI == share dry-run/publish MCP
insights sync -> query -> evidence
memory recall v2 -> extract v2 -> candidate/review/prepare/promote
purge/exclude/regenerate-secret
clean npm install smoke
```

达到 `evidence-grade` 的来源额外验证 hard-sealed、Delivery Trace binding、Memory chunk coverage 和 source revision CAS。Usage-only 来源必须有负例证明 Share/Memory 被拒绝。

Memory 额外验证：recall 与 extract 对同一 v2 request 得到相同 `selectedSourceIds`、`skippedSourceIds`、snapshot/binding digest；v1 `providers` 映射保持旧结果；v2 `sourceIds` 可选择新 registry source；未指定时返回 selected/skipped 列表；超过 16 个 source 的批次共享 `selectionSetDigest`，任一批次失败整组无候选、无 recall partial result；指定未资格 source、缺 project fingerprint 或缺 Delivery Trace 时整批拒绝；v1/v2 exclusion 迁移冲突不覆盖原配置。

Runner 资格单独验收：`memory recall` 的 Agent-native 路径可以不启动 Runner，但 `memory extract`/`consolidate` 的正向 evidence-grade 用例必须调用真实 `codex` 和 `claude` CLI 各至少一次，记录 binary content hash、版本指纹、profile digest、输入 digest 和最终 promotion receipt；fake runner、凭证缺失或只完成 dry-run 的结果只能标记 `not-qualified`。

### 17.5 真实数据 smoke

- 真实 fixture 只在开发者本机忽略目录运行，repo 只提交净化合成 fixture；
- smoke 输出仅包含 source ID、记录/事件数量、digest 和 coverage，不打印正文/path/native ID；
- 每个 adapter 至少保留两个真实 schema/version 样本的 content-free manifest；
- 本机 smoke 不能替代 CI synthetic conformance，也不能因本机没有该 Agent 而让正式测试假通过。
- smoke 必须验证 0600 本地 sidecar/descriptor 与 public 输出的隔离、跨 worktree 不串 binding，以及 source removal/exclusion 后的 retraction；不得把正文、native ID、绝对路径或凭证写入 artifact。

## 18. 发布与兼容

- 新 adapter 初次进入 registry 时状态为 `experimental`；只有 conformance、vertical slice、真实 smoke、文档与 release package 验证全部通过才标 `qualified`。
- `experimental` 不出现在 README 的“完整支持”表，`sources` 会明确展示限制。
- Fact V3 是 Insights Engine 与 root CLI 协同升级，必须同版本发布；旧 root 不得与新 Engine 猜测兼容。
- V3 发布执行完整 Insights、CLI、API、Viewer、FC、Cloudflare、Skill 和 release allowlist 验证；平台包仍按 root-last workflow 发布。
- OpenCode SQLite 支持只在包含 Engine 的 macOS/Linux platform package 宣称；Windows core-only 保持明确拒绝，不新增未实现 ACL/SQLite 例外。
- 任一 adapter semantic change 都提升 `sourceAdapterVersion`；只有受影响 source 在下次 sync replace/rebuild，无关 adapter 不重建。
- origin secret regenerate 会使 source/session/record keys、list cursors、Delivery Trace 和 Memory bindings 全部失效；迁移只提供一次性的 `TS_INSIGHTS_IDENTITY_MIGRATION_REQUIRED` 指引，不保留可查询的旧 key alias。V2→V3 交换期间可在本机 0600 migration metadata 暂存旧→新 ref 仅用于返回指引，首次成功 sync 后立即清除；secret regenerate 不建立这类映射。

## 19. 风险与处置

| 风险 | 处置 |
|---|---|
| Adapter 数量增加导致浅层 glue 蔓延 | registry 唯一接线；共享 Projection；conformance 通过同一 seam |
| usage 记录被误当完整历史 | capability vector + runtime coverage + Memory fail-closed |
| SQLite schema 快速漂移 | 白名单 variants、固定 reader profile、unknown schema 明确失败 |
| Fact V3 迁移成本和回归 | shadow rebuild、V2 active fallback、differential query/evidence gate |
| 新来源引入敏感数据泄漏 | built-in only、no-follow/read-only、共享 redaction、content-free diagnostics |
| provider ID/命名继续混乱 | source/runner/target 三类型；v2 schema 与 CLI alias 迁移 |
| 一个数据库大量 Session 导致反复打开 | adapter 内部只读 connection pool/batched reader 优化；不扩大外部接口 |
| ccusage 路径更新后 Threadshare 静默失效 | adapter discovery fixture + runtime diagnostic；不依赖 ccusage package/runtime |

## 20. 明确拒绝的替代方案

### 20.1 继续在 `provider-evidence.mjs` 增加 `if (provider === ...)`

会继续复制 discovery、export、listing 和 Insights 逻辑；新增 SQLite 时 byte-offset 假设仍无法消除。

### 20.2 直接复用 ccusage 输出

ccusage 的报告是 usage aggregation，不包含 Threadshare 所需的完整消息、Tool payload、Turn closure、revision 和 Evidence。把它作为依赖还会引入第二套扫描、版本与安装生命周期。

### 20.3 查询时按 Agent 扫描文件

违反 ADR-0001；无法提供稳定 snapshot/cursor、Memory CAS、purge 和 revision-checked Evidence。

### 20.4 所有格式都转换成临时 JSONL

会制造第二份敏感数据、丢失 SQLite snapshot/revision 语义，并把 replace source 伪装成 append source。

### 20.5 为每个 storage format 暴露公共 reader interface

调用方会被迫理解 SQLite、JSON 与 JSONL checkpoint，module 变浅。Storage reader 只作为 adapter implementation 的内部 seam。

### 20.6 首版开放第三方插件

Adapter 可读取全部聊天和本机路径，动态插件等同执行本地代码。签名、权限、更新和审计需独立 ADR，不能搭车进入来源扩展。

## 21. 完成定义

首个多来源 Epic 只有同时满足以下条件才完成：

1. Codex/Claude 经 registry/canonical event 重构后行为兼容，没有第二套 exporter/parser。
2. Fact V3/source-state v2 与 protocol@v2 完成 shadow migration，JSONL/JSON/SQLite 三种 change model 均有 crash/clean-equivalence 证据，旧 key 有明确迁移错误；`memory recall` 与 `memory extract` 共用 v2 source-selection contract，并通过 v1 兼容迁移验证。
3. pi 试点完成；OpenCode 至少在 macOS/Linux 达到其公开声明的 capability vector，并按该 vector 跑通 CLI/MCP/Share/Insights/Memory 对应正负路径；evidence-grade 的 batch Memory 路径还必须有真实 Codex/Claude CLI E2E；不具备 Memory 资格的来源只验证拒绝路径。
4. Team Memory 只接收 evidence-grade、runtime coverage 完整、active、hard-sealed Turn；usage-only/history-grade 来源有确定性拒绝，source selection 与 exclusion 不静默漏项。
5. README、中文 README、Skill、usage guide、CLI help、MCP schema、config migration 和 release package 与 registry 同步，clean install 后 Agent 可以先发现来源再执行任务。
