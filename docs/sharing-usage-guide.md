# 分享使用手册

Threadshare 可以把 Codex、Claude Code 或 Paseo 中的可见会话发布成只读 Viewer 链接。推荐在当前
Agent 对话里直接提出分享目标，由 Agent 识别会话、预检范围并返回链接；只有自动化或排障时才需要
手动运行 CLI。

## 1. 直接对 Agent 说

分享完整当前会话：

```text
用 Threadshare 把当前聊天分享出来。先预检，确认有效后发布，把只读链接给我。
```

只分享其中一段：

```text
用 Threadshare 分享当前聊天，但从我们开始讨论发布失败的那条用户消息起算。
先列出候选起点让我选，不要把这次分享请求放进链接。
```

设置生命周期：

```text
把当前聊天分享 7 天，并为我保留可撤销能力。链接和一次性撤销命令分别给我。
```

读取别人给出的链接：

```text
用 Threadshare 读取这个链接，概括关键决定和未完成项：<viewer-url>
```

用户不需要先找 session id、判断当前是 Codex 还是 Claude、选择 `--from`/`--before`，也不需要把
会话导出成文件。Agent 应通过当前上下文和 Threadshare 的会话发现能力完成这些步骤。

## 2. Agent 会怎样工作

### 2.1 完整分享

1. 解析当前会话；如果存在多个合理候选，只展示编号、时间、仓库和脱敏预览让用户选择。
2. 用与正式发布完全相同的范围执行 dry run，检查协议、条目数和 5 MiB 上限。
3. dry run 有效后发布，并核验返回的 share id、Viewer URL 和可选生命周期字段。
4. 返回链接；例行核验不在终端回显完整 transcript。

### 2.2 从某条消息开始分享

Agent 会读取当前分享请求之前的用户消息候选，只把编号和短预览展示给用户。用户选定后，Agent 使用
原始 boundary 排除分享请求、翻页和选择过程本身，再发布从所选用户 Turn 开始的内容。

如果当前请求尚未写入 provider session，Agent 可以重试一次；仍无法确认安全 boundary 时应停止，
不能退化成分享完整会话，也不能依靠模糊文本猜起点。

### 2.3 生命周期

默认链接永久有效且不可撤销。只有用户明确要求时，Agent 才增加到期时间或一次性撤销 capability。
撤销 token 只在创建时出现，不能找回，也不能放进 Viewer URL、日志或共享内容。

## 3. 分享边界

- Viewer URL 不公开列出，但任何拿到链接的人都能读取内容；它不是访问控制系统。
- 导出器会跳过隐藏、metadata、sidechain 和已知编排记录，并对常见凭证字段做 best-effort 脱敏。
- 可见消息和 Tool 输入输出仍可能包含无法自动识别的敏感信息；发布前要审查范围。
- `share` 会上传选中的可见会话；Insights 和 Memory 默认留在本机，三者不要混用。
- 普通 Agent transcript 会省略 Tool payload 和内部事件正文；需要完整字段时才读取 JSON。

## 4. CLI 等价流程

下面的命令供人直接操作或编写自动化。先用帮助确认当前版本参数：

```bash
threadshare share --help
threadshare messages --help
threadshare read --help
```

### 4.1 已知会话时分享

```bash
threadshare share codex <session-id-or-jsonl-file> --dry-run --report --json
threadshare share codex <session-id-or-jsonl-file> --json

threadshare share claude <session-id-or-jsonl-file> --json
threadshare share paseo <agent-id-or-prefix> --json
```

不知道原生 session id 时：

```bash
threadshare sessions codex --format json
threadshare sessions claude --format json
```

### 4.2 选择起点

人在交互式终端可以使用：

```bash
threadshare share paseo <agent-id-or-prefix> --pick-start
```

Agent 使用非交互流程，保留最初返回的 boundary：

```bash
threadshare messages paseo <agent-id-or-prefix> --format json
threadshare messages paseo <agent-id-or-prefix> \
  --before <original-boundary-id> --offset <next-offset> --format json
threadshare share paseo <agent-id-or-prefix> \
  --from <selected-message-id> --before <original-boundary-id> --json
```

### 4.3 到期、撤销和读取

```bash
threadshare share codex <session-id> --expires 7d --json
threadshare share codex <session-id> --revoke --json
threadshare revoke '<viewer-url>' --token <revoke-token> --json

threadshare read '<viewer-url>'
threadshare read '<viewer-url>' --format json
threadshare read '<viewer-url>' --format markdown
```

`read` 默认返回适合 Agent 审阅的紧凑表示。使用 `--format json` 读取完整结构化字段，或使用
`--format markdown` 读取完整可读 transcript。不要抓取 Viewer HTML。

## 5. 常见问题

| 现象 | 处理 |
|---|---|
| Agent 找到多个会话 | 让它展示编号、更新时间、仓库和脱敏首条请求，不要默认最新一个 |
| dry run 无效或超限 | 缩小分享范围；失败后不能去掉 range 参数重试成完整分享 |
| 当前分享请求出现在候选中 | 保留它作为 exclusive boundary，再从更早的用户消息中选起点 |
| 发布结果不确定 | 保留诊断中的 Result URL，不要自动重试 `TS_PUBLISH_OUTCOME_UNKNOWN` |
| 生命周期未确认 | 保留已创建链接，按诊断处理；不要假装到期或撤销已经生效 |
| 需要自托管服务 | 明确传入 `--url` 或 `THREADSHARE_URL`；默认使用托管服务 |
