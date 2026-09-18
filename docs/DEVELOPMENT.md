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

工具说明由插件生成并随请求发送：首轮提供页面摘要和入口动作；选择页面后提供完整参数、
约束和示例。同一轮任务内复用契约，后续只返回新的状态与结果。

## 目录

| 文件                                               | 职责                                         |
| -------------------------------------------------- | -------------------------------------------- |
| `entrypoints/background/remote.ts`                 | WebSocket 握手、决策接收、侧栏状态与执行事件 |
| `utils/browser-loop.ts`                            | 决策校验、轮次、请求去重、任务时限、结束     |
| `utils/browser-round.ts`                           | 顺序执行动作、页面变化中断、稳定等待和观察   |
| `utils/browser-actions.ts`                         | 本地动作参数校验、URL 防护、串行执行与去重   |
| `utils/tool-catalog.ts`                            | 工具参数与给 Agent 的说明                    |
| `agent/decision-guide.md`                          | Agent 决策与任务完成规则                     |
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
插件设置保存完整 Key；Key 不进入聊天记录。

双方必须完成 `agent-loop-v1` 握手后才显示已连接。协议不匹配时给出升级提示，
没有就绪回执时在 10 秒后结束握手。连接替换或协议不匹配不会自动反复重连。

## 决策与执行

Agent 的每个响应属于 `actions`、`done` 或 `blocked`。一个动作批次最多五个动作。
只有已知表单编辑可位于后续动作前；点击、导航、读取和滚动必须位于批次末尾。
整个批次先校验再执行，页面变化时放弃剩余动作并返回实际状态。

插件负责稳定等待和观察，不要求 Agent 预测导航目标或自行添加等待。
模型返回 `done` 后，插件保存回答、结束工具记录、释放控制并保留结果页。
普通聊天不会开启浏览器控制。最多 30 次决策、15 分钟或连续三轮失败后停止。

请求 ID 在插件循环和 Remote 交换层关联。相同决策重试不会重复输入；同一 ID
携带不同决策会被拒绝。断线、停止与 worker 重载不会自动恢复未完成的动作。

## 页面范围与安全

每条用户消息固定当前页上下文。切换浏览器前台标签不会转移正在执行的目标。
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
