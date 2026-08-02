---
status: complete
created: 2026-08-02
baseline: 164a40eb7cbcae62b0dfe3d3afbbfa2a6d816947
---

# Threadshare Agent Transcript 与同链接内容协商

## 目标

让用户继续只分享一个 canonical Viewer URL：

```text
https://cloud-thread.team-harness.com/?id=<uuid>
```

普通浏览器保持现有 Viewer；能够声明 Markdown 偏好的 Agent 从同一 URL 获得低 token、
Markdown-compatible 的 `agent-transcript@v1`。未安装 Threadshare 的 Agent 还可从 HTTP/HTML
alternate 元数据和静态 HTML 注释发现该表示。CLI 将 compact Agent transcript 设为 `read`
的默认输出，同时保留完整 JSON 和现有完整 Markdown。

成功标准不是识别所有 Agent，而是提供标准、确定、可发现的表示选择，并让常见的“用户直接把
Viewer URL 交给 Agent”路径不再要求先理解 canonical JSON。

## 现场

- `GET /api/v1/shares/:id` 是冻结的 canonical JSON 契约；Viewer URL 是 `/?id=<uuid>`。
- Cloudflare Worker 对所有非 `/api/` 请求直接委托 `env.ASSETS.fetch()`；FC handler 对 `/`
  返回打包的 `/index.html`。
- Viewer 是静态 SPA，浏览器随后读取 canonical API；当前 HTML 首屏没有 transcript。
- `threadshare read` 当前强制 `--format <json|markdown>`。JSON 是完整 canonical history；现有
  Markdown 会按原顺序完整展开 tool input/output/error、thought、todo、activity 和 compaction。
- `threadshare-history@v1` 与 legacy Paseo migration shape 的 entry 形状兼容。API/Viewer 可读
  legacy；CLI `read` 有意只接受 canonical history。
- `src/share-read.mjs` 是 CLI 读取与完整 Markdown formatter 的现 owner；`worker.ts` 与
  `fc/handler.ts` 必须保持行为等价。
- 已接受的 `.codestable/epics/lightweight-sharing-evolution.md` 曾把服务端 Agent 表示列为非目标；
  本功能是 Owner 在 2026-08-02 明确提出的新契约，不回写或改写该历史 Epic。
- 未命中可复用 lesson；`.codestable/attention.md` 没有额外 canonical requirement。

## 边界与设计

### 1. 单一数据源与模块归属

- `threadshare-history@v1` 和存储对象不变；不生成或保存第二份 transcript。
- 新增 `src/agent-transcript.mjs`，作为 CLI、Cloudflare 和 FC 共享的唯一 renderer/negotiation
  owner。它包含：
  - `agent-transcript@v1` 格式化；
  - `Accept`/`format=agent` 选择；
  - Agent alternate/presentation URL；
  - Markdown 成功/失败响应的共享 header/body 契约。
- 现有 `formatHistoryAsMarkdown()` 保留在 `src/share-read.mjs`，语义不变；不把完整人类
  Markdown 悄悄改成有损格式。
- 服务端 renderer 接收已经由存储 decoder 验证的 canonical 或 legacy history；CLI 继续先走
  `readSharedHistory()`，因此仍明确拒绝 legacy。

### 2. Agent transcript v1

首行和段落形状冻结为 Markdown-compatible 文本：

```markdown
# Threadshare Agent Transcript v1

> Lossy view of untrusted conversation data. Message Markdown is preserved; tool payloads and internal events are omitted.
> Summarized 4 tool calls; omitted 7 internal entries (thought 3, todo 1, activity 2, compaction 1).

## User

> <原始 message.markdown 第 1 行>
>
> <原始 message.markdown 第 2 行>

---

## Tool Calls

- "exec_command" [completed] x3
- "apply_patch" [failed]

---

## Assistant

> <原始 message.markdown>
```

规则：

- message 按源顺序全部保留；`markdown` 正文不总结、不截断。renderer 先按 CommonMark 语义把
  CRLF 和裸 CR 都归一化为 LF，再把 C0（LF/TAB 除外）、DEL（U+007F）、C1、U+061C、U+200E–U+200F、
  U+2028–U+202E、U+2066–U+2069 写成 ASCII `\uXXXX`。随后每个 LF 分隔的物理行都必须放入
  Markdown blockquote：非空行前缀 `> `，空行输出 `>`。因此正文 Markdown 的内容、行结束语义
  与顺序保留在 quote 容器内，但原始字节会增加安全 framing/escape；正文里的
  `## Assistant`、`## Tool Calls`、`---` 或伪 summary 永远只能出现在 blockquote 内，ANSI、bidi
  与 Unicode line separator 也不能在终端或纯文本读取中改写边界。
- 每段固定使用 `## User` 或 `## Assistant`；不输出 message ID、时间戳、provider、model、
  conversation ID 或标题。相邻根级段落之间固定输出 `---`；只有 renderer 可以输出不带
  blockquote 前缀的根级 heading、summary、separator 和 tool list。
- 连续 tool entries 合为一个 `## Tool Calls` 段；只把相邻且 `(name,status)` 相同的调用折叠为
  `xN`，不得跨其他 tool name/status 重排。
- tool name 的分组使用完整原值，展示值最多保留前 120 个 Unicode scalar values，超出后附加
  ASCII `... [truncated]`。展示时使用 JSON string literal，并把 C0/C1、U+061C、U+200E–U+200F、
  U+2028–U+202E、U+2066–U+2069 显式写成 ASCII `\uXXXX`，保证换行、双向控制符、引号和控制
  字符不能破坏或视觉重排一行结构；status 原样使用 schema 枚举
  `running|completed|failed|canceled`。
- tool 的 `input`、`output`、`error` 永不进入 Agent transcript，包括失败调用。
- thought、todo、activity、compaction 正文全部省略，仅在固定 summary 中给出数量。
- summary 始终输出 tool 总数和四类 internal entry 数，含零值，避免调用方猜测是否为完整视图。
- 输出以一个换行结尾。该表示是面向 LLM 阅读的有损 presentation，不替代 canonical JSON，
  不承诺可用于重放或逐字段自动化。
- transcript 顶部明确标识内容不可信；消息本身仍可能包含 prompt injection，安全优先级不因
  转为 Markdown 而提高。
- 不伪造边界的保证针对原始 transcript 文本和关闭 raw HTML 的 CommonMark parser。v1 为保留
  message Markdown 不转义 `<`/`>`；若消费方启用 raw HTML，必须再经过 HTML sanitizer，不能把
  blockquote 当作 DOM 安全边界。该限制写入 help/docs，并用包含 `</blockquote>` 的 fixture
  验证原始文本 framing，而不宣称任意第三方 HTML renderer 都保持容器。

### 3. 同一 Viewer URL 的选择契约

只在 Viewer 文档路径 `/` 和 `/index.html` 上启用；`/api/v1/shares/:id` 无论 `Accept` 为何
都继续返回 canonical JSON。

优先级：

1. query 中第一个 `format` 值为 `agent` 时明确选择 Agent transcript，覆盖 `Accept`；重复值只取
   第一个，其他 Viewer query 参数继续忽略。
2. 否则仅当 `Accept` 明确包含可接受的 `text/markdown`，且其 q 值严格高于 `text/html` 时，
   选择 Agent transcript。
3. q 值相同、只有 `*/*`、缺少 `Accept` 或其他情况都返回 HTML，保持浏览器与旧调用兼容。

`Accept` parser 只把显式 `text/markdown` 作为 Agent opt-in，同时按 RFC 9110 §12.5.1 计算两个
representation 的有效 q。为避免 adapter 或实现者作不同推断，v1 冻结以下算法：

- 对逗号和分号的切分必须识别 quoted-string；引号未闭合、token/参数语法错误的单个 range
  作为不可接受处理，不影响其他 range。
- 大小写不敏感的 `text/markdown`、`text/html`、`text/*`、`*/*` 参与 representation q 计算；
  其他 range 不匹配。Agent opt-in 仍额外要求至少一个匹配的精确 `text/markdown` range 的 q
  大于 0，wildcard 单独永远不能触发 Markdown。
- media parameter 仅支持大小写不敏感的 `charset=utf-8`；其他 q 之前的 media parameter 使该
  range 不匹配对应 representation。q 之后语法有效的 accept-extension 忽略。
- q 缺省为 1；RFC qvalue grammar 冻结为 `0` 或 `0.` 后 0–3 位数字，以及 `1` 或 `1.` 后 0–3
  个零，因此 `0.`、`0.5`、`1.`、`1.00` 合法，`.5`、`1.001`、大于 1、重复 q 或非数字 q
  都使该 range 的 q 为 0。
- 每个 representation 选择最高 specificity 的匹配范围：精确 type/subtype 高于 `text/*`，后者
  高于 `*/*`；同 specificity 的重复 range 取最高 q。没有匹配 range 时 q 为 0。
- 在存在显式 Markdown opt-in 的前提下，Markdown representation q 必须严格高于 HTML
  representation q；其余情况返回 HTML。因而只有 `text/markdown` 时选择 Markdown；
  `text/markdown;q=0.5,*/*;q=1`、`text/markdown;q=0.5,text/*;q=0.7`、
  `text/markdown;q=0.5,text/html;q=0.5`、`text/markdown;q=.5` 和只有 wildcard 都选择 HTML。

首版不依据 User-Agent、`Sec-Fetch-*` 或 IP 猜测 Agent。

Agent 表示仅支持 GET/HEAD；其他 method 返回 405 Markdown problem，并带 `Allow: GET, HEAD`。
HEAD 执行与 GET 相同的存在性/过期检查并返回相同 status/headers，但成功或失败都没有 body。
显式 Agent 请求缺少、
携带非法或不存在的 share ID，以及过期/撤销对象，都返回同一 404 Markdown problem，不泄露
存在性。存储或 decode 故障返回 500 Markdown problem。API 路径原有 JSON 错误不变。

problem body 精确冻结并都以一个换行结尾：

```text
# Threadshare Agent Transcript v1

Error: Shared conversation was not found.
```

500 将末行替换为 `Error: Unable to load shared conversation.`；405 将末行替换为
`Error: Method not allowed.`，并增加 `Allow: GET, HEAD`。

成功 Agent response：

```http
Content-Type: text/markdown; charset=utf-8
Cache-Control: private, no-store
Vary: Accept
X-Threadshare-Format: agent-transcript@v1
Access-Control-Allow-Origin: *
Access-Control-Expose-Headers: x-threadshare-expires-at, x-threadshare-format
```

设置过期时继续返回 `X-Threadshare-Expires-At`。404/405/500 也必须 `no-store`，保持同一
`Content-Type`、`Vary` 与 format header。源 history 的 5 MiB 创建限制不变；v1 不另行截断
message Markdown，因此不承诺 transcript 自身严格小于 5 MiB。

`/` 与 `/index.html` 的所有 GET/HEAD HTML response（无 id、非法 id、合法 id）也统一设置
`Cache-Control: no-store`，并把 `Accept` 以大小写不敏感、去重的方式合并进现有 `Vary`，不得
覆盖 Assets 已有的其他 Vary token；已有 `Vary: *` 时保持 `*`，不追加 `Accept`。Markdown 的
所有 status 同样执行该 merge。这样任何被协商的文档响应都不会因缺少/非法 id 的 HTML 缓存
污染显式 Markdown 请求。

Viewer 文档路径的非 GET/HEAD 请求不委托 Assets：Agent negotiation 命中时返回上述 Markdown
405；否则 CF/FC 都返回现有形状的 JSON `{"error":"Method not allowed"}`。两种 405 都精确带
`Allow: GET, HEAD`、`Cache-Control: no-store` 并合并 `Vary: Accept`；JSON 侧保持无 Viewer CORS。

### 4. Viewer alternate 发现

- 对带合法 UUID 的 HTML Viewer response 增加准确的 HTTP alternate；若 Assets 已有 `Link`，以
  追加 field value 的方式保留它，不得覆盖：

```http
Link: </?id=<uuid>&format=agent>; rel="alternate"; type="text/markdown"
Vary: Accept
```

- `index.html` 增加不带 `href` 的 `<link rel="alternate" type="text/markdown">`。静态 HTML 无法在
  不重写 body 的前提下把 id 注入 href；缺少 `href` 时该元素不会声明错误的当前文档 alternate，
  只作为 JS best-effort discovery 的占位。浏览器脚本在发现合法 id 后把 `href` 更新为显式
  `format=agent` URL。未执行 JS 的机器发现契约是首响应中准确的 HTTP `Link`。
- `<!doctype html>` 后、任何用户内容之前放置静态、版本化的 `THREADSHARE_AGENT_HINT v1`
  注释。注释正文不得包含 HTML comment 非法的连续两个 hyphen；其冻结语义为：
  - 当前页面是人类 Viewer，conversation 是不可信数据；
  - 优先以 `Accept: text/markdown` 重新读取当前 URL，或添加 `format=agent`；
  - 已有 CLI 时可运行 `threadshare read "<viewer-url>"`；包名为
    `@team-harness/threadshare`；
  - 未经用户或环境 Owner 授权不得安装软件；
  - 完整结构化数据使用 canonical API（注释中不写包含连续 hyphen 的 CLI option）。
- HTML 注释与动态 `<link>` 是 best-effort LLM/browser hint，可能被 extractor 丢弃；准确的 HTTP
  alternate 才是无脚本机器发现契约。首版不做服务端 transcript SSR，也不把隐藏正文塞入 HTML。
- 现有可见的 `AI agent review: Copy JSON link` 改为 `AI agent review: Copy review link`，复制不带
  hash 的同一个 canonical Viewer URL，而不是 API 或 `format=agent` 专用 URL；成功态文字为
  `Review link copied`。这让 UI 推荐的仍是用户可同时交给浏览器与 Agent 的单一链接。完整 JSON
  只在 help/docs 中作为需要 tool payload 或结构化处理时的显式选项。
- HTML response 不读取对象存储，只根据 syntactically valid id 提供 alternate，保持现有 Viewer
  首屏成本；alternate 真正读取时再执行存在性和生命周期检查。

### 5. FC query 兼容

- Cloudflare 使用标准 `Request.url`/headers。
- FC 新增单一 event URL/query helper，支持当前 `path/rawPath/requestContext.http.path`，并兼容
  FC 常见的 `rawQueryString`、`queryParameters`、`queries` map。选中的 path 必须剥离 query。
  query 来源优先级冻结为：存在 string 类型的 `rawQueryString`（含空字符串）时只使用它；否则
  使用 object 类型 `queryParameters`；否则使用 object 类型 `queries`；最后才使用选中 path 自带
  的 query suffix。高优先级来源存在时忽略低优先级冲突值。raw query 的重复 key 和 map 的
  string/array 值都只取第一个字符串；非字符串值忽略。所有来源最终通过同一个 URLSearchParams
  语义解码，冲突/重复 fixture 必须覆盖。
- FC 的 `Accept` 专用读取 helper 必须收集所有大小写不敏感的同名 header；string 值直接加入，
  array 值按顺序加入其中全部 string 成员，最后以逗号合并后交共享 parser。其他现有 header
  继续保持首个字符串语义。这样 FC list-valued Accept 与 Cloudflare `Headers.get()` 的合并行为
  对等。
- `format=agent`、Accept、HTML Link、GET/HEAD、404/405/500、expiration header 在 CF/FC 中逐项
  对等测试；adapter 不各写一套 renderer 或协商规则。

### 6. CLI 契约

```text
threadshare read <share-url>                         # 默认 agent
threadshare read <share-url> --format agent          # 显式 compact transcript
threadshare read <share-url> --format markdown       # 现有完整 Markdown
threadshare read <share-url> --format json           # 完整 canonical JSON
```

- 缺少 `--format` 从当前 `TS_USAGE_OPTION_DEPENDENCY` 失败改为成功输出 agent transcript，是有意的
  向后兼容扩展；已有显式 JSON/Markdown 调用不变。
- 非法 format 返回现有 `TS_USAGE_INVALID_VALUE`，Problem/Next 明确列出 agent/json/markdown。
- 官方 Viewer Agent alternate `/?id=<uuid>&format=agent` 是合法 CLI 输入；`src/share-url.mjs` 仅在
  Viewer URL 上允许唯一 `id` 加可选且唯一、值严格为 `agent` 的 `format`，解析后仍下载 canonical
  API。API URL 继续拒绝任何 query，Viewer 继续拒绝其他、重复参数和 URL 中的 capability。
- CLI 继续从 canonical API 下载、执行禁止重定向、5 MiB 限制和 schema 复验，再本地调用共享
  renderer；不依赖目标服务已升级，避免新 CLI 无法读取旧自托管 Threadshare。
- `threadshare read --help`、README 双语和 bundled Skill 将 agent 设为 review/上下文理解的默认；
  只有需要完整字段、tool payload 或程序化处理时才推荐 JSON，完整人类审阅仍可选 Markdown。

### 7. 兼容性、非目标与有界简化

- 不修改 history schema、POST、canonical GET、对象 key、生命周期、revoke 或 Viewer 渲染安全。
- 不发布 npm、不部署 Cloudflare/FC、不创建 release；这些需要独立授权。
- 不做 UA Agent 名单、自动安装 CLI、服务端 SSR、token 估算、按 token budget 截断或 tool payload
  摘要。
- 首版的已知上限：删除 HTML comments/headers 且始终请求 HTML 的零接入 Agent 仍只得到 SPA。
  升级触发是主流目标 Agent 实测无法发现 alternate；升级方向是语义化服务端首屏，而不是扩充
  User-Agent 猜测列表。
- Agent transcript 会保留全部 message Markdown，因此超长纯消息会话仍可能消耗大量 token；出现
  实际 review 超限证据后，再单独设计显式 budget/range，而不在 v1 静默截断。

## 影响面

### 必须修改

- 新增 `src/agent-transcript.mjs`：共享 renderer、negotiation、URL/header/problem 契约。
- `worker.ts`：Viewer negotiation、R2 读取/生命周期复用、HTML Link header。
- `wrangler.jsonc`：使用 `assets.run_worker_first: true`，保证 `/`、`/index.html` 与既有 `/api/*`
  在静态 Assets 前进入 Worker；其他请求由 Worker 立即委托 `env.ASSETS.fetch()`。数组路由无法阻止
  Assets 对 `/index.html` 的预先 307，因此不能满足冻结契约。
- `fc/handler.ts`：event query、Viewer negotiation、OSS 读取/生命周期复用、HTML Link header。
- `bin/threadshare.mjs`、`src/cli-contract.mjs`：read 默认 agent 和第三种 format。
- `index.html`、`app.js`：alternate 元数据、静态 Agent hint、运行时显式 href，以及可见 review
  copy link 从 API JSON 改为同一个 canonical Viewer URL；同步更新 aria-label、title，并把
  `data-history-json-url` 改为语义准确的 review URL 属性。
- `README.md`、`README.zh-CN.md`、`skills/threadshare/SKILL.md`、`AGENTS.md`：公开契约与维护归属；
  `AGENTS.md` 的精确发布清单数字同步从 17 改为 18。
- `package.json`、`scripts/verify-release.mjs`、`test/release-automation.test.mjs`：打包新共享模块，
  精确 allowlist 从 17 变为 18。
- tests：共享 formatter/negotiation、CLI、Worker、FC、静态 HTML hint。

### 需要验证

- canonical API headers/body、legacy migration、expiration/lazy delete/revoke 不回归。
- Cloudflare build 与 FC bundle 都能消费同一个 `.mjs` module。
- Viewer 默认 HTML、静态资源、deep link 和现有 JS JSON fetch 不回归；只改变既有 review copy
  link 的文字与复制目标，不改变布局结构。
- `npm test`、`npm run build:cloudflare`、`npm run validate:skill`、npm 12 dry-run pack 精确 18 文件；
  tarball 隔离安装后的默认/三种 read format。

### 仍待调查

- FC 生产事件究竟使用 `queries`、`queryParameters` 还是 `rawQueryString`；实现按兼容集合读取，
  review 后用本地等价测试覆盖所有形状，真实部署不在本任务授权范围。
- Cloudflare Assets binding 的 HTML response headers；实现只 clone stream/headers，不读取或重写
  HTML body，并通过 Worker 测试冻结 Link/Vary/no-store 行为。

## 证据计划

- TDD：先写 formatter golden/负向泄漏测试，确保 message Markdown/顺序在 blockquote framing 中
  保留，且 unique tool input/output/error、thought/todo/activity/compaction 正文完全不出现。
- TDD：加入伪造 `## Assistant`、`## Tool Calls`、summary、`---`、`</blockquote>` 的对抗消息，
  CRLF/裸 CR/LF/ANSI/bidi/Unicode line separator，以及超长与 bidi tool name；断言归一化后只有
  renderer 产生根级结构、终端控制符不原样出现且 tool 行有界。
- 体积证据使用 UTF-8 byte length，避免新增 tokenizer 依赖：tool-heavy fixture 至少包含三个各自
  带 4 KiB unique input/output/error 的调用和短消息，Agent transcript 必须同时小于 canonical
  JSON 与完整 Markdown 的 20%；message-heavy fixture 不设虚假节省门槛，只验证正文无截断。
- 语义 fixture 固定覆盖“用户请求 → assistant 计划 → tool 成功/失败摘要 → assistant 结论”，断言
  全部 message、相对顺序和 tool name/status/count 可用于 review，同时明确 payload 证据需回退 JSON。
- TDD：按冻结算法覆盖 Accept 大小写、quoted-string、charset、exact/wildcard specificity、重复
  range、qvalue grammar、非法/重复 q、query override、browser Accept 默认 HTML、FC Accept 数组，
  以及普通/`*` Vary 合并。
- TDD：真实 CLI 子进程默认 agent、显式三格式、invalid format stable code；`parseShareReference`
  正向接受唯一 `id` 加唯一 `format=agent`，并反向拒绝其他 format、重复 format、额外 query key
  和 capability query。
- TDD：CF 与 FC 对相同 history 的 transcript body/headers 完全一致；404、405、expired、HEAD、legacy、
  HTML Link 逐项对等。
- Cloudflare 路由门禁：使用 Wrangler test harness 读取真实 `wrangler.jsonc` 与构建后的 Assets，
  证明 `/`、`/index.html` 先进入 User Worker，而 hashed 静态资源仍由 Assets 正常提供；同时验证
  canonical API 在 Markdown Accept 下仍返回 JSON。
- 静态检查：index comment 和 rel alternate 存在，注释不含连续 hyphen、自动安装命令且明确授权
  边界。alternate 与 canonical Viewer URL 构造归共享纯 helper，并用 Node 单测冻结 HTTP Link、
  运行时 href 和 review copy link 的 URL 结果；DOM 层的可见文字、aria-label、title、复制成功态与
  clipboard 行为不引入新的 DOM 测试依赖，改由真实浏览器 smoke 验证。
- 回归：API/Viewer/release/FC 全量测试、Cloudflare 独立 build、Skill validation；使用 Node
  `22.22.3`、npm `12.0.2` 执行 `npm pack --dry-run --ignore-scripts --json`，记录精确 18-file
  清单与 integrity，再做临时 prefix tarball 安装；另用临时输出目录执行
  `wrangler deploy --dry-run --outdir <temp>`，只验证 Worker bundle，不部署或写仓库生成物。
- 实测：本地 dev/Worker 请求 `Accept: text/html`、`Accept: text/markdown`、`format=agent`；CLI
  读取同一 mock/本地 share。由于只改既有链接文案/目标而不改布局结构，不要求新增视觉设计；
  仍以现有 Viewer 测试和浏览器 smoke 验证 copy、console、deep link 与移动/桌面文字不溢出。

## 验收标准

- 用户分享同一个 Viewer URL；浏览器/default Accept 获得 HTML，显式 Markdown Accept 或
  `format=agent` 获得 `agent-transcript@v1`。
- Agent transcript 在原始文本不可伪造的 blockquote framing 中保留全部 User/Assistant Markdown 语义和
  相对顺序；tool 只保留有界安全显示的 name/status/相邻 count，任何 tool payload 与 internal
  entry 正文均不出现，并明确声明有损/不可信。
- canonical API、history schema、5 MiB、过期/撤销和双云存储契约无变化。
- HTML response 提供准确 HTTP Link，以及明确为 JS/best-effort 的 HTML rel alternate 和静态
  Agent hint；hint 不诱导 Agent 未经授权安装软件；可见 review link 复制同一个 Viewer URL；
  所有协商文档与 405 都 no-store、正确合并 Vary，405 带 Allow。
- `threadshare read <url>` 默认 compact transcript；`--format agent|json|markdown` 三种明确可用，
  旧显式 JSON/Markdown 输出不变。
- CF 与 FC 对 Agent GET/HEAD、成功/404/405/500/expired/legacy、headers/body 行为等价。
- 所有证据计划中的自动化门禁通过，npm 包只增加共享 renderer 一个生产文件。

## 状态与未决

- 当前：实现、本地验证与 change review 均已完成，候选可提交。尚未 commit、push、发布 npm 或
  部署 Cloudflare/FC。
- Owner 已确认的方向：单 Viewer URL、Accept Markdown、`format=agent` fallback、HTTP/HTML
  alternate、顶部 Agent 注释、CLI 默认 compact transcript；首版不做重型 SSR。
- Round 1 design review（冻结 SHA-256
  `8c5500933c2ae42d71fd7015c10a804fa238a1696337141b93fc105e06a6c076`）结论为 2 Blocking / 5
  Important；本轮已按 findings 修订，尚未修改生产代码、测试、其他文档或打包配置。
- Round 2 design review（冻结 SHA-256
  `88d9bfd8ae955fdf83b64b2646b26c4003ab92deef53a4f3d705546a2e4d3830`）结论为 1 Blocking / 3
  Important；本轮已按 findings 修订，并补入现有 Viewer review link 的遗漏影响面。
- Round 3 design review（冻结 SHA-256
  `639e1533f2c943195dc578c50e7694bc96f0e2c9807990e50d0d7612c3c00042`）结论为 0 Blocking / 1
  Important；唯一 Important 是复制链接自动化证据与现有无 DOM harness 的矛盾，已收敛为共享纯
  helper 单测加真实浏览器 smoke，不改变产品契约。其余 share URL、无障碍文字与数据属性 Nit 已
  纳入实现范围；同一 design review 阶段已达三轮上限，不再新增审查轮。
- 已实现共享 `agent-transcript@v1` renderer、严格 Accept 协商、Viewer alternate/hint、CLI 默认
  agent 格式，以及 Cloudflare/FC 等价的 GET/HEAD/404/405/500 行为；canonical API、存储格式与
  5 MiB 创建/读取限制未改。
- Change review Round 1（冻结 staged diff SHA-256
  `a353b64ebcc66986efeb98f59582bc18f9a0be1fa5531058edd0869f41c1290f`）结论为 1 Blocking / 3
  Important / 6 Nit。已处理全部 Blocking/Important：Cloudflare 配置改为
  `assets.run_worker_first: true`，Worker 将 `/index.html` 的内部 Assets 读取规范化到 `/`；新增真实
  Wrangler test harness 路由门禁，并以 `wrangler dev` HTTP smoke 复验 root/index/API/405/assets；
  静态 alternate 改为无 `href`、JS 再补齐；Accept parser 接受 q 后 bare extension；删除读取
  `app.js` 字面量冒充行为覆盖的测试。其余 Nit 不改变正确性或安全契约，留给 reviewer 复核。
- Change review Round 2（冻结 staged diff SHA-256
  `a151c5635bbbaae2645253d6bff64e3e76908eb81d7eb7a554f8db8ba491d9a4`）结论为可合：Round 1 的
  1 Blocking / 3 Important 全部 resolved；本轮新增 0 Blocking / 0 Important / 4 Nit。reviewer
  独立复验真实 `wrangler dev` 路由、28 组 Accept、2400 组 CF/FC 差分、share URL 解析与最终
  pack integrity，未发现新的正确性、安全或双适配器等价问题。
- 自动化证据：`npm test` 全部通过（CLI 105、Viewer 3、API 32、Release 8、FC/Cloudflare routing
  19）；
  `git diff --check`、修改后的 JavaScript `node --check`、`npm run validate:skill` 均通过；
  Cloudflare build 由完整测试覆盖，另以仓库 `wrangler.jsonc` 执行 `wrangler deploy --dry-run`
  成功。首次未显式指定 config 的 dry-run 被本机陈旧 `.wrangler/deploy/config.json` 重定向挡住，
  显式使用 canonical config 后通过，未部署。
- 使用 Node `22.22.3` 与 npm `12.0.2` 生成最终 dry-run/真实 tarball：精确 18 个文件，integrity
  为 `sha512-ss8ICrDYfdz1rW9YxXVtP2u0Mtq31m0hArTDXTxAhWIGY58Poc55MlewYEiZZ7mR8awZZNb+GQ+xAAFXjSqQjw==`；
  最终 tarball 已在临时 prefix 隔离安装，包内 `threadshare read --help` 正确展示默认 agent 与
  `agent|json|markdown` 三种格式。
- 浏览器 smoke 已覆盖桌面与 390px 移动端：无溢出，动态 alternate、canonical review URL、
  mock clipboard 成功态均正确，未出现应用 console error；I1 修复后另用真实 DOM 确认静态无
  `href` 的 alternate 在合法 id 上被 JS 补为同源 `format=agent` URL。
- 遗留仅为非阻塞维护成本：`run_worker_first: true` 使静态资源也经过 Worker；Cloudflare 路由门禁
  随 `test:fc` 运行；Wrangler harness 使用 pin 住的 unstable API；首次真实部署后仍建议线上 smoke。
- 毕业清单：公开契约已进入 `AGENTS.md`、README 双语与 bundled Skill；机器门禁进入共享 renderer
  测试、CLI/API/Worker/FC 测试和真实 Wrangler routing test；没有需要新建 lesson 的跨项目结论。
  仓库没有既定的永久 feature 归档位置，因此按 `cs-feat` 保留本 work 文档，待 Owner 决定后续归宿。
