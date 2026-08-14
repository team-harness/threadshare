# 用 Insights 分析 Agent 编程工作：一个真实索引案例

这份报告展示的不是“Insights 有哪些字段”，而是用户可以把哪些问题交给 Agent，以及 Agent 如何用 Threadshare Insights 给出可行动、可下钻、不会过度推断的回答。

案例来自一个真实的本地个人索引。文中只保留聚合数字和归类结论，不公开项目 key、Session key、本地路径、事件正文或 evidence key。

## 分析边界

主体趋势来自 committed snapshot `3657`，深度案例来自 snapshot `3718`，失败分析更新于 snapshot `3729`。这些结果回答不同层级的问题，本文不把跨 snapshot 的小幅计数差异解释成行为变化。

| 指标 | 观测值 |
|---|---:|
| 原始 Session | 3,634 |
| 可分析 main Session | 3,046 |
| 排除的 subagent Session | 587 |
| 已索引 Turn | 11,488 |
| Capability | 207（176 Tool、31 Skill） |
| 本地派生状态 | 约 12.1 GiB |

趋势比较使用 13 个完整 UTC 周：当前窗口为 `2026-05-11` 至 `2026-08-10`，对照窗口为 `2026-02-09` 至 `2026-05-11`。

Insights 查询只读取已提交索引，不会隐式运行 `sync`。因此 Agent 的回答应同时给出 snapshot、查询窗口、coverage 和 evidence，而不是把索引内容表述成实时事实。

## 问题 1：哪些 Skill 或 Tool 用得最多，用在什么场景？

> 请用 Threadshare Insights 找出最近 13 个完整周使用最多的 5 个 Skill，并说明它们通常出现在什么工作场景。区分调用次数、独立 Turn、Session 和 dedupe group。

Agent 先做 Skill 使用排行，再为前 5 个 Skill 获取代表性上下文。用户不需要指定命令或内部分析计划。

| Skill | 调用 | Turn | Session / group | Agent 归纳的常见场景 |
|---|---:|---:|---:|---|
| `codestable:cs-review` | 24 | 24 | 24 / 24 | 冻结 diff、独立审查、契约与证据核验 |
| `cs` | 20 | 20 | 9 / 8 | 实现前讨论、设计收敛、canonical 决策 |
| `codestable:cs-epic` | 4 | 4 | 2 / 2 | 多阶段迁移、长程交付、阶段验收 |
| `paseo` | 3 | 3 | 3 / 3 | 多 Agent 分工、并行实现与验证 |
| `cs-onboard` | 3 | 3 | 3 / 3 | 新仓库接入、建立维护边界 |

**有价值的回答**：Skill 已进入正式工程流程，但采用高度集中。前两个 Skill 占全部 90 次 Skill invocation 的 48.9%，前五个占 60.0%。最值得产品化的是 review 与设计收敛流程，而不是继续增加低频入口。

**下一步**：把 `cs-onboard` 与 `codestable:cs-onboard` 归为同一 capability family，再观察长期采用率。`cs` 的 20 次调用只分布在 8 个 group，不能被写成 20 个独立成功案例。

Tool 趋势还暴露了命名迁移：`exec_command` 从 119,754 降至 32,181，而 `exec` 从 0 增至 42,054；`write_stdin` 下降时，`wait` 同期上升。Agent 应先验证 alias，再解释行为变化。

## 问题 2：哪些 Tool 一直失败，同一尝试链后来成功了吗？

> 请按绝对失败量和失败率分别找出 Tool 热点，并判断代表性失败链是后来成功、从未成功，还是被放弃。

| Tool | 失败 / 调用 | 失败率 | Agent 判断的优先级 |
|---|---:|---:|---|
| `Bash` | 329 / 13,674 | 2.41% | 绝对失败量最高，最适合先做错误分类 |
| `ExitPlanMode` | 39 / 47 | 82.98% | 39 次失败、8 次终态未知、没有完成记录 |
| `Write` | 25 / 482 | 5.19% | 大部分终态未知，需先改善记录再判断可靠性 |
| `WebFetch` | 9 / 9 | 100% | 没有成功记录，应检查是否仍应启用 |
| 已下线 MCP 搜索 | 4 / 4 | 100% | 清理仍在引用旧能力的工作流 |

Agent 在同一索引中统计到 307,956 个候选链。返回的 50 条代表链全部是 `never-succeeded`，其中 34 条来自 `Bash`；这些具体失败链都没有记录到后续成功。

**有价值的回答**：先治理 `Bash` 能减少最多重试；同时应删除 100% 失败的退役集成。高失败率和高失败量是两种不同问题，不能合成一个不透明分数。

**下一步**：按更短时间窗下钻 `Bash`，读取代表链的完整证据，把失败分成环境缺失、命令错误、权限、超时和并发冲突，再决定修文档、修工具还是修 Agent 提示。

本次按单个 Tool 缩小范围的下钻没有完成。因此报告能确认返回的 50 条链没有恢复，但不把它们外推成所有 Tool 的完整恢复率。

Top 5 不是总体分布。Tool terminal state 与 containing Turn outcome 也是两条不同事实轴；“同一 Turn 共现”不能写成“Tool 失败导致任务失败”。

## 问题 3：哪些 Session 偏研究、偏实现，哪些缺少文档支撑？

> 请找出偏研究、偏实现、缺少配套文档或实现与规格脱节的 Session，并解释判断依据，不评价代码质量。

工作流分析统计到 633 个 Session。Top 5 全部被估计为 `implementationHeavy`；最密集的两个 Session 分别涉及 224 和 241 个 distinct path。

其中一个代表 Session 记录了 248 次文件尝试、53 个 distinct path 和 21 次失败，同时有 428 个 document-like 事件。它不是 doc void，更像“有文档支撑但执行摩擦较高”的实现任务。

**有价值的回答**：当前排名由大规模实现任务主导。对团队复盘更有用的分组是“高实现量且低失败”与“高实现量且高失败”，而不是简单地把文件多解释成产出高。

**下一步**：让 Agent 对高失败 Session 展开完整时间线，检查失败集中在哪个阶段；对 doc void 或 spec precision gap Session，再验证是否真的缺少设计材料，而不是适配器未记录到文档事件。

`implementationHeavy`、`researchHeavy`、`docVoid` 和 `specPrecisionGap` 都是版本化估计。它们描述被记录的文件工作流，不是质量评分。

## 问题 4：活动强度和项目切换何时发生变化？

> 请比较最近 13 个完整 UTC 周与前一个等长窗口，找出 Turn、Tool、Skill 和 context transition 的变化，并指出峰值周。

| 指标 | 对照窗口 | 当前窗口 | 变化 |
|---|---:|---:|---:|
| Turn | 6,988 | 3,474 | -50.3% |
| Tool invocation | 158,944 | 107,831 | -32.2% |
| Skill invocation | 1 | 90 | +89 |
| 每 Turn Tool 调用 | 22.7 | 31.0 | +36.4% |

最后一个完整周贡献了当前窗口 29.7% 的 Turn、49.8% 的 Tool invocation，以及 86.7% 的 recorded context transition。

**有价值的回答**：snapshot 中记录的 Turn 变少，但单个 Turn 的工具密度明显上升，工作更集中在少数高编排任务。Skill 从几乎未记录增长到 90 次，也说明显式工作流开始替代临时操作。

**下一步**：把峰值周与交付结果、失败链和 Session workflow 联合分析。若高 Tool 密度没有带来更多验证通过或可复用产物，应优先减少轮询、等待和协调开销。

Context transition 是连续事件中的项目变化信号，不等于人的注意力切换，也不能直接解释为生产力下降。对照窗口前三周没有记录活动，复用比较时应单独核查 coverage。

## 问题 5：哪些 provider、model、project 组合消耗了最多 token？

> 请找出最近 13 周的 token 热点，分别报告 input、cached input、output 和 reasoning，并说明缺失指标。

查询得到 326 个热点组。排名第一的组记录了约 28.44 亿 total token，其中 input 约 28.28 亿、cached input 约 27.72 亿、output 约 640 万、reasoning 约 228 万。

该组 cached input 约占 input 的 98.0%。Top 5 都来自 Codex 记录，但 model 字段为空；当前适配器也不提供 capability 级 token 归因。

**有价值的回答**：主要成本信号不是“输出太长”，而是超大上下文反复进入请求；其中绝大部分被缓存复用。优化时应先比较未缓存 input、output 和任务结果，而不是只按 total 排名。

**下一步**：按 project group 比较未缓存 input / Turn、output / Turn 和成功交付，找出“上下文反复重建”的组。高 cached 比例是复用信号，不能直接换算为费用节省。

本次 coverage 标记为 partial：139,191 个匹配事件缺少至少一种 token metric，`cacheWriteInput` 也没有记录。缺失值不能按 0 处理，Tool 或 Skill 共现更不能被当成 token 归因。

## 问题 6：以前出现相似错误时，后来怎样解决？

> 我又遇到了 macOS `LC_UUID` 相关问题。请搜索相似历史，找到同一尝试链中随后成功的步骤，只返回有证据的历史做法。

全局 Search 找到 233 个相关 Turn。Agent 选中一个发布审查 Session 后，把范围收敛到 21 个相关事件；返回的前 10 个事件中，有 4 个关联到了同一 attempt chain 的后续成功事件。

**Agent 给出的历史答案**：移除导致 Mach-O 缺少 UUID 的 linker flag；在两次构建产物上用 `otool -l` 正向断言 `LC_UUID`；把检查放在 `cmp` 和复制之前，并继续执行签名、公证后的真实产物 smoke。

历史记录还显示该路径随后通过了定向测试、release 测试和独立审查。它比“尝试重新构建”更有价值，因为答案包含失败签名、修正动作、验证顺序和成功证据。

**下一步**：Agent 应把这个历史方案当作候选操作，再核对当前 toolchain 与 workflow 是否相同。这份证据只证明“历史上随后观察到成功”，不保证同一步骤必然解决当前环境。

像 `TS_OPERATION_FAILED` 这样的通用词会被拒绝为过宽查询。Agent 应先定位具体错误、项目或 Session，再读取相关尝试链，既更快，也能避免把不相关历史拼成伪答案。

## 问题 7：某个 Session 中到底发生了什么？

> 请按原始顺序总结刚才定位出的发布审查 Session 中的消息、Tool、token 和 lifecycle 事件。不要把分页首屏当成完整时间线。

该 Session 在查询窗口内共有 223 个事件。首个有界页面返回 50 个：9 个 capability invocation、9 个 capability result、20 个 token usage、3 个 visible message，以及 9 个 provider-unknown 事件。

这 50 个事件全部来自 main scope，completeness 都是 `full`，时间跨度约 2 分 30 秒。首屏没有 compaction、rollback、resume、fork 或 lifecycle 事件，但这不能证明后续 173 个事件也没有。

**有价值的回答**：Agent 可以把“收到审查任务 -> 执行检查 -> 读取结果 -> 形成结论”的顺序还原出来，并精确区分 Tool 调用与 Tool 结果。它适合解释为何作出某个判断，而不是只看最终回答。

**下一步**：继续分页直到 `truncated=false`，再按 revision 获取关键 event evidence。若问题只关心 rollback 或 compaction，可缩小窗口或过滤 event kind，避免把整个 Session 塞进 Agent 上下文。

时间线是证据索引，不是自动生成的因果故事。`provider-unknown` 与缺少 lifecycle 事件都应如实保留，Agent 不应根据相邻顺序补写不存在的关系。

## Agent 使用方式

1. 先运行 `threadshare insights sync`，再用 `threadshare insights status --format json` 记录当前索引状态。日常使用增量 `sync`；只有明确需要完整原子重建时才用 `reindex`。
2. 先用 `overview`、`usage` 或 `activity` 做聚合定位。要求 Agent 固定 UTC 窗口，并报告 snapshot、分子、分母和 coverage。
3. 用户只描述具体分析问题；Agent 自行选择查询、过滤条件和内部分析计划。大索引不要从通用词或无限时间窗开始。
4. 内部分析计划只返回结构化事实、派生信号、估计和 evidence target。让 Agent 明确区分四者，并检查 `truncated`、`coverage.degraded` 与 diagnostics。
5. 对要引用的结论再运行 `insights evidence`。保留 revision；若 revision 已变化，重新查询，不要把旧 evidence 与新 snapshot 混用。

Agent 的底层入口以 `threadshare insights spec --format json`、`threadshare insights --help` 和已发布 JSON Schema 为准。用户不需要记忆或选择这些协议。
