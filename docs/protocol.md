# WebSocket 协议规范

> [← 返回 README](../README.md) ｜ [交互流程示例](interaction.md) ｜ [数据存储](db.md)

**连接地址：** `ws://localhost:8182`（端口通过 `.chery/config.yaml` 的 `server.port` 配置）

**消息模式：** RPC 模式，四种消息类型：

| 类型 | 方向 | 说明 |
|------|------|------|
| Request | C→S | 请求消息 |
| Response | S→C | 响应消息 |
| Chunk | S→C | 流式增量 |
| Notification | S→C | 服务端推送 |

**传输格式**（由 `.chery/config.yaml` 的 `server.transport` 配置，默认 `binary`）：

| 模式 | stream chunk（带 seq） | staged chunk / notification |
|------|------------------------|------------------------------|
| `binary` | 二进制帧 `0x01` | JSON 帧 `0x02` |
| `json` | JSON 字符串 | JSON 字符串 |

二进制帧（stream chunk）格式：

```
[0x01][seq:4 bytes BE][requestId_len:1 byte][requestId:n bytes][payload_json]
```

JSON 帧格式：

```
[0x02][full_json]
```

**消息结构：**

```typescript
interface Request {
  id: string;              // UUID，关联 Response
  kind: "request";
  method: string;          // 方法名
  params: unknown;         // 方法参数
}

interface Response {
  id: string;
  kind: "response";
  requestId: string;       // 对应 Request.id
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}

interface Chunk {
  kind: "chunk";
  type: "stream" | "staged";
  requestId: string;
  seq?: number;            // stream 类型序号
  data: StreamChunkData | StagedChunkData;
}

interface StreamChunkData {
  thinking?: string;       // thinking 增量
  content?: string;        // content 增量
  senseCall?: SenseCallDelta[];
}

interface StagedChunkData {
  type: "thinking_end" | "content_end" | "sense_end" | "reverse";
  role?: "user" | "assistant" | "system" | "sense";  // 消息角色，chat.get 历史返回时使用
  thinking?: string;
  content?: string;
  senseName?: string;
  arguments?: string;
  messageIds?: string[];           // reverse 类型：被撤回的消息 id 列表
}

interface Notification {
  kind: "notification";
  type: "interrupt" | "accept" | "rejected" | "consumed" | "loaded" | "done" | "error";
  requestId: string;
  data: InterruptData | AcceptData | RejectedData | ConsumedData | null | { message: string };
}
```

### Notification 类型

| type | data | 触发时机 |
|------|------|----------|
| `consumed` | `{count}` | 用户输入入队 |
| `interrupt` | `{approvalId, senseName, arguments, supervisionLevel, needsApproval}` | sense_end |
| `accept` | `{approvalId, senseName, result}` | sense 执行成功 |
| `rejected` | `{approvalId, senseName, reason}` | sense 被拒 / 审批取消 |
| `loaded` | `null` | chat.get 历史发完 |
| `done` | `null` | chat.send/resume loop 结束 |
| `error` | `{message}` | error chunk 或 handler 异常 |

> `supervisionLevel` 为数字枚举（0/1/2，见 [core/sense.md](./core/sense.md)「Sense 监管等级」）。`needsApproval = supervisionLevel > 0`。

### Chunk 类型

| type | data | 说明 |
|------|------|------|
| `stream` | `{thinking?, content?, senseCall?}` | 流式增量（带 seq，二进制帧） |
| `staged` | `{type, role?, thinking?, content?, senseName?, arguments?, messageIds?}` | 阶段完成（JSON 帧） |

`staged.type` 取值：`thinking_end` / `content_end` / `sense_end` / `reverse`。`role`（user/assistant/system/sense）仅 chat.get 返回历史时携带。`reverse`（携 `messageIds`）由 `chat.send` 在自动撤回末尾 pending sense 时发送，标记客户端回滚对应消息。

### 方法列表

| 方法 | 说明 | 流式 |
|------|------|------|
| `brain.list` | 列出所有可用 brain（senseGroups 为全局全量）+ 当前已连 MCP server 名（`mcpServers`） | 否 |
| `sense.list` | 列出所有可用 sense group（senses 含 `:level` 后缀未解析） | 否 |
| `runtime.set` | 原子设置 chat 的 brain + senseGroups + mcpServers（每轮可换） | 否 |
| `chat.create` | 创建聊天（必带 brain + senseGroups，可选 mcpServers，chatId 可选） | 否 |
| `chat.list` | 列出所有聊天 | 否 |
| `chat.get` | 获取聊天详情（流式载入历史，末条未完成周期时返回 canResume） | 是 |
| `chat.delete` | 删除聊天 | 否 |
| `chat.send` | 发送聊天消息（仅 chatId + prompt；末尾有 pending 时自动撤回并发 staged.reverse） | 是 |
| `chat.resume` | 续接（无 prompt，恢复执行 pending sense 或继续 loop） | 是 |
| `sense.approval` | 感官审批（accept/reject） | 否 |
| `mcp.list` | 列出所有 config 声明的 MCP server 及运行期状态 | 否 |
| `mcp.get` | 单个 MCP server 详情（params: `{name}`） | 否 |
| `mcp.connect` | 连接单个 MCP server（已连幂等；params: `{name}`） | 否 |
| `mcp.disconnect` | 断开单个 MCP server（未连幂等；params: `{name}`） | 否 |
| `mcp.reload` | 重载 MCP server（params: `{name?}`，给出→原子重载单个，省略→全量重读 config） | 否 |

### MCP 管理 API

MCP 分**连接层**与**挂载层**，二者解耦：

- **连接层**（global registry）：哪些 MCP server 连着、其 sense 已注册进全局 senseRegistry。经 `mcp.*` RPC 热重载，**不重启服务**。
- **挂载层**（per-chat schema）：chat 启用哪些**已连** server → 其全部 `mcp__<server>__*` tools 合并进该 chat 的 LLM schema。经 `chat.create` / `runtime.set` 的 `mcpServers` 字段设置，**不走 sense_groups**。

> **关键边界：连接 ≠ 对 chat 可见。** `mcp.connect` 只把 server 接入 registry；chat 必须经 `mcpServers` 显式启用，其 tools 才进 schema。反之 `mcp.disconnect` 后，已启用该 server 的 chat 下次 resolve 时会 fail loud（NOT_FOUND）。

#### 连接层（mcp.\*）

| 方法 | params | 返回 | 语义 |
|------|--------|------|------|
| `mcp.list` | `{}` | `{servers: McpServerInfo[]}` | 列出 config 所有 server + 状态（connected/disconnected/failed） |
| `mcp.get` | `{name}` | `{server: McpServerInfo}` | 单个详情；config 无名 → `NOT_FOUND` |
| `mcp.connect` | `{name}` | `{server: McpServerInfo}` | 已连幂等；config 无名 → `NOT_FOUND` |
| `mcp.disconnect` | `{name}` | `{server: McpServerInfo}` | 未连幂等；反注册其 sense + close client |
| `mcp.reload` | `{name?}` | `{servers, connected, failed, totalSenses}` | 给出 name → 原子重载单个；省略 → 重读 config 全量重载 |

`McpServerInfo`：

```typescript
{
  name: string;
  status: "connected" | "disconnected" | "failed";
  transport: "stdio" | "streamable-http";
  supervision?: number;      // server 级默认监管（0/1/2）
  senseNames: string[];      // 该 server 注册的 sense 名（仅 connected 非空）
  error?: string;            // status==="failed" 时的原因
}
```

**原子 reload**：单个 server 重载按「建新连接 → 同步 register 新 + unregister 旧差集 → close 旧」交换，注册表任意时刻对同名 sense 有效，无缺失窗口；建新失败则旧态保留。全量 reload 逐 server 容忍，单个失败计入 `failed` 不中断其他。

**幂等**：`connect` 对已连 server 为 no-op；`disconnect` 对未连 server 为 no-op（config 有名即成功，无名 `NOT_FOUND`）。reload 期间在途 `callTool` 接受降级（executor try/catch → 错误 content），同 SIGINT。

#### 挂载层（mcpServers）

`chat.create` / `runtime.set` 携带 `mcpServers: string[]`（enabled server 名，与 `senseGroups` 同层级、同原子性）：

```jsonc
// chat.create
{ "brain": "main", "senseGroups": ["default"], "mcpServers": ["filesystem"] }
// runtime.set
{ "chatId": "...", "brain": "main", "senseGroups": ["default"], "mcpServers": ["filesystem", "remote"] }
```

- enabled server 的**全部** `mcp__<server>__*` sense 合并进 LLM schema，监管用 sense 自带的 server 级 `supervision`（无 `:level` 覆盖，因绕过 sense_groups）。
- `mcpServers` 缺省 `[]`（关闭所有 MCP）；响应回显生效值（`brain.list` 的 `mcpServers` 返回当前已连 server 供前端渲染开关）。
- 持久化于 `metadata.runtime`，服务重启 `ensureChat` 自动恢复；旧 chat（无此字段）视为 `[]`，行为不变。
- enable 一个未连 server → `chat.create`/`runtime.set` 抛 `MCP server "X" not connected`（fail loud，NOT_FOUND 语义）。

详见 [core/mcp.md](./core/mcp.md)。

### HTTP API

Web 静态服务（端口通过 `.chery/config.yaml` 的 `server.web_port` 配置，默认 `8183`；实现见 [service/http.md](./service/http.md)）除托管前端文件外，提供以下 HTTP 端点：

#### `GET /api/config`

返回可公开的服务配置，供前端自动构建 WebSocket 连接地址。

**响应示例：**

```json
{
  "wsPort": 8182,
  "webPort": 8183,
  "transport": "binary"
}
```

| 字段 | 类型 | 说明 |
|------|------|------|
| `wsPort` | number | WebSocket 服务端口 |
| `webPort` | number | Web 静态服务端口 |
| `transport` | string | 传输格式：`binary` / `json` |

> 前端通过 `fetch('/api/config')` 获取配置，结合 `window.location.hostname` 自动构建 `ws://` 连接地址，无需硬编码端口。

### 错误处理

错误响应结构：

```json
{"id":"...","kind":"response","requestId":"...","success":false,"error":{"code":"INTERNAL","message":"..."}}
```

错误码：

| code | 触发场景 |
|------|----------|
| `INTERNAL` | handler 异常 / 跨连接并发同 chat（Chat busy） |
| `TIMEOUT` | 审批超时（15min） |
| `METHOD_NOT_FOUND` | 方法未注册 |
| `NOT_FOUND` | chat 不存在 |
| `INVALID_PARAMS` | 参数缺失 |
