# Team Memory 使用手册

Team Memory 不是实时代理拦截器。它回看本机 Insights 中已经记录的、属于当前仓库的历史 Turn，把经过用户确认的结论写成 `.threadshare/memory/**` 下的团队记忆，再按需装配到 Agent 上下文。

## 1. 先选正确的入口

在已经打开的 Codex 或 Claude Code 对话里，推荐直接说：

```text
用 Threadshare 回看最近两周这个仓库关于发布失败的聊天，整理成团队经验。
```

当前 Agent 会调用 `memory recall`，读取有界材料，先展示候选，再和用户讨论修改。这个路径不需要 `--runner`，也不需要用户维护 `memory-filter.json`。

如果只是想调查历史，不想写入仓库，停在 Insights；如果要共享完整原始会话，使用 `threadshare share`，不要把它当作 Memory。

## 2. 准备工作

在目标仓库的非 bare worktree 中执行一次：

```bash
threadshare insights sync --repository .
threadshare memory init
threadshare memory status --format json
```

Memory 会在选材时自动叠加：

- 当前 worktree scope；
- `eligible`、`active`、`hard-sealed` Turn；
- 完整 Delivery Trace coverage；
- 明确的时间窗和用户筛选条件。

超过 200 个匹配 Turn 会直接拒绝，不会静默截取前缀。需要更小范围时，用时间、主题、provider、Tool/Skill 或结果证据过滤器缩小范围。

## 3. 从聊天整理团队记忆

这是把聊天变成原子团队记忆的标准顺序：

| 阶段 | Agent 做什么 | Threadshare 做什么 | 用户确认点 |
|---|---|---|---|
| `recall` | 提供时间窗、主题和过滤条件 | 返回完整有界 Turn chunk、证据目录和契约 | 确认回看范围 |
| 对话分析 | 阅读材料、提出候选、接受用户补充 | 不写共享文件 | 确认候选文字 |
| `stage` 第一次 | 提交 `CandidateDraftBatch@v1` | 返回当前候选池和 `AdjudicationTask` | 讨论重复关系 |
| `stage` 第二次 | 提交 `store/skip/update/merge` 裁决 | 把保留项放入 quarantine | 确认裁决结果 |
| `review` | 展示候选、statement、证据和 digest | 重新计算 assessment 与状态 | 逐条确认弱证据 |
| `prepare` | 提交精确 candidate revision/digest | 生成与当前文件一致性绑定的写入计划 | 确认最终文件 diff |
| `promote` | 提交 plan id | 写入 `.threadshare/memory/**` | 最终写入确认 |

### 3.1 CLI 等价流程

人只提供筛选参数；协议 JSON 由当前 Agent 生成并通过 stdin 传入：

```bash
threadshare memory recall \
  --since 2026-08-08T00:00:00.000Z \
  --until 2026-08-22T00:00:00.000Z \
  --query "发布失败" \
  --providers claude,codex \
  --result-evidence provider-completed \
  --format json

# Agent 展示候选并提交 CandidateDraftBatch@v1
printf '%s\n' '<CandidateDraftBatch@v1 JSON>' \
  | threadshare memory stage --request - --format json

# Agent 对照返回的池提交 AdjudicationResult@v1
printf '%s\n' '<AdjudicationResult@v1 JSON>' \
  | threadshare memory stage --request - --format json

threadshare memory review --format json

# 用户确认精确 diff 后，Agent 提交 PrepareRequest@v1
printf '%s\n' '<PrepareRequest@v1 JSON>' \
  | threadshare memory prepare --request - --format json

# 用户确认 PromotionPlan 后
threadshare memory promote --plan <plan-id> --format json
```

上面的占位符不是要求用户手写的文件。若 Agent 不在场，先运行 `threadshare memory --help` 和对应 schema；不要凭字段名称猜测 digest、candidate id 或 evidence id。

### 3.2 证据与确认规则

- 每条 statement 必须引用当前 recall source 中的 evidence id；不要按 `ev-*` 的编号顺序猜映射。
- Delivery Trace 的 `direct/observed/candidate/contextual/unknown` 是来源强度，不等于自然语言陈述已经成立。
- LLM 生成的陈述默认需要逐条人工确认；只有确定性 typed fact 或已确认 statement 才能进入晋升计划。
- 修改 statement 文字会使旧 citation assessment 和 approval 失效；不要复用旧 digest。
- `promote` 只修改绑定 worktree 的 `.threadshare/memory/**`，不自动 stage、commit 或 push。

## 4. 整理场景与守则

当已有批准的记忆后，在同一 Agent 对话中生成场景和守则：

```bash
threadshare memory synthesize --if-due --format json
```

`--if-due` 只在至少 20 条已批准记忆新增或变化时继续；需要全部重放时使用：

```bash
threadshare memory synthesize --full --format json
```

之后仍是同一条确认链：

```bash
printf '%s\n' '<ConsolidationPatch@v1 JSON>' \
  | threadshare memory stage --request - --format json
threadshare memory review --kind consolidation --format json
printf '%s\n' '<PrepareRequest@v1 JSON>' \
  | threadshare memory prepare --request - --format json
threadshare memory promote --plan <plan-id> --format json
```

空 Patch 也会被记录为可见的 no-op 基线；需要重新检查全部已批准记忆时使用 `--full`，不要把上次空结果当成永久跳过。

晋升后，如需让 provider 上下文反映仓库记忆，显式装配并检查 diff：

```bash
threadshare memory assemble --provider claude
threadshare memory assemble --provider codex
git diff -- .threadshare/memory AGENTS.md
```

`.threadshare/memory/**` 是团队记忆的 Git 真相源；provider 文件是可重新生成的 adapter 投影。提交和推送由用户按正常 Git/PR 流程完成。

## 5. CLI 与 MCP 对等

CLI 和 MCP 提供同一组交互操作：

| CLI | MCP |
|---|---|
| `memory status` | `threadshare_memory_status` |
| `memory recall` | `threadshare_memory_recall` |
| `memory synthesize` | `threadshare_memory_synthesize` |
| `memory stage` | `threadshare_memory_stage` |
| `memory review` | `threadshare_memory_review` |
| `memory prepare` | `threadshare_memory_prepare` |
| `memory promote` | `threadshare_memory_promote` |

MCP 通过本机 Insights stdio server 暴露：

```bash
threadshare insights mcp --stdio
```

同一 request 在 CLI 和 MCP 上必须得到等价的状态、确认结果和错误语义。批量处理和只读搜索是另外的入口，不会替代候选确认和最终写入。

## 6. `--runner` 什么时候才需要

`--runner` 只用于独立 batch：

```bash
threadshare memory extract --runner claude \
  --since <utc> --until <utc> --query "发布失败"

threadshare memory consolidate --runner codex \
  --runner-model <model> --runner-endpoint <https-url>
```

每次批量预览、提取和裁决都有独立的确认步骤；具体参数和批准方式以 `threadshare memory --help` 为准。

在当前 Codex/Claude 对话里，优先 `recall/synthesize`，不要让 Agent 再启动一个同类 runner，避免重复读取、重复确认和上下文断裂。

## 7. 排障清单

| 现象 | 处理 |
|---|---|
| 没有可回看的 Turn | 先确认 `insights sync --repository .` 已完成，再缩小或调整时间窗 |
| 超过 200 Turn | 增加主题、provider、结果证据或 capability 过滤；系统不会截前缀 |
| source/binding stale | 重新 `recall` 或 `synthesize`，不要复用旧 task/digest |
| review 后文件变化 | 重新 `review → prepare`，让新的 target blob 进入计划 |
| `promote` 被拒 | 先看 `memory review` 的 candidate/assessment/policy/owner 诊断；不要手改 plan |
| 需要继续装配 | 先确认 `.threadshare/memory/**` 的 diff，再运行对应 provider 的 `assemble` |

## 8. 延伸阅读

- [Insights + Memory 场景手册](./insights-memory-scenarios.md)
- [开发者文档索引](./README.md)
