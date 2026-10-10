import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import { createEmptySession } from '../../src/stores/chats/model/hydration'
import { agentApi } from '../../src/services/agentApi'
import { WsClient, wsClient } from '../../src/services/ws'
import {
  beginLiveRun,
  shouldResumeRoleReply,
  toSequencedSessionEvent,
  useChatSessionsStore,
} from '../../src/stores/chats'
import { installActiveTurns, reduce, reduceSessionEvent } from '../../src/stores/chats/model/reducer'
import { selectCanResume, selectIsWorking } from '../../src/stores/chats/read-model/selectors'

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
    const resume = vi.spyOn(agentApi, 'resumeRun').mockResolvedValue({
      chatId: 'parent-chat',
      commandId: 'resume-command',
      runId: 'resume-run',
      status: 'started',
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
      expect(resume).toHaveBeenCalledWith({
        chatId: 'parent-chat',
        commandId: expect.any(String),
      })
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

  it('does not expose the removed transport replay API', () => {
    const client = new WsClient()
    expect('isReplayEvent' in client).toBe(false)
    expect('replayEvents' in client).toBe(false)
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

  it('does not restore stale timing facts from replay after a newer event cursor', () => {
    const store = useChatSessionsStore()
    const session = store.ensureEntity('parent-chat')
    session.sync.eventSeq = 5
    session.executionSteps = [
      {
        id: 'new-turn',
        runId: 'new-run',
        chatId: 'parent-chat',
        kind: 'model',
        name: '模型响应',
        status: 'running',
        startedAt: 500,
      },
    ]

    store.applyEvent(
      'parent-chat',
      {
        kind: 'session',
        type: 'turn.started',
        chatId: 'parent-chat',
        eventSeq: 4,
        data: { turnId: 'old-turn', messageId: 'old-message', runId: 'old-run', createdAt: 100 },
      },
      'replay',
    )

    expect(session.sync.eventSeq).toBe(5)
    expect(session.executionSteps.map((step) => step.id)).toEqual(['new-turn'])
  })

  it('restores a running Pet response from one atomic chat.open snapshot', async () => {
    vi.spyOn(agentApi, 'listChats').mockResolvedValue([
      { chatId: 'running-chat', running: true, canResume: false },
    ])
    const open = vi.spyOn(agentApi, 'openChat').mockResolvedValue({
      chatId: 'running-chat',
      subscriptionId: 'subscription-1',
      eventSeq: 12,
      timelineRevision: 4,
      timelineChanged: false,
      state: {
        pendingInputs: [],
        run: { runId: 'run-1', status: 'running' },
        activeTurns: [
          {
            turnId: 'turn-1',
            runId: 'run-1',
            messageId: 'message-1',
            thinking: 'complete recovered thought',
            content: 'complete recovered response',
          },
        ],
      },
    })
    const store = useChatSessionsStore()

    await store.startup()

    expect(open).toHaveBeenCalledWith({
      scope: 'chat',
      chatId: 'running-chat',
      knownTimelineRevision: undefined,
      knownEventSeq: 0,
    })

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

  it('retracts a partial message by staged.reverse before rendering the clean retry', () => {
    const session = createEmptySession('parent-chat')
    session.activeTurns = [
      {
        turnId: 'failed-turn',
        runId: 'run-1',
        messageId: 'failed-turn',
        thinking: '',
        content: 'discarded partial',
        status: 'running',
      },
    ]

    reduce(
      session,
      {
        kind: 'chunk',
        type: 'stream',
        requestId: 'request-1',
        chatId: 'parent-chat',
        runId: 'run-1',
        data: { msgId: 'failed-turn', createdAt: 1, content: 'discarded partial' },
      },
      { now: 1 },
    )
    reduce(
      session,
      {
        kind: 'chunk',
        type: 'staged',
        requestId: 'request-1',
        chatId: 'parent-chat',
        runId: 'run-1',
        data: { type: 'reverse', messageIds: ['failed-turn'] },
      },
      { now: 2 },
    )

    expect(session.messagesById['failed-turn']?.status).toBe('revoked')
    expect(session.activeMessageId).toBeUndefined()
    expect(session.activeTurns).toEqual([])

    reduce(
      session,
      {
        kind: 'chunk',
        type: 'stream',
        requestId: 'request-1',
        chatId: 'parent-chat',
        runId: 'run-1',
        data: { msgId: 'clean-turn', createdAt: 3, content: 'clean result' },
      },
      { now: 3 },
    )
    reduce(
      session,
      {
        kind: 'notification',
        type: 'done',
        chatId: 'parent-chat',
        runId: 'run-1',
        data: {
          canResume: false,
          finalMessage: {
            msgId: 'clean-turn',
            role: 'assistant',
            content: 'clean result',
            createdAt: 3,
          },
        },
      },
      { now: 4 },
    )

    expect(session.messagesById['clean-turn']).toMatchObject({
      content: 'clean result',
      status: 'sealed',
    })
    expect(session.activeMessageId).toBeUndefined()
  })

  it('uses turn.cancelled to close the active turn and execution step', () => {
    const session = createEmptySession('parent-chat')
    session.activeTurns = [
      {
        turnId: 'failed-turn',
        runId: 'run-1',
        messageId: 'failed-turn',
        thinking: '',
        content: 'partial',
        status: 'running',
      },
    ]
    reduce(
      session,
      {
        kind: 'notification',
        type: 'turn.started',
        chatId: 'parent-chat',
        runId: 'run-1',
        data: {
          turnId: 'failed-turn',
          messageId: 'failed-turn',
          runId: 'run-1',
          createdAt: 10,
        },
      },
      { now: 10 },
    )
    reduce(
      session,
      {
        kind: 'chunk',
        type: 'stream',
        requestId: 'request-1',
        chatId: 'parent-chat',
        runId: 'run-1',
        data: { msgId: 'failed-turn', createdAt: 10, content: 'partial' },
      },
      { now: 11 },
    )
    reduce(
      session,
      {
        kind: 'notification',
        type: 'turn.cancelled',
        chatId: 'parent-chat',
        runId: 'run-1',
        data: {
          turnId: 'failed-turn',
          messageId: 'failed-turn',
          reason: 'retry_reset',
          cancelledAt: 12,
        },
      },
      { now: 12 },
    )

    expect(session.activeTurns).toEqual([])
    expect(session.activeMessageId).toBeUndefined()
    expect(session.messagesById['failed-turn']?.status).toBe('revoked')
    expect(session.executionSteps).toEqual([
      expect.objectContaining({ id: 'failed-turn', status: 'cancelled', completedAt: 12 }),
    ])

    const v2Session = createEmptySession('v2-chat')
    expect(
      reduceSessionEvent(
        v2Session,
        {
          kind: 'session',
          type: 'turn.started',
          chatId: 'v2-chat',
          runId: 'run-2',
          eventSeq: 1,
          data: {
            turnId: 'v2-failed-turn',
            messageId: 'v2-failed-turn',
            runId: 'run-2',
            createdAt: 20,
          },
        },
        { now: 20 },
      ),
    ).toBe(true)
    expect(
      reduceSessionEvent(
        v2Session,
        {
          kind: 'session',
          type: 'turn.cancelled',
          chatId: 'v2-chat',
          runId: 'run-2',
          eventSeq: 2,
          data: {
            turnId: 'v2-failed-turn',
            messageId: 'v2-failed-turn',
            reason: 'retry_reset',
            cancelledAt: 21,
          },
        },
        { now: 21 },
      ),
    ).toBe(true)
    expect(v2Session.activeTurns).toEqual([])
    expect(v2Session.messagesById['v2-failed-turn']?.status).toBe('revoked')
    expect(v2Session.executionSteps[0]).toMatchObject({ status: 'cancelled', completedAt: 21 })
  })
})
