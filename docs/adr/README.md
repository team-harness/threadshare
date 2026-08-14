# Architecture Decision Records

本目录保存 Threadshare 已采用且需要跨迭代保持稳定的架构决策。实现计划、阶段状态、基准数值和可回滚细节留在对应设计文档中。

| ADR | 状态 | 决策 |
|---|---|---|
| [0001](0001-local-insights-persistent-projection-architecture.md) | Accepted | Local Insights 使用持久化、事务化投影，不退化为查询时扫描 Provider 文件 |
| [0002](0002-evidence-gated-insights-performance-evolution.md) | Accepted | 性能优化必须由分段测量触发，并保持流式、内存有界与 fail-closed |

变更已经接受的决策时，新增 ADR 并将旧 ADR 标为 `Superseded`，不要直接改写历史理由。设计文档不能静默覆盖 ADR。
