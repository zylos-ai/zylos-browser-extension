# 用户态改造 · 本地实施记录

依据：`review-design.md`、`implementation-design.md` 3.0。用户于 2026-09-09 要求本地实施，并允许暂用本地开发登录；不修改共享测试库结构或生产登录配置。

## 实施顺序

- [ ] Agent 能力开通：Connect 的 browser 类型 → Comm → OpenMAX 确定性安装／核验；不读取用户浏览器凭据。
- [ ] 用户登录：插件独立用户会话，不选择 Agent；本地开发登录明确标识，与正式身份提供方隔离。
- [ ] 在线执行端：Comm 用户态专用连接，区分账号、执行端与连接代次。
- [ ] 任务授权：私聊中批准、只读确认当前插件、临时任务目标、Ready 不建页。
- [ ] 工具循环与清理：复用 CLI/CDP、截图、模拟光标；停止与重连不重放动作。
- [ ] 本地启动脚本、跨服务契约与端到端验证。

## 验收边界

本地开发身份只用于明确标注的本地联调，不得冒充测试环境真实用户或复用未核验的 user_id。
正式 Logto 客户端尚未配置；正式 SSO、商店回调和线上权限隔离标为待联调，不以本地测试通过代替。
每阶段补录实际运行命令与结果；未运行项不标完成。保留旧分支改动及旧数据，不清空设备绑定表。

## 2026-09-09：第一批代码与验证

### 已修改

- `cws-connect`：加入 `browser` 能力类型与空凭据表单契约，补目录迁移 `000061`；安装命令不带设备或用户 token。
- `zylos-openmax`：确定性安装器加入 Browser；复用已安装组件，不强制升级或重启在线进程，检查专用健康响应后才报告成功。
- `zylos-browser-channel`：健康接口补充服务身份和 CLI transport，现有协议仍为 2，不虚报整体已升级到用户态版。
- `cws-connect`：新增显式启用的本地用户登录适配器，Core 校验真实全局 identity，PKCE 一次性兑换独立短期会话。没有选择 Agent、创建长期绑定或复制网页登录 token。

登录实现和边界见 [本地用户登录说明](../../../../cws-connect/docs/browser-local-user-login.md)。

### 已运行

- OpenMAX 安装器测试：59 / 59 通过。
- Browser Channel 测试：19 / 19 通过，TypeScript 构建通过。
- Connect domain / app / Comm commander 单元测试通过。
- 本地登录 usecase / Core adapter / HTTP transport race 测试通过；开发入口编译与 go vet 通过。
- SQL 生成、61 份迁移的静态校验、Go 边界校验通过。未设置共享 `DATABASE_URL`，未对共享库执行迁移。
- 本地 Docker PostgreSQL 中的新目录迁移 Up → Down → Up 通过：使用独立事务内 schema，验证能力记录保留、目录 ID 不变、不影响原有 13 个渠道，测试结束回滚。此项仅验证涉及的两表与 000061，不是完整 61 次历史迁移演练。

### 还未完成，不能当作已交付

- FE 的 Connector 产品入口和插件用户登录 UI 尚未切换；新登录适配器还没有接入 Comm 用户态 WS。
- endpoint/epoch、跨服务预占与任务临时目标还未按 3.0 改造；现有执行 Demo 仍是旧设备绑定机制。
- 安装分支通过的是测试，不代表远程组件注册表／正式包版本、真实 Agent 安装回执已联调。
- 没有重启现有运行服务、覆盖 Chrome 已加载扩展，或更改 dev.sh 默认登录方式。
- 正式 Logto client、生产 Core/Connect/Comm 合约、共享安全存储、C4 可靠续跑与完整真实用户验收仍待完成。
