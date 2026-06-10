# cheryClaw

多 LLM Brain 框架，支持 Ollama、OpenAI 等提供商。核心特性：Sense 调用监管、流式响应、两阶段执行。

## 隐喻体系

cheryClaw 采用拟人化隐喻设计：

| 概念 | 隐喻 | 说明 |
|------|------|------|
| Brain | 大脑 | AI 服务核心，负责思考决策 |
| Sense | 感官 | 感知操作，神经手脚，与世界交互 |
| Soul | 灵魂 | 智能体的独立存在，承载记忆与性格 |
| Chat | 聊天 | 与灵魂的交互通道，承载消息历史 |

**交互流程：** 创建灵魂 → 载入灵魂 → 创建聊天 → 发送消息 → 触发感官 → 大脑思考

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

## 数据格式示例

### 创建灵魂

```text
→ {"id":"1","kind":"request","method":"soul.create","params":{"brain":"ollama"}}
← {"id":"2","kind":"response","requestId":"1","success":true,"data":{"soulId":"abc","config":{"provider":"ollama","model":"gemma3:1b"}}}
```

### 列出灵魂

```text
→ {"id":"2","kind":"request","method":"soul.list","params":{}}
← {"id":"3","kind":"response","requestId":"2","success":true,"data":{"souls":[{"soulId":"abc","config":{"provider":"ollama","model":"gemma3:1b"},"createdAt":1717700000000}]}}
```

### 载入灵魂

```text
→ {"id":"3","kind":"request","method":"soul.load","params":{"soulId":"abc"}}
← {"id":"4","kind":"response","requestId":"3","success":true,"data":{"soulId":"abc","config":{...},"chats":[...],"pendingApprovals":[...]}}
```

### 创建聊天

```text
→ {"id":"4","kind":"request","method":"chat.create","params":{"soulId":"abc"}}
← {"id":"5","kind":"response","requestId":"4","success":true,"data":{"chatId":"chat-uuid"}}
```

**注意：** 发送消息前必须先创建聊天。`chat.send` 不再自动创建 chatId。

### 列出聊天

```text
→ {"id":"5","kind":"request","method":"chat.list","params":{"soulId":"abc"}}
← {"id":"6","kind":"response","requestId":"5","success":true,"data":{"chats":[{"chatId":"chat-1","createdAt":1717700000000,"updatedAt":1717700100000,"messageCount":5}]}}
```

### 获取聊天详情（载入历史对话）

```text
→ {"id":"5","kind":"request","method":"chat.get","params":{"chatId":"chat-1"}}
← {"id":"6","kind":"response","requestId":"5","success":true,"data":{"chatId":"chat-1"}}
← [binary chunk] type:staged, data:{"type":"thinking_end","role":"assistant","thinking":"历史思考内容"}
← [binary chunk] type:staged, data:{"type":"content_end","role":"assistant","content":"历史响应内容"}
← [binary chunk] type:staged, data:{"type":"sense_end","role":"assistant","senseName":"...","arguments":"..."}
← {"kind":"notification","type":"complete","requestId":"chat-1","data":{"approvalId":"...","senseName":"...","result":"..."}}
← {"kind":"notification","type":"loaded","requestId":"chat-1","data":null}
```

### 发送聊天消息（流式）

```text
→ {"id":"10","kind":"request","method":"chat.send","params":{"soulId":"abc","chatId":"chat-uuid","prompt":"你好"}}
← [binary chunk] seq:1, data:{"content":"你"}
← [binary chunk] seq:2, data:{"content":"好"}
← {"kind":"notification","type":"done","requestId":"chat-1","data":null}
← {"kind":"response","requestId":"10","success":true,"data":{"chatId":"chat-uuid"}}
```

### 感官审批流程（confirm 模式）

```text
← {"kind":"notification","type":"interrupt","requestId":"chat-1","data":{"approvalId":"sc-1","senseName":"execute_command","arguments":"{\"command\":\"ls\"}","supervisionLevel":"confirm"}}
→ {"id":"20","kind":"request","method":"sense.approval","params":{"soulId":"abc","approvalId":"sc-1","action":"accept"}}
← {"kind":"response","requestId":"20","success":true,"data":{"approvalId":"sc-1","action":"accept"}}
← {"kind":"notification","type":"complete","requestId":"chat-1","data":{"approvalId":"sc-1","senseName":"execute_command","result":"file1.txt\nfile2.txt"}}
```

### 自动执行感官（auto 模式）

```text
← [binary chunk] seq:5, requestId:chat-1, data:{"senseCall":[{"index":0,"id":"sc-1","name":"read_file","arguments":"{\"path\":\"test.ts\"}"}]}
← {"kind":"chunk","type":"staged","requestId":"chat-1","data":{"type":"sense_end","senseName":"read_file","arguments":"{\"path\":\"test.ts\"}"}}
← {"kind":"notification","type":"complete","requestId":"chat-1","data":{"approvalId":"sc-1","senseName":"read_file","result":"文件内容..."}}
```

### 删除聊天

```text
→ {"id":"20","kind":"request","method":"chat.delete","params":{"chatId":"chat-1"}}
← {"id":"21","kind":"response","requestId":"20","success":true,"data":{"chatId":"chat-1"}}
```

### 删除灵魂（需先删除所有 Chat）

```text
→ {"id":"30","kind":"request","method":"soul.delete","params":{"soulId":"abc"}}
← {"id":"31","kind":"response","requestId":"30","success":false,"error":{"code":"SOUL_HAS_CHATS","message":"Soul has chats, delete them first"}}
```

### 错误处理

```text
← {"kind":"response","requestId":"1","success":false,"error":{"code":"METHOD_NOT_FOUND","message":"Method \"xxx\" not found"}}
← {"kind":"notification","type":"error","requestId":"chat-1","data":{"message":"执行出错"}}
```

错误码：`INTERNAL` | `TIMEOUT` | `METHOD_NOT_FOUND` | `SOUL_NOT_FOUND` | `APPROVAL_NOT_FOUND` | `INVALID_PARAMS` | `SOUL_HAS_CHATS`

## 配置文件

| 文件 | 说明 |
|------|------|
| `.env` | 环境变量：`WS_PORT`、`OLLAMA_HOST`、`OPENAI_API_KEY`、`CHERY_DIR`、`CHERY_TRANSPORT` |
| [.chery/config.yaml](.chery/config.yaml) | LLM 客户端配置、Sense 分组、全局配置（thinking/supervision/stream） |
| [.chery/system.md](.chery/system.md) | 系统 prompt 模板 |
| [.chery/skills/](.chery/skills/) | 技能定义目录，每个技能包含 `SKILL.md` |
| [.chery/senses/](.chery/senses/) | 外部自定义感官目录，`.ts` 文件自动编译注入 |
| [.chery/db/](.chery/db/) | 数据库存储目录（自动创建） |

### 数据库架构

cheryClaw 采用多文件数据库架构，提升性能与可维护性：

``text
[CHERY_DIR]/.chery/db/
├── soul.db                # souls + chats 表
│   ├── souls             # 灵魂信息（id, agent_name, provider, model, sense_group）
│   └── chats             # 聊天信息（id, soul_id, messages_month, created_at, updated_at）
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
CREATE TABLE souls (
  id TEXT PRIMARY KEY,
  agent_name TEXT NOT NULL,
  provider TEXT NOT NULL,
  model TEXT NOT NULL,
  sense_group TEXT,
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL
);

CREATE TABLE chats (
  id TEXT PRIMARY KEY,
  soul_id TEXT NOT NULL,
  messages_month TEXT NOT NULL, -- 如 "2026-06"
  created_at INTEGER NOT NULL,
  updated_at INTEGER NOT NULL,
  metadata TEXT,
  FOREIGN KEY (soul_id) REFERENCES souls(id) ON DELETE CASCADE
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
- 跨数据库的外键约束无法生效，删除时手动清理关联数据
- 历史数据迁移：建议清空重来，手动删除旧 `data.db` 文件

### Sense 监管等级

| 等级 | 行为 |
|------|------|
| `auto` | 自动执行，推送 complete notification |
| `confirm` | 推送 interrupt notification，等待审批 |
| `manual` | 推送 interrupt notification，禁止自动执行 |

优先级：感官定义 > sense_group > global.supervision