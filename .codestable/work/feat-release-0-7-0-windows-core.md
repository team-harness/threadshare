# Release 0.7.2 Recovery — Windows Core-Only

## Target

发布 `@team-harness/threadshare@0.7.2`。macOS/Linux arm64/x64 发布完整原生 Insights Engine；Windows arm64/x64 只安装并验证 root core CLI，不发布 Windows Engine 包。`darwin-arm64@0.7.0` 与 `darwin-arm64@0.7.1` 已发布且不可变，但两个 root 版本均未发布；按恢复规则不回填旧版本，改发完整 0.7.2。

## Boundaries

- 保留六目标运行时与独立 Engine CI，以便继续验证 Windows 可编译性。
- 稳定发布集合仅为四个 macOS/Linux Engine 包加 root，共五个 npm 包。
- 六目标 consumer smoke 必须全部通过；Windows 必须证明 root-only 安装中没有平台 Engine 包且 core CLI 可执行。
- root 始终最后发布，现有 `@team-harness/threadshare@0.6.1` 在此之前不受影响。

## Acceptance

- release staging、manifest、optional dependencies、SBOM 与 publish verifier 精确绑定四个 Engine release targets。
- `publish-npm.yml` 不引用 Windows 签名 secrets，不构建或发布 Windows Engine。
- npm registry 中缺失的 `@team-harness/threadshare-linux-x64` 只执行一次 binary-free bootstrap；不重复已有 bootstrap。
- Apple 签名、公证、四 Engine provenance、六 consumer smoke、root-last publish 全绿后，临时前缀安装并验证 `0.7.2`。

## Status

- 2026-08-11：owner 已确认 Apple 环境可用，并批准 Windows 在 0.7.x 降级为 core CLI only。
- 2026-08-11：release staging、五包 bundle 与六目标 consumer smoke 的 TDD 切片已落地；`npm run test:release` 60/60 通过。
- 2026-08-11：Node 22.22.3 下 Insights Node 234、Rust 170、CLI 176、Viewer 7、API 32、FC 19 全绿；Cloudflare build、Skill validation、evidence verifier、npm 54-file dry-run 与 `git diff --check` 通过。
- 2026-08-11：Agent Query 终审唯一 important 已关闭，公开 coverage 现固定回显 `scope: "all-indexed-history"`，并明确 selection 有界而 coverage 聚合是全历史线性成本。
- 2026-08-11：release review 发现 npm 首次 bootstrap 会把 `latest` 初始化到 `0.0.0-bootstrap.0`；verifier 现仅容忍这一精确例外，并继续拒绝其他 prerelease latest。
- 2026-08-11：Windows 所有 `insights` 动作现明确 fail-closed 为平台不支持；core consumer smoke 同时验证 installed help、Insights 拒绝诊断与嵌套平台包缺席。
- 2026-08-11：首次 0.7.0 workflow 在任何 npm publish 前失败：npm 12 `pack --json` 返回按包名索引的对象，workflow 却按旧数组形状读取 `[0].filename`。修复把两种输出形状收敛到共享 parser，并由独立 CLI 供 workflow 使用。
- 2026-08-11：四个 Engine 包的 npm Trusted Publisher 已配置为 `team-harness/threadshare` 的 `publish-npm.yml`：darwin-arm64 `51628bbe-d876-4c53-8d49-38be9a99e5b5`、darwin-x64 `5a3af625-0da7-4320-b0d7-678bcfa965ee`、linux-arm64 `627ed33b-2a58-4847-be4e-db18f7f328e7`、linux-x64 `dc8042d8-3e29-4d6c-8c39-5c9c5f38785c`。root Trusted Publisher 已由 0.6.1 发布实证。
- 2026-08-11：第二次 0.7.0 workflow 的 verify、四 Engine 构建/签名/公证与 npm 12 package-release 全绿；首个平台 publish 在 registry 写入前被 npm provenance 校验拒绝，因为生成的平台 `package.json` 缺少 `repository.url`。五包 0.7.0 仍全部不存在。平台 manifest 现固定携带与 root 0.6.1 已验证 provenance 相同的 canonical GitHub repository。
- 2026-08-11：第三次 0.7.0 workflow 成功发布 `darwin-arm64@0.7.0` 及其 SLSA provenance，随后即时 registry 安装确认遇到传播延迟；attempt 2 又发现 npm 12 的 provenance buildType 已切换为 GitHub Actions SLSA v1。0.7.0 Release/tag 与已发布平台包保持不可变，root 0.7.0 不回填。校验器现精确接受旧 npm CLI 与当前 GitHub Actions 两种 buildType，并已对真实 0.7.0 包完成全链复核。
- 2026-08-11：0.7.1 attempt 1 发布 `darwin-arm64@0.7.1` 后遇到 registry 传播延迟；attempt 2 已能复用并验证其 SLSA provenance，但 Linux runner 在隔离验证 Darwin 包时被 npm `EBADPLATFORM` 拒绝。0.7.1 Release/tag 与已发布平台包保持不可变，root 0.7.1 不回填。
- 2026-08-11：registry attestation 校验的临时安装现显式使用 `--force`，仅绕过校验机与目标包的 os/cpu 不匹配，不改变普通用户安装约束。回归测试先红后绿，并已对真实 `darwin-arm64@0.7.1` 完成跨平台安装与 `npm audit signatures --include-attestations` 验证。
- 2026-08-11：0.7.2 发布候选全量验证通过：顶层测试、release 61、Insights Rust 170、Insights Node 234、evidence verifier、Skill、54-file npm pack 与 `git diff --check` 全绿；code-intel working-tree review 风险为 low（20/100）。

## Next Action

提交并推送 0.7.2 精确候选；确认 0.7.1 workflow 终态后创建 0.7.2 Release，监控到五包 registry、provenance、六平台 consumer smoke、root-last publish 与本机安装验证全部完成。
