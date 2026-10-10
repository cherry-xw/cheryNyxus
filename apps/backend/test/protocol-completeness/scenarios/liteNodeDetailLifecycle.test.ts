import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { Method } from '@chery/protocol'
import type {
  ChatCreateResponseData,
  ChatInputSubmitResponseData,
  ChatOpenResponseData,
  ChatTimelineGetResponseData,
  ChatTimelineNodeGetResponseData,
  InteractionListResponseData,
  Notification,
  TimelineNode,
} from '@/service/message/types.js'
import { bootProtocolService, waitFor, type ProtocolService } from '../helpers/serviceHarness.js'

interface OpenedChat { chatId: string; subscriptionId: string }

function commandInput(chatId: string, content: string) {
  return { chatId, content, commandId: randomUUID(), clientMessageId: randomUUID(), messageId: randomUUID() }
}

function notifications(service: ProtocolService, type: string, chatId: string): Notification[] {
  return service.client.received.filter(
    (event): event is Notification =>
      event.kind === 'notification' && event.type === type && event.chatId === chatId,
  )
}

describe('Lite node-detail public protocol lifecycle', () => {
  let service: ProtocolService
  const opened: OpenedChat[] = []

  beforeAll(async () => {
    service = await bootProtocolService()
  })

  afterEach(async () => {
    for (const chat of opened.splice(0).reverse()) {
      await service.client.call(Method.CHAT_ABORT, { chatId: chat.chatId }).catch(() => undefined)
      await service.client.call(Method.CHAT_CLOSE, { subscriptionId: chat.subscriptionId }).catch(() => undefined)
      await service.client.call(Method.CHAT_DELETE, { chatId: chat.chatId }).catch(() => undefined)
    }
  })

  afterAll(async () => service.close())

  async function createChat(): Promise<OpenedChat> {
    const created = await service.client.call(Method.CHAT_CREATE, {
      brain: 'protocol_approval', senseGroup: 'protocol_write', skipBlankReuse: true,
    })
    expect(created.success).toBe(true)
    const chatId = (created.data as ChatCreateResponseData).chatId
    const openedResponse = await service.client.call(Method.CHAT_OPEN, {
      scope: 'root', rootChatId: chatId, view: 'tree',
    })
    expect(openedResponse.success).toBe(true)
    const chat = { chatId, subscriptionId: (openedResponse.data as ChatOpenResponseData).subscriptionId }
    opened.push(chat)
    return chat
  }

  async function toolNode(chatId: string): Promise<TimelineNode> {
    const deadline = Date.now() + 10_000
    while (Date.now() < deadline) {
      const response = await service.client.call(Method.CHAT_TIMELINE_GET, {
        rootChatId: chatId, view: 'tree',
      })
      const timeline = (response.data as ChatTimelineGetResponseData).rootTimeline
      const node = timeline?.nodes.find((item) => item.kind === 'tool-batch' && item.toolCalls?.length)
      if (node) return node
      await new Promise((resolve) => setTimeout(resolve, 20))
    }
    throw new Error('tool node was not persisted')
  }

  it('serves a historical tool detail through the real router before and after approval', async () => {
    const { chatId } = await createChat()
    const request = service.client.request(
      Method.CHAT_INPUT_SUBMIT,
      commandInput(chatId, 'write only after approval'),
    )
    const accepted = await service.client.awaitResponse(request)
    const runId = (accepted.data as ChatInputSubmitResponseData).runId
    await waitFor(() => notifications(service, 'interrupt', chatId).at(-1))

    const node = await toolNode(chatId)
    const first = await service.client.call(Method.CHAT_TIMELINE_NODE_GET, {
      rootChatId: chatId,
      nodeId: node.id,
      sections: ['toolCalls'],
      toolCursor: { callIndex: 0, field: 'arguments', offset: 0 },
    })
    expect(first.success).toBe(true)
    const pendingDetail = first.data as ChatTimelineNodeGetResponseData
    expect(pendingDetail.node.content).toBe('')
    expect(pendingDetail.node.toolCalls).toHaveLength(1)
    expect(pendingDetail.node.toolCalls?.[0]).toMatchObject({ name: 'write_file' })
    expect(pendingDetail.node.toolCalls?.[0]?.result).toBeUndefined()

    const interactions = await service.client.call(Method.INTERACTION_LIST, { includeActivity: true })
    const approval = (interactions.data as InteractionListResponseData).interactions.find(
      (interaction) => interaction.chatId === chatId && interaction.kind === 'approval',
    )
    if (!approval) throw new Error('approval interaction was not persisted')
    const decision = await service.client.call(Method.INTERACTION_APPROVAL_DECIDE, {
      interactionId: approval.interactionId,
      action: 'accept',
      expectedRevision: approval.revision,
      commandId: randomUUID(),
    })
    expect(decision.success).toBe(true)
    await waitFor(() => notifications(service, 'done', chatId).find((event) => event.runId === runId))
    service.client.release(request)

    const completed = await service.client.call(Method.CHAT_TIMELINE_NODE_GET, {
      rootChatId: chatId,
      nodeId: node.id,
      sections: ['toolCalls'],
      toolCursor: { callIndex: 0, field: 'result', offset: 0 },
    })
    expect(completed.success).toBe(true)
    const completedDetail = completed.data as ChatTimelineNodeGetResponseData
    expect(completedDetail.node.content).toBe('')
    expect(completedDetail.node.toolCalls?.[0]).toMatchObject({
      name: 'write_file', status: 'completed', result: expect.any(String),
    })
  })
})
