# WebSocket 传输模块

> 源码 [src/service/websocket/](../../src/service/websocket/) ｜ 上级 [service/README.md](./README.md) ｜ 相关 [./message.md](./message.md)（RPC 路由/类型）、[../protocol.md](../protocol.md)（协议规范）

> **本文档范围**：传输模块**实现**——WebSocketServer 封装、ConnectionManager 连接状态管理、二进制帧编解码（transport）。
> **协议规范**（消息结构、Method 列表、Notification/Chunk 字段、错误码、HTTP `/api/config`）见 [../protocol.md](../protocol.md)，本文不重复。

## 职责

- **服务封装**（index.ts）：创建 `ws.WebSocketServer`、绑定 connection/message/close/error、把 Request 分发给 `RpcRouter`、迭代流式 handler 结果逐帧推送、interrupt 后记 approvalId（供 close park；限时超时由 core approvalRegistry 管，非本层）。
- **连接状态**（connection.ts）：`ConnectionManager` 维护 ws→state、chatId→connectionId 活跃绑定（拒绝跨连接并发同 chat）、pendingRequests（含审批 ID 映射）、关闭时 park pending approval 并释放 chat 绑定。
- **帧编解码**（transport.ts）：`Transport` 单例，按 `config.server.transport`（`binary`/`json`）编码 Chunk/Notification；Request/Response 始终走 JSON。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [src/service/websocket/index.ts](../../src/service/websocket/index.ts) | `createWebSocketServer({port, router})`：ws 服务、消息分发、流式迭代推送、interrupt→记 approvalId、错误兜底 |
| [src/service/websocket/connection.ts](../../src/service/websocket/connection.ts) | `ConnectionManager`/`connectionManager` 单例：连接状态、chat 活跃绑定、pendingRequest approvalId 映射、close park |
| [src/service/websocket/transport.ts](../../src/service/websocket/transport.ts) | `Transport`/`transport` 单例：`encode`（Chunk/Notification→Buffer/string）、`parseMessage`/`serializeMessage`（Request/Response JSON） |

## 核心概念 / 导出

### createWebSocketServer（index.ts）

```ts
interface WebSocketServerConfig { port: number; router: RpcRouter; }
export function createWebSocketServer(config: WebSocketServerConfig): WebSocketServer;
```

内部 `wss.on("connection", ws => ...)`：
1. `connectionManager.create(ws)` 生成 `ConnectionState`（含 randomUUID id + pendingRequests Map）。
2. `ws.on("message", data => handleMessage(ws, state, buffer, router))`。
3. `ws.on("close", () => connectionManager.close(ws))`。
4. `ws.on("error", ...)` 仅日志。

### handleMessage / handleRequest 流程

```
handleMessage:
  raw = transport.parseMessage(buffer)       // JSON 解析
  if isRequest(raw): handleRequest(...)
  else: sendError("未知消息类型")

handleRequest:
  connectionManager.addPendingRequest(ws, request.id)
  ctx = { requestId: request.id, connectionId: state.id }
  result = await router.handle(request, ctx)
  if isAsyncGenerator(result):               // 流式
    while true:
      iter = await result.next()
      if iter.done: ws.send(serializeMessage(iter.value)); break  // 最终 Response
      item = iter.value
      if item.kind === "notification" && item.type === "interrupt":
        setRequestApprovalId(ws, request.id, approvalId)            // 供 close 时 park；限时超时由 core approvalRegistry 管
      ws.send(transport.encode(item))                            // Chunk/Notification 编码推送
  else:
    ws.send(transport.serializeMessage(result))                  // 非流式 Response
  removePendingRequest
```

### ConnectionManager（connection.ts）

```ts
export interface ConnectionState {
  id: string;                 // randomUUID
  ws: WebSocket;
  pendingRequests: Map<string, PendingRequest>;  // requestId → { approvalId? }（approvalId 供 close 时 park）
}
export const connectionManager: ConnectionManager;
```

| 方法 | 作用 |
|------|------|
| `create(ws)` | 建 ConnectionState 入 Map |
| `addPendingRequest(ws, requestId)` | 记 pending（`{ approvalId? }`） |
| `setRequestApprovalId(ws, requestId, approvalId)` | interrupt 后记录审批 ID（供 close 时 park） |
| `bindChatConnection(chatId, connectionId)` | 同 chat 活跃期间绑定；已被其他连接占用则 **throw**（P0-3 跨连接并发拒绝） |
| `releaseChatConnection(chatId, connectionId)` | 仅 owner 匹配才解绑（防误释放后绑定的 owner） |
| `forceReleaseChatConnection(chatId)` | 不校验 owner，chat.abort 跨连接重连清旧 owner |
| `close(ws)` | 见下「关闭流程」 |

### Transport（transport.ts）

```ts
const FRAME_TYPE = { CHUNK: 0x01, JSON: 0x02 } as const;
export class Transport {
  private get binary(): boolean;        // 惰性读 config.server.transport === "binary"
  encode(msg: Chunk | Notification): Buffer | string;
  parseMessage(data: Buffer | string): unknown;       // Request/Response 用（JSON）
  serializeMessage(msg: unknown): string;             // Request/Response 用（JSON）
}
export const transport: Transport;
```

**二进制帧格式**（与 [../protocol.md](../protocol.md) 一致，编码实现在此）：

- stream chunk（`0x01`）：`[0x01][requestId_len:1][requestId:n][payload_json]`
- 其他 Chunk/Notification（`0x02`）：`[0x02][full_json]`
- json 模式：`encode` 全部返回 JSON 字符串（便于调试）。
- Request/Response 始终 JSON：`parseMessage`（`safeJsonParse`）/`serializeMessage`（`JSON.stringify`）。

## 关键流程 / 数据流

### chat 连接绑定（防跨连接并发，P0-3）

```
chat.send/resume handler:
  if agent.isRunning(): 仅入队输入，不绑定连接，return {chatId}      // 复用活跃流
  connectionManager.bindChatConnection(chatId, ctx.connectionId)
    └─ 已被其他连接占用 → throw "Chat ... is busy (active on another connection)"
                     → handler yield error notification + return 失败 Response
  ... 流式执行 ...
  finally: connectionManager.releaseChatConnection(chatId, ctx.connectionId)
```

`chat.abort` 用 `forceReleaseChatConnection` 无条件解绑（跨连接重连清旧 owner）。

### 审批超时（approvalRegistry 独占，service 层不起 timer）

限时审批超时由 **core approvalRegistry** 独占管理（非 service websocket 层）：

```
senseMiddleware（tool.ts）needsApproval → approvalRegistry.createApproval(id, global.approval_timeout)
  ├─ approval_timeout=0 / undefined → 不创建 timer（不限时，永久等用户决）
  ├─ 用户 sense.approval → approvalManager.confirm → resolveApproval(id) → 清 timer + resolve
  └─ 超时 → registry 内部 timer fire → resolve({ action:'reject', reason:'审批超时' })
            → senseMiddleware await 解除 → yield sense_reject → streamMapper 发 rejected notification
            → 前端 routeNotification 自动关审批卡片 → 子 loop 继续（= 用户点 Reject 的正常路径）
```

websocket handleRequest 收 interrupt 仅做 `setRequestApprovalId`（记 approvalId→requestId 供 close 时 park），**不再起 timer**。旧 `startApprovalTimeout` 超时 `ws.send(TIMEOUT)+close(ws)` 拆连接是 bug 源（覆盖 registry 的正确 reject，且 close(ws) 不关 socket 留「socket 活+后端态删」断裂态），已废。WS 断连走 close(ws)→park（见下）。

### 连接关闭流程（connection.ts `close`）

关键：**不调 `gen.return()`**（await 态无法立即终止，且 return 传播与 senseMiddleware catch 的 yield 交互会导致链条死锁——generator suspended 在 return completion 下的 yield，checkpoint/observer finally 永不执行，assistant 无法落库）。改靠 approval park 让 senseMiddleware 正常 catch 结束。

```
close(ws):
  for each pendingRequest in state.pendingRequests:
    if pending.approvalId:
      approvalManager.park(approvalId)     // → core approvalRegistry.rejectApproval(AgentParkError) → senseMiddleware await 解除（WS 断连挂起，子 chat 保持 canResume 待重连，observer 静默不唤主）
  for [chatId, connId] in activeChatConnections:   // 释放本连接绑定的所有 chat
    if connId === state.id: delete
  connections.delete(ws)
```

> 详见 [./chat.md](./chat.md)「abort 与 pending approval」。

## 依赖与关联 ⭐

**被依赖：**

- [service/index.ts](../../src/service/index.ts)：`createWebSocketServer({ port, router })`。
- [service/chat/send.ts](../../src/service/chat/send.ts)：`connectionManager.bindChatConnection` / `releaseChatConnection` / `forceReleaseChatConnection`（chat.abort）。
- [service/approval/manager.ts](../../src/service/approval/manager.ts)：`connection.ts` import `approvalManager`（close 时 abort pending approval）。

**依赖：**

- `ws`（WebSocketServer / WebSocket）。
- [./message](../../src/service/message/index.ts)：`RpcRouter`、`Request`、`createResponse`/`createError`/`ErrorCode`/`isRequest`/`isAsyncGenerator`。
- [./connection](../../src/service/websocket/connection.ts)（index.ts 用 connectionManager）、[./transport](../../src/service/websocket/transport.ts)（index.ts 用 transport）。
- [@/utils/generator](../../src/utils/generator.ts)：`isAsyncGenerator`。
- [@/utils/logger](../../src/utils/logger/index.ts)：全流程日志。
- [@/utils/config](../../src/utils/config.ts)：`config.server.transport`（binary/json 模式切换）。
- [@/utils/json](../../src/utils/json.ts)：`safeJsonParse`（parseMessage 兜底）。

**横切参考：**

- [../protocol.md](../protocol.md)：传输格式规范、二进制帧格式定义、HTTP `/api/config`。
- [./chat.md](./chat.md)：chat 连接绑定、审批超时、abort 与 pending approval 的 service 侧流程。

## 扩展点

- **换底层传输**：当前固定 `ws`。若换 uWebSockets 等，改 `createWebSocketServer` 的 server 构造与 message/close 事件绑定，`Transport`/`ConnectionManager` 可复用。
- **改超时/策略**：限时审批超时由 core approvalRegistry 管（`createApproval(id, global.approval_timeout)`，见 tool.ts），调 `global.approval_timeout`（`0`=不限时）；websocket 层不再起 timer。
- **新增帧类型**：`FRAME_TYPE` 加键 + Transport 增对应 encode 分支；同步更新 [../protocol.md](../protocol.md) 帧格式章节。
- **多实例/集群**：当前 `connectionManager`/`transport` 均模块级单例，单进程内有效。多实例需改造 chat 绑定与 pending approval 状态共享（当前依赖进程内 Map）。
