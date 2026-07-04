# Service 服务层总览

> 源码 [src/service/](../../src/service/) ｜ 上级 [README](../README.md) ｜ 子模块 [./chat.md](./chat.md) ｜ [./message.md](./message.md) ｜ [./websocket.md](./websocket.md) ｜ 相关 [db.md](../db.md)、[../protocol.md](../protocol.md)、[../interaction.md](../interaction.md)

## 职责

service 层是「外部世界 ↔ agent 内核」的边界。它把 WebSocket 上的 RPC 请求路由到对应 handler，把 agent 的流式 `MiddlewareChunk` 流映射成协议层 Chunk/Notification 推回客户端，并集中处理 DB 持久化与审批副作用。

- **启动装配**（[index.ts](../../src/service/index.ts)）：`startService(port)` 创建 Router → 注册全部 handler → 启动 WebSocketServer。
- **RPC 路由**（[message/](../../src/service/message/)）：Request/Response/Chunk/Notification 四象限类型 + `RpcRouter` 分发。详见 [./message.md](./message.md)。
- **传输实现**（[websocket/](../../src/service/websocket/)）：ws 封装、连接状态、二进制帧编解码。详见 [./websocket.md](./websocket.md)。
- **chat 枢纽**（[chat/](../../src/service/chat/)）：流式执行、observer 副作用、streamMapper 映射、runtime 缓存、chat 管理。详见 [./chat.md](./chat.md)。
- **单文件 handler**：`approval/`、`bash/`、`brain/`、`runtime/`、`sense/` 各负责少量 RPC 方法。

## 启动流程

入口 [src/index.ts](../../src/index.ts) `main()`：

```
initLogger(config.global.logger)
WS_PORT  = config.server.port
WEB_PORT = config.server.web_port
bootstrapAgentRuntime()          // 注册内置 Provider + 重建 Sense registry
wss = startService(WS_PORT)      // ← 本模块入口
startWebServer(WEB_PORT)         // web/server.ts（HTTP /api/config + 静态前端）
getSoulDb()                      // 初始化数据库
SIGINT/SIGTERM → wss.close() + closeAllDbs() + exit
```

`startService`（[service/index.ts](../../src/service/index.ts)）：

```ts
export function startService(port: number) {
  const router = createRouter();
  registerBrainHandlers(router);        // brain.list
  registerSenseHandlers(router);        // sense.list
  registerRuntimeSetHandlers(router);   // runtime.set
  registerChatHandlers(router);         // chat.send / chat.resume / sense.approval / chat.abort
  registerChatManageHandlers(router);   // chat.create / chat.list / chat.get / chat.delete
  registerBashHandlers(router);         // bash.list / bash.kill
  return createWebSocketServer({ port, router });
}
```

> service/index.ts 另 `export { createWebSocketServer }`、`export { createRouter }`、`export * from message/types`，供测试与外部组装复用。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [src/service/index.ts](../../src/service/index.ts) | `startService(port)`：建 Router + 注册全部 handler + 建 WebSocketServer |
| [src/service/message/index.ts](../../src/service/message/index.ts) | barrel：types + router |
| [src/service/message/types.ts](../../src/service/message/types.ts) | RPC 全部类型、`Method`/`ErrorCode` 常量、工厂、类型守卫 |
| [src/service/message/router.ts](../../src/service/message/router.ts) | `RpcRouter`：注册、分发、流式包装、错误转换 |
| [src/service/websocket/index.ts](../../src/service/websocket/index.ts) | `createWebSocketServer`：ws 服务、消息分发、流式推送、审批超时 |
| [src/service/websocket/connection.ts](../../src/service/websocket/connection.ts) | `ConnectionManager` 单例：连接状态、chat 绑定、审批超时、close abort |
| [src/service/websocket/transport.ts](../../src/service/websocket/transport.ts) | `Transport` 单例：二进制/JSON 帧编解码 |
| [src/service/chat/send.ts](../../src/service/chat/send.ts) | `handleChatSend`/`handleChatResume`/`handleSenseApproval`/`handleChatAbort` |
| [src/service/chat/handler.ts](../../src/service/chat/handler.ts) | `handleChatCreate`/`handleChatList`/`handleChatGet`/`handleChatDelete` |
| [src/service/chat/observer.ts](../../src/service/chat/observer.ts) | `observeAgentChunks`：effect chunk → DB/审批副作用 |
| [src/service/chat/streamMapper.ts](../../src/service/chat/streamMapper.ts) | `streamAgentChunks`：MiddlewareChunk → 协议 Chunk/Notification |
| [src/service/chat/runtime.ts](../../src/service/chat/runtime.ts) | `chatRuntimes` Map + `ensureChat`/`setRuntime`/`clear`/`abort` |
| [src/service/approval/manager.ts](../../src/service/approval/manager.ts) | `ApprovalManager` 单例：极简审批（Set + 转调 core registry） |
| [src/service/bash/handler.ts](../../src/service/bash/handler.ts) | `bash.list` / `bash.kill` handler |
| [src/service/brain/list.ts](../../src/service/brain/list.ts) | `brain.list` handler |
| [src/service/runtime/set.ts](../../src/service/runtime/set.ts) | `runtime.set` handler |
| [src/service/sense/list.ts](../../src/service/sense/list.ts) | `sense.list` handler |

## RPC 模式

四种消息：`Request`（C→S）、`Response`（S→C 请求返回）、`Chunk`（S→C 流式增量，stream 带 seq 走二进制帧）、`Notification`（S→C 推送）。完整字段、传输帧格式、错误码见 [../protocol.md](../protocol.md)；类型与路由机制见 [./message.md](./message.md)。

Router 分发要点：handler 返回普通 `Promise` → 直接 Response；返回 `AsyncGenerator` → `wrapStreamingHandler` 迭代 yield Chunk/Notification、最终 return ResponseData 包装成 Response（详见 [./message.md](./message.md)「关键流程」）。

## Handler 总览

| RPC 方法 | Handler | 文件 | 流式 | 一句话 |
|----------|---------|------|------|--------|
| `brain.list` | `handleBrainList` | [brain/list.ts](../../src/service/brain/list.ts) | 否 | 列 config.yaml 的 brain + 全局 senseGroups |
| `sense.list` | `handleSenseList` | [sense/list.ts](../../src/service/sense/list.ts) | 否 | 列 config.yaml 的 sense_groups（原始字符串，含 `:level` 后缀） |
| `runtime.set` | `handleRuntimeSet` | [runtime/set.ts](../../src/service/runtime/set.ts) | 否 | 原子设置 chat 的 brain + senseGroups |
| `chat.create` | `handleChatCreate` | [chat/handler.ts](../../src/service/chat/handler.ts) | 否 | 建 chat + ensureChat 注入 runtime + 加载历史 |
| `chat.list` | `handleChatList` | 同上 | 否 | 全局列表（读冗余 message_count） |
| `chat.get` | `handleChatGet` | 同上 | 是 | 流式载入历史 + loaded + canResume |
| `chat.delete` | `handleChatDelete` | 同上 | 否 | clearChatRuntime + deleteChat |
| `chat.send` | `handleChatSend` | [chat/send.ts](../../src/service/chat/send.ts) | 是 | 流式发送；恢复撤回；运行中仅入队 |
| `chat.resume` | `handleChatResume` | 同上 | 是 | 续接（无 prompt），恢复执行 / 继续 loop |
| `sense.approval` | `handleSenseApproval` | 同上 | 否 | 转调 approvalManager.confirm |
| `chat.abort` | `handleChatAbort` | 同上 | 否 | abort generator + 强制解绑 + 清内存 |
| `bash.list` | `handleBashList` | [bash/handler.ts](../../src/service/bash/handler.ts) | 否 | 列 chat 挂起的 bash 进程 |
| `bash.kill` | `handleBashKill` | 同上 | 否 | 杀死挂起 bash 进程组 |

> ⚠ `../protocol.md` 方法表未列 `chat.abort` / `bash.list` / `bash.kill`（文档滞后）。`Method` 常量全集见 [./message.md](./message.md)「Method 常量」。chat.* 流程细节见 [./chat.md](./chat.md)。

## 核心概念 / 导出

- **`startService(port)`**（index.ts）：唯一对外启动入口，返回 `WebSocketServer`。
- **`RpcRouter`**（message/router.ts）：`register` / `handle`，handler 联合 `HandlerContext`（含 requestId、connectionId）。
- **`connectionManager`**（websocket/connection.ts 单例）：chat 活跃绑定、审批超时、close abort。
- **`transport`**（websocket/transport.ts 单例）：帧编解码。
- **`approvalManager`**（approval/manager.ts 单例）：极简审批。
- **`chatRuntimes`**（chat/runtime.ts 模块级私有 Map）+ `ensureChat`/`setRuntime` 等导出。

## 关键流程 / 数据流

核心数据流（WebSocket 收 Request → 推送）：

```
ws.on("message")
  → transport.parseMessage → isRequest?
  → router.handle(request, ctx)
     → handler(ctx, params)
        → [chat.send/resume] AgentBuilder.run/resume → AsyncGenerator<MiddlewareChunk>
           → observeAgentChunks(gen, chatId, getMessages)   // 拦截 effect 做 DB/审批副作用
           → streamAgentChunks(gen, rid)                    // MiddlewareChunk → Chunk/Notification
     → wrapStreamingHandler 迭代 yield
  → handleRequest 逐帧：
       notification(interrupt) → setRequestApprovalId + startApprovalTimeout(15min)
       ws.send(transport.encode(item))                      // Chunk/Notification 编码
     最终 Response → ws.send(transport.serializeMessage)
  → clearApprovalTimeout + removePendingRequest
```

各子环节展开见对应子文档：[./message.md](./message.md)（路由）、[./websocket.md](./websocket.md)（传输/连接）、[./chat.md](./chat.md)（chat 流式/observer/审批）。

## 单文件 Handler 章节

### approval/manager —— 极简审批管理器

| 项 | 内容 |
|----|------|
| 源码 | [approval/manager.ts](../../src/service/approval/manager.ts) |
| 对应 RPC | 无直接 RPC；被 observer（`register`）与 `sense.approval`（`confirm`）、ws close（`abort`）调用 |
| 职责 | 极简审批：仅维护 `Set<approvalId>`，`confirm`/`abort` 转调 core [approvalRegistry](../../src/core/sense/approvalRegistry.ts) 解除 senseMiddleware 的 await Promise |

```ts
class ApprovalManager {
  private approvals = new Set<string>();
  register(approvalId): void;                                  // observer 收 sense_pending 时调
  confirm(approvalId, action:"accept"|"reject", reason?): void; // → resolveApproval(id, action, reason)
  abort(approvalId): void;                                      // → rejectApproval(id, Error("approval aborted"))
}
export const approvalManager: ApprovalManager;
```

> ⚠ **P1-11 解耦后**：`ApprovalManager` 不再存 resolve/reject 函数指针，只登记 id，触发由 core registry 负责。`.claude/CLAUDE.md` 仍写「存 approvalResolve 回调」——与代码不符。无 DB 持久化（pending sense 靠 messages.content 空判定，见 [db.md](../db.md)）。完整 service 侧审批流程见 [./chat.md](./chat.md)「审批 service 侧流程」。

### bash/handler —— 挂起 bash 进程管理

| 项 | 内容 |
|----|------|
| 源码 | [bash/handler.ts](../../src/service/bash/handler.ts) |
| 对应 RPC | `bash.list`（`handleBashList`）、`bash.kill`（`handleBashKill`） |
| 职责 | 列出 / 杀死某 chat 挂起的 bash 子进程（进程组）。注册表由 agent 层持有 |

```ts
handleBashKill(ctx, {chatId, pid}): Promise<{chatId, pid, killed: boolean}>   // killBashProcess(chatId, pid)
handleBashList(ctx, {chatId}): Promise<{chatId, processes: BashProcessInfo[]}> // listBashProcesses(chatId)
registerBashHandlers(router): void;  // 注册 Method.BASH_KILL / BASH_LIST
```

`BashProcessInfo`（[message/types.ts](../../src/service/message/types.ts)）对齐 agent/sense/processRegistry 的 `BashProcessEntry`（service 层不反向依赖 agent，独立定义）。范式同 `ApprovalManager` 调 core registry——注册表在 agent/core 层，service 层只触发。`killed=false` 表示 pid 已不在挂起表中。

### brain/list —— 列出 brain

| 项 | 内容 |
|----|------|
| 源码 | [brain/list.ts](../../src/service/brain/list.ts) |
| 对应 RPC | `brain.list`（`handleBrainList`） |
| 职责 | 枚举 `config.llm.brain` 全部 brain（name/provider/model/thinking）+ 全局全量 senseGroups |

```ts
handleBrainList(ctx, params): Promise<{brains: Array<{name, provider, model, thinking?, senseGroups: string[]}>}>;
registerBrainHandlers(router): void;
```

`senseGroups` 返回 `Object.keys(config.sense_groups ?? {})`，全局全量、每个 brain 相同（交互示例见 [../interaction.md](../interaction.md) brain.list）。

### runtime/set —— 原子设置 runtime

| 项 | 内容 |
|----|------|
| 源码 | [runtime/set.ts](../../src/service/runtime/set.ts) |
| 对应 RPC | `runtime.set`（`handleRuntimeSet`） |
| 职责 | 原子校验 + 设置 chat 的 brain + senseGroups（每轮可换） |

```ts
handleRuntimeSet(ctx, {chatId, brain, senseGroups}): Promise<{chatId, brain, senseGroups}>;
```

流程：`getChat` 存在性校验 → `parseRuntimeSelection(p, "runtime.set")`（[agent/runtimeResolver](../../src/agent/runtimeResolver.ts)）→ `setRuntime(chatId, selection)`（[chat/runtime.ts](../../src/service/chat/runtime.ts)，原子注入 builder + 持久化 metadata.runtime）。前置：chat 必须已存在（`chat.create`）。

### sense/list —— 列出 sense groups

| 项 | 内容 |
|----|------|
| 源码 | [sense/list.ts](../../src/service/sense/list.ts) |
| 对应 RPC | `sense.list`（`handleSenseList`） |
| 职责 | 枚举 `config.sense_groups`（name + senses 原始字符串数组） |

```ts
handleSenseList(ctx, params): Promise<{senseGroups: Array<{name, senses: string[]}>}>;
registerSenseHandlers(router): void;
```

`senses` 为 config 原始字符串，含 `:level` 后缀（如 `execute_command:auto`），**未解析**（解析发生在 agent RuntimeResolver.resolveSense，见 [../../src/agent/runtimeResolver.ts](../../src/agent/runtimeResolver.ts)）。

## 依赖与关联 ⭐

**被依赖：**

- [src/index.ts](../../src/index.ts)：`startService(port)`、（间接）`getSoulDb`/`closeAllDbs`。

**依赖（跨模块）：**

- [@/agent/builder](../../src/agent/builder.ts)、[@/agent/runtimeResolver](../../src/agent/runtimeResolver.ts)：chat/ + runtime/ handler。
- [@/agent/sense/processRegistry](../../src/agent/sense/processRegistry.ts)：`killBashProcess` / `listBashProcesses`（bash/handler）。
- [@/core/sense/approvalRegistry](../../src/core/sense/approvalRegistry.ts)：`resolveApproval` / `rejectApproval`（approval/manager）。
- [@/db/chat](../../src/db/chat.ts)、[@/db/index](../../src/db/index.ts)：chat/ handler、chat/observer、runtime/、brain/ 等（详见 [db.md](../db.md)）。
- [@/utils/config](../../src/utils/config.ts)：brain/list、sense/list 读 config；index.ts 读 `config.server.port`。
- [@/utils/logger](../../src/utils/logger/index.ts)、[@/utils/generator](../../src/utils/generator.ts)、[@/utils/json](../../src/utils/json.ts)。
- `ws`、`better-sqlite3`（间接，经 db 模块）。

**横切参考：**

- [../protocol.md](../protocol.md)：协议规范（消息结构、方法、错误码、HTTP 端点）。
- [../interaction.md](../interaction.md)：各方法端到端交互序列。
- [../mock.md](../mock.md)：前端/mock 与本服务交互。
- [db.md](../db.md)：DB schema、状态判定、路由。

## 扩展点

- **新增 RPC 方法**：types.ts 加 Method + Request/Response Data；写 handler（`Promise` 或 `AsyncGenerator`）+ `register*Handlers`；service/index.ts `startService` 调注册；同步补 [../protocol.md](../protocol.md)。
- **新增单文件 handler 模块**：仿 brain/list.ts（读 config）或 bash/handler.ts（调 agent 注册表）模式，新建 `service/<name>/handler.ts`。
- **更换传输/服务实现**：`createWebSocketServer` 是唯一 ws 入口；`transport`/`connectionManager` 为单例，替换时需保持 chat 绑定与审批超时语义。
