# Zylos Browser Extension

独立的 WXT + React + TypeScript Chrome MV3 插件。负责界面、设备连接、用户控制授权和浏览器操作；通过 WS/WSS 连接独立的 zylos-browser-channel。

后续开发计划见 [浏览器自动化能力升级 TODO](docs/ROADMAP.md)，包含分阶段任务、项目归属和验收标准。

0.10.1：分组不再显示“已停止／已完成”。临时页关闭，保留结果页退出分组，空组随之消失；暂停时显示“等待继续”。兼容 Channel 0.10.0，不需要重启服务，重载原插件即可。流程和异常边界见 [工作标签生命周期](docs/task-tab-lifecycle.md)。

0.10.0（历史）：新增 pause／finalize 任务收尾与归属清理日志，配对保留，不增加权限。

0.9.1（历史）：主界面收敛为聊天，删除手动工作标签面板、设备编号与调试详情。配对入口移入设置，首次使用仍可输入配对码。仅在对话需要操作网页时显示授权卡片，确认后才新建专用标签。

当前执行入口：Channel 0.10.0 使用 agent-browser CLI，不再使用浏览器 MCP。聊天链路不变，新增 task-finalize-v1 收尾能力。Channel 中的 SKILL.md 和 README.md 是新版 CLI 使用与迁移说明；下文版本描述为历史记录。

0.9.0：支持对话中按需授权。先直接发送需求，首次浏览器工具调用时显示“允许并继续”卡片；确认后新建专用工作标签，并通过原有 C4 通道通知 Agent 继续原任务。配合 Channel 0.8.0，无需改 Core。原手动授权折叠为可选高级设置。升级需重启 Channel/Agent MCP 会话并重载插件，详见 [对话内授权](docs/CONVERSATION-AUTH.md)。

0.8.1：鼠标操作改用本地平滑轨迹，沿途发送真实 CDP 鼠标移动事件，图标跟随已发送的坐标，支持网页悬停和 Pointer 事件。保留工作标签隔离及停止检查。只需重载原插件并重新授权工作标签，不增加权限、不改配对，也无需重启 Core / Channel。实现与验证见 [原生鼠标轨迹](docs/POINTER-MOTION.md)。

0.8.0：默认创建独立的后台工作标签，并用绿色「Coco Agent」原生标签组标记。你切换到其他标签不会改变 Agent 的操作目标；后续动作复用同一个工作标签。可以明确选择「使用当前页面」替代新建。完成后标记变灰并释放调试，停止则撤销授权，结果页面保留。需配合 Channel 0.7.0。升级步骤、边界和验证见 [工作标签说明](docs/TASK-TABS.md)。

以下为历史版本记录；0.8.0 已用工作标签授权替代窗口授权。

0.7.1：修复 MCP 路径的可视鼠标反馈。点击前移动、输入/按键反馈与动作间隙保留；结束/停止清理，截图隐藏。配合 Channel 0.6.1，关闭会上屏闪红框的上游截图标注，继续返回干净截图和 snapshot refs。升级后原地重载插件，并在 Agent 空闲时重启其 MCP 会话；无需重配对。

0.7.0：支持 Channel 的 agent-browser MCP 引擎接入。新增 cdp-relay-v1，只在用户授权的当前窗口/标签中执行受限 CDP 操作，保留光标、停止和答复前解除调试。工具定义和第三方引擎在 Channel；本项目仍是独立 WXT 插件，聊天链路没有改变。详见 [架构](docs/ARCHITECTURE.md) 和 [协议](docs/PROTOCOL.md)。

已加入截图 + 页面结构的 `observe`，用法和模型看图边界见 [截图辅助操作](docs/SCREENSHOTS.md)。

0.6.1：Channel 普通答复前会等待 finish 释放调试连接和光标，原窗口授权与配对保留。下一次工具调用按需重新连接，用户点击停止仍会撤销授权。具体时序和旧版本兼容见 [协议说明](docs/PROTOCOL.md)。

## 快速开始

需要 Node.js 22+：

```sh
npm ci
npm run dev
```

开发模式使用 WXT 默认浏览器启动和热更新流程，默认打开独立开发浏览器。若环境没有可用浏览器，可按 WXT 的 Browser Startup 文档配置本机浏览器；不要把个人 Chrome 配置复制进项目。手动加载开发构建时选择 .output/chrome-mv3-dev/；开发进程需要持续运行。

生产构建：

```sh
npm run build
npm run zip
```

在 Chrome 扩展管理页开启开发者模式，加载本项目的 **.output/chrome-mv3/**。zip 位于 .output/。构建只使用 WXT 默认输出，不再复制到 extension/。

## 源码结构

```text
entrypoints/
  background/       # Service Worker 入口、连接管理
  popup/            # 弹窗 HTML 和 React 入口
  sidepanel/        # 侧边栏 HTML 和 React 入口
components/         # 共享 React 组件、错误边界
hooks/              # React 状态与消息订阅
assets/             # 经 WXT 处理的样式
utils/
  automation/       # CDP 执行器、页面辅助脚本、可视光标
  commands.ts       # 浏览器端命令校验
  messages.ts       # 插件内部消息类型与校验
  mount.tsx         # 共享 React 挂载
tests/
  unit/             # UI、协议、授权生命周期单测
  fixtures/         # 本地协议契约样例
docs/               # 架构、协议、迁移说明
wxt.config.ts       # WXT + React + manifest 配置
```

使用 WXT 官方默认扁平目录，不配置自定义 srcDir / outDir。没有资源需求的 public/、modules/ 等目录不创建空壳。注入脚本只在授权操作时执行，不新增全站 content script。

## 连接与使用

本地服务地址为 http://127.0.0.1:3460；远程填写受信任的 HTTPS/WSS 地址。配对码由 channel 生成。在插件内配对后，勾选授权并点击「创建 Agent 工作标签」。通过「查看工作标签」可主动切过去查看过程。

Agent 的 MCP 工具定义、agent-browser 依赖和 Skill 在 channel，插件 executor 负责工作标签授权检查并执行 CDP/标签操作。模型推理不在插件内。配对持久化；断线、停止或后台重启撤销操作授权。密码、上传下载和跨域 iframe 等能力仍不支持。升级时在原扩展卡片重载 .output/chrome-mv3/，无需重新配对，需重新授权工作标签；0.8.0 新增 tabGroups 权限。Channel 服务与 Agent 的 MCP 会话也须加载新版本。

## 检查

```sh
npm test
npm run test:build
npm run format:check
```

跨项目集成测试在 channel 目录执行，指定本项目 .output/chrome-mv3/ 为 BROWSER_EXTENSION_DIR。测试使用独立 Chromium 配置和模拟页面，不向真实 Agent 发任务。

从旧 extension/ 目录迁移，请先阅读 docs/MIGRATION.md。不要再加载旧 panel.html 或旧构建目录。

参考：[WXT Project Structure](https://wxt.dev/guide/essentials/project-structure.html)、[Entrypoints](https://wxt.dev/guide/essentials/entrypoints.html)。
