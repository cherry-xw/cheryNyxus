# DB 数据持久化模块

> 源码 [src/db/](../src/db/) ｜ 上级 [README](./README.md) ｜ 相关 [service/chat.md](./service/chat.md)（observer 调用 DB 写）、[协议规范](./protocol.md)、[交互流程](./interaction.md)

本文档吸收并取代了旧版 `docs/database.md`（schema + 分片 + revoked/审批状态机制）。chats/messages 的全部表结构、字段含义、状态判定规则以本文档为准。

## 职责

多文件 SQLite 持久化层，为 service 层提供 chat 与 message 的 CRUD：

- **多实例管理**：`soul.db`（全局 chats 表）+ 按月分片的 `YYYY-MM.db`（messages 表），实例缓存单例。
- **按创建月固定分片**：chat 创建时固化 `messages_month`，该 chat 全生命周期所有消息写入同一月份库，跨月不迁移。
- **chat 生命周期 CRUD**：创建、查询、列出（含冗余 `message_count`）、更新时间戳、metadata JSON merge、删除（跨库）。
- **message CRUD**：路由到对应月份库的插入、查询、审批结果回填、批量撤回、感官去重 replace 标记。
- **问题批次投影**：`question_batches` + `question_items` 持久化 ask_user_question 批次；支持旧消息回填、事件游标快照和整批原子回答。
- **运行时配置持久化**：`metadata.runtime` 存储 brain + senseGroup + mcpServers，服务重启后自动恢复（单组化：读时兼容旧 `senseGroups[]` 取首项）；预设创建的会话还快照 `metadata.workspace`（项目工作目录）、`metadata.promptPathOverride`（角色 systemPrompt 合并到全局 base 之后）、`metadata.skillFilter`（per-role 技能组/插件组白名单，`{skills?, plugins?}`，仅裁剪 system prompt `<skills>` 块），使后续更改 `config.yaml` 不影响历史会话。
- **自动 schema 迁移**：旧库缺列时按列检查补 `ALTER TABLE ADD COLUMN`，无需手动迁移。

三大隐喻映射：**Chat**（chatId）是顶层实体存于 soul.db；**消息**（含 Brain 响应与 Sense 调用结果）按月分片存于 `YYYY-MM.db`。审批与撤回不建独立表，靠 `content` 空与 `revoked=1` 判定。

## 文件清单

| 文件 | 一句话 |
|------|--------|
| [src/db/index.ts](../src/db/index.ts) | 多 SQLite 实例管理：`getSoulDb`/`getMonthlyDb` 单例缓存、chats/messages 建表、列迁移、`closeAllDbs` |
| [src/db/chat.ts](../src/db/chat.ts) | chats 表 CRUD + messages 表按月路由 CRUD、`MessageRow`/`MessageData` 类型、`parseMessageRow` |
| [src/db/question.ts](../src/db/question.ts) | QuestionBatch/QuestionItem 持久化、旧占位消息回填、权威快照与原子批量回答 |

## 核心概念 / 导出

### 实例管理（index.ts）

```ts
// soul.db 单例（首次调用时建库 + 建表 + 迁移）
export function getSoulDb(): Database.Database;
// YYYY-MM.db 单例（按 yearMonth 缓存，缺失则建库 + 建表 + 迁移）
export function getMonthlyDb(yearMonth: string): Database.Database;
// 关闭所有缓存的 db 实例（SIGINT/SIGTERM 调用）
export function closeAllDbs(): void;
```

`dbCache` 为模块级私有：

```ts
const dbCache = {
  soulDb: null as Database.Database | null,
  monthlyDbs: new Map<string, Database.Database>(),
};
```

两个 PRAGMA 统一开启：soul.db `foreign_keys = ON` + `journal_mode = WAL`；月库仅 `journal_mode = WAL`（跨库外键约束无法生效，messages 不带外键）。

### 表结构（真实 schema）

```sql
-- soul.db.chats
CREATE TABLE chats (
  id             TEXT PRIMARY KEY,          -- chatId（前端传入或 UUID）
  messages_month TEXT NOT NULL,             -- "YYYY-MM"，创建月固定，消息路由键
  created_at     INTEGER NOT NULL,          -- Date.now()
  updated_at     INTEGER NOT NULL,          -- 每条消息更新
  metadata       TEXT,                      -- JSON 字符串，含 runtime: { brain, senseGroup }
  message_count  INTEGER NOT NULL DEFAULT 0,-- 冗余计数（P1-8，chatList 免 N+1）
  parent_chat_id TEXT                       -- 子 agent 关联主 chat 的 chatId；主 chat 为 NULL（主从 Agent 桌宠系统 CP1）
);

-- YYYY-MM.db.messages
CREATE TABLE messages (
  id               TEXT PRIMARY KEY,        -- 调用方传入（checkpoint/loadHistory 生成）
  chat_id          TEXT NOT NULL,           -- 无外键（跨库）
  role             TEXT NOT NULL,           -- user / assistant / system / sense
  content          TEXT,                    -- NULL 或空串 = pending（待审批/未完成）
  thinking         TEXT,
  sense_calls      TEXT,                    -- JSON 数组：[{id,name,arguments}]
  hash             TEXT,                    -- sense 结果 hash（历史去重）
  replace_state    INTEGER DEFAULT 0,       -- 感官去重命中标记
  replace_by       TEXT,                    -- 触发替换的新 sense id
  replace_content  TEXT,                    -- 替换说明（短）
  original_content TEXT,                    -- 被替换时的原内容（溯源）
  revoked          INTEGER DEFAULT 0,       -- 1 = 撤回（buildMessages 过滤）
  runtime          TEXT,                    -- JSON {brain,senseGroup,mcpServers}，仅 user 消息记（发送时配置）；assistant 不记（回放关联前一条 user）
  created_at       INTEGER NOT NULL
);
CREATE INDEX idx_messages_chat ON messages(chat_id);

-- YYYY-MM.db.question_batches / question_items
-- batch_id = assistant_message_id；status=pending/completed。
-- item 保存结构化问题、单/多选标记、pending/answered/cancelled 和答案审计字段。
```

### CRUD 函数（chat.ts）

| 函数 | 签名要点 | 说明 |
|------|----------|------|
| `createChat(chatId, metadata?, parentChatId?)` | → `ChatRow` | 按 `Date.now()` 算 `messages_month`（创建月固定），同步预创建月库；`parentChatId` 可选，子 agent 写主 chat 的 chatId，主 chat 留空 |
| `getChat(chatId)` | → `ChatRow \| undefined` | |
| `listAllChats()` | → `ChatRow[]` | 按 `updated_at DESC`，`message_count` 直接读冗余列 |
| `updateChat(chatId)` | → void | 仅更新 `updated_at` |
| `updateChatMetadata(chatId, patch)` | → void | JSON 浅合并到现有 metadata（保留其他 key） |
| `getChatRuntimeSelection(chatId)` | → `{brain, senseGroup, mcpServers} \| undefined` | 读 `metadata.runtime`，重启后恢复用；兼容旧 `senseGroups[]`，缺失的 `mcpServers` 视为 `[]` |
| `getChatSkillFilter(chatId)` | → `{skills?, plugins?} \| undefined` | 读 `metadata.skillFilter`（per-role 技能组/插件组白名单快照，`getChatPromptOverride`/`getChatWorkspace` 同类）。任一维度缺省 = 该维度全部通过；二者皆缺省 → 返 `undefined`（全部 skill，向后兼容） |
| `deleteChat(chatId)` | → void | 跨库 try/finally：先删 messages 再删 chat，崩溃仅留孤儿 chat（指向已空月库） |
| `addMessage(messageId, chatId, data)` | → `MessageRow` | messageId 调用方传入；`message_count++`；更新 `updated_at`；`data.runtime` 仅 user 消息传（发送时配置，记入 messages.runtime） |
| `getMessages(chatId)` | → `MessageRow[]` | 按 `created_at ASC` |
| `fillApprovalResult(chatId, messageId, {content?, hash?})` | → void | 按路由定位月库 UPDATE（**不依赖 messageId 月份前缀**） |
| `markMessagesRevoked(chatId, messageIds[])` | → void | 批量 `SET revoked=1 WHERE id IN (...)` |
| `markMessageReplaced(chatId, messageId, fields)` | → void | 感官去重：写 replace_* 与 optional content，不改 content 时不误清空 |
| `parseMessageRow(row)` | → `MessageData` | 行→结构化，含 `replace`/`revoked` 解析 |

### 行类型

```ts
export interface MessageRow {
  id: string; chat_id: string; role: string;
  content: string | null; thinking: string | null;
  sense_calls: string | null; hash: string | null;
  replace_state: number | null; replace_by: string | null;
  replace_content: string | null; original_content: string | null;
  revoked: number; created_at: number;
  runtime: string | null;                // JSON {brain,senseGroup,mcpServers}，仅 user 消息记
}

export interface MessageData {
  role: "user" | "assistant" | "system" | "sense";
  content?: string; thinking?: string;
  senseCall?: Array<{ id: string; name: string; arguments: string }>;
  hash?: string;
  replace?: { state: boolean; by: string; content: string };
  originalContent?: string;
  revoked?: boolean;
  runtime?: { brain: string; senseGroup: string; mcpServers: string[] }; // 仅 user 消息传（发送时配置）
}
```

## 关键流程 / 数据流

### 按月分片路由

```
createChat(chatId)
  └─ messages_month = formatYearMonth(now)        // 创建月固化，跨月不迁移
  └─ INSERT chats + getMonthlyDb(month) 预创建

addMessage(messageId, chatId, data)
  └─ SELECT messages_month FROM chats WHERE id=chatId
  └─ getMonthlyDb(messages_month)                  // 命中缓存或新建
  └─ INSERT messages + chats.message_count++ + updateChat

getMessages(chatId) / fillApprovalResult / markMessagesRevoked / markMessageReplaced
  └─ 同样先查 messages_month 路由（全部按 chatId 定位月库，不依赖 id 前缀）
```

> ⚠ **messageId 路由历史教训**：旧实现按 `messageId.substring(0,7)` 提取月份定位库。但 pending sense 的 messageId = `trigger.id`（LLM `tool_call.id` 或 `sense-${index}`，无月份前缀），导致 `fillApprovalResult` 落到错误空库、UPDATE 命中 0 行、content 永远 NULL。**已修正**：所有月份路由统一按 chatId 查 `messages_month`，与 `addMessage`/`getMessages` 同源。

### 状态判定（无独立状态表）

| 状态 | 判定 | 谁读 | 谁写 |
|------|------|------|------|
| **pending（待审批/未完成）** | `role='sense' AND content` 为 NULL/空串 | `chat.get` 算 `canResume`；`buildMessages` 跳过 pending 末尾 | senseMiddleware 创建 pending sense 时 `addMessage(content=undefined)` |
| **审批完成** | `content` 非空 | observer confirm 时读 | `fillApprovalResult` 写 content/hash |
| **撤回（revoked）** | `revoked=1` | `buildMessages` 过滤不进 LLM 上下文 | `markMessagesRevoked`（chat.send 恢复撤回） |
| **感官去重命中** | `replace_state=1` | `parseMessageRow` 还原 `replace` 元数据 | `markMessageReplaced`（read_file hash 相同 = 文件未变） |

### chat.get canResume 判定（handler 层，但依赖本模块）

末条（跳过 revoked）为 `sense` 或 `user` → `canResume=true`：
- `sense`：pending sense 待恢复 / done sense 无后续 assistant
- `user`：用户消息已入库但 assistant 未响应（异常中断，resume Case2 复用末条 user 调 LLM）

### schema 自动迁移

旧库（建表早于新列引入）用 `CREATE TABLE IF NOT EXISTS` 不会补列，靠 `PRAGMA table_info` 按列检查补 `ALTER TABLE ADD COLUMN`：

- `ensureChatColumn(db, "message_count", "INTEGER NOT NULL DEFAULT 0")`：加列时一次性按各自 `messages_month` 路由 `COUNT(*)` 回填。
- `ensureMessageColumn(db, "revoked", "INTEGER DEFAULT 0")`。

## 依赖与关联 ⭐

**被依赖（谁调用 db）：**

- [service/chat/observer.ts](../src/service/chat/observer.ts)：`addMessage`（message_created effect + abort finally flush）、`fillApprovalResult`（message_updated 非 replace）、`markMessageReplaced`（message_updated 带 replace = 感官去重）。
- [service/chat/handler.ts](../src/service/chat/handler.ts)：`createChat`/`listAllChats`/`getChat`/`getMessages`/`deleteChat`/`parseMessageRow`（chat.create/list/get/delete）。
- [service/chat/runtime.ts](../src/service/chat/runtime.ts)：`getMessages`/`parseMessageRow`（loadHistory）、`getChatRuntimeSelection`/`updateChatMetadata`（持久化 runtime selection 到 metadata.runtime）。
- [service/chat/send.ts](../src/service/chat/send.ts)：`getChat`（存在校验）、`markMessagesRevoked`（chat.send 恢复场景撤回）。
- [service/runtime/set.ts](../src/service/runtime/set.ts)：`getChat`（存在校验）。
- [src/index.ts](../src/index.ts)：`getSoulDb()`（启动时初始化）、`closeAllDbs()`（SIGINT/SIGTERM）。

**依赖：**

- `better-sqlite3`：同步 SQLite 驱动。
- [@/utils/config](../src/utils/config.ts)：`config.global.db_dir`（库目录，默认 `.chery/db`）。
- [@/utils/json](../src/utils/json.ts)：`safeJsonParse`（metadata / sense_calls 解析兜底）。

**横切参考：**

- [service/chat.md](./service/chat.md)：observer 如何消费 effect chunk 触发 DB 写、审批回填与撤回流程。
- [交互流程](./interaction.md)：chat.send 撤回、chat.resume 续接的协议层交互序列。

## 扩展点

- **新增消息字段**：在 `initMonthlyTables` 的 `CREATE TABLE` 加列 + 对应 `ensureMessageColumn` 兜底旧库；同步更新 `MessageRow` / `MessageData` / `addMessage` / `parseMessageRow`。
- **新增 chat 字段**：`initSoulTables` 建表加列 + `ensureChatColumn`（若需回填仿 message_count 分支）。例：`parent_chat_id TEXT` 子 agent 关联主 chat，无需回填（`ADD COLUMN` 缺省 NULL），`ensureChatColumn(db, "parent_chat_id", "TEXT")` 即可。
- **改分片策略**：当前创建月固定不迁移；若要按消息时间动态分片，需重写 `addMessage`（按 now 算 month 而非查 `messages_month`）并调整 `getMessages`（跨月合并，需 chat 跨多月时路由）。
- **添加审批持久化表**：当前审批靠 content 空判定；若需审批历史/审计，新增表 + 在 `fillApprovalResult` 同处写入。
