# Threadshare

[English](./README.md) | [简体中文](./README.zh-CN.md)

Threadshare 是一个可自行部署的 Agent 会话分享服务，由只读 Web Viewer、HTTP API 和 CLI 组成。它不依赖 Paseo、Codex、Claude Code 或特定云厂商。

本仓库拥有通用的 `threadshare-history@v1` 协议。不同 Agent 的原始会话会先转换为这一格式，再由 Threadshare 校验、存储并生成稳定的只读链接。

## 快速开始

通过 npm 全局安装：

```bash
npm install --global @team-harness/threadshare
threadshare share codex <session-id-or-jsonl-file>
threadshare share claude <session-id-or-jsonl-file> --json
```

也可以不安装，直接运行：

```bash
npx --yes @team-harness/threadshare@latest share codex <session-id-or-jsonl-file>
```

CLI 默认使用 `https://cloud-thread.team-harness.com`。可以通过 `--url <service-url>` 或 `THREADSHARE_URL` 覆盖。普通输出是 Viewer 链接；`--json` 输出 `{"id":"...","url":"..."}`，适合 Agent 和脚本处理。

CLI 只导出用户消息、Assistant 文本、思考和工具调用，不上传原始 system prompt、凭证或 provider 配置。可见消息和工具输入输出仍可能包含敏感信息，分享前应确认会话适合公开给持有链接的人。

## CLI

```text
threadshare export <codex|claude> <session-id|file> [--output <file|->]
threadshare publish <history.json|-> [--url <service-url>] [--json]
threadshare share <codex|claude> <session-id|file> [--url <service-url>] [--json]
threadshare validate <history.json|->
```

Codex 会话优先从 `$CODEX_HOME/sessions` 查找，未配置时使用 `~/.codex/sessions`；Claude Code 会话从 `~/.claude/projects` 查找。可以传完整 session ID、能够唯一匹配的部分 ID，或者 JSONL 文件路径。部分 ID 命中多个文件时必须改用更完整的 ID 或路径。

只导出，不上传：

```bash
threadshare export codex <session-id> --output history.json
threadshare validate history.json
```

上传已有的协议 JSON：

```bash
threadshare publish history.json --json
```

## Agent Skill

仓库内置 `threadshare` Skill，用来规范 Codex 和 Codex Cloud 如何定位会话、执行分享、验证返回 JSON，以及避免在常规检查中输出聊天正文和本地路径。

为 Codex 全局安装：

```bash
npx --yes skills add team-harness/threadshare --skill threadshare --agent codex --global --yes
```

Codex Cloud 可以在环境初始化阶段执行同一命令，但去掉 `--global`，将 Skill 安装到项目范围。Skill 源文件位于 [`skills/threadshare`](./skills/threadshare)。

## JSON 协议

规范文件位于 [`schema/threadshare-history.v1.schema.json`](./schema/threadshare-history.v1.schema.json)。基础结构如下：

```json
{
  "format": "threadshare-history@v1",
  "schemaVersion": 1,
  "exportedAt": "2026-07-30T00:00:00.000Z",
  "conversation": {
    "id": "provider-session-id",
    "title": "Conversation title",
    "provider": "codex",
    "source": "codex"
  },
  "entries": []
}
```

Entry 支持消息、工具调用、思考、待办、活动记录和上下文压缩标记。Viewer 将所有文本视为不可信内容：原始 HTML 会被转义，不安全链接只显示为文本。

迁移期间，API 仍接收旧 Paseo v1 JSON；所有新生产者都应输出 `threadshare-history@v1`。

## HTTP API

Viewer 与 API 使用同一域名：

```text
POST /api/v1/shares       -> { "id": "<uuid>" }
GET  /api/v1/shares/:id   -> threadshare history JSON
Viewer                    -> /?id=<uuid>#message-<entry-id>
```

上传接口只接收 `application/json`，严格校验协议，最大 5 MiB。服务端始终生成 `shares/<uuid>.json`，客户端不能指定对象路径、文件名或 MIME 类型。公开部署时应在网关或 CDN 配置限流。

## 部署

### Cloudflare Workers + R2

```bash
npm install
npx wrangler login
npx wrangler r2 bucket create threadshare-shares
npm run deploy:cloudflare
```

`wrangler.jsonc` 通过 `THREADSHARE_BUCKET` 绑定 R2，并使用 Workers Assets 托管 Viewer。第一次部署完成后可在 Cloudflare 绑定自定义域名。不要提交 account ID、API Token 或存储凭证。

### 阿里云 FC + OSS

```bash
npm install
npm run build:fc
cd fc
licell login
licell workspace init --type api --app threadshare-fc --runtime nodejs22 \
  --entry dist/index.cjs --target prod --disable-vpc --region cn-shanghai
licell oss create threadshare-shares-your-name --acl private --public-access-block on
licell env set THREADSHARE_OSS_BUCKET threadshare-shares-your-name
licell env set THREADSHARE_OSS_REGION cn-shanghai
licell env set THREADSHARE_OSS_ACCESS_KEY_ID <ram-access-key-id>
licell env set THREADSHARE_OSS_ACCESS_KEY_SECRET <ram-access-key-secret>
cd ..
npm run deploy:fc
```

FC 负责代理私有 OSS 的读写。建议使用仅允许访问 `shares/` 前缀 `GetObject` 和 `PutObject` 的独立 RAM 身份。`.licell/` 中的本地部署状态不会提交到仓库。

### Void

为应用绑定 Object Storage 后执行：

```bash
npx void init
npm run deploy:void
```

## Paseo 接入

Paseo 是 Threadshare 协议的一个生产者。默认共享服务已经是 `https://cloud-thread.team-harness.com`；自行部署后，可以在 daemon 配置中覆盖：

```json
{
  "daemon": {
    "chatShare": { "baseUrl": "https://your-threadshare.example.com" }
  }
}
```

Paseo 只向 API 上传经过转换的会话 JSON，不包含云凭证，也不依赖本仓库的具体部署方式。

## 验证

```bash
npm run build:cloudflare
npm run test:cli
npm run test:fc
```
