# Threadshare

[English](./README.md) | [简体中文](./README.zh-CN.md)

Threadshare 可以把 Codex、Claude Code 和 Paseo agent 会话转换成只读 Web 链接。

安装 CLI 后即可使用 [cloud-thread.team-harness.com](https://cloud-thread.team-harness.com) 提供的默认托管服务，无需先部署服务端。

需要自有域名、存储或基础设施控制时，可以独立部署同一套 Viewer、API 和 `threadshare-history@v1` 通用协议。Threadshare 不依赖特定 Agent provider 或云平台。

## 快速开始

Threadshare 需要 Node.js 20 或更高版本。

### 1. 安装 CLI

```bash
npm install --global @team-harness/threadshare
```

### 2. 分享会话

根据会话所属的 provider 选择命令：

```bash
# Codex 或 Codex Cloud
threadshare share codex <session-id-or-jsonl-file>

# Claude Code
threadshare share claude <session-id-or-jsonl-file>

# 使用 Codex 或 Claude 的 Paseo agent
threadshare share paseo <agent-id-or-prefix>
```

`share` 会导出可见会话内容、执行协议校验、上传到默认托管服务，并输出 Viewer 链接：

```text
https://cloud-thread.team-harness.com/?id=<share-id>
```

Agent 或脚本可以增加 `--json`，获得单行 `{"id":"...","url":"..."}` 响应。

### 从某条用户消息开始分享

人在交互式终端中可以让 Threadshare 展示最近 10 个用户 turn，再选择共享会话的起点：

```bash
threadshare share paseo <agent-id-or-prefix> --pick-start
```

输入 `m` 再加载 10 条更早的消息，输入 `q` 取消。被选中的用户 turn 会包含在分享中，内容一直延续到当前快照末尾。`--pick-start` 不能与 `--from` 或 `--before` 一起使用。

Agent 应使用非交互候选命令。它会把最后一个用户 turn 作为排他边界，从而排除“请分享”、后续加载更多、序号选择和分享工具调用本身：

```bash
threadshare messages paseo <agent-id-or-prefix> --format json
threadshare messages paseo <agent-id-or-prefix> --format json \
  --before <original-boundary-id> --offset <next-offset>
threadshare share paseo <agent-id-or-prefix> \
  --from <selected-message-id> --before <original-boundary-id> --json
```

`messages` 默认按从新到旧返回边界前最近 10 个候选，单行 JSON 包含 `boundaryId`、`boundaryPreview`、`messages`、`hasMore` 和 `nextOffset`。Agent 应确认 `boundaryPreview` 对应当前分享指令，只向用户展示带序号的预览；加载更多时始终复用首次的 `boundaryId`，不向用户暴露内部消息 ID。如果当前请求还没有写入原生 session，应重试一次或停止，不能猜测边界。

脚本已经知道准确用户消息 ID 时，可以直接使用范围参数：`--from` 包含起点，`--before` 排除结束边界。`--from last-user` 表示 `--before` 之前最后一个用户 turn；未提供边界时表示快照中的最后一个用户 turn。同一原生用户 turn 包含多个文本 block 时始终作为整体选择。

同时未提供 `--from` 和 `--before` 时，`share` 与 `export` 保持默认行为，处理完整的可见会话快照。显式传入空的范围值属于非法参数，命令会在发布前退出，避免选取失败后静默退化为全量分享。

Viewer 链接不会公开列出，但它不带访问鉴权。任何获得链接的人都能读取对应会话，因此分享前应先检查内容。

分享 Paseo agent 时，本机需要安装 `paseo` CLI 且 daemon 可访问。Threadshare 会定位它引用的原生 Codex 或 Claude session，不修改 Paseo，也不上传 Paseo 状态文件。

### 不安装直接运行

```bash
npx --yes @team-harness/threadshare@latest share codex <session-id-or-jsonl-file>
```

### 使用其他 Threadshare 服务端

CLI 默认连接托管服务。需要使用独立部署时，可以为单次命令或当前 shell 覆盖地址：

```bash
threadshare share codex <session-id> --url https://threadshare.example.com
export THREADSHARE_URL=https://threadshare.example.com
```

## CLI 命令

```text
threadshare messages <codex|claude|paseo> <session-id|file|agent-id> --format json [--before <user-message-id>] [--offset <n>] [--limit <n>]
threadshare export <codex|claude|paseo> <session-id|file|agent-id> [--from <user-message-id|last-user>] [--before <user-message-id>] [--output <file|->]
threadshare publish <history.json|-> [--url <service-url>] [--json]
threadshare share <codex|claude|paseo> <session-id|file|agent-id> [--from <user-message-id|last-user>] [--before <user-message-id>] [--pick-start] [--url <service-url>] [--json]
threadshare validate <history.json|->
```

- `share`：一步完成原生会话导出与发布。
- `messages`：为 Agent 选择起点返回已脱敏的单行用户 turn 预览；必须使用 `--format json`，默认与最大分页大小分别是 10 和 50。
- `export`：只生成规范 JSON，不上传。
- `publish`：上传已有的 `threadshare-history@v1` 文档。
- `validate`：在本地校验协议文档。

例如，先检查导出内容再发布：

```bash
threadshare export codex <session-id> --output history.json
threadshare validate history.json
threadshare publish history.json --json
```

Codex 会话优先从 `$CODEX_HOME/sessions` 查找，未配置时使用 `~/.codex/sessions`。Claude Code 会话从 `~/.claude/projects` 查找。部分 ID 有歧义时，可以传入明确的 JSONL 路径。

Paseo agent 必须使用完整 UUID 或唯一 UUID 前缀。Threadshare 会通过 Paseo CLI 获取 daemon home，只读取匹配的本地 agent 元数据，再把原生 session ID 交给 Codex 或 Claude 导出器。

目前只支持使用 Codex 或 Claude 的 Paseo agent。运行中的 agent 只能导出原生 provider 已持久化内容的 best-effort 快照，可能不包含仍在写入的尾部。

## 安装 Codex Skill

仓库内置 `threadshare` Skill，用来规范 Codex 和 Codex Cloud 如何定位、分享和验证会话，并避免在常规检查中输出聊天正文或本地路径。

为 Codex 全局安装：

```bash
npx --yes skills add team-harness/threadshare --skill threadshare --agent codex --global --yes
```

Skill 会优先使用已安装的 CLI，不存在时回退到 `npx`。Codex Cloud 可在环境初始化阶段去掉 `--global`，安装到项目范围。源文件位于 [`skills/threadshare`](./skills/threadshare)。

## 隐私与分享边界

Viewer 链接只读且不会公开列出，但它不是带鉴权的私密链接。任何获得链接的人都能读取对应会话。

导出器会保留可见的用户消息、Assistant 文本、思考和工具活动；跳过隐藏记录、元记录与 sidechain 记录；不导出原始 system prompt 和 provider 配置。原生日志有时会把 Agent 注入的编排上下文记录为 `role: "user"`，Threadshare 会把这类已知 wrapper 视为隐藏内容，并从全量与范围导出中排除。

范围分享会先关联工具调用与结果，再重建工具在排他边界时的状态。即使工具调用发生在 `--before` 之前，边界之后才写入的结果也不会进入分享。

常见凭据字段和 token 模式会尽力脱敏。可见消息、工具输入或输出仍可能包含未被识别的敏感数据，因此分享前应检查会话内容。

## 独立部署 Threadshare

使用默认托管服务时可以跳过本节。需要控制域名、对象存储、地域、限流策略或发布周期时，再选择独立部署。

首先准备仓库：

```bash
git clone https://github.com/team-harness/threadshare.git
cd threadshare
npm install
```

部署完成后，通过 `--url` 或 `THREADSHARE_URL` 将 CLI 指向新域名。Viewer 与 API 必须使用同一个 origin。

### Cloudflare Workers + R2

```bash
npx wrangler login
npx wrangler r2 bucket create threadshare-shares
npm run deploy:cloudflare
```

`wrangler.jsonc` 使用 `THREADSHARE_BUCKET` 绑定 R2，并通过 Workers Assets 托管 Viewer。首次部署后可在 Cloudflare 绑定自定义域名。不要提交 account ID、API Token 或存储凭据。

### 阿里云函数计算 + OSS

```bash
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

FC 负责代理私有 OSS 的读写。建议使用独立 RAM 身份，并将权限限制为 `shares/` 前缀的 `GetObject` 和 `PutObject`。

`fc/.licell/`、`.void/` 和 `.wrangler/` 下的本地部署状态已被 Git 忽略，不应提交。

### Void Viewer

Void 可以部署 Vite Viewer。对外开放写入 API 前，需要先绑定对象存储：

```bash
npx void init
npm run deploy:void
```

## 协议与 API

新的 producer 需要把原生会话转换为 `threadshare-history@v1`。规范文件位于 [`schema/threadshare-history.v1.schema.json`](./schema/threadshare-history.v1.schema.json)。

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

Entry 可以表示消息、工具调用、思考、待办、活动或上下文压缩标记。Viewer 将会话文本视为不可信内容：原始 HTML 会被转义，不安全链接只保留标签文本。

旧 Paseo v1 格式只用于迁移兼容。新的 producer 必须使用 `threadshare-history@v1`，Threadshare 运行时不依赖 Paseo。

### HTTP API

```text
POST /api/v1/shares       -> { "id": "<uuid>" }
GET  /api/v1/shares/:id   -> threadshare history JSON
Viewer                    -> /?id=<uuid>#message-<entry-id>
```

`POST` 只接收 `application/json`，严格校验协议，最大负载为 5 MiB。服务端始终生成 `shares/<uuid>.json`，客户端不能指定对象路径、文件名或 MIME 类型。

历史读取响应使用 `Cache-Control: no-store`，避免共享会话被中间缓存保留。

公开部署时应在网关或 CDN 配置限流。

### Paseo 作为 Producer

快速开始中的 CLI bridge 无需修改 Paseo。如需原生 producer 集成，[team-harness/paseo](https://github.com/team-harness/paseo) 是内置 Thread Share 支持的定制版本。

在 daemon 中配置 Threadshare 服务地址：

```json
{
  "daemon": {
    "chatShare": { "baseUrl": "https://cloud-thread.team-harness.com" }
  }
}
```

Paseo 只上传经过校验的会话 JSON，不包含云凭据，也不依赖本仓库的具体部署方式。

## 开发验证

根据改动范围运行对应检查：

```bash
npm run build:cloudflare
npm run test:cli
npm run test:api
npm run test:fc
```
