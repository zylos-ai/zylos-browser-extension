# 授权后无工作页：启动版本冲突回归

范围：2026-09-10 本地 Demo，不是生产上线或真实账号新任务验收。

## 故障证据

00:51 的 B 站任务已完成批准、ready 和 C4 续跑。Channel 首个 open 先提交 touch，把任务 revision 从 3 推进到 4；插件尚未收到异步状态更新，用旧 revision 提交 started，服务器拒绝 STALE_TASK。插件却在提交前已经将 started 设为 true，重试因此被拒绝 TASK_ALREADY_STARTED，没有创建过工作页。OpenMAX 聊天卡只根据 running 显示“正在操作／查看工作页”，进一步掩盖了失败。

这与前一份 reply-lifecycle 报告的“迟到提示自动收尾”是两个独立缺陷；之前的测试替身未校验 started 的真实 revision CAS，漏掉了这一种时序。

## 修复范围

- 扩展启动先同步占用 starting 锁，再读取权威任务、核对任务/账号/端点/连接代次/激活/session/source/期限。仅对明确未提交的 409 STALE_TASK 最多重试三次；网络结果不确定不重放。实际建页完成才记 started。
- 启动失败立即撤销本地控制，提交停止与清理；停止请求也读取当前版本，避免再次撞上旧 revision。断线、停止及换代后的迟到成功不建页。
- OpenMAX 卡片通过只读 browser-task-page-state 得知实际标签状态；无页不显示查看，有页才显示，读取失败不沿用旧成功。读取不签发证明、不创建页、不增加授权；操作仍经平台/WS。
- 修改仅涉及扩展、cws-fe 和 Channel 的测试。没有新增表、修改 Core 或重写登录。

## 验证

| 检查 | 结果 |
| --- | --- |
| 新增旧版本首次 open 回归（修复前） | failed：attach 调用为 0，复现用户故障 |
| 扩展 npm test | passed：129 项，含类型检查；冲突、并发、停止、断线、迟到回执、未知网络结果、建页失败 |
| 扩展 npm run test:build | passed：3 项；构建 .output-platform/chrome-mv3 |
| Channel npm test | passed：19 项 |
| 实际打包 MV3 + agent-browser CLI + OpenMAX 回复检查 | passed：故意制造一次 started CAS 拒绝，恢复后成功建页；定位、点击、截图、暂停继续、标签隔离、清理、保留页解除控制均通过 |
| FE browser-local / browser-chat-consent Vitest | passed：27 项 |
| FE 聊天卡 Playwright | passed：6 项，含 light/dark 模式、查看仍经 HTTP 平台、无页/断线不显示查看入口 |
| FE 定向 Biome 与 check-types | passed |
| FE 故意把页面状态改成永远 true | 仅隔离 bundle 变异：5/5 次在等待状态断言失败；另一种同义错误表达式 1/1 失败；等价正确改写 1/1 通过。开发服务源码未被变异。 |

跨仓命令：在 zylos-browser-channel 下，设置 BROWSER_EXTENSION_DIR 指向扩展的 .output-platform/chrome-mv3，BROWSER_OPENMAX_DIR 指向 zylos-openmax，再执行 node test/platform-cli.e2e.mjs。最终隔离产物：/tmp/coco-platform-cli-AjXye5。

FE：pnpm --filter @cws/web exec playwright test --config=playwright.binding.config.ts browser-chat-consent.spec.ts。页面/API/身份由隔离 fixture 提供，不接触真实账号。

## 生效与未验证部分

卡住的原任务已显式停止，数据库确认为 closed / confirmed / stopped；不会重放旧任务。localhost:3000/workspace 与 Channel /health 均返回 200。此次没有重启服务或变更凭据。

扩展已重新打包；用户 Chrome 仍须在 chrome://extensions 重新加载 Coco，并刷新 OpenMAX 页面。真实账号下重新授权并完成 B 站搜索播放：not_run，需用户新任务授权，不以隔离测试冒充已播放。
