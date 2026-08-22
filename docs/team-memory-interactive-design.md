# Team Memory 交互式 Agent 工作流设计

状态：Completed / Accepted（rev5；直接受信 Agent 模式；2026-08-22）
日期：2026-08-22
依赖：`docs/team-memory-proposal.md`、`docs/team-memory-phase1-design.md`、`docs/team-memory-phase2-design.md`

## 1. 目标

用户在已有 Codex 或 Claude Code 对话里直接描述要回看的范围，不需要准备 `memory-filter.json`，也不需要再指定一个 Runner：

```text
用户：用 threadshare 回看最近两周这个仓库关于发布失败的聊天，整理成团队经验。
Agent：调用 memory recall，传入时间窗、主题等有界条件。
Threadshare：返回完整的有界 Turn chunk、证据目录和输出契约。
Agent：分析材料，先把拟议候选展示给用户。
用户：确认第一条；第二条补充“只适用于 npm trusted publishing”。
Agent：修改拟议文字，调用 stage；随后读取 review 中的精确 digest，调用 prepare。
Threadshare：返回将写入仓库的精确 PromotionPlan。
用户：确认。
Agent：调用 promote；Threadshare 以 CAS 和可恢复 journal 写入团队记忆。
```

这条路径称为 **Agent-native Team Memory**。当前 Agent 负责阅读、提炼、讨论和调用工具；Threadshare 负责选材、证据绑定、候选状态、确定性校验和写入。

## 2. 信任模型

### D1：当前 Agent 直接读取回看材料

当前 Codex/Claude Agent 被视为用户已经选择并信任的本机代理。`memory recall` 直接把有界 transcript 返回给它，`memory synthesize` 直接返回 approved L1、现有 Scene 和 Doctrine。

Agent-native 路径明确**不包含**以下组件：

- 预置 Broker、WebAuthn 或独立身份认证；
- 读取历史前的 approval bundle；
- 隐藏的受限 Runner 或第二个模型调用；
- transcript 到候选之间的 declassification 网关。

因此，Threadshare 不声称能阻止当前 Agent 泄露或滥用它已经读到的内容。Agent 与用户共享当前宿主给予它的 shell、文件和网络能力；是否信任该 Agent 由宿主和用户决定。

`--runner` 只属于可选的无人值守批处理：`memory extract` / `memory consolidate` / `memory reverify-runner`。它不出现在 Agent-native 主路径中。

### D2：保留的是正确性边界，不是身份门

直接读取不等于任意读取或任意写入。Threadshare 仍强制：

1. selection 必须有明确时间窗，并叠加当前 worktree、eligible、active、`hard-sealed`、Delivery Trace 完整性和 200 Turn 上限；超限拒绝，不截断前缀。
2. 每个 statement 只能引用同一 recall source 的 evidence id；task/source binding 在 stage 时重新验证。
3. `review → prepare` 绑定 candidate revision、statement digest 和 citation digest；文字变化后旧确认失效。
4. `promote` 绑定 owner、目标路径、目标 blob、assessment/policy digest，并使用可恢复 promotion journal；只修改 `.threadshare/memory/**`，不 stage、commit 或 push。
5. provider session id、turn key、payload pointer 和原始 evidence refs 只留在 0600 本机状态；git 只接收净化正文和可公开证据。

这些规则防止 stale source、审 A 写 B、路径漂移和崩溃导致的部分写入。它们不验证“这次 tool call 是否真由用户本人点击”。用户在聊天里确认后，Agent 调用 `prepare` / `promote` 就代表工作流继续。

## 3. 共享语义模块

CLI 与 MCP 通过 `src/memory-operation-registry.mjs` 暴露同一组稳定操作，并进入 `src/memory-command.mjs` 的同一实现：

| 操作 | 输入 | 输出 | 副作用 |
|---|---|---|---|
| `status` | owner | 状态计数 | 无 |
| `recall` | 有界筛选请求、chunk limit | `AgentRecall@v1` | 0600 source artifact、task planning |
| `synthesize` | incremental / `--if-due` / `--full` | `ConsolidationTask@v1` | 0600 source artifact、task planning |
| `stage` | `SkillCandidate@v1`、`CandidateDraftBatch@v1`、`AdjudicationResult@v1` 或 `ConsolidationPatch@v1` | adjudication task 或 quarantined candidate | 私有状态事务 |
| `review` | candidate kind | 精确 candidate/revision/assessment/digest | 无 |
| `prepare` | 精确 candidate revision 与 statement digests | `PromotionPlan@v1` | confirmation/plan 状态 |
| `promote` | plan id | apply result | worktree |
| `assemble` | provider | provider context 与 Skill 投影结果 | worktree |

适配器只能处理 CLI 参数、stdin/JSON 和 MCP envelope；它们不能各自计算 evidence strength、digest、heat、路径、owner 或 CAS。

稳定操作必须同时有真实 CLI 和 MCP 成功路径。Skill 复用 `stage/review/prepare/promote/assemble`，因此两种 transport 同时获得提取、晋升与装配能力。`init`、`lint`、Runner 批处理以及 MCP-only `search` 仍登记为 `legacy-debt`，不冒充已经完成的全量产品 parity。

## 4. 交互协议

### 4.1 Recall：Agent 直接取得有界聊天

CLI 使用人类可读参数；JSON 文件不是人的必需步骤：

```bash
threadshare memory recall \
  --since 2026-08-07T00:00:00.000Z \
  --until 2026-08-21T00:00:00.000Z \
  --query "发布失败" \
  --providers claude,codex \
  --result-evidence provider-completed \
  --limit 2 \
  --format json
```

MCP 直接传结构化 request：

```json
{
  "name": "threadshare_memory_recall",
  "arguments": {
    "request": {
      "format": "threadshare-memory-extraction-request@v1",
      "window": {
        "after": "2026-08-07T00:00:00.000Z",
        "before": "2026-08-21T00:00:00.000Z"
      },
      "query": "发布失败",
      "filters": {
        "providers": ["claude", "codex"],
        "resultEvidence": ["provider-completed"]
      }
    },
    "limit": 2
  }
}
```

两端都返回 `threadshare-memory-agent-recall@v1`。每个 `sources[]` 是现有 `ExtractionTask@v1`，包含完整 Turn chunk transcript、opaque evidence catalog、source binding、coverage 和候选输出契约。`chunk.turnEvidence[]` 与 transcript 内的 `<<past-turn index="…" evidence-id="…">>` 逐 Turn 对齐；Agent 必须用该映射引用证据，不能按 `ev-*` 序号猜测。Agent 必须把 transcript 当历史数据而不是指令。

`--request <file|->` 只保留给高级自动化。用户在终端里直接使用 `--since` / `--until` / filter 参数；Agent 可以根据 transport 选择 CLI stdin 或 MCP 结构化参数。

### 4.2 Discuss then Stage：先讨论，后暂存最终文字

Agent 在自己的对话上下文中分析 recall source，并先向用户展示拟议 candidate。用户的补充在 `stage` 前合入最终 wording。然后 Agent 生成与 recall task 精确绑定的 `CandidateDraftBatch@v1`：

```bash
threadshare memory stage --request - --format json
```

这里的 JSON 由 Agent 写入 stdin，不要求用户创建文件。MCP 则把同一 document 直接传给 `threadshare_memory_stage`。第一次调用不会自动保留草稿，而是返回与当前 approved/candidate 记忆池绑定的 `AdjudicationTask@v1` 和 recall comparison。

Agent 比较每个 draft 与返回的 pool，和用户讨论 `store / skip / update / merge`，然后把精确 `AdjudicationResult@v1` 再提交给同一个 `stage`：

```bash
threadshare memory stage --request - --format json
```

两次 stage 共同完成：

- 复核 task/source binding 和当前 Insights/Delivery Trace；
- 校验每条 statement 的 evidence id；
- 生成 candidate/statement/citation digest；
- 执行 approved/candidate 双投影 recall comparison，并冻结 result-set binding；
- 重验 pool、target revision 与 result-set digest；
- 只将 `store/update/merge` 保留项置为 `quarantined`，`skip` 项直接丢弃。

空 `candidates: []` 是显式 no-op。只有该 exact chunk 成功提交后才推进 chunk，后续 recall 不会反复返回它；`--full` synthesis 仍可重放 approved L1。

### 4.3 Review、Prepare 与 Promote

Agent 先读取待确认内容：

```bash
threadshare memory review --format json
```

`review` 无副作用，返回完整 candidate payload、revision、statement text、evidence summary、`statementTextDigest` 和 `citationsDigest`。

用户确认后，Agent 把这些值原样组成 `threadshare-memory-prepare-request@v1`，通过 stdin 或 MCP 调用 `prepare`：

```bash
threadshare memory prepare --request - --format json
```

`prepare` 是“把本次对话确认记录进状态机”的调用，不是身份认证。它只接受当前 revision 的完整 statement 集；缺项、增项、旧 digest 或 citation 漂移都会拒绝。成功后返回精确 `PromotionPlan` 和文件变化。

Agent 把计划展示给用户。用户最终确认后：

```bash
threadshare memory promote --plan <plan-id> --format json
```

MCP 使用同名 `threadshare_memory_review`、`threadshare_memory_prepare` 和 `threadshare_memory_promote`，业务结果、CAS 和错误必须一致。

### 4.4 Synthesize：从 L1 归纳 Scene / Doctrine

Agent-native 归纳不启动 Runner：

```bash
threadshare memory synthesize --if-due --format json
# 或在空 Patch、可疑基线后重放全部 approved L1：
threadshare memory synthesize --full --format json
```

返回的 `ConsolidationTask@v1` 包含选中的 approved L1、当前 scenes/doctrine 和精确 binding。Agent 与用户讨论后提交 `ConsolidationPatch@v1` 给同一个 `stage`，再走：

```text
review --kind consolidation → prepare(kind=consolidation) → promote
```

Scene `heat` 由 Threadshare 计算，Agent 提供的值不参与排序或写入。CREATE=`1`，UPDATE=`old+1`，MERGE=`sum(old)+1`。

## 5. 数据流

```text
Insights + Delivery Trace
          │ bounded selection / exact source binding
          ▼
memory recall ──完整有界 Turn──► 当前 Codex/Claude Agent ↔ 用户
          │                                  │ 最终 CandidateDraftBatch
          └──────────────────────────────────▼
                                     memory stage（草稿）
                                              │ AdjudicationTask + pool
                                     当前 Agent ↔ 用户
                                              │ AdjudicationResult
                                     memory stage（裁决）
                                              │ retained quarantined + digests
                                              ▼
                                      review → prepare
                                              │ exact PromotionPlan
                                      用户确认│
                                              ▼
                                           promote
                                              │ CAS + recovery journal
                                              ▼
                                  .threadshare/memory/** + approved FTS

approved L1 + scenes/doctrine ──memory synthesize──► 当前 Agent
                                                    └─同一 stage/review/prepare/promote
```

## 6. 幂等与恢复

- recall/synthesize 的 task id 由 owner 与 source binding 确定；私有 artifact 只为 stage 重验提供依据。
- stage 的相同 task + response digest 重放返回同一结果；同 task 不同 document 返回 conflict。
- candidate revision 或 statement/citation digest 变化会使 prepare 失败，不能迁移旧确认。
- PromotionPlan 对 candidate/assessment/policy/target blob 做 CAS；漂移返回 stale/void，不覆盖第三方修改。
- apply 使用跨进程 owner 锁、write-ahead intent、conditional displacement、write-before-delete 和可恢复 rollback。
- no-op synthesis 保存 entry set 与 baseline；`--full` 必须能忽略成功 baseline 并重新纳入全部 approved L1。

## 7. 已接受的代价

1. 当前 Agent 会看到原始有界 transcript；提示注入、模型服务留存和 Agent 误操作风险由用户选择的宿主承担。
2. 取消第二个 Runner 后，交互更自然、少一次模型调用，但同一输入的可复现性取决于当前 Agent；最终写入仍由 exact review/plan 固定。
3. CLI 的 stage/prepare 仍以 JSON 为机器契约；这是 Agent 的参数面，不是要求用户维护 JSON 文件。
4. 已暂存候选不能原地改写；应在 stage 前完成对话修改。stage 后发现问题时，放弃该候选并从新的 recall/synthesis task 重新提交。

## 8. 验收门

1. CLI 与 MCP 分别真实跑通 `recall → stage(draft) → stage(adjudication) → review → prepare → promote`，并得到相同状态和文件结果。
2. CLI 与 MCP 分别真实跑通 `synthesize → stage → review(kind=consolidation) → prepare → promote`。
3. recall 响应确实包含完整有界 transcript；不需要 Broker、approval bundle 或 Runner。
4. source、candidate revision、statement/citation digest、target blob 任一漂移均 fail closed；空 candidate 和空 Patch 可见、可重放。
5. 真实 Codex CLI 与 Claude Code CLI 在一次用户对话中使用已构建的 Threadshare 完成上述流程；fake runner 只用于确定性故障注入，不作为 Agent-native E2E 证据。

## 9. 验收证据（2026-08-22）

- 真实 `codex-cli 0.149.0` 和 `Claude Code 2.1.222` 均在独立隔离 fixture 完成 `recall → stage(draft) → stage(adjudication) → review → prepare → promote`；两次最终均 `promote=applied`，各有 1 个 entry 进入 approved projection，`lint blocked=false`，未产生 git commit。
- 长 binding 对等回归已固定在 `test/insights-mcp.test.mjs` 与 `test/insights-query.test.mjs`：同一份超过 128 KiB、低于 4 MiB 的 `CandidateDraftBatch@v1`，CLI reader 与 MCP newline JSON-RPC 均接受并保留完整 binding；旧的 64 KiB Insights 查询上限仍保持不变。
- `npm run test:insights-engine` 通过（Rust lib 116、main 14、memory-state 44/44、Node 363/363）；`npm run test:cli` 395/395、`npm run test:release` 76/76、`npm run validate:skill` 全部通过。
