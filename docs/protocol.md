# WebSocket 协议规范

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
| `sense_started`                            | `{id, senseName, arguments}`                                                                                                 | sense_end（**仅 auto**；smart/manual 走 interrupt）。auto 工具开始执行信号，前端据 `id` 维护「运行中工具」列表（pet bar 右侧显 icon）；对应 `accept`（`approvalId=id`）到达时移除                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `accept`                                   | `{approvalId, senseName, result}`                                                                                            | sense 执行成功（全工具推；`approvalId`=sense 调用 id，前端据此移除「运行中工具」同 id 项）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `rejected`                                 | `{approvalId, senseName, reason}`                                                                                            | sense 被拒 / 审批取消                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             |
| `loaded`                                   | `null`                                                                                                                       | chat.get 历史发完                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 |
| `done`                                     | `{contextUsage, contextBreakdown, used?, total?, finished?, finalMessage?, canResume?}`                                      | chat.send/resume loop 结束。`contextUsage` = 当前 chat 总 token /（brain.contextLimit KB × 256）（0-1），前端据实时更新 pet.contextUsage（ContextBar）。CP7。`contextBreakdown` = 6 段分解 `{system,userSystem,memory,skills,tools,conversation:Segment, total, usage}`（各段 `{tokens,count?}`：系统/用户系统提示词·记忆（条数）·技能（skill 数）·工具定义（tool 数）·用户对话（消息条数，含 sense 调用结果）），前端据更新 pet.contextBreakdown 渲染分段进度条。`used`/`total` = 已用/上限 token。`finished`（boolean，仅子 chat 即 `parent_chat_id` 非空时携带）= 子 agent 已完成，前端据 `finished===true` 把子 pet 转 ghost（灵魂态保留）。done 时后端写 `metadata.finished` 持久化，刷新后 `chat.list` 暴露同字段重建 ghost。`canResume`（boolean，权威）= `computeCanResume` 派生：统一暂停语义下前端据 canResume 区分 paused（末条非 ended，显继续按钮）/ ended（末条 assistant 无 senseCalls，无按钮），取代旧 done→canResume=false 硬编码。`finalMessage`（`{msgId,role:"assistant",content,thinking?,createdAt,agentChatId?}`，仅本轮末条为 assistant 时携带）= 刚完成的权威回复，前端实时追加进 `stream.history`（PetIcons 圆点气泡即时显新内容，不再等 `chat.get` 重载）；`msgId` 供下次 `chat.get` 合流按 msgId 去重；`agentChatId` 标识该消息来源 chatId（默认 = 当前 chatId），供前端反向溯源（filter `agentChatId === X` 取该 agent 完整 history，无需正向溯源） |
| `error`                                    | `{message, canResume?}`                                                                                                      | agent generator 在流中抛出 error chunk 时触发（retry 耗尽 / maxLoop 超限）。统一暂停语义：AI 报错归 **paused**（非失败），`canResume`=`computeCanResume` 派生，前端据 canResume 显继续按钮（可重试）；final Response 恒 success:true                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                              |
| `replaced`                                 | `{id, content, originalContent, by}`                                                                                         | 感官去重命中，历史 sense 结果被新读取替换                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `role_created`                             | `{taskId, chatId, parentChatId, type, prompt, brain, senseGroup, wake}`                                                      | spawn_role sense 执行时。前端收此 notification → 创建子 pet + 调 `chat.startSpawn({taskId})` 原子领取任务；重放不产生第二次初始 prompt。事件外层 `chatId` = `parentChatId`。`wake ∈ 'immediate' \| 'deferred' \| 'barrier'`：唤醒策略（信息性，前端均驱动子跑；唤主时机由后端 wakeScheduler 决定，见 [agent-pet.md §5.4](./agent-pet.md)）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                        |
| `role_destroyed`                           | `{chatId}`                                                                                                                   | **已失去发出方**（`destroy_role` sense 移除，子 agent done 改转 ghost，见 [agent-pet.md §5.6](./agent-pet.md)。协议项保留作防御）；外层 `chatId` 为其主 chat。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                    |
| `role_reply`                               | `{parentChatId, childChatId, type, content, spawnSenseCallId?, msgId?}`                                                      | wake='immediate' 子完成 / wake 策略满足唤主时推（wakeScheduler evalWakePolicy 判定 shouldWake=true）。子 loop 结束后已把子结果以 role:role 注入主 chat DB，前端收此 notification → 自动 `chat.resume(parentChatId)`。**deferred/barrier 暂存路径不推此 notification**（wakeParent silent=true 仅注入 role + DB 写，主被将来某次唤主 resume 时消费）；`content` 仅即时展示，权威内容在主 chat；事件外层 `chatId` = `parentChatId`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `question_batch_requested`                 | `{batchId, assistantMessageId, createdAt, questions:[{questionId,position,question,header?,options,multiSelect,createdAt}]}` | 一个 assistant turn 的完整问题批次。`batchId = assistantMessageId`，服务端在所有 placeholder sense 和批次领域状态持久化完成后才发出；事件按 `batchId` 幂等，可安全重放。前端只保存本地草稿，不逐题回传。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| `question_batch_completed`                 | `{batchId}`                                                                                                                  | 整批答案已在单个 SQLite 事务中写入 sense 消息并关闭批次。事件进入 chat event log，前端收到或重放时仅清理对应批次；是否启动 `chat.resume` 由 `sense.question.batchAnswer` RPC 的 `shouldResume` 决定，避免重复续跑。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               |
| `question_requested` / `question_answered` | 旧逐题结构                                                                                                                   | 仅兼容历史事件和旧客户端；新前端不再据此构造问题状态。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            |

> `supervisionLevel` 为数字枚举（0/1/2，见 [core/sense.md](./core/sense.md)「Sense 监管等级」）。`needsApproval = supervisionLevel > 0`。auto sense（`needsApproval:false`）不推 `interrupt`（无审批需求，前端不弹审核卡）；仅 smart/manual 推送。`waitTime` = `global.approval_timeout`（ms，字段约束 `>= 0`：`0` = 不限时，不显倒计时；省略 = `0` 同义），`createdAt` = 发起时间戳（ms），前端据此算倒计时：`remaining = waitTime - (now - createdAt)`，归零后端超时 reject → `rejected` notification；用户 accept/reject 后前端立即关闭（不等 `accept`/`rejected` notification 回来）。`approval_timeout` 的范围校验在 [config.ts §validateRawConfig](./utils/config.md) 与 [schemas.ts §globalSchema](./service/message.md) 双层执行。

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
  currentTodo?: unknown[] // 最近一条 update_todo 的 arguments.todos（结构化）；无则省略
}
```

- `pendingApproval`：仅当挂起审批**仍存活**（`approvalManager` 内存命中，未被 confirm/park/超时清出）才返回；否则 `undefined`（run 已 paused，前端显继续按钮）。
- `runningTools`：running 时从内存/事件扫描，idle 时从事件扫描；含待审批工具（与 `pendingApproval` 同 id）。
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
| `chat.list`                                     | 列出所有聊天（`params.includePreview=true` 时每项增返 `preview`/`turnCount`，供会话列表渲染；省略=lean，供初始化重建 pet 树，避免 N+1）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 否   |
| `chat.get`                                      | 获取聊天详情（流式载入历史）。response 包含 `canResume`、上下文用量、`currentState?`（刷新当前态快照）及 `{snapshotSeq,pendingQuestionBatches}` 问题权威快照；旧会话首次读取时按 assistant message 自动回填批次。                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 是   |
| `chat.delete`                                   | 删除聊天（目标为主 chat 即无 `parent_chat_id` 时，级联删其所有子 chat + 各自消息 + 清内存 runtime；CP8）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 否   |
| `chat.send`                                     | 发送聊天消息（`{chatId, prompt, attachments?}`）。Response.data 必含 `{chatId,runId}`；运行中再次发送仅入队并返 `{queued:true,runId:<活跃运行>}`，不会新建空流。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 是   |
| `chat.resume`                                   | 单会话续接（无 prompt，恢复执行 pending sense 或继续 loop）。Response.data `{chatId,runId}`；已有运行时返 `alreadyRunning:true`。用于错误/断连等非树级手动暂停的兼容恢复。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 是   |
| `chat.resumeTree`                               | 精确恢复一次树级暂停实际中止的运行。params `{rootChatId,pauseId,commandId}`，返回 `{rootChatId,pauseId,commandId,status,results}`；仅恢复仍对应原 paused run 且未被新操作接管的目标。相同 `commandId` 幂等返回原响应；部分失败以同一 `pauseId`、新 `commandId` 重试。响应非流式；各目标后续事件仍走 root subscription。                                                                                                                                                                                                                                                                                                                                                         | 否   |
| `chat.sync`                                     | **ChatSession hydration 水源**：补发 `afterSeq` 之后的持久 chat 事件。`afterSeq` 仅是查询游标；response 的 `latestSeq` 始终表示 journal 实际持久化最高序号，空 journal 固定为 `0`，不得回显调用方游标。冷启动 `chat.sync(0)` 返回完整连续事件流；超窗时由消息合成回填旧历史并保留近期 active stream。response 携 `{chatId,latestSeq,minSeq?,reset:false,backfilled?,snapshotSeq,currentState?,pendingQuestionBatches,runtime,preset,workspace,canResume,contextUsage,contextUsed,contextTotal,contextBreakdown,commandConfig}`，前端在 snapshotSeq 边界一次构建/更新 ChatSession。                                                                                                                                                                                                                                         | 是   |
| `chat.timeline.get`                             | 获取 canonical timeline。传 `{rootChatId,view}` 时返回 CP2 root graph snapshot：持久 `nodes/edges`、显式 `activeRuns/pendingInputs`、`revision/capturedEventSeq`；`createdAt` 仅展示，拓扑顺序使用 root 单调 `orderKey`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `chat.branch.preview`                           | 预览从稳定节点分叉。返回 `{taskId,sourceBranchId,eligible,sideEffects,effectDigest,inheritedCompletedTasks,inheritedPausedTasks}`；继承任务由锚点前派发事实的因果闭包决定，不按墙钟完成时间决定。                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `chat.branch.create`                            | 创建 `continuation` 或 `detail`。continuation 原子写入继承合并节点、首条用户输入、活动主干身份与未完成任务投递路由；detail 不改变主干。                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `chat.branch.activate`                          | params `{branchId,commandId}`。仅允许激活 `original/continuation`，原子切换任务唯一活动主干并重路由该分支因果闭包内尚未投递的 spawn task；不复制消息、不执行或恢复 Agent。返回 `{taskId,activeBranchId,activeChatId,deliveryGeneration}`。                                                                                                                                                                                                                                                                                                                                                                    | 否   |
| `chat.open` / `chat.close`                      | 原子建立/关闭 direct 或 root subscription。返回的 `eventSeq`/snapshot `capturedEventSeq` 是对应 chat/root journal 的实际持久化最高序号，空 journal 为 `0`；root snapshot 必须使用 root journal 水位。root open 的 fence 内同时返回 graph snapshot 与全部后代 transient state；snapshot 水位线后的事件才释放。Root envelope 只进入 root reducer，不再按 `sourceEventSeq` 重复进入 per-chat reducer；direct open 也不能替换同连接的 root subscription。root patch 对未按需加载的 view 直接忽略；已缓存 view 的 revision gap 只刷新该 view，只有 root `eventSeq` gap 或 WebSocket 重连才重开 subscription。`chat.close` 仅取消观察，不暂停或终止 Agent；终止只能显式调用 `chat.abort`。                                                                                                                                                                                                                                                                                                                   | 否   |
| `chat.startSpawn`                               | 原子启动 `role_created` 携带的 `{taskId}`。同一 task 只会写入一次初始 user prompt；重放时会附着现有运行或恢复中断任务。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 是   |
| `chat.abort`                                    | 中止当前 chat 运行流；可选 `{runId,commandId}`。工作台对 root 调用时 `commandId` 同时作为 `pauseId`，持久化本次实际中止的 `chatId+runId` 目标集；`runId` 与活跃运行不同则返回 `CONFLICT`，重试返回同一结果。                                                                                                                                                                                                                                                                                                                                                                                                                                        | 否   |
| `chat.stopChild` / `chat.sendToChild`           | 保留的内部控制方法名；公开 websocket 调用一律拒绝。主 Agent 只能通过 `stop_child` / `send_to_child` senses 控制其 root 下的子 Agent。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     | 否   |
| `chat.attach`                                   | 刷新（F5）后重连运行中 run。params `{chatId}`，返回 `{chatId,running,attached?,currentState?}`。`!running` → 前端回落历史；`running` → 后端把该 run 后续 chunk/notification 重定向到本连接 ws（`liveOutputByChat[chatId]`）、取消断连 park、重建 owner 绑定。搭配随后的 `chat.sync` 回放补齐当前实时态。                                                                                                                                                                                                                                                                                                                                                                                  | 否   |
| `sense.approval`                                | 感官审批（accept/reject）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                 | 否   |
| `sense.question.batchAnswer`                    | 原子回答完整批次。params `{chatId,batchId,answers:[{questionId,selectedLabels,freeText?,cancelled?}]}`，必须恰好覆盖批次中所有 pending 项；服务端校验单/多选和合法 label，在同一事务中写入全部 sense 答案并关闭批次。返回 `{chatId,batchId,completed,shouldResume}`。                                                                                                                                                                                                                                                                                                                                                                                                                     | 否   |
| `sense.question.answer`                         | 旧单题兼容接口；仅允许单题批次，多题批次会拒绝并要求使用 `sense.question.batchAnswer`。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   | 否   |
| `bash.list`                                     | 列出当前 chat 挂起的 bash 进程                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 否   |
| `bash.kill`                                     | 显式杀死当前 chat 的挂起 bash 进程组                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                      | 否   |
| `mcp.list`                                      | 列出所有 config 声明的 MCP server 及运行期状态                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                            | 否   |
| `mcp.get`                                       | 单个 MCP server 详情（params: `{name}`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 否   |
| `mcp.connect`                                   | 连接单个 MCP server（已连幂等；params: `{name}`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 否   |
| `mcp.disconnect`                                | 断开单个 MCP server（未连幂等；params: `{name}`）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         | 否   |
| `mcp.reload`                                    | 重载 MCP server（params: `{name?}`，给出→原子重载单个，省略→全量重读 config）                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                             | 否   |
| ~~`subagent.result`~~                           | **2026-07-09 废弃**：spawn 重构为 yield turn + 后端注入唤醒 + wakeScheduler 按策略唤主（[agent-pet.md §5.4](./agent-pet.md)），结果不再由前端 RPC 回传。handler + schema 删                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                               | —    |
| `config.get`                                    | 读取 `.chery/config.yaml` 原文（**除 server 段**），供设置面板编辑。`roles.<type>.avatar` 可选；缺省时按角色名稳定生成内置头像。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          | 否   |
| `config.workspace.validate`                     | 在**后端所在主机**校验 `{workspace}`：空值有效（表示未限定）；非空必须为绝对、可访问的目录。返回 `{valid, error?}`，只读，不写配置也不触发重启；设置页用于预设工作区输入的即时红色警告。                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                  | 否   |
| `config.save`                                   | 保存配置（params: 除 server 外全部字段）：zod 结构校验 + 业务校验（`roles.<name>.brain` 引用必须存在于 `llm.brain`、`presets.*.roles[*]` 引用的 type 必须存在于 `config.roles`、`supervision` 合法值、`sense_groups` 的 `:level` 后缀合法、`llm.brain.*` 的 `model`/`provider` 必填、`systemPrompt` existsSync）-> 通过则保留盘上 `server` 段不动、`js-yaml` dump（无注释）写回 -> 返回 `{needRestart:true}`；失败返 `INVALID_PARAMS`、**不写盘**（结构校验失败：message 一行中文 + `tracingId`，完整 Zod issues 走 logger；业务校验失败：列出中文错误）。重启后端后生效                                                                                                                  | 否   |
| `utils.models`                                  | 独立工具：基于用户提供的 `{provider, url, key?}` 拉取可用模型列表。`provider` 支持 `openai`/`ollama`/`anthropic`；`url` 必填（API base URL，含版本前缀如 `/v1`）；`key` 可选（ollama 通常无需，openai/anthropic 缺 key 或占位符 `$VAR` 未替换时返回中文友好 `error` 提示本地 LM Studio/vLLM 等不校验 key 的服务可填任意非空字符串，不抛 RpcError）。`anthropic` 走原生 fetch `GET {url}/models?limit=1000`，header `x-api-key`+`anthropic-version: 2023-06-01`。返回 `{models: [{id, name?, ownedBy?}], error?}`（anthropic `display_name` -> `name`，无 `ownedBy`）；请求失败时 `models` 为空数组、`error` 携带错误信息（非 RpcError，前端可展示）。后续该模块会扩展其他便捷信息查询工具 | 否   |
| `utils.testConnection`                          | 独立工具：使用未保存的 `{provider, url, key?, model}` 构造单条“只回复 OK”消息，经 provider 的 Message + LLM Adapter 执行真实最小非流请求。成功返回 `{ok:true}`；失败返回 `{ok:false,error}`（非 RpcError）。不保存配置、不创建 chat、不写 DB、不经过 middleware/retry/sense，并跳过 `PreLLMRequest` hook；`mock` 无网络连通语义，返回失败说明                                                                                                                                                                                                                                                                                                                                             | 否   |
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
  controlState?: TreeControlState
}
```

- 每个持久 node/edge 都有 root 级单调 `orderKey`；刷新只复用持久 ID/orderKey，不按时间重排身份。
- `tool-batch` ID 由服务端稳定生成；call 使用 `{callId,index,name,arguments,result?,status,childChatId?,targetChatId?}`，同批顺序只看 `index`。
- edge kind 为 `sequence | spawn | continue | dispatch | return | return-continuation`。跨 Agent 关系只读 edge fact，不读正文、角色名或相邻时间。
- termination 使用 `{actor,code,at,detail?,controlOperationId?}` 注记目标 node/turn，`code` 为 `user_abort | system_stop | watchdog | error | agent_redirect`，不得修改原 content。
- root patch operation 同时覆盖 node、edge、active run 与 pending input；upsert/remove/revoke 按事实 ID 幂等。base revision 缺口仍触发整体 resync。
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

Web 静态服务（端口由环境变量 `WEB_PORT` 指定，默认 `8183`；原 `config.server.web_port` 已废弃；实现见 [service/http.md](./service/http.md)）除托管前端文件外，提供以下 HTTP 端点：

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
      "roles": ["coordinator_ali", "read_code", "read_image", "plan"]
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
| `presets`     | `{name, leader, brain, roles:string[]}[]` | 全部预设（FAB 预设选择器用）；`leader` = 组长角色 type 名，`brain` = 该角色使用的 brain，`roles` = 该预设引用的角色 type 名列表                                                   |
| `default`     | object \| undefined                       | 派生自「默认」预设 `leader` 角色（brain+senseGroup+mcpServers）；AgentDialog 无 runtime 时预选用。无「默认」预设时不返此字段                                                      |

> 前端通过 `fetch('/api/config')` 获取配置，结合 `window.location.hostname` 自动构建 `ws://` 连接地址，无需硬编码端口。

#### 认证（用户名/密码）

`server.auth.username`+`password`（加盐 scrypt 哈希）配置后启用。**授权规则：本地 loopback 信任豁免；非本地未登录的接口请求 401 拒绝。** 登录成功签发双 token（HMAC 无状态）：access token（15min，`Authorization: Bearer` 或 WS `?token=`）+ refresh token（7d）。签名密钥 `server.auth.sessionSecret`（或环境变量 `CHERY_AUTH_SESSION_SECRET`）默认由后端启动自动生成 32 字节随机值并持久化到 `.chery/.env` 跨重启复用；**失效/轮换：删除 `.chery/.env` 中该行后重启即重新生成，所有已签发 token 立即失效需重新登录**。

- `POST /api/auth/login` — body `{username, password}` → `200 {accessToken, refreshToken, expiresIn}`；凭据错误 `401 {error}`。
- `POST /api/auth/refresh` — body `{refreshToken}` → `200 {accessToken, expiresIn}`；无效 `401 {error}`。
- `GET /api/auth/me` — 空白验证：已登录 `200 {authenticated:true, user:{sub,username,isAdmin}}`，否则 `401 {authenticated:false}`。
- `POST /api/auth/logout` — 清 OAuth2 会话 cookie，`204`（密码认证前端自行丢弃 token）。

#### `POST /api/skills/import`

上传 ZIP 包导入独立技能（两阶段 stage→commit 的 **stage 入口**；raw bytes + `X-Chery-Session-Token` 鉴权，与 `/api/media/upload` 同模式）。

- **请求**：body 为原始 zip 字节，服务端解压到 `.chery/.staging/<uuid>/` 分析候选；鉴权同媒体端点（OAuth2 HttpOnly 会话或本地 session token）。
- **响应**：`200 {stagingId, candidates:[{name,description,trigger?,conflict}]}`（同 `skills.importUrl`）；`conflict=true` 表示 `skills_dir/<name>` 已存在。
- **失败**：`400 {error}`（解压或解析异常）。
- **下一步**：前端据 `candidates` 逐项确认后调 `skills.commit` 落盘。

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
