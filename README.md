# Coco Browser Extension

WXT + React + TypeScript / Chrome MV3。默认只使用 Zylos remote 接入：
插件通过 WebSocket + key 连接 [zylos-browser-remote](../zylos-browser-remote)，
在侧边栏聊天，在专用工作标签里执行 Agent 的浏览器命令。

使用 WXT 标准命令和默认输出目录：`npm run build` → `.output/chrome-mv3`。
没有构建模式开关，`npm run dev`、`npm run build` 和 `npm run zip` 都使用 remote 入口。

## 本地启动

在 Coco 根目录运行：

```sh
./Browser-dev.sh
```

脚本构建插件，检查通道链接和 key，启动缺少的 C4 / Agent 监控服务，并启动或复用 relay。
`--check` 只检查现状，`--no-build` 复用已有插件产物。

1. Chrome 打开 `chrome://extensions`，启用开发者模式。
2. 加载本项目 `.output/chrome-mv3`。
3. 在插件侧边栏「设置」填写 `ws://127.0.0.1:3802/ext` 和 relay 发出的完整 key。
4. 点击「保存并连接」，在侧边栏向 Agent 发送任务。

后续构建仍使用同一个目录，在 Chrome 扩展页点击刷新即可。
Finder 隐藏点开头的目录，可按 `Command + Shift + G` 粘贴完整路径。

## 从旧构建目录迁移

以前从 `.output-remote/chrome-mv3` 或 `.output-platform/chrome-mv3` 加载的扩展，
需要在 Chrome 中停用旧条目，重新加载 `.output/chrome-mv3`。
加载路径变化可能改变扩展 ID，旧的 Chrome storage 不会自动迁移；在新插件中重新填写
relay 地址和原来的 key 即可。keyId 由 key 决定，继续使用同一个 key 就仍是同一个 C4 endpoint。

如果没有保存原来的明文 key，可在 relay 项目执行 `node scripts/key.js new --label local-chrome`
生成一个新 key；relay 的 keys.json 只存摘要，不能从中取回旧 key。

## 聊天与浏览器操作

- 用户消息：侧边栏 → relay → C4 → Agent。
- Agent 回复：C4 send → relay → 侧边栏气泡。
- 浏览器命令：Agent CLI → relay `/rpc` → 插件执行引擎 → 结果原路返回。
- `utils/remote-commands.ts` 校验命令；URL 黑名单、工作标签归属、幂等回放、密码/OTP 拒填和停用开关由插件执行。
- 第一次 `open` 在用户当前标签旁创建工作标签并分组，之后的命令只作用于任务标签。

协议与错误码见 [PROTOCOL.md](../zylos-browser-remote/docs/PROTOCOL.md)。

## 开发与验证

```sh
npm ci
npm test
npm run test:build
```

`npm run test:build` 会执行标准构建并检查生成的 manifest、页面资源、remote 协议和聊天入口。
`npm run zip` 在 `.output` 内生成发布压缩包。`npm run dev` 使用 WXT 的开发浏览器流程；
测试自己 Chrome 中的登录状态时，使用上面的本地启动和手动加载流程。

## 源码

- `entrypoints/background/index.ts`：唯一后台入口，启动 `remote.ts`。
- `entrypoints/background/remote.ts`：连接、心跳、聊天、命令分发。
- `components/RemotePanel.tsx`：聊天、设置、任务状态和停止按钮。
- `utils/remote.ts`：relay 协议和存储结构。
- `utils/remote-commands.ts` / `utils/guard.ts`：命令校验和 URL 策略。
- `utils/automation/`：任务标签、CDP、鼠标轨迹、模拟光标和清理日志。

`docs/specs/openmax-browser-connector/` 是旧平台接入的历史设计与验证记录，不是当前启动指南。
