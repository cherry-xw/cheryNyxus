import { ref, type ComputedRef, type Ref } from 'vue'
import type {
  MessageBranchTreeControllerProps,
  MessageBranchTreeControllerEmits,
  ControllerEmit,
} from './treeControllerTypes'
import type { useNyxusHost } from '../application/host'
import type { useTreeGraphProjection } from './useTreeGraphProjection'
import type { useTreeCanvas } from '../composables/useTreeCanvas'
import type { usePianoEasterEgg } from '../composables/usePianoEasterEgg'
import { mainExecutionEndpoint } from '../graph/executionGraph'
import type { PositionedExecutionNode } from '../graph/executionLayout'
import { hasNodeHoverDetail, canPinNodeDetail } from '../graph/nodeSkins'
import type { DefaultNodePopover } from '../graph/nodePopoverModel'

/** Node click, keyboard focus, branch and generation navigation. */
export function useTreeNodeActivation({
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
}: {
  props: MessageBranchTreeControllerProps
  emit: ControllerEmit<MessageBranchTreeControllerEmits>
  agents: ReturnType<typeof useNyxusHost>['agents']
  canvas: ReturnType<typeof useTreeCanvas>
  pianoEasterEgg: ReturnType<typeof usePianoEasterEgg>
  persistentGraph: ReturnType<typeof useTreeGraphProjection>['persistentGraph']
  awaitingInteractionNodeIds: ComputedRef<Set<string>>
  defaultNodePopovers: ComputedRef<DefaultNodePopover[]>
  crtsByAnchor: ComputedRef<Map<string, Array<{ id: string }>>>
  pinnedDetailNodeId: Ref<string | undefined>
  hoveredDetailNodeId: Ref<string | undefined>
  readingFoldId: Ref<string | undefined>
  isInteractiveNode: (node: PositionedExecutionNode) => boolean
  pinCrt: (id: string) => void
  selectPaperNode: (id: string) => void
  showNodeDetail: (node: PositionedExecutionNode) => void
  closeNodeDetail: () => void
}) {
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
  function onNodePointerDown(event: PointerEvent, node: PositionedExecutionNode): void {
    // Interactive nodes must retain pointer ownership. Otherwise the viewport's
    // pointer capture retargets the eventual click to the canvas.
    // start 节点在非 staticView 下同样保留所有权（钢琴彩蛋首步可点化）。
    if (isInteractiveNode(node) || (!props.staticView && node.kind === 'start'))
      event.stopPropagation()
  }
  function activateNode(node: PositionedExecutionNode): void {
    if (canvas.consumeClickAfterDrag()) return
    if (pianoEasterEgg.consume(node)) {
      emit('easter-egg')
      return
    }
    if (node.kind === 'pack' && node.pack) {
      openGenerationView(node.pack.sourceRootChatId, node.pack.generationIndex)
      return
    }
    if (props.paperMode && hasNodeHoverDetail(node)) {
      selectPaperNode(node.id)
      return
    }
    if (awaitingInteractionNodeIds.value.has(node.id)) {
      const model = defaultNodePopovers.value.find(
        (candidate) =>
          candidate.anchorNodeId === node.id || candidate.anchorAltNodeIds?.includes(node.id),
      )
      if (model && (model.approval || model.question)) {
        emit('interactionFocus', {
          chatId: model.chatId,
          interactionId: model.approval?.approvalId ?? model.question?.batch.batchId,
          anchorNodeId: model.anchorNodeId,
        })
      }
    } else if (crtsByAnchor.value.has(node.id)) {
      for (const card of crtsByAnchor.value.get(node.id) ?? []) pinCrt(card.id)
    } else if (canPinNodeDetail(node)) {
      pinnedDetailNodeId.value = node.id
      hoveredDetailNodeId.value = node.id
      if (node.kind === 'fold') readingFoldId.value = node.id
    } else if (pinnedDetailNodeId.value && hasNodeHoverDetail(node)) {
      // 常驻窗口已固定（拖拽/点击过某个节点）后，点击任意有详情内容的节点
      // 即把窗口内容切换到该节点；窗口停留在用户手动放置的位置。
      pinnedDetailNodeId.value = node.id
      hoveredDetailNodeId.value = node.id
      if (node.kind === 'fold') readingFoldId.value = node.id
    }
  }
  function focusNode(node: PositionedExecutionNode): void {
    if (props.paperMode && hasNodeHoverDetail(node)) {
      selectPaperNode(node.id)
      return
    }
    showNodeDetail(node)
  }
  const generationDialogIndex = ref<number>()
  const generationDialogRootChatId = ref<string>()
  function openGenerationView(sourceRootChatId: string, generationIndex: number): void {
    if (props.staticView) return // 二层内不再下钻（嵌套深度恒 1）
    if (agents.historyDrawerStack.includes(sourceRootChatId)) {
      agents.openHistoryGeneration(sourceRootChatId, generationIndex)
      return
    }
    generationDialogRootChatId.value = sourceRootChatId
    generationDialogIndex.value = generationIndex
  }
  function closeGenerationView(): void {
    generationDialogIndex.value = undefined
    generationDialogRootChatId.value = undefined
  }
  return {
    requestBranch,
    onNodePointerDown,
    activateNode,
    focusNode,
    generationDialogIndex,
    generationDialogRootChatId,
    closeGenerationView,
  }
}
