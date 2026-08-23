# Insights 使用手册

Insights 是 Threadshare 的本机历史分析层。它让当前 Codex 或 Claude Agent 查询已经记录的工作，回答
“发生过什么、频率如何、以前怎样解决、证据在哪里”。推荐直接描述问题；用户不需要选择 Query、
Recipe、resource、schema 或 opaque key。

## 1. 直接对 Agent 说

找历史失败和解法：

```text
用 Threadshare 分析最近一个月这个仓库反复出现的发布失败。
区分 Tool 调用失败和所在 Turn 的最终结果，并给出三个可复核案例。
```

分析工作方式：

```text
用 Threadshare 看最近 13 个完整周里哪些 Skill 和 Tool 用得最多，分别报告调用次数、
覆盖的 Turn/Session 和证据限制，不要把共现写成因果关系。
```

追踪交付：

```text
用 Threadshare 解释这个 Commit 是怎样从计划走到交付的。
把 direct、observed、candidate 证据分开，并指出还缺什么。
```

准备继续工作：

```text
用 Threadshare 回顾这个仓库最近的实现和评审，整理已完成事项、未解决风险和继续工作的上下文。
```

如果用户只想分析一个明确 Session，可以说“只分析当前会话”；跨 Session 找规律、失败链或交付关系时，
Agent 才使用 Insights。

## 2. Agent 会怎样工作

1. 先检查本机索引状态和当前仓库是否已注册；需要刷新时说明原因，再执行增量 `sync`。
2. 读取 Threadshare 的 Agent spec，把自然语言问题映射成有界 Query/Recipe；不要求用户选择内部协议。
3. 先用聚合或搜索缩小范围，再读取支持结论所需的 revision-bound Evidence。
4. 在回答中报告 snapshot、时间窗、coverage、truncation、证据强度和限制。
5. 结果默认只用于当前判断；只有用户决定沉淀时，才进入 Team Memory 的确认写入流程。

Agent 可以通过本机 MCP 工具或 CLI 执行上述步骤。两种入口共享同一 schema 和查询语义，用户通常不需要
关心 Agent 选择了哪一种。

## 3. 先判断是否应该用 Insights

| 目标 | 推荐能力 |
|---|---|
| 分析一个 Session 的 Turn、Tool、retry 或 rollback | `analyze` |
| 跨 Session 找规律、失败链、用量或交付关系 | Insights |
| 把确认后的结论写进仓库供团队复用 | Team Memory |
| 给别人一个可读的完整会话链接 | Share |

Insights Deep Query 可能返回 analysis、Tool payload、错误和本地路径。把这些结果当作本机敏感数据；
除非用户明确要求，不要将它们 share、publish 或发送到远程服务。

## 4. 第一次使用与刷新

Agent 发现没有索引时，应说明会在本机构建索引，然后运行：

```bash
threadshare insights status --format json
threadshare insights sync
```

需要分析当前仓库的 Commit、文件和 Agent Session 关系时，注册仓库：

```bash
threadshare insights sync --repository .
```

`sync` 第一次建立索引，之后只处理变化的 Session，不上传会话。查询不会隐式扫描 provider 文件。
只有完整原子重建或 origin secret 恢复时才使用 `reindex`，不要把它当作普通刷新。

仓库自己的 Markdown checklist 只是可选 Intent 证据，必须显式注册：

```bash
threadshare insights sync --repository . --intent docs/plan.md
threadshare insights sync --repository . --clear-intent
```

Threadshare 不会自动寻找 checklist，也不依赖外部需求系统。

## 5. Agent 回答的质量要求

### 5.1 用量与趋势

Agent 应区分 recorded invocation count、distinct Turn、Session 和 dedupe group。Tool/Skill 的调用终态与
包含它的 Turn 结果是不同维度；共现不能证明某个工具导致成功、失败或效率变化。

### 5.2 失败链与历史解法

`never-succeeded`、`recovered` 等是具体 attempt chain 的状态。不能因为某个 Tool 总体可靠，就断言某次
失败已恢复。历史上的后续成功是一条候选做法，不保证当前问题也会被修复。

### 5.3 Delivery Trace

完整 Commit hash 可以形成 direct evidence；短 hash 只有在注册仓库内唯一解析时才是 observed。
candidate/contextual edge 只能作为调查线索，不能写成已确认交付或作者证明。读取 Git diff 时必须保持
commit、parent、revision、digest 和分页一致，所有页面齐全后才能称为完整 diff。

### 5.4 Coverage 与分页

- 查询针对已提交 snapshot，不是实时 provider 文件。
- coverage 未知或不完整时，不能把结果描述成全量事实。
- opaque cursor 必须原样带回，不能自行构造 offset 或排序键。
- Evidence 必须使用 Search/Recipe 返回的精确 revision；stale 后重新查询。

## 6. CLI 等价流程

下面的命令用于手动验证、脚本或排障。完整参数以帮助为准：

```bash
threadshare insights --help
threadshare insights spec --format json
```

手动验证一条结论时，保持“先找候选，再读证据”：

```bash
threadshare insights search --query "timeout" --format json
threadshare insights evidence <turn-key> \
  --revision <revision> \
  --format json
```

需要自定义 records、aggregate 或 versioned Recipe 时：

```bash
threadshare insights query --help
threadshare insights recipe --help
threadshare insights evidence --help
```

不要猜 schema 字段或 `ev-*` 顺序，也不要复用旧 revision。优先使用 reference payload 缩小范围，再读取
少量完整 Evidence。

## 7. MCP 入口

本机 MCP server 只走 stdio，不监听网络端口：

```bash
threadshare insights mcp --stdio
```

Agent 通过 `threadshare_insights_spec`、`threadshare_insights_query`、
`threadshare_insights_recipe` 和 `threadshare_insights_evidence` 完成相同工作。参数和错误以 MCP
`tools/list`、CLI `--help` 与已发布 schema 为准。

## 8. 排障

| 现象 | 处理 |
|---|---|
| 没有本机索引 | 明确运行增量 `threadshare insights sync` 后重试 |
| 结果过旧 | 先确认需要刷新，再运行 `sync`；不要直接 `reindex` |
| coverage 不完整 | 缩小问题或修复索引覆盖，不能把 degraded 结果当完整 |
| Evidence revision stale | 重新 Search/Recipe，使用新 revision |
| origin secret 需要恢复 | 明确执行 `reindex --regenerate-secret` 并接受 keyed identity 变化 |
| 结果含敏感内容 | 留在本机，不复制到 share、Issue 或不受控模型上下文 |

## 9. 延伸阅读

- [Insights + Team Memory 场景手册](./insights-memory-scenarios.md)
- [真实 Insights 分析报告](./insights-analysis-example.md)
- [Delivery Trace 参考报告](./insights-delivery-trace-example.md)
- [Deep Query 设计](./insights-deep-query-design.md)
- [Delivery Trace 设计](./insights-delivery-trace-design.md)
