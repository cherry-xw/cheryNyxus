import { getSoulDb } from '@/db/index.js'
import { getChat } from '@/db/chat.js'
import { addMessage, fillApprovalResult, getMessages } from '@/db/message.js'

/** Called synchronously at the yielded start boundary, before any tool handler runs. */
export function recordToolStart(chatId: string, callId: string, name: string, args: string, requestLocal = false): boolean {
  if (name === 'ask_user_question') return false
  const db = getSoulDb()
  db.prepare('INSERT OR IGNORE INTO tool_execution_starts(chat_id, call_id, name) VALUES (?, ?, ?)').run(chatId, callId, name)
  if (requestLocal) return false
  if (getMessages(chatId).some(message => message.id === callId)) return false
  addMessage(callId, chatId, { role: 'sense', senseCall: [{ id: callId, name, arguments: args }] })
  return true
}

export function releaseToolStart(chatId: string, callId: string): void {
  getSoulDb().prepare('DELETE FROM tool_execution_starts WHERE chat_id = ? AND call_id = ?').run(chatId, callId)
}

/** No external request is issued during recovery, even if the previous result was lost. */
export function recoverInterruptedTools(): void {
  const db = getSoulDb()
  const starts = db.prepare('SELECT chat_id, call_id, name FROM tool_execution_starts').all() as { chat_id: string; call_id: string; name: string }[]
  const messages = new Map<string, ReturnType<typeof getMessages>>()
  for (const entry of starts) {
    if (!getChat(entry.chat_id)) { releaseToolStart(entry.chat_id, entry.call_id); continue }
    let rows = messages.get(entry.chat_id)
    if (!rows) { rows = getMessages(entry.chat_id); messages.set(entry.chat_id, rows) }
    const existing = rows.find(row => row.id === entry.call_id)
    if (!existing?.content) {
      const content = `工具 ${entry.name} 已开始，但服务在保存结果前中断。执行结果未确认；不会自动重放。请先查询实际状态，不能假定外部操作已经停止或失败。`
      if (existing) fillApprovalResult(entry.chat_id, entry.call_id, { content })
      else addMessage(entry.call_id, entry.chat_id, { role: 'role', content })
    }
    releaseToolStart(entry.chat_id, entry.call_id)
  }
}
