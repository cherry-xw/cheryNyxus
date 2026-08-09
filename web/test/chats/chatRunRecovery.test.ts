import { describe, expect, it, vi } from 'vitest'
import { createEmptySession } from '../../src/stores/chats/hydration'
import {
  beginLiveRun,
  shouldResumeRoleReply,
  toSequencedSessionEvent,
} from '../../src/stores/chats'
import { installActiveTurns, reduceSessionEvent } from '../../src/stores/chats/reducer'

describe('chat live run recovery', () => {
  it('marks the canonical session working before a live resume receives stream output', () => {
    const session = createEmptySession('parent-chat')
    session.run.status = 'paused'
    session.run.error = 'waiting for answer'
    session.run.retainUntil = Date.now() + 10_000
    const onWorkingChange = vi.fn()

    expect(beginLiveRun(session, onWorkingChange)).toBe(true)
    expect(session.run).toMatchObject({
      status: 'running',
      error: undefined,
      retainUntil: undefined,
    })
    expect(session.ui.bubbleVisible).toBe(true)
    expect(onWorkingChange).toHaveBeenCalledWith('parent-chat', true)
  })

  it('does not restart an already-running session or replayed role reply', () => {
    const session = createEmptySession('parent-chat')
    session.run.status = 'running'
    const onWorkingChange = vi.fn()

    expect(beginLiveRun(session, onWorkingChange)).toBe(false)
    expect(onWorkingChange).not.toHaveBeenCalled()

    session.sync.replaying = true
    expect(shouldResumeRoleReply(session)).toBe(false)
  })

  it('advances the canonical event sequence for sequenced legacy notifications', () => {
    const legacy = toSequencedSessionEvent({
      kind: 'notification',
      type: 'consumed',
      chatId: 'parent-chat',
      seq: 12,
      data: null,
    } as unknown as Parameters<typeof toSequencedSessionEvent>[0])

    expect(legacy).toMatchObject({ chatId: 'parent-chat', eventSeq: 12, type: 'consumed' })
    const session = createEmptySession('parent-chat')
    session.sync.eventSeq = 11
    if (!legacy) throw new Error('expected sequenced legacy notification')
    reduceSessionEvent(session, legacy, { now: 1 })
    reduceSessionEvent(
      session,
      {
        kind: 'session',
        type: 'turn.delta',
        chatId: 'parent-chat',
        eventSeq: 13,
        data: { turnId: 'turn-1', messageId: 'turn-1', channel: 'content', offset: 0, delta: 'ok' },
      },
      { now: 2 },
    )
    expect(session.messagesById['turn-1']?.content).toBe('ok')

    expect(
      toSequencedSessionEvent({
        kind: 'notification',
        type: 'done',
        chatId: 'parent-chat',
        data: null,
      }),
    ).toBeUndefined()
  })

  it('accepts sequenced legacy stream chunks without appending duplicate text', () => {
    const event = toSequencedSessionEvent({
      kind: 'chunk',
      type: 'stream',
      requestId: 'request-1',
      chatId: 'parent-chat',
      seq: 7,
      data: { delta: 'legacy duplicate' },
    } as unknown as Parameters<typeof toSequencedSessionEvent>[0])
    expect(event).toMatchObject({ eventSeq: 7, chatId: 'parent-chat' })
  })

  it('materializes an open-session active turn for the tree and CRT', () => {
    const session = createEmptySession('parent-chat')
    installActiveTurns(
      session,
      [{ turnId: 'turn-1', messageId: 'message-1', thinking: 'trace', content: 'partial' }],
      100,
    )

    expect(session.activeMessageId).toBe('message-1')
    expect(session.messageOrder).toEqual(['message-1'])
    expect(session.messagesById['message-1']).toMatchObject({
      role: 'assistant',
      thinking: 'trace',
      content: 'partial',
      status: 'streaming',
    })
  })
})
