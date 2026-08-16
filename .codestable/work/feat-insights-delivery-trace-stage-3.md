---
type: feat
status: complete
---

# Insights Delivery Trace Stage 3

## 目标

把 Stage 2 的 Delivery Trace、Evidence、Git diff 与 continuation context 接入本地 Dashboard，形成用户可操作的 `Insights Inspector`。

## 现场

- Stage 0-2 已在当前工作树完成，尚未提交或发布。
- Dashboard 已有 Overview、Search、Skills、Tools 和右侧 evidence inspector。
- Intent adapter 属于 Stage 4；Stage 3 必须准确显示 intent unavailable，不得在浏览器推断 intent/session/commit 关系。

## 边界

- 浏览器只消费 Engine Query/Trace response 中存在的 node/edge；同名、相邻时间、basename 都不能补边。
- 默认只读 committed SQLite；Git diff 只能由用户手势触发 revision-bound Evidence。
- Dashboard 不扫描 Provider/Git source，不修改 state 权限，不把 bootstrap secret 放入 URL。
- 现有右侧 inspector 更名为 Detail Drawer；`Insights Inspector` 是主工作台。
- self-contained HTML export、Intent adapter 与 25k 正式证据不在本阶段。

## 证据

- [x] Dashboard repository/date API red -> green，复用 snapshot-bound Query/Trace。
- [x] Reducer mutation test：删除 response edge 会移除 related highlight。
- [x] Evidence、Git diff、SCM 与 continuation 均由显式用户手势触发。
- [x] 桌面/移动 Playwright 无重叠、横向页面溢出或空白状态。
- [x] 两次 clean build 一致，installed smoke、全量回归与 code-deep review 通过。

## 验收

1. 用户可从 `Insights Inspector` 按 repository 与 UTC date 浏览 committed delivery evidence。
2. Prompt / Activity / Delivery 三栏只显示 Trace response 支持的联动，evidence strength 与 limitations 可见。
3. Commit/File 可按需读取分页 diff，并在有 SCM mapping 时由用户手势打开安全链接。
4. continuation copy 明确不能恢复 Session、代码或 Git 状态。
5. Intent/Session 关系尚不可用时显示准确 coverage，不制造空白成功态。

## 状态

Stage 3 第 5/5 步完成：实现、安装态验证与 diff 审查均闭合。

## 实现记录

- Dashboard 只通过 authenticated loopback API 读取 repository、Delivery Edge、Trace、Evidence、Git diff、session timeline 与 continuation。
- Date mode 使用 committed `delivery-edge` Query；Intent projection 尚未交付时明确显示 unavailable。
- Prompt / Activity / Delivery lane 的 related state 只由 Trace response edge 计算；删除 edge 的变异测试会删除对应高亮。
- Commit/File 的 Evidence、Git diff、SCM link 与 continuation 均需用户手势；Session 节点按需执行 `session-timeline@1` 并逐事件读取 Evidence。
- Playwright：1440x900 与 390x844 均为 `document.scrollWidth === viewport`；桌面 lane 宽约 231px，移动 lane 宽 366px，移动 Drawer 为 390px。
- 安装态 smoke：隔离 tarball 在 darwin-arm64 上完成 7 个 CLI 查询、21 个 schema 校验与 4 个 MCP 工具调用。
- 安装态 smoke 发现并修复 Query v2 / Recipe / Trace / Evidence helper 在 `try/finally` 中未等待即关闭 reader 的生命周期缺陷；延迟响应测试锁定 response 完成前 reader 必须保持打开。
- 验证：Insights 299/299、CLI 199/199、release 72/72、Skill 与根 evidence verifier 全绿；Dashboard committed build 与 72-file npm allowlist 一致。

## 未决

- Stage 4 才引入 Intent adapter 与正式 25k evidence。
