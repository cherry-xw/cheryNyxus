/**
 * Tier 2 canonical open acceptance: atomic subscription boundary + transient state hydration.
 *
 * `chat.open` replaces the former attach/sync pair. It registers the subscription, captures
 * eventSeq, hydrates state at that boundary, then releases later events through the subscription.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import type { ChatCreateResponseData, InterruptNotificationData } from '@/service/message/types.js'
import {
  awaitInputAccepted,
  bootFlowService,
  connectClient,
  openChat,
  submitChatInput,
  type FlowService,
} from '../helpers/serviceHarness.js'
import { waitForNotification } from '../helpers/eventsAssert.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

describe('S17 chat.open atomic subscription boundary', () => {
  let svc: FlowService
  let client: RpcClient
  let chatId = ''

  beforeAll(async () => {
    svc = await bootFlowService()
    client = await connectClient(svc)
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
    client.close()
    await svc.close()
  })

  it('opens an idle chat with an explicit subscription boundary and empty transient state', async () => {
    const created = await client.call('chat.create', {
      brain: 'mock_content',
      senseGroup: 'auto_senses',
    })
    chatId = (created.data as ChatCreateResponseData).chatId

    const opened = await openChat(client, chatId)
    expect(opened.chatId).toBe(chatId)
    expect(opened.subscriptionId).toBeTruthy()
    expect(opened.eventSeq).toBe(0)
    expect(opened.state.run).toBeUndefined()
    expect(opened.state.pendingInputs).toEqual([])
    expect(opened.state.activeTurns).toEqual([])
    expect(opened.state.questionBatches).toEqual([])
    expect(opened.state.runningTools).toEqual([])
  })

  it('hydrates the live run and pending approval at the captured event boundary', async () => {
    const created = await client.call('chat.create', {
      brain: 'mock_confirm',
      senseGroup: 'confirm_senses',
    })
    chatId = (created.data as ChatCreateResponseData).chatId

    const input = submitChatInput(client, chatId, '写文件')
    await awaitInputAccepted(client, input)
    const interrupt = await waitForNotification(() => input.events, 'interrupt')
    const approvalId = (interrupt.data as InterruptNotificationData).approvalId

    const opened = await openChat(client, chatId)
    expect(opened.eventSeq).toBeGreaterThan(0)
    expect(opened.state.run?.state).toBe('running')
    expect(opened.state.pendingApproval?.approvalId).toBe(approvalId)
    expect(opened.state.runningTools.some((tool) => tool.id === approvalId)).toBe(true)

    await client.call('chat.abort', { chatId })
  }, 15_000)

  it('delivers events created after open with the same subscription and increasing eventSeq', async () => {
    const created = await client.call('chat.create', {
      brain: 'mock_content',
      senseGroup: 'auto_senses',
    })
    chatId = (created.data as ChatCreateResponseData).chatId
    const opened = await openChat(client, chatId)

    const input = submitChatInput(client, chatId, '回复')
    await awaitInputAccepted(client, input)
    await waitForNotification(() => input.events, 'done')

    const sequenced = client.received.filter(
      (event) =>
        (event as { subscriptionId?: string }).subscriptionId === opened.subscriptionId &&
        typeof (event as { eventSeq?: unknown }).eventSeq === 'number',
    ) as Array<{ eventSeq: number; subscriptionId: string }>
    expect(sequenced.length).toBeGreaterThan(0)
    expect(sequenced.every((event) => event.eventSeq > opened.eventSeq)).toBe(true)
    expect(sequenced.map((event) => event.eventSeq)).toEqual(
      [...sequenced.map((event) => event.eventSeq)].sort((a, b) => a - b),
    )
  }, 15_000)
})
