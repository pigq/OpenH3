---
name: apiyi-image-generation
description: 当用户要求通过 APIYi 或 gpt-image-2.5-all 生成图片、修改图片、使用参考图或蒙版编辑，以及配置此 Skill 的生图 URL、Key、模型时使用。适用于 OpenH3；不用于视频生成或修改对话模型。
---

# APIYi 图片生成 · OpenH3

本 Skill 改编自用户提供的 api2img，保留其 Images API 调用方式。默认地址为 `https://api.apiyi.com/v1`，默认模型为 `gpt-image-2.5-all`。这是可执行脚本型 Skill，不是 MCP 工具。

## 执行入口

定位**当前加载的本 Skill 目录**，记为 `<skill-dir>`。保留整个目录（包括 `bin` 和 `core`），不要只复制 SKILL.md。要求 Node.js 18.17+。在会话工作目录运行：

```powershell
node "<skill-dir>/bin/install.js" doctor
```

`configured: true` 只说明配置可读取，不证明云端模型可用。诊断不联网、不输出完整 Key。私有测试包的 `private/` 包含预配置；Windows Key 使用 DPAPI 加密，只能由原 Windows 用户解密。无随包配置时，使用当前用户目录下 `.openh3/apiyi-image-generation/`，不修改原来的 `.api2img` 或 OpenH3 对话模型。

**已配置时直接使用，不重复索要 URL/Key。** 不要调用 `npx api2img`、安装其他 Agent 适配器、切换本地 ComfyUI，不要通过内置图片工具执行本 Skill；内置工具的协议与本脚本不同。

## 生成

```powershell
node "<skill-dir>/bin/install.js" generate --prompt "一只毛茸茸的橘猫坐在木质窗台上，望向窗外。柔和晨光照亮胡须和眼睛，毛发清晰，浅色窗帘虚化，暖色胶片调色，自然抓拍感，安静温柔。竖版3:4构图。" --model "gpt-image-2.5-all" --size "768x1024" --out "output/imagegen/orange-cat.png"
```

此示例尺寸为精确 3:4 的**请求值**，是否接受取决于云端模型。接口拒绝尺寸或模型时，先复用用户已授权的备选模型、尺寸范围及费用限制，在该范围内继续并说明实际选择，不重复询问。只有需要超出已有选择或改变所要求比例、且未获授权时，才说明具体失败并询问缺失的选择。不得静默更换供应商。默认生成一张；仅在用户要求时增加 `--n`。

请求发送到 `/v1/images/generations`，支持 `data[].b64_json` 和 `data[].url`。输出为 JSON，`files` 包含绝对路径；返回图像格式与扩展名不一致时自动修正扩展名。以返回路径为准，检查实际图片可正常解码，并核对实际宽高是否满足所要求的比例，再展示给用户。服务端可能忽略尺寸；实际不是 3:4 时明确说明，不宣称已经满足 3:4。退出失败、空响应或未得到图片时，不宣称生图成功。

可使用 `--prompt-file <UTF-8文本>` 传长提示词。每次选新文件名；没有用户覆盖意图时不要传 `--force`。

只验证参数、不花费生图额度：

```powershell
node "<skill-dir>/bin/install.js" generate --prompt "test" --model "gpt-image-2.5-all" --size "768x1024" --dry-run
```

`--dry-run` 不请求服务器，不能证明认证、模型或尺寸已经通过验证。

## 编辑

用户要求修改指定图片时，使用其提供的图片；这些输入将上传到已配置的 APIYi 地址。未明确要求上传的无关文件不要附加。

```powershell
node "<skill-dir>/bin/install.js" edit --image "<输入图片绝对路径>" --prompt "保留主体，将背景改为浅色窗帘" --model "gpt-image-2.5-all" --out "output/imagegen/edited.png"
```

多张参考图重复 `--image`；蒙版使用 `--mask <路径>`。发送 multipart 至 `/v1/images/edits`。是否支持多图、蒙版以及尺寸由所选云端模型决定。不要虚构 `generate-batch` 等未实现命令。

## 配置与更新

用户已授权提供 URL/Key 时，可以直接配置本 Skill，不必要求用户手工设置，也不需要额外的配置 MCP。把以下 JSON 经**进程标准输入**送给命令（用用户提供的真实值替换示例，不回显 Key）：

```text
node "<skill-dir>/bin/install.js" configure --stdin-json
```

```json
{ "baseUrl": "https://api.apiyi.com/v1", "apiKey": "<用户提供的Key>", "model": "gpt-image-2.5-all" }
```

不要把 Key 写进 SKILL.md、提示词、命令行参数或临时文本文件。配置成功后运行 `doctor` 回读；只说明保存状态。仅修改模型可运行 `configure --model "gpt-image-2.5-all"`。仅在用户要求清除时执行 `configure --clear`。

默认超时 300000 ms；可用 `--timeout-ms` 指定。执行工具可保留进程并等待输出，轮询时不要重复启动生成。超时可能意味着服务器仍在处理；先检查现有进程和输出。已有授权明确涵盖未知结果后的付费重试次数/费用时，可在该范围内继续，无需再次确认；没有这类授权时，说明可能重复计费后仅询问重试决定，不把一般“继续”当成无限付费重试授权。HTTP 401/403、模型不支持、非图片响应等应如实报告，不切换供应商。

## OpenH3 导入与发现

此包通过 OpenH3 的 Skills 导入入口导入整个目录或 ZIP。成功导入后，OpenH3 原生 Agent 会在下一轮消息刷新可发现技能；已有会话也适用，无需绑定助手默认技能或重新建会话。助手的技能设置用于预选技能，不是导入技能的使用门槛。仅复制到磁盘或在消息里提到名称，不代表已完成导入。

如果当前会话找不到 Skill，不要重复调用未知名称。可以先用已有文件读取/执行工具读取本文件并运行脚本；缺少执行工具时，应切换到有执行能力的 Agent。

若需要让 Agent 管理 OpenH3 的技能导入，可读取应用内置 `openh3-config` Skill 的导入说明。它是配置 Skill，不是同名 MCP 工具。配置本 Skill 并不会自动配置云端 H3 视频或 OpenH3 的全局模型设置。
