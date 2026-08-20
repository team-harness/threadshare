# Team Memory Phase 1 详细技术设计

状态：Draft（实现依据；上游规格为 [team-memory-proposal.md](./team-memory-proposal.md) rev6）
日期：2026-08-20
范围：提案 §8 Phase 1 的实现级设计——模块拆分、数据定义、协议、接口签名、测试计划与阶段推进顺序

## 0. 与提案的偏差声明（实现决策，需 review 判定）

| # | 提案原文 | Phase 1 实现决策 | 理由与后续 |
|---|---|---|---|
| DEV-1 | D3：approved memory 经 memory ingest 进入 **Insights** Rust 表组与 memory FTS，供 Query 层 `memory-entry` resource 使用 | Phase 1 将 approved 投影放在 **memory-state.sqlite3** 内（`approved_entries` + `approved_fts`，按 `(repositoryKey, worktreeKey)` 分键，与提案一致的事务语义与 no-scan-on-query 约束）；`memory_search` MCP 与去重召回都走该投影。Insights 侧 `memory-entry` Query resource、ingest collection 与影子重建**顺延至 Phase 2** | 一次交付两套投影（insights + memory-state）会让 Phase 1 的 Rust 面积翻倍；memory-state 投影已满足全部功能与一致性要求（同事务更新、generation、versioned 召回）。风险：消费面暂无 snapshot-token 级联到 insights 快照——记录为 Phase 2 任务 |
| DEV-2 | frontmatter 未指定方言 | 仓库无 YAML 依赖（仅 ajv/ajv-formats/jsonc-parser/markdown-it/zod），**不新增依赖**。定义严格 frontmatter 方言：`key: value`，value 为 JSON 字面量（字符串可省引号，数组/对象必须是合法 JSON）；自研解析器，保证确定性 round-trip | 新增 yaml 依赖违背仓库极简依赖文化；严格方言可精确校验、可 canonical 序列化 |
| DEV-3 | conformance test 每次交付前运行 | 通过一次后缓存 `{profile, cliVersionFingerprint, testVersion}`，CLI 版本或 profile 或 testVersion 变化才重跑；`--reverify-runner` 强制重跑 | 全量探针较慢（需真实模型调用）；指纹失效语义与提案一致 |

## 1. 模块清单

### Node（`src/`，全部新文件，需同步发布白名单）

| 文件 | 职责 |
|---|---|
| `memory-contracts.mjs` | 全部契约对象的 zod schema、canonical 序列化、digest 计算（复用 `canonical-json.mjs`）；契约版本常量 |
| `memory-format.mjs` | entry/scene/doctrine/SKILL 文件的 frontmatter 方言解析、校验、canonical 序列化；`parseMemoryEntry` / `serializeMemoryEntry` / `parseSceneMeta` |
| `memory-repository.mjs` | `resolveRepositoryBinding(cwd | --repository)`：git common dir identity + real worktree root；零/多映射硬失败；publicRepositoryIdentity 净化 |
| `memory-lint.mjs` | 净化管线：secret 检测（正则族 + Shannon entropy）、provider session id 检测、frontmatter/容量/slug 校验；`lintEntryText(text) → findings[]` |
| `memory-state-client.mjs` | memory-state 引擎协议的 Node 封装（每个协议命令一个函数）；复用引擎 spawn/分帧基础设施 |
| `memory-extraction.mjs` | 选材评分（insights query）、chunk 切分（连续完整 Turn ≤40KB、tool payload 头尾摘录 + coverage 申报）、`<<past-*>>` transcript 序列化、evidenceCatalog 组装、sourceInputDigest、EvidenceAssessment 派生、AdjudicationTask 组装 |
| `memory-runner.mjs` | runner profile 加载与校验、deny-all conformance test、RunnerExecutionPlan / AuthorizationManifest 生成、子进程执行（stdin/stdout、超时、输出上限）、codex hard-fail |
| `memory-command.mjs` | CLI 编排：`memory init / extract / review / promote / lint / assemble / status`；puts 全流程串起来 |
| `memory-prompts.mjs` | 提炼/裁决/归纳 prompt 资产（版本化常量，promptVersion 进 CAS） |

MCP：`insights-mcp.mjs` 增补 `threadshare_memory_search`（只读）与 `threadshare_memory_status`（编排辅助，不携带 transcript）。

### Rust（`crates/insights-engine/src/`）

| 文件 | 职责 |
|---|---|
| `memory_state.rs` | memory-state.sqlite3 的打开/迁移（独立于 insights 库；0600；WAL）、`memory_state_meta` 版本键 |
| `memory_state_repository.rs` | 全部表操作：repository_bindings / tasks / submissions / chunks / candidates / candidate_fts / candidate_projection / approved_entries / approved_fts / approved_projection / evidence_refs / assessments / promotion_journal / authorization_log；claim/lease、幂等提交、revision CAS、事务边界 |
| `memory_recall.rs` | 双 FTS 各取 3×k BM25 候选 + `recall-rrf@1`（k=60，tie-break `sourceKind,id`）；recallQueryDigest / resultSetDigest 计算 |
| `memory_promotion.rs` | PromotionPlan 校验与应用：owner 重解析比对、blob OID（`git hash-object` 语义，纯 Rust 计算 `sha1("blob {len}\0"+bytes)`）、no-follow 逐级 traversal + 原子 rename 写入器、journal 恢复 |
| `main.rs` / 协议模块 | 新增请求分发（见 §3） |

## 2. memory-state.sqlite3 DDL（v1）

位置：`<state-dir>/memory/memory-state.sqlite3`（0600）。`memory_state_meta(key, value)` 存 `memoryStateUuid` 与 `schema_version = 1`。

```sql
CREATE TABLE repository_bindings (
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  public_repository_identity TEXT, root_realpath TEXT NOT NULL,      -- 敏感，仅本库
  root_realpath_digest BLOB NOT NULL,
  common_dir_device INTEGER NOT NULL, common_dir_inode INTEGER NOT NULL,
  memory_root TEXT NOT NULL DEFAULT '.threadshare/memory',
  status TEXT NOT NULL DEFAULT 'active',
  PRIMARY KEY (repository_key, worktree_key)
);
CREATE TABLE tasks (
  task_id TEXT PRIMARY KEY, kind TEXT NOT NULL,                      -- extraction|adjudication|consolidation
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  chunk_ref TEXT, draft_batch_ref TEXT,
  binding_json TEXT NOT NULL, authorization_plan_digest BLOB,
  lease_holder TEXT, lease_expires_at INTEGER,
  status TEXT NOT NULL DEFAULT 'pending',                            -- pending|claimed|submitted|stale
  created_at INTEGER NOT NULL
);
CREATE TABLE submissions (
  task_id TEXT NOT NULL, response_digest BLOB NOT NULL,
  received_at INTEGER NOT NULL, PRIMARY KEY (task_id, response_digest)
);
CREATE TABLE chunks (
  chunk_ref TEXT PRIMARY KEY,                                        -- sessionKey:turnStart:turnEnd:chunkDigest
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  session_key BLOB NOT NULL, turn_range TEXT NOT NULL, chunk_digest BLOB NOT NULL,
  status TEXT NOT NULL DEFAULT 'pending',                            -- pending|drafted|extracted|stale
  provenance_snapshot_seq INTEGER
);
CREATE TABLE candidates (
  candidate_id TEXT PRIMARY KEY,
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  chunk_ref TEXT NOT NULL, revision INTEGER NOT NULL DEFAULT 1,
  content_digest BLOB NOT NULL, payload_json TEXT NOT NULL,          -- 净化前全文，仅本库
  status TEXT NOT NULL DEFAULT 'draft',                              -- draft|quarantined|promoted|discarded
  adjudication TEXT NOT NULL DEFAULT 'pending',                      -- pending|done|failed
  updated_at INTEGER NOT NULL
);
CREATE VIRTUAL TABLE candidate_fts USING fts5(
  searchable_text, content='', contentless_delete=1
);                                                                    -- rowid ↔ candidates.rowid，同事务维护
CREATE TABLE candidate_projection (
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  generation INTEGER NOT NULL, analyzer_version TEXT NOT NULL,
  recall_algorithm_version TEXT NOT NULL,
  PRIMARY KEY (repository_key, worktree_key)
);
CREATE TABLE approved_entries (                                      -- DEV-1：approved 投影
  entry_id TEXT NOT NULL, repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  revision INTEGER NOT NULL, content_digest BLOB NOT NULL,
  frontmatter_json TEXT NOT NULL, body_text TEXT NOT NULL, status TEXT NOT NULL,
  PRIMARY KEY (entry_id, repository_key, worktree_key)
);
CREATE VIRTUAL TABLE approved_fts USING fts5(
  searchable_text, content='', contentless_delete=1
);
CREATE TABLE approved_projection (
  repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  generation INTEGER NOT NULL, source_tree_digest BLOB NOT NULL,     -- worktree 记忆文件全集 digest
  analyzer_version TEXT NOT NULL, recall_algorithm_version TEXT NOT NULL,
  PRIMARY KEY (repository_key, worktree_key)
);
CREATE TABLE evidence_refs (
  candidate_id TEXT NOT NULL, statement_id TEXT NOT NULL, evidence_id TEXT NOT NULL,
  pointer_digest BLOB NOT NULL, session_key BLOB, turn_key BLOB, revision INTEGER,
  payload_sha256 BLOB, relation TEXT, strength TEXT, limitations_json TEXT,
  task_id TEXT NOT NULL, PRIMARY KEY (candidate_id, statement_id, evidence_id)
);
CREATE TABLE assessments (
  candidate_id TEXT NOT NULL, statement_id TEXT NOT NULL,
  citations_digest BLOB NOT NULL, provenance_strength TEXT NOT NULL,
  limitations_json TEXT NOT NULL, claim_support TEXT NOT NULL,       -- unverified|typed-fact|human-confirmed
  assessed_by TEXT NOT NULL,                                         -- deterministic|human
  statement_text_digest BLOB NOT NULL, revision INTEGER NOT NULL,
  PRIMARY KEY (candidate_id, statement_id)
);
CREATE TABLE promotion_journal (
  plan_id TEXT PRIMARY KEY, repository_key BLOB NOT NULL, worktree_key BLOB NOT NULL,
  candidate_ids_json TEXT NOT NULL, assessment_digest BLOB NOT NULL,
  per_file_json TEXT NOT NULL,                                       -- [{targetPath,targetBlobHash,sanitizedDigest}]
  policy_version TEXT NOT NULL, status TEXT NOT NULL,                -- approved|applied|voided
  updated_at INTEGER NOT NULL
);
CREATE TABLE authorization_log (
  plan_digest BLOB NOT NULL, task_id TEXT, runner_input_digest BLOB,
  input_coverage_digest BLOB, provider TEXT, model TEXT, endpoint TEXT,
  bytes INTEGER, decided_at INTEGER NOT NULL,
  via TEXT NOT NULL,                                                  -- interactive|digest|manifest
  manifest_digest BLOB
);
```

事务边界（与提案 §5.5 一致）：

- **tx-claim**：`UPDATE tasks SET status='claimed', lease_* WHERE task_id=? AND (status='pending' OR lease_expires_at < now)`，行级原子；
- **tx-extraction-submit**：submissions 插入（幂等短路）→ candidates 插入 + candidate_fts + evidence_refs + assessments + candidate_projection.generation+1 + chunks.status='drafted' + tasks.status='submitted'，单事务；
- **tx-adjudication-submit**：submissions 幂等 → 逐 target `UPDATE candidates ... WHERE candidate_id=? AND revision=?`（CAS，任一失败整体回滚置 stale）→ 裁决效果（quarantined/discarded/merge 重写 payload+revision+FTS）→ chunks.status='extracted' → tasks.status='submitted'，单事务；
- **tx-promotion**：journal 状态推进与文件写入分离；`applied` 前崩溃 → 重放（写入器幂等：目标内容 digest 相同则跳过）。

## 3. 引擎协议新增（沿用现有分帧与信封）

**传输决策（DEV-4）**：不为每个操作新增一对 MessageKind（现有协议是长 if/else 逐类型校验，15 组消息会造成巨量样板），而是新增**一对信封消息** `MEMORY_COMMAND` / `MEMORY_RESULT`，携带 `op` 字段与 op 专属 payload；Rust 侧沿用 delivery-trace 已有的 `serde_json::from_value::<Request>() + request.validate()` 模式（protocol.rs:4606-4615 先例）做 op 级严格校验，Node 侧由 `memory-contracts.mjs` 的 zod schema 双向校验。op 清单如下（语义与原 15 命令一致）：

| op（MEMORY_COMMAND.op） | 方向语义 | 要点 |
|---|---|---|
| `MEMORY_STATE_OPEN` | 打开/迁移 memory-state；返回 memoryStateUuid、schemaVersion | stateDir 由 Node 传入；chmod 0600 |
| `MEMORY_BIND_REPOSITORY` | upsert repository_bindings | 绝对路径只进库 |
| `MEMORY_PLAN_TASKS` | 写入 chunks（pending）与 tasks（pending） | Node 完成选材/分块后批量落库 |
| `MEMORY_CLAIM_TASK` | claim + lease | 返回 task 全量 binding |
| `MEMORY_SUBMIT_EXTRACTION` | tx-extraction-submit | 入参含 drafts + assessments + evidence_refs |
| `MEMORY_RECALL` | 双 FTS + RRF；返回 per-draft ordered recallSets + union pool + digests | 只读 |
| `MEMORY_SUBMIT_ADJUDICATION` | 提交前引擎内**重跑召回**比对 resultSetDigest，再 tx-adjudication-submit | stale 时返回结构化拒绝 |
| `MEMORY_SYNC_APPROVED` | 以 worktree 扫描结果全量/增量更新 approved 投影 | 入参为 Node 解析后的 entries；source_tree_digest 比对短路 |
| `MEMORY_SEARCH` | approved_fts BM25 检索 | 供 MCP/CLI 消费 |
| `MEMORY_REVIEW_QUEUE` | 列 quarantined 候选 + assessments | 只读 |
| `MEMORY_CONFIRM_STATEMENT` | 人审确认：校验 statement_text_digest + citations_digest 后置 human-confirmed | 漂移拒绝 |
| `MEMORY_PROMOTION_PLAN` | 生成 plan（含 blob OID 计算）并入 journal（approved） | diff 由 Node 渲染 |
| `MEMORY_PROMOTION_APPLY` | owner 重解析 + 逐项 blob/assessment/policy CAS + no-follow 写入 + journal applied | fail-closed |
| `MEMORY_AUTHORIZE` | 写 authorization_log | plan/manifest 通用 |
| `MEMORY_STATUS` | chunks/tasks/candidates 计数与游标概览 | 只读 |

Node 侧每个请求在 `memory-state-client.mjs` 封装为 `memoryXxx(engine, params)`，请求/响应用 `memory-contracts.mjs` 的 zod schema 双向校验（沿用 insights-engine-protocol 的双向校验模式）。

## 4. 关键算法实现点

- **blob OID**：`sha1("blob " + len + "\0" + bytes)` 纯 Rust 实现（已有 sha2 依赖，需补 sha1 或用 `git hash-object` 子进程——决策：**子进程 git**，与 promotion 的 git 语义天然一致，且避免新增 crate；沙箱 env 复用 `insights-git-evidence.mjs` 的模式，由 Node 预计算传入，Rust 侧只做比对）。修正：为使 `MEMORY_PROMOTION_APPLY` 的 CAS 不依赖 Node 诚实，Rust 侧自行读目标文件字节并计算 OID——采用**新增 `sha1` crate（RustCrypto，固定版本）**。
- **RRF**：`score(d) = Σ 1/(60 + rank)`，rank 从 1 起；tie-break `(sourceKind, id)` 字典序；`recall-rrf@1` 版本串进 binding。
- **chunk 切分**：输入为 insights `session-timeline` recipe + evidence 分页读取的 Turn 事件；贪心装填 ≤ 40960 字节；单 Turn 内超大 tool payload → 头尾各 1024 字节摘录 + `payloadSha256` 指针，coverage 逐项 `truncated`。
- **transcript 序列化**：`<<past-user>>\n{text}\n\n<<past-tool_call>>…\n<<end-of-transcript>>`；确定性（排序、换行规范）以便 digest 稳定。
- **secret lint**：正则族（AKIA/ghp_/sk-/xox[abp]/-----BEGIN.*KEY/JWT 形态/URL 内嵌凭据）+ 长 token Shannon entropy（≥4.0 bits/char 且长度 ≥20 的连续 base64/hex 串）+ provider session id 形态（uuid v4 + 已知 session 路径特征）。findings 分 `block`（secret/session-id）与 `warn`。
- **conformance 探针**：探针任务 stdin 指示模型执行 6 类违规操作并要求回报"已执行"；判定 = 进程退出后检查（a）输出不含违规成功标记（b）探针沙箱目录无文件系统副作用（c）无网络监听/子进程残留（通过 profile 参数保证 + 输出审计）。探针语料随包版本化 `conformance-test@1`。

## 5. CLI 面（`cli-contract.mjs` 新增 `memory` 命令组）

```
threadshare memory init                          # 初始化 .threadshare/memory/ 骨架
threadshare memory status [--repository <path>]  # 游标/候选/任务概览
threadshare memory extract [--repository <path>] [--runner claude]
                           [--approve-plan <digest>] [--approve-manifest <digest>]
                           [--limit <n>] [--format json]
threadshare memory review  [--format json]       # 逐条确认 + 生成 PromotionPlan
threadshare memory promote --plan <planId>       # 应用已批准 plan（只改工作区）
threadshare memory lint [<path>...]              # 独立净化检查
threadshare memory assemble --provider claude    # 装配 adapter
threadshare memory reverify-runner --runner claude
```

MCP 工具：`threadshare_memory_search`（入参 query/limit，出参带 generation 与 coverage）；`threadshare_memory_status`（只读概览；触发提炼的 MCP 入口只创建 pending plan 并提示走 CLI）。

## 6. 测试计划（node --test + cargo test，不依赖真实 LLM/claude CLI）

| 层 | 测试文件 | 覆盖 |
|---|---|---|
| 契约 | `test/memory-contracts.test.mjs` | schema 往返、digest 稳定性、非法输入 |
| 格式 | `test/memory-format.test.mjs` | frontmatter 方言 round-trip、非法 frontmatter、容量/slug |
| lint | `test/memory-lint.test.mjs` | secret 族阳性/阴性、entropy 边界、session id 检测 |
| owner | `test/memory-repository.test.mjs` | 临时 git 仓库 + worktree fixture：唯一解析、多映射硬失败、symlink 根拒绝 |
| 状态库 | `crates/insights-engine/tests/memory_state.rs` | DDL/迁移、claim 竞争、幂等、CAS、召回 digest、journal 恢复（进程内注入崩溃点：事务前后断言） |
| 状态库-Node | `test/memory-state-client.test.mjs` | 协议往返、并发 claim（两客户端）、submit 幂等 |
| 提炼 | `test/memory-extraction.test.mjs` | chunk 切分边界（含同 Turn 超预算）、coverage 申报、sourceInputDigest 稳定、evidence 派生（任务外 id 拒绝、无引用 unknown） |
| runner | `test/memory-runner.test.mjs` | **fake runner**（test fixture 脚本）：plan digest 绑定、同字节换内容 digest 变化、超时/输出上限、codex hard-fail、conformance 判定逻辑（用 fake CLI 模拟违规/合规） |
| CLI | `test/memory-command.test.mjs` | init/status/lint/review→promote 全链路（fake runner + 临时仓库）；promote 后 blob 漂移 plan 作废；promote 不产生 git 历史操作 |
| 验收 | `test/memory-acceptance.test.mjs` | 提案 §8 验收清单的自动化子集（隐私 grep、跨 chunk 去重、manifest 局部失效） |

## 7. 阶段推进与 review 节奏

按仓库根 to-do 的 Stage 2–8 推进；每个 Stage 完成即：`npm test` 相关分组通过 → `git commit` → 用 cs-agent 拉独立 reviewer（codex）做该 Stage 的 diff review → 修复 → 下一 Stage。发布白名单与 verify-release 更新集中在 Stage 8（避免中间态反复改门限）。

## 8. 接线参照（代码勘察结论，2026-08-20）

关键事实与由此确定的实现决策：

- **DEV-5（第二连接路线）**：引擎当前单连接无多库先例（`storage.rs:192-196`；无 ATTACH）。memory-state 必须独立于 insights.sqlite3（提案 §5.5：`insights reset` 不丢），故排除"同库加表"路线；采用**第二个 Connection**：`EngineServer` 增 `memory: Option<MemoryStorage>` 字段，由 `MEMORY_COMMAND{op:"open"}` 懒打开，复制 `configure()` 的 pragma/WAL 序列（`storage.rs:332-391`），持有独立 `database_path`（WAL sidecar 维护依赖它，`storage.rs:298-302, 400-431`）；0600 由 `persistent_file_permissions` 先例保证（`storage.rs:116`）。
- **协议接线链**（新增 MessageKind 的全部落点）：Rust `protocol.rs:118-175`（枚举）→ `:178-237`（as_str）→ `:3625-3681`（字符串→枚举）→ `:3691-4640`（校验 arm，serde 模式参照 `:4606-4615`）→ `main.rs:656-1174` READY match arm；Node `insights-engine-protocol.mjs:65-122`（MESSAGE_TYPES）→ assert 函数 → `:3830-3893` dispatch → `create*Message` → `insights-engine-client.mjs:614-800/1236-1500`（公开+私有方法模板 `:631-646`/`:1255-1275`）；帧向量 `test/fixtures/insights-protocol-v1/frames.json`（Rust/Node 双向消费）。
- **CLI 接线**：`cli-contract.mjs` COMMAND_SPECS（`:159-470`，参照 insights `:211-280`）+ DIAGNOSTIC_CODES 硬闸门（未登记 code 构造即抛，`:748`）+ preflightHelp 两处 `insights` 硬编码需加 `memory` 对称分支（`:832-834`/`:842-844`）；bin 分发抄 `bin/threadshare.mjs:953-1105`（平台闸门 + AbortController + SIGINT/SIGTERM）。
- **MCP 接线**：`insights-mcp.mjs` TOOL_NAMES（`:11-16`，顺序即索引）+ toolCatalog schema 并行读 + toolInvocation 分派；`test/insights-mcp.test.mjs:51-54` 硬编码工具名断言需同步。
- **git 先例**：`resolveGitRepository`（`insights-repository-source.mjs:413-446`）**已提供 common dir / worktree root / device / inode 解析**，memory-repository 直接复用；沙箱 env 两套模板（execFile 有界 buffer / spawn 流式 spool）。
- **文件读取先例**：`insights-intent-source.mjs:156-209` 的安全读取骨架（realpath 双向前缀 + O_NOFOLLOW + 读前后 bigint stat 比对 TOCTOU + 1MiB 上限 + ENOENT 降级）为 memory 文件读取模板；**运行时无 YAML**（yaml 仅 devDependency、markdown-it 的唯一使用者不在发布白名单）——印证 DEV-2 手写 frontmatter。
- **测试落点**：需要引擎二进制的 Node 测试进 `test:insights-engine` 组（先 cargo build；`test/helpers/insights-e2e.mjs` 提供二进制路径与跳过闸门，要求 Node ≥ 22.5）；纯 Node 测试进 `test:cli`；npm scripts 的测试文件列表是**硬编码枚举**，新文件必须显式追加。Rust 集成测试模板 `tests/insights_overview.rs:1-60`；crash 注入用 `THREADSHARE_INSIGHTS_TEST_CRASH_AT` failpoint（`storage.rs:13-48`）。
- **发布白名单三份手抄副本**：`package.json:26-70`（src 逐文件、schema 整目录）、`scripts/verify-release.mjs:23-96`（73 条扁平清单 + 272KiB/1.25MiB 门限，逐位精确比对）、`test/release-automation.test.mjs:48+`；`AGENTS.md:59` 的 "73-file" 字样需同步——全部集中在 Stage 8 处理。

## 9. 契约字段定稿（Stage 2 实现依据）

通用约定：每个契约含 `format` 自识别字段（如 `"threadshare-memory-extraction-task@v1"`）；digest 一律为小写 hex64（sha256）字符串，git blob OID 为 hex40；整数遵守 canonical-json 安全整数约束；zod schema 全部 `.strict()`。digest 计算：`memoryDigestHex(value) = sha256hex(canonicalJson(value))`；`computePlanDigest(plan)` 剔除 `planDigest`/`authorization` 后取 canonical digest；`computeManifestDigest` 同理剔除 `manifestDigest`/`authorization`；`computeRunnerInputDigest(bytes)` 对精确字节取 sha256。

- **RepositoryBinding@v1**：`{ format, repositoryKey: hex64, worktreeKey: hex64, publicRepositoryIdentity: string|null, rootRealpathDigest: hex64, commonDirectoryIdentity: { device: int, inode: int }, memoryRoot: ".threadshare/memory" }`（不含绝对路径——rootRealpath 只存事务库）。
- **RestrictedExtractionRunner@v1**：`{ format, adapter: "claude-cli"|"codex-cli", version: string, argvTemplate: string[], toolPolicy: "none", network: "model-only", ephemeral: "required", timeoutMs: int, maxOutputBytes: int, conformance: { testVersion: string, passedAt: string, cliVersionFingerprint: string }|null }`。
- **RunnerExecutionPlan@v1**：`{ format, planDigest: hex64|null, taskKind: "extraction"|"adjudication"|"consolidation", taskId, runnerInputDigest: hex64, inputCoverageDigest: hex64, inputCoverage: [{ sourceKind: "transcript"|"draft"|"candidate-pool"|"scene-index"|"prompt", opaqueSourceId: string, revision: int|null, contentDigest: hex64, bytes: int, truncated: bool }], runnerProfile: string, provider: string, model: string, endpoint: string, bytesToSend: int, localSessionPersistence: "none", providerRetention: "unknown"|"no-retention"|"provider-policy", authorization: "pending"|"approved" }`。
- **AuthorizationManifest@v1**：`{ format, manifestDigest: hex64|null, plans: [{ planDigest: hex64, taskKind, taskId, bytesToSend: int }], totalBytes: int, authorization: "pending"|"approved" }`。
- **ExtractionTask@v1**：`{ format, taskId, lease: { holder: string, expiresAt: int }, binding: { databaseUuid: string, owner: { repositoryKey, worktreeKey }, sourceInputDigest: hex64, turnRevisions: int[], payloadDigests: hex64[], deliveryEdgeRevisions: int[], promptVersion, schemaVersion, chunkerVersion, provenance: { snapshotSeq: int, evaluatedAt: string } }, session: { project: string|null, repositoryKey: hex64, timeWindow: { start: string, end: string }|null }, evidenceCatalog: [{ evidenceId, kind: "commit"|"turn"|"path", pointerDigest: hex64, display: string }], chunk: { turnRange: { start: int, end: int }, coverage: [{ sourceKind: "turn"|"tool-payload", ref: string, completeness: "full"|"truncated", bytes: int }], transcript: string }, context: { sceneIndexSummary: string|null }, contract: { draftSchema: "threadshare-memory-candidate-draft-batch@v1", prompts: { promptVersion: string, extraction: string } } }`。
- **CandidateDraftBatch@v1**：`{ format, taskId, binding（原样回传）, candidates: [{ content: string, type: "work_fact"|"work_task"|"work_method"|"work_artifact", priority: int(0..100), confidence: "high"|"medium"|"low", scene: string|null, statements: [{ statementId, text, evidenceIds: string[] }] }] }`。
- **EvidenceAssessment@v1**：`{ format, candidateId, statementId, citations: [{ evidenceId, pointerDigest: hex64 }], provenanceStrength: "direct"|"observed"|"candidate"|"contextual"|"unknown", limitations: string[], claimSupport: "unverified"|"typed-fact"|"human-confirmed", assessedBy: "deterministic"|"human", statementTextDigest: hex64, revision: int }`。
- **AdjudicationTask@v1**：`{ format, taskId, lease, binding: { databaseUuid, memoryStateUuid, owner, draftBatchDigest: hex64, approvedProjection: { generation: int, analyzerVersion: string }, candidateProjection: { generation: int, analyzerVersion: string }, recallAlgorithmVersion: string, recallQueryDigest: hex64, resultSetDigest: hex64, poolItemRevisions: [{ sourceKind: "approved"|"candidate", id, revision: int }], promptVersion, schemaVersion }, drafts: [CandidateDraftBatch.candidates 同构 + candidateId], recallSets: [{ draftRef, ordered: [{ rank: int, sourceKind, id }] }], pool: [{ sourceKind, id, revision: int, contentDigest: hex64, state: string, summary: string }], contract: { resultSchema: "threadshare-memory-adjudication-result@v1", prompts: { promptVersion, adjudication: string } } }`。
- **AdjudicationResult@v1**：`{ format, taskId, binding（原样回传）, adjudications: [{ draftRef, action: "store"|"skip"|"update"|"merge", targetIds: string[], mergedFields: { content?, type?, priority?, scene?, occurred?: string[] }|null }] }`。
- **ConsolidationPatch@v1**：`{ format, taskId, binding（原样回传）, operations: [{ op: "create"|"update"|"merge"|"delete", target: "scene"|"doctrine", name: string, newContent: string|null, basedOnEntryIds: string[], mergeSources: string[] }] }`。
- **PromotionPlan@v1**：`{ format, planId, owner: RepositoryBinding@v1, candidateIds: string[], assessmentDigest: hex64, perFile: [{ targetPath: string, targetBlobHash: hex40|null, sanitizedContentDigest: hex64 }], policyVersion: string, diff: string }`。

JSON Schema 落盘范围（Phase 1）：跨进程边界的四个契约（ExtractionTask / CandidateDraftBatch / AdjudicationTask / AdjudicationResult）+ 审计对象（RunnerExecutionPlan / AuthorizationManifest / PromotionPlan）落 `schema/threadshare-memory-*.v1.schema.json`；其余以 zod 为准，JSON Schema 补齐列入 Stage 8。
