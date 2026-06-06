import { getDb } from "./index.js";
import { safeJsonParse } from "@/utils/json.js";

export interface ChatRow {
  id: string;
  soul_id: string;
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
}

export function createChat(
  chatId: string,
  soulId: string,
  metadata?: Record<string, unknown>,
): ChatRow {
  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO chats (id, soul_id, created_at, updated_at, metadata)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(chatId, soulId, now, now, metadata ? JSON.stringify(metadata) : null);

  return {
    id: chatId,
    soul_id: soulId,
    created_at: now,
    updated_at: now,
    metadata: metadata ? JSON.stringify(metadata) : null,
  };
}

export function getChat(chatId: string): ChatRow | undefined {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM chats WHERE id = ?");
  return stmt.get(chatId) as ChatRow | undefined;
}

export function listChatsBySoul(soulId: string): ChatRow[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM chats WHERE soul_id = ? ORDER BY updated_at DESC");
  return stmt.all(soulId) as ChatRow[];
}

export function updateChat(chatId: string): void {
  const db = getDb();
  const stmt = db.prepare("UPDATE chats SET updated_at = ? WHERE id = ?");
  stmt.run(Date.now(), chatId);
}

export function deleteChat(chatId: string): void {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM chats WHERE id = ?");
  stmt.run(chatId);
}

export function addMessage(
  messageId: string,
  chatId: string,
  data: MessageData,
): MessageRow {
  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO messages (id, chat_id, role, content, thinking, sense_calls, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    messageId,
    chatId,
    data.role,
    data.content ?? null,
    data.thinking ?? null,
    data.senseCall ? JSON.stringify(data.senseCall) : null,
    now,
  );

  updateChat(chatId);

  return {
    id: messageId,
    chat_id: chatId,
    role: data.role,
    content: data.content ?? null,
    thinking: data.thinking ?? null,
    sense_calls: data.senseCall ? JSON.stringify(data.senseCall) : null,
    created_at: now,
  };
}

export function getMessages(chatId: string): MessageRow[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM messages WHERE chat_id = ? ORDER BY created_at ASC");
  return stmt.all(chatId) as MessageRow[];
}

export function clearMessages(chatId: string): void {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM messages WHERE chat_id = ?");
  stmt.run(chatId);
  updateChat(chatId);
}

export function parseMessageRow(row: MessageRow): MessageData {
  return {
    role: row.role as MessageData["role"],
    content: row.content ?? undefined,
    thinking: row.thinking ?? undefined,
    senseCall: row.sense_calls ? safeJsonParse(row.sense_calls, undefined) : undefined,
  };
}