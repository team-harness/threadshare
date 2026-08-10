# Insights Engine 基准

## ITEM-3 原生 substrate 基线

### 结论

ITEM-3 选择 Rust sidecar 的依据不是当前基准更快，而是同时保留 Node `>=20`、固定 SQLite patch/compile options，并把数据库故障与内存隔离到独立进程。Node 22 `node:sqlite` 仍作为 reference harness，持续量化这项选择的成本。

当前 Engine 只实现 `SessionFactsDeltaV1` 的 protocol、校验和 session commit substrate，尚未实现 ITEM-4 的 normalized Fact repository、Projection 或 FTS query。因此本基准能比较 commit、wire、RSS 和底层 point lookup，不能替代最终的 raw-session backfill、BM25 Top-20 或 purge benchmark。

## 运行

先构建优化后的本机 Engine，再运行默认 25,000 Turn 基准：

```bash
cargo build --release --manifest-path crates/insights-engine/Cargo.toml --locked
npm run benchmark:insights-engine -- --output /tmp/threadshare-insights-benchmark.json
```

快速验证使用更小 corpus：

```bash
npm run benchmark:insights-engine -- \
  --turns 500 \
  --turns-per-session 50 \
  --queries 100 \
  --warmup 20 \
  --json
```

可用 `--engine <path>` 指定 binary，或设置 `THREADSHARE_INSIGHTS_ENGINE_PATH`。reference harness 要求 Node 22.5+；Threadshare 产品本身仍支持 Node 20。

## Corpus

生成器固定使用 seed `threadshare-insights-benchmark-v1`，默认生成 250 个 session、每个 100 Turn。每个 session/Turn key、问题、回复、时间、项目 key 和 provider 都由 index 确定性变化，避免复制相同行带来的压缩或 cache 假象。

同一 corpus 在两个独立进程中重新生成，并以 corpus SHA-256、查询结果 SHA-256、committed session 数和数据库字节数交叉校验。任何一项不同都会让命令失败。

## 2026-08-10 committed-head 实测

环境：Apple M4，10 logical CPU，32 GiB RAM，macOS 25.5.0，Node v22.22.2。Rust bundled SQLite 为 3.53.2；Node reference SQLite 为 3.51.2。

源码基线为 clean commit `968e297b27c906cc3a7cc74dcda885db09aa0b04`，三次结果的 `sourceWorktreeDirty` 均为 `false`。脚本 SHA-256 为 `72fb375ac9914aa9d73a65a309b4833de2cb73e9f3ccf73bd3e8037ffc597c87`。

Corpus：25,000 Turn / 250 session / 13,285,772 canonical bytes；digest 为 `815ee307ed1171077e452588d3839aff55e9e5b5ceddec585c81751a4fbd1b29`。

| 运行 | Rust commit wall | Rust Turn/s | warm open | Rust lookup P95 | sidecar RSS | Node commit wall | Node Turn/s | Node lookup P95 | 配对 wall ratio |
|---|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 1 | 17,900.828 ms | 1,396.6 | 9.397 ms | 0.467 ms | 11.344 MiB | 193.170 ms | 129,419.7 | 0.253 ms | 92.67x |
| 2 | 21,606.195 ms | 1,157.1 | 3.563 ms | 0.387 ms | 11.453 MiB | 440.545 ms | 56,747.8 | 0.303 ms | 49.04x |
| 3 | 16,616.451 ms | 1,504.5 | 19.659 ms | 0.236 ms | 11.484 MiB | 708.592 ms | 35,281.3 | 0.477 ms | 23.45x |
| **中位数** | **17,900.828 ms** | **1,396.6** | **9.397 ms** | **0.387 ms** | **11.453 MiB** | **440.545 ms** | **56,747.8** | **0.303 ms** | **49.04x** |

中位数下，Rust canonical throughput 为 `0.708 MiB/s`，harness + Engine RSS 为 `115.750 MiB`，Node reference RSS 为 `111.891 MiB`。两侧数据库均为 `13,467,648 bytes`（约 `12.84 MiB`）。Rust commit wall 包含 Node protocol frame 准备、IPC、Rust frame validation、delta 重建/JCS 校验和 250 次 SQLite commit；Node reference 接收已经生成并验证的 canonical delta 后直接执行相同表结构的事务。因此配对 wall ratio 是产品边界成本上界，不是纯 SQLite 或纯 IPC 比较。

Protocol 发送 750 个 request frame、接收 750 个 response frame，总 wire bytes 为 13,574,778，相对 canonical corpus 的放大为 `1.02175x`。wire 体积可接受；当前主要风险在 frame validation/delta 重建/逐 session commit 路径，需要 ITEM-4 profile 后再定位。

两库 point lookup 使用同一 Node `node:sqlite` reader，结果 digest 完全一致。Rust protocol 尚无 query message，所以该数字只证明落盘布局和读取结果一致，不能表示 Rust query latency。macOS 的 sidecar RSS 使用进程启动/结束观察值，避免每 100 ms 启动 `ps` 干扰 wall time；Linux 使用 `/proc` 100 ms 采样并报告近似 peak。

共享机器上的三次运行中，Rust commit wall 为 16.6 到 21.6 秒，Node reference 为 0.193 到 0.709 秒，说明单次 wall/query 数据受并发负载影响。本文以三次中位数作为 ITEM-3 committed-head 证据，并保留完整环境、corpus digest 和脚本 digest；最终性能判定仍要等 ITEM-4 的真实 Fact/FTS workload。

## ITEM-4 事务索引实测

ITEM-4 benchmark 使用同一确定性 seed，并分别测量两条路径：容量路径生成真实密度的 `SessionFactsDeltaV1`，覆盖 normalized Fact、detail-full FTS、rollup、change log 与 mutation；raw 路径生成 Codex/Claude 原生 JSONL，计时范围覆盖 discovery、Provider Adapter、后台 worker、Engine protocol 和 SQLite transaction。两条路径不能互换分母。

容量回填同时报告三段互斥耗时：`corpusGenerationMs` 只包含惰性 corpus 生成与 digest/字节统计，`protocolPreparationMs` 只包含 frame 生成与编码，`engineBackfillMs = wallMs - corpusGenerationMs - protocolPreparationMs`。`engineTurnsPerSecond` 只使用最后一项作分母，另以 `endToEndTurnsPerSecond` 保留用户实际等待口径，不能再把两者写成同一个吞吐值。

raw 回填只有同时满足以下条件才允许通过 `>=10 MiB/s`：每个 backfill cycle 都发现全部唯一 source、discovery/index diagnostic 均为空、跨 cycle 聚合后的唯一 committed source 和 committed 总数均等于 corpus 数、最终 `sessions`/`sourceStates` 也与 corpus 对齐。吞吐报告聚合所有 backfill cycle，不再假定 `cycleReports[0]` 就代表完整回填。worker 等待由 `onCycle` 事件驱动；append commit 只接受与目标 source 相同的 commit，并再用唯一 marker 的 FTS 命中交叉验证。

所有结果同时记录运行开始与报告生成时的 1/5/15 分钟 host load，以及 1 分钟 load 除以逻辑 CPU 数后的归一值。host load 只用于解释环境竞争，不能放宽任何性能 gate。macOS 大样本使用 `.noindex` 临时根，避免合成 JSONL 触发 Spotlight，而真实 Codex/Claude session 本来位于隐藏目录；该环境变量必须和完整命令一起进入证据 manifest。

后台 poll 以一次 reconciliation 完成为计时起点，不使用从进程启动起固定触发的 `setInterval`。因此超过 poll interval 的首次回填结束后不会立刻排入一次全量 no-op scan；watcher、manual trigger 与 retry 仍可在回填期间排入下一轮。

运行容量与真实 raw 回填：

```bash
npm run benchmark:insights-engine -- \
  --capacity \
  --turns 250000 \
  --turns-per-session 100 \
  --output /tmp/threadshare-insights-capacity-250k.json

mkdir -p /tmp/threadshare-insights-bench.noindex
TMPDIR=/tmp/threadshare-insights-bench.noindex npm run benchmark:insights-engine -- \
  --raw-backfill \
  --sessions 10000 \
  --raw-text-characters 262144 \
  --output /tmp/threadshare-insights-raw-10k.json
```

### 运行环境与证据边界

环境为 Apple M4、10 logical CPU、32 GiB RAM、macOS 25.5.0、Node v22.22.2，Rust bundled SQLite 3.53.2。ITEM-4 尚未形成 milestone commit，五份输出记录的是 HEAD `170f29952b2354f5a896cf2091584644cf6ca837` 上的候选工作树，`sourceWorktreeDirty=true`；因此结果同时保存 benchmark script SHA-256 与完整输出 SHA-256，供 staged review 对照。

正式验收使用同一个脚本 SHA-256 `e86f6cf6a4a20721476ffa6d296bdb9d85e2652d43ed22e5be674f11d30161fe`。完整 JSON、命令、环境、生成参数与失败反例保存在 [`docs/benchmarks/local-session-insights/2026-08-10/`](benchmarks/local-session-insights/2026-08-10/README.md)；仓库不保存合成 JSONL 或多 GiB SQLite。

| 证据 | output SHA-256 | 判定 |
|---|---|---|
| 10k raw backfill | `64e5b987fa99f2f967bf46226f5f3784357470d644bfff24f9968d6bd5fd3732` | acceptance |
| 5k capacity | `be138b0ad38b244be55d6a6ee015241fb78d1d526f2a8a150c4eb1c47caee200` | acceptance |
| 25k capacity | `0f043d416ad19f74746d1d9b92df9f441ccfb184df0e506a8ac2b463d22ab405` | acceptance |
| 250k capacity | `150bbe01f6f8a1002f0dbfe09b0914919b1032c78728bd5cd03eaa25a73b4cad` | acceptance |
| 10k raw，环境竞争 | `43d53ba77a3038d6f92404d3670c6b993928897f9b7e2c01dc4204e0e4b17c01` | failed gate，仅作反例 |

### 原始 session 回填与增量 freshness

raw corpus 为 10,000 个唯一 session，Codex/Claude 各 5,000 个，共 `2,965,275,222` raw bytes；每个 session 使用 262,144 个问题字符，低于本机历史库约 1.4 MiB/file 的平均量级，避免 16 KiB 小文件让固定事务成本主导结果。语料在计时外生成，最新 100 个 source 排在 discovery 优先队列前部。

| 指标 | 结果 | 门槛 |
|---|---:|---:|
| raw backfill wall | 222,034.81 ms | - |
| raw throughput | **12.736 MiB/s** | `>=10 MiB/s` |
| 最新 100 个全部 commit | **2,440.52 ms** | `<=30,000 ms` |
| Adapter P50 / P95 | 13.04 / 19.21 ms | 记录值 |
| commit ACK P50 / P95 | 72.43 / 87.21 ms | 记录值 |
| watcher append 到 commit | **975.24 ms** | `<=2,000 ms` |
| watcher append 完整周期 | 978.42 ms | `<=2,000 ms` |
| append Engine transaction | 17.17 ms | 记录值 |

初次回填只有一个 `startup` cycle，10,000/10,000 session 成功、0 failure；append 周期原因明确为 `filesystem`，metadata reconciliation 判定 9,999 unchanged、只提交变化文件，最终得到 10,001 Turn / 10,001 FTS document，并由 marker query 命中新增 Turn。`physicalBytesRead=4,775,864,537` 单独报告，不作为吞吐分母。运行开始/结束的 1 分钟 host load 为 7.01/7.01；所有 cycle 的 discovery 数、唯一 source 数、aggregated commit 数与最终持久化 session 数全部相等。

保留的竞争反例在同一脚本、同一 corpus 下仍然 10,000/10,000 对账且只有一个 cycle，但 host load 从 8.33 升到 13.74，吞吐降到 9.280 MiB/s、append 到 commit 为 2,045.00 ms，因此两个 gate 正确失败。该反例证明环境字段用于解释差异，而不是放宽门槛。

### 容量、RSS 与 backend 决策

容量 corpus 每 Turn 固定 9 SourceRecord、9 Event、3 Turn-Evidence、3 Capability Use、6 Use-Evidence、135 natural posting，并确定性改变 stable key、时间、problem/final text 与保留 identifier。natural、code、capability 三列分别报告并断言密度，当前 corpus 的 code 期望值明确为 0，capability posting 不能替代 natural 密度。查询延迟在 `VACUUM` 前测量；维护后再用 `dbstat` 拆分，并要求全部 SQLite 对象都有已知 owner。

页数交叉对账使用 `dbstat bytes + fileFormatPages.totalBytes == page_count * page_size`。`fileFormatPages` 显式列出 freelist 和 SQLite 固定的 lock-byte page：数据库超过 1 GiB 后，包含偏移 `1,073,741,824` 的整页不会归属于任何表或索引，因而不会出现在 `dbstat` 中。该页必须精确计入，不能用误差区间掩盖；`VACUUM` 后 freelist 预期为 0。

磁盘口径拆为 `compactedSteadyStateBytes` 与更保守的 `observedDerivedStatePeakBytes`：前者是 VACUUM 后 DB/WAL/SHM 加最大单 session canonical staging 上界，后者取维护前后持久化峰值再加同一 staging 上界，并用于 8 GiB packed-facts 决策。sidecar RSS、Node harness RSS 和 combined RSS 分开报告；Engine RSS 按 25k `<96 MiB`、250k `<128 MiB` 独立门禁，不混入磁盘字节。

| Turns | Engine Turn/s | 稳态总量 | Fact | detail-full FTS | Projection | sidecar RSS | field terms | postings |
|---:|---:|---:|---:|---:|---:|---:|---:|---:|
| 5,000 | 240.3 | 53.89 MiB | 47.09 MiB | 3.78 MiB | 1.32 MiB | 49.14 MiB | 45,112 | 710,000 |
| 25,000 | 208.7 | 263.31 MiB | 237.16 MiB | 18.15 MiB | 6.30 MiB | 49.44 MiB | 178,935 | 3,550,000 |
| 250,000 | **221.4** | **2.535 GiB** | **2.335 GiB** | **139.53 MiB** | **63.27 MiB** | **49.59 MiB** | 1,542,188 | 35,500,000 |

25k 稳态低于 1 GiB，250k Fact 低于 6 GiB、稳态低于 8 GiB，FTS 低于 400 MiB backend re-evaluation 线；三档均 `quick_check=ok`、foreign-key violation 为 0。因此 ITEM-4 保持 `normalized-row-v1`，不启动 `packed-facts-v1`，也不引入 Tantivy 或自研 LSM。

250k 端到端 wall 为 1,364.58 秒（183.2 Turn/s）；扣除惰性 corpus 生成和 protocol preparation 后，Engine backfill 为 1,129.30 秒（221.4 Turn/s）。运行开始/结束的 1 分钟 host load 为 14.12/6.92；容量、RSS、`VACUUM`/`dbstat`、完整性和 mutation 门禁均按实际值判断，没有因竞争负载放宽。

### Warm open 与 mutation

每档已填充数据库连续重启 3 次并取中位数。5k / 25k / 250k 的 READY 分别为 **8.06 / 6.84 / 4.64 ms**，全部远低于 `<500 ms` 门槛。对应 `ENGINE_STATUS` 中位数为 154.81 / 924.22 / 5,775.67 ms；它包含随库规模增长的完整性和状态读取，保持独立观测，不能混成 open 门槛。

250k mutation trace：

| 操作 | wall | 验证结果 |
|---|---:|---|
| replace-session | 378.59 ms | generation 2、replacement FTS 可查 |
| delete-source | 33.55 ms | Fact/FTS/rollup 删除 |
| exclude-source | 2.36 ms | 立即进入 pending-purge、不可查 |
| purge maintenance | 12,708.74 ms | optimize/checkpoint/VACUUM 后才标 purged |

最终保留 2,498 session / 249,800 Turn，FTS 与 rollup 同为 249,800，change log 保持 113 rows；replace、delete、purge、Projection cleanup、searchability、change-log cap、quick-check 和 foreign keys 全部通过。

### 恢复与隐私 canary

自动化 crash matrix 在 Fact commit、ACK 丢失、Projection shadow switch，以及 purge 的 DELETE/optimize/checkpoint/VACUUM 边界注入故障；恢复后与 clean snapshot 比较 logical Fact、Projection、checkpoint 语义和 integrity。purge canary 额外持有旧 reader：逻辑删除后 MATCH/`fts5vocab` 已为 0，但 live DB/WAL 仍含 token 时状态必须保持 pending；只有 token 从 DB/WAL 消失且 WAL truncate 为 0 后才返回 purged。测试不会把 SQLite tombstone 当作物理清除完成。
