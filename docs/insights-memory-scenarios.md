# Insights + Team Memory 场景手册

这份手册按工作目标选择路径。每个场景都先问一个问题：结果只是帮助这次判断，还是要成为仓库未来可复用的团队知识？前者停在 Insights，后者才进入 Memory 的确认与晋升流程。

## 选择表

| 你想做什么 | 推荐路径 | 是否写仓库 |
|---|---|---:|
| 找出某类失败、频率或趋势 | Insights Query/Recipe | 否 |
| 追踪一个需求如何到达 Commit | Insights Delivery Trace | 否 |
| 从发布失败中提炼可复用做法 | Insights → Memory | 是（确认后） |
| 汇总多条经验成场景/守则 | Memory `synthesize` | 是（确认后） |
| 让新 Agent 读取已批准经验 | Memory `synthesize` / `assemble` | 更新投影 |
| 分享完整聊天原文 | `threadshare share` | 不进入 Memory |

## 场景一：发布失败复盘，沉淀成团队经验

### 用户请求

```text
用 Threadshare 回看最近两周这个仓库关于发布失败的聊天，整理成两条可执行的团队经验。先展示证据和候选，我确认后再写入。
```

### 推荐流程

1. Agent 确认当前 worktree，必要时先执行 `threadshare insights sync --repository .`。
2. 调用 `memory recall`，带明确时间窗和“发布失败”等主题；默认一次处理一个 chunk。
3. 逐条展示候选、原始 Turn 的 evidence id、证据强度和限制；接受用户补充。
4. 依次执行 `stage(draft) → stage(adjudication) → review`。
5. 用户确认精确 candidate 后 `prepare`，再展示文件 diff。
6. 用户确认后 `promote`，最后检查 `.threadshare/memory/**` 和需要的 provider projection。

### 结果应该是什么

结果是短、可复用、带限制条件的 entry，例如“发布前运行某项检查，并在某种失败信号出现时执行某个恢复步骤”，而不是整段聊天摘要。没有足够证据的推断应保留为待确认候选或明确写出 limitation。

## 场景二：发现反复失败的 Tool，但暂时不写记忆

### 用户请求

```text
找出最近一个月最常失败的发布相关 Tool，区分失败调用和所在 Turn 是否最终完成，并给出三个可复核案例。
```

### 推荐流程

1. 先让 Agent 读取 `threadshare insights spec --format json`。
2. 用 Usage/Recipe 排名，再用 Search → Evidence 取三个完整案例。
3. 分开报告 invocation terminal state、Turn outcome、snapshot、coverage 和 evidence revision。
4. 只有当用户确认“这是一条团队应该遵守的做法”时，才转入场景一的 Memory 流程。

### 常见误读

高失败量不等于 Tool 无效；共现也不能证明 Tool 导致 Turn 成功或失败。把“调查线索”和“已确认经验”分开，是 Insights 到 Memory 的关键门槛。

## 场景三：新成员 onboarding，读取已有团队经验

### 用户请求

```text
整理当前仓库已批准的发布和回滚经验，告诉我新成员第一次发版前应该检查什么。
```

### 推荐流程

1. Agent 调用 `memory synthesize`，只读取已批准的记忆、现有场景/守则和适用规则。
2. 把建议按“必须做 / 失败时做 / 适用限制”分组，并指出来源 entry。
3. 不需要再次读取历史 transcript；已有批准记忆就是这条路径的输入。
4. 若需要更新 provider context，由用户确认后运行 `memory assemble --provider claude|codex`，检查 diff 后再提交。

### 边界

`synthesize` 不是重新回看原始聊天，也不会自动把尚未确认的候选当成团队规则。过时或冲突的经验应重新回到 review，而不是在 Agent 提示词里静默覆盖。

## 场景四：解释一个 Commit 的交付来源

### 用户请求

```text
这个发布修复 Commit 是如何从计划走到交付的？哪些证据是 direct，哪些只是 observed 或 candidate？
```

### 推荐流程

1. `threadshare insights sync --repository .` 注册当前仓库。
2. Agent 让 `threadshare_insights_spec` 选择 Delivery Trace Recipe，或等价调用 CLI。
3. 沿 Session → Turn → 文件 → Commit 下钻，需要时读取完整 Git diff evidence。
4. 报告每条 edge 的 relation、strength、source、facts 和 limitations。

### 不要做

不要把 observed Session/Commit 关联写成 Agent 作者证明；不要把 candidate/contextual edge 当成已确认交付；不要为了“补全故事”把多个 snapshot 的计数强行拼成一个实时事实。

## 场景五：每周整理一次团队记忆

### 用户请求

```text
检查本周是否有至少 20 条新的已批准经验；如果有，生成待审的场景和守则，不要自动写入。
```

### 推荐流程

```bash
threadshare memory status --format json
threadshare memory synthesize --if-due --format json
```

如果有任务，Agent 读取返回的已批准记忆和现有场景/守则，展示拟议修改，再执行：

```bash
printf '%s\n' '<ConsolidationPatch@v1 JSON>' \
  | threadshare memory stage --request - --format json
threadshare memory review --kind consolidation --format json
printf '%s\n' '<PrepareRequest@v1 JSON>' \
  | threadshare memory prepare --request - --format json
threadshare memory promote --plan <plan-id> --format json
```

没有新内容时也会有可见的 no-op 基线。需要忽略基线、重新检查全部已批准记忆时，明确使用 `--full`；不要把空结果误认为“以后永远不需要再看”。

## 场景六：历史输入或仓库发生变化后继续工作

### 典型现象

- recall 返回的 Turn revision 已变化；
- review 后 `.threadshare/memory` 目标文件被修改；
- scene、doctrine 或 approved entry 新增/删除；
- promotion plan 报 source binding、assessment、policy 或 target blob stale。

### 正确处理

停止复用旧 candidate、task、assessment 和 plan。重新执行受影响的最小流程：

```text
source 变化       → recall / synthesize
candidate 文字变化 → stage / review
review 后文件变化  → review / prepare
plan 后目标变化    → prepare / promote
```

Fail closed 的目的就是避免“审的是 A，最后写的是 B”。不要手动改 digest 或绕过状态机。

## 场景七：从 MCP 调用

### 用户请求

```text
用本机 Threadshare 回看最近一次发布故障，先给我两条候选；我确认后再写入团队记忆。
```

### Agent 行为

1. 通过 `threadshare insights mcp --stdio` 完成 `initialize` 和 `tools/list`。
2. 用 `threadshare_insights_spec` 或 `threadshare_memory_recall` 选择有界输入。
3. 通过 `threadshare_memory_stage` 两次提交 draft/adjudication。
4. 通过 `threadshare_memory_review` 展示 evidence 和 digest。
5. 用户确认后调用 `threadshare_memory_prepare`，再次确认 exact plan，最后调用 `threadshare_memory_promote`。

CLI 和 MCP 的状态、校验、错误码和写入结果应等价；换 transport 不应跳过用户确认。批量预览和只读搜索不代表完整的确认写入流程。

## 场景模板

可以直接把下面的句式交给当前 Codex/Claude Agent：

```text
用 Threadshare Insights 在 <时间范围> 回看 <仓库/主题> 的 <问题>。
先报告 snapshot、coverage 和证据，再判断哪些结论值得进入 Team Memory。
候选先展示给我；我确认后再 stage、prepare 和 promote，不要自动 commit 或 push。
```

更短的判断式：

```text
先查证，不写入：用 Insights。
确认后沉淀：用 Memory。
只想给别人看原文：用 share。
```
