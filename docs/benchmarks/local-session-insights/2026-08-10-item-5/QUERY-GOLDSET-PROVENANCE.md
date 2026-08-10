# ITEM-5 query gold set provenance

## Acceptance set

`test/fixtures/insights-query-evaluation.v2.json` 中的 `acceptance` 数据集来源于本项目当前设计与实现对话里真实出现的用户请求。它不是从本机 Session 目录复制的原始记录，也不包含 Agent、reviewer 或工具输出生成的提问。

数据集包含 60 个用户请求原子子句。复合消息按独立动作或约束拆分；重复消息只有在承载不同动作、环境或验收条件时才保留。`sourceRef` 是仓库内不可逆的顺序引用，不对应 provider session、message id、文件偏移或本机路径。

为了满足冻结评测的语言分层，同一主题下的不同真实子句可能被改写为中文、英文或中英混合/代码表达。每条查询通过 `transformation` 明确区分语言保持改写与翻译改写。它们是 real-derived queries，不是逐字原文，也不能解释为 60 个统计独立的 Session。

Acceptance corpus 同样包含 60 个去敏历史问题文档，中文、英文、中英混合/代码各 20 个。每条 query 对全部 60 篇文档都有显式 judgment；跨语言文档固定为 0，英文翻译改写查询对应英文历史问题摘要，中英混合查询对应中英混合历史问题摘要，不再让英文查询以中文文档作为唯一 gold target。

Lexical BM25 v1 不承诺跨语言翻译召回，cross-language translation retrieval 不属于本轮 acceptance scope。未来若要评估这一能力，必须建立独立的 cross-language set 和明确的 backend 决策，不能把其失败混入当前 Recall/NDCG gate。

## Deidentification

提交前执行以下裁剪：

1. 删除服务 URL、域名、用户目录、仓库绝对路径和本机会话目录。
2. 删除 UUID、session/message id、hash、账号、邮箱和时间定位信息。
3. 保留公开技术标识符，例如 `format=agent`、`SKILL.md`、`Fact Model v1`、`Cloudflare` 和 `$cs-epic`，因为精确 identifier 召回属于 Epic 验收面。
4. 将原问题与回复改写成最小可判定文本，不提交原始上下文、Tool payload、thinking 或系统提示词。

校验器对 URL、邮箱、UUID、64 位十六进制值、用户目录和 provider Session 目录形状 fail closed。原始对话只留在本地，不属于 benchmark artifact。

## Relevance labels

`acceptance.documents` 是从同一真实对话主题整理出的去敏 Turn 摘要，不是合成性能语料，也不是逐字会话导出。Judgment policy 固定为 `threadshare-query-judgments@v2`：

- `3`: 直接满足查询的主要 Turn。
- `2`: 可独立满足主要查询意图的 Turn。
- `1`: 有用背景，但不构成 Recall 目标。
- `0`: 不相关。

每条查询至少有一个 relevance `3` 的主要文档；不再为了凑 Recall 分母而强制第二个正例。60 条查询与 60 篇文档在不提供 Engine 分数、命中词或排序的情况下完成盲标，query/document 文本在盲标前后保持不变。成对主题会共享词面，例如 Agent link 与 URL review、Tool 与 Skill evidence、performance 与 index design；query 文本不复制主要文档的原句，也不注入一问一唯一 token。因此 Engine 仍需在近邻文档间完成召回和排序，而不是靠语言桶或唯一标记直接通过。

candidate Recall@300 与 Top-20 Recall 只统计 relevance `>=2`；NDCG@10 使用完整 0–3 等级。报告另列 grade-3 hit rate、grade-1 contextual coverage、judgment policy 和 qrel SHA-256。任何未标注文档、公开结果不属于候选集合或候选超过 300 条时 evaluation fail closed。指标只从 production SearchTrace 与公开排序结果计算；fixture 本身不包含 Engine 成绩，也不证明任何 gate 已通过。

## Development set

同一 JSON 文件顶层的 30 篇文档和 30 条 `development` 查询来自 ITEM-5 实现前完成的
独立设计与契约审查 findings，覆盖 analyzer drift、FTS vocabulary scan、失败重试、Skill
证据、rollback、filter-before-limit、CJK/code analyzer、commit/ACK 崩溃、revision cursor
和原生包发布顺序。它们经过去标识与三种语言形态改写，provenance 固定为
`review-derived-deidentified-development`，source 固定为
`pre-item5-independent-design-and-contract-review-findings`。

这个 development set 与 acceptance set 的来源分离：前者来自 reviewer findings，后者来自
当前对话中的真实用户 prompt 原子意图。它不是生产 session 的统计样本，也不用于最终
Recall/NDCG acceptance。正式消融只使用其 `development` split，并在报告中明确
`fixed-production-candidates-rerank-only`：候选来自一次真实 Engine 查询，变体仅重新计算公开
排序分量，不重新执行各自的 FTS 候选生成。

顶层其余 `evaluation` 查询继续只用于指标数学和错误边界单元测试。正式质量验收默认且只能
显式报告 `real-acceptance` 的 provenance；报告同时写入 `dataset` 与 `provenance`，防止把
development/unit 结果误当成真实 gold-set 结果。
