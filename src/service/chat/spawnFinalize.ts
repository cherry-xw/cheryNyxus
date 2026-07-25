import { getChat, getLastMessage, updateChatMetadata } from '@/db/chat.js'
import { finishSpawnTask, getSpawnTaskByChild } from '@/db/delivery.js'
import { safeJsonParse } from '@/utils/json.js'
import { logger } from '@/utils/logger/index.js'

/**
 * 幂等终态化 spawn 子 chat（防御性兜底，见 docs/service/chat.md chat.resume 流程）。
 *
 * 统一暂停语义下，子 loop 的任何错误（429 / retry 耗尽 / AI 报错）只归 paused（可 resume 续跑），不中断流程。
 * 子可能多次暂停-resume，最终一次 chat.resume 跑完时（末条 assistant 无 senseCalls）即为真正完成，必须标 finished。
 *
 * 主路径：wait=true/false 子 loop 结束均 yield child_done → observer 设 finished + wakeParent（docs/agent-pet.md §5.4）。
 * 本 helper 兜底 child_done 未走的边界（如 startSpawn RPC 中断后前端改发独立 chat.resume），与 handleChatStartSpawn
 * 的 4 处标记逻辑对齐，幂等不重复唤主。
 *
 * 判定权威：末条 assistant（真正完成的唯一标志，见 docs/agent/middleware.md 统一暂停语义）。
 * 不调 wakeParent——observer.child_done 路径已唤主，此处仅补持久态。
 *
 * @returns true 表示本次标记了终态；false 表示非子 chat / 已终态 / 未真正完成（paused/中断）。
 */
export function finalizeSpawnChildIfDone(chatId: string): boolean {
  const chat = getChat(chatId)
  if (!chat?.parent_chat_id) return false // 非子 chat

  const meta = chat.metadata ? (safeJsonParse(chat.metadata, {}) as { finished?: boolean }) : {}
  if (meta.finished === true) return false // 已终态（幂等）

  const last = getLastMessage(chatId)
  if (last?.role !== 'assistant') return false // 末条非 assistant，未真正完成（paused / 中断）

  const task = getSpawnTaskByChild(chatId)
  if (task && task.status !== 'finished') finishSpawnTask(task.taskId)
  updateChatMetadata(chatId, { finished: true })
  logger.event('spawn.finalize', { chatId, parentChatId: chat.parent_chat_id })
  return true
}
