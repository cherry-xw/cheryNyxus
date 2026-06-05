# cheryClaw

多 LLM Agent 框架，支持 Ollama、OpenAI 等提供商。核心特性：Tool 调用监管、流式响应、两阶段执行。

## 快速开始

```bash
yarn install
cp .env.example .env  # 配置 API 密钥
yarn dev              # 开发模式，监听 ws://localhost:8080
```

## WebSocket 协议

连接地址：`ws://localhost:8080`（端口可通过 `WS_PORT` 环境变量修改）

基于 RPC 模式，消息分为四种类型：

- **Request**（C→S）：请求消息
- **Response**（S→C）：响应消息（请求返回）
- **Chunk**（S→C）：流式增量（高频传输，结构简洁）
- **Notification**（S→C）：服务端推送（异步通知）

### 传输格式

| 方向 | 消息类型 | 传输格式 |
| ---- | -------- | -------- |
| C→S | Request | JSON 字符串 |
| S→C | Response | JSON 字符串 |
| S→C | Chunk（stream） | 二进制帧：`[0x01][seq:4B][requestIdLen:1B][requestId][data]` |
| S→C | Chunk（其他） / Notification | 二进制帧：`[0x02][JSON]` |

### 消息结构

#### Request（C→S）

```typescript
interface Request {
  id: string;          // UUID，用于关联 Response
  kind: "request";
  method: string;      // 方法名，见下方方法列表
  params: unknown;     // 方法参数
}
```

示例：

```json
{
  "id": "a1b2c3d4-5678-90ab-cdef-1234567890ab",
  "kind": "request",
  "method": "agent.create",
  "params": { "agent": "ollama" }
}
```

#### Response（S→C）

```typescript
interface Response {
  id: string;
  kind: "response";
  requestId: string;   // 对应 Request 的 id
  success: boolean;
  data?: unknown;
  error?: { code: string; message: string };
}
```

示例：

```json
{
  "id": "e5f6a7b8-1234-5678-9abc-def012345678",
  "kind": "response",
  "requestId": "a1b2c3d4-5678-90ab-cdef-1234567890ab",
  "success": true,
  "data": { "sessionId": "abc-123", "config": { "provider": "ollama", "model": "gemma3:1b" } }
}
```

#### Chunk（S→C，流式增量）

```typescript
interface Chunk {
  kind: "chunk";
  type: "stream" | "staged";
  requestId: string;
  seq?: number;        // stream 事件的序号
  data: ChunkData;
}

// Stream Chunk Data
interface StreamChunkData {
  thinking?: string;       // thinking 增量
  content?: string;        // content 增量
  toolCall?: ToolCallDelta[];  // tool 调用参数增量
}

interface ToolCallDelta {
  index?: number;          // 工具调用索引
  id?: string;             // tool_call.id
  name?: string;           // 工具名称
  arguments?: string;      // 参数 JSON 片段
}

// Staged Chunk Data
interface StagedChunkData {
  type: "thinking_end" | "content_end" | "tool_trigger";
  thinking?: string;
  content?: string;
}
```

示例 - stream chunk：

```json
{
  "kind": "chunk",
  "type": "stream",
  "requestId": "thread-1",
  "seq": 1,
  "data": { "content": "你" }
}
```

示例 - staged chunk：

```json
{
  "kind": "chunk",
  "type": "staged",
  "requestId": "thread-1",
  "data": { "type": "thinking_end", "thinking": "思考内容..." }
}
```

#### Notification（S→C，服务端推送）

```typescript
interface Notification {
  kind: "notification";
  type: NotificationType;
  requestId: string;
  data: NotificationData;
}

type NotificationType =
  | "interrupt"    // 工具中断（待审批）
  | "complete"     // 工具执行结果
  | "consumed"     // 消息已消费
  | "done"         // 执行完成
  | "error";       // 错误

// Interrupt Notification Data
interface InterruptNotificationData {
  interruptId: string;     // 工具调用唯一标识（= tool_call.id）
  toolName: string;
  arguments: string;
  supervisionLevel: string;
}

// Complete Notification Data
interface CompleteNotificationData {
  interruptId: string;
  toolName: string;
  result: string;
}

// Consumed Notification Data
interface ConsumedNotificationData {
  count: number;           // 消费的消息数量
}
```

示例 - interrupt notification：

```json
{
  "kind": "notification",
  "type": "interrupt",
  "requestId": "thread-1",
  "data": {
    "interruptId": "tc-123",
    "toolName": "execute_command",
    "arguments": "{\"command\":\"ls -la\"}",
    "supervisionLevel": "confirm"
  }
}
```

示例 - complete notification：

```json
{
  "kind": "notification",
  "type": "complete",
  "requestId": "thread-1",
  "data": {
    "interruptId": "tc-123",
    "toolName": "execute_command",
    "result": "drwxr-xr-x ..."
  }
}
```

### 方法列表

#### 创建 Agent

使用 `.chery/config.yaml` 中 `llm.agent` 下配置的 agent 名称创建会话。

```typescript
// method: "agent.create"
// params:
{
  agent: string;         // config.yaml 中 llm.agent 下的配置名称
  sessionId?: string;    // 可选，自定义会话 ID
}

// response.data:
{ sessionId: string; config: { provider: string; model: string; tool_group?: string | string[] } }
```

示例：

```text
→ { "id": "1", "kind": "request", "method": "agent.create", "params": { "agent": "ali_glm5" } }
← { "id": "2", "kind": "response", "requestId": "1", "success": true,
   "data": { "sessionId": "abc-123", "config": { "provider": "openai", "model": "glm-5" } } }
```

#### 删除 Agent

```typescript
// method: "agent.delete"
// params:
{ sessionId: string }
```

#### 列出 Agents

返回所有历史会话（从数据库读取，重启后仍可恢复）。

```typescript
// method: "agent.list"
// params: {}

// response.data:
{
  sessions: Array<{
    sessionId: string;
    config: { provider: string; model: string; tool_group?: string | string[] };
    createdAt: number;
  }>;
}
```

#### 获取 Session 详情

获取指定会话的历史线程和待处理中断。

```typescript
// method: "agent.session"
// params:
{ sessionId: string }

// response.data:
{
  sessionId: string;
  config: { provider: string; model: string; tool_group?: string | string[] };
  createdAt: number;
  threads: Array<{
    threadId: string;
    createdAt: number;
    updatedAt: number;
    messageCount: number;
    messages: Array<{
      id: string;
      role: string;
      content?: string;
      thinking?: string;
      toolCalls?: unknown;
      createdAt: number;
      type: "thinking_only" | "normal" | "tool_response";
      toolCallId?: string;
    }>;
  }>;
  pendingInterrupts: Array<{
    interruptId: string;
    threadId: string;
    createdAt: number;
    toolCalls: Array<{ id: string; name: string; arguments: string }>;
  }>;
}
```

#### 执行 Agent（流式）

```typescript
// method: "agent.execute"（streaming）
// params:
{
  sessionId: string;
  threadId?: string;    // 可选，复用已有线程
  prompt: string;       // 用户消息
}

// 服务端依次推送 Chunk / Notification：
// 1. stream × N   → { thinking / content / toolCall }
// 2. staged?       → { type: "thinking_end" / "content_end" / "tool_trigger" }
// 3. interrupt?    → 工具待审批
// 4. complete?     → 工具执行结果
// 5. consumed?     → 消息已消费
// 6. done          → null
// 7. error?        → { message }
```

示例：

```text
→ { "id": "10", "kind": "request", "method": "agent.execute",
   "params": { "sessionId": "abc-123", "prompt": "你好" } }
← [binary stream chunk] seq: 1, data: { content: "你" }
← [binary stream chunk] seq: 2, data: { content: "好" }
← { "kind": "notification", "type": "done", "requestId": "thread-1", "data": null }
← { "kind": "response", "requestId": "10", "success": true,
   "data": { "threadId": "thread-1" } }
```

#### 审批工具执行

需确认工具触发 `interrupt` notification 后，通过 `agent.approval_tool` 方法回复：

**审批超时机制**：interrupt 发出后启动计时（默认 5 分钟），超时后释放资源并通知前端会话结束。

```typescript
// method: "agent.approval_tool"
// params:
{
  sessionId: string;
  interruptId: string;      // 工具调用唯一标识
  action: "accept" | "reject";
  reason?: string;          // 拒绝原因
}
```

示例：

```text
// 确认执行
→ { "id": "20", "kind": "request", "method": "agent.approval_tool",
   "params": { "sessionId": "abc-123", "interruptId": "tc-123", "action": "accept" } }
← { "kind": "response", "requestId": "20", "success": true,
   "data": { "interruptId": "tc-123", "action": "accept" } }

// 拒绝执行
→ { "id": "21", "kind": "request", "method": "agent.approval_tool",
   "params": { "sessionId": "abc-123", "interruptId": "tc-123", "action": "reject", "reason": "不允许执行" } }
← { "kind": "response", "requestId": "21", "success": true,
   "data": { "interruptId": "tc-123", "action": "reject" } }
```

### 工具执行完整流程

**自动执行工具（auto）**：

```text
// 1. 流式响应中包含 toolCall 增量
← { "kind": "chunk", "type": "stream", "seq": 5,
   "data": { "toolCall": [{ "index": 0, "id": "tc-1", "name": "read_file" }] } }

// 2. staged 标记 tool_trigger
← { "kind": "chunk", "type": "staged", "data": { "type": "tool_trigger" } }

// 3. complete notification（自动执行完成）
← { "kind": "notification", "type": "complete",
   "data": { "interruptId": "tc-1", "toolName": "read_file", "result": "文件内容..." } }
```

**需确认工具（confirm）**：

```text
// 1. interrupt notification（待审批）
← { "kind": "notification", "type": "interrupt",
   "data": { "interruptId": "tc-2", "toolName": "execute_command",
             "arguments": "{\"command\":\"rm -rf /tmp/test\"}",
             "supervisionLevel": "confirm" } }

// 2. 客户端审批
→ { "kind": "request", "method": "agent.approval_tool",
   "params": { "sessionId": "abc-123", "interruptId": "tc-2", "action": "accept" } }
← { "kind": "response", "success": true,
   "data": { "interruptId": "tc-2", "action": "accept" } }

// 3. complete notification（执行完成）
← { "kind": "notification", "type": "complete",
   "data": { "interruptId": "tc-2", "toolName": "execute_command", "result": "删除成功" } }
```

### 消息消费通知

当用户输入被消费进入消息循环时，推送 `consumed` notification：

```text
← { "kind": "notification", "type": "consumed",
   "data": { "count": 2 } }
```

### 错误处理

```typescript
// Response 错误示例
{
  "kind": "response",
  "requestId": "1",
  "success": false,
  "error": {
    "code": "METHOD_NOT_FOUND",
    "message": "Method \"xxx\" not found"
  }
}

// Notification 错误示例
{
  "kind": "notification",
  "type": "error",
  "requestId": "thread-1",
  "data": { "message": "执行出错" }
}
```

错误码：`INTERNAL` | `TIMEOUT` | `METHOD_NOT_FOUND` | `SESSION_NOT_FOUND` | `INTERRUPT_NOT_FOUND` | `INVALID_PARAMS`

## 配置

### 环境变量（.env）

```env
WS_PORT=8080                     # WebSocket 端口
OLLAMA_HOST=http://localhost:11434
OPENAI_API_KEY=sk-xxx
CHERY_DIR=/path/to/project       # .chery 目录路径
CHERY_TRANSPORT=binary           # 传输格式：binary | json
```

### LLM 配置（.chery/config.yaml）

```yaml
llm:
  agent:
    ollama:
      url: $OLLAMA_HOST
      model: gemma3:1b
      provider: ollama
      tool_group: safe_tools

    openai:
      url: https://api.openai.com/v1
      model: gpt-4
      key: $OPENAI_API_KEY
      provider: openai
      thinking: true
      tool_group: [safe_tools, dangerous_tools]
```

### Tool 监管等级

| 等级 | 行为 |
|------|------|
| `auto` | 自动执行，推送 complete notification |
| `confirm` | 推送 interrupt notification，等待 `agent.approval_tool` 审批 |
| `manual` | 推送 interrupt notification，禁止自动执行 |

优先级：工具定义 > tool_group > global.supervision

## 扩展

### 自定义工具

`.chery/tools/<name>.ts`：

```typescript
const Schema = z.object({
  text: z.string().describe("参数描述"),
});

export default tool(
  "tool_name",
  "工具描述",
  Schema,
  async (input) => ({
    content: `结果: ${input.text}`,
    hash: ""
  }),
  SupervisionLevel.confirm
);
```

在 `config.yaml` 的 `tool_groups` 中添加工具名称即可使用。

### 自定义技能

`.chery/skills/<name>/SKILL.md`：

```markdown
---
name: skill_name
description: 技能描述
---

# skill_name

详细说明...
```

## 常用命令

```bash
yarn dev           # 开发模式（热重载）
yarn build         # 构建产物
yarn start         # 运行产物
yarn compile:tools # 编译外部工具
yarn test          # 运行测试
```

## License

ISC