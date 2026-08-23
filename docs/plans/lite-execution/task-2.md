# Task 2：Canonical Web 执行读模型

## 目标

从 Web/Electron 已有 canonical chat session 数据派生统一的执行监控读模型，使完整工作台和 Lite 共享同一份会话、流式事件、交互与重连事实。

## 允许修改范围

- Web chat session reducer、类型、selector 和相关 adapter。
- 从 canonical timeline/transient state 派生执行步骤、当前问题、总状态、最终正文的纯读逻辑。
- Web/Electron 完整视图与 Lite 的呈现预设类型和默认值。
- 上述 reducer、selector、adapter 的单元测试。

## 禁止事项

- 不修改后端协议或 middleware 执行事件。
- 不修改 LiteView 的视觉结构和模式切换行为。
- 不创建 socket、`LiteClient`、root subscription 或第二份 canonical store。
- 不在 selector 中发起 RPC、懒加载或其他副作用。
- 不复制完整 timeline 到 per-window UI state。
- 不修改 MCU 固件。

## 接口与行为

- chat session reducer 消费 Task 1 的 run、turn、tool 时间字段和 `executionSteps` 快照。
- 提供稳定 selector/adapter，按 `rootChatId` 派生：
  - 当前用户问题。
  - root 总状态、开始/完成时间与总耗时基准。
  - 按真实事件顺序排列的模型/工具节点。
  - 多 Agent 并行活动节点。
  - root 流程最后正文。
- 定义共享呈现配置：

```ts
interface ExecutionPresentationOptions {
  stream: 'full' | 'final-only'
  content: 'full' | 'summary' | 'lazy'
  toolDetail: 'full' | 'name-only' | 'lazy'
  thinking: 'full' | 'lazy' | 'omitted'
  executionStepLimit?: number
  timelinePageSize?: number
  detailPageChars?: number
}
```

- 完整视图默认 `full/full/full/full`。
- Lite 默认 `final-only/lazy/name-only/lazy`，只影响呈现，不影响 canonical 数据接收。
- selector 对迟到事件、重复事件和 currentState/replay 合并保持幂等；不通过当前数组位置猜测 root 或步骤归属。

## 测试

- currentState、实时事件和 replay 均能得到相同执行读模型。
- 当前问题来自正确 root；切换历史会话不会复用旧 root 数据。
- 总开始/完成时间和 run 终态正确派生。
- 模型、工具节点顺序及成功/失败/拒绝/取消状态正确。
- 不同子 Agent 的 running 节点可并行展示。
- 最终正文只取 root 流程最后正文，不误取子 Agent 或中间正文。
- 完整与 Lite 预设只改变呈现选项，不改变 canonical session 内容。
- reducer 对重复/迟到事件幂等。

## 完成条件

- 完整视图与 Lite 可消费同一个无副作用执行读模型。
- 单元测试覆盖 currentState、实时、重放、并行和 root 切换。
- 代码中没有新增连接或 root subscription。
- 删除本文件，在 master 中标记 Task 2 完成。
- 独立提交：`refactor(web): derive lite state from canonical sessions`。

