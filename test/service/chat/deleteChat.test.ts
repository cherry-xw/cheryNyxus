import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat, getChat } from '@/db/chat.js'
import { handleChatDelete } from '@/service/chat/handler.js'
import type { HandlerContext } from '@/service/message/router.js'

const cleanup: string[] = []

afterEach(() => {
  for (const chatId of cleanup.splice(0).reverse()) {
    if (getChat(chatId)) deleteChat(chatId)
  }
})

describe('chat.delete', () => {
  it('returns the authoritative set of recursively deleted chats', async () => {
    const rootChatId = randomUUID()
    const childChatId = randomUUID()
    const grandchildChatId = randomUUID()
    cleanup.push(rootChatId, childChatId, grandchildChatId)
    createChat(rootChatId)
    createChat(childChatId, {}, rootChatId)
    createChat(grandchildChatId, {}, childChatId)

    const result = await handleChatDelete({} as HandlerContext, { chatId: rootChatId })

    expect(new Set(result.deletedChatIds)).toEqual(
      new Set([rootChatId, childChatId, grandchildChatId]),
    )
    expect(getChat(rootChatId)).toBeUndefined()
    expect(getChat(childChatId)).toBeUndefined()
    expect(getChat(grandchildChatId)).toBeUndefined()
  })
})
