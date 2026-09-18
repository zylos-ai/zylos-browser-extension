# 浏览器动作与决策

动作定义和约束属于插件。Agent 从决策请求中获得参数，不需要维护第二份工具列表。

| 能力                   | 决策动作                                                     |
| ---------------------- | ------------------------------------------------------------ |
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
