# Browser control wire protocol v1

## 工作标签授权：task-tab-v1（0.8.0）

新版 state.capabilities 包含 task-tab-v1，control 为 `{scope:"task",windowId,sessionId,groupId,tabId,tabIds}`。sessionId 是授权 UUID，tabId 必须属于唯一、最多 8 个 ID 的 tabIds。插件和 Channel 分别校验，groupId 的实际归属由插件向 Chrome 核对。私人页手动加入同组不进入 tabIds。

用户界面的 grant 支持 mode=new（默认新建后台工作标签）或 current（明确指定当前页）。授权后目标固定；浏览器前台切换不会更新 tabId。open 复用工作页，new-tab 创建同组后台工作页，switch-tab 仅改变已授权逻辑目标。tabs.selected 表示目标；tabs.active 不是目标选择依据。空白工作页保留 control，但 tab 可为 null，由 open 启动导航。

新版 MCP 同时要求 cdp-relay-v1 和 task-tab-v1，不允许旧窗口跟随模式。旧插件 state 仍可被 Channel 解析以支持既有聊天/CLI，但 MCP 会要求升级；新版插件需新版 Channel，旧 Channel 的严格 control 校验不兼容 task。wire protocol 仍为 1，新增能力与授权结构需配套发布。

下文的“当前标签”均指已选择的 Agent 工作标签，不是用户前台页；切标签导致租约失效指工具选择另一工作页，用户切前台不使 refs 失效。关闭/移出当前工作页撤销授权，无个人页回退。详细行为见 [工作标签说明](TASK-TABS.md)。

## MCP/CDP 扩展：cdp-relay-v1（0.7.0）

ready 后的 state 声明此能力；旧插件不声明时 Channel 拒绝 MCP 操作，原 command 协议不变。MCP 不进入 chat 队列。两端分别维护 cdp-protocol.ts，无运行时源码共享。

- cdp-bind：id、leaseId、controlSessionId、deadline。插件只能绑定已有有效授权的当前标签，返回 leaseId/controlSessionId/tabId 和页面信息，不能替用户授权。
- cdp-command：上述字段再加 tabId、method、params；两端检查方法白名单。sessionId 子会话当前不支持。截止时间前后都检查会话身份，切标签/授权改变使旧租约失效。
- cdp-response：原 id、ok、result 或 error。每设备最多 32 个 CDP 请求在途，插件限制结果小于 8 MiB；普通 command 不与在途 CDP 混用，stop/cancel 优先处理。
- cdp-event：leaseId、method、params。只转发必要的顶层 Page/Runtime/Network 生命周期；Network 不传 headers、cookie 或 body，事件上限 1 MiB。

CDP 请求只来自 Channel 内私有回环 listener 的活跃工具租约，不能连接用户全局调试端口。白名单不包含 cookie、Browser 控制、任意 Target 管理或存储导出；Page.navigate 只允许支持的 HTTP(S) 页面，截图只允许当前视口。密码/OTP 由用户输入。

普通已完成的工具错误会 park/finish，保留授权；有未完成请求、停止、断线、超时则保守取消，不重放写操作。finish、授权变化、标签变化均使旧引擎 refs 失效。最终 reply 也检查 MCP busy，并继续等待真实 debugger detach 后显示文本。

两端通过 WS/WSS JSON 消息通信。设备配对后以凭据认证；chat 送入 channel 的 C4 通道；command 与 result 使用请求 ID 关联。取消或断线不能自动重放写操作。

命令类型：tabs、observe、snapshot、click、fill、type、open、new-tab、switch-tab、scroll、keypress、screenshot、finish、stop。open 复用当前标签；new-tab 显式新建。参数校验不能代替用户控制授权。

## 答复收尾扩展：finish-v1

插件 state.capabilities 包含 finish-v1 时，支持无参数的 finish 命令。成功返回 finished=true、debuggerDetached=true。它清除光标、使旧 refs 失效并释放 debugger，但保留原工作标签授权；空闲期间页面加载/用户前台切换不会重连，下一条浏览器操作按原授权重连。tabs 无需连接调试器。stop/断线/重载仍撤销授权。0.8.0 的 finish 将组标为灰色已完成，stop 标为已停止；两者都保留页面。

Channel 的 reply IPC 默认 final=true：确认设备不忙，锁住新的浏览器命令，发送 finish 并等待完成，然后才下发 assistant chat。工具尚未完成时返回 BROWSER_BUSY，不中断写操作；释放失败、超时或授权更换时不发布该答复。显式 final=false 的进度消息不触发收尾。没有 finish-v1 的旧插件回退到 stop，会撤销旧授权，升级并重载后才能保留授权。

C4 普通答复当前没有阶段标记，所以提前发的确认消息也会释放空闲调试连接；后续操作能恢复，但必须重新观察、不能复用旧 refs。这不是任务 ID 状态机，也不是用定时器猜测模型是否完成。

Chrome 提示条由浏览器管理，本实现调用真实 [chrome.debugger.detach](https://developer.chrome.com/docs/extensions/reference/api/debugger#method-detach)，不隐藏或规避调试提示。

插件校验器位于 utils/commands.ts，一致性样例位于 tests/fixtures/commands.v1.cases.json。channel 独立维护自己的同版校验器和样例。修改协议需同步两端测试并运行 Chrome 集成测试；破坏性协议改动需提升版本。此次目录整理保持 wire protocol 1。

## 截图观察扩展：observe-v1

插件的 state 消息新增可选 capabilities: ["observe-v1"]。旧 state 不带此字段仍可使用原命令；新 channel 只向声明能力的客户端发送 observe，否则立即返回 EXTENSION_UPDATE_REQUIRED。新插件仍兼容旧 channel 的原命令。不是全量协议版本协商。

observe 参数：op="observe"，interactive 为可选布尔值，默认 false。只读，不执行点击，也不自动重放之前的动作。

返回：observationId、tabId、url、title、pageVersion、startedAt、capturedAt、viewport、text、screenshot。viewport 包含 readyState、width/height（CSS 像素）、scrollX/Y、dpr；screenshot 是 mimeType="image/png" 和 base64 data。视口截图不包含插件光标；AX text 是顶层文档结构，可以包含屏幕外元素。pageVersion 是授权会话和导航代数，不是 DOM 内容版本。

observe 刷新 refs；AX 和截图是同一授权页面上的连续读取，并非动态页面的原子快照。页面加载中返回 PAGE_LOADING，导航或切页中返回 PAGE_CHANGED/STOPPED；失败不应被解释为前一个写操作失败。超过传输上限返回 SCREENSHOT_TOO_LARGE/RESULT_TOO_LARGE，不断开连接。重复请求只返回精简 RESULT_ALREADY_DELIVERED，不缓存大量图片。

Agent CLI 在服务端把 data 写为私有临时 PNG，将响应替换为 screenshot.path/width/height/bytes，明确要求调用图片读取工具。WS 的 base64 和 CLI 的路径都不直接等于模型图片输入。具体流程见 [截图观察](SCREENSHOTS.md)。
