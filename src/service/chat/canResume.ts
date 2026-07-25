import { getChat, getLastMessage } from '@/db/chat.js'
import { hasPendingQuestionBatches } from '@/db/question.js'
import { safeJsonParse } from '@/utils/json.js'

/**
 * 判定 chat 是否可 resume（统一暂停语义：非 ended 态皆可 resume）。
 *
 * ended 唯一条件：末条 visible assistant 且无 sense_calls（loop 自然完成，AI 给出纯正文响应）。
 * 其余皆 paused（可 resume）：末条 sense/user/role/subagent，或 assistant 带工具调用
 * （AI 还没基于工具结果回复，处于暂停态）。
 *
 * 提取共享：chat.get / chat.list / streamMapper(error+done 分支) 复用，避免逻辑漂移。
 * hasPendingQuestionBatches 兜底：提问占位期间禁止 resume（由 batchAnswer 走 resume）。
 * abandoned 兜底：watchdog wake_on_timeout=true 标记的子为 ghost，用户无法操作 → 不可 resume。
 * getLastMessage 已过滤 revoked，此处仅判角色与 sense_calls（DB snake_case JSON 串）。
 */
export function computeCanResume(chatId: string): boolean {
  // abandoned 子（看门狗 wake_on_timeout=true 判定）→ ghost，无交互面
  const chat = getChat(chatId)
  if (chat?.metadata) {
    const meta = safeJsonParse<{ abandoned?: boolean }>(chat.metadata, {})
    if (meta.abandoned === true) return false
  }
  if (hasPendingQuestionBatches(chatId)) return false
  const last = getLastMessage(chatId)
  if (!last) return false
  const role = last.role
  if (role === 'sense' || role === 'user' || role === 'role' || role === 'subagent') return true
  if (role === 'assistant') {
    // 末条 assistant 带工具调用 = AI 还没基于工具结果回复 = paused 可 resume；
    // 无工具调用 = ended（loop 自然完成，新用户对话开始前的最终态）。
    const senseCalls = last.sense_calls ? safeJsonParse<Array<unknown>>(last.sense_calls, []) : []
    return Array.isArray(senseCalls) && senseCalls.length > 0
  }
  return false
}
