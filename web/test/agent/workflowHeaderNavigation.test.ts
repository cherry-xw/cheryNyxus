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
    }),
  )
  const beforeNavigate = vi.fn()
  const navigation = scope.run(() =>
    useHeaderBoardNavigation({
      boards,
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
      terminal: relationTerminal('response:checkpoint', 'checkpoint', true, 'out'),
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
