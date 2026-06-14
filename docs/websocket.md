# WebSocket 协议规范

> [← 返回 README](../README.md) ｜ [交互流程示例](interaction.md) ｜ [数据库架构](database.md)

**连接地址：** `ws://localhost:8080`（端口通过 `WS_PORT` 环境变量配置）

**消息模式：** RPC 模式，四种消息类型：

| 类型 | 方向 | 说明 |
|------|------|------|
| Request | C→S | 请求消息 |
| Response | S→C | 响应消息 |
| Chunk | S→C | 流式增量 |
| Notification | S→C | 服务端推送 |

**传输格式**（由 `CHERY_TRANSPORT` 环境变量决定，默认 `binary`）：

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

> `supervisionLevel` 为数字枚举（0/1/2，见 [database.md](database.md)「Sense 监管等级」）。`needsApproval = supervisionLevel > 0`。

### Chunk 类型

| type | data | 说明 |
|------|------|------|
| `stream` | `{thinking?, content?, senseCall?}` | 流式增量（带 seq，二进制帧） |
| `staged` | `{type, role?, thinking?, content?, senseName?, arguments?, messageIds?}` | 阶段完成（JSON 帧） |

`staged.type` 取值：`thinking_end` / `content_end` / `sense_end` / `reverse`。`role`（user/assistant/system/sense）仅 chat.get 返回历史时携带。`reverse`（携 `messageIds`）由 `chat.send` 在自动撤回末尾 pending sense 时发送，标记客户端回滚对应消息。

### 方法列表

| 方法 | 说明 | 流式 |
|------|------|------|
| `brain.list` | 列出所有可用 brain（senseGroups 为全局全量） | 否 |
| `sense.list` | 列出所有可用 sense group（senses 含 `:level` 后缀未解析） | 否 |
| `runtime.set` | 原子设置 chat 的 brain + senseGroups（每轮可换） | 否 |
| `chat.create` | 创建聊天（必带 brain + senseGroups，chatId 可选） | 否 |
| `chat.list` | 列出所有聊天 | 否 |
| `chat.get` | 获取聊天详情（流式载入历史，末条未完成周期时返回 canResume） | 是 |
| `chat.delete` | 删除聊天 | 否 |
| `chat.send` | 发送聊天消息（仅 chatId + prompt；末尾有 pending 时自动撤回并发 staged.reverse） | 是 |
| `chat.resume` | 续接（无 prompt，恢复执行 pending sense 或继续 loop） | 是 |
| `sense.approval` | 感官审批（accept/reject） | 否 |

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
