# Insights Engine ITEM-3 基准

## 结论

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

## 2026-08-10 实测

环境：Apple M4，10 logical CPU，32 GiB RAM，macOS 25.5.0，Node v22.22.2。Rust bundled SQLite 为 3.53.2；Node reference SQLite 为 3.51.2。

源码基线为 `1f8f2e330c3c3596ecaf78385697eec5fc755b11` 加尚未提交的 ITEM-3 candidate，脚本 SHA-256 为 `72fb375ac9914aa9d73a65a309b4833de2cb73e9f3ccf73bd3e8037ffc597c87`。milestone commit 后必须重跑，不能把这份 dirty-worktree 数据当 release acceptance 证据。

Corpus：25,000 Turn / 250 session / 13,285,772 canonical bytes；digest 为 `815ee307ed1171077e452588d3839aff55e9e5b5ceddec585c81751a4fbd1b29`。

| 指标 | Rust sidecar | Node `node:sqlite` reference |
|---|---:|---:|
| warm open | 2.776 ms | 未单列 |
| commit wall | 19,190.744 ms | 440.941 ms |
| Turn/s | 1,302.7 | 56,696.9 |
| canonical MiB/s | 0.660 | 28.735 |
| isolated Engine RSS | 11.4 MiB sidecar | 不适用（进程内） |
| harness + Engine RSS | 126.4 MiB | 113.0 MiB reference process |
| DB + WAL + SHM | 12.84 MiB | 12.84 MiB |
| point lookup P95 | 0.399 ms | 0.619 ms |

Rust 的 19.19 秒包含 2.84 秒 Node protocol frame 准备，以及 16.35 秒 IPC、Rust frame validation、delta 重建/JCS 校验和 SQLite commit。Node reference 接收已经生成并验证的 canonical delta 后直接执行相同表结构的事务，因此 `43.52x` wall ratio 是产品边界成本上界，不是纯 SQLite 或纯 IPC 比较。

Protocol 发送 750 个 request frame、接收 750 个 response frame，总 wire bytes 为 13,574,778，相对 canonical corpus 的放大为 `1.02175x`。wire 体积可接受；当前主要风险在 frame validation/delta 重建/逐 session commit 路径，需要 ITEM-4 profile 后再定位。

两库 point lookup 使用同一 Node `node:sqlite` reader，结果 digest 完全一致。Rust protocol 尚无 query message，所以该数字只证明落盘布局和读取结果一致，不能表示 Rust query latency。macOS 的 sidecar RSS 使用进程启动/结束观察值，避免每 100 ms 启动 `ps` 干扰 wall time；Linux 使用 `/proc` 100 ms 采样并报告近似 peak。

共享机器上的三次确认运行中，Rust commit wall 为 13.6 到 19.2 秒，Node reference 为 0.075 到 0.441 秒，说明单次 wall/query 数据受并发负载影响。报告保留完整环境、corpus digest 和脚本 digest，正式性能判定应在空闲机器上至少运行三次并取中位数。

## ITEM-4 接续门槛

ITEM-4 必须复用相同 seed 和 key/text 变化规则，把 benchmark workload 替换为真实 normalized Fact、detail-full FTS、rollup 和 mutation trace。届时才执行 Epic 的原始字节 `>=10 MiB/s`、warm Top-20、RSS、容量、delete/replace、purge 与 crash-recovery 门槛。

当前 `0.660 canonical MiB/s` 与 Epic 的 raw-byte gate 不是同一分母，不能直接判失败；但它已经是明确性能风险。ITEM-4 在扩展 schema 前应先 profile protocol validation、Rust canonical delta 重建和 250 次事务各自占比，不能把差距归因给 SQLite 或直接放宽门槛。
