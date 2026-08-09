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

## ITEM-4 接续门槛

ITEM-4 必须复用相同 seed 和 key/text 变化规则，把 benchmark workload 替换为真实 normalized Fact、detail-full FTS、rollup 和 mutation trace。届时才执行 Epic 的原始字节 `>=10 MiB/s`、warm Top-20、RSS、容量、delete/replace、purge 与 crash-recovery 门槛。

当前中位数 `0.708 canonical MiB/s` 与 Epic 的 raw-byte gate 不是同一分母，不能直接判失败；但它已经是明确性能风险。ITEM-4 在扩展 schema 前应先 profile protocol validation、Rust canonical delta 重建和 250 次事务各自占比，不能把差距归因给 SQLite 或直接放宽门槛。
