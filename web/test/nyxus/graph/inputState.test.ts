import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RootTimelineSnapshot, TimelineNode } from '../../../src/services/agentApi'
import {
  createMainInputState,
  pendingInputAnchor,
  reduceMainInputState,
} from '../../../src/features/pets/nyxus/composables/mainInputState'
import {
  mainExecutionEndpoint,
  projectExecutionGraph,
  type ExecutionGraphSnapshot,
} from '../../../src/features/pets/nyxus/graph/executionGraph'
import { layoutExecutionGraph } from '../../../src/features/pets/nyxus/graph/executionLayout'
import {
  applyRootPatch,
  applyRootTransientEvent,
  createRootTransientState,
  installRootTimeline,
  readRootTimeline,
} from '../../../src/stores/chats/read-model/rootTimeline'

function node(id: string, orderKey: number, sourceChatId = 'root'): TimelineNode {
  return {
    id,
    rootChatId: 'root',
    sourceChatId,
    kind: 'message',
    actor: { kind: 'agent', chatId: sourceChatId },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content: id,
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
  }
}

function facts(nodes: TimelineNode[]): ExecutionGraphSnapshot {
  return { rootChatId: 'root', nodes, edges: [], activeRuns: [] }
}

describe('main input state machine', () => {
  it('walks idle → editing → pending → consuming → entity with one anchor', () => {
    let state = createMainInputState('draft:root')
    state = reduceMainInputState(state, { type: 'edit' })
    state = reduceMainInputState(state, {
      type: 'submit-accepted',
      inputId: 'input-1',
      messageId: 'message-1',
      content: 'hello',
    })
    expect(state).toMatchObject({ phase: 'pending', anchorKey: 'message-1' })
    state = reduceMainInputState(state, { type: 'claimed' })
    expect(state).toMatchObject({ phase: 'consuming', anchorKey: 'message-1' })
    state = reduceMainInputState(state, { type: 'committed' })
    expect(state).toMatchObject({ phase: 'entity', messageId: 'message-1', anchorKey: 'message-1' })
  })

  it('keeps editing and content on failure, while close resets the draft', () => {
    let state = reduceMainInputState(createMainInputState('draft:root'), { type: 'edit' })
    state = reduceMainInputState(state, {
      type: 'submit-failed',
      content: 'retry me',
      error: 'offline',
    })
    expect(state).toMatchObject({ phase: 'editing', content: 'retry me', error: 'offline' })
    expect(reduceMainInputState(state, { type: 'close' })).toEqual(
      createMainInputState('draft:root'),
    )
  })

  it('orders multiple running inputs after the true root endpoint and never a child terminal', () => {
    const graph = projectExecutionGraph(
      facts([node('root-tail', 1), node('child-tail', 2, 'child')]),
      [
        { id: 'message-2', content: 'second', createdAt: 4, state: 'pending', queueSequence: 2 },
        { id: 'message-1', content: 'first', createdAt: 3, state: 'pending', queueSequence: 1 },
      ],
    )
    expect(graph.nodes.slice(-2).map((item) => item.id)).toEqual(['message-1', 'message-2'])
    expect(graph.edges.slice(-2).map((edge) => [edge.from, edge.to])).toEqual([
      ['root-tail', 'message-1'],
      ['message-1', 'message-2'],
    ])
    expect(mainExecutionEndpoint(graph).id).toBe('message-2')
  })

  it('reuses graph id and coordinates when the pending fact becomes a committed entity', () => {
    const persistent = node('root-tail', 1)
    const pending = projectExecutionGraph(facts([persistent]), [
      { id: 'message-1', content: 'hello', createdAt: 2, state: 'consuming', queueSequence: 1 },
    ])
    const entity = node('message-1', 2)
    entity.actor = { kind: 'user', actorId: 'human' }
    entity.direction = 'user-to-agent'
    const committed = projectExecutionGraph(facts([persistent, entity]), [
      { id: 'message-1', content: 'hello', createdAt: 2, state: 'consuming', queueSequence: 1 },
    ])
    const pendingPosition = layoutExecutionGraph(pending).nodes.find(
      (item) => item.id === 'message-1',
    )
    const entityPosition = layoutExecutionGraph(committed).nodes.find(
      (item) => item.id === 'message-1',
    )
    expect(committed.nodes.filter((item) => item.id === 'message-1')).toHaveLength(1)
    expect(entityPosition).toMatchObject({ x: pendingPosition?.x, y: pendingPosition?.y })
  })
})

describe('real recovery fixture', () => {
  it('keeps a consumed input until the canonical node with the same messageId arrives', async () => {
    const fixture = JSON.parse(
      await readFile(resolve('test/fixtures/cp5-real-input-lifecycle.json'), 'utf8'),
    ) as {
      pending: {
        inputId: string
        messageId: string
        content: string
        queueSequence: number
        acceptedAt: number
      }
      entity: TimelineNode
    }
    expect(pendingInputAnchor(fixture.pending)).toBe(fixture.entity.id)

    const transient = createRootTransientState({
      pendingInputs: [{ ...fixture.pending, state: 'queued' }],
    })
    applyRootTransientEvent(transient, {
      chatId: fixture.entity.rootChatId,
      type: 'input.updated',
      data: {
        inputId: fixture.pending.inputId,
        messageId: fixture.pending.messageId,
        state: 'consumed',
      },
    })
    expect(transient.pendingInputs[0]?.state).toBe('consumed')

    const snapshot: RootTimelineSnapshot = {
      rootChatId: fixture.entity.rootChatId,
      view: 'tree',
      revision: 1,
      capturedEventSeq: 1,
      nodes: [],
      edges: [],
      activeRuns: [],
      pendingInputs: transient.pendingInputs,
    }
    const cache: Record<string, RootTimelineSnapshot> = {}
    installRootTimeline(cache, snapshot)
    expect(
      applyRootPatch(cache, {
        rootChatId: snapshot.rootChatId,
        view: 'tree',
        baseRevision: 1,
        revision: 2,
        operations: [{ type: 'upsert', node: { ...fixture.entity, orderKey: 1 } }],
      }),
    ).toBe('applied')
    expect(readRootTimeline(cache, snapshot.rootChatId, 'tree')?.pendingInputs).toEqual([])
  })
})
