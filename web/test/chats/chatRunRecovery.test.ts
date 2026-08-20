import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptySession } from '../../src/stores/chats/hydration'
import { agentApi } from '../../src/services/agentApi'
import { wsClient } from '../../src/services/ws'
import {
  beginLiveRun,
  shouldResumeRoleReply,
  toSequencedSessionEvent,
  useChatSessionsStore,
} from '../../src/stores/chats'
import { installActiveTurns, reduceSessionEvent } from '../../src/stores/chats/reducer'
import { selectCanResume, selectIsWorking } from '../../src/stores/chats/selectors'

describe('chat live run recovery', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

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

    expect(shouldResumeRoleReply('replay')).toBe(false)
  })

  it('projects a recoverable chat catalog entry as paused for Workbench and Pet controls', () => {
    const store = useChatSessionsStore()
    store.initCatalog([{ chatId: 'recoverable-root', running: false, canResume: true }])

    const session = store.sessionsById['recoverable-root']!
    expect(session.run.status).toBe('paused')
    expect(selectIsWorking(session)).toBe(false)
    expect(selectCanResume(session)).toBe(true)
  })

  it('suppresses historical root role replies while preserving live auto-resume', () => {
    const resume = vi.spyOn(agentApi, 'resumeChat').mockReturnValue({
      requestId: 'resume-request',
      done: Promise.resolve({
        id: 'resume-response',
        kind: 'response',
        requestId: 'resume-request',
        success: true,
      }),
    })
    const store = useChatSessionsStore()
    store.ensureEntity('parent-chat')
    store.rootSubscriptions['parent-chat'] = {
      subscriptionId: 'root-subscription',
      eventSeq: 9,
    }
    store.bindWsClient()
    const deliver = (message: unknown): void => {
      ;(
        wsClient as unknown as { handleMessage: (event: MessageEvent) => void }
      ).handleMessage({ data: JSON.stringify(message) } as MessageEvent)
    }
    const roleReply = (rootEventSeq: number, msgId: string) => ({
      kind: 'notification',
      type: 'role_reply',
      chatId: 'parent-chat',
      rootChatId: 'parent-chat',
      rootEventSeq,
      eventSeq: rootEventSeq,
      subscriptionId: 'root-subscription',
      data: {
        parentChatId: 'parent-chat',
        childChatId: 'child-chat',
        type: 'coder',
        content: 'done',
        msgId,
      },
    })

    try {
      deliver(roleReply(9, 'historical-return'))
      expect(resume).not.toHaveBeenCalled()
      expect(store.sessionsById['parent-chat']?.messagesById['historical-return']).toBeDefined()

      deliver(roleReply(10, 'live-return'))
      expect(resume).toHaveBeenCalledTimes(1)
      expect(resume).toHaveBeenCalledWith('parent-chat')
    } finally {
      store.unbindWsClient()
    }
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
