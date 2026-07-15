# Chat 子系统（service/chat）

> 源码 [src/service/chat/](../../src/service/chat/) ｜ 上级 [service/README.md](./README.md) ｜ 相关 [./message.md](./message.md)、[./websocket.md](./websocket.md)、[../agent/middleware.md](../agent/middleware.md)、[db.md](../db.md)、[../interaction.md](../interaction.md)

## 职责

service 层的核心枢纽。把 RPC 请求（`chat.*` / `sense.approval`）转成 agent 流式执行，并把内部 `MiddlewareChunk` 流转成协议层 Chunk/Notification，同时集中处理 DB 持久化与审批注册副作用。

- **流式执行**（send.ts）：`chat.send` / `chat.resume` 驱动 `AgentBuilder.run/resume`，处理末尾未完成撤回（`staged.reverse`）、跨连接并发绑定、运行中 send 仅入队。
- **副作用编排**（observer.ts）：统一消费 agent 内部 effect chunk（`message_created` / `message_updated` / `sense_pending` / `question_pending`），触发 DB 写（`addMessage` / `fillApprovalResult` / `markMessageReplaced`）与审批/问答注册（`approvalManager.register` / `questionManager.register`），abort 时 flush 兜底保证 DB 一致。
- **协议映射**（streamMapper.ts）：`MiddlewareChunk` → 协议 `Chunk` / `Notification`（`sense_end`→`interrupt`、`sense_accept/reject`→`accept/rejected`、`question_pending`→`question_requested`、`message_updated` 带 replace → `replaced` 等）。
- **运行时缓存**（runtime.ts）：`chatRuntimes: Map<chatId, {builder, selection}>`，单 chat 绑定 AgentBuilder（跨轮不重建），`ensureChat` 创建/恢复 + 持久化 runtime + 一次性加载历史。
- **chat 管理**（handler.ts）：`chat.create` / `list` / `get`（流式载入历史 + `canResume`）/ `delete`。
- **审批 service 侧**（send.ts `handleSenseApproval`）：转调 `approvalManager.confirm` → core `approvalRegistry.resolveApproval` 触发 senseMiddleware await。
- **问答 service 侧**（send.ts `handleSenseQuestionAnswer`）：转调 `questionManager.confirm` → core `questionRegistry.resolveQuestion` 触发 ask_user_question sense handler await（auto 路径，handler 内部 await，不走 approval 流）。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [src/service/chat/send.ts](../../src/service/chat/send.ts) | `handleChatSend` / `handleChatResume` / `handleSenseApproval` / `handleChatAbort` + `registerChatHandlers` |
| [src/service/chat/handler.ts](../../src/service/chat/handler.ts) | `handleChatCreate` / `handleChatList` / `handleChatGet`（流式历史 + canResume）/ `handleChatDelete` + `registerChatManageHandlers` |
| [src/service/chat/observer.ts](../../src/service/chat/observer.ts) | `observeAgentChunks`：消费 effect chunk 做 DB 副作用 + 审批注册，finally abort flush |
| [src/service/chat/streamMapper.ts](../../src/service/chat/streamMapper.ts) | `streamAgentChunks`：MiddlewareChunk → 协议 Chunk/Notification 映射 |
| [src/service/chat/runtime.ts](../../src/service/chat/runtime.ts) | `chatRuntimes` Map + `ensureChat` / `setRuntime` / `clearChatRuntime` / `abortChatRuntime` / `loadHistory` |

## 核心概念 / 导出

### runtime.ts —— chatRuntimes 缓存

```ts
interface ChatRuntime { builder: AgentBuilder; selection?: RuntimeSelection; }
const chatRuntimes = new Map<string, ChatRuntime>();

export async function ensureChat(chatId: string, selection?: RuntimeSelection): Promise<AgentBuilder>;
export async function setRuntime(chatId: string, selection: RuntimeSelection): Promise<void>;
export function clearChatRuntime(chatId: string): void;        // chat.delete / chat.abort
export function abortChatRuntime(chatId: string): void;        // builder.abort → compose.abort throw 注入
```

`ensureChat` 幂等：已存在直接返回（带 selection 则 `configureRuntime` 原子更新 + 持久化）；不存在则 `new AgentBuilder().build()` + 从 `metadata.runtime` 或显式 selection 解析 runtime + `loadHistory` 一次性注入内存。

`configureRuntime` 内部：`runtime.selection = selection` + `builder.configureRuntime(selection)` + `updateChatMetadata(chatId, {runtime: selection})`（持久化供重启恢复）。

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
     yield* streamAgentChunks(generator, rid, chatId, (msg) => { failureMessage = msg; })
   catch err:
     "approval aborted"（chat.abort 触发）→ 静默
     其他 → failureResponse = createResponse(rid, false, ..., createError(INTERNAL, err.message))
   finally:
     connectionManager.releaseChatConnection(chatId, ctx.connectionId)
   // 防御性：retry-yielded ErrorChunk（不 throw）经 streamMapper 收集的 message 也填入 failureResponse
   if failureMessage && !failureResponse: failureResponse = createResponse(rid, false, ..., createError(INTERNAL, failureMessage))
   return failureResponse ?? { chatId }
```

> 末尾未完成撤回**只在 chat.get 恢复场景**（服务重启后末尾留未完成周期）触发。正常运行中 loop 自动续接不会留 pending。详见 [../interaction.md](../interaction.md) chat.send。

### observer effect 消费（observer.ts）

```
for await chunk of generator:
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
  else: yield chunk                                     // 透传 stream/staged/sense_*/consumed/done/error
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
| `stream` | `createChunk("stream", rid, data, {chatId,runId})` | 流式增量；经 WS 发送前持久化时附 `seq`，断线由 `chat.sync` 重放（保留窗口外回退 `chat.get`） |
| `staged` | `createChunk("staged", rid, {type: stagedType, thinking?, content?, senseName?, arguments?, id?})` | 阶段完成 |
| `sense_end`（SenseTriggerChunk） | `createNotification("interrupt", rid, {approvalId:id, senseName, arguments, supervisionLevel, needsApproval: level>auto})` | 感官触发 |
| `sense_accept` | `createNotification("accept", rid, {approvalId:id, senseName, result})` | 执行成功 |
| `sense_reject` | `createNotification("rejected", rid, {approvalId:id, senseName, reason})` | 被拒 |
| `question_pending` | `createNotification("question_requested", rid, {questionId, senseName:"ask_user_question", question, header?, options, multiSelect, waitTime, createdAt})` | ask_user_question 感官触发（auto 路径，但走独立 chunk 推送 notification 而非 sense_started） |
| `consumed` | `createNotification("consumed", rid, {count})` | 输入入队 |
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
   catch / finally: 同 send（approval aborted 静默）
```

`agent.resume()`（builder.ts）：末尾有 pending sense → 置 `resumePending=true`，首轮 senseMiddleware skip chat 层、重发 `sense_end`→`interrupt`（按监管等级）；全 done → `run("")` 正常 loop。续接规则与交互序列见 [../interaction.md](../interaction.md) chat.resume，agent 侧实现见 [../agent/middleware.md](../agent/middleware.md)。

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

## 审批 service 侧流程（跨模块）

**P1-11 解耦后**：core（senseMiddleware）在 [core/sense/approvalRegistry.ts](../../src/core/sense/approvalRegistry.ts) 创建审批 Promise 并 `await`；service `ApprovalManager` 只存 `Set<approvalId>`，`confirm/abort` 转调 core registry。

> ⚠ `.claude/CLAUDE.md` 仍写「ApprovalManager 存 approvalResolve 回调」——**与代码不符**，以本文档为准。

```
1. chat.send → agent.run → checkpoint 产 sense_pending effect
2. observer 收 sense_pending → approvalManager.register(approvalId)   // 仅登记
3. streamMapper 收 sense_end → yield interrupt notification
4. websocket handleRequest 收 interrupt → setRequestApprovalId + `startApprovalTimeout(waitTime)`；`waitTime=0` 不限时
5. 客户端 sense.approval {approvalId, action, reason?}
   → handleSenseApproval → approvalManager.confirm(approvalId, action, reason)
     → core approvalRegistry.resolveApproval(id, action, reason)       // 解除 senseMiddleware await
6. senseMiddleware 继续：accept 执行感官 / reject 跳过
   → checkpoint 产 message_updated effect（confirm pending sense 的 content 回填）
7. observer 收 message_updated（非 replace）→ fillApprovalResult(chatId, id, {content, hash})
8. streamMapper 收 sense_accept/sense_reject → yield accept/rejected notification
```

agent 侧（SenseTriggerChunk 生成、await Promise、tool.ts）见 [../agent/middleware.md](../agent/middleware.md)。`ApprovalManager` 本身见 [./README.md](./README.md)「approval/manager」。

### abort 与 pending approval

- **chat.abort**（`handleChatAbort`）：`abortChatRuntime`（`builder.abort()` → `compose.abort` 注入错误到挂起 await → senseMiddleware catch → throw 传播退出整链）→ `forceReleaseChatConnection`（不校验 owner）→ `clearChatRuntime`。顺序关键：删 Map 前先取 builder 引用调 abort；pending sense content 保持 NULL，重连后 `chat.get` 仍 `canResume=true`。
- **ws 连接关闭**（[./websocket.md](./websocket.md) `connectionManager.close`）：不调 `gen.return()`（会与 senseMiddleware catch 的 yield 死锁），改 `approvalManager.abort(pending.approvalId)` → core `rejectApproval` 让 generator 正常 catch 结束。
- 两种路径下 senseMiddleware 的 await 都通过 core registry 的 reject 解除，使挂起 generator 可被 GC。`approval aborted` 异常在 `handleChatSend`/`handleChatResume` 内被识别为预期（chat.abort 引起），静默不报 error。

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
- [./websocket.md](./websocket.md)：chat 连接绑定、审批超时、close abort。

## 扩展点

- **新增 chat 级 RPC（流式）**：仿 `handleChatSend` 写 AsyncGenerator handler，`observeAgentChunks` 包 agent generator、`streamAgentChunks` 映射输出；`registerChatHandlers` 加注册。
- **新增 effect chunk 类型**：core middleware 产新 effect → observer.ts 加对应 DB 副作用分支；streamMapper 默认不透传内部 effect（`continue`）。
- **改 runtime 缓存策略**：当前 `chatRuntimes` 进程内 Map，单 chat 单 builder 跨轮不重建；若要 LRU 淘汰或跨进程共享，改 `ensureChat` 与 `clearChatRuntime`。
- **撤回策略调整**：`revokeTrailingCycle`（agent 层）决定撤回范围；service 侧 `markMessagesRevoked` + `staged.reverse` chunk 是固定落库与通知，撤回规则变更同步 [../interaction.md](../interaction.md)。
