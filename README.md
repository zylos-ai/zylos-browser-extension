# Coco Browser Extension — 用户态平台模式

WXT + React + TypeScript / Chrome MV3。**OpenMAX 是唯一聊天入口，插件只做用户登录、
任务执行和紧急停止。** 默认构建已统一为平台模式，不再打包旧聊天/配对/插件授权界面。

## 用户流程

1. 安装并打开插件，点击登录，进入 OpenMAX **个人主页** `/workspace/account?browser_login=1`。
2. 沿用 Workspace 登录；在个人主页确认当前账号后，background 自动保存独立插件会话，无需回 Popup，也不选择或绑定 Agent。Connections 只负责另行给 Agent 开通 Browser 能力，不是插件登录入口。
3. 私聊 Agent 下达浏览器任务，在对话里允许。
4. 平台中转通知 background 准备任务；此时不创建页面、不连接调试器。
5. Agent 第一次 open 时，在原聊天窗口旁直接打开目标 URL，并标记任务组。
6. 完成时清理临时标签；用户明确要保留的页面退出分组。等待登录则暂停，回聊天明确继续。

登录不等于任务授权。执行端、任务、激活和标签归属校验都保留。
用户切换页面不改变 Agent 的目标。不保存“已停止/已完成”分组。

## 本地开发

```sh
npm ci
npm test
npm run build
npm run test:build
```

Chrome 加载 **.output-platform/chrome-mv3**；build:platform 是同一个构建的兼容命令。
输出路径保留，是为了不改变现有安装 ID。旧 .output 文件不自动删除，但不再更新或使用。
npm run dev 会使用 WXT 开发浏览器，不能拿个人 Chrome profile 作测试副本。

完整本地系统从 Coco 根目录 `bash dev.sh` 启动。必须一起升级 API/Relay/Channel/OpenMAX/FE，
不能将新版插件混接旧服务。插件不直接连接 Agent IP。

## 源码

- entrypoints/background/platform.ts：用户登录交接、平台事件、任务准备、执行与失效处理。
- components/ExecutorPanel.tsx：简洁状态、连接引导、查看工作页和停止。
- utils/platform.ts：平台契约；utils/messages.ts：内部面板来源校验。
- utils/automation/：任务标签、CDP、真实鼠标轨迹、模拟光标、归属清理日志。
- tests/：协议、UI、授权边界、标签生命周期；跨项目真实 CLI 测试在 Channel。

没有独立聊天框、手填 Agent 地址、配对码、手动授权工作标签或 Popup 再批准。
保留已有截图、鼠标、敏感输入保护和工作标签隔离，不重写无关执行能力。

## 实施范围

[完整实施设计](docs/specs/openmax-browser-connector/implementation-design.md)
是本轮代码与评审稿的对应说明。其余早期 docs 保留作历史资料，不作为运行步骤。
当前包仅允许本机开发 origin；商店正式包、生产登录回调、WSS、BFF/SDK、
多实例路由和隐私审查仍需补齐，不能直接发布这个本地构建。
