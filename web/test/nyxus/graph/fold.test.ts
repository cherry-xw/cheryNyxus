import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type {
  ExecutionEdgeFact,
  RootTimelineSnapshot,
  TimelineNode,
} from '../../../src/services/agentApi'
import {
  projectPersistentExecutionGraph,
  type ExecutionFoldMember,
  type ExecutionNode,
} from '../../../src/features/pets/nyxus/graph/executionGraph'
import {
  computeFoldRanges,
  computeFullFoldRanges,
  projectFoldExecutionGraph,
  projectFullFoldExecutionGraph,
  projectParticipantFoldExecutionGraph,
} from '../../../src/features/pets/nyxus/graph/foldProjection'
import { foldTabForMember, foldWheelView } from '../../../src/features/pets/nyxus/graph/foldTabs'
import {
  oppositePopoverPlacement,
  selectedToolCall,
} from '../../../src/features/pets/nyxus/graph/toolBatchDetails'

const rootChatId = 'root'

function message(
  id: string,
  orderKey: number,
  sourceChatId = rootChatId,
  partial: Partial<TimelineNode> = {},
): TimelineNode {
  return {
    id: `message:${id}`,
    rootChatId,
    sourceChatId,
    sourceMessageId: id,
    kind: 'message',
    actor: { kind: 'agent', chatId: sourceChatId },
    direction: 'agent-to-user',
    visibility: 'conversation',
    content: id,
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
    ...partial,
  }
}

function batch(
  id: string,
  orderKey: number,
  sourceChatId = rootChatId,
  partial: Partial<TimelineNode> = {},
): TimelineNode {
  return {
    id: `batch:${id}`,
    batchId: `batch:${id}`,
    rootChatId,
    sourceChatId,
    sourceMessageId: id,
    kind: 'tool-batch',
    actor: { kind: 'agent', chatId: sourceChatId },
    direction: 'internal',
    visibility: 'detail',
    content: '',
    toolCalls: [
      {
        callId: `call:${id}`,
        index: 0,
        name: `tool:${id}`,
        arguments: '{}',
        result: 'ok',
        status: 'completed',
      },
    ],
    orderKey,
    createdAt: orderKey,
    updatedAt: orderKey,
    status: 'committed',
    ...partial,
  }
}

function unit(id: string, orderKey: number, sourceChatId = rootChatId): TimelineNode[] {
  return [message(id, orderKey, sourceChatId), batch(id, orderKey + 1, sourceChatId)]
}

function graph(
  nodes: TimelineNode[],
  activeRuns: RootTimelineSnapshot['activeRuns'] = [],
  edges: ExecutionEdgeFact[] = [],
) {
  return projectPersistentExecutionGraph({ rootChatId, nodes, edges, activeRuns })
}

function member(node: ExecutionNode): ExecutionFoldMember {
  return { id: node.id, displayNode: node, nodes: [node] }
}

describe('Agent-local Fold projection', () => {
  it('always places the fold wheel opposite the content popover', () => {
    expect(oppositePopoverPlacement('left')).toBe('right')
    expect(oppositePopoverPlacement('right')).toBe('left')
  })
  it('keeps a single terminal member canonical, then creates Fold after the successor resolves', async () => {
    const fixture = JSON.parse(
      await readFile(resolve('test/fixtures/cp7-real-fold.json'), 'utf8'),
    ) as { snapshot: RootTimelineSnapshot }
    const activeCanonical = projectPersistentExecutionGraph(fixture.snapshot)
    const before = structuredClone(activeCanonical)
    const active = projectFoldExecutionGraph(activeCanonical)
    expect(active.ranges).toHaveLength(0)
    expect(active.graph.nodes.map((node) => node.id)).toEqual(
      expect.arrayContaining([
        'message:user-upstream',
        'message:assistant-a',
        'batch:assistant-a',
        'message:assistant-b',
        'batch:assistant-b',
      ]),
    )
    expect(activeCanonical).toEqual(before)

    const resolvedSnapshot = structuredClone(fixture.snapshot)
    resolvedSnapshot.activeRuns = resolvedSnapshot.activeRuns.map((run) => ({
      ...run,
      status: 'completed' as const,
    }))
    const activeCall = resolvedSnapshot.nodes
      .find((node) => node.id === 'batch:assistant-b')
      ?.toolCalls?.at(0)
    if (!activeCall) throw new Error('fixture is missing the active call')
    activeCall.status = 'completed'
    activeCall.result = '[REDACTED]'

    const resolved = projectFoldExecutionGraph(projectPersistentExecutionGraph(resolvedSnapshot))
    expect(resolved.ranges).toHaveLength(1)
    expect(resolved.ranges[0]).toMatchObject({
      id: 'fold:root-cp7-real:message:assistant-a',
    })
    expect(resolved.ranges[0]?.members.map((item) => item.id)).toEqual([
      'batch:assistant-a',
      'batch:assistant-b',
    ])
    expect(resolved.graph.nodes.some((node) => node.id === 'message:assistant-b')).toBe(false)
    expect(resolved.graph.nodes.some((node) => node.id === 'batch:assistant-b')).toBe(false)
  })

  it('computes independent folds for each Agent and never mixes their pages', () => {
    const ranges = computeFoldRanges(
      graph([...unit('root-a', 1), ...unit('child-a', 3, 'child'), ...unit('root-b', 5)]),
    )

    expect(ranges).toHaveLength(1)
    expect(
      ranges.map((range) => [range.sourceChatId, range.members.map((item) => item.id)]),
    ).toEqual([['root', ['batch:root-a', 'batch:root-b']]])
  })

  it('keeps user/upstream, return, spawn, termination and dispatch facts outside folds', () => {
    const upstream = message('upstream', 1, rootChatId, {
      actor: { kind: 'user', actorId: 'human' },
      target: { kind: 'agent', chatId: rootChatId },
      direction: 'user-to-agent',
    })
    const returned = message('return', 4, 'child', {
      kind: 'return',
      direction: 'agent-to-agent',
      target: { kind: 'agent', chatId: rootChatId },
    })
    const spawn = batch('spawn', 7, rootChatId, {
      toolCalls: [
        {
          callId: 'call:spawn',
          index: 0,
          name: 'spawn_agent',
          arguments: '{}',
          result: 'ok',
          status: 'completed',
          childChatId: 'child',
        },
      ],
    })
    const termination = message('termination', 10, rootChatId, {
      termination: { actor: 'system', code: 'system_stop', at: 10 },
    })
    const dispatch = message('dispatch', 13, rootChatId, {
      kind: 'dispatch',
      direction: 'agent-to-agent',
      visibility: 'internal',
      target: { kind: 'agent', chatId: 'child' },
    })
    const canonical = graph([
      upstream,
      ...unit('a', 2),
      returned,
      ...unit('b', 5),
      spawn,
      ...unit('c', 8),
      termination,
      ...unit('d', 11),
      dispatch,
      ...unit('e', 14),
    ])
    const projected = projectFoldExecutionGraph(canonical)
    const foldedIds = new Set(
      projected.ranges.flatMap((range) => range.nodes.map((node) => node.id)),
    )

    for (const id of [upstream.id, returned.id, spawn.id, termination.id, dispatch.id]) {
      expect(foldedIds.has(id)).toBe(false)
      expect(projected.graph.nodes.some((node) => node.id === id)).toBe(true)
    }
    expect(projected.ranges).toHaveLength(0)
  })

  it.each(['running', 'waiting', 'paused'] as const)(
    'keeps a %s approval/user-operation unit independent',
    (status) => {
      const pending = batch('question', 4, rootChatId, {
        toolCalls: [
          {
            callId: 'call:question',
            index: 0,
            name: 'request_user_input',
            arguments: '{}',
            status: 'accepted',
          },
        ],
      })
      const canonical = graph(
        [...unit('done', 1), message('question', 3), pending],
        [
          {
            rootChatId,
            chatId: rootChatId,
            runId: 'run:question',
            batchId: pending.id,
            status,
          },
        ],
      )
      const projected = projectFoldExecutionGraph(canonical)

      expect(projected.ranges).toHaveLength(0)
      expect(projected.graph.nodes.some((node) => node.id === 'message:done')).toBe(false)
      expect(projected.graph.nodes.some((node) => node.id === 'batch:done')).toBe(true)
      expect(projected.graph.nodes.some((node) => node.id === 'message:question')).toBe(false)
      expect(projected.graph.nodes.some((node) => node.id === 'batch:question')).toBe(true)
    },
  )

  it('folds completed, rejected and errored interactions after they resolve', () => {
    const nodes = ['completed', 'rejected', 'error'].flatMap((status, index) => {
      const id = `interaction-${status}`
      return [
        message(id, index * 2 + 1),
        batch(id, index * 2 + 2, rootChatId, {
          toolCalls: [
            {
              callId: `call:${id}`,
              index: 0,
              name: 'approval_tool',
              arguments: '{}',
              ...(status === 'completed' ? { result: 'ok' } : {}),
              status: status as 'completed' | 'rejected' | 'error',
            },
          ],
        }),
      ]
    })

    expect(computeFoldRanges(graph(nodes))[0]?.members.map((item) => item.id)).toEqual([
      'batch:interaction-completed',
      'batch:interaction-rejected',
      'batch:interaction-error',
    ])
  })

  it('assigns node-type skins and maps members onto the confirmed ellipse depth order', () => {
    const canonical = graph([
      batch('tool', 1),
      batch('question', 2, rootChatId, {
        toolCalls: [
          {
            callId: 'call:question',
            index: 0,
            name: 'request_user_input',
            arguments: '{}',
            result: 'answer',
            status: 'completed',
          },
        ],
      }),
      batch('interaction', 3, rootChatId, {
        toolCalls: [
          {
            callId: 'call:interaction',
            index: 0,
            name: 'approval_tool',
            arguments: '{}',
            status: 'pending',
          },
        ],
      }),
      batch('error', 4, rootChatId, {
        toolCalls: [
          {
            callId: 'call:error',
            index: 0,
            name: 'broken_tool',
            arguments: '{}',
            status: 'error',
          },
        ],
      }),
      message('agent', 5),
    ])
    const displayNodes = canonical.nodes.filter((node) => node.orderSlot === 'persistent')
    expect(displayNodes.map((node) => foldTabForMember(member(node)).kind)).toEqual([
      'tool',
      'question',
      'interaction',
      'error',
      'agent',
    ])

    const wheel = foldWheelView(
      Array.from({ length: 20 }, (_, index) => index),
      10,
    )
    const bySlot = new Map(wheel.slots.map((slot) => [slot.id, slot]))
    expect(wheel).toMatchObject({ selectedIndex: 10, layerIndex: 1, layerCount: 3 })
    expect(wheel.slots.map((slot) => slot.itemIndex)).toEqual([10, 9, 11, 8, 12, 7, 13, 6])
    expect(bySlot.get('E')).toMatchObject({ role: 'active', realContent: true, interactive: true })
    expect(bySlot.get('C')).toMatchObject({ role: 'adjacent', realContent: true })
    expect(bySlot.get('G')).toMatchObject({ role: 'adjacent', realContent: true })
    expect(bySlot.get('A')).toMatchObject({ role: 'transition', realContent: false })
    expect(bySlot.get('H')).toMatchObject({ role: 'transition', realContent: false })
    expect(bySlot.get('D')).toMatchObject({ role: 'back', realContent: false })
    expect(bySlot.get('E')!.z).toBeGreaterThan(bySlot.get('C')!.z)
    expect(bySlot.get('C')!.z).toBe(bySlot.get('G')!.z)
    expect(bySlot.get('C')!.z).toBeGreaterThan(bySlot.get('A')!.z)
    expect(bySlot.get('A')!.z).toBe(bySlot.get('H')!.z)
    expect(bySlot.get('A')!.z).toBeGreaterThan(bySlot.get('B')!.z)
    expect(bySlot.get('B')!.z).toBe(bySlot.get('F')!.z)
    expect(bySlot.get('B')!.z).toBeGreaterThan(bySlot.get('D')!.z)
    expect(Math.abs(bySlot.get('E')!.y - bySlot.get('C')!.y)).toBeLessThan(38)
    expect(Math.abs(bySlot.get('C')!.y - bySlot.get('A')!.y)).toBeLessThan(38)
    expect(wheel.slots.filter((slot) => slot.realContent).map((slot) => slot.id)).toEqual([
      'E',
      'C',
      'G',
    ])
    const rotated = foldWheelView(
      Array.from({ length: 20 }, (_, index) => index),
      11,
    )
    expect(rotated.slots.find((slot) => slot.item === 10)?.id).toBe('C')
    expect(rotated.slots.find((slot) => slot.item === 9)?.id).toBe('A')
    expect(rotated.slots.find((slot) => slot.item === 8)?.id).toBe('B')
    expect(rotated.slots.find((slot) => slot.item === 7)?.id).toBe('D')
    const smallWheel = foldWheelView(['current', 'previous'], 0)
    expect(smallWheel.slots.map((slot) => [slot.id, slot.item])).toEqual([
      ['E', 'current'],
      ['C', 'previous'],
    ])
  })

  it('preserves a selected secondary tool tab and otherwise picks active then first', () => {
    const calls = [
      { callId: 'done', index: 0, name: 'done', arguments: '{}', status: 'completed' as const },
      { callId: 'active', index: 1, name: 'active', arguments: '{}', status: 'accepted' as const },
    ]
    expect(selectedToolCall(calls, 'done')?.callId).toBe('done')
    expect(selectedToolCall(calls, 'missing')?.callId).toBe('active')
    expect(selectedToolCall([calls[0]!], 'missing')?.callId).toBe('done')
  })

  it('keeps the global graph canonical and renders Fold with the shared node skin plus wheel', async () => {
    const canonical = graph([...unit('a', 1), ...unit('b', 3)])
    const before = structuredClone(canonical)
    projectFoldExecutionGraph(canonical)
    expect(canonical).toEqual(before)

    const [treeSource, railSource, dialogSource] = await Promise.all([
      readFile(resolve('web/src/features/pets/nyxus/components/MessageBranchTree.vue'), 'utf8'),
      readFile(resolve('web/src/features/pets/nyxus/components/FoldTabRail.vue'), 'utf8'),
      readFile(resolve('web/src/features/agent/chat/AgentDialog.vue'), 'utf8'),
    ])
    expect(treeSource).toContain("props.foldMode === 'full'")
    expect(treeSource).toContain('projectFullFoldExecutionGraph')
    expect(treeSource).not.toContain('node-detail-bookmark')
    expect(treeSource).not.toContain('class="fold-card"')
    expect(treeSource).toContain('foldCount: node.fold.members.length')
    const rendererSource = await readFile(
      resolve('web/src/features/pets/nyxus/renderer/ExecutionGraphPixiRenderer.ts'),
      'utf8',
    )
    expect(rendererSource).toContain('if (node.foldCount)')
    expect(treeSource).toContain('<FoldTabRail')
    expect(railSource).not.toContain('fold-spine')
    expect(railSource).toContain('fold-wheel-navigation')
    expect(railSource).not.toContain('translate3d(')
    expect(railSource).not.toContain('scale(')
    expect(railSource).not.toContain('perspective:')
    expect(railSource).toContain('left 340ms cubic-bezier')
    expect(railSource).toContain('top 340ms cubic-bezier')
    expect(railSource).toContain('queuedSteps')
    expect(railSource).toContain('seamPoint')
    expect(railSource).not.toContain('while (Math.abs(wheelAccumulator)')
    expect(railSource).toContain('wheelAccumulator = 0\n  enqueueStep(direction)')
    expect(treeSource).toContain(':anchor-x="detailPlacement.nodeOffset.x"')
    expect(railSource).toContain('WHEEL_THRESHOLD')
    expect(railSource).toContain('PageDown')
    expect(railSource).toContain('@media (prefers-reduced-motion: reduce)')
    expect(dialogSource).toContain(':fold-mode="foldMode"')
    expect(dialogSource).toContain('selectFoldMode')
  })
})

describe('Full-fold projection', () => {
  function userMessage(id: string, orderKey: number, sourceChatId = rootChatId): TimelineNode {
    return message(id, orderKey, sourceChatId, {
      actor: { kind: 'user', actorId: 'human' },
      target: { kind: 'agent', chatId: sourceChatId },
      direction: 'user-to-agent',
    })
  }

  it('keeps only user messages and the final reply of each completed round', () => {
    const canonical = graph([
      userMessage('u1', 1),
      ...unit('tool-a', 2),
      message('reply-1', 4),
      userMessage('u2', 5),
      ...unit('tool-b', 6),
      message('reply-2', 8),
    ])
    const projected = projectFullFoldExecutionGraph(canonical)

    const visibleIds = new Set(projected.graph.nodes.map((node) => node.id))
    for (const keep of ['message:u1', 'message:reply-1', 'message:u2', 'message:reply-2']) {
      expect(visibleIds.has(keep)).toBe(true)
    }
    for (const hidden of ['message:tool-a', 'batch:tool-a', 'message:tool-b', 'batch:tool-b']) {
      expect(visibleIds.has(hidden)).toBe(false)
    }
    expect(projected.ranges).toHaveLength(2)
    expect(projected.ranges[0]!.nodes.map((n) => n.id)).toEqual(['batch:tool-a'])
    expect(projected.ranges[1]!.nodes.map((n) => n.id)).toEqual(['batch:tool-b'])
  })

  it('keeps a running round fully expanded', () => {
    const pending = batch('running', 3, rootChatId)
    const canonical = graph(
      [userMessage('u1', 1), message('intermediate', 2), pending, message('reply', 4)],
      [
        {
          rootChatId,
          chatId: rootChatId,
          runId: 'run:pending',
          batchId: pending.id,
          status: 'running',
        },
      ],
    )
    const projected = projectFullFoldExecutionGraph(canonical)

    expect(projected.ranges).toHaveLength(0)
    expect(projected.graph.nodes.some((n) => n.id === 'batch:running')).toBe(true)
  })

  it('does not fold a boundary-less leading segment', () => {
    const canonical = graph([...unit('a', 1), userMessage('u1', 3), message('reply', 4)])
    const projected = projectFullFoldExecutionGraph(canonical)

    expect(projected.ranges).toHaveLength(0)
    expect(projected.graph.nodes.some((n) => n.id === 'message:a')).toBe(false)
    expect(projected.graph.nodes.some((n) => n.id === 'batch:a')).toBe(true)
  })
})

describe('Participant fold projection', () => {
  function edge(
    id: string,
    orderKey: number,
    fromNodeId: string,
    toNodeId: string,
    kind: ExecutionEdgeFact['kind'],
    sourceChatId = rootChatId,
    targetChatId = sourceChatId,
  ): ExecutionEdgeFact {
    return {
      id,
      rootChatId,
      fromNodeId,
      toNodeId,
      kind,
      orderKey,
      sourceChatId,
      targetChatId,
    }
  }

  function userMessage(id: string, orderKey: number, sourceChatId = rootChatId): TimelineNode {
    return message(id, orderKey, sourceChatId, {
      actor: { kind: 'user', actorId: 'human' },
      target: { kind: 'agent', chatId: sourceChatId },
      direction: 'user-to-agent',
    })
  }

  function dispatchNode(orderKey: number): TimelineNode {
    return message('dispatch', orderKey, rootChatId, {
      kind: 'dispatch',
      direction: 'agent-to-agent',
      visibility: 'internal',
      target: { kind: 'agent', chatId: 'child' },
    })
  }

  function returnedNode(orderKey: number): TimelineNode {
    return message('return', orderKey, 'child', {
      kind: 'return',
      direction: 'agent-to-agent',
      target: { kind: 'agent', chatId: rootChatId },
    })
  }

  it('keeps dispatch/spawn/return and the final reply, but folds execution details', () => {
    const spawn = batch('spawn', 3, rootChatId, {
      toolCalls: [
        {
          callId: 'call:spawn',
          index: 0,
          name: 'spawn_agent',
          arguments: '{}',
          result: 'ok',
          status: 'completed',
          childChatId: 'child',
        },
      ],
    })
    const canonical = graph([
      userMessage('u1', 1),
      dispatchNode(2),
      spawn,
      returnedNode(4),
      ...unit('tool-a', 5),
      message('reply', 8),
    ])
    const projected = projectParticipantFoldExecutionGraph(canonical)
    const visibleIds = new Set(projected.graph.nodes.map((node) => node.id))

    for (const keep of [
      'message:u1',
      'message:dispatch',
      'batch:spawn',
      'message:return',
      'message:reply',
    ]) {
      expect(visibleIds.has(keep)).toBe(true)
    }
    for (const hidden of ['message:tool-a', 'batch:tool-a']) {
      expect(visibleIds.has(hidden)).toBe(false)
    }
    expect(projected.ranges).toHaveLength(1)
  })

  it('folds a sub-agent internal segment into the round fold card', () => {
    const canonical = graph([
      userMessage('u1', 1),
      dispatchNode(2),
      ...unit('child-work', 3, 'child'),
      returnedNode(6),
      message('reply', 7),
    ])
    const projected = projectParticipantFoldExecutionGraph(canonical)
    const visibleIds = new Set(projected.graph.nodes.map((node) => node.id))

    expect(visibleIds.has('message:dispatch')).toBe(true)
    expect(visibleIds.has('message:return')).toBe(true)
    expect(visibleIds.has('message:child-work')).toBe(false)
    expect(visibleIds.has('batch:child-work')).toBe(false)
    expect(projected.ranges).toHaveLength(1)
  })

  it('keeps fan-out and return convergence while folding every participant branch independently', () => {
    const spawn = batch('spawn-many', 4, rootChatId, {
      toolCalls: ['child-a', 'child-b'].map((childChatId, index) => ({
        callId: `call:spawn:${childChatId}`,
        index,
        name: 'spawn_agent',
        arguments: '{}',
        result: 'ok',
        status: 'completed' as const,
        childChatId,
      })),
    })
    const taskA = message('task-a', 5, 'child-a', {
      actor: { kind: 'agent', chatId: rootChatId },
      target: { kind: 'agent', chatId: 'child-a' },
      direction: 'parent-to-child',
    })
    const taskB = message('task-b', 6, 'child-b', {
      actor: { kind: 'agent', chatId: rootChatId },
      target: { kind: 'agent', chatId: 'child-b' },
      direction: 'parent-to-child',
    })
    const returnA = message('return-a', 11, 'child-a', {
      kind: 'return',
      direction: 'child-to-parent',
      target: { kind: 'agent', chatId: rootChatId },
    })
    const returnB = message('return-b', 12, 'child-b', {
      kind: 'return',
      direction: 'child-to-parent',
      target: { kind: 'agent', chatId: rootChatId },
    })
    const received = message('received', 13, rootChatId, {
      direction: 'child-to-parent',
    })
    const canonical = graph(
      [
        userMessage('u1', 1),
        ...unit('root-before-dispatch', 2),
        spawn,
        taskA,
        taskB,
        ...unit('child-a-work', 7, 'child-a'),
        ...unit('child-b-work', 9, 'child-b'),
        returnA,
        returnB,
        received,
        ...unit('root-after-return', 14),
        message('final', 16),
      ],
      [],
      [
        edge('u-to-pre', 101, 'message:u1', 'message:root-before-dispatch', 'sequence'),
        edge('pre-owner', 102, 'message:root-before-dispatch', 'batch:root-before-dispatch', 'sequence'),
        edge('pre-to-spawn', 103, 'batch:root-before-dispatch', 'batch:spawn-many', 'sequence'),
        edge('spawn-a', 104, 'batch:spawn-many', 'message:task-a', 'spawn', rootChatId, 'child-a'),
        edge('spawn-b', 105, 'batch:spawn-many', 'message:task-b', 'spawn', rootChatId, 'child-b'),
        edge('task-a-work', 106, 'message:task-a', 'message:child-a-work', 'sequence', 'child-a'),
        edge('child-a-owner', 107, 'message:child-a-work', 'batch:child-a-work', 'sequence', 'child-a'),
        edge('child-a-return', 108, 'batch:child-a-work', 'message:return-a', 'return', 'child-a', rootChatId),
        edge('task-b-work', 109, 'message:task-b', 'message:child-b-work', 'sequence', 'child-b'),
        edge('child-b-owner', 110, 'message:child-b-work', 'batch:child-b-work', 'sequence', 'child-b'),
        edge('child-b-return', 111, 'batch:child-b-work', 'message:return-b', 'return', 'child-b', rootChatId),
        edge('return-a-received', 112, 'message:return-a', 'message:received', 'return-continuation', 'child-a', rootChatId),
        edge('return-b-received', 113, 'message:return-b', 'message:received', 'return-continuation', 'child-b', rootChatId),
        edge('received-work', 114, 'message:received', 'message:root-after-return', 'sequence'),
        edge('root-after-owner', 115, 'message:root-after-return', 'batch:root-after-return', 'sequence'),
        edge('root-after-final', 116, 'batch:root-after-return', 'message:final', 'sequence'),
      ],
    )
    const projected = projectParticipantFoldExecutionGraph(canonical)
    const visibleIds = new Set(projected.graph.nodes.map((node) => node.id))

    for (const keep of [
      'message:u1',
      'batch:spawn-many',
      'message:task-a',
      'message:task-b',
      'message:return-a',
      'message:return-b',
      'message:received',
      'message:final',
    ]) {
      expect(visibleIds.has(keep)).toBe(true)
    }
    expect(
      projected.ranges.map((range) => [
        range.sourceChatId,
        range.nodes.map((node) => node.id),
      ]),
    ).toEqual([
      [rootChatId, ['batch:root-before-dispatch']],
      ['child-a', ['batch:child-a-work']],
      ['child-b', ['batch:child-b-work']],
      [rootChatId, ['batch:root-after-return']],
    ])
    expect(projected.graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          from: 'message:u1',
          to: 'participant-fold:root:batch:root-before-dispatch',
        }),
        expect.objectContaining({
          from: 'participant-fold:root:batch:root-before-dispatch',
          to: 'batch:spawn-many',
        }),
        expect.objectContaining({ from: 'batch:spawn-many', to: 'message:task-a' }),
        expect.objectContaining({ from: 'batch:spawn-many', to: 'message:task-b' }),
        expect.objectContaining({
          from: 'message:task-a',
          to: 'participant-fold:child-a:batch:child-a-work',
        }),
        expect.objectContaining({
          from: 'participant-fold:child-a:batch:child-a-work',
          to: 'message:return-a',
        }),
        expect.objectContaining({
          from: 'message:task-b',
          to: 'participant-fold:child-b:batch:child-b-work',
        }),
        expect.objectContaining({
          from: 'participant-fold:child-b:batch:child-b-work',
          to: 'message:return-b',
        }),
        expect.objectContaining({ from: 'message:return-a', to: 'message:received' }),
        expect.objectContaining({ from: 'message:return-b', to: 'message:received' }),
        expect.objectContaining({
          from: 'message:received',
          to: 'participant-fold:root:batch:root-after-return',
        }),
        expect.objectContaining({
          from: 'participant-fold:root:batch:root-after-return',
          to: 'message:final',
        }),
      ]),
    )
  })
})
