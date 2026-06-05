import { getDb } from "./index.js";
import { safeJsonParse } from "@/utils/json.js";

export interface ThreadRow {
  id: string;
  session_id: string;
  created_at: number;
  updated_at: number;
  metadata: string | null;
}

export interface MessageRow {
  id: string;
  thread_id: string;
  role: string;
  content: string | null;
  thinking: string | null;
  tool_calls: string | null;
  created_at: number;
}

export interface MessageData {
  role: "user" | "assistant" | "system" | "tool";
  content?: string;
  thinking?: string;
  toolCalls?: Array<{
    id: string;
    type: "function";
    function: {
      name: string;
      arguments: string;
    };
  }>;
}

export function createThread(
  threadId: string,
  sessionId: string,
  metadata?: Record<string, unknown>,
): ThreadRow {
  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO threads (id, session_id, created_at, updated_at, metadata)
    VALUES (?, ?, ?, ?, ?)
  `);

  stmt.run(threadId, sessionId, now, now, metadata ? JSON.stringify(metadata) : null);

  return {
    id: threadId,
    session_id: sessionId,
    created_at: now,
    updated_at: now,
    metadata: metadata ? JSON.stringify(metadata) : null,
  };
}

export function getThread(threadId: string): ThreadRow | undefined {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM threads WHERE id = ?");
  return stmt.get(threadId) as ThreadRow | undefined;
}

export function listThreadsBySession(sessionId: string): ThreadRow[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM threads WHERE session_id = ? ORDER BY updated_at DESC");
  return stmt.all(sessionId) as ThreadRow[];
}

export function updateThread(threadId: string): void {
  const db = getDb();
  const stmt = db.prepare("UPDATE threads SET updated_at = ? WHERE id = ?");
  stmt.run(Date.now(), threadId);
}

export function deleteThread(threadId: string): void {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM threads WHERE id = ?");
  stmt.run(threadId);
}

export function addMessage(
  messageId: string,
  threadId: string,
  data: MessageData,
): MessageRow {
  const db = getDb();
  const now = Date.now();

  const stmt = db.prepare(`
    INSERT INTO messages (id, thread_id, role, content, thinking, tool_calls, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `);

  stmt.run(
    messageId,
    threadId,
    data.role,
    data.content ?? null,
    data.thinking ?? null,
    data.toolCalls ? JSON.stringify(data.toolCalls) : null,
    now,
  );

  updateThread(threadId);

  return {
    id: messageId,
    thread_id: threadId,
    role: data.role,
    content: data.content ?? null,
    thinking: data.thinking ?? null,
    tool_calls: data.toolCalls ? JSON.stringify(data.toolCalls) : null,
    created_at: now,
  };
}

export function getMessages(threadId: string): MessageRow[] {
  const db = getDb();
  const stmt = db.prepare("SELECT * FROM messages WHERE thread_id = ? ORDER BY created_at ASC");
  return stmt.all(threadId) as MessageRow[];
}

export function clearMessages(threadId: string): void {
  const db = getDb();
  const stmt = db.prepare("DELETE FROM messages WHERE thread_id = ?");
  stmt.run(threadId);
  updateThread(threadId);
}

export function parseMessageRow(row: MessageRow): MessageData {
  return {
    role: row.role as MessageData["role"],
    content: row.content ?? undefined,
    thinking: row.thinking ?? undefined,
    toolCalls: row.tool_calls ? safeJsonParse(row.tool_calls, undefined) : undefined,
  };
}