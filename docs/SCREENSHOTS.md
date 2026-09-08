# 截图辅助浏览器操作

## 已实现的流程

Agent 调用 Channel 的 `observe --device ID` → 插件检查工作标签授权并读取该页面结构、截取该页视口 → Channel CLI 在 Agent 机器保存 PNG → Agent 用图片工具读取 → 结合图片和元素 refs 决定下一步 → 关键动作后再次观察并验证结果。0.8.0 起当前页面是 Agent 逻辑工作页，不是用户前台标签；MCP 截图直接返回 image，旧 CLI 的落盘规则见下文。

本版继续使用 Skill + CLI，不新增 Gateway/MCP，不修改 zylos-core，不在插件里再运行一个模型。图片读取是 Agent 的一个真实工具调用：本地 Codex 使用 view_image，Claude Code 可使用支持图片的 Read。已检查本机运行时为 Codex，安装的 CLI 包含 view_image。模型/供应商仍必须支持视觉输入；没有图片工具时必须说明无法看图，不能把打印路径当成已经看见。

## 怎么试

1. 在 Chrome 原来的扩展卡片上点重新加载，路径仍是本项目 `.output/chrome-mv3/`。
2. 保留原配对，重新创建或授权 Agent 工作标签。
3. 在插件发任务，例如：“先截图看看当前页面，再帮我填写搜索内容；搜索后再截图核对结果。”不要在登录、验证码或敏感信息页面测试。

Agent 的调用示意（ID 必须来自请求的原设备 endpoint）：

```sh
~/zylos/bin/zylos-browser-channel observe --device DEVICE_ID
# 使用运行时图片工具读取 result.screenshot.path；这不是 shell 命令。
~/zylos/bin/zylos-browser-channel click REF_FROM_OBSERVATION --device DEVICE_ID
~/zylos/bin/zylos-browser-channel observe --device DEVICE_ID
# 读取新图片、核对实际结果，再继续或回复。
```

observe 默认保留非交互文本，便于看到保存成功或失败提示。`observe -i` 只精简结构文本，不改变图片。`snapshot [-i]` 仍是纯文本；`screenshot [file.png]` 仍支持单独截图，不传路径改为唯一临时文件，避免反复执行时文件已存在。

## 隐私、权限与保存

只截图当前授权的 Agent 工作网页视口，不截图用户其他前台标签、桌面或 Chrome 界面，不持续录屏。截图会沿现有 WS/WSS 连接传给已经配对的 Agent，远程部署时文件在 Agent 虚拟机，不在客户文件目录。工作页中的敏感内容可能进入截图；不要把图片再上传到不相关服务。

临时目录是 Channel 数据目录下的 observations/，目录权限 0700、图片 0600。每设备最多保留 8 张，1 小时过期；服务每分钟清理，启动和新截图时也清理。服务停止期间没有后台清理，重启后继续；并发捕获可能短暂超过数量上限。显式指定的导出路径不覆盖原文件、不参与自动清理。图片不进入聊天历史，不写 base64 日志；Agent 自身图片工具的记录和模型侧保留策略不由此缓存清理控制。

停止、断线、切页时的生命周期检查继续有效，不返回已失效的观察。图片过大明确报错，不静默压缩到文字不可读，也不因为超限自动重复点击。

## 目前的边界

- 能看见不代表一定能点到：仍以 AX ref 操作，未增加坐标点击、跨域 iframe 定位或图片语义定位。
- 结构与截图是连续采集，不是原子的同一帧；页面版本只标记导航/控制变化。动态页面出现不一致时重新观察。
- 检查加载中状态，但尚未实现通用“等指定文字/元素出现”工具。没有固定睡两秒、没有每按一个键就截图。
- 操作后观察和图片读取由 Channel Skill 指导 Agent 调用，不是每个写命令自动附图，也不是 Core 强制执行的任务状态机。观察失败不会自动重放提交。
- 截图不保证准确率提高多少，也可能增加看图耗时。需在真实业务任务中继续验证。

## 验证范围

覆盖联合观察、CLI 图片落盘与权限、生命周期取消、加载中、超大截图拒绝、旧插件能力提示、图片过期清理。Chromium 使用独立临时配置和模拟页面，验证真实 PNG 和保存成功/失败页面文本；不把测试页面文字当成真实 LLM 视觉理解的证明。未自动向本机 Zylos Agent 发送真实模型测试任务。

实现依据：[CDP 截图接口](https://chromedevtools.github.io/devtools-protocol/tot/Page/#method-captureScreenshot)；[Codex CLI 官方说明](https://learn.chatgpt.com/docs/codex/cli)。
