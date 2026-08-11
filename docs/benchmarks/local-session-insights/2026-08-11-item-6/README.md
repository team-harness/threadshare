# ITEM-6 Dashboard Overview 基准证据

本目录归档 `READ_INSIGHTS_OVERVIEW` 在 25,000 / 250,000 Turn 数据库上的正式聚合
读取证据。仓库只保存两份白名单 aggregate JSON 与一份 manifest；两档合计约 4.44 GiB
canonical 合成输入（250k 档约 4.04 GiB）、SQLite/WAL/SHM、完整 runner 报告和任何真实
Provider session 均未提交。

## 结果

| 规模 | 测量 / 预热 | P50 | P95 | P99 | 最大值 | P95 / P99 门槛 |
|---:|---:|---:|---:|---:|---:|---:|
| 25,000 Turn | 1,000 / 100 | 1.658 ms | 2.697 ms | 3.577 ms | 24.910 ms | <100 / <250 ms |
| 250,000 Turn | 1,000 / 100 | 11.470 ms | 15.665 ms | 20.270 ms | 26.599 ms | <200 / <500 ms |

两档运行的 1,100 次响应都保持同一 payload digest 与 snapshot，mismatch 为 0。
250,000 Turn 的 post-VACUUM 数据库为 2,779,881,472 bytes，带有界 staging 的派生状态
峰值为 2,893,485,692 bytes；Fact / FTS / Projection 分别为 2,543,841,280 /
165,777,408 / 70,205,440 bytes，Engine sidecar peak RSS 为 53,379,072 bytes。
250k FTS 含 250,000 documents、1,544,274 field terms 与 36,010,640 postings；warm Engine
从启动到首次真实 `READ_INSIGHTS_OVERVIEW` 返回的 3 次样本中位数为 19.357 ms。真实产品路径
`createInsightsBackgroundWorker -> reconcileActiveInsights -> SEARCH_TURNS` 的 append-to-searchable
为 25k 189.318 ms、250k 163.454 ms，且 probe 清理后 Fact/FTS baseline 精确恢复。全部 Overview、
存储分类、容量、FTS、RSS、首次可用和 2 秒 freshness gate 通过。artifact 同时保留测量范围和
四项 `notMeasured`，避免把未测维度读成已通过。250k 完整性 STATUS 读取中位数 7,909.163 ms
仅作维护审计，不进入 500 ms 首次可用门槛。

## 来源链

- 被测源码：clean commit `e35020de008c6808b4b45376cee933e5eac9a13f`。
- 批准 Epic SHA-256：`46e2cc8fdc974dac26a67ab3f448bcc0df458b5ae33a28da4e2f469fe8daf582`。
- benchmark script SHA-256：`c2a0cbdf7761779c5d0cfcabff6636af7854e6f086ae5cfe39e038354c04a05d`。
- packager script SHA-256：`d31f8d2943969d89a3cd2ebba4528bd28f20b3874476c4086065adb041241f0a`。
- raw 25k report：32,121 bytes，SHA-256 `6f30190ee4a6ae4c7d1237288ad082cf3c00e748040e0dcabc1c2da7818451e3`。
- raw 250k report：32,311 bytes，SHA-256 `da0eee5c6ef7b81850e48fde2f0cedd456a82dce930a991f818a5eb1673fa5b0`。

Engine 是该 clean source commit 的 Cargo `--release` 本地构建，binary SHA-256 为
`3dc78d8dd8fecf6b35924eae43dfeb37772838d283b2dd4d69bdbc74da18b938`。其 version document
如实声明 `engineVersion=0.0.0`、`target=development`：这里的 release 仅指 Rust 编译
profile，不是 npm stable release provenance；当前 version document 不携带 Cargo profile，
因此 manifest 把这一来源明确记为 `local-cargo-release-profile-unverifiable`，不声称可由二进制
身份独立证明。host load 只作审计记录，不参与 gate，也不用于放宽阈值。

## 复现

先在独立 clean worktree 检出被测 commit，构建 Engine 并生成完整临时报表：

```bash
ITEM6_SOURCE_WORKTREE="$(mktemp -d)"
git worktree add --detach "$ITEM6_SOURCE_WORKTREE" \
  e35020de008c6808b4b45376cee933e5eac9a13f
cd "$ITEM6_SOURCE_WORKTREE"
npm ci --ignore-scripts
cargo build --locked --release \
  --manifest-path crates/insights-engine/Cargo.toml
ITEM6_REPORT_DIR="$(mktemp -d)"
node scripts/benchmark-insights-engine.mjs \
  --capacity --turns 25000 --turns-per-session 100 \
  --queries 1000 --warmup 100 \
  --seed threadshare-insights-dashboard-25k-v1 \
  --skip-mutations \
  --engine crates/insights-engine/target/release/threadshare-insights-engine \
  --output "$ITEM6_REPORT_DIR/overview-25k.raw.json"
node scripts/benchmark-insights-engine.mjs \
  --capacity --turns 250000 --turns-per-session 100 \
  --queries 1000 --warmup 100 \
  --seed threadshare-insights-dashboard-250k-v1 \
  --skip-mutations \
  --engine crates/insights-engine/target/release/threadshare-insights-engine \
  --output "$ITEM6_REPORT_DIR/overview-250k.raw.json"
```

回到包含本证据目录的 checkout，用 packager 核对历史 git object、Engine binary、
批准 Epic、两份报告和全部 gate，再原子创建 evidence 目录：

```bash
node scripts/package-insights-dashboard-evidence.mjs \
  --report-25k "$ITEM6_REPORT_DIR/overview-25k.raw.json" \
  --report-250k "$ITEM6_REPORT_DIR/overview-250k.raw.json" \
  --engine "$ITEM6_SOURCE_WORKTREE/crates/insights-engine/target/release/threadshare-insights-engine" \
  --output-dir docs/benchmarks/local-session-insights/2026-08-11-item-6/evidence
npm run verify:insights-evidence
```

packager 重新计算严格延迟、warm 首次 Overview、真实产品路径 2 秒 freshness、FTS density、
6 GiB Fact、8 GiB 派生状态、400 MiB FTS 和 96/128 MiB Engine RSS 门槛，不只信任报告中的
布尔值；任一缺测、mismatch、dirty source、来源哈希漂移、未分类存储或隐私形状都会失败。
输出只白名单保留测量边界、环境、corpus、Overview、容量聚合与哈希，不会复制 request id、
SQLite 对象明细或任何 stable key。
artifact 与 manifest 交叉记录 packager digest；验证历史证据不依赖未来工作树中的 packager
仍保持同一字节，避免一次正常的验证器维护让旧证据失效。
