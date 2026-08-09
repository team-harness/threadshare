---
status: active
created: 2026-08-09
work: ../work/epic-local-session-insights.md
---

# Threadshare 本地 Session Insights

## 起点

Threadshare 已能发现、导出和分享 Codex、Claude Code 与 Paseo 的原生 session，但当前只面向单次会话读取与展示。用户无法从长期历史中回答：哪些 Tool 或 Skill 经常使用、它们参与了哪些问题、后续是否出现验证或纠错，以及过去的相似问题采用过什么工作路径。

这些信号已经部分存在于原始 session：Codex 可通过结构化 Skill 注入确认 Skill 已加载，Claude Code 可通过 `Skill` tool call 及成功 result 确认 Skill 已加载；读取已知 `SKILL.md` 只能作为较弱证据。现有 exporter 会过滤隐藏 Skill 内容，且 `threadshare-history@v1` 没有 Skill entry，因此分析必须在过滤前从原始 session 派生，同时保持公开 History 不变。

2026-08-09 的本机基线约有 3,300 个 JSONL、4.56 GiB，最大单文件约 157 MiB；现有 listing 口径发现 3,266 个 canonical 候选，但该数字尚未按 `session_meta.thread_source/source.subagent` 排除独立 subagent rollout，不能称为 eligible main session。最近 400 个 Codex 文件中实测 156 个 `thread_source=subagent`，ITEM-1 必须按新 scope 规则重算 main/subagent/unknown 基线；当前字节与容量估算包含这些文件，因此只作为保守量级。现有 session 列表即使只展示 10 条，也需要递归发现并 stat 全部候选，本机实测 Codex 约 1.11 秒、Claude 约 0.88 秒；对最大文件做一次只解析 JSON 的流式基准约 5.48 秒、峰值 RSS 约 90 MiB。每次启动全量解析不可接受，性能必须由持久化增量索引解决，而不是依赖更快的全量扫描。基线会随 session 持续增长，只用于量级与架构判断，不作为固定产品计数。

对 1.37 GiB、约 30% eligible 原始字节做确定性分层抽样，并按本 Epic 的三字段 analyzer、64 KiB 文本 cap 与 token cap 复算后，估算当前约有 15,011 个可见 user Turn、28.5 MiB 问题文本、435 万 logical token、203 万 `(field, term, Turn)` posting 和 22–30 万 field-term；容量设计按 25,000 Turn、400 万 posting、40 万 field-term 留余量。约 53% 问题为中英混合，28% 主要为中文，19% 主要为英文，34% 带代码、路径、命令或 identifier 信号；因此不能采用英文空格分词或静态 stopword 表。问题长度 P99 约 50 KiB，最大超过 300 KiB；约 173 个 Turn 命中 8,192 token cap，3 个命中 distinct-term cap，索引文档必须有确定上界并报告 truncation。样本流式解析 1.47 GB 约 90 秒，首次全量回填是分钟级后台任务，不得阻塞 UI。

同一批语料中，Codex 结构化 Skill 确认加载为 106 次、命中 39 / 2,768 个 session；Claude `Skill` tool use 与成功 result 为 31 次、命中 30 / 492 个 eligible session；合计 137 次、覆盖约 2.1%。Tool call 信号普遍存在，但 Skill 确认加载相对稀疏。因此第一版以 Tool、Turn 和历史问题检索为主要价值，Skill 作为可下钻的观察维度；不得基于当前稀疏样本生成 Skill 优劣或推荐结论。

## 目标

提供本地优先的 `threadshare insights`：无感扫描用户已有的 Codex 与 Claude 原生 session，在不上传数据、不修改 Agent 行为的前提下，恢复 Tool 与 Skill 使用证据，关联到用户 Turn，并通过本地 Web Dashboard 展示使用量、执行可靠性、问题关联、结果证据和历史相似路径。Paseo 引用按需解析回同一原生 session，不形成第三套索引或 provider 统计。

## 范围

- 从原始 Codex、Claude session 被动恢复 Skill 加载；Paseo agent 引用只沿用现有 bridge 按需定位原生 session，不进入后台枚举热路径。
- 提取 Turn、Tool、Skill、问题文本与结果证据，生成版本化、可重建的本地派生索引。
- 新增单 session 分析、跨 session 聚合、问题搜索和有证据指针的 Tool 历史路径；Skill 只提供事实列表与关联问题。
- 新增只绑定 loopback 的本地 Dashboard；首屏、索引进度、证据覆盖率和不确定结果必须可见。
- 以流式、最新优先、可中断恢复的后台回填处理大规模历史；日常刷新只处理新增或变化数据。
- 随 npm 包交付预编译 Rust Insights Engine；用户只安装 Threadshare，不安装 Rust、SQLite 或本机编译工具链。

## 非目标

- 不上传原始 session、问题文本或分析索引，不增加账户、团队空间、云端数据库或公共排行榜。
- 不修改 `threadshare-history@v1`、分享 API、Cloudflare/FC 存储对象、公共 Viewer 或 Agent Markdown。
- 不要求用户、Codex、Claude 或 Paseo 安装 Hook、主动上报、手工打分或改变正常 Agent 工作流。
- 不建立 Skill 调用树，不把 Skill 加载成功、Tool completed 或用户沉默等同于问题解决。
- 第一版不归因 Codex/Claude subagent 活动或子 session，也不调用外部模型做问题分类；必须显示双 provider 的覆盖缺口。
- 第一版只承诺可解释的 lexical similarity，不构建向量索引、通用知识图谱或语义同义召回，也不把 lexical match 表述为语义等价。
- 不自研通用 LSM、Posting 压缩或图数据库文件格式；首版使用成熟事务存储与倒排实现，把自定义逻辑限制在 Threadshare 的文档模型、分词、排序和证据路径。
- 不把本地索引误述为原始数据没有新增风险；聚合问题文本会扩大本机集中暴露面，必须提供预读取排除和完整重置能力。

## 共享语言与概念边界

- **Skill 可用**：Skill 出现在运行时 catalog 中，只证明 Agent 可以选择它。
  - 不包括：Skill 已加载或已经参与问题；不得计入使用次数。
  - 关系 / 不变量：只有 session 内权威 catalog 可产出 `skill-catalog-entry`，用 keyed path fingerprint 将名称映射到同 session 的完整 read；catalog 不是使用证据，绝对路径不入 Fact。
- **确认加载**：Codex session 中 user role 文本以 `<skill>` 开头且包含结构化 `<name>` 子元素，或 Claude session 出现成功的 `Skill` tool call/result。
  - 不包括：Skill 工作流完成或问题解决。
  - 关系 / 不变量：`<skills_instructions>` catalog、assistant 复述和非首部 `<skill>` 一律排除；Skill 身份取自 `<name>`，不取自绝对路径。默认 Skill 使用量只统计确认加载，保留 provider、Turn、顺序和证据类型。
- **推断加载**：Agent 完整读取同一 session 内可观察 catalog 中已知的 `SKILL.md`，但 session 没有 provider 原生的确认加载事件。
  - 不包括：搜索、编辑、审查、引用路径或只读取片段。
  - 关系 / 不变量：catalog 只能来自同一原始 session 的权威记录，禁止读取当前文件系统或进程启动时 catalog 后回填历史；Codex 可使用 session 内 `developer:<skills_instructions>`，Claude v1 在没有 session 内 catalog snapshot 时不产出推断加载。推断与确认加载分栏展示，不能静默合并成同一置信口径。
- **结果证据**：同一 Turn 中或其后可观察到的 provider terminal state、exit code、Turn complete/aborted 和后续可见 user message 等原始事实，以及从这些事实生成的带版本 Projection。
  - 不包括：把普通文本直接当作测试通过、部署成功、用户确认/纠错，或对 Skill/Tool 的因果证明；Projection 证据不足时结果必须是 `unknown`。
- **事实（Fact）**：Provider Evidence Adapter 从权威原始记录中恢复、可用 evidence pointer 回查的观察值，包括 Turn、事件、Capability 身份与一次使用。
  - 不包括：`solved`、`effective`、`recommended`、问题类别或相似度等分析判断，也不包括 FTS token、rollup 和路径 family。
  - 关系 / 不变量：原始 session 是最终事实权威；事实进入 `Fact Model v1` 后保持 provider-neutral、稳定身份和原始观察口径，不能因当前 UI 或排名需要改写含义。
- **Evidence Event**：一个 session 内最小的有序观察事实，例如可见消息边界、Tool invocation/result、Skill catalog entry/确认或推断加载，以及 Turn complete/aborted。
  - 不包括：完整 Tool 参数/输出、Skill 正文、系统提示词、完整 thinking，或从多条事件推断出的成功结论。
  - 关系 / 不变量：顺序以 source byte offset 和 record 内数值位置为权威，时间戳只作观察字段；事件只存一份，可通过 `turn_evidence` 关联其发生 Turn、前后 Turn 或其他被它直接佐证的 Turn，也可通过 `capability_use_evidence` 关联 invocation、result 和 corroboration 等一次使用证据。Turn lifecycle/rollback 只关联 Turn，不能扇出到 Capability Use。
- **Capability / Capability Use**：Capability 是 provider-scoped 的 Tool 或 Skill 身份；Capability Use 是它在一个 Turn 中的一次观察使用，分别保存执行状态、evidence strength、调用来源范围和隐私安全的输入指纹。
  - 不包括：Skill 调用树、Tool 的因果贡献或把同名 Capability 自动解释为同一实现来源。
  - 关系 / 不变量：公开身份以 provider、kind 和 canonical name 为准；exact observed name、`originScope=main|subagent|unknown`、不暴露内容的可选 origin/input fingerprint 保存在每次 Use 上，用于诊断同名冲突和识别同输入重试，不污染共享 Capability 身份。v1 不以路径作为 Skill 身份；一次 Use 通过关联表引用一到多条 Evidence Event。默认统计与路径只包含 `originScope=main`，其余范围单列 coverage，不归因给父 Turn。
- **Projection**：只从已提交 Fact Model 派生、可删除重建的查询结构或分析结果，包括 FTS、逐字段统计、rollup、Tool 路径和未来的版本化 feature。
  - 不包括：Provider 原始记录、Fact、source checkpoint 或持久化排除规则。
  - 关系 / 不变量：每个 Projection 独立记录输入 fact schema、projection version、watermark 和 active/building/failed 状态；只改变 Projection 时不得重读 raw session。
- **分析 Turn**：一条 provider 权威可见 user message 到下一条权威 user message 之间的可见消息与能力事件。Codex 只以 `response_item/message/user` 为 user 边界，`event_msg/user_message` 只作重复记录校验；Claude 只以含可见文本的顶层 user record 为边界，tool-result-only record 不是边界。
  - 不包括：隐藏 Skill 注入、Claude tool result、Codex `event_msg:user_message` 孪生记录，以及仍有未决 Tool 的开放 Turn。
  - 关系 / 不变量：跨增量 append 必须保存开放 Turn、pending Tool 和 provider 记录类状态；generation 只保存结束事件、EOF、source mtime 等原始事实，读取/聚合时再按注入时钟派生 hard-sealed、quiescent 或 open 三态。
- **索引覆盖率**：已完成派生分析的 eligible canonical main session / Turn 与现有 session listing 候选总量之比，并区分 provider、确认证据和推断证据。
  - 不包括：准确率；部分索引期间所有聚合必须同时展示覆盖范围。
- **TurnDocument**：倒排索引的最小文档，一条权威分析 Turn 对应一个稳定文档；身份由 provider、canonical session id 和权威 user record 的起始 byte offset 确定。
  - 不包括：整个 session、单条 assistant message 或 Tool payload；open Turn 只能作为明确标记的 provisional revision。
  - 关系 / 不变量：同一 Turn 后续补入 Tool result 或 closure fact 时更新同一 document key；provisional revision 可被问题搜索命中，但不进入持久 rollup、Tool 证据路径或样本门槛；查询只读取一个已提交 Engine Snapshot。
- **Engine Snapshot**：Rust Insights Engine 在一个 SQLite 事务提交后可见的 Fact、active Projection、source checkpoint 和 projection watermark 状态。
  - 不包括：正在解析、尚未提交的 session delta，或 raw session 文件的当前瞬时内容。
  - 关系 / 不变量：一次查询固定在一个 snapshot；索引较 raw session 滞后时必须返回 pending/stale 状态，不能把旧结果伪装为最新。
- **Tool 证据路径**：lexical 候选 Turn 中按顺序观察到的 provider-scoped Tool 名称序列及其状态分布。
  - 不包括：Skill 调用树、因果路径或“最佳方案”。
  - 关系 / 不变量：路径必须能回到组成它的 Turn evidence；支持度按不同 Turn 与去重后的 session group 分开计数。main-scope Turn 只表示该 Turn 所属 Session 的 `sessionScope=main`；Turn 内的 subagent/unknown Event 或 Use 只排除对应能力归因，不会让整个 Turn 失去 main scope。只有至少 5 个 hard-sealed/quiescent、`providerVisibility=active`、main-scope Turn 且来自至少 3 个非空 `duplicateGroupKey` 才形成 evidence path；open、rolled-back、subagent/unknown scope、null group 与同一 resume/fork group 的重复 Turn 不计独立支持，否则只返回 raw matches 与 `insufficientSample=true`。其余章节只能引用该定义，不得另写门槛变体。

端到端场景：用户第一次在约 4.56 GiB 历史上运行 `threadshare insights`，本地服务先打开 UI 并展示索引进度，后台按更新时间从新到旧流式回填；用户关闭后 checkpoint 持久化，下次从已提交字节偏移恢复。暖启动直接读取派生索引，后台核对文件元数据；一个活跃 session 新增 JSONL 后，只读取上次完整换行之后的新字节，恢复其 open Turn 与 pending Tool，由对应 Provider Evidence Adapter 生成 `SessionFactsDeltaV1`，再原子提交新的 Engine Snapshot。用户点开 Skill 时看到确认/推断次数、相关问题和样本不足提示，但不会看到 Skill 正文、绝对路径或调用参数；Claude 没有 session 内 catalog 时只显示确认加载。未来新增“同输入 Tool 重试链”分析时，只从已提交 Evidence Event、input fingerprint 与 Capability Use 构建新 Projection，读取 raw session 为 0 bytes，也不修改 Codex/Claude Adapter。

## Provider 记录权威

| Provider | 事实 | 权威记录 | 排除 / 交叉校验 |
|---|---|---|---|
| Codex | 可见 user/assistant message | `response_item` 中 `payload.type=message` | `event_msg:user_message` 若存在只校验重复、不创建 Turn；`event_msg:agent_message` 只作 assistant 孪生校验，不创建可见消息 |
| Codex | Skill 确认加载 | user message 首部结构化 `<skill><name>` | catalog、assistant 复述和非首部出现排除 |
| Codex | Skill catalog | developer message 中结构化 `<skills_instructions>` | 产出不计使用的 `skill-catalog-entry`，只供同 session inferred-load 的 keyed path/name 校验，不进问题索引 |
| Codex | Tool invocation | `response_item` 的 `payload.type=function_call\|custom_tool_call` | `event_msg:*_begin` 只作覆盖诊断，不创建 Use 或 invocation Event |
| Codex | Tool result | `response_item` 的 `payload.type=function_call_output\|custom_tool_call_output` | `event_msg:patch_apply_end/mcp_tool_call_end/web_search_end` 等使用不同 correlation namespace，只作覆盖诊断，不创建 result/orphan Event |
| Codex | Turn started | `event_msg:task_started` | 归属其后第一个权威 user Turn；不能按 source order 归给前一 Turn；原生 `turn_id` 若存在只作关联交叉校验 |
| Codex | Turn complete / 放弃 | `event_msg:task_complete/turn_aborted` | 以匹配原生 `turn_id` 或 started->user->terminal 状态机关联当前 Turn；歧义时保留 orphan diagnostic、不猜配；隐藏 `<turn_aborted>` 只交叉校验 |
| Codex | compaction 生命周期 | 顶层 `compacted` / `event_msg:context_compacted` | `replacement_history` 内嵌消息不是可见消息，不计 Turn、不进问题索引 |
| Codex | file-level subagent scope | `session_meta.thread_source=subagent`，或 `session_meta.source.subagent.thread_spawn` 存在 | 整个 session 标记 `sessionScope=subagent`/`eligibility=subagent-excluded`，只保存 Session scope/coverage，不摄入 Turn/Event/Use；不保存 agent path/name/role，不建立 parent 关系 |
| Codex | inline subagent / team scope | `event_msg:sub_agent_activity`、`inter_agent_communication_metadata` 及 fixture 锁定的 agent/team metadata | main session 内对应 Event/Use 置 `originScope=subagent`，只判 scope/coverage，不保存 agent 身份 |
| Codex | main-session lineage | file-level subagent 已先排除；其余 session 使用 `session_meta.forked_from_id ?? session_meta.id` 的一跳 root | provider-scoped HMAC 后作为 explicit-lineage dedupe；v1 不递归归并 fork 链 |
| Codex | provider rollback | `event_msg:thread_rolled_back` 的 `payload.num_turns` | Adapter 只产出 session-scoped relative status Event；Engine 依 committed Fact 解析目标，Adapter 不持有或猜测历史 Turn |
| Claude | 可见 user/assistant message | 顶层 user/assistant record 的可见 text part | tool-result-only、meta、sidechain、compact summary 排除 |
| Claude | Tool invocation / result | assistant `tool_use` 与 user `tool_result` | provider correlation id 配对；tool-result-only user record 不创建 Turn；`isSidechain=true` 的 record/Use 置 `originScope=subagent` |
| Claude | Skill 确认加载 | assistant `tool_use:Skill` 与 user `tool_result` 配对 | `is_error` 失败不计为确认加载 |
| Claude | Skill 推断加载 | 仅 session 内权威 catalog snapshot + 完整 `SKILL.md` read | v1 没有 catalog snapshot 时不产出 inferred load；禁止读取当前文件系统 catalog |
| Claude | resume / fork 去重证据 | 无可依赖 immutable lineage；使用一或两个 hard-sealed Turn 的 exact-content prefix fingerprint | timestamp 只作准入、不进摘要；两 Turn 为 strong、一 Turn为 weak，缺可见 assistant/timestamp 时为 unknown |
| Claude | 已知非事实记录 | `attachment`、`last-prompt`、`queue-operation`、`mode`、`relocated`、`worktree-state`、`file-history-snapshot|delta`、`pr-link`、非可见 `system` | 已知且有意忽略，按 record class 聚合 coverage，不逐条创建未知 Event；`subagents/agent-*.jsonl` 计入 `unnamed-subagent-file-skipped` |

File-level scope 先于任何 Turn/Event 解析：Codex `session_meta.thread_source=subagent` 或 `source.subagent.thread_spawn` 命中时，Adapter 只产出 `sessionScope=subagent` 的 Session Fact 与聚合 coverage，不把该文件当 main session 建 Turn/Use/FTS；Claude 非 UUID 主文件的 `subagents/agent-*.jsonl` 由 discovery 计入 `unnamed-subagent-file-skipped`，不再静默丢弃。主 session 内只有 fixture 锁定的 inline/sidechain 记录可把局部 Event/Use 置为 subagent；无法判 scope 时用 `unknown`，不能默认 main。

Codex 顶层 `compacted` 与 `event_msg:context_compacted` 是 append 到 JSONL 的生命周期记录，不是可见消息、Turn 边界或文件中段改写。Codex `task_started` 的 source position 通常早于本 Turn user message；Adapter 必须先暂存，遇到后继权威 user boundary 后只向该新 Turn 建立 `turn_evidence(role=lifecycle)`，不得修改前一 hard-sealed Turn。原生 `turn_id` 只作跨记录关联 corroboration，不进入 Turn 身份。adapter 必须把已知 provider 记录类及权威级别固化为 fixture 索引；未知类只增加 coverage diagnostic，不能被猜作可见边界、Tool 结果或 subagent main-scope 事实。

## 关键决策

- **DEC-1 · 本地个人产品**：`threadshare insights` 是本地个人分析入口，数据默认不离开设备；公共分享链路不承担跨 session 分析。
- **DEC-2 · 被动证据优先**：Codex 仅把 user role、文本首部、含 `<name>` 的结构化 `<skill>` 计为确认加载；Claude 仅把成功配对的 `Skill` tool use/result 计为确认加载。只有同一 session 内 `skill-catalog-entry` 的 keyed path fingerprint 与完整 `SKILL.md` read 的 keyed input/path evidence 一致，才能提升为推断加载；Codex 可使用 session 内 `<skills_instructions>`，Claude 没有 snapshot 时 v1 不推断。catalog entry 本身不计使用；实时文件系统 catalog、assistant 复述、非首部出现、提及、搜索和编辑也不计使用。
- **DEC-3 · 公开契约隔离**：分析在 provider 原始记录进入可见 History 过滤前完成；现有同步 export 函数签名、返回结构以及 share/read/Viewer/Agent transcript 的可观察输出保持兼容。流式 reader 作为并存的上层能力，不替换已发布同步 API。
- **DEC-4 · 增量索引而非全量启动扫描**：每个 source session 的 checkpoint 保存最后完整行 byte offset、不完整尾部的 byte length/digest、open Turn、pending Tool、pending `task_started`、provider 记录类优先级/去重状态，以及 fact schema/provider adapter/privacy policy/origin-secret epoch；不得复制不完整 JSONL bytes、Tool payload 或可见消息正文，恢复时从原 session 重读该有界尾部。Engine 以 compare-and-swap generation 接收 session-scoped Fact delta，只撤回或替换变化的事实根。首次回填最新优先并可恢复，暖启动先读 Engine Snapshot；后台 stat 不读元数据未变化文件正文，变化文件只读取固定 4 KiB 头部和 checkpoint 前固定 4 KiB 尾部用于 append-boundary 指纹核对，再决定 append 或单 session 重建。Codex compaction 记录按 append 消费；文件 size 缩小、身份变化、size 未增长但 mtime 变化或指纹不符时重建。provider 违反 append-only 契约、同时修改未采样中段并继续追加时仍可能漏检，作为明确残余风险由 `reindex` 兜底。
- **DEC-5 · 预编译 Rust sidecar 与单一事务索引**：Insights 的索引、混合文本 analyzer、查询和 rollup 由独立 Rust sidecar 实现，通过固定版本的 `rusqlite` 与 `bundled-full` feature 静态链接固定 SQLite 并启用 FTS5，再以版本化 length-prefixed JSON stdio 协议与 Node CLI 通信；不用 N-API，避免 Node ABI 耦合和 native crash 影响主进程。该决策不是从 CodeGraph 的 Rust kernel 推导数据库实现：CodeGraph 的 Rust/N-API 只负责 tree-sitter 解析，其 SQLite 来自 bundled Node。owner decision 固定为保留 Threadshare 现有 Node `>=20` 公开兼容边界，而 `node:sqlite` 从 Node 22.5 才存在且本机 Node 22.22.2 仍标为 experimental；选择 Rust 是为了不提升用户 Node 下限、不捆绑完整 Node runtime、固定 SQLite/FTS 行为并隔离索引故障，不预设同一 SQLite 算法仅因换语言就更快。Node 继续拥有现有 provider 解析与公开 CLI 契约，按 session batch 跨边界，不逐 record 调用 Rust；ITEM-3 必须用同一 25,000 Turn corpus 与 Node 22 `node:sqlite` reference harness 对比协议开销、回填吞吐、查询和 RSS。Rust 只需满足本 Epic 的绝对门槛，不以必须胜过同算法 Node reference 作为伪性能条件；若 Rust 未达门槛而 Node reference 达标，则本 Epic 保持 blocked，不静默提高 Node 下限或发布 Node-22-only Insights。未来只有 owner 明确批准 major-compatible 的 Node `>=22.5` 变更，才用独立决策把 ITEM-3 替换为零原生 `node:sqlite` 路线。Rust binary 以六个 OS/arch 平台 npm optional package 自动随 `@team-harness/threadshare` 安装，不运行 postinstall 下载或本机编译；六个依赖只注入发布 staging 中的根 manifest，不进入源码 `package.json`/lockfile。缺失或不支持的平台只让 Insights 返回稳定 diagnostic，既有 share/read/export 继续工作。
- **DEC-6 · SQLite/FTS5 优先于自研 LSM 或 Tantivy 双存储**：当前基线约 1.5 万文档，长期目标为 25 万文档；Insights 同时需要全文检索、结构化过滤、事务更新和聚合。bundled SQLite + contentless-delete FTS5 能在一个 WAL transaction 内原子维护事实、倒排和 rollup，避免自研 Posting/compaction，也避免 SQLite + Tantivy 双存储的 outbox 与跨索引一致性。只有在确认 df lookup 使用 pinned SQLite 的 term-equality seek plan 后，记录硬件的 250,000 Turn benchmark 出现以下任一可复现事实才重开检索 backend 评估：FTS posting traversal 占 query profile 超过 50% 且 P95/P99 越过 200/500 ms；detail-full FTS 超过 400 MiB；FTS 查询使 RSS 超过 128 MiB；或 candidate Recall@300 低于 0.90 且已排除 analyzer/query construction 问题。

  Fact repository 是独立容量轴：normalized-row implementation 在 `VACUUM` 后以 `dbstat` 统计的 Fact 表+索引超过 6 GiB，或全部稳态超过 8 GiB 时，ITEM-4 必须实现 `packed-facts-v1`，不能只“评估”、提高门槛、丢 Fact 或假设压缩率。Engine 内部 `FactRepository` seam 固定 `applySessionFacts`、`readTurnClosure`、`scanSnapshot` 与 stable-key lookup；normalized-row 与 packed implementation 对外保持同一 `SessionFactsDeltaV1`、logical Fact、stable key、revision、Projection input/output 和 protocol。`packed-facts-v1` 仍使用同一 SQLite/WAL：sessions/checkpoints、Turn 搜索热字段、共享 Capability 与跨 Turn links 保持关系表；SourceRecord 与 session-scoped orphan Event 只在 session owner pack 保存一次，Turn-local Event/Use/link pack 通过 session-local source ordinal 引用它，不能为多个 Turn 复制 SourceRecord metadata。source ordinal 必须单调递增且永不复用；逻辑回收只写 tombstone、保留 ordinal slot，物理压实只允许在 `replace-session` 或显式 session rebuild 时重写该 session 全部 pack。

  所有 pack 采用 versioned deterministic binary array、owner-local dictionary、varint offset/reference 和固定 chunk size，以逻辑字段 `(ownerSessionKey, ownerKind, ownerKey, revision, chunkOrdinal, logicalLength, payloadSha256, payload)` 无压缩存入 SQLite；是否使用 rowid/`WITHOUT ROWID` 由 ITEM-4 同 corpus 容量与点查 benchmark 决定，不冻结未经实测的物理表选项。session source pack 只追加、tombstone 或在明确 compaction 时替换受影响 chunk，open Turn 只重写其 Turn chunk，不重写整个 session；未变化的 SourceRecord/Event 必须保持原 ordinal。owner-local source ordinal 是物理引用，不进入 logical Fact digest、protocol/evidence pointer 或增量与 clean rebuild 等价断言。Fact、Projection、FTS 与 checkpoint 仍单事务提交。该分支必须在 `compression=none` 下满足 6/8 GiB、增量/clean-build逐逻辑 Fact 等价、详情解码和 2 秒可检索门槛；可选压缩只算额外余量。无压缩 packed 后仍越界或延迟失败时 Epic 保持 blocked，由 owner 重新决定事实范围或容量预算。Tantivy 不减少 problem/excerpt/Event/Use/link 存储，不能拿换检索引擎伪装成事实层优化；不以主观“更快”提前引入 Tantivy、自研 LSM 或第二事实存储。
- **DEC-7 · BM25 召回、可解释重排与有界路径归纳**：第一版问题检索只索引 user problem text、code/identifier terms 和 capability names，以 FTS5 BM25 召回固定候选，再用 IDF coverage 与 exact-match 做有界重排；不得用全库 LIKE 或 Levenshtein scan 兜底。Tool 路径只从最多 200 个候选 Turn 归纳，排序展示相关度、跨 independent session group 支持度和时间事实，不引入效果或因果分数。
- **DEC-8 · Fact Model 与 Projection 分离**：Codex/Claude 各自作为 Provider Evidence Adapter，在公开 History 过滤前产出同一个 `SessionFactsDeltaV1`；Rust Engine 的小 Interface 只接收该 provider-neutral delta 并返回 committed Snapshot，不向调用者暴露 SQLite 表、FTS 或 rollup 细节。`sessions`、`turns`、`source_records`、`evidence_events`、`capabilities`、`capability_uses` 及 Turn/Use evidence links 构成长期事实层；FTS、统计、路径和未来分析是独立版本的 Projection。projection-only 变化从事实层重建且不得读取 raw session；新增/改变事实含义才升级 fact schema，provider authority/配对、隐私裁剪/secret epoch 或 duplicate policy 变化分别升级 Adapter/privacy/duplicate contract，并重解析受影响 session。SQLite 是 Engine 的 implementation；DEC-6 的 internal FactRepository 只切换同一逻辑 Fact 的物理布局，不成为 CLI、Adapter 或分析 Module 的公开 storage adapter。

## 性能与存储模型

索引目录是可删除、可完整重建的派生状态。默认位置由平台 state-directory resolver 决定：macOS 使用 `~/Library/Application Support/threadshare/insights`，Linux 使用 `${XDG_STATE_HOME:-~/.local/state}/threadshare/insights`，Windows 使用 `%LOCALAPPDATA%/threadshare/insights`；`THREADSHARE_INSIGHTS_HOME` 是显式覆盖。目录权限限制为当前用户，报告和 UI 不暴露本机绝对路径。

索引前应用 provider、项目路径和显式 session 排除规则；新增排除规则时必须移除既有 contribution。排除规则不是派生状态，存入平台 config-directory 下的 `threadshare/config.json`，由 versioned JSON schema 校验：macOS 使用 `~/Library/Application Support/threadshare/config.json`，Linux 使用 `${XDG_CONFIG_HOME:-~/.config}/threadshare/config.json`，Windows 使用 `%APPDATA%/threadshare/config.json`，`THREADSHARE_CONFIG` 可显式覆盖。配置包含 `insights.excludeProviders`、`insights.excludeProjects`、`insights.excludeSessions` 和 `insights.quiescenceSeconds`；quiescence 默认 300 秒，允许 60 到 86,400 秒。CLI contract 提供 exclude add/remove/list 表面，第一版 Dashboard 只读展示规则。`reset` 和 `reindex` 都不得删除或绕过排除规则。

索引会把分散在 provider 目录中的用户问题集中成可检索语料；`turns` 中的 bounded problem text 和 FTS 中可逆的 base32 token/position 在信息量上都按问题原文副本对待，不能把 token 编码描述为匿名化或不含原文。Dashboard 必须展示索引位置、占用和 purge 状态，CLI 必须提供 status、reindex 与 reset。reset 关闭 Engine 后删除全部派生 DB、WAL、SHM 和 staging，不触碰原始 session 或持久化排除规则；reset 后重新索引仍须应用同一规则。普通表 `PRAGMA secure_delete=ON`、FTS `optimize`、VACUUM 与文件删除只能提供本机逻辑清除和 best-effort 页面覆写，不能承诺从 SSD wear-leveling、文件系统 snapshot 或外部备份中法证擦除。

本地 HTTP server 和 UI shell 先从 Rust Engine 的 committed snapshot 启动，目录发现、stat reconciliation 和首次回填都在后台 worker 执行；首次无索引时 UI 立即显示空状态和进度，而不等待历史正文。worker 从最新数据开始流式读取，按 session batch 提交并主动让出事件循环。Dashboard 的权威状态字段统一由《验收标准》定义。关闭进程最多丢失尚未 commit 的当前 batch，不会让 checkpoint 超前于可见 Turn 或 FTS。

日常刷新先比较 file identity、size 和纳秒 mtime；元数据未变化时不读取正文。元数据变化时读取固定 4 KiB 头部和 checkpoint 前固定 4 KiB 尾部核对 append boundary：size 增长且 identity/指纹一致时从最后完整 JSONL 换行后的 byte offset 继续；size 未增长但 mtime 变化、size 缩小、指纹不符、文件替换、fact schema/privacy policy 升级或 provider adapter 声明 Fact emission 不兼容时，只重建受影响 session。纯 parser 性能修复且 Fact emission 兼容的 adapter version 变化不强制重建。Projection 版本升级只从 committed Fact 重建，不属于 session 正文刷新。同 size/mtime 的静默改写，以及“修改未采样中段后继续追加”这类违反 provider append-only 契约的变化不能由 8 KiB 指纹完全检测，作为已接受残余风险由显式 `reindex` 兜底。查询永远读取派生索引，不扫描 raw session。

Engine 使用一个 versioned SQLite database 作为本地派生状态；当前 active Fact 与 active Projection 在同一 WAL transaction 中提交。`sessions` 保存 provider-neutral session 身份、eligibility 和保守的 resume/fork 去重证据，`source_checkpoints` 单独保存 ingestion-only 的 source locator、fingerprint、完整行 byte offset、不完整尾部的 length/digest、privacy-safe provider parser state、origin-secret epoch、EOF/source mtime、明确结束事件，以及最后一份已提交 `deltaId`/snapshot；checkpoint 不保存不完整 raw bytes、Tool args/output 或消息正文，source locator 也不是业务 Fact，不能进入查询结果或 UI。同一 session 任何时刻最多一个 in-flight delta，因此不需要无界幂等日志。`source_records` 每个被引用 JSONL record 只保存一次 byte range/hash/class，Event 只保存其整数外键与 compact pointer tuple，禁止在每条 Event 重复 session key、record hash、class 或 JSON Pointer string。`turns`、`evidence_events`、`turn_evidence`、`capabilities`、`capability_uses` 与 `capability_use_evidence` 保存 Fact；`turn_rollup_contributions`、只有三行的 `field_stats(field, fts_doc_count)` 和 FTS 保存 Projection；`projection_state` 与 `projection_change_log` 只保存重建协调状态。默认 normalized-row physical layout 的 SQLite 内部关系全部使用 `INTEGER PRIMARY KEY` 与 integer foreign key，32-byte stable key 只在所属实体的唯一 BLOB 索引保存一次；integer id 不进入 protocol、evidence pointer 或跨重建身份。active FTS row、`field_stats` 和 rollup 与对应 Fact 在同一事务增减，禁止查询时扫描 FTS 计算逐字段分母。

FTS 固定为 `content=''`、`contentless_delete=1`、`detail=full`、`columnsize=1`，显式设置当前 SQLite 默认的 FTS5 `automerge=4`、`deletemerge=10` 与普通表 `PRAGMA secure_delete=ON`，目的是固定 schema 行为而非宣称调优收益。detail-full 的 positions、频次、可逆 analyzer tokens 和 `turns.problem_text` 都属于敏感派生数据。FTS special `secure-delete` 不作为 v1 purge 安全性前提：single-document canary 中开关两侧都只有 `optimize` 后才清除原 token，不能为未经证明的收益承担持续写放大；未来启用必须用多 segment/mutation canary 证明 pre-optimize recoverability 明显下降并重测写入 P95。`detail=column` 禁用，因为在 contentless 表上会让内建 `bm25()` 丧失 term instance/column frequency并静默返回全 0；schema smoke test 必须锁定非零差异和列权重排序。exact phrase 仍只在最多 300 个候选的 bounded problem text 上检查。兼容 storage schema 变化走事务 migration；Projection 版本变化在同库 shadow tables 中从 committed Fact Snapshot 后台重建，完成后原子切换 active version，不读 raw session；provider authority、fact schema 或隐私裁剪变化才在新的 versioned DB 中重解析受影响 session，完成后原子替换 `CURRENT` 指针。

新增排除规则先在事务中将 session 标记为 ineligible，使所有查询立即隐藏，并进入 `pending purge`；后台删除 facts/FTS，再执行 FTS `optimize`、`wal_checkpoint(TRUNCATE)` 与 `VACUUM`，成功后才报告 purged。active DB 所在 state-dir 在 POSIX 上固定 0700、DB/WAL/SHM 固定 0600；Windows 对目录、数据库和临时文件设置只允许当前用户 SID 的显式 DACL。SQLite `VACUUM` 的临时数据库位于 active DB 同一目录而不受 `SQLITE_TMPDIR` 控制，因此禁止为 purge 改用会留下显式第二副本的 `VACUUM INTO`，并由同 volume 的空间 preflight 覆盖。Node 另建 state-dir `tmp/`，POSIX 0700、Windows 使用同一 DACL，并只为 sidecar 设置 `SQLITE_TMPDIR`、`TMPDIR`、Windows `TEMP`/`TMP`；Engine 固定 `PRAGMA temp_store=FILE`，把 sorter overflow、transient index 和空路径 `ATTACH` 等普通 SQLite 临时文件限制在这里，POSIX 文件按 0600 创建，启动时清扫孤儿。清理必须可中断恢复并记录写放大/耗时；空间不足或损坏导致无法完成时继续隐藏结果，但状态区保留旧 DB 路径、受限临时目录、风险和修复动作。reset 对已关闭文件执行同级 best-effort 清除，不把 unlink 误述为法证擦除。ITEM-3 在实现冻结时把 bundled SQLite 精确 patch version 写入 Cargo.lock、Engine `--version` 和 build manifest；升级必须重新通过 `INDEX 263`、FTS 行为、容量与性能 smoke，其他 SQLite reader 不属于兼容面。

provider parser checkpoint 至少保存 open Turn、pending Tool、pending `task_started`、权威记录类状态、必要去重键和上次完整行边界，不持久化 quiescent 判断。读取/聚合时的闭合规则如下：出现下一条权威 user message，或按《Provider 记录权威》的 `turn_id`/唯一 started->user->terminal 状态机匹配 `task_complete/turn_aborted` 时 hard-sealed；歧义 terminal 只形成 orphan diagnostic，不能猜着封闭 Turn。到 EOF 且当前注入时钟超过 source mtime 加 `quiescenceSeconds` 时派生为 quiescent，可进入聚合但保留 closure reason，并在后续 append 时重新打开和原子替换；其余为 open。尾部 Turn 始终以 provisional revision 存入 `turns` 与 FTS，使其可被问题搜索命中并标记 provisional，但不进入持久 rollup、Tool 证据路径或样本门槛。hard-sealed Turn 进入持久 rollup；每个 session 最多一个尾部 Turn 单独保存，查询时再按同一注入时钟决定是否临时加入聚合。Dashboard 分别报告三态，不能把 open 静默排除在 coverage 之外。

去重另有一个时钟无关、只用于 exact-content fingerprint 的 `observedEofClosed` 证据：Adapter 读到完整 EOF、确认 partial-tail length 为 0 后立即二次 stat；file identity/size/mtime 与本批 source snapshot 一致，且尾部 Turn 已有非空可见 assistant message时，随 `COMMIT_SESSION` 上送该观察。它不把 Turn 提升为 hard-sealed/quiescent，不允许进入 rollup、路径 Turn 数或结果判断；二次 stat 后发生的 append 由 watcher/reconciliation 标 stale，并在下一 delta 撤回该证据、重算 Session 去重字段与相关 Projection。相同 source snapshot bytes 的增量与 clean rebuild 必须得到相同 `observedEofClosed`，不得读取挂钟或 quiescence 配置。

Engine 使用单 writer；一次 query 使用短生命周期 read transaction 固定同一 snapshot。第二个进程复用现有本地服务或以稳定 diagnostic 退出，stale lock 可恢复。SQLite 固定启用 WAL、foreign keys、busy timeout 和 derived-index 可接受的 synchronous 策略；首次 backfill 以 session 为提交边界，WAL 未 checkpoint 增长达到 64 MiB 时后台 passive checkpoint，达到 128 MiB 时 writer 在 transaction 边界施加背压，避免 WAL 无界增长。数据库损坏时保留原文件并报告可执行的 `reindex`，不静默删除原始或排除配置。

实现必须使用流式行解析和背压，不得对大 session 使用整文件 `readFile`/`split`。Node 与 Rust 使用 protocol v1 handshake 和最大 4 MiB frame，按 session delta 的有界 batch 通信，不逐 record 或逐 token 跨进程。超大或无效记录必须以有界内存跳过并写入 coverage diagnostic，不能阻塞整个 corpus。默认后台并发和提交批次应以保持本地 Dashboard 响应为优先，而不是追求最大吞吐。

## Fact Model v1

### Module seam 与 Interface

Codex 与 Claude 是两个真实的 Provider Evidence Adapter，共同满足一个内部 Interface；公开 History exporter 不是该 Interface，因为它已经丢弃了分析所需的 Skill、lifecycle 和 Tool result 证据。Node 侧 Interface 固定为 `ProviderEvidenceAdapter.readDelta(source, checkpoint, privacyContext) -> SessionFactsDeltaV1`，其中 `privacyContext` 只提供 versioned project/origin/input/dedupe keyed fingerprint 与 `originSecretEpoch`，不暴露 secret 或 Engine storage；Rust Engine 固定为 `InsightsEngine.applySessionFacts(delta) -> SnapshotId`。Adapter 隐藏 provider record class、去重和配对细节；Engine 隐藏 SQLite schema、事务、FTS、rollup、projection rebuild，以及必须查询 committed Fact 才能完成的 provider-neutral relative mutation。具体而言，Adapter 只规范化 rollback 的 relative status Event，Engine 才解析历史目标、建立 link 与更新 visibility。测试与生产调用同一 Interface，SQLite 只作为本地可替代 implementation，不把内部 storage seam 暴露给 CLI 或分析 Module。

`SessionFactsDeltaV1` 是 protocol v1 的 provider-neutral 载荷，至少包含 `factSchemaVersion=1`、`providerAdapterVersion`、`privacyPolicyVersion`、`originSecretEpoch`、`duplicatePolicyVersion`、session fact、`expectedGeneration`、`deltaId`、`mode=append|replace-session`、typed retractions、upsert Turns、Source Records、Evidence Events、Turn-Evidence links、Capabilities、Capability Uses、Use-Evidence links 和 source checkpoint。所有 Turn/SourceRecord/Event/Use/link 都有唯一 `ownerSessionKey`；`append` 可撤回 Turn 根或 session-scoped orphan Event，撤回 Turn 时删除发生于该 Turn 的 Event、属于该 Turn 的 Use，以及所有引用这些被删行的 link，并重新计算其他受影响 Turn 的 revision；无 Event 引用的 Source Record 在同一事务逻辑回收，normalized-row 可物理删除，packed layout 必须按 DEC-6 保留不可复用的 tombstone ordinal。正常 open Turn append 必须 additive upsert：stable key 未变的 SourceRecord/Event/Use 保留原行与 packed ordinal，只撤回内容确实变化或不再存在的 Fact，不能为方便而 retract-then-recreate 整个 Turn。`replace-session` 原子替换该 session 拥有的全部 Fact。Capability identity 是不可变共享 Fact，Adapter 只能幂等 upsert，Engine 只在无 Use 引用后垃圾回收，不能由 session delta 直接撤回。Adapter 只发送 Fact、relative status Event 与 checkpoint，不能发送自己无法从当前 delta 解析的历史 rollback link，也不能发送 FTS token、BM25 score、rollup、路径 family 或其他 Projection 结果。`deltaId` 由 session key、expected generation、mode、origin-secret epoch、duplicate-policy version、canonical fact mutation digest 与目标 checkpoint 确定；相同输入必须产生相同 canonical bytes 和 ID。

### 稳定身份与来源顺序

所有稳定 key 使用同一个无歧义编码：`hashKey(domain, parts...) = SHA-256(ASCII("threadshare:" + domain + ":v1") || 0x00 || length-prefixed parts)`；每个 key 公式固定 part 的类型和数量，每个 part 先编码为 UTF-8 或指定的固定宽度 big-endian integer，再加 unsigned 32-bit big-endian byte length。协议中的 u64 使用无前导零的十进制字符串；stable key、record SHA-256、correlation/input/origin/dedupe fingerprint 等全部二进制值在 canonical JSON 中固定为小写 hex，并由 schema 校验精确字节长度。canonical mutation bytes 使用 RFC 8785 JSON Canonicalization Scheme，并由 schema 禁止浮点数、重复 object key 和未声明字段；集合按各自 stable key 排序，source sequence 保持原顺序。禁止直接字符串拼接，也禁止用数据库 rowid、数组下标或易变化时间戳充当跨重建身份。

```text
sessionKey    = hashKey("session", provider, canonicalSessionId)
turnKey       = hashKey("turn", sessionKey, uint64be(turnStartByteOffset))
sourceRecordKey = hashKey("source-record", sessionKey, uint64be(recordStartByteOffset))
eventKey      = hashKey("event", sessionKey, uint64be(recordStartByteOffset), int32be(contentIndex), uint16be(eventOrdinal))
capabilityKey = hashKey("capability", provider, kind, canonicalName, identityVersion)
useKey        = hashKey("capability-use", turnKey, providerCorrelationDigestOrFirstEvidenceEventKey)
duplicateGroupKey = hashKey("duplicate-group", provider, dedupeFingerprint)
revision      = SHA-256(canonical Turn-local Fact closure)
```

`canonicalName` v1 是 provider 暴露名称经过 Unicode NFC 后的值，保留大小写、标点和 namespace，不做 alias、路径或 basename 合并；改变该规则必须提升 `identityVersion`。provider correlation digest 使用 `hashKey("provider-correlation", sessionKey, rawCorrelationId)`，原始 id 不进入 Fact。可选 origin/input/path/dedupe fingerprint 由 `privacyContext` 使用 index-local random secret 做 domain-separated HMAC-SHA-256：origin 不参与 Capability identity，input 只用于判定同 Capability 的同输入重复调用，path 只用于同 session catalog/read 等值匹配，dedupe 只用于 resume/fork 支持度去重；它们都不暴露原始内容且不跨 reset 承诺稳定。该 secret 以 0600/current-user-only 权限存于 state directory、常规 `reindex` 必须保留、随 `reset` 删除，并带随机 `originSecretEpoch`。secret 缺失、损坏或 epoch 不匹配时不得静默重建，Engine 返回稳定 diagnostic；只有显式 secret-recovery reindex 或 reset 才生成新 epoch 并重解析全部 keyed Fact。epoch 进入 checkpoint、delta 和 canonical mutation identity。

`inputFingerprint` 的输入规范化固定为：对完整 provider arguments，合法 JSON 使用 JCS，否则使用原始 UTF-8 bytes；只持久化 HMAC，不持久化或输出参与 HMAC 的字段。HMAC domain 同时包含 provider、Capability kind/name，避免跨 Tool 等值。`pathFingerprint` 只对 provider 明示路径做平台感知的纯词法规范化（Unicode NFC、分隔符、`.`/`..` segment 和 Windows drive-letter 规则），禁止 stat、realpath 或读取当前文件系统；symlink/alias 导致的漏匹配作为 inferred-load coverage，不允许模糊匹配。完整 read v1 只接受 fixture 锁定的结构化读取调用在无 offset/limit 截断下成功返回，shell 命令文本或片段 read 不提升为 inferred load。

Session 去重只使用 session 内可观察且由 provider fixture 锁定的证据。File-level subagent 先排除，不参与去重。Codex main session 的 `explicit-lineage` 一跳 root 固定为 `session_meta.forked_from_id ?? session_meta.id`；两者都缺失时不可用，不递归追溯 fork 链。Claude v1 不假设存在 immutable lineage 或 record identity，因为实测 resume 会重写 `sessionId/uuid/parentUuid/timestamp`。普通 parent hint、路径、标题、mtime 或相似文本都不能成为 lineage。

没有 explicit lineage 时使用 exact-content first-Turn prefix。provider user-boundary timestamp 只作为“记录形状完整”的准入条件，**绝不进入 fingerprint**；第一 Turn 必须是 hard-sealed 或满足 `observedEofClosed`，边界 timestamp 非空且至少有一条可见 assistant message。`dedupeFingerprint` 永远只由第一 Turn signature 生成；该 signature 包含未截断 user text 的 NFC/LF-normalized SHA-256、按 source order 排列的全部可见 assistant content digest，以及 Capability kind/exact observed name/provider terminal state，不 lowercase、trim、模糊匹配或只用首 prompt。若第二个 hard-sealed Turn 同样满足完整 shape，另存 `dedupeCorroborationFingerprint`，但它只能增强组证据，**绝不能改变 `dedupeFingerprint` 或 `duplicateGroupKey`**。`observedEofClosed` 的第一 Turn 后续 append 时允许重算 provisional fingerprint 并原子失效 session/path Projection；第一 Turn一旦 hard-sealed，其 fingerprint 冻结，后续 append 不改变。explicit lineage 后出现时始终优先并触发同样失效。

Engine 以 `(provider, dedupeFingerprint)` 生成 nullable `duplicateGroupKey`；缺少合格证据时保持 null，不猜测合并，也不把该 session 计作 evidence-path 的独立 group。Session Fact 同时保存 `duplicatePolicyVersion`、`duplicateMethod=explicit-lineage|exact-first-turn-prefix`、`duplicateConfidence=strong|weak`、可选 `dedupeCorroborationFingerprint`、`dedupeClosure=hard-sealed|observed-eof` 与组成证据的 Event key；这些字段不参与 `sessionKey`、`turnKey`、eligibility 或 Fact 去重，也不建立跨 session 关系。explicit lineage 为 strong；exact-content session 默认 weak。Engine 派生的 exact-content group 只有在至少两个成员提供相同非空 corroboration fingerprint 且所有非空 corroboration 无冲突时才标 strong，否则为 weak；不同第二 Turn 不拆组，只会保持 weak，因此偏差只能保守合并、低估独立样本，不会把同源副本拆成多个 group。UI 同时展示 raw session count、strong/weak independent group count、`observed-eof` provisional group count 和 unknown-dedupe session count；weak group可以计入《共享语言》的保守门槛。null session 仍返回 raw match，但不能帮助通过该门槛。

`useKey` 的最后一部分先编码一字节 branch tag，再编码 32-byte correlation digest 或 first Event key；一旦 Use 创建便不能从 fallback 分支切换到 correlation 分支，Adapter 必须在 open/pending state 中持久化该选择。同一 open Turn 后续追加 result、follow-up 或 closure 时保持 `turnKey`，revision 由 Engine 在应用 delta 后计算，不由 Adapter 上送。Turn-local Fact closure 精确定义为：Turn row（不含 revision）、发生于该 Turn 的 Event 及其 Source Record、指向该 Turn 的 `turn_evidence` link、属于该 Turn 的 Use、Use-Evidence link，以及被这些 Use 引用的不可变 Capability identity；同一 Turn 内被 link 引用的 Event/Source Record 已由 occurred 集合完整纳入，跨 Turn 或 session-scoped orphan Event 只以 `eventKey` 引用进入目标 Turn closure，不传递纳入其 attributes/Source Record，避免跨 Turn revision 连锁。按 entity kind 与 stable key 排序后做 JCS。它不包含 source checkpoint、其他 Turn 的 Event attributes、Capability 的其他 Use 或任何 Projection。

Evidence Event 的权威顺序是 `(recordStartByteOffset asc, contentIndex asc, eventOrdinal asc)`；top-level record 的 `contentIndex=-1`，同一 content item 派生多种事实时使用固定 event-kind 枚举顺序生成 `eventOrdinal`。provider timestamp 允许为空或乱序，只能用于展示和时间过滤，不能决定调用路径。Evidence pointer 的逻辑值固定为 `sessionKey`、record byte range、JSON Pointer、record SHA-256 和 provider record class；物理存储由 Event 的 `sourceRecordId` 与 `(pointerKind, contentIndex, subIndex?, eventOrdinal)` compact tuple 还原，pointer recipe 由 provider fixture 固定，不存重复字符串。pointer 不包含绝对路径，Engine 通过 ingestion-only checkpoint 解析 source locator。

### 事实实体与关系

| Entity / relation | 稳定内容 | 明确不保存 |
|---|---|---|
| `sessions` | `sessionKey`、provider、可选 provider-declared `originatorVersion`、`sessionScope=main|subagent|unknown`、脱敏 project key、observed start/end、eligibility、可选 dedupe/corroboration fingerprint、method/confidence/closure/policy/evidence Event keys、nullable Engine-derived `duplicateGroupKey` | 原始 session 正文、agent path/name/role、公开 share 状态、跨 session 关系边 |
| `source_checkpoints` | ingestion-only source locator、file identity/fingerprint/size/mtime、完整行 offset、EOF observation、partial-tail length/digest、privacy-safe parser state、generation、last delta/snapshot | partial raw bytes、Tool payload、查询维度、分析结论 |
| `source_records` | `sourceRecordKey`、owner session、record byte range、record SHA-256、provider record class | raw record body、重复 JSON Pointer string；packed owner-local source ordinal 是物理编号，不是逻辑 Fact |
| `turns` | `turnKey`、session、source order、最多 64 KiB problem text（前 48 KiB + 后 16 KiB）、最多 8 KiB final excerpt（前 6 KiB + 后 2 KiB）、raw closure facts、`providerVisibility=active\|rolled-back\|unknown`、Engine-derived revision、独立 `factTruncation` flags；main-scope 由所属 Session 的 `sessionScope=main` 派生 | assistant 全文、thinking、Tool payload、analyzer token truncation；Turn 内 subagent Use 不改变 Turn scope |
| `evidence_events` | `eventKey`、owner session、发生位置的 nullable Turn、source record、compact pointer tuple、source order、tagged event kind、`originScope`、observed timestamp/state、evidence strength 与 type-validated safe attributes | raw args/output、重复 record metadata、任意 provider JSON dump、agent 身份、`solved/effective` |
| `turn_evidence` | `(turnKey, eventKey, role)`，role 为 boundary/lifecycle/result/follow-up/rollback/corroboration | 把 Event 文本或 attributes 复制进目标 Turn |
| `capabilities` | provider、Tool/Skill kind、canonical name、identity version | observed path、绝对路径、Skill 正文、跨 Use 聚合状态 |
| `capability_uses` | `useKey`、Turn、Capability、Turn 内 ordinal、exact observed name、`originScope`、可选 origin/input fingerprint、provider-normalized terminal state、confirmed/inferred strength、provider correlation digest | raw input、因果贡献、推荐分数 |
| `capability_use_evidence` | `(useKey, eventKey, role)`，role 为 invocation/result/corroboration | 把 Turn complete/aborted 扇出到全部 Use，或用单一 pointer 压缩多事实 |

关系固定为 `Session 1:N Turn`、`Session 1:N SourceRecord 1:N EvidenceEvent`、`Turn 1:N occurred EvidenceEvent`、`Turn N:M EvidenceEvent`、`Turn 1:N CapabilityUse`、`Capability 1:N CapabilityUse`、`CapabilityUse N:M EvidenceEvent`。除共享 Capability identity 外，Use/Event/link 两端的 `ownerSessionKey` 必须相同，v1 禁止跨 session 事实关系。例如下一条 user message 的 boundary Event 发生在新 Turn，同时以 `turn_evidence(role=follow-up)` 关联前一 Turn；这是“出现后续输入”的原始顺序事实，不把文本推断为 correction 或 confirmation，事件本身也不能复制。follow-up link 合法改变前一个 hard-sealed Turn 的 revision；这与“后继 `task_started` 不得误改前一 Turn”的专门约束是两条不同规则。

Codex lifecycle 使用显式状态机：`task_started` 先作为 session-scoped pending Event，不发生于前一 Turn；看到其后第一个权威 user boundary 时，以 `turn_evidence(role=lifecycle)` 关联新 Turn。`task_complete/turn_aborted` 优先按原生 `turn_id` 与该 pending-started/new-Turn 配对；旧记录缺少 `turn_id` 时只在 started->user->terminal 序列唯一时关联，否则保持 orphan diagnostic。下一条 user boundary 仍可 hard-seal 前一 Turn，但绝不能用后继 `task_started` 改写前一 Turn revision。Tool invocation、一次或多次 result、capability-specific completion 和交叉校验必须保留为独立事件并通过 link role 关联，不能压成一个 `completed/error` 字段；Codex `event_msg:*_begin/*_end` 不与 `response_item` correlation namespace 混配。Turn-level complete/aborted 只能关联 Turn，严禁复制或扇出到该 Turn 的每个 Capability Use。

Use 上的 terminal state 取 source order 最后的 provider 明示 terminal Event，缺失时为 `unknown`，早先失败仍保留在事件序列中。Skill strength 取关联 load evidence 的 `confirmed > inferred`，不是 execution success。v1 不建立 Capability Use 的 parent/child 树，provider correlation 只用于配对、不表达因果关系；没有 invocation/load 且无法可靠配对的孤立 result 只保留 Evidence Event 与 coverage diagnostic，不虚构 Capability Use。`originScope=subagent|unknown` 的 Use/Event 同样保留事实与 coverage，但默认分析不归因到 main Turn。

Codex rollback 的 `rolledBackTurnCount=N` 是 provider 明示的相对目标，rollback Event 自身固定为 session-scoped、`occurredTurn=null`。Adapter 只发送该 Event；Engine 在同一 session 的 committed Fact 与本次 upsert 合并后，按 source order 重放 rollback Event，从每个 Event 之前选择最近 N 个仍为 `providerVisibility=active`、所属 Session 为 main、且已 hard-sealed 的 Turn，给每个目标建立 `turn_evidence(role=rollback)` 并改为 `rolled-back`。Event 所在的 open Turn不算目标；像 `turn_aborted` 已在 Event 前 hard-seal 的 Turn则可以成为最近目标。N 必须为 1..512；缺失、越界、目标不足、Fact truncation 或无法完整重放时只保留 provider-status 与 unresolved coverage，整条不部分应用、不猜 quiescent/open 目标。rollback Event upsert/retraction、`replace-session` 或相关 Turn 变化时，Engine 必须从该 session 的 normalized status Event 重放 visibility，确保增量与 clean rebuild 相同。rollback 是允许追溯修改已 hard-sealed Turn 的显式 provider 事实，必须同时更新这些 Turn revision、FTS/rollup/path contribution；这不违反“后继 `task_started` 不得误改前一 Turn”的专门约束。rolled-back Fact 留作审计，默认从 FTS、rollup、路径和样本门槛排除。

Evidence Event 使用封闭的 versioned tagged union；v1 只允许 `visible-message(role)`、`capability-invocation(capabilityKey, correlationDigest?, inputFingerprint?)`、`capability-result(correlationDigest?, providerState, exitCode?, outputBytes?, durationMs?)`、`skill-catalog-entry(capabilityKey, pathFingerprint)`、`skill-load(capabilityKey, confirmed|inferred, evidenceSource)`、`turn-lifecycle(started|completed|aborted)` 和 `provider-status(statusKind, providerState, rolledBackTurnCount?)`。user `visible-message` 同时承担 Turn boundary，assistant `visible-message` 只记录消息出现，不建立新 Turn。`skill-catalog-entry` 是可用性/名称映射事实，不创建 Capability Use；inferred `skill-load` 只在 catalog Event 的 source order 早于完整 read invocation 时产出，并同时链接 read invocation/result 与同 path fingerprint catalog Event；catalog 后出现时只记 coverage，不追溯提升已 hard-sealed Turn。`inputFingerprint` 是 keyed digest，不保存参数；`outputBytes` 是权威 result payload 的 UTF-8 byte length，`durationMs` 只在同一权威 Tool record/correlation 明示且可无歧义归属时保存，均使用有界 u64 十进制字符串。`rolledBackTurnCount` 使用无前导零 u64 十进制字符串，只有 `thread-rolled-back` 可设置；回滚目标只由该计数和 Event source position 相对解析，不保存 provider 未提供的伪目标 digest。tag 的数值 discriminant 与 `eventOrdinal` tie-break 顺序由 fact schema fixture 固定，改变它们必须提升 fact schema。`provider-status` 只接收 fixture 锁定的 provider 原生结构化状态，包括 `thread-rolled-back`；测试/构建/部署类别、用户 correction/confirmation、`solved/effective` 等从文本或事件组合得到的判断属于 Projection，不能伪装为 Fact。每个 event 的 safe attributes canonical JSON 上限 1 KiB，只允许该 event kind schema 声明的标量、枚举和 digest；未知字段丢弃并计入 coverage diagnostic，不能把 payload 原样塞进通用 JSON。每 Turn 最多 4,096 个 occurred/linked Evidence Event、2,048 个 Capability Use 和合计 8,192 条 Turn/Use-Evidence link，超限必须保留 user boundary 与 lifecycle，其他事件按 source order 保留前 75%/后 25% 并写入 `factTruncation`；这与 analyzer 的 `tokenTruncation` 是两个独立事实/Projection diagnostic。

Session-scoped nullable-Turn Event 每 session 最多 4,096 条，其中 `skill-catalog-entry` 最多 2,048 条；超限时优先保留 rollback、unmatched terminal、pending lifecycle 和组成 dedupe evidence 的 Event，再按 event-kind/source order 确定性保留 catalog 与其他 orphan，并写入 session-level `factTruncation`。被《Provider 记录权威》排除的孪生/begin/end 只增加聚合 coverage counter，不各自创建 Event，因此不能用噪声耗尽该 cap。

### Fact 与 Projection 生命周期

`factSchemaVersion`、每个 `providerAdapterVersion`、`privacyPolicyVersion`、`originSecretEpoch`、`duplicatePolicyVersion`、`storageSchemaVersion`、`analyzerVersion`、`rankerVersion` 和每个 `projectionVersion` 独立演进。fact schema 只在 wire/entity 字段或含义变化时升级；Adapter 必须声明新旧版本的 Fact emission 是否兼容，兼容升级只更新 checkpoint，权威记录/配对变化则以同一或新版 fact schema 重解析受影响 session；隐私裁剪、keyed-fingerprint、secret epoch 或 duplicate policy 变化提升对应版本/epoch 并重解析受影响 session。provider-declared `originatorVersion` 是低敏感观察字段，可供 coverage/格式回归 Projection 按版本切分，不决定 authority。每次 Fact commit 分配单调递增 `snapshotSeq`，并在同一事务向 `projection_change_log(snapshotSeq, ownerSessionKey, rootKind, rootKey, operation)` 写入只含 stable key/op 的失效记录；主键为 `(snapshotSeq, rootKind, rootKey)`，同一 commit 重复根合并，commit 后根仍存在时 operation 为 `upsert`，否则为 `tombstone`。

Engine 必须从 mutation 的提交前/后状态发出所有受影响根，至少包含 session 根、每个受影响的旧/新 Turn 根和旧/新 Capability 根。跨 Turn `turn_evidence` 变化同时失效 Event 的 occurred Turn（若有）与 link 的目标 Turn；跨 Turn `capability_use_evidence` 变化同时失效 Event 的 occurred Turn（若有）、Use 所属 Turn与其 Capability 根。目标 Turn revision 只纳入跨 Turn link 和 `eventKey`，不传递纳入另一 Turn 的 Event attributes。每个 Projection descriptor 固定 `rootKind=session|turn|capability`，catch-up 对每个失效根先删除 shadow contribution，再从当前 committed Fact 重新物化该根，因此 change log 不需要复制问题文本、旧 Event attributes 或 Projection payload。

`projection_state(name, version, inputFactSchemaVersion, rootKind, baseSnapshotSeq, watermark, status, errorDigest)` 记录 active/building/failed。新 Projection 先在短事务中登记 `baseSnapshotSeq`，再以有界 read transaction 批次扫描 committed Fact 并写 shadow tables；扫描不要求持有长生命周期 SQLite snapshot，因为从 `baseSnapshotSeq+1` 起的全部失效根都会在 catch-up 中按当前 Fact 重新物化。完成扫描后按 change log 追平，并在短 writer transaction 内消费到当前 snapshot、切换 active version。旧版在切换前继续服务并显示 stale/building；Projection 构建失败不能回滚或污染 Fact，也不能让查询穿透到 raw session。

`projection_change_log` 是有界 rebuild coordination metadata，不是业务 Fact。Engine 只回收不高于所有 building Projection watermark 的记录；若任一 build 使 log 超过 64 MiB 或 1,000,000 条，必须取消落后最久的 shadow build、保留旧 active version、清理其 shadow 状态后从新 base snapshot 重试，不能无限增长、保持长读事务或阻塞正常 Fact commit。没有 building Projection 时，active Projection 与 Fact 同事务提交后即可回收所有已消费记录。

只改变 analyzer、排名、rollup、Tool path 或新增分析维度时，从 Fact 重建对应 Projection，raw session 读取量必须为 0 bytes。新增事实字段/含义时升级 fact schema；provider 权威记录或事件配对变化时提升对应 Adapter version 并声明不兼容；隐私裁剪变化时提升 privacy policy。后两者可继续产出同版 Fact，但都必须从 checkpoint 标记的受影响 session 重解析；不得用 migration 猜造过去未观察的 Fact。`solved`、`effective`、`recommended`、测试/部署类别、用户 correction/confirmation、问题分类和相似度永远属于带版本的 Projection；事实层只保存 provider state、exit code、follow-up boundary 和 aborted 等独立观察值。

v1 的扩展性承诺是有边界的：Tool/Skill 次数与场景、同 input fingerprint 的失败后重试、重复调用/失败序列、follow-up 模式、Tool output-size/可用 duration 分布、bounded 问题/最终回复分类、lexical similarity、Turn closure/rollback、去重组规模、provider originator-version coverage 和新的聚合维度，必须能只增加 Projection。需要解释 Tool 参数/输出或错误文本、完整 assistant 中间消息/thinking、Skill 正文、subagent 身份/内部过程、可读文件路径、模型/token/context/cost、git branch/cwd 可读名，或 v1 未保存的 provider 字段时，必须先做独立隐私决策、升级 Fact schema 并重解析受影响 session，不能从缺失数据中猜造事实。新增 provider 只实现新的 Provider Evidence Adapter，不修改 Engine Interface；新增分析只消费 Fact repository，不绕过 Engine 读取 raw session。Codex Tool duration 因权威记录近乎不提供值，即使零 raw-read 聚合也只能报告低覆盖，不能生成有统计意义的耗时结论。

## 索引与查询算法

### 文档身份与 analyzer

一个 `TurnDocument` 对应 Fact Model 中一个分析 Turn，并直接使用其 `turnKey` 作为 document key。同一开放 Turn 后续补入 Tool result、follow-up link 或 closure fact 时保持 document key，只替换 revision；source replacement、provider authority 或 fact schema 变化才重建受影响 session，analyzer/ranker 变化只重建对应 Projection。索引输入只来自已提交 Fact：可见问题文本、最后一条可见 assistant message 的 bounded excerpt、时间、provider、脱敏 project key、Capability 名称与状态、结果证据、closure raw facts 和 evidence pointer，不读取 source checkpoint locator，也不包含绝对路径、Tool args/output、Skill 正文、系统提示词或 provider settings。

问题文本 64 KiB 与 final excerpt 8 KiB 的裁剪方式是 `turns` 的 Fact schema 常量，已在 Fact Model 实体表冻结；改变它们必须提升 fact/privacy schema 并重解析 raw session，不能只提升 analyzer。Analyzer 只负责 Projection 上限：单文档最多 8,192 个 token、4,096 个 distinct term，token 超限时保留前 6,144 与后 2,048 个，并写入独立 `tokenTruncation`；Capability facts 使用独立上限，不得被问题长文本挤掉。Fact Model 的 Event/Use/link cap 与 `factTruncation` 不属于 analyzer。单 provider record 上限 8 MiB。一次查询最多分析 256 个去重 field-term，最终最多 32 个进入 scoring；默认返回 50、最大 200。当前 P99 问题约 50 KiB，因此 Fact 文本上限保护异常长文档而不系统性截断正常样本；fact/token truncation 必须分栏进入 coverage diagnostic。

versioned analyzer 生成三个 FTS field。每个逻辑 term 最多 256 bytes UTF-8，超限改为 `h` 加 SHA-256；普通 term 编码为 `t` 加小写 base32 UTF-8 的 ASCII-safe token，再以空格分隔写入 FTS。查询使用同一 codec，并只从校验后的 token 构造参数化 `MATCH` 表达式，不把原始用户查询拼入 FTS 语法。这样 CJK gram、路径和 identifier 不会被 SQLite tokenizer 二次拆分，也不会让单个异常 identifier 无界扩大词典。

| Field | 规则 | BM25 weight |
|---|---|---:|
| `natural` | NFKC、稳定 lowercase；Latin/number word；连续 CJK 生成重叠 bigram/trigram | 8.0 |
| `code` | Markdown fenced/inline code 内全部 ASCII identifier；代码外仅保留含数字，或含点号、正反斜杠、下划线、连字符、冒号、井号、at 符号分隔，或属于 CLI flag、camel/Pascal 大小写跃迁的强 code 形状，再拆 camelCase、snake_case、kebab-case 和 path segment | 4.0 |
| `capability` | provider-scoped Tool/Skill canonical name；只含名称，不含参数 | 2.0 |

code context 由固定版本 Markdown parser 识别，不用正则猜测围栏边界。natural/code 分别保持原始 byte-offset 顺序：head 区域最多取 6,144 token，tail 区域最多取 2,048 token，每个区域在两个 field 间轮询，某 field 耗尽后余额转给另一个；4,096 distinct field-term 同样按 head 3,072 / tail 1,024 仲裁，未用额度可转移。capability 使用独立上限，不参与该轮询。单个 CJK 字符不进入索引；只有一个可检索字符且没有结构化 filter 的查询返回 `QUERY_TOO_BROAD`。第一版不 stemming、不做静态 stopword 删除。FTS Projection 记录 `analyzerVersion`、Markdown parser version 与 Unicode segmentation data version，任一变化只触发从 Fact 可恢复重建该 Projection。assistant 正文第一版不进入全文索引；结果页只读取索引内的 bounded final-answer excerpt 和 evidence pointer，因此不能沿用问题文本容量预算偷偷增加 assistant 全文。

### 增量写入

Provider Evidence Adapter 为每个变化 session 生成 `SessionFactsDeltaV1`；协议先发送带 fact schema/provider adapter/privacy policy/origin-secret epoch/duplicate policy version 的 `BEGIN_SESSION`，再用不超过 4 MiB 的 `RETRACT_FACTS` / `UPSERT_FACTS` frame 分批传输，最后发送带 checkpoint 的 `COMMIT_SESSION`。Engine 先验证 stable keys、canonical mutation digest、全部 binary hex/长度、所有 Fact 外键和 privacy/dedupe schema，再写入连接私有的 SQLite TEMP staging table 或权限 0600 的 state-dir temp file，不开启主库 write transaction；断连、显式 abort 或启动恢复时清除未提交 staging。只有 `COMMIT_SESSION` 才开启主库事务，不允许半个 session delta 可见。Rust Engine 在一个事务内按以下顺序处理：

1. 先查已提交 `deltaId`；完全相同的重放返回原 snapshot id，其他请求再 compare-and-swap 校验 expected generation，防止并发或旧 delta 覆盖新状态；
2. 按 Fact Model ownership/外键顺序执行 typed retractions 或 replace-session，删除受影响 link、Use、Event、无引用 Source Record、Turn 与旧 active Projection contribution，并记录提交前的 Turn/Capability 失效根；
3. 批量插入新增或更新的 Session/Turn/SourceRecord/Event/Turn-Evidence/Capability/Use/Use-Evidence Fact；Engine 再把 rollback relative status 与 committed Fact 合并后按 source order重放该 session 的 visibility/link，重算所有受影响 Turn revision，然后从 `providerVisibility=active` 的 Fact 生成 active/provisional FTS tokens 与对应逐字段 `field_stats` delta，并仅从 hard-sealed、main-scope、非 rolled-back Fact 生成 rollup contribution；
4. 分配 `snapshotSeq`，补齐提交后的 Session/Turn/Capability 失效根并写入只含 key/op 的 `projection_change_log`，更新 source checkpoint、generation、active projection watermarks 和 snapshot metadata；
5. commit 后才向 Node 确认新 snapshot id。

崩溃发生在 commit 前时整个 delta 不可见，恢复后从旧 checkpoint 重放；commit 后 ACK 前崩溃时，同一 `deltaId` 的重放返回已提交结果。Fact、active Projection 和 checkpoint 只在同一 commit 后可见。正常 append 的成本为 `O(delta bytes + changed Turn facts/tokens)`，不会重写 session 历史；open Turn 使用 additive upsert，未变化 Fact 保持 stable key/row/ordinal，tombstone 增长必须是 `O(实际撤回事实数)` 而非 `O(append 次数)`。rollback 是罕见的显式追溯 mutation，成本为 `O(delta bytes + N 个目标 Turn facts/tokens)` 且 `N<=512`。truncate/source replacement 或 fact schema/provider authority 升级只重建受影响 session，Projection 升级不重读 raw session。排除规则变化先在事务中把 session 标为 ineligible，使所有查询立即隐藏，再后台删除其 Fact 与 Projection contribution；重新摄入前必须重新通过排除规则。

文件 watcher 只提供变化 hint，metadata reconciliation 仍是事实权威。事件进入 pending 集合后查询返回 snapshot age、pending session 数，并给来自 pending session 的结果加 `stale=true`；debounce 或 watcher 退化不能静默宣称索引已是最新。

### 候选召回与排序

查询文本上限为 8 KiB UTF-8，超限返回 `QUERY_TOO_LONG`，不静默截断。查询先解析 provider、project、date、Tool、Skill、result 和 closure filters，再由同版 analyzer 生成最多 256 个去重 `(field, term)`；超限保留前 192 与后 64 个。Engine 预备 8、32、128、256 四档 statement，选择能容纳本次 term 数的最小档，以 `NULL` 填充未用位置，并用绑定占位符的 `term IN (?, ..., ?)` 参数化 SQL 从 `fts5vocab(..., 'col')` 读取候选 term 的逐 field document frequency；不得用 temp table、CTE 驱动 JOIN、Rust/JS 词表扫描或 SQL 层 full-vocab scan 代替 term-equality seek。Engine build manifest 所固定 SQLite 版本的 `EXPLAIN QUERY PLAN` 必须显示 `VIRTUAL TABLE INDEX 263`；出现 `INDEX 3`、`INDEX 7` 或其他全词典扫描计划即 schema smoke 失败，SQLite 升级时只有用同规模基准证明等价 term seek 才能更新该断言。Engine 排除 `df=0` 的 field-term 并把数量写入 query diagnostic；`ftsDocs(field)` 明确定义为当前 Engine Snapshot 中尚存在于 FTS、且该 field 至少有一个 token 的 TurnDocument 数，pending purge 文档在其 FTS row 删除前仍计入。高频阈值只分别应用于 `natural` 与 `code`：当同 field 存在低频 term 时，`df / ftsDocs(field) > 0.20` 的 term 不负责候选召回，只保留用于 exact substring；`capability` field 永不因高频被剔除。若某个 natural/code field 的 term 全部高频，则该 field 保留 document frequency 最低的最多两个、至少一个 term。完成上述规则后，再按 `(document frequency asc, code/identifier 同频优先, 首次出现位置 asc, field asc, term asc)` 选择最多 32 个 scoring field-term。df lookup、MATCH posting traversal、SQL filter 相交和 300 候选重排必须分别计时进入 query diagnostic 与 benchmark；只有正确 seek 形态在目标 corpus 上仍使整体门槛失败时，才允许提案以与 FTS 同事务维护的 `term_df` 替换，并须重新通过崩溃一致性与容量评审。候选 field-term 用列限定的 OR 召回，coverage 在重排阶段约束多词相关性。结构化 filter 在 SQL 中与 FTS rowid 相交，不能在取完无界结果后用 JS 全量过滤。

没有文本 term 但至少有一个有效结构化 filter 时，不进入 FTS，直接在 `turns`/fact 的有界索引上按 `(createdAt desc, documentKey asc)` 返回最多 200 条；既没有 term 也没有 filter 才返回 `QUERY_TOO_BROAD`。该分支同样固定 Engine Snapshot、应用 eligibility/purge visibility，并不得扫描 raw session。

FTS5 以 `ORDER BY bm25(turns_fts, 8.0, 4.0, 2.0) ASC, rowid ASC LIMIT 300` 取候选，显式遵循 FTS5“数值越小越相关”的排序语义。Rust 对这些候选读取 bounded problem text，计算：

```text
rankComponent = 61 / (60 + bm25Rank)  # bm25Rank 从 1 开始
idfCoverage   = matchedQueryIdf / totalRetainedQueryIdf
exact         = normalized query 是 normalized problem substring 时为 1，否则为 0
relevance     = wr * rankComponent + wc * idfCoverage + we * exact
```

这里的 retained query term 只指经过 `df>0`、逐 field 高频规则和 32-term cap 后的最终 scoring field-term；`fieldIdf = ln((ftsDocs(field) + 1) / (df + 1)) + 1`，`totalRetainedQueryIdf` 是这些 term 的 fieldIdf 总和，`matchedQueryIdf` 是当前候选实际命中子集的总和。被排除的高频 term 不进入 coverage 分母，完整 normalized query 仍用于 bounded exact 检查。relevance 只在同一 Engine Snapshot 内用于排序，不声明跨 snapshot 可比较。

初始 development 配置为 `(wr, wc, we) = (0.45, 0.40, 0.15)`；rank decay 与三项权重都只是开发集初值，必须做分量消融后冻结进 `rankerVersion`，evaluation set 不得参与调参。最终按 `(relevance desc, createdAt desc, documentKey asc)` 稳定排序，并返回 BM25 rank、matched field-terms、coverage 与 exact component，UI 不展示无法解释的黑盒单分。不得用全库 `LIKE '%...%'`、全词表 Levenshtein、raw session scan 或外部模型作为空结果 fallback；不足两个可检索字符且没有结构化 filter 时返回稳定的 `QUERY_TOO_BROAD` diagnostic。

### Tool 证据路径

证据路径只处理 search top 200 中当前为 hard-sealed 或 quiescent 的 Turn。每条路径按 Turn 内的真实发生顺序串联 provider-scoped Tool 名称，连续重复调用折叠为 `name × {1|2-3|4+}`，状态不参与 identity 而单独汇总。先按完整序列 fingerprint 分组并缓存所有 group pair 的距离；再按 fingerprint 升序枚举 group，只与既有 family 的当前 medoid 比较，首尾 Tool 相同且 ordered bigram weighted-Jaccard `>= 0.70` 时并入第一个满足条件的 family，否则新建 family；每次并入后增量更新距离和并重算 medoid，按 `(组内加权 Jaccard 距离和 asc, fingerprint asc)` 打破平局。该规则避免未定义的 single-linkage 传递闭包，并让输入顺序不影响结果。候选上限固定，pair distance 与 medoid 维护最坏为 `O(K^2 * L)`，其中 `K <= 200`、`L` 为 bounded Tool 序列长度，与 corpus 总量无关。

单条路径最多保留 128 个折叠节点，超限取前 96 与后 32 并标记 truncated。ordered bigram 的权重固定为 `1 + ln((K + 1) / (candidateDf + 1))`，只用当前不超过 200 条候选计算；family merge 不读取全库统计。路径按 `(best member relevance desc, distinct independent-session-group count desc, Turn count desc, latestAt desc, fingerprint asc)` 稳定排序，明确表达“与本次查询的相关度优先”，不代表更常用或更有效；UI 可另按支持度排序。路径同时展示支持 Turn、raw session 数、strong/weak `COUNT(DISTINCT duplicateGroupKey)`、unknown-dedupe session 数、Tool 状态分布和 evidence pointers。路径形成、排除范围与 `insufficientSample` 完全引用《共享语言》的唯一 evidence-path 门槛，不在算法层复制数值规则。结果证据不参与路径优先级，避免把 completed、用户沉默或相关性误写成“用得好”。

### 容量与复杂度预算

| Corpus | Documents | Postings | Field terms | Warm Top-20 P95 | P99 | Engine RSS | 稳态全部派生状态 |
|---|---:|---:|---:|---:|---:|---:|---:|
| 当前容量门槛 | 25,000 | 4,000,000 | 400,000 | `<100 ms` | `<250 ms` | `<96 MiB` | `<1 GiB` |
| 长期容量门槛 | 250,000 | 40,000,000 | 1,500,000 | `<200 ms` | `<500 ms` | `<128 MiB` | `<8 GiB` |

原 30% 样本的 optimized contentless-delete FTS5 使用了不能正确执行 BM25 的 detail-column，只能作为 14–18 MiB 当前值、240–300 MiB 长期值的下界。贴近同一 4,868-document 形态的 preliminary detail-full 复测为 detail-column 的 1.212 倍，暂估当前 17–22 MiB、250,000 Turn 290–364 MiB；ITEM-5 benchmark 前必须用同一去敏 30% 分层样本重测并报告，FTS 超过 400 MiB 时重开 DEC-6。对同一 1.37 GiB 分层样本按 Fact Model v1 结构化记录实测，4,837 Turn 的 Fact SQLite 为 103.2 MiB，约 22.4 KiB/Turn；直接外推 250,000 Turn 已约 5.2–5.8 GiB，考虑大文件层事件密度后为 5.8–7.0 GiB。该实测同时发现 Turn lifecycle 向每个 Use 关联会产生二次扇出，故 v1 明确禁止；Source Record normalization 与 integer foreign key 是实现前置，但不能再假设 1.5 GiB 总量。长期另外包含约 475 MiB bounded problem text、353 MiB final-answer excerpt、290–364 MiB FTS 及 rollup/WAL/change log，因此稳态门槛改为 8 GiB，当前 25,000 Turn 门槛改为 1 GiB。

ITEM-4 必须在相同样本复测 normalization 后的 Fact/Projection 分项，再按真实 Event/Use 密度扩展到 25,000/250,000 Turn；表中 `稳态全部派生状态` 包含 Fact repository、active Projection、change log、WAL、FTS tombstone/merge 和 staging 的稳态峰值。第一版不依赖未经实测的压缩率通过验收：normalized Fact 超过 6 GiB 或全部稳态超过 8 GiB 时，必须走 DEC-6 已冻结的无压缩 `packed-facts-v1` 分支，并对 normalized/packed 同一 mutation trace 逐 snapshot 比较 logical Fact digest、查询排序、Tool path、evidence pointer、purge 和 crash recovery；packed 仍越界或详情/增量延迟失败时保持 blocked。shadow Projection、versioned 全量重建、packed migration 或 purge compaction 还需同时容纳旧/新状态，启动前必须按 `2 * active size + 256 MiB` 做可用磁盘 preflight，空间不足时保留旧 snapshot 并给出 diagnostic。

warm Engine open 必须 `<500 ms`，查询读取 raw session 为 0 bytes，新提交 Turn 在正常 watcher 条件下 2 秒内可检索。首次回填复杂度为 `O(raw bytes + emitted tokens/facts)`，在记录硬件的本机基线上持续吞吐不得低于 10 MiB/s，且最新 100 个 eligible session 应在 30 秒内可查；warm reconciliation 为 `O(files)` metadata；文本查询为最多 256 个 field-term 的有界 df lookup、FTS posting traversal、SQL filter 相交与固定 `300` 候选重排；无文本总览读取 rollup，不扫描 Turn 或 capability fact。长期 corpus 必须以确定性改变 session/document key、时间与保留 identifier 的方式扩展，不能简单复制相同 row 取得虚假的压缩或 cache 优势。超过任一预算先形成可复现 benchmark 与 profile，再按 DEC-6 的量化触发器决定 backend，不能直接放宽门槛。

## 验收标准

- 现有 Codex、Claude 与 Paseo 按需 bridge 的 export/share/read 输出及所有公开契约测试保持不变；已发布同步导出函数签名和返回结构不变，Agent Markdown 不新增分析内容。`npm install -g @team-harness/threadshare` 在 darwin/linux/win32 的 x64/arm64 支持矩阵中自动取得校验过的 Engine binary，不执行 install script、运行时下载或本机编译；缺失或不支持 binary 时 Insights 返回稳定 diagnostic，既有 Node `>=20` CLI 仍可用。根 staged tarball 和六个平台包各有独立精确 allowlist、pack size、integrity、provenance、clean-install 与签名/notarization 验证；源码 checkout 的 `npm ci` 不依赖尚未发布的平台包，平台包全部确认后才发布已准备好的根 tarball。
- 真实形状 fixture 覆盖四类 Codex `<skill>`、session 内 `developer:<skills_instructions>` catalog、`response_item`/`event_msg:user_message` 与 assistant/`agent_message` 孪生对、权威 `function_call|custom_tool_call(_output)`、不同 correlation namespace 的 `event_msg:*_begin/*_end` 排除、`task_started` 早于本 Turn user boundary、`task_complete`/`turn_aborted`/歧义或缺失结束事件、inline subagent/team scope、顶层 `compacted`/`context_compacted` append 及 `replacement_history` 不重复计数。Codex file-level fixture 必须分别覆盖 `session_meta.thread_source=subagent` 与 `session_meta.source.subagent.thread_spawn`，并断言只产 Session scope/coverage，不产 Turn/Event/Use、FTS 或 main evidence-path 支持；main session 的 `forked_from_id ?? id` 只作一跳 lineage，不递归归并。`thread_rolled_back` fixture 必须模拟前 N 个 Turn 已在旧 delta 提交、rollback 只在 append 尾部到达：Adapter 只产 `occurredTurn=null` 的 relative Event，Engine 从 committed Fact 选择最近 N 个 active hard-sealed main Turn，逐 Turn 建 link、更新 revision 并从 FTS/rollup/path 移除；当前 open Turn排除、Event 前已 aborted 的 Turn可选，连续 rollback 重放 active 栈，N 缺失/为 0/大于 512/目标不足/截断时整体 unresolved。fixture 还必须证明后继 Turn 的 `task_started` 不改变前一 hard-sealed Turn revision。Claude 覆盖 `tool_use/tool_result`、`isSidechain=true` 的 subagent scope、`Skill` 成功、session 内有/无 catalog 的完整 `SKILL.md` read、catalog-only、搜索/编辑误报、已知忽略 record class、`subagents/agent-*.jsonl` 的 `unnamed-subagent-file-skipped` diagnostic、compaction 与 resume/fork 去重；失败使用基于通用 `is_error` 契约的合成 fixture 并明确标注。

  Node/Rust 共享 golden vectors，锁定 JCS、u64 decimal、全部二进制值小写 hex/精确长度、domain/length-prefix key、NFC/case-sensitive Capability identity、use-key branch、origin-secret epoch、source order、Turn-local revision 和 `deltaId`；同一 delta 重复解析必须产生逐字节相同的 canonical mutation 与 ID，分段 append、append/replace-session、跨 Turn follow-up、orphan result、Capability GC 与 clean rebuild 则比较 logical Fact closure 和 source-position/parser-state 语义，generation、delta/snapshot id 与 watermark 按下文明确排除。Tool invocation、多次 result 与 corroboration 保持独立 Evidence Event 和多 link，不压成单一状态；同一 Source Record metadata 只存一次，Turn lifecycle 不得产生 `O(CapabilityUse)` link 扇出。分析输出、Fact、checkpoint parser state 与 Projection 不包含 partial raw tail、Skill 正文、绝对路径、Claude Skill args、系统提示词、thinking 或未授权 Tool payload；safe attributes 的封闭 tagged-union schema、compact pointer round-trip、HMAC origin/input/dedupe fingerprint、outputBytes/durationMs 和大小上限都有正负 fixture。origin secret 丢失不得静默重建：普通 `reindex` 必须保留 secret、epoch 和相同输入下的 keyed Fact；只有显式 secret-recovery reindex 或 `reset` 才轮换 epoch、重解析全部 keyed Fact，并使旧 Projection 整体失效。

  Session 去重 fixture 至少覆盖：相同首 prompt 但第一 Turn assistant 内容或 Tool 序列/terminal state 不同不得合并；完整相同的第一 Turn 即使第二 Turn不同也保持同一 weak group，至少两个成员的相同第二 Turn corroboration 才把组标 strong，corroboration 永不改 group key。timestamp 只决定 shape 是否合格，改写 timestamp 不得改变 fingerprint；停在一 Turn与继续到两/三 Turn的同源副本必须仍在同一 group。只有 EOF 尾部 Turn时，`observedEofClosed` 可生成 provisional first-Turn key；同一 raw bytes 的增量/clean build key 相同，后续在原 Turn append 时允许重算并原子失效，追加下一 user Turn后 first-Turn key 冻结。缺 timestamp、缺可见 assistant、无合格第一 Turn或只有普通 parent hint 时 `duplicateGroupKey=null`。Codex file-level subagent 不去重，main session 只用 `forked_from_id ?? id` 一跳 lineage，explicit lineage 后出现时优先并失效路径 Projection。三份 null-dedupe 副本不得被当作已证实独立样本，UI 同时展示 raw/strong/weak/observed-eof-provisional/unknown count 与 dedupe coverage。
- 事务与增量测试覆盖 CAS 冲突、frame 中断、commit 后 ACK 丢失时同一 `deltaId` 的幂等重放、append、open Turn replacement、truncate、排除/pending purge、fact/provider/privacy/duplicate/projection/analyzer/FTS 参数 rebuild 和 SQLite 损坏诊断；在每个 transaction/DB swap/projection swap/purge 边界注入崩溃，恢复后的 Session/Turn/SourceRecord/Event/Turn-Evidence/Capability/Use/Use-Evidence Fact、FTS row、`field_stats`、rollup、change-log semantic roots 与 projection materialization 都与同源 clean rebuild 一致，并通过 `PRAGMA quick_check` 与 FTS5 `integrity-check`。checkpoint 只比较 source-position/parser-state 语义字段：byte offset、partial-tail length/digest、pending state、origin-secret epoch 与各版本轴；`generation`、`deltaId`、snapshot id 与 projection watermark 是 ingestion 历史坐标，不要求逐值等于单次 clean rebuild，只要求引用同一可见 Fact Snapshot 且不超前。SQLite integer surrogate 永不出现在 protocol 或跨重建断言，stable BLOB key 的唯一索引与所有 foreign key 都通过 integrity fixture。测试新增 `capability-retry-summary@v1` Projection 时不得修改 Provider Adapter 或 Fact schema，必须用 input fingerprint 区分同输入 retry 与普通重复调用、从 committed Fact 构建且读取 raw session 为 0 bytes。

  shadow build 使用有界 read transaction 批次扫描期间持续 append/delete/session metadata 变化与两类跨 Turn link 变化，分别验证 occurred Turn、目标 Turn、Use 所属 Turn 与 Capability 的提交前/后失效根全部发出；change log 可追平、tombstone 不复活旧事实、切换 snapshot 与 clean build 等价，超过 64 MiB/1,000,000 条时取消并保留旧 active Projection。fact schema 升级只重解析标记受影响的 session，不能伪造旧 Fact。normalized-row 超过 6 GiB 时必须启动无压缩 packed branch；两种 FactRepository 跑同一 mutation trace 的逐 snapshot logical Fact digest、查询排序、Tool path、evidence pointer 与 purge 结果完全一致，并覆盖 packed shadow build/catch-up/switch 的崩溃注入、详情解码延迟和 raw-read=0。packed fixture 必须证明 session-local source ordinal 单调递增且永不复用，回收只留 tombstone，只有 `replace-session`/显式 session rebuild 可物理压实；ordinal 不进入 logical digest 或跨 rebuild 等价；对同一 open Turn 连续 N 次 append 后，未变化 Fact 保持 ordinal，tombstone 数为 `O(实际撤回 record 数)` 而非 `O(N)`；rowid 与 `WITHOUT ROWID` 只能由同 corpus 的容量/点查 benchmark 选择。固定 SQL smoke fixture 必须让 detail-full contentless FTS 的 `bm25()` 对至少两行产生不同非零值，且交换列权重改变排序；四档参数化 df statement 必须命中 `VIRTUAL TABLE INDEX 263`，temp table/CTE JOIN 的 `INDEX 3`/`7` 全词典扫描必须被测试拒绝。DELETE、`optimize`、checkpoint、VACUUM 后已排除 token 不再出现在 live DB/WAL 的逻辑页中；VACUUM 临时数据库只出现在 active DB 同目录，其他 SQLite 临时文件只出现在 state-dir `tmp/`。POSIX 自动化测试断言目录 0700/文件 0600，Windows 测试断言目录、DB/WAL/SHM、origin secret 和临时文件 DACL 只允许当前用户 SID。warm UI 不等待 reconciliation，元数据未变化文件不读正文，变化文件指纹固定 8 KiB，查询读取 raw session 为 0 bytes。
- 冻结至少 60 个带 relevance label 的去敏真实查询 evaluation set，中文、英文、中英混合/代码各至少 20 个，并以独立 development set 调整 rank decay/权重且保存分量消融；candidate Recall@300 `>= 0.90`、最终 Top-20 Recall `>= 0.85`、NDCG@10 `>= 0.75`，精确 identifier、错误码和引用短语均有命中 fixture。本机原始问题、路径和 session id 不得进入仓库，只提交去敏 fixture 与聚合报告。对 mutation trace 的 100 个确定性查询，在相同注入时钟下，增量 snapshot 与 clean rebuild 的候选、稳定排序和 Tool path 分组完全一致；在记录硬件与 corpus 构造方法的 25,000 / 250,000 Turn benchmark 上达到《容量与复杂度预算》全部门槛，并单列 df lookup、posting traversal、filter、rerank、delete/replace delta 与 purge maintenance 成本。
- Dashboard 能按 provider、项目、日期、Skill、Tool、问题和结果证据筛选；状态区统一展示 eligible、excluded、ambiguous、file/inline subagent 与 unknown-scope excluded、`unnamed-subagent-file-skipped`、rolled-back、indexed、raw/strong-group/weak-group/observed-eof-provisional/unknown-dedupe session count、byte progress、hard-sealed、quiescent、open、evidence coverage、snapshot age/pending、purge state、Fact storage profile、index location/size 和 recent errors。服务只绑定随机 loopback 端口，严格校验 Host、禁用 CORS，并通过权限受限的一次性本地 bootstrap 文件 POST 凭据；凭据不得进入 URL、浏览器 argv、日志或 referrer。任何“效果”结论都能下钻到 session/Turn 证据或明确显示 unknown。

## 子项契约

### ITEM-1：Provider Session Evidence

- 类型：`cs-feat`
- 依赖：无
- 可交付结果：与现有同步导出 API 并存的流式 session record reader、Codex/Claude Provider Evidence Adapter、provider 权威记录类 fixture 索引，以及 schema-validated `SessionFactsDeltaV1` tagged union；Adapter 产出 Session/Turn/Source Record/Evidence Event/Turn-Evidence/Capability/Capability Use/Use-Evidence Fact 和 checkpoint，不产出 Projection。
- 验收要点：旧 exporter 函数签名、返回结构和输出深度等价；Codex 在 Turn 解析前识别 `thread_source=subagent`/`source.subagent.thread_spawn` 并只产 Session scope/coverage，main session 只用 `response_item` user message 建 Turn，user/assistant `event_msg` 孪生只作可选交叉校验，Tool invocation/result 只取权威 `response_item`，不同 id namespace 的 begin/end 不创建 Event/Use；`task_started` 暂存后归属下一权威 user Turn，terminal 只按明确 `turn_id` 或唯一状态机配对，rollback 只规范化为带 `num_turns` 的 session-scoped Event，不由 Adapter 选择历史目标。Claude `isSidechain=true` 标为 subagent，外部 `agent-*.jsonl` 形成稳定 diagnostic。Skill 身份只取首部结构化 `<name>`，inferred load 只读 source order 更早的 session 内 catalog，Claude 无 catalog 时不推断；Skill body、路径和 args 不进入分析事件。fixture 同时锁定 first-Turn group key、second-Turn corroboration、`observedEofClosed` 重开、Codex 一跳 lineage、provider originator version、input/origin fingerprint、outputBytes/可用 duration。stable key 使用 domain-separated length-prefix encoding，所有 binary canonical JSON 使用小写 hex，Node/Rust golden vector 逐字节一致，source order 不依赖 timestamp，normalized Source Record + compact pointer 必须还原相同 byte range/JSON Pointer/record digest；checkpoint 只存 partial-tail length/digest、origin-secret epoch 和 privacy-safe pending state；未知、无效、超大或越界记录形成有界 diagnostic，不导致整个 session 失败。

### ITEM-2：Turn Analysis 与单 Session 报告

- 类型：`cs-feat`
- 依赖：ITEM-1
- 可交付结果：按分析 Turn 与三态闭合规则关联 Tool、Skill 和结果证据；保留 invocation/result/corroboration 的独立 Use evidence，以及只关联 Turn 的 lifecycle/rollback evidence、execution state、origin scope 与 confirmed/inferred strength；Codex 权威 `event_msg:turn_aborted` 映射为 `turn-lifecycle(aborted)` Fact、hard-seal 明确匹配的当前 Turn，`abandoned` 作为展示 Projection，隐藏 `<turn_aborted>` 仅作交叉校验；provider rollback 保留 Fact 但默认隐藏被撤回 Turn，subagent/unknown scope 不进入 main 统计；提供 `threadshare analyze <codex|claude> <session>` 的本地 text/JSON 分析入口，并复用既有 session resolution 与 CLI diagnostic 契约。
- 验收要点：hidden message、tool result 和 Codex `event_msg:user_message` 不启动 Turn；后继 `task_started` 不改写前一 hard-sealed Turn revision，后继 user boundary 的 follow-up link 则必须合法更新前一 Turn revision；Engine 对 `thread_rolled_back.num_turns=N` 重放 committed active hard-sealed main Turn，选择完整目标并同步更新 revision/Projection，无法完整解析时不部分应用；多次 invocation/result 不被压平，同 input fingerprint 的 retry 与普通重复调用可区分，使用量、Tool/Skill 顺序、execution state、output-size/可用 duration、evidence strength、closure reason、source order 和全部 evidence pointer 可复现；不调用外部模型，不建立 Skill/Tool 调用树，不把加载、completed、exit 0 或单次 validation 自动升级为 solved/effective。
- CLI 契约：`analyze` 与后续 `insights` 命令必须登记到 `COMMAND_SPECS`，`QUERY_TOO_LONG`、`QUERY_TOO_BROAD`、Engine 缺失/损坏和 purge 状态必须登记到 `DIAGNOSTIC_CODES` 并通过既有稳定性测试；所有本机 diagnostic 复用 `sanitizeDiagnosticProblem`，不得旁路绝对路径脱敏。

### ITEM-3：Rust Insights Engine 与原生交付

- 类型：`cs-feat`
- 依赖：ITEM-2
- 可交付结果：独立 Rust sidecar、bundled SQLite/FTS5、protocol v1 handshake 与有界 session-batch frame、`factSchemaVersion`/provider adapter/privacy policy/projection/analyzer capability negotiation，以及 `@team-harness/threadshare-<target>` 命名的 darwin/linux/win32 x64/arm64 平台 npm optional packages；发布后的根包用精确同版本 optional dependency 解析当前平台 binary，Linux 优先交付静态 musl artifact 以避免依赖用户系统 glibc。单一 target matrix 在 CI 隔离 staging 中生成六个带 `os`/`cpu` 的平台 manifest/tarball；平台包不得成为源码 npm workspace、源码 dependency 或源码 lockfile member。本地开发和测试只用显式 `THREADSHARE_INSIGHTS_ENGINE_PATH` 指向本地 binary，不提交 `file:` 覆盖或 lockfile 污染。源码 `package.json`/lockfile 继续描述可独立 `npm ci` 的现有根项目；verify job 在隔离 staging 复制精确 allowlist 文件，并由确定性 generator 生成发布根 manifest，唯一允许的语义差异是按 target matrix、package name 排序注入六个等于 release tag 的 optional dependencies。发布 manifest 不反写源码或 lockfile。
- Protocol 版本契约：handshake 与 `BEGIN_SESSION` 必须协商/校验 `factSchemaVersion`、provider adapter、privacy policy、origin-secret epoch、duplicate policy、Fact storage profile、Projection 和 analyzer capability；不支持的组合在写入前返回稳定 diagnostic，不能部分接受后再迁移猜测。
- 源码与发布 staging 契约：源码 `package.json` 和 lockfile 必须断言六个平台 package name 完全不存在，源码版本三处仍与 release tag 一致；staged root manifest 单独断言六个 exact-version optional dependencies。平台稳定版本发布后，每个目标 runner 必须从本地 staged root tarball clean-install，让 npm 从 registry 只解析匹配 Engine 并通过 handshake；不得同时传入本地平台 tarball 绕过真实 consumer resolution。平台稳定版本尚不存在而 packument 为 404 或只含 `bootstrap` dist-tag 都属于合法预发布状态。
- 一次性外部前置条件：npm 只有在 scoped package 已存在后才能配置 Trusted Publisher。首个稳定 Engine 版本之前，organization owner 必须单独授权一次 bootstrap 例外，并先更新仓库 `AGENTS.md` 记录该唯一例外；随后在干净临时目录中使用交互式 2FA，把六个不含 binary、不会安装 Engine 的最小平台包各发布为 `0.0.0-bootstrap.0`，仅使用 `bootstrap` dist-tag、public access，不创建或移动 `latest`，不使用 automation token。六个包存在后，逐包配置 organization `team-harness`、repository `threadshare`、workflow `publish-npm.yml` 的 Trusted Publisher，并恢复/确认 require 2FA 和 disallow token publishing。bootstrap 只占用包名和建立信任，不满足任何稳定依赖；不得由普通 release workflow 自动执行，也不得在后续版本重复。本 Epic 获批本身不等于授权该不可逆 registry 动作，执行前仍需 owner 明确确认。
- 验收要点：先以同一 25,000 Turn corpus 对 Node 22 `node:sqlite` reference harness 做回填、query、RSS 与协议开销对照并记录选择依据；六个 artifact 均有 target/ABI/最低 OS、checksum、license/SBOM、代码签名或 notarization、`--version`/handshake/精确 SQLite patch version、FTS5 compile-option smoke test 和真实目标 clean-install 矩阵。pinned npm 12.0.2 fixture 必须证明源码 checkout 在平台包尚未发布时按现有 lockfile `npm ci` 成功、源码 manifest/lockfile 均不含六个平台包名、staged root tarball 含六个 exact optional dependencies、带 `os`/`cpu` 的平台包不进入 workspace，以及 registry consumer-resolution 矩阵只安装匹配 Engine。release verifier 必须把 `PACKAGE_NAME`、metadata 校验与 `EXPECTED_PACKAGE_FILES` 参数化成 staged root 加六个平台包的七项矩阵；staged root 为精确 allowlist，平台包各有只包含 manifest/license/binary 的独立 allowlist，不能把 binary 混进根包。版本校验覆盖源码 `package.json`、lockfile 顶层与 root package、staged root manifest 的 version/六个 optional dependency 值，以及六个生成的 package/build manifest，全部等于 release tag；generator 测试保证 staged manifest 除六个 optional dependencies 外与源码公开字段深度等价。`decidePublish`、`validatePublishedRelease` 与 `assertPreparedIntegrity` 必须显式区分两类包：包含确定性 Dashboard 资产的 staged root 继续逐位比较 registry/prepared integrity；平台包重跑则按 immutable registry integrity、attested workflow/source SHA、内嵌 build manifest 与目标 smoke 判定，不拿新签名的随机字节和既有 tarball 做伪可复现比较。
- 发布契约：创建稳定 GitHub Release 前，候选 main SHA 必须通过 pinned Rust/Node/npm/Vite/toolchain 的六目标 build、smoke，以及签名前 unsigned binary和 staged root 的两次独立 clean build；两次 staged root tarball integrity 必须相同，Dashboard 文件名、内容、archive ordering、mtime 与 manifest 排序必须确定。随后平台 binary 只签名/notarize 一次。release verify job 生成并保存本次将发布的六个已签名平台 tarball 与同一个 staged root tarball，publish job 使用这些 artifact，不重新构建、签名或打包。固定 `SOURCE_DATE_EPOCH`、path remap、Cargo.lock、linker/build-id、pinned Vite/Node/npm 与 archive ordering；全部七个 npm package 配置同一 Trusted Publisher workflow 和 SLSA provenance。平台包先逐个 publish/confirm；六个均成功后，各目标 runner 从本地 staged root tarball 安装、从 registry 解析匹配平台包并再次 handshake，全部通过才 publish 已保存的 staged root tarball。重跑时，对 registry 已存在的平台包验证 immutable integrity、attested workflow/source SHA、内嵌 build manifest 与 smoke test 后跳过，不要求新签名字节等于已发布 tarball；只构建、签名和发布缺失包。若任一平台包已发布，而 provenance/source、生成 manifest、binary 或 workflow 必须通过改源代码才能修复，则该版本与 tag 保持不可变，根包不得补发，修复后升新版本；不能把“根包尚未发布”误判成可删除 Release/tag 的未发布状态。不得提交 binary、运行 postinstall 下载、本机 Rust 编译或未校验 binary；unsupported/missing/corrupt binary 只禁用 Insights，不能破坏既有 CLI。
- 制品传递与来源验证：release verify job 必须生成六个已签名平台 `.tgz`、同一个 staged root `.tgz` 和 attempt-scoped `release-manifest.json`，以 `run_id/run_attempt` 隔离后上传；manifest 至少记录每项的 package name、version、target、tarball 名、npm SHA-512 integrity、raw SHA-256、source SHA 与 build-manifest digest。publish job 只能下载这批 artifact，逐项校验 manifest、raw SHA-256、npm integrity、source SHA 和 build manifest 后执行 `npm publish ./artifact/<name>.tgz --provenance`；不得再次运行 prepare、build、sign、pack，也不得从 checkout/cwd 发布。发布后 provenance 验证必须覆盖 Sigstore bundle、subject tarball digest、workflow `publish-npm.yml`、release tag ref，以及 `resolvedDependencies.gitCommit == RELEASE_SHA`，不能只检查 predicate type。重跑时，对 registry 已存在的平台包下载 registry tarball并验证上述事实后跳过，只发布 release manifest 中仍缺失的 artifact。ITEM-3 必须同步更新 release verifier、workflow、自动化测试和 `AGENTS.md` 的七包 allowlist、一次性 bootstrap、artifact-first 发布与恢复规则。

### ITEM-4：事务化可恢复增量索引

- 类型：`cs-feat`
- 依赖：ITEM-3
- 可交付结果：SQLite Fact repository、内部 normalized-row/`packed-facts-v1` FactRepository seam、独立 source checkpoint、detail-full FTS/rollup/未来分析 Projection、`projection_state`、有界 `projection_change_log`、single writer、`SessionFactsDeltaV1` CAS transaction、后台索引 worker、增量 reconciliation、排除规则、fact/provider/privacy/dedupe/projection rebuild、可恢复 logical purge、保留 secret 的普通 reindex、显式 secret-recovery reindex、reset 与状态诊断。
- CLI/密钥契约：普通 `threadshare insights reindex` 保留 origin secret/epoch；只有显式 `threadshare insights reindex --regenerate-secret` 可在稳定确认后轮换 secret/epoch、重解析全部 keyed Fact 并重建全部 Projection，成功前旧 snapshot 继续可读；`reset` 仍删除全部派生状态与 secret。secret 缺失/损坏时普通命令返回稳定 diagnostic 和该恢复命令，不得自动轮换。
- 验收要点：以至少 10,000 个 synthetic session、大文件和 mutation trace 验证 O(files) 后台发现、O(new bytes) 日常解析、固定并发、WAL 背压、增量替换和 clean rebuild 等价；在 frame、transaction commit、versioned DB/projection/packed swap、DELETE/optimize/checkpoint/VACUUM 边界注入崩溃；分 N 次 append、时钟派生 quiescent、后续重新打开与一次解析在相同注入时钟下 Fact/Projection 一致；普通 reindex 保留 secret/epoch/keyed Fact，secret-recovery reindex 与 reset 才轮换并原子替换完整 keyed Fact/Projection；新增 test-only retry Projection 时 Adapter 与 Fact schema 零改动、raw 读取为 0，projection failure 或 change-log cap 保留旧 active 版本并显示状态；排除结果立即不可查且 purged 状态只在清理完成后出现，reset 后排除规则仍生效，stale lock 可恢复，数据库损坏可诊断且不触碰 raw session。显式固定为当前 SQLite 默认值的 `automerge=4`、`deletemerge=10` 只为防止未来默认漂移，不宣称已经调优；Source Record normalization、integer foreign key、Event/Turn-Evidence/Use/Use-Evidence、projection change log 与 shadow build 的容量、lifecycle 扇出、tombstone/segment 数量、写放大和查询延迟必须纳入同一 30% 样本及 250,000 Turn mutation benchmark；Fact >6 GiB 或稳态 >8 GiB 必须执行无压缩 packed 分支，仍不达标则 ITEM 保持 blocked。

### ITEM-5：历史问题检索与证据路径

- 类型：`cs-feat`
- 依赖：ITEM-4
- 可交付结果：混合中英文/代码 analyzer、FTS5 BM25 候选、IDF coverage/exact 有界重排、结构化 filter 和 Tool 路径归纳；每个结果与路径都指向本地 session/Turn 证据，并公开可解释评分分量。
- 验收要点：先用同一 30% 分层样本复测 detail-full FTS 容量，再让 25,000 与 250,000 Turn corpus 达到延迟/RSS/磁盘预算；candidate Recall@300、最终 Recall/NDCG 与分量消融达到门槛；不调用外部模型，不做全库 LIKE/Levenshtein/raw fallback，不产生 Skill 推荐、因果结论或单一“最佳”分数；路径形成与 `insufficientSample` 只引用《共享语言》的单一定义，raw/strong-group/weak-group/observed-eof-provisional/unknown-dedupe count 必须同时可见。

### ITEM-6：本地 Insights Dashboard

- 类型：`cs-feat`
- 依赖：ITEM-4、ITEM-5
- 可交付结果：`threadshare insights` 绑定系统分配的 loopback 端口并打开本地 Dashboard；提供总览、Skill/Tool 详情、历史问题搜索、Tool 路径、Turn 证据链、过滤、索引位置/占用和进度；Dashboard 使用固定无 hash 的构建文件名，以一个目录条目进入根包 `files`，release verifier 将目录展开为排序稳定的精确文件 allowlist，任何多余资产都失败，并设置 pack 压缩/解压体积上限。Dashboard build 禁止嵌入挂钟、绝对路径、随机 id 或不稳定 chunk ordering，纳入 staged root 两次 clean-build integrity 等价验收。
- 验收要点：缓存可用时 UI 不等待 raw session reconciliation；部分索引明确展示 pending/stale、pending purge、Codex file/inline 与 Claude sidechain/agent-file scope、unknown scope、rolled-back、Turn closure、raw/strong-group/weak-group/observed-eof-provisional/unknown-dedupe session count 与 evidence coverage；启动器生成权限仅当前用户可读、含 one-time secret 的临时 HTML，通过自动 POST 换取 HttpOnly/SameSite 本地会话并立即删除，secret 不进入 URL/argv；Host、DNS rebinding、异常 Origin、无 CORS、端口冲突、CSP 和路径脱敏有自动化测试；同 OS 用户视为可信，因为其已能读取原始 session。第一版 UI 不修改持久化排除规则。

## 最终交付索引

待各子项完成后记录代码、测试、CLI、Dashboard、性能证据和文档指针。

## 整体验收

在保留现有公开 Threadshare 行为的前提下，用户只安装 `@team-harness/threadshare`，在支持平台无本机编译地取得 Rust Engine；使用接近 2026-08-09 本机基线规模的 corpus 完成首次后台回填、暖启动、活跃 session 增量更新、Skill/Tool 下钻、问题检索和 Tool 证据路径流程，并以 250,000 Turn corpus 验证长期增长余量。Fact Model v1 的 provider 权威、lifecycle 归属、stable key/小写 hex、Source Record/compact pointer、source order、多证据关系、append/replace ownership、session 去重、subagent scope、rollback visibility、隐私裁剪/secret epoch 和 provider-neutral Interface 必须由真实形状 fixture 锁定；新增同输入 retry-summary Projection 必须证明未来分析可以在 Adapter/Fact schema 零改动、raw session 零读取下扩展。实测并按 provider 报告 gold-set 检索质量、查询延迟/RSS/磁盘、Fact/Projection 分项容量、raw/strong/weak/observed-eof-provisional/unknown group 数，以及满足《共享语言》唯一 evidence-path 门槛的查询数；Claude 基线还必须对照仅 hard-sealed 的 null 比例与启用 `observedEofClosed` 后的比例，不能把单 Turn 历史静默丢出分母。normalized Fact 越过 6 GiB 时必须以无压缩 packed layout 重新通过 6/8 GiB 与逐逻辑 Fact 等价门槛，不把 Skill 稀疏信号包装成建议。验证数据始终留在本机，UI 对覆盖率与不确定性表达准确，并运行受影响的 CLI、Viewer、API、release、Cloudflare、FC 和 Skill 验证。

## 遗留风险

- Provider session 格式会随 Codex/Claude 版本演进；adapter 必须用 fixture 锁定已知形状，并把未知形状转成 coverage diagnostic。
- 第一版不分析 Codex/Claude subagent 活动或子 session；Codex 已识别的 file-level subagent 只保留 Session scope/coverage，inline subagent 与 Claude sidechain 只保留局部 scope Fact，Claude `agent-*.jsonl` 仅计 skip diagnostic，全部从 main 统计排除。无法识别的新 provider 形状仍可能造成覆盖偏低或过度归因，Dashboard 必须按 provider 显式展示该限制。
- 结果证据只能表达相关性，无法证明某个 Skill 或 Tool 导致问题解决；未来若增加模型分类或团队聚合，必须另行确认隐私与产品边界。
- SQLite/FTS5 的 lexical 召回无法识别无词面重叠的同义问题；只有 250,000 Turn benchmark 或质量 gold set 以可复现证据越过门槛，才评估 Tantivy、向量或其他 backend，迁移不能改变 Engine protocol、本地优先和公开契约隔离。
- 原生平台包扩大 release 与供应链表面；每个支持 target 必须独立验证 integrity/provenance，未覆盖的 libc、旧 OS 或架构必须明确报 unsupported，不能在安装时临时下载可执行文件。
- 本地索引保存 bounded problem text，并在 detail-full FTS 中保存可逆 token 与位置；排除/reset 的 logical purge 不能清除 SSD、文件系统 snapshot 或外部备份，UI 与文档必须把这一残余风险说清楚。
- 同 size/mtime 的静默 session 改写，或修改未采样中段后继续追加，可能不会被 warm reconciliation 发现，用户需通过 `reindex` 修复；Claude Skill 失败 fixture 目前只有合成数据，未经真实失败记录验证。
- 没有可见 assistant、provider boundary timestamp 或可用 hard-sealed/`observedEofClosed` 第一 Turn 的 session 无法生成 `duplicateGroupKey`，因此只能作为 raw match、不计独立路径样本。Claude 没有 terminal 事件，若只接受 hard-sealed，实测 289/475（61%）主 session 会是 null；`observedEofClosed` 专门降低该缺口，但其 group 明确为 provisional，后续在原 Turn append 时可能重算。first-Turn exact-content group 会把两个独立但第一 Turn 逐事实相同、第二 Turn不同的会话保守合并，可能低估支持度，但不会把同源的一/两/三 Turn副本拆组。Codex explicit lineage 只追一跳，不递归合并更长 fork 链，可能漏合并深层副本。
- Claude `subagents/agent-*.jsonl` 缺少与主 UUID session 相同的 canonical identity，v1 只保留 provider/project 级 skip coverage，不伪造 Session Fact；因此 Claude subagent coverage 粒度低于 Codex file-level subagent，跨 provider 比例必须标注分母差异。
- Codex 权威 `response_item` 通常不提供 Tool duration，`durationMs` 大多为 unknown；第一版的耗时分析覆盖率会明显低于 output-size/调用状态，Dashboard 不得把缺失当作 0。
- `packed-facts-v1` 会增加详情解码与 Projection rebuild CPU，并降低直接 SQL 排障便利性；若无压缩 packed 仍越过 6/8 GiB 或延迟门槛，必须保持 blocked，不能静默丢事件、读取 raw session 查询或放宽预算。
