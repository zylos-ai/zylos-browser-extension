# 用户态 V3 本地实施契约

本轮验收范围：完整本地 Demo；现有真实 Core 身份/会话 API + 独立 Docker Browser 表 + 单实例 Comm。正式 SSO client、公开域名/WSS、多实例共享目录不伪装成本地已验证功能。

1. 扩展登录只取得真实全局用户 identity；本地 PKCE 适配器复用 Core 校验，不保留网页 token。
2. Connector 为选中且有管理权的 Agent 开通 Browser 能力。安装控制复用 Comm → OpenMAX 安装器，结果回本地能力记录；不写共享测试库。
3. 插件主动连接 Comm 用户入口。Comm 分配 endpoint/epoch；不是普通聊天订阅。Channel 主动连接任务入口，可预连接，无入站 Agent 端口。
4. 当前浏览器确认经插件现有 WS 发给 Comm，绑定任务、来源、revision、nonce、identity、endpoint、epoch。网页只得到短期证明，不得到执行令牌。
5. 允许先验证真实人类消息与能力，再在 Comm 预占，Connect SQL CAS/回执/outbox，最后提交并等待 Ready；重复事件不会重复建页/执行。
6. Ready 不建页；首个真实 URL 在聊天页相邻创建任务页。CLI/CDP 执行循环、截图、光标和任务标签清理沿用。
7. 断线/注销立即隔离旧代次；不自动恢复副作用。未确认清理阻止再次批准；需要本地任务日志确认或明确人工处理。
8. 状态与工具使用 protocol 3，拒绝把旧绑定静默升级。保留旧表数据，切换前备份；不删除用户原有标签。

验收：登录不选 Agent、同账号可先后使用不同已开通 Agent、对话批准无需 Popup、未批准不读页/建页、首 URL 无 about:blank、错误账号/来源/旧代次拒绝、竞争批准最多一个成功、暂停/继续/停止、保留结果、断线与重复命令、真实打包插件与 CLI 本地闭环。
