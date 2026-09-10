# 实施与验收清单

2026-09-09 · 对应 [完整实施设计 v1.1](implementation-design.md) 的 P0—P4；详细源码依据与本次测试见该文档 §19。Notion 保持目标评审稿，本文件记录实施差距。

勾选仅表示所描述的狭窄事项已具备，没有把部分 Demo 实现勾成整个阶段交付。未勾选项用「部分实现／未实现／待验证／待评审」说明。当前可停在 Demo，不表示要求本轮继续开发。

## P0：契约与环境

- [x] 七个业务仓库与 Comm SDK 生成入口已在本地。
- [x] Browser 开发 API／Relay、Docker 独立库与根目录 dev.sh 已接线，未向共享测试库新增 Browser 表。
- [x] 原聊天版与平台执行版扩展输出目录分离；开发接口有明确本地开关。
- [ ] **未实现**：统一 Browser v1 API／Proto／codec fixture、跨仓生成契约及消费者版本矩阵；当前是手工维护的开发协议。
- [ ] **待评审／配置**：正式 API/WSS 域名、固定插件 ID、既有登录配置权限、数据保留期与发布负责人。
- [ ] **待验证**：双用户／双 Agent、隔离 Chrome profile、多 Relay、仅出站云端 Agent 的可复现环境。

## P1：登录、绑定与 Connections

- [x] 本地绑定流程复用网页登录，网页选择 Agent 并确认后，background 自动兑换、保存绑定；无 Popup 二次确认。
- [x] 绑定码验证 challenge／verifier 与过期／消费状态；设备凭据只交插件。插件校验 origin、nonce 和发起页。
- [x] 明确 DEVICE_AUTH_REQUIRED 时停止本地控制并提示重新连接；存储／网络错误不冒充凭据撤销。
- [x] 已有本地设备列表、解绑 API 与插件状态面板。
- [ ] **部分实现**：正式 Connector 应用枚举、管理 Agent、重命名、在线状态整合；当前是独立本地卡片和精简连接表。
- [ ] **未实现**：正式 Core BrowserTicketService／设备主体、RPC／SDK、正式迁移与凭据版本体系。
- [ ] **待验证**：新账号注册、无组织回跳、跨账号绑定、兑换响应丢失／重绑、生产 origin 与固定 ID。
- [ ] **待评审／未实现**：网页退出时停止任务及保留／解除绑定选项；当前 logout 未联动 Browser。

## P2：对话授权与最小任务回路

- [x] 真实 DM 消息级 context、私有 broker、平台来源复核和设备单任务约束已有代码。
- [x] 私聊任务卡通过单次码交给同机 background；已有慢 Relay 等待、超时／重复保护，不需回 Popup 补点。
- [x] Channel --context 解析、平台 Relay 和 agent-browser 0.36.0 调度已接线；不接受混用旧设备参数。
- [x] 标签隔离、截图路径返回及基础最终回复 finalize 门禁已有实现。
- [x] 历史一次 example.com 真实闭环有记录：读取标题、清理临时页、回原 DM；**使用旧插件内授权，不代表新对话卡已验收**。
- [ ] **未实现**：多设备 awaiting_device 选择；当前多个候选只返回选择错误。
- [ ] **未实现**：preparing／prepared／execution-ready 完整门禁；当前 attach → decision 直接 running。
- [ ] **部分实现**：outbox 已写库，但未被消费者可靠投递；broker 轮询并 claim 后投 C4，缺持久投递账本与失败恢复。
- [ ] **部分实现**：最终回复缺失 context、closed 但 cleanup 未确认、稳定 client_msg_id 与明确保留意图的跨故障保护。
- [ ] **未实现**：纯只读状态 CLI、暂停结构化原因；不能把 request 或旧 observe 接口当作已具备的新命令。
- [ ] **待验证**：新对话卡一次点击 → 正常默认 open → Agent 真读截图 → 完成清理 → 同一私聊回复的真实全链路。

## P3：生命周期与可靠性

- [x] 显式 pause 会停止调试、保留等待组；resume 接口生成新 activation；等待十分钟的基础逻辑已有。
- [x] 临时页关闭、保留页退出分组、页归属 journal 与恢复逻辑已有；不保留“已停止／已完成”组。
- [x] revision／操作签名去重、任务截止时间、过期清扫、requires_attention 阻止复用已有。
- [ ] **部分实现**：60 秒 Agent 传输 grant 已有，但尚非各端统一的短执行租约、授权 epoch、连接 epoch 与权限撤销体系。
- [ ] **未实现**：可靠撤销通知／outbox 重投、C4 uncertain 状态展示和恢复；当前认领后失败可能漏续跑。
- [ ] **未实现**：pausing/paused 确认协议、人工核对清理后解除 attention 的完整 UI/API。
- [ ] **未实现**：跨 Comm 实例共享路由、NATS 定向转发、截图分块、有界队列及停止优先级。
- [ ] **部分实现**：来源读取校验已有；成员／Agent 授权变化、消息编辑撤回、组织删除的完整事件联动未接入。
- [ ] **待验证**：真实 pause/resume、执行中停止、断网、系统休眠、MV3／Agent／Chrome 重启、手动移动页面、清理部分失败和保留回执丢失。

## P4：安全与正式交付

- [ ] **待验证**：跨用户／组织／Agent／设备／任务的越权、并发双任务、旧帧与伪造 metadata 的完整专项。
- [ ] **待验证**：普通 DM／群聊、旧 OAuth／API Key Connector、账号登录退出的完整回归。
- [ ] **待评审／实施**：高风险动作明确同意标准、暂停时页面隐私、日志脱敏、截图任务隔离和保留清扫。
- [ ] **待评审／验证**：debugger／远程执行边界、站点能力与商店权限／隐私材料；开发可用不代表商店审核通过。
- [ ] **未实施**：获准环境的正式迁移、兼容服务部署、功能灰度、双实例／容量验收和回滚演练；不得把本地 schema 直接用于共享库。

## 本次证据边界

2026-09-09 本次复跑：Extension 指定五个文件 **57** 项、FE Browser 两个文件 **23** 项、OpenMax Browser 两个文件 **2** 项，共 **82 项通过**。均为隔离自动测试，不连接用户 Chrome 或真实 Agent。

本次未复跑 Channel／Connect／Comm／Core 构建及全套测试，没有真实浏览器或云端验收。历史证据见 [本地交接记录](../../../../cws-connect/docs/browser-local-handoff.md)，不要累计不同日期的测试数量，也不要以勾选代替完整实施设计 A01—A18 的逐项验收。
