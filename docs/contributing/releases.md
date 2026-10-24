# Release guide / 发布指南

公开安装包和校验文件以主仓库 [GitHub Releases](https://github.com/pigq/OpenH3/releases) 为准，不提交到源码树。

## 当前 Alpha

Windows Alpha 为未签名体验包，当前通过 Releases 手动更新。Alpha 2 发布说明要求下载其显式应用源码 ZIP：自动生成的 Source code 附件不包含该包的全部待同步修复。两个仓库同名旧标签也不是同一提交。保留历史说明，后续版本应修复可追溯关系，不能静默移动已发布标签。

## 下一版本的检查项

1. 将计划发布的修改提交到官方仓库，用新的 tag 标记准确提交。
2. 从干净 checkout 安装锁定依赖，运行 CI 和相关测试，再构建发布包。
3. 分别检查源码与解包产物的凭据、第三方 NOTICE 和源码提供材料。
4. 在独立环境验证安装、首启、一个小任务和升级；记录平台与已知限制。
5. 上传安装包和 SHA256，说明签名状态、更新方式及准确的源码提交。

`scripts/open-source-release-audit.js` 是辅助检查：没有产物时 artifact findings 为零不代表二进制通过检查；固定的许可证 review 项也不是自动计算的未解决数量。

不要修改旧兼容标识或更新源来“统一文案”。更新源迁移必须同时检查主进程、feed、允许域名与安装包元数据。

参考：[CI](ci.md)、[第三方 NOTICE](../../resources/third-party-licenses/NOTICE.OpenH3.txt)、[源码提供说明](../../resources/third-party-licenses/SOURCE-OFFER.md)。

## 左下角更新入口（下一个客户端版本）

桌面客户端启动后延迟 30 秒静默检查，此后每 6 小时检查；已有下载缓存可先验证并恢复。发现新版本后在设置旁显示更新入口，用户点击才下载，下载完成后确认安装。普通退出不会自动安装。WebUI 不挂载桌面更新控制器。

发布时须验证当前配置更新源能提供匹配版本、平台、架构的元数据与安装包，校验信息必须一致。无兼容安装包时回退到发布页，不显示无效下载操作。安装包回退明确显示“打开安装包”，不承诺自动重启。

验收至少覆盖：无更新、发现更新但不弹窗、下载进度与失败重试、关闭详情保留入口、确认取消不安装、确认后升级、撤回版本后入口消失。单元测试通过不等同于安装包升级成功；仍需独立 Windows 安装环境实测。

### 确认后的静默覆盖安装

正常自动更新调用 `quitAndInstall(true, true)`：Windows 安装器接收 `--updated /S --force-run`，在原安装位置替换程序并重启，不展示安装向导。首次安装仍保留向导；普通退出仍不安装更新。提权安装仍可能出现系统授权窗口。

NSIS 明确配置 `deleteAppDataOnUninstall: false`，保留现有安装 GUID 和用户资料目录，不通过卸载清数据再安装实现更新。自动更新不可用时，完整安装包入口标为“手动安装（备用）”，不冒充自动更新。

回归检查使用已安装的 NsisUpdater 实现验证实际启动参数，并验证停后端后才交接安装器。仍须在独立 Windows 测试用户中，从旧安装包升级至新包，核对配置、数据库、历史记录与文件，不能用单元测试代替此步骤。

### Desktop update source

Desktop updates use only GitHub Releases in `pigq/OpenH3`. Publish the draft release after uploading installers, blockmaps and all platform/architecture `latest*.yml` files. The native GitHub updater reads these manifests; manual checks use the GitHub Releases API and preserve asset download URLs. Drafts are excluded, prereleases require opt-in, and older versions are not installed. GitHub failures can be retried; there is no upstream CDN fallback.

The normal flow is: download in the background → confirm restart and update → silent replacement and restart. Existing configuration and user data are retained. Manual installer fallback remains a separately labelled action.

## 官方内容库（独立频道）

客户端更新使用 `pigq/OpenH3` 的 GitHub Releases；官方内容库使用同一仓库的 `content-stable` 分支，载荷放在 `content-snapshots` 的不可变 commit。两者不共享版本号、重启按钮或发布元数据，也不访问旧 CDN。内容同步仅更新官方模型介绍、模板和已上架展示作品，绝不下载安装或改写用户模型、ComfyUI 节点、工作流及依赖。用户生成结果不进入官方作品列表。

### 上线前准备

1. 将受信任的 Ed25519 **公钥**（SPKI PEM）及预置轮换公钥加入 `resources/content-catalog/trusted-keys.json`，随客户端发布。私钥不进入仓库和安装包。
2. 在 GitHub 配置受保护的 `official-content` environment、必要审阅者及 `CONTENT_SIGNING_PRIVATE_KEY` secret。该 workflow 只允许官方仓库 `main` 上手动运行。没有公钥时保持随包内置库；不会退化成无签名同步。
3. 审核每项媒体的作者、许可和来源，确认再分发权；模型卡封面与模板、展示作品执行相同的授权门禁。旧内置预览带明确的待审标记，发布器会拒绝，不能以占位授权替换。没有新展示作品时列表可为空。
4. **必须同时交付配套 Core**：HTTP 中继、WebUI 认证和子进程密钥过滤现已集成到主仓库 `core/`。使用默认本地 Core 源构建，确认 bundle 记录的真实版本、构建来源和摘要。仅编译桌面源码不会替换旧 Core，不要用旧二进制冒充完整功能。

### 编辑、校验与预览

编辑源 JSON 包含 `{ catalog, approvals }`。每项审批须匹配 `id/revision`，包含 `status: "published"`、`approvedBy`、ISO `approvedAt`；未上架内容禁止进入产物。稳定 ID 使用 `official:`，变更文本、媒体或行为必须增加修订。模型卡只能描述客户端支持的家族，不能声明任意执行器。

```powershell
node scripts/content-catalog/export-builtin.mjs
node scripts/content-catalog/build.mjs --input content-source/catalog-source.json --assets-dir content-source --out .runtime/content-preview --keyring resources/content-catalog/trusted-keys.json --sequence 1
node scripts/content-catalog/preview.mjs --after .runtime/content-preview/catalog.json
```

`build` 的输出目录必须不存在；检查 schema、默认语言、审批、媒体 magic bytes、摘要、大小、LFS 指针、来源授权和路径边界。输出 `catalog.json`、按摘要命名的媒体及 `changes.json`。本地预览不发布。发布器还会验证当前频道的签名和载荷，重新计算新增/修改/撤下差异并强制修订递增，不能用省略 `--previous` 绕过检查。

### 签名、发布与回退

通过 `Publish official content catalog` workflow 提供编辑源路径、严格递增的序号、key ID 和最低客户端版本。流程先上传完整载荷并提交 `content-snapshots`，再签名最终清单（有效期 30 天），最后以 `force: false` 移动 `content-stable`。中间失败不移动已签名频道；并发冲突需重新审核、重新运行，不 force push。不得创建内容专用的客户端 Release 或改动 `latest*.yml`。

本地离线签名工具 `sign.mjs` 仅从 `OPENH3_CONTENT_PRIVATE_KEY_FILE` 读取私钥；签的是最终清单原始字节，不是重新序列化对象。密钥轮换先通过客户端交付新公钥，再切换签名者；删除旧公钥也须通过客户端发布。

官方回退：用已审阅旧内容构建**更高** `releaseSequence`，在 workflow 填写至少 8 字符的 `rollback_reason`，审批后重新发布；审计原因写进不可变 `changes.json`。本地“恢复上一版本”只切换有效缓存，不降低反重放高水位。过期清单不能新激活，已验证的离线缓存仍可用。

### 运行维护与验收

- 专用缓存位于用户数据目录的 `official-content`，不会删除模型或用户结果。启动后 30 秒检查、每 6 小时检查；网络错误最多按 1/5/15 分钟额外重试。设置可关闭自动同步，手动检查仍可用。
- 必需封面全量校验后原子切换；视频按需读取，支持 Range/HEAD。缓存软上限 512 MiB，保护当前、上一份、恢复凭据和页面租约；超限停止新的可选媒体下载。
- 页面更新只提示刷新，不突然重排；草稿、会话 `creation_request` 及每个新 ComfyUI 任务保留模板修订副本。云图结果旁保留独立 `.generation.json`（实际提示词、来源副本、模型标识、结果摘要），不含 provider 密钥。历史 H3 任务维持原格式，不伪造过去不存在的来源数据。
- Desktop 与 WebUI 复用同一宿主服务；WebUI 经过 Core 认证及 CSRF，普通登录用户只读，只有宿主管理员可控制同步。loopback 内部令牌不回传浏览器，不继承给 agent 子进程。
- `TRUST_UNCONFIGURED`：先交付可信公钥；`SIGNATURE_INVALID`/`DIGEST_MISMATCH`：核对发布产物，不跳过校验；`MANIFEST_EXPIRED`：重新发布更高序号；`CLOCK_INVALID`：检查宿主时间；`CONTENT_HOST_UNAVAILABLE`：检查配套 Core 与宿主；`CACHE_LIMIT`/`DISK_FULL`：处理专用缓存/磁盘，不清理模型。
- 跨进程验收使用隔离临时资料、临时公钥和模型哨兵文件：设置 `OPENH3_CORE_TEST_BINARY` 指向本次构建 Core，运行 `tests/integration/contentCatalog/core.test.ts`。默认未提供该路径时明确跳过此测试，不能据此宣称端到端通过。Windows 覆盖安装、macOS/Linux 安装产物与 Bun standalone 仍须各平台发行验收。

2026-10-23 本地验证：Windows Bun 编译后的 standalone 已通过生产 SPA、匿名拒绝、登录后目录读取、随包 52 个模板/3 个模型卡、资源摘要、Range、CSRF 和独立同步设置的隔离启动冒烟。该验证使用新 Core debug 二进制，不等于正式 tarball、受管运行时完整性或各平台安装升级验收。

### 2026-10-24 提交前审查记录

本次修复了去重下载的任务接管及早到终态、跨平台安装包误推荐、内容恢复/回收并发、跨实例媒体租约及崩溃锁恢复，并加入回归。修改相关的 38 个 Vitest suite 通过（405 项通过，1 项 Bash fixture 因环境跳过）；真实 Core 跨进程内容测试已执行。TypeScript、Electron-vite 构建、格式与 i18n 检查通过；lint 无 error，仍有既有 warning。

配套 Core 的内容认证/CSRF/权限中继 3 项集成测试和内部凭据过滤 2 项测试通过，`cargo check` 与格式检查通过。但 affected-crate 整体测试并未全绿：未改动的 `session_skill` 存在旧品牌变量与 CRLF 断言失败，runtime 的既有 Unix 命令/路径 fixture 在 Windows 上有 13 项失败；Clippy 被未改动的 `openh3-extension/src/skill_view.rs` 嵌套 `if` 阻断。它们不计作本次通过项，也未借此修改无关代码。

此次是源码提交验收，不是正式发布验收。公钥/签名保护环境、媒体授权审批、新 Core bundle 以及真实覆盖安装和各平台发行验收仍须完成。

### 当前单仓库验收（进行中）

以上历史审查针对旧双仓库树，不能作为当前主线或正式发布的结论。当前基于 `pigq/OpenH3` 主线 `787fd3e86` 集成，保留全部 8 个模型家族及原有真实预览/播放交互，目录更新不改写用户安装的模型。内置导出同步覆盖这 8 个家族与 52 个模板。

正式内容签名密钥已于 2026-10-24 根据维护者授权生成并配置，详见下节。媒体再分发授权和上架审批资料尚未准备，尚未发布官方远端内容，客户端继续使用随包内置库。签名密钥就绪不代替内容授权、配套 release Core、实际安装覆盖升级及各平台发行验收；通过源码测试不代表正式发布验收完成。

当前集成已通过 Desktop 的 lint（0 error）、格式、TypeScript、i18n 与完整 Vitest 门禁：618 个 suite、5853 项通过，另有 1 个 suite、9 项按既有条件跳过。跨进程内容测试使用真实 Core 执行，未以默认跳过代替通过。运行使用现有 CI 配置并限制进程为 4 个逻辑 CPU，未增加测试超时或削弱断言。Vite 生产构建亦已通过。

Core 的格式、Clippy 和迁移不可变检查通过。首次 workspace 测试仍有 2 项失败：既有广播 fixture 在订阅前发出了事件，现改用已有 gate 并通过 agent 库全部 981 项；损坏数据库备份遇到 Windows 文件占用，未改生产逻辑，独立重跑该 suite 的 22 项通过。完整 workspace 正在重新验证，此处不将首次全量结果记作全绿。

### 正式内容签名配置（2026-10-24）

- 活跃 key ID：`openh3-content-20261024`；算法 Ed25519，公钥为 SPKI PEM，仅公钥随源码和客户端交付。
- 公钥 SPKI DER 的 SHA256：`1decb9f5ca9eac04dc41c3509dd78e22ea5c7e3ee51ce86064f486607f9cbf41`。
- 私钥以 PKCS8 PEM 保存在维护者本机受限目录；关闭目录继承，仅当前 Windows 用户与 SYSTEM 可访问。私钥不进入 Git、日志或安装包，另行保管加密离线备份。
- GitHub `official-content` environment 已配置 `CONTENT_SIGNING_PRIVATE_KEY`，上传前使用 GitHub environment 公钥通过 libsodium sealed box 加密；不是仓库级 secret。
- 环境仅允许 `main` **分支**（不允许同名 tag），必须由 `pigq` 审批，管理员不能跳过。当前采用单维护者审批，允许发起人本人审批，并非双人复核；增加独立审核人后再启用禁止自审。
- 未触发内容发布 workflow，未创建 `content-stable`/`content-snapshots` 发布来代替未完成的媒体授权。发布前先将公钥随客户端交付，再使用匹配 key ID 签名；轮换同样先交付新公钥再切换 secret。
