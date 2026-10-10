### 2026-09-29 OpenH3 Alpha 安装包更新

- 用户确认新的 OpenH3 字标为正式品牌资源；已保存原始 `openh3-logo-source.png`，生成透明 `openh3-logo.png`、桌面 `app.png` 和 Windows `app.ico`，并将登录页、侧栏和安装包切换到新字标。
- 已加入 OpenH3 QQ 群 790631169 及二维码 `docs/assets/openh3-qq-group.png`，同步中英文 README 和支持文档。
- 已重新构建采用新字标的 Windows x64 未签名 Alpha 体验包：`out/OpenH3-2.2.2-win-x64.exe`（240,151,599 bytes，SHA256=`0504375D3DF9909F10F1C08CBC7E04AD69DC5B8CC87B152FF33FD852D4EAAA5C`）。
- 客户端可见品牌继续迁移：About、更新入口、远程连接提示、诊断提示、频道描述和中英文设置/团队/定时任务中的 CLI 名称已统一为 OpenH3；旧 `appId`、协议、存储键和内置助手 ID 保留以确保升级兼容。

- 修复快速构建跳过版本/图标编辑的问题：改为仅禁用签名，保留 OpenH3 产品信息；带签名凭据时拒绝禁用签名的回归测试同步覆盖。
- 发布配置与签名策略回归 17 passed、1 skipped；TypeScript 和 i18n 通过。首次重建后的 ASAR 检查 40,566 个条目，未发现 Provider bootstrap、模型权重或匹配的 Provider Key/本机用户路径。
- 补充运行时原始许可证以及 npm NOTICE 生成脚本；清单覆盖 1,726 个依赖版本，包含 managed npm，ASAR 中 973 个包无清单遗漏。41 个包的标准许可证补充与原始证据缺失分开记录；jsonify 的 Public Domain 声明未伪造成许可证原文。
- 已确认 AionCore v0.2.2 为 Rust 二进制，并非 Bun compile；顶层许可证不代表 654 个 Cargo 锁定依赖的声明已经核齐。
- 3 个 H3 工作流原样内嵌随包提供，已补固定 revision 的 LICENSE、NOTICE、逐文件 SHA256；模型权重不随包提供。工作流的分发范围不能被项目 Apache-2.0 声明覆盖。
- FFmpeg 保留，不发布删减功能版。当前待核实其完整对应源码提供路径；缺少材料不影响已有二进制的正常执行。
- GitHub Alpha 体验包已公开更新；它仍是未签名体验包，不应描述为正式发布包。构建通过、许可证据和新机器实测分别记录；现有审计脚本的 6 条固定 review 项不能被理解为自动计算的未解决数量。

### 2026-09-29 公开仓库首页与 About

- 已确认仓库公开，About description、使用指南 Website 和 9 个 Topics 已写入并通过 GitHub API 回读确认。
- 产品主定位更新为“对话驱动的本地 AI 创作引擎”，中英文 README 同步，明确当前以 H3 / ComfyUI 视频工作流为核心。
- GitHub Releases 暂无公开安装包；README 和快速开始改为源码入口，Release 徽章改为 Alpha 状态徽章，不再引导用户下载不存在的文件。
- 修正文档首页失效入口、开发指南上游克隆地址、远程 Provider 数据边界以及第三方运行时分发说明。
- Discussions 已启用，支持文档同步；私密漏洞报告尚未启用，安全文档移除不存在的 GitHub 私信方式。
- 本轮为仓库元数据与文档修订，不重建安装包，也不改变现有许可证证据或实机测试结论。

### 2026-09-23 P0 发布审计首轮

- [x] 新增 scripts/open-source-release-audit.js 和 npm run audit:open-source-release，检查源码、构建产物、Provider bootstrap 和许可证文件。
- [x] 清除本地 out/win-unpacked/resources/video-provider-bootstrap.json 旧体验包残留；本轮审计结果为源码0项凭据、构建产物0项凭据、许可证文件6项。
- [ ] 依赖许可证清单仍需补齐 ComfyUI、第三方节点、H3权重、工作流和运行时版本/来源/再分发边界；当前6项只是仓库可见许可证文件，不代表许可审查完成。
- [ ] 公开构建仍需在打包后执行该审计；体验包注入 Provider Key 的构建入口只能用于内部测试，不能用于公共 Alpha。

### 2026-09-23 OpenH3 品牌资源首轮

- [x] 以用户确认的 `openh3-logo-source.png` 作为品牌源，生成透明字标、renderer 图标、Linux PNG 和 Windows 多尺寸 ICO。
- [x] Windows electron-builder 的 `resources/app.ico` 引用已补齐；未改 `appId`、协议 scheme、数据目录和更新仓库，保留旧版本升级兼容性。
- [x] 新增 `npm run generate:openh3-icons`，可在换图后重复生成二进制图标资源。
- [ ] macOS `app.icns` 仍需在 macOS 构建机生成并做安装包视觉回归；当前不能宣称全平台图标验收完成。

### 2026-09-23 OpenH3 发布前构建验收

- [x] 已重新执行 `node scripts/generate-openh3-icons.mjs`、发布配置单测（10 passed、1 skipped）、`tsc --noEmit`、`check-i18n.js` 和 `open-source-release-audit.js`；发布审计为 source findings 0、artifact findings 0、license files 6。
- [x] Electron Vite build 通过。Windows x64 fast 构建首次暴露 `@electron/rebuild` v4 不接受 `--platform` 的真实错误，已在 `scripts/rebuildNativeModules.js` 移除该参数并重新验证；原生 `better-sqlite3` prebuild 和二进制检查通过。
- [x] 已生成 OpenH3 未签名体验包 `out/OpenH3-2.2.2-win-x64.exe`（306,594,235 bytes，SHA256=`E65A46FCC4E506ADFBB1AB3161395D48758A0C16E995198C5D89838C2BEE9D44`）。包内 `resources/app.png` 为 OpenH3 图标，`app.asar`、FFmpeg 与 ffprobe 存在；构建产物审计未发现 Provider Key、私有地址或本机路径泄露。
- [ ] 当前仅代表本机自动化构建和包级检查通过，不代表 PC09 或干净机器实机验收；仍需安装/首启、H3 三模式、失败恢复、视觉回归和卸载复验。
- [ ] 包尚未签名，不能描述为正式发布包；macOS ICNS、许可证/权重再分发证明、兼容迁移和公开仓库历史清理仍是公开 Alpha 阻断项。

### 2026-09-23 P0 组件边界盘点

- [x] 已核对自研桌面/媒体/H3 服务、AionCore v0.2.2、ComfyUI 便携运行时、三类内嵌 H3 工作流、自定义节点归档、H3 模型/VAE/文本编码器、FFmpeg/ffprobe、7zr 及 Python/Triton 安装依赖的代码入口和固定来源字段。
- [x] 已确认下载器对模型、节点、运行时和解压器执行固定 URL/revision/大小/SHA256 或 SHA512 校验；失败不会静默替换为未校验文件。
- [ ] 许可证和再分发证明尚未完成：当前仓库可见许可证文件数量不能代表 ComfyUI、第三方节点、H3 权重、工作流、FFmpeg 和运行时均可公开分发。
- [ ] H3 融合/量化权重所含 Turbo LoRA、Mystic LoRA 和转换文件尚未取得独立授权证明；MiniMax 原始模型许可不能自动覆盖这些衍生文件。
- [ ] 仍需补齐组件清单中的版本、来源、许可证原文、NOTICE、再分发范围和公开包处理方式；完成前不把模型或运行时放入公开基础安装包，也不宣称完整开源合规。

当前开源路线下一步：先完成组件许可与权利证明台账，再设计 AionUi 旧身份到 OpenH3 的兼容迁移；保持现有 `appId`、`aionui://`、数据目录和更新仓库不变。H3 基础能力已完成，SLA 实机矩阵属于独立的性能质量支线。

### 2026-09-23 发布审计范围修正

- [x] `scripts/open-source-release-audit.js` 已从仅扫描 Git 已跟踪文件改为扫描“已跟踪 + 未被 `.gitignore` 排除的工作树文件”，覆盖当前尚未提交的 H3/媒体源码。
- [x] 修正后重新执行审计：Source findings 0、Artifact findings 0、License files 6；releasePackagingConfig 为 10 passed、1 skipped，TypeScript 检查通过。
- [ ] 这仍只是凭据/构建产物门禁，不代表模型、ComfyUI、第三方节点、FFmpeg、工作流或运行时的许可证和再分发授权已完成。

### 2026-09-23 许可证台账推进

- [x] 已从最终 Windows 资源目录核对 FFmpeg/ffprobe 的实际资产：`7.1.1-essentials_build-www.gyan.dev`、GPL v3、FFmpeg commit `db69d06eee`，并确认包内包含 `resources/ffmpeg/win32-x64/LICENSE` 与 `README.txt`。
- [x] 已修正发布判断：当前 FFmpeg 二进制是 GPL v3 构建，后续发布资料不得笼统标注为 LGPL；仍需补源码提供方式、编解码器配置和 NOTICE。
- [ ] ComfyUI portable 和三个自定义节点仍需逐 commit 获取许可证/NOTICE 并确认随安装器再分发边界。
- [x] 固定版本许可证已核实：ComfyUI v0.35.0 GPL-3.0；MAINodes commit `f4868b4a08e8a504ce86db54a17961d399ffa2bc` GPL-3.0-or-later；PlagueKind sparse commit `fd26ffb89dee294ca740a59632e5b3423b9a9d2a` MIT；KJNodes commit `d3cfe21625e5170126ce06fbfc1e88108688c3` GPL-3.0。
- [ ] 需保存上述固定 revision 的许可证文本副本和 NOTICE；MAINodes/KJNodes 的 GPL 源码提供及分发边界仍待核对，PlagueKind fork 中继承/引入的代码需追溯来源许可。许可证标签已识别，不代表随包分发已获法律审核通过。
- [ ] H3 INT8、VAE、Qwen3-VL、Turbo/Mystic LoRA 和转换权重仍没有逐文件授权证明；继续采用用户确认后下载或用户自备策略，不将其标记为 OpenH3 Apache-2.0 内容。
- [x] AionCore v0.2.2 的下载 URL/版本已固定，公开上游许可证已定位为 Apache-2.0；当前 bundled 资源目录仍需补齐随包许可证/NOTICE 副本。
- [ ] 7-Zip、Node 运行时及 npm/bun 依赖尚未形成发布版第三方 NOTICE 集合；根目录 Apache-2.0 不覆盖这些组件。

### 2026-09-23 固定版本许可证证据索引

- [x] 已记录固定 revision 的许可证来源：ComfyUI v0.35.0 `https://github.com/Comfy-Org/ComfyUI/blob/v0.35.0/LICENSE`；MAINodes `f4868b4a08e8a504ce86db54a17961d399ffa2bc`；PlagueKind sparse `fd26ffb89dee294ca740a59632e5b3423b9a9d2a`；KJNodes `d3cfe21625e5170126ce06fbfcfe1d88108688c3`。
- [ ] 发布资料仍需保存这些 revision 对应的 LICENSE/NOTICE 原文，并为 GPL 组件准备源码获取方式；当前只有来源索引，不代表发布包已经完成合规资料。
- [x] 发布审计现在将固定组件的许可证资料缺口写入 `.runtime/open-source-release-audit.json` 并单独输出 `License evidence gaps`，与凭据/构建产物 findings 分开统计。
- [x] 已保存四个固定 revision 的 LICENSE 原文到 `resources/third-party-licenses/`，审计报告新增 `licenseEvidencePresent` 列表。
- [ ] GPL 对应源码提供方案、PlagueKind fork 继承代码 NOTICE、7-Zip/Node/npm 依赖清单及 H3 权重逐文件授权仍未完成。

### 2026-09-23 OpenH3 可见品牌迁移第一阶段

- [x] `package.json`、桌面包描述、electron-builder 产品名、Linux 菜单项、托盘提示和内置浏览器用户提示已使用 OpenH3。
- [x] 所有 locale 中的用户可见产品名称已更新为 OpenH3；`generate-i18n-types.js` 和 `check-i18n.js` 已通过。
- [x] 未改动 `appId: com.aionui.app`、`aionui://`、`executableName: AionUi`、`AIONUI_*` 环境变量、旧数据目录和更新仓库，以维持现有安装升级、协议唤起和运行时配置兼容。
- [x] 上游 AionUi 版权/来源说明以及旧身份的内部迁移标识保留，避免把来源归属误写成 OpenH3 或破坏兼容读取。
- [ ] 当前仍需完成组件许可和再分发权利台账；完整身份切换必须另行设计迁移、回滚和旧版本升级测试。
- [ ] 当前 Windows 包仍是未签名体验包，不是正式发布包；PC09/干净机器实机验收、签名和全平台包仍按发布门禁执行。

### 2026-09-23 许可证清单复核

- [x] 根项目继续使用 Apache-2.0，且保留根 `LICENSE` 的 AionUi 上游版权归属；没有把上游版权盲改为 OpenH3。
- [x] 四个私有 workspace package 已补 `license: Apache-2.0`，并增加回归测试；公开仓库尚未确认，因此未伪造 `repository` 字段。
- [x] 运行资产来源已逐项核对：AionCore v0.2.2、ComfyUI portable v0.35.0、MAINodes/PlagueKind/KJNodes 固定 commit、MATLOWAI/GuangyuanSD/Comfy-Org 模型固定 revision 和 SHA256。
- [x] FFmpeg 7.1.1 essentials 的 GPL v3、源码 commit `db69d06eee`、构建配置、LICENSE/README 已随 Windows 资源保留。
- [x] FastH3 Preview 当前只有 model repo/revision，未记录 license metadata；内嵌 workflow 也只有模板来源线索，不能据此宣称可公开再分发。
- [ ] 许可证/NOTICE 和再分发授权台账仍未完成，缺口包括 ComfyUI/三个节点/H3 权重及衍生 LoRA/工作流/7zr/AionCore/Node/字体图标和逐包 npm/bun 依赖。
- [ ] 当前许可结论只能支持“固定来源、按需下载并校验”的 Alpha 策略，不能支持将模型和运行时并入 OpenH3 Apache-2.0 基础包。

### 2026-09-23 Windows Alpha 包最终复验

- [x] `packages/desktop/electron-builder.yml` 已把 `resources/third-party-licenses` 纳入 `extraResources`；避免许可证只存在源码目录而不进入安装包。
- [x] 发布配置回归为 12 passed、1 skipped；TypeScript 检查通过。
- [x] 标准 `npm run build-win:x64` 构建通过；主程序 `AionUi.exe` 的 ProductName 和 FileDescription 均为 OpenH3，旧可执行文件名仅作为升级兼容标识保留。
- [x] 最终包：`out/OpenH3-2.2.2-win-x64.exe`，237,863,449 bytes，SHA256 `D2027732E9F2FAB2C67F55021DAD636B720526DA20236260F3713328590DC290`。
- [x] 包内存在 `app.asar`、OpenH3 图标、AionCore/Node、FFmpeg/ffprobe、FFmpeg GPL LICENSE/README、ComfyUI v0.35.0/三个节点许可证原文和 `NOTICE.OpenH3.txt`；未包含 Provider bootstrap。
- [x] 发布审计最新结果：Source findings 0、Artifact findings 0、License files 16、License evidence gaps 6。
- [ ] 当前包的安装器和主程序均为 `NotSigned`；没有证书时只能作为未签名 Alpha 体验包，不能宣称已解决 Windows 安全软件拦截。
- [ ] 未完成项保持不变：PC09/干净机器实机验收、H3 三模式和失败恢复、GPL 对应源码提供、7-Zip/Node/npm/bun NOTICE、H3 权重及衍生文件授权、macOS ICNS、身份兼容迁移。

### 2026-09-23 个人/团队名义 Alpha 发布准备

- [x] 暂不绑定公司主体、组织仓库、商标或域名；当前只准备技术预览版发布资料。
- [x] Windows 安装包会随包携带已核对的 ComfyUI/节点许可证原文；模型权重、衍生 LoRA 和 Provider Key 不写入源码或基础安装包。
- [x] 已新增 `resources/third-party-licenses/NOTICE.OpenH3.txt`，列出固定运行时、节点、FFmpeg、AionCore 和模型/工作流的发布边界；它是技术清单，不是未取得权利的授权声明。
- [x] 首次启动继续采用按需下载、固定哈希校验和用户确认条款；对话 Provider 由用户自行配置。
- [ ] 仍需在发布页面明确 Alpha、未签名、支持范围、已知限制和反馈入口；未完成前不要称为正式稳定版。
- [ ] 仍需补 GPL 对应源码提供方式、7-Zip/Node/npm/bun NOTICE 和 H3 权重逐文件授权；这些不因暂不绑定公司身份而消失。
- [x] 已整理 README Alpha 入口、`NOTICE.OpenH3.txt` 和 `SOURCE-OFFER.md`；当前只完成本地推送前检查，未向远端推送。
- [ ] 当前 Git remote 仍指向上游 AionUi 仓库；确认新的 OpenH3 GitHub 仓库地址后再配置 remote 和执行 push。

### 2026-09-24 H3 聊天状态展示收口

- [x] 移除“超过 1 分钟未收到新进度，暂时无法判断是否卡住”和取消行为长提示；长节点计算只保留当前任务状态和耗时。
- [x] 连续 `aionui_h3_job_status` 调用在工具步骤摘要中合并为单条视频任务记录，并显示更新次数；内部兼容 ID 不再作为用户可见节点名称。
- [x] 保留任务卡中的最新节点进度、生成耗时、取消生成和最终视频结果；新增 DOM 回归测试覆盖重复状态折叠与旧名称隐藏。

### 2026-09-24 Windows Alpha 包刷新

- [x] 已重新构建 `out/OpenH3-2.2.2-win-x64.exe`，306,612,247 bytes，SHA256=`C4145E75C20075DCAA43F60CE9420BD92386E7F3690E3EE8D8648D1721D11152`。
- [x] 安装包内 `resources/app.asar`、`resources/app.png` 和 `resources/third-party-licenses/NOTICE.OpenH3.txt` 均存在；`open-source-release-audit.js` 结果为 Source findings 0、Artifact findings 0。
- [x] 本包包含 H3 聊天状态展示修复和对应 DOM 测试；重复状态调用折叠，用户界面不再显示内部 `aionui_*` 节点名或过时卡住提示。
- [ ] 仍为未签名 Alpha 体验包，不是正式发布包；许可证证据缺口 6 项、GPL 源码提供、H3/LoRA/工作流逐文件授权、干净机器验收和 Windows 签名仍需单独闭环。

### 2026-09-24 GitHub 仓库公开前清理

- [x] 已新增 `openh3` remote 指向 `https://github.com/pigq/OpenH3.git`，原 `origin` 上游地址保留；整理后的版本已推送到 OpenH3 `main`。
- [x] 已把根 README 改为 OpenH3 Alpha 项目说明，公开入口不再指向上游下载、发行版或社区活动；保留必要的 AionUi 来源归属。
- [x] 已将 `.runtime/` 和临时审计运行目录加入 `.gitignore`，避免本机缓存、模型状态和审计 JSON 进入公开提交。
- [x] 首次公开提交已完成逐项审查，未使用未经筛选的 `git add .`。
- [x] 首次提交审查已发现本地 FFmpeg 可执行文件约 174 MB，已加入 `.gitignore`；许可证和 README 会进入源码仓库，二进制应作为单独构建/发布资源处理，避免误提交大文件。
- [x] 新仓库的 `LICENSE` 和本地源码历史已合并，未强制覆盖远端。

### 2026-09-24 公共仓库内容清理

- [x] 删除不参与 OpenH3 运行和构建的上游协作目录 `.aionui/`、`.gemini/` 和 `.claude/`。
- [x] 删除未再被 OpenH3 README 引用、且仍包含旧 AionUi 营销内容的旧多语言 README；保留整理后的中文入口。
- [x] 保留 `tests/`、源码、构建脚本和许可证文件；测试目录是开源复现验证所需内容。

### 2026-09-24 上游协作元数据清理

- [x] 删除上游专用 `CLAUDE.md` 及 `.claude/skills/`，项目规范统一放在 `AGENTS.md`、`CONTRIBUTING.md` 和 `docs/contributing/`。
- [x] 将旧版 AionUi 变更记录替换为 OpenH3 专属 `CHANGELOG.md`，保留 Alpha 阶段和发布说明入口。
- [x] `.gitignore` 忽略本地 `.claude/`、`.codex/` 和 `.gemini/` 配置，避免个人 AI 工具文件再次进入仓库。

### 2026-09-24 README 产品定位更新

- [x] 根 README 改为面向新用户的产品首页，明确 OpenH3 是开箱即用的本地视频 Agent 工作台。
- [x] 产品定位改为“让视频创作像软件开发一样可对话、可执行、可追踪”，不使用竞品名称作宣传文案。
- [x] README 补充核心能力、首次使用步骤、源码运行方式、目录结构和 Alpha 发布边界。
- [x] 根目录提供中文 `readme.md` 和英文 `README.en.md`，两个入口互相链接。
- [x] README 已加入真实的参考图、应用内结果预览和压缩演示 GIF；原始 MP4 不进入源码仓库，避免引入不必要的大文件。

### 2026-09-29 发布门禁分类纠正（取代此前笼统的五项阻断表述）

- 已完成：中英文 README、演示入口、社区规范与 GitHub 模板治理已在 d6d8b71d 推送；此前 09-28 状态说明仅更新了仓库外副本，本次补入仓库内状态记录。
- 已通过自动化验证（09-28）：发布配置测试 12 passed、1 skipped，TypeScript、i18n、工作流 YAML 解析通过；审计 Source findings 0、Artifact findings 0、License evidence gaps 6。此处是历史结果，不代表本轮重新构建安装包。
- 公开源码：签名及 PC09 验收不是前提；仍需确保所发布源码及历史不含密钥、无权公开的文件，并保留适用许可证和来源说明。
- 分发安装包：按实际随包组件落实许可证和 NOTICE；随包 GPL 二进制必须匹配对应源码提供方式，Alpha 标签不免除此义务。仅用于构建、未随包分发的 npm/bun 工具不一律要求进入安装包 NOTICE。
- 模型和工作流：逐文件再分发审查适用于实际分发的权重、LoRA、转换文件和内嵌工作流；不随包、不托管的用户自备模型不要求项目另行取得再分发许可。自动下载入口仍需核对适用条款。
- 实机质量：已有本机可用记录不作废；开发环境外的安装、首次启动和代表性任务尚需验证。无需指定 PC09，Dense/SLA 对比只支撑加速性能/质量承诺，不作为源码公开的通用阻断。
- 尚未签名：签名是发行信任改进项，可后置；产品成熟度与签名状态独立。当前保留 Alpha 是因为稳定性证据仍有限，不是因为未签名。未签名版本可在实际分发许可义务满足后发布，并明确标注状态。

### 2026-10-10 Cloudflare Responses 网关接入

- [x] 新增 `services/openh3-gateway` Cloudflare Worker，公开 `/v1/responses`、`/v1/models` 和 `/health`，不暴露上游 API Key。
- [x] Worker 固定允许模型 `gpt-6-astra` 与 reasoning `low`，拒绝非对象 JSON 和超过 1 MiB 的请求；Chat Completions 不开放。
- [x] 桌面端默认 Provider 改为 Responses API，客户端 API Key 为空；仅在构建时注入已部署的 `OPENH3_GATEWAY_URL`。
- [x] Worker 与 Provider 回归测试通过（8 passed）；发布配置回归为 20 passed、1 skipped，TypeScript、i18n、Electron Vite 构建均通过；开源审计 Source findings 0、Artifact findings 0。
- [x] Worker 已部署为 `https://openh3-gateway.qingh120.workers.dev`；`/health`、`/v1/models` 和一次 Responses 请求实测通过，Cloudflare Secret 列表确认仅保存 `UPSTREAM_API_KEY`。
- [x] 已用真实 Worker URL 构建 Windows x64 未签名体验包：`out/OpenH3-2.2.2-win-x64.exe`，309,146,008 bytes，SHA256=`59FE03D68473A224A4FC455421EB3BF9AE606BDF843A1C238217F29FF8E8F5AF`。
- [x] 包外资源检查通过：`app.asar`、OpenH3 `app.png`、`NOTICE.OpenH3.txt`、FFmpeg/ffprobe 均存在；构建产物未发现 Provider Key。
- 当前按用户选择暂不增加 Cloudflare 速率/额度策略，不将其列为本轮阻断；实际安装验收状态单独记录，当前体验包尚未签名。

### 2026-10-10 H3 安装异常与 ComfyUI 停滞处理（早期实现记录）

- [x] H3 安装状态文件损坏或阶段字段异常时降级为可重试的失败状态，媒体服务不会因启动时 JSON 解析异常退出。
- [x] 安装 worker 的 `error`/`exit` 只结算一次，避免下载、校验或解压异常触发重复完成/失败路径。
- [x] ComfyUI 任务增加无历史/事件变化的停滞超时（默认 10 分钟），超过后以 `H3_COMFY_STALLED` 失败并释放运行锁；总超时仍保留。
- [x] 节点内部进度不再冒充整体任务百分比，避免 Agent/界面误判进度并反复查询；当前节点进度继续通过 `activity.value/max` 展示。
- [x] runtime 测试通过：27 个测试文件、156 个测试（含新增停滞和损坏状态覆盖）；TypeScript 与 i18n 检查通过。

### 2026-10-10 H3 全局运行时心跳 watchdog（早期实现，已由下方完整闭环替代）

- [x] 任务等待期间每 30 秒探测 ComfyUI `/system_stats` 与 `/queue`，成功心跳只更新监控状态，不刷新执行活动时间；界面可区分运行时在线与任务实际进展。
- [x] 心跳只证明 ComfyUI 进程可达，不会掩盖执行停滞；任务执行事件/历史仍单独记录，无执行变化先标记疑似停滞；队列/历史核对和总时限负责最终收口。
- [x] 连续 3 次运行时探测失败返回 `H3_COMFY_HEARTBEAT_LOST`；远端未确认时保留任务栅栏，不释放给替代 GPU 任务。
- [x] watchdog 回归测试通过：runtime 27 个测试文件、157 个测试，TypeScript 通过。

### 2026-10-10 ComfyUI 任务闭环与远端状态栅栏

- [x] 任务监控改为“历史结果优先 + 指定 prompt 队列核对 + 有界心跳”：进程可达不再冒充任务进展；重复事件不会刷新执行时间；长节点保留总时限。
- [x] 取消接口增加远端确认：`cancelled: true` 只表示取消指令已发出；目标仍在运行/排队时保持阻塞，不会开始下一次 GPU 生成。
- [x] 提交过程先持久化 prompt 预留 ID；提交回执异常、断联、重启均保留 `remoteUncertain` 栅栏，避免重复提交；后台每 30 秒只做一次有界核对，绝不自动重试生成。
- [x] 任务快照增加 `stopPolling: true`、`nextAction`、`automaticRetryAllowed: false`；MCP 明确要求 Agent 提交后结束当前回合，由界面 SSE/定时刷新展示结果。
- [x] 取消与完成竞态保留已完成视频；任务不存在返回 HTTP 404；SSE 终态正确关闭；释放显存前核对无活动任务。
- [x] H3 安装状态 `null`/数组/数字和落盘失败均降级为可重试状态；安装回调异常只结算一次。
- [x] 补充 runtime/UI 回归和媒体服务真实 HTTP 集成覆盖；最终相关测试集合 `37 files, 245 passed, 1 skipped`，TypeScript、i18n、Oxlint（0 errors）通过。
- [x] Windows 安装包已在后续构建复验中重新生成；本轮以文末“对话输入框视频导入图标优化与安装包刷新”记录的包路径、大小和 SHA256 为准。
- [ ] 仍需在真实 ComfyUI GPU 上验证：长采样无事件、运行时重启、取消后队列清空、断联恢复和多显存配置；这些不由单元/HTTP 集成测试替代。

本轮监控默认值：队列心跳 30 秒、连续失败 3 次、执行静默 10 分钟仅标记疑似停滞、总时限 30 分钟（保留 `AIONUI_H3_MAX_WAIT_MS` 配置），队列消失且历史为空需 60 秒宽限。取消确认最多 4 次、整体请求限时 30 秒。WebSocket 丢失后使用 HTTP 核对原 prompt，不重新提交。

边界：`stopPolling` 是 MCP 的明确协作契约，并非对任意第三方 Agent 推理循环的强制中断。内置 UI 在终态停止 SSE/轮询。提交回执丢失且服务从未确认过该 prompt 时，空队列不能证明迟到提交不会生效，系统保留阻塞而不强制解锁；需要核实运行时任务后处理。没有对用户反馈的每一种“闪退”宣称已定位根因，当前只修复并测试了已复现的状态文件和 worker 回调异常路径。

### 2026-10-10 H3 完整闭环构建验证

- [x] 使用缓存 Electron 37.10.3 和重新下载的 AionCore v0.2.2 完成 Windows x64 未签名包：`out/OpenH3-2.2.2-win-x64.exe`，309,229,248 bytes，SHA256=`A215D857CAEDF1B4B5A8553722CA1F6D6149CD7F1DCF06F77A675B75022FC43C`。
- [x] 包内资源：`resources/app.asar`、OpenH3 `resources/app.png`、`NOTICE.OpenH3.txt`、FFmpeg/ffprobe、AionCore 与媒体服务均存在；app.asar 中 147 个文本文件扫描无 Provider Key、开发机路径或私有地址。
- [x] 包内媒体服务确认包含 `H3_REMOTE_STATE_UNCONFIRMED`、`confirmStopped`；MCP bundle 确认包含 `stopPolling`；Cloudflare 网关 URL 出现在 Provider chunk；无 `video-provider-bootstrap.json`。
- [x] `open-source-release-audit.js`：Source findings 0、Artifact findings 0；许可证证据缺口仍为 6 项，属于正式合规材料，不因 Alpha 包自动消失。
- [ ] `Get-AuthenticodeSignature` 状态为未签名；本包只能称 Windows x64 Alpha 未签名体验包。

### 2026-10-10 对话输入框视频导入图标优化与安装包刷新

- [x] 视频导入按钮改用与 SendBox 一致的 IconPark outline 单色图标，固定 32px 圆形点击区域和 16px 图标尺寸；上传中、取消、hover、focus 和 disabled 状态统一处理。
- [x] 视频导入 DOM 回归测试补充按钮和取消状态断言；相关测试 2 passed，TypeScript、i18n、Oxfmt 和 Oxlint（0 errors）通过。
- [x] 重新构建 Windows x64 未签名 Alpha 体验包：`out/OpenH3-2.2.2-win-x64.exe`（309,144,751 bytes，SHA256=`0A758938B56ED8F7FF496815A480E905C9A561E0EDF700DC3F6378606A80037D`）。
- [x] afterPack 验证 `resources/app.asar`、OpenH3 `app.png`、FFmpeg/ffprobe、第三方许可证资源和 x64 native module；开源发布审计 Source findings 0、Artifact findings 0。
- [ ] 安装包仍未签名，只能称为 Windows x64 Alpha 未签名体验包；干净机器安装/首启和真实 GPU 任务验收仍需单独执行。
