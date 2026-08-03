# 更新日志

本文件记录 Threadshare 面向用户的重要变化。最上方的“线上版本”记录已经部署到官方托管服务、
但尚未重新生成 npm 版本号和 Git tag 的变化。

## [线上版本] - 2026-08-03

### 新增

- Viewer 的 Turns 目录会随正文滚动自动高亮当前用户轮次，并保持当前项在目录中可见。

### 修复

- “AI agent review” 复制链接现在包含 `format=agent`，Agent 打开链接时可直接获得精简转录。
- 移动端滚动长会话时，Turns 导航会固定在视口顶部；展开目录和自动高亮仍保持可用。

## [0.6.1] - 2026-08-03

### 修复

- 阿里云 FC 返回 Viewer、静态资源和 Agent 转录时显式使用 inline 展示，避免浏览器将响应作为附件下载。

## [0.6.0] - 2026-08-03

### 新增

- 同一个 Viewer URL 现在可通过 `format=agent` 或 `Accept: text/markdown` 返回
  `agent-transcript@v1`，普通浏览器仍显示原有 HTML Viewer。
- 新增面向 Agent 的精简转录：保留消息 Markdown、工具名称与状态等审查信息，省略工具 payload
  和内部事件正文，显著降低长会话的传输体积与 token 消耗。
- `threadshare read` 默认读取精简 Agent 转录，并继续支持完整 JSON 和完整 Markdown 输出。
- Viewer 和 HTTP 响应增加 Agent alternate 发现信息与 “AI agent review” 入口。

## [0.5.0] - 2026-08-02

### 新增

- CLI 增加完整的根命令与子命令帮助，可直接发现命令、参数、默认值、输出和安全注意事项。
- CLI 失败输出使用稳定诊断码，并统一提供 `Problem`、`Usage` 和 `Next`，同时清理敏感参数。

## [0.4.2] - 2026-08-02

### 新增

- npm 稳定版本改由 GitHub Release 触发，并通过 Trusted Publishing 自动发布及生成 provenance。

### 修复

- 修正 npm 发布工作流的解析问题，确保 GitHub Actions 能正常启动发布任务。

## [0.4.1] - 2026-08-02

### 新增

- CLI 可列出本机 Codex、Claude Code 和 Paseo 会话，并支持从指定用户轮次开始分享。
- 分享和发布命令支持 `--expires`，可设置 1 分钟至 365 天的有效期；到期后立即拒绝读取并尝试惰性删除。
- 分享和发布命令支持 `--revoke`，使用只在客户端展示一次的撤销凭证主动失效链接；服务端只保存凭证摘要。
- 新增 `threadshare read`，可从 Viewer 或 API URL 读取完整 JSON 或可读 Markdown。
- 新增 `--dry-run` 和 `--report` 本地预检，在上传前验证格式、大小、entry 分布和脱敏结果。
- Viewer 增加用户 Turns 目录、消息锚点，以及工具调用和思考内容的本地折叠，便于浏览长会话。
- Cloudflare/R2 与阿里云 FC/OSS 同步支持过期、撤销、读取和新版内部存储包装。

### 修复

- 撤销命令可正确接收完整的 256-bit capability token，包括以 `--` 开头的合法值。

[线上版本]: https://github.com/team-harness/threadshare/compare/0.6.1...HEAD
[0.6.1]: https://github.com/team-harness/threadshare/compare/0.6.0...0.6.1
[0.6.0]: https://github.com/team-harness/threadshare/compare/0.5.0...0.6.0
[0.5.0]: https://github.com/team-harness/threadshare/compare/0.4.2...0.5.0
[0.4.2]: https://github.com/team-harness/threadshare/compare/0.4.1...0.4.2
[0.4.1]: https://github.com/team-harness/threadshare/releases/tag/0.4.1
