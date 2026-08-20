import { createPinia, setActivePinia } from 'pinia'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  agentApi,
  type ChatOpenResponse,
  type RootTimelineSnapshot,
} from '../../src/services/agentApi'
import { wsClient } from '../../src/services/ws'
import { useChatSessionsStore } from '../../src/stores/chats'

function snapshot(view: RootTimelineSnapshot['view']): RootTimelineSnapshot {
  return {
    rootChatId: 'root-live',
    view,
    revision: 1,
    capturedEventSeq: 9,
    nodes: [],
    edges: [],
    activeRuns: [],
    pendingInputs: [],
  }
}

function opened(): ChatOpenResponse {
  return {
    chatId: 'root-live',
    subscriptionId: 'subscription-live',
    eventSeq: 9,
    timelineRevision: 1,
    timelineChanged: true,
    rootTimeline: snapshot('conversation'),
    state: {
      chatIds: ['root-live'],
      pendingInputs: [],
      activeTurns: [],
      runs: [],
    },
  }
}

describe('Nyxus root message controller', () => {
  beforeEach(() => {
    setActivePinia(createPinia())
    vi.restoreAllMocks()
  })

  it('shares one root subscription across concurrent conversation and tree views', async () => {
    let resolveOpen: ((response: ChatOpenResponse) => void) | undefined
    const open = vi.spyOn(agentApi, 'openChat').mockImplementation(
      () =>
        new Promise<ChatOpenResponse>((resolve) => {
          resolveOpen = resolve
        }),
    )
    const getTimeline = vi.spyOn(agentApi, 'getRootTimeline').mockResolvedValue(snapshot('tree'))
    vi.spyOn(agentApi, 'closeChat').mockResolvedValue(undefined)

    const store = useChatSessionsStore()
    const tree = store.observeRootTimeline('root-live', 'tree')
    const conversation = store.observeRootTimeline('root-live', 'conversation')

    await Promise.resolve()
    expect(open).toHaveBeenCalledTimes(1)
    resolveOpen?.(opened())

    await expect(conversation).resolves.toMatchObject({ view: 'conversation' })
    await expect(tree).resolves.toMatchObject({ view: 'tree' })
    expect(open).toHaveBeenCalledTimes(1)
    expect(getTimeline).toHaveBeenCalledTimes(1)
    expect(store.rootSubscriptions['root-live']?.subscriptionId).toBe('subscription-live')
  })

  it('reuses the live subscription and installed tree without snapshot polling', async () => {
    const open = vi.spyOn(agentApi, 'openChat').mockResolvedValue(opened())
    const getTimeline = vi.spyOn(agentApi, 'getRootTimeline').mockResolvedValue(snapshot('tree'))
    vi.spyOn(agentApi, 'closeChat').mockResolvedValue(undefined)

    const store = useChatSessionsStore()
    await store.observeRootTimeline('root-live', 'tree')
    await store.observeRootTimeline('root-live', 'tree')

    expect(open).toHaveBeenCalledTimes(1)
    expect(getTimeline).toHaveBeenCalledTimes(1)
  })

  it('keeps late subscriptions for different roots independent', async () => {
    const resolvers = new Map<string, (response: ChatOpenResponse) => void>()
    vi.spyOn(agentApi, 'openChat').mockImplementation(
      ({ rootChatId }) =>
        new Promise<ChatOpenResponse>((resolve) => {
          resolvers.set(rootChatId!, resolve)
        }),
    )
    vi.spyOn(agentApi, 'getRootTimeline').mockImplementation(({ rootChatId, view }) =>
      Promise.resolve({ ...snapshot(view ?? 'conversation'), rootChatId }),
    )
    const close = vi.spyOn(agentApi, 'closeChat').mockResolvedValue(undefined)

    const store = useChatSessionsStore()
    const oldRoot = store.observeRootTimeline('root-old', 'conversation')
    await Promise.resolve()
    const newRoot = store.observeRootTimeline('root-new', 'conversation')
    await Promise.resolve()

    resolvers.get('root-new')?.({
      ...opened(),
      chatId: 'root-new',
      subscriptionId: 'subscription-new',
      rootTimeline: { ...snapshot('conversation'), rootChatId: 'root-new' },
    })
    await expect(newRoot).resolves.toMatchObject({ rootChatId: 'root-new' })

    resolvers.get('root-old')?.({
      ...opened(),
      chatId: 'root-old',
      subscriptionId: 'subscription-old',
      rootTimeline: { ...snapshot('conversation'), rootChatId: 'root-old' },
    })
    await expect(oldRoot).resolves.toMatchObject({ rootChatId: 'root-old' })
    expect(close).not.toHaveBeenCalled()
    expect(store.rootSubscriptions['root-old']?.subscriptionId).toBe('subscription-old')
    expect(store.rootSubscriptions['root-new']?.subscriptionId).toBe('subscription-new')
  })

  it('closes a root only after its final owner releases it', async () => {
    vi.spyOn(agentApi, 'openChat').mockResolvedValue(opened())
    vi.spyOn(agentApi, 'getRootTimeline').mockResolvedValue(snapshot('tree'))
    const close = vi.spyOn(agentApi, 'closeChat').mockResolvedValue(undefined)
    const store = useChatSessionsStore()

    await store.acquireRootTimeline('root-live', 'workbench:a', 'tree')
    await store.acquireRootTimeline('root-live', 'history-drawer', 'conversation')
    await store.releaseRootTimeline('root-live', 'workbench:a')
    expect(close).not.toHaveBeenCalled()
    expect(store.rootSubscriptions['root-live']).toBeDefined()

    await store.releaseRootTimeline('root-live', 'history-drawer')
    expect(close).toHaveBeenCalledWith('subscription-live')
    expect(store.rootSubscriptions['root-live']).toBeUndefined()
  })

  it('evicts deleted sessions, root projections and subscriptions together', async () => {
    vi.spyOn(agentApi, 'openChat').mockResolvedValue(opened())
    vi.spyOn(agentApi, 'getRootTimeline').mockResolvedValue(snapshot('tree'))
    const close = vi.spyOn(agentApi, 'closeChat').mockResolvedValue(undefined)
    const store = useChatSessionsStore()
    store.ensureCatalogEntity({
      chatId: 'root-live',
      preset: 'cheryNyxus',
      createdAt: 1,
      updatedAt: 1,
    })
    await store.acquireRootTimeline('root-live', 'workbench:a', 'tree')

    await store.evictSessions(['root-live'])

    expect(close).toHaveBeenCalledWith('subscription-live')
    expect(store.sessionsById['root-live']).toBeUndefined()
    expect(store.rootSubscriptions['root-live']).toBeUndefined()
    expect(store.rootTimelineStates['root-live']).toBeUndefined()
    expect(store.rootTimeline('root-live', 'conversation')).toBeUndefined()
    expect(store.rootTimeline('root-live', 'tree')).toBeUndefined()
  })

  it('applies a root input event without opening a direct session for its source cursor', async () => {
    const open = vi.spyOn(agentApi, 'openChat').mockResolvedValue(opened())
    vi.spyOn(agentApi, 'getRootTimeline').mockResolvedValue(snapshot('tree'))
    vi.spyOn(agentApi, 'closeChat').mockResolvedValue(undefined)
    const store = useChatSessionsStore()
    await store.observeRootTimeline('root-live', 'tree')
    open.mockClear()
    store.bindWsClient()

    try {
      const dispatch = wsClient as unknown as {
        dispatchEvent(message: unknown, kind: unknown): void
      }
      dispatch.dispatchEvent(
        {
          kind: 'notification',
          type: 'input.updated',
          chatId: 'root-live',
          rootChatId: 'root-live',
          rootEventSeq: 10,
          sourceEventSeq: 999,
          subscriptionId: 'subscription-live',
          data: {
            inputId: 'input-live',
            messageId: 'message-live',
            content: 'hello',
            state: 'accepted',
          },
        },
        'notification',
      )

      expect(open).not.toHaveBeenCalled()
      expect(store.rootTimelineStates['root-live']?.pendingInputs).toEqual([
        expect.objectContaining({ inputId: 'input-live', content: 'hello' }),
      ])
      expect(store.sessionsById['root-live']?.sync.resyncRequired).not.toBe(true)
    } finally {
      store.unbindWsClient()
    }
  })

  it('batches contiguous root turn deltas into one reactive publish window', async () => {
    vi.useFakeTimers()
    vi.spyOn(agentApi, 'openChat').mockResolvedValue(opened())
    vi.spyOn(agentApi, 'closeChat').mockResolvedValue(undefined)
    const store = useChatSessionsStore()
    await store.observeRootTimeline('root-live', 'conversation')
    store.bindWsClient()

    try {
      const dispatch = wsClient as unknown as {
        dispatchEvent(message: unknown, kind: unknown): void
      }
      const rootEvent = (rootEventSeq: number, type: string, data: unknown) =>
        dispatch.dispatchEvent(
          {
            kind: 'notification',
            chatId: 'root-live',
            rootChatId: 'root-live',
            rootEventSeq,
            subscriptionId: 'subscription-live',
            type,
            data,
          },
          'notification',
        )

      rootEvent(10, 'turn.started', { turnId: 'turn-live', messageId: 'message-live' })
      rootEvent(11, 'turn.delta', {
        turnId: 'turn-live',
        channel: 'content',
        offset: 0,
        delta: 'hello',
      })
      rootEvent(12, 'turn.delta', {
        turnId: 'turn-live',
        channel: 'content',
        offset: 5,
        delta: ' world',
      })

      expect(store.rootSubscriptions['root-live']?.eventSeq).toBe(12)
      expect(store.rootTimelineStates['root-live']?.activeTurns[0]?.content).toBe('')
      await vi.advanceTimersByTimeAsync(63)
      expect(store.rootTimelineStates['root-live']?.activeTurns[0]?.content).toBe('')
      await vi.advanceTimersByTimeAsync(1)
      expect(store.rootTimelineStates['root-live']?.activeTurns[0]?.content).toBe('hello world')
    } finally {
      store.unbindWsClient()
      vi.useRealTimers()
    }
  })

  it('flushes queued root deltas before applying the next structural event', async () => {
    vi.useFakeTimers()
    vi.spyOn(agentApi, 'openChat').mockResolvedValue(opened())
    vi.spyOn(agentApi, 'closeChat').mockResolvedValue(undefined)
    const store = useChatSessionsStore()
    await store.observeRootTimeline('root-live', 'conversation')
    store.bindWsClient()

    try {
      const dispatch = wsClient as unknown as {
        dispatchEvent(message: unknown, kind: unknown): void
      }
      const rootEvent = (rootEventSeq: number, type: string, data: unknown) =>
        dispatch.dispatchEvent(
          {
            kind: 'notification',
            chatId: 'root-live',
            rootChatId: 'root-live',
            rootEventSeq,
            subscriptionId: 'subscription-live',
            type,
            data,
          },
          'notification',
        )

      rootEvent(10, 'turn.started', { turnId: 'turn-live', messageId: 'message-live' })
      rootEvent(11, 'turn.delta', {
        turnId: 'turn-live',
        channel: 'content',
        offset: 0,
        delta: 'complete before status',
      })
      rootEvent(12, 'run.updated', { runId: 'run-live', status: 'running' })

      expect(store.rootTimelineStates['root-live']?.activeTurns[0]?.content).toBe(
        'complete before status',
      )
      expect(store.rootTimelineStates['root-live']?.activeRuns[0]?.runId).toBe('run-live')
      expect(vi.getTimerCount()).toBe(0)
    } finally {
      store.unbindWsClient()
      vi.useRealTimers()
    }
  })

  it('ignores patches for uncached views without reopening the root subscription', async () => {
    const open = vi.spyOn(agentApi, 'openChat').mockResolvedValue(opened())
    const getTimeline = vi.spyOn(agentApi, 'getRootTimeline').mockResolvedValue(snapshot('tree'))
    const close = vi.spyOn(agentApi, 'closeChat').mockResolvedValue(undefined)
    const store = useChatSessionsStore()
    await store.observeRootTimeline('root-live', 'tree')
    store.bindWsClient()

    try {
      const dispatch = wsClient as unknown as {
        dispatchEvent(message: unknown, kind: unknown): void
      }
      dispatch.dispatchEvent(
        {
          kind: 'notification',
          type: 'timeline.patch',
          chatId: 'root-live',
          rootChatId: 'root-live',
          rootEventSeq: 10,
          subscriptionId: 'subscription-live',
          data: {
            rootPatches: [
              {
                rootChatId: 'root-live',
                view: 'audit',
                baseRevision: 1,
                revision: 2,
                operations: [],
              },
            ],
          },
        },
        'notification',
      )
      await Promise.resolve()

      expect(open).toHaveBeenCalledTimes(1)
      expect(close).not.toHaveBeenCalled()
      expect(getTimeline).toHaveBeenCalledTimes(1)
      expect(store.rootSubscriptions['root-live']).toMatchObject({
        subscriptionId: 'subscription-live',
        eventSeq: 10,
      })
    } finally {
      store.unbindWsClient()
    }
  })

  it('refreshes only a cached view on revision gap without reopening the subscription', async () => {
    const open = vi.spyOn(agentApi, 'openChat').mockResolvedValue(opened())
    let treeRevision = 1
    const getTimeline = vi.spyOn(agentApi, 'getRootTimeline').mockImplementation(({ view }) =>
      Promise.resolve({
        ...snapshot(view ?? 'conversation'),
        revision: view === 'tree' ? treeRevision : 1,
      }),
    )
    const close = vi.spyOn(agentApi, 'closeChat').mockResolvedValue(undefined)
    const store = useChatSessionsStore()
    await store.observeRootTimeline('root-live', 'tree')
    treeRevision = 6
    store.bindWsClient()

    try {
      const dispatch = wsClient as unknown as {
        dispatchEvent(message: unknown, kind: unknown): void
      }
      dispatch.dispatchEvent(
        {
          kind: 'notification',
          type: 'timeline.patch',
          chatId: 'root-live',
          rootChatId: 'root-live',
          rootEventSeq: 10,
          subscriptionId: 'subscription-live',
          data: {
            rootPatches: [
              {
                rootChatId: 'root-live',
                view: 'tree',
                baseRevision: 5,
                revision: 6,
                operations: [],
              },
              {
                rootChatId: 'root-live',
                view: 'audit',
                baseRevision: 5,
                revision: 6,
                operations: [],
              },
            ],
          },
        },
        'notification',
      )

      await vi.waitFor(() => expect(getTimeline).toHaveBeenCalledTimes(2))
      expect(open).toHaveBeenCalledTimes(1)
      expect(close).not.toHaveBeenCalled()
      expect(store.rootTimeline('root-live', 'tree')?.revision).toBe(6)
      expect(store.rootSubscriptions['root-live']?.subscriptionId).toBe('subscription-live')
    } finally {
      store.unbindWsClient()
    }
  })
})
