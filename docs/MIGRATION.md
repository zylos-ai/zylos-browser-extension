# v0.5.0：改为 WXT 默认结构

## 变化

移除 browser/ 自定义源码根目录，按职责迁到 entrypoints/、components/、hooks/、utils/、assets/。test/ 改为 tests/，协议样例移到 tests/fixtures/。移除旧 panel.html 入口、发布复制脚本和 build:extension 别名。生成产物仅保留 .output/，不再维护第二份 extension/。

历史 artifacts/、旧构建目录和整理前源码已保存在项目外：
/Users/bobo/coco/zylos-browser-extension-backup-QlE5Zj

该目录仅供恢复，不参与构建和运行。旧根目录 VERIFICATION.md 随源码归档，不再作为当前版操作指南。

## 本机加载路径迁移

1. 停止旧插件的窗口控制，并在 Chrome 扩展管理页禁用旧插件。
2. 执行 npm run build。
3. 使用「加载已解压的扩展程序」，选择本项目 .output/chrome-mv3/。
4. 在 channel 生成新的一次性配对码，连接新插件，再主动开启窗口控制。
5. 确认功能正常后，可由用户自行移除 Chrome 中的旧扩展登记。

未固定 manifest key 的已解压扩展可能因加载路径改变而改变 ID，所以此处不承诺自动保留旧插件的 Chrome storage 或配对。channel 服务和旧设备记录没有被删除；不自动复制设备凭据，也不替用户开启控制。

同一个新加载路径上的后续构建，只需在 Chrome 点击重新加载，无需每次重新选择目录。服务端 C4 标识仍由 channel 自己维护，不受插件源码目录变化影响。

## 回归验证

使用 npm test 验证 UI、授权竞态、消息和协议；npm run test:build 验证默认输出、入口和权限。跨项目测试使用模拟 channel 和独立 Chromium profile，不使用个人浏览器，也不发送真实 LLM 任务。channel 的升级测试验证的是同路径替换产物下的存储兼容，不代表本次改变加载路径能自动保留 ID。

2026-09-06 本轮结果：11 项单测、1 项产物检查、格式检查、zip 打包及两项真实 Chromium 集成脚本全部通过；channel 的 14 项单测通过，既有服务健康检查正常。Channel 仅同步测试入口与文档中的产物路径，业务源码没有改变，Core 工作树仍干净。
