# ITEM-6 Dashboard Overview 基准证据

本目录归档 `READ_INSIGHTS_OVERVIEW` 在 25,000 / 250,000 Turn 数据库上的正式聚合
读取证据。仓库只保存两份白名单 aggregate JSON 与一份 manifest；两档合计约 4.44 GiB
canonical 合成输入（250k 档约 4.04 GiB）、SQLite/WAL/SHM、完整 runner 报告和任何真实
Provider session 均未提交。

## 结果

| 规模 | 测量 / 预热 | P50 | P95 | P99 | 最大值 | P95 / P99 门槛 |
|---:|---:|---:|---:|---:|---:|---:|
| 25,000 Turn | 1,000 / 100 | 1.580 ms | 1.942 ms | 2.328 ms | 3.066 ms | <100 / <250 ms |
| 250,000 Turn | 1,000 / 100 | 11.560 ms | 14.165 ms | 16.631 ms | 20.293 ms | <200 / <500 ms |

两档运行的 1,100 次响应都保持同一 payload digest 与 snapshot，mismatch 为 0。
250,000 Turn 的 post-VACUUM 数据库为 2,779,881,472 bytes，带有界 staging 的派生状态
峰值为 2,893,485,692 bytes；Fact / FTS / Projection 分别为 2,543,841,280 /
165,777,408 / 70,205,440 bytes，Engine sidecar peak RSS 为 50,708,480 bytes。
250k FTS 含 250,000 documents、1,544,274 field terms 与 36,010,640 postings；warm Engine
READY 的 3 次样本中位数为 4.804 ms。全部 Overview、存储分类、容量、FTS、RSS 与完整性
gate 通过。artifact 同时保留测量范围和四项 `notMeasured`，避免把未测维度读成已通过。
`populatedWarmOpenUnder500Ms` 只约束 Engine READY；250k 的 STATUS 读取中位数 7,150.835 ms
会保留作审计记录，但不属于该 gate，不能解读为完整 warm-open 链路小于 500 ms。

## 来源链

- 被测源码：clean commit `b70877b819787cebb18a9934903ee5be1f3d5d71`。
- 批准 Epic SHA-256：`46e2cc8fdc974dac26a67ab3f448bcc0df458b5ae33a28da4e2f469fe8daf582`。
- benchmark script SHA-256：`96f3af5395bf57878253df4ea5d9bd60c424d48d094150c38f5aeabb39e3fe73`。
- packager script SHA-256：`a313c2b7a3d39ca980b958d54bbbf5b06aed36c2db6607a534e8e53774e575c1`。
- raw 25k report：30,694 bytes，SHA-256 `4091faab93bfe4fa27b9006005d523226763d893dd484724bee1f5ea52462345`。
- raw 250k report：30,852 bytes，SHA-256 `3c15bd405a372241173626165f594b88c61103fd6544d15343fbd388c7fa999c`。

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
  b70877b819787cebb18a9934903ee5be1f3d5d71
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

packager 重新计算严格延迟、warm READY、FTS density、6 GiB Fact、8 GiB 派生状态、400 MiB
FTS 和 96/128 MiB Engine RSS 门槛，不只信任报告中的布尔值；任一缺测、mismatch、dirty
source、来源哈希漂移、未分类存储或隐私形状都会失败。输出只白名单保留测量边界、环境、
corpus、Overview、容量聚合与哈希，不会复制 request id、SQLite 对象明细或任何 stable key。
artifact 与 manifest 交叉记录 packager digest；验证历史证据不依赖未来工作树中的 packager
仍保持同一字节，避免一次正常的验证器维护让旧证据失效。
