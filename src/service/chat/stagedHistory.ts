import { createChunk, type Chunk } from '../message/types.js'
import { getMessages, parseMessageRow } from '@/db/message.js'
import type { RuntimeSelection } from '@/agent/runtimeResolver.js'
import { projectMessageRuntime } from './runtimeProvenance.js'
/**
 * 把 chat 持久消息转成 staged chunk 序列（消息→staged），供 chat.get 历史回放与 chat.sync 超窗回填复用。
 * runtime 溯源：user 带自身 runtime（并推进 lastUserRuntime），assistant 带前一条 user runtime（关联，见 agent-pet.md §5.7）。
 * 合成 chunk 的 requestId 为空串（非 RPC 产物），seq 缺省（超窗回填的旧历史无真实 seq，前端按 msgId/id 处理）。
 */
export function messagesToStagedEvents(chatId: string): Chunk[] {
  const messages = getMessages(chatId)
  let lastUserRuntime: RuntimeSelection | undefined
  const chunks: Chunk[] = []
  for (const msg of messages) {
    const parsedMsg = parseMessageRow(msg)
    if (parsedMsg.thinking) {
      chunks.push(
        createChunk(
          'staged',
          '',
          {
            type: 'thinking_end',
            role: parsedMsg.role,
            thinking: parsedMsg.thinking,
            createdAt: msg.created_at,
            msgId: msg.id,
            agentChatId: chatId,
          },
          { chatId },
        ),
      )
    }
    if (parsedMsg.content) {
      // History replay resets attribution on a content-bearing user row without a selection.
      const projection = projectMessageRuntime(
        parsedMsg.role,
        parsedMsg.runtime,
        lastUserRuntime,
        true,
      )
      const msgRuntime = projection.current
      lastUserRuntime = projection.next
      chunks.push(
        createChunk(
          'staged',
          '',
          {
            type: 'content_end',
            role: parsedMsg.role,
            content: parsedMsg.content,
            createdAt: msg.created_at,
            msgId: msg.id,
            agentChatId: chatId,
            ...(msgRuntime ? { runtime: msgRuntime } : {}),
            ...(parsedMsg.role === 'sense' ? { id: msg.id } : {}),
            ...(parsedMsg.replace?.state
              ? { replace: parsedMsg.replace, originalContent: parsedMsg.originalContent }
              : {}),
            ...(parsedMsg.contextCompaction ? { contextCompaction: true } : {}),
            ...(parsedMsg.contextCompactionTokens !== undefined
              ? { contextCompactionTokens: parsedMsg.contextCompactionTokens }
              : {}),
          },
          { chatId },
        ),
      )
    }
    if (parsedMsg.role !== 'sense' && parsedMsg.senseCall && parsedMsg.senseCall.length > 0) {
      for (const sc of parsedMsg.senseCall) {
        chunks.push(
          createChunk(
            'staged',
            '',
            {
              type: 'sense_end',
              role: parsedMsg.role,
              senseName: sc.name,
              arguments: sc.arguments,
              id: sc.id,
              agentChatId: chatId,
              ...(sc.security ? { security: sc.security } : {}),
            },
            { chatId },
          ),
        )
      }
    }
  }
  return chunks
}
