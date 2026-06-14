import { getSoulDb, getMonthlyDb } from "./index.js";
import { safeJsonParse } from "@/utils/json.js";
import { randomUUID } from "crypto";

export interface ChatRow {
  id: string;
  messages_month: string;
  created_at: number;
  updated_at: number;
  metadata: string | null;
}

export interface MessageRow {
  id: string;
  chat_id: string;
  role: string;
  content: string | null;
  thinking: string | null;
  sense_calls: string | null;
  hash: string | null;
  replace_state: number | null;
  replace_by: string | null;
  replace_content: string | null;
  original_content: string | null;
  revoked: number;
  created_at: number;
}

export interface MessageData {
  role: "user" | "assistant" | "system" | "sense";
  content?: string;
  thinking?: string;
  senseCall?: Array<{
    id: string;
    name: string;
    arguments: string;
  }>;
  hash?: string;
  replace?: {
    state: boolean;
    by: string;
    content: string;
  };
  originalContent?: string;
  revoked?: boolean;
}

/**
 * 格式化年份月份（YYYY-MM）
 * 用于 createChat 时确定该 chat 的 messages 分片月份（创建月固定，跨月不迁移）
 */
function formatYearMonth(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * 创建聊天（无需 soulId）
 * messages_month 按创建时间固定，之后该 chat 所有消息都写入此月份分片（跨月不迁移）
 */
export function createChat(
  chatId: string,
  metadata?: Record<string, unknown>,
): ChatRow {
  const db = getSoulDb();
  const now = Date.now();
  const messagesMonth = formatYearMonth(now);

  const stmt = db.prepare(`
    INSERT INTO chats (id, messages_month, created_at, updated_at, metadata)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(chatId, messagesMonth, now, now, metadata ? JSON.stringify(metadata) : null);

  // 确保月份文件存在
  getMonthlyDb(messagesMonth);

  return {
    id: chatId,
    messages_month: messagesMonth,
    created_at: now,
    updated_at: now,
    metadata: metadata ? JSON.stringify(metadata) : null,
  };
}

/**
 * 获取聊天
 */
export function getChat(chatId: string): ChatRow | undefined {
  const db = getSoulDb();
  const stmt = db.prepare("SELECT * FROM chats WHERE id = ?");
  return stmt.get(chatId) as ChatRow | undefined;
}

/**
 * 列出所有聊天（全局，不再按 soulId 过滤）
 */
export function listAllChats(): ChatRow[] {
  const db = getSoulDb();
  const stmt = db.prepare("SELECT * FROM chats ORDER BY updated_at DESC");
  return stmt.all() as ChatRow[];
}

/**
 * 更新聊天时间戳
 */
export function updateChat(chatId: string): void {
  const db = getSoulDb();
  const stmt = db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?");
  stmt.run(Date.now(), chatId);
}

/**
 * 更新 chat metadata（JSON merge）。
 * patch 浅合并到现有 metadata，避免覆盖其他 key（未来扩展用途不冲突）。
 */
export function updateChatMetadata(
  chatId: string,
  patch: Record<string, unknown>,
): void {
  const db = getSoulDb();
  const row = db
    .prepare("SELECT metadata FROM chats WHERE id = ?")
    .get(chatId) as { metadata: string | null } | undefined;
  if (!row) return;
  const current = row.metadata
    ? (safeJsonParse(row.metadata, {}) as Record<string, unknown>)
    : {};
  const next = { ...current, ...patch };
  db.prepare("UPDATE chats SET metadata = ?, updated_at = ? WHERE id = ?").run(
    JSON.stringify(next),
    Date.now(),
    chatId,
  );
}

/**
 * 读取持久化的 runtime selection（metadata.runtime）。
 * 服务重启后内存 chatRuntimes 丢失，ensureChat 据此自动恢复 runtime。
 * brain/group 为 config.yaml 名称引用，恢复时实时 resolve（配置变更后自动用新配置）。
 */
export function getChatRuntimeSelection(
  chatId: string,
): { brain: string; senseGroups: string[] } | undefined {
  const db = getSoulDb();
  const row = db
    .prepare("SELECT metadata FROM chats WHERE id = ?")
    .get(chatId) as { metadata: string | null } | undefined;
  if (!row?.metadata) return undefined;
  const parsed = safeJsonParse(row.metadata, {}) as Record<string, unknown>;
  const rt = parsed.runtime as
    | { brain?: string; senseGroups?: string[] }
    | undefined;
  if (
    !rt?.brain ||
    !Array.isArray(rt.senseGroups) ||
    rt.senseGroups.length === 0
  ) {
    return undefined;
  }
  return { brain: rt.brain, senseGroups: rt.senseGroups };
}

/**
 * 删除聊天（手动清理 messages）
 * 跨库无事务：先删 messages 再删 chat，try/finally 保证 chat 行删除，
 * 崩溃风险仅留 chat 行未删的孤儿（指向已空 messages 库），可接受。
 */
export function deleteChat(chatId: string): void {
  const soulDb = getSoulDb();

  // 1. 查询 messages_month
  const chatStmt = soulDb.prepare("SELECT messages_month FROM chats WHERE id = ?");
  const chat = chatStmt.get(chatId) as { messages_month: string } | undefined;

  if (!chat) return;

  // 2. 先删 messages（跨库），finally 删 chat 行避免中途崩溃留孤儿 chat 指向空库
  try {
    const monthlyDb = getMonthlyDb(chat.messages_month);
    const msgStmt = monthlyDb.prepare("DELETE FROM messages WHERE chat_id = ?");
    msgStmt.run(chatId);
  } finally {
    const stmt = soulDb.prepare("DELETE FROM chats WHERE id = ?");
    stmt.run(chatId);
  }
}

/**
 * 添加消息（路由到月份文件）
 */
export function addMessage(
  messageId: string,
  chatId: string,
  data: MessageData,
): MessageRow {
  // 1. 获取 chat 的 messages_month
  const soulDb = getSoulDb();
  const chatStmt = soulDb.prepare("SELECT messages_month FROM chats WHERE id = ?");
  const chat = chatStmt.get(chatId) as { messages_month: string } | undefined;

  if (!chat) throw new Error(`Chat ${chatId} not found`);

  // 2. 生成包含月份的 messageId
  const uuid = randomUUID();
  const finalMessageId = messageId || `${chat.messages_month}-${uuid}`;

  // 3. 路由到月份文件并插入 message
  const monthlyDb = getMonthlyDb(chat.messages_month);
  const now = Date.now();

  const stmt = monthlyDb.prepare(`
    INSERT INTO messages (id, chat_id, role, content, thinking, sense_calls, hash, replace_state, replace_by, replace_content, original_content, revoked, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    finalMessageId,
    chatId,
    data.role,
    data.content ?? null,
    data.thinking ?? null,
    data.senseCall ? JSON.stringify(data.senseCall) : null,
    data.hash ?? null,
    data.replace?.state ? 1 : 0,
    data.replace?.by ?? null,
    data.replace?.content ?? null,
    data.originalContent ?? null,
    data.revoked ? 1 : 0,
    now,
  );

  updateChat(chatId);

  return {
    id: finalMessageId,
    chat_id: chatId,
    role: data.role,
    content: data.content ?? null,
    thinking: data.thinking ?? null,
    sense_calls: data.senseCall ? JSON.stringify(data.senseCall) : null,
    hash: data.hash ?? null,
    replace_state: data.replace?.state ? 1 : 0,
    replace_by: data.replace?.by ?? null,
    replace_content: data.replace?.content ?? null,
    original_content: data.originalContent ?? null,
    revoked: data.revoked ? 1 : 0,
    created_at: now,
  };
}

/**
 * 获取消息（路由到月份文件）
 */
export function getMessages(chatId: string): MessageRow[] {
  // 1. 获取 chat 的 messages_month
  const soulDb = getSoulDb();
  const chatStmt = soulDb.prepare("SELECT messages_month FROM chats WHERE id = ?");
  const chat = chatStmt.get(chatId) as { messages_month: string } | undefined;

  if (!chat) return [];

  // 2. 路由到月份文件
  const monthlyDb = getMonthlyDb(chat.messages_month);

  // 3. 查询 messages
  const stmt = monthlyDb.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC");
  return stmt.all(chatId) as MessageRow[];
}

/**
 * 清空消息（路由到月份文件）
 */
export function clearMessages(chatId: string): void {
  // 1. 获取 chat 的 messages_month
  const soulDb = getSoulDb();
  const chatStmt = soulDb.prepare("SELECT messages_month FROM chats WHERE id = ?");
  const chat = chatStmt.get(chatId) as { messages_month: string } | undefined;

  if (!chat) return;

  // 2. 删除 messages
  const monthlyDb = getMonthlyDb(chat.messages_month);
  const stmt = monthlyDb.prepare("DELETE FROM messages WHERE chat_id = ?");
  stmt.run(chatId);

  updateChat(chatId);
}

/**
 * 填充审批结果（更新 content / hash 字段）
 * 按 chatId 路由月份库（与 addMessage/getMessages 同源），消除对 messageId 月份前缀的依赖：
 * confirm pending sense 的 messageId = trigger.id（LLM tool_call.id 或 sense-${index}），无月份前缀，
 * 旧实现 substring(0,7) 会落到错误空库、UPDATE 命中 0 行 → content 永远 NULL。
 */
export function fillApprovalResult(
  chatId: string,
  messageId: string,
  fields: { content?: string; hash?: string },
): void {
  const soulDb = getSoulDb();
  const chat = soulDb
    .prepare("SELECT messages_month FROM chats WHERE id = ?")
    .get(chatId) as { messages_month: string } | undefined;
  if (!chat) return;

  const monthlyDb = getMonthlyDb(chat.messages_month);

  const sets: string[] = [];
  const vals: unknown[] = [];
  if (fields.content !== undefined) {
    sets.push("content = ?");
    vals.push(fields.content);
  }
  if (fields.hash !== undefined) {
    sets.push("hash = ?");
    vals.push(fields.hash);
  }
  if (sets.length === 0) return;

  monthlyDb
    .prepare(`UPDATE messages SET ${sets.join(", ")} WHERE id = ?`)
    .run(...vals, messageId);
}

/**
 * 批量标记消息 revoked（chat.resume 撤回时持久化）
 */
export function markMessagesRevoked(chatId: string, messageIds: string[]): void {
  if (messageIds.length === 0) return;
  const soulDb = getSoulDb();
  const chat = soulDb
    .prepare("SELECT messages_month FROM chats WHERE id = ?")
    .get(chatId) as { messages_month: string } | undefined;
  if (!chat) return;

  const monthlyDb = getMonthlyDb(chat.messages_month);
  const placeholders = messageIds.map(() => "?").join(", ");
  monthlyDb
    .prepare(`UPDATE messages SET revoked = 1 WHERE id IN (${placeholders})`)
    .run(...messageIds);
}

/**
 * 标记消息 replaced（感官去重命中时持久化 replace 状态）
 * 与 markMessagesRevoked 同源路由（按 chatId 定位月份库），
 * UPDATE replace_state/replace_by/replace_content/original_content，不动 content 字段（历史内容保持真实，replace 为元数据）。
 */
export function markMessageReplaced(
  chatId: string,
  messageId: string,
  fields: {
    replace: { state: boolean; by: string; content: string };
    originalContent?: string;
  },
): void {
  const soulDb = getSoulDb();
  const chat = soulDb
    .prepare("SELECT messages_month FROM chats WHERE id = ?")
    .get(chatId) as { messages_month: string } | undefined;
  if (!chat) return;

  const monthlyDb = getMonthlyDb(chat.messages_month);
  monthlyDb
    .prepare(
      `UPDATE messages
       SET replace_state = ?, replace_by = ?, replace_content = ?, original_content = ?
       WHERE id = ?`,
    )
    .run(
      fields.replace.state ? 1 : 0,
      fields.replace.by,
      fields.replace.content,
      fields.originalContent ?? null,
      messageId,
    );
}

/**
 * 解析消息行
 */
export function parseMessageRow(row: MessageRow): MessageData {
  return {
    role: row.role as MessageData["role"],
    content: row.content ?? undefined,
    thinking: row.thinking ?? undefined,
    senseCall: row.sense_calls ? safeJsonParse(row.sense_calls, undefined) : undefined,
    hash: row.hash ?? undefined,
    replace: row.replace_state
      ? { state: true, by: row.replace_by ?? "", content: row.replace_content ?? "" }
      : undefined,
    originalContent: row.original_content ?? undefined,
    revoked: row.revoked === 1,
  };
}