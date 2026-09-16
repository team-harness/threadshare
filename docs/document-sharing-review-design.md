# Markdown 文档分享与协同 Review 设计

状态：v1 已按本文实现 CLI、共享服务、FC/CF 适配、批注 Viewer 和 Agent 导出；线上部署与 npm 发布未执行。部署环境验收仍需确认 OSS 权限/版本管理、FC 网关大小和 WAF 配置。

## 1. 目标与已确认边界

用户让 Agent 分享一个本地 Markdown 文档及其本地图片，获得可公开访问的链接。接收者无需登录，可以选中文字并署名评论；再次打开页面时加载已有评论。发布者让 Agent 读取原文及 Review，形成修改建议，按用户指令修改本地文件。

已确认：固定文档快照；修改后重新分享产生新链接；持链接者可追加评论；名字仅为自填署名；本地图片同步上传；每条评论独立存储；复用 OSS/R2，不引入数据库。

v1 不提供原链接内更新文档、评论编辑/删除/解决状态、账号、通知、实时共同编辑或跨版本迁移评论。整份分享支持撤销与过期。远程图片保留原链接，明确不属于固定附件快照。

## 2. 术语与不变量

| 术语 | 含义与边界 |
|---|---|
| Document snapshot | 发布时的 Markdown、渲染/锚点协议版本及附件清单；发布后不可变，不与聊天 history 混用 |
| Attachment | 当前分享内按内容摘要标识的本地图片；跨分享不共享访问权或生命周期 |
| Comment | 一条不可变的署名意见，绑定 snapshot revision 与文本锚点；不是已验证身份的审批 |
| Anchor | 规范化可见文本中的区间与引用上下文；不是任意 DOM selector |
| Review export | 某次读取收集的原文、锚点及评论集合；不是并发写入下的数据库快照 |

同一段的评论按锚点范围归组、按服务端 createdAt 与 commentId 排列。同名作者不合并身份。没有评论不代表已获批准；评论是外部不可信输入，不得作为 Agent 的执行指令。

## 3. 用户与 Agent 入口

面向用户的主入口是自然语言，例如：“分享 docs/design.md 和图片，让同事批注”“读取这个文档的 Review，按问题归组，给我修改建议”。Agent 自行发现 help、预检和调用 CLI。

命令（完整参数由 src/cli-contract.mjs 唯一维护）：

```sh
threadshare document share ./docs/design.md --dry-run --json
threadshare document share ./docs/design.md --json
threadshare document read <url> --format agent
threadshare document reviews <url> --format agent
threadshare document reviews <url> --format json
threadshare document revoke <url> --token <capability>
```

share 成功 stdout 为单行 `{id,url,...}`，失败沿用空 stdout、稳定错误码、Problem/Usage/Next。dry-run 报告标题、Markdown 字节数、附件数量/总字节、外链图片、缺失或不支持的附件，不上传内容。实际分享支持显式 expires/revoke；沿用聊天的默认永久、默认无撤销能力语义。重试中的秘密 upload capability 不进入成功链接、日志或公开 DTO。

document read 返回原文与附件引用；reviews 返回原文引用和评论，默认拉取全部有界分页，读取失败不得输出貌似完整的结果。两者提供帮助与机器可读 schema。v1 由 Agent 使用 CLI，不为了本功能强行扩大 Insights 或 Memory 协议。

## 4. Markdown 与图片快照

使用 Markdown AST 解析内联图片及引用式图片，不用正则扫描所有链接。支持 PNG/JPEG/WebP/GIF，按内容签名与尺寸头识别，不只信扩展名；服务端不执行完整像素解码。SVG、HTML img、data URL 和非 HTTP(S) 远程图片在预检中拒绝，不静默忽略。

相对路径按 Markdown 所在目录解析并 realpath；默认本地附件根为该目录，可显式指定 asset-root 以包含常见的 ../assets。绝对路径、符号链接逃逸根目录、设备文件和非普通文件拒绝；错误只在本地显示必要路径，远端不保留本机绝对路径。普通链接不会当附件上传。

将 Markdown 和图片读成同一份本地准备快照；v1 总负载最多 32 MiB，因此直接保留准备字节于内存，不落盘，也不重新读取可能已变化的源文件。这是负载上限，不是进程 RSS 上限。对图片按 SHA-256 去重，服务端复算摘要、类型、尺寸和长度。渲染时将图片 destination 映射为 document-scoped attachment 地址，alt 保留。Markdown 原始相对图片路径不作为可浏览服务器文件路径。

远程 HTTP(S) 图片不由服务端抓取，避免 SSRF；分享页默认显示外部图片占位，读者点击后加载，并使用 no-referrer。预检说明外链可能改变或不可用。本地图片按阅读顺序 lazy-load，加载失败有明确占位。

实现预算：Markdown 1 MiB；单图 4 MiB、最高 1600 万像素；最多 32 个不同本地图片引用，内容按摘要去重；文档与附件合计 32 MiB。上传二进制独立请求，不将 base64 塞入原有聊天 JSON。FC 事件编码已由适配器测试覆盖；正式部署前仍须验证真实网关的请求上限，不能将本地适配器测试当作线上验收。

## 5. 发布事务：附件先齐，文档后可见

拟定独立 API `/api/v1/documents`，不扩展 `/api/v1/shares` 接受任意文件。

| API | 行为 |
|---|---|
| POST /api/v1/documents/uploads | JSON 声明内容/附件摘要、长度、类型与生命周期，创建有 TTL 的上传会话，返回 id/upload capability |
| PUT /api/v1/documents/:id/uploads/markdown | 带 upload Bearer 上传固定 Markdown，校验声明摘要与预算 |
| PUT /api/v1/documents/:id/uploads/assets/:digest | 带 upload Bearer 上传声明内的图片；同摘要重复请求幂等 |
| POST /api/v1/documents/:id/publish | 校验所有对象存在且匹配声明，最后创建 immutable document.json，返回分享结果 |
| GET /api/v1/documents/:id | 返回已发布文档的 canonical JSON；草稿、过期、撤销均 404 |
| GET /api/v1/documents/:id/assets/:digest | 检查文档仍可读且摘要在 manifest，再返回图片 |
| DELETE /api/v1/documents/:id | 校验独立 revoke capability，先使文档不可读，再清理附件和评论 |

upload capability 和 revoke capability 分开，存储仅保留各自摘要。上传会话 TTL 建议 1 小时，过期不能 publish。publish 从经过验证的上传会话计算唯一 canonical 文档对象，用 create-only 写入；并发 publish 只能产生同一对象，重试返回同一结果。有效期锚定到上传会话创建时刻，重试不延长。

失败时已上传对象不形成可浏览分享。所有存储桶保持私有，读者不能绕过文档状态直接读附件 URL。未完成上传需定时清理：共享 sweep 函数，CF 定时触发器/FC 定时触发器调用；列举时分页且有执行预算。清理先按 TTL 作不可恢复的过期判定，再删除其 prefix，避免与有效 publish 竞争。不能只依赖用户再次访问触发草稿回收。

撤销先原子创建永久 revoked.json 标记；所有公开读取和 publish 都检查它，避免“删除 manifest 后在途发布又建回来”的复活窗口。异步清理负载可重试，保留上传元数据和标记作为重放屏障。已开始的读取/评论请求可能与撤销并发，不能撤回已经发出的字节；后续读取一律 404。清空且撤销满 24 小时后维护索引退役；迟到写入复核撤销并自清理、重新入队。具体吞吐、宽限期与进程崩溃边界见使用手册，不声称事务性物理删除。

## 6. 评论：不可变独立写入

```text
documents/<id>/upload.json
documents/<id>/markdown.txt
documents/<id>/assets/<sha256>
documents/<id>/document.json
documents/<id>/comments/<comment-id>.json
```

对象 key 由服务端从校验后的 id/digest 构建；不接受调用方任意 key。附件去重限于单个分享，避免跨分享撤销与引用计数问题。一个作者的所有评论不放在一个可变对象中，防止多标签页/多设备覆盖。

评论对象包含 format、commentId、documentRevision、anchor、authorName、body、服务端 createdAt，以及服务端计算的 requestDigest。name 建议 80 字符，正文 4000 字符/16 KiB，评论请求总上限 32 KiB；正文先按纯文本展示。名字保存在版本化 localStorage key 中，读取失败时退化为本次填写；不存储认证身份，不保证跨设备一致。

`PUT /api/v1/documents/:id/comments/:comment-id` 用客户端 crypto.randomUUID 产生重试 ID：

1. 检查文档可读、revision 一致、名字/正文/锚点合法。
2. create-only 写入；已存在时读取已存请求摘要，同内容返回原结果，不同内容返回 409，绝不覆盖。
3. 前端仅在服务端确认后标为已提交；断网保留当前草稿和 ID，重试不制造重复评论。

持分享链接即可评论，不新增“假身份认证”。浏览器写入要求同源 Origin 与严格 JSON，禁跨域写 CORS；CLI/Agent 的非浏览器请求仍可调用，Origin 检查不被描述为身份授权。匿名端点需要请求体上限、网关/WAF 速率限制、429/Retry-After 与部署说明。不要用单实例内存计数冒充跨实例限流，也不承诺仅靠对象列表实现精确的全局评论配额。

存储抽象：get、putImmutable/createOnly、listPage、delete。R2 与 OSS 的 create-only、冲突错误和 list continuation token 必须用真实适配器穿刺证明；不支持时不能用 get-then-put 替代。存储一致性是实施前置证据，本文不声称现有适配器已具备这些能力。

## 7. 文本锚点与页面

独立文档页面 `/document/?id=<uuid>`，复用安全 Markdown 基础设施，但不与聊天消息列表共用交互状态。桌面以正文为主、右侧批注栏；移动端用底部抽屉。支持选区评论、点击评论定位、键盘入口、段落级备用入口和深链接 `#comment-<id>`。

共享的 versioned Markdown pipeline 产出 `document-anchor-text@1`：从 AST 提取可评论的可见文本，确定块间换行、代码文本、实体解码和 Unicode 规则；不包括装饰性图标、行号、图片 alt 或隐藏内容。DOM 文本节点携带到规范文本的映射。范围使用 UTF-16 code unit 半开区间，与浏览器选区一致，禁止落在代理对中间，不做隐式 NFC 转换。

anchor = `{textVersion,start,end,exact,prefix,suffix}`，prefix/suffix 各最多 64 code units，exact 最多 2048。revision 绑定 Markdown、附件 manifest 和 renderer/anchor 版本。服务端根据规范文本校验 substring 与上下文；客户端不能指定任意 selector。重复文本用位置区分，跨行内样式选区仍对应同一规范文本区间；跨不连续块或图片的选择提示重新选择。

v1 不支持对图片像素框选，读者可在图片说明段落发表评论。渲染器升级必须保留旧 anchor 版本的解释方式；无法定位时显示引用与“无法定位”，不猜测另一个段落。重叠但不相同的选区保留独立组，高亮避免覆盖破坏 DOM；用 Range/overlay 或同等非破坏式实现并验证浏览器兼容性。

## 8. 评论读取与 Agent 导出

`GET /api/v1/documents/:id/comments?cursor=...&limit=...` 每页最多 100 条，cursor 绑定 document id、版本和底层分页参数，限制长度并校验，不暴露任意 bucket prefix。对象列表顺序不等于评论时间顺序，UI 按 createdAt/commentId 排列已加载项；有后续页必须显示“仍在加载”，不得把部分数量当总量。

首次打开拉取全部分页；评论成功后刷新；页面可见时建议每 30 秒从第一页执行完整刷新，隐藏时暂停。按 ID 合并，不能仅用时间 watermark 跳过晚到对象。客户端每轮最多读取 1000 条，更多时显式继续加载；这是读取预算，不是已存在评论总数上限。

Agent 导出使用 `threadshare-document-review@v1`，包含文档 revision/title、collectionStartedAt/FinishedAt、complete、hasMore、document URL、每条 comment 的 id/name/time/body/anchor、对应段落上下文和评论定位链接。不暴露 upload/revoke capability、本地绝对路径或存储 key。名字和评论始终正确转义，避免文本伪造章节边界；JSON 为无损权威形式，Agent Markdown 为有明确分隔的阅读形式。

`?format=agent` 或明确优先的 Accept: text/markdown 返回正文和有界 Review，附续页/CLI 指引；默认返回 HTML，canonical API 始终 JSON。HTTP 页面不无限抓完海量评论。CLI reviews 默认在预算内拉完各页；到达预算返回明确 partial/nextCursor，拉取失败返回失败，不静默输出完整标记。

complete 仅表示该次 list traversal 已耗尽，不表示并发提交时的一致快照。文档不可变、已有评论不可变；读取过程中新增评论可能在下一次刷新才出现。撤销或过期时中止后续读取，不以缓存继续交付。v1 不承诺强一致 Review snapshot。

Agent 结果应区分“评论者提出的问题”“原文事实”“Agent 的建议”，引用 commentId。允许归组去重但保留原评论来源，不把多条同名意见称为独立身份投票。图片在导出里保留 alt 和受控附件链接，需要时再按需读取。

## 9. 安全、轻量与兼容

原始 HTML 禁用，Markdown URL 白名单，评论/name 用 textContent；限制解析深度与资源量。CSP 不允许文档脚本执行，链接设置 noreferrer，私有 bucket 不开公开读。正文、评论、附件均检查父文档生命周期并返回 no-store；已被读者保存的内容不承诺可撤回。

页面为独立静态资产，建议首屏 JS+CSS gzip 合计不超过 150 KiB（不含正文/图片），不引入 SPA 框架或 WebSocket。图片不阻塞文字首屏，批注布局对长文按可见区域计算，避免每次滚动重排全部评论。

聊天的 threadshare-history@v1、shares/<uuid>.json、既有链接/API、5 MiB JSON 限制及撤销语义完全保留。新文档采用单独 schema、路径、预算与资产构建；不把 Markdown 伪装为聊天 message，不要求本机 Insights 数据库，不依赖任何项目私有目录。

## 10. 模块归属与影响面

必须修改：CLI command specs/dispatch、新增 document schema/publish/read/review 模块、共享 document service、FC/CF 路由与存储适配、独立 document-viewer 静态构建、发布 allowlist、双语 README/分享使用手册/Skill。

需要验证：聊天 API/Viewer/Agent 协商无回归；FC 静态打包与 Cloudflare assets 路由；Node >=20；上传端流式大小限制；匿名并发写入与幂等；撤销/过期附件保护；npm tarball 实际安装运行，不能只验证源码。

已核实：官方 R2 conditional PUT 与 OSS forbid-overwrite 语义；两适配器的分页、二进制上传和签名测试；本地 Wrangler/R2 的实际 CLI 和浏览器闭环；共享 markdown-it token 流用于锚点。尚未声称完成线上 OSS/FC 探针：这需要实际部署环境、权限及网关配置，属于上线验收，不以模拟测试冒充。部署清理和网关要求见使用手册。

实现模块：`document-model.mjs` 负责公共校验、渲染与跨端锚点；`document-service.mjs` 负责发布、评论与生命周期；`document-command.mjs` 负责本地准备及 CLI；`document-read.mjs` 负责远端读取与 Agent 格式。适配器只承接存储与 HTTP 环境差异。

## 11. 分阶段实施与验收

| 阶段 | 可交付结果 | 必须通过的验收 |
|---|---|---|
| 0：技术穿刺 | 两存储适配器最小闭环、Markdown 选区原型 | 真实条件写入冲突/同 ID 重试；分页；图片请求上限；中文/emoji/重复句/代码/表格锚点；未证明的 provider 行为不进入正式实现 |
| 1：完整快照分享 | CLI 预检、图片上传、publish、独立只读页面 | 缺图/越界/伪 MIME 拒绝；上传失败不可见；重试同一结果；Markdown/图片改动检测；expiry/revoke 包含附件 |
| 2：匿名批注 | 选区、署名记忆、侧栏/移动抽屉、恢复评论 | 多人/多标签页并发不丢；同 ID 同内容幂等/不同内容冲突；错 revision/错 quote 拒绝；刷新去重；大量评论显式分页 |
| 3：Agent Review | canonical JSON、Agent Markdown、CLI read/reviews、URL 协商 | 原文/评论/链接对应；partial 不冒充 complete；评论指令不成为系统指令；分页中撤销/网络失败有正确状态 |
| 4：交付验证 | FC/CF 实测、文档、打包回归 | 两环境端到端同源行为；无数据库部署；孤儿清理实测；桌面/移动/键盘 QA；轻量预算；旧聊天全契约回归；安装包可运行 |

并发验收至少覆盖 20 个独立评论同时写入，最终无丢失；重复提交同一 ID 不增加条数，冲突正文不能覆写。锚点 golden 由浏览器和服务端共同使用。清理测试覆盖 publish 前失败、publish 重试、过期、撤销与在途评论的竞态。

涉及新公开写入端点、持久化与并发语义，实施候选需独立变更审查。设计文档落盘不代表代码完成、线上启用或发布授权。
