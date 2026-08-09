import { describe, expect, it } from 'vitest'
import type { RootTimelineSnapshot } from '../../src/services/agentApi'
import {
  applyRootPatch,
  applyRootTransientEvent,
  createRootTransientState,
  effectiveRootLiveState,
  installRootTimeline,
  readRootTimeline,
  runSingleFlight,
} from '../../src/stores/chats/rootTimeline'
import { createEmptySession } from '../../src/stores/chats/hydration'

function snapshot(view: RootTimelineSnapshot['view'], revision = 1): RootTimelineSnapshot {
  return {
    rootChatId: 'root',
    view,
    revision,
    capturedEventSeq: 4,
    nodes: [],
    edges: [],
    activeRuns: [],
    pendingInputs: [],
  }
}

describe('RootTimelineStore', () => {
  it('keeps a live turn visible when the root transient plane is temporarily empty', () => {
    const root = createEmptySession('root')
    root.activeTurns = [
      {
        turnId: 'turn-1',
        runId: 'run-1',
        messageId: 'message-1',
        thinking: 'live',
        content: '',
        status: 'running',
        createdAt: 1,
      },
    ]
    root.activeRun = { runId: 'run-1', status: 'running' }
    const unrelated = createEmptySession('other-root')
    unrelated.activeTurns = [
      {
        turnId: 'other-turn',
        runId: 'other-run',
        messageId: 'other-message',
        thinking: '',
        content: 'must not leak',
        status: 'running',
      },
    ]

    expect(
      effectiveRootLiveState('root', createRootTransientState(), {
        root,
        'other-root': unrelated,
      }),
    ).toEqual({
      activeTurns: [
        expect.objectContaining({
          chatId: 'root',
          runId: 'run-1',
          messageId: 'message-1',
          thinking: 'live',
        }),
      ],
      activeRuns: [expect.objectContaining({ chatId: 'root', runId: 'run-1' })],
    })
  })

  it('does not resurrect a session turn after the root plane completed it', () => {
    const root = createEmptySession('root')
    root.activeTurns = [
      {
        turnId: 'turn-1',
        runId: 'run-1',
        messageId: 'message-1',
        thinking: 'stale',
        content: '',
        status: 'running',
      },
    ]
    root.activeRun = { runId: 'run-1', status: 'running' }
    const rootState = createRootTransientState()
    applyRootTransientEvent(rootState, {
      chatId: 'root',
      type: 'turn.started',
      data: { turnId: 'turn-1', runId: 'run-1', messageId: 'message-1' },
    })
    applyRootTransientEvent(rootState, {
      chatId: 'root',
      type: 'turn.completed',
      data: { turnId: 'turn-1', messageId: 'message-1' },
    })

    expect(effectiveRootLiveState('root', rootState, { root })).toEqual({
      activeTurns: [],
      activeRuns: [],
    })
  })

  it('coalesces concurrent gap recovery into one resync', async () => {
    const flights = new Map<string, Promise<number>>()
    let calls = 0
    let release: ((value: number) => void) | undefined
    const task = () => {
      calls += 1
      return new Promise<number>((resolve) => {
        release = resolve
      })
    }

    const first = runSingleFlight(flights, 'root', task)
    const second = runSingleFlight(flights, 'root', task)
    expect(calls).toBe(1)
    release?.(7)
    await expect(first).resolves.toBe(7)
    await expect(second).resolves.toBe(7)
    expect(flights.size).toBe(0)
  })

  it('isolates conversation, tree and audit snapshots by view', () => {
    const cache: Record<string, RootTimelineSnapshot> = {}
    installRootTimeline(cache, snapshot('conversation'))
    installRootTimeline(cache, snapshot('tree', 2))

    expect(readRootTimeline(cache, 'root', 'conversation')?.view).toBe('conversation')
    expect(readRootTimeline(cache, 'root', 'tree')?.revision).toBe(2)
    expect(readRootTimeline(cache, 'root', 'audit')).toBeUndefined()
  })

  it('rejects a revision gap without mutating the installed snapshot', () => {
    const cache: Record<string, RootTimelineSnapshot> = {}
    installRootTimeline(cache, snapshot('conversation', 3))

    expect(
      applyRootPatch(cache, {
        rootChatId: 'root',
        view: 'conversation',
        baseRevision: 4,
        revision: 5,
        operations: [],
      }),
    ).toBe('gap')
    expect(readRootTimeline(cache, 'root', 'conversation')?.revision).toBe(3)
  })

  it('reports a patch for an unopened view as missing so callers can resync it', () => {
    const cache: Record<string, RootTimelineSnapshot> = {}
    installRootTimeline(cache, snapshot('conversation', 1))

    expect(
      applyRootPatch(cache, {
        rootChatId: 'root',
        view: 'tree',
        baseRevision: 0,
        revision: 1,
        operations: [],
      }),
    ).toBe('missing')
    expect(readRootTimeline(cache, 'root', 'tree')).toBeUndefined()
  })

  it('applies graph operations atomically and treats a repeated patch as idempotent', () => {
    const cache: Record<string, RootTimelineSnapshot> = {}
    installRootTimeline(cache, snapshot('tree', 1))
    const patch = {
      rootChatId: 'root',
      view: 'tree' as const,
      baseRevision: 1,
      revision: 2,
      operations: [
        {
          type: 'upsert' as const,
          node: {
            id: 'node-1',
            rootChatId: 'root',
            sourceChatId: 'root',
            kind: 'message' as const,
            actor: { kind: 'agent' as const, chatId: 'root' },
            direction: 'agent-to-user' as const,
            visibility: 'conversation' as const,
            content: 'hello',
            orderKey: 1,
            createdAt: 1,
            updatedAt: 1,
            status: 'committed' as const,
          },
        },
        {
          type: 'upsert-edge' as const,
          edge: {
            id: 'edge-1',
            rootChatId: 'root',
            fromNodeId: 'node-1',
            toNodeId: 'node-2',
            kind: 'continue' as const,
            orderKey: 2,
            sourceChatId: 'root',
            targetChatId: 'root',
          },
        },
        {
          type: 'upsert-run' as const,
          run: {
            rootChatId: 'root',
            chatId: 'root',
            runId: 'run-1',
            status: 'running' as const,
            nodeId: 'node-1',
          },
        },
      ],
    }

    expect(applyRootPatch(cache, patch)).toBe('applied')
    expect(applyRootPatch(cache, patch)).toBe('duplicate')
    expect(readRootTimeline(cache, 'root', 'tree')).toMatchObject({
      revision: 2,
      nodes: [{ id: 'node-1' }],
      edges: [{ id: 'edge-1' }],
      activeRuns: [{ runId: 'run-1', nodeId: 'node-1' }],
    })
    expect(
      applyRootPatch(cache, {
        rootChatId: 'root',
        view: 'tree',
        baseRevision: 2,
        revision: 3,
        operations: [
          { type: 'revoke', nodeId: 'node-1' },
          { type: 'remove-edge', edgeId: 'edge-1' },
          { type: 'remove-run', chatId: 'root', runId: 'run-1' },
        ],
      }),
    ).toBe('applied')
    expect(readRootTimeline(cache, 'root', 'tree')).toMatchObject({
      nodes: [{ id: 'node-1', status: 'revoked' }],
      edges: [],
      activeRuns: [],
    })
  })

  it('keeps pending, active turn and run identities stable until terminal events', () => {
    const state = createRootTransientState()
    applyRootTransientEvent(state, {
      chatId: 'child',
      type: 'input.updated',
      data: {
        inputId: 'input-1',
        messageId: 'message-1',
        content: 'hello',
        state: 'queued',
      },
    })
    applyRootTransientEvent(state, {
      chatId: 'child',
      type: 'run.updated',
      data: { runId: 'run-1', status: 'running' },
    })
    applyRootTransientEvent(state, {
      chatId: 'child',
      type: 'turn.started',
      data: { turnId: 'turn-1', messageId: 'message-2', runId: 'run-1' },
    })
    applyRootTransientEvent(state, {
      chatId: 'child',
      type: 'turn.delta',
      data: { turnId: 'turn-1', channel: 'content', offset: 0, delta: 'partial' },
    })

    expect(state.pendingInputs[0]).toMatchObject({ chatId: 'child', messageId: 'message-1' })
    expect(state.activeTurns[0]).toMatchObject({ chatId: 'child', content: 'partial' })
    expect(state.activeRuns[0]).toMatchObject({ chatId: 'child', runId: 'run-1' })

    applyRootTransientEvent(state, {
      chatId: 'child',
      type: 'input.updated',
      data: { inputId: 'input-1', state: 'consumed' },
    })
    applyRootTransientEvent(state, {
      chatId: 'child',
      type: 'turn.completed',
      data: { turnId: 'turn-1', messageId: 'message-2' },
    })
    applyRootTransientEvent(state, {
      chatId: 'child',
      type: 'run.updated',
      data: { runId: 'run-1', status: 'completed' },
    })

    expect(state.pendingInputs).toEqual([
      expect.objectContaining({ inputId: 'input-1', messageId: 'message-1', state: 'consumed' }),
    ])
    expect(state.activeTurns).toEqual([])
    expect(state.activeRuns).toEqual([])
  })

  it('rekeys a provisional input in place by clientMessageId', () => {
    const state = createRootTransientState({
      pendingInputs: [
        {
          inputId: 'optimistic-input:client-1',
          clientMessageId: 'client-1',
          messageId: 'message-1',
          content: 'hello',
          state: 'accepted',
        },
      ],
    })

    applyRootTransientEvent(state, {
      chatId: 'root',
      type: 'input.updated',
      data: {
        inputId: 'input-1',
        clientMessageId: 'client-1',
        messageId: 'message-1',
        content: 'hello',
        state: 'started',
      },
    })

    expect(state.pendingInputs).toEqual([
      expect.objectContaining({
        inputId: 'input-1',
        clientMessageId: 'client-1',
        messageId: 'message-1',
      }),
    ])
  })
})
