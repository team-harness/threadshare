---
status: active
created: 2026-08-01
work: ../work/epic-lightweight-sharing-evolution.md
---

# Threadshare 轻量分享能力演进

## 起点

Threadshare 已提供 Codex、Claude Code 与 Paseo 会话导出、匿名只读分享链接、静态 Viewer，以及行为等价的 Cloudflare/R2 和阿里云 FC/OSS 部署。公开 producer 契约为 `threadshare-history@v1`，当前存储对象直接保存该 history，分享默认永久有效。

当前主要缺口是：长会话不易定位，Agent 缺少稳定的远端读取命令，发布前缺少不上传的本地检查，分享创建后也不能选择到期或撤销。

## 目标

在不引入账户、数据库、KV、队列或云厂商控制面的前提下，提高 Threadshare 对人和 Agent 的可读性、发布可控性与分享生命周期管理能力，同时保持现有公开 history 格式、默认行为和双云部署对等。

## 范围

- Viewer 长会话导航：用户 turn 目录，以及工具与思考折叠。
- Agent 原生读取：`threadshare read <share-url> --format <json|markdown>`。
- 本地发布预检：`threadshare share ... --dry-run [--report]`。
- 每条分享可选过期，默认仍永久有效；到期后立即拒绝读取并懒删除对象。
- 每条分享可选 capability 撤销；服务端只保存 token 摘要。
- CF/R2 与 FC/OSS 行为、错误语义和测试保持等价。
- README、CLI 帮助和 bundled Skill 与新增命令同步。

## 非目标

- 不增加对齐说明、结论 brief，也不修改原始会话内容。
- 不增加账户、团队空间、权限、评论或协作控制面。
- 不增加匿名写入限流、容量或成本告警、成功率、延迟、404 指标平台。
- 不增加幂等发布控制面、数据库、KV、队列或 Metrics 后端。
- 不增加定时清理任务；未被再次访问的过期对象允许暂时保留在存储中。
- Viewer 不保存 capability token，也不提供浏览器内撤销 UI；撤销只通过 CLI 或直接 API 调用完成。
- 不过滤用户明确允许保留的链接和图片；继续沿用现有可见内容导出与凭据脱敏边界。
- 不改变或扩展 legacy Paseo shape，也不修改 Paseo CLI。
- 本 Epic 不提前抽取 producer adapter；出现下一个原生 provider 时再执行该重构。
- npm 发布、生产部署和域名切流不属于代码验收，需 owner 另行明确授权。

## 验收标准

- 不带任何新增选项的现有 CLI 和 HTTP 调用保持兼容，分享默认永久有效。
- `POST /api/v1/shares` 的 JSON body 仍是一个经严格校验的 history；`GET /api/v1/shares/:id` 成功时仍返回同一个 history，而不是内部存储包装。
- `threadshare-history@v1` schema、5 MiB 请求限制、JSON-only 校验、固定对象键、`no-store` 读取和不可信 Markdown 渲染边界不弱化。
- 旧的裸 history 对象与新的内部对象包装都可读取；CF 与 FC 对创建、读取、过期、撤销和错误返回有对等测试。
- 实际发布路径的 `--json` 分享输出仍是单行 JSON，至少包含 `id` 和 `url`；新增字段只能是向后兼容的可选字段。dry run JSON 必含 `dryRun: true` 和 `valid`，且不得伪造 `id` 或 `url`。
- `read`、预检、过期和撤销均有 CLI 自动化测试，错误输入严格失败且不会退化成上传、全量分享或任意 URL 操作。
- Viewer 在手机与桌面宽度下可通过 user turn 目录导航长会话，既有消息锚点、复制、安全渲染与只读语义不回归。
- `npm test`、Cloudflare build、FC tests、Skill quick validation 和 `npm pack --dry-run --json` 均通过；打包内容仍只包含 CLI、协议、Skill、README 和许可证所需文件。

## 子项契约

### ITEM-1：内部对象包装与可选过期

- 类型：`cs-feat`
- 依赖：无
- 归属：共享 lifecycle/存储编解码逻辑归入 `src/`；`worker.ts` 与 `fc/handler.ts` 只保留各自对象存储 I/O，固定对象键的 R2/OSS 删除原语随本子项引入，供懒删除和后续撤销复用。
- 设计要点：
  - 新对象使用带显式 `format: "threadshare-object@v1"` 判别字段的内部 JSON 包装，并包含服务端生成的 `createdAt`、可选 `expiresAt` 和原始 `history`。
  - 解码器兼容旧裸 history；缺少过期信息即视为永久有效。
  - CLI 的 `publish` 和 `share` 接受 `--expires <duration>`；时长使用严格的正整数加 `m`、`h` 或 `d`。客户端通过 `x-threadshare-expires-in` header 发送规范化整数秒，服务端只接受 60 到 31,536,000 秒，格式或范围无效统一返回 400，禁止 clamp；POST body 始终只是 history。
  - 过期时间由服务端时钟计算并表示为 RFC 3339 UTC。设置过期时，创建响应必须返回 `expiresAt`，成功 GET 必须返回相同格式和值的 `x-threadshare-expires-at`；未设置时两者均省略，JSON body 始终是 history。
  - 到期读取统一返回不泄露存在性的 404，并尽力删除对象；删除失败不得恢复访问，也不得把 404 改成 500。
  - CF 与 FC 的成功 GET header 集合冻结为 `cache-control: private, no-store`、`content-type: application/json; charset=utf-8`、`access-control-allow-origin: *`、`access-control-expose-headers: x-threadshare-expires-at` 和可选 `x-threadshare-expires-at`；不返回存储对象 ETag，也不在实际 GET 响应重复 preflight-only headers。
  - 集合路由 `/api/v1/shares` 的 OPTIONS 继续返回 204，并明确允许 `POST, OPTIONS` 与 `content-type, x-threadshare-expires-in, x-threadshare-revoke-token-sha256`。GET 是无需 preflight 的简单跨域读取；DELETE 与 `authorization` 不进入 CORS 契约，不支持浏览器跨域撤销。
- 验收要点：默认永久、header 传输、边界时长、服务端时钟、旧对象兼容、到期临界点、懒删除失败、成功 header 集合，以及 CF/FC 等价行为均有测试。

### ITEM-2：Capability 撤销

- 类型：`cs-feat`
- 依赖：ITEM-1
- 归属：token 解析、摘要与存储字段属于共享 lifecycle 模块；R2/OSS adapter 只实现固定对象键删除。
- 设计要点：
  - `publish` 和 `share` 的 `--revoke` 在本机生成 256-bit capability token，只把 SHA-256 base64url 摘要通过 `x-threadshare-revoke-token-sha256` header 发送；POST body 始终只是 history，服务端和存储对象从不保存原始 token。
  - 新增 `threadshare revoke <share-url> --token <token> [--json]`，通过 `Authorization: Bearer` 调用固定的 share DELETE 路由。
  - token 错误、缺失、对象不存在或旧对象未启用撤销时统一返回 404；成功删除返回 204。摘要比较采用固定长度、常量时间比较。
  - 已过期但尚未被懒删除的对象，在 capability 正确时 DELETE 仍删除对象并返回 204；错误 capability 仍返回 404。
  - 非 JSON 的分享 stdout 继续只输出 Viewer URL；一次性撤销命令写到 stderr。`--json` 结果可增加 `revokeToken`，供 Agent 显式保存。
  - share URL 解析只接受 HTTP(S) Viewer URL 或对应的 `/api/v1/shares/<uuid>` URL，不允许把 token 放入 URL。
  - 创建时的 capability 摘要 header 按 ITEM-1 的 POST CORS 契约开放；DELETE 与 `Authorization` 仅供 CLI 和不受 CORS 约束的直接 API 客户端使用，Viewer 本身不保存 token、不提供撤销 UI。
- 验收要点：正确 token 删除、错误 token 不删除、旧对象不可撤销、token 不落存储、固定键删除、CLI 单行 JSON 和 CF/FC 等价行为均有测试。

### ITEM-3：Agent 原生读取

- 类型：`cs-feat`
- 依赖：ITEM-1
- 归属：share URL 规范化和远端 history 读取归入 CLI 侧共享模块；格式化不进入服务端。
- 设计要点：
  - 新增 `threadshare read <share-url> --format <json|markdown>`；接受规范 Viewer URL 及固定 API URL，忽略合法的消息 fragment，但不跟随任意路径。
  - 只允许 HTTP(S)，使用 `redirect: "error"` 禁止跟随重定向，并在读取流和声明长度两处复用 5 MiB `CHAT_SHARE_MAX_BYTES` 上限。
  - 返回值必须再次验证为 `threadshare-history@v1`。legacy Paseo shape 仍可由 API/Viewer 迁移读取，但 CLI `read` 明确拒绝，并提示用户用当前 Threadshare producer 重新发布为 canonical history；这不扩展 legacy contract。
  - JSON 输出是完整 canonical history；Markdown 输出按原顺序确定性表达消息、工具、思考、todo、activity 和 compaction，不丢弃可见内容。
  - 不增加服务端专用 Agent 接口；过期和撤销后的读取沿用相同 404。
- 验收要点：Viewer/API URL、锚点、两种格式、完整 entry 顺序、无效 URL、重定向、声明和流式超限响应、legacy 专用错误、非 history 响应和 404 均有测试。

### ITEM-4：本地发布预检

- 类型：`cs-feat`
- 依赖：ITEM-1、ITEM-2
- 归属：history 汇总与报告格式归入 CLI 侧共享模块，复用现有导出、范围选择和 canonical validation。
- 设计要点：
  - `share ... --dry-run` 完成真实导出、范围选择、脱敏、校验和 5 MiB 检查，但绝不发起网络请求。
  - `--dry-run` 输出简要结果；`--report` 仅可与 `--dry-run` 组合，增加按 entry kind、message role、字节数、用户 turn 数和脱敏标记数汇总。
  - 报告不得输出消息正文、工具参数、工具结果、原生日志路径或 provider 配置；`--json` 时输出稳定单行对象，必含 `dryRun: true` 与 `valid`，且不包含 `id` 或 `url`。
  - `--expires` 与 `--revoke` 可在 dry run 中被校验并报告意图，但不计算最终服务端时间、不生成 capability token。
- 验收要点：三种 provider、范围分享、无网络、超限、严格选项组合、人类输出和单行 JSON 均有测试。

### ITEM-5：Viewer 长会话导航

- 类型：`cs-feat`
- 依赖：无
- 归属：纯 Viewer 状态和 DOM 渲染，不改变 API 或 history schema。
- 设计要点：
  - 从 user message 生成可扫描的 turn 目录，使用现有 `#message-<entry-id>` 锚点；长文本只作转义后的短预览。
  - 工具详情与 thought 均默认折叠并支持逐项展开；折叠控件保持键盘可用并明确暴露展开状态。
  - 桌面布局允许目录与会话并列，手机布局将目录收为紧凑控件；所有控制具有稳定尺寸、键盘焦点和无重叠的响应式布局。
  - Agent 读取引导保持为一行紧凑入口，继续复制完整 source JSON URL，不改变公开读取契约。
  - 点击 turn 目录项或处理 `#message-<entry-id>` deep link 时直接聚焦目标，不修改 history 或分享 URL，也不弱化 Markdown/链接安全处理。
- 验收要点：turn 目录、deep link、工具与 thought 折叠、键盘可用性，以及桌面和手机视觉检查均通过；既有复制与 deep link 行为不回归。

### ITEM-6：集成、文档与交付检查

- 类型：`cs-feat`
- 依赖：ITEM-1、ITEM-2、ITEM-3、ITEM-4、ITEM-5
- 归属：README、CLI help、`skills/threadshare/` 与现有构建和打包检查。
- 设计要点：
  - 从先使用默认服务、再独立部署的视角补齐所有新增命令和生命周期语义。
  - 明确 unlisted link、capability token、默认永久、逻辑过期与懒删除的边界。
  - Skill 为人类和 Agent 分别给出预检、读取、撤销和过期工作流，不打印 transcript 或本地路径。
  - 不在本子项自动执行 npm 发布、生产部署或域名变更。
- 验收要点：全量测试、两套部署构建、Skill 校验和 npm 包内容检查通过，文档命令与 CLI help 一致。

## 关键决策

- `threadshare-history@v1` 继续只描述可移植会话；生命周期元数据只存在于内部 `threadshare-object@v1` 包装，GET 成功响应会解包。
- API 继续无账户、无数据库。访问时读取对象本来就是必经路径，因此过期与 capability 校验不增加新的基础设施依赖。
- 过期分为访问失效与物理清理：访问失效是严格保证；物理清理先采用懒删除。已知上限是从未再次读取的过期对象仍占空间；当实际存储成本或对象数量成为问题时，升级方向是基于相同解码器的可移植 sweep 命令，而不是数据库控制面。
- 撤销 token 由客户端生成，服务端只接收摘要；这样普通 POST body 和 history 契约不变，原始 capability 也不会进入对象存储。
- 创建请求的生命周期元数据只通过已冻结的 `x-threadshare-*` headers 传输；内部包装或生命周期字段不得进入 POST body 或成功 GET body。
- CLI `read` 只消费 canonical history，禁止重定向并严格执行 5 MiB 上限；legacy 迁移读取继续留在 API/Viewer，不扩展到新 CLI 能力。
- 当前 Codex、Claude 与 Paseo 的 producer 分支保持现状。新增下一个原生 provider 是 adapter 抽取与 provider 一致性测试的升级触发器。
- 所有新增选项采用严格校验；空值、非法组合和未知格式直接失败，不退化为永久、全量或实际发布。

## 最终交付索引

待执行完成后补充。

## 整体验收

待所有子项完成后，由 fresh reviewer 按本文件批准版本进行 acceptance review，再由 owner 做最终接受。

## 遗留风险

- 懒删除不保证无人访问的过期对象及时释放存储空间，这是有明确升级触发器的有界简化。
- Capability token 丢失后无法恢复；因为没有账户或数据库，服务端不提供找回能力。
- npm 发布和生产环境部署需要独立授权，并在代码验收之后执行。
