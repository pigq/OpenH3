# OpenH3 OSS 更新分发设计

日期：2026-11-02

状态：待用户审阅

## 背景

OpenH3 v3.0.7 的桌面更新器将 GitHub Releases 配置为更新源。当前自动更新、手动版本查询和备用安装包下载均依赖 GitHub 端点；部分中国大陆网络无法稳定访问这些端点。仓库已有发布后分发工作流，将 Release 资产镜像到 S3，但它没有改变桌面客户端的更新源，且下载清单必须与实际安装包和 blockmap 配套。

仓库中还已有 `CdnGenericProvider`，可作为静态更新源的基础；该 Provider 尚未接入生产更新流程。

## 目标

- 让中国大陆客户端优先从阿里云 OSS 查询并下载稳定版更新。
- 保留 GitHub Releases 作为备用来源和公开版本页。
- 让自动更新、手动检查、安装包回退使用一致的版本信息和下载地址。
- 发布时校验清单、安装包、SHA-512 和可选 blockmap，避免客户端看到不完整版本。
- 发布客户端中不包含任何 OSS 或短信 AccessKey。
- 首个迁移版本正常通过现有 GitHub 更新链路到达 v3.0.7 用户；只有无法访问 GitHub 的少数用户需要手动安装。

## 方案

采用双源静态分发：OSS 是客户端首选更新源，GitHub Releases 是备用源。更新器按“OSS 检查/下载，失败后 GitHub 检查/下载”的顺序尝试；用户所在网络能访问哪一端，就使用哪一端。回退状态绑定到本次检查和下载，不能把 OSS 清单与 GitHub 同名文件或不同版本的安装包混用。两个来源都失败时保留现有错误提示、重试入口和 GitHub Release 页面链接。

复用现有 Electron updater 和版本校验机制。为静态源接入现有 `CdnGenericProvider` 或等价的统一 Feed Provider。当前 Provider 会把清单里的更新文件路径解析到版本目录。若所用 OSS 域名不能可靠支持 electron-updater 的多 Range 差分下载，应关闭多 Range 请求，让更新器下载完整安装包；完整包仍须按清单 SHA-512 校验。阿里云 OSS 的普通单 Range 请求可用于大对象分段传输。

手动检查所需的说明、发布时间和平台安装包信息从同一发布版本生成的公开索引读取，并带上 OSS 主下载地址、GitHub 备用地址以及 GitHub Release 页面地址。下载 IPC 对两个源实施 HTTPS 主机白名单校验，每次重定向都重新校验；OSS 文件只允许落在固定更新前缀下，禁止任意 URL 下载。

## OSS 对象布局

首期使用现有 Bucket `bohuauhd` 的深圳外网 Endpoint，不需要把 AccessKey 放入客户端。更新对象放在独立前缀：

```text
updates/stable/latest.yml
updates/stable/latest-mac.yml
updates/stable/latest-arm64-mac.yml
updates/stable/latest-linux.yml
updates/stable/latest-linux-arm64.yml
updates/stable/latest-win-arm64.yml
updates/stable/releases.json
updates/stable/<version>/<installer>
updates/stable/<version>/<installer>.blockmap
```

示例基础 URL：`https://bohuauhd.oss-cn-shenzhen.aliyuncs.com/updates/stable/`。平台清单使用 electron-builder 生成的正式元数据，不手工改写其中的版本、路径或 SHA-512。版本目录不可变；禁止用新内容覆盖已发布版本的对象。`latest*.yml` 和 `releases.json` 是可更新的索引对象。

匿名读取权限仅授予 `updates/*` 对象；上传身份只获得该前缀所需的写入权限。若 Bucket 策略无法将匿名读取安全限定到此对象前缀，则先新建独立更新 Bucket，而不扩大当前 Bucket 的公开权限。

## 发布流程

1. 正式 Release 发布后，由 CI 获取相同 tag 对应的安装包、所有平台 `latest*.yml` 和相关 `.blockmap`；不通过重新构建生成 OSS 专用二进制。
2. 校验平台清单版本与 tag 一致、清单引用对象存在、安装包大小和 SHA-512 一致、架构文件齐全。发布说明和手动安装索引从同一 Release 生成。
3. 先将安装包、blockmap 和版本索引上传到不可变版本目录；执行 OSS HEAD/GET 验证并确认 SHA-512。
4. 校验成功后，最后更新根目录的 `latest*.yml` 和 `releases.json`。单对象写入具备原子可见性；索引设置短缓存，版本对象设置长缓存。
5. GitHub Release 保持现有发布方式与完整资产。OSS 失败必须在工作流中显式报错并告警，不能把未完成镜像报告为成功。

仓库现有 `release-distribute.yml` 可扩展为 OSS 并行分发目标。改造时应一并核对其 S3 文件选择：electron-updater 所需的 blockmap 不能在镜像阶段遗漏。若保留 S3，发布产物仍来自同一经过校验的 `dist`，各目标可独立报告结果。

## 客户端行为

- 启动约 30 秒后及后续每 6 小时，先检查 OSS 稳定版清单；OSS 请求或清单解析失败时再尝试 GitHub。
- 发现新版后，从成功返回该版本清单的同一来源下载。下载失败可尝试另一来源，但必须重新确认备用清单中的版本和文件 SHA-512。
- 自动下载、空闲后安装、用户数据保留策略沿用当前 v3.0.7 行为。
- “设置 → 关于 → 检查更新”、更新说明和手动下载安装包采用同一个 OSS 优先版本索引，并为手动下载提供 GitHub 备用链接。
- 旧版本与新源都失败时，保留错误详情和手动前往 Release 页的入口。

## 迁移策略

下一稳定版本（按当前版本序列预计为 v3.0.8）是源切换过渡版：

- 先按现有流程在 GitHub 发布过渡版，使 v3.0.7 的更新器能发现它。
- 同一版本的安装包与更新元数据同时分发到 OSS。
- 过渡版运行后将 OSS 设为首选，GitHub 作为回退；后续版本都按双源流程发布。
- 因用户量少，不为迁移单独制作版本或开展普遍手工迁移；只有访问不到 GitHub 且未升级的用户需要从 OSS 手动下载并安装一次。

v3.0.7 无法仅通过上传 OSS 文件切换更新源，因为已发布程序的 Feed 配置固定指向 GitHub。该版本的手动更新元数据也直接请求 GitHub API。因此不承诺对离线于 GitHub 的 v3.0.7 客户端进行无版本升级的远程改源。

## 凭证与网络安全

刚才对话中出现的 OSS/SMS AccessKey 应视为已暴露：立即轮换，检查调用记录和异常费用，并按实际用途拆分身份。发布工作流应使用专用 RAM 身份，通过 GitHub Actions OIDC/阿里云 RAM 角色获取短期凭证；如果环境无法使用 OIDC，则把专用 RAM AccessKey 保存在 CI Secret，仅授予 `updates/*` 写入权限并定期轮换。桌面安装包、公开仓库和发布资产均不得包含任何云凭证。

匿名客户端只读公开更新对象，不持有签名 URL 或云凭证。若流量或跨地域成本后续需要 CDN，再配置备案域名和私有 OSS 回源；客户端更新源通过配置常量迁到域名，保持 OSS 目录结构不变。

## 验收

- v3.0.7 在能访问 GitHub 的测试机可自动升级到过渡版；过渡版随后可从 OSS 查询下一版本。
- 通过阻断 GitHub 的网络测试，过渡版仍可从 OSS 完成检查、完整下载、SHA-512 校验和安装。
- 通过阻断 OSS 的测试，客户端能从 GitHub 检查并下载同一版本；切换源过程中不能出现版本/哈希交叉。
- 手动检查显示正确版本、发布说明和架构对应的安装文件；无对应平台安装包时给出可理解的回退入口。
- 清单缓存短于版本对象缓存；版本对象不能被同版本不同内容覆盖。
- Windows 至少完成干净安装升级和已有用户配置升级；对支持的平台补齐 macOS/Linux 更新源检查及文件校验测试。
- CI 日志不输出密钥；OSS 匿名读取仅覆盖更新前缀；上传身份不能修改更新前缀之外的对象。

## 参考

- [electron-builder 自动更新](https://www.electron.build/docs/features/auto-update/)
- [electron-builder Generic 更新服务器选项](https://www.electron.build/docs/api/builder-util-runtime.interface.genericserveroptions/)
- [阿里云 OSS CDN 加速与大文件 Range 回源](https://www.alibabacloud.com/help/en/oss/user-guide/cdn-acceleration)
- [阿里云 AccessKey 泄露响应](https://www.alibabacloud.com/help/en/ram/user-guide/solution-to-accesskey-leakage)
