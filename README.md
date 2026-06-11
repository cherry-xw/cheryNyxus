# cheryClaw

多 LLM Brain 框架，支持 Ollama、OpenAI 等提供商。核心特性：Sense 调用监管、流式响应、两阶段执行。

## 隐喻体系

cheryClaw 采用拟人化隐喻设计：

| 概念 | 隐喻 | 说明 |
|------|------|------|
| Brain | 大脑 | AI 服务核心，负责思考决策 |
| Sense | 感官 | 感知操作，神经手脚，与世界交互 |
| Chat | 聊天 | 交互通道，承载消息历史 |

**交互流程：** `chat.create`（携带 brain + senseGroups）→ `chat.send` → 触发感官 → 大脑思考（中途可用 `brain.set` / `sense.set` 更换 Brain/Sense）

> Brain 与 Sense Group 在每轮对话开始时可更换，不与 Chat 锁定。Chat 仅承载消息历史。

## 启动指令

| 指令 | 功能 |
|------|------|
| `yarn dev` | 开发模式，热重载，监听 `ws://localhost:8080` |
| `yarn build` | 构建产物到 `dist/` |
| `yarn start` | 运行构建产物 |
| `yarn compile:senses` | 编译 `.chery/senses/` 下的外部感官 |
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
  type: "thinking_end" | "content_end" | "sense_end";
  role?: "user" | "assistant" | "system" | "sense";  // 消息角色，chat.get历史返回时使用
  thinking?: string;
  content?: string;
  senseName?: string;
  arguments?: string;
}

interface Notification {
  kind: "notification";
  type: "interrupt" | "complete" | "consumed" | "loaded" | "done" | "error";
  requestId: string;
  data: InterruptData | CompleteData | ConsumedData | null | { message: string };
}
```

### 方法列表

| 方法 | 说明 | 流式 |
|------|------|------|
| `brain.list` | 列出所有可用 brain | 否 |
| `brain.set` | 设置 chat 的 brain（每轮可换） | 否 |
| `sense.list` | 列出所有可用 sense group | 否 |
| `sense.set` | 设置 chat 的 sense group（每轮可换） | 否 |
| `chat.create` | 创建聊天（必带 brain + senseGroups，chatId 可选） | 否 |
| `chat.list` | 列出所有聊天 | 否 |
| `chat.get` | 获取聊天详情（载入历史） | 是 |
| `chat.delete` | 删除聊天 | 否 |
| `chat.send` | 发送聊天消息（仅 chatId + prompt） | 是 |
| `chat.resume` | 恢复 pending sense 执行 | 是 |
| `sense.approval` | 感官审批 | 否 |

## 数据格式示例

### 列出 Brain

```text
→ {"id":"1","kind":"request","method":"brain.list","params":{}}
← {"id":"2","kind":"response","requestId":"1","success":true,"data":{"brains":[{"name":"ollama","provider":"ollama","model":"gemma3:1b","senseGroups":"safe_senses"}]}}
```

### 列出 Sense Group

```text
→ {"id":"2","kind":"request","method":"sense.list","params":{}}
← {"id":"3","kind":"response","requestId":"2","success":true,"data":{"senseGroups":[{"name":"safe_senses","supervision":0,"senses":["read_file","skill"]}]}}
```

### 创建聊天

```text
→ {"id":"4","kind":"request","method":"chat.create","params":{"brain":"longcat","senseGroups":["safe_senses"]}}
← {"id":"5","kind":"response","requestId":"4","success":true,"data":{"chatId":"chat-uuid"}}
```

**注意：** `brain` + `senseGroups` 必传——创建时原子注入 runtime 并加载历史。`chatId` 可选（前端自定义），未传则服务端生成。`chat.send` 前必须先 `chat.create`；中途换 brain/sense 用 `brain.set` / `sense.set`。

### 列出聊天

```text
→ {"id":"5","kind":"request","method":"chat.list","params":{}}
← {"id":"6","kind":"response","requestId":"5","success":true,"data":{"chats":[{"chatId":"chat-1","createdAt":1717700000000,"updatedAt":1717700100000,"messageCount":5}]}}
```

### 获取聊天详情（载入历史对话）

```text
→ {"id":"5","kind":"request","method":"chat.get","params":{"chatId":"chat-1"}}
← {"id":"6","kind":"response","requestId":"5","success":true,"data":{"chatId":"chat-1"}}
← [binary chunk] type:staged, data:{"type":"thinking_end","role":"assistant","thinking":"历史思考内容"}
← [binary chunk] type:staged, data:{"type":"content_end","role":"assistant","content":"历史响应内容"}
← [binary chunk] type:staged, data:{"type":"sense_end","role":"assistant","senseName":"...","arguments":"..."}
← {"kind":"notification","type":"loaded","requestId":"chat-1","data":null}
```

### 设置 Brain（每轮可换）

```text
→ {"id":"10","kind":"request","method":"brain.set","params":{"chatId":"chat-uuid","brain":"longcat"}}
← {"id":"11","kind":"response","requestId":"10","success":true,"data":{"chatId":"chat-uuid","brain":"longcat"}}
```

### 设置 Sense Group（每轮可换）

```text
→ {"id":"12","kind":"request","method":"sense.set","params":{"chatId":"chat-uuid","senseGroups":["safe_senses"]}}
← {"id":"13","kind":"response","requestId":"12","success":true,"data":{"chatId":"chat-uuid","senseGroups":["safe_senses"]}}
```

> **Brain/Sense 设置：** 首次配置由 `chat.create` 原子完成（注入 runtime + 加载历史）。`brain.set` / `sense.set` 用于中途更换，各自携带 chatId。Middleware 实例跨轮不重建，messages 历史天然保留。`sense.set` 依赖已设置的 `brain.provider`，须先 `brain.set`。

### 发送聊天消息（流式）

```text
→ {"id":"20","kind":"request","method":"chat.send","params":{"chatId":"chat-uuid","prompt":"你好"}}
← [binary chunk] seq:1, data:{"content":"你"}
← [binary chunk] seq:2, data:{"content":"好"}
← {"kind":"notification","type":"done","requestId":"chat-uuid","data":null}
← {"kind":"response","requestId":"20","success":true,"data":{"chatId":"chat-uuid"}}
```

> **send 仅携带 chatId + prompt：** brain/sense 已由 `chat.create` 配置（或中途 `brain.set` / `sense.set` 更换）。send 前必须已完成 runtime 配置，否则服务端返回 runtime 未配置错误。

### 感官审批流程（confirm 模式）

```text
← {"kind":"notification","type":"interrupt","requestId":"chat-1","data":{"approvalId":"sc-1","senseName":"execute_command","arguments":"{\"command\":\"ls\"}","supervisionLevel":"confirm","needsApproval":true}}
→ {"id":"20","kind":"request","method":"sense.approval","params":{"approvalId":"sc-1","action":"accept"}}
← {"kind":"response","requestId":"20","success":true,"data":{"approvalId":"sc-1","action":"accept"}}
← {"kind":"notification","type":"accept","requestId":"chat-1","data":{"approvalId":"sc-1","senseName":"execute_command","result":"file1.txt\nfile2.txt"}}
```

### 自动执行感官（auto 模式）

```text
← [binary chunk] seq:5, requestId:chat-1, data:{"senseCall":[{"index":0,"id":"sc-1","name":"read_file","arguments":"{\"path\":\"test.ts\"}"}]}
← {"kind":"chunk","type":"staged","requestId":"chat-1","data":{"type":"sense_end","senseName":"read_file","arguments":"{\"path\":\"test.ts\"}"}}
← {"kind":"notification","type":"accept","requestId":"chat-1","data":{"approvalId":"sc-1","senseName":"read_file","result":"文件内容..."}}
```

### 恢复执行（pending sense recovery）

```text
→ {"id":"30","kind":"request","method":"chat.resume","params":{"chatId":"chat-uuid"}}
← {"kind":"notification","type":"interrupt","requestId":"chat-uuid","data":{"approvalId":"sc-1","senseName":"execute_command","arguments":"{\"command\":\"ls\"}","supervisionLevel":"confirm","needsApproval":true}}
```

> 历史由 `chat.create` 原子加载到内存；`chat.resume` 自动检测 `role=sense AND content IS NULL` 的 pending 消息并重新发起审批/执行（senseMiddleware Phase 0）。前置：须先 `chat.create`（携带 brain + senseGroups）。

### 删除聊天

```text
→ {"id":"20","kind":"request","method":"chat.delete","params":{"chatId":"chat-1"}}
← {"id":"21","kind":"response","requestId":"20","success":true,"data":{"chatId":"chat-1"}}
```

### 错误处理

```text
← {"kind":"response","requestId":"1","success":false,"error":{"code":"METHOD_NOT_FOUND","message":"Method \"xxx\" not found"}}
← {"kind":"notification","type":"error","requestId":"chat-1","data":{"message":"执行出错"}}
```

错误码：`INTERNAL` | `TIMEOUT` | `METHOD_NOT_FOUND` | `NOT_FOUND` | `INVALID_PARAMS`

## 配置文件

| 文件 | 说明 |
|------|------|
| `.env` | 环境变量：`WS_PORT`、`WEB_PORT`、`OLLAMA_HOST`、`OPENAI_API_KEY`、`CHERY_DIR`、`CHERY_TRANSPORT` |
| [.chery/config.yaml](.chery/config.yaml) | LLM 客户端配置、Sense 分组、全局配置（thinking/supervision/stream） |
| [.chery/system.md](.chery/system.md) | 系统 prompt 模板 |
| [.chery/skills/](.chery/skills/) | 技能定义目录，每个技能包含 `SKILL.md` |
| [.chery/senses/](.chery/senses/) | 外部自定义感官目录，`.ts` 文件自动编译注入 |
| [.chery/db/](.chery/db/) | 数据库存储目录（自动创建） |

### 数据库架构

cheryClaw 采用多文件数据库架构：

``text
[CHERY_DIR]/.chery/db/
├── soul.db                # chats 表
│   └── chats             # 聊天信息（id, messages_month, created_at, updated_at）
└── YYYY-MM.db             # messages 表（按月分片）
    └── messages          # 消息历史（id, chat_id, role, content, thinking, sense_calls）
```

**关键特性：**

- **按月分片**：messages 表按月份存储（如 `2026-06.db`），便于归档与清理
- **路由机制**：chats 表的 `messages_month` 字段记录消息所在月份文件，查询时自动路由
- **审批状态**：`role='sense' AND content IS NULL` 的 messages 表示待审批状态
- **messageId 格式**：`YYYY-MM-uuid`（如 `2026-06-abc123...`），便于月份路由

**表结构：**

```sql
-- soul.db
CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  messages_month TEXT NOT NULL, -- 如 "2026-06"
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT
);

-- YYYY-MM.db
CREATE TABLE messages (
  id TEXT PRIMARY KEY,         -- 格式：YYYY-MM-uuid
  chat_id TEXT NOT NULL,       -- 无外键（跨数据库）
  role TEXT NOT NULL,          -- user/assistant/system/sense
  content TEXT,                -- NULL 表示 pending（待审批）
  thinking TEXT,
  sense_calls TEXT,            -- JSON 数组
  hash TEXT,
  replace_state INTEGER,
  replace_by TEXT,
  replace_content TEXT,
  original_content TEXT,
  created_at INTEGER NOT NULL
);
```

**注意：**

- approvals 表已去掉，审批状态通过 messages.content 字段判断
- brain/senseGroups 为运行时参数，不持久化（由 `brain.set` / `sense.set` 设置，`chat.send` 不携带）
- 跨数据库的外键约束无法生效，删除时手动清理关联数据

### Sense 监管等级

| 等级 | 行为 |
|------|------|
| `auto` | 自动执行，推送 accept notification |
| `confirm` | 推送 interrupt notification，等待审批 |
| `manual` | 推送 interrupt notification，禁止自动执行 |

优先级：感官定义 > sense_group > global.supervision
