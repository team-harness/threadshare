# Deep Query v2 证据

本目录归档当前迭代唯一正式运行的 Deep Query v2 25k 合成证据。证据目录只包含
一个 aggregate report 和一个 manifest；不包含原始 Session、JSONL、SQLite/WAL/SHM、
临时路径或稳定 Session/Turn 标识。

## 25k 结果

被测规模为 25,000 Turn / 250 Session，固定 100 次测量、20 次预热。全部 7 个 Recipe
均有非空结果并通过 P95 <500 ms / P99 <1,000 ms：最慢的
`capability-contexts@1` 为 P95 154.51 ms、P99 161.04 ms。基础 records 的 P95/P99
为 4.06/4.23 ms，aggregate 为 1.42/1.93 ms。

Evidence 多页读取共完成 100 次，分页吞吐为 **56.50 MiB/s**（门槛 50 MiB/s）。
Engine sidecar 峰值 RSS 为 46.73 MiB；persistent storage amplification 为 1.1492x，
History FTS amplification 为 0.5717x；FTS integrity、事件类型索引 query plan、存储分类
和全部 Deep Query gate 均通过。

运行环境为 Apple M4 / 10 logical CPUs / 32 GiB / Node 22.22.2。主机起始
one-minute load per logical CPU 为 0.599，报告时为 1.105；该负载仅作为复现上下文，
不用于放宽任何门槛。Engine 身份和构建限制原样保留在 report/manifest 中：本次是本地
Cargo release-profile 构建，不能冒充 npm stable provenance。

## 范围边界

- **已测**：25k Fact V2 合成语料、records/aggregate、7 个 Recipe、Evidence 分页、
  storage/FTS/RSS/query-plan gate。
- **延期**：250k 长期规模档；本机 30% 真实 Session sample。本机真实样本曾运行超过一小时
  未形成完整报告，已停止且未归档；二者都不能由 25k 结果外推。
- raw provider parsing 与单 Session 512 MiB logical payload boundary 不在此 aggregate
  report 的测量范围内，分别由现有 adapter 测试和 Rust boundary test 覆盖。

## 复核

```bash
npm run verify:insights-evidence
```

根 verifier 会同时复核 ITEM-4、ITEM-5、ITEM-6 和本目录的 Deep Query manifest、历史
Git object provenance、artifact hash、数值门槛与隐私声明。完整复现需要在 clean checkout
重新构建 Engine 并运行 benchmark；报告中的 `sourceRevision`、脚本 SHA-256、Engine 摘要
和 corpus digest 用于绑定该次运行。
