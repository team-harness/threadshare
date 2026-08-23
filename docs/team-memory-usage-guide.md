# Team Memory 使用手册

Team Memory 让当前 Codex 或 Claude Agent 事后回看本机历史，把用户确认过的经验写进仓库。正常使用时，
用户只描述想回看的范围和期望结果；Agent 负责调用 Threadshare、分析材料、生成协议对象，并在每个写入点
回到对话中确认。

## 1. 直接对 Agent 说

从历史聊天提炼原子经验：

```text
用 Threadshare 回看最近两周这个仓库关于发布失败的聊天，整理成两条团队经验。
先给我候选、证据和限制，我确认后再写入。
```

整理已经批准的经验：

```text
用 Threadshare 把当前仓库已批准的发布经验整理成场景和守则。
先展示会修改什么，不要自动写入、commit 或 push。
```

生成 Agent Skill：

```text
用 Threadshare 回看最近两周的发布失败，并优先参考已有团队记忆，
整理成 release-checks Skill。先展示步骤、证据和适用限制，确认后再装配给 Codex。
```

查询已有团队经验：

```text
用 Threadshare 查找当前仓库已经批准的发布和回滚经验，告诉我这次发版前应该检查什么。
```

用户不需要准备 `memory-filter.json`、Candidate JSON、digest 或 plan id。在现有 Agent 对话里也不需要
指定 `--runner`。

## 2. 你和 Agent 会怎样协作

| 对话阶段 | Agent 展示什么 | 用户决定什么 | 是否写仓库 |
|---|---|---|---:|
| 确定范围 | 时间、主题、provider 等筛选 | 回看范围是否正确 | 否 |
| 阅读与提炼 | 候选文字、原始证据、confidence、limitations | 修改、补充或删除候选 | 否 |
| 去重裁决 | 与已有记忆/候选的比较 | `store`、`skip`、`update` 或 `merge` | 否 |
| Statement review | 最终 statement 与证据绑定 | 逐条确认事实表述 | 否 |
| 文件计划 | 将写入的路径、diff 和 lint 结果 | 是否执行这个精确计划 | 否 |
| Promote | 实际写入结果 | 后续是否 commit/push | 是 |

用户可以在任一阶段修改措辞或补充限制。文字变化会使旧确认失效，Agent 应让 Threadshare 重新生成后续
绑定，不能沿用旧 digest。`promote` 只修改 `.threadshare/memory/**` 和本机 approved projection，
不会自动 `git add`、commit 或 push。

## 3. Agent 在背后做什么

### 3.1 回看历史

Agent 把自然语言要求转换为明确的时间窗和过滤条件，然后调用 `memory recall` 或等价 MCP 工具。
Threadshare 还会强制叠加当前 worktree、`eligible`、`active`、`hard-sealed` 和完整 Delivery Trace
coverage。超过 200 个匹配 Turn 会拒绝，不会静默截取前缀。

Recall 默认一次返回一个完整 chunk。Agent 逐个读取，并使用 `chunk.turnEvidence` 与对应的
`<<past-turn ... evidence-id="...">>` 标记绑定证据；不能根据 `ev-*` 的编号顺序猜来源。

### 3.2 提交和去重

Agent 先把讨论后的候选交给 Threadshare。Threadshare 返回当前 approved/candidate pool，Agent 再和用户
确认哪些候选应保留、跳过、更新或合并。只有第二次精确裁决才会把保留项放入 quarantine；没有候选时
会记录显式 no-op，而不是假装处理成功。

### 3.3 Review、Prepare、Promote

Threadshare 在 review 时重新计算 statement、citation、policy 和 source binding。用户确认精确 statement
后，Agent 才 prepare 文件计划；用户再确认计划，Agent 才 promote。仓库或历史输入变化会让旧计划
stale，流程会 fail closed，避免“审的是 A，写的是 B”。

Agent 可以通过 MCP 或 CLI 完成相同步骤。MCP 更适合已经配置工具的对话；CLI 是始终可用的本机等价
入口。执行通道不改变确认点。

## 4. 第一次使用

在目标仓库中需要一次本机初始化。Agent 可以自行检查状态，并在缺失时执行：

```bash
threadshare insights sync --repository .
threadshare memory init
threadshare memory status --format json
```

`insights sync` 建立或增量刷新本机历史索引，`memory init` 创建仓库内的 Team Memory 骨架。历史聊天
不会因为初始化而上传。

## 5. 三种输出

### 5.1 Entry：一条原子经验

Entry 适合短、可复用、带适用条件的事实或做法，例如“发布前运行某项检查；出现某信号时采用某恢复
步骤”。它不是整段聊天摘要。弱证据或推断必须逐条确认并保留 limitation。

### 5.2 Scene 与 Doctrine：整理多条已批准经验

用户可以直接要求 Agent“整理已有记忆”。Agent 使用 `synthesize` 读取 approved entries 与当前
scene/doctrine，提出增删改计划，再走相同 review/prepare/promote 确认链。

`--if-due` 只在至少 20 条已批准 Entry 新增或变化时继续；`--full` 用于忽略成功基线、重新检查全部
approved entries。空 Patch 会成为可见 no-op 基线，但不会阻止以后显式 full replay。

### 5.3 Skill：一套可执行步骤

当结果是一套以后可以重复执行的流程时，Agent 提议 `SkillCandidate`。分析顺序是：

1. 比较相关的现有 Skill；
2. 阅读 Scene、Doctrine 和 approved Entry；
3. 回到本次 recall 的历史 Turn 做原始取证。

已有 Memory 不能替代原始证据，每条 statement 仍需引用本次 recall source 的 evidence id。上下文被截断
时，Agent 应缩小查询后重新 recall，不能假定未返回内容不存在。

Skill 晋升后，`.threadshare/memory/skills/**` 是 Git 真相源。Agent 只有在用户指定 provider 后才运行
assemble，将其投影到 `.codex/skills/` 或 `.claude/skills/`；发现投影被手改时必须报冲突，不能覆盖。

## 6. CLI 等价流程

下面的命令主要用于自动化、调试或没有 MCP 的 Agent。完整参数以帮助为准：

```bash
threadshare memory --help
```

### 6.1 Entry 回看与晋升

人只提供筛选参数；stdin 中的协议 JSON 由 Agent 生成：

```bash
threadshare memory recall \
  --since <start-utc> \
  --until <end-utc> \
  --query "发布失败" \
  --providers claude,codex \
  --format json

printf '%s\n' '<CandidateDraftBatch JSON>' \
  | threadshare memory stage --request - --format json
printf '%s\n' '<AdjudicationResult JSON>' \
  | threadshare memory stage --request - --format json

threadshare memory review --format json
printf '%s\n' '<PrepareRequest JSON>' \
  | threadshare memory prepare --request - --format json
threadshare memory promote --plan <plan-id> --format json
```

这些占位符不是要求用户手写或维护的文件。Agent 从 Threadshare 返回值构造 exact request。

### 6.2 Scene、Doctrine 与 Skill

```bash
threadshare memory synthesize --if-due --format json
threadshare memory review --kind consolidation --format json

threadshare memory review --kind skill --format json
threadshare memory lint .threadshare/memory/skills/<name>/SKILL.md
threadshare memory assemble --provider codex
threadshare memory assemble --provider claude
```

`stage`、`prepare` 和 `promote` 与 Entry 使用同一生命周期；Agent 根据返回 guidance 选择 candidate kind，
用户不需要记住协议名称。

## 7. Agent 执行入口

本机 MCP server 通过以下命令提供 stdio transport：

```bash
threadshare insights mcp --stdio
```

Agent 可以使用 `threadshare_memory_search` 查询已批准 Memory；交互式 Team Memory 的稳定写入生命周期使用
`threadshare_memory_recall`、`threadshare_memory_synthesize`、`threadshare_memory_stage`、
`threadshare_memory_review`、`threadshare_memory_prepare`、`threadshare_memory_promote` 和
`threadshare_memory_assemble`。

稳定生命周期同时提供 MCP 和 CLI 入口，并保持等价的 source checks、状态、确认结果和错误语义。切换
transport 不能跳过 review 或最终写入确认。只读查询的具体入口由 Agent 选择，用户仍只描述想找的经验。

## 8. `--runner` 只用于独立批处理

当前 Codex/Claude 对话应由当前 Agent 直接分析 recall/synthesize 返回的材料。只有用户明确要求脱离当前
对话运行独立 batch 时，才使用：

```bash
threadshare memory extract --runner claude \
  --since <utc> --until <utc> --query "发布失败"

threadshare memory consolidate --runner codex \
  --runner-model <model> --runner-endpoint <https-url>
```

`claude` 会启动本机 Claude Code CLI，`codex` 会启动本机 Codex CLI。Batch 的每次 delivery 都有独立
审批；在已有 Agent 对话里再启动同类 runner 会造成重复读取、重复确认和上下文断裂。

## 9. 排障

| 现象 | 处理 |
|---|---|
| 没有可回看的 Turn | 确认 `insights sync --repository .` 已完成，再调整时间窗或主题 |
| 超过 200 Turn | 增加主题、provider、结果证据或 capability 过滤；系统不会截前缀 |
| context 被截断 | 缩小 query 后重新 recall，不能把未返回项当成不存在 |
| source/binding stale | 重新 recall 或 synthesize，不复用旧 task/digest |
| 修改了候选文字 | 重新 stage/review，让新 statement 获得新绑定 |
| review 后文件变化 | 重新 review/prepare，让当前 target blob 进入计划 |
| promote 被拒 | 按 review 的 candidate/assessment/policy/owner 诊断处理，不手改 plan |
| assemble 冲突 | 先检查 provider 投影的本地修改，不静默覆盖 |

## 10. 延伸阅读

- [Insights + Team Memory 场景手册](./insights-memory-scenarios.md)
- [Skill 提取与装配设计](./team-memory-skill-design.md)
- [开发者文档索引](./README.md)
