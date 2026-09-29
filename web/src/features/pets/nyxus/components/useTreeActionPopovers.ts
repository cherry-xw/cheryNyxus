import { computed, ref, watch, type Ref } from 'vue'
import type { useNyxusHost } from '../application/host'
import type { useTreeGraphProjection } from './useTreeGraphProjection'
import type { PositionedExecutionNode } from '../graph/executionLayout'
import type { ExecutionFoldMember, ExecutionNode } from '../graph/executionGraph'
import type { DefaultNodePopover } from '../graph/nodePopoverModel'
import { buildDefaultNodePopovers } from '../graph/nodePopoverModel'
import { anchoredPopoverPosition } from '../graph/toolBatchDetails'
import { projectExecutionPresentation } from '../graph/executionPresentation'

/** Pending-action anchors and auxiliary node popover positioning. */
export function useTreeActionPopovers({
  graph,
  chatSessions,
  layout,
  viewportSize,
  nodeScreenAnchor,
  memberContainingNode,
  popoverWidth,
  popoverInitialHeight,
}: {
  graph: ReturnType<typeof useTreeGraphProjection>['graph']
  chatSessions: ReturnType<typeof useNyxusHost>['chats']
  layout: () => ReturnType<typeof projectExecutionPresentation>
  viewportSize: Ref<{ width: number; height: number }>
  nodeScreenAnchor: (node: PositionedExecutionNode) => { x: number; y: number }
  memberContainingNode: (
    members: readonly ExecutionFoldMember[],
    nodeId?: string,
  ) => ExecutionFoldMember | undefined
  popoverWidth: number
  popoverInitialHeight: number
}) {
  const actionSelectedCallIds = ref<Map<string, string>>(new Map())
  const defaultNodePopovers = computed(() =>
    buildDefaultNodePopovers(graph.value.nodes, chatSessions.sessionsById),
  )
  const defaultPopoverById = computed(
    () => new Map(defaultNodePopovers.value.map((model) => [model.id, model] as const)),
  )
  const defaultPopoverAnchorIds = computed(
    () => new Set(defaultNodePopovers.value.map((model) => model.anchorNodeId)),
  )
  /**
   * 等待用户交互的锚定节点（待审批/待回答）：整棵树上持续闪烁，直到交互完成。
   * 除主锚点外还包含模型的附加锚点（如提问批的 ask_user_question 问号工具节点）。
   */
  const awaitingInteractionNodeIds = computed(() => {
    const ids = new Set<string>()
    for (const model of defaultNodePopovers.value) {
      ids.add(model.anchorNodeId)
      for (const alt of model.anchorAltNodeIds ?? []) ids.add(alt)
    }
    return ids
  })
  /** 保留节点弹层布局状态，审核/提问模型本身不再进入弹层渲染。 */
  const actionPopoverOpenIds = ref<Set<string>>(new Set())
  watch(
    defaultNodePopovers,
    (models) => {
      const liveIds = new Set(models.map((model) => model.id))
      const next = new Map(actionSelectedCallIds.value)
      for (const id of next.keys()) if (!liveIds.has(id)) next.delete(id)
      actionSelectedCallIds.value = next
    },
    { immediate: true },
  )
  const actionPopoverManual = ref<Map<string, { left: number; top: number }>>(new Map())
  /** action 弹窗的实测内容高度（ResizeObserver 上报），定位用真实高度而非滚动上限。 */
  const actionPopoverHeights = ref<Map<string, number>>(new Map())
  /**
   * 高度测量指令：观察宿主元素尺寸变化并回传实测高度，供定位使用。
   * 每帧回传的是闭包里的最新回调（updated 钩子同步），避免 ResizeObserver 回调拿到过期引用。
   */
  const vMeasureHeight = {
    mounted(el: HTMLElement, binding: { value: (height: number) => void }): void {
      const host = el as HTMLElement & {
        __popoverMeasure?: ResizeObserver
        __popoverMeasureCallback?: (height: number) => void
      }
      host.__popoverMeasureCallback = binding.value
      const observer = new ResizeObserver(() => {
        host.__popoverMeasureCallback?.(host.offsetHeight)
      })
      observer.observe(el)
      host.__popoverMeasure = observer
    },
    updated(el: HTMLElement, binding: { value: (height: number) => void }): void {
      ;(
        el as HTMLElement & { __popoverMeasureCallback?: (height: number) => void }
      ).__popoverMeasureCallback = binding.value
    },
    unmounted(el: HTMLElement): void {
      ;(el as HTMLElement & { __popoverMeasure?: ResizeObserver }).__popoverMeasure?.disconnect()
    },
  }
  function setActionPopoverHeight(id: string, height: number): void {
    if (height <= 0 || actionPopoverHeights.value.get(id) === height) return
    const next = new Map(actionPopoverHeights.value)
    next.set(id, height)
    actionPopoverHeights.value = next
  }
  /** v-measure-height 的具名回调工厂：模板内联箭头无法推断 height 类型（TS7006）。 */
  function recordActionPopoverHeight(id: string): (height: number) => void {
    return (height: number) => setActionPopoverHeight(id, height)
  }
  function dragActionPopover(id: string, delta: { x: number; y: number }): void {
    const placement = defaultPopoverPlacements.value.find((item) => item.id === id)
    if (!placement) return
    const current = actionPopoverManual.value.get(id) ?? {
      left: placement.left,
      top: placement.top,
    }
    const headerVisible = 32
    const left = Math.min(
      viewportSize.value.width - headerVisible,
      Math.max(-popoverWidth + headerVisible, current.left + delta.x),
    )
    const top = Math.min(
      viewportSize.value.height - headerVisible,
      Math.max(0, current.top + delta.y),
    )
    const next = new Map(actionPopoverManual.value)
    next.set(id, { left, top })
    actionPopoverManual.value = next
  }
  // 模型消失（审批已处理/提问已答复）→ 清掉该 id 的手动位置、实测高度与打开态，重开后回自动定位。
  watch(
    () => defaultNodePopovers.value.map((model) => model.id),
    (ids) => {
      const idSet = new Set(ids)
      const nextManual = new Map(actionPopoverManual.value)
      const nextHeights = new Map(actionPopoverHeights.value)
      const nextOpen = new Set(actionPopoverOpenIds.value)
      for (const id of nextManual.keys()) if (!idSet.has(id)) nextManual.delete(id)
      for (const id of nextHeights.keys()) if (!idSet.has(id)) nextHeights.delete(id)
      for (const id of nextOpen) if (!idSet.has(id)) nextOpen.delete(id)
      actionPopoverManual.value = nextManual
      actionPopoverHeights.value = nextHeights
      actionPopoverOpenIds.value = nextOpen
    },
  )
  const defaultPopoverPlacements = computed(() => {
    const positioned = new Map(layout().nodes.map((node) => [node.id, node]))
    const heightLimit = Math.max(160, viewportSize.value.height - 96)
    return defaultNodePopovers.value.flatMap((model, order) => {
      // 审批/提问统一在工作台左下角审核窗口处理，节点只承担闪烁提示与定位，
      // 不再生成节点旁的第二个可交互审核窗口。
      if (model.approval || model.question) return []
      // 审批/提问交互卡只在用户点击（或外部定位）对应节点后打开；
      // 未打开的待处理模型仅驱动节点闪烁提示。
      if (!actionPopoverOpenIds.value.has(model.id)) return []
      const node = positioned.get(model.anchorNodeId)
      if (!node) return []
      const anchor = nodeScreenAnchor(node)
      const measured = actionPopoverHeights.value.get(model.id)
      const auto = anchoredPopoverPosition({
        anchor,
        viewport: viewportSize.value,
        panel: { width: popoverWidth, height: measured ?? popoverInitialHeight },
        margin: 12,
      })
      const manual = actionPopoverManual.value.get(model.id)
      const left = manual?.left ?? auto.left
      const top = manual?.top ?? auto.top
      const placement = manual
        ? anchor.x <= left + popoverWidth / 2
          ? ('left' as const)
          : ('right' as const)
        : auto.placement
      return [
        {
          id: model.id,
          anchor,
          panel: { width: popoverWidth, height: Math.min(heightLimit, 640) },
          main: node.main,
          actionable: true,
          pinned: false,
          order: model.createdAt || order,
          left,
          top,
          placement,
        },
      ]
    })
  })
  function defaultPopoverNodes(
    model: DefaultNodePopover,
  ): { anchor: ExecutionNode; display: ExecutionNode } | undefined {
    const anchor = layout().nodes.find((node) => node.id === model.anchorNodeId)
    if (!anchor) return undefined
    if (anchor.kind !== 'fold' && anchor.kind !== 'round') return { anchor, display: anchor }
    const member = memberContainingNode(anchor.fold?.members ?? [], model.displayNodeId)
    return { anchor, display: member?.displayNode ?? anchor }
  }
  function selectedActionCall(model: DefaultNodePopover): string | undefined {
    return actionSelectedCallIds.value.get(model.id) ?? model.selectedCallId
  }
  function selectActionCall(modelId: string, callId: string): void {
    const next = new Map(actionSelectedCallIds.value)
    next.set(modelId, callId)
    actionSelectedCallIds.value = next
  }
  const defaultPopoverViews = computed(() =>
    defaultPopoverPlacements.value.flatMap((placement) => {
      const model = defaultPopoverById.value.get(placement.id)
      if (!model) return []
      const nodes = defaultPopoverNodes(model)
      if (!nodes) return []
      return [
        {
          placement,
          model,
          ...nodes,
          relatedEdges: graph.value.edges.filter(
            (edge) => edge.from === nodes.anchor.id || edge.to === nodes.anchor.id,
          ),
        },
      ]
    }),
  )
  function resetActionPopovers(): void {
    actionSelectedCallIds.value = new Map()
  }
  return {
    actionSelectedCallIds,
    defaultNodePopovers,
    defaultPopoverAnchorIds,
    awaitingInteractionNodeIds,
    vMeasureHeight,
    recordActionPopoverHeight,
    dragActionPopover,
    defaultPopoverViews,
    selectedActionCall,
    selectActionCall,
    resetActionPopovers,
  }
}
