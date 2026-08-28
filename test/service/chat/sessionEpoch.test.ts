import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it } from 'vitest'
import { bootstrapAgentRuntime } from '@/agent/bootstrap.js'
import { createChat, deleteChat } from '@/db/chat.js'
import { listChatEpochs } from '@/db/epoch.js'
import { clearChatRuntime, ensureChat } from '@/service/chat/runtime.js'
import { handleSessionRuntimeSet } from '@/service/runtime/session.js'
import type { HandlerContext } from '@/service/message/router.js'
import { logger } from '@/utils/logger/index.js'

const cleanup: string[] = []

beforeAll(async () => {
  await bootstrapAgentRuntime()
})

afterEach(() => {
  for (const chatId of cleanup.splice(0).reverse()) {
    clearChatRuntime(chatId)
    deleteChat(chatId)
  }
})

describe('session runtime epoch boundaries', () => {
  it('does not rotate an epoch for the identical pre-send session selection', async () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    const primary = {
      brain: 'mock_content',
      senseGroup: 'auto_senses',
      mcpServers: [],
    }
    await ensureChat(chatId, primary)

    await handleSessionRuntimeSet({ log: logger } as HandlerContext, {
      chatId,
      primary,
      roles: {},
    })
    await handleSessionRuntimeSet({ log: logger } as HandlerContext, {
      chatId,
      primary,
      roles: {},
    })

    expect(listChatEpochs(chatId)).toHaveLength(1)
  })

  it('rotates exactly once when the main Agent runtime actually changes', async () => {
    const chatId = randomUUID()
    cleanup.push(chatId)
    createChat(chatId)
    await ensureChat(chatId, {
      brain: 'mock_content',
      senseGroup: 'auto_senses',
      mcpServers: [],
    })

    await handleSessionRuntimeSet({ log: logger } as HandlerContext, {
      chatId,
      primary: {
        brain: 'mock_auto',
        senseGroup: 'auto_senses',
        mcpServers: [],
      },
      roles: {},
    })

    expect(listChatEpochs(chatId)).toHaveLength(2)
  })
})
