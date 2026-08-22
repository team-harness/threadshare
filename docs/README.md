# Threadshare 使用文档

这里是面向实际工作的使用入口。实现细节、协议字段和验收记录仍以各自的设计文档为准；本目录的手册只回答三个问题：什么时候用、先做什么、结果如何继续使用。

## 快速选择

| 目标 | 先读 | 核心入口 |
|---|---|---|
| 从历史 Agent 工作中找规律、失败链或交付证据 | [Insights 使用手册](./insights-usage-guide.md) | `threadshare insights` |
| 把历史聊天提炼成仓库团队记忆 | [Team Memory 使用手册](./team-memory-usage-guide.md) | `threadshare memory recall` |
| 按具体工作场景照着做 | [Insights + Memory 场景手册](./insights-memory-scenarios.md) | 自然语言请求或 CLI |
| 需要深入了解协议和安全边界 | [Team Memory 提案](./team-memory-proposal.md)、[实现设计文档](./team-memory-phase1-design.md) | 开发者参考 |

## 先记住三条边界

1. **Insights 是本机历史查询。** `sync`/`reindex` 才会更新索引；查询不会隐式扫描原始 provider 文件，也不会上传内容。
2. **Memory 是事后回看后的审阅写入。** 在现有 Codex/Claude 对话中，Agent 使用 `recall` 或 `synthesize`，和用户讨论后再 `stage → review → prepare → promote`。
3. **完整聊天分享是另一件事。** 需要发布会话时使用 `threadshare share`；不要把 Deep Query 的原始输出直接传给远端服务。

## 参数参考

手册中的命令只展示常用工作流。完整参数、默认值和稳定诊断以 `threadshare <command> --help` 为准；在当前 Codex 或 Claude 对话中，直接描述目标即可让 Agent 选择合适的入口。
