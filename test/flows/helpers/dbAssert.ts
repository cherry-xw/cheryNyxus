/**
 * DB 断言辅助：直接读 sqlite（经 db/chat.ts 封装，自动路由月份分片）。
 *
 * 验证 docs/database.md 的存储语义：
 * - chats 表：messages_month / created_at / updated_at
 * - messages 表：role / content / thinking / sense_calls / revoked / hash
 * - pending 语义：role=sense AND content 为空（NULL/空串）
 * - revoked 语义：revoked=1，buildMessages 过滤
 */
import {
  getMessages,
  getChat,
  parseMessageRow,
  type MessageRow,
  type ChatRow,
} from "@/db/chat.js";

export interface ParsedMessage {
  id: string;
  role: string;
  content?: string;
  thinking?: string;
  senseCall?: Array<{ id: string; name: string; arguments: string }>;
  hash?: string;
  revoked: boolean;
  createdAt: number;
}

export function dbRawMessages(chatId: string): MessageRow[] {
  return getMessages(chatId);
}

export function dbMessages(chatId: string): ParsedMessage[] {
  return getMessages(chatId).map((row) => {
    const parsed = parseMessageRow(row);
    return {
      id: row.id,
      role: parsed.role,
      content: parsed.content,
      thinking: parsed.thinking,
      senseCall: parsed.senseCall,
      hash: parsed.hash,
      revoked: parsed.revoked,
      createdAt: row.created_at,
    };
  });
}

export function dbChat(chatId: string): ChatRow | undefined {
  return getChat(chatId);
}

/** 仅未撤回的消息（buildMessages 视角） */
export function dbVisibleMessages(chatId: string): ParsedMessage[] {
  return dbMessages(chatId).filter((m) => !m.revoked);
}

/** pending sense 判定：role=sense 且 content 为空 */
export function isPendingSense(m: ParsedMessage): boolean {
  return m.role === "sense" && (!m.content || m.content === "");
}
