<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, ref, shallowRef, toRef, watch } from 'vue'
import {
  VueFlow,
  type NodeMouseEvent,
  type ViewportTransform,
  type VueFlowStore,
} from '@vue-flow/core'
import '@vue-flow/core/dist/style.css'
import '@vue-flow/core/dist/theme-default.css'
import {
  Aim,
  ArrowLeft,
  ArrowRight,
  FullScreen,
  Minus,
  Plus,
  Refresh,
  VideoPause,
  VideoPlay,
  Warning,
} from '@element-plus/icons-vue'
import type { RootTimelineSnapshot } from '@/application/backend/public'
import { useChatSessionsStore } from '@/application/public'
import type { NyxusContentSelection, NyxusReaderFoldMode } from '@/features/pets/nyxus/public'
import {
  projectWorkflowGraph,
  resolveWorkflowGraphSelection,
  type WorkflowGraphNode,
  type WorkflowGraphNodeData,
  type WorkflowGraphEdge,
  type WorkflowGraphProjection,
} from './graphModel'
import { useWorkflowController } from './useWorkflowController'
import { useRuntimeMotion } from './useRuntimeMotion'
import { orthogonalPathBetween } from './motionPolicy'
import { useWorkflowPointerHighlight } from './useWorkflowPointerHighlight'
import WorkflowContentNode from './WorkflowContentNode.vue'
import WorkflowHeaderNode from './WorkflowHeaderNode.vue'
import WorkflowResultEdge from './WorkflowResultEdge.vue'
import WorkflowHeaderStepNode from './WorkflowHeaderStepNode.vue'
import WorkflowHeaderGroupNode from './WorkflowHeaderGroupNode.vue'
import WorkflowHeaderCallsNode from './WorkflowHeaderCallsNode.vue'
import WorkflowHeaderEdge from './WorkflowHeaderEdge.vue'
import WorkflowFocusEdge from './WorkflowFocusEdge.vue'
import WorkflowStepDetails from './WorkflowStepDetails.vue'
import {
  absoluteGraphPosition,
  headerTemplateNodeId,
  type HeaderGroupToggleEvent,
  type HeaderSelection,
  type HeaderScopeEvent,
} from './headerGraph'
import type { HeaderScopeSelection } from './headerState'
import { projectReplayTimeline, projectWorkflowStepDetails } from './workflowStepDetails'

const props = withDefaults(
  defineProps<{
    chatId: string
    timeline?: RootTimelineSnapshot
    suspended?: boolean
    foldMode?: NyxusReaderFoldMode
    readerOpen?: boolean
    selection?: NyxusContentSelection
    focusSourceChatId?: string
    focusInteractionId?: string
    focusNonce?: number
  }>(),
  { suspended: false, foldMode: 'participant', readerOpen: false, focusNonce: 0 },
)
const emit = defineEmits<{
  selectContent: [payload: NyxusContentSelection]
  replayTimelineChange: [payload: { replay: boolean; timeline?: RootTimelineSnapshot }]
  selectStep: [payload: HeaderSelection]
  selectHeaderScope: [payload: HeaderScopeEvent]
}>()
const chatSessions = useChatSessionsStore()

const controller = useWorkflowController(toRef(props, 'chatId'), toRef(props, 'suspended'))
const replayTimeline = shallowRef<RootTimelineSnapshot>()
const displayTimeline = computed(() =>
  controller.replay.value && controller.history.value
    ? projectReplayTimeline(replayTimeline.value, controller.workflowState.value)
    : controller.replay.value
      ? replayTimeline.value
      : props.timeline,
)
const headerSelections = ref<Record<string, HeaderScopeSelection>>({})
/** 用户手动展开的 group（key: `${headerId}:${groupId}`）。活跃 group 不受此约束。 */
const userExpandedGroups = ref<Set<string>>(new Set())
/** 是否启用「非活跃 group 自动收起」；关闭后所有 group 保持展开。 */
const autoCollapseEnabled = ref(true)
const selectedStep = shallowRef<HeaderSelection>()

function groupKey(headerId: string, groupId: string): string {
  return `${headerId}:${groupId}`
}
function onToggleGroup(event: HeaderGroupToggleEvent): void {
  const key = groupKey(event.headerId, event.groupId)
  const next = new Set(userExpandedGroups.value)
  if (next.has(key)) next.delete(key)
  else next.add(key)
  userExpandedGroups.value = next
}
function resetGroupOverrides(headerId: string): void {
  const prefix = `${headerId}:`
  userExpandedGroups.value = new Set(
    [...userExpandedGroups.value].filter((key) => !key.startsWith(prefix)),
  )
}
function closeStepDetails(restoreFocus = true): void {
  const selection = selectedStep.value
  selectedStep.value = undefined
  controller.clearDetailHistory()
  if (!restoreFocus || !selection) return
  void nextTick(() => {
    const triggers = flowHostRef.value?.querySelectorAll<HTMLButtonElement>(
      '[data-workflow-header-id][data-workflow-template-node]',
    )
    Array.from(triggers ?? [])
      .find(
        (trigger) =>
          trigger.dataset.workflowHeaderId === selection.headerId &&
          trigger.dataset.workflowTemplateNode === selection.templateNodeId,
      )
      ?.focus()
  })
}
function selectHeaderScope(event: HeaderScopeEvent): void {
  closeStepDetails(false)
  headerSelections.value = { ...headerSelections.value, [event.headerId]: event.scope }
  emit('selectHeaderScope', event)
}
const liveTurns = computed(() => {
  if (controller.replay.value) return []
  const chatIds = new Set([
    props.chatId,
    ...(displayTimeline.value?.branches?.map((branch) => branch.chatId) ?? []),
    ...(displayTimeline.value?.nodes.map((node) => node.sourceChatId) ?? []),
    ...(displayTimeline.value?.activeRuns.map((run) => run.chatId).filter(Boolean) ?? []),
  ])
  return [...chatIds].flatMap((chatId) =>
    chatId ? chatSessions.sessionsById[chatId]?.activeTurns ?? [] : [],
  )
})
const baseProjection = computed(() =>
  projectWorkflowGraph(
    controller.workflowState.value,
    displayTimeline.value,
    props.foldMode,
    headerSelections.value,
    liveTurns.value,
  ),
)
const selectedGraphNodeId = computed(() => {
  const selection = props.selection
  if (!selection) return undefined
  const resolution = resolveWorkflowGraphSelection(baseProjection.value, selection)
  return resolution.status === 'available' ? resolution.graphNodeId : undefined
})
const focusTransition = shallowRef<{ id: string; edge: WorkflowGraphEdge }>()
let focusSerial = 0
function projectNodeSelection(node: WorkflowGraphNode): WorkflowGraphNode {
  const data = node.data
  const className = [node.class, { selected: node.id === selectedGraphNodeId.value }]
  if (!data || data.kind !== 'header-step') {
    return { ...node, class: className }
  }
  const step = selectedStep.value
  return {
    ...node,
    class: className,
    data: {
      ...data,
      selected: step?.headerId === data.headerId && step.templateNodeId === data.template.id,
    },
  }
}
const activeGroupIds = computed(() => baseProjection.value.activeGroupIds)
function groupCollapsed(headerId: string, groupId: string): boolean {
  if (activeGroupIds.value.has(groupId)) return false
  if (userExpandedGroups.value.has(groupKey(headerId, groupId))) return false
  return autoCollapseEnabled.value
}
/** 收起态 group 的标题条高度（宽度不变，复用硬编码坐标） */
const COLLAPSED_GROUP_HEIGHT = 44
/** 节点左侧/右侧边界的中点（绝对坐标），用作收起态重路由边的端点 */
function sideMidpoint(
  node: WorkflowGraphNode,
  side: 'left' | 'right',
  nodes: WorkflowGraphNode[],
): { x: number; y: number } {
  const origin = absoluteGraphPosition(node, nodes)
  const height = Number(node.height ?? 0)
  return side === 'left'
    ? { x: origin.x, y: origin.y + height / 2 }
    : { x: origin.x + Number(node.width ?? 0), y: origin.y + height / 2 }
}
/**
 * 收起 group 的跨 group 连线重路由：把收起的一端改连到该 group 容器（边界中点），
 * 另一端保持；重算正交折线路径并清除旧 label 锚点。source/target 都收起时应由调用方直接舍弃。
 */
function rerouteCollapsedEdge(
  edge: WorkflowGraphEdge,
  sourceCollapsed: boolean,
  targetCollapsed: boolean,
  nodes: WorkflowGraphNode[],
  stepToGroup: ReadonlyMap<string, string>,
): WorkflowGraphEdge | undefined {
  if (!edge.data) return undefined
  const groupId = stepToGroup.get(sourceCollapsed ? edge.source : edge.target)
  const groupNode = groupId ? nodes.find((node) => node.id === groupId) : undefined
  const keptNode = nodes.find((node) => node.id === (sourceCollapsed ? edge.target : edge.source))
  if (!groupNode || !keptNode) return undefined
  const start = sideMidpoint(groupNode, sourceCollapsed ? 'right' : 'left', nodes)
  const end = sideMidpoint(
    keptNode,
    absoluteGraphPosition(keptNode, nodes).x < absoluteGraphPosition(groupNode, nodes).x
      ? 'right'
      : 'left',
    nodes,
  )
  const points = orthogonalPathBetween(start, end)
  const data = { ...edge.data, points, labelPoint: undefined }
  return sourceCollapsed
    ? { ...edge, source: groupNode.id, sourceHandle: undefined, data }
    : { ...edge, target: groupNode.id, targetHandle: undefined, data }
}
const projection = computed<WorkflowGraphProjection>(() => {
  const base = baseProjection.value
  const collapsedStepIds = new Set<string>()
  const stepToGroup = new Map<string, string>()
  for (const node of base.nodes) {
    const data = node.data
    if (data?.kind !== 'header-step') continue
    stepToGroup.set(node.id, `${data.headerId}:group:${data.template.group}`)
    if (groupCollapsed(data.headerId, data.template.group)) collapsedStepIds.add(node.id)
  }
  const nodes = base.nodes.flatMap((node): WorkflowGraphNode[] => {
    const data = node.data
    if (data?.kind === 'header-step' && collapsedStepIds.has(node.id)) return []
    if (data?.kind === 'header-group') {
      const collapsed = groupCollapsed(data.headerId, data.groupId)
      return [
        {
          ...node,
          height: collapsed ? COLLAPSED_GROUP_HEIGHT : node.height,
          data: {
            ...data,
            collapsed,
            active: activeGroupIds.value.has(data.groupId),
          },
        },
      ]
    }
    return [projectNodeSelection(node)]
  })
  const allEdges = focusTransition.value ? [...base.edges, focusTransition.value.edge] : base.edges
  const edges = allEdges.flatMap((edge): WorkflowGraphEdge[] => {
    const data = edge.data
    if (data?.semantic !== 'template') return [edge]
    const sourceCollapsed = collapsedStepIds.has(edge.source)
    const targetCollapsed = collapsedStepIds.has(edge.target)
    if (sourceCollapsed && targetCollapsed) return []
    if (sourceCollapsed || targetCollapsed) {
      const rerouted = rerouteCollapsedEdge(
        edge,
        sourceCollapsed,
        targetCollapsed,
        nodes,
        stepToGroup,
      )
      return rerouted ? [rerouted] : []
    }
    return [edge]
  })
  return { ...base, nodes, edges }
})
const stepDetailHistory = computed(() => {
  if (!controller.replay.value || !controller.history.value) return controller.detailHistory.value
  const state = controller.workflowState.value
  return {
    ...controller.history.value,
    occurrences: state ? Object.values(state.occurrences) : [],
    gaps: state?.gaps ?? [],
    historyComplete: state?.historyComplete ?? controller.history.value.historyComplete,
  }
})
const stepDetailModel = computed(() => {
  if (!selectedStep.value) return undefined
  return projectWorkflowStepDetails({
    selection: selectedStep.value,
    history: stepDetailHistory.value,
    resolveAnchor: graphSelection,
  })
})
const flow = ref<VueFlowStore>()
const flowHostRef = ref<HTMLElement | null>(null)
const pointerHighlightRef = ref<HTMLElement | null>(null)
useWorkflowPointerHighlight({
  host: flowHostRef,
  layer: pointerHighlightRef,
  suspended: toRef(props, 'suspended'),
})
const cameraByRoot = new Map<string, ViewportTransform>()
const cameraRootId = computed(
  () =>
    displayTimeline.value?.rootChatId ?? controller.workflowState.value?.rootChatId ?? props.chatId,
)
const {
  refreshVisibility: refreshMotionVisibility,
  focusAlongPath,
  cancelFocusMotion,
} = useRuntimeMotion({
  scope: flowHostRef,
  projection,
  rootChatId: cameraRootId,
  timelineRevision: computed(() => displayTimeline.value?.capturedEventSeq ?? 0),
  change: controller.workflowChange,
  replay: controller.replay,
  suspended: toRef(props, 'suspended'),
  synced: controller.synced,
  hidden: controller.hidden,
})
let resizeFrame = 0
let resolvedFocusKey = ''

function copyViewport(viewport: ViewportTransform): ViewportTransform {
  return { x: viewport.x, y: viewport.y, zoom: viewport.zoom }
}

function currentViewport(): ViewportTransform | undefined {
  const viewport = flow.value?.viewport.value
  return viewport ? copyViewport(viewport) : undefined
}

function focusNode(nodeId: string | undefined): void {
  if (!nodeId || !flow.value) return
  const node = projection.value.nodes.find((candidate) => candidate.id === nodeId)
  if (!node) return
  const width = typeof node.width === 'number' ? node.width : 184
  const height = typeof node.height === 'number' ? node.height : 82
  const position = absoluteGraphPosition(node, projection.value.nodes)
  void flow.value.setCenter(position.x + width / 2, position.y + height / 2, {
    zoom: 1,
    duration: 180,
  })
}

function cancelFocusTransition(): void {
  cancelFocusMotion()
  focusTransition.value = undefined
}

function centerOnWorldPoint(point: { x: number; y: number }): void {
  const zoom = currentViewport()?.zoom ?? 1
  void flow.value?.setCenter(point.x, point.y, { zoom, duration: 0 })
}

function nodeCenter(node: WorkflowGraphNode): { x: number; y: number } {
  const position = absoluteGraphPosition(node, baseProjection.value.nodes)
  return {
    x: position.x + Number(node.width ?? 184) / 2,
    y: position.y + Number(node.height ?? 82) / 2,
  }
}

function relationshipPath(source: WorkflowGraphNode, target: WorkflowGraphNode) {
  return orthogonalPathBetween(nodeCenter(source), nodeCenter(target))
}

function onPaneReady(store: VueFlowStore): void {
  flow.value = store
  const saved = cameraByRoot.get(cameraRootId.value)
  if (saved) void store.setViewport(saved)
  else void nextTick(() => focusNode(projection.value.activeHeaderId))
  refreshMotionVisibility()
}

function recordViewport(event: { flowTransform: ViewportTransform }): void {
  cameraByRoot.set(cameraRootId.value, copyViewport(event.flowTransform))
  refreshMotionVisibility()
}

function resetZoom(): void {
  const viewport = currentViewport()
  if (!flow.value || !viewport) return
  void flow.value.setViewport({ x: viewport.x, y: viewport.y, zoom: 1 }, { duration: 120 })
}

function graphSelection(selection: NyxusContentSelection) {
  return resolveWorkflowGraphSelection(baseProjection.value, selection)
}

function selectNode(event: NodeMouseEvent): void {
  const data = event.node.data as WorkflowGraphNodeData
  if (data.kind === 'content') {
    emit('selectContent', { nodeId: data.node.id, sourceChatId: data.node.sourceChatId })
    return
  }
}

function selectContentNode(data: Extract<WorkflowGraphNodeData, { kind: 'content' }>): void {
  emit('selectContent', { nodeId: data.node.id, sourceChatId: data.node.sourceChatId })
}

function selectStep(selection: HeaderSelection): void {
  selectedStep.value = selection
  emit('selectStep', selection)
  if (controller.replay.value && controller.history.value) return
  void controller.loadDetailHistory({
    sourceChatId: selection.chatId,
    ...(selection.scope.runId ? { runId: selection.scope.runId } : {}),
  })
}

function retryStepDetails(): void {
  if (selectedStep.value) selectStep(selectedStep.value)
}

function selectStepContent(selection: NyxusContentSelection, graphNodeId: string): void {
  const step = selectedStep.value
  const sourceId = step ? headerTemplateNodeId(step.headerId, step.templateNodeId) : undefined
  const source = sourceId
    ? baseProjection.value.nodes.find((node) => node.id === sourceId)
    : undefined
  const target = baseProjection.value.nodes.find((node) => node.id === graphNodeId)
  cancelFocusTransition()
  if (source && target) {
    const points = relationshipPath(source, target)
    const id = `workflow-focus:${++focusSerial}`
    focusTransition.value = {
      id,
      edge: {
        id,
        source: source.id,
        target: target.id,
        type: 'focus',
        selectable: false,
        focusable: false,
        class: 'workflow-edge workflow-focus-relation',
        data: {
          relation: '显式内容锚点',
          semantic: 'template',
          points,
          evidenced: true,
          accent: source.data?.kind === 'header-step' ? source.data.visual.accent : undefined,
        },
      },
    }
    void nextTick(() => {
      focusAlongPath({
        id,
        points,
        onProgress: centerOnWorldPoint,
        onComplete: () => {
          if (focusTransition.value?.id === id) focusTransition.value = undefined
        },
      })
    })
  } else {
    focusNode(graphNodeId)
  }
  emit('selectContent', selection)
}

async function loadHistory(): Promise<void> {
  closeStepDetails(false)
  replayTimeline.value = props.timeline ? structuredClone(props.timeline) : undefined
  await controller.loadHistory()
}

function returnLive(): void {
  closeStepDetails(false)
  controller.returnLive()
  replayTimeline.value = undefined
}

watch(cameraRootId, (rootChatId, previousRootChatId) => {
  cancelFocusTransition()
  headerSelections.value = {}
  const viewport = currentViewport()
  if (previousRootChatId && viewport) cameraByRoot.set(previousRootChatId, viewport)
  void nextTick(() => {
    const saved = cameraByRoot.get(rootChatId)
    if (saved && flow.value) void flow.value.setViewport(saved)
    else focusNode(projection.value.activeHeaderId)
  })
})
watch(
  () => props.readerOpen,
  () => {
    const viewport = currentViewport()
    const host = flowHostRef.value
    if (!viewport || !host || !flow.value) return
    const before = host.getBoundingClientRect()
    const worldCenter = {
      x: (before.width / 2 - viewport.x) / viewport.zoom,
      y: (before.height / 2 - viewport.y) / viewport.zoom,
    }
    if (resizeFrame) cancelAnimationFrame(resizeFrame)
    void nextTick(() => {
      resizeFrame = requestAnimationFrame(() => {
        resizeFrame = 0
        const nextHost = flowHostRef.value
        if (!nextHost || !flow.value) return
        const after = nextHost.getBoundingClientRect()
        void flow.value.setViewport({
          x: after.width / 2 - worldCenter.x * viewport.zoom,
          y: after.height / 2 - worldCenter.y * viewport.zoom,
          zoom: viewport.zoom,
        })
        refreshMotionVisibility()
      })
    })
  },
  { flush: 'pre' },
)
watch(
  [
    () => props.focusSourceChatId,
    () => props.focusInteractionId,
    () => props.focusNonce,
    () => baseProjection.value.scene.selectionTargets,
  ],
  ([sourceChatId, interactionId, focusNonce]) => {
    if (!interactionId) return
    const selection = { nodeId: interactionId, sourceChatId: sourceChatId ?? props.chatId }
    const focusKey = `${props.chatId}:${selection.sourceChatId}:${selection.nodeId}:${focusNonce}`
    if (focusKey === resolvedFocusKey) return
    const resolution = graphSelection(selection)
    if (resolution.status !== 'available') return
    const nodeId = resolution.graphNodeId
    resolvedFocusKey = focusKey
    void nextTick(() => {
      focusNode(nodeId)
      emit('selectContent', resolution.selection)
    })
  },
  { immediate: true },
)
watch(
  [() => controller.replay.value, displayTimeline],
  ([replay, timeline]) => {
    cancelFocusTransition()
    emit('replayTimelineChange', { replay, timeline: replay ? timeline : undefined })
  },
  { flush: 'sync' },
)
watch(
  () => props.chatId,
  () => {
    resolvedFocusKey = ''
    closeStepDetails(false)
    replayTimeline.value = undefined
  },
)
watch(
  () => props.suspended,
  (suspended) => {
    if (suspended) {
      cancelFocusTransition()
      closeStepDetails(false)
    }
  },
)
onBeforeUnmount(() => {
  cancelFocusTransition()
  if (resizeFrame) cancelAnimationFrame(resizeFrame)
  const viewport = currentViewport()
  if (viewport) cameraByRoot.set(cameraRootId.value, viewport)
})

defineExpose({
  focusActiveHeader: () => focusNode(projection.value.activeHeaderId),
  focusCurrentOccurrence: () => focusNode(projection.value.activeOccurrenceId),
  fitView: () => flow.value?.fitView({ padding: 0.16, duration: 180 }),
})
</script>

<template>
  <section
    class="runtime-diagram"
    :class="{
      'is-suspended': suspended,
      'is-replay': controller.replay.value,
      'is-offline': !controller.synced.value,
    }"
    aria-label="Agent 执行生长图"
  >
    <header class="workflow-toolbar">
      <span class="workflow-title">
        <strong>Agent 执行图</strong>
        <small>{{ controller.replay.value ? '固定历史回放' : '实时任务视图' }}</small>
      </span>
      <span class="workflow-sync" :class="{ 'is-offline': !controller.synced.value }">
        {{ controller.synced.value ? '已同步' : '等待同步' }}
      </span>
      <div class="workflow-toolbar-actions" role="group" aria-label="画布视图控制">
        <el-tooltip content="缩小" placement="bottom">
          <button type="button" aria-label="缩小" @click="flow?.zoomOut({ duration: 100 })">
            <Minus aria-hidden="true" />
          </button>
        </el-tooltip>
        <el-tooltip content="放大" placement="bottom">
          <button type="button" aria-label="放大" @click="flow?.zoomIn({ duration: 100 })">
            <Plus aria-hidden="true" />
          </button>
        </el-tooltip>
        <el-tooltip content="恢复 100%" placement="bottom">
          <button type="button" aria-label="恢复 100%" @click="resetZoom">
            <Refresh aria-hidden="true" />
          </button>
        </el-tooltip>
        <el-tooltip content="适配整张图" placement="bottom">
          <button
            type="button"
            aria-label="适配整张图"
            @click="flow?.fitView({ padding: 0.16, duration: 180 })"
          >
            <FullScreen aria-hidden="true" />
          </button>
        </el-tooltip>
        <el-tooltip content="定位活动头部" placement="bottom">
          <span class="workflow-control-anchor">
            <button
              type="button"
              aria-label="定位活动头部"
              :disabled="!projection.activeHeaderId"
              @click="focusNode(projection.activeHeaderId)"
            >
              <Aim aria-hidden="true" />
            </button>
          </span>
        </el-tooltip>
        <el-tooltip content="定位当前步骤" placement="bottom">
          <span class="workflow-control-anchor">
            <button
              type="button"
              aria-label="定位当前步骤"
              :disabled="!projection.activeOccurrenceId"
              @click="focusNode(projection.activeOccurrenceId)"
            >
              <Aim aria-hidden="true" />
            </button>
          </span>
        </el-tooltip>
      </div>
      <button
        v-if="!controller.replay.value"
        type="button"
        class="workflow-command"
        :disabled="controller.historyLoading.value"
        @click="loadHistory"
      >
        历史回放
      </button>
      <button v-else type="button" class="workflow-command" @click="returnLive">返回实时</button>
    </header>

    <div
      v-if="controller.replay.value"
      class="workflow-playback"
      role="group"
      aria-label="历史回放控制"
    >
      <button type="button" :disabled="!controller.replayLength.value" @click="controller.play">
        <VideoPause v-if="controller.playing.value" aria-hidden="true" />
        <VideoPlay v-else aria-hidden="true" />
        {{ controller.playing.value ? '暂停' : '播放' }}
      </button>
      <button
        type="button"
        aria-label="上一步"
        :disabled="controller.cursor.value <= 0"
        @click="controller.seek(controller.cursor.value - 1)"
      >
        <ArrowLeft aria-hidden="true" />
      </button>
      <input
        :value="controller.cursor.value"
        type="range"
        min="0"
        :max="Math.max(0, controller.replayLength.value - 1)"
        aria-label="回放位置"
        @input="controller.seek(Number(($event.target as HTMLInputElement).value))"
      />
      <button
        type="button"
        aria-label="下一步"
        :disabled="controller.cursor.value >= controller.replayLength.value - 1"
        @click="controller.seek(controller.cursor.value + 1)"
      >
        <ArrowRight aria-hidden="true" />
      </button>
      <select v-model.number="controller.speed.value" aria-label="回放速度">
        <option :value="0.5">0.5×</option>
        <option :value="1">1×</option>
        <option :value="2">2×</option>
      </select>
      <span>
        {{ controller.replayLength.value ? controller.cursor.value + 1 : 0 }} /
        {{ controller.replayLength.value }}
      </span>
    </div>

    <div
      v-if="controller.error.value || controller.historyError.value"
      class="workflow-notice is-error"
      role="alert"
    >
      <Warning aria-hidden="true" />
      <span>{{ controller.error.value || controller.historyError.value }}</span>
      <button v-if="controller.error.value" type="button" @click="controller.open">重试</button>
    </div>
    <div
      v-else-if="controller.workflowState.value && !controller.workflowState.value.historyComplete"
      class="workflow-notice"
      role="status"
    >
      <Warning aria-hidden="true" />
      这段历史存在记录缺口，未确认部分不会按成功显示。
    </div>

    <div
      ref="flowHostRef"
      class="workflow-flow-host"
      :aria-busy="controller.loading.value || controller.historyLoading.value"
      @pointerdown.capture="cancelFocusTransition"
      @wheel.passive.capture="cancelFocusTransition"
    >
      <VueFlow
        aria-label="执行拓扑画布"
        :nodes="projection.nodes"
        :edges="projection.edges"
        :nodes-draggable="false"
        :nodes-connectable="false"
        :edges-updatable="false"
        :min-zoom="0.35"
        :max-zoom="1.8"
        :fit-view-on-init="false"
        :pan-on-drag="true"
        :zoom-on-scroll="true"
        @pane-ready="onPaneReady"
        @move-end="recordViewport"
        @node-click="selectNode"
      >
        <template #node-content="nodeProps">
          <WorkflowContentNode v-bind="nodeProps" @select="selectContentNode" />
        </template>
        <template #node-header="nodeProps">
          <WorkflowHeaderNode
            v-bind="nodeProps"
            @select-scope="selectHeaderScope"
            @reset-group-overrides="resetGroupOverrides"
          />
        </template>
        <template #node-header-group="nodeProps">
          <WorkflowHeaderGroupNode v-bind="nodeProps" @toggle="onToggleGroup" />
        </template>
        <template #node-header-step="nodeProps">
          <WorkflowHeaderStepNode v-bind="nodeProps" @select-step="selectStep" />
        </template>
        <template #node-header-calls="nodeProps">
          <WorkflowHeaderCallsNode v-bind="nodeProps" @select-scope="selectHeaderScope" />
        </template>
        <template #edge-header-flow="edgeProps">
          <WorkflowHeaderEdge v-bind="edgeProps" />
        </template>
        <template #edge-result="edgeProps">
          <WorkflowResultEdge v-bind="edgeProps" />
        </template>
        <template #edge-focus="edgeProps">
          <WorkflowFocusEdge v-bind="edgeProps" />
        </template>
      </VueFlow>
      <WorkflowStepDetails
        v-if="stepDetailModel"
        :model="stepDetailModel"
        :loading="controller.detailHistoryLoading.value"
        :error="controller.detailHistoryError.value"
        @close="closeStepDetails"
        @retry="retryStepDetails"
        @select-content="selectStepContent"
      />
      <div ref="pointerHighlightRef" class="workflow-pointer-highlight" aria-hidden="true" />
      <div
        v-if="controller.loading.value || controller.historyLoading.value"
        class="workflow-loading"
        role="status"
      >
        {{ controller.historyLoading.value ? '正在加载历史…' : '正在同步执行图…' }}
      </div>
      <div v-else-if="!projection.nodes.length" class="workflow-empty" role="status">
        当前还没有可显示的执行事实
      </div>
    </div>
  </section>
</template>

<style scoped lang="less" src="./RuntimeDiagram.styles.less"></style>
