# 用 Insights 分析 Agent 编程工作：一个真实索引案例

这份报告演示如何让 Agent 基于 Threadshare Insights 回答比“搜到哪段对话”更有价值的问题：工作方式是否变化、哪些 Skill 真正进入日常流程、Tool 失败应先治理哪里，以及上下文成本是否得到有效复用。

报告使用一个真实的本地个人索引，但只保留聚合结果和经过归类的结论。代表 Turn 文本、项目 key、本地路径、稳定记录 key 和 snapshot token 均不进入本文。

## 分析边界

正文中的分析数字来自 committed snapshot `3657`。生成初稿时，索引状态为 `ready`，SQLite quick check 与 FTS integrity check 均为 `ok`，但一次 `sync` 返回了 `TS_OPERATION_FAILED`；因此正文保留当时的历史口径，不把 snapshot `3657` 表述为原始文件的最新完整视图。该故障随后推动了大 Session 分块 staging、活跃文件重试与大库查询分段优化；修复后的同一索引已成功同步到 snapshot `3718`，`failed=0`。

| 指标 | 观测值 |
|---|---:|
| 原始 Session | 3,634 |
| 可分析 main Session | 3,046 |
| 排除的 subagent Session | 587 |
| 已索引 Turn | 11,488 |
| Capability | 207（176 Tool、31 Skill） |
| 本地派生状态 | 约 12.1 GiB |

趋势窗口使用 13 个完整 UTC 周：

- 当前窗口：`2026-05-11T00:00:00.000Z` 至 `2026-08-10T00:00:00.000Z`
- 对照窗口：`2026-02-09T00:00:00.000Z` 至 `2026-05-11T00:00:00.000Z`

Insights 查询不会读取原始 provider 文件，也不会隐式运行 `sync`。所有 response 的 `sourceFreshness` 均为 `not-evaluated`，因此本文只声称“snapshot 中记录了什么”，不声称 snapshot 与报告生成瞬间的原始文件完全同步。

## 结论 1：snapshot 记录的 Turn 减少，但单个 Turn 的工具密度上升

| 指标 | 对照窗口 | 当前窗口 | 变化 |
|---|---:|---:|---:|
| Turn | 6,988 | 3,489 | -50.1% |
| Tool 调用 | 158,944 | 107,972 | -32.1% |
| 每 Turn Tool 调用 | 22.7 | 30.9 | +36.1% |

这不能直接解释为“实际工作量减半”。当前窗口在 snapshot 中记录的 Turn 数减半，但每个 Turn 内的工具调用更密集，说明任务形态可能正在向更长、更自动化、编排程度更高的工作集中。对照窗口的前三周没有记录活动，也应在复用这个比较时单独核查。

最后一个完整周尤其突出：它占当前窗口 29.8% 的 Turn，却占 49.8% 的 Tool 调用。对 Agent 工作流更有意义的后续问题不是“为什么少了一半 Turn”，而是：

1. 高密度 Turn 是否产出了更多已验证结果；
2. 调用增长来自实现工作，还是轮询、等待和协调开销；
3. 是否有少数长任务贡献了过多失败重试与上下文成本。

## 结论 2：Skill 已进入正式工程流程，但使用高度集中

当前窗口记录了 90 次 Skill invocation。前两个 Skill 占 48.9%，前五个占 60.0%。

| Skill | 调用 | Turn | Session / dedupe group | 代表性使用场景 |
|---|---:|---:|---:|---|
| `codestable:cs-review` | 24 | 24 | 24 / 24 | 冻结 diff、独立代码或设计审查、契约与证据核验 |
| `cs` | 20 | 20 | 9 / 8 | 实现前讨论、设计收敛、canonical 文档决策 |
| `codestable:cs-epic` | 4 | 4 | 2 / 2 | 多阶段迁移、长程功能交付、阶段验收 |
| `paseo` | 3 | 3 | 3 / 3 | 多 Agent 分工、团队协调、并行实现与验证 |
| `cs-onboard` | 3 | 3 | 3 / 3 | 新仓库接入、基线合同与维护边界建立 |

代表性场景来自标记为 partial coverage 的 `capability-contexts@1`，适合生成调查假设，不适合声称覆盖了全部 Skill 使用。这里能得出“这些 Skill 在哪些场景被记录使用”，不能得出“这些 Skill 导致任务成功”。尤其是 `cs` 的 20 次调用只分布在 8 个 dedupe group，说明一次工作中可能多次进入同一流程；调用数不能直接当成 20 个独立成功案例。

另一个数据治理信号是命名分裂：`cs-onboard` 与 `codestable:cs-onboard` 分别记录了 3 次。如果要做长期采用率分析，应先把 provider 前缀和历史别名归并为 capability family，否则排行榜会低估同一工作流。

## 结论 3：Tool 名称迁移会制造假的趋势拐点

当前窗口最显眼的 Tool 变化包括：

| Tool | 对照窗口 | 当前窗口 | 表面变化 |
|---|---:|---:|---:|
| `exec_command` | 119,754 | 32,181 | -87,573 |
| `exec` | 0 | 42,054 | +42,054 |
| `write_stdin` | 22,737 | 4,025 | -18,712 |
| `wait` | 199 | 7,943 | +7,744 |

这更像运行时或工具协议迁移，而不是 Agent 突然改变了基本行为。代表 Turn 也显示这些 Tool 仍主要共同出现在代码修改、测试、长进程等待和 Agent 协调任务中。

因此，跨版本趋势分析必须先做两层归一化：

1. 精确 capability：保留原始 provider 与 canonical name，用于证据下钻；
2. 功能 family：把已确认的历史别名或替代能力合并，用于趋势比较。

在没有 alias 证据时，Agent 应报告“可能发生命名迁移”，不能把 `exec` 的增长写成新增了 42,054 次独立行为。

## 结论 4：失败治理要同时看绝对量和失败率

| Tool | 失败 / 调用 | 失败率 | 适合回答的问题 |
|---|---:|---:|---|
| `Bash` | 248 / 9,616 | 2.58% | 哪类 shell 错误贡献了最多可消除的重试？ |
| `ExitPlanMode` | 18 / 21 | 85.71% | 是否存在协议、状态机或交互前提不匹配？ |
| `Write` | 14 / 337 | 4.15% | 写入失败是否集中在路径、权限或冲突？ |
| `WebFetch` | 8 / 8 | 100% | 该集成是否在环境中不可用或已被替代？ |
| `mcp__codebase-memory-mcp__search_code` | 4 / 4 | 100% | 已下线依赖是否仍被旧工作流调用？ |

`Bash` 是“绝对失败量”优先级最高的对象；`ExitPlanMode`、`WebFetch` 和已下线 MCP 是“失败率或环境兼容性”问题。两种优先级不能混成一个分数。

这些数字是 invocation terminal state，而且本次失败榜主要来自 Claude 的结构化终态记录；不能把 Codex Tool 的零失败计数解释为没有失败。Containing Turn outcome 是另一条事实轴；本次 Claude Tool 所在 Turn 的 outcome 覆盖大多为 `unknown`。因此不能说“Tool 失败导致 Turn 被放弃”，只能说两者可能共现，随后应使用 `failure-chains@1` 和 evidence 验证具体链条。

## 结论 5：上下文复用很强，但 token 结论需要覆盖说明

最大的一组已记录 token hotspot 包含约 28.28 亿 input token，其中约 27.72 亿为 cached input，比例约 98.0%。因此该组记录主要由 cached input 构成；这提示应优先分析上下文复用，不能单凭这个比例证明节省了多少费用。

但这个数字不能直接解释为费用：

- provider 的 token 与计费口径可能不同；
- `token-hotspots@1` 在本次运行中标记为 partial coverage；
- 139,662 个匹配事件缺少至少一种 token metric；
- capability attribution 为 `unavailable`，不能把 token 成本归因给某个 Tool 或 Skill。

更可靠的优化方向是比较“非缓存 input、output、reasoning 与任务结果”，而不是只按 total token 排名。若一个项目总 token 很高但 cached input 比例也很高，它与“每次都重新注入大量未缓存上下文”是两类问题。

## 可复用的 Agent 分析流程

### 1. 固定 snapshot 与完整周窗口

```bash
threadshare insights status --format json
threadshare insights overview --format json
```

先记录 snapshot seq、integrity、coverage 和 `sourceFreshness`。时间趋势优先使用完整 UTC 周，避免把尚未结束的一周误判为下降。

### 2. 先聚合，再读取上下文

`usage.json`：

```json
{
  "format": "threadshare-insights-usage-request@v1",
  "window": {
    "observedAtOrAfter": "2026-05-11T00:00:00.000Z",
    "observedBefore": "2026-08-10T00:00:00.000Z"
  },
  "comparisonWindow": {
    "observedAtOrAfter": "2026-02-09T00:00:00.000Z",
    "observedBefore": "2026-05-11T00:00:00.000Z"
  },
  "orderBy": "recorded-invocation-count",
  "limit": 15
}
```

```bash
threadshare insights usage skill --request usage.json --format json > usage-result.json
threadshare insights usage tool --request usage.json --format json
```

先用 Usage 找 capability key，再把少量 key 传给 `capability-contexts@1`。不要一开始就拉取所有代表 Turn。

```bash
jq '{format:"threadshare-insights-recipe-request@v1",window:{after:.window.observedAtOrAfter,before:.window.observedBefore},filters:{capabilityKeys:[.items[:5][].capabilityKey]},limit:5,allowDegraded:true}' usage-result.json > contexts.json
threadshare insights recipe capability-contexts@1 --request contexts.json --format json
```

### 3. 把失败量与失败率拆开

把 `orderBy` 改成 `recorded-failing-invocation-count`，先定位绝对失败热点；再由 Agent 计算 `failed / invocation`，识别低频但高失败率的集成。任何结论都应同时给出分子和分母。

### 4. 用 recipe 定位，用 evidence 定案

```bash
threadshare insights recipe capability-contexts@1 --request recipe.json --format json
threadshare insights recipe failure-chains@1 --request recipe.json --format json
threadshare insights recipe solution-recall@1 --request recall.json --format json
```

Recipe 返回的是 recorded facts、derived signals、estimates 与 evidence target，不是自然语言裁决。Agent 应保留 revision，并在需要引用完整输入、输出或错误时再调用 `evidence`。

### 5. 给每个结论附上限制

至少回答以下问题：

- 数据是否 fresh，还是仅来自 committed snapshot；
- invocation 是否可能被重复 Session 或 alias 放大；
- terminal state 与 containing Turn outcome 是否被分开；
- recipe 是否 `degraded`，缺少哪些时间戳、revision、payload 或 token metric；
- 当前结论是记录事实、派生信号、估计，还是 Agent 的解释。

## 下一轮最有价值的探索

1. **失败恢复**：对 `Bash` 和 `ExitPlanMode` 分别跑小窗口 `failure-chains@1`，区分最终恢复、从未成功与放弃。
2. **方案复用**：针对反复出现的构建、发布、索引和协议错误跑 `solution-recall@1`，引用后续成功 attempt，而不是只做文本相似搜索。
3. **编程闭环**：用 `file-workflow-signals@1` 找 research-heavy、implementation-heavy、doc void 与 spec precision gap Session，并核对代表 evidence。
4. **上下文成本**：按项目比较未缓存 input 与 output，识别“上下文反复重建”而非“缓存复用良好”的热点。
5. **编排效率**：把 `spawn/create → wait → review → fix` 作为功能 family 观察，衡量协调调用是否随可验证交付同步增长。

修复后，同一约 13 GiB 索引上的宽范围查询均成功：`failure-chains@1` 统计到 144,710 个候选链，`file-workflow-signals@1` 统计到 633 个 Session，`activity-shifts@1` 返回 13 个周 bucket。前两类只返回 Top 5 明细并明确标记 `truncated`；三类结果都保留 `TS_INSIGHTS_RECIPE_PARTIAL_COVERAGE`，用于提醒 Agent 聚合总量是精确结果，但代表明细和部分事件字段并不完整。推荐顺序仍然是：大索引先聚合定位，再按 capability、project、session 或更短时间窗做有界下钻。
