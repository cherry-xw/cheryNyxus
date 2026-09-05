import { randomUUID } from 'crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { addMessage, createChat, deleteChat } from '@/db/chat.js'
import { appendChatEvent, prepareChatEventForDelivery } from '@/db/delivery.js'
import { buildTaskOverview } from '@/service/chat/overview.js'

const cleanup: string[] = []
afterEach(() => {
  for (const id of cleanup.splice(0).reverse()) deleteChat(id)
})

describe('task overview projection', () => {
  it('aggregates a root and its agents and filters old completed tasks', () => {
    const root = randomUUID()
    const child = randomUUID()
    cleanup.push(root, child)
    createChat(root, { preset: 'research', presetId: 'preset-1' })
    createChat(child, { type: 'reviewer', finished: true }, root)

    const overview = buildTaskOverview(root, 0)
    expect(overview).toMatchObject({
      rootChatId: root,
      preset: 'research',
      presetId: 'preset-1',
      pendingCount: 0,
    })
    expect(overview?.agents).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ chatId: root, role: '主 Agent' }),
        expect.objectContaining({ chatId: child, role: 'reviewer', status: 'completed' }),
      ]),
    )
    expect(buildTaskOverview(root, Date.now() + 10_000)).toBeUndefined()
  })

  it('keeps only the latest twenty meaningful activity events', () => {
    const root = randomUUID()
    cleanup.push(root)
    createChat(root)
    for (let index = 0; index < 25; index += 1) {
      prepareChatEventForDelivery(root, {
        kind: 'notification',
        type: 'turn.started',
        data: { turnId: `turn-${index}`, messageId: `message-${index}`, createdAt: index + 1 },
        chatId: root,
      })
    }

    const events = buildTaskOverview(root, 0)?.recentEvents ?? []
    expect(events).toHaveLength(20)
    expect(events[0]?.at).toBe(6)
    expect(events.at(-1)?.at).toBe(25)
  })

  it('surfaces a failed resumable agent as failed instead of paused', () => {
    const root = randomUUID()
    cleanup.push(root)
    createChat(root)
    addMessage(randomUUID(), root, { role: 'sense', content: 'failed tool result' })
    for (const [type, data] of [
      ['run.updated', { runId: 'run-failed', status: 'running', at: 10 }],
      ['turn.started', { runId: 'run-failed', turnId: 'turn-failed', createdAt: 11 }],
      ['error', { runId: 'run-failed', message: 'boom' }],
      ['run.updated', { runId: 'run-failed', status: 'paused', at: 12 }],
    ] as const) {
      appendChatEvent(root, { kind: 'notification', type, data, chatId: root, runId: 'run-failed' })
    }

    expect(buildTaskOverview(root, 0)).toMatchObject({
      status: 'failed',
      hasFailure: true,
      agents: [expect.objectContaining({ status: 'failed' })],
    })
  })
})
