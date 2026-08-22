# Team Memory Phase 2 详细技术设计

状态：Completed / Accepted（2026-08-21；上游规格为 [team-memory-proposal.md](./team-memory-proposal.md) rev8；三轮独立设计审查与最终独立实现审查已通过，无 Blocking/Important）

Phase 2 只交付三个既定子项：L2/L3 归纳闭环、`extraction-candidates@1` Recipe、assemble adapter 扩展。Phase 3 的 Skill 提取与跨仓共享不进入本阶段。

## 1. 完成定义

Phase 2 完成必须同时满足：

1. `memory consolidate` 能从当前 owner 的 approved L1 增量生成绑定输入的 pending plan；只有显式授权后，受限 Runner 才能读取 L1/scene/doctrine，并提交 `ConsolidationPatch@v1`。
2. Patch 经过 Rust 事务内的确定性容量/路径/schema 校验与宿主 heat 物化后进入本机隔离区；每个 operation 都是 `unverified`，必须逐条人工确认，再经 owner/blob/policy CAS 的 PromotionPlan 写入或删除 scene/doctrine 文件。
3. 会话选材的权重、门槛和稳定排序只在 Insights Recipe `extraction-candidates@1` 中实现；Node 只提供 Search 选出的精确 Turn 集并消费 Recipe 结果，不保留第二份权重算法。
4. `assemble --provider claude|codex` 分别维护根目录 `CLAUDE.md` / `AGENTS.md` 的单一生成块；L3 全文注入，L2 只注入 `path + heat + summary` 导航。
5. fake runner 只覆盖确定性故障；真实 `codex` live gate 必须完成一次 consolidation。相关 Node/Rust、MCP、release、Skill 与全量回归全部通过。

## 2. L2/L3 归纳契约

### 2.1 `ConsolidationTask@v1`

Threadshare 发送给 Runner 的唯一输入：

```text
{
  format, taskId, lease,
  binding: {
    databaseUuid, memoryStateUuid,
    owner: { repositoryKey, worktreeKey },
    approvedProjection: { generation, analyzerVersion, coverage, sourceTreeDigest },
    entrySetDigest,
    entryRevisions: [{ entryId, revision, contentDigest }],
    sceneIndexDigest,
    sceneRevisions: [{ name, contentDigest, heat }],
    doctrineDigest,
    replay: { mode: incremental | full, afterSuccessfulRunId: string | null },
    promptVersion, schemaVersion, policyVersion
  },
  entries: [{ entryId, revision, contentDigest, type, scene, priority,
              confidence, body }],
  scenes: [{ name, contentDigest, heat, content }],
  doctrine: { contentDigest, content } | null,
  policy,
  contract: { patchSchema, prompts }
}
```

`entries` 只含自最近一次成功归纳后新增或内容变化的 approved L1；第一次归纳包含当前全部 approved L1。输入按 `entryId`、scene `name` 排序。正文、scene、doctrine 字节均进入 binding digest 与 Runner coverage。

`approvedProjection.coverage` 必须为 `complete`。Node 不直接遍历 Runner 输入文件；它通过仅宿主可用、不对 MCP/Runner 暴露的 Rust `list-memory-files` / `read-memory-file` 操作，以 descriptor-relative no-follow 方式重读 approved L1、scene 与 doctrine，任一父级或最终组件 symlink 都在 Runner 启动前 fail closed。Rust 在 `submit-consolidation`、`promotion-plan` 和 apply mutation 前 precheck 三处再次校验完整 approved L1 源树、完整 scene 文件集合、逐文件 digest/heat、doctrine digest 与 replay epoch。owner、generation、source tree、成功基线、任一条目/文件变化或新增未绑定文件都使任务/计划失效。全局 Insights snapshot 因无关 Session 前进不单独导致失效。

### 2.2 `ConsolidationPatch@v1`

Runner 只能返回声明式变更：

```text
{
  format, taskId, binding,
  operations: [{
    operationId,
    op: create | update | merge | delete,
    target: scene | doctrine,
    name,
    newContent: string | null,
    basedOnEntryIds: string[],
    mergeSources: string[],
    rationale: string
  }]
}
```

Runner 必须原样回传 `taskId` 与 `binding`。`basedOnEntryIds` 只能引用任务中的 L1；`mergeSources` 只能引用任务中的 scene。Threadshare 不接受 Runner 自报的 evidence strength、claim support、路径、文件操作或 heat。scene `newContent` 中即使出现 heat，提交时也忽略其值并由宿主重写；除 heat 外的 META/body 必须满足严格 grammar。

提交后产生的 consolidation candidate 使用固定顶层形状：

```text
{
  candidateKind: "consolidation-patch",
  runId, binding, operations,
  statements: [{ statementId: operationId, operation }]
}
```

`statements` 与 `operations` 必须按 `operationId` 一一对应、数量相等，Rust 在 submit 与 promotion-plan 两处都复核；缺少任一 assessment 均拒绝。每个 operation 在隔离区形成一条 review statement。`statementTextDigest` 绑定**宿主物化后的** canonical operation（包括重写 heat 后的 `newContent`），而不是只绑定 rationale；因此人工确认后任何正文变化都会失效。`citationsDigest` 固定为按 `entryId` 排序的 `{ entryId, revision, contentDigest }[]` canonical digest，来源只能是 `basedOnEntryIds`。引用 approved L1 只形成 `contextual` provenance，生成内容仍为 `unverified`。

promotion-plan 对 `candidateKind` fail closed：entry plan 只能含 entry candidate；consolidation plan 必须且只能含一个 `consolidation-patch` candidate。consolidation 的 `perFile` 由 Rust 从已确认的宿主物化 operation 派生；即使 Node 同时传入预览值，Rust 也必须逐项验证 target、operation、bytes 与 statement digest 完全一致，避免“确认 A、写入 B”。

### 2.3 确定性策略门

Threadshare 在落隔离区前验证完整 Patch，任一 operation 非法则整批拒绝：

- 默认更新已有 scene；每批最多 CREATE 1 个 scene。
- 当前 scene 数 `>= 12` 时 CREATE 必须有明确无法并入现有 scene 的 rationale；`>= 14` 禁止 CREATE；`>= 15` 时 Patch 必须包含 MERGE/DELETE 并使最终数量 `< 15`。
- 最终 scene 数不得超过 15；同一文件在一批内只能有一个最终写入者；merge source 不能被其他 operation 再更新。
- scene `newContent` 的 summary/body 必须通过 Rust 与 Node 的等价 validator（summary <= 40 字符、body <= 1500 字符）；doctrine 必须通过等价的 `validateDoctrine`（<= 1200 字符）。所有“字符”固定按 Unicode scalar value/code point 计数（Rust `chars().count()` 等价于 JS `[...value].length`），不是 UTF-8 bytes 或 grapheme；输入先把 CRLF 规范化为 LF、移除行尾空白并保留正文内部空行，再计数和 digest。容量、最终 scene 数、路径派生、operation 冲突与内容 grammar 的权威门在 Rust submit transaction 内，Node 只做提前报错。
- doctrine 的 `name` 固定为 `doctrine`，每批最多一个 doctrine operation；doctrine 不接受 merge source。
- create/update/merge 必须有 `newContent` 和至少一个 `basedOnEntryId`；delete 必须 `newContent=null`。路径只由 `target + name` 确定，Runner 不能提供路径。

scene heat 只由宿主确定性计算并写入最终 `newContent`：CREATE = 1；UPDATE = 原 heat + 1；MERGE = 所有 source heat 之和 + 1。结果使用 checked `u32` 加法且上限为 `2_147_483_647`，溢出即拒绝，不做饱和或 Runner 覆盖。DELETE 无 heat。Rust 重算并比对 Node 的物化结果；Runner 自报 heat 的值永不进入候选、排序或 git。

Patch 允许空 operations。空 Patch 以 no-op 完成归纳游标，不创建候选，也不需要人工批准。它会改变 `successfulRunId`；下一次 `--full` 把该值作为宿主持久化的 replay epoch 绑入 task digest，因此即使 L1/scene/doctrine 字节完全未变，也会产生新 taskId 并可再次交付 Runner。

### 2.4 事务与增量游标

memory-state schema v2 新增 `candidates.candidate_kind`（旧行回填 `entry`）、`consolidation_runs` 与 `consolidation_run_entries`：

- `submit-consolidation` 在一个 `BEGIN IMMEDIATE` 内执行 claim/lease CAS、幂等 submission、绑定校验、run/entry-set 持久化、单个 patch candidate 与逐 operation assessment 写入、task 提交。
- 非空 Patch 生成一个 `candidateKind=consolidation-patch` 的 quarantined candidate；它不进入 candidate FTS，也不改变 L1 去重召回结果。`review-queue` 必须按 kind 过滤；`memory review` 默认只列 entry，`memory review --kind consolidation` 单独展示 op/target/mergeSources、原文与完整新正文 diff。
- PromotionPlan 成功应用后，同一 closing transaction 把 candidate 置 promoted、run 置 applied，并让该 run 的 entry set 成为下一次增量基线。
- 空 Patch 在 submit transaction 内置 no-op 并成为下一次增量基线，但必须完整保存 entry set；CLI 与 `memory status` 显式报告“本次 N 条 L1 已标记为已归纳且无变更”。`memory consolidate --full` 忽略成功基线、把当前全部 approved L1 重新纳入新任务，并把当前 `successfulRunId` 作为 `replay.afterSuccessfulRunId` 绑入 taskId；无论上次成功 run 是 no-op 还是 applied，同一 entry set 都可重放。空 Patch 不含生成内容，因而不做伪人审；其可见性与 `--full` 可逆性是允许推进的前提。
- 被丢弃、stale 或尚未 promote 的 Patch 不推进成功基线。相同输入已有 pending/review run 时不重复出任务。

open/migration 顺序固定为：先只创建/读取 v1 meta；无版本行的新库直接创建 v2；版本为 1 时进入单个 `BEGIN IMMEDIATE`，迁移并更新版本，提交后再按 v2 完整校验；版本未知则拒绝。失败回滚后仍是可由旧引擎读取的完整 v1，绝不预先执行 v2 DDL 或提前写版本号。

v1→v2 在该事务中按以下顺序重建 `promotion_files`：重命名旧表；创建 v2 表（`operation TEXT NOT NULL DEFAULT 'write' CHECK(operation IN ('write','delete'))`，`sanitized_content` / `sanitized_digest` 对 delete 可空并有成对 CHECK，新增 `intent_state`、`originally_present` 与可空 rollback 原文/digest）；把全部旧行以 `operation='write'` 原样搬入并核对 row count/digest；删除旧表；增加 candidate kind 与 consolidation 表/索引；最后写 schema version=2。旧行按 `applied=1 → intent_state='applied'`、`applied=0 → 'pending'` 回填，`originally_present=NULL` 并标记 `legacy_write_only=1`；legacy plan 在 mutation 前发现漂移时沿用 Phase 1 语义直接 void，绝不进入缺少原文的 rollback；conditional displacement 已产生 hold/new artifact 时则保持 `applying` 并 fail loud，不能把可恢复文件留在终态。既有 extraction/candidate/promotion 行和 applied progress 均保持。

### 2.5 PromotionPlan 删除语义

`PromotionPlan@v1.perFile[]` 向后兼容增加 `operation: write | delete`：缺省为 `write`，旧计划保持可读。

- write：`sanitizedContentDigest` 为 hex64；应用时用 descriptor-relative、no-follow 的同目录原子 displacement/install，不直接覆盖目标名。
- delete：`sanitizedContentDigest=null`，计划必须绑定非空 `targetBlobHash`；应用时复用 `memory_promotion.rs` 的 `open_root → descend → open_parent` descriptor traversal，把目标以 `renameat2(RENAME_NOREPLACE)`（Linux）/`renameatx_np(RENAME_EXCL)`（macOS）原子移入 hold，校验被移动的真实字节后才清理，不对已校验后可能变化的目标名直接 `unlinkat`。
- 整个 apply 在任何 SQLite 状态读取前先持有同一 memory-state 库旁的跨进程独占锁；锁竞争 fail closed，不允许两个进程同时 apply 不同或相同计划。`approved → applying`、转 `rolling_back`/`voided` 与最终 `applied` 均以预期 status + mutation phase 做事务 CAS，任一落后 owner 不能作废或覆盖正在推进的计划。新计划只接受当前 `sanitize@1` policy；apply 在 mutation 前重算全部候选/逐 statement assessment 快照并比对 `assessmentDigest` 与 policyVersion。候选一旦被 approved/applying 计划占用，`confirm-statement`、`discard-candidate` 和裁决合并都不得再修改它；快照漂移只能在写文件前作废计划。
- journal 阶段固定为 `precheck | mutating | rolling_back | done`。`precheck` 先对**全部**目标做 owner/blob/assessment/policy CAS，并在一个事务中保存原始 bytes/digest、`originally_present` 与每个文件的 pending intent；任一 observed blob 不等于 `targetBlobHash` 都在 mutation 前整份 void。目标内容碰巧等于 write 结果也不能跳过此 CAS；delete 没有 `already_exact` 快路。
- 每个文件在动手前先单独提交 write-ahead `intent`。hold/new 路径由已持久化的 `planId + targetPath + forward|rollback` 确定性派生；先以 no-replace rename 原子捕获 mutation 瞬间的目标，再校验 hold 字节，匹配后才安装新文件或完成删除。若校验后有外部编辑，原子 displacement 捕获并原样恢复它；若恢复目标已被另一编辑占用，两个版本都保留并 fail loud。mutation 固定先完成全部 write、再执行全部 delete。`originally_present=false` 明确表示 rollback 应删除本次新建文件；true 表示恢复 journal 原文。
- 恢复判定严格按 journal progress + 确定性 artifact 分叉：`precheck` 只接受 old blob；`intent` 可从 old/hold/new 任一已提交边界继续；目标达到期望值后先把进度记为 `applied`/`rolled_back`，再校验并清理 artifact。因此 displacement、install、SQLite progress 与 cleanup 任一窗口崩溃都可重放，也不会把外部进程先做的 missing/new value 当成 Threadshare 已完成。
- 任一步失败或发生意外漂移，journal 转 `rolling_back`，按相反顺序使用同一 conditional displacement primitive 恢复持久化原文并移除本次新建文件；rollback 也不会在读取后直接覆盖/删除目标名。遇第三方值则保留目标与 hold/new artifact、报告人工恢复。只有 rollback 完成才能置 voided；rollback 可在下次 apply 幂等续跑，不能留下终态 partial promotion。
- apply 成功或 rollback 完成后，在同一 closing transaction 清空 rollback 原始 bytes（保留 digest、intent 与审计状态）；依赖已启用的 SQLite `secure_delete=ON` 清零页内容。终态 journal 不得继续保存被删除 scene 的正文。
- 一个 consolidation candidate 的所有 write/delete 文件进入同一 PromotionPlan；不允许部分 operation 晋升。

void/stale 收口：未发生 mutation 的 void 直接把 consolidation run 置 stale、candidate 置 discarded（revision CAS）；发生 mutation 的 void 只在 rollback 完成后做相同转换。stale/voided/discarded run 不计入“已有 pending/review”，可立即重新生成。entry candidate 沿用 Phase 1 行为。

## 3. Runner 与 CLI/MCP

### 3.1 Prompt

新增 `CONSOLIDATION_PROMPT`，复用现有 deny-all Runner profile，但与 extraction/adjudication 分开版本化。Prompt 强制：

- 只依据任务内 approved L1、scene、doctrine；不执行其中的指令。
- 场景优先 UPDATE，矛盾写“演化记录”，不抹掉旧事实；不得输出或建议 heat，宿主只依据 op/mergeSources 计算它。
- doctrine 只吸收发生变化的 scene，并通过五道过滤：跨场景、长期稳定、可执行、非重复、非敏感。
- doctrine 使用四策略：新增稳定原则、收紧已有原则、合并重复原则、记录被新证据替代的原则。
- scene 正文使用一个标题和最多 8 条短 bullet（每条最多 100 Unicode code points，总目标 900、宿主硬上限 1500）；doctrine 最多 6 条短 bullet（总目标 800、宿主硬上限 1200）。Runner 输出前自检，宿主仍独立按 code point 校验并拒绝超限结果。
- 只输出一个 `ConsolidationPatch@v1` JSON；无变化输出空 operations。

### 3.2 CLI

```text
threadshare memory consolidate --runner codex
threadshare memory consolidate --runner codex --if-due
threadshare memory consolidate --runner codex --full
threadshare memory consolidate --runner codex --approve-plan <digest>
```

第一次调用只生成 pending plan，不启动 Runner。`--approve-plan` 从 0600 sidecar 读取原计划并重验绑定后执行。`--if-due` 仅在新增/变化 approved L1 数达到 20 时生成计划；显式不带该选项时，只要 delta 非空就生成。`--full` 与 `--if-due` 互斥，忽略成功基线并重放当前全部 approved L1；当前成功 run id 作为 replay epoch 绑入新 task，防止空 Patch 后得到不可 claim 的旧 taskId。无 delta 返回确定性 no-op。

MCP 新增 `threadshare_memory_consolidate_preview`，语义与 CLI preview 相同：最多创建 0600 pending artifact，不授权、不启动 Runner，响应不含 L1/scene/doctrine 正文。

### 3.3 真实 Runner 验收

`test:memory-codex-live` 增加 consolidation case：真实 Codex 读取合成的 approved L1/scene 输入，返回合法非空 Patch；测试证明无新可索引 Session、无 shell/文件/MCP 副作用，并完成 parse、submit、逐 operation 确认、promotion 与 `AGENTS.md` assemble。fake runner 不作为 Runner 可用性证据。

## 4. `extraction-candidates@1` Recipe

### 4.1 唯一评分算法

Search 继续负责全文与结构化过滤，并返回最多 200 个完整匹配 Turn。Node 把这组精确 `turnKeys` 以及 owner 派生的 project keys 交给 Recipe；session 集只能由 Recipe 从 turnKeys 派生。Recipe 再次强制：

```text
session eligibility = eligible + main scope + not purged
turn eligibility    = active + revision present + hard-sealed + 位于精确 turnKeys
session gate        = eligible turn count >= 3

score = direct_delivery_edge_count * 40
      + observed_delivery_edge_count * 25
      + recovered_failure_chain_count * 15
      + min(round(main_capability_invocations * 10 / eligible_turn_count), 10)
      + (has_conclusive_final_answer ? 5 : 0)
```

direct/observed 只计所选 Turn 到 commit 的 distinct Delivery Trace edge；不计递归展开得到的 file/intent 边。结果按 `score DESC, sessionKey ASC` 排序。Recipe item 返回原始 count、各 contribution、总分和 session evidence target。

Node 不再导出权重常量或重算 score；它只校验 Recipe item 与 Recipe 已声明的稳定顺序。`MAX_EXTRACTION_CANDIDATE_SESSIONS = floor(MAX_TURN_KEYS / MIN_ELIGIBLE_TURNS) = floor(200 / 3) = 66`，因此 `extraction-candidates@1` 是唯一允许 `limit <= 66`、response `items <= 66` 的 Recipe；Node 固定请求该派生常量并要求 `truncated=false`，不做不存在的 Recipe 分页。该 Recipe 从 `turnKeys` 自行派生 session，拒绝同时提供 `sessionKeys`。Search/Recipe snapshot 不同则整次重试。

### 4.2 协议与覆盖

通用 Recipe filter 增加仅 `extraction-candidates@1` 可用的 `turnKeys`（最多 200）。其他 Recipe 收到它必须拒绝；该 Recipe 要求非空 turnKeys、拒绝 sessionKeys，并无条件拒绝 `allowDegraded=true`。Recipe 必须验证每个选中 project 到同一个 repository 的映射唯一、repository 状态 available 且 Delivery Graph coverage complete；任一不满足都以 `TS_INSIGHTS_COVERAGE_INCOMPLETE` fail closed，不能由 `allowDegraded` 绕过或把未知 delivery 当 0。

`recovered_failure_chain_count` 是当前 Recipe SQL 内部对所选 Turn 的精确聚合，不调用受 `limit=50` 约束的 `failure-chains@1`，不截断；golden vector 覆盖单 session 超过 50 条 chain。

Recipe schema、Rust/JS protocol validator、CLI/MCP enum、Agent spec、fixture 与 release allowlist 同步更新。

## 5. Assemble Adapter

真相源保持 `.threadshare/memory/**`，装配只生成可再生 block：

| provider | 目标文件 | L3 | L2 |
|---|---|---|---|
| claude | `CLAUDE.md` | doctrine 全文 | scene `path + heat + summary` |
| codex | `AGENTS.md` | doctrine 全文 | scene `path + heat + summary` |

scene 导航按 `heat DESC, name ASC` 排序，最多 15 条；若理论输入超限，生成块明确写出 omitted 数量（正常通过容量门后为 0）。目标都是 owner root 的直接子文件；读取使用 `open(O_NOFOLLOW)`，写入使用同目录临时文件 + atomic rename，不把检查式 `lstat` 描述成逐级 openat。只替换唯一且成对的 Threadshare marker 内字节；END 缺失、重复 BEGIN/END 或顺序错误一律 fail closed 且不写文件，marker 外用户内容逐字保留。重复执行必须 byte-identical，provider 间互不修改对方文件。Phase 2 首次加入 heat 的那次 assemble 是一次有意的生成块升级，之后才要求 byte-identical。

## 6. 验收矩阵

| 风险 | 必须证明 |
|---|---|
| 绑定漂移 | 完整 entry 源树、scene 树、doctrine、owner、成功基线或投影任一变化使 pending/candidate/plan 失效；submit/review/plan/apply 时间窗内新增、修改或删除文件都 fail closed |
| 容量/路径 | 12/14/15 边界、冲突 operation、非法 slug/内容、越界路径全部拒绝 |
| 人审 | 每个 operation 默认 unverified；正文 digest 漂移后旧确认无效 |
| 删除恢复 | blob/assessment/policy drift 在 mutation 前 void；崩溃后 delete 幂等；文件重现不被静默再删；跨进程 apply 互斥且状态转换用 CAS |
| migration | v1 -> v2 保留所有旧表数据；失败不半迁移 |
| Recipe 等价 | Rust golden vector 覆盖权重、四舍五入、tie-break；Node 不含权重实现 |
| coverage | Delivery Graph 不可用时 Recipe fail closed |
| adapter | Claude/Codex marker 外内容保留、heat 排序、重复执行不改字节 |
| 安全 | Runner 批处理的 MCP preview 保持 pending-only、未批准不交付；Agent-native MCP 与 CLI 共享 exact state machine；L1/scene/doctrine 任一父级 symlink 在 Runner 启动前拒绝；真实 Codex consolidation 无副作用 |

必须增加的负例：write 阶段失败时 delete 尚未执行且已写文件可回滚；displacement/install/progress/cleanup 各崩溃窗口均可 forward/rollback 重放；`pending` 文件即使碰巧等于输出也不得被认作已应用，`applied` 新文件被外部删除后不得重建；在 conditional mutation 的校验与 rename 之间替换 write/delete 目标时外部字节必须原样保留且计划 fail loud/rollback；promotion 终态不再保存被删除正文；v1 半完成 legacy plan 保留 progress 且漂移时直接 void；Runner 执行期间 scene 内容变化或新增 scene 使 submit 失败；submit 后修改/删除 approved L1 使 review、promotion-plan 或 apply 失败；replay epoch 在 candidate 或 plan 后推进使 promotion-plan/apply 拒绝且不改文件；review 后 scene 集合变化使 promotion-plan 失败；plan 批准后新增非目标 scene 使 apply 整份 void；批准后 assessment/policy 漂移在 mutation 前 void，且 approved/applying 候选不能 confirm/discard/被裁决合并；另一进程持有 apply 锁时新 apply fail closed；零 assessment consolidation candidate 被拒；混合 candidateKind plan 被拒；`allowDegraded=true` 被硬拒；Delivery Graph partial 被硬拒；Runner 自报 heat 被宿主重写；空 Patch 提交后在输入完全未变时 `--full` 产生新 taskId 并可重新交付；`.threadshare` / `memory` 父级 symlink 对 approved entry、scene、doctrine 三类读取都在 Runner 启动前拒绝；marker 缺失/重复不改用户文件。

协议与发布接线必须同步完成：新增 `ConsolidationTask@v1` / `ConsolidationPatch@v1` JSON Schema；显式更新 `schema/threadshare-memory-promotion-plan.v1.schema.json`（optional `operation` 默认 write；write 要求 hex64 digest；delete 要求 null digest + 非空 blob hash）；更新 `memory-contracts`、memory-state JS/Rust protocol 与 `submit-consolidation`、CLI contract/parser/help、MCP `threadshare_memory_consolidate_preview`、Insights Recipe schema/enum/validator/Agent spec、Skill、fixtures、release allowlist 与 live test。任何一项缺失都不算 ITEM-12/13 完成。

Rust/Node validator 必须共享 golden vectors，覆盖 CJK、代理对 emoji、ZWJ 序列、组合字符、CRLF、尾随空白，以及 40/41、1500/1501 边界；两侧对每个 vector 的 normalized bytes、字符数、digest 与 pass/fail 必须完全一致。

权威验证至少包括：定向 Node/Rust tests、`npm run test:memory-codex-live`、`npm run test:insights-engine`、`npm run test:cli`、`npm run test:release`、`npm run validate:skill`，以及 AGENTS.md 列出的完整发布前验证。

## 7. 实施与验收记录

2026-08-21 的最终候选验收证据（已包含 replay epoch、descriptor-relative Runner 输入读取、完整 L1 源树 CAS、assessment/policy 快照与跨进程 promotion 锁）：

- `npm run test:memory-codex-live` 使用真实 `codex-cli 0.149.0` 与真实模型连接，87.30 秒跑通 conformance、L1 提取、裁决、非空 consolidation、逐 operation 确认、promotion 与 Codex assemble；源 Session 集合未变化，一次性 Runner 目录全部清除。
- `npm run test:insights-engine` 从 Rust fmt/test/clippy/build 到 Node 端到端与证据校验全部通过；Rust lib 116 tests、main 14 tests、memory-state 44/44、Node 363/363。memory-state 覆盖 v1→v2 原子迁移、legacy 半完成 plan 与 artifact 非终态恢复、write/delete conditional displacement 与竞态/崩溃恢复、forward/rollback displacement 后进度提交前恢复、pending/applied 状态边界、终态原文清除、空 Patch 后同输入 full replay、父级 symlink、完整 L1/Scene/Doctrine/replay CAS、assessment/policy 漂移和并发 apply 互斥。
- Node 22.22.3 下，`npm run test:cli` 395/395、`test:viewer` 7/7、`test:api` 32/32、`test:release` 76/76、`test:fc` 19/19 全部通过；Cloudflare build 与 Skill validation 通过。
- Node 22.22.3 / npm 12.0.2 的 `npm pack --dry-run --ignore-scripts --json` 得到精确 95 文件、368,751 bytes compressed、1,721,713 bytes unpacked；低于 368 KiB / 1.75 MiB 硬上限，平台包仍保持精确四文件门。
- `extraction-candidates@1` 的 Rust golden test 覆盖超过 50 条 failure chain、歧义 repository mapping fail closed；Rust/Node 共用 Unicode normalization/count/digest/boundary vectors，Node 已移除第二份评分权重。
