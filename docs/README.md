# Threadshare 使用文档

Threadshare 面向 Agent 使用。通常不需要先学习 `share`、`insights`、`memory` 的命令和协议；
在 Codex 或 Claude Code 对话中直接描述目标，让 Agent 选择 MCP 或 CLI 完成工作。

## 先对 Agent 说

| 你的目标 | 可以直接这样说 | 使用手册 |
|---|---|---|
| 分享当前聊天 | “用 Threadshare 把当前聊天分享出来。先预检，再把只读链接给我。” | [分享使用手册](./sharing-usage-guide.md) |
| 只分享其中一段 | “从我们开始讨论发布失败的那条消息起分享；先列出候选起点让我选。” | [分享使用手册](./sharing-usage-guide.md) |
| 调查历史工作 | “用 Threadshare 分析最近一个月反复出现的发布失败，给出可复核证据。” | [Insights 使用手册](./insights-usage-guide.md) |
| 沉淀团队经验 | “回看最近两周这个仓库的发布失败，整理成团队经验；确认后再写入。” | [Team Memory 使用手册](./team-memory-usage-guide.md) |
| 生成可复用 Skill | “把已经确认的发布经验整理成 release-checks Skill，先展示候选和限制。” | [Team Memory 使用手册](./team-memory-usage-guide.md) |
| 不确定该用哪个能力 | “先判断应该用 share、Insights 还是 Memory，再继续。” | [场景手册](./insights-memory-scenarios.md) |

Agent 应自行发现 Threadshare 能力、解析当前会话或仓库、选择有界参数，并在发布内容或写入
`.threadshare/memory/**` 前展示需要用户确认的结果。用户不需要准备 JSON 请求文件，也不需要选择
Recipe、schema、opaque id 或 `--runner`。

第一次使用时，先按 [README 的 Agent 接入步骤](../README.zh-CN.md#一次性接入-agent)安装 CLI；
Codex 用户再安装配套 Skill，支持 MCP 的客户端还可以连接本机 Threadshare server。完成一次接入后，
日常工作只需继续使用上面的自然语言请求。

## Agent 如何执行

Agent 可以使用两种等价入口：

- 已配置 Threadshare MCP 时，直接调用工具；
- 没有 MCP 时，在当前终端调用 `threadshare` CLI。

Insights 与 Team Memory 的稳定操作在 MCP 和 CLI 上使用相同的校验、状态与确认语义。分享流程目前由
Agent 调用 CLI。选择哪条执行通道是 Agent 的工作，不应变成用户需要回答的问题。

## 按结果选择

| 结果 | Threadshare 能力 | 是否离开本机 | 是否写仓库 |
|---|---|---:|---:|
| 一个只读会话链接 | Share | 是，上传选中的可见会话 | 否 |
| 一次有证据的历史分析 | Insights | 否 | 否 |
| 经确认的原子团队经验 | Team Memory entry | 否 | 是 |
| 场景、守则或 Agent Skill | Team Memory synthesis/Skill | 否 | 是 |

## CLI 与开发者参考

手册末尾提供 CLI 等价流程，供人在终端操作、编写自动化或排障。完整参数、默认值和稳定诊断始终以
`threadshare <command> --help` 为准，不从手册复制整份参数表。

实现细节、协议字段和验收记录属于开发者文档：

- [Team Memory 提案](./team-memory-proposal.md)
- [Team Memory Phase 1 设计](./team-memory-phase1-design.md)
- [Team Memory Phase 2 设计](./team-memory-phase2-design.md)
- [Skill 提取与装配设计](./team-memory-skill-design.md)
- [Session Source Adapter 扩展设计](./session-source-adapter-design.md)
- [Conversation Hierarchy 与本机 Dashboard 设计](./conversation-hierarchy-dashboard-design.md)
- [Deep Query 设计](./insights-deep-query-design.md)
- [Delivery Trace 设计](./insights-delivery-trace-design.md)
