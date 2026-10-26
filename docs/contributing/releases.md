# Release guide / 发布指南

公开安装包和校验文件放在主仓库 [GitHub Releases](https://github.com/pigq/OpenH3/releases)，不提交到源码树；`BHUHD/OpenH3` 只作为同一项目的镜像。

## 历史 Alpha 与 3.0.0 迁移边界

历史 Windows Alpha 为未签名体验包，通过 Releases 手动更新。Alpha 2 发布说明要求下载其显式应用源码 ZIP：自动生成的 Source code 附件不包含该包的全部待同步修复。两个仓库同名旧标签也不是同一提交。保留历史说明，后续版本应修复可追溯关系，不能静默移动已发布标签。

已发布的官方 `3.0.0` 仍使用旧 CDN 更新源，不具备本次 GitHub feed 迁移和官方内容协议。在不访问旧 CDN 的前提下，它不能自动发现新的 GitHub 更新源。迁移到实际发布的 `3.0.1` 时，需要从官方 GitHub Releases 下载新安装包，正常退出旧版后做**一次手工覆盖安装**，不卸载、不删除原资料；之后的更新才使用新客户端的 GitHub feed。不能重编或修改旧版 feed，再把测试称为原版 `3.0.0` 自动升级。

`3.0.1` 仍须完成发行验收后才能发布。源码版本号、Actions artifact 或本地单元测试不是已发布安装包，也不是已通过真实旧版覆盖安装的证明。

## 下一版本的检查项

1. 将计划发布的修改提交到官方仓库，用新的 tag 标记准确提交。
2. 从干净 checkout 安装锁定依赖，运行 CI 和相关测试，再构建发布包。
3. 分别检查源码与解包产物的凭据、第三方 NOTICE 和源码提供材料。
4. 在独立环境验证安装、首启、一个小任务和升级；记录平台与已知限制。
5. 上传安装包和 SHA256，说明签名状态、更新方式及准确的源码提交。

`scripts/open-source-release-audit.js` 是辅助检查：没有产物时 artifact findings 为零不代表二进制通过检查；固定的许可证 review 项也不是自动计算的未解决数量。

不要修改旧兼容标识或更新源来“统一文案”。更新源迁移必须同时检查主进程、feed、允许域名与安装包元数据。

参考：[CI](ci.md)、[第三方 NOTICE](../../resources/third-party-licenses/NOTICE.OpenH3.txt)、[源码提供说明](../../resources/third-party-licenses/SOURCE-OFFER.md)。

## 既有手工入口

继续使用 `🔨 Manual Build`（`.github/workflows/build-manual.yml`），通过显式 `mode` 分开操作，不新增内容发布 workflow：

- `build`（默认）：保留原六平台及 `all`、`branch`、质量检查开关和 Core run ID / 旧别名输入行为。仍调用原 reusable build，只产构建附件，不因这次整合触发内容发布。
- `official-content`：只运行官方内容发布 job，绝不准备桌面构建矩阵或调用桌面 reusable build。必须在 `pigq/OpenH3` 的 `main` 上手工触发；`branch`、`platform`、质量开关及 Core run ID 在此模式不生效。内容来源固定为此次触发的 `main` 提交，不能用 `branch` 偷换为另一来源。

两个模式共享九个 dispatch 输入；内容模式只需 `content_source`、`content_sequence`，回退时再填 `rollback_reason`。这两个内容输入在 dispatch 表单上可留空，避免改变普通构建必填项；内容 job 会拒绝缺失序号或无效源。官方 key ID 与协议最低客户端 `3.0.1` 固定在发布 step 中，不占额外输入，也不随未来桌面包版本无故提高最低兼容门槛。该入口不绕过正常发布审查，不创建客户端 tag / Release。

## 官方内容库（独立频道）

客户端更新使用 `pigq/OpenH3` 的 GitHub Releases；官方内容库使用同一仓库的 `content-stable` 分支，载荷放在 `content-snapshots` 的不可变 commit。两者不共享版本号、重启按钮或发布元数据，也不访问旧 CDN。内容同步仅更新官方模型介绍、模板和已上架展示作品，绝不下载安装或改写用户模型、ComfyUI 节点、工作流及依赖。用户生成结果不进入官方作品列表。

### 上线前准备

1. 将受信任的 Ed25519 **公钥**（SPKI PEM）及预置轮换公钥加入 `resources/content-catalog/trusted-keys.json`，随客户端发布。私钥不进入仓库和安装包。
2. 在 GitHub 配置受保护的 `official-content` environment、必要审阅者、仅允许 `main` 的部署规则及 environment secret `CONTENT_SIGNING_PRIVATE_KEY`。使用上述手工入口的 `official-content` 模式；内容 job 只允许官方仓库 `main` 上运行。不要把内容私钥配置成普通构建继承的仓库或组织 secret。没有公钥时保持随包内置库；不会退化成无签名同步。
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

通过 `🔨 Manual Build` 的 `mode=official-content` 提供 `content_source`（该 `main` 提交内已审阅源 JSON 路径）及严格递增的 `content_sequence`。发布 job 使用受保护的 `official-content` environment，仅该内容 job 获得 `contents: write`；原桌面 build job 的既有权限不变，但内容模式不会运行它。内容发布按独立 concurrency group 串行、不取消在途发布；普通构建不受此锁影响。私钥只注入签名 step，临时文件以独占方式、`0600` 权限创建，并在退出及 `always()` 清理时删除。

固定签名 key ID 为 `openh3-content-20261024`，清单 `minClientVersion` 为该协议首次交付版本 `3.0.1`。流程先验证全部审批与媒体，再由既有发布器验证当前频道签名、载荷与严格递增序号；上传完整载荷并提交 `content-snapshots` 后，才签名最终清单（有效期 30 天），最后以 `force: false` 移动 `content-stable`。中间失败不移动已签名频道，可能留下未激活的不可变快照；并发冲突需重新审核、重新运行，不 force push。不得创建内容专用的客户端 Release 或改动 `latest*.yml`。

本地离线签名工具 `sign.mjs` 仅从 `OPENH3_CONTENT_PRIVATE_KEY_FILE` 读取私钥；签的是最终清单原始字节，不是重新序列化对象。密钥轮换先通过客户端交付新公钥，再切换签名者；删除旧公钥也须通过客户端发布。

官方回退：用已审阅旧内容构建**更高** `releaseSequence`，在 workflow 填写至少 8 字符的 `rollback_reason`，审批后重新发布；审计原因写进不可变 `changes.json`。本地“恢复上一版本”只切换有效缓存，不降低反重放高水位。过期清单不能新激活，已验证的离线缓存仍可用。

### 运行维护与验收

- 专用缓存位于用户数据目录的 `official-content`，不会删除模型或用户结果。启动后 30 秒检查、每 6 小时检查；网络错误最多按 1/5/15 分钟额外重试。设置可关闭自动同步，手动检查仍可用。
- 必需封面全量校验后原子切换；视频按需读取，支持 Range/HEAD。缓存软上限 512 MiB，保护当前、上一份、恢复凭据和页面租约；超限停止新的可选媒体下载。
- 页面更新只提示刷新，不突然重排；草稿、会话 `creation_request` 及每个新 ComfyUI 任务保留模板修订副本。云图结果旁保留独立 `.generation.json`（实际提示词、来源副本、模型标识、结果摘要），不含 provider 密钥。历史 H3 任务维持原格式，不伪造过去不存在的来源数据。
- Desktop 与 WebUI 复用同一宿主服务；WebUI 经过 Core 认证及 CSRF，普通登录用户只读，只有宿主管理员可控制同步。loopback 内部令牌不回传浏览器，不继承给 agent 子进程。
- `TRUST_UNCONFIGURED`：先交付可信公钥；`SIGNATURE_INVALID`/`DIGEST_MISMATCH`：核对发布产物，不跳过校验；`MANIFEST_EXPIRED`：重新发布更高序号；`CLOCK_INVALID`：检查宿主时间；`CONTENT_HOST_UNAVAILABLE`：检查配套 Core 与宿主；`CACHE_LIMIT`/`DISK_FULL`：处理专用缓存/磁盘，不清理模型。
- 跨进程验收使用隔离临时资料、临时公钥和模型哨兵文件：设置 `OPENH3_CORE_TEST_BINARY` 指向本次构建 Core，运行 `tests/integration/contentCatalog/core.test.ts`。默认未提供该路径时明确跳过此测试，不能据此宣称端到端通过。Windows 覆盖安装、macOS/Linux 安装产物与 Bun standalone 仍须各平台发行验收。

### 当前交付状态

- 随包信任锚已配置生产 Ed25519 公钥，key ID 为 `openh3-content-20261024`；仅公钥随客户端交付，私钥不进入源码、安装包或日志。
- `sourceConfigured` 只说明客户端有受信任公钥，不代表远端频道已发布或媒体已获授权。当前媒体再分发授权及逐项上架审批材料尚未准备，本次不发布官方远端内容；频道未发布、请求失败或验签失败时保留随包内置库或上一份已验证缓存，不退化为无签名同步。
- 内置库保留全部 8 个受支持模型家族、52 个模板和原有真实预览/播放；模型由用户自行下载和管理。作品卡区仅接受官方模板与审核上架展示，用户生成结果不混入官方目录。
- 正式私钥离线加密备份及真实旧版 Windows 覆盖升级验收仍须完成。原完整 feature 树的历史测试和产物记录不作为本次独立内容分支已通过验收的证据；新分支须重新构建配套 Core 并执行跨进程内容测试。

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
