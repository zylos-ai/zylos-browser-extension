# Browser Use 文档入口

当前目标：**3.0 用户态接入方案**，2026-09-09。

- [评审稿](review-design.md)：产品交互、具体服务图、职责和验收。
- [评审稿阅读版](review-design.html)：浏览器打开，图片可点击放大。
- [实施设计](implementation-design.md)：登录、Channel 开通、Comm 路由、任务协议、数据与仓库改造清单。
- [实施设计阅读版](implementation-design.html)：与 Markdown 正文一致。
- [图源与 PNG](图片和附件/)：7 张图，含循环执行和工作标签生命周期。
- [生成源文件](diagram-source/build.mjs)：原生 SVG 绘图与离线 HTML 渲染。
- [旧 Demo 实施记录 2.0](history/implementation-design-v2.md)：仅用于追溯，非当前目标。

插件只登录用户账号，不长期绑定 Agent。Connector 为选中的 Agent 开通能力；
每次任务仍在私聊里批准，Comm 定向路由到当前插件。登录、开通、任务批准互不等同。

本轮仅修改文档和图，未按3.0改造代码。旧 design.md、tasks.md 及前端2.0任务清单均属历史，
不能据此认为新方案已实现；以实施设计第12节为新改造计划。未同步 Notion/Figma。
