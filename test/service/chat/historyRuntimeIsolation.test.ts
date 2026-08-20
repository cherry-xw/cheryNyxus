import { randomUUID } from 'node:crypto'
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest'
import type { WebSocket } from 'ws'
import { RuntimeResolver } from '@/agent/runtimeResolver.js'
import config from '@/utils/config.js'
import {
  addPendingInput,
  createChat,
  deleteChat,
  getMessages,
  listPendingInputs,
} from '@/db/chat.js'
import { getSoulDb } from '@/db/index.js'
import {
  handleChatClose,
  handleChatGet,
  handleChatList,
  handleChatOpen,
  handleChatSync,
} from '@/service/chat/handler.js'
import { handleChatResume } from '@/service/chat/send.js'
import { clearChatRuntime, ensureChat, resolveEffectiveSelection } from '@/service/chat/runtime.js'
import { connectionManager } from '@/service/websocket/connection.js'
import type { HandlerContext } from '@/service/message/router.js'
import { logger } from '@/utils/logger/index.js'
import { bootstrapForTests } from '../../agent/helpers/agentHarness.js'

const cleanupChats: string[] = []
const cleanupSockets: WebSocket[] = []

beforeAll(async () => {
  await bootstrapForTests()
})

afterEach(async () => {
  for (const ws of cleanupSockets.splice(0)) await connectionManager.close(ws)
  for (const chatId of cleanupChats.splice(0).reverse()) {
    clearChatRuntime(chatId)
    deleteChat(chatId)
  }
})

function createContext(): { ctx: HandlerContext; ws: WebSocket } {
  const ws = {
    OPEN: 1,
    readyState: 1,
    send: vi.fn(),
  } as unknown as WebSocket
  const state = connectionManager.create(ws)
  cleanupSockets.push(ws)
  return { ctx: { connectionId: state.id, log: logger }, ws }
}

async function drain<T>(generator: AsyncGenerator<unknown, T, unknown>): Promise<T> {
  while (true) {
    const next = await generator.next()
    if (next.done) return next.value
  }
}

describe('historical runtime isolation', () => {
  it('does not resolve obsolete runtime during list/get/sync/open', async () => {
    const chatId = randomUUID()
    cleanupChats.push(chatId)
    createChat(chatId, {
      preset: 'removed-preset',
      runtime: { brain: 'my-brain', senseGroup: 'removed-senses', mcpServers: [] },
    })

    const resolveSpy = vi.spyOn(RuntimeResolver.prototype, 'resolve')
    const { ctx } = createContext()
    await handleChatList(ctx, { scope: 'history' })
    await drain(handleChatGet(ctx, { chatId }))
    await drain(handleChatSync(ctx, { chatId, afterSeq: 0 }))
    const opened = await handleChatOpen(ctx, { chatId })
    await handleChatClose(ctx, { subscriptionId: opened.subscriptionId })

    expect(resolveSpy).not.toHaveBeenCalled()
    resolveSpy.mockRestore()
  })

  it('maps a stable presetId to the current leader runtime instead of historical metadata', () => {
    const chatId = randomUUID()
    cleanupChats.push(chatId)
    const presetId = config.presets?.['detail-test']?.id
    expect(presetId).toBeTruthy()
    createChat(chatId, {
      preset: 'old-detail-name',
      presetId,
      runtime: { brain: 'my-brain', senseGroup: 'removed-senses', mcpServers: [] },
    })

    expect(resolveEffectiveSelection(chatId)).toMatchObject({
      status: 'followed',
      selection: { brain: 'mock_content', senseGroup: 'auto_senses', mcpServers: [] },
    })
  })

  it('treats legacy preset names and stable ids as one stage association', async () => {
    const stableChatId = randomUUID()
    const legacyChatId = randomUUID()
    cleanupChats.push(stableChatId, legacyChatId)
    const presetId = config.presets?.['detail-test']?.id
    expect(presetId).toBeTruthy()
    createChat(stableChatId, { preset: 'old-detail-name', presetId })
    createChat(legacyChatId, { preset: 'detail-test' })
    const newest = Date.now() + 100_000
    getSoulDb().prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(newest - 1, stableChatId)
    getSoulDb().prepare('UPDATE chats SET updated_at = ? WHERE id = ?').run(newest, legacyChatId)

    const response = await handleChatList({} as HandlerContext, { scope: 'stage' })
    const matching = response.chats.filter(
      (chat) => chat.chatId === stableChatId || chat.chatId === legacyChatId,
    )

    expect(matching.map((chat) => chat.chatId)).toEqual([legacyChatId])
  })

  it('keeps a deleted association viewable but requires an explicit execution selection', async () => {
    const chatId = randomUUID()
    cleanupChats.push(chatId)
    createChat(chatId, {
      preset: 'removed-preset',
      presetId: 'preset-removed-history',
      runtime: { brain: 'my-brain', senseGroup: 'removed-senses', mcpServers: [] },
    })

    await expect(drain(handleChatGet({} as HandlerContext, { chatId }))).resolves.toMatchObject({
      chatId,
      runtime: { brain: 'my-brain' },
    })
    await expect(ensureChat(chatId)).rejects.toMatchObject({
      code: 'RUNTIME_SELECTION_REQUIRED',
    })
  })

  it('leaves a durable pending input inert on open and consumes it once after explicit resume', async () => {
    const chatId = randomUUID()
    cleanupChats.push(chatId)
    const presetId = config.presets?.['detail-test']?.id
    createChat(chatId, {
      preset: 'old-detail-name',
      presetId,
      runtime: { brain: 'my-brain', senseGroup: 'removed-senses', mcpServers: [] },
    })
    addPendingInput({
      inputId: `input-${chatId}`,
      chatId,
      messageId: `message-${chatId}`,
      commandId: `command-${chatId}`,
      content: 'continue this durable command',
      queueSequence: 1,
      state: 'started',
      acceptedAt: Date.now(),
    })

    const { ctx } = createContext()
    const opened = await handleChatOpen(ctx, { chatId })
    expect(getMessages(chatId)).toHaveLength(0)
    expect(listPendingInputs(chatId)).toHaveLength(1)

    await drain(handleChatResume(ctx, { chatId }))
    await handleChatClose(ctx, { subscriptionId: opened.subscriptionId })

    const matchingInputs = getMessages(chatId).filter(
      (message) => message.role === 'user' && message.content === 'continue this durable command',
    )
    expect(matchingInputs).toHaveLength(1)
    expect(listPendingInputs(chatId)).toHaveLength(0)
  })
})
