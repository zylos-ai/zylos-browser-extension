# 专用工作标签（Extension 0.8.0 / Channel 0.7.0）

## 使用方式

1. 配对或恢复现有连接。选择「新建专用标签（推荐）」、勾选授权，创建工作标签。
2. 插件在同一普通浏览器窗口创建一个后台空白标签，并放入绿色「Coco Agent · 工作中」组，不切走用户正在看的页面。
3. 发送任务，例如“打开哔哩哔哩”。Agent 首次导航工作标签，后续观察和操作复用它。你可以同时浏览其他标签。
4. 点击「查看工作标签」才会主动聚焦它。也可以直接点击 Chrome 标签查看可视鼠标。
5. 最终答复前 finish 释放 debugger 和光标，组变灰「已完成」；授权仍保留。下次工具仍使用该工作标签。点击停止则撤销授权，组标为「已停止」。两者都不关闭结果页。

若要继续已有页面，授权前选「使用当前页面」；它会把那一页移入 Agent 组，属于明确授权，并非自动接管当前焦点。

## 实现与边界

- 工具定义和 Agent 规则在 Channel 的 src/mcp.ts、SKILL.md；不是插件内运行另一个 AI。
- 插件 executor 持有 scope=task、sessionId、windowId、groupId、tabId、tabIds。tabId 是 Agent 逻辑目标，tabIds 是明确登记的工作标签，最多 8 个。
- open、snapshot、输入、点击、截图都使用绑定的工作标签 ID；不再监听用户 onActivated 来切换目标，也不要求标签 active。
- new-tab 仅在必要时创建后台工作页并登记到同组；switch-tab 仅切换逻辑目标，不聚焦。tabs 只返回已授权普通工作页，selected 表示工具目标，active 仅表示 Chrome 前台状态。
- Chrome 原生分组时明确传入任务 windowId，不能依赖当前聚焦窗口。组的颜色只用于提示，不是授权来源；把私人页拖入组不会自动授权。
- 关闭、移出分组或移出窗口中的当前工作标签会撤销整个授权；移除其他工作页只移除其登记。不会自动改操作私人页。
- 断线、后台重启和插件重载都撤销授权；配对保留。异常退出可能留下旧组颜色，不代表仍可操作，以插件授权状态为准。
- 仅支持普通 Chrome 窗口和既有 HTTP(S) 顶层文档能力。冻结/休眠、要求前台可见的网站可能需要用户查看工作页；不保证所有站点可完全后台运行。
- 网站主动打开的弹窗不自动加入授权，也未实现弹窗焦点拦截。不得以访问个人标签或放宽范围作为回退。需要时由用户明确指定页面，或使用已观察到的链接在工作页导航。
- 尚不是多任务调度系统：每台设备仍是一个授权会话、单工具执行。没有跨任务并发、自动弹窗归属或持久化任务恢复。

## 升级

1. Agent 空闲时更新并构建 Channel，重启 zylos-browser-bridge，再重启 Agent 的 MCP 会话以加载新工具规则。无需修改 Core 源码或新增 Gateway。
2. 在 Chrome 扩展管理页原卡片重载 .output/chrome-mv3/。本次新增 tabGroups 权限；如 Chrome 要求确认新增权限，确认后启用。不要删设备记录或换加载目录。
3. 保留原配对，重新创建或授权工作标签。新版 MCP 要求 task-tab-v1；旧插件会提示升级，不会偷偷退回“跟随前台”。旧 Channel 不认识 task 授权，应两端一起更新。

## 验证

在 Channel 执行 test:mcp、test:integration，在插件执行 npm test、test:build。使用临时 Chromium profile 和本地测试页面，不操作个人浏览器，也不向真实 Agent 发任务。

真实 agent-browser MCP 链路覆盖：个人前台输入保持不变、后台工作页 fill/click/snapshot/screenshot/open、截图像素确认来自工作页、工作标签切换不改变前台、未授权标签拒绝、完成变灰并实际 detach、后续恢复仍绑定、停止和配对升级回归。单测另覆盖组成员伪授权、关闭/移出、授权竞态、八标签上限和显式当前页模式。

这些测试证明浏览器路由和隔离，不证明模型选品/搜索质量，也不代表已对所有真实网站测试。

Chrome 官方 API：[tabs.group](https://developer.chrome.com/docs/extensions/reference/api/tabs#method-group)、[tabGroups](https://developer.chrome.com/docs/extensions/reference/api/tabGroups)、[debugger](https://developer.chrome.com/docs/extensions/reference/api/debugger)。
