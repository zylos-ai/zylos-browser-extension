# 架构和开发边界

> 以下是旧 Channel / OpenMAX 接入的历史演进记录。当前插件固定使用 remote 入口，
> 标准构建输出为 `.output/chrome-mv3`；当前结构和启动步骤见 [README](../README.md)，
> 消息协议见 [relay PROTOCOL](../../zylos-browser-remote/docs/PROTOCOL.md)。

## 专用工作标签（0.8.0）

路由改为显式 task 会话，不跟随前台焦点。ControlCard 的授权按钮创建独立后台标签，或按用户选择指定当前页；executor 维护确切 tabIds 和 selected tabId，用 Chrome 原生绿色组标记。组成员关系不是授权，不能借拖入同组获取私人页控制权。Channel 的 CDP lease 同时绑定 deviceId、sessionId 和该逻辑目标。

用户前台切换不改变工具目标；Agent 新建和切换工具页不调用 active:true。只有用户点击「查看工作标签」才聚焦。任务完成 detach 后灰色标记，停止撤销授权但留结果页。详见 [行为、边界和验证](TASK-TABS.md)。新增 tabGroups 权限；仍无常驻全站 content script，没有 Core 源码改动。

## agent-browser MCP 接入（0.7.0）

聊天消息仍由独立 Channel 送入 C4/SQLite，Agent 的文本答复走原 Channel。浏览器工具由 Agent 调用 Channel 项目的 MCP server；该 server 调用真正的 agent-browser 0.36.0，再把 CDP 操作经同一个 Channel 的 WS 发给插件。MCP/第三方引擎都不打包到插件，没有新增客户端本地服务或公网 Gateway。

本项目新增 utils/cdp-protocol.ts。background/runtime.ts 接收 cdp-bind/cdp-command、关联响应并转发必要事件；utils/automation/executor.ts 将租约绑定到已有用户授权和当前标签，检查方法/页面/敏感输入后调用 chrome.debugger。不是对 AI 开放任意 CDP/JS：AI 工具集合及参数在 Channel 收窄，两端再维护 CDP 方法白名单。

原 CLI 命令执行器保留作兼容，不能与正在运行的 MCP 工具混用。CDP Input 鼠标事件驱动可视光标；MCP 的节点 focus 和文本/按键路径也补充位置反馈。移动完成后才转发真实动作（动画等待有上限），不会用页面 JS 伪造点击。首次从视口角落进入的箭头是 Agent 的 UI 代理，不代表用户的系统鼠标位置。减少动态效果偏好仍跳过动画。

0.7.1 起，已有光标在有效 CDP 控制期间每秒续期，保持在工具调用间隙；续期不创建光标，不改变截图隐藏状态。停止、结束、切页/切标签或调试断开会停止续期；后台异常失联后页面光标 3 秒自清理。截图临时隐藏光标。Channel 0.6.1 强制使用干净截图，不启用上游在真实 DOM 中画框的 annotate 模式；即使兼容调用传入 annotate:true 也返回未标注图并说明。离线图片标注尚未实现。

finish 清理租约/光标/调试连接但保留授权；stop 撤销授权。当前只支持顶层文档，不转发 iframe 子会话。工具调用等待结果返回，下一步判断仍由原 Agent 作出。

## WXT 入口

entrypoints/background/index.ts 启动后台；同目录 runtime.ts 管理 WS、设备凭据和消息，endpoint.ts 校验地址。popup 与 sidepanel 是两个独立入口，共享 components/ 和 hooks/useAgent.ts，通过 utils/mount.tsx 挂载 React。

所有 UI 特权请求都必须来自当前扩展的 popup.html 或 sidepanel.html；旧 panel.html 已移除，并不再列入消息来源白名单。

## 操作执行

后台检查命令格式，调用 utils/automation/executor.ts。执行器确认用户已授权的工作标签 ID、所属任务窗口/组及操作生命周期，再调用 Chrome tabs / debugger API。utils/automation/injected/ 是受控的内部页面辅助脚本，按需以 raw 文本打包，不是对外开放的任意 JavaScript 执行接口。可视光标不会出现在 Agent 页面快照或截图里。

assets/styles.css 由 WXT 处理；源码不写入 .output/，WXT 负责生成 manifest 与所有浏览器产物。

## Channel 边界

本插件不包含 C4、Agent skill、工具 CLI 或服务进程。它主动连接独立 channel，并只通过版本 1 WS 协议交换消息和工具结果。模型判断和观察—操作循环在 Core 中，channel 负责路由，插件负责执行。

命令校验与内部消息类型分别在 utils/commands.ts、utils/messages.ts。测试契约在 tests/fixtures/。扩展协议时同步 channel，不能跨项目直接 import 源码。

目录整理之后新增 observe-v1 能力：同一授权页面的结构和截图一起返回，Channel CLI 保存图片并提示 Agent 读取。观察循环仍由 Agent 调用工具完成，未改 Core 或生产权限。详细边界见 [截图辅助操作](SCREENSHOTS.md)。
