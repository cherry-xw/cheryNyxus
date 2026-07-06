# src 设计问题与优化建议

本文基于 `.claude/CLAUDE.md` 与 `.claude/plans/*` 中的项目目标理解，对 `src/` 当前实现做设计层面的审视。项目期望的核心方向是：`Core / Agent / Service / DB / Utils` 分层清晰，`Brain / Sense / Chat` 解耦，middleware 只产出 chunk/effect，DB、审批、WebSocket 等副作用由 service observer 消费。

## 总体判断

当前代码已经在向目标架构收敛：`RuntimeResolver` 做 brain/sense 原子解析，`service/chat/observer.ts` 集中处理 DB 与审批副作用，`approvalRegistry` 把审批 Promise 从 service 回调中剥离出来。这些方向是对的。

主要问题在于：运行态状态机仍散落在多个模块，错误/中止语义依赖字符串约定，DB 分片和内存状态缺少事务边界，协议入口缺少运行时校验。结果是恢复、审批、热重载、断连、重试这些复杂路径容易靠注释和局部补丁维持，而不是由类型和边界保证。

## P0：优先修复的问题

### 1. abort / approval aborted 用字符串做控制流，且会被 compose 包装破坏

**证据**

- `compose.abort()` 注入 `new Error("approval aborted")`，但 `executeChain()` 会把所有 handler 异常包装成 `[compose] handler at index ...`：[`src/core/middleware/compose.ts`](../src/core/middleware/compose.ts)。
- `retryMiddleware` 和 `handleChatSend/Resume` 都用 `error.message === "approval aborted"` 判断是否静默退出：[`src/agent/middleware/retry.ts`](../src/agent/middleware/retry.ts)、[`src/service/chat/send.ts`](../src/service/chat/send.ts)。
- `tool.ts` 在审批 abort 时也直接 `throw new Error("approval aborted")`。

**影响**

一旦异常经过 `compose` 包装，外层精确字符串匹配失效，断连/中止可能被当作普通错误推给前端，甚至进入 retry / error notification 路径。这是恢复语义的核心风险。

**建议**

- 新增领域错误类型，例如 `AgentAbortError` / `ApprovalAbortedError`，带稳定 `code`。
- `compose` 对领域错误不包装；或包装时保留 `cause`，外层用 `isAgentAbortError(err)` 沿 `cause` 链判断。
- 禁止业务逻辑用 `error.message` 做分支，统一用错误 code / class。

### 2. `ensureChat` 先写 runtime Map，再配置 runtime，失败会留下半初始化实例

**证据**

- `ensureChat()` 在 `chatRuntimes.set(chatId, runtime)` 后才 `configureRuntime()`：[`src/service/chat/runtime.ts`](../src/service/chat/runtime.ts)。
- `chat.create` 先 `createChat(chatId)`，再 `ensureChat(chatId, selection)`：[`src/service/chat/handler.ts`](../src/service/chat/handler.ts)。

**影响**

如果 runtime 解析失败，比如 brain、sense group、MCP server 不存在，会出现：

- DB 已创建 chat 行，但 runtime 未成功。
- `chatRuntimes` 可能保留未配置 builder。
- 后续 `send/resume` 走已存在 runtime 分支时，不会重新解析 selection，最终在 `requireRuntime()` 才失败。

**建议**

- 先在局部变量完成 `new AgentBuilder().build()`、`configureRuntime()`、`init()`，全部成功后再写入 `chatRuntimes`。
- `chat.create` 应把 `createChat + ensureChat` 视为一个用例：失败时删除已创建 chat，或先解析 selection 成功后再创建 chat。
- 对 `ensureChat` 增加失败清理：`catch` 中 `chatRuntimes.delete(chatId)`。

### 3. 消息周期状态机分散，恢复/撤回语义难以保证

**证据**

同一套“消息周期”规则散落在多个位置：

- user input 入消息、staged 边界、pending sense 创建在 `checkpoint.ts`。
- assistant/sense 消息创建与 recovery update 在 `checkpointState.ts`。
- 尾部周期撤回、pending sense 判断在 `core/middleware/index.ts`。
- `canResume` 判断在 `service/chat/handler.ts`。
- observer 还有 abort 兜底 flush。

**影响**

这些模块都在用局部规则理解 `user -> assistant -> sense -> assistant` 周期。新增一个消息状态、一个 provider 差异或一个恢复路径时，很容易只改到一处，造成 DB、内存消息、前端 staged 回放不一致。

**建议**

- 提取 `ConversationCycle` / `MessageJournal` 小模块，集中提供：
  - `appendUserInputs`
  - `appendAssistantFromStream`
  - `appendPendingSense`
  - `completeSense`
  - `revokeTrailingCycle`
  - `canResume`
- middleware 只调用这些意图方法，不直接到处操作 `ctx.soul.messages`。
- `chat.get` 的历史回放也复用同一套状态解释，而不是自己重新判断。

### 4. DB 分片写入缺少事务边界和状态校验

**证据**

- `addMessage()` 插入月库 messages 后，再更新 soul.db 的 `message_count` 与 `updated_at`。
- `deleteChat()` 跨 soul.db 与月库删除，注释中承认跨库无事务。
- `fillApprovalResult()`、`markMessagesRevoked()`、`markMessageReplaced()` 不检查 `UPDATE` 命中行数。

**影响**

进程崩溃或异常中断时，可能出现：

- message 已写入但 `message_count` 未更新。
- chat 已删除但月库残留消息，或反过来。
- pending sense 更新实际没有命中，但调用方仍认为恢复完成。

**建议**

- 封装 `ChatRepository`，把“写消息 + 更新 chat 元数据/计数”作为一个用例。
- SQLite 跨库可考虑 `ATTACH` 后事务；如果暂不做跨库事务，至少检查每步 `changes`，失败时记录可修复事件。
- 增加启动期/维护命令：重算 `message_count`、扫描孤儿消息、修复 pending 异常状态。

## P1：中期优化问题

### 5. RPC 类型没有和 method 绑定，运行时也缺少 schema 校验

**证据**

- `RequestData` / `ResponseData` 是大 union，但 `Request.method` 只是 `string`。
- `RpcRouter.register()` 把 handler 强转为统一 `HandlerFn<RequestData, ResponseData>`。
- handler 内部大量 `params as ChatCreateRequestData` 之类断言。

**影响**

TypeScript 无法保证 `chat.send` 一定拿到 `{ chatId, prompt }`。来自 WebSocket 的外部输入也没有 zod/io-ts 级别校验，错误会在业务深处爆出，错误码也会变成泛化的 `INTERNAL`。

**建议**

- 定义 `MethodMap`：
  - key = method
  - value = `{ requestSchema, responseSchema, handler }`
- router 根据 method 做 schema parse，校验失败返回 `INVALID_PARAMS`。
- `Request<M extends Method>` 让 `method` 与 `params` 在类型层绑定。

### 6. 全局 Sense / MCP registry 与 per-chat runtime 的生命周期边界不清

**证据**

- `senseRegistry` 是进程全局对象。
- MCP connect/disconnect/reload 会注册或注销全局 sense。
- `RuntimeResolver` 解析时把 sense executor 复制到当前 chat 的 `senseTable`。

**影响**

已有 chat runtime 可能持有旧 MCP client 的 executor。MCP disconnect/reload 后，全局 registry 变了，但已创建的 builder 不一定同步失效。结果可能是：前端显示 server 已断开，但旧 chat 仍能尝试调用旧 executor，或调用到已关闭 client。

**建议**

- 给 registry 增加版本号，runtime 记录创建时版本；send/resume 前发现版本变化则重建 runtime。
- MCP executor 执行时检查 server 当前连接状态，断开则返回明确错误。
- 更彻底的方式是：runtime 只保存 sense name，执行时通过版本化 registry 解析，而不是长期持有闭包。

### 7. sense call 流式拼装逻辑重复，存在分叉风险

**证据**

- `senseMiddleware` 自己维护 `senseDeltaMap`，以 index 变化触发 `sense_end`。
- `CheckpointState` 又实现了一套 `mergeSenseDeltas()`，用于构建 assistant message。

**影响**

两套拼装规则只要有一个 provider 的 delta 格式不完全一致，就可能出现“前端看到的 sense_end”和“落库 assistant.senseCalls”不一致。

**建议**

- 提取 `SenseCallAssembler`，同时给 `senseMiddleware` 与 `CheckpointState` 使用。
- 对 OpenAI / Ollama / Mock 的流式 tool call delta 建参数化测试。

### 8. 感官去重替换逻辑有局部不一致

**证据**

- auto sense 的 replaced patch 带 `content`。
- confirm/manual accept 分支的 replaced patch 只带 `replace` 和 `originalContent`，没有 `content`。
- observer 的 `markMessageReplaced()` 只有传入 `content` 时才更新 DB content。

**影响**

confirm/manual 路径下，内存中的旧 sense content 已被改成短说明，但 DB 可能仍保留长内容，只写 replace 元数据。重启后历史回放与当前内存表现可能不同。

**建议**

- replaced patch 类型强制要求 `content`、`replace`、`originalContent` 同时存在。
- 去重替换应作为 `MessageJournal.replaceMessage()` 原子操作，不在 `tool.ts` 里直接改历史消息。

### 9. 审批批处理策略会让多个工具调用互相阻塞

**证据**

`executeCollectedCalls()` 对所有 confirm/manual 调用先 `Promise.all()`，全部审批完成后才逐个执行。

**影响**

如果一轮里有多个需审批工具，用户接受第一个也不会执行，必须等所有审批都有结果。任一审批 abort 会让整批都 abort。这个策略简单，但交互上不够细，也会放大单个 pending 的影响范围。

**建议**

- 明确产品语义：批量审批还是逐个审批。
- 如果保留批量审批，协议层应表达“本批审批组”。
- 如果改逐个审批，`executeCollectedCalls()` 应按 call 独立 await 和执行，abort 只影响对应 call 或当前 chain。

## P2：可维护性优化

### 10. `Middleware` 类名与职责不匹配

`core/middleware/index.ts` 里的 `Middleware` 实际是单 chat agent runtime：持有 chatId、messages、userInputs、runtime、运行状态、撤回逻辑。它不只是 middleware 组合器。

建议改名或拆分：

- `AgentSession`：持有 chat 状态与运行控制。
- `MiddlewarePipeline`：只负责 compose/run/abort。
- `MessageJournal`：持有消息状态机。

### 11. 内置 Sense 直接依赖进程级环境，缺少注入边界

例子：

- `search_codebase` 固定以 `process.cwd()` 建索引，并且初始化失败会缓存 `null` 到进程重启。
- `execute_command` 直接读取全局 config、spawn shell、写 bash log。

这些做法短期可用，但会让测试、多 workspace、多项目根、热重载变困难。

建议为 sense executor 注入 `SenseRuntimeContext`，至少包含 `chatId`、`workspaceRoot`、`config`、`logger`、`abortSignal`。当前通过 `SenseSharedData` 注入 chatId 是临时方案，长期不应继续扩大。

### 12. 文档与代码存在少量漂移

`.claude/CLAUDE.md` 是极简索引，但部分旧描述已经在模块文档里被标注为过时。建议把 `.claude/CLAUDE.md` 保持在“只索引，不描述细节”的状态，容易变化的实现细节只保留在 `docs/` 模块文档中。

## 推荐实施顺序

1. 先修异常语义：引入 typed abort error，消除字符串匹配。
2. 修 `ensureChat` 半初始化问题，保证 runtime 创建失败不会污染 Map 和 DB。
3. 提取消息周期状态机，把 revoke/canResume/pending/complete 统一到一个模块。
4. 给 RPC router 加 method schema 校验，减少外部输入在业务深处爆炸。
5. 封装 DB repository，补 `changes` 检查和一致性修复工具。
6. 处理 MCP/Sense registry 版本化，避免热重载影响已有 runtime 的边界不清。

## 验收建议

重点补以下测试，而不是只补单元覆盖率：

- approval abort 经过 compose 后不会发 error notification。
- `chat.create` runtime 解析失败后，不留 chat row / 不留半初始化 runtime。
- pending sense 断连后 `chat.get canResume=true`，`chat.resume` 能稳定恢复。
- MCP disconnect/reload 后，旧 chat runtime 的工具调用表现可预期。
- 感官去重在 auto 与 confirm/manual 路径下，内存、DB、历史回放一致。
