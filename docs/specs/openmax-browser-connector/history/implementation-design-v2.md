# Browser Use V2：实施设计与代码对应

版本 2.0 · 2026-09-09 · 分支 `codex/browser-platform-v2`

本版以用户确认的《browser use 插件设计方案评审（修订版）》为准，替代本文件 v1.1。
评审稿描述目标产品；本文描述实现契约、代码落点、验证和生产化缺口。
旧 Notion、旧 design.md、早期直连图若与本版冲突，以修订评审稿和本文为准；本轮未修改 Notion。

## 1. 一句话说明

**用户在 OpenMAX 连接浏览器并私聊 Agent；授权在聊天里完成；平台中转控制指令，
插件在任务专属标签中操作，结束清理后回原对话。**

两种权限分开：

- 连接登记：记录“本浏览器 profile 安装属于谁、哪个工作区、可供哪个 Agent 使用”。
  插件保留设备身份，不获得永久网页操作权限。
- 本次任务允许：由登录用户在原聊天点击，平台绑定当前浏览器并批准此任务。
  结束、撤销、过期或上下文丢失后不能继续操作。

插件在线和 Channel 预连接都不等于任务授权。没有 MCP，没有独立插件聊天。

## 2. 仓库边界

| 仓库 | 当前职责 | 本轮 |
| --- | --- | --- |
| zylos-browser-extension | WXT/React 执行插件、身份握手、任务准备、标签/CDP/光标/清理 | 重构，去掉 standalone 入口 |
| zylos-browser-channel | CLI、平台连接、agent-browser 引擎和私有 CDP relay | 重构，要求可信 context |
| zylos-openmax | 私聊来源索引、平台 broker、C4 续跑和最终回复门禁 | 更新就绪语义和收尾等待 |
| cws-fe | Connections 接入、Agent 选择、对话允许/继续/停止 | 更新网页流程 |
| cws-connect | 设备登记、真实身份/来源验证、任务状态、回执、outbox | 更新本地业务实现 |
| cws-comm | 浏览器专用 WS、预连接与定向控制转发 | 更新本地 transport |
| cws-core | 现有平台身份、成员、消息 API；正式 Browser BFF 的归属 | 本轮无业务代码变更 |
| zylos-core | 推理循环及原 C4/SQLite | 不修改 |

七个有旧改动的仓库已切到同名新分支；zylos-core 不需要改动。
原未提交内容备份在 `/Users/bobo/coco/browser-v2-baseline-mmfiZw`。
分支只隔离后续工作，原 dirty 内容并未凭空成为 commit；本轮没有提交或推送。

## 3. 三条链路

```text
聊天：
OpenMAX → 平台聊天 → zylos-openmax → C4 / SQLite → Agent
Agent → C4 → zylos-openmax → 平台聊天 → OpenMAX

授权：
聊天网页读取当前插件身份证明（只读）
→ 网页将“允许”提交平台 → 任务 preparing
→ cws-comm 推送准备事件 → 插件确认上下文 → running
→ zylos-openmax 认领本次激活 → C4 通知 Agent 继续

执行：
Agent → 我们的 CLI → Channel → agent-browser / 私有 CDP relay
→ cws-comm 浏览器专用中转 → 插件 chrome.debugger → 本任务标签
结果沿工具调用返回 Agent，不进入聊天队列
```

首个 open 是例外：没有标签可供 agent-browser/CDP 连接时，Channel 发受限 bootstrap，
由插件直接创建请求 URL 的工作标签；以后操作继续使用 agent-browser。
这不是第二套聊天协议，也不是让模型运行任意插件代码。

## 4. 首次连接与登录

1. 用户在 Connections 点“连接”，进入平台的浏览器连接页。
2. 平台未登录时走已有登录/注册和工作区选择；不再实现一套插件账号系统。
3. 网页通过已配置的扩展产品 ID 向同一浏览器 background 发 `browser-binding-start`。
4. background 生成 profile installation ID（已有则复用）、随机 verifier、challenge 和 nonce。
   verifier 只留后台；只把公开握手参数交回网页，不创建工作标签。
5. 用户在网页选择有权使用的 Agent 并确认；平台核验真实账号/组织/Agent，签发一次性绑定码。
6. 网页把绑定码和 nonce 交给原来源 tab 的 background；后台校验来源及 Agent，
   携 verifier 兑换，保存设备凭据，建立出站 WS，回报 bound。
7. 网页展示已连接，用户无须再打开 Popup 或批准第二次。

原插件“登录并连接”按钮仍可作为连接页入口，但不是必经步骤。
首次安装失败给出安装指引。当前本地构建显示加载目录；正式商店条目尚未发布，
不能编造商店地址。正式包应配置官方扩展 ID 和商店链接。

凭据边界：

| 值 | 保存/用途 |
| --- | --- |
| 平台登录 token | 现有网页登录体系；不发送给插件 |
| installation ID | 标识本 profile 的本次安装，不是硬件或用户身份 |
| 绑定码 + verifier | 一次性登记握手；平台只存码哈希，后台持有 verifier |
| 设备凭据 | background 的受限 storage；平台存哈希和有效期 |
| 当前设备证明 | 30 秒、任务/版本/设备/来源关联；只用于平台核验当前浏览器 |
| WS ticket | 单次短期换票；角色与任务隔离，不是允许操作 |
| context | Agent 主机私有消息索引；不是权限令牌 |

替换仍有效的已有安装绑定时，兑换请求还必须携带 background 持有的旧设备凭据；
仅知道公开 installation ID 不能覆盖或撤销别人已有绑定。

短期证明采用进程内签名密钥，服务重启后失效；没有恢复旧授权的后门。
生产需持久密钥轮换/实例一致性，不把本地签名密钥模式直接横向扩容。

## 5. 对话授权和启动

任务创建基于真实原 DM：平台核验 org、发送者、会话参与者、Agent 和消息版本。
一个来源消息只对应一个任务；创建时 device_id 可为空，不先选择“第一个在线设备”。

- 卡片出现时 Channel 可申请 task-scoped 预连接。只允许心跳/同步，无设备观察或 CDP。
- 用户点击允许/继续时，网页对本浏览器插件发 `browser-device-probe`。
  background 只申请设备证明并记住来源 tab/window；不批准、不创建标签。
- 网页 POST 平台 `/user/tasks/:id/decision`，带 action、revision、operation_id、device_proof。
- 平台核验登录用户、原消息、绑定、在线状态及证明；事务内锁设备/任务，
  将设备绑定到任务，进入 preparing。每设备最多一个未收尾任务。
- outbox 经 Relay 通知 background；插件复查平台任务及来源，保存执行上下文并回 ready。
- ready 后 running 才允许工具，OpenMAX broker 按 activation 认领续跑。
- Agent 首个 open 发 bootstrap；插件先报告 started，再在原窗口紧邻聊天页创建
  **请求的实际 HTTP(S) URL**，展示工作组并接入 CDP。授权阶段没有 about:blank。
- 后续 open 复用选中的工作页。新增工作页后台打开。用户切换其他 tab 不改变执行目标。

当前网页按设备登记列表获取扩展产品 ID，再由本机 background 提供实际设备证明。
该列表不是目标设备选择器；不存在“当前浏览器失败就去操作另一台设备”的回退。

来源 tab/window 消失、被移走、非许可页面或无痕时失败，不猜当前焦点。
若发生断线或超时，只查询状态；不自动重发用户点击或网站副作用。

## 6. 状态和标签生命周期

```text
awaiting_consent → preparing → running ⇄ waiting_user
                                  ↓
                              finalizing → closed
```

| 阶段 | 标签与控制 | 退出条件 |
| --- | --- | --- |
| awaiting_consent | 无工作页、无 CDP | 人工允许/拒绝/5 分钟超时 |
| preparing | 接受任务上下文，仍无新标签 | 插件 ready；30 秒超时 |
| running，未 open | 有任务权限，无页面 | 首个合法 URL bootstrap |
| running，已 open | 任务所有的彩色分组，真实鼠标事件和可视光标 | 完成、暂停或停止 |
| waiting_user | 脱离调试、无光标、保留“等待继续”组 | 对话明确继续；10 分钟超时 |
| finalizing | 拒绝新普通操作，清理/交还页面 | 清理 ACK 或 30 秒截止 |
| closed | 无继续权限；状态留在聊天中 | 新需求必须新消息、新授权 |

运行租约 5 分钟随工具调用续期；绝对任务上限 30 分钟，其他期限不能越过。
插件断线/重启不会静默恢复执行；旧标签无法核验归属时保留并提示。

结束规则：临时任务页关闭；明确保留的结果页退出分组、解除控制；
不保留“已停止/已完成”组；用户原有页不关闭。归属日志记录 task/browser session/
window/group/tab 和 keep 决定，删除前再次检查归属。
准备完成但尚未创建标签也可以正常收尾，不因不存在清理日志而误报失败。

cleanup 为 confirmed / partial / unknown / not_required。无法确认不等于成功，
unknown/partial 会阻止设备被新任务直接复用，需用户处理或重新连接。
C4 出站入库不等于回复已送达。正常最终文字必须等待浏览器收尾；
awaiting_consent/preparing/waiting_user 可以发送明确的等待说明。

## 7. 工具和传输

工具定义与 Agent 使用规则在 Channel：
`src/browser-commands.ts` + `SKILL.md`。仅 status 不需要 context。
不接收网页提供的任意 JS、自选 CDP 端点、Cookie、密码/OTP 或 raw CLI 参数。
agent-browser 原生进程使用 argv 数组和白名单参数，不拼接 shell。

截图返回私有图片路径，Agent 必须再用图片读取工具查看。可视光标来自插件本地代码；
点击轨迹同时通过 CDP 发送真实浏览器输入事件。不是控制 macOS 全局物理鼠标。
现有执行能力复用，没有为架构迁移重写全部定位与截图代码。

浏览器 WS 与聊天 WS 分离，不向同用户的其他聊天连接广播 CDP。
路由以 org/device/task/activation 匹配；消息 ID 关联结果，旧激活和旧租约拒绝。
预连接不能接收缓存的页面状态。运行/收尾前还核验任务期限和当前设备绑定。

平台事件只有在插件应用后 ACK，不能在 socket.send 成功时标记送达。
重复事件重新 ACK，但不重复 ready/bootstrap。状态事件会合并旧版本；
“查看工作页”是尽力通知，若被更高版本覆盖，用户可再次点击，不能用于权限判断。

本地 Relay 单实例、每秒核验 grant 并投递未 ACK 事件；插件心跳/查询当前为 2 秒。
这些是 Demo 的性能取舍，不宣称生产规模的连接数或延迟指标。
原生 agent-browser 自带部分传输恢复；应用不自动重放写操作，不能宣称网站 exactly-once。

## 8. 数据表和本地隔离

业务数据落在 Docker `127.0.0.1:25432/coco_browser_local`，
自动测试使用 `coco_browser_test`。不向测试环境现有数据库新增表或写入新枚举。

| 本地表 | 用途 |
| --- | --- |
| applications / connections / connection_agents | 仅 Browser 的最小连接目录与 Agent 关系 |
| browser_binding_intents | 单次绑定握手、哈希、challenge 和过期 |
| browser_devices | 安装身份、连接、设备凭据哈希、撤销/需处理标记 |
| browser_tasks | 来源、当前设备、source_id、state/revision/activation、期限、清理状态 |
| browser_operation_receipts | task + operation 去重，拒绝同 ID 不同决定 |
| browser_outbox | task + revision 事件及应用 ACK |
| browser_schema_version | 本地 schema 版本 |

前面三张通用表只是在隔离数据库中模拟已有目录模型，不是生产再建一套账号/组织。
组织、成员、Agent、原消息仍经既有 Core API 验证，不复制测试库，也不做跨库 join。
正式接入应复用平台目录表并编写审核后的迁移；不能把 dev/browser/schema.sql 直接上线。

V2 本地变更：task.device_id 可空；新增 source_id、preparing；outbox 新增 delivered_at。
未新增“任务操作码”表；旧内存 task-intent/consume 流程已去掉。
状态更新、幂等回执和 outbox 在一个 SQL 事务内完成。设备唯一活动任务约束仍保留。

## 9. 关键接口

全部为本地 `/api/v1/browser` 下接口；不是已经发布的正式 SDK。

| 调用方 | 接口 | 行为 |
| --- | --- | --- |
| 网页 | POST /bindings | 登录身份+Agent 权限校验，签发绑定码 |
| 插件 | POST /bindings/preview、/redeem | 验证 verifier，兑换设备身份 |
| 插件 | POST /device/ticket | 换取设备 WS ticket |
| 插件 | POST /device/proof | 只读当前设备/来源证明，不改变任务状态 |
| 网页 | GET /user/tasks?conversation_id=... | 本用户、工作区、会话任务 |
| 网页 | POST /user/tasks/:id/decision | approve/deny/resume/stop/reveal |
| Agent broker | POST /tasks、GET /tasks/:id | 基于可信原消息创建/读取任务 |
| Agent broker | POST /tasks/:id/ticket | 等待期预连接或有效运行连接 |
| 插件 | POST /tasks/:id/ready、/started | 准备完成/准备创建页面 |
| Agent broker | POST /tasks/:id/touch、/pause、/finalize | 延期、等待、结束 |
| Agent/插件 | POST /tasks/:id/stop、/cleanup | 撤销/回报清理 |
| Relay 内部 | /internal/browser/consume、/check、/events、/ack | 换票、持续校验、可靠状态投递 |

最外层仍检查真实登录身份或设备凭据，接口白名单按调用角色不同。
浏览器页消息严格限定本地许可 origin、具体路径、顶层、非无痕和来源 tab。
设备探测返回短期证明，不返回设备长凭据、平台 token 或可执行 CDP。

## 10. 本轮已经移除和保留

移除：独立插件聊天 UI、手填 Agent URL、配对入口、旧 requestContext 授权控制器、
插件 approve/resume 按钮、网页操作码交给插件执行、Channel 文本回复服务、
旧模式入口及只验证旧模式的集成脚本。

保留：WXT 常规目录、React 状态面板、原生鼠标/截图、task-only CDP、敏感输入限制、
source context、角色/设备/任务校验、操作回执、过期、停止、标签归属清理。
旧集成测试的浏览器执行回归迁到 platform-cli.e2e；安全测试不因删旧模式而全部删除。
安装组件名称和 CLI 旧别名暂保留识别已有部署，不保留旧运行路径。
源码已删文件可从基线备份恢复；用户 Chrome 数据及既有本地绑定未清空。

## 11. 验证与尚未交付的内容

已验证：

- 插件类型检查、96 项单元/标签/UI/协议测试与 MV3 构建。
- Channel CLI/IPC/CDP/截图/安装与平台预连接测试。
- Go 鉴权/来源/状态机/HTTP/Relay 定向转发测试及 race。
- 独立真实 PostgreSQL：绑定兑换、来源幂等、设备串行、准备/就绪、ACK、暂停激活和撤销。
- FE 真实 hook/API 请求体测试、类型检查；浏览器 E2E 覆盖绑定、允许、设备错误和 ACK 丢失。
- 临时 Chrome + 真正打包插件 + 原生 agent-browser CLI：
  当前浏览器登记、准备无空白页、首个 URL、snapshot、输入/可信鼠标点击、
  密码保护、截图、个人页隔离、明确继续、保留结果和组/调试清理。

最后一项使用平台身份/存储/中转测试替身，不能代替真实账号全链路。
旧版曾经成功的真实用户 Demo 不能算新版验收。不会静默用真实 Agent 发送测试任务。

仍需完成/验收：

1. 正式 Core BFF、Connect/Comm 服务装配、OpenAPI/typed SDK、正式数据迁移。
   目前 FE 浏览器 API 是 local-only contract 经既有 coreFetch 的开发例外。
2. 生产 HTTPS/WSS、官方扩展 ID/商店入口、生产 origin/回调配置。
3. 多实例路由、共享票据/证明密钥、背压/帧限流、资源与日志保留。
4. C4 续跑的可靠 outbox/投递状态；当前 activation 单次认领后 ACK 不明不自动重放，
   避免重复执行，但仍可能需要人工恢复。任务状态 ACK 已实现，不等于 C4 ACK 已可靠化。
5. 真实账号全链路复验、真实登录等待、断网/重载/停止竞态和云端仅出站验收。
6. 商店权限、远程执行/evaluate 边界、隐私/敏感信息与第三方站点兼容专项。

这些不是“改完 Demo 即生产可上线”的承诺。多浏览器选择不在首版范围。

## 12. 启动、版本与回退

在 Coco 根目录运行 `bash dev.sh`；脚本构建唯一平台插件，
设置本地扩展 ID，检查 Browser API schema 2 / Relay protocol 2 / Channel protocol 2。
已有旧版本不会被静默当作新版本复用，也不会自动中断运行任务。

升级时先结束浏览器任务、退出旧本地启动终端，再启动新 API/Relay/FE；
确认已安装 zylos-openmax 副本同步本分支文件后重启对应两个适配服务，
最后在 Chrome 原目录重载 .output-platform/chrome-mv3。
不重启无关 Channel、不清空 Docker volume、不改 shared DB。

本轮代码/构建已更新；没有自动对用户现用服务或 Chrome 做整套重启与账号重新绑定。
安装副本不同于源码仓库，不能把“编译成功”当“线上进程已经使用”。

回退时先停止任务，按备份恢复相互兼容的各仓库与对应安装副本/构建；
本地新增字段可保留，不能通过清空数据库回滚。
旧 .output 产物未自动删除，不应与新版平台服务混用。
