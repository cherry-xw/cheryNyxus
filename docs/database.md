# 数据库架构与监管

> [← 返回 README](../README.md)

## 数据库架构

cheryClaw 采用多文件数据库架构：

```text
[CHERY_DIR]/.chery/db/
├── soul.db                # chats 表
│   └── chats             # 聊天信息（id, messages_month, created_at, updated_at）
└── YYYY-MM.db             # messages 表（按 chat 创建月固定分片）
    └── messages          # 消息历史（id, chat_id, role, content, thinking, sense_calls）
```

**关键特性：**

- **按创建月固定分片**：messages 表按 chat 创建月存储（如 `2026-06.db`），`messages_month` 在 createChat 时固化，跨月不迁移
- **路由机制**：chats 表的 `messages_month` 字段记录消息所在月份文件，查询时自动路由
- **审批状态**：`role='sense' AND content` 为空（NULL 或空串）的 messages 表示待审批状态
- **消息撤回（revoked）**：`chat.send` 在 chat.get 恢复场景（重启后末尾留有未完成周期）触发时，撤回整个当前周期 AI 响应（assistant 的 think/content/tool + pending sense 消息）标记 `revoked=1`，`buildMessages` 过滤不进 LLM 上下文，并发 `staged.reverse` chunk 通知客户端回滚（撤回规则见 [interaction.md](interaction.md) chat.send）
- **messageId 格式**：目标 `YYYY-MM-uuid`（便于月份路由）。⚠ pending sense 实际 id = `trigger.id`（LLM `tool_call.id`，无月份前缀），`fillApprovalResult` 月份提取错误（审查 P0 #1，待修）

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
  content TEXT,                -- 空（NULL/空串）表示 pending（待审批）
  thinking TEXT,
  sense_calls TEXT,            -- JSON 数组
  hash TEXT,
  revoked INTEGER DEFAULT 0,   -- 撤回标记：chat.resume 撤回的消息，buildMessages 过滤
  replace_state INTEGER,
  replace_by TEXT,
  replace_content TEXT,
  original_content TEXT,
  created_at INTEGER NOT NULL
);
```

**注意：**

- approvals 表已去掉，审批状态通过 messages.content 字段判断
- brain/senseGroups 为运行时参数，不持久化（由 `chat.create` / `runtime.set` 原子设置，`chat.send` 不携带）
- 跨数据库的外键约束无法生效，删除时手动清理关联数据

## Sense 监管等级

| 等级 | 值 | 行为 |
|------|----|------|
| `auto` | 0 | 自动执行，推送 accept notification |
| `confirm` | 1 | 推送 interrupt notification，等待审批 |
| `manual` | 2 | 推送 interrupt notification，禁止自动执行 |

优先级：感官定义 > sense_group > global.supervision
