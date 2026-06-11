import { getSoulDb, getMonthlyDb, getAllMonths } from "./index.js";
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
}

/**
 * 格式化年份月份（YYYY-MM）
 */
function formatYearMonth(timestamp: number): string {
  const date = new Date(timestamp);
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, "0")}`;
}

/**
 * 创建聊天（无需 soulId）
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
 * 删除聊天（手动清理 messages）
 */
export function deleteChat(chatId: string): void {
  const soulDb = getSoulDb();

  // 1. 查询 messages_month
  const chatStmt = soulDb.prepare("SELECT messages_month FROM chats WHERE id = ?");
  const chat = chatStmt.get(chatId) as { messages_month: string } | undefined;

  if (!chat) return;

  // 2. 删除 messages
  const monthlyDb = getMonthlyDb(chat.messages_month);
  const msgStmt = monthlyDb.prepare("DELETE FROM messages WHERE chat_id = ?");
  msgStmt.run(chatId);

  // 3. 删除 chat
  const stmt = soulDb.prepare("DELETE FROM chats WHERE id = ?");
  stmt.run(chatId);
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
    INSERT INTO messages (id, chat_id, role, content, thinking, sense_calls, hash, replace_state, replace_by, replace_content, original_content, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
 * 填充审批结果（更新 content 字段）
 * messageId 格式：YYYY-MM-uuid
 */
export function fillApprovalResult(messageId: string, result: string): void {
  // 提取月份（YYYY-MM）
  const month = messageId.substring(0, 7);
  const monthlyDb = getMonthlyDb(month);

  const stmt = monthlyDb.prepare("UPDATE messages SET content = ? WHERE id = ?");
  stmt.run(result, messageId);
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
  };
}