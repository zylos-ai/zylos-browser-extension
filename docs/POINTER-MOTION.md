# 原生鼠标轨迹（0.8.1）

## 改动范围

生产改动只在浏览器插件。`utils/automation/pointer-motion.ts` 统一处理 MCP 转发与插件原生命令的鼠标事件；`executor.ts` 负责授权、页面状态和 CDP 发送；`injected/cursor.js` 绘制不接收点击的可视光标。Core、Channel 业务代码、MCP 工具定义与权限均不变。Channel 的 MCP 端到端测试增加了网页事件断言。

## 执行方式

- 在插件 Service Worker 内生成直线路径，用 smoothstep 调整速度，计划时长 100–320ms，约每 16ms 一个采样点；实际耗时受浏览器负载影响。不加入随机抖动、绕路或额外点击。
- 每个采样点先发送 `Input.dispatchMouseEvent(mouseMoved)`，成功后将图标放到同一坐标；不再为鼠标操作播放一段独立的 CSS/Web Animations 移动动画。
- 首次鼠标操作在视口右下方建立 Agent 自己的起点，不读取或推测用户的物理鼠标位置。后续从上次实际发送的位置继续；导航、重新授权等失效操作重置该状态。
- 到达后发送原始按下事件，松开原样发送且不补移动，避免把点击变成拖拽；保留按键修饰符、按钮状态、滚轮参数。鼠标命令在本地排队，避免轨迹交错。
- 浏览器负责向页面派发 mouse / pointer 事件和更新 `:hover`。这不是页面脚本的 `dispatchEvent()`，也不是系统鼠标控制。
- `prefers-reduced-motion` 开启时取消渐进移动，仍发送实际移动事件。输入/键盘动作的提示仍沿用已有反馈逻辑；本次不把 fill/type 改成逐字模拟键盘。

## 安全和边界

每次 CDP 发送前后检查授权、任务标签、截止时间和页面版本，并在发送前重新读取标签所属任务组。停止、关闭/移出任务标签或导航后，不继续向旧坐标发送输入。鼠标操作不切换用户的前台标签。

按下命令需要补移动时，对移动前后目标坐标做原生 DOM 命中检查；目标节点/框架变化则返回 `ELEMENT_CHANGED_DURING_MOVE`，不按下、不自动重放。此检查不是对目标语义的证明，也不保证覆盖上游独立 move 与 press 两条命令之间的所有布局变化；Agent 仍需重新观察并确认操作结果。

网页可能节流或合并移动事件，不能保证所有页面每个监听器都收到每一个采样点。后台标签也可能节流动画。画得更自然、输入事件由 Chrome 产生，不意味着不可检测，更不保证解决某个站点的风控或 `about:blank` 问题。新增的悬停本身可能展开菜单，Agent 应根据新页面状态继续决策。

## 验证

插件内执行：

```sh
npm test
npm run test:build
```

覆盖轨迹边界、终点、减少动态效果、单次按下/松开、事件/图标坐标一致、按钮和修饰键、并发顺序、超时/停止/导航取消、目标变化、工作标签隔离。

完整链路在独立 Channel 项目执行（使用临时浏览器配置及本地模拟网页，不访问个人 Chrome）：

```sh
BROWSER_EXTENSION_DIR=/Users/bobo/coco/zylos-browser-extension/.output/chrome-mv3 node test/mcp.e2e.mjs
```

实际网页断言包括：多个不同位置的 `mousemove`、`pointermove`、目标 `mouseenter`、CSS `:hover`、`isTrusted` 为真，且目标仅收到一次 `mousedown → mouseup → click`。同时回归截图、工作标签隔离、密码拒绝、finish/stop 和聊天链路。

## 使用新版

在 Chrome 扩展管理页，对原来从 `.output/chrome-mv3/` 加载的 Coco 插件点击重新加载。不要删除后重装；配对保留，操作授权会撤销，需要重新授权工作标签。版本显示为 0.8.1。无需重启 Agent、Core 或 Channel。
