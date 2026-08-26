/**
 * Canonical execution tree consumer with CP5 input, CP6 details, and CP7 folds.
 *
 * The component is intentionally a thin renderer: topology and coordinates
 * come from pure graph modules, while this layer owns only the canvas gesture
 * and visual skin. Later checkpoints add termination controls and CRT anchoring.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, shallowRef, watch } from 'vue'
import { useNyxusHost } from '../application/host'
import { useThemeTokens } from '@/composables/useThemeTokens'
import { effectiveRootLiveState } from '@/application/chat/public'
import {
  mainExecutionEndpoint,
  projectActiveTurnNodes,
  projectInputNodes,
  projectPersistentExecutionGraph,
  type ExecutionFoldMember,
  type ExecutionNode,
  type VirtualInputNode,
} from '../graph/executionGraph'
import {
  projectFoldExecutionGraph,
  projectFullFoldExecutionGraph,
  projectParticipantFoldExecutionGraph,
} from '../graph/foldProjection'
import { projectCoreFlowExecutionGraph } from '../graph/coreFlowProjection'
import {
  createIncrementalExecutionLayout,
  type ExecutionLayoutMode,
} from '../graph/executionLayout'
import { DETAIL_BRANCH_COLOR, edgeStyle } from '../graph/edgeStyles'
import {
  accentForTheme,
  canPinNodeDetail,
  hasNodeHoverDetail,
  skinForNode,
} from '../graph/nodeSkins'
import {
  anchoredPopoverPosition,
  oppositePopoverPlacement,
  toolBatchDetail,
} from '../graph/toolBatchDetails'
import { useTreeCanvas, type CanvasTransform } from '../composables/useTreeCanvas'
import { pendingInputAnchor, pendingInputPhase } from '../composables/mainInputState'
import ExecutionNodePopover from './ExecutionNodePopover.vue'
import FoldTabRail from './FoldTabRail.vue'
import AnchoredRunCrt from './AnchoredRunCrt.vue'
import NodePaperStack from './NodePaperStack.vue'
import GenerationTreeDialog from './GenerationTreeDialog.vue'
import { terminationDisplay } from '../graph/termination'
import { buildRunCrtModels, effectiveRunFacts, type RunCrtModel } from '../graph/crtModel'
import { layoutCrtWindowsBesideAnchors, selectVisibleCrtIds } from '../graph/crtLayout'
import { buildDefaultNodePopovers, type DefaultNodePopover } from '../graph/nodePopoverModel'
import {
  ExecutionGraphPixiRenderer,
  type PixiExecutionScene,
} from '../renderer/ExecutionGraphPixiRenderer'
import { executionSceneSignature } from '../renderer/executionSceneSignature'
import {
  createExecutionViewportIndex,
  selectVisibleExecutionItems,
  viewportSelectionContainsCamera,
  visibleItemsKey,
  type ExecutionCamera,
} from '../renderer/executionViewport'
import type { RootTimelineSnapshot } from '@/application/backend/public'
import { buildPaperStack } from '../paper/paperStackModel'

export type MessageBranchTreeControllerProps = {
    rootChatId: string
    timelineOverride?: RootTimelineSnapshot
    branchAnchorNodeId?: string
    branchAnchorKind?: 'detail' | 'continuation'
    detailBranchAvailable?: boolean
    detailBranchUnavailableReason?: string
    layoutMode?: ExecutionLayoutMode
    foldMode?: 'none' | 'partial' | 'full' | 'participant'
    focusSourceChatId?: string
    focusInteractionId?: string
    /** 节点数≤此值跳过视口裁剪全量渲染（消除平移卡顿）。undefined → 用默认阈值。 */
    fullRenderThreshold?: number
    paperMode?: boolean
    /** Parent workbench is minimized/hidden; keep state but suspend GPU work. */
    suspended?: boolean
    /** 静态历史视图（代际二层弹窗）：挂断 live 投影（输入/流式/CRT），仅渲染 timelineOverride。 */
    staticView?: boolean
  }
export type MessageBranchTreeControllerEmits = {
  branch: [
    payload: {
      type: 'detail' | 'continuation'
      nodeId: string
      sourceRootChatId: string
      ordinary?: boolean
    },
  ]
  /** 用户激活了带待处理交互（审批/提问）的节点 → 父级同步到待操作面板聚焦。 */
  interactionFocus: [focus: { chatId: string; interactionId?: string; anchorNodeId?: string }]
}
type ControllerEmit<T> = <K extends keyof T>(event: K, ...args: T[K] extends unknown[] ? T[K] : never) => void

export function useMessageBranchTreeController(props: MessageBranchTreeControllerProps, emit: ControllerEmit<MessageBranchTreeControllerEmits>): any {
  const { chats: chatSessions, agents, theme: themeStore } = useNyxusHost()
  const { canvasPalette } = useThemeTokens()
  const viewportRef = ref<HTMLElement | null>(null)
  const pixiMountRef = ref<HTMLElement | null>(null)
  const hoveredDetailNodeId = ref<string>()
  const pinnedDetailNodeId = ref<string>()
  const selectedCallId = ref<string>()
  const selectedFoldMembers = ref<Map<string, string>>(new Map())
  const unreadFoldMembers = ref<Map<string, number>>(new Map())
  const readingFoldId = ref<string>()
  const viewportSize = ref({ width: 0, height: 0 })
  const pinnedCrtIds = ref<Set<string>>(new Set())
  const hiddenCrtIds = ref<Set<string>>(new Set())
  const crtWindowState = ref<Map<string, { left: number; top: number; z: number }>>(new Map())
  let nextCrtZ = 1
  const actionSelectedCallIds = ref<Map<string, string>>(new Map())
  const recoveringGraph = ref(false)
  const recoveryError = ref('')
  const gpuRenderError = ref('')
  const hasNewTail = ref(false)
  /** 已在图中出现过的节点 id；判定「回到底部」要用全新 id，排除末节点抖动。 */
  let knownTailIds = new Set<string>()
  let gpuRenderer: ExecutionGraphPixiRenderer | undefined
  let gpuMountGeneration = 0
  let lastGpuSceneSignature = ''
  let detailHideTimer: ReturnType<typeof setTimeout> | undefined
  const timelineSnapshot = computed(
    () => props.timelineOverride ?? chatSessions.rootTimeline(props.rootChatId, 'tree'),
  )
  const timelineNodes = computed(() => timelineSnapshot.value?.nodes ?? [])
  const rootTransientState = computed(() => chatSessions.rootTimelineStates[props.rootChatId])
  const liveState = computed(() =>
    props.staticView
      ? { activeTurns: [], activeRuns: [] }
      : effectiveRootLiveState(props.rootChatId, rootTransientState.value, chatSessions.sessionsById),
  )
  let cachedActiveRunKey = ''
  let cachedActiveCrtRuns: ReturnType<typeof effectiveRunFacts> = []
  const activeCrtRuns = computed(() => {
    // Token deltas change turn content but not run topology. Keep the durable
    // projection graph from rebuilding until run IDs/statuses actually change.
    const canonicalRuns = timelineSnapshot.value?.activeRuns ?? []
    const key = [
      props.rootChatId,
      ...canonicalRuns.map((run) => `${run.chatId ?? ''}:${run.runId ?? ''}:${run.status ?? ''}`),
      ...liveState.value.activeRuns.map(
        (run) => `${run.chatId ?? ''}:${run.runId ?? ''}:${run.status ?? run.state ?? ''}`,
      ),
      ...liveState.value.activeTurns.map(
        (turn) => `${turn.chatId ?? ''}:${turn.runId ?? ''}:${turn.turnId}:${turn.status}`,
      ),
    ].join('\u0001')
    if (key === cachedActiveRunKey) return cachedActiveCrtRuns
    cachedActiveRunKey = key
    cachedActiveCrtRuns = effectiveRunFacts(
      props.rootChatId,
      canonicalRuns,
      liveState.value.activeRuns,
      liveState.value.activeTurns,
    )
    return cachedActiveCrtRuns
  })
  const pendingInputs = computed<VirtualInputNode[]>(() => {
    if (props.staticView) return []
    const rootState = rootTransientState.value
    const latest = Math.max(0, ...timelineNodes.value.map((node) => node.createdAt))
    return (rootState?.pendingInputs ?? [])
      .filter((input) => !input.chatId || input.chatId === props.rootChatId)
      .filter((input) => input.state !== 'cancelled' && input.state !== 'rejected')
      .map((input, index) => ({
        id: pendingInputAnchor(input),
        content: input.content,
        createdAt: input.acceptedAt ?? latest + index + 1,
        state: pendingInputPhase(input),
        ...(input.queueSequence === undefined ? {} : { queueSequence: input.queueSequence }),
      }))
      .sort(
        (a, b) =>
          (a.queueSequence ?? Number.MAX_SAFE_INTEGER) -
            (b.queueSequence ?? Number.MAX_SAFE_INTEGER) ||
          a.createdAt - b.createdAt ||
          a.id.localeCompare(b.id),
      )
  })
  const persistentGraph = computed(() =>
    projectPersistentExecutionGraph(
      timelineSnapshot.value
        ? { ...timelineSnapshot.value, activeRuns: activeCrtRuns.value }
        : {
            rootChatId: props.rootChatId,
            nodes: [],
            edges: [],
            activeRuns: activeCrtRuns.value,
            generations: [],
          },
    ),
  )
  const liveGraph = computed(() =>
    projectActiveTurnNodes(
      projectInputNodes(persistentGraph.value, pendingInputs.value),
      liveState.value.activeTurns,
      activeCrtRuns.value,
    ),
  )
  const foldProjection = computed(() => {
    if (props.foldMode === 'none') return { graph: liveGraph.value, ranges: [] }
    if (props.foldMode === 'full') return projectFullFoldExecutionGraph(liveGraph.value)
    if (props.foldMode === 'participant') return projectParticipantFoldExecutionGraph(liveGraph.value)
    return projectFoldExecutionGraph(liveGraph.value)
  })
  const graph = computed(() => foldProjection.value.graph)
  const coreFlowProjection = computed(() => projectCoreFlowExecutionGraph(graph.value))
  const paperGraph = computed(() => coreFlowProjection.value.paperGraph)
  type CachedPaperEntry = {
    version: string
    entry: ReturnType<typeof buildPaperStack>[number]
  }
  let paperEntryCache = new Map<string, CachedPaperEntry>()
  function paperTextHash(value?: string): number {
    if (!value) return 0
    let hash = 2166136261
    for (let index = 0; index < value.length; index += 1) {
      hash ^= value.charCodeAt(index)
      hash = Math.imul(hash, 16777619)
    }
    return hash >>> 0
  }
  function paperNodeVersion(node: ExecutionNode): string {
    const fact = node.sourceFact
    const own = [
      node.id,
      node.status,
      node.inputState ?? '',
      paperTextHash(node.content),
      paperTextHash(node.thinking),
      fact?.updatedAt ?? '',
      fact?.status ?? '',
      ...(fact?.toolCalls ?? []).flatMap((call) => [
        call.callId ?? '',
        call.status ?? '',
        paperTextHash(call.arguments),
        paperTextHash(call.result),
      ]),
    ]
    if (node.kind === 'fold') {
      own.push(
        ...(node.fold?.members ?? []).flatMap((member) => {
          const display = member.displayNode
          return [
            display.id,
            display.status,
            display.sourceFact?.updatedAt ?? '',
            paperTextHash(display.content),
            paperTextHash(display.thinking),
          ]
        }),
      )
    }
    return own.join('\u0001')
  }
  const paperEntries = computed(() => {
    const nextCache = new Map<string, CachedPaperEntry>()
    const entries = buildPaperStack(paperGraph.value.nodes, nodeTitle).map((entry) => {
      const version = paperNodeVersion(entry.node)
      const cached = paperEntryCache.get(entry.id)
      const stable =
        cached?.version === version && cached.entry.title === entry.title ? cached.entry : entry
      nextCache.set(entry.id, { version, entry: stable })
      return stable
    })
    paperEntryCache = nextCache
    return entries
  })
  const activePaperNodeId = ref<string>()
  const paperHasNewTail = ref(false)
  const paperCurrentIndex = computed(() => {
    const index = paperEntries.value.findIndex((entry) => entry.id === activePaperNodeId.value)
    return index >= 0 ? index : Math.max(0, paperEntries.value.length - 1)
  })
  const defaultNodePopovers = computed(() =>
    buildDefaultNodePopovers(graph.value.nodes, chatSessions.sessionsById),
  )
  const activePaperQuestionPopover = computed(() => {
    if (!props.paperMode || !activePaperNodeId.value) return undefined
    return defaultNodePopovers.value.find(
      (model) => model.question && model.anchorNodeId === activePaperNodeId.value,
    )
  })
  const defaultPopoverById = computed(
    () => new Map(defaultNodePopovers.value.map((model) => [model.id, model] as const)),
  )
  const defaultPopoverAnchorIds = computed(
    () => new Set(defaultNodePopovers.value.map((model) => model.anchorNodeId)),
  )
  const endpointFoldProjection = computed(() => {
    if (props.foldMode === 'none') return { graph: liveGraph.value, ranges: [] }
    if (props.foldMode === 'full') return projectFullFoldExecutionGraph(liveGraph.value)
    if (props.foldMode === 'participant') return projectParticipantFoldExecutionGraph(liveGraph.value)
    return projectFoldExecutionGraph(liveGraph.value)
  })
  const endpointGraph = computed(() => endpointFoldProjection.value.graph)
  const layoutEngine = createIncrementalExecutionLayout()
  const endpointLayoutEngine = createIncrementalExecutionLayout()
  const layout = computed(() =>
    layoutEngine.layout(graph.value, {
      mode: props.layoutMode,
      branchPacking: props.foldMode === 'full' ? 'inward' : 'balanced',
    }),
  )
  const endpointLayout = computed(() =>
    endpointLayoutEngine.layout(endpointGraph.value, {
      mode: props.layoutMode,
      branchPacking: props.foldMode === 'full' ? 'inward' : 'balanced',
    }),
  )
  const canvas = useTreeCanvas({
    viewport: () => viewportRef.value,
    contentBounds: () => layout.value.bounds,
    initialFocus: () => ({ x: 0, y: layout.value.bounds.minY }),
    minScale: 0.32,
    maxScale: 2.2,
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
  const VIEWPORT_RETENTION_OVERSCAN = 1600
  const VIEWPORT_RETENTION_SAFETY_MARGIN = 240
  const forcedGpuNodeIds = computed(
    () =>
      new Set(
        [
          hoveredDetailNodeId.value,
          pinnedDetailNodeId.value,
          props.paperMode ? activePaperNodeId.value : undefined,
          ...runningTailIds.value,
        ].filter((id): id is string => !!id),
      ),
  )
  const executionViewportIndex = computed(() => createExecutionViewportIndex(layout.value))
  /** 全量渲染默认阈值（config 未配置时兜底）：节点数≤此值跳过视口裁剪。 */
  const TREE_FULL_RENDER_THRESHOLD_DEFAULT = 500
  const fullRenderThreshold = computed(
    () => {
      const configured = props.fullRenderThreshold ?? TREE_FULL_RENDER_THRESHOLD_DEFAULT
      // The reader leaves only half a viewport for the graph. Avoid keeping hundreds
      // of offscreen text textures in the software-rendered Electron canvas.
      return props.paperMode ? Math.min(configured, 120) : configured
    },
  )
  const fullRenderActive = computed(() => layout.value.nodes.length <= fullRenderThreshold.value)
  const visibleExecutionItems = computed(() =>
    selectVisibleExecutionItems(
      layout.value,
      viewportSelectionCamera.value,
      forcedGpuNodeIds.value,
      executionViewportIndex.value,
      VIEWPORT_RETENTION_OVERSCAN,
      fullRenderThreshold.value,
    ),
  )
  const visibleExecutionKey = computed(() => visibleItemsKey(visibleExecutionItems.value))
  const visibleInteractiveNodes = computed(() =>
    visibleExecutionItems.value.nodes.filter(isInteractiveNode),
  )
  function dragExecutionCamera(transform: CanvasTransform): ExecutionCamera {
    return { ...transform, width: viewportSize.value.width, height: viewportSize.value.height }
  }
  function setDragOverlayTranslation(x: number, y: number): void {
    viewportRef.value?.style.setProperty('--tree-drag-x', `${x}px`)
    viewportRef.value?.style.setProperty('--tree-drag-y', `${y}px`)
  }
  function startGpuDrag(transform: CanvasTransform): void {
    gpuRenderer?.setCamera(dragExecutionCamera(transform))
    gpuRenderer?.setMotionPaused(true)
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
    setDragOverlayTranslation(transform.x - canvas.offsetX.value, transform.y - canvas.offsetY.value)
    retainCameraSelection(camera)
  }
  function finishGpuDrag(transform: CanvasTransform): void {
    const camera = dragExecutionCamera(transform)
    gpuRenderer?.setCamera(camera)
    retainCameraSelection(camera)
    gpuRenderer?.setMotionPaused(false)
    snapCrtWindowsToAnchors()
    void nextTick(() => {
      setDragOverlayTranslation(0, 0)
      viewportRef.value?.classList.remove('is-panning')
    })
  }
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
            anchor: canvas.worldToScreen(node),
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
      const anchor = canvas.worldToScreen(node)
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
  /** 定位高度未测到前的合理小初始值：避免用视口上限高度参与垂直钳制导致矮窗「飘高」。 */
  const POPOVER_INITIAL_HEIGHT = 220
  /** 审批/提问等 action 弹窗被用户拖动后的手动位置；缺省 = 跟随自动定位（贴节点右侧）。 */
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
      ;(el as HTMLElement & { __popoverMeasureCallback?: (height: number) => void })
        .__popoverMeasureCallback = binding.value
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
      Math.max(-480 + headerVisible, current.left + delta.x),
    )
    const top = Math.min(
      viewportSize.value.height - headerVisible,
      Math.max(0, current.top + delta.y),
    )
    const next = new Map(actionPopoverManual.value)
    next.set(id, { left, top })
    actionPopoverManual.value = next
  }
  // 模型消失（审批已处理/提问已答复）→ 清掉该 id 的手动位置与实测高度，重开后回自动定位。
  watch(
    () => defaultNodePopovers.value.map((model) => model.id),
    (ids) => {
      const idSet = new Set(ids)
      const nextManual = new Map(actionPopoverManual.value)
      const nextHeights = new Map(actionPopoverHeights.value)
      for (const id of nextManual.keys()) if (!idSet.has(id)) nextManual.delete(id)
      for (const id of nextHeights.keys()) if (!idSet.has(id)) nextHeights.delete(id)
      actionPopoverManual.value = nextManual
      actionPopoverHeights.value = nextHeights
    },
  )
  const defaultPopoverPlacements = computed(() => {
    const positioned = new Map(layout.value.nodes.map((node) => [node.id, node]))
    const heightLimit = Math.max(160, viewportSize.value.height - 96)
    return defaultNodePopovers.value.flatMap((model, order) => {
      const node = positioned.get(model.anchorNodeId)
      if (!node) return []
      const anchor = canvas.worldToScreen(node)
      const measured = actionPopoverHeights.value.get(model.id)
      const auto = anchoredPopoverPosition({
        anchor,
        viewport: viewportSize.value,
        panel: { width: 480, height: measured ?? POPOVER_INITIAL_HEIGHT },
        margin: 12,
      })
      const manual = actionPopoverManual.value.get(model.id)
      const left = manual?.left ?? auto.left
      const top = manual?.top ?? auto.top
      const placement = manual
        ? anchor.x <= left + 480 / 2
          ? ('left' as const)
          : ('right' as const)
        : auto.placement
      return [
        {
          id: model.id,
          anchor,
          panel: { width: 480, height: Math.min(heightLimit, 640) },
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
  function actorLabel(node: ExecutionNode): string {
    const actor = node.actor
    if (actor.kind === 'user') return actor.displayName?.trim() || '我'
    if (actor.kind === 'agent') {
      return (
        actor.roleType?.trim() ||
        (node.sourceChatId === node.rootChatId ? 'Cherry Nyxus' : '协作节点')
      )
    }
    if (actor.kind === 'tool') return toolDisplayName(actor.toolName)
    return '系统事件'
  }
  function toolDisplayName(name: string): string {
    return agents.senseTools.find((tool) => tool.name === name)?.label?.trim() || name
  }
  function nodeTitle(node: ExecutionNode): string {
    if (node.kind === 'start') return '任务起点'
    if (node.kind === 'input') return '我的指令'
    if (node.kind === 'pack') {
      // 打包节点标题 = 摘要首行（compactNodeTitle 统一截断）。
      const firstLine = node.content
        .split('\n')
        .map((line) => line.trim())
        .find(Boolean)
      return firstLine ? `打包 · ${firstLine}` : '打包历史'
    }
    if (node.kind === 'return') return '结果返回'
    if (node.direction === 'parent-to-child') return '委派任务'
    if (node.kind === 'tool-batch') {
      const detail = toolBatchDetail(node)
      if (detail?.calls.length === 1) return toolDisplayName(detail.calls[0]!.name)
      return detail?.calls.length ? `工具执行 · ${detail.calls.length} 项` : '工具执行'
    }
    if (node.kind === 'fold') return skinForNode(node).label
    if (node.kind === 'dispatch') return '任务委派'
    if (node.kind === 'spawn') return '创建协作节点'
    return actorLabel(node)
  }
  function compactNodeTitle(node: ExecutionNode): string {
    const title = nodeTitle(node)
    return title.length > 10 ? `${title.slice(0, 9)}…` : title
  }
  function nodeAriaLabel(node: (typeof layout.value.nodes)[number]): string {
    const states = [
      runningTailIds.value.has(node.id) ? '运行中' : '',
      isPaused(node) ? '已暂停' : '',
      isError(node) ? '执行错误' : '',
      node.sourceFact?.termination ? terminationDisplay(node.sourceFact.termination).label : '',
    ].filter(Boolean)
    return `${nodeTitle(node)}，${skinForNode(node).label}${states.length ? `，${states.join('，')}` : ''}`
  }
  function focusRelativeNode(nodeId: string, direction: -1 | 1 | 'first' | 'last'): void {
    const ids = layout.value.nodes.filter(isInteractiveNode).map((node) => node.id)
    if (ids.length === 0) return
    const current = Math.max(0, ids.indexOf(nodeId))
    const index =
      direction === 'first'
        ? 0
        : direction === 'last'
          ? ids.length - 1
          : Math.min(ids.length - 1, Math.max(0, current + direction))
    const nextId = ids[index]!
    const node = layout.value.nodes.find((candidate) => candidate.id === nextId)
    if (!node) return
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
  function isInteractiveNode(node: (typeof layout.value.nodes)[number]): boolean {
    return hasNodeHoverDetail(node) || crtsByAnchor.value.has(node.id)
  }
  watch(
    [layout, () => props.focusSourceChatId, () => props.focusInteractionId],
    ([currentLayout, sourceChatId, interactionId]) => {
      if (!sourceChatId && !interactionId) return
      const node = currentLayout.nodes.find((candidate) => {
        if (interactionId && candidate.id === interactionId) return true
        if (
          interactionId &&
          toolBatchDetail(candidate)?.calls.some((call) => call.callId === interactionId)
        )
          return true
        return !!sourceChatId && candidate.sourceChatId === sourceChatId
      })
      if (!node) return
      canvas.panToPoint(node)
      if (hasNodeHoverDetail(node)) pinnedDetailNodeId.value = node.id
      if (interactionId) selectedCallId.value = interactionId
    },
    { flush: 'post' },
  )
  function cancelDetailHide(): void {
    if (detailHideTimer) clearTimeout(detailHideTimer)
    detailHideTimer = undefined
  }
  function showNodeDetail(node: (typeof layout.value.nodes)[number]): void {
    if (props.paperMode) return
    if (crtsByAnchor.value.has(node.id) || defaultPopoverAnchorIds.value.has(node.id)) return
    if (!hasNodeHoverDetail(node)) return
    cancelDetailHide()
    hoveredDetailNodeId.value = node.id
    if (node.kind === 'fold') readingFoldId.value = node.id
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
    if (detailNode.value?.kind === 'fold') readingFoldId.value = detailNode.value.id
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
  function requestBranch(type: 'detail' | 'continuation', nodeId: string): void {
    if (props.staticView) return // 静态代际视图：历史节点不提供分支入口（服务端已拒绝）
    const node = persistentGraph.value.nodes.find((candidate) => candidate.id === nodeId)
    if (!node || node.kind === 'pack') return
    const branchId = node.sourceFact?.branchId
    const sourceRootChatId = branchId
      ? props.timelineOverride?.branches?.find((branch) => branch.branchId === branchId)?.chatId
      : props.rootChatId
    if (!sourceRootChatId) return
    // 结尾节点（主执行流终点）的「从此处继续」= 普通发送：在当前会话末尾追加一条新消息。
    // 是否普通发送只看该节点是否就是执行流终点，与工作台当前聚焦的聊天无关——
    // 工作台可能聚焦在某一分支，而整棵任务树的真正终点落在根会话里。
    const ordinary =
      type === 'continuation' && mainExecutionEndpoint(persistentGraph.value).id === node.id
    emit('branch', { type, nodeId, sourceRootChatId, ...(ordinary ? { ordinary: true } : {}) })
    closeNodeDetail()
  }
  function updateStringMap(
    target: typeof selectedFoldMembers,
    update: (next: Map<string, string>) => void,
  ): void {
    const next = new Map(target.value)
    update(next)
    target.value = next
  }
  function updateNumberMap(
    target: typeof unreadFoldMembers,
    update: (next: Map<string, number>) => void,
  ): void {
    const next = new Map(target.value)
    update(next)
    target.value = next
  }
  function memberContainingNode(
    members: readonly ExecutionFoldMember[],
    nodeId?: string,
  ): ExecutionFoldMember | undefined {
    if (!nodeId) return undefined
    return members.find(
      (member) => member.id === nodeId || member.nodes.some((node) => node.id === nodeId),
    )
  }
  function selectedFoldMember(
    node: (typeof layout.value.nodes)[number] | undefined,
  ): ExecutionFoldMember | undefined {
    const members = node?.fold?.members ?? []
    return (
      memberContainingNode(members, pinnedDetailNodeId.value) ??
      memberContainingNode(members, selectedFoldMembers.value.get(node?.id ?? '')) ??
      members.at(-1)
    )
  }
  function selectFoldMember(foldId: string, memberId: string): void {
    updateStringMap(selectedFoldMembers, (next) => next.set(foldId, memberId))
    const fold = graph.value.nodes.find((node) => node.id === foldId)
    if (fold?.fold?.members.at(-1)?.id === memberId) {
      updateNumberMap(unreadFoldMembers, (next) => next.set(foldId, 0))
    }
    selectedCallId.value = undefined
  }
  function onFoldRailInteraction(foldId: string, active: boolean): void {
    if (active) {
      readingFoldId.value = foldId
      return
    }
    const detailStillOpen =
      hoveredDetailNodeId.value === foldId || pinnedDetailNodeId.value === foldId
    if (!detailStillOpen && readingFoldId.value === foldId) readingFoldId.value = undefined
  }
  function onNodePointerDown(event: PointerEvent, node: (typeof layout.value.nodes)[number]): void {
    // Interactive nodes must retain pointer ownership. Otherwise the viewport's
    // pointer capture retargets the eventual click to the canvas.
    if (isInteractiveNode(node)) event.stopPropagation()
  }
  async function recoverGraph(): Promise<void> {
    if (recoveringGraph.value) return
    recoveringGraph.value = true
    recoveryError.value = ''
    try {
      await chatSessions.resyncRootTimeline(props.rootChatId)
    } catch (error) {
      recoveryError.value = error instanceof Error ? error.message : '重新同步失败'
    } finally {
      recoveringGraph.value = false
    }
  }
  // 折叠档位/切根后禁止 `followContentEnd` 立即把相机拖到末尾：fit 应锚定开始节点，
  // 让用户看清新投影的起点。动画结束后恢复自动跟随（流式新增节点仍可贴底）。
  let suppressAutoFollow = false
  function resetLayout(): boolean {
    suppressAutoFollow = true
    if (!canvas.fitToView({ animate: true, duration: 300 })) {
      suppressAutoFollow = false
      return false
    }
    window.setTimeout(() => {
      suppressAutoFollow = false
    }, 360)
    return true
  }
  function isPaused(node: (typeof layout.value.nodes)[number]): boolean {
    return node.activeRuns.some((run) => run.status === 'paused')
  }
  function isError(node: (typeof layout.value.nodes)[number]): boolean {
    return node.sourceFact?.termination?.code === 'error'
  }
  function activateNode(node: (typeof layout.value.nodes)[number]): void {
    if (canvas.consumeClickAfterDrag()) return
    if (node.kind === 'pack' && node.pack) {
      openGenerationView(node.pack.generationIndex)
      return
    }
    if (props.paperMode && hasNodeHoverDetail(node)) {
      selectPaperNode(node.id)
      return
    }
    if (defaultPopoverAnchorIds.value.has(node.id)) {
      const model = defaultNodePopovers.value.find((candidate) => candidate.anchorNodeId === node.id)
      if (model && (model.approval || model.question)) {
        emit('interactionFocus', {
          chatId: model.chatId,
          interactionId: model.approval?.approvalId ?? model.question?.batch.batchId,
          anchorNodeId: model.anchorNodeId,
        })
      }
      return
    } else if (crtsByAnchor.value.has(node.id)) {
      for (const card of crtsByAnchor.value.get(node.id) ?? []) pinCrt(card.id)
    } else if (canPinNodeDetail(node)) {
      pinnedDetailNodeId.value = node.id
      hoveredDetailNodeId.value = node.id
      if (node.kind === 'fold') readingFoldId.value = node.id
    }
  }
  function focusNode(node: (typeof layout.value.nodes)[number]): void {
    if (props.paperMode && hasNodeHoverDetail(node)) {
      selectPaperNode(node.id)
      return
    }
    showNodeDetail(node)
  }
  function selectPaperNode(nodeId: string): void {
    const index = paperEntries.value.findIndex((entry) => entry.id === nodeId)
    if (index < 0) return
    activePaperNodeId.value = nodeId
    paperHasNewTail.value = index < paperEntries.value.length - 1 && paperHasNewTail.value
    closeNodeDetail()
  }
  function selectPaperIndex(index: number): void {
    const entry = paperEntries.value[index]
    if (!entry) return
    selectPaperNode(entry.id)
    if (index === paperEntries.value.length - 1) paperHasNewTail.value = false
  }
  function returnToLatestPaper(): void {
    selectPaperIndex(paperEntries.value.length - 1)
  }
  // ── 打包代际二层：点 pack 节点 → 抽屉已开则联动抽屉二层，否则本组件内弹窗 ──
  const generationDialogIndex = ref<number>()
  function openGenerationView(generationIndex: number): void {
    if (props.staticView) return // 二层内不再下钻（嵌套深度恒 1）
    if (agents.historyDrawerStack.includes(props.rootChatId)) {
      agents.openHistoryGeneration(props.rootChatId, generationIndex)
      return
    }
    generationDialogIndex.value = generationIndex
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
    detailNode.value?.kind === 'fold' ? detailFoldMember.value?.displayNode : detailNode.value,
  )
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
  const detailMaxHeight = computed(() => {
    return Math.min(640, Math.max(160, viewportSize.value.height - 96))
  })
  /** 实际渲染的详情弹窗高度。定位用真实高度而非上限，否则弹窗被按上限钳制到视口顶部、
   *  低处节点 hover 时弹窗停在顶部不跟随节点（「游离」）。未测到前回退到上限。 */
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
  /** pinned 详情弹窗被用户拖动后的手动位置；null = 跟随自动定位（贴节点右侧）。hover 临时详情不参与拖拽。 */
  const detailManualPos = ref<{ left: number; top: number } | null>(null)
  function dragDetailPopover(delta: { x: number; y: number }): void {
    const current = detailPlacement.value
    if (!current) return
    const base = detailManualPos.value ?? {
      left: parseFloat(current.style.left),
      top: parseFloat(current.style.top),
    }
    const headerVisible = 32
    const left = Math.min(
      viewportSize.value.width - headerVisible,
      Math.max(-480 + headerVisible, base.left + delta.x),
    )
    const top = Math.min(
      viewportSize.value.height - headerVisible,
      Math.max(0, base.top + delta.y),
    )
    detailManualPos.value = { left, top }
  }
  const detailPlacement = computed(() => {
    const node = detailNode.value
    const viewport = viewportRef.value
    if (!node || !viewport) return undefined
    const anchor = canvas.worldToScreen(node)
    const auto = anchoredPopoverPosition({
      anchor,
      viewport: viewportSize.value,
      panel: { width: 480, height: measuredDetailHeight.value || POPOVER_INITIAL_HEIGHT },
      margin: 12,
    })
    const manual = detailPinned.value ? detailManualPos.value : undefined
    const left = manual?.left ?? auto.left
    const top = manual?.top ?? auto.top
    const placement = manual
      ? anchor.x <= left + 480 / 2
        ? ('left' as const)
        : ('right' as const)
      : auto.placement
    return {
      style: { left: `${left}px`, top: `${top}px` },
      nodeOffset: { x: anchor.x - left, y: anchor.y - top },
      placement,
    }
  })
  const detailAnchorStyle = computed(() => detailPlacement.value?.style)
  const foldRailSide = computed(() =>
    detailPlacement.value ? oppositePopoverPlacement(detailPlacement.value.placement) : 'left',
  )
  const pixiScene = computed<PixiExecutionScene>(() => ({
    nodes: visibleExecutionItems.value.nodes.map((node) => {
      const skin = skinForNode(node)
      return {
        id: node.id,
        x: node.x,
        y: node.y,
        accent: accentForTheme(themeStore.theme, skin.key),
        glyph: skin.glyph,
        title: compactNodeTitle(node),
        ...(node.sourceFact?.termination
          ? { termination: terminationDisplay(node.sourceFact.termination).label }
          : {}),
        ...(node.kind === 'fold' && node.fold ? { foldCount: node.fold.members.length } : {}),
        ...(node.kind === 'pack' && node.pack ? { foldCount: node.pack.nodeCount } : {}),
        running: runningTailIds.value.has(node.id),
        detailActive:
          hoveredDetailNodeId.value === node.id ||
          pinnedDetailNodeId.value === node.id ||
          Boolean(props.paperMode && activePaperNodeId.value === node.id),
        branchAnchorKind: containsBranchAnchor(node) ? props.branchAnchorKind : undefined,
        paused: isPaused(node),
        error: isError(node),
        revoked: node.status === 'revoked',
        deemphasized: !coreFlowProjection.value.coreNodeIds.has(node.id),
        detailBranch: coreFlowProjection.value.detailNodeIds.has(node.id),
      }
    }),
    edges: visibleExecutionItems.value.edges.map((edge) => {
      const detailBranch =
        coreFlowProjection.value.detailNodeIds.has(edge.from.id) ||
        coreFlowProjection.value.detailNodeIds.has(edge.to.id)
      return {
        id: edge.id,
        from: edge.from,
        to: edge.to,
        color: detailBranch ? DETAIL_BRANCH_COLOR : edgeStyle(edge.kind).color,
        active: runningTailIds.value.has(edge.from.id) || runningTailIds.value.has(edge.to.id),
        phaseSeconds: (edge.to.createdAt % 1300) / 1000,
        deemphasized:
          !coreFlowProjection.value.coreNodeIds.has(edge.from.id) ||
          !coreFlowProjection.value.coreNodeIds.has(edge.to.id),
        detailBranch,
        ...(edge.routeX === undefined ? {} : { routeX: edge.routeX }),
      }
    }),
  }))
  function gpuNodeHitStyle(node: (typeof layout.value.nodes)[number]): Record<string, string> {
    const position = canvas.worldToScreen(node)
    const size = Math.max(30, 46 * canvas.scale.value)
    return {
      width: `${size}px`,
      height: `${size}px`,
      transform: `translate3d(${position.x - size / 2}px, ${position.y - size / 2}px, 0)`,
    }
  }
  function defaultPopoverNodes(
    model: DefaultNodePopover,
  ): { anchor: ExecutionNode; display: ExecutionNode } | undefined {
    const anchor = layout.value.nodes.find((node) => node.id === model.anchorNodeId)
    if (!anchor) return undefined
    if (anchor.kind !== 'fold') return { anchor, display: anchor }
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
      if (activePaperQuestionPopover.value?.id === model.id) return []
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
  function onEscape(event: KeyboardEvent): void {
    if (event.key !== 'Escape') return
    if (pinnedDetailNodeId.value) closeNodeDetail()
    else {
      const latest = [...pinnedCrtIds.value].at(-1)
      if (latest) unpinCrt(latest)
    }
  }
  let viewportRO: ResizeObserver | undefined
  let knownFoldCounts = new Map<string, number>()
  // 首次进入/切根时，数据布局与工作台视口可能分两拍就绪。保留待 fit 状态，直到两者都有效，
  // 避免早到的 resetLayout 静默失败后一直使用默认相机；成功后即停止，不能抢走用户视角。
  let initialFitPending = true
  watch(
    () =>
      foldProjection.value.ranges.map((range) => ({
        id: range.id,
        members: range.members,
      })),
    (ranges) => {
      if (props.foldMode === 'none') return
      const selected = new Map(selectedFoldMembers.value)
      const unread = new Map(unreadFoldMembers.value)
      const nextCounts = new Map<string, number>()
      for (const range of ranges) {
        const count = range.members.length
        const previousCount = knownFoldCounts.get(range.id) ?? 0
        const current = memberContainingNode(range.members, selected.get(range.id))
        const pinned = memberContainingNode(range.members, pinnedDetailNodeId.value)
        const protectedReading = readingFoldId.value === range.id || !!pinned
        const latest = range.members.at(-1)
        if (pinned) {
          selected.set(range.id, pinned.id)
          if (latest?.id === pinned.id) unread.set(range.id, 0)
        } else if (!current || (!protectedReading && count > previousCount)) {
          if (latest) selected.set(range.id, latest.id)
          unread.set(range.id, 0)
        } else if (protectedReading && count > previousCount) {
          unread.set(range.id, (unread.get(range.id) ?? 0) + count - previousCount)
        }
        nextCounts.set(range.id, count)
      }
      selectedFoldMembers.value = selected
      unreadFoldMembers.value = unread
      knownFoldCounts = nextCounts
    },
    { immediate: true },
  )
  watch(
    () => props.rootChatId,
    (rootChatId, previousRootChatId) => {
      if (!rootChatId) return
      initialFitPending = true
      cachedActiveRunKey = ''
      cachedActiveCrtRuns = []
      layoutEngine.reset()
      endpointLayoutEngine.reset()
      recoveryError.value = ''
      hasNewTail.value = false
      knownTailIds = new Set()
      selectedFoldMembers.value = new Map()
      unreadFoldMembers.value = new Map()
      actionSelectedCallIds.value = new Map()
      knownFoldCounts = new Map()
      activePaperNodeId.value = undefined
      paperHasNewTail.value = false
      paperEntryCache = new Map()
      generationDialogIndex.value = undefined
      if (previousRootChatId && previousRootChatId !== rootChatId) {
        pinnedCrtIds.value = new Set()
        hiddenCrtIds.value = new Set()
        crtWindowState.value = new Map()
        nextCrtZ = 1
      }
      closeNodeDetail()
      void nextTick(tryInitialFit)
    },
    { immediate: true },
  )
  watch(
    paperEntries,
    (entries, previousEntries) => {
      if (!props.paperMode) return
      if (!entries.length) {
        activePaperNodeId.value = undefined
        paperHasNewTail.value = false
        return
      }
      const previousIds = new Set(previousEntries?.map((entry) => entry.id) ?? [])
      const previousActive = activePaperNodeId.value
      const wasAtTail =
        !previousEntries?.length || previousEntries.at(-1)?.id === previousActive || !previousActive
      if (previousActive && entries.some((entry) => entry.id === previousActive)) {
        if (wasAtTail && entries.at(-1)?.id !== previousActive) {
          activePaperNodeId.value = entries.at(-1)!.id
        } else if (!wasAtTail && entries.some((entry) => !previousIds.has(entry.id))) {
          paperHasNewTail.value = true
        }
        return
      }
      activePaperNodeId.value = entries.at(-1)!.id
    },
    { immediate: true },
  )
  watch(
    () => props.paperMode,
    (enabled) => {
      closeNodeDetail()
      if (enabled && !activePaperNodeId.value) activePaperNodeId.value = paperEntries.value.at(-1)?.id
      // 卡牌模式开关会让树视口在「全宽 ↔ 右半区」间切换，旧相机位置不再对齐新视口。
      // 与折叠档位/布局模式一致：开关后重新 fit，使节点树在新视口内居中。
      void nextTick(resetLayout)
    },
  )
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
  watch(
    () => props.foldMode,
    () => {
      closeNodeDetail()
      // 折叠档位改变会整体重排投影图（节点增删），旧相机位置/缩放已不再对应新图。
      // 与切根一致：清空增量布局缓存并重新 fit 到新投影，否则开始/末尾节点定位不到视口内。
      layoutEngine.reset()
      endpointLayoutEngine.reset()
      void nextTick(resetLayout)
    },
  )
  watch(
    () => props.layoutMode,
    () => {
      closeNodeDetail()
      layoutEngine.reset()
      endpointLayoutEngine.reset()
      void nextTick(resetLayout)
    },
  )
  // 用户拖离后末尾真正追加了「新」节点（id 此前未出现在图中）才显示「回到底部」浮标。
  // 排除 transient 占位增删 / 投影折叠重排造成的末节点 id 抖动：新尾若是旧节点则不置位。
  // 首次 / 切根后 knownTailIds 为空，先建档不置位，避免把根节点误判为「新尾」。
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
    canvas.fitToView({ animate: true, duration: 460 })
  }
  function syncGpuScene(scene = pixiScene.value): void {
    const signature = executionSceneSignature(scene, visibleExecutionKey.value)
    const appliedToPixi = signature !== lastGpuSceneSignature
    if (!appliedToPixi) return
    lastGpuSceneSignature = signature
    gpuRenderer?.setScene(scene)
  }
  watch(
    executionCamera,
    (camera) => {
      gpuRenderer?.setCamera(camera)
      if (!canvas.dragging.value) viewportSelectionCamera.value = camera
    },
    { deep: true, flush: 'sync' },
  )
  watch(pixiScene, (scene) => syncGpuScene(scene))
  // 主题切换：更新画布调色板并重画静态层（accent 随 pixiScene 重算）。
  watch(canvasPalette, (palette) => gpuRenderer?.setPalette(palette))
  watch(
    () => props.paperMode,
    (paperMode) => gpuRenderer?.setMotionFrameRate(paperMode ? 24 : 30),
    { immediate: true },
  )
  watch(
    () => props.suspended,
    (suspended) => gpuRenderer?.setSuspended(!!suspended),
    { immediate: true },
  )
  async function mountGpuRenderer(): Promise<void> {
    const host = pixiMountRef.value
    if (!host) return
    const generation = ++gpuMountGeneration
    const renderer = new ExecutionGraphPixiRenderer()
    gpuRenderer = renderer
    renderer.setScene(pixiScene.value)
    renderer.setPalette(canvasPalette.value)
    renderer.setMotionFrameRate(props.paperMode ? 24 : 30)
    renderer.setSuspended(!!props.suspended)
    try {
      await renderer.mount(host)
    } catch (error) {
      if (generation === gpuMountGeneration) {
        gpuRenderError.value = error instanceof Error ? error.message : 'GPU 渲染器初始化失败'
      }
      return
    }
    if (generation !== gpuMountGeneration) {
      renderer.destroy()
      return
    }
    renderer.setCamera(executionCamera.value)
    gpuRenderError.value = ''
    lastGpuSceneSignature = ''
    syncGpuScene()
  }
  onMounted(() => {
    viewportRO = new ResizeObserver(() => {
      const width = viewportRef.value?.clientWidth ?? 0
      const height = viewportRef.value?.clientHeight ?? 0
      viewportSize.value = { width, height }
      // 与画布相机同步：resizeTo 对工作台瞬时全屏切换可能漏触发，导致 GPU 位图停留在旧高度、
      // 图底部被裁剪。这里显式重设渲染器尺寸，与 SVG 视口保持一致。
      gpuRenderer?.resize(width, height)
    })
    if (viewportRef.value) viewportRO.observe(viewportRef.value)
    void nextTick(() => {
      tryInitialFit()
    })
    void mountGpuRenderer()
    window.addEventListener('keydown', onEscape)
  })
  onBeforeUnmount(() => {
    gpuMountGeneration += 1
    gpuRenderer?.destroy()
    gpuRenderer = undefined
    viewportRO?.disconnect()
    detailHeightRO?.disconnect()
    cancelDetailHide()
    window.removeEventListener('keydown', onEscape)
  })

  return {
    AnchoredRunCrt, ExecutionNodePopover, FoldTabRail, GenerationTreeDialog, NodePaperStack,
    activateNode, activePaperQuestionPopover, agents, canvas, closeCrt, closeNodeDetail, crtById,
    crtPlacements, crtVisibility, defaultPopoverAnchorIds, defaultPopoverViews, detailAnchorEl,
    detailAnchorStyle, detailDisplayNode, detailFoldMember, detailMaxHeight, detailNode,
    detailPinned, detailPlacement, detailRelatedEdges, dragActionPopover, dragCrt,
    dragDetailPopover, focusCrt, focusNode, focusRelativeNode, foldRailSide, generationDialogIndex,
    gpuNodeHitStyle, gpuRenderError, graph, hasNewTail, hideNodeDetail, keepNodeDetailOpen,
    leaveNodeDetail, nodeAriaLabel, nodeTitle, onFoldRailInteraction, onNodePointerDown,
    overlayPlacements, paperCurrentIndex, paperEntries, paperGraph, paperHasNewTail,
    persistentGraph, pinCrt, pinnedCrtIds, pixiMountRef, recordActionPopoverHeight, recoverGraph,
    recoveringGraph, recoveryError, ref, requestBranch, resetLayout, returnToBottom,
    returnToLatestPaper, selectActionCall, selectFoldMember, selectPaperIndex, selectedActionCall,
    selectedCallId, showNodeDetail, unpinCrt, unreadFoldMembers, viewportRef, viewportSize,
    visibleInteractiveNodes,
  }
}
