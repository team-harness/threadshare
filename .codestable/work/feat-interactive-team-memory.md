---
type: feat
status: complete
---

# Interactive Team Memory

## 目标

让当前 Codex/Claude Agent 通过 Threadshare 直接读取有界历史证据、与用户讨论团队记忆候选，并在用户确认后晋升；CLI 与 MCP 调用同一个语义模块并保持稳定能力同构。

## 决策

- 当前 Agent 是用户选择的受信本机代理。`recall` 直接返回完整有界 Turn chunk，`synthesize` 直接返回 approved L1 与当前 Scene/Doctrine。
- Agent-native 路径不使用 Broker、WebAuthn、读取前 approval bundle、隐藏受限 Runner 或 declassification。Threadshare 不声称防御恶意本机 Agent。
- `--runner` 只保留给可选 batch `extract/consolidate/reverify-runner`；已有 Codex/Claude 对话调用 `recall/synthesize` 时不传 runner。
- 用户使用 `--since`、`--until` 与普通 filter 参数；`--request -` 的 CandidateDraftBatch/AdjudicationResult/ConsolidationPatch/PrepareRequest 由 Agent 生成，不要求用户维护 JSON 文件。
- Agent-native L1 使用与 batch 相同的两阶段去重：第一次 stage 返回 AdjudicationTask 与当前 pool，第二次 stage 提交 store/skip/update/merge；不自动 store 重复项。
- 仍保留 worktree + eligible + active + hard-sealed 选材、Delivery Trace、evidence binding、candidate revision、statement/citation digest、target blob CAS 和可恢复 promotion journal。
- `review` 只读；用户确认后，Agent 用精确 digest 调用 `prepare` 生成 PromotionPlan，再在最终确认后调用 `promote`。该过程是工作流状态，不是身份认证。
- CLI/MCP 使用一个 operation registry、一个 contract、一个状态机；transport envelope 可以不同，业务语义不能不同。

## 稳定操作

`status`、`review`、`recall`、`synthesize`、`stage`、`prepare`、`promote` 必须同时具备 CLI 与 MCP 真实成功路径。`init/lint/assemble`、Runner batch 和 MCP-only search 暂记 `legacy-debt`。

## 验收

1. operation registry 中稳定操作缺 CLI 或 MCP 入口时 release test 失败。
2. 相同 request 的 CLI/MCP normalized result、错误码、CAS 和持久状态一致。
3. source/revision/statement/citation/target blob 漂移均拒绝；空 candidate 与空 Patch 可见、可重放。
4. 真实 Codex 与 Claude 完成 recall、候选讨论、用户补充、精确 prepare 与 promote E2E。
5. 既有 batch extraction/consolidation E2E、release allowlist、README/Skill/help 全部保持通过。

## 当前状态

- [x] 直接 Agent 信任模型冻结，Broker/受限处理器方案废弃。
- [x] operation registry 与 stable CLI/MCP parity contract tests。
- [x] L1 `recall → stage(draft) → stage(adjudication) → review → prepare → promote` 实现和定向测试。
- [x] L2/L3 `synthesize → stage → review → prepare → promote` 实现和定向测试。
- [x] README/Skill/help/设计文档统一。
- [x] 全量验证、code-deep review、真实 Codex Agent-native E2E。
- [x] 真实 Claude Code Agent-native E2E。

## 证据

- `src/memory-operation-registry.mjs`：稳定操作与 CLI/MCP adapters。
- `src/memory-command.mjs`：共享 Agent-native 状态机。
- `src/insights-mcp.mjs`：同构 MCP tools。
- `docs/team-memory-interactive-design.md`：rev5 直接 Agent 协议与信任边界。
- 2026-08-22：真实 Codex CLI 0.149.0 在隔离 fixture 完成 `recall → stage(draft) → stage(adjudication) → review → prepare → promote`；最终 `promote=applied`、approved entry=1，证据映射命中 `turn 0 → ev-4-380ae17d7cf1`，未产生 git commit。
- 2026-08-22：真实 Claude Code 2.1.222 在独立隔离 fixture 完成 `recall → stage(draft) → stage(adjudication) → review → prepare → promote`；promote=applied，approved entry=1，lint 无阻断。
- 2026-08-22：长 binding CLI/MCP 对等回归通过（含 MCP EOF 超限负例）；`test:cli` 395/395、Insights Engine Node 363/363 及全部 Rust suite、`test:release` 76/76、`validate:skill` 全部通过。
