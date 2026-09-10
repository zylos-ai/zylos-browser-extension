# 授权后未建页即结束：修复与回归

2026-09-10，本地开发链路；不代表正式部署或真实账号任务验收。

## 原因与修复

实测记录中，任务 00:40:47 已授权并进入 running；迟到的授权提示走 `scripts/send.js` 时触发自动 finalize，00:41:03 关闭。期间没有打开工作页。消息发送不应根据发送瞬间的任务状态推断“最终回复”。

- OpenMAX 发送适配器移除自动 finalize。普通／等待／进度消息没有改变任务生命周期的副作用。
- Agent 显式调用 finalize／stop，等任务 closed 后发送最终结果。最终消息端点追加 `browser-final:activation_id`，复用既有 activation；适配器只读检查，不发清理命令。旧 activation 或提前最终回复被拒绝；已关闭但清理部分失败／未知的任务可以如实报告失败。
- 续跑上下文和 Browser Skill 写明进度与最终结果的区别，不靠识别“已完成”等文字猜测类别。未标记消息保留普通消息语义。
- Channel 的 request 在 running 时明确提示执行，在 finalizing 时提示清理，不再误报 closed。
- 插件只根据当前任务的实际控制标签显示“查看工作标签”；仅 ready 时显示“已授权，等待 Agent 打开网页”。

## 验证记录

| 检查 | 结果 |
| --- | --- |
| OpenMAX：`node --test src/lib/*.test.js src/cli/*.test.js` | passed，804 项 |
| Extension：`npm test` | passed，117 项，含类型检查 |
| Extension：`npm run test:build` | passed，3 项构建检查 |
| Channel：`npm test` | passed，19 项，含构建 |
| MV3 + CLI + OpenMAX 回复检查跨仓隔离测试 | passed |

跨仓测试在 Channel 目录运行：

```sh
BROWSER_EXTENSION_DIR=/Users/bobo/coco/zylos-browser-extension/.output-platform/chrome-mv3 \
BROWSER_OPENMAX_DIR=/Users/bobo/coco/zylos-openmax \
node test/platform-cli.e2e.mjs
```

覆盖：授权先到、提示后发仍保持 running；提前最终回复被拒绝但不关闭任务；首个 open 建页；实际弹窗 UI 仅在有页时出现查看入口；点击／输入／截图、焦点隔离、暂停继续、保留结果与清理；显式清理后最终回复检查通过。使用真实构建的 MV3、agent-browser CLI 和 OpenMAX 回复检查函数，但平台身份／消息投递为隔离 fixture，没有向用户真实会话发送测试消息。

本轮另发现一条未纳入默认构建命令的旧检查仍要求 v2 `browser-binding-confirm`：已按当前 v3 契约改为验证 `browser-user-login-confirm`、拒绝旧事件，并纳入 `test:build`。

## 本地生效范围

OpenMAX 安装副本四个文件与仓库一致；已重启本地 zylos-openmax、zylos-browser-bridge，健康检查通过。其他 PM2 服务、账号凭据和数据库未改。扩展已重新构建，用户的 Chrome 仍需重新加载 Coco 才采用新 UI。

真实账号新任务复测：not_run。已关闭的旧任务不自动恢复或重放。正式登录、生产中转及商店审核不在本次修复范围。
