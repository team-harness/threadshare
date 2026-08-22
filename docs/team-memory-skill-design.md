# Team Memory Skill 提取与装配设计

状态：Implemented / Accepted（2026-08-22）

这份文档描述当前已经落地的 Skill 提取与装配能力。跨仓共享不属于本实现。

## 1. 用户路径

在 Codex 或 Claude 对话中，用户可以直接说：

```text
回看最近两周这个仓库的发布失败，找出以后可以重复执行的操作步骤，整理成一个 Skill。先展示候选，我确认后再写入。
```

Agent 使用与 L1 记忆相同的回看入口：

```text
recall → 分析与补充 → stage(SkillCandidate) → review(kind=skill)
       → prepare(kind=skill) → promote → assemble(provider)
```

当前对话路径不需要 `--runner`。`--runner` 仍只属于独立的 batch `extract` / `consolidate`。

`memory recall` / `threadshare_memory_recall` 的同一响应会返回：

- `sources`：有界、完整 Turn 分块和 evidence catalog；
- `guidance.skillRequestFormat`：固定为 `threadshare-memory-skill-candidate@v1`；
- `skillContext`：现有 Skill 的名称、描述、完整文档和当前 SHA-256 digest，供 Agent 判断 create/update 与避免重复。
- `memoryContext`：当前 Scene、Doctrine 和 approved entry，以及绑定这些来源的 `bindingDigest`。

现有 Skill 同时满足“≤20 个且完整文档合计 ≤128 KiB”时全部返回；否则按当前 recall query 对名称、描述和正文做确定性相关性排序。响应最多返回 20 个完整文档、合计 128 KiB，不截断单个 Skill；未完整返回时显式设置 `truncated: true`。源仓最多支持 256 个 Skill，超出后 recall/assemble 直接拒绝。这一步只帮助 Agent 比较，最终唯一性与 update 仍由目标 digest CAS 决定。

Skill 提取采用固定的 Memory-first 顺序：现有 Skill → Scene → Doctrine → approved entry → 历史 Turn。`memoryContext` 最多返回 40 项、正文合计 128 KiB，不截断单项；超限时在每个来源层级内按 query 相关性、Scene heat 或 entry priority 做确定性排序，并显式返回 `truncated: true`。Memory 内容用于复用已经收敛的知识，历史 Turn 仍是 statement 的最终证据来源，不能只引用二次总结。

## 2. SkillCandidate@v1

Agent 提交的最小协议是 `schema/threadshare-memory-skill-candidate.v1.schema.json`：

```json
{
  "format": "threadshare-memory-skill-candidate@v1",
  "taskId": "extract-...",
  "binding": "recall 返回的完整 extraction binding",
  "memoryContextDigest": "recall.memoryContext.bindingDigest",
  "skill": {
    "name": "release-checks",
    "description": "Run the release checks before publishing.",
    "body": "## Procedure\n\n1. Run `npm run test:release`.\n",
    "action": "create",
    "expectedContentDigest": null
  },
  "statements": [{
    "statementId": "release-check",
    "text": "发布前运行 release 检查。",
    "evidenceIds": ["ev-..."]
  }]
}
```

约束：

- `name` 是 1–64 个小写字母、数字和单连字符组成的 slug；目标固定为 `.threadshare/memory/skills/<name>/SKILL.md`。
- `description` 不得包含换行或尖括号；正文上限 64 KiB，必须是 LF 文本，不能带 BOM 或 CR。
- `create` 要求目标不存在；`update` 必须携带目标当前正文的 SHA-256 `expectedContentDigest`。Skill 没有 delete 操作。
- `memoryContextDigest` 必须原样回显同一次 recall 的 `memoryContext.bindingDigest`。它绑定全部 approved entry revision、Scene digest/heat 和 Doctrine digest，不由 Agent 计算。
- 每条 statement 都必须引用至少一个同一 recall source 的 evidence id；statement id 和同一 statement 内的 evidence id 必须唯一。Threadshare 从 source binding 和证据目录重新计算 assessment，Agent 不能自报 digest、strength 或 heat。
- 生成性 statement 默认是 `unverified`；`review` 中逐条确认后才允许 `prepare`。

Threadshare 内部仍复用 v2 memory-state 的 extraction task 和 candidate 表，Skill payload 带有 `candidateKind: "skill"`，因此不需要破坏性数据库迁移。Skill 在 entry recall/去重池中被排除，但 review、promotion CAS 和审计仍走同一状态机。

## 3. 审核与写入

`memory review --kind skill` 会重新读取当前 Skill 目标并校验 create/update digest，同时展示 statement、证据摘要、限制和确认 digest。目标正文、provider session id、turn key 和 payload 引用不会写入 Git；原始引用仅保存在本机 0600 memory-state 中。

`memory prepare --request -` 的 `kind` 必须是 `skill`，请求内容只引用 review 返回的 candidate revision、statementTextDigest 和 citationsDigest。Prepare 产生精确 PromotionPlan，包含目标 blob CAS 与净化后的正文。只有用户确认该计划后才执行：

```bash
threadshare memory review --kind skill --format json
printf '%s\n' '<PrepareRequest kind=skill>' \
  | threadshare memory prepare --request - --format json
threadshare memory promote --plan <plan-id> --format json
```

任意 transcript source binding、Memory context、candidate revision、statement/citation digest、目标文件或 owner 漂移都会使流程 fail closed，需要重新 recall/stage/review。Memory context 在 stage、review/prepare 和 promote 前都会重新读取；approved entry、Scene 或 Doctrine 的新增、删除或正文变化都使旧 Skill 候选失效。

## 4. 装配

Git 真相源是 `.threadshare/memory/skills/**`。装配是显式、可重复生成的 provider adapter：

```bash
threadshare memory lint .threadshare/memory/skills/<name>/SKILL.md
threadshare memory assemble --provider claude
threadshare memory assemble --provider codex
```

两种 provider 都会维护根目录的 Team Memory 生成块，并分别把 Skill 投影到：

| provider | Skill 投影 |
|---|---|
| `claude` | `.claude/skills/<name>/SKILL.md` |
| `codex` | `.codex/skills/<name>/SKILL.md` |

源 Skill 只保留通用 frontmatter 和正文，不复制 `agents/openai.yaml` 等 provider 专属元数据。首次生成或由 Threadshare 上次生成的文件可以被更新；检测到用户在投影文件上的未记录修改时，装配会报冲突而不会覆盖。

装配不会删除过期 provider 文件，也不会自动提交 Git。提交前检查：

```bash
git diff -- .threadshare/memory CLAUDE.md AGENTS.md .claude/skills .codex/skills
```

## 5. CLI/MCP 对等

Skill 没有单独的 transport 专用操作。CLI 和 MCP 共同使用 `stage`、`review`、`prepare`、`promote`：

| CLI | MCP |
|---|---|
| `memory stage --request -` | `threadshare_memory_stage` |
| `memory review --kind skill` | `threadshare_memory_review({kind:"skill"})` |
| `memory prepare --request -` | `threadshare_memory_prepare` |
| `memory promote --plan <id>` | `threadshare_memory_promote` |
| `memory assemble --provider <x>` | `threadshare_memory_assemble({provider:"<x>"})` |

两种入口共享 recall 的 `skillContext`/`memoryContext`、zod/Rust contract、candidate 状态、证据绑定、错误码、PromotionPlan、CAS 和 provider 装配实现。MCP 的 `tools/list` 同时公布带 `memoryContextDigest` 的 `SkillCandidate@v1` 与 `threadshare_memory_assemble`；切换 transport 不会跳过确认或改变写入语义。

## 6. 验收

- `test/memory-command.test.mjs` 覆盖 Memory-first 返回顺序、entry/scene/doctrine 在 stage/review/promote 前的漂移拒绝、canonical Skill 的 CLI lint 分流，以及 MCP stage → CLI review → MCP prepare → CLI promote → Claude assemble 的真实引擎路径。
- `test/memory-skill.test.mjs` 覆盖规范化序列化、格式拒绝、secret/provider-path lint 和 schema 约束。
- Rust memory-state 覆盖 `skill` review kind、Skill payload exclusion from recall、finalized submission 状态和混合队列过滤。
- `npm run test:cli`、`npm run test:insights-engine`、`npm run test:release`、`npm run validate:skill` 是发布前必跑检查。
