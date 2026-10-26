# OpenH3 命名与升级兼容

产品显示、内部工程命名和持久化标识采用不同的迁移方式。代码搜索仍会命中旧名称；这些命中不能全部机械替换。

## 产品名称与兼容边界

OpenH3 是产品展示名称。新的安装包、窗口标题、应用身份、后端二进制、资源目录、更新仓库和 CLI 帮助使用 OpenH3 名称；持久化标识、已有协议和真实上游来源不做机械替换。

兼容范围包括 `AIONUI_*` 环境变量、`aionui://` 深链、`aionui-session` Cookie、`x-aionui-*` 请求头，以及 `AIONCORE_LISTENING` / `AIONCORE_READY` 启动握手。`aionui.db`、`.aionui`、旧用户目录、`aionui.dir`、`aion-extension.json` 和内置 Skill/MCP 历史 ID 可能仍被已有数据、扩展或脚本引用。

新配置优先使用 OpenH3 标识；读取旧数据时保留回退，在兼容旧客户端所需的位置保留双写。删除旧标识前必须提供迁移、回滚方案和旧版本数据的集成测试。上游依赖、版权声明和来源链接中的原名称保持真实，不改写为 OpenH3 自有来源。

## 本次统一的命名

| 范围                                  | 新名称                                                                           | 旧版本的兼容方式                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
| Rust 工作区 crate、源码导入和测试命令 | `openh3-*`、`openh3_*`                                                           | 保留数据库 schema 和序列化格式；crate 改名不参与用户数据解码                              |
| 后端可执行文件、打包资源目录          | `openh3-core`、`bundled-openh3-core`                                             | 启动器继续接受旧二进制和资源目录                                                          |
| 构建、版本解析脚本                    | `prepareOpenH3Core.js`、`resolveOpenH3CoreVersion.js`                            | 旧脚本路径作为薄包装继续导入新实现                                                        |
| React 基础组件                        | `OpenH3Modal`、`OpenH3Select` 等                                                 | 统一导出入口保留旧组件、类型别名；已有主题使用的 CSS 类继续有效                           |
| 本地配置和聊天文件                    | `openh3-config.txt`、`openh3-chat.txt`、`openh3-chat-message.txt`、`.openh3-env` | 在首次读取时迁移，保留旧文件；新文件已存在则以新文件为准；复制失败时读取旧文件            |
| 分会话历史目录                        | `openh3-chat-history`                                                            | 按会话迁移旧目录中的文件；两个目录同时存在也能读取旧会话                                  |
| 内置管家目录、规则、头像与新安装 ID   | `openh3-assistant`                                                               | 旧安装复用原有 definition ID 和 assistant ID，两个名称均可查询规则、头像和设置            |
| 媒体和 ComfyUI MCP 工具               | `openh3_*`                                                                       | 新提示词和内置 skill 使用新名称；旧工具名称绑定相同 handler，已有会话的待执行调用仍能继续 |
| 产品自有显示名称与图标                | `OpenH3`、`OpenH3 Core`、OpenH3 图标                                             | 新数据库迁移只刷新内部 agent 的显示名称和图标；不改 runtime discriminant                  |
| 环境变量、浏览器本地偏好              | `OPENH3_*`、OpenH3 前缀的偏好键                                                  | 相应入口保留旧变量和旧键回退，新值优先                                                    |

## 数据兼容约束

历史 SQL migration 的内容必须保持原样，包括其中的旧名称和注释。SQLx 会校验已应用 migration 的 checksum，改注释同样会导致旧数据库升级失败。检查脚本同时检查新旧 crate 目录，允许内容不变的目录重命名，并拒绝重命名后修改历史 SQL。

新增 migration 045 只更新产品自有内部 agent 的名称和图标。它不改写助手主键、用户自建助手、overlay、偏好、会话快照、定时任务 JSON 或用户提示词。管家 bootstrap 使用原有 definition ID；用户选择的模型、技能、启用状态、顺序和最近使用时间继续引用同一条记录。

文件存储的编码格式仍为 `base64(encodeURIComponent(JSON))`。路径在旧目录复制完成后才解析，避免先确定一个不存在的新路径、随后漏读旧数据。已有规范文件优先，迁移可重复执行，旧原件保留为升级前备份。备份不会自动与之后的新文件写入同步。

本次验证针对旧版本数据向新版本升级。升级后的数据库包含新的 migration 版本；不保证旧程序能够直接打开已经升级的数据库，也没有在用户的真实数据库上执行试迁移。

## 必须保留的旧名称

| 保留位置                                              | 原因                                                                     |
| ----------------------------------------------------- | ------------------------------------------------------------------------ |
| `aionrs` runtime 值、会话类型和相应适配代码           | 数据库和 wire contract；直接替换会让旧会话无法反序列化或选择正确 runtime |
| 外部 `aion-*` Rust 依赖与其 Git URL                   | 属于上游库实际名称，改字符串不会产生对应的新依赖                         |
| 历史数据库文件名、旧目录、旧助手/技能标识             | 新版本读取旧数据及执行旧调用时需要                                       |
| cookie、header、深链接、进程握手标记及旧 MCP 工具别名 | 现有客户端、已登录会话、旧后端和待执行工具调用的兼容契约                 |
| CSS 旧类名、旧组件导出、旧脚本入口                    | 用户自定义主题、扩展或已有构建脚本可能引用它们                           |
| Windows 安装器内部宏和旧卸载器兼容逻辑                | 旧安装器升级、卸载及诊断工具仍需要解析这些标识                           |
| 版权头、LICENSE、第三方声明、上游仓库链接和历史记录   | 保留真实来源和历史事实；产品页面的显示文字单独处理                       |

这些例外的存在不表示新功能应继续使用旧品牌命名。新增产品代码、提示词、组件、脚本和测试命令应使用 OpenH3 名称；新增兼容别名应注明用途。

## 回归验证入口

- Desktop：`tests/unit/bootstrap/storageIdentityMigration.test.ts` 覆盖自定义缓存路径、旧临时目录、文件优先级、迁移失败回退、重复启动和混合历史目录。
- Backend：[`identity_compatibility.rs`](../../core/crates/openh3-db/tests/identity_compatibility.rs) 从 migration 044 的数据库升级，逐列比较助手、overlay、偏好、会话、快照及定时任务，检查外键和重复执行。
- Assistant：`openh3_butler_upgrade_preserves_identity_settings_rules_and_avatar` 检查改名后的 bootstrap、两个名称的查询、规则及头像。
- MCP：媒体工具测试同时检查新旧名称的 schema 与 handler 相同；旧调用测试和新工具结果显示测试同时保留。
- 数据库历史：[`check-immutability.test.ps1`](../../core/scripts/migration/check-immutability.test.ps1) 覆盖纯目录改名可通过、改名后修改历史 SQL 仍会失败。
