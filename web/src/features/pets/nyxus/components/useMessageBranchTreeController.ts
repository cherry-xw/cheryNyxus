import { ref, watch } from 'vue'
import { useNyxusHost } from '../application/host'
import { useThemeTokens } from '@/composables/useThemeTokens'
import { hasNodeHoverDetail } from '../graph/nodeSkins'
import { toolBatchDetail } from '../graph/toolBatchDetails'
import { usePianoEasterEgg } from '../composables/usePianoEasterEgg'
import ExecutionNodePopover from './ExecutionNodePopover.vue'
import RoundNodePopover from './RoundNodePopover.vue'
import FoldTabRail from './FoldTabRail.vue'
import AnchoredRunCrt from './AnchoredRunCrt.vue'
import NodePaperStack from './NodePaperStack.vue'
import GenerationTreeDialog from './GenerationTreeDialog.vue'
import type {
  MessageBranchTreeControllerProps,
  MessageBranchTreeControllerEmits,
  MessageBranchTreeController,
  ControllerEmit,
} from './treeControllerTypes'
import { useTreeGraphProjection } from './useTreeGraphProjection'
import { useTreeNodeActivation } from './useTreeNodeActivation'
import { useTreeViewportLifecycle } from './useTreeViewportLifecycle'
import { useTreeModeReactions } from './useTreeModeReactions'
import { useTreeNodeLabels } from './useTreeNodeLabels'
import { useTreeGpuScene } from './useTreeGpuScene'
import { useTreeActionPopovers } from './useTreeActionPopovers'
import { useTreeFoldReading } from './useTreeFoldReading'
import { useTreeDetailWindow } from './useTreeDetailWindow'
import { useTreeCamera } from './useTreeCamera'
import { useTreeCrtWindows } from './useTreeCrtWindows'

export function useMessageBranchTreeController(
  props: MessageBranchTreeControllerProps,
  emit: ControllerEmit<MessageBranchTreeControllerEmits>,
): MessageBranchTreeController {
  const { chats: chatSessions, agents, theme: themeStore } = useNyxusHost()
  const { canvasPalette } = useThemeTokens()
  const viewportRef = ref<HTMLElement | null>(null)
  const hoveredDetailNodeId = ref<string>()
  const pinnedDetailNodeId = ref<string>()
  const selectedCallId = ref<string>()
  const viewportSize = ref({ width: 0, height: 0 })
  const recoveringGraph = ref(false)
  const recoveryError = ref('')
  const { actorLabel, nodeTitle, compactNodeTitle, nodeAriaLabel } = useTreeNodeLabels({
    agents,
    runningTailIds: () => runningTailIds.value,
    isPaused,
    isError,
  })
  const {
    timelineSnapshot,
    liveState,
    activeCrtRuns,
    persistentGraph,
    foldProjection,
    graph,
    coreFlowProjection,
    paperGraph,
    paperEntries,
    activePaperNodeId,
    paperHasNewTail,
    paperCurrentIndex,
    selectPaperNode,
    selectPaperIndex,
    returnToLatestPaper,
    resetGraphProjection,
  } = useTreeGraphProjection(props, chatSessions, nodeTitle, () => detail.closeNodeDetail())
  const pianoEasterEgg = usePianoEasterEgg({
    graph: () => graph.value,
    enabled: () => !props.staticView,
  })
  const {
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
  } = useTreeActionPopovers({
    graph,
    chatSessions,
    layout: () => layout.value,
    viewportSize,
    nodeScreenAnchor: (node) => nodeScreenAnchor(node),
    memberContainingNode: (members, nodeId) => memberContainingNode(members, nodeId),
    popoverWidth: 640,
    popoverInitialHeight: 220,
  })
  const {
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
  } = useTreeCamera({
    props,
    graph,
    timelineSnapshot,
    viewportRef,
    viewportSize,
    hoveredDetailNodeId,
    pinnedDetailNodeId,
    activePaperNodeId,
    runningTailIds: () => runningTailIds.value,
    isInteractiveNode,
    renderer: () => gpu.renderer(),
    snapCrts: () => snapCrtWindowsToAnchors(),
  })
  const {
    unreadFoldMembers,
    readingFoldId,
    memberContainingNode,
    selectedFoldMember,
    selectFoldMember,
    stepFoldDetail,
    onFoldRailInteraction,
    resetFoldReading,
  } = useTreeFoldReading({
    props,
    graph,
    foldProjection,
    pinnedDetailNodeId,
    hoveredDetailNodeId,
    selectedCallId,
    detailNode: () => detail.detailNode.value,
    detailFoldMember: () => detail.detailFoldMember.value,
  })
  const POPOVER_INITIAL_HEIGHT = 220
  const POPOVER_WIDTH = 640
  const detail = useTreeDetailWindow({
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
    hasCrtAnchor: (id) => crtsByAnchor.value.has(id),
    hasDefaultPopoverAnchor: (id) => defaultPopoverAnchorIds.value.has(id),
    popoverWidth: POPOVER_WIDTH,
    popoverInitialHeight: POPOVER_INITIAL_HEIGHT,
  })
  const {
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
  } = detail
  const {
    pinnedCrtIds,
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
  } = useTreeCrtWindows({
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
  })
  /** 审批/提问等 action 弹窗被用户拖动后的手动位置；缺省 = 跟随自动定位（贴节点右侧）。 */
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
      // 审核/提问只在左下角统一窗口处理，节点在这里仅作为定位和闪烁提示。
    },
    { flush: 'post' },
  )
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
  function isPaused(node: (typeof layout.value.nodes)[number]): boolean {
    return node.activeRuns.some((run) => run.status === 'paused')
  }
  function isError(node: (typeof layout.value.nodes)[number]): boolean {
    return node.sourceFact?.termination?.code === 'error'
  }
  const {
    requestBranch,
    onNodePointerDown,
    activateNode,
    focusNode,
    generationDialogIndex,
    generationDialogRootChatId,
    closeGenerationView,
  } = useTreeNodeActivation({
    props,
    emit,
    agents,
    canvas,
    pianoEasterEgg,
    persistentGraph,
    awaitingInteractionNodeIds,
    defaultNodePopovers,
    crtsByAnchor,
    pinnedDetailNodeId,
    hoveredDetailNodeId,
    readingFoldId,
    isInteractiveNode,
    pinCrt,
    selectPaperNode,
    showNodeDetail,
    closeNodeDetail,
  })
  const gpu = useTreeGpuScene({
    props,
    emit,
    layout,
    canvas,
    visibleExecutionItems,
    visibleExecutionKey,
    viewportSelectionCamera,
    executionCamera,
    themeStore,
    canvasPalette,
    coreFlowProjection,
    runningTailIds,
    awaitingInteractionNodeIds,
    hoveredDetailNodeId,
    pinnedDetailNodeId,
    activePaperNodeId,
    containsBranchAnchor,
    isPaused,
    isError,
    compactNodeTitle,
  })
  const {
    pixiMountRef,
    gpuRenderError,
    gpuNodeAccent,
    gpuNodeHitStyle,
    mountGpuRenderer,
    restartGpuRenderer,
    resizeGpuRenderer,
    disposeGpuRenderer,
  } = gpu
  useTreeModeReactions({
    props,
    graphProjection: { resetGraphProjection, paperEntries, activePaperNodeId, paperHasNewTail },
    camera: { resetCameraForRoot, resetCameraLayout, resetLayout, tryInitialFit, hasNewTail },
    resetPiano: () => pianoEasterEgg.reset(),
    recoveryError,
    resetFoldReading,
    resetActionPopovers,
    resetCrtWindows,
    generationDialogIndex,
    generationDialogRootChatId,
    closeNodeDetail,
    gpuRenderError,
    restartGpuRenderer,
  })
  useTreeViewportLifecycle({
    pinnedDetailNodeId,
    pinnedCrtIds,
    closeNodeDetail,
    unpinCrt,
    viewportRef,
    viewportSize,
    tryInitialFit,
    mountGpuRenderer,
    resizeGpuRenderer,
    disposeGpuRenderer,
    cleanupDetail,
  })

  return {
    AnchoredRunCrt,
    ExecutionNodePopover,
    RoundNodePopover,
    FoldTabRail,
    GenerationTreeDialog,
    NodePaperStack,
    activateNode,
    agents,
    canvas,
    closeCrt,
    closeGenerationView,
    closeNodeDetail,
    crtById,
    crtPlacements,
    crtVisibility,
    defaultPopoverAnchorIds,
    defaultPopoverViews,
    detailAnchorEl,
    detailAnchorStyle,
    detailDisplayNode,
    detailFoldMember,
    detailRoundSections,
    detailMaxHeight,
    detailNode,
    detailPinned,
    detailWrap,
    detailPlacement,
    detailRelatedEdges,
    dragActionPopover,
    dragCrt,
    dragDetailPopover,
    finishDetailDrag,
    cycleDetailSize,
    detailSizeLabel,
    toggleDetailWrap,
    focusCrt,
    focusNode,
    focusRelativeNode,
    foldRailSide,
    generationDialogIndex,
    generationDialogRootChatId,
    gpuNodeAccent,
    gpuNodeHitStyle,
    gpuRenderError,
    graph,
    hasNewTail,
    hideNodeDetail,
    keepNodeDetailOpen,
    leaveNodeDetail,
    nodeAriaLabel,
    nodeTitle,
    onFoldRailInteraction,
    onNodePointerDown,
    overlayPlacements,
    paperCurrentIndex,
    paperEntries,
    paperGraph,
    paperHasNewTail,
    persistentGraph,
    pinCrt,
    pinnedCrtIds,
    pixiMountRef,
    recordActionPopoverHeight,
    recoverGraph,
    recoveringGraph,
    recoveryError,
    requestBranch,
    resetLayout,
    returnToBottom,
    returnToLatestPaper,
    selectActionCall,
    selectFoldMember,
    selectPaperIndex,
    selectedActionCall,
    selectedCallId,
    showNodeDetail,
    stepFoldDetail,
    unpinCrt,
    unreadFoldMembers,
    vMeasureHeight,
    viewportRef,
    viewportSize,
    visibleInteractiveNodes,
    taskPlanMarkerNodes,
    taskPlanForNode,
    taskPlanMarkerStyle,
    actorLabel,
  }
}
