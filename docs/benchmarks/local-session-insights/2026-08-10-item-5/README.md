# ITEM-5 查询基准证据

本目录用于归档 ITEM-5 的方法说明。通过验收的七件证据只写入固定子目录
`evidence/`；大规模 runner 先把六份报告写到仓库外的临时目录，packager 完成全部
校验后才原子安装该子目录。原始 session、本机路径、session 标识符和 benchmark
数据库均不得提交。

## 必需报告

1. `capacity-25k-query.acceptance.json`：25,000 Turn，预热后至少测量 1,000 次
   查询，同时覆盖 `pathLimit=0` 和 `pathLimit=10`；mutation 后另用同源 clean
   rebuild 跑 100 个同钟确定性查询，逐项比较 candidate、最终顺序和 Tool family。
2. `capacity-250k-query.acceptance.json`：250,000 Turn，同样覆盖两组查询，且每组
   至少测量 1,000 次。
3. `quality.acceptance.json`：冻结的去敏 evaluation set Recall@300、Top-20 Recall
   和 NDCG@10。
4. `ablation.acceptance.json`：development set 排序分量消融结果。
5. `candidate-25k.acceptance.json`：冻结 gold Turn 注入 25,000 个单-term 干扰 Turn
   后的 candidate Recall@300，且至少一条查询真实达到 300 候选上限。
6. `real-sample-30pct.acceptance.json`：按原始字节抽取的本机 30% 分层样本 detail-full
   FTS 实测及 250,000 Turn 容量外推。
7. `manifest.json`：所有 gate 通过后，记录脚本、fixture、报告、源码 commit 和
   Engine build identity 的哈希。

以上文件最终位于 `evidence/`。packager 不覆盖已有目录，防止失败或重跑混入旧证据。

## 复现命令

先在已经提交且 clean 的候选 commit 上构建 Engine。两个容量报告需要分开运行，避免
RSS 和文件系统测量互相干扰；六份原始报告全部写到临时目录：

```bash
export THREADSHARE_RELEASE_VERSION="$(node -p "require('./package.json').version")"
export THREADSHARE_ENGINE_TARGET="$(node --input-type=module -e "import { insightsEngineTarget } from './src/insights-engine-targets.mjs'; const target = insightsEngineTarget(); if (!target) process.exit(1); process.stdout.write(target.target);")"
cargo build --locked --release --manifest-path crates/insights-engine/Cargo.toml
ITEM5_REPORT_DIR="$(mktemp -d)"
node scripts/benchmark-insights-engine.mjs \
  --query-benchmark --formal --turns 25000 --turns-per-session 100 \
  --queries 1000 --warmup 100 --seed threadshare-insights-query-25k-v1 \
  --output "$ITEM5_REPORT_DIR/capacity-25k-query.acceptance.json"
node scripts/benchmark-insights-engine.mjs \
  --query-benchmark --formal --turns 250000 --turns-per-session 100 \
  --queries 1000 --warmup 100 --seed threadshare-insights-query-250k-v1 \
  --output "$ITEM5_REPORT_DIR/capacity-250k-query.acceptance.json"
node scripts/run-insights-query-quality.mjs \
  --formal \
  --fixture test/fixtures/insights-query-evaluation.v2.json \
  --engine crates/insights-engine/target/release/threadshare-insights-engine \
  --output "$ITEM5_REPORT_DIR/quality.acceptance.json" \
  --ablation-output "$ITEM5_REPORT_DIR/ablation.acceptance.json" \
  --candidate-output "$ITEM5_REPORT_DIR/candidate-25k.acceptance.json"
node scripts/benchmark-insights-real-sample.mjs \
  --execute \
  --engine crates/insights-engine/target/release/threadshare-insights-engine \
  --output "$ITEM5_REPORT_DIR/real-sample-30pct.acceptance.json"
node scripts/package-insights-benchmark-evidence.mjs \
  --input-dir "$ITEM5_REPORT_DIR" \
  --output-dir docs/benchmarks/local-session-insights/2026-08-10-item-5/evidence \
  --engine crates/insights-engine/target/release/threadshare-insights-engine
```

任一正式 gate 为 false 时对应 runner 退出 1。packager 还会拒绝 dirty worktree、commit
或 Engine binary/build identity 不一致、脚本/fixture/Epic 哈希漂移、规模或 seed 漂移，
以及包含绝对路径、URL、IP、凭据、session/Turn/source/project 标识的报告。

runner 会通过真实 `SEARCH_TURNS` 协议测量两轮：一轮关闭 Tool path，另一轮使用
`pathLimit=10`。报告包含 P50/P95/P99、查询阶段 sidecar RSS、detail-full FTS
字节数、全部派生状态字节数，以及 Engine 的 analyzer、document-frequency、rerank
和 Tool-path 耗时。Engine 当前只提供 posting traversal 与 SQL filter intersection
的合并耗时，因此报告明确命名为 `postingAndFilterCombined`，不会伪造无法证明的拆分。

机械预算按 Epic 和 corpus 规模选择：25k 要求 P95 <100 ms、P99 <250 ms、RSS
<96 MiB、全部派生状态 <1 GiB；250k 要求 P95 <200 ms、P99 <500 ms、RSS
<128 MiB、全部派生状态 <8 GiB。两者都要求 detail-full FTS <400 MiB。25k/250k
验收若每组不足 1,000 次测量，会在生成通过 gate 之前被拒绝。

25k mutation trace 还会把 replace/delete/exclude/purge 后的增量库与同源 clean
rebuild 库置于同一 `nowUnixMs` 和 quiescence 配置下，固定执行 100 个互不重复的
`pathLimit=10` 双 term 查询。报告要求两侧 100/100 查询都有结果和非空 Tool family，
只保存 candidate turn key 序列、公开结果 turn key 顺序和 Tool family
fingerprint/medoid/member 分组的聚合 SHA-256，不保存任何 key；覆盖计数或三类摘要任一
不符合都会让正式 gate 与 packager 失败。`clockIdentity` 是同一注入时钟的可审计记录，
不是对墙钟漂移的采样。此处等价性只覆盖 Epic 要求的 candidate、公开结果顺序与 Tool
family 三轴，不声称 generation、revision、score 或 snapshot 坐标逐字段相等。250k
继续承担长期容量和延迟门槛，避免为同一正确性断言额外构建第二份 2 GiB 以上数据库。

质量 runner 的正式排名报告只加载 fixture 中的 `real-acceptance` 数据集：先把去标识
文档作为 Fact 提交到一次性临时数据库，再逐条调用真实 Rust sidecar 的
`SEARCH_TURNS`。Recall 只统计 relevance `>=2`，NDCG 保留 0–3 全等级；全部 60 篇
文档都有显式 qrel，未标注结果直接失败。Top-20 Recall 和 NDCG@10 使用公开排序结果，
不会用 synthetic outcomes 替代实测结果。

candidate-scale 报告使用同一冻结 query/qrel，但另加入 25,000 个去敏干扰 Turn。每个
干扰 Turn 只包含 Engine 在插入前选出的一个 scoring term，gold query/document 文本
保持不变；该报告只计算 gold target 的 Recall@300，不把未人工标注的干扰 Turn 用于
Top-20/NDCG。development 消融使用 ITEM-5 实现前独立设计审查 findings 整理出的去敏
development set，与 acceptance 的用户 prompt 来源分离。它基于真实 Engine 产生的一次
固定候选集，分别移除 BM25 rank、IDF coverage 和 exact substring 后稳定重排；不会伪称
每个变体都重新执行 FTS 候选生成。报告记录这一限制、当前 runner hash 和 Engine build
hash，临时数据库在返回前删除。任一质量或 candidate-scale gate 未通过时仍写出报告供
诊断，但进程以退出码 1 结束，不能把失败运行收进 acceptance manifest。
