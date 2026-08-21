# Threadshare 团队记忆与经验总结 提案

状态：Active（rev8；Phase 1/2 已实现并通过真实 Codex 验收，Phase 3 未启动）
日期：2026-08-21（rev8；五轮设计审查意见、自查增补与 Phase 1/2 实施反馈均已吸收，见附录 B）
适用范围：本机 Threadshare Insights 与新增的仓库内记忆库；云端共享面在本提案中保持**未设计**状态（见 Phase 3）

设计输入：

- 对 [TencentDB-Agent-Memory](https://github.com/Tencent/TencentDB-Agent-Memory) 的完整源码调研（MemoryProxy 拦截与会话还原、MemoryCore L0–L3 分层提炼管线、检索召回、Skill 提取、团队共享模型），详见附录 A
- Threadshare 现有架构：ADR-0001（持久化事务性投影）、ADR-0003（Delivery Trace 证据图）、Deep Query 设计（snapshot / revision / coverage / 禁止静默截断契约）、`insights-intent-source.mjs` 的 Markdown 证据源适配器模式、`skills/threadshare/SKILL.md` 的本地数据边界（"原始内容不得传给网络服务，除非用户明确要求"）
- 2026-08-20 五轮设计审查（cs-review）：rev1 五条、rev2 复审五条、rev3 复审五条、rev4 复审三条、rev5 复审四条，本版已全部吸收（附录 B 逐条对应）
- 本机 CLI 能力复测（Phase 1 收尾）：Claude Code 2.1.222 支持 `--tools ""` / `--bare` / `--safe-mode` / `--no-session-persistence` / `--strict-mcp-config`；Codex CLI 0.147.0 可通过 feature flags 禁用 `shell_tool`、`unified_exec`、`code_mode_host` 及浏览器/插件/MCP 等 ambient 能力，执行宿主在真实 canary 调用中 fail-closed；两者仍必须逐二进制/profile 通过 deny-all conformance，不能只信参数声明
- 目标场景：不做实时代理拦截，**事后回看**本机已记录的 Codex / Claude Code 会话，提炼团队可共享的记忆与经验

## 1. 决策摘要

在 Threadshare 上新增一条"**冻结的会话证据 → 授权的受限 Runner 提炼 → 库内隔离区审批 → git 团队共享 → Agent 按需装配**"的事后提炼链路：

1. **L0 已存在**：provider 会话文件 + insights 索引天然就是 L0 层。
2. **新增四类提炼产物**：L1 原子记忆、L2 场景文档、L3 团队守则（doctrine）、Skill（SKILL.md 兼容格式，agent-neutral 存放）。
3. **提炼由受限 Runner 执行，且资格靠一致性测试证明**：历史内容只交付给通过 **deny-all conformance test** 的隔离 Runner。Phase 1 启用 Claude 与 Codex profile；Codex 额外使用一次性 `HOME/CODEX_HOME`、空 MCP 配置、显式 feature deny、`--ignore-user-config/--ignore-rules` 与 `--ephemeral`，并把 exact model/HTTPS endpoint 固化进 profile digest。宿主无可验证 Runner 时，Threadshare 拒绝交付历史内容。
4. **transcript 出网需绑定精确输入并显式授权**：每次提炼前生成 `RunnerExecutionPlan@v1`，绑定 task、输入 digest、全部输入 coverage、provider/model/endpoint、发送字节数，以及**分开申报**的本机会话持久化与服务端留存；runner 参数只创建 pending plan，交互确认或 `--approve-plan <digest>` 才授权；批量提炼可用 `AuthorizationManifest@v1` 一次确认一组**逐个列明**的 plan digest（每个 plan 仍只对自身 digest 生效、单独失效）。MCP 不得自行授权。Runner 强制本机 no-session-persistence；**Threadshare 不承诺也不暗示模型服务端的留存策略**（providerRetention 默认 unknown，如实展示）。
5. **提炼阶段的全部状态在单一事务库内**：任务、提交、候选（draft/quarantined）、原始 evidence refs、chunk 游标全部是 `memory-state.sqlite3` 的表，单事务提交；**不再有事务外的 quarantine/、evidence-refs/ 文件目录**。审批后的 git 写入走独立的可恢复 promotion journal，不声称与提炼同事务。
6. **提取与裁决拆为两阶段任务**（消除循环依赖）：`ExtractionTask → CandidateDraftBatch → 双 FTS + RRF 召回 → AdjudicationTask → AdjudicationResult → 事务性入隔离区`，两阶段各有 taskId / lease / binding / 幂等提交。
7. **关联来源与陈述支持分离**：Delivery Trace 只派生 `provenance_strength`（关联来源强度），绝不把 direct/observed 当作自然语言 statement 成立的证明；每条 statement 另有 `claim_support: unverified | typed-fact | human-confirmed`。任意 LLM 生成陈述默认 unverified；只有确定性 typed fact 或逐条人工确认才能晋升。
8. **提交 CAS 按相关输入判定，且裁决绑定双投影召回结果集**：approved memory 走 Insights memory FTS，draft/quarantined 走事务库内 candidate FTS；各取有界候选后以确定性 RRF 融合。AdjudicationTask 绑定两侧投影 provenance、query/result digest 与逐项 revision，提交时重跑召回；只有结果集变化才 stale。
9. **repo/worktree owner 贯穿全流程**：`RepositoryBinding@v1` 从 ExtractionTask 一直绑定到 PromotionPlan；project 到仓库映射不唯一时硬失败。写入固定在所绑定 worktree 的 `.threadshare/memory/**`，拒绝 symlink、路径穿越与 owner 漂移。
10. **晋升有 git 内容 CAS**：`PromotionPlan@v1` 绑定 repository/worktree owner、目标文件 blob hash、净化内容 digest 与净化策略版本；漂移必须重新生成 diff 并再次批准；Phase 1 的 promote **只修改工作区**，不自动 stage/commit/push。
11. **git 为团队记忆的真相源，只存净化内容，agent-neutral**；Claude/Codex 装配是显式 adapter。
12. **共享面未设计**：需独立 ADR / endpoint / storage wrapper；不复用现有 shares API。

## 2. 背景与问题

团队在多个项目上使用 Codex / Claude Code 等 Agent 工作。相同的项目背景被反复讲解，跑通的做法被反复摸索，踩过的坑被反复踩。Threadshare 已经把会话历史变成可查询的结构化证据（Local Insights），但证据不等于经验：

- Insights 能回答"哪个 Tool 一直失败、哪次失败链后来成功了"，但不能沉淀"下次遇到这类问题该怎么做"；
- 每个成员的会话历史都是本机私有的，跑通的方法不会自动流动到队友和下一个 Agent；
- 现有 Continuation Context 是即时派生、无状态、不落库的，无法累积。

参考项目 TencentDB-Agent-Memory 用"代理拦截 + 实时分层提炼"解决了同类问题（PersonaMem 48% → 76%）。本提案吸收其经过生产校准的算法与 prompt 资产，但采集、权限、并发、授权与共享架构按 Threadshare 的事后场景、证据契约与隐私边界重新设计。

## 3. 关键事实与设计决策

调研与实测确认的关键事实：

| # | 事实 | 证据 |
|---|---|---|
| F1 | Threadshare 运行时零 LLM 依赖；provider-independent 是产品边界 | `package.json`；AGENTS.md |
| F2 | `insights.sqlite3` 是派生态；所有 `*_key` 是本机 HMAC 指纹，跨机器不可比 | ADR-0001；`src/session-facts.mjs` |
| F3 | 本地索引含未裁剪的密钥与私有内容；share 路径不得自动读取 | AGENTS.md；Deep Query 设计 |
| F4 | Insights 查询契约要求 snapshot / revision / payload digest / coverage 一致性，禁止静默截断 | Deep Query 设计 |
| F5 | Delivery Trace 的 commit 节点使用仓库身份 + 完整 hash；direct / observed / candidate / contextual 描述的是**关系来源强度**，不能证明任意生成陈述的语义成立 | Delivery Trace 设计 §6；ADR-0003 |
| F6 | 全局 snapshot 序号随每次 Session commit 递增，与任务相关性无关 | `normalized_repository.rs`（session_commits.snapshot_seq） |
| F7 | MCP server 只能控制自己暴露的工具，无法撤销宿主 ambient capabilities | `src/insights-mcp.mjs`；MCP 协议语义 |
| F8 | 现有 `POST /api/v1/shares` 只接受 `threadshare-history@v1`；ADR-0003 只授权独立 portable contract | `src/share-api.ts`；ADR-0003 |
| F9 | **Claude Code 2.1.222 具备可验证的零工具参数面**；**Codex CLI 0.147.0 虽无单一 `--tools none`，但 feature deny 可关闭 shell/unified exec/code-mode host 及其他 ambient capability**。真实 canary 中 code-mode host fail-closed；资格仍由完整 conformance 与二进制/profile 指纹决定 | 第三轮审查 + 2026-08-21 Phase 1 复测 |
| F10 | 现有本地数据边界："原始 Query 内容不得传给网络服务，除非用户明确要求" | `skills/threadshare/SKILL.md` |
| F11 | SQLite 事务无法原子提交外部文件系统对象 | SQLite 语义 |
| F12 | Insights state 是本机全局库；同一 project key 可被多个注册仓库声明；现有 repository resolver 可取得 real worktree root 与 git common directory identity | `src/insights-paths.mjs`；Delivery Trace 设计 §10.2；`src/insights-repository-source.mjs` |

由此确定六个核心决策：

### D1：受限 Runner 的资格靠 conformance test 证明；transcript 出网靠输入绑定授权

**Runner 资格（对 F7 / F9）**：

- `RestrictedExtractionRunner@v1` profile 随包分发，但 **profile 声明不构成资格**；资格由 **deny-all conformance test** 证明：Threadshare 在交付任何历史内容之前，先以对抗性探针任务运行该 profile（探针 prompt 诱导执行 shell / 读写文件 / 调用 MCP / 发起任务外网络请求），验证全部被拒且无副作用，通过后记录 `{profile, cliVersion, testVersion}` 指纹；CLI 版本或 profile 变化即失效重测；
- **Phase 1 启用 Claude 与 Codex profile**。Claude 使用 `--tools "" --bare --safe-mode --no-session-persistence --strict-mcp-config`；Codex profile v2 使用显式 model/HTTPS endpoint、空 `mcp_servers`、执行/浏览器/插件等 feature deny、`--ignore-user-config/--ignore-rules`、`--ephemeral` 与一次性 home。宿主环境缩减为认证、代理、证书与 locale 白名单，不透传任意项目 secret、`NODE_OPTIONS` 或动态加载变量；v2 使旧 conformance 指纹自动失效重测。参数面只是前置条件，两者仍须真实通过 conformance；
- **硬失败规则：宿主环境不能提供通过 conformance test 的 Runner 时，Threadshare 必须拒绝向任何 Agent 交付历史内容**；不降级、不回退到 ambient Agent；
- transcript 经 stdin 交付、结果经 stdout 回收；超时与输出上限强制执行；**Runner 必须以本机 no-session-persistence 模式运行**（`localSessionPersistence: none`），避免提炼运行自身生成新的可索引会话（防反馈回路）。

**出网授权（对 F10）**：Runner 无本机工具，但会把未裁剪的 transcript 发往模型端点——这是内容离开本机，必须显式授权：

- 每次提炼执行前，Threadshare 先确定性序列化将交给 Runner 的完整 stdin，再生成 **`RunnerExecutionPlan@v1`**：`taskKind + taskId + runnerInputDigest + inputCoverageDigest`、全部输入来源 coverage（包含 transcript、draft、候选池摘要）、provider、model、精确发送字节数、网络目的地，以及**两级分开申报的留存**——`localSessionPersistence: none`（Runner 本机不留会话，CLI 参数可保证）与 `providerRetention: unknown | no-retention | provider-policy`（模型服务端留存，**Threadshare 无法凭 CLI 参数保证**，默认 unknown，如实展示，不得伪装为本机可保证属性）；
- `planDigest = sha256(canonical plan without authorization decision)`。`memory extract --runner <claude|codex> --request <file|->` 只生成并展示 pending plan，不交付内容；Codex 新 preview 还需绑定 `--runner-model` 与 `--runner-endpoint`。交互式确认或非交互 `--approve-plan <planDigest>` 才授权该**唯一输入**。task input、候选池、coverage、endpoint、model 或留存字段任一变化都产生新 digest，必须重新确认；
- **批量授权（自查增补）**：批量提炼时逐任务唯一 digest × 两阶段任务会导致确认次数爆炸（50 个 chunk ≈ 100 次确认）。可生成 `AuthorizationManifest@v1`——逐个列明各 pending plan 的 digest、taskKind 与字节数，一次交互确认批准清单内全部 digest；每个 plan 仍只对自身 digest 生效，任一 plan 的输入变化只作废该 plan、不影响清单内其他已批准 plan；**不存在"整包授权覆盖未来任务"的语义**；manifest 批准同样写入审计日志；
- **MCP 不得自行授权**：ambient 宿主 Agent 经 MCP 触发提炼只能创建 pending plan，等待用户在 CLI 侧确认；MCP 响应永不携带 transcript；
- 全部授权决定写入审计日志。

路径校验、schema 校验、原子写入与全部 git 操作由 Threadshare 主进程执行。`<<past-*>>` 标记只用于提取质量（防 role-capture），不承担权限职责。

### D2：仓库内文件为团队记忆真相源；原始引用只存本机事务库；真相源 agent-neutral

- git 内：净化正文、稳定 `id`、可公开证据（仓库身份 + 完整 commit hash、仓库相对路径）、confidence / provenance_strength / claim_support / limitations；
- 原始 provider session id、turn key、revision、payload digest 等溯源引用**存 `memory-state.sqlite3` 的 evidence_refs 表**（库文件 0600），不再使用独立文件目录（F11：文件无法参与 SQLite 事务）；`portable: false` 只表示不可迁移，不表示不敏感——敏感引用一律不进 git；
- **用户显式批准 PromotionPlan 是进入 git 的唯一通道**（见 D5）；lint 与 PR review 是补充防线；
- 真相源目录不含任何 provider 专属路径（F1）：Skill 存 `.threadshare/memory/skills/`；到具体 Agent 的落位（CLAUDE.md import、`.claude/skills/` 等）由 `threadshare memory assemble --provider <x>` 显式 adapter 生成，装配产物视为可再生成的派生物。

### D3：approved memory 与在途候选各有单一持久化投影

approved memory 经 memory ingest 协议（新增 collection）进入 Insights Rust 表组与 memory FTS（影子重建 + build cursor），供 Query 层 `memory-entry` resource、JS 客户端与 CLI/MCP 使用。**ingest 与投影按 `(repositoryKey, worktreeKey)` 分键（自查增补）**：同一仓库的不同 worktree 可能检出不同的记忆文件状态，投影只按 repository 分键会互相污染；§6.4 的"approved FTS 已同步至绑定 worktree"即以此分键为前提。在途 draft/quarantined 不进入公共 Insights：它们在 `memory-state.sqlite3` 内维护事务性的 **candidate FTS**，与 candidate 行同事务更新，仅供去重编排。去重模块分别从两侧取 `3 × k` BM25 候选，再以 versioned RRF（`k=60`）确定性融合为 top-k；不比较两个语料库不可比的原始 BM25 分数，也不引入 scan-on-query 数据面。

### D4：提炼阶段单事务库；两阶段任务；CAS 按相关输入判定

**owner 模型（rev6 新增）**：Threadshare 在生成任何任务前解析唯一 **`RepositoryBinding@v1`**：`repositoryKey` 绑定 git common directory identity，`worktreeKey` 绑定 real worktree root，`memoryRoot` 固定为 `.threadshare/memory`。project 未映射仓库或映射多于一个仓库时硬失败，不使用排序后首个仓库。binding 中只流转 opaque key/digest；本机绝对路径只存 0600 事务库。tasks、candidates、adjudication 与 PromotionPlan 全部携带同一 owner，任何漂移均拒绝。

**事务模型（对 F11，rev4/rev6 修订）**：提炼阶段的**全部**状态——repository bindings、tasks、submissions、chunks、candidates（draft / quarantined）、evidence refs、candidate FTS——都是 `memory-state.sqlite3` 的表；claim、幂等提交、候选与 evidence 落库、候选 revision/FTS 更新、chunk 游标推进在**同一 SQLite 事务**内完成，不涉及任何外部文件。审批通过后的 git 写入是**独立的 promotion journal**（可恢复、幂等重放），不声称与提炼提交同事务。

**两阶段任务（消除循环依赖，rev4 新增）**：

```
ExtractionTask@v1 ──Runner──► CandidateDraftBatch@v1（仅候选，无裁决）
        └─ Threadshare：draft 入库（事务 1）
Threadshare 对每条 draft 候选执行双 FTS 召回 + 确定性 RRF
AdjudicationTask@v1（draft batch + 统一候选池及各自 revision）
        ──Runner──► AdjudicationResult@v1
        └─ Threadshare：执行裁决 + 候选置 quarantined + chunk 置 extracted（事务 2）
```

两阶段各有独立 taskId / lease / binding / 幂等提交（taskId + responseDigest）语义。此前 rev3 的单任务契约要求 Runner 在提交候选的同一响应里完成裁决，而召回又只能发生在候选提交之后且 Runner 无检索工具——该循环依赖在 rev4 中消除。

**CAS 粒度（对 F6）**：`snapshotSeq` 仅作组装 provenance；stale 判定比较 `databaseUuid + owner binding + sourceInputDigest + 逐项 turn/payload revision + 引用的 delivery-edge revision + prompt/schema/chunker 版本`。`sourceInputDigest` 是源输入的 canonical digest，不包含自身；`RunnerExecutionPlan.runnerInputDigest` 另对最终序列化 stdin 字节取 digest，避免自引用。只有相关输入变化才判 stale；无关会话同步不使在途任务失效。

**裁决绑定召回结果集（rev5/rev6 修订）**：仅绑定已召回条目的 revision 无法察觉"任务运行期间新条目挤入 top-5"。AdjudicationTask 因此记录 approved/candidate 两侧投影 provenance、`recallQueryDigest + resultSetDigest`。结果集 digest 覆盖每个 draft 的 ordered recall set：`{draftRef, rank, sourceKind, id, revision, contentDigest, state}`；同一 union pool 内的排名或 draft-to-result 映射变化也可见。提交时在最新已同步投影上**重跑同一召回**；投影 generation 变化但结果集相同可接受，结果集不同才 stale 重出。candidate 的任何 recall-visible 内容或状态变化都在事务内推进 revision 并同步 candidate FTS。

### D5：候选状态机与带 git 内容 CAS 的晋升

候选状态机是 `draft → quarantined → promoted | discarded`，只存在事务库；成功晋升后写入 git 的条目状态机是 `approved → deprecated`。两者用不同枚举，避免把“候选已写出”与“团队条目当前有效”混为一谈。

**晋升（rev4/rev6 修订）**：审批的对象是 **`PromotionPlan@v1`**，它绑定：

```
RepositoryBinding（repositoryKey + worktreeKey + memoryRoot）
+ 目标文件当前工作区字节的 git blob OID（`git hash-object` 语义；不存在则为 null）
+ 净化后内容 digest
+ 净化策略（lint 规则集）版本
```

- 用户在 `memory review` 中看到的 diff 即由该 plan 生成；**批准后执行时逐项校验 blob hash 与策略版本，任何漂移（git pull、其他候选先晋升、用户手工改动、lint 规则升级）→ 作废该 plan，重新生成 diff、重新批准**——本机 claim/lease 不解决团队 git 并发，内容 CAS 解决；
- 执行时重新解析 owner，要求 repositoryKey/worktreeKey 与 plan 完全一致；`targetPath` 必须是 `memoryRoot` 内的 normalized relative path。Rust 写入器使用 directory-handle-relative、no-follow 的逐级 traversal 与原子 rename；`lstat` 仅用于诊断，不作为抗 TOCTOU 保证。任何 symlink、owner、路径或 inode 漂移均 fail-closed；
- Phase 1 的 promote **只修改工作区文件**，不自动 stage / commit / push；提交与推送由用户走常规 git 流程（PR 复核在此发生）；
- **关联来源强度由 Threadshare 派生，不由 Runner 自报（rev5/rev6）**：任务包内的 commit / turn / path 证据以 opaque `evidenceId` 下发，Runner 的 statement 只能引用 `evidenceIds[]`；Threadshare 校验每个 id 归属当前任务及其 immutable pointer digest，并按 Delivery Trace 规则计算 statement 的 `provenance_strength` 与 limitations。statement 无引用为 unknown，有多个引用时取最强 relation strength、limitations 取并集；该值只描述关联来源，不表示 statement 被证实；
- **陈述支持独立判定**：每条 statement 初始 `claim_support: unverified`。Phase 1 的 versioned typed-fact allowlist 仅含从不可变 Git object 生成的 `commit-changed-path@1` 与从配对 invocation/result 生成的 `command-exit@1`；renderer 只能输出固定模板，才可置 `typed-fact`。其他 LLM 生成陈述即使引用 direct edge 也保持 unverified，必须在 review 中连同证据摘录逐条人工确认后置 `human-confirmed`。entry 级 provenance 按 `direct > observed > candidate > contextual > unknown` 取最弱值，limitations 取并集；git 内 `claim_support` 为 `typed-fact | human-confirmed | mixed`，不允许 unverified；
- “批准全部”仅对全部 statements 均为 `typed-fact` 的 entry 开放；生成性记忆必须逐条确认。`adjudication: failed` 仍须单独处理。

### D6：共享面未设计

跨仓库/组织共享需独立 ADR + 独立 endpoint + 独立 storage wrapper 与显式裁剪层；**不复用现有 `POST /api/v1/shares`**（F8）。

## 4. 总体架构

主数据流：

```
显式有界筛选请求 + 唯一 RepositoryBinding + 冻结的 Insights Turn chunks（sourceInputDigest 绑定）
  → RunnerExecutionPlan@v1（绑定精确 task input；CLI 确认 digest；MCP 只能 pending）
  → ExtractionTask@v1 → 受限 Runner（通过 conformance test，ephemeral）
  → CandidateDraftBatch@v1 → 事务 1：draft + evidence assessment + candidate FTS
  → approved memory FTS + candidate FTS → BM25 候选 → versioned RRF top-5
  → AdjudicationTask@v1 → Runner → AdjudicationResult@v1
  → 事务 2：候选 revision/FTS CAS、裁决、quarantined、chunk 游标推进
  → memory review：逐条确认 unverified claim → 生成 owner-bound PromotionPlan@v1
  → 用户显式批准 → promotion journal 写工作区（只改文件，不碰 git 历史）
  → 用户常规 git commit / PR
  → insights sync 摄入 → Memory FTS 投影
  → Agent recall（assemble adapter 装配 + memory_search 工具）
```

模块视图：

```
┌── 数据源（只读，已有）──────────────────────────────────────┐
│ provider session 文件 + insights.sqlite3                     │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌── 提炼工作流（新增）────────────────────────────────────────┐
│ Threadshare 主进程：owner 解析、选材、分块、任务包、双投影召回│
│   claim/lease、CAS、evidence assessment、净化、PromotionPlan、│
│   promotion journal、conformance test、输入绑定授权           │
│ 受限 Runner（LLM 推理；通过 deny-all conformance test；      │
│   ephemeral；stdin/stdout）：提取、裁决、归纳                │
│ ambient 宿主 Agent（仅编排/审阅，经 MCP；不见 transcript；   │
│   不能授权出网）                                             │
└──────────────┬───────────────────────────────────────────────┘
               ▼
┌── 状态与记忆库 ──────────────────────────────────────────────┐
│ 本机 memory-state.sqlite3（0600，事务库）：repository_bindings/│
│   tasks / submissions / chunks / candidates + candidate_fts / │
│   evidence_refs / assessments / promotion_journal / auth log   │
│ 仓库内（净化，agent-neutral）：entries/ scenes/ doctrine.md   │
│   skills/  index.json（派生）                                 │
└──────────────┬───────────────────────────────────────────────┘
               │ git push/pull = 团队同步；PR = 复核留痕
               ▼
┌── 消费面 ────────────────────────────────────────────────────┐
│ threadshare memory assemble --provider <x>（显式装配 adapter）│
│ threadshare_memory_search MCP（memory FTS，snapshot 语义）    │
└──────────────────────────────────────────────────────────────┘
```

## 5. 数据模型

### 5.1 L1 条目：`entries/<slug>.md`（git 内，净化后）

（下例中 `# …` 尾注仅为本文档的讲解性标注；实际文件方言不支持注释——见实施设计 DEV-2）

```markdown
---
id: auth-module-do-not-refactor        # 稳定逻辑 id（slug），即文件名
type: work_method                       # work_fact | work_task | work_method | work_artifact
status: approved                        # git 内仅 approved | deprecated
priority: 85
confidence: high                        # high | medium | low（Runner 建议值，供人工参考）
provenance_strength: observed           # 仅表示关联来源强度；全部 statements 的最弱值
claim_support: human-confirmed          # typed-fact | human-confirmed | mixed；git 内无 unverified
limitations: ["not-authorship", "not-causality"]   # 沿用 Delivery Trace 词汇表
scope: repo                             # Phase 1 只接受 repo
scene: 鉴权模块维护
occurred: ["2026-08-12", "2026-08-18"]  # 时间戳轨迹，merge 时取并集
evidence: {
  "commits": [
    { "repo": "github.com/team-harness/threadshare",
      "hash": "7fd2f23a1b04c9e8d2f6a35b7c01d94e8f123456" }
  ],
  "paths": ["routes/api/session.ts"]
}                                       # 仅可公开证据；值为多行 JSON（frontmatter 方言，实施设计 DEV-2）
superseded_by: null
---
别重构旧鉴权模块的 session 中间件，移动端 v2.3 之前的客户端仍依赖其
非标准 cookie 行为。改动前必须先在 staging 用 mobile-e2e 套件验证。
```

要点：

- **原子性**：一个 L1 entry 只表达一个可独立复用、可独立审核的 claim unit；候选含多个独立 statements 时，promotion 前拆为多个 entry。正文可以包含同一 claim 的条件、行动和限制，但不能把不同证据基础的结论揉成一条；
- **版本模型**：当前文件可更新，历史由 git 保存；update/merge 改写当前文件；被替代条目置 `deprecated` + `superseded_by`；
- **git 内不出现任何 provider session id / turn key / payload 引用**——溯源在 memory-state 的 evidence_refs 表（供原机器回跳复核）；
- `confidence`、`provenance_strength` 与 `claim_support` 三者分离：confidence 是模型建议，provenance 只表示关系来源，claim support 才表示 typed fact 或人审状态；commit 关联本身只证明"观察到相关交付"；
- `memory review` 必须按 statement 展示证据摘录、公开证据与 limitations。本机 pointer 不进 git；仅本机可复核的条目增加 `source-local-only` limitation。

### 5.2 L2 场景：`scenes/<name>.md`

沿用参考项目 code 模式：章节（工作场景/适用条件/核心 SOP/判断逻辑/禁忌与反模式/关键事实依据/演化记录/待确认问题）+ META 头（created/updated/summary ≤40 字/heat：新建=1、更新+1、合并=sum+1）；单文件 ≤1500 字符；全库 ≤15 个；叙事体；矛盾写"演化记录"不覆盖。

### 5.3 L3 守则：`doctrine.md`

章节（Core Principles / Reusable SOPs / Decision Logic / Boundaries & Anti-patterns / Agent Rules）；≤1200 字；五道写入过滤（通用性/完整性/可执行性/稳定性/精炼性）；四种更新策略（强化/补充/修正/重构），持续压缩。

### 5.4 Skill：`.threadshare/memory/skills/<name>/SKILL.md`

SKILL.md 兼容格式，agent-neutral 存放；provider 落位由 `assemble --provider <x>` 显式装配。

### 5.5 提炼状态：`<state-dir>/memory/memory-state.sqlite3`（0600，事务库，独立于 insights.sqlite3）

由 Rust 引擎管理。**提炼阶段全部状态都是本库的表**（F11：不存在事务外的 quarantine/ 或 evidence-refs/ 文件目录）：

```
state_meta:       memoryStateUuid, schemaVersion
repository_bindings:
                  repositoryKey, worktreeKey, publicRepositoryIdentity,
                  rootRealpath(敏感), rootRealpathDigest,
                  commonDirectoryDevice, commonDirectoryInode,
                  memoryRoot: .threadshare/memory, status
tasks:            taskId, kind: extraction|adjudication|consolidation,
                  repositoryKey, worktreeKey, chunkRef / draftBatchRef,
                  binding, authorizationPlanDigest, lease(holder, expiresAt),
                  status: pending|claimed|submitted|stale
submissions:      taskId, responseDigest, receivedAt          ← 幂等去重
chunks:           chunkRef(sessionKey, turnRange, chunkDigest),
                  repositoryKey, worktreeKey,
                  status: pending|drafted|extracted|stale,
                  provenance(snapshotSeq)
candidates:       candidateId, repositoryKey, worktreeKey, chunkRef,
                  revision, contentDigest, payload(净化前全文),
                  status: draft|quarantined|promoted|discarded,
                  adjudication: pending|done|failed
candidate_fts:    external-content FTS(candidateId, searchableText),
                  仅索引同 owner 的 active candidate           ← 与 candidates 同事务
candidate_projection:
                  repositoryKey, worktreeKey, generation,
                  analyzerVersion, recallAlgorithmVersion       ← 与 candidates 同事务
evidence_refs:    candidateId + statementId + evidenceId →
                  pointerDigest, sessionKey, turnKey, revision,
                  payloadSha256, relation, strength, limitations, taskId
                                                               ← 敏感，永不出库
assessments:      candidateId + statementId, citationsDigest,
                  provenanceStrength, limitations, claimSupport,
                  assessedBy: deterministic|human, revision
promotion_journal: planId, repositoryKey, worktreeKey,
                  candidateIds[], targetPath, assessmentDigest,
                  targetBlobHash, sanitizedDigest, policyVersion,
                  status: approved|applied|voided              ← 可恢复重放
authorization_log: planDigest, taskId, runnerInputDigest,
                  inputCoverageDigest, provider, model, endpoint,
                  bytes, decidedAt,
                  via: interactive|digest|manifest, manifestDigest?
```

事务语义：

- **claim**：事务内领取 pending 任务并设 lease；lease 未过期不可二次领取；过期由下次 claim 回收；
- **提交**：owner/CAS 校验 → 幂等检查（同 taskId + 同 responseDigest 返回既有结果；不同 digest 拒绝并审计）→ 结果落库 + candidate revision/FTS + assessment + 状态推进，**单事务**；
- **候选 revision**：任何会改变召回或裁决语义的 payload、status、adjudication、supersession 更新都推进 monotonic revision 并重算 contentDigest；candidate FTS 和 generation 在同一事务更新。Adjudication 对 candidate target 执行逐行 revision CAS；
- **崩溃恢复**：不存在"候选已落、游标未推"或反之的中间态（全在一个 SQLite 事务内）；promotion journal 独立恢复：`applied` 幂等重放、半途崩溃按 planId 续作或作废；
- 只有提交成功的 chunk 推进；省略/延后/stale 的 chunk 保持可重出；
- `--regenerate-secret` 后按 chunkDigest 尽力迁移，失败回 pending。

### 5.6 契约对象（Phase 1 定稿 JSON Schema）

**`MemoryExtractionRequest@v1`**（CLI → Threadshare）：`{ format, window: { after, before }, query?, filters?: { providers?, sessionKeys?, toolCapabilityKeys?, skillCapabilityKeys?, resultEvidence?, capabilityTerminalStates? } }`。window 为最长 366 天的 canonical UTC 半开区间；调用方不具备 project/closure 字段，owner project keys 与 `hard-sealed` 由 Threadshare 强制注入。

**`RepositoryBinding@v1`**（Threadshare 内部 owner）：`{ repositoryKey, worktreeKey, publicRepositoryIdentity, rootRealpathDigest, commonDirectoryIdentity: { device, inode }, memoryRoot: ".threadshare/memory" }`。repositoryKey/worktreeKey 由本机 origin secret 派生；publicRepositoryIdentity 必须经过 credential/query/fragment 净化。绝对路径只存 repository_bindings 表，不进入任务 stdout、git 或 MCP。project 解析为零个或多个 repository 时均硬失败；调用方必须显式指定唯一 repository/worktree 后重试。

**`RestrictedExtractionRunner@v1`**（runner profile）：`{ adapter: claude-cli | codex-cli, version, argvTemplate（参数白名单）, toolPolicy: none, network: model-only, ephemeral: required, timeoutMs, maxOutputBytes, conformance: { testVersion, passedAt, cliVersionFingerprint } }`。**conformance 记录缺失或指纹失配 → 该 profile 不可用**。Codex profile 的 argv 固化 exact model/HTTPS endpoint、空 MCP 配置与全部 deny flags；运行时只复制认证材料到一次性 home，不加载用户配置、规则、Skills 或插件，结束后删除。

**`RunnerExecutionPlan@v1`**：`{ planDigest, taskKind, taskId, runnerInputDigest, inputCoverageDigest, inputCoverage: [ { sourceKind, opaqueSourceId, revision, contentDigest, bytes, truncated } ], runnerProfile, provider, model, endpoint, bytesToSend, localSessionPersistence: none, providerRetention: unknown | no-retention | provider-policy, authorization: pending | approved }`。`runnerInputDigest = sha256(exact stdin bytes)`；planDigest 覆盖除 authorization 决定外的完整 canonical plan。批准只对该 digest 生效，执行前重新计算 stdin digest 并比对。MCP 只能产生 `pending`；CLI 交互确认或 `--approve-plan <digest>` 转为 approved。`providerRetention` 如实展示，不得伪装为本机可保证属性。

`authorizationPlanDigest` 只存 tasks 表的调度元数据，不进入被哈希的 Runner stdin。dispatcher 只有在 taskId 与重新计算的 runnerInputDigest 同时匹配 approved plan 时才启动 Runner，从结构上避免 task digest 与 plan digest 的自引用。

**`AuthorizationManifest@v1`**（批量授权，自查增补）：`{ manifestDigest, plans: [ { planDigest, taskKind, taskId, bytesToSend } ], totalBytes, authorization: pending | approved }`。一次交互确认批准清单内全部 planDigest；逐 plan 生效、逐 plan 失效；清单只覆盖生成时已存在的 pending plan，不构成对未来任务的授权。

**`ExtractionTask@v1`**（Threadshare → Runner，stdin）：

```
{ taskId, lease,
  binding: { databaseUuid, owner: { repositoryKey, worktreeKey },
             sourceInputDigest,
             selection: { requestDigest, resultSetDigest, sourceBindingDigest },
             turnRevisions[], payloadDigests[],
             deliveryEdgeRevisions[], promptVersion, schemaVersion, chunkerVersion,
             provenance: { snapshotSeq, evaluatedAt } },
  session: { project, repositoryKey, timeWindow },
  evidenceCatalog: [ { evidenceId, kind: commit|turn|path,
                       pointerDigest, display } ], ← opaque id，Runner 仅能引用；
                                                    relation/strength 仅存 Threadshare 侧
  chunk: { turnRange, coverage, transcript },
  context: { sceneIndexSummary },                 ← 仅供归类参考，无候选池
  contract: { draftSchema, prompts } }
```

**`CandidateDraftBatch@v1`**（Runner → Threadshare，stdout）：仅候选，无裁决：

```
{ taskId, binding,
  candidates: [ { content, type, priority, confidence, scene,
                  statements: [ { statementId, text, evidenceIds[] } ] } ] }
                  ← Runner 不自报 provenance/limitations/claimSupport；
                    任意 LLM statement 初始 claimSupport=unverified
```

**`EvidenceAssessment@v1`**（Threadshare 内部派生）：`{ candidateId, statementId, citations: [ { evidenceId, pointerDigest } ], provenanceStrength: direct|observed|candidate|contextual|unknown, limitations[], claimSupport: unverified|typed-fact|human-confirmed, assessedBy: deterministic|human, revision }`。`provenanceStrength` 仅由 Delivery Trace relation/fact 派生；`typed-fact` 仅允许 versioned allowlist renderer 产生，LLM 不得写入。review 后的人工确认绑定 statement text digest、citations digest 与 assessment revision，任一漂移即失效。

**`AdjudicationTask@v1`**（Threadshare → Runner）：draft 批次 + Threadshare 召回的**统一候选池**（每条既有条目携带 revision，进入本任务 binding 的 CAS）：

```
{ taskId, lease,
  binding: { databaseUuid, memoryStateUuid,
             owner: { repositoryKey, worktreeKey },
             draftBatchDigest,
             approvedProjection: { generation, analyzerVersion },
             candidateProjection: { generation, analyzerVersion },
             recallAlgorithmVersion, recallQueryDigest, resultSetDigest,
             poolItemRevisions[], promptVersion, schemaVersion },
  drafts: [...],
  recallSets: [ { draftRef, ordered: [ { rank, sourceKind, id } ] } ],
  pool: [ { sourceKind: approved|candidate, id, revision,
            contentDigest, state, content 摘要 } ],
         ← 含 approved 条目 + 其他 chunk 未丢弃的 draft/quarantined 候选
  contract: { resultSchema, prompts } }
```

**`AdjudicationResult@v1`**（Runner → Threadshare）：

```
{ taskId, binding,
  adjudications: [ { draftRef, action: store|skip|update|merge,
                     targetIds[], mergedFields? } ] }
```

**`ConsolidationPatch@v1`**（归纳 Runner → Threadshare）：scene/doctrine 的声明式变更集，Threadshare 校验容量与路径后经隔离区/审批应用。

**`PromotionPlan@v1`**（审批对象）：`{ planId, owner: RepositoryBinding, candidateIds[], assessmentDigest, perFile: [ { targetPath, targetBlobHash|null, sanitizedContentDigest } ], policyVersion, diff }`。执行时重解析 owner，并逐项校验 assessment、blob hash 与 policyVersion；`targetPath` 必须位于固定 memoryRoot 且整条路径无 symlink。任一漂移即作废重审。

## 6. 核心流程与算法

### 6.1 阶段①：选材（Threadshare，确定性）

选材前必须提供 `MemoryExtractionRequest@v1`：canonical UTC `window.after/before` 必填、非空且最长 366 天；可选全文 query，以及 provider、opaque session key、Tool/Skill capability key、result evidence、capability terminal state 过滤。调用方不能传 projectKeys 或 closure；Threadshare 从显式 CLI repository 参数或当前 worktree 解析唯一 `RepositoryBinding@v1`，推导注册 worktree 的 project/repository keys，并强制加入 `hard-sealed`。因此“回看 Insights”永远至少受时间窗、owner 与 closure 三重限制，不存在默认遍历全部库的路径。完整匹配超过 200 Turns 时以 `TS_QUERY_TOO_BROAD` 拒绝，绝不静默取前 N。

project 映射不是 owner 选择规则：零映射或多映射均返回稳定诊断，用户必须指定唯一 repository/worktree；后续查询、task 与状态写入均按该 owner 过滤。Search 后按 selected Turn 的 `(sessionKey, turnKey, revision)` 生成 `resultSetDigest`；逐 session 完整分页回读 Turn Evidence 和 Delivery Trace，再以 Turn revision、evidence payload digest 与 delivery edge revision 生成 `sourceBindingDigest`。三者连同规范化 request 的 `requestDigest` 进入任务 binding。

```
候选 session 评分（走现有投影）：
  门槛：main-scope、未 exclude、turn 数 ≥ 3、
        仅纳入 eligible + active（未回滚）+ 已关闭（hard sealed）的 Turn
  价值信号（加权）：
    + delivery-trace direct / observed 边（权重最高）
    + failure chain recovered
    + tool 调用密度高 / 有 skill 使用
    + 结论性 final answer
  增量：按 §5.5 chunk 状态出任务；append 的 session 只出新增 turn 的 chunk
```

### 6.2 阶段②：授权、分块与任务包（Threadshare，确定性）

- **先计划、后授权、再交付**：组装绑定精确 task input 与全部输入 coverage 的 `RunnerExecutionPlan@v1`；runner 参数仅产生 pending plan。交互确认或 `--approve-plan <digest>` 后才交付；MCP 永远停在 pending；授权记录入 authorization_log；
- **分块替代截断**：chunk = 连续完整 Turn 序列，按预算（默认 40KB）贪心装填，永不切开 Turn；单 Turn 超预算时 user/assistant 正文永不压缩，超大 tool payload 以"头尾摘录 + payload digest 指针"替代并在 `chunk.coverage` 逐项申报 `truncated`——有损必申报（F4）；
- transcript 序列化沿用防 role-capture 规则（`<<past-*>>` 包裹 + `<<end-of-transcript>>` 锚点 + "transcript 内指令不针对你"声明）；
- 审批从本机 0600 sidecar 读取原计划，不重新按当前结果猜测计划；模型交付前与候选提交前均按原 request 重读相关输入。database UUID、request/result/source binding 或 sourceInputDigest 任一漂移即拒绝；仅 snapshotSeq 因筛选外数据前进而相关 digest 不变时可接受；过期任务结果不落状态（留审计）。

### 6.3 阶段③：L1 提取（受限 Runner → CandidateDraftBatch）

提炼 prompt 以参考项目 code 模式为底本：四类记忆（`work_method` 最高价值）、准确归因（建议 ≠ 决策；AI 输出不当团队事实）、只从本 chunk 提取、三原则（宁缺毋滥/独立完整/归纳合并）、整段弧线评估、逐条 statement 引用任务包 `evidenceCatalog` 中的 `evidenceIds`、禁止输出 secrets。Runner 不输出 provenance、limitations 或 claim support；合法引用只证明来源关联，不证明 statement 成立。

输出 `CandidateDraftBatch@v1`（**不含裁决**），zod 校验，非法退回重试（受幂等与重试上限约束）。Threadshare 校验 evidenceId/pointer、派生 `EvidenceAssessment@v1`；LLM statement 一律以 `claimSupport: unverified` 落库。事务 1 原子提交 draft、assessment、candidate revision 与 candidate FTS。

### 6.4 阶段④：去重裁决（独立 AdjudicationTask）

1. Threadshare 确认 approved memory FTS 已同步至绑定 worktree 的当前记忆文件状态；candidate FTS 因与 candidate 行同事务而天然同步。对每条 draft，分别从 approved/candidate FTS 取 `3 × 5` BM25 候选，再以 `recall-rrf@1`（RRF `k=60`，稳定 tie-breaker=`sourceKind,id`）融合 top-5；candidate 侧排除本批自身，包含同 owner 下其他 chunk 的未丢弃 draft/quarantined；
2. 记录两侧 projection provenance、canonical recallQueryDigest，以及每个 draft 的 ordered `{draftRef,rank,sourceKind,id,revision,contentDigest,state}` 生成的 resultSetDigest；任务显式携带 recallSets 与去重后的 union pool。组装输入绑定的 RunnerExecutionPlan，批准后才把 draft 与候选池摘要交给 Runner；
3. Runner 单次批量裁决 `store / skip / update / merge`（target_ids，多对多、跨 type，merge 时时间戳并集、priority 酌情调整）；
4. 提交时 Threadshare 在最新已同步投影上**重跑同一召回并比对 resultSetDigest**。generation 变化但结果集相同可接受；新条目进入、排序变化或池内 revision/content/state 漂移则 stale 重出；
5. 对 candidate target 逐项执行 revision CAS；裁决、候选 revision/FTS 更新、候选置 quarantined、chunk 置 extracted 在事务 2 原子提交；
6. **裁决解析失败**：重试一次；再失败置 `adjudication: failed` 待人工复核——绝不凭不可解析输出执行 update/merge，也不静默丢弃。

### 6.5 阶段⑤：状态机、审批与晋升（带 git 内容 CAS）

```
candidate: draft ──裁决通过──► quarantined ──plan 应用──► promoted
             └─校验失败/超期──────────────────────────► discarded
git entry:                                           approved ──被替代──► deprecated
```

1. `threadshare memory review`：按 statement 展示正文、证据摘录、公开 evidence、`provenance_strength`、limitations 与 `claim_support`，不把关联强度表述为内容证明；
2. 确定性 typed-fact statement 可保持 `typed-fact`；其他生成性 statement 必须逐条确认，确认记录绑定 statement/citations digest 并转为 `human-confirmed`。只有全部 statements 均非 unverified 才生成 `PromotionPlan@v1`；“批准全部”只对全 typed-fact entry 开放；
3. plan 绑定 RepositoryBinding、assessmentDigest、净化内容、目标文件 blob hash、策略版本与 diff；**用户显式批准 plan 是进入工作区的唯一通道**。`adjudication: failed` 候选单独处理；
4. 净化管线（写入前，确定性）：剥离全部本机引用（仅存 evidence_refs 表）→ secret lint（正则 + entropy，硬门禁）→ frontmatter / 容量 / slug 校验；
5. **执行时重解析 owner，并逐项校验 assessment、blob hash 与 policyVersion**；目标必须在绑定 worktree 的固定 memoryRoot 内，路径任一层是 symlink、inode 漂移或越界均 fail-closed。任何漂移都使 plan 作废并要求重新生成 diff、重新批准；
6. promote **只修改绑定工作区**，不自动 stage/commit/push；git 提交与 PR 由用户走常规流程（团队复核在此发生）；promotion journal 保证崩溃后可恢复/幂等重放。

### 6.6 阶段⑥：L2/L3 归纳（周期性，声明式）

触发：每累计 N 条（默认 20）新 approved 条目，或显式 `memory consolidate`。归纳 Runner（同样经输入绑定授权与 conformance 门）读 scene 索引 + 新增条目，提交 `ConsolidationPatch@v1`；Threadshare 应用时强制容量约束（默认 UPDATE 不 CREATE、每批最多新建 1 个、≥12 建议合并 → 14 禁止新建 → 15 必须先 MERGE 并删除旧文件、heat 规则、矛盾写"演化记录"）；doctrine 只喂变化场景，五道过滤 + 四策略。归纳生成内容同样是 unverified，须经逐条人审、隔离区与 owner-bound PromotionPlan 才能写工作区。

### 6.7 Skill 提取（独立契约）

沿用参考项目 v2 捕获哲学："When in doubt, capture"；判定标准"同团队下次会受益"；具体 ID/路径是要参数化的占位符；拒绝清单四条（secrets、无诊断路径的裸日志、纯瞬态、已被覆盖改 update）；输出 SkillCandidate 或精确 `Nothing to save.`；去重三层（预注入清单 ≤20 全量、超出 BM25 关键词筛选 → name 唯一 → 撞重转 update）；无 delete；生成内容默认 unverified，经逐条人审、隔离区与 owner-bound PromotionPlan 落至 `.threadshare/memory/skills/`。

## 7. 召回与使用（消费面）

"稳定直注 + 索引导航 + 工具按需"三层策略，装配经显式 provider adapter：

| 层 | 方式 | 实现 |
|---|---|---|
| L3 doctrine | 全文进上下文 | `assemble --provider claude` 生成/维护 CLAUDE.md import（用户显式执行） |
| L2 scenes | 只注入索引（路径 + heat + summary） | assemble 生成导航块；正文 Agent 用 Read 自取 |
| L1 entries | 按需检索 | MCP `threadshare_memory_search`（memory FTS，snapshot / coverage 语义）；导航块建议"每轮 ≤3 次"（软约束） |
| L0 | 已有 | 现有 insights query / recipe / evidence 工具 |

团队同步 = `git pull`；新成员 clone 后执行一次 `assemble` 完成"读档"。

## 8. 分阶段实施

### Phase 1 — 记忆库与提炼 MVP

存储与索引：

1. `.threadshare/memory/` 文件格式 + memory-state 表结构定稿（含全部 §5.6 契约 JSON Schema）
2. memory-state 事务库（Rust 引擎管理）：RepositoryBinding、claim/lease、幂等提交、candidate revision + candidate FTS + assessment 同事务、promotion journal、authorization log
3. memory ingest：collection 协议 + Rust 表组 + schema migration（含 crash recovery 测试）
4. approved memory FTS 投影（影子重建、build cursor、incremental-vs-clean 等价证据）+ 双投影召回 adapter（BM25 各取 3 × k、versioned RRF）
5. Query 层 `memory-entry` resource + JS 客户端

工作流：

6. Runner 基础设施：claude-cli + codex-cli profile、**deny-all conformance test**（对抗性探针 + 指纹记录 + 失效重测）、ephemeral/一次性 home 强制、超时/输出上限、无合格 Runner 即拒绝交付的硬失败路径
7. 执行授权：精确输入绑定的 `RunnerExecutionPlan@v1`、交互确认 / `--approve-plan <digest>`、MCP pending 语义、authorization log
8. `memory init / review / promote / lint / assemble` CLI；唯一 owner 解析、逐条 claim review、PromotionPlan assessment/blob CAS、no-follow 原子写入、净化管线
9. 两阶段提炼任务：显式有界筛选请求、worktree/hard-sealed 强制 scope、完整 Turn + Delivery Trace 回读、三层 selection binding、chunk 切分与 coverage 申报、ExtractionTask / AdjudicationTask 组装、双投影召回、candidate revision CAS、chunk 级游标（`memory extract` CLI；MCP 可生成 pending preview，不能授权或执行）
10. 提炼 prompt 资产（L1 code 模式 + 防 role-capture + 批量裁决），随包分发
11. `threadshare_memory_search` / `threadshare_memory_status` / `threadshare_memory_extract_preview` MCP 工具；preview 只落本机 0600 pending artifact，响应不含 transcript

验收（全链路之外的专项）：

- **Conformance**：对抗性探针验证 Claude/Codex profile 拒绝 shell/文件/MCP/任务外网络且无副作用；CLI 二进制或 profile 变化触发重测；`npm run test:memory-codex-live` 必须用真实 Codex 完成 conformance、L1 提取、裁决、L2/L3 归纳、人工确认后的晋升与 Codex adapter 装配，并证明不新增可索引 Session；fake runner 只用于超时、漂移、网络违规等确定性故障注入，不能作为 Runner 可用性验收；
- **授权**：MCP 与仅指定 runner 均只产生 pending plan；未批准 digest 不交付任何输入；用相同字节数替换 transcript 或候选池内容时 runnerInputDigest/inputCoverageDigest 必须变化并要求重新确认；manifest 批准后修改其中一个 task 的输入，仅该 plan 失效、清单内其余 plan 照常执行；runner 运行不产生新的可索引会话；
- **事务**：并发 claim 竞争唯一持有；candidate 行、revision、FTS、assessment 与游标推进同事务的逐崩溃点注入；同 taskId 重复提交幂等；promotion journal 半途崩溃恢复；apply 全程跨进程互斥，并在 mutation 前重验 candidate/assessment/policy 快照；
- **CAS/召回**：无关会话同步推进 snapshotSeq 时任务不失效；相关 turn revision 漂移拒绝；approved/candidate 任一侧新条目进入 top-5 或池项 revision/content/state 漂移均使任务重出；projection generation 变化但 resultSetDigest 相同则接受；并发 merge 同一 candidate 仅一个 revision CAS 成功；跨 chunk 重复被捕获；
- **证据**：任务外/虚构 evidenceId 校验失败；把合法 direct commit evidenceId 挂到无关生成 statement 时，只能得到 provenance，claimSupport 仍为 unverified；未逐条确认不得生成 PromotionPlan；typed-fact renderer mutation test 证明 LLM 不能伪造 typed-fact；
- **owner/晋升**：project 多仓映射硬失败；在另一 worktree 执行 plan、目标父目录或文件为 symlink、路径越过 memoryRoot、批准后 git pull/assessment 漂移均作废或 fail-closed；promote 不产生任何 git 历史操作；
- **隐私**：含 secret 候选被净化门拦截；grep 确认 git 内无任何 provider session id。

### Phase 2 — 归纳与装配

12. L2/L3 consolidate 契约与 prompt；13. 选材评分固化为 Recipe `extraction-candidates@1`；14. assemble adapter 扩展。原第 15 项 Codex runner 重评估已前移为 Phase 1 完成门，不计入 Phase 2。**Phase 2 已于 2026-08-21 完成**：真实 `codex-cli 0.149.0` 跑通提取 → 裁决 → 非空归纳 Patch → 逐 operation 人审 → 可恢复晋升 → `AGENTS.md` 装配；MCP 保持 pending-only。归纳输入改由 Rust descriptor-relative no-follow 安全读取，完整 L1/Scene/Doctrine 源树、replay epoch、assessment/policy 快照在 submit/review/plan/apply 阶段 fail closed；promotion 以跨进程锁与状态 CAS 保证单 owner，并用同目录 no-replace conditional displacement 避免覆盖或删除并发外部编辑；发布包与 Skill 已同步。

### Phase 3 — Skill 提取与跨仓共享

16. Skill 提取契约；17. 跨仓共享**保持未设计**：立项需独立 ADR + endpoint + storage wrapper 与显式裁剪层，不复用现有 shares API（F8）

### 工程硬约束

新增 `src/*.mjs` 同步 files 白名单与 `verify-release.mjs` 门限；测试 `node --test` 一一对应；Rust 投影变更需 migration / shadow rebuild / crash recovery / 等价证据（ADR-0001）；Windows 无 insights 引擎，memory 功能限定 macOS / Linux；不引入第二个 scan-on-query 数据面。

## 9. 与参考项目的差异总表

| 模块 | 本方案 | 相对参考项目的变化 |
|---|---|---|
| L0 采集 | 已有（session 文件 + insights） | 省掉整个 Proxy |
| 触发编排 | 批处理 + 事务性 chunk 游标 + 选材评分 + 相关输入 CAS | 无实时编排；新增一致性/幂等/授权语义 |
| 提炼执行权限 | conformance test 证明的受限 Runner + 精确 task input digest 授权；无合格 Runner 即拒绝 | 参考项目给 L2 LLM 目录内文件工具；本方案将能力限制与内容授权分开 |
| 提取/去重编排 | 两阶段任务（draft → 召回 → 裁决），各自 lease/幂等 | 参考项目单 worker 串行（无此问题域） |
| 长会话处理 | 按 Turn 分块全量 + coverage 申报 | 参考项目头尾截断（事后场景弃用） |
| 去重算法 | 两阶段沿用；approved/candidate 双 FTS 各取有界 BM25 候选，versioned RRF 融合；LLM 批量裁决；解析失败人工复核 | 参考项目单一候选库且失败 fallback store |
| L2/L3 | 模板、容量约束、heat、增量演进沿用 | 执行改声明式 patch |
| Skill | v2 捕获哲学、防 role-capture、输出契约沿用 | agent-neutral 存放 + assemble 装配 |
| 存储 | Insights approved 投影 + git 净化真相源 + 单一事务状态库（含 candidate FTS）；owner 显式绑定 | 参考项目 SQLite/VDB 真相源、无净化分层、无事务化状态 |
| 证据模型 | confidence + provenance strength + claim support + limitations；关联来源由 Threadshare 派生，生成陈述仍须 typed fact 或人审 | 参考项目仅 priority |
| 审核/晋升 | 状态机 + owner-bound PromotionPlan（assessment/blob/policy CAS + no-follow writer）+ 用户批准 + PR | 参考项目审核流未实现 |
| 召回 | 三层注入沿用；消费用 memory FTS；去重用 approved/candidate 双投影 + RRF；显式 assemble | 暂不做 embedding |

## 10. 风险与开放问题

| # | 风险 / 开放问题 | 倾向与缓解 |
|---|---|---|
| R1 | 提炼质量依赖 Runner 所用模型 | 契约层强校验；prompt 版本化进 CAS；profile 可配模型（换模型需重新授权） |
| R2 | 隐私进入 git 历史 | transcript 只进合格 Runner（出网经显式授权）→ 候选只在 0600 事务库 → 净化管线 + secret lint → PromotionPlan 批准是唯一通道 → PR 复核兜底 |
| R3 | 本机并发 | claim/lease 序列化；团队 git 并发由 PromotionPlan blob CAS 处理 |
| R4 | 个人私有记忆归属 | Phase 1 仅 repo scope；个人 scope 列为开放问题 |
| R5 | 记忆库膨胀 | 容量硬约束逼合并压缩；deprecated 归档；无时间衰减 |
| R6 | 非 git 项目 / 跨仓库经验 | Phase 1 不支持；与 Phase 3 独立 ADR 一并设计 |
| R7 | 分块全量比截断多耗 LLM | 接受（正确性优先）；选材控制总量；预算可调 |
| R8 | `--regenerate-secret` 状态迁移 | 按 chunkDigest 尽力迁移，失败回 pending |
| R9 | Runner 参数或 CLI 升级重新打开 ambient capability | profile 固化全部 deny 参数；二进制内容/profile digest 变化使签名 conformance 失效；真实 Codex live gate 作为发布前专项验收，失败即拒绝交付 |
| R10 | conformance test 的探针覆盖不完备 | 测试用例随包版本化、可追加；指纹绑定 CLI 版本，升级即重测；缺陷按安全 issue 流程处理 |
| R11 | 模型服务端可能留存 transcript（providerRetention 无法由本机保证） | RunnerExecutionPlan 如实申报 providerRetention（默认 unknown）；团队可在 profile 中固定为已签约 no-retention 的端点；这是授权决策的输入而非技术保证 |
| R12 | 生成性记忆逐条确认降低审核吞吐 | 接受（可信度优先）；“批准全部”仅开放给确定性 typed-fact；review UI 把 statement 与证据并排，减少确认成本 |
| R13 | approved/candidate 双投影可能漂移或排序不一致 | candidate 行与 FTS 同事务；approved 投影先 sync；召回算法/analyzer 版本化；提交重跑并比较包含 revision/content/state 的 resultSetDigest |

## 附录 A：参考项目调研结论（要点）

对 TencentDB-Agent-Memory（MemoryProxy / MemoryCore / MemoryKnowledge / MemoryPanel）的源码级调研结论，作为本提案算法部分的出处：

- **分层记忆**：L0 对话 → L1 原子（LLM 情境切分 + 提取，单次调用）→ L2 场景（agentic 沙箱写文件，容量三级预警逼合并）→ L3 画像/守则（增量演进，只喂变化场景）。一轮完整提炼最少 4 次 LLM 调用，全走低成本模型。
- **去重**：向量/BM25 仅做 top-5 召回、无相似度阈值，判重交给单次批量 LLM 裁决（store/skip/update/merge，统一候选池、多对多合并、时间戳并集）；解析失败 fallback store（本方案改为重试 + 人工复核）。
- **检索**：查询即清洗后的最新用户消息（无改写）；FTS5 BM25（jieba）与向量各取 3 倍候选，RRF（k=60）融合取 top-5；默认关闭 embedding、纯 BM25 可跑。
- **注入**："L3 全文 + L2 索引直注（stable、cache 友好），L1/L0 只暴露只读工具按需查"。
- **Skill 提取**：round 累积触发归档 + 后台 worker；抽取器为 ≤16 轮 tool-calling 的 Review Agent（6 工具、无 delete）；prompt v1→v2 从"高精度闸门"（46% 召回）转向"when in doubt, capture"；防 role-capture 用 `<<past-*>>` 包裹（有生产事故记录佐证）；去重靠预注入清单 + name 唯一键 + 撞错自愈。
- **批量导入（事后模式）**：完全复用实时路径 HTTP 契约，客户端只补节流、断点、ETA。
- **团队共享**：统一 Asset 登记 + 五级可见性 + allow-only ACL + fixed binding 装配；默认 private 且 admin 亦不可读；审核流未真正实现。
- **已确认缺陷（不继承）**：recall 软超时不 abort、hybrid 路径 scoreThreshold 失效、同毫秒游标丢数据 TODO、L2 沙箱 LLM 持有目录内文件工具、"每轮 ≤3 次工具调用"仅 prompt 约束。

## 附录 B：设计审查意见对应表

### 第一轮（rev1 → rev2）

| 审查意见 | 结论 | 落点 |
|---|---|---|
| 1. [Blocking] "git 工作区即沙箱"不是安全边界 | 采纳 | rev2 声明式契约 → rev3 Runner 机制 → rev4 conformance test（见第三轮 #1） |
| 2. [Blocking] 头尾截断静默丢中间内容；任务未绑定快照一致性 | 采纳 | §6.2 分块 + coverage 申报；chunk 级游标；限定 eligible/active/closed Turn |
| 3. [Blocking] regex/entropy/PR 不足以防隐私进 git 历史 | 采纳 | 净化分层；git 内无 session 引用；批准是唯一通道 |
| 4. [Blocking] 证据强度与晋升门不足 | 采纳 | confidence/strength/limitations + 完整 hash + 仓库身份；逐条 statement 证据；状态机；裁决失败人工复核 |
| 5. [Important] adapter 不会自动获得 FTS/查询能力 | 采纳 | D3 明确范围；Phase 1 拆出 ingest/投影/resource/客户端 |

### 第二轮（rev2 → rev3）

| 审查意见 | 结论 | 落点 |
|---|---|---|
| 1. [Blocking] 宿主权限无法由 MCP 收窄，缺可执行 owner | 采纳 | Runner 机制（rev4 进一步补 conformance，见下） |
| 2. [Blocking] chunk/候选/游标无事务与幂等语义 | 采纳 | memory-state 事务库（rev4 收全部状态入库，见下） |
| 3. [Blocking] 全局 snapshot CAS 过严且相关依赖不完整 | 采纳 | D4：snapshotSeq 降为 provenance；相关输入 CAS |
| 4. [Blocking] Phase 3 与 provider 输出跨越公共契约 | 采纳 | 共享面未设计（D6）；真相源 agent-neutral + assemble adapter |
| 5. [Important] append-only 与稳定 ID 矛盾 | 采纳 | "当前文件可更新，历史由 git 保存"；`superseded_by` |

### 第三轮（rev3 → rev4）

| 审查意见 | 结论 | 落点 |
|---|---|---|
| 1. [Blocking] Codex Runner 无法证明"零工具"，profile 声明≠资格 | 采纳并持续由 live gate 收口 | D1：资格始终由 deny-all conformance + 二进制/profile 指纹证明；Codex 0.147.0 的 Phase 1 与 0.149.0 的 Phase 2 均采用 feature deny + fail-closed code-mode host + 一次性 home，并由真实 live gate 验证；F9、R9/R10 |
| 2. [Blocking] SQLite 事务不能包含外部 sidecar/quarantine 文件 | 采纳 | D4/§5.5：candidates、evidence_refs、submissions、chunks 全部入 memory-state 表，单事务；git 写入改独立 promotion journal（可恢复重放）；F11 |
| 3. [Blocking] 提取与逐候选去重存在循环依赖 | 采纳 | D4 两阶段任务：ExtractionTask→CandidateDraftBatch → Threadshare 召回 → AdjudicationTask→AdjudicationResult，各自 taskId/lease/binding/幂等；§5.6 契约拆分；§6.3/6.4 重写 |
| 4. [Blocking] 原始 transcript 出网缺显式授权契约 | 采纳 | D1：RunnerExecutionPlan@v1；CLI 显式参数=授权、MCP 仅 pending；no-session-persistence 强制（防反馈回路）；authorization_log；F10；验收项 |
| 5. [Blocking] review→promote 之间没有 git 内容 CAS | 采纳 | D5：PromotionPlan@v1 绑定 blob hash + 净化内容 digest + 策略版本，漂移作废重审；promote 只改工作区不碰 git 历史；promotion_journal；验收项 |

### 第四轮（rev4 → rev5）

| 审查意见 | 结论 | 落点 |
|---|---|---|
| 1. [Blocking] 证据强度由不可信 Runner 自报，虚构引用可进入批量批准；entry 级强度归约未定义 | 采纳 | §5.6：ExtractionTask 下发 opaque evidenceCatalog，statements 只含 `evidenceIds[]`（Runner 不自报 strength/limitations）；D5：Threadshare 校验 id 归属 + 按 Delivery Trace 规则派生 effective strength，entry 取最弱、limitations 取并集，全 direct/observed 才可批量批准；§6.3/§6.5；验收"证据"组 |
| 2. [Blocking] 去重 CAS 未绑定召回结果集（新条目挤入 top-5 不可见；投影 freshness 未检查；跨 chunk 候选不在池内） | 采纳 | D4"裁决绑定召回结果集"：binding 增 projectionRevision + recallQueryDigest + resultSetDigest，提交时重跑召回比对；召回前投影须同步；池含跨 chunk draft/quarantined 候选；§5.6/§6.4；验收三用例 |
| 3. [Important] ephemeral 混淆本机会话与模型服务端留存 | 采纳 | D1 / §5.6 / 摘要第 4 条：拆分 `localSessionPersistence: none`（本机可保证）与 `providerRetention: unknown/no-retention/provider-policy`（如实展示、不承诺）；R11 |

### 第五轮（rev5 → rev6）

| 审查意见 | 结论 | 落点 |
|---|---|---|
| 1. [Blocking] Delivery Trace 关联强度被误作自然语言陈述可信度 | 采纳 | F5、摘要 #7、D5、`EvidenceAssessment@v1`、§6.3/§6.5：拆分 provenance strength 与 claim support；LLM 陈述默认 unverified；仅 typed fact 或逐条人审可晋升；对应验收 |
| 2. [Blocking] task/candidate/PromotionPlan 未绑定 repository/worktree owner，可能写错仓库 | 采纳 | F12、摘要 #9、D4 owner 模型、`RepositoryBinding@v1`、全状态 owner 字段、PromotionPlan owner CAS；§6.1/§6.5；多仓/错 worktree/symlink/越界验收 |
| 3. [Blocking] 跨 chunk 候选池使用未定义的 candidate revision 与检索投影 | 采纳 | D3 双持久化投影；§5.5 candidate revision/contentDigest/candidate FTS 同事务；AdjudicationTask 双投影 binding；§6.4 BM25 + RRF、逐项 revision CAS；并发验收 |
| 4. [Important] RunnerExecutionPlan 未绑定实际 task 输入，候选池变化可复用授权 | 采纳 | 摘要 #4、D1、`RunnerExecutionPlan@v1`：绑定 task/input/coverage digest 与全部输入来源；runner 参数仅建 pending plan，交互或 digest 批准；同字节换内容验收 |

### 第五轮后自查增补（rev6 内）

| 发现 | 落点 |
|---|---|
| 1. [Important] 逐任务唯一 digest × 两阶段任务导致批量提炼授权确认次数爆炸（50 chunk ≈ 100 次确认） | D1 / 摘要 #4 / §5.6 `AuthorizationManifest@v1`：一次确认一组逐个列明的 plan digest，逐 plan 生效与失效，不覆盖未来任务；authorization_log 增 via: manifest；验收补 manifest 局部失效用例 |
| 2. [Important] approved memory ingest/投影未声明按 (repositoryKey, worktreeKey) 分键，同仓多 worktree 互相污染 | D3 增补分键声明，与 §6.4"同步至绑定 worktree"及 owner 模型对齐 |
| 3. [Minor] `rankerVersion` 与 `recallAlgorithmVersion` 命名不一致 | §5.5 candidate_projection 统一为 `recallAlgorithmVersion` |
