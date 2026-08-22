# Insights 使用手册

Insights 是 Threadshare 的本机历史分析层。它把已经记录的 Codex/Claude 会话投影成可查询的 snapshot、Turn、Tool/Skill 使用、失败链、文件活动、Token 和 Delivery Trace 证据。它适合回答“发生过什么、频率如何、证据在哪里”，不直接替代人的判断。

## 1. 先判断是否应该用 Insights

| 需求 | 工具 |
|---|---|
| 只分析一个 Session 的 Turn、Tool、retry 或 rollback | `threadshare analyze` |
| 跨 Session 找规律、失败链、用量或交付关系 | `threadshare insights` |
| 把可复用结论写进仓库供团队使用 | `threadshare memory` |
| 给别人一个可读的完整会话链接 | `threadshare share` |

Insights 查询可能返回 analysis、Tool payload、错误和本地路径。把它当作本机敏感数据；除非用户明确要求，不要 share、publish 或发送给远程 MCP/模型服务。

## 2. 五分钟初始化

在仓库目录中执行：

```bash
# 查看是否已有本机索引
threadshare insights status --format json

# 第一次使用或希望纳入最新本地 Session 时同步
threadshare insights sync

# 需要仓库交付关系时注册当前仓库
threadshare insights sync --repository .
```

`sync` 第一次会建立索引，之后是增量更新。它不会上传会话内容。只有明确需要完整原子重建，或正在处理 origin secret 恢复时，才使用 `reindex`；不要把 `reindex` 当成普通刷新按钮。

要把仓库自己的 Markdown checklist 作为可选 Intent 证据，显式指定仓库相对路径：

```bash
threadshare insights sync --repository . --intent docs/plan.md
threadshare insights sync --repository . --clear-intent
```

Threadshare 不会自动扫描仓库寻找 checklist，也不要求任何外部需求管理系统。

## 3. 让 Agent 选择查询

最推荐的方式是直接描述问题：

```text
请用 Threadshare Insights 分析最近 13 个完整周里反复失败的 Tool 尝试，区分调用终态和所在 Turn 的结果，并给出可以验证的证据。
```

兼容的 Agent 会先读取：

```bash
threadshare insights spec --format json
```

然后按问题选择有界的 Query 或 Recipe。用户不需要记住 resource、Recipe 名称、内部 schema 或 opaque key。Agent 的回答应包含 snapshot、时间窗口、coverage、是否截断，以及它实际使用的 evidence。

## 4. 手动验证一个结论

手动调试或编写脚本时，保持“先找候选、再取证据”的顺序：

```bash
# 候选搜索：输出为一行 JSON
threadshare insights search --query "timeout" --format json

# 使用 Search 返回的精确 turn key 与 revision 获取证据
threadshare insights evidence <turn-key> \
  --revision <revision> \
  --format json
```

如果使用 Query、Recipe 或 Evidence 请求文件，先读对应帮助和已发布 schema：

```bash
threadshare insights query --help
threadshare insights recipe --help
threadshare insights evidence --help
```

不要猜 `ev-*` 标识符的顺序，也不要复用旧 revision。出现 stale cursor 或 revision 错误时，重新 Search/Recipe，再从新结果继续。

## 5. 常见问题的选择方式

### 5.1 用量和工作方式

把“最近一段时间最常用的 Skill/Tool”交给 Agent。它应区分：

- recorded invocation count（记录到的调用次数）；
- distinct Turn、Session 和 dedupe group；
- Tool/Skill invocation 的 terminal state；
- 包含该调用的 Turn 最终结果。

调用终态和 Turn 结果是两个不同维度。共现不能证明某个 Tool 或 Skill 导致了成功、失败或效率变化。

### 5.2 失败链和历史解法

示例请求：

```text
找出最近一个月反复出现的发布超时，追踪每条尝试链是否后来成功，并只引用能取得完整 evidence 的案例。
```

Agent 通常会使用 Recipe 或 Search → Evidence。回答中应把 `never-succeeded`、`recovered` 等链状态与所在 Turn 的结果分开说明，不能因为 Tool 总体可靠就断言某一次失败已经恢复。

### 5.3 Delivery Trace

先注册仓库，再提问：

```bash
threadshare insights sync --repository .
```

```text
这个发布修复是如何从计划走到 Commit 的？哪些 Session、文件和 Git 证据是 direct，哪些只是 observed 或 candidate？
```

Delivery Trace 使用 Git 和 Agent 证据。完整 hash 可以形成 direct evidence；短 hash 只有在注册仓库内唯一解析时才是 observed。candidate/contextual edge 只能作为调查线索，不能写成已确认交付关系，也不能凭相关性推断作者身份。

### 5.4 深度查询

Deep Query 适合需要完整消息、Tool 输入输出、错误或文件路径的本机调查。它的返回更敏感、更大，也更容易包含不应离开本机的内容。先用聚合 Query/Recipe 缩小范围，再按需读取 Evidence；不要一开始就把完整原始事件交给另一个网络服务。

## 6. MCP 使用

本机 MCP server 只走 stdio，不监听网络端口：

```bash
threadshare insights mcp --stdio
```

MCP 客户端按 `initialize → tools/list → tools/call` 使用已发布 schema。Insights 工具包括：

- `threadshare_insights_spec`
- `threadshare_insights_query`
- `threadshare_insights_recipe`
- `threadshare_insights_evidence`

Memory 的稳定 MCP 工具见 [Team Memory 使用手册](./team-memory-usage-guide.md)。参数和错误码以 CLI `--help`、MCP `tools/list` 和仓库 schema 为准；手册中的示例只展示工作流，不复制完整参数表。

## 7. Snapshot、coverage 与分页

- 查询针对已提交 snapshot，不是实时 provider 文件。
- `coverage` 必须随结论报告；未知或不完整 coverage 不能被写成全量事实。
- 有 cursor 的查询必须原样带回 opaque cursor；不要自行构造 offset 或排序键。
- 证据读取必须使用 Search/Recipe 返回的精确 revision。
- 索引没有自动更新时，先确认是否需要用户授权后运行 `sync`。

## 8. 维护和排障

| 现象 | 处理 |
|---|---|
| `status` 显示没有索引 | 运行 `threadshare insights sync`，再重试查询 |
| 结果过旧 | 先确认用户允许刷新，再运行增量 `sync`；不要直接 `reindex` |
| coverage 不完整 | 缩小问题范围或修复本地索引覆盖；不能用 `allowDegraded` 把未知当完整 |
| evidence revision stale | 重新执行 Search/Recipe，使用新返回的 revision |
| origin secret/身份需要重建 | 明确执行 `reindex --regenerate-secret`，按 CLI 的交互确认完成；这会改变 keyed identity |
| 结果含敏感内容 | 留在本机；不要复制到 share、Issue、远程 MCP 或不受控模型上下文 |

## 9. 相关设计与实例

- [真实 Insights 分析报告](./insights-analysis-example.md)
- [Delivery Trace 参考报告](./insights-delivery-trace-example.md)
- [Deep Query 设计](./insights-deep-query-design.md)
- [Delivery Trace 设计](./insights-delivery-trace-design.md)
- [Insights + Memory 场景手册](./insights-memory-scenarios.md)
