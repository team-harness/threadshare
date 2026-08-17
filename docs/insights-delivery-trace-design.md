# Insights Delivery Trace 设计

状态：Accepted；Stage 0–4 已实现；25k 正式 evidence 已归档；250k 延期

日期：2026-08-16

适用范围：本机 Threadshare Insights；不改变云端 share、Viewer、`threadshare-history@v1` 或 npm 平台支持范围

关联决策：

- [ADR-0001：Local Insights 使用持久事务投影](adr/0001-local-insights-persistent-projection-architecture.md)
- [ADR-0002：Insights 性能演进必须由证据门控](adr/0002-evidence-gated-insights-performance-evolution.md)
- [ADR-0003：Delivery Trace 是 Agent 与 Dashboard 共享的 snapshot-bound evidence graph](adr/0003-insights-delivery-trace-evidence-graph.md)
- [Local Insights Deep Query 设计](insights-deep-query-design.md)

设计输入包括 Better Harness Inspector 的 Feature/Date 工作台、Session Replay、Tool 泳道、Commit/File 关联和 evidence limitation 模型。Threadshare 采纳其交互与认识论约束，不依赖其包、文件格式或一次性 HTML runtime。

## 1. 决策摘要

Delivery Trace 把 Threadshare 已索引的完整 Agent 历史与新的本地 Git/Intent 证据连接为一个可查询的交付证据图：

```text
Intent -> Session -> Turn -> Capability Use -> File -> Git Commit
            |          |              |
            |          +-> Error/Retry/Result
            +-> Provider lifecycle and complete evidence
```

它有两个平等的消费端：

1. Agent 通过 `threadshare_insights_spec` 选择 `delivery-trace@1`，再按需读取完整 Evidence；用户只需要提出自然语言问题。
2. Dashboard 的 `Insights Inspector` 用同一响应展示 Intent/Date 导航、Prompt/Activity/Delivery 三栏、Session Replay、选择联动和证据抽屉。

Agent 或 Dashboard 选中 Commit 后，可以按需读取该 Commit、指定 parent 或指定 path 的实际文本 diff；sync 不批量生成完整 diff。若仓库配置了 GitHub/GitLab web mapping，还可以在用户手势下打开对应 SCM Commit 页面。

关联规则、排序、coverage、snapshot 和 cursor 都由 Rust Engine 拥有。Node、MCP 和浏览器只做白名单映射与展示。

## 2. 目标与非目标

### 2.1 目标

- 回答“一个需求由哪些 Session、Tool、文件和 Commit 交付，为什么相信这些关联”。
- 回答“失败到成功之间发生了什么，最终哪个变更或 Commit 结束了尝试链”。
- 发现 intent 无交付、Commit 无 Session 证据、Session 无最终交付等 evidence gap。
- 让人和 Agent 在同一 snapshot 上逐层展开，不靠查询时扫描或前端猜测。
- 生成有界、只读、明确边界的 continuation context，帮助新 Agent 接手工作。

### 2.2 非目标

- 不自动恢复或继续原生 Codex、Claude 或其他 Provider Session。
- 不修改工作区、Git refs、index、commit、branch、issue 或产品计划。
- 不把候选关联提升为作者身份、因果关系或代码行归属。
- v1 不访问网络 Issue Tracker，不抓取 GitHub/GitLab 数据，不解析源代码语义。
- v1 不提供任意图查询语言、Cypher、SQL、JSONPath 或自定义关联规则。

## 3. 从 Better Harness Inspector 采纳什么

### 3.1 采纳

- `Intent` 与 `Date` 两种入口，共用同一底层 evidence，不把导航状态冒充证据强度。
- Prompt、normalized activity、Commit/File 同屏，选择任一对象会联动相关对象。
- 每条关系显示 evidence source、facts、strength 和 limitations。
- Session Trace/Replay 保留 observed time；缺时间时只表达 sequence，不制造 wall-clock 顺序。
- Continuation context 明确声明只读边界和证据缺口。

### 3.2 不采纳

- 不以“扫描当前仓库 + 最近 30 天/100 Session/200 Commit + 生成 HTML”作为主运行时。
- 不把安全裁剪后的 report projection 当作事实源；本地 Insights 保留完整 payload，UI 按需 hydration。
- 不让前端实现 Story/Session/Commit correlation。
- 不强制仓库存在 Feature Tree。
- 不让静态 HTML export 决定公共协议；export 若实现，是 Trace response 的下游。

## 4. 架构边界

```text
Provider Session adapters       GitRepositorySource       IntentSourceV1 adapters
            |                           |                         |
            +------------- sync/reindex staging ----------------+
                                        |
                            one committed SQLite snapshot
                                        |
             history facts + repository facts + intent facts + trace projection
                                        |
                      LocalInsightsQuery / delivery-trace@1
                               /                         \
                  Agent CLI/MCP                    Insights Inspector
```

### 4.1 模块所有权

| 责任 | 建议 owner |
|---|---|
| Git 只读发现、repo identity、commit/file delta | `src/insights-repository-source.mjs` |
| 单 Commit/path diff Evidence 与 SCM URL | `src/insights-git-evidence.mjs`、`src/insights-scm-links.mjs` |
| Intent adapter、Markdown tree、显式 refs | `src/insights-intent-source.mjs` |
| repository/intent Fact wire 构造 | `src/insights-trace-facts.mjs` 的独立 `TraceSourceDeltaV1` owner |
| SQLite schema、投影、edge classifier、Trace Query | `crates/insights-engine/src/delivery_trace.rs` |
| protocol DTO 与白名单验证 | Rust `protocol.rs` + `src/insights-engine-protocol.mjs` |
| Agent spec/Recipe 路由 | `src/insights-agent-spec.mjs`、`src/insights-query.mjs`、`src/insights-mcp.mjs` |
| 本地 HTTP 映射 | `src/insights-dashboard.mjs`、`src/insights-dashboard-server.mjs` |
| 浏览器交互 | `src/insights-dashboard/`，构建后同步 `insights-dashboard/` |

模块名可在实现设计中调整，但责任不能回流到浏览器或形成第二个 query data plane。

## 5. Trace domain contract

### 5.1 Node

`TraceNodeV1` 是轻量、可分页、可稳定引用的节点：

```json
{
  "kind": "session",
  "key": "64-hex-stable-key",
  "revision": "64-hex-revision",
  "label": "bounded display label",
  "observedAt": "2026-08-16T02:00:00.000Z",
  "attributes": {}
}
```

v1 node kind：

| kind | identity |
|---|---|
| `intent` | source key + adapter-owned stable intent id |
| `repository` | config-persisted repository id 经 origin secret 派生的 stable key |
| `session` / `turn` / `capability-use` | 复用现有 stable key |
| `file` | repository key + lexical normalized repository-relative path |
| `git-commit` | repository key + full object hash |

`attributes` 必须按 kind 使用严格 schema，禁止任意 provider JSON 混入轻量节点。完整消息、Tool payload、错误或 diff 通过 Evidence 分页读取。

### 5.2 Edge

```json
{
  "relation": "session-correlates-commit",
  "from": { "kind": "session", "key": "..." },
  "to": { "kind": "git-commit", "key": "..." },
  "strength": "observed",
  "source": "ordered-exact-path-overlap",
  "facts": [
    { "kind": "exact-path-overlap", "count": "3" },
    { "kind": "within-observed-commit-window" }
  ],
  "limitations": ["not-authorship", "not-exclusive-line-attribution"],
  "revision": "64-hex-revision"
}
```

Canonical contract 存 typed fact 和 limitation code，不把英文解释字符串作为事实身份。Node、CLI 与 UI 可从 versioned code 渲染友好文案。

### 5.3 Relation

v1 关系分两类：

- Recorded：`intent-declares-session`、`intent-declares-commit`、`session-contains-turn`、`turn-contains-capability-use`、`session-touched-file`、`commit-changed-file`、`session-observed-commit`、`turn-observed-commit`。
- Derived：`session-correlates-commit`、`turn-correlates-commit`、`intent-correlates-session`、`contextual-same-file`。

Recorded relation 仍需说明来源；Derived relation 必须包含可复算 facts 与 limitation。`contextual-same-file` 永远不能作为 Agent 的默认结论依据。

## 6. Evidence strength 与关联规则

### 6.1 Strength

| strength | 可接受依据 | Agent 默认行为 |
|---|---|---|
| `direct` | 显式 intent ref；观察到 Git commit 命令并从 result 解析出完整 hash | 可陈述“显式关联/观察到提交” |
| `observed` | 成功 Git commit result 中的短 hash 在同仓库唯一解析；或精确 repo-relative path + 有界事件顺序 + commit 窗口 | 可陈述“观察到相关证据”，不得称作者身份 |
| `candidate` | 唯一的有界文本重合或弱时间/路径组合 | 默认不进入结论，只在要求候选时返回 |
| `contextual` | 同文件历史、相邻日期、共同仓库 | 只作导航背景 |

### 6.2 Session-to-Commit

1. Tool result 中记录完整 Commit hash时，生成 `session-observed-commit/direct`；普通成功 `git commit` result 中的短 hash 只有在当前注册仓库唯一解析且 Commit reachable 时，才生成 `session-correlates-commit/observed`。Agent 不需要采用指定的 commit 命令。同一个观察结果同时按记录该结果的 Turn 生成 `turn-observed-commit/direct` 与 `turn-correlates-commit/observed`：Session 级归属只回答“哪一段工作产出了这个 Commit”，Turn 级归属才能区分落地的那次尝试与它之前的失败尝试。两级边共用同一份 observed Git 结果，不新增 Git 读取，也不改变 strength 规则。
2. 对已直接观察的相邻 Commit，只有发生在“上一直接 Commit 之后、当前 Commit 之前”的文件写操作才能贡献当前关联。
3. 文件必须使用同 repository identity 下的 lexical relative path 精确相等；basename、suffix 或 absolute-path 字符串相似不算 exact。
4. invocation 只代表 attempted action；只有 result 或 Git object 提供的事实才能提升完成状态。
5. 路径重合、时间重合和 cwd 位于仓库内不能单独证明 authoring。
6. Turn 级交付归属按该 Turn 自己的边分四类读：有 `turn-observed-commit` 为 `direct`；只有 `turn-correlates-commit` 为 `observed`；被一个**当前可读**的注册仓库覆盖却没有任何交付边为 `noDelivery`；其余为 `uncovered`。"当前可读"取 repository source 最近一次扫描的 `available`：降级快照保留旧 refs 却不带 commit，其下的 Turn 不可能获得交付边，把它们读成 `noDelivery` 等于对没人能看的仓库断言"这条路径不交付东西"。因此 `available` 描述的是最近一次扫描而不是 Turn 发生的时刻，仓库恢复可读后这些计数会从 `uncovered` 移回 `noDelivery` 或交付类 —— 这正是 Derived 关系可复算的含义，读计数的人必须知道它随扫描状态变化。已经观察到的交付边不受影响：那次观察发生过，之后失去读取权限并不能取消它。

### 6.3 Intent-to-Delivery

- Intent 中显式 session/commit ref 为 direct。
- Intent 声明 Commit，而 Commit 只有 candidate Session 时，不得把间接链整体提升为 direct。
- 无 ref 时可产生 candidate text-overlap，但必须至少两个 significant terms、唯一最高分且有固定 analyzer version。
- UI 默认分区显示 candidate；Agent 默认 `includeCandidateEdges:false`。

### 6.4 Git history mutation

- Commit hash 对象不可变；`reachable` 是每次 sync 观察到的状态，不是 identity。
- rebase/amend 后，旧 Commit 若曾被 Session 或 Intent 引用，保留为 unreachable evidence，不物理删除。
- default Trace 聚焦当前 reachable history，同时以 coverage 报告被排除的 historical/unreachable 数量。
- 一次 Git sync 记录开始和结束的 ref digest；发生漂移时整 repo batch 回滚并有界重试，不能提交混合代历史。

## 7. Repository evidence source

### 7.1 注册与作用域

Repository source 必须显式注册，避免全局 Insights 自动执行每个历史 cwd 下的 Git：

```text
threadshare insights sync --repository .
```

具体 option 名由 CLI contract 实现阶段冻结。语义必须保持：

- 注册 lexical path 对应的 Git common directory；worktree 共享同 repository identity。
- 注册时生成 opaque repository id 并保存在 Insights config，而不是只存在可重建数据库中；reindex 与 root locator 更新不得改变 repository key。
- 没有 `--repository` 的第一次 sync 不遍历 `$HOME`、`~/work` 或历史 Session cwd 来发现 Git 仓库；显式注册是进入 repository evidence scope 的唯一入口。
- 后续普通 `sync` 更新已注册 repository；`reindex` 重建已注册 source。
- Trace 查询缺 repository evidence 时返回 coverage/diagnostic，并由 Agent 建议用户执行一次显式 sync；查询本身不隐式注册或扫描。
- source 删除或路径迁移不删除历史 commit facts，只把 source 状态标记为 unavailable。

### 7.2 增量扫描与预算

首次注册先从现有 indexed Session 计算该 repository 的 observed time coverage，再枚举相交 Commit metadata；用户可以显式给出更窄或更宽的 `--since`。没有 Session coverage 且没有显式 window 时不扫描全部历史，而是返回需要范围的诊断。

Repository source 保存完整 ref-name -> object-id map 与 canonical digest：

```text
refs unchanged -> skip
fast-forward -> enumerate new tip excluding previous tip
rebase/force update -> enumerate added and removed affected regions
deleted ref -> recompute reachability only for affected known commits
```

一次 source transaction 有独立的 commit、changed-path、walk-depth 和 canonical-byte budgets。超限返回稳定 too-broad diagnostic 并保留上一个完整 repository snapshot，不保存部分 ref map。Repository scanner 默认串行，避免与 Provider backfill 形成嵌套磁盘并发。

### 7.3 只读 Git 边界

- 只允许 plumbing/read-only 命令，并设置 `GIT_OPTIONAL_LOCKS=0`、关闭 pager、external diff 与 textconv。
- 不运行 hooks，不 checkout，不 fetch，不访问 network，不刷新 index，不创建 refs 或 lock file。
- v1 读取 commit identity、parents、author/committer time、bounded summary、tree identity、changed paths、rename endpoints 和行数统计；不索引完整 blob/diff 内容。
- Git stderr、路径和 commit summary 属本地 evidence，可被完整 Evidence 返回；轻量 protocol 仍受响应字节限制。

### 7.4 SCM web mapping

Repository registration 可选择一个 canonical remote。`origin` 只有在能无歧义、安全解析时才可作为默认建议；多 remote、self-hosted GitHub Enterprise 或 GitLab Self-Managed 必须允许显式选择 `remoteName`、`scmKind` 和 `webBaseUrl`。

支持的 recorded remote 输入包括 HTTPS、`ssh://` 和 SCP-like SSH。持久化前必须删除 userinfo、credential、query、fragment 和 `.git` suffix；`file://`、本地路径、含密码/token 的 URL 或未知 provider 不生成外链。

Public response 使用严格字段：

```json
{
  "scm": {
    "kind": "github",
    "webBaseUrl": "https://github.com",
    "repositoryPath": "team-harness/threadshare",
    "availability": "not-verified"
  },
  "externalLinks": {
    "commit": "https://github.com/team-harness/threadshare/commit/<full-hash>"
  }
}
```

GitHub/GitLab Commit 页面本身展示 commit metadata、changed files 和 diff；Compare 链接只在 adapter 对 parent/base 语义有明确版本化规则时提供。相关官方契约：[GitHub comparing commits](https://docs.github.com/en/pull-requests/how-tos/commit-changes/comparing-commits)、[GitLab commits](https://docs.gitlab.com/user/project/repository/commits/)、[GitLab compare revisions](https://docs.gitlab.com/user/project/repository/compare_revisions/)。

Threadshare 不发 HTTP HEAD/GET 验证链接，不读取浏览器登录态。私有仓库依赖用户在浏览器中已有权限；未 push Commit 可能 404。Dashboard 使用新 tab、`rel="noopener noreferrer"` 和既有 `Referrer-Policy: no-referrer`，Agent API 只返回 URL，不自动打开。

### 7.5 按需 Git diff Evidence

Trace response 只保存 commit parents、changed-file manifest、rename 和 line statistics。选中 Commit 后，Agent/Dashboard 可请求：

```json
{
  "target": { "kind": "git-commit", "key": "commit-node-key", "revision": "..." },
  "view": "diff",
  "parentHash": "full-parent-hash",
  "paths": ["src/query.rs"],
  "cursor": null
}
```

读取规则：

- 单 parent Commit 默认使用唯一 parent；root Commit 使用 empty tree；merge Commit 必须显式选择 parent，禁止静默选择 first parent。
- path 必须来自已提交的 `git_commit_files` manifest，按 repository-relative exact path 过滤；不能传任意 pathspec 访问工作区。
- adapter 只读取指定 commit/parent object，固定 `--no-ext-diff`、`--no-textconv`、diff algorithm、context 行数和 rename 规则；不运行 hooks、filters 或 network。
- 文本 patch 流式返回；binary 只返回 metadata，不返回 blob。单响应继续受 4 MiB frame 限制，cursor 绑定 repository key、commit、parent、paths、format version、content digest 和 byte offset。
- object 不存在、repo unavailable、revision 漂移或输出超预算时 fail-closed；可同时返回 `externalLinks.commit` 作为用户手动 fallback，但不能把链接可用性当作成功证据。

Diff Evidence 是显式单对象 hydration，不参与候选选择和关系计算。实现可以使用 mode `0600` 的有界 TEMP spool 计算 digest 与分页；不得写入 active Insights DB，也不得形成隐式持久缓存。

## 8. IntentSourceV1

Intent 是可选事实源，不是 Trace 可用性的前置条件。

```text
IntentSourceV1
  sourceKey
  adapterVersion
  revision
  nodes[] { id, parentId, kind, title, status, refs }
  diagnostics[]
```

v1 首个适配器可接受仓库内显式配置的 Markdown checklist：两空格层级、`- [ ]`/`- [x]` 状态、可选稳定 `{#id}`，内部节点为 feature、叶子为 story。Refs 支持 spec、session、commit、issue locator；只有 session/commit 的可验证 ref 参与 direct edge。

Intent adapter 必须：

- line-local 报告缩进、重复 id 和 malformed ref；
- 使用 repository-relative locator；
- 不联网补全 issue；
- 不因解析部分失败丢弃整个 repository trace，coverage 显示 partial；
- 不把 generated title id 冒充跨重命名稳定 identity。

## 9. SQLite 与 projection

建议逻辑表：

| 表 | 责任 |
|---|---|
| `repository_sources` | 注册 source、repository key、ref digest、sync state |
| `git_commits` | immutable object facts + observed reachability |
| `git_commit_files` | changed path、rename from/to、change kind、line counts |
| `intent_sources` / `intent_nodes` / `intent_refs` | versioned intent adapter output |
| `delivery_trace_edges` | Recorded/Derived typed edges 与 revision |
| `delivery_trace_edge_facts` | 可索引、可复算的 typed evidence facts |

推荐索引由 25k EXPLAIN 决定，初始候选包括：

```text
git_commits(repository_key, committed_at, commit_hash)
git_commit_files(repository_key, normalized_path, commit_hash)
intent_refs(ref_kind, ref_value, intent_key)
delivery_trace_edges(from_kind, from_key, strength, relation, to_key)
delivery_trace_edges(to_kind, to_key, strength, relation, from_key)
```

Repository/Intent batch 使用 TEMP staging、canonical digest 和单事务 apply。Edge projection 与 source facts 在同一事务更新 snapshot；崩溃、超限或 source drift 时不得暴露半个 graph。

Repository/Intent 不伪装成 Session，也不扩展 `SessionFactsDeltaV1`。Node 生成独立 `TraceSourceDeltaV1`，包含 `sourceKind`、`sourceKey`、`sourceRevision`、counts 和严格 collection；Engine 使用独立的 bounded begin/upsert/commit frames，但复用现有 TEMP staging、digest、receipt 与 ACK-loss 幂等机制。

Projection identity 单独版本化，例如 `delivery-graph@1`；Recipe identity 为 `delivery-trace@1`，两条版本轴不得合并。升级走 candidate shadow rebuild，不在 active 表原地混写新旧 edge 语义。

## 10. Query 与 Recipe contract

### 10.1 Low-level resource

Deep Query 新增 `delivery-edge` resource，用于类型化 records/aggregate；不开放任意图遍历。

可过滤字段：repositoryKey、projectKey、intentKey、sessionKey、turnKey、capabilityKey、commitHash、normalizedPath、relation、strength、observedAt、reachable。

### 10.2 `delivery-trace@1`

用户不需要记 Recipe 名。Agent 先调用 `threadshare_insights_spec`，由 intent mapping 选择：

```json
{
  "name": "delivery-trace@1",
  "root": { "kind": "session", "key": "..." },
  "window": { "after": null, "before": null },
  "direction": "both",
  "maxDepth": 3,
  "includeCandidateEdges": false,
  "includeContextualEdges": false,
  "limit": 100,
  "cursor": null
}
```

至少提供 root 或有界 window + repository/project filter；拒绝无界全图查询。`maxDepth` 取 1..3，`limit` 取 1..200。Engine 另设 nodes、edges、candidate rows、hydrated bytes 和 response bytes 独立预算。

Response：

```json
{
  "format": "threadshare-insights-delivery-trace@v1",
  "databaseUuid": "uuid",
  "snapshotSeq": "42",
  "evaluatedAt": "2026-08-16T02:00:00.000Z",
  "root": { "kind": "session", "key": "..." },
  "nodes": [],
  "edges": [],
  "nextCursor": null,
  "truncated": false,
  "coverage": {
    "repositoryState": "complete",
    "intentState": "unavailable",
    "unresolvedRefCount": "0",
    "excludedCandidateEdgeCount": "3",
    "excludedContextualEdgeCount": "8",
    "unreachableCommitCount": "0",
    "unselectedRepositoryCount": "0"
  }
}
```

一次 Trace 只读一个 repository 的边。Session 与 Turn root 是按 project key 解析仓库的，同一个 project key 可能被多个已注册 repository 声明（同一工作路径被重新 `git init` 成新的 Git directory 时，旧注册项按设计保留），此时 Trace 取排序后的第一个，其余数量记在 `unselectedRepositoryCount`，让遗漏可见而不是静默。`"0"` 表示本次 Trace 覆盖了声明该 root 的全部仓库。按 repository 或 commit 进入的 root 不存在这个问题，恒为 `"0"`。

Cursor 绑定 database UUID、snapshotSeq、去掉 cursor 后的 canonical request、evaluatedAt 和 graph frontier。分页可以重复 boundary node，但每页 edge 的两端必须都在本页 `nodes` 中；客户端按 `(kind,key,revision)` 去重。

### 10.3 Evidence

Trace node/edge 均有 revision。完整 Prompt、Tool input/output、error、file payload、commit metadata、intent source excerpt 或单 Commit diff 使用现有 Evidence 分页模型扩展 target kind；revision 不匹配返回 stale/changed error，不能返回另一个版本的证据。

Git diff Evidence 的 provenance 必须是 `local-git-object`，与存储在 SQLite 中的 `recorded`/`derived` facts 分开。Agent 引用 diff 时同时给出 commit hash、parent、path 和 completeness；不能把缺页或 binary metadata 当作完整代码审查。

## 11. Agent 使用体验

`threadshare insights spec --format json` 与 MCP spec 增加自然语言 intent，不要求用户输入协议名。至少覆盖：

| 用户问题 | Agent 行为 |
|---|---|
| 这个功能由哪些会话和提交交付，依据是什么 | Trace direct/observed edge，引用 limitation |
| 这次失败后来怎么解决，最终改了什么 | failure-chain + delivery-trace + Evidence |
| 哪些需求还没有对应提交 | intent root，聚合 missing delivery edge |
| 哪些提交没有 Agent 或 intent 证据 | commit root，返回 evidence gap，不推断人工/Agent authorship |
| 我继续这项工作前要先知道什么 | 生成有界 continuation context，列明 snapshot 与缺口 |

Agent 输出规则进入 Skill golden：

- 必须区分“显式关联”“观察到”“候选”“上下文”。
- 不得把 `observed` 复述为“Agent 编写了此 Commit”。
- candidate/contextual 不得支撑默认结论。
- truncated、partial、unavailable 或 stale 必须在结论附近披露。
- continuation context 必须声明不能恢复 Session、代码或 Git 状态。

## 12. Insights Inspector

### 12.1 信息架构

Dashboard 增加 `Insights Inspector` 主 tab；现有右侧 `inspector` 更名为 Detail Drawer，避免让局部证据抽屉冒充完整 Inspector。

Insights Inspector 有两种导航模式：

- Intent：可折叠 feature/story tree；显示 complete/todo 与 evidence gap，但不把 todo 状态等同证据强度。
- Date：UTC day/week；在 intent 缺失时仍可按 observed activity 检查交付。

### 12.2 Workbench

选中 scope 后展示三栏：

1. User intent/prompts。
2. Provider-neutral normalized activity 与完整调用泳道。
3. Git commits、changed files 和 delivery gaps。

选择 Story、Session、Turn、Tool call、File 或 Commit 后，其他栏只高亮由当前 Trace response 支撑的 related selections。浏览器不得用相同文本、相邻 DOM 顺序或 basename 自行补边。

Session 详情复用 `session-timeline@1` 和 Evidence，按 Turn 展开 prompt、intermediate response、Tool calls、assistant response 与 directly observed commits。缺 timestamp 的事件按 sequence 展示并标记 timing unavailable。

### 12.3 有界 UI

- 初屏只取 selected root 的 depth 1；展开节点再请求后续页。
- 大 payload、diff、Tool output 默认不加载；用户或 Agent 请求 Evidence 时分页读取。
- 所有 list/swimlane 使用稳定尺寸和虚拟化或分页，不把 25k 全图装入浏览器。
- 不使用无边界 force-directed graph 作为主导航；交付链以可扫描的 lanes/tree 为主。
- self-contained HTML export 延期；本地 loopback Dashboard 是 v1 runtime。

## 13. Continuation context

Continuation context 是一个有界的派生文本/JSON，不是 checkpoint：

- 包含 selected intent、最近 prompts、direct/observed commits、exact shared paths、失败链摘要、snapshot 和 coverage。
- candidate/contextual 单独列出，不混入已确认交付。
- 不包含“已恢复”“可直接继续原 Session”等声明。
- 不执行 Provider CLI、不写工作区、不 checkout commit。
- 复制动作只发生在浏览器用户手势后；Agent 可请求同一结构化数据自行组织上下文。

## 14. Snapshot、并发与生命周期

- Trace Query 与现有 Query 在一个 SQLite read transaction 中完成。
- Git diff Evidence 是唯一允许离开 SQLite snapshot 的读取路径；它只读取 Trace 已选择的 immutable object，并以 commit/parent/revision/digest 独立绑定，不能回流改变 graph result。
- Provider、Repository、Intent 任一 source 正在 sync 时，查询继续读上一个 committed snapshot。
- source batch 完成后一次推进 snapshotSeq；同一 response 不混合旧 Session 与新 Commit。
- Engine timeout/abort/fatal 后 client 淘汰，迟到 frame 不进入下一个 Trace 请求。
- purge/exclude 应从默认 Trace 移除对应 Session 关系；Git/Intent facts 若仍有独立来源可保留，但 edge coverage 必须解释断链。
- `status` 报告 repository/intent projection version、last successful sync、pending/drift/failed state，不读取完整图做 integrity scan。

## 15. 性能与容量

v1 采用 ADR-0002 的三层证据：小型确定性 fixture、正式 25k、可选真实仓库。250k 延期，不由 25k 外推。

正式 25k corpus 除现有历史事件外，增加确定性 repository/intents：

- 25,000 Turns、足够的 Tool/file events；
- 至少 5,000 Commits、20,000 changed-file rows；
- direct/observed/candidate/contextual 与 unresolved refs 均非空；
- rebase/unreachable、rename、同文件并行 Session 和无 timestamp 反例。

门槛：

| 路径 | 25k gate |
|---|---|
| Trace 初页 | P95 < 200 ms，P99 < 500 ms |
| depth 扩展 | P95 < 250 ms，P99 < 500 ms |
| Evidence 首屏 | P95 < 100 ms，后续保持既有吞吐门槛 |
| 单 Commit/path diff 首屏 | P95 < 500 ms，后续流式且内存有界 |
| Engine sidecar RSS | peak < 128 MiB |
| response | 单 frame < 4 MiB，超预算 fail-closed |

EXPLAIN gate 必须证明按 repository/path/from/to 索引选择候选，不出现对 `history_events`、`git_commit_files` 或 `delivery_trace_edges` 的无界全表扫描。Query 不得对每个 node 发 N+1 SQL。

Stage 4 的 25k 正式结果归档于
[`docs/benchmarks/local-session-insights/2026-08-16-delivery-trace/`](benchmarks/local-session-insights/2026-08-16-delivery-trace/README.md)：四条查询路径的 P95 分别为 4.30、10.24、34.06 和 10.86 ms，Engine peak RSS 为 37,683,200 bytes，最大响应为 47,901 bytes，incremental/clean graph digest 相等。250k 仍为明确的 deferred/not measured，不从这些数字外推。

## 16. Migration、clean rebuild 与发布

- Provider Adapter `claude@3` / `codex@3` 首次启用时，会对既有 Session 做一次 `replace-session` 重放，使历史中的普通 `git commit` result 与新摄入数据采用同一关联语义；完成后后续 sync 恢复增量处理。
- 新 schema/projection 缺失时，旧 Agent Query 继续工作；Delivery Trace 返回稳定 not-ready diagnostic。
- candidate shadow rebuild 构建 repository/intent/edge 投影，验证后原子激活；失败保留旧 active DB。
- 增量 sync 与 clean rebuild 对同一 source snapshot 必须产生逐 node/edge/revision 完全相等的 digest。
- npm tarball 必须包含新增 schema、Agent Skill 和 Dashboard assets；clean-install smoke 覆盖 CLI/MCP spec、Recipe 和 Insights Inspector API。
- Windows 仍按当前 release contract 为 core-only；本设计不改变平台发布矩阵。

## 17. 分阶段实施与验收

### Stage 0：契约与 TDD fixture

交付：Trace Node/Edge/response JSON schema、Rust DTO、双侧 protocol validator、edge classifier golden、Git/Intent fixture。

验收：

- Rust 与 Node 对相同 fixture 逐字段一致；未知字段、错误 revision、非法 strength/limitation fail-closed。
- mutation test 能杀死“shared path 自动升级 direct”“candidate 默认进入结论”“edge 引用缺失 node”。
- README/Skill 只给自然语言问题，参数发现继续指向 `insights spec/help`。

### Stage 1：Repository facts 与 edge projection

交付：显式 repository 注册、read-only Git source、ref watermarks、commit/file schema、TEMP staging、incremental projection、`delivery-edge` Query、credential-free SCM mapping。

验收：

- active ref drift 整 batch 回滚并有界重试；不会因正常 commit 写入永久失败。
- 默认 sync 不发现或扫描未注册仓库；测试在历史 Session cwd 放置 canary repo 并断言 Git runner 零调用。
- commit amend/rebase 后旧 hash 保留为 unreachable；current/historical 查询口径可证伪。
- worktree 共享 repository identity；不同 repository 的同路径不串联。
- crash/ACK loss 重放幂等；incremental 与 clean rebuild digest 相等。

### Stage 2：Agent Recipe 与 Evidence

交付：`delivery-trace@1`、spec intent mapping、MCP/CLI schema、node/edge evidence paging、按需 Git diff Evidence、continuation context DTO。

验收：

- 五类高价值问题 golden 能产出 evidence-bearing answer plan。
- Agent 文案不把 observed/candidate 表述为 authoring/causality。
- cursor 在 snapshot、request、clock、frontier 或 reindex UUID 漂移时 stale。
- diff fixture 与固定 Git oracle 逐字节一致；merge parent、rename、binary、超大单文件、missing object 和分页 digest 均有反例。
- GitHub/GitLab remote parser 的 credential/query/fragment mutation 不得进入 API；SCM unavailable 不改变 Trace evidence strength。
- installed tarball 真实调用四个 MCP tools 并读取新增 Recipe/schema。

### Stage 3：Insights Inspector

交付：`Insights Inspector` tab、Intent/Date 导航、三栏 workbench、Session Replay、Detail Drawer、related selection、continuation copy。

验收：

- Playwright 桌面/移动截图无重叠、横向页面溢出或空白状态；大列表不造成 layout shift。
- 选择联动只使用 response edge；删除一条 edge 的 mutation test 会移除对应高亮。
- Dashboard 不扫描 Git/Provider source，不修改 state 目录权限，不把 bootstrap secret 放入 URL。
- source assets 与 committed build 两次 clean build 完全一致。

### Stage 4：Intent adapter 与正式 evidence

交付：Markdown `IntentSourceV1`、unresolved diagnostics、25k runner、packager/verifier、用户文档与真实参考报告。

验收：

- malformed/partial tree 保留可用 Trace 并准确报告 coverage；重复 ID fail-closed。
- 25k correctness、latency、RSS、query-plan、response-bound、incremental-equivalence gate 全部非空通过。
- evidence 归档只保存 aggregate/digest，不提交本机路径、Session 内容、Git 仓库或数据库。
- 250k 明确标记 not measured/deferred。

## 18. 实现期间不可漂移的审查清单

1. 是否只有 Engine 在决定 Trace edge，UI/Node 没有第二套关联算法？
2. 是否每条 Derived edge 都有 typed facts、limitation 和可复算 revision？
3. 是否 Query 路径完全不读取 Git、workspace、intent 或 Provider raw source？
4. 是否 candidate/contextual 默认不进入 Agent 结论，coverage 没有隐藏排除量？
5. 是否新增性能结论来自正式 25k，而不是小 fixture 或 250k 外推？

任一答案为否，Stage 不得标记完成。
