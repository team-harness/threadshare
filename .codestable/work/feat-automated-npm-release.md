---
type: feat
status: candidate-verification
created: 2026-08-02
owner_confirmation: confirmed-2026-08-02
implementation_review_round_1_target: sha256:0ea427efe034f7e23320e289fdd1a96ccd3946b4702ed0fd99b7aa8c55043f19
---

# GitHub Release 自动发布 npm

## 目标

把 npm 发布从本机人工操作收敛为可审计的 GitHub Release 流程：维护者先在 `main` 提交与版本一致的候选，再发布同名稳定 Release；GitHub Actions 完成验证，并通过 npm Trusted Publishing/OIDC 发布 `@team-harness/threadshare`，不保存长期 npm token。

首次端到端验收使用 `0.4.2`：实现与版本提交推送后，先配置 npm Trusted Publisher，再创建 GitHub Release `0.4.2`，观察 workflow 实际发布并验证 registry provenance 与隔离安装。

## 现场

- `main`、`origin/main` 与 npm `latest` 当前均为 `0.4.1`；GitHub Release/tag `0.4.1` 已存在，现有 tag 约定不带 `v`。
- 仓库当前没有 `.github/workflows/`；GitHub Actions 已开启，默认 workflow 权限为只读，`gh` 当前有 `repo`/`workflow` 权限。
- npm 包 owner 为 `dafang`，但仓库和 GitHub 当前均未保存 npm secret；Trusted Publisher 尚待配置。GitHub 仓库为 public，满足 npm provenance 的公开来源要求。
- `npm test` 覆盖 CLI、Viewer、API/Worker 与 FC；`npm run build:cloudflare`、FC tests、16 文件 npm pack 边界均已有本地证据。
- Skill 校验目前引用本机 `skill-creator/scripts/quick_validate.py`，fresh GitHub runner 不可复现。
- `package-lock.json` 的现有 resolved URL 来自本机 npm 镜像；发布 CI 应统一改为官方 npm registry，避免把个人镜像配置带入供应链。
- `.codestable/lessons/` 与 v1 只读知识目录不存在；相关历史边界来自 `AGENTS.md` 和已接受 Epic `.codestable/epics/lightweight-sharing-evolution.md`。
- 已用不修改全局安装的临时工具链实测 Node `22.22.3` 与 npm `12.0.2` 均可用且 engines 兼容；本机默认版本不能代替该 pinned 组合的发布证据。

## 边界与决策

### 发布触发与身份

- 唯一触发器是 `release: types: [published]`；job 级显式要求 GitHub Release 的 `draft == false` 且 `prerelease == false`，防止稳定 semver tag 被误标为 prerelease 后仍发布 `latest`。
- Release tag 必须是无前缀稳定 semver，且精确等于 `package.json`、lockfile 顶层与根 package 的版本。
- checkout 锚定 release event 给出的不可变 `GITHUB_SHA`，fetch 完整历史与 tag；校验当前同名 tag 仍指向该 commit，并要求该提交是 `origin/main` 的 ancestor，拒绝 tag 移动窗口与游离 tag 发布。
- `verify` job 只授予 `contents: read`，负责依赖安装、完整测试、构建、Skill 校验与候选 pack；`publish` job 依赖其成功后才获得 `contents: read` 与 `id-token: write`，且不运行 `npm ci`、测试或构建。两个 job 都重新计算候选 integrity 并要求完全一致，把 OIDC 权限限制在来源复核、发布与发布后确认的最小阶段；checkout 均禁止持久化 GitHub credential。
- 使用 GitHub-hosted runner、Node `22.22.3` 与固定 npm CLI `12.0.2`。`actions/checkout`、`actions/setup-node` 固定到已核对的完整 commit SHA，并保留版本注释；两个 release job 都不启用 package manager cache。
- npm Trusted Publisher 精确绑定 `team-harness/threadshare`、workflow `publish-npm.yml`，Environment 留空，Allowed actions 只选择 `npm publish`；包级 Publishing access 设置为要求 2FA 并禁止 token 发布，只允许 Trusted Publisher 或交互式 2FA 路径，不增加 `NPM_TOKEN` 或 GitHub repository secret。npm 侧每个包同时只能有一个 Trusted Publisher，且本 workflow 必须保持 public GitHub 仓库与 GitHub-hosted runner。本次不绑定 GitHub Environment，避免为单一稳定 Release 流程增加另一套审批依赖；团队权限模型扩大时再单独评估。

### 门禁与幂等

- 新增仓库内可复现的 Skill validator；契约来源固化为：`SKILL.md` 必须有 YAML 字典 frontmatter，允许键仅 `name`、`description`、`license`、`allowed-tools`、`metadata`，必含字符串 `name`/`description`；name 使用 1–64 位小写字母、数字和单连字符，不得首尾/连续连字符，且与目录名一致；description 非空、不超过 1024 字符且不含尖括号。`agents/openai.yaml` 必须含字符串 `interface.display_name`、25–64 字符的 `short_description`、以及显式提及 `$threadshare` 的 `default_prompt`。`AGENTS.md` 改为调用仓库命令，不再依赖 fresh runner 不可解析的本机路径。
- 新增 release verifier，严格校验 tag/package/lock 版本、稳定 semver，以及 `npm pack --dry-run --ignore-scripts --json` 的 16 文件精确白名单。
- 新增自动化测试覆盖上述成功与失败路径，并静态锁定 workflow 的触发器、draft/prerelease 守卫、两 job 权限隔离、SHA pin、event SHA 与 tag 一致性、主分支归属检查、完整门禁、跨 job integrity 一致性、OIDC publish 与无 token 契约。
- `verify` job 运行 `npm ci`、完整 `npm test`、独立 Cloudflare build、Skill validator 与 release verifier；任一步失败都不会启动 `publish` job。`publish` job 只重新核对来源与 pack、比较两个 job 的 integrity、按需发布并做后置确认。
- 发布前直接读取官方 registry 的完整 packument `GET https://registry.npmjs.org/@team-harness%2fthreadshare`，必须在有界重试内得到 HTTP 200 与结构合法的 JSON；404、超时、5xx、非 JSON、缺失 `dist-tags.latest`、latest 不是稳定 semver、或 latest 未出现在 `versions` 中均严格失败，任何探测失败都不得解释为“版本不存在”。目标版本是否存在只由 `versions` 中精确键判断，并用真实 semver 数值比较器而非字符串比较。
- 若目标版本已存在，先比较 registry integrity：与本次 pack 一致则跳过 publish 并进入后置确认，不一致则严格失败；该分支允许 `latest` 已是更高稳定版本。只有目标版本不存在时才要求目标版本严格高于 `versions` 中所有已发布稳定版本并允许发布，防止 `latest` 被人工回退后旧 Release 把 dist-tag 降级。
- 发布使用 `npm publish --ignore-scripts --access public --provenance --registry=https://registry.npmjs.org`；pack 预检同样禁用 lifecycle scripts。Trusted Publishing 会自动生成 provenance，显式 `--provenance` 是有意的 fail-closed 防线。
- publish 与幂等 skip 两条路径随后都在最多 5 分钟内退避重试：确认目标版本与本次 pack integrity 一致，并严格要求 `dist.attestations.provenance.predicateType == "https://slsa.dev/provenance/v1"` 与非空 `dist.attestations.url`；`dist.signatures` 只是 registry 签名，不得作为 provenance 证据。后置确认要求 `latest` 不得低于目标；首次发布前目标已被要求高于所有稳定版本，因此正常发布后应精确指向目标，手动重跑一个已被更高稳定版本取代的旧 Release 时则允许 `latest` 保持在更高版本且绝不回退。`latest` 低于目标或 provenance 缺失均严格失败。
- workflow 使用 package 级 concurrency 分组且不取消进行中任务，所有版本共用单一发布通道，避免不同 Release 并发抢占 `latest`；publish 前的 `latest` 比较仍作为跨通道 fail-closed 防线。
- integrity 幂等依赖 tag commit 中冻结的 Node + npm 组合：已发布 Release 只能用 `gh run rerun <run-id>` 重放原 event、原 `GITHUB_SHA` 与原工具链，不得删除、移动或重建已发布 tag。后续 pin 更新只作用于新 Release，因此旧 run 的 tarball 字节判据保持可复现；违反该边界时 integrity 不同会严格失败。

### 非目标

- 不把 Cloudflare/FC 生产部署接入本 workflow；npm Release 与生产切流继续独立授权。
- 不自动推断或修改版本，不从 commit message 生成版本，不引入 release-please/Changesets。
- 不支持 prerelease 到 `next`；需要时作为独立功能设计。
- 不保存 npm token，不降低 package 2FA 或 GitHub Actions 权限边界。
- 不在本轮增加 GitHub Environment、organization 级 `sha_pinning_required` 或 Dependabot；SHA pin 与 Node/npm pin 的更新规则写入维护文档，平台级强制策略另行评估。
- 不支持多个稳定 Release 同时排队；日常流程必须等待前一个 Release workflow 成功后再发布下一版本。

## 影响面

### 必须修改

- `.github/workflows/publish-npm.yml`：Release 触发、验证、OIDC 发布与发布后确认。
- `scripts/validate-skill.mjs`：仓库内 Skill 校验。
- `scripts/verify-release.mjs`：版本、pack、registry integrity 与 GitHub outputs。
- `test/release-automation.test.mjs`：release tooling 与 workflow 契约测试。
- `package.json` / `package-lock.json`：脚本、测试链、YAML dev dependency、最终版本 `0.4.2`；lockfile 仅机械替换 `resolved` 的 registry host，保留所有版本与 integrity，不重新解析依赖树。
- `AGENTS.md`：可复现验证命令、GitHub Release 发布流程、pin 更新归属，以及 publish 前/后失败的恢复 runbook。

### 需要验证

- 既有 CLI/Viewer/API/FC tests、Cloudflare build、Skill validator、16 文件 pack 白名单。
- workflow YAML 可解析，脚本在 Ubuntu/Node 22.22.3/npm 12.0.2 下执行；本地候选也通过临时工具链使用同一版本组合复跑 release verifier 与 pack 检查，并记录 pack integrity。CI publish 前输出同 runner、同工具链计算的预期 integrity，发布后 registry 必须与它精确相等；本地值作为跨环境诊断证据一并比对，不代替 CI 同 runner 门禁。
- lockfile 替换 registry host 后，使用全新临时 npm cache 执行 `npm ci`，并确认 `package.json` 与 `package-lock.json` 均未被重写。
- GitHub Actions 默认只读设置与 job 级 `id-token: write` 生效。
- npm Trusted Publisher 的 repository/workflow 绑定准确，首次 `0.4.2` Release 无 token 发布成功。
- npm `latest`、provenance、实际 tarball 隔离安装和 CLI help。
- 失败恢复：仅在确认 npm 目标版本尚不存在时，publish 前失败可修复 `main`、删除未发布的 Release/tag，再以同版本和新 commit 重建；publish 已成功但后置确认因 registry 暂态失败时使用 `gh run rerun <run-id>` 重放原 workflow、走同 pin 的幂等确认。若失败来自 workflow 缺陷，则保留已发布版本与 tag，修复 `main` 并 bump 下一版本，绝不覆盖、移动或复用 npm 已发布版本。concurrency 导致的 `cancelled` 不是成功：若尚无更高版本，重跑该 run；若更高版本已发布，则不得补发低版本，只记录该版本跳过并继续更高版本。

### 仍待调查

- Owner 已在 npm 页面配置 Trusted Publisher：organization `team-harness`、repository `threadshare`、workflow `publish-npm.yml`、Environment 留空、Allowed actions 仅 `npm publish`；Release 前还需核对包级禁 token 发布设置并轮换已暴露 token。
- npm Trusted Publisher 保存后是否立即可用于首次发布；以 `0.4.2` workflow 的 OIDC 发布结果为准，不用本机 token 兜底。

## 证据

- TDD：先加入 release automation tests，依次观察缺少 `yaml`、缺少 workflow 的红测；pinned npm 12 暴露 pack JSON 顶层从数组变为包名对象后，再补一轮确定性红测并实现 npm 10/12 双形状兼容。实现审查后又补齐最高稳定版本防降级、两 job OIDC 隔离、参数/GitHub output/integrity 守卫与 Skill 失败路径测试；当前 release tests 8/8 通过。
- 本地候选：常规 `npm test`、`npm run build:cloudflare`、Skill validator；再用 Node 22.22.3/npm 12.0.2 的临时工具链执行 release verifier、`npm pack --dry-run --ignore-scripts --json` 与空 cache `npm ci`，记录 integrity，不以本机默认 npm 10 的输出代替 pinned 证据。Cloudflare build 虽已被 FC test 间接执行，仍有意独立运行并保留单独信号。
- Fresh 验证：默认工具链与 pinned Node 22.22.3/npm 12.0.2 下完整测试均通过（CLI 86、Viewer 2、API/Worker 25、release 8、FC 14）；pinned 独立 Cloudflare build 通过。空 cache `npm ci` 前后 package/lock SHA-256 不变。
- Pack/安装：npm 12 pack 恰好 16 文件，integrity `sha512-2rnC2vIwOGj10vWh7nKKTgV67gNnNm8KfAnzPhH0FCg/trCXP3I/kt04ij6DOqgJpSlMgE2fpvebIhPOy0MIkw==`；真实 registry preflight 得出 `latest=0.4.1`、`shouldPublish=true`。临时 tarball 安装到隔离 prefix 后，包版本为 `0.4.2`，真实 `threadshare --help` 成功。
- 独立 diff review：首轮冻结审查为 0 Blocking、5 Important，均已修复；Round 2 Opus 5 复审确认这 5 条全部闭环，新增的 workflow 守卫测试缺口也已补齐。其余为既有 5 分钟 attestation 确认窗口的运维风险：若包已写入但 run 因可见性延迟变红，必须按 runbook 重跑原 run，绝不删除 Release 或移动 tag。
- 线上验收（待执行）：创建 GitHub Release `0.4.2` 后，要求对应 workflow 成功、npm 官方 registry 显示 `latest=0.4.2` 且有 provenance，并从官方 registry 安装到临时 prefix 运行 CLI help。

## 验收

- Release tag、package/lock 版本或 `main` 归属不一致时，在 publish 前严格失败。
- 目标版本不高于 registry 已发布的最高稳定版本时不允许首次 publish，不会因手工回退过 `latest` 而降级 dist-tag；不同版本的 workflow 也不会并发发布。
- workflow 无任何 npm secret；完整验证 job 只有 `contents: read`，最小发布 job 才有 `contents: read` 与 `id-token: write`。
- 全量门禁失败时不发布；同一成功 Release 重跑不会重复发布，内容不一致不会被当作成功。
- `0.4.2` 由 GitHub Release workflow 实际发布，而不是本机 `npm publish`。
- npm 包仍恰好包含既有 16 个允许文件，CLI 默认服务与所有公开行为不变。
- GitHub/npm 一次性配置和日常发布步骤在 `AGENTS.md` 中可复现。
- `AGENTS.md` 明确区分 publish 前失败与 npm 已写入后的失败恢复，避免移动已发布 tag 或尝试覆盖 npm 版本。
- 每个稳定 Release 必须对应一个终态为 `success` 的 workflow run；`cancelled` 视为未完成，且下一稳定 Release 必须等待当前 run 成功。

## 状态与未决

- 当前：设计审查与两轮实现审查的有效代码发现均已吸收；最后一项 workflow 守卫测试已补齐，等待最终冻结目标复审。
- Owner 于 2026-08-02 确认推荐方案：授权实现、提交并推送 `main`；授权在浏览器配置 Trusted Publisher、禁 token 发布并轮换已暴露 token后创建稳定 Release `0.4.2`，触发不可逆 npm 发布；不授权 Cloudflare/FC 部署。
