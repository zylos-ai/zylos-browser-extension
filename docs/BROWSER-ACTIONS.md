# 浏览器动作与决策

动作定义和约束属于插件。Agent 从决策请求中获得参数，不需要维护第二份工具列表。

| 能力                   | 决策动作                                                     |
| ---------------------- | ------------------------------------------------------------ |
| 只读消息对应的页面     | `read-page`，无需 CDP；支持分段读取正文                      |
| 选中用户发消息时的页面 | `use-current-tab`，使用初始上下文中的 `contextId`            |
| 打开或切换页面         | `open`、`new-tab`、`switch-tab`、`back`、`forward`、`reload` |
| 元素操作               | `click`、`double-click`、`right-click`、`hover`、`drag`      |
| 表单与键盘             | `fill`、`type`、`check`、`select`、`keypress`                |
| 滚动                   | `scroll`，支持页面及指定容器                                 |
| 定向读取               | `find`、`inspect`、`frames`                                  |
| 视觉观察               | `observe`，返回页面与截图                                    |
| 原生对话框             | `dialog`                                                     |

完整参数由 [tool-catalog.ts](../utils/tool-catalog.ts) 从执行校验 Schema 生成。
决策格式与批次规则见 [browser-loop.ts](../utils/browser-loop.ts)，Agent 行为约束见
[decision-guide.md](../agent/decision-guide.md)。

每条消息先通过页面脚本采集轻量 DOM 摘要。`mode: reading` 时只有 `read-page`、
`use-current-tab` 和 `open`；普通聊天或摘要足够时直接回答。摘要不足时使用 `read-page`，
用返回的 `nextOffset` 和 `contentVersion` 继续读取；文本版本变化时从 offset 0 重读。
`limited: true` 表示提取不完整，不能声称覆盖整页。只读动作单独执行，不自动截图或等待页面稳定。
需要操作或高级观察时选择 `use-current-tab` 或 `open`，成功后进入 `mode: operating`，
此时才发送完整操作工具与规则。模式由实际控制状态决定，与轮次无关。

例如选中页面后，用观察到的输入框 ref 填写并提交：

```json
{
  "kind": "actions",
  "actions": [
    { "method": "fill", "params": { "ref": "@observed-input", "text": "spider-man" } },
    { "method": "keypress", "params": { "ref": "@observed-input", "key": "Enter" } }
  ],
  "memory": "确认搜索结果"
}
```

示例 ref 必须替换为当前观察中的实际值。插件校验整个批次，执行后自动处理页面稳定、
同页导航或单个新弹窗，再返回页面文本、滚动状态和任务标签。无需额外请求快照或标签列表。

动作 JSON 通过 `replyCommands.actions` 提交。完成时将回复正文送入
`replyCommands.done`，不能完成或需要用户输入时使用 `replyCommands.blocked`。
这两个命令通过 C4 记录并发送最终文字，由 Remote 的消息适配脚本转换为
`{"kind":"done","text":"结果"}` 或 `{"kind":"blocked","text":"具体障碍"}` 给插件。
普通聊天直接走最终回复命令。每次使用当前请求附带的命令，不沿用旧请求 ID。

点击成功不等于目标完成，但目标确认后不应反复点击、切换播放状态或重复提交。
观察失败时先确认实际页面；不得自动重复已经完成的输入。

## 只读路径验证（2026-09-20）

类型检查、199 项单元测试、3 项构建检查，以及隔离 Chrome 中的 9 个端到端场景通过。
端到端测试使用真实插件和 Remote 0.5.0、临时浏览器配置和本地网页；Agent 决策由测试提供。
聊天和连续正文补读期间记录到的插件 debugger API 调用为 0；随后进入操作模式可点击原消息
对应的 Tab。同网址刷新会使旧上下文失效，停止中的读取不能恢复任务。

Chrome 149 测试文章的一次运行结果如下。耗时包括测试调用链，不包含模型推理或公网延迟，
输出体积为页面上下文/观察对象的 JSON UTF-8 字节数，不是整个请求的大小。

| 操作            |  耗时 | 页面输出 | debugger 调用 |
| --------------- | ----: | -------: | ------------: |
| 首次 DOM 上下文 | 13 ms |  6,484 B |             0 |
| 正文补读第一段  | 18 ms | 12,483 B |             0 |
| 正文补读第二段  |  7 ms |  7,567 B |             0 |

运行 `npm run test:e2e` 可重复验证；以上数值不是生产页面或模型响应速度的保证。
