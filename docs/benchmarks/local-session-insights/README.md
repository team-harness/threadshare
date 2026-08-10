# Local Session Insights 测试数据索引

这里汇总 Local Session Insights 的大规模验收证据。仓库只保存可复核的去标识聚合
JSON、manifest、生成参数与哈希；原始 session、prompt/answer、真实 source/user 绝对
路径、真实 session 身份、SQLite/WAL/SHM 和多 GiB 临时语料均不进入版本库或 npm 包。
报告可以保留通用临时目录和确定性合成 benchmark ID，它们不对应用户数据。

## 证据包

| 目录 | 覆盖范围 | 最大规模 | 主要结论 |
|---|---|---:|---|
| [`2026-08-10/`](2026-08-10/) | ITEM-4 回填、增量、事务、容量与隐私清除 | 10,000 session / 250,000 Turn | raw 回填 12.736 MiB/s；250k 派生状态约 2.53 GiB；全部正式 gate 通过 |
| [`2026-08-10-item-5/`](2026-08-10-item-5/) | ITEM-5 查询质量、延迟、mutation 等价与真实样本外推 | 250,000 Turn / 本机约 30% 字节样本 | Recall@300 0.925；Top-20 Recall 0.925；NDCG@10 0.790453；250k P99 低于 144 ms |

ITEM-4 目录另外保留一份受主机竞争影响的失败运行，证明吞吐和 freshness 门槛会真实
失败，而不是只保存通过样本。ITEM-5 的 `evidence/manifest.json` 绑定 source commit、
Engine build、批准 Epic、脚本、fixture、qrel 和六份报告的 SHA-256。

ITEM-4 是里程碑提交前捕获的历史证据，manifest 因而如实记录
`sourceWorktreeDirty=true`。其 benchmark script SHA-256 为 `e86f6cf6...d30161fe`，与
最终评审并提交的 ITEM-4 milestone `53080c9d45e846907eea4341f84deae6e20058d9`
中的脚本逐字节相同；报告和脚本哈希共同绑定了被测候选。ITEM-5 则由 clean committed
worktree 生成并由 packager 拒绝 dirty source。

ITEM-6 复用同一 capacity runner，并新增 `READ_INSIGHTS_OVERVIEW` 的响应完整性、
snapshot/payload 稳定性和 25k/250k P95/P99 gate；不复制已有多 GiB corpus。仓库测试中的
800 Turn real-sidecar 运行只证明 gate 和协议可执行，不替代上表已经归档的 250,000 Turn
容量与查询证据。后续若从 clean commit 生成新的 ITEM-6 正式报告，应新建独立 manifest，
不得覆盖 ITEM-4/5 历史目录。

## 数据边界

- 真实 Provider 语料只在本机临时目录中被确定性抽样和分析，报告只保留文件数、字节数、
  Turn 数、分层比例、容量外推与哈希。
- 合成容量语料由固定 seed 生成，运行结束后删除；仓库不保存生成后的 JSONL 或数据库。
- mutation 等价报告只保存候选、公开排序和 Tool family 三个摘要的 SHA-256，不保存
  session、Turn、source、project 或 Capability stable key。
- `package.json.files` 和 release allowlist 不包含 `docs/`，这些证据不会随 npm 安装分发。

## 复核入口

每个证据包的 README 给出完整复现命令和机械 gate。快速检查已归档证据：

```bash
jq -e '.gates | all(. == true)' \
  docs/benchmarks/local-session-insights/2026-08-10/raw-backfill-10k.acceptance.json
node docs/benchmarks/local-session-insights/verify-evidence.mjs
npm run test:insights-engine
```

性能时长会随硬件和负载变化；corpus identity、结构计数、来源哈希、隐私校验与 gate
语义必须保持可复现。新证据应从 clean committed worktree 生成；上述 ITEM-4 历史例外
必须同时保留 dirty 标记、候选说明与可对照的提交脚本哈希。失败运行不能覆盖已通过的
evidence 目录。
