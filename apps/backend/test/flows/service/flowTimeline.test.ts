/**
 * Tier 2 canonical history acceptance.
 *
 * `chat.timeline.get` replaces the former sync replay hydration path. Complete canonical messages
 * come from durable message storage, while revision exposes a stable snapshot version.
 */
import { afterAll, afterEach, beforeAll, describe, expect, it } from 'vitest'
import { deleteChat, getChat } from '@/db/chat.js'
import { getMonthlyDb } from '@/db/index.js'
import type { ChatCreateResponseData } from '@/service/message/types.js'
import {
  awaitInputAccepted,
  bootFlowService,
  connectClient,
  getChatTimeline,
  submitChatInput,
  type FlowService,
} from '../helpers/serviceHarness.js'
import { waitForNotification } from '../helpers/eventsAssert.js'
import type { RpcClient } from '../../helpers/rpcClient.js'

describe('S11 canonical durable timeline', () => {
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

  async function createCompletedTodoChat(): Promise<void> {
    const created = await client.call('chat.create', {
      brain: 'mock_todo',
      senseGroup: 'todo_senses',
    })
    chatId = (created.data as ChatCreateResponseData).chatId
    const input = submitChatInput(client, chatId, '规划任务')
    await awaitInputAccepted(client, input)
    await waitForNotification(() => input.events, 'done')
  }

  it('returns complete canonical messages independently of chat-event retention', async () => {
    await createCompletedTodoChat()

    const baseline = await getChatTimeline(client, chatId)
    expect(baseline.revision).toBeGreaterThan(0)
    expect(baseline.messages?.map((message) => message.role)).toEqual([
      'user',
      'assistant',
      'assistant',
    ])
    const todo = baseline.messages
      ?.flatMap((message) => message.senseCalls ?? [])
      .find((call) => call.name === 'update_todo')
    expect(todo?.status).toBe('accepted')
    expect(JSON.parse(todo!.arguments).todos).toHaveLength(3)

    const month = getChat(chatId)!.messages_month
    getMonthlyDb(month).prepare('DELETE FROM chat_events WHERE chat_id = ?').run(chatId)

    const afterRetention = await getChatTimeline(client, chatId)
    expect(afterRetention.messages?.map((message) => message.id)).toEqual(
      baseline.messages?.map((message) => message.id),
    )
    expect(afterRetention.revision).toBe(baseline.revision)
  }, 15_000)

  it('keeps the direct-chat revision and complete timeline stable for a known revision', async () => {
    await createCompletedTodoChat()

    const baseline = await getChatTimeline(client, chatId)
    const unchanged = await getChatTimeline(client, chatId, baseline.revision)
    expect(unchanged.revision).toBe(baseline.revision)
    expect(unchanged.messages?.map((message) => message.id)).toEqual(
      baseline.messages?.map((message) => message.id),
    )
  }, 15_000)
})
