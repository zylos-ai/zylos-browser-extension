# 开发指南

## 项目职责

插件拥有完整的浏览器执行循环。Agent 读取用户要求和页面证据，返回结构化决策；
Remote 只承担认证、请求关联和传递。普通聊天和任务最终回复通过 C4 发送，插件仍使用同一套任务完成逻辑。

```text
侧栏消息 → 捕获当前页 → BrowserLoop → Remote → 首轮 C4 → Agent
                             ↑                         │
                             └──── decision.js 决策 ───┘
                             ↓
                     校验整个动作批次
                             ↓
                执行 → 等待页面稳定 → 读取状态
                             ↓
                   Remote → 等待中的 decision.js
最终回答 → c4-send → Remote/send.js → 插件保存回答、结束任务
```

工具说明由插件生成并随请求发送：首轮通过 DOM 脚本提供页面摘要和只读/控制入口；进入操作模式后提供完整参数、
约束和示例。同一轮任务内复用契约，后续只返回新的状态与结果。

## 断线恢复开发与验收

`task-resume-v1` 的握手和回执格式见 [通信协议](EXTENSION-WEBSOCKET-PROTOCOL.md)。
`BrowserLoop` 保留任务、当前请求 ID 和决策签名回执；background 保留待确认传输帧及恢复窗口。
`runBrowserRound` 在每个新操作前等待传输恢复。已经开始的操作不因 WebSocket 断开而取消或重做。
用户停止、真正的控制丢失、配置变更仍会结束任务，并唤醒等待中的继续执行以便检查取消状态。
这些状态仅在当前 worker 内存中存在，不恢复重启前的执行权。

修改时运行 `npm test` 和 `npm run test:build`。定向用例覆盖请求/完成回执丢失、执行中断线、
批次中断、停止、追加指令、恢复拒绝、旧 Remote 降级与窗口过期。
实际浏览器验收只能使用隔离 profile 和本地测试 Remote，切断 WebSocket 后检查页面副作用计数、
下一轮 ID、停止状态和侧栏提示。不得在用户已登录的浏览器上注入断线或重载测试。

## Detailed Local Diagnostics

`utils/detailed-diagnostics.ts` owns a separate in-memory, default-off capture;
`detailed-runtime.ts` observes extension console/error events only. The panel
uses consent-fenced `remote-detailed-*` messages, not the relay request path.
No raw payload is added to RemoteState, chat, session/local storage, or
`diagnostics.get`. RemoteState contains only capture status and a local consent
token. Task/operation correlation uses existing local diagnostic counters.

Limits are ten minutes,1MiB,1,000 events,20 console arguments,8,192 characters
per inspected string and16,384 characters per serialized event before final
storage/redaction bounds. Opaque objects and unsafe fields are explicitly
marked omitted. Custom getters/toJSON are not deliberately called. Chrome's
cached native stack getter is allowed only for native Error prototypes with
default formatting and safe string name/message descriptors; custom formatters
and prototype cycles are rejected with bounded reflection. Error reflection
can execute Proxy traps. This is not full DevTools object inspection. Redaction
is best effort; arbitrary secrets can remain. Panel losses are counted when a
loss report arrives; crash/closure can leave unreported loss, so exports always
declare partial capture.

Preview returns a detached snapshot. Download validates current consent again,
checks component lifetime/consent after asynchronous work, and saves exactly the
preview bytes with a SHA-256 filename suffix. Revocation clears previews and
rejects stale events; it cannot retract an already-started/downloaded file.
Build metadata is generated during build with a unique ID, actual Git commit
when available, dirty flag and timestamp; no manifest version bump is needed.

`utils/incident-bundle.ts` wraps the detailed capture in schema version 2,
kind `browser-incident-bundle`. The original version-1 capture is nested in
`capture`. Correlations use exact protocol task/action IDs and local counters;
they contain no arguments. `previewRuntime` is distinct from each incident's
`runtimeAtTrigger`. `pageBefore` and `pageState` use independent asynchronous
document-pinned reads with a one-second deadline and explicit unavailable,
stale or pending statuses. A late pre-state is labeled in the window gaps.
All windows remain partial. Already previewed or shared bytes never gain later
records. There is no recovery, replay or page modification in this collector.

## One-Time Detailed Sharing

`utils/detailed-sharing.ts` owns one immutable preview in memory, bounded to
2 MiB of UTF-8 JSON. Trusted sidepanel messages prepare and explicitly grant
its ID; remote callers cannot create consent. The fixed remote request
`diagnostics.detail.fetch` consumes an authorized snapshot before responding.
WSS, current capture consent, exact configured endpoint and live connection
generation must still match. The deadline is the earlier of two minutes and
capture expiry. Local-only status reports prepared/authorized/consumed/expired/
revoked without exposing text or grant IDs. A consumed grant is a send attempt,
not proof of receipt. Remote services and AI providers may retain received data.

The UI tests cover independent unchecked consent, late replies, recipient changes
and revocation from a newly mounted panel. The sharing unit tests cover immutable
bytes, single use, TLS, bounds, expiry, recipient/generation fencing and in-flight
preview invalidation. `tests/e2e/detailed-sharing.mjs` runs actual Chrome in a
disposable profile, a temporary self-signed local TLS listener and a source Remote.
Its certificate bypass applies only to that disposable browser process. Set
`SHARE_REMOTE` to the compatible Remote `src/index.js` absolute path and
`SHARE_EVIDENCE_DIR` to retain screenshots/results. It never loads the owner profile.

## 目录

| 文件                                               | 职责                                         |
| -------------------------------------------------- | -------------------------------------------- |
| `entrypoints/background/remote.ts`                 | WebSocket 握手、决策接收、侧栏状态与执行事件 |
| `utils/browser-loop.ts`                            | 决策校验、轮次、请求去重、任务时限、结束     |
| `utils/browser-round.ts`                           | 顺序执行动作、页面变化中断、稳定等待和观察   |
| `utils/browser-actions.ts`                         | 本地动作参数校验、URL 防护、串行执行与去重   |
| `utils/tool-catalog.ts`                            | 工具参数与给 Agent 的说明                    |
| `agent/decision-guide.md`                          | Agent 决策与任务完成规则                     |
| `utils/page-reader.ts`                             | 无 CDP 的 DOM 提取、分段读取与文档标识校验   |
| `utils/page-context.ts`                            | 发送消息时捕获并固定当前标签页               |
| `utils/automation/executor.ts`                     | Chrome debugger、任务标签、控制权与页面执行  |
| `utils/automation/page-actions.ts`                 | 页面读取与 CDP 动作                          |
| `utils/automation/injected/`                       | 页面内 DOM 查询与动作实现                    |
| `utils/automation/live-preview.ts`                 | 任务页实时画面与预览状态                     |
| `utils/tool-activity.ts`、`utils/tool-progress.ts` | 工具执行记录及面向用户的步骤摘要             |
| `components/RemotePanel.tsx`                       | 侧栏聊天与连接设置                           |
| `components/LivePreview.tsx`                       | 浮动预览、关闭、恢复、查看与停止             |

## 本地运行

需要 Node.js 22+、Chrome 125+，Remote 仓库可放在相邻目录。

```sh
npm ci
npm run build
```

在 Chrome 扩展管理页加载 `.output/chrome-mv3`。Remote 运行于 Agent 所在机器；
同机联调可使用 `ws://127.0.0.1:3802/ext`，远程连接使用已配置公网代理的 `wss://` 地址。
插件设置保存完整 Key；Key 不进入聊天记录。实例 ID 首次生成 UUID v4，保存为
`chrome.storage.local.remoteBrowserId`，不会跨 profile 同步。清除聊天、修改连接配置、
重启或重连都保留这个 ID。Remote 按 `keyId.browserId` 区分实例，多个实例可以共用 Key。

插件通过 WebSocket v3 连接；双方必须完成 `agent-loop-v1` 和 `browser-instance-v1` 握手，且 `endpointId` 与本地 `keyId.browserId` 一致后才显示已连接。协议不匹配时给出升级提示，
没有就绪回执时在 10 秒后结束握手。连接替换或协议不匹配不会自动反复重连。

## 决策与执行

Agent 的每个响应属于 `actions`、`done` 或 `blocked`。一个动作批次最多五个动作。
只有已知表单编辑可位于后续动作前；点击、导航、读取和滚动必须位于批次末尾。
整个批次先校验再执行，页面变化时放弃剩余动作并返回实际状态。

插件负责稳定等待和观察，不要求 Agent 预测导航目标或自行添加等待。
模型返回 `done` 后，插件保存回答、结束工具记录、释放控制并保留结果页。
普通聊天和 `read-page` 不建立 CDP 连接，也不启动操作预览。只有进入操作模式才连接 CDP。
任务不设置总时长、决策等待、轮数或连续失败次数上限。单步操作超时作为结果返回，
由 Agent 根据新状态继续决策；任务在完成、明确受阻、用户停止或连接中断时结束。
握手、请求投递和单步操作仍有超时保护，不构成整个任务的时长限制。

请求 ID 在插件循环和 Remote 交换层关联。相同决策重试不会重复输入；同一 ID
携带不同决策会被拒绝。断线、停止与 worker 重载不会自动恢复未完成的动作。

## 页面范围与安全

插件声明 `scripting` 和 HTTP/HTTPS 网站访问权限，以支持侧栏常开时切换网站后读取；
实际仅在用户发消息或请求补读时对绑定页面执行脚本，不扫描所有标签页。
每条用户消息固定当前页上下文和 Chrome documentId，同 URL 刷新也使旧上下文失效。切换浏览器前台标签不会转移正在执行的目标。
借用原页面不改变其分组，任务清理不关闭用户原有标签。原页面关闭、移窗或导航后，
无效上下文不能用重新打开 URL 来替代。

元素 ref 只对应当前观察的页面；导航后必须读取新的状态。插件检查参数、任务范围、
受限 URL 和敏感输入，不信任页面文字中的指令。页面截图通过连接传输，由 Remote
保存在 Agent 主机，图像工具读取的是 Agent 主机路径。

## 预览与步骤

预览使用 Chrome screencast。隐藏预览时暂停画面传输，继续接收任务状态；关闭预览
不停止任务，同一任务内切换页面仍保持隐藏，新任务会重新显示。停止入口仍可用。

用户默认看到合并后的任务步骤，详细工具日志可展开。Remote Monitor 接收插件的
`agent-event`，记录方法、耗时和裁剪后的参数/结果元数据，不保存截图编码。
Monitor 只在 Remote 内部端口开启，生产默认关闭。

## 新增浏览器动作

1. 在 `utils/commands.ts` 定义执行参数与校验规则。
2. 在执行器或页面动作实现中加入行为，并检查范围和导航中断。
3. 在 `utils/tool-catalog.ts` 写明参数、约束与示例。
4. 在 `utils/browser-loop.ts` 的决策动作列表加入该动作；按行为更新批次约束。
5. 更新步骤名称与中英文文案，并验证动作结果、失败与停止行为。

Remote 无需维护第二份动作表。

## 验证

### 诊断和控制权丢失

`utils/diagnostics-schema.ts` 定义插件拥有的语义/隐私白名单；`diagnostics.ts` 管理有界 session 缓冲区、
本地任务关联、epoch 和分页。`diagnostics-runtime.ts` 只记录异常类型及 console 级别，
`diagnostics-panel.ts` 通过可信侧栏和同意令牌发送事件。研究台账与浏览器动作均记录操作结果。
Remote 只负责鉴权、实例关联和有界传输，不复制动作注册表或决定恢复策略。
协议字段和保留上限以 [线路协议](EXTENSION-WEBSOCKET-PROTOCOL.md) 的 diagnostics-v2 节为准。

中途开启诊断会重新建立本地任务关联，并标记 `partialCapture`。这不补造已经错过的开始事件，
也不会把旧 epoch 的迟到结果加入新记录。开关、接收方变更、worker 重启和队列溢出都需回归验证。

控制权丢失与普通观察失败不同：`ControlLoss` 保留当前批次已完成的研究操作和浏览器操作的安全回执，
终止任务，不恢复控制、不重放输入。`PAGE_CHANGED/PAGE_LOADING` 等可恢复观察错误仍返回决策循环；
尚未取得控制的初始选择失败仍保留 reading 模式。细节见 [控制丢失回执](CONTROL-LOSS.md)。
修改这些行为需同时验证真实 Chrome、用户停止/取消、迟到响应、研究前缀和普通只读路径。
改线路字段时同步两仓权威协议文档；Agent 提示词按代码评审，不另建替代开发手册。

```sh
npm test
npm run test:build
npm run test:e2e
npm run zip
```

单元测试覆盖动作参数、页面范围、浏览器循环、传输状态、预览和 UI。
构建检查验证 Manifest、入口与生成代码。
E2E 使用临时 Chrome profile、本地网页和相邻 Remote 仓库，模拟 Agent 决策，验证
实际标签页操作、表单提交、弹窗选择、滚动、图像读取、停止和预览。
不会向用户正在运行的 Agent 投递任务。可通过 `CHROME_PATH` 指定 Chrome for Testing，
`RELAY_ROOT` 指定 Remote 仓库，`E2E_FILTER` 按名称筛选，`E2E_SCREENSHOT_DIR` 保存截图。

## 多浏览器验证

`npm run test:e2e` 包含两份临时 Chrome profile 共用一个 Key 的回归场景：
A/B 分别操作各自页面，拒绝错目标回复，停止和重连 A 不影响 B，重启 A 保留身份。
测试使用实际插件、Remote 和本地网页，Agent 决策由确定性测试输入代替，不接入真实 Agent 队列。
