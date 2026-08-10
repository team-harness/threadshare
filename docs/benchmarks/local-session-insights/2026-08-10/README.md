# Local Session Insights ITEM-4 验收数据

这组证据固定了 ITEM-4 的真实 Provider 回填、增量 freshness、normalized Fact 容量、FTS 密度、RSS、SQLite 页对账和 mutation 结果。正式通过数据与受竞争影响的失败样本分开保存；host load 只解释环境，不放宽门禁。

## 结果

| 证据 | 规模 | 核心结果 | 判定 |
|---|---:|---|---|
| `raw-backfill-10k.acceptance.json` | 10,000 session / 2.965 GB raw | 12.736 MiB/s；最新 100 个 2.441 s；append 0.975 s；单 startup cycle | 通过 |
| `capacity-5k.acceptance.json` | 5,000 Turn | Engine 240.3 Turn/s；稳态 53.89 MiB；710,000 postings | 通过 |
| `capacity-25k.acceptance.json` | 25,000 Turn | Engine 208.7 Turn/s；稳态 263.31 MiB；3,550,000 postings | 通过 |
| `capacity-250k.acceptance.json` | 250,000 Turn | Engine 221.4 Turn/s；稳态 2.53 GiB；35,500,000 postings | 通过 |
| `raw-backfill-10k.contended-failure.json` | 10,000 session / 2.965 GB raw | 9.280 MiB/s；append 2.045 s；结束时 1 分钟 load 13.74 | 失败反例 |

四份 acceptance 的 corpus、落盘事实、FTS、rollup、完整性和性能门禁全部通过。失败反例同样完成了 10,000/10,000 source 对账，失败仅来自吞吐和 append freshness 门槛，不能作为通过证据。

## 复现

先构建当前候选的 release Engine：

```bash
cargo build --release --manifest-path crates/insights-engine/Cargo.toml --locked
```

运行三档容量基准：

```bash
node scripts/benchmark-insights-engine.mjs --capacity --turns 5000 --turns-per-session 100 --output /tmp/threadshare-insights-capacity-5k.json
node scripts/benchmark-insights-engine.mjs --capacity --turns 25000 --turns-per-session 100 --output /tmp/threadshare-insights-capacity-25k.json
node scripts/benchmark-insights-engine.mjs --capacity --turns 250000 --turns-per-session 100 --output /tmp/threadshare-insights-capacity-250k.json
```

运行真实 Provider Adapter + worker + Engine 回填：

```bash
mkdir -p /tmp/threadshare-insights-bench.noindex
TMPDIR=/tmp/threadshare-insights-bench.noindex node scripts/benchmark-insights-engine.mjs --raw-backfill --sessions 10000 --raw-text-characters 262144 --output /tmp/threadshare-insights-raw-10k.json
```

`.noindex` 临时根只用于避免 macOS Spotlight 扫描合成 JSONL。语料固定使用 seed `threadshare-insights-benchmark-v1`；容量文件还记录 identity/content digest。raw 文件由 seed、Provider 配比、文本长度、脚本 digest、总字节数和唯一 session 数共同绑定。

## 校验

所有输出必须使用同一个 benchmark script digest：

```bash
shasum -a 256 scripts/benchmark-insights-engine.mjs
jq -r '.benchmarkScriptSha256' docs/benchmarks/local-session-insights/2026-08-10/*.acceptance.json
```

raw acceptance 的七个门禁、单周期和完整 source 对账：

```bash
jq -e '.gates | all(. == true)' docs/benchmarks/local-session-insights/2026-08-10/raw-backfill-10k.acceptance.json
jq -e '.backfill.report.cycles == 1 and .backfill.report.committed == 10000 and .facts.sessions == 10000 and .facts.sourceStates == 10000' docs/benchmarks/local-session-insights/2026-08-10/raw-backfill-10k.acceptance.json
```

容量 acceptance 的机械门禁：

```bash
for file in docs/benchmarks/local-session-insights/2026-08-10/capacity-*.acceptance.json; do
  jq -e '.packedFactsDecision.allMeasuredCapacityGatesPassed and .mutations.verified.integrity' "$file"
done
```

250k 数据库超过 1 GiB，SQLite 固定 lock-byte page 不属于任何 `dbstat` 对象。必须精确满足：

```bash
jq -e '.rustSidecar.capacity.fileFormatPages.lockBytePageBytes == 4096 and .rustSidecar.capacity.fileFormatPages.freelistBytes == 0 and .rustSidecar.capacity.dbstatAccountedPageBytes == .rustSidecar.capacity.databasePageBytes' docs/benchmarks/local-session-insights/2026-08-10/capacity-250k.acceptance.json
```

输出文件 SHA-256、文件字节数、命令、环境、生成参数和 host load 均在 `manifest.json`。重新生成的性能时长可以变化，但 corpus digest、结构计数和门禁语义必须一致。

## 数据边界

仓库只保存约 75 KiB 的指标 JSON，不保存合成 JSONL、多 GiB SQLite/WAL/SHM、Engine binary、CPU profile 或临时目录。所有 corpus 都是确定性合成数据；证据包不包含真实 session、原始 prompt、用户名路径或凭据。

这些文件不进入 npm 包。`package.json.files` 与 release allowlist 都不包含 `docs/`；发布验证仍需断言 source-root 包保持精确 37 文件。

本组数据没有测 ITEM-5 的 BM25 Top-20、Recall@300 或 evidence-path 查询质量；那些指标由后续查询实现单独验收。
