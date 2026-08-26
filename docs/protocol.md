# WebSocket 协议规范

> Canonical Chat 协议说明（2026-08）：`chat.list`、`chat.open/close`、
> `chat.timeline.*`、`chat.input.submit`、`chat.run.resume` 与显式 tree/abort control
> 是当前公开会话 API。请求 schema 和跨端 envelope 类型以 `packages/protocol` 为唯一来源。
> `chat.send/get/sync/attach/resume/startSpawn/sendToChild` 以及旧 sense approval/question
> 路由不再对外注册；本文后续仍出现的这些名称仅是历史帧格式说明，不构成可调用契约。
> 新客户端不得实现 attach + sync replay，也不得从流式 RPC 生命周期推断 run 状态。

> [← 返回 README](../README.md) ｜ [交互流程示例](interaction.md) ｜ [数据存储](db.md)

> **当前实现说明（V2）**：连续输入、权威历史和多 Agent 根时间线的最新契约见
> [multi-agent-canonical-timeline.md](multi-agent-canonical-timeline.md)。本文保留旧
> `chat.get/chat.sync/chat.attach`、staged chunk 等兼容期帧格式；新代码不得据此重新设计前端历史重组。

**连接地址：** `ws://localhost:8182`（端口通过 `.chery/config.yaml` 的 `server.port` 配置）

**消息模式：** RPC 模式，四种消息类型：

| 类型         | 方向 | 说明       |
| ------------ | ---- | ---------- |
| Request      | C→S  | 请求消息   |
| Response     | S→C  | 响应消息   |
| Chunk        | S→C  | 流式增量   |
| Notification | S→C  | 服务端推送 |

**传输格式**（由 `.chery/config.yaml` 的 `server.transport` 配置，默认 `binary`）：

| 模式     | stream chunk    | staged chunk / notification |
| -------- | --------------- | --------------------------- |
| `binary` | 二进制帧 `0x01` | JSON 帧 `0x02`              |
| `json`   | JSON 字符串     | JSON 字符串                 |

二进制帧（stream chunk）格式：

```
[0x01][requestId_len:1 byte][requestId:n bytes][payload_json]
```

旧客户端的 `payload_json` 直接是 stream data；带业务关联的新帧使用
`{data, chatId?, runId?, seq?}`。两种形式均由客户端兼容解码。

JSON 帧格式：

```
[0x02][full_json]
```

**消息结构：**

```typescript
interface Request {
  id: string // UUID；24 小时内同 id + method + params 只执行一次
  kind: 'request'
  method: string // 方法名
  params: unknown // 方法参数
}

interface Response {
  id: string
  kind: 'response'
  requestId: string // 对应 Request.id
  success: boolean
  data?: unknown
  error?: { code: string; message: string }
}

interface Chunk {
  kind: 'chunk'
  type: 'stream' | 'staged'
  requestId: string
  chatId?: string // 所属 chat；客户端不得再由 requestId 推断
  runId?: string // 本次 chat.send/chat.resume 运行（= 启动该运行的 Request.id）
  seq?: number // 可恢复 chat 事件的单调序号
  data: StreamChunkData | StagedChunkData
}

interface StreamChunkData {
  msgId: string // 当前 LLM 响应消息 id；=最终 messages.id
  createdAt: number // 当前 LLM 响应开始时间
  thinking?: string // thinking 增量
  content?: string // content 增量
  senseCall?: SenseCallDelta[]
}

interface StagedChunkData {
  type: 'thinking_end' | 'content_end' | 'sense_end' | 'reverse'
  role?: 'user' | 'assistant' | 'system' | 'sense' // 消息角色，chat.get 历史返回时使用
  thinking?: string
  content?: string
  senseName?: string
  arguments?: string
  id?: string // sense 调用 id，用于关联 sense_end 与 sense 结果
  messageIds?: string[] // reverse 类型：被撤回的消息 id 列表
  replace?: { state: boolean; by: string; content: string } // 感官去重替换元数据
  originalContent?: string // 被替换时的原内容
  runtime?: { brain: string; senseGroup: string; mcpServers: string[] } // content_end 携带：user=发送时配置，assistant=前一条 user runtime（后端关联）
}

interface Notification {
  kind: 'notification'
  type:
    | 'interrupt'
    | 'accept'
    | 'rejected'
    | 'consumed'
    | 'loaded'
    | 'done'
    | 'error'
    | 'replaced'
    | 'role_created'
    | 'role_destroyed'
    | 'role_reply'
    | 'sense_started'
    | 'question_requested'
    | 'question_answered'
    | 'question_batch_requested'
    | 'question_batch_completed'
    | 'auto_compacted'
    | 'timeline.patch'
    | 'turn.started'
    | 'turn.delta'
    | 'turn.completed'
    | 'input.updated'
    | 'run.updated'
    | 'interaction.changed'
  requestId?: string // 仅与某次 RPC 有直接因果关系时携带
  chatId?: string // 异步推送（role_created/role_reply 等）以此路由
  runId?: string // 运行中事件的稳定关联 id
  seq?: number // 可恢复 chat 事件的单调序号
  data:
    | InterruptData
    | AcceptData
    | RejectedData
    | ConsumedData
    | ReplacedData
    | RoleCreatedData
    | RoleDestroyedData
    | RoleReplyData
    | SenseStartedData
    | null
    | { message: string }
}
```

### Notification 类型

| type                                       | data                                                                                                                         | 触发时机                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `consumed`                                 | `{count, messages:[{id,role:"user",content,createdAt,...}]}`                                                                 | 用户输入入队；messages 是已进入 journal 的权威用户消息，前端按 id upsert/rekey 乐观消息                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `interrupt`                                | `{approvalId, senseName, arguments, supervisionLevel, needsApproval, waitTime, createdAt}`                                   | sense_end（仅 smart/manual；auto 不推）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `sense_started`                            | `{id, senseName, arguments, startedAt?}`                                                                                     | 工具的**真实执行边界**：通过审批、schema/security 与 PreToolUse 检查后，在调用工具 handler 前立即发出。auto 工具逐个发出；smart/manual 工具仅在批准后发出，审批等待期间或拒绝时不发。前端据 `id` 维护「运行中工具」，对应 `accept`/`rejected` 到达时结束；`startedAt` 为 epoch ms，可选以兼容旧客户端                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                       |
| `accept`                                   | `{approvalId, senseName, result, completedAt?}`                                                                              | sense 执行结束（全工具推；`approvalId`=sense 调用 id，前端据此结束同 id 工具步骤）；`completedAt` 为 epoch ms                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `rejected`                                 | `{approvalId, senseName, reason, completedAt?}`                                                                              | sense 被拒 / 审批取消；`completedAt` 为 epoch ms。若在执行前拒绝，计时快照会产生 `startedAt=completedAt` 的零时长 rejected 步骤，不把审批等待计入工具耗时                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `loaded`                                   | `null`                                                                                                                       | chat.get 历史发完                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `done`                                     | `{contextUsage, contextBreakdown, used?, total?, finished?, finalMessage?, canResume?, completedAt?}`                        | chat.send/resume loop 结束。`completedAt` 为 epoch ms。`contextUsage` = 当前 chat 总 token /（brain.contextLimit KB × 256）（0-1），前端据实时更新 pet.contextUsage（ContextBar）。CP7。`contextBreakdown` = 6 段分解 `{system,userSystem,memory,skills,tools,conversation:Segment, total, usage}`（各段 `{tokens,count?}`：系统/用户系统提示词·记忆（条数）·技能（skill 数）·工具定义（tool 数）·用户对话（消息条数，含 sense 调用结果）），前端据更新 pet.contextBreakdown 渲染分段进度条。`used`/`total` = 已用/上限 token。`finished`（boolean，仅子 chat 即 `parent_chat_id` 非空时携带）= 子 agent 已完成，前端据 `finished===true` 把子 pet 转 ghost（灵魂态保留）。done 时后端写 `metadata.finished` 持久化，刷新后 `chat.list` 暴露同字段重建 ghost。`canResume`（boolean，权威）= `computeCanResume` 派生：统一暂停语义下前端据 canResume 区分 paused（末条非 ended，显继续按钮）/ ended（末条 assistant 无 senseCalls，无按钮），取代旧 done→canResume=false 硬编码。`finalMessage`（`{msgId,role:"assistant",content,thinking?,createdAt,agentChatId?}`，仅本轮末条为 assistant 时携带）= 刚完成的权威回复，前端实时追加进 `stream.history`（PetIcons 圆点气泡即时显新内容，不再等 `chat.get` 重载）；`msgId` 供下次 `chat.get` 合流按 msgId 去重；`agentChatId` 标识该消息来源 chatId（默认 = 当前 chatId），供前端反向溯源（filter `agentChatId === X` 取该 agent 完整 history，无需正向溯源） |
| `error`                                    | `{message, canResume?}`                                                                                                      | agent generator 在流中抛出 error chunk 时触发（retry 耗尽 / maxLoop 超限）。统一暂停语义：AI 报错归 **paused**（非失败），`canResume`=`computeCanResume` 派生，前端据 canResume 显继续按钮（可重试）；final Response 恒 success:true                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `replaced`                                 | `{id, content, originalContent, by}`                                                                                         | 感官去重命中，历史 sense 结果被新读取替换                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `role_created`                             | `{taskId, chatId, parentChatId, type, prompt, brain, senseGroup, wake}`                                                      | spawn_role sense 执行时。前端收此 notification → 创建子 pet + 调 `chat.startSpawn({taskId})` 原子领取任务；重放不产生第二次初始 prompt。事件外层 `chatId` = `parentChatId`。`wake ∈ 'immediate' \| 'deferred' \| 'barrier'`：唤醒策略（信息性，前端均驱动子跑；唤主时机由后端 wakeScheduler 决定，见 [agent-pet.md §5.4](./agent-pet.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `role_destroyed`                           | `{chatId}`                                                                                                                   | **已失去发出方**（`destroy_role` sense 移除，子 agent done 改转 ghost，见 [agent-pet.md §5.6](./agent-pet.md)。协议项保留作防御）；外层 `chatId` 为其主 chat。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `role_reply`                               | `{parentChatId, childChatId, type, content, spawnSenseCallId?, msgId?}`                                                      | wake='immediate' 子完成 / wake 策略满足唤主时推（wakeScheduler evalWakePolicy 判定 shouldWake=true）。子 loop 结束后已把子结果以 role:role 注入主 chat DB，前端收此 notification → 自动 `chat.resume(parentChatId)`。**deferred/barrier 暂存路径不推此 notification**（wakeParent silent=true 仅注入 role + DB 写，主被将来某次唤主 resume 时消费）；`content` 仅即时展示，权威内容在主 chat；事件外层 `chatId` = `parentChatId`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `question_batch_requested`                 | `{batchId, assistantMessageId, createdAt, questions:[{questionId,position,question,header?,options,multiSelect,createdAt}]}` | 一个 assistant turn 的完整问题批次。`batchId = assistantMessageId`，服务端在所有 placeholder sense 和批次领域状态持久化完成后才发出；事件按 `batchId` 幂等，可安全重放。前端只保存本地草稿，不逐题回传。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `question_batch_completed`                 | `{batchId}`                                                                                                                  | 整批答案已在单个 SQLite 事务中写入 sense 消息并关闭批次。事件进入 chat event log，前端收到或重放时仅清理对应批次；是否启动 `chat.resume` 由 `sense.question.batchAnswer` RPC 的 `shouldResume` 决定，避免重复续跑。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `question_requested` / `question_answered` | 旧逐题结构                                                                                                                   | 仅兼容历史事件和旧客户端；新前端不再据此构造问题状态。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |
| `auto_compacted` | 轻量 toast 数据 | 自动压缩：chat 上下文超阈值自动注入 `[[command:/compact]]`，推前端显「已自动压缩」提示。 |
| `timeline.patch` | `{chatId, baseRevision, revision, operations, rootPatch?, rootPatches?}` | 持久化消息事务提交后的权威时间线增量 patch（root 维度 diff，详见 [multi-agent-canonical-timeline.md](./multi-agent-canonical-timeline.md)）。 |
| `turn.started` | `{turnId, messageId, runId?, createdAt}` | 该 msgId 的首个 stream chunk 到达时发出（同 turn 只发一次，服务端 Set 去重）。`turnId = messageId` = checkpoint 预分配的 assistant msgId（= 最终落库 messages.id）。 |
| `turn.delta` | `{turnId, messageId, channel, offset, delta}` | 实时打字机增量（V2 session 通道）。`channel ∈ thinking | content`；`offset` 为该 channel 内字符偏移（服务端维护）。**与 legacy 0x01 stream chunk 双通道并存**（同内容两条通道同时发出）。 |
| `turn.completed` | `{turnId, messageId, completedAt?}` | 该 turn 的节点事实已提交；staged 完成处发出，run 终态时对所有未完成 turn 补发（completedTurns 去重）。`completedAt` 为 epoch ms。 |
| `input.updated` | `{inputId, clientMessageId?, messageId?, state, content?, queueSequence?, acceptedAt?, reason?}` | 用户输入生命周期。`state ∈ accepted | started | queued | consumed | cancelled | rejected`（accepted/cancelled/rejected 当前无发射方，属类型预留）。`chat.input.submit` ack 时携 `content`（用户原始输入全文回显，无截断）与 `state: started/queued`；`consumed` 通知后逐 input 补发 `state: consumed`。 |
| `run.updated` | `{runId, status, at?, startedAt?}` | run 状态变更。`status ∈ running | waiting | paused | completed | failed`。`at` 是本次状态发生的 epoch ms；首个 `running` 同时携 `startedAt`。**run 启动即发 running，先于首个 token**——工作态判定的唯一权威信号，前端不得从 turn.started / assistant 输出推断；done 按 canResume 发 paused/completed；abort/park/未预期异常一律补发 paused（兜底安全网）。新增时间字段均可选，以兼容旧客户端。 |
| `interaction.changed` | `{interactionId, status, revision}`（三字段；lite 连接增携 `presetId?`，D18） | interactions 表任何状态迁移后的轻量失效信号。**无 chatId、无 seq、不进 chat_events、不经 prepareSessionEvent 路由**——广播到所有已连接客户端（含未订阅任何 chat 的连接）。纯失效通知：客户端据此重拉 `interaction.list`；断线错过的通知由重连/重拉兜底，无重放语义。lite 连接的 `presetId` 供设备判断是否需重拉（消多 agent 放大）；非 lite 连接不携带。 |

> `supervisionLevel` 为数字枚举（0/1/2，见 [core/sense.md](./core/sense.md)「Sense 监管等级」）。`needsApproval = supervisionLevel > 0`。auto sense（`needsApproval:false`）不推 `interrupt`（无审批需求，前端不弹审核卡）；仅 smart/manual 推送。`waitTime` = `global.approval_timeout`（ms，字段约束 `>= 0`：`0` = 不限时，不显倒计时；省略 = `0` 同义），`createdAt` = 发起时间戳（ms），前端据此算倒计时：`remaining = waitTime - (now - createdAt)`，归零后端超时 reject → `rejected` notification；用户 accept/reject 后前端立即关闭（不等 `accept`/`rejected` notification 回来）。`approval_timeout` 的范围校验在 [config.ts §validateRawConfig](./utils/README.md) 与 [schemas.ts §globalSchema](./service/message.md) 双层执行。

> **断连宽限 vs 审批超时**：WS 断连不立即 park 挂起审批（由 `disconnect_grace_ms` 宽限期接管，宽限期内 approval Promise 存活、重连可用**原 approvalId** 审批续跑，到期才 park；见 [websocket.md 断连宽限](./service/websocket.md)）。但 `approval_timeout>0` 的用户超时 timer 在宽限期内**仍计时**——若断连期间到点，registry resolve-as-reject（loop 继续，= 用户拒绝），重连后该工具显 rejected。即「断连推迟 park，但不暂停用户超时计时」。`approval_timeout=0`（不限时）的资源上限由 `global.approval_hard_timeout`（默认 30min）兜底，到点 park 归 paused 可续（非拒绝）。

### Chunk 类型

| type     | data                                                                                                                                                   | 说明                                                                                           |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------- |
| `stream` | `{msgId, createdAt, thinking?, content?, senseCall?}`                                                                                                  | 当前 LLM 响应的实时增量；同一响应所有 chunk 的 msgId 稳定，工具循环下一次 LLM 调用使用新 msgId |
| `staged` | `{type, role?, thinking?, content?, senseName?, arguments?, id?, msgId?, createdAt?, messageIds?, replace?, originalContent?, runtime?, agentChatId?}` | 阶段完成（JSON 帧）                                                                            |

`staged.type` 取值：`thinking_end` / `content_end` / `sense_end` / `reverse`。`role`（user/assistant/system/sense）仅 chat.get 返回历史时携带。`id` 用于把 `sense_end` 与 `role:"sense"` 的结果块关联起来。`reverse`（携 `messageIds`）由 `chat.send` 在自动撤回末尾 pending sense 时发送，标记客户端回滚对应消息。`replace/originalContent` 仅 chat.get 历史回放命中感官去重时携带。`runtime` 仅 `content_end` 携带：user 消息=发送时配置（来自 `messages.runtime`），assistant=前一条 user 的 runtime（后端关联，不入库 assistant runtime），供前端 hover 历史消息显该消息用的 brain/工具。`agentChatId` 仅 chat.get 历史回放携带（= 当前回放的 chatId），供前端 HistoryItem 反向溯源（filter `agentChatId === X` 取该 agent 完整 history）。

`msgId` / `role` / `createdAt`：checkpoint 在每个 LLM turn 开始时预分配 assistant id。该 `msgId` 从第一个实时 `stream` delta 起携带，并与 staged、done.finalMessage、最终落库 messages.id、chat.sync/chat.get 回放 id 完全相同。工具循环中的下一次 LLM 调用生成新 `msgId`，前端据此封口旧 active message、建立空新消息，再应用首个 delta；不从 thinking/content 的内容变化猜测边界。`thinking_end`、`content_end`、`sense_end` 均携当前 assistant `msgId`，由 reducer upsert 同一对象。

### 流协议终态语义

单一权威终态 = **final Response**（RPC 协议层）：

- 成功路径：streaming chunks/staged chunks → `done` notification（业务终态，含 `contextUsage`+`finished?`+`canResume?`）→ **final Response** (`success:true`)。
- 异常路径（统一暂停语义）：streaming chunks/staged chunks → `error` notification（含 `canResume?`，归 paused）→ **final Response** (`success:true`)。AI 报错/中断/断连皆归暂停可恢复，前端据 `canResume` 显继续按钮；final Response 不再 success:false。

`done` 与 `error` 是业务事件（统一暂停语义下 final Response 恒 success:true，终态由 notification 的 `canResume`/`finished` 判定）；客户端必须以 `chatId/runId` 路由事件。

### currentState（刷新当前态快照）

`chat.get` / `chat.attach` / `chat.sync` 的 response 携带 `currentState?`（G8）：刷新重建时给前端**权威当前态**，避免从事件流推导「审批是否仍存活」「运行中工具」「当前 todo」。前端单一缓存数组仍以事件流（`chat.sync`）为累积水源；`currentState` 仅补事件无法可靠判定的事实（如审批已被 park 但无 rejected 事件）。

```typescript
interface CurrentStateData {
  pendingApproval?: {
    approvalId: string
    senseName: string
    arguments: string
    supervisionLevel: number
    waitTime: number // = global.approval_timeout（0=不限时）；前端据 waitTime+createdAt 算倒计时
    createdAt: number // interrupt 发起时间戳（ms）
  }
  runningTools: { id: string; senseName: string }[] // 已发 sense_end 但无 accept/rejected 的工具（含待审批）
  executionSteps: ExecutionStep[] // 从持久事件重建的当前 run 模型轮次与真实工具执行步骤
  currentTodo?: unknown[] // 最近一条 update_todo 的 arguments.todos（结构化）；无则省略
}

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

- `pendingApproval`：仅当挂起审批**仍存活**（`approvalManager` 内存命中，未被 confirm/park/超时清出）才返回；否则 `undefined`（run 已 paused，前端显继续按钮）。
- `runningTools`：running 时从内存/事件扫描，idle 时从事件扫描；含待审批工具（与 `pendingApproval` 同 id）。
- `executionSteps`：扫描持久 `chat_events`（最多最近 10,000 条），以该 chat 最新一次 `run.updated{status:'running'}` 为当前 run 起点，重建模型轮次与真实工具执行步骤；因此断线、刷新或服务重启后仍可恢复计时。root `chat.open` 会聚合所有后代 chat 的步骤，允许多个并行子 Agent 同时处于 `running`。
- `executionSteps` 与 `runningTools` 职责不同：前者是精确计时事实；后者保留既有兼容语义，仍可能包含正在等待审批、尚未真实执行的工具。
- `currentTodo`：最近 `update_todo` sense 的结构化 todos（todo 无专用通知，靠 sense_end.arguments）。
- **不含 `currentTurnContent`**：当前轮 content 由带 `msgId` 的 stream delta + staged 重放构建，避免无边界双写。sync snapshot 只在 `snapshotSeq` 边界 replace currentState/session metadata。

### 前端 ChatSession hydration

启动先用一次 `chat.list(includePreview=true)` 建立全部 catalog 实体，只对舞台最近 5 个主 chat 及其后代完整 hydration；其他 chat 在用户加载时原位升级。

```text
running chat:
  chat.attach(chatId)          // 仅重定向后续 live output，不推进客户端 cursor
  chat.sync(chatId,lastSeq)    // 冷启动 lastSeq=0
  → seq 有序重放 stream/staged/notification
  → response.snapshotSeq 边界 replace session metadata/currentState/questions
  → drain seq > snapshotSeq 的已缓冲 live 事件

idle chat:
  chat.sync(chatId,lastSeq)
```

`chat.sync` response 除事件 cursor/currentState/question snapshot 外，还携当前 runtime、preset、workspace、canResume、context usage/breakdown/commandConfig，供前端一次构建完整 UI 投影。HistoryDrawer、SessionList 打开和 Pet hover 均不调用 `chat.get`；正常 send/done 后也不重拉历史。

前端仅有一个领域 reducer：`seq` 去事件重放，`msgId` 对消息 upsert。主 chat 群聊时间线由 selector 动态合并各 descendant ChatSession，禁止存 child 消息副本。

### 事件重放分类（replay-safe，G6）

`chat.sync` 回放事件时，前端须区分**幂等可重放**（累积显示）与**动作/终态**（仅更新态、不触发副作用）：

| 分类         | 事件                                                                                                                                                                 | 重放行为                                                                |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| 幂等可重放   | `stream` / `staged`(thinking_end·content_end·sense_end·reverse) / `consumed` / `interrupt` / `accept` / `rejected` / `sense_started` / `replaced` / `auto_compacted` | 重放即累积进缓存数组、更新对应显示                                      |
| 动作/终态    | `done` / `error` / `role_reply` / `question_batch_requested` / `question_batch_completed`                                                                            | 重放仅更新态（如 finished/canResume/批次关闭），不重复触发 RPC 或副作用 |
| 跳过发起动作 | `chat.startSpawn` / `chat.resume` 的 RPC 响应流                                                                                                                      | 属前端主动发起的 RPC，重放时不重新发起（仅消费其流内事件）              |

> `role_created` 不入 chat_events（spawn task 是持久权威载体，刷新靠 `chat.list` 重建 pet 树，非事件回放）。

### 方法列表

| 方法                                            | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 流式 |
| ----------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ---- |
| `brain.list`                                    | 列出所有可用 brain（含 `capabilities`：Tool Call、三类媒体输入/生成；每项 `default` 标记 = 是否为「默认」预设 `leader` 角色用的 brain；`senseGroups` 支持 `string \| string[]`——前者单组，后者为历史多组兼容）+ 当前已连 MCP server 名（`mcpServers`）                                                                                                                                                                                                                                                                                                                                                                                                                                    | 否   |
| `sense.list`                                    | 列出所有可用 sense group（senses 含 `:level` 后缀未解析）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `sense.tools`                                   | 列出全部内置工具（代码维护的 `BUILTIN_SENSE_TOOLS`），每项 `{name, label, description, icon}`：`name`=原名（作 sense_groups 条目 key）、`label`=中文名（UI 显示）、`description`=解释（tooltip）、`icon`=glyph/emoji 字符串（pet bar 运行中工具图标用，非内置工具前端 fallback ⚙）。自定义/外部/MCP 工具不在此列，靠前端组合框自由输入                                                                                                                                                                                                                                                                                                                                                    | 否   |
| `sense.tools.docs`                             | 统一获取内置工具完整说明文档。params `{tools?: string[]}`：省略/空 = 全量返回（前端一次拉取缓存、按需展示）；提供 `tools` = 后端按 name 列表一次性返回对应说明（未知 name 自动忽略）。每项 `{name, doc}`，`doc` 按【作用】【能力】【边界】【注意】分节、换行分隔，文档统一定义于 `BUILTIN_SENSE_TOOLS.doc`（sense.tools 不携带 doc，避免下拉响应臃肿）。自定义/外部/MCP 工具不在内                                                                                                                                                                                                                                                                                                                                                     | 否   |
| `skills.list`                                   | 分页列出独立或插件技能。params `{page?,pageSize?,search?,plugin?}`，`pageSize` 最大 200，返回 `{skills,total,page,pageSize}`；目录扫描只解析 frontmatter，当前页才读取正文并计算 token。`plugin` 省略=独立技能、`*`=全部、具体值=该插件。                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `skills.listNames`                              | 角色装备使用的轻量目录，返回独立技能名、插件名以及各自系统提示词 token 汇总；不读取技能正文。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 否   |
| `skills.preImportUrl`                           | **前置**：拉取远端分支列表 + 探测鉴权需求。params `{url, credentialId?}` → `{gitNotInstalled, needsAuth, branches, defaultBranch?}` 或 `{gitNotInstalled: true}`。与 `plugins.preImportUrl` 区别：不返 `suggestedName/nameConflict`（技能多候选，冲突在 stage 时逐候选检测）。git CLI 硬性前提，缺失不降级                                                                                                                                                                                                                                                                                                                                                                                | 否   |
| `skills.importUrl`                              | 拉取 GitHub 仓库（独立技能集合）到 staging 分析候选（对标插件：分支选择 + 鉴权）。params `{url, branch, credentialId?}` 或 `{url, branch, username, password, remember?, label?}`（两组互斥）→ `{stagingId, candidates:[{name,description,trigger?,conflict}], branch?, commitSha?, commitDate?, savedCredentialId?}`（两阶段：前端确认后调 `skills.commit` 落盘）；`conflict=true` 表示 `skills_dir/<name>` 已存在，需前端逐项确认覆盖/跳过。鉴权失败抛友好错；`savedCredentialId` 仅 `remember=true` 时返。亦支持 `POST /api/skills/import` 上传 zip 字节走同一 stage 路径（zip 无 source 字段）                                                                                        | 否   |
| `skills.commit`                                 | 落盘 stage 候选为独立 skill。params `{stagingId, selections:[{name, import}]}`（`import:false` 跳过；`true` 导入，冲突则覆盖）→ `{imported:[...], skipped:[...]}`。若 staging manifest 携 git 来源 meta（URL 导入才有），按 {cloneUrl,branch} 写/更新中央来源索引 `.chery/.skill-sources.json`（`sourceId` 有→更新 commitSha/Date/skills；无→新建）。zip 导入无来源 meta，不写索引                                                                                                                                                                                                                                                                                                        | 否   |
| `skills.delete`                                 | 删除独立 skill 目录（`skills_dir/<name>`）。params `{name}` → `{ok:true}`；若该 skill 属某来源索引条目，同步从其 skills 列表移除。`plugins_dir` 下的插件 skill 不在此列（走 `plugins.uninstall`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 否   |
| `skills.listSources`                            | 返回仓库摘要 `{id,cloneUrl,branch,commitSha,commitDate,lastSyncedAt,skillCount,lastCheckedAt?,latestSha?,latestDate?,updateAvailable?,lastCheckError?}`，不展开关联技能。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `skills.checkSource` / `skills.checkAllSources` | 仅用远端 HEAD 检查单个或全部技能仓库是否有更新，持久化检查时间、版本和错误，不修改本地技能目录。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 否   |
| `skills.resyncSource`                           | 重新拉取某来源并返回候选及 `selected` 原跟踪技能；前端分页/搜索确认后才调用 `skills.commit` 覆盖。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        | 否   |
| `skills.resyncAllSources`                       | 批量重新拉取全部来源（非交互：自动 commit 仅匹配原 `entry.skills` 命名的 candidate，新增/删除静默丢弃）。params `{}` → `{results:[{sourceId, ok, error?, commitSha?, commitDate?}], successes, failures}`；失败条目同步写 `SkillSourceEntry.lastSyncError`（成功的清空），前端 refresh 后读持久化字段逐项标记「刷新失败」红 pill                                                                                                                                                                                                                                                                                                                                                          | 否   |
| `skills.deleteSource`                           | 删除一个来源索引条目 + 其跟踪的全部 skill 文件夹。params `{sourceId}` → `{ok:true}`（镜像 `plugins.uninstall` 语义）。已脱离来源的独立 skill（re-sync 时取消勾选的）不受影响                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 否   |
| `plugins.list`                                  | 列出已安装插件（`.chery/plugins/<name>/`）。返回 `{plugins:[{name, sourceUrl, cloneUrl, branch, commitSha, commitDate, installedAt, updatedAt, lastCheckedAt?, latestSha?, latestDate?, updateAvailable?, skills:[{name,description,trigger?}]}]}`，每项来自 `.chery-plugin.json` manifest + 扫描其 skills（`cloneUrl/branch/commitSha/commitDate` 旧 manifest 上为空串；检查字段从未检查时为 undefined）                                                                                                                                                                                                                                                                                 | 否   |
| `plugins.preImportUrl`                          | **前置**：拉取远端分支列表 + 探测鉴权需求 + 文件夹冲突。params `{url, credentialId?}` → `{branches: string[], defaultBranch, needsAuth, suggestedName, nameConflict}` 或 `{gitNotInstalled: true}`；`suggestedName = sanitizeName(repo)`，`nameConflict = pluginDirExists(suggestedName)`（冲突时前端展示「文件夹名」改名输入框）。git CLI 为硬性前提，缺失不降级                                                                                                                                                                                                                                                                                                                         | 否   |
| `plugins.importUrl`                             | 拉取 GitHub 整仓（superpowers 风格关联包）到 staging。params `{url, branch, credentialId?}` 或 `{url, branch, username, password, remember?, label?, pluginName?}`（两组互斥）→ `{stagingId, pluginName, existing, sourceUrl, branch, commitSha, commitDate, savedCredentialId?, skills:[...]}`；`pluginName` 在 `nameConflict=true` 时由前端提供以改名；`existing=true` 同名已装，`needsAuth=true` 鉴权失败不抛错；`savedCredentialId` 仅 `remember=true` 时返。详见 [./agent/plugin.md](./agent/plugin.md)                                                                                                                                                                              | 否   |
| `plugins.commit`                                | 落盘 staged 插件到 `plugins_dir/<name>/` + 写 `.chery-plugin.json` manifest（含 cloneUrl/branch/commitSha/commitDate + `updateAvailable=false`/`latestSha`/`lastCheckedAt=now`，刚装视为已检查最新）。params `{stagingId, overwrite}`（`overwrite=true` 覆盖同名）→ `{plugin: PluginInfo}`                                                                                                                                                                                                                                                                                                                                                                                                | 否   |
| `plugins.checkUpdate`                           | 检查单个插件版本更新，结果写回该插件 manifest。params `{name}` → `{currentSha, currentDate, latestSha, latestDate, lastUpgrade, updateAvailable}`；版本号 = commit 短 SHA（7 位）；私有仓 401 则 `latestDate` 空                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 否   |
| `plugins.checkAllUpdates`                       | 批量检查全部已安装插件，结果写入各自 manifest（`lastCheckedAt`/`latestSha`/`latestDate`/`updateAvailable`），前端 refresh 后读持久化字段。params `{}` → `{checked, updatesAvailable, failed:[{name, reason}]}`；单个失败（私有仓 needsAuth/网络错误）不中断整体                                                                                                                                                                                                                                                                                                                                                                                                                           | 否   |
| `plugins.update`                                | 按 `manifest.cloneUrl` + `branch` 重新 `git clone` 覆盖。params `{name}` → `{plugin: PluginInfo}`（更新 commitSha/commitDate/updatedAt + 置 `updateAvailable=false`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 否   |
| `plugins.uninstall`                             | 删除整个插件目录。params `{name}` → `{ok:true}`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           | 否   |
| `credentials.list`                              | 列出凭据池（密令**永不**回前端）。params `{}` → `{credentials: [{id, label, username}]}`（仅 id/label/username，无 ciphertext/iv/tag），供插件 / 未来 skills 复用                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 否   |
| `credentials.save`                              | 保存凭据到加密池（AES-256-GCM，存 `.chery/.secrets/git-credentials.json` 0600）。params `{username, password, label?}` → `{id}`；字段名 `password` 复用 logger 自动脱敏。详见 [./utils/secretStore.md](./utils/secretStore.md)                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 否   |
| `credentials.delete`                            | 按 id 删除凭据。params `{id}` → `{ok: true}`；id 不存在幂等返 `ok: false`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `prompts.list`                                  | 递归列出 `.chery/prompt/` 下全部 `.md`（含子文件夹，**排除全局 base `system.md`**），每项为相对 `.chery/` 的路径（如 `prompt/prefebMain/leader.md`）。供设置面板 `systemPrompt` 级联选择器（`el-cascader`）建目录树；叶 `value`=全路径=存储值。目录为空返 `[]`                                                                                                                                                                                                                                                                                                                                                                                                                            | 否   |
| `runtime.set`                                   | 原子设置 chat 的 brain + senseGroup + mcpServers（每轮可换）。`toolCall:false` 的 brain 只接受空工具组/MCP；preset chat 下仅 `brain` 生效（编制锁定，senseGroup/mcp 强制取创建快照；显式带不同值 fail loud）                                                                                                                                                                                                                                                                                                                                                                                                                                                                              | 否   |
| `chat.create`                                   | 创建聊天。可选 `preset`：从 `config.presets[preset].leader` 解析 brain+senseGroup+mcp+systemPrompt（编制快照入 metadata，运行后锁定）。主 pet 恒带 `preset`（旧 `config.default` 已并入「默认」预设）；显式 brain+senseGroup 路径仅子 agent 用                                                                                                                                                                                                                                                                                                                                                                                                                                            | 否   |
| `chat.list`                                     | 按范围列出聊天。params 必须含 `scope:'stage'\|'preset'\|'history'`；stage 只查询当前配置关联的各 preset 最新根及后代，preset 按需查询指定 `presetId/preset`，history 才加载完整目录。`includePreview=true` 时增返 `preview`/`turnCount`。历史 runtime 只展示、不校验。 | 否   |
| `chat.get`                                      | 获取聊天详情（流式载入历史）。response 包含 `canResume`、工作区、历史 runtime、`currentState?` 及问题权威快照；不初始化 Agent，不解析历史 runtime，不计算 context breakdown。 | 是   |
| `chat.delete`                                   | 删除聊天（目标为主 chat 即无 `parent_chat_id` 时，级联删其所有子 chat + 各自消息 + 清内存 runtime）；响应返回 `{chatId,deletedChatIds}`，后者是实际删除目标及全部后代的权威集合。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `chat.send`                                     | 发送聊天消息（`{chatId, prompt, attachments?}`）。Response.data 必含 `{chatId,runId}`；运行中再次发送仅入队并返 `{queued:true,runId:<活跃运行>}`，不会新建空流。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 是   |
| `chat.resume`                                   | 单会话续接（无 prompt，恢复执行 pending sense 或继续 loop）。Response.data `{chatId,runId}`；已有运行时返 `alreadyRunning:true`。用于错误/断连等非树级手动暂停的兼容恢复。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 是   |
| `chat.resumeTree`                               | 精确恢复一次树级暂停实际中止的运行。params `{rootChatId,pauseId,commandId}`，返回 `{rootChatId,pauseId,commandId,status,results}`；仅恢复仍对应原 paused run 且未被新操作接管的目标。相同 `commandId` 幂等返回原响应；部分失败以同一 `pauseId`、新 `commandId` 重试。响应非流式；各目标后续事件仍走 root subscription。                                                                                                                                                                                                                                                                                                                                                         | 否   |
| `chat.sync`                                     | **ChatSession hydration 水源**：补发 `afterSeq` 之后的持久事件。response 携 `{chatId,latestSeq,minSeq?,reset:false,backfilled?,snapshotSeq,currentState?,pendingQuestionBatches,runtime,preset,workspace,canResume,commandConfig}`；历史 runtime 只回显，不初始化 Agent 或计算 context breakdown。 | 是   |
| `chat.route.suggest`                            | 发送动作触发的会话目标选择（**流式**）。params `{presetId,draft,requestVersion}`；预设须绑定 `shadows.conversationRouting`。内部运行临时 Shadow，先流式推送 `type:'route'` chunk：`data.delta`（`{thinking,content}`，实时增量，前端累积）供前端路由小窗渲染；结束推送最终 `data`（=`{requestVersion,target:{chatId:string|null,confidence:number,reason:string},trace:{context:{draft,candidates},response:{content?,toolCall}}}`，无 `delta` 字段即最终）。`chatId:null` 表示新对话；Trace 仅供当前前端悬浮说明，后端不持久化。失败时消息不得发送，由用户手动选目标。                                                                                                                                                                                                                                                                    | 是   |
| `chat.timeline.get`                             | 获取 canonical timeline。传 `{rootChatId,view}` 时返回 CP2 root graph snapshot：持久 `nodes/edges`（**代际窗口**：当前代+上一代，`orderKey > windowFloor`，不足两代全量）、显式 `activeRuns/pendingInputs`、`revision/capturedEventSeq`、`generations`（L0 代际索引，无 compact 为 `[]`）；`createdAt` 仅展示，拓扑顺序使用 root 单调 `orderKey`。请求 `knownRevision >= revision` 时短路返回 `{chatId, revision, unchanged: true}`（无 nodes/edges/generations/messages）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 否   |
| `chat.timeline.generation.get`                  | 按需拉取单个已打包代际的完整图。params `{rootChatId, generationIndex}`（1-based，指向 `generations[].index`）→ `{rootChatId, generation: GenerationEntry, nodes, edges}`；直接按 `orderKey` 区间 `(fromOrderKey, boundaryOrderKey]` 读持久事实，不重跑 projector；代际不存在显式报错。供打包节点/代际卡片二层展开，前端 LRU 缓存。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `chat.branch.preview`                           | 预览从稳定节点分叉。返回 `{taskId,sourceBranchId,eligible,sideEffects,effectDigest,inheritedCompletedTasks,inheritedPausedTasks}`；继承任务由锚点前派发事实的因果闭包决定，不按墙钟完成时间决定。**anchor 属已打包代**（`orderKey <= 最后一代 boundaryOrderKey`）→ `eligible:false`，reason「只能在当前对话段内创建分支，已打包的历史不支持分支」；无 compact 不限制。                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `chat.branch.create`                            | 创建 `continuation` 或 `detail`。continuation 原子写入继承合并节点、首条用户输入、活动主干身份与未完成任务投递路由；detail 不改变主干。**分支仅限当前代**（同 preview 的代际校验，非当前代直接拒绝）。                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `chat.branch.activate`                          | params `{branchId,commandId}`。仅允许激活 `original/continuation`，原子切换任务唯一活动主干并重路由该分支因果闭包内尚未投递的 spawn task；不复制消息、不执行或恢复 Agent。返回 `{taskId,activeBranchId,activeChatId,deliveryGeneration}`。                                                                                                                                                                                                                                                                                                                                                                    | 否   |
| `chat.open` / `chat.close`                      | 原子建立/关闭 direct 或 root subscription。`chat.open` params 可携 `executionStepLimit?: int`（1..500）：严格限制 `state.executionSteps` 总数；活动步骤优先，活动数超限时保留最新的 limit 项，剩余额度再填最新终态。标准客户端省略时返回完整当前 run 窗口，lite 连接省略时默认 16。返回的 `eventSeq`/snapshot `capturedEventSeq` 是对应 chat/root journal 的实际持久化最高序号，空 journal 为 `0`；root snapshot 必须使用 root journal 水位。root open 的 fence 内同时返回 graph snapshot 与全部后代 transient state；snapshot 水位线后的事件才释放。root open 请求 `knownTimelineRevision >= revision` 时短路：省略 `rootTimeline`、返回 `timelineUnchanged: true`（`timelineChanged: false`），订阅栅栏与包含 `executionSteps` 的 `state` 照常。Root envelope 只进入 root reducer，不再按 `sourceEventSeq` 重复进入 per-chat reducer；direct open 也不能替换同连接的 root subscription。root patch 对未按需加载的 view 直接忽略；已缓存 view 的 revision gap 只刷新该 view，只有 root `eventSeq` gap 或 WebSocket 重连才重开 subscription。`chat.close` 仅取消观察，不暂停或终止 Agent；终止只能显式调用 `chat.abort`。                                                                                                                                                                                    | 否   |
| `chat.startSpawn`                               | 原子启动 `role_created` 携带的 `{taskId}`。同一 task 只会写入一次初始 user prompt；重放时会附着现有运行或恢复中断任务。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 是   |
| `chat.abort`                                    | 中止当前 chat 运行流；可选 `{runId,commandId}`。工作台对 root 调用时 `commandId` 同时作为 `pauseId`，持久化本次实际中止的 `chatId+runId` 目标集；`runId` 与活跃运行不同则返回 `CONFLICT`，重试返回同一结果。                                                                                                                                                                                                                                                                                                                                                                                                                                        | 否   |
| `chat.stopChild` / `chat.sendToChild`           | 保留的内部控制方法名；公开 websocket 调用一律拒绝。主 Agent 只能通过 `stop_child` / `send_to_child` senses 控制其 root 下的子 Agent。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 否   |
| `chat.attach`                                   | 刷新（F5）后重连运行中 run。params `{chatId}`，返回 `{chatId,running,attached?,currentState?}`。`!running` → 前端回落历史；`running` → 后端把该 run 后续 chunk/notification 重定向到本连接 ws（`liveOutputByChat[chatId]`）、取消断连 park、重建 owner 绑定。搭配随后的 `chat.sync` 回放补齐当前实时态。                                                                                                                                                                                                                                                                                                                                                                                  | 否   |
| `sense.approval`                                | 感官审批（accept/reject）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `sense.question.batchAnswer`                    | 原子回答完整批次。params `{chatId,batchId,answers:[{questionId,selectedLabels,optionNotes?,freeText?,cancelled?}]}`，必须恰好覆盖批次中所有 pending 项；服务端校验单/多选和合法 label，在同一事务中写入全部 sense 答案并关闭批次。返回 `{chatId,batchId,completed,shouldResume}`。                                                                                                                                                                                                                                                                                                                                                                                                                     | 否   |
| `sense.question.answer`                         | 旧单题兼容接口；仅允许单题批次，多题批次会拒绝并要求使用 `sense.question.batchAnswer`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 否   |
| `chat.timeline.node.get`                        | **lite P0（已实现）**：单节点按需全文详情。canonical params `{rootChatId, nodeId, sections?, offset?, limit?}` 保持 ≤32KB；工具分页可加 `toolCursor:{callIndex,field,offset}`。lite 连接每次投影一个 section，完整 RPC Response 严格 `≤maxFrameBytes`，响应 `page` 携最终装箱后的真实 `nextOffset`/`nextCursor`（详见下节）。低频、用户触发、只读，不改变 snapshot/patch 权威性；节流位（RATE_LIMITED）预留。 | 否   |
| `interaction.list`                              | **持久交互收件箱（跨断线/刷新/重启）**。params `{presetId?, includeActivity?, maxItems?}`：默认仅返回待办（status ∈ pending/resolving/blocked），`includeActivity: true` 含终态历史；`presetId` 过滤。排序：待办态优先，组内 created_at 升序 + updated_at 降序；**LIMIT 500 静默截断**（lite 传 `maxItems`（1..20）时改为单页窗口 + `hasMore`，详见「lite profile 连接级投影」节）。返回 `{interactions: InteractionData[], serverNow, hasMore?, truncations?}`（`serverNow` 恒带；approval payload 超长字段截断时附 `truncations`；结构见「interactions 数据存储」节）。审批遗漏/断线重连的重拉兜底就是此方法。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    | 否   |
| `interaction.approval.decide`                   | **收件箱审批决策**（推荐入口；`sense.approval` 并存）。params `{interactionId, action: 'accept'|'reject', expectedRevision, commandId, reason?}`：`interactionId = approvalId = sense call id`；`expectedRevision` 乐观锁（必须等于当前行 revision，不匹配报错刷新重试）；`commandId` 幂等键（见「命令幂等层」）。返回 `{interaction: InteractionData}`。特殊行为：**已过期审批（deadlineAt ≤ now）的调用返回成功响应**（interaction.status=expired，result={action:'reject'}）并自动恢复 Agent 继续跑，不报错——客户端必须以 interaction.status 为准；服务端重启后审批不在内存时自动 detached resume 重建（轮询最多 8s），恢复失败转 blocked。成功副作用：resolveApproval 解除 senseMiddleware await → interactions 转 completed → 广播 interaction.changed。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 否   |
| `interaction.question.answer`                   | **收件箱问题应答**。`sense.question.batchAnswer` 的收件箱化包装。params `{interactionId(=batchId), expectedRevision, commandId, answers:[{questionId, selectedLabels, optionNotes?, freeText?, cancelled?}]}`（校验规则同 batchAnswer：恰好覆盖、白名单 label、单选数、非空、cancelled 旁路；服务端对 selectedLabels 去重）。单事务写入全部答案 + interactions 转 completed + resumePending + 自动 detached resume。返回 `{interaction: InteractionData}`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 否   |
| `chat.input.submit`                             | **命令面用户输入**（chat.send 的命令化变体）。params `{chatId, commandId, clientMessageId, messageId, content, attachments?}`：`messageId` 为**客户端预分配的持久节点 id**（accepted input 与最终 timeline node 复用同一 id，树不删重建）；`commandId` 幂等键。行为：立即 ack 返回 `{chatId, inputId, clientMessageId, messageId, runId, state: 'started'|'queued', queueSequence, acceptedAt}`（运行中提交 state=queued 归并活跃 run），**执行与响应分离**——分离运行的最终 Response 不发客户端，run 可见性全靠通知流（input.updated/consumed/run.updated/done 等）。root-only：`controlRootChatId` 为内部专用（websocket schema 刻意剥离，WS 客户端对子 chat 提交恒拒「用户输入只能提交到主 Agent」）。内存队列上限 16，超限抛错（错误消息「输入队列已满，请稍后重试」）。**注：该上限错误当前 error.code 归 INTERNAL（INPUT_QUEUE_FULL 尚未注册为协议错误码，planned 见 mcu-lite-api.md D13）**。 | 否   |
| `bash.list`                                     | 列出当前 chat 挂起的 bash 进程                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 否   |
| `bash.kill`                                     | 显式杀死当前 chat 的挂起 bash 进程组                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 否   |
| `mcp.list`                                      | 列出所有 config 声明的 MCP server 及运行期状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 否   |
| `mcp.get`                                       | 单个 MCP server 详情（params: `{name}`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 否   |
| `mcp.connect`                                   | 连接单个 MCP server（已连幂等；params: `{name}`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 否   |
| `mcp.disconnect`                                | 断开单个 MCP server（未连幂等；params: `{name}`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 否   |
| `mcp.reload`                                    | 重载 MCP server（params: `{name?}`，给出→原子重载单个，省略→全量重读 config）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 否   |
| ~~`subagent.result`~~                           | **2026-07-09 废弃**：spawn 重构为 yield turn + 后端注入唤醒 + wakeScheduler 按策略唤主（[agent-pet.md §5.4](./agent-pet.md)），结果不再由前端 RPC 回传。handler + schema 删                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —    |
| `config.get`                                    | 读取 `.chery/config.yaml` 原文（**除 server 段**），供设置面板编辑。`roles.<type>.avatar` 可选；缺省时按角色名稳定生成内置头像。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 否   |
| `config.workspace.validate`                     | 在**后端所在主机**校验 `{workspace}`：空值有效（表示未限定）；非空必须为绝对、可访问的目录。返回 `{valid, error?}`，只读，不写配置也不触发重启；设置页用于预设工作区输入的即时红色警告。
| `config.workspace.browse.start`                 | 开启服务端文件夹浏览会话（设置页工作区「浏览」弹层）。params 必须为严格空对象 `{}` → `{sessionId, ttlMs, platform, sep, roots:[{path,name}], initialPath, includeFiles, error?}`。`roots` 为**生效浏览根明文**：**默认全盘可浏览**——POSIX 为 `/`、win32 为全部存在盘符，权限由系统对后端的实际访问报错把关；若配置了 `server.workspace_browse.roots` 白名单则收窄为该集合内（路径穿越、软链逃逸拒绝）。**`.chery` 系统配置目录恒不可浏览**。`initialPath` 空串=多根选择器，单根=直接列其子目录；无有效根时结构化返回 `error`（不抛 RpcError）。`sessionId` 用于后续 `list` 鉴权 + 会话级限流 + TTL 过期清理（默认 10 分钟）。 | 否   |
| `config.workspace.browse.list`                  | 懒加载列某目录子项（逐层钻取）。params `{sessionId, nonce, encPath, includeFiles?}`：`nonce` 为客户端每次请求新生成的 hex 一次性随机数；`encPath = xorEncrypt(nonce, 绝对路径或空串)`（空串=根选择层）；`includeFiles` 缺省取配置 `default_include_files`（默认 false 仅目录，为硬上限）。响应 `{nonce, encData}`：`nonce` 回显供校验一致，`encData = xorEncrypt(nonce, JSON.stringify(payload))`；`payload = {path, accessible, error?, entries:[{name,path,isDir,accessible}]}`。**权限限制由系统对后端的实际访问报错实现**（预期失败不抛错）：readdir 遇 EACCES/EPERM 返回 `{accessible:false, error:'下级无法加载（无权限）'}`，前端据此提示该目录下级不可再钻取。⚠ 载荷加密为**混淆级**（与登录同算法：nonce 明文随请求，主动中间人可解），仅防被动嗅探/日志明文泄漏；真机密性依赖 HTTPS/loopback。 | 否   |
| `config.save`                                   | 保存配置（params: 除 server 外全部字段）：zod 结构校验 + 业务校验（role kind、普通角色/Shadow 引用边界、Shadow 不可 mention、会话路由 Shadow 工具组、brain 引用、`supervision`、sense level、model/provider、systemPrompt 文件等）-> 通过则保留盘上 `server` 段不动、移除已废弃 `routingBrain`、`js-yaml` dump（无注释）写回 -> 返回 `{needRestart:true}`；失败返 `INVALID_PARAMS`、**不写盘**。重启后端后生效                                                                                                                  | 否   |
| `utils.models`                                  | 独立工具：基于用户提供的 `{provider, url, key?, fullUrl?}` 拉取可用模型列表。`provider` 支持 `openai`/`ollama`/`anthropic`；`url` 必填（API base URL，**须含版本前缀如 `/v1`**——版本段由用户填写、后端只拼端点）；`fullUrl=true` 时**不拼接**，直接用用户提供的地址访问（默认 false：按 provider 注册的端点模式拼接，见 [agent/provider.md](./agent/provider.md)「URL 解析与端点拼接」）；`key` 可选（ollama 通常无需，openai/anthropic 缺 key 或占位符 `$VAR` 未替换时返回中文友好 `error` 提示本地 LM Studio/vLLM 等不校验 key 的服务可填任意非空字符串，不抛 RpcError）。`anthropic` 走原生 fetch `GET {url}/models?limit=1000`，header `x-api-key`+`anthropic-version: 2023-06-01`。返回 `{models: [{id, name?, ownedBy?}], error?}`（anthropic `display_name` -> `name`，无 `ownedBy`）；请求失败时 `models` 为空数组、`error` 携带错误信息（非 RpcError，前端可展示）。后续该模块会扩展其他便捷信息查询工具 | 否   |
| `utils.testConnection`                          | 独立工具：使用未保存的 `{provider, url, key?, model, fullUrl?}` 构造单条“只回复 OK”消息，经 provider 的 Message + LLM Adapter 执行真实最小非流请求。`fullUrl=true` 时 URL 不拼接，直接用用户提供的地址访问（与 `utils.models` 同规则，正式 chat 也同规则）。成功返回 `{ok:true}`；失败返回 `{ok:false,error}`（非 RpcError）。不保存配置、不创建 chat、不写 DB、不经过 middleware/retry/sense，并跳过 `PreLLMRequest` hook；`mock` 无网络连通语义，返回失败说明                                                                                                                                                                                                                                                                                                                                             | 否   |
| `utils.openFile`                                | 打开指定文件（用配置的文本编辑器或系统默认）。`path` 相对 `CHERY_DIR`（如 `.env`、`.chery/config.yaml`）。优先使用 `global.textEditor` 配置的编辑器（支持 `$ENV` 占位符），未配置则由后端进程调用系统默认打开器（Windows: `cmd /c start`，macOS: `open`，Linux: `xdg-open`）。成功返回空对象，失败返 RpcError                                                                                                                                                                                                                                                                                                                                                                             | 否   |
| `utils.openConfigDir`                           | 在**后端所在主机**的系统文件管理器中打开配置目录。params 必须为严格空对象 `{}`；目标固定为 `join(getCheryDir(), ".chery")`，客户端不能传路径。远程浏览器调用时不会打开浏览器客户端机器的目录。成功返回空对象，失败返 RpcError                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 否   |
| `utils.editors`                                 | 检测后端主机可用的文本编辑器，返回 `{editors: [{name, command, available}]}`，供设置页选择 `global.textEditor`                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 否   |

#### `chat.list` 响应字段

每项 `ChatSummary`：

| 字段                                                                 | 类型                                                                 | 说明                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| -------------------------------------------------------------------- | -------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `chatId`                                                             | string                                                               | chat id                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `createdAt` / `updatedAt`                                            | number                                                               | 创建 / 最后运行时间戳（ms）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `messageCount`                                                       | number                                                               | 消息总数（冗余列，免 N+1）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| `parentChatId`                                                       | string \| null                                                       | 子 chat 关联主 chat；主 chat 为 null                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `preview`                                                            | string \| undefined                                                  | 仅 `includePreview=true` 返。首条 user 消息截断（≤40 字符），供会话列表辨识。"指令"跳过规则待定（默认 `isDirective=false`，取首条 user 消息）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `turnCount`                                                          | number \| undefined                                                  | 仅 `includePreview=true` 返。user 角色消息数 = 会话轮次                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `contextUsage` / `contextUsed` / `contextTotal` / `contextBreakdown` | number / [ContextBreakdown](../src/utils/token.ts) \| undefined      | 仅 `includePreview=true` 返。上下文用量比例（0-1）/ 已用 token / 上限 token / 6 段分解（系统·用户系统提示词·记忆·技能·工具定义·用户对话，各段 `{tokens,count?}`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `finished`                                                           | boolean \| undefined                                                 | 子 chat done 后置 true（`metadata.finished` 解析）。前端据 `finished===true` 把子 pet 重建为 ghost（灵魂态）。主 chat 恒无此字段                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| `pendingApproval`                                                    | `{ senseName: string; waitTime: number; createdAt: number } \| null` | 非 null = 该 chat 有 in-flight sense 审批待用户 accept/reject（approvalManager 内存索引命中）。`senseName` = 待审批感官名；`waitTime` = 审批窗口 ms（= `global.approval_timeout`，0 = 不限时）；`createdAt` = interrupt 触发时间戳（ms），前端倒计时 = `waitTime - (now - createdAt)`。null/缺省 = 无挂起审批。由后端 approvalManager 索引派生（轻量，无需 hydration），与 `chat.get`/`chat.sync` 的 `currentState.pendingApproval`（computeCurrentState 扫事件重建，单 chat 已 hydration 路径）一致——同为 approval 生命周期。供会话列表「琴键」闪烁提示（含未打开/未 hydration 的 chat）。**非请求参数**，恒返回（无则 null；响应未做 schema 校验） |

> `includePreview` 按 `messages_month` 分组批量查每 chat 首条 user 消息 + 计数，避免逐 chat N+1。lean 模式（省略）不查 messages，仅供 `initFromChats` 重建 pet 树。
> `pendingApproval` 与 `includePreview` 无关：无论 lean/includePreview 恒返回，源自 approvalManager 内存索引（非 messages 查询）。

#### CP2 root execution graph facts

`RootTimelineSnapshot` 是 timeline 与节点树共享的原子事实快照：

```ts
interface RootTimelineSnapshot {
  rootChatId: string
  view: 'conversation' | 'tree' | 'audit'
  revision: number
  capturedEventSeq: number
  nodes: TimelineNode[]
  edges: ExecutionEdgeFact[]
  activeRuns: ActiveRunFact[]
  pendingInputs: PendingInputSnapshot[]
  generations: GenerationEntry[]
  controlState?: TreeControlState
}
```

- 每个持久 node/edge 都有 root 级单调 `orderKey`；刷新只复用持久 ID/orderKey，不按时间重排身份。
- **代际窗口**：`nodes/edges` 只含 `orderKey > windowFloor`（当前代+上一代；不足两代全量），edges 两端须均在窗口内；服务端持久层仍全量。`generations` 为 compact 边界推导的 L0 代际索引（`{index, boundaryMessageId, boundaryNodeId, boundaryOrderKey, fromOrderKey, summary, nodeCount, createdAt, trigger}`，区间 `(fromOrderKey, boundaryOrderKey]`），无 compact 为 `[]`；更早代经 `chat.timeline.generation.get` 按需拉取。代际为推导计算，无新表（详见 [multi-agent-canonical-timeline.md](multi-agent-canonical-timeline.md) §3.5）。
- `tool-batch` ID 由服务端稳定生成；call 使用 `{callId,index,name,arguments,result?,status,childChatId?,targetChatId?}`，同批顺序只看 `index`。
- edge kind 为 `sequence | spawn | continue | dispatch | return | return-continuation`。跨 Agent 关系只读 edge fact，不读正文、角色名或相邻时间。
- termination 使用 `{actor,code,at,detail?,controlOperationId?}` 注记目标 node/turn，`code` 为 `user_abort | system_stop | watchdog | error | agent_redirect`，不得修改原 content。
- root patch operation 同时覆盖 node、edge、active run 与 pending input；upsert/remove/revoke 按事实 ID 幂等。**patch 为 diff 增量**：服务端缓存上次已发送 JSON，新增/变化 upsert、消失 remove（node→`remove`、edge→`remove-edge`、run→`remove-run`、input→`remove-input`）；单 chat canonical message 消失 → `remove`。缓存未命中（重启后首次）退化全量 upsert。窗口滑动（新 compact 定稿）时滑出窗口的节点以 `remove` 下发。base revision 缺口仍触发整体 resync。
- `parentNodeId`/`causationId` 仅为旧客户端读取兼容字段；CP2 新事实不再写入。旧 `spawnId` 只通过服务端 `callId -> owning batch/node` 索引保守回填，歧义记录为 `unknown`。

CP8 在上述事实契约上增加主 Agent 子任务控制：`stop_child` 使用稳定 command ID，可按后代到目标的顺序递归停止；`send_to_child` 对 running 子 Agent 入队、对 paused 子 Agent 创建新 turn，对 terminal 子 Agent 拒绝。用户只能向 root chat 提交输入；直接 child submit 与公开 child-control RPC 都会被服务端拒绝。stop 与自然完成竞争时，首个持久 terminal 状态获胜。

工作台树级暂停使用持久 `TreeControlState`：操作状态为 `pausing | paused | resuming | partial | completed | superseded`，目标状态为 `paused | resuming | resumed | delegated | skipped | failed`。续接只作用于本次暂停的 `paused/failed` 目标；已自然完成、已手动启动、已删除或已被 `send_to_child` 接管的目标不得被旧 `pauseId` 再次启动。

任务聚合快照额外返回 `activeBranchId`。`conversation_tasks.active_branch_id` 是主干身份唯一事实；`original` 只是分支来源类型，不等于永久主干。子任务的 `parent_chat_id` 保持原派发归属，结果实际投递读取 `delivery_chat_id/delivery_branch_id/delivery_generation`。完成方必须在写入前后校验 generation；若与主干切换竞争失败，重新读取最新路由后投递，避免结果写入已被替换的旧主干。

### MCP 管理 API

MCP 分**连接层**与**挂载层**，二者解耦：

- **连接层**（global registry）：哪些 MCP server 连着、其 sense 已注册进全局 senseRegistry。经 `mcp.*` RPC 热重载，**不重启服务**。
- **挂载层**（per-chat schema）：chat 启用哪些**已连** server → 其全部 `mcp__<server>__*` tools 合并进该 chat 的 LLM schema。经 `chat.create` / `runtime.set` 的 `mcpServers` 字段设置，**不走 sense_groups**。

> **关键边界：连接 ≠ 对 chat 可见。** `mcp.connect` 只把 server 接入 registry；chat 必须经 `mcpServers` 显式启用，其 tools 才进 schema。反之 `mcp.disconnect` 后，已启用该 server 的 chat 下次 resolve 时会 fail loud（NOT_FOUND）。

#### 连接层（mcp.\*）

| 方法             | params    | 返回                                        | 语义                                                            |
| ---------------- | --------- | ------------------------------------------- | --------------------------------------------------------------- |
| `mcp.list`       | `{}`      | `{servers: McpServerInfo[]}`                | 列出 config 所有 server + 状态（connected/disconnected/failed） |
| `mcp.get`        | `{name}`  | `{server: McpServerInfo}`                   | 单个详情；config 无名 → `NOT_FOUND`                             |
| `mcp.connect`    | `{name}`  | `{server: McpServerInfo}`                   | 已连幂等；config 无名 → `NOT_FOUND`                             |
| `mcp.disconnect` | `{name}`  | `{server: McpServerInfo}`                   | 未连幂等；反注册其 sense + close client                         |
| `mcp.reload`     | `{name?}` | `{servers, connected, failed, totalSenses}` | 给出 name → 原子重载单个；省略 → 重读 config 全量重载           |

`McpServerInfo`：

```typescript
{
  name: string;
  status: "connected" | "disconnected" | "failed";
  transport: "stdio" | "streamable-http";
  supervision?: number;      // server 级默认监管（0/1/2）
  senseNames: string[];      // 该 server 注册的 sense 名（仅 connected 非空）
  error?: string;            // status==="failed" 时的原因
}
```

**原子 reload**：单个 server 重载按「建新连接 → 同步 register 新 + unregister 旧差集 → close 旧」交换，注册表任意时刻对同名 sense 有效，无缺失窗口；建新失败则旧态保留。全量 reload 逐 server 容忍，单个失败计入 `failed` 不中断其他。

**幂等**：`connect` 对已连 server 为 no-op；`disconnect` 对未连 server 为 no-op（config 有名即成功，无名 `NOT_FOUND`）。reload 期间在途 `callTool` 接受降级（executor try/catch → 错误 content），同 SIGINT。

#### 挂载层（mcpServers）

`chat.create` / `runtime.set` 携带 `mcpServers: string[]`（enabled server 名，与 `senseGroup` 同层级、同原子性）：

```jsonc
// chat.create
{ "brain": "main", "senseGroup": "default", "mcpServers": ["filesystem"] }
// runtime.set
{ "chatId": "...", "brain": "main", "senseGroup": "default", "mcpServers": ["filesystem", "remote"] }
```

- enabled server 的**全部** `mcp__<server>__*` sense 合并进 LLM schema，监管用 sense 自带的 server 级 `supervision`（无 `:level` 覆盖，因绕过 sense_groups）。
- `mcpServers` 缺省 `[]`（关闭所有 MCP）；响应回显生效值（`brain.list` 的 `mcpServers` 返回当前已连 server 供前端渲染开关）。
- 持久化于 `metadata.runtime`，服务重启 `ensureChat` 自动恢复；旧 chat（无此字段）视为 `[]`，行为不变。
- enable 一个未连 server → `chat.create`/`runtime.set` 抛 `MCP server "X" not connected`（fail loud，NOT_FOUND 语义）。

详见 [core/mcp.md](./core/mcp.md)。

### HTTP API

Web 静态服务（端口 `config.server.webPort`，优先级 `WEB_PORT` 环境变量 > 本字段 > 默认 `8183`；原 `config.server.web_port` 已废弃；实现见 [service/http.md](./service/http.md)）除托管前端文件外，提供以下 HTTP 端点：

#### `GET /api/config`

返回可公开的服务配置，供前端自动构建 WebSocket 连接地址。

**响应示例：**

```json
{
  "wsPort": 8182,
  "webPort": 8183,
  "transport": "binary",
  "senseGroups": [
    { "name": "leader", "default": true },
    { "name": "plan", "default": false }
  ],
  "presets": [
    {
      "name": "默认",
      "leader": "coordinator_ali",
      "brain": "ali_glm5",
      "roles": ["coordinator_ali", "read_code", "read_image", "plan"],
      "shadows": { "conversationRouting": "conversation_router" }
    }
  ],
  "default": {
    "brain": "ali_glm5",
    "senseGroup": "leader",
    "mcpServers": []
  }
}
```

| 字段          | 类型                                      | 说明                                                                                                                                                                              |
| ------------- | ----------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `wsPort`      | number                                    | WebSocket 服务端口                                                                                                                                                                |
| `webPort`     | number                                    | Web 静态服务端口（来自 `WEB_PORT` 环境变量）                                                                                                                                      |
| `transport`   | string                                    | 传输格式：`binary` / `json`                                                                                                                                                       |
| `senseGroups` | `{name, default}[]`                       | config.sense_groups 全部键名 + `default` 标记（= 是否在「默认」预设 `leader` 角色的 `senseGroup` 内，供前端 AgentDialog 渲染单选 + 预选默认项）；config 无 sense_groups 时为 `[]` |
| `presets`     | `{name, leader, brain, roles:string[], shadows?}[]` | 全部预设（FAB 预设选择器用）；`leader`/`roles` 只含普通角色；`shadows.conversationRouting` 为可选会话路由 Shadow type                                                   |
| `default`     | object \| undefined                       | 派生自「默认」预设 `leader` 角色（brain+senseGroup+mcpServers）；AgentDialog 无 runtime 时预选用。无「默认」预设时不返此字段                                                      |

> 前端通过 `fetch('/api/config')` 获取配置，结合 `window.location.hostname` 自动构建 `ws://` 连接地址，无需硬编码端口。

#### 认证（用户名/密码）

`server.auth.username`+`password`（加盐 scrypt 哈希）配置后启用。**授权规则：本地 loopback 信任豁免；非本地未登录的接口请求 401 拒绝。** 登录成功签发双 token（HMAC 无状态）：access token（15min，`Authorization: Bearer` 或 WS `?token=`）+ refresh token（7d）。签名密钥 `server.auth.sessionSecret`（或环境变量 `CHERY_AUTH_SESSION_SECRET`）默认由后端启动自动生成 32 字节随机值并持久化到后端同级的 `.env`（`rootEnvPath`，即项目根 / exe 同级）跨重启复用——`.env` 是**唯一**的 env 文件，`.chery/` 下不再存放 `.env`；**失效/轮换：删除 `.env` 中该行后重启即重新生成，所有已签发 token 立即失效需重新登录**。

- `POST /api/auth/challenge` — 分发一次性登录挑战（公开，无需鉴权）：`200 {challengeId, nonce}`。`nonce` 供前端作为 keyHex 经 **SHA-256 CTR 流密码**加密凭据；challenge 单次使用、TTL 120s，解密后即作废（防重放）。纯 JS 实现（前端 `web/src/utils/obfuscate.ts`、后端 `xorDecrypt`），非安全上下文（非 HTTPS 远端）亦可用。仅密码认证模式启用，否则 `404`。
- `POST /api/auth/login` — body 为**加密凭据信封** `{challengeId, cipher}`（信封明文 = `JSON.stringify({username, password})`，keyHex = challenge nonce，`keystream = SHA-256(nonce_U8 || BE32(counter))` 逐字节异或）→ `200 {username, accessToken, refreshToken, expiresIn}`；challenge 无效/解密失败/凭据错误一律 `401 {error}`。`username` 供前端登录面板展示已登录用户信息（凭据不落明文在网）。
- `POST /api/auth/refresh` — body `{refreshToken}` → `200 {accessToken, expiresIn}`；无效 `401 {error}`。
- `GET /api/auth/me` — 空白验证：已登录 `200 {authenticated:true, user:{sub,username,isAdmin}}`，否则 `401 {authenticated:false}`。
- `POST /api/auth/logout` — 清 OAuth2 会话 cookie，`204`（密码认证前端自行丢弃 token）。

> **前端本地存储**：服务地址+用户名始终默认记住（`localStorage`）；「记住密码」默认关，勾选后密码经 **SHA-256 CTR 流密码**加密存本地（随机 32B keyHex 存 `localStorage`，base64 密文），下次预填（不自动登录）。

#### `POST /api/skills/import`

上传 ZIP 包导入独立技能（两阶段 stage→commit 的 **stage 入口**；raw bytes + `X-Chery-Session-Token` 鉴权，与 `/api/media/upload` 同模式）。

- **请求**：body 为原始 zip 字节，服务端解压到 `.chery/.staging/<uuid>/` 分析候选；鉴权同媒体端点（OAuth2 HttpOnly 会话或本地 session token）。
- **响应**：`200 {stagingId, candidates:[{name,description,trigger?,conflict}]}`（同 `skills.importUrl`）；`conflict=true` 表示 `skills_dir/<name>` 已存在。
- **失败**：`400 {error}`（解压或解析异常）。
- **下一步**：前端据 `candidates` 逐项确认后调 `skills.commit` 落盘。

## lite profile 连接级投影（已实现，P0）

> 面向 MCU/资源受限前端的连接级精简投影。**同一后端、同一 handler**：lite 连接的全部出站帧（Notification 与 RPC Response）经发送端投影裁剪；不带 profile 的连接行为完全不变。契约总纲见 [mcu-lite-api.md](./mcu-lite-api.md)（定稿 v3.1），节点投影（LeanTimelineNode）定义见 [multi-agent-canonical-timeline.md §3.6](./multi-agent-canonical-timeline.md)。本节只记录 wire 层事实。

### 连接声明与握手

- **URL 查询参数**：`?profile=lite&v=1`（与 `?token=` 同风格）。可选参数：`maxFrameBytes=N`（512–65536，缺省 4096，单帧字节预算）、`turnDelta=1`（订阅 turn.delta 单通道流，P1 语义，in_progress）。
- **未知版本拒绝（D14）**：`profile=lite` 但 `v` 不在支持列表时，握手期 `close(4001, JSON.stringify({supportedVersions: [1]}))`——设备在握手层机读判定，不进入消息循环（websocket/index.ts parseLiteProfile）。

### 信封最小化（lite 连接的 Notification 帧）

lite 连接的通知信封省略 `requestId / subscriptionId / eventSeq / rootEventSeq / sourceEventSeq`，保留 `type / chatId / runId? / seq`；`data.runId` 与信封 `runId` 重复时去重（仅保留信封位）。

### RPC Response 帧投影（timeline.get / chat.open）

lite 连接上 `chat.timeline.get` 与 `chat.open` 的响应经传输层投影（不改 handler 语义）：

- `rootTimeline.nodes` 逐节点映射为 **LeanTimelineNode**（字段集见 canonical §3.6.2；`contentLength` 为字符数口径，与 web 端 TimelineNode 一致；超预算截断时附 `contentHash`）；`edges` 置 `[]`（D7：conversation 顺序 = orderKey 全序）。
- **分页与预告（D6）**：节点数 > 20 时取 orderKey 最大的 20 条（最新窗口），响应附 `nodeCount`（窗口内总节点数）与 `hasMore: true`（≤20 时仅 `nodeCount`）。
- **游标分页（P1-2，已实现）**：lite 连接上 `chat.timeline.get` / `chat.open` 请求可携带 `before`（number = 上一页返回的 `nextCursor`，orderKey 排他下界：只返回 orderKey < before 的更早节点）与 `limit`（int 1..100，缺省 20）。响应增 `nextCursor`（number = 本页最小 orderKey，hasMore:true 时携带，客户端以它续拉）。与 P0 兼容：不带参数时行为与 P0 完全一致；nodeCount/hasMore 语义不变。**服务端按 maxFrameBytes 自动收缩 limit（T30）**：页大小 = min(请求 limit, maxFrameBytes−512B 信封开销可容纳的 lean 节点数)——从最新端（orderKey 大者）按 lean 实际序列化字节数装箱，超预算即止；至少保留 1 节点，hasMore/nextCursor 续拉补齐。收缩后 hasMore 判定为「实际下发页 < 窗口内总数」（含 total ≤ limit 但超字节的场景）。`interaction.list` 维持 P0 的 maxItems+hasMore 全量重拉窗口（T6 R8 决策不变，无 OFFSET 游标）。历史分页游标以 orderKey 直接表达（非 legacy chat.get 的 createdAt/id 复合编码）。
- **state 快照 lean 集（B-11）**：`activeTurns` → `{chatId, turnId, messageId, createdAt}`（去累计文本）；`run` / `runs[]` 在活动 run 上保留可选 `startedAt`（从持久 `run.updated` 重建，供断线后恢复总计时）；`questionBatches` → `{batchId, interactionId}`（去题干，详情走 interaction.list）；`runningTools` → `{id, senseName}`（工具名级）；`roles` → `{taskId, chatId, parentChatId, type, state}`（去 prompt 等长字段）；`pendingInputs` **保留 content**（冷启动恢复用户输入）。activeRuns/generations 等其余快照键保留。
- **执行步骤计时**：`state.executionSteps` / `currentState.executionSteps` 只保留 `ExecutionStep` 的计时字段，工具/模型名称最多 96 UTF-8 bytes。`chat.open.executionStepLimit`（1..500）是严格数量上限，lite 缺省 16；`running` 步骤优先，活动数超限时保留最新 limit 项，再以最新终态步骤填满。完整序列化响应仍受连接 `maxFrameBytes` 约束：超预算先移除最旧终态步骤，再移除最旧 timeline 节点（至少保留 1 个）并重算 `nextCursor`；若仍超预算，再淘汰最旧活动步骤，至少保留最新活动项。

### 事件截断引用（truncations）

lite 连接上，事件/响应中的超长字符串字段按字节预算截断后，载体对象附：

```
truncations: [{ field, contentLength, contentHash }]   // contentHash = 原文 sha256 hex
```

- `interrupt`（审批，G4 全量下发但字段级截断）与 `interaction.list` 响应 payload（approval arguments）共用该策略：**保留全部键名与短字段全文，仅超长单字段截断**（D3）；`field` 为被截字段名（嵌套为 `key.subKey` 形态）。
- `done.finalMessage.content` 截断至帧预算（maxFrameBytes − 信封开销），截断时附 `contentLength`（字符数）+ `contentHash`；全文经 `chat.timeline.node.get` 拉取。
- `interaction.list` 响应的 truncations 携带 `interactionId` 定位（`{interactionId, field, contentLength, contentHash}`）。

### interaction.list 的 lite 参数（已实现，handler 层，非 lite 亦可安全调用）

- 请求增 `maxItems`（int 1..20）：单页上限；服务端取 maxItems+1 探测，响应 `hasMore: true` 表示仍有未返回条目（无 OFFSET 游标，客户端重拉全量窗口）。未传时维持 LIMIT 500 全量窗口（现状不变）。
- 响应恒附 `serverNow`（服务端毫秒时间戳；设备无 NTP 时校准本地钟，倒计时 `remaining = deadlineAt − (now + Δ)`）。
- lite 连接的 `interaction.changed` 增携 `presetId`（D18，消多 agent 重拉放大；非 lite 连接不携带）。

### chat.timeline.node.get（新方法，已实现）

lean 摘要的按需全文出口（canonical §3.6.3）。非 lite/canonical 调用保留原能力：`{rootChatId, nodeId, sections?: ['content','thinking','toolCalls'], offset?, limit?}` → `{rootChatId, node, refs, hasMore, page?}`，单 handler 响应 ≤32KB；旧参数与完整节点能力不因 lite 预算改变。

lite 连接的详情规则：

- 每次请求一个 section。`content`/`thinking` 仍用 `offset`，口径是 JavaScript UTF-16 code unit；响应 `page:{section,offset,consumed,nextOffset?}`。客户端只能按 `nextOffset` 续拉，不能按请求 `limit` 自增。
- `toolCalls` 首次从 `toolCursor:{callIndex:0,field:'arguments',offset:0}` 开始。服务端每页只装一个调用的一个字段，遍历顺序为同一调用的 `arguments → result → 下一调用`；响应 `page:{section:'toolCalls',cursor,consumed,nextCursor?}`。`callIndex/offset` 是 `0..2^31-1` 整数，`field` 仅允许 `arguments|result`，游标对象拒绝未知字段，且不能与 legacy `offset` 同传。
- lite 投影先裁掉未请求 section 和 canonical 节点元数据，再以**完整序列化 RPC Response** 做精确装箱；正文、思考、工具字段及 JSON 转义膨胀都计入 `maxFrameBytes`。`page`/下一游标在最终收缩后生成，因此 `consumed` 是实际返回量。
- `success:false` 的 `node.get` Response 同样严格受 `maxFrameBytes` 约束：服务端按完整失败信封收缩 `error.message`。正常 `id/requestId` 原样保留；单个 correlation 的 JSON 序列化结果超过 128B 时，确定性降级为 `sha256:<64 hex>`，字段仍保留且同一原值重复请求得到同一标识。若成功页的基础节点/工具 metadata 已无法装入预算，服务端返回这种有界失败信封，不返回游标无法前进的成功页。
- `nextOffset`/`nextCursor` 缺失即终页；恰好命中 legacy `limit` 最多允许一次空终页探测。空页不返回同一游标，客户端也必须拒绝未前进游标，避免死循环。

截断/预算耗尽时可附 `refs: [{field, contentLength, contentHash}]`（contentLength 为原文字节数）。低频、用户触发、只读；节流位（RATE_LIMITED）预留。

## 命令幂等层（request_journal）

> 数据存储：soul.db `request_journal` 表（request_id PK / method / params_hash = sha256(method + '\n' + JSON(params)) / status(active|completed) / response_json / created_at / updated_at），保留 24h（claim 时惰性清理）。

`interaction.*` 与 `chat.input.submit` 的 `commandId` 走本层（与 Request.id 的协议层幂等是**两层独立机制**，本层跨服务重启持久化）：

| claim 结果 | 行为 |
|---|---|
| new（无记录） | 插入 active，正常执行 |
| completed 且指纹一致 | 原样重放存储的响应 JSON，不重复执行 |
| 指纹不一致（method 或 params 变了） | 报错「commandId 已用于另一条命令」 |
| active（并发处理中） | 报错「该操作正在处理中」 |
| handler 抛错 | abandonRequest 删除 active 行——同 commandId 同参可安全重试 |

## interactions 数据存储（持久交互收件箱）

> 数据存储：soul.db `interactions` 表（[src/db/index.ts](../src/db/index.ts)）。**跨断线/刷新/重启的用户可见交互事实源**；运行时审批 Promise（approvalRegistry）不是权威。

| 列 | 类型 | 说明 |
|---|---|---|
| interaction_id | TEXT PK | approval: = sense call id；question: = batchId |
| kind | TEXT | 'approval' \| 'question_batch' |
| chat_id / root_chat_id | TEXT | root 由 getRootChatId 派生 |
| preset_id / anchor_node_id | TEXT? | preset 来自 chat metadata；anchor：approval=approvalId，question=assistantMessageId |
| status | TEXT | 见下方状态机 |
| payload_json | TEXT | approval: {senseName, senseDescription?, arguments, supervisionLevel, security?}（**不含 waitTime/createdAt**——interrupt 通知才带，持久侧等价物是 deadline_at）；question: {assistantMessageId, questions:[…]}（与 question_batch_requested.data 同构） |
| deadline_at | INTEGER? | 仅 approval 且审批限时（waitTime>0）时 = createdAt + waitTime；question 恒 NULL。倒计时 = deadlineAt − now |
| result_json | TEXT? | approval: {action, reason?}；question: {answers:[{questionId, answerText, cancelled}]} |
| revision | INTEGER | 乐观锁 token：INSERT=1，upsert 重注册 / claim(CAS) / 状态迁移各 +1 |
| created_at / updated_at / completed_at | INTEGER | completed_at 仅终态写入 |

**状态机**：

```
pending ──claim(CAS: WHERE revision=?)──▶ resolving ──决策/应答──▶ completed（终态）
   │                                        │
   │ upsert 同 id 重注册：revision+1          │ 恢复失败/审批恢复窗口超时 → blocked（可再 claim）
   │ （resolving 保持 resolving，否则 pending）│ 审批 deadline 到点（仅 approval）→ expired（终态）
   └────────────────────────────────────────┘ cancelled：枚举存在，当前无写入方（预留）
```

- 终态行（completed/expired/cancelled）**永不被 upsert 复活**；服务重启后 register 命中终态行直接 replay 终态决定到重建的 core promise（accept 需 security 的 policyHash + assessmentHash 一致，否则强制 reject）。
- **deadline 生命周期**：后台 sweeper 每 1s 扫描过期 approval（pending 且 deadline_at ≤ now）→ 审批不在内存时先 detached resume 重建（轮询最多 8s）→ expire = interactions 转 expired + resolveApproval('reject','审批超时，工具未执行')（Agent 循环继续，非终止）。
- 对应 `InteractionData` RPC 返回结构：{interactionId, kind, chatId, rootChatId, presetId?, anchorNodeId?, status, payload, deadlineAt?, result?, revision, createdAt, updatedAt, completedAt?}。

## 版本定位（lite profile 依赖）

上述 interaction.* / chat.input.submit / 六种通知为**已实现（implemented）**，即 MCU lite profile（[mcu-lite-api.md](./mcu-lite-api.md)，P0 已实现）的 v1 基础。lite profile 的连接级裁剪、LeanTimelineNode 投影、`chat.timeline.node.get` 均已随 **P0 落地（implemented）**，wire 层事实（连接声明/信封最小化/Response 投影/truncations/node.get）见「lite profile 连接级投影」节；节点投影定义见 [multi-agent-canonical-timeline.md §3.6 精简投影（lite profile）](./multi-agent-canonical-timeline.md)。D13 扩展错误码（INTERACTION_STALE / INTERACTION_ALREADY_RESOLVED / COMMAND_CONFLICT / INPUT_QUEUE_FULL / PROFILE_VERSION_UNSUPPORTED / RATE_LIMITED）已随 T20 全部注册并按场景抛出（interaction handler 显式抛码；INPUT_QUEUE_FULL 复用既有错误类 code 自动透传；PROFILE_VERSION_UNSUPPORTED/RATE_LIMITED 为注册备用/预留位，见错误码表）。P1（turn.delta 可选订阅/分页细化/折叠调优/参考固件）为 in_progress（实现中）；P2（HTTP lite 面/短键名/maxFrameBytes 协商）保持 planned。

### 错误处理

错误响应结构：

```json
{
  "id": "...",
  "kind": "response",
  "requestId": "...",
  "success": false,
  "error": { "code": "INTERNAL", "message": "..." }
}
```

错误码：

| code               | 触发场景                                                    |
| ------------------ | ----------------------------------------------------------- |
| `INTERNAL`         | 未分类 handler 异常                                         |
| `CONFLICT`         | chat busy / 条件 abort 的 runId 与活跃运行不一致            |
| `TIMEOUT`          | 审批超时（以 `interrupt.data.waitTime` 为准，`0` = 不限时） |
| `METHOD_NOT_FOUND` | 方法未注册                                                  |
| `NOT_FOUND`        | chat / MCP server 等资源不存在                              |
| `INVALID_PARAMS`   | 参数缺失或非法                                              |
| `RUNTIME_SELECTION_REQUIRED` | 历史任务无法关联当前 preset/type，且本会话没有显式当前运行配置。只读历史仍可查看；仅发送/继续等执行入口返回此码，引导用户选择当前配置 |
| _（implemented，T20 已注册）交互命令专用码_ | INTERACTION_STALE（revision 过期，interaction.* decide/answer 乐观锁不匹配）/ INTERACTION_ALREADY_RESOLVED（审批/问题已处理）/ COMMAND_CONFLICT（commandId 冲突或处理中）/ INPUT_QUEUE_FULL（chat.input.submit 队列满，上限 16）/ PROFILE_VERSION_UNSUPPORTED（注册备用；握手期实际用 close(4001)）/ RATE_LIMITED（node.get 节流预留位，注册未触发）——见 [mcu-lite-api.md](./mcu-lite-api.md) D13。router toRpcError 按码透传（handler 抛带 code 错误）；message 保持中文用户面（F11）。测试断言见 test/service/interaction/errorCodes.test.ts |
