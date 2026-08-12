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

### 2. 查找会话

不知道原生 session ID 时，可以列出最近更新的 10 个会话：

```bash
threadshare sessions codex
threadshare sessions claude
```

每项包含完整 session ID、更新时间、项目、Git 分支，以及经过脱敏的首条可见用户请求预览。该命令只读取本机文件，不上传任何内容。使用 `--offset <n>` 和 `--limit <n>` 分页；Agent 或脚本增加 `--format json`，可获得稳定的单行响应。

### 3. 分享会话

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

### 让 Agent 查询本地 Insights

先用 `sync` 初始化或增量更新本地 Insights 索引，再通过 JSON-only 查询动作分析已提交、经过隐私裁剪的历史；
查询本身不会上传数据，也不会重新扫描 provider session 文件：

```bash
threadshare insights status
threadshare insights sync
threadshare insights search --query 'database timeout' --format json
threadshare insights usage skill --request usage.json --format json
threadshare insights activity --request activity.json --format json
```

`sync` 会在索引不存在时创建它；索引已存在时只提交新增、变更、删除或刚被排除的 Session。
在交互式终端中，它会把字节进度写到 stderr。只有明确需要完整原子重建或恢复 origin secret 时才使用
`reindex`。

规范请求形状以 `threadshare insights --help` 和各 action 的 help 为准。查询面包括 Overview、
Tool/Skill 使用排行、UTC 活动分桶、带过滤条件的 Turn 搜索、Capability 目录，以及带 revision
校验的证据分页。响应包含用于引用结果、检测分页期间原子 reindex 的 committed snapshot 身份。

适合交给 Agent 的高价值问题包括：

- **复用过去的解决方案：**“以前处理过类似的数据库超时吗？当时尝试了什么？”Search 找到相关
  Turn，带 revision 校验的 Evidence 用可见问题和最终结果支撑回答，避免 Agent 重复探索同一路径。
- **选择 Skill 或 Tool：**“最近最常用哪些 Skill，分别用在什么情况下？哪些 Tool 反复出现失败
  invocation？”Usage 给出已记录活动的排行，Search 与 Evidence 补充问题背景和结果，让排行可以转化
  为实际选择。
- **发现反复出现的工程阻力：**“哪些失败、retry 或中止任务一直重复出现？”带过滤条件的 Search
  串联跨 Session 的重复症状，帮助 Agent 识别脆弱测试、环境问题和重复返工。
- **衡量工作流调整：**“引入一个新 Skill 后，与上一周期相比发生了什么变化？”Usage 的对比窗口
  和 UTC Activity 分桶展示 invocation 与工作模式的变化，同时不上传底层 Session。

本地 Insights 目前为 macOS 与 Linux 的 arm64/x64 提供原生包。Windows 安装仍可使用
`share`、`read`、`export` 等 Threadshare 核心 CLI；在 owner-only Windows ACL adapter 完成前，
0.7.x 不提供本地 Insights。

Usage 统计的是索引记录中的 invocation，不是推断出的独立使用次数。Agent 必须同时报告 grouped、
ungrouped invocation 与返回的 dedupe support；Capability 调用终态和所在 Turn 的结果必须分开陈述，
共现不能被表述为某个 Tool 或 Skill 导致 Turn 成功或失败。查询结果可以包含有界的可见问题与最终
回答摘录，但不会包含原始 Tool payload、system/thinking 内容、provider pointer 或本地路径。

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

## 安装 Codex Skill

仓库内置 `threadshare` Skill，用来规范 Codex 和 Codex Cloud 如何定位、分享和验证会话，并避免在常规检查中输出聊天正文或本地路径。

为 Codex 全局安装：

```bash
npx --yes skills add team-harness/threadshare --skill threadshare --agent codex --global --yes
```

Skill 会优先使用已安装的 CLI，不存在时回退到 `npx`。Codex Cloud 可在环境初始化阶段去掉 `--global`，安装到项目范围。源文件位于 [`skills/threadshare`](./skills/threadshare)。

## 隐私与分享边界

Viewer 链接只读且不会公开列出，但它不是带鉴权的私密链接。任何获得链接的人都能读取对应会话。

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

FC 负责代理私有 OSS 的读写。建议使用独立 RAM 身份，并将权限限制为 `shares/` 前缀的 `GetObject`、`PutObject` 和 `DeleteObject`。

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
