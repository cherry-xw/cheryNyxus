# Task 1：计时事实与协议

## 目标

在真实执行边界建立稳定、可重建、向后兼容的 run、模型轮次和工具调用计时事实，并为 MCU 提供受限的执行步骤快照。

## 允许修改范围

- middleware 中 run、模型轮次、auto 工具和审批工具的执行事件产生位置。
- canonical/protocol 事件 schema、序列化类型与 currentState 扫描器。
- Lite `chat.open` 参数与响应投影、帧预算裁剪逻辑。
- 协议、canonical timeline 和 MCU API 相关文档。
- 直接覆盖上述行为的后端与协议测试。

## 禁止事项

- 不改 Web/Electron 的 store、LiteView、切换入口或 UI。
- 不改 MCU 固件渲染。
- 不建立新的 WebSocket 或新的 Lite transport。
- 不改变既有字段的含义、必填性或 wire shape；新增时间字段必须可选。
- 不在模型生成工具调用时提前开始工具计时。
- 不混入与计时协议无关的重构。

## 接口与行为

- 为事件增加向后兼容的可选字段：
  - `run.updated.at`；首次 running 时增加 `startedAt`。
  - `turn.completed.completedAt`。
  - `sense_started.startedAt`。
  - `accept.completedAt`、`rejected.completedAt`、`done.completedAt`。
- 定义并投影：

```ts
interface ExecutionStep {
  id: string
  runId: string
  chatId: string
  kind: 'model' | 'tool'
  name: string
  status: 'running' | 'completed' | 'failed' | 'rejected' | 'cancelled'
  startedAt: number
  completedAt?: number
}
```

- `chat.open/currentState.executionSteps` 返回当前 run 可见的执行步骤。
- `chat.open.executionStepLimit?: number` 控制计时节点数量；标准客户端默认保留完整当前 run 窗口，MCU 默认最近 16 项。
- `sense_started` 必须在工具真正开始执行前发送：auto 工具逐个发送；审批工具批准后、执行前发送。
- 并行子 Agent 允许存在多个 running 步骤；同一 chat 的顺序工具保持真实顺序。
- currentState 必须能从持久事件重建计时步骤，不能依赖单进程内存状态。
- `executionStepLimit` 与 `maxFrameBytes` 同时约束输出，服务器在帧预算不足时安全收缩实际页。

## 测试

- 多个 auto 工具的开始/完成事件按真实执行顺序出现。
- 审批等待期间不存在工具 started；批准后立即产生 started，随后产生终态。
- 工具成功、失败、拒绝、取消均产生正确终态与完成时间。
- 模型轮次、工具和 root run 的时间能从 currentState 重建，重连后仍一致。
- 并行子 Agent 可同时包含多个 running 步骤。
- `executionStepLimit` 返回最近步骤并保持活动节点可见。
- `maxFrameBytes` 与步骤限制同时生效，无超预算帧。
- 旧客户端忽略新增字段后行为不变，非 Lite 连接不回归。

## 完成条件

- 所有新增字段、schema、类型、投影与文档一致。
- 针对性协议/后端测试全部通过。
- 主 Agent 审查确认事件位于真实执行边界且未改变旧 wire contract。
- 删除本文件，在 master 中标记 Task 1 完成。
- 独立提交：`feat(protocol): add execution timing facts`。

