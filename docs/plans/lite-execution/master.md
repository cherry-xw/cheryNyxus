# Web/Electron 单连接 Lite 与 MCU 执行监控总计划

## 目标

建立两条共享同一执行语义、传输策略不同的客户端路径：

- Web/Electron 继续使用 canonical WebSocket 和唯一 root 订阅。完整工作台与 Lite 仅切换客户端呈现，不断连、不重连、不重复水合。
- Electron/Web 默认具备流式正文、完整最终正文、完整工具数据与思考数据能力；Lite 预设在完整 canonical 数据上做简洁展示与懒加载。
- MCU 使用独立 `profile=lite` 连接，由服务端根据设备传入的帧预算、节点数量和分页参数硬裁剪。
- 界面顶部展示当前问题、总状态和总耗时；下方按真实事件顺序展示模型轮次、工具调用及各自耗时。
- 当前节点实时计时；完成节点自动折叠为名称、状态、耗时摘要；最终只突出 root 流程最后正文。
- 工具详情、思考、超长正文和历史内容按需加载。
- 同步修复 Lite 当前的错会话、多窗口串状态、切换触发重连、`done` 分支不完整、发送/审批/提问状态闭环缺失等问题。

## 架构决策

### Web/Electron canonical 单连接

- `WorkbenchDialog` 继续通过 `chatSessions.acquireRootTimeline()` 持有唯一 root 订阅。
- 完整视图与 Lite 共享 canonical root timeline、chat session transient state、interaction inbox、streaming events、reconnect/replay fence 和命令发送路径。
- 切换 Lite 只改变 Vue 组件及 selector，不调用 `connect`、`disconnect`、`chat.open` 或 `chat.close`。
- 多窗口仅按 `windowId + rootChatId` 保存展开项、草稿、滚动位置等 UI 状态，不复制 canonical 会话数据。
- Web/Electron 生产路径不再依赖独立 `LiteClient`；主连接断线时只允许 canonical 连接执行一次重连。

### MCU 独立 Lite profile

- MCU 继续通过独立 `profile=lite` 连接验证低资源协议完整性。
- 服务端依据 `maxFrameBytes`、`executionStepLimit`、时间线分页和 `node.get` 分页约束响应。
- MCU 默认 `maxFrameBytes=2048`、`turnDelta=0`、`executionStepLimit=16`，设备可显式覆盖。
- 固件使用固定容量数据结构，首屏仅接收问题、总状态、计时步骤和最终正文摘要；详情按键触发分页加载。

## 共享接口

### 呈现预设

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

- Electron/Web 完整视图：`full/full/full/full`。
- Electron/Web Lite：`final-only/lazy/name-only/lazy`，但底层仍接收完整 canonical 数据。
- MCU：`final-only/lazy/name-only/lazy`，并由服务端硬裁剪。

### 计时事实

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

- `run.updated`：增加可选 `at`；首次 running 增加可选 `startedAt`。
- `turn.completed`：增加可选 `completedAt`。
- `sense_started`：增加可选 `startedAt`，并移动到工具真正开始执行之前发送。
- `accept`、`rejected`、`done`：增加可选 `completedAt`。
- `chat.open/currentState`：增加当前 run 的 `executionSteps`。
- `chat.open`：增加可选 `executionStepLimit`。
- 所有新增字段均保持向后兼容，旧客户端可安全忽略。

### 容量参数

- `maxFrameBytes=512..65536`：连接级字节预算。
- `turnDelta=0|1`：连接级流式能力。
- `limit/before`：时间线节点分页。
- `executionStepLimit`：执行计时节点数量。
- `node.get offset/limit`：正文、思考和工具详情字符分页。
- `interaction.list maxItems`：交互收件箱数量。

## 顺序任务与提交边界

| 顺序 | 任务 | 计划文件 | 预期提交 |
| --- | --- | --- | --- |
| 1 | 计时事实与协议 | `task-1.md` | `feat(protocol): add execution timing facts` |
| 2 | Canonical Web 执行读模型 | `task-2.md` | `refactor(web): derive lite state from canonical sessions` |
| 3 | Lite 单连接集成 | `task-3.md` | `fix(web): switch lite mode without reconnecting` |
| 4 | 执行监控 UI 与懒加载详情 | `task-4.md` | `feat(web): add lite execution monitor` |
| 5 | 交互状态机闭环 | `task-5.md` | `fix(web): complete lite interaction state machine` |
| 6 | MCU 有界执行界面 | `task-6.md` | `feat(firmware): render bounded execution timeline` |

执行规则：

1. 严格按 Task 1 → Task 6 顺序派发，每项只交给一个 Agent 实施。
2. Agent 只能修改该任务“允许修改范围”内的内容，不混入用户现有脏改动。
3. 主 Agent 审查差异并运行该任务的针对性测试。
4. 验收通过后删除对应 `task-N.md`，更新本文件状态，并在同一次功能提交中纳入计划文件删除。
5. 所有任务完成后执行统一回归，只修复本轮引入的问题；删除本文件及剩余验收材料，提交 `test(lite): complete cross-client regression`。
6. 不自动 push。

## 统一验收矩阵

### 协议与后端

- 多个 auto 工具的 started/completed 时间严格按实际执行顺序出现。
- 审批等待计入任务总耗时，但不计入工具执行耗时；批准后才发送 `sense_started`。
- rejected、error、abort 均能封口对应节点和总任务。
- turn、tool、run 时间能从持久事件重建为 currentState。
- `executionStepLimit` 与 `maxFrameBytes` 同时生效。
- 旧客户端忽略新增字段后行为不变；非 Lite 连接不受 Lite profile 限制影响。

### Web/Electron

- 切换 Lite 前后 WebSocket 实例数不增加，root `subscriptionId` 与 `rootEventSeq` cursor 不变化。
- 运行中频繁切换不停止任务、不丢流、不重复消息。
- 主连接断线只重连一次，Lite 不维护第二套重连状态。
- 两个工作台窗口各自显示正确 root，不串会话或 UI 状态。
- 当前问题、总计时、模型/工具计时、完成折叠和并行 Agent 展示正确。
- 完整视图可展示完整流与完整工具数据；Lite 仅简洁呈现。
- 首屏不因 Lite 额外调用 `node.get`；展开正文、thinking 或工具详情时才请求。
- `done`、继续、发送失败、审批、提问和超时均形成闭环。

### MCU

- 2048 B 默认配置下响应不超过设备缓冲。
- 16 节点固定容量无越界、无动态分配。
- 工具顺序切换、模型轮次、总计时和断线恢复正确。
- 超长最终正文可通过 `offset/limit` 连续分页且不重复、不缺段。
- `turnDelta=0` 时不接收逐字正文；开启能力仍由协议测试覆盖。

## 最终回归

- 运行 Web 与后端类型检查。
- 运行 Web Lite、chat store、workbench 和 reconnect 测试。
- 运行 Lite projection、connection、attach/cold-sync 和 interaction 测试。
- 运行 MCU host/static 测试。
- 运行 Web production build。
- 检查每个提交只包含对应功能及计划文件删除，不包含用户已有改动。

## 固定假设

- Electron/Web Lite 是“完整 canonical 数据上的简洁呈现”，不是 MCU 传输模拟器。
- MCU profile 是验证低资源协议完整性的权威入口。
- 总计时从当前用户问题进入执行流程开始，到 root `done`/error/abort 终态结束。
- 同一 chat 内工具顺序执行；不同子 Agent 可并行。
- 完成节点保留一行摘要；MCU 最多保留 16 项，溢出时汇总最早完成项。
- Web/Electron 默认拥有完整能力，但 Lite 首屏仍遵循懒加载，避免无意义的渲染与内存占用。

