# Agent Middleware（中间件链）

> 源码 [src/agent/middleware/](../../src/agent/middleware/) ｜ 上级 [agent](./README.md) ｜ 审批 service 侧 [../service/chat.md](../service/chat.md) ｜ 交互 [../interaction.md](../interaction.md)

## 职责

把一次 LLM 调用展开为「流式增量 → 阶段完成 → 感官触发 → 感官执行 → 循环」的洋葱链。中间件负责**产生 chunk 与声明副作用意图**，不直接触达 DB / 审批 / WebSocket——这些由 [service observer](../service/chat.md) 消费 agent 输出的 effect chunk 完成。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [index.ts](../../src/agent/middleware/index.ts) | 聚合导出 + `defaultHandlers` 数组（定义洋葱执行顺序） |
| [checkpoint.ts](../../src/agent/middleware/checkpoint.ts) | 第 1 层：归纳 delta → staged chunk，构建 messages，声明 message/sense effect |
| [checkpointState.ts](../../src/agent/middleware/checkpointState.ts) | checkpoint 的状态封装：累积 delta、flushAssistant、sense 结果回写、senseDelta 合并 |
| [tool.ts](../../src/agent/middleware/tool.ts) | 第 2 层（sense）：Phase 1 收集 senseDelta + 触发；Phase 2 auto/confirm/manual 批量执行 + 审批 |
| [retry.ts](../../src/agent/middleware/retry.ts) | 第 3 层：捕获 chat 层错误，分类重试 MAX_RETRIES 次，失败 yield ErrorChunk |
| [chat.ts](../../src/agent/middleware/chat.ts) | 第 4 层（最内）：调用 LLM（流式/非流式），yield StreamChunk |
| [loop.ts](../../src/agent/middleware/loop.ts) | `createLoopHandler`：循环 runChain 直到无 senseCalls，超 maxLoop yield ErrorChunk，最终 yield DoneChunk |

## 核心概念

### 洋葱模型执行顺序（外 → 内）

```ts
// index.ts
export const defaultHandlers: MiddlewareHandler<MiddlewareChunk>[] = [
  checkpointMiddleware,  // 第 1 层（最外）
  senseMiddleware,       // 第 2 层
  retryMiddleware,       // 第 3 层
  chatMiddleware,        // 第 4 层（最内）
];
```

**含义：** 入站时 `checkpoint → sense → retry → chat`，出站 chunk 反向流回。每层 `yield* next()` 把控制权交给内层，再处理内层 yield 的 chunk。

每层职责（[index.ts 注释](../../src/agent/middleware/index.ts)）：

| 层 | 职责 |
|----|------|
| checkpoint | 归纳所有 chunk；生成 `staged`（thinking_end/content_end/sense_end）；构建并维护 `ctx.soul.messages`；声明 `message_created`/`message_updated`/`sense_pending`/`consumed` effect |
| sense | 收集 sense_end，confirm/manual 等审批，执行感官，yield `sense_accept`/`sense_reject` |
| retry | 捕获 LLM 调用错误，可恢复错误重试 3 次，不可恢复直接 yield ErrorChunk |
| chat | 调用 LLM（`llmAdapter.chatStream` 或 `chat`），yield `StreamChunk`（含 thinkingDelta/contentDelta/senseDelta） |

### Chunk 类型（运行时产出的子集）

来自 [core/middleware/types.ts](../../src/core/middleware/types.ts)。**agent 真正 yield 的 chunk：**

| chunk type | 产出层 | 说明 |
|------------|--------|------|
| `stream` | chat | 流式增量（thinkingDelta / contentDelta / senseDelta） |
| `sense_end` | sense | 感官触发（SenseTriggerChunk） |
| `sense_accept` / `sense_reject` | sense | 感官执行结果 / 拒绝 |
| `staged` | checkpoint | 阶段完成（thinking_end / content_end / sense_end） |
| `consumed` | checkpoint | 用户输入已入队 |
| `message_created` / `message_updated` | checkpoint | 声明副作用（observer 落库） |
| `sense_pending` | checkpoint | 声明审批待注册（observer 注册 ApprovalManager） |
| `question_batch_pending` | checkpoint | 同一 assistant turn 的完整待回答批次；仅在所有 placeholder sense 已写入 journal 后产生 |
| `error` | retry / loop | 重试失败或 maxLoop 超限 |
| `done` | loop | 整个 loop 结束 |

> `stream`/`sense_end`/`sense_accept`/`staged`/`consumed`/`done`/`error` 会流出到传输层（[protocol.md](../protocol.md)）；`message_created`/`message_updated`/`sense_pending` 是**内部 effect chunk**，service observer 消费后不发出传输层（[../interaction.md chat.send 注释](../interaction.md)）。

## 关键流程

### A. 一次完整 chain 执行的 Chunk 流向

以「LLM 返回 content + 1 个 auto sense_call，loop 第二轮纯文本回复」为例（[../interaction.md 流程 B](../interaction.md)）：

```text
【第一轮 chain】
chat 层      yield StreamChunk(content="我来读取")
                 ↓（流回）
checkpoint  收集 contentDelta，标记 contentActive
                 ↓
             （流结束）yield staged(content_end, content="我来读取")

chat 层      yield StreamChunk(senseDelta=[{index:0,name:"read_file",...}])
                 ↓
sense 层     检测 index 变化/流结束 → buildSenseTrigger
             yield sense_end(id, name, args, supervision=auto)
                 ↓
checkpoint  收到 sense_end：
               ① yield staged(sense_end, ...)
               ② flushAssistant → push assistant + yield message_created
               ③ supervision=auto，不创建 pending sense 消息
                 ↓
sense 层     Phase 2：auto 直接执行 doExecuteSense
             yield sense_accept(id, name, result, hash)
                 ↓
checkpoint  ingest(sense_accept) → 存入 senseResults（finally 落库）
             yield sense_accept（透传）

【checkpoint.finally】appendResponseMessages：
   - 未 flush 的纯 content/thinking → 创建 assistant + message_created
   - sense_accept → 创建 sense 消息 + message_created（或 recovery 原地更新）

【loop 判定】lastVisible.role==="sense" → continue，进入第二轮 chain

【第二轮 chain】LLM 基于 sense 结果回复纯文本
chat → checkpoint → finally → assistant(无 senseCalls)

【loop 判定】lastVisible.role==="assistant" && !senseCalls → break
【loop 结束】yield done
```

### B. 审批流程（confirm/manual，agent 侧）

完整跨模块流程见 [../interaction.md 流程 C](../interaction.md) 与 [../service/chat.md](../service/chat.md)。agent 侧的关键节点：

```text
sense 层 Phase 1：buildSenseTrigger(ctx, id, name, args)
  ├─ supervisionLevel > auto？
  │    └─ 是：approvalPromise = createApproval(id)   ← core/sense/approvalRegistry
  └─ yield sense_end(id, name, args, supervisionLevel)
       ↓（流回）
checkpoint 收到 sense_end：
  ├─ yield staged(sense_end, ...)                     ← 触发 web interrupt notification
  ├─ flushAssistant（push assistant + message_created effect）
  ├─ supervision > 0：
  │    ├─ pending sense 消息不存在 → push 空 content 的 sense 消息 + message_created
  │    └─ yield sense_pending(approvalId, ...) effect  ← observer 注册 ApprovalManager
  └─ supervision = 0：无 pending 创建

sense 层 Phase 2：executeCollectedCalls
  ├─ auto calls → 立即 doExecuteSense → yield sense_accept
  └─ needsApproval（confirm/manual）：
       ├─ await Promise.all(approvalPromise)           ← 阻塞，等 service.confirm
       │     （service: sense.approval → resolveApproval(id) 解除本 await）
       ├─ 客户端断连/超时 → approvalRegistry reject → catch 抛 "approval aborted"
       │     ⚠ throw 传播（不 return、不 yield sense_reject），pending sense 保持 NULL
       └─ 每个 decision：accept → doExecuteSense → yield sense_accept
                          reject → yield sense_reject(id, name, reason)
```

**几个非显然设计（[tool.ts](../../src/agent/middleware/tool.ts) 注释）：**

- `approvalPromise` 不随 chunk 传递——P1-11 重构后改为 `createApproval(id)` 在 core 的 `approvalRegistry` 管理，service 调 `resolveApproval/rejectApproval` 触发。chunk 只带 `approvalId` 字符串。
- 审批被 abort 时 **throw 而非 return**：return 只结束 `senseMiddleware`，loop 会误以为本轮完成继续第二轮 LLM 调用，破坏「应停在 pending sense 待 canResume」的语义。

### C. 问答流程（ask_user_question，agent 侧）

ask_user_question 是特殊感官：`SupervisionLevel.auto`（不走 approval 流），采用 **yield-turn 模型**（镜像 `spawn_role wait=true`，不阻塞 await）。handler 立即 `ctx.yieldTurn()` + 返回**非空占位** content `"(等待用户回答…)"`；loop 末 `yieldTurn=true` → break。checkpoint 收集本 turn 的全部提问，等 placeholder sense 全部进入 journal 后才产生一个 `question_batch_pending`，批次 ID 使用稳定的 assistant message ID。

**答案到达后原子更新 + resume**：用户 `sense.question.batchAnswer` → service 在一个 SQLite 事务中校验并更新批次全部 sense content + 关闭 batch → 同步内存 journal → set `resumePending` + 持久化 `question_batch_completed`。RPC 返回 `shouldResume:true` 后前端启动 `chat.resume`，新一轮 LLM 一次看到整批答案。

**不重跑关键**：占位 content 非空 → `hasPendingTrailingSense()`=false → resume 走 Case2（`run("")`），`executeResumePending` 永不为 ask 触发，无重复提问/死循环。

```
1. tool.ts buildSenseTrigger(ctx, id, "ask_user_question", argsJson):
     └─ yield SenseTriggerChunk(type:"sense_end", id, name:"ask_user_question", supervisionLevel:0)

2. checkpoint.ts 收 trigger：
     └─ name==="ask_user_question" → safeJsonParse(argsJson) → 收集为本 turn 的 question candidate

3. executeCollectedCalls auto branch:
     await doExecuteSense → handler (ask.ts):
       ctx?.yieldTurn?.() + return { content: "(等待用户回答…)" }  ← 立即返回，不 await
     → sense_accept（占位 content）→ loop 末 yieldTurn → break → done/child_yield

4. checkpoint finally 将全部 placeholder sense 变更先 yield 给 observer 落库，再产生 question_batch_pending

5. observer 持久化 question_batches/question_items → streamMapper 推 question_batch_requested（chat.send 流内进入事件日志）

6. ...（时间流逝；agent idle 等待，WS 已释放）...

7. 前端 QuestionCard 用户逐题编辑草稿，最后一步提交整批：
     → agentApi.answerQuestionBatch(chatId, batchId, answers[])
     → handleSenseQuestionBatchAnswer → resolveQuestionBatch
       → 单事务写完全部答案 + 关闭批次
       → completeSenseResult 同步内存 + set resumePending + 推 question_batch_completed

8. batchAnswer response.shouldResume → resumeAgent → chat.resume → 新 loop（末条 sense → continue）→ LLM 见全部答案
```

与审批的关键差异：审批在 middleware 层 await（handler 同步），靠 pending sense（content 空）+ canResume 续接；问答用 yield-turn（不 await、释放 turn），靠持久化 QuestionBatch + placeholder sense + 原子 batchAnswer 触发 resume。问答不限时。
- `sense_pending` effect **始终 yield**（即便 pending sense 消息已存在，如 resume 续接场景）——resume 时 pending 已落库，仅注册 ApprovalManager 避免重复 INSERT。

### C. checkpoint 的三 delta 状态机

[checkpoint.ts](../../src/agent/middleware/checkpoint.ts) 用两个布尔标记 `thinkingActive`/`contentActive` 跟踪当前阶段，按 stream chunk 的 delta 字段切换：

| chunk 字段 | 切换动作 |
|------------|----------|
| `thinkingDelta` | `thinkingActive = true` |
| `contentDelta` | 若 thinkingActive → yield `staged(thinking_end)`；`contentActive = true` |
| `senseDelta[]` | 若 thinkingActive → yield `staged(thinking_end)`；若 contentActive → yield `staged(content_end)` |
| 流结束 | 残留 thinkingActive/contentActive → yield 对应 staged |

> 三种 staged 的语义是「这一段已完整」，主要用于 chat.get 历史回显和前端分段渲染。sense_end 的 staged 在收到 `sense_end` chunk 时直接 yield（不依赖 delta 累积）。

### D. senseDelta 合并（流式 sense_call 重组）

OpenAI 流式响应把一次 tool_call 拆成多个 delta（首个带 id/name，后续只有 arguments 片段）。[checkpointState.ts mergeSenseDeltas](../../src/agent/middleware/checkpointState.ts) 按 `index` 累积：

```ts
// 按 index 累积，首 delta 的 id/name 保留，arguments 拼接
for (const delta of deltas) {
  const existing = mergedMap.get(delta.index ?? 0);
  if (existing) {
    existing.arguments += delta.arguments;
    if (delta.id && !existing.id) existing.id = delta.id;
    if (delta.name && !existing.name) existing.name = delta.name;
  } else { /* 初始化 */ }
}
```

sense 中间件自己的 `senseDeltaMap`（[tool.ts Phase 1](../../src/agent/middleware/tool.ts)）做同样的事，但**以 index 变化作为「上一个 call 已完整」的信号**触发 `sense_end`，剩余的最后一个 call 在流结束后统一触发。

### E. loop 的停止判定

[loop.ts createLoopHandler](../../src/agent/middleware/loop.ts) 每轮 `runChain()` 后基于 `ctx.soul.messages` 的**最后一条可见消息**（跳过 `revoked`）判定：

| lastVisible | 判定 |
|-------------|------|
| `role === "sense"` | continue（刚执行完感官，下一轮 LLM 读取结果） |
| `role === "assistant"` 且有 `senseCalls` | continue（感官调用待执行） |
| 其他（assistant 无 senseCall / user / system） | 检查残留 userInputs → 有则 continue，否则 stop |
| 无消息 / 全 revoked | 同上（残留输入则 continue，否则 stop） |

`maxLoop`（默认 30，来自 `config.global.maxLoopCount`）耗尽时 yield `error` chunk。**重要：** `stopped` 标记区分 break（正常停止）vs while 条件耗尽——避免在第 maxLoop 轮正常 break 时误报超限。

最终无论是否超限都 yield `done`（[loop.ts 末尾](../../src/agent/middleware/loop.ts)）。

### F. retry 的回滚

[retry.ts](../../src/agent/middleware/retry.ts) 在每轮 try 前 snapshot `messages.length`。chat 层中途失败时，外层 checkpoint 可能已 push 半截 assistant message——重试前 `messages.length = snapshot` 回滚，避免重复 append 污染历史。

| 错误分类（classifyError） | 可恢复？ | 处理 |
|---------------------------|----------|------|
| network / timeout / provider | 是 | delay 1s 后 continue |
| validation | 否 | 直接 yield ErrorChunk |
| unknown | 否 | 同上 |

**特殊：** `error.message === "approval aborted"` 直接 re-throw 传播——这是 compose abort（chat.abort 注入的 throw），必须保证「在任意挂起点都直接退出」，由 service 层 `handleChatSend` 静默 catch。

> 已 yield 的 StreamChunk 无法撤回（retry 固有表现），仅回滚内存 messages。

## 依赖与关联 ⭐

### 依赖

| 依赖 | 用途 |
|------|------|
| [core/middleware](../../src/core/middleware/) | `compose`（洋葱执行器）、`MiddlewareHandler`、`LoopHandler` |
| [core/middleware/types](../../src/core/middleware/types.ts) | `MiddlewareContext`、`RuntimeConfig`、所有 Chunk 类型 |
| [core/config](../../src/core/config.ts) | `SupervisionLevel` 枚举 |
| [core/sense](../../src/core/sense/) | `createApproval`（[tool.ts](../../src/agent/middleware/tool.ts) 构建审批 Promise） |
| [core/message/adapter](../../src/core/message/adapter.ts) | `ReplaceInfo`（sense 历史替换）、`LLMResponse` |
| [core/sense/adapter](../../src/core/sense/adapter.ts) | `SenseCallData`、`SenseFunction` |
| [core/llm/adapter](../../src/core/llm/adapter.ts) | `LLMOptions` |
| [agent/sense/processRegistry](../../src/agent/sense/processRegistry.ts) | bash 子进程按 chatId 注册/查询/kill；chatId 由 `SenseRuntimeContext` 第 3 参传入 |
| [agent/prompt/index](../../src/agent/prompt/index.ts) | `buildFirstSystemPrompt`（[builder.ts init](../../src/agent/builder.ts) 首条 system 消息） |
| [utils/json](../../src/utils/json.ts) | `safeJsonParse`（[tool.ts doExecuteSense](../../src/agent/middleware/tool.ts) 解析 argsJson） |
| [utils/logger](../../src/utils/logger/) | 全文大量日志 |

### 被依赖

| 调用方 | 用途 |
|--------|------|
| [agent/builder.ts](../../src/agent/builder.ts) | `build()` 注入 `defaultHandlers` 与 `createLoopHandler(maxLoopCount)` 到 `Middleware` 构造 |

### 横切参考

- [../service/chat.md](../service/chat.md) — observer 如何把 `message_created`/`message_updated`/`sense_pending` effect 翻译为 DB 写入与 ApprovalManager 注册；`fillApprovalResult` 如何更新 pending sense 的 content
- [../interaction.md](../interaction.md) — chunk → wire 帧映射；chat.resume Case1/Case2 续接语义；撤回规则
- [../protocol.md](../protocol.md) — chunk 二进制帧格式

## 5 个中间件详解

### 1. checkpointMiddleware（[checkpoint.ts](../../src/agent/middleware/checkpoint.ts)）

**职责：** 入站处理用户输入、出站归纳状态、构建并维护消息历史、声明副作用。

**伪代码：**

```ts
async function* checkpointMiddleware(ctx, next) {
  // ① next() 前：把 userInputs 转为 user messages
  for (const input of userInputs) {
    push user message to ctx.soul.messages;
    yield message_created effect;
  }
  yield consumed effect;
  userInputs.length = 0;

  const state = new CheckpointState();
  // ② 消费内层 chunk，三 delta 状态机 yield staged
  for await (const chunk of next()) {
    state.ingest(chunk);
    // thinking/content/sense delta 边界检测 → yield staged(thinking_end/content_end)
    if (chunk.type === "sense_end") {
      yield staged(sense_end, ...);
      state.flushAssistant(ctx);          // ★ 见下方
      if (supervision > 0) {
        push 空 content 的 sense 消息（若不存在）;
        yield sense_pending effect;       // 始终 yield（resume 续接也走此分支）
      }
    }
    yield chunk;
  }
  // ③ 流结束：yield 残留 staged
  // ④ finally：appendResponseMessages → yield message_created/updated effect
}
```

**为什么 sense_end 时就 flushAssistant（而不是 finally）：** 见 [checkpointState.ts flushAssistant 注释](../../src/agent/middleware/checkpointState.ts)：

1. **顺序**：pending sense 在 sense_end push，assistant 若拖到 finally push 会排成 `[user, sense, assistant]`，破坏 LLM 消息顺序（assistant 应在 tool result 前），导致 `revokeTrailingCycle` 找不到前置 assistant、resume Case1 判定错误。
2. **abort 落库**：sense_end 在 for-await 循环内，yield 的 effect 已被 observer 消费落库；abort 时（`gen.return` 传播下 finally 的 yield 会死锁不执行）此路径已执行，assistant 已在 DB。

> checkpoint **不再 yield done**——由 [loop.ts](../../src/agent/middleware/loop.ts) 负责。

### 2. senseMiddleware（[tool.ts](../../src/agent/middleware/tool.ts)）

> 文件名 `tool.ts` 是历史命名，内容是 sense 中间件（待重构）。

**职责：** Phase 1 收集 senseDelta + 触发；Phase 2 按监管等级执行；resume 续接跳过 chat 层。

**resume Case1 入口（[tool.ts executeResumePending](../../src/agent/middleware/tool.ts)）：** `ctx.soul.resumePending === true` 时，**首轮 skip chat 层**（不调 next/LLM），从历史末尾向前收集连续空 content 的 sense 消息重建 trigger 执行。工具不在当前 senseTable → 静默写「无此工具:{name}」（作 accept，LLM 据此感知工具不存在）。service 层 `AgentBuilder.resume()` 检测到 `hasPendingTrailingSense()` 时置此标志。

**Phase 1 — 收集与触发：**

```ts
const senseDeltaMap = new Map<number, {...}>();
for await (const chunk of next()) {             // ← 调内层 retry/chat
  if (chunk.type === "stream" && chunk.senseDelta) {
    // 累积 arguments，index 变化 → 上一个 call 已完整 → buildSenseTrigger + yield sense_end
  }
  yield chunk;
}
// 流结束：处理剩余 sense calls（最后一个 index 的 call）
```

**Phase 2 — 批量执行（[tool.ts executeCollectedCalls](../../src/agent/middleware/tool.ts)）：**

```ts
// auto 先执行（不等审批）
for (const call of autoCalls) {
  const { content, hash, replaced } = await doExecuteSense(...);
  yield sense_accept;
  for (const r of replaced) yield message_updated;   // 历史 hash 替换
}

// confirm/manual 批量等待
if (needsApproval.length > 0) {
  try { await Promise.all(approvalPromise); }
  catch { throw new Error("approval aborted"); }      // ★ 见上方「审批流程 B」
  for (const call of needsApproval) {
    const decision = await call.approvalPromise;
    if (decision.action === "accept") { doExecuteSense → yield sense_accept; }
    else { yield sense_reject(id, name, reason); }
  }
}
```

**doExecuteSense 的历史替换（[tool.ts doExecuteSense](../../src/agent/middleware/tool.ts)）：** 若 `result.hash` 命中历史某条 sense 消息的 hash（read_file hash 含 mtime，命中 = 文件未变动），把旧消息 content 替换为短说明「已被新读取取代」，长内容移至 `originalContent` 折叠——剔除冗长重复上下文。文件若被改动 → mtime 变 → hash 不同 → 各自独立留存。

**hash 黑名单（90ecacf2 案例）：** `tool.ts` 维护 `NON_DEDUPABLE_SENSES` 黑名单（当前含 `spawn_role`），这些 sense 即使返回 hash 也不触发 `replaceSense` 折叠。spawn_role 的 hash 是"派发标识"（`hashGenerator("spawn_role", childChatId, type, mode)`），命中 ≠ 重复派发任务（实际可能是"不同任务复用未完成子 chat"），折叠会破坏原始 prompt 参数 + 链式替换。**双保险**：`spawn_role` 自身不返回 hash + 黑名单兜底。

**流式多 sense_call reconcile（90ecacf2 案例）：** OpenAI 流式 tool_calls delta 分散到达——首个 sense_end 触发 `flushAssistant` 时 `state.senseDeltas` 未累积完整（yield trigger 早于 ingest chunk），assistant 的 `senseCalls` 字段可能只记部分 trigger。LLM 下一轮 buildMessages 重建 OpenAI `tool_calls` 字段会丢失 trigger，对应 tool result 成"孤儿"，上下文错乱。

修复：CheckpointState 暴露 `flushedAssistantId` + `flushedAssistantSenseCalls`；流结束后（[checkpoint.ts finally](../../src/agent/middleware/checkpoint.ts)）调 `state.reconcileAssistantSenseCalls()` 比对「flush 时」与「最终 `mergeSenseDeltas`」，有新增则 yield `message_updated` patch（`kind:"content"` + `senseCalls`），由 [observer.ts](../../src/service/chat/observer.ts) 调 `updateAssistantSenseCalls` 持久化到 DB（独立 UPDATE `sense_calls` 列）。保留"assistant 在 sense 之前入库"语义（[checkpoint.ts:122-124](../../src/agent/middleware/checkpoint.ts#L122-L124)），仅 in-place 补充 senseCalls 字段。

**chatId 注入（[tool.ts doExecuteSense](../../src/agent/middleware/tool.ts) + processRegistry）：** executor 支持可选第 3 参 `SenseRuntimeContext`。`doExecuteSense` 调 `senseEntry.execute(args, ctx.soul.senseSharedData, { chatId: ctx.soul.chatId })`，bash executor 读取 `senseCtx?.chatId` 后注册子进程；不再占用 sharedData 的保留 namespace。

### 3. retryMiddleware（[retry.ts](../../src/agent/middleware/retry.ts)）

**职责：** 捕获 chat 层错误，分类重试，失败 yield ErrorChunk。详见「关键流程 F」。

**常量：** `MAX_RETRIES = 3`、`RETRY_DELAY_MS = 1000`。

### 4. chatMiddleware（[chat.ts](../../src/agent/middleware/chat.ts)）

**职责：** 调用 LLM，yield StreamChunk（含 senseDelta）。

**媒体输入预处理：** 用户消息中的 `[[media:<filename>]]` 受控资产引用会在构造 provider 消息前解析。中间件按当前 brain 的 `capabilities.input.image/video/audio` 许可调用媒体网关 `understand`，仅把理解文本注入本轮内存请求；持久化原消息不改写。处理失败或能力未声明时同样注入显式说明，避免静默丢弃附件。见 [../model-capabilities.md](../model-capabilities.md)。

**关键：** `if (!ctx.runtime) throw`——P2-4 重构后 runtime 在 `send` 前由 `configureRuntime` 注入，运行时守卫窄化消除了构造期 `{} as RuntimeConfig` 的类型谎言。

**handleStream vs handleNonStream：**

| 路径 | 调用 | 产出 |
|------|------|------|
| `ctx.global.stream === true` | `llmAdapter.chatStream` | for-await 流，每 chunk yield 一个 StreamChunk |
| `false` | `llmAdapter.chat` | 单次响应，yield 单个 StreamChunk（content/thinking/senseDelta 整体） |

`options` 构造（[chat.ts](../../src/agent/middleware/chat.ts)）：`{ model, url, key, thinking?, rpm? }`，仅当 `brain.thinking`/`brain.rpm` 为真时展开（OpenAI Provider 的 RPM 限流据此触发）。

执行下游：`yield* next()`（chat 是最内层，next 实际是空 generator，但保持洋葱结构一致）。

### 5. createLoopHandler（[loop.ts](../../src/agent/middleware/loop.ts)）

**职责：** 循环 runChain 直到无 senseCalls，maxLoop 超限 yield error，最终 yield done。详见「关键流程 E」。

`AgentBuilder.build()` 注入 `createLoopHandler(config.global.maxLoopCount)`。它不是 `MiddlewareHandler` 而是 `LoopHandler`——由 [core/middleware](../../src/core/middleware/) 的 `Middleware` 构造期绑定（`generator = loopHandler.bind(this, ctx, () => runChain(ctx))`）。

## 扩展点

### 添加中间件

1. 在 [middleware/](../../src/agent/middleware/) 新增 `<name>.ts`，实现 `MiddlewareHandler<MiddlewareChunk>` 签名：

   ```ts
   export async function* myMiddleware(
     ctx: MiddlewareContext,
     next: () => AsyncGenerator<MiddlewareChunk>,
   ): AsyncGenerator<MiddlewareChunk> { /* ... */ yield* next(); /* ... */ }
   ```

2. 在 [index.ts](../../src/agent/middleware/index.ts) 的 `defaultHandlers` 数组**按位置插入**——位置决定洋葱层级（越靠前越外层）。例如想插入到 retry 与 chat 之间：

   ```ts
   export const defaultHandlers = [
     checkpointMiddleware,
     senseMiddleware,
     retryMiddleware,
     myMiddleware,        // ← 内层 chat 之前
     chatMiddleware,
   ];
   ```

3. 横切关注点（如日志、metrics）放最外层；需看到最终 chunk 的放最内层（chat 之前）。

### 修改 loop 停止策略

替换 [builder.ts](../../src/agent/builder.ts) 传给 `Middleware` 构造的 `createLoopHandler(maxLoop)`——可自定义 `LoopHandler` 实现。当前判定基于 `ctx.soul.messages` 的 lastVisible 消息，自定义时注意 `revoked` 过滤（撤回场景）。

### 调整 retry 策略

[retry.ts](../../src/agent/middleware/retry.ts) 的 `MAX_RETRIES` / `RETRY_DELAY_MS` / `classifyError` / `isRecoverable` 均可改。注意保持 `approval aborted` 的 re-throw 语义（否则 abort 不能穿透 retry）。
