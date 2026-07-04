# Logger 统一日志（结构化事件 Trace）

> 源码 [src/utils/logger/](../../src/utils/logger/) ｜ 上级 [./README.md](./README.md) ｜ 相关 [./drain.md](./drain.md) ｜ 配置 [./README.md#config](./README.md)

## 职责

cheryClaw 全项目唯一日志出口。每条日志 = **一个 JSON 事件（单行）**，携带 `LogScope` 关联键，为「按会话还原用户每一步操作」的解读模块提供 trace 数据。

- **结构化事件**：主接口 `logger.event(type, data?, level?)`，输出 JSON 行（`format: json` 默认）。
- **ALS scope 传播**：`AsyncLocalStorage` 承载 `LogScope`，边界 `logger.run(scope, fn)` 注入，沿 async 链自动传播 —— 调用点无需透传 logger。
- **类型化句柄**：`MiddlewareContext.log` / `HandlerContext.log`（= 全局 logger，读 ALS），便于 IDE 发现。
- **事件目录**：~35 种 `type`，覆盖用户步骤 / chunk 结构 / 生命周期 / 诊断。
- **legacy 兜底**：`info/debug/warn/error(...args)` 转 `event("log.<level>", {message})`，未迁移调用点仍可用。
- **bash 子进程 + 通用文件日志工具集**（`logger.tools`）：与旧版一致，供 `execute_command` 等感官记录长跑命令。

> 设计取舍：牺牲直接人读性（JSON），换取机器可解析 + 完整溯源。解读模块按 `scope.traceId`（= chatId）过滤事件流即可重建单会话流程。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [types.ts](../../src/utils/logger/types.ts) | `LogLevel` / `LogScope` / `LogEvent` / `InternalLoggerConfig` / `Logger` / `LoggerTools` / `BashLogInfo`；仅类型 |
| [index.ts](../../src/utils/logger/index.ts) | `createLogger` 闭包工厂 + ALS 引擎（`runScope`/`getScope`）+ `event` JSON 格式化 + 默认 Proxy `logger` + `initLogger` + bash/文件工具 |

## 核心概念

### 配置

`.chery/config.yaml` 的 `global.logger`（[config.ts `LoggerConfig`](../../src/utils/config.ts#L86-L93)）：

```yaml
global:
  logger:
    level: info              # debug | info | warn | error | silent
    output: [console, file]  # (console | file)[]，可同时多处
    timestamp: true          # plain 格式下是否带时间戳
    location: true           # 是否带 [file:line] 调用位置
    format: json             # plain | json（默认 json）
```

缺省：`level=info`、`output=["console"]`、`timestamp=true`、`location=true`、`format="json"`。

### LogScope（会话关联键）

```ts
interface LogScope {
  traceId?: string;       // = chatId（会话，跨轮稳定）—— 解读模块的主过滤键
  requestId?: string;     // 单次 RPC 请求
  connectionId?: string;  // WebSocket 连接
  runId?: string;         // 预留：单次 chain 执行（当前 chat.send 下 ≈ requestId）
  spanId?: string;        // 嵌套 span（预留）
  parentSpanId?: string;
}
```

### 事件 JSON schema（单行一事件）

```json
{
  "ts": "2026-07-04T10:00:00.123Z",
  "level": "info",
  "type": "sense.result",
  "scope": { "traceId": "chat-a", "requestId": "r1", "connectionId": "c1" },
  "location": "streamMapper.ts:75",
  "data": { "senseCallId": "call_0", "name": "read_file", "resultLen": 1234, "hash": "..." }
}
```

无 scope 的全局事件（启动、`conn.open` 等）`scope` 为 `{}`；`data` 缺省时省略。

### 公开导出

```ts
// index.ts
export type { BashLogInfo, LogScope, LogEvent, Logger } from "./types.js";
export { LogLevel } from "./types.js";
export function initLogger(config?: ConfigLoggerConfig): Logger;   // 由 config.ts 调用
export const logger: Logger;                                        // Proxy 默认实例，延迟初始化
export function generateLogId(): string;                            // runId/spanId 生成（randomUUID）
```

### Logger 接口

```ts
interface Logger {
  event(type: string, data?: Record<string, unknown>, level?: LogLevel): void;  // 主接口
  run<T>(scope: Partial<LogScope>, fn: () => T): T;     // 边界注入（与父 scope 合并）
  getScope(): LogScope;                                  // 读当前 ALS scope（无则 {}）
  // legacy 兜底（转 event type=`log.<level>`, {message}）
  debug/info/warn/error(...args: unknown[]): void;
  close(): void;
  getConfig(): InternalLoggerConfig;
  setConfig(config: Partial<ConfigLoggerConfig>): void;
  tools: LoggerTools;
}
```

> `logger.write(message)` 已移除（0 调用点，死代码）。

## 关键流程

### ALS 传播边界（唯一有效点 = `handleRequest`）

ALS 只在 `als.run` 回调的**同步执行期**保持 store；async generator 的 body 在 `.next()` 时运行。故 **scope 必须包「迭代」而非「创建」**。流式链的最外层 `.next()` 在 [websocket/index.ts `handleRequest`](../../src/service/websocket/index.ts)（普通 async 函数，非 generator）—— 这是唯一能生效的 `logger.run` 边界：

```
handleRequest:
  await logger.run({ connectionId, requestId, traceId: extractChatId(params) }, async () => {
    req.start
    result = await router.handle(request, ctx)
    迭代 result.next()  ← 整条 handler → agent → 中间件 → observer/streamMapper 在此 scope 内执行
    req.end
  })
```

- `traceId` 由 `extractChatId(request.params)` 提取（chat.* / sense.approval 等携带 chatId 的方法）。
- 中间件深层、sense executor、provider：均在 `result.next()` 驱动下执行，自动携带 scope。
- **跨审批挂起保持**：senseMiddleware `await approvalPromise` 时，`handleRequest` 停在 `await result.next()`，scope 不丢；用户 `sense.approval` 解除 await，链条在同一 scope 续跑。
- **conn 层**（open/close/error）：在 `ws.on(...)` 回调，独立于请求 scope，用 `logger.run({connectionId}, () => logger.event(...))` 临时注入。

> 类型化句柄：`MiddlewareContext.log` / `HandlerContext.log` = 全局 `logger`（内部读 ALS）。中间件推荐 `ctx.log.event(...)`，util/sense 用裸 `logger.event(...)`，二者等价。

### 一次事件的数据流

```
某模块 logger.event("sense.result", { senseCallId, name, resultLen })
  └─ logger Proxy → getLogger() → Logger.event(type, data, level)
       ├─ if config.level > level: return（静默）
       ├─ scope = ALS.getStore() ?? {}
       ├─ 构造 LogEvent { ts, level, type, scope, location?, data? }
       ├─ JSON.stringify（或 renderPlain）
       ├─ if output 含 console: stdout/stderr.write(line + "\n")
       └─ if file stream: 写 .chery/logs/YYYY-MM-DD.log
```

## 事件目录

解读模块据此还原流程。`scope` 字段统一携带 `traceId`（chatId）/ `requestId` / `connectionId`。

### A. chokepoint 自动派生（替散落中间件 log）

| 派生点 | 事件 |
|---|---|
| [streamMapper.ts](../../src/service/chat/streamMapper.ts) | `staged`、`sense.trigger`、`sense.result`、`sense.rejected`、`input.consumed`、`chat.run.error`、`chat.run.done`、`message.replaced` |
| [observer.ts](../../src/service/chat/observer.ts) | `message.created`、`message.updated`、`message.replaced.db`、`approval.pending` |

### B. 显式事件

| 类别 | type |
|---|---|
| lifecycle | `conn.open` / `conn.close` / `conn.error` / `conn.closing` / `conn.notfound`、`req.start` / `req.end` / `req.error` / `req.handler.error` / `req.stream.error` |
| chat 管理 | `chat.create` / `chat.list` / `chat.get` / `chat.delete` |
| 用户动作 | `chat.send.start`（`mode: send\|resume`）、`chat.send.queued`、`chat.send.revoke`、`chat.send.aborted`、`chat.send.error`、`chat.abort`、`chat.bind` / `chat.bind.failed` / `chat.release` |
| 审批 | `sense.approval`、`approval.pending`、`approval.wait`、`approval.timeout` |
| runtime | `runtime.set` |
| chain 内 | `loop.start` / `loop.iter` / `loop.decision` / `loop.max` / `loop.end`、`llm.req` / `llm.resp`、`retry.attempt`、`input.dropped`、`input.consumed` |
| bash | `bash.list` / `bash.kill`、`bash.proc.register` / `clear` / `kill` |
| provider | `mock.turn` / `mock.script.missing` / `mock.script.empty` / `mock.exhausted.*`、`ollama.toolcall.unreliable` |
| 诊断（debug） | `rateLimit.wait`、`conn.closing` |

> 未迁移的 legacy 调用（启动 `src/index.ts`、`web/server.ts`、`agent/sense/index.ts` 加载、`drainBase` tree、`compileToolsReporter` ASCII 表、`loadSkill`）仍以 `log.<level>` 事件出，非用户步骤 trace。

## 解读模块契约（后续实现）

输入：`.chery/logs/YYYY-MM-DD.log`（JSONL，所有会话混合）。

```
1. 读全部事件行，JSON.parse
2. 按 scope.traceId 过滤（= chatId）→ 单会话事件集
3. 按 ts 排序
4. 还原流程：chat.create → chat.send.start(prompt) → llm.req → staged(thinking_end/content_end)
   → sense.trigger → approval.pending → (approval.wait) → sense.approval → sense.result
   → loop.decision(continue) → llm.req → ... → chat.run.done → req.end
5. 关联键 join：
   - senseCallId：sense.trigger ↔ sense.result/rejected ↔ message.created(role:sense)
   - approvalId：approval.pending ↔ sense.approval ↔ approval.timeout
   - messageId：message.created ↔ DB messages 表
   - requestId：req.start ↔ req.end（闭合请求回路）
```

## 依赖与关联 ⭐

### 内部依赖

| 源 | 目标 | 性质 |
|----|------|------|
| [index.ts](../../src/utils/logger/index.ts) | `node:async_hooks` / `node:crypto` / `fs` / `path` / `os` / `dayjs` | runtime |
| [index.ts](../../src/utils/logger/index.ts) / [types.ts](../../src/utils/logger/types.ts) | `@/utils/config.js`（`LoggerConfig` 类型） | 仅类型（无环） |

### 被依赖（全项目几乎所有非纯算法模块）

| 层 | 用法 |
|----|------|
| **core** | `core/middleware`（`MiddlewareContext.log` 字段；`input.dropped` 事件） |
| **agent** | middleware（chat/loop/tool/retry/checkpointState 事件）、provider（mock/ollama 事件）、sense（processRegistry/bash 事件）、prompt |
| **service** | chat（send/handler/observer/streamMapper 事件）、message/router（req 事件 + `HandlerContext.log`）、websocket（conn/req 事件 + ALS 边界）、runtime/bash |
| **utils** | `drain/drainBase`（legacy）、`rateLimiter`（`rateLimit.wait` debug） |
| **入口** | `index.ts`、`web/server`（legacy 启动日志） |

logger 是事实上的全局副作用出口，自身保持零业务依赖（仅类型依赖 config）。

### ALS 边界点

- [websocket/index.ts `handleRequest`](../../src/service/websocket/index.ts)：request scope（`connectionId` + `requestId` + `traceId`）—— **唯一传播边界**。
- [websocket/index.ts](../../src/service/websocket/index.ts) `wss.on("connection"/"close"/"error")`：conn scope（临时注入 `connectionId`）。

## 扩展点

### 新增事件类型

直接 `logger.event("<category>.<action>", { ...fields })`。`data` 字段应**截断长内容**（记 `*Len` 而非全量），避免日志膨胀。事件 `type` 命名 `<域>.<动作>`（dot 分层），便于解读模块分类。

### 新增输出目标（loki/elasticsearch 等）

`emit()`（[index.ts](../../src/utils/logger/index.ts)）当前分支 console / file stream。新增：`LoggerConfig.output` 联合类型加值 → `loadLoggerConfig` 解析 → `createLogger` 初始化客户端 → `emit` 加分支 → `close` 释放。

### 调试某会话

```bash
grep '"traceId":"<chatId>"' .chery/logs/YYYY-MM-DD.log | jq .   # 单会话完整事件流
```

或临时 `logger.setConfig({ level: "debug" })` 拉 debug 事件（`rateLimit.wait` 等）。

## 已知局限

- **traceId 仅 chat.\* / sense.approval 等携带 chatId 的方法**：`brain.list` / `sense.list` 等管理 RPC 无 chatId，`traceId` 缺省（这些非会话内步骤）。
- **诊断日志未结构化**：`drainBase` printTree、`compileToolsReporter` ASCII 表仍走 legacy `log.info`（dev 诊断，非用户 trace）；需要时后续转结构化事件。
- **`runId` 预留**：当前 chat.send 下 `requestId` ≈ run，未单独发 runId；多 chain-run 场景需补。
- **location 追踪靠 `Error.stack`**：性能开销，生产可关 `location: false`。
