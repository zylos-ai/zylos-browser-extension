<p align="center">
  <img src="assets/brand/logo.png" alt="Zylos" width="400" />
</p>

<h1 align="center">Zylos Browser</h1>

<p align="center">
  <strong>让你的 Zylos Agent，在 Chrome 中与你一起工作。</strong><br />
  在侧边栏里聊天，让 Agent 打开网页、查找信息、填写表单，并完成浏览器任务。
</p>

<p align="center">
  <img src="https://img.shields.io/badge/Chrome-125%2B-4285F4?logo=googlechrome&logoColor=white" alt="Chrome 125 或更新版本" />
  <img src="https://img.shields.io/badge/Manifest-V3-AC01C2" alt="Manifest V3" />
  <img src="https://img.shields.io/badge/Node.js-22%2B-5FA04E?logo=nodedotjs&logoColor=white" alt="构建需要 Node.js 22 或更新版本" />
</p>

<p align="center">
  <a href="#features">功能</a> ·
  <a href="#quick-start">快速开始</a> ·
  <a href="#how-it-works">工作原理</a> ·
  <a href="docs/DEVELOPMENT.md">开发指南</a> ·
  <a href="https://github.com/zylos-ai/zylos-browser-extension/issues">反馈问题</a>
</p>

---

Zylos Browser 是 Zylos Agent 的 Chrome 插件。在同一个侧边栏里，你既可以日常聊天，也可以把浏览器任务交给 Agent。每条消息默认附带当前页面的标题、网址和文字摘要。Agent 可以直接读取、操作你正在看的页面，也可以为新任务创建工作标签；执行时显示操作光标和任务状态，你可以随时停止。

插件运行在你的 Chrome 中，Agent 可以运行在本机或远程服务器，通过 [Zylos Browser Remote](https://github.com/zylos-ai/zylos-browser-remote) 连接。

<a id="features"></a>

## 在浏览器里，完成更多事

| 功能               | 你可以做什么                                                                                   |
| ------------------ | ---------------------------------------------------------------------------------------------- |
| **当前页上下文**   | 每次发送消息时关联当前标签页，并附带最多 6,000 字符的主页面文字摘要；需要更多内容时再读取。    |
| **侧边栏对话**     | 与已连接的 Zylos Agent 聊天；需要操作网页时，直接描述任务。                                    |
| **网页交互**       | 打开与切换工作标签、查找元素、点击、输入、滚动和填写表单。                                     |
| **页面观察**       | 通过页面快照、文本和截图，让 Agent 了解网页当前的内容与状态。                                  |
| **可见的执行过程** | 聊天内查看工具步骤与耗时；输入框右上方实时预览任务页面，悬停可查看或停止，完成后显示绿色勾选。 |
| **专用工作标签**   | 在 `zylos` 标签组中执行任务，最终回复后释放控制并保留结果页。                                  |
| **中文与英文界面** | 默认跟随浏览器语言，也可以在设置中手动切换。                                                   |

试着从一个简单的请求开始：

> 总结当前页面，再帮我点击这里的搜索按钮。

> 打开 example.com，告诉我这个页面介绍了什么。

> 打开 YouTube，搜索「明日之丈」。

> 不用操作浏览器，帮我整理一下今天的工作计划。

每次点击发送时固定当前标签页，之后切换标签不会把任务转移到另一个页面。借用的原标签页不会被任务清理关闭或改变分组。普通聊天无需调用浏览器操作工具；自动附带的页面文字不包含表单值，受限页面或读取失败时会说明内容不可用。

当前页上下文需要同时更新插件和 Remote；远程部署也使用同一条连接链路。浏览器任务的具体步骤由连接的 Agent 根据你的请求和插件指南决定。

<a id="quick-start"></a>

## 快速开始

你需要 **Chrome 125+** 和一个可用的 **Zylos Agent**。以下步骤从源码安装插件，构建需要 **Node.js 22+**。

### 1. 安装插件

```sh
git clone https://github.com/zylos-ai/zylos-browser-extension.git
cd zylos-browser-extension
npm ci
npm run build
```

打开 `chrome://extensions`，开启 **开发者模式** → **加载已解压的扩展程序**，选择本仓库的 **`.output/chrome-mv3`** 目录。

建议将 Zylos 固定到 Chrome 工具栏，点击章鱼图标即可打开侧边栏。更新源码并重新构建后，需要在扩展管理页点击 **重新加载**。

<details>
<summary>macOS 中找不到 .output 目录？</summary>

Finder 默认隐藏以点开头的目录。按 `Command + Shift + .` 显示隐藏目录，或在目录选择框中按 `Command + Shift + G` 输入完整路径。

</details>

### 2. 获取 Agent 的连接信息

如果已经配置了 Browser Remote，直接使用已有的连接地址和完整 Key。首次连接时，把下面的提示词复制到你原来与 Zylos Agent 对话的入口，让它按安装文档配置服务。

<details>
<summary><strong>展开并复制：让 Agent 配置 Browser Remote</strong></summary>

适用于已经在线上运行、拥有独立 HTTPS 地址的 Zylos Agent。

```text
请帮我安装并配置 Zylos Browser Remote，让我能通过 Chrome 插件和你聊天，并让你操作我的浏览器。我确认安装（confirm）。

请先阅读安装说明：
https://github.com/zylos-ai/zylos-browser-remote/blob/main/README.md

然后完成：
1. 检查是否已安装 browser-remote；已安装则复用。
2. 使用你现有的公网 HTTPS 域名，配置 WebSocket 转发路由。
3. 启动服务，检查 Relay 和公网入口是否可用。
4. 为我的 Chrome 插件生成一个连接 Key。
5. 读取组件 SKILL.md，按插件请求附带的工具契约，通过 decision.js 返回动作决策；最终回答使用当前请求附带的 C4 回复命令。

完成后，请直接在当前对话返回：
地址：wss://你的真实域名/browser-remote/ext
Key：本次生成的完整密钥，不是 keyId

我会把这两项填入插件设置，然后与你验证聊天和浏览器操作。
```

地址复用 Agent 已有的域名，Agent 仍需配置 `/browser-remote/` 的转发路由。这些步骤由 Agent 按文档执行，目前尚未整合成一键配对命令。

</details>

Agent 应当返回两项信息，例如：

| 字段                  | 示例                                         |
| --------------------- | -------------------------------------------- |
| 服务地址（Relay URL） | `wss://alice.example.com/browser-remote/ext` |
| 连接 Key              | Agent 生成的完整连接密钥                     |

**使用完整 Key，而不是短的 `keyId`。** 每个 Chrome profile 应使用独立 Key，同一个 Key 的新连接会替换旧连接。

### 3. 连接并开始聊天

打开侧边栏的 **设置**，填写服务地址和 Key，点击 **保存并连接**。

显示已连接后，先发送一条消息，确认 Agent 能回复；再试试「打开 example.com」，浏览器中应出现名为 `zylos` 的工作标签组。

连接配置保存在当前 Chrome profile 的插件本地存储中，再次打开侧边栏无需重新填写。

> **使用远程 Agent？** 你的电脑只需安装插件，Remote 和 Agent 运行在服务器上。使用 Agent 返回的 `wss://` 地址即可，无需在本机启动 `Browser-dev.sh`。`ws://127.0.0.1:3802/ext` 仅适用于 Chrome 和 Relay 位于同一台电脑的本地联调。

<a id="how-it-works"></a>

## 工作原理

```mermaid
flowchart LR
  User["你"] <-->|"侧边栏对话"| Extension["Chrome 插件"]
  Extension <-->|"WebSocket"| Remote["Browser Remote"]
  Remote <-->|"页面状态 / 结构化决策"| Agent["Zylos Agent"]
  Extension <-->|"浏览器操作与结果"| Pages["工作标签"]
```

| 项目                                                                   | 职责                                                           |
| ---------------------------------------------------------------------- | -------------------------------------------------------------- |
| **本仓库 · Chrome 插件**                                               | 侧边栏、任务循环、浏览器执行器、页面观察、工具定义和参数校验。 |
| **[Browser Remote](https://github.com/zylos-ai/zylos-browser-remote)** | 连接插件与 Agent，转发请求和结果，处理聊天投递与图片附件。     |
| **Zylos Core / Agent**                                                 | 根据插件发送的状态返回结构化动作决策或最终答复。               |

支持 `agent-loop-v1` 的 Remote 连接后，侧边栏默认使用插件任务循环：插件发送当前页面摘要及动作契约 → Agent 返回决策 → 插件执行、等待页面稳定、读取实际状态 → 请求下一轮决策。普通聊天直接返回文字，不创建浏览器任务。插件会跟随选中任务页新开的单个子 Tab；多个新 Tab 交由 Agent 根据实际列表选择。不会猜目标网址，也不会自动重复已执行的点击。

工具定义和循环指南只有插件这一份。Remote 只做请求关联、首次 C4 投递、图片附件转换和诊断记录。后续页面状态直接作为决策命令的返回值交给 Agent，不再逐轮经过 C4 队列。插件和 Remote 需同时支持决策协议；更新后重启 Remote 并重新加载插件。详见 [决策协议](agent/decision-guide.md)。实际速度仍取决于模型响应和网页加载。

插件使用 `webNavigation` 权限确认新页面的来源，只将当前任务页创建的子 Tab 纳入任务，避免用户切换前台页面后错误关联。

执行链路、端口分工、任务生命周期和目录地图见 [开发指南](docs/DEVELOPMENT.md)。

## 开发与贡献

项目基于 **WXT · React · TypeScript · Zod**，使用 **Tailwind CSS / DaisyUI** 构建侧边栏界面。

```sh
npm run dev         # WXT 开发模式
npm test            # 类型检查与单元测试
npm run test:build  # 构建与产物检查
npm run test:e2e    # 真实 Chrome 与 Relay 的端到端测试
npm run zip         # 生成插件压缩包
```

端到端测试需要 Chrome 和相邻的 `zylos-browser-remote` 仓库；可通过 `CHROME_PATH`、`RELAY_ROOT` 指定路径。完整环境与验证说明见 [开发指南](docs/DEVELOPMENT.md#8-常用命令与验证)。

欢迎提交 Issue 或 Pull Request。报告问题时，请附上 Chrome / 插件版本、复现步骤，以及相关错误信息；新增浏览器动作时，请同时更新工具说明和对应测试。

## 常见问题

| 现象                     | 检查方向                                                                                            |
| ------------------------ | --------------------------------------------------------------------------------------------------- |
| 无法连接                 | 检查完整 `wss://` 地址、`/browser-remote/ext` 路径和完整 Key；由 Agent 检查证书、代理路由与 Relay。 |
| 已连接，但聊天无回复     | 由 Agent 检查 C4 消息通道、Agent 运行状态与 Remote 的回复脚本。                                     |
| 聊天正常，但无法操作网页 | 检查决策返回的错误和任务状态，按请求附带的工具契约继续。                                            |
| 更新后仍显示旧能力       | 重新构建，在 Chrome 扩展管理页重新加载，并核对加载的是当前仓库的 `.output/chrome-mv3`。             |

## 文档

| 文档                                                                                       | 内容                                                         |
| ------------------------------------------------------------------------------------------ | ------------------------------------------------------------ |
| [开发指南](docs/DEVELOPMENT.md)                                                            | 项目架构、执行链路、目录地图、界面开发与本地验证。           |
| [插件 WebSocket 收发协议](docs/EXTENSION-WEBSOCKET-PROTOCOL.md)                            | 连接握手、消息字段、决策与结果格式、完整调用示例和代码定位。 |
| [浏览器动作](docs/BROWSER-ACTIONS.md)                                                      | 动作参数、执行边界与验证记录。                               |
| [Agent 决策指南](agent/decision-guide.md)                                                  | 随插件提供的浏览器工作流程与错误恢复说明。                   |
| [工具目录源码](utils/tool-catalog.ts)                                                      | 工具用途、约束、例子与动态参数描述。                         |
| [Remote 安装与部署](https://github.com/zylos-ai/zylos-browser-remote#readme)               | 连接服务的安装、配置与 Agent 接入。                          |
| [Remote 协议](https://github.com/zylos-ai/zylos-browser-remote/blob/main/docs/PROTOCOL.md) | 消息格式、传输接口与错误响应。                               |
