import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { createChat, deleteChat } from '@/db/chat.js'
import { addMessage, getMessages, parseMessageRow } from '@/db/message.js'

it('保留超时截断内容，并在重新读取消息时恢复模型排除标记', () => {
  const chatId = randomUUID()
  createChat(chatId)
  try {
    addMessage(randomUUID(), chatId, { role: 'user', content: '完整提问' })
    addMessage(randomUUID(), chatId, { role: 'sense', content: '此前完成的工具结果' })
    const partialId = randomUUID()
    addMessage(partialId, chatId, {
      role: 'assistant',
      content: '已收到的半截回复【模型请求超时截断】',
      thinking: '已收到的思考',
      modelExcluded: true,
    })

    const rows = getMessages(chatId)
    expect(rows.map((row) => parseMessageRow(row).modelExcluded)).toEqual([false, false, true])
    expect(parseMessageRow(rows.find((row) => row.id === partialId)!).content).toContain('半截回复')
    expect(parseMessageRow(rows.find((row) => row.id === partialId)!).thinking).toBe('已收到的思考')
  } finally {
    deleteChat(chatId)
  }
})
