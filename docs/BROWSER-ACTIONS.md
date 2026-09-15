# 浏览器动作：实现与验收

当前插件使用单一侧边栏入口。执行、定位、等待、子 frame 管理均在插件内；Relay
服务和 `scripts/browser.js` 继续转发动作与参数。Agent 的能力说明同步到
`zylos-browser-remote/SKILL.md`。不包含上传、下载或全浏览器控制。

## 实现步骤

1. **统一动作契约**：`utils/commands.ts` 导出 `actionParams`，Remote 和执行器共用。
   保留既有命令格式，增加 `browser-actions-v2` 等能力声明；坐标与 ref 互斥。
2. **共用页面执行层**：`utils/automation/page-actions.ts` 负责元素引用、鼠标键盘、表单与容器滚动。
   页面辅助函数作为插件固定资源打包，不允许 Agent 上传任意 JavaScript。
3. **复杂页面定位**：`frames.ts` 递归处理 Chrome 125+ 子调试会话与同进程 frame，
   ref 绑定 frame、子会话和页面代次。点击坐标换算到顶层视口，检查父 iframe 遮挡。
   Shadow DOM 内的命中检测和焦点判断在元素所属 root 完成。
4. **导航与任务接续**：增加历史导航、刷新、来源明确的新标签归组、弹窗查看与处理。
   弹窗处理可以越过等待队列，避免弹窗阻塞之后无法恢复。逻辑切标签不抢用户焦点；
   通过受控标签的 focus emulation 保持后台页面能处理输入，detach 时释放。
5. **状态与条件等待**：快照包含控件状态；`inspect` 提供值、勾选、禁用、展开、焦点和滚动信息。
   条件在插件本地轮询；普通动作串行，停止/暂停立即打断，丢弃停止前的排队动作。
6. **验证与 Agent 说明**：单元测试覆盖参数、状态和并发；独立 Chrome profile + 本地网页 +
   真实 Relay 验证执行结果。构建产物仍为 `.output/chrome-mv3`。

## 动作参数

命令入口还包括 `open/start/new-tab/switch-tab/tabs/snapshot/observe/screenshot/fill/type/pause/finish/stop/finalize`。

| 动作                                   | 参数与返回                                                                                                                    |
| -------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `click`, `double-click`, `right-click` | `{ref}` 或 `{x,y}`，可选 `modifiers:["Control","Shift","Alt","Meta"]`                                                         |
| `hover`                                | `{ref}` 或 `{x,y}`                                                                                                            |
| `drag`                                 | `{from:{ref}或{x,y}, to:{ref}或{x,y}, steps?:2..60, modifiers?}`；支持鼠标拖动与 HTML drag/drop                               |
| `keypress`                             | `{key, modifiers?, ref?}`；单个字符或 Enter/Tab/Escape/Backspace/Delete/Arrow*/Home/End/PageUp/PageDown/Space。`ref` 可先聚焦 |
| `select`                               | `{ref,values:["option value"]}`；原生 select，多选按 values 设置，触发 input/change                                           |
| `check`                                | `{ref,checked:true或false}`；已在目标状态时不重复点击                                                                         |
| `scroll`                               | `{direction,pixels?,ref?}`；ref 指向具体滚动容器；也可用 x/y 指定滚轮位置；未指定则视口中心                                   |
| `frames`                               | `{}`；返回允许操作的 frame ID、URL、父 frame                                                                                  |
| `find`                                 | `{selector,frameId?}`；CSS 查询穿透 open Shadow DOM，返回最多 100 个 ref 与状态                                               |
| `inspect`                              | `{ref}`；返回实时控件状态，敏感输入值脱敏                                                                                     |
| `back`, `forward`, `reload`            | `{}`；返回 navigating，随后用 wait 确认目标页面                                                                               |
| `dialog`                               | `{action?:"get"或"accept"或"dismiss",promptText?}`；读取/处理 alert、confirm、prompt、beforeunload                            |
| `wait`                                 | `{condition,ref?或selector?,frameId?,text?,url?,checked?,timeoutMs?}`                                                         |

`wait.condition`：attached / detached / visible / hidden / enabled / clickable / checked /
text / url / loaded / new-tab。元素条件需 ref 或 selector；text 条件需 text；url 条件需完整目标 URL，
匹配 URL 且页面完成加载。默认等待 10 秒，最大 60 秒，并受请求总 deadline 约束。
`new-tab` 返回下一个尚未领取的新标签 ID，再由 Agent 显式 `switch-tab`。
跨导航等待优先使用 selector 或 url，旧 ref 不会自动指向新文档中的元素。

## 边界与错误恢复

- 工作标签最多 8 个。新标签必须能由 Chrome 的 opener 信息追溯到当前任务；
  不接管用户无关标签。弹出窗口内的任务新页归入任务窗口。
- frame 中的受限 URL 同样受策略控制。用户当前已有标签仍不提供接管入口。
- CSS 查找穿透 open Shadow DOM；closed root 中暴露到 AX 树的元素可用 snapshot ref 操作。
- iframe 坐标支持普通布局及轴向缩放；旋转、透视 iframe 不保证可操作，检测到时拒绝坐标推算。
- 坐标单位是当前顶层视口的 CSS 像素，不是截图的物理像素。窗口缩放或页面变化后需重新观察。
- `select` 用于原生 select；自定义下拉框组合使用 hover/click/keypress/find。
- `DIALOG_OPEN` 表示操作可能已经触发弹窗。读取并处理 dialog，**不要重新点击触发按钮**。
- `PAGE_CHANGED` 后检查 URL/页面结果；不能据此认定刚才的点击没执行。`STALE_ELEMENT` 用新 snapshot/find 获取引用。
- 只有明确发生在原生 mousePressed 之前的命中变化才会重新定位，最多 2 次；不会自动重放已提交的点击。
- requestId 的成功结果缓存及在途合并均限于当前 worker；CLI 每次运行生成新 ID。
  改变参数复用同一 ID 会返回 `REQUEST_ID_CONFLICT`。这不是跨重启的 exactly-once 保证。
- 上传下载、任意脚本执行、浏览器地址栏与系统窗口快捷键不在本轮范围。

## 验证方式

```sh
npm test
npm run test:build
CHROME_PATH="/path/to/Chrome for Testing" npm run test:e2e
```

端到端测试使用一次性浏览器目录和随机本机端口，默认使用相邻的 `zylos-browser-remote`
作为真实转发服务，可用 `RELAY_ROOT` 指定路径；不访问个人浏览器资料，不发送 C4 消息。
具体用例在 `tests/e2e/browser-actions.mjs`，覆盖本轮六个方向以及停止、失效引用和错误恢复。

## 验证记录

2026-09-15，插件 0.12.0，在 macOS / Node.js 24.18.0 / Chrome for Testing 149.0.7827.55 下验证：

| 验证                     | 结果                                                |
| ------------------------ | --------------------------------------------------- |
| TypeScript 与 Vitest     | 通过，11 个测试文件 / 96 项测试                     |
| WXT 构建与产物检查       | 通过，2 项检查；只有 sidepanel 页面，工具栏无 popup |
| 真实 Chrome + 独立 Relay | 通过，18 个场景                                     |

端到端验证覆盖侧边栏聊天收发、停止按钮、鼠标与表单、容器滚动、同源/跨域/嵌套 iframe、
Shadow DOM、原生弹窗、导航、新标签接续、重复请求、过期引用与暂停打断。
侧边栏测试加载实际构建的 `sidepanel.html`，同时检查工具栏打开侧边栏的配置。
测试使用一次性无头浏览器和本地测试网页；实际网站的自定义控件仍需按页面行为验证。

本地体验用 Coco 根目录的 `Browser-dev.sh` 启动链路，在 `chrome://extensions`
刷新从 `.output/chrome-mv3` 加载的扩展，点击工具栏图标打开侧边栏。
Agent 使用新命令前应读取当前 `browser-remote/SKILL.md`，并用 `info` 查看能力列表。
