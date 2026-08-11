# Release 0.7.0 Windows Core-Only

## Target

发布 `@team-harness/threadshare@0.7.0`。macOS/Linux arm64/x64 发布完整原生 Insights Engine；Windows arm64/x64 只安装并验证 root core CLI，不发布 Windows Engine 包。

## Boundaries

- 保留六目标运行时与独立 Engine CI，以便继续验证 Windows 可编译性。
- 稳定发布集合仅为四个 macOS/Linux Engine 包加 root，共五个 npm 包。
- 六目标 consumer smoke 必须全部通过；Windows 必须证明 root-only 安装中没有平台 Engine 包且 core CLI 可执行。
- root 始终最后发布，现有 `@team-harness/threadshare@0.6.1` 在此之前不受影响。

## Acceptance

- release staging、manifest、optional dependencies、SBOM 与 publish verifier 精确绑定四个 Engine release targets。
- `publish-npm.yml` 不引用 Windows 签名 secrets，不构建或发布 Windows Engine。
- npm registry 中缺失的 `@team-harness/threadshare-linux-x64` 只执行一次 binary-free bootstrap；不重复已有 bootstrap。
- Apple 签名、公证、四 Engine provenance、六 consumer smoke、root-last publish 全绿后，临时前缀安装并验证 `0.7.0`。

## Status

- 2026-08-11：owner 已确认 Apple 环境可用，并批准 Windows 在 0.7.x 降级为 core CLI only。
- 2026-08-11：release staging、五包 bundle 与六目标 consumer smoke 的 TDD 切片已落地；`npm run test:release` 60/60 通过。
- 2026-08-11：Node 22.22.3 下 Insights Node 234、Rust 170、CLI 176、Viewer 7、API 32、FC 19 全绿；Cloudflare build、Skill validation、evidence verifier、npm 54-file dry-run 与 `git diff --check` 通过。
- 2026-08-11：Agent Query 终审唯一 important 已关闭，公开 coverage 现固定回显 `scope: "all-indexed-history"`，并明确 selection 有界而 coverage 聚合是全历史线性成本。
- 2026-08-11：release review 发现 npm 首次 bootstrap 会把 `latest` 初始化到 `0.0.0-bootstrap.0`；verifier 现仅容忍这一精确例外，并继续拒绝其他 prerelease latest。
- 2026-08-11：Windows 所有 `insights` 动作现明确 fail-closed 为平台不支持；core consumer smoke 同时验证 installed help、Insights 拒绝诊断与嵌套平台包缺席。

## Next Action

冻结修订 diff 并完成 release follow-up review；通过后合入 main，完成 linux-x64 一次性 bootstrap 与 Trusted Publisher 配置，再创建 0.7.0 GitHub Release。
