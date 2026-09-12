import { computed, effectScope, nextTick, ref, shallowRef } from 'vue'
import { describe, expect, it, vi } from 'vitest'
import type { VueFlowStore } from '@vue-flow/core'
import { projectWorkflowGraph } from '../../src/features/agent/workbench/runtime-diagram/graphModel'
import { useHeaderBoardNavigation } from '../../src/features/agent/workbench/runtime-diagram/useHeaderBoardNavigation'
import { relationTerminal } from '../../src/features/agent/workbench/runtime-diagram/headerLayout'
import { topologyMatrixSnapshot } from '../fixtures/executionGraphFixtures'

function setup() {
  const scope = effectScope(),
    boards = ref<Record<string, string>>({}),
    expanded = ref<Record<string, readonly string[]>>({}),
    follow = ref(false),
    root = ref('root-a'),
    disabled = ref(false)
  const viewport = ref({ x: 123, y: 456, zoom: 1.2 })
  const setViewport = vi.fn(async (next) => {
    viewport.value = { ...next }
    return true
  })
  const setCenter = vi.fn(async () => true)
  const flow = shallowRef({ viewport, setViewport, setCenter } as unknown as VueFlowStore)
  const projection = computed(() =>
    projectWorkflowGraph(undefined, topologyMatrixSnapshot(), 'none', {}, [], {
      boards: boards.value,
      expanded: expanded.value,
    }),
  )
  const beforeNavigate = vi.fn()
  const navigation = scope.run(() =>
    useHeaderBoardNavigation({
      boards,
      expanded,
      follow,
      root: computed(() => root.value),
      flow,
      host: ref(null),
      projection,
      disabled: computed(() => disabled.value),
      beforeNavigate,
    }),
  )!
  return {
    scope,
    boards,
    expanded,
    follow,
    root,
    disabled,
    viewport,
    setViewport,
    setCenter,
    projection,
    navigation,
    beforeNavigate,
  }
}
describe('board navigation lifecycle', () => {
  it('preserves siblings when opening and only removes the collapsed descendants', async () => {
    const t = setup(),
      header = t.projection.value.activeHeaderId!
    await t.navigation.navigate(header, 'intake')
    await t.navigation.navigate(header, 'model-layer')
    expect(t.expanded.value[header]).toEqual(
      expect.arrayContaining(['intake', 'loop', 'record', 'tools', 'retry-layer', 'model-layer']),
    )
    t.navigation.toggle(header, 'tools')
    expect(t.expanded.value[header]).toEqual(expect.arrayContaining(['intake', 'loop', 'record']))
    expect(t.expanded.value[header]).not.toContain('model-layer')
    t.navigation.expandAll()
    expect(t.expanded.value[header]).toHaveLength(8)
    t.navigation.overview()
    expect(t.expanded.value[header]).toEqual([])
    t.scope.stop()
  })
  it('coalesces camera following and cancels it on manual browsing, suspension and disposal', async () => {
    vi.useFakeTimers()
    const t = setup()
    try {
      t.follow.value = true
      await nextTick()
      await vi.advanceTimersByTimeAsync(160)
      expect(t.setCenter).toHaveBeenCalledOnce()
      t.setCenter.mockClear()
      t.follow.value = false
      await nextTick()
      t.follow.value = true
      await nextTick()
      t.navigation.pauseFollow()
      await vi.advanceTimersByTimeAsync(200)
      expect(t.setCenter).not.toHaveBeenCalled()
      t.follow.value = true
      await nextTick()
      t.disabled.value = true
      await vi.advanceTimersByTimeAsync(200)
      expect(t.setCenter).not.toHaveBeenCalled()
      t.disabled.value = false
      await nextTick()
      t.scope.stop()
      await vi.advanceTimersByTimeAsync(200)
      expect(t.setCenter).not.toHaveBeenCalled()
    } finally {
      t.scope.stop()
      vi.useRealTimers()
    }
  })
  it('returns to the exact previous viewport and keeps roots independent', async () => {
    const test = setup(),
      header = test.projection.value.activeHeaderId!
    await test.navigation.navigate(header, 'loop')
    test.viewport.value = { x: 20, y: 30, zoom: 1.1 }
    await test.navigation.navigate(header, 'record')
    await test.navigation.navigate(header, 'loop')
    expect(test.viewport.value).toEqual({ x: 20, y: 30, zoom: 1.1 })
    test.root.value = 'root-b'
    expect(test.boards.value).toEqual({})
    await test.navigation.navigate(header, 'tools')
    test.root.value = 'root-a'
    expect(test.boards.value[header]).toBe('loop')
    test.scope.stop()
  })
  it('rejects stale navigation and does not navigate when suspended', async () => {
    const test = setup(),
      header = test.projection.value.activeHeaderId!
    const pending = test.navigation.navigate(header, 'loop')
    test.root.value = 'root-b'
    await pending
    expect(test.setViewport).not.toHaveBeenCalled()
    test.disabled.value = true
    await test.navigation.navigate(header, 'tools')
    expect(test.boards.value).toEqual({})
    test.scope.stop()
  })
  it('traces the original endpoint into its owning board without inventing an occurrence', async () => {
    const test = setup(),
      header = test.projection.value.activeHeaderId!
    test.navigation.trace({
      headerId: header,
      terminal: relationTerminal('channels:checkpoint', 'checkpoint', true, 'out'),
    })
    await test.navigation.traceEnd('target')
    expect(test.boards.value[header]).toBe('record')
    expect(test.setCenter).toHaveBeenCalledOnce()
    expect(test.projection.value.nodes.some((n) => n.data.kind === 'occurrence')).toBe(false)
    test.root.value = 'other'
    await nextTick()
    expect(test.navigation.relation.value).toBeUndefined()
    test.scope.stop()
  })
  it('does not throw on wheel when the flow store exists but the viewport is not ready', () => {
    const test = setup(),
      header = test.projection.value.activeHeaderId!
    test.boards.value = { [header]: 'overview' }
    // Simulate the initialization/reconstruction race: the Vue Flow store is
    // already registered but its viewport ref has not been initialized yet.
    ;(test.viewport as unknown as { value: unknown }).value = undefined
    const originalElement = globalThis.Element
    class ElementStub {
      closest(): null {
        return null
      }
    }
    ;(globalThis as unknown as { Element: unknown }).Element = ElementStub
    try {
      const event = {
        target: new ElementStub(),
        deltaY: -20,
        preventDefault: vi.fn(),
        stopPropagation: vi.fn(),
      }
      expect(() => test.navigation.onWheel(event as unknown as WheelEvent)).not.toThrow()
      expect(test.setViewport).not.toHaveBeenCalled()
      expect(test.setCenter).not.toHaveBeenCalled()
    } finally {
      ;(globalThis as unknown as { Element: unknown }).Element = originalElement
    }
    test.scope.stop()
  })
})
