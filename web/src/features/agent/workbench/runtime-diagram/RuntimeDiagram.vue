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
import type { NyxusContentSelection, NyxusReaderFoldMode } from '@/features/pets/nyxus/public'
import {
  projectWorkflowGraph,
  resolveWorkflowGraphSelection,
  type WorkflowGraphNode,
  type WorkflowGraphNodeData,
  type WorkflowGraphProjection,
} from './graphModel'
import { useWorkflowController } from './useWorkflowController'
import { useRuntimeMotion } from './useRuntimeMotion'
import { useWorkflowPointerHighlight } from './useWorkflowPointerHighlight'
import WorkflowContentNode from './WorkflowContentNode.vue'
import WorkflowHeaderNode from './WorkflowHeaderNode.vue'
import WorkflowResultEdge from './WorkflowResultEdge.vue'
import WorkflowHeaderStepNode from './WorkflowHeaderStepNode.vue'
import WorkflowHeaderGroupNode from './WorkflowHeaderGroupNode.vue'
import WorkflowHeaderCallsNode from './WorkflowHeaderCallsNode.vue'
import WorkflowHeaderEdge from './WorkflowHeaderEdge.vue'
import WorkflowStepDetails from './WorkflowStepDetails.vue'
import { absoluteGraphPosition, type HeaderSelection, type HeaderScopeEvent } from './headerGraph'
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
const selectedStep = shallowRef<HeaderSelection>()
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
const baseProjection = computed(() =>
  projectWorkflowGraph(
    controller.workflowState.value,
    displayTimeline.value,
    props.foldMode,
    headerSelections.value,
  ),
)
const selectedGraphNodeId = computed(() => {
  const selection = props.selection
  if (!selection) return undefined
  const resolution = resolveWorkflowGraphSelection(baseProjection.value, selection)
  return resolution.status === 'available' ? resolution.graphNodeId : undefined
})
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
const projection = computed<WorkflowGraphProjection>(() => ({
  ...baseProjection.value,
  nodes: baseProjection.value.nodes.map(projectNodeSelection),
}))
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
const { refreshVisibility: refreshMotionVisibility } = useRuntimeMotion({
  scope: flowHostRef,
  projection,
  rootChatId: cameraRootId,
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
  focusNode(graphNodeId)
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
    if (suspended) closeStepDetails(false)
  },
)
onBeforeUnmount(() => {
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
          <WorkflowHeaderNode v-bind="nodeProps" @select-scope="selectHeaderScope" />
        </template>
        <template #node-header-group="nodeProps">
          <WorkflowHeaderGroupNode v-bind="nodeProps" />
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
