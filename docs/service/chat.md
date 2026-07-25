# Chat 子系统（service/chat）

> 源码 [src/service/chat/](../../src/service/chat/) ｜ 上级 [service/README.md](./README.md) ｜ 相关 [./message.md](./message.md)、[./websocket.md](./websocket.md)、[../agent/middleware.md](../agent/middleware.md)、[db.md](../db.md)、[../interaction.md](../interaction.md)

## 职责

service 层的核心枢纽。把 RPC 请求（`chat.*` / `sense.approval`）转成 agent 流式执行，并把内部 `MiddlewareChunk` 流转成协议层 Chunk/Notification，同时集中处理 DB 持久化与审批注册副作用。

- **流式执行**（send.ts）：`chat.send` / `chat.resume` 驱动 `AgentBuilder.run/resume`，处理末尾未完成撤回（`staged.reverse`）、跨连接并发绑定、运行中 send 仅入队。
- **副作用编排**（observer.ts）：统一消费 agent 内部 effect chunk并落库。`question_batch_pending` 到达时先持久化完整 QuestionBatch，再转发给协议层，确保事件出站前答案目标已可写。
- **协议映射**（streamMapper.ts）：`MiddlewareChunk` → 协议 `Chunk` / `Notification`（`sense_end`→`interrupt`、`sense_accept/reject`→`accept/rejected`、`question_batch_pending`→`question_batch_requested`、`message_updated` 带 replace → `replaced` 等）。ask_user_question 不再产生 `sense_started`，问题指示器直接由批次投影派生。
- **运行时缓存**（runtime.ts）：`chatRuntimes: Map<chatId, {builder, selection}>`，单 chat 绑定 AgentBuilder（跨轮不重建），`ensureChat` 创建/恢复 + 持久化 runtime + 一次性加载历史。
- **chat 管理**（handler.ts）：`chat.create` / `list` / `get`（流式载入历史 + `canResume`）/ `delete`。
- **审批 service 侧**（send.ts `handleSenseApproval`）：转调 `approvalManager.confirm` → core `approvalRegistry.resolveApproval` 触发 senseMiddleware await。
- **问答 service 侧**（send.ts `handleSenseQuestionBatchAnswer` + wake.ts `resolveQuestionBatch`）：按 `chatId+batchId` 原子校验整批答案，在同一月库事务中更新全部 sense content、question_items 和 question_batches；随后同步内存 journal、set `resumePending`、持久化 `question_batch_completed`。旧单题 RPC 仅兼容单题批次。

## 前端 ChatSession 信息契约

后端不决定 Pet/HistoryDrawer 等具体 UI，但必须让前端仅靠一次 hydration + 后续事件即可构建完整会话投影。

- checkpoint 在每次 LLM turn 开始时预分配 assistant `msgId`，该 id 同时用于实时 stream、staged、最终落库、done finalMessage 和 sync replay。
- `runId` 标识一次 send/resume；工具循环中的每次 LLM 调用产生不同 `msgId`。
- 每个实时 stream delta 必带 `msgId` 和 `createdAt`。前端首次看到新 id 时建立空 streaming message，再追加 delta；Pet 和历史抽屉读取同一对象。
- `consumed` notification 携本次进入 journal 的完整 user messages（含真实 id），覆盖主 chat 排队输入和子 chat 初始 prompt。
- `chat.sync` response 携 session metadata/runtime/context/currentState/question snapshot；冷启动 `chat.sync(0)` 可构建完整 ChatSession，正常运行不再依赖 `chat.get` 收敛。
- 所有 live chat 事件先持久化再发 socket，并携 `seq`。前端以 `seq` 去事件重放、以 `msgId` 做消息 upsert。

running chat hydration 顺序固定：`chat.attach` 先建立实时输出重定向，但不推进客户端 cursor；随后 `chat.sync(lastSeq)` 填补缺口，sync response 在 `snapshotSeq` 边界应用权威快照，再继续消费更晚事件。attach snapshot 不得提前跳过当前 active message 的既有 delta。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [src/service/chat/send.ts](../../src/service/chat/send.ts) | `handleChatSend` / `handleChatResume` / `handleSenseApproval` / `handleChatAbort` + `registerChatHandlers` |
| [src/service/chat/handler.ts](../../src/service/chat/handler.ts) | `handleChatCreate` / `handleChatList` / `handleChatGet`（流式历史 + canResume）/ `handleChatDelete` + `registerChatManageHandlers` |
| [src/service/chat/contextUsage.ts](../../src/service/chat/contextUsage.ts) | `computeContextBreakdown`：6 段 token 用量分解（chat.contextUsage / chat.get 快照共用） |
| [src/service/chat/promptSnapshot.ts](../../src/service/chat/promptSnapshot.ts) | `handleChatPromptSnapshot`：重建 chat 当前 runtime 的 system prompt 全文 + 工具定义（chat.promptSnapshot RPC，供历史抽屉「上下文」hover 面板） |
| [src/service/chat/observer.ts](../../src/service/chat/observer.ts) | `observeAgentChunks`：消费 effect chunk 做 DB 副作用 + 审批注册 + child_done 调度，finally abort flush + 每条 chunk feed-dog 喂狗 |
| [src/service/chat/streamMapper.ts](../../src/service/chat/streamMapper.ts) | `streamAgentChunks`：MiddlewareChunk → 协议 Chunk/Notification 映射 |
| [src/service/chat/runtime.ts](../../src/service/chat/runtime.ts) | `chatRuntimes` Map + `ensureChat` / `setRuntime` / `clearChatRuntime` / `abortChatRuntime` / `loadHistory` |
| [src/service/chat/wakeScheduler.ts](../../src/service/chat/wakeScheduler.ts) | 唤醒策略调度器：`onChildDone` + `evalWakePolicy`（hasBarrier→all / first+immediate→唤 / first+deferred→兜底）+ `allChildrenFinished` + `parentHasBarrier` |
| [src/service/chat/wake.ts](../../src/service/chat/wake.ts) | `wakeParent(silent?)`（deferred/barrier 静默注入 / immediate 完整唤主）+ `handleAsyncWakeTimeout`（按 `watchdog.wake_on_timeout` 分支）+ `resolveQuestionBatch` + `rebuildWaitedChildren`（启动期按 policy 重建唤醒链） |

## 核心概念 / 导出

### runtime.ts —— chatRuntimes 缓存

```ts
interface ChatRuntime { builder: AgentBuilder; selection?: RuntimeSelection; }
const chatRuntimes = new Map<string, ChatRuntime>();

export async function ensureChat(chatId: string, selection?: RuntimeSelection): Promise<AgentBuilder>;
export async function setRuntime(chatId: string, selection: RuntimeSelection): Promise<void>;
export async function setSessionRoleRuntimes(
  chatId: string,
  primary: RuntimeSelection,
  roles: Record<string, RuntimeSelection>,
): Promise<{ applied: string[]; deferredRunning: string[] }>;
export function clearChatRuntime(chatId: string): void;        // chat.delete / chat.abort
export function abortChatRuntime(chatId: string): void;        // builder.abort → compose.abort throw 注入
```

`ensureChat` 幂等：已存在直接返回（带 selection 则 `configureRuntime` 原子更新 + 持久化）；不存在则 `new AgentBuilder().build()` + 从 `metadata.runtime` 或显式 selection 解析 runtime + `loadHistory` 一次性注入内存。

`configureRuntime` 内部：`runtime.selection = selection` + `builder.configureRuntime(selection)` + `updateChatMetadata(chatId, {runtime: selection})`（持久化供重启恢复）。

#### session.runtime.set —— 主角色 + 子角色编制（带回灌已存在子）

**调用方**：主 pet 发送界面（AgentDialog `handleSend`）提交前同步调用，确保本次发送的主角色 + 后续 spawn_role 模板 + 已存在子 chat 全部对齐新选择。

**分层语义**（修主发送界面改子角色 brain 不作用于已派发子的缺口）：

| 层级 | 行为 | 持久化 |
|------|------|--------|
| 主角色（`primary`） | 立即 `configureRuntime(primary, true)` 切换主运行时 | **不**写主 chat `metadata.runtime`（会话级模板，重启失效） |
| 子角色（`roles`）未来 spawn | 写入内存 `sessionRoleRuntimes`，`spawn_role` 时由 `getSessionRoleRuntime` 消费 | 不落库 |
| 子角色（`roles`）已存在子 | **回灌**：遍历父会话存活子 chat（`findChildChatsWithType`），按 type 匹配新 `roles`：idle/未加载子 `configureRuntime` + 写**子 chat 自己的 `metadata.runtime`**；running 子记 `deferredRunning`（不打断流，需用户先 abort→resume） | 子 chat `metadata.runtime` 持久化（重启自动恢复） |

**返回值** `{ applied: childChatId[], deferredRunning: childChatId[] }` 供前端展示反馈（fail-loud，规则12）。running 子不静默——前端 console.info 提示「需先停止再修改才能生效」。

### observer.ts —— observeAgentChunks

```ts
export async function* observeAgentChunks(
  generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
  chatId: string,
  getMessages: () => LLMResponse[],
): AsyncGenerator<MiddlewareChunk, void, unknown>;
```

包装 agent generator，对 effect chunk 拦截做副作用、其余 `yield` 透传给 streamMapper。内部维护 `syncedIds: Set<string>`（历史消息视为已落库，避免 abort flush 重复 INSERT 触发 UNIQUE 冲突）。

### streamMapper.ts —— streamAgentChunks

```ts
export async function* streamAgentChunks(
  generator: AsyncGenerator<MiddlewareChunk, void, unknown>,
  rid: string,
): AsyncGenerator<Chunk | Notification, void, unknown>;
```

### send.ts handler 签名

```ts
handleChatSend(ctx, data: ChatSendRequestData): AsyncGenerator<Chunk|Notification, ChatSendResponseData|Response>
handleChatResume(ctx, data: ChatResumeRequestData): AsyncGenerator<...>
handleSenseApproval(ctx, data: SenseApprovalRequestData): Promise<SenseApprovalResponseData>
handleChatAbort(ctx, data: ChatAbortRequestData): Promise<ChatAbortResponseData>
```

### handler.ts handler 签名

```ts
handleChatCreate(ctx, params): Promise<ChatCreateResponseData>        // 调 ensureChat 注入 runtime
handleChatList(ctx, params): Promise<{chats}>                          // 读冗余 message_count
handleChatGet(ctx, params): AsyncGenerator<Chunk|Notification, ChatGetResponseData>  // 流式历史 + canResume
handleChatDelete(ctx, params): Promise<{chatId}>                       // clearChatRuntime + deleteChat
```

## 关键流程 / 数据流

### chat.send 完整流程（send.ts `handleChatSend`）

```
1. getChat(chatId) 存在性校验
2. agent = await ensureChat(chatId)                     // runtime 已在 chat.create/runtime.set 注入
3. `runId = ctx.requestId`（单元调用无 requestId 时生成 UUID）；全部 chat 事件显式携带 `{chatId,runId}`
4. if agent.isRunning():                               // 运行中 send
     for await (_ of agent.run(prompt)) {}              // 迭代仅为触发 send body 入队 userInputs
     return { chatId }                                  // 不绑定连接、不走流、不撤回
5. connectionManager.bindChatConnection(chatId, ctx.connectionId)
     └─ 已被占用 → yield error + return 失败 Response（P0-3）
6. 恢复场景撤回（仅 idle）：
     revokedIds = agent.revokeTrailingCycle()           // 撤回末尾整个当前周期 AI 响应
     if revokedIds.length > 0:
       markMessagesRevoked(chatId, revokedIds)          // DB 落 revoked=1
       yield createChunk("staged", rid, {type:"reverse", messageIds: revokedIds})
7. try:
     generator = observeAgentChunks(agent.run(prompt), chatId, () => agent.getMessages())
     yield* streamAgentChunks(generator, rid, chatId, runId)   // 统一暂停语义：不再传 onError
   catch err:
     AgentAbortError / AgentParkError（chat.abort 或 WS 断连触发）→ 静默（归 paused）
     其他 → 仅记 error 日志（不再构造 failureResponse；loop 已停，末条保持可恢复态）
   finally:
     connectionManager.releaseChatConnection(chatId, ctx.connectionId)
   // 统一暂停语义：final Response 恒 success:true。AI 报错（retry 耗尽 ErrorChunk）等异常归 paused，
   // streamMapper 已下发 error notification（含 canResume）；前端据 canResume 显继续按钮。
   // 结束态（ended）仅 loop 自然完成（末条 assistant 无 senseCalls）。
   return { chatId, runId, ...(userMsgId ? { userMsgId } : {}) }
```

> 末尾未完成撤回**只在 chat.get 恢复场景**（服务重启后末尾留未完成周期）触发。正常运行中 loop 自动续接不会留 pending。详见 [../interaction.md](../interaction.md) chat.send。

### observer effect 消费（observer.ts）

```
for await chunk of generator:
  feedWatchdog(chatId)                                  // 每条 chunk 喂狗重置看门狗（非注册唤醒子自动忽略）
  message_created:
    if !syncedIds.has(message.id):
      addMessage(message.id, chatId, {role, content, thinking, senseCall, hash})
      syncedIds.add(message.id)
    continue                                            // effect 不透传
  message_updated:
    if patch.replace:                                   // 感官去重命中
      markMessageReplaced(chatId, id, {content, replace, originalContent})
      syncedIds.add(id)
      // 不 continue：透传让 streamMapper 转 replaced notification（实时更新历史 sense block）
    else:                                               // confirm 回填 content/hash
      fillApprovalResult(chatId, id, {content, hash})
      syncedIds.add(id); continue
  sense_pending:
    approvalManager.register(chunk.approvalId)          // 仅登记（P1-11）
    continue
  child_yield:                                          // 子 spawn 孙后 yield turn 本轮暂停
    logger.event('child.yield'); continue               // 不唤醒主、不设 finished
  child_done:                                           // 子 loop 真正完成
    if getWaitedParent(childChatId):
      updateChatMetadata(childChatId, { finished: true })  // 先持久化（聚合唤主时刷新读到）
      await wakeScheduler.onChildDone(childChatId, content) // 按 policy: silent 暂存 / resume 唤主
    continue
  else: yield chunk                                     // 透传 stream/staged/sense_*/consumed/done/error/question_batch_pending
catch err:                                              // 统一暂停语义：abort/park/真实故障皆归 paused
  if isAgentParkError(err): log('agent.paused', kind='park')        // WS 断连
  elif isAgentAbortError(err): log('agent.paused', kind='abort')    // 用户 chat.abort
  else: log('agent.paused', kind='unexpected', ...)                 // 真实故障（error 级，带 stack）
  // 不 wakeParent、不写 finished——子 chat 末条保持原样，computeCanResume 派生 canResume=true 待 resume
  throw err                                             // 传播 send 层（统一静默）
finally:                                                // abort 兜底 flush
  for m of getMessages():                               // 极端未 sync 的 user/assistant/sense
    if m.revoked: continue
    if role not in [user,assistant,sense]: continue     // system 仅内存（loadHistory），不入库
    if syncedIds.has(m.id): continue
    addMessage(...); syncedIds.add(m.id)
```

### streamMapper 映射表

| MiddlewareChunk.type | → 协议 | 说明 |
|---|---|---|
| `stream` | `createChunk("stream", rid, {msgId,createdAt,...delta}, {chatId,runId})` | 每次 LLM 响应的实时增量；`msgId` 在 checkpoint turn 开始时预分配并与最终 messages.id 相同。经 WS 发送前持久化并附 `seq`，断线由 `chat.sync` 重放。 |
| `staged` | `createChunk("staged", rid, {type: stagedType, thinking?, content?, senseName?, arguments?, id?, msgId?, role?, createdAt?}, {chatId,runId})` | 阶段完成。实时路径（`chat.send`/`resume` 执行中）`thinking_end`/`content_end` 携预分配 `msgId`+`createdAt`（`content_end` 另携 `role:"assistant"`），与 chat.get 回放同 id，供前端实时累积进 `stream.history` |
| `sense_end`（SenseTriggerChunk） | `createNotification("interrupt", rid, {approvalId:id, senseName, arguments, supervisionLevel, needsApproval: level>auto})` | 感官触发 |
| `sense_accept` | `createNotification("accept", rid, {approvalId:id, senseName, result})` | 执行成功 |
| `sense_reject` | `createNotification("rejected", rid, {approvalId:id, senseName, reason})` | 被拒 |
| `question_batch_pending` | `createNotification("question_batch_requested", rid, {batchId,assistantMessageId,createdAt,questions})` | 同一 assistant turn 的完整 ask_user_question 批次；observer 已先持久化领域状态 |
| `consumed` | `createNotification("consumed", rid, {count,messages})` | 输入入队；messages 为已写 journal 的规范化 user 消息，含真实 id，前端据此 upsert/rekey 乐观消息。 |
| `error` | `createNotification("error", rid, {message: errors[0].message})` | 软失败 |
| `done` | `createNotification("done", rid, null)` | loop 结束 |
| `message_updated`（带 replace） | `createNotification("replaced", rid, {id, content, originalContent, by})` | 感官去重 |
| `message_created` / `sense_pending` | `continue`（被 observer 消费） | 不进传输层 |

### chat.resume 流程（send.ts `handleChatResume`）

前置：`chat.get` 返回 `canResume:true`。无 prompt，首轮跳过 chat 层（不调 LLM）：

```
1. getChat 校验
2. agent = await ensureChat(chatId)
3. if agent.isRunning(): return {chatId}                 // 运行中 resume 无意义，避免误释放绑定（P0-1）
4. bindChatConnection（同 send）
5. try:
     generator = observeAgentChunks(agent.resume(), chatId, () => agent.getMessages())
     yield* streamAgentChunks(generator, rid)
   catch / finally: 同 send（approval aborted / park 静默）
```

`agent.resume()`（builder.ts）：末尾有 pending sense → 置 `resumePending=true`，首轮 senseMiddleware skip chat 层、重发 `sense_end`→`interrupt`（按监管等级）；全 done → `run("")` 正常 loop。续接规则与交互序列见 [../interaction.md](../interaction.md) chat.resume，agent 侧实现见 [../agent/middleware.md](../agent/middleware.md)。

**防御性 finalize**（[spawnFinalize.ts](../../src/service/chat/spawnFinalize.ts) `finalizeSpawnChildIfDone`）：`handleChatResume` 末尾若 `chat.parent_chat_id` 非空（子 chat）调一次。子 loop 暂停后经独立 `chat.resume` 续跑完成的场景，resume 路径本身不写 finished——此 helper 兜底：末条 assistant + 未 finished → `finishSpawnTask` + `updateChatMetadata({finished:true})`，保证子最终转 ghost（与 `handleChatStartSpawn` 路径一致，幂等，不调 wakeParent 避免重复唤主）。统一暂停语义下错误只归 paused 可续，最终一次 resume 跑完必须标 finished。

### chat.get 流式载入历史（handler.ts `handleChatGet`）

```
messages = getMessages(chatId)
for msg of messages:
  parsed = parseMessageRow(msg)
  if parsed.thinking: yield staged{type:"thinking_end", role, thinking}
  if parsed.content: yield staged{type:"content_end", role, content,
    ...(role==="sense" ? {id: msg.id} : {}),              // sense 结果带 id 供前端关联 sense block
    ...(parsed.replace?.state ? {replace, originalContent} : {})}
  if parsed.senseCall: for sc: yield staged{type:"sense_end", role, senseName, arguments, id: sc.id}
yield notification("loaded", null)
lastVisible = [...messages].reverse().find(m => !m.revoked)
canResume = !!lastVisible && (lastVisible.role === "sense" || lastVisible.role === "user")
return {chatId, canResume}
```

`canResume` 判定依据：末条 sense（pending / done 无后续 assistant）或末条 user（异常中断，resume Case2 复用末条 user 调 LLM）。详见 [db.md](../db.md)「状态判定」。

### 唤醒策略调度器（wakeScheduler.ts + wake.ts）

子完成唤主的单一调度入口，取代旧「child_done 直调 wakeParent」1:1 硬编码。介于 [observer.ts](../../src/service/chat/observer.ts) 的 child_done 分支与 `wakeParent` 之间，按 spawn 时声明的 **`WakePolicy`**（immediate/deferred/barrier，类型见 [spawnBroker.ts](../../src/agent/spawnBroker.ts)）决定 silent 暂存 / resume 唤主。

**onChildDone 流程**（[wakeScheduler.ts](../../src/service/chat/wakeScheduler.ts)）：

```
observer 收 child_done chunk
  → getWaitedParent(childChatId) 命中（非主 agent 自身）
  → updateChatMetadata(childChatId, { finished: true })   // 先持久化 finished，避免聚合唤主时刷新读不到
  → wakeScheduler.onChildDone(childChatId, content):
       shouldWake = evalWakePolicy(parentChatId, waited.wakePolicy)
       wakeParent(parentChatId, childChatId, type, content, { silent: !shouldWake })
```

**evalWakePolicy 判定矩阵**（运行时推导，每次扫 `findChatsByParent`，无持久 wake_mode）：

| 模式 | 当前完成子 policy | 判定 |
|------|------------------|------|
| all（主的子中存在 `wake='barrier'`） | 任意 | `allChildrenFinished(parent)` 才唤主，否则暂存 |
| first（无 barrier 子） | `immediate` | **唤主**（聚合已完成子结果） |
| first（无 barrier 子） | `deferred` | 暂存；若碰巧 `allChildrenFinished` 则唤主（兜底） |

**wakeParent silent 参数**（[wake.ts](../../src/service/chat/wake.ts)）：

```
wakeParent(parentChatId, childChatId, type, content, { silent? })
  ├─ 格式化 content：统一前缀 `[角色 ${type}] `（caller 已带则不重拼，idempotent）
  ├─ getChat(parentChatId) 不存在 → clearWaitedChild + 丢弃（子结果丢失，用户已删会话）
  ├─ builder = ensureChat(parent); parentWasRunning = builder.isRunning()
  ├─ msgId = builder.appendRoleReply(formattedContent, { silent })  // 内存 journal（守单一写者）
  │    └─ silent=true 不置 roleReplyPending；silent=false 置 roleReplyPending
  ├─ addMessage(msgId, parentChatId, { role:'role', content: formattedContent })  // DB 写（主 observer 未运行，不走 effect 路径）
  ├─ clearWaitedChild(childChatId)  // 释放唤醒链 + 看门狗，幂等
  ├─ if silent: logger.event('wake.silent') + return  // deferred/barrier 暂存终止
  ├─ if !parentWasRunning: updateChatMetadata(parent, { resumePending: true })  // 主 idle 时持久化唤醒意图
  ├─ 读子 metadata.spawnSenseCallId（= 触发 spawn 的 sense call id）
  └─ createNotification('role_reply', ...) + appendChatEvent + ws.send(findOwnerWsByChatId(parent))
       └─ ws 离线：logger.event('wake.offline')（resumePending 已落 DB，前端重连恢复）
```

**handleAsyncWakeTimeout（feed-dog 看门狗超时分支）**（[wake.ts](../../src/service/chat/wake.ts)，service 启动期 `setAsyncWakeHandler` 注入）：

```
子 timeout_ms（config.global.watchdog.timeout_ms，默认 5min）内无 chunk 喂狗 → 判定卡死
  wakeOnTimeout = config.global.watchdog.wake_on_timeout ?? false  // 默认 false
  if wakeOnTimeout:
    wakeParent(parent, child, type, "[角色 type] 子任务执行超时（已暂停，可在子会话点击继续）")
      └─ silent=false 完整唤主（通知主决策重派/放弃）
  else:
    clearWaitedChild(child)  // 不唤主也需释放唤醒链 + 看门狗
  abortChatRuntime(child) + clearChatRuntime(child)  // 释放挂死 generator + 内存
  // 子 chat 保持末条派生 canResume，用户可 resume 续跑
```

**看门狗与唤醒链解耦**（修问题2根因）：`wake_on_timeout=false`（默认）下，子卡死不影响主——主继续等真正完成的子唤主；子被 abort 后可由用户从子会话 resume 续跑。

**rebuildWaitedChildren（启动重建）**（[wake.ts](../../src/service/chat/wake.ts)，service/index.ts init 调，broadcaster / asyncWake 注入之后）：扫所有子 chat（parent_chat_id 非空）按 wake 策略分流：

- `finished=true`（子完成、崩溃前未唤主）→ 从 DB 末条 assistant content `wakeParent` 补注入：`wake='immediate'`（或旧记录无 wake 默认）→ `silent:false` 补唤主；`wake='deferred'/'barrier'`→ `silent:true` 静默注入。
- `finished!==true`（interrupted，turn 中断）→ `registerWaitedChild(childChatId, parentChatId, type, policy)` 重建链 + 重启看门狗（带 policy，待前端重连续跑子）。
- 内存态 waitedChildren 重启即丢，本函数从持久化 metadata（`wake` + `type`）重建，使唤醒链跨后端重启可恢复。

调度策略与协议影响详见 [../agent-pet.md §5.4](../agent-pet.md)。

## 审批 service 侧流程（跨模块）

**P1-11 解耦后**：core（senseMiddleware）在 [core/sense/approvalRegistry.ts](../../src/core/sense/approvalRegistry.ts) 创建审批 Promise 并 `await`；service `ApprovalManager` 只存 `Set<approvalId>`，`confirm/abort` 转调 core registry。

> ⚠ `.claude/CLAUDE.md` 仍写「ApprovalManager 存 approvalResolve 回调」——**与代码不符**，以本文档为准。

```
1. chat.send → agent.run → checkpoint 产 sense_pending effect
2. observer 收 sense_pending → approvalManager.register(approvalId)   // 仅登记
3. streamMapper 收 sense_end → yield interrupt notification
4. websocket handleRequest 收 interrupt → setRequestApprovalId（记 approvalId→requestId 供 close 时 park）。限时超时由 core approvalRegistry 独占（createApproval(id, global.approval_timeout)，见 tool.ts）；`approval_timeout=0` 不限时
5. 客户端 sense.approval {approvalId, action, reason?}
   → handleSenseApproval → approvalManager.confirm(approvalId, action, reason)
     → core approvalRegistry.resolveApproval(id, action, reason)       // 解除 senseMiddleware await
6. senseMiddleware 继续：accept 执行感官 / reject 跳过
   → checkpoint 产 message_updated effect（confirm pending sense 的 content 回填）
7. observer 收 message_updated（非 replace）→ fillApprovalResult(chatId, id, {content, hash})
8. streamMapper 收 sense_accept/sense_reject → yield accept/rejected notification
```

agent 侧（SenseTriggerChunk 生成、await Promise、tool.ts）见 [../agent/middleware.md](../agent/middleware.md)。`ApprovalManager` 本身见 [./README.md](./README.md)「approval/manager」。

### abort、断连宽限与 pending approval

- **chat.abort**（`handleChatAbort`）：`abortChatRuntime`（`builder.abort()` → `compose.abort` 注入错误到挂起 await → `senseMiddleware` catch → throw 传播退出整链）→ `forceReleaseChatConnection`（不校验 owner）→ `clearChatRuntime`。顺序关键：删 Map 前先取 builder 引用调 abort；pending sense content 保持 NULL，重连后 `chat.get` 仍 `canResume=true`。
- **WS 连接关闭**：不立即 `builder.abort()` 或 `approvalManager.park()`。connection 进入 `global.disconnect_grace_ms`（默认 15000ms）宽限期；期间同 requestId 重连则迁移流输出目标并继续当前 loop。
- **宽限期到期**：运行仍无新 owner 时设置 `requestParkAfterTurn(chatId, runId)`。当前 `runChain` 输出结束后 loop 边界抛 `AgentParkError`，observer 归 paused 并在 finally flush；不写 `finished`、不唤父、不注入错误 role。若断连时挂起审批，宽限期到期才调用 `approvalManager.park(approvalId)` 解除 await。
- **资源释放**：safe park 传播至 `handleChatSend`/`handleChatResume` 的 finally，统一 `releaseChatRun`、`releaseChatConnection`、清理 grace tracking。provider stream 真正无结束时仍由 watchdog/abort 兜底。
- **前端恢复**：重连只恢复 `running`/`canResume` 状态与断连窗口 `chat.sync`；`running=false + canResume=true` 只显示“继续”，禁止自动 `chat.resume`。用户点击后才启动新 requestId。

> `disconnect_grace_ms=0` 表示不等待；该配置是全局毫秒值，校验 `>=0` 且必须有限。

## 依赖与关联 ⭐

**被依赖：**

- [service/index.ts](../../src/service/index.ts)：`registerChatHandlers` + `registerChatManageHandlers`。
- [service/runtime/set.ts](../../src/service/runtime/set.ts)：`setRuntime`（runtime.set handler 调）。
- [service/chat/handler.ts](../../src/service/chat/handler.ts)：`ensureChat` / `clearChatRuntime`（chat.create / chat.delete）。

**依赖（模块内）：**

- runtime.ts ← send.ts / handler.ts / service/runtime/set.ts（ensureChat / clearChatRuntime / setRuntime）；调用方直接从 `runtime.ts` import，不再经 send.ts 转发。
- observer.ts ← send.ts（chat.send / chat.resume 包裹 agent generator）。
- streamMapper.ts ← send.ts（chat.send / chat.resume 映射输出）。

**依赖（跨模块）：**

- [@/agent/builder](../../src/agent/builder.ts)：`AgentBuilder`（build / configureRuntime / init / run / resume / revokeTrailingCycle / isRunning / getMessages / abort / hasPendingTrailingSense / setResumePending）。
- [@/agent/runtimeResolver](../../src/agent/runtimeResolver.ts)：`parseRuntimeSelection`（chat.create / runtime.set 校验）+ `RuntimeSelection` 类型。
- [@/core/middleware/types](../../src/core/middleware/types.ts)：`MiddlewareChunk` 各 variant、`LLMResponse` 类型。
- [@/core/message/adapter](../../src/core/message/adapter.ts)：`LLMResponse` 类型（observer getMessages 返回）。
- [@/core/config](../../src/core/config.ts)：`SupervisionLevel`（streamMapper 算 `needsApproval`）。
- [@/db/chat](../../src/db/chat.ts)：`createChat`/`listAllChats`/`getChat`/`getMessages`/`deleteChat`/`parseMessageRow`/`addMessage`/`fillApprovalResult`/`markMessagesRevoked`/`markMessageReplaced`/`updateChatMetadata`/`getChatRuntimeSelection`。详见 [db.md](../db.md)。
- [../approval/manager](../../src/service/approval/manager.ts)：`approvalManager.register`（observer）/ `confirm`（handleSenseApproval）。
- [../websocket/connection](../../src/service/websocket/connection.ts)：`connectionManager.bindChatConnection` / `releaseChatConnection` / `forceReleaseChatConnection`。
- [@/utils/logger](../../src/utils/logger/index.ts)：send/streamMapper 全流程日志。

**横切参考：**

- [../interaction.md](../interaction.md)：chat.send / chat.resume / 审批 / 恢复的端到端交互序列与流程图。
- [../agent/middleware.md](../agent/middleware.md)：senseMiddleware 如何产 SenseTriggerChunk / await approval Promise / accept/reject。
- [./message.md](./message.md)：Chunk/Notification 类型与工厂。
- [./websocket.md](./websocket.md)：chat 连接绑定、审批超时（approvalRegistry）、close park。

## 扩展点

- **新增 chat 级 RPC（流式）**：仿 `handleChatSend` 写 AsyncGenerator handler，`observeAgentChunks` 包 agent generator、`streamAgentChunks` 映射输出；`registerChatHandlers` 加注册。
- **新增 chat 级 RPC（非流式轻量）**：仿 `handleChatContextUsage` / `handleChatPromptSnapshot` 写 async handler，`registerChatManageHandlers` 加注册（`Method` + `requestSchemas` + RPC 类型 map 三处同步）。
- **新增 effect chunk 类型**：core middleware 产新 effect → observer.ts 加对应 DB 副作用分支；streamMapper 默认不透传内部 effect（`continue`）。
- **改 runtime 缓存策略**：当前 `chatRuntimes` 进程内 Map，单 chat 单 builder 跨轮不重建；若要 LRU 淘汰或跨进程共享，改 `ensureChat` 与 `clearChatRuntime`。
- **撤回策略调整**：`revokeTrailingCycle`（agent 层）决定撤回范围；service 侧 `markMessagesRevoked` + `staged.reverse` chunk 是固定落库与通知，撤回规则变更同步 [../interaction.md](../interaction.md)。

### chat.promptSnapshot —— 系统提示词快照

历史抽屉顶部「上下文」hover 面板展示**完整系统提示词**（非 token 用量，区别于 `chat.contextUsage`）。

- 重建基准：chat metadata 持久化的 `systemPromptFile` / `workspace` / `skillFilter` + `runtime` selection，与 init 期 `buildFirstSystemPrompt` / `RuntimeResolver.resolve` 同源（recompute-at-request，不入 DB、不缓存）。
- 返回两段：
  - `systemPrompt`：`buildFirstSystemPrompt` 全文（`<system-reminder>`+`<environment>`+`<workspace>`+`<memory>`+`<skills>`）。
  - `tools`：当前 runtime 启用的全部工具定义（含 mcp / `memory_manage`），统一 OpenAI 形状 `{name, description, parameters}`（剥离 provider 差异：OpenAI strict / Anthropic input_schema 在各自 provider 内转换，快照层不关心）。前端参数 schema 弱化展示（折叠 + 字段名/类型/required，不渲染 schema 全文）。
- 子 chat（`parent_chat_id` 存在）→ `injectMemoryManage=false`，与 init 期一致。
- selection 缺失（chat 无 runtime）→ `tools=[]`；systemPrompt 仍按 prompt 文件重建。resolve runtime 失败（感官组不存在 / MCP server 未连）→ fail loud 抛错，不静默返空。
