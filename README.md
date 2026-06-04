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

基于 RPC 模式，消息分为三种类型：`Request`（C→S）、`Response`（S→C）、`Event`（S→C 推送），以及专用的 `Tool`（S→C 工具事件 + C→S 审批回复）。

### 传输格式

| 方向 | 消息类型 | 传输格式 |
| ---- | -------- | -------- |
| C→S | Request | JSON 字符串 |
| S→C | Response | JSON 字符串 |
| S→C | Event（stream） | 二进制帧：`[0x01][seq:4B][requestIdLen:1B][requestId][delta]` |
| S→C | Event（其他） / Tool | 二进制帧：`[0x02][JSON]` |

### 消息结构

#### Request（C→S）

```typescript
interface RpcRequest {
  id: string;          // UUID，用于关联 Response
  timestamp: number;
  kind: "request";
  method: string;      // 方法名，见下方方法列表
  params: unknown;     // 方法参数
  timeout?: number;    // 超时时间（毫秒）
}

// 示例
{
  "id": "a1b2c3d4-5678-90ab-cdef-1234567890ab",
  "timestamp": 1780406172214,
  "kind": "request",
  "method": "agent.create",
  "params": { "provider": "ollama" },
  "timeout": 30000
}
```

#### Response（S→C）

```typescript
interface RpcResponse {
  id: string;
  timestamp: number;
  kind: "response";
  requestId: string;   // 对应 Request 的 id
  success: boolean;
  result?: unknown;
  error?: { code: string; message: string; retryable: boolean };
}

// 示例 - 成功
{
  "id": "e5f6a7b8-1234-5678-9abc-def012345678",
  "timestamp": 1780406172215,
  "kind": "response",
  "requestId": "a1b2c3d4-5678-90ab-cdef-1234567890ab",
  "success": true,
  "result": { "sessionId": "abc-123", "config": { "provider": "ollama", "model": "gemma3:1b" } }
}
```

#### Event（S→C 推送）

流式执行时，服务端持续推送事件：

```typescript
interface RpcEvent {
  id: string;
  timestamp: number;
  kind: "event";
  event: string;       // 事件类型：stream | interrupt | staged | done | error
  requestId?: string;
  seq?: number;        // stream 事件的序号
  data: unknown;
}

// 示例 - stream 事件（二进制帧传输，此处展示解码后的结构）
{
  "id": "c3d4e5f6-7890-abcd-ef01-234567890abc",
  "timestamp": 1780406172216,
  "kind": "event",
  "event": "stream",
  "requestId": "3",
  "seq": 1,
  "data": { "delta": "你" }
}

// 示例 - staged 事件
{
  "id": "d4e5f6a7-8901-bcde-f012-345678901234",
  "timestamp": 1780406172217,
  "kind": "event",
  "event": "staged",
  "requestId": "3",
  "data": { "type": "thinking_end", "thinking": "思考内容..." }
}

// 示例 - done 事件
{
  "id": "e5f6a7b8-9012-cdef-0123-456789012345",
  "timestamp": 1780406172218,
  "kind": "event",
  "event": "done",
  "data": {}
}
```

#### Tool（S→C 工具事件）

工具执行过程中，服务端推送 Tool 事件，包含三个阶段：`trigger`（触发）、`interrupt`（中断待审批）、`complete`（完成）。

```typescript
interface RpcTool {
  id: string;
  timestamp: number;
  kind: "tool";
  requestId: string;
  state: "trigger" | "interrupt" | "complete";
  data: {
    handleId: string;                                  // 工具调用唯一标识
    toolName: string;                                  // 工具名称
    arguments: string;                                 // 工具参数（JSON）
    interruptId?: string;                              // 中断 ID（interrupt 状态时存在）
    action?: "auto" | "accept" | "reject";             // 决策类型
    result?: string;                                   // 执行结果（complete 时）
    reason?: string;                                   // 拒绝原因
  };
}
```

**示例 - 自动执行工具（auto）：**

```text
// 1. trigger：工具开始执行
← { "kind": "tool", "requestId": "3", "state": "trigger",
    "data": { "handleId": "tc-1", "toolName": "read_file", "arguments": "{\"path\":\"/tmp/data\"}", "action": "auto" } }

// 2. complete：执行完成
← { "kind": "tool", "requestId": "3", "state": "complete",
    "data": { "handleId": "tc-1", "toolName": "read_file", "arguments": "{\"path\":\"/tmp/data\"}", "action": "auto", "result": "文件内容..." } }
```

**示例 - 需确认工具（confirm）完整流程：**

```text
// 1. interrupt：工具需要审批
← { "kind": "tool", "requestId": "3", "state": "interrupt",
    "data": { "handleId": "int1-tc-2", "toolName": "execute_command", "arguments": "{\"command\":\"rm -rf /tmp/test\"}", "interruptId": "int1" } }

// 2. 客户端通过 agent.approval_tool 方法回复审批结果
→ { "id": "20", "kind": "request", "method": "agent.approval_tool",
    "params": { "sessionId": "abc-123", "handleId": "int1-tc-2", "action": "accept" } }
← { "kind": "response", "requestId": "20", "success": true, "result": { "handleId": "int1-tc-2", "action": "accept" } }

// 3. complete：执行完成（action 为 accept）
← { "kind": "tool", "requestId": "3", "state": "complete",
    "data": { "handleId": "int1-tc-2", "toolName": "execute_command", "arguments": "{\"command\":\"rm -rf /tmp/test\"}", "action": "accept", "result": "删除成功" } }
```

**示例 - 拒绝执行：**

```text
// 客户端拒绝
→ { "id": "21", "kind": "request", "method": "agent.approval_tool",
    "params": { "sessionId": "abc-123", "handleId": "int1-tc-2", "action": "reject", "reason": "不允许执行该命令" } }

// complete：action 为 reject
← { "kind": "tool", "requestId": "3", "state": "complete",
    "data": { "handleId": "int1-tc-2", "toolName": "execute_command", "arguments": "{\"command\":\"rm -rf /tmp/test\"}", "action": "reject", "result": "用户拒绝执行，原因是不允许执行该命令" } }
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

// response.result:
{ sessionId: string; config: { provider: string; model: string; tool_group?: string | string[] } }

// 示例
→ { "id": "1", "timestamp": 1780406172214, "kind": "request", "method": "agent.create", "params": { "agent": "ali_glm5" } }
← { "id": "2", "timestamp": 1780406172215, "kind": "response", "requestId": "1", "success": true, "result": { "sessionId": "abc-123", "config": { "provider": "openai", "model": "glm-5", "tool_group": "safe_tools" } } }
```

#### 删除 Agent

```typescript
// method: "agent.delete"
// params:
{ sessionId: string }

// 示例
→ { "id": "5", "timestamp": 1780406172300, "kind": "request", "method": "agent.delete", "params": { "sessionId": "abc-123" } }
← { "id": "6", "timestamp": 1780406172301, "kind": "response", "requestId": "5", "success": true, "result": { "sessionId": "abc-123" } }
```

#### 列出 Agents

返回所有历史会话（从数据库读取，重启后仍可恢复）。

```typescript
// method: "agent.list"
// params: {}

// response.result:
{
  sessions: Array<{
    sessionId: string;
    config: { provider: string; model: string; tool_group?: string | string[] };
    createdAt: number;    // 创建时间戳
  }>;
}

// 示例
→ { "id": "7", "timestamp": 1780406172302, "kind": "request", "method": "agent.list", "params": {} }
← { "id": "8", "timestamp": 1780406172303, "kind": "response", "requestId": "7", "success": true,
   "result": { "sessions": [{ "sessionId": "abc-123", "config": { "provider": "ollama", "model": "gemma3:1b" }, "createdAt": 1780406172215 }] } }
```

#### 获取 Session 详情

获取指定会话的历史线程和待处理中断。

```typescript
// method: "agent.session"
// params:
{ sessionId: string }

// response.result:
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
      type: "thinking_only" | "normal" | "tool_response";  // 消息类型
      toolCallId?: string;  // tool 角色消息关联的 tool call id
    }>;
  }>;
  pendingInterrupts: Array<{
    interruptId: string;
    threadId: string;
    createdAt: number;
    toolCalls: Array<{ tid: string; name: string; arguments: string }>;
  }>;
}

// 消息类型说明：
// - thinking_only: assistant 消息仅含 thinking，无 content（历史可见，消息窗口不显示）
// - normal: 正常 assistant/user 消息
// - tool_response: tool 角色回复，携带 toolCallId 关联原始 tool call

// 示例
→ { "id": "9", "timestamp": 1780406172304, "kind": "request", "method": "agent.session",
   "params": { "sessionId": "abc-123" } }
← { "id": "10", "timestamp": 1780406172305, "kind": "response", "requestId": "9", "success": true,
   "result": {
     "sessionId": "abc-123",
     "config": { "provider": "ollama", "model": "gemma3:1b" },
     "createdAt": 1780406172215,
     "threads": [{ "threadId": "thread-1", "messageCount": 5, "messages": [
       { "id": "msg-1", "role": "user", "content": "hello", "type": "normal", "createdAt": 1000 },
       { "id": "msg-2", "role": "assistant", "thinking": "...", "type": "thinking_only", "createdAt": 1001 },
       { "id": "msg-3", "role": "assistant", "content": "hi", "type": "normal", "createdAt": 1002 },
       { "id": "tc-1", "role": "tool", "content": "result", "type": "tool_response", "toolCallId": "tc-1", "createdAt": 1003 }
     ] }],
     "pendingInterrupts": []
   } }
```

#### 恢复 Session

重启服务后，可通过两种方式恢复历史会话：

**方式1：直接执行（自动恢复）**

```typescript
// agent.execute 会自动从数据库恢复 session
→ { "id": "10", "kind": "request", "method": "agent.execute",
   "params": { "sessionId": "abc-123", "prompt": "继续对话" } }
← [正常流式响应]
```

**方式2：显式恢复**

```typescript
// 传入已有 sessionId 创建，返回 recovered: true
→ { "id": "1", "kind": "request", "method": "agent.create",
   "params": { "agent": "ali_glm5", "sessionId": "abc-123" } }
← { "kind": "response", "requestId": "1", "success": true,
   "result": { "sessionId": "abc-123", "config": {...}, "createdAt": 1780406172215, "recovered": true } }
```

**恢复中断审批**

如果会话有待处理的工具中断，可通过 `agent.session` 获取详情后继续审批：

```text
# 1. 获取 session 详情，发现 pendingInterrupts
→ { "method": "agent.session", "params": { "sessionId": "abc-123" } }
← { "pendingInterrupts": [{ "interruptId": "int1", "toolCalls": [{ "name": "execute_command", ... }] }] }

# 2. 用户选择继续审批，发送 approval_tool
→ { "method": "agent.approval_tool", "params": { "sessionId": "abc-123", "handleId": "int1-tc-1", "action": "accept" } }
← { "success": true }
```

#### 执行 Agent（流式）

```typescript
// method: "agent.execute"（streaming，服务端推送 Event 序列）
// params:
{
  sessionId: string;
  threadId?: string;    // 可选，复用已有线程
  prompt: string;       // 用户消息
}

// 服务端依次推送 Event / Tool：
// 1. stream × N   → { thinkingDelta / contentDelta }
// 2. tool?        → trigger(interrupt) / trigger(auto) / complete
// 3. staged?       → 阶段性结果
// 4. done          → {}
// 5. error?        → { error: "错误信息" }

// 示例 - 普通对话
→ { "id": "10", "timestamp": 1780406172216, "kind": "request", "method": "agent.execute", "params": { "sessionId": "abc-123", "prompt": "你好" } }
← [binary stream event] seq: 1, delta: "你"
← [binary stream event] seq: 2, delta: "好"
← { "id": "...", "kind": "event", "event": "done", "data": {} }
← { "id": "...", "kind": "response", "requestId": "10", "success": true, "result": { "threadId": "thread-1" } }

// 示例 - 复用已有线程（多轮对话）
→ { "id": "11", "timestamp": 1780406172400, "kind": "request", "method": "agent.execute", "params": { "sessionId": "abc-123", "threadId": "thread-1", "prompt": "继续刚才的话题" } }
← [binary stream event] seq: 1, delta: "好的"
← { "id": "...", "kind": "event", "event": "done", "data": {} }
← { "id": "...", "kind": "response", "requestId": "11", "success": true, "result": { "threadId": "thread-1" } }
```

#### 审批工具执行

需确认工具触发 `interrupt` 后，通过 `agent.approval_tool` 方法回复：

**审批超时机制**：interrupt 发出后启动计时（默认 5 分钟），超时后释放资源并通知前端会话结束。

```typescript
// method: "agent.approval_tool"
// params:
{
  sessionId: string;
  handleId: string;
  action: "accept" | "reject";
  reason?: string;
}

// 示例 - 确认
→ { "id": "20", "kind": "request", "method": "agent.approval_tool", "params": { "sessionId": "abc-123", "handleId": "int1-tc-1", "action": "accept" } }
← { "kind": "response", "requestId": "20", "success": true, "result": { "handleId": "int1-tc-1", "action": "accept" } }

// 示例 - 拒绝
→ { "id": "21", "kind": "request", "method": "agent.approval_tool", "params": { "sessionId": "abc-123", "handleId": "int1-tc-1", "action": "reject", "reason": "不允许执行" } }
```

### 完整示例

```text
# 1. 创建 Agent
→ { "id": "1", "timestamp": 1780406172214, "kind": "request", "method": "agent.create", "params": { "agent": "ali_glm5" } }
← { "id": "2", "timestamp": 1780406172215, "kind": "response", "requestId": "1", "success": true, "result": { "sessionId": "abc-123", "config": { "provider": "openai", "model": "glm-5", "tool_group": "safe_tools" } } }

# 2. 执行（流式）
→ { "id": "3", "timestamp": 1780406172216, "kind": "request", "method": "agent.execute", "params": { "sessionId": "abc-123", "prompt": "你好" } }
← [binary stream event] delta: "你"
← [binary stream event] delta: "好"
← { "kind": "event", "event": "done", "data": {} }
← { "kind": "response", "requestId": "3", "success": true, "result": { "threadId": "thread-1" } }

# 3. 工具执行（含中断确认）
→ { "id": "10", "kind": "request", "method": "agent.execute", "params": { "sessionId": "abc-123", "prompt": "列出目录内容" } }
← [stream] delta: "我来执行..."
← { "kind": "tool", "state": "trigger", "data": { "handleId": "tc-auto", "toolName": "read_file", "arguments": "...", "action": "auto" } }
← { "kind": "tool", "state": "complete", "data": { "handleId": "tc-auto", "toolName": "read_file", "action": "auto", "result": "文件内容..." } }
← { "kind": "tool", "state": "interrupt", "data": { "handleId": "int1-tc-2", "toolName": "execute_command", "arguments": "{\"command\":\"ls -la\"}", "interruptId": "int1" } }
→ { "id": "20", "kind": "request", "method": "agent.approval_tool", "params": { "sessionId": "abc-123", "handleId": "int1-tc-2", "action": "accept" } }
← { "kind": "response", "requestId": "20", "success": true, "result": { "handleId": "int1-tc-2", "action": "accept" } }
← { "kind": "tool", "state": "complete", "data": { "handleId": "int1-tc-2", "toolName": "execute_command", "action": "accept", "result": "drwxr-xr-x ..." } }
← { "kind": "event", "event": "done", "data": {} }
← { "kind": "response", "requestId": "10", "success": true, "result": { "threadId": "thread-2" } }
```

### 错误处理

```typescript
// Response 错误示例
{
  "id": "...",
  "timestamp": 1780406172214,
  "kind": "response",
  "requestId": "1",
  "success": false,
  "error": {
    "code": "METHOD_NOT_FOUND",   // 错误码
    "message": "Method \"xxx\" not found",
    "retryable": false
  }
}
```

错误码：`INTERNAL` | `TIMEOUT` | `METHOD_NOT_FOUND` | `SESSION_NOT_FOUND` | `INTERRUPT_NOT_FOUND` | `HANDLE_NOT_FOUND` | `INVALID_PARAMS` | `CONFIG_MISMATCH`

## 配置

### 环境变量（.env）

```env
WS_PORT=8080                     # WebSocket 端口
OLLAMA_HOST=http://localhost:11434
OPENAI_API_KEY=sk-xxx
CHERY_DIR=/path/to/project       # .chery 目录路径
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
| `auto` | 自动执行，推送 `trigger` + `complete` Tool 事件 |
| `confirm` | 推送 `interrupt` Tool 事件，等待 `agent.approval_tool` 审批 |
| `manual` | 推送 `interrupt` Tool 事件，禁止自动执行 |

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