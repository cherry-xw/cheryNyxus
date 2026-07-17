# Message 消息类型与 RPC 路由

> 源码 [src/service/message/](../../src/service/message/) ｜ 上级 [service/README.md](./README.md) ｜ 相关 [./websocket.md](./websocket.md)（传输层）、[../protocol.md](../protocol.md)（协议规范）

本文档讲 RPC **消息类型定义**与 **RpcRouter 方法路由机制**（service/message/ 模块实现）。协议规范（消息结构详表、传输二进制帧格式、错误码全集、方法列表交互说明）见 [../protocol.md](../protocol.md)，本文不重复。

## 职责

- **类型层**（types.ts）：定义全部 RPC 消息类型（Request / Response / Chunk / Notification）、`RpcMethodMap` 方法级参数/结果映射、Method/ErrorCode 常量、工厂函数、类型守卫。service 内部以此为唯一协议类型契约；web 通过自己的传输 DTO 与 `agentApi` 消费线上结构。
- **路由层**（router.ts）：`RpcRouter` 注册 handler、分发请求、自动区分普通 Promise 与 AsyncGenerator handler、统一错误转 RpcError、保证流式 handler 最终 return Response。
- **入口**（index.ts）：re-export types + router。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [src/service/message/types.ts](../../src/service/message/types.ts) | 全部 RPC 类型定义、`Method`/`ErrorCode` 常量、`createResponse/Chunk/Notification/Error` 工厂、`isRequest/isResponse` 类型守卫 |
| [src/service/message/router.ts](../../src/service/message/router.ts) | `RpcRouter` 类、`HandlerContext`/`HandlerFn` 类型、`createRouter()` 工厂、流式包装与错误转换 |
| [src/service/message/index.ts](../../src/service/message/index.ts) | barrel：`export * from types + router` |

## 核心概念 / 导出

### 消息四象限

```ts
interface Request  { id; kind:"request";       method; params }              // C→S
interface Response { id; kind:"response";      requestId; success; data?; error? }  // S→C（请求返回）
interface Chunk    { kind:"chunk"; type:"stream"|"staged"; requestId; data }         // S→C（流式增量）
interface Notification { kind:"notification"; type: NotificationType; requestId; data } // S→C（推送）
```

详细字段（含 `StreamChunkData`/`StagedChunkData`/各 `NotificationData`）见 [../protocol.md](../protocol.md)「消息结构」「Notification 类型」「Chunk 类型」三节。RPC 请求/响应不再依赖两个互不关联的宽联合：`RpcMethodMap` 将每个 `Method` 显式绑定到 `{ params, result }`，`ParamsOf<M>` / `ResultOf<M>` 为 handler 提供方法级类型；`RequestData` / `ResponseData` 仅作为动态传输边界的派生联合。

### NotificationType（types.ts 真实取值）

```ts
export type NotificationType =
  | "interrupt"    // 感官审批请求（streamMapper 据 SenseTriggerChunk 生成）
  | "accept"       // 感官执行成功
  | "rejected"     // 感官执行被拒
  | "consumed"     // 用户输入已入队
  | "loaded"       // chat.get 历史发完
  | "done"         // chat.send/resume loop 结束
  | "error"        // 错误
  | "replaced";    // 感官去重命中：历史 sense 结果被新读取替换（web 实时更新历史 sense block）
```

`replaced` 由 [chat/streamMapper.ts](../../src/service/chat/streamMapper.ts) 在 `message_updated` 携带 `replace` 时生成。详见 [./chat.md](./chat.md)。

### Method 与 RpcMethodMap

`Method` 常量定义所有合法 RPC 名称，完整运行时列表见 [../protocol.md](../protocol.md)「方法列表」。类型层使用同一组常量键建立方法映射：

```ts
interface RpcMethodMap {
  [Method.BRAIN_LIST]: { params: BrainListRequestData; result: BrainListResponseData };
  [Method.SKILLS_LIST]: { params: SkillsListRequestData; result: SkillsListResponseData };
  // ...每个 Method 恰好一项
  [Method.UTILS_OPEN_CONFIG_DIR]: {
    params: UtilsOpenConfigDirRequestData;
    result: UtilsOpenConfigDirResponseData;
  };
}

type ParamsOf<M extends Method> = RpcMethodMap[M]["params"];
type ResultOf<M extends Method> = RpcMethodMap[M]["result"];
```

`skills.list` 是无参 RPC，返回当前 `.chery/skills/` 中用户技能的元数据
`{skills:[{name,description,trigger?,extra?,nameDescTokens,triggerTokens,contentTokens,promptTokens,contextTokens}]}`。

- **`contextTokens`**：激活该 skill 后预计新增的上下文 token（即 `promptTokens`，JSON 序列化全字段，`ceil(字符数/4)`），供发送窗口指令 tag hover 卡片展示「Token 消耗量」。
- **`nameDescTokens` / `triggerTokens` / `contentTokens` / `promptTokens`**：分别对应 SKILL.md 各部分 token，由 `computeSkillTokens` 一次性算好，供后端 `computeContextBreakdown.skills` 等模块直接复用，不重复 estimateTokens。

仅用于发送窗口的 `/` 命令菜单；`/compact` 仍是固定系统入口，但其正文从
`.chery/command/compact.md` 读取，不通过该 RPC 伪装成可删除的用户技能。compact assistant 摘要在消息行
的 `context_compaction` 标记为真时建立新的模型上下文边界；`chat.get` 仍返回完整历史并在 staged 内容中携带该标记供 UI 渲染。

`RpcRouter.register(Method.X, handler)` 会据 Method 字面量自动校验 handler 的 params/result；`requestSchemas` 继续通过 `satisfies Record<Method, ...>` 保证运行时校验表完整。新增 `utils.openConfigDir` 固定打开后端主机的 `CHERY_DIR/.chery`，不接收客户端路径。

### ErrorCode 常量

```ts
export const ErrorCode = {
  METHOD_NOT_FOUND: "METHOD_NOT_FOUND",
  INTERNAL:         "INTERNAL",
  TIMEOUT:          "TIMEOUT",
  NOT_FOUND:        "NOT_FOUND",
  INVALID_PARAMS:   "INVALID_PARAMS",
} as const;
```

`NOT_FOUND` / `INVALID_PARAMS` 主要由资源查询与 MCP 管理 handler 显式返回；普通 handler 抛出的异常仍由 router 转成 `INTERNAL`。

### HandlerFn 与 HandlerContext

```ts
export interface HandlerContext {
  requestId?: string;
  connectionId: string;   // 来自 ConnectionManager.create 生成的 UUID
}

// handler 可返回普通 Promise（非流式）或 AsyncGenerator（流式，yield Chunk|Notification，return ResponseData|Response）
export type HandlerFn<M extends Method> = (
  ctx: HandlerContext,
  data: ParamsOf<M>,
) => Promise<ResultOf<M> | Response>
   | AsyncGenerator<Chunk | Notification, ResultOf<M> | Response, unknown>;
```

### RpcRouter 核心方法

```ts
class RpcRouter {
  register<M extends Method>(method: M, handler: HandlerFn<M>): void;
  handle(request: Request, ctx: HandlerContext): Promise<Response | AsyncGenerator<Chunk|Notification, Response>>;
}
createRouter(): RpcRouter;
```

`handle()` 返回 `Response`（非流式）或 `AsyncGenerator`（流式），由 websocket 层用 `isAsyncGenerator` 判断后分别处理。

### 工厂与类型守卫

```ts
createResponse(requestId, success, data?, error?): Response;
createChunk(type: "stream"|"staged", requestId, data): Chunk;
createNotification(type, requestId, data): Notification;
createError(code, message): RpcError;

isRequest(msg): msg is Request;       // 判 kind === "request"
isResponse(msg): msg is Response;
```

## 关键流程 / 数据流

### 请求分发（router.handle）

```
router.handle(request, ctx)
  ├─ handlers.get(method) 未命中 → createResponse(success=false, error=METHOD_NOT_FOUND)
  ├─ 命中 → definition.handler(ctx, params)
  │    ├─ isAsyncGenerator(result)?
  │    │    ├─ 是 → wrapStreamingHandler(generator, requestId)  // 流式
  │    │    └─ 否 → await result
  │    │         ├─ isResponse(data)? → 直接返回（handler 自建 Response）
  │    │         └─ 否 → createResponse(requestId, true, data)
  │    └─ catch → toRpcError(err) → createResponse(success=false, error)
```

### 流式 handler 包装（wrapStreamingHandler）

确保 AsyncGenerator handler 最终 return 一个 Response：

```
async function* wrapStreamingHandler(generator, requestId):
  try:
    while true:
      iter = await generator.next()
      if iter.done:
        if isResponse(iter.value): return normalizeResponseRequestId(value, requestId)
        return createResponse(requestId, true, iter.value)   // generator return 的 ResponseData
      yield iter.value                                        // 透传 Chunk/Notification
  catch err:
    logger.error(...)
    yield { kind:"notification", type:"error", requestId, data:{message} }  // 错误先以 notification 推送
    return createResponse(requestId, false, undefined, createError(...))     // 再返回失败 Response
```

`normalizeResponseRequestId` 保证 generator 自建 Response 的 `requestId` 与请求一致（不一致则重建）。

> **设计要点**：handler 内部抛异常会被 router 捕获转 Response，websocket 层无需再处理 handler 异常。流式 handler 的错误同时产出 `error` notification + 失败 Response（见 [../interaction.md](../interaction.md)「硬失败」路径）。

## 依赖与关联 ⭐

**被依赖（谁用类型/路由）：**

- [service/index.ts](../../src/service/index.ts)：`createRouter()` + 调各模块 `register*Handlers(router)` 注册全部方法。
- [service/websocket/index.ts](../../src/service/websocket/index.ts)：`router.handle(request, ctx)` 分发；`isAsyncGenerator` 判断流式；用 `createResponse`/`createError`/`ErrorCode` 发错误兜底。
- [service/websocket/connection.ts](../../src/service/websocket/connection.ts)：`import type { RpcRouter }`（仅类型）。
- 所有 handler（brain/sense/runtime/chat/bash）：import `Method`/`Request/Response Data` 类型 + `HandlerContext`/`HandlerFn` + `createChunk`/`createNotification` 工厂。
- [service/chat/streamMapper.ts](../../src/service/chat/streamMapper.ts)：`createChunk`/`createNotification` + `Chunk`/`Notification` 类型。

**依赖：**

- [@/utils/generator](../../src/utils/generator.ts)：`isAsyncGenerator`（区分普通 Promise 与流式 handler）。
- [@/utils/logger](../../src/utils/logger/index.ts)：router 内 `logger.error` 记录 handler 失败。
- `crypto.randomUUID`：工厂函数生成 message id。
- `@/core/config`：仅 `SupervisionLevel` 枚举（用于 `InterruptNotificationData.supervisionLevel`、`SenseListResponseData.supervision`）。

**横切参考：**

- [../protocol.md](../protocol.md)：消息结构详表、错误码、HTTP `/api/config` 端点。
- [./websocket.md](./websocket.md)：transport 层如何把 Chunk/Notification 编码为二进制/JSON 帧发出。

## 扩展点

- **添加 RPC 方法**：
  1. types.ts：新增 request/result 类型、`Method` 常量，并在 `RpcMethodMap` 添加唯一映射项；无数据成功响应使用严格空对象类型，禁止裸 `{}`。
  2. schemas.ts：在 `requestSchemas` 添加同名键；`satisfies Record<Method, ...>` 会在缺项时编译失败。
  3. 写 handler 并在对应 `register*Handlers(router)` 注册；`register` 会按 Method 自动检查 params/result，无需手写泛型参数。
  4. 同步更新 `../protocol.md` 方法列表与 `./README.md` Handler 总览。
- **自定义错误码**：types.ts `ErrorCode` 加常量，handler 内 `createError(code, message)` 后 throw 或自建 Response 返回。router 的 `toRpcError` 当前固定转 `INTERNAL`，自定义 code 需 handler 主动 return Response 而非 throw。
- **消息类型扩展**：新增 NotificationType 时同步改 `NotificationData` 联合 + `streamMapper` 的映射分支。
