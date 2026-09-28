/**
 * Chat 处理器共享守卫。
 *
 * 「会话不存在」是所有 chat.* RPC 的公共失败路径：统一抛带
 * `ErrorCode.NOT_FOUND` 的错误（消息保持既有文案，前端直接展示），
 * 供 wsClient 按错误码路由（如会话列表自动摘除）。
 */
import { ErrorCode } from '../message/types.js'
import { getChat, type ChatRow } from '@/db/chat.js'

/** 断言会话存在并返回行；不存在时抛 NOT_FOUND（文案与历史版本一致）。 */
export function assertChatExists(chatId: string): ChatRow {
  const chat = getChat(chatId)
  if (!chat) throw Object.assign(new Error('这个会话不见了'), { code: ErrorCode.NOT_FOUND })
  return chat
}
