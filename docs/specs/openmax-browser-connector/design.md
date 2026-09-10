# 技术设计：网页登录、设备绑定与浏览器执行

> 历史初稿，已被 [完整实施设计 v1.0](implementation-design.md) 替代。下文保留早期讨论背景，其中“缺少 cws-comm 源码”等判断已经过时，不作为实施依据。

状态：提案，2026-09-08。所有标记“新增”的字段、接口和通道都尚未实现；名称可在协议评审时统一，但安全边界不能省略。

## 1. 范围与现状

当前插件 0.10.1、Channel 0.10.0 使用独立配对、插件聊天、CLI 和本地 CDP relay。旧模式已分别保存：

| 仓库 | 保存分支 | 基线提交 | 设计所在分支 |
| --- | --- | --- | --- |
| zylos-browser-extension | `codex/baseline-plugin-chat` | `9b188d3` | `codex/openmax-browser-executor` |
| zylos-browser-channel | `codex/baseline-plugin-chat` | `e12e92e` | `codex/openmax-browser-executor` |

新模式将入口改为 OpenMax DM，不重写浏览器执行引擎、不增加 MCP、不另建 Gateway 项目。第一版统一平台中转；公网直连保留为后续 transport 适配，不在首版同时维护两套产品流程。

已有 Connections 的 `credential_mode=direct/proxy` 指凭据使用方式，**不是 Agent 公网／内网连接方式**。浏览器不能伪装成一个普通 API Key Connector 来跳过设备授权。

## 2. 登录／注册：复用网页登录，插件领取设备身份

### 2.1 用户流程

网页先登录与插件先安装都进入同一个流程：

1. 用户在 Connections 点击“连接当前浏览器”；或者在未绑定插件点击“前往 OpenMax 连接”。
2. 未登录则进入当前环境的 Logto 登录／注册页。复用现有网页 SDK、回调及 `/auth/logto/onboard`，不在插件中收集密码。
3. 新账号完成邮箱验证；平台建立或匹配 identity。没有工作区时，走现有创建／加入工作区流程，然后返回浏览器连接页，不自动创建额外工作区。
4. 在当前工作区连接个人浏览器。没有可用 Agent 时可先绑定，显示“待选择 Agent”，不触发自动购买／创建 Agent。
5. 插件显示服务端确认的账号、工作区、设备名称，用户确认后完成绑定。网页再复用现有 Agent 授权选择器。

现有 `LogtoOnboard` 校验 API access token、应用 ID token、相同 subject 与已验证邮箱。浏览器连接只复用成功登录后的身份；不以 URL 中的 `app_id` 或前端传入的 member ID 代替认证。

登录后的返回位置用受控的站内流程标识保存；沿用 OAuth state 校验，只允许白名单站内路由，禁止任意 `return_url` 跳转。

### 2.2 网页与插件的绑定握手（新增）

采用允许域名的网页消息通道。Chrome 支持网页通过 `externally_connectable` 和 `runtime.sendMessage(extensionId, …)` 向指定插件发送消息；这是绑定引导接口，不开放浏览器操作能力。[Chrome 官方消息文档](https://developer.chrome.com/docs/extensions/develop/concepts/messaging#external-webpage)

1. 插件后台生成一次性随机 `verifier`，保留在后台；向网页返回其 `S256 challenge` 和本次 `nonce`，不返回 verifier。
2. 网页携带现有登录态请求创建绑定意图。服务端从认证主体获取账号和工作区，绑定 challenge、nonce、预期插件 ID 和个人归属，返回短期一次性 code。
3. 用户在网页选择 Agent 并确认连接，再将 code、nonce 和所选 Agent 交给插件后台；无须回到 Popup 确认。
4. 插件仅访问打包配置中的平台地址，用 code 与 verifier 校验预览和所选 Agent，然后兑换受限设备凭据。后台验证发起页面、nonce、有效期并对重复交接去重。
5. 插件保存凭据并自动连接，向网页回传绑定结果和当前连接状态，不返回设备凭据。绑定不等于任何一次任务的操作授权。

建议绑定意图有效期 2 分钟；刷新或重复提交必须幂等，跨账号、跨工作区、challenge 不匹配、过期和已消费的 code 均拒绝。短期 code 不放查询日志、分析埋点或聊天消息中。

该握手防止凭据通过网页传递和 code 被截取后直接兑换，**不等于对插件安装来源或用户电脑的硬件级认证**。仍须精确校验网页 origin、消息结构和用户确认。

正式版只允许指定 OpenMax origin 和平台 API；localhost 仅进入开发构建配置，不使用 `<all_urls>`。外部网页消息只允许探测版本、绑定和查询本次绑定结果，禁止 CDP、任意 fetch、读取 token、任意标签操作。

### 2.3 凭据与退出

| 凭据 | 放在哪里 | 权限 |
| --- | --- | --- |
| OpenMax 用户登录令牌 | 现有网页认证模块 | 原有平台用户权限，不复制到插件／Agent |
| 浏览器设备凭据（新增，可轮换与撤销） | 插件后台；服务端存校验摘要 | 仅本设备连接、接收本设备授权请求和回报状态，不可读聊天或申请任意用户任务 |
| 浏览器 WSS 票据（新增，短期单次） | 插件或 Channel 内存 | 限定设备／Agent 角色、组织、用途和版本，不是普通聊天票据 |
| Agent 平台凭据 | 现有 zylos-openmax 配置 | 由 OpenMax 适配器代办准入与换票，不再复制一份到 Browser Channel |

插件持久化凭据使用 `storage.local` 并限制为 `TRUSTED_CONTEXTS`；短期票据只保存在后台内存／session。不使用 storage.sync，不向 content script 或 React 页面返回原始凭据。Chrome 提供访问范围控制，这不应被描述为系统钥匙串或加密保险箱。[Chrome storage 文档](https://developer.chrome.com/docs/extensions/reference/api/storage)

关闭网页不解除设备绑定。明确从当前网页登录退出时，先调用当前绑定的撤销／停用接口，再完成网页登出；离线失败要明确显示“未确认解除”，插件重连后必须重新校验。远程解绑以服务端状态为准，不能只删除浏览器本地 token。

切换账号或工作区不静默改绑；新绑定前提示并停止旧任务。首版一个 Chrome profile 只启用一个账号／工作区绑定，避免任务误投。

如果以后必须让插件脱离 OpenMax 网页独立登录，再接 Logto 的 Chrome 扩展客户端、回调和独立 client ID；当前版本无须因此增加第二套登录流程。[Logto Chrome 扩展文档](https://docs.logto.io/quick-starts/chrome-extension)

## 3. Connector 与状态归属

建议在现有 cws-connect 体系新增 `provider_type=browser`、`credential_mode=none`，工具类型仍为 `cli`。`none` 只表示没有交给 Agent 的第三方服务凭据，不表示设备无认证。必须同步数据库 CHECK、领域枚举、RPC／OpenAPI、SDK、FE 和 zylos-openmax 消费逻辑。

复用 `connections` 的个人归属与 `connection_agents`；不向 Agent 下发设备 token。浏览器 Connector 的通用 credential acquire／普通 conn.invoke 路径明确拒绝，并提示改走浏览器 CLI。连接事件消费者对 browser 分支只更新能力索引和状态，不执行 direct 凭据缓存逻辑。

建议新增的数据职责：

| 数据 | 权威存储／职责 |
| --- | --- |
| 浏览器绑定、设备凭据摘要与版本 | cws-connect PostgreSQL：`browser_devices`，关联 connection；记录 profile 安装标识、协议版本、撤销时间 |
| 短期绑定意图 | cws-connect PostgreSQL：`browser_binding_intents`，challenge、过期时间、消费状态；定期过期清理 |
| 浏览器任务 | cws-connect PostgreSQL：`browser_tasks`，关联真实消息、用户、Agent、设备、授权状态、lease epoch、终态和清理结果 |
| 在线路由、短期票据、连接租约 | cws-comm／Redis，过期即不可路由；online 不是永久授权状态 |
| 当前 CLI／引擎、待返回结果、消息上下文映射 | Browser Channel 私有运行目录和内存；重启只恢复识别与清理，不恢复操作权限 |
| 任务创建的 Chrome tab/group ID 与归属记录 | 插件本地；只有插件能确认真实标签存在、归属和清理结果 |
| 用户聊天记录与 Agent 待投递消息 | 平台原有消息存储和 Agent 原有 C4 SQLite；不存 CDP 帧和截图正文 |

约束：同一连接的 Agent 授权唯一；同一设备最多一个非终态任务；同一来源消息／Agent 的创建请求幂等。绑定消费、任务状态转换用事务及版本条件更新，不依靠“先查再写”的应用判断。跨数据库 ID 不建外键，创建时通过服务校验。

撤销先持久化并提高凭据／租约版本，然后通知中转和插件。现有连接事件通知为 best-effort，不能单独承担安全撤销；需要可靠重投机制及短租约重新校验兜底。离线设备只能在恢复后清理，不能声称服务端能立即删除离线浏览器的标签。

## 4. 从 OpenMax 消息到浏览器任务

### 4.1 聊天保持原路

网页消息经 cws-core／cws-comm 到 zylos-openmax，后者调用 `c4-receive --channel openmax`，进入原 c4.db 再由 Dispatcher 投递 Agent。Browser Channel 不再次把相同需求入库。

zylos-openmax 在收到并核验真实 DM 消息后，注册不可变的来源记录：`orgId / conversationId / messageId / requesterMemberId / agentMemberId`，产生 opaque `contextHandle`。只有 handle 作为工具路由提示交给 Agent，原始正文仍是不可信用户内容。

记录通过受限本机 Unix socket 与 Browser Channel 关联；不使用全局“最近一次聊天”或按设备覆盖的 `latestRequest` 代替消息级上下文。CLI 的 handle 只是索引，不是授权凭据。

### 4.2 首次调用与平台准入（新增）

1. Agent 判断需要浏览器，调用 CLI，携带 contextHandle。纯聊天不创建浏览器任务。
2. Channel 请求 zylos-openmax 的受限本机适配接口，由后者用现有 Agent 身份请求平台任务准入。
3. cws-core 从平台读取真实消息及会话，核对消息所属组织／会话、发送者是有效的人类成员、私聊对象与当前 Agent 一致；不直接信任用户可写的 `metadata`。
4. cws-connect 核对连接属于该发送者、当前 Agent 仍被授权、设备在线且空闲。首版只接受本人 DM，多设备必须选择，不能随便取第一个。
5. 创建 `awaiting_consent` 任务，经专用通道推送到该设备；CLI 返回“等待授权”，这不是浏览器操作成功。
6. 用户在插件允许，插件创建并登记专用工作标签。平台收到一致的任务／设备确认后授予有限期操作租约。
7. 授权结果经 zylos-openmax 投递带 task ID 的 OpenMax C4 续跑事件，Agent 重新观察并执行，**不重放导致授权弹窗的原命令**。

插件创建工作页后，如果任务已撤销、授权确认失败或租约未签发，禁止附加调试执行，并安全清理刚创建的临时页。连接事件、租约与用户确认必须属于同一任务版本，不能把旧确认用于新任务。

当前 C4 收件内容可以携带结构化文本提示，回复 endpoint 可由 Channel 解释；预计不改 zylos-core 表结构或推理循环。真正的权限判断必须落在平台与插件，不能仅靠 Skill 提示。

### 4.3 本机适配接口边界

zylos-openmax 提供“登记来源、请求任务准入、换取 Channel 票据、发布状态、投递续跑”这些限定动作。它持有平台身份，不暴露任意 HTTP 代理或读取 API Key 的接口。

Browser Channel 保留私有 CLI socket、agent-browser 引擎与 CDP relay。引擎只连接本机受限 relay，不暴露 CDP 监听端口。两项目不合并，也不把 agent-browser 搬到用户电脑。

两组件运行在同一受信任 Agent 主机上。该设计不防御已经被攻破的同 UID 进程，也不等于多租户 OS 隔离；不同客户运行时仍应沿用平台现有隔离边界。

## 5. 内网 Agent 如何通信

### 5.1 首版选择：统一中转

插件主动连接公网 `cws-comm` 浏览器端点；Agent 侧 Channel 主动连接同一中转服务。服务端按已认证的组织、设备、任务和角色配对双向路由。Agent 不需要公网 IP，用户电脑不需要本地服务或开放端口。

建议独立 `/browser-control/ws` 端点，复用 cws-comm 的部署、鉴权基础设施和在线路由能力，但不复用普通聊天的 seq、历史同步、离线重放及广播语义。准确实现仍须拿到 cws-comm 源码后确认。

协议应区分：设备上线、任务授权／继续／停止、CDP 命令、CDP response/event、清理确认、心跳和错误。CDP 是 Channel 与插件之间转发的协议，真正对 Chrome 的调用由插件 `chrome.debugger` 执行。

每个执行包至少携带版本、taskId、deviceId、leaseEpoch、requestId、帧类型、截止时间和 payload。服务端从票据确定路由，不允许客户端通过改 orgId／deviceId 自选目标。事件与 response 要保留 CDP session/target 对应关系，不能当成普通聊天字符串拼接。

### 5.2 可靠性与停止

- 每设备串行执行；限流、限包大小、有界队列。截图体积超出单帧限制时走专用分块通道，约束总量和组装超时，不进入聊天历史或无限堆内存。
- 推荐初始心跳 20 秒、租约 60 秒，需在 MV3 实机和网络压测后调整；连接在线不能无限延长已失效的授权。
- 停止／撤销有独立高优先级路径，不能排在截图或长工具调用后面。插件本地停止先阻止后续 CDP 并解除调试，再尽力通知平台。
- 断线先禁止执行，重连换新票据、提高 lease epoch、重新核对任务状态；不恢复旧动作队列，不自动恢复旧授权。
- requestId 去重只能减少已识别重复，不能保证网页副作用 exactly-once。上游 agent-browser 也可能重试；传输不确定时使旧租约失效并报告“执行结果待核实”，不得自动重复提交／发送。
- 平台租约过期、成员离开、Agent 授权撤销、设备解绑均拒绝新命令；短租约用于限制通知丢失后的失效窗口，不宣称瞬时全球一致。

后续公网直连只替换传输适配器，同样要求平台任务准入、受限票据、授权卡和标签归属检查。不得回退到“填任意 WSS 地址和长期配对码”。

## 6. 标签、暂停和最终回复

任务状态：`awaiting_consent → running ↔ waiting_user → finalizing → completed / stopped / failed`。拒绝／授权超时直接终止，不创建工作页；清理未确认时另记 `cleanup_pending`，不能标为已完全清理。

| 场景 | 页面与授权 | OpenMax 行为 |
| --- | --- | --- |
| 正在授权 | 不创建工作标签、不附加 debugger | 显示等待浏览器授权 |
| 已授权执行 | 只操作本任务登记的彩色分组页面；切换焦点不换目标 | 显示进行中，可停止 |
| 需要登录／确认 | 显式 pause，解除调试和光标，保留页面“等待继续” | 显示原因与继续按钮，不视为任务完成 |
| 用户继续 | 只接受绑定用户对该任务的明确操作；核对页面仍存在并重新观察 | 发去重续跑事件，不重复入库原始请求 |
| 完成或停止 | 关闭归属确认的临时页；用户明确保留的页退出分组；释放调试、光标与租约 | 确认收尾后返回结果，不留“已完成／已停止”组 |
| 暂停超过 10 分钟／重启／断连 | 终止旧授权，按本地归属安全清理；无法确认归属不强删 | 如实显示中断或待清理；新的操作需要重新授权 |

这是显式 `pause`／`resume` 能力，不是 CDP `evaluate` 自己发现“需要登录”。Agent 根据页面观察请求暂停，用户操作才触发继续。不会要求把密码或验证码发给 Agent。

### 回复前的收尾必须迁移

目前 browser-extension channel 的回复适配器有收尾兜底，`zylos-openmax/scripts/send.js` 没有。新模式必须补上任务相关的收尾检查：

1. 扩展 OpenMax 的 reply endpoint 支持受验证的任务 handle（例如新增 `|browser:<handle>` 后缀），C4 仍按原接口传递 endpoint 和正文。适配器用来源记录校验其与会话／消息／Agent 对应关系，不能只信后缀。
2. 普通聊天不受影响；任务的 progress／waiting 状态由结构化状态事件呈现，不通过“每条 Agent 文本都 finalize”来猜任务结束。
3. 正常任务最终回复先调用 Channel finalize，等待插件停止执行并返回清理确认，随后发送 OpenMax 文字结果。已 pause 的任务只允许发送等待说明，不执行正常完成清理。
4. send.js 缺失任务后缀但该来源消息仍关联进行中的任务时，应拒绝模糊的最终发送并要求补充任务信息，不静默绕过；不得影响无关私聊或同会话的新普通消息。
5. 断线／清理失败不能无限等待：进入失败或待清理状态，明确回复未完成的部分，不声称浏览器已收尾。幂等保存收尾和回复状态，C4 重试不得重复执行网页操作。

注意：`c4-send` 在调用 Channel 的 send.js 前记录出站消息。因此 c4.db 的出站记录只说明“尝试发送”，不等于用户收到、浏览器完成或清理成功。任务状态与清理确认才是依据。

## 7. 新增 API 草案

以下路径仅为设计命名。对外经过 cws-core；内部请求传播可信 principal，业务数据主要由 cws-connect 管理，WS 中转落在 cws-comm。

| 接口 | 调用者／作用 |
| --- | --- |
| `POST /api/v1/connect/browser/bindings` | 登录用户创建短期绑定意图；个人归属从认证主体推导 |
| `GET /api/v1/connect/browser/bindings/{id}` | 创建者查询绑定结果，不能读取设备凭据 |
| `POST /api/v1/browser/bindings/preview`、`…/redeem` | 插件以 code + verifier 校验／一次性交换；不凭无认证的 account ID 绑定 |
| `POST /api/v1/browser/device-session` | 插件用设备凭据换浏览器用途的短期票据；校验撤销与版本 |
| `POST /api/v1/browser/tasks` | zylos-openmax 使用 Agent 身份申请；真实消息、归属及 Agent 授权均由服务端复核 |
| `POST /api/v1/browser/tasks/{id}/decision` | 绑定设备提交用户授权结果；绑定当前版本，不接收 Agent 自批 |
| `POST /api/v1/browser/tasks/{id}/resume`、`…/stop` | 已认证的任务发起用户，或限定的绑定设备控制；模型只能 pause／finalize，不能替用户批准或恢复 |
| `POST /api/v1/browser/tasks/{id}/channel-ticket` | 该任务的 Agent 身份换执行侧票据，不返回用户设备长期凭据 |
| `GET /api/v1/browser/tasks/{id}` | 有权限的用户／执行 Agent 查询状态；连接恢复后以此核对，不凭旧 WS 帧恢复 |

连接授权和解绑继续复用 Connections API，增加浏览器设备凭据／任务撤销联动。任务状态回报、cleanup ACK 和心跳定义在专用 WS 协议中，按角色限制可写状态。

HTTP 错误和工具错误应区分 `DEVICE_OFFLINE`、`AGENT_NOT_AUTHORIZED`、`WRONG_TASK_OWNER`、`CONSENT_REQUIRED`、`TASK_BUSY`、`STALE_LEASE`、`EXECUTION_UNCERTAIN`、`CLEANUP_PENDING`。工具返回等待状态不等于成功执行。

## 8. 代码落点与依赖

| 仓库 | 已核对的代码入口 | 计划 |
| --- | --- | --- |
| cws-fe | `apps/web/src/app/(workspace)/connections/page.tsx`、`apps/web/src/app/(auth)/auth/callback/page.tsx`、`apps/web/src/lib/api.ts` | 接入浏览器类别、绑定引导、登录返回和任务状态；沿用权限头和登录管理 |
| cws-core | `internal/transport/http/connect.go`、`message.go`、`internal/app/auth/sso.go` | 新增 browser BFF／准入模块；用户 metadata 不可作为可信授权源 |
| cws-connect | `internal/domain/enums.go`、`internal/app/connection_service.go`、`connection_authz.go`、`internal/adapter/cwscomm/connection_event_notifier.go` | 类型、数据模型、准入、可靠撤销；新增迁移并按项目工具生成契约 |
| cws-comm | 当前缺少服务端仓库 | 独立控制端点、受限设备主体、Agent 路由、票据、租约与协议／SDK |
| zylos-openmax | `src/comm-bridge.js`、`src/lib/message.js`、`src/lib/connection-events.js`、`scripts/send.js` | 可信消息上下文、本机受限适配器、browser 连接事件、续跑和收尾 |
| Browser Channel | `src/server.ts`、`src/bridge.ts`、`src/authorization.ts`、`src/browser-runner.ts`、`src/cdp-relay.ts` | 从旧聊天入口解耦，新增任务级上下文和平台传输；保留引擎白名单与 argv 调用 |
| Extension | `components/App.tsx`、`AuthorizationCard.tsx`、`entrypoints/background/runtime.ts`、`wxt.config.ts` | 绑定 UI、平台会话、受限网页通信与状态界面；复用既有执行及清理逻辑 |

Go/TS SDK 在当前项目中有不同版本：Core 的 comm Go SDK 为 alpha.62、Connect 为 alpha.47、FE 的 realtime TS SDK 为 alpha.50。新增协议必须明确兼容能力协商与生成／发布版本，不能假设各仓库已经对齐，也不要直接编辑生成代码。

Browser Channel 的工具使用 Skill 会随新 CLI 更新，明确从 OpenMax handle 获取任务，不再要求插件聊天产生 requestContext。这里只列计划，本次未修改 Skill 或 Agent 安装配置。

## 9. 本地联调与缺口

已检查 `/Users/bobo/coco/LOCAL-DEV.md` 和 `dev.sh --check`：现有脚本默认本地启动 FE、Core、Connect；PostgreSQL、Redis、Comm、AgentManager 等通过端口转发使用共享 `cws-int`。这不是完整的纯本地环境。

当次检测：网页 3000、Core 8080、Connect 18080 无法连接；Channel 3460 健康检查返回 200。没有发送真实 Agent 任务、执行登录注册、启动服务或迁移数据库。Composio API Key 未配置，但本方案不依赖 Composio。

实施前需要：

- 拉取有权限的 cws-comm 源码，并确认 comm/connect/common 协议和 SDK 的生成发布来源；SDK 引用不能替代服务端实现。
- 为 Core、Connect、Comm 使用隔离测试数据库／Redis 命名空间与测试账号。默认不迁移共享测试库；沿用已有凭据加密 KEK，不能重生成覆盖已有凭据。
- 新增可选择本地 Comm 的启动模式：HTTP／WS／RPC 地址对齐、测试域名白名单正确、SDK 版本一致。当前 ws-dev-proxy 会改写 Origin，不能据此证明生产 origin 校验正确。
- 准备开发／测试／正式的配置矩阵：Logto issuer、应用 ID、API resource、回调、网页 origin、插件 ID、平台 API 和 WSS。测试登录环境与正式 `auth.openmax.com` 不能混用令牌或复制错误回调。
- Agent runtime 安装并启用对应分支的 zylos-openmax 和 Browser Channel；构建通过不等于 PM2／已安装 Skill 已切换。只在获准的隔离联调阶段执行切换。

## 10. 发布边界

上线前还要核对 Chrome 商店说明、权限用途、隐私政策及截图／页面数据的告知和保留规则。默认不保存控制通道 payload 到业务日志；任务日志只保留状态、错误类别和脱敏关联 ID。

不能把“用了 Runtime.evaluate”直接等同于必定拒审：Chrome MV3 政策对符合用途的 Debugger API 有明确例外；但例外不覆盖插件里其他形式的远程代码加载，也不免除功能可审计和用户数据要求。需要按实际使用方式审查，不能承诺过审。[Chrome MV3 官方政策](https://developer.chrome.com/docs/webstore/program-policies/mv3-requirements)

安全底线保持不变：未授权不执行、只控制任务归属页面、远程页面内容不作为系统指令、不新增任意 eval 工具、不导出 cookie、不让模型处理密码／OTP、不因网络中转而移除现有 CDP 方法白名单。对付款、消息发送等有外部影响的动作，还须符合用户具体任务授权；绑定设备不是无限行为授权。
