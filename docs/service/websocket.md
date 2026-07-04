# WebSocket 传输模块

> 源码 [src/service/websocket/](../../src/service/websocket/) ｜ 上级 [service/README.md](./README.md) ｜ 相关 [./message.md](./message.md)（RPC 路由/类型）、[../protocol.md](../protocol.md)（协议规范）

> **本文档范围**：传输模块**实现**——WebSocketServer 封装、ConnectionManager 连接状态管理、二进制帧编解码（transport）。
> **协议规范**（消息结构、Method 列表、Notification/Chunk 字段、错误码、HTTP `/api/config`）见 [../protocol.md](../protocol.md)，本文不重复。

## 职责

- **服务封装**（index.ts）：创建 `ws.WebSocketServer`、绑定 connection/message/close/error、把 Request 分发给 `RpcRouter`、迭代流式 handler 结果逐帧推送、interrupt 后启动审批超时。
- **连接状态**（connection.ts）：`ConnectionManager` 维护 ws→state、chatId→connectionId 活跃绑定（拒绝跨连接并发同 chat）、pendingRequests（含审批 ID + 超时计时器）、关闭时 abort pending approval 并释放 chat 绑定。
- **帧编解码**（transport.ts）：`Transport` 单例，按 `config.server.transport`（`binary`/`json`）编码 Chunk/Notification；Request/Response 始终走 JSON。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [src/service/websocket/index.ts](../../src/service/websocket/index.ts) | `createWebSocketServer({port, router})`：ws 服务、消息分发、流式迭代推送、interrupt→审批超时、错误兜底 |
| [src/service/websocket/connection.ts](../../src/service/websocket/connection.ts) | `ConnectionManager`/`connectionManager` 单例：连接状态、chat 活跃绑定、pendingRequest 审批超时、close abort |
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
        setRequestApprovalId(ws, request.id, approvalId)
        startApprovalTimeout(ws, request.id, onTimeout)          // 15min，超时发 TIMEOUT Response + close
      ws.send(transport.encode(item))                            // Chunk/Notification 编码推送
  else:
    ws.send(transport.serializeMessage(result))                  // 非流式 Response
  clearApprovalTimeout + removePendingRequest
```

### ConnectionManager（connection.ts）

```ts
export interface ConnectionState {
  id: string;                 // randomUUID
  ws: WebSocket;
  pendingRequests: Map<string, PendingRequest>;  // requestId → { approvalId?, approvalTimeoutTimer?, approvalTimeoutMs }
}
export const connectionManager: ConnectionManager;
```

| 方法 | 作用 |
|------|------|
| `create(ws)` | 建 ConnectionState 入 Map |
| `addPendingRequest(ws, requestId, timeoutMs?)` | 记 pending，默认 `defaultApprovalTimeout=900000`（15min） |
| `setRequestApprovalId(ws, requestId, approvalId)` | interrupt 后记录审批 ID（供 close 时 abort） |
| `startApprovalTimeout(ws, requestId, onTimeout)` | 启动 setTimeout，到点回调（发 TIMEOUT + close） |
| `clearApprovalTimeout(ws, requestId)` | handler 完成 / 审批通过时清除 |
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

- stream chunk（带 seq，`0x01`）：`[0x01][seq:4 bytes BE][requestId_len:1][requestId:n][payload_json]`
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

### 审批超时（interrupt → 15min）

```
streamMapper yield interrupt notification
  → handleRequest: setRequestApprovalId + startApprovalTimeout(15min)
    ├─ 15min 内 sense.approval 到达 / handler 正常结束 → clearApprovalTimeout
    └─ 超时 → onTimeout: ws.send Response(TIMEOUT, "Approval timeout - chat ended") + connectionManager.close(ws)
```

### 连接关闭流程（connection.ts `close`）

关键：**不调 `gen.return()`**（await 态无法立即终止，且 return 传播与 senseMiddleware catch 的 yield 交互会导致链条死锁——generator suspended 在 return completion 下的 yield，checkpoint/observer finally 永不执行，assistant 无法落库）。改靠 approval abort 让 senseMiddleware 正常 catch 结束。

```
close(ws):
  for each pendingRequest in state.pendingRequests:
    if pending.approvalId:
      approvalManager.abort(approvalId)     // → core approvalRegistry.rejectApproval → senseMiddleware await 解除
    if pending.approvalTimeoutTimer: clearTimeout(...)
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
- **改超时/策略**：`defaultApprovalTimeout`（15min）可调；`addPendingRequest(ws, requestId, customMs)` 支持单请求覆盖。
- **新增帧类型**：`FRAME_TYPE` 加键 + Transport 增对应 encode 分支；同步更新 [../protocol.md](../protocol.md) 帧格式章节。
- **多实例/集群**：当前 `connectionManager`/`transport` 均模块级单例，单进程内有效。多实例需改造 chat 绑定与 pending approval 状态共享（当前依赖进程内 Map）。
