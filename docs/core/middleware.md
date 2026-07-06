# Middleware（洋葱模型与单 Chat 执行器）

> 源码 [src/core/middleware/](../../src/core/middleware/) ｜ 上级 [core/README.md](./README.md) ｜ 相关 [sense.md](./sense.md)、[message.md](./message.md)、[interaction.md](../interaction.md)

## 职责

`core/middleware/` 是 Agent 执行链的核心：把多个中间件按洋葱模型组合成一条 generator 链，再由 `AgentSession` 门面承载**单个 chat 的执行会话**。会话内部组合 `MiddlewarePipeline`（链执行/abort/运行态）与 `MessageJournal`（消息历史、输入队列、撤回、resume 判定），对外暴露 `init` / `configureRuntime` / `send` / `abort` / `revokeTrailingCycle` 等门面方法。

它是洋葱模型的引擎，但**不定义中间件的具体行为**——`checkpointMiddleware`、`senseMiddleware`、`retryMiddleware`、`chatMiddleware`、`loopHandler` 都在 [`agent/middleware/`](../../src/agent/middleware/) 实现，通过 `AgentSession` 构造参数注入。core 只定义契约（`MiddlewareHandler` / `LoopHandler` / `MiddlewareContext` / 全部 Chunk 类型）和组合机制（`compose`）。

## 文件清单

| 文件 | 职责 |
|------|------|
| [compose.ts](../../src/core/middleware/compose.ts) | `compose()` 组合器、`ComposedMiddleware`（`run` 启动链 / `abort` 注入错误退出） |
| [middlewarePipeline.ts](../../src/core/middleware/middlewarePipeline.ts) | `MiddlewarePipeline`：封装 compose/run/abort 与运行态 |
| [messageJournal.ts](../../src/core/middleware/messageJournal.ts) | `MessageJournal`：集中 messages/userInputs/revoke/pending/resume 等消息周期规则 |
| [types.ts](../../src/core/middleware/types.ts) | `MiddlewareContext`、`SoulGroup`、`RuntimeConfig`、全部 Chunk 类型、`MiddlewareHandler` / `LoopHandler` |
| [index.ts](../../src/core/middleware/index.ts) | `AgentSession` 类（默认导出，单 chat 绑定，组合 Pipeline + Journal 的门面） |

> ⚠ CLAUDE.md 旧描述提到「`chatMap` / `createChat` / `send`」顶层导出，**真实代码不存在**。Chat 多路复用与缓存发生在 [`service/chat/`](../../src/service/chat/)；core 层的 `AgentSession` 是**单 chat** 的，service 层为每个 chatId 创建独立实例。

## 核心概念 / 导出

### compose() 组合器

```ts
export interface ComposedMiddleware<T = unknown> {
  run(ctx: MiddlewareContext): AsyncGenerator<T>;   // 每次创建新 generator
  abort(): void;                                     // 向当前 generator 注入错误
}

export function compose<T = unknown>(
  handlers: MiddlewareHandler<T>[],
): ComposedMiddleware<T>;
```

执行顺序为标准洋葱：最外层 Enter → 内层 Enter → Core → 内层 Exit → 最外层 Exit。**单次执行不处理重试**——重试/循环由 `LoopHandler` 在外层包一层 `while` 实现（见下）。

`abort()`：对当前挂起的 generator 调 `.throw(new Error("approval aborted"))`。错误注入到 `senseMiddleware` 挂起的 `await approvalPromise`，其 `catch` 捕获后重新 `throw` 传播退出整条链（不继续 `next`）。用于 `chat.abort` 等场景：core 自主退出，不依赖 service 层 approvalManager。

### MiddlewareHandler / LoopHandler

```ts
export type MiddlewareHandler<T = MiddlewareChunk> = (
  ctx: MiddlewareContext,
  next: () => AsyncGenerator<T>,     // 调 next() 进入下一层
) => AsyncGenerator<T>;

export type LoopHandler<T = MiddlewareChunk> = (
  ctx: MiddlewareContext,
  runChain: () => AsyncGenerator<T, void, unknown>,
) => AsyncGenerator<T, void, unknown>;
```

`MiddlewareHandler` 是洋葱某层：先处理入站 chunk（yield 给外层），再 `yield* next()` 进入下层，最后处理出站。`LoopHandler` 在最外层包循环——反复调 `runChain()` 直到 LLM 末轮无 senseCalls，最后 `yield DoneChunk`。

### MiddlewareContext 与分组

```ts
export interface MiddlewareContext {
  soul: SoulGroup;        // 单 chat 上下文（跨轮可变）
  global: GlobalConfig;   // 全局配置（跨轮不变）
  runtime?: RuntimeConfig;// 运行时配置（每轮可换，send 前 requireRuntime 校验非空）
  log: Logger;            // 当前作用域 logger
  journal: MessageJournal;// 消息周期单一写者
}
```

| 分组 | 字段 | 来源 / 语义 |
|------|------|------|
| `soul` | `chatId` | `init()` 绑定，跨轮不变 |
| `soul` | `senseSharedData: Map<ns, Map<id, unknown>>` | 感官间共享数据（namespace → identifier → data） |
| `soul` | `userInputs: UserInputEntry[]` | `send()` 入队，checkpoint 消费；容量上限 16，超限丢最早（背压） |
| `soul` | `messages?: LLMResponse[]` | 内存对话历史，`init()` 注入、checkpoint 追加、`buildMessages` 时过滤 `revoked` |
| `soul` | `resumePending?: boolean` | `chat.resume` Case1 标志，首轮 senseMiddleware 检测后 skip chat 层 |
| `global` | `thinking / supervision / stream / maxLoopCount` | 来自 [`config.global`](../../src/utils/config.ts)，构造时注入 |
| `runtime` | `brain / adapters / builtSenses / senseTable` | [`AgentBuilder.configureRuntime`](../../src/agent/builder.ts) 每轮原子注入 |
| `log` | `logger` | AgentSession 构造时注入，供中间件写结构化日志 |
| `journal` | `MessageJournal` | AgentSession 构造时注入，集中 messages/userInputs 的所有写操作 |

### RuntimeConfig 与 AdaptersGroup

```ts
export interface RuntimeConfig {
  brain: BrainConfig;                          // model/provider/url/key/thinking/rpm
  adapters: AdaptersGroup;                     // llm/message/sense adapter 实例
  builtSenses: SenseFunction[];                // 给 LLM 的工具声明（已 provider 格式化）
  senseTable: Map<string, SenseEntry>;         // name → { supervisionLevel, execute }
}
```

`runtime` 由 builder 解析 brain + senseGroups 后**整体**注入（原子），避免 provider 与工具定义处于半配置状态。`SenseEntry.supervisionLevel` 已在摊平时按[优先级链](./sense.md#sense-监管等级)前置计算完毕，运行期不再回退到 `global.supervision`。

### Chunk 类型（中间件 yield 的数据单元）

`MiddlewareChunk` 是以下 11 种的联合（详见 [types.ts](../../src/core/middleware/types.ts)）：

| Chunk | 触发层 | 用途 |
|------|------|------|
| `StreamChunk` | chatMiddleware | 流式增量（thinkingDelta / contentDelta / senseDelta?） |
| `SenseTriggerChunk` (`sense_end`) | senseMiddleware | 感官待执行（id/name/args/supervisionLevel） |
| `SenseAcceptChunk` | senseMiddleware | 感官执行成功（result/hash） |
| `SenseRejectChunk` | senseMiddleware | 感官被拒（reason） |
| `StagedChunk` | checkpointMiddleware | 阶段完成（thinking_end / content_end / sense_end，累积值） |
| `ConsumedChunk` | checkpoint | 用户输入已入循环（count + messages 快照） |
| `MessageCreatedChunk` | checkpoint | **副作用**：创建消息（observer 落库） |
| `MessageUpdatedChunk` | checkpoint | **副作用**：更新消息（patch：content/hash/replace...） |
| `SensePendingChunk` | checkpoint | **副作用**：注册待审批 sense（observer 调 approvalManager） |
| `DoneChunk` | loopHandler | 全部 loop 结束 |
| `ErrorChunk` | retryMiddleware | 重试失败/超限（带 attempt/category/recoverable） |

> **P1-11 解耦设计**：`SenseTriggerChunk` / `SensePendingChunk` **不再携带 `approvalResolve` 函数指针**，审批 Promise 改由 [`core/sense/approvalRegistry`](./sense.md) 管理。chunk 只产 `{approvalId, supervisionLevel, needsApproval}` 事实，service `ApprovalManager` 经 `resolveApproval/rejectApproval` 触发对应 Promise。core↔service 分层由此干净。

### AgentSession 类（门面 + 状态机）

```ts
export default class AgentSession<T = unknown> {
  constructor(global: GlobalConfig, handlers: MiddlewareHandler<T>[], loopHandler?: LoopHandler<T>);

  init(chatId: string, messages: LLMResponse[]): string | undefined;  // 绑定 chatId + 初始消息（仅一次）
  configureRuntime(runtime: RuntimeConfig): void;                     // 原子注入运行时（每轮可换）
  send(input: string): AsyncGenerator<T>;                             // 入队输入 + 启动 loop（见下）
  abort(): void;                                                      // 中止当前 generator
  revokeTrailingCycle(): string[];                                    // 撤回末尾整周期 AI 响应（chat.send 恢复场景）
  hasPendingTrailingSense(): boolean;                                 // 末尾是否有 pending sense（chat.resume 走 Case1 or Case2）
  setResumePending(value: boolean): void;
  isRunning(): boolean;                                               // 是否有活跃迭代器
  getMessages(): LLMResponse[];                                       // 暴露内存消息（observer flush 用）
}
```

关键不变量：

- **单 chat 绑定**：一个 `AgentSession` 实例 = 一个 chatId，service 层每 chat 创建独立实例，跨轮不重建。
- **职责拆分**：链执行由 `MiddlewarePipeline` 管，消息周期由 `MessageJournal` 管，`AgentSession` 只做门面协调。
- **runtime 可空**：构造时 `runtime` 为 `undefined`（消除旧 `{} as RuntimeConfig` 类型谎言）；`send` 前调 `requireRuntime` 强校验 `brain/adapters/builtSenses/senseTable` 齐全。
- **背压**：`userInputs` 容量 16，超限丢最早（`MAX_USER_INPUTS`）。
- **运行中再 send**：`isRunningFlag` 守护，运行中调用只入队、不启第二个 generator，由当前 loop 下一轮消费。

## 关键流程 / 数据流

### 洋葱链 + 循环

执行链顺序由 agent 层 `defaultHandlers` 决定（由外到内）：`checkpointMiddleware → senseMiddleware → retryMiddleware → chatMiddleware`，外层再套 `loopHandler` 反复跑直到收敛。

```text
send(input)                      ── agent/builder.ts 门面转发 ──
  └─ loopHandler(ctx, runChain)  ── while: 反复 runChain，末轮无 senseCalls 时 break + yield Done
       └─ compose.run(ctx)       ── executeChain(0) 洋葱递归
            ├─ checkpoint.enter  ── 收集 delta、归纳 Staged、产 message/sense effect
            ├─    sense.enter    ── 收集 senseDelta、检测完整 call、yield sense_end
            ├─       retry.enter ── 捕获 chat 层错误、决定重试 or 透传 ErrorChunk
            ├─          chat.core── 调 LLMAdapter.chatStream、yield StreamChunk（每个 delta）
            ├─       retry.exit
            ├─    sense.exit     ── auto 直接执行；confirm/manual await approvalRegistry Promise 后执行
            │                       → yield sense_accept / sense_reject
            └─ checkpoint.exit   ── yield StagedChunk + message_created/updated/sense_pending effect
                                  ↓
            service observer 消费 effect chunk → 落库 / 注册审批
```

### send 状态机

```text
send(input):
  requireInitialized()  ── 未 init 抛错
  requireRuntime()      ── runtime 不全抛错
  if input.trim():
    if userInputs.length >= 16: shift() 丢最早（背压）
    userInputs.push({content, time})
  if isRunningFlag: return        ── 运行中只入队，不启新 generator
  isRunningFlag = true
  try: yield* generator           ── 跑完整个 loop（loopHandler 内部多次 runChain）
  finally: isRunningFlag = false
```

### 撤回（revokeTrailingCycle）与续接判定

`chat.send` 在 `chat.get` 恢复场景（重启后末尾留有未完成周期）下，调 `revokeTrailingCycle`：从末尾向前收集连续 `role==="sense"` 群 + 紧邻其前的带 `senseCalls` 的 assistant，整体标 `revoked=true`（返回被撤回的 id 列表，供 service 持久化）。OpenAI tool_calls 配对约束要求 assistant 与 tool 结果成对移除，故整周期一并撤回。

`chat.resume` 用 `hasPendingTrailingSense` 判断 Case1（末尾有 pending sense → `setResumePending(true)`，首轮 senseMiddleware 跳过 chat 层恢复执行）vs Case2（全 done → 直接进 loop 调 LLM）。详见 [interaction.md](../interaction.md)。

## 依赖与关联

- **依赖**：
  - 类型：[`LLMResponse`](./message.md)（`core/message/adapter`）、[`LLMAdapter`](./llm.md)、[`SenseAdapter` / `SenseCallData` / `SenseFunction`](./sense.md)、[`SenseResult` / `SenseSharedData`](./sense.md)（`core/sense/senseCreator`）、[`SupervisionLevel`](./README.md#supervisionlevel-枚举)（`core/config`）。
  - 配置类型：[`GlobalConfig` / `BrainConfig`](../../src/utils/config.ts)。
  - 工具：[`utils/logger`](../../src/utils/logger/index.ts)（背压告警）。
- **被依赖**：
  - [`agent/middleware/index.ts`](../../src/agent/middleware/index.ts) —— `defaultHandlers` / `createLoopHandler` 注入。
  - [`agent/builder.ts`](../../src/agent/builder.ts) —— `new AgentSession(...)` 构造，并把 `AgentBuilder` 全部门面方法转发给 `AgentSession` 实例。
  - [`agent/middleware/{checkpoint,sense,retry,chat,loop,checkpointState}.ts`](../../src/agent/middleware/) —— 实现各 `MiddlewareHandler`，依赖 `types.ts` 的 Context/Chunk。
  - [`service/chat/`](../../src/service/chat/) —— 经 `AgentBuilder` 间接驱动；observer 消费 effect chunk 落库 / 注册审批。
- **横切参考**：[interaction.md](../interaction.md)（send/resume/revoke 状态机完整语义）、[protocol.md](../protocol.md)（Chunk → wire chunk 映射）、[db.md](../db.md)（`revoked` 与 message 落库）。

## 扩展点：加中间件

1. 在 `src/agent/middleware/<name>.ts` 实现 `MiddlewareHandler`（签名见上）。
2. 决定洋葱层级（`next()` 调用前后做什么），在 [`agent/middleware/index.ts`](../../src/agent/middleware/index.ts) 的 `defaultHandlers` 数组中按序插入——数组顺序即洋葱外→内顺序。
3. 若需在 loop 外层加策略（如自定义收敛条件），实现 `LoopHandler` 并传给 `AgentSession` 构造的第三参数（默认走 `createLoopHandler(maxLoopCount)`）。
4. core/ 本身无需改动——`compose` / `MiddlewarePipeline` / `AgentSession` 与具体 handler 无关。
