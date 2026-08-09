import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { RootTimelineSnapshot, TimelineNode } from '../../../src/services/agentApi'
import {
  projectPersistentExecutionGraph,
  type ExecutionFoldMember,
  type ExecutionNode,
} from '../../../src/features/pets/nyxus/graph/executionGraph'
import {
  computeFoldRanges,
  projectFoldExecutionGraph,
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

function graph(nodes: TimelineNode[], activeRuns: RootTimelineSnapshot['activeRuns'] = []) {
  return projectPersistentExecutionGraph({ rootChatId, nodes, edges: [], activeRuns })
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
      expect(projected.graph.nodes.some((node) => node.id === 'message:done')).toBe(true)
      expect(projected.graph.nodes.some((node) => node.id === 'batch:done')).toBe(true)
      expect(projected.graph.nodes.some((node) => node.id === 'message:question')).toBe(true)
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
    expect(treeSource).toContain('props.folded\n    ? projectFoldExecutionGraph')
    expect(treeSource).not.toContain('node-detail-bookmark')
    expect(treeSource).not.toContain('class="fold-card"')
    expect(treeSource).toContain('class="node-fold-count"')
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
    expect(dialogSource).toContain(':folded="treeFolded"')
    expect(dialogSource).toContain('@click="treeFolded = !treeFolded"')
  })
})
