---
name: x-recruiter
description: 用于在 X (x.com) 发布招聘帖子。包含文案规范、图片生成提示和自动化发布脚本。发布 AI 相关岗位或设计类岗位时优先使用。
---

> **⚠️ Platform note — read before running any command.** The command examples here are written for **macOS / Linux**. On **Windows**: run `python` (or `py`) instead of `python3`, use `$env:USERPROFILE\…` and backslashes instead of `~/…`, and translate any shell pipes/redirects (`|`, `>`, `&&`) to their PowerShell equivalents before running. The scripts themselves are cross-platform; only the way you invoke them differs.

# X Recruiter (X 招聘助手)

本技能用于快速在 X 发布招聘信息，包含文案规则、封面/详情图提示与自动化发布脚本。

## 核心工作流

### 1. 信息收集

先复用用户已提供的信息，仅补问缺失或冲突且影响结果的内容；用户已明确的信息不重复确认：

- **岗位名称**
- **核心职责 & 要求**
- **投递邮箱/链接**

### 2. 生成视觉素材

`scripts/generate_images.js` 只生成 `image_instructions.txt` 提示，不生成图片。按这些提示使用当前已授权的生图、绘图或文档渲染工具制作素材；缺少某个专用工具时检查等价可用工具，不重复调用未知接口。

- **操作**：
  ```bash
  node scripts/generate_images.js
  ```
- **脚本产出**：`image_instructions.txt`。完整素材步骤需另行产出 `cover.png`、`jd_details.png`，检查文件存在、可解码且内容正确后再使用。没有可用制作工具时，保留已完成文案并说明具体缺项，不宣称图片已生成。

### 3. 生成文案

生成符合 X 调性的文案，控制在 280 字符内。

- **规则**：参考 `assets/rules.md`。
- **要求**：简洁、清晰、带核心职责与投递方式。

### 4. 自动化发布

只有用户明确要求发布时才运行 `scripts/publish_x.py`：脚本会自动点击 Post，不提供审核暂停模式。仅要求草稿、预览或保留审核时，先交付文案和素材，不运行该脚本。发布前检查脚本/依赖是否可运行；脚本不可用时可以使用已获准的浏览器工具完成同一已授权流程，不把工具故障等同于需要再次授权发布。

**前置要求**：

- 安装 Playwright: `pip install playwright`
- 安装浏览器驱动: `playwright install chromium`

**执行命令**：

```bash
python3 scripts/publish_x.py "post_content.txt" "cover.png" "jd_details.png"
```

**交互流程（更清晰的步骤说明）**：

1. 观察浏览器窗口：脚本已打开 X 首页或发帖页。
2. 若出现登录页，请完成登录。
3. 登录完成后，脚本会自动填充文案与图片。
4. 脚本自动点击 Post；核对真实发布结果并提供帖子链接。进程退出或点击成功不代表发布成功，状态不明时先检查已有帖子，不重复提交。已明确授权发布时不另加聊天确认，登录交互仍由用户完成。

## 资源文件

- **assets/rules.md**: 文案规则与限制。
- **assets/design_philosophy.md**: 视觉风格指南。
- **scripts/generate_images.js**: 图片提示文件生成脚本。
- **scripts/publish_x.py**: 发布自动化脚本。
