import { randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { createChat, deleteChat } from '@/db/chat.js'
import {
  claimInteraction,
  getInteraction,
  listInteractions,
  transitionInteraction,
  upsertPendingInteraction,
} from '@/db/interaction.js'

const chats: string[] = []
afterEach(() => {
  for (const chatId of chats.splice(0).reverse()) deleteChat(chatId)
})

describe('durable interaction inbox', () => {
  it('keeps one stable approval identity across pending upserts', () => {
    const chatId = randomUUID()
    chats.push(chatId)
    createChat(chatId, { presetId: 'preset-a' })
    const first = upsertPendingInteraction({
      interactionId: 'approval-a',
      kind: 'approval',
      chatId,
      payload: { senseName: 'write_file', arguments: '{}' },
      deadlineAt: Date.now() + 30_000,
    })
    const second = upsertPendingInteraction({
      interactionId: 'approval-a',
      kind: 'approval',
      chatId,
      payload: { senseName: 'write_file', arguments: '{}' },
      deadlineAt: first.deadlineAt,
    })
    expect(second.interactionId).toBe(first.interactionId)
    expect(second.revision).toBe(first.revision + 1)
    expect(listInteractions({ presetId: 'preset-a' })).toHaveLength(1)
  })

  it('atomically claims one terminal state and keeps activity auditable', () => {
    const chatId = randomUUID()
    chats.push(chatId)
    createChat(chatId)
    upsertPendingInteraction({
      interactionId: 'approval-terminal',
      kind: 'approval',
      chatId,
      payload: { senseName: 'bash', arguments: '{}' },
    })
    expect(transitionInteraction('approval-terminal', ['pending'], 'expired', {
      action: 'reject', reason: 'timeout',
    })?.status).toBe('expired')
    expect(transitionInteraction('approval-terminal', ['pending'], 'completed')).toBeUndefined()
    expect(listInteractions()).toHaveLength(0)
    expect(listInteractions({ includeActivity: true }).find((item) => item.interactionId === 'approval-terminal')?.result)
      .toMatchObject({ action: 'reject', reason: 'timeout' })
    expect(getInteraction('approval-terminal')?.completedAt).toBeTypeOf('number')
  })

  it('claims by revision once and never revives a terminal interaction', () => {
    const chatId = randomUUID()
    chats.push(chatId)
    createChat(chatId)
    const pending = upsertPendingInteraction({
      interactionId: 'approval-claim',
      kind: 'approval',
      chatId,
      payload: { senseName: 'bash', arguments: '{}' },
    })

    const claimed = claimInteraction(pending.interactionId, pending.revision)
    expect(claimed?.status).toBe('resolving')
    expect(claimInteraction(pending.interactionId, pending.revision)).toBeUndefined()
    expect(transitionInteraction(pending.interactionId, ['resolving'], 'completed')?.status)
      .toBe('completed')

    const replayed = upsertPendingInteraction({
      interactionId: pending.interactionId,
      kind: 'approval',
      chatId,
      payload: { senseName: 'bash', arguments: '{"replayed":true}' },
    })
    expect(replayed.status).toBe('completed')
    expect(replayed.payload).toEqual({ senseName: 'bash', arguments: '{}' })
  })
})
