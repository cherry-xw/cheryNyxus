import { computed, ref, watch, type ComputedRef, type Ref } from 'vue'
import { gsap } from 'gsap'
import type { MessageBranchTreeControllerProps } from './treeControllerTypes'
import type { useTreeCanvas } from '../composables/useTreeCanvas'
import type { PositionedExecutionNode } from '../graph/executionLayout'
import type { ExecutionFoldMember } from '../graph/executionGraph'
import { projectExecutionPresentation } from '../graph/executionPresentation'
import { anchoredPopoverPositionBelow, toolBatchDetail } from '../graph/toolBatchDetails'
import { hasNodeHoverDetail } from '../graph/nodeSkins'
import {
  FOLD_WHEEL_NODE_GAP,
  FOLD_WHEEL_STAGE_HEIGHT,
  FOLD_WHEEL_STAGE_WIDTH,
} from '../graph/foldTabs'
import type { useTreeGraphProjection } from './useTreeGraphProjection'

/** Hover, pinned detail, frozen placement and drag/size lifetime. */
export function useTreeDetailWindow({
  props,
  graph,
  layout,
  canvas,
  viewportRef,
  viewportSize,
  hoveredDetailNodeId,
  pinnedDetailNodeId,
  selectedCallId,
  readingFoldId,
  selectedFoldMember,
  hasCrtAnchor,
  hasDefaultPopoverAnchor,
  popoverWidth,
  popoverInitialHeight,
}: {
  props: MessageBranchTreeControllerProps
  graph: ReturnType<typeof useTreeGraphProjection>['graph']
  layout: ComputedRef<ReturnType<typeof projectExecutionPresentation>>
  canvas: ReturnType<typeof useTreeCanvas>
  viewportRef: Ref<HTMLElement | null>
  viewportSize: Ref<{ width: number; height: number }>
  hoveredDetailNodeId: Ref<string | undefined>
  pinnedDetailNodeId: Ref<string | undefined>
  selectedCallId: Ref<string | undefined>
  readingFoldId: Ref<string | undefined>
  selectedFoldMember: (node: PositionedExecutionNode | undefined) => ExecutionFoldMember | undefined
  hasCrtAnchor: (id: string) => boolean
  hasDefaultPopoverAnchor: (id: string) => boolean
  popoverWidth: number
  popoverInitialHeight: number
}) {
  let detailHideTimer: ReturnType<typeof setTimeout> | undefined
  function cancelDetailHide(): void {
    if (detailHideTimer) clearTimeout(detailHideTimer)
    detailHideTimer = undefined
  }
  function showNodeDetail(node: (typeof layout.value.nodes)[number]): void {
    if (props.paperMode) return
    if (hasCrtAnchor(node.id) || hasDefaultPopoverAnchor(node.id)) return
    if (!hasNodeHoverDetail(node)) return
    cancelDetailHide()
    hoveredDetailNodeId.value = node.id
    if (node.kind === 'fold' || node.kind === 'round') readingFoldId.value = node.id
  }
  function hideNodeDetail(node: (typeof layout.value.nodes)[number]): void {
    if (props.paperMode) return
    if (pinnedDetailNodeId.value === node.id) return
    cancelDetailHide()
    detailHideTimer = setTimeout(() => {
      detailHideTimer = undefined
      if (!pinnedDetailNodeId.value && hoveredDetailNodeId.value === node.id) {
        hoveredDetailNodeId.value = undefined
        if (readingFoldId.value === node.id) readingFoldId.value = undefined
      }
    }, 180)
  }
  function keepNodeDetailOpen(): void {
    cancelDetailHide()
    if (detailNode.value?.kind === 'fold' || detailNode.value?.kind === 'round')
      readingFoldId.value = detailNode.value.id
  }
  function leaveNodeDetail(): void {
    if (pinnedDetailNodeId.value) return
    cancelDetailHide()
    detailHideTimer = setTimeout(() => {
      detailHideTimer = undefined
      hoveredDetailNodeId.value = undefined
      readingFoldId.value = undefined
    }, 180)
  }
  function closeNodeDetail(): void {
    cancelDetailHide()
    detailManualPos.value = null
    pinnedDetailNodeId.value = undefined
    hoveredDetailNodeId.value = undefined
    selectedCallId.value = undefined
    readingFoldId.value = undefined
  }
  const detailNode = computed(() => {
    const id = pinnedDetailNodeId.value ?? hoveredDetailNodeId.value
    if (!id) return undefined
    const exact = layout.value.nodes.find((node) => node.id === id)
    if (exact) return exact
    return layout.value.nodes.find(
      (node) =>
        node.fold?.members.some((member) =>
          member.nodes.some((memberNode) => memberNode.id === id),
        ) ||
        (!!selectedCallId.value &&
          toolBatchDetail(node)?.calls.some((call) => call.callId === selectedCallId.value)),
    )
  })
  const detailFoldMember = computed(() => selectedFoldMember(detailNode.value))
  const detailDisplayNode = computed(() =>
    detailNode.value?.kind === 'fold' || detailNode.value?.kind === 'round'
      ? detailFoldMember.value?.displayNode
      : detailNode.value,
  )
  /** 整轮三段式（轮次档位）：第一段用户提问与第三段主 Agent 最终回复节点。 */
  const detailRoundSections = computed(() => {
    const node = detailNode.value
    if (node?.kind !== 'round' || !node.round || !node.fold) return undefined
    const opening = node.fold.projectionNodes.find((item) => item.id === node.round!.openingNodeId)
    const reply = node.fold.projectionNodes.find((item) => item.id === node.round!.replyNodeId)
    if (!opening || !reply) return undefined
    return { opening, reply }
  })
  const detailPinned = computed(() => !!pinnedDetailNodeId.value && !!detailNode.value)
  function containsBranchAnchor(node: (typeof layout.value.nodes)[number]): boolean {
    const anchorId = props.branchAnchorNodeId
    if (!anchorId) return false
    if (node.id === anchorId || node.sourceFact?.id === anchorId) return true
    return !!node.fold?.members.some(
      (member) =>
        member.id === anchorId ||
        member.displayNode.sourceFact?.id === anchorId ||
        member.nodes.some(
          (candidate) => candidate.id === anchorId || candidate.sourceFact?.id === anchorId,
        ),
    )
  }
  const detailRelatedEdges = computed(() => {
    const node = detailNode.value
    return node
      ? graph.value.edges.filter((edge) => edge.from === node.id || edge.to === node.id)
      : []
  })
  /** hover 临时弹窗最大高度（2026-09-27 下调：配合宽度加宽成横宽「显示器」式，小屏更易看到底部内容）。 */
  const detailMaxHeight = computed(() => {
    return Math.min(480, Math.max(160, viewportSize.value.height - 96))
  })
  /** 详情弹窗实测高度。冻结契约（2026-09-02）下仅在冻结决策前已测得时参与定位，
   *  否则用初始回退值；会话内不随实测回填重排。切节点时清零，旧节点高度不串位。 */
  const detailAnchorEl = ref<HTMLElement>()
  const measuredDetailHeight = ref(0)
  let detailHeightRO: ResizeObserver | undefined
  watch(detailAnchorEl, (el) => {
    detailHeightRO?.disconnect()
    detailHeightRO = undefined
    measuredDetailHeight.value = 0
    if (!el) return
    detailHeightRO = new ResizeObserver(() => {
      const height = el.offsetHeight
      if (height > 0 && height !== measuredDetailHeight.value) measuredDetailHeight.value = height
    })
    detailHeightRO.observe(el)
  })
  /** 详情弹窗被用户拖动后的手动位置；null = 跟随自动定位。hover 窗口首次拖动时会升级为常驻窗口。 */
  const detailManualPos = ref<{ left: number; top: number } | null>(null)
  const detailSize = ref({ width: 640, height: 520 })
  const detailWrap = ref(false)
  function nodeScreenAnchor(node: (typeof layout.value.nodes)[number]) {
    const centre = canvas.worldToScreen(node)
    const bounds = node.visualBounds
    if (!bounds) return centre
    const worldX = centre.x <= viewportSize.value.width / 2 ? bounds.right : bounds.left
    return canvas.worldToScreen({ x: worldX, y: node.y })
  }
  /** 悬浮窗下方锚点：节点底沿中点的屏幕坐标（弹窗出现在节点正下方，横竖排版通用）。 */
  function nodeScreenAnchorBelow(node: (typeof layout.value.nodes)[number]) {
    const centre = canvas.worldToScreen(node)
    const bounds = node.visualBounds
    if (!bounds) return { x: centre.x, y: centre.y + 28 }
    return canvas.worldToScreen({ x: node.x, y: bounds.bottom })
  }
  /**
   * 详情弹窗拖拽（2026-09-02 返工契约）：hover 窗口首次产生有效位移时
   * 立即升级为常驻窗口，此后鼠标移出不再自动关闭；pointermove 期间 quickSetter 直写
   * transform x/y（与树平移的 CSS `translate` 属性分属不同通道，可叠加），不触发
   * 每帧响应式 patch；`finishDetailDrag`（弹窗 dragEnd）才把终值一次性落回
   * `detailManualPos` 并清除直写 transform——落回与清写同帧完成，无闪烁。
   */
  let detailDragState: { baseLeft: number; baseTop: number; left: number; top: number } | null =
    null
  let detailDragSetters:
    { x: ReturnType<typeof gsap.quickSetter>; y: ReturnType<typeof gsap.quickSetter> } | undefined
  function dragDetailPopover(delta: { x: number; y: number }): void {
    const current = detailPlacement.value
    if (!current) return
    if (!detailDragState) {
      const baseLeft = parseFloat(current.style.left)
      const baseTop = parseFloat(current.style.top)
      detailDragState = { baseLeft, baseTop, left: baseLeft, top: baseTop }
      const node = detailNode.value
      if (!pinnedDetailNodeId.value && node) {
        cancelDetailHide()
        pinnedDetailNodeId.value = node.id
        hoveredDetailNodeId.value = node.id
        detailManualPos.value = { left: baseLeft, top: baseTop }
      }
    }
    const headerVisible = 32
    detailDragState.left = Math.min(
      viewportSize.value.width - headerVisible,
      Math.max(-detailSize.value.width + headerVisible, detailDragState.left + delta.x),
    )
    detailDragState.top = Math.min(
      viewportSize.value.height - headerVisible,
      Math.max(0, detailDragState.top + delta.y),
    )
    const element = detailAnchorEl.value
    if (element) {
      detailDragSetters ??= {
        x: gsap.quickSetter(element, 'x', 'px'),
        y: gsap.quickSetter(element, 'y', 'px'),
      }
      detailDragSetters.x(detailDragState.left - detailDragState.baseLeft)
      detailDragSetters.y(detailDragState.top - detailDragState.baseTop)
    }
  }
  function finishDetailDrag(): void {
    if (!detailDragState) return
    detailManualPos.value = { left: detailDragState.left, top: detailDragState.top }
    detailDragState = null
    detailDragSetters = undefined
    const element = detailAnchorEl.value
    if (element) gsap.set(element, { x: 0, y: 0, clearProps: 'transform' })
  }
  /**
   * 常驻详情窗口尺寸档位（2026-09-15 变更）：取消 8 向拖拽 resize，改由头部
   * 「尺寸切换」按钮在 S/M/L 三档间循环，避免用户手动拖拽窗口尺寸。
   * - S：当前默认尺寸（640×520），即原 M 档，用户实测“刚刚好”；
   * - M：按 S 宽度 +25%（800×650）；
   * - L：按 S 宽度 +50%（960×780）。
   * 换档只更新 detailSize；未拖过位置的窗口继续自动定位，拖过的位置会回收进视口。
   */
  function detailSizePresets(): Array<{ width: number; height: number; label: string }> {
    return [
      { width: 640, height: 520, label: 'S' },
      { width: 800, height: 650, label: 'M' },
      { width: 960, height: 780, label: 'L' },
    ]
  }
  const detailSizeLabel = computed(() => {
    const preset = detailSizePresets().find(
      (item) => item.width === detailSize.value.width && item.height === detailSize.value.height,
    )
    return preset?.label ?? 'M'
  })
  function cycleDetailSize(): void {
    const presets = detailSizePresets()
    const index = presets.findIndex(
      (item) => item.width === detailSize.value.width && item.height === detailSize.value.height,
    )
    const next = presets[(index + 1) % presets.length] ?? { width: 640, height: 520, label: 'S' }
    detailSize.value = { width: next.width, height: next.height }
    if (detailManualPos.value) {
      const vp = viewportSize.value
      detailManualPos.value = {
        left: Math.min(
          Math.max(24, detailManualPos.value.left),
          Math.max(24, vp.width - next.width - 24),
        ),
        top: Math.min(
          Math.max(0, detailManualPos.value.top),
          Math.max(0, vp.height - next.height - 12),
        ),
      }
    }
  }
  function toggleDetailWrap(): void {
    detailWrap.value = !detailWrap.value
  }
  /**
   * 详情弹窗定位冻结契约（2026-09-02）：一次显示会话只求值一次位置。
   * 显示会话 = hover 换到新节点，或弹窗关闭后重新显示；会话内实测高度回填、
   * 画布缩放/平移、视口 resize 均不改变弹窗位置（屏幕坐标完全冻结）。
   * hover → pinned 切换不算新会话；pinned 拖拽经 `detailManualPos`、
   * 尺寸档位切换经 `detailSize` 覆盖冻结位置。
   */
  interface DetailPlacementDecision {
    left: number
    top: number
    anchorX: number
    placement: 'left' | 'right' | 'below'
    railSide: 'left' | 'right'
    nodeOffset: { x: number; y: number }
  }
  let frozenDetailPlacement: DetailPlacementDecision | null = null
  watch(
    () => detailNode.value?.id,
    () => {
      frozenDetailPlacement = null
      // 冻结决策只用本次会话的初始高度：上个节点的实测高度不参与新节点定位。
      measuredDetailHeight.value = 0
    },
  )
  /** 一次性求值自动定位决策：优先节点正下方，下方放不下回退侧贴；左轮默认贴弹窗左侧。 */
  function decideDetailPlacement(): DetailPlacementDecision {
    const node = detailNode.value
    if (!node) {
      return {
        left: 0,
        top: 0,
        anchorX: 0,
        placement: 'below',
        railSide: 'left',
        nodeOffset: { x: 0, y: FOLD_WHEEL_STAGE_HEIGHT / 2 },
      }
    }
    // 悬浮窗优先出现在节点正下方（横竖排版一致）；下方放不下才回退右侧优先的侧贴逻辑。
    const anchor = nodeScreenAnchorBelow(node)
    const auto = anchoredPopoverPositionBelow({
      anchor,
      viewport: viewportSize.value,
      panel: detailPinned.value
        ? detailSize.value
        : { width: popoverWidth, height: measuredDetailHeight.value || popoverInitialHeight },
      margin: 12,
    })
    const panelWidth = detailPinned.value ? detailSize.value.width : popoverWidth
    // 左轮与弹窗并排、顶对齐（统一落在节点下方区域）：默认贴弹窗左侧，左侧视口
    // 空间不足改贴弹窗右侧，两侧都放不下时钳制在视口内。锚点为弹窗容器相对坐标，
    // 左轮随弹窗容器移动（pinned 拖动时保持相对位置）。
    let railSide: 'left' | 'right' = 'left'
    let railAnchorX = 0 // side='left' 时 nav 左缘 = railAnchorX - STAGE_WIDTH - NODE_GAP
    if (auto.left - FOLD_WHEEL_STAGE_WIDTH - FOLD_WHEEL_NODE_GAP < 12) {
      railSide = 'right'
      railAnchorX = panelWidth // side='right' 时 nav 左缘 = railAnchorX + NODE_GAP
      if (
        auto.left + panelWidth + FOLD_WHEEL_NODE_GAP + FOLD_WHEEL_STAGE_WIDTH >
        viewportSize.value.width - 12
      ) {
        // 两侧都放不下（极窄视口）：钳回左侧贴视口边距，允许与弹窗轻微重叠。
        railSide = 'left'
        railAnchorX = Math.max(0, 12 - auto.left + FOLD_WHEEL_STAGE_WIDTH + FOLD_WHEEL_NODE_GAP)
      }
    }
    return {
      left: auto.left,
      top: auto.top,
      anchorX: anchor.x,
      placement: auto.placement,
      railSide,
      nodeOffset: { x: railAnchorX, y: FOLD_WHEEL_STAGE_HEIGHT / 2 },
    }
  }
  const detailPlacement = computed(() => {
    const node = detailNode.value
    const viewport = viewportRef.value
    if (!node || !viewport) return undefined
    frozenDetailPlacement ??= decideDetailPlacement()
    const decision = frozenDetailPlacement
    const manual = detailPinned.value ? detailManualPos.value : undefined
    const left = manual?.left ?? decision.left
    const top = manual?.top ?? decision.top
    const panelWidth = detailPinned.value ? detailSize.value.width : popoverWidth
    const placement = manual
      ? decision.anchorX <= left + panelWidth / 2
        ? ('left' as const)
        : ('right' as const)
      : decision.placement
    return {
      style: {
        left: `${left}px`,
        top: `${top}px`,
        ...(detailPinned.value
          ? { width: `${detailSize.value.width}px`, height: `${detailSize.value.height}px` }
          : {}),
      },
      nodeOffset: decision.nodeOffset,
      railSide: decision.railSide,
      placement,
    }
  })
  const detailAnchorStyle = computed(() => detailPlacement.value?.style)
  const foldRailSide = computed<'left' | 'right'>(() => {
    const placement = detailPlacement.value
    if (!placement) return 'left'
    return placement.railSide
  })
  function cleanupDetail(): void {
    detailHeightRO?.disconnect()
    cancelDetailHide()
  }
  return {
    showNodeDetail,
    hideNodeDetail,
    keepNodeDetailOpen,
    leaveNodeDetail,
    closeNodeDetail,
    detailNode,
    detailFoldMember,
    detailDisplayNode,
    detailRoundSections,
    detailPinned,
    detailRelatedEdges,
    detailMaxHeight,
    detailAnchorEl,
    detailWrap,
    nodeScreenAnchor,
    dragDetailPopover,
    finishDetailDrag,
    detailSizeLabel,
    cycleDetailSize,
    toggleDetailWrap,
    detailPlacement,
    detailAnchorStyle,
    foldRailSide,
    containsBranchAnchor,
    cleanupDetail,
  }
}
