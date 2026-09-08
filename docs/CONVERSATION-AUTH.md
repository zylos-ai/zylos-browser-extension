# 对话内按需授权

版本：插件 0.9.0 / Channel 0.8.0。Core 无源代码改动。

## 用户流程

直接发送需求即可，不必先勾选或创建标签。普通聊天不会申请控制。Agent 第一次需要浏览器且没有授权时，对话区显示真实的授权卡片，而不是一条要求去设置页操作的文字。

点击“允许并继续”后，在点击所在浏览器窗口新建专用后台工作标签；Channel 向原设备的 C4 会话发送一次续跑事件。用户不需要重新描述任务或发送“继续”。首版卡片默认新建标签；原来“使用当前页面”的操作保留在折叠的手动设置中。授权有效期间复用工作区，完成时仍解除调试、保留工作标签授权。

卡片明确说明会读取网页及截图、发送给已连接 Agent，并且不授权个人其他标签。取消、停止、断线、重载或 5 分钟超时会结束等待。关掉弹窗不会自动同意，重新打开可查看仍有效的请求。发送新需求会取消旧的等待请求。

## 实现

- Channel 为每条浏览器聊天生成 `requestContext`（原聊天记录 ID），随 C4 消息附给 Agent。它不是权限凭证，不能代替点击授权。
- MCP 工具增加可选 `requestContext` 字段；未授权时必须使用当前浏览器对话中的精确值。元数据不会传给 agent-browser。另一设备、过期消息或无上下文的其他渠道，不能借此申请或续跑这条任务。
- 只有执行前拒绝的浏览器调用可以创建请求。MCP 立即返回结构化的 pending 状态，不占用一个等待数分钟的工具调用，不自动重试已执行的操作。
- Channel 保存每设备最多一个内存请求和结果，随机 ID、设备连接、原消息 ID 绑定，5 分钟有效。相同消息重试返回同一请求；拒绝后不会被模型重试重新弹出。服务重启后旧请求失效，不持久化浏览器操作权限。
- 插件收到 `authorization` 消息只绘制卡片。只有精确的 bundled popup/sidepanel 消息可以触发本地授权；双击/多个面板不会重复创建。创建过程中取消会撤销在途授权。
- 创建完成后，插件通过已认证连接发 `authorization-decision`，Channel 核对请求 ID、设备连接、期限、实际工作区的 `controlSessionId`，消费请求后再投递续跑。
- 续跑是明确标记的 Channel 事件，通过现有 `c4-receive.js` 进入原通道；不是伪造用户消息、不是重放暂存点击。Agent 需重新观察，空工作页先导航到用户指定的网站。新需求或停止优先于旧续跑事件。
- 如果 C4 投递失败或结果不确定，显示 `resume-failed`。不会盲目重试投递；用户可检查现状后再发继续。

主要文件：插件 `utils/authorization.ts`、`components/AuthorizationCard.tsx`、background runtime；Channel `src/authorization.ts`、`src/bridge.ts`、`src/mcp.ts`、`src/server.ts` 与 `SKILL.md`。

## 升级与验证

1. 构建 Channel 和插件；更新正在使用的 Channel Skill。
2. 在 Agent 空闲时重启 Channel，并刷新/重启 Agent 的 MCP 会话，使工具 schema 和 Skill 生效。
3. 在原扩展卡片重载 `.output/chrome-mv3/`。保留原配对，不必重新填配对码。
4. 不做手动授权，直接发送新的浏览器需求。新消息应带有 Channel 生成的 requestContext；旧消息没有该字段，不应猜测补齐。

自动测试：插件 `npm test`、`npm run test:build`；Channel `npm test`；完整链路使用独立临时 Chromium、本地页面和模拟 Agent continuation：

```sh
BROWSER_EXTENSION_DIR=/Users/bobo/coco/zylos-browser-extension/.output/chrome-mv3 node test/mcp.e2e.mjs
```

该端到端测试不向日常 Agent 发消息，也不使用个人 Chrome。它验证卡片出现前不创建标签，一次点击触发一次续跑回调，模拟 Agent 随回调自动导航，无需第二条用户消息。真实 Core 的消息消费取决于已启动的 Agent/C4 环境，发布时应再做一次实际会话验收。
