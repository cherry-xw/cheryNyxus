<script setup lang="ts">
/**
 * Canonical execution tree consumer with CP5 input, CP6 details, and CP7 folds.
 *
 * The component is intentionally a thin renderer: topology and coordinates
 * come from pure graph modules, while this layer owns only the canvas gesture
 * and visual skin. Later checkpoints add termination controls and CRT anchoring.
 */
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from 'vue'
import { useChatSessionsStore } from '@/stores'
import { effectiveRootLiveState } from '@/stores/chats/rootTimeline'
import type { TimelineActor } from '@/services/agentApi'
import {
  mainExecutionEndpoint,
  projectActiveTurnNodes,
  projectInputNodes,
  projectPersistentExecutionGraph,
  type ExecutionFoldMember,
  type ExecutionNode,
  type VirtualInputNode,
} from '../graph/executionGraph'
import { projectFoldExecutionGraph } from '../graph/foldProjection'
import { createIncrementalExecutionLayout } from '../graph/executionLayout'
import { EXECUTION_ICON_RADIUS } from '../graph/executionLayout'
import { executionEdgeGeometry } from '../graph/executionGeometry'
import { edgeStyle } from '../graph/edgeStyles'
import { canPinNodeDetail, hasNodeHoverDetail, skinForNode } from '../graph/nodeSkins'
import {
  anchoredPopoverPosition,
  oppositePopoverPlacement,
  toolBatchDetail,
  type ToolBatchVisualStatus,
} from '../graph/toolBatchDetails'
import { useTreeCanvas } from '../composables/useTreeCanvas'
import {
  createMainInputState,
  pendingInputAnchor,
  pendingInputPhase,
  reduceMainInputState,
} from '../composables/mainInputState'
import FiberPulseLine from './FiberPulseLine.vue'
import ExecutionNodePopover from './ExecutionNodePopover.vue'
import FoldTabRail from './FoldTabRail.vue'
import AnchoredRunCrt from './AnchoredRunCrt.vue'
import { terminationDisplay } from '../graph/termination'
import {
  buildRunCrtModels,
  effectiveRunFacts,
  type RunCrtModel,
} from '../graph/crtModel'
import { layoutAnchoredCrts, selectVisibleCrtIds } from '../graph/crtLayout'
import {
  buildDefaultNodePopovers,
  type DefaultNodePopover,
} from '../graph/nodePopoverModel'

const props = withDefaults(
  defineProps<{ rootChatId: string; editing?: boolean; folded?: boolean }>(),
  { folded: true },
)
const emit = defineEmits<{ activateInput: []; composerTarget: [target: HTMLElement] }>()
const chatSessions = useChatSessionsStore()
const viewportRef = ref<HTMLElement | null>(null)
const composerMountRef = ref<HTMLElement | null>(null)
const hoveredDetailNodeId = ref<string>()
const pinnedDetailNodeId = ref<string>()
const selectedCallId = ref<string>()
const selectedFoldMembers = ref<Map<string, string>>(new Map())
const unreadFoldMembers = ref<Map<string, number>>(new Map())
const readingFoldId = ref<string>()
const viewportSize = ref({ width: 0, height: 0 })
const inputState = ref(createMainInputState(`draft:${props.rootChatId}`))
const pinnedCrtIds = ref<Set<string>>(new Set())
const hiddenCrtIds = ref<Set<string>>(new Set())
const actionSelectedCallIds = ref<Map<string, string>>(new Map())
const recoveringGraph = ref(false)
const recoveryError = ref('')
let detailHideTimer: ReturnType<typeof setTimeout> | undefined
function getComposerTarget(): HTMLElement | null {
  return composerMountRef.value
}

const timelineSnapshot = computed(() => chatSessions.rootTimeline(props.rootChatId, 'tree'))
const timelineNodes = computed(() => timelineSnapshot.value?.nodes ?? [])
const rootTransientState = computed(() => chatSessions.rootTimelineStates[props.rootChatId])
const liveState = computed(() =>
  effectiveRootLiveState(
    props.rootChatId,
    rootTransientState.value,
    chatSessions.sessionsById,
  ),
)
const activeCrtRuns = computed(() =>
  effectiveRunFacts(
    props.rootChatId,
    timelineSnapshot.value?.activeRuns ?? [],
    liveState.value.activeRuns,
    liveState.value.activeTurns,
  ),
)
const pendingInputs = computed<VirtualInputNode[]>(() => {
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
const draftInputs = computed<VirtualInputNode[]>(() =>
  inputState.value.phase === 'editing'
    ? [
        {
          id: `input:draft:${props.rootChatId}`,
          content: '输入需求…',
          createdAt:
            Math.max(
              0,
              ...pendingInputs.value.map((item) => item.createdAt),
              ...(rootTransientState.value?.activeTurns ?? []).map((turn) => turn.createdAt ?? 0),
            ) + 1,
          state: inputState.value.phase,
        },
      ]
    : [],
)
const persistentGraph = computed(() =>
  projectPersistentExecutionGraph(
    timelineSnapshot.value
      ? { ...timelineSnapshot.value, activeRuns: activeCrtRuns.value }
      : {
          rootChatId: props.rootChatId,
          nodes: [],
          edges: [],
          activeRuns: activeCrtRuns.value,
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
const foldProjection = computed(() =>
  props.folded
    ? projectFoldExecutionGraph(projectInputNodes(liveGraph.value, draftInputs.value))
    : { graph: projectInputNodes(liveGraph.value, draftInputs.value), ranges: [] },
)
const graph = computed(() => foldProjection.value.graph)
const defaultNodePopovers = computed(() =>
  buildDefaultNodePopovers(graph.value.nodes, chatSessions.sessionsById),
)
const defaultPopoverById = computed(
  () => new Map(defaultNodePopovers.value.map((model) => [model.id, model] as const)),
)
const defaultPopoverAnchorIds = computed(
  () => new Set(defaultNodePopovers.value.map((model) => model.anchorNodeId)),
)
const endpointFoldProjection = computed(() =>
  props.folded
    ? projectFoldExecutionGraph(liveGraph.value)
    : { graph: liveGraph.value, ranges: [] },
)
const endpointGraph = computed(() => endpointFoldProjection.value.graph)
const layoutEngine = createIncrementalExecutionLayout()
const endpointLayoutEngine = createIncrementalExecutionLayout()
const layout = computed(() => layoutEngine.layout(graph.value))
const endpointLayout = computed(() => endpointLayoutEngine.layout(endpointGraph.value))
const inputEndpointId = computed(() => mainExecutionEndpoint(endpointGraph.value).id)

const canvas = useTreeCanvas({
  viewport: () => viewportRef.value,
  contentBounds: () => layout.value.bounds,
  initialFocus: () => ({ x: 0, y: layout.value.bounds.minY }),
  minScale: 0.32,
  maxScale: 2.2,
  padding: 18,
})

const projectedCrts = computed(() =>
  buildRunCrtModels({
    rootChatId: props.rootChatId,
    runs: activeCrtRuns.value,
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
  return new Set(
    [
      ...graph.value.nodes
        .filter((node) => node.activeRuns.some((run) => run.status === 'running'))
        .map((node) => node.id),
      ...projectedCrts.value
        .filter((card) => card.status === 'running' || card.status === 'waiting')
        .map((card) => card.anchorNodeId),
    ],
  )
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

const overlayPlacements = computed(() => {
  const positioned = new Map(layout.value.nodes.map((node) => [node.id, node]))
  const heightLimit = Math.max(160, viewportSize.value.height - 24)
  return layoutAnchoredCrts(
    [
      ...visibleCrts.value.flatMap((card, order) => {
        const node = positioned.get(card.anchorNodeId)
        if (!node) return []
        return [
          {
            id: card.id,
            anchor: canvas.worldToScreen(node),
            panel: { width: 340, height: Math.min(heightLimit, 280) },
            main: card.main,
            actionable: false,
            pinned: pinnedCrtIds.value.has(card.id),
            order: card.updatedAt || order,
          },
        ]
      }),
      ...defaultNodePopovers.value.flatMap((model, order) => {
        const node = positioned.get(model.anchorNodeId)
        if (!node) return []
        return [
          {
            id: model.id,
            anchor: canvas.worldToScreen(node),
            panel: { width: 360, height: Math.min(heightLimit, 420) },
            main: node.main,
            actionable: true,
            pinned: false,
            order: model.createdAt || order,
          },
        ]
      }),
    ],
    { ...viewportSize.value, margin: 12 },
  )
})
const crtPlacements = computed(() =>
  overlayPlacements.value.filter((placement) => retainedCrts.value.has(placement.id)),
)
const defaultPopoverPlacements = computed(() =>
  overlayPlacements.value.filter((placement) => defaultPopoverById.value.has(placement.id)),
)

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

function actorLabel(actor: TimelineActor): string {
  if (actor.kind === 'user') return actor.displayName?.trim() || '我'
  if (actor.kind === 'agent') return actor.roleType?.trim() || '主 Agent'
  if (actor.kind === 'tool') return actor.toolName
  return '系统'
}

function nodeTitle(node: (typeof layout.value.nodes)[number]): string {
  if (node.kind === 'start') return '开始'
  if (node.kind === 'input') return '我'
  if (node.kind === 'return') return `${actorLabel(node.actor)} · 回传`
  if (node.kind === 'tool-batch') {
    const detail = toolBatchDetail(node)
    return detail?.spawn ? 'Spawn' : detail?.calls[0]?.name || '工具'
  }
  if (node.kind === 'fold') return skinForNode(node).label
  if (node.kind === 'dispatch') return '派发'
  return actorLabel(node.actor)
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
  const layoutIndex = layout.value.nodes.findIndex((node) => node.id === ids[index])
  const target = viewportRef.value?.querySelector<SVGGElement>(
    `[data-execution-node-index="${layoutIndex}"]`,
  )
  target?.focus()
}

function isInteractiveNode(node: (typeof layout.value.nodes)[number]): boolean {
  return isInputActivationTarget(node) || hasNodeHoverDetail(node) || crtsByAnchor.value.has(node.id)
}

function cancelDetailHide(): void {
  if (detailHideTimer) clearTimeout(detailHideTimer)
  detailHideTimer = undefined
}

function showNodeDetail(node: (typeof layout.value.nodes)[number]): void {
  if (crtsByAnchor.value.has(node.id) || defaultPopoverAnchorIds.value.has(node.id)) return
  if (!hasNodeHoverDetail(node)) return
  cancelDetailHide()
  hoveredDetailNodeId.value = node.id
  if (node.kind === 'fold') readingFoldId.value = node.id
}

function hideNodeDetail(node: (typeof layout.value.nodes)[number]): void {
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
  pinnedDetailNodeId.value = undefined
  hoveredDetailNodeId.value = undefined
  selectedCallId.value = undefined
  readingFoldId.value = undefined
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

function isInputEndpoint(node: (typeof layout.value.nodes)[number]): boolean {
  return node.id === inputEndpointId.value
}
function isInputActivationTarget(node: (typeof layout.value.nodes)[number]): boolean {
  return isInputEndpoint(node) || node.id === `input:draft:${props.rootChatId}`
}

function onNodePointerDown(event: PointerEvent, node: (typeof layout.value.nodes)[number]): void {
  // Interactive nodes must retain pointer ownership. Otherwise the viewport's
  // pointer capture retargets the eventual click to the canvas.
  if (isInteractiveNode(node)) event.stopPropagation()
}

function edgePath(edge: (typeof layout.value.edges)[number]): string {
  return executionEdgeGeometry(edge.from, edge.to, EXECUTION_ICON_RADIUS).path
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

function resetLayout(): void {
  canvas.fitToView({ animate: true, duration: 300 })
}

function isPaused(node: (typeof layout.value.nodes)[number]): boolean {
  return node.activeRuns.some((run) => run.status === 'paused')
}

function isError(node: (typeof layout.value.nodes)[number]): boolean {
  return node.sourceFact?.termination?.code === 'error'
}

function activateNode(node: (typeof layout.value.nodes)[number]): void {
  if (canvas.consumeClickAfterDrag()) return
  if (isInputActivationTarget(node)) emit('activateInput')
  else if (defaultPopoverAnchorIds.value.has(node.id)) return
  else if (crtsByAnchor.value.has(node.id)) {
    for (const card of crtsByAnchor.value.get(node.id) ?? []) pinCrt(card.id)
  }
  else if (canPinNodeDetail(node)) {
    pinnedDetailNodeId.value = node.id
    hoveredDetailNodeId.value = node.id
    if (node.kind === 'fold') readingFoldId.value = node.id
  }
}

const composerAnchorStyle = computed(() => {
  const node = layout.value.nodes.find((item) => item.id === `input:draft:${props.rootChatId}`)
  if (!node) return undefined
  const position = anchoredPopoverPosition({
    anchor: canvas.worldToScreen(node),
    viewport: viewportSize.value,
    panel: { width: 380, height: 204 },
    gap: 28,
    margin: 12,
  })
  return { left: `${position.left}px`, top: `${position.top}px` }
})

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
const detailRelatedEdges = computed(() => {
  const node = detailNode.value
  return node
    ? graph.value.edges.filter((edge) => edge.from === node.id || edge.to === node.id)
    : []
})
const detailMaxHeight = computed(() => {
  return Math.min(420, Math.max(120, viewportSize.value.height - 184))
})
const detailPlacement = computed(() => {
  const node = detailNode.value
  const viewport = viewportRef.value
  if (!node || !viewport) return undefined
  const anchor = canvas.worldToScreen(node)
  const position = anchoredPopoverPosition({
    anchor,
    viewport: viewportSize.value,
    panel: { width: 360, height: detailMaxHeight.value },
    margin: 12,
  })
  return {
    style: { left: `${position.left}px`, top: `${position.top}px` },
    nodeOffset: { x: anchor.x - position.left, y: anchor.y - position.top },
    placement: position.placement,
  }
})
const detailAnchorStyle = computed(() => detailPlacement.value?.style)
const foldRailSide = computed(() =>
  detailPlacement.value ? oppositePopoverPlacement(detailPlacement.value.placement) : 'left',
)
function batchStatus(node: (typeof layout.value.nodes)[number]): ToolBatchVisualStatus | undefined {
  return toolBatchDetail(node)?.status
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
watch(
  () =>
    foldProjection.value.ranges.map((range) => ({
      id: range.id,
      members: range.members,
    })),
  (ranges) => {
    if (!props.folded) return
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
    inputState.value = createMainInputState(`draft:${rootChatId}`)
    layoutEngine.reset()
    endpointLayoutEngine.reset()
    recoveryError.value = ''
    selectedFoldMembers.value = new Map()
    unreadFoldMembers.value = new Map()
    actionSelectedCallIds.value = new Map()
    knownFoldCounts = new Map()
    if (previousRootChatId && previousRootChatId !== rootChatId) {
      pinnedCrtIds.value = new Set()
      hiddenCrtIds.value = new Set()
    }
    closeNodeDetail()
    void nextTick(resetLayout)
  },
  { immediate: true },
)
watch(
  () => props.folded,
  () => closeNodeDetail(),
)
watch(
  () => endpointLayout.value.height,
  () => {
    void nextTick(() => canvas.followContentEnd(endpointLayout.value.height))
  },
)
watch(
  () => props.editing,
  (editing) => {
    inputState.value = reduceMainInputState(inputState.value, {
      type: editing ? 'edit' : 'close',
    })
  },
  { immediate: true },
)
onMounted(() => {
  viewportRO = new ResizeObserver(() => {
    viewportSize.value = {
      width: viewportRef.value?.clientWidth ?? 0,
      height: viewportRef.value?.clientHeight ?? 0,
    }
    canvas.fitToView()
  })
  if (viewportRef.value) viewportRO.observe(viewportRef.value)
  void nextTick(() => {
    resetLayout()
    if (composerMountRef.value) emit('composerTarget', composerMountRef.value)
  })
  window.addEventListener('keydown', onEscape)
})
onBeforeUnmount(() => {
  viewportRO?.disconnect()
  cancelDetailHide()
  window.removeEventListener('keydown', onEscape)
})

defineExpose({ resetLayout, getComposerTarget })
</script>

<template>
  <section class="execution-tree" aria-label="Agent 执行节点树">
    <div
      ref="viewportRef"
      class="tree-viewport"
      :class="{ 'is-panning': canvas.dragging.value }"
      @pointerdown="canvas.onPointerDown"
      @pointermove="canvas.onPointerMove"
      @pointerup="canvas.onPointerUp"
      @pointercancel="canvas.onPointerUp"
      @lostpointercapture="canvas.onPointerUp"
      @wheel.prevent="canvas.onWheel"
    >
      <svg class="tree-canvas" width="100%" height="100%" role="img">
        <defs>
          <filter id="execution-node-glow" x="-80%" y="-80%" width="260%" height="260%">
            <feGaussianBlur stdDeviation="4" result="blur" />
            <feMerge>
              <feMergeNode in="blur" />
              <feMergeNode in="SourceGraphic" />
            </feMerge>
          </filter>
        </defs>
        <g class="tree-world" :transform="canvas.transform.value">
          <g class="tree-edges">
            <FiberPulseLine
              v-for="edge in layout.edges"
              :key="edge.id"
              :d="edgePath(edge)"
              :color="edgeStyle(edge.kind).color"
              :kind="edge.kind"
              :active="runningTailIds.has(edge.from.id) || runningTailIds.has(edge.to.id)"
              :delay="(edge.to.createdAt % 1300) / 1000"
            />
          </g>
          <g
            v-for="(node, nodeIndex) in layout.nodes"
            :key="node.id"
            class="execution-node"
            :class="[
              `kind-${node.kind}`,
              {
                'is-running': runningTailIds.has(node.id),
                'is-detail-active': detailNode?.id === node.id,
                'is-paused': isPaused(node),
                'is-error': isError(node),
                'is-revoked': node.status === 'revoked',
                'is-input-pending': node.inputState === 'pending',
                'is-input-consuming': node.inputState === 'consuming',
                [`is-tool-${batchStatus(node)}`]: !!batchStatus(node),
              },
            ]"
            :transform="`translate(${node.x} ${node.y})`"
            :tabindex="isInteractiveNode(node) ? 0 : undefined"
            :role="isInteractiveNode(node) ? 'button' : undefined"
            :aria-label="isInteractiveNode(node) ? nodeAriaLabel(node) : undefined"
            :data-execution-node-index="isInteractiveNode(node) ? nodeIndex : undefined"
            @pointerdown="onNodePointerDown($event, node)"
            @pointerenter="showNodeDetail(node)"
            @pointerleave="hideNodeDetail(node)"
            @focus="showNodeDetail(node)"
            @blur="hideNodeDetail(node)"
            @keydown.enter.prevent.stop="activateNode(node)"
            @keydown.space.prevent.stop="activateNode(node)"
            @keydown.down.prevent.stop="focusRelativeNode(node.id, 1)"
            @keydown.right.prevent.stop="focusRelativeNode(node.id, 1)"
            @keydown.up.prevent.stop="focusRelativeNode(node.id, -1)"
            @keydown.left.prevent.stop="focusRelativeNode(node.id, -1)"
            @keydown.home.prevent.stop="focusRelativeNode(node.id, 'first')"
            @keydown.end.prevent.stop="focusRelativeNode(node.id, 'last')"
            @click.stop="activateNode(node)"
          >
            <circle class="node-halo" cx="0" cy="0" r="18" :stroke="skinForNode(node).accent" />
            <circle class="node-icon" cx="0" cy="0" r="15" :stroke="skinForNode(node).accent" />
            <circle class="node-state-overlay" cx="0" cy="0" r="19" />
            <text class="node-glyph" x="0" y="7" :fill="skinForNode(node).accent">
              {{ skinForNode(node).glyph }}
            </text>
            <text class="node-title" x="0" y="34">{{ nodeTitle(node) }}</text>
            <text v-if="node.sourceFact?.termination" class="node-termination" x="0" y="47">
              {{ terminationDisplay(node.sourceFact.termination).label }}
            </text>
            <g v-if="node.kind === 'fold' && node.fold" class="node-fold-count">
              <circle cx="12" cy="-12" r="8" :stroke="skinForNode(node).accent" />
              <text x="12" y="-9">{{ node.fold.members.length }}</text>
            </g>
            <circle
              v-if="runningTailIds.has(node.id)"
              class="node-running-dot"
              cx="11"
              cy="-11"
              r="3"
              :fill="skinForNode(node).accent"
            />
          </g>
        </g>
      </svg>
      <div class="tree-overlay" aria-live="polite">
        <div v-if="persistentGraph.diagnostics.length" class="graph-diagnostic" role="alert">
          <span>执行图数据异常（{{ persistentGraph.diagnostics.length }}）</span>
          <button type="button" :disabled="recoveringGraph" @click.stop="recoverGraph">
            {{ recoveringGraph ? '同步中…' : '重新同步' }}
          </button>
          <small v-if="recoveryError">{{ recoveryError }}</small>
        </div>
        <svg
          v-if="overlayPlacements.length"
          class="crt-anchor-lines"
          width="100%"
          height="100%"
          aria-hidden="true"
        >
          <line
            v-for="placement in overlayPlacements"
            :key="`${placement.id}:line`"
            :x1="placement.line.from.x"
            :y1="placement.line.from.y"
            :x2="placement.line.to.x"
            :y2="placement.line.to.y"
          />
        </svg>
        <div
          v-for="placement in crtPlacements"
          :key="placement.id"
          class="run-crt-anchor"
          :class="`is-${placement.placement}`"
          :style="{
            left: `${placement.left}px`,
            top: `${placement.top}px`,
            zIndex: placement.actionable ? 6 : placement.pinned ? 5 : 4,
          }"
        >
          <AnchoredRunCrt
            v-if="crtById.get(placement.id)"
            :card="crtById.get(placement.id)!"
            :pinned="pinnedCrtIds.has(placement.id)"
            :max-height="placement.panel.height"
            @pin="pinCrt(placement.id)"
            @unpin="unpinCrt(placement.id)"
            @close="closeCrt(placement.id)"
          />
        </div>
        <div v-if="crtVisibility.hiddenPassive" class="crt-overflow-summary" role="status">
          +{{ crtVisibility.hiddenPassive }} 个后台运行
        </div>
        <div
          v-for="view in defaultPopoverViews"
          :key="view.model.id"
          :style="{
            left: `${view.placement.left}px`,
            top: `${view.placement.top}px`,
            zIndex: 6,
          }"
          class="node-detail-anchor is-action-default"
          @pointerdown.stop
          @pointermove.stop
          @pointerup.stop
          @click.stop
          @wheel.stop
        >
          <ExecutionNodePopover
            :node="view.display"
            :fold-node="view.anchor.kind === 'fold' ? view.anchor : undefined"
            :related-edges="view.relatedEdges"
            :pinned="false"
            :max-height="view.placement.panel.height"
            :selected-call-id="selectedActionCall(view.model)"
            :chat-id="view.model.chatId"
            :approval="view.model.approval"
            :question="view.model.question"
            @select-call="selectActionCall(view.model.id, $event)"
          />
        </div>
        <div
          v-if="detailNode && detailAnchorStyle && !defaultPopoverAnchorIds.has(detailNode.id)"
          :style="detailAnchorStyle"
          class="node-detail-anchor"
          @pointerenter="keepNodeDetailOpen"
          @pointerleave="leaveNodeDetail"
          @pointerdown.stop
          @pointermove.stop
          @pointerup.stop
          @wheel.stop
        >
          <FoldTabRail
            v-if="detailNode.kind === 'fold' && detailNode.fold && detailPlacement"
            :members="detailNode.fold.members"
            :selected-member-id="detailFoldMember?.id"
            :unread-count="unreadFoldMembers.get(detailNode.id)"
            :anchor-x="detailPlacement.nodeOffset.x"
            :anchor-y="detailPlacement.nodeOffset.y"
            :side="foldRailSide"
            @select="detailNode && selectFoldMember(detailNode.id, $event)"
            @interaction="detailNode && onFoldRailInteraction(detailNode.id, $event)"
          />
          <ExecutionNodePopover
            v-if="detailDisplayNode"
            :node="detailDisplayNode"
            :fold-node="detailNode.kind === 'fold' ? detailNode : undefined"
            :related-edges="detailRelatedEdges"
            :pinned="detailPinned"
            :max-height="detailMaxHeight"
            :selected-call-id="selectedCallId"
            @select-call="selectedCallId = $event"
            @close="closeNodeDetail"
          />
        </div>
        <div
          v-show="editing && composerAnchorStyle"
          :style="composerAnchorStyle"
          class="node-composer-anchor"
          @pointerdown.stop
          @pointermove.stop
          @pointerup.stop
          @wheel.stop
        >
          <div ref="composerMountRef" class="node-composer-mount" />
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped lang="less">
.execution-tree {
  position: absolute;
  inset: 0;
  width: 100%;
  height: 100%;
  overflow: visible;
}
.tree-viewport {
  position: absolute;
  inset: 0;
  cursor: grab;
  touch-action: none;
  background: transparent;
  user-select: none;
  -webkit-user-select: none;
}
.tree-viewport.is-panning {
  cursor: grabbing;
}
.tree-canvas {
  display: block;
  user-select: none;
  -webkit-user-select: none;
}
.tree-world {
  transform-origin: 0 0;
}
.tree-overlay {
  position: absolute;
  inset: 0;
  overflow: hidden;
  pointer-events: none;
}
.crt-anchor-lines {
  position: absolute;
  inset: 0;
  overflow: visible;
  pointer-events: none;
}
.crt-anchor-lines line {
  stroke: rgba(181, 255, 242, 0.52);
  stroke-width: 1;
  stroke-dasharray: 3 4;
}
.run-crt-anchor {
  position: absolute;
  width: 340px;
  pointer-events: auto;
}
.crt-overflow-summary {
  position: absolute;
  left: 12px;
  bottom: 12px;
  z-index: 3;
  padding: 5px 8px;
  border: 1px solid rgba(181, 255, 242, 0.34);
  border-radius: 6px;
  color: rgba(224, 255, 246, 0.72);
  background: rgba(5, 16, 13, 0.9);
  font: 9px/1.2 ui-monospace, monospace;
}
.graph-diagnostic {
  position: absolute;
  top: 12px;
  left: 50%;
  z-index: 8;
  display: flex;
  align-items: center;
  gap: 8px;
  max-width: calc(100% - 24px);
  padding: 7px 10px;
  border: 1px solid rgba(255, 113, 140, 0.72);
  border-radius: 7px;
  color: #ffe3e9;
  background: rgba(38, 8, 16, 0.94);
  transform: translateX(-50%);
  pointer-events: auto;
  font: 11px/1.3 system-ui, sans-serif;
}
.graph-diagnostic button {
  border: 1px solid rgba(255, 227, 233, 0.5);
  border-radius: 5px;
  color: inherit;
  background: transparent;
  cursor: pointer;
}
.graph-diagnostic small {
  color: #ffb6c4;
}
.node-detail-anchor {
  position: absolute;
  z-index: 2;
  pointer-events: auto;
}
.node-composer-anchor {
  position: absolute;
  top: 0;
  left: 0;
  width: 380px;
  min-height: 204px;
  pointer-events: auto;
}
.node-composer-mount {
  width: 100%;
  min-height: 204px;
  pointer-events: auto;
  user-select: text;
  -webkit-user-select: text;
}
.node-halo {
  fill: none;
  stroke-width: 8;
  opacity: 0;
}
.execution-node[role='button'] {
  cursor: pointer;
  outline: none;
}
.execution-node[role='button']:focus-visible .node-state-overlay {
  stroke: #b5fff2;
}
.node-icon {
  fill: rgba(8, 25, 37, 0.88);
  stroke-width: 1.4;
}
.node-state-overlay {
  fill: none;
  stroke: transparent;
  stroke-width: 2;
  stroke-dasharray: 3 4;
}
.execution-node.is-paused .node-state-overlay {
  stroke: #f6c85f;
}
.execution-node.is-error .node-state-overlay {
  stroke: #ff718c;
  stroke-dasharray: none;
}
.execution-node.is-tool-active .node-state-overlay {
  stroke: #6bcff7;
  animation: node-spin 1.2s linear infinite;
}
.execution-node.is-tool-pending .node-state-overlay {
  stroke: #ffca73;
}
.execution-node.is-tool-completed .node-state-overlay {
  stroke: #8bf0b1;
  stroke-dasharray: none;
}
.execution-node.is-tool-error .node-state-overlay {
  stroke: #ff718c;
  stroke-dasharray: none;
}
.execution-node.is-tool-rejected .node-state-overlay {
  stroke: #93a4ad;
  stroke-dasharray: 2 3;
}
.execution-node.is-revoked .node-state-overlay {
  stroke: #93a4ad;
}
.execution-node.is-revoked {
  opacity: 0.46;
}
.execution-node.is-input-pending {
  opacity: 0.52;
}
.execution-node.is-input-pending .node-icon {
  stroke-dasharray: 3 3;
}
.execution-node.is-input-consuming {
  opacity: 0.72;
}
.execution-node.is-input-consuming .node-state-overlay {
  stroke: #6bcff7;
  animation: node-spin 1.2s linear infinite;
}
.node-glyph {
  font:
    700 18px/1 ui-monospace,
    SFMono-Regular,
    Menlo,
    monospace;
  text-anchor: middle;
}
.node-title {
  fill: #e6f8ff;
  font:
    700 11px/1.2 system-ui,
    sans-serif;
  text-anchor: middle;
}
.node-termination {
  fill: #ffb6c4;
  font:
    700 8px/1.2 system-ui,
    sans-serif;
  text-anchor: middle;
}
.node-fold-count circle {
  fill: rgba(7, 19, 30, 0.98);
  stroke-width: 1;
}
.node-fold-count text {
  fill: #e6f8ff;
  font:
    700 7px/1 ui-monospace,
    monospace;
  text-anchor: middle;
}
.execution-node.is-running .node-halo {
  opacity: 0.42;
  filter: url(#execution-node-glow);
  animation: node-breathe 1.4s ease-in-out infinite;
}
.execution-node.is-detail-active .node-halo {
  filter: url(#execution-node-glow);
  animation: node-detail-pulse 1.05s ease-in-out infinite;
}
.execution-node.is-detail-active .node-icon {
  filter: url(#execution-node-glow);
}
.execution-node.is-detail-active .node-title {
  fill: #fff;
}
.node-running-dot {
  animation: node-dot 0.9s ease-in-out infinite alternate;
}
@keyframes node-detail-pulse {
  0%,
  100% {
    stroke-width: 5;
    opacity: 0.24;
  }
  50% {
    stroke-width: 10;
    opacity: 0.68;
  }
}
@keyframes node-breathe {
  from {
    stroke-width: 4;
    opacity: 0.18;
  }
  to {
    stroke-width: 11;
    opacity: 0.54;
  }
}
@keyframes node-dot {
  from {
    opacity: 0.3;
  }
  to {
    opacity: 1;
  }
}
@keyframes node-spin {
  to {
    stroke-dashoffset: -14;
  }
}
@media (prefers-reduced-motion: reduce) {
  .execution-node.is-running .node-halo,
  .execution-node.is-detail-active .node-halo,
  .node-running-dot,
  .execution-node.is-tool-active .node-state-overlay,
  .execution-node.is-input-consuming .node-state-overlay {
    animation: none;
  }
  .execution-node.is-detail-active .node-halo {
    stroke-width: 8;
    opacity: 0.52;
  }
}
</style>
