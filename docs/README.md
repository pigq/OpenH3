# OpenH3 文档 / Documentation

按你要完成的任务选择入口。产品概览见[中文首页](../README.md)或 [English](readme/README.en.md)。

| 我想…… / Goal                           | 入口 / Start here                                                                                                                                               |
| --------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 安装并开始使用 / Get started            | [首次运行](getting-started/README.md)、[系统要求](getting-started/system-requirements.md)                                                                       |
| 了解支持范围 / Check capabilities       | [产品范围](getting-started/product-scope.md)、[演示](showcase/README.md)                                                                                        |
| 配置与排错 / Configure and troubleshoot | [操作指南](guides/README.md)、[支持](../.github/SUPPORT.md)                                                                                                     |
| 运行源码 / Develop                      | [开发环境](contributing/development.md)、[贡献指南](../CONTRIBUTING.md)                                                                                         |
| 理解实现 / Understand the code          | [架构](architecture/overview.md)、[命名与兼容](architecture/product-identity-compatibility.zh-CN.md)、[模块](../packages/README.md)、[测试](../tests/README.md) |
| 了解计划与发布 / Follow the project     | [路线图](contributing/roadmap.md)、[发布流程](contributing/releases.md)、[变更记录](../CHANGELOG.md)                                                            |

## 维护规则 / Maintaining docs

- 功能文档使用英文小写 `kebab-case.md`；语言后缀使用 `.zh-CN.md` 或 `.en.md`。
- `README.md` 是目录入口；`CONTRIBUTING.md`、`LICENSE` 等平台约定文件保留标准名称。
- 用户指南放 `getting-started/` 或 `guides/`；贡献与发布说明放 `contributing/`；架构放 `architecture/`。
- 公开文档只保留当前产品的使用说明、维护指南与实际架构。上游 PRD、功能设想、空占位页和实现讨论保留在 Git 历史，不继续维护平行规格库。
- 私人商业草案、聊天转录、临时验收日志和生成报告留在本地忽略目录，不新增到公开文档树。
- 修改文件位置时同时修正引用。产品范围已归入 `getting-started/`，路线图与发布说明归入 `contributing/`，不再维护平行的 `openh3/` 文档树。
