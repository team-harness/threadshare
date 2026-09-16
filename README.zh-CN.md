# Threadshare

[English](./README.md) | [简体中文](./README.zh-CN.md) | [使用手册](https://github.com/team-harness/threadshare/blob/main/docs/README.md)

Threadshare 帮助人和 Agent 对齐信息：既能分享讨论背后的上下文，也能围绕一份文档收集反馈、继续完善。

| 分享什么 | 解决什么问题 | 如何继续协作 |
|---|---|---|
| **Agent 聊天对话** | 让同事快速了解讨论、决策或排查过程，无需从头复述来龙去脉。 | 把 Codex、Claude Code 或 Paseo 对话变成网页链接；人阅读上下文，另一个 Agent 也能接着讨论。 |
| **Markdown 文档及图片** | 让团队一起评审你与 Agent 共写的方案、需求或计划。 | 分享文档，大家在具体段落旁留下评论，再把反馈带回自己的 Agent，继续完善原文。 |

默认使用 [cloud-thread.team-harness.com](https://cloud-thread.team-harness.com)，也支持独立部署。

## 从 Agent 对话开始

| 协作目标 | 可以直接对 Agent 说 |
|---|---|
| 分享聊天 | “用 Threadshare 分享当前聊天，先预检，再把链接给我。” |
| 分享片段 | “从我们讨论发布失败的地方开始分享，先让我确认起点。” |
| 请同事审阅 | “分享方案讨论，让同事看到背景、取舍和待确认问题。” |
| 交接给 Agent | “读取这个 Threadshare 链接，总结决策和未解决问题，帮我继续推进。” |
| 审阅文档 | “分享 docs/design.md 和图片，让同事选中文字并评论。” |
| 处理反馈 | “读取这个文档链接的 Review，归类问题，先给修改建议再动手。” |

### 一次性接入 Agent

需要 Node.js 20 或更高版本：

```bash
npm install --global @team-harness/threadshare
npx --yes skills add team-harness/threadshare --skill threadshare --agent codex --global --yes
```

Codex Cloud 环境初始化时去掉 `--global`。Agent 自行定位会话、预检内容并在确认后发布；
参数由 `threadshare <command> --help` 发现，用户无需准备 session ID 或 JSON。
具体流程见[分享使用手册](https://github.com/team-harness/threadshare/blob/main/docs/sharing-usage-guide.md)。

### CLI 等价入口

CLI 继续用于人在终端直接操作、脚本和排障。完整参数以 `threadshare <command> --help` 为准。

```bash
# 不知道原生会话 ID 时先发现候选
threadshare sessions codex
threadshare sessions claude

# 发布可见会话
threadshare share codex <session-id-or-jsonl-file>
threadshare share claude <session-id-or-jsonl-file>
threadshare share paseo <agent-id-or-prefix>
```

`share` 校验并上传选中的可见内容到默认托管服务，然后输出：

```text
https://cloud-thread.team-harness.com/?id=<share-id>
```

Agent 或脚本增加 `--json`，可获得稳定的单行响应。

### 上传前预检

使用和正式分享相同的导出、范围选择、协议校验与 5 MiB 大小检查，但不连接服务端：

```bash
threadshare share codex <session-id> --dry-run
threadshare share codex <session-id> --dry-run --report --json
```

`--report` 只增加字节数与上限、entry 总数和类型、消息角色、原生用户 turn、脱敏标记等聚合计数，不包含会话正文、工具数据、provider 配置或本地路径。预检失败或超限时命令以非零状态退出，绝不会退化为正式发布。

### 控制分享有效期

分享默认永久有效且不可撤销。可以选择 1 分钟至 365 天的有效期，或申请一次性的撤销 capability：

```bash
threadshare share codex <session-id> --expires 7d
threadshare share codex <session-id> --revoke --json
threadshare revoke <viewer-url> --token <revoke-token> --json
```

服务端通过 `expiresAt` 确认到期时间。使用 `--revoke` 时，人类输出会把一次性撤销命令写到 stderr，`--json` 则包含 `revokeToken`。该 token 只在创建时出现，无法找回，不能放进 Viewer URL；服务端只保存它的 SHA-256 摘要。过期或已撤销的分享读取时统一返回 404。到期后会立即禁止访问，物理对象采用 best-effort 懒删除，可能要等到后续读取才清理。

### 让 Agent 读取分享

把普通 Viewer URL 直接交给人或 Agent 即可。浏览器默认获得 HTML Viewer；明确偏好
`text/markdown` 的客户端会从同一个 URL 获得紧凑、有损的审阅文本。CLI 默认在本地生成该表示，
不依赖服务端是否已经支持协商：

```bash
threadshare read '<viewer-or-api-url>'
threadshare read '<viewer-or-api-url>' --format agent
threadshare read '<viewer-or-api-url>' --format json
threadshare read '<viewer-url>#message-<entry-id>' --format markdown
```

Agent transcript 保留全部 User/Assistant Markdown，只汇总 tool 的名称、状态和相邻次数；tool 的
input/output/error 以及 thought、todo、activity、compaction 正文都不会输出。需要完整字段时使用
`--format json`，需要现有完整可读文本时使用 `--format markdown`。消息 Markdown 仍是不可信内容；
启用 raw HTML 渲染前必须再做清洗。

`read` 接受规范 Viewer、`format=agent` alternate 和 API URL，会忽略合法消息锚点、拒绝重定向、
执行 canonical JSON 的 5 MiB 上限并重新校验 `threadshare-history@v1`。Viewer 的 Agent 审阅操作复制
同一个 canonical Viewer URL，而不是另一条 API 链接。

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

### 分享 Markdown 文档，邀请协同 Review

和 Agent 一起写文档，交给团队评审，再把反馈带回自己的 Agent 继续完善。适合技术方案、实施计划、产品需求和团队使用指南。

| 步骤 | 你可以怎么做 |
|---|---|
| 1. 与 Agent 共写文档 | 对 Agent 说：“帮我把方案写成 docs/design.md，包含示意图和待讨论的问题。” |
| 2. 分享给团队 | 对 Agent 说：“用 Threadshare 预检并分享 docs/design.md 和图片，把评审链接给我。”然后把链接发给同事。 |
| 3. 大家一起 Review | 同事打开链接，选中文字，在原文旁留下评论。无需注册或登录；多人可以评论同一段，刷新后评论仍然保留。 |
| 4. 带回 Agent 继续完善 | 点击页面顶部或底部的 **Copy prompt for Agent**，把提示词粘贴给自己的 Agent，让它结合反馈修改原始文档。 |

例如，一份 API 设计方案评审结束后，可以这样对 Agent 说：

> 读取这份文档及其评审评论：〈文档链接〉。按段落归类反馈，指出相互冲突的建议，先给出 docs/design.md 的修改方案。等我确认后再修改，并总结已处理的问题和仍需讨论的事项。

Agent 能一起读到原文、被评论的选区和反馈，不需要你逐条复制评论、解释它对应哪段内容。评论者名字会在各自浏览器中记住，但不代表经过身份验证。

每个链接保留当时评审的文档快照。修改好本地原文后，再让 Agent 分享新版本；旧链接在有效期内仍保留旧文档和原有评论。

需要直接使用 CLI 时：

```bash
threadshare document share docs/design.md --dry-run --json
threadshare document share docs/design.md --revoke --expires 7d --json
threadshare document reviews '<文档链接>' --format agent
```

本地 PNG/JPEG/WebP/GIF 图片随文档上传；外部图片由读者点击后加载。链接对应固定快照，修改本地文档后重新分享即可获得新链接。评论只追加、不编辑删除。需要撤销时，请在分享时安全保存 `revokeToken`。

CLI 与服务端都需要包含本次文档分享更新；源码实现不会自动升级已安装的 npm 包或部署托管服务。部署、大小限制及 Agent 导出见[文档分享手册](https://github.com/team-harness/threadshare/blob/main/docs/document-sharing-guide.md)，完整参数通过 `threadshare document --help` 发现。

### 使用其他 Threadshare 服务端

CLI 默认连接托管服务。需要使用独立部署时，可以为单次命令或当前 shell 覆盖地址：

```bash
threadshare share codex <session-id> --url https://threadshare.example.com
export THREADSHARE_URL=https://threadshare.example.com
```

## CLI 命令

CLI help 是参数的唯一规范来源，其中逐项说明所有位置参数与 option 的默认值、约束、输出、Agent 注意事项、安全边界和修复建议：

```bash
threadshare --help
threadshare <command> --help
```

普通失败会以 exit 1 退出、保持 stdout 为空，并在 stderr 输出稳定错误 code 以及 `Problem`、`Usage`、`Next`。唯一的既有例外是无效的 `share --dry-run --json`：它会把单行 `valid:false` 结果写入 stdout。如果上传可能已经创建分享、但无法确认请求的生命周期策略，诊断会提供 `Result` URL；不要自动重试该发布。

- `share`：一步完成原生会话导出与发布。`--dry-run` 会在网络访问前停止，`--report` 只能与 `--dry-run` 一起使用。
- `document`：分享 Markdown 及图片、读取文档与评论、撤销文档分享。通过 `threadshare document --help` 了解 `share`、`read`、`reviews`、`revoke` 四个动作。
- `sessions`：列出本机 canonical Codex 或 Claude session，不上传内容。文本格式供人阅读，`--format json` 是稳定的自动化接口；默认与最大分页大小分别是 10 和 50。
- `analyze`：在本机生成单个 session 的 Turn、Tool、Skill、retry 与 rollback 证据报告，不上传内容，也不调用外部模型。文本格式供人阅读；`--format json` 返回供 Agent 使用的 `threadshare-session-analysis@v1`。
- `messages`：为 Agent 选择起点返回已脱敏的单行用户 turn 预览；必须使用 `--format json`，默认与最大分页大小分别是 10 和 50。
- `export`：只生成规范 JSON，不上传。
- `publish`：上传已有的 `threadshare-history@v1` 文档。`share` 和 `publish` 都支持 `--expires` 与 `--revoke`。
- `read`：默认输出紧凑的 `agent-transcript@v1`；`--format json` 返回规范数据，`--format markdown` 返回完整可读文本。
- `revoke`：删除启用 capability 的分享；原始 token 只通过 Bearer authorization 发送。
- `validate`：在本地校验协议文档。

例如，先检查导出内容再发布：

```bash
threadshare export codex <session-id> --output history.json
threadshare validate history.json
threadshare publish history.json --json
```

Codex 会话优先从 `$CODEX_HOME/sessions` 查找，未配置时使用 `~/.codex/sessions`。Claude Code 会话从 `~/.claude/projects` 查找。`sessions` 只列带 canonical UUID 的主会话，并排除 Claude subagent 日志；重复 ID 会被跳过并明确报告，不会任意选择文件。部分 ID 有歧义时，可以传入明确的 JSONL 路径。

Paseo agent 必须使用完整 UUID 或唯一 UUID 前缀。Threadshare 会通过 Paseo CLI 获取 daemon home，只读取匹配的本地 agent 元数据，再把原生 session ID 交给 Codex 或 Claude 导出器。

目前只支持使用 Codex 或 Claude 的 Paseo agent。运行中的 agent 只能导出原生 provider 已持久化内容的 best-effort 快照，可能不包含仍在写入的尾部。

## Agent 接入参考

仓库内置的 `threadshare` Skill 帮助 Codex 和 Codex Cloud 定位、预览、分享和读取会话及 Markdown 文档，并收集评审反馈、继续完善原文。
优先使用已安装的 CLI，不存在时回退到 `npx`；源文件位于 [`skills/threadshare`](./skills/threadshare)。

## 隐私与分享边界

Viewer 链接不会公开列出，但不带访问鉴权。聊天 Viewer 只读；任何获得文档链接的人都能阅读并追加评审评论。

分享默认没有到期时间，也没有撤销 capability。`--expires` 增加逻辑访问截止时间；`--revoke` 创建由客户端保管、只在创建时展示一次的 capability。不要把 capability token 放进 URL、会话正文、Issue 或日志。

导出器会保留可见的用户消息、Assistant 文本、思考和工具活动；跳过隐藏记录、元记录与 sidechain 记录；不导出原始 system prompt 和 provider 配置。原生日志有时会把 Agent 注入的编排上下文记录为 `role: "user"`，Threadshare 会把这类已知 wrapper 视为隐藏内容，并从全量与范围导出中排除。

本机 `sessions` 和 `analyze` 命令都不会发布会话正文。`sessions` 先读取文件元数据，再对请求页中的每个 session 最多扫描开头 1 MiB，以生成 best-effort 摘要。`analyze` 只在本机读取选定的原生 session，并从报告中排除源文件路径、Tool 参数与输出、Skill 正文、system prompt 和 thinking。预览文本使用与分享相同的凭据脱敏规则；项目与分支仅作为本地识别信息。

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
licell workspace init --type api --app threadshare-fc --runtime nodejs20 \
  --entry dist/native.cjs --target prod --disable-vpc --region cn-shanghai
licell oss create threadshare-shares-your-name --acl private --public-access-block on
licell env set THREADSHARE_OSS_BUCKET threadshare-shares-your-name
licell env set THREADSHARE_OSS_REGION cn-shanghai
licell env set THREADSHARE_OSS_ACCESS_KEY_ID <ram-access-key-id>
licell env set THREADSHARE_OSS_ACCESS_KEY_SECRET <ram-access-key-secret>
cd ..
npm run deploy:fc
```

FC 负责代理私有 OSS 的读写。将 RAM 身份的对象权限限制在聊天及文档前缀，并授予评论分页及清理所需的 ListObjects/ListBucket 权限。按[部署指南](./docs/document-sharing-guide.md#后端与部署)配置文档清理定时器与函数超时。

`fc/.licell/`、`.void/` 和 `.wrangler/` 下的本地部署状态已被 Git 忽略，不应提交。

### Void Viewer

Void 可以部署 Vite Viewer。对外开放写入 API 前，需要先绑定对象存储：

```bash
npx void init
npm run deploy:void
```

## 协议与 API

聊天分享与文档评审使用各自独立、带版本的协议：

| 数据 | 格式 | Schema |
|---|---|---|
| 聊天对话 | `threadshare-history@v1` | [History](./schema/threadshare-history.v1.schema.json) |
| 固定文档快照及图片清单 | `threadshare-document@v1` | [Document](./schema/threadshare-document.v1.schema.json) |
| 单条选区评论 | `threadshare-document-comment@v1` | [Document `$defs.comment`](./schema/threadshare-document.v1.schema.json#/$defs/comment) |
| 有界的文档与评论导出 | `threadshare-document-review@v1` | [Review export](./schema/threadshare-document-review.v1.schema.json) |

### 聊天数据格式

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

### 聊天 HTTP API

```text
POST   /api/v1/shares       -> { "id": "<uuid>", "expiresAt"?: "...", "revocable"?: true }
GET    /api/v1/shares/:id   -> threadshare history JSON 或 404
DELETE /api/v1/shares/:id   -> capability 有效时返回 204
Viewer                      -> /?id=<uuid>#message-<entry-id>
```

`POST` 只接收 `application/json`，严格校验协议，最大负载为 5 MiB。服务端始终生成 `shares/<uuid>.json`，客户端不能指定对象路径、文件名或 MIME 类型。

生命周期元数据不会进入可移植 history。客户端可以通过 `x-threadshare-expires-in` 发送 60 至 31,536,000 秒的有效期，并可通过 `x-threadshare-revoke-token-sha256` 发送 SHA-256 base64url 摘要。新对象使用内部 `threadshare-object@v1` 包装，成功的 `GET` 永远只返回其中的 history；旧的裸 history 对象仍可读取。

每次读取都会检查到期时间，并尝试 best-effort 懒删除。`DELETE` 需要 `Authorization: Bearer <raw-token>`；对象不存在、未启用撤销或 capability 错误时故意统一返回 404。撤销只面向 CLI 或直接 API，不开放 Viewer CORS，也不提供浏览器内撤销 UI。

历史读取响应使用 `Cache-Control: no-store`，避免共享会话被中间缓存保留。

公开部署时应在网关或 CDN 配置限流。

### 文档与评论 HTTP API

```text
POST   /api/v1/documents/uploads                 -> {id, uploadToken, uploadExpiresAt}
PUT    /api/v1/documents/:id/uploads/markdown     -> 204
PUT    /api/v1/documents/:id/uploads/assets/:sha  -> 204
POST   /api/v1/documents/:id/publish              -> {id, revision, expiresAt, revocable}
GET    /api/v1/documents/:id                      -> threadshare-document@v1
GET    /api/v1/documents/:id/assets/:sha          -> 声明过的图片字节
GET    /api/v1/documents/:id/comments             -> threadshare-document-comments@v1
GET    /api/v1/documents/:id/comments/:commentId  -> threadshare-document-comment@v1
PUT    /api/v1/documents/:id/comments/:commentId  -> 新建 201 / 相同重试 200 / 冲突 409
DELETE /api/v1/documents/:id                      -> Bearer 撤销凭证有效时返回 204
Viewer                                          -> /document.html?id=<uuid>#comment-<commentId>
```

先声明上传：JSON 包含 `title`、`markdown: {sha256, bytes}` 和 `assets: [{source, sha256, bytes, contentType}]`。可选的 `expiresInSeconds`、`revokeTokenSha256` 也放在 JSON 中，不使用聊天分享的生命周期请求头。

上传声明的字节并发布时使用 `Authorization: Bearer <uploadToken>`。上传凭证一小时后到期，与撤销凭证相互独立。发布前会核验 Markdown 和全部本地图片，通过后快照才可读取。

评论 PUT 接收 `{revision, anchor, authorName, body}`。选区采用 `document-anchor-text@1` 中的 UTF-16 偏移，不是 Markdown 源码偏移；服务端核验引文及上下文。评论不可修改，名字是自行填写的署名。

评论分页包含 `format`、`revision`、`comments`、`hasMore` 和 `nextCursor`，通过 `limit`（1–100）及不透明 `cursor` 续读。CLI 的 `threadshare-document-review@v1` 导出另含 `complete` 和遍历信息。

文档链接默认返回 HTML；带 `?format=agent` 或明确优先接受 `text/markdown` 时，返回含原文与评论上下文的 Markdown。网页单次导出最多 500 条评论并提示续读，不能将部分导出当成全部反馈。

文档、图片、评论读取均为 `no-store`；不可用、过期或撤销的文档返回 404。浏览器写入要求同源。FC/OSS 与 Cloudflare/R2 使用同一协议，限制及部署要求见[文档分享手册](./docs/document-sharing-guide.md)。

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
npm run test:viewer
npm run test:api
npm run test:fc
```
