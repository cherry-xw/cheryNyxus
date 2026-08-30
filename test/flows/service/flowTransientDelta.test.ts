/** Canonical WS acceptance for transient model-output deltas. */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { deleteChat, getMessages } from '@/db/chat.js'
import { getChatEvents, getRootEvents } from '@/db/delivery.js'
import type {
  ChatCreateResponseData,
  ChatOpenResponseData,
  Notification,
} from '@/service/message/types.js'
import config from '@/utils/config.js'
import { notificationsByType, waitFor, waitForNotification } from '../helpers/eventsAssert.js'
import { bootFlowService, connectClient, type FlowService } from '../helpers/serviceHarness.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

describe('transient stream delta persistence', () => {
  let svc: FlowService
  let client: RpcClient
  let chatId: string
  let savedChunkDelayMs: number | undefined

  beforeAll(async () => {
    svc = await bootFlowService()
    client = await connectClient(svc)
    const mock = config.llm.brain.mock_content?.mock
    if (!mock) throw new Error('mock_content brain is missing its mock configuration')
    savedChunkDelayMs = mock.chunkDelayMs
    mock.chunkDelayMs = 750
  })

  afterEach(() => {
    if (!chatId) return
    try {
      deleteChat(chatId)
    } catch {
      // The test may already have removed it.
    }
    chatId = ''
  })

  afterAll(async () => {
    const mock = config.llm.brain.mock_content?.mock
    if (mock) mock.chunkDelayMs = savedChunkDelayMs
    client.close()
    await svc.close()
  })

  it('delivers live deltas without journaling them and restores the active prefix from memory', async () => {
    const create = await client.call('chat.create', {
      brain: 'mock_content',
      senseGroup: 'auto_senses',
    })
    expect(create.success).toBe(true)
    chatId = (create.data as ChatCreateResponseData).chatId

    const firstOpen = await client.call('chat.open', { scope: 'chat', chatId })
    expect(firstOpen.success).toBe(true)

    const input = client.request('chat.input.submit', {
      chatId,
      commandId: randomUUID(),
      clientMessageId: randomUUID(),
      messageId: randomUUID(),
      content: '回复',
    })
    const ack = await client.awaitResponse(input)
    expect(ack.success).toBe(true)

    const firstDelta = await waitFor(
      () => input.events,
      (events) => notificationsByType(events, 'turn.delta')[0],
      5_000,
    )
    expect(firstDelta).toMatchObject({
      kind: 'notification',
      type: 'turn.delta',
      chatId,
      transient: true,
    })
    expect((firstDelta as Notification & { seq?: number }).seq).toBeUndefined()

    const liveChatEvents = getChatEvents(chatId, 0).events
    const liveRootEvents = getRootEvents(chatId, 0).events
    expect(liveChatEvents.some(isDeltaEvent)).toBe(false)
    expect(liveRootEvents.some(isDeltaEvent)).toBe(false)

    const reopen = await client.call('chat.open', { scope: 'chat', chatId })
    expect(reopen.success).toBe(true)
    const activeTurns = (reopen.data as ChatOpenResponseData).state.activeTurns
    expect(activeTurns).toHaveLength(1)
    expect(activeTurns[0]).toMatchObject({
      turnId: (firstDelta.data as { turnId: string }).turnId,
      thinking: (firstDelta.data as { delta: string }).delta,
      content: '',
    })

    await waitForNotification(() => input.events, 'done', 8_000)

    const messages = getMessages(chatId)
    expect(messages.at(-1)).toMatchObject({
      role: 'assistant',
      content: '你好，这是纯文本回复',
    })

    const finalChatEvents = getChatEvents(chatId, 0).events
    const finalRootEvents = getRootEvents(chatId, 0).events
    expect(finalChatEvents.some(isDeltaEvent)).toBe(false)
    expect(finalRootEvents.some(isDeltaEvent)).toBe(false)
    expect(finalChatEvents.map((event) => event.seq)).toEqual(
      Array.from({ length: finalChatEvents.length }, (_, index) => index + 1),
    )
    expect(finalRootEvents.map((event) => event.rootEventSeq)).toEqual(
      Array.from({ length: finalRootEvents.length }, (_, index) => index + 1),
    )

    const completedOpen = await client.call('chat.open', { scope: 'chat', chatId })
    expect((completedOpen.data as ChatOpenResponseData).state.activeTurns).toEqual([])
    client.release(input)
  }, 15_000)
})

function isDeltaEvent(event: Record<string, unknown>): boolean {
  return (
    (event.kind === 'chunk' && event.type === 'stream') ||
    (event.kind === 'notification' && event.type === 'turn.delta')
  )
}
