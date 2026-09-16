import { readFileSync } from 'node:fs'
import { computed, ref } from 'vue'
import { describe, expect, it } from 'vitest'
import type { RootTimelineSnapshot } from '../../src/application/backend/public'
import { selectTreeTimelineOverride } from '../../src/features/agent/workbench/workbenchTimelineSelection'

function snapshot(revision: number): RootTimelineSnapshot {
  return {
    rootChatId: 'root',
    view: 'tree',
    revision,
    nodes: [],
    edges: [],
    activeRuns: [],
    generations: [],
  } as RootTimelineSnapshot
}

describe('workbench tree timeline selection', () => {
  it('stops the task snapshot from hiding live data once the live revision catches up', () => {
    const selectedRootChatId = ref('previous')
    const liveByRoot = ref<Record<string, RootTimelineSnapshot | undefined>>({})
    const fallback = ref<RootTimelineSnapshot | undefined>(snapshot(5))
    const override = computed(() =>
      selectTreeTimelineOverride(liveByRoot.value[selectedRootChatId.value], fallback.value),
    )

    expect(override.value).toBe(fallback.value)

    selectedRootChatId.value = 'current'
    liveByRoot.value.current = snapshot(4)
    expect(override.value).toBe(fallback.value)

    liveByRoot.value.current = snapshot(5)
    expect(override.value).toBeUndefined()

    liveByRoot.value.current = snapshot(6)
    expect(override.value).toBeUndefined()

    fallback.value = undefined
    expect(override.value).toBeUndefined()
  })

  it('wires the revision-aware selection into the Pixi tree props', () => {
    const controller = readFileSync(
      'web/src/features/agent/workbench/useWorkbenchDialogController.ts',
      'utf8',
    )

    expect(controller).toContain('timelineOverride: selectTreeTimelineOverride(')
    expect(controller).not.toContain('timelineOverride: taskTimeline.value')
  })
})
