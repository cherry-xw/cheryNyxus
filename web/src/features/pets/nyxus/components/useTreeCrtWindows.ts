import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { MessageBranchTreeControllerProps } from './treeControllerTypes'
import type { useNyxusHost } from '../application/host'
import type { useTreeGraphProjection } from './useTreeGraphProjection'
import type { useTreeCanvas } from '../composables/useTreeCanvas'
import type { PositionedExecutionNode } from '../graph/executionLayout'
import { projectExecutionPresentation } from '../graph/executionPresentation'
import { buildRunCrtModels, type RunCrtModel } from '../graph/crtModel'
import { layoutCrtWindowsBesideAnchors, selectVisibleCrtIds } from '../graph/crtLayout'

/** Running CRT projection, window visibility, snapping, dragging and focus order. */
export function useTreeCrtWindows({
  props,
  chatSessions,
  timelineSnapshot,
  liveState,
  persistentGraph,
  graph,
  activeCrtRuns,
  layout,
  canvas,
  viewportSize,
  nodeScreenAnchor,
}: {
  props: MessageBranchTreeControllerProps
  chatSessions: ReturnType<typeof useNyxusHost>['chats']
  timelineSnapshot: ReturnType<typeof useTreeGraphProjection>['timelineSnapshot']
  liveState: ReturnType<typeof useTreeGraphProjection>['liveState']
  persistentGraph: ReturnType<typeof useTreeGraphProjection>['persistentGraph']
  graph: ReturnType<typeof useTreeGraphProjection>['graph']
  activeCrtRuns: ReturnType<typeof useTreeGraphProjection>['activeCrtRuns']
  layout: ComputedRef<ReturnType<typeof projectExecutionPresentation>>
  canvas: ReturnType<typeof useTreeCanvas>
  viewportSize: Ref<{ width: number; height: number }>
  nodeScreenAnchor: (node: PositionedExecutionNode) => { x: number; y: number }
}) {
  const pinnedCrtIds = ref<Set<string>>(new Set())
  const hiddenCrtIds = ref<Set<string>>(new Set())
  const crtWindowState = ref<Map<string, { left: number; top: number; z: number }>>(new Map())
  let nextCrtZ = 1
  const projectedCrts = computed(() =>
    buildRunCrtModels({
      rootChatId: props.rootChatId,
      runs: activeCrtRuns.value,
      authoritativeRuns: timelineSnapshot.value?.activeRuns,
      activeTurns: liveState.value.activeTurns,
      canonicalNodes: persistentGraph.value.nodes,
      visibleNodes: graph.value.nodes,
      sessionsById: chatSessions.sessionsById,
    }),
  )
  const retainedCrts = computed(
    () => new Map(projectedCrts.value.map((card) => [card.id, card] as const)),
  )
  const runningTailIds = computed(() => {
    return new Set([
      ...graph.value.nodes
        .filter((node) => node.activeRuns.some((run) => run.status === 'running'))
        .map((node) => node.id),
      ...projectedCrts.value
        .filter((card) => card.status === 'running' || card.status === 'waiting')
        .map((card) => card.anchorNodeId),
    ])
  })
  watch(
    projectedCrts,
    (nextCards) => {
      const liveIds = new Set(nextCards.map((card) => card.id))
      updateCrtSet(pinnedCrtIds, (ids) => {
        for (const id of ids) if (!liveIds.has(id)) ids.delete(id)
      })
      updateCrtSet(hiddenCrtIds, (ids) => {
        for (const id of ids) if (!liveIds.has(id)) ids.delete(id)
      })
    },
    { immediate: true },
  )
  const crtVisibility = computed(() => {
    const cards = [...retainedCrts.value.values()].map((card, order) => ({
      id: card.id,
      actionable: card.actionable,
      pinned: pinnedCrtIds.value.has(card.id),
      order: card.updatedAt || order,
    }))
    return selectVisibleCrtIds(cards, 5)
  })
  const visibleCrts = computed(() =>
    [...retainedCrts.value.values()].filter(
      (card) =>
        crtVisibility.value.visible.has(card.id) &&
        (card.actionable || !hiddenCrtIds.value.has(card.id)),
    ),
  )
  const initialCrtPlacements = computed(() => {
    const positioned = new Map(layout.value.nodes.map((node) => [node.id, node]))
    const heightLimit = Math.max(160, viewportSize.value.height - 96)
    return layoutCrtWindowsBesideAnchors(
      visibleCrts.value.flatMap((card, order) => {
        const node = positioned.get(card.anchorNodeId)
        if (!node) return []
        return [
          {
            id: card.id,
            anchor: nodeScreenAnchor(node),
            panel: { width: 360, height: Math.min(heightLimit, 476) },
            anchorClearance: 23 * canvas.scale.value + 10,
            main: card.main,
            actionable: false,
            pinned: pinnedCrtIds.value.has(card.id),
            order: card.updatedAt || order,
            lineTargetOffsetY: 16,
          },
        ]
      }),
      { ...viewportSize.value, margin: 12 },
    )
  })
  let crtAnchorPlacementKeys = new Map<string, string>()
  watch(
    initialCrtPlacements,
    (placements) => {
      const live = new Set(visibleCrts.value.map((card) => card.id))
      const next = new Map(crtWindowState.value)
      const nextPlacementKeys = new Map<string, string>()
      for (const id of next.keys()) if (!live.has(id)) next.delete(id)
      for (const placement of placements) {
        const placementKey = [
          placement.anchor.x,
          placement.anchor.y,
          placement.left,
          placement.top,
        ].join(':')
        nextPlacementKeys.set(placement.id, placementKey)
        const current = next.get(placement.id)
        if (!current)
          next.set(placement.id, { left: placement.left, top: placement.top, z: nextCrtZ++ })
        else if (crtAnchorPlacementKeys.get(placement.id) !== placementKey)
          next.set(placement.id, { ...current, left: placement.left, top: placement.top })
      }
      crtAnchorPlacementKeys = nextPlacementKeys
      crtWindowState.value = next
    },
    { immediate: true },
  )
  function snapCrtWindowsToAnchors(): void {
    const next = new Map(crtWindowState.value)
    let changed = false
    for (const placement of initialCrtPlacements.value) {
      const current = next.get(placement.id)
      if (!current || (current.left === placement.left && current.top === placement.top)) continue
      next.set(placement.id, { ...current, left: placement.left, top: placement.top })
      changed = true
    }
    if (changed) crtWindowState.value = next
  }
  const crtPlacements = computed(() => {
    const positioned = new Map(layout.value.nodes.map((node) => [node.id, node]))
    return visibleCrts.value.flatMap((card, order) => {
      const node = positioned.get(card.anchorNodeId)
      const state = crtWindowState.value.get(card.id)
      if (!node || !state) return []
      const anchor = nodeScreenAnchor(node)
      const panel = {
        width: 360,
        height: Math.min(Math.max(160, viewportSize.value.height - 96), 476),
      }
      const centerX = state.left + panel.width / 2
      const placement = anchor.x <= centerX ? ('right' as const) : ('left' as const)
      const edgeX = placement === 'right' ? state.left : state.left + panel.width
      return [
        {
          id: card.id,
          anchor,
          panel,
          main: card.main,
          actionable: card.actionable,
          pinned: pinnedCrtIds.value.has(card.id),
          order: card.updatedAt || order,
          left: state.left,
          top: state.top,
          placement,
          windowZ: state.z,
          line: { from: anchor, to: { x: edgeX, y: state.top + 16 } },
        },
      ]
    })
  })
  /** 锚点连线只服务运行 CRT；节点悬浮框（详情/审批/提问）一律不画线。 */
  const overlayPlacements = computed(() => [...crtPlacements.value])
  const crtById = computed(() => new Map(visibleCrts.value.map((card) => [card.id, card])))
  const crtsByAnchor = computed(() => {
    const result = new Map<string, RunCrtModel[]>()
    for (const card of retainedCrts.value.values()) {
      const cards = result.get(card.anchorNodeId) ?? []
      cards.push(card)
      result.set(card.anchorNodeId, cards)
    }
    return result
  })
  function updateCrtSet(target: typeof pinnedCrtIds, update: (next: Set<string>) => void): void {
    const next = new Set(target.value)
    update(next)
    target.value = next
  }
  function pinCrt(id: string): void {
    updateCrtSet(pinnedCrtIds, (next) => next.add(id))
    updateCrtSet(hiddenCrtIds, (next) => next.delete(id))
  }
  function unpinCrt(id: string): void {
    updateCrtSet(pinnedCrtIds, (next) => next.delete(id))
  }
  function closeCrt(id: string): void {
    if (retainedCrts.value.get(id)?.actionable) return
    unpinCrt(id)
    updateCrtSet(hiddenCrtIds, (next) => next.add(id))
  }
  function focusCrt(id: string): void {
    const current = crtWindowState.value.get(id)
    if (!current) return
    const next = new Map(crtWindowState.value)
    const ordered = [...next.entries()]
      .filter(([candidate]) => candidate !== id)
      .sort((a, b) => a[1].z - b[1].z || a[0].localeCompare(b[0]))
    ordered.forEach(([candidate, state], index) => next.set(candidate, { ...state, z: index + 1 }))
    next.set(id, { ...current, z: ordered.length + 1 })
    nextCrtZ = ordered.length + 2
    crtWindowState.value = next
  }
  function dragCrt(id: string, delta: { x: number; y: number }): void {
    const current = crtWindowState.value.get(id)
    if (!current) return
    const width = 360
    const headerVisible = 32
    const left = Math.min(
      viewportSize.value.width - headerVisible,
      Math.max(-width + headerVisible, current.left + delta.x),
    )
    const top = Math.min(
      viewportSize.value.height - headerVisible,
      Math.max(0, current.top + delta.y),
    )
    const next = new Map(crtWindowState.value)
    next.set(id, { left, top, z: current.z })
    crtWindowState.value = next
  }
  function resetCrtWindows(): void {
    pinnedCrtIds.value = new Set()
    hiddenCrtIds.value = new Set()
    crtWindowState.value = new Map()
    nextCrtZ = 1
  }
  return {
    pinnedCrtIds,
    projectedCrts,
    runningTailIds,
    crtVisibility,
    crtPlacements,
    overlayPlacements,
    crtById,
    crtsByAnchor,
    pinCrt,
    unpinCrt,
    closeCrt,
    focusCrt,
    dragCrt,
    snapCrtWindowsToAnchors,
    resetCrtWindows,
  }
}
