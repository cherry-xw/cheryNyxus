import { computed, nextTick, ref, shallowRef, watch, type Ref } from 'vue'
import type { TimelineNode } from '@/application/backend/public'
import type { MessageBranchTreeControllerProps } from './treeControllerTypes'
import type { useTreeGraphProjection } from './useTreeGraphProjection'
import {
  createIncrementalExecutionLayout,
  type PositionedExecutionNode,
} from '../graph/executionLayout'
import { projectExecutionPresentation } from '../graph/executionPresentation'
import { useTreeCanvas, type CanvasTransform } from '../composables/useTreeCanvas'
import {
  createExecutionViewportIndex,
  selectVisibleExecutionItems,
  viewportSelectionContainsCamera,
  visibleItemsKey,
  type ExecutionCamera,
} from '../renderer/executionViewport'
import type { ExecutionGraphPixiRenderer } from '../renderer/ExecutionGraphPixiRenderer'

/** Layout camera, viewport selection and initial/new-tail following. */
export function useTreeCamera({
  props,
  graph,
  timelineSnapshot,
  viewportRef,
  viewportSize,
  hoveredDetailNodeId,
  pinnedDetailNodeId,
  activePaperNodeId,
  runningTailIds,
  isInteractiveNode,
  renderer,
  snapCrts,
}: {
  props: MessageBranchTreeControllerProps
  graph: ReturnType<typeof useTreeGraphProjection>['graph']
  timelineSnapshot: ReturnType<typeof useTreeGraphProjection>['timelineSnapshot']
  viewportRef: Ref<HTMLElement | null>
  viewportSize: Ref<{ width: number; height: number }>
  hoveredDetailNodeId: Ref<string | undefined>
  pinnedDetailNodeId: Ref<string | undefined>
  activePaperNodeId: Ref<string | undefined>
  runningTailIds: () => Set<string>
  isInteractiveNode: (node: PositionedExecutionNode) => boolean
  renderer: () => ExecutionGraphPixiRenderer | undefined
  snapCrts: () => void
}) {
  const hasNewTail = ref(false)
  /** 已在图中出现过的节点 id；判定「回到底部」要用全新 id，排除末节点抖动。 */
  let knownTailIds = new Set<string>()
  const layoutEngine = createIncrementalExecutionLayout()
  const layout = computed(() =>
    projectExecutionPresentation(
      layoutEngine.layout(graph.value, {
        mode: props.layoutMode,
        branchPacking: props.foldMode === 'full' ? 'inward' : 'balanced',
      }),
      props.presentationMode ?? 'horizontal-signal',
    ),
  )
  const canvas = useTreeCanvas({
    viewport: () => viewportRef.value,
    contentBounds: () => layout.value.bounds,
    initialFocus: () =>
      layout.value.presentation === 'horizontal-signal'
        ? { x: layout.value.bounds.minX, y: layout.value.nodes[0]?.y ?? 0 }
        : { x: 0, y: layout.value.bounds.minY },
    minScale: 0.32,
    // 2026-09-02 调整：2.2 放大后节点超出阅读尺度，上限收敛到 1.6。
    maxScale: 1.6,
    padding: 18,
    deferDragCommit: true,
    onDragStart: startGpuDrag,
    onDragFrame: presentGpuDrag,
    onDragEnd: finishGpuDrag,
  })
  const executionCamera = computed<ExecutionCamera>(() => ({
    scale: canvas.scale.value,
    x: canvas.offsetX.value,
    y: canvas.offsetY.value,
    width: viewportSize.value.width,
    height: viewportSize.value.height,
  }))
  const viewportSelectionCamera = shallowRef<ExecutionCamera>(executionCamera.value)
  const VIEWPORT_RETENTION_SAFETY_MARGIN = 160
  /** 横向节点树右侧警戒线：最右节点屏幕位置超过视口宽度此比例（右侧留白 20%）时整体左移。 */
  const TREE_TAIL_EDGE_RATIO = 0.8
  const viewportRetentionOverscan = computed(() =>
    Math.max(480, Math.min(960, Math.max(viewportSize.value.width, viewportSize.value.height))),
  )
  const forcedGpuNodeIds = computed(
    () =>
      new Set(
        [
          hoveredDetailNodeId.value,
          pinnedDetailNodeId.value,
          props.paperMode ? activePaperNodeId.value : undefined,
          ...runningTailIds(),
        ].filter((id): id is string => !!id),
      ),
  )
  const executionViewportIndex = computed(() => createExecutionViewportIndex(layout.value))
  /** 全量渲染默认阈值（config 未配置时兜底）：节点数≤此值跳过视口裁剪。 */
  const TREE_FULL_RENDER_THRESHOLD_DEFAULT = 150
  const fullRenderThreshold = computed(() => {
    const configured = props.fullRenderThreshold ?? TREE_FULL_RENDER_THRESHOLD_DEFAULT
    // 卡牌模式打开右侧抽屉后画布被遮罩覆盖，收紧全量渲染阈值节省软件渲染纹理；
    // 流程图/阅读器抽屉同样覆盖画布、不改变视口尺寸，保持默认阈值。
    return props.paperMode ? Math.min(configured, 120) : configured
  })
  const fullRenderActive = computed(() => layout.value.nodes.length <= fullRenderThreshold.value)
  const visibleExecutionItems = computed(() =>
    selectVisibleExecutionItems(
      layout.value,
      viewportSelectionCamera.value,
      forcedGpuNodeIds.value,
      executionViewportIndex.value,
      viewportRetentionOverscan.value,
      fullRenderThreshold.value,
    ),
  )
  const visibleExecutionKey = computed(() => visibleItemsKey(visibleExecutionItems.value))
  const visibleInteractiveNodes = computed(() =>
    visibleExecutionItems.value.nodes.filter(
      // start 为纯装饰节点，默认不在命中层；工作台（非 staticView）下可点化以承载钢琴彩蛋首步。
      (node) => isInteractiveNode(node) || (!props.staticView && node.kind === 'start'),
    ),
  )
  function taskPlanForNode(
    node: PositionedExecutionNode,
  ): NonNullable<TimelineNode['todoPlan']> | undefined {
    if (node.sourceFact?.todoPlan) return node.sourceFact.todoPlan
    return node.fold?.projectionNodes
      .filter((member) => !!member.sourceFact?.todoPlan)
      .sort((a, b) => (b.orderKey ?? -Infinity) - (a.orderKey ?? -Infinity))[0]?.sourceFact
      ?.todoPlan
  }
  const taskPlanMarkerNodes = computed(() => {
    const latestByChat = new Map<string, { node: PositionedExecutionNode; orderKey: number }>()
    for (const node of layout.value.nodes) {
      let planOrder = node.orderKey ?? -Infinity
      const plan = taskPlanForNode(node)
      if (!plan) continue
      if (!node.sourceFact?.todoPlan) {
        planOrder =
          node.fold?.projectionNodes
            .filter((member) => !!member.sourceFact?.todoPlan)
            .sort((a, b) => (b.orderKey ?? -Infinity) - (a.orderKey ?? -Infinity))[0]?.orderKey ??
          planOrder
      }
      const previous = latestByChat.get(node.sourceChatId)
      if (!previous || planOrder > previous.orderKey) {
        latestByChat.set(node.sourceChatId, { node, orderKey: planOrder })
      }
    }
    const visible = new Set(visibleInteractiveNodes.value.map((node) => node.id))
    return [...latestByChat.values()].map(({ node }) => node).filter((node) => visible.has(node.id))
  })
  function taskPlanMarkerStyle(node: PositionedExecutionNode): Record<string, string> {
    const bounds = node.visualBounds
    const position = canvas.worldToScreen({
      x: bounds?.left ?? node.x - 52,
      y: node.y,
    })
    return { left: `${position.x}px`, top: `${position.y - 8}px` }
  }
  function focusRelativeNode(
    nodeId: string,
    direction: -1 | 1 | 'first' | 'last' | 'up' | 'down' | 'left' | 'right',
  ): void {
    const nodes = layout.value.nodes.filter(isInteractiveNode)
    if (nodes.length === 0) return
    const currentIndex = Math.max(
      0,
      nodes.findIndex((node) => node.id === nodeId),
    )
    const current = nodes[currentIndex]!
    let node
    if (direction === 'first') node = nodes[0]
    else if (direction === 'last') node = nodes.at(-1)
    else if (
      layout.value.presentation === 'horizontal-signal' &&
      (direction === 'up' || direction === 'down')
    ) {
      const sign = direction === 'up' ? -1 : 1
      node = nodes
        .filter((candidate) => (candidate.y - current.y) * sign > 0)
        .sort(
          (a, b) =>
            Math.abs(a.y - current.y) - Math.abs(b.y - current.y) ||
            Math.abs(a.x - current.x) - Math.abs(b.x - current.x),
        )[0]
    } else {
      const delta = direction === -1 || direction === 'left' || direction === 'up' ? -1 : 1
      node = nodes[Math.min(nodes.length - 1, Math.max(0, currentIndex + delta))]
    }
    if (!node) return
    const nextId = node.id
    const focusTarget = (): boolean => {
      const target = viewportRef.value?.querySelector<HTMLButtonElement>(
        `[data-execution-node-id="${CSS.escape(nextId)}"]`,
      )
      target?.focus()
      return !!target
    }
    if (!focusTarget()) {
      canvas.panToPoint(node)
      void nextTick(focusTarget)
    }
  }
  function dragExecutionCamera(transform: CanvasTransform): ExecutionCamera {
    return { ...transform, width: viewportSize.value.width, height: viewportSize.value.height }
  }
  function setDragOverlayTranslation(x: number, y: number): void {
    viewportRef.value?.style.setProperty('--tree-drag-x', `${x}px`)
    viewportRef.value?.style.setProperty('--tree-drag-y', `${y}px`)
  }
  function startGpuDrag(transform: CanvasTransform): void {
    renderer()?.setCamera(dragExecutionCamera(transform))
    renderer()?.setMotionPaused(true)
    viewportRef.value?.classList.add('is-panning')
    setDragOverlayTranslation(0, 0)
  }
  function retainCameraSelection(camera: ExecutionCamera): void {
    // Full-render scenes are camera-independent. Updating the selection ref here
    // would only invalidate Vue and repatch every transparent hit target per frame.
    if (fullRenderActive.value) return
    if (
      !viewportSelectionContainsCamera(
        visibleExecutionItems.value.bounds,
        camera,
        VIEWPORT_RETENTION_SAFETY_MARGIN,
      )
    ) {
      viewportSelectionCamera.value = camera
    }
  }
  function presentGpuDrag(transform: CanvasTransform): void {
    const camera = dragExecutionCamera(transform)
    // Freeze the expensive Pixi scene while panning. The already rendered canvas
    // and all camera-bound DOM overlays are translated as compositor bitmaps.
    setDragOverlayTranslation(
      transform.x - canvas.offsetX.value,
      transform.y - canvas.offsetY.value,
    )
    retainCameraSelection(camera)
  }
  function finishGpuDrag(transform: CanvasTransform): void {
    const camera = dragExecutionCamera(transform)
    renderer()?.setCamera(camera)
    retainCameraSelection(camera)
    renderer()?.setMotionPaused(false)
    snapCrts()
    void nextTick(() => {
      setDragOverlayTranslation(0, 0)
      viewportRef.value?.classList.remove('is-panning')
    })
  }
  function resetLayout(): boolean {
    // 横向 Signal：复位/切根/折叠切换后保持节点默认尺寸（scale 1），
    // 最右节点停在视口宽度 TREE_TAIL_EDGE_RATIO（80%）处，即距右缘 20%，
    // 与运行中新增节点的跟随目标一致；树不 fit 铺满整个页面、节点不缩小。
    // 其他模式（vertical-classic）继续整树自适应 fit。
    const horizontal = layout.value.presentation === 'horizontal-signal'
    if (
      !canvas.fitToView({
        animate: true,
        duration: 300,
        ...(horizontal
          ? ({ align: 'right', scale: 1, tailRatio: TREE_TAIL_EDGE_RATIO } as const)
          : {}),
      })
    ) {
      return false
    }
    return true
  }
  let initialFitPending = true
  function tryInitialFit(): void {
    // 数据请求完成前 graph 可能已有占位边界，不能据此结束首次 fit，否则真实历史到达后仍是默认相机。
    if (!initialFitPending || !timelineSnapshot.value) return
    if (resetLayout()) initialFitPending = false
  }
  watch(
    [
      () => timelineSnapshot.value?.revision,
      () => graph.value.nodes.length,
      () => layout.value.bounds.minX,
      () => layout.value.bounds.minY,
      () => layout.value.bounds.maxX,
      () => layout.value.bounds.maxY,
      () => viewportSize.value.width,
      () => viewportSize.value.height,
    ],
    () => void nextTick(tryInitialFit),
    { flush: 'post' },
  )
  // 横向 Signal：新节点出现后保持节点尺寸不变（不再重新 fit 缩小整棵树）。
  // 最右节点越过右侧警戒线时整体左移，让新节点继续从右侧出现。
  const signalTailRight = computed(() => {
    if (layout.value.presentation !== 'horizontal-signal') return Number.NEGATIVE_INFINITY
    let right = Number.NEGATIVE_INFINITY
    for (const node of layout.value.nodes) {
      const bounds = node.visualBounds
      if (bounds) right = Math.max(right, bounds.right)
    }
    return right
  })
  watch(
    signalTailRight,
    (right) => {
      // 首次进入/切根由 tryInitialFit 负责 fit，横向跟随只在已就绪后接管新增节点。
      if (right === Number.NEGATIVE_INFINITY || initialFitPending) return
      canvas.followContentEndX(right, TREE_TAIL_EDGE_RATIO)
    },
    { flush: 'post' },
  )
  watch(
    () => graph.value.nodes,
    (nodes) => {
      const known = knownTailIds
      knownTailIds = new Set(nodes.map((node) => node.id))
      const tailId = nodes.at(-1)?.id
      if (!tailId || known.size === 0) return
      if (canvas.userPanned.value && !known.has(tailId)) hasNewTail.value = true
    },
  )
  function returnToBottom(): void {
    hasNewTail.value = false
    const latest = layout.value.nodes.at(-1)
    if (latest) canvas.panToPoint(latest)
  }
  function resetCameraForRoot(): void {
    initialFitPending = true
    knownTailIds = new Set()
  }
  function resetCameraLayout(): void {
    layoutEngine.reset()
  }
  return {
    layout,
    canvas,
    executionCamera,
    viewportSelectionCamera,
    visibleExecutionItems,
    visibleExecutionKey,
    visibleInteractiveNodes,
    focusRelativeNode,
    taskPlanForNode,
    taskPlanMarkerNodes,
    taskPlanMarkerStyle,
    hasNewTail,
    resetLayout,
    tryInitialFit,
    returnToBottom,
    resetCameraForRoot,
    resetCameraLayout,
  }
}
