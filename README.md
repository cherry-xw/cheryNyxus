# cheryClaw

多 LLM Agent 框架，支持 Ollama、OpenAI 等提供商。核心特性：Tool 调用监管、流式响应、两阶段执行。

## 启动指令

| 指令 | 功能 |
|------|------|
| `yarn dev` | 开发模式，热重载，监听 `ws://localhost:8080` |
| `yarn build` | 构建产物到 `dist/` |
| `yarn start` | 运行构建产物 |
| `yarn compile:tools` | 编译 `.chery/tools/` 下的外部工具 |
| `yarn test` | 运行测试 |

## WebSocket 协议

**连接地址：** `ws://localhost:8080`（端口通过 `WS_PORT` 环境变量配置）

**消息模式：** RPC 模式，四种消息类型：

| 类型 | 方向 | 说明 |
|------|------|------|
| Request | C→S | 请求消息 |
| Response | S→C | 响应消息 |
| Chunk | S→C | 流式增量 |
| Notification | S→C | 服务端推送 |

**传输格式：**

| 方向 | 类型 | 格式 |
|------|------|------|
| C→S | Request | JSON 字符串 |
| S→C | Response | JSON 字符串 |
| S→C | Chunk (stream) | 二进制帧：`[0x01][seq:4B][requestIdLen:1B][requestId][data]` |
| S→C | Chunk (其他) / Notification | 二进制帧：`[0x02][JSON]` |

**消息结构：**

```typescript
interface Request {
  id: string;              // UUID，关联 Response
  kind: "request";
  method: string;          // 方法名
  params: unknown;          // 方法参数
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
  toolCall?: ToolCallDelta[];
}

interface StagedChunkData {
  type: "thinking_end" | "content_end" | "tool_trigger";
  thinking?: string;
  content?: string;
}

interface Notification {
  kind: "notification";
  type: "interrupt" | "complete" | "consumed" | "done" | "error";
  requestId: string;
  data: InterruptData | CompleteData | ConsumedData | null | { message: string };
}
```

## 数据格式示例

### 创建 Agent

```text
→ {"id":"1","kind":"request","method":"agent.create","params":{"agent":"ollama"}}
← {"id":"2","kind":"response","requestId":"1","success":true,"data":{"sessionId":"abc","config":{"provider":"ollama","model":"gemma3:1b"}}}
```

### 列出 Agents

```text
→ {"id":"2","kind":"request","method":"agent.list","params":{}}
← {"id":"3","kind":"response","requestId":"2","success":true,"data":{"sessions":[{"sessionId":"abc","config":{"provider":"ollama","model":"gemma3:1b"},"createdAt":1717700000000}]}}
```

### 获取 Session 详情

```text
→ {"id":"3","kind":"request","method":"agent.session","params":{"sessionId":"abc"}}
← {"id":"4","kind":"response","requestId":"3","success":true,"data":{"sessionId":"abc","config":{...},"threads":[...],"pendingInterrupts":[...]}}
```

### 执行 Agent（流式）

```text
→ {"id":"10","kind":"request","method":"agent.execute","params":{"sessionId":"abc","prompt":"你好"}}
← [binary chunk] seq:1, data:{"content":"你"}
← [binary chunk] seq:2, data:{"content":"好"}
← {"kind":"notification","type":"done","requestId":"thread-1","data":null}
← {"kind":"response","requestId":"10","success":true,"data":{"threadId":"thread-1"}}
```

### 工具审批流程（confirm 模式）

```text
← {"kind":"notification","type":"interrupt","requestId":"thread-1","data":{"interruptId":"tc-1","toolName":"execute_command","arguments":"{\"command\":\"ls\"}","supervisionLevel":"confirm"}}
→ {"id":"20","kind":"request","method":"agent.approval_tool","params":{"sessionId":"abc","interruptId":"tc-1","action":"accept"}}
← {"kind":"response","requestId":"20","success":true,"data":{"interruptId":"tc-1","action":"accept"}}
← {"kind":"notification","type":"complete","requestId":"thread-1","data":{"interruptId":"tc-1","toolName":"execute_command","result":"file1.txt\nfile2.txt"}}
```

### 自动执行工具（auto 模式）

```text
← [binary chunk] seq:5, requestId:thread-1, data:{"toolCall":[{"index":0,"id":"tc-1","name":"read_file","arguments":"{\"path\":\"test.ts\"}"}]}
← {"kind":"chunk","type":"staged","requestId":"thread-1","data":{"type":"tool_trigger"}}
← {"kind":"notification","type":"complete","requestId":"thread-1","data":{"interruptId":"tc-1","toolName":"read_file","result":"文件内容..."}}
```

### 错误处理

```text
← {"kind":"response","requestId":"1","success":false,"error":{"code":"METHOD_NOT_FOUND","message":"Method \"xxx\" not found"}}
← {"kind":"notification","type":"error","requestId":"thread-1","data":{"message":"执行出错"}}
```

错误码：`INTERNAL` | `TIMEOUT` | `METHOD_NOT_FOUND` | `SESSION_NOT_FOUND` | `INTERRUPT_NOT_FOUND` | `INVALID_PARAMS`

## 配置文件

| 文件 | 说明 |
|------|------|
| `.env` | 环境变量：`WS_PORT`、`OLLAMA_HOST`、`OPENAI_API_KEY`、`CHERY_DIR`、`CHERY_TRANSPORT` |
| [.chery/config.yaml](.chery/config.yaml) | LLM 客户端配置、Tool 分组、全局配置（thinking/supervision/stream） |
| [.chery/system.md](.chery/system.md) | 系统 prompt 模板 |
| [.chery/skills/](.chery/skills/) | 技能定义目录，每个技能包含 `SKILL.md` |
| [.chery/tools/](.chery/tools/) | 外部自定义工具目录，`.ts` 文件自动编译注入 |

### Tool 监管等级

| 等级 | 行为 |
|------|------|
| `auto` | 自动执行，推送 complete notification |
| `confirm` | 推送 interrupt notification，等待审批 |
| `manual` | 推送 interrupt notification，禁止自动执行 |

优先级：工具定义 > tool_group > global.supervision
