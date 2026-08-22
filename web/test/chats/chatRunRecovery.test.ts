import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptySession } from '../../src/stores/chats/hydration'
import { agentApi } from '../../src/services/agentApi'
import { WsClient, wsClient } from '../../src/services/ws'
import {
  beginLiveRun,
  shouldResumeRoleReply,
  toSequencedSessionEvent,
  useChatSessionsStore,
} from '../../src/stores/chats'
import { installActiveTurns, reduce, reduceSessionEvent } from '../../src/stores/chats/reducer'
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

  it('marks chat.sync envelopes as replay provenance for every store consumer', () => {
    const client = new WsClient()
    const internals = client as unknown as {
      pending: Map<string, { request: { id: string; kind: 'request'; method: string; params: unknown } }>
      handleMessage: (event: MessageEvent) => void
    }
    internals.pending.set('sync-request', {
      request: { id: 'sync-request', kind: 'request', method: 'chat.sync', params: {} },
    })
    let observed: unknown
    const stop = client.onNotification((event) => {
      observed = event
    })

    try {
      internals.handleMessage({
        data: JSON.stringify({
          kind: 'notification',
          type: 'turn.delta',
          requestId: 'sync-request',
          chatId: 'parent-chat',
          data: { turnId: 'turn-1', messageId: 'message-1', delta: 'old' },
        }),
      } as MessageEvent)
      expect(client.isReplayEvent(observed)).toBe(true)
    } finally {
      stop()
    }
  })

  it('advances replayed turn events without exposing them to the Pet bubble', () => {
    const store = useChatSessionsStore()
    const session = store.ensureEntity('parent-chat')

    store.applyEvent(
      'parent-chat',
      {
        kind: 'session',
        type: 'turn.started',
        chatId: 'parent-chat',
        eventSeq: 1,
        data: { turnId: 'old-turn', messageId: 'old-message', runId: 'old-run' },
      },
      'replay',
    )
    store.applyEvent(
      'parent-chat',
      {
        kind: 'session',
        type: 'turn.delta',
        chatId: 'parent-chat',
        eventSeq: 2,
        data: {
          turnId: 'old-turn',
          messageId: 'old-message',
          channel: 'content',
          offset: 0,
          delta: 'historical response',
        },
      },
      'replay',
    )

    expect(session.sync.eventSeq).toBe(2)
    expect(session.activeTurns).toEqual([])
    expect(session.activeMessageId).toBeUndefined()
    expect(session.messagesById['old-message']).toBeUndefined()
    expect(session.run.retainUntil).toBeUndefined()
  })

  it('restores a running Pet response from one attach snapshot', async () => {
    vi.spyOn(agentApi, 'listChats').mockResolvedValue([
      { chatId: 'running-chat', running: true, canResume: false },
    ])
    vi.spyOn(agentApi, 'attachChat').mockResolvedValue({
      chatId: 'running-chat',
      running: true,
      attached: true,
      runId: 'run-1',
      snapshotSeq: 12,
      pendingQuestionBatches: [],
      activeTurns: [
        {
          turnId: 'turn-1',
          runId: 'run-1',
          messageId: 'message-1',
          thinking: 'complete recovered thought',
          content: 'complete recovered response',
        },
      ],
    })
    const store = useChatSessionsStore()

    await store.startup()

    const session = store.sessionsById['running-chat']!
    expect(session.run).toMatchObject({ status: 'running', activeRunId: 'run-1' })
    expect(session.activeTurns).toHaveLength(1)
    expect(session.messagesById['message-1']).toMatchObject({
      thinking: 'complete recovered thought',
      content: 'complete recovered response',
      status: 'streaming',
    })
  })

  it('clears residual active turns when the run reaches a terminal state', () => {
    const session = createEmptySession('parent-chat')
    session.activeTurns = [
      {
        turnId: 'turn-1',
        runId: 'run-1',
        messageId: 'message-1',
        thinking: 'partial',
        content: '',
        status: 'running',
      },
    ]
    session.run.status = 'running'
    session.run.activeRunId = 'run-1'

    reduceSessionEvent(
      session,
      {
        kind: 'session',
        type: 'run.updated',
        chatId: 'parent-chat',
        eventSeq: 1,
        data: { runId: 'run-1', status: 'completed' },
      },
      { now: 1 },
    )

    expect(session.activeTurns).toEqual([])
    expect(session.run).toMatchObject({ status: 'ended', activeRunId: undefined })

    session.activeTurns = [
      {
        turnId: 'turn-2',
        runId: 'run-2',
        messageId: 'message-2',
        thinking: '',
        content: 'partial',
        status: 'running',
      },
    ]
    session.run.status = 'running'
    session.run.activeRunId = 'run-2'
    reduce(
      session,
      {
        kind: 'notification',
        type: 'done',
        chatId: 'parent-chat',
        runId: 'run-2',
        data: { canResume: false },
      },
      { now: 2 },
    )

    expect(session.activeTurns).toEqual([])
    expect(session.run).toMatchObject({ status: 'ended', activeRunId: undefined })
  })

  it('applies a replayed done over an event gap so canonical status does not stick at running', () => {
    const store = useChatSessionsStore()
    const session = store.ensureEntity('parent-chat')
    session.sync.replaying = false
    session.run.status = 'running'
    session.run.activeRunId = 'run-3'

    // event-gap replay：rootEventSeq 跳号后 done 判 replay，但仍须封印终态（幂等），
    // 否则 canonical run.status 残留 running → 工作台误显「运行中/暂停」
    store.applyEvent(
      'parent-chat',
      {
        kind: 'notification',
        type: 'done',
        chatId: 'parent-chat',
        runId: 'run-3',
        data: { canResume: false },
      },
      'replay',
    )

    expect(session.run.status).toBe('ended')
    expect(session.run.activeRunId).toBeUndefined()
  })

  it('keeps skipping replayed non-terminal notifications during historical chat.sync replay', () => {
    const store = useChatSessionsStore()
    const session = store.ensureEntity('parent-chat')
    session.sync.replaying = true
    session.run.status = 'running'

    store.applyEvent(
      'parent-chat',
      {
        kind: 'notification',
        type: 'consumed',
        chatId: 'parent-chat',
        data: null,
      },
      'replay',
    )

    expect(session.run.status).toBe('running')
  })
})
