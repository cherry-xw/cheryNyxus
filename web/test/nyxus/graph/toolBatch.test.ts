import { readFile } from 'node:fs/promises'
import { resolve } from 'node:path'
import { describe, expect, it } from 'vitest'
import type { GraphToolCall, RootTimelineSnapshot, TimelineNode } from '../../../src/services/agentApi'
import { projectPersistentExecutionGraph } from '../../../src/features/pets/nyxus/graph/executionGraph'
import {
  anchoredPopoverPosition,
  graphToolCallToSenseCall,
  orderedToolCalls,
  toolBatchDetail,
  toolBatchUsesTabs,
  toolBatchVisualStatus,
} from '../../../src/features/pets/nyxus/graph/toolBatchDetails'

function call(index: number, id: string, status: GraphToolCall['status'] = 'completed'): GraphToolCall {
  return { callId: id, index, name: id, arguments: '{}', status }
}

function batchNode(calls: GraphToolCall[]): TimelineNode {
  return {
    id: 'canonical-batch',
    batchId: 'canonical-batch',
    rootChatId: 'root',
    sourceChatId: 'root',
    sourceMessageId: 'assistant-1',
    kind: 'tool-batch',
    actor: { kind: 'agent', chatId: 'root' },
    direction: 'internal',
    visibility: 'detail',
    content: '',
    toolCalls: calls,
    orderKey: 1,
    createdAt: 1,
    updatedAt: 1,
    status: 'committed',
  }
}

function graphNode(calls: GraphToolCall[]) {
  return projectPersistentExecutionGraph({
    rootChatId: 'root',
    nodes: [batchNode(calls)],
    edges: [],
    activeRuns: [],
  }).nodes.find((node) => node.id === 'canonical-batch')!
}

describe('tool batch detail projection', () => {
  it('renders one call directly and enables tabs only for two or more calls', () => {
    expect(toolBatchUsesTabs([call(0, 'one')])).toBe(false)
    expect(toolBatchUsesTabs([call(0, 'one'), call(1, 'two')])).toBe(true)
  })

  it('orders tabs by canonical index and keeps batch/call identity across streaming updates', () => {
    const first = toolBatchDetail(graphNode([call(0, 'a', 'accepted')]))!
    const updated = toolBatchDetail(graphNode([call(1, 'b'), call(0, 'a')]))!
    expect(first.batchId).toBe(updated.batchId)
    expect(updated.calls.map((item) => item.callId)).toEqual(['a', 'b'])
    expect(updated.calls[0]).toMatchObject({ callId: first.calls[0]?.callId, index: 0 })
  })

  it('maps every protocol state to the node overlay and existing renderer contract', () => {
    expect(toolBatchVisualStatus([call(0, 'pending', 'pending')])).toBe('pending')
    expect(toolBatchVisualStatus([call(0, 'active', 'accepted')])).toBe('active')
    expect(toolBatchVisualStatus([call(0, 'done')])).toBe('completed')
    expect(toolBatchVisualStatus([call(0, 'rejected', 'rejected')])).toBe('rejected')
    expect(toolBatchVisualStatus([call(0, 'error', 'error')])).toBe('error')
    expect(graphToolCallToSenseCall(call(0, 'rejected', 'rejected')).status).toBe('error')
  })

  it('keeps the anchored overlay inside viewport and above the piano reserve', () => {
    expect(
      anchoredPopoverPosition({
        anchor: { x: 790, y: 590 },
        viewport: { width: 800, height: 700 },
        panel: { width: 360, height: 420 },
        reservedBottom: 160,
      }),
    ).toEqual({ left: 406, top: 110, placement: 'left' })
  })

  it('keeps a short panel beside a low anchor instead of dragging it to the viewport top', () => {
    // 回归：定位高度必须用实测矮高，不得用视口上限高度参与垂直钳制——
    // 否则 maxTop = viewport - 640 会把矮窗顶到视口顶部（「飘高」）。
    expect(
      anchoredPopoverPosition({
        anchor: { x: 400, y: 600 },
        viewport: { width: 1000, height: 700 },
        panel: { width: 480, height: 200 },
        margin: 12,
      }),
    ).toEqual({ left: 424, top: 488, placement: 'right' })
  })
})

describe('topology and real fixture', () => {
  it('preserves multi/nested spawn, continue and return paths and excludes rejected spawn edges', async () => {
    const fixture = JSON.parse(
      await readFile(resolve('test/fixtures/cp3-topology-matrix.json'), 'utf8'),
    ) as { snapshot: RootTimelineSnapshot }
    const graph = projectPersistentExecutionGraph(fixture.snapshot)
    const rootSpawnEdges = graph.edges
      .filter((edge) => edge.kind === 'spawn' && edge.from === 'root-spawn-batch')
      .sort((a, b) => (a.sourceFact?.callId ?? '').localeCompare(b.sourceFact?.callId ?? ''))
    expect(rootSpawnEdges.map((edge) => edge.sourceFact?.callId)).toEqual(['spawn-a', 'spawn-b'])
    expect(graph.edges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ kind: 'continue', from: 'root-spawn-batch', to: 'root-continue' }),
        expect.objectContaining({ kind: 'spawn', from: 'child-a-spawn-batch', to: 'grandchild-start' }),
        expect.objectContaining({ kind: 'return', from: 'grandchild-output', to: 'grandchild-return' }),
        expect.objectContaining({ kind: 'return-continuation', from: 'grandchild-return', to: 'child-a-continue' }),
      ]),
    )
    const rejected = batchNode([call(0, 'failed-spawn', 'rejected')])
    rejected.toolCalls![0]!.name = 'spawn_role'
    const rejectedGraph = projectPersistentExecutionGraph({
      rootChatId: 'root',
      nodes: [rejected],
      edges: [],
      activeRuns: [],
    })
    expect(rejectedGraph.edges.some((edge) => edge.kind === 'spawn')).toBe(false)
  })

  it('keeps real streaming spawn calls in index order without rebuilding the batch', async () => {
    const fixture = JSON.parse(
      await readFile(resolve('test/fixtures/cp6-real-tool-batch.json'), 'utf8'),
    ) as { batchId: string; streamStates: GraphToolCall[][] }
    const [initial, final] = fixture.streamStates
    expect(initial).toHaveLength(1)
    expect(orderedToolCalls(final).map((item) => item.callId)).toEqual([
      initial![0]!.callId,
      'toolu_tool-007f2732b9e64571aa2fca5d765c9223',
    ])
    expect(fixture.batchId).toBe('batch:9d6c4baf-ba5d-4c7e-afd6-2e1eb7cac57f')
  })

  it('isolates popover selection, scrolling and pointer gestures from the canvas', async () => {
    const source = await readFile(
      resolve('web/src/features/pets/nyxus/components/MessageBranchTree.vue'),
      'utf8',
    )
    expect(source).toContain('@pointerdown.stop')
    expect(source).toContain('@pointermove.stop')
    expect(source).toContain('@pointerup.stop')
    expect(source).toContain('@wheel.stop')
    expect(source).toContain('window.addEventListener(\'keydown\', onEscape)')
  })
})
