# ITEM-5 本机真实语料 30% 分层样本方法

## 执行

该基准会读取本机 session。先构建与候选 commit 对应的 release Engine，再显式传入
`--execute`：

```bash
cargo build --locked --release --manifest-path crates/insights-engine/Cargo.toml
node scripts/benchmark-insights-real-sample.mjs \
  --execute \
  --engine crates/insights-engine/target/release/threadshare-insights-engine \
  --output docs/benchmarks/local-session-insights/2026-08-10-item-5/real-sample-30pct.acceptance.json
```

脚本从 `HOME`、`CODEX_HOME` 和 `THREADSHARE_CONFIG` 解析真实 provider roots 与排除配置。
未传 `--execute` 时不会扫描或读取 session。快速回归只使用生成的小语料：

```bash
node --test test/insights-real-sample-benchmark.test.mjs
```

## 抽样

1. 先使用生产 discovery 口径取得 canonical Codex/Claude 文件，并应用配置中的 provider
   与 session 排除；项目排除在 Adapter 解析后、Fact commit 前应用。
2. 固定按 `provider + 文件大小层` 分组。大小层为 `<64 KiB`、`64 KiB–1 MiB`、
   `1–16 MiB`、`>=16 MiB`，不会随本机语料分布重新计算边界。
3. 每组按 `SHA-256(seed, provider, session id, bytes)` 排成确定性顺序，再沿该顺序累计
   原始文件字节。首次跨过该组 30% 字节目标时，只比较“跨界前前缀”和“包含跨界文件的
   前缀”与目标的绝对字节误差，选择更近者；误差相同固定选择不足侧。非空分层至少保留
   一个文件，因此单个超大文件构成的分层不会被抽样丢弃。
4. 样本使用 CoW clone；文件系统不支持时退化为字节复制。硬链接没有采用，因为活跃
   JSONL 后续 append 会同时改变硬链接，不能形成可复现快照。复制前后校验
   `dev/ino/size/mtimeNs`，源发生变化时整次基准失败。
5. 复制完成后对每个实际快照做流式 SHA-256，再按稳定 selection token、字节数与文件
   digest 聚合成 `selectedSnapshotContentDigest`。该 digest 证明报告对应实际复制并提交的
   字节集合，而不只对应 discovery 元数据。

报告同时给出总体与逐分层的 `fileFraction` 和 `byteFraction`。文件数比例不作为 30% 门禁；
正式验收要求总体原始字节比例落在闭区间 `[0.25, 0.35]`。该范围固定为目标两侧各 5 个
百分点，不会根据本次结果动态放宽：已知基线最大单文件约 157 MiB、总语料约 4.56 GiB，
一个最大边界文件约造成 3.4 个百分点的离散误差，剩余空间覆盖小分层的至少一个文件规则。
超出范围即令 `allMeasuredGatesPassed=false`，必须调整明确的分层或 seed 后重新生成证据，
不能把偏离 30% 的结果仍称为 30% 样本。

这份报告的 population scope 是“canonical discovered 且未被 provider/session 排除的文件”；
`sessionScope`、eligibility 与项目排除数量由真实 Adapter/Engine 结果单独报告，不把 discovery
候选误称为 eligible main session。

2026-08-09 的 preliminary 基线只保留了聚合数字，没有保留抽样算法、成员清单或 selection
digest，因而无法从仓库证据证明新旧成员逐文件相同。本方法是第一次把抽样身份冻结为固定
算法与 population/selection digest。复测可以与旧基线比较同一规模和分层口径，但在找回旧
selection digest 前，不把它表述为“逐文件同一批样本”。

## 真实执行路径

复制后的文件位于权限受限的一次性 provider roots。脚本随后调用生产
`discoverProviderEvidenceSources`、`reconcileInsights` 和真实 Rust sidecar，最终对关闭后的
SQLite 执行 checkpoint、`VACUUM`、`dbstat`、`fts5vocab`、SQLite integrity、FTS5
`integrity-check` 与 foreign-key audit。
测量包含：

- Session/Turn/Event/Use 等聚合 Fact 数量与索引 wall time；
- `detail=full` FTS 字节、document、field-term、posting、occurrence 及三字段分项；
- 8,192 token、4,096 distinct field-term、256 capability token cap 的命中数量；
- Fact truncation、diagnostic、coverage 的聚合数量；
- 去重聚合的 raw/eligible、strong、weak、observed-EOF provisional 与 unknown 数量，
  其中 provisional 是与 strong/weak 正交的 closure 维度；
- Engine/SQLite 身份、硬件环境、commit、脚本/Epic/Engine 与样本选择哈希。

FTS schema 确认为 `detail=full`、analyzer identity 为 `mixed-cjk-code@1`、detail-full
FTS 按样本 live Turn document 的实测字节密度线性外推到 250,000 Turn 后仍 `<400 MiB`、
全部选中 source 均被 committed/excluded、checkpoint 与已提交 source byte 对账、SQLite
integrity/foreign key 均通过后，报告才会设置
`allMeasuredGatesPassed=true`。

长期 detail-full FTS `<400 MiB` 没有 skip 开关。实测外推不通过时报告保留用于诊断，
但 CLI 退出 1，packager 也拒绝安装该证据。

## 隐私与清理

报告不含源路径、session id、问题/回复文本、原始 session、Tool payload、临时数据库或排除
规则值。Fact diagnostic 与 coverage 只输出 distinct/occurrence 总量，不输出可能携带 provider
record class 的 key。CLI 错误只输出稳定错误码，不回显异常中的路径。

所有复制 session、origin secret、配置副本、SQLite/WAL/SHM 和临时文件都放在单个 0700
临时树中。报告先在内存中构造，临时树成功递归删除后才返回；清理失败则整次运行失败，
不会生成“已清理”的验收报告。仓库只提交聚合 JSON，不提交多 GiB corpus、数据库或 raw
session。
