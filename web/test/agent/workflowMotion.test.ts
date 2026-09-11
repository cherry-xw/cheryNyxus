import { describe, expect, it, vi } from 'vitest'
import {
  planWorkflowMotion,
  selectWorkflowMotionLoops,
  shouldLoopWorkflowMotion,
  WorkflowMotionRegistry,
  type WorkflowMotionContext,
  type WorkflowMotionItem,
} from '../../src/features/agent/workbench/runtime-diagram/motionPolicy'

function item(
  occurrenceId: string,
  overrides: Partial<WorkflowMotionItem> = {},
): WorkflowMotionItem {
  return {
    occurrenceId,
    rootChatId: 'root',
    sourceHeaderId: 'header:main',
    kind: 'model',
    status: 'running',
    live: true,
    orderQuality: 'exact',
    firstSequence: 1,
    lastSequence: 1,
    ...overrides,
  }
}

function context(overrides: Partial<WorkflowMotionContext> = {}): WorkflowMotionContext {
  return {
    source: 'live',
    rootChatId: 'root',
    synced: true,
    replay: false,
    suspended: false,
    hidden: false,
    spatial: true,
    loops: true,
    ...overrides,
  }
}

describe('workflow runtime motion policy', () => {
  it('animates only exact live changes for the current root', () => {
    const decisions = planWorkflowMotion(
      [],
      [
        item('current'),
        item('other-root', { rootChatId: 'other' }),
        item('legacy', { orderQuality: 'reconstructed' }),
        item('gap', { status: 'unknown', live: false }),
      ],
      context(),
    )
    expect(decisions).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ occurrenceId: 'current' }),
        phase: 'enter',
      }),
    ])
  })

  it.each([
    ['hydrate', { source: 'hydrate' as const }],
    ['replay', { replay: true }],
    ['background', { hidden: true }],
    ['minimized', { suspended: true }],
    ['disconnected', { synced: false }],
  ])('keeps %s snapshots static', (_label, overrides) => {
    expect(planWorkflowMotion([], [item('new')], context(overrides))).toEqual([])
  })

  it('settles a rapid terminal occurrence and cancels no-op repeats', () => {
    expect(
      planWorkflowMotion([], [item('fast', { status: 'succeeded', live: false })], context()),
    ).toEqual([
      expect.objectContaining({
        item: expect.objectContaining({ occurrenceId: 'fast' }),
        phase: 'settle',
      }),
    ])
    const waiting = item('same', { status: 'waiting' })
    expect(planWorkflowMotion([waiting], [waiting], context())).toEqual([])
  })

  it('distinguishes waiting, resume and terminal transitions without changing identity', () => {
    const running = item('same')
    const waiting = item('same', { status: 'waiting', lastSequence: 2 })
    const resumed = item('same', { lastSequence: 3 })
    const failed = item('same', { status: 'failed', live: false, lastSequence: 4 })

    expect(planWorkflowMotion([running], [waiting], context())[0]).toMatchObject({
      item: { occurrenceId: 'same' },
      phase: 'status',
    })
    expect(planWorkflowMotion([waiting], [resumed], context())[0]?.phase).toBe('status')
    expect(planWorkflowMotion([resumed], [failed], context())[0]?.phase).toBe('settle')
  })

  it('removes spatial motion for reduced mode and bounds work to visible newest items', () => {
    const values = Array.from({ length: 5 }, (_, index) =>
      item(`item-${index}`, { firstSequence: index, lastSequence: index }),
    )
    const visible = new Set(['item-1', 'item-3', 'item-4'])
    expect(
      planWorkflowMotion(
        [],
        values,
        context({ spatial: false, visibleOccurrenceIds: visible, limit: 2 }),
      ).map((decision) => ({ id: decision.item.occurrenceId, spatial: decision.spatial })),
    ).toEqual([
      { id: 'item-3', spatial: false },
      { id: 'item-4', spatial: false },
    ])
  })

  it('runs continuous feedback only for visible active nodes in full motion', () => {
    const active = item('active', { status: 'waiting' })
    expect(
      shouldLoopWorkflowMotion(active, context({ visibleOccurrenceIds: new Set(['active']) })),
    ).toBe(true)
    expect(shouldLoopWorkflowMotion(active, context({ loops: false }))).toBe(false)
    expect(shouldLoopWorkflowMotion(active, context({ visibleOccurrenceIds: new Set() }))).toBe(
      false,
    )
    expect(shouldLoopWorkflowMotion(active, context({ replay: true }))).toBe(false)

    const values = Array.from({ length: 10 }, (_, index) =>
      item(`loop-${index}`, { firstSequence: index, lastSequence: index }),
    )
    expect(
      selectWorkflowMotionLoops(values, context(), 3).map((candidate) => candidate.occurrenceId),
    ).toEqual(['loop-9', 'loop-8', 'loop-7'])
  })

  it('cancels stale handles on replace and all handles on teardown', () => {
    const registry = new WorkflowMotionRegistry()
    const first = vi.fn()
    const latest = vi.fn()
    const other = vi.fn()
    const releaseLatest = registry.track('same', first)
    registry.track('same', latest)
    registry.track('other', other)

    expect(first).toHaveBeenCalledOnce()
    releaseLatest()
    expect(registry.size).toBe(2)
    registry.cancelAll()
    expect(latest).toHaveBeenCalledOnce()
    expect(other).toHaveBeenCalledOnce()
    expect(registry.size).toBe(0)
  })
})
