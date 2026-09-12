import { computed, nextTick, onScopeDispose, ref, watch, type ComputedRef, type Ref } from 'vue'
import type { ViewportTransform, VueFlowStore } from '@vue-flow/core'
import {
  absoluteGraphPosition,
  headerTemplateNodeId,
  type HeaderTerminalEvent,
} from './headerGraph'
import { boardParent, HEADER_BOARDS, layerAncestors } from './headerLayout'
import { HEADER_LAYERS, WORKFLOW_HEADER_TEMPLATE } from './headerTemplate'
import type { WorkflowGraphProjection } from './graphModel'

export function boardZoomIntent(
  zoom: number,
  deltaY: number,
  overChip: boolean,
  board: string,
): 'enter' | 'back' | undefined {
  if (deltaY < 0 && zoom >= 1.45 && overChip) return 'enter'
  if (deltaY > 0 && zoom <= 0.55 && board !== 'overview') return 'back'
  return undefined
}
export function useHeaderBoardNavigation(options: {
  boards: Ref<Record<string, string>>
  expanded?: Ref<Record<string, readonly string[]>>
  follow?: Ref<boolean>
  root: ComputedRef<string>
  flow: Ref<VueFlowStore | undefined>
  host: Ref<HTMLElement | null>
  projection: ComputedRef<WorkflowGraphProjection>
  disabled: ComputedRef<boolean>
  followDisabled?: ComputedRef<boolean>
  beforeNavigate: () => void
}) {
  const cameras = new Map<string, ViewportTransform>(),
    roots = new Map<string, Record<string, string>>()
  const expanded = options.expanded ?? ref<Record<string, readonly string[]>>({})
  const follow = options.follow ?? ref(false)
  const followDisabled = computed(
    () => options.disabled.value || options.followDisabled?.value === true,
  )
  const expansionsByRoot = new Map<string, Record<string, readonly string[]>>()
  let followTimer: ReturnType<typeof setTimeout> | undefined
  function cancelFollow(): void {
    clearTimeout(followTimer)
    followTimer = undefined
  }
  function pauseFollow(): void {
    cancelFollow()
    if (!follow.value) return
    const next: Record<string, string[]> = {}
    for (const node of options.projection.value.nodes) {
      if (node.data?.kind === 'header-group' && !node.data.collapsed)
        (next[node.data.headerId] ??= []).push(node.data.groupId)
    }
    expanded.value = next
    if (activeHeader.value)
      options.boards.value = { ...options.boards.value, [activeHeader.value]: currentBoard.value }
    follow.value = false
  }
  const focusByBoard = new Map<string, string>()
  const relation = ref<HeaderTerminalEvent>()
  let serial = 0,
    lastWheel = 0,
    wheelLocked = false
  const activeHeader = computed(() => options.projection.value.activeHeaderId)
  const currentBoard = computed(() => {
    if (follow.value) {
      const step = options.projection.value.nodes.find(
        (n) => n.id === options.projection.value.rawActiveOccurrenceId,
      )
      if (step?.data?.kind === 'header-step') return step.data.template.group
      return 'overview'
    }
    return options.boards.value[activeHeader.value ?? ''] ?? 'overview'
  })
  const key = (header: string, board: string) => JSON.stringify([options.root.value, header, board])
  async function navigate(headerId: string, board: string, targetNodeId?: string): Promise<void> {
    if (!HEADER_BOARDS.includes(board) || options.disabled.value) return
    pauseFollow()
    const root = options.root.value,
      token = ++serial
    const previous = options.boards.value[headerId] ?? 'overview'
    const viewport = options.flow.value?.viewport.value
    if (viewport) cameras.set(key(headerId, previous), { ...viewport })
    const focused =
      options.host.value?.ownerDocument.activeElement?.closest<HTMLElement>('.vue-flow__node')
        ?.dataset.id
    if (focused) focusByBoard.set(key(headerId, previous), focused)
    options.beforeNavigate()
    expanded.value = {
      ...expanded.value,
      [headerId]: [...new Set([...(expanded.value[headerId] ?? []), ...layerAncestors(board)])],
    }
    options.boards.value = { ...options.boards.value, [headerId]: board }
    await nextTick()
    if (
      serial !== token ||
      options.root.value !== root ||
      !options.flow.value ||
      options.disabled.value
    )
      return
    const saved = cameras.get(key(headerId, board))
    const targetId = targetNodeId
      ? headerTemplateNodeId(headerId, targetNodeId)
      : `${headerId}:group:${board}`
    const target = options.projection.value.nodes.find((n) => n.id === targetId)
    const header = options.projection.value.nodes.find((n) => n.id === headerId)
    if (saved && !targetNodeId) await options.flow.value.setViewport(saved, { duration: 0 })
    else if (target) {
      const p = absoluteGraphPosition(target, options.projection.value.nodes)
      await options.flow.value.setCenter(
        p.x + Number(target.width) / 2,
        p.y + Number(target.height) / 2,
        { zoom: 1, duration: 0 },
      )
    } else if (header) {
      await options.flow.value.setViewport(
        { x: 32 - header.position.x, y: 32 - header.position.y, zoom: 1 },
        { duration: 0 },
      )
    }
    if (serial !== token) return
    const restoreId = targetId ?? focusByBoard.get(key(headerId, board))
    const nodes = options.host.value?.querySelectorAll<HTMLElement>('.vue-flow__node') ?? []
    const element = Array.from(nodes).find((n) => n.dataset.id === restoreId)
    const button =
      element?.querySelector<HTMLButtonElement>('button') ??
      options.host.value?.parentElement?.querySelector<HTMLButtonElement>('[data-board-back]')
    button?.focus({ preventScroll: true })
    // Bound long-running multi-root workspaces without persisting transient UI into business state.
    if (cameras.size > 80) {
      const oldest = cameras.keys().next().value!
      cameras.delete(oldest)
      focusByBoard.delete(oldest)
    }
  }
  function back(): void {
    if (activeHeader.value) {
      collapse(activeHeader.value, currentBoard.value)
      void navigate(activeHeader.value, boardParent(currentBoard.value))
    }
  }
  function overview(): void {
    if (activeHeader.value) {
      pauseFollow()
      expanded.value = { ...expanded.value, [activeHeader.value]: [] }
      void navigate(activeHeader.value, 'overview')
    }
  }
  function collapse(headerId: string, group: string): void {
    pauseFollow()
    options.beforeNavigate()
    expanded.value = {
      ...expanded.value,
      [headerId]: (expanded.value[headerId] ?? []).filter(
        (id) => !layerAncestors(id).includes(group),
      ),
    }
  }
  function toggle(headerId: string, group: string): void {
    const chip = options.projection.value.nodes.find((n) => n.id === `${headerId}:group:${group}`)
    if (chip?.data?.kind === 'header-group' && !chip.data.collapsed) {
      collapse(headerId, group)
      options.boards.value = { ...options.boards.value, [headerId]: boardParent(group) }
    } else void navigate(headerId, group)
  }
  function expandAll(): void {
    if (!activeHeader.value) return
    pauseFollow()
    options.beforeNavigate()
    expanded.value = {
      ...expanded.value,
      [activeHeader.value]: HEADER_LAYERS.map((layer) => layer.id),
    }
  }
  function onWheel(event: WheelEvent): void {
    const now = performance.now()
    if (now - lastWheel > 240) wheelLocked = false
    lastWheel = now
    const element = event.target instanceof Element ? event.target : undefined
    if (
      options.disabled.value ||
      element?.closest('.nowheel, input, select, textarea, [role="dialog"]')
    )
      return
    pauseFollow()
    const headerId = activeHeader.value,
      zoom = options.flow.value?.viewport.value?.zoom
    if (!headerId || !zoom) return
    const chip = element?.closest<HTMLElement>('[data-board-chip]')
    const intent = boardZoomIntent(zoom, event.deltaY, !!chip, currentBoard.value)
    if (
      intent === 'back' &&
      !element?.closest('.workflow-header-shell, [data-workflow-layer], .workflow-terminal')
    )
      return
    if (!intent && !wheelLocked) return
    event.preventDefault()
    event.stopPropagation()
    if (wheelLocked) return
    wheelLocked = true
    if (intent === 'enter' && chip?.dataset.boardChip)
      void navigate(headerId, chip.dataset.boardChip)
    else if (intent === 'back') back()
  }
  function trace(event: HeaderTerminalEvent): void {
    relation.value = event
  }
  async function traceEnd(end: 'source' | 'target'): Promise<void> {
    const selected = relation.value
    if (!selected) return
    const id = selected.terminal[end],
      node = WORKFLOW_HEADER_TEMPLATE.nodes.find((n) => n.id === id)
    if (node) await navigate(selected.headerId, node.group, id)
  }
  watch(
    options.root,
    (_, previous) => {
      ++serial
      relation.value = undefined
      wheelLocked = false
      roots.set(previous, { ...options.boards.value })
      cancelFollow()
      expansionsByRoot.set(previous, { ...expanded.value })
      expanded.value = expansionsByRoot.get(options.root.value) ?? {}
      options.boards.value = roots.get(options.root.value) ?? {}
      if (roots.size > 20) {
        const oldest = roots.keys().next().value!
        roots.delete(oldest)
        expansionsByRoot.delete(oldest)
      }
    },
    { flush: 'sync' },
  )
  watch(options.disabled, () => {
    ++serial
    cancelFollow()
    relation.value = undefined
  })
  const activity = computed(() => {
    const graph = options.projection.value
    return [
      options.root.value,
      graph.rawActiveOccurrenceId,
      ...graph.nodes
        .filter((n) => n.data?.kind === 'header-group' || n.data?.kind === 'header-step')
        .map(
          (n) =>
            `${n.id}:${n.position.x},${n.position.y},${n.width},${n.height}:${n.data?.kind === 'header-step' ? n.data.slot.occurrence?.occurrenceId : ''}`,
        ),
    ].join('|')
  })
  watch(
    [activity, follow, followDisabled, options.flow],
    () => {
      cancelFollow()
      if (!follow.value || followDisabled.value || !options.flow.value) return
      const root = options.root.value
      followTimer = setTimeout(() => {
        followTimer = undefined
        if (!follow.value || followDisabled.value || options.root.value !== root) return
        const graph = options.projection.value
        const node =
          graph.nodes.find((n) => n.id === graph.activeOccurrenceId) ??
          graph.nodes.find((n) => n.id === `${graph.activeHeaderId}:group:loop`)
        if (!node) return
        const p = absoluteGraphPosition(node, graph.nodes)
        void options.flow.value?.setCenter(
          p.x + Number(node.width) / 2,
          p.y + Number(node.height) / 2,
          { zoom: 1, duration: 0 },
        )
      }, 160)
    },
    { flush: 'post', immediate: true },
  )
  onScopeDispose(() => {
    ++serial
    cancelFollow()
    cameras.clear()
    roots.clear()
    focusByBoard.clear()
    expansionsByRoot.clear()
  })
  return {
    currentBoard,
    relation,
    navigate,
    back,
    overview,
    expandAll,
    toggle,
    pauseFollow,
    onWheel,
    trace,
    traceEnd,
  }
}
