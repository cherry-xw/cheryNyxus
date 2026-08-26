/** Canonical command-plane abort recovery flow. */
import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { deleteChat } from '@/db/chat.js'
import { getInteraction } from '@/db/interaction.js'
import { approvalManager } from '@/service/approval/manager.js'
import { isChatRunning } from '@/service/chat/runtime.js'
import type {
  ChatAbortResponseData,
  ChatCreateResponseData,
  ChatListResponseData,
} from '@/service/message/types.js'
import { allEvents, interrupts, waitFor, waitForNotification } from '../helpers/eventsAssert.js'
import { bootFlowService, connectClient, type FlowService } from '../helpers/serviceHarness.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

describe('S13 canonical abort recovery', () => {
  let svc: FlowService
  let client: RpcClient
  let chatId: string

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
  })

  afterAll(async () => {
    client.close()
    await svc.close()
  })

  async function createAndOpenConfirmChat(): Promise<void> {
    const create = await client.call('chat.create', {
      brain: 'mock_confirm',
      senseGroup: 'confirm_senses',
    })
    expect(create.success).toBe(true)
    chatId = (create.data as ChatCreateResponseData).chatId
    const open = await client.call('chat.open', { scope: 'chat', chatId })
    expect(open.success).toBe(true)
  }

  function submitConfirmInput() {
    return client.request('chat.input.submit', {
      chatId,
      commandId: randomUUID(),
      clientMessageId: randomUUID(),
      messageId: randomUUID(),
      content: '写文件',
    })
  }

  it('projects canResume through the canonical catalog after abort', async () => {
    await createAndOpenConfirmChat()
    const input = submitConfirmInput()
    const ack = await client.awaitResponse(input)
    expect(ack.success).toBe(true)

    await waitForNotification(() => input.events, 'interrupt')
    expect(interrupts(allEvents(input.events))).toHaveLength(1)

    const abort = await client.call('chat.abort', { chatId })
    expect(abort.success).toBe(true)
    expect((abort.data as ChatAbortResponseData).aborted).toBe(true)
    await waitFor(
      () => input.events,
      () => (!isChatRunning(chatId) ? true : undefined),
    )

    const catalog = await client.call('chat.list', { scope: 'history' })
    expect(catalog.success).toBe(true)
    const summary = (catalog.data as ChatListResponseData).chats.find(
      (entry) => entry.chatId === chatId,
    )
    expect(summary?.canResume).toBe(true)
  }, 15_000)

  it('cancels approval and releases runtime immediately after detached input abort', async () => {
    await createAndOpenConfirmChat()
    const input = submitConfirmInput()
    const ack = await client.awaitResponse(input)
    expect(ack.success).toBe(true)

    const interrupt = await waitForNotification(() => input.events, 'interrupt')
    const approvalId = (interrupt.data as { approvalId: string }).approvalId
    expect(approvalManager.has(approvalId)).toBe(true)
    expect(getInteraction(approvalId)?.status).toBe('pending')

    const abort = await client.call('chat.abort', { chatId })
    expect(abort.success).toBe(true)
    expect((abort.data as ChatAbortResponseData).aborted).toBe(true)
    expect(approvalManager.has(approvalId)).toBe(false)
    expect(getInteraction(approvalId)).toMatchObject({
      status: 'cancelled',
      result: { action: 'reject', reason: '用户停止运行' },
    })
    await waitFor(
      () => input.events,
      () => (!isChatRunning(chatId) ? true : undefined),
    )
  }, 15_000)
})
