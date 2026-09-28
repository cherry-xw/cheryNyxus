import { getMonthlyDb, getSoulDb } from './index.js'

/**
 * 断言写操作命中 ≥1 行，否则抛错（规则12：失败显性化，禁静默 0 行）。
 * better-sqlite3 RunResult.changes 反映受影响行数；UPDATE/DELETE 命中 0 行多为
 * chat/messageId 不匹配等隐性 bug（如 fillApprovalResult 旧实现落错库致 content 永久 NULL）。
 * 用结构类型 { changes: number } 免 import better-sqlite3 类型。
 */
export function assertChanged(result: { changes: number }, context: string): void {
  if (result.changes === 0) {
    throw new Error(`[db] ${context}: 0 rows affected (expected ≥1)`)
  }
}

/** Look up a chat's fixed message shard; callers retain their existing missing-chat behavior. */
export function getChatMonthlyDb(chatId: string): ReturnType<typeof getMonthlyDb> | undefined {
  const row = getSoulDb().prepare('SELECT messages_month FROM chats WHERE id = ?').get(chatId) as
    { messages_month: string } | undefined
  return row ? getMonthlyDb(row.messages_month) : undefined
}
